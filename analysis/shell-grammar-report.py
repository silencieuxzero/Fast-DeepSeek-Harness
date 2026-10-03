#!/usr/bin/env python3
"""
FINAL measurement with mutually-exclusive categories.

Key discipline:
  * "grammar" = the SHELL rejected the model's own command syntax
    (PowerShell: ParserError / 找不到接受实际参数 / MissingArgument / 参数验证;
     bash: "syntax error near unexpected token" / "unterminated quoted string" /
     "bad substitution" / "invalid option").
  * "runtime" = the command was well-formed and ran; the world said no
    (absent path, absent binary, no match, non-zero from grep/test).
  * A program merely PRINTING error-looking text is not a shell failure, so the
    pattern must appear after the [stderr] marker or accompany a non-zero exit.
"""
import json
import os
import re
import sys
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import zstandard

ROOT = "C:/Users/rain/.dsh/sessions"
MAGIC = b'\x28\xb5\x2f\xfd'


def lines(p):
    with open(p, 'rb') as fh:
        h = fh.read(4)
        fh.seek(0)
        d = zstandard.ZstdDecompressor().stream_reader(fh).read() if h == MAGIC else fh.read()
    for l in d.decode('utf8', 'replace').split('\n'):
        if l.strip():
            yield l


GRAMMAR = {
    'pwsh': re.compile(
        r'ParserError'
        r'|表达式或语句中缺少|字符串缺少终止符|意外的标记'
        r'|MissingArgument|A command must follow -Command'
        r'|无法对参数[“"]?ArgumentList|执行参数验证'
        r'|找不到接受实际参数|找不到接受自变量'
        r'|FullQualifiedErrorId : (?:MissingArgument|UnexpectedToken)'
        r'|ParentContainsErrorRecordException', re.I),
    'bash': re.compile(
        r'syntax error near unexpected token|unterminated quoted string'
        r'|unexpected EOF while looking for|bad substitution'
        r'|invalid option|ambiguous redirect|too many arguments', re.I),
}
RUNTIME = {
    'pwsh': re.compile(
        r'找不到路径|Cannot find path|项识别为 cmdlet|CommandNotFoundException'
        r'|InvalidArgument|ParameterBindingException|无法绑定|找不到.*路径', re.I),
    'bash': re.compile(
        r'No such file or directory|cannot access|command not found'
        r'|not recognized|No such file', re.I),
}


def region(txt):
    i = txt.find('[stderr]')
    return txt[i:] if i >= 0 else txt


files = []
for dp, _, fs in os.walk(ROOT):
    for f in fs:
        if re.search(r'\.jsonl(\.zstd)?$', f):
            files.append(os.path.join(dp, f))

best = {}
for p in files:
    for l in lines(p):
        try:
            j = json.loads(l)
        except Exception:
            continue
        if j.get('type') == 'session' and j.get('id'):
            s = j['id']
            sz = os.path.getsize(p)
            if s not in best or sz > best[s][1]:
                best[s] = (p, sz)
        break

n = Counter()
res = {t: Counter() for t in ('pwsh', 'bash')}
samples = {t: [] for t in ('pwsh', 'bash')}

for sid, (p, _sz) in best.items():
    pend = {}
    for l in lines(p):
        try:
            j = json.loads(l)
        except Exception:
            continue
        t = j.get('type')
        d = j.get('data') or {}
        if t == 'tool/call':
            a = d.get('arguments')
            if isinstance(a, str):
                try:
                    a = json.loads(a)
                except Exception:
                    a = None
            pend[d.get('callId')] = (d.get('name'), (a or {}).get('command', '') if isinstance(a, dict) else '')
        elif t == 'tool/result':
            m = d.get('message') if isinstance(d.get('message'), dict) else {}
            cid = m.get('toolCallId') or d.get('toolCallId')
            tool, cmd = pend.get(cid, ('?', ''))
            if tool not in res:
                continue
            n[tool] += 1
            c = m.get('content')
            txt = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
            reg = region(txt)
            nonzero = bool(re.search(r'\[(?:exit code:\s*[1-9]|Command finished with exit code\s*[1-9])', txt))
            if GRAMMAR[tool].search(reg):
                res[tool]['grammar'] += 1
                if len(samples[tool]) < 8:
                    samples[tool].append((re.sub(r'\s+', ' ', cmd)[:190], re.sub(r'\s+', ' ', reg)[:190]))
            elif RUNTIME[tool].search(reg):
                res[tool]['runtime'] += 1
            elif nonzero:
                res[tool]['nonzero'] += 1
            elif re.search(r'timed out|killed by signal', txt):
                res[tool]['timeout'] += 1

print('=' * 84)
print('SHELL COMMAND FAILURES, MUTUALLY EXCLUSIVE CATEGORIES')
print('=' * 84)
print(f"{'shell':<7}{'calls':>7}{'GRAMMAR':>9}{'rate':>8}{'runtime':>9}{'nonzero':>9}{'timeout':>9}")
for t in ('pwsh', 'bash'):
    c = n[t] or 1
    print(f"{t:<7}{n[t]:>7}{res[t]['grammar']:>9}{100*res[t]['grammar']/c:>7.2f}%"
          f"{res[t]['runtime']:>9}{res[t]['nonzero']:>9}{res[t]['timeout']:>9}")

pg = res['pwsh']['grammar'] / (n['pwsh'] or 1)
bg = res['bash']['grammar'] / (n['bash'] or 1)
print(f"\npwsh grammar-error rate {pg*100:.2f}%  vs  bash {bg*100:.2f}%")
if bg:
    print(f"ratio: pwsh is {pg/bg:.1f}x more likely to have its command rejected by the shell")
else:
    print("ratio: bash recorded 0 grammar rejections in this corpus")

for t in ('pwsh', 'bash'):
    print(f"\n--- {t} grammar failures ({res[t]['grammar']}) ---")
    for cmd, err in samples[t]:
        print(f"  CMD: {cmd}")
        print(f"  ERR: {err}\n")

#!/usr/bin/env python3
"""
Definitive measurement: how often did the model's own shell command fail to PARSE
or BIND, separately from a command that parsed fine but the world said no?

Discipline: a "self-inflicted" failure must be the SHELL's own complaint, so the
pattern must appear in the [stderr] region (or, absent that marker, in a record
whose exit code is non-zero). This excludes false positives where a command
succeeds while merely PRINTING text that looks like an error (e.g. an audit script
echoing a captured PowerShell error).
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


# Shell-grammar complaints: the model's command itself was malformed.
SELF = re.compile(
    r'ParserError'
    r'|表达式或语句中缺少|字符串缺少终止符|意外的标记|分析错误|应该是[“"]?}'
    r'|MissingArgument|A command must follow -Command'
    r'|无法对参数.*?执行参数验证|ArgumentList.*?Null'
    r'|找不到接受实际参数|找不到接受自变量'
    r'|unterminated quoted string|unexpected EOF while looking for'
    r'|syntax error near unexpected token|bad substitution',
    re.I)

# The world said no: well-formed command, absent path / absent binary / no match.
BENIGN = re.compile(
    r'找不到路径|Cannot find path|No such file or directory|ENOENT'
    r'|项识别为 cmdlet|CommandNotFoundException|not recognized as the name'
    r'|不是内部或外部命令|command not found',
    re.I)


def stderr_region(txt):
    """Text the shell itself emitted as diagnostics (PowerShell marks it [stderr])."""
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

stat = {t: Counter() for t in ('pwsh', 'bash')}
calls = Counter()
fp = {t: [] for t in ('pwsh', 'bash')}
hits = {t: [] for t in ('pwsh', 'bash')}

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
            if d.get('name') in calls or d.get('name') in stat:
                calls[d.get('name')] += 1
        elif t == 'tool/result':
            m = d.get('message') if isinstance(d.get('message'), dict) else {}
            cid = m.get('toolCallId') or d.get('toolCallId')
            tool, cmd = pend.get(cid, ('?', ''))
            if tool not in stat:
                continue
            c = m.get('content')
            txt = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
            region = stderr_region(txt)
            nonzero = bool(re.search(r'\[(?:exit code:\s*[1-9]|Command finished with exit code\s*[1-9])', txt))
            # The shell's own grammar complaint, in the diagnostics region.
            if SELF.search(region):
                # Guard: if the pattern only occurs because a program printed it
                # (no [stderr] marker and exit 0), it is a false positive.
                if '[stderr]' not in txt and not nonzero:
                    fp[tool].append((cmd, txt))
                    continue
                stat[tool]['self_inflicted'] += 1
                hits[tool].append((cmd, re.sub(r'\s+', ' ', region))[:400])
            elif BENIGN.search(region):
                stat[tool]['benign_missing'] += 1
            elif re.search(r'\[(?:exit code:\s*[1-9]|Command finished with exit code\s*[1-9])', txt):
                stat[tool]['benign_nonzero'] += 1
            elif re.search(r'timed out|killed by signal', txt):
                stat[tool]['timeout'] += 1

print('DEFINITIVE: shell-grammar failures (the model mis-typed the command)\n' + '=' * 76)
print(f"{'shell':<8}{'calls':>8}{'self-inflicted':>16}{'rate':>9}{'benign-missing':>16}{'benign-exit':>13}{'timeout':>9}")
for t in ('pwsh', 'bash'):
    s = stat[t]
    n = calls[t] or 1
    print(f"{t:<8}{calls[t]:>8}{s['self_inflicted']:>16}{100*s['self_inflicted']/n:>8.2f}%"
          f"{s['benign_missing']:>16}{s['benign_nonzero']:>13}{s['timeout']:>9}")
    print(f"{'':<8}{'(false positives excluded: %d)' % len(fp[t]):<50}")

pws = stat['pwsh']['self_inflicted'] / (calls['pwsh'] or 1)
bs = stat['bash']['self_inflicted'] / (calls['bash'] or 1)
print(f"\npwsh grammar-error rate {pws*100:.2f}%  vs bash {bs*100:.2f}%"
      f"  ->  {'n/a' if not bs else 'pwsh ' + format(pws/bs, '.1f') + 'x higher'}")

print('\n\n--- excluded false positives ---')
for t in ('pwsh', 'bash'):
    for cmd, txt in fp[t][:6]:
        print(f"  [{t}] {re.sub(r'[[:space:]]+', ' ', cmd)[:130]}")
        print(f"        (matched only in printed output): {re.sub(r'[[:space:]]+', ' ', txt)[:130]}")

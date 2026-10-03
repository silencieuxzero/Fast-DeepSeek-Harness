#!/usr/bin/env python3
"""Fair comparison: the risk is NOT uniform across commands. Almost every shell
rejection happens in a command that embeds an inner program or a path with quotes.
So compare the failure rate CONDITIONAL on that construct, and check for confounds:

  - does any session use both shells (within-session comparison available)?
  - what share of each shell's calls embed an inner program (node -e / python -c)?
  - among those, how often did the shell reject the command text?
  - are the two corpora the same era / same kind of work?

Read-only.
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
INLINE = re.compile(r'\bnode\s+-e\b|\bpython3?\s+-c\b|\bperl\s+-e\b|\bpwsh\b\s+-c\b', re.I)
PWSH_GRAMMAR = re.compile(
    r'TerminatorExpectedAtEndOfString|EmptyPipeElement'
    r'|ParserError\s*:\s*\(.*?\)\s*\[\]|CategoryInfo\s*:\s*ParserError'
    r'|MissingArgument|A command must follow -Command'
    r'|无法对参数.*?执行参数验证|找不到接受实际参数|找不到接受自变量'
    r'|表达式或语句中缺少|字符串缺少终止符', re.I)
BASH_GRAMMAR = re.compile(
    r'(?:^|\n)\s*(?:\S*/)?bash:\s+(?:-c:\s+)?(?:line\s+\d+:\s+)?'
    r'.*?(?:unexpected EOF|syntax error|bad substitution|unexpected token)', re.I)
NONZERO = re.compile(r'\[(?:exit code:\s*[1-9]|Command finished with exit code\s*[1-9])')


def lines(p):
    with open(p, 'rb') as fh:
        h = fh.read(4)
        fh.seek(0)
        d = zstandard.ZstdDecompressor().stream_reader(fh).read() if h == MAGIC else fh.read()
    for l in d.decode('utf8', 'replace').split('\n'):
        if l.strip():
            yield l


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

# shell -> {inline calls, inline grammar errors, plain calls, plain grammar errors}
S = {t: Counter() for t in ('pwsh', 'bash')}
both = []
for sid, (p, _sz) in best.items():
    title = ''
    pend = {}
    local = Counter()
    for l in lines(p):
        try:
            j = json.loads(l)
        except Exception:
            continue
        t = j.get('type')
        d = j.get('data') or {}
        if t == 'session/title':
            title = d.get('title') if isinstance(d, dict) else (d or '')
        elif t == 'tool/call':
            a = d.get('arguments')
            if isinstance(a, str):
                try:
                    a = json.loads(a)
                except Exception:
                    a = None
            cmd = (a or {}).get('command', '') if isinstance(a, dict) else ''
            n = d.get('name')
            if n in S:
                local[n] += 1
                pend[d.get('callId')] = (n, cmd, bool(INLINE.search(cmd)))
        elif t == 'tool/result':
            m = d.get('message') if isinstance(d.get('message'), dict) else {}
            cid = m.get('toolCallId') or d.get('toolCallId')
            tool, cmd, is_inline = pend.get(cid, ('?', '', False))
            if tool not in S:
                continue
            c = m.get('content')
            txt = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
            region = txt[txt.find('[stderr]'):] if '[stderr]' in txt else txt
            mo = (PWSH_GRAMMAR.search(region) if tool == 'pwsh' else BASH_GRAMMAR.search(txt))
            if mo and mo.group(0).strip()[:40] and mo.group(0).strip()[:40] in cmd:
                mo = None
            if mo and ('[stderr]' in txt or NONZERO.search(txt)):
                S[tool]['inline_err' if is_inline else 'plain_err'] += 1
                S[tool]['err_sessions_' + sid] += 1
            if is_inline:
                S[tool]['inline'] += 1
            else:
                S[tool]['plain'] += 1
    if local['pwsh'] and local['bash']:
        both.append((str(title), local['pwsh'], local['bash']))

print("CONDITIONAL FAILURE RATE\n" + "=" * 74)
print(f"{'shell':<7}{'plain calls':>13}{'plain errs':>12}{'plain %':>9}"
      f"{'inline calls':>14}{'inline errs':>13}{'inline %':>10}{'total %':>9}")
for t in ('pwsh', 'bash'):
    pl, pe = S[t]['plain'], S[t]['plain_err']
    il, ie = S[t]['inline'], S[t]['inline_err']
    tot, te = pl + il, pe + ie
    print(f"{t:<7}{pl:>13}{pe:>12}{100*pe/(pl or 1):>8.2f}%"
          f"{il:>14}{ie:>13}{100*ie/(il or 1):>9.2f}%{100*te/(tot or 1):>8.2f}%")

print("\nshare of each shell's calls that embed an inner program:")
for t in ('pwsh', 'bash'):
    tot = S[t]['plain'] + S[t]['inline']
    print(f"  {t:<5} {S[t]['inline']}/{tot} = {100*S[t]['inline']/(tot or 1):.1f}%")

print("\nsessions that used BOTH shells (within-session comparison would be ideal):")
if both:
    for title, pc, bc in both:
        print(f"  {title[:46]:<48} pwsh={pc:>4} bash={bc:>4}")
else:
    print("  NONE -- the two corpora are disjoint sessions, so this is a")
    print("  between-session comparison, confounded by task and by era.")

print("\ninline-error share of all inline commands (the construct that breaks):")
for t in ('pwsh', 'bash'):
    il, ie = S[t]['inline'], S[t]['inline_err']
    print(f"  {t:<5} {ie}/{il} = {100*ie/(il or 1):.2f}%")
print(f"\nratio: pwsh inline failure / bash inline failure = "
      f"{(S['pwsh']['inline_err']/(S['pwsh']['inline'] or 1))/((S['bash']['inline_err']/(S['bash']['inline'] or 1)) or 1):.1f}x")

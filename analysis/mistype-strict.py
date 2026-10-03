#!/usr/bin/env python3
"""pwsh vs bash: how often did the model's own command get REJECTED BY THE SHELL?

Answers the user's question (m00832): "dsh often mistypes commands under
PowerShell -- does bash have the same problem?"

Only ONE thing is counted: a failure where the SHELL ITSELF said the command text
was malformed. Explicitly excluded, because none of them is a mistyped command:
  - well-formed command, missing path / no-match grep / missing binary / timeout
  - parsed fine, but the program the model embedded in it (node -e, python -c)
    had a bug
  - an error string that a PROGRAM merely PRINTED (an audit script echoing a
    captured PowerShell error is exactly the trap that fooled the first pass)

Every surviving hit is dumped in full so it can be eyeballed. Read-only.
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

# pwsh's own parser/binder complaining. The diagnostic SHAPE, not a bare keyword.
PWSH_GRAMMAR = re.compile(
    r'TerminatorExpectedAtEndOfString'          # a quote/string did not terminate
    r'|EmptyPipeElement'                         # a pipe with nothing after it
    r'|ParserError\s*:\s*\(.*?\)\s*\[\]'         # ParserError CategoryInfo line
    r'|CategoryInfo\s*:\s*ParserError'
    r'|MissingArgument|A command must follow -Command'
    r'|无法对参数.*?执行参数验证'
    r'|找不到接受实际参数|找不到接受自变量'
    r'|表达式或语句中缺少|字符串缺少终止符',
    re.I)

# bash's own complaint, prefixed with the shell's name the way bash does it.
BASH_GRAMMAR = re.compile(
    r'(?:^|\n)\s*(?:\S*/)?bash:\s+(?:-c:\s+)?(?:line\s+\d+:\s+)?'
    r'.*?(?:unexpected EOF|syntax error|bad substitution|unexpected token)',
    re.I)

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


def stderr_region(txt):
    i = txt.find('[stderr]')
    return txt[i:] if i >= 0 else txt


calls = Counter()
hits = {'pwsh': [], 'bash': []}
for sid, (p, _sz) in best.items():
    title = ''
    pend = {}
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
            pend[d.get('callId')] = (d.get('name'), cmd)
            if d.get('name') in ('pwsh', 'bash'):
                calls[(d.get('name'),)] = calls[(d.get('name'),)] + 1
                calls[('calls', d.get('name'), title.startswith('exp-'))] += 1
        elif t == 'tool/result':
            m = d.get('message') if isinstance(d.get('message'), dict) else {}
            cid = m.get('toolCallId') or d.get('toolCallId')
            tool, cmd = pend.get(cid, ('?', ''))
            if tool not in ('pwsh', 'bash'):
                continue
            c = m.get('content')
            txt = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
            region = stderr_region(txt)
            if tool == 'pwsh':
                mo = PWSH_GRAMMAR.search(region)
            else:
                mo = BASH_GRAMMAR.search(txt)
            if not mo:
                continue
            # the string must not be coming from the command itself (grepping sources)
            if mo.group(0).strip()[:40] and mo.group(0).strip()[:40] in cmd:
                continue
            if '[stderr]' not in txt and not NONZERO.search(txt):
                continue
            hits[tool].append(dict(sid=sid, title=str(title), cmd=cmd,
                                   hit=mo.group(0).strip()[:90], txt=region[:400],
                                   exp=str(title).startswith('exp-')))

print("SHELL REJECTED THE MODEL'S COMMAND TEXT\n" + "=" * 78)
for t in ('pwsh', 'bash'):
    n = len(hits[t])
    tot = calls[('calls', t, True)] + calls[('calls', t, False)]
    print(f"{t:<6} calls={tot:>6}   shell-grammar errors={n:>3}   rate={100*n/(tot or 1):.2f}%")

print("\nsplit by corpus (my own experiment vs real work):")
for label, flag in (('all', None), ('real work', False), ('my experiment', True)):
    parts = []
    for t in ('pwsh', 'bash'):
        if flag is None:
            c = calls[('calls', t, True)] + calls[('calls', t, False)]
            g = len(hits[t])
        else:
            c = calls[('calls', t, flag)]
            g = sum(1 for h in hits[t] if h['exp'] == flag)
        parts.append(f"{t}: {g}/{c} = {100*g/(c or 1):.2f}%")
    print(f"  {label:<16} " + "   ".join(parts))

print("\nwhich failure mode:")
for t in ('pwsh', 'bash'):
    pats = [('escaped-inner-quote', r'TerminatorExpected|字符串缺少终止符|unexpected EOF'),
            ('parameter-binding', r'找不到接受|无法对参数|MissingArgument|must follow -Command'),
            ('parser-other', r'ParserError|EmptyPipeElement|表达式或语句中缺少'),
            ('bash-syntax', r'syntax error|bad substitution|unexpected token')]
    for nm, pat in pats:
        k = sum(1 for h in hits[t] if re.search(pat, h['hit'], re.I))
        if k:
            print(f"  {t:<5} {nm:<22} {k}")

print("\nby session:")
per = Counter()
for t in ('pwsh', 'bash'):
    for h in hits[t]:
        per[(t, h['title'])] += 1
for (t, title), n in per.most_common():
    print(f"   {t:<5} {title[:46]:<48} {n:>3}")

print("\n\nEVERY HIT\n" + "=" * 78)
for t in ('pwsh', 'bash'):
    for i, h in enumerate(hits[t], 1):
        print(f"\n[{t} #{i}] {h['title'][:40]}  {h['sid'][:20]}")
        print(f"   HIT: {h['hit']!r}")
        print(f"   CMD: {re.sub(chr(10), ' ', h['cmd'])[:260]}")
        print(f"   TXT: {re.sub(chr(10), ' ', h['txt'])[:220]}")

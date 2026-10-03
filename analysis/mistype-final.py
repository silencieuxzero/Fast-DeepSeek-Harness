#!/usr/bin/env python3
"""Deliverable measurement for the pwsh-vs-bash "mistyped command" question.

Two DIFFERENT failure kinds, deliberately separated:

  A. shell-grammar  -- the SHELL rejected the model's command text. The command
     did not parse or bind. This is what "输错命令" means.
     Counted only when the shell's own complaint appears in the [stderr] region,
     or, absent that marker, in a record whose exit code is non-zero. This
     excludes commands that merely PRINT text resembling an error.

  B. program-bug -- the command parsed fine; the program the model embedded in
     it (node -e / python -c / a script) had a bug. Not a mistyped command.

Reports both per shell, per session, and with a leave-one-session-out view so a
single heavy session cannot carry the rate. Read-only.
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

# The SHELL's own complaint that the command text was malformed.
GRAMMAR = re.compile(
    r'ParserError'
    r'|表达式或语句中缺少|字符串缺少终止符|意外的标记|分析错误|应该是[“"]?}'
    r'|MissingArgument|A command must follow -Command'
    r'|无法对参数.*?执行参数验证|ArgumentList.*?Null'
    r'|找不到接受实际参数|找不到接受自变量'
    r'|unterminated quoted string|unexpected EOF while looking for'
    r'|syntax error near unexpected token|bad substitution',
    re.I)

# A program inside the command reported a bug: parsed fine, logic was wrong.
PROGBUG = re.compile(
    r'^\s*(?:ReferenceError|TypeError|SyntaxError: [^\n]*is not valid JSON)'
    r'|Cannot read propert|is not defined|is not a function|MODULE_NOT_FOUND'
    r'|Cannot find module|Traceback \(most recent call last\)'
    r'|NameError|AttributeError|IndentationError',
    re.I | re.M)

INLINE = re.compile(r'\bnode\s+-e\b|\bpython3?\s+-c\b|\bperl\s+-e\b', re.I)
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


sessions = {}
for sid, (p, _sz) in best.items():
    title = ''
    pend = {}
    calls = Counter()
    inline = Counter()
    grammar = Counter()
    progbug = Counter()
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
            n = d.get('name')
            if n in ('pwsh', 'bash'):
                calls[n] += 1
                if INLINE.search(cmd):
                    inline[n] += 1
        elif t == 'tool/result':
            m = d.get('message') if isinstance(d.get('message'), dict) else {}
            cid = m.get('toolCallId') or d.get('toolCallId')
            tool, cmd = pend.get(cid, ('?', ''))
            if tool not in ('pwsh', 'bash'):
                continue
            c = m.get('content')
            txt = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
            if GRAMMAR.search(stderr_region(txt)):
                if '[stderr]' not in txt and not NONZERO.search(txt):
                    pass  # survives only in printed output -> not the shell talking
                else:
                    grammar[tool] += 1
            if PROGBUG.search(txt):
                progbug[tool] += 1
    if calls['pwsh'] or calls['bash']:
        sessions[sid] = dict(title=str(title), calls=calls, inline=inline,
                             grammar=grammar, progbug=progbug)

exp = {s: v for s, v in sessions.items() if v['title'].startswith('exp-')}
oth = {s: v for s, v in sessions.items() if not v['title'].startswith('exp-')}


def group(name, grp):
    pc = sum(v['calls']['pwsh'] for v in grp.values())
    bc = sum(v['calls']['bash'] for v in grp.values())
    pi = sum(v['inline']['pwsh'] for v in grp.values())
    bi = sum(v['inline']['bash'] for v in grp.values())
    pg = sum(v['grammar']['pwsh'] for v in grp.values())
    bg = sum(v['grammar']['bash'] for v in grp.values())
    pp = sum(v['progbug']['pwsh'] for v in grp.values())
    bp = sum(v['progbug']['bash'] for v in grp.values())
    print(f"{name:<22}{pc:>7}{bc:>7}{pi:>8}{bi:>8}{pg:>8}{bg:>8}{pp:>8}{bp:>8}")
    return pc, bc, pg, bg


print("SHELL COMMANDS: did the SHELL reject the model's command text?\n" + "=" * 82)
print(f"{'group':<22}{'pwsh':>7}{'bash':>7}{'pInline':>8}{'bInline':>8}{'pGram':>8}{'bGram':>8}{'pProg':>8}{'bProg':>8}")
pc, bc, pg, bg = group('ALL', sessions)
group('  my experiment', exp)
group('  real work', oth)
print()
print(f"pwsh grammar-error rate: {pg}/{pc} = {100*pg/(pc or 1):.2f}%")
print(f"bash grammar-error rate: {bg}/{bc} = {100*bg/(bc or 1):.2f}%")
print(f"bash excluding my experiment: "
      f"{sum(v['grammar']['bash'] for v in oth.values())}/{sum(v['calls']['bash'] for v in oth.values())} = "
      f"{100*sum(v['grammar']['bash'] for v in oth.values())/(sum(v['calls']['bash'] for v in oth.values()) or 1):.2f}%")

print("\n\nGRAMMAR ERRORS BY SESSION (a rate must not come from one session)\n" + "=" * 82)
for shell in ('pwsh', 'bash'):
    rows = [(v['title'], v['calls'][shell], v['grammar'][shell]) for v in sessions.values() if v['grammar'][shell]]
    rows.sort(key=lambda r: -r[2])
    tot = sum(v['calls'][shell] for v in sessions.values())
    print(f"\n{shell}: {sum(r[2] for r in rows)} grammar errors over {tot} calls, in {len(rows)} sessions")
    for title, c, g in rows[:8]:
        print(f"   {title[:44]:<46} {g:>3} errors / {c:>4} calls")

print("\n\nLEAVE-ONE-SESSION-OUT: does any single session carry the bash rate?\n" + "=" * 82)
bc_t = sum(v['calls']['bash'] for v in sessions.values())
bg_t = sum(v['grammar']['bash'] for v in sessions.values())
worst = max(((v['title'], v['grammar']['bash'], v['calls']['bash']) for v in sessions.values()),
            key=lambda r: r[1])
print(f"bash with every session: {bg_t}/{bc_t} = {100*bg_t/bc_t:.2f}%")
print(f"bash dropping the worst one ('{worst[0][:40]}'): "
      f"{bg_t-worst[1]}/{bc_t-worst[2]} = {100*(bg_t-worst[1])/(bc_t-worst[2]):.2f}%")
pc_t = sum(v['calls']['pwsh'] for v in sessions.values())
pg_t = sum(v['grammar']['pwsh'] for v in sessions.values())
worstp = max(((v['title'], v['grammar']['pwsh'], v['calls']['pwsh']) for v in sessions.values()),
             key=lambda r: r[1])
print(f"pwsh with every session: {pg_t}/{pc_t} = {100*pg_t/pc_t:.2f}%")
print(f"pwsh dropping the worst one ('{worstp[0][:40]}'): "
      f"{pg_t-worstp[1]}/{pc_t-worstp[2]} = {100*(pg_t-worstp[1])/(pc_t-worstp[2]):.2f}%")

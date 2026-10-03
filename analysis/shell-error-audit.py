#!/usr/bin/env python3
"""
shell-error-audit.py — measure per-shell command failure modes from real DSH transcripts.

Question it answers: "the model often types the wrong command under PowerShell --
does the same happen under bash?"  Method: join tool/call -> tool/result by callId
across every session transcript, bucket by shell tool name, classify failure text
into named modes, and report the rate per shell.

Read-only. Roots are passed as argv. Handles plain .jsonl and multi-frame
.jsonl.zstd (python-zstandard stream_reader).
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

# Transcripts mix encodings: the JSON envelope is ASCII/UTF-8, but PowerShell's
# own error output is captured as raw console bytes (GBK/cp936 on this machine),
# so a line can be invalid UTF-8. Decode per line with utf-8 then gbk fallback.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

try:
    import zstandard
except ImportError:
    zstandard = None

# ---- failure classification -------------------------------------------------
# IMPORTANT: DSH records a failed shell command with isError:false -- the failure
# exists only as TEXT ("[stderr] ...", "[exit code: 1]"). Classify by text.
#
# Ordered: first match wins. Patterns cover English and Chinese PowerShell
# localizations (this machine's pwsh emits Chinese error text).
MODES = [
    ('command-not-found', re.compile(
        r'CommandNotFoundException|is not recognized as the name'
        r'|not recognized as an internal or external|command not found'
        r'|: command not found|项识别为|无法将.*识别|不是内部或外部命令')),
    ('syntax', re.compile(
        r'ParserError|UnexpectedToken|Unexpected token|syntax error'
        r'|MissingEndCurlyBrace|Missing closing|TerminatorExpectedAtEndOfString'
        r'|InvalidEndOfLine|MissingExpressionAfter|意外的标记|分析错误'
        r'|表达式或语句中缺少|应该是|缺少右|字符串缺少终止符|bad substitution'
        r'|unexpected EOF|unterminated|语法错误|缺少结束标记', re.I)),
    ('path-not-found', re.compile(
        r'Cannot find path|No such file or directory|PathNotFound|ENOENT'
        r'|Could not find a part of the path|找不到路径|系统找不到指定的路径|不存在')),
    ('param-binding', re.compile(
        r'ParameterBindingException|A parameter cannot be found|Cannot bind argument'
        r'|missing a mandatory parameter|无法绑定|缺少参数|无法找到与参数名匹配的参数')),
    ('permission', re.compile(r'Permission denied|Access is denied|UnauthorizedAccess|拒绝访问')),
    ('quoting/expansion', re.compile(r'too many arguments|ambiguous redirect|unbound variable')),
]

EXIT_RE = re.compile(r'\[exit code:\s*(-?\d+)\]', re.I)


def classify(text):
    if not text:
        return None
    for name, rx in MODES:
        if rx.search(text):
            return name
    return None


def exit_code(text):
    m = EXIT_RE.search(text or '')
    return int(m.group(1)) if m else None


def result_text(d):
    m = d.get('message')
    if m is None:
        return ''
    if isinstance(m, str):
        return m
    if isinstance(m, dict):
        c = m.get('content')
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return '\n'.join(x.get('text', '') for x in c if isinstance(x, dict) and isinstance(x.get('text'), str))
    return ''


# ---- file collection --------------------------------------------------------
def collect(root):
    out = []
    if os.path.isfile(root):
        return [root] if re.search(r'\.jsonl(\.zstd)?$', root) else []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if re.search(r'\.jsonl(\.zstd)?$', f):
                out.append(os.path.join(dirpath, f))
    return out


def open_lines(path):
    """Yield decoded lines from a plain or zstd transcript."""
    with open(path, 'rb') as fh:
        head = fh.read(4)
        fh.seek(0)
        if head == b'\x28\xb5\x2f\xfd':
            if zstandard is None:
                raise RuntimeError('python-zstandard required for .zstd transcripts')
            with zstandard.ZstdDecompressor().stream_reader(fh) as r:
                data = r.read()
        else:
            data = fh.read()
    for line in data.decode('utf8', 'replace').split('\n'):
        if line.strip():
            yield line


# ---- pass 1: dedupe by session id (largest copy wins) -----------------------
roots = sys.argv[1:]
files = []
for r in roots:
    files.extend(collect(r))

by_session = {}
no_id = []
for path in files:
    sid, size = None, os.path.getsize(path)
    try:
        for line in open_lines(path):
            try:
                j = json.loads(line)
            except Exception:
                continue
            if j.get('type') == 'session' and j.get('id'):
                sid = j['id']
            break
    except Exception:
        pass
    if sid is None:
        no_id.append(path)
    elif sid not in by_session or size > by_session[sid][1]:
        by_session[sid] = (path, size)

chosen = [p for p, _ in by_session.values()] + no_id

# ---- pass 2: scan ----------------------------------------------------------
per_tool = defaultdict(lambda: {'calls': 0, 'results': 0, 'errors': 0, 'orphans': 0,
                                'modes': Counter(), 'samples': [], 'exits': []})
sessions = set()

for path in chosen:
    pending = {}
    sid = None
    for line in open_lines(path):
        try:
            j = json.loads(line)
        except Exception:
            continue
        t = j.get('type')
        if t == 'session' and j.get('id'):
            sid = j['id']
            sessions.add(sid)
            continue

        if t == 'tool/call':
            d = j.get('data') or {}
            args = d.get('arguments')
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = None
            cmd = (args or {}).get('command', '') if isinstance(args, dict) else ''
            pending[d.get('callId')] = (d.get('name'), cmd)
            per_tool[d.get('name')]['calls'] += 1
            continue

        if t == 'tool/result':
            d = j.get('data') or {}
            msg = d.get('message') if isinstance(d.get('message'), dict) else {}
            call_id = msg.get('toolCallId') or d.get('toolCallId')
            tool, cmd = pending.get(call_id, (d.get('name') or '(unknown)', ''))
            b = per_tool[tool]
            b['results'] += 1
            if call_id not in pending:
                b['orphans'] += 1

            text = result_text(d)
            mode = classify(text)
            ec = exit_code(text)
            if ec is not None:
                b['exits'].append(ec)
            if mode:
                b['errors'] += 1
                b['modes'][mode] += 1
                if len(b['samples']) < 6:
                    b['samples'].append({
                        'session': sid,
                        'command': re.sub(r'\s+', ' ', cmd)[:220],
                        'mode': mode,
                        'exit': ec,
                        'evidence': re.sub(r'\s+', ' ', text)[:300],
                    })

# ---- report ----------------------------------------------------------------
print(f"scanned {len(chosen)} transcript(s) (from {len(files)} file(s)), "
      f"{len(sessions)} distinct session(s)\n")

SHELLS = ['pwsh', 'bash', 'powershell', 'shell', 'sh', 'cmd']
rows = sorted(((t, b) for t, b in per_tool.items() if t in SHELLS),
              key=lambda kv: -kv[1]['calls'])

print('shell      calls  results  errs   err%   nonzero   failures by mode')
print('--------  ------  -------  ----  -----  --------  ------------------')
for tool, b in rows:
    pct = (b['errors'] / b['calls'] * 100) if b['calls'] else 0.0
    nz = sum(1 for c in b['exits'] if c != 0)
    modes = '  '.join(f'{m}:{n}' for m, n in b['modes'].most_common())
    print(f"{tool:<8}  {b['calls']:>6}  {b['results']:>7}  {b['errors']:>4}  "
          f"{pct:>5.1f}  {nz:>8}  {modes}")

pw = per_tool.get('pwsh')
bs = per_tool.get('bash')
if pw and bs and pw['calls'] and bs['calls']:
    a, c = pw['errors'] / pw['calls'], bs['errors'] / bs['calls']
    print(f"\npwsh failure rate {a*100:.2f}%  vs  bash {c*100:.2f}%  ->  "
          f"{'pwsh ' + str(round(a/c, 2)) + 'x worse' if c else 'n/a'}")

print('\n--- samples per shell ---')
for tool, b in rows:
    print(f"\n[{tool}]  (showing {len(b['samples'])} of {b['errors']})")
    for s in b['samples']:
        print(f"  mode={s['mode']} exit={s['exit']}")
        print(f"  cmd : {s['command']}")
        print(f"  err : {s['evidence']}")

print('\n--- non-shell tools (context) ---')
for t, b in sorted(((t, b) for t, b in per_tool.items() if t not in SHELLS),
                   key=lambda kv: -kv[1]['calls'])[:14]:
    print(f"  {t:<24} calls={b['calls']:>5} errors={b['errors']}")

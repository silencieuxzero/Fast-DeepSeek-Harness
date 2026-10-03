#!/usr/bin/env python3
"""Triage: dump every shell failure with its command, to separate true authoring
errors (bad syntax / wrong command / quoting) from legitimate non-zero results
(grep found nothing, path genuinely absent during exploration)."""
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


files = []
for dp, _, fs in os.walk(ROOT):
    for f in fs:
        if re.search(r'\.jsonl(\.zstd)?$', f):
            files.append(os.path.join(dp, f))

# canonical file per session
canon = {}
for p in files:
    for l in lines(p):
        try:
            j = json.loads(l)
        except Exception:
            continue
        if j.get('type') == 'session' and j.get('id'):
            canon[j['id']] = p
        break

fails = {'pwsh': [], 'bash': []}
for p in set(canon.values()):
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
            if tool not in fails:
                continue
            c = m.get('content')
            txt = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
            # failure evidence only
            ev = re.search(r'\[stderr\]([\s\S]{0,400})', txt)
            marker = re.findall(r'\[(?:exit code:\s*-?\d+|Command finished with exit code\s*-?\d+|Command timed out or OOM|shell killed by signal[^\]]*)\]', txt)
            is_fail = bool(ev) or any(re.search(r'(?:exit code:|exit code\s*:)\s*[1-9]', x) for x in marker) or \
                      any(('timed out' in x or 'killed' in x) for x in marker)
            if is_fail:
                fails[tool].append((cmd, (ev.group(1) if ev else ' '.join(marker))[:260]))

for tool in ('pwsh', 'bash'):
    print(f"\n{'='*100}\n{tool.upper()}: {len(fails[tool])} failing calls\n{'='*100}")
    for i, (cmd, ev) in enumerate(fails[tool], 1):
        print(f"\n[{i}] CMD: {re.sub(chr(10), ' ; ', cmd)[:240]}")
        print(f"    ERR: {re.sub(r'\s+', ' ', ev)[:240]}")

#!/usr/bin/env python3
"""
Where does a step's wall-clock actually go, and how much of the prompt is cached?

Per assistant step the stream carries absolute timestamps:
  stream[0].time              = request start
  stream[-1].time             = response finished
and each assistant message carries `usage`:
  {inputTokens, outputTokens, totalTokens, cacheReadTokens}

Tool time is the gap between a step's last stream timestamp and the next
step/start (or the tool/result that closes the calls).
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

steps = []           # per assistant step
cache_hit = cache_tot = 0
reason_chars = text_chars = out_tokens = in_tokens = 0

for sid, (p, _sz) in best.items():
    for l in lines(p):
        try:
            j = json.loads(l)
        except Exception:
            continue
        if j.get('type') != 'assistant/message':
            continue
        d = j.get('data') or {}
        st = d.get('stream')
        if not isinstance(st, list) or not st:
            continue
        t0 = st[0].get('time') if isinstance(st[0], dict) else None
        t1 = st[-1].get('time') if isinstance(st[-1], dict) else None
        if not (isinstance(t0, (int, float)) and isinstance(t1, (int, float))):
            continue
        m = d.get('message') or {}
        c = m.get('content')
        rc = tc = 0
        if isinstance(c, list):
            for part in c:
                if not isinstance(part, dict):
                    continue
                if part.get('type') == 'reasoning':
                    rc += len(part.get('text') or '')
                elif part.get('type') == 'text':
                    tc += len(part.get('text') or '')
        u = d.get('usage') or {}
        ir = u.get('cacheReadTokens') or 0
        it = u.get('inputTokens') or 0
        cache_hit += ir
        cache_tot += ir + it
        out_tokens += u.get('outputTokens') or 0
        in_tokens += it
        reason_chars += rc
        text_chars += tc
        steps.append({'dur': t1 - t0, 'reason': rc, 'text': tc,
                      'in': it, 'cr': ir, 'out': u.get('outputTokens') or 0,
                      'reasoning_chunks': sum(
                          1 for e in st if isinstance(e, dict)
                          and isinstance(e.get('chunk'), dict)
                          and e['chunk'].get('type') == 'block-end'
                          and isinstance(e['chunk'].get('block'), dict)
                          and e['chunk']['block'].get('type') == 'reasoning')})

steps.sort(key=lambda s: -s['dur'])
n = len(steps)
print(f"assistant steps analysed: {n}  (across {len(best)} sessions)")
print(f"model wall-clock total:   {sum(s['dur'] for s in steps)/1000:.1f} s")
print(f"  median step:            {sorted(s['dur'] for s in steps)[n//2]/1000:.2f} s")
print(f"  p90 step:               {sorted(s['dur'] for s in steps)[int(n*.9)]/1000:.2f} s")
print(f"  top 10% of steps carry: {100*sum(s['dur'] for s in steps[:max(1,n//10)])/max(sum(s['dur'] for s in steps),1):.1f}% of model time")
print()
print(f"reasoning chars: {reason_chars:,}   visible text chars: {text_chars:,}"
      f"   -> reasoning is {100*reason_chars/max(reason_chars+text_chars,1):.1f}% of output")
print(f"output tokens:   {out_tokens:,}   cache-miss input tokens: {in_tokens:,}")
print(f"cache hit rate:  {100*cache_hit/max(cache_tot,1):.1f}%  ({cache_hit:,} reused / {cache_tot:,} prompt)")
print()
# throughput: reasoning chars per second of model time
tot = sum(s['dur'] for s in steps) / 1000
print(f"throughput: {reason_chars/max(tot,1):.0f} reasoning chars/s,"
      f" {out_tokens/max(tot,1):.1f} output tok/s")
print()
print("--- 12 slowest steps ---")
print(f"{'dur_s':>7}{'reason_ch':>11}{'in_tok':>8}{'cache_rd':>10}{'out_tok':>8}")
for s in steps[:12]:
    print(f"{s['dur']/1000:>7.2f}{s['reason']:>11,}{s['in']:>8,}{s['cr']:>10,}{s['out']:>8,}")

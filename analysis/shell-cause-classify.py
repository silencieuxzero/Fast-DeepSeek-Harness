#!/usr/bin/env python3
"""
Classify shell failures BY CAUSE, to answer: is the failure "the model typed the
command wrong" (authoring) or "the command was fine, the world said no" (factual)?

authoring  = a malformed command: quoting/escaping bug, parse error, wrong
             invocation form, or a bug in code the model wrote inline.
factual    = the command was well-formed; a path was absent, a search matched
             nothing, the environment lacked the binary, or it timed out.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

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


# authoring-error signatures (the model's own command is malformed / buggy)
AUTHORING = [
    ('quoting/escaping', re.compile(
        r'ParserError.*?(?:缺少|缺失|MissingArgument|UnexpectedToken|意外的标记)'
        r'|表达式或语句中缺少|字符串缺少终止符|应该是|缺少右|MissingArgument'
        r'|找不到接受实际参数|找不到接受自变量|位置形式参数'
        r'|A command must follow -Command|ArgumentList.*?Null|无法对参数.*?执行参数验证'
        r'|Cannot bind argument|ParameterBindingException|InvalidArgument', re.I | re.S)),
    ('inline-code-bug', re.compile(
        r'ReferenceError|TypeError:|SyntaxError|is not defined|is not a function'
        r'|require is not defined|Cannot find module', re.I)),
    ('unbalanced-quote', re.compile(r'unterminated|unexpected EOF|bad substitution|缺少结束', re.I)),
]

# factual signatures (command was fine; the world said no)
FACTUAL = [
    ('path-absent', re.compile(
        r'找不到路径|Cannot find path|No such file or directory|ENOENT|Could not find a part'
        r'|系统找不到指定的路径|does not exist', re.I)),
    ('not-on-path', re.compile(
        r'项识别为 cmdlet|CommandNotFoundException|not recognized as the name'
        r'|不是内部或外部命令|command not found', re.I)),
    ('timeout/killed', re.compile(r'Command timed out or OOM|shell killed by signal|shell exited', re.I)),
]


def err_text(txt):
    m = re.search(r'\[stderr\]([\s\S]{0,600})', txt)
    body = m.group(1) if m else txt
    return body


def cause(txt, cmd):
    body = err_text(txt)
    # A path that lost its backslashes is a PowerShell escaping bug, not a real
    # missing directory: 'Users ainAppData...esourcesapp.asar'.
    if re.search(r'(?:^|\s)(?:Users|ProgramData|Windows)\s', body) and '\\' not in body.split('open')[-1][:200]:
        if 'ENOENT' in body or 'no such file' in body.lower():
            return 'authoring:quoting/escaping'
    for name, rx in AUTHORING:
        if rx.search(body):
            return f'authoring:{name}'
    for name, rx in FACTUAL:
        if rx.search(body):
            return f'factual:{name}'
    if re.search(r'\[(?:exit code:\s*[1-9]|Command finished with exit code\s*[1-9])', txt):
        return 'factual:nonzero-exit'
    return 'other'


files = []
for dp, _, fs in os.walk(ROOT):
    for f in fs:
        if re.search(r'\.jsonl(\.zstd)?$', f):
            files.append(os.path.join(dp, f))

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

stats = {'pwsh': Counter(), 'bash': Counter()}
calls = Counter()
examples = defaultdict(list)

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
            if d.get('name') in calls or d.get('name') in ('pwsh', 'bash'):
                calls[d.get('name')] += 1
        elif t == 'tool/result':
            m = d.get('message') if isinstance(d.get('message'), dict) else {}
            cid = m.get('toolCallId') or d.get('toolCallId')
            tool, cmd = pend.get(cid, ('?', ''))
            if tool not in stats:
                continue
            c = m.get('content')
            txt = '\n'.join(x.get('text', '') for x in c if isinstance(x, dict)) if isinstance(c, list) else ''
            if not re.search(r'\[stderr\]|\[exit code:\s*[1-9]|Command finished with exit code\s*[1-9]|timed out|killed', txt):
                continue
            cat = cause(txt, cmd)
            stats[tool][cat] += 1
            if len(examples[cat]) < 3:
                examples[cat].append((tool, re.sub(r'\s+', ' ', cmd)[:150],
                                      re.sub(r'\s+', ' ', err_text(txt))[:200]))

print('SHELL FAILURES BY CAUSE\n' + '=' * 78)
for tool in ('pwsh', 'bash'):
    total = sum(stats[tool].values())
    auth = sum(v for k, v in stats[tool].items() if k.startswith('authoring'))
    print(f"\n{tool}: {calls[tool]} calls, {total} failures "
          f"({total/max(calls[tool],1)*100:.1f}%)  -- authoring errors: {auth} "
          f"({auth/max(calls[tool],1)*100:.1f}% of calls)")
    for k, v in stats[tool].most_common():
        print(f"    {v:>4}  {k}")

print('\n\nREPRESENTATIVE EXAMPLES\n' + '=' * 78)
for cat in sorted(examples, key=lambda c: -sum(stats[t][c] for t in stats)):
    print(f"\n### {cat}  (pwsh={stats['pwsh'][cat]}, bash={stats['bash'][cat]})")
    for tool, cmd, err in examples[cat]:
        print(f"  [{tool}] {cmd}")
        print(f"        -> {err}")

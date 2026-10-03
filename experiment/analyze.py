#!/usr/bin/env python3
"""Measure reasoning effort for one or more session ids.

usage: analyze.py SESSION_ID [SESSION_ID ...]
       analyze.py --tag A|B SESSION_ID
       analyze.py --arm A|B
       analyze.py --list

Endpoints measured per session:
  chars_*   reasoning characters per step (log scale) -- primary, needs many sessions
  loose_*   'reopened/hesitated' marker count per step -- ~8x more sensitive
  tight_*   conservative 're-opened a settled question' set -- very sparse
Also records the arm (A/B) actually present in the session's system prompt, so a
mis-switched run cannot silently pollute a batch.
"""
import sys, os, glob, json, math, re, statistics

SESS = r"C:\Users\rain\.dsh\sessions"
RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")

ARM_A_NEEDLE = "Reasoning is private and is not the deliverable"
ARM_B_NEEDLE = "Private reasoning is cost you cannot ship"

LOOSE = re.compile(r"\bwait\b|\bactually\b|hold on|\bin fact\b|\bhowever\b|\bbut wait\b", re.I)
TIGHT = re.compile(
    r"let me reconsider|hold on|as I (already )?(determined|established|noted|concluded|verified|said)"
    r"|I already (determined|established|noted|verified|checked|said)"
    r"|going back to|re-?examin|already decided|settled (this|that|it)",
    re.I)


def session_file(sid):
    hits = glob.glob(os.path.join(SESS, "*", sid, "session.v4.jsonl.zstd"))
    return hits[0] if hits else None


def records(path):
    """Stream-decompress. Direct .decompress() fails: no content size in frame header."""
    import zstandard as zstd
    d = zstd.ZstdDecompressor()
    with open(path, "rb") as fh:
        with d.stream_reader(fh) as r:
            buf = b""
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                buf += chunk
    for line in buf.split(b"\n"):
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


def reasoning_text(rec):
    msg = (rec.get("data") or {}).get("message") or {}
    out = []
    for c in msg.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "reasoning":
            out.append(c.get("text") or "")
    return "\n".join(out)


def analyze(sid):
    path = session_file(sid)
    if not path:
        return {"session": sid, "error": "session file not found"}

    steps, effort, arm = [], None, None
    tool_names = []
    for rec in records(path):
        t = rec.get("type")
        data = rec.get("data") or {}
        if t == "request/header":
            h = data.get("header") or {}
            cfg = h.get("config") or {}
            effort = cfg.get("reasoningEffort", effort)
            tool_names = [x.get("name") for x in (h.get("tools") or []) if isinstance(x, dict)]
        elif t == "system/message":
            blob = json.dumps(data, ensure_ascii=False)
            if ARM_B_NEEDLE in blob:
                arm = "B"
            elif ARM_A_NEEDLE in blob:
                arm = "A"
        elif t == "assistant/message":
            steps.append(reasoning_text(rec))

    chars = [len(s) for s in steps]
    nonzero = [c for c in chars if c > 0]
    loose = [len(LOOSE.findall(s)) for s in steps]
    tight = [len(TIGHT.findall(s)) for s in steps]
    n = len(chars)
    total = sum(chars)
    return {
        "session": sid,
        "arm": arm,
        "effort": effort,
        "steps": n,
        "nonzero": len(nonzero),
        "chars_total": total,
        "chars_median": statistics.median(chars) if chars else 0,
        "chars_geo": math.exp(statistics.mean([math.log(c) for c in nonzero])) if nonzero else 0,
        "big_steps": sum(1 for c in chars if c >= 8000),
        "loose_total": sum(loose),
        "loose_per_step": (sum(loose) / n) if n else 0,
        "loose_density_per_1k": (1000 * sum(loose) / total) if total else 0,
        "tight_total": sum(tight),
        "tight_per_step": (sum(tight) / n) if n else 0,
        "tools_in_header": len(tool_names),
        "has_pwsh": ("pwsh" in tool_names) if tool_names else None,
    }


def tag(sid, arm):
    os.makedirs(RUNS, exist_ok=True)
    p = os.path.join(RUNS, "%s.txt" % arm)
    seen = set()
    if os.path.exists(p):
        seen = {l.strip() for l in open(p) if l.strip()}
    if sid not in seen:
        with open(p, "a") as fh:
            fh.write(sid + "\n")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--tag":
        tag(args[2], args[1].upper())
        print("tagged %s -> arm %s" % (args[2], args[1].upper()))
        sys.exit(0)
    if args and args[0] in ("--list", "--arm"):
        arms = [args[1].upper()] if args[0] == "--arm" else ["A", "B"]
        rows = []
        for a in arms:
            p = os.path.join(RUNS, "%s.txt" % a)
            if os.path.exists(p):
                for l in open(p):
                    if l.strip():
                        rows.append((a, l.strip()))
        for a, sid in rows:
            r = analyze(sid)
            print("%s %s" % (a, json.dumps(r, ensure_ascii=False)))
        sys.exit(0)
    for sid in args:
        print(json.dumps(analyze(sid), ensure_ascii=False, indent=1))

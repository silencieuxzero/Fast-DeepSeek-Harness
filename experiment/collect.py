#!/usr/bin/env python3
"""Collect every experiment session and report per-arm aggregates.

Experiment sessions are identified by session title (task_board sets the title
from the card title, which we prefix 'exp-A-' / 'exp-B-'), NOT by scanning text
for markers -- transcript text contains our own commands and gives false hits.

usage: collect.py [--since EPOCH_MS] [--json]
"""
import sys, os, glob, json, math, re, statistics, time

SESS = r"C:\Users\rain\.dsh\sessions"
ARM_A_NEEDLE = "Reasoning is private and is not the deliverable"
ARM_B_NEEDLE = "Private reasoning is cost you cannot ship"
LOOSE = re.compile(r"\bwait\b|\bactually\b|hold on|\bin fact\b|\bhowever\b|\bbut wait\b", re.I)


def records(path):
    import zstandard as zstd
    d = zstd.ZstdDecompressor()
    with open(path, "rb") as fh:
        with d.stream_reader(fh) as r:
            buf = b""
            while True:
                c = r.read(1 << 20)
                if not c:
                    break
                buf += c
    for line in buf.split(b"\n"):
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


def scan(path):
    title = None
    arm = None
    steps = []
    effort = None
    tool_names = []
    t0 = t1 = None
    for rec in records(path):
        t = rec.get("type")
        data = rec.get("data") or {}
        if t == "session/title":
            title = data.get("title")
        elif t == "request/header":
            h = data.get("header") or {}
            effort = (h.get("config") or {}).get("reasoningEffort", effort)
            tool_names = [x.get("name") for x in (h.get("tools") or []) if isinstance(x, dict)]
        elif t == "system/message":
            blob = json.dumps(data, ensure_ascii=False)
            arm = "B" if ARM_B_NEEDLE in blob else ("A" if ARM_A_NEEDLE in blob else arm)
        elif t == "step/start":
            if t0 is None:
                t0 = rec.get("time")
            t1 = rec.get("time")
        elif t == "assistant/message":
            msg = data.get("message") or {}
            txt = "\n".join(c.get("text") or "" for c in (msg.get("content") or [])
                            if isinstance(c, dict) and c.get("type") == "reasoning")
            steps.append(txt)
    chars = [len(s) for s in steps]
    nz = [c for c in chars if c > 0]
    loose = [len(LOOSE.findall(s)) for s in steps]
    n = len(chars)
    return {
        "title": title, "arm": arm, "effort": effort,
        "steps": n,
        "chars_total": sum(chars),
        "chars_geo": math.exp(statistics.mean([math.log(c) for c in nz])) if nz else 0,
        "chars_median": statistics.median(chars) if chars else 0,
        "big_steps": sum(1 for c in chars if c >= 8000),
        "loose_total": sum(loose),
        "loose_per_step": (sum(loose) / n) if n else 0,
        "tools": len(tool_names),
        "has_pwsh": ("pwsh" in tool_names) if tool_names else None,
        "path": path,
    }


def all_rows():
    rows = []
    for p in glob.glob(os.path.join(SESS, "*", "*", "session.v4.jsonl.zstd")):
        try:
            r = scan(p)
        except Exception:
            continue
        if r["title"] and str(r["title"]).startswith("exp-"):
            rows.append(r)
    rows.sort(key=lambda r: (r["arm"] or "?", str(r["title"])))
    return rows


def agg(rows):
    if not rows:
        return {}
    n = sum(r["steps"] for r in rows)
    tot = sum(r["chars_total"] for r in rows)
    loose = sum(r["loose_total"] for r in rows)
    nz = []
    for r in rows:
        if r["chars_geo"]:
            nz.append(r["chars_geo"])
    return {
        "sessions": len(rows), "steps": n,
        "chars_total": tot,
        "chars_per_step": tot / n if n else 0,
        "loose_total": loose,
        "loose_per_step": loose / n if n else 0,
        "loose_per_1k_chars": 1000 * loose / tot if tot else 0,
        "geo_of_geo": math.exp(statistics.mean([math.log(x) for x in nz])) if nz else 0,
        "big_steps": sum(r["big_steps"] for r in rows),
    }


if __name__ == "__main__":
    rows = all_rows()
    if "--json" in sys.argv:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        sys.exit(0)
    for arm in ("A", "B", None):
        sel = [r for r in rows if r["arm"] == arm]
        if not sel:
            continue
        print("=== arm %s ===" % (arm or "?"))
        for r in sel:
            print("  %-16s steps=%-3d chars=%-7d geo=%-7.0f loose=%-4d loose/step=%.2f big=%d pwsh=%s"
                  % (r["title"], r["steps"], r["chars_total"], r["chars_geo"],
                     r["loose_total"], r["loose_per_step"], r["big_steps"], r["has_pwsh"]))
        print("  AGG", json.dumps(agg(sel), ensure_ascii=False))

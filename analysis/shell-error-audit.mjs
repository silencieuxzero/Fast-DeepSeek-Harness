// shell-error-audit.mjs — measure per-shell command failure modes from real DSH session transcripts.
//
// Question it answers: "the model often types the wrong command under PowerShell —
// does the same happen under bash?"  Method: join tool/call -> tool/result by callId
// across every session transcript, bucket by shell tool name, and classify the
// failure text into named modes.
//
// Handles both plain .jsonl and DSH's compressed .jsonl.zstd (Node >= 22 zlib).
// Read-only. Inputs are passed as argv.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import readline from 'node:readline';

const roots = process.argv.slice(2);

/** Recursively collect transcript files under a path (or accept a file as-is). */
function collect(root, out = []) {
  let st;
  try { st = fs.statSync(root); } catch { return out; }
  if (st.isFile()) { if (/\.jsonl(\.zstd)?$/.test(root)) out.push(root); return out; }
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.jsonl(\.zstd)?$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = roots.flatMap((r) => collect(r));

/** Open a transcript as a UTF-8 line stream, transparently decompressing zstd. */
function openStream(file) {
  const buf = fs.readFileSync(file);
  const isZstd = file.endsWith('.zstd') || (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd);
  const data = isZstd ? zlib.zstdDecompressSync(buf) : buf;
  return readline.createInterface({ input: Readable.from([data]), crlfDelay: Infinity });
}

// ---- failure classification -------------------------------------------------
// IMPORTANT: DSH records a failed shell command with `isError: false` — the failure
// exists only as TEXT ("[stderr] ...", "[exit code: 1]"). So we classify by text.
//
// Ordered: first match wins. Patterns cover both English and Chinese PowerShell
// localizations (this machine's pwsh emits Chinese error text).
const MODES = [
  ['command-not-found', /CommandNotFoundException|is not recognized as the name|not recognized as an internal or external|command not found|: command not found|项识别为|无法将.*识别|不是内部或外部命令/i],
  ['syntax',            /ParserError|Unexpected token|syntax error|MissingEndCurlyBrace|Missing closing|TerminatorExpectedAtEndOfString|InvalidEndOfLine|MissingExpressionAfter|UnexpectedToken|意外的标记|分析错误|表达式或语句中缺少|应该是|缺少右|缺少.*}|hash 值必须|字符串缺少终止符|bad substitution|unexpected EOF|unterminated|语法错误/i],
  ['path-not-found',    /Cannot find path|No such file or directory|PathNotFound|ENOENT|Could not find a part of the path|找不到路径|系统找不到指定的路径|不存在/i],
  ['param-binding',     /ParameterBindingException|A parameter cannot be found|Cannot bind argument|missing a mandatory parameter|无法绑定|缺少参数|无法找到与参数名匹配的参数/i],
  ['permission',        /Permission denied|Access is denied|UnauthorizedAccess|拒绝访问/i],
  ['quoting/expansion', /too many arguments|ambiguous redirect|unbound variable|不能将.*识别/i],
];

function classify(text) {
  if (!text) return null;
  for (const [name, re] of MODES) if (re.test(text)) return name;
  return null; // no failure evidence in the text
}

function exitCode(text) {
  const m = text.match(/\[exit code:\s*(-?\d+)\]/i);
  return m ? Number(m[1]) : null;
}

/** tool/result carries text in different shapes across tool versions. */
function resultText(d) {
  const m = d?.message;
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m.content)) {
    return m.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
  }
  if (typeof m.content === 'string') return m.content;
  return '';
}

// ---- pass 1: map session id -> best (largest) file, to drop duplicate copies ----
const bySession = new Map(); // sessionId -> {file, size}
const noId = [];
for (const file of files) {
  let sid = null;
  try {
    const rl = openStream(file);
    for await (const line of rl) { // session header is the first line
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (j.type === 'session' && j.id) sid = j.id; } catch { /* ignore */ }
      break;
    }
  } catch { /* unreadable */ }
  const size = fs.statSync(file).size;
  if (!sid) { noId.push({ file, size }); continue; }
  const prev = bySession.get(sid);
  if (!prev || size > prev.size) bySession.set(sid, { file, size });
}
const chosen = [...bySession.values()].map((v) => v.file).concat(noId.map((v) => v.file));

// ---- pass 2: scan -----------------------------------------------------------------
const perTool = new Map();
const sessions = new Set();

function bucket(tool) {
  if (!perTool.has(tool)) {
    perTool.set(tool, { calls: 0, results: 0, errors: 0, orphans: 0, modes: new Map(), samples: [], exitCodes: [] });
  }
  return perTool.get(tool);
}

for (const file of chosen) {
  const pending = new Map();
  let sid = null;
  const rl = openStream(file);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'session' && j.id) { sid = j.id; sessions.add(j.id); continue; }

    if (j.type === 'tool/call') {
      const d = j.data ?? {};
      let args = d.arguments;
      try { args = typeof args === 'string' ? JSON.parse(args) : args; } catch { /* keep raw */ }
      pending.set(d.callId, { tool: d.name, command: args?.command ?? '' });
      bucket(d.name).calls += 1;
      continue;
    }

    if (j.type === 'tool/result') {
      const d = j.data ?? {};
      // The id lives at data.message.toolCallId — data.toolCallId is undefined.
      const callId = d.message?.toolCallId ?? d.toolCallId;
      const call = pending.get(callId);
      const tool = call?.tool ?? d.name ?? '(unknown)';
      const b = bucket(tool);
      b.results += 1;
      if (!call) b.orphans += 1;

      const text = resultText(d);
      const mode = classify(text);
      const ec = exitCode(text);
      if (ec !== null) b.exitCodes.push(ec);
      // "error" = explicit shell-level failure evidence (not merely a non-zero exit,
      // which is a normal answer for grep/test/ls).
      if (mode) {
        b.errors += 1;
        b.modes.set(mode, (b.modes.get(mode) ?? 0) + 1);
        if (b.samples.length < 6) {
          b.samples.push({
            session: sid,
            command: String(call?.command ?? '').slice(0, 220),
            mode,
            exitCode: ec,
            evidence: text.replace(/\s+/g, ' ').slice(0, 300),
          });
        }
      }
      continue;
    }
  }
}

// ---- report -----------------------------------------------------------------
console.log(`scanned ${chosen.length} transcript(s) (from ${files.length} file(s)), ${sessions.size} distinct session(s)\n`);

const shells = ['pwsh', 'bash', 'powershell', 'shell', 'sh', 'cmd'];
const rows = [...perTool.entries()].filter(([t]) => shells.includes(t)).sort((a, b) => b[1].calls - a[1].calls);

console.log('shell      calls  results  errs   err%   nonzero-exit   failures by mode');
console.log('--------  ------  -------  ----  -----  ------------   ------------------');
for (const [tool, b] of rows) {
  const pct = b.calls ? ((b.errors / b.calls) * 100).toFixed(1) : '0.0';
  const nz = b.exitCodes.filter((c) => c !== 0).length;
  const modes = [...b.modes.entries()].sort((x, y) => y[1] - x[1]).map(([m, n]) => `${m}:${n}`).join('  ');
  console.log(`${tool.padEnd(8)}  ${String(b.calls).padStart(6)}  ${String(b.results).padStart(7)}  ${String(b.errors).padStart(4)}  ${pct.padStart(5)}  ${String(nz).padStart(12)}   ${modes}`);
}

const er = rows.find(([t]) => t === 'pwsh')?.[1];
const br = rows.find(([t]) => t === 'bash')?.[1];
if (er && br) {
  const a = er.errors / (er.calls || 1), c = br.errors / (br.calls || 1);
  console.log(`\npwsh failure rate ${(a * 100).toFixed(2)}% vs bash ${(c * 100).toFixed(2)}%  -> ratio ${c ? (a / c).toFixed(2) : 'n/a'}x`);
}

console.log('\n--- samples per shell ---');
for (const [tool, b] of rows) {
  console.log(`\n[${tool}]  (showing ${b.samples.length} of ${b.errors})`);
  b.samples.forEach((s) => {
    console.log(`  mode=${s.mode} exit=${s.exitCode}`);
    console.log(`  cmd : ${s.command}`);
    console.log(`  err : ${s.evidence}`);
  });
}

console.log('\n--- non-shell tools (context) ---');
[...perTool.entries()].filter(([t]) => !shells.includes(t))
  .sort((a, b) => b[1].calls - a[1].calls).slice(0, 14)
  .forEach(([t, b]) => console.log(`  ${t.padEnd(24)} calls=${String(b.calls).padStart(5)} errors=${b.errors}`));

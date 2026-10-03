// CORRECTED end-to-end measurement of a persistent Git Bash as DSH observes it.
// Fixes the previous harness bug: startSend() calls resetReadinessEvidence()
// (dsh-terminal-bash/lib/index.js:520 and :552), so promptSeen/promptTextSeen/
// promptTail are cleared before every write. A stale `promptTextSeen=true`
// therefore CANNOT make the fast path fire immediately.
//
// Also models the real consumer (dsh-tool-bash-persistent/lib/index.js:265-310):
// it loops, and on a settle without the END marker it re-sends with empty text
// (which resets readiness evidence again). So a premature settle costs extra
// round trips, not truncation.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const req = createRequire("C:/Users/rain/.dsh/profiles/node_modules/dsh-desktop-next/");
const pty = req("node-pty");

const CONTROLLED_PROMPT = "dsh> ";
const env = {
  ...process.env,
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
  DSH_SHELL: "1",
  PS1: CONTROLLED_PROMPT,
  PROMPT_COMMAND: `printf "\\033]133;D;%s\\007" "$?"; PS1='${CONTROLLED_PROMPT}'`,
  BASH_SILENCE_DEPRECATION_WARNING: "1",
};

function makeSanitizer() {
  let pending = "";
  let tracking = false;
  return {
    push(chunk) {
      pending += chunk;
      let text = "";
      let prompt = false;
      let includeTail = tracking;
      let tail = "";
      const appendText = (v) => {
        text += v;
        if (tracking) tail += v;
      };
      let i = 0;
      while (i < pending.length) {
        const escape = pending.indexOf("\x1B", i);
        if (escape < 0) {
          appendText(pending.slice(i));
          i = pending.length;
          break;
        }
        appendText(pending.slice(i, escape));
        if (escape + 1 >= pending.length) {
          i = escape;
          break;
        }
        const kind = pending[escape + 1];
        if (kind === "]") {
          const bel = pending.indexOf("\x07", escape + 2);
          const st = pending.indexOf("\x1B\\", escape + 2);
          let end = -1;
          if (bel >= 0 && st >= 0) end = Math.min(bel + 1, st + 2);
          else if (bel >= 0) end = bel + 1;
          else if (st >= 0) end = st + 2;
          if (end < 0) {
            i = escape;
            break;
          }
          const term = pending[end - 1] === "\x07" ? 1 : 2;
          if (pending.slice(escape + 2, end - term).startsWith("133;D;")) {
            prompt = true;
            tracking = true;
            includeTail = true;
            tail = "";
          }
          i = end;
          continue;
        }
        if (kind === "[") {
          let end = escape + 2;
          while (end < pending.length) {
            const code = pending.charCodeAt(end);
            if (code >= 64 && code <= 126) break;
            end += 1;
          }
          if (end >= pending.length) {
            i = escape;
            break;
          }
          i = end + 1;
          continue;
        }
        i = escape + 2;
      }
      pending = pending.slice(i);
      return { text, prompt, ...(includeTail ? { promptTail: tail } : {}) };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quoteForBash = (v) =>
  `$'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\r", "\\r").replaceAll("\n", "\\n")}'`;
const markers = () => {
  const id = randomUUID();
  return { start: `__DSH_PERSISTENT_BASH_START_${id}__`, end: `__DSH_PERSISTENT_BASH_END_${id}:` };
};
const wrapCommand = (c, m) =>
  `printf '%s\\n' ${quoteForBash(m.start)}; eval -- ${c}; __dsh_persistent_bash_status=$?; printf '%s%s\\n' ${quoteForBash(m.end)} "$__dsh_persistent_bash_status"`;

const CASES = [
  { name: "noop (true)", cmd: "true", want: null },
  { name: "printf x", cmd: "printf 'x'", want: "x" },
  { name: "ls -A | wc -l", cmd: "ls -A | wc -l", want: null },
  { name: "silent 1.5s then print", cmd: "sleep 1.5; printf 'LATE'", want: "LATE" },
  { name: "output, 1.2s silence, output", cmd: "printf 'A'; sleep 1.2; printf 'B'", want: "B" },
  { name: "seq 1 2000", cmd: "seq 1 2000", want: "2000" },
  { name: "20KB single line", cmd: "printf '%s' \"$(head -c 20000 /dev/zero | tr '\\0' 'z')\"", want: null },
];

async function run({ echoOff, idleSilenceMs, handoffGraceMs, pollIntervalMs, label }) {
  const p = pty.spawn("C:\\Program Files\\Git\\bin\\bash.exe", ["--noprofile", "--norc", "-i"], {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: process.cwd(),
    env,
  });
  const san = makeSanitizer();
  const S = { promptSeen: false, promptTextSeen: false, promptTail: "", lastOutputAt: Date.now(), scrollbackNonEmpty: false };
  let raw = "";
  p.onData((d) => {
    raw += d;
    const s = san.push(d);
    if (s.text.length > 0) {
      S.lastOutputAt = Date.now();
      S.scrollbackNonEmpty = true;
    }
    if (s.prompt) {
      S.promptSeen = true;
      S.promptTail = "";
      S.lastOutputAt = Date.now();
    }
    if (S.promptSeen && s.promptTail !== undefined) {
      const remaining = Math.max(0, 6 - S.promptTail.length);
      S.promptTail += s.promptTail.slice(0, remaining);
      if (s.promptTail.length > remaining) S.promptTail = `${CONTROLLED_PROMPT}\0`;
      S.promptTextSeen = S.promptTail === CONTROLLED_PROMPT;
    }
  });
  // mirrors Session.resetReadinessEvidence() (index.js:575-580)
  const reset = () => {
    S.lastOutputAt = Date.now();
    S.promptSeen = false;
    S.promptTextSeen = false;
    S.promptTail = "";
  };

  await sleep(800);
  p.write(echoOff ? "stty -echo\r" : "\r");
  await sleep(600);

  const rows = [];
  for (const c of CASES) {
    const m = markers();
    const t0 = Date.now();
    let text = null;
    let sends = 0;
    let settled = false;
    let fastSeen = false;
    while (Date.now() - t0 < 15000) {
      // mirror dsh-tool-bash-persistent: startSend with text on first pass,
      // then empty text on each retry
      text = sends === 0 ? wrapCommand(c.cmd, m) : "";
      reset();
      const submit = sends === 0;
      sends++;
      p.write(text + (submit ? "\r" : ""));
      // pollReadiness loop until settle
      const tSend = Date.now();
      settled = false;
      while (Date.now() - tSend < Math.max(12000, idleSilenceMs * 3 + handoffGraceMs + 500)) {
        const idleFor = Date.now() - S.lastOutputAt;
        if (S.promptSeen && S.promptTextSeen && idleFor >= pollIntervalMs) {
          fastSeen = true;
          settled = true;
          break;
        }
        const handoff = S.promptSeen ? handoffGraceMs : 0;
        if (S.scrollbackNonEmpty && idleFor >= idleSilenceMs + handoff) {
          settled = true;
          break;
        }
        if (raw.includes(m.end)) {
          settled = true;
          break;
        }
        await sleep(5);
      }
      if (raw.includes(m.end)) break;
      if (Date.now() - t0 >= 15000) break;
      await sleep(5);
    }
    const ms = Date.now() - t0;
    const bodyStart = raw.lastIndexOf(m.start);
    const bodyEnd = raw.lastIndexOf(m.end);
    const body = bodyStart >= 0 && bodyEnd > bodyStart ? raw.slice(bodyStart + m.start.length, bodyEnd) : "";
    const ok = !raw.includes(m.end) ? false : c.want === null ? true : body.includes(c.want);
    rows.push({ name: c.name, ms, sends, fastSeen, ok, complete: raw.includes(m.end) });
    await sleep(60);
  }
  p.kill();
  console.log(`\n--- ${label} ---`);
  for (const r of rows) {
    console.log(
      `  ${r.complete && r.ok ? "OK  " : "BAD "} ${String(r.ms).padStart(6)}ms  retries=${r.sends - 1}  fastpath=${r.fastSeen ? "Y" : "n"}  ${r.name}`,
    );
  }
  return rows;
}

(async () => {
  console.log("persistent Git Bash -- end-to-end per tool call, correct reset semantics\n");
  await run({ echoOff: false, idleSilenceMs: 3000, handoffGraceMs: 500, pollIntervalMs: 50, label: "echo ON   idle=3000 handoff=500 (shipped defaults)" });
  await run({ echoOff: false, idleSilenceMs: 600, handoffGraceMs: 50, pollIntervalMs: 50, label: "echo ON   idle=600 handoff=50 (pwsh-tuned values)" });
  await run({ echoOff: true, idleSilenceMs: 3000, handoffGraceMs: 500, pollIntervalMs: 50, label: "stty-echo idle=3000 handoff=500 (shipped defaults)" });
  await run({ echoOff: true, idleSilenceMs: 600, handoffGraceMs: 50, pollIntervalMs: 50, label: "stty-echo idle=600 handoff=50 (pwsh-tuned values)" });
  process.exit(0);
})();

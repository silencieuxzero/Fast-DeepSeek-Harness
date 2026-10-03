// Safety test: at each idleSilenceMs setting, does a persistent Git Bash
// survive commands that go SILENT mid-execution, print late, stutter, or emit
// lots of output? Truncation would make a low idleSilenceMs unusable.
//
// Emulates pollReadiness settlement + the persistent tool's marker contract:
// settle when (fast path) OR (idle >= idleSilenceMs + handoff). After settle,
// report whether the END marker was already present (complete) or not (partial
// -> the real tool would return truncated output).
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
  { name: "silent 1.5s then print (sleep 1.5)", cmd: "sleep 1.5; printf 'LATE_OK\\n'", want: "LATE_OK" },
  { name: "silent 0.8s then print (sleep 0.8)", cmd: "sleep 0.8; printf 'LATE_OK\\n'", want: "LATE_OK" },
  { name: "output, 1.2s silence, output", cmd: "printf 'A\\n'; sleep 1.2; printf 'B\\n'", want: "B" },
  { name: "2000 lines", cmd: "seq 1 2000", want: "2000" },
  { name: "big single line", cmd: "printf '%s' \"$(head -c 20000 /dev/zero | tr '\\0' 'z')\"; printf '\\n'", want: "zzzz" },
  { name: "no output at all", cmd: "true", want: null },
];

async function run(idleSilenceMs, handoffGraceMs, pollIntervalMs, echoOff) {
  const p = pty.spawn("C:\\Program Files\\Git\\bin\\bash.exe", ["--noprofile", "--norc", "-i"], {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: process.cwd(),
    env,
  });
  const san = makeSanitizer();
  const S = { promptSeen: false, promptTextSeen: false, promptTail: "", lastOutputAt: Date.now(), scrollbackNonEmpty: false };
  let all = "";
  p.onData((d) => {
    all += d;
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

  await sleep(800);
  p.write(echoOff ? "stty -echo\r" : "\r");
  await sleep(500);

  const out = [];
  for (const c of CASES) {
    const m = markers();
    const t0 = Date.now();
    S.lastOutputAt = Date.now();
    p.write(wrapCommand(c.cmd, m) + "\r");
    let waited = 0;
    let settledFor = null;
    while (Date.now() - t0 < 15000) {
      const sinceWrite = Date.now() - t0;
      const idleFor = Date.now() - S.lastOutputAt;
      const complete = all.includes(m.end);
      // The real tool re-checks the marker after every settle, so a premature
      // settle is only fatal if the marker never arrives before the loop ends.
      if (complete) {
        settledFor = sinceWrite;
        break;
      }
      const fast = S.promptSeen && S.promptTextSeen && idleFor >= pollIntervalMs;
      const handoff = S.promptSeen ? handoffGraceMs : 0;
      const fallback = S.scrollbackNonEmpty && idleFor >= idleSilenceMs + handoff;
      if ((fast || fallback) && sinceWrite > 30) {
        // settled but incomplete -> the tool would return a PARTIAL result
        waited++;
        settledFor = sinceWrite;
        // let it run on to see how late the real completion is
        const t2 = Date.now();
        while (!all.includes(m.end) && Date.now() - t2 < 12000) await sleep(20);
        break;
      }
      await sleep(5);
    }
    const bodyStart = all.lastIndexOf(m.start);
    const bodyEnd = all.lastIndexOf(m.end);
    const body = bodyStart >= 0 && bodyEnd > bodyStart ? all.slice(bodyStart + m.start.length, bodyEnd) : "";
    const ok = c.want === null ? true : body.includes(c.want);
    out.push({
      case: c.name,
      premature: waited > 0,
      complete: all.includes(m.end),
      contentOk: ok,
      ms: Date.now() - t0,
    });
    await sleep(50);
  }
  p.kill();
  console.log(`\n--- idle=${idleSilenceMs} handoff=${handoffGraceMs} echoOff=${echoOff} ---`);
  for (const r of out) {
    console.log(
      `  ${r.premature ? "PREMATURE" : "clean    "}  complete=${r.complete ? "Y" : "N"} content=${r.contentOk ? "OK" : "MISSING"}  ${String(r.ms).padStart(6)}ms  ${r.case}`,
    );
  }
  return out.some((r) => r.premature && !r.contentOk) || out.some((r) => !r.contentOk);
}

(async () => {
  console.log("Truncation safety of a persistent Git Bash, by idleSilenceMs\n");
  await run(3000, 500, 50, false);
  await run(600, 50, 50, false);
  await run(600, 50, 50, true);
  await run(100, 50, 50, true);
  process.exit(0);
})();

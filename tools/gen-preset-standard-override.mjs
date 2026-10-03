// Generate the `preset-standard` override block for the desktop profile patch,
// replacing the shipped one-shot `tool-pwsh` row with a persistent pwsh group.
//
// This works on the SHIPPED standard.patch.yml text and emits YAML at the
// correct indent, so the plugins list is restated verbatim and cannot drift.
//
// Usage: node gen-preset-standard-override.mjs <standard.patch.yml> <minimal.patch.yml> <out.yml>

import { readFileSync, writeFileSync } from "node:fs";

const [stdPath, minPath, outPath] = process.argv.slice(2);
if (!stdPath || !minPath || !outPath) {
  console.error("usage: node gen-preset-standard-override.mjs <standard.patch.yml> <minimal.patch.yml> <out.yml>");
  process.exit(2);
}

const rd = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n").split("\n");
const std = rd(stdPath);
const min = rd(minPath);

// Shipped files indent the plugins list under `- insert: > - id: ... > config:`.
// Both standard and minimal use the same 10-space indent for `- id:` members.
const MEMBER = /^ {10}- id: /;

function entry(lines, id, file) {
  const start = lines.findIndex((l) => l === `          - id: ${id}`);
  if (start < 0) throw new Error(`entry '${id}' not found in ${file}`);
  let end = start + 1;
  while (end < lines.length && !MEMBER.test(lines[end])) end += 1;
  return { start, end, text: lines.slice(start, end).join("\n").replace(/\s+$/, "") };
}

// 1. the tool-pwsh entry we are dropping
const pwsh = entry(std, "tool-pwsh", stdPath);
if (!pwsh.text.includes("@deepseek-ai/dsh-tool-pwsh")) {
  throw new Error("tool-pwsh entry does not reference @deepseek-ai/dsh-tool-pwsh");
}

// 2. the persistent-shell group we are borrowing from minimal
const group = entry(min, "persistent-shell", minPath).text;
if (!group.includes("dsh-tool-pwsh-persistent")) {
  throw new Error("persistent-shell group does not reference dsh-tool-pwsh-persistent");
}
// minimal's group is already at the 10-space member indent we need.

// 3. rebuild standard's plugins list with the swap
const listStart = std.findIndex((l) => l === "        plugins:");
if (listStart < 0) throw new Error("plugins: not found in standard.patch.yml");
// start at `plugins:` so the key comes along; its members are at 10 spaces and
// the whole shipped subtree is uniformly -4 from where we need it.
const rebuilt = [...std.slice(listStart, pwsh.start), ...group.split("\n"), ...std.slice(pwsh.end)]
  .join("\n")
  .replace(/\s+$/, "");

// The shipped files nest `plugins:` 8 deep with members at 10; in our override
// it sits under `config:` at 4 with members at 6 — a uniform -4 shift, which
// preserves the relative structure of the whole subtree.
const dedent4 = (text) => text.replace(/^ {4}/gm, "");

const header = `# ---------------------------------------------------------------------------
# PERSISTENT PWSH — replaces the shipped one-shot pwsh tool with a shell that
# is owned by the agent and stays alive for the whole conversation.
#
# WHY: dsh-tool-pwsh starts a brand-new "pwsh -NoLogo -NoProfile -NonInteractive
# -Command" process for EVERY call (dsh-pwsh-local/README: "no shell state
# survives between calls"). On this machine that costs 640 ms of pure process
# startup per call, measured; the persistent shell measures 109 ms. Across a
# 123-call session that is the difference between ~79 s and ~13 s.
#
# WHY IT MUST BE 'preset-standard': the web bundle disables the HOST-level
# tool-pwsh row (dsh-web-app/cordis.patch.yml:447-451) and moves the agent plane
# behind agent presets. Editing dsh-base's tool-pwsh row, or the profile's, is a
# silent no-op. There is no user-facing config field for this — the preset
# declaration IS the switch.
#
# WHAT IT DOES: a Cordis patch override is keyed by loader row id, and replaces
# the complete config. So this restates the shipped standard preset verbatim and
# swaps exactly one member: the 'tool-pwsh' entry becomes a 'persistent-shell'
# group (pty + terminal-bash(shellDialect: pwsh) + dsh-tool-pwsh-persistent),
# copied from the upstream minimal preset.
#
# GENERATED — do not hand-edit the plugins list below.
#   node <workspace>\\fast-mode-preset\\tools\\gen-preset-standard-override.mjs \\
#     <dsh-web-app>/presets/standard.patch.yml \\
#     <dsh-web-app>/presets/minimal.patch.yml <out>
# The path shown in this block is the SHIPPED file; the live app.asar copy is
# what the runtime actually composes.
#
# REVERT: delete this whole block (or restore
# cordis.patch.yml.bak-before-persistent-pwsh), then reload the loader and
# start a NEW session.
#
# SCOPE: agent presets are activated once and shared by selecting Agents, so an
# existing session keeps the revision it booted with. Only sessions started
# after this edit pick up the persistent shell.
#
# KNOWN LIMIT: dsh-tool-pwsh-persistent declares no isConcurrencySafe, so like
# dsh-tool-pwsh it is exclusive (dsh-tools/lib/index.js:3057 fails closed). It
# removes the per-call process tax but does NOT recover the parallel-scheduling
# loss that exclusivity causes.
# ---------------------------------------------------------------------------`;

const out = `${header}
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
${dedent4(rebuilt)}
`;

writeFileSync(outPath, out, "utf8");
console.log(`wrote ${outPath}`);
console.log(`  dropped:  ${pwsh.text.split("\n").length} lines (tool-pwsh)`);
console.log(`  inserted: ${group.split("\n").length} lines (persistent-shell)`);
console.log(`  total:    ${out.split("\n").length} lines`);

// Generate the `bash-first` agent-preset row from the live `preset-standard`
// override already present in the profile patch.
//
// WHY A GENERATOR AND NOT A HAND-WRITTEN BLOCK
// A Cordis patch override is keyed by loader row id and replaces the COMPLETE
// config, so a second preset has to restate the entire ~200-line plugin list.
// That list also contains `!!js` expressions, folded scalars and deep
// indentation. Slicing the live text is exact; retyping it is not.
//
// INDENTATION: the profile's `preset-standard` override is the shipped insert
// form dedented by 4 (see ./gen-preset-standard-override.mjs in this directory,
// which did `dedent4`). We re-indent the finished block by 4 to put it back
// under a top-level `- insert:` list. All edits below happen in the dedented
// coordinate system.
//
// WHAT IT CHANGES relative to the block it is derived from:
//   1. row id      preset-standard -> preset-bash-first   (+ a new insert row)
//   2. config.id   standard        -> bash-first          (+ name/description)
//   3. config.order 1              -> 5                   (roster position)
//   4. terminal-pwsh + persistent-pwsh go from `disabled: true` to
//      `disabled: !!js process.platform !== 'win32'` — PowerShell is ENABLED
//      on Windows, because it is the fallback the gate unlocks.
//   5. both pwsh members get `backendType: shell-pwsh`. THIS IS LOAD-BEARING:
//      dsh-terminal-bash's PTY backend keys off `backendType` (default "shell")
//      and dsh-terminal refuses a repeated type with DUPLICATE_BACKEND
//      (dsh-terminal/lib/index.js:69), so enabling the pwsh backend next to the
//      bash one under the default name would fail the whole group mount.
//      dsh-tool-pwsh-persistent spawns with `type: config.backendType`
//      (ppwsh.js:223), so the tool side must name the same non-default type.
//   6. a `shell-fallback` member is added INSIDE the preset's `plugins`, right
//      after `persistent-shell`. Placement matters: a profile-level row would
//      also match `standard`-preset agents (they see both a bash and a pwsh
//      tool too), silently re-shaping a preset the user did not ask to change.
//      As a preset member the listener is scoped to the preset's standing
//      mount, which is the agent scope's PARENT (apr.js:678
//      `bindScopeParent(agentKey, generation.key)`), so it catches exactly the
//      agents that joined bash-first. `./shell-fallback.mjs` resolves against
//      the declaring plugin's baseUrl (apr.js:535), i.e. the profile directory —
//      the same mechanism the (now deleted) `./reasoning-budget.mjs` row used.
//   7. the three `cordis`-preset capabilities are folded in (see step 3b):
//      a `tool-cordis` row, `skill-filesystem.customSkillDirs` pointing at the
//      Cordis authoring skills, and `tool-plugin-manager` un-gated.
//   8. a `tool-presentation` row with `mode: both` (see step 3c) turns on PTC
//      (programmatic tool calling) alongside the native schemas. This is the
//      ONE row that carries the `ptc` preset's capability; the factory `ptc`
//      preset pairs it with disabling `workflow-ptc`/`tool-workflow`, which
//      this preset deliberately does NOT do — see the note in step 3c.
//
// Usage:
//   node gen-bash-first-preset.mjs <profile cordis.patch.yml> <out.yml>

import { readFileSync, writeFileSync } from 'node:fs'

const [, , patchPath, outPath] = process.argv
if (!patchPath || !outPath) {
  console.error('usage: node gen-bash-first-preset.mjs <cordis.patch.yml> <out.yml>')
  process.exit(2)
}

const ORDER = 5
const INDENT = 4
const SRC = readFileSync(patchPath, 'utf8')
const srcLines = SRC.split('\n')

// --- 1. isolate the top-level `- id: preset-standard` entry -----------------
const start = srcLines.findIndex((line) => line === '- id: preset-standard')
if (start < 0) throw new Error(`preset-standard entry not found in ${patchPath}`)
let end = srcLines.length
for (let i = start + 1; i < srcLines.length; i += 1) {
  if (/^- /.test(srcLines[i])) { end = i; break }
}
const block = srcLines.slice(start, end)
while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()

// --- 2. header rewrite (still in the 0-indent override form) ----------------
block[0] = '- id: preset-bash-first'
if (block[1] !== "  name: '@deepseek-ai/dsh-agent-preset'") {
  throw new Error(`unexpected row name at line 2 of the block: ${JSON.stringify(block[1])}`)
}

const header = block.findIndex((line) => line === '    id: standard')
if (header < 0) throw new Error('config.id not found in the preset-standard block')
block[header] = '    id: bash-first'
block.splice(
  header + 1,
  0,
  '    name: 快速模式',
  '    description: 只使用 Bash；连续失败后才解锁 PowerShell。',
)

const orderLine = block.findIndex((line) => line === '    order: 1')
if (orderLine < 0) throw new Error('config.order not found in the preset-standard block')
block[orderLine] = `    order: ${ORDER}`

// --- 3. enable + re-type the two pwsh members -------------------------------
// Group members sit at indent 10 (`          - id: pty`).
const memberSpans = () => {
  const spans = new Map()
  for (let i = 0; i < block.length; i += 1) {
    const match = /^ {10}- id: /.exec(block[i])
    if (match === null) continue
    let stop = block.length
    for (let j = i + 1; j < block.length; j += 1) {
      if (/^ {10}- id: /.test(block[j])) { stop = j; break }
    }
    spans.set(block[i].slice(match[0].length).trim(), { start: i, end: stop })
  }
  return spans
}

for (const [id, span] of memberSpans()) {
  if (id !== 'terminal-pwsh' && id !== 'persistent-pwsh') continue

  // Drop the comments that only explain why the member used to be disabled;
  // they would be a lie in this preset.
  const kept = block.slice(span.start, span.end).filter((line) => !/^\s+#/.test(line))

  const where = kept.findIndex((line) => /^\s+disabled: true$/.test(line))
  if (where < 0) throw new Error(`member ${id} is not \`disabled: true\` any more`)
  kept[where] = "            disabled: !!js process.platform !== 'win32'"

  const cfg = kept.findIndex((line) => line === '            config:')
  if (cfg < 0) throw new Error(`member ${id} has no config:`)
  kept.splice(cfg + 1, 0, '              backendType: shell-pwsh')

  block.splice(span.start, span.end - span.start, ...kept)
}

// --- 3b. grant the creation-mode ('cordis' preset) capabilities --------------
// The user asked for bash-first to carry the FULL feature set of `standard` PLUS
// everything `cordis` (the UI's 「创造模式」) can do. Diffing the two shipped
// definitions (dsh-web-app/presets/{standard,cordis}.patch.yml) shows exactly
// three deltas, all reproduced here:
//
//   (a) a `tool-cordis` row                      -> cordis_inspect_list/query
//   (b) `skill-filesystem` gains customSkillDirs -> the three Cordis authoring
//       skills ship inside @deepseek-ai/dsh-agent-preset/skills
//   (c) `tool-plugin-manager` is un-gated       -> `disabled: !!js "!ctx.get('profileContext')"`
//
// (a) needs no bundle-level work: dsh-web-app/cordis.patch.yml:144-151 mounts
// `cordis-host-runner` and `cordis-inspect-providers` at BUNDLE level with the
// comment "The Host inspect providers are process-global ... so they register
// here once and every preset's `tool-cordis` row reads them." The preset row is
// the only gate.
//
// (b) CANNOT be copied verbatim from the factory cordis preset. That file is
// evaluated with baseUrl = the web-app `presets/` directory, so
// `createRequire(baseUrl)` finds @deepseek-ai/dsh-agent-preset. THIS patch is
// evaluated with baseUrl = the PROFILE directory, where that call throws
// MODULE_NOT_FOUND (measured: profiles/desktop/ and profiles/ both fail). The
// expression below therefore walks UP to the junction that holds the package
// tree — profiles/node_modules/dsh-desktop-next is a junction onto the DSH
// install — and resolves from there. Measured working from the profile baseUrl,
// returning .../dsh-agent-preset/skills with all three skills present.
// Top-level rows read `      - id: <id>` here: 6 spaces, then `- id: ` (6
// chars), so the id itself begins at index 12.
const topRow = /^ {6}- id: /;
const topSpans = () => {
  const spans = []
  for (let i = 0; i < block.length; i += 1) {
    if (!topRow.test(block[i])) continue
    let stop = block.length
    for (let j = i + 1; j < block.length; j += 1) {
      if (topRow.test(block[j])) { stop = j; break }
    }
    spans.push({ id: block[i].slice(12).trim(), start: i, end: stop })
  }
  return spans
}
// NOTE: every lookup must be recomputed at use time. The splices below insert
// lines, so a span captured once up front would carry stale indices — the
// `tool-cordis` row would land inside `tool-web`'s config instead of after it.
const spanOf = (id) => topSpans().find((s) => s.id === id)

// (c) un-gate the plugin manager exactly as the cordis preset does.
{
  const span = spanOf('tool-plugin-manager')
  if (!span) throw new Error('top-level plugin row `tool-plugin-manager` not found')
  const at = block.findIndex(
    (line, i) => i >= span.start && i < span.end && line === '        disabled: true',
  )
  if (at < 0) throw new Error('`tool-plugin-manager` is not `disabled: true` any more')
  block[at] = '        disabled: !!js "!ctx.get(\'profileContext\')"'
}

// (b) add the bundled Cordis authoring skills to the skill catalog.
{
  const span = spanOf('skill-filesystem')
  if (!span) throw new Error('top-level plugin row `skill-filesystem` not found')
  if (block.slice(span.start, span.end).some((line) => /^\s+customSkillDirs:/.test(line))) {
    throw new Error('`skill-filesystem` already carries customSkillDirs')
  }
  const nameLine = block.findIndex(
    (line, i) => i >= span.start && i < span.end && /^\s+name: /.test(line),
  )
  if (nameLine < 0) throw new Error('`skill-filesystem` has no name line')
  block.splice(
    nameLine + 1,
    0,
    '        config:',
    '          customSkillDirs:',
    "            - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(new URL('../node_modules/dsh-desktop-next/package.json', baseUrl)).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')",
  )
}

// (a) register the runtime inspection tools, placed where the cordis preset
// puts them (immediately after `tool-web`).
{
  const span = spanOf('tool-web')
  if (!span) throw new Error('top-level plugin row `tool-web` not found')
  if (spanOf('tool-cordis')) throw new Error('`tool-cordis` already present')
  block.splice(
    span.end,
    0,
    '      - id: tool-cordis',
    "        name: '@deepseek-ai/dsh-tool-cordis'",
  )
}

// --- 3c. turn on PTC (programmatic tool calling) in 'both' mode --------------
// The factory `ptc` preset (dsh-web-app/presets/ptc.patch.yml) differs from
// `standard` in exactly four ways, and this is the load-bearing one:
//
//   - id: tool-presentation
//     name: '@deepseek-ai/dsh-agent-tool-presentation'
//     config:
//       mode: ptc
//
// `mode` is required and takes `native` | `ptc` | `both`:
//   native -> one JSON schema per tool (the deployment default; what this
//             preset had before this row existed).
//   ptc    -> the model sees ONLY `run_code` plus a generated SDK declaration
//             block, and a system-prompt section states that naming any other
//             tool directly fails. `wireSchemas(scope)` keeps `run_code` alone.
//   both   -> `run_code` AND every native schema ship together; the model
//             picks. The SDK block is rendered either way.
//
// WE CHOSE `both`, not `ptc`. Under pure `ptc` the `bash` schema disappears from
// the request, so this preset's entire identity — "bash is the only shell
// callable, and `shell-fallback`'s 10155 prompt section tells the model to
// prefer it" — would be narrated to a model that cannot see a bash tool. The
// prompt would describe a tool the wire never advertises. `both` keeps the
// bash-first contract intact and adds concurrency/context economy on top.
//
// REQUIREMENTS, both already satisfied on this machine:
//   (a) a composed `ctx.ptcRuntime`. `presentAs(mode)` calls
//       `requirePtcRuntime(mode)` for any non-native mode, which throws
//       `dsh-tools: mode "..." requires a PTC runtime ...` when absent.
//       The `include:ptc-runtime` row (@deepseek-ai/dsh-ptc-runtime-node) is
//       active in this profile.
//   (b) a registered SDK renderer for `runtime.language` (TypeScript/Python).
//   When either is missing the whole PRESET is rejected at mount by
//   dsh-agent-preset-registry — it does not degrade to native.
//
// ONE DECLARATION PER AGENT. `presentAs` throws `tools.presentAs("...")
// conflicts with "..." already declared for this scope; one composition selects
// one presentation` on a second call, so this row must stay the ONLY
// tool-presentation row in this preset.
//
// WHY NOT ALSO DISABLE workflow-ptc / tool-workflow (as the factory ptc preset
// does): the factory `ptc` preset disables them because its `provider: spawn`
// PTC engine and the workflow engine cannot coexist under EVERY runtime — the
// documented hard case is a Python PTC provider, where dsh-workflow-ptc
// README.zh.md:28 requires disabling workflow-ptc, tool-workflow and any
// enabled tool-ralph. This deployment's runtime is TypeScript. Measured on this
// install: `workflow`'s output schema IS lossless JSON (both a
// `snapshotJsonValue` round-trip and the real `renderToolsSdk` projection
// succeed), so the `sdkSchemas()` "output schema must be lossless JSON before
// SDK projection" guard that could have forced the disable does not fire. The
// two engines are independent; keeping `workflow` enabled is the point of a
// full-featured fast preset. If a future change swaps in a Python PTC provider,
// these three rows MUST be disabled together.
//
// Placement mirrors the factory ptc preset: after the `tool-web` group and
// before `present`. `tool-cordis` (step 3b) already sits right after
// `tool-web`, so anchoring on `present` puts this row in the same relative
// position the factory preset uses. Do NOT hang it off `tool-web`.end — that
// index is stale the moment step 3b splices `tool-cordis` in.
{
  const span = spanOf('present')
  if (!span) throw new Error('top-level plugin row `present` not found')
  if (spanOf('tool-presentation')) throw new Error('`tool-presentation` already present')
  block.splice(
    span.start,
    0,
    '      - id: tool-presentation',
    "        name: '@deepseek-ai/dsh-agent-tool-presentation'",
    '        config:',
    '          mode: both',
  )
}

// --- 4. insert the gate as a top-level preset plugin ------------------------
// It goes INSIDE `plugins`, not at profile top level. A profile-level row would
// also catch agents on the `standard` preset, which already exposes both `bash`
// (persistent-bash, enabled on win32 by the override above) and `pwsh` (the
// one-shot tool-pwsh row, still win32-enabled) — the gate self-tests on exactly
// that pair, so it would silently re-shape a preset the user did not ask to
// change.
//
// Delivery works because presets are mounted as the agent scope's PARENT:
// `AgentPresetRegistry.mount`/`join` call `bindScopeParent(agentKey,
// generation.key)` (apr.js:678), and `agent/created` / `tools/post-execute` are
// dispatched scope-targeted at the agent (tools.js:3505). A listener registered
// in the preset's standing scope is therefore an ancestor of every agent that
// joined it — and of no other agent.
//
// Top-level preset plugin rows sit at indent 6 in this coordinate system
// (source `      - id: persona`), i.e. 10 after the +4 re-indent below.
const anchor = block.findIndex((line) => line === '      - id: persistent-shell')
if (anchor < 0) throw new Error('top-level plugin row `persistent-shell` not found')
let anchorEnd = block.length
for (let i = anchor + 1; i < block.length; i += 1) {
  if (/^ {6}- id: /.test(block[i])) { anchorEnd = i; break }
}

const gateRow = [
  '      - id: shell-fallback',
  '        name: ./shell-fallback.mjs?v=2',
  '        config:',
  '          enabled: true',
  '          threshold: 2',
  '          primaryTools: [bash]',
  '          fallbackTools: [pwsh]',
]
block.splice(anchorEnd, 0, ...gateRow)

// --- 5. re-indent under `- insert:` ----------------------------------------
const member = block.map((line) => (line === '' ? line : ' '.repeat(INDENT) + line))

const banner = `# ---------------------------------------------------------------------------
# PRESET: bash-first — bash is the ONLY shell callable until it fails.
#
# GENERATED — regenerate with:
#   node <repo>/tools/gen-bash-first-preset.mjs \\
#     C:\\Users\\rain\\.dsh\\profiles\\desktop\\cordis.patch.yml <out>
# It is derived from the 'preset-standard' override above, so change anything
# shared by both presets THERE and regenerate.
#
# FOUR PARTS, all required:
#   1. terminal-bash/persistent-bash register the persistent tool 'bash'
#      (Git Bash via shellPath — bare \`bash\` on PATH is WSL).
#   2. terminal-pwsh/persistent-pwsh register 'pwsh', re-typed to
#      backendType 'shell-pwsh' so the two PTY backends can coexist
#      (dsh-terminal refuses a repeated backend type with DUPLICATE_BACKEND).
#   3. the 'shell-fallback' plugin HIDES 'pwsh' per agent via
#      agent.ctx.tools.restrict({ deny: ['pwsh'] }) and disposes that
#      restriction only after 2 CONSECUTIVE failed 'bash' calls. A prompt alone
#      cannot do this — the model still sees the pwsh schema and reaches for it
#      on the first Windows-flavoured command.
#   4. 'tool-presentation' with mode 'both' adds PTC (programmatic tool
#      calling): the model may also call \`run_code\` and drive tools from inside
#      a program, overlapping safe calls and keeping intermediate results out
#      of the conversation. 'both' (not 'ptc') on purpose — pure 'ptc' hides
#      the 'bash' schema, which would contradict part 3's whole narrative.
#      Requires a composed ctx.ptcRuntime (the 'include:ptc-runtime' row) and a
#      registered SDK renderer; the preset is rejected at mount without them.
#
# The gate is a plugin row INSIDE this preset, so scope parenting confines it to
# bash-first agents only; it cannot leak into the 'standard' preset, which also
# happens to expose both a bash and a pwsh tool.
#
# NOTE: 'tool-bash' (one-shot) stays win32-disabled and no one-shot 'tool-pwsh'
# row exists here, so the only shells reachable in this preset are the two
# persistent ones.
#
# REVERT: delete this generated block (this banner to EOF) plus
# shell-fallback.mjs, then start a NEW session.
# ---------------------------------------------------------------------------
`

writeFileSync(outPath, `- insert:\n${member.join('\n')}\n\n${banner}`, 'utf8')
console.log(`wrote ${outPath}`)
console.log(`  preset-bash-first: ${member.length} lines (insert member), order ${ORDER}`)
console.log(`  gate row: ${gateRow.length} lines inside plugins, threshold 2`)

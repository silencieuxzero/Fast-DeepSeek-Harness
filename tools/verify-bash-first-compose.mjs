// Offline composition check for the generated `bash-first` preset block.
//
// Reproduces boot's include: the shipped preset declaration layer + the profile
// patch + the generated block, flattened, then run through the include's OWN
// applyEntryPatches over an empty root. Answers:
//   1. does `preset-bash-first` actually land as a row (not silently dropped)?
//   2. is config.id `bash-first`, order 5, and is the plugin list complete?
//   3. are terminal-pwsh/persistent-pwsh enabled on win32 with backendType
//      `shell-pwsh` (the DUPLICATE_BACKEND guard)?
//   4. is the `shell-fallback` gate a member of the preset's OWN plugin list
//      (NOT a top-level row — top level would also catch preset-standard)?
//   5. did the existing preset-standard override survive untouched?
//
// Usage: node verify-bash-first-compose.mjs <generated.yml>

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire('C:/Users/rain/.dsh/profiles/node_modules/dsh-desktop-next/')
const yaml = require('yaml')
const { applyEntryPatches } = require('@deepseek-ai/cordis-plugin-include')

const WEBAPP =
  'C:/Users/rain/.dsh/profiles/node_modules/dsh-desktop-next/node_modules/@deepseek-ai/dsh-web-app'
const PROFILE_PATCH = 'C:/Users/rain/.dsh/profiles/desktop/cordis.patch.yml'
const generated = process.argv[2]
if (!generated) {
  console.error('usage: node verify-bash-first-compose.mjs <generated.yml>')
  process.exit(2)
}

// `!!js` expressions must be stripped before parsing; they are re-evaluated by
// the real loader, which this offline check does not model.
const load = (p) => yaml.parse(readFileSync(p, 'utf8').replace(/!!js /g, ''))

const layers = [
  load(join(WEBAPP, 'presets/standard.patch.yml')),
  load(PROFILE_PATCH),
  load(generated),
]

const warnings = []
const composed = applyEntryPatches([], layers.flat(), (msg, ...args) => {
  let i = 0
  warnings.push(msg.replace(/%C/g, () => JSON.stringify(args[i++])))
})

const fail = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`)
  if (!ok) fail.push(label)
}

console.log('--- applyEntryPatches warnings ---')
console.log(warnings.length ? warnings.map((w) => '  ' + w).join('\n') : '  (none)')
console.log()

// --- row ids present -------------------------------------------------------
const ids = composed.map((row) => row.id)
console.log('--- rows (' + ids.length + ') ---')
console.log('  ' + ids.join(', '))
console.log()

check(
  !ids.includes('shell-fallback'),
  'shell-fallback is NOT a top-level row (it must stay preset-scoped)',
  ids.filter((id) => id === 'shell-fallback').length ? 'found at top level!' : 'absent as expected',
)
check(ids.includes('preset-bash-first'), 'preset-bash-first row inserted')
check(ids.includes('preset-standard'), 'preset-standard row still present')

// --- the new preset --------------------------------------------------------
const std = composed.find((row) => row.id === 'preset-standard')
const preset = composed.find((row) => row.id === 'preset-bash-first')
if (preset) {
  check(
    preset.name === '@deepseek-ai/dsh-agent-preset',
    'preset-bash-first.name is the agent-preset plugin',
    preset.name,
  )
  const cfg = preset.config ?? {}
  check(cfg.id === 'bash-first', 'config.id === bash-first', String(cfg.id))
  check(cfg.order === 5, 'config.order === 5', String(cfg.order))

  const plugins = cfg.plugins ?? []
  const pluginIds = plugins.map((p) => p.id)
  console.log('\n--- preset-bash-first plugins (' + pluginIds.length + ') ---')
  console.log('  ' + pluginIds.join(', '))

  // The plugin list must match preset-standard's, member for member.
  const stdIds = (std?.config?.plugins ?? []).map((p) => p.id)
  const missing = stdIds.filter((id) => !pluginIds.includes(id))
  check(missing.length === 0, 'every preset-standard member is carried over', `missing: ${missing.join(', ') || 'none'}`)

  const shell = plugins.find((p) => p.id === 'persistent-shell')
  check(shell !== undefined, 'persistent-shell group present')
  if (shell) {
    check(shell.group === true, 'persistent-shell.group === true')
    console.log('  isolate:', JSON.stringify(shell.isolate))
    const members = (shell.config ?? []).map((m) => m.id)
    console.log('  members:', members.join(', '))
    check(
      ['pty', 'terminal-bash', 'persistent-bash', 'terminal-pwsh', 'persistent-pwsh'].every((m) =>
        members.includes(m),
      ),
      'all five shell members present',
    )

    console.log('\n--- the pwsh fallback pair ---')
    for (const id of ['terminal-pwsh', 'persistent-pwsh']) {
      const member = (shell.config ?? []).find((m) => m.id === id)
      if (!member) { check(false, `${id} present`); continue }
      console.log(`  ${id}: disabled=${JSON.stringify(member.disabled)} backendType=${JSON.stringify(member.config?.backendType)}`)
      // The generated file sets `disabled: !!js process.platform !== 'win32'`,
      // stripped to the string `process.platform !== 'win32'` by load().
      check(
        member.disabled === "process.platform !== 'win32'",
        `${id} is DISABLED off-win32 only (i.e. enabled on Windows)`,
        String(member.disabled),
      )
      check(
        member.config?.backendType === 'shell-pwsh',
        `${id}.backendType === shell-pwsh`,
        String(member.config?.backendType),
      )
    }

    const bashMember = (shell.config ?? []).find((m) => m.id === 'terminal-bash')
    console.log(`  terminal-bash: backendType=${JSON.stringify(bashMember?.config?.backendType)} shellPath=${JSON.stringify(bashMember?.config?.shellPath)}`)
    check(
      bashMember?.config?.backendType === undefined,
      'terminal-bash keeps the DEFAULT backendType (must differ from shell-pwsh)',
    )
  }
}

// --- the gate row (inside the preset's own plugins) ------------------------
const gate = (preset?.config?.plugins ?? []).find((p) => p.id === 'shell-fallback')
check(gate !== undefined, 'shell-fallback gate is a member of preset-bash-first.plugins')
if (gate) {
  // A trailing `?v=N` is load-bearing: the host caches plugin modules by URL, so an
  // edited .mjs is invisible until the URL changes (or the host restarts).
  check(
    /^\.\/shell-fallback\.mjs(\?v=\d+)?$/.test(String(gate.name)),
    'gate.name is the profile-relative .mjs (with optional cache-busting ?v=N)',
    gate.name,
  )
  const cfg = gate.config ?? {}
  check(cfg.enabled !== false, 'gate.enabled is not false')
  check(cfg.threshold === 2, 'gate.threshold === 2', String(cfg.threshold))
  check(
    JSON.stringify(cfg.primaryTools) === '["bash"]',
    'gate.primaryTools === [bash]',
    JSON.stringify(cfg.primaryTools),
  )
  check(
    JSON.stringify(cfg.fallbackTools) === '["pwsh"]',
    'gate.fallbackTools === [pwsh]',
    JSON.stringify(cfg.fallbackTools),
  )
  // A gate must never appear in the preset-standard plugin list.
  const stdGate = (std?.config?.plugins ?? []).find((p) => p.id === 'shell-fallback')
  check(stdGate === undefined, 'shell-fallback gate is ABSENT from preset-standard')
}

// --- the three creation-mode ('cordis' preset) capabilities ----------------
// The user asked for bash-first to equal `standard` PLUS everything the
// 「创造模式」 (`cordis`) preset can do. Diffing the two shipped definitions
// gives exactly three deltas; each is asserted here against the composed rows.
console.log()
console.log('--- creation-mode capabilities folded in from the cordis preset ---')
{
  const plugins = preset?.config?.plugins ?? []
  const byId = (id) => plugins.find((p) => p.id === id)

  // (a) the runtime inspection tools: cordis_inspect_list / cordis_inspect_query.
  const cordis = byId('tool-cordis')
  check(cordis !== undefined, 'tool-cordis row is present')
  check(
    cordis?.name === '@deepseek-ai/dsh-tool-cordis',
    'tool-cordis names the inspect-tool package',
    cordis?.name,
  )
  // Placement mirrors the cordis preset: straight after `tool-web`.
  const orderIds = plugins.map((p) => p.id)
  check(
    orderIds.indexOf('tool-cordis') === orderIds.indexOf('tool-web') + 1,
    'tool-cordis sits immediately after tool-web (as in the cordis preset)',
  )

  // (b) the bundled Cordis authoring skills. The factory cordis preset resolves
  // them with createRequire(baseUrl), but THIS patch is evaluated with
  // baseUrl = the profile directory, where that call throws MODULE_NOT_FOUND —
  // so the expression must resolve from the junction that holds the packages.
  const skills = byId('skill-filesystem')
  const dirs = skills?.config?.customSkillDirs
  check(Array.isArray(dirs) && dirs.length === 1, 'skill-filesystem has exactly one customSkillDirs entry')
  const expr = String(dirs?.[0] ?? '')
  check(
    !/createRequire\(baseUrl\)/.test(expr),
    'customSkillDirs does NOT use createRequire(baseUrl) (would throw MODULE_NOT_FOUND here)',
  )
  check(
    /dsh-desktop-next\/package\.json/.test(expr),
    'customSkillDirs resolves through the dsh-desktop-next junction',
  )
  check(
    /dsh-agent-preset\/package\.json/.test(expr) && /'skills'/.test(expr),
    "customSkillDirs points at dsh-agent-preset's skills dir",
  )

  // (c) the plugin manager, un-gated the same way the cordis preset does.
  const pm = byId('tool-plugin-manager')
  check(pm !== undefined, 'tool-plugin-manager row is present')
  check(
    pm?.disabled !== true,
    'tool-plugin-manager is no longer unconditionally disabled',
    JSON.stringify(pm?.disabled),
  )
}

// --- the PTC ('programmatic tool calling') presentation row -----------------
// `tool-presentation` with `mode: both` is the one row that carries the factory
// `ptc` preset's capability. Three things must hold, and each has bitten before:
//   * the row exists and is the ONLY one (a second `presentAs` call for the same
//     scope throws `tools.presentAs("...") conflicts with "..." already
//     declared for this scope; one composition selects one presentation`);
//   * mode is exactly `both`, not `ptc` — pure `ptc` hides the `bash` schema, so
//     this preset's whole bash-first narrative (and shell-fallback's 10155
//     prompt section) would describe a tool the wire never advertises;
//   * it sits immediately BEFORE `present`, mirroring the factory ptc preset,
//     which places it after the `tool-web`/`tool-cordis` pair.
console.log()
console.log('--- PTC presentation (mode both) folded in from the ptc preset ---')
{
  const plugins = preset?.config?.plugins ?? []
  const rows = plugins.filter((p) => p.id === 'tool-presentation')

  check(rows.length === 1, 'exactly one tool-presentation row (presentAs rejects a second declaration)')
  check(
    rows[0]?.name === '@deepseek-ai/dsh-agent-tool-presentation',
    'tool-presentation names the presentation package',
    rows[0]?.name,
  )
  check(
    rows[0]?.config?.mode === 'both',
    "tool-presentation mode is 'both' (pure 'ptc' would hide the bash schema)",
    JSON.stringify(rows[0]?.config?.mode),
  )
  const orderIds = plugins.map((p) => p.id)
  check(
    orderIds.indexOf('tool-presentation') === orderIds.indexOf('present') - 1,
    'tool-presentation sits immediately before present (as in the ptc preset)',
  )
  // The factory ptc preset disables these; this preset must NOT, since the
  // deployment runtime is TypeScript and `workflow`'s output schema is lossless
  // JSON (measured). Asserting it keeps a future drive-by edit from "fixing" it.
  // NOTE: these rows are NESTED inside the subagent `cordis:group` member. A
  // group's children are its `config` ARRAY (`group: true` + `config: [ ... ]`),
  // not a `config.plugins` list — a top-level `plugins.find` would miss them and
  // report a false failure.
  const nested = []
  const walk = (list) => {
    for (const entry of list ?? []) {
      if (entry === null || typeof entry !== 'object') continue
      const children = Array.isArray(entry.config)
        ? entry.config
        : (entry.config?.plugins ?? [])
      for (const child of children) nested.push(child)
      walk(children)
    }
  }
  walk(plugins)
  const findAny = (id) => plugins.find((p) => p.id === id) ?? nested.find((p) => p.id === id)
  for (const id of ['workflow-ptc', 'tool-workflow']) {
    const row = findAny(id)
    check(row !== undefined, `${id} row is present`)
    check(row?.disabled !== true, `${id} stays enabled alongside PTC`)
  }
}

console.log()
if (fail.length) {
  console.log(`RESULT: ${fail.length} check(s) FAILED`)
  for (const label of fail) console.log('  - ' + label)
  process.exit(1)
}
console.log('RESULT: all checks passed')

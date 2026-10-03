// Unit-test shell-fallback.mjs against a fake Cordis context.
//
// The plugin is pure logic over three things: the agent's visible tool list,
// `tools.restrict()`'s disposer, and the result object of `tools/post-execute`.
// All three are cheap to fake, so the gate can be exercised without booting DSH
// or spending a session. What this DOES verify: the trust decision, the failure
// classification (including the non-zero-exit-as-success quirk), the consecutive
// counter, one-way release, and the self-gating on tool visibility.
// What it does NOT verify: that the real `restrict()` accepts 'pwsh' for a
// preset-mounted agent, and that the real bash tool renders the exit marker
// exactly as assumed — those need a live session.
//
// Usage: node test-shell-fallback.mjs

import { apply } from 'file:///C:/Users/rain/.dsh/profiles/desktop/shell-fallback.mjs'

const fail = []
let passed = 0
const check = (ok, label, detail) => {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { fail.push(label); console.log(`FAIL  ${label}${detail === undefined ? '' : `  ${detail}`}`) }
}

/** Build a fake host + one agent, returning the handles the test drives. */
function harness(visibleTools, extraConfig) {
  const listeners = { 'agent/created': [], 'tools/post-execute': [], 'agent/disposed': [] }
  const logs = []
  const host = {
    get: (name) => (name === 'tools' ? {} : undefined),
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    on: (event, handler) => { listeners[event].push(handler) },
  }

  const restrictions = []
  const sections = []
  const agentCtx = {
    tools: {
      schemas: () => visibleTools.map((name) => ({ name })),
      restrict: (filter) => {
        restrictions.push(filter)
        return () => { restrictions.push({ undone: true, filter }) }
      },
    },
    systemPrompt: {
      section: (section) => { sections.push(section) },
    },
  }

  apply(host, { enabled: true, threshold: 2, ...(extraConfig ?? {}) })

  const agent = { id: 'agent-1', ctx: agentCtx }
  for (const handler of listeners['agent/created']) handler({ agent })

  /** Drive one finished tool call through the post-execute waterfall. */
  const run = async (name, result) => {
    for (const handler of listeners['tools/post-execute']) {
      await handler({ name, agent }, result, async () => ({ kind: 'accept' }))
    }
  }

  const dispose = () => { for (const h of listeners['agent/disposed']) h({ agent }) }

  return { restrictions, sections, logs, run, dispose, agent }
}

const text = (value) => [{ type: 'text', text: value }]

// --- 1. the happy path: pwsh is withheld --------------------------------
{
  const h = harness(['bash', 'pwsh', 'read'])
  check(h.restrictions.length === 1, 'restrict() called exactly once')
  check(
    JSON.stringify(h.restrictions[0]) === '{"deny":["pwsh"]}',
    'restrict() denies exactly [pwsh]',
    JSON.stringify(h.restrictions[0]),
  )
  check(
    h.sections.some((s) => s.name === 'shell-fallback/primary'),
    'the "bash only" prompt section is mounted',
  )
  check(
    h.sections.every((s) => s.interpolate === false),
    'every section is interpolate:false (cache-stable)',
  )
}

// --- 2. self-gating: a preset without both halves is untouched -----------
for (const [label, tools] of [
  ['no bash visible', ['pwsh', 'read']],
  ['no pwsh visible', ['bash', 'read']],
  ['neither visible', ['read', 'write']],
]) {
  const h = harness(tools)
  check(h.restrictions.length === 0, `no restrict() when ${label}`)
  check(h.sections.length === 0, `no prompt section when ${label}`)
}

// --- 3. threshold: one failure is not enough ----------------------------
{
  const h = harness(['bash', 'pwsh'])
  await h.run('bash', { isError: true, content: text('boom') })
  check(h.restrictions.length === 1, 'still restricted after 1 failure (threshold 2)')
  check(
    !h.sections.some((s) => s.name === 'shell-fallback/unlocked'),
    'no unlock section after 1 failure',
  )
}

// --- 4. threshold: the second consecutive failure unlocks ---------------
{
  const h = harness(['bash', 'pwsh'])
  await h.run('bash', { isError: true, content: text('boom') })
  await h.run('bash', { isError: true, content: text('boom again') })
  check(
    h.restrictions.some((r) => r.undone === true),
    'the restriction disposer ran on the 2nd failure',
  )
  check(
    h.sections.some((s) => s.name === 'shell-fallback/unlocked'),
    'the unlock prompt section is mounted',
  )
}

// --- 5. a success resets the streak -------------------------------------
{
  const h = harness(['bash', 'pwsh'])
  await h.run('bash', { isError: true, content: text('boom') })
  await h.run('bash', { isError: false, content: text('ok'), exit: 0 })
  await h.run('bash', { isError: true, content: text('boom') })
  check(
    !h.restrictions.some((r) => r.undone === true),
    'flaky failures (broken by a success) never unlock',
  )
}

// --- 6. shell-breakage markers only: a non-zero command exit is NOT one --
// The gate must distinguish "the shell broke" from "the command reported
// failure". `grep` exiting 1 with no match is the command working correctly;
// counting it would unlock PowerShell after two routine commands.
for (const [label, output, shouldFail] of [
  ['non-zero command exit in a success result', 'oops\n[Command finished with exit code 1]', false],
  ['exit 0 marker', 'fine\n[Command finished with exit code 0]', false],
  ['grep no-match exit 1', 'no matches\n[Command finished with exit code 1]', false],
  ['git diff --quiet exit 1', '[Command finished with exit code 1]', false],
  ['timeout marker', 'partial\n[Command timed out or OOM]', true],
  ['shell exited marker', 'gone\n[shell exited: code 1]', true],
  ['bare shell exit marker', 'exit\n[shell exited]', true],
  ['killed by signal', 'gone\n[shell killed by signal: SIGKILL]', true],
  ['shell reset marker', 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.', true],
  ['shell init failure', 'persistent bash shell did not accept initialization', true],
  ['plain output', 'all good', false],
  ['empty output', '', false],
  ['isError with no marker', 'boom', true],
]) {
  const h = harness(['bash', 'pwsh'])
  // isError stays FALSE for the marker cases: the persistent bash tool reports
  // these inside the rendered text, not as an error.
  const isError = label === 'isError with no marker'
  await h.run('bash', { isError, content: text(output) })
  await h.run('bash', { isError, content: text(output) })
  const unlocked = h.restrictions.some((r) => r.undone === true)
  check(unlocked === shouldFail, `${label} -> ${shouldFail ? 'counts' : 'does not count'}`, `output=${JSON.stringify(output)}`)
}

// --- 6b. countCommandFailures opts into the looser semantics ------------
{
  const h = harness(['bash', 'pwsh'], { countCommandFailures: true })
  await h.run('bash', { isError: false, content: text('[Command finished with exit code 1]') })
  await h.run('bash', { isError: false, content: text('[Command finished with exit code 1]') })
  check(
    h.restrictions.some((r) => r.undone === true),
    'countCommandFailures:true counts a non-zero command exit',
  )
}
{
  const h = harness(['bash', 'pwsh'], { countCommandFailures: true })
  await h.run('bash', { isError: false, content: text('[Command finished with exit code 0]') })
  await h.run('bash', { isError: false, content: text('[Command finished with exit code 0]') })
  check(
    !h.restrictions.some((r) => r.undone === true),
    'countCommandFailures:true still ignores a zero exit',
  )
}

// --- 7. unrelated tools and other agents are ignored --------------------
{
  const h = harness(['bash', 'pwsh'])
  await h.run('read', { isError: true, content: text('no such file') })
  await h.run('grep', { isError: true, content: text('no match') })
  check(
    !h.restrictions.some((r) => r.undone === true),
    'failures of non-primary tools never unlock the fallback',
  )
}

// --- 8. release is one-way: a later success does not re-hide ------------
{
  const h = harness(['bash', 'pwsh'])
  await h.run('bash', { isError: true, content: text('boom') })
  await h.run('bash', { isError: true, content: text('boom') })
  const before = h.restrictions.length
  await h.run('bash', { isError: false, content: text('recovered') })
  check(
    h.restrictions.length === before,
    'no re-restriction after a successful bash call (one-way release)',
  )
}

// --- 9. a throwing restrict() degrades instead of breaking --------------
{
  const listeners = { 'agent/created': [], 'tools/post-execute': [] }
  const logs = []
  const host = {
    get: (n) => (n === 'tools' ? {} : undefined),
    logger: { info: () => {}, warn: (m) => logs.push(m) },
    on: (e, h) => (listeners[e] ??= []).push(h),
  }
  const agentCtx = {
    tools: {
      schemas: () => [{ name: 'bash' }, { name: 'pwsh' }],
      restrict: () => { throw new Error('names unknown global tool pwsh') },
    },
    systemPrompt: { section: () => {} },
  }
  apply(host, { enabled: true, threshold: 2 })
  const agent = { id: 'a2', ctx: agentCtx }
  for (const h of listeners['agent/created']) h({ agent })
  check(
    logs.some((m) => /could not withhold pwsh/.test(m)),
    'a failing restrict() is logged as a warning, not thrown',
  )
  // And the surface stays usable: counting still works, release is a no-op.
  let threw = false
  try {
    for (const h of listeners['tools/post-execute'])
      await h({ name: 'bash', agent }, { isError: true, content: text('x') }, async () => ({ kind: 'accept' }))
  } catch { threw = true }
  check(!threw, 'post-execute never throws when the restriction could not be applied')
  void agentCtx
}

// --- 10. disabled config is inert ---------------------------------------
{
  const listeners = { 'agent/created': [] }
  const host = { get: () => ({}), logger: {}, on: (e, h) => (listeners[e] ??= []).push(h) }
  apply(host, { enabled: false })
  check(listeners['agent/created'].length === 0, 'enabled:false registers no listener')
}

// --- 11. a missing tool runtime warns instead of throwing ---------------
{
  let warned = false
  const host = {
    get: () => undefined,
    logger: { warn: () => { warned = true } },
    on: () => {},
  }
  let threw = false
  try { apply(host, {}) } catch { threw = true }
  check(!threw && warned, 'a missing tool runtime warns and returns')
}

console.log()
if (fail.length) {
  console.log(`RESULT: ${passed} passed, ${fail.length} FAILED`)
  for (const label of fail) console.log('  - ' + label)
  process.exit(1)
}
console.log(`RESULT: all ${passed} checks passed`)

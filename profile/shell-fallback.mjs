// shell-fallback — keep `bash` as the only shell the model may call until it
// demonstrably fails, then unlock PowerShell as a fallback.
//
// WHY THIS EXISTS
// The user asked for a preset in which only bash is callable, with PowerShell
// held back "after bash has failed a few times". A prompt instruction alone
// cannot deliver that: the model still SEES the pwsh schema and will reach for
// it on the first Windows-flavoured command. So the gate is real, not advisory:
// `agent.ctx.tools.restrict({ deny: ['pwsh'] })` removes the tool from the
// agent's view, and the restriction is disposed only after N consecutive
// failing bash calls.
//
// HOW IT HOOKS IN (all mechanisms verified against the shipped sources)
//   - `ctx.on('agent/created', ...)` gives us the agent's own scoped ctx. The
//     tools the preset mounted live in a PARENT layer of that scope, so they are
//     in `restrictableNames` and therefore actually restrictable (dsh-tools
//     `view()` only puts inherited names there; a tool registered on the agent's
//     own layer would make the whole `restrict()` call throw).
//   - `restrict()` returns a disposer and the restriction is a layer effect
//     owned by agentCtx, so it is also torn down automatically with the agent.
//   - `tools/post-execute` is a waterfall that sees every executed call, success
//     or failure. Counting there — not in a `guard` — is required because
//     `ToolGuard` is synchronous and cannot "count then allow".
//
// WHY FAILURE DETECTION IS NOT JUST `result.isError`
// The persistent bash tool does NOT throw on a non-zero exit: pbash.js
// renderCaptured() appends `[Command finished with exit code N]` to a SUCCESS
// result. So a failing command looks like a success unless the rendered text is
// inspected.
//
// But an ordinary non-zero exit is NOT a shell failure, and by default must not
// count: `grep` with no match, `git diff --quiet`, `test -f` — these exit
// non-zero as their normal, correct answer. Counting them would unlock
// PowerShell within two routine commands and destroy the bash-only property this
// preset exists for. What counts by default is the SHELL breaking, not the
// COMMAND reporting a failure:
//   - the tool result is an error (`isError`);
//   - `[Command timed out or OOM]`;
//   - `[shell exited: code N]` / `[shell exited]` / `[shell killed by signal: X]`
//     — the persistent shell itself died, so the next call starts from scratch;
//   - the shell-reset message, which means state was lost.
// Note `exit 3` in a persistent shell produces `[shell exited: code 3]`, i.e. it
// IS a shell failure: `exit` ends the shell, it does not merely fail a command.
//
// Set `countCommandFailures: true` to also count a plain non-zero command exit.
// That is closer to "bash isn't working for me" in spirit and unlocks sooner,
// but it fires on the routine cases above — the choice is the operator's, so it
// is a config flag rather than a silent decision.
//
// SCOPE / CAVEATS
//   - Self-gating: it only acts on an agent that has BOTH a primary tool
//     (`bash`) and a fallback tool (`pwsh`) visible. A preset with no bash, or
//     no pwsh, is left completely untouched.
//   - It never throws out of a listener. If the restriction cannot be applied
//     (unknown tool name, unexpected scope), it logs and leaves the surface as
//     it was — degraded, never broken.
//   - Release is one-way for the rest of the session: once unlocked, pwsh stays
//     unlocked. Re-hiding it after a lucky bash call would make the tool surface
//     flap, and every flap invalidates the request prefix cache.
//   - Revert: delete the `shell-fallback` insert row from cordis.patch.yml (and
//     this file). It adds no other state.

export const name = 'shell-fallback'

// `ctx.get('tools')` is probed, but the tool runtime is the whole point of the
// plugin: without it there is nothing to restrict, so it is a hard dependency.
export const inject = ['tools']

const DEFAULT_THRESHOLD = 2
const DEFAULT_PRIMARY = ['bash']
const DEFAULT_FALLBACK = ['pwsh']

/** Shown to every agent this plugin guards: bash first, always. */
const PRIMARY_TEXT = `## Shell

Commands run through a single persistent shell whose state (working directory, exported variables) survives between calls.

- Use it for every command. Reach for another shell only if this one is explicitly unlocked below.
- Chain related commands in ONE call: a step's cost is charged per step, not per command. Separate read-only probes with \`;\` and stop on a real failure.
- A non-zero exit is reported as \`[Command finished with exit code N]\` and does NOT stop the shell; read it before assuming a command worked.`

/** Shown once the fallback is unlocked. */
const unlockText = (threshold, tools) => `## PowerShell fallback unlocked

The persistent bash shell failed ${threshold} times in a row, so PowerShell (\`${tools.join('`, `')}\`) has been made available for the rest of this session.

- Prefer bash when it works; use PowerShell for what bash cannot do well on Windows (native paths, services, registry, \`Get-*\` cmdlets).
- It is a separate persistent shell: its state does not carry over from bash, so re-establish the working directory if the command depends on it.
- Keep it to one call that does the whole job rather than many small ones.`

const TIMEOUT_RE = /\[Command timed out or OOM\]/
const SHELL_EXIT_RE = /\[shell (?:exited|killed by signal)/
const STATE_LOST_RE = /persistent bash shell (?:was reset|did not accept initialization)/
const EXIT_CODE_RE = /\[Command finished with exit code (\d+)\]/

/** Flatten a tool result's content blocks into searchable text. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        return ''
      })
      .join('\n')
  }
  return ''
}

/**
 * Whether a finished primary call means the SHELL broke.
 *
 * `result` is the SECOND parameter of the waterfall, i.e. the normalized
 * `ToolExecutionResult` — NOT what `next()` returns. `next()` yields a
 * `PostToolDecision` ({kind:'accept'|'block'}, plus optional content/value/
 * additionalContexts), which carries no error flag at all; dsh-tools only folds
 * it into a result afterwards (tools.js:3504-3533). The shipped
 * repeat-tool-reminder ignores this argument as `_result`, which is why the
 * distinction is easy to miss.
 *
 * Deliberately NOT counted by default: a plain `[Command finished with exit code
 * N]` for N !== 0. That is the command failing, which is a normal and
 * informative outcome; the shell is still healthy. Pass `countCommandFailures`
 * to opt into counting those as well.
 */
function looksFailed(result, countCommandFailures) {
  if (result?.isError === true) return true
  const text = textOf(result?.content)
  if (text === '') return false
  if (TIMEOUT_RE.test(text)) return true
  if (SHELL_EXIT_RE.test(text)) return true
  if (STATE_LOST_RE.test(text)) return true
  if (countCommandFailures) {
    const exit = EXIT_CODE_RE.exec(text)
    if (exit !== null && exit[1] !== '0') return true
  }
  return false
}

function nameSet(value, fallback) {
  const list = Array.isArray(value) && value.length > 0 ? value : fallback
  return new Set(list.filter((entry) => typeof entry === 'string' && entry !== ''))
}

/** Register a static (cache-stable) prompt section on one agent. */
function addSection(agentCtx, sectionName, order, text, log) {
  const systemPrompt = agentCtx?.systemPrompt ?? agentCtx?.get?.('systemPrompt')
  if (systemPrompt === undefined) return false
  try {
    systemPrompt.section({ name: sectionName, order, text, interpolate: false })
    return true
  } catch (error) {
    log?.(`${sectionName} section skipped: ${error?.message ?? error}`)
    return false
  }
}

export function apply(ctx, config) {
  if (config?.enabled === false) return

  const threshold =
    Number.isInteger(config?.threshold) && config.threshold > 0 ? config.threshold : DEFAULT_THRESHOLD
  const primary = nameSet(config?.primaryTools, DEFAULT_PRIMARY)
  const fallback = [...nameSet(config?.fallbackTools, DEFAULT_FALLBACK)]
  const countCommandFailures = config?.countCommandFailures === true

  const runtime = ctx.get('tools')
  if (runtime === undefined) {
    ctx.logger?.warn?.('[shell-fallback] tool runtime unavailable; leaving the shell surface untouched')
    return
  }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[shell-fallback] ${message}`)
    } catch {}
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`[shell-fallback] ${message}`)
    } catch {}
  }

  /** agent.id -> { hidden, undo, failures, released, agentCtx } */
  const states = new Map()

  ctx.on('agent/created', ({ agent }) => {
    const agentCtx = agent?.ctx
    if (agentCtx?.tools === undefined) return

    let visible = []
    try {
      visible = agentCtx.tools.schemas(agent).map((tool) => tool.name)
    } catch (error) {
      warn(`could not read the tool surface for agent ${agent?.id}: ${error?.message ?? error}`)
      return
    }

    const hasPrimary = visible.some((toolName) => primary.has(toolName))
    const hidden = fallback.filter((toolName) => visible.includes(toolName))
    if (!hasPrimary || hidden.length === 0) {
      // A preset without both halves is not ours to police.
      return
    }

    let undo
    try {
      undo = agentCtx.tools.restrict({ deny: hidden })
    } catch (error) {
      warn(
        `could not withhold ${hidden.join(', ')} for agent ${agent?.id}`
          + ` (${error?.message ?? error}); the fallback stays visible`,
      )
      return
    }

    states.set(agent.id, { hidden, undo, failures: 0, released: false, agentCtx })
    addSection(agentCtx, 'shell-fallback/primary', 10155, PRIMARY_TEXT, info)
    info(
      `agent=${agent.id}: bash-only shell surface`
        + ` (withheld ${hidden.join(', ')}; unlock after ${threshold} consecutive failures)`,
    )
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    const agent = exec?.agent
    if (agent === undefined) return downstream
    const state = states.get(agent.id)
    if (state === undefined || state.released) return downstream
    if (!primary.has(exec.name)) return downstream

    if (looksFailed(result, countCommandFailures)) state.failures += 1
    else state.failures = 0

    if (state.failures < threshold) return downstream

    state.released = true
    try {
      state.undo?.()
    } catch (error) {
      warn(`could not release the fallback for agent ${agent.id}: ${error?.message ?? error}`)
    }
    addSection(state.agentCtx, 'shell-fallback/unlocked', 10156, unlockText(threshold, state.hidden), info)
    info(
      `agent=${agent.id}: ${threshold} consecutive ${[...primary].join('/')} failures`
        + ` -> unlocked ${state.hidden.join(', ')}`,
    )
    return downstream
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent?.id)
  })
}

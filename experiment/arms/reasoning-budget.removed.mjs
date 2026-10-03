// reasoning-budget — a system-prompt section that bounds private reasoning.
//
// WHY THIS EXISTS
// Measured on 13 real DSH sessions (1157 steps, 4.24M reasoning characters):
//   - reasoning is 75.4% of all model output characters; visible text is 1.0%
//   - thinking time is 75.1% of total step wall-clock (3152s of 4197s in one session)
//   - the cost is concentrated: the top 10% of steps carry 62.7% of all reasoning,
//     and the largest single step is 79,136 characters / 93.6s
//   - reasoning length correlates almost linearly with the count of
//     "reopen a settled question" markers (r = 0.882 between log length and marker
//     count), and expensive steps use those markers 1.79x more than cheap ones
//     ("option A / option B" 4.47x more)
// So the mechanism is not context size and not tool output size: it is an unbounded
// self-revision loop that keeps re-opening decisions it already made.
//
// WHY A PROMPT SECTION AND NOT SOMETHING ELSE
// Everything else was measured and rejected:
//   - reasoning_effort tier: a natural experiment found the `low` session produced
//     *more* per-step reasoning than the `high` sessions, with the same maximum
//     burst. The tier changes token throughput, not how much the model deliberates.
//   - maxTokens: capping at 4000 tokens removes 20% of reasoning but truncates 92
//     steps whose tool arguments run up to 69,881 characters — it destroys real work.
//   - shrinking context: correlation between accumulated history and per-step
//     reasoning is -0.034. Smaller context does not produce shorter thinking.
//   - stripping replayed reasoning from history: reasoning passback *appends*, so it
//     lives inside the cached prefix; rewriting it would drop cache reuse from the
//     changed token and cost far more than it saves.
// The assembled system prompt carried no reasoning-length guidance at all, so the
// one lever that is free, reversible, cache-stable after the first request, and
// covers 100% of steps (not just the ~50-60% a burst detector could reach) is text.
//
// COST: the section is re-sent on every step. Keep it terse. ~800 characters against
// a ~49,700-character prompt is 1.6%.
//
// CAVEAT: nothing in the recorded sessions proves the model obeys such a contract —
// static logs cannot show compliance. Treat the effect as unverified until an A/B on
// live sessions measures reasoning characters per step. Revert by deleting the
// `insert` row (and this file) from cordis.patch.yml.

export const name = 'reasoning-budget'

// `ctx.systemPrompt` is a hard Cordis dependency: accessing it without declaring it
// throws inside apply() and the loader parks the whole entry at fiberPhase "failed".
export const inject = ['systemPrompt']

/** Order 10150: after first-party guidance, immediately before the persona suffix (10200). */
export const DEFAULT_ORDER = 10150

export const DEFAULT_TEXT = `## Reasoning budget

Reasoning is private and is not the deliverable. Keep it short, and converge.

- A decision once made is not reopened. Do not re-derive a fact you already established, re-inspect a file you already read, or restate a plan you already stated. If you notice yourself writing "wait", "actually", "hold on", or "let me reconsider", finish the sentence and act on the decision already made.
- Do not enumerate alternatives you have already compared. Pick the option that is already best and move.
- When the next action is known, call the tool. Reasoning before a tool call should cover only what is genuinely still uncertain about that one call — a few sentences, not paragraphs.
- Keep each step's reasoning under roughly 300 words. If it is getting longer, you are re-opening settled questions: stop and act.`

export function apply(ctx, config) {
  const enabled = config?.enabled !== false
  if (!enabled) return

  const order = Number.isFinite(config?.order) ? config.order : DEFAULT_ORDER
  const text = typeof config?.text === 'string' && config.text.trim() !== '' ? config.text : DEFAULT_TEXT

  ctx.systemPrompt.section({
    name,
    order,
    text,
    interpolate: false,
  })

  try {
    ctx.logger?.info?.(`${name}: mounted reasoning-budget section at order ${order} (${text.length} chars)`)
  } catch {}
}

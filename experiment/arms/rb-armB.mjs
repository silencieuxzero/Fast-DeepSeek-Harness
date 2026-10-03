// rb-armB — experiment arm B (treatment): the same contract, roughly half the length and
// with a hard word cap instead of a soft one. Scoped into bash-first only.
export const name = 'reasoning-budget'
export const inject = ['systemPrompt']

const TEXT = `## Reasoning budget

Private reasoning is cost you cannot ship. Converge hard.

- Decide once. Never restate, re-derive, or re-verify anything already established in this session.
- Do not write alternatives you will not take. Name the chosen action and stop.
- Reasoning before a tool call: at most two sentences.
- Hard cap: 60 words per step. If you are over, you are already wrong — cut, and call the tool.`

export function apply(ctx, config) {
  ctx.systemPrompt.section({ name, order: 10150, text: TEXT, interpolate: false })
}

// rb-armA — experiment arm A (control): the exact text currently deployed globally.
// Scoped into the bash-first preset only; shadows the global section of the same name.
export const name = 'reasoning-budget'
export const inject = ['systemPrompt']

const TEXT = `## Reasoning budget

Reasoning is private and is not the deliverable. Keep it short, and converge.

- A decision once made is not reopened. Do not re-derive a fact you already established, re-inspect a file you already read, or restate a plan you already stated. If you notice yourself writing "wait", "actually", "hold on", or "let me reconsider", finish the sentence and act on the decision already made.
- Do not enumerate alternatives you have already compared. Pick the option that is already best and move.
- When the next action is known, call the tool. Reasoning before a tool call should cover only what is genuinely still uncertain about that one call — a few sentences, not paragraphs.
- Keep each step's reasoning under roughly 300 words. If it is getting longer, you are re-opening settled questions: stop and act.`

export function apply(ctx, config) {
  ctx.systemPrompt.section({ name, order: 10150, text: TEXT, interpolate: false })
}

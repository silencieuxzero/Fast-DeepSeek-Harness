// Replace the trailing `- insert:` block (the bash-first preset) in the live
// profile patch with freshly generated content.
//
// WHY NOT SEARCH FOR THE FIRST `- insert:`: the patch contains more than one.
// The bash-first block is the LAST one, so anchor on the generated member's own
// header row and walk back to the nearest preceding top-level `- insert:`.
// Anything before that line (the preset-standard override and every earlier
// bundle patch) is preserved byte for byte.

import { readFileSync, writeFileSync } from 'node:fs'

const [, , livePath, genPath] = process.argv
if (!livePath || !genPath) {
  console.error('usage: node splice-bash-first.mjs <live cordis.patch.yml> <generated.yml>')
  process.exit(2)
}

const live = readFileSync(livePath, 'utf8')
const lines = live.split('\n')

// The member sits at indent 4 under `- insert:` (`    - id: preset-bash-first`).
const MEMBER = '    - id: preset-bash-first'
const memberAt = lines.indexOf(MEMBER)
if (memberAt < 0) throw new Error(`\`${MEMBER}\` not found in the live patch`)

let insertAt = -1
for (let i = memberAt - 1; i >= 0; i -= 1) {
  if (lines[i] === '- insert:') { insertAt = i; break }
}
if (insertAt < 0) throw new Error('no `- insert:` above the bash-first member')
if (memberAt - insertAt !== 1) {
  throw new Error(`unexpected line between insert and member: ${JSON.stringify(lines[insertAt + 1])}`)
}

const head = lines.slice(0, insertAt)
const tail = readFileSync(genPath, 'utf8')
const out = `${head.join('\n')}${tail}`

writeFileSync(livePath, out, 'utf8')
console.log(`live: ${lines.length} lines -> head kept 1..${insertAt} (${head.length} lines)`)
console.log(`replaced from line ${insertAt + 1} to EOF`)
console.log(`wrote ${livePath}: ${out.length} bytes`)

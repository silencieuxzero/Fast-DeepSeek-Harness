// Replace the trailing `- insert:` block (the bash-first preset) in the live
// profile patch with freshly generated content.
//
// WHY NOT SEARCH FOR THE FIRST `- insert:`: the patch contains more than one.
// The bash-first block is the LAST one, so anchor on the generated member's own
// header row and walk back to the nearest preceding top-level `- insert:`.
// Anything before that line (the preset-standard override and every earlier
// bundle patch) is preserved byte for byte.
//
// TWO TRAPS THIS SCRIPT HAS ALREADY FALLEN INTO — both are load-bearing:
//
//   1. NEWLINE BETWEEN HEAD AND TAIL. `head` is `lines.slice(0, insertAt)`, so
//      its last element is the line ABOVE `- insert:` (the standard override's
//      final `disabled: true`). Joining it straight onto `- insert:` produced
//      `        disabled: true- insert:` — one corrupted line, no blank, and
//      the YAML no longer parsed. The join must add the separator back.
//
//   2. THE TOP-LEVEL `agent-preset-registry` ROW IS NOT OURS TO DELETE. It sits
//      at indent 0 AFTER the generated member's last plugin row and BEFORE the
//      banner (live patch :653-657):
//
//          - id: agent-preset-registry
//            name: "@deepseek-ai/dsh-agent-preset-registry"
//            config:
//              default: standard
//              selectedDefault: bash-first
//
//      It is a sibling top-level entry of `- insert:`, NOT part of the block
//      the generator emits, and it is what makes 快速模式 the default preset.
//      Replacing "from `- insert:` to EOF" silently deleted it (measured:
//      `653,657d652`). So the region between the end of the generated member and
//      the START OF THE BANNER is carried over verbatim and re-spliced between
//      the fresh member and the fresh banner. The banner itself IS regenerated
//      — it lives in the generator — so the old one is dropped, not carried.

import { readFileSync, writeFileSync } from 'node:fs'

const [, , livePath, genPath] = process.argv
if (!livePath || !genPath) {
  console.error('usage: node splice-bash-first.mjs <live cordis.patch.yml> <generated.yml>')
  process.exit(2)
}

// The banner's first line. It is emitted by the generator and is the marker that
// separates "content to carry over" from "content to regenerate".
const BANNER_START = '# ---------------------------------------------------------------------------'

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

// Everything at indent 0 after `- insert:` is a sibling top-level entry, not part
// of the member (which is indented 4). The first such line is the start of the
// carry-over region. A `^- ` can never match inside the member, and banner lines
// start with `#`, so this is unambiguous.
let carryAt = lines.length
for (let i = insertAt + 1; i < lines.length; i += 1) {
  if (/^- /.test(lines[i])) { carryAt = i; break }
}

// The carry-over stops where the (regenerated) banner begins.
let carryEnd = lines.length
for (let i = carryAt; i < lines.length; i += 1) {
  if (lines[i].startsWith(BANNER_START)) { carryEnd = i; break }
}
const carry = lines.slice(carryAt, carryEnd)

const head = lines.slice(0, insertAt)
const gen = readFileSync(genPath, 'utf8').split('\n')
const genBannerAt = gen.findIndex((line) => line.startsWith(BANNER_START))
if (genBannerAt < 0) throw new Error(`generated file has no banner starting with ${BANNER_START}`)

const out = [
  ...head,
  ...gen.slice(0, genBannerAt),
  ...carry,
  ...gen.slice(genBannerAt),
].join('\n')

writeFileSync(livePath, out, 'utf8')
console.log(`live: ${lines.length} lines -> head kept 1..${insertAt} (${head.length} lines)`)
console.log(`carried over ${carry.length} line(s) after the member: ${carry.filter((l) => /^- /.test(l)).map((l) => l.trim()).join(', ') || '(none)'}`)
console.log(`regenerated member + banner from line ${insertAt + 1}`)
console.log(`wrote ${livePath}: ${out.length} bytes`)

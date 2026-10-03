#!/usr/bin/env node
// set-arm.mjs — point the preset-scoped reasoning-budget row at one experiment arm.
//
// The row lives INSIDE preset-bash-first, so its section shadows the global
// 'reasoning-budget' section for 快速模式 sessions only. The global row is never
// touched, so standard/cordis keep the deployed text untouched.
//
//   node set-arm.mjs A     -> scoped row present, pointing at ./rb-armA.mjs
//   node set-arm.mjs B     -> scoped row present, pointing at ./rb-armB.mjs
//   node set-arm.mjs off   -> scoped row absent; the global text applies again
//   node set-arm.mjs check -> report current state, change nothing
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const DIR = 'C:/Users/rain/.dsh/profiles/desktop';
const PATCH = `${DIR}/cordis.patch.yml`;
const BACKUP = `${DIR}/cordis.patch.yml.bak-before-rbexperiment`;

const arg = (process.argv[2] || '').toLowerCase();
const arm = arg === 'off' ? 'OFF' : arg.toUpperCase();
if (!['A', 'B', 'OFF', 'CHECK'].includes(arm)) {
  console.error('usage: node set-arm.mjs A|B|off|check');
  process.exit(2);
}

const src = readFileSync(PATCH, 'utf8');
let lines = src.split('\n');

const locate = (ls) => {
  const presetAt = ls.findIndex((l) => /^\s*-\s+id:\s*preset-bash-first\s*$/.test(l));
  if (presetAt < 0) throw new Error('preset-bash-first row not found');
  let pluginsAt = -1;
  for (let i = presetAt + 1; i < ls.length; i++) {
    if (/^\s*plugins:\s*$/.test(ls[i])) { pluginsAt = i; break; }
    if (/^\s*-\s+id:\s*\S/.test(ls[i])) break;
  }
  if (pluginsAt < 0) throw new Error('plugins: not found under preset-bash-first');
  const childIndent = ls[pluginsAt].match(/^\s*/)[0].length + 2;
  // first/last line belonging to the scoped row, if present
  let rowAt = -1;
  for (let i = pluginsAt + 1; i < ls.length; i++) {
    const m = ls[i].match(/^(\s*)-\s+id:\s*(\S+)\s*$/);
    if (!m) continue;
    if (m[1].length < childIndent) break;
    if (m[1].length === childIndent && m[2] === 'reasoning-budget') { rowAt = i; break; }
  }
  return { presetAt, pluginsAt, childIndent, rowAt };
};

const IND = (n) => ' '.repeat(n);
const rowText = (a, childIndent) => [
  `${IND(childIndent)}# PRESET-SCOPED reasoning budget (prompt experiment). The global row above mounts`,
  `${IND(childIndent)}# section name 'reasoning-budget' for every preset; a section with the same name`,
  `${IND(childIndent)}# registered through this agent's own ctx shadows it, so only 快速模式 is affected.`,
  `${IND(childIndent)}- id: reasoning-budget`,
  `${IND(childIndent + 2)}name: ./rb-arm${a}.mjs`,
];

const describe = (ls) => {
  const { rowAt, childIndent } = locate(ls);
  if (rowAt < 0) return { present: false };
  for (let i = rowAt + 1; i < ls.length; i++) {
    const m = ls[i].match(/^(\s*)name:\s*(.*)$/);
    if (m && m[1].length > childIndent) return { present: true, name: m[2].trim(), rowAt };
    if (/^\s*-\s+id:\s*\S/.test(ls[i]) && ls[i].match(/^\s*/)[0].length <= childIndent) break;
  }
  return { present: true, name: null, rowAt };
};

if (arm === 'CHECK') {
  const d = describe(lines);
  console.log(JSON.stringify({ patch: PATCH, lines: lines.length, ...d }, null, 2));
  process.exit(0);
}

const { pluginsAt, childIndent, rowAt } = locate(lines);
const before = describe(lines);

if (arm === 'OFF') {
  if (rowAt >= 0) {
    let start = rowAt;
    while (start - 1 > pluginsAt && /^\s*#/.test(lines[start - 1])) start--;
    let end = rowAt;
    for (let i = rowAt + 1; i < lines.length; i++) {
      if (lines[i].trim() === '' || lines[i].match(/^\s*/)[0].length > childIndent) end = i;
      else break;
    }
    lines.splice(start, end - start + 1);
  }
} else if (rowAt >= 0) {
  // replace just the name line of the existing row
  for (let i = rowAt + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)name:\s*(.*)$/);
    if (m && m[1].length > childIndent) { lines[i] = `${m[1]}name: ./rb-arm${arm}.mjs`; break; }
    if (/^\s*-\s+id:\s*\S/.test(lines[i]) && lines[i].match(/^\s*/)[0].length <= childIndent) break;
  }
} else {
  // insert after the persona row (the first child of plugins:) so it stays a direct child
  let anchor = pluginsAt;
  for (let i = pluginsAt + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*(\S+)\s*$/);
    if (!m) continue;
    if (m[1].length < childIndent) break;
    if (m[1].length === childIndent) {
      // extend to the end of this row
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const mm = lines[j].match(/^(\s*)-\s+id:\s*(\S+)\s*$/);
        if (mm && mm[1].length <= childIndent) break;
        if (lines[j].trim() !== '' && lines[j].match(/^\s*/)[0].length <= childIndent) break;
        end = j;
      }
      anchor = end;
      break;
    }
  }
  lines.splice(anchor + 1, 0, ...rowText(arm, childIndent));
}

if (!existsSync(BACKUP)) copyFileSync(PATCH, BACKUP);
writeFileSync(PATCH, lines.join('\n'), 'utf8');

const after = readFileSync(PATCH, 'utf8');
console.log(`arm=${arm}`);
console.log(`  before: ${JSON.stringify(before)}`);
console.log(`  after : ${JSON.stringify(describe(after.split('\n')))}`);
console.log(`  global reasoning-budget row still present: ${/^\s*-\s+id:\s*reasoning-budget\s*$/m.test(after)}`);
console.log(`  lines: ${src.split('\n').length} -> ${after.split('\n').length}`);

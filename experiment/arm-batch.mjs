#!/usr/bin/env node
// arm-batch.mjs — drive the prompt experiment through the task board.
//
// Because there is no non-interactive CLI and subtasks inherit the parent's
// `mode`, one parent card with N subtasks starts N bash-first sessions with a
// single run call. This script creates that tree.
//
//   node arm-batch.mjs <cardPrefix> <count> <parentId|NEW> <promptFile>
//
// It prints the JSON it would hand to the board tools; the agent then performs
// the calls (this repo has no HTTP client for the board).
import { readFileSync } from 'node:fs';

const [prefix, countRaw, parent, promptFile] = process.argv.slice(2);
if (!prefix || !countRaw) {
  console.error('usage: node arm-batch.mjs <prefix> <count> <parentId|NEW> <promptFile>');
  process.exit(2);
}
const count = Number.parseInt(countRaw, 10);
const prompt = readFileSync(promptFile || 'task.txt', 'utf8');
const plan = [];
for (let i = 1; i <= count; i++) {
  plan.push({ title: `${prefix}-${String(i).padStart(2, '0')}`, parentId: parent === 'NEW' ? null : parent, prompt });
}
console.log(JSON.stringify(plan, null, 1));

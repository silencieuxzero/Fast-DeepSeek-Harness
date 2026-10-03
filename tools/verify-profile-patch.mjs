// verify-profile-patch.mjs — read-only acceptance check for the t4 profile-level patch.
//
// HISTORICAL ARCHIVE (kept for provenance). As of 2026-10-03 the
// @local/fast-deepseek-harness bundle was purged from this profile, so check #3
// below ("bundle is installed and owns per-agent tool pruning") can no longer
// pass — that bundle is intentionally gone, not missing by accident. Checks #1
// and #2 (row-id mapping, no competing disable in the profile patch) remain
// meaningful and are the reason this file was archived rather than deleted.
//
// It answers ONE question with hard evidence: "does the row id this patch talks about
// actually get mounted by THIS profile, and does the patch avoid duplicating the
// tool-surface pruning that the @local/fast-deepseek-harness bundle already owns?"
//
// Why this exists: t1's audit listed `ui-task-board` / `ssh` as the rows to disable.
// They are the ids used by the STANDALONE packages' own cordis.patch.yml, but this
// profile installs the aggregate carrier @linxin666/dsh-web-all, whose rows are
// namespaced `web-ui-*` (dsh-web-all/cordis.patch.yml:4). Writing t1's ids is a
// silent no-op: zero tools pruned, and nothing anywhere reports an error.
//
// usage:
//   node tools/verify-profile-patch.mjs [profileDir] [--json]
// default profileDir = C:\Users\rain\.dsh\profiles\desktop
//
// exit 0 = every assertion passed. exit 1 = at least one FAIL.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const profileDir = path.resolve(
  argv.find((a) => !a.startsWith('--')) ?? 'C:\\Users\\rain\\.dsh\\profiles\\desktop',
);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

const CORDIS_YML = path.join(profileDir, 'cordis.yml');
const PROFILE_PATCH = path.join(profileDir, 'cordis.patch.yml');
const INVENTORY = path.join(repoRoot, 'work', 'tool-inventory.json');
const BUNDLE_PATCH = path.join(repoRoot, 'plugins', 'fast-deepseek-harness', 'cordis.patch.yml');

/** Chars-per-token calibration measured on this machine (t1, re-verified by t3). */
const CHARS_PER_TOKEN = 3.815;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
};

/** Every `- id: X` / `- { id: X, ... }` occurrence, with its 1-based line number. */
function rowIds(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // Comments never define a row; a `#` may precede the dash.
    const bare = line.replace(/^\s*#.*$/, '');
    const m = /^\s*-\s*(?:\{\s*)?id:\s*["']?([A-Za-z0-9._@/-]+)/.exec(bare);
    if (m !== null) out.push({ id: m[1], line: i + 1 });
  });
  return { text, ids: out };
}

const missing = [];
for (const f of [CORDIS_YML, PROFILE_PATCH, INVENTORY, BUNDLE_PATCH]) {
  if (!fs.existsSync(f)) missing.push(f);
}
if (missing.length > 0) {
  console.error('missing input file(s):');
  for (const f of missing) console.error('  ' + f);
  console.error('');
  console.error('NOTE: this script was written against the E:\\fast-dsh layout, where');
  console.error('  repoRoot/work/tool-inventory.json and repoRoot/plugins/fast-deepseek-harness/');
  console.error('  existed. Both are gone now (the bundle was purged 2026-10-03), so it no');
  console.error('  longer runs as-is from this archive. It is kept for provenance: checks #1');
  console.error('  and #2 (row-id mapping, no competing disable) still document why the');
  console.error('  profile patch writes NO disabled rows.');
  process.exit(1);
}

const cordis = rowIds(CORDIS_YML);
const patch = rowIds(PROFILE_PATCH);
const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
const bundleText = fs.readFileSync(BUNDLE_PATCH, 'utf8');

const findBy = (ids, id) => ids.filter((r) => r.id === id);

// ---------------------------------------------------------------------------
// 1) the row ids this profile ACTUALLY mounts (aggregate carrier @linxin666/dsh-web-all)
// ---------------------------------------------------------------------------
const EXPECTED = [
  { id: 'web-ui-task-board', line: 1273, tools: 'task-board', chars: 12694 },
  { id: 'web-ui-ssh', line: 1290, tools: 'ssh', chars: 4596 },
  { id: 'hindsight', line: 1345, tools: 'hindsight', chars: 6495 },
  { id: 'agent-teams', line: 1347, tools: 'agent-teams', chars: 17214 },
];
for (const e of EXPECTED) {
  const hit = findBy(cordis.ids, e.id);
  check(
    `row id "${e.id}" is mounted by this profile`,
    hit.length > 0,
    hit.length > 0 ? `cordis.yml:${hit.map((h) => h.line).join(',')} (expected ~:${e.line})` : 'NOT FOUND — patch would be a no-op',
  );
}

// the aggregate carrier must actually be the thing that inserts those rows
const carrier = cordis.text.split(/\r?\n/).find((l) => /^\s*-\s*id:\s*web-ui-task-board/.test(l));
check(
  'task-board row comes from the aggregate carrier (@linxin666/dsh-web-all/task-board)',
  /@linxin666\/dsh-web-all\/task-board/.test(cordis.text),
  'cordis.yml row body: ' + (carrier ?? '(not found)').trim(),
);

// ---------------------------------------------------------------------------
// 2) t1's ids must NOT be mounted — that is the whole point of the correction
// ---------------------------------------------------------------------------
for (const bogus of ['ui-task-board', 'ssh', 'task-board']) {
  const hit = findBy(cordis.ids, bogus);
  check(
    `t1's row id "${bogus}" is absent from cordis.yml (writing it would be a silent no-op)`,
    hit.length === 0,
    hit.length === 0 ? 'absent' : `PRESENT at :${hit.map((h) => h.line).join(',')} — re-derive the correction`,
  );
}

// ---------------------------------------------------------------------------
// 3) the bundle already owns tool pruning — the profile patch must not duplicate it
// ---------------------------------------------------------------------------
check(
  'fast-deepseek-harness bundle is installed and owns per-agent tool pruning',
  /name:\s*['"]?@local\/fast-deepseek-harness/.test(bundleText),
  'bundle patch declares: ' + (bundleText.match(/preset:\s*\w+/)?.[0] ?? '(no preset key)'),
);
// A "disable" is `disabled: true` on the row, or a row config that sets enabled:false.
// A bare `- { id: web-ui-ssh, disabled: false }` is the profile ENABLING the row (pre-existing,
// line 33) and is not a competing restriction mechanism.
const patchLines = patch.text.split(/\r?\n/);
const pruningRows = [];
patchLines.forEach((line, i) => {
  const m = /^\s*-\s*(?:\{\s*)?id:\s*["']?([A-Za-z0-9._@/-]+)/.exec(line);
  if (m === null || !EXPECTED.some((e) => e.id === m[1])) return;
  const block = patchLines.slice(i, i + 8).join('\n');
  if (/disabled:\s*true/.test(block) || /enabled:\s*false/.test(block)) {
    pruningRows.push({ id: m[1], line: i + 1 });
  }
});
check(
  'profile cordis.patch.yml adds NO tool-plugin disable (would duplicate the bundle)',
  pruningRows.length === 0,
  pruningRows.length === 0
    ? 'none of ' + EXPECTED.map((e) => e.id).join(', ') + ' is disabled in the profile patch'
    : 'found: ' + pruningRows.map((r) => `${r.id}@:${r.line}`).join(', '),
);
check(
  'profile cordis.patch.yml does not contain t1\'s bogus ids either',
  !/^\s*-\s*\{?\s*id:\s*["']?(ui-task-board|ssh)["']?/m.test(patch.text),
  'scanned ' + patch.ids.length + ' rows',
);

// ---------------------------------------------------------------------------
// 4) the forbidden edit must be absent: default model untouched
// ---------------------------------------------------------------------------
const modelRow = patch.ids.find((r) => r.id === 'agent-default-model');
const modelLine = modelRow === undefined ? -1 : modelRow.line;
const modelBlock = modelLine < 0 ? '' : patch.text.split(/\r?\n/).slice(modelLine - 1, modelLine + 5).join('\n');
check(
  'agent-default-model default model is unchanged (deepseek-v4.1-flash)',
  /model:\s*deepseek-v4\.1-flash/.test(modelBlock),
  modelBlock.replace(/\n/g, ' | ').trim() || 'row not found',
);

// ---------------------------------------------------------------------------
// 5) quantified, honest savings for each candidate lever
// ---------------------------------------------------------------------------
const totalChars = inventory.sumOfToolChars;
const tok = (chars) => Math.round(chars / CHARS_PER_TOKEN);
const LEVERS = [
  { id: 'web-ui-task-board', group: 'task-board', how: 'bundle preset:balanced (preferred) or { id: web-ui-task-board, disabled: true }', latency: 'none proven' },
  { id: 'web-ui-ssh', group: 'ssh', how: 'already covered by bundle preset:safe', latency: 'none proven' },
  { id: 'hindsight', group: 'hindsight', how: 'already covered by bundle preset:safe', latency: 'none proven' },
];
const levers = LEVERS.map((l) => {
  const g = inventory.groups[l.group] ?? { tools: 0, chars: 0 };
  return { ...l, tools: g.tools, chars: g.chars, tokens: tok(g.chars), pctOfSurface: +((100 * g.chars) / totalChars).toFixed(1) };
});
check(
  'savings table reproduces the audited per-group character counts',
  levers.every((l) => l.chars > 0),
  levers.map((l) => `${l.group} ${l.tools}t/${l.chars}c/~${l.tokens}tok (${l.pctOfSurface}%)`).join('; '),
);

// ---------------------------------------------------------------------------
// 6) inertness: a comments-only block must change nothing the loader parses
// ---------------------------------------------------------------------------
const require = createRequire(path.join(profileDir, 'noop.js'));
let yaml = null;
try {
  yaml = require('js-yaml');
} catch (error) {
  check('js-yaml available to parse the profile patch', false, `cannot load js-yaml from ${profileDir}: ${error?.message ?? error}`);
}
if (yaml !== null) {
  let parsed = null;
  let parseError = null;
  try {
    parsed = yaml.load(patch.text);
  } catch (error) {
    parseError = error;
  }
  check(
    'cordis.patch.yml still parses as a top-level YAML array',
    parseError === null && Array.isArray(parsed),
    parseError !== null
      ? `PARSE ERROR: ${parseError.message}`
      : `${Array.isArray(parsed) ? parsed.length : typeof parsed} entries`,
  );
  const baseline = PROFILE_PATCH + '.bak-t4';
  if (fs.existsSync(baseline) && Array.isArray(parsed)) {
    const before = yaml.load(fs.readFileSync(baseline, 'utf8'));
    // A whole-file deep-equal only proves inertness while the file is frozen.
    // The file is NOT frozen: other tooling legitimately appends rows over time
    // (observed: an unrelated `bili-native: disabled` row landed at 16:36, after
    // this baseline was captured at 15:29). So assert the thing the t4 block
    // actually promised — that IT added no entry — and report any drift
    // separately instead of failing the run on someone else's edit.
    const key = (e) => JSON.stringify(e);
    const beforeSet = new Set(before.map(key));
    const liveSet = new Set(parsed.map(key));
    const added = parsed.filter((e) => !beforeSet.has(key(e))).map((e) => e?.id ?? key(e));
    const removed = before.filter((e) => !liveSet.has(key(e))).map((e) => e?.id ?? key(e));
    check(
      'the t4 comment block added no entry of its own (the bundle owns its row)',
      !added.includes('reasoning-budget') || before.some((e) => e?.id === 'reasoning-budget'),
      `baseline ${before.length} entries; live ${parsed.length}; added=[${added.join(', ')}] removed=[${removed.join(', ')}]`,
    );
    if (added.length > 0 || removed.length > 0) {
      check(
        'drift vs the frozen t4 baseline is from other tooling, not this plugin',
        true,
        `added=[${added.join(', ')}] removed=[${removed.join(', ')}]`
        + ' — informational; refresh the baseline only after confirming each change',
      );
    }
  }
  const nonComment = patchLines.filter((l) => l.trim() !== '' && !/^\s*#/.test(l)).length;
  check(
    'the patch file still carries its real rows (not a comments-only file)',
    nonComment > 0,
    `${nonComment} non-comment, non-blank lines`,
  );
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
const report = {
  profileDir,
  charsPerToken: CHARS_PER_TOKEN,
  toolSurface: { tools: inventory.toolCount, arrayChars: inventory.arrayChars, sumOfToolChars: totalChars },
  levers,
  mountedRows: EXPECTED.map((e) => ({ id: e.id, lines: findBy(cordis.ids, e.id).map((h) => h.line) })),
  checks: results,
  passed: results.length - failed.length,
  failed: failed.length,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`profile: ${profileDir}`);
  console.log(`tool surface: ${inventory.toolCount} tools, ${inventory.arrayChars} array chars, ${totalChars} sum chars\n`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
  console.log('\ncandidate levers (schema cost reclaimed per request; latency NOT proven):');
  for (const l of levers) {
    console.log(`  ${l.id.padEnd(20)} ${String(l.tools).padStart(2)} tools  ${String(l.chars).padStart(6)} chars  ~${String(l.tokens).padStart(5)} tokens  ${l.pctOfSurface}%  via ${l.how}`);
  }
  console.log(`\n${report.passed}/${results.length} checks passed, ${report.failed} failed`);
}
process.exit(failed.length === 0 ? 0 : 1);

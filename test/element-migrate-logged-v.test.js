// The v3→v4 planner reuses the logged version a copy already names (rule (0)
// 'logged'; PLAN 1A.4; DECISIONS C1/F3/F4; U247a, wave 7's follow-up W7-2).
//
// A project born on v4 that loses its _version.json is read back as v3 (U246)
// and goes through the comment migration. Its copies name their versions — a
// copy's own `v`, or its node's commit record's id@v — and the log already
// holds them. Before rule (0) a pin edited before its first commit (c1@1→@2→@3,
// no ancestor carrying c1) matched none of rules (a)/(b) (its carrier walk's pv
// is null, c1@3's parent_v is 2) and the plan minted c1@4 beside c1@3: the same
// payload twice, and copy-v-mismatch at the boot reconcile. Rule (0) takes the
// named version when the log holds it and element-log copyMatches holds — the
// reconcile's own payload check.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planMigration, migrateComments } = require('../lib/core/element-migrate');
const { createElementLog, payloadOf } = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');
const { withServer } = require('../test-support/helpers');

const T0 = 1760000000000;
const ANCHOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const copyOf = (text, over = {}) => ({
  id: 'c1', seq: 1, created_at: T0 + 1, shared: true, text, anchor: ANCHOR, replies: [], ...over,
});
const nodeOf = (id, parent, comments, i) => ({
  id, parent_id: parent, created_at: T0 + i * 1000, author: 'claude',
  trigger: { kind: 'turn', message: `turn ${i}`, summary: `turn ${i}` },
  mounts: [{ id: 'm1', html: '<p class="lead">Hello</p>', owner: 'claude' }],
  store: {}, comments, captures: [],
});

// A log holding c1@1 (root) → @2 → @3, each the next edit of one pin, and —
// unless `commit` is false — n1's commit record pinning c1@3 (homing all of
// them on n1 is the home of @3; @1 and @2 stay homeless, as a born-v4 edit
// before the first commit leaves them).
function seedLog(t, { commit = true, n1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-logged-v-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const file = path.join(dir, 'log.jsonl');
  const w = createElementLog({ file, redactor: createRedactor(), bootId: 'seed:1', now: () => T0 });
  w.load();
  w.ensureElement({ id: 'c1', kind: 'comment', created_at: T0 + 1 });
  w.appendVersion({ id: 'c1', payload: payloadOf(copyOf('one')), seq: 1, original: ANCHOR, at: T0 + 2 });
  w.appendVersion({ id: 'c1', payload: payloadOf(copyOf('two')), parent_v: 1, seq: 1, original: ANCHOR, at: T0 + 3 });
  w.appendVersion({ id: 'c1', payload: payloadOf(copyOf('three')), parent_v: 2, seq: 1, original: ANCHOR, at: T0 + 4 });
  if (commit) w.appendCommit({ node: n1, pins: ['c1@3'] });
  w.close();
  const log = createElementLog({ file, redactor: createRedactor(), dryRun: true });
  t.after(() => log.close());
  log.load();
  return log;
}

const n0 = nodeOf('n0', null, [], 0);
const plan = (log, nodes, more = {}) => planMigration({ nodes, meta: { state: 'ok', active: nodes[nodes.length - 1].id }, log, ...more });
const ops = (p, op) => p.actions.filter((a) => a.op === op);
const versionsToMint = (p) => ops(p, 'ver').length;

test('a copy naming v 3 with c1@3\'s payload maps to c1@3: no ver, no commit, reused_logged 1', (t) => {
  const n1 = nodeOf('n1', 'n0', [copyOf('three', { v: 3 })], 1);
  const log = seedLog(t, { n1 });
  const p = plan(log, [n0, n1]);
  assert.equal(p.refused, false);
  assert.deepEqual(ops(p, 'ver'), [], 'no version minted (was c1@4, parent_v null)');
  assert.deepEqual(ops(p, 'commit'), [], 'n1\'s commit record is already the plan\'s');
  assert.equal(p.counters.reused_logged, 1);
  assert.equal(p.counters.commits_present, 1);
  assert.equal(versionsToMint(p), 0);
  assert.deepEqual(p.detail.pins.get('n1'), ['c1@3']);
  assert.deepEqual(ops(p, 'migration').length, 1, 'only the migration record is appended');
});

test('the same copy without its v: n1\'s commit record names c1@3, so it maps there', (t) => {
  const n1 = nodeOf('n1', 'n0', [copyOf('three')], 1);
  const log = seedLog(t, { n1 });
  const p = plan(log, [n0, n1]);
  assert.equal(p.counters.reused_logged, 1);
  assert.deepEqual(ops(p, 'ver'), []);
  assert.deepEqual(ops(p, 'commit'), []);
  assert.equal(p.counters.commits_present, 1);
});

test('a copy naming v 3 whose text differs, or a v the log lacks: today\'s rules (each mints), reused_logged 0', (t) => {
  for (const c of [copyOf('edited by hand', { v: 3 }), copyOf('three', { v: 9 })]) {
    // No commit record here, so the commit-pin route cannot answer either.
    const n1 = nodeOf('n1', 'n0', [c], 1);
    const log = seedLog(t, { commit: false });
    const p = plan(log, [n0, n1]);
    assert.equal(p.counters.reused_logged, 0, `v ${c.v}, "${c.text}"`);
    const ver = ops(p, 'ver');
    assert.equal(ver.length, 1, 'mints, as rule (c) did before');
    assert.equal(ver[0].v, 4);
    assert.equal(ver[0].parent_v, null);
  }
});

test('a copy naming v 3 with a payload the commit pin also names, under a node whose commit record names another v: c.v wins', (t) => {
  // The copy's own v is the one it names; the commit pin is read only when the
  // copy carries none.
  const n1 = nodeOf('n1', 'n0', [copyOf('two', { v: 2 })], 1);
  const log = seedLog(t, { n1 });
  const p = plan(log, [n0, n1]);
  assert.equal(p.counters.reused_logged, 1);
  assert.deepEqual(p.detail.pins.get('n1'), ['c1@2']);
  assert.deepEqual(ops(p, 'ver'), []);
  assert.equal(ops(p, 'commit').length, 1, 'the plan\'s pins differ from the record\'s: a commit is written');
});

test('a draft copy on base_active naming v 3 with its payload: no ver for the draft', (t) => {
  const n1 = nodeOf('n1', 'n0', [copyOf('three', { v: 3 })], 1);
  const log = seedLog(t, { n1 });
  const draft = { state: 'ok', value: { base_active: 'n1', comments: [copyOf('three', { v: 3 })] } };
  const p = plan(log, [n0, n1], { draft });
  assert.equal(p.draft.state, 'migrated');
  assert.equal(p.draft.versions_new, 0);
  assert.deepEqual(p.detail.draft, ['c1@3']);
  assert.deepEqual(ops(p, 'ver'), []);

  // A draft copy whose base_active node carries a different v of the pin: its
  // own v still names the version (no ancestry test for a named version).
  const n1b = nodeOf('n1', 'n0', [copyOf('three', { v: 3 })], 1);
  const log2 = seedLog(t, { n1: n1b });
  const d2 = { state: 'ok', value: { base_active: 'n1', comments: [copyOf('two', { v: 2 })] } };
  const p2 = plan(log2, [n0, n1b], { draft: d2 });
  assert.deepEqual(p2.detail.draft, ['c1@2']);
  assert.equal(p2.draft.versions_new, 0);
  assert.deepEqual(ops(p2, 'ver'), []);
});

test('a homeless logged version a node copy names is homed by the plan (claimed), as reuse (b)\'s homeless branch does', (t) => {
  const n1 = nodeOf('n1', 'n0', [copyOf('three', { v: 3 })], 1);
  const log = seedLog(t, { commit: false });
  assert.equal(log.homeOf('c1', 3), null, 'c1@3 has no home before the plan');
  // n2 (a sibling of n1 under n0) names the same version: it stays homed on n1,
  // the first node in graph order, and still maps (the copy names it).
  const n2 = nodeOf('n2', 'n0', [copyOf('three', { v: 3 })], 2);
  const p = plan(log, [n0, n1, n2]);
  assert.equal(p.counters.reused_logged, 2);
  assert.deepEqual(ops(p, 'ver'), []);
  const commits = ops(p, 'commit');
  assert.deepEqual(commits.map((a) => [a.node.id, a.pins]), [['n1', ['c1@3']], ['n2', ['c1@3']]],
    'the plan\'s commits home c1@3 on n1');
  assert.equal(p.counters.commits_new, 2);
  assert.equal(p.counters.reuse_refused_home_off_ancestry, 0);

  // The claim is what later rules read: n1 names the homeless c1@1, so a copy
  // with c1@1's payload and no v on a sibling branch (n3) finds it homed on n1,
  // off n3's ancestry — refused (F4), never taken as homeless — and mints.
  const log2 = seedLog(t, { commit: false });
  const m1 = nodeOf('n1', 'n0', [copyOf('one', { v: 1 })], 1);
  const m3 = nodeOf('n3', 'n0', [copyOf('one')], 3);
  const p2 = plan(log2, [n0, m1, m3]);
  assert.equal(p2.counters.reused_logged, 1);
  assert.equal(p2.counters.reused_homeless, 0);
  assert.equal(p2.counters.reuse_refused_home_off_ancestry, 1);
  assert.deepEqual(p2.detail.pins.get('n3'), ['c1@4']);
});

test('a v3 graph (copies with no v, no commit records): rule (0) never fires', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-logged-v3-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const log = createElementLog({ file: path.join(dir, 'log.jsonl'), redactor: createRedactor(), dryRun: true });
  t.after(() => log.close());
  log.load();
  const n1 = nodeOf('n1', 'n0', [copyOf('one')], 1);
  const n2 = nodeOf('n2', 'n1', [copyOf('two')], 2);
  const p = plan(log, [n0, n1, n2]);
  assert.equal(p.counters.reused_logged, 0);
  assert.deepEqual(ops(p, 'ver').map((a) => [a.v, a.parent_v]), [[1, null], [2, 1]]);
});

// ── end to end ──────────────────────────────────────────────────────────────

async function ok(p, what) {
  const r = await p;
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function turn(api, message) {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  return ok(api.post('/api/turn-end', { summary: message }), 'turn-end');
}
const logRecords = (root) => fs.readFileSync(projectPaths(root).elementsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const versionsOfPin = (root, id) => logRecords(root).filter((r) => r.t === 'ver' && r.id === id);

test('a born-v4 project that lost _version.json migrates with no version appended and no copy-v-mismatch', async (t) => {
  // First touch: a new project at v4.
  const s1 = await withServer(t, {});
  const root = s1.root;
  const paths = projectPaths(root);
  assert.equal(JSON.parse(fs.readFileSync(paths.version, 'utf8')).version, 4);
  await ok(s1.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  await turn(s1.api, 'page');
  const pin = (await ok(s1.api.post('/api/comments', { text: 'one', anchor: ANCHOR }), 'add')).pin;
  await ok(s1.api.patch(`/api/comments/${pin.id}`, { text: 'two' }), 'edit 1');
  await ok(s1.api.patch(`/api/comments/${pin.id}`, { text: 'three' }), 'edit 2');
  await turn(s1.api, 'pins');
  await s1.stop();

  const before = versionsOfPin(root, pin.id);
  assert.ok(before.length >= 3, `the pin was edited twice (${before.length} versions)`);
  assert.equal(logRecords(root).some((r) => r.t === 'migration'), false, 'a born-v4 log holds no migration record');
  fs.rmSync(paths.version);

  // The report counts the logged reuses in `reused` (a dry run: nothing written).
  const dry = migrateComments(paths.dir, { dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.ok(dry.report.counters.reused_logged >= 1, JSON.stringify(dry.report.counters));
  const c = dry.report.counters;
  assert.equal(dry.report.reused, c.reused_on_edge + c.reused_by_hash + c.reused_homeless + c.reused_logged);
  assert.equal(dry.report.versions_to_mint, 0);
  assert.deepEqual(versionsOfPin(root, pin.id), before, 'the dry run wrote nothing');

  const s2 = await withServer(t, { root });
  assert.equal(JSON.parse(fs.readFileSync(paths.version, 'utf8')).version, 4);
  const after = versionsOfPin(root, pin.id);
  assert.deepEqual(after.map((r) => [r.v, r.parent_v]), before.map((r) => [r.v, r.parent_v]), 'no new version of the pin (no duplicate @4)');
  const records = logRecords(root);
  assert.equal(records.filter((r) => r.t === 'migration').length, 1, 'the migration record');
  const report = JSON.parse(fs.readFileSync(paths.elementsBootReport, 'utf8'));
  assert.equal(report.states['copy-v-mismatch'], undefined, JSON.stringify(report.states));
  assert.equal(s2.srv.elements.stats().copy_v_mismatch, 0);
});

// The chat mirror's disk budget (U455; annotation engine PLAN.md 3E.1 as
// re-specified by DECISIONS.md L.4 P4 = c, "make the size adjustable but
// default to unlimited"; RULED R2 = a; GT-13's retention clauses).
//
// Pinned:
//   * lib/core/mirror-settings: readMirrorSettings — absent, corrupt (torn
//     JSON) and invalid (v 2, a negative, string or under-floor size, an extra
//     key) each read {v: 1, disk_budget_bytes: null}, and the file is left as it
//     is; write then read round-trips; parseSize reads '2GiB', '500MB',
//     '1.5 GB', '1073741824' and 'unlimited' (null), and refuses '10MB' (under
//     MIN_BUDGET_BYTES, 64 MiB), '-1' and '2XB' with a hint;
//   * NO SIZE SET (L.4's clause): a mirror of any size — index, diffs and a
//     shadow store far over 1 GiB as a synthetic (sparse) file tree — deletes
//     nothing at the first housekeeping or a later check, logs no budget line,
//     prunes nothing and keeps recording ('shadow-store-full' never set); a
//     corrupt mirror.json reads as unlimited and deletes nothing either;
//   * a size set and the mirror under it: nothing deleted;
//   * a size set and the mirror over it: (i) the index files of an ended,
//     unparsed conversation and an orphan go first (the orphan before them),
//     a live conversation's and a parsed one's (engine.indexing false) stay,
//     then the node-diff caches; (ii) prunes stepped 7 days → 3 days → 1 day →
//     6 hours, never under an hour; (iii) diff records oldest first, a
//     node-linked turn's record (a node's node.mirror ref) after every other;
//     each deletion one `[mirror] budget` line, capped at 50, then the summary;
//   * on a real shadow store the stepped prune removes an old unreachable
//     tree, keeps a fresh one and keeps a tree a ref holds;
//   * a size the mirror cannot get under after every tier → recording off
//     with 'shadow-store-full', store.full() true, restore's features()
//     answers its existing reason; lifting the budget (`unlimited`) turns
//     recording back on at the next check;
//   * the check repeats every BUDGET_CHECK_MS (6 h), reading the record again;
//     stop() clears the timer;
//   * turnDiff of a ready turn whose record the budget deleted answers
//     {status: 'unavailable', reason: 'removed', rule: 'disk-budget-bytes',
//     note: the row's user_text}; with no budget set the rule is null.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withTempHome, waitUntil } = require('../test-support/helpers');
const { treesnapRepo } = require('../test-support/treesnap-fixture');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths, userClaudePaths } = require('../lib/core/paths');
const { runGit } = require('../lib/server/git-run');
const { retention } = require('../lib/server/mirror/retention');
const { createRestore } = require('../lib/server/control/restore');
const {
  createShadowStore, createCodediffSource, LIMITS, SNAPSHOT_FLOOR_MS, PRUNE_STEPS_MS, BUDGET_LOG_MAX, REMOVED_NOTE,
} = require('../lib/server/mirror/codediff');
const settings = require('../lib/core/mirror-settings');

const {
  readMirrorSettings, inspectMirrorSettings, writeMirrorSettings, parseSize, measureMirror, MIN_BUDGET_BYTES,
} = settings;

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const S = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const DEFAULT = { v: 1, disk_budget_bytes: null };

function project(t) {
  withTempHome(t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(require('../test-support/sandbox').home, 'wc-u455-')));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths: projectPaths(root) };
}

// A file of `size` bytes (sparse: truncate, so a GiB costs no disk), its mtime
// `ageMs` ago. `json` puts that text at the head of the file.
function put(file, size, { ageMs = 0, json = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json || '');
  fs.truncateSync(file, Math.max(size, json ? Buffer.byteLength(json) : 0));
  const at = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, at, at);
  return file;
}
// An index file whose JSON carries saved_at, padded with spaces to `size`.
function putIndex(paths, sid, size, savedAt) {
  const head = JSON.stringify({ session_id: sid, saved_at: savedAt });
  const body = head.slice(0, -1) + ' '.repeat(Math.max(0, size - head.length)) + '}';
  return put(paths.mirrorIndex(sid), Buffer.byteLength(body), { json: body });
}
const exists = (f) => fs.existsSync(f);

// A shadow store stand-in over real files: prune(expire) removes the files
// under mirrorGit/objects older than the expiry, as git prune does an
// unreachable loose object; measure is the real one.
function fakeStore(paths) {
  let overBudget = false;
  const prunes = [];
  const ageOf = (expire) => {
    const m = /^(\d+)\.(days|hours|seconds)\.ago$/.exec(expire);
    assert.ok(m, `an expiry git reads (${expire})`);
    return Number(m[1]) * { days: DAY, hours: HOUR, seconds: 1000 }[m[2]];
  };
  const walk = (dir, out = []) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  return {
    prunes,
    init: async () => ({ ok: true }),
    info: () => ({ attrSource: true }),
    snapshot: async () => ({ ok: true, tree: 'a'.repeat(40), at: Date.now(), duration_ms: 1, excluded: { large: [], sensitive: [] }, head: null, attr_exact: true }),
    housekeep: async () => ({ ok: true, full: overBudget }),
    prune: async (expire) => {
      prunes.push(expire);
      const cutoff = Date.now() - ageOf(expire);
      for (const f of walk(path.join(paths.mirrorGit, 'objects'))) if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
      return true;
    },
    measure: () => measureMirror(paths),
    full: () => overBudget,
    markFull: (v) => { overBudget = v === true; },
    diff: async () => ({ ok: false, reason: 'diff-failed' }),
    treeExists: async () => false,
    env: () => ({}),
  };
}

// The codediff source on a fake engine whose timers the test runs by hand:
// first() opens a fresh turn (its snapshot schedules the first housekeeping)
// and runs that check; next() runs the BUDGET_CHECK_MS check the last one armed.
function sourceOn(t, { root, paths, store, limits = {}, convs = [], unparsed = [], graph = null, headers = new Map(), transcriptPath = () => null }) {
  const logs = [];
  const timers = [];
  const cleared = [];
  const bySid = new Map();
  for (const c of convs) for (const s of c.sessions) bySid.set(s.session_id, c);
  const engine = {
    root, paths, now: Date.now, log: (m) => logs.push(String(m)), graph,
    redactor: createRedactor(),
    timers: {
      setTimeout: (fn, ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; },
      clearTimeout: (id) => cleared.push(id),
    },
    model: {
      turn: (id) => headers.get(id) || null,
      resolveTurn: (id) => id,
      turnsOf: () => [],
      openTurnOf: () => null,
      patchTurn: (id, p) => { headers.set(id, { ...(headers.get(id) || { id }), ...p }); },
    },
    conversations: {
      list: () => convs,
      bySession: (sid) => bySid.get(sid) || null,
      transcriptPath,
    },
    indexing: (cid) => unparsed.includes(cid),
    live: { noteActivity: () => {} },
  };
  const src = createCodediffSource({ enabled: true, shadow: store, limits }).attach(engine);
  t.after(() => src.stop());
  const checks = () => timers.filter((x) => x.ms === LIMITS.BUDGET_CHECK_MS && !x.ran);
  const h = {
    src, logs, timers, cleared, headers, engine,
    budgetLines: () => logs.filter((l) => l.startsWith('[mirror] budget:')),
    state: () => src.diagnostics().git.state,
    async first() {
      src.onTurnOpened({ id: 'tOpen', conversation_id: 'C0', session_id: S(9), started_at: Date.now() });
      const zero = await waitUntil(() => timers.find((x) => x.ms === 0 && !x.ran), { timeout: 10000, what: 'the first housekeeping' });
      zero.ran = true;
      zero.fn();
      return waitUntil(() => checks().length === 1, { timeout: 20000, what: 'the first check' });
    },
    async next() {
      const [c] = checks();
      assert.ok(c, 'a check is armed');
      c.ran = true;
      c.fn();
      return waitUntil(() => checks().length === 1, { timeout: 20000, what: 'the next check' });
    },
  };
  return h;
}

// ── lib/core/mirror-settings ────────────────────────────────────────────────

test('readMirrorSettings: absent, corrupt and invalid each read {v: 1, disk_budget_bytes: null}, and the file is left as it is', (t) => {
  const { paths } = project(t);
  assert.equal(paths.mirrorSettings, path.join(paths.dir, 'mirror.json'));
  assert.deepEqual(readMirrorSettings(paths), DEFAULT);
  assert.equal(inspectMirrorSettings(paths).state, 'absent');
  const cases = [
    ['{"v":1,"disk_budget_bytes":', 'corrupt'],
    ['', 'corrupt'],
    ['{"v":2,"disk_budget_bytes":null}', 'invalid'],
    ['{"v":1,"disk_budget_bytes":-1}', 'invalid'],
    ['{"v":1,"disk_budget_bytes":"2GiB"}', 'invalid'],
    [`{"v":1,"disk_budget_bytes":${MIN_BUDGET_BYTES - 1}}`, 'invalid'],
    ['{"v":1,"disk_budget_bytes":1.5e9}', 'ok'],
    [`{"v":1,"disk_budget_bytes":${GiB},"x":1}`, 'invalid'],
    ['[1]', 'invalid'],
  ];
  for (const [bytes, state] of cases) {
    fs.writeFileSync(paths.mirrorSettings, bytes);
    const r = inspectMirrorSettings(paths);
    assert.equal(r.state, state, bytes);
    if (state !== 'ok') assert.deepEqual(readMirrorSettings(paths), DEFAULT, bytes);
    assert.equal(fs.readFileSync(paths.mirrorSettings, 'utf8'), bytes, 'never renamed aside or rewritten');
  }
  assert.equal(fs.readdirSync(paths.dir).filter((n) => n.startsWith('mirror.json')).length, 1, 'no aside copy');
  assert.throws(() => readMirrorSettings({}), TypeError);
});

test('writeMirrorSettings then readMirrorSettings round-trips; a size under the floor or not an integer is refused', (t) => {
  const { paths } = project(t);
  assert.deepEqual(writeMirrorSettings(paths, { disk_budget_bytes: 2 * GiB }), { v: 1, disk_budget_bytes: 2 * GiB });
  assert.deepEqual(readMirrorSettings(paths), { v: 1, disk_budget_bytes: 2 * GiB });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.mirrorSettings, 'utf8')), { v: 1, disk_budget_bytes: 2 * GiB });
  writeMirrorSettings(paths, { disk_budget_bytes: null });
  assert.deepEqual(readMirrorSettings(paths), DEFAULT);
  assert.equal(inspectMirrorSettings(paths).state, 'ok');
  for (const bad of [MIN_BUDGET_BYTES - 1, -1, 1.5 * GiB + 0.5, '1GiB', undefined, Infinity]) {
    assert.throws(() => writeMirrorSettings(paths, { disk_budget_bytes: bad }), TypeError, String(bad));
  }
  assert.deepEqual(readMirrorSettings(paths), DEFAULT, 'a refused write leaves the record');
});

test('parseSize reads decimal and binary units and `unlimited`; under 64 MiB, negative and unknown units are refused with a hint', () => {
  assert.equal(MIN_BUDGET_BYTES, 64 * MiB, 'RULED R2 = a');
  assert.equal(parseSize('2GiB'), 2147483648);
  assert.equal(parseSize('500MB'), 500000000);
  assert.equal(parseSize('1.5 GB'), 1500000000);
  assert.equal(parseSize('1073741824'), 1073741824);
  assert.equal(parseSize('64MiB'), MIN_BUDGET_BYTES);
  assert.equal(parseSize('1tib'), 1024 ** 4);
  assert.equal(parseSize('unlimited'), null);
  assert.equal(parseSize(' Unlimited '), null);
  for (const [text, code] of [['10MB', 'under-floor'], ['-1', 'bad-size'], ['2XB', 'bad-size'], ['', 'bad-size'], ['GB', 'bad-size'], ['1e9', 'bad-size'], [undefined, 'bad-size']]) {
    assert.throws(() => parseSize(text), (e) => e instanceof settings.SizeError && e.code === code && typeof e.hint === 'string' && e.hint.length > 0, String(text));
  }
  assert.throws(() => parseSize('10MB'), /64 MiB/);
  assert.throws(() => parseSize('2XB'), /GiB/);
});

// ── no size set: nothing is deleted whatever the size (L.4's clause) ────────

function bigMirror(paths) {
  const files = [
    putIndex(paths, S(1), 2 * KiB, 1),
    put(paths.mirrorIndex(S(2)), 1.5 * GiB, { ageMs: 400 * DAY }),
    put(paths.mirrorDiff('tOld'), 300 * MiB, { ageMs: 400 * DAY }),
    put(paths.mirrorNodeDiff('n1'), 10 * MiB, { ageMs: 30 * DAY }),
    put(path.join(paths.mirrorGit, 'objects', 'ab', 'c'.repeat(38)), 2 * GiB, { ageMs: 30 * DAY }),
    put(path.join(paths.mirrorGit, 'objects', 'pack', 'pack-1.pack'), 1 * GiB, { ageMs: 30 * DAY }),
  ];
  return files;
}

test('no budget set: a mirror far over 1 GiB deletes nothing at the first housekeeping or a later check, logs no budget line and keeps recording', async (t) => {
  const { root, paths } = project(t);
  const files = bigMirror(paths);
  assert.ok(measureMirror(paths).total > 4 * GiB);
  const store = fakeStore(paths);
  const h = sourceOn(t, {
    root, paths, store,
    convs: [{ id: 'C1', sessions: [{ session_id: S(1) }], ended_at: 1, process: null }],
    unparsed: ['C1'],
  });
  await h.first();
  await h.next();
  for (const f of files) assert.ok(exists(f), `${path.basename(f)} kept`);
  assert.deepEqual(h.budgetLines(), [], 'no budget line');
  assert.deepEqual(store.prunes, [], 'no budget prune');
  assert.equal(store.full(), false);
  assert.notEqual(h.state(), 'shadow-store-full');
  assert.ok(!h.logs.some((l) => l.includes('shadow-store-full')));
  assert.equal(LIMITS.DISK_BUDGET_BYTES, null);
});

test('a corrupt mirror.json reads as unlimited: nothing deleted', async (t) => {
  const { root, paths } = project(t);
  const files = bigMirror(paths);
  fs.writeFileSync(paths.mirrorSettings, '{"v":1,"disk_budget_bytes":1');
  const store = fakeStore(paths);
  const h = sourceOn(t, { root, paths, store, convs: [{ id: 'C1', sessions: [{ session_id: S(1) }], ended_at: 1, process: null }], unparsed: ['C1'] });
  await h.first();
  for (const f of files) assert.ok(exists(f));
  assert.deepEqual(h.budgetLines(), []);
  assert.equal(store.full(), false);
});

test('a size set and the mirror under it: nothing deleted, no budget line', async (t) => {
  const { root, paths } = project(t);
  writeMirrorSettings(paths, { disk_budget_bytes: 64 * MiB });
  const files = [putIndex(paths, S(1), 2 * KiB, 1), put(paths.mirrorDiff('t1'), 4 * KiB, { ageMs: DAY })];
  const store = fakeStore(paths);
  const h = sourceOn(t, { root, paths, store, convs: [{ id: 'C1', sessions: [{ session_id: S(1) }], ended_at: 1, process: null }], unparsed: ['C1'] });
  await h.first();
  for (const f of files) assert.ok(exists(f));
  assert.deepEqual(h.budgetLines(), []);
  assert.deepEqual(store.prunes, []);
});

// ── a size set and the mirror over it: the order ────────────────────────────

test('over a set budget: rebuildable indexes (orphan first, never a live or parsed one) and node-diff caches, then stepped prunes, then diff records oldest first with a node-linked one last', async (t) => {
  const { root, paths } = project(t);
  const K = 1000;
  // (i) indexes: S9 an orphan; S1, S2 ended and unparsed; S3 live; S4 ended but parsed.
  const idx = {
    orphan: putIndex(paths, S(9), K, 500),
    s1: putIndex(paths, S(1), K, 100),
    s2: putIndex(paths, S(2), K, 300),
    live: putIndex(paths, S(3), K, 50),
    parsed: putIndex(paths, S(4), K, 10),
  };
  const cache = put(paths.mirrorNodeDiff('n1'), K, { ageMs: 40 * DAY });
  // (ii) loose objects: 10 days, 2 days and 30 minutes old.
  const obj = (name, ageMs) => put(path.join(paths.mirrorGit, 'objects', name.slice(0, 2), name.slice(2)), K, { ageMs });
  const old1 = obj('aa' + '1'.repeat(38), 10 * DAY);
  const old2 = obj('bb' + '2'.repeat(38), 2 * DAY);
  const fresh = obj('cc' + '3'.repeat(38), 30 * 60 * 1000);
  // (iii) diff records: dB and dD are node-linked.
  const d = {
    dA: put(paths.mirrorDiff('dA'), K, { ageMs: 5 * DAY }),
    dB: put(paths.mirrorDiff('dB'), K, { ageMs: 9 * DAY }),
    dC: put(paths.mirrorDiff('dC'), K, { ageMs: 3 * DAY }),
    dD: put(paths.mirrorDiff('dD'), K, { ageMs: 1 * DAY }),
  };
  assert.equal(measureMirror(paths).total, 13 * K);
  const graph = {
    nodes: new Map([
      ['n1', { id: 'n1', mirror: { v: 1, turns: [{ turn_id: 'dB', session_id: S(1) }] } }],
      ['n2', { id: 'n2', mirror: { v: 1, turns: ['dD'] } }],
      ['n3', { id: 'n3' }],
    ]),
  };
  const ready = { status: 'ready', files: 1, additions: 1, deletions: 0 };
  const headers = new Map([['dA', { id: 'dA', session_id: S(1), code: ready }]]);
  const store = fakeStore(paths);
  const h = sourceOn(t, {
    root, paths, store, graph, headers,
    limits: { DISK_BUDGET_BYTES: 4500 },
    convs: [
      { id: 'C1', sessions: [{ session_id: S(1) }], ended_at: 1, process: null },
      { id: 'C2', sessions: [{ session_id: S(2) }], ended_at: null, process: null },
      { id: 'C3', sessions: [{ session_id: S(3) }], ended_at: null, process: { pid: 4242 } },
      { id: 'C4', sessions: [{ session_id: S(4) }], ended_at: 1, process: null },
    ],
    unparsed: ['C1', 'C2', 'C3'],
  });
  await h.first();

  for (const f of [idx.orphan, idx.s1, idx.s2, cache, old1, old2, d.dA, d.dC, d.dB]) assert.ok(!exists(f), `${path.basename(f)} deleted`);
  for (const f of [idx.live, idx.parsed, fresh, d.dD]) assert.ok(exists(f), `${path.basename(f)} kept`);
  assert.deepEqual(store.prunes, ['7.days.ago', '3.days.ago', '1.days.ago', '6.hours.ago'], 'the stepped expiry');
  assert.deepEqual(PRUNE_STEPS_MS, [7 * DAY, 3 * DAY, DAY, 6 * HOUR]);
  assert.equal(SNAPSHOT_FLOOR_MS, HOUR);
  assert.ok(PRUNE_STEPS_MS.every((ms) => ms >= SNAPSHOT_FLOOR_MS), 'never under an hour');

  const lines = h.budgetLines();
  assert.deepEqual(lines.slice(0, -1), [
    `[mirror] budget: deleted index ${S(9)}.json (1000 B)`,
    `[mirror] budget: deleted index ${S(1)}.json (1000 B)`,
    `[mirror] budget: deleted index ${S(2)}.json (1000 B)`,
    '[mirror] budget: deleted node-diff node-n1.json (1000 B)',
    '[mirror] budget: pruned snapshots older than 7.days.ago (1000 B)',
    '[mirror] budget: pruned snapshots older than 3.days.ago (0 B)',
    '[mirror] budget: pruned snapshots older than 1.days.ago (1000 B)',
    '[mirror] budget: pruned snapshots older than 6.hours.ago (0 B)',
    '[mirror] budget: deleted diff dA.json (1000 B)',
    '[mirror] budget: deleted diff dC.json (1000 B)',
    '[mirror] budget: deleted linked-diff dB.json (1000 B)',
  ]);
  const summary = lines.at(-1);
  assert.match(summary, /^\[mirror\] budget: 13000 B over the 4500 B budget, now 4000 B: /);
  assert.match(summary, /deleted 3 index files \(3000 B\), 1 node-diff caches \(1000 B\), 2 diff records \(2000 B\), 1 node-linked diff records \(1000 B\); pruned snapshots to 6\.hours\.ago \(2000 B\)$/);
  assert.equal(store.full(), false, 'under the budget: not full');
  assert.notEqual(h.state(), 'shadow-store-full');

  // turnDiff of a ready turn whose record the budget deleted names the budget.
  const out = await h.src.api.diff({ turn: 'dA' });
  assert.deepEqual(out, { v: 1, turn_id: 'dA', status: 'unavailable', reason: 'removed', rule: 'disk-budget-bytes', note: retention('disk-budget-bytes').user_text });
});

test('the deletion lines are capped at 50 per check, then one summary line', async (t) => {
  const { root, paths } = project(t);
  for (let i = 0; i < 70; i++) put(paths.mirrorDiff(`d${String(i).padStart(3, '0')}`), 100, { ageMs: (100 - i) * HOUR });
  const store = fakeStore(paths);
  const h = sourceOn(t, { root, paths, store, limits: { DISK_BUDGET_BYTES: 1 }, convs: [{ id: 'C1', sessions: [{ session_id: S(1) }], ended_at: 1, process: null }] });
  await h.first();
  assert.equal(BUDGET_LOG_MAX, 50);
  const lines = h.budgetLines();
  assert.equal(lines.length, 51, '50 lines, then the summary');
  assert.equal(lines[0], '[mirror] budget: pruned snapshots older than 7.days.ago (0 B)');
  assert.equal(lines[4], '[mirror] budget: deleted diff d000.json (100 B)', 'oldest first');
  assert.match(lines[50], /deleted 0 index files \(0 B\), 0 node-diff caches \(0 B\), 70 diff records \(7000 B\), 0 node-linked diff records \(0 B\); pruned snapshots to 6\.hours\.ago \(0 B\); 24 more lines not logged$/);
  assert.deepEqual(fs.readdirSync(paths.mirrorDiffsDir), []);
});

test('a registry that lists nothing judges no index (no orphans), and nothing outside .web-chat/mirror/ or under a symlink is touched', async (t) => {
  const { root, paths } = project(t);
  const index = putIndex(paths, S(1), 5000, 1);
  const outside = put(path.join(root, 'keep.json'), 5000);
  fs.mkdirSync(paths.mirrorDiffsDir, { recursive: true });
  fs.symlinkSync(outside, paths.mirrorDiff('dLink'));
  const store = fakeStore(paths);
  const h = sourceOn(t, { root, paths, store, limits: { DISK_BUDGET_BYTES: 1000 }, convs: [] });
  await h.first();
  assert.ok(exists(index), 'not an orphan while the registry lists nothing');
  assert.ok(exists(outside));
  assert.ok(fs.lstatSync(paths.mirrorDiff('dLink')).isSymbolicLink(), 'a symlink is never followed or deleted');
  assert.equal(store.full(), true, 'still over');
});

// ── over after every tier; lifted; the cadence ──────────────────────────────

test('a set size the mirror cannot get under: recording off with shadow-store-full, restore answers its reason; `unlimited` turns it back on at the next check', async (t) => {
  const { root, paths } = project(t);
  writeMirrorSettings(paths, { disk_budget_bytes: 64 * MiB });
  // A live conversation's index, which the budget never deletes, over the budget.
  const live = put(paths.mirrorIndex(S(3)), 100 * MiB);
  const linked = put(paths.mirrorDiff('dL'), 10 * MiB, { ageMs: DAY });
  const store = fakeStore(paths);
  const graph = { nodes: new Map([['n1', { id: 'n1', mirror: { v: 1, turns: ['dL'] } }]]) };
  const h = sourceOn(t, { root, paths, store, graph, convs: [{ id: 'C3', sessions: [{ session_id: S(3) }], ended_at: null, process: { pid: 7 } }], unparsed: ['C3'] });
  await h.first();
  assert.ok(exists(live), 'a live conversation\'s index stays');
  assert.ok(!exists(linked), 'every tier ran: the node-linked diff went last');
  assert.equal(store.full(), true);
  assert.equal(h.state(), 'shadow-store-full');
  assert.match(h.budgetLines().at(-1), /still over: no more diffs are recorded \(shadow-store-full\)$/);
  assert.ok(h.logs.includes('codediff: off (shadow-store-full)'));

  // A fresh turn that ran a tool now reads unavailable with the reason.
  h.headers.set('tFull', { id: 'tFull', session_id: S(3), code: null });
  h.src.onTurnOpened({ id: 'tFull', conversation_id: 'C3', session_id: S(3), started_at: Date.now() });
  h.src.onTurnClosed({ id: 'tFull', conversation_id: 'C3', session_id: S(3), ended_at: Date.now(), counts: { tools: 1 } });
  assert.deepEqual(h.headers.get('tFull').code, { status: 'unavailable', reason: 'shadow-store-full' });

  // restore's features() answers its existing reason.
  const fakeRunGit = Object.assign(async () => ({ code: 0, stdout: '', stderr: '' }), {
    exclusive: (fn) => fn(fakeRunGit), features: async () => ({ missing: false, attrSource: true }),
  });
  const restore = createRestore({ root, paths, shadow: store, runGit: fakeRunGit });
  assert.deepEqual(await restore.features(), { ok: false, reason: 'shadow-store-full' });

  // The host lifts it: the next check reads the record again.
  writeMirrorSettings(paths, { disk_budget_bytes: null });
  await h.next();
  assert.equal(store.full(), false);
  assert.notEqual(h.state(), 'shadow-store-full');
  assert.ok(h.logs.includes('codediff: on again (the mirror is within its disk budget)'));
  assert.deepEqual(await restore.features(), { ok: true });
  assert.ok(exists(live));
});

test('the budget is checked again every BUDGET_CHECK_MS, reading the record each time; stop() clears the timer', async (t) => {
  const { root, paths } = project(t);
  assert.equal(LIMITS.BUDGET_CHECK_MS, 6 * HOUR, 'RULED R2 = a');
  const rec = put(paths.mirrorDiff('d1'), 100 * MiB, { ageMs: DAY });
  const store = fakeStore(paths);
  const h = sourceOn(t, { root, paths, store, convs: [{ id: 'C1', sessions: [{ session_id: S(1) }], ended_at: 1, process: null }] });
  await h.first();
  assert.ok(exists(rec), 'no budget yet');
  writeMirrorSettings(paths, { disk_budget_bytes: 64 * MiB });
  await h.next();
  assert.ok(!exists(rec), 'the record\'s size applied at the next check');
  assert.equal(h.budgetLines()[0], '[mirror] budget: pruned snapshots older than 7.days.ago (0 B)');
  const armed = h.timers.filter((x) => x.ms === LIMITS.BUDGET_CHECK_MS && !x.ran);
  assert.equal(armed.length, 1);
  await h.src.stop();
  assert.ok(h.cleared.includes(armed[0].id), 'stop() clears the armed check');
});

test('turnDiff: a ready turn whose record is gone names disk-budget-bytes only while a budget is set and its transcript is present', async (t) => {
  const { root, paths } = project(t);
  const ready = { status: 'ready', files: 1, additions: 1, deletions: 0 };
  const headers = new Map([['tR', { id: 'tR', session_id: S(1), code: ready }], ['tG', { id: 'tG', session_id: S(2), code: ready }]]);
  // S(2)'s transcript is gone (its project directory stays, the file does not).
  const slugDir = path.join(userClaudePaths().projectsDir, 'wc-u455-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  const transcriptPath = (sid) => (sid === S(2) ? path.join(slugDir, `${S(2)}.jsonl`) : null);
  const store = fakeStore(paths);
  const h = sourceOn(t, { root, paths, store, headers, transcriptPath });
  assert.deepEqual(await h.src.api.diff({ turn: 'tR' }), { v: 1, turn_id: 'tR', status: 'unavailable', reason: 'removed', rule: null, note: REMOVED_NOTE });
  writeMirrorSettings(paths, { disk_budget_bytes: GiB });
  assert.deepEqual(await h.src.api.diff({ turn: 'tR' }), {
    v: 1, turn_id: 'tR', status: 'unavailable', reason: 'removed', rule: 'disk-budget-bytes',
    note: 'The mirror\'s own files are kept without a size limit unless you set one with claude-web-chat mirror budget, and then the files it can rebuild go first and a diff linked to a graph node goes last.',
  });
  // A transcript Claude Code's cleanup deleted names that cleanup, budget or no budget.
  const gone = await h.src.api.diff({ turn: 'tG' });
  assert.equal(gone.status, 'unavailable');
  assert.equal(gone.rule, 'claude-code-cleanup', 'the cleanup, not the budget, removed it');
});

// ── a real shadow store: the stepped prune ──────────────────────────────────

test('on a real shadow store the stepped prune removes an old unreachable tree, keeps a fresh one and a tree a ref holds, and never expires under an hour', async (t) => {
  withTempHome(t);
  const repo = treesnapRepo(t, { files: { 'a.txt': 'one\n' } });
  const paths = projectPaths(repo.root);
  const calls = [];
  const runner = Object.assign(async (args, opts) => { calls.push(args); return runGit(args, opts); }, {
    exclusive: (fn) => runGit.exclusive(fn), features: () => runGit.features(),
  });
  const store = createShadowStore({ root: repo.root, paths, runGit: runner });
  repo.write('a.txt', 'two\n');
  const a = await store.snapshot();
  repo.write('a.txt', 'three\n');
  const b = await store.snapshot();
  assert.ok(a.ok && b.ok && a.tree !== b.tree);
  // Every loose object in the shadow two days old; tree A held by a ref.
  const objects = path.join(paths.mirrorGit, 'objects');
  const twoDays = (Date.now() - 2 * DAY) / 1000;
  for (const d of fs.readdirSync(objects)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of fs.readdirSync(path.join(objects, d))) fs.utimesSync(path.join(objects, d, f), twoDays, twoDays);
  }
  const shadowGit = (args) => runGit(args, { env: { GIT_DIR: paths.mirrorGit } });
  assert.equal((await shadowGit(['update-ref', 'refs/wc/safety/test-hold', a.tree])).code, 0);
  repo.write('a.txt', 'four\n');
  const c = await store.snapshot(); // fresh: under every step
  assert.ok(c.ok);

  const h = sourceOn(t, { root: repo.root, paths, store, limits: { DISK_BUDGET_BYTES: 1 }, convs: [{ id: 'C1', sessions: [{ session_id: S(1) }], ended_at: 1, process: null }] });
  await h.first();
  const prunes = calls.filter((c) => c[0] === 'prune').map((c) => c[1]);
  assert.deepEqual(prunes, ['--expire=7.days.ago', '--expire=7.days.ago', '--expire=3.days.ago', '--expire=1.days.ago', '--expire=6.hours.ago'], 'housekeeping\'s, then the budget\'s steps');
  const has = async (id) => (await shadowGit(['cat-file', '-e', `${id}^{tree}`])).code === 0;
  assert.equal(await has(a.tree), true, 'a tree a ref holds is never pruned');
  assert.equal(await has(b.tree), false, 'an old unreachable tree is pruned');
  assert.equal(await has(c.tree), true, 'a fresh unreachable tree is kept (never an expiry under an hour)');
  assert.equal(store.full(), true, 'a 1-byte budget stays exceeded');
});

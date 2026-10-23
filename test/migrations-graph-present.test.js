const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { run, SCHEMA_VERSION } = require('../lib/update/migrations');
const { projectPaths } = require('../lib/core/paths');
const { withServer, commentBody } = require('../test-support/helpers');

// A graph present at first touch is a v3 project (U246, ruling H2 (a)): a
// .web-chat/ with no _version.json whose graph directory holds any non-dot entry
// (a lost version file, a hand-copied .web-chat/) is migrated from v3, not
// stamped current; only an empty or absent graph directory is a new project.

// A stateDir must be named `.web-chat` under a root, as test/migrations.test.js
// builds it: the runner mints its paths from projectPaths(dirname(stateDir)).
function tmpState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mig-gp-'));
  const stateDir = path.join(root, '.web-chat');
  fs.mkdirSync(stateDir, { recursive: true });
  const p = projectPaths(root);
  return { root, stateDir, versionFile: p.version, graphDir: p.graphDir, themeDefault: p.themeDefault };
}
const readVersion = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).version;

function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { return { out: fn(), warned: () => out }; } finally { process.stderr.write = orig; }
}

// Steps that record which ran: an injected 3 (the v3→v4 slot) and a 1 and 2 that
// must never run for a graph-present project.
function recorder({ daemonOnly = false } = {}) {
  const ran = [];
  const step3 = Object.assign(() => { ran.push(3); }, daemonOnly ? { daemonOnly: true, what: 'test step' } : {});
  return { ran, steps: { 1: () => { ran.push(1); }, 2: () => { ran.push(2); }, 3: step3 } };
}

function seedGraph(graphDir, names) {
  fs.mkdirSync(graphDir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(graphDir, n), '{}');
}

// ── the runner ──────────────────────────────────────────────────────────────

for (const [label, names] of [
  ['graph/n0.json', ['n0.json']],
  ['graph/_meta.json alone', ['_meta.json']],
  ['an aside alone (n3.json.corrupt-1)', ['n3.json.corrupt-1']],
]) {
  test(`${label} with no _version.json is a v3 project: step 3 runs, stamped 4, no new-project look, one line`, () => {
    const { stateDir, versionFile, graphDir, themeDefault } = tmpState();
    seedGraph(graphDir, names);
    const { ran, steps } = recorder();
    const r = captureStderr(() => run(stateDir, { steps, target: 4 }));
    assert.deepEqual(r.out, { ok: true, version: 4 });
    assert.deepEqual(ran, [3], 'only the v3→v4 step ran');
    assert.equal(readVersion(versionFile), 4);
    assert.ok(!fs.existsSync(themeDefault), 'a project with a graph is not new: no theme-default.json');
    const lines = r.warned().split('\n').filter((l) => /holds a graph/.test(l));
    assert.equal(lines.length, 1, r.warned());
    assert.match(lines[0], /holds a graph but no _version\.json; treating it as v3 and migrating\./);
    assert.ok(lines[0].includes(stateDir), 'the line names the stateDir');
  });
}

test('the real runner: a graph present with no _version.json migrates to SCHEMA_VERSION without the new-project look', () => {
  const { stateDir, versionFile, graphDir, themeDefault } = tmpState();
  seedGraph(graphDir, ['_meta.json']);
  const r = captureStderr(() => run(stateDir));
  assert.deepEqual(r.out, { ok: true, version: SCHEMA_VERSION });
  assert.equal(readVersion(versionFile), SCHEMA_VERSION);
  assert.ok(!fs.existsSync(themeDefault));
  assert.match(r.warned(), /treating it as v3/);
});

for (const [label, make] of [
  ['an empty graph/ (as ensureProjectDirs leaves it)', (g) => fs.mkdirSync(g, { recursive: true })],
  ['an absent graph/', () => {}],
  ['a graph/ holding only .DS_Store', (g) => seedGraph(g, ['.DS_Store'])],
]) {
  test(`${label} is a first touch as before: SCHEMA_VERSION stamped, theme-default.json seeded, no step run`, () => {
    const { stateDir, versionFile, graphDir, themeDefault } = tmpState();
    make(graphDir);
    const { ran, steps } = recorder();
    const r = captureStderr(() => run(stateDir, { steps }));
    assert.deepEqual(r.out, { ok: true, version: SCHEMA_VERSION });
    assert.deepEqual(ran, []);
    assert.equal(readVersion(versionFile), SCHEMA_VERSION);
    assert.ok(fs.existsSync(themeDefault), 'a new project gets the new-project look');
    assert.equal(r.warned(), '', 'a fresh project warns about nothing');
  });
}

test('outside the daemon a graph-present project defers at v3 with nothing stamped; the daemon migrates it next', () => {
  const { stateDir, versionFile, graphDir, themeDefault } = tmpState();
  seedGraph(graphDir, ['n0.json', '_meta.json']);
  const { ran, steps } = recorder({ daemonOnly: true });
  const r = captureStderr(() => run(stateDir, { steps, target: 4, context: 'install' }));
  assert.deepEqual(r.out, { deferred: 3 });
  assert.deepEqual(ran, []);
  assert.ok(!fs.existsSync(versionFile), 'no _version.json written');
  assert.ok(!fs.existsSync(themeDefault), 'no theme-default.json written');
  assert.match(r.warned(), /v3→v4 test step runs in the daemon at its next boot/);
  // The daemon sees the same state at its next boot and migrates it.
  const d = captureStderr(() => run(stateDir, { steps, target: 4 }));
  assert.deepEqual(d.out, { ok: true, version: 4 });
  assert.deepEqual(ran, [3]);
  assert.equal(readVersion(versionFile), 4);
  assert.ok(!fs.existsSync(themeDefault));
});

for (const target of [3, 2]) {
  test(`an injected target ${target} with a graph present: {ok, version: ${target}}, stamped, no step run, no seed`, () => {
    const { stateDir, versionFile, graphDir, themeDefault } = tmpState();
    seedGraph(graphDir, ['n0.json']);
    const { ran, steps } = recorder();
    const r = captureStderr(() => run(stateDir, { steps, target }));
    assert.deepEqual(r.out, { ok: true, version: target });
    assert.deepEqual(ran, []);
    assert.equal(readVersion(versionFile), target);
    assert.ok(!fs.existsSync(themeDefault));
  });
}

// An unreadable graph directory counts as present (the safe side is to migrate,
// as the torn-version branch reasons): never the new-project look.
test('an unreadable graph/ counts as present: migrated as v3, no new-project look', { skip: process.getuid && process.getuid() === 0 ? 'root reads a 000 directory' : false }, (t) => {
  const { stateDir, versionFile, graphDir, themeDefault } = tmpState();
  seedGraph(graphDir, []);
  fs.chmodSync(graphDir, 0o000);
  t.after(() => fs.chmodSync(graphDir, 0o755));
  const { ran, steps } = recorder();
  const r = captureStderr(() => run(stateDir, { steps, target: 4 }));
  assert.deepEqual(r.out, { ok: true, version: 4 });
  assert.deepEqual(ran, [3]);
  assert.equal(readVersion(versionFile), 4);
  assert.ok(!fs.existsSync(themeDefault));
});

// ── end to end: the F6 ids seeds (G-9), with no _version.json ───────────────

// A minimal valid node file (passes isGraphNode), the F6 harness's synthNode shape.
const node = (id, parent_id, created_at, comments) => ({
  id, parent_id, created_at, author: 'claude',
  trigger: { kind: 'turn', message: 'synthetic', summary: 'synthetic' },
  mounts: [], store: {}, comments, captures: [],
});
const pin = (n) => ({ id: 'c' + n, seq: n, created_at: 1700000000000 + n, shared: true, text: 'p' + n, anchor: null });
const pins = (k) => Array.from({ length: k }, (_, i) => pin(i + 1));

function migrationRecord(root) {
  const file = projectPaths(root).elementsLog;
  const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return recs.find((r) => r && r.t === 'migration') || null;
}

async function bootAndMint(t, seed) {
  let stderr = '';
  const orig = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { stderr += chunk; return orig.call(this, chunk, ...rest); };
  let s;
  try { s = await withServer(t, { seed }); } finally { process.stderr.write = orig; }
  const r = await s.api.post('/api/elements', commentBody({ text: 'new' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { s, id: r.json.pin.id, stderr };
}

test('e2e: ids.js\'s node-copy seed, no _version.json, n2.json torn after its pins → migrated, mints c7', async (t) => {
  const seed = ({ webChatDir }) => {
    const g = path.join(webChatDir, 'graph');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'n0.json'), JSON.stringify(node('n0', null, 1700000001000, pins(2))));
    fs.writeFileSync(path.join(g, 'n1.json'), JSON.stringify(node('n1', 'n0', 1700000002000, pins(3))));
    const n2 = JSON.stringify(node('n2', 'n1', 1700000003000, pins(6)));
    const cut = n2.indexOf('"seq":6') + '"seq":6'.length + 1; // torn AFTER its pins' seqs
    fs.writeFileSync(path.join(g, 'n2.json'), n2.slice(0, cut));
    fs.writeFileSync(path.join(g, '_meta.json'), JSON.stringify({ active: 'n1' }));
  };
  const { s, id, stderr } = await bootAndMint(t, seed);
  assert.ok(!['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].includes(id), `minted ${id}, an id a copy held`);
  assert.equal(id, 'c7');
  assert.match(stderr, /holds a graph but no _version\.json; treating it as v3/);
  assert.equal(readVersion(projectPaths(s.root).version), SCHEMA_VERSION, 'migrated to 4');
  assert.ok(!fs.existsSync(projectPaths(s.root).themeDefault), 'no new-project look');
  const rec = migrationRecord(s.root);
  assert.ok(rec, 'the v3→v4 migration record is in the log');
  assert.ok(rec.seq_floor >= 6, `seq_floor ${rec.seq_floor} covers the torn copy's seqs`);
});

test('e2e: ids.js\'s draft-copy seed (stale draft c1-c3, base_active n9), no _version.json → mints c4', async (t) => {
  const seed = ({ webChatDir }) => {
    const g = path.join(webChatDir, 'graph');
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, 'n0.json'), JSON.stringify(node('n0', null, 1700000001000, pins(1))));
    fs.writeFileSync(path.join(g, '_meta.json'), JSON.stringify({ active: 'n0' }));
    fs.writeFileSync(path.join(webChatDir, 'draft.json'), JSON.stringify({
      schema_version: 1, saved_at: 1, base_active: 'n9', mounts: [], markdown: [], order: [], store: {},
      comments: pins(3), captures: [], queue: [],
    }));
  };
  const { s, id } = await bootAndMint(t, seed);
  assert.equal(readVersion(projectPaths(s.root).version), SCHEMA_VERSION);
  assert.ok(!['c1', 'c2', 'c3'].includes(id), `minted ${id}, an id the draft held`);
  assert.equal(id, 'c4');
});

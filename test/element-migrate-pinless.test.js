// A commit record for every node (U351; plan 2E.1; alpha.1 finding A-1): the
// v3→v4 migration writes one for a PINLESS node too — a node whose `comments`
// is empty or absent — so a project's first boot after the upgrade reads clean
// (no node-without-commit-record, no integrity event, graph_integrity clean).
// The fixture is test-support/v3-graph.js's fixed graph with `pinless: 3`
// (n7 with `comments: []`, n8 and n10 with no `comments` key, children of n4).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { v3Graph } = require('../test-support/v3-graph');
const { withServer } = require('../test-support/helpers');
const { migrateComments, planMigration, readProject, playActions } = require('../lib/core/element-migrate');
const { createElementLog } = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');

const BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat.js');
const CLOCK = () => 1760000100000;
const PINLESS = ['n7', 'n8', 'n10'];

function tmp(t, prefix = 'wc-v3-pinless-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  return root;
}
const fixture = (t, opts) => v3Graph(tmp(t), opts);

function records(paths) {
  let text = '';
  try { text = fs.readFileSync(paths.elementsLog, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const version = (paths) => JSON.parse(fs.readFileSync(paths.version, 'utf8')).version;
const nodeIds = (paths) => fs.readdirSync(paths.graphDir).filter((f) => /^n\d+\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();

function plan(t, g) {
  const log = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor(), dryRun: true });
  t.after(() => log.close());
  log.load();
  const project = readProject(g.stateDir);
  return planMigration({ nodes: project.nodes, meta: project.meta, draft: project.draft, log, asides: project.asides });
}

function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (st.isDirectory()) { out.push(`${rel}/`); walk(full); } else {
        out.push(`${rel} ${st.size} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return out;
}

// A v3 project whose nodes carry no copy at all, and no draft.
function pinlessProject(t, count = 4) {
  const root = tmp(t, 'wc-v3-nopins-');
  const paths = projectPaths(root);
  fs.mkdirSync(paths.graphDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const n = { id: `n${i}`, parent_id: i === 1 ? null : `n${i - 1}`, created_at: 1760000000000 + i * 1000, author: 'claude', trigger: { kind: 'turn', message: '', summary: '' }, mounts: [], store: {}, captures: [] };
    if (i % 2) n.comments = [];
    fs.writeFileSync(path.join(paths.graphDir, `n${i}.json`), JSON.stringify(n));
  }
  fs.writeFileSync(paths.meta, JSON.stringify({ active: `n${count}`, lock: null }));
  fs.writeFileSync(paths.version, JSON.stringify({ version: 3 }));
  return { root, stateDir: paths.dir, paths };
}

test('the fixture: pinless 0 is the default graph; pinless 3 appends n7, n8, n10 under n4', (t) => {
  const a = fixture(t);
  const b = fixture(t, { pinless: 0 });
  assert.deepEqual(b.nodes, a.nodes);
  const g = fixture(t, { pinless: 3 });
  assert.deepEqual(g.nodes.slice(0, 6), a.nodes);
  assert.deepEqual(g.nodes.slice(6).map((n) => [n.id, n.parent_id]), PINLESS.map((id) => [id, 'n4']));
  assert.deepEqual(g.nodes[6].comments, []);
  assert.equal('comments' in g.nodes[7], false);
  assert.equal('comments' in g.nodes[8], false);
  assert.equal(g.active, 'n6');
  assert.equal(g.draft.base_active, 'n6');
  assert.deepEqual(g.cases, a.cases);
});

test('planMigration plans an empty commit record for each pinless node beside the pinned ones', (t) => {
  const base = plan(t, fixture(t));
  const p = plan(t, fixture(t, { pinless: 3 }));
  const commits = p.actions.filter((a) => a.op === 'commit');
  const empty = commits.filter((a) => a.pins.length === 0).map((a) => a.node.id).sort();
  assert.deepEqual(empty, [...PINLESS].sort());
  assert.equal(commits.length, base.counters.commits_new + 3);
  assert.equal(p.counters.commits_new, base.counters.commits_new + 3, 'pinned + 3');
  assert.equal(p.nodes, base.nodes, 'plan.nodes still counts the pin-carrying nodes');
  assert.equal(p.graph_nodes, base.graph_nodes + 3);
  assert.deepEqual(Object.keys(p).sort(), Object.keys(base).sort(), 'no key added to the plan');
  assert.equal(p.detail.pins.size, base.detail.pins.size, 'detail.pins keeps meaning pin-carrying nodes');
  const mig = p.actions.find((a) => a.op === 'migration');
  assert.deepEqual(Object.keys(mig).sort(), Object.keys(base.actions.find((a) => a.op === 'migration')).sort());
  assert.equal(mig.nodes, base.nodes);

  const r = migrateComments(fixture(t, { pinless: 3 }).stateDir, { dryRun: true, now: CLOCK });
  assert.equal(r.dry_run, true);
  assert.equal(r.report.pinless_nodes, 3);
  assert.equal(r.report.nodes, base.nodes);
});

test('a v3 project whose nodes carry no copy and no draft gets a commit record per node and the migration record', (t) => {
  const g = pinlessProject(t, 4);
  const r = migrateComments(g.stateDir, { now: CLOCK, bootId: 'b1' });
  assert.equal(r.ok, true);
  assert.equal(r.migrated, true, 'no longer `empty`');
  assert.equal(r.empty, undefined);
  assert.equal(r.report.pinless_nodes, 4);
  const recs = records(g.paths);
  const commits = recs.filter((x) => x.t === 'commit');
  assert.deepEqual(commits.map((x) => x.node).sort(), nodeIds(g.paths));
  for (const c of commits) assert.deepEqual(c.pins, []);
  assert.equal(recs.filter((x) => x.t === 'migration').length, 1);

  const before = size(g.paths.elementsLog);
  const again = migrateComments(g.stateDir, { now: CLOCK, bootId: 'b2' });
  assert.equal(again.already, true);
  assert.equal(size(g.paths.elementsLog), before, 'a rerun appends 0 bytes');
});

test('a project with no graph files still writes nothing', (t) => {
  const root = tmp(t, 'wc-v3-nofiles-');
  const stateDir = path.join(root, '.web-chat');
  fs.mkdirSync(stateDir);
  const r = migrateComments(stateDir, { now: CLOCK });
  assert.equal(r.empty, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'elements')), false);
});

test('crash idempotence: a log holding some pinless nodes\' records gets only the missing ones', (t) => {
  const g = pinlessProject(t, 6);
  // The first run, cut short: half its commit actions played into a real open.
  const dry = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor(), dryRun: true });
  dry.load();
  const project = readProject(g.stateDir);
  const p = planMigration({ nodes: project.nodes, meta: project.meta, draft: project.draft, log: dry, asides: project.asides });
  dry.close();
  const half = p.actions.filter((a) => a.op === 'commit').slice(0, 3);
  const real = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor(), bootId: 'crash', now: CLOCK });
  real.load();
  playActions(real, { actions: half });
  real.close();
  const before = records(g.paths).filter((x) => x.t === 'commit').length;
  assert.equal(before, 3);

  const r = migrateComments(g.stateDir, { now: CLOCK, bootId: 'b2' });
  assert.equal(r.migrated, true);
  assert.equal(r.report.counters.commits_present, 3);
  assert.equal(r.report.counters.commits_new, 3);
  assert.equal(r.report.pinless_nodes, 3);
  const commits = records(g.paths).filter((x) => x.t === 'commit');
  assert.equal(commits.length, 6, 'one per node, none twice');
  assert.deepEqual(commits.map((x) => x.node).sort(), nodeIds(g.paths));
  assert.equal(records(g.paths).filter((x) => x.t === 'migration').length, 1);
});

test('claude-web-chat migrate names the pinless commit records and writes nothing', (t) => {
  const g = fixture(t, { pinless: 3 });
  const before = listing(g.root);
  const r = spawnSync(process.execPath, [BIN, 'migrate'], {
    cwd: g.root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nodes\s+9 in the graph, 6 carrying pins, 3 pinless, a commit record each/);
  assert.deepEqual(listing(g.root), before, 'nothing written');
  assert.equal(version(g.paths), 3);
  assert.equal(fs.existsSync(g.paths.elementsDir), false, 'no .web-chat/elements/');
});

test('the first boot of a v3 project with pinless nodes reads clean', async (t) => {
  const g = fixture(t, { pinless: 3 });
  const ctx = await withServer(t, { root: g.root });
  assert.equal(version(g.paths), 4);
  const commits = records(g.paths).filter((x) => x.t === 'commit');
  const ids = nodeIds(g.paths);
  for (const id of ids) assert.equal(commits.filter((c) => c.node === id).length, 1, `${id}: one commit record`);
  for (const id of PINLESS) assert.deepEqual(commits.find((c) => c.node === id).pins, []);
  const report = JSON.parse(fs.readFileSync(g.paths.elementsBootReport, 'utf8'));
  assert.equal(report.clean, true, JSON.stringify(report.states));
  assert.equal('node-without-commit-record' in report.states, false);
  const health = (await ctx.api.get('/api/health')).json;
  assert.equal(health.graph_integrity.clean, true, JSON.stringify(health.graph_integrity));
  assert.equal(ctx.srv.bus.read({ since: 0, kinds: ['integrity'] }).events.length, 0, 'no integrity event');
});

test('crash after every pinless record: the rerun appends only the migration record, then answers already', (t) => {
  const g = pinlessProject(t, 4);
  // The first run, cut short after its last commit record and before the
  // migration record: no action is left but the migration record itself.
  const real = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor(), bootId: 'crash', now: CLOCK });
  real.load();
  for (const id of nodeIds(g.paths)) real.appendCommit({ node: { id }, pins: [] });
  real.close();

  const r = migrateComments(g.stateDir, { now: CLOCK, bootId: 'b2' });
  assert.equal(r.migrated, true, 'not `empty`: the migration record is still owed');
  assert.equal(r.report.counters.commits_new, 0);
  assert.equal(r.report.counters.commits_present, 4);
  assert.equal(r.report.pinless_nodes, 0);
  assert.equal(records(g.paths).filter((x) => x.t === 'commit').length, 4, 'none written twice');
  assert.equal(records(g.paths).filter((x) => x.t === 'migration').length, 1);
  const before = size(g.paths.elementsLog);
  assert.equal(migrateComments(g.stateDir, { now: CLOCK, bootId: 'b3' }).already, true);
  assert.equal(size(g.paths.elementsLog), before);
});

test('a pinless node whose logged record names pins gets an empty record: only the same pins count as present', (t) => {
  const g = pinlessProject(t, 2);
  const real = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor(), bootId: 'seed', now: CLOCK });
  real.load();
  real.appendCommit({ node: { id: 'n1' }, pins: ['c9@1'] });
  real.appendCommit({ node: { id: 'n2' }, pins: [] });
  real.close();
  const dry = createElementLog({ file: g.paths.elementsLog, redactor: createRedactor(), dryRun: true });
  t.after(() => dry.close());
  dry.load();
  const project = readProject(g.stateDir);
  const p = planMigration({ nodes: project.nodes, meta: project.meta, draft: project.draft, log: dry, asides: project.asides });
  assert.deepEqual(p.actions.filter((a) => a.op === 'commit').map((a) => [a.node.id, a.pins]), [['n1', []]]);
  assert.equal(p.counters.commits_new, 1);
  assert.equal(p.counters.commits_present, 1, 'n2\'s empty record');
});

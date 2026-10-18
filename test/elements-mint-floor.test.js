// The mint's floor from the boot reconcile's node asides (GT-10, ruling K1;
// PLAN 1A.2, 1A.3; U247).
//
// A node file that does not read is set aside by graph.load
// (n<K>.json.corrupt-<ts>) and reported by the boot reconcile, but the pins it
// held are in no log record when the log never saw them (copies a 0.8.5 daemon
// wrote during a rollback, or a v3 project's node first torn after its
// migration). The reconcile reads every node aside on disk — this boot's and an
// earlier boot's — with the one tolerant scanner (element-log maxElementSeqIn)
// and reserves past the highest id or seq the bytes still show, so the mint
// never hands out an id the torn file holds. The report names the floor
// (mint_floor) and each aside's scan (max_seq).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { withServer, existingProject } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const { createElementLog, maxElementSeqIn } = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { reconcileElements, mintFloorOf, REPORT_NAME } = require('../lib/server/domain/elements-reconcile');

const ANCHOR = { mount: 'm1', selector: 'p.lead', text: 'Hello', ordinal: 0 };
const T0 = 1760000000000;

const graphDir = (root) => projectPaths(root).graphDir;
const bootReport = (root) => JSON.parse(fs.readFileSync(projectPaths(root).elementsBootReport, 'utf8'));
const idNum = (id) => Number(String(id).slice(1));

async function ok(p, what) {
  const r = await p;
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text}`);
  return r.json;
}
async function turn(api, message = 'turn') {
  await ok(api.post('/api/turn-begin', { message }), 'turn-begin');
  return ok(api.post('/api/turn-end', { summary: message }), 'turn-end');
}
const addPin = async (api, text) => (await ok(api.post('/api/comments', { text, anchor: ANCHOR }), `add ${text}`)).pin;

const pin = (n) => ({
  id: `c${n}`, seq: n, created_at: T0 + n, shared: true, text: `pin ${n}`, anchor: ANCHOR, replies: [],
});
function nodeOf(id, parent, comments, i = 9) {
  return {
    id, parent_id: parent, created_at: T0 + i * 1000, author: 'claude',
    trigger: { kind: 'turn', message: `turn ${i}`, summary: `turn ${i}` },
    mounts: [{ id: 'm1', html: '<p class="lead">Hello</p>', owner: 'claude' }],
    store: {}, comments, captures: [],
  };
}
// A node file's bytes cut AFTER its pins (they still show "seq":6) or BEFORE
// them (no pin, seq or element id at all).
function tornBytes(node, where) {
  const text = JSON.stringify(node);
  const at = where === 'after' ? text.indexOf(',"captures"') : text.indexOf('"comments"');
  assert.ok(at > 0, 'the cut point is in the file');
  return text.slice(0, at);
}

// ── the scanner ─────────────────────────────────────────────────────────────

test('maxElementSeqIn: the highest seq or element id in torn bytes, never a parse', () => {
  const full = JSON.stringify(nodeOf('n9', 'n1', [pin(4), pin(5), pin(6)]));
  const midPin = full.slice(0, full.indexOf('"id":"c6"') + '"id":"c6"'.length);
  assert.equal(maxElementSeqIn(midPin), 6, 'cut mid-pin, after c6\'s id and before its seq');
  assert.equal(maxElementSeqIn(full.slice(0, full.indexOf('"id":"c6"'))), 5, 'cut before c6');
  assert.equal(maxElementSeqIn('{"comments":[{"id":"c9"'), 9, 'an id with no seq');
  assert.equal(maxElementSeqIn('{"comments":[{"seq": 12,'), 12, 'whitespace after the colon');
  assert.equal(maxElementSeqIn('{"id": "c31", "seq":\n 30'), 31, 'whitespace in both forms; the max wins');
  assert.equal(maxElementSeqIn('{"id":"n9","trunc'), 0, 'a node id is not an element id');
  assert.equal(maxElementSeqIn('{"id":"c12x","seq":"7"'), 0, 'neither an id that is not c<n> nor a string seq');
  assert.equal(maxElementSeqIn(''), 0);
  assert.equal(maxElementSeqIn(null), 0);
  assert.equal(maxElementSeqIn(`{"seq":${Number.MAX_SAFE_INTEGER + 2},"id":"c99999999999999999","seq":8`), 8,
    'a value past MAX_SAFE_INTEGER is ignored');
});

test('maxElementSeqIn is the one scanner: no second "seq" regex in the log, the migration or the reconcile', () => {
  const lib = path.join(__dirname, '..', 'lib');
  for (const rel of ['core/element-log.js', 'core/element-migrate.js', 'server/domain/elements-reconcile.js']) {
    const src = fs.readFileSync(path.join(lib, rel), 'utf8');
    const regexes = src.match(/\/"seq":[^/\n]*\/g?/g) || [];
    assert.equal(regexes.length, rel === 'core/element-log.js' ? 1 : 0, `${rel}: ${regexes.join(' ')}`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(lib, 'core/element-log.js'), 'utf8'), /TORN_SEQ_RE/);
  assert.doesNotMatch(fs.readFileSync(path.join(lib, 'core/element-migrate.js'), 'utf8'), /\bSEQ_RE\b/);
});

// ── the reconcile, unit ─────────────────────────────────────────────────────

for (const refused of [false, true]) {
  test(`floorFromAsides runs in the ${refused ? 'migration-refused' : 'normal'} branch: the log reserves past the aside, the report names it`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mint-floor-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const gdir = path.join(dir, 'graph');
    fs.mkdirSync(gdir);
    const thisBoot = 'n9.json.corrupt-1760000000000';
    const earlier = 'n4.json.corrupt-1750000000000';
    fs.writeFileSync(path.join(gdir, thisBoot), tornBytes(nodeOf('n9', 'n1', [pin(4), pin(5), pin(6)]), 'after'));
    fs.writeFileSync(path.join(gdir, earlier), '{"id":"n4","comments":[{"id":"c3","seq":3');
    const log = createElementLog({ file: path.join(dir, 'log.jsonl'), redactor: createRedactor() });
    log.load();
    t.after(() => log.close());
    const graph = {
      nodes: new Map(), topology: new Map(), nextSeq: 10, active: null, lastNode: null,
      loadReport: { nodes_aside: [{ file: 'n9.json', aside: thisBoot, why: 'torn' }], meta_aside: null },
    };
    const store = { log, stats: () => log.stats() };
    const report = reconcileElements({ graph, store, paths: { GRAPH_DIR: gdir }, migration: refused ? { refused: true } : null });
    assert.deepEqual(report.mint_floor, { seq: 6, files: [earlier, thisBoot].sort() });
    assert.equal(mintFloorOf(report), 6);
    assert.equal(log.nextSeq(), 7, 'the log\'s own reservation');
    assert.equal(log.mintId(), 'c7');
    if (!refused) {
      assert.deepEqual(report.states['commit-record-without-node'].detail,
        [{ node: 'n9', aside: thisBoot, record: false, max_seq: 6 }]);
    }
  });
}

test('mintFloorOf: a report an older boot wrote (no mint_floor) reads as 0', () => {
  assert.equal(mintFloorOf({ at: 1, clean: true, states: {} }), 0);
  assert.equal(mintFloorOf(null), 0);
  assert.equal(mintFloorOf({ mint_floor: { seq: 0, files: [] } }), 0);
  assert.equal(mintFloorOf({ mint_floor: { seq: 6, files: ['n9.json.corrupt-1'] } }), 6);
});

// ── end to end ──────────────────────────────────────────────────────────────

// A v4 project with c1-c3 in the log and committed on its active node, stopped;
// then a node file n9.json holding c4-c6 (copies the log never saw), torn
// `where`. Returns {root, active}.
async function seedTorn(t, where) {
  const s1 = await withServer(t, { seed: existingProject });
  await ok(s1.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello</p>' }), 'render');
  const ids = [];
  for (const text of ['one', 'two', 'three']) ids.push((await addPin(s1.api, text)).id);
  assert.deepEqual(ids, ['c1', 'c2', 'c3']);
  const active = (await turn(s1.api, 'pins')).node_id;
  await s1.stop();
  fs.writeFileSync(path.join(graphDir(s1.root), 'n9.json'), tornBytes(nodeOf('n9', active, [pin(4), pin(5), pin(6)]), where));
  return { root: s1.root, active };
}

test('a node file holding c4-c6 torn after its pins: the reboot mints c7, never c4; the report names the aside\'s max_seq and the floor', async (t) => {
  const { root } = await seedTorn(t, 'after');

  const s2 = await withServer(t, { root });
  const report = bootReport(root);
  const orphan = report.states['commit-record-without-node'];
  assert.ok(orphan, JSON.stringify(report.states));
  assert.equal(orphan.count, 1);
  assert.match(orphan.examples[0], /^n9\.json\.corrupt-/);
  assert.deepEqual(orphan.detail, [{ node: 'n9', aside: orphan.examples[0], record: false, max_seq: 6 }]);
  assert.deepEqual(report.mint_floor, { seq: 6, files: [orphan.examples[0]] });
  const health = (await s2.api.get('/api/health')).json;
  assert.deepEqual(health.graph_integrity, { clean: false, states: { 'commit-record-without-node': 1 }, report: REPORT_NAME },
    'graph_integrity unchanged in shape');

  const next = await addPin(s2.api, 'after the tear');
  assert.equal(next.id, 'c7', 'the torn file\'s c4-c6 are never minted again');
  assert.equal(next.seq, 7);
  await s2.stop();

  // A later boot: the aside is an earlier boot's now. The floor still holds.
  const s3 = await withServer(t, { root });
  const later = bootReport(root);
  assert.deepEqual(later.mint_floor, { seq: 6, files: [orphan.examples[0]] });
  const again = await addPin(s3.api, 'a later boot');
  assert.ok(idNum(again.id) > 7, `${again.id} is above c7`);
});

test('the floor from an EARLIER boot\'s aside alone: a boot that minted nothing, then a reboot, still mints c7', async (t) => {
  const { root } = await seedTorn(t, 'after');
  const s2 = await withServer(t, { root }); // sets n9.json aside; mints nothing
  await s2.stop();
  assert.equal(fs.existsSync(path.join(graphDir(root), 'n9.json')), false);

  const s3 = await withServer(t, { root });
  const report = bootReport(root);
  assert.equal(report.mint_floor.seq, 6);
  assert.equal(report.mint_floor.files.length, 1);
  assert.match(report.mint_floor.files[0], /^n9\.json\.corrupt-/);
  assert.equal((await addPin(s3.api, 'two boots later')).id, 'c7');
});

test('the same file torn BEFORE its pins: no floor from it, and the mint continues from the log\'s max', async (t) => {
  const { root } = await seedTorn(t, 'before');
  const s2 = await withServer(t, { root });
  const report = bootReport(root);
  assert.deepEqual(report.mint_floor, { seq: 0, files: [] });
  assert.equal(report.states['commit-record-without-node'].detail[0].max_seq, 0);
  assert.equal((await addPin(s2.api, 'no false floor')).id, 'c4');
});

test('a v3 project whose n2 is torn after its pins migrates with seq_floor 6 and mints c7', async (t) => {
  const s = await withServer(t, {
    seed: ({ webChatDir }) => {
      fs.writeFileSync(path.join(webChatDir, '_version.json'), JSON.stringify({ version: 3 }) + '\n');
      const g = path.join(webChatDir, 'graph');
      fs.mkdirSync(g, { recursive: true });
      fs.writeFileSync(path.join(g, 'n1.json'), JSON.stringify(nodeOf('n1', null, [pin(1), pin(2), pin(3)], 1)));
      fs.writeFileSync(path.join(g, 'n2.json'), tornBytes(nodeOf('n2', 'n1', [pin(1), pin(2), pin(3), pin(4), pin(5), pin(6)], 2), 'after'));
      fs.writeFileSync(path.join(g, '_meta.json'), JSON.stringify({ active: 'n1' }));
    },
  });
  const records = fs.readFileSync(projectPaths(s.root).elementsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const migration = records.find((r) => r.t === 'migration');
  assert.ok(migration, 'the migration ran');
  assert.equal(migration.seq_floor, 6, 'the migration read the torn n2\'s seqs');
  const report = bootReport(s.root);
  assert.equal(report.mint_floor.seq, 6, 'and the reconcile reads its aside');
  assert.equal((await addPin(s.api, 'after the migration')).id, 'c7');
});

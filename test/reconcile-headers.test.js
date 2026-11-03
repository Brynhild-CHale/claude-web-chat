// The reconcile reads headers (PLAN §5 4G.3, part 2; U574; GT-10, GT-12).
//
// The boot reconcile (lib/server/domain/elements-reconcile) runs before the
// listen. Before this unit its compareNodes read every node's `comments` —
// through copiesOf and element-log nodeDigest — and so faulted every lazy body
// U573 built from the graph index. It now takes each node's digest and its
// copy-v check from the index header (graph.headerOf's pins, nodeDigest's own
// inputs), and reads a body only where a copy's CONTENT is needed: an unclean
// node, a record pin whose version the log lacks, a node with no commit record
// (adopt), or a header whose pins are null. findCapture skips a committed node
// whose header's capture_ids do not list the id. This file pins:
//
//   * THE PROOF: a boot over the index reads no body before the listen but the
//     active node's (restoreLiveToNode), and the after-listen work (the index
//     flush, the mirror's start) reads none either;
//   * an unclean node the index cannot see (its record pins a version the log
//     lost) is the one body the reconcile reads, and it is reported as a full
//     read reports it;
//   * GT-10 unchanged: the boot report (less its time, boot id and timings) of
//     a boot over the index deep-equals that of the same files booted with the
//     index deleted — clean, dangling-commit-record, copy-v-mismatch, an
//     adopt, a header whose pins are null, a missing pin version;
//   * the stand-in digest equals the whole node's for every fixture node;
//   * inspect_capture's route answers a capture committed on an old node as
//     before, and reads only the first node whose capture_ids list it.
//
// The fixture is ONE daemon life committing 40 nodes through the daemon's own
// routes (panes, markdown, comment pins and replies, captures, a wipe, a
// deleted pin), stopped gracefully; the graph index is then built over its
// files (a running daemon indexes after the listen only the nodes it found at
// boot — RULED U572-U573@index-cadence-and-refusal — so the index of this life's
// commits is the next boot's), and every test boots a copy of that root.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, waitUntil, commentBody } = require('../test-support/helpers');
const { projectPaths } = require('../lib/core/paths');
const elementLog = require('../lib/core/element-log');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { resolvePaths } = require('../lib/server/paths');

const TURNS = 40;
const DOC_HTML = '<html><body><article><h1>Doc</h1><p>The body of a captured page, long enough to distil.</p></article></body></html>';
const anchorOn = (mount) => ({ mount, selector: 'p', text: mount, ordinal: 0 });

const graphDir = (root) => projectPaths(root).graphDir;
const nodeFile = (root, id) => JSON.parse(fs.readFileSync(path.join(graphDir(root), `${id}.json`), 'utf8'));
const writeNodeFile = (root, node) => fs.writeFileSync(path.join(graphDir(root), `${node.id}.json`), JSON.stringify(node, null, 2));
const nodeIds = (root) => fs.readdirSync(graphDir(root)).filter((f) => /^n\d+\.json$/.test(f)).map((f) => f.slice(0, -5))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const activeOf = (root) => JSON.parse(fs.readFileSync(projectPaths(root).meta, 'utf8')).active;
const logLines = (root) => fs.readFileSync(projectPaths(root).elementsLog, 'utf8').split('\n').filter(Boolean);
const writeLog = (root, lines) => fs.writeFileSync(projectPaths(root).elementsLog, lines.join('\n') + '\n');
const commitLine = (l, id) => { const r = JSON.parse(l); return r.t === 'commit' && r.node === id; };
// The boot report less what differs between any two boots of the same files.
function reportOf(root) {
  const r = JSON.parse(fs.readFileSync(projectPaths(root).elementsBootReport, 'utf8'));
  delete r.at; delete r.boot; delete r.timings;
  return r;
}

// The graph index over a root's files, as a boot's after-listen flush writes it.
function buildIndex(root) {
  const g = createGraph({ paths: resolvePaths(root), state: createState() });
  g.load();
  g.flushIndex();
  return g;
}

const scratch = [];
test.after(() => { for (const d of scratch) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function copyRoot(from) {
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rh-'));
  scratch.push(to);
  // The index's entries are stat-checked, so the copy keeps each file's mtime.
  fs.cpSync(path.join(from, '.web-chat'), path.join(to, '.web-chat'), { recursive: true, preserveTimestamps: true });
  return to;
}

// ── the fixture ─────────────────────────────────────────────────────────────

let fixture = null;
async function buildFixture(t) {
  const s = await withServer(t);
  const { api } = s;
  const out = { capOld: null, capLive: null, q: null, qNode: null };
  let pins = [];
  for (let i = 1; i <= TURNS; i++) {
    assert.equal((await api.post('/api/turn-begin', { message: `turn ${i}` })).status, 200);
    const mount = `m${i % 5}`;
    assert.equal((await api.post('/api/render', { id: mount, html: `<p>${mount} at turn ${i}</p>` })).json.ok, true);
    if (i % 4 === 0) assert.equal((await api.post('/api/markdown', { id: `md-${i}`, text: `## Part ${i}\n\nA line of framing.` })).json.ok, true);
    if (i % 3 === 0) {
      const r = await api.post('/api/elements', commentBody({ text: `note ${i}`, shared: true, anchor: anchorOn(mount) }));
      assert.equal(r.json.ok, true, JSON.stringify(r.json));
      pins.push(r.json.pin.id);
    }
    if (i % 5 === 0 && pins.length) {
      const r = await api.post(`/api/elements/${pins[pins.length - 1]}/reply`, { text: `reply at ${i}` });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    if (i === 3 || i === 14) {
      const r = await api.post('/api/capture', { url: `https://example.test/doc-${i}`, title: `Doc ${i}`, html: DOC_HTML });
      assert.equal(r.json.ok, true);
      if (i === 3) out.capOld = r.json.capture_id; else out.capLive = r.json.capture_id;
    }
    if (i === 20) {
      // A pin with two versions that only this turn's node carries.
      const r = await api.post('/api/elements', commentBody({ text: 'short-lived', shared: true, anchor: anchorOn(mount) }));
      out.q = r.json.pin.id;
      assert.equal((await api.post(`/api/elements/${out.q}/reply`, { text: 'and gone' })).status, 200);
    }
    if (i === 21) assert.equal((await api.del(`/api/elements/${out.q}`)).json.ok, true);
    const end = await api.post('/api/turn-end', { author: 'claude' });
    assert.ok(end.json.node_id, `turn ${i} committed: ${JSON.stringify(end.json)}`);
    if (i === 20) out.qNode = end.json.node_id;
    // The wipe drops the live captures (and the pins on the panes it took), so
    // capOld rides only the nodes of the turns before it.
    if (i === 10) { assert.equal((await api.post('/api/graph/wipe', { name: 'fresh' })).status, 200); pins = []; }
  }
  await s.graceful();
  buildIndex(s.root);
  // withServer removes its root when the first test ends: keep a copy.
  out.root = copyRoot(s.root);
  out.ids = nodeIds(out.root);
  out.active = activeOf(out.root);
  return out;
}
async function getFixture(t) {
  if (!fixture) fixture = await buildFixture(t);
  return fixture;
}

// A non-active node (and not qNode) with a copy at v >= 2: the copy-v-mismatch
// target (its pin's lower version is in the log).
function pickTwoVersionNode(f) {
  for (const id of f.ids) {
    if (id === f.active || id === f.qNode) continue;
    const c = (nodeFile(f.root, id).comments || []).find((p) => p.v >= 2);
    if (c) return { id, copy: c };
  }
  throw new Error('no node with a v>=2 copy in the fixture');
}
// A non-active node (and not qNode) carrying at least one copy.
function pickPinnedNode(f) {
  const id = f.ids.find((n) => n !== f.active && n !== f.qNode && (nodeFile(f.root, n).comments || []).length);
  assert.ok(id, 'a pinned node');
  return id;
}

// One boot of `root`: its report, and the bodies read at the listen and after
// the after-listen work (the index flush, the mirror's start).
async function boot(t, root) {
  const s = await withServer(t, { root });
  const atListen = s.srv.graph.lazyStats();
  await s.srv.mirror.ready;
  await new Promise((r) => setImmediate(r));
  return { s, atListen, after: s.srv.graph.lazyStats(), report: reportOf(root) };
}
async function bootStop(t, root) {
  const b = await boot(t, root);
  await b.s.stop();
  return b;
}

// The GT-10 pair: the same files booted over the index and with it deleted.
async function bootPair(t, root) {
  const withIndex = copyRoot(root);
  const without = copyRoot(root);
  fs.rmSync(projectPaths(without).graphIndex);
  const a = await bootStop(t, withIndex);
  const b = await bootStop(t, without);
  assert.equal(b.atListen.headers, 0, 'the index-less boot read every node whole');
  assert.equal(a.atListen.headers, TURNS, 'the indexed boot built every node from its header');
  assert.deepStrictEqual(a.report, b.report, 'GT-10: the boot report is the one a full read gives');
  return { a, b };
}

// ── THE PROOF ───────────────────────────────────────────────────────────────

test('the proof: a boot over the index reads no node body before the listen but the active one\'s, nor after it', async (t) => {
  const f = await getFixture(t);
  assert.equal(f.ids.length, TURNS, 'one node per turn');
  const root = copyRoot(f.root);
  const indexAt = fs.statSync(projectPaths(root).graphIndex).mtimeMs;
  const s = await withServer(t, { root });
  // The body's first line: the listen has happened, the after-listen
  // immediates not yet.
  const atListen = s.srv.graph.lazyStats();
  assert.equal(atListen.headers, TURNS, 'every node built from its header');
  assert.deepEqual(atListen.faulted_ids, [f.active], 'only the active node\'s body, read by restoreLiveToNode');
  assert.equal(atListen.faults, 1);
  assert.equal(s.srv.graph.active, f.active);
  // The index flush and the mirror's start (both after the listen). The
  // boot's own reconcile appended nothing, so the flush has nothing to write.
  await s.srv.mirror.ready;
  await new Promise((r) => setImmediate(r));
  await waitUntil(() => fs.existsSync(projectPaths(root).graphIndex), { what: 'the index' });
  const after = s.srv.graph.lazyStats();
  assert.deepEqual(after.faulted_ids, [f.active], 'the after-listen work reads no body');
  assert.equal(after.resident, 1);
  assert.ok(fs.statSync(projectPaths(root).graphIndex).mtimeMs >= indexAt);
  assert.equal(reportOf(root).clean, true, JSON.stringify(reportOf(root).states));
});

test('an unclean node the index cannot see (its record pins a version the log lost) is the one body the reconcile reads', async (t) => {
  const f = await getFixture(t);
  const root = copyRoot(f.root);
  const pinned = nodeFile(root, f.qNode).comments.find((c) => c.id === f.q);
  assert.equal(pinned.v, 2, 'the short-lived pin is at v2 on its node');
  for (const id of f.ids) if (id !== f.qNode) assert.ok(!(nodeFile(root, id).comments || []).some((c) => c.id === f.q), `${id} does not carry it`);
  const lines = logLines(root);
  const kept = lines.filter((l) => { const r = JSON.parse(l); return !(r.t === 'ver' && r.id === f.q && r.v === 2); });
  assert.equal(kept.length, lines.length - 1);
  writeLog(root, kept);

  const { a } = await bootPair(t, root);
  assert.deepEqual(a.atListen.faulted_ids, [f.qNode, f.active], 'the missing version\'s node, then the active one');
  assert.deepEqual(a.after.faulted_ids, [f.qNode, f.active]);
  assert.deepEqual(a.report.states['node-pins-missing-version'], {
    count: 1, examples: [`${f.qNode}:${f.q}@2`], detail: [{ node: f.qNode, pin: `${f.q}@2`, repaired: true }],
  });
});

// ── GT-10: the report with and without the index ────────────────────────────

test('GT-10: a clean fixture reports the same with and without the index', async (t) => {
  const f = await getFixture(t);
  const { a } = await bootPair(t, f.root);
  assert.equal(a.report.clean, true, JSON.stringify(a.report.states));
  assert.deepEqual(a.atListen.faulted_ids, [f.active]);
});

test('GT-10: dangling-commit-record (a record whose digest is not the node\'s) reads that body and reports the same', async (t) => {
  const f = await getFixture(t);
  const root = copyRoot(f.root);
  const X = pickPinnedNode(f);
  writeLog(root, logLines(root).map((l) => (commitLine(l, X) ? JSON.stringify({ ...JSON.parse(l), digest: 'f'.repeat(64) }) : l)));
  const { a } = await bootPair(t, root);
  assert.deepEqual(a.report.states['dangling-commit-record'].examples, [X]);
  assert.deepEqual(a.atListen.faulted_ids, [X, f.active], 'the unclean node\'s copies are hash-checked from its body');
});

test('GT-10: copy-v-mismatch (a record pinning another v than the copy) is found from the header alone', async (t) => {
  const f = await getFixture(t);
  const root = copyRoot(f.root);
  const { id: X, copy } = pickTwoVersionNode(f);
  const from = `${copy.id}@${copy.v}`;
  const to = `${copy.id}@${copy.v - 1}`;
  writeLog(root, logLines(root).map((l) => {
    if (!commitLine(l, X)) return l;
    const r = JSON.parse(l);
    assert.ok(r.pins.includes(from));
    return JSON.stringify({ ...r, pins: r.pins.map((p) => (p === from ? to : p)) });
  }));
  const { a } = await bootPair(t, root);
  assert.deepEqual(a.report.states['copy-v-mismatch'].examples, [`${X}:${from}`]);
  assert.equal(a.report.states['dangling-commit-record'], undefined, 'the digest still agrees');
  assert.deepEqual(a.atListen.faulted_ids, [f.active], 'a clean node\'s {id, v} comes from its header: no body read');
});

test('GT-10: a node with no commit record is adopted from its body and reported the same', async (t) => {
  const f = await getFixture(t);
  const root = copyRoot(f.root);
  const X = pickPinnedNode(f);
  writeLog(root, logLines(root).filter((l) => !commitLine(l, X)));
  const { a } = await bootPair(t, root);
  assert.deepEqual(a.report.states['node-without-commit-record'].detail, [{ node: X, adopted: true }]);
  assert.deepEqual(a.atListen.faulted_ids, [X, f.active]);
});

test('GT-10: a header whose pins are null (comments not all plain objects) reads that body and reports the same', async (t) => {
  const f = await getFixture(t);
  const root = copyRoot(f.root);
  const X = pickPinnedNode(f);
  const node = nodeFile(root, X);
  node.comments.push(7);
  writeNodeFile(root, node);
  // The record agrees with the edited node, so only the null pins send the
  // reconcile to the body.
  const digest = elementLog.nodeDigest(node);
  writeLog(root, logLines(root).map((l) => (commitLine(l, X) ? JSON.stringify({ ...JSON.parse(l), digest }) : l)));
  const g = buildIndex(root);
  assert.equal(g.headerOf(X).pins, null, 'the index holds pins: null for it');
  const { a } = await bootPair(t, root);
  assert.equal(a.report.clean, true, JSON.stringify(a.report.states));
  assert.deepEqual(a.atListen.faulted_ids, [X, f.active]);
});

// ── the stand-in digest ─────────────────────────────────────────────────────

test('the stand-in digest: nodeDigest of each header stand-in equals nodeDigest of the whole node, and reads no body', async (t) => {
  const f = await getFixture(t);
  const g = createGraph({ paths: resolvePaths(f.root), state: createState() });
  g.load();
  assert.equal(g.lazyStats().headers, TURNS);
  let pinned = 0;
  for (const id of f.ids) {
    const n = g.nodes.get(id);
    const h = g.headerOf(id);
    assert.ok(Array.isArray(h.pins), `${id}: pins in the header`);
    if (h.pins.length) pinned++;
    const standIn = { id: n.id, parent_id: n.parent_id, created_at: n.created_at, comments: h.pins };
    assert.equal(elementLog.nodeDigest(standIn), elementLog.nodeDigest(nodeFile(f.root, id)), id);
  }
  assert.ok(pinned > TURNS / 2, `most nodes carry pins (${pinned})`);
  assert.deepEqual(g.lazyStats().faulted_ids, [], 'no body read');
});

// ── findCapture ─────────────────────────────────────────────────────────────

test('findCapture: a capture committed on an old node answers as before and reads only the first node that lists it', async (t) => {
  const f = await getFixture(t);
  const withIndex = copyRoot(f.root);
  const without = copyRoot(f.root);
  fs.rmSync(projectPaths(without).graphIndex);

  const a = await boot(t, withIndex);
  const { graph, state } = a.s.srv;
  const holders = [...graph.nodes.keys()].filter((id) => (graph.headerOf(id).capture_ids || []).includes(f.capOld));
  assert.ok(holders.length >= 2, `several nodes carry it (${holders})`);
  assert.ok(!holders.includes(f.active));
  assert.ok(!state.captures.some((c) => c.id === f.capOld), 'not live');
  const before = graph.lazyStats().faulted_ids;
  // GET /api/captures/:id/raw is the route inspect_capture calls.
  const r1 = await a.s.api.get(`/api/captures/${f.capOld}/raw`);
  assert.equal(r1.status, 200);
  assert.equal(r1.json.id, f.capOld);
  assert.deepEqual(graph.lazyStats().faulted_ids, [...before, holders[0]], 'one body: the first node whose capture_ids list it');
  // A live capture reads no body; an unknown id skips every node.
  assert.ok(state.captures.some((c) => c.id === f.capLive));
  assert.equal((await a.s.api.get(`/api/captures/${f.capLive}/raw`)).status, 200);
  assert.equal((await a.s.api.get('/api/captures/cap999/raw')).status, 404);
  assert.deepEqual(graph.lazyStats().faulted_ids, [...before, holders[0]]);
  await a.s.stop();

  const b = await boot(t, without);
  const r2 = await b.s.api.get(`/api/captures/${f.capOld}/raw`);
  assert.equal(r2.status, 200);
  assert.deepStrictEqual(r1.json, r2.json, 'the same record as a full read finds');
  await b.s.stop();
});

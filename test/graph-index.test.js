// The graph index and stored view keys (PLAN §5 4G.2, GRAPH@stored-view-key).
//
// graph.load used to hash every node's snapshotView at every boot (~40 % of
// the boot at 1,000 × 200), throwing away the key registerNode had already
// computed at commit. The keys now persist in a DERIVED file,
// .web-chat/graph-index.json, taken at boot when the node file's size and
// mtime and the projection version still agree. This file pins:
//
//   * a first boot (no index) hashes every key; the index is written once
//     after the listen, one entry per node file, and nothing lands in graph/;
//   * a second boot takes every stored key, and the keys (and the drawn
//     graph's collapse answer) equal a full re-hash;
//   * a stat mismatch re-hashes that one node; a removed file loses its entry;
//   * writeNode and registerNode keep the entries current;
//   * a different pv, a different v, a torn or non-object index only costs the
//     old hashing — never renamed aside, never a failed boot — and is
//     overwritten after the listen;
//   * THE PINNED FIXTURE: five node shapes and their nodeViewKey, beside
//     PROJECTION_VERSION — a snapshotView change fails here until it bumps;
//   * a preserveTimestamps copy of a primed project keeps every entry valid
//     (KIT@index-copy); a plain copy hashes everything and boots correctly;
//   * a removed .web-chat/ is not recreated, and a graph with no root has no
//     index at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const { createGraph, computeCollapse, INDEX_VERSION } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { projectPaths } = require('../lib/core/paths');
const { SCHEMA_VERSION } = require('../lib/core/versions');
const turns = require('../lib/server/domain/turns');
const { nodeViewKey, PROJECTION_VERSION } = turns;

// ── fixtures ────────────────────────────────────────────────────────────────

let clock = 1000;
function node(id, parent_id, extra = {}) {
  return {
    id, parent_id, created_at: clock++, author: 'claude',
    trigger: { kind: 'turn', message: `turn ${id}`, summary: `turn ${id}` },
    mounts: [], store: {}, comments: [], captures: [], ...extra,
  };
}

// A chain with no-change runs, so the collapse answer has something in it:
// n1 repeats n0, n3 repeats n2, n4 is the tip and active.
function chain() {
  const a = { mounts: [{ id: 'p1', html: '<p>one</p>' }] };
  const b = { mounts: [{ id: 'p1', html: '<p>two</p>' }], store: { k: 2 } };
  return [
    node('n0', null, a), node('n1', 'n0', a),
    node('n2', 'n1', b), node('n3', 'n2', b),
    node('n4', 'n3', { mounts: [{ id: 'p1', html: '<p>three</p>' }] }),
  ];
}

// The past, so a plain copy (or a rewrite) lands a different mtime for sure.
const PAST = new Date('2026-01-02T03:04:05.678Z');

function seedProject(webChatDir, nodes = chain(), { active = nodes[nodes.length - 1].id } = {}) {
  const dir = path.join(webChatDir, 'graph');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of nodes) {
    const f = path.join(dir, `${n.id}.json`);
    fs.writeFileSync(f, JSON.stringify(n, null, 2));
    fs.utimesSync(f, PAST, PAST);
  }
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ active, lock: null }));
  // An existing project at this build's schema (no v3 → v4 migration run).
  fs.writeFileSync(path.join(webChatDir, '_version.json'), JSON.stringify({ version: SCHEMA_VERSION }) + '\n');
  return dir;
}

function tmpProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gindex-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

// A graph over a project root as createServer builds one (the paths name the
// root, so the index is on), loaded.
function loadGraph(root, opts = {}) {
  const pp = projectPaths(root);
  const graph = createGraph({ paths: { GRAPH_DIR: pp.graphDir, META_PATH: pp.meta, root }, state: createState(), ...opts });
  graph.load();
  return graph;
}

function readIndex(root) {
  return JSON.parse(fs.readFileSync(projectPaths(root).graphIndex, 'utf8'));
}

function nodeFiles(root) {
  return fs.readdirSync(projectPaths(root).graphDir).filter((f) => /^n\d+\.json$/.test(f)).sort();
}

function fullRehash(graph) {
  return new Map([...graph.nodes.values()].map((n) => [n.id, nodeViewKey(n)]));
}

const collapseOf = (json) => JSON.stringify({ nodes: json.nodes, collapsed_count: json.collapsed_count });

// ── THE PINNED FIXTURE ──────────────────────────────────────────────────────
// Five node shapes as they exist on disk. If this test fails you changed what
// snapshotView projects for an existing node: bump PROJECTION_VERSION in
// lib/server/domain/turns.js in the same change, and re-pin these keys. Not
// bumping it leaves every stored key in every project's graph index stale.
const PINNED_SHAPES = {
  // A node written before markdown, order and layout existed.
  legacy: {
    id: 'n0', parent_id: null, created_at: 1000, author: 'claude',
    trigger: { kind: 'turn', message: 'a', summary: 'a' },
    mounts: [
      { id: 'p-b', html: '<p>second</p>', params: { n: 2 }, pane_state: { pinned: true }, form_state: {} },
      { id: 'p-a', html: '<p>first</p>', component: 'note', form_state: { '#q:0': 'typed' }, owner: 'claude' },
    ],
    store: { b: [1, 2], a: { z: 1, y: 'two' } },
    comments: [], captures: [],
  },
  // Markdown, an order (with a dangling id), Claude's baseline and run flags.
  page: {
    id: 'n1', parent_id: 'n0', created_at: 1001, author: 'claude',
    mounts: [{ id: 'p-a', html: '<p>first</p>' }, { id: 'p-b', html: '<p>second</p>' }],
    markdown: [{ id: 'md-title', text: '# Title', owner: 'claude' }, { id: 'md-2', text: 'between' }],
    order: ['md-title', 'p-a', 'md-2', 'p-b', 'gone'],
    claude_order: ['md-title', 'p-b', 'md-2', 'p-a'],
    runs: { 'md-2': { stacks: false }, start: { stacks: true }, 'p-a': { stacks: false } },
    store: {}, comments: [], captures: [],
  },
  // Comment copies with and without the log version `v`.
  comments: {
    id: 'n2', parent_id: 'n1', created_at: 1002, author: 'user',
    mounts: [{ id: 'p-a', html: '<p>first</p>' }],
    store: {},
    comments: [
      { id: 'c1', seq: 1, text: 'pinned with v', author: 'user', anchor: { mount: 'p-a', selector: 'p', text: 'first' }, v: 3, replies: [{ text: 'ok', author: 'claude' }] },
      { id: 'c2', seq: 2, text: 'no v', author: 'user', anchor: { mount: 'p-a', selector: 'p' }, shared: false },
    ],
    captures: [],
  },
  // Non-empty element references (one malformed, dropped by the projection).
  elements: {
    id: 'n3', parent_id: 'n2', created_at: 1003, author: 'claude',
    mounts: [], store: {}, comments: [],
    elements: ['k7@2', 'h3@1', 'not-a-ref'],
    captures: [],
  },
  // A capture carrying a box grab's `image`.
  capture: {
    id: 'n4', parent_id: 'n3', created_at: 1004, author: 'claude',
    mounts: [], store: {}, comments: [],
    captures: [{ id: 'cap1', seq: 1, url: 'https://example.com/', title: 'Example', image: { file: 'cap1.png', w: 10, h: 10 } }],
  },
};

test('graph index: the pinned fixture — snapshotView for five node shapes, at PROJECTION_VERSION 1', () => {
  assert.equal(PROJECTION_VERSION, 1);
  const pinned = {
    legacy: '8e857123eb5945894ea89f77066b4e8694105e97',
    page: 'db5149603d050fe60231a12117e20ce00c1b5a6c',
    comments: '0d75bf0cc62554af548b95b0db07fbf0dab5aeb0',
    elements: 'f9166bc2fcd98ee69cb7eb0ab521742ac1ba1917',
    capture: '002162d859c0847dd349cc484b3e93fd0ceb7d6b',
  };
  for (const [shape, key] of Object.entries(pinned)) {
    assert.equal(
      nodeViewKey(PINNED_SHAPES[shape]), key,
      `snapshotView's output changed for the '${shape}' node shape: bump PROJECTION_VERSION in ` +
      'lib/server/domain/turns.js in the same change and re-pin these keys (test/graph-index.test.js), ' +
      'or every stored view key in every project\'s .web-chat/graph-index.json goes stale'
    );
  }
});

// ── boots through the daemon ────────────────────────────────────────────────

test('graph index: a first boot hashes every key and writes the index after the listen; a second takes every key', async (t) => {
  const s1 = await withServer(t, { seed: ({ webChatDir }) => { seedProject(webChatDir); } });
  const graphDir = projectPaths(s1.root).graphDir;
  const graphBefore = fs.readdirSync(graphDir).sort();

  assert.deepEqual(s1.srv.graph.loadReport.index,
    { present: false, reason: 'absent', entries: 0, taken: 0, hashed: 5, headers: 0, read_whole: 5 });
  const indexFile = projectPaths(s1.root).graphIndex;
  assert.equal(path.dirname(indexFile), path.join(s1.root, '.web-chat'), 'the index sits in .web-chat/, outside graph/');
  await waitUntil(() => fs.existsSync(indexFile), { what: 'the after-listen index write' });

  const idx = readIndex(s1.root);
  assert.equal(idx.v, INDEX_VERSION);
  assert.equal(idx.pv, PROJECTION_VERSION);
  assert.deepEqual(Object.keys(idx.nodes).sort(), nodeFiles(s1.root), 'one entry per node file, keyed by file name');
  for (const [file, e] of Object.entries(idx.nodes)) {
    const st = fs.statSync(path.join(graphDir, file));
    assert.equal(e.id, file.replace(/\.json$/, ''));
    assert.equal(e.size, st.size);
    assert.equal(e.mtime_ms, st.mtimeMs);
    assert.equal(e.view_key, s1.srv.graph.viewKeys.get(e.id));
  }
  assert.deepEqual(fs.readdirSync(graphDir).sort(), graphBefore, 'nothing new inside graph/');
  assert.ok(!fs.readdirSync(graphDir).some((f) => f.includes('graph-index')));

  const keys1 = new Map(s1.srv.graph.viewKeys);
  assert.deepEqual(keys1, fullRehash(s1.srv.graph));
  const g1 = await s1.api.get('/api/graph');
  assert.equal(g1.status, 200);
  assert.equal(g1.json.collapsed_count, 2, 'n1 and n3 repeat their parents');

  await s1.graceful(); await s1.stop();
  const s2 = await withServer(t, { root: s1.root });
  assert.deepEqual(s2.srv.graph.loadReport.index,
    { present: true, reason: null, entries: 5, taken: 5, hashed: 0, headers: 5, read_whole: 0 });
  assert.deepEqual(new Map(s2.srv.graph.viewKeys), keys1, 'the stored keys, entry for entry');
  assert.deepEqual(new Map(s2.srv.graph.viewKeys), fullRehash(s2.srv.graph), 'and they equal a full re-hash');
  const g2 = await s2.api.get('/api/graph');
  assert.equal(collapseOf(g2.json), collapseOf(g1.json), 'the collapse answer is byte-equal');
  assert.deepEqual(fs.readdirSync(graphDir).sort(), graphBefore);
});

test('graph index: a bookmark rewrites the node; its new stat reaches the index at the next boot and collapse still keeps it', async (t) => {
  const s1 = await withServer(t, { seed: ({ webChatDir }) => { seedProject(webChatDir); } });
  const indexFile = projectPaths(s1.root).graphIndex;
  await waitUntil(() => fs.existsSync(indexFile), { what: 'the after-listen index write' });
  const before = (await s1.api.get('/api/graph')).json.nodes.find((n) => n.id === 'n1');
  assert.equal(before.collapsed, true, 'n1 repeats n0 and is hidden');

  const b = await s1.api.post('/api/graph/bookmark', { id: 'n1', name: 'kept' });
  assert.equal(b.status, 200);
  const n1File = path.join(projectPaths(s1.root).graphDir, 'n1.json');
  const stBookmarked = fs.statSync(n1File);
  assert.notEqual(readIndex(s1.root).nodes['n1.json'].size, stBookmarked.size,
    'the index is written once after the listen (RULED U572-U573@index-cadence-and-refusal (a)): a rewrite during the run is not flushed');

  await s1.graceful(); await s1.stop();
  const s2 = await withServer(t, { root: s1.root });
  assert.deepEqual(s2.srv.graph.loadReport.index,
    { present: true, reason: null, entries: 5, taken: 4, hashed: 1, headers: 4, read_whole: 1 }, 'the bookmarked node is read whole');
  assert.equal(s2.srv.graph.viewKeys.get('n1'), s2.srv.graph.viewKeys.get('n0'), 'the bookmark is not a projected field');
  await waitUntil(() => readIndex(s2.root).nodes['n1.json'].size === stBookmarked.size, { what: 'the refreshed entry' });
  const e = readIndex(s2.root).nodes['n1.json'];
  assert.equal(e.mtime_ms, stBookmarked.mtimeMs, 'the entry carries the new size and mtime');
  assert.notEqual(computeCollapse(s2.srv.graph).get('n1').collapsed, true, 'a bookmarked node is never collapsible');

  await s2.graceful(); await s2.stop();
  const s3 = await withServer(t, { root: s1.root });
  assert.deepEqual(s3.srv.graph.loadReport.index,
    { present: true, reason: null, entries: 5, taken: 5, hashed: 0, headers: 5, read_whole: 0 });
  const n1 = (await s3.api.get('/api/graph')).json.nodes.find((n) => n.id === 'n1');
  assert.equal(n1.collapsed, undefined, 'still drawn: bookmarked');
  assert.equal(n1.bookmarked, true);
});

test('graph index: a different pv or v, a torn or non-object index only costs the hashing, and is overwritten after the listen', async (t) => {
  const good = (root) => {
    const g = loadGraph(root);
    assert.equal(g.flushIndex(), true);
    return readIndex(root);
  };
  const variants = [
    ['pv', (idx) => JSON.stringify({ ...idx, pv: PROJECTION_VERSION + 1 }), { present: true, reason: 'pv', entries: 5 }],
    ['v', (idx) => JSON.stringify({ ...idx, v: INDEX_VERSION + 1 }), { present: true, reason: 'invalid', entries: 0 }],
    ['torn', (idx) => JSON.stringify(idx).slice(0, 40), { present: true, reason: 'corrupt', entries: 0 }],
    ['array', () => '[1,2,3]', { present: true, reason: 'invalid', entries: 0 }],
    ['nodes-not-object', (idx) => JSON.stringify({ ...idx, nodes: [] }), { present: true, reason: 'invalid', entries: 0 }],
  ];
  for (const [name, bytes, expect] of variants) {
    const s = await withServer(t, {
      seed: ({ root, webChatDir }) => {
        seedProject(webChatDir);
        fs.writeFileSync(projectPaths(root).graphIndex, bytes(good(root)));
      },
    });
    assert.deepEqual(s.srv.graph.loadReport.index, { ...expect, taken: 0, hashed: 5, headers: 0, read_whole: 5 }, `${name}: every key hashed`);
    assert.deepEqual(new Map(s.srv.graph.viewKeys), fullRehash(s.srv.graph), `${name}: the keys are right`);
    assert.equal((await s.api.get('/api/graph')).status, 200, `${name}: the boot did not fail`);
    await waitUntil(() => {
      try { const i = readIndex(s.root); return i.v === INDEX_VERSION && i.pv === PROJECTION_VERSION && Object.keys(i.nodes).length === 5; } catch { return false; }
    }, { what: `${name}: the index overwritten` });
    const aside = fs.readdirSync(path.join(s.root, '.web-chat')).filter((f) => f.startsWith('graph-index.json.'));
    assert.deepEqual(aside, [], `${name}: a derived file is never renamed aside`);
    await s.stop();
  }
});

// ── the stat check and the entry refresh, over a bare graph ────────────────

test('graph index: a stat mismatch re-hashes that one node; a removed file loses its entry', (t) => {
  const root = tmpProject(t);
  seedProject(path.join(root, '.web-chat'));
  const g0 = loadGraph(root);
  assert.equal(g0.loadReport.index.hashed, 5);
  assert.equal(g0.flushIndex(), true);
  assert.equal(g0.flushIndex(), false, 'nothing changed since: no write');

  const clean = loadGraph(root);
  assert.deepEqual(clean.loadReport.index, { present: true, reason: null, entries: 5, taken: 5, hashed: 0, headers: 5, read_whole: 0 });
  assert.equal(clean.flushIndex(), false, 'every entry taken as it was: the index is not dirty');

  // Touched: same bytes, mtime forward.
  const dir = projectPaths(root).graphDir;
  const later = new Date(PAST.getTime() + 60_000);
  fs.utimesSync(path.join(dir, 'n2.json'), later, later);
  const touched = loadGraph(root);
  assert.deepEqual(touched.loadReport.index, { present: true, reason: null, entries: 5, taken: 4, hashed: 1, headers: 4, read_whole: 1 });
  assert.deepEqual(new Map(touched.viewKeys), fullRehash(touched));
  assert.equal(touched.flushIndex(), true, 'the hashed entry marks the index dirty');
  assert.equal(readIndex(root).nodes['n2.json'].mtime_ms, fs.statSync(path.join(dir, 'n2.json')).mtimeMs);

  // Rewritten with a different size (and its old mtime put back): the size alone refuses it.
  const n3 = JSON.parse(fs.readFileSync(path.join(dir, 'n3.json'), 'utf8'));
  n3.mounts = [{ id: 'p1', html: '<p>edited by hand</p>' }];
  fs.writeFileSync(path.join(dir, 'n3.json'), JSON.stringify(n3, null, 2));
  fs.utimesSync(path.join(dir, 'n3.json'), PAST, PAST);
  const resized = loadGraph(root);
  assert.deepEqual(resized.loadReport.index, { present: true, reason: null, entries: 5, taken: 4, hashed: 1, headers: 4, read_whole: 1 });
  assert.equal(resized.viewKeys.get('n3'), nodeViewKey(n3), 'the new bytes, not the stored key');
  assert.notEqual(resized.viewKeys.get('n3'), resized.viewKeys.get('n2'));
  assert.equal(resized.flushIndex(), true);

  // Removed since the index was written.
  fs.rmSync(path.join(dir, 'n4.json'));
  const removed = loadGraph(root);
  assert.deepEqual(removed.loadReport.index, { present: true, reason: null, entries: 5, taken: 4, hashed: 0, headers: 4, read_whole: 0 });
  assert.equal(removed.flushIndex(), true, 'a stale entry makes the index dirty');
  assert.deepEqual(Object.keys(readIndex(root).nodes).sort(), ['n0.json', 'n1.json', 'n2.json', 'n3.json']);
});

test('graph index: an entry whose id disagrees with its node is not taken', (t) => {
  const root = tmpProject(t);
  seedProject(path.join(root, '.web-chat'));
  loadGraph(root).flushIndex();
  const idx = readIndex(root);
  idx.nodes['n2.json'].id = 'n9';
  idx.nodes['n3.json'].view_key = 'not a key';
  fs.writeFileSync(projectPaths(root).graphIndex, JSON.stringify(idx));
  const g = loadGraph(root);
  assert.deepEqual(g.loadReport.index, { present: true, reason: null, entries: 5, taken: 3, hashed: 2, headers: 3, read_whole: 2 });
  assert.deepEqual(new Map(g.viewKeys), fullRehash(g));
});

test('graph index: writeNode and registerNode keep the entries current', (t) => {
  const root = tmpProject(t);
  seedProject(path.join(root, '.web-chat'));
  const g = loadGraph(root);
  g.flushIndex();

  // A rewrite (the bookmark route's shape): the entry follows the file.
  const n1 = g.nodes.get('n1');
  n1.bookmarked = true; n1.name = 'kept';
  g.writeNode(n1);
  // A commit through commitNode: writeNode then registerNode.
  const r = turns.commitNode(g, { emit() {} }, {
    draftPath: path.join(root, '.web-chat', 'draft.json'), parentId: 'n4', author: 'claude',
    triggerKind: 'turn', message: 'm', summary: 's',
    clearLock: false, op: 'commit', includeLabelAndUnlock: false,
  });
  const newFile = `${r.node_id}.json`;
  assert.equal(newFile, 'n5.json');
  assert.equal(g.flushIndex(), true);

  const idx = readIndex(root);
  const dir = projectPaths(root).graphDir;
  for (const f of ['n1.json', newFile]) {
    const st = fs.statSync(path.join(dir, f));
    assert.equal(idx.nodes[f].size, st.size, `${f}: size refreshed`);
    assert.equal(idx.nodes[f].mtime_ms, st.mtimeMs, `${f}: mtime refreshed`);
  }
  assert.equal(idx.nodes[newFile].view_key, g.viewKeys.get(newFile.replace(/\.json$/, '')), 'registerNode recorded its key');

  const next = loadGraph(root);
  assert.deepEqual(next.loadReport.index, { present: true, reason: null, entries: 6, taken: 6, hashed: 0, headers: 6, read_whole: 0 });
  assert.deepEqual(new Map(next.viewKeys), fullRehash(next));
});

// ── the copy (KIT@index-copy) ───────────────────────────────────────────────

test('graph index: a preserveTimestamps copy of a primed project keeps every entry; a plain copy hashes and still boots', async (t) => {
  const src = tmpProject(t);
  seedProject(path.join(src, '.web-chat'));
  // Sub-millisecond mtimes, the case a copy through Date objects can move.
  const dir = projectPaths(src).graphDir;
  nodeFiles(src).forEach((f, i) => {
    const s = (PAST.getTime() + i * 13.7 + 0.777) / 1000;
    fs.utimesSync(path.join(dir, f), s, s);
  });
  const primed = loadGraph(src);
  assert.equal(primed.flushIndex(), true);

  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gindex-copy-'));
  t.after(() => { try { fs.rmSync(kept, { recursive: true, force: true }); } catch {} });
  fs.cpSync(src, kept, { recursive: true, preserveTimestamps: true });
  const g = loadGraph(kept);
  assert.deepEqual(g.loadReport.index, { present: true, reason: null, entries: 5, taken: 5, hashed: 0, headers: 5, read_whole: 0 },
    `on ${process.version}`);
  assert.deepEqual(new Map(g.viewKeys), fullRehash(g));

  // …and the daemon reads it the same way.
  const s = await withServer(t, { root: kept });
  assert.equal(s.srv.graph.loadReport.index.taken, 5);
  assert.equal(s.srv.graph.loadReport.index.hashed, 0);
  await s.stop();

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gindex-copy-'));
  t.after(() => { try { fs.rmSync(plain, { recursive: true, force: true }); } catch {} });
  fs.cpSync(src, plain, { recursive: true });
  const p = loadGraph(plain);
  assert.deepEqual(p.loadReport.index, { present: true, reason: null, entries: 5, taken: 0, hashed: 5, headers: 0, read_whole: 5 });
  assert.deepEqual(new Map(p.viewKeys), fullRehash(p));
  assert.equal(p.active, 'n4');
});

// ── where it may and may not be written ─────────────────────────────────────

test('graph index: a removed .web-chat/ is not recreated, and a graph with no root has no index', (t) => {
  const root = tmpProject(t);
  seedProject(path.join(root, '.web-chat'));
  const g = loadGraph(root);
  fs.rmSync(path.join(root, '.web-chat'), { recursive: true, force: true });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let wrote;
  try { wrote = g.flushIndex(); } finally { console.error = orig; }
  assert.equal(wrote, false, 'flushIndex never throws');
  assert.equal(fs.existsSync(path.join(root, '.web-chat')), false, '{mkdir: false}: never recreated');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[web-chat\] could not write the graph index/);

  // No root in the paths: no index, behaves as before.
  const bare = tmpProject(t);
  const dir = seedProject(path.join(bare, '.web-chat'));
  const before = fs.readdirSync(path.join(bare, '.web-chat')).sort();
  const ng = createGraph({ paths: { GRAPH_DIR: dir, META_PATH: path.join(dir, '_meta.json') }, state: createState() });
  ng.load();
  assert.equal(ng.indexPath, null);
  assert.equal(ng.loadReport.index, null);
  assert.deepEqual(new Map(ng.viewKeys), fullRehash(ng));
  assert.equal(ng.flushIndex(), false);
  assert.deepEqual(fs.readdirSync(path.join(bare, '.web-chat')).sort(), before, 'nothing written');

  // A stray index inside graph/ is not ours: graph.load's filter treats it as a
  // node file, as it always has (test/graph-corrupt.test.js) — which is why the
  // index lives one level up.
  assert.notEqual(path.dirname(projectPaths(bare).graphIndex), dir);
});

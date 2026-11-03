// Lazy node bodies (PLAN §5 4G.3, part 1; GRAPH@lazy-node-bodies).
//
// graph.load used to read and parse every node file at every boot. The graph
// index (U572) now carries each node's HEADER — the node less its body keys
// (mounts, the page sequence and its layout, store, comments, captures), plus
// fields derived from the body that live in the index only — and a boot
// builds every node whose entry still agrees with its file from that header.
// The body keys are enumerable accessors that read the file on first touch
// and stay resident. This file pins:
//
//   * a second boot over the index the first wrote builds every node from its
//     header and reads no file; one touch reads one file, once, and turns
//     every body key of that node into a plain data property;
//   * a lazy node answers every read exactly as the whole node does
//     (JSON.stringify, spread, Object.keys, `in`, deepStrictEqual,
//     structuredClone, page.pageOrder);
//   * a header field set before the touch survives it, and writeNode writes
//     the whole node with it;
//   * a body that cannot be read after boot answers empty, marks the node,
//     and writeNode (and so POST /api/graph/bookmark) refuses to rewrite it;
//   * a missing or version-1 index reads everything whole; a node file added
//     by hand is read whole and indexed after the listen;
//   * the comment-seq and capture-seq floors come from the headers;
//   * the derived fields never reach a node object or a node file, and pins
//     are exactly element-log nodeDigest's inputs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const { createGraph, headerOf, BODY_KEYS } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { projectPaths } = require('../lib/core/paths');
const { SCHEMA_VERSION } = require('../lib/core/versions');
const elementLog = require('../lib/core/element-log');
const turns = require('../lib/server/domain/turns');
const page = require('../lib/server/domain/page');
const elementRefs = require('../lib/server/domain/element-refs');

const bus = { emit() {} };
const DERIVED = ['key_order', 'body_keys', 'pins', 'max_comment_seq', 'max_capture_seq', 'capture_ids'];

function tmpProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lazy-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  const pp = projectPaths(root);
  fs.mkdirSync(pp.graphDir, { recursive: true });
  fs.mkdirSync(pp.captures, { recursive: true });
  // An existing project at this build's schema (no migration at boot).
  fs.writeFileSync(path.join(root, '.web-chat', '_version.json'), JSON.stringify({ version: SCHEMA_VERSION }) + '\n');
  return root;
}

function graphPaths(root) {
  const pp = projectPaths(root);
  return { GRAPH_DIR: pp.graphDir, META_PATH: pp.meta, CAPTURES_DIR: pp.captures, root };
}

// A graph over a project root as createServer builds one (the index on), or
// with `indexPath: null` one that reads every node whole, as before 4G.
function loadGraph(root, { state = createState(), elements, ...opts } = {}) {
  const graph = createGraph({ paths: graphPaths(root), state, ...opts });
  if (elements) graph.elements = elements;
  graph.load();
  return graph;
}

function mount(state, id, html) {
  state.mounts.set(id, turns.hydrateMount({ html }));
  page.place(state, id);
}

// Six nodes committed through commitNode: a pane-only node, markdown and
// order, a moved item and a run flag (claude_order, runs), element refs,
// comments with seq and v (and one without v), captures, a store.
function commitFixture(root) {
  const state = createState();
  const g = loadGraph(root, { state });
  const commit = (message) => turns.commitNode(g, bus, {
    draftPath: path.join(root, '.web-chat', 'draft.json'), parentId: g.active, author: 'claude',
    triggerKind: 'turn', message, summary: message,
    clearLock: false, op: 'commit', includeLabelAndUnlock: false,
  });
  mount(state, 'p1', '<p>one</p>');
  commit('panes only');
  page.putMarkdown(state, bus, { id: 'md-title', text: '# Title' });
  mount(state, 'p2', '<p>two</p>');
  state.comments.push({ id: 'c40', seq: 40, v: 1, mount: 'p1', text: 'first', replies: [{ by: 'claude', text: 'ok' }], anchor: { kind: 'pane' } });
  commit('markdown and a comment');
  page.putMarkdown(state, bus, { id: 'md-part', text: '## Part' });
  mount(state, 'p3', '<p>three</p>');
  page.moveItem(state, bus, { id: 'p3', after: 'start' });
  page.setRunFlag(state, bus, { anchor: 'md-part', stacks: false });
  elementRefs.putRef(state, 'h3', 1);
  state.captures.push({ id: 'cap9', seq: 9, url: 'https://example.test/', title: 'x' });
  commit('layout, refs and a capture');
  state.comments.push({ id: 'c41', seq: 41, mount: 'p2', text: 'no v yet' });
  state.store.k = { deep: [1, 2] };
  commit('a comment with no v, a store');
  page.clearMarkdown(state);
  commit('markdown gone again');
  state.captures.push({ id: 'cap7', seq: 7 });
  commit('another capture');
  assert.equal(g.flushIndex(), true);
  return g;
}

const fileOf = (root, id) => path.join(projectPaths(root).graphDir, `${id}.json`);
const readFile = (root, id) => JSON.parse(fs.readFileSync(fileOf(root, id), 'utf8'));
const readIndex = (root) => JSON.parse(fs.readFileSync(projectPaths(root).graphIndex, 'utf8'));
const isData = (obj, k) => { const d = Object.getOwnPropertyDescriptor(obj, k); return !!d && 'value' in d && d.writable; };

test('lazy bodies: the fixture holds every body shape', (t) => {
  const root = tmpProject(t);
  const g = commitFixture(root);
  const ids = [...g.nodes.keys()];
  assert.equal(ids.length, 6);
  const files = ids.map((id) => readFile(root, id));
  const has = (k) => files.some((f) => Object.prototype.hasOwnProperty.call(f, k));
  for (const k of ['markdown', 'order', 'claude_order', 'runs', 'elements']) assert.ok(has(k), `some node holds ${k}`);
  assert.ok(files.some((f) => !('markdown' in f)), 'and some node has no page sequence');
  assert.ok(files.some((f) => f.comments.some((c) => c.v === undefined)), 'a comment with no v');
  for (const f of files) for (const k of BODY_KEYS) {
    if (k in f) assert.ok(readIndex(root).nodes[`${f.id}.json`].header.body_keys.includes(k));
  }
});

test('lazy bodies: a second boot builds every node from its header; one touch reads one file, once', (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  const g = loadGraph(root);
  const N = g.nodes.size;
  assert.equal(g.loadReport.index.headers, N);
  assert.equal(g.loadReport.index.read_whole, 0);
  assert.deepEqual(g.lazyStats(), { headers: N, resident: 0, faults: 0, unreadable: 0, faulted_ids: [] });

  // Every header-side read, and the questions that do not read a value, cost nothing.
  for (const n of g.nodes.values()) {
    void n.trigger; void n.parent_id; void n.elements; void n.created_at;
    void Object.keys(n); void ('markdown' in n); void Object.prototype.hasOwnProperty.call(n, 'order');
  }
  void g.headerOf('n3');
  assert.equal(g.lazyStats().faults, 0, 'no body read by header fields, keys, `in` or headerOf');

  const n2 = g.nodes.get('n2');
  for (const k of BODY_KEYS) if (k in n2) assert.ok(!isData(n2, k), `${k} is an accessor before the touch`);
  const mounts = n2.mounts;
  assert.equal(mounts.length, 3);
  assert.deepEqual(g.lazyStats(), { headers: N, resident: 1, faults: 1, unreadable: 0, faulted_ids: ['n2'] });
  for (const k of Object.keys(n2)) assert.ok(isData(n2, k), `${k} is a plain data property after the touch`);
  assert.equal(n2.mounts, mounts, 'the same resident array');
  void n2.comments; void n2.store; void JSON.stringify(n2);
  assert.equal(g.lazyStats().faults, 1, 'a second touch reads nothing');
});

test('lazy bodies: every read of a lazy node equals the read of the whole node', (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  const whole = loadGraph(root, { indexPath: null });
  assert.equal(whole.loadReport.index, null);
  const ids = [...whole.nodes.keys()];

  // Questions that read no value, asked before any touch.
  const lazyKeys = loadGraph(root);
  for (const id of ids) {
    const lz = lazyKeys.nodes.get(id), wh = whole.nodes.get(id);
    assert.deepEqual(Object.keys(lz), Object.keys(wh), `${id}: Object.keys`);
    for (const k of [...BODY_KEYS, 'elements', 'bookmarked']) assert.equal(k in lz, k in wh, `${id}: '${k}' in node`);
  }
  assert.equal(lazyKeys.lazyStats().faults, 0);

  // Each read on its own fresh lazy graph, so each runs through the accessors.
  const reads = {
    stringify: (n) => JSON.stringify(n),
    pretty: (n) => JSON.stringify(n, null, 2),
    spread: (n) => JSON.stringify(Object.entries({ ...n })),
    clone: (n) => structuredClone(n),
    pageOrder: (n) => page.pageOrder(n),
    digest: (n) => elementLog.nodeDigest(n),
    viewKey: (n) => turns.nodeViewKey(n),
  };
  for (const [name, read] of Object.entries(reads)) {
    const g = loadGraph(root);
    for (const id of ids) assert.deepStrictEqual(read(g.nodes.get(id)), read(whole.nodes.get(id)), `${id}: ${name}`);
  }
  const g = loadGraph(root);
  for (const id of ids) {
    const lz = g.nodes.get(id);
    assert.equal(JSON.stringify(lz), JSON.stringify(readFile(root, id)), `${id}: the file's JSON re-serialised`);
    assert.deepStrictEqual(lz, whole.nodes.get(id), `${id}: deepStrictEqual`);
  }
  assert.ok(!('markdown' in g.nodes.get('n0')), 'a node with no markdown has no markdown key');
  assert.ok('order' in g.nodes.get('n1'));
});

test('lazy bodies: a header field set before the touch survives it, and writeNode writes the whole node with it', (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  const before = readFile(root, 'n2');
  const g = loadGraph(root);
  const n = g.nodes.get('n2');
  n.bookmarked = true;
  n.name = 'kept';
  n.theme = { tokens: { '--wc-accent': '#123456' } };
  assert.equal(g.lazyStats().faults, 0, 'a header write reads no body');
  assert.equal(n.comments.length, 1);
  assert.equal(n.bookmarked, true, 'the bookmark survives the touch');
  assert.equal(n.name, 'kept');
  assert.deepEqual(n.theme, { tokens: { '--wc-accent': '#123456' } });
  g.writeNode(n);
  assert.deepStrictEqual(readFile(root, 'n2'), { ...before, bookmarked: true, name: 'kept', theme: { tokens: { '--wc-accent': '#123456' } } });

  // A body key set before the touch reads the body first, then sets.
  const m = g.nodes.get('n3');
  m.store = { replaced: true };
  assert.equal(g.lazyStats().faults, 2);
  assert.deepEqual(m.store, { replaced: true });
  assert.deepEqual(m.comments, readFile(root, 'n3').comments, 'the other body keys came from the file');
});

test('lazy bodies: a body that cannot be read after boot answers empty, marks the node, and writeNode refuses it', (t) => {
  for (const [how, damage] of [
    ['torn', (f) => fs.writeFileSync(f, '{"id":')],
    ['deleted', (f) => fs.rmSync(f)],
    ['another node', (f) => fs.writeFileSync(f, JSON.stringify({ id: 'n9', created_at: 1 }))],
  ]) {
    const root = tmpProject(t);
    commitFixture(root);
    const g = loadGraph(root);
    const f = fileOf(root, 'n1');
    damage(f);
    const bytes = fs.existsSync(f) ? fs.readFileSync(f) : null;
    const n = g.nodes.get('n1');
    assert.deepEqual(n.comments, [], `${how}: comments`);
    assert.deepEqual(n.mounts, [], `${how}: mounts`);
    assert.deepEqual(n.store, {}, `${how}: store`);
    assert.deepEqual(n.captures, [], `${how}: captures`);
    assert.ok(!('markdown' in n) && !('order' in n), `${how}: no page sequence`);
    assert.equal(n.trigger.message, 'markdown and a comment', `${how}: the header stands`);
    assert.ok(g.unreadableBodies.has('n1'), `${how}: marked`);
    assert.equal(g.lazyStats().unreadable, 1);
    n.bookmarked = true;
    assert.throws(() => g.writeNode(n), (e) => e.code === 'NODE_BODY_UNREADABLE', `${how}: writeNode refuses`);
    assert.deepEqual(fs.existsSync(f) ? fs.readFileSync(f) : null, bytes, `${how}: the file is untouched`);
  }

  // An untouched lazy node: writeNode reads the body first, then refuses.
  const root = tmpProject(t);
  commitFixture(root);
  const g = loadGraph(root);
  fs.writeFileSync(fileOf(root, 'n4'), '{"id":');
  assert.throws(() => g.writeNode(g.nodes.get('n4')), (e) => e.code === 'NODE_BODY_UNREADABLE');
  assert.equal(fs.readFileSync(fileOf(root, 'n4'), 'utf8'), '{"id":');
  assert.equal(g.headerOf('n4').pins.length, 0, 'it answers the empty body');
});

test('lazy bodies: POST /api/graph/bookmark on a node whose body is unreadable answers 500 and leaves the file', async (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  const s = await withServer(t, { root });
  await waitUntil(() => readIndex(root).nodes['n5.json'], { what: 'the after-listen index' });
  // Before U574 the boot's reconcile reads every body before the listen, so
  // re-read the graph from its index in place: every node is lazy again, as a
  // boot after U574 leaves every node but the active one and the unclean.
  s.srv.graph.load();
  assert.equal(s.srv.graph.lazyStats().headers, 6);
  const f = fileOf(root, 'n2');
  fs.writeFileSync(f, '{"id":');
  const r = await s.api.post('/api/graph/bookmark', { id: 'n2', name: 'x' });
  assert.equal(r.status, 500);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"id":', 'the file is unchanged');
  assert.ok(s.srv.graph.unreadableBodies.has('n2'));
  // Another node bookmarks as ever.
  const ok = await s.api.post('/api/graph/bookmark', { id: 'n3', name: 'fine' });
  assert.equal(ok.status, 200);
  assert.equal(readFile(root, 'n3').name, 'fine');
  assert.equal(readFile(root, 'n3').comments.length, 2, 'written whole');
});

test('lazy bodies: a missing or version-1 index reads every node whole', (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  const whole = loadGraph(root, { indexPath: null });
  const idx = readIndex(root);
  const variants = [
    ['absent', () => fs.rmSync(projectPaths(root).graphIndex), 'absent'],
    ['v1', () => fs.writeFileSync(projectPaths(root).graphIndex, JSON.stringify({
      v: 1, pv: idx.pv,
      nodes: Object.fromEntries(Object.entries(idx.nodes).map(([f, e]) => [f, { id: e.id, size: e.size, mtime_ms: e.mtime_ms, view_key: e.view_key }])),
    })), 'invalid'],
  ];
  for (const [name, write, reason] of variants) {
    write();
    const g = loadGraph(root);
    assert.equal(g.loadReport.index.reason, reason, name);
    assert.equal(g.loadReport.index.read_whole, 6, `${name}: read whole`);
    assert.equal(g.loadReport.index.headers, 0, `${name}: no headers`);
    assert.deepEqual(g.lazyStats(), { headers: 0, resident: 6, faults: 0, unreadable: 0, faulted_ids: [] });
    for (const id of whole.nodes.keys()) assert.deepStrictEqual(g.nodes.get(id), whole.nodes.get(id), `${name}: ${id}`);
    assert.equal(g.flushIndex(), true, `${name}: rewritten`);
    assert.equal(loadGraph(root).loadReport.index.headers, 6, `${name}: the next boot builds from headers`);
  }

  // An entry whose header is unusable is read whole (its view key still taken).
  const broken = readIndex(root);
  broken.nodes['n2.json'].header.body_keys = ['mounts', 'nonsense'];
  broken.nodes['n3.json'].header.node.created_at = 'yesterday';
  fs.writeFileSync(projectPaths(root).graphIndex, JSON.stringify(broken));
  const g = loadGraph(root);
  assert.equal(g.loadReport.index.headers, 4);
  assert.equal(g.loadReport.index.read_whole, 2);
  assert.equal(g.loadReport.index.taken, 6);
  for (const id of whole.nodes.keys()) assert.deepStrictEqual(g.nodes.get(id), whole.nodes.get(id));
});

test('lazy bodies: a node file added by hand after the index is read whole and indexed after the listen', async (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  const hand = { ...readFile(root, 'n5'), id: 'n6', parent_id: 'n5', created_at: Date.now() + 1000,
    comments: [{ id: 'c77', seq: 77, v: 3, text: 'an older build' }] };
  fs.writeFileSync(fileOf(root, 'n6'), JSON.stringify(hand, null, 2));
  const g = loadGraph(root);
  assert.equal(g.loadReport.index.headers, 6);
  assert.equal(g.loadReport.index.read_whole, 1);
  assert.deepStrictEqual(g.nodes.get('n6'), hand);

  const s = await withServer(t, { root });
  await waitUntil(() => readIndex(root).nodes['n6.json'], { what: 'n6 indexed after the listen' });
  assert.deepEqual(readIndex(root).nodes['n6.json'].header.pins, [{ id: 'c77', v: 3 }]);
  await s.stop();
  const next = loadGraph(root);
  assert.equal(next.loadReport.index.headers, 7);
  assert.deepStrictEqual(next.nodes.get('n6'), hand);
});

test('lazy bodies: the comment-seq and capture-seq floors come from the headers', (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  let reserved = 0;
  const elements = { reserveSeq(n) { reserved = Math.max(reserved, n); } };
  const state = createState();
  const g = loadGraph(root, { state, elements });
  assert.equal(reserved, 41, 'the highest comment seq');
  assert.ok(state.captureSeq >= 9, 'the highest capture seq');
  assert.equal(state.captureSeq, 9);
  assert.equal(g.lazyStats().faults, 0, 'with no body read');

  // A sidecar above them still raises the capture floor.
  fs.writeFileSync(path.join(projectPaths(root).captures, 'cap12.html'), '<p>x</p>');
  const state2 = createState();
  const g2 = loadGraph(root, { state: state2, elements });
  assert.equal(state2.captureSeq, 12);
  assert.equal(g2.lazyStats().faults, 0);

  // The floors read whole equal the floors from headers.
  let reservedWhole = 0;
  const stateWhole = createState();
  loadGraph(root, { state: stateWhole, indexPath: null, elements: { reserveSeq(n) { reservedWhole = Math.max(reservedWhole, n); } } });
  assert.equal(reservedWhole, 41);
  assert.equal(stateWhole.captureSeq, 12);
});

test('lazy bodies: the derived fields live in the index only, and pins are nodeDigest\'s inputs', (t) => {
  const root = tmpProject(t);
  commitFixture(root);
  const whole = loadGraph(root, { indexPath: null });
  const g = loadGraph(root);
  for (const [id, wh] of whole.nodes) {
    const lz = g.nodes.get(id);
    for (const k of DERIVED) {
      assert.ok(!(k in lz), `${id}: no ${k} on the node`);
      assert.ok(!(k in readFile(root, id)), `${id}: no ${k} in its file`);
    }
    const h = g.headerOf(id);
    assert.deepEqual(Object.keys(h).sort(), ['body_keys', 'capture_ids', 'max_capture_seq', 'max_comment_seq', 'pins']);
    const standIn = { id: lz.id, parent_id: lz.parent_id, created_at: lz.created_at, comments: h.pins };
    assert.equal(elementLog.nodeDigest(standIn), elementLog.nodeDigest(wh), `${id}: the digest from pins`);
    assert.deepEqual(h, whole.headerOf(id), `${id}: the stored header equals the one derived from the whole node`);
    const stored = readIndex(root).nodes[`${id}.json`].header;
    assert.deepEqual(stored, JSON.parse(JSON.stringify(headerOf(wh))), `${id}: the entry is headerOf(whole)`);
    assert.ok(!BODY_KEYS.some((k) => k in stored.node), `${id}: no body key in the header`);
  }
  assert.equal(g.lazyStats().faults, 0, 'headerOf reads no body');
  assert.deepEqual(g.headerOf('n2').capture_ids, ['cap9']);
  assert.deepEqual(g.headerOf('n1').pins, [{ id: 'c40', v: 1 }]);
  assert.deepEqual(g.headerOf('n3').pins, [{ id: 'c40', v: 1 }, { id: 'c41', v: null }]);

  // After a write, the file still carries no derived field.
  const n = g.nodes.get('n4');
  n.bookmarked = true;
  g.writeNode(n);
  for (const k of DERIVED) assert.ok(!(k in readFile(root, 'n4')));

  // A comment that is not a plain object makes pins null — read whole, then from the header.
  const odd = { ...readFile(root, 'n5'), id: 'n6', parent_id: 'n5', created_at: Date.now() + 1000, comments: [{ id: 'c1', seq: 1 }, 'not a pin'] };
  fs.writeFileSync(fileOf(root, 'n6'), JSON.stringify(odd));
  const g2 = loadGraph(root);
  assert.equal(g2.headerOf('n6').pins, null);
  assert.equal(g2.flushIndex(), true);
  const g3 = loadGraph(root);
  assert.equal(g3.loadReport.index.headers, 7);
  assert.equal(g3.headerOf('n6').pins, null, 'from the header, no body read');
  assert.equal(g3.lazyStats().faults, 0);
  assert.equal(headerOf({ id: 'n1', created_at: 1, comments: [null] }).pins, null);
  assert.deepEqual(headerOf({ id: 'n1', created_at: 1 }).pins, []);
});

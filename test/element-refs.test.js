'use strict';
// Element references on the live surface and the node (U326e; DECISIONS.md
// K.1 A2, E-STORE (a)): state.elements, a list of id@v strings
// (lib/server/domain/element-refs), rides graph.snapshotLive /
// restoreLiveToNode, the draft, the view key, the dirty check and commitNode —
// DEFAULT-FREE, so a surface without references is byte-identical to what it
// was at 39b52f8. No route writes references yet (U325's), so these tests seed
// state.elements directly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const { withServer, tmpRoot } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const { refsOf, setRefs } = require('../lib/server/domain/element-refs');
const turns = require('../lib/server/domain/turns');
const page = require('../lib/server/domain/page');
const { stableStringify } = require('../lib/core/stable-json');

// ── The 39b52f8 snapshotView, reproduced verbatim (lib/server/domain/turns.js
// :204-227 at that commit), so "every existing key is unchanged" is measured
// against the function as it was, not against itself.
function oldViewMount(m) {
  const out = { id: m.id, ...turns.hydrateMount(m) };
  const fsv = out.form_state;
  if (fsv && typeof fsv === 'object' && !Object.keys(fsv).length) out.form_state = undefined;
  return out;
}
function oldWithoutV(c) {
  if (!c || typeof c !== 'object' || !('v' in c)) return c;
  const { v, ...rest } = c;
  void v;
  return rest;
}
function oldSnapshotView(s) {
  const mounts = (s.mounts || [])
    .map(oldViewMount)
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  const markdown = (s.markdown || [])
    .map((m) => ({ id: m.id, ...page.hydrateMarkdown(m) }))
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  return stableStringify({
    mounts,
    markdown,
    order: page.pageOrder(s),
    layout: page.layoutFields(s),
    store: s.store || {},
    comments: (s.comments || []).map(oldWithoutV),
    captures: s.captures || [],
  });
}
const oldKey = (node) => crypto.createHash('sha1').update(oldSnapshotView(node || {})).digest('hex');

const nodeFile = (root, id) => path.join(root, '.web-chat', 'graph', `${id}.json`);
const readNode = (root, id) => JSON.parse(fs.readFileSync(nodeFile(root, id), 'utf8'));

async function turn(api, message, work) {
  await api.post('/api/turn-begin', { message });
  if (work) await work();
  return api.post('/api/turn-end', { author: 'claude' });
}

// ── The module ───────────────────────────────────────────────────────────────

test('refsOf: a copy of state.elements, [] when the field is absent', () => {
  assert.deepEqual(refsOf({}), []);
  assert.deepEqual(refsOf(null), []);
  const state = { elements: ['h5@1', 'g7@2'] };
  const got = refsOf(state);
  assert.deepEqual(got, ['h5@1', 'g7@2']);
  got.push('h9@1');
  assert.deepEqual(state.elements, ['h5@1', 'g7@2'], 'the copy is not the live list');
});

test('setRefs: keeps a copy of the non-empty strings that contain @, and nothing else', () => {
  const state = {};
  const list = ['h5@1', '', 'nope', 7, null, { id: 'h6' }, 'g2@3'];
  const set = setRefs(state, list);
  assert.deepEqual(state.elements, ['h5@1', 'g2@3']);
  assert.deepEqual(set, ['h5@1', 'g2@3']);
  list.length = 0;
  assert.deepEqual(state.elements, ['h5@1', 'g2@3'], 'the live list is a copy of the argument');
  setRefs(state, undefined);
  assert.deepEqual(state.elements, [], 'an absent list sets []');
});

// ── Default-free: nothing existing changes ──────────────────────────────────

test('every v3-fixture node and the v3 draft keeps its 39b52f8 nodeViewKey', () => {
  for (const opts of [{}, { scale: { nodes: 40, copies: 6, seed: 7 } }]) {
    const g = v3Graph(tmpRoot(), opts);
    assert.ok(g.nodes.length > 3);
    for (const n of g.nodes) {
      assert.equal(turns.nodeViewKey(n), oldKey(n), `node ${n.id}`);
      assert.equal(turns.snapshotView(n), oldSnapshotView(n), `node ${n.id}`);
    }
    if (g.draft) assert.equal(turns.snapshotView(g.draft), oldSnapshotView(g.draft));
  }
});

test('a fresh graph\'s nodes keep their 39b52f8 nodeViewKey, and the live snapshot projects as before', async (t) => {
  const { api, srv, root } = await withServer(t);
  await turn(api, 'one', async () => {
    await api.post('/api/render', { id: 'p1', html: '<p>p1</p>' });
    await api.post('/api/markdown', { id: 'md-title', text: '# Title' });
  });
  await turn(api, 'two', async () => {
    await api.post('/api/render', { id: 'p2', html: '<p>p2</p>', place: { span: 6 } });
    await api.post('/api/store', { patch: { k: 1 } });
    await api.post('/api/comments', { text: 'pin', anchor: { mount: 'p1', selector: 'p', text: 'p1', ordinal: 0 } });
  });
  assert.ok(srv.graph.nodes.size >= 2);
  for (const [id, n] of srv.graph.nodes) {
    assert.equal(turns.nodeViewKey(n), oldKey(n), `node ${id}`);
    const onDisk = readNode(root, id);
    assert.equal('elements' in onDisk, false, `node ${id}'s file carries no empty elements key`);
    assert.equal(turns.nodeViewKey(onDisk), oldKey(onDisk));
  }
  // The live snapshot always carries the list; its projection does not when empty.
  const snap = srv.graph.snapshotLive();
  assert.deepEqual(snap.elements, []);
  assert.equal(turns.snapshotView(snap), oldSnapshotView(snap));
  assert.equal(turns.liveIsDirty(srv.graph), false);
});

test('a node file with no references has exactly the 39b52f8 key set (no empty elements key)', async (t) => {
  const { api, root } = await withServer(t);
  const end = await turn(api, 'one', () => api.post('/api/render', { id: 'p1', html: '<p>p1</p>' }));
  const node = readNode(root, end.json.node_id);
  assert.deepEqual(Object.keys(node).filter((k) => ['mounts', 'store', 'comments', 'captures', 'elements'].includes(k)),
    ['mounts', 'store', 'comments', 'captures']);
});

// ── A reference is a change ─────────────────────────────────────────────────

test('a turn whose only change is one reference is dirty and commits a node holding it', async (t) => {
  const { api, srv, root } = await withServer(t);
  const a = await turn(api, 'base', () => api.post('/api/render', { id: 'p1', html: '<p>p1</p>' }));
  assert.ok(a.json.node_id);
  await api.post('/api/turn-begin', { message: 'highlight only' });
  srv.state.elements = ['h5@1'];
  assert.equal(turns.liveIsDirty(srv.graph), true, 'a reference alone makes the surface dirty');
  const b = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(b.json.node_id, `committed: ${JSON.stringify(b.json)}`);
  assert.notEqual(b.json.node_id, a.json.node_id);
  assert.deepEqual(readNode(root, b.json.node_id).elements, ['h5@1']);
  assert.deepEqual(srv.graph.nodes.get(b.json.node_id).elements, ['h5@1']);
  assert.equal(turns.liveIsDirty(srv.graph), false);
});

test('a turn with no reference change and no other change commits nothing (folds)', async (t) => {
  const { api, srv } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'refs' });
  srv.state.elements = ['h5@1', 'g2@1'];
  const first = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(first.json.node_id);
  const size = srv.graph.nodes.size;
  // The same references in another order are the same surface.
  srv.state.elements = ['g2@1', 'h5@1'];
  const r = await turn(api, 'chat only');
  assert.equal(r.json.skipped, 'no-change');
  assert.equal(srv.graph.nodes.size, size);
});

// ── Restore ──────────────────────────────────────────────────────────────────

test('Set active to an older node and back restores state.elements; a node without the field restores []', async (t) => {
  const { api, srv } = await withServer(t);
  const a = await turn(api, 'base', () => api.post('/api/render', { id: 'p1', html: '<p>p1</p>' }));
  await api.post('/api/turn-begin', { message: 'refs' });
  srv.state.elements = ['h5@1'];
  const b = await api.post('/api/turn-end', { author: 'claude' });
  assert.ok(b.json.node_id);

  const toA = await api.post('/api/graph/active', { id: a.json.node_id });
  assert.equal(toA.status, 200);
  assert.equal(srv.graph.active, a.json.node_id);
  assert.deepEqual(srv.state.elements, [], 'a node without the field restores []');

  const toB = await api.post('/api/graph/active', { id: b.json.node_id });
  assert.equal(toB.status, 200);
  assert.deepEqual(srv.state.elements, ['h5@1']);
  assert.equal(turns.liveIsDirty(srv.graph), false);
  // No preserve node was needed either way.
  assert.equal(srv.graph.nodes.size, 2);
});

// ── The draft ────────────────────────────────────────────────────────────────

test('a graceful stop writes the references into draft.json and the next boot restores them', async (t) => {
  const { api, srv, root, webChatDir, graceful } = await withServer(t);
  await turn(api, 'base', () => api.post('/api/render', { id: 'p1', html: '<p>p1</p>' }));
  srv.state.elements = ['h5@1', 'g3@2'];
  await graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(webChatDir, 'draft.json'), 'utf8'));
  assert.deepEqual(draft.elements, ['h5@1', 'g3@2']);

  const { srv: srv2 } = await withServer(t, { root });
  assert.deepEqual(srv2.state.elements, ['h5@1', 'g3@2']);
  assert.equal(turns.liveIsDirty(srv2.graph), true, 'the restored references are still uncommitted');
});

test('an otherwise empty surface with one reference writes a draft', async (t) => {
  const { srv, root, webChatDir, graceful } = await withServer(t);
  srv.state.elements = ['h5@1'];
  await graceful();
  const file = path.join(webChatDir, 'draft.json');
  assert.ok(fs.existsSync(file), 'a reference alone is a draft');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).elements, ['h5@1']);
  const { srv: srv2 } = await withServer(t, { root });
  assert.deepEqual(srv2.state.elements, ['h5@1']);
});

test('a draft without references carries no elements key (its bytes are unchanged)', async (t) => {
  const { api, webChatDir, graceful } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<p>p1</p>' });
  await graceful();
  const draft = JSON.parse(fs.readFileSync(path.join(webChatDir, 'draft.json'), 'utf8'));
  assert.equal('elements' in draft, false);
});

test('writeDraft / loadDraft round-trip the references without a server', () => {
  const dir = tmpRoot();
  const file = path.join(dir, 'draft.json');
  assert.equal(turns.writeDraft(file, null, { mounts: [], store: {}, comments: [], captures: [], queue: [], elements: [] }), false,
    'an empty list is no draft');
  assert.equal(turns.writeDraft(file, 'n1', { mounts: [], store: {}, comments: [], captures: [], queue: [], elements: ['h5@1'] }), true);
  const state = { mounts: new Map(), markdown: new Map(), order: [], claudeOrder: [], runs: {}, store: {}, comments: [], captures: [], captureSeq: 0, queue: [], queueSeq: 0, pendingWake: null, pendingWakeSeq: 0, pendingAck: null };
  turns.loadDraft(file, 'n1', state);
  assert.deepEqual(state.elements, ['h5@1']);
});

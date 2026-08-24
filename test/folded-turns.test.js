// Turns that change nothing commit no node — POST /api/turn-end.
//
// A node exists only where the SURFACE actually changed (liveIsDirty: mounts
// incl. per-pane theme, store, comments, captures). A chat-only turn releases
// the lock and accumulates its trigger on graph.pendingFolded instead; the next
// turn that DOES change something commits one node carrying those collapsed
// turns as `folded` / `folded_count`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer } = require('../test-support/helpers');
const turns = require('../lib/server/domain/turns');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');

// A whole turn, with an optional body of work in the middle.
async function turn(api, message, work) {
  await api.post('/api/turn-begin', { message: message || '' });
  if (work) await work();
  return api.post('/api/turn-end', { author: 'claude' });
}

async function graph(api) {
  return (await api.get('/api/graph')).json;
}

async function node(api, id) {
  return (await api.get(`/api/graph/node/${id}`)).json;
}

function metaPath(root) {
  return path.join(root, '.web-chat', 'graph', '_meta.json');
}

// ── The skip itself ────────────────────────────────────────────────────────

test('a turn that changes nothing commits no node and reports the skip', async (t) => {
  const { api } = await withServer(t);

  const r = await turn(api, 'just talking');
  assert.equal(r.status, 200);
  assert.equal(r.json.skipped, 'no-change', 'turn-end must not commit an unchanged surface');
  assert.equal(r.json.node_id, undefined);
  assert.equal(r.json.accumulated, 1);

  const g = await graph(api);
  assert.equal(g.nodes.length, 0, 'no node was created');
  assert.equal(g.active, null);
  assert.equal(g.lock, null, 'the lock is released even though nothing committed');
  assert.equal(g.pending_folded, 1);
});

test('a run of chat-only turns produces ONE node, carrying all of them as folded', async (t) => {
  const { api } = await withServer(t);

  await turn(api, 'chat one');
  await turn(api, 'chat two');
  await turn(api, 'chat three');
  assert.equal((await graph(api)).nodes.length, 0, 'three chat turns, zero nodes');
  assert.equal((await graph(api)).pending_folded, 3);

  await turn(api, 'now render', () => api.post('/api/render', { id: 'p1', html: '<p>hi</p>' }));

  const g = await graph(api);
  assert.equal(g.nodes.length, 1, 'the whole run collapses into a single node');
  assert.equal(g.pending_folded, 0, 'the accumulator drained onto the node');

  const n = await node(api, g.active);
  assert.equal(n.trigger.message, 'now render', "the node's own trigger is the turn that changed something");
  assert.equal(n.folded_count, 3);
  assert.deepEqual(n.folded.map((f) => f.message), ['chat one', 'chat two', 'chat three']);
  assert.deepEqual(n.folded.map((f) => f.kind), ['turn', 'turn', 'turn']);
  assert.equal(n.folded[0].author, 'claude');
  assert.ok(n.folded[0].at > 0);

  // and the collapsed count is visible from the topology (what get_graph reads)
  assert.equal(g.nodes[0].folded_count, 3);
});

test('an ordinary node reports folded_count 0 and carries no folded array', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'render', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));
  const g = await graph(api);
  assert.equal(g.nodes[0].folded_count, 0);
  const n = await node(api, g.active);
  assert.equal(n.folded, undefined);
});

// ── Conservative about what counts as "no change" ──────────────────────────

test('a store-only turn still commits — the store is part of the surface', async (t) => {
  const { api } = await withServer(t);
  const r = await turn(api, 'set a key', () => api.post('/api/store', { patch: { k: 'v' } }));
  assert.equal(r.json.skipped, undefined);
  assert.ok(r.json.node_id, 'a store write is a surface change');
});

test('a pane-theme-only turn still commits — the theme rides the mount', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'render', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));

  const r = await turn(api, 'theme it', () =>
    api.post('/api/theme', { scope: 'pane', target: 'p1', tokens: { '--wc-accent': '#f00' } }));
  assert.equal(r.json.skipped, undefined);
  assert.ok(r.json.node_id, 'a per-pane theme change is a surface change');
});

test('a turn that renders then clears back to the starting state is correctly skipped', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'render', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));
  const before = (await graph(api)).nodes.length;

  const r = await turn(api, 'churn', async () => {
    await api.post('/api/render', { id: 'tmp', html: '<p>scratch</p>' });
    await api.post('/api/clear', { id: 'tmp' });
  });
  assert.equal(r.json.skipped, 'no-change');
  assert.equal((await graph(api)).nodes.length, before, 'net-zero work leaves no node');
});

// ── Re-aim: a superseded context must not be stapled onto a later node ─────

test('set-active after skipped turns DISCARDS them — the commit point moved', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'first', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));
  const n0 = (await graph(api)).active;
  await turn(api, 'second', () => api.post('/api/render', { id: 'p2', html: '<p>b</p>' }));

  await turn(api, 'chat about it');
  assert.equal((await graph(api)).pending_folded, 1);

  await api.post('/api/graph/active', { id: n0 });
  assert.equal((await graph(api)).pending_folded, 0, 'a re-aim drops the superseded turns');

  await turn(api, 'work here', () => api.post('/api/render', { id: 'p3', html: '<p>c</p>' }));
  const g = await graph(api);
  const fresh = await node(api, g.active);
  assert.equal(fresh.folded, undefined, 'turns from the old context are not attached here');
  assert.equal(fresh.folded_count, undefined);
});

test('new graph after skipped turns discards them too', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'first', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));
  await turn(api, 'chat');
  assert.equal((await graph(api)).pending_folded, 1);
  await api.post('/api/graph/new', { name: 'Research' });
  assert.equal((await graph(api)).pending_folded, 0);
});

test('branch-here with dirty live state hands the skipped turns to the preserve node', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'first', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));
  const n0 = (await graph(api)).active;
  await turn(api, 'second', () => api.post('/api/render', { id: 'p2', html: '<p>b</p>' }));

  await turn(api, 'chat about it');
  // uncommitted work on the current context
  await api.post('/api/render', { id: 'p3', html: '<p>wip</p>' });

  const r = await api.post('/api/graph/branch-here', { id: n0 });
  assert.ok(r.json.preserved, 'dirty live state was preserved');
  const preserved = await node(api, r.json.preserved);
  assert.equal(preserved.folded_count, 1, 'the preserve node IS this context’s commit');
  assert.equal(preserved.folded[0].message, 'chat about it');
  assert.equal((await graph(api)).pending_folded, 0);
});

test('a re-aim QUEUED during a skipped turn still applies, and discards the turn', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'first', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));
  const n0 = (await graph(api)).active;
  await turn(api, 'second', () => api.post('/api/render', { id: 'p2', html: '<p>b</p>' }));

  await api.post('/api/turn-begin', { message: 'chat' });
  const q = await api.post('/api/graph/active', { id: n0 });
  assert.equal(q.json.pending, true, 'a re-aim during a live turn queues');

  const end = await api.post('/api/turn-end', { author: 'claude' });
  assert.equal(end.json.skipped, 'no-change');
  assert.deepEqual(end.json.reaim, { op: 'set-active', id: n0, ok: true });
  const g = await graph(api);
  assert.equal(g.active, n0, 'the queued re-aim applied even though nothing committed');
  assert.equal(g.pending_folded, 0, 'and it took the superseded turn with it');
});

// ── Bookmarks ride across skipped turns ───────────────────────────────────

test('a wipe that actually empties the page IS a change — the next turn commits', async (t) => {
  const { api } = await withServer(t);
  await turn(api, 'first', () => api.post('/api/render', { id: 'p1', html: '<p>a</p>' }));

  await api.post('/api/graph/wipe', {});
  const r = await turn(api, 'chat after the wipe');
  assert.equal(r.json.skipped, undefined, 'the emptied page differs from the active node');
  assert.ok(r.json.node_id);
  const n = await node(api, r.json.node_id);
  assert.deepEqual(n.mounts, []);
  assert.equal(n.bookmarked, true);
});

test('a wipe that changes nothing, then no-change turns: the bookmark rides to the eventual node', async (t) => {
  const { api } = await withServer(t);
  // A node with store content but no panes — so the wipe is a genuine no-op on
  // the surface, which is the sharp case: it must still bookmark.
  await turn(api, 'first', () => api.post('/api/store', { patch: { k: 'v' } }));

  await api.post('/api/graph/wipe', { name: 'fresh start' });
  await turn(api, 'chat one');
  await turn(api, 'chat two');
  assert.equal((await graph(api)).nodes.length, 1, 'the chat turns committed nothing');
  assert.equal((await graph(api)).pending_folded, 2, 'a wipe keeps the lineage, so it keeps the turns');

  await turn(api, 'render at last', () => api.post('/api/render', { id: 'p2', html: '<p>b</p>' }));
  const g = await graph(api);
  const fresh = g.nodes.find((n) => n.id === g.active);
  assert.equal(fresh.bookmarked, true, 'the bookmark waited for the first node with real content');
  assert.equal(fresh.name, 'fresh start');
  assert.equal(fresh.folded_count, 2);
});

// ── Durability ─────────────────────────────────────────────────────────────

test('accumulated turns (and a pending bookmark) survive a daemon restart', async (t) => {
  const { api, root, graceful } = await withServer(t);
  await turn(api, 'first', () => api.post('/api/store', { patch: { k: 'v' } }));
  await api.post('/api/graph/wipe', { name: 'take two' });
  await turn(api, 'chat one');
  await turn(api, 'chat two');

  const meta = JSON.parse(fs.readFileSync(metaPath(root), 'utf8'));
  assert.equal(meta.pending_folded.length, 2, 'the accumulator is persisted in graph/_meta.json');
  assert.deepEqual(meta.pending_bookmark, { name: 'take two' });

  await graceful();
  const { api: api2 } = await withServer(t, { root });

  assert.equal((await graph(api2)).pending_folded, 2, 'restored on boot');
  await turn(api2, 'render after reboot', () => api2.post('/api/render', { id: 'p2', html: '<p>b</p>' }));
  const g = await graph(api2);
  const fresh = await node(api2, g.active);
  assert.equal(fresh.folded_count, 2);
  assert.deepEqual(fresh.folded.map((f) => f.message), ['chat one', 'chat two']);
  assert.equal(fresh.bookmarked, true);
  assert.equal(fresh.name, 'take two');
});

test('an _meta.json written before this feature loads as "nothing pending"', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-folded-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const graphDir = path.join(dir, 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  const meta = path.join(graphDir, '_meta.json');
  fs.writeFileSync(meta, JSON.stringify({ active: null, lock: null }));

  const g = createGraph({ paths: { GRAPH_DIR: graphDir, META_PATH: meta }, state: createState() });
  g.load();
  assert.deepEqual(g.pendingFolded, []);
  assert.equal(g.pendingFoldedDropped, 0);
  assert.equal(g.pendingBookmark, null);
});

// ── The cap ────────────────────────────────────────────────────────────────

test('the accumulator is bounded: oldest drop, folded_count stays honest', () => {
  const g = { pendingFolded: [], pendingFoldedDropped: 0 };
  const total = turns.MAX_FOLDED + 5;
  for (let i = 0; i < total; i++) turns.accumulateFolded(g, { message: `t${i}` });

  assert.equal(g.pendingFolded.length, turns.MAX_FOLDED, 'bounded — _meta.json cannot grow forever');
  assert.equal(g.pendingFolded[0].message, 't5', 'the OLDEST entries are the ones dropped');
  assert.equal(g.pendingFoldedDropped, 5);

  const node = {};
  turns.applyFolded(g, node);
  assert.equal(node.folded.length, turns.MAX_FOLDED);
  assert.equal(node.folded_count, total, 'the count reports every collapsed turn, not just the retained ones');
  assert.deepEqual(g.pendingFolded, [], 'draining clears the slot');
  assert.equal(g.pendingFoldedDropped, 0);
});

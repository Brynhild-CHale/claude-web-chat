// Set active preserves — POST /api/graph/active. A previewed node is read-only
// (plan §2b D2); making it active is the ONE gesture that moves the commit point
// onto it, so it carries what branch-on-edit (the retired POST
// /api/graph/branch-here) used to guarantee: any DIRTY live state is first
// auto-committed as a user-authored 'preserve' node (nothing uncommitted is ever
// lost), then active re-aims; the next commit lands as a branch child and the
// original node's downstream stays intact (append-only).

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');

async function nodesById(api) {
  const g = await api.get('/api/graph');
  const out = new Map();
  for (const n of g.json.nodes) out.set(n.id, n);
  return { nodes: out, active: g.json.active };
}

test('set-active: dirty live state is auto-preserved, then active re-aims', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  const c2 = await api.post('/api/commit', { message: 'two' });

  // live now diverges from the active node (uncommitted render)
  await api.post('/api/render', { id: 'b', html: '<p>wip</p>' });
  const r = await api.post('/api/graph/active', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.ok(r.json.preserved, 'dirty live state committed as a preserve node');
  assert.equal(r.json.active, c1.json.node_id);

  const { nodes, active } = await nodesById(api);
  assert.equal(active, c1.json.node_id);
  const preserved = nodes.get(r.json.preserved);
  assert.equal(preserved.parent_id, c2.json.node_id, 'preserve node extends the old lineage');
  assert.equal(preserved.author, 'user');

  const full = await api.get('/api/graph/node/' + r.json.preserved);
  assert.equal(full.json.trigger.kind, 'preserve');
  assert.deepEqual(full.json.mounts.map((x) => x.id).sort(), ['a', 'b'], 'the uncommitted pane rides the preserve node');

  // live surface now mirrors the re-aimed node
  const m = await api.get('/api/mounts');
  assert.deepEqual(m.json.mounts.map((x) => x.id), ['a']);

  // the next commit branches off the edited node; downstream (c2) is untouched
  await api.post('/api/render', { id: 'a', html: '<p>edited</p>' });
  const c3 = await api.post('/api/commit', { message: 'branch edit' });
  const after = await nodesById(api);
  assert.equal(after.nodes.get(c3.json.node_id).parent_id, c1.json.node_id);
  assert.ok(after.nodes.get(c2.json.node_id), 'original downstream node preserved');
});

test('set-active: clean live state re-aims without a preserve commit', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'two' });

  // live === active node (the commit just snapshotted it) → nothing to preserve
  const r = await api.post('/api/graph/active', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.equal(r.json.preserved, null);
  assert.equal(r.json.active, c1.json.node_id);
});

test('set-active: a fresh turn lock queues a pending re-aim; unknown node 404s', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'two' });

  assert.equal((await api.post('/api/graph/active', { id: 'nope' })).status, 404);

  await api.post('/api/turn-begin', { message: 'working' });
  const r = await api.post('/api/graph/active', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.equal(r.json.pending, true);
  // still parked: active hasn't moved
  assert.notEqual((await api.get('/api/graph')).json.active, c1.json.node_id);

  // turn-end commits on the lock base, THEN applies the queued set-active
  const te = await api.post('/api/turn-end', {});
  assert.equal(te.json.reaim.op, 'set-active');
  assert.equal(te.json.reaim.ok, true);
  const g = await api.get('/api/graph');
  assert.equal(g.json.active, c1.json.node_id);
  assert.equal(g.json.lock, null);
});

test('the branch-on-edit route is gone — a preview edit can no longer re-aim', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  const r = await api.post('/api/graph/branch-here', { id: c1.json.node_id });
  assert.equal(r.status, 404, 'POST /api/graph/branch-here was retired with branch-on-edit (D2)');
});

// data-1: Set active onto the node that is already active is a no-op. Before,
// the preserve commit stepped active onto the preserve node and the re-aim
// stepped it straight back — the live work left the surface and the next commit
// forked off the old node.
test('set-active on the already-active node: no preserve, no move, live work untouched', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'b', html: '<p>wip</p>' });

  const r = await api.post('/api/graph/active', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.equal(r.json.unchanged, true);
  assert.equal(r.json.preserved, null);
  assert.equal(r.json.active, c1.json.node_id);

  const { nodes, active } = await nodesById(api);
  assert.equal(active, c1.json.node_id);
  assert.equal(nodes.size, 1, 'no preserve node was committed');
  const m = await api.get('/api/mounts');
  assert.deepEqual(m.json.mounts.map((x) => x.id).sort(), ['a', 'b'], 'the uncommitted pane is still live');

  // the next commit continues from the active node with the live work in it
  const c2 = await api.post('/api/commit', { message: 'two' });
  assert.equal((await nodesById(api)).nodes.get(c2.json.node_id).parent_id, c1.json.node_id);
});

test('set-active on the already-active node mid-turn is not queued — the turn lands and stays', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });

  await api.post('/api/turn-begin', { message: 'working' });
  const r = await api.post('/api/graph/active', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.equal(r.json.unchanged, true);
  assert.ok(!r.json.pending, 'a no-op is never queued');

  await api.post('/api/render', { id: 'b', html: '<p>claude</p>' });
  const te = await api.post('/api/turn-end', {});
  assert.ok(te.json.node_id);
  assert.equal(te.json.reaim, undefined, 'nothing queued to apply');
  assert.equal((await api.get('/api/graph')).json.active, te.json.node_id, "active stays on Claude's turn");
  const m = await api.get('/api/mounts');
  assert.deepEqual(m.json.mounts.map((x) => x.id).sort(), ['a', 'b']);
});

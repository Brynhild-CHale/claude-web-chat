// Branch-on-edit — POST /api/graph/branch-here: the user edited a form while
// previewing an older node. The server auto-commits any DIRTY live state as a
// user-authored 'preserve' node (nothing uncommitted is ever lost), then
// re-aims active onto the edited node; the next commit lands as a branch child
// and the original node's downstream stays intact (append-only).

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');

async function nodesById(api) {
  const g = await api.get('/api/graph');
  const out = new Map();
  for (const n of g.json.nodes) out.set(n.id, n);
  return { nodes: out, active: g.json.active };
}

test('branch-here: dirty live state is auto-preserved, then active re-aims', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  const c2 = await api.post('/api/commit', { message: 'two' });

  // live now diverges from the active node (uncommitted render)
  await api.post('/api/render', { id: 'b', html: '<p>wip</p>' });
  const r = await api.post('/api/graph/branch-here', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.ok(r.json.preserved, 'dirty live state committed as a preserve node');
  assert.equal(r.json.active, c1.json.node_id);

  const { nodes, active } = await nodesById(api);
  assert.equal(active, c1.json.node_id);
  const preserved = nodes.get(r.json.preserved);
  assert.equal(preserved.parent_id, c2.json.node_id, 'preserve node extends the old lineage');
  assert.equal(preserved.author, 'user');

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

test('branch-here: clean live state re-aims without a preserve commit', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'two' });

  // live === active node (the commit just snapshotted it) → nothing to preserve
  const r = await api.post('/api/graph/branch-here', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.equal(r.json.preserved, null);
  assert.equal(r.json.active, c1.json.node_id);
});

test('branch-here: a fresh turn lock queues a pending re-aim; unknown node 404s', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'two' });

  assert.equal((await api.post('/api/graph/branch-here', { id: 'nope' })).status, 404);

  await api.post('/api/turn-begin', { message: 'working' });
  const r = await api.post('/api/graph/branch-here', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.equal(r.json.pending, true);
  // still parked: active hasn't moved
  assert.notEqual((await api.get('/api/graph')).json.active, c1.json.node_id);

  // turn-end commits on the lock base, THEN applies the queued branch-here
  const te = await api.post('/api/turn-end', {});
  assert.equal(te.json.reaim.op, 'branch-here');
  assert.equal(te.json.reaim.ok, true);
  const g = await api.get('/api/graph');
  assert.equal(g.json.active, c1.json.node_id);
  assert.equal(g.json.lock, null);
});

// Set active preserves — POST /api/graph/active. A previewed node is read-only
// (plan §2b D2); making it active is the ONE gesture that moves the commit point
// onto it, so it carries what branch-on-edit (the retired POST
// /api/graph/branch-here) used to guarantee: any DIRTY live state is first
// auto-committed as a user-authored 'preserve' node (nothing uncommitted is ever
// lost), then active re-aims; the next commit lands as a branch child and the
// original node's downstream stays intact (append-only).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withServer } = require('../test-support/helpers');

// A server whose turn lock goes stale in `ms`. LOCK_TTL_MS is read at
// domain/turns LOAD, so every lib/server module is evicted and re-required
// (test/lock-ttl.test.js's shortTtlServer, which explains why it is the whole
// directory); env var and cache are restored on t.after.
const SERVER_DIR = path.join(__dirname, '..', 'lib', 'server') + path.sep;
const bustServerModules = () => {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SERVER_DIR)) delete require.cache[k];
};
function shortTtlServer(t, ms) {
  const prev = process.env.WEB_CHAT_LOCK_TTL_MS;
  process.env.WEB_CHAT_LOCK_TTL_MS = String(ms);
  bustServerModules();
  t.after(() => {
    if (prev === undefined) delete process.env.WEB_CHAT_LOCK_TTL_MS; else process.env.WEB_CHAT_LOCK_TTL_MS = prev;
    bustServerModules();
  });
  return require('../lib/server').createServer;
}
// A real elapsed wait: the assertion is that the TTL has passed.
const elapse = (ms) => new Promise((r) => setTimeout(r, ms));

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

// R3-2: "stay here" is judged against the node the user was looking at, BEFORE
// the stale-lock steal. The steal commits the abandoned turn as a preserve node
// and moves active onto it; compared after, a click on the old active became a
// real re-aim — the work left the surface, the next commit forked off the old
// node, and the reply said `preserved:null` although a node had just been made.
test('set-active on the node that was active, under a STALE lock: the work stays live and the reply names the preserve node', async (t) => {
  const { api } = await withServer(t, { createServer: shortTtlServer(t, 150) });
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });

  await api.post('/api/turn-begin', { message: 'a turn that never Stops' });
  await api.post('/api/render', { id: 'b', html: '<p>half-finished</p>' });
  await elapse(300);

  const r = await api.post('/api/graph/active', { id: c1.json.node_id });
  assert.equal(r.status, 200);
  assert.ok(r.json.preserved, 'the steal kept the abandoned work as a node, and the reply says which');
  assert.notEqual(r.json.preserved, c1.json.node_id);
  assert.equal(r.json.active, r.json.preserved, 'active is the preserve node — it holds exactly the page the user was on');

  const { nodes, active } = await nodesById(api);
  assert.equal(active, r.json.preserved);
  assert.equal(nodes.get(r.json.preserved).parent_id, c1.json.node_id);
  const full = await api.get('/api/graph/node/' + r.json.preserved);
  assert.equal(full.json.trigger.kind, 'preserve');
  assert.deepEqual(full.json.mounts.map((x) => x.id).sort(), ['a', 'b']);
  const m = await api.get('/api/mounts');
  assert.deepEqual(m.json.mounts.map((x) => x.id).sort(), ['a', 'b'], 'the live surface keeps the work');
  assert.equal((await api.get('/api/graph')).json.lock, null, 'the stale lock is gone');

  // …and the next commit continues from it rather than forking off the old node
  const c2 = await api.post('/api/commit', { message: 'next' });
  assert.equal((await nodesById(api)).nodes.get(c2.json.node_id).parent_id, r.json.preserved);
});

test('wipe and new-graph that steal a stale lock also say where the abandoned work went', async (t) => {
  const { api } = await withServer(t, { createServer: shortTtlServer(t, 150) });
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  await api.post('/api/commit', { message: 'one' });

  await api.post('/api/turn-begin', { message: 'a turn that never Stops' });
  await api.post('/api/render', { id: 'b', html: '<p>half-finished</p>' });
  await elapse(300);
  const w = await api.post('/api/graph/wipe', { name: 'fresh' });
  assert.equal(w.status, 200);
  assert.ok(w.json.preserved, 'the wipe reports the preserve node its steal committed');
  const pw = await api.get('/api/graph/node/' + w.json.preserved);
  assert.ok(pw.json.mounts.some((x) => x.id === 'b'));
  assert.deepEqual((await api.get('/api/mounts')).json.mounts, [], 'and still wipes');

  await api.post('/api/turn-begin', { message: 'another turn that never Stops' });
  await api.post('/api/render', { id: 'c', html: '<p>more</p>' });
  await elapse(300);
  const n = await api.post('/api/graph/new', { name: 'next' });
  assert.equal(n.status, 200);
  assert.ok(n.json.preserved, 'new-graph reports it too');
  const pn = await api.get('/api/graph/node/' + n.json.preserved);
  assert.ok(pn.json.mounts.some((x) => x.id === 'c'));
  assert.equal(n.json.active, null);

  // Nothing to preserve → an explicit null, like set-active's.
  const w2 = await api.post('/api/graph/wipe', {});
  assert.equal(w2.json.preserved, null);
});

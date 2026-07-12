const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');

async function render(api, id) {
  return api.post('/api/render', { id, html: `<div>${id}</div>` });
}
async function turn(api) {
  await api.post('/api/turn-begin', {});
  return api.post('/api/turn-end', { author: 'claude', summary: 't' });
}

test('labels: fresh install starts blank, first turn yields n1.0', async (t) => {
  const { api } = await withServer(t);

  let g = (await api.get('/api/graph')).json;
  assert.equal(g.active, null);
  assert.equal(g.nodes.length, 0);

  await render(api, 'p1');
  await turn(api);
  g = (await api.get('/api/graph')).json;
  assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].label, 'n1.0');
  assert.equal(g.nodes[0].parent_id, null);
  assert.equal(g.active_label, 'n1.0');
});

test('labels: trunk increments, branch appends, existing labels stay stable', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1'); await turn(api);   // n1.0
  await render(api, 'p2'); await turn(api);   // n1.1
  await render(api, 'p3'); await turn(api);   // n1.2

  let g = (await api.get('/api/graph')).json;
  const labelById = Object.fromEntries(g.nodes.map(n => [n.id, n.label]));
  assert.deepEqual([...new Set(Object.values(labelById))].sort(), ['n1.0', 'n1.1', 'n1.2']);

  // branch off the first trunk child (label n1.1)
  const n11 = g.nodes.find(n => n.label === 'n1.1');
  await api.post('/api/graph/active', { id: n11.id });
  await render(api, 'pb'); await turn(api);

  g = (await api.get('/api/graph')).json;
  const after = Object.fromEntries(g.nodes.map(n => [n.id, n.label]));
  // stability: the three original trunk nodes keep their labels
  for (const id of Object.keys(labelById)) {
    assert.equal(after[id], labelById[id], `label for ${id} must not change`);
  }
  // the new node is a branch child of n1.1 → n1.1.0
  const branchLabels = g.nodes.map(n => n.label).filter(l => !['n1.0', 'n1.1', 'n1.2'].includes(l));
  assert.deepEqual(branchLabels, ['n1.1.0']);
});

test('wipe: clears panes but stays on the same graph and bookmarks the next node', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1'); await turn(api);   // n1.0
  await render(api, 'p2'); await turn(api);   // n1.1
  await api.post('/api/store', { patch: { keep: 'me' } });

  let g = (await api.get('/api/graph')).json;
  const activeBefore = g.active;
  assert.ok(activeBefore, 'there is an active node before wipe');

  const w = await api.post('/api/graph/wipe', {});
  assert.equal(w.status, 200);
  assert.equal(w.json.active, activeBefore, 'wipe keeps active — same graph');

  g = (await api.get('/api/graph')).json;
  assert.equal(g.active, activeBefore);
  // store survives the wipe (panes only)
  assert.equal((await api.get('/api/store')).json.keep, 'me');

  // a turn on the now-blank surface CONTINUES the same tree (n1.2), not a new root
  await render(api, 'pn'); await turn(api);
  g = (await api.get('/api/graph')).json;
  const roots = g.nodes.filter(n => n.parent_id === null);
  assert.equal(roots.length, 1, 'wipe did not branch a new graph');
  const fresh = g.nodes.find(n => n.label === 'n1.2');
  assert.ok(fresh, 'next node continues the trunk');
  assert.equal(fresh.bookmarked, true, 'the fresh-start node is bookmarked');
});

test('new graph: starts a new top-level tree and bookmarks its root with the given name', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1'); await turn(api);   // n1.0
  await render(api, 'p2'); await turn(api);   // n1.1
  const before = Object.fromEntries((await api.get('/api/graph')).json.nodes.map(n => [n.id, n.label]));

  const r = await api.post('/api/graph/new', { name: 'Research' });
  assert.equal(r.status, 200);
  assert.equal(r.json.active, null);
  assert.equal(r.json.name, 'Research');
  assert.equal((await api.get('/api/graph')).json.active, null);

  // the next turn creates a new root → n2.0, bookmarked with the graph name
  await render(api, 'pn'); await turn(api);
  const g = (await api.get('/api/graph')).json;
  const roots = g.nodes.filter(n => n.parent_id === null);
  assert.equal(roots.length, 2);
  const newRoot = roots.find(n => !(n.id in before));
  assert.equal(newRoot.label, 'n2.0');
  assert.equal(newRoot.bookmarked, true);
  assert.equal(newRoot.name, 'Research');
  // first tree unchanged
  for (const id of Object.keys(before)) {
    assert.equal(g.nodes.find(n => n.id === id).label, before[id]);
  }
});

test('new graph with no name: new root is bookmarked but unnamed', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1'); await turn(api);   // n1.0
  await api.post('/api/graph/new', {});
  await render(api, 'pn'); await turn(api);
  const g = (await api.get('/api/graph')).json;
  const newRoot = g.nodes.find(n => n.label === 'n2.0');
  assert.ok(newRoot);
  assert.equal(newRoot.bookmarked, true);
  assert.equal(newRoot.name, '');
});

test('navigation: restoring a node without a queued pin dequeues the stranded item', async (t) => {
  const { api } = await withServer(t);

  await render(api, 'p1'); await turn(api);   // n1.0 — committed with no comments
  await render(api, 'p2'); await turn(api);   // n1.1 — active, no comments

  const g = (await api.get('/api/graph')).json;
  const n10 = g.nodes.find(n => n.label === 'n1.0');

  // A shared pin on the live surface (active n1.1) enqueues a comment item.
  const pin = (await api.post('/api/comments', {
    text: 'look here', shared: true,
    anchor: { mount: 'p2', selector: 'div', text: 'p2', ordinal: 0 },
  })).json.pin;
  const item = (await api.get('/api/queue')).json.items.find(it => it.comment_id === pin.id);
  assert.ok(item, 'the shared pin enqueued a comment item');

  // Navigate to n1.0, whose committed comments do NOT include this pin — the
  // live queue item is now stranded and must be dropped on restore.
  const nav = await api.post('/api/graph/active', { id: n10.id });
  assert.equal(nav.json.ok, true);

  const after = (await api.get('/api/queue')).json;
  assert.equal(after.items.some(it => it.id === item.id), false, 'stranded comment item dequeued on navigation');

  // …and it left via the canonical queue-remove event, not a silent drop.
  const events = (await api.get('/api/events')).json.events;
  assert.ok(
    events.some(e => e.kind === 'queue' && e.op === 'remove' && e.id === item.id),
    'a queue-remove event was emitted for the stranded item',
  );
});

test('bookmark: sets fields, surfaces in topology, persists across restart', async (t) => {
  const { api, root, graceful } = await withServer(t);

  await render(api, 'p1'); await turn(api);
  let g = (await api.get('/api/graph')).json;
  const id = g.nodes[0].id;

  const b = await api.post('/api/graph/bookmark', { id, name: 'milestone' });
  assert.equal(b.status, 200);
  assert.equal(b.json.bookmarked, true);

  g = (await api.get('/api/graph')).json;
  const n = g.nodes.find(n => n.id === id);
  assert.equal(n.bookmarked, true);
  assert.equal(n.name, 'milestone');

  // un-bookmark with empty name
  await api.post('/api/graph/bookmark', { id, name: '' });
  let nd = (await api.get('/api/graph/node/' + id)).json;
  assert.equal(nd.bookmarked, false);

  // re-bookmark, then restart and confirm persistence
  await api.post('/api/graph/bookmark', { id, name: 'final' });
  await graceful();

  const { api: api2 } = await withServer(t, { root });
  nd = (await api2.get('/api/graph/node/' + id)).json;
  assert.equal(nd.bookmarked, true);
  assert.equal(nd.name, 'final');
});

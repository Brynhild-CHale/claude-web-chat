const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { withServer } = require('../test-support/helpers');

test('pane_state survives restoreLiveToNode', async (t) => {
  const { api, root } = await withServer(t);

  const r1 = await api.post('/api/render', { id: 'p1', html: '<div>hello</div>' });
  assert.equal(r1.json.id, 'p1');

  // Fresh installs start blank (no auto n0); commit the live state so a node
  // file is written. The first commit takes seq 0 → n0.json.
  await api.post('/api/commit', { message: 'seed' });

  const { resolvePaths } = require('../lib/server/paths');
  const paths = resolvePaths(root);
  const graphFiles = fs.readdirSync(paths.GRAPH_DIR);
  assert.ok(graphFiles.includes('n0.json'));
});

test('graph.restoreLiveToNode copies pane_state', () => {
  const { createGraph } = require('../lib/server/graph');
  const state = { store: {}, mounts: new Map() };
  const fakePaths = { GRAPH_DIR: '/tmp/non-existent', META_PATH: '/tmp/non-existent/_meta.json' };
  const g = createGraph({ paths: fakePaths, state });
  g.nodes.set('test', {
    id: 'test', parent_id: null, created_at: 1, author: 'test',
    mounts: [{ id: 'm1', html: 'x', target: 'main', pane_state: { colSpan: 6, locked: true } }],
    store: {},
  });
  g.restoreLiveToNode('test');
  const m = state.mounts.get('m1');
  assert.ok(m);
  assert.deepEqual(m.pane_state, { colSpan: 6, locked: true });
});

test('snapshot/restore deep-copy pins — no replies/anchor aliasing to stored nodes', () => {
  const { createGraph } = require('../lib/server/graph');
  const fakePaths = { GRAPH_DIR: '/tmp/non-existent', META_PATH: '/tmp/non-existent/_meta.json' };

  // snapshotLive must not hand the stored node a live reference to share back.
  const liveState = {
    store: {}, mounts: new Map(), captures: [], queue: [],
    comments: [{ id: 'c1', text: 'root', anchor: { mount: 'm1', text: 'x' }, replies: [{ author: 'user', text: 'r1' }] }],
  };
  const snap = createGraph({ paths: fakePaths, state: liveState }).snapshotLive();
  assert.notStrictEqual(snap.comments[0], liveState.comments[0]);
  assert.notStrictEqual(snap.comments[0].replies, liveState.comments[0].replies, 'replies array copied');
  assert.notStrictEqual(snap.comments[0].replies[0], liveState.comments[0].replies[0], 'reply object copied');
  assert.notStrictEqual(snap.comments[0].anchor, liveState.comments[0].anchor, 'anchor object copied');

  // restoreLiveToNode must not alias the stored node back into live state.
  const restoreState = { store: {}, mounts: new Map(), captures: [], queue: [] };
  const g = createGraph({ paths: fakePaths, state: restoreState });
  const node = {
    id: 'n', parent_id: null, created_at: 1, author: 'x', mounts: [], store: {},
    comments: [{ id: 'c1', text: 'root', anchor: { mount: 'm1' }, replies: [{ author: 'claude', text: 'a' }] }],
  };
  g.nodes.set('n', node);
  g.restoreLiveToNode('n');
  assert.notStrictEqual(restoreState.comments[0].replies, node.comments[0].replies, 'restored replies array copied');
  assert.notStrictEqual(restoreState.comments[0].replies[0], node.comments[0].replies[0], 'restored reply object copied');
  assert.notStrictEqual(restoreState.comments[0].anchor, node.comments[0].anchor, 'restored anchor object copied');
  assert.equal(restoreState.comments[0].replies[0].text, 'a', 'content still round-trips');
});

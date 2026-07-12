const test = require('node:test');
const assert = require('node:assert');
const { createGraph } = require('../lib/server/graph');
const { diffNodes } = require('../lib/server/diff');
const { withServer } = require('../test-support/helpers');

test('pane mode: restoreLiveToNode copies pane_state.mode', () => {
  const state = { store: {}, mounts: new Map() };
  const fakePaths = { GRAPH_DIR: '/tmp/wc-non-existent-pm', META_PATH: '/tmp/wc-non-existent-pm/_meta.json' };
  const g = createGraph({ paths: fakePaths, state });
  g.nodes.set('t', {
    id: 't', parent_id: null, created_at: 1, author: 't',
    mounts: [{ id: 'm1', html: 'x', target: 'main', pane_state: { colSpan: 6, mode: 'expanded' } }],
    store: {},
  });
  g.restoreLiveToNode('t');
  assert.equal(state.mounts.get('m1').pane_state.mode, 'expanded');
});

test('pane mode: diffNodes flags a pane_state change when only mode differs', () => {
  const a = { mounts: [{ id: 'm1', html: 'x', target: 'main', pane_state: { mode: 'reduced' } }], store: {} };
  const b = { mounts: [{ id: 'm1', html: 'x', target: 'main', pane_state: { mode: 'expanded' } }], store: {} };
  const d = diffNodes(a, b);
  assert.equal(d.mounts.changed.length, 1);
  assert.equal(d.mounts.changed[0].id, 'm1');
  assert.ok(d.mounts.changed[0].fields.pane_state, 'pane_state flagged as changed');
});

test('pane mode: WS pane:state merge preserves other fields when only mode changes', async (t) => {
  const { api, ws } = await withServer(t);

  await api.post('/api/render', { id: 'p1', html: '<div>x</div>' });

  await new Promise((resolve, reject) => {
    const sock = ws();
    sock.on('open', () => {
      sock.send(JSON.stringify({ type: 'pane:state', id: 'p1', pane_state: { colSpan: 6, locked: true } }));
      setTimeout(() => sock.send(JSON.stringify({ type: 'pane:state', id: 'p1', pane_state: { mode: 'expanded' } })), 30);
      setTimeout(() => { sock.close(); resolve(); }, 100);
    });
    sock.on('error', reject);
  });

  const { json: mounts } = await api.get('/api/mounts');
  const m = mounts.mounts.find((x) => x.id === 'p1');
  assert.equal(m.pane_state.colSpan, 6, 'earlier field retained');
  assert.equal(m.pane_state.locked, true, 'earlier field retained');
  assert.equal(m.pane_state.mode, 'expanded', 'mode merged in');
});

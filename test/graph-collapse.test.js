// Read-time collapse of turns that changed nothing (graph.computeCollapse,
// surfaced by GET /api/graph).
//
// Since fold-forward, a no-change turn commits no node at all. Graphs written
// before that landed are full of the nodes it now prevents — byte-identical
// copies of their parent, one per chat-only turn. These fix what the payload
// says about such a node, and (just as important) which ones it must NEVER
// hide: nothing here rewrites history, so a wrong answer is a graph that
// misreports its own shape.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');

const PANE_A = { id: 'a', html: '<p>A</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null };
const PANE_B = { id: 'b', html: '<p>B</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null };

let clock = 1;
function node(id, parent_id, extra = {}) {
  return {
    id, parent_id, created_at: clock++, author: 'claude',
    trigger: { kind: 'turn', message: `turn ${id}`, summary: `turn ${id}` },
    mounts: [], store: {}, comments: [], captures: [], ...extra,
  };
}

// A graph laid out to exercise every rule at once. `=` means "surface identical
// to its parent" — the only nodes that may ever collapse.
//
//   n0 root []          n10 root [A]              n20 root [A]
//   n1  [A]   changed   n11 = , TWO children      n21 = , bookmarked
//   n2  =     COLLAPSE  n12 = leaf                n22 =            COLLAPSE
//   n3  =     COLLAPSE  n13 = leaf                n23 = , ACTIVE
//   n4  [A,B] changed                             n24 = leaf
//   n5  =     COLLAPSE
//   n6  [A,B] + store   changed (store counts)
//   n7  =     leaf
const NODES = [
  node('n0', null),
  node('n1', 'n0', { mounts: [PANE_A] }),
  node('n2', 'n1', { mounts: [PANE_A] }),
  node('n3', 'n2', { mounts: [PANE_A] }),
  node('n4', 'n3', { mounts: [PANE_A, PANE_B] }),
  node('n5', 'n4', { mounts: [PANE_A, PANE_B] }),
  node('n6', 'n5', { mounts: [PANE_A, PANE_B], store: { k: 1 } }),
  node('n7', 'n6', { mounts: [PANE_A, PANE_B], store: { k: 1 } }),
  node('n10', null, { mounts: [PANE_A] }),
  node('n11', 'n10', { mounts: [PANE_A] }),
  node('n12', 'n11', { mounts: [PANE_A] }),
  node('n13', 'n11', { mounts: [PANE_A] }),
  node('n20', null, { mounts: [PANE_A] }),
  node('n21', 'n20', { mounts: [PANE_A], bookmarked: true, name: 'kept' }),
  node('n22', 'n21', { mounts: [PANE_A] }),
  node('n23', 'n22', { mounts: [PANE_A] }),
  node('n24', 'n23', { mounts: [PANE_A] }),
];

const seed = ({ webChatDir }) => {
  const dir = path.join(webChatDir, 'graph');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of NODES) fs.writeFileSync(path.join(dir, `${n.id}.json`), JSON.stringify(n));
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ active: 'n23' }));
};

async function graphPayload(t) {
  const ctx = await withServer(t, { seed });
  const r = await ctx.api.get('/api/graph');
  assert.equal(r.status, 200);
  const by = new Map(r.json.nodes.map((n) => [n.id, n]));
  return { payload: r.json, by };
}

test('collapse: only nodes identical to their parent are hidden', async (t) => {
  const { payload, by } = await graphPayload(t);
  const hidden = payload.nodes.filter((n) => n.collapsed).map((n) => n.id).sort();
  assert.deepEqual(hidden, ['n2', 'n22', 'n3', 'n5']);
  assert.equal(payload.collapsed_count, 4);
});

test('collapse: a run rolls forward onto the next node that changed something', async (t) => {
  const { by } = await graphPayload(t);
  const n4 = by.get('n4');
  assert.equal(n4.collapsed, undefined, 'n4 changed the surface');
  assert.equal(n4.parent_id, 'n3', 'the record on disk is untouched');
  assert.equal(n4.display_parent, 'n1', 'but the drawn edge skips the collapsed run');
  assert.deepEqual(n4.absorbed.map((a) => a.id), ['n2', 'n3'], 'oldest first');
  assert.equal(n4.absorbed_count, 2);
  assert.equal(n4.absorbed[0].trigger_summary, 'turn n2', 'the collapsed turn keeps its trigger');
  assert.ok(n4.absorbed[0].label, 'and its label, so it can still be named');
});

test('collapse: a store-only change still counts as a change', async (t) => {
  const { by } = await graphPayload(t);
  const n6 = by.get('n6');
  assert.equal(n6.collapsed, undefined, 'same panes, different store — not a no-change turn');
  assert.deepEqual(n6.absorbed.map((a) => a.id), ['n5']);
});

test('collapse: never hides a root, a fork, a tip, the active node, or a mark', async (t) => {
  const { by } = await graphPayload(t);
  const notHidden = (id, why) => assert.equal(by.get(id).collapsed, undefined, why);
  notHidden('n0', 'a root is the graph\'s identity');
  notHidden('n11', 'a fork is load-bearing shape');
  notHidden('n12', 'a tip is where the lineage ends');
  notHidden('n7', 'the last node of a chain has nothing to roll into');
  notHidden('n23', 'never hide where the user is standing');
  notHidden('n21', 'a bookmarked/named node was marked on purpose');
});

test('collapse: a visible node with no collapsed run reports none', async (t) => {
  const { by } = await graphPayload(t);
  const n1 = by.get('n1');
  assert.equal(n1.display_parent, 'n0');
  assert.equal(n1.absorbed, undefined);
  assert.equal(n1.absorbed_count, undefined);
});

test('collapse: the node the active one absorbed is attributed to it', async (t) => {
  const { by } = await graphPayload(t);
  const n23 = by.get('n23');
  assert.deepEqual(n23.absorbed.map((a) => a.id), ['n22']);
  assert.equal(n23.display_parent, 'n21', 'edge skips to the bookmarked node');
});

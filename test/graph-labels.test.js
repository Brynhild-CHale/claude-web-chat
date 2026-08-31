// computeLabels — the derived hierarchical labels (n1.0, n1.1, n1.1.0, …).
//
// Labels are recomputed from topology on every read (GET /api/graph, get_graph,
// twice inside nodeForExport), so the walk has to survive the shape a real
// project actually grows: a TRUNK, which is one linear chain with a node per
// committed turn. A self-recursive walk burns two frames per trunk level and
// threw `RangeError: Maximum call stack size exceeded` at ~3,000 nodes — after
// which the graph viewer, get_graph and export all 500 at once, with nothing to
// recover from (labels are derived, so there is no file to repair).
//
// These tests drive computeLabels directly on a synthetic topology: booting a
// server and committing 10,000 turns would take minutes and prove less.

const test = require('node:test');
const assert = require('node:assert');
const { computeLabels } = require('../lib/server/graph');

// A topology map of the shape graph.js builds: id -> {id, parent_id, created_at,
// children[]}. `parents` names each node's parent in creation order.
function topologyOf(parents) {
  const topo = new Map();
  parents.forEach((parent_id, i) => {
    topo.set(`n${i}`, { id: `n${i}`, parent_id, created_at: 1000 + i, children: [] });
  });
  for (const t of topo.values()) {
    if (t.parent_id && topo.has(t.parent_id)) topo.get(t.parent_id).children.push(t.id);
  }
  return { topology: topo };
}

// One linear chain of N nodes: n0 <- n1 <- n2 <- …
function chain(n) {
  return topologyOf(Array.from({ length: n }, (_, i) => (i === 0 ? null : `n${i - 1}`)));
}

test('computeLabels labels a 10,000-node trunk without overflowing the stack', () => {
  const graph = chain(10000);
  const labels = computeLabels(graph);
  assert.equal(labels.size, 10000);
  assert.equal(labels.get('n0'), 'n1.0');
  assert.equal(labels.get('n1'), 'n1.1');
  assert.equal(labels.get('n9999'), 'n1.9999');
});

test('computeLabels keeps trunk/branch semantics on a mixed graph', () => {
  // n0 root; n1,n2 trunk; n3 branches off n1; n4 continues that branch;
  // n5 is a second root.
  const graph = topologyOf([null, 'n0', 'n1', 'n1', 'n3', null]);
  const labels = computeLabels(graph);
  assert.equal(labels.get('n0'), 'n1.0');
  assert.equal(labels.get('n1'), 'n1.1');
  assert.equal(labels.get('n2'), 'n1.2');
  assert.equal(labels.get('n3'), 'n1.1.0'); // later child of n1 → a branch
  assert.equal(labels.get('n4'), 'n1.1.1'); // that branch's own trunk
  assert.equal(labels.get('n5'), 'n2.0');   // second root → second tree
});

test('computeLabels labels a 5,000-deep branch spine', () => {
  // Every node has TWO children, so every level appends a branch segment as
  // well as continuing the trunk — depth is the same, breadth is not.
  const parents = [null];
  for (let i = 1; i < 5000; i++) parents.push(`n${i - 1}`);
  parents.push('n1'); // one extra branch child, to keep the fork case live
  const labels = computeLabels(topologyOf(parents));
  assert.equal(labels.size, 5001);
  assert.equal(labels.get('n5000'), 'n1.1.0');
});

test('computeLabels memoises per topology revision, and only per revision', () => {
  // `topoRev` is the cache key; createGraph bumps it at registerNode and load.
  // A graph that carries one is cached, a bare {topology} (what the tests above
  // build, and anything hand-assembled) never is.
  const graph = { ...chain(3), topoRev: 1 };
  const first = computeLabels(graph);
  assert.equal(computeLabels(graph), first, 'same revision → the same map');

  // Grow the graph the way registerNode does, and bump the revision with it.
  graph.topology.set('n3', { id: 'n3', parent_id: 'n2', created_at: 2000, children: [] });
  graph.topology.get('n2').children.push('n3');
  graph.topoRev++;
  const second = computeLabels(graph);
  assert.notEqual(second, first, 'a topology change must not serve the stale map');
  assert.equal(second.get('n3'), 'n1.3');

  const bare = chain(3);
  assert.notEqual(computeLabels(bare), computeLabels(bare), 'no revision → never cached');
});

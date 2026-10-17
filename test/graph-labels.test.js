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

// ── the third-child label fix ───────────────────────────────────────────────
// Every non-first child used to be labelled `L.0`, so a node with k children
// gave k−2 siblings the same label and a label lookup (resolveNodeRef's scan)
// opened the first of them. The child at index i ≥ 2 is now `L-i.0`; the first
// two children label exactly as before.

const { mulberry32 } = require('../test-support/fake-secrets');
const { resolveNodeRef } = require('../lib/server/domain/refs');

// A growable graph of the shape graph.js builds, ids n0, n1, … in creation order.
function growable() { return { topology: new Map(), nodes: new Map(), seq: 0, clock: 1000 }; }
function grow(g, parent) {
  const id = 'n' + g.seq++;
  g.topology.set(id, { id, parent_id: parent, created_at: g.clock++, children: [] });
  g.nodes.set(id, { id, parent_id: parent });
  if (parent && g.topology.has(parent)) g.topology.get(parent).children.push(id);
  return id;
}
const labelsOf = (g) => computeLabels({ topology: g.topology });
function duplicates(labels) {
  const seen = new Set();
  let d = 0;
  for (const l of labels.values()) { if (seen.has(l)) d++; seen.add(l); }
  return d;
}

// f3c4a7f's rule, kept here as the oracle for graphs whose nodes have at most
// two children (where the new rule must agree with it exactly).
function oldRule(g) {
  const out = new Map();
  const kids = (id) => g.topology.get(id).children.slice()
    .sort((a, b) => g.topology.get(a).created_at - g.topology.get(b).created_at);
  const roots = [...g.topology.values()].filter((t) => !t.parent_id).map((t) => t.id)
    .sort((a, b) => g.topology.get(a).created_at - g.topology.get(b).created_at);
  const stack = roots.map((id, k) => [id, `n${k + 1}.0`]).reverse();
  while (stack.length) {
    const [id, label] = stack.pop();
    out.set(id, label);
    const c = kids(id);
    for (let i = c.length - 1; i >= 0; i--) {
      const parts = label.split('.');
      parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
      stack.push([c[i], i === 0 ? parts.join('.') : label + '.0']);
    }
  }
  return out;
}

test('computeLabels: a fan-out of 1..5 children of n1.1 has no duplicate label', () => {
  const expected = ['n1.2', 'n1.1.0', 'n1.1-2.0', 'n1.1-3.0', 'n1.1-4.0'];
  for (let k = 1; k <= 5; k++) {
    const g = growable();
    const r = grow(g, null);
    const a = grow(g, r); // n1.1
    const kids = [];
    for (let i = 0; i < k; i++) kids.push(grow(g, a));
    // Give the third and fourth children a trunk child each.
    const trunks = kids.slice(2, 4).map((c) => grow(g, c));
    const labels = labelsOf(g);
    assert.equal(duplicates(labels), 0, `${k} children: no duplicate label`);
    assert.deepEqual(kids.map((c) => labels.get(c)), expected.slice(0, k));
    if (k <= 2) assert.deepEqual(labels, oldRule(g), `${k} children: labels unchanged from f3c4a7f`);
    if (k >= 3) assert.equal(labels.get(trunks[0]), 'n1.1-2.1');
    if (k >= 4) assert.equal(labels.get(trunks[1]), 'n1.1-3.1');
  }
});

test('computeLabels: a fan-out under a nested branch node, and a branch off a dashed label', () => {
  for (let k = 1; k <= 5; k++) {
    const g = growable();
    const r = grow(g, null);
    const a = grow(g, r);            // n1.1
    grow(g, a);                      // n1.2
    const b = grow(g, a);            // n1.1.0
    const kids = [];
    for (let i = 0; i < k; i++) kids.push(grow(g, b));
    const labels = labelsOf(g);
    assert.equal(duplicates(labels), 0, `${k} children of n1.1.0: no duplicate label`);
    assert.deepEqual(kids.map((c) => labels.get(c)),
      ['n1.1.1', 'n1.1.0.0', 'n1.1.0-2.0', 'n1.1.0-3.0', 'n1.1.0-4.0'].slice(0, k));
    if (k <= 2) assert.deepEqual(labels, oldRule(g));
  }
  // n1.1-2.0 → its trunk n1.1-2.1 → a branch off that, n1.1-2.1.0, and a third
  // child of n1.1-2.1, n1.1-2.1-2.0.
  const g = growable();
  const r = grow(g, null);
  const a = grow(g, r);
  grow(g, a); grow(g, a);
  const third = grow(g, a);
  const t1 = grow(g, third);
  grow(g, t1);
  const br = grow(g, t1);
  const br2 = grow(g, t1);
  const labels = labelsOf(g);
  assert.equal(labels.get(third), 'n1.1-2.0');
  assert.equal(labels.get(t1), 'n1.1-2.1');
  assert.equal(labels.get(br), 'n1.1-2.1.0');
  assert.equal(labels.get(br2), 'n1.1-2.1-2.0');
  assert.equal(duplicates(labels), 0);
});

test('computeLabels: graphs of at most two children per node label exactly as f3c4a7f did', () => {
  const rnd = mulberry32(2007);
  for (let round = 0; round < 20; round++) {
    const g = growable();
    grow(g, null);
    for (let i = 0; i < 150; i++) {
      const open = [...g.topology.values()].filter((t) => t.children.length < 2).map((t) => t.id);
      const parent = rnd() < 0.15 ? null : open[Math.floor(rnd() * open.length)];
      grow(g, parent);
    }
    assert.deepEqual(labelsOf(g), oldRule(g), `round ${round}`);
  }
});

test('computeLabels: 300 seeded appends to a branchy graph never duplicate or relabel', () => {
  const rnd = mulberry32(2002);
  const g = growable();
  grow(g, null);
  let prev = labelsOf(g);
  let forks3 = 0;
  for (let i = 0; i < 300; i++) {
    const ids = [...g.topology.keys()];
    const parent = rnd() < 0.8 ? ids[ids.length - 1] : ids[Math.floor(rnd() * ids.length)];
    grow(g, parent);
    const next = labelsOf(g);
    assert.equal(duplicates(next), 0, `append ${i}: no duplicate label`);
    for (const [id, l] of prev) assert.equal(next.get(id), l, `append ${i}: ${id} keeps its label`);
    prev = next;
  }
  for (const t of g.topology.values()) if (t.children.length >= 3) forks3++;
  assert.ok(forks3 > 0, 'the seeded graph has a node with three or more children');
});

test('resolveNodeRef: a dashed label opens its own node, and a stored id still wins', () => {
  const g = growable();
  const r = grow(g, null);
  const a = grow(g, r);
  const kids = [grow(g, a), grow(g, a), grow(g, a), grow(g, a)];
  const third = resolveNodeRef(g, 'n1.1-2.0');
  assert.equal(third.ok, true);
  assert.equal(third.id, kids[2], 'n1.1-2.0 is the third child');
  assert.equal(resolveNodeRef(g, 'n1.1-3.0').id, kids[3]);
  assert.equal(resolveNodeRef(g, 'n1.1.0').id, kids[1]);

  // A node whose stored id spells another node's label: the id wins.
  const h = growable();
  const root = grow(h, null);           // n1.0
  const n1 = grow(h, root);             // n1.1
  const n2 = grow(h, n1);               // n1.2
  h.topology.set('n1.2', { id: 'n1.2', parent_id: root, created_at: h.clock++, children: [] });
  h.nodes.set('n1.2', { id: 'n1.2', parent_id: root });
  h.topology.get(root).children.push('n1.2');
  assert.equal(labelsOf(h).get(n2), 'n1.2');
  assert.equal(resolveNodeRef(h, 'n1.2').id, 'n1.2', 'the stored id wins over the label scan');
});

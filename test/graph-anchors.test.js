// Graph anchors keyed by node id (PLAN 1A.8, GT-20) — lib/server/domain/refs
// `resolveGraphAnchor` — and the third-child label fix seen end to end through
// the daemon's graph routes.
//
// A graph anchor pins something to the graph itself (a node, a fork, a span of
// turns, a branch), so it is keyed by stored node ids. Labels are derived from
// topology on every read and are only ever a display name: an anchor that names
// a node by label alone is refused.

const test = require('node:test');
const assert = require('node:assert');
const { performance } = require('node:perf_hooks');
const { withServer } = require('../test-support/helpers');
const { mulberry32 } = require('../test-support/fake-secrets');
const { computeLabels } = require('../lib/server/graph');
const { resolveGraphAnchor, GRAPH_ANCHOR_STATES } = require('../lib/server/domain/refs');

// A graph of the shape graph.js builds, carrying a topoRev so computeLabels
// caches its map the way the daemon's graph does.
function growable() { return { topology: new Map(), nodes: new Map(), topoRev: 0, seq: 0, clock: 1000 }; }
function grow(g, parent) {
  const id = 'n' + g.seq++;
  g.topology.set(id, { id, parent_id: parent, created_at: g.clock++, children: [] });
  g.nodes.set(id, { id, parent_id: parent });
  if (parent && g.topology.has(parent)) g.topology.get(parent).children.push(id);
  g.topoRev++;
  return id;
}

// A seeded branchy graph: most commits continue the newest node, the rest
// branch from anywhere, with an occasional new root.
function branchy(n, seed) {
  const rnd = mulberry32(seed);
  const g = growable();
  grow(g, null);
  while (g.seq < n) {
    const ids = [...g.topology.keys()];
    const x = rnd();
    const parent = x < 0.01 ? null : x < 0.75 ? ids[ids.length - 1] : ids[Math.floor(rnd() * ids.length)];
    grow(g, parent);
  }
  return g;
}

// The test's own oracles, independent of the label grammar.
function chainUp(g, id) {
  const out = [];
  for (let cur = id; cur != null; cur = g.nodes.get(cur).parent_id) out.push(cur);
  return out;
}
// A child that is not the first-created child of its parent.
function isLaterChild(g, id) {
  const p = g.nodes.get(id).parent_id;
  return p != null && g.topology.get(p).children[0] !== id;
}

// 500 anchors of the four kinds, drawn with the graph's own seed.
function drawAnchors(g, seed, count) {
  const rnd = mulberry32(seed);
  const ids = [...g.nodes.keys()];
  const forks = ids.filter((id) => g.topology.get(id).children.length >= 2);
  const branches = ids.filter((id) => isLaterChild(g, id));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = [];
  for (let i = 0; i < count; i++) {
    switch (i % 4) {
      case 0: out.push({ kind: 'node', node_id: pick(ids) }); break;
      case 1: out.push({ kind: 'fork', node_id: pick(forks) }); break;
      case 2: {
        const to = pick(ids);
        const up = chainUp(g, to);
        out.push({ kind: 'span', from_id: up[Math.floor(rnd() * up.length)], to_id: to });
        break;
      }
      default: out.push({ kind: 'branch', node_id: pick(branches) });
    }
  }
  return out;
}

function ownIds(answer) {
  return answer.kind === 'span' ? [answer.from_id, answer.to_id] : [answer.node_id];
}

test('resolveGraphAnchor: 500 anchors over a 3,000-node branchy graph answer exact by id', () => {
  const g = branchy(3000, 1207);
  const anchors = drawAnchors(g, 4207, 500);
  const labels = computeLabels(g);
  const seenStates = new Set();
  const first = anchors.map((a) => {
    const r = resolveGraphAnchor(g, a);
    seenStates.add(r.state);
    assert.equal(r.ok, true, `${JSON.stringify(a)} → ${JSON.stringify(r)}`);
    assert.equal(r.state, 'exact');
    assert.equal(r.kind, a.kind);
    if (a.kind === 'span') {
      assert.equal(r.from_id, a.from_id);
      assert.equal(r.to_id, a.to_id);
      assert.equal(r.length, chainUp(g, a.to_id).indexOf(a.from_id) + 1);
      assert.deepEqual(r.labels, [labels.get(a.from_id), labels.get(a.to_id)]);
      assert.equal(r.label, `${labels.get(a.from_id)}..${labels.get(a.to_id)}`);
    } else {
      assert.equal(r.node_id, a.node_id);
      assert.equal(r.label, labels.get(a.node_id));
    }
    if (a.kind === 'fork') {
      assert.deepEqual(r.children, g.topology.get(a.node_id).children);
      assert.deepEqual(r.labels, r.children.map((c) => labels.get(c)));
    }
    if (a.kind === 'branch') {
      assert.equal(r.parent_id, g.nodes.get(a.node_id).parent_id);
      assert.equal(r.parent_label, labels.get(r.parent_id));
    }
    return r;
  });
  for (const s of seenStates) assert.ok(GRAPH_ANCHOR_STATES.includes(s));

  // A field the label walk does not read (bookmarked) changes on 50 nodes, with
  // no topoRev bump: every answer is the same.
  const rnd = mulberry32(5207);
  const ids = [...g.nodes.keys()];
  for (let i = 0; i < 50; i++) {
    const id = ids[Math.floor(rnd() * ids.length)];
    g.topology.get(id).bookmarked = true;
    g.nodes.get(id).bookmarked = true;
  }
  anchors.forEach((a, i) => assert.deepEqual(resolveGraphAnchor(g, a), first[i]));

  // 20 appended nodes (topoRev bumps): no anchor's ids, label or state change; a
  // fork may only gain children after the ones it had.
  for (let i = 0; i < 20; i++) grow(g, ids[Math.floor(rnd() * ids.length)]);
  anchors.forEach((a, i) => {
    const r = resolveGraphAnchor(g, a);
    assert.equal(r.state, 'exact');
    assert.deepEqual(ownIds(r), ownIds(first[i]));
    assert.equal(r.label, first[i].label);
    if (a.kind === 'fork') assert.deepEqual(r.children.slice(0, first[i].children.length), first[i].children);
  });
});

test('resolveGraphAnchor: the orphaned answers and their reasons', () => {
  const g = growable();
  const r = grow(g, null);          // n1.0
  const a = grow(g, r);             // n1.1
  const b = grow(g, a);             // n1.2
  const c = grow(g, a);             // n1.1.0
  const other = grow(g, null);      // n2.0
  const states = new Set();
  const check = (anchor, reason) => {
    const ans = resolveGraphAnchor(g, anchor);
    states.add(ans.state);
    assert.deepEqual(ans, { ok: false, state: 'orphaned', reason }, JSON.stringify(anchor));
  };
  check({ kind: 'node', node_id: 'n999' }, 'node-gone');
  check({ kind: 'fork', node_id: 'n999' }, 'node-gone');
  check({ kind: 'branch', node_id: 'n999' }, 'node-gone');
  check({ kind: 'span', from_id: r, to_id: 'n999' }, 'node-gone');
  check({ kind: 'node' }, 'node-gone');
  check({ kind: 'span', from_id: b, to_id: c }, 'not-an-ancestor');       // siblings
  check({ kind: 'span', from_id: b, to_id: r }, 'not-an-ancestor');       // reversed
  check({ kind: 'span', from_id: other, to_id: b }, 'not-an-ancestor');   // another tree
  check({ kind: 'fork', node_id: r }, 'not-a-fork');                      // one child
  check({ kind: 'fork', node_id: b }, 'not-a-fork');                      // a leaf
  check({ kind: 'branch', node_id: b }, 'not-a-branch');                  // the trunk child
  check({ kind: 'branch', node_id: r }, 'not-a-branch');                  // a root
  check({ kind: 'node', label: 'n1.3' }, 'label-not-an-anchor');
  check({ kind: 'fork', label: 'n1.1' }, 'label-not-an-anchor');
  check({ kind: 'span', from_label: 'n1.0', to_label: 'n1.2' }, 'label-not-an-anchor');
  check({ kind: 'span', from_id: r, to_label: 'n1.2' }, 'label-not-an-anchor');
  check({ kind: 'nodes', node_id: r }, 'unknown-kind');
  check(null, 'unknown-kind');
  for (const s of states) assert.ok(GRAPH_ANCHOR_STATES.includes(s));

  // The exact answers on the same graph, for contrast; a label beside an id is
  // display only and never read.
  assert.equal(resolveGraphAnchor(g, { kind: 'node', node_id: c, label: 'n1.2' }).label, 'n1.1.0');
  assert.deepEqual(resolveGraphAnchor(g, { kind: 'fork', node_id: a }).children, [b, c]);
  assert.equal(resolveGraphAnchor(g, { kind: 'branch', node_id: c }).parent_id, a);
  assert.equal(resolveGraphAnchor(g, { kind: 'span', from_id: b, to_id: b }).length, 1);
  assert.equal(resolveGraphAnchor(g, { kind: 'span', from_id: r, to_id: b }).length, 3);
  assert.deepEqual(GRAPH_ANCHOR_STATES, ['exact', 'orphaned']);
  assert.ok(Object.isFrozen(GRAPH_ANCHOR_STATES));
});

test('resolveGraphAnchor: a branch at any fan-out position, read off the new labels', () => {
  const g = growable();
  const r = grow(g, null);
  const a = grow(g, r);
  const kids = [grow(g, a), grow(g, a), grow(g, a), grow(g, a), grow(g, a)];
  assert.equal(resolveGraphAnchor(g, { kind: 'branch', node_id: kids[0] }).reason, 'not-a-branch');
  const labels = kids.slice(1).map((k) => resolveGraphAnchor(g, { kind: 'branch', node_id: k }));
  assert.deepEqual(labels.map((x) => x.label), ['n1.1.0', 'n1.1-2.0', 'n1.1-3.0', 'n1.1-4.0']);
  assert.ok(labels.every((x) => x.state === 'exact' && x.parent_id === a));
  const fork = resolveGraphAnchor(g, { kind: 'fork', node_id: a });
  assert.deepEqual(fork.labels, ['n1.2', 'n1.1.0', 'n1.1-2.0', 'n1.1-3.0', 'n1.1-4.0']);
});

test('resolveGraphAnchor: never writes to the graph', () => {
  const g = branchy(300, 99);
  const before = JSON.stringify([...g.topology.values()]) + JSON.stringify([...g.nodes.values()]);
  const rev = g.topoRev;
  for (const a of drawAnchors(g, 7, 100)) resolveGraphAnchor(g, a);
  resolveGraphAnchor(g, { kind: 'node', label: 'n1.1' });
  assert.equal(g.topoRev, rev);
  assert.equal(JSON.stringify([...g.topology.values()]) + JSON.stringify([...g.nodes.values()]), before);
});

test('resolveGraphAnchor: 500 warm resolves over 3,000 nodes finish under a second', () => {
  // A loose unit bound; GT-12's 10 ms per resolve is the gate's measurement.
  const g = branchy(3000, 3207);
  const anchors = drawAnchors(g, 6207, 500);
  for (const a of anchors) resolveGraphAnchor(g, a); // warm: the label cache
  const t0 = performance.now();
  for (const a of anchors) resolveGraphAnchor(g, a);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `500 warm resolves took ${ms.toFixed(1)} ms`);
});

// ── end to end: four children of one node through the daemon ───────────────

async function render(api, id) {
  const r = await api.post('/api/render', { id, html: `<div>${id}</div>` });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
}
async function turn(api) {
  await api.post('/api/turn-begin', {});
  const r = await api.post('/api/turn-end', { author: 'claude', summary: 't' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

test('a node with four children gets four distinct labels, each resolving to its own node', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p0'); await turn(api);            // n1.0
  await render(api, 'p1'); await turn(api);            // n1.1 — the parent P
  let g = (await api.get('/api/graph')).json;
  const parent = g.active;
  await render(api, 'p2'); await turn(api);            // n1.2 — P's trunk child

  for (const b of ['b1', 'b2', 'b3']) {
    const nav = await api.post('/api/graph/active', { id: parent });
    assert.equal(nav.json.ok, true, JSON.stringify(nav.json));
    await render(api, b); await turn(api);
  }

  g = (await api.get('/api/graph')).json;
  const children = g.nodes.filter((n) => n.parent_id === parent)
    .sort((x, y) => x.created_at - y.created_at);
  assert.equal(children.length, 4);
  assert.deepEqual(children.map((n) => n.label), ['n1.2', 'n1.1.0', 'n1.1-2.0', 'n1.1-3.0']);
  assert.equal(new Set(g.nodes.map((n) => n.label)).size, g.nodes.length, 'no two nodes share a label');

  for (const child of children) {
    // A label resolves through the one node-ref resolver (the diff route takes
    // a label; /api/graph/node/:id takes a stored id only).
    const d = await api.get(`/api/graph/diff?a=${encodeURIComponent(child.label)}&b=${encodeURIComponent(child.label)}`);
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.a.id, child.id, `${child.label} opens its own node`);
    const n = await api.get(`/api/graph/node/${encodeURIComponent(child.id)}`);
    assert.equal(n.status, 200);
    assert.equal(n.json.label, child.label);
  }
});

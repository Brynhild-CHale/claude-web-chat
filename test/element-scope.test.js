// The home-node resolver (lib/server/domain/element-scope, U205; PLAN 1A.6,
// DECISIONS C1 branch-only, GT-11's home-node clause): a node shows the newest
// version whose home node — the node of the first commit record pinning it —
// is in its own ancestry, with 0 cross-branch picks.
//
// Three halves, ported from design/annotation-engine-redesign/tests/F6:
//   named   — c4-v2.js's 5 named topologies (c4.js's simulator)
//   seeded  — its 400 seeded random graphs (mulberry32, seeds 1000 + i)
//   server  — fork.js's G-8 run through withServer and the real routes
// The simulator's graphs are plain {nodes, topology} objects and its store is
// a lib/core/element-log on a temp file (versions and commit records appended
// directly), so the first two halves need no daemon. The ORACLE is independent
// of the log: each version's home is the first simulator node (in creation
// order) whose pin is that version, and the ancestry is the simulator's own
// parent chain — never homeOf, never lineage.ancestry. c4-v2.js's notes: every
// mismatch with the older derived-home oracle was that oracle's error (it fell
// back to the node a never-pinned version was minted on), so this one stamps
// homes at commit, as the log does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withServer, commentBody } = require('../test-support/helpers');
const { mulberry32 } = require('../test-support/fake-secrets');
const { createElementLog } = require('../lib/core/element-log');
const { createRedactor } = require('../lib/core/redact');
const { projectPaths } = require('../lib/core/paths');
const { computeLabels } = require('../lib/server/graph');
const lineage = require('../lib/server/domain/lineage');
const { visibleVersion, elementsForNode } = require('../lib/server/domain/element-scope');

const EL = 'c1';
const ANCHOR = { mount: 'scope-pane', selector: '#a', text: 'Alpha', ordinal: 0 };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-element-scope-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// ── the simulator (c4.js createSim, one element, through a real log) ───────
// Each simulator op maps onto the log as the daemon would write it: add and
// reply append a version, a commit (a turn's, or Set active's preserve node)
// appends the node's commit record pinning the live version, remove / a clean
// re-aim / New graph append nothing. `graph` is the plain object the resolver
// reads (nodes + topology, Maps of {id, parent_id, created_at}; a topology
// entry also lists its children, as computeLabels reads them).
function createSim(log) {
  const nodes = new Map(); // id → {id, parent, pin}, the oracle's own record
  const graph = { nodes: new Map(), topology: new Map() };
  const versions = []; // v, in mint order
  let seq = 0, clock = 1, active = null, live = null;
  const counts = { preserves: 0, newGraphs: 0 };
  log.ensureElement({ id: EL });
  const vNew = (parent_v) => {
    const rec = log.appendVersion({
      id: EL, parent_v,
      payload: { text: 'note', shared: true, replies: versions.map((v) => ({ author: 'user', at: v, text: 'r' + v })), anchor: ANCHOR },
    });
    versions.push(rec.v);
    return rec.v;
  };
  const commit = () => {
    const id = 'n' + seq++;
    const created_at = clock++;
    nodes.set(id, { id, parent: active, pin: live });
    const node = { id, parent_id: active, created_at, comments: live == null ? [] : [{ id: EL, v: live }] };
    graph.nodes.set(id, node);
    graph.topology.set(id, { id, parent_id: active, created_at, children: [] });
    if (active != null) graph.topology.get(active).children.push(id);
    log.appendCommit({ node, pins: live == null ? [] : [`${EL}@${live}`] });
    active = id;
    return id;
  };
  return {
    nodes, graph, versions, counts,
    get active() { return active; },
    add() { live = vNew(null); },
    reply() { if (live != null) live = vNew(live); },
    remove() { live = null; },
    commit,
    reaim(id) {
      const a = active ? nodes.get(active) : null;
      if ((a ? a.pin : null) !== live) { commit(); counts.preserves++; } // the preserve node
      active = id; live = nodes.get(id).pin;
    },
    newGraph() { active = null; live = null; counts.newGraphs++; },
  };
}

function simIn(t, dir, name) {
  const log = createElementLog({ file: path.join(dir, name + '.jsonl'), redactor: createRedactor() });
  t.after(() => log.close());
  log.load();
  return { log, sim: createSim(log) };
}

// c4.js's five named topologies, verbatim.
const topologies = {
  chain(s) { s.add(); s.commit(); for (let i = 0; i < 9; i++) { if (i % 2) s.reply(); s.commit(); } },
  fork_depth2(s) { s.add(); s.commit(); s.reply(); const a = s.commit(); s.reply(); s.commit(); s.reaim(a); s.reply(); s.commit(); s.reply(); s.commit(); },
  fork_after_orphan(s) { s.add(); const r = s.commit(); s.remove(); s.commit(); s.commit(); s.reaim(r); s.reply(); s.commit(); s.reply(); s.commit(); },
  preserve_interposed(s) { s.add(); const r = s.commit(); s.reply(); s.commit(); s.reply(); /* dirty */ s.reaim(r); s.reply(); s.commit(); },
  second_root(s) { s.add(); s.commit(); s.reply(); s.commit(); s.newGraph(); s.commit(); s.commit(); },
};

// c4.js randomSim(seed), verbatim (steps: reply / remove / commit / re-aim with
// preserve / commit), plus New graph on its unused 0.40–0.43 band (c4.js skips
// it there; the brief asks for new-graph steps): a New graph, then a fresh add
// as the new tree's first pin, as c4.js's corpus replay starts a root.
function randomGraph(s, seed) {
  const r = mulberry32(seed);
  s.add(); s.commit();
  const steps = 20 + Math.floor(r() * 40);
  for (let i = 0; i < steps; i++) {
    const x = r();
    if (x < 0.35) s.reply();
    else if (x < 0.40) s.remove();
    else if (x < 0.43) { s.newGraph(); s.add(); }
    else if (x < 0.75) s.commit();
    else if (x < 0.97 && s.nodes.size > 1) { const ids = [...s.nodes.keys()]; s.reaim(ids[Math.floor(r() * ids.length)]); }
    else s.commit();
  }
  s.commit();
}

// The ancestry-only oracle, independent of the log.
function oracleOf(sim) {
  const home = new Map();
  for (const n of sim.nodes.values()) if (n.pin != null && !home.has(n.pin)) home.set(n.pin, n.id);
  const anc = (id) => { const s = new Set(); let x = id; while (x != null && sim.nodes.has(x) && !s.has(x)) { s.add(x); x = sim.nodes.get(x).parent; } return s; };
  return {
    home, anc,
    pick(id) {
      const a = anc(id);
      let best = null;
      for (const v of sim.versions) if (home.has(v) && a.has(home.get(v)) && (best == null || v > best)) best = v;
      return best;
    },
  };
}

// Score one graph: every node's visibleVersion and elementsForNode row against
// the oracle. Returns the tallies the GT-11 clause reads.
function score(sim, log) {
  const o = oracleOf(sim);
  const row = { nodes: 0, picks: 0, cross_branch_picks: 0, mismatches: 0, holding_not_own_copy: 0, homeless_picks: 0, row_mismatches: 0, versions_without_home: 0 };
  for (const v of sim.versions) {
    if (!o.home.has(v)) row.versions_without_home++;
    assert.equal(log.homeOf(EL, v), o.home.get(v) ?? null, `homeOf(${EL}@${v}) is the first node pinning it`);
  }
  for (const [id, n] of sim.nodes) {
    row.nodes++;
    const pick = visibleVersion(sim.graph, log, EL, id);
    const want = o.pick(id);
    if (pick !== want) row.mismatches++;
    if (pick == null) { assert.equal(want, null); continue; }
    row.picks++;
    const h = log.homeOf(EL, pick);
    if (h == null) row.homeless_picks++;
    else if (!o.anc(id).has(h)) row.cross_branch_picks++;
    if (n.pin != null && pick !== n.pin) row.holding_not_own_copy++;
    // elementsForNode agrees with visibleVersion, the node's own pin, and the
    // oracle's list of newer versions homed off the ancestry.
    const rows = elementsForNode(sim.graph, log, id);
    const a = o.anc(id);
    const elsewhere = sim.versions.filter((v) => v > want && o.home.has(v) && !a.has(o.home.get(v)));
    const r = rows.find((x) => x.id === EL);
    const ok = rows.length === 1 && r && r.newest_visible_v === pick && r.v === (n.pin ?? null)
      && JSON.stringify(r.newer_elsewhere.map((x) => [x.v, x.home])) === JSON.stringify(elsewhere.map((v) => [v, o.home.get(v)]));
    if (!ok) row.row_mismatches++;
  }
  return row;
}

const zero = { cross_branch_picks: 0, mismatches: 0, holding_not_own_copy: 0, homeless_picks: 0, row_mismatches: 0 };
const verdict = (r) => ({ cross_branch_picks: r.cross_branch_picks, mismatches: r.mismatches, holding_not_own_copy: r.holding_not_own_copy, homeless_picks: r.homeless_picks, row_mismatches: r.row_mismatches });

// ── named topologies ────────────────────────────────────────────────────────

for (const [name, build] of Object.entries(topologies)) {
  test(`named topology ${name}: visibleVersion equals the ancestry-only oracle at every node, 0 cross-branch picks`, (t) => {
    const { log, sim } = simIn(t, tmpDir(t), name);
    build(sim);
    const r = score(sim, log);
    assert.ok(r.nodes > 0 && r.picks > 0, 'the topology evaluated something');
    assert.deepEqual(verdict(r), zero);
  });
}

test('named topologies: the cases that matter resolve as C1 says', (t) => {
  const dir = tmpDir(t);
  // fork_depth2: n0(v1) n1(v2) n2(v3) | re-aim n1, reply → n3(v4) n4(v5).
  {
    const { log, sim } = simIn(t, dir, 'fd2');
    topologies.fork_depth2(sim);
    assert.equal(visibleVersion(sim.graph, log, EL, 'n2'), 3);
    assert.equal(visibleVersion(sim.graph, log, EL, 'n3'), 4, 'the sibling branch sees its own reply, never n2\'s v3');
    assert.equal(visibleVersion(sim.graph, log, EL, 'n1'), 2);
    const [row] = elementsForNode(sim.graph, log, 'n1');
    assert.deepEqual(row.newer_elsewhere.map((x) => [x.v, x.home]), [[3, 'n2'], [4, 'n3'], [5, 'n4']]);
    const labels = computeLabels(sim.graph);
    assert.deepEqual(row.newer_elsewhere.map((x) => x.label), ['n2', 'n3', 'n4'].map((id) => labels.get(id)));
  }
  // preserve_interposed: the dirty reply at the re-aim is homed at the preserve node.
  {
    const { log, sim } = simIn(t, dir, 'pi');
    topologies.preserve_interposed(sim);
    const preserve = [...sim.nodes.values()].find((n) => n.pin === 3);
    assert.ok(preserve, 'a preserve node pins the dirty v3');
    assert.equal(log.homeOf(EL, 3), preserve.id);
    assert.equal(visibleVersion(sim.graph, log, EL, preserve.id), 3);
    assert.equal(visibleVersion(sim.graph, log, EL, 'n0'), 1);
  }
  // fork_after_orphan: the nodes after the remove hold no copy and still see v1.
  {
    const { log, sim } = simIn(t, dir, 'fao');
    topologies.fork_after_orphan(sim);
    assert.equal(sim.nodes.get('n2').pin, null);
    assert.equal(visibleVersion(sim.graph, log, EL, 'n2'), 1);
    const [row] = elementsForNode(sim.graph, log, 'n2');
    assert.equal(row.v, null, 'the node holds no copy');
    assert.equal(row.newest_visible_v, 1);
  }
  // second_root: the second tree sees nothing of the first.
  {
    const { log, sim } = simIn(t, dir, 'sr');
    topologies.second_root(sim);
    assert.equal(visibleVersion(sim.graph, log, EL, 'n3'), null);
    assert.deepEqual(elementsForNode(sim.graph, log, 'n3'), []);
  }
});

// ── 400 seeded random graphs ────────────────────────────────────────────────

test('400 seeded random graphs (commit / reply / remove / re-aim with preserve / new graph): 0 cross-branch picks against the oracle', (t) => {
  const dir = tmpDir(t);
  const total = { graphs: 0, nodes: 0, picks: 0, versions_without_home: 0, ...zero };
  let preserves = 0, newGraphs = 0;
  for (let i = 0; i < 400; i++) {
    const log = createElementLog({ file: path.join(dir, `g${i}.jsonl`), redactor: createRedactor() });
    try {
      log.load();
      const sim = createSim(log);
      randomGraph(sim, 1000 + i);
      preserves += sim.counts.preserves;
      newGraphs += sim.counts.newGraphs;
      const r = score(sim, log);
      total.graphs++;
      for (const k of Object.keys(r)) total[k] = (total[k] || 0) + r[k];
    } finally {
      log.close();
    }
  }
  assert.equal(total.graphs, 400);
  assert.ok(total.nodes > 4000 && total.picks > 0, `the graphs evaluated (${total.nodes} nodes)`);
  assert.ok(total.versions_without_home > 0, 'some versions were never pinned (superseded or dropped): homeless ones exist to be refused');
  assert.ok(preserves > 0 && newGraphs > 0, 'the seeds exercised re-aims and New graph');
  assert.deepEqual(verdict(total), zero);
});

// ── purity: no writes, one ancestry walk per call ──────────────────────────

test('visibleVersion and elementsForNode write nothing and walk the ancestry once per call', (t) => {
  const dir = tmpDir(t);
  const { log, sim } = simIn(t, dir, 'pure');
  topologies.fork_depth2(sim);
  const file = path.join(dir, 'pure.jsonl');
  const bytes = fs.statSync(file).size;
  const stats = JSON.stringify(log.stats());
  const orig = lineage.ancestry;
  let calls = 0;
  lineage.ancestry = (...a) => { calls++; return orig(...a); };
  try {
    for (const id of sim.nodes.keys()) {
      calls = 0;
      visibleVersion(sim.graph, log, EL, id);
      assert.equal(calls, 1, 'visibleVersion: one ancestry walk');
      calls = 0;
      elementsForNode(sim.graph, log, id);
      assert.equal(calls, 1, 'elementsForNode: one ancestry walk');
    }
  } finally {
    lineage.ancestry = orig;
  }
  assert.equal(fs.statSync(file).size, bytes, 'the log is the same size');
  assert.equal(JSON.stringify(log.stats()), stats, 'and indexes the same records');
});

test('elementsForNode: one row per element homed in the ancestry; a node holding no copy reports v null and the newest visible v', (t) => {
  const dir = tmpDir(t);
  const log = createElementLog({ file: path.join(dir, 'two.jsonl'), redactor: createRedactor() });
  t.after(() => log.close());
  log.load();
  const graph = { nodes: new Map(), topology: new Map() };
  const node = (id, parent_id, created_at, pins) => {
    const n = { id, parent_id, created_at, comments: pins.map((p) => ({ id: p.split('@')[0] })) };
    graph.nodes.set(id, n);
    graph.topology.set(id, { id, parent_id, created_at, children: [] });
    if (parent_id != null) graph.topology.get(parent_id).children.push(id);
    log.appendCommit({ node: n, pins });
  };
  const ver = (id, parent_v) => log.appendVersion({ id, parent_v, payload: { text: id, shared: true } }).v;
  log.ensureElement({ id: 'ca' }); log.ensureElement({ id: 'cb' }); log.ensureElement({ id: 'cz' });
  ver('ca', null); ver('cb', null);
  node('n0', null, 1, ['ca@1', 'cb@1']);
  ver('cb', 1);
  node('n1', 'n0', 2, ['ca@1', 'cb@2']);
  node('n2', 'n1', 3, ['cb@2']); // ca removed: no copy here
  ver('cz', null); // never committed: no home, no row anywhere
  const rows = elementsForNode(graph, log, 'n2');
  assert.deepEqual(rows.map((r) => r.id).sort(), ['ca', 'cb']);
  const ca = rows.find((r) => r.id === 'ca');
  assert.deepEqual(ca, { id: 'ca', v: null, newest_visible_v: 1, newer_elsewhere: [] });
  const cb = rows.find((r) => r.id === 'cb');
  assert.deepEqual(cb, { id: 'cb', v: 2, newest_visible_v: 2, newer_elsewhere: [] });
  assert.equal(visibleVersion(graph, log, 'cz', 'n2'), null);
  assert.equal(log.homeOf('cz', 1), null);
  // n0's view: cb@2 is homed at a descendant, listed as newer elsewhere.
  const at0 = elementsForNode(graph, log, 'n0').find((r) => r.id === 'cb');
  assert.deepEqual(at0.newer_elsewhere, [{ v: 2, home: 'n1', label: computeLabels(graph).get('n1') }]);
  // A home node the graph has not loaded (its file set aside) cannot be shown
  // "at nX": its version is left out of newer_elsewhere, never labelled by id.
  const partial = { nodes: new Map([['n0', graph.nodes.get('n0')]]), topology: new Map([['n0', { ...graph.topology.get('n0'), children: [] }]]) };
  assert.deepEqual(elementsForNode(partial, log, 'n0').find((r) => r.id === 'cb').newer_elsewhere, []);
  // Unknown node, null node, empty id: nothing visible.
  assert.deepEqual(elementsForNode(graph, log, 'nope'), []);
  assert.equal(visibleVersion(graph, log, 'ca', null), null);
  assert.equal(visibleVersion(graph, log, '', 'n2'), null);
});

// ── the server fork (fork.js's G-8 run) ────────────────────────────────────

async function turn(api, message, work) {
  const b = await api.post('/api/turn-begin', { message });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  if (work) await work();
  const e = await api.post('/api/turn-end', { author: 'claude' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.ok(e.json.node_id, `turn ${message} committed a node: ${JSON.stringify(e.json)}`);
  return e.json.node_id;
}
const reply = async (api, text) => {
  const r = await api.post(`/api/elements/${EL}/reply`, { text, author: 'user' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
};

test('server fork (G-8): pin A, reply r1 B, Set active A, reply r2 C — each node sees its own version, never a sibling\'s', async (t) => {
  const { api, srv, root } = await withServer(t);
  const graph = srv.graph;
  const store = graph.elements;
  const logFile = projectPaths(root).elementsLog;
  const A = await turn(api, 'A', async () => {
    await api.post('/api/render', { id: 'scope-pane', html: '<div><p id="a">Alpha</p><p id="b">Beta</p></div>' });
    const c = await api.post('/api/elements', commentBody({ text: 'root note', anchor: ANCHOR }));
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.pin.id, EL);
  });
  await reply(api, 'r1');
  const B = await turn(api, 'B');
  const re = await api.post('/api/graph/active', { id: A });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.ok(!re.json.preserved, 'a clean re-aim: no preserve node');
  await reply(api, 'r2');
  const C = await turn(api, 'C');
  assert.equal(graph.nodes.get(C).parent_id, A, 'C branches from A');

  const vA = visibleVersion(graph, store, EL, A);
  const vB = visibleVersion(graph, store, EL, B);
  const vC = visibleVersion(graph, store, EL, C);
  const pinned = (id) => Number(store.pinsOf(id).find((p) => p.startsWith(EL + '@')).split('@')[1]);
  assert.deepEqual([vA, vB, vC], [pinned(A), pinned(B), pinned(C)], 'each node sees its own copy');
  assert.equal(store.homeOf(EL, vA), A);
  assert.equal(store.homeOf(EL, vB), B);
  assert.equal(store.homeOf(EL, vC), C);
  const replies = (v) => (store.version(EL, v).payload.replies || []).map((r) => r.text);
  assert.deepEqual(replies(vC), ['r2'], 'C shows r2, never r1');
  assert.deepEqual(replies(vB), ['r1']);
  assert.deepEqual(replies(vA), []);

  const labels = computeLabels(graph);
  const [rowA] = elementsForNode(graph, store, A);
  assert.deepEqual(rowA, {
    id: EL, v: vA, newest_visible_v: vA,
    newer_elsewhere: [{ v: vB, home: B, label: labels.get(B) }, { v: vC, home: C, label: labels.get(C) }],
  });
  const [rowC] = elementsForNode(graph, store, C);
  assert.deepEqual(rowC.newer_elsewhere, [], 'B\'s v is older than C\'s: nothing newer elsewhere');

  // A node holding no copy: Set active C (clean), remove the pin, commit E.
  await api.post('/api/graph/active', { id: C });
  const del = await api.del(`/api/elements/${EL}`);
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const E = await turn(api, 'E', () => api.post('/api/render', { id: 'scope-pane-2', html: '<p>e</p>' }));
  assert.equal(graph.nodes.get(E).parent_id, C);
  assert.deepEqual(elementsForNode(graph, store, E), [{ id: EL, v: null, newest_visible_v: vC, newer_elsewhere: [] }]);

  // Set active over a dirty surface: Set active B (clean), reply r3 live, Set
  // active A → the preserve node is the home of every version it pins.
  await api.post('/api/graph/active', { id: B });
  await reply(api, 'r3');
  const re2 = await api.post('/api/graph/active', { id: A });
  assert.equal(re2.status, 200, JSON.stringify(re2.json));
  const P = re2.json.preserved;
  assert.ok(P && graph.nodes.has(P), 'a preserve node was committed');
  assert.equal(graph.nodes.get(P).parent_id, B);
  const pPins = store.pinsOf(P);
  assert.ok(pPins.length >= 1);
  for (const p of pPins) {
    const at = p.lastIndexOf('@');
    assert.equal(store.homeOf(p.slice(0, at), Number(p.slice(at + 1))), P, `${p} is homed at the preserve node`);
  }
  const vP = visibleVersion(graph, store, EL, P);
  assert.equal(vP, pinned(P));
  assert.deepEqual(replies(vP), ['r1', 'r3']);
  assert.equal(visibleVersion(graph, store, EL, B), vB, 'B still sees its own copy (P is a descendant)');
  assert.deepEqual(elementsForNode(graph, store, B)[0].newer_elsewhere.map((x) => x.home), [C, P]);

  // A version New graph dropped before any commit has no home and is visible
  // from no node: a reply minted on the live pin (Set active A restored v_A),
  // then New graph.
  const live = srv.state.comments.find((c) => c.id === EL);
  assert.ok(live, 'the live pin after Set active A');
  const dropped = store.reply(live, { text: 'never committed', author: 'user' });
  assert.ok(dropped.v > vP, 'the newest version of all');
  const ng = await api.post('/api/graph/new', { name: 'fresh' });
  assert.equal(ng.status, 200, JSON.stringify(ng.json));
  assert.equal(store.homeOf(EL, dropped.v), null, 'no commit pinned it');

  // Every node of the run: the pick is the newest version homed in its own
  // ancestry (0 cross-branch picks), and the dropped version is never picked.
  const bytes = fs.statSync(logFile).size;
  for (const id of graph.nodes.keys()) {
    const v = visibleVersion(graph, store, EL, id);
    assert.notEqual(v, dropped.v, `${id} never sees the homeless version`);
    const anc = new Set(lineage.ancestry(graph, id));
    assert.ok(anc.has(store.homeOf(EL, v)), `${id}'s pick is homed on its own ancestry`);
    const best = store.versionsOf(EL).map((r) => r.v).filter((x) => anc.has(store.homeOf(EL, x)));
    assert.equal(v, Math.max(...best));
    for (const row of elementsForNode(graph, store, id)) {
      assert.ok(!row.newer_elsewhere.some((x) => x.v === dropped.v), 'the homeless version is not even listed elsewhere');
    }
  }
  assert.equal(fs.statSync(logFile).size, bytes, 'the resolver made no writes');
});

// The replay groundwork: ONE node-ref resolver (domain/refs), the pure replay
// path (domain/replay-path) and GET /api/replay/path.
//
// The path resolver decides which frames a replay shows and what each caption
// says, so a wrong answer here is a replay that repeats a frame, skips a real
// change, loses a prompt, or plays a lineage the user never walked. The
// fixtures below reuse the collapse rules' shape (graph-collapse.test.js): `=`
// marks a node whose surface is identical to its parent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withServer } = require('../test-support/helpers');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');
const { resolveNodeRef, ancestorChain } = require('../lib/server/domain/refs');
const { resolveReplayPath, MAX_STEPS } = require('../lib/server/domain/replay-path');

const PANE_A = { id: 'a', html: '<p>A</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null };
const PANE_B = { id: 'b', html: '<p>B</p>', target: null, params: {}, component: null, pane_state: {}, form_state: {}, theme: null, owner: null };

let clock = 1000;
function node(id, parent_id, extra = {}) {
  clock += 1000;
  return {
    id, parent_id, created_at: clock, author: 'claude',
    trigger: { kind: 'turn', message: `prompt ${id}`, summary: `sum ${id}` },
    mounts: [], store: {}, comments: [], captures: [], ...extra,
  };
}

//   n0 root []                 n10 root [A]
//   n1 [A]      changed        n11 [A,B]
//   n2 =        COLLAPSE (+1 folded turn of its own)
//   n3 =        COLLAPSE
//   n4 [A,B]    changed, bookmarked 'mark' , folded 2 (count 3: one aged out)
//   n5 [A,B]+k  changed
//   n6 =        COLLAPSE
//   n7 [A]      changed   ← active
//   n8 [B]      sibling of n2 (a fork off n1) — NOT on n7's lineage
function nodes() {
  clock = 1000;
  return [
    node('n0', null),
    node('n1', 'n0', { mounts: [PANE_A] }),
    node('n2', 'n1', { mounts: [PANE_A], folded: [{ at: 1, author: 'claude', kind: 'turn', message: 'chat before n2', summary: 'chat before n2' }], folded_count: 1 }),
    node('n3', 'n2', { mounts: [PANE_A] }),
    node('n4', 'n3', {
      mounts: [PANE_A, PANE_B], bookmarked: true, name: 'mark',
      folded: [
        { at: 2, author: 'claude', kind: 'turn', message: 'f1', summary: 'f1' },
        { at: 3, author: 'wake', kind: 'turn', message: 'f2', summary: 'f2', reply: 'said f2' },
      ],
      folded_count: 3,
    }),
    node('n5', 'n4', { mounts: [PANE_A, PANE_B], store: { k: 1 } }),
    node('n6', 'n5', { mounts: [PANE_A, PANE_B], store: { k: 1 } }),
    node('n7', 'n6', { mounts: [PANE_A], store: { k: 1 }, trigger: { kind: 'turn', message: 'prompt n7', summary: 'sum n7', reply: 'reply n7' } }),
    node('n8', 'n1', { mounts: [PANE_B] }),
    node('n10', null, { mounts: [PANE_A] }),
    node('n11', 'n10', { mounts: [PANE_A, PANE_B] }),
  ];
}

function fakeGraph(list = nodes(), active = 'n7') {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-replay-')));
  const paths = { GRAPH_DIR: tmp, META_PATH: path.join(tmp, '_meta.json') };
  const state = createState();
  const graph = createGraph({ paths, state });
  for (const n of list) graph.registerNode(n); // parents precede children
  graph.active = active;
  state.mounts.set('live-pane', { html: '<p>live</p>', target: 'main', params: {} });
  state.store.live = true;
  return graph;
}

const ids = (r) => r.steps.map((s) => s.id);

// ── resolveNodeRef ─────────────────────────────────────────────────────────

test('resolveNodeRef: a stored id, a label, `active` and a missing ref', () => {
  const g = fakeGraph();
  const byId = resolveNodeRef(g, 'n4');
  assert.equal(byId.ok, true);
  assert.equal(byId.id, 'n4');
  assert.equal(byId.label, 'n1.4');
  assert.equal(byId.node, g.nodes.get('n4'));

  const byLabel = resolveNodeRef(g, 'n1.4');
  assert.equal(byLabel.id, 'n4', 'the label the user sees resolves to the stored node');

  for (const ref of [undefined, null, 'active']) {
    const a = resolveNodeRef(g, ref);
    assert.equal(a.id, 'n7', `${ref} → active`);
    assert.equal(a.label, 'n1.7');
  }

  const miss = resolveNodeRef(g, 'n9.9');
  assert.deepEqual([miss.ok, miss.code], [false, 'not-found']);
});

test('resolveNodeRef: a stored id wins over a label that spells the same string', () => {
  // `n2` is both the stored id of the node labelled n1.2 and a prefix of the
  // second tree's labels (n2.0, n2.1). Ids are exact, so they are tried first.
  const g = fakeGraph();
  assert.equal(resolveNodeRef(g, 'n2').id, 'n2');
  assert.equal(resolveNodeRef(g, 'n2.0').id, 'n10', 'the second tree\'s root, by label');
});

test('resolveNodeRef: `active` with no commit point is its own code', () => {
  const g = fakeGraph(nodes(), null);
  const r = resolveNodeRef(g, 'active');
  assert.deepEqual([r.ok, r.code], [false, 'no-active']);
});

test('resolveNodeRef: `live` is the snapshot under the ACTIVE node\'s theme, and can be refused', () => {
  const list = nodes();
  list.find((n) => n.id === 'n7').theme = { tokens: { '--wc-bg': '#000' } };
  const g = fakeGraph(list);
  const r = resolveNodeRef(g, 'live');
  assert.equal(r.ok, true);
  assert.equal(r.live, true);
  assert.deepEqual([r.id, r.label], ['live', 'live']);
  assert.deepEqual(r.node.mounts.map((m) => m.id), ['live-pane']);
  assert.deepEqual(r.node.store, { live: true });
  assert.deepEqual(r.node.theme, { tokens: { '--wc-bg': '#000' } });

  const noActive = resolveNodeRef(fakeGraph(nodes(), null), 'live');
  assert.equal(noActive.node.theme, null, 'no active node → no borrowed theme, not undefined');

  const refused = resolveNodeRef(g, 'live', { allowLive: false });
  assert.deepEqual([refused.ok, refused.code], [false, 'live-not-allowed']);
});

test('ancestorChain: root first, stops at a missing parent and at a cycle', () => {
  const g = fakeGraph();
  assert.deepEqual(ancestorChain(g, 'n7'), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
  assert.deepEqual(ancestorChain(g, 'n11'), ['n10', 'n11']);
  assert.deepEqual(ancestorChain(g, 'nope'), []);
  // A hand-edited cycle ends the walk instead of spinning.
  g.topology.get('n0').parent_id = 'n1';
  assert.deepEqual(ancestorChain(g, 'n1'), ['n0', 'n1']);
});

// ── resolveReplayPath ──────────────────────────────────────────────────────

test('replay path: `to` defaults to active, `from` to the nearest bookmark (inclusive)', () => {
  const r = resolveReplayPath(fakeGraph());
  assert.equal(r.ok, true);
  assert.deepEqual(r.to, { id: 'n7', label: 'n1.7' });
  assert.deepEqual(r.from, { id: 'n4', label: 'n1.4' });
  assert.equal(r.from_default, 'bookmark');
  assert.deepEqual(ids(r), ['n4', 'n5', 'n7'], 'n6 is a no-change node the viewer does not draw');

  // Inclusive: standing ON the bookmark replays just that node.
  const onMark = resolveReplayPath(fakeGraph(), { to: 'n4' });
  assert.deepEqual(ids(onMark), ['n4']);
});

test('replay path: with no bookmark above `to`, `from` defaults to the tree\'s root', () => {
  const r = resolveReplayPath(fakeGraph(), { to: 'n11' });
  assert.equal(r.from_default, 'root');
  assert.deepEqual(ids(r), ['n10', 'n11']);
  const viaN8 = resolveReplayPath(fakeGraph(), { to: 'n8' });
  assert.deepEqual(ids(viaN8), ['n0', 'n1', 'n8'], 'the bookmark on a sibling lineage is not an ancestor');
});

test('replay path: collapsed nodes are skipped and their captions ride the next kept step', () => {
  const r = resolveReplayPath(fakeGraph(), { from: 'n0' });
  assert.deepEqual(ids(r), ['n0', 'n1', 'n4', 'n5', 'n7']);
  assert.equal(r.skipped, 3);

  const n4 = r.steps.find((s) => s.id === 'n4');
  // Oldest first: n2's own folded turn, n2's trigger, n3's trigger, then n4's
  // own folded turns. Nothing the skipped nodes said is lost.
  assert.deepEqual(n4.folded.map((f) => f.prompt), ['chat before n2', 'prompt n2', 'prompt n3', 'f1', 'f2']);
  const n2 = n4.folded[1];
  assert.deepEqual({ id: n2.id, label: n2.label, collapsed: n2.collapsed, summary: n2.summary }, { id: 'n2', label: 'n1.2', collapsed: true, summary: 'sum n2' });
  assert.equal(n4.folded[4].reply, 'said f2', 'a folded turn keeps its reply summary');
  assert.equal(n4.folded[4].author, 'wake');
  // n2 carried 1, n2 + n3 themselves are 2, n4's own count is 3 (one aged out).
  assert.equal(n4.folded_count, 6);

  const n7 = r.steps.find((s) => s.id === 'n7');
  assert.deepEqual(n7.folded.map((f) => f.id), ['n6']);
  assert.equal(n7.folded_count, 1);
  assert.deepEqual(r.steps.find((s) => s.id === 'n5').folded, [], 'a step with nothing carried has an empty folded[]');
});

test('replay path: the step caption shape', () => {
  const r = resolveReplayPath(fakeGraph(), { from: 'n4' });
  const [n4, n5, n7] = r.steps;
  assert.deepEqual(Object.keys(n7).sort(), [
    'author', 'created_at', 'dt_from_prev', 'folded', 'folded_count', 'id', 'kind', 'label', 'prompt', 'reply', 'summary',
  ]);
  assert.deepEqual(
    { label: n7.label, author: n7.author, kind: n7.kind, prompt: n7.prompt, reply: n7.reply, summary: n7.summary },
    { label: 'n1.7', author: 'claude', kind: 'turn', prompt: 'prompt n7', reply: 'reply n7', summary: 'sum n7' },
  );
  assert.equal(n5.reply, null, 'a node that recorded no reply says null, not ""');
  assert.equal(n4.dt_from_prev, null, 'the first step has no predecessor');
  assert.equal(n5.dt_from_prev, n5.created_at - n4.created_at);
  assert.equal(n7.dt_from_prev, n7.created_at - n5.created_at, 'measured from the previous KEPT step, across the skipped n6');
});

test('replay path: includeCollapsed plays every commit', () => {
  const r = resolveReplayPath(fakeGraph(), { from: 'n0', includeCollapsed: true });
  assert.deepEqual(ids(r), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.steps[2].folded.map((f) => f.prompt), ['chat before n2']);
});

test('replay path: an endpoint is always a step, even one the viewer would hide', () => {
  const r = resolveReplayPath(fakeGraph(), { from: 'n2', to: 'n6' });
  assert.deepEqual(ids(r), ['n2', 'n4', 'n5', 'n6']);
  assert.deepEqual(r.steps[1].folded.map((f) => f.id || null), ['n3', null, null]);
});

test('replay path: refs are labels or ids; `from` must be an ancestor of `to`', () => {
  const g = fakeGraph();
  assert.deepEqual(ids(resolveReplayPath(g, { from: 'n1.1', to: 'n1.5' })), ['n1', 'n4', 'n5']);

  const side = resolveReplayPath(g, { from: 'n8', to: 'n7' });
  assert.deepEqual([side.ok, side.code, side.which], [false, 'not-ancestor', 'from']);
  assert.match(side.error, /n1\.1\.0 is not an ancestor of n1\.7/);
  const backwards = resolveReplayPath(g, { from: 'n7', to: 'n4' });
  assert.equal(backwards.code, 'not-ancestor', 'a descendant is not an ancestor');
  const otherTree = resolveReplayPath(g, { from: 'n10', to: 'n7' });
  assert.equal(otherTree.code, 'not-ancestor');

  assert.deepEqual(resolveReplayPath(g, { to: 'nope' }).which, 'to');
  assert.equal(resolveReplayPath(g, { to: 'nope' }).code, 'not-found');
  assert.equal(resolveReplayPath(g, { from: 'nope' }).code, 'not-found');
  assert.equal(resolveReplayPath(g, { to: 'live' }).code, 'live-not-allowed');
  assert.equal(resolveReplayPath(fakeGraph(nodes(), null)).code, 'no-active');
});

test(`replay path: capped at MAX_STEPS (${MAX_STEPS}), keeping the steps nearest \`to\``, () => {
  clock = 0;
  const list = [];
  const N = MAX_STEPS + 5;
  for (let i = 0; i < N; i++) {
    // Every node changes the surface, so none collapse.
    list.push({
      id: `n${i}`, parent_id: i ? `n${i - 1}` : null, created_at: 1000 + i, author: 'claude',
      trigger: { kind: 'turn', message: `p${i}`, summary: '' },
      mounts: [{ ...PANE_A, html: `<p>${i}</p>` }], store: {}, comments: [], captures: [],
    });
  }
  const g = fakeGraph(list, `n${N - 1}`);
  const r = resolveReplayPath(g);
  assert.equal(r.total_steps, N);
  assert.equal(r.truncated, true);
  assert.equal(r.steps.length, MAX_STEPS);
  assert.equal(r.steps[r.steps.length - 1].id, `n${N - 1}`, 'the replay still arrives at `to`');
  assert.equal(r.steps[0].id, 'n5');
  assert.deepEqual(r.from, { id: 'n5', label: r.steps[0].label }, '`from` reports where the replay actually starts');
  assert.equal(r.steps[0].dt_from_prev, null, 'the first KEPT step has no predecessor');

  const small = resolveReplayPath(g, { maxSteps: 3 });
  assert.deepEqual(ids(small), [`n${N - 3}`, `n${N - 2}`, `n${N - 1}`]);
  const under = resolveReplayPath(g, { from: `n${N - 3}` });
  assert.equal(under.truncated, false);
});

// ── GET /api/replay/path ───────────────────────────────────────────────────

const seed = ({ webChatDir }) => {
  const dir = path.join(webChatDir, 'graph');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of nodes()) fs.writeFileSync(path.join(dir, `${n.id}.json`), JSON.stringify(n));
  fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({ active: 'n7' }));
};

test('GET /api/replay/path: defaults, refs, include_collapsed and honest errors', async (t) => {
  const { api } = await withServer(t, { seed });

  const d = await api.get('/api/replay/path');
  assert.equal(d.status, 200);
  assert.deepEqual(d.json.steps.map((s) => s.label), ['n1.4', 'n1.5', 'n1.7']);
  assert.equal(d.json.from_default, 'bookmark');

  const all = await api.get('/api/replay/path?from=n1.0&to=n1.7&include_collapsed=1');
  assert.equal(all.json.steps.length, 8);
  const drawn = await api.get('/api/replay/path?from=n1.0&to=active&include_collapsed=0');
  assert.equal(drawn.json.steps.length, 5);
  // The same flag reader as GET /replay and the render body (document.flag).
  assert.equal((await api.get('/api/replay/path?from=n1.0&to=n1.7&include_collapsed=yes')).json.steps.length, 8);
  assert.equal((await api.get('/api/replay/path?from=n1.0&to=n1.7&include_collapsed=off')).json.steps.length, 5);
  const blank = await api.get('/api/replay/path?from=&to=');
  assert.deepEqual(blank.json.steps.map((s) => s.id), ['n4', 'n5', 'n7'], 'an empty param means the default');

  const missing = await api.get('/api/replay/path?to=n9.9');
  assert.equal(missing.status, 404);
  assert.deepEqual([missing.json.code, missing.json.which], ['not-found', 'to']);
  const side = await api.get('/api/replay/path?from=n8&to=n7');
  assert.equal(side.status, 400);
  assert.equal(side.json.code, 'not-ancestor');
  const live = await api.get('/api/replay/path?to=live');
  assert.equal(live.status, 400);
  assert.equal(live.json.code, 'live-not-allowed');
});

// ── the three former copies now go through resolveNodeRef ────────────────────

test('export and diff resolve through the one resolver', async (t) => {
  const { api } = await withServer(t, { seed });
  // The diff route: a label on one side, a stored id on the other.
  const diff = await api.get('/api/graph/diff?a=n1.4&b=n5');
  assert.equal(diff.status, 200);
  assert.deepEqual([diff.json.a, diff.json.b], [{ id: 'n4', label: 'n1.4' }, { id: 'n5', label: 'n1.5' }]);
  const nf = await api.get('/api/graph/diff?a=n1.4&b=nope');
  assert.deepEqual([nf.status, nf.json.error, nf.json.which], [404, 'node not found', 'b']);

  // Export by label, by id, and the default.
  for (const ref of ['n1.4', 'n4']) {
    const r = await api.get(`/api/export/${ref}`);
    assert.equal(r.status, 200, ref);
    assert.match(r.headers.get('content-disposition') || '', /n1-4\.html/);
  }
  const e404 = await api.get('/api/export/n9.9');
  assert.deepEqual([e404.status, e404.json.error], [404, 'node not found: n9.9']);

  // Nothing is left carrying its own label → id scan.
  const root = path.join(__dirname, '..');
  for (const rel of ['lib/server/export.js', 'lib/server/routes/graph.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(src, /label === |labelToId/, `${rel} should resolve refs through domain/refs`);
  }
});

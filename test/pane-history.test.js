// Pane history (notes.txt; plan §1d): GET /api/mounts/:id/history walks the
// active node's ancestry for the distinct versions of one pane,
// GET /preview/pane/:node/:mount renders one version read-only, and
// POST /api/mounts/:id/restore ("make current") copies a version back into the
// live slot as a USER write. Pinned here: what counts as a version (content, not
// layout or typing), which node a version is attributed to, the live row, the
// preview's isolation, and every refusal of the restore.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, waitUntil } = require('../test-support/helpers');
const { ancestry, specHash, mountHistory } = require('../lib/server/domain/lineage');
const { PREVIEW_CSP } = require('../lib/core/cors');

const render = (api, id, html, extra = {}) => api.post('/api/render', { id, html, ...extra });
const history = async (api, id, q = '') => (await api.get(`/api/mounts/${id}/history${q}`)).json;
const mounts = async (api) => (await api.get('/api/mounts')).json.mounts;
const paneOf = async (api, id) => (await mounts(api)).find((m) => m.id === id);
async function turn(api, message = 't') {
  await api.post('/api/turn-begin', { message });
  return (await api.post('/api/turn-end', {})).json;
}

async function browser(ctx) {
  const sock = ctx.ws();
  const frames = [];
  sock.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'));
  return { sock, frames, send: (f) => sock.send(JSON.stringify(f)) };
}

// ── lineage (pure) ─────────────────────────────────────────────────────────

function fakeGraph(nodes) {
  return { nodes: new Map(nodes.map((n) => [n.id, n])) };
}

test('lineage: ancestry walks newest-first to the root and survives a cycle or a dangling parent', () => {
  const g = fakeGraph([
    { id: 'n0', parent_id: null },
    { id: 'n1', parent_id: 'n0' },
    { id: 'n2', parent_id: 'n1' },
    { id: 'n3', parent_id: 'n0' },
  ]);
  assert.deepEqual(ancestry(g, 'n2'), ['n2', 'n1', 'n0']);
  assert.deepEqual(ancestry(g, 'n3'), ['n3', 'n0'], 'a branch walks its own line, not its sibling');
  assert.deepEqual(ancestry(g, null), []);
  assert.deepEqual(ancestry(g, 'nope'), []);
  const cyc = fakeGraph([{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }]);
  assert.deepEqual(ancestry(cyc, 'a'), ['a', 'b'], 'a hand-edited cycle ends the walk');
  const dangling = fakeGraph([{ id: 'x', parent_id: 'gone' }]);
  assert.deepEqual(ancestry(dangling, 'x'), ['x']);
});

test('lineage: a version is its content — pane_state, form_state, theme and owner do not make a new one', () => {
  const base = { html: '<p>a</p>', params: { k: 1 }, component: undefined };
  const h = specHash(base);
  assert.equal(specHash({ ...base, pane_state: { colSpan: 6, pinned: true } }), h);
  assert.equal(specHash({ ...base, form_state: { '#x:0': 'typed' } }), h);
  assert.equal(specHash({ ...base, theme: { tokens: { '--wc-bg': '#000' } }, owner: 'claude' }), h);
  assert.equal(specHash({ html: '<p>a</p>', params: { k: 1 } }), h, 'absent and undefined hash alike');
  assert.notEqual(specHash({ ...base, html: '<p>b</p>' }), h);
  assert.notEqual(specHash({ ...base, params: { k: 2 } }), h);
  assert.notEqual(specHash({ ...base, component: 'clock' }), h);
});

test('lineage: a run of one version is attributed to the node that introduced it; A→B→A lists A once, at its latest introduction', () => {
  const m = (html) => ({ id: 'p', html });
  const g = fakeGraph([
    { id: 'n0', parent_id: null, created_at: 1, author: 'claude', trigger: { summary: 'first' }, mounts: [m('A')] },
    { id: 'n1', parent_id: 'n0', created_at: 2, author: 'claude', trigger: { summary: 'same' }, mounts: [m('A')] },
    { id: 'n2', parent_id: 'n1', created_at: 3, author: 'claude', trigger: { summary: 'to B' }, mounts: [m('B')] },
    { id: 'n3', parent_id: 'n2', created_at: 4, author: 'user', trigger: { summary: 'gone' }, mounts: [] },
    { id: 'n4', parent_id: 'n3', created_at: 5, author: 'claude', trigger: { summary: 'back to A' }, mounts: [m('A')] },
    { id: 'n5', parent_id: 'n4', created_at: 6, author: 'claude', trigger: { summary: 'still A' }, mounts: [m('A')] },
  ]);
  const labels = new Map([['n4', 'n1.4']]);
  const v = mountHistory(g, { mountId: 'p', fromId: 'n5', labels });
  assert.deepEqual(v.map((x) => x.node_id), ['n4', 'n2'], 'newest first, deduped, a gap breaks a run');
  assert.equal(v[0].label, 'n1.4');
  assert.equal(v[0].trigger_summary, 'back to A');
  assert.equal(v[1].label, 'n2', 'an unlabelled node falls back to its id');
  assert.equal(v[1].created_at, 3);
  // Without the gap, the run reaches back to its first node.
  const early = mountHistory(g, { mountId: 'p', fromId: 'n1', labels });
  assert.deepEqual(early.map((x) => x.node_id), ['n0']);
  // A gap breaks a run even when the same version comes back after it: the
  // version is attributed to its return, not to the node before the gap.
  const gap = fakeGraph([
    { id: 'g0', parent_id: null, created_at: 1, mounts: [m('A')] },
    { id: 'g1', parent_id: 'g0', created_at: 2, mounts: [] },
    { id: 'g2', parent_id: 'g1', created_at: 3, mounts: [m('A')] },
  ]);
  assert.deepEqual(mountHistory(gap, { mountId: 'p', fromId: 'g2' }).map((x) => x.node_id), ['g2']);
});

// ── GET /api/mounts/:id/history ─────────────────────────────────────────────

test('history: distinct versions along the active ancestry, newest first, with labels and trigger summaries', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p', '<p>v1</p>');
  const a = await turn(api, 'first version');
  await render(api, 'other', '<p>x</p>'); // p unchanged across this node
  await turn(api, 'unrelated');
  await render(api, 'p', '<p>v1</p>', { place: { col: 1, span: 6 } }); // layout only
  await turn(api, 'resized');
  await render(api, 'p', '<p>v2</p>');
  const c = await turn(api, 'second version');

  const h = await history(api, 'p');
  assert.equal(h.ok, true);
  assert.equal(h.id, 'p');
  assert.deepEqual(h.versions.map((v) => v.node_id), [c.node_id, a.node_id]);
  const [v2, v1] = h.versions;
  assert.equal(v1.trigger_summary, 'first version', 'attributed to the node that introduced it');
  assert.equal(v2.trigger_summary, 'second version');
  assert.match(v1.label, /^n1\.\d+$/);
  assert.equal(v2.author, 'claude');
  assert.equal(v2.owner, 'claude');
  assert.equal(typeof v2.spec_hash, 'string');
  assert.equal(v2.current, true, 'the live pane matches the newest version');
  assert.equal('current' in v1, false);
  assert.equal(h.versions.some((v) => v.node_id === 'live'), false, 'live equals a listed version: no live row');
});

test('history: live content no node has is a `live` row on top; a pane that never existed has no versions', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p', '<p>v1</p>');
  const a = await turn(api);
  await render(api, 'p', '<p>draft</p>');
  const h = await history(api, 'p');
  assert.deepEqual(h.versions.map((v) => v.node_id), ['live', a.node_id]);
  assert.equal(h.versions[0].current, true);
  assert.equal(h.versions[0].label, 'live');
  assert.equal('current' in h.versions[1], false);

  assert.deepEqual((await history(api, 'nobody')).versions, []);
});

test('history: ?from walks another node\'s line and never includes the live surface; an unknown from is a 404', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p', '<p>v1</p>');
  const a = await turn(api);
  await render(api, 'p', '<p>v2</p>');
  await turn(api);
  await render(api, 'p', '<p>draft</p>');
  const h = await history(api, 'p', `?from=${a.node_id}`);
  assert.equal(h.from, a.node_id);
  assert.deepEqual(h.versions.map((v) => v.node_id), [a.node_id]);
  assert.equal(h.versions[0].current, undefined, 'current is only judged against the live surface');
  const r = await api.get('/api/mounts/p/history?from=n999');
  assert.equal(r.status, 404);
});

// ── GET /preview/pane/:node/:mount ──────────────────────────────────────────

test('preview/pane: one version of one pane under PREVIEW_CSP — no other pane, no markdown, never minimized', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'p', '<p>PANE-P-V1</p>');
  await render(api, 'q', '<p>PANE-Q</p>');
  await api.post('/api/markdown', { id: 'intro', text: '# INTRO-HEADING' });
  const a = await turn(api);

  const r = await api.get(`/preview/pane/${a.node_id}/p`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), PREVIEW_CSP);
  assert.match(r.text, /PANE-P-V1/);
  assert.doesNotMatch(r.text, /PANE-Q/, 'the other pane is not in the document');
  assert.doesNotMatch(r.text, /INTRO-HEADING/, 'the page markdown is not in the document');

  // A minimized pane previews visible and full-width.
  const b = await browser(ctx);
  b.send({ type: 'pane:state', id: 'p', pane_state: { minimized: true, colSpan: 4, col: 3 } });
  await waitUntil(async () => (await paneOf(api, 'p')).pane_state?.minimized === true);
  b.sock.close();
  await render(api, 'p', '<p>PANE-P-V2</p>');
  const c = await turn(api);
  const r2 = await api.get(`/preview/pane/${c.node_id}/p`);
  const node = JSON.parse(r2.text.match(/const NODE = (.*);\n/)[1]);
  assert.deepEqual(node.mounts.map((m) => m.id), ['p']);
  assert.equal(node.mounts[0].pane_state.minimized, undefined);
  assert.equal(node.mounts[0].pane_state.colSpan, 12);
  assert.equal(node.mounts[0].pane_state.col, undefined);

  for (const bad of [`/preview/pane/n999/p`, `/preview/pane/${a.node_id}/nope`]) {
    const x = await api.get(bad);
    assert.equal(x.status, 404, bad);
    assert.equal(x.headers.get('content-security-policy'), PREVIEW_CSP, `${bad}: the 404 is under the policy too`);
  }
});

test('preview/pane (and preview/node) draw in the viewer\'s ?mode=, else the server default', async (t) => {
  const { api } = await withServer(t);
  const applied = await api.post('/api/theme/apply', { name: 'earthy', scope: 'global' });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  await render(api, 'p', '<p>x</p>');
  const a = await turn(api);
  const bg = (html) => (html.match(/--wc-bg:\s*([^;]+);/) || [])[1];
  for (const path of [`/preview/pane/${a.node_id}/p`, `/preview/node/${a.node_id}`]) {
    assert.equal(bg((await api.get(path)).text), '#e4dccb', `${path}: light by default`);
    assert.equal(bg((await api.get(`${path}?mode=dark`)).text), '#151109', `${path}: dark when asked`);
    assert.equal(bg((await api.get(`${path}?mode=sepia`)).text), '#e4dccb', `${path}: an unknown mode is ignored`);
  }
});

// ── POST /api/mounts/:id/restore ────────────────────────────────────────────

test('restore: copies the version\'s content into the live slot as a `history` write that folds into the next commit', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p', '<p>v1</p>', { params: { title: 'one' } });
  const a = await turn(api);
  await render(api, 'p', '<p>v2</p>', { params: { title: 'two' } });
  await turn(api);
  const before = (await api.get('/api/events')).json.events.length;

  const r = await api.post('/api/mounts/p/restore', { node_id: a.node_id });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.owner, 'claude', 'the version stays Claude\'s');
  assert.equal(r.json.restored_from, a.node_id);

  const live = await paneOf(api, 'p');
  assert.equal(live.owner, 'claude');
  const evs = (await api.get('/api/events')).json.events.slice(before);
  const ev = evs.find((e) => e.kind === 'render' && e.id === 'p');
  assert.equal(ev.source, 'history', 'a user action, never source:claude');

  // It is a surface change: the next turn commits it, and the history now
  // marks the restored version as current with no live row.
  const h = await history(api, 'p');
  assert.equal(h.versions.find((v) => v.node_id === a.node_id).current, true);
  assert.equal(h.versions.some((v) => v.node_id === 'live'), false);
  const c = await turn(api);
  assert.ok(c.node_id, 'the restore committed a node');
  const node = (await api.get(`/api/graph/node/${c.node_id}`)).json;
  const p = node.mounts.find((m) => m.id === 'p');
  assert.equal(p.html, '<p>v1</p>');
  assert.deepEqual(p.params, { title: 'one' });
});

test('restore: a history write does not keep Claude\'s turn lock alive', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p', '<p>v1</p>');
  const a = await turn(api);
  await render(api, 'p', '<p>v2</p>');
  await turn(api);
  await api.post('/api/turn-begin', { message: 'x' });
  const started = (await api.get('/api/graph')).json.lock.started_at;
  await new Promise((r) => setTimeout(r, 15));
  await api.post('/api/mounts/p/restore', { node_id: a.node_id });
  assert.equal((await api.get('/api/graph')).json.lock.started_at, started);
  await render(api, 'p', '<p>v3</p>'); // control: Claude's own write does re-stamp
  assert.ok((await api.get('/api/graph')).json.lock.started_at > started);
});

test('restore: layout comes from the version, the user\'s pin stays; typed values carry unless with_form', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'p', '<p>v1</p>', { place: { col: 1, span: 6, rows: 4 } });
  const b = await browser(ctx);
  b.send({ type: 'pane:form', id: 'p', form_state: { '#name:0': 'old typing' } });
  await waitUntil(async () => (await paneOf(api, 'p')).form_state);
  const a = await turn(api);
  await render(api, 'p', '<p>v2</p>', { place: { col: 7, span: 6 } });
  b.send({ type: 'pane:state', id: 'p', pane_state: { pinned: true } });
  b.send({ type: 'pane:form', id: 'p', form_state: { '#name:0': 'new typing' } });
  await waitUntil(async () => {
    const p = await paneOf(api, 'p');
    return p.pane_state.pinned && p.form_state['#name:0'] === 'new typing';
  });
  b.sock.close();
  await turn(api);

  await api.post('/api/mounts/p/restore', { node_id: a.node_id });
  let p = await paneOf(api, 'p');
  assert.deepEqual(p.place, { col: 1, span: 6, rows: 4 }, 'the version\'s layout');
  assert.deepEqual(p.pane_state.claude_place, { col: 1, span: 6, rows: 4 });
  assert.equal(p.pane_state.pinned, true, 'restoring content never unpins');
  assert.deepEqual(p.form_state, { '#name:0': 'new typing' }, 'the live typing carries');

  await api.post('/api/mounts/p/restore', { node_id: a.node_id, with_form: true });
  p = await paneOf(api, 'p');
  assert.deepEqual(p.form_state, { '#name:0': 'old typing' }, 'with_form takes the version\'s');
});

test('restore: a pane cleared since comes back; a version without a component drops the live one', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p', '<p>v1</p>');
  const a = await turn(api);
  await api.post('/api/clear', { id: 'p' });
  await render(api, 'q', '<p>q</p>');
  await turn(api);
  const r = await api.post('/api/mounts/p/restore', { node_id: a.node_id });
  assert.equal(r.json.ok, true);
  const all = await mounts(api);
  assert.deepEqual(all.map((m) => m.id), ['q', 'p'], 'appended to the page');
});

test('restore: refused on a locked pane, a driver-owned pane, a driver-written version, and bad requests', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'p', '<p>v1</p>');
  await render(api, 'svc', '<p>s1</p>', { owner: 'service:watch' });
  await render(api, 'mine', '<p>m1</p>', { owner: 'service:watch' });
  const a = await turn(api);
  await render(api, 'p', '<p>v2</p>');
  await render(api, 'mine', '<p>m2</p>', { force: true }); // Claude takes it over
  await turn(api);

  // Driver-owned live pane.
  let r = await api.post('/api/mounts/svc/restore', { node_id: a.node_id });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.owned, true);
  assert.equal(r.json.owner, 'service:watch');
  assert.match(r.json.hint, /only a pane Claude owns/);
  // Claude's live pane, but the chosen version was a driver's.
  r = await api.post('/api/mounts/mine/restore', { node_id: a.node_id });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.owned, true);
  assert.match(r.json.hint, /version/);
  assert.equal((await paneOf(api, 'mine')).owner, 'claude', 'nothing changed');

  // Locked.
  const b = await browser(ctx);
  b.send({ type: 'pane:state', id: 'p', pane_state: { locked: true } });
  await waitUntil(async () => (await paneOf(api, 'p')).pane_state?.locked);
  b.sock.close();
  r = await api.post('/api/mounts/p/restore', { node_id: a.node_id });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.locked, true);

  assert.equal((await api.post('/api/mounts/p/restore', {})).status, 400);
  assert.equal((await api.post('/api/mounts/p/restore', { node_id: 'n999' })).status, 404);
  assert.equal((await api.post('/api/mounts/nope/restore', { node_id: a.node_id })).status, 404);
});

test('restore: a version without a component drops the live one (the supervisor stops a service the version never had)', () => {
  const { createState } = require('../lib/server/state');
  const { restoreMount } = require('../lib/server/domain/mounts');
  const state = createState();
  const frames = [];
  const bus = { emit: (e) => frames.push(e) };
  state.mounts.set('p', { html: '<p>svc</p>', target: 'main', component: 'git-dashboard', owner: 'claude', gen: 0 });
  state.order = ['p'];
  const r = restoreMount(state, bus, { id: 'p', version: { id: 'p', html: '<p>old</p>', target: 'main', owner: 'claude' } });
  assert.equal(r.ok, true);
  assert.equal('component' in state.mounts.get('p'), false);
  assert.equal(frames[0].event.source, 'history');
  assert.equal(frames[0].ws.component, undefined);
});

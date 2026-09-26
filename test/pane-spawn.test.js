// Panes spawning panes (notes.txt): a pane script's `api.spawn` / `api.close`
// → POST /api/pane/spawn|close → lib/server/domain/spawn → setMount/removeMount.
// Pinned here: the owner stamp and what it lets a pane do (replace/close its
// own children, close itself, nothing else), the parent check, the lock, the
// caps (children, total, depth, rate, html, params), the signals strip, the
// default placement, component spawns, and that a spawned pane is surface
// content like any other (it commits with the node). The chrome half — the
// runtime hands scripts an `api`, and the chrome stamps `parent` — is pinned in
// test/mount-runtime.test.js and test/mount-chrome-safety.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, waitUntil } = require('../test-support/helpers');
const { createState } = require('../lib/server/state');
const spawn = require('../lib/server/domain/spawn');
const { setMount } = require('../lib/server/domain/mounts');
const { derive } = require('../lib/server/domain/signals');

const render = (api, id, html = `<p>${id}</p>`, extra = {}) => api.post('/api/render', { id, html, ...extra });
const doSpawn = async (api, parent, spec = {}) => (await api.post('/api/pane/spawn', { html: '<p>child</p>', ...spec, parent })).json;
const doClose = async (api, parent, id) => (await api.post('/api/pane/close', { parent, id })).json;
const listing = async (api) => (await api.get('/api/mounts')).json;
const paneOf = async (api, id) => (await listing(api)).mounts.find((m) => m.id === id);

async function browser(ctx) {
  const sock = ctx.ws();
  const frames = [];
  sock.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'));
  return { sock, frames, send: (f) => sock.send(JSON.stringify(f)) };
}

// ── the domain, driven directly (caps need numbers no HTTP test should loop) ──

function fixture() {
  const state = createState();
  const events = [];
  const bus = { emit: (e) => events.push(e) };
  setMount(state, bus, { id: 'root', html: '<p>root</p>' });
  return { state, bus, events };
}

test('spawn: a child is owned by its parent, named after it, and lands beneath it in spawn order', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'a');
  await render(api, 'p');
  await render(api, 'z');
  const r1 = await doSpawn(api, 'p');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.id, 'p-1');
  assert.equal(r1.owner, 'pane:p');
  assert.equal(r1.parent, 'p');
  const r2 = await doSpawn(api, 'p', { html: '<p>two</p>' });
  assert.equal(r2.id, 'p-2');
  const l = await listing(api);
  assert.deepEqual(l.order, ['a', 'p', 'p-1', 'p-2', 'z'], 'children follow the parent, in spawn order');
  assert.equal(l.mounts.find((m) => m.id === 'p-1').owner, 'pane:p');
  // An explicit after wins over the default.
  const r3 = await doSpawn(api, 'p', { id: 'top', after: 'start' });
  assert.equal(r3.ok, true);
  assert.equal((await listing(api)).order[0], 'top');
  // The ring records the write as the pane's, not Claude's.
  const ev = (await api.get('/api/events')).json.events.filter((e) => e.kind === 'render' && e.id === 'p-1');
  assert.equal(ev.at(-1).source, 'pane:p');
});

test('spawn: the parent must be a live pane, and never the child itself', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p');
  await api.post('/api/markdown', { id: 'md-x', text: '# hi' });
  assert.equal((await doSpawn(api, undefined)).no_parent, true, 'no parent stamped');
  assert.equal((await doSpawn(api, 'ghost')).no_parent, true, 'a pane that is not on the surface');
  assert.equal((await doSpawn(api, 'md-x')).no_parent, true, 'a markdown item is not a pane');
  const self = await doSpawn(api, 'p', { id: 'p' });
  assert.equal(self.ok, false);
  assert.equal(self.self, true);
  assert.equal((await paneOf(api, 'p')).owner, 'claude', 'the parent is untouched');
  // Malformed requests are 400s: exactly one of html / component.
  assert.equal((await api.post('/api/pane/spawn', { parent: 'p' })).status, 400);
  assert.equal((await api.post('/api/pane/spawn', { parent: 'p', html: 'x', component: 'website' })).status, 400);
  // Reserved ids and the markdown id space go through setMount's own refusals.
  assert.equal((await doSpawn(api, 'p', { id: 'topbar' })).reserved, true);
  assert.equal((await doSpawn(api, 'p', { id: 'md-x' })).conflict, 'markdown');
});

test('ownership: a pane replaces and closes only its own children (or itself); Claude needs force for them', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p');
  await render(api, 'q');
  await render(api, 'mine');
  await doSpawn(api, 'p', { id: 'pc' });
  await doSpawn(api, 'q', { id: 'qc' });

  // Replace own child: same owner, gen bumps, position kept.
  const before = (await listing(api)).order;
  const re = await doSpawn(api, 'p', { id: 'pc', html: '<p>v2</p>' });
  assert.equal(re.ok, true);
  assert.deepEqual((await listing(api)).order, before, 'a re-spawn keeps its place');

  // Not someone else's: Claude's pane, or a sibling's child.
  const overClaude = await doSpawn(api, 'p', { id: 'mine' });
  assert.equal(overClaude.owned, true);
  assert.equal(overClaude.owner, 'claude');
  assert.equal((await doSpawn(api, 'p', { id: 'qc' })).owned, true);
  assert.equal((await doClose(api, 'p', 'qc')).owned, true, 'a sibling\'s child');
  assert.equal((await doClose(api, 'p', 'mine')).owned, true, 'Claude\'s pane');
  assert.ok(await paneOf(api, 'qc'));
  assert.ok(await paneOf(api, 'mine'));

  // Claude over a pane-spawned pane: the driver-ownership refusal, force escapes.
  const claudeOver = (await render(api, 'pc')).json;
  assert.equal(claudeOver.owned, true);
  assert.equal(claudeOver.owner, 'pane:p');
  assert.equal((await api.post('/api/clear', {})).json.owned, true, 'a bulk clear is rejected whole');
  assert.equal((await api.post('/api/clear', { id: 'pc' })).json.owned, true);

  // Close own child, then itself.
  assert.deepEqual(await doClose(api, 'p', 'pc'), { ok: true, id: 'pc', parent: 'p' });
  assert.equal(await paneOf(api, 'pc'), undefined);
  assert.equal((await doClose(api, 'p', 'pc')).not_found, true);
  assert.equal((await doClose(api, 'q', 'q')).ok, true, 'a pane may close itself');
  assert.equal(await paneOf(api, 'q'), undefined);
  // Its child outlives it (orphaned, still owned by the gone parent's name) and
  // the gone parent can do nothing further.
  assert.equal((await paneOf(api, 'qc')).owner, 'pane:q');
  assert.equal((await doClose(api, 'q', 'qc')).no_parent, true);
  // The ring names the pane as the closer.
  const ev = (await api.get('/api/events')).json.events.filter((e) => e.kind === 'clear' && e.id === 'pc');
  assert.equal(ev.at(-1).source, 'pane:p');
});

test('lock: a user-locked child refuses both a re-spawn and a close', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await render(api, 'p');
  await doSpawn(api, 'p', { id: 'pc' });
  const b = await browser(ctx);
  t.after(() => b.sock.close());
  b.send({ type: 'pane:state', id: 'pc', pane_state: { locked: true } });
  await waitUntil(async () => (await paneOf(api, 'pc')).pane_state?.locked);
  assert.equal((await doSpawn(api, 'p', { id: 'pc', html: '<p>new</p>' })).locked, true);
  assert.equal((await doClose(api, 'p', 'pc')).locked, true);
  assert.ok(await paneOf(api, 'pc'));
  // A locked parent can still spawn (the lock guards that pane, not its children).
  b.send({ type: 'pane:state', id: 'p', pane_state: { locked: true } });
  await waitUntil(async () => (await paneOf(api, 'p')).pane_state?.locked);
  assert.equal((await doSpawn(api, 'p')).ok, true);
});

test('component spawn: resolves the component, records it, and refuses a name that is not one', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p');
  const r = await doSpawn(api, 'p', { html: undefined, component: 'website', params: { url: 'https://example.com' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const m = await paneOf(api, r.id);
  assert.equal(m.component, 'website');
  assert.equal(m.owner, 'pane:p');
  const missing = await doSpawn(api, 'p', { html: undefined, component: 'no-such-thing' });
  assert.equal(missing.not_found, true);
  const hostile = await doSpawn(api, 'p', { html: undefined, component: '../../etc' });
  assert.equal(hostile.not_found, true, 'the name grammar is the containment rule');
});

test('remote (X-WC-Remote: 1): an html spawn is refused 403 before anything lands; a component spawn still works', async (t) => {
  const { api } = await withServer(t);
  await render(api, 'p');
  const remote = { 'x-wc-remote': '1' };
  const r = await api.post('/api/pane/spawn', { parent: 'p', id: 'kid', html: '<script>1</script>' }, remote);
  assert.equal(r.status, 403);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.remote, true);
  assert.match(r.json.hint, /component/);
  assert.equal(await paneOf(api, 'kid'), undefined, 'nothing mounted');
  // Even a malformed body with html in it is refused as remote, not argued with.
  const both = await api.post('/api/pane/spawn', { parent: 'p', html: '<p>x</p>', component: 'website' }, remote);
  assert.equal(both.status, 403);
  const comp = await api.post('/api/pane/spawn', { parent: 'p', component: 'website', params: { url: 'https://example.com' } }, remote);
  assert.equal(comp.json.ok, true, JSON.stringify(comp.json));
  // Any other value of the label is not the portal's, and the local path is unchanged.
  const local = await api.post('/api/pane/spawn', { parent: 'p', id: 'kid', html: '<p>x</p>' }, { 'x-wc-remote': '0' });
  assert.equal(local.json.ok, true, JSON.stringify(local.json));
});

test('a spawned pane is surface content: it commits with the turn, owner and all', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'go' });
  await render(api, 'p');
  await doSpawn(api, 'p', { id: 'pc' });
  const end = (await api.post('/api/turn-end', {})).json;
  const nodeId = end.node_id;
  const node = (await api.get(`/api/graph/node/${nodeId}`)).json;
  const pc = node.mounts.find((m) => m.id === 'pc');
  assert.ok(pc, 'the child is in the committed node');
  assert.equal(pc.owner, 'pane:p', 'the owner travels with the node');
});

test('the render frame names the writer, so the chrome can show a child\'s parent', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  const b = await browser(ctx);
  await render(api, 'p');
  await doSpawn(api, 'p', { id: 'pc' });
  await waitUntil(() => b.frames.some((f) => f.type === 'render' && f.id === 'pc'));
  assert.equal(b.frames.find((f) => f.type === 'render' && f.id === 'p').owner, 'claude');
  assert.equal(b.frames.find((f) => f.type === 'render' && f.id === 'pc').owner, 'pane:p');
  b.sock.close();
});

test('caps: children per parent, pane-spawned total, spawn depth', () => {
  const { state, bus } = fixture();
  for (let i = 0; i < spawn.MAX_CHILDREN; i++) {
    const r = spawn.spawnPane(state, bus, { parent: 'root', html: 'x', now: i * 1000 });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const over = spawn.spawnPane(state, bus, { parent: 'root', html: 'x', now: 99_000 });
  assert.equal(over.cap, 'children');
  // Re-spawning an existing child is not a new one — the cap does not bite.
  assert.equal(spawn.spawnPane(state, bus, { parent: 'root', id: 'root-1', html: 'y', now: 99_000 }).ok, true);
  // Closing one makes room.
  assert.equal(spawn.closePane(state, bus, { parent: 'root', id: 'root-1', now: 99_000 }).ok, true);
  assert.equal(spawn.spawnPane(state, bus, { parent: 'root', html: 'x', now: 120_000 }).ok, true);

  // Depth: root(0) → d1 → d2 → d3; d3 cannot spawn.
  const s2 = fixture();
  let parent = 'root';
  for (let d = 1; d <= spawn.MAX_DEPTH; d++) {
    const r = spawn.spawnPane(s2.state, s2.bus, { parent, id: `d${d}`, html: 'x' });
    assert.equal(r.ok, true, `depth ${d}: ${JSON.stringify(r)}`);
    assert.equal(spawn.depthOf(s2.state, `d${d}`), d);
    parent = `d${d}`;
  }
  assert.equal(spawn.spawnPane(s2.state, s2.bus, { parent, html: 'x' }).cap, 'depth');

  // Total: many parents, each under its own cap, still bounded surface-wide.
  const s3 = fixture();
  const parents = Math.ceil(spawn.MAX_SPAWNED_TOTAL / 10) + 1;
  for (let p = 0; p < parents; p++) setMount(s3.state, s3.bus, { id: `P${p}`, html: 'x' });
  let made = 0, refused = null;
  outer: for (let p = 0; p < parents; p++) {
    for (let i = 0; i < 10; i++) {
      const r = spawn.spawnPane(s3.state, s3.bus, { parent: `P${p}`, html: 'x' });
      if (!r.ok) { refused = r; break outer; }
      made++;
    }
  }
  assert.equal(made, spawn.MAX_SPAWNED_TOTAL);
  assert.equal(refused.cap, 'total');
});

test('caps: the per-parent rate window counts spawns and closes, and slides', () => {
  const { state, bus } = fixture();
  const t0 = 1_000_000;
  for (let i = 0; i < spawn.RATE_MAX; i++) {
    assert.equal(spawn.spawnPane(state, bus, { parent: 'root', id: 'c', html: `v${i}`, now: t0 }).ok, true);
  }
  const r = spawn.spawnPane(state, bus, { parent: 'root', id: 'c', html: 'more', now: t0 + 1 });
  assert.equal(r.cap, 'rate');
  assert.equal(spawn.closePane(state, bus, { parent: 'root', id: 'c', now: t0 + 2 }).cap, 'rate');
  assert.equal(state.mounts.get('c').html, `v${spawn.RATE_MAX - 1}`, 'a refused write changes nothing');
  // Another parent has its own window.
  setMount(state, bus, { id: 'other', html: 'x' });
  assert.equal(spawn.spawnPane(state, bus, { parent: 'other', html: 'x', now: t0 + 3 }).ok, true);
  // Once the window has slid past, the parent may write again.
  assert.equal(spawn.closePane(state, bus, { parent: 'root', id: 'c', now: t0 + spawn.RATE_WINDOW_MS }).ok, true);
});

test('caps: html and params size; params must be an object', () => {
  const { state, bus } = fixture();
  const big = spawn.spawnPane(state, bus, { parent: 'root', html: 'x'.repeat(spawn.HTML_MAX_CHARS + 1) });
  assert.equal(big.too_large, true);
  assert.equal(big.limit, spawn.HTML_MAX_CHARS);
  assert.equal(spawn.spawnPane(state, bus, { parent: 'root', html: 'x'.repeat(spawn.HTML_MAX_CHARS) }).ok, true);
  const bigParams = spawn.spawnPane(state, bus, { parent: 'root', html: 'x', params: { blob: 'y'.repeat(spawn.PARAMS_MAX_CHARS) } });
  assert.equal(bigParams.too_large, true);
  assert.equal(spawn.spawnPane(state, bus, { parent: 'root', html: 'x', params: [1] }).invalid, true);
  assert.equal(spawn.spawnPane(state, bus, { parent: 'root', html: 'x', id: 42 }).invalid, true);
  assert.equal(state.mounts.size, 2, 'only the one in-cap spawn landed');
});

test('signals: a spawned pane cannot declare wake signals', () => {
  const { state, bus } = fixture();
  const r = spawn.spawnPane(state, bus, {
    parent: 'root', id: 'c', html: 'x',
    params: { title: 'T', signals: [{ key: 'go', wake: 'immediate' }] },
  });
  assert.equal(r.ok, true);
  assert.match(r.warning, /signals ignored/);
  assert.deepEqual(state.mounts.get('c').params, { title: 'T' });
  assert.deepEqual(derive(state), {}, 'nothing reached the signal registry');
  // A spawn without signals carries no warning.
  assert.equal(spawn.spawnPane(state, bus, { parent: 'root', id: 'c2', html: 'x', params: { title: 'T' } }).warning, undefined);
});

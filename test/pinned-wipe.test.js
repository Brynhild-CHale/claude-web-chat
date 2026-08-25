// A pin is load-bearing, not cosmetic.
//
// `pane_state.pinned` already blocked drag-reorder in the browser; it now also
// survives a page wipe (POST /api/graph/wipe) and the agent's clear-all
// (POST /api/clear with no id) unless force:true. A wipe still bookmarks the
// next node either way — including when survivors mean the page isn't empty
// afterwards. The wipe also takes an optional `name` for that bookmark.

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');

// pane_state is only settable over the WS (the browser owns pane chrome), so
// pin through a socket and wait for the server to have applied it.
async function pin(ctx, id) {
  const sock = ctx.ws();
  await new Promise((resolve, reject) => {
    sock.on('open', resolve);
    sock.on('error', reject);
  });
  sock.send(JSON.stringify({ type: 'pane:state', id, pane_state: { pinned: true } }));
  for (let i = 0; i < 100; i++) {
    const m = (await ctx.api.get('/api/mounts')).json.mounts.find((x) => x.id === id);
    if (m && m.pane_state && m.pane_state.pinned) { sock.close(); return; }
    await new Promise((r) => setTimeout(r, 10));
  }
  sock.close();
  throw new Error(`pane ${id} never became pinned`);
}

async function mountIds(api) {
  return (await api.get('/api/mounts')).json.mounts.map((m) => m.id).sort();
}

// ── Wipe ───────────────────────────────────────────────────────────────────

test('wipe preserves pinned panes and clears the rest', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await api.post('/api/render', { id: 'go', html: '<p>go</p>' });
  await pin(ctx, 'keep');

  const w = await api.post('/api/graph/wipe', {});
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.kept, ['keep']);
  assert.deepEqual(await mountIds(api), ['keep'], 'the pinned pane survived the wipe');
});

test('wipe with nothing pinned still clears everything (unchanged behaviour)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>a</p>' });
  await api.post('/api/render', { id: 'b', html: '<p>b</p>' });
  const w = await api.post('/api/graph/wipe', {});
  assert.deepEqual(w.json.kept, []);
  assert.deepEqual(await mountIds(api), []);
});

test('a wipe with surviving pinned panes STILL bookmarks the next node', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await api.post('/api/render', { id: 'go', html: '<p>go</p>' });
  await pin(ctx, 'keep');
  await api.post('/api/commit', { message: 'seed' });

  const w = await api.post('/api/graph/wipe', { name: 'act two' });
  assert.deepEqual(w.json.kept, ['keep'], 'a pane survived — the page is not empty');

  const g0 = (await api.get('/api/graph')).json;
  assert.deepEqual(g0.pending_bookmark, { name: 'act two' }, 'the gesture bookmarked anyway');

  await api.post('/api/turn-begin', { message: 'next' });
  await api.post('/api/render', { id: 'fresh', html: '<p>fresh</p>' });
  const end = await api.post('/api/turn-end', { author: 'claude' });

  const g = (await api.get('/api/graph')).json;
  const n = g.nodes.find((x) => x.id === end.json.node_id);
  assert.equal(n.bookmarked, true);
  assert.equal(n.name, 'act two');
});

test('wipe takes an optional label for the bookmark; absent still bookmarks unlabelled', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>a</p>' });
  const named = await api.post('/api/graph/wipe', { name: '  release prep  ' });
  assert.equal(named.json.name, 'release prep', 'trimmed');
  assert.deepEqual((await api.get('/api/graph')).json.pending_bookmark, { name: 'release prep' });

  await api.post('/api/render', { id: 'b', html: '<p>b</p>' });
  const bare = await api.post('/api/graph/wipe', {});
  assert.equal(bare.json.name, '');
  assert.deepEqual((await api.get('/api/graph')).json.pending_bookmark, { name: '' },
    'an absent name still bookmarks — it just has no label');
});

test('a wipe QUEUED during a turn carries its label through to the applied wipe', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>a</p>' });
  await api.post('/api/commit', { message: 'seed' });

  await api.post('/api/turn-begin', { message: 'busy' });
  const q = await api.post('/api/graph/wipe', { name: 'queued label' });
  assert.equal(q.json.pending, true);
  assert.equal(q.json.name, 'queued label');

  await api.post('/api/render', { id: 'b', html: '<p>b</p>' });
  const end = await api.post('/api/turn-end', { author: 'claude' });
  assert.deepEqual(end.json.reaim, { op: 'wipe', ok: true });
  assert.deepEqual((await api.get('/api/graph')).json.pending_bookmark, { name: 'queued label' },
    'the label survived the queue, not just the wipe');
});

test('the reset frame after a wipe carries the surviving pinned panes', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await api.post('/api/render', { id: 'go', html: '<p>go</p>' });
  await pin(ctx, 'keep');

  // A bystander socket: it must be TOLD what survived, never have to work it out.
  const sock = ctx.ws();
  const reset = new Promise((resolve, reject) => {
    sock.on('message', (d) => {
      let m = null;
      try { m = JSON.parse(d.toString()); } catch {}
      if (m && m.type === 'reset') resolve(m);
    });
    sock.on('error', reject);
  });
  await new Promise((r) => sock.on('open', r));

  await api.post('/api/graph/wipe', {});
  const frame = await reset;
  sock.close();
  assert.deepEqual(frame.mounts.map((m) => m.id), ['keep']);
});

test('new graph still clears pinned panes — it detaches active entirely', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await pin(ctx, 'keep');
  await api.post('/api/graph/new', { name: 'Other' });
  assert.deepEqual(await mountIds(api), [], 'a new tree starts genuinely blank');
});

// ── clear-all ──────────────────────────────────────────────────────────────

test('clear-all preserves pinned panes; force:true takes them too', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await api.post('/api/render', { id: 'go', html: '<p>go</p>' });
  await pin(ctx, 'keep');

  const c = await api.post('/api/clear', {});
  assert.equal(c.status, 200);
  assert.deepEqual(c.json.kept, ['keep']);
  assert.deepEqual(await mountIds(api), ['keep']);

  const forced = await api.post('/api/clear', { force: true });
  assert.equal(forced.json.kept, undefined);
  assert.deepEqual(await mountIds(api), []);
});

test('clearing a pinned pane BY ID still works — naming it is deliberate', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await pin(ctx, 'keep');
  const c = await api.post('/api/clear', { id: 'keep' });
  assert.equal(c.status, 200);
  assert.deepEqual(await mountIds(api), []);
});

test('a target clear also spares pins, and leaves other targets alone', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>k</p>', target: 'side' });
  await api.post('/api/render', { id: 'go', html: '<p>g</p>', target: 'side' });
  await api.post('/api/render', { id: 'other', html: '<p>o</p>', target: 'main' });
  await pin(ctx, 'keep');

  const c = await api.post('/api/clear', { target: 'side' });
  assert.deepEqual(c.json.kept, ['keep']);
  assert.deepEqual(await mountIds(api), ['keep', 'other']);
});

test('clear-all with nothing pinned emits the unchanged bulk frame', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'a', html: '<p>a</p>' });
  await api.post('/api/render', { id: 'b', html: '<p>b</p>' });

  const sock = ctx.ws();
  const frames = [];
  sock.on('message', (d) => {
    let m = null;
    try { m = JSON.parse(d.toString()); } catch {}
    if (m && m.type === 'clear') frames.push(m);
  });
  await new Promise((r) => sock.on('open', r));

  const c = await api.post('/api/clear', {});
  assert.deepEqual(c.json, { ok: true });
  await new Promise((r) => setTimeout(r, 60));
  sock.close();
  assert.deepEqual(frames, [{ type: 'clear' }], 'one bulk frame, exactly as before');
});

test('when pins survive, clients are told exactly which panes went (never a bulk drop)', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await api.post('/api/render', { id: 'go1', html: '<p>1</p>' });
  await api.post('/api/render', { id: 'go2', html: '<p>2</p>' });
  await pin(ctx, 'keep');

  const sock = ctx.ws();
  const frames = [];
  sock.on('message', (d) => {
    let m = null;
    try { m = JSON.parse(d.toString()); } catch {}
    if (m && m.type === 'clear') frames.push(m);
  });
  await new Promise((r) => sock.on('open', r));

  await api.post('/api/clear', {});
  await new Promise((r) => setTimeout(r, 60));
  sock.close();

  assert.deepEqual(frames, [{ type: 'clear', id: 'go1' }, { type: 'clear', id: 'go2' }]);
  assert.ok(!frames.some((f) => f.id === undefined),
    'a bulk frame would have told the client to drop the pinned pane too');

  const ev = (await api.get('/api/events')).json.events.filter((e) => e.kind === 'clear');
  assert.equal(ev.length, 1, 'one ring entry for the one clear call');
  assert.equal(ev[0].kept, 1);
});

test('the ownership guard still wins: a foreign pane rejects the clear before pins matter', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'svc', html: '<p>s</p>', owner: 'service:git' });
  await api.post('/api/render', { id: 'keep', html: '<p>k</p>' });
  await pin(ctx, 'keep');

  const c = await api.post('/api/clear', {});
  assert.equal(c.json.ok, false);
  assert.equal(c.json.owned, true);
  assert.deepEqual(await mountIds(api), ['keep', 'svc'], 'rejected whole — nothing removed');
});

// ── Restart ────────────────────────────────────────────────────────────────

test('a pinned survivor of a wipe rides the draft across a restart', async (t) => {
  const ctx = await withServer(t);
  const { api, root } = ctx;
  await api.post('/api/render', { id: 'keep', html: '<p>keep</p>' });
  await api.post('/api/render', { id: 'go', html: '<p>go</p>' });
  await pin(ctx, 'keep');
  await api.post('/api/commit', { message: 'seed' });
  await api.post('/api/graph/wipe', {});
  assert.deepEqual(await mountIds(api), ['keep']);

  await ctx.graceful();
  const { api: api2 } = await withServer(t, { root });
  assert.deepEqual(await mountIds(api2), ['keep'],
    'the wipe survivor, not the wiped node, is what comes back');
});

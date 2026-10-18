// X-5 (PLAN.md 1B.5, DECISIONS A1): a renderer's write never queues an item
// with a dangling origin mount. A browser `store:set` names its writing pane
// (`mount`) and a gesture — both the client's claim. ws.js keeps them only for
// a live pane; queue.enqueue normalises every item's origin_mount to something
// live on the page (a pane, or a markdown item) or null; coalesce matches on
// that normalised value. policy.activityItem reserves `origin_element`, present
// only when an event carries one (tranche 2's element renderers fill it).

const test = require('node:test');
const assert = require('node:assert');
const { withServer, waitUntil } = require('../test-support/helpers');
const { activityItem } = require('../lib/channel/policy');
const queue = require('../lib/server/domain/queue');

// One socket per test, open once its hello arrives.
async function openSocket(ctx, t) {
  const sock = ctx.ws();
  t.after(() => { try { sock.close(); } catch {} });
  await new Promise((resolve, reject) => {
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') resolve();
    });
    sock.on('error', reject);
  });
  return sock;
}

// Send one store:set and wait until its store event is on the ring — the wake
// policy runs as a bus subscriber of that same emit, so the queue has settled.
async function storeSet(ctx, sock, frame) {
  const marker = Object.keys(frame.patch)[0];
  const value = frame.patch[marker];
  sock.send(JSON.stringify({ type: 'store:set', ...frame }));
  return waitUntil(async () => {
    const ev = await ctx.api.get('/api/events');
    const hits = (ev.json.events || []).filter((e) => e.kind === 'store' && e.source === 'browser'
      && Object.hasOwn(e.patch || {}, marker) && JSON.stringify(e.patch[marker]) === JSON.stringify(value));
    return hits.length ? hits[hits.length - 1] : null;
  }, { what: `the store event for ${marker}` });
}

const items = async (ctx) => (await ctx.api.get('/api/queue')).json.items;

// ── the X-5 policy case: a write that claims a pane that is not there ──────

test('X-5: a gesture store:set naming no pane queues nothing and its event names no mount', async (t) => {
  const ctx = await withServer(t);
  const sock = await openSocket(ctx, t);
  const ev = await storeSet(ctx, sock, { patch: { x: 1 }, mount: 'el-x', gesture: true });
  assert.equal(Object.hasOwn(ev, 'mount'), false, 'the ring\'s store event carries no mount');
  assert.equal(Object.hasOwn(ev, 'gesture'), false, 'nor a gesture');
  const q = await items(ctx);
  assert.equal(q.filter((it) => it.origin_mount === 'el-x').length, 0, 'items_with_dangling_origin_mount is 0');
  assert.equal(q.filter((it) => it.kind === 'activity').length, 0, 'an unattributed, gesture-less write is not activity');
  assert.equal(q.length, 0);
});

test('X-5: a gesture write that names no pane at all is unchanged: unattributed activity', async (t) => {
  const ctx = await withServer(t);
  const sock = await openSocket(ctx, t);
  const ev = await storeSet(ctx, sock, { patch: { y: 1 }, gesture: true });
  assert.equal(ev.gesture, true, 'no claim, nothing to strip');
  const q = await items(ctx);
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'activity');
  assert.equal(q[0].origin_mount, null);
});

test('X-5: a live pane\'s gesture write still coalesces with origin_mount and origin_gen', async (t) => {
  const ctx = await withServer(t);
  await ctx.api.post('/api/render', { id: 'p1', html: '<div>p1</div>' });
  const gen = ctx.srv.state.mounts.get('p1').gen;
  const sock = await openSocket(ctx, t);
  const ev = await storeSet(ctx, sock, { patch: { x: 1 }, mount: 'p1', gesture: true });
  assert.equal(ev.mount, 'p1');
  assert.equal(ev.gesture, true);
  let q = await items(ctx);
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'activity');
  assert.equal(q[0].origin_mount, 'p1');
  assert.equal(q[0].origin_gen, gen);
  assert.equal(Object.hasOwn(q[0], 'origin_element'), false, 'no element, no origin_element key');
  await storeSet(ctx, sock, { patch: { x: 2 }, mount: 'p1', gesture: true });
  q = await items(ctx);
  assert.equal(q.length, 1, 'the second write coalesces into the same item');
  assert.equal(q[0].counts.store, 2);
});

test('X-5: params.routing \'none\' still opts a live pane out', async (t) => {
  const ctx = await withServer(t);
  await ctx.api.post('/api/render', { id: 'p1', html: '<div>p1</div>', params: { routing: 'none' } });
  const sock = await openSocket(ctx, t);
  await storeSet(ctx, sock, { patch: { x: 1 }, mount: 'p1', gesture: true });
  assert.equal((await items(ctx)).length, 0);
});

test('X-5: a declared queue signal still enqueues — a dangling writer falls back to its declarer', async (t) => {
  const ctx = await withServer(t);
  await ctx.api.post('/api/render', { id: 'sig', html: '<div>s</div>', params: { signals: [{ key: 'form_submit', wake: 'queue' }] } });
  await ctx.api.post('/api/render', { id: 'p1', html: '<div>p1</div>' });
  const sock = await openSocket(ctx, t);

  const ev = await storeSet(ctx, sock, { patch: { form_submit: { seq: 1 } }, mount: 'el-x', gesture: true });
  assert.equal(Object.hasOwn(ev, 'mount'), false);
  let q = await items(ctx);
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'signal');
  assert.notEqual(q[0].origin_mount, 'el-x', 'never the dangling claim');
  assert.equal(q[0].origin_mount, 'sig', 'an unattributed write is the declarer\'s (signalItem, unchanged)');

  await storeSet(ctx, sock, { patch: { form_submit: { seq: 2 } }, mount: 'p1', gesture: true });
  q = await items(ctx);
  assert.equal(q.length, 2);
  assert.equal(q[1].kind, 'signal');
  assert.equal(q[1].origin_mount, 'p1', 'a live writer is still the origin');
});

test('X-5: a delegated dom event naming no pane coalesces unattributed', async (t) => {
  const ctx = await withServer(t);
  const sock = await openSocket(ctx, t);
  sock.send(JSON.stringify({ type: 'event', payload: { type: 'change', mountId: 'el-x', tag: 'INPUT' } }));
  const q = await waitUntil(async () => { const l = await items(ctx); return l.length ? l : null; }, { what: 'the activity item' });
  assert.equal(q.length, 1);
  assert.equal(q[0].origin_mount, null);
});

// ── enqueue: a comment item's origin ───────────────────────────────────────

test('enqueue: a comment pinned on a cleared pane has no origin; one on a live markdown item keeps it', async (t) => {
  const ctx = await withServer(t);
  await ctx.api.post('/api/render', { id: 'gone', html: '<div>g</div>' });
  await ctx.api.post('/api/clear', { id: 'gone' });
  assert.equal(ctx.srv.state.mounts.has('gone'), false);
  await ctx.api.post('/api/markdown', { id: 'md-a', text: '## Notes' });

  const a = await ctx.api.post('/api/comments', { text: 'on a cleared pane', shared: true, anchor: { mount: 'gone' } });
  const b = await ctx.api.post('/api/comments', { text: 'on prose', shared: true, anchor: { mount: 'md-a' } });
  const q = await items(ctx);
  const qa = q.find((it) => it.comment_id === a.json.pin.id);
  const qb = q.find((it) => it.comment_id === b.json.pin.id);
  assert.ok(qa && qb, 'both shared pins queued');
  assert.equal(qa.origin_mount, null);
  assert.equal(qb.origin_mount, 'md-a');
  assert.equal(Object.hasOwn(qb, 'origin_gen'), false, 'gen is stamped only from a live pane');
});

test('enqueue/coalesce (unit): origins normalise against the live page', () => {
  const emitted = [];
  const bus = { emit: (x) => emitted.push(x) };
  const state = {
    mounts: new Map([['p1', { gen: 3 }]]),
    markdown: new Map([['md-1', { text: '# T' }]]),
    queue: [],
    queueSeq: 0,
  };
  const dangling = queue.enqueue(state, bus, { kind: 'capture', origin_mount: 'nope', summary: 's' });
  assert.equal(dangling.origin_mount, null);
  const pane = queue.enqueue(state, bus, { kind: 'comment', origin_mount: 'p1', summary: 's' });
  assert.equal(pane.origin_mount, 'p1');
  assert.equal(pane.origin_gen, 3);
  const md = queue.enqueue(state, bus, { kind: 'comment', origin_mount: 'md-1', summary: 's' });
  assert.equal(md.origin_mount, 'md-1');
  const none = queue.enqueue(state, bus, { kind: 'capture', summary: 's' });
  assert.equal(Object.hasOwn(none, 'origin_mount'), false, 'an item with no origin field gets none');

  // Two dangling ids fold into ONE unattributed activity item.
  const a1 = queue.coalesce(state, bus, activityItem({ kind: 'dom', type: 'click', mountId: 'ghost-1', tag: 'BUTTON' }));
  const a2 = queue.coalesce(state, bus, activityItem({ kind: 'dom', type: 'click', mountId: 'ghost-2', tag: 'BUTTON' }));
  assert.equal(a1, a2);
  assert.equal(a1.origin_mount, null);
  assert.equal(a1.counts.click, 2);
  assert.equal(state.queue.filter((it) => it.kind === 'activity').length, 1);
  for (const e of emitted) {
    const it = e.event.item;
    assert.ok(!it || it.origin_mount == null || state.mounts.has(it.origin_mount) || state.markdown.has(it.origin_mount));
  }
});

// ── activityItem: the reserved origin_element slot ─────────────────────────

test('activityItem: origin_element only when the event carries an element', () => {
  const ev = { kind: 'store', patch: { x: 1 }, source: 'browser', mount: 'p1', seq: 7 };
  assert.deepStrictEqual(activityItem(ev), {
    kind: 'activity',
    source: 'browser',
    origin_mount: 'p1',
    why_wake: 'pane activity',
    counts: { click: 0, change: 0, submit: 0, store: 1 },
    keys: ['x'],
    summary: 'p1 · 1 store write · keys: x',
    seq: 7,
  }, 'without an element the shape is today\'s, key for key');
  const withEl = activityItem({ ...ev, element: 'c7' });
  assert.equal(withEl.origin_element, 'c7');
  const dom = activityItem({ kind: 'dom', type: 'click', mountId: 'p1', tag: 'BUTTON', element: 'c9' });
  assert.equal(dom.origin_element, 'c9');
  assert.equal(Object.hasOwn(activityItem({ kind: 'dom', type: 'click', mountId: 'p1', tag: 'BUTTON' }), 'origin_element'), false);
});

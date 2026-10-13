// Bounded live state (U102, tranche 5): a cap on live captures, and what a wipe
// and a new graph clear.
//
// Rulings (2026-10-13): A4 (c) — the live surface keeps the newest 50 captures;
// older ones stay in the nodes that hold them and their raw sidecars stay on
// disk. A3 (b) — a wipe also deletes the pins on the panes it removed and the
// live captures; a new graph deletes every pin and every live capture; captures
// already copied into committed nodes stay there. A-defaults (a) — the store is
// never pruned in 0.8.5, so a wipe keeps it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const { CAPTURES_LIVE_MAX, retain, clearLive } = require('../lib/server/domain/captures');

const PAGE = (n) => `<html><head><title>Page ${n}</title></head><body><p>page ${n} body</p></body></html>`;

// Post one page capture through the real route. render:false keeps the test off
// the capture panes: the records and the sidecars are what is under test.
async function capture(api, n) {
  const r = await api.post('/api/capture', { url: `https://example.test/p${n}`, title: `Page ${n}`, html: PAGE(n), render: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.capture_id;
}

async function turn(api) {
  await api.post('/api/turn-begin', {});
  return api.post('/api/turn-end', { author: 'claude', summary: 't' });
}

// pane_state is only settable over the WS (the browser owns pane chrome).
async function pinPane(ctx, id) {
  const sock = ctx.ws();
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  sock.send(JSON.stringify({ type: 'pane:state', id, pane_state: { pinned: true } }));
  try {
    await waitUntil(async () => {
      const m = (await ctx.api.get('/api/mounts')).json.mounts.find((x) => x.id === id);
      return !!(m && m.pane_state && m.pane_state.pinned);
    }, { timeout: 5000, what: `pane ${id} pinned` });
  } finally { sock.close(); }
}

async function addPin(api, mount, text = 'look') {
  const r = await api.post('/api/comments', {
    text, shared: true, anchor: { mount, selector: 'div', text: mount, ordinal: 0 },
  });
  assert.equal(r.json.ok, true);
  return r.json.pin;
}

// A socket that records every frame, opened before the gesture under test.
async function frameLog(ctx) {
  const sock = ctx.ws();
  const frames = [];
  sock.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.on('open', resolve); sock.on('error', reject); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { timeout: 5000, what: 'hello' });
  return { frames, close: () => sock.close() };
}

const liveCaptures = async (api) => (await api.get('/api/captures')).json.captures;
const comments = async (api) => (await api.get('/api/comments')).json.comments;
const events = async (api) => (await api.get('/api/events')).json.events;

// ── the domain module ─────────────────────────────────────────────────────

test('retain keeps the newest by seq, in order, and reports what it dropped; clearLive keeps the counter', () => {
  assert.equal(CAPTURES_LIVE_MAX, 50, 'ruled A4 (c): the newest 50');
  const state = { captures: [3, 1, 4, 2, 5].map((seq) => ({ id: `cap${seq}`, seq })), captureSeq: 5 };
  assert.deepEqual(retain(state, 3).sort(), ['cap1', 'cap2']);
  assert.deepEqual(state.captures.map((c) => c.id), ['cap3', 'cap4', 'cap5'], 'the survivors keep their order');
  assert.deepEqual(retain(state, 3), [], 'at the cap nothing goes');
  assert.equal(clearLive(state), 3);
  assert.deepEqual(state.captures, []);
  assert.equal(state.captureSeq, 5, 'the counter is never reset');
});

// ── the cap ───────────────────────────────────────────────────────────────

test('60 captures leave the newest 50 live; every sidecar stays; a node committed before the trim keeps its records', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;

  for (let n = 1; n <= 10; n++) await capture(api, n);
  const committed = await turn(api);
  const nodeId = committed.json.node_id;
  assert.ok(nodeId, `a node was committed: ${JSON.stringify(committed.json)}`);

  for (let n = 11; n <= 60; n++) {
    await capture(api, n);
    // "Never exceed": checked after every push past the cap, not only at the end.
    if (n >= 50) assert.equal((await liveCaptures(api)).length, Math.min(n, CAPTURES_LIVE_MAX), `after capture ${n}`);
  }
  const live = await liveCaptures(api);
  assert.equal(live.length, CAPTURES_LIVE_MAX, 'live captures never exceed the cap');
  assert.deepEqual(live.map((c) => c.id), Array.from({ length: 50 }, (_, i) => `cap${i + 11}`), 'the newest, in order');

  for (let n = 1; n <= 60; n++) {
    assert.ok(fs.existsSync(path.join(ctx.webChatDir, 'captures', `cap${n}.html`)), `cap${n}'s raw sidecar is on disk`);
  }

  const held = (await api.get(`/api/captures?node=${encodeURIComponent(nodeId)}`)).json;
  assert.deepEqual(held.captures.map((c) => c.id), Array.from({ length: 10 }, (_, i) => `cap${i + 1}`),
    'the node committed before the trim still holds its records');
  const raw = await api.get('/api/captures/cap3/raw');
  assert.equal(raw.status, 200, JSON.stringify(raw.json));
  assert.equal(raw.json.id, 'cap3');
  assert.match(raw.json.raw, /page 3 body/, 'inspect_capture still reads a trimmed record through its node');
});

// ── a wipe ────────────────────────────────────────────────────────────────

test('a wipe drops the pins on the panes it removed and the live captures; the pinned pane keeps its pin; the store is kept', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'gone', html: '<div>gone</div>' });
  await api.post('/api/render', { id: 'keep', html: '<div>keep</div>' });
  await pinPane(ctx, 'keep');
  const onGone = await addPin(api, 'gone');
  const onKeep = await addPin(api, 'keep');
  await capture(api, 1);
  await capture(api, 2);
  await api.post('/api/store', { patch: { left: 'alone' } });
  const storeBefore = (await api.get('/api/store')).json;

  const queued = (await api.get('/api/queue')).json.items;
  assert.ok(queued.some((it) => it.comment_id === onGone.id), 'the shared pin on the doomed pane is queued');

  const log = await frameLog(ctx);
  t.after(() => log.close());
  const before = (await events(api)).length;
  const w = await api.post('/api/graph/wipe', {});
  assert.equal(w.json.ok, true);
  assert.deepEqual(w.json.kept, ['keep']);
  await waitUntil(() => log.frames.some((f) => f.type === 'reset'), { timeout: 5000, what: 'reset frame' });

  assert.deepEqual((await comments(api)).map((c) => c.id), [onKeep.id], 'only the pin on the pinned pane stays');
  const commentFrames = log.frames.filter((f) => f.type === 'comments');
  assert.equal(commentFrames.length, 1, 'one comments frame');
  assert.deepEqual(commentFrames[0].comments.map((c) => c.id), [onKeep.id]);
  const deletes = (await events(api)).slice(before).filter((e) => e.kind === 'comment' && e.op === 'delete');
  assert.deepEqual(deletes.map((e) => e.id), [onGone.id], 'one comment delete event, for the removed pane\'s pin');

  assert.deepEqual(await liveCaptures(api), [], 'no live captures after a wipe');
  assert.deepEqual((await api.get('/api/store')).json, storeBefore, 'the store is unchanged');

  const after = (await api.get('/api/queue')).json.items;
  assert.equal(after.some((it) => it.comment_id === onGone.id), false, 'the queued pin was dequeued by the wipe');
  assert.ok(after.some((it) => it.comment_id === onKeep.id), 'the surviving pin stays queued');
});

test('a wipe keeps a pin with no pane anchor', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'gone', html: '<div>gone</div>' });
  const loose = (await api.post('/api/comments', { text: 'page note', shared: false })).json.pin;
  await addPin(api, 'gone');
  await api.post('/api/graph/wipe', {});
  assert.deepEqual((await comments(api)).map((c) => c.id), [loose.id]);
});

// ── a new graph ───────────────────────────────────────────────────────────

test('a new graph drops every pin and every live capture; the seq counters keep counting', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'a', html: '<div>a</div>' });
  await api.post('/api/render', { id: 'b', html: '<div>b</div>' });
  await pinPane(ctx, 'b');
  const p1 = await addPin(api, 'a');
  const p2 = await addPin(api, 'b');
  // A pin with no pane anchor: a wipe keeps one, a new graph does not.
  const loose = (await api.post('/api/comments', { text: 'page note', shared: true })).json.pin;
  await capture(api, 1);
  const c2 = await capture(api, 2);

  const before = (await events(api)).length;
  const r = await api.post('/api/graph/new', { name: 'fresh' });
  assert.equal(r.json.ok, true);
  assert.deepEqual(await comments(api), [], 'every pin is gone');
  assert.deepEqual(await liveCaptures(api), [], 'every live capture is gone');
  const deletes = (await events(api)).slice(before).filter((e) => e.kind === 'comment' && e.op === 'delete');
  assert.deepEqual(deletes.map((e) => e.id).sort(), [p1.id, p2.id, loose.id].sort());
  assert.equal((await api.get('/api/queue')).json.items.some((it) => it.comment_id), false, 'no pin is left queued');

  const nextCap = await capture(api, 3);
  assert.equal(nextCap, `cap${Number(c2.slice(3)) + 1}`, 'the capture counter was not reset');
  const nextPin = await addPin(api, 'x');
  assert.equal(nextPin.seq, loose.seq + 1, 'the comment counter was not reset');
  assert.notEqual(nextPin.id, p1.id);
});

// ── a wipe queued behind a locked turn ────────────────────────────────────

test('a wipe queued during a locked turn applies the same rules when it runs', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/render', { id: 'gone', html: '<div>gone</div>' });
  await api.post('/api/render', { id: 'keep', html: '<div>keep</div>' });
  await pinPane(ctx, 'keep');
  const onGone = await addPin(api, 'gone');
  const onKeep = await addPin(api, 'keep');
  await api.post('/api/store', { patch: { k: 1 } });

  await api.post('/api/turn-begin', {});
  await capture(api, 1);
  const q = await api.post('/api/graph/wipe', {});
  assert.equal(q.json.pending, true, `the wipe queued behind the lock: ${JSON.stringify(q.json)}`);
  assert.equal((await comments(api)).length, 2, 'nothing is cleared until the turn ends');
  assert.equal((await liveCaptures(api)).length, 1);

  const end = await api.post('/api/turn-end', { author: 'claude', summary: 't' });
  const nodeId = end.json.node_id;
  assert.ok(nodeId, 'the turn committed before the queued wipe ran');

  assert.deepEqual((await comments(api)).map((c) => c.id), [onKeep.id]);
  assert.deepEqual(await liveCaptures(api), []);
  assert.equal((await api.get('/api/store')).json.k, 1, 'the store is kept');
  assert.equal((await api.get('/api/queue')).json.items.some((it) => it.comment_id === onGone.id), false);

  const node = (await api.get(`/api/graph/node/${encodeURIComponent(nodeId)}`)).json;
  assert.deepEqual(node.captures.map((c) => c.id), ['cap1'], 'the committed node keeps the capture the wipe cleared');
  assert.deepEqual(node.comments.map((c) => c.id).sort(), [onGone.id, onKeep.id].sort(), 'and the pins');
});

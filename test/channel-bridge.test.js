// Commit 3 — the channel bridge. Two halves:
//   * the §5 "fake transport" integration: a REAL in-process daemon emits a
//     `wake`; the bridge (real SSE, fake notify sink) produces EXACTLY ONE
//     notifications/claude/channel with the sanitized envelope; non-`wake` kinds
//     produce none.
//   * fake-client unit tests for the reconnect/cursor discipline (deterministic,
//     no timing/SSE).

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { subscribeSSE } = require('../lib/client');
const { startChannelBridge } = require('../lib/channel/bridge');

const HTML = '<html><head><title>Doc</title></head><body><p>hi</p></body></html>';
const BACKOFF_TICK = 1000; // > BACKOFF_MIN_MS (500), so the first reconnect fires
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return; await settle(20); }
  throw new Error('waitFor timed out');
}

// Wrap the real client so the test can await the SSE subscription being live
// before it emits a wake (the first connect is live-only — no replay — so the
// bridge must be subscribed before the wake, or it's genuinely missed).
function readyClient() {
  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  const client = {
    subscribeSSE(opts) {
      return subscribeSSE({ ...opts, onOpen: () => { if (opts.onOpen) opts.onOpen(); markReady(); } });
    },
  };
  return { client, ready };
}

test('bridge: a real wake becomes exactly one notification with the sanitized envelope', async (t) => {
  const { api, root } = await withServer(t, { writePortfile: true });
  const { client, ready } = readyClient();
  const notified = [];
  const bridge = startChannelBridge({ notify: (method, params) => notified.push({ method, params }), client, root });
  t.after(() => bridge.stop());
  await ready;

  await api.post('/api/capture', { url: 'https://example.com/page', title: 'Ex', html: HTML });
  await api.post('/api/queue/push', {});

  await waitFor(() => notified.length >= 1);
  await settle(60); // give any (erroneous) extra notification a chance to arrive

  assert.equal(notified.length, 1, 'exactly one notification per wake');
  assert.equal(notified[0].method, 'notifications/claude/channel');
  const { content, meta } = notified[0].params;
  assert.match(content, /captured example\.com/);
  assert.equal(meta.kind, 'capture');
  assert.equal(meta.captures, 'cap1');
  // envelope discipline: no raw body / angle brackets in content
  assert.doesNotMatch(content, /[<>]/);
});

test('policy: channel_connected reflects only explicit wake subscribers (not all-kinds)', async (t) => {
  const { api, port } = await withServer(t);
  const openSSE = (kinds) => new Promise((resolve) => { const h = subscribeSSE({ port, kinds, onOpen: () => resolve(h) }); });

  assert.equal((await api.get('/api/queue/policy')).json.channel_connected, false, 'baseline: no channel');

  const all = await openSSE(undefined); // an all-kinds driver stream
  await settle(40);
  assert.equal((await api.get('/api/queue/policy')).json.channel_connected, false, 'an all-kinds SSE is not a channel');
  all.close();

  const wake = await openSSE(['wake']); // the bridge
  await settle(40);
  assert.equal((await api.get('/api/queue/policy')).json.channel_connected, true, 'a wake-filtered SSE is the channel');
  wake.close();
});

test('bridge: non-wake events produce no notification', async (t) => {
  const { api, root } = await withServer(t, { writePortfile: true });
  const { client, ready } = readyClient();
  const notified = [];
  const bridge = startChannelBridge({ notify: (m, p) => notified.push({ m, p }), client, root });
  t.after(() => bridge.stop());
  await ready;

  await api.post('/api/render', { id: 'r1', html: '<b>x</b>' });
  await api.post('/api/store', { patch: { k: 1 } });
  await api.post('/api/capture', { url: 'https://a.com/1', title: 'A', html: HTML }); // enqueues, no wake
  await settle(150);

  assert.equal(notified.length, 0, 'store/render/capture(enqueue) must not notify — only a wake does');
});

// The bridge's connect-time cursor choice reads the daemon's boot token off
// /api/health; pin that the field is exposed.
test('health exposes the daemon boot token (bridge restart detection)', async (t) => {
  const { api } = await withServer(t);
  const { json: body } = await api.get('/api/health');
  assert.equal(typeof body.boot, 'string', '/api/health carries the per-boot token');
  assert.ok(body.boot.includes(':'), 'boot token is pid:boot-time');
});

// ── fake-client unit: cursor + reconnect discipline ──────────────────────────
//
// connect() now fetches the daemon's boot token (client.get('/api/health')) BEFORE
// it subscribes, so the fake client carries a `get` and the tests
// let that async step settle. `microflush` drains the fetchBoot microtasks; it
// rides setImmediate (never mock-timed here) so it works with or without mock
// setTimeout.
const microflush = () => new Promise((r) => setImmediate(r));

test('bridge: cursor dedupes replays, delivers newer seqs', async () => {
  const connects = [];
  const client = { subscribeSSE(opts) { connects.push(opts); return { close() {} }; }, get: async () => ({}) };
  const notified = [];
  const bridge = startChannelBridge({ notify: (m, p) => notified.push(p), client, root: 'x' });
  await microflush();

  assert.equal(connects.length, 1);
  const c = connects[0];
  c.onEvent({ kind: 'wake', seq: 5, batch: [{ id: 'q1', kind: 'signal', summary: 's' }] });
  assert.equal(notified.length, 1);
  c.onEvent({ kind: 'wake', seq: 5, batch: [{ id: 'q1', kind: 'signal', summary: 's' }] }); // replay
  assert.equal(notified.length, 1, 'replayed seq is deduped');
  c.onEvent({ kind: 'wake', seq: 6, batch: [{ id: 'q2', kind: 'signal', summary: 't' }] }); // newer
  assert.equal(notified.length, 2);
  // a non-wake kind slipping through is ignored defensively
  c.onEvent({ kind: 'store', seq: 7 });
  assert.equal(notified.length, 2);
  bridge.stop();
});

test('bridge: a daemon restart (new boot token, reset seq) still delivers', async () => {
  const connects = [];
  const client = { subscribeSSE(opts) { connects.push(opts); return { close() {} }; }, get: async () => ({}) };
  const notified = [];
  const bridge = startChannelBridge({ notify: (m, p) => notified.push(p), client, root: 'x' });
  await microflush();
  const c = connects[0];

  // First daemon: cursor climbs to 35 (mirrors this session's chan_test wakes).
  c.onEvent({ kind: 'wake', seq: 35, boot: 'pidA:100', batch: [{ id: 'q1', kind: 'signal', summary: 's' }] });
  assert.equal(notified.length, 1);

  // Daemon restarts → seq resets to a LOWER number under a NEW boot token. Without
  // boot detection this would be dropped as `12 <= 35`; with it, it delivers.
  c.onEvent({ kind: 'wake', seq: 12, boot: 'pidB:200', batch: [], note: 'just a comment' });
  assert.equal(notified.length, 2, 'the post-restart wake is not swallowed as a replay');

  // And the cursor now dedupes within the NEW boot normally.
  c.onEvent({ kind: 'wake', seq: 12, boot: 'pidB:200', batch: [] }); // replay
  assert.equal(notified.length, 2, 'same-boot replay is still deduped');
  bridge.stop();
});

test('bridge: reconnect resumes from the last-delivered seq', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connects = [];
  const client = { subscribeSSE(opts) { connects.push(opts); return { close() {} }; }, get: async () => ({ boot: 'B' }) };
  const bridge = startChannelBridge({ notify: () => {}, client, root: 'x' });
  await microflush();

  assert.equal(connects[0].since, undefined, 'first connect is live-only');
  connects[0].onEvent({ kind: 'wake', seq: 9, boot: 'B', batch: [] });
  connects[0].onClose(); // stream dropped → schedule reconnect
  t.mock.timers.tick(BACKOFF_TICK);
  await microflush(); // reconnect re-fetches the (same) boot, then resubscribes
  assert.equal(connects.length, 2, 'reconnected after backoff');
  assert.equal(connects[1].since, 9, 'same boot → resumes from the cursor');
  bridge.stop();
});

// F4: the daemon restarts DURING the reconnect backoff. Pre-fix, connect resumed
// with the old boot's cursor (35), the fresh daemon filtered the backoff-window
// wake as `3 <= 35`, and it was lost. Now connect checks the live boot token first
// and full-replays, so the missed wake is delivered.
test('bridge: a daemon restart during the reconnect backoff replays the missed wake (F4)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connects = [];
  let boot = 'pidA:1';
  const client = { subscribeSSE(opts) { connects.push(opts); return { close() {} }; }, get: async () => ({ boot }) };
  const notified = [];
  const bridge = startChannelBridge({ notify: (m, p) => notified.push(p), client, root: 'x' });
  await microflush();

  assert.equal(connects[0].since, undefined, 'first connect is live-only');
  connects[0].onEvent({ kind: 'wake', seq: 35, boot: 'pidA:1', batch: [{ id: 'q1', kind: 'signal', summary: 's' }] });
  assert.equal(notified.length, 1);

  // Stream drops; while the bridge backs off the daemon restarts (new boot, seq
  // space reset to 1) and a wake lands in the fresh ring at a LOW seq.
  connects[0].onClose();
  boot = 'pidB:2';
  t.mock.timers.tick(BACKOFF_TICK);
  await microflush(); // reconnect fetches the NEW boot before choosing the cursor

  assert.equal(connects.length, 2, 'reconnected after backoff');
  assert.equal(connects[1].since, 0, 'a changed boot forces a full replay, not since:35');

  // The fresh daemon replays the backoff-window wake (seq 3, below the old cursor).
  connects[1].onEvent({ kind: 'wake', seq: 3, boot: 'pidB:2', batch: [{ id: 'q9', kind: 'signal', summary: 'late' }] });
  assert.equal(notified.length, 2, 'the wake emitted during the backoff is delivered after reconnect');

  // A same-boot reconnect still dedupes: it resumes from the cursor and never
  // redelivers an already-delivered seq.
  connects[1].onClose();
  t.mock.timers.tick(BACKOFF_TICK);
  await microflush();
  assert.equal(connects.length, 3);
  assert.equal(connects[2].since, 3, 'same boot → resumes from the cursor');
  connects[2].onEvent({ kind: 'wake', seq: 3, boot: 'pidB:2', batch: [] }); // replay of a delivered seq
  assert.equal(notified.length, 2, 'the already-delivered seq is not redelivered');
  connects[2].onEvent({ kind: 'wake', seq: 4, boot: 'pidB:2', batch: [] }); // genuinely newer
  assert.equal(notified.length, 3, 'a new seq under the same boot still delivers');
  bridge.stop();
});

test('bridge: stop() prevents further reconnects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connects = [];
  const client = { subscribeSSE(opts) { connects.push(opts); return { close() {} }; }, get: async () => ({ boot: 'B' }) };
  const bridge = startChannelBridge({ notify: () => {}, client, root: 'x' });
  await microflush();
  bridge.stop();
  connects[0].onClose();
  t.mock.timers.tick(BACKOFF_TICK);
  assert.equal(connects.length, 1, 'no reconnect after stop()');
});

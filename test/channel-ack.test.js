// Delivery confirmation for a live Push. A wake fired at a LIVE channel is
// retained (pendingAck) until the bridge acks it back — so a silent drop (a
// zombie SSE stream, a notify that never lands) is detectable instead of
// vanishing. Two halves, mirroring channel-bridge.test.js:
//   * domain units for the retain / ack / repush / stale-fold / liveness paths;
//   * a REAL in-process daemon + bridge (fake notify sink, real HTTP client) that
//     exercises the end-to-end heartbeat + ack round-trip.

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { subscribeSSE } = require('../lib/client');
const { createBus } = require('../lib/core/bus');
const { startChannelBridge } = require('../lib/channel/bridge');
const queue = require('../lib/server/domain/queue');

const HTML = '<html><head><title>Doc</title></head><body><p>hi</p></body></html>';
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 2500) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await pred()) return; await settle(20); }
  throw new Error('waitFor timed out');
}

function liveState() {
  return { queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {}, wakeConsumers: 1, wakeConsumerSeenAt: Date.now(), pendingAck: null, pendingWake: null, pendingWakeSeq: 0 };
}

// ── domain: liveness gates park-vs-wake ──────────────────────────────────────

test('channelLive: fresh heartbeat is live; a stale one is not; count-0 never is', () => {
  const now = Date.now();
  assert.equal(queue.channelLive({ wakeConsumers: 1, wakeConsumerSeenAt: now }, now), true);
  assert.equal(queue.channelLive({ wakeConsumers: 1, wakeConsumerSeenAt: now - queue.CONSUMER_TTL_MS - 1 }, now), false, 'stale heartbeat = zombie');
  assert.equal(queue.channelLive({ wakeConsumers: 0, wakeConsumerSeenAt: now }, now), false, 'no consumer');
});

test('flush: a stale heartbeat PARKS instead of firing into a zombie stream', () => {
  const bus = createBus();
  const state = liveState();
  state.wakeConsumerSeenAt = Date.now() - queue.CONSUMER_TTL_MS - 1; // heartbeat went stale
  queue.enqueue(state, bus, { kind: 'signal', summary: 's' });
  const { wake, parked } = queue.flush(state, bus, {});
  assert.equal(wake, null, 'no live wake into a dead stream');
  assert.ok(parked, 'parked for reliable next-message delivery');
  assert.equal(state.pendingAck, null, 'nothing left in flight');
});

// ── domain: retain + ack ─────────────────────────────────────────────────────

test('flush: a live push retains the batch as pendingAck keyed by the wake seq', () => {
  const bus = createBus();
  const state = liveState();
  queue.enqueue(state, bus, { kind: 'signal', summary: 's' });
  const { wake } = queue.flush(state, bus, {});
  assert.ok(wake, 'fired a live wake');
  assert.ok(state.pendingAck, 'batch retained awaiting ack');
  assert.equal(state.pendingAck.seq, wake.seq);
  assert.equal(state.pendingAck.batch.length, 1);
});

test('ackWake: a matching ack clears the retain and emits a wake-ack frame', () => {
  const bus = createBus();
  const events = [];
  const wsFrames = [];
  bus.subscribe((e) => events.push(e));
  bus.setBroadcaster((f) => wsFrames.push(f));
  const state = liveState();
  queue.enqueue(state, bus, { kind: 'signal', summary: 's' });
  const { wake } = queue.flush(state, bus, {});

  assert.equal(queue.ackWake(state, bus, wake.seq, wake.boot), true, 'matching ack');
  assert.equal(state.pendingAck, null, 'retain cleared');
  assert.ok(events.some((e) => e.kind === 'wake-ack' && e.seq === wake.seq), 'wake-ack event emitted');
  assert.ok(wsFrames.some((f) => f.type === 'wake-ack' && f.seq === wake.seq), 'wake-ack WS frame emitted');
});

test('ackWake: a stale seq (or wrong boot) no-ops and leaves the retain intact', () => {
  const bus = createBus({ bootId: 'boot-1' }); // a real boot token so the boot guard bites
  const state = liveState();
  queue.enqueue(state, bus, { kind: 'signal', summary: 's' });
  const { wake } = queue.flush(state, bus, {});
  assert.equal(queue.ackWake(state, bus, wake.seq + 999, wake.boot), false, 'wrong seq');
  assert.equal(queue.ackWake(state, bus, wake.seq, 'some-other-boot'), false, 'wrong boot');
  assert.ok(state.pendingAck, 'retain untouched — the rail still awaits the real ack');
});

// ── domain: recovery + backstop ──────────────────────────────────────────────

test('repush: re-fires a live wake (new seq, re-retained) and parks on demand', () => {
  const bus = createBus();
  const state = liveState();
  queue.enqueue(state, bus, { kind: 'signal', summary: 's' });
  const { wake } = queue.flush(state, bus, {});

  const again = queue.repush(state, bus, wake.seq, {});
  assert.equal(again.mode, 'wake');
  assert.notEqual(again.wake.seq, wake.seq, 'a fresh seq for the rail to await');
  assert.equal(state.pendingAck.seq, again.wake.seq, 're-retained under the new seq');

  const held = queue.repush(state, bus, again.wake.seq, { park: true });
  assert.equal(held.mode, 'parked', 'Hold converts it to a park');
  assert.equal(state.pendingAck, null);
  assert.ok(state.pendingWake, 'delivered on the next message');
});

test('repush: an unknown seq is a 404-able null (nothing retained)', () => {
  const bus = createBus();
  const state = liveState();
  assert.equal(queue.repush(state, bus, 123, {}), null);
});

test('foldStaleAck: leaves a fresh retain, folds a stale one into the park', () => {
  const bus = createBus();
  const state = liveState();
  queue.enqueue(state, bus, { kind: 'signal', summary: 's' });
  queue.flush(state, bus, {});
  const seq = state.pendingAck.seq;

  assert.equal(queue.foldStaleAck(state), false, 'fresh retain is left for the live rail');
  assert.ok(state.pendingAck, 'still in flight');

  state.pendingAck.created_at = Date.now() - queue.ACK_STALE_MS - 1; // age it out
  assert.equal(queue.foldStaleAck(state), true, 'stale retain folds');
  assert.equal(state.pendingAck, null);
  assert.ok(state.pendingWake, 'now a park — rides the next message');
  assert.equal(state.pendingWake.batch.length, 1, 'the retained batch is preserved in the park');
  assert.equal(typeof seq, 'number');
});

test('flush: a new push folds a still-retained prior in-flight into the park (no loss)', () => {
  const bus = createBus();
  const state = liveState();
  queue.enqueue(state, bus, { kind: 'signal', summary: 'first' });
  queue.flush(state, bus, {}); // first push, retained
  assert.ok(state.pendingAck);

  queue.enqueue(state, bus, { kind: 'signal', summary: 'second' });
  queue.flush(state, bus, {}); // second push supersedes
  assert.ok(state.pendingWake, 'the first (un-acked) batch was parked, not dropped');
  assert.ok(state.pendingWake.batch.some((it) => it.summary === 'first'), 'first batch preserved in the park');
  assert.ok(state.pendingAck, 'the second push is now the in-flight one');
});

// ── integration: the real bridge heartbeats + acks over HTTP ─────────────────

function readyClient() {
  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  const client = {
    subscribeSSE(opts) { return subscribeSSE({ ...opts, onOpen: () => { if (opts.onOpen) opts.onOpen(); markReady(); } }); },
    get: (p, o) => require('../lib/client').get(p, o),
    post: (p, b, o) => require('../lib/client').post(p, b, o),
  };
  return { client, ready };
}

test('bridge: a delivered wake is acked back, clearing the retain and emitting wake-ack', async (t) => {
  const { api, root, port } = await withServer(t, { writePortfile: true });
  const acks = [];
  const ackStream = subscribeSSE({ port, kinds: ['wake-ack'], onEvent: (e) => { if (e.kind === 'wake-ack') acks.push(e); } });
  t.after(() => { try { ackStream.close(); } catch {} });

  const { client, ready } = readyClient();
  const notified = [];
  const bridge = startChannelBridge({ notify: (method, params) => notified.push({ method, params }), client, root });
  t.after(() => bridge.stop());
  await ready;

  await api.post('/api/capture', { url: 'https://example.com/page', title: 'Ex', html: HTML });
  const push = (await api.post('/api/queue/push', {})).json;
  assert.equal(push.mode, 'wake', 'live channel → live wake');
  assert.equal(typeof push.seq, 'number');

  // The bridge delivers the notification, then POSTs the ack, which emits wake-ack.
  await waitFor(() => notified.length >= 1);
  await waitFor(() => acks.some((a) => a.seq === push.seq));

  // Retain is cleared: a repush now finds nothing in flight.
  const rp = await api.post('/api/queue/repush', { seq: push.seq });
  assert.equal(rp.status, 404, 'delivery confirmed — nothing left to repush');
});

test('route: heartbeat stamps liveness; a wrong-seq ack no-ops', async (t) => {
  const { api } = await withServer(t);
  const hb = (await api.post('/api/channel/heartbeat', {})).json;
  assert.equal(hb.ok, true);
  const ack = (await api.post('/api/channel/ack', { seq: 9999 })).json;
  assert.equal(ack.acked, false, 'no matching in-flight wake');
});

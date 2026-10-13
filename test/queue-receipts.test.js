// U61c — receipts (spec §6.6, §6.1): each message's delivery, from queued to
// confirmed, driven only by the queue's own paths
// (lib/server/domain/queue.js), and served content-free by GET /api/queue
// (lib/server/routes/queue.js).
//
// Two halves, as test/queue-targeting.test.js: the domain on a plain state and
// bus, and the routes on a bare Express app with a fake audience. A request
// through lib/client is a host process (the turn-begin hook, the bridge); one
// through Node's fetch carries the Fetch Metadata headers a browser sends, so
// it stands for the rail (its Cancel).

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createBus } = require('../lib/core/bus');
const client = require('../lib/client');
const queue = require('../lib/server/domain/queue');
const { mountQueueRoutes } = require('../lib/server/routes/queue');
const { createState } = require('../lib/server/state');
const { createGraph } = require('../lib/server/graph');
const { isRemoteRequest } = require('../lib/core/cors');
const { atLeast, fromOptIn, MIRROR_HINT, MIRROR_FULL_HINT } = require('../lib/core/remote-policy');

const SECRET_TEXT = 'Receipts never carry this lapis-otter-7';

function freshState({ live = true } = {}) {
  const now = Date.now();
  return {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: live ? 1 : 0, wakeConsumerSeenAt: live ? now : 0,
    pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}

function capturedBus() {
  const bus = createBus({ bootId: 'boot-1' });
  const frames = [];
  bus.setBroadcaster((frame) => frames.push(frame));
  return { bus, frames };
}

const message = (text = SECRET_TEXT) => ({ text, skill: { name: 'capture-profile', args: 'lapis' }, files: [{ path: 'lib/core/bus.js', bytes: 10 }], chars: text.length, conversation_id: null });
const receiptOf = (state, msgId) => state.messageReceipts && state.messageReceipts.get(msgId);
const stateOf = (state, msgId) => (receiptOf(state, msgId) || {}).state;
const receiptFrames = (frames) => frames.filter((f) => f.type === 'queue' && f.op === 'receipt');
const receiptEvents = (bus) => bus.read({ kinds: ['queue'] }).events.filter((e) => e.op === 'receipt');

// Every receipt frame and ring event is exactly the content-free shape.
function assertReceiptShapes(frames, bus) {
  for (const f of receiptFrames(frames)) {
    assert.deepEqual(Object.keys(f).sort(), ['at', 'msg_id', 'op', 'state', 'type']);
    assert.ok(Number.isFinite(f.at));
    assert.ok(queue.RECEIPT_STATES.includes(f.state));
  }
  for (const e of receiptEvents(bus)) {
    const { msg_id, state, kind, op } = e;
    assert.equal(kind, 'queue');
    assert.equal(op, 'receipt');
    assert.ok(/^m-[0-9a-f]{8}$/.test(msg_id));
    assert.ok(queue.RECEIPT_STATES.includes(state));
    for (const k of ['text', 'item', 'batch', 'skill', 'files', 'summary']) assert.equal(k in e, false, `no ${k} on a receipt event`);
  }
  const all = JSON.stringify(receiptFrames(frames)) + JSON.stringify(receiptEvents(bus));
  assert.ok(!all.includes('lapis'), 'no word of the message, its args or its paths');
  assert.ok(!all.includes('bus.js'));
}

// ── the domain ───────────────────────────────────────────────────────────────

test('enqueue → queued; a live push → sending, then sent on the ack; one frame and one ring event per step', () => {
  const state = freshState();
  const { bus, frames } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  assert.equal(stateOf(state, m.msg_id), 'queued');
  assert.deepEqual(receiptFrames(frames).map((f) => [f.msg_id, f.state]), [[m.msg_id, 'queued']]);

  const r = queue.release(state, bus, [m.id]);
  assert.ok(r.wake);
  const rec = receiptOf(state, m.msg_id);
  assert.equal(rec.state, 'sending');
  assert.equal(rec.seq, r.wake.seq);
  assert.equal(rec.boot, 'boot-1');

  assert.equal(queue.ackWake(state, bus, r.wake.seq, r.wake.boot), true);
  assert.equal(stateOf(state, m.msg_id), 'sent');

  assert.deepEqual(receiptFrames(frames).map((f) => f.state), ['queued', 'sending', 'sent']);
  assert.deepEqual(receiptEvents(bus).map((e) => e.state), ['queued', 'sending', 'sent']);
  assertReceiptShapes(frames, bus);
});

test('no channel → parked with the park id; the turn-begin hook\'s consume → handed_over; the transcript → confirmed', () => {
  const state = freshState({ live: false });
  const { bus, frames } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  const r = queue.release(state, bus, [m.id]);
  assert.ok(r.parked);
  assert.equal(stateOf(state, m.msg_id), 'parked');
  assert.equal(receiptOf(state, m.msg_id).park_id, r.parked.id);

  assert.equal(queue.consumePending(state, r.parked.id, { bus, host: true }), true);
  assert.equal(stateOf(state, m.msg_id), 'handed_over');

  assert.equal(queue.confirmDelivered(state, bus, m.msg_id), true);
  assert.equal(stateOf(state, m.msg_id), 'confirmed');
  assert.deepEqual(receiptFrames(frames).map((f) => f.state), ['queued', 'parked', 'handed_over', 'confirmed']);
  assert.deepEqual(receiptEvents(bus).map((e) => e.state), ['queued', 'parked', 'handed_over', 'confirmed']);
  assertReceiptShapes(frames, bus);
});

test('a consume that is not the host discards the park: its messages fail; a stale id moves nothing', () => {
  const state = freshState({ live: false });
  const { bus } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  const { parked } = queue.release(state, bus, [m.id]);
  assert.equal(queue.consumePending(state, 'pw-stale', { bus, host: true }), false);
  assert.equal(stateOf(state, m.msg_id), 'parked');
  assert.equal(queue.consumePending(state, parked.id, { bus }), true, 'host defaults to false');
  assert.equal(stateOf(state, m.msg_id), 'failed');
});

test('a Take back → queued for the typed messages; a stop request stays parked under the new park id', () => {
  const state = freshState({ live: false });
  const { bus, frames } = capturedBus();
  const stop = queue.enqueueMessage(state, bus, { text: '', skill: null, files: [], chars: 0, conversation_id: null },
    { source: 'task-stop', task_id: 'bdz1n2', staged: true });
  const m = queue.enqueueMessage(state, bus, message());
  const { parked } = queue.flush(state, bus);
  assert.equal(stateOf(state, m.msg_id), 'parked');
  assert.equal(stateOf(state, stop.msg_id), 'parked');
  const r = queue.recallPending(state, bus, parked.id);
  assert.deepEqual(r.ids, [m.id]);
  assert.equal(stateOf(state, m.msg_id), 'queued');
  assert.equal(receiptOf(state, m.msg_id).park_id, undefined, 'a queued receipt keeps no park id');
  assert.equal(stateOf(state, stop.msg_id), 'parked');
  assert.equal(receiptOf(state, stop.msg_id).park_id, r.park.id, 'the re-stamped park\'s id, silently');
  assert.deepEqual(receiptFrames(frames).filter((f) => f.msg_id === stop.msg_id).map((f) => f.state), ['queued', 'parked']);
  assertReceiptShapes(frames, bus);
});

test('a drain of the park → sending; a merge into the park only refreshes park_id', () => {
  const state = freshState({ live: false });
  const { bus, frames } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  queue.release(state, bus, [m.id]);
  // A signal pushed onto the park re-stamps it: the message stays parked, one frame.
  queue.enqueue(state, bus, { kind: 'signal', signal_key: 'k', summary: 's', why_wake: 'w', source: 'browser' });
  const { parked } = queue.flush(state, bus);
  assert.equal(receiptOf(state, m.msg_id).park_id, parked.id);
  assert.equal(receiptFrames(frames).filter((f) => f.state === 'parked').length, 1);
  state.wakeConsumers = 1;
  state.wakeConsumerSeenAt = Date.now();
  const wake = queue.drainPending(state, bus, null);
  assert.ok(wake);
  assert.equal(stateOf(state, m.msg_id), 'sending');
  assert.equal(receiptOf(state, m.msg_id).seq, wake.seq);
  assert.equal(receiptOf(state, m.msg_id).park_id, undefined);
});

test('a parked message the MAX_QUEUE cap evicts from a merged park → failed, never parked for good', () => {
  const state = freshState({ live: false });
  const { bus, frames } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  queue.release(state, bus, [m.id]);
  assert.equal(stateOf(state, m.msg_id), 'parked');
  // MAX_QUEUE later signals merged into the park: the message is its oldest item.
  for (let i = 0; i < queue.MAX_QUEUE; i++) {
    queue.enqueue(state, bus, { kind: 'signal', signal_key: `k${i}`, summary: 's', why_wake: 'w', source: 'browser' });
  }
  const { parked } = queue.flush(state, bus);
  assert.equal(parked.batch.length, queue.MAX_QUEUE, 'the cap itself is unchanged');
  assert.equal(parked.batch.some((it) => it.msg_id === m.msg_id), false, 'the cap dropped the message');
  assert.equal(stateOf(state, m.msg_id), 'failed');
  assert.deepEqual(receiptFrames(frames).filter((f) => f.msg_id === m.msg_id).map((f) => f.state), ['queued', 'parked', 'failed']);
  assertReceiptShapes(frames, bus);
});

test('an ack while the channel is not live leaves the receipt sending', () => {
  const state = freshState();
  const { bus } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  const { wake } = queue.release(state, bus, [m.id]);
  state.wakeConsumers = 0;
  assert.equal(queue.ackWake(state, bus, wake.seq, wake.boot), false);
  assert.equal(stateOf(state, m.msg_id), 'sending');
});

test('a fold of a retained message wake into the park moves sending → parked', () => {
  const state = freshState();
  const { bus, frames } = capturedBus();
  const a = queue.enqueueMessage(state, bus, message());
  queue.release(state, bus, [a.id]);
  assert.equal(stateOf(state, a.msg_id), 'sending');
  // A new release supersedes the un-acked wake: flush folds it into the park.
  state.wakeConsumers = 0;
  const b = queue.enqueueMessage(state, bus, message('second'));
  const r = queue.release(state, bus, [b.id]);
  // The fold parked A first, so B waits in the queue (one message per park).
  assert.deepEqual(r.heldBack, [b.id]);
  assert.equal(stateOf(state, b.msg_id), 'queued');
  assert.equal(stateOf(state, a.msg_id), 'parked');
  assert.equal(receiptOf(state, a.msg_id).park_id, state.pendingWake.id);
  assert.equal(receiptOf(state, a.msg_id).seq != null, true, 'the wake it rode is still named');
  assert.deepEqual(receiptFrames(frames).filter((f) => f.msg_id === a.msg_id).map((f) => f.state), ['queued', 'sending', 'parked']);

  // The stale-ack backstop and a Hold (repush {park: true}) fold the same way.
  const s2 = freshState();
  const c = queue.enqueueMessage(s2, bus, message());
  queue.release(s2, bus, [c.id]);
  assert.equal(queue.foldStaleAck(s2, Date.now() + queue.ACK_STALE_MS + 1, bus), true);
  assert.equal(stateOf(s2, c.msg_id), 'parked');
  const s3 = freshState();
  const d = queue.enqueueMessage(s3, bus, message());
  const w = queue.release(s3, bus, [d.id]).wake;
  const rp = queue.repush(s3, bus, w.seq, { park: true });
  assert.equal(rp.mode, 'parked');
  assert.equal(stateOf(s3, d.msg_id), 'parked');
  // A live Retry stays sending, under the retry's seq.
  const s4 = freshState();
  const e = queue.enqueueMessage(s4, bus, message());
  const w4 = queue.release(s4, bus, [e.id]).wake;
  const rw = queue.repush(s4, bus, w4.seq, {});
  assert.equal(rw.mode, 'wake');
  assert.equal(stateOf(s4, e.msg_id), 'sending');
  assert.equal(receiptOf(s4, e.msg_id).seq, rw.wake.seq);
});

test('illegal steps are ignored: confirmed and failed never move; queued cannot become sent', () => {
  const state = freshState({ live: false });
  const { bus, frames } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  assert.equal(queue.noteReceipt(state, bus, m.msg_id, 'sent'), false);
  assert.equal(queue.noteReceipt(state, bus, m.msg_id, 'handed_over'), false);
  assert.equal(queue.confirmDelivered(state, bus, m.msg_id), false, 'a queued message was never sent');
  assert.equal(stateOf(state, m.msg_id), 'queued');
  assert.equal(queue.noteReceipt(state, bus, m.msg_id, 'bogus'), false);

  const { parked } = queue.release(state, bus, [m.id]);
  queue.consumePending(state, parked.id, { bus, host: true });
  queue.confirmDelivered(state, bus, m.msg_id);
  for (const next of queue.RECEIPT_STATES) assert.equal(queue.noteReceipt(state, bus, m.msg_id, next), false);
  assert.equal(stateOf(state, m.msg_id), 'confirmed');

  const f = queue.enqueueMessage(state, bus, message());
  const p2 = queue.release(state, bus, [f.id]).parked;
  queue.consumePending(state, p2.id, { bus, host: false });
  for (const next of queue.RECEIPT_STATES) assert.equal(queue.noteReceipt(state, bus, f.msg_id, next), false);
  assert.equal(queue.confirmDelivered(state, bus, f.msg_id), false);
  assert.equal(stateOf(state, f.msg_id), 'failed');

  // An unknown marker (an earlier boot's) creates nothing.
  assert.equal(queue.confirmDelivered(state, bus, 'm-00000000'), false);
  assert.equal(queue.markUnconfirmed(state, bus, 'm-00000000'), false);
  assert.equal(state.messageReceipts.has('m-00000000'), false);
  // Every frame was one accepted step.
  assert.deepEqual(receiptFrames(frames).map((x) => x.state),
    ['queued', 'parked', 'handed_over', 'confirmed', 'queued', 'parked', 'failed']);
});

test('markUnconfirmed moves only sent and handed_over; unconfirmed → confirmed still', () => {
  const live = freshState();
  const { bus } = capturedBus();
  const a = queue.enqueueMessage(live, bus, message());
  assert.equal(queue.markUnconfirmed(live, bus, a.msg_id), false, 'not from queued');
  const { wake } = queue.release(live, bus, [a.id]);
  assert.equal(queue.markUnconfirmed(live, bus, a.msg_id), false, 'not from sending');
  queue.ackWake(live, bus, wake.seq, wake.boot);
  assert.equal(queue.markUnconfirmed(live, bus, a.msg_id), true, 'from sent');
  assert.equal(stateOf(live, a.msg_id), 'unconfirmed');
  assert.equal(queue.markUnconfirmed(live, bus, a.msg_id), false);
  assert.equal(queue.confirmDelivered(live, bus, a.msg_id), true);
  assert.equal(queue.markUnconfirmed(live, bus, a.msg_id), false, 'not from confirmed');

  const off = freshState({ live: false });
  const b = queue.enqueueMessage(off, bus, message());
  const { parked } = queue.release(off, bus, [b.id]);
  assert.equal(queue.markUnconfirmed(off, bus, b.msg_id), false, 'not from parked');
  queue.consumePending(off, parked.id, { bus, host: true });
  assert.equal(queue.markUnconfirmed(off, bus, b.msg_id), true, 'from handed_over');

  const c = queue.enqueueMessage(off, bus, message());
  queue.consumePending(off, queue.release(off, bus, [c.id]).parked.id, { bus });
  assert.equal(queue.markUnconfirmed(off, bus, c.msg_id), false, 'not from failed');
});

test('the transport seam taking a message → sent (through sending); confirmed only from the transcript', () => {
  const state = freshState();
  const { bus, frames } = capturedBus();
  state.messageTransport = () => ({ via: 'mod' });
  const m = queue.enqueueMessage(state, bus, message());
  const r = queue.release(state, bus, [m.id]);
  assert.deepEqual(r.transported, [{ id: m.id, via: 'mod' }]);
  assert.equal(stateOf(state, m.msg_id), 'sent');
  assert.deepEqual(receiptFrames(frames).map((f) => f.state), ['queued', 'sending', 'sent']);
});

test('out of sent: a transport\'s hand-back → queued, a failed command op → failed; no other new step', () => {
  // The main session's decision after tranche 6 wave 2 (U91b): RECEIPT_NEXT.sent
  // gains 'queued' and 'failed', and nothing else in the table changes.
  const state = freshState();
  const { bus, frames } = capturedBus();
  state.messageTransport = () => ({ via: 'mod' });
  const a = queue.enqueueMessage(state, bus, message());
  queue.release(state, bus, [a.id]);
  assert.equal(stateOf(state, a.msg_id), 'sent');
  for (const next of ['sending', 'parked', 'handed_over']) assert.equal(queue.noteReceipt(state, bus, a.msg_id, next), false, `sent ↛ ${next}`);
  assert.equal(queue.noteReceipt(state, bus, a.msg_id, 'queued'), true, 'sent → queued (handed back)');
  assert.equal(queue.noteReceipt(state, bus, a.msg_id, 'parked'), true, 'then it parks as any other');
  const b = queue.enqueueMessage(state, bus, message());
  queue.release(state, bus, [b.id]);
  assert.equal(queue.noteReceipt(state, bus, b.msg_id, 'failed'), true, 'sent → failed (a failed command op)');
  for (const next of queue.RECEIPT_STATES) assert.equal(queue.noteReceipt(state, bus, b.msg_id, next), false, 'failed stays final');
  assert.deepEqual(receiptFrames(frames).map((f) => f.state),
    ['queued', 'sending', 'sent', 'queued', 'parked', 'queued', 'sending', 'sent', 'failed']);
  assertReceiptShapes(frames, bus);
});

test('removing a queued message drops its receipt with no frame of its own', () => {
  const state = freshState();
  const { bus, frames } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  const before = receiptFrames(frames).length;
  queue.remove(state, bus, m.id);
  assert.equal(state.messageReceipts.has(m.msg_id), false);
  assert.equal(receiptFrames(frames).length, before);
  assert.ok(frames.some((f) => f.type === 'queue' && f.op === 'remove' && f.id === m.id));
});

test('51 receipts drop the oldest; the draft snapshot holds no receipts', () => {
  const state = createState();
  state.wakeConsumers = 1;
  state.wakeConsumerSeenAt = Date.now();
  const { bus } = capturedBus();
  const ids = [];
  for (let i = 0; i < queue.RECEIPTS_MAX + 1; i++) {
    const m = queue.enqueueMessage(state, bus, message());
    ids.push(m.msg_id);
    const { wake } = queue.release(state, bus, [m.id]);
    queue.ackWake(state, bus, wake.seq, wake.boot);
    queue.confirmDelivered(state, bus, m.msg_id);
  }
  assert.equal(queue.RECEIPTS_MAX, 50);
  assert.equal(state.messageReceipts.size, 50);
  assert.equal(state.messageReceipts.has(ids[0]), false, 'the oldest dropped');
  assert.deepEqual(queue.receiptsList(state).map((r) => r.msg_id), ids.slice(1));
  // A minted id never reuses one a receipt still remembers.
  const m = queue.enqueueMessage(state, bus, message());
  assert.equal(stateOf(state, m.msg_id), 'queued');

  const fakePaths = { GRAPH_DIR: '/tmp/non-existent', META_PATH: '/tmp/non-existent/_meta.json' };
  const snap = createGraph({ paths: fakePaths, state }).snapshotLive();
  const bytes = JSON.stringify(snap);
  assert.equal(Object.keys(snap).some((k) => /receipt/i.test(k)), false, 'no receipts field');
  for (const id of ids) assert.equal(bytes.includes(id), false, 'a delivered message leaves no trace in the draft');
  assert.ok(bytes.includes(m.msg_id), 'the queued message itself still rides the draft (U61a)');
});

// ── the routes ───────────────────────────────────────────────────────────────

function fakeAudience({ optIn = 'off' } = {}) {
  const a = {
    optIn,
    levelOf(req) { return isRemoteRequest(req) ? fromOptIn(a.optIn) : 'local'; },
    requireMirror(need) {
      return (req, res, next) => {
        const level = a.levelOf(req);
        if (atLeast(level, need)) return next();
        return res.status(403).json({ ok: false, mirror: level, remote: isRemoteRequest(req),
          hint: need === 'full' ? MIRROR_FULL_HINT : MIRROR_HINT });
      };
    },
  };
  return a;
}

async function host(t, { live = true, optIn = 'off' } = {}) {
  const state = freshState({ live });
  const { bus, frames } = capturedBus();
  const ctx = { state, bus, graph: null, audience: fakeAudience({ optIn }), mirror: { enabled: () => ({ enabled: true }) } };
  const app = express();
  app.use(express.json());
  mountQueueRoutes(app, ctx);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  // Node's fetch: a browser request (the rail).
  const call = async (method, p, body, { remote = false } = {}) => {
    const h = {};
    if (remote) h['X-WC-Remote'] = '1';
    const init = { method, headers: h };
    if (body !== undefined) { init.body = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  // lib/client: a host process (the turn-begin hook, the bridge).
  const hostPost = (p, body) => client.post(p, body, { port, noSpawn: true });
  return { state, bus, frames, ctx, call, hostPost };
}

test('a consume through lib/client → handed_over; through Node\'s fetch → failed', async (t) => {
  const h = await host(t, { live: false });
  const a = queue.enqueueMessage(h.state, h.bus, message());
  const p1 = queue.release(h.state, h.bus, [a.id]).parked;
  assert.deepEqual(await h.hostPost('/api/queue/pending/consume', { id: p1.id }), { ok: true, consumed: true });
  assert.equal(stateOf(h.state, a.msg_id), 'handed_over');

  const b = queue.enqueueMessage(h.state, h.bus, message());
  const p2 = queue.release(h.state, h.bus, [b.id]).parked;
  const cancel = await h.call('POST', '/api/queue/pending/consume', { id: p2.id });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.consumed, true);
  assert.equal(stateOf(h.state, b.msg_id), 'failed');
  assertReceiptShapes(h.frames, h.bus);
});

test('GET /api/queue/pending folds a stale retain into the park: sending → parked, then the hook\'s consume hands it over', async (t) => {
  const h = await host(t);
  const m = queue.enqueueMessage(h.state, h.bus, message());
  queue.release(h.state, h.bus, [m.id]);
  assert.equal(stateOf(h.state, m.msg_id), 'sending');
  h.state.pendingAck.created_at = Date.now() - queue.ACK_STALE_MS - 1;
  const pending = await h.call('GET', '/api/queue/pending');
  assert.ok(pending.json.pending);
  assert.equal(stateOf(h.state, m.msg_id), 'parked');
  assert.equal(receiptOf(h.state, m.msg_id).park_id, pending.json.pending.id);
  await h.hostPost('/api/queue/pending/consume', { id: pending.json.pending.id });
  assert.equal(stateOf(h.state, m.msg_id), 'handed_over');
});

test('GET /api/queue serves receipts locally and at basic remote, content-free', async (t) => {
  const h = await host(t, { live: false });
  const queued = queue.enqueueMessage(h.state, h.bus, message());
  const held = queue.enqueueMessage(h.state, h.bus, message(), { staged: false });
  const sentOne = queue.enqueueMessage(h.state, h.bus, message());
  queue.release(h.state, h.bus, [sentOne.id]);
  const want = [
    { msg_id: queued.msg_id, state: 'queued' },
    { msg_id: held.msg_id, state: 'queued' },
    { msg_id: sentOne.msg_id, state: 'parked' },
  ];
  for (const remote of [false, true]) {
    const r = await h.call('GET', '/api/queue', undefined, { remote });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.receipts.map(({ msg_id, state }) => ({ msg_id, state })), want);
    for (const rec of r.json.receipts) {
      assert.deepEqual(Object.keys(rec).sort(), ['at', 'msg_id', 'state']);
      assert.ok(Number.isFinite(rec.at));
    }
    assert.ok(!JSON.stringify(r.json.receipts).includes('lapis'));
    if (remote) assert.ok(!r.text.includes('lapis'), 'a basic viewer sees no word of any message');
  }
  // Before any message, the list is empty, not absent.
  const h2 = await host(t);
  assert.deepEqual((await h2.call('GET', '/api/queue')).json.receipts, []);
});

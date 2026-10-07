// U61b — targeting, Take back and the channel gate (spec §6.4 Targeting and
// One message per park, §6.3's recall row, §5.7 P1, ruling C1 (a)).
//
// Two halves, as test/queue-messages.test.js: the domain
// (lib/server/domain/queue.js — stampChannel, channelLiveFor, deliver's
// target, the park's target, drainPending by pid, the one-message park rule,
// recallPending) on a plain state and bus; and the routes
// (lib/server/routes/queue.js) on a bare Express app with that file's fake
// audience. A request through lib/client is a host process (the bridge); one
// through Node's fetch carries the Fetch Metadata headers a browser sends, so
// it stands for a pane's fetch.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createBus } = require('../lib/core/bus');
const client = require('../lib/client');
const queue = require('../lib/server/domain/queue');
const { mountQueueRoutes } = require('../lib/server/routes/queue');
const { isRemoteRequest } = require('../lib/core/cors');
const { atLeast, fromOptIn, MIRROR_HINT, MIRROR_FULL_HINT } = require('../lib/core/remote-policy');

const SECRET_TEXT = 'Take this back please opal-heron-5';
const SECOND_TEXT = 'And this one too cobalt-finch-2';

function freshState({ live = true, pids = [] } = {}) {
  const now = Date.now();
  const state = {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: live ? 1 : 0, wakeConsumerSeenAt: live ? now : 0,
    pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
  for (const pid of pids) queue.stampChannel(state, pid, now);
  return state;
}

function capturedBus() {
  const bus = createBus({ bootId: 'boot-1' });
  const frames = [];
  bus.setBroadcaster((frame) => frames.push(frame));
  return { bus, frames };
}

const message = (text = SECRET_TEXT) => ({ text, skill: null, files: [], chars: text.length, conversation_id: null });
const stopRequest = (state, bus, taskId = 'bdz1n2') => queue.enqueueMessage(state, bus,
  { text: '', skill: null, files: [], chars: 0, conversation_id: null },
  { source: 'task-stop', task_id: taskId, staged: true, autosend: false });
const signal = (n = 1) => ({ kind: 'signal', signal_key: `k${n}`, summary: `signal ${n}`, why_wake: 'declared signal', source: 'browser' });
const wakesIn = (bus) => bus.read({ kinds: ['wake'] }).events;

// ── per-pid consumers ────────────────────────────────────────────────────────

test('stampChannel: a pid is live while fresh; another is not; channelLive is unchanged', () => {
  const now = Date.now();
  const state = freshState({ pids: [111] });
  assert.equal(queue.channelLiveFor(state, 111, now), true);
  assert.equal(queue.channelLiveFor(state, 222, now), false);
  assert.equal(queue.channelLiveFor(state, undefined, now), true, 'no pid: channelLive');
  assert.equal(queue.channelLive(state, now), true);
  // A stale pid is gone, and the next stamp prunes it.
  assert.equal(queue.channelLiveFor(state, 111, now + queue.CONSUMER_TTL_MS), false);
  queue.stampChannel(state, 333, now + queue.CONSUMER_TTL_MS);
  assert.deepEqual([...state.channelPids.keys()], [333]);
  // Anything but a positive safe integer is ignored (the channel is still stamped).
  const s2 = freshState({ live: true });
  for (const bad of ['111', 0, -4, 1.5, null, Number.MAX_SAFE_INTEGER + 2]) {
    assert.deepEqual(queue.stampChannel(s2, bad), { pid: null, turnedLive: false });
  }
  assert.equal(s2.channelPids, undefined);
});

test('stampChannel: turnedLive on a first or stale stamp only; at most 32 pids, least recent dropped', () => {
  const now = Date.now();
  const state = freshState();
  assert.equal(queue.stampChannel(state, 111, now).turnedLive, true);
  assert.equal(queue.stampChannel(state, 111, now + 1000).turnedLive, false);
  assert.equal(queue.stampChannel(state, 111, now + 1000 + queue.CONSUMER_TTL_MS).turnedLive, true);
  const s = freshState();
  for (let pid = 1; pid <= queue.CHANNEL_PIDS_MAX + 3; pid++) queue.stampChannel(s, pid, now);
  assert.equal(s.channelPids.size, queue.CHANNEL_PIDS_MAX);
  assert.equal(s.channelPids.has(1), false);
  assert.equal(s.channelPids.has(queue.CHANNEL_PIDS_MAX + 3), true);
});

test('channelLiveFor: while no consumer has reported a pid, a target is judged by channelLive (best effort)', () => {
  const state = freshState();
  assert.equal(queue.channelLiveFor(state, 222), true);
  assert.equal(queue.channelLiveFor(freshState({ live: false }), 222), false);
});

// ── targeted delivery ─────────────────────────────────────────────────────────

test('deliver: a live target wakes with target_pid and the retain keeps it; a dead one parks at once', () => {
  const state = freshState({ pids: [111] });
  const { bus } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  const r = queue.release(state, bus, [m.id], { target_pid: 111 });
  assert.equal(r.wake.target_pid, 111);
  assert.equal(state.pendingAck.target_pid, 111);
  assert.equal(r.parked, null);

  const s2 = freshState({ pids: [111] });
  const m2 = queue.enqueueMessage(s2, bus, message());
  const before = wakesIn(bus).length;
  const r2 = queue.release(s2, bus, [m2.id], { target_pid: 222 });
  assert.equal(r2.wake, null);
  assert.equal(r2.parked.target_pid, 222);
  assert.equal(wakesIn(bus).length, before, 'no wake went out');
  assert.equal(s2.queue.length, 0, 'the message left the queue for the park');

  // Untargeted: today's rule — live wakes, not live parks.
  const s3 = freshState({ pids: [111] });
  const m3 = queue.enqueueMessage(s3, bus, message());
  const r3 = queue.release(s3, bus, [m3.id]);
  assert.ok(r3.wake);
  assert.equal(Object.hasOwn(r3.wake, 'target_pid'), false);
  assert.equal(Object.hasOwn(s3.pendingAck, 'target_pid'), false);
  const s4 = freshState({ live: false });
  queue.enqueueMessage(s4, bus, message());
  assert.ok(queue.flush(s4, bus).parked);
});

test('a signal-only wake carries no target_pid key', () => {
  const state = freshState({ pids: [111] });
  const { bus } = capturedBus();
  queue.enqueue(state, bus, signal());
  const { wake } = queue.flush(state, bus);
  assert.ok(wake);
  assert.equal(Object.hasOwn(wake, 'target_pid'), false);
  const direct = queue.emitWake(bus, [{ kind: 'signal' }], {});
  assert.equal(Object.hasOwn(direct, 'target_pid'), false);
});

// ── the park's target ─────────────────────────────────────────────────────────

test('park merges: untargeted + targeted → targeted; two targets → untargeted for good', () => {
  const state = freshState({ live: false });
  queue.parkWake(state, { batch: [{ id: 'q1', kind: 'signal' }] });
  assert.equal(state.pendingWake.target_pid, undefined);
  queue.parkWake(state, { batch: [{ id: 'q2', kind: 'signal' }], target_pid: 111 });
  assert.equal(state.pendingWake.target_pid, 111, 'a targeted batch sets it');
  queue.parkWake(state, { batch: [{ id: 'q3', kind: 'signal' }] });
  assert.equal(state.pendingWake.target_pid, 111, 'an untargeted batch leaves it');
  queue.parkWake(state, { batch: [{ id: 'q4', kind: 'signal' }], target_pid: 111 });
  assert.equal(state.pendingWake.target_pid, 111, 'the same target keeps it');
  queue.parkWake(state, { batch: [{ id: 'q5', kind: 'signal' }], target_pid: 222 });
  assert.equal(state.pendingWake.target_pid, undefined, 'two targets: any session may claim it');
  assert.equal(state.pendingWake.mixed_targets, true);
  queue.parkWake(state, { batch: [{ id: 'q6', kind: 'signal' }], target_pid: 111 });
  assert.equal(state.pendingWake.target_pid, undefined, 'and it stays untargeted');
  assert.equal(state.pendingWake.batch.length, 6, 'nothing lost');
});

test('a folded retain carries its target into the park (foldPendingAck, foldStaleAck, repush)', () => {
  const { bus } = capturedBus();
  const live = () => {
    const state = freshState({ pids: [111] });
    const m = queue.enqueueMessage(state, bus, message());
    queue.release(state, bus, [m.id], { target_pid: 111 });
    assert.equal(state.pendingAck.target_pid, 111);
    return state;
  };
  const a = live();
  queue.foldPendingAck(a);
  assert.equal(a.pendingWake.target_pid, 111);

  const b = live();
  b.pendingAck.created_at = Date.now() - queue.ACK_STALE_MS - 1;
  assert.equal(queue.foldStaleAck(b), true);
  assert.equal(b.pendingWake.target_pid, 111);

  const c = live();
  const held = queue.repush(c, bus, c.pendingAck.seq, { park: true });
  assert.equal(held.parked.target_pid, 111);

  // A Retry stays aimed: live → a fresh targeted wake, retained with its target.
  const d = live();
  const again = queue.repush(d, bus, d.pendingAck.seq, {});
  assert.equal(again.mode, 'wake');
  assert.equal(again.wake.target_pid, 111);
  assert.equal(d.pendingAck.target_pid, 111);
  // …and parks when the target's channel has gone.
  d.channelPids.set(111, Date.now() - queue.CONSUMER_TTL_MS - 1);
  queue.stampChannel(d, 333);
  const parked = queue.repush(d, bus, d.pendingAck.seq, {});
  assert.equal(parked.mode, 'parked');
  assert.equal(parked.parked.target_pid, 111);
});

test('drainPending: a park targeted at 222 is left by a connect (no pid) and drained to 222', () => {
  const state = freshState({ pids: [111] });
  const { bus } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  queue.release(state, bus, [m.id], { target_pid: 222 });
  assert.equal(state.pendingWake.target_pid, 222);
  assert.equal(queue.drainPending(state, bus, null), null, 'a consumer connect does not drain it');
  assert.ok(state.pendingWake);
  assert.equal(queue.drainPending(state, bus, null, { pid: 111 }), null, 'nor does another pid');
  const wake = queue.drainPending(state, bus, null, { pid: 222 });
  assert.equal(wake.target_pid, 222);
  assert.equal(state.pendingWake, null);
  assert.equal(state.pendingAck.target_pid, 222, 'retained with its target');

  // An untargeted park drains whatever the pid.
  const s2 = freshState({ live: false });
  queue.enqueue(s2, bus, signal());
  queue.flush(s2, bus);
  assert.ok(queue.drainPending(s2, bus, null, { pid: 999 }));
});

// ── one message per park ──────────────────────────────────────────────────────

test('one message per park: a second typed message stays queued, waiting parked_message, autosend on', () => {
  const state = freshState({ live: false });
  const { bus, frames } = capturedBus();
  const m1 = queue.enqueueMessage(state, bus, message());
  assert.ok(queue.release(state, bus, [m1.id]).parked);
  const m2 = queue.enqueueMessage(state, bus, message(SECOND_TEXT), { autosend: false });
  const parkId = state.pendingWake.id;
  frames.length = 0;
  const r = queue.release(state, bus, [m2.id]);
  assert.deepEqual(r.heldBack, [m2.id]);
  assert.equal(r.parked, null);
  assert.equal(state.pendingWake.id, parkId, 'the park is untouched');
  const it = state.queue.find((q) => q.id === m2.id);
  assert.equal(it.waiting, 'parked_message');
  assert.equal(it.autosend, true);
  assert.ok(!frames.some((f) => f.op === 'remove'), 'it never left the queue');
  const upd = frames.find((f) => f.op === 'update' && f.id === m2.id);
  assert.equal(upd.item.waiting, 'parked_message', 'the rail sees why it waits');
  assert.ok(!JSON.stringify(frames).includes('cobalt'), 'no text on a frame');

  // A signal Push still parks; a stop request parks beside the message.
  const s = queue.enqueue(state, bus, signal());
  const pushed = queue.flush(state, bus);
  assert.ok(pushed.parked);
  assert.ok(state.pendingWake.batch.some((x) => x.id === s.id));
  assert.ok(state.queue.some((q) => q.id === m2.id), 'the waiting message stayed (a plain Push holds it back too)');
  const stop = stopRequest(state, bus);
  const sr = queue.release(state, bus, [stop.id]);
  assert.ok(sr.parked);
  assert.equal(sr.heldBack, undefined);
  assert.deepEqual(state.pendingWake.batch.filter(queue.isMessage).map((x) => x.id), [m1.id, stop.id]);
});

test('one message per park: with an empty park the first of two typed messages goes, the second waits', () => {
  const state = freshState({ live: false });
  const { bus } = capturedBus();
  const a = queue.enqueueMessage(state, bus, message());
  const b = queue.enqueueMessage(state, bus, message(SECOND_TEXT));
  const r = queue.flush(state, bus);
  assert.deepEqual(r.batch.map((x) => x.id), [a.id]);
  assert.deepEqual(r.heldBack, [b.id]);
  assert.deepEqual(state.queue.map((q) => q.id), [b.id]);
});

test('one message per park: a parked stop request leaves room for a typed message', () => {
  const state = freshState({ live: false });
  const { bus } = capturedBus();
  const stop = stopRequest(state, bus);
  assert.ok(queue.release(state, bus, [stop.id]).parked);
  const m = queue.enqueueMessage(state, bus, message());
  const r = queue.release(state, bus, [m.id]);
  assert.equal(r.heldBack, undefined, 'a stop request is not the park\'s one message');
  assert.ok(r.parked);
  assert.deepEqual(state.pendingWake.batch.filter(queue.isMessage).map((x) => x.id), [stop.id, m.id]);
  assert.equal(state.queue.length, 0);
});

test('one message per park: a live channel holds nothing back; a fold may join a second message', () => {
  const state = freshState({ live: false });
  const { bus } = capturedBus();
  const m1 = queue.enqueueMessage(state, bus, message());
  queue.release(state, bus, [m1.id]);
  // The channel comes up: a release now wakes, with a message parked behind.
  state.wakeConsumers = 1;
  queue.stampChannel(state, 111);
  const m2 = queue.enqueueMessage(state, bus, message(SECOND_TEXT));
  const r = queue.release(state, bus, [m2.id]);
  assert.ok(r.wake);
  assert.equal(r.heldBack, undefined);
  queue.foldPendingAck(state);
  assert.deepEqual(state.pendingWake.batch.filter(queue.isMessage).map((x) => x.id), [m1.id, m2.id]);
});

// ── Take back (recall) ────────────────────────────────────────────────────────

test('recall: a stale id answers null; a park holding two messages puts both back, in order, and clears', () => {
  const state = freshState({ live: false });
  const { bus, frames } = capturedBus();
  const a = queue.enqueueMessage(state, bus, message());
  const b = queue.enqueueMessage(state, bus, message(SECOND_TEXT), { autosend: true });
  // Two messages in one park, as a fold makes one.
  const sent = state.queue.splice(0).map((it) => ({ ...it, waiting: 'parked_message' }));
  queue.parkWake(state, { batch: sent });
  assert.equal(queue.recallPending(state, bus, 'pw-nope'), null);
  frames.length = 0;
  const r = queue.recallPending(state, bus, state.pendingWake.id);
  assert.deepEqual(r.ids, [a.id, b.id]);
  assert.equal(r.park, null);
  assert.equal(state.pendingWake, null, 'nothing left: the park clears');
  assert.deepEqual(state.queue.map((q) => q.id), [a.id, b.id]);
  for (const it of state.queue) {
    assert.equal(it.staged, true);
    assert.equal(it.autosend, false);
    assert.equal(Object.hasOwn(it, 'waiting'), false);
  }
  assert.equal(state.queue[0].text, SECRET_TEXT, 'the stored item keeps its words');
  const adds = frames.filter((f) => f.type === 'queue' && f.op === 'add');
  assert.deepEqual(adds.map((f) => f.item.id), [a.id, b.id], 'one add frame each');
  assert.ok(!JSON.stringify(frames).includes('opal') && !JSON.stringify(frames).includes('cobalt'), 'no text on a frame');
  const ring = bus.read({ kinds: ['queue'] }).events.filter((e) => e.op === 'add').slice(-2);
  assert.ok(!JSON.stringify(ring).includes('opal'), 'nor on the ring');
});

test('recall: a message, a stop request and a signal — only the message comes back', () => {
  const state = freshState({ live: false });
  const { bus } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  const stop = stopRequest(state, bus);
  const s = queue.enqueue(state, bus, signal());
  queue.flush(state, bus);
  const park = state.pendingWake;
  assert.match(park.envelope.content, /opal-heron-5/);
  const r = queue.recallPending(state, bus, park.id);
  assert.deepEqual(r.ids, [m.id]);
  assert.deepEqual(state.queue.map((q) => q.id), [m.id]);
  const left = state.pendingWake;
  assert.ok(left, 'the stop request and the signal stay parked');
  assert.notEqual(left.id, park.id, 're-stamped: a hook holding the old envelope no-ops on consume');
  assert.equal(r.park.id, left.id);
  assert.deepEqual(left.batch.map((x) => x.id), [stop.id, s.id]);
  assert.match(left.envelope.content, /Stop request from the web-chat page \[web-chat message m-[0-9a-f]{8}\]: stop background task bdz1n2/);
  assert.match(left.envelope.content, /signal 1/);
  assert.ok(!left.envelope.content.includes('opal-heron-5'), 'the message block is gone');
  assert.ok(!left.envelope.content.includes(m.msg_id), 'and its marker');
  assert.equal(left.created_at, park.created_at);
});

test('recall: a signal-only park is left as it is', () => {
  const state = freshState({ live: false });
  const { bus } = capturedBus();
  queue.enqueue(state, bus, signal());
  queue.flush(state, bus);
  const park = state.pendingWake;
  const r = queue.recallPending(state, bus, park.id);
  assert.deepEqual(r.ids, []);
  assert.equal(state.pendingWake, park);
  assert.equal(state.queue.length, 0);
});

test('recall: a park left with only its Push note keeps the note parked', () => {
  const state = freshState({ live: false });
  const { bus } = capturedBus();
  const m = queue.enqueueMessage(state, bus, message());
  queue.flush(state, bus, { note: 'look at the second tab' });
  const park = state.pendingWake;
  const r = queue.recallPending(state, bus, park.id);
  assert.deepEqual(r.ids, [m.id]);
  assert.ok(state.pendingWake, 'the note is still in it, so the park stays');
  assert.equal(r.park.id, state.pendingWake.id);
  assert.deepEqual(state.pendingWake.batch, []);
  assert.equal(state.pendingWake.note, 'look at the second tab');
  assert.ok(!state.pendingWake.envelope.content.includes('opal-heron-5'), 'the message block is gone');
});

// ── the routes ───────────────────────────────────────────────────────────────

// test/queue-messages.test.js's fake audience: a plain loopback request is
// local; one with the portal's label gets the project's opt-in. It has no
// requireHost, so the route falls back to the no-opt-in audience's gate.
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

async function host(t, { live = true, optIn = 'off', queueRelease } = {}) {
  const state = freshState({ live });
  const { bus, frames } = capturedBus();
  const audience = fakeAudience({ optIn });
  const ctx = { state, bus, graph: null, audience, mirror: { enabled: () => ({ enabled: true }) } };
  if (queueRelease) ctx.queueRelease = queueRelease;
  const app = express();
  app.use(express.json());
  mountQueueRoutes(app, ctx);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  // Node's fetch: a browser request (a pane's fetch).
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
  // lib/client: a host process (the bridge).
  const hostPost = (p, body) => client.post(p, body, { port, noSpawn: true });
  return { state, bus, frames, audience, ctx, call, hostPost, base };
}

test('heartbeat {pid} through lib/client stamps that pid; through fetch (a browser) it is refused', async (t) => {
  const h = await host(t);
  const hb = await h.hostPost('/api/channel/heartbeat', { pid: 111 });
  assert.deepEqual(hb, { ok: true, connected: true });
  assert.equal(queue.channelLiveFor(h.state, 111), true);
  assert.equal(queue.channelLiveFor(h.state, 222), false);
  // A pid that is not a positive safe integer is ignored.
  await h.hostPost('/api/channel/heartbeat', { pid: '222' });
  assert.equal(queue.channelLiveFor(h.state, 222), false);

  const seenAt = h.state.wakeConsumerSeenAt;
  const browser = await h.call('POST', '/api/channel/heartbeat', { pid: 222 });
  assert.equal(browser.status, 403);
  assert.equal(browser.json.ok, false);
  assert.equal(h.state.channelPids.has(222), false, 'a pane cannot fake a target\'s liveness');
  assert.equal(h.state.wakeConsumerSeenAt, seenAt);
  assert.equal((await h.call('POST', '/api/channel/heartbeat', {}, { remote: true })).status, 403, 'nor a remote viewer');
});

test('ack: through fetch → 403 and the retain stays; through lib/client as today', async (t) => {
  const h = await host(t);
  await h.hostPost('/api/channel/heartbeat', { pid: 111 });
  queue.enqueue(h.state, h.bus, signal());
  const { wake } = queue.flush(h.state, h.bus);
  const refused = await h.call('POST', '/api/channel/ack', { seq: wake.seq, boot: wake.boot });
  assert.equal(refused.status, 403);
  assert.ok(h.state.pendingAck, 'a pane cannot fake a Sent receipt');
  assert.deepEqual(await h.hostPost('/api/channel/ack', { seq: wake.seq + 1, boot: wake.boot }), { ok: true, acked: false });
  assert.deepEqual(await h.hostPost('/api/channel/ack', { seq: wake.seq, boot: wake.boot }), { ok: true, acked: true });
  assert.equal(h.state.pendingAck, null);
});

test('the first heartbeat from 222 drains the park targeted at 222', async (t) => {
  const h = await host(t);
  await h.hostPost('/api/channel/heartbeat', { pid: 111 });
  // A message for 222, which has no channel yet: parked at once.
  const m = queue.enqueueMessage(h.state, h.bus, message());
  const r = queue.release(h.state, h.bus, [m.id], { target_pid: 222 });
  assert.equal(r.parked.target_pid, 222);
  assert.equal(queue.drainPending(h.state, h.bus, null), null, 'a consumer connect leaves it');
  // A heartbeat from 111 (already live) does nothing to it.
  await h.hostPost('/api/channel/heartbeat', { pid: 111 });
  assert.ok(h.state.pendingWake);

  await h.hostPost('/api/channel/heartbeat', { pid: 222 });
  assert.equal(h.state.pendingWake, null, 'drained to its own channel');
  const last = wakesIn(h.bus).at(-1);
  assert.equal(last.target_pid, 222);
  assert.deepEqual(last.batch.map((x) => x.id), [m.id]);
  assert.equal(h.state.pendingAck.target_pid, 222, 'retained for its ack');
  // A second heartbeat from 222 drains nothing more.
  const n = wakesIn(h.bus).length;
  await h.hostPost('/api/channel/heartbeat', { pid: 222 });
  assert.equal(wakesIn(h.bus).length, n);
});

test('a heartbeat never folds or overwrites an in-flight wake: the targeted park waits for its ack', async (t) => {
  const h = await host(t);
  await h.hostPost('/api/channel/heartbeat', { pid: 111 });
  const m = queue.enqueueMessage(h.state, h.bus, message());
  queue.release(h.state, h.bus, [m.id], { target_pid: 222 });
  const parkId = h.state.pendingWake.id;
  // Then a live wake to 111, awaiting its ack.
  queue.enqueue(h.state, h.bus, signal());
  const { wake } = queue.flush(h.state, h.bus, { target_pid: 111 });
  assert.equal(wake.target_pid, 111);
  assert.equal(h.state.pendingWake.id, parkId, 'the park is still aimed at 222');
  const inflight = h.state.pendingAck;

  await h.hostPost('/api/channel/heartbeat', { pid: 222 });
  assert.equal(h.state.pendingAck, inflight, '111\'s in-flight wake is kept');
  assert.equal(h.state.pendingWake.id, parkId, 'and nothing was folded into the park');

  await h.hostPost('/api/channel/ack', { seq: wake.seq, boot: wake.boot });
  assert.equal(h.state.pendingAck, null);
  await h.hostPost('/api/channel/heartbeat', { pid: 222 });
  assert.equal(h.state.pendingWake, null, 'the next heartbeat from 222 drains it');
  const last = wakesIn(h.bus).at(-1);
  assert.equal(last.target_pid, 222);
  assert.deepEqual(last.batch.map((x) => x.id), [m.id]);
});

test('a park the user chose (Hold) is not drained by a heartbeat from its already-live target', async (t) => {
  const h = await host(t);
  await h.hostPost('/api/channel/heartbeat', { pid: 111 });
  const m = queue.enqueueMessage(h.state, h.bus, message());
  const { wake } = queue.release(h.state, h.bus, [m.id], { target_pid: 111 });
  assert.equal(wake.target_pid, 111, 'a live target wakes');
  // The rail's ack timed out and the user pressed Hold.
  const held = await h.hostPost('/api/queue/repush', { seq: wake.seq, park: true });
  assert.equal(held.mode, 'parked');
  const parkId = h.state.pendingWake.id;
  assert.equal(h.state.pendingWake.target_pid, 111);
  const n = wakesIn(h.bus).length;

  await h.hostPost('/api/channel/heartbeat', { pid: 111 });
  assert.ok(h.state.pendingWake, 'the held park is still there');
  assert.equal(h.state.pendingWake.id, parkId);
  assert.equal(wakesIn(h.bus).length, n, 'and no new wake went to the channel that failed to ack');
  assert.equal(h.state.pendingAck, null);
});

test('GET /api/queue/pending?pid=: an untargeted park or one at that pid; never another\'s; no pid serves any', async (t) => {
  const h = await host(t, { live: false });
  queue.enqueue(h.state, h.bus, signal());
  queue.flush(h.state, h.bus);
  const untargeted = h.state.pendingWake.id;
  assert.equal((await h.call('GET', '/api/queue/pending?pid=111')).json.pending.id, untargeted);

  h.state.pendingWake = null;
  queue.enqueue(h.state, h.bus, signal(2));
  queue.flush(h.state, h.bus, { target_pid: 111 });
  const at111 = h.state.pendingWake.id;
  assert.equal((await h.call('GET', '/api/queue/pending?pid=111')).json.pending.id, at111);
  assert.equal((await h.call('GET', '/api/queue/pending?pid=222')).json.pending, null);
  assert.equal((await h.call('GET', '/api/queue/pending')).json.pending.id, at111, 'a hook without CLAUDE_PID claims as today');
  assert.equal((await h.call('GET', '/api/queue/pending?pid=nope')).json.pending.id, at111, 'a malformed pid is no pid');
});

test('consume and recall: below full with a message in the park → 403; a signal-only park consumes', async (t) => {
  const h = await host(t, { live: false, optIn: 'read' });
  const m = queue.enqueueMessage(h.state, h.bus, message());
  queue.release(h.state, h.bus, [m.id]);
  const id = h.state.pendingWake.id;
  assert.equal((await h.call('POST', '/api/queue/pending/consume', { id }, { remote: true })).status, 403);
  assert.equal((await h.call('POST', '/api/queue/pending/recall', { id }, { remote: true })).status, 403);
  assert.equal(h.state.pendingWake.id, id, 'the park is untouched');
  h.audience.optIn = 'full';
  const r = await h.call('POST', '/api/queue/pending/recall', { id }, { remote: true });
  assert.deepEqual(r.json, { ok: true, recalled: true, ids: [m.id], pending_id: null });

  h.audience.optIn = 'read';
  queue.enqueue(h.state, h.bus, signal());
  queue.flush(h.state, h.bus, { messages: false });
  const sid = h.state.pendingWake.id;
  assert.deepEqual((await h.call('POST', '/api/queue/pending/recall', { id: sid }, { remote: true })).json, { ok: true, recalled: false });
  assert.deepEqual((await h.call('POST', '/api/queue/pending/consume', { id: sid }, { remote: true })).json, { ok: true, consumed: true });
});

test('POST /api/queue/pending/recall: a stale id answers recalled false; JSON only', async (t) => {
  const h = await host(t, { live: false });
  const m = queue.enqueueMessage(h.state, h.bus, message());
  queue.release(h.state, h.bus, [m.id]);
  assert.deepEqual((await h.call('POST', '/api/queue/pending/recall', { id: 'pw999' })).json, { ok: true, recalled: false });
  assert.deepEqual((await h.call('POST', '/api/queue/pending/recall', {})).json, { ok: true, recalled: false });
  assert.ok(h.state.pendingWake);
  const raw = await fetch(`${h.base}/api/queue/pending/recall`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: h.state.pendingWake.id,
  });
  assert.equal(raw.status, 415);
  const foreign = await fetch(`${h.base}/api/queue/pending/recall`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ id: h.state.pendingWake.id }),
  });
  assert.equal(foreign.status, 403);
  assert.ok(h.state.pendingWake, 'neither took it back');
});

test('POST /api/queue/message send now with a message parked: queued, waiting parked_message', async (t) => {
  const h = await host(t, { live: false });
  const first = await h.call('POST', '/api/queue/message', { text: 'first', send: 'now' });
  assert.equal(first.json.mode, 'parked');
  const second = await h.call('POST', '/api/queue/message', { text: 'second', send: 'now' });
  assert.equal(second.json.mode, 'queued');
  assert.equal(second.json.waiting, 'parked_message');
  const it = h.state.queue.find((q) => q.id === second.json.id);
  assert.equal(it.autosend, true);
  // A Push naming it says the same.
  const push = await h.call('POST', '/api/queue/push', { ids: [it.id] });
  assert.equal(push.json.mode, 'queued');
  assert.equal(push.json.waiting, 'parked_message');
  assert.deepEqual(push.json.waiting_ids, [it.id]);
});

test('with a fake ctx.queueRelease, a message sent now and a push naming it reach send() with mode now and the request\'s provenance', async (t) => {
  const sends = [];
  const queueRelease = {
    send(item, opts) { sends.push({ id: item.id, mode: opts.mode, prov: opts.prov }); return { mode: 'queued', waiting: 'busy' }; },
  };
  const h = await host(t, { queueRelease });
  const r = await h.call('POST', '/api/queue/message', { text: 'now please', send: 'now', device: 'mobile' });
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.mode, 'queued');
  assert.equal(r.json.waiting, 'busy');
  assert.deepEqual(sends, [{ id: r.json.id, mode: 'now', prov: { origin: 'local', device: 'mobile' } }]);
  assert.equal(wakesIn(h.bus).length, 0, 'the route did not release it itself');

  sends.length = 0;
  const p = await h.call('POST', '/api/queue/push', { ids: [r.json.id], device: 'desktop' });
  assert.equal(p.json.ok, true, p.text);
  assert.equal(p.json.mode, 'queued');
  assert.deepEqual(sends, [{ id: r.json.id, mode: 'now', prov: { origin: 'local', device: 'desktop' } }]);
  assert.deepEqual(p.json.sent, [{ id: r.json.id, mode: 'queued', waiting: 'busy' }]);
  assert.equal(wakesIn(h.bus).length, 0);
});

test('without ctx.queueRelease, a push naming a message releases it as today', async (t) => {
  const h = await host(t);
  const m = queue.enqueueMessage(h.state, h.bus, message());
  const s = queue.enqueue(h.state, h.bus, signal());
  const p = await h.call('POST', '/api/queue/push', { ids: [m.id] });
  assert.equal(p.json.mode, 'wake');
  assert.deepEqual(wakesIn(h.bus).at(-1).batch.map((x) => x.id), [m.id, s.id]);
});

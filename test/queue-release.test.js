// U63 — the queue's messages in motion (lib/server/queue-release.js; spec §6.4,
// §6.6): when a message goes (claudeFree, send's table, the turn boundaries),
// to whom (targetFor), and how its receipt moves on (the transcript's
// `delivered`, the unconfirmed timer and CONFIRM_VERIFIED).
//
// Everything runs on a plain state and bus (as test/queue-receipts.test.js
// does), a fake mirror, fake asks and injected timers, so a boundary's 1,500 ms
// and the three-minute rule are fired by hand, never waited for.

const test = require('node:test');
const assert = require('node:assert');
const { createBus } = require('../lib/core/bus');
const queue = require('../lib/server/domain/queue');
const { stopGraph, LOCK_TTL_MS } = require('../lib/server/domain/turns');
const { wakeEnvelope } = require('../lib/channel/envelope');
const {
  createQueueRelease, CONFIRM_VERIFIED, RELEASE_DELAY_MS, UNCONFIRMED_MS,
} = require('../lib/server/queue-release');

const C1 = 'conv-one';
const C2 = 'conv-two';

function freshState({ live = true } = {}) {
  const now = Date.now();
  return {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: live ? 1 : 0, wakeConsumerSeenAt: live ? now : 0,
    pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}

function fakeGraph(t) {
  const graph = { lock: null, active: null, saveMeta() {} };
  t.after(() => stopGraph(graph));
  return graph;
}

function fakeTimers() {
  const all = [];
  return {
    setTimer(fn, ms) {
      const h = { fn, ms, cleared: false, fired: false, unrefd: false, unref() { h.unrefd = true; } };
      all.push(h);
      return h;
    },
    clearTimer(h) { if (h) h.cleared = true; },
    pending() { return all.filter((h) => !h.cleared && !h.fired); },
    fire(ms) {
      for (const h of all.filter((x) => !x.cleared && !x.fired && (ms == null || x.ms === ms))) { h.fired = true; h.fn(); }
    },
    all,
  };
}

// A fake mirror facade: the reads queue-release makes, and a hand-driven
// transition feed.
function fakeMirror({ primary = null, lives = {}, pids = {}, enabled = true } = {}) {
  const subs = new Set();
  return {
    lives, pids,
    primary,
    on: enabled,
    snapshot() { return { primary: this.primary }; },
    liveOf(cid) { return this.lives[cid] || null; },
    conversationOfPid(pid) { return this.pids[pid] || null; },
    enabled() { return { enabled: this.on }; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(e) { for (const fn of [...subs]) fn({ kind: 'mirror', ...e }); },
    subs,
  };
}

const live = (state, pid = null, extra = {}) => ({ state, process: pid ? { pid, alive: true, cpu_pct: 0 } : null, ...extra });

function harness(t, { mirror = fakeMirror(), asks = null, channel = true, confirmVerified } = {}) {
  const state = freshState({ live: channel });
  const bus = createBus({ bootId: 'boot-1' });
  const graph = fakeGraph(t);
  const timers = fakeTimers();
  const opts = { state, bus, graph, mirror, asks, setTimer: timers.setTimer, clearTimer: timers.clearTimer };
  if (confirmVerified !== undefined) opts.confirmVerified = confirmVerified;
  const rel = createQueueRelease(opts);
  rel.start();
  t.after(() => rel.stop());
  return { state, bus, graph, timers, rel, mirror };
}

function enqueue(h, { text = 'hello', conversation_id = C1, autosend = true, staged = true, origin, device } = {}) {
  return queue.enqueueMessage(h.state, h.bus, { text, skill: null, files: [], chars: text.length }, {
    conversation_id, autosend, staged, origin, device,
  });
}

const wakes = (bus) => bus.read({ kinds: ['wake'] }).events;
const queuedIds = (state) => state.queue.map((it) => it.id);
const receiptState = (state, msgId) => (state.messageReceipts.get(msgId) || {}).state;
const graphEvent = (bus, op) => bus.emit({ event: { kind: 'graph', op } });

test('the constants: CONFIRM_VERIFIED stays false until V30 is recorded; 1.5 s; three minutes', () => {
  assert.equal(CONFIRM_VERIFIED, false);
  assert.equal(RELEASE_DELAY_MS, 1500);
  assert.equal(UNCONFIRMED_MS, 180000);
});

// ── claudeFree ──

test('claudeFree: a fresh lock whose claude_pid maps to the conversation is busy; another conversation\'s lock is not', (t) => {
  const mirror = fakeMirror({ pids: { 4242: C1, 5353: C2 } });
  const h = harness(t, { mirror });
  h.graph.lock = { base: null, started_at: Date.now(), message: 'x', author: 'user', session_id: 's-1', claude_pid: 4242 };
  assert.equal(h.rel.claudeFree(C1), false);
  assert.equal(h.rel.claudeFree(C2), true, 'another conversation\'s lock does not count');
  h.graph.lock.claude_pid = 5353;
  assert.equal(h.rel.claudeFree(C1), true);
  assert.equal(h.rel.claudeFree(C2), false);
});

test('claudeFree: a lock with neither session_id nor claude_pid counts for every conversation; a stale one for none', (t) => {
  const h = harness(t, { mirror: fakeMirror({ pids: { 4242: C1 } }) });
  h.graph.lock = { base: null, started_at: Date.now(), message: 'channel wake: 1 signal', author: 'wake' };
  assert.equal(h.rel.claudeFree(C1), false);
  assert.equal(h.rel.claudeFree(C2), false);
  assert.equal(h.rel.claudeFree(null), false);
  h.graph.lock = { base: null, started_at: Date.now() - LOCK_TTL_MS - 1000, message: 'x', author: 'user', claude_pid: 4242 };
  assert.equal(h.rel.claudeFree(C1), true, 'a stale lock is turns.js\'s stale lock, and holds nothing');
  h.graph.lock = { base: null, started_at: Date.now() - LOCK_TTL_MS - 1000, message: 'x', author: 'user' };
  assert.equal(h.rel.claudeFree(C2), true);
});

test('claudeFree: a pending ask for the conversation is busy; one for another is not; no asks is none', (t) => {
  const rows = [];
  const h = harness(t, { asks: { pending: () => rows } });
  assert.equal(h.rel.claudeFree(C1), true);
  rows.push({ id: 'ask_1', conversation_id: C2, state: 'pending' });
  assert.equal(h.rel.claudeFree(C1), true);
  rows.push({ id: 'ask_2', conversation_id: C1, state: 'pending' });
  assert.equal(h.rel.claudeFree(C1), false);
  const none = harness(t, { asks: null });
  assert.equal(none.rel.claudeFree(C1), true);
});

test('claudeFree: live working is busy, live idle is free, and with no mirror it is free', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111), [C2]: live('idle', 222) } });
  const h = harness(t, { mirror });
  assert.equal(h.rel.claudeFree(C1), false);
  assert.equal(h.rel.claudeFree(C2), true);
  for (const s of ['question', 'waiting', 'compacting', 'suspended']) {
    mirror.lives[C1] = live(s, 111);
    assert.equal(h.rel.claudeFree(C1), false, s);
  }
  const bare = harness(t, { mirror: null });
  assert.equal(bare.rel.claudeFree(C1), true);
  assert.equal(bare.rel.claudeFree(null), true);
});

// ── send ──

test('send auto: idle releases now, targeted at the conversation\'s process', (t) => {
  const h = harness(t, { mirror: fakeMirror({ lives: { [C1]: live('idle', 111) } }) });
  const item = enqueue(h);
  const r = h.rel.send(item, { mode: 'auto', prov: { origin: 'local', device: 'desktop' } });
  assert.ok(r.wake, 'woken now');
  assert.equal(r.wake.target_pid, 111);
  assert.deepEqual(queuedIds(h.state), []);
});

test('send auto: unknown (no live state, no mirror) releases now, untargeted', (t) => {
  const h = harness(t, { mirror: null });
  const item = enqueue(h, { conversation_id: null });
  const r = h.rel.send(item, { mode: 'auto', prov: {} });
  assert.ok(r.wake);
  assert.equal(r.wake.target_pid, undefined);
});

test('send auto: while working it stays queued, FIFO per conversation: position 1, then 2', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111), [C2]: live('working', 222) } });
  const h = harness(t, { mirror });
  const a = enqueue(h, { text: 'do X' });
  assert.deepEqual(h.rel.send(a, { mode: 'auto', prov: {} }), { mode: 'queued', position: 1 });
  const other = enqueue(h, { text: 'elsewhere', conversation_id: C2 });
  assert.deepEqual(h.rel.send(other, { mode: 'auto', prov: {} }), { mode: 'queued', position: 1 }, 'another conversation counts its own');
  const b = enqueue(h, { text: 'then Y' });
  assert.deepEqual(h.rel.send(b, { mode: 'auto', prov: {} }), { mode: 'queued', position: 2 });
  assert.deepEqual(queuedIds(h.state), [a.id, other.id, b.id]);
  assert.equal(wakes(h.bus).length, 0);
});

test('send auto: an ended conversation releases now, which parks untargeted for the next prompt', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: { ...live('ended', 111), process: { pid: 111, alive: false } } } });
  const h = harness(t, { mirror, channel: false });
  const item = enqueue(h);
  const r = h.rel.send(item, { mode: 'auto', prov: {} });
  assert.ok(r.parked, 'parked');
  assert.equal(r.parked.target_pid, undefined, 'never aimed at a dead process');
  assert.equal(receiptState(h.state, item.msg_id), 'parked');
});

test('send auto: a process the mirror reports gone releases now as well', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: { state: 'working', process: { pid: 111, alive: false }, evidence: { proc: 'gone' } } } });
  const h = harness(t, { mirror, channel: false });
  const r = h.rel.send(enqueue(h), { mode: 'auto', prov: {} });
  assert.ok(r.parked);
});

// U63b (§6.4's table): "ended, or a process gone → parks it for the next
// prompt typed in the project" — a park, never an untargeted live wake that
// another session's live bridge would run (the double run targeting prevents).
test('send auto and a boundary: a message for a gone process parks and emits no wake while another session\'s channel is live', (t) => {
  const gone = { state: 'working', process: { pid: 111, alive: false }, evidence: { proc: 'gone' } };
  const mirror = fakeMirror({ lives: { [C1]: gone, [C2]: live('idle', 222) }, pids: { 222: C2 } });
  const h = harness(t, { mirror });
  queue.stampChannel(h.state, 222);
  assert.ok(queue.channelLive(h.state), 'the other session\'s channel is live');
  const item = enqueue(h, { text: 'for the gone one' });
  const r = h.rel.send(item, { mode: 'auto', prov: {} });
  assert.ok(r.parked, 'parked');
  assert.equal(r.wake, null);
  assert.equal(r.parked.target_pid, undefined, 'untargeted: the next prompt typed in the project claims it');
  assert.ok(queue.pendingFor(h.state, 222), 'any session\'s next prompt may claim it');
  assert.equal(receiptState(h.state, item.msg_id), 'parked');
  assert.deepEqual(queuedIds(h.state), []);
  // A boundary: an autosend message queued while its conversation worked, which
  // then ended.
  const h2 = harness(t, { mirror: fakeMirror({ lives: { [C1]: live('working', 111), [C2]: live('idle', 222) } }) });
  queue.stampChannel(h2.state, 222);
  const a = enqueue(h2, { text: 'later' });
  assert.deepEqual(h2.rel.send(a, { mode: 'auto', prov: {} }), { mode: 'queued', position: 1 });
  h2.mirror.lives[C1] = { ...live('ended', 111), process: { pid: 111, alive: false } };
  h2.mirror.emit({ op: 'state', conversation_id: C1, state: 'ended', prev: 'working' });
  h2.timers.fire(1500);
  assert.deepEqual(queuedIds(h2.state), []);
  assert.ok(h2.state.pendingWake && h2.state.pendingWake.batch.some((it) => it.id === a.id), 'parked');
  assert.equal(h2.state.pendingWake.target_pid, undefined);
  assert.equal(wakes(h.bus).length + wakes(h2.bus).length, 0, 'no wake reached the live channel');
});

// U63b (§6.4: FIFO per conversation): a send 'auto' while older autosend
// messages of its conversation still wait queues behind them, even when Claude
// is already free (the 1,500 ms before the boundary's timer, or a missed
// boundary), and the boundaries release all of them in order.
test('send auto: a third auto send before the boundary timer queues at position 3; the three release in order', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111) } });
  const h = harness(t, { mirror });
  const a = enqueue(h, { text: 'do X' });
  const b = enqueue(h, { text: 'then Y' });
  assert.deepEqual(h.rel.send(a, { mode: 'auto', prov: {} }), { mode: 'queued', position: 1 });
  assert.deepEqual(h.rel.send(b, { mode: 'auto', prov: {} }), { mode: 'queued', position: 2 });
  mirror.lives[C1] = live('idle', 111);
  mirror.emit({ op: 'state', conversation_id: C1, state: 'idle', prev: 'working' });
  assert.equal(h.timers.pending().length, 1, 'the boundary armed its timer');
  const timer = h.timers.pending()[0];
  assert.equal(h.rel.claudeFree(C1), true, 'Claude is free before the timer fires');
  const c = enqueue(h, { text: 'and Z' });
  assert.deepEqual(h.rel.send(c, { mode: 'auto', prov: {} }), { mode: 'queued', position: 3 });
  assert.equal(wakes(h.bus).length, 0, 'nothing overtook the queue');
  assert.deepEqual(h.timers.pending(), [timer], 'the pending timer is not re-armed (no added delay)');
  const order = [];
  for (let i = 0; i < 3; i += 1) {
    h.graph.lock = null;
    if (i > 0) graphEvent(h.bus, 'unlock');
    h.timers.fire(1500);
    const w = wakes(h.bus);
    order.push(w[w.length - 1].batch.map((it) => it.id).join('+'));
  }
  assert.deepEqual(order, [a.id, b.id, c.id], 'released in order, one per boundary');
  assert.deepEqual(queuedIds(h.state), []);
  // A missed boundary: free, an older message waiting and no timer armed — the
  // new one still queues behind it, and send arms the timer that releases them.
  const m = harness(t, { mirror: fakeMirror({ lives: { [C1]: live('working', 111) } }) });
  const old = enqueue(m, { text: 'old' });
  m.rel.send(old, { mode: 'auto', prov: {} });
  m.mirror.lives[C1] = live('idle', 111);
  const next = enqueue(m, { text: 'new' });
  assert.deepEqual(m.rel.send(next, { mode: 'auto', prov: {} }), { mode: 'queued', position: 2 });
  assert.equal(m.timers.pending().length, 1, 'send armed the boundary timer itself');
  m.timers.fire(1500);
  assert.deepEqual(queuedIds(m.state), [next.id], 'the older one went first');
});

test('send now: while working it is released at once, targeted', (t) => {
  const h = harness(t, { mirror: fakeMirror({ lives: { [C1]: live('working', 111) } }) });
  h.graph.lock = { base: null, started_at: Date.now(), message: 'x', author: 'user', claude_pid: 111 };
  const r = h.rel.send(enqueue(h), { mode: 'now', prov: { origin: 'remote', device: 'mobile' } });
  assert.ok(r.wake);
  assert.equal(r.wake.target_pid, 111);
  assert.equal(r.wake.origin, 'remote');
  assert.equal(r.wake.device, 'mobile');
});

// U63b (§6.4's table, for Send now as for autosend): a conversation that has
// ended, or whose process is gone, parks the message for the next prompt typed
// in the project — never an untargeted live wake another session would run.
test('send now: a message for a gone process parks and emits no wake while another session\'s channel is live', (t) => {
  const gone = { state: 'working', process: { pid: 111, alive: false }, evidence: { proc: 'gone' } };
  for (const c1 of [gone, { ...live('ended', 111), process: { pid: 111, alive: false } }, live('ended')]) {
    const mirror = fakeMirror({ lives: { [C1]: c1, [C2]: live('idle', 222) }, pids: { 222: C2 } });
    const h = harness(t, { mirror });
    queue.stampChannel(h.state, 222);
    assert.ok(queue.channelLive(h.state), 'the other session\'s channel is live');
    const item = enqueue(h, { text: 'for the gone one' });
    const r = h.rel.send(item, { mode: 'now', prov: {} });
    assert.ok(r.parked, `parked (${c1.state})`);
    assert.equal(r.wake, null);
    assert.equal(r.parked.target_pid, undefined, 'untargeted: the next prompt typed in the project claims it');
    assert.ok(queue.pendingFor(h.state, 222), 'any session\'s next prompt may claim it');
    assert.equal(receiptState(h.state, item.msg_id), 'parked');
    assert.deepEqual(queuedIds(h.state), []);
    assert.equal(wakes(h.bus).length, 0, 'no wake reached the live channel');
  }
});

// ── boundaries ──

test('a graph turn-end arms one 1,500 ms timer, then releases only the oldest autosend message', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111) } });
  const h = harness(t, { mirror });
  const a = enqueue(h, { text: 'do X' });
  const b = enqueue(h, { text: 'then Y' });
  h.rel.send(a, { mode: 'auto', prov: {} });
  h.rel.send(b, { mode: 'auto', prov: {} });
  mirror.lives[C1] = live('idle', 111);
  graphEvent(h.bus, 'turn-end');
  assert.equal(h.timers.pending().length, 1);
  assert.equal(h.timers.pending()[0].ms, 1500);
  assert.ok(h.timers.pending()[0].unrefd, 'unref\'d');
  assert.equal(wakes(h.bus).length, 0, 'nothing before the delay');
  h.timers.fire(1500);
  assert.deepEqual(queuedIds(h.state), [b.id], 'one per boundary: the oldest went');
  assert.equal(wakes(h.bus).length, 1);
  assert.equal(wakes(h.bus)[0].target_pid, 111);
  // The wake took a (session-less) lock: the next boundary waits for its unlock.
  graphEvent(h.bus, 'turn-skipped');
  h.timers.fire(1500);
  assert.deepEqual(queuedIds(h.state), [b.id], 'still busy under the wake turn');
  h.graph.lock = null;
  graphEvent(h.bus, 'unlock');
  h.timers.fire(1500);
  assert.deepEqual(queuedIds(h.state), [], 'then Y');
});

test('a boundary whose conversation is still busy when the timer fires releases nothing', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111) } });
  const h = harness(t, { mirror });
  const a = enqueue(h);
  h.rel.send(a, { mode: 'auto', prov: {} });
  graphEvent(h.bus, 'turn-end');
  h.timers.fire(1500);
  assert.deepEqual(queuedIds(h.state), [a.id]);
  assert.equal(wakes(h.bus).length, 0);
});

test('a held message never autosends', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  const h = harness(t, { mirror });
  const held = enqueue(h, { staged: false, autosend: false });
  const held2 = enqueue(h, { staged: false, autosend: true });
  graphEvent(h.bus, 'turn-end');
  h.timers.fire();
  mirror.emit({ op: 'state', conversation_id: C1, state: 'idle', prev: 'working' });
  h.timers.fire();
  assert.deepEqual(queuedIds(h.state), [held.id, held2.id]);
  assert.equal(wakes(h.bus).length, 0);
});

test('unlock, turn-skipped and a mirror transition to idle each trigger a release', (t) => {
  for (const trigger of ['unlock', 'turn-skipped', 'idle']) {
    const mirror = fakeMirror({ lives: { [C1]: live('working', 111) } });
    const h = harness(t, { mirror });
    const a = enqueue(h);
    h.rel.send(a, { mode: 'auto', prov: {} });
    mirror.lives[C1] = live('idle', 111);
    if (trigger === 'idle') mirror.emit({ op: 'state', conversation_id: C1, state: 'idle', prev: 'working' });
    else graphEvent(h.bus, trigger);
    assert.equal(h.timers.pending().length, 1, trigger);
    h.timers.fire(1500);
    assert.deepEqual(queuedIds(h.state), [], `${trigger} released it`);
  }
});

test('a mirror idle transition for another conversation arms nothing for this one', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111), [C2]: live('idle', 222) } });
  const h = harness(t, { mirror });
  h.rel.send(enqueue(h), { mode: 'auto', prov: {} });
  mirror.emit({ op: 'state', conversation_id: C2, state: 'idle', prev: 'working' });
  assert.equal(h.timers.pending().length, 0);
});

test('a message waiting for the park (waiting: parked_message) is released at the next idle', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  const h = harness(t, { mirror, channel: false });
  const first = enqueue(h, { text: 'first' });
  const second = enqueue(h, { text: 'second', staged: false, autosend: false });
  h.rel.send(first, { mode: 'now', prov: {} });
  const r = h.rel.send(second, { mode: 'now', prov: {} });
  assert.deepEqual(r.heldBack, [second.id], 'one message per park');
  assert.equal(second.waiting, 'parked_message');
  // The turn-begin hook claims the park; the turn runs; the conversation idles.
  assert.ok(queue.consumePending(h.state, h.state.pendingWake.id, { bus: h.bus, host: true }));
  mirror.emit({ op: 'state', conversation_id: C1, state: 'idle', prev: 'working' });
  h.timers.fire(1500);
  assert.deepEqual(queuedIds(h.state), []);
  assert.ok(h.state.pendingWake && h.state.pendingWake.batch.some((it) => it.id === second.id), 'parked in its turn');
  assert.ok(!h.state.pendingWake.batch.some((it) => 'waiting' in it), 'waiting is cleared on release');
});

test('provenance: an autosend release carries the message\'s own origin and device into its envelope', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111) } });
  const h = harness(t, { mirror });
  const a = enqueue(h, { origin: 'remote', device: 'mobile' });
  h.rel.send(a, { mode: 'auto', prov: { origin: 'remote', device: 'mobile' } });
  mirror.lives[C1] = live('idle', 111);
  graphEvent(h.bus, 'turn-end');
  h.timers.fire(1500);
  const [w] = wakes(h.bus);
  const env = wakeEnvelope(w.batch, { reason: w.reason, source: w.source, seq: w.seq, note: w.note, origin: w.origin, device: w.device });
  assert.match(env.content, /Pushed from: origin=remote device=mobile/);
});

test('provenance: a parked autosend release keeps the message\'s origin and device too', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111) } });
  const h = harness(t, { mirror, channel: false });
  const a = enqueue(h, { origin: 'remote', device: 'mobile' });
  h.rel.send(a, { mode: 'auto', prov: {} });
  mirror.lives[C1] = live('idle', 111);
  graphEvent(h.bus, 'unlock');
  h.timers.fire(1500);
  assert.match(h.state.pendingWake.envelope.content, /Pushed from: origin=remote device=mobile/);
});

// ── targeting ──

test('targetFor: one live pid for the whole batch, else none', (t) => {
  const mirror = fakeMirror({ primary: C1, lives: { [C1]: live('idle', 111), [C2]: live('idle', 222), c3: live('idle') } });
  const h = harness(t, { mirror });
  const a = enqueue(h, { conversation_id: C1 });
  const b = enqueue(h, { conversation_id: C2 });
  const p = enqueue(h, { conversation_id: null });
  const none = enqueue(h, { conversation_id: 'c3' });
  assert.equal(h.rel.targetFor([a]), 111);
  assert.equal(h.rel.targetFor([a, p]), 111, 'no conversation_id → the primary');
  assert.equal(h.rel.targetFor([a, b]), null, 'two conversations, two pids: untargeted');
  assert.equal(h.rel.targetFor([none]), null, 'unknown pid: none');
  assert.equal(h.rel.targetFor([enqueue(h, { conversation_id: 'nobody' })]), null);
  assert.equal(h.rel.targetFor([]), null);
  mirror.lives[C1] = { ...live('ended', 111), process: { pid: 111, alive: false } };
  assert.equal(h.rel.targetFor([a]), null, 'never a gone process');
});

test('a release with an unknown pid carries no target_pid', (t) => {
  const h = harness(t, { mirror: fakeMirror({ lives: { [C1]: live('idle') } }) });
  const r = h.rel.send(enqueue(h), { mode: 'auto', prov: {} });
  assert.ok(r.wake);
  assert.ok(!('target_pid' in r.wake));
});

test('targeting is best effort while no bridge reports a pid (lenient), and strict once one does', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  // No pid reported: the targeted release wakes (every old bridge would take it).
  const lenient = harness(t, { mirror });
  const r1 = lenient.rel.send(enqueue(lenient), { mode: 'now', prov: {} });
  assert.ok(r1.wake, 'woken');
  assert.equal(r1.wake.target_pid, 111);
  // Another process's bridge reported its pid: the target has no live channel, so it parks for it.
  const strict = harness(t, { mirror });
  queue.stampChannel(strict.state, 222);
  const r2 = strict.rel.send(enqueue(strict), { mode: 'now', prov: {} });
  assert.ok(r2.parked, 'parked');
  assert.equal(r2.parked.target_pid, 111);
  assert.equal(queue.pendingFor(strict.state, 222), null, 'the other process cannot claim it');
  assert.ok(queue.pendingFor(strict.state, 111));
  // The target's own bridge reported: it wakes.
  const own = harness(t, { mirror });
  queue.stampChannel(own.state, 111);
  const r3 = own.rel.send(enqueue(own), { mode: 'now', prov: {} });
  assert.ok(r3.wake);
  assert.equal(r3.wake.target_pid, 111);
});

// ── receipts ──

function parkAndHandOver(h, msgOpts = {}) {
  const item = enqueue(h, msgOpts);
  h.rel.send(item, { mode: 'now', prov: {} });
  assert.equal(receiptState(h.state, item.msg_id), 'parked');
  assert.ok(queue.consumePending(h.state, h.state.pendingWake.id, { bus: h.bus, host: true }));
  assert.equal(receiptState(h.state, item.msg_id), 'handed_over');
  return item;
}

test('receipts: the mirror\'s delivered transition confirms the message its marker names', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  const h = harness(t, { mirror, channel: false });
  const item = parkAndHandOver(h);
  mirror.emit({ op: 'delivered', conversation_id: C1, via: 'parked', marker: item.msg_id });
  assert.equal(receiptState(h.state, item.msg_id), 'confirmed');
  assert.equal(h.timers.pending().filter((x) => x.ms === UNCONFIRMED_MS).length, 0, 'its timer is cleared');
  mirror.emit({ op: 'delivered', conversation_id: C1, via: 'parked', marker: 'm-00000000' });
});

test('receipts: handed_over for three minutes while the mirror tails the conversation turns unconfirmed', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  const h = harness(t, { mirror, channel: false });
  const item = parkAndHandOver(h);
  const armed = h.timers.pending().filter((x) => x.ms === UNCONFIRMED_MS);
  assert.equal(armed.length, 1);
  assert.ok(armed[0].unrefd);
  h.timers.fire(UNCONFIRMED_MS);
  assert.equal(receiptState(h.state, item.msg_id), 'unconfirmed');
});

test('receipts: not tailing (mirror off, no live object, or ended) leaves handed_over alone', (t) => {
  for (const setup of [
    (m) => { m.on = false; },
    (m) => { delete m.lives[C1]; },
    (m) => { m.lives[C1] = live('ended', 111); },
  ]) {
    const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
    const h = harness(t, { mirror, channel: false });
    const item = parkAndHandOver(h);
    setup(mirror);
    h.timers.fire(UNCONFIRMED_MS);
    assert.equal(receiptState(h.state, item.msg_id), 'handed_over');
  }
  const bare = harness(t, { mirror: null, channel: false });
  const item = parkAndHandOver(bare, { conversation_id: null });
  bare.timers.fire(UNCONFIRMED_MS);
  assert.equal(receiptState(bare.state, item.msg_id), 'handed_over', 'no mirror, no false alarm');
});

function sendAndAck(h) {
  const item = enqueue(h);
  const r = h.rel.send(item, { mode: 'now', prov: {} });
  assert.ok(r.wake);
  assert.ok(queue.ackWake(h.state, h.bus, r.wake.seq, r.wake.boot));
  assert.equal(receiptState(h.state, item.msg_id), 'sent');
  return item;
}

test('receipts: sent for three minutes stays sent while CONFIRM_VERIFIED is false', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  const h = harness(t, { mirror });
  const item = sendAndAck(h);
  assert.equal(h.timers.pending().filter((x) => x.ms === UNCONFIRMED_MS).length, 0, 'no timer is even armed');
  h.timers.fire();
  assert.equal(receiptState(h.state, item.msg_id), 'sent');
});

test('receipts: with confirmVerified, sent for three minutes while tailing turns unconfirmed', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  const h = harness(t, { mirror, confirmVerified: true });
  const item = sendAndAck(h);
  h.timers.fire(UNCONFIRMED_MS);
  assert.equal(receiptState(h.state, item.msg_id), 'unconfirmed');
});

test('receipts: a receipt that moved on before the timer fired is left as it is', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('idle', 111) } });
  const h = harness(t, { mirror, channel: false });
  const item = parkAndHandOver(h);
  const timer = h.timers.pending().find((x) => x.ms === UNCONFIRMED_MS);
  queue.confirmDelivered(h.state, h.bus, item.msg_id);
  assert.ok(timer.cleared, 'the move cleared it');
  timer.fn();
  assert.equal(receiptState(h.state, item.msg_id), 'confirmed');
});

test('stop() leaves no timer and no subscription', (t) => {
  const mirror = fakeMirror({ lives: { [C1]: live('working', 111) } });
  const h = harness(t, { mirror, channel: false });
  h.rel.send(enqueue(h), { mode: 'auto', prov: {} });
  graphEvent(h.bus, 'turn-end');
  const handed = parkAndHandOver(h, { conversation_id: C2 });
  assert.ok(h.timers.pending().length >= 2);
  assert.equal(mirror.subs.size, 1);
  h.rel.stop();
  assert.equal(h.timers.pending().length, 0, 'every timer cleared');
  assert.equal(mirror.subs.size, 0, 'the mirror subscription is gone');
  graphEvent(h.bus, 'turn-end');
  mirror.emit({ op: 'state', conversation_id: C1, state: 'idle' });
  mirror.emit({ op: 'delivered', conversation_id: C2, via: 'parked', marker: handed.msg_id });
  assert.equal(h.timers.pending().length, 0, 'nothing arms after stop');
  assert.equal(receiptState(h.state, handed.msg_id), 'handed_over', 'a delivered transition after stop confirms nothing');
  h.rel.stop();
});

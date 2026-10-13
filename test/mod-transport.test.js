// U91 — the composer on the mod: lib/server/mod-transport.js (spec §15.7,
// §6.1's transport seam, §6.5's block, §6.6's receipts).
//
// The transport on a fake bridge (enqueue + sessionOf, as U87's
// lib/server/domain/bridge answers them) and a fake mirror, then through the
// REAL queue domain (deliver's seam, flush, park) with state.messageTransport
// set to it. No `claude`, no mod, no daemon.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createBus } = require('../lib/core/bus');
const queue = require('../lib/server/domain/queue');
const { createModTransport, withModCommands } = require('../lib/server/mod-transport');
const { mountSkillsRoutes } = require('../lib/server/routes/skills');
const { wakeEnvelope } = require('../lib/channel/envelope');
const { messageMarker } = require('../lib/core/prompt-class');
const { validateOp } = require('../lib/core/mod-protocol');

const SID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const SID2 = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

function freshState({ live = false } = {}) {
  return {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: live ? 1 : 0, wakeConsumerSeenAt: live ? Date.now() : 0,
    pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}
const newBus = () => createBus({ bootId: 'boot-u91' });
const wakesIn = (bus) => bus.read({ kinds: ['wake'] }).events;
const receiptsIn = (bus, msgId) => bus.read({ kinds: ['queue'] }).events.filter((e) => e.op === 'receipt' && e.msg_id === msgId).map((e) => e.state);
const receiptOf = (state, msgId) => (state.messageReceipts instanceof Map ? (state.messageReceipts.get(msgId) || {}).state : undefined);

// A fake bridge: sessionOf from a map of conversation → session, enqueue
// recording every op and answering `answer` (a value, or a function of the op).
function fakeBridge({ sessions = { c1: SID }, answer = { ok: true, result: {} } } = {}) {
  const ops = [];
  return {
    ops,
    sessions,
    sessionOf(cid) { return Object.prototype.hasOwnProperty.call(this.sessions, cid) ? this.sessions[cid] : null; },
    enqueue(sid, op) {
      ops.push({ sid, ...op });
      const a = typeof answer === 'function' ? answer(op) : answer;
      return a && typeof a.then === 'function' ? a : Promise.resolve(a);
    },
  };
}
function fakeMirror({ primary = 'c1', pid = null } = {}) {
  return {
    snapshot: () => ({ primary }),
    liveOf: () => (pid ? { process: { pid } } : null),
  };
}

// A message item through the real domain.
function enqueue(state, bus, over = {}, prov = { origin: 'local', device: 'desktop' }) {
  return queue.enqueueMessage(state, bus, {
    text: 'Tighten the retry logic.', skill: null, files: [], chars: 24, conversation_id: 'c1', ...over,
  }, prov);
}
const settle = () => new Promise((r) => setImmediate(r));

test('a message for a mod-attached conversation is one submit op of the marked block, taken by the mod', async () => {
  const state = freshState();
  const bus = newBus();
  const bridge = fakeBridge();
  const t = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
  const item = enqueue(state, bus, { text: '/not-a-command but text\nsecond line' }, { origin: 'remote', device: 'mobile' });
  assert.deepEqual(t(item), { via: 'mod' });
  assert.equal(bridge.ops.length, 1);
  const [op] = bridge.ops;
  assert.equal(op.sid, SID);
  assert.equal(op.op, 'submit');
  assert.deepEqual(Object.keys(op.args), ['text']);
  const text = op.args.text;
  assert.equal(text, wakeEnvelope([item], { origin: 'remote', device: 'mobile' }).content);
  assert.ok(text.includes(messageMarker(item.msg_id)), 'the marker');
  assert.ok(text.startsWith('Pushed from: origin=remote device=mobile\n'), 'the provenance line opens it');
  assert.ok(!text.trimStart().startsWith('/'), 'never a / text');
  assert.ok(text.includes('> /not-a-command but text\n> second line'), 'the quoted block');
  assert.equal(validateOp('submit', op.args).ok, true);
});

test('a message with no provenance still never begins with /, and a text that is a command but carries a skill or files is submitted', async () => {
  const state = freshState();
  const bus = newBus();
  const bridge = fakeBridge();
  const t = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
  const bare = enqueue(state, bus, { text: '/plan' }, {});
  bare.skill = { name: 'review', args: '' };
  assert.deepEqual(t(bare), { via: 'mod' });
  const filed = enqueue(state, bus, { text: '/compact', files: [{ path: 'a.js', bytes: 3 }] }, {});
  assert.deepEqual(t(filed), { via: 'mod' });
  assert.deepEqual(bridge.ops.map((o) => o.op), ['submit', 'submit']);
  for (const o of bridge.ops) {
    assert.ok(!o.args.text.trimStart().startsWith('/'));
    assert.equal(validateOp('submit', o.args).ok, true);
  }
});

test('a safe command with no skill and no files is one command op', async () => {
  const state = freshState();
  const bus = newBus();
  const bridge = fakeBridge();
  const t = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
  for (const text of ['/compact', '/context', '/recap', '/Rename  v40 test ']) assert.deepEqual(t(enqueue(state, bus, { text })), { via: 'mod' });
  assert.deepEqual(bridge.ops.map(({ op, args }) => ({ op, args })), [
    { op: 'command', args: { name: 'compact', args: '' } },
    { op: 'command', args: { name: 'context', args: '' } },
    { op: 'command', args: { name: 'recap', args: '' } },
    { op: 'command', args: { name: 'rename', args: 'v40 test' } },
  ]);
  // '/plan open': one command op where the mod's protocol takes args for
  // plan; declined (the channel or the park) where it does not.
  const before = bridge.ops.length;
  const r = t(enqueue(state, bus, { text: '/plan open' }));
  if (validateOp('command', { name: 'plan', args: 'open' }).ok) {
    assert.deepEqual(r, { via: 'mod' });
    assert.deepEqual(bridge.ops.slice(before).map(({ op, args }) => ({ op, args })), [{ op: 'command', args: { name: 'plan', args: 'open' } }]);
  } else {
    assert.equal(r, null);
    assert.equal(bridge.ops.length, before);
  }
});

test('declined: a task-stop, no attached session, a sessionOf that throws, a non-message, an enqueue that throws', async () => {
  const state = freshState();
  const bus = newBus();
  const bridge = fakeBridge({ sessions: { c1: SID } });
  const t = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
  const stop = queue.enqueueMessage(state, bus, { text: '', skill: null, files: [], chars: 0, conversation_id: 'c1' }, { source: 'task-stop', task_id: 'bdz1n2' });
  assert.equal(t(stop), null);
  assert.equal(t(enqueue(state, bus, { conversation_id: 'c2' })), null);
  assert.equal(t({ kind: 'signal', id: 'q1' }), null);
  assert.equal(t(null), null);
  const throwing = createModTransport({ bridge: { ...bridge, sessionOf() { throw new Error('boom'); }, enqueue: bridge.enqueue }, mirror: fakeMirror(), state, bus });
  assert.equal(throwing(enqueue(state, bus)), null);
  const badEnqueue = createModTransport({ bridge: { sessionOf: () => SID, enqueue() { throw new Error('boom'); } }, mirror: fakeMirror(), state, bus });
  assert.equal(badEnqueue(enqueue(state, bus)), null);
  const notAPromise = createModTransport({ bridge: { sessionOf: () => SID, enqueue: () => ({ ok: true }) }, mirror: fakeMirror(), state, bus });
  assert.equal(notAPromise(enqueue(state, bus)), null);
  assert.equal(bridge.ops.length, 0);
});

test('conversation_id null follows the primary; a snapshot that throws or answers a Promise gives none', async () => {
  const state = freshState();
  const bus = newBus();
  const bridge = fakeBridge({ sessions: { c1: SID, c9: SID2 } });
  const t = createModTransport({ bridge, mirror: fakeMirror({ primary: 'c9' }), state, bus });
  assert.deepEqual(t(enqueue(state, bus, { conversation_id: null })), { via: 'mod' });
  assert.equal(bridge.ops[0].sid, SID2);
  for (const mirror of [{ snapshot() { throw new Error('x'); } }, { snapshot: async () => ({ primary: 'c9' }) }, null]) {
    const u = createModTransport({ bridge, mirror, state, bus });
    assert.equal(u(enqueue(state, bus, { conversation_id: null })), null);
  }
});

test('the function never throws, whatever it is handed', () => {
  const state = freshState();
  const bus = newBus();
  const t = createModTransport({ bridge: fakeBridge(), mirror: fakeMirror(), state, bus });
  const hostile = { kind: 'message', get msg_id() { throw new Error('boom'); } };
  for (const v of [undefined, 0, 'x', [], {}, { kind: 'message' }, hostile, { kind: 'message', msg_id: 'm-00000000', text: 7 }]) {
    assert.doesNotThrow(() => t(v));
  }
  assert.throws(() => createModTransport({}), TypeError);
});

test('through the real queue domain: transported, receipts queued → sending → sent, no wake and no park', async () => {
  const state = freshState({ live: true });
  const bus = newBus();
  const bridge = fakeBridge();
  state.messageTransport = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
  const item = enqueue(state, bus);
  const r = queue.release(state, bus, [item.id], { origin: 'local', device: 'desktop' });
  assert.deepEqual(r.transported, [{ id: item.id, via: 'mod' }]);
  assert.equal(r.wake, null);
  assert.equal(r.parked, null);
  assert.equal(wakesIn(bus).length, 0);
  assert.equal(state.pendingWake, null);
  assert.equal(state.queue.length, 0);
  await settle();
  assert.deepEqual(receiptsIn(bus, item.msg_id), ['queued', 'sending', 'sent']);
  assert.equal(bridge.ops.length, 1);
});

test('a declined item wakes or parks exactly as without a transport', async () => {
  for (const live of [true, false]) {
    const state = freshState({ live });
    const bus = newBus();
    const bridge = fakeBridge({ sessions: {} });
    state.messageTransport = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
    const item = enqueue(state, bus);
    const r = queue.release(state, bus, [item.id], { origin: 'local', device: 'desktop' });
    assert.deepEqual(r.transported, []);
    if (live) {
      assert.ok(r.wake, 'a live channel wakes');
      assert.equal(r.parked, null);
      assert.equal(receiptOf(state, item.msg_id), 'sending');
    } else {
      assert.equal(r.wake, null);
      assert.ok(r.parked, 'no channel parks');
      assert.equal(receiptOf(state, item.msg_id), 'parked');
    }
    assert.equal(bridge.ops.length, 0);
  }
});

test('the mod never had it ({ok:false, delivered:false}): delivered once more through the domain, declined, and parked', async () => {
  for (const refused of ['timeout', 'queue-full', 'not-attached', 'detached', 'stopped']) {
    const state = freshState({ live: false });
    const bus = newBus();
    const bridge = fakeBridge({ answer: { ok: false, refused, hint: 'h', delivered: false } });
    state.messageTransport = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
    const item = enqueue(state, bus);
    const r = queue.release(state, bus, [item.id], {});
    assert.deepEqual(r.transported, [{ id: item.id, via: 'mod' }]);
    assert.equal(state.pendingWake, null);
    await settle();
    assert.ok(state.pendingWake, `${refused}: parked`);
    assert.deepEqual(state.pendingWake.batch.map((it) => it.msg_id), [item.msg_id]);
    assert.equal(wakesIn(bus).length, 0);
    assert.equal(bridge.ops.length, 1, 'offered to the mod once only');
  }
});

test('a rejected enqueue falls back too; a live channel wakes it with the item\'s provenance', async () => {
  const state = freshState({ live: true });
  const bus = newBus();
  const bridge = fakeBridge({ answer: () => Promise.reject(new Error('gone')) });
  state.messageTransport = createModTransport({ bridge, mirror: fakeMirror(), state, bus, graph: { lock: null, active: 'n0', saveMeta() {} } });
  const item = enqueue(state, bus, {}, { origin: 'remote', device: 'mobile' });
  queue.release(state, bus, [item.id], { origin: 'local', device: 'desktop' });
  await settle();
  const [wake] = wakesIn(bus);
  assert.ok(wake, 'woken');
  assert.equal(wake.reason, 'mod-fallback');
  assert.equal(wake.origin, 'remote');
  assert.equal(wake.device, 'mobile');
  assert.deepEqual(wake.batch.map((it) => it.msg_id), [item.msg_id]);
});

// The receipt of a handed-back message. lib/server/domain/queue.js's receipt
// graph (RECEIPT_NEXT) has no step out of 'sent' but confirmed/unconfirmed, so
// the fallback's sending/parked and a failed command's 'failed' are ignored
// and the receipt stays 'sent' (U91's hand-off, open issue 1: a queue.js
// change no tranche-6 cell holds). These are the behaviour the brief asks for.
test('the fallback\'s receipt goes back through the delivery\'s states', { todo: 'needs queue.js RECEIPT_NEXT sent → sending | parked | failed (U91 open issue 1)' }, async () => {
  const state = freshState({ live: false });
  const bus = newBus();
  state.messageTransport = createModTransport({ bridge: fakeBridge({ answer: { ok: false, refused: 'timeout', delivered: false } }), mirror: fakeMirror(), state, bus });
  const item = enqueue(state, bus);
  queue.release(state, bus, [item.id], {});
  await settle();
  assert.equal(receiptOf(state, item.msg_id), 'parked');
});

test('a failed command op is marked failed', { todo: 'needs queue.js RECEIPT_NEXT sent → failed (U91 open issue 1)' }, async () => {
  const state = freshState({ live: true });
  const bus = newBus();
  state.messageTransport = createModTransport({ bridge: fakeBridge({ answer: { ok: false, refused: 'failed', delivered: true } }), mirror: fakeMirror(), state, bus });
  const item = enqueue(state, bus, { text: '/compact' });
  queue.release(state, bus, [item.id], {});
  await settle();
  assert.equal(receiptOf(state, item.msg_id), 'failed');
});

test('handed out with no result ({ok:false, delivered:true}): the receipt stays sent, nothing re-sent', async () => {
  const state = freshState({ live: true });
  const bus = newBus();
  const bridge = fakeBridge({ answer: { ok: false, refused: 'no-result', delivered: true } });
  state.messageTransport = createModTransport({ bridge, mirror: fakeMirror(), state, bus });
  const item = enqueue(state, bus);
  queue.release(state, bus, [item.id], {});
  await settle();
  assert.equal(receiptOf(state, item.msg_id), 'sent');
  assert.equal(wakesIn(bus).length, 0);
  assert.equal(state.pendingWake, null);
});

test('a command op that fails is never re-sent through the channel or the park', async () => {
  for (const answer of [{ ok: false, refused: 'timeout', delivered: false }, { ok: false, refused: 'failed', delivered: true }]) {
    const state = freshState({ live: true });
    const bus = newBus();
    const bridge = fakeBridge({ answer });
    const logs = [];
    state.messageTransport = createModTransport({ bridge, mirror: fakeMirror(), state, bus, log: (m) => logs.push(m) });
    const item = enqueue(state, bus, { text: '/compact' });
    queue.release(state, bus, [item.id], {});
    await settle();
    assert.equal(wakesIn(bus).length, 0, 'no wake');
    assert.equal(state.pendingWake, null, 'no park');
    assert.equal(bridge.ops.length, 1);
    assert.ok(logs.some((l) => /\/compact/.test(l)), 'logged');
  }
});

test('withModCommands: the catalog answers as before; modCommands follows the bridge registry', async (t) => {
  const catalog = {
    calls: [],
    catalog(cid) { this.calls.push(['catalog', cid]); return { conversation: cid || 'c1', source: 'session', partial: false, skills: [{ name: 'review', description: 'r', origin: 'project' }] }; },
    resolve(name, opts) { this.calls.push(['resolve', name, opts]); return name === 'review' ? 'skill' : null; },
    lookup(name) { return { kind: name === 'review' ? 'skill' : 'unknown' }; },
    clear() { this.calls.push(['clear']); },
  };
  const bridge = fakeBridge({ sessions: { c1: SID } });
  const wrapped = withModCommands(catalog, { bridge, mirror: fakeMirror({ primary: 'c1' }) });
  assert.equal(await wrapped.resolve('review', { conversation_id: 'c1' }), 'skill');
  assert.deepEqual(await wrapped.lookup('review'), { kind: 'skill' });
  wrapped.clear();
  assert.equal(await wrapped.modCommands('c1'), true);
  assert.equal(await wrapped.modCommands(null), true, 'the primary');
  assert.equal(await wrapped.modCommands('c2'), false);
  bridge.sessions = {};
  assert.equal(await wrapped.modCommands('c1'), false, 'detached');
  bridge.sessions = { c2: SID2 };
  assert.equal(await wrapped.modCommands('c2'), true, 'attached later');
  const throwing = withModCommands(catalog, { bridge: { sessionOf() { throw new Error('x'); } }, mirror: null });
  assert.equal(await throwing.modCommands('c1'), false);
  assert.equal(await throwing.modCommands(null), false, 'no mirror, no primary');
  assert.equal('lookup' in withModCommands({ catalog: catalog.catalog }, { bridge }), false, 'only what the catalog has');

  // The /api/skills route on a bare app answers the same through either.
  const answers = [];
  for (const skills of [catalog, wrapped]) {
    const app = express();
    app.use(express.json());
    const audience = { requireMirror: () => (req, res, next) => next(), levelOf: () => 'local' };
    mountSkillsRoutes(app, { skills, audience, mirror: { ready: Promise.resolve(), enabled: () => ({ enabled: true }) } });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/skills?conversation=c1`);
    answers.push({ status: res.status, body: await res.json() });
  }
  assert.deepEqual(answers[1], answers[0]);
});

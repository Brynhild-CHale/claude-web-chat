// Control on the mod (lib/server/control/mod.js, U89; spec §15.2 path 1, §6.9
// 'Ruled (Q7, Q-H)', §15.6 'In place'; rulings Q-B, Q-C, Q-E, B2 (a), F6,
// C-defaults (a)), driven through a REAL createControl (whose createInterrupt is
// the real one) with a fake bridge standing in for ctx.bridge (U87) and a fake
// mirror facade — nothing here runs `claude`:
//   * the interrupt's mod path: an attached session and mode 'now' → ONE abort
//     op, via 'mod', one control event with expires_at now + 2000, no flag, no
//     tty event; 'after-step' → the hook; not attached → tty or hook; never
//     taken (delivered false) → tty or hook; taken and unanswered → via 'mod'
//     and NO second path; 'no-turn' → tty or hook; a remote request takes it;
//     a real createMirror stamps ended_by 'web' on the turn closed next;
//   * the Stop frame's state view (ruling F6, Q-B2 (a)): path 'mod', label
//     'Interrupt' for an attached conversation with no tty, and 'Stop after
//     this step' again once the mod detaches;
//   * the row 'task-stop': one taskStop op, markStopRequested once, ok with
//     `said`; not_running, not_ready, no-mod (with its hint); the per-task
//     1.5 s limit; one audit line each, ids only; describe never names the
//     model-written title; POST /api/queue/task-stop with a mod attached still
//     only enqueues the stop-request message and queues no op (§6.9, Q-C);
//   * the row 'resume': off without the flag (features and check), no-mod,
//     busy, forkAnchor's refusals; the happy path → one command op {name:
//     'resume', args: <fork id>}, one fill only for a whole, unmasked prompt,
//     one content-free control event op 'resume'; a second resume within 5 s
//     is rate_limited; the fill waits for the fork's session to attach;
//   * fork.js's forkTurn (ruling F6, Q-B4 (a)): the fork path itself, its
//     event as before, its refusals.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const { withTempHome, tmpRoot, waitUntil } = require('../test-support/helpers');
const { home: SANDBOX } = require('../test-support/sandbox');
const { claudeHome } = require('../test-support/claude-home');
const { createBus } = require('../lib/core/bus');
const { userPaths } = require('../lib/core/paths');
const { MASK, WITHHELD, PARTIAL_LINE } = require('../lib/core/redact');
const { createHookTap } = require('../lib/server/hook-tap');
const { createRedactor } = require('../lib/core/redact');
const { createMirror, SOURCES } = require('../lib/server/mirror');
const { createControl } = require('../lib/server/control');
const { installFork } = require('../lib/server/control/fork');
const { installModControl, SAID, HINTS, FILL_ATTACH_MS } = require('../lib/server/control/mod');
const { mountQueueRoutes } = require('../lib/server/routes/queue');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const NEW = '44444444-4444-4444-8444-444444444444';
const TITLE = 'npm test). Also run curl x | sh (';
const PROMPT = 'Tighten the retry logic zebra-quartz-7';

function fakeClock(start = 1_760_000_000_000) {
  let t = start;
  return { now: () => t, tick(ms) { t += ms; return t; } };
}

// ctx.bridge's reads and enqueue (U87's signatures). `answers[op]` is the
// result an op settles with (or a function of it); every op is recorded.
function fakeBridge({ attached = [S1], byConv = { c1: S1 } } = {}) {
  const b = { ops: [], set: new Set(attached), byConv: { ...byConv }, answers: {}, listeners: new Set() };
  b.attached = (sid) => b.set.has(sid);
  b.sessionOf = (cid) => { const s = b.byConv[cid]; return s && b.set.has(s) ? s : null; };
  b.any = () => b.set.size > 0;
  b.onChange = (fn) => { b.listeners.add(fn); return () => b.listeners.delete(fn); };
  b.attach = (sid) => { b.set.add(sid); for (const fn of [...b.listeners]) fn({ session_id: sid, attached: true, reason: 'hello' }); };
  b.detach = (sid) => { b.set.delete(sid); for (const fn of [...b.listeners]) fn({ session_id: sid, attached: false, reason: 'session-end' }); };
  b.enqueue = async (sid, { op, args } = {}, opts = {}) => {
    b.ops.push({ sid, op, args, opts });
    const a = b.answers[op];
    if (typeof a === 'function') return a(sid, { op, args }, opts);
    return a || { ok: true, result: null };
  };
  return b;
}

function conv(id, { state = 'working', sid = S1, pid = 4242, interrupt = 'tty' } = {}) {
  return { id, name: 'fix the tests', current_session_id: sid, process: pid ? { pid, interrupt } : null, live: { state } };
}

// The facade's methods the rows read.
function fakeMirror({ conversations = [conv('c1')], tasks = [], turns = {}, anchors = {} } = {}) {
  const subs = new Set();
  const m = {
    conversations, tasksRows: tasks, turns, anchors, marked: [],
    snapshot: () => ({ conversations: m.conversations }),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(ev) { for (const fn of [...subs]) fn({ kind: 'mirror', ...ev }); },
    set(id, patch) { m.conversations = m.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)); },
    tasks: () => ({ tasks: m.tasksRows.map((r) => ({ ...r })), counts: {}, rev: 1 }),
    markStopRequested(id) { m.marked.push(id); return { id, stop_requested: true }; },
    async turn(id) { return m.turns[id] ? JSON.parse(JSON.stringify(m.turns[id])) : null; },
    async forkAnchor(id) { return Object.hasOwn(m.anchors, id) ? m.anchors[id] : { refused: 'unknown' }; },
  };
  return m;
}

function turnOf(id, { cid = 'c1', text = PROMPT, truncated = false, label = 'n1.2' } = {}) {
  const prompt = { id: `p_${id}`, kind: 'prompt', text };
  if (truncated) prompt.truncated = true;
  return {
    turn: { id, conversation_id: cid, session_id: S1, node: label ? { id: 'n2', label, role: 'commit' } : null, started_at: 1 },
    items: [prompt, { id: `r_${id}`, kind: 'reply', text: 'ok' }],
  };
}

function captureSurface() {
  const s = { spec: null };
  s.register = (kind, spec) => { s.spec = spec; return () => { s.spec = null; }; };
  s.ensure = async () => ({ port: 1 });
  return s;
}

// The control domain over the fakes, with the mod's rows installed.
async function rig(t, { mirror = fakeMirror(), bridge = fakeBridge(), env = {}, forkTurn = null, clock = fakeClock(), timers } = {}) {
  withTempHome(t);
  const root = tmpRoot('wc-mod-control-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bus = createBus();
  const frames = [];
  bus.setBroadcaster((f) => frames.push(f));
  const events = [];
  bus.subscribe((e) => events.push(e));
  const surface = captureSurface();
  const logs = [];
  const control = createControl({ root, bus, mirror, answerSurface: surface, now: clock.now });
  t.after(() => control.stop());
  await control.start();
  const mod = installModControl(control, { bridge, mirror, forkTurn, bus, env, now: clock.now, log: (m) => logs.push(m), ...(timers ? { timers } : {}) });
  t.after(() => mod.unregister());
  const controls = () => events.filter((e) => e.kind === 'control');
  const audit = () => {
    try {
      return fs.readFileSync(path.join(root, '.web-chat', 'control', 'audit.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  return { root, bus, frames, events, controls, control, mod, mirror, bridge, clock, surface, logs, audit };
}

const interrupt = (control, target, ctx = {}) => control.invoke('interrupt', { mode: 'now', ...target }, ctx);
const flagOf = (sid) => userPaths().haltFlag(sid);

// ── 1. the interrupt's mod path ─────────────────────────────────────────────

test('an attached session and mode now → exactly ONE abort op, via mod, one control event with expires_at now + 2000; no flag, no tty event', async (t) => {
  const r = await rig(t);
  r.bridge.answers.abort = { ok: true, result: { aborted: true, stopped: ['bk1'] } };
  const a = await interrupt(r.control, { conversation_id: 'c1' });
  assert.deepEqual([a.ok, a.accepted, a.via], [true, true, 'mod']);
  assert.deepEqual(r.bridge.ops.map((o) => [o.sid, o.op, o.args]), [[S1, 'abort', {}]]);
  assert.deepEqual(r.bridge.ops[0].opts, { deliverWithinMs: 1000, resultWithinMs: 1500 });
  const [e, ...more] = r.controls();
  assert.equal(more.length, 0, 'one event');
  assert.deepEqual({ ...e, seq: 0, ts: 0 }, {
    seq: 0, ts: 0, kind: 'control', op: 'interrupt', id: a.request_id, conversation_id: 'c1', session_id: S1, via: 'mod',
    expires_at: r.clock.now() + 2000,
  });
  assert.equal('target_pid' in e, false, 'nothing for the Esc injector, though the process says tty');
  assert.equal(fs.existsSync(flagOf(S1)), false, 'no halt flag');
  assert.deepEqual(r.control.interrupt.flags(), []);
  assert.deepEqual(r.frames, []);
  assert.ok(r.logs.some((l) => l === 'control: mod abort ok (stopped 1: bk1)'), 'the stopped ids, for V43');
  assert.equal(r.audit()[0].via, 'mod');
});

test("mode 'after-step' takes the hook as before, and asks the mod nothing", async (t) => {
  const r = await rig(t);
  const a = await interrupt(r.control, { conversation_id: 'c1', mode: 'after-step' });
  assert.equal(a.via, 'hook');
  assert.equal(r.bridge.ops.length, 0);
  assert.ok(fs.existsSync(flagOf(S1)));
});

test('no mod attached → tty (local) or hook (remote), as before', async (t) => {
  const r = await rig(t, { bridge: fakeBridge({ attached: [] }) });
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).via, 'tty');
  r.clock.tick(1600);
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' }, { remote: true })).via, 'hook');
  assert.equal(r.bridge.ops.length, 0);
});

test('the abort never taken by the mod (delivered false) → tty or hook; a mod that took it with no turn → tty or hook', async (t) => {
  const r = await rig(t);
  r.bridge.answers.abort = { ok: false, refused: 'timeout', delivered: false };
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).via, 'tty');
  r.clock.tick(1600);
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' }, { remote: true })).via, 'hook');
  r.clock.tick(1600);
  r.bridge.answers.abort = { ok: false, refused: 'no-turn', delivered: true };
  fs.rmSync(flagOf(S1), { force: true });
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).via, 'tty');
  assert.equal(r.bridge.ops.length, 3, 'the mod was asked each time');
  assert.deepEqual(r.controls().map((e) => e.via), ['tty', 'hook', 'tty']);
});

test('taken but unanswered (delivered true) → via mod and NO second path: no Esc event, no flag', async (t) => {
  const r = await rig(t);
  for (const answer of [{ ok: false, refused: 'no-result', delivered: true }, { ok: false, refused: 'failed', error: 'is already ending', delivered: true }]) {
    r.bridge.answers.abort = answer;
    const a = await interrupt(r.control, { conversation_id: 'c1' }, { remote: answer.refused === 'failed' });
    assert.equal(a.via, 'mod', answer.refused);
    r.clock.tick(1600);
  }
  assert.deepEqual(r.controls().map((e) => [e.via, 'target_pid' in e]), [['mod', false], ['mod', false]]);
  assert.equal(fs.existsSync(flagOf(S1)), false);
});

test('a remote request takes the mod path (B2 (a)); a conversation with no tty and a mod takes it too', async (t) => {
  const r = await rig(t, { mirror: fakeMirror({ conversations: [conv('c1', { pid: null })] }) });
  const a = await interrupt(r.control, { conversation_id: 'c1' }, { remote: true, device: 'mobile' });
  assert.equal(a.via, 'mod');
  const line = r.audit()[0];
  assert.deepEqual([line.via, line.origin, line.device], ['mod', 'remote', 'mobile']);
});

test('after unregister() the interrupt is tier 1 again', async (t) => {
  const r = await rig(t);
  r.mod.unregister();
  assert.equal((await interrupt(r.control, { conversation_id: 'c1' })).via, 'tty');
  assert.equal(r.bridge.ops.length, 0);
  assert.equal((await r.control.invoke('task-stop', { task_id: 'b1' }, {})).refused, 'unknown-action');
  assert.equal((await r.control.invoke('resume', { turn_id: 't2' }, {})).refused, 'unknown-action');
});

// The event's shape, read by a real mirror facade: via mod stamps ended_by 'web'.
test('a real createMirror stamps ended_by web on the turn closed after a via-mod interrupt', async (t) => {
  let mirror = null;
  t.after(async () => { if (mirror) await mirror.stop(); });
  withTempHome(t);
  const root = fs.mkdtempSync(path.join(SANDBOX, 'wc-mod-facade-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ch = claudeHome(t, { root, isolate: true });
  const hooks = createHookTap();
  const mainBus = createBus();
  let ts = Date.now();
  mirror = createMirror({
    root, hooks, mainBus, mirrorBus: createBus({ maxEvents: 2000 }), redactor: createRedactor(), log: () => {},
    sampleProcs: async (pids) => new Map(pids.map((p) => [p, { alive: true, startedAt: null, cpuMs: 0, state: 'S' }])),
    sources: SOURCES.filter((s) => s.name === 'live'),
  });
  const closes = [];
  mirror.subscribe((e) => { if (e.op === 'turn-closed') closes.push(e); });
  await mirror.start();
  const publish = (event, extra = {}) => hooks.publish({
    v: 1, event, ts: (ts += 1), session_id: S1, transcript_path: ch.transcript(S1), cwd: ch.cwd,
    prompt_id: null, claude_pid: null, entrypoint: 'cli', permission_mode: 'default', agent: null, tool: null,
    result: null, session: null, compact: null, stop: null, prompt: null, ask: null, ...extra,
  });
  const prompt = (pid) => publish('UserPromptSubmit', { prompt_id: pid, prompt: { author: 'user', text: `prompt ${pid}` } });
  publish('SessionStart', { session: { source: 'startup' } });
  prompt('pA');
  const control = createControl({ root, bus: mainBus, mirror });
  t.after(() => control.stop());
  await control.start();
  const bridge = fakeBridge({ attached: [S1] });
  bridge.answers.abort = { ok: true, result: { aborted: true, stopped: [] } };
  const mod = installModControl(control, { bridge, mirror, bus: mainBus, env: {} });
  t.after(() => mod.unregister());
  const c = mirror.snapshot({ level: 'local' }).conversations[0];
  assert.ok(c && ['working', 'compacting', 'question', 'waiting'].includes(c.live.state));
  const a = await control.invoke('interrupt', { conversation_id: c.id, mode: 'now' }, {});
  assert.equal(a.via, 'mod', JSON.stringify(a));
  assert.equal(bridge.ops.length, 1);
  prompt('pB');
  const closed = closes.find((e) => e.turn_id === 'pA');
  assert.ok(closed, 'pA closed');
  assert.equal(closed.ended_by, 'web');
  assert.equal(fs.existsSync(userPaths().haltFlag(S1)), false);
});

// ── the Stop frame's state view (ruling F6, Q-B2 (a)) ───────────────────────

function stateRead(surface, query, { remote = false } = {}) {
  return new Promise((resolve) => {
    const res = { writableEnded: false, destroyed: false };
    const kit = { json: (_res, status, body) => { res.writableEnded = true; resolve({ status, body }); } };
    const req = { method: 'GET', headers: remote ? { 'x-wc-remote': '1' } : {} };
    surface.spec.api(req, res, kit, { rest: 'state', query, body: null });
  });
}

test("the state view says path 'mod' and 'Interrupt' for an attached conversation with no tty, and 'Stop after this step' once the mod detaches", async (t) => {
  const r = await rig(t, { mirror: fakeMirror({ conversations: [conv('c1', { pid: null })] }) });
  const v0 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.deepEqual([v0.path, v0.label], ['mod', 'Interrupt']);
  const remote = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' }, { remote: true })).body;
  assert.deepEqual([remote.path, remote.label, remote.v], ['mod', 'Interrupt', v0.v], 'remote takes the mod too; v is not per requester');
  r.bridge.detach(S1);
  const v1 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.deepEqual([v1.path, v1.label], ['hook', 'Stop after this step']);
  assert.ok(v1.v > v0.v, 'a detach bumps v');
  r.mod.unregister();
  r.bridge.attach(S1);
  const v2 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.equal(v2.path, 'hook', 'the probe goes with unregister');
});

// A mod attaching or leaving wakes the Stop frame's held long-poll at once
// (bridge.onChange → control.interrupt.refresh()), not at the poll's own wait.
// OPEN (U115): createControl's `interrupt` facade (lib/server/control/index.js
// :535, outside U115's grant) must carry `refresh: interrupt.refresh` for
// control/mod.js to reach it; until that one-line patch lands these two cases
// are todo. Drop the todo with the patch.
const REFRESH_TODO = 'needs lib/server/control/index.js to expose interrupt.refresh on control.interrupt (U115 open issue)';

function heldPoll(r, v) {
  const out = { settled: null };
  out.promise = stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1', v: String(v), wait: '20000' })
    .then((x) => { out.settled = x; return x; });
  return out;
}

test('a held Stop-frame long-poll wakes at once when the mod detaches, and again when it attaches', { todo: REFRESH_TODO }, async (t) => {
  const r = await rig(t, { mirror: fakeMirror({ conversations: [conv('c1', { pid: null })] }) });
  const v0 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.deepEqual([v0.path, v0.label], ['mod', 'Interrupt']);

  const a = heldPoll(r, v0.v);
  await new Promise((res) => setImmediate(res));
  assert.equal(a.settled, null, 'held while nothing changed');
  r.bridge.detach(S1);
  assert.ok(await waitUntil(() => a.settled, { timeout: 5000 }), 'the detach woke the poll, not its 20 s wait');
  assert.deepEqual([a.settled.body.path, a.settled.body.label], ['hook', 'Stop after this step']);
  assert.ok(a.settled.body.v > v0.v);

  const b = heldPoll(r, a.settled.body.v);
  await new Promise((res) => setImmediate(res));
  assert.equal(b.settled, null);
  r.bridge.attach(S1);
  assert.ok(await waitUntil(() => b.settled, { timeout: 5000 }), 'the attach woke the poll');
  assert.deepEqual([b.settled.body.path, b.settled.body.label], ['mod', 'Interrupt']);
});

test('after mod.unregister() a detach wakes no held poll: the subscription went with it', { todo: REFRESH_TODO }, async (t) => {
  const r = await rig(t, { mirror: fakeMirror({ conversations: [conv('c1', { pid: null })] }) });
  // While installed, the feed is subscribed; unregister() removes it.
  const before = r.bridge.listeners.size;
  assert.ok(before >= 1, 'subscribed while installed');
  r.mod.unregister();
  assert.equal(r.bridge.listeners.size, before - 1, 'unregister() removed the subscription');
  const v0 = (await stateRead(r.surface, { action: 'interrupt', conversation_id: 'c1' })).body;
  assert.deepEqual([v0.path, v0.label], ['hook', 'Stop after this step'], 'the probe went with unregister too');
  const held = heldPoll(r, v0.v);
  await new Promise((res) => setImmediate(res));
  r.bridge.detach(S1);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(held.settled, null, 'nothing woke it');
  await r.control.stop(); // releases the waiter, leaving no 20 s timer behind
  await held.promise;
});

// ── 2. task-stop ────────────────────────────────────────────────────────────

const TASKS = [
  { id: 'b1', kind: 'shell', status: 'running', title: TITLE, conversation_id: 'c1' },
  { id: 'b2', kind: 'shell', status: 'running', title: 'other', conversation_id: 'c1' },
  { id: 'done01', kind: 'shell', status: 'done', title: 'old', conversation_id: 'c1' },
  { id: 'a1b2c3', kind: 'agent', status: 'running', title: 'agent', tool_use_id: 'toolu_01ABC', conversation_id: 'c1' },
  { id: 'toolu_02DEF', kind: 'agent', status: 'running', title: 'young', tool_use_id: 'toolu_02DEF', conversation_id: 'c1' },
  { id: 'x9', kind: 'shell', status: 'running', title: 'elsewhere', conversation_id: 'c2' },
];
const taskRig = (t, o = {}) => rig(t, {
  mirror: fakeMirror({ conversations: [conv('c1'), conv('c2', { sid: S2 })], tasks: TASKS }), ...o,
});
const stopTask = (r, id, ctx = {}) => r.control.invoke('task-stop', { task_id: id }, ctx);

test('task-stop: a running shell with a mod → one taskStop op, markStopRequested once, ok with said; an agent asked for by its old tool_use id stops by its agentId', async (t) => {
  const r = await taskRig(t);
  r.bridge.answers.taskStop = { ok: true, result: { stopped: true } };
  const a = await stopTask(r, 'b1');
  assert.deepEqual(a, { ok: true, via: 'mod', said: SAID.stopping });
  assert.deepEqual(r.bridge.ops.map((o) => [o.sid, o.op, o.args]), [[S1, 'taskStop', { task_id: 'b1' }]]);
  assert.deepEqual(r.mirror.marked, ['b1']);
  const ag = await stopTask(r, 'toolu_01ABC');
  assert.equal(ag.ok, true);
  assert.deepEqual(r.bridge.ops[1].args, { task_id: 'a1b2c3' });
  assert.deepEqual(r.mirror.marked, ['b1', 'a1b2c3']);
  assert.deepEqual(r.controls(), [], 'no control event: the row confirms from the transcript');
});

test("task-stop refusals: finished or unknown → not_running; a provisional agent → not_ready; no mod → 'no-mod' with its hint; the mod's own refusal passes through", async (t) => {
  const r = await taskRig(t, { bridge: fakeBridge({ attached: [S1], byConv: { c1: S1 } }) });
  assert.equal((await stopTask(r, 'done01')).refused, 'not_running');
  assert.equal((await stopTask(r, 'nope')).refused, 'not_running');
  assert.equal((await stopTask(r, 'toolu_02DEF')).refused, 'not_ready');
  assert.deepEqual(await stopTask(r, 'x9'), { ok: false, refused: 'no-mod', hint: 'use Kill in the tray: the request goes to Claude' });
  assert.equal(HINTS.noModTask, 'use Kill in the tray: the request goes to Claude');
  assert.equal(r.bridge.ops.length, 0, 'a refusal asks the mod nothing');
  r.bridge.answers.taskStop = { ok: false, refused: 'failed', error: 'No task found', delivered: true };
  const f = await stopTask(r, 'b1');
  assert.equal(f.ok, false);
  assert.equal(f.refused, 'failed');
  assert.ok(f.hint && !f.hint.includes('No task found'), 'the mod\'s error text is not passed on');
  assert.deepEqual(r.mirror.marked, [], 'nothing marked stopping');
});

test('task-stop limit: a second request for the same task within 1.5 s is rate_limited; another task is not; one audit line each, ids only', async (t) => {
  const r = await taskRig(t);
  assert.equal((await stopTask(r, 'b1')).ok, true);
  r.clock.tick(1000);
  assert.equal((await stopTask(r, 'b1')).refused, 'rate_limited');
  assert.equal((await stopTask(r, 'b2')).ok, true, 'another task is free');
  r.clock.tick(600);
  assert.equal((await stopTask(r, 'b1')).ok, true, '1.6 s later');
  const lines = r.audit();
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => [l.action, l.outcome, l.via]), [
    ['task-stop', 'accepted', 'mod'], ['task-stop', 'refused:rate_limited', null], ['task-stop', 'accepted', 'mod'], ['task-stop', 'accepted', 'mod'],
  ]);
  for (const l of lines) assert.deepEqual(Object.keys(l.target), ['task_id']);
  assert.ok(!JSON.stringify(lines).includes('curl'), 'never the title');
});

test('task-stop: params take only TaskStop\'s id grammar; the frame\'s subject is the kind and the id, never the model-written title', async (t) => {
  const r = await taskRig(t);
  // The POST body, past the answer origin's gate: params() is the HTTP layer's.
  const post = (body) => new Promise((resolve) => {
    const kit = { json: (_res, status, b) => resolve({ status, body: b }) };
    r.surface.spec.api({ method: 'POST', headers: {} }, {}, kit, { rest: 'task-stop', query: {}, body });
  });
  for (const bad of ['', '../x', 'a b', 'x'.repeat(65), 7]) {
    const x = await post({ task_id: bad });
    assert.deepEqual([x.status, x.body.refused], [400, 'bad-target'], String(bad));
  }
  assert.equal((await post({ task_id: 'b1', extra: 1 })).status, 400, 'exactly the row\'s fields');
  assert.equal(r.bridge.ops.length, 0);
  const ok = await post({ task_id: 'b1' });
  assert.deepEqual([ok.status, ok.body.ok, ok.body.via], [200, true, 'mod']);
  const docs = [];
  const kit = { document: (_res, o) => docs.push(o), json: (_res, status, body) => docs.push({ status, body }) };
  await r.surface.spec.document({ method: 'GET', headers: {} }, {}, kit, { rest: 'task-stop', query: { task_id: 'b1', layout: 'confirm', mode: 'light' } });
  const desc = JSON.parse(docs[0].meta['wc-control']);
  assert.deepEqual(desc, { title: 'Stop this task now', summary: 'Claude Code stops it with TaskStop, through the web-chat mod.', lines: ['Shell · b1'] });
  assert.equal(docs[0].key, 'control:task-stop:b1');
  await r.surface.spec.document({ method: 'GET', headers: {} }, {}, kit, { rest: 'task-stop', query: { task_id: 'b1', layout: 'stop' } });
  assert.equal(docs[1].status, 404, 'confirm only');
});

test('task-stop features: ok with any mod attached, else no-mod', async (t) => {
  const r = await taskRig(t);
  assert.deepEqual(r.mod.features().task_stop, { ok: true });
  r.bridge.detach(S1);
  assert.deepEqual(r.mod.features().task_stop, { ok: false, reason: 'no-mod' });
});

test('POST /api/queue/task-stop with a mod attached still only enqueues the stop-request message and queues no op (§6.9, Q-C)', async (t) => {
  const r = await taskRig(t);
  const state = {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: 1, wakeConsumerSeenAt: Date.now(), pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
  const bus = createBus({ bootId: 'boot-1' });
  const ctx = { state, bus, graph: { lock: null, active: 'n0', saveMeta() {} }, mirror: r.mirror, bridge: r.bridge, control: r.control };
  const app = express();
  app.use(express.json());
  mountQueueRoutes(app, ctx);
  const srv = http.createServer(app);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => srv.close(res)));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/queue/task-stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: 'b1' }),
  });
  const body = await res.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(r.bridge.ops.length, 0, 'the pane-callable route never reaches the mod');
  const [wake] = bus.read({ kinds: ['wake'] }).events;
  assert.equal(wake.batch.length, 1);
  assert.deepEqual([wake.batch[0].source, wake.batch[0].task_id], ['task-stop', 'b1']);
});

// ── 3. resume (experimental) ────────────────────────────────────────────────

const ON = { WEB_CHAT_REWIND_IN_PLACE: '1' };
function resumeMirror(o = {}) {
  return fakeMirror({
    conversations: [conv('c1', { state: 'idle' }), conv('c2', { state: 'working', sid: S2 }), conv('c3', { state: 'idle', sid: 'abc' })],
    turns: {
      t2: turnOf('t2'),
      tmask: turnOf('tmask', { text: `use ${MASK('token')} please` }),
      tcut: turnOf('tcut', { truncated: true }),
      twith: turnOf('twith', { text: `read this: ${WITHHELD('env')}` }),
      tpart: turnOf('tpart', { text: `the log said ${PARTIAL_LINE} then stopped` }),
      tbusy: turnOf('tbusy', { cid: 'c2' }),
      tnomod: turnOf('tnomod', { cid: 'c3' }),
      tsup: turnOf('tsup'),
      t1: turnOf('t1'),
    },
    anchors: {
      t2: { session_id: S1, parent_uuid: PARENT },
      tmask: { session_id: S1, parent_uuid: PARENT },
      tcut: { session_id: S1, parent_uuid: PARENT },
      twith: { session_id: S1, parent_uuid: PARENT },
      tpart: { session_id: S1, parent_uuid: PARENT },
      tsup: { refused: 'superseded' },
      t1: { refused: 'first' },
    },
    ...o,
  });
}
function stubFork() {
  const f = { calls: [], answer: { ok: true, session_id: NEW, label: 'fork of n1.2' } };
  f.fn = async (id) => { f.calls.push(id); return typeof f.answer === 'function' ? f.answer(id) : f.answer; };
  return f;
}
const resumeTurn = (r, id, ctx = {}) => r.control.invoke('resume', { turn_id: id }, ctx);

test("resume without WEB_CHAT_REWIND_IN_PLACE: features {ok: false, reason: 'off'} and check 'off' with the restart hint; nothing forks", async (t) => {
  const fork = stubFork();
  for (const env of [{}, { WEB_CHAT_REWIND_IN_PLACE: 'true' }, { WEB_CHAT_REWIND_IN_PLACE: '0' }]) {
    const r = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env });
    assert.deepEqual(r.mod.features().resume, { ok: false, reason: 'off' });
    assert.deepEqual(await resumeTurn(r, 't2'), { ok: false, refused: 'off', hint: 'set WEB_CHAT_REWIND_IN_PLACE=1 and run claude-web-chat restart' });
    assert.equal(r.bridge.ops.length, 0);
  }
  assert.deepEqual(fork.calls, []);
});

test('resume refusals with the flag: no mod; a working conversation (busy); the fork anchor\'s superseded, first and unknown', async (t) => {
  const fork = stubFork();
  const r = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env: ON, bridge: fakeBridge({ attached: [S1, S2], byConv: { c1: S1, c2: S2 } }) });
  assert.equal((await resumeTurn(r, 'tnomod')).refused, 'no-mod');
  assert.equal((await resumeTurn(r, 'tbusy')).refused, 'busy');
  assert.equal((await resumeTurn(r, 'tsup')).refused, 'superseded');
  assert.equal((await resumeTurn(r, 't1')).refused, 'first');
  assert.equal((await resumeTurn(r, 'tnone')).refused, 'unknown');
  assert.match((await resumeTurn(r, 'tsup')).hint, /rewound away/);
  assert.deepEqual(fork.calls, [], 'a refusal forks nothing');
  assert.equal(r.bridge.ops.length, 0);
  assert.deepEqual(r.controls(), []);
  const nomod = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env: ON, bridge: fakeBridge({ attached: [] }) });
  assert.deepEqual(nomod.mod.features().resume, { ok: false, reason: 'no-mod' });
  assert.equal((await resumeTurn(nomod, 't2')).refused, 'no-mod');
});

test('resume happy path: one fork, one command op resume <fork id>, one fill with the whole prompt, one content-free control event; a second within 5 s is rate_limited', async (t) => {
  const fork = stubFork();
  const r = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env: ON });
  assert.deepEqual(r.mod.features().resume, { ok: true });
  const a = await resumeTurn(r, 't2');
  assert.deepEqual(a, { ok: true, via: 'mod', said: SAID.filled, filled: true });
  assert.deepEqual(fork.calls, ['t2']);
  assert.deepEqual(r.bridge.ops.map((o) => [o.sid, o.op, o.args]), [
    [S1, 'command', { name: 'resume', args: NEW }],
    [S1, 'fill', { text: PROMPT }],
  ]);
  assert.equal(r.bridge.ops[0].opts.resultWithinMs, 10000);
  const evs = r.controls();
  assert.equal(evs.length, 1);
  assert.deepEqual({ ...evs[0], seq: 0, ts: 0, id: 'x' }, { seq: 0, ts: 0, id: 'x', kind: 'control', op: 'resume', conversation_id: 'c1', session_id: S1, outcome: 'switched' });
  assert.ok(!JSON.stringify(evs).includes('zebra') && !JSON.stringify(evs).includes(NEW), 'no text, no fork id');
  assert.ok(!JSON.stringify(r.audit()).includes('zebra'));
  assert.equal(r.audit()[0].via, 'mod');
  assert.equal((await resumeTurn(r, 'tcut')).refused, 'rate_limited', 'project scope: another turn too');
  r.clock.tick(5001);
  assert.equal((await resumeTurn(r, 't2')).ok, true);
});

test('resume: a masked or truncated prompt is not refilled, and the answer says so; a fill the mod refuses says so too', async (t) => {
  const fork = stubFork();
  const r = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env: ON });
  // A redaction mask, a withheld file and an omitted partial line are each a
  // prompt the mirror does not hold whole (lib/core/redact's three marks).
  for (const id of ['tmask', 'tcut', 'twith', 'tpart']) {
    const a = await resumeTurn(r, id);
    assert.deepEqual(a, { ok: true, via: 'mod', said: SAID.notWhole, filled: false }, id);
    r.clock.tick(5001);
  }
  assert.deepEqual(r.bridge.ops.map((o) => o.op), ['command', 'command', 'command', 'command'], 'no fill op');
  assert.ok(SAID.notWhole.length <= 120 && SAID.filled.length <= 120);
  r.bridge.answers.fill = { ok: false, refused: 'failed', delivered: true };
  assert.equal((await resumeTurn(r, 't2')).said, SAID.fillFailed);
});

test('resume: a fork that failed, or a switch the mod refused, is failed — the event says so, and only the frame learns the fork command', async (t) => {
  const fork = stubFork();
  const r = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env: ON });
  fork.answer = { ok: false, refused: 'claude-missing', hint: 'no claude' };
  assert.deepEqual(await resumeTurn(r, 't2'), { ok: false, refused: 'claude-missing', hint: 'no claude' });
  fork.answer = { ok: true, session_id: NEW, label: 'fork of n1.2' };
  r.bridge.answers.command = { ok: false, refused: 'no-result', delivered: true };
  const b = await resumeTurn(r, 't2');
  assert.equal(b.refused, 'switch-failed');
  assert.match(b.hint, new RegExp(`claude --resume ${NEW}`));
  assert.deepEqual(r.controls().map((e) => e.outcome), ['failed', 'failed']);
  assert.ok(!r.bridge.ops.some((o) => o.op === 'fill'));
});

test('resume: the fill goes to the fork\'s session once its mod says hello, waiting for it; with neither attached in time, no fill', async (t) => {
  const pending = new Map();
  let n = 0;
  const timers = {
    setTimeout(fn, ms) { const id = ++n; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  const fork = stubFork();
  const r = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env: ON, timers });
  // The install's own feed (the Stop label's refresh, U115) stays subscribed.
  const base = r.bridge.listeners.size;
  // The switch ends the old session at once; the fork's hello comes later.
  r.bridge.answers.command = () => { r.bridge.detach(S1); return { ok: true, result: null }; };
  const running = resumeTurn(r, 't2');
  await new Promise((res) => setImmediate(res));
  assert.deepEqual([...pending.values()].map((p) => p.ms), [FILL_ATTACH_MS], 'one bounded wait');
  r.bridge.attach(NEW);
  const a = await running;
  assert.equal(a.filled, true);
  assert.deepEqual(r.bridge.ops.at(-1), { sid: NEW, op: 'fill', args: { text: PROMPT }, opts: { deliverWithinMs: 3000, resultWithinMs: 3000 } });
  assert.equal(pending.size, 0, 'the wait is cleared');
  assert.equal(r.bridge.listeners.size, base, 'and unsubscribed');

  // Both attached (the fork's hello before the old session's detach): the fork's.
  r.clock.tick(5001);
  r.bridge.answers.command = { ok: true, result: null };
  r.bridge.set.add(S1);
  const both = await resumeTurn(r, 't2');
  assert.equal(both.filled, true);
  assert.equal(r.bridge.ops.at(-1).sid, NEW, 'the fork\'s session takes the fill');

  r.clock.tick(5001);
  r.bridge.answers.command = () => { r.bridge.detach(S1); return { ok: true, result: null }; };
  r.bridge.set.add(S1);
  r.bridge.set.delete(NEW);
  const again = resumeTurn(r, 't2');
  await new Promise((res) => setImmediate(res));
  for (const [id, p] of [...pending]) { pending.delete(id); p.fn(); }
  const b = await again;
  assert.deepEqual([b.ok, b.filled, b.said], [true, false, SAID.fillFailed]);
});

test('resume: unregister() releases a fill still waiting', async (t) => {
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const fork = stubFork();
  const r = await rig(t, { mirror: resumeMirror(), forkTurn: fork.fn, env: ON, timers });
  r.bridge.answers.command = () => { r.bridge.detach(S1); return { ok: true, result: null }; };
  const running = resumeTurn(r, 't2');
  await new Promise((res) => setImmediate(res));
  r.mod.unregister();
  const a = await running;
  assert.equal(a.filled, false);
});

// ── fork.js forkTurn (ruling F6, Q-B4 (a)) ──────────────────────────────────

test('forkTurn is the fork row\'s own path: the same check, argv and event, answering the session id and label to the daemon', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-forkturn-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bus = createBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const control = createControl({ root, bus });
  t.after(() => control.stop());
  const mirror = resumeMirror();
  const runs = [];
  const fork = installFork(control, {
    mirror, root, bus, findClaude: () => '/x/claude',
    runClaudeAsync: async (argv, opts) => { runs.push({ argv, opts }); return { ok: true, stdout: JSON.stringify({ session_id: NEW }) }; },
  });
  assert.equal(typeof fork.forkTurn, 'function');
  const a = await fork.forkTurn('t2');
  assert.deepEqual(a, { ok: true, session_id: NEW, label: 'fork of n1.2' });
  assert.deepEqual(runs[0].argv, ['-p', '/rename fork of n1.2', '--resume', S1, '--resume-session-at', PARENT, '--fork-session', '--output-format', 'json']);
  assert.deepEqual([runs[0].opts.cwd, runs[0].opts.timeoutMs], [root, 30000]);
  const evs = events.filter((e) => e.kind === 'control');
  assert.deepEqual(evs.map((e) => [e.op, e.outcome, e.session_id]), [['fork', 'forked', S1]]);
  assert.deepEqual(await fork.forkTurn('tsup'), { ok: false, refused: 'superseded', hint: 'that turn was rewound away; fork from a turn that is still in the conversation' });
  assert.equal((await fork.forkTurn('../x')).refused, 'bad-target');
  assert.equal(runs.length, 1, 'a refusal spawns nothing');
  // The row itself answers as before.
  const row = await control.invoke('fork', { turn_id: 't2' }, {});
  assert.deepEqual(row, { ok: true, session_id: NEW, command: `claude --resume ${NEW}` });
});

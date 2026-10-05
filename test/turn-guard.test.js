// The turn guard (spec §3.3, U31): the daemon ends a held turn on evidence when
// Claude Code fires no Stop — an Esc or an interrupt (the mirror's turn-closed
// {by:'status'}), a session gone (SessionEnd, process-gone, the pid check), an
// unanswered wake — and reconciles the late Stop that may follow.
//
// The rules run against a fake graph (lock, pendingFolded, nodes, writeNode,
// redactText), a real hook tap, a real change bus, a fake mirror (subscribe,
// status, liveOf, conversationOfPid), an injected isPidAlive and a fake endTurn
// that commits or folds the way U30's does. The last tests run the guard on a
// real daemon with U30's real endTurn: a Stop-less Esc commits its node
// `interrupted`, and the late Stop that follows is reconciled, not committed.
// Every wait goes through waitUntil; a "nothing happens" wait is a waitUntil on
// a predicate that never holds. On the daemon each mirror event is stamped one
// millisecond after the lock's started_at: a real turn-closed {by:'status'}
// comes STOP_GRACE_MS after the flip, never in the lock's own millisecond.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { waitUntil, withServer, shortLockTtl } = require('../test-support/helpers');
const { createBus } = require('../lib/core/bus');
const { createHookTap } = require('../lib/server/hook-tap');
const { createTurnGuard, GONE_MS, BUSY_STATES } = require('../lib/server/turn-guard');
const { ACTIVE_STATES } = require('../lib/server/mirror/live');
const { request } = require('../lib/client');

// Nothing happens for `ms`: a waitUntil that never succeeds.
const quiet = (ms) => waitUntil(() => false, { timeout: ms });

const S1 = { session_id: 'sess-1', claude_pid: 4001, prompt_id: 'p1' };

// A graph with what the guard touches. redactText masks a fake key so a test can
// see the reply went through it.
function fakeGraph() {
  const g = {
    lock: null,
    pendingFolded: [],
    nodes: new Map(),
    written: [],
    metaSaves: 0,
    redactText: (s) => s.replace(/sk-test-[A-Za-z0-9]+/g, '[redacted]'),
    writeNode(node) { g.written.push(node.id); },
    saveMeta() { g.metaSaves += 1; },
  };
  return g;
}

// U30's endTurn, in miniature: commit a node when `dirty`, else fold the turn;
// release the lock and say so on the bus, as domain/turns does.
function fakeEndTurn(g, bus, opts = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    if (!g.lock) return { ok: true, skipped: 'no-lock' };
    const lock = g.lock;
    const end = {
      ...(args.ended ? { ended: args.ended } : {}),
      ...(args.ended_by ? { ended_by: args.ended_by } : {}),
    };
    g.lock = null;
    if (opts.dirty === false) {
      g.pendingFolded.push({ at: Date.now(), author: 'claude', kind: 'turn', message: lock.message || '', summary: '', ...end });
      bus.emit({ event: { kind: 'graph', op: 'turn-skipped', reason: 'no-change' } });
      return { ok: true, skipped: 'no-change', accumulated: g.pendingFolded.length };
    }
    const id = `n${g.nodes.size + 1}`;
    g.nodes.set(id, { id, created_at: Date.now(), trigger: { kind: 'turn', message: lock.message || '', summary: '', ...end } });
    bus.emit({ event: { kind: 'graph', op: 'turn-end', id } });
    return { ok: true, node_id: id };
  };
  fn.calls = calls;
  return fn;
}

// The mirror's in-process face, as the guard reads it. emit() delivers a ring
// entry (`ts` stamped at emission unless the test gives one).
function fakeMirror({ rows = [], pids = {} } = {}) {
  const subs = new Set();
  return {
    subs,
    rows,
    emit(e) {
      const ev = { kind: 'mirror', ts: Date.now(), ...e };
      for (const fn of [...subs]) fn(ev);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    status() { return { rev: 1, now: Date.now(), aggregate: { state: 'idle' }, conversations: this.rows }; },
    liveOf() { return null; },
    conversationOfPid(pid) { return pids[pid] || null; },
  };
}

// A guard over fakes, stopped in t.after. `bind:false` leaves endTurn unbound.
function rig(t, {
  mirror = fakeMirror(), withMirror = true, isPidAlive, dirty, bind = true, ...opts
} = {}) {
  const graph = fakeGraph();
  const bus = createBus();
  const hooks = createHookTap();
  const endTurn = fakeEndTurn(graph, bus, { dirty });
  const guard = createTurnGuard({
    graph, bus, hooks, mirror: withMirror ? mirror : undefined, isPidAlive,
    settleMs: 60, wakeIdleMs: 80, lateStopMs: 60000, pidCheckMs: 20, goneMs: 40, ...opts,
  });
  t.after(() => guard.stop());
  if (bind) guard.bindEndTurn(endTurn);
  // Take a lock the way the routes do: the record, then a graph event on the bus.
  const lock = (fields = S1, { author = 'user', message = 'the prompt', ago = 50 } = {}) => {
    graph.lock = { base: null, started_at: Date.now() - ago, message, author, ...fields };
    bus.emit({ event: { kind: 'graph', op: 'turn-begin', base: null } });
    return graph.lock;
  };
  return { graph, bus, hooks, mirror, endTurn, guard, lock };
}

const closedBy = (by, extra = {}) => ({
  op: 'turn-closed', conversation_id: 'c1', session_id: S1.session_id, turn_id: 't1', outcome: 'interrupted', by, ...extra,
});

// ── Esc or interrupt ────────────────────────────────────────────────────────

test('a turn-closed {by:status} for the lock\'s session ends the turn after settleMs, interrupted, with the event\'s ended_by', async (t) => {
  const r = rig(t);
  r.lock();
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  assert.equal(r.endTurn.calls.length, 0, 'nothing before settleMs');
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the interrupted end' });
  assert.deepStrictEqual(r.endTurn.calls[0], {
    author: 'claude', ended: 'interrupted', ended_by: 'terminal', session_id: 'sess-1', prompt_id: 'p1',
  });
  assert.equal(r.graph.lock, null);
  assert.equal(r.graph.nodes.get('n1').trigger.ended_by, 'terminal');
});

test('ended_by is copied verbatim, and absent when the event has none', async (t) => {
  const a = rig(t);
  a.lock();
  a.mirror.emit(closedBy('status'));
  await waitUntil(() => a.endTurn.calls.length === 1, { what: 'the end' });
  assert.equal('ended_by' in a.endTurn.calls[0], false);

  const b = rig(t);
  b.lock();
  b.mirror.emit(closedBy('status', { ended_by: 'web' }));
  await waitUntil(() => b.endTurn.calls.length === 1, { what: 'the end' });
  assert.equal(b.endTurn.calls[0].ended_by, 'web', 'an interrupt from the browser arrives the same way (§15.2)');
});

test('a Stop (or StopFailure) of the session published on the tap within settleMs cancels the pending end', async (t) => {
  for (const event of ['Stop', 'StopFailure']) {
    const r = rig(t);
    r.lock();
    r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
    r.hooks.publish({ v: 1, event, session_id: 'sess-1', claude_pid: 4001 });
    await quiet(150);
    assert.equal(r.endTurn.calls.length, 0, `${event} cancels`);
  }
  // Another session's Stop does not.
  const o = rig(t);
  o.lock();
  o.mirror.emit(closedBy('status'));
  o.hooks.publish({ v: 1, event: 'Stop', session_id: 'sess-other', claude_pid: 9999 });
  await waitUntil(() => o.endTurn.calls.length === 1, { what: 'the end despite another session\'s Stop' });
});

test('a turn-closed for another session, from before started_at, or by another `by` does nothing', async (t) => {
  const r = rig(t);
  const lock = r.lock();
  r.mirror.emit(closedBy('status', { session_id: 'sess-other', conversation_id: 'c9' }));
  r.mirror.emit(closedBy('status', { ts: lock.started_at - 1 }));
  r.mirror.emit(closedBy('status', { ts: lock.started_at }));
  r.mirror.emit(closedBy('next-turn'));
  r.mirror.emit(closedBy('transcript'));
  r.mirror.emit(closedBy('stop'));
  await quiet(150);
  assert.equal(r.endTurn.calls.length, 0);
  assert.notEqual(r.graph.lock, null);
});

test('the lock is matched through claude_pid when the event\'s session_id differs (conversationOfPid)', async (t) => {
  const r = rig(t, { mirror: fakeMirror({ pids: { 4001: 'c1' } }) });
  r.lock();
  r.mirror.emit(closedBy('status', { session_id: 'sess-after-clear', conversation_id: 'c1', ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the end' });
  assert.equal(r.endTurn.calls[0].ended, 'interrupted');
  assert.equal(r.endTurn.calls[0].session_id, 'sess-1', 'the lock\'s session');

  // A conversation the pid does not belong to is not the lock's.
  const o = rig(t, { mirror: fakeMirror({ pids: { 4001: 'c1' } }) });
  o.lock();
  o.mirror.emit(closedBy('status', { session_id: 'sess-x', conversation_id: 'c2' }));
  await quiet(150);
  assert.equal(o.endTurn.calls.length, 0);
});

// ── session gone ────────────────────────────────────────────────────────────

test('SessionEnd for the lock\'s session on the tap ends the turn session-ended after goneMs', async (t) => {
  assert.equal(GONE_MS, 1000, '§3.3: after 1 s');
  const r = rig(t, { goneMs: 120 });
  r.lock();
  r.hooks.publish({ v: 1, event: 'SessionEnd', session_id: 'sess-1', claude_pid: 4001, session: { reason: 'other' } });
  await quiet(40);
  assert.equal(r.endTurn.calls.length, 0, 'not before goneMs');
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the session-ended end' });
  assert.deepStrictEqual(r.endTurn.calls[0], { author: 'claude', ended: 'session-ended', session_id: 'sess-1', prompt_id: 'p1' });

  // Another session's SessionEnd, and a SessionEnd matched only by pid (a /clear's
  // late one for the old session_id), do nothing.
  const o = rig(t);
  o.lock();
  o.hooks.publish({ v: 1, event: 'SessionEnd', session_id: 'sess-2' });
  o.hooks.publish({ v: 1, event: 'SessionEnd', session_id: 'sess-before-clear', claude_pid: 4001 });
  await quiet(120);
  assert.equal(o.endTurn.calls.length, 0);
});

test('the mirror\'s process-gone naming the lock\'s session in session_ids ends the turn session-ended', async (t) => {
  const r = rig(t);
  r.lock();
  r.mirror.emit({ op: 'process-gone', conversation_id: 'c1', session_ids: ['sess-0', 'sess-1'], pid: 4001 });
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the end' });
  assert.equal(r.endTurn.calls[0].ended, 'session-ended');

  const o = rig(t);
  o.lock();
  o.mirror.emit({ op: 'process-gone', conversation_id: 'c2', session_ids: ['sess-2'], pid: 4002 });
  await quiet(120);
  assert.equal(o.endTurn.calls.length, 0, 'another process');
});

test('isPidAlive false on two consecutive checks ends the turn session-ended; false then true does not; null never acts', async (t) => {
  const seq = (answers) => {
    let i = 0;
    const f = (pid) => { f.pids.push(pid); const v = answers[Math.min(i, answers.length - 1)]; i += 1; return v; };
    f.pids = [];
    return f;
  };
  const gone = seq([false, false]);
  const a = rig(t, { isPidAlive: gone });
  a.lock();
  await waitUntil(() => a.endTurn.calls.length === 1, { what: 'the pid-gone end' });
  assert.equal(a.endTurn.calls[0].ended, 'session-ended');
  assert.ok(gone.pids.every((p) => p === 4001), 'a bare check of the lock\'s claude_pid');

  const flap = seq([false, true, false, true, false, true]);
  const b = rig(t, { isPidAlive: flap });
  b.lock();
  await quiet(200);
  assert.equal(b.endTurn.calls.length, 0, 'false then true is not two consecutive');
  assert.ok(flap.pids.length >= 3, 'it kept checking');

  const none = seq([null]);
  const c = rig(t, { isPidAlive: none });
  c.lock();
  await quiet(200);
  assert.equal(c.endTurn.calls.length, 0, 'null is no verdict');

  const throws = rig(t, { isPidAlive: () => { throw new Error('EAGAIN'); } });
  throws.lock();
  await quiet(120);
  assert.equal(throws.endTurn.calls.length, 0, 'a throw is no verdict');

  // A promise of a verdict is awaited.
  const async = rig(t, { isPidAlive: async () => false });
  async.lock();
  await waitUntil(() => async.endTurn.calls.length === 1, { what: 'the async pid-gone end' });

  // No claude_pid, no check.
  const nopid = seq([false]);
  const d = rig(t, { isPidAlive: nopid });
  d.lock({ session_id: 'sess-1' });
  await quiet(120);
  assert.deepStrictEqual(nopid.pids, []);
});

// ── unanswered wake ─────────────────────────────────────────────────────────

test('a fresh wake lock with no session going busy within wakeIdleMs while every session is idle is released through endTurn', async (t) => {
  const r = rig(t, { mirror: fakeMirror({ rows: [{ id: 'c1', state: 'idle' }, { id: 'c2', state: 'ended' }] }), dirty: false });
  r.lock({}, { author: 'wake', message: 'wake', ago: 0 });
  await quiet(30);
  assert.equal(r.endTurn.calls.length, 0, 'not before wakeIdleMs');
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the wake release' });
  assert.deepStrictEqual(r.endTurn.calls[0], { author: 'claude' });
  assert.equal(r.graph.lock, null);
  assert.equal(r.graph.pendingFolded.length, 1, 'a clean surface folds (endTurn decides)');
});

test('a session going busy keeps the wake lock; so does a session that is not idle, or no known session', async (t) => {
  const a = rig(t, { mirror: fakeMirror({ rows: [{ id: 'c1', state: 'idle' }] }) });
  a.lock({}, { author: 'wake', ago: 0 });
  a.mirror.emit({ op: 'state', conversation_id: 'c1', session_id: 'sess-1', pid: 4001, state: 'working', prev: 'idle' });
  a.mirror.emit({ op: 'state', conversation_id: 'c1', session_id: 'sess-1', pid: 4001, state: 'idle', prev: 'working' });
  await quiet(200);
  assert.equal(a.endTurn.calls.length, 0, 'it answered');

  const b = rig(t, { mirror: fakeMirror({ rows: [{ id: 'c1', state: 'idle' }, { id: 'c2', state: 'working' }] }) });
  b.lock({}, { author: 'wake', ago: 0 });
  await quiet(200);
  assert.equal(b.endTurn.calls.length, 0, 'not every session is idle');
  // …until that session flips idle (a transition, not a clock).
  b.mirror.rows[1].state = 'idle';
  b.mirror.emit({ op: 'state', conversation_id: 'c2', session_id: 'sess-2', pid: 4002, state: 'idle', prev: 'working' });
  await waitUntil(() => b.endTurn.calls.length === 1, { what: 'the release once every session is idle' });

  const c = rig(t, { mirror: fakeMirror({ rows: [] }) });
  c.lock({}, { author: 'wake', ago: 0 });
  await quiet(200);
  assert.equal(c.endTurn.calls.length, 0, 'a mirror that knows no session cannot say nobody answered');

  // A user lock is never released this way.
  const d = rig(t, { mirror: fakeMirror({ rows: [{ id: 'c1', state: 'idle' }] }) });
  d.lock();
  await quiet(200);
  assert.equal(d.endTurn.calls.length, 0);
});

// ── the late Stop ───────────────────────────────────────────────────────────

test('closedRecently is true within lateStopMs of a guard close and false after', async (t) => {
  let clock = 1_000_000;
  const r = rig(t, { now: () => clock, lateStopMs: 1000 });
  assert.equal(r.guard.closedRecently('sess-1'), false);
  r.lock();
  r.mirror.emit(closedBy('status', { ended_by: 'terminal', ts: Date.now() }));
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the end' });
  assert.equal(r.guard.closedRecently('sess-1'), true);
  assert.equal(r.guard.closedRecently('sess-2'), false);
  clock += 1000;
  assert.equal(r.guard.closedRecently('sess-1'), true, 'at lateStopMs');
  clock += 1;
  assert.equal(r.guard.closedRecently('sess-1'), false, 'after it');
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', reply: 'late' }), null, 'nothing to reconcile');
});

test('reconcileLateStop writes the (redacted) reply and ended onto the node, drops ended_by, answers its id, and is a no-op the second time', async (t) => {
  const r = rig(t);
  r.lock();
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the end' });
  const node = r.graph.nodes.get('n1');
  assert.equal(node.trigger.ended, 'interrupted');

  const got = r.guard.reconcileLateStop({ session_id: 'sess-1', prompt_id: 'p1', reply: 'Done.\n\nThe key sk-test-abc123 was rotated.', ended: 'stop' });
  assert.equal(got, 'n1');
  assert.equal(node.trigger.reply, 'Done. The key [redacted] was rotated.', 'summarizeReply\'d and redacted');
  assert.equal(node.trigger.ended, 'stop');
  assert.equal('ended_by' in node.trigger, false, 'a Stop came: not interrupted');
  assert.deepStrictEqual(r.graph.written, ['n1']);

  node.trigger.reply = 'kept';
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', prompt_id: 'p1', reply: 'again', ended: 'stop' }), 'n1');
  assert.equal(node.trigger.reply, 'kept', 'the second reconcile writes nothing');
  assert.deepStrictEqual(r.graph.written, ['n1']);

  // A late StopFailure records 'failed'.
  const f = rig(t);
  f.lock();
  f.mirror.emit(closedBy('status'));
  await waitUntil(() => f.endTurn.calls.length === 1, { what: 'the end' });
  f.guard.reconcileLateStop({ session_id: 'sess-1', reply: '', ended: 'failed' });
  assert.equal(f.graph.nodes.get('n1').trigger.ended, 'failed');
  assert.equal('reply' in f.graph.nodes.get('n1').trigger, false, 'no reply, no key');
});

test('reconcileLateStop writes onto the folded entry, or onto its copy in the node a commit has taken it into', async (t) => {
  const r = rig(t, { dirty: false });
  r.lock();
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the end' });
  const entry = r.graph.pendingFolded[0];
  assert.equal(entry.ended, 'interrupted');
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', reply: 'late reply', ended: 'stop' }), 'folded');
  assert.equal(entry.reply, 'late reply');
  assert.equal(entry.ended, 'stop');
  assert.equal('ended_by' in entry, false);
  assert.equal(r.graph.metaSaves, 1, 'pendingFolded rides _meta.json');
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', reply: 'twice', ended: 'stop' }), 'folded');
  assert.equal(entry.reply, 'late reply', 'no-op the second time');

  // A commit took the entry since: the copy in node.folded is written.
  const c = rig(t, { dirty: false });
  c.lock();
  c.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => c.endTurn.calls.length === 1, { what: 'the end' });
  const node = { id: 'n7', created_at: Date.now(), trigger: { kind: 'turn' }, folded: c.graph.pendingFolded.map((f) => ({ ...f })) };
  c.graph.nodes.set('n7', node);
  c.graph.pendingFolded = [];
  assert.equal(c.guard.reconcileLateStop({ session_id: 'sess-1', reply: 'late', ended: 'stop' }), 'folded');
  assert.equal(node.folded[0].reply, 'late');
  assert.equal(node.folded[0].ended, 'stop');
  assert.equal('ended_by' in node.folded[0], false);
  assert.deepStrictEqual(c.graph.written, ['n7']);
});

test('a late Stop finds the turn its prompt_id names when the guard closed two of the session\'s turns', async (t) => {
  const r = rig(t);
  r.lock({ ...S1, prompt_id: 'p1' });
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the first end' });
  r.lock({ ...S1, prompt_id: 'p2' });
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 2, { what: 'the second end' });
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', prompt_id: 'p1', reply: 'first', ended: 'stop' }), 'n1');
  assert.equal(r.graph.nodes.get('n1').trigger.reply, 'first');
  assert.equal('reply' in r.graph.nodes.get('n2').trigger, false, 'the newer turn is not the one the Stop names');
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', prompt_id: 'p2', reply: 'second', ended: 'stop' }), 'n2');
  assert.equal(r.graph.nodes.get('n2').trigger.reply, 'second');
});

test('a late Stop naming a prompt_id no remembered turn had is reconciled to nothing; one naming none takes the newest (U31b)', async (t) => {
  const r = rig(t);
  r.lock({ ...S1, prompt_id: 'p1' });
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the first end' });
  r.lock({ ...S1, prompt_id: 'p2' });
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 2, { what: 'the second end' });

  // Ruling U31@pick-prompt-mismatch: no fallback to the session's newest record.
  assert.equal(r.guard.closedRecently('sess-1'), true);
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', prompt_id: 'p9', reply: 'stray', ended: 'stop' }), null);
  for (const id of ['n1', 'n2']) {
    const tr = r.graph.nodes.get(id).trigger;
    assert.deepStrictEqual([tr.ended, tr.ended_by, 'reply' in tr], ['interrupted', 'terminal', false], `${id} untouched`);
  }
  assert.deepStrictEqual(r.graph.written, []);

  // A Stop without a prompt_id keeps 0.8.5's first rule: the session's newest.
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', reply: 'late', ended: 'stop' }), 'n2');
  assert.equal(r.graph.nodes.get('n2').trigger.reply, 'late');
  assert.equal('reply' in r.graph.nodes.get('n1').trigger, false);
});

test('noteEnded remembers a turn the turn-begin route ended, node or folded; unbound it remembers nothing (U31b)', async (t) => {
  const r = rig(t);
  const held = { base: null, started_at: Date.now() - 50, message: 'held', author: 'user', ...S1 };
  r.graph.nodes.set('n5', { id: 'n5', created_at: Date.now(), trigger: { kind: 'turn', ended: 'interrupted', ended_by: 'web' } });
  assert.equal(r.guard.noteEnded(held, { ok: true, node_id: 'n5' }, { ended: 'interrupted', since: Date.now() }), true);
  assert.equal(r.guard.closedRecently('sess-1'), true);
  assert.equal(r.guard.reconcileLateStop({ session_id: 'sess-1', prompt_id: 'p1', reply: 'after all', ended: 'stop' }), 'n5');
  const tr = r.graph.nodes.get('n5').trigger;
  assert.deepStrictEqual([tr.reply, tr.ended, 'ended_by' in tr], ['after all', 'stop', false]);

  // A fold: the entry endTurn just pushed is the one the Stop lands on.
  const f = rig(t);
  const since = Date.now();
  f.graph.pendingFolded.push({ at: Date.now(), author: 'claude', kind: 'turn', message: 'held', summary: '', ended: 'interrupted' });
  assert.equal(f.guard.noteEnded({ ...held, prompt_id: 'p3' }, { ok: true, skipped: 'no-change', accumulated: 1 }, { ended: 'interrupted', since }), true);
  assert.equal(f.guard.reconcileLateStop({ session_id: 'sess-1', prompt_id: 'p3', reply: 'chat only', ended: 'stop' }), 'folded');
  assert.deepStrictEqual([f.graph.pendingFolded[0].reply, f.graph.pendingFolded[0].ended], ['chat only', 'stop']);

  // Nothing to remember: no session, no result, or no endTurn bound.
  assert.equal(f.guard.noteEnded({ base: null, started_at: 1, message: 'm', author: 'user' }, { ok: true, node_id: 'n1' }), false);
  assert.equal(f.guard.noteEnded(held, null), false);
  const u = rig(t, { bind: false });
  assert.equal(u.guard.noteEnded(held, { ok: true, node_id: 'n5' }), false);
  assert.equal(u.guard.closedRecently('sess-1'), false);
});

test('the late Stop of a remembered turn on the tap does not cancel what the guard armed for the held turn (U31b)', async (t) => {
  const r = rig(t);
  r.lock({ ...S1, prompt_id: 'p1' });
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  await waitUntil(() => r.endTurn.calls.length === 1, { what: 'the first end' });
  r.lock({ ...S1, prompt_id: 'p2' });
  r.mirror.emit(closedBy('status', { ended_by: 'web' }));
  // p1's Stop arrives inside p2's settle window: it is p1's, not p2's.
  r.hooks.publish({ v: 1, event: 'Stop', session_id: 'sess-1', claude_pid: 4001, prompt_id: 'p1' });
  await waitUntil(() => r.endTurn.calls.length === 2, { what: 'the held turn\'s interrupted end' });
  assert.deepStrictEqual([r.endTurn.calls[1].prompt_id, r.endTurn.calls[1].ended], ['p2', 'interrupted']);

  // The held turn's own Stop (its prompt_id, or none) still cancels it.
  for (const stopFields of [{ prompt_id: 'p3' }, {}]) {
    const before = r.endTurn.calls.length;
    r.lock({ ...S1, prompt_id: 'p3' });
    r.mirror.emit(closedBy('status'));
    r.hooks.publish({ v: 1, event: 'Stop', session_id: 'sess-1', claude_pid: 4001, ...stopFields });
    await quiet(150);
    assert.equal(r.endTurn.calls.length, before, 'cancelled');
    r.graph.lock = null;
    r.bus.emit({ event: { kind: 'graph', op: 'unlock', had: true } });
  }
});

test('BUSY_STATES is the mirror\'s ACTIVE_STATES (U31b)', () => {
  assert.deepStrictEqual([...BUSY_STATES].sort(), [...ACTIVE_STATES].sort());
  assert.equal(BUSY_STATES.size, ACTIVE_STATES.length);
  // Built from it, not copied: a state the mirror adds is busy here too.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'turn-guard.js'), 'utf8');
  assert.match(src, /new Set\(ACTIVE_STATES\)/);
  assert.match(src, /require\('\.\/mirror\/live'\)/);
});

test('a turn opening keeps the wake lock, like a session going busy', async (t) => {
  const r = rig(t, { mirror: fakeMirror({ rows: [{ id: 'c1', state: 'idle' }] }) });
  r.lock({}, { author: 'wake', ago: 0 });
  r.mirror.emit({ op: 'turn-open', conversation_id: 'c1', session_id: 'sess-1', turn_id: 't9' });
  await quiet(200);
  assert.equal(r.endTurn.calls.length, 0, 'it answered');
});

// ── ended(lock): the same-session question ──────────────────────────────────

test('ended(lock) gives evidence for a close, a gone process or an idle flip after started_at, and false otherwise', async (t) => {
  // A close: the settle is long so the turn stays held while asked.
  const a = rig(t, { settleMs: 60000 });
  const la = a.lock();
  assert.equal(a.guard.ended(la), false);
  a.mirror.emit(closedBy('next-turn'));
  assert.equal(a.guard.ended(la), false, 'next-turn is the asking prompt\'s own close');
  a.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  assert.deepStrictEqual(a.guard.ended(la), { by: 'status', ended_by: 'terminal' });

  for (const by of ['transcript', 'stop']) {
    const r = rig(t);
    const l = r.lock();
    r.mirror.emit(closedBy(by));
    assert.deepStrictEqual(r.guard.ended(l), { by });
  }

  // A gone process (the gone timer is long, so the turn stays held).
  const g = rig(t, { goneMs: 60000 });
  const lg = g.lock();
  g.mirror.emit({ op: 'process-gone', conversation_id: 'c1', session_ids: ['sess-1'], pid: 4001 });
  assert.deepStrictEqual(g.guard.ended(lg), { by: 'process-gone' });
  const s = rig(t, { goneMs: 60000 });
  const ls = s.lock();
  s.hooks.publish({ v: 1, event: 'SessionEnd', session_id: 'sess-1' });
  assert.deepStrictEqual(s.guard.ended(ls), { by: 'session-end' });

  // An idle flip.
  const i = rig(t);
  const li = i.lock();
  i.mirror.emit({ op: 'state', conversation_id: 'c1', session_id: 'sess-1', pid: 4001, state: 'working', prev: 'idle' });
  assert.equal(i.guard.ended(li), false, 'going busy is no evidence');
  i.mirror.emit({ op: 'state', conversation_id: 'c1', session_id: 'sess-1', pid: 4001, state: 'idle', prev: 'working' });
  assert.deepStrictEqual(i.guard.ended(li), { by: 'idle' });
  assert.equal(i.endTurn.calls.length, 0, 'an idle flip is evidence to ask about, never an interrupt the guard acts on');
  // Claude wrote after it (the keep-alive re-stamped started_at): not the end.
  li.started_at = Date.now() + 1;
  assert.equal(i.guard.ended(li), false);

  // Before started_at, another session: false.
  const o = rig(t);
  const lo = o.lock();
  o.mirror.emit(closedBy('status', { ts: lo.started_at - 5 }));
  o.mirror.emit(closedBy('status', { session_id: 'sess-2', conversation_id: 'c2' }));
  o.mirror.emit({ op: 'state', conversation_id: 'c2', session_id: 'sess-2', pid: 4002, state: 'idle', prev: 'working' });
  assert.equal(o.guard.ended(lo), false);
  assert.equal(o.guard.ended(null), false);
  assert.equal(o.guard.ended({ ...lo }), false, 'evidence belongs to the lock object');
});

// ── discipline ──────────────────────────────────────────────────────────────

test('a timer armed for one lock does nothing after graph.lock changes', async (t) => {
  const r = rig(t, { isPidAlive: () => false, pidCheckMs: 40 });
  r.lock();
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  // Another turn's lock replaces it with no event the guard hears.
  r.graph.lock = { base: null, started_at: Date.now(), message: 'next', author: 'user', session_id: 'sess-9' };
  await quiet(200);
  assert.equal(r.endTurn.calls.length, 0, 'the settle and the pid check were the old lock\'s');
});

test('a lock change seen on the bus disarms the old lock\'s timers', async (t) => {
  const r = rig(t);
  r.lock();
  r.mirror.emit(closedBy('status'));
  r.graph.lock = null;
  r.bus.emit({ event: { kind: 'graph', op: 'unlock', had: true } });
  await quiet(150);
  assert.equal(r.endTurn.calls.length, 0);
});

test('without bindEndTurn nothing is ended', async (t) => {
  const r = rig(t, { bind: false, isPidAlive: () => false, mirror: fakeMirror({ rows: [{ id: 'c1', state: 'idle' }] }) });
  const l = r.lock();
  r.mirror.emit(closedBy('status', { ended_by: 'terminal' }));
  r.hooks.publish({ v: 1, event: 'SessionEnd', session_id: 'sess-1' });
  await quiet(200);
  assert.equal(r.endTurn.calls.length, 0);
  assert.equal(r.graph.lock, l);
  assert.equal(r.guard.ended(l), false);
  assert.equal(r.guard.closedRecently('sess-1'), false);
});

test('without a mirror only SessionEnd and the pid check act', async (t) => {
  const a = rig(t, { withMirror: false });
  a.lock();
  a.hooks.publish({ v: 1, event: 'SessionEnd', session_id: 'sess-1' });
  await waitUntil(() => a.endTurn.calls.length === 1, { what: 'the SessionEnd end' });

  const b = rig(t, { withMirror: false, isPidAlive: () => false });
  b.lock();
  await waitUntil(() => b.endTurn.calls.length === 1, { what: 'the pid end' });

  // The mirror-only rules have no input: a wake lock rides its TTL.
  const c = rig(t, { withMirror: false });
  c.lock({}, { author: 'wake', ago: 0 });
  c.mirror.emit(closedBy('status'));
  await quiet(200);
  assert.equal(c.endTurn.calls.length, 0);
  assert.equal(c.mirror.subs.size, 0, 'it never subscribed');
});

test('stop() clears every timer and subscription, and is idempotent', async (t) => {
  const pids = [];
  const r = rig(t, { isPidAlive: (p) => { pids.push(p); return true; }, pidCheckMs: 20 });
  r.lock();
  r.mirror.emit(closedBy('status'));
  assert.equal(r.mirror.subs.size, 1);
  r.guard.stop();
  r.guard.stop();
  assert.equal(r.mirror.subs.size, 0);
  const checks = pids.length;
  r.hooks.publish({ v: 1, event: 'SessionEnd', session_id: 'sess-1' });
  r.mirror.emit(closedBy('status'));
  await quiet(200);
  assert.equal(r.endTurn.calls.length, 0, 'the pending settle was cleared');
  assert.equal(pids.length, checks, 'the pid check stopped');
  assert.equal(r.guard.ended(r.graph.lock), false);
  assert.equal(r.guard.closedRecently('sess-1'), false);
});

// ── on a real daemon, with U30's endTurn ────────────────────────────────────

// A daemon, its live ctx and the handle mountGraphRoutes returned (the wrapper
// test/turn-repairs.test.js uses: a fresh lib/server after shortLockTtl's
// eviction, its mountGraphRoutes wrapped to hand both back). The guard is built
// the way createServer will (U40): bound to that endTurn, set on ctx.turnGuard.
async function daemonWithGuard(t, guardOpts = {}) {
  shortLockTtl(t, 15 * 60 * 1000);
  const routes = require('../lib/server/routes/graph');
  const real = routes.mountGraphRoutes;
  const cap = {};
  routes.mountGraphRoutes = (app, ctx) => { cap.ctx = ctx; cap.handle = real(app, ctx); return cap.handle; };
  const { createServer } = require('../lib/server');
  const { createTurnGuard: freshGuard } = require('../lib/server/turn-guard');
  const s = await withServer(t, { createServer });
  const { ctx } = cap;
  const mirror = fakeMirror();
  const guard = freshGuard({ graph: ctx.graph, bus: ctx.bus, hooks: ctx.hooks, mirror, settleMs: 50, ...guardOpts });
  t.after(() => guard.stop());
  guard.bindEndTurn(cap.handle.endTurn);
  ctx.turnGuard = guard;
  return {
    ...s, ctx, graph: ctx.graph, mirror, guard,
    host: (p, body) => request(s.port, 'POST', p, body, { timeout: 10000 }),
    nodeFile: (id) => JSON.parse(fs.readFileSync(path.join(s.root, '.web-chat', 'graph', `${id}.json`), 'utf8')),
  };
}

test('a Stop-less Esc commits its node interrupted with the mirror\'s ended_by; the late Stop is reconciled, not committed', async (t) => {
  const d = await daemonWithGuard(t);
  const begin = await d.host('/api/turn-begin', { message: 'refactor it', author: 'user', ...S1 });
  assert.equal(begin.status, 200);
  d.ctx.state.store.k = 1; // the turn changed the surface
  d.mirror.emit(closedBy('status', { ended_by: 'terminal', ts: d.graph.lock.started_at + 1 }));
  const id = await waitUntil(() => !d.graph.lock && d.graph.active, { what: 'the guard\'s commit' });
  const node = d.graph.nodes.get(id);
  assert.equal(node.trigger.ended, 'interrupted');
  assert.equal(node.trigger.ended_by, 'terminal');
  assert.equal(node.trigger.message, 'refactor it');
  assert.equal(d.nodeFile(id).trigger.ended_by, 'terminal');
  const turnEnd = d.ctx.bus.events.filter((e) => e.kind === 'graph' && e.op === 'turn-end');
  assert.deepStrictEqual(turnEnd.map((e) => [e.id, e.ended, e.ended_by, e.session_id]), [[id, 'interrupted', 'terminal', 'sess-1']]);

  // The Stop that finally arrives.
  const late = await d.host('/api/turn-end', { author: 'claude', reply: 'Refactored the module.', ended: 'stop', ...S1 });
  assert.deepStrictEqual([late.status, late.body], [200, { ok: true, reconciled: id }]);
  assert.equal(d.graph.nodes.size, 1, 'no stray node');
  assert.equal(node.trigger.reply, 'Refactored the module.');
  assert.equal(node.trigger.ended, 'stop');
  assert.equal('ended_by' in node.trigger, false);
  const onDisk = d.nodeFile(id);
  assert.equal(onDisk.trigger.reply, 'Refactored the module.', 'graph.writeNode persisted it');
  assert.equal('ended_by' in onDisk.trigger, false);
  // A duplicate Stop is still not a node.
  const again = await d.host('/api/turn-end', { author: 'claude', reply: 'x', ...S1 });
  assert.deepStrictEqual(again.body, { ok: true, reconciled: id });
  assert.equal(d.graph.nodes.size, 1);
});

test('on a daemon: a Stop inside settleMs wins; a same-session prompt after an Esc asks ended() and interrupts; a clean Esc folds', async (t) => {
  const d = await daemonWithGuard(t, { settleMs: 300 });
  await d.host('/api/turn-begin', { message: 'one', ...S1 });
  d.ctx.state.store.k = 1;
  d.mirror.emit(closedBy('status', { ended_by: 'terminal', ts: d.graph.lock.started_at + 1 }));
  const stop = await d.host('/api/turn-end', { author: 'claude', reply: 'answered', ...S1 });
  assert.ok(stop.body.node_id, 'the Stop commits');
  await quiet(400);
  assert.equal(d.graph.nodes.size, 1, 'the guard ended nothing');
  assert.equal(d.graph.nodes.get(stop.body.node_id).trigger.ended, 'stop');

  // An Esc, then the user types again before settleMs: U30's route asks ended().
  await d.host('/api/turn-begin', { message: 'two', ...S1, prompt_id: 'p2' });
  d.ctx.state.store.k = 2;
  d.mirror.emit(closedBy('status', { ended_by: 'terminal', ts: d.graph.lock.started_at + 1 }));
  const next = await d.host('/api/turn-begin', { message: 'three', ...S1, prompt_id: 'p3' });
  assert.ok(next.body.interrupted, 'the held turn ended as interrupted first');
  assert.equal(d.graph.nodes.get(next.body.interrupted).trigger.ended_by, 'terminal');
  assert.equal(d.graph.lock.prompt_id, 'p3');
  await quiet(400);
  assert.equal(d.graph.lock.prompt_id, 'p3', 'the old settle did nothing to the new lock');

  // A clean surface: the Esc folds, and the late Stop lands on the folded entry.
  await d.host('/api/turn-end', { author: 'claude', ...S1, prompt_id: 'p3' });
  await d.host('/api/turn-begin', { message: 'four', ...S1, prompt_id: 'p4' });
  d.mirror.emit(closedBy('status', { ended_by: 'terminal', ts: d.graph.lock.started_at + 1 }));
  await waitUntil(() => !d.graph.lock, { what: 'the guard\'s fold' });
  const entry = d.graph.pendingFolded[d.graph.pendingFolded.length - 1];
  assert.equal(entry.ended, 'interrupted');
  const late = await d.host('/api/turn-end', { author: 'claude', reply: 'just chat', ...S1, prompt_id: 'p4' });
  assert.deepStrictEqual(late.body, { ok: true, reconciled: 'folded' });
  assert.equal(entry.reply, 'just chat');
  assert.equal(entry.ended, 'stop');
});

// ── U31b: a late Stop naming another prompt; a turn a new prompt closed ─────

test('on a daemon: a late Stop naming a prompt_id the guard never closed is not reconciled, and a dirty surface commits an unlocked-turn node (U31b)', async (t) => {
  const d = await daemonWithGuard(t);
  await d.host('/api/turn-begin', { message: 'refactor it', author: 'user', ...S1 });
  d.ctx.state.store.k = 1;
  d.mirror.emit(closedBy('status', { ended_by: 'terminal', ts: d.graph.lock.started_at + 1 }));
  const id = await waitUntil(() => !d.graph.lock && d.graph.active, { what: 'the guard\'s commit' });
  d.ctx.state.store.k = 2; // something changed the surface since

  const late = await d.host('/api/turn-end', { author: 'claude', reply: 'not that turn\'s reply', ended: 'stop', ...S1, prompt_id: 'p-other' });
  assert.equal(late.status, 200);
  assert.equal(late.body.reconciled, undefined, 'attached to no closed turn');
  assert.equal(late.body.unlocked, true, 'the lockless path ran');
  const stray = d.graph.nodes.get(late.body.node_id);
  assert.equal(stray.trigger.kind, 'unlocked-turn');
  assert.equal(stray.trigger.reply, 'not that turn\'s reply');
  const tr = d.graph.nodes.get(id).trigger;
  assert.deepStrictEqual([tr.ended, tr.ended_by, 'reply' in tr], ['interrupted', 'terminal', false], 'the guard\'s node is untouched');

  // The turn's own Stop is still reconciled.
  const own = await d.host('/api/turn-end', { author: 'claude', reply: 'Refactored.', ended: 'stop', ...S1 });
  assert.deepStrictEqual(own.body, { ok: true, reconciled: id });
  assert.equal(d.graph.nodes.get(id).trigger.reply, 'Refactored.');
});

test('on a daemon: a turn the turn-begin route ended as interrupted takes its late Stop while the next turn holds the lock; the held turn stays open (U31b)', async (t) => {
  const d = await daemonWithGuard(t, { settleMs: 60000 });
  await d.host('/api/turn-begin', { message: 'one', ...S1 });
  d.ctx.state.store.k = 1;
  d.mirror.emit(closedBy('status', { ended_by: 'terminal', ts: d.graph.lock.started_at + 1 }));
  const next = await d.host('/api/turn-begin', { message: 'two', ...S1, prompt_id: 'p2' });
  const old = next.body.interrupted;
  assert.ok(old && d.graph.nodes.has(old), 'the route ended the held turn as interrupted');
  const held = d.graph.lock;
  assert.equal(held.prompt_id, 'p2');
  d.ctx.state.store.k = 2; // the held turn's own work

  const late = await d.host('/api/turn-end', { author: 'claude', reply: 'Finished one.', ended: 'stop', ...S1 });
  assert.deepStrictEqual([late.status, late.body], [200, { ok: true, reconciled: old }]);
  const tr = d.graph.nodes.get(old).trigger;
  assert.deepStrictEqual([tr.message, tr.reply, tr.ended, 'ended_by' in tr], ['one', 'Finished one.', 'stop', false]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.root, '.web-chat', 'graph', `${old}.json`), 'utf8')).trigger.reply, 'Finished one.');
  assert.equal(d.graph.lock, held, 'the held turn stays open');
  assert.equal(d.graph.nodes.size, 1);

  // The held turn's own Stop ends it as always.
  const own = await d.host('/api/turn-end', { author: 'claude', reply: 'Finished two.', ...S1, prompt_id: 'p2' });
  assert.ok(own.body.node_id);
  assert.equal(d.graph.lock, null);
  const t2 = d.graph.nodes.get(own.body.node_id).trigger;
  assert.deepStrictEqual([t2.message, t2.reply, t2.ended], ['two', 'Finished two.', 'stop']);
});

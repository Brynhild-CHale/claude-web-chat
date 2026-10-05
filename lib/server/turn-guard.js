// lib/server/turn-guard.js — the turn guard: the daemon ends a held turn on
// evidence when Claude Code fires no Stop (spec §3.3). `ctx.turnGuard`.
//
//   createTurnGuard({ graph, bus, hooks, mirror, isPidAlive, now = Date.now,
//                     settleMs = 5000, wakeIdleMs = 15000, lateStopMs = 60000,
//                     pidCheckMs = 5000, goneMs = 1000 })
//     → { bindEndTurn(fn), ended(lock), closedRecently(session_id),
//         reconcileLateStop({session_id, prompt_id, reply, ended}), stop() }
//
// createServer (U40) builds it after the mirror, binds the endTurn handle
// mountGraphRoutes returns, sets ctx.turnGuard and calls stop() from both of its
// teardown paths. Until bindEndTurn is called the guard acts on nothing: its
// timers fire into nothing, ended() answers false and nothing is remembered.
//
// THE RULES (§3.3's table), each about the lock held at that moment:
//
//   Esc or interrupt   the mirror's turn-closed {by:'status'} for the lock's
//                      session, after lock.started_at → unless a Stop or
//                      StopFailure of that session arrives on the hook tap within
//                      settleMs, endTurn({author:'claude', ended:'interrupted',
//                      ended_by: <the event's, copied verbatim; absent when
//                      absent>, session_id}). An interrupt from the browser (§15.2)
//                      fires no Stop either and arrives the same way.
//   session gone       SessionEnd for the lock's session on the tap; the mirror's
//                      process-gone naming it (its two-sample verdict, §2.6); or
//                      isPidAlive(lock.claude_pid) === false on two consecutive
//                      checks pidCheckMs apart while that lock is held → after
//                      goneMs (1 s), endTurn({author:'claude', ended:'session-ended',
//                      session_id}).
//   unanswered wake    a fresh `wake` lock with no session going busy within
//                      wakeIdleMs while every known session of the project is
//                      idle → endTurn({author:'claude'}): it skips and folds a
//                      clean surface, commits a dirty one.
//   late Stop          every turn the guard ended is remembered for lateStopMs
//                      ({session_id, prompt_id, node id or 'folded', at});
//                      the turn-end route's first branch (§3.2) asks
//                      closedRecently and hands the Stop to reconcileLateStop,
//                      which writes its reply and `ended` onto that node or
//                      folded entry, silently (ruling U31@late-stop-announce: the
//                      node shows the reply on its next read).
//
// ended(lock) answers the turn-begin route's same-session question (§3.2): an
// evidence object {by, ended_by?} when, after lock.started_at, the lock's session
// saw a turn-closed (by 'status', 'transcript' or 'stop'), its process gone
// (SessionEnd, process-gone, the pid check) or a state flip to idle; else false.
//
// DISCIPLINE. It acts only while a lock is held, and only on events and
// transitions, never on a lock's age: a live process can read `busy` for days
// (F7), and the TTL (domain/turns) stays the only clock on a lock. It decides
// nothing the mirror decides: an interrupt is the mirror's turn-closed
// {by:'status'}, never its own reading of a status flip, and process-gone is the
// mirror's verdict. "After lock.started_at" compares an event's ring ts with
// started_at at the moment the event ARRIVES: installLockKeepalive re-stamps
// started_at on every Claude write, which only makes the test stricter. Every
// timer belongs to the lock object it was armed for, does nothing once
// graph.lock is another object (the syncStaleTimer pattern in domain/turns), is
// cleared when the guard sees the lock change, and is unref'd; stop() clears
// them all and unsubscribes, and is idempotent. Without a mirror it sees only
// SessionEnd and the pid check, and every other path keeps the TTL's behaviour.
// The stale steal with preserve, the wake upgrade, the re-aim queue, the
// keep-alive, the boot clear and `claude-web-chat unlock` are domain/turns' and
// the routes', untouched here.
//
// Its inputs: `hooks` (lib/server/hook-tap.js) — SessionEnd envelopes, and the
// Stop and StopFailure the turn routes publish synchronously BEFORE they commit
// (so a Stop always cancels a pending end in time); `mirror.subscribe` — the
// mirror ring's turn-closed, process-gone, state and turn-open transitions (the
// rest it ignores); `mirror.status()` for "every known session idle" and
// `mirror.conversationOfPid(pid)` to tie a lock's claude_pid to a conversation;
// `bus`, the main change bus, whose graph events say the lock changed;
// `isPidAlive` (lib/core/portfiles): false is gone, true is alive, anything else
// (null, a throw) is no verdict and never moves anything.

const { summarizeReply } = require('../core/reply');
const { sameSession, redactGraphText } = require('./domain/turns');

// The live states that mean a session took up work (spec §2.6's state machine).
const BUSY_STATES = new Set(['working', 'compacting', 'question', 'waiting']);
// The turn-closed `by`s that are evidence a held turn ended (§3.2's row 4).
// 'next-turn' is not: the very prompt that asks ended() closes the previous
// turn that way, synchronously, before the lock logic runs.
const CLOSE_EVIDENCE = new Set(['status', 'transcript', 'stop']);
// How long session-gone evidence waits before ending the turn (§3.3: 1 s).
const GONE_MS = 1000;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validPid = (p) => Number.isSafeInteger(p) && p >= 2;

function createTurnGuard({
  graph, bus, hooks, mirror, isPidAlive, now = Date.now,
  settleMs = 5000, wakeIdleMs = 15000, lateStopMs = 60000, pidCheckMs = 5000, goneMs = GONE_MS,
} = {}) {
  if (!graph || typeof graph !== 'object') throw new TypeError('createTurnGuard: graph is required');
  const clock = typeof now === 'function' ? now : Date.now;
  const hasMirror = Boolean(mirror) && typeof mirror.subscribe === 'function';

  let endTurnFn = null;
  let stopped = false;
  // The lock the guard is watching and its timers: { lock, settle, gone, pid,
  // wake, pidFalse, wakeBusy, wakeDue }. One at a time — graph.lock is one.
  let cur = null;
  // lock object → the evidence it ended ({by, ended_by?, ts}); a WeakMap so a
  // released lock takes its evidence with it.
  const evidence = new WeakMap();
  // The turns the guard ended, newest last (the late-Stop memory).
  const closed = [];
  const offs = [];

  // ── the lock being watched ──
  // Called on every input: a lock change disarms the old lock's timers and arms
  // the new one's (the pid check, the wake window).
  function sync() {
    if (stopped) return null;
    const lock = isPlain(graph.lock) ? graph.lock : null;
    if (cur && cur.lock === lock) return cur;
    if (cur) disarm(cur);
    cur = lock ? {
      lock, settle: null, gone: null, pid: null, wake: null,
      pidFalse: 0, wakeBusy: false, wakeDue: false,
    } : null;
    if (cur) { armPid(cur); armWake(cur); }
    return cur;
  }

  function clearTimer(st, key) {
    if (st[key]) { clearTimeout(st[key]); st[key] = null; }
  }

  function disarm(st) {
    for (const k of ['settle', 'gone', 'pid', 'wake']) clearTimer(st, k);
  }

  // A timer that belongs to st.lock: it does nothing once the guard stopped, the
  // lock changed, or the guard moved on to another lock record.
  function schedule(st, key, ms, fn) {
    clearTimer(st, key);
    const t = setTimeout(() => {
      st[key] = null;
      if (!live(st)) return;
      fn(st);
    }, Math.max(0, Number.isFinite(ms) ? ms : 0));
    if (t && typeof t.unref === 'function') t.unref();
    st[key] = t;
  }

  const live = (st) => !stopped && cur === st && graph.lock === st.lock;

  // An event "after lock.started_at", judged as it arrives (see DISCIPLINE).
  function after(ts, lock) {
    const at = Number.isFinite(ts) ? ts : clock();
    return !Number.isFinite(lock.started_at) || at > lock.started_at;
  }

  function note(lock, ev) {
    const had = evidence.get(lock);
    // The first strong evidence stays; an idle flip only fills an empty slot.
    if (!had || (had.by === 'idle' && ev.by !== 'idle')) evidence.set(lock, ev);
  }

  // ── ending a turn ──
  function sessionArgs(lock) {
    return {
      ...(typeof lock.session_id === 'string' && lock.session_id ? { session_id: lock.session_id } : {}),
      ...(typeof lock.prompt_id === 'string' && lock.prompt_id ? { prompt_id: lock.prompt_id } : {}),
    };
  }

  function fire(st, args) {
    if (typeof endTurnFn !== 'function') return;
    const lock = st.lock;
    disarm(st);
    const t0 = Date.now();
    let r = null;
    try { r = endTurnFn(args); } catch { r = null; }
    remember(lock, args, r, t0);
    sync();
  }

  // The session's turn the guard just ended, for a late Stop to find.
  function remember(lock, args, r, t0) {
    if (!isPlain(r) || typeof lock.session_id !== 'string' || !lock.session_id) return;
    let target = null;
    let key = null;
    if (typeof r.node_id === 'string' && r.node_id) target = r.node_id;
    else if (r.skipped === 'no-change') {
      target = 'folded';
      // The entry skipTurn pushed; a re-aim applied in the same call may have
      // carried it onto a preserve node already, so the key finds it there too.
      const pf = Array.isArray(graph.pendingFolded) ? graph.pendingFolded : [];
      const last = pf[pf.length - 1];
      key = { ref: isPlain(last) && last.ended === args.ended && last.at >= t0 ? last : null, since: t0, ended: args.ended };
    }
    if (!target) return;
    closed.push({
      session_id: lock.session_id,
      ...(typeof lock.prompt_id === 'string' && lock.prompt_id ? { prompt_id: lock.prompt_id } : {}),
      target, key, at: clock(), done: false,
    });
  }

  function prune() {
    const t = clock();
    while (closed.length && !(t - closed[0].at <= lateStopMs)) closed.shift();
  }

  // ── Esc or interrupt ──
  function armSettle(st, ended_by) {
    if (st.settle) return;
    const lock = st.lock;
    schedule(st, 'settle', settleMs, () => fire(st, {
      author: 'claude', ended: 'interrupted',
      ...(ended_by !== undefined && ended_by !== null ? { ended_by } : {}),
      ...sessionArgs(lock),
    }));
  }

  // ── session gone ──
  function sessionGone(st, by) {
    note(st.lock, { by, ts: clock() });
    if (st.gone) return;
    clearTimer(st, 'pid');
    const lock = st.lock;
    schedule(st, 'gone', goneMs, () => fire(st, { author: 'claude', ended: 'session-ended', ...sessionArgs(lock) }));
  }

  function armPid(st) {
    if (typeof isPidAlive !== 'function' || !validPid(st.lock.claude_pid)) return;
    schedule(st, 'pid', pidCheckMs, checkPid);
  }

  function checkPid(st) {
    let v;
    try { v = isPidAlive(st.lock.claude_pid); } catch { v = null; }
    if (v && typeof v.then === 'function') {
      v.then((x) => pidVerdict(st, x), () => pidVerdict(st, null));
      return;
    }
    pidVerdict(st, v);
  }

  // false counts, true resets, anything else (null: no verdict) leaves the count
  // as it is — a loaded machine delays a verdict, it never invents one.
  function pidVerdict(st, v) {
    if (!live(st) || st.gone) return;
    if (v === false) st.pidFalse += 1;
    else if (v === true) st.pidFalse = 0;
    if (st.pidFalse >= 2) { sessionGone(st, 'process-gone'); return; }
    schedule(st, 'pid', pidCheckMs, checkPid);
  }

  // ── unanswered wake ──
  function armWake(st) {
    if (!hasMirror || st.lock.author !== 'wake') return;
    schedule(st, 'wake', wakeLeft(st.lock), checkWake);
  }

  function wakeLeft(lock) {
    const start = Number.isFinite(lock.started_at) ? lock.started_at : Date.now();
    return start + wakeIdleMs - Date.now();
  }

  function checkWake(st) {
    if (st.lock.author !== 'wake' || st.wakeBusy) return;
    // A second wake re-stamped the lock: its window starts again.
    const left = wakeLeft(st.lock);
    if (left > 0) { schedule(st, 'wake', left, checkWake); return; }
    st.wakeDue = true;
    releaseWakeIfIdle(st);
  }

  // Every known (not ended) session idle, and at least one known: a mirror that
  // knows no session cannot say nobody answered.
  function allIdle() {
    let rows;
    try { rows = mirror.status(); } catch { return false; }
    rows = isPlain(rows) && Array.isArray(rows.conversations) ? rows.conversations : null;
    if (!rows) return false;
    const known = rows.filter((r) => isPlain(r) && r.state !== 'ended');
    return known.length > 0 && known.every((r) => r.state === 'idle');
  }

  function releaseWakeIfIdle(st) {
    if (!st.wakeDue || st.wakeBusy || st.lock.author !== 'wake' || !live(st)) return;
    if (!allIdle()) return;
    fire(st, { author: 'claude' });
  }

  // ── inputs ──
  function matchesMirror(lock, e) {
    if (typeof lock.session_id === 'string' && lock.session_id) {
      if (e.session_id === lock.session_id) return true;
      if (Array.isArray(e.session_ids) && e.session_ids.includes(lock.session_id)) return true;
    }
    if (validPid(lock.claude_pid)) {
      if (e.pid === lock.claude_pid) return true;
      let cid = null;
      try { cid = mirror.conversationOfPid(lock.claude_pid); } catch { cid = null; }
      if (cid && e.conversation_id === cid) return true;
    }
    return false;
  }

  function onMirror(e) {
    if (stopped || !isPlain(e)) return;
    const st = sync();
    if (!st) return;
    const lock = st.lock;
    const busy = (e.op === 'state' && BUSY_STATES.has(e.state)) || e.op === 'turn-open';
    if (busy && lock.author === 'wake') { st.wakeBusy = true; clearTimer(st, 'wake'); return; }
    if (e.op === 'state' && st.wakeDue) { releaseWakeIfIdle(st); return; }
    if (!matchesMirror(lock, e) || !after(e.ts, lock)) return;
    if (e.op === 'turn-closed') {
      if (e.by === 'process-gone') { sessionGone(st, 'process-gone'); return; }
      if (!CLOSE_EVIDENCE.has(e.by)) return;
      const ended_by = e.ended_by;
      note(lock, { by: e.by, ...(ended_by !== undefined && ended_by !== null ? { ended_by } : {}), ts: e.ts });
      if (e.by === 'status') armSettle(st, ended_by);
    } else if (e.op === 'process-gone') {
      sessionGone(st, 'process-gone');
    } else if (e.op === 'state' && e.state === 'idle' && e.prev !== 'idle') {
      note(lock, { by: 'idle', ts: Number.isFinite(e.ts) ? e.ts : clock() });
    }
  }

  function onHook(env) {
    if (stopped || !isPlain(env)) return;
    const st = sync();
    if (!st) return;
    const lock = st.lock;
    if (env.event === 'Stop' || env.event === 'StopFailure') {
      // The turn routes publish this before they commit: the Stop ends the turn
      // itself, so nothing the guard armed may end it a second time.
      if (sameSession(lock, { session_id: env.session_id, claude_pid: env.claude_pid })) {
        clearTimer(st, 'settle');
        clearTimer(st, 'gone');
      }
      return;
    }
    // A SessionEnd names its session exactly. Matching by pid would let a /clear's
    // late SessionEnd for the old session_id end the new session's turn (C36).
    if (env.event === 'SessionEnd' && !isPlain(env.agent)
      && typeof lock.session_id === 'string' && lock.session_id && env.session_id === lock.session_id) {
      sessionGone(st, 'session-end');
    }
  }

  function onBus(e) {
    if (isPlain(e) && e.kind === 'graph') sync();
  }

  function subscribeTo(src, fn) {
    if (!src || typeof src.subscribe !== 'function') return;
    try {
      const off = src.subscribe(fn);
      if (typeof off === 'function') offs.push(off);
    } catch { /* an input that cannot be followed is an input the guard does without */ }
  }
  subscribeTo(hooks, onHook);
  if (hasMirror) subscribeTo(mirror, onMirror);
  subscribeTo(bus, onBus);
  sync();

  // ── the API ──
  function bindEndTurn(fn) {
    endTurnFn = typeof fn === 'function' ? fn : null;
    sync();
  }

  function ended(lock) {
    if (stopped || typeof endTurnFn !== 'function' || !isPlain(lock)) return false;
    sync();
    const ev = evidence.get(lock);
    if (!ev) return false;
    // An idle flip that Claude wrote past (the keep-alive moved started_at beyond
    // it) was not the turn's end.
    if (ev.by === 'idle' && Number.isFinite(lock.started_at) && !(ev.ts > lock.started_at)) return false;
    return { by: ev.by, ...(ev.ended_by !== undefined ? { ended_by: ev.ended_by } : {}) };
  }

  function closedRecently(session_id) {
    if (stopped || typeof session_id !== 'string' || !session_id) return false;
    prune();
    return closed.some((r) => r.session_id === session_id);
  }

  // The record a late Stop belongs to: the newest of its session, preferring the
  // one with its prompt_id.
  function pick(session_id, prompt_id) {
    let best = null;
    for (let i = closed.length - 1; i >= 0; i -= 1) {
      const r = closed[i];
      if (r.session_id !== session_id) continue;
      if (typeof prompt_id === 'string' && prompt_id && r.prompt_id === prompt_id) return r;
      if (!best) best = r;
    }
    return best;
  }

  const matchesKey = (f, key) => isPlain(f) && (f === key.ref
    || (!key.ref && f.ended === key.ended && Number.isFinite(f.at) && f.at >= key.since));

  function findFolded(key) {
    if (!key) return null;
    const pf = Array.isArray(graph.pendingFolded) ? graph.pendingFolded : [];
    const inPending = pf.find((f) => matchesKey(f, key));
    if (inPending) return { entry: inPending, node: null };
    // A commit took it since: it is a copy in that node's folded[].
    const plain = key.ref ? { ended: key.ref.ended, at: key.ref.at, message: key.ref.message } : null;
    const nodes = graph.nodes && typeof graph.nodes.values === 'function' ? [...graph.nodes.values()] : [];
    for (const node of nodes) {
      if (!isPlain(node) || !Array.isArray(node.folded)) continue;
      if (Number.isFinite(node.created_at) && node.created_at < key.since) continue;
      const entry = node.folded.find((f) => (plain
        ? isPlain(f) && f.at === plain.at && f.ended === plain.ended && f.message === plain.message
        : matchesKey(f, key)));
      if (entry) return { entry, node };
    }
    return null;
  }

  function reconcileLateStop({ session_id, prompt_id, reply, ended: how } = {}) {
    if (stopped || typeof session_id !== 'string' || !session_id) return null;
    prune();
    const rec = pick(session_id, prompt_id);
    if (!rec) return null;
    if (rec.done) return rec.target;
    rec.done = true;
    const rep = redactGraphText(graph, summarizeReply(reply));
    const end = how === 'failed' ? 'failed' : 'stop';
    // A Stop came, so the turn was not interrupted: the guard's ended_by goes.
    const patch = (o) => { if (rep) o.reply = rep; o.ended = end; delete o.ended_by; };
    try {
      if (rec.target === 'folded') {
        const hit = findFolded(rec.key);
        if (hit) {
          patch(hit.entry);
          if (hit.node) graph.writeNode(hit.node);
          else if (typeof graph.saveMeta === 'function') graph.saveMeta();
        }
      } else {
        const node = graph.nodes && typeof graph.nodes.get === 'function' ? graph.nodes.get(rec.target) : null;
        if (isPlain(node) && isPlain(node.trigger)) {
          patch(node.trigger);
          graph.writeNode(node);
        }
      }
    } catch { /* the node keeps what the guard wrote; the route still answers */ }
    return rec.target;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (cur) disarm(cur);
    cur = null;
    for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
    closed.length = 0;
  }

  return { bindEndTurn, ended, closedRecently, reconcileLateStop, stop };
}

module.exports = { createTurnGuard, BUSY_STATES, CLOSE_EVIDENCE, GONE_MS };

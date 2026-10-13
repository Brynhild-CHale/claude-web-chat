// lib/server/domain/bridge.js — the mod bridge (spec §15.7), `ctx.bridge`: the
// daemon's side of the web-chat mod, a plugin of function hooks running inside
// Claude Code (tier 2: behind a probe, never a dependency, ruling Q-A).
//
//   createBridge({ root, paths, hooks, mirror, now, log, timers, fsImpl,
//                  randomBytes, toggle })
//     → { hello, poll, result, events, enqueue, attached, sessionOf, any,
//         status, onChange, setPermissionWait, start, stop }
//
// Three things live here, and nothing else does:
//
//   THE REGISTRY of mod-attached sessions: {session_id, cc_version,
//   mod_version, token, attached_at, last_poll_at, queue, counters}. A hello
//   registers one and mints its token; a second hello for the same session
//   replaces the first (the old token then answers 401 'superseded'). The
//   hello carries no pid — the mod has no call that gives it one (notes-B §1,
//   H13) — so the session's process is the mirror's to know: a mirror
//   `process-gone` naming the session detaches it, as do a main-loop
//   SessionEnd on the hook tap, the mod's own session.end, and no poll for
//   STALE_MS.
//
//   THE OP QUEUE, one per session: enqueue(sessionId, {op, args}) validates
//   the op against the wire's allowlist (lib/core/mod-protocol validateOp —
//   every op allowlisted, no config-persisting command, no slash text as a
//   submit, no bypassPermissions), queues it, and wakes that session's
//   long-poll. An op not handed out by its expiry (deliverWithinMs) is
//   WITHDRAWN and never handed out later — a stale abort or resume must not
//   land late (§15.2's 2 s Esc expiry is the same rule) — and resolves
//   {ok: false, refused: 'timeout', delivered: false}; one handed out with no
//   result within resultWithinMs resolves {refused: 'no-result', delivered:
//   true}. The daemon never names a turn: `abort` aborts the mod's running one.
//
//   THE EVENT INTAKE: each event the mod posts is validated (validateEvent),
//   answered at once, and published AFTER the response, once, on the hook tap
//   as a synthetic envelope:
//
//     {v: 1, event: 'ModEvent', synthetic: true, ts, session_id,
//      mod: {kind, ...payload}, tool?}
//
//   with, for tool.call and tool.done, a `tool` section built by
//   lib/core/tool-input exactly as the hooks build theirs (re-projected here:
//   the mod's own bound is a transport cap, not the mirror projection).
//   The envelope is shaped to need no edit anywhere else: ModEvent is unknown
//   to the turn machine (ignored), the asks domain skips synthetic envelopes,
//   the turn guard reads only SessionEnd, mirror.ingest routes a synthetic
//   envelope by its session (unknown → ignored), and live.js counts it as
//   progress. Two kinds are never published: session.end (it detaches; a mod
//   event later than a SessionEnd would make live.js read an ended session as
//   alive) and diag (shape names, kept for status()).
//
//   ts is the event's `at` clamped to [the session's last ts + 1, now()], so
//   no two of one session's envelopes share the facade's envelope identity
//   (session|event|ts|…) and none runs ahead of the clock; an event that
//   cannot be stamped yet (a burst inside one millisecond) waits for the next.
//   At most TAP_RATE envelopes per second per session reach the tap — its
//   200-entry ring is shared with the asks domain's PreToolUse correlation —
//   and past it, consecutive turn.step deltas of one turn merge into one
//   envelope (published when the second turns over) and anything else is
//   dropped and counted.
//
// THE TOKEN is minted at hello (24 random bytes, hex), held in memory by both
// sides, compared with crypto.timingSafeEqual, and never logged, published,
// reported or written to disk (§15.7). It is not, and is never derived from,
// Claude Code's own messaging token, which nothing here reads.
//
// THE BRIDGE LOG, projectPaths(root).modDir/bridge.log, JSONL, one line per
// hello, refusal of a hello, detach (with its reason) and settled op:
// {at, what, session_id, cc_version?, mod_version?, op?, outcome?, ms?,
// reason?} — never an op's args, an event's text, a result or a token. Past
// 1 MiB it moves to bridge.log.1 (one generation, as the control audit). The
// mod directory is created only inside a .web-chat/ that still exists: a line
// that would re-create a removed .web-chat/ is dropped (tranche 5's instance
// guard reads a deleted .web-chat/ as the user saying stop). V33's and V35's
// validation scripts read it.
//
// TRANSPORT-INDEPENDENT. Every method takes and answers plain values
// ({status, body} for the route-facing four), so a later transport (the file
// channel ruled out of 0.8.5, C3 (b)) calls the same functions.
//
// LIFECYCLE. start() subscribes to the tap and the mirror and arms one sweep
// timer (every SWEEP_MS). stop() answers every waiter [], resolves every
// pending enqueue {refused: 'stopped'}, unsubscribes and clears every timer —
// all synchronously, so the daemon's runShutdown can release its registry
// record as its last synchronous step with nothing of the bridge left to
// await (tranche 5) — and returns an already-settled promise. It is
// idempotent.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { projectPaths, realpath } = require('../../core/paths');
const { compareVersions } = require('../../core/versions');
const {
  projectToolInput, toolKind, stepLabel, callLabel, inputHash,
} = require('../../core/tool-input');
const proto = require('../../core/mod-protocol');
const togglePolicy = require('../../toggle/policy');

const {
  MOD_PROTOCOL, MOD_EVENT, MOD_MIN_CLAUDE, OPS, EVENT_KINDS, BATCH_MAX, OPS_WAIT_MAX_MS, FLUSH_MS,
  QUEUE_MAX, WAITERS_MAX, STALE_MS, TAP_RATE, OPS_PER_POLL, TEXT_MAX, PERMISSION_WAIT_MAX_MS,
  validateOp, validateEvent, validateHello, validateResult,
} = proto;

const SWEEP_MS = 10000;
const RATE_WINDOW_MS = 1000;
const DISABLED_RETRY_MS = 30000;
const LOG_MAX_BYTES = 1024 * 1024;
const DELIVER_DEFAULT_MS = 3000;
const RESULT_DEFAULT_MS = 10000;
const WITHIN_MAX_MS = 10 * 60 * 1000;
const RETIRED_MAX = 64;
const OUTBOX_MAX = 500;
const CALLS_MAX = 256;
const TOKEN_RE = /^[0-9a-f]{48}$/;

const NODE_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
});

const HINTS = Object.freeze({
  token: 'say hello again: POST /api/bridge/hello',
  protocol: 'run claude-web-chat mod on again',
  tooOld: `the mod needs Claude Code ${MOD_MIN_CLAUDE} or newer`,
  wrongProject: 'this daemon serves another project: read server.json again',
  disabled: 'web-chat is switched off here',
  stopped: 'the web-chat server is shutting down',
  notAttached: 'no mod is attached to that session',
  queueFull: 'too many ops are waiting for that session',
});

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const answer = (status, body) => ({ status, body });

function sameRoot(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  const ra = realpath(a);
  return ra !== null && ra === realpath(b);
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createBridge({
  root, paths, hooks, mirror = null, now = Date.now, log = () => {}, timers = NODE_TIMERS,
  fsImpl = fs, randomBytes = crypto.randomBytes, toggle = togglePolicy,
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('createBridge: root is required');
  const p = paths || projectPaths(root);
  const logFile = path.join(p.modDir, 'bridge.log');
  const clock = () => {
    try { const t = now(); return Number.isFinite(t) ? t : Date.now(); } catch { return Date.now(); }
  };
  const say = (msg) => { try { log(msg); } catch {} };

  const sessions = new Map(); // session_id → record
  const retired = []; // [{buf, reason}] tokens that once were, newest last
  const listeners = new Set();
  const handles = new Set(); // every timer this bridge armed and has not cleared
  const immediates = new Set();
  const offs = [];
  const totals = {
    hellos: 0, refused: 0, detached: 0, ops_enqueued: 0, ops_refused: 0, ops_settled: 0,
    events_accepted: 0, events_dropped: 0, events_published: 0, events_merged: 0, events_rate_dropped: 0,
  };
  let permissionWaitMs = 0;
  let started = false;
  let stopped = false;
  let sweepHandle = null;
  let attachSeq = 0;

  // ── timers, all tracked ──
  function arm(fn, ms) {
    const h = timers.setTimeout(() => { handles.delete(h); fn(); }, Math.max(0, ms));
    handles.add(h);
    return h;
  }
  function disarm(h) {
    if (h == null) return;
    handles.delete(h);
    try { timers.clearTimeout(h); } catch {}
  }
  function soon(fn) {
    const h = setImmediate(() => { immediates.delete(h); fn(); });
    immediates.add(h);
  }

  // ── the bridge log ──
  function writeLog(fields) {
    const line = { at: clock(), ...fields };
    try {
      // Non-recursive: when .web-chat/ itself has gone, this fails with ENOENT
      // and the line is dropped, rather than bringing the folder back.
      try { fsImpl.mkdirSync(p.modDir); } catch (e) { if (!e || e.code !== 'EEXIST') return; }
      let size = 0;
      try { size = fsImpl.statSync(logFile).size; } catch {}
      if (size >= LOG_MAX_BYTES) fsImpl.renameSync(logFile, `${logFile}.1`);
      fsImpl.appendFileSync(logFile, `${JSON.stringify(line)}\n`);
    } catch (e) { say(`bridge: log write failed (${(e && e.code) || 'error'})`); }
  }

  function notify(info) {
    for (const fn of [...listeners]) {
      try { fn(info); } catch (e) { say(`bridge: an onChange listener failed: ${(e && e.message) || e}`); }
    }
  }

  function retire(s, reason) {
    retired.push({ buf: s.tokenBuf, reason });
    while (retired.length > RETIRED_MAX) retired.shift();
  }

  // ── auth ──
  function auth(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { fail: answer(401, { ok: false, refused: 'token', hint: HINTS.token }) };
    const buf = Buffer.from(token, 'utf8');
    for (const s of sessions.values()) if (safeEqual(s.tokenBuf, buf)) return { s };
    for (let i = retired.length - 1; i >= 0; i--) {
      if (safeEqual(retired[i].buf, buf)) return { fail: answer(401, { ok: false, refused: retired[i].reason, hint: HINTS.token }) };
    }
    return { fail: answer(401, { ok: false, refused: 'token', hint: HINTS.token }) };
  }

  // ── ops: settle, hand out, withdraw ──
  function settle(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    disarm(entry.deliverTimer);
    disarm(entry.resultTimer);
    const s = entry.session;
    const i = s.queue.indexOf(entry);
    if (i !== -1) s.queue.splice(i, 1);
    s.inflight.delete(entry.id);
    totals.ops_settled += 1;
    s.counters.ops_settled += 1;
    writeLog({
      what: 'op', session_id: s.session_id, op: entry.op,
      outcome: outcome.ok ? 'ok' : outcome.refused, ms: Math.max(0, clock() - entry.enqueued_at),
    });
    entry.resolve(outcome);
  }

  function withdrawExpired(s) {
    const t = clock();
    for (const entry of [...s.queue]) {
      if (entry.expires_at <= t) settle(entry, { ok: false, refused: 'timeout', hint: 'the mod did not take the op in time', delivered: false });
    }
  }

  function takeOps(s) {
    withdrawExpired(s);
    const out = [];
    while (s.queue.length && out.length < OPS_PER_POLL) {
      const entry = s.queue.shift();
      disarm(entry.deliverTimer);
      entry.deliverTimer = null;
      entry.handed = true;
      s.inflight.set(entry.id, entry);
      entry.resultTimer = arm(() => settle(entry, { ok: false, refused: 'no-result', hint: 'the mod took the op and did not answer', delivered: true }), entry.resultWithinMs);
      s.counters.ops_delivered += 1;
      out.push({ id: entry.id, op: entry.op, args: entry.args, expires_at: entry.expires_at });
    }
    return out;
  }

  function answerWaiter(s, ops) {
    const w = s.waiter;
    if (!w) return;
    s.waiter = null;
    disarm(w.timer);
    if (w.offAbort) w.offAbort();
    w.resolve(answer(200, { ok: true, ops }));
  }

  function waiterCount() {
    let n = 0;
    for (const s of sessions.values()) if (s.waiter) n += 1;
    return n;
  }

  // ── detach ──
  function detach(s, reason) {
    if (sessions.get(s.session_id) !== s) return;
    sessions.delete(s.session_id);
    retire(s, 'detached');
    answerWaiter(s, []);
    const outcome = reason === 'stopped'
      ? { ok: false, refused: 'stopped', hint: HINTS.stopped }
      : { ok: false, refused: 'detached', hint: 'the mod detached from that session' };
    for (const entry of [...s.queue, ...s.inflight.values()]) settle(entry, { ...outcome, delivered: entry.handed === true });
    s.outbox.length = 0;
    s.held = null;
    disarm(s.drainTimer);
    s.drainTimer = null;
    totals.detached += 1;
    writeLog({ what: 'detach', session_id: s.session_id, reason });
    say(`bridge: mod detached from session ${s.session_id} (${reason})`);
    notify({ session_id: s.session_id, attached: false, reason });
  }

  // ── hello ──
  function refuseHello(status, body, sessionId) {
    totals.refused += 1;
    writeLog({ what: 'refused', session_id: sessionId, outcome: body.refused || 'bad-request' });
    return answer(status, { ok: false, ...body });
  }

  function hello(body) {
    if (stopped) return answer(503, { ok: false, unavailable: true, hint: HINTS.stopped });
    const v = validateHello(body);
    const claimed = isPlain(body) && proto.isUuid(body.session_id) ? body.session_id.toLowerCase() : null;
    if (!v.ok) return refuseHello(400, { error: 'bad_request', refused: 'bad-request', hint: v.hint }, claimed);
    const h = v.hello;
    const sid = h.session_id;
    if (h.protocol !== MOD_PROTOCOL) return refuseHello(409, { refused: 'protocol', hint: HINTS.protocol }, sid);
    if (compareVersions(h.cc_version, MOD_MIN_CLAUDE) < 0) return refuseHello(409, { refused: 'too-old', hint: HINTS.tooOld }, sid);
    if (!sameRoot(h.root, root)) return refuseHello(409, { refused: 'wrong-project', hint: HINTS.wrongProject }, sid);
    let state = { enabled: true };
    try { state = toggle.resolve({ cwd: root, sessionId: sid }); } catch {}
    if (state && state.enabled === false) {
      return refuseHello(409, { refused: 'disabled', scope: state.by || null, retry_ms: DISABLED_RETRY_MS, hint: HINTS.disabled }, sid);
    }

    const token = randomBytes(24).toString('hex');
    const t = clock();
    const prev = sessions.get(sid);
    let s;
    if (prev) {
      // The same session saying hello again (the mod reloaded): the new token
      // replaces the old, and the session's queue carries over.
      retire(prev, 'superseded');
      answerWaiter(prev, []);
      s = prev;
    } else {
      s = {
        session_id: sid, queue: [], inflight: new Map(), waiter: null, outbox: [], held: null, drainTimer: null,
        last_ts: 0, rate: { start: 0, count: 0 }, calls: new Map(), shapes: {},
        counters: {
          ops_enqueued: 0, ops_delivered: 0, ops_settled: 0, events_accepted: 0, events_dropped: 0,
          events_published: 0, events_merged: 0, events_rate_dropped: 0,
        },
      };
      sessions.set(sid, s);
    }
    attachSeq += 1;
    Object.assign(s, {
      cc_version: h.cc_version, mod_version: h.mod_version, tokenBuf: Buffer.from(token, 'utf8'),
      attached_at: t, last_poll_at: t, seq: attachSeq,
    });
    totals.hellos += 1;
    writeLog({ what: 'hello', session_id: sid, cc_version: h.cc_version, mod_version: h.mod_version, reason: prev ? 'superseded' : undefined });
    say(`bridge: mod attached to session ${sid} (Claude Code ${h.cc_version}, mod ${h.mod_version})`);
    notify({ session_id: sid, attached: true, reason: prev ? 'superseded' : 'hello' });
    return answer(200, {
      ok: true,
      token,
      protocol: MOD_PROTOCOL,
      wait_max_ms: OPS_WAIT_MAX_MS,
      flush_ms: FLUSH_MS,
      permission_wait_ms: permissionWaitMs,
      ops: OPS.filter((o) => h.ops.includes(o)),
      events: EVENT_KINDS.filter((k) => h.events.includes(k)),
    });
  }

  // ── poll ──
  function poll(token, { waitMs = 0, signal = null } = {}) {
    if (stopped) return Promise.resolve(answer(200, { ok: true, ops: [] }));
    const a = auth(token);
    if (a.fail) return Promise.resolve(a.fail);
    const s = a.s;
    s.last_poll_at = clock();
    const ops = takeOps(s);
    if (ops.length) return Promise.resolve(answer(200, { ok: true, ops }));
    const wait = Math.min(OPS_WAIT_MAX_MS, Math.max(0, Math.floor(Number(waitMs) || 0)));
    if (wait === 0) return Promise.resolve(answer(200, { ok: true, ops: [] }));
    answerWaiter(s, []); // a second poll for one session answers the first
    if (waiterCount() >= WAITERS_MAX) return Promise.resolve(answer(200, { ok: true, ops: [] }));
    if (signal && signal.aborted) return Promise.resolve(answer(200, { ok: true, ops: [] }));
    return new Promise((resolve) => {
      const w = { resolve, timer: null, offAbort: null };
      w.timer = arm(() => { if (s.waiter === w) answerWaiter(s, []); }, wait);
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => { if (s.waiter === w) answerWaiter(s, []); };
        signal.addEventListener('abort', onAbort, { once: true });
        w.offAbort = () => signal.removeEventListener('abort', onAbort);
      }
      s.waiter = w;
    });
  }

  // ── enqueue ──
  function within(v, dflt, name) {
    if (v === undefined) return dflt;
    if (!(Number.isFinite(v) && v > 0 && v <= WITHIN_MAX_MS)) throw new TypeError(`bridge.enqueue: ${name} must be 1-${WITHIN_MAX_MS} ms`);
    return v;
  }

  function newOpId(s) {
    for (;;) {
      const id = `op_${clock().toString(36)}${randomBytes(2).toString('hex')}`;
      if (!s.inflight.has(id) && !s.queue.some((e) => e.id === id)) return id;
    }
  }

  function enqueue(sessionId, { op, args } = {}, { deliverWithinMs, resultWithinMs } = {}) {
    const deliver = within(deliverWithinMs, DELIVER_DEFAULT_MS, 'deliverWithinMs');
    const resultMs = within(resultWithinMs, RESULT_DEFAULT_MS, 'resultWithinMs');
    if (stopped) return Promise.resolve({ ok: false, refused: 'stopped', hint: HINTS.stopped, delivered: false });
    const v = validateOp(op, args);
    if (!v.ok) {
      totals.ops_refused += 1;
      return Promise.resolve({ ok: false, refused: v.refused, hint: v.hint, delivered: false });
    }
    const sid = typeof sessionId === 'string' ? sessionId.toLowerCase() : null;
    const s = sid ? sessions.get(sid) : null;
    if (!s) {
      totals.ops_refused += 1;
      return Promise.resolve({ ok: false, refused: 'not-attached', hint: HINTS.notAttached, delivered: false });
    }
    withdrawExpired(s);
    if (s.queue.length >= QUEUE_MAX) {
      totals.ops_refused += 1;
      return Promise.resolve({ ok: false, refused: 'queue-full', hint: HINTS.queueFull, delivered: false });
    }
    return new Promise((resolve) => {
      const t = clock();
      const entry = {
        id: newOpId(s), op, args: v.args, expires_at: t + deliver, enqueued_at: t, resultWithinMs: resultMs,
        session: s, resolve, settled: false, handed: false, deliverTimer: null, resultTimer: null,
      };
      entry.deliverTimer = arm(() => {
        if (!entry.handed) settle(entry, { ok: false, refused: 'timeout', hint: 'the mod did not take the op in time', delivered: false });
      }, deliver);
      s.queue.push(entry);
      totals.ops_enqueued += 1;
      s.counters.ops_enqueued += 1;
      if (s.waiter) answerWaiter(s, takeOps(s));
    });
  }

  // ── result ──
  function result(token, body) {
    if (stopped) return answer(503, { ok: false, unavailable: true, hint: HINTS.stopped });
    const a = auth(token);
    if (a.fail) return a.fail;
    const s = a.s;
    const v = validateResult(body);
    if (!v.ok) {
      if (v.refused === 'too-large') {
        const entry = s.inflight.get(v.id);
        if (!entry) return answer(404, { ok: false, refused: 'unknown-op' });
        settle(entry, { ok: false, refused: 'too-large', hint: v.hint, delivered: true });
        return answer(413, { ok: false, refused: 'too-large', hint: v.hint });
      }
      return answer(400, { ok: false, error: 'bad_request', hint: v.hint });
    }
    const r = v.result;
    const entry = s.inflight.get(r.id);
    if (!entry) return answer(404, { ok: false, refused: 'unknown-op' });
    if (r.ok) settle(entry, { ok: true, result: r.result === undefined ? null : r.result });
    else {
      settle(entry, {
        ok: false, refused: r.refused || 'failed', ...(r.error ? { error: r.error } : {}), delivered: true,
      });
    }
    return answer(200, { ok: true });
  }

  // ── events ──
  function toolSection(name, useId, input) {
    let projected;
    try { projected = projectToolInput(name, input, { profile: 'mirror' }).input; } catch { projected = { truncated: true }; }
    let hash = null;
    if (input !== undefined) {
      try { hash = inputHash(input); } catch { hash = null; }
    }
    return {
      name: typeof name === 'string' ? name : null,
      use_id: useId,
      kind: toolKind(name),
      label: stepLabel(name, input),
      call: callLabel(name, input),
      input: projected,
      input_hash: hash,
    };
  }

  function stampFor(s, at, t) {
    const base = Number.isFinite(at) ? Math.min(Math.floor(at), t) : t;
    return Math.max(base, s.last_ts + 1);
  }

  function publishOne(s, ev, ts) {
    const { kind, at: _at, ...payload } = ev;
    const env = {
      v: 1, event: MOD_EVENT, synthetic: true, ts, session_id: s.session_id, mod: { kind, ...payload },
    };
    if (kind === 'tool.call') {
      s.calls.set(ev.tool_use_id, { name: ev.tool, input: ev.input });
      while (s.calls.size > CALLS_MAX) s.calls.delete(s.calls.keys().next().value);
      env.tool = toolSection(ev.tool, ev.tool_use_id, ev.input);
    } else if (kind === 'tool.done') {
      const call = s.calls.get(ev.tool_use_id) || { name: null, input: undefined };
      s.calls.delete(ev.tool_use_id);
      env.tool = toolSection(call.name, ev.tool_use_id, call.input);
    }
    s.last_ts = ts;
    s.rate.count += 1;
    s.counters.events_published += 1;
    totals.events_published += 1;
    try { hooks.publish(env); } catch (e) { say(`bridge: publish failed: ${(e && e.message) || e}`); }
  }

  function mergeShapes(s, shapes) {
    for (const [k, list] of Object.entries(shapes || {})) {
      if (Object.keys(s.shapes).length >= 32 && !Object.hasOwn(s.shapes, k)) continue;
      s.shapes[k] = [...new Set([...(s.shapes[k] || []), ...list])].slice(0, 64);
    }
  }

  function mergeStep(s, ev) {
    if (s.held && s.held.turn_id === ev.turn_id) {
      const h = s.held;
      h.delta = (h.delta + ev.delta).slice(0, TEXT_MAX);
      h.index = ev.index;
      if (ev.message_id) h.message_id = ev.message_id;
      h.at = ev.at;
      h.merged += 1;
    } else if (!s.held) {
      s.held = { ...ev, merged: 1 };
    } else {
      return false;
    }
    s.counters.events_merged += 1;
    totals.events_merged += 1;
    return true;
  }

  function scheduleDrain(s, ms) {
    if (s.drainTimer) return;
    s.drainTimer = arm(() => { s.drainTimer = null; drain(s); }, ms);
  }

  // Publish what the session's outbox holds, in order, inside the rate cap.
  function drain(s) {
    if (s.drainTimer) { disarm(s.drainTimer); s.drainTimer = null; }
    while (!stopped && sessions.get(s.session_id) === s) {
      const t = clock();
      if (t >= s.rate.start + RATE_WINDOW_MS) { s.rate.start = t; s.rate.count = 0; }
      if (s.held && s.rate.count < TAP_RATE) {
        const ts = stampFor(s, s.held.at, t);
        if (ts > t) { scheduleDrain(s, 1); return; }
        const held = s.held;
        s.held = null;
        publishOne(s, held, ts);
        continue;
      }
      if (!s.outbox.length) break;
      const ev = s.outbox[0];
      if (ev.kind === 'session.end') { s.outbox.shift(); detach(s, 'session-end'); return; }
      if (ev.kind === 'diag') { s.outbox.shift(); mergeShapes(s, ev.shapes); continue; }
      if (s.rate.count >= TAP_RATE) {
        s.outbox.shift();
        if (!(ev.kind === 'turn.step' && mergeStep(s, ev))) {
          s.counters.events_rate_dropped += 1;
          totals.events_rate_dropped += 1;
        }
        continue;
      }
      const ts = stampFor(s, ev.at, t);
      if (ts > t) { scheduleDrain(s, 1); return; }
      s.outbox.shift();
      publishOne(s, ev, ts);
    }
    if (s.held && sessions.get(s.session_id) === s) scheduleDrain(s, Math.max(1, s.rate.start + RATE_WINDOW_MS - clock()));
  }

  function events(token, body) {
    if (stopped) return answer(503, { ok: false, unavailable: true, hint: HINTS.stopped });
    const a = auth(token);
    if (a.fail) return a.fail;
    const s = a.s;
    if (!isPlain(body) || Object.keys(body).some((k) => k !== 'events') || !Array.isArray(body.events)) {
      return answer(400, { ok: false, error: 'bad_request', hint: 'events takes {events: [...]}' });
    }
    if (body.events.length > BATCH_MAX) {
      return answer(400, { ok: false, error: 'bad_request', hint: `at most ${BATCH_MAX} events per batch` });
    }
    const accepted = [];
    let dropped = 0;
    for (const raw of body.events) {
      const ev = isPlain(raw) ? validateEvent(raw.kind, raw) : null;
      if (ev && s.outbox.length + accepted.length < OUTBOX_MAX) accepted.push(ev);
      else dropped += 1;
    }
    s.counters.events_accepted += accepted.length;
    s.counters.events_dropped += dropped;
    totals.events_accepted += accepted.length;
    totals.events_dropped += dropped;
    if (accepted.length) {
      s.outbox.push(...accepted);
      soon(() => drain(s));
    }
    return answer(200, { ok: true, accepted: accepted.length, dropped });
  }

  // ── reads ──
  function attached(sessionId) {
    return typeof sessionId === 'string' && sessions.has(sessionId.toLowerCase());
  }

  function sessionOf(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId || !mirror || typeof mirror.conversationOf !== 'function') return null;
    let cid = null;
    try { cid = mirror.conversationOf(conversationId) || conversationId; } catch { return null; }
    let best = null;
    for (const s of sessions.values()) {
      let c = null;
      try { c = mirror.conversationOf(s.session_id); } catch {}
      if (c === cid && (!best || s.seq > best.seq)) best = s;
    }
    return best ? best.session_id : null;
  }

  function any() {
    return sessions.size > 0;
  }

  function status() {
    return {
      ok: true,
      protocol: MOD_PROTOCOL,
      min_claude: MOD_MIN_CLAUDE,
      running: started && !stopped,
      permission_wait_ms: permissionWaitMs,
      sessions: [...sessions.values()].map((s) => ({
        session_id: s.session_id,
        cc_version: s.cc_version,
        mod_version: s.mod_version,
        attached_at: s.attached_at,
        last_poll_at: s.last_poll_at,
        polling: s.waiter !== null,
        queued: s.queue.length,
        inflight: s.inflight.size,
        counters: { ...s.counters },
        shapes: JSON.parse(JSON.stringify(s.shapes)),
      })),
      counters: { ...totals },
    };
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('bridge.onChange: fn must be a function');
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  function setPermissionWait(ms) {
    if (!(Number.isSafeInteger(ms) && ms >= 0 && ms <= PERMISSION_WAIT_MAX_MS)) {
      throw new TypeError(`bridge.setPermissionWait: 0-${PERMISSION_WAIT_MAX_MS} ms, an integer`);
    }
    permissionWaitMs = ms;
  }

  // ── lifecycle ──
  function sweep() {
    sweepHandle = null;
    if (stopped) return;
    const t = clock();
    for (const s of [...sessions.values()]) {
      if (!s.waiter && t - s.last_poll_at > STALE_MS) detach(s, 'stale');
    }
    sweepHandle = arm(sweep, SWEEP_MS);
  }

  function onHook(env) {
    if (!isPlain(env) || env.event !== 'SessionEnd' || env.synthetic === true || isPlain(env.agent)) return;
    const sid = typeof env.session_id === 'string' ? env.session_id.toLowerCase() : null;
    const s = sid ? sessions.get(sid) : null;
    if (s) detach(s, 'session-end');
  }

  function onMirror(e) {
    if (!isPlain(e) || e.op !== 'process-gone' || !Array.isArray(e.session_ids)) return;
    for (const id of e.session_ids) {
      const s = typeof id === 'string' ? sessions.get(id.toLowerCase()) : null;
      if (s) detach(s, 'process-gone');
    }
  }

  function start() {
    if (started || stopped) return;
    started = true;
    if (hooks && typeof hooks.subscribe === 'function') offs.push(hooks.subscribe(onHook));
    if (mirror && typeof mirror.subscribe === 'function') {
      try { offs.push(mirror.subscribe(onMirror)); } catch (e) { say(`bridge: mirror subscribe failed: ${(e && e.message) || e}`); }
    }
    sweepHandle = arm(sweep, SWEEP_MS);
  }

  function stop() {
    if (stopped) return Promise.resolve();
    stopped = true;
    for (const s of [...sessions.values()]) detach(s, 'stopped');
    for (const off of offs.splice(0)) { try { off(); } catch {} }
    disarm(sweepHandle);
    sweepHandle = null;
    for (const h of [...handles]) disarm(h);
    for (const h of [...immediates]) clearImmediate(h);
    immediates.clear();
    listeners.clear();
    return Promise.resolve();
  }

  return {
    hello, poll, result, events, enqueue, attached, sessionOf, any, status, onChange, setPermissionWait, start, stop,
  };
}

module.exports = { createBridge, SWEEP_MS, RATE_WINDOW_MS, DISABLED_RETRY_MS, LOG_MAX_BYTES, HINTS };

// lib/server/control/interrupt.js — the interrupt (spec §15.2, Q-B): the
// control domain's `interrupt` row, the halt flag's whole life, and the Stop
// layout's state view.
//
//   createInterrupt({mirror, bus, userPaths, now, log, fsImpl})
//     → { row, onMirror(event), sweep(), stop(), addPath(fn) → remove, flags() }
//   HALT_TTL_S = 1800, TTY_EXPIRY_MS = 2000, INTERRUPT_GAP_MS = 1500
//
// createControl (./index.js) installs `row` as the action 'interrupt' (fields
// conversation_id and mode; the layout 'stop'), feeds onMirror every mirror
// transition, calls sweep() at start and stop() at stop. Nothing else here is
// reachable: the action runs only through control.invoke, which the answer
// origin's gate calls (§15.5) — no route on the main origin.
//
// ── interrupt({conversation_id, mode: 'now'|'after-step'}, {remote, device}) ─
//   1. the conversation, from mirror.snapshot({level: 'local'}): unknown →
//      refused 'unknown';
//   2. its live state not in ACTIVE_STATES (live.js's, imported — ruling
//      U31b@busy-states-copy) → refused 'not-busy';
//   3. the limiter (once per INTERRUPT_GAP_MS per conversation) is invoke's;
//   4. the first path that applies:
//        [a path addPath() put first — tranche 6's mod abort; none in T4]
//        tty   mode 'now', a LOCAL request (Q-B: the injection is local only),
//              process.interrupt 'tty' and a pid → the event carries
//              target_pid = the Claude Code process, expires_at = now + 2 s;
//        hook  a session id passing isSafeId → the halt flag
//              userPaths().haltFlag(sid) holds floor(now/1000) + HALT_TTL_S,
//              written by writeJsonAtomic (JSON's form of a number is the
//              digits the halt script reads; notes-B decision 3); the event's
//              expires_at is that expiry in epoch SECONDS (U12b #7). A remote
//              'now' takes this path (ruling B2 (a): built now, dormant behind
//              the answer surface's remote refusal until U74), and so does
//              every 'after-step';
//        else  refused 'no-path';
//   5. exactly ONE main-bus event, ring and SSE only — never a ws frame:
//        {kind: 'control', op: 'interrupt', id, conversation_id, session_id,
//         via, target_pid?, expires_at}
//      The mirror facade reads who stopped the turn from it (§2.6, C41) and the
//      session's Esc injector (lib/mcp/interrupt.js) acts on a 'tty' one
//      addressed to its parent. Nothing is emitted for a refusal.
//   6. → {ok: true, accepted: true, via, request_id} | {ok: false, refused, hint}
//
// ── the halt flag's life (notes-B decision 4) ─────────────────────────────────
// A flag must never outlive its turn, or the next turn would stop at its first
// tool. This module remembers every flag it wrote, per session, and removes it
// when the mirror reports that session's turn closed or its process gone, and
// at stop(). At start it sweeps only EXPIRED flags: the halt directory is per
// user and shared by every project's daemon, so a live flag there is another
// daemon's Stop and never ours to delete. Every look is an lstat; only a
// regular file whose name is a safe session id is read or removed — a symlink
// is never followed, read or unlinked.
//
// ── the Stop layout's state view (U85) ───────────────────────────────────────
//   {v, conversation_id, state, active, waiting, path: 'tty'|'hook'|null,
//    label: 'Interrupt'|'Stop after this step',
//    last: null | {request_id, via, at, outcome: 'pending'|'interrupted'|'ended'}}
// `path` is the one a 'now' request from THIS requester would take (a remote
// requester never gets 'tty'); `waiting` is a pending prompt, which an Esc
// declines. `last.outcome` leaves 'pending' when, after the request, the mirror
// reports the conversation leaving the active states or a turn closed
// interrupted ('interrupted'), or its process gone ('ended'). `v` bumps on each
// change; state(…, {v, waitMs}) long-polls until it differs (32 waiters at most,
// each bounded by its wait, every one released at stop()).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { userPaths: defaultUserPaths, isSafeId } = require('../../core/paths');
const { writeJsonAtomic } = require('../../core/fsjson');
const { ACTIVE_STATES } = require('../mirror/live');

const HALT_TTL_S = 1800;
const TTY_EXPIRY_MS = 2000;
const INTERRUPT_GAP_MS = 1500;

const MODES = Object.freeze(['now', 'after-step']);
// The mirror's conversation id grammar (lib/server/mirror/model.js ID_RE).
const CONVERSATION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_WAITERS = 32;
const MAX_VIEWS = 256;
// A flag's first line: decimal epoch seconds, as the halt script reads it.
const EXPIRY_RE = /^(\d{1,12})(?:\s|$)/;
const FLAG_READ_MAX = 64;

const LABELS = Object.freeze({ tty: 'Interrupt', mod: 'Interrupt', hook: 'Stop after this step' });

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPidValue = (p) => Number.isSafeInteger(p) && p > 0;

function badTarget(msg) {
  const e = new TypeError(msg);
  e.code = 'bad-target';
  return e;
}

function requestId(t) {
  return `ci_${Math.max(0, Math.floor(t)).toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

function createInterrupt({
  mirror = null,
  bus = null,
  userPaths = defaultUserPaths,
  now = Date.now,
  log = () => {},
  fsImpl = fs,
} = {}) {
  const say = (m) => { try { log(m); } catch {} };
  const up = () => (typeof userPaths === 'function' ? userPaths() : userPaths);
  const extraPaths = []; // addPath()'s, tried before tty and hook
  const flags = new Map(); // session id → {file, cid, expires}
  const views = new Map(); // conversation id → {v, sig, last}
  const waiters = new Set();
  let stopped = false;

  // ── the conversation, as the mirror's snapshot holds it ───────────────────
  function conversation(cid) {
    if (!mirror || typeof mirror.snapshot !== 'function') return null;
    let snap = null;
    try { snap = mirror.snapshot({ level: 'local' }); } catch (e) { say(`control: snapshot failed (${e && e.code || 'error'})`); return null; }
    const list = snap && Array.isArray(snap.conversations) ? snap.conversations : [];
    return list.find((c) => isPlain(c) && c.id === cid) || null;
  }
  const stateOf = (c) => (c && isPlain(c.live) && typeof c.live.state === 'string' ? c.live.state : null);
  const sessionOf = (c) => (c && isSafeId(c.current_session_id) ? c.current_session_id : null);
  const ttyOf = (c) => {
    const p = c && isPlain(c.process) ? c.process : null;
    return p && p.interrupt === 'tty' && isPidValue(p.pid) ? p.pid : null;
  };

  // The path a request would take, before any write. → {via, pid?, sid?} | null.
  function choosePath(c, mode, remote) {
    const pid = ttyOf(c);
    if (mode === 'now' && !remote && pid) return { via: 'tty', pid, sid: sessionOf(c) };
    const sid = sessionOf(c);
    if (sid) return { via: 'hook', sid };
    return null;
  }

  // ── the halt flag ─────────────────────────────────────────────────────────
  function writeFlag(sid, cid) {
    const file = up().haltFlag(sid);
    if (!file) return null;
    const expires = Math.floor(now() / 1000) + HALT_TTL_S;
    writeJsonAtomic(file, expires, { pretty: 0 });
    flags.set(sid, { file, cid, expires });
    return expires;
  }

  // Remove a regular file, never what a symlink points at. → true if removed.
  function unlinkRegular(file) {
    let st;
    try { st = fsImpl.lstatSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    try { fsImpl.unlinkSync(file); return true; } catch { return false; }
  }

  function removeFlag(sid) {
    const rec = flags.get(sid);
    if (!rec) return false;
    flags.delete(sid);
    return unlinkRegular(rec.file);
  }

  // Only expired flags: a live one is another daemon's Stop.
  function sweep() {
    let dir;
    try { dir = up().haltDir; } catch { return 0; }
    let st;
    try { st = fsImpl.lstatSync(dir); } catch { return 0; }
    if (!st.isDirectory()) return 0; // a symlinked halt dir is never walked
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch { return 0; }
    const nowS = Math.floor(now() / 1000);
    let swept = 0;
    for (const name of names) {
      if (!isSafeId(name)) continue;
      const file = path.join(dir, name);
      let fst;
      try { fst = fsImpl.lstatSync(file); } catch { continue; }
      if (!fst.isFile()) continue;
      let head = '';
      try {
        const fd = fsImpl.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const buf = Buffer.alloc(FLAG_READ_MAX);
          const n = fsImpl.readSync(fd, buf, 0, FLAG_READ_MAX, 0);
          head = buf.subarray(0, n).toString('utf8');
        } finally { fsImpl.closeSync(fd); }
      } catch { continue; }
      const m = EXPIRY_RE.exec(head);
      if (!m) continue; // not a flag this format knows: leave it
      if (Number(m[1]) > nowS) continue; // live: never ours to delete
      if (unlinkRegular(file)) swept += 1;
    }
    return swept;
  }

  // ── the state view ────────────────────────────────────────────────────────
  function entryOf(cid) {
    let e = views.get(cid);
    if (!e) {
      e = { v: 0, sig: null, last: null };
      views.set(cid, e);
      while (views.size > MAX_VIEWS) views.delete(views.keys().next().value);
    }
    return e;
  }

  function viewOf(cid, reqCtx = {}) {
    const remote = reqCtx.remote === true;
    const c = conversation(cid);
    const state = stateOf(c);
    const e = entryOf(cid);
    const tty = ttyOf(c) != null;
    const sid = sessionOf(c) != null;
    const last = e.last ? { ...e.last } : null;
    // The requester-independent facts: `path` is derived from them per caller,
    // so two callers never bump v back and forth.
    const sig = JSON.stringify([c ? 1 : 0, state, tty, sid, last]);
    if (sig !== e.sig) { e.sig = sig; e.v += 1; }
    const p = c ? choosePath(c, 'now', remote) : null;
    const via = p ? p.via : null;
    return {
      v: e.v,
      conversation_id: cid,
      state,
      active: ACTIVE_STATES.includes(state),
      waiting: state === 'waiting' || state === 'question',
      path: via,
      label: via === 'hook' ? LABELS.hook : LABELS.tty,
      last,
    };
  }

  function finishWaiter(w, view) {
    if (!waiters.has(w)) return;
    waiters.delete(w);
    clearTimeout(w.timer);
    let out = view;
    if (!out) { try { out = viewOf(w.cid, w.reqCtx); } catch { out = null; } }
    w.resolve(out);
  }

  function notify(cid) {
    if (!waiters.size) return;
    for (const w of [...waiters]) {
      if (w.cid !== cid) continue;
      let view = null;
      try { view = viewOf(cid, w.reqCtx); } catch { continue; }
      if (view.v !== w.v) finishWaiter(w, view);
    }
  }
  // After the writer that emitted the transition has finished its own model
  // write (a microtask, so no timer is ever left behind).
  const notifySoon = (cid) => { if (waiters.size) queueMicrotask(() => notify(cid)); };

  function state(target, reqCtx = {}, { v = null, waitMs = 0 } = {}) {
    const cid = target.conversation_id;
    const view = viewOf(cid, reqCtx);
    if (stopped || !(waitMs > 0) || v == null || view.v !== v || waiters.size >= MAX_WAITERS) return Promise.resolve(view);
    return new Promise((resolve) => {
      const w = { cid, v, reqCtx, resolve, timer: null };
      w.timer = setTimeout(() => finishWaiter(w, null), waitMs);
      waiters.add(w);
    });
  }

  function setLast(cid, last) {
    entryOf(cid).last = last;
    notifySoon(cid);
  }
  function settleLast(cid, outcome) {
    const e = views.get(cid);
    if (!e || !e.last || e.last.outcome !== 'pending') return;
    e.last = { ...e.last, outcome };
  }

  // ── the mirror's transitions ──────────────────────────────────────────────
  function onMirror(ev) {
    if (!isPlain(ev) || ev.kind !== 'mirror' || stopped) return;
    const cid = typeof ev.conversation_id === 'string' ? ev.conversation_id : null;
    if (ev.op === 'turn-closed') {
      if (isSafeId(ev.session_id)) removeFlag(ev.session_id);
      else if (cid) for (const [sid, rec] of [...flags]) if (rec.cid === cid) removeFlag(sid);
      if (cid && ev.outcome === 'interrupted') settleLast(cid, 'interrupted');
    } else if (ev.op === 'process-gone') {
      const sids = Array.isArray(ev.session_ids) ? ev.session_ids : [];
      for (const sid of sids) if (isSafeId(sid)) removeFlag(sid);
      if (cid) for (const [sid, rec] of [...flags]) if (rec.cid === cid) removeFlag(sid);
      if (cid) settleLast(cid, 'ended');
    } else if (ev.op === 'state') {
      if (cid && typeof ev.state === 'string' && !ACTIVE_STATES.includes(ev.state)) settleLast(cid, 'interrupted');
    }
    if (cid) notifySoon(cid);
  }

  // ── the row ───────────────────────────────────────────────────────────────
  function params(q) {
    if (!isPlain(q)) throw badTarget('the target must be an object');
    const cid = q.conversation_id;
    if (typeof cid !== 'string' || !CONVERSATION_RE.test(cid)) throw badTarget('conversation_id must be a conversation id');
    const mode = q.mode === undefined ? 'now' : q.mode;
    if (!MODES.includes(mode)) throw badTarget("mode must be 'now' or 'after-step'");
    return { conversation_id: cid, mode };
  }

  async function check(target) {
    const c = conversation(target.conversation_id);
    if (!c) return { refused: 'unknown', hint: 'no such conversation in this project' };
    if (!ACTIVE_STATES.includes(stateOf(c))) return { refused: 'not-busy', hint: 'Claude is not working in that conversation right now' };
    return null;
  }

  async function run(target, reqCtx = {}) {
    if (stopped) return { ok: false, refused: 'stopped', hint: 'the daemon is stopping' };
    const remote = reqCtx.remote === true;
    const cid = target.conversation_id;
    const mode = target.mode;
    const c = conversation(cid);
    if (!c) return { ok: false, refused: 'unknown', hint: 'no such conversation in this project' };
    if (!ACTIVE_STATES.includes(stateOf(c))) return { ok: false, refused: 'not-busy', hint: 'Claude is not working in that conversation right now' };
    const t = now();
    const id = requestId(t);
    const sid = sessionOf(c);
    let delivered = null; // {via, target_pid?, expires_at}

    for (const fn of extraPaths) {
      let r = null;
      try { r = await fn({ conversation: c, target, reqCtx, request_id: id }); } catch (e) { say(`control: interrupt path failed (${e && e.code || 'error'})`); r = null; }
      if (isPlain(r) && typeof r.via === 'string') { delivered = r; break; }
    }
    if (!delivered) {
      const p = choosePath(c, mode, remote);
      if (p && p.via === 'tty') {
        delivered = { via: 'tty', target_pid: p.pid, expires_at: t + TTY_EXPIRY_MS };
      } else if (p && p.via === 'hook') {
        let expires = null;
        try { expires = writeFlag(p.sid, cid); } catch (e) { say(`control: halt flag not written (${e && e.code || 'error'})`); expires = null; }
        if (expires == null) return { ok: false, refused: 'failed', hint: 'the halt flag could not be written' };
        delivered = { via: 'hook', expires_at: expires };
      }
    }
    if (!delivered) return { ok: false, refused: 'no-path', hint: 'this conversation can be stopped only in its terminal' };

    const event = { kind: 'control', op: 'interrupt', id, conversation_id: cid, session_id: sid, via: delivered.via };
    if (isPidValue(delivered.target_pid)) event.target_pid = delivered.target_pid;
    event.expires_at = delivered.expires_at;
    if (bus && typeof bus.emit === 'function') {
      try { bus.emit({ event }); } catch (e) { say(`control: interrupt event failed (${e && e.code || 'error'})`); }
    }
    setLast(cid, { request_id: id, via: delivered.via, at: t, outcome: 'pending' });
    return { ok: true, accepted: true, via: delivered.via, request_id: id };
  }

  async function describe(target) {
    const c = conversation(target.conversation_id);
    const name = c && typeof c.name === 'string' && c.name ? c.name.slice(0, 200) : null;
    return { title: name, summary: 'Stop Claude in this conversation' };
  }

  const row = Object.freeze({
    fields: Object.freeze(['conversation_id', 'mode']),
    layouts: Object.freeze(['stop']),
    limit: Object.freeze({ scope: 'conversation', ms: INTERRUPT_GAP_MS }),
    params,
    key: (target) => target.conversation_id,
    describe,
    check,
    run,
    state,
  });

  function addPath(fn) {
    if (typeof fn !== 'function') throw new TypeError('addPath needs a function');
    extraPaths.push(fn);
    return () => { const i = extraPaths.indexOf(fn); if (i >= 0) extraPaths.splice(i, 1); };
  }

  function stop() {
    stopped = true;
    for (const sid of [...flags.keys()]) removeFlag(sid);
    for (const w of [...waiters]) finishWaiter(w, null);
  }

  return {
    row,
    onMirror,
    sweep,
    stop,
    addPath,
    flags: () => [...flags].map(([session_id, r]) => ({ session_id, file: r.file, expires: r.expires })),
  };
}

module.exports = { createInterrupt, HALT_TTL_S, TTY_EXPIRY_MS, INTERRUPT_GAP_MS };

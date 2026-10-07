// lib/server/queue-release.js — the composer queue's messages in motion (spec
// §6.4, §6.6; U63).
//
// The queue domain (lib/server/domain/queue.js) keeps the messages, delivers a
// batch (wake or park) and keeps each message's receipt. This module decides
// WHEN a message goes and to WHOM, and moves receipts on from the transcript:
//
//   createQueueRelease({state, bus, graph, mirror, asks, now, setTimer,
//                       clearTimer, delayMs, unconfirmedMs, confirmVerified, log})
//     → {send(item, {mode, prov}), claudeFree(cid), targetFor(items), start(), stop()}
//
// THE CONVERSATION of a message is its own conversation_id, else the mirror's
// primary (snapshot({level: 'basic'}).primary); null with no mirror.
//
// claudeFree(cid) — Claude is free for that conversation when:
//   * no FRESH graph lock is held by it: a lock whose claude_pid the mirror maps
//     to cid (conversationOfPid; a session_id the facade's optional
//     conversationOf maps to cid counts the same), or a lock that records
//     neither session_id nor claude_pid (a wake's, a page's: it counts for every
//     conversation). Another conversation's lock does not count. Staleness is
//     turns.js's own rule (lockIsStale), never a copy. Nothing here reads
//     prompt_id (a join keeps the lock's, U30);
//   * no ask is pending for it (asks.pending(), by conversation_id);
//   * its live state is 'idle' whenever the mirror knows it ('unknown' or no
//     live object is not knowing it).
//
// send(item, {mode, prov}) — what the queue routes call (ctx.queueRelease):
//   'now'   release at once, targeted; for an ended conversation, or one
//           whose process is gone, the same explicit park as 'auto' (U63b);
//   'auto'  §6.4's table: idle, or unknown (no live state, no mirror) → release
//           now; working, question, waiting, compacting, suspended (it resumes
//           into working) → stay queued (autosend), answering
//           {mode: 'queued', position} (1-based among that conversation's
//           autosend messages, oldest first: the tray's `next`, `#2`); ended,
//           or a process the mirror reports gone → release now as an explicit
//           park (deliver's `park: true`, U63b) for the next prompt typed in the
//           project — never a live wake another session's bridge would run —
//           untargeted (a park aimed at a dead pid would wait for ever, U61b).
//           FIFO per conversation (U63b): while older autosend messages of its
//           conversation still wait, a free conversation's message queues
//           behind them too, and the boundary timers (armed by send when none
//           is) release in order.
//   Every release goes through queue.release (the one delivery path) with
//   target_pid = targetFor([item]) and the provenance it was handed.
//
// targetFor(items) → the pid of mirror.liveOf(cid).process when every message
// resolves to the same live pid, else null (best effort: untargeted).
//
// BOUNDARIES (autosend). A graph `turn-end`, `turn-skipped` or `unlock` on the
// main bus names no conversation, so it arms a timer for every conversation
// with an autosend message; a mirror transition to `idle` (which also covers an
// Esc with no Stop) or to `ended` arms one for its conversation. Each timer is
// unref'd, re-armed by a later boundary, and fires after delayMs: when the
// conversation is free (or its process is gone), the OLDEST of its autosend
// messages goes — one per boundary, so "do X, then Y" runs in order — with that
// message's own stored origin and device as the release's provenance (every
// envelope opens with its 'Pushed from' line). An autosend message is a staged
// message with autosend: true, or one waiting 'parked_message' (flush kept it
// back while the park held a message; the user had already sent it, so it goes
// even when it was held before). A held message never autosends.
//
// RECEIPTS IN MOTION (§6.6). A mirror `delivered` transition confirms the
// receipt its marker names (queue.confirmDelivered): the transcript is the only
// confirmation. A receipt entering `handed_over` — and `sent`, only when
// confirmVerified — arms an unconfirmed timer; when it fires and the receipt is
// unchanged, it turns `unconfirmed` only while the mirror is tailing that
// conversation (enabled, a live object, not ended): without the mirror there
// is no false alarm. CONFIRM_VERIFIED stays false until gate V30 is recorded:
// until then a live (`sent`) message never turns unconfirmed.
//
// stop() unsubscribes and clears every timer; the server constructs this after
// the mirror (ctx.queueRelease) and stops it in both teardown paths (U66a).

const queue = require('./domain/queue');
const { lockIsStale } = require('./domain/turns');

// Gate V30 (§10.3) records which transcript carrier holds a live channel
// message's marker. Until it does, a `sent` receipt never turns unconfirmed.
const CONFIRM_VERIFIED = false;
const RELEASE_DELAY_MS = 1500;
const UNCONFIRMED_MS = 180000;

const NO_CID = '\u0000none';
const keyOf = (cid) => (typeof cid === 'string' && cid ? cid : NO_CID);
const isStr = (v) => typeof v === 'string' && v !== '';

function createQueueRelease({
  state, bus, graph, mirror = null, asks = null,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  delayMs = RELEASE_DELAY_MS, unconfirmedMs = UNCONFIRMED_MS, confirmVerified = CONFIRM_VERIFIED,
  log = () => {},
} = {}) {
  if (!state || !bus) throw new TypeError('createQueueRelease needs state and bus');
  // `now` is accepted for the brief's signature; every time here is a timer
  // (setTimer) or the queue's own receipt stamp, so nothing reads it yet.
  void now;

  let started = false;
  let stopped = false;
  const offs = [];
  const boundaryTimers = new Map(); // conversation key → {handle, cid}
  const receiptTimers = new Map(); // msg_id → handle

  const safe = (fn, fallback = null) => {
    try { return fn(); } catch (e) { log(`queue-release: ${(e && e.message) || e}`); return fallback; }
  };
  const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };

  // ── the mirror, read defensively ──
  function primary() {
    if (!mirror || typeof mirror.snapshot !== 'function') return null;
    const s = safe(() => mirror.snapshot({ level: 'basic' }));
    return s && isStr(s.primary) ? s.primary : null;
  }
  // A lazily read primary for one operation (snapshot is not free).
  function primaryOnce() {
    let read = false;
    let value = null;
    return () => { if (!read) { read = true; value = primary(); } return value; };
  }
  function conversationOf(item, prim = primary) {
    if (item && isStr(item.conversation_id)) return item.conversation_id;
    return typeof prim === 'function' ? prim() : prim;
  }
  function liveOf(cid) {
    if (!isStr(cid) || !mirror || typeof mirror.liveOf !== 'function') return null;
    const v = safe(() => mirror.liveOf(cid));
    return v && typeof v === 'object' ? v : null;
  }
  function isGone(live) {
    if (!live) return false;
    if (live.state === 'ended') return true;
    if (live.process && typeof live.process === 'object' && live.process.alive === false) return true;
    return !!(live.evidence && live.evidence.proc === 'gone');
  }
  function conversationOfLock(lock) {
    if (!mirror) return null;
    if (Number.isSafeInteger(lock.claude_pid) && typeof mirror.conversationOfPid === 'function') {
      const c = safe(() => mirror.conversationOfPid(lock.claude_pid));
      if (isStr(c)) return c;
    }
    if (isStr(lock.session_id) && typeof mirror.conversationOf === 'function') {
      const c = safe(() => mirror.conversationOf(lock.session_id));
      if (isStr(c)) return c;
    }
    return null;
  }

  // ── claudeFree ──
  function lockHeldBy(cid) {
    const lock = graph && graph.lock;
    if (!lock || lockIsStale(lock)) return false;
    const hasSession = isStr(lock.session_id) || Number.isSafeInteger(lock.claude_pid);
    if (!hasSession) return true;
    if (!isStr(cid)) return false;
    return conversationOfLock(lock) === cid;
  }
  function askPendingFor(cid) {
    if (!asks || typeof asks.pending !== 'function') return false;
    const rows = safe(() => asks.pending(), []);
    if (!Array.isArray(rows)) return false;
    const want = isStr(cid) ? cid : null;
    return rows.some((a) => a && (isStr(a.conversation_id) ? a.conversation_id : null) === want);
  }
  function claudeFree(cid) {
    if (lockHeldBy(cid)) return false;
    if (askPendingFor(cid)) return false;
    const live = liveOf(cid);
    if (live && isStr(live.state) && live.state !== 'idle' && live.state !== 'unknown') return false;
    return true;
  }

  // ── targeting ──
  function pidOf(cid) {
    const live = liveOf(cid);
    if (!live || isGone(live) || !live.process || typeof live.process !== 'object') return null;
    return queue.isTargetPid(live.process.pid) ? live.process.pid : null;
  }
  function targetFor(items) {
    if (!Array.isArray(items) || !items.length) return null;
    const prim = primaryOnce();
    let pid = null;
    for (const it of items) {
      const p = pidOf(conversationOf(it, prim));
      if (p == null) return null;
      if (pid == null) pid = p;
      else if (pid !== p) return null;
    }
    return pid;
  }

  // ── the one way this module releases ──
  function releaseItem(item, prov, { park = false } = {}) {
    const opts = { graph };
    if (park) opts.park = true;
    if (prov && prov.origin !== undefined) opts.origin = prov.origin;
    if (prov && prov.device !== undefined) opts.device = prov.device;
    const target_pid = targetFor([item]);
    if (target_pid != null) opts.target_pid = target_pid;
    return queue.release(state, bus, [item.id], opts);
  }

  // An autosend message: staged with autosend, or one flush kept back for a
  // parked message (§6.4's one message per park). A held message never is.
  function isAutosend(it) {
    if (!queue.isMessage(it)) return false;
    if (it.waiting === 'parked_message') return true;
    return it.autosend === true && it.staged !== false;
  }
  function autosendOf(cid, prim) {
    const want = isStr(cid) ? cid : null;
    return state.queue.filter((it) => isAutosend(it) && (conversationOf(it, prim) || null) === want);
  }

  function send(item, { mode, prov } = {}) {
    if (!item || typeof item !== 'object') throw new TypeError('queueRelease.send: no item');
    const prim = primaryOnce();
    const cid = conversationOf(item, prim);
    const live = liveOf(cid);
    // Ended, or its process gone (for 'now' as for 'auto'): nothing will ever
    // free it — release now as an explicit park (untargeted) for the next prompt
    // typed in the project, never a live wake another session would run.
    if (isGone(live)) return releaseItem(item, prov, { park: true });
    if (mode === 'now') return releaseItem(item, prov);
    // FIFO per conversation (§6.4): an autosend message with older ones of its
    // conversation still waiting (the 1,500 ms before a boundary's timer, or a
    // boundary missed) queues behind them even when Claude is free, and the
    // boundary timers release them in order. When Claude is free and no timer
    // is armed for the conversation, arm one now (an armed one is left alone:
    // re-arming would only delay it).
    const list = autosendOf(cid, prim);
    const at = list.findIndex((it) => it.id === item.id);
    const free = claudeFree(cid);
    if (at > 0) {
      if (free && !boundaryTimers.has(keyOf(cid))) arm(cid);
      return { mode: 'queued', position: at + 1 };
    }
    if (free) return releaseItem(item, prov);
    return { mode: 'queued', position: at < 0 ? list.length + 1 : at + 1 };
  }

  // ── boundaries ──
  function fire(cid) {
    if (stopped) return;
    const prim = primaryOnce();
    const next = autosendOf(cid, prim)[0];
    if (!next) return;
    const gone = isGone(liveOf(cid));
    if (!gone && !claudeFree(cid)) return;
    safe(() => releaseItem(next, { origin: next.origin, device: next.device }, { park: gone }));
  }
  function arm(cid) {
    if (stopped) return;
    const key = keyOf(cid);
    const prev = boundaryTimers.get(key);
    if (prev) clearTimer(prev.handle);
    const handle = unref(setTimer(() => {
      boundaryTimers.delete(key);
      fire(isStr(cid) ? cid : null);
    }, delayMs));
    boundaryTimers.set(key, { handle, cid });
  }
  function armEvery() {
    const prim = primaryOnce();
    const seen = new Set();
    for (const it of state.queue) {
      if (!isAutosend(it)) continue;
      const cid = conversationOf(it, prim);
      const key = keyOf(cid);
      if (seen.has(key)) continue;
      seen.add(key);
      arm(cid);
    }
  }
  function armFor(cid) {
    if (!isStr(cid)) return;
    if (autosendOf(cid, primaryOnce()).length) arm(cid);
  }

  // ── receipts ──
  function receipt(msgId) {
    return state.messageReceipts instanceof Map ? state.messageReceipts.get(msgId) || null : null;
  }
  function tailing(cid) {
    if (!isStr(cid) || !mirror || typeof mirror.enabled !== 'function') return false;
    const on = safe(() => mirror.enabled());
    if (!on || on.enabled !== true) return false;
    const live = liveOf(cid);
    return !!live && live.state !== 'ended';
  }
  function onReceipt(e) {
    const id = e.msg_id;
    if (!isStr(id)) return;
    const prev = receiptTimers.get(id);
    if (prev) { clearTimer(prev); receiptTimers.delete(id); }
    const watch = e.state === 'handed_over' || (e.state === 'sent' && confirmVerified === true);
    if (!watch || stopped) return;
    const rec = receipt(id);
    const at = rec ? rec.at : null;
    const armedState = e.state;
    receiptTimers.set(id, unref(setTimer(() => {
      receiptTimers.delete(id);
      if (stopped) return;
      const r = receipt(id);
      if (!r || r.state !== armedState || r.at !== at) return;
      const cid = isStr(r.conversation_id) ? r.conversation_id : primary();
      if (!tailing(cid)) return;
      safe(() => queue.markUnconfirmed(state, bus, id));
    }, unconfirmedMs)));
  }

  // ── lifecycle ──
  function onMain(e) {
    if (!e || typeof e !== 'object') return;
    if (e.kind === 'graph' && (e.op === 'turn-end' || e.op === 'turn-skipped' || e.op === 'unlock')) armEvery();
    else if (e.kind === 'queue' && e.op === 'receipt') onReceipt(e);
  }
  function onMirror(e) {
    if (!e || typeof e !== 'object') return;
    if (e.op === 'delivered') {
      if (isStr(e.marker)) safe(() => queue.confirmDelivered(state, bus, e.marker));
    } else if (e.op === 'state' && (e.state === 'idle' || e.state === 'ended')) {
      armFor(e.conversation_id);
    }
  }

  function start() {
    if (started || stopped) return;
    started = true;
    if (typeof bus.subscribe === 'function') offs.push(bus.subscribe((e) => onMain(e)));
    if (mirror && typeof mirror.subscribe === 'function') {
      const off = safe(() => mirror.subscribe((e) => onMirror(e)));
      if (typeof off === 'function') offs.push(off);
    }
  }

  function stop() {
    stopped = true;
    while (offs.length) { const off = offs.pop(); try { off(); } catch {} }
    for (const { handle } of boundaryTimers.values()) clearTimer(handle);
    boundaryTimers.clear();
    for (const h of receiptTimers.values()) clearTimer(h);
    receiptTimers.clear();
  }

  return { send, claudeFree, targetFor, start, stop };
}

module.exports = { createQueueRelease, CONFIRM_VERIFIED, RELEASE_DELAY_MS, UNCONFIRMED_MS };

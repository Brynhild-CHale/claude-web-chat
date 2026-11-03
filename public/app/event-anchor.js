// The event-time anchor (annotation engine, PLAN.md 4D.1; DECISIONS.md C4):
// the element anchor a reported click, change or submit carries, computed at
// the moment of the event over a WARM per-pane index (RULED 2026-11-02,
// U542@event-index-and-view (a)).
//
// The record is the resolver's existing one — anchors.record(root, el,
// {mount, ix}) — never a second recorder, and it is exactly what
// anchors.record(root, el, {mount}) would give at that moment: the index it is
// taken over is rebuilt whenever the pane's DOM moved since it was built. Only
// the cost differs: a record without an index walks the whole pane first
// (≈ 3 ms p95 over a dense pane), one over a built index is a lookup.
//
// The lifecycle of a pane root's entry:
//   * it is made at the root's first ENGAGEMENT — a capture-phase pointerdown,
//     focusin or keydown on the root (mounts.js), or the first event anchored
//     there — with its index and ONE MutationObserver on the root (childList,
//     subtree, characterData, attributes) whose only job is to mark the entry
//     dirty;
//   * a dirty entry is rebuilt off the input path, in one single-flight idle
//     callback (requestIdleCallback with an IDLE_TIMEOUT_MS timeout, a 0 ms
//     setTimeout where there is none), and again at the next engagement if it
//     is still dirty;
//   * an entry with no engagement for ENGAGED_MS disconnects its observer and
//     drops its index (one single-flight expiry timer for every entry);
//   * release(root) — the pane leaving (mounts.js releasePane) — disconnects
//     it at once.
//
// anchorAt(root, target, mountId) is the event path: pending mutation records
// are taken first (any → dirty), a dirty or missing index is built now (the
// COLD path, stats().cold; a clean one is the WARM path, stats().warm), and the
// element is the target or its nearest ancestor inside the root the recorder
// answers for (at most ANCESTOR_STEPS steps: an element inside a
// data-wc-chrome subtree, or a skip element, has no record of its own). A
// record whose JSON is over EVENT_ANCHOR_MAX bytes answers null, as does a
// target outside the root or a recorder that throws.
//
// Nothing here resolves an anchor (A2 is deferred), sends anything, or reads
// a store: the caller (mounts.js reportEvent) puts the record on the event
// frame, and the daemon (lib/server/ws.js domEvent) checks it again.

// No engagement for this long: the entry's observer goes and its index with it.
export const ENGAGED_MS = 60_000;
// public/app/overlay-report.js MAX_RECORD's figure: a record over it is not sent.
export const EVENT_ANCHOR_MAX = 4096;
// How far up from the target the element may be found.
export const ANCESTOR_STEPS = 32;
// The idle rebuild's deadline, where requestIdleCallback exists.
export const IDLE_TIMEOUT_MS = 500;
// What the entry's one observer hears: anything that can move a record.
export const OBSERVE = Object.freeze({ childList: true, subtree: true, characterData: true, attributes: true });

const ENCODER = new TextEncoder();
const byteLength = (s) => ENCODER.encode(s).length;

// The default idle scheduler: requestIdleCallback where there is one, else a
// 0 ms timeout. Bare names, so a page's (and a test shell's) own timers are used.
function idleSchedule(fn) {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
  return setTimeout(fn, 0);
}

export function createEventAnchors({
  anchors,
  MutationObserver: MO = typeof MutationObserver === 'function' ? MutationObserver : null,
  schedule = idleSchedule,
  now = () => Date.now(),
  // The expiry timer never holds a process open (a Node host — a test's jsdom
  // chrome — has unref; a browser's handle is a number and has none).
  setTimer = (fn, ms) => { const h = setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); return h; },
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  if (!anchors || typeof anchors.index !== 'function' || typeof anchors.record !== 'function') {
    throw new Error('event-anchor: an anchors module with index and record is required');
  }
  // root → { ix, dirty, mo, last }
  const entries = new Map();
  const counts = { warm: 0, cold: 0, built: 0, idle: 0, expired: 0, released: 0, oversize: 0, none: 0 };
  let idlePending = false;
  let expiry = null;

  function build(root, e) {
    if (e.mo) {
      try { e.mo.takeRecords(); } catch {}
    }
    e.ix = anchors.index(root);
    e.dirty = false;
    counts.built += 1;
  }

  function drop(root, e) {
    if (e.mo) {
      try { e.mo.disconnect(); } catch {}
    }
    e.mo = null;
    e.ix = null;
    entries.delete(root);
  }

  function sweep() {
    const t = now();
    for (const [root, e] of [...entries]) {
      if (t - e.last >= ENGAGED_MS) { drop(root, e); counts.expired += 1; }
    }
  }

  function armExpiry() {
    if (expiry != null || !entries.size) return;
    let oldest = Infinity;
    for (const e of entries.values()) if (e.last < oldest) oldest = e.last;
    const wait = Math.max(0, oldest + ENGAGED_MS - now());
    expiry = setTimer(() => {
      expiry = null;
      sweep();
      armExpiry();
    }, wait);
  }

  function rebuildIdle() {
    idlePending = false;
    sweep();
    for (const [root, e] of entries) {
      if (!e.dirty) continue;
      try { build(root, e); counts.idle += 1; } catch (err) { e.ix = null; e.dirty = true; }
    }
  }

  function markDirty(e) {
    if (!entries.has(e.root)) return;
    e.dirty = true;
    if (idlePending) return;
    idlePending = true;
    try { schedule(rebuildIdle); } catch { idlePending = false; }
  }

  // The root's entry, made (index and observer) when it has none; `last` moves
  // to now either way. A still-dirty index is rebuilt here, on the engagement.
  function entryFor(root) {
    sweep();
    let e = entries.get(root);
    if (!e) {
      e = { root, ix: null, dirty: true, mo: null, last: now() };
      entries.set(root, e);
      if (MO) {
        try {
          const mo = new MO(() => markDirty(e));
          mo.observe(root, OBSERVE);
          e.mo = mo;
        } catch { e.mo = null; }
      }
    }
    e.last = now();
    armExpiry();
    return e;
  }

  function pending(e) {
    if (!e.mo) return true;   // no observer: nothing says the index is current
    let recs = [];
    try { recs = e.mo.takeRecords(); } catch { return true; }
    return recs.length > 0;
  }

  function engage(root) {
    if (!root) return;
    const e = entryFor(root);
    if (pending(e)) e.dirty = true;
    if (e.dirty || !e.ix) {
      try { build(root, e); } catch { e.ix = null; e.dirty = true; }
    }
  }

  function elementFor(root, target) {
    let el = target;
    if (el && el.nodeType !== 1) el = el.parentNode;
    if (!el || el === root || typeof root.contains !== 'function' || !root.contains(el)) return [];
    const out = [];
    for (let k = 0; k < ANCESTOR_STEPS && el && el !== root && el.nodeType === 1; k++) {
      out.push(el);
      el = el.parentNode;
    }
    return out;
  }

  function anchorAt(root, target, mountId) {
    if (!root) return null;
    const chain = elementFor(root, target);
    if (!chain.length) { counts.none += 1; return null; }
    const e = entryFor(root);
    if (pending(e)) e.dirty = true;
    if (e.dirty || !e.ix) {
      try { build(root, e); } catch { e.ix = null; e.dirty = true; counts.none += 1; return null; }
      counts.cold += 1;
    } else {
      counts.warm += 1;
    }
    for (const el of chain) {
      let rec = null;
      try { rec = anchors.record(root, el, { mount: mountId, ix: e.ix }); } catch { rec = null; }
      if (!rec) continue;
      let json;
      try { json = JSON.stringify(rec); } catch { return null; }
      if (byteLength(json) > EVENT_ANCHOR_MAX) { counts.oversize += 1; return null; }
      return rec;
    }
    counts.none += 1;
    return null;
  }

  function release(root) {
    const e = entries.get(root);
    if (!e) return;
    drop(root, e);
    counts.released += 1;
    if (!entries.size && expiry != null) { clearTimer(expiry); expiry = null; }
  }

  function stats() {
    let observing = 0;
    let dirty = 0;
    for (const e of entries.values()) {
      if (e.mo) observing += 1;
      if (e.dirty) dirty += 1;
    }
    return { entries: entries.size, observing, dirty, idlePending, ...counts };
  }

  return { engage, anchorAt, release, stats, sweep };
}

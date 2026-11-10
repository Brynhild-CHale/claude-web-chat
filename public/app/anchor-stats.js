// The event-anchor stats on the chrome's client frame (annotation engine
// tranche 6, 6C.1, U761; C-5C-BD6). The daemon keeps the newest `anchor_stats`
// a LOCAL socket sends (lib/server/ws.js anchorStatsOf) and answers their sum
// and per-socket rows to the host alone (GET /api/elements/anchor-stats), so
// the main session and the exit's F1 read a live surface's event-anchor
// counts — BD6's live figure — with no pane on the page.
//
// Counts only: the fourteen integers (and one boolean) the engine's stats()
// answers (public/app/event-anchor.js), copied into a fresh plain object. Never
// text, an id, a mount id or any element datum. Nothing is sent before the
// engine exists (mounts.js eventAnchorStats answers null until its first use).
//
// Every dependency is injected (it imports nothing), so it is tested as an ES
// module with no DOM:
//   stats()               → the engine's stats, or null
//   setClientField(k, v)  → public/app/ws.js's seam: v rides every client frame
//   onHello(fn)           → public/app/ws.js's hello hooks
//   every                 → the re-read period (ANCHOR_STATS_EVERY_MS)
//   setInterval / clearInterval → the window's (bare: the shell test stubs them)
//   onPageHide(fn)        → where the interval is cleared (the window's pagehide)

export const ANCHOR_STATS_EVERY_MS = 30000;

// The keys sent, in this order: the engine's four gauges, then its ten counts.
export const ANCHOR_STATS_KEYS = Object.freeze([
  'entries', 'observing', 'dirty', 'idlePending',
  'warm', 'cold', 'cold_missing', 'cold_dirty', 'built', 'idle', 'expired', 'released', 'oversize', 'none',
]);

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

// The fourteen known keys out of a stats() answer, as a fresh plain object;
// null for anything that is not an object. A count that is not a non-negative
// integer is left out (the daemon drops it anyway); idlePending is a boolean.
export function anchorStatsOf(stats) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
  const out = {};
  for (const k of ANCHOR_STATS_KEYS) {
    const v = stats[k];
    if (k === 'idlePending') { if (typeof v === 'boolean') out[k] = v; }
    else if (isCount(v)) out[k] = v;
  }
  return out;
}

// The comparison key of one answer: the known keys' values in order. Two
// answers with the same key carry the same counts. null → null.
export function anchorStatsKey(stats) {
  const s = anchorStatsOf(stats);
  if (!s) return null;
  return ANCHOR_STATS_KEYS.map((k) => (k in s ? String(s[k]) : '-')).join(',');
}

const defaultPageHide = (fn) => {
  try { if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', fn); } catch {}
};

export function initAnchorStats({
  stats,
  setClientField,
  onHello,
  every = ANCHOR_STATS_EVERY_MS,
  setInterval: arm = (fn, ms) => setInterval(fn, ms),
  clearInterval: disarm = (h) => clearInterval(h),
  onPageHide = defaultPageHide,
} = {}) {
  if (typeof stats !== 'function' || typeof setClientField !== 'function') {
    throw new TypeError('initAnchorStats: stats and setClientField are required');
  }
  // The key of the last answer set (setClientField compares with ===, and a
  // fresh object is always new, so this module decides when a value moved).
  let lastKey = null;

  function read() {
    let s = null;
    try { s = stats(); } catch { s = null; }
    return anchorStatsOf(s);
  }
  function put(s) {
    lastKey = anchorStatsKey(s);
    try { setClientField('anchor_stats', s); } catch {}
  }

  // On init and on every hello: whatever the engine answers now (nothing
  // before the engine exists).
  function refresh() {
    const s = read();
    if (s) put(s);
  }
  // Every tick: only while some entry is dirty, or when a count moved since
  // the last set. Named, so a chrome test that lists the shell's intervals can
  // tell this ticker from another module's (test/comments-quiet.test.js).
  function anchorStatsTick() {
    const s = read();
    if (!s) return;
    if ((s.dirty || 0) > 0 || anchorStatsKey(s) !== lastKey) put(s);
  }

  let handle = null;
  const start = () => { if (handle == null) handle = arm(anchorStatsTick, every); };
  const halt = () => { if (handle != null) { try { disarm(handle); } catch {} handle = null; } };

  refresh();
  // A hello re-reads, and re-arms a ticker a pagehide cleared (a page back
  // from the back-forward cache reconnects).
  const offHello = typeof onHello === 'function' ? onHello(() => { refresh(); start(); }) : null;
  start();
  if (typeof onPageHide === 'function') onPageHide(halt);
  const stop = () => {
    halt();
    if (typeof offHello === 'function') { try { offHello(); } catch {} }
  };
  return { refresh, tick: anchorStatsTick, stop };
}

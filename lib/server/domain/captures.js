// lib/server/domain/captures.js — the one home for LIVE-capture retention.
//
// A page capture (routes/capture.js) appends a record to state.captures, and each
// record holds its whole distilled page. Nothing used to trim that list, and every
// committed node copies all of it (graph.js snapshotLive), every turn end and Set
// active serialise and hash it (turns.js snapshotView via liveIsDirty), and
// draft.json holds it — so a long capture session made each of those slower and
// each node larger without bound (the Safari report's item 3).
//
// Two rules, both ruled 2026-10-13:
//   - A4 (c): the live surface keeps the newest CAPTURES_LIVE_MAX captures, by
//     seq. An older record is only dropped from the LIVE list: a node committed
//     while it was live still holds its copy, and its raw sidecar
//     (.web-chat/captures/<id>.html) stays on disk, so get_captures / inspect_capture
//     on that node still read it. (retain never touches a node or a file.)
//   - A3 (b): a wipe and a new graph empty the live captures (clearLive). Captures
//     already copied into committed nodes stay there.
//
// state.captureSeq is never reset or lowered here: capture ids (and their sidecar
// file names) stay unique across trims, wipes and new graphs.
//
// A capture that leaves the live list takes its queue item with it (U102b), through
// the queue's own removal path (domain/queue removeByCapture): otherwise a Push
// delivered a capture id that get_captures no longer lists and, for a capture no
// node had copied yet, inspect_capture answered 404 for. Pass `bus` so the removal
// emits the standard `queue` remove frame the rail folds; without one (the boot's
// draft restore, before any client exists) the items go silently.
//
// Stateless like the other domain modules: every fn receives the live `state`.

const queue = require('./queue');

const CAPTURES_LIVE_MAX = 50;

// Keep the newest `max` live captures by seq, in their existing order, and
// dequeue the capture item of each one dropped. `opts` is `{max, bus}` (a bare
// number is `max`). Returns the ids it dropped (empty when nothing was over the cap).
function retain(state, opts = {}) {
  const { max = CAPTURES_LIVE_MAX, bus = null } = typeof opts === 'number' ? { max: opts } : (opts || {});
  const list = Array.isArray(state.captures) ? state.captures : [];
  if (list.length <= max) return [];
  const newest = new Set(
    [...list].sort((a, b) => ((b && b.seq) || 0) - ((a && a.seq) || 0)).slice(0, Math.max(0, max)),
  );
  const dropped = [];
  state.captures = list.filter((c) => {
    if (newest.has(c)) return true;
    dropped.push(c && c.id);
    return false;
  });
  queue.removeByCapture(state, bus, dropped);
  return dropped;
}

// Empty the live captures (a wipe, a new graph) and dequeue their capture items.
// The counter stays where it is. Returns how many went.
function clearLive(state, { bus = null } = {}) {
  const list = Array.isArray(state.captures) ? state.captures : [];
  state.captures = [];
  queue.removeByCapture(state, bus, list.map((c) => c && c.id));
  return list.length;
}

module.exports = { CAPTURES_LIVE_MAX, retain, clearLive };

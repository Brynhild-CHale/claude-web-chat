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
// Stateless like the other domain modules: every fn receives the live `state`.

const CAPTURES_LIVE_MAX = 50;

// Keep the newest `max` live captures by seq, in their existing order. Returns
// the ids it dropped (empty when nothing was over the cap).
function retain(state, max = CAPTURES_LIVE_MAX) {
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
  return dropped;
}

// Empty the live captures (a wipe, a new graph). The counter stays where it is.
function clearLive(state) {
  const n = Array.isArray(state.captures) ? state.captures.length : 0;
  state.captures = [];
  return n;
}

module.exports = { CAPTURES_LIVE_MAX, retain, clearLive };

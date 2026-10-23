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
// THE ONE CAPTURE-RECORD WRITER (U328b): createCapture allocates the id (or
// takes one allocateCapture reserved), writes the raw sidecar, appends the
// record, applies the cap (retain) and announces it. POST /api/capture (the
// extension's page captures) and the box grab (lib/server/box-grab.js) both
// write through it; nothing else pushes onto state.captures. The extension's
// capture also bumps the store's `tab_capture` signal and emits the `capture`
// event the wake policy turns into a capture item (signal: true, event: true,
// the route's arguments); a box grab's capture does neither (its one queue
// item is the element item, lib/channel/policy elementItem, F6 (a)).
//
// Stateless like the other domain modules: every fn receives the live `state`.

const fs = require('fs');
const path = require('path');
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

// Reserve the next capture id before its record exists (a box grab writes the
// id into its element's version before the capture is built). → {seq, id}
function allocateCapture(state) {
  const seq = ++state.captureSeq;
  return { seq, id: `cap${seq}` };
}

// Write one capture record. `opts`:
//   id, seq       a reservation from allocateCapture (else one is made here)
//   source        the record's `source` ('ext:tab-stream', 'element:box-grab')
//   url, title, profile, distilled   the record's fields
//   raw           the raw text, written to captures/<id>.html (raw_ref)
//   extra         fields set on the record after the base ones, in order (an
//                 extension capture's kind / fell_back_from / interaction; a
//                 box grab's kind and image)
//   signal        bump the store's tab_capture key (the extension's wake path)
//   event         emit the `capture` event (the wake policy's capture item)
//   bus           the change bus (retain's queue removals, the event)
// → {ok: true, record} | {ok: false, error} when the sidecar could not be
// written (nothing appended; the reserved seq stays spent, as it always has).
function createCapture(state, bus, paths, opts = {}) {
  const { source, url = '', title = '', profile, distilled, raw = '', extra = null, signal = false, event = false } = opts;
  const { seq, id } = opts.id ? { seq: opts.seq, id: opts.id } : allocateCapture(state);
  const rawRel = path.join('captures', `${id}.html`);
  try {
    fs.writeFileSync(path.join(paths.CAPTURES_DIR, `${id}.html`), raw);
  } catch (e) {
    return { ok: false, error: `failed to persist raw capture: ${e.message}` };
  }
  const record = {
    id,
    seq,
    ts: Date.now(),
    url,
    title,
    profile,
    distilled,
    raw_ref: rawRel,
    bytes_raw: Buffer.byteLength(raw),
    source,
  };
  if (extra) Object.assign(record, extra);
  state.captures.push(record);
  // Live captures are capped (ruled A4 (c)): the oldest beyond the newest 50
  // leave the live list only — nodes keep theirs, sidecars stay.
  retain(state, { bus });
  if (signal) {
    // Signal key: the wake path. Claude waits on `tab_capture` (store_key) or the
    // `capture` event kind; the bumping seq makes repeat captures distinguishable.
    state.store.tab_capture = { seq, capture_id: id, url, title, profile };
  }
  if (event) {
    // Triple-effect: the store mutation above (signal key), its store:patch WS
    // frame, and the `capture` event — WS frame + event co-located in one emit.
    bus.emit({
      event: { kind: 'capture', capture_id: id, seq, url, profile, source },
      ...(signal ? { ws: { type: 'store:patch', patch: { tab_capture: state.store.tab_capture } } } : {}),
    });
  }
  return { ok: true, record };
}

module.exports = { CAPTURES_LIVE_MAX, retain, clearLive, allocateCapture, createCapture };

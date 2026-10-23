'use strict';
// The transient-marks holder (annotation engine, PLAN.md 2B.2; DECISIONS.md C6;
// readiness R3 seam 11, X-9; notes-B Q8-Q10, rulings U313@marks-remote-level =
// a): a driver's, a service's or Claude's highlight of the moment — "this row
// is failing", "look here" — that is never committed.
//
//   createMarks({bus, now, redactor}) → ctx.marks
//     set(owner, marks, {writer})  REPLACE-ALL for that owner; an empty list
//                                  clears the owner's set. → {ok: true, owner,
//                                  count} | {ok: false, status, error, field?,
//                                  hint}
//     sets()                       [{owner, marks}] — what hello and reset carry
//     list()                       [{owner, marks, writer, at}] — GET /api/marks
//     clear()                      every set, silently: broadcastReset calls it
//                                  beside the report counter's bump, so a
//                                  restore, Wipe or New graph leaves no mark on
//                                  the new surface (its own frame carries
//                                  `marks: []`)
//     stats()                      {owners, marks, writes, refused}
//
// A MARK: {mount, anchor?, element?, kind, label?} — `mount` the pane or
// markdown item it is on, `anchor` an anchor record (or the legacy {selector,
// text} locator), `element` an 'id@v' it points at, `kind` a word of at most
// 32 characters a type will draw by, `label` at most 200 characters. A set
// holds at most MAX_MARKS marks in MAX_BYTES of JSON; at most MAX_OWNERS
// owners hold a set at once. A malformed set is refused whole.
//
// OFF THE STORE (C6, X-9). The sets live in this closure — never state.store,
// never a `state` key snapshotLive reads, never the draft — so a mark write is
// not a change to the surface: it never dirties the live state, never makes a
// turn commit, never rides a node. Each change is announced with
// bus.emit({ws: {type: 'marks', owner, marks}}), the ws-only path with no
// `event`, so it puts no entry on the ring (50 writes → 0 ring entries, 0
// nodes). The frame and hello/reset's `marks` field are the seam a type takes
// later: the chrome draws no mark in tranche 2 (notes-B Q10).
//
// WHO SEES THEM (E3 a): lib/core/remote-policy's FRAME_RULES row `marks` at
// `read`, and `marks` on TEXT_RULES.frames' hello and reset — a remote viewer
// below `read` gets neither the frame nor the field.
//
// WHO WRITES (C-15): the route is host-only (audience.requireHost, a transport
// gate on where a request comes from); the owner is the writers domain's
// answer (resolveWriter), and the writer stamp {class, owner, verified} beside
// the set is attribution, never authorization. Nothing here refuses or grants
// on a class, and nothing treats pane:<id> or user as a boundary.
//
// A label or an anchor may hold text: when the daemon's redactor is handed in,
// each set passes it before it is held or sent, as the comment frames' pins do.

const { isPinKey } = require('../../core/element-log');

const MAX_MARKS = 200;
const MAX_BYTES = 64 * 1024;
const MAX_OWNERS = 32;
const MAX_KIND = 32;
const MAX_LABEL = 200;
const MAX_MOUNT = 200;
const MARK_KEYS = Object.freeze(['mount', 'anchor', 'element', 'kind', 'label']);
const KIND_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/;

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const HINT = 'a mark is {mount, kind, anchor?, element?, label?}: mount an item id, kind a word of at most 32 characters, element an id@v, label at most 200 characters; a set holds at most 200 marks in 64 KB';

function jsonBytes(v) {
  try { return Buffer.byteLength(JSON.stringify(v)); } catch { return Infinity; }
}

// Why one mark is malformed (its field), or null.
function markProblem(m) {
  if (!isObj(m)) return 'mark';
  for (const k of Object.keys(m)) if (!MARK_KEYS.includes(k)) return k;
  if (typeof m.mount !== 'string' || !m.mount || m.mount.length > MAX_MOUNT) return 'mount';
  if (typeof m.kind !== 'string' || m.kind.length > MAX_KIND || !KIND_RE.test(m.kind)) return 'kind';
  if (m.label !== undefined && (typeof m.label !== 'string' || m.label.length > MAX_LABEL)) return 'label';
  if (m.element !== undefined && !isPinKey(m.element)) return 'element';
  if (m.anchor !== undefined && !isObj(m.anchor)) return 'anchor';
  return null;
}

function createMarks({ bus, now = Date.now, redactor = null } = {}) {
  const held = new Map(); // owner → {marks, writer, at}
  const counts = { writes: 0, refused: {} };
  const refuse = (status, error, field) => {
    counts.refused[error] = (counts.refused[error] || 0) + 1;
    return { ok: false, status, error, ...(field ? { field } : {}), hint: HINT };
  };
  const copy = (v) => JSON.parse(JSON.stringify(v));

  function set(owner, marks, { writer = null } = {}) {
    if (typeof owner !== 'string' || !owner) return refuse(400, 'owner');
    if (!Array.isArray(marks)) return refuse(400, 'shape', 'marks');
    if (marks.length > MAX_MARKS) return refuse(413, 'too-many-marks', 'marks');
    if (jsonBytes(marks) > MAX_BYTES) return refuse(413, 'too-large', 'marks');
    for (let i = 0; i < marks.length; i++) {
      const why = markProblem(marks[i]);
      if (why) return refuse(400, 'malformed', `marks[${i}].${why}`);
    }
    if (marks.length && !held.has(owner) && held.size >= MAX_OWNERS) return refuse(409, 'too-many-owners');
    let clean = copy(marks);
    if (redactor && typeof redactor.value === 'function') clean = copy(redactor.value(clean));
    counts.writes++;
    if (clean.length) held.set(owner, { marks: clean, writer: writer ? copy(writer) : null, at: Number(now()) });
    else held.delete(owner);
    if (bus && typeof bus.emit === 'function') bus.emit({ ws: { type: 'marks', owner, marks: copy(clean) } });
    return { ok: true, owner, count: clean.length };
  }

  const sets = () => [...held].map(([owner, h]) => ({ owner, marks: copy(h.marks) }));
  const list = () => [...held].map(([owner, h]) => ({ owner, marks: copy(h.marks), writer: h.writer ? copy(h.writer) : null, at: h.at }));
  function clear() { held.clear(); }
  function stats() {
    let n = 0;
    for (const h of held.values()) n += h.marks.length;
    return { owners: held.size, marks: n, writes: counts.writes, refused: { ...counts.refused } };
  }

  return { set, sets, list, clear, stats };
}

module.exports = { createMarks, markProblem, MAX_MARKS, MAX_BYTES, MAX_OWNERS, MAX_KIND, MAX_LABEL };

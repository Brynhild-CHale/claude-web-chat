'use strict';
// The lean element projection (PLAN 2A.3; readiness R2 §3 row 3, verdict S-17):
// what the chrome needs to draw every element on the FIRST frame of a surface —
// the hello, every reset, and a previewed node — and nothing it does not.
//
//   leanElements(state, elements)              the live surface's rows
//   leanElements(node, elements, {node: true}) a committed node's rows
//   surfaceOf(state)                           the B6 counter the two frames stamp
//
// A ROW is {id, v, type, anchor, shared, replies, answered}, the list sorted by id:
//   id, v      the element and the log version the row draws (v null when the
//              log cannot map the copy)
//   type       'comment' for a pin; for a reference, the log's element kind
//   anchor     the RESOLVER's record, as the log holds it (the version's
//              payload.anchor: a converted pin's pin-locator@1, an engine
//              record as stored; redacted at write by the one writer and masked
//              at read by the log's views). A pin the log cannot map carries the
//              converted form of its own copy's anchor (element-log
//              convertAnchor, the one mapping: the chrome keeps no copy of it).
//   shared     false only for a private element (PRIVATE_RULES drops the row
//              for every viewer that is not local)
//   replies    the reply COUNT, never a reply
//   answered   whether a reply's author is 'claude' (the marker's answered
//              colour; notes-A Q5 (a), K.2-21)
// NEVER a text body, a reply's text, or a writer or provenance sibling: the
// text loads when the element is opened. Every row is built field by field
// from an allowlist, never spread from a pin or a version.
//
// LIVE: every pin of state.comments (comments keep their 0.8.5 copies, E-STORE
// a), and every id@v reference of state.elements (U326e's shape, read through
// element-refs refsOf; each parsed by element-log parsePin, the one parser),
// projected from the log: type from the element's kind, anchor and shared from
// the version's payload. A reference whose version the log does not hold is
// kept as an unresolvable row (anchor null) and counted private (shared false):
// fail closed. A reference naming a pin's id is the pin's row.
//
// A NODE: its `comments` (the 0.8.5 copies), each projected as a live pin is;
// a copy's version is its own `v` when the log holds it, else the one the
// node's commit record pins. The node's `elements` references are NOT projected
// here (the overlay holds them as pending rows until a later unit hands their
// anchors back).
//
// `elements` is the daemon's element store (graph.elements); without one (a
// bare rig, a store that failed to open) every row is projected from its copy.

const { convertAnchor, isEngineRecord, parsePin, pinMapOf, SCHEMAS, SCHEMA } = require('../../core/element-log');
const { refsOf } = require('./element-refs');

// A pin's type: comment@1's (the log's schema table names it; no literal, so
// the frame census never reads a row field as a frame type).
const COMMENT_TYPE = SCHEMAS[SCHEMA].type;
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

// The version record the log holds for id@v, or null.
function versionOf(elements, id, v) {
  if (!elements || typeof elements.version !== 'function' || !isPosInt(v)) return null;
  try { return elements.version(id, v) || null; } catch { return null; }
}

// A copy's anchor in the resolver's form, as payloadOf stores it: an engine
// record kept, anything else converted; null when it cannot be (no mount).
function copyAnchor(a) {
  if (a == null) return null;
  try { return isEngineRecord(a) ? a : convertAnchor(a); } catch { return null; }
}

const payloadAnchor = (rec) => {
  const p = rec && rec.payload;
  return isObj(p) && p.anchor !== undefined ? p.anchor : null;
};

// One comment copy (a live pin, or a node's copy) → its row. `pinned` is the
// version the node's commit record names for it (a node only).
function commentRow(pin, elements, pinned) {
  const id = pin.id;
  let v = isPosInt(pin.v) ? pin.v : null;
  let rec = versionOf(elements, id, v);
  if (!rec && isPosInt(pinned) && pinned !== v) {
    const r = versionOf(elements, id, pinned);
    if (r) { rec = r; v = pinned; }
  }
  const replies = Array.isArray(pin.replies) ? pin.replies : [];
  return {
    id,
    v,
    type: COMMENT_TYPE,
    schema: rec && typeof rec.schema === 'string' ? rec.schema : SCHEMA,
    anchor: rec ? payloadAnchor(rec) : copyAnchor(pin.anchor),
    shared: pin.shared !== false,
    replies: replies.length,
    answered: replies.some((r) => isObj(r) && r.author === 'claude'),
  };
}

function kindOf(elements, id, rec) {
  try {
    const log = elements && elements.log;
    const el = log && typeof log.element === 'function' ? log.element(id) : null;
    if (el && typeof el.kind === 'string' && el.kind) return el.kind;
  } catch {}
  const schema = rec && SCHEMAS[rec.schema];
  return schema ? schema.type : null;
}

// One id@v reference → its row, from the log alone.
function refRow({ id, v }, elements) {
  const rec = versionOf(elements, id, v);
  const p = rec && isObj(rec.payload) ? rec.payload : null;
  return {
    id,
    v,
    type: kindOf(elements, id, rec),
    schema: rec && typeof rec.schema === 'string' ? rec.schema : null,
    anchor: p && p.anchor !== undefined ? p.anchor : null,
    shared: p ? p.shared !== false : false,
    replies: 0,
    answered: false,
  };
}

const validCopy = (c) => isObj(c) && typeof c.id === 'string' && c.id !== '';
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function leanElements(source, elements = null, { node = false } = {}) {
  const src = isObj(source) ? source : {};
  const pins = Array.isArray(src.comments) ? src.comments : [];
  let pinned = null;
  if (node && elements && typeof elements.pinsOf === 'function' && typeof src.id === 'string') {
    try { pinned = pinMapOf(elements.pinsOf(src.id)); } catch { pinned = null; }
  }
  const rows = [];
  const seen = new Set();
  for (const pin of pins) {
    if (!validCopy(pin) || seen.has(pin.id)) continue;
    seen.add(pin.id);
    rows.push(commentRow(pin, elements, pinned ? pinned.get(pin.id) : null));
  }
  if (!node) {
    for (const ref of refsOf(src)) {
      const p = parsePin(ref);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      rows.push(refRow(p, elements));
    }
  }
  return rows.sort(byId);
}

// The B6 counter (ruling 2B@replace-key b): a non-negative integer, 0 while
// unset. U311 seeds and bumps state.surface; this module only reads it.
function surfaceOf(state) {
  const n = state && state.surface;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

module.exports = { leanElements, surfaceOf };

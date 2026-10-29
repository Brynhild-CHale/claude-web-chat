// lib/server/domain/comments.js — comment-pin domain helpers shared across the
// routes and the queue-revert path, and the element API's one removal and its
// frames (U325). Stateless like the other domain modules: every fn receives
// the live `state` (which owns state.comments and state.elements) and the
// change `bus`.
//
// deleteComment is the ONE canonical pin removal (C1): it filters the pin out of
// state.comments and emits the `comment` delete event + `element:comment` WS frame in a
// single shape, so the route's DELETE and the queue's Revert can't drift a second
// divergent delete frame. Returns true if a pin was removed, false if the id
// wasn't found. A delete event carries no pin (only the bare id policy.js reads on
// the dequeue path), so there is nothing to redact here.
//
// emitComments(state, bus, event) is THE comment write's announcement: the
// event on the ring (a private pin's text redacted out of it: redactPin) and
// the comment type's element frame, `element:comment`, carrying every live
// pin under `elements` (U327a; the shape every element frame has). lib/server/
// ws.js projects it per socket through its FRAME_RULES row (element-policy's,
// at the type's see level): a local socket gets it whole, a remote one at read
// or full without the private pins (PRIVATE_RULES.frames), one below read
// none. Every comment write of the element API, and deleteComment, goes
// through it.
//
// removeElement(state, bus, id, {elements}) is THE element removal (C2): a
// comment through deleteComment; any other type's live reference dropped
// (element-refs dropRef) and its type's frame sent. Nothing is appended to the
// log (no tombstone) and every committed node keeps its copy or reference —
// except a CHAT element's (U415), which no node holds: its Delete is the
// log's drop record (elements.dropElement, {writer, provenance} its stamps),
// then its type's frame.
//
// emitElements(state, bus, elements, type, event) is a non-comment type's
// announcement: the `element:<type>` frame carrying that type's live records
// under `elements` (lib/core/element-policy frameType; PRIVATE_RULES drops a
// private record before any non-local socket gets it), and the event, which
// carries no text: elementEvent builds it, {kind: 'element', type, op, id, v,
// shared, mount} — v and the shared flag are what the queue's element item
// reads (K.2-10), mount the live pane the anchor names (U215), else null.

const { frameType } = require('../../core/element-policy');
const { CHAIN_PRIVATE } = require('../../core/remote-policy');
const { refOf, dropRef, anchorItem } = require('./element-refs');
const { chainPrivate } = require('./elements');

// A PRIVATE pin's text must never enter the event ring — get_events serves
// the ring unfiltered, so it would leak exactly what the element read
// withholds. Redact the note body + every reply body from the EVENT copy, but
// keep the fields the dequeue path reads (lib/channel/policy reads
// event.pin.id and event.pin.shared === false). A shared pin is returned
// untouched — its text is already Claude-visible and commentItem needs it for
// the wake summary.
function redactPin(pin) {
  if (!pin || pin.shared !== false) return pin;
  const out = { ...pin, text: '' };
  if (Array.isArray(pin.replies)) out.replies = pin.replies.map((r) => ({ ...r, text: '' }));
  return out;
}

// The frame carries, under remote-policy CHAIN_PRIVATE (a Symbol: no JSON
// byte changes), the ids of every live chained pin's private members —
// domain/elements chainPrivate, the log's answer — so projectFrame nulls each
// for a socket that does not see private records, whatever its type and
// whether it still exists (U406a, Q8 a). Absent when there is none.
function emitComments(state, bus, event) {
  const ev = event && event.pin ? { ...event, pin: redactPin(event.pin) } : event;
  const ws = { type: frameType('comment'), elements: state.comments };
  const hidden = new Set();
  for (const pin of state.comments) {
    if (pin && Array.isArray(pin.chain) && pin.chain.length) for (const id of chainPrivate(state, pin)) hidden.add(id);
  }
  if (hidden.size) ws[CHAIN_PRIVATE] = [...hidden];
  bus.emit({ event: ev, ws });
}

function deleteComment(state, bus, id) {
  const next = state.comments.filter((c) => c.id !== id);
  if (next.length === state.comments.length) return false;
  state.comments = next;
  emitComments(state, bus, { kind: 'comment', op: 'delete', id });
  return true;
}

// The ring event of a non-comment element write: ids, numbers and flags only.
function elementEvent(state, op, rec) {
  const item = anchorItem(rec);
  return {
    kind: 'element',
    type: rec.type,
    op,
    id: rec.id,
    v: rec.v,
    shared: rec.shared !== false,
    mount: item && state.mounts && state.mounts.has(item) ? item : null,
  };
}

// `records` (optional; U416): the frame's records as the caller made them —
// a chat type's live records each WITH the resolver's answer (state, visible,
// explain…), which the route awaits (mirror.resolveAnchors) before it emits;
// absent, the type's live records as the store reads them. A frame whose
// records carry chains (a chained chat pin) carries, as emitComments' does,
// the union of their private members under CHAIN_PRIVATE (domain/elements
// chainPrivate, the log's answer), so projectFrame nulls each for a socket
// that does not see private records — a page element of any type, or one
// since deleted — not only a private record in the frame's own list (K.2-164).
function emitElements(state, bus, elements, type, event, { records = null } = {}) {
  const list = Array.isArray(records) ? records : elements.liveRecords(type);
  const ws = { type: frameType(type), elements: list };
  const hidden = new Set();
  for (const rec of list) {
    if (rec && Array.isArray(rec.chain) && rec.chain.length) for (const id of chainPrivate(state, rec, elements)) hidden.add(id);
  }
  if (hidden.size) ws[CHAIN_PRIVATE] = [...hidden];
  bus.emit({ event, ws });
}

function removeElement(state, bus, id, { elements = null, writer = null, provenance = null } = {}) {
  if (Array.isArray(state.comments) && state.comments.some((c) => c && c.id === id)) return deleteComment(state, bus, id);
  // A chat element (family chat: the surface never holds one) is removed by
  // its own Delete, the log's drop record (U415), then its type's frame.
  const chatType = elements && typeof elements.familyOf === 'function' ? elements.typeOf(id) : null;
  if (chatType && elements.familyOf(chatType) === 'chat') {
    const latest = elements.latest(id);
    if (!latest || elements.dropped(id)) return false;
    const rec = elements.record(id, latest.v);
    elements.dropElement(id, { writer, provenance });
    emitElements(state, bus, elements, chatType, elementEvent(state, 'delete', rec || { id, v: latest.v, type: chatType, shared: false }));
    return true;
  }
  const held = refOf(state, id);
  if (!held) return false;
  const rec = elements ? elements.record(held.id, held.v) : null;
  const type = (elements && elements.typeOf(id)) || (rec && rec.type) || null;
  dropRef(state, id);
  if (!elements || !type) return true;
  emitElements(state, bus, elements, type, elementEvent(state, 'delete', rec || { id, v: held.v, type, shared: false }));
  return true;
}

module.exports = { deleteComment, emitComments, redactPin, removeElement, emitElements, elementEvent };

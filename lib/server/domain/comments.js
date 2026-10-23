// lib/server/domain/comments.js — comment-pin domain helpers shared across the
// routes and the queue-revert path, and the element API's one removal and its
// frames (U325). Stateless like the other domain modules: every fn receives
// the live `state` (which owns state.comments and state.elements) and the
// change `bus`.
//
// deleteComment is the ONE canonical pin removal (C1): it filters the pin out of
// state.comments and emits the `comment` delete event + `comments` WS frame in a
// single shape, so the route's DELETE and the queue's Revert can't drift a second
// divergent delete frame. Returns true if a pin was removed, false if the id
// wasn't found. A delete event carries no pin (only the bare id policy.js reads on
// the dequeue path), so there is nothing to redact here.
//
// emitComments(state, bus, event) is THE comment write's announcement: the
// event on the ring (a private pin's text redacted out of it: redactPin) and
// the full `comments` frame (lib/server/ws.js projects it per socket). Every
// comment write of the element API, and deleteComment, goes through it, so
// U327a switches the frame to element:comment in one place.
//
// removeElement(state, bus, id, {elements}) is THE element removal (C2): a
// comment through deleteComment; any other type's live reference dropped
// (element-refs dropRef) and its type's frame sent. Nothing is appended to the
// log (no tombstone) and every committed node keeps its copy or reference.
//
// emitElements(state, bus, elements, type, event) is a non-comment type's
// announcement: the `element:<type>` frame carrying that type's live records
// under `elements` (lib/core/element-policy frameType; PRIVATE_RULES drops a
// private record before any non-local socket gets it), and the event, which
// carries no text: elementEvent builds it, {kind: 'element', type, op, id, v,
// shared, mount} — v and the shared flag are what the queue's element item
// reads (K.2-10), mount the live pane the anchor names (U215), else null.

const { frameType } = require('../../core/element-policy');
const { refOf, dropRef, anchorItem } = require('./element-refs');

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

function emitComments(state, bus, event) {
  const ev = event && event.pin ? { ...event, pin: redactPin(event.pin) } : event;
  bus.emit({ event: ev, ws: { type: 'comments', comments: state.comments } });
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

function emitElements(state, bus, elements, type, event) {
  bus.emit({ event, ws: { type: frameType(type), elements: elements.liveRecords(type) } });
}

function removeElement(state, bus, id, { elements = null } = {}) {
  if (Array.isArray(state.comments) && state.comments.some((c) => c && c.id === id)) return deleteComment(state, bus, id);
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

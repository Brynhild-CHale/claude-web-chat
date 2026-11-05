'use strict';
// Element references on the live surface (DECISIONS.md K.1 A2, E-STORE (a)).
//
// The non-comment elements (a highlight, a box grab, a later type's) live in
// the element log alone; the surface holds only REFERENCES to them, one `id@v`
// string per element, in `state.elements`. A committed node carries the same
// list as `node.elements` (no payload copies), and the list rides every place
// the surface's fields are typed by hand: graph.snapshotLive /
// restoreLiveToNode, the draft (loadDraft / writeDraft — U352's heldCopies(value)
// reads `value.elements` from the draft, so a graceful close holds them), the
// view key (snapshotView, so a reference-only turn is dirty and commits) and
// commitNode. Comments keep their 0.8.5 copies (state.comments) for AG-1.
//
// THE SHAPE (K.2 item 2: this module owns it; U304's lean projection reads it):
// an array of non-empty strings, each holding an '@'. Every id@v here is read
// by U353's parsePin (lib/core/element-log), the one parser.
//
// THE REFERENCE RULES (U325; DECISIONS C2):
//   putRef(state, id, v)      the element's reference is id@v: an earlier
//                             version's is replaced in place, a new one appended
//   dropRef(state, id)        the element leaves the live surface (the one
//                             removal's half for a reference: domain/comments
//                             removeElement); its committed nodes keep it
//   refOf(state, id)          {id, v} of the element's live reference, or null
//   wipeDrops(state, store)   a Wipe's rule: the ids none of whose anchor's
//                             items (the panes or markdown items the
//                             version's anchor names: anchorItems — one for
//                             every anchor but a stroke's page record, whose
//                             arrow names two) is on the page after the wipe
//                             cleared it (WIPE@either-end) — and every
//                             reference the log cannot name an item for
//   liveIds(state)            a New graph's rule: every live reference's id
// A graceful close holds the references through U352's heldCopies(value)
// (lib/server/domain/elements), which reads `value.elements` already.
//
// DEFAULT-FREE: the field is created lazily (lib/server/state.js does not
// declare it), an absent field reads as [], and every writer of a node, a draft
// or a view key omits it when the list is empty, so a surface without
// references is byte-identical to what it was before this module existed.

const { parsePin } = require('../../core/element-log');
const { isPageRecord } = require('../../core/strokes');

function clean(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => typeof r === 'string' && r.length > 0 && r.includes('@'));
}

// A copy of the live references ([] when the field is absent).
function refsOf(state) {
  return clean(state && state.elements);
}

// Replace the live references with a copy of `list`, keeping only well-formed
// entries. Returns the list set.
function setRefs(state, list) {
  const next = clean(list);
  state.elements = next;
  return next.slice();
}

// {id, v} of the live reference of `id`, or null.
function refOf(state, id) {
  for (const r of refsOf(state)) {
    const p = parsePin(r);
    if (p && p.id === id) return p;
  }
  return null;
}

// The element `id`'s reference becomes id@v: in place of its earlier one, or
// appended. Returns the list set.
function putRef(state, id, v) {
  const ref = `${id}@${v}`;
  if (!parsePin(ref) || parsePin(ref).id !== id) throw new TypeError(`putRef: not an id@v: ${JSON.stringify(ref)}`);
  const next = [];
  let placed = false;
  for (const r of refsOf(state)) {
    const p = parsePin(r);
    if (p && p.id === id) {
      if (!placed) { next.push(ref); placed = true; }
      continue;
    }
    next.push(r);
  }
  if (!placed) next.push(ref);
  return setRefs(state, next);
}

// Every reference of `id` leaves the live surface. Returns the {id, v} it
// held, or null when it held none.
function dropRef(state, id) {
  const held = refOf(state, id);
  if (!held) return null;
  setRefs(state, refsOf(state).filter((r) => { const p = parsePin(r); return !p || p.id !== id; }));
  return held;
}

// The page item a version's payload is anchored to: the anchor's `mount` (an
// element or range record, a legacy locator), `md` (a markdown source record)
// or `item` (a page record), else a box grab's rect.item. null when none.
function anchorItem(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const a = p.anchor && typeof p.anchor === 'object' ? p.anchor : {};
  for (const k of ['mount', 'md', 'item']) if (typeof a[k] === 'string' && a[k]) return a[k];
  const r = p.rect && typeof p.rect === 'object' ? p.rect : null;
  return r && typeof r.item === 'string' && r.item ? r.item : null;
}

// The distinct page items a version's payload touches (tranche 5, U623): a
// stroke's page record (lib/core/strokes isPageRecord) names its item and
// both endpoints' items — [item, from.item, to.item] deduped, so an arrow
// from A to B is [A, B] and a margin stroke [A]; any other payload
// [anchorItem(payload)]; [] when it names none. The undo (UNDO@either-end),
// the Wipe (WIPE@either-end) and render-impact (IMPACT@both-items) read it.
function anchorItems(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (isPageRecord(p.anchor)) return [...new Set([p.anchor.item, p.anchor.from.item, p.anchor.to.item])];
  const one = anchorItem(p);
  return one ? [one] : [];
}

// Is `item` on the live page (a pane, or a markdown item: one id space)?
function onPage(state, item) {
  return !!item && ((state.mounts && state.mounts.has(item)) || (state.markdown && state.markdown.has(item)));
}

// A Wipe's rule (C2): the ids of the live references none of whose anchor's
// items (anchorItems) is on the page now (WIPE@either-end: an arrow stays
// while either of its items does), or which name no item, or which the log
// (`store.version`) cannot place. A malformed entry is dropped from the list
// here (it names no element).
function wipeDrops(state, store) {
  const out = [];
  const keep = [];
  for (const r of refsOf(state)) {
    const p = parsePin(r);
    if (!p) continue;
    keep.push(r);
    const rec = store && typeof store.version === 'function' ? store.version(p.id, p.v) : null;
    const items = rec ? anchorItems(rec.payload) : [];
    if (!items.some((item) => onPage(state, item))) out.push(p.id);
  }
  if (keep.length !== refsOf(state).length) setRefs(state, keep);
  return out;
}

// A New graph's rule: every live reference's id (malformed entries dropped).
function liveIds(state) {
  const ids = [];
  for (const r of refsOf(state)) { const p = parsePin(r); if (p) ids.push(p.id); }
  if (ids.length !== refsOf(state).length) setRefs(state, refsOf(state).filter((r) => parsePin(r)));
  return ids;
}

module.exports = { refsOf, setRefs, refOf, putRef, dropRef, anchorItem, anchorItems, onPage, wipeDrops, liveIds };

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
// an array of non-empty strings, each holding an '@'. Nothing here parses an
// id@v — U353's parsePin is the one parser, and the reference rules that need
// it (Wipe, New graph, commit-record pinning) are U325's.
//
// DEFAULT-FREE: the field is created lazily (lib/server/state.js does not
// declare it), an absent field reads as [], and every writer of a node, a draft
// or a view key omits it when the list is empty, so a surface without
// references is byte-identical to what it was before this module existed.

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

module.exports = { refsOf, setRefs };

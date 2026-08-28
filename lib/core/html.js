// The one HTML escaper. A zero-dependency leaf, so every layer can reach it
// without importing sideways: it used to live under lib/server/util/, which made
// lib/capture/markdown.js — a distiller that never touches the server — import
// from the server subsystem just to escape a string, and left lib/server/export.js
// and lib/capture/profiles/simplify.js free to hand-roll their own.
//
// One mode, five characters: & < > " '. Not a preference — the result is
// interpolated into an attribute value as often as into a text node, and an
// escaper that is only safe in one of those positions is a trap. simplify.js's
// private copy escaped four (no apostrophe) and used it for `href=` and `src=`
// alike; the client's four copies disagreed three ways before public/app/esc.js
// collapsed them. There is deliberately no "fewer characters" option: the only
// reason to want one is byte-preservation for a producer whose output is
// compared, and nothing in the tree is in that position. If something ever is,
// add the mode THEN, named for what it omits, with the caller in the same PR.
//
// Null-safe: null/undefined render as '' rather than the literal 'null'.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };

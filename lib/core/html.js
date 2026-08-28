// The one HTML escaper. A zero-dependency leaf, so every layer can reach it
// without importing sideways: it used to live under lib/server/util/, which made
// lib/capture/markdown.js — a distiller that never touches the server — import
// from the server subsystem just to escape a string, and left lib/server/export.js
// free to hand-roll a fifth copy of the same replace chain because reaching the
// "shared" home from a sibling felt like the same kind of reach.
//
//   escapeHtml(s)                     & < > " '   — the safe default
//   escapeHtml(s, { quotes: false })  & < >       — text-node mode
//
// The default is the five-character form because the result is interpolated into
// attribute values as often as into text, and an escaper that is only safe in one
// of those positions is a trap. `{ quotes: false }` exists for producers whose
// output is byte-compared (a distillate, a golden fixture) and which have never
// escaped quotes; it is NOT a performance option and never the right choice for
// an attribute value.
//
// Null-safe: null/undefined render as '' rather than the literal 'null'.

function escapeHtml(s, { quotes = true } = {}) {
  const out = String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return quotes ? out.replace(/"/g, '&quot;').replace(/'/g, '&#39;') : out;
}

module.exports = { escapeHtml };

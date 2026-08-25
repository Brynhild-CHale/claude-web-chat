// The ONE HTML escaper on the client.
//
// There were four, in four files, with three different character sets — the
// drawer's escaped `<>&` but not quotes, service-trust's escaped `&<>"` but not
// `'`, comments' and graph-view's escaped all five. Any of those is fine in
// isolation and the difference is invisible until a string reaches the wrong
// one: a `'` that survives into an attribute context is an attribute break, and
// `&` alone is a double-escaping bug in the other direction.
//
// Component packs are what made this urgent rather than tidy. A component's
// `name` and `description` used to come only from the local project; a pack
// install means they come from a repository somebody else wrote, so they are
// attacker-controlled text rendered into a privileged origin. The drawer now
// puts both through `textContent` (which needs no escaping at all and is
// therefore the right answer wherever it is available) — but the template
// literals elsewhere in the chrome still need one escaper, and it should be
// this one.
//
// Escapes all five: & < > " '. Safe in both element and quoted-attribute
// contexts. Ampersand first, or the other replacements get double-escaped.
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => MAP[c]);
}

export default esc;

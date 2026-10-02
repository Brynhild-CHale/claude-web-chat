// lib/core/stable-json.js — deterministic JSON: both forms, by name.
//
// "The same value always gives the same bytes, whatever order its keys were
// inserted in" is needed wherever two copies of one value reach the same keys
// along different paths (a live record and a node file, say) and are compared:
//
//   the node digest       does this turn change the surface? (domain/turns.js)
//   change detection      what differs between two surfaces, and does a pane's
//                         layout need resetting? (diff.js, domain/page.js)
//   pane-history hashes   is this the same version of a pane? (domain/lineage.js)
//   the tool-input hash   which tool call is this permission request for?
//                         (core/tool-input.js inputHash)
//
// There are TWO forms, and they are not interchangeable. Each is byte-for-byte
// the function it replaced, and must stay so:
//
//   stableStringify(v)  the node digest's form (it was a private copy in
//                       domain/turns.js). It builds the string by hand, so an
//                       undefined property is written `"k":undefined` (a pane's
//                       absent snapshot field still takes part in the digest),
//                       an undefined array element as nothing (`[,1]`), and a
//                       top-level undefined returns undefined.
//   stableKey(v)        change detection's form (it was diff.js's
//                       stableStringify, which diff.js still re-exports under
//                       that name). It copies the value into objects with sorted
//                       keys and hands that to JSON.stringify, which DROPS an
//                       undefined property and writes an undefined element as
//                       null; a top-level undefined becomes a NUL-prefixed
//                       sentinel, so it never equals null.
//
// They disagree on undefined and, through JSON.stringify's own rules, on
// integer-like keys (the copy re-orders them numerically), an own `__proto__`
// key (assigning it sets the copy's prototype, so it vanishes) and an own
// `toJSON` method (the copy calls it). Merging them would move every committed
// node's digest or every pane's version hash, so both live here under names that
// say which is which. test/core-helpers.test.js pins both against output
// captured from the original functions; a "tidier" rewrite of either is a
// change to every graph on disk.
//
// JSON values only: a cycle recurses until the stack runs out, and a BigInt
// throws, exactly as before.
//
// Dependency direction: core; this file imports only node:crypto.

const crypto = require('node:crypto');

// The node digest's form. Keys sorted by code unit; an undefined property is
// spelled `"k":undefined`.
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// Change detection's form: an order-independent deep stringify. undefined gets
// a distinct sentinel so an absent field differs from an explicit null.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
function stableKey(v) {
  if (v === undefined) return '\u0000undef';
  return JSON.stringify(sortKeys(v));
}

// sha1 (hex) of stableStringify(v). A value that form cannot spell at the top
// level (undefined, a function) hashes as the text `undefined`, the form's own
// spelling of it inside an object, rather than throwing.
function stableHash(v) {
  return crypto.createHash('sha1').update(String(stableStringify(v))).digest('hex');
}

module.exports = { stableStringify, stableKey, stableHash };

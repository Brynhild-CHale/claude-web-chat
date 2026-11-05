'use strict';
// The render-impact answer (annotation engine, PLAN.md 4F.2; INK@render-impact,
// AD3; settled default IMPACT@counts; rulings STREAM@4F AF1 (a), U563@private-
// count (a), U563-U580@catalogue-tool-edits (a)): how many annotations sit on
// the page items a write touched, so `render`, `use_component` and `clear`
// tell Claude at the moment it changes things — for every element type, the
// built-ins and a pack's alike.
//
//   annotationsOn(state, store, items, {remote}) → null | {item | items, total,
//                    by_type: {<type>: n}, shared, private?}
//                    `items` is the page item (pane or markdown ids: one id
//                    space) the write touched, a string, answered as `item`;
//                    or an array (a bulk clear's removed items), answered as
//                    `items`, the ids with any, in the order given. null when no annotation anchors any of them,
//                    so a caller attaches the field only when it is non-zero
//                    and every unannotated answer stays byte-equal.
//   annotationsOf(state, store, item, {remote}) → null | {ids: Map(id →
//                    {type, shared, v}), total, by_type, shared, private?}
//                    the per-item tally list_mounts reads, with the element
//                    ids the verdict (byState) is restricted to. The ids never
//                    leave the daemon: byState and the route read them.
//   byState(answers, ids, gen) → null | {exact, re_resolved, orphaned}
//                    the post-resolve verdict over the held answers
//                    (lib/server/domain/reports answers({mount})) for the
//                    item's live content only: an answer counts when its `gen`
//                    is the pane's live gen and its `v` the element's live
//                    version (`ids`' v: the reference's, or the live pin's), so
//                    a re-render or a moved element leaves its old answers out
//                    until a viewer reports again. The report table holds one
//                    answer per (mount, id@v), so that is at most one per
//                    element. Over the elements `ids` names only (live on the
//                    item and, for a remote request, shared). null when none.
//
// WHAT IS COUNTED. The daemon resolves no anchors: it knows only which live
// annotations anchor an item. Two sources, the same rule as the Wipe's
// (element-refs wipeDrops; the element API's mount filter, GET
// /api/elements?mount=, still reads anchorItem's one item, a page record's
// from-item):
//   - every live reference (element-refs refsOf) whose version the log places
//     (store.version(id, v)) and one of whose anchor's items (anchorItems:
//     one, but for a stroke's page record, whose arrow names two) is in
//     `items`; a version the log cannot place is skipped. Its type is the
//     store's typeOf(id), its privacy the version's own `shared` flag.
//   - every live comment pin (state.comments, the 0.8.5 copies) on those items,
//     its items by the same anchorItems rule (its `locator` for a legacy pin,
//     else its `anchor`), its privacy its own `shared`.
// IMPACT@both-items (tranche 5, U623): an annotation touching several of the
// asked items (an arrow from A to B, both cleared) is LISTED under each of
// them — a bulk answer's `items` names both, and annotationsOf on either item
// counts it — and COUNTED ONCE in an answer's total, by_type, shared and
// private: the total is the number of distinct annotations touching any of
// the asked items, never the sum over items.
//
// COUNTS ONLY: no id, no text, no anchor, no payload ever enters the answer.
// `remote: true` (a portal request) leaves every private element out of every
// count and omits `private` (K.5 J2: a private element is hidden from a remote
// viewer). A local caller — Claude's tools included — gets `private: n`, a
// number with no content (IMPACT@counts; notes-F §3: the one place Claude's
// tools learn a private element exists; the rules text frames it as the
// user's own notes).
//
// Pure: reads state and the store, writes nothing, emits nothing.

const { refsOf, anchorItems } = require('./element-refs');
const { parsePin } = require('../../core/element-log');

const COMMENT = 'comment';
// A reference whose type the store cannot name still counts, under this key.
const UNKNOWN_TYPE = 'unknown';
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

// The page items a live comment pin sits on: its legacy locator's mount, else
// its anchor's items (anchorItems' rule over {anchor}).
function pinItems(pin) {
  if (!isObj(pin)) return [];
  if (isObj(pin.locator) && typeof pin.locator.mount === 'string' && pin.locator.mount) return [pin.locator.mount];
  return anchorItems({ anchor: pin.anchor });
}
// The first of them, or null (the one-item reading, kept for its callers).
function pinItem(pin) {
  const items = pinItems(pin);
  return items.length ? items[0] : null;
}

// Every live annotation on `items` (a Set), once each: [{id, type, shared,
// item, items}] — `items` the asked items it touches, `item` the first.
function liveOn(state, store, items) {
  const out = [];
  if (!items.size) return out;
  for (const r of refsOf(state)) {
    const p = parsePin(r);
    if (!p) continue;
    let rec = null;
    try { rec = store && typeof store.version === 'function' ? store.version(p.id, p.v) : null; } catch { rec = null; }
    if (!rec) continue;
    const hit = anchorItems(rec.payload).filter((i) => items.has(i));
    if (!hit.length) continue;
    let type = null;
    try { type = typeof store.typeOf === 'function' ? store.typeOf(p.id) : null; } catch { type = null; }
    const payload = isObj(rec.payload) ? rec.payload : {};
    out.push({ id: p.id, v: p.v, type: typeof type === 'string' && type ? type : UNKNOWN_TYPE, shared: payload.shared !== false, item: hit[0], items: hit });
  }
  for (const pin of Array.isArray(state && state.comments) ? state.comments : []) {
    const hit = pinItems(pin).filter((i) => items.has(i));
    if (!hit.length) continue;
    out.push({ id: typeof pin.id === 'string' ? pin.id : null, v: pin.v, type: COMMENT, shared: pin.shared !== false, item: hit[0], items: hit });
  }
  return out;
}

// {total, by_type, shared, private?} over `list`, a remote request's without
// any private element; null when nothing is left to count.
function tally(list, remote) {
  const seen = remote ? list.filter((a) => a.shared) : list;
  if (!seen.length) return null;
  const counts = {};
  let shared = 0;
  for (const a of seen) {
    counts[a.type] = (counts[a.type] || 0) + 1;
    if (a.shared) shared += 1;
  }
  // by_type in type-name order, so an answer reads the same however the
  // references happen to be ordered.
  const by_type = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const out = { total: seen.length, by_type, shared };
  if (!remote) out.private = seen.length - shared;
  return { out, seen };
}

function annotationsOn(state, store, items, { remote = false } = {}) {
  const bulk = Array.isArray(items);
  const list = (bulk ? items : [items]).filter((i) => typeof i === 'string' && i);
  const ids = [...new Set(list)];
  if (!ids.length) return null;
  const t = tally(liveOn(state, store, new Set(ids)), !!remote);
  if (!t) return null;
  if (!bulk) return { item: ids[0], ...t.out };
  const withAny = new Set(t.seen.flatMap((a) => a.items));
  return { items: ids.filter((i) => withAny.has(i)), ...t.out };
}

function annotationsOf(state, store, item, { remote = false } = {}) {
  if (typeof item !== 'string' || !item) return null;
  const t = tally(liveOn(state, store, new Set([item])), !!remote);
  if (!t) return null;
  const ids = new Map();
  for (const a of t.seen) if (a.id) ids.set(a.id, { type: a.type, shared: a.shared, v: a.v });
  return { ids, ...t.out };
}

// The resolver's three answers as list_mounts names them.
const STATE_KEYS = Object.freeze({ exact: 'exact', 're-resolved': 're_resolved', orphaned: 'orphaned' });

function byState(answers, ids, gen) {
  if (!Array.isArray(answers) || !answers.length || !ids || !ids.size) return null;
  const out = { exact: 0, re_resolved: 0, orphaned: 0 };
  let any = false;
  for (const a of answers) {
    if (!isObj(a) || !STATE_KEYS[a.state] || a.gen !== gen) continue;
    const live = ids.get(a.id);
    if (!live || a.v !== live.v) continue;
    out[STATE_KEYS[a.state]] += 1;
    any = true;
  }
  return any ? out : null;
}

module.exports = { annotationsOn, annotationsOf, byState, pinItem };

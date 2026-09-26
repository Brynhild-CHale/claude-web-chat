// The page engine — the ONE owner of the page SEQUENCE and of the markdown items
// that sit in it.
//
// The page model (plan §2b D3, simplified by the maintainer): no stored section
// structure. The live surface is one ordered sequence of items, each either a
// PANE (lib/server/domain/mounts owns its record) or a MARKDOWN chunk (owned
// here). Markdown sits between and around panes; consecutive panes form a grid
// run; `#`–`###` headings in the markdown build the Contents nav. A node with no
// markdown is one grid run — exactly today's page — so nothing is migrated.
//
// Two pieces of live state, both on `state` (lib/server/state.js):
//   state.markdown  Map<id, { text, owner, gen }>
//   state.order     [id, …] — every pane id and markdown id, once, in page order
//
// Every write to either goes through this module (test/conventions.test.js
// ratchets it). The per-item writers keep `order` exact incrementally — setMount
// calls place(), removeMount calls drop() — and the BULK paths that replace the
// whole surface (restore to a node, the boot draft, Wipe, the bulk clear) call
// restore()/clearMarkdown()/reconcile() rather than reasoning about order
// themselves.
//
// Ids share ONE namespace across panes and markdown: they are siblings in the
// sequence and `after` names either kind, so a markdown id that equals a pane id
// is refused (and vice versa, in setMount).
//
// Persistence mirrors the mount record: MARKDOWN_FIELDS is the field authority for
// the writer (snapshot) and the reader (restore) alike; `gen` is live-only, as it
// is for panes (D18). A committed node carries `markdown` + `order` only when it
// HAS markdown — without it the node's `mounts` array order already is the page
// order, which is also how every node written before this module reads back.

const MARKDOWN_FIELDS = ['text', 'owner'];

// A markdown chunk is prose between panes, not a document store. The cap keeps a
// runaway write from turning every committed node into a megabyte of text.
const MARKDOWN_MAX_CHARS = 32 * 1024;

function ensure(state) {
  if (!(state.markdown instanceof Map)) state.markdown = new Map();
  if (!Array.isArray(state.order)) state.order = [];
  return state;
}

function hydrateMarkdown(m) {
  const out = {};
  for (const k of MARKDOWN_FIELDS) out[k] = m[k];
  return out;
}

// ── the order, as a pure function of a surface ──────────────────────────────
// `s` is any surface-shaped value: a graph node, a draft, a live snapshot. Its
// `order` is honoured for the ids it names that still exist; anything it does
// not name (every pane of a node written before `order` existed) follows in
// `mounts` array order, then `markdown` array order. Dangling and duplicate ids
// drop out. The same answer for the same surface, whoever asks — the dirty
// check, the diff, the preview and the export all read the page through this.
function pageOrder(s) {
  const mounts = Array.isArray(s && s.mounts) ? s.mounts : [];
  const markdown = Array.isArray(s && s.markdown) ? s.markdown : [];
  const known = new Set();
  const all = [];
  for (const m of mounts) if (m && m.id != null && !known.has(String(m.id))) { known.add(String(m.id)); all.push(String(m.id)); }
  for (const m of markdown) if (m && m.id != null && !known.has(String(m.id))) { known.add(String(m.id)); all.push(String(m.id)); }
  const out = [];
  const placed = new Set();
  for (const id of (Array.isArray(s && s.order) ? s.order : [])) {
    const k = String(id);
    if (known.has(k) && !placed.has(k)) { placed.add(k); out.push(k); }
  }
  for (const id of all) if (!placed.has(id)) { placed.add(id); out.push(id); }
  return out;
}

// The live form: rebuild state.order from what is actually live, keeping the
// current order for every id that survives.
function reconcile(state) {
  ensure(state);
  const known = new Set([...state.mounts.keys(), ...state.markdown.keys()]);
  const out = [];
  const placed = new Set();
  for (const id of state.order) if (known.has(id) && !placed.has(id)) { placed.add(id); out.push(id); }
  for (const id of state.mounts.keys()) if (!placed.has(id)) { placed.add(id); out.push(id); }
  for (const id of state.markdown.keys()) if (!placed.has(id)) { placed.add(id); out.push(id); }
  state.order = out;
  return out;
}

// ── placing one item ────────────────────────────────────────────────────────
// `after`: undefined → a NEW item appends, an existing one keeps its place (a
// same-id re-render never moves). 'start' → first. An id in the page → right
// after it. Anything else (unknown id, or the item itself) → treated as
// undefined, and a `warning` comes back for the caller to hand on — the write
// still lands, because refusing prose over a stale anchor would lose it.
function place(state, id, after) {
  ensure(state);
  const cur = state.order.indexOf(id);
  const exists = cur !== -1;
  let warning = null;
  let anchor = after;
  if (anchor != null && anchor !== 'start') {
    anchor = String(anchor);
    if (anchor === id || !state.order.includes(anchor)) {
      warning = anchor === id
        ? `after:'${anchor}' names the item itself; ${exists ? 'kept its position' : 'appended'}`
        : `after:'${anchor}' is not on the page; ${exists ? 'kept its position' : 'appended'}`;
      anchor = undefined;
    }
  }
  if (anchor == null) {
    if (!exists) state.order.push(id);
    return { warning, moved: !exists };
  }
  if (exists) state.order.splice(cur, 1);
  if (anchor === 'start') state.order.unshift(id);
  else state.order.splice(state.order.indexOf(anchor) + 1, 0, id);
  return { warning, moved: true };
}

function drop(state, id) {
  ensure(state);
  const i = state.order.indexOf(id);
  if (i !== -1) state.order.splice(i, 1);
}

// Live panes in page order — what hello/reset, the snapshot and list_mounts
// present, so a reader of the mounts array alone (today's chrome) already sees
// the panes in the order the page puts them.
function orderedMounts(state) {
  ensure(state);
  reconcile(state);
  const out = [];
  for (const id of state.order) if (state.mounts.has(id)) out.push([id, state.mounts.get(id)]);
  return out;
}

function orderedMarkdown(state) {
  ensure(state);
  reconcile(state);
  const out = [];
  for (const id of state.order) if (state.markdown.has(id)) out.push([id, state.markdown.get(id)]);
  return out;
}

// ── markdown writes ─────────────────────────────────────────────────────────

// md-1, md-2, … — the next free number above every md-N already on the page.
function nextMarkdownId(state) {
  ensure(state);
  let max = 0;
  for (const id of [...state.markdown.keys(), ...state.mounts.keys()]) {
    const m = /^md-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `md-${max + 1}`;
}

function conflictReject(id, kind) {
  return {
    ok: false,
    rejected: true,
    conflict: kind,
    id,
    hint: `'${id}' is already a ${kind === 'pane' ? 'pane' : 'markdown item'} on this page; panes and markdown share one id space — pick another id`,
  };
}

function frameFor(id, rec, order) {
  return { type: 'markdown', id, text: rec.text, owner: rec.owner, order: order.slice() };
}

// Put (or replace, by id) a markdown item. The same soft-refusal conventions as
// setMount — a 200 with `ok:false` — for a reserved id, an id a pane holds, a
// foreign owner without force, and text over the cap. A malformed request (text
// not a string) is the route's 400.
function putMarkdown(state, bus, { id, text, after, owner, force = false } = {}) {
  // Lazy: mounts.js requires this module at load for place()/drop().
  const { isReservedId, ownerReject, reservedReject, normalizeOwner } = require('./mounts');
  ensure(state);
  const who = normalizeOwner(owner);
  const mid = id == null || id === '' ? nextMarkdownId(state) : String(id);
  if (isReservedId(mid)) return reservedReject(mid);
  if (state.mounts.has(mid)) return conflictReject(mid, 'pane');
  const body = String(text);
  if (body.length > MARKDOWN_MAX_CHARS) {
    return {
      ok: false, rejected: true, too_large: true, id: mid, chars: body.length, limit: MARKDOWN_MAX_CHARS,
      hint: `markdown is capped at ${MARKDOWN_MAX_CHARS} characters; keep page prose short — split it, or put bulk content in a pane`,
    };
  }
  const existing = state.markdown.get(mid);
  if (existing && existing.owner && existing.owner !== who && !force) return ownerReject(mid, existing.owner);
  const gen = existing ? ((existing.gen || 0) + 1) : 0;
  const rec = { text: body, owner: who, gen };
  state.markdown.set(mid, rec);
  const { warning } = place(state, mid, after);
  bus.emit({
    event: { kind: 'markdown', op: 'put', id: mid, bytes: body.length, source: who },
    ws: frameFor(mid, rec, state.order),
  });
  return { ok: true, id: mid, owner: who, ...(warning ? { warning } : {}) };
}

// Take one markdown item off the page. Returns whether one was removed. The
// owner gate is the caller's (the clear route applies one rule to both kinds).
function removeMarkdown(state, bus, { id, source } = {}) {
  ensure(state);
  if (id == null || !state.markdown.has(id)) return false;
  state.markdown.delete(id);
  drop(state, id);
  bus.emit({
    event: { kind: 'markdown', op: 'remove', id, source },
    ws: { type: 'markdown:remove', id },
  });
  return true;
}

// Bulk: drop every markdown item, no frames — for the paths that broadcast a
// whole-surface `reset` (Wipe, new graph, boot) or batch their own frames (the
// bulk clear). Returns the ids removed.
function clearMarkdown(state) {
  ensure(state);
  const ids = [...state.markdown.keys()];
  state.markdown.clear();
  reconcile(state);
  return ids;
}

// ── persistence ─────────────────────────────────────────────────────────────

// The page half of a live snapshot: markdown records (MARKDOWN_FIELDS only, in
// page order) plus the full order.
function snapshot(state) {
  ensure(state);
  return {
    markdown: orderedMarkdown(state).map(([id, m]) => ({ id, ...hydrateMarkdown(m) })),
    order: state.order.slice(),
  };
}

// The page fields a committed NODE carries: none when the page has no markdown,
// because then the node's mounts array order already is the page order.
function nodeFields(snap) {
  const md = Array.isArray(snap && snap.markdown) ? snap.markdown : [];
  if (!md.length) return {};
  return { markdown: md.map((m) => ({ ...m })), order: pageOrder(snap) };
}

// Bulk restore from a node or draft. Call AFTER state.mounts has been refilled.
function restore(state, s) {
  ensure(state);
  state.markdown.clear();
  for (const m of (Array.isArray(s && s.markdown) ? s.markdown : [])) {
    if (!m || m.id == null || state.mounts.has(String(m.id))) continue;
    state.markdown.set(String(m.id), hydrateMarkdown(m));
  }
  state.order = pageOrder({
    mounts: [...state.mounts.keys()].map((id) => ({ id })),
    markdown: [...state.markdown.keys()].map((id) => ({ id })),
    order: s && s.order,
  });
}

module.exports = {
  MARKDOWN_FIELDS,
  MARKDOWN_MAX_CHARS,
  ensure,
  hydrateMarkdown,
  pageOrder,
  reconcile,
  place,
  drop,
  orderedMounts,
  orderedMarkdown,
  nextMarkdownId,
  putMarkdown,
  removeMarkdown,
  clearMarkdown,
  snapshot,
  nodeFields,
  restore,
};

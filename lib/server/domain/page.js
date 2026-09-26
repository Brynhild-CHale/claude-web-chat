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
// Four pieces of live state, all on `state` (lib/server/state.js):
//   state.markdown     Map<id, { text, owner, gen }>
//   state.order        [id, …] — every pane id and markdown id, once, in page order
//   state.claudeOrder  [id, …] — the same ids in the order CLAUDE last proposed:
//                      the order half of "Claude's layout" (↺ resetLayout). Every
//                      agent/driver write (place) moves an item in both
//                      sequences; a USER move (moveItem) moves it in `order` only.
//   state.runs         { [anchor]: { stacks:false } } — per-grid-run flags, keyed
//                      by the run's anchor: the markdown id right before the run,
//                      or 'start' for the run the page opens with. Default
//                      (stacks:true) is the absence of an entry.
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
  if (!Array.isArray(state.claudeOrder)) state.claudeOrder = state.order.slice();
  if (!state.runs || typeof state.runs !== 'object' || Array.isArray(state.runs)) state.runs = {};
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
  syncClaudeOrder(state);
  pruneRuns(state);
  return out;
}

// Keep the baseline sequence over exactly the live ids: drop what left the page,
// and append anything it has never seen in live page order (an item restored
// from a node written before the baseline existed has no other answer).
function syncClaudeOrder(state) {
  const live = new Set(state.order);
  const out = [];
  const placed = new Set();
  for (const id of state.claudeOrder) if (live.has(id) && !placed.has(id)) { placed.add(id); out.push(id); }
  for (const id of state.order) if (!placed.has(id)) { placed.add(id); out.push(id); }
  state.claudeOrder = out;
}

// A run flag whose anchor left the page goes with it; an EMPTY page has no runs.
function pruneRuns(state) {
  if (!state.mounts.size && !state.markdown.size) { state.runs = {}; return; }
  for (const a of Object.keys(state.runs)) {
    if (a !== 'start' && !state.markdown.has(a)) delete state.runs[a];
  }
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
  // place() is the AGENT/DRIVER write (setMount, putMarkdown), so the item moves
  // in Claude's baseline sequence exactly as it moves on the page. The baseline
  // is synced first: it must hold the same ids as `order` for the anchor to mean
  // the same thing in both.
  syncClaudeOrder(state);
  if (anchor == null) {
    if (!exists) { state.order.push(id); state.claudeOrder.push(id); }
    return { warning, moved: !exists };
  }
  insertAfter(state.order, id, anchor);
  insertAfter(state.claudeOrder, id, anchor);
  return { warning, moved: true };
}

// Move `id` to right after `anchor` ('start' = first) within one sequence. The
// anchor is known to be in `seq` and to differ from `id`.
function insertAfter(seq, id, anchor) {
  const cur = seq.indexOf(id);
  if (cur !== -1) seq.splice(cur, 1);
  if (anchor === 'start') seq.unshift(id);
  else seq.splice(seq.indexOf(anchor) + 1, 0, id);
}

function drop(state, id) {
  ensure(state);
  const i = state.order.indexOf(id);
  if (i !== -1) state.order.splice(i, 1);
  const j = state.claudeOrder.indexOf(id);
  if (j !== -1) state.claudeOrder.splice(j, 1);
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

function frameFor(id, rec, state) {
  return { type: 'markdown', id, text: rec.text, owner: rec.owner, order: state.order.slice(), claude_order: state.claudeOrder.slice() };
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
    ws: frameFor(mid, rec, state),
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
// page order), the full order, and the layout state (Claude's baseline order +
// the run flags) — as fields that are ABSENT at their defaults, so a snapshot of
// a page nobody rearranged is exactly what it was before layout existed.
function snapshot(state) {
  ensure(state);
  reconcile(state);
  const pg = {
    markdown: orderedMarkdown(state).map(([id, m]) => ({ id, ...hydrateMarkdown(m) })),
    order: state.order.slice(),
  };
  return { ...pg, ...layoutFields({ ...pg, mounts: state.order.filter((id) => state.mounts.has(id)).map((id) => ({ id })), claude_order: state.claudeOrder, runs: state.runs }) };
}

// The layout half of any surface-shaped value, normalised and default-free:
//   claude_order  only when it differs from the page order (a user moved something)
//   runs          only the valid anchors with a non-default flag
// The one reading of both — node fields, the draft, the no-change check and the
// diff all go through it, so "differs from default" means one thing.
function layoutFields(s) {
  const out = {};
  const ord = pageOrder(s);
  if (Array.isArray(s && s.claude_order)) {
    const co = pageOrder({ ...s, order: s.claude_order });
    if (co.some((id, i) => id !== ord[i])) out.claude_order = co;
  }
  const runs = s && s.runs && typeof s.runs === 'object' && !Array.isArray(s.runs) ? s.runs : null;
  if (runs) {
    const md = new Set((Array.isArray(s.markdown) ? s.markdown : []).map((m) => m && String(m.id)));
    const kept = {};
    for (const [a, f] of Object.entries(runs)) {
      if (a !== 'start' && !md.has(a)) continue;
      if (f && f.stacks === false) kept[a] = { stacks: false };
    }
    if (Object.keys(kept).length) out.runs = kept;
  }
  return out;
}

// The page fields a committed NODE carries: markdown + order only when the page
// has markdown, because then the node's mounts array order already is the page
// order; claude_order / runs only when they are not at their defaults.
function nodeFields(snap) {
  const md = Array.isArray(snap && snap.markdown) ? snap.markdown : [];
  const out = md.length ? { markdown: md.map((m) => ({ ...m })), order: pageOrder(snap) } : {};
  return { ...out, ...layoutFields(snap) };
}

// Bulk restore from a node or draft. Call AFTER state.mounts has been refilled.
// A surface with no `claude_order` (every node written before it, and every
// node nobody rearranged) takes its page order as Claude's baseline.
function restore(state, s) {
  ensure(state);
  state.markdown.clear();
  for (const m of (Array.isArray(s && s.markdown) ? s.markdown : [])) {
    if (!m || m.id == null || state.mounts.has(String(m.id))) continue;
    state.markdown.set(String(m.id), hydrateMarkdown(m));
  }
  const ids = {
    mounts: [...state.mounts.keys()].map((id) => ({ id })),
    markdown: [...state.markdown.keys()].map((id) => ({ id })),
  };
  state.order = pageOrder({ ...ids, order: s && s.order });
  state.claudeOrder = Array.isArray(s && s.claude_order)
    ? pageOrder({ ...ids, order: s.claude_order })
    : state.order.slice();
  state.runs = {};
  const runs = s && s.runs && typeof s.runs === 'object' && !Array.isArray(s.runs) ? s.runs : {};
  for (const [a, f] of Object.entries(runs)) if (f && f.stacks === false) state.runs[a] = { stacks: false };
  syncClaudeOrder(state);
  pruneRuns(state);
}

// ── layout: placement, Claude's baseline, runs ─────────────────────────────
// A pane's size and column live in its pane_state (the chrome's own record,
// carried across re-renders by the mount engine):
//   col      1–12, the grid column it starts in (absent = auto flow)
//   colSpan  2–12 columns wide (absent = 12)
//   rows     2–24 rows of ROW_PX (absent = auto height)
//   heightPx rows × ROW_PX — kept beside `rows` because the current chrome and
//            every node written before `rows` existed size a pane by it
// `place:{col, span, rows}` on render / use_component is how Claude proposes one;
// the proposal is also kept as pane_state.claude_place, the per-pane half of
// "Claude's layout" that resetLayout (↺) restores. A user drag or resize changes
// the layout keys only — never claude_place, never state.claudeOrder.

const GRID_COLS = 12;
const SPAN_MIN = 2;
const ROWS_MIN = 2;
const ROWS_MAX = 24;
const ROW_PX = 40;
// Every pane_state key that says where a pane sits or how big it is. `rowSpan` is
// the pre-heightPx legacy form (60px a row), read but never written.
const LAYOUT_KEYS = ['col', 'colSpan', 'rows', 'heightPx', 'rowSpan'];

function toInt(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
const clampTo = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Clamp a requested placement into the grid. Returns null for a non-object.
// span shrinks to fit the columns right of `col`; only when even SPAN_MIN would
// not fit does `col` move left. An omitted span is "the rest of the row".
function normalizePlace(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const c = toInt(p.col);
  const s = toInt(p.span);
  const r = toInt(p.rows);
  let col = c == null ? null : clampTo(c, 1, GRID_COLS);
  let span = s == null ? GRID_COLS : clampTo(s, SPAN_MIN, GRID_COLS);
  if (col != null) {
    if (col > GRID_COLS - SPAN_MIN + 1) col = GRID_COLS - SPAN_MIN + 1;
    span = Math.min(span, GRID_COLS - col + 1);
  }
  const rows = r == null ? null : clampTo(r, ROWS_MIN, ROWS_MAX);
  return { col, span, rows };
}

function rowsFromPx(px) {
  const n = Number(px);
  return Number.isFinite(n) && n > 0 ? clampTo(Math.round(n / ROW_PX), ROWS_MIN, ROWS_MAX) : null;
}

// The {col, span, rows} a pane_state describes — the one READING of it. `rows`
// falls back to heightPx (then the legacy rowSpan) so an old node answers in rows
// without being rewritten.
function placeOf(ps) {
  const s = ps || {};
  const c = toInt(s.col);
  const col = c != null && c >= 1 && c <= GRID_COLS ? c : null;
  const sp = toInt(s.colSpan);
  const span = sp != null && sp >= 1 ? Math.min(sp, GRID_COLS) : GRID_COLS;
  let rows = toInt(s.rows);
  if (rows == null) rows = rowsFromPx(s.heightPx);
  if (rows == null && s.rowSpan > 1) rows = rowsFromPx(s.rowSpan * 60);
  return { col, span, rows };
}

function stripLayout(ps) {
  const out = { ...(ps || {}) };
  for (const k of LAYOUT_KEYS) delete out[k];
  return out;
}

// pane_state keys for a normalised placement — absent where the placement is auto.
function layoutKeys(pl) {
  const out = {};
  if (pl.col != null) out.col = pl.col;
  out.colSpan = pl.span;
  if (pl.rows != null) { out.rows = pl.rows; out.heightPx = pl.rows * ROW_PX; }
  return out;
}

// Claude places a pane: the layout keys become the placement and the placement
// becomes the baseline. Everything else in pane_state (pinned, locked, mode,
// minimized) is the user's and carries untouched.
function applyPlace(ps, pl) {
  return { ...stripLayout(ps), ...layoutKeys(pl), claude_place: { ...pl } };
}

// A pane_state put back to Claude's layout: the baseline placement (or, with no
// baseline, no layout keys at all — the default a never-placed pane has) and not
// minimized. undefined stays undefined: a pane nobody touched has nothing to reset.
function baselinePaneState(ps) {
  if (!ps) return ps;
  const out = stripLayout(ps);
  delete out.minimized;
  if (ps.claude_place) Object.assign(out, layoutKeys(normalizePlace(ps.claude_place) || {}));
  return out;
}

// The browser's pane:state is a MERGE, so a reset frame spells every layout key
// out — a key the reset removed would otherwise survive in the chrome.
function paneStateFrame(ps) {
  return {
    ...ps,
    col: ps.col == null ? null : ps.col,
    colSpan: ps.colSpan == null ? GRID_COLS : ps.colSpan,
    rows: ps.rows == null ? null : ps.rows,
    heightPx: ps.heightPx == null ? null : ps.heightPx,
    minimized: !!ps.minimized,
  };
}

// A browser pane:state patch, merged onto the stored record. Two rules live here
// and nowhere else:
//   * the LOCK. A pane locked BEFORE this patch refuses any change to where it
//     sits or how big it is — the patch's layout keys are dropped and named in
//     `refused` (the route re-sends the authoritative state so the dragging
//     client snaps back). Everything else applies, unlock included: unlocking is
//     how the user gets the pane back, and the move after it is then allowed.
//   * rows ↔ heightPx. Whichever side the patch sets, the other follows, so the
//     current chrome (heightPx) and a rows-speaking one never disagree. `rows` is
//     only ever re-derived on a pane that already carries it — an old pane is not
//     rewritten by being resized.
function patchPaneState(prev, patch) {
  const before = prev || {};
  const p = { ...(patch && typeof patch === 'object' ? patch : {}) };
  const refused = [];
  if (before.locked) {
    const now = placeOf(before);
    const next = placeOf({ ...before, ...p });
    const moved = now.col !== next.col || now.span !== next.span || now.rows !== next.rows;
    if (moved) for (const k of LAYOUT_KEYS) if (k in p) { refused.push(k); delete p[k]; }
  }
  const out = { ...before, ...p };
  if ('rows' in p) {
    const r = toInt(p.rows);
    if (r == null) { delete out.rows; out.heightPx = null; }
    else { out.rows = clampTo(r, ROWS_MIN, ROWS_MAX); out.heightPx = out.rows * ROW_PX; }
  } else if ('heightPx' in p && 'rows' in out) {
    const r = rowsFromPx(out.heightPx);
    if (r == null) delete out.rows; else out.rows = r;
  }
  return { pane_state: out, refused };
}

// ── runs ──
// A run is the consecutive panes after its anchor: the markdown id right before
// them, or 'start' for the panes the page opens with. Derived from the order on
// every read — there is no stored run structure to drift.
function isAnchor(state, anchor) {
  return anchor === 'start' || (anchor != null && state.markdown.has(String(anchor)));
}

function runPanes(state, anchor) {
  let i = anchor === 'start' ? 0 : state.order.indexOf(String(anchor)) + 1;
  const out = [];
  for (; i < state.order.length; i++) {
    const id = state.order[i];
    if (state.markdown.has(id)) break;
    if (state.mounts.has(id)) out.push(id);
  }
  return out;
}

function anchorReject(anchor) {
  return {
    ok: false,
    rejected: true,
    unknown_anchor: true,
    anchor,
    hint: `'${anchor}' is not a run anchor; a run is anchored by the markdown id right before it, or 'start'`,
  };
}

function lockedMoveReject(id) {
  return {
    ok: false,
    rejected: true,
    locked: true,
    id,
    hint: `pane '${id}' is locked; unlock it to move or resize it`,
  };
}

const isLocked = (state, id) => {
  const m = state.mounts.get(id);
  return !!(m && m.pane_state && m.pane_state.locked);
};

// ↺ Claude's layout, for one run: every UNLOCKED pane in it goes back to its
// baseline placement, un-minimized, and the run's unlocked panes are re-sorted
// into Claude's order within the slots they occupy (a locked pane keeps its slot
// and its size). The reset is scoped to the run as it stands: it re-sorts the
// panes that are in it now; it does not pull back a pane the user dragged into
// another run. A user action — it moves `order`, never the baseline.
function resetLayout(state, bus, { anchor, source = 'browser' } = {}) {
  ensure(state);
  reconcile(state);
  if (!isAnchor(state, anchor)) return anchorReject(anchor);
  const a = String(anchor);
  const inRun = runPanes(state, a);
  const locked = inRun.filter((id) => isLocked(state, id));
  const movable = inRun.filter((id) => !isLocked(state, id));
  const slots = movable.map((id) => state.order.indexOf(id));
  const rank = new Map(state.claudeOrder.map((id, i) => [id, i]));
  const sorted = movable.slice().sort((x, y) => (rank.get(x) - rank.get(y)) || (movable.indexOf(x) - movable.indexOf(y)));
  const reordered = sorted.some((id, i) => id !== movable[i]);
  if (reordered) {
    const next = state.order.slice();
    sorted.forEach((id, i) => { next[slots[i]] = id; });
    state.order = next;
  }
  const { stableStringify } = require('../diff');
  const frames = [];
  const reset = [];
  for (const id of movable) {
    const m = state.mounts.get(id);
    const next = baselinePaneState(m.pane_state);
    if (stableStringify(next) === stableStringify(m.pane_state)) continue;
    m.pane_state = next;
    reset.push(id);
    frames.push({ type: 'pane:state', id, pane_state: paneStateFrame(next) });
  }
  if (reordered) frames.push({ type: 'page:order', order: state.order.slice() });
  if (frames.length) {
    bus.emit({
      event: { kind: 'page', op: 'reset-layout', anchor: a, ids: reset, reordered, source },
      ws: frames,
    });
  }
  return { ok: true, anchor: a, reset, reordered, skipped_locked: locked };
}

// Per-run responsive flag. stacks:true (the default, and so stored as nothing)
// lets the run fold to one column on a narrow screen; false keeps the fixed grid
// and scrolls it sideways.
function setRunFlag(state, bus, { anchor, stacks, source = 'browser' } = {}) {
  ensure(state);
  if (!isAnchor(state, anchor)) return anchorReject(anchor);
  const a = String(anchor);
  if (stacks) delete state.runs[a];
  else state.runs[a] = { stacks: false };
  bus.emit({
    event: { kind: 'page', op: 'run', anchor: a, stacks: !!stacks, source },
    ws: { type: 'page:run', anchor: a, stacks: !!stacks },
  });
  return { ok: true, anchor: a, stacks: !!stacks };
}

// A USER move in the page sequence (drag-reorder): `order` only — the baseline
// stays where Claude put the item, which is what ↺ goes back to. A locked pane
// refuses; so does an anchor that is not on the page (unlike an agent write's
// append-with-warning, a drop onto nothing should do nothing).
function moveItem(state, bus, { id, after, source = 'browser' } = {}) {
  ensure(state);
  reconcile(state);
  const mid = id == null ? '' : String(id);
  if (!state.order.includes(mid)) {
    return { ok: false, rejected: true, unknown: true, id: mid, hint: `'${mid}' is not on the page` };
  }
  if (isLocked(state, mid)) return lockedMoveReject(mid);
  const anchor = after === 'start' ? 'start' : (after == null ? '' : String(after));
  if (anchor !== 'start' && (anchor === mid || !state.order.includes(anchor))) {
    return {
      ok: false, rejected: true, unknown_anchor: true, id: mid, anchor,
      hint: `after:'${anchor}' is not another item on the page (use an item id or 'start')`,
    };
  }
  const before = state.order.join('\n');
  const next = state.order.slice();
  insertAfter(next, mid, anchor);
  state.order = next;
  if (state.order.join('\n') !== before) {
    bus.emit({
      event: { kind: 'page', op: 'move', id: mid, after: anchor, source },
      ws: { type: 'page:order', order: state.order.slice() },
    });
  }
  return { ok: true, id: mid, order: state.order.slice() };
}

// The anchor keyword for the top of the page: `after:'start'` places an item
// first, and the run the page opens with is keyed 'start'. So it can never be an
// item id — `after:'start'` and a run flag would each have two meanings — and
// mounts.isReservedId refuses it for panes and markdown alike.
const PAGE_START = 'start';

module.exports = {
  PAGE_START,
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
  layoutFields,
  nodeFields,
  restore,
  GRID_COLS,
  ROW_PX,
  LAYOUT_KEYS,
  normalizePlace,
  placeOf,
  applyPlace,
  baselinePaneState,
  patchPaneState,
  runPanes,
  resetLayout,
  setRunFlag,
  moveItem,
};

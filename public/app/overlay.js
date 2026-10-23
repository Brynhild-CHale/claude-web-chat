// The page well's element overlay (annotation engine 2A.1): ONE body-level
// layer, #el-layer, that draws the anchored elements of the page from the
// resolver's answers, clipped to what the page actually shows. It is the one
// home of the overlay concept (PLAN.md §0's engines rule): the element types
// (comment, highlight, box grab), the hidden-state probe, the report batching,
// the input-mode policy, the tool arming and the orphan stand-in all plug in
// through the seams below, never by editing this file.
//
// What it draws. Two element sets, 'live' and 'preview'; the one drawn is the
// one matching view.previewing. 'live' is filled from the hello and reset
// frames' `elements` (with the frame's `surface` counter kept beside it); a
// later unit relays incremental element frames through setElements /
// upsertElements / removeElements. 'preview' is filled from the previewed
// node (topbar.js previewNode emits bus 'preview:node'): its `lean_elements`
// (the daemon's projection of the node's 0.8.5 comment copies, anchors already
// in the resolver's form) and its `elements` id@v references, held as pending
// rows that draw nothing until a later unit hands their anchors back through
// upsertElements('preview', …). The chrome converts no 0.8.5 locator: every
// anchor reaches it already in the resolver's form.
//
// How it resolves. One anchors.watch() per mount that has element or range
// rows in the drawn set: the resolver's one settle listener turns a pane's
// settle into a coalesced pass against its cached index (PLAN.md §7 items 2
// and 3), and a set change starts one resolveAll pass per touched mount (the
// same cached index). A source row (an anchor on a markdown item) is resolved
// by resolveSource over the item's current page text and its sourceMap, on a
// markdown frame, after the hello / reset applier and on a set change, in a
// frame of its own. resolve() is never called per record.
//
// How it draws. An answer delivered by the resolver is only STORED here and a
// draw frame is asked for, so the overlay's box reads never share the
// resolver's delivering frame (condition C-05-3). A draw frame reads boxes for
// at most the budget (10 ms, the resolver's) and carries the rest to the next
// frame — its look-ahead is THIS frame's own cost per group (the costliest
// after its first, which pays any layout flush), never a figure kept across
// frames, so one slow read never throttles the frames after it; a frame reads
// every box of its slice before it writes any marker style; markers are rebuilt only when the drawn set's signature changes and
// otherwise moved (comments.js's F11 rule). Each frame is reported on bus
// 'overlay:frame' and summed in stats().
//
// The clip (S-1). A marker is drawn only when its anchor point lies inside the
// intersection of the viewport, the well's box (#main) and the client box of
// every overflow-clipping ancestor from the anchor up through each shadow host
// (getRootNode().host); the glyph's own box — the anchor point plus the
// marker's transform offset and size, both written inline from the type's
// glyph, so the clip reads exactly what is drawn — is clipped to that
// intersection with clip-path, so no part of a glyph paints over the rail,
// the minbar or the bottom bar.
//
// It makes no network call, sends no report (U314's, through onAnswers), and
// assigns `hidden` only through the probe seam (U303's). Previews are
// read-only (D2): no create and no pick runs while previewing. Tranche 2 draws
// in the live chrome only (F-DOCS (a)): a preview, export or replay document
// draws no element.
import { bus } from './bus.js';
import { view, $ } from './state.js';
import { page } from './page.js';
import { onFrame, onHello } from './ws.js';
import { sourceMap } from './markdown.js';
import anchors from './anchors.js';
import { hiddenProbe, installRetriggers } from './overlay-hidden.js';
// How a tool takes the pointer routed to it (capture, cancel its default) is
// the input-mode policy's answer, never a rule of this file's. input-mode.js
// imports this module too: the cycle is safe because neither reads the other's
// bindings while it evaluates (dispatchMode is read only inside onPointer).
import { dispatchMode } from './input-mode.js';

// ── the vocabulary ──────────────────────────────────────────────────────────
// The states come from the one vocabulary (lib/core/anchor-states, carried by
// the resolver's module), never spelled as a bare literal here.
function stateOf(name) {
  if (!anchors.STATES || anchors.STATES.indexOf(name) < 0) throw new Error(`overlay: the state vocabulary has no ${name}`);
  return name;
}
const EXACT = stateOf('exact');
const RE_RESOLVED = stateOf('re-resolved');
const ORPHANED = stateOf('orphaned');
const HIDDEN = stateOf('hidden');

export const DEFAULT_BUDGET_MS = 10;
export const SCOPES = Object.freeze(['live', 'preview']);
// The input kinds a tool registers (U335's manifest field `taps | strokes |
// selection`, K.2-6). A `taps` tool gets the gesture's click; a `strokes` or
// `selection` tool gets every event of the gesture (input.phase names it).
export const INPUT_KINDS = Object.freeze(['taps', 'strokes', 'selection']);
// The pointer policy's three answers.
export const POINTER_ANSWERS = Object.freeze(['tool', 'page', 'ignore']);
export const PICK_KINDS = Object.freeze(['element', 'range', 'source']);
// The generic marker's glyph: a 26px box whose bottom centre is the anchor
// point (the comment pin's shape). A type may register its own.
export const MARKER_GLYPH = Object.freeze({ dx: -13, dy: -26, w: 26, h: 26 });

// THE DRAW RULES: how an answer is drawn, first matching row wins. `how` and
// `guess` null match anything. A section answer (re-resolved, how 'section')
// is a SECTION GUESS, never drawn as a hit (RULED GT-03@source-section-fallback,
// DECISIONS.md I.5 F2 (a)); an orphan the resolver carried a guess for (how
// 'locator-guess', a guess element) is drawn at the guess as a carried guess,
// flagged for the re-anchor seam (I.8 O1, I.7 M1, alpha.1 finding K-10); an
// orphan with no guess is never drawn and is listed by orphans(); a hidden
// element (the probe's) is neither drawn nor listed.
export const DRAW_RULES = Object.freeze([
  Object.freeze({ state: EXACT, how: null, guess: null, draw: 'hit', cls: 'el-hit', listed: false }),
  Object.freeze({ state: RE_RESOLVED, how: 'section', guess: null, draw: 'section', cls: 'el-section', listed: false }),
  // The re-resolved row's draw relies on the edit-tolerance reading below.
  Object.freeze({ state: RE_RESOLVED, how: null, guess: null, draw: 'hit', cls: 'el-hit', listed: false }),
  Object.freeze({ state: ORPHANED, how: null, guess: true, draw: 'guess', cls: 'el-guess', listed: true }),
  Object.freeze({ state: ORPHANED, how: null, guess: false, draw: 'none', cls: null, listed: true }),
  Object.freeze({ state: HIDDEN, how: null, guess: null, draw: 'none', cls: null, listed: false }),
]);

// The edited-element reading the re-resolved row's draw relies on (PLAN.md §7
// item 6; H4, G8): P-1, the share of edited elements the resolver re-finds,
// read 0.7589 over 589 anchors at the 1C gate on 39b52f8
// (results/gate-t1-1C.md); H4's four-anchor margin read as five anchors above
// the 0.75 refute line there. THE TRIGGER STAYS LIVE: if a later gate reads
// P-1 under 0.75, G8 fires and the edit-tolerant text term is built in the
// resolver. Nothing here changes a resolver rule (lib/core/anchors.js is
// U307's alone in tranche 2).
export const EDIT_TOLERANCE = Object.freeze({
  reading: 'P-1',
  value: 0.7589,
  of: 589,
  gate: '1C',
  head: '39b52f8',
  source: 'results/gate-t1-1C.md',
  margin_anchors: 5,
  refute_line: 0.75,
  trigger: 'G8: a P-1 reading under 0.75 builds the edit-tolerant text term',
  live: true,
});

export function drawRuleOf(answer) {
  const st = answer && answer.state;
  const hasGuess = !!(answer && answer.guess);
  for (const r of DRAW_RULES) {
    if (r.state !== st) continue;
    if (r.how != null && r.how !== answer.how) continue;
    if (r.guess != null && r.guess !== hasGuess) continue;
    return r;
  }
  return null;
}

// ── configuration (injectable for tests) ───────────────────────────────────
const cfg = {
  rectOf: (x) => defaultRectOf(x),
  raf: (fn) => requestAnimationFrame(fn),
  now: () => performance.now(),
  budget_ms: DEFAULT_BUDGET_MS,
  clips: (el) => defaultClips(el),
};
function defaultRectOf(x) {
  if (!x) return null;
  if (typeof x.getClientRects === 'function' && x.nodeType === undefined) {
    // a Range: its first client rect is the anchor point's line
    const rs = x.getClientRects();
    if (rs && rs.length) return rs[0];
  }
  return typeof x.getBoundingClientRect === 'function' ? x.getBoundingClientRect() : null;
}
function defaultClips(el) {
  const w = el.ownerDocument && el.ownerDocument.defaultView;
  if (!w || typeof w.getComputedStyle !== 'function') return false;
  const cs = w.getComputedStyle(el);
  const clipping = (v) => !!v && v !== 'visible';
  return clipping(cs.overflow) || clipping(cs.overflowX) || clipping(cs.overflowY);
}

// ── state ───────────────────────────────────────────────────────────────────
const scopes = { live: { rows: new Map(), surface: null }, preview: { rows: new Map(), surface: null, node: null } };
let drawnScope = 'live';
const answers = new Map();        // id → {row, raw, state, rule, mount, scope, gen, hidden}
const watches = new Map();        // mount → {unwatch, ids, scope}
const initial = new Map();        // mount → a resolveAll handle (a set change's pass)
let initialQueued = new Set();
let initialScheduled = false;
let sourcesPending = false;
const mapCache = new Map();       // md id → {text, map}
const types = new Map();          // type → {draw, create, input, glyph, move}
const answerSubs = new Set();
const armedSubs = new Set();
let probe = null;
let policy = null;
let armedState = null;            // {type, profile} or null
let pickState = null;
const gestures = new Map();       // pointerId → {decision, pointerType, mode, up}: each pointer's gesture
let lastDown = null;              // the pointerId of the newest pointerdown
let listeningOn = null;           // the well the capture listeners are on, or null
let layer = null;
let inited = false;
let lastSig = null;
let groups = [];                  // the built groups (markers) of the drawn set
let pass = null;                  // a position pass carried across frames
let drawPending = false;
let drawAgain = false;
let lastOrphanSig = '';
const scrollRoots = new WeakSet();
const elTokens = new WeakMap();
let nextToken = 1;
const failed = new Map();         // id → {type, error} for a draw that threw

const totals = { frames: 0, longest_frame_ms: 0, box_reads: 0, box_ms: 0 };
const lastPass = { drawn: 0, clipped: 0, guesses: 0, sections: 0 };

// ── rows ────────────────────────────────────────────────────────────────────
function checkScope(scope) {
  if (!SCOPES.includes(scope)) throw new TypeError(`overlay: scope must be one of ${SCOPES.join(', ')}`);
}
function normRow(r) {
  if (!r || typeof r !== 'object' || r.id == null || r.id === '') return null;
  const row = {
    id: String(r.id),
    v: r.v == null ? null : r.v,
    type: r.type == null ? null : String(r.type),
    schema: typeof r.schema === 'string' ? r.schema : null,
    anchor: r.anchor && typeof r.anchor === 'object' ? r.anchor : null,
    shared: r.shared === undefined ? null : !!r.shared,
    replies: Number.isFinite(r.replies) ? r.replies : 0,
    pending: !!r.pending,
  };
  if (r.answered !== undefined) row.answered = !!r.answered;
  return row;
}
// Where a row resolves: a pane mount (element and range anchors, a converted
// pin), a markdown item (a source anchor), or nowhere (pending, no anchor).
function placeOf(row) {
  if (row.pending || !row.anchor) return null;
  const a = row.anchor;
  if (a.kind === 'page') return null;
  if (a.kind === 'source') return { kind: 'md', key: a.md == null ? null : String(a.md) };
  return { kind: 'pane', key: a.mount == null || a.mount === '' ? null : String(a.mount) };
}
function mountsOf(rows) {
  const out = new Set();
  for (const r of rows) {
    const p = placeOf(r);
    if (p && p.kind === 'pane' && p.key != null) out.add(p.key);
  }
  return out;
}

export function setElements(scope, rows) {
  checkScope(scope);
  const S = scopes[scope];
  const before = [...S.rows.values()];
  S.rows = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = normRow(r);
    if (row) S.rows.set(row.id, row);
  }
  changed(scope, [...before, ...S.rows.values()]);
}
export function upsertElements(scope, rows) {
  checkScope(scope);
  const S = scopes[scope];
  const touched = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = normRow(r);
    if (!row) continue;
    const old = S.rows.get(row.id);
    if (old) touched.push(old);
    S.rows.set(row.id, row);
    touched.push(row);
  }
  changed(scope, touched);
}
export function removeElements(scope, ids) {
  checkScope(scope);
  const S = scopes[scope];
  const touched = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const old = S.rows.get(String(id));
    if (!old) continue;
    S.rows.delete(old.id);
    touched.push(old);
  }
  changed(scope, touched);
}
export function elementsOf(scope) {
  checkScope(scope);
  return [...scopes[scope].rows.values()].map((r) => ({ ...r }));
}
export function surfaceOf(scope = 'live') {
  checkScope(scope);
  return scopes[scope].surface;
}
export function drawnScopeOf() { return drawnScope; }

// A set changed: the drawn set's watches, passes and answers follow.
function changed(scope, touchedRows) {
  if (scope !== drawnScope) return;
  const rows = scopes[scope].rows;
  for (const id of [...answers.keys()]) if (!rows.has(id)) { answers.delete(id); failed.delete(id); }
  for (const r of touchedRows) {
    const cur = rows.get(r.id);
    if (!cur || placeOf(cur) == null) answers.delete(r.id);
  }
  syncWatches();
  let sources = false;
  for (const r of touchedRows) {
    const p = placeOf(r);
    if (!p) continue;
    if (p.kind === 'md') sources = true;
    else if (p.key == null) noMount(r);
    else queueInitial(p.key);
  }
  if (sources) scheduleSources();
  orphansChanged();
  requestDraw();
}

// A pane row whose anchor names no mount answers orphaned, once.
function noMount(row) {
  const cur = scopes[drawnScope].rows.get(row.id);
  if (!cur) return;
  const raw = { state: ORPHANED, el: null, i: -1, how: 'no-mount' };
  deliver(drawnScope, null, [cur.id], [raw], { records: 1, gen: null, absent: true });
}

// ── watching ────────────────────────────────────────────────────────────────
function rowsOfMount(scope, mount) {
  const out = [];
  for (const r of scopes[scope].rows.values()) {
    const p = placeOf(r);
    if (p && p.kind === 'pane' && p.key === mount) out.push(r);
  }
  return out;
}
function syncWatches() {
  const want = mountsOf(scopes[drawnScope].rows.values());
  for (const [m, w] of [...watches]) {
    if (want.has(m) && w.scope === drawnScope) continue;
    w.unwatch();
    watches.delete(m);
    const h = initial.get(m);
    if (h) { h.cancel(); initial.delete(m); }
  }
  for (const m of want) {
    if (watches.has(m)) continue;
    const w = { scope: drawnScope, ids: [], unwatch: null };
    w.unwatch = anchors.watch(m, {
      records: () => {
        const list = rowsOfMount(w.scope, m);
        w.ids = list.map((r) => r.id);
        return list.map((r) => r.anchor);
      },
      onAnswers: (ans, report) => deliver(w.scope, m, w.ids, ans, report),
    });
    watches.set(m, w);
  }
}
function unwatchAll() {
  for (const w of watches.values()) w.unwatch();
  watches.clear();
  for (const h of initial.values()) h.cancel();
  initial.clear();
  initialQueued = new Set();
}

function paneRoot(mount) {
  const M = window.__wcMount;
  const it = M && typeof M.itemEl === 'function' ? M.itemEl(document, mount) : null;
  return it && it.kind === 'pane' && it.el && it.el.shadowRoot ? it.el.shadowRoot : null;
}
// A set change's passes, one per touched mount, started together on a
// microtask so a burst of changes starts each mount's pass once.
function queueInitial(mount) {
  initialQueued.add(mount);
  if (initialScheduled) return;
  initialScheduled = true;
  Promise.resolve().then(runInitial);
}
function runInitial() {
  initialScheduled = false;
  const list = [...initialQueued];
  initialQueued = new Set();
  for (const m of list) {
    if (!watches.has(m)) continue;
    const scope = drawnScope;
    const rows = rowsOfMount(scope, m);
    if (!rows.length) continue;
    const ids = rows.map((r) => r.id);
    const prev = initial.get(m);
    if (prev) prev.cancel();
    initial.delete(m);
    const root = paneRoot(m);
    if (!root) {
      deliver(scope, m, ids, rows.map(() => ({ state: ORPHANED, el: null, i: -1, how: 'mount-absent' })),
        { records: rows.length, gen: null, absent: true });
      continue;
    }
    const handle = anchors.resolveAll(root, rows.map((r) => r.anchor), {}, (ans, report) => {
      if (initial.get(m) === handle) initial.delete(m);
      deliver(scope, m, ids, ans, report);
    });
    initial.set(m, handle);
  }
}

// ── sources (markdown items) ────────────────────────────────────────────────
function scheduleSources() {
  if (sourcesPending) return;
  sourcesPending = true;
  cfg.raf(resolveSources);
}
function mapOf(md, text) {
  const c = mapCache.get(md);
  if (c && c.text === text) return c.map;
  const map = sourceMap(text);
  mapCache.set(md, { text, map });
  return map;
}
function resolveSources() {
  sourcesPending = false;
  const scope = drawnScope;
  const byMd = new Map();
  for (const r of scopes[scope].rows.values()) {
    const p = placeOf(r);
    if (!p || p.kind !== 'md') continue;
    if (!byMd.has(p.key)) byMd.set(p.key, []);
    byMd.get(p.key).push(r);
  }
  const M = window.__wcMount;
  for (const [md, rows] of byMd) {
    const it = md != null && M && typeof M.itemEl === 'function' ? M.itemEl(document, md) : null;
    const item = page.markdown && md != null ? page.markdown.get(md) : null;
    const ids = rows.map((r) => r.id);
    let ans;
    if (it && it.kind === 'md' && item) {
      const text = String(item.text == null ? '' : item.text);
      const map = mapOf(md, text);
      ans = rows.map((r) => anchors.resolveSource(it.el, text, map, r.anchor));
    } else {
      ans = rows.map(() => ({ state: ORPHANED, range: null, start: null, end: null, how: 'item-absent', occ: 0 }));
    }
    deliver(scope, md, ids, ans, { records: rows.length, gen: null, source: true });
  }
}

// ── answers ─────────────────────────────────────────────────────────────────
function probed(row, raw, mount, scope) {
  if (!probe) return null;
  try {
    const reason = probe({ row: { ...row }, answer: raw, mount, scope });
    return reason == null || reason === false ? null : reason;
  } catch (e) {
    console.error('[web-chat] overlay: the hidden probe failed', e);
    return null;
  }
}
function entryOf(row, raw, mount, scope, gen) {
  const hidden = probed(row, raw, mount, scope);
  const state = hidden ? HIDDEN : raw.state;
  return { row, raw, state, hidden, rule: drawRuleOf({ ...raw, state }), mount, scope, gen };
}
// A pass delivered (the resolver's, a set change's or the sources'): the
// answers are STORED, the probe applied, the listeners told, and a draw frame
// asked for. No box is read here (C-05-3).
function deliver(scope, mount, ids, ans, report) {
  if (scope !== drawnScope) return;
  const rows = scopes[scope].rows;
  const items = [];
  const n = Math.min(ids.length, Array.isArray(ans) ? ans.length : 0);
  for (let i = 0; i < n; i++) {
    const row = rows.get(ids[i]);
    if (!row || !ans[i]) continue;
    const e = entryOf(row, ans[i], mount, scope, report && report.gen != null ? report.gen : null);
    answers.set(row.id, e);
    failed.delete(row.id);
    const raw = e.raw;
    items.push({ id: row.id, v: row.v, type: row.type, state: e.state, how: raw.how == null ? null : raw.how,
      tie: raw.tie == null ? null : raw.tie, why: raw.why == null ? null : raw.why, el: raw.el || null });
  }
  if (items.length) {
    const msg = { mount, scope, surface: scopes[scope].surface, gen: report && report.gen != null ? report.gen : null,
      items, report: report || null };
    for (const fn of [...answerSubs]) {
      try { fn(msg); } catch (e) { console.error('[web-chat] overlay: an onAnswers listener failed', e); }
    }
  }
  orphansChanged();
  requestDraw();
}

export function onAnswers(fn) {
  if (typeof fn !== 'function') throw new TypeError('onAnswers: expects a function');
  const h = (m) => fn(m);
  answerSubs.add(h);
  return () => { answerSubs.delete(h); };
}

// The one hidden-state probe (U303's): fn({row, answer, mount, scope}) → null
// or a hidden reason. The last set wins; setting re-applies it to the answers
// held.
export function setHiddenProbe(fn) {
  if (fn != null && typeof fn !== 'function') throw new TypeError('setHiddenProbe: expects a function or null');
  const mine = fn || null;
  probe = mine;
  reprobe();
  return () => { if (probe === mine) { probe = null; reprobe(); } };
}
function reprobe() {
  for (const [id, e] of answers) answers.set(id, entryOf(e.row, e.raw, e.mount, e.scope, e.gen));
  orphansChanged();
  requestDraw();
}

// ── orphans ─────────────────────────────────────────────────────────────────
export function orphans() {
  const out = [];
  for (const e of answers.values()) {
    if (e.scope !== drawnScope || e.state !== ORPHANED || !e.rule || !e.rule.listed) continue;
    out.push({ id: e.row.id, v: e.row.v, type: e.row.type, mount: e.mount, scope: e.scope,
      how: e.raw.how == null ? null : e.raw.how, guess: !!e.raw.guess });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function orphansChanged() {
  const list = orphans();
  const sig = drawnScope + '|' + list.map((o) => `${o.id}@${o.v}:${o.how}:${o.guess ? 1 : 0}`).join(',');
  if (sig === lastOrphanSig) return;
  lastOrphanSig = sig;
  bus.emit('overlay:orphans', { scope: drawnScope, orphans: list });
}

// ── the drawn scope ─────────────────────────────────────────────────────────
function syncScope() {
  const want = view.previewing ? 'preview' : 'live';
  if (want === drawnScope) return;
  drawnScope = want;
  unwatchAll();
  answers.clear();
  failed.clear();
  if (want === 'live') { scopes.preview.rows = new Map(); scopes.preview.node = null; }
  const rows = [...scopes[want].rows.values()];
  changed(want, rows);
}
function takeLive(msg) {
  scopes.live.surface = msg && msg.surface != null ? msg.surface : null;
  setElements('live', msg && Array.isArray(msg.elements) ? msg.elements : []);
  scheduleSources();
}
// A previewed node's rows: its lean comment rows, and its id@v references held
// pending. The split at the last '@' is U353's parsePin rule (element-log is
// node-only, so the chrome cannot import it).
function refRow(ref) {
  const s = String(ref);
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const v = Number(s.slice(at + 1));
  return { id: s.slice(0, at), v: Number.isSafeInteger(v) && v > 0 ? v : null, pending: true };
}
function takePreview(d) {
  const node = d && d.node;
  const rows = [];
  for (const r of Array.isArray(node && node.lean_elements) ? node.lean_elements : []) rows.push(r);
  const have = new Set(rows.map((r) => r && r.id != null && String(r.id)));
  for (const ref of Array.isArray(node && node.elements) ? node.elements : []) {
    const r = refRow(ref);
    if (r && !have.has(r.id)) rows.push(r);
  }
  scopes.preview.node = d && d.id != null ? d.id : null;
  setElements('preview', rows);
  syncScope();
}

// ── the draw ────────────────────────────────────────────────────────────────
function tokenOf(el) {
  let t = elTokens.get(el);
  if (!t) { t = nextToken++; elTokens.set(el, t); }
  return t;
}
function rangeKey(range) {
  return `r${tokenOf(range.startContainer)}:${range.startOffset}-${tokenOf(range.endContainer)}:${range.endOffset}`;
}
// The signature unchanged, the built groups (and their markers) stay; each
// takes the fresh pass's DOM objects and items, so a placement and a type's
// move read the current Range and answers, never a stale pass's.
function refreshKept(gs) {
  for (let i = 0; i < gs.length; i++) {
    const g = groups[i];
    const f = gs[i];
    if (!g || g.key !== f.key) continue;
    g.el = f.el;
    g.range = f.range;
    g.items = f.items;
    g.mount = f.mount;
  }
}
function glyphOf(type) {
  const t = types.get(type);
  const g = t && t.glyph;
  return g || MARKER_GLYPH;
}
// The drawn set as marker groups: per type, the elements grouped by the DOM
// element they resolve to (a range or a section, one group each). No box read.
function buildGroups() {
  const byKey = new Map();
  const M = window.__wcMount;
  for (const e of answers.values()) {
    if (e.scope !== drawnScope || !e.rule || e.rule.draw === 'none' || e.row.pending) continue;
    const kind = e.rule.draw;
    const raw = e.raw;
    let el = null;
    let range = null;
    if (kind === 'guess') el = raw.guess;
    else if (raw.range) range = raw.range;
    else if (raw.el) el = raw.el;
    else if (kind === 'section' && e.mount != null && M && typeof M.itemEl === 'function') {
      const it = M.itemEl(document, e.mount);
      el = it ? it.el : null;
    }
    if (!el && !range) continue;
    const type = e.row.type || 'element';
    // Keyed by the DOM position it answers: an element by its identity, a
    // range by its boundary points (each container's identity and offset),
    // never by the Range object — the resolver builds a fresh Range every
    // pass, and a key on it would rebuild every marker in the layer on a pass
    // that moved nothing (F11). A re-render that replaced the text keeps no
    // container, so its key changes and the group is rebuilt over the new
    // Range; a kept group takes the pass's current Range (refreshKept).
    const key = el ? `${type}|${kind}|e${tokenOf(el)}` : `${type}|${kind}|${rangeKey(range)}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, type, kind, cls: e.rule.cls, el, range, mount: e.mount, scope: e.scope, items: [],
        container: null, glyph: glyphOf(type), failed: false };
      byKey.set(key, g);
    }
    g.items.push({ id: e.row.id, v: e.row.v, type, row: e.row, state: e.state, how: raw.how == null ? null : raw.how,
      answer: raw });
  }
  const out = [...byKey.values()];
  for (const g of out) g.items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}
function sigOf(gs) {
  return drawnScope + '#' + gs.map((g) => g.key + ':' + g.items.map((it) => {
    const r = it.row;
    return `${it.id}@${it.v}:${it.state}:${r.shared ? 1 : 0}${r.answered ? 1 : 0}:${r.replies}`;
  }).join(',')).join('|');
}
function drawCtx(g) {
  return {
    layer, scope: g.scope, glyph: g.glyph, previewing: view.previewing,
    rectOf: (x) => cfg.rectOf(x),
    rectsOf: (range) => (range && typeof range.getClientRects === 'function' ? [...range.getClientRects()] : []),
  };
}
function rebuild(gs) {
  for (const m of [...layer.querySelectorAll('.el-marker')]) m.remove();
  for (const g of gs) {
    const c = document.createElement('div');
    c.className = `el-marker ${g.cls}`;
    c.dataset.type = g.type;
    c.dataset.elIds = g.items.map((it) => it.id).join(' ');
    const gl = g.glyph;
    c.style.width = gl.w + 'px';
    c.style.height = gl.h + 'px';
    c.style.transform = `translate(${gl.dx}px, ${gl.dy}px)`;
    c.style.display = 'none';
    c._group = g;
    g.container = c;
    layer.appendChild(c);
    const t = types.get(g.type);
    try {
      if (t) t.draw(g, drawCtx(g));
      else {
        c.classList.add('el-generic');
        c.title = g.type;
        const s = document.createElement('span');
        s.className = 'el-generic-name';
        s.textContent = g.type;
        c.appendChild(s);
      }
    } catch (err) {
      console.error(`[web-chat] overlay: the '${g.type}' draw failed`, err);
      c.remove();
      g.container = null;
      g.failed = true;
      for (const it of g.items) failed.set(it.id, { type: g.type, error: String((err && err.message) || err) });
    }
  }
}

export function requestDraw() {
  if (!layer) return;
  if (pass) { drawAgain = true; return; }
  if (drawPending) return;
  drawPending = true;
  cfg.raf(drawFrame);
}

function intersect(a, b) {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}
function boxOf(r) {
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
}
// One frame's reads: every box read goes through here and is counted.
function reader(fr) {
  return (x) => {
    fr.reads++;
    return cfg.rectOf(x);
  };
}
// The client box of a clipping element (its border box less borders and
// scrollbars, when the browser reports them), or null when it clips nothing.
function clipBoxOf(el, fr, read) {
  if (fr.clipCache.has(el)) return fr.clipCache.get(el);
  let box = null;
  const isWell = el === fr.well;
  if (isWell || cfg.clips(el)) {
    const r = read(el);
    if (r) {
      box = boxOf(r);
      if (el.clientWidth > 0 || el.clientHeight > 0) {
        const l = r.left + (el.clientLeft || 0);
        const t = r.top + (el.clientTop || 0);
        box = { left: l, top: t, right: l + el.clientWidth, bottom: t + el.clientHeight };
      }
    }
  }
  fr.clipCache.set(el, box);
  return box;
}
// The clip of an anchor: the viewport ∩ the well ∩ every overflow-clipping
// ancestor from `start` up through each shadow host to the document.
function clipFrom(start, fr, read) {
  if (fr.startCache.has(start)) return fr.startCache.get(start);
  let clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  if (fr.well) {
    const w = clipBoxOf(fr.well, fr, read);
    if (w) clip = intersect(clip, w);
  }
  const de = document.documentElement;
  for (let n = start; n && n !== de && n.nodeType !== 9;) {
    if (n.nodeType === 11) { n = n.host || null; continue; }
    if (n.nodeType === 1 && n !== fr.well && n !== document.body) {
      const b = clipBoxOf(n, fr, read);
      if (b) clip = intersect(clip, b);
    }
    n = n.parentNode;
  }
  fr.startCache.set(start, clip);
  return clip;
}
function hide(g) {
  if (g.container) g.container.style.display = 'none';
}
// Measure one group — READS ONLY: its anchor's box and its clip, and the
// glyph's inset against that clip. Returns {res: 'drawn' | 'clipped' |
// 'unplaced', x, y, clip, inset}; nothing is written until the frame's whole
// slice is measured (applyGroup), so reads and writes never interleave.
function measureGroup(g, fr, read) {
  if (!g.container) return { res: 'unplaced' };
  let startEl;
  if (g.range) {
    const sc = g.range.startContainer;
    if (!sc || !sc.isConnected) return { res: 'unplaced' };
    startEl = sc.nodeType === 1 ? sc : sc.parentNode;
  } else {
    if (!g.el || !g.el.isConnected) return { res: 'unplaced' };
    startEl = g.el.parentNode;
  }
  const rootNode = startEl && startEl.getRootNode ? startEl.getRootNode() : null;
  if (rootNode && rootNode.nodeType === 11 && !scrollRoots.has(rootNode)) {
    scrollRoots.add(rootNode);
    rootNode.addEventListener('scroll', requestDraw, { capture: true, passive: true });
  }
  const r = read(g.range || g.el);
  if (!r || (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0)) return { res: 'unplaced' };
  const x = r.left;
  const y = r.top;
  const clip = clipFrom(startEl, fr, read);
  if (!(x >= clip.left && x < clip.right && y >= clip.top && y < clip.bottom)) return { res: 'clipped' };
  const gl = g.glyph;
  const gx = x + gl.dx;
  const gy = y + gl.dy;
  const top = Math.max(0, clip.top - gy);
  const left = Math.max(0, clip.left - gx);
  const right = Math.max(0, gx + gl.w - clip.right);
  const bottom = Math.max(0, gy + gl.h - clip.bottom);
  if (top + bottom >= gl.h || left + right >= gl.w) return { res: 'clipped' };
  return { res: 'drawn', x, y, clip, inset: [top, right, bottom, left] };
}
// Write one measured group: left/top and the glyph's clip-path, or hidden;
// then the type's move, if any. Runs only after the slice's reads.
function applyGroup(g, m) {
  const c = g.container;
  if (!c) return;
  if (m.res !== 'drawn') { hide(g); return; }
  const [top, right, bottom, left] = m.inset;
  c.style.left = m.x + 'px';
  c.style.top = m.y + 'px';
  c.style.clipPath = top || right || bottom || left ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : '';
  c.style.display = '';
  const t = types.get(g.type);
  if (t && t.move) {
    try { t.move(g, { ...drawCtx(g), x: m.x, y: m.y, clip: m.clip }); } catch (err) {
      console.error(`[web-chat] overlay: the '${g.type}' move failed`, err);
    }
  }
}

function drawFrame() {
  drawPending = false;
  if (!layer) return;
  const now = cfg.now;
  const t0 = now();
  if (!pass) {
    drawAgain = false;
    const gs = buildGroups();
    const sig = sigOf(gs);
    if (sig !== lastSig) {
      lastSig = sig;
      groups = gs;
      rebuild(gs);
    } else refreshKept(gs);
    pass = { i: 0, drawn: 0, clipped: 0, guesses: 0, sections: 0 };
  }
  const fr = { reads: 0, clipCache: new Map(), startCache: new Map(), well: $('main') };
  const read = reader(fr);
  const budget = cfg.budget_ms;
  // The read phase: measure groups while this frame's own look-ahead fits the
  // budget. The look-ahead is the costliest group of THIS frame after its first
  // (the first pays the clip reads and any layout flush; alone, it is its own
  // estimate) — nothing carries across frames, so one slow read throttles only
  // the frame it lands in.
  const slice = [];
  let firstMs = 0;
  let restMax = 0;
  while (pass.i < groups.length) {
    const n = slice.length;
    if (n > 0 && now() - t0 + (n === 1 ? firstMs : restMax) > budget) break;
    const g = groups[pass.i];
    const s = now();
    const m = g.failed ? { res: 'unplaced' } : measureGroup(g, fr, read);
    const d = now() - s;
    if (n === 0) firstMs = d;
    else if (d > restMax) restMax = d;
    slice.push([g, m]);
    pass.i++;
  }
  // The write phase: every marker style of the slice, after all its reads.
  for (const [g, m] of slice) {
    if (!g.failed) applyGroup(g, m);
    if (m.res === 'drawn') {
      pass.drawn++;
      if (g.kind === 'guess') pass.guesses++;
      if (g.kind === 'section') pass.sections++;
    } else if (m.res === 'clipped') pass.clipped++;
  }
  const placed = slice.length;
  const ms = now() - t0;
  const done = pass.i >= groups.length;
  totals.frames++;
  totals.box_reads += fr.reads;
  totals.box_ms += ms;
  if (ms > totals.longest_frame_ms) totals.longest_frame_ms = ms;
  const carried = groups.length - pass.i;
  if (done) {
    lastPass.drawn = pass.drawn;
    lastPass.clipped = pass.clipped;
    lastPass.guesses = pass.guesses;
    lastPass.sections = pass.sections;
    pass = null;
  }
  bus.emit('overlay:frame', { frame: totals.frames, ms, box_reads: fr.reads, groups: placed, carried, done,
    anchors: answers.size, budget_ms: budget });
  if (!done) { drawPending = true; cfg.raf(drawFrame); return; }
  if (drawAgain) { drawAgain = false; requestDraw(); }
}

export function stats() {
  return {
    frames: totals.frames,
    longest_frame_ms: totals.longest_frame_ms,
    box_reads: totals.box_reads,
    box_ms: totals.box_ms,
    drawn: lastPass.drawn,
    clipped: lastPass.clipped,
    guesses: lastPass.guesses,
    sections: lastPass.sections,
    orphans: orphans().length,
    anchors: answers.size,
    draw_failed: failed.size,
    listening: !!listeningOn,
  };
}
// The elements whose type's draw threw (recorded, never drawn).
export function failedDraws() {
  return [...failed].map(([id, f]) => ({ id, ...f }));
}

// ── types ───────────────────────────────────────────────────────────────────
// registerType(type, {draw(group, ctx), create?(input, ctx), input?, glyph?,
// move?(group, ctx)}) → unregister. draw fills the group's container (a marker
// the overlay positions and clips) for the type's elements resolved to one DOM
// element; move, when given, runs after each placement; create takes the
// armed tool's input. An element whose type has none draws a generic marker.
export function registerType(type, spec) {
  if (typeof type !== 'string' || !type) throw new TypeError('registerType: a type name is required');
  if (!spec || typeof spec.draw !== 'function') throw new TypeError('registerType: {draw(group, ctx)} is required');
  if (spec.create != null && typeof spec.create !== 'function') throw new TypeError('registerType: create must be a function');
  if (spec.move != null && typeof spec.move !== 'function') throw new TypeError('registerType: move must be a function');
  if (spec.input != null && !INPUT_KINDS.includes(spec.input)) {
    throw new TypeError(`registerType: input must be one of ${INPUT_KINDS.join(', ')}`);
  }
  let glyph = null;
  if (spec.glyph != null) {
    const g = spec.glyph;
    if (!['dx', 'dy', 'w', 'h'].every((k) => Number.isFinite(g[k])) || g.w <= 0 || g.h <= 0) {
      throw new TypeError('registerType: glyph is {dx, dy, w, h} in px');
    }
    glyph = Object.freeze({ dx: g.dx, dy: g.dy, w: g.w, h: g.h });
  }
  const entry = { draw: spec.draw, create: spec.create || null, move: spec.move || null, input: spec.input || null, glyph };
  types.set(type, entry);
  lastSig = null;
  requestDraw();
  return () => {
    if (types.get(type) !== entry) return;
    types.delete(type);
    lastSig = null;
    requestDraw();
  };
}
export function inputKindOf(type) {
  const t = types.get(type);
  return (t && t.input) || null;
}

// ── the armed tool: THE one armed-tool state of the chrome (K.2-3, K.2-14) ──
export function setArmed(type, profile) {
  const next = type == null ? null : { type: String(type), profile: profile == null ? null : String(profile) };
  const cur = armedState;
  if ((next === null && cur === null) || (next && cur && next.type === cur.type && next.profile === cur.profile)) return;
  armedState = next;
  dropGestures();
  syncListening();
  const snap = armed();
  for (const fn of [...armedSubs]) {
    try { fn(snap); } catch (e) { console.error('[web-chat] overlay: an onArmedChange listener failed', e); }
  }
}
export function armed() { return armedState ? { ...armedState } : null; }
export function onArmedChange(fn) {
  if (typeof fn !== 'function') throw new TypeError('onArmedChange: expects a function');
  const h = (v) => fn(v);
  armedSubs.add(h);
  return () => { armedSubs.delete(h); };
}

// THE one pointer dispatch (fn(event, {armed}) → 'tool' | 'page' | 'ignore'),
// consulted while a tool is armed at each pointer's pointerdown, at a lone
// click (no live gesture of its own: a keyboard's or a script's click), and
// once more at the click of a gesture it gave to the tool — with a stand-in
// carrying that gesture's pointerType — because only where the gesture ended
// can it tell a tap from a pan (a finger that travelled past the slop): an
// answer other than 'tool' there makes that click nobody's. 'tool' hands the
// gesture to the armed type's create; 'page' lets every event of it reach the
// page untouched with the tool still armed (K.2-9); 'ignore' swallows it
// (neither the tool nor the page gets it). The last set wins.
export function setPointerPolicy(fn) {
  if (fn != null && typeof fn !== 'function') throw new TypeError('setPointerPolicy: expects a function or null');
  const mine = fn || null;
  policy = mine;
  return () => { if (policy === mine) policy = null; };
}

const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'];
// The capture listeners sit on the well only while a tool is armed or a pick
// is pending.
function syncListening() {
  const want = !!(armedState || pickState);
  if (want && !listeningOn) {
    const well = $('main');
    if (!well) return;
    for (const t of POINTER_EVENTS) well.addEventListener(t, onPointer, true);
    listeningOn = well;
  } else if (!want && listeningOn) {
    for (const t of POINTER_EVENTS) listeningOn.removeEventListener(t, onPointer, true);
    listeningOn = null;
    dropGestures();
  }
}
function dropGestures() {
  gestures.clear();
  lastDown = null;
}
function innerTarget(e) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const n of path) if (n && n.nodeType === 1) return n;
  return e.target && e.target.nodeType === 1 ? e.target : null;
}
function whereOf(target) {
  const out = { root: document, mount: null, md: null };
  if (!target) return out;
  const root = target.getRootNode ? target.getRootNode() : document;
  if (root && root.nodeType === 11 && root.host) {
    out.root = root;
    const h = root.host;
    out.mount = (h.dataset && h.dataset.mountId) || h.id || null;
  } else {
    const b = target.closest ? target.closest('[data-md-id]') : null;
    if (b) out.md = b.getAttribute('data-md-id');
  }
  return out;
}
function swallow(e, prevent) {
  e.stopPropagation();
  if (prevent && e.cancelable) e.preventDefault();
}
function toolCtx() {
  return { anchors, sourceMap, markdownText, scope: 'live', armed: armed() };
}
function markdownText(md) {
  const m = page.markdown && md != null ? page.markdown.get(String(md)) : null;
  return m ? String(m.text == null ? '' : m.text) : null;
}
// Each pointer's gesture is its own (a palm landing during a pen stroke never
// re-decides the pen's): decided at its pointerdown, read by its pointermove,
// pointerup and pointercancel, dropped at its pointercancel, at its click, at
// the next pointerdown of its id, at a move of its pointer with no button down
// while the well has not heard it up (it was released outside #main), and —
// once it is up — at any later pointerdown (a click follows its pointerup in
// the same task, or never). A click that names a pointer takes that pointer's
// gesture alone; one that names none takes the newest pointerdown's only once
// that pointer is up, its click unspent and a pointer pressed it (detail >= 1).
// With neither it is a lone click (a keyboard's Enter, pointerId -1; a script's
// el.click(); or the click a pan's gesture never got), and the policy is asked
// about it afresh.
function askPolicy(e) {
  let decision = 'tool';
  if (policy) {
    try { decision = policy(e, { armed: armed() }); } catch (err) {
      console.error('[web-chat] overlay: the pointer policy failed', err);
      decision = 'page';
    }
  }
  return POINTER_ANSWERS.includes(decision) ? decision : 'page';
}
function gestureOfClick(e) {
  // A click that names a pointer takes that pointer's gesture or none: never the
  // newest pointerdown's, which may be another pointer's (a mouse released
  // outside the well leaves its entry not up; a pen may still be down). A
  // keyboard's click names -1, a lone one by any reading.
  if (typeof e.pointerId === 'number') return gestures.has(e.pointerId) ? [e.pointerId, gestures.get(e.pointerId)] : null;
  // A click that names no pointer (a browser whose click is a MouseEvent): the
  // newest pointerdown's only once the well heard it up, with its own click
  // unspent, and only when a pointer pressed the click (detail >= 1; any later
  // pointerdown would have dropped this gesture). A press still not up is no
  // click's: its pointer was released where the well could not hear it (U302b).
  const g = lastDown == null ? null : gestures.get(lastDown);
  return g && g.up && e.detail >= 1 ? [lastDown, g] : null;
}
// The click of a gesture the tool took, judged again where it ended: the
// stand-in names the gesture's pointer (a click event may carry none) and not
// the click's type, so the policy reads it as that pointer at its release.
function clickStillTool(e, g) {
  const stand = {
    pointerId: e.pointerId, pointerType: g.pointerType, target: e.target,
    composedPath: () => (typeof e.composedPath === 'function' ? e.composedPath() : []),
    clientX: e.clientX, clientY: e.clientY,
  };
  return askPolicy(stand) === 'tool';
}
function onPointer(e) {
  if (view.previewing) return;   // D2: a preview creates and picks nothing
  if (pickState) { onPick(e); return; }
  if (!armedState) return;
  const t = types.get(armedState.type);
  const kind = (t && t.input) || 'taps';
  let decision;
  let g = null;
  if (e.type === 'pointerdown') {
    for (const [id, old] of gestures) if (old.up || id === e.pointerId) gestures.delete(id);
    decision = askPolicy(e);
    g = { decision, pointerType: e.pointerType || '', mode: decision === 'tool' ? dispatchMode(e, kind) : null, up: false };
    gestures.set(e.pointerId, g);
    lastDown = e.pointerId;
  } else if (e.type === 'click') {
    const own = gestureOfClick(e);
    if (own) {
      gestures.delete(own[0]);   // its click is spent
      g = own[1];
      decision = g.decision === 'tool' && !clickStillTool(e, g) ? 'ignore' : g.decision;
    } else {
      decision = askPolicy(e);   // a lone click
    }
  } else {
    g = gestures.get(e.pointerId);
    if (!g) return;   // a hover, or the tail of a gesture that began before the arming
    // A move with no button down on a press the well never heard end (released
    // outside #main): the press is over, so its gesture goes and this move, a
    // hover, is the page's (U302b).
    if (e.type === 'pointermove' && e.buttons === 0 && !g.up) { gestures.delete(e.pointerId); return; }
    // A move after this entry's own pointerup is a hover: it passes through and
    // the entry stays for its click (a browser that sends no click when the
    // down and up targets differ would otherwise swallow it; K.2-51).
    if (e.type === 'pointermove' && g.up) return;
    decision = g.decision;
    if (e.type === 'pointerup') g.up = true;
    else if (e.type === 'pointercancel') gestures.delete(e.pointerId);
  }
  if (decision === 'page') return;
  if (decision === 'ignore') { swallow(e, e.type !== 'pointermove'); return; }
  // 'tool': the page never hears it. The tool takes the click (its default —
  // a link's, a button's — never runs); a pointer event's default is cancelled
  // and the pointer captured as the policy's dispatchMode answers for this
  // pointer (a drawing pointer's default only: a pen's, a mouse's as the pen's).
  const mode = (g && g.mode) || dispatchMode(e, kind);
  swallow(e, e.type === 'click' || mode.cancelDefault);
  const target = innerTarget(e);
  if (e.type === 'pointerdown' && mode.capture) capture(target, e.pointerId);
  if (!t || !t.create) return;
  if (kind === 'taps' && e.type !== 'click') return;
  const where = whereOf(target);
  const input = { event: e, phase: e.type, kind, target, root: where.root, mount: where.mount, md: where.md,
    clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType || 'mouse',
    profile: armedState.profile };
  try { t.create(input, toolCtx()); } catch (err) {
    console.error(`[web-chat] overlay: the '${armedState.type}' create failed`, err);
  }
}
function capture(el, pointerId) {
  const at = el && typeof el.setPointerCapture === 'function' ? el : listeningOn;
  if (!at || typeof at.setPointerCapture !== 'function') return;
  try { at.setPointerCapture(pointerId); } catch { /* the pointer is gone (no active pointer with that id) */ }
}

// pick({kind}) → {promise, cancel}: the next qualifying press records an anchor
// of that kind through the resolver (record, recordRange, recordSource) and
// resolves with {kind, record, mount}; cancel (or a newer pick) resolves null.
// The caller registers cancel with the popover registry. While previewing it
// resolves null at once.
export function pick({ kind } = {}) {
  if (!PICK_KINDS.includes(kind)) throw new TypeError(`pick: kind must be one of ${PICK_KINDS.join(', ')}`);
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  if (pickState) pickState.finish(null);
  if (view.previewing) {
    resolveFn(null);
    return { promise, cancel() {} };
  }
  const st = {
    kind,
    finish(v) {
      if (pickState === st) { pickState = null; syncListening(); }
      resolveFn(v);
    },
  };
  pickState = st;
  syncListening();
  return { promise, cancel: () => st.finish(null) };
}
function selectionRange(root) {
  const sel = (root && root.getSelection ? root.getSelection() : null) || (document.getSelection && document.getSelection());
  return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
}
function onPick(e) {
  const st = pickState;
  const fires = st.kind === 'element' ? e.type === 'click' : (e.type === 'pointerup' || e.type === 'click');
  if (!fires) return;
  const target = innerTarget(e);
  const where = whereOf(target);
  let rec = null;
  if (st.kind === 'element') {
    if (where.mount != null) rec = anchors.record(where.root, target, { mount: where.mount });
  } else if (st.kind === 'range') {
    const range = where.mount != null ? selectionRange(where.root) : null;
    if (range) rec = anchors.recordRange(where.root, range, { mount: where.mount });
  } else {
    const text = markdownText(where.md);
    const block = target && target.closest ? target.closest('[data-md-id]') : null;
    const range = block && text != null ? selectionRange(document) : null;
    if (range) rec = anchors.recordSource(block, range, mapOf(where.md, text), text, { md: where.md });
  }
  if (!rec) return;
  swallow(e, true);
  st.finish({ kind: st.kind, record: rec, mount: st.kind === 'source' ? where.md : where.mount });
}

// ── init ────────────────────────────────────────────────────────────────────
// initOverlay(opts?) creates the layer once and wires its inputs; every call
// may set the injectables: {rectOf, raf, now, budget_ms, clips}.
export function initOverlay(opts = {}) {
  for (const k of ['rectOf', 'raf', 'now', 'clips']) {
    if (opts[k] != null) {
      if (typeof opts[k] !== 'function') throw new TypeError(`initOverlay: ${k} must be a function`);
      cfg[k] = opts[k];
    }
  }
  if (opts.budget_ms != null) {
    if (!(opts.budget_ms >= 0)) throw new TypeError('initOverlay: budget_ms must be a number >= 0');
    cfg.budget_ms = opts.budget_ms;
  }
  if (inited) return;
  inited = true;
  layer = document.createElement('div');
  layer.id = 'el-layer';
  document.body.appendChild(layer);
  // One delegated click for every marker: a carried guess is offered to the
  // re-anchor seam.
  layer.addEventListener('click', (ev) => {
    const m = ev.target && ev.target.closest ? ev.target.closest('.el-marker') : null;
    const g = m && m._group;
    if (!g || g.kind !== 'guess') return;
    ev.stopPropagation();
    for (const it of g.items) bus.emit('overlay:guess', { id: it.id, v: it.v, type: it.type, mount: g.mount, scope: g.scope });
  });
  onHello(takeLive);
  onFrame('reset', takeLive);
  onFrame('markdown', scheduleSources);
  onFrame('markdown:remove', scheduleSources);
  bus.on('preview:node', takePreview);
  bus.on('view', syncScope);
  // Hidden versus gone, and the store / hidden-state re-resolve (U303,
  // overlay-hidden.js): settles only the mounts watched here.
  setHiddenProbe(hiddenProbe);
  installRetriggers({ watched: () => [...watches.keys()], raf: (fn) => cfg.raf(fn), resolveMount: queueInitial });
  const M = window.__wcMount;
  if (M && typeof M.onSettle === 'function') M.onSettle(() => requestDraw());
  window.addEventListener('scroll', requestDraw, { capture: true, passive: true });
  window.addEventListener('resize', requestDraw, { passive: true });
}

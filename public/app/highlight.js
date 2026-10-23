// The highlight type (annotation engine tranche 2, PLAN.md 2C.4; F3
// highlight.js; GT-07's highlight clause). A highlight is a RANGE of text the
// user selected inside one pane (a range anchor, lib/core/anchors recordRange)
// or one markdown item (a source anchor, recordSource, so it follows its
// section — U243's rule), kept in the element log as highlight@1 = {anchor,
// shared, color, note} and on the surface as an id@v reference (E-STORE a).
//
// NEVER A WRAPPING ELEMENT. Nothing here edits a pane's DOM or the page's:
// no <mark>, no <span>, no class on page content. A highlight is painted
//
//   - with the CSS Custom Highlight API where the browser has it (CSS.highlights
//     and Highlight, with constructable style sheets): ONE Highlight per colour
//     token in CSS.highlights, named wc-hl-<token> (wc-hl-<token>-guess for a
//     guess), holding the resolver's answered Ranges. A ::highlight() rule in
//     the document does not reach a range inside a shadow tree, so ONE shared
//     constructed sheet (its rules built from the token names alone, never a
//     colour string a pane supplied) is adopted into each shadow root that
//     holds a highlighted range, and into the document for a markdown item's,
//     and taken out again when the last highlight in it goes. mount-runtime.js
//     is never edited (§2.3 gives it no tranche-2 owner);
//   - otherwise (jsdom; a Safari before 17.2), by GEOMETRY: rectangles from the
//     range's getClientRects() drawn inside the highlight's marker in the
//     overlay layer (#el-layer), clipped to the overlay's own clip (the clip it
//     hands the type's move), re-measured whenever the overlay places the
//     marker again (a settle, a scroll, a resize). The rectangles are read for
//     every marker the frame placed, then written, after the overlay's own
//     frame (bus 'overlay:frame'): its reads-before-writes rule holds here too.
//
// THE MARKER. Each highlight group the overlay builds keeps its marker: a small
// handle at the range's first line (a stand-in look, tokens only — U338's
// toolbar work may restyle it). Clicking it opens the note popover (below) —
// except a section fallback's, whose click reaches the overlay's delegated one
// and so the re-anchor card (K.2-79).
//
// RE-RESOLUTION follows the overlay's draw rules: an exact answer is painted;
// a re-resolved one (a range found again by its context, its position or a
// fuzzy match; a source answer's how 'section') is painted AS A GUESS — a dashed
// underline, a named stand-in (class hl-guess); an orphan is never painted and
// is listed by the overlay's orphans() for U306's re-anchor (an orphan the
// resolver carried a guess element for is not painted either).
//
// THE RECORDS. The live rows (id, v, anchor, shared) come with the hello and
// every reset (the lean projection, overlay.js takeLive); this module reads the
// records themselves (their colour and note) with ONE GET /api/elements?type=
// highlight on each hello and reset (no poll), and the daemon's element:
// highlight frame (every live highlight's record) both refreshes them and is
// relayed to the overlay (upsertElements / removeElements). A previewed node's
// references are pending rows in the overlay until their anchors come back:
// one GET ?type=highlight&node=<stored id> per preview, handed to
// upsertElements('preview', …).
//
// THE TOOL. registerElementType('highlight', {draw, create, input:
// 'selection', glyph, move}) — the reads gate (element-types.js) runs the draw.
// The toolbar arms it (overlay setArmed; U337's tools, U338's bar): this module
// adds no button. create() reads the BROWSER-FORMED selection at the gesture's
// pointerup (K.2-48: input-mode's selection row keeps the pointerdown default,
// so a mouse or pen drag selects as it always does); a finger reaches it as a
// tap on static content (D1 b), after a long-press selection. The armed tool's
// settings — settingsOf(armed().type, armed().profile), K.2-14 — give the colour
// (a token name; gold when none) and the snap (words, the default, or blocks),
// which adjusts the selected Range, never one built from the pointer path. A
// selection that leaves the pane (or markdown item) it started in is refused
// with SPAN_HINT; one inside a focused field is the field's (K.2-9). The
// compatibility mousedown / mouseup a pen or mouse sends after a pointerdown the
// tool took is stopped at the well (never cancelled: the mousedown starts the
// selection), so a pane's control never hears a press the tool took.
//
// THE NOTE POPOVER (a stand-in look): note, "Visible to Claude" and colour,
// saved by PATCH; Delete by DELETE; read-only on a previewed node (D2). It is a
// registered popover (shell.js registerPopover): Escape and an outside press
// close it.
//
// TO CLAUDE (F3 b, K.2-10, K.2-11): this module writes no queue code. The
// daemon raises the element queue item for a shared highlight (the highlight's
// element.json declares wake) and drops it when the highlight goes or turns
// private; the rail draws it through the card registered here (its colour, its
// note, Show on page) while the engine owns the item (remove, re-send). Claude
// reads it through get_comments({type: 'highlight'}), the one read.
//
// C-15-1: nothing here treats a pane or the user as a security boundary; the
// daemon decides every write.
import * as overlay from './overlay.js';
import anchors from './anchors.js';
import { registerElementType } from './element-types.js';
import { request } from './http.js';
import { onFrame, onHello } from './ws.js';
import { settingsOf } from './toolbar-state.js';
import { registerPopover, registerQueueCard } from './shell.js';
import { showReaimNote, READONLY_HINT } from './topbar.js';
import { bus } from './bus.js';
import { view, $ } from './state.js';

export const TYPE = 'highlight';
// The colour tokens a highlight may carry (ruling F2 (a): the element.json's
// enum), each painted from var(--wc-<token>).
export const COLORS = Object.freeze(['gold', 'accent', 'green', 'rust']);
export const DEFAULT_COLOR = 'gold';
export const SNAPS = Object.freeze(['words', 'blocks']);
export const DEFAULT_SNAP = 'words';
export const NAME_PREFIX = 'wc-hl-';
export const GUESS_SUFFIX = '-guess';
// The marker: a small handle over the range's first character.
export const HANDLE_GLYPH = Object.freeze({ dx: -4, dy: -4, w: 8, h: 8 });
export const ELEMENTS_PATH = '/api/elements';
export const SPAN_HINT = 'A highlight stays inside one pane or one markdown item: select within one.';
export const EMPTY_HINT = 'Nothing to highlight there: select some text (a shorter span if it was long).';
export const GONE_HINT = 'That highlight is not on the page now.';
// The block snap's containers, nearest first.
const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,dt,dd,figcaption,caption,summary,'
  + 'div,section,article,aside,header,footer,address,table,ul,ol,dl,figure,details,form,fieldset,main,nav';
const FIELDS = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
const WORD = /[\p{L}\p{N}_'’-]/u;
const SPACE = /\s/;

// The state vocabulary (lib/core/anchor-states, carried by the resolver's
// module), never a bare literal of a state the vocabulary may not hold.
function stateOf(name) {
  if (!anchors.STATES || anchors.STATES.indexOf(name) < 0) throw new Error(`highlight: the state vocabulary has no ${name}`);
  return name;
}
const EXACT = stateOf('exact');

export function highlightName(color, guess = false) {
  return NAME_PREFIX + colorToken(color) + (guess ? GUESS_SUFFIX : '');
}
const colorToken = (c) => (COLORS.includes(c) ? c : DEFAULT_COLOR);

// ── the records ────────────────────────────────────────────────────────────
let liveRecords = new Map();      // id → the record (live)
let previewRecords = new Map();   // id → the record (the previewed node)
let previewId = null;
let liveSeq = 0;                  // bumped by every hello, reset and frame
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function recordOf(id) {
  const scope = overlay.drawnScopeOf();
  const m = scope === 'preview' ? previewRecords : liveRecords;
  return m.get(String(id)) || null;
}
function colorOf(id) {
  const r = recordOf(id);
  return colorToken(r && r.color);
}
function rowOf(rec) {
  return {
    id: String(rec.id), v: rec.v == null ? null : rec.v, type: TYPE,
    schema: typeof rec.schema === 'string' ? rec.schema : null,
    anchor: isObj(rec.anchor) ? rec.anchor : null, shared: rec.shared !== false,
  };
}
const validRec = (r) => isObj(r) && typeof r.id === 'string' && r.id !== '' && (r.type == null || r.type === TYPE);

// The live highlights the daemon holds now (a frame, or the GET): the records
// kept, and the overlay's live rows of this type brought to match — rows that
// left removed, new or changed ones upserted, nothing touched otherwise.
function applyLive(list) {
  const recs = (Array.isArray(list) ? list : []).filter(validRec);
  liveRecords = new Map(recs.map((r) => [r.id, r]));
  const have = new Map(overlay.elementsOf('live').filter((r) => r.type === TYPE).map((r) => [r.id, r]));
  const gone = [...have.keys()].filter((id) => !liveRecords.has(id));
  const fresh = [];
  for (const rec of recs) {
    const row = rowOf(rec);
    const h = have.get(row.id);
    if (h && !h.pending && h.v === row.v && h.shared === row.shared && h.anchor) continue;
    fresh.push(row);
  }
  if (gone.length) overlay.removeElements('live', gone);
  if (fresh.length) overlay.upsertElements('live', fresh);
  overlay.requestDraw();
  refreshCards();
}
// One record the daemon answered a write with.
function applyOne(rec) {
  if (!validRec(rec)) return;
  const list = [...liveRecords.values()].filter((r) => r.id !== rec.id);
  list.push(rec);
  applyLive(list);
}
function dropOne(id) {
  applyLive([...liveRecords.values()].filter((r) => r.id !== id));
}

async function loadLive() {
  const mine = ++liveSeq;
  const r = await request('GET', `${ELEMENTS_PATH}?type=${TYPE}`);
  if (mine !== liveSeq || !r.ok || !r.body || !Array.isArray(r.body.elements)) return;
  applyLive(r.body.elements);
}
function onElementsFrame(msg) {
  liveSeq++;
  applyLive(msg && Array.isArray(msg.elements) ? msg.elements : []);
}

// A previewed node: its highlights' anchors at that node, handed to the
// overlay's preview set (the references it holds pending).
async function onPreview(d) {
  const id = d && d.id != null ? String(d.id) : null;
  previewId = id;
  previewRecords = new Map();
  if (!id) return;
  const r = await request('GET', `${ELEMENTS_PATH}?type=${TYPE}&node=${encodeURIComponent(id)}`);
  if (previewId !== id || !view.previewing || !r.ok || !r.body || !Array.isArray(r.body.elements)) return;
  const recs = r.body.elements.filter(validRec);
  previewRecords = new Map(recs.map((x) => [x.id, x]));
  if (recs.length) overlay.upsertElements('preview', recs.map(rowOf));
  overlay.requestDraw();
}

// ── painting ───────────────────────────────────────────────────────────────
// The Custom Highlight API, when the browser has all of it; null otherwise.
export function paintApi() {
  const w = window;
  const css = w.CSS;
  if (!css || !css.highlights || typeof css.highlights.set !== 'function' || typeof w.Highlight !== 'function') return null;
  if (typeof w.CSSStyleSheet !== 'function' || !w.ShadowRoot || !w.Document) return null;
  if (!('adoptedStyleSheets' in w.ShadowRoot.prototype) || !('adoptedStyleSheets' in w.Document.prototype)) return null;
  return { registry: css.highlights, Highlight: w.Highlight };
}
export function paintMode() { return paintApi() ? 'custom-highlight' : 'geometry'; }

// The ONE sheet every highlighted root adopts: a rule per token, built from
// the token names alone.
let sheet = null;
export function sheetText() {
  return COLORS.map((c) => `::highlight(${highlightName(c)}) { background-color: color-mix(in srgb, var(--wc-${c}) 38%, transparent); }\n`
    + `::highlight(${highlightName(c, true)}) { text-decoration: underline dashed var(--wc-${c}); text-decoration-thickness: 2px; }`).join('\n');
}
function sharedSheet() {
  if (sheet) return sheet;
  const s = new window.CSSStyleSheet();
  s.replaceSync(sheetText());
  sheet = s;
  return sheet;
}
export function highlightSheet() { return sheet; }
const adopted = new Set();        // the roots the sheet is adopted into
function adopt(root) {
  const s = sharedSheet();
  const cur = Array.isArray(root.adoptedStyleSheets) ? root.adoptedStyleSheets : [...(root.adoptedStyleSheets || [])];
  if (!cur.includes(s)) root.adoptedStyleSheets = [...cur, s];
  adopted.add(root);
}
function unadopt(root) {
  adopted.delete(root);
  const cur = root.adoptedStyleSheets;
  if (!cur || !sheet) return;
  const list = [...cur];
  if (list.includes(sheet)) root.adoptedStyleSheets = list.filter((x) => x !== sheet);
}

// The markers this type drew: container → true. A rebuild removes the old
// containers from the layer; the reconcile below forgets them.
const marks = new Set();
const elRanges = new WeakMap();   // a section element → its contents' Range
let lastNamed = new Map();        // name → the Ranges last registered

function rangeOfGroup(g) {
  if (g.range) return g.range;
  const el = g.el;
  if (!el || !el.isConnected) return null;
  let r = elRanges.get(el);
  if (!r) {
    r = document.createRange();
    r.selectNodeContents(el);
    elRanges.set(el, r);
  }
  return r;
}
const groupOf = (c) => (c && c._group) || null;
function isGuess(g, it) {
  return g.kind === 'section' || (it && it.state !== EXACT);
}
// What is painted now: one entry per (drawn highlight, its range).
function paints() {
  const out = [];
  for (const c of [...marks]) {
    if (!c.isConnected) { marks.delete(c); continue; }
    const g = groupOf(c);
    const ids = c._hlIds;
    if (!g || !ids || g.kind === 'guess') continue;
    const range = rangeOfGroup(g);
    if (!range || !range.startContainer || !range.startContainer.isConnected) continue;
    const root = range.startContainer.getRootNode ? range.startContainer.getRootNode() : document;
    for (const it of g.items || []) {
      if (!ids.has(String(it.id))) continue;
      out.push({ id: String(it.id), container: c, range, root, color: colorOf(it.id), guess: isGuess(g, it) });
    }
  }
  return out;
}
const sameList = (a, b) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

// After every overlay frame: the Highlight registry and the adopted sheets
// follow what is drawn, and every marker shows its highlight's colour.
function reconcile() {
  const ps = paints();
  for (const p of ps) {
    if (p.container.dataset.color !== p.color) p.container.dataset.color = p.color;
    p.container.classList.toggle('hl-guess', p.guess);
  }
  const api = paintApi();
  if (!api) { for (const root of [...adopted]) unadopt(root); return; }
  const byName = new Map();
  for (const p of ps) {
    const name = highlightName(p.color, p.guess);
    if (!byName.has(name)) byName.set(name, []);
    const list = byName.get(name);
    if (!list.includes(p.range)) list.push(p.range);
  }
  for (const c of COLORS) {
    for (const guess of [false, true]) {
      const name = highlightName(c, guess);
      const ranges = byName.get(name) || [];
      if (!ranges.length) {
        if (lastNamed.has(name)) { try { api.registry.delete(name); } catch { /* the registry's own */ } lastNamed.delete(name); }
        continue;
      }
      if (sameList(lastNamed.get(name), ranges) && api.registry.has && api.registry.has(name)) continue;
      api.registry.set(name, new api.Highlight(...ranges));
      lastNamed.set(name, ranges);
    }
  }
  const roots = new Set(ps.map((p) => p.root).filter(Boolean));
  for (const root of [...adopted]) if (!roots.has(root)) unadopt(root);
  for (const root of roots) {
    try { adopt(root); } catch (e) { console.error('[web-chat] highlight: a style sheet could not be adopted', e); }
  }
  for (const p of ps) clearRects(p.container);
}

// ── the geometry fallback ──────────────────────────────────────────────────
// The type's move records each placed marker; the overlay's frame event then
// reads every recorded marker's rectangles, then writes them.
let placed = [];
function clearRects(c) {
  for (const r of [...c.querySelectorAll(':scope > .hl-rect')]) r.remove();
}
function drawRects() {
  const list = placed;
  placed = [];
  if (!list.length || paintApi()) return;
  // Reads.
  const measured = [];
  for (const m of list) {
    const c = m.container;
    if (!c.isConnected || c.style.display === 'none') continue;
    const range = rangeOfGroup(m.group);
    const rects = range && typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
    measured.push({ ...m, rects });
  }
  // Writes.
  for (const m of measured) {
    const { container: c, x, y, clip, glyph } = m;
    const ox = x + glyph.dx;
    const oy = y + glyph.dy;
    clearRects(c);
    if (!c._hlIds || !c._hlIds.size) continue;
    for (const r of m.rects) {
      const left = Math.max(r.left, clip.left);
      const top = Math.max(r.top, clip.top);
      const right = Math.min(r.left + r.width, clip.right);
      const bottom = Math.min(r.top + r.height, clip.bottom);
      if (!(right > left && bottom > top)) continue;
      const d = document.createElement('div');
      d.className = 'hl-rect';
      d.style.left = (left - ox) + 'px';
      d.style.top = (top - oy) + 'px';
      d.style.width = (right - left) + 'px';
      d.style.height = (bottom - top) + 'px';
      c.appendChild(d);
    }
    // The marker's own clip-path covered the handle alone; the rectangles
    // reach past it, so the clip becomes the overlay's clip itself, in the
    // marker's own coordinates.
    const L = clip.left - ox;
    const T = clip.top - oy;
    const R = clip.right - ox;
    const B = clip.bottom - oy;
    c.style.clipPath = `polygon(${L}px ${T}px, ${R}px ${T}px, ${R}px ${B}px, ${L}px ${B}px)`;
  }
}

// ── the type's draw and move ───────────────────────────────────────────────
function draw(group) {
  const c = group.container;
  if (!c) return;
  c.classList.add('hl-handle');
  if (group.kind === 'guess') {
    // An orphan the resolver carried a guess for: never painted (U306 lists it).
    c.classList.add('hl-none');
    c._hlIds = null;
    return;
  }
  const items = group.items || [];
  c._hlIds = new Set(items.map((it) => String(it.id)));
  const first = items[0];
  c.dataset.color = first ? colorOf(first.id) : DEFAULT_COLOR;
  c.classList.toggle('hl-guess', items.some((it) => isGuess(group, it)));
  c.title = items.length > 1 ? `${items.length} highlights` : 'Highlight';
  c.setAttribute('role', 'button');
  if (group.kind === 'section') {
    // A section fallback (K.2-79): no note listener — the click reaches the
    // overlay's delegated one ('overlay:guess' how 'section'), and the
    // re-anchor card is the affordance; the note opens once it is re-anchored.
    // The ids that carry a note, for the card's one line saying so.
    c.setAttribute('aria-label', 'Re-anchor this highlight');
    const noted = items.filter((it) => { const r = recordOf(it.id); return !!(r && r.note); }).map((it) => String(it.id));
    if (noted.length) c.dataset.elNotes = noted.join(' ');
    else delete c.dataset.elNotes;
  } else {
    c.setAttribute('aria-label', 'Open this highlight\'s note');
    c.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openNote(c);
    });
  }
  marks.add(c);
}
function move(group, ctx) {
  if (!group.container || !group.container._hlIds) return;
  placed.push({ container: group.container, group: groupOf(group.container) || group, x: ctx.x, y: ctx.y,
    clip: ctx.clip, glyph: ctx.glyph || HANDLE_GLYPH });
}

// ── the selection ──────────────────────────────────────────────────────────
function inField(el) {
  return !!(el && el.nodeType === 1 && el.closest && el.closest(FIELDS));
}
// The browser's selection as a Range, as the root sees it: a shadow root's own
// (Chrome), its composed range (getComposedRanges), else the document's.
function selectedRange(root) {
  const doc = document;
  const sel = doc.getSelection ? doc.getSelection() : null;
  if (root && root !== doc && typeof root.getSelection === 'function') {
    const s = root.getSelection();
    if (s && s.rangeCount) return s.getRangeAt(0);
  }
  if (root && root !== doc && sel && typeof sel.getComposedRanges === 'function') {
    let rs = null;
    try { rs = sel.getComposedRanges({ shadowRoots: [root] }); } catch {
      try { rs = sel.getComposedRanges(root); } catch { rs = null; }
    }
    const sr = rs && rs[0];
    if (sr && !sr.collapsed) {
      const r = doc.createRange();
      try { r.setStart(sr.startContainer, sr.startOffset); r.setEnd(sr.endContainer, sr.endOffset); return r; } catch { /* not in this document */ }
    }
  }
  return sel && sel.rangeCount ? sel.getRangeAt(0) : null;
}
function clearSelection(root) {
  try { if (root && root !== document && typeof root.getSelection === 'function') { const s = root.getSelection(); if (s) s.removeAllRanges(); } } catch { /* nothing selected */ }
  try { const s = document.getSelection && document.getSelection(); if (s) s.removeAllRanges(); } catch { /* nothing selected */ }
}
const holds = (limit, node) => !!node && (limit === node || (typeof limit.contains === 'function' && limit.contains(node)));

// Snap a selected Range (a copy; the user's selection is never written):
// words — trimmed of edge whitespace, then widened to whole words at both ends;
// blocks — widened to the nearest block (inside `limit`) at each end.
export function snapRange(range, snap, limit) {
  const out = range.cloneRange();
  if (snap === 'blocks') {
    const blockOf = (node) => {
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const b = el && el.closest ? el.closest(BLOCKS) : null;
      return b && b !== limit && holds(limit, b) ? b : null;
    };
    const sb = blockOf(out.startContainer);
    const eb = blockOf(out.endContainer);
    if (sb) out.setStart(sb, 0); else if (limit.nodeType !== 11) out.setStart(limit, 0);
    if (eb) out.setEnd(eb, eb.childNodes.length); else if (limit.nodeType !== 11) out.setEnd(limit, limit.childNodes.length);
    return out;
  }
  const sc = out.startContainer;
  if (sc.nodeType === 3) {
    let so = out.startOffset;
    while (so < sc.data.length && SPACE.test(sc.data[so])) so++;
    while (so > 0 && WORD.test(sc.data[so - 1]) && WORD.test(sc.data[so] || ' ')) so--;
    if (sc === out.endContainer && so >= out.endOffset) return range.cloneRange();
    out.setStart(sc, so);
  }
  const ec = out.endContainer;
  if (ec.nodeType === 3) {
    let eo = out.endOffset;
    while (eo > 0 && SPACE.test(ec.data[eo - 1])) eo--;
    while (eo < ec.data.length && WORD.test(ec.data[eo]) && WORD.test(ec.data[eo - 1] || ' ')) eo++;
    if (ec === out.startContainer && eo <= out.startOffset) return range.cloneRange();
    out.setEnd(ec, eo);
  }
  return out.collapsed ? range.cloneRange() : out;
}

// The armed tool's settings (K.2-14): the colour token and the snap.
function armedSettings() {
  const a = overlay.armed();
  let s = {};
  try { s = settingsOf(a ? a.type : TYPE, a ? a.profile : undefined) || {}; } catch { s = {}; }
  return { color: colorToken(s.color), snap: SNAPS.includes(s.snap) ? s.snap : DEFAULT_SNAP };
}

// ── create ─────────────────────────────────────────────────────────────────
let gesture = null;   // the press the tool took: {pointerId, mount, md, root, target}
let compat = false;   // the tool took a press: its compatibility mouse events are the tool's
function create(input, ctx) {
  if (view.previewing) { showReaimNote(READONLY_HINT); return; }
  const e = input.event || {};
  if (input.phase === 'pointerdown') {
    if (inField(input.target)) { gesture = null; return; }   // a field keeps its own selection (K.2-9)
    gesture = { pointerId: e.pointerId, mount: input.mount, md: input.md, root: input.root, target: input.target };
    compat = true;
    return;
  }
  if (input.phase === 'pointercancel') { gesture = null; return; }
  if (input.phase !== 'pointerup') return;
  const g = gesture;
  gesture = null;
  if (!g || g.pointerId !== e.pointerId) return;
  finish(g, input, ctx).catch((err) => console.error('[web-chat] highlight: create failed', err));
}

async function finish(g, input, ctx) {
  if (inField(input.target)) return;
  const sameItem = g.mount === input.mount && g.md === input.md;
  const root = g.mount != null ? g.root : document;
  const range = selectedRange(root);
  const selected = !!(range && !range.collapsed);
  if (!sameItem || (g.mount == null && g.md == null)) {
    if (selected || !sameItem) showReaimNote(SPAN_HINT);
    return;
  }
  if (!selected) return;
  let limit;
  if (g.mount != null) limit = g.root;
  else limit = g.target && g.target.closest ? g.target.closest('[data-md-id]') : null;
  if (!limit || !holds(limit, range.startContainer) || !holds(limit, range.endContainer)) { showReaimNote(SPAN_HINT); return; }
  const settings = armedSettings();
  const r = snapRange(range, settings.snap, limit);
  const A = (ctx && ctx.anchors) || anchors;
  let anchor = null;
  if (g.mount != null) {
    anchor = A.recordRange(limit, r, { mount: g.mount });
  } else {
    const text = ctx && typeof ctx.markdownText === 'function' ? ctx.markdownText(g.md) : null;
    if (text != null && ctx && typeof ctx.sourceMap === 'function') anchor = A.recordSource(limit, r, ctx.sourceMap(text), text, { md: g.md });
  }
  if (!anchor) { showReaimNote(EMPTY_HINT); return; }
  const body = { type: TYPE, anchor, payload: { shared: true, color: settings.color, note: '' } };
  const res = await request('POST', ELEMENTS_PATH, { body, device: true });
  if (!res.ok) { showReaimNote(res.hint); return; }
  clearSelection(root);
  if (res.body && res.body.element) applyOne(res.body.element);
}

// The compatibility mouse events of a press the tool took (a pen's, a mouse's,
// a finger's tap): stopped at the well so a pane's control never hears them;
// never cancelled — the mousedown starts the browser's selection the tool reads.
function onCompatMouse(e) {
  if (!compat) return;
  const a = overlay.armed();
  if (!a || a.type !== TYPE || view.previewing) { compat = false; return; }
  const well = $('main');
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (!well || !path.includes(well)) return;
  if (inField(path.find((n) => n && n.nodeType === 1))) return;
  e.stopPropagation();
  if (e.type === 'mouseup') compat = false;
}
// Every new press starts clean: the tool's create sets it again for its own.
function onAnyPointerDown() { compat = false; }

// ── the note popover (a stand-in look) ─────────────────────────────────────
let pop = null;
let popOff = null;
function closeNote() {
  if (popOff) { popOff(); popOff = null; }
  if (pop) { pop.remove(); pop = null; }
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function swatch(color) {
  const s = el('span', 'hl-swatch');
  s.dataset.color = colorToken(color);
  s.setAttribute('aria-hidden', 'true');
  return s;
}
export function openNote(container) {
  closeNote();
  const ids = container && container._hlIds ? [...container._hlIds] : [];
  const id = ids[0];
  if (!id) return null;
  const rec = recordOf(id) || { id, color: DEFAULT_COLOR, note: '', shared: true };
  const readOnly = !!view.previewing;
  const p = el('div', 'popover hl-pop');
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', 'Highlight');
  p.dataset.id = id;
  const head = el('div', 'hl-pop-head');
  head.append(swatch(rec.color), el('span', 'hl-pop-title', 'Highlight'));
  p.appendChild(head);
  if (readOnly) {
    p.appendChild(el('p', 'hl-pop-note', rec.note ? String(rec.note) : 'No note.'));
    p.appendChild(el('p', 'hl-pop-hint', READONLY_HINT));
  } else {
    const ta = el('textarea', 'hl-note');
    ta.value = rec.note ? String(rec.note) : '';
    ta.placeholder = 'Add a note';
    ta.rows = 3;
    const share = el('label', 'hl-share');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = rec.shared !== false;
    share.append(cb, document.createTextNode(' Visible to Claude'));
    let color = colorToken(rec.color);
    const colors = el('div', 'hl-colors');
    for (const c of COLORS) {
      const b = el('button', 'hl-color');
      b.type = 'button';
      b.dataset.color = c;
      b.title = c;
      b.setAttribute('aria-label', `Colour: ${c}`);
      b.setAttribute('aria-pressed', String(c === color));
      b.addEventListener('click', () => {
        color = c;
        for (const x of colors.children) x.setAttribute('aria-pressed', String(x.dataset.color === c));
      });
      colors.appendChild(b);
    }
    const acts = el('div', 'hl-pop-acts');
    const save = el('button', 'hl-save', 'Save');
    save.type = 'button';
    const del = el('button', 'hl-delete', 'Delete');
    del.type = 'button';
    acts.append(save, del);
    p.append(ta, share, colors, acts);
    save.addEventListener('click', async () => {
      const patch = {};
      if (ta.value !== (rec.note || '')) patch.note = ta.value;
      if (cb.checked !== (rec.shared !== false)) patch.shared = cb.checked;
      if (color !== colorToken(rec.color)) patch.color = color;
      if (!Object.keys(patch).length) { closeNote(); return; }
      const r = await request('PATCH', `${ELEMENTS_PATH}/${encodeURIComponent(id)}`,
        { body: { payload: patch, ...(rec.v != null ? { base_v: rec.v } : {}) } });
      if (!r.ok) { showReaimNote(r.hint); return; }
      if (r.body && r.body.element) applyOne(r.body.element);
      closeNote();
    });
    del.addEventListener('click', async () => {
      const r = await request('DELETE', `${ELEMENTS_PATH}/${encodeURIComponent(id)}`);
      if (!r.ok) { showReaimNote(r.hint); return; }
      dropOne(id);
      closeNote();
    });
  }
  const box = container.getBoundingClientRect ? container.getBoundingClientRect() : { left: 0, bottom: 0 };
  p.style.left = Math.max(8, Math.round(box.left)) + 'px';
  p.style.top = Math.round(box.bottom + 6) + 'px';
  document.body.appendChild(p);
  pop = p;
  popOff = registerPopover({ el: p, close: closeNote });
  const first = p.querySelector('textarea');
  if (first) { try { first.focus(); } catch { /* not focusable here */ } }
  return p;
}

// ── the rail's card (K.2-11) ───────────────────────────────────────────────
// Where a highlight is on the page now: its painted range, else its pane.
export function showOnPage(elementId, mount) {
  for (const c of marks) {
    if (!c.isConnected || !c._hlIds || !c._hlIds.has(String(elementId))) continue;
    const g = groupOf(c);
    const range = g ? rangeOfGroup(g) : null;
    const node = range ? range.startContainer : null;
    const at = node && (node.nodeType === 1 ? node : node.parentElement);
    if (at && typeof at.scrollIntoView === 'function') { at.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true; }
  }
  const M = window.__wcMount;
  const it = mount && M && typeof M.itemEl === 'function' ? M.itemEl(document, mount) : null;
  if (it && it.el && typeof it.el.scrollIntoView === 'function') { it.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true; }
  showReaimNote(GONE_HINT);
  return false;
}
const cardSlots = new Set();
function renderCard(item, slot) {
  cardSlots.add(slot);
  slot.replaceChildren();
  const id = item.element_id == null ? '' : String(item.element_id);
  const rec = liveRecords.get(id) || null;
  const line = el('div', 'hl-card');
  line.appendChild(swatch(rec && rec.color));
  const note = rec && rec.note ? String(rec.note) : '';
  line.appendChild(el('span', note ? 'hl-card-note' : 'hl-card-note hl-card-empty', note || (item.summary ? String(item.summary) : 'Highlight')));
  const show = el('button', 'hl-card-show', 'Show on page');
  show.type = 'button';
  show.addEventListener('click', () => showOnPage(id, item.origin_mount || null));
  line.appendChild(show);
  slot.appendChild(line);
  slot._hlItem = item;
}
// A record's colour or note changed: the cards on the rail redraw in place.
function refreshCards() {
  for (const slot of [...cardSlots]) {
    if (!slot.isConnected) { cardSlots.delete(slot); continue; }
    if (slot._hlItem) renderCard(slot._hlItem, slot);
  }
}

// ── init ───────────────────────────────────────────────────────────────────
let inited = false;
export function initHighlights() {
  if (inited) return;
  inited = true;
  registerElementType(TYPE, { draw, move, create, input: 'selection', glyph: HANDLE_GLYPH });
  registerQueueCard(TYPE, { render: renderCard, unmount: (slot) => { cardSlots.delete(slot); slot._hlItem = null; } });
  onHello(() => { loadLive(); });
  onFrame('reset', () => { loadLive(); });
  onFrame(`element:${TYPE}`, onElementsFrame);
  bus.on('preview:node', (d) => { onPreview(d).catch((e) => console.error('[web-chat] highlight: the preview read failed', e)); });
  bus.on('view', () => { if (!view.previewing) { previewId = null; previewRecords = new Map(); } });
  bus.on('overlay:frame', (f) => {
    drawRects();
    if (f && f.done) reconcile();
  });
  window.addEventListener('pointerdown', onAnyPointerDown, true);
  document.addEventListener('mousedown', onCompatMouse, true);
  document.addEventListener('mouseup', onCompatMouse, true);
}

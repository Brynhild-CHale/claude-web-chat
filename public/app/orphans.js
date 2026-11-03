// Orphans visible, and the re-anchor affordance (annotation engine 2A.6;
// DECISIONS.md I.5 F2's note, I.8 O1, I.7 M1, alpha.1 finding K-10).
//
// The overlay (overlay.js) draws what the resolver re-finds and lists what it
// cannot: orphans() is the drawn surface's orphans (live, or the previewed
// node's), a hidden element never among them (U303's probe). This module
// makes that list visible and lets the user re-anchor an element, writing a
// new ANCHOR VERSION through the element route and never a node:
//
//   * ONE list, three ways in: a ⌘K row 'Orphaned elements (n)'
//     (registerPaletteSource) that opens a STAND-IN popover of the rows, and a
//     section of the same rows in the graph inspector for the node on screen
//     only (the active node live, the previewed node while previewing), capped
//     with capRows. Each row: the element's type, its last-known place by
//     mount, 'guess' when the resolver carried one, and 'Re-anchor…'.
//   * The carried guess (a converted pin whose text no longer matches; the
//     overlay draws it at the guess): a click on its marker (bus
//     'overlay:guess') opens the re-anchor card, a STAND-IN popover — 'Re-anchor
//     here' records an anchor of the element's OWN anchor kind on the guess
//     element through the resolver and writes it; 'Leave it' writes nothing.
//   * A SECTION FALLBACK (a source record whose quote and bracket are gone,
//     re-resolved how 'section' and drawn over its hinted section; never an
//     orphan, never listed): a click on its marker (bus 'overlay:guess' with
//     how 'section', K.2-74) opens the same card, saying the element is
//     anchored to its section; 'Re-anchor here' records a source anchor over
//     the section the resolver answers at the press and writes it the same way.
//   * A guess-less orphan's 'Re-anchor…' starts overlay.pick({kind: the
//     element's own anchor kind}); the card stays up while the pick waits and
//     is registered with the one dismiss layer, so Escape (or a press outside
//     the page well) cancels the pick and nothing is sent. The picked record is
//     written.
//   * THE WRITE (the one path): http.js request('PATCH', '/api/elements/<id>',
//     {body: {anchor, base_v}, device: true}) — U325's re-anchor body, base_v
//     the version the overlay holds. On ok the overlay's live set takes the new
//     version (upsertElements) and the card reads 'Re-anchored · anchor v<n>
//     written, the node untouched'; a refusal shows its hint in the card and
//     changes nothing. While previewing every write path answers READONLY_HINT
//     and sends nothing (D2); the list and the guess still show.
//
// The look is a STAND-IN until the design studio's mock-up (H-2 (b): U338
// draws the toolbar; this module draws no toolbar, tray or settings look).
// Classes only, never an element id. Tranche 2 draws elements in the live
// chrome only (F-DOCS (a)), so the list exists nowhere in a document.
import { bus } from './bus.js';
import { view, $ } from './state.js';
import anchors from './anchors.js';
import { orphans, elementsOf, drawnScopeOf, upsertElements, pick } from './overlay.js';
import { registerPopover, registerPaletteSource } from './shell.js';
import { onInspectorRender, closeOverlay, isOverlayOpen } from './graph-view.js';
import { capRows, moreLabel } from './row-caps.js';
import { request } from './http.js';
import { READONLY_HINT } from './topbar.js';
import { page } from './page.js';
import { sourceMap } from './markdown.js';

export const PALETTE_SOURCE = 'orphans';
export const PICK_HINTS = Object.freeze({
  element: 'click the element in a pane to anchor it to',
  range: 'select the text in a pane to anchor it to',
  source: 'select the text in a markdown item to anchor it to',
  point: 'click inside an image, an svg or a canvas in a pane to anchor it to',
});
export const LEAVE_HINT = 'Left as it is — nothing written.';
export const NO_GUESS_HINT = 'The guess is gone from the page — pick a new place instead.';
export const NO_SECTION_HINT = 'The section is gone from the page, or too long to anchor to — pick a new place instead.';
// A section fallback whose marker names it in data-el-notes (a type whose
// marker opens a note, e.g. a highlight): its note waits for the re-anchor.
export const SECTION_NOTE_LINE = 'Its note opens once it is re-anchored.';
export const UNCHANGED_HINT = 'Nothing written — the element is already anchored there.';
export const sectionText = (place, v) =>
  `Anchored in ${place}, v${v == null ? '?' : v} · its text no longer matches; anchored to its section, drawn over the section`;
export const reanchoredText = (v) => `Re-anchored · anchor v${v == null ? '?' : v} written, the node untouched`;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ── the rows ────────────────────────────────────────────────────────────────
function rowOf(id, scope = drawnScopeOf()) {
  return elementsOf(scope).find((r) => r.id === id) || null;
}
function kindOf(row) {
  const k = row && isObj(row.anchor) ? row.anchor.kind : null;
  return k === 'element' || k === 'range' || k === 'source' || k === 'point' ? k : null;
}
// The element's last-known place, by mount (a pane, or a markdown item).
function placeOf(o, row) {
  const a = row && isObj(row.anchor) ? row.anchor : null;
  if (a && a.kind === 'source') return o.mount != null ? `markdown ${o.mount}` : (a.md != null ? `markdown ${a.md}` : 'no place');
  const m = o.mount != null ? o.mount : (a && a.mount != null ? a.mount : null);
  return m != null ? `pane ${m}` : 'no place';
}
function describe(o) {
  const row = rowOf(o.id, o.scope);
  return { ...o, row, kind: kindOf(row), place: placeOf(o, row) };
}
// The node the surface shows: the previewed one, else the active one.
export function nodeOnScreen() {
  return view.previewing ? view.viewedId : view.activeId;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function rowEl(o, { from } = {}) {
  const li = el('li', 'wc-orphan-row');
  li.dataset.elId = o.id;
  li.appendChild(el('span', 'wc-orphan-type', o.type || 'element'));
  li.appendChild(el('span', 'wc-orphan-place', o.place));
  if (o.guess) li.appendChild(el('span', 'wc-orphan-guess', 'guess'));
  const b = el('button', 'wc-orphan-act', 'Re-anchor…');
  b.type = 'button';
  b.title = o.guess ? 'Re-anchor it at the guess, or leave it' : 'Pick a new place on the page for it';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (from === 'inspector' && isOverlayOpen()) closeOverlay();
    closeList();
    if (o.guess) openGuessCard(o);
    else startPick(o);
  });
  li.appendChild(b);
  return li;
}
function rowsEl(list, from) {
  const ul = el('ul', 'wc-orphan-rows');
  const capped = capRows(list);
  for (const o of capped.rows) ul.appendChild(rowEl(describe(o), { from }));
  if (capped.more) ul.appendChild(el('li', 'wc-orphan-more', moreLabel(capped.more)));
  return ul;
}

// ── the stand-in list (a registered popover) ───────────────────────────────
let listEl = null;
function closeList() {
  if (listEl) listEl.remove();
  listEl = null;
}
function fillList() {
  if (!listEl) return;
  const list = orphans();
  listEl.textContent = '';
  const head = el('div', 'wc-orphans-head');
  head.appendChild(el('span', 'wc-orphans-title', `Orphaned elements (${list.length})`));
  head.appendChild(el('span', 'wc-standin', 'stand-in'));
  listEl.appendChild(head);
  if (!list.length) { listEl.appendChild(el('p', 'wc-orphans-empty', 'Every element on this surface is anchored.')); return; }
  listEl.appendChild(rowsEl(list, 'list'));
}
export function openOrphanList() {
  closeList();
  const pop = el('div', 'wc-orphans-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Orphaned elements');
  // one panel at a time: the dismiss layer's own close-the-others event
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: pop } }));
  listEl = pop;
  document.body.appendChild(pop);
  fillList();
  return pop;
}

// ── the re-anchor card (a registered popover) ──────────────────────────────
// {id, o, mode: 'guess' | 'section' | 'pick' | 'refused' | 'note' | 'done',
//  handle (a pending pick), busy}
let card = null;
let cardEl = null;
function closeCard() {
  const c = card;
  card = null;
  if (c && c.handle) { const h = c.handle; c.handle = null; h.cancel(); }
  if (cardEl) cardEl.remove();
  cardEl = null;
}
function markerOf(id) {
  const layer = $('el-layer');   // the overlay's one layer (read, never made here)
  if (!layer) return null;
  for (const m of layer.querySelectorAll('.el-marker')) {
    if ((m.dataset.elIds || '').split(' ').includes(id)) return m;
  }
  return null;
}
function placeCard(c, id) {
  const m = markerOf(id);
  const r = m && typeof m.getBoundingClientRect === 'function' ? m.getBoundingClientRect() : null;
  if (!r || !(r.width || r.height)) { c.classList.add('wc-reanchor-docked'); return; }
  c.style.left = Math.max(8, Math.round(r.left)) + 'px';
  c.style.top = Math.round(r.bottom + 6) + 'px';
}
function newCard(o) {
  closeCard();
  closeList();
  const c = el('div', 'wc-reanchor-card');
  c.setAttribute('role', 'dialog');
  c.setAttribute('aria-label', 'Re-anchor');
  c.dataset.elId = o.id;
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: c } }));
  cardEl = c;
  card = { id: o.id, o, mode: 'note', handle: null, busy: false };
  document.body.appendChild(c);
  placeCard(c, o.id);
  return c;
}
function cardHead(c, o) {
  const head = el('div', 'wc-reanchor-head');
  head.appendChild(el('span', 'wc-reanchor-title', `${o.type || 'element'} · v${o.v == null ? '?' : o.v}`));
  head.appendChild(el('span', 'wc-standin', 'stand-in'));
  c.appendChild(head);
}
function noteEl() { return cardEl && cardEl.querySelector('.wc-reanchor-note'); }
function setNote(text, { refused = false } = {}) {
  const n = noteEl();
  if (!n) return;
  n.textContent = text;
  n.classList.toggle('wc-refused', !!refused);
}
function button(cls, text, fn) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}

export function openGuessCard(orphan) {
  const o = describe(orphan);
  const c = newCard(o);
  const section = o.how === 'section';
  card.mode = section ? 'section' : 'guess';
  cardHead(c, o);
  c.appendChild(el('p', 'wc-reanchor-text', section ? sectionText(o.place, o.v)
    : `Anchored in ${o.place}, v${o.v == null ? '?' : o.v} · its anchor no longer matches; drawn at the resolver's guess`));
  const m = section ? markerOf(o.id) : null;
  if (m && (m.dataset.elNotes || '').split(' ').includes(String(o.id))) c.appendChild(el('p', 'wc-reanchor-noteline', SECTION_NOTE_LINE));
  const acts = el('div', 'wc-reanchor-acts');
  acts.appendChild(button('wc-reanchor-here', 'Re-anchor here', () => reanchorHere(o)));
  acts.appendChild(button('wc-reanchor-leave', 'Leave it', () => leaveIt()));
  c.appendChild(acts);
  const note = el('p', 'wc-reanchor-note');
  note.setAttribute('role', 'status');
  c.appendChild(note);
  return c;
}

function leaveIt() {
  // Nothing is written: the card closes.
  closeCard();
}

// The guess, found again for the button press by the resolver itself (the
// overlay's answer for the same record), on the element's pane.
function guessOf(o) {
  const M = window.__wcMount;
  const mount = o.mount != null ? o.mount : (o.row && o.row.anchor && o.row.anchor.mount);
  const it = mount != null && M && typeof M.itemEl === 'function' ? M.itemEl(document, mount) : null;
  const root = it && it.kind === 'pane' && it.el && it.el.shadowRoot ? it.el.shadowRoot : null;
  if (!root || !o.row || !o.row.anchor) return null;
  let ans = null;
  try { ans = anchors.resolve(root, o.row.anchor); } catch (e) { console.error('[web-chat] orphans: the resolver failed', e); }
  return ans && ans.guess && ans.guess.nodeType === 1 ? { root, el: ans.guess, mount: String(mount) } : null;
}
// An anchor of the element's OWN kind on the guess element, recorded by the
// resolver (record / recordRange); never another kind.
function recordOn(kind, g) {
  if (kind === 'element') return anchors.record(g.root, g.el, { mount: g.mount });
  if (kind === 'range' && typeof anchors.recordRange === 'function') {
    const range = document.createRange();
    range.selectNodeContents(g.el);
    return anchors.recordRange(g.root, range, { mount: g.mount });
  }
  return null;
}

// A section fallback's section, found again for the button press by the
// resolver (resolveSource over the markdown item's current text), and a source
// anchor — the element's own kind — recorded over it; null when the answer is
// no longer a section or the section is too long to quote.
function recordOnSection(o) {
  if (o.kind !== 'source' || !o.row || !isObj(o.row.anchor)) return null;
  const M = window.__wcMount;
  const md = o.mount != null ? o.mount : o.row.anchor.md;
  const it = md != null && M && typeof M.itemEl === 'function' ? M.itemEl(document, md) : null;
  const item = md != null && page.markdown ? page.markdown.get(String(md)) : null;
  if (!it || it.kind !== 'md' || !it.el || !item) return null;
  const text = String(item.text == null ? '' : item.text);
  try {
    const map = sourceMap(text);
    const ans = anchors.resolveSource(it.el, text, map, o.row.anchor);
    if (!ans || ans.how !== 'section' || !ans.range) return null;
    return anchors.recordSource(it.el, ans.range, map, text, { md: String(md) });
  } catch (e) {
    console.error('[web-chat] orphans: the resolver failed', e);
    return null;
  }
}

async function reanchorHere(o) {
  if (!card || card.id !== o.id || card.busy) return;
  if (view.previewing) { setNote(READONLY_HINT, { refused: true }); return; }
  let rec = null;
  if (o.how === 'section') rec = recordOnSection(o);
  else {
    const g = guessOf(o);
    rec = g ? recordOn(o.kind, g) : null;
  }
  if (!rec) {
    setNote(o.how === 'section' ? NO_SECTION_HINT : NO_GUESS_HINT, { refused: true });
    const acts = cardEl && cardEl.querySelector('.wc-reanchor-acts');
    if (acts && !acts.querySelector('.wc-reanchor-pick')) acts.prepend(button('wc-reanchor-pick', 'Re-anchor…', () => startPick(o)));
    return;
  }
  await write(o, rec);
}

// A guess-less orphan: arm a pick of the element's own anchor kind; the card
// shows what to do and holds the pick's cancel for the dismiss layer.
export function startPick(orphan) {
  const o = describe(orphan);
  const c = newCard(o);
  card.mode = 'pick';
  cardHead(c, o);
  const note = el('p', 'wc-reanchor-note');
  note.setAttribute('role', 'status');
  if (view.previewing || !o.kind) {
    c.appendChild(note);
    setNote(view.previewing ? READONLY_HINT : 'This element has no anchor kind the page can pick.', { refused: true });
    return c;
  }
  c.appendChild(el('p', 'wc-reanchor-text', `Re-anchor: ${PICK_HINTS[o.kind]} (Escape cancels)`));
  const acts = el('div', 'wc-reanchor-acts');
  acts.appendChild(button('wc-reanchor-cancel', 'Cancel', () => closeCard()));
  c.appendChild(acts);
  c.appendChild(note);
  const handle = pick({ kind: o.kind });
  const mine = card;
  mine.handle = handle;
  handle.promise.then((got) => {
    if (card !== mine) return;
    mine.handle = null;
    // A pick ended by something else (a preview opening) leaves the card as
    // that left it: only a pick still pending closes it on a null answer.
    if (mine.mode !== 'pick') return;
    if (!got || !got.record) { closeCard(); return; }
    const cancel = cardEl && cardEl.querySelector('.wc-reanchor-cancel');
    if (cancel) cancel.remove();
    return write(o, got.record);
  }).catch((e) => console.error('[web-chat] orphans: the pick failed', e));
  return c;
}

// THE WRITE: one PATCH through the chrome's one reader. Never a node write.
async function write(o, anchor) {
  const mine = card;
  if (!mine) return;
  if (view.previewing) { setNote(READONLY_HINT, { refused: true }); return; }
  const row = rowOf(o.id, 'live');
  const body = { anchor };
  if (row && Number.isSafeInteger(row.v)) body.base_v = row.v;
  mine.busy = true;
  setNote('Writing…');
  const r = await request('PATCH', '/api/elements/' + encodeURIComponent(o.id), { body, device: true });
  mine.busy = false;
  if (card !== mine) return;
  if (!r.ok) { setNote(r.hint || 'The daemon refused the re-anchor.', { refused: true }); return; }
  const got = r.body && isObj(r.body.element) ? r.body.element : null;
  if (r.body && r.body.unchanged) { setNote(UNCHANGED_HINT); return; }
  const v = got && Number.isSafeInteger(got.v) ? got.v : null;
  // The version the daemon wrote: a comment's engine record rides `record`,
  // another type's `anchor`; the anchor sent when it answers neither.
  const next = got && isObj(got.record) ? got.record : got && isObj(got.anchor) ? got.anchor : anchor;
  if (row) upsertElements('live', [{ ...row, v: v == null ? row.v : v, anchor: next }]);
  mine.mode = 'done';
  const acts = cardEl && cardEl.querySelector('.wc-reanchor-acts');
  if (acts) acts.remove();
  setNote(reanchoredText(v));
  if (cardEl) cardEl.classList.add('wc-reanchor-done');
}

// ── the inspector section (the node on screen only) ────────────────────────
let inspCtx = null;
function drawInspector(ctx) {
  if (!ctx || !ctx.box) return;
  const old = ctx.box.querySelector('.wc-orphans-insp');
  if (old) old.remove();
  if (typeof ctx.current === 'function' && !ctx.current()) return;
  if (ctx.id == null || ctx.id !== nodeOnScreen()) return;
  const list = orphans();
  if (!list.length) return;
  const sec = el('section', 'wc-orphans-insp');
  const head = el('div', 'wc-orphans-head');
  head.appendChild(el('span', 'wc-orphans-title', `ORPHANED ELEMENTS · ${list.length}`));
  head.appendChild(el('span', 'wc-standin', 'stand-in'));
  sec.appendChild(head);
  sec.appendChild(rowsEl(list, 'inspector'));
  const acts = ctx.box.querySelector('.gv-actions');
  if (acts) ctx.box.insertBefore(sec, acts);
  else ctx.box.appendChild(sec);
}

// ── wiring ──────────────────────────────────────────────────────────────────
function onOrphans() {
  fillList();
  if (inspCtx) drawInspector(inspCtx);
}
function onView() {
  // A preview refuses every write: a pick pending when one opens ends, and the
  // card says why.
  if (view.previewing && card && card.handle) {
    const h = card.handle;
    card.handle = null;
    card.mode = 'refused';
    h.cancel();
    setNote(READONLY_HINT, { refused: true });
  }
}

let offs = null;
export function initOrphans() {
  if (offs) return;
  const well = () => $('main');
  offs = [
    registerPopover({ el: () => listEl, close: closeList }),
    // While a pick waits, a press in the page well is the pick's, not an
    // outside press: the card stays (and its pick) until the pick answers.
    registerPopover({
      el: () => cardEl,
      close: closeCard,
      contains: (target, path) => {
        const p = Array.isArray(path) ? path : [];
        if (cardEl && (p.includes(cardEl) || (target && cardEl.contains(target)))) return true;
        const w = well();
        return !!(card && card.handle && w && (p.includes(w) || (target && w.contains(target))));
      },
    }),
    registerPaletteSource(PALETTE_SOURCE, {
      rows: () => {
        const n = orphans().length;
        return n ? [{ kind: 'elements', label: `Orphaned elements (${n})`, hint: 'stand-in list', run: openOrphanList }] : [];
      },
    }),
    onInspectorRender((ctx) => { inspCtx = ctx; drawInspector(ctx); }),
    bus.on('overlay:orphans', onOrphans),
    bus.on('overlay:guess', (d) => {
      if (!d || d.id == null) return;
      // A section fallback is no orphan: its row is on the drawn surface.
      if (d.how === 'section') {
        if (rowOf(d.id, d.scope)) openGuessCard({ id: d.id, v: d.v, type: d.type, mount: d.mount, scope: d.scope, how: 'section' });
        return;
      }
      const o = orphans().find((x) => x.id === d.id && x.guess);
      if (o) openGuessCard(o);
    }),
    bus.on('view', onView),
  ];
}

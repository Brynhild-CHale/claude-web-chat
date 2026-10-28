// The box grab, chrome side (annotation engine 2C.4; DECISIONS.md I
// box-grabs@2C.4, K.1 F-GRAB (a) and its note, K.2 items 10, 11, 17, 18; the
// rulings F4, F5, F6 (a); U328c — the daemon half is U328b's
// lib/server/box-grab.js).
//
// THE GESTURE. The type registers through element-types.js registerElementType
// with input 'strokes' (the input-mode policy's: a pen or a mouse draws; a
// finger only with finger-draws on, K.2-8 / D1 (b); a previewed node creates
// nothing, D2: element-types.js's tray action guard refuses the gesture with
// READONLY_HINT, TRAY@guard). create() takes every event of the
// gesture the overlay's one pointer dispatch hands it: the press starts a
// rubber band drawn in the overlay's layer (#el-layer, viewport coordinates),
// the moves stretch it, the release measures the grab and posts it, a cancel
// drops it. Nothing else listens to the pointer.
//
// THE MEASURE (measureGrab). The page item under the box is the item it
// overlaps most (a pane's `.pane[data-pane-id]` wrapper or a markdown block's
// `[data-md-id]`, the attributes the export shell carries too, so the daemon's
// render finds the same item); a box over no item — the chrome around the
// page — is refused with CHROME_HINT. ONE FRAME OF REFERENCE (K.2-72): the rect
// is measured from the item's CONTENT BOX — a pane's `.mount-host` (never the
// wrapper, whose header the export has no copy of), a markdown item's block —
// and the anchor and payload carry that box's size, `box: {w, h}` beside
// `rect`, and its own scroll, `scroll: {top, left}` (K.2-80: a rows-capped
// pane's box scrolls; 0/0 when it is not); the daemon clips from the export's
// content box of the same item, laid out at that width and scrolled the same,
// so nothing reflows or shifts under the clip. A box over the
// pane's header alone is chrome too (CHROME_HINT). The box is clipped to the
// content box, then snapped as the armed settings say (toolbar-state.js
// settingsOf('box-grab'), the manifest's default 'block' beneath, F2 (a)):
// 'block' takes the box of the smallest element containing it (the content
// box itself when no element inside does); 'free' keeps it as drawn. The element
// recorded is the deepest one containing the grabbed box, inside the pane's
// shadow root (or the markdown block): its selector path and its outerHTML,
// clipped to HTML_MAX_BYTES. The chrome sends these raw values once, to the
// one writer (POST /api/elements through http.js); the daemon adds the
// pane's script errors and the theme's name and redacts everything (U328b).
//
// THE LOOK BEFORE SENDING (B2's note: "The user should be able to see the
// picture that gets snapped so they can confirm that claude is seeing what
// they are"). The daemon raises the grab's one element queue item only when
// its picture settles (or cannot be drawn), carrying the image block. When the
// item of a grab drawn here arrives (the rail's `queue` snapshot, or the
// `element:box-grab` frame after it), a popover — a STAND-IN look, registered
// with shell.js registerPopover — shows the picture: an <img> of GET
// /api/elements/<id>/grab, the one PNG Claude reads (no canvas, no re-encode,
// scaled down by CSS only). "Keep in queue" closes it; "Discard" deletes the
// element and takes its queue item out through queue.js's own removal.
// chrome-not-found (or a failed render) shows its hint and says Claude gets
// the metadata only.
//
// THE CARD (K.2-11, F6 (a)). The rail draws the grab's element item through
// the card registered here (shell.js registerQueueCard; the rail's consult is
// U305's, K.2-18): the same picture, Open (the look at full size), Re-send
// (POST /api/queue/items/<id>/resend, K.2-17 — a delivered item only), Remove
// (the ctx's removal, the queue's own) and Show on page (mounts.js revealPane
// or page.js revealMarkdown on the item the grab came from). A STAND-IN look.
// The card adds no write path of its own.
//
// SEND TO CLAUDE (F.5, M2 (a)). The look after the picture settled (the
// card's Open) carries Send to Claude beside Show on page, at canWrite only
// (element-types.js maySend): a grab is always shared, so one tap queues it
// again when no item of its is queued (element-types.js sendToClaude), with
// the picture its item carried; Push still decides when. Discard and Send
// run through the tray action guard (TRAY@guard).
//
// NOTHING ON THE PAGE (F6 (a)). A sent grab's anchor is a page record the
// engine never resolves (overlay.js placeOf), so the type's draw is never
// called for it; it is a no-op all the same.
//
// C-15-1..3: nothing here is a security boundary; the device claim is
// attribution (http.js `device: true`).
import { registerElementType, typeOf, trayAction, maySend, sendToClaude, SEND_LABEL } from './element-types.js';
import { request } from './http.js';
import { bus } from './bus.js';
import { view, $ } from './state.js';
import { onFrame } from './ws.js';
import { settingsOf } from './toolbar-state.js';
import { registerPopover, registerQueueCard } from './shell.js';
import { queueSnapshot, removeItem } from './queue.js';
import { revealPane } from './mounts.js';
import { revealMarkdown } from './page.js';
import { effectiveMode, getGlobalTheme } from './theme.js';
import { deviceKind } from './viewport.js';
import { showReaimNote } from './topbar.js';

export const TYPE = 'box-grab';
export const SNAPS = Object.freeze(['block', 'free']);
export const DEFAULT_SNAP = 'block';
export const HTML_MAX_BYTES = 8192;
// Below this many px on both sides a drawn box is a press, not a box: 'block'
// grabs the smallest element under it, 'free' refuses.
export const MIN_BOX_PX = 4;
export const ELEMENTS_PATH = '/api/elements';
export const grabUrl = (id) => `${ELEMENTS_PATH}/${encodeURIComponent(String(id))}/grab`;
const resendUrl = (itemId) => `/api/queue/items/${encodeURIComponent(String(itemId))}/resend`;

export const CHROME_HINT = 'A box grab is drawn over the page — a pane or its text. That box covered only the chrome around it: draw it again over the page.';
export const SMALL_HINT = 'Draw a box: press, drag across what Claude should see, then release.';
export const METADATA_ONLY = 'No picture — Claude gets the metadata only.';
export const QUEUED_RESEND = 'Still queued: the next Push sends it.';
export const GONE_HINT = 'That block is no longer on the page.';

const SKIP_TAGS = new Set(['script', 'style', 'template', 'link', 'meta', 'noscript']);
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const num = (n) => Math.round(n * 100) / 100;

// ── geometry ─────────────────────────────────────────────────────────────────
const boxOf = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
};
const area = (b) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
const meet = (a, b) => ({
  left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
});
const EPS = 0.5;
const holds = (outer, inner) => outer.left <= inner.left + EPS && outer.top <= inner.top + EPS
  && outer.right >= inner.right - EPS && outer.bottom >= inner.bottom - EPS;
const sized = (b) => b.right - b.left > 0 && b.bottom - b.top > 0;

// The page's items, in the well: panes and markdown blocks.
function pageItems() {
  const well = $('main');
  if (!well) return [];
  const out = [];
  for (const el of well.querySelectorAll('.pane[data-pane-id]')) out.push({ id: el.dataset.paneId, kind: 'pane', el });
  for (const el of well.querySelectorAll('[data-md-id]')) out.push({ id: el.getAttribute('data-md-id'), kind: 'md', el });
  return out.filter((it) => it.id);
}

// The item a box is over: the one it overlaps most; a press (no area) takes
// the item holding its point.
function itemUnder(box) {
  let best = null;
  let bestArea = 0;
  const point = !sized(box);
  for (const it of pageItems()) {
    const b = boxOf(it.el);
    if (!sized(b)) continue;
    if (point) {
      if (holds(b, box)) return { ...it, box: b };
      continue;
    }
    const a = area(meet(b, box));
    if (a > bestArea) { best = { ...it, box: b }; bestArea = a; }
  }
  return best;
}

// Where the item's content lives: a pane's shadow root (inside its host), or
// the markdown block itself; and the content's own box.
function contentOf(item) {
  if (item.kind === 'md') return { root: item.el, base: item.el };
  const host = item.el.querySelector('.mount-host');
  if (!host) return { root: null, base: item.el };
  return { root: host.shadowRoot || null, base: host };
}

// The deepest element inside `root` whose box holds `box`: the smallest one,
// the later in tree order on a tie.
function deepestHolding(root, box) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  let best = null;
  let bestArea = Infinity;
  for (const el of root.querySelectorAll('*')) {
    if (SKIP_TAGS.has(el.localName)) continue;
    const b = boxOf(el);
    if (!sized(b) || !holds(b, box)) continue;
    const a = area(b);
    if (a <= bestArea) { best = { el, box: b }; bestArea = a; }
  }
  return best;
}

// A selector path from `stop` (exclusive) down to `el`: tag, #id, up to two
// classes, :nth-of-type when a sibling shares the tag.
function stepOf(el) {
  let s = el.localName;
  if (el.id) s += '#' + el.id;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
  for (const c of cls) s += '.' + c;
  const parent = el.parentElement || el.parentNode;
  if (parent && parent.children) {
    const same = [...parent.children].filter((c) => c.localName === el.localName);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return s;
}
function pathOf(el, stop) {
  const steps = [];
  for (let n = el; n && n !== stop && n.nodeType === 1; n = n.parentElement) {
    if (n.id === 'main' && n.getRootNode() === document) break;
    steps.unshift(stepOf(n));
    if (n.parentElement == null) break;
  }
  return steps.join(' > ');
}
function itemPath(item) {
  const attr = item.kind === 'md' ? 'data-md-id' : 'data-pane-id';
  const parent = item.el.parentElement;
  const above = parent ? pathOf(parent, null) : '';
  const self = `${item.el.localName}[${attr}=${JSON.stringify(String(item.id))}]`;
  return ['#main', above, self].filter(Boolean).join(' > ');
}

// The element's outerHTML, clipped to `max` UTF-8 bytes (never splitting a
// character).
export function clipHtml(html, max = HTML_MAX_BYTES) {
  const s = typeof html === 'string' ? html : '';
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  const { read } = enc.encodeInto(s, new Uint8Array(max));
  return s.slice(0, read);
}

function snapOf(profile) {
  let s = null;
  try { s = settingsOf(TYPE, profile).snap; } catch { s = null; }
  if (SNAPS.includes(s)) return s;
  const row = typeOf(TYPE);
  const d = row && row.toolbar && row.toolbar.settings && row.toolbar.settings.small
    && row.toolbar.settings.small.properties && row.toolbar.settings.small.properties.snap
    && row.toolbar.settings.small.properties.snap.default;
  return SNAPS.includes(d) ? d : DEFAULT_SNAP;
}

function viewportNow() {
  const v = { w: Math.round(window.innerWidth || 0), h: Math.round(window.innerHeight || 0), dpr: Number(window.devicePixelRatio) || 1 };
  if (deviceKind() === 'mobile') v.mobile = true;
  return v;
}

// measureGrab(box, {snap}) → {ok: true, body} | {ok: false, hint}. `box` is in
// viewport px {left, top, right, bottom}. The body is the POST /api/elements
// body (http.js adds the device claim): rect relative to the item's content
// box, box that content box's {w, h}, scroll its {top, left} scroll offset.
export function measureGrab(drawn, { snap = DEFAULT_SNAP } = {}) {
  const box = {
    left: Math.min(drawn.left, drawn.right), top: Math.min(drawn.top, drawn.bottom),
    right: Math.max(drawn.left, drawn.right), bottom: Math.max(drawn.top, drawn.bottom),
  };
  const small = box.right - box.left < MIN_BOX_PX && box.bottom - box.top < MIN_BOX_PX;
  if (small && snap !== 'block') return { ok: false, hint: SMALL_HINT };
  const probe = small ? { left: box.left, top: box.top, right: box.left, bottom: box.top } : box;
  const item = itemUnder(probe);
  if (!item) return { ok: false, hint: CHROME_HINT };
  const { root, base } = contentOf(item);
  const own = boxOf(base);
  const frame = sized(own) ? own : item.box;
  if (small ? !holds(frame, probe) : !sized(meet(box, frame))) return { ok: false, hint: CHROME_HINT };
  const clipped = small ? probe : meet(box, frame);
  const deepest = deepestHolding(root, clipped);
  let grabbed = clipped;
  if (snap === 'block') {
    const b = deepest ? deepest.box : frame;
    grabbed = sized(b) ? meet(b, frame) : frame;
  }
  if (!sized(grabbed)) return { ok: false, hint: SMALL_HINT };
  const el = deepest ? deepest.el : null;
  const vp = viewportNow();
  const rel = {
    x: num(grabbed.left - frame.left), y: num(grabbed.top - frame.top),
    w: num(grabbed.right - grabbed.left), h: num(grabbed.bottom - grabbed.top),
  };
  const size = { w: num(frame.right - frame.left), h: num(frame.bottom - frame.top) };
  // The content box's own scroll (a rows-capped pane's .mount-host scrolls):
  // the rect is relative to what is scrolled into view, so the daemon scrolls
  // the export's box the same before the clip (K.2-80); 0/0 when unscrolled.
  const scroll = { top: num(Number(base.scrollTop) || 0), left: num(Number(base.scrollLeft) || 0) };
  const client = { x: num(grabbed.left), y: num(grabbed.top), w: rel.w, h: rel.h };
  const mount = item.kind === 'pane' ? item.id : null;
  const theme = getGlobalTheme();
  const meta = {
    item_path: itemPath(item),
    element_path: el ? pathOf(el, root) : '',
    html: clipHtml(el ? el.outerHTML : ''),
    theme: theme && typeof theme.name === 'string' ? theme.name : null,
    mode: effectiveMode() === 'dark' ? 'dark' : 'light',
    viewport: vp,
  };
  return {
    ok: true,
    body: {
      type: TYPE,
      anchor: { v: 1, kind: 'page', item: item.id, mount, rect: { ...rel }, box: { ...size }, scroll: { ...scroll }, viewport: vp },
      payload: { shared: true, rect: { ...rel, item: item.id, viewport: vp, client }, box: { ...size }, scroll: { ...scroll }, meta },
    },
    item: item.id,
  };
}

// ── the gesture ──────────────────────────────────────────────────────────────
let band = null;     // {pointerId, x0, y0, el}
function bandBox(b, x, y) {
  return { left: Math.min(b.x0, x), top: Math.min(b.y0, y), right: Math.max(b.x0, x), bottom: Math.max(b.y0, y) };
}
function drawBand(b, x, y) {
  if (!b.el) {
    const layer = $('el-layer');
    if (!layer) return;
    b.el = document.createElement('div');
    b.el.className = 'bg-band';
    layer.appendChild(b.el);
  }
  const r = bandBox(b, x, y);
  Object.assign(b.el.style, {
    left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`,
  });
}
function dropBand() {
  if (band && band.el) band.el.remove();
  band = null;
}

function note(text) {
  try { showReaimNote(text); } catch { /* the note is a courtesy */ }
}

// create(input): every event of a gesture the overlay gave the tool.
function create(input) {
  if (!input) return;
  // A previewed node creates nothing (D2): the tray action guard's rule and hint.
  if (trayAction(() => true, { note }) !== true) { dropBand(); return; }
  const { phase, clientX: x, clientY: y } = input;
  const id = input.event && typeof input.event.pointerId === 'number' ? input.event.pointerId : 1;
  if (phase === 'pointerdown') {
    dropBand();
    band = { pointerId: id, x0: x, y0: y, el: null, profile: input.profile == null ? null : input.profile };
    drawBand(band, x, y);
    return;
  }
  if (!band || band.pointerId !== id) return;
  if (phase === 'pointermove') { drawBand(band, x, y); return; }
  if (phase === 'pointercancel') { dropBand(); return; }
  if (phase !== 'pointerup') return;
  const b = band;
  const drawn = bandBox(b, x, y);
  dropBand();
  const m = measureGrab(drawn, { snap: snapOf(b.profile) });
  if (!m.ok) { note(m.hint); return; }
  send(m);
}

// The one write: POST /api/elements through http.js.
const awaiting = new Map();   // element id → {item}: grabs drawn here, picture not yet looked at
const origins = new Map();    // element id → the page item it came from (Show on page)
async function send(m) {
  const r = await request('POST', ELEMENTS_PATH, { body: m.body, device: true });
  const rec = r.ok && r.body && isObj(r.body.element) ? r.body.element : null;
  if (!rec || rec.id == null) { note(r.hint || 'The box grab was not saved.'); return null; }
  const id = String(rec.id);
  origins.set(id, m.item);
  awaiting.set(id, { item: m.item });
  checkSettled();
  return id;
}

// ── the look ─────────────────────────────────────────────────────────────────
const itemsOf = () => {
  try { return queueSnapshot().items || []; } catch { return []; }
};
const isGrabItem = (it) => !!it && it.kind === 'element' && it.type === TYPE;
const elementIdOf = (it) => (it && (it.element_id != null ? String(it.element_id) : null));
function queueItemOf(elementId) {
  return itemsOf().find((it) => isGrabItem(it) && elementIdOf(it) === elementId) || null;
}
function checkSettled() {
  if (!awaiting.size) return;
  for (const [id] of [...awaiting]) {
    const it = queueItemOf(id);
    const state = it && isObj(it.image) ? it.image.state : null;
    if (!it || !state || state === 'pending') continue;
    awaiting.delete(id);
    openLook({ elementId: id, image: it.image, queueId: it.id, before: true });
  }
}

let look = null;   // {el, unregister}
export function closeLook() {
  if (!look) return;
  const l = look;
  look = null;
  try { l.unregister(); } catch {}
  l.el.remove();
}

function pictureOf(elementId, image, cls) {
  if (isObj(image) && image.state === 'ready') {
    const img = document.createElement('img');
    img.className = cls;
    img.src = grabUrl(elementId);
    img.alt = 'The box grab, as Claude sees it';
    img.decoding = 'async';
    if (Number.isFinite(image.width)) img.width = image.width;
    if (Number.isFinite(image.height)) img.height = image.height;
    return img;
  }
  const p = document.createElement('p');
  p.className = `${cls} bg-nopic`;
  const why = isObj(image) ? (image.hint || image.error || '') : '';
  const pending = isObj(image) && image.state === 'pending';
  p.textContent = pending ? 'The picture is still being drawn.' : [METADATA_ONLY, why].filter(Boolean).join(' ');
  return p;
}

function button(label, cls, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

// openLook({elementId, image, queueId, before}) — the popover. `before`: the
// look the user gets when the picture settles (Keep in queue / Discard);
// else the card's Open (Close / Show on page).
export function openLook({ elementId, image, queueId = null, before = false } = {}) {
  closeLook();
  const el = document.createElement('div');
  el.className = 'popover bg-look';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Box grab');
  el.dataset.element = elementId;
  const h = document.createElement('h4');
  h.textContent = before ? 'Box grab — what Claude will see' : 'Box grab';
  const frame = document.createElement('div');
  frame.className = 'bg-look-frame';
  frame.append(pictureOf(elementId, image, 'bg-look-img'));
  const acts = document.createElement('div');
  acts.className = 'bg-look-acts';
  if (before) {
    acts.append(
      button('Keep in queue', 'bg-keep', () => closeLook()),
      button('Discard', 'bg-discard', () => trayAction(() => { closeLook(); return discard(elementId, queueId); }, { note })),
    );
  } else {
    acts.append(button('Show on page', 'bg-show', () => { closeLook(); showOnPage(elementId); }));
    if (maySend()) {
      acts.append(button(SEND_LABEL, 'bg-send', () => trayAction(async () => {
        const r = await sendToClaude(elementId);
        note(r.ok ? r.note : r.hint);
      }, { note })));
    }
    acts.append(button('Close', 'bg-close', () => closeLook()));
  }
  el.append(h, frame, acts);
  document.body.appendChild(el);
  const entry = { el, unregister: () => {} };
  entry.unregister = registerPopover({ el, close: () => { if (look === entry) closeLook(); } });
  look = entry;
  return el;
}

// Discard: the element goes (DELETE, the one removal), and its queue item
// through the queue's own removal.
export async function discard(elementId, queueId = null) {
  awaiting.delete(elementId);
  const qid = queueId || (queueItemOf(elementId) || {}).id || null;
  const r = await request('DELETE', `${ELEMENTS_PATH}/${encodeURIComponent(elementId)}`);
  if (!r.ok && r.status !== 404) note(r.hint);
  if (qid) await removeItem(qid);
  return r.ok;
}

// Show on page: the pane (or markdown block) the grab came from.
async function originOf(elementId, hint) {
  if (hint) return hint;
  if (origins.has(elementId)) return origins.get(elementId);
  const r = await request('GET', `${ELEMENTS_PATH}?type=${encodeURIComponent(TYPE)}`);
  const list = r.ok && r.body && Array.isArray(r.body.elements) ? r.body.elements : [];
  const rec = list.find((e) => e && String(e.id) === elementId);
  const item = rec && isObj(rec.anchor) ? rec.anchor.item : null;
  return typeof item === 'string' && item ? item : null;
}
export async function showOnPage(elementId, hint = null) {
  const item = await originOf(String(elementId), hint);
  if (item && (revealPane(item) || revealMarkdown(item))) return true;
  note(GONE_HINT);
  return false;
}

// ── the card (K.2-11) ────────────────────────────────────────────────────────
function renderCard(item, slot, ctx) {
  slot.classList.add('bg-card');
  const id = elementIdOf(item);
  const pic = pictureOf(id, item.image, 'bg-card-img');
  const sum = document.createElement('div');
  sum.className = 'qi-summary';
  sum.textContent = item.summary || '';
  const acts = document.createElement('div');
  acts.className = 'bg-card-acts';
  const open = button('Open', 'bg-open', () => openLook({ elementId: id, image: item.image }));
  const resend = button('Re-send', 'bg-resend', () => resendItem(item.id));
  if (!ctx || !ctx.parked) { resend.disabled = true; resend.title = QUEUED_RESEND; }
  const remove = button('Remove', 'bg-remove', () => { if (ctx && ctx.remove) ctx.remove(); });
  if (!ctx || typeof ctx.remove !== 'function') remove.disabled = true;
  const show = button('Show on page', 'bg-show', () => showOnPage(id, item.origin_mount || null));
  acts.append(open, resend, remove, show);
  slot.append(pic, sum, acts);
}

// Re-send a delivered element item (K.2-17): the queue domain's operation.
export async function resendItem(itemId) {
  if (itemId == null) return false;
  const r = await request('POST', resendUrl(itemId));
  if (!r.ok) note(r.hint);
  return r.ok;
}

// ── init ─────────────────────────────────────────────────────────────────────
let inited = false;
export function initBoxGrab() {
  if (inited) return;
  inited = true;
  // draw: a no-op. A sent grab's anchor is a page record the overlay never
  // places (F6 (a)), so this is never called for one.
  registerElementType(TYPE, { draw() {}, create, input: 'strokes' });
  registerQueueCard(TYPE, { render: renderCard });
  bus.on('queue', () => checkSettled());
  onFrame(`element:${TYPE}`, () => checkSettled());
  bus.on('view', () => { if (view.previewing) dropBand(); });
}

// Tests: the module's own state, put back.
export function _resetForTests() {
  dropBand();
  closeLook();
  awaiting.clear();
  origins.clear();
}
export function _awaiting() { return [...awaiting.keys()]; }

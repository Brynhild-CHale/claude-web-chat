// The comment type, chrome side (annotation engine tranche 2, PLAN.md 2C.4;
// U327b) — comment pins drawn by the page well's ONE overlay (overlay.js), the
// threads they open, the tool that drops them and their card in the queue rail.
//
// THE RECORDS. A comment is an element of the element API (/api/elements,
// type 'comment'): a pin {id, v, text, shared, replies, anchor, …} kept in the
// element log. A private pin never reaches Claude's store reads; Claude reads
// the shared ones through get_comments. The live pins reach the chrome three
// ways, and none of them is a timer:
//   - the daemon's `element:comment` frame (ws.js → applyCommentsFrame), the
//     whole live pin array under `elements`, sent by every comment write;
//   - the hello and every reset carry the lean projection (U304) the overlay
//     takes itself (overlay.js takeLive): the rows it draws from;
//   - ONE GET /api/elements?type=comment through http.js at init, after every
//     hello (a reconnect may have missed a frame) and every reset (a Wipe, a
//     Set active, a Branch or a New graph moved the pins, and the lean rows
//     carry no text) — never while the tab is hidden: a read asked for then is
//     sent when it is visible again.
// The pins are relayed to the overlay's live set (upsertElements /
// removeElements): a frame is the whole live set, so a row it lacks goes; a
// read only refreshes what it lists (the hello's and reset's lean rows are the
// daemon's own projection, never pruned by a read). Each pin's anchor is in
// the resolver's form: the engine record
// a pin carries as its anchor, the version's engine anchor a read serves as
// `record`, or the row the lean projection already gave. The chrome converts no
// 0.8.5 locator (overlay.js's rule): a frame that brings a legacy-anchored pin
// the overlay has no row for asks for one read, which serves its `record`.
//
// THE DRAW. registerElementType('comment', {draw, create, input: 'taps'})
// (element-types.js: the reads gate runs the draw; never registerType). The
// overlay resolves every anchor kind and places, clips and groups the markers
// — pins on one element share one marker with a count — under its DRAW_RULES:
// an exact or re-resolved answer is drawn as the pin, a section answer as a
// section guess, an orphan the resolver carried a guess for at its guess (a
// click on it is the overlay's re-anchor seam, orphans.js), and a plain orphan
// is never drawn: the overlay lists it (orphans()). This module only fills a
// marker: today's 26px map pin, coloured by its state — coral awaiting a reply,
// green once Claude answered, muted when every pin on it is private. Markers
// re-place on the overlay's own redraws (a pane's settle, a scroll, a resize,
// a preview transition, a layout change of the well); nothing here polls.
//
// THE TOOL. Pin mode IS the comment tool armed in the chrome's ONE armed-tool
// state (overlay.js setArmed / armed / onArmedChange, K.2-3), armed through
// tools.js: setPinMode / togglePinMode are thin wrappers, so ✎, C, the bottom
// bar's create entry and the toolbar arm one tool, and body.pin-mode (the
// crosshair, the pressed looks) follows onArmedChange — this module keeps no
// second state. Pointer input reaches create() only through the overlay's
// pointer dispatch under the input-mode policy (input-mode.js): a pen or a
// mouse drops a pin wherever it taps, a pane's controls included (K.2-9); a
// finger tap on static content drops one, and on a control runs the control
// with the tool still armed (D1 b). create() records the tapped element with
// the engine's recorder (anchors.record) and the legacy locator {mount,
// selector, text, ordinal} beside it, then opens the composer; Pin posts
// {type: 'comment', anchor, locator, payload: {text, shared}, device}. A tap
// outside every pane (a markdown item, the page's own chrome) drops nothing.
//
// PREVIEWS ARE READ-ONLY (D2). A previewed older node draws its own pins (the
// overlay's preview set, from the node's lean_elements; their threads from one
// GET ?type=comment&node=<id>), and a thread opened there shows its messages
// and READONLY_HINT, with no reply, share or delete; nothing is created there.
// Documents (a preview document, an export, a replay) draw no pin (F-DOCS a).
//
// THE CARD (K.2-11). A shared pin's queue item ({kind: 'comment', comment_id})
// is drawn in the rail through the card registered here: where the pin is, its
// reply count and Show on page. The rail owns the row and the engine the item
// (stage, hold, ⟲): the card adds no write path.
//
// Every write goes through http.js with the device claim (attribution only,
// C-15-3); no rule here treats a pane or the user as a security boundary
// (C-15-1) — the daemon decides every write.
//
// The heavy modules (the overlay and what it pulls in: ws.js → store.js reads
// `window` at evaluation) are imported lazily: queue.js imports this module
// for isCommentAnswered, and no-DOM module tests import queue.js.
import { view, $ } from './state.js';
import { esc } from './esc.js';
import { request } from './http.js';

export const TYPE = 'comment';
export const ELEMENTS_PATH = '/api/elements';
export const GONE_HINT = 'That comment is not on the page now.';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const validPin = (p) => isObj(p) && typeof p.id === 'string' && p.id !== '' && (p.type == null || p.type === TYPE);
// An anchor in the resolver's form: an engine record, or a converted
// pin-locator@1 — never a 0.8.5 locator {mount, selector, text, ordinal}.
const resolverForm = (a) => isObj(a) && a.v === 1 && typeof a.kind === 'string';

// ── the modules this one reaches lazily ─────────────────────────────────────
let mods = null;
let loading = null;
function load() {
  if (!loading) {
    loading = Promise.all([
      import('./overlay.js'), import('./element-types.js'), import('./tools.js'), import('./shell.js'),
      import('./ws.js'), import('./topbar.js'), import('./mounts.js'), import('./bus.js'), import('./toolbar-state.js'),
    ]).then(([overlay, types, tools, shell, ws, topbar, mounts, bus, toolbar]) => {
      mods = { overlay, types, tools, shell, ws, topbar, mounts, bus: bus.bus, toolbar };
      return mods;
    });
  }
  return loading;
}
const readOnly = () => (mods ? mods.mounts.contentReadOnly() : !!view.previewing);
function note(text) {
  if (mods && text) mods.topbar.showReaimNote(text);
}

// ── pin mode: the comment tool in the one armed state ───────────────────────
let btn = null;
let inited = false;

// Arm (on) or put down (off) the comment tool. Arming goes through tools.js,
// which refuses it while a preview is shown (its read-only notice) or where
// tools need full access; putting it down leaves another armed tool alone.
export function setPinMode(on) {
  if (!mods) { load().then(() => setPinMode(on), (e) => console.error('[web-chat] comments: load failed', e)); return; }
  const a = mods.overlay.armed();
  const mine = !!(a && a.type === TYPE);
  if (on && !mine) mods.tools.armTool(TYPE);
  else if (!on && mine) mods.tools.disarm();
}

export function togglePinMode() {
  if (!mods) { load().then(() => togglePinMode(), (e) => console.error('[web-chat] comments: load failed', e)); return; }
  mods.tools.toggle(TYPE);
}

// body.pin-mode and the ✎ button's pressed look follow the one armed state.
function syncArmed() {
  const a = mods && mods.overlay.armed();
  const on = !!(a && a.type === TYPE);
  document.body.classList.toggle('pin-mode', on);
  if (btn) btn.classList.toggle('active', on);
}

// ── the records ─────────────────────────────────────────────────────────────
let liveComments = [];            // the live pins (a frame, a read, a write's answer)
let previewComments = new Map();  // id → pin, of the previewed node
let previewId = null;
const knownAnchors = new Map();   // id → the resolver-form anchor a read served (`record`)
let liveSeq = 0;                  // bumped by every frame and read: an older read's answer is dropped
let stale = false;                // a read asked for while hidden

// F13: apply a pushed `element:comment` frame — the live pins swapped and
// relayed to the overlay at once. Exported for ws.js.
export function applyCommentsFrame(comments) {
  liveSeq++;
  setLive(comments, { fromFrame: true });
}

// B4: has Claude replied in this pin's thread? The rail's dot goes green only
// then. Exported for queue.js, which derives the dot from the live pins.
export function isCommentAnswered(id) {
  const pin = liveComments.find((c) => c.id === id);
  return !!(pin && Array.isArray(pin.replies) && pin.replies.some((r) => r && r.author === 'claude'));
}

const answeredOf = (pin) => Array.isArray(pin.replies) && pin.replies.some((r) => isObj(r) && r.author === 'claude');

function setLive(list, { fromFrame = false } = {}) {
  liveComments = (Array.isArray(list) ? list : []).filter(validPin);
  for (const pin of liveComments) {
    if (resolverForm(pin.record)) knownAnchors.set(pin.id, pin.record);
    else if (resolverForm(pin.anchor)) knownAnchors.set(pin.id, pin.anchor);
  }
  const ids = new Set(liveComments.map((p) => p.id));
  for (const id of [...knownAnchors.keys()]) if (!ids.has(id)) knownAnchors.delete(id);
  relayLive({ fromFrame });
  retitle();
  refreshCards();
}

// The overlay row of a pin: its anchor in the resolver's form, its state.
function rowOf(pin, anchor) {
  return {
    id: pin.id, v: pin.v == null ? null : pin.v, type: TYPE,
    ...(typeof pin.schema === 'string' ? { schema: pin.schema } : {}),
    anchor, shared: pin.shared !== false,
    replies: Array.isArray(pin.replies) ? pin.replies.length : 0, answered: answeredOf(pin),
  };
}
const sameRow = (a, b) => !a.pending && a.v === b.v && a.shared === b.shared && a.replies === b.replies
  && !!a.answered === !!b.answered && JSON.stringify(a.anchor) === JSON.stringify(b.anchor);

// The overlay's live comment rows brought to match the live pins: new or
// changed ones upserted, nothing touched otherwise; and, for a frame (the
// whole live set), the rows it lacks removed.
function relayLive({ fromFrame = false } = {}) {
  if (!mods) return;
  const ov = mods.overlay;
  const have = new Map(ov.elementsOf('live').filter((r) => r.type === TYPE).map((r) => [r.id, r]));
  const fresh = [];
  let unknown = false;
  for (const pin of liveComments) {
    const prior = have.get(pin.id);
    let anchor;
    if (resolverForm(pin.anchor)) anchor = pin.anchor;
    else if (knownAnchors.has(pin.id)) anchor = knownAnchors.get(pin.id);
    else if (pin.anchor == null) anchor = null;                       // a page note: drawn nowhere on the page
    else if (prior && prior.anchor) anchor = prior.anchor;            // the lean projection's (a migrated pin)
    else { unknown = true; continue; }                                // a 0.8.5 locator: a read serves `record`
    const row = rowOf(pin, anchor);
    if (prior && sameRow(prior, row)) continue;
    fresh.push(row);
  }
  const ids = new Set(liveComments.map((p) => p.id));
  const gone = fromFrame ? [...have.keys()].filter((id) => !ids.has(id)) : [];
  if (gone.length) ov.removeElements('live', gone);
  if (fresh.length) ov.upsertElements('live', fresh);
  // Only a frame asks: a read's answer never starts another read.
  if (unknown && fromFrame) refresh();
}

// One record the daemon answered a write with; or one it removed.
function applyOne(pin) {
  if (!validPin(pin)) return;
  const list = liveComments.filter((c) => c.id !== pin.id);
  list.push(pin);
  liveSeq++;
  setLive(list);
}
function dropOne(id) {
  liveSeq++;
  setLive(liveComments.filter((c) => c.id !== id));
  if (mods) mods.overlay.removeElements('live', [id]);
}

// The live pins, read once. Put off while the tab is hidden.
async function refresh() {
  if (isHidden()) { stale = true; return; }
  stale = false;
  const mine = ++liveSeq;
  const r = await request('GET', `${ELEMENTS_PATH}?type=${TYPE}`);
  if (mine !== liveSeq || !r.ok || !r.body || !Array.isArray(r.body.elements)) return;
  setLive(r.body.elements);
}
function onVisibility() {
  if (!isHidden() && stale) refresh();
}

// A previewed node: its pins' records (their text and replies) for its threads.
// Its markers are the overlay's (the node's lean_elements).
async function onPreview(d) {
  const id = d && d.id != null ? String(d.id) : null;
  previewId = id;
  previewComments = new Map();
  if (!id) return;
  const r = await request('GET', `${ELEMENTS_PATH}?type=${TYPE}&node=${encodeURIComponent(id)}`);
  if (previewId !== id || !view.previewing || !r.ok || !r.body || !Array.isArray(r.body.elements)) return;
  previewComments = new Map(r.body.elements.filter(validPin).map((p) => [p.id, p]));
  retitle();
}
function onView() {
  if (!view.previewing) { previewId = null; previewComments = new Map(); }
}

// The pin `id` names in the set the page draws now.
function recordOf(id) {
  const scope = mods ? mods.overlay.drawnScopeOf() : (view.previewing ? 'preview' : 'live');
  if (scope === 'preview') return previewComments.get(String(id)) || null;
  return liveComments.find((c) => c.id === String(id)) || null;
}

// ── the marker ──────────────────────────────────────────────────────────────
// A 26px map-pin glyph (the overlay's MARKER_GLYPH box, its tip at the anchor):
// currentColor with a panel-bg hole, so it reads as a pin in any theme.
const PIN_SVG = '<svg viewBox="0 0 16 16" width="26" height="26" aria-hidden="true">'
  + '<path d="M8 1.4c-2.5 0-4.4 2-4.4 4.4 0 3.2 4.4 8.8 4.4 8.8s4.4-5.6 4.4-8.8C12.4 3.4 10.5 1.4 8 1.4z" fill="currentColor"/>'
  + '<circle cx="8" cy="5.8" r="1.55" style="fill:var(--wc-panel-bg)"/></svg>';
const marks = new Set();          // the containers this type drew

function titleOf(ids) {
  return ids.map((id) => {
    const p = recordOf(id);
    return p ? (p.shared === false ? '(private) ' : '') + (p.text || '') : '';
  }).filter(Boolean).join('  •  ');
}
// The overlay hands the group the pins resolved to one element (or a section,
// or a carried guess). Rows carry shared and answered (the lean projection's,
// or this module's relay), so the colour needs no record.
function draw(group) {
  const c = group.container;
  if (!c) return;
  const items = Array.isArray(group.items) ? group.items : [];
  const rows = items.map((it) => it.row || {});
  const anyShared = rows.some((r) => r.shared !== false);
  const answered = rows.some((r) => r.shared !== false && r.answered);
  c.classList.add('pin-marker');
  if (!anyShared) c.classList.add('private');
  else if (answered) c.classList.add('replied');
  c.innerHTML = PIN_SVG + (items.length > 1 ? '<span class="pin-count">' + items.length + '</span>' : '');
  c._commentIds = items.map((it) => String(it.id));
  c.title = titleOf(c._commentIds);
  c.setAttribute('role', 'button');
  c.setAttribute('aria-label', items.length > 1 ? `${items.length} comments` : 'Comment');
  marks.add(c);
  // A carried guess's click is the overlay's (its re-anchor seam, orphans.js):
  // only a pin drawn where it belongs opens its thread here.
  if (group.kind === 'guess') return;
  c.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openPinMenu(c._commentIds, ev.clientX, ev.clientY);
  });
}
// A record's text arrived after its marker was drawn (a read after the hello).
function retitle() {
  for (const c of [...marks]) {
    if (!c.isConnected) { marks.delete(c); continue; }
    if (c._commentIds) c.title = titleOf(c._commentIds);
  }
}

// ── create: the tool's tap ──────────────────────────────────────────────────
const cssEsc = (s) => ((typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') ? CSS.escape(s) : s);
// The legacy locator get_comments' anchor_label reads: the element's own tag and
// classes (CSS.escape each, so Tailwind-style tokens stay queryable), its index
// among the pane's matches, its text.
function locatorOf(target, root, mount) {
  const tag = target.tagName ? target.tagName.toLowerCase() : '*';
  const classes = target.classList ? [...target.classList].map(cssEsc) : [];
  const selector = tag + (classes.length ? '.' + classes.join('.') : '');
  let ordinal = 0;
  try { ordinal = Math.max(0, [...root.querySelectorAll(selector)].indexOf(target)); } catch { ordinal = 0; }
  return { mount, selector, text: (target.textContent || '').trim().slice(0, 120), ordinal };
}

// The overlay calls this with the click of a gesture the policy gave the tool.
function create(input, ctx) {
  if (readOnly()) { note(mods && mods.topbar.READONLY_HINT); return; }
  if (!input || input.phase !== 'click') return;
  const { mount, root, target } = input;
  if (mount == null || !root || root === document || !target || target.nodeType !== 1) return;
  const A = (ctx && ctx.anchors) || (window.__wcMount && window.__wcMount.anchor) || null;
  let record = null;
  try { record = A && typeof A.record === 'function' ? A.record(root, target, { mount }) : null; } catch { record = null; }
  openComposer({ record, locator: locatorOf(target, root, mount) }, input.clientX, input.clientY);
}

async function postPin(spot, text, shared) {
  const body = { type: TYPE, anchor: spot.record || spot.locator, payload: { text, shared } };
  if (spot.record) body.locator = spot.locator;
  const r = await request('POST', ELEMENTS_PATH, { body, device: true });
  if (!r.ok) { note(r.hint); return; }
  const pin = r.body && (r.body.element || r.body.pin);
  if (validPin(pin)) applyOne(pin); else refresh();
}

/* ── the pin popover (composer / chooser / thread) ──────────────────────────
   Dismissal is the shell's ONE dismiss layer: shell.js registers `.pin-pop`
   (registerPopover), so an outside press, a focus move out of it, another
   panel opening, a window blur or Escape remove it like every other chrome
   panel. What stays here is only what the shell cannot know: the F12 rule that
   the first Escape in a non-empty reply draft blurs rather than closes. */
let pop = null;
function closePop() {
  if (pop) { pop.remove(); pop = null; }
}
export function closePinPop() { closePop(); }
function openPop(el, x, y, w, h) {
  closePop();
  pop = el;
  document.body.appendChild(el);
  // Viewport coordinates from the click; .pin-pop stays position:fixed.
  el.style.left = Math.max(8, Math.min(x || 0, window.innerWidth - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y || 0, window.innerHeight - h - 8)) + 'px';
}

// Where a pin sits, as the design's breadcrumb — "open-questions › item 2":
// the block (mount id), then the element's own text, or its tag when it has
// none. Escaped: the mount id is agent-supplied and the text is the pane's.
function anchorPath(a, max) {
  const mount = esc((a && a.mount) || 'block');
  const text = a && typeof a.text === 'string' ? a.text : '';
  const tail = text
    ? (text.length > max ? text.slice(0, max) + '…' : text)
    : String((a && a.selector) || '').split('.')[0];
  return mount + (tail ? '<span class="pin-path-sep"> › </span>' + esc(tail) : '');
}
// The locator a pin's breadcrumb reads: the legacy locator it carries, or its
// anchor's own fields (an engine record names its mount and its head).
function locatorOfPin(pin) {
  if (isObj(pin.locator)) return pin.locator;
  const a = pin.anchor;
  if (!isObj(a)) return null;
  if (typeof a.selector === 'string') return a;
  const text = a.fp && typeof a.fp.head === 'string' ? a.fp.head
    : a.fingerprint && typeof a.fingerprint.text === 'string' ? a.fingerprint.text
      : a.quote && typeof a.quote.exact === 'string' ? a.quote.exact : '';
  return { mount: a.mount != null ? a.mount : a.md, text, selector: (a.path && a.path.selector) || (a.fp && a.fp.tag) || '' };
}

function openComposer(spot, x, y) {
  let shared = true;
  try {
    const a = mods.overlay.armed();
    const s = mods.toolbar.settingsOf(TYPE, a && a.type === TYPE ? a.profile : undefined) || {};
    shared = s.shared !== false;
  } catch { shared = true; }
  const el = document.createElement('div');
  el.className = 'popover pin-pop';
  el.innerHTML =
    '<div class="pin-anchor">' + anchorPath(spot.locator, 40) + '</div>'
    + '<textarea class="pin-text" rows="3" placeholder="Comment…"></textarea>'
    + '<label class="pin-share"><input type="checkbox" class="pin-share-cb"' + (shared ? ' checked' : '') + '> Share with Claude</label>'
    + '<div class="pin-actions"><button class="pin-cancel">Cancel</button><button class="pin-save">Pin</button></div>';
  openPop(el, x, y, 264, 156);
  const ta = el.querySelector('.pin-text');
  ta.focus();
  // The composer's own Escape: shell.js stands down for a focused editable, so
  // the field owns the key.
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    closePop();
    setPinMode(false);
  });
  el.querySelector('.pin-cancel').addEventListener('click', closePop);
  el.querySelector('.pin-save').addEventListener('click', () => {
    const text = ta.value.trim();
    const share = el.querySelector('.pin-share-cb').checked;
    closePop();
    setPinMode(false);
    if (readOnly()) { note(mods.topbar.READONLY_HINT); return; }
    postPin(spot, text, share).catch((e) => console.error('[web-chat] comments: the pin was not sent', e));
  });
}

// A pin's thread as message rows: the root note (a user message) then each reply.
function threadMessages(pin) {
  const msgs = [{ author: 'user', text: pin.text || '' }];
  for (const r of (Array.isArray(pin.replies) ? pin.replies : [])) msgs.push(r);
  return msgs;
}

// A marker click opens the thread(s) it stands for — one pin opens its thread,
// a grouped marker opens a chooser.
function openPinMenu(ids, x, y) {
  const pins = ids.map(recordOf).filter(Boolean);
  if (!pins.length) { if (!view.previewing) refresh(); return; }
  if (pins.length > 1) openThreadChooser(pins, x, y);
  else openThread(pins[0].id, x, y);
}

function openThreadChooser(pins, x, y) {
  const el = document.createElement('div');
  el.className = 'popover pin-pop pin-chooser';
  el.innerHTML = '<div class="pin-anchor">' + pins.length + ' comments here</div>'
    + pins.map((p) => {
      const n = Array.isArray(p.replies) ? p.replies.length : 0;
      return '<button class="pin-thread-row" data-id="' + esc(p.id) + '">'
        + '<span class="ptr-dot' + (answeredOf(p) ? ' answered' : '') + (p.shared === false ? ' private' : '') + '"></span>'
        + '<span class="ptr-text">' + esc((p.text || '(no comment)').slice(0, 60)) + '</span>'
        + (n ? '<span class="ptr-n">' + n + '</span>' : '') + '</button>';
    }).join('');
  openPop(el, x, y, 288, 44 + pins.length * 34);
  el.querySelectorAll('.pin-thread-row').forEach((row) =>
    row.addEventListener('click', () => openThread(row.dataset.id, x, y)));
}

// The Google-Docs-style thread: anchor, the message stack (you / Claude), and a
// reply box that posts a USER reply (which enqueues so Push continues the
// thread). On a previewed node: the messages and the read-only hint, nothing
// that writes.
function openThread(id, x, y) {
  const pin = recordOf(id);
  if (!pin) { closePop(); return; }
  const ro = readOnly();
  const el = document.createElement('div');
  el.className = 'popover pin-pop pin-thread' + (ro ? ' pin-readonly' : '');
  el.dataset.id = pin.id;
  const msgs = threadMessages(pin).map((m) =>
    '<div class="pin-msg ' + (m.author === 'claude' ? 'claude' : 'user') + '">'
    + '<div class="pin-who">' + (m.author === 'claude' ? 'Claude' : 'You') + '</div>'
    + '<div class="pin-body">' + esc(m.text || '') + '</div></div>').join('');
  el.innerHTML =
    '<div class="pin-anchor">' + anchorPath(locatorOfPin(pin), 32) + '</div>'
    + '<div class="pin-thread-msgs">' + msgs + '</div>'
    + (ro
      ? '<div class="pin-reply-err pin-ro-hint">' + esc(mods ? mods.topbar.READONLY_HINT : '') + '</div>'
      : '<div class="pin-reply"><textarea class="pin-reply-text" rows="2" placeholder="Reply…"></textarea>'
        + '<div class="pin-actions"><label class="pin-share" title="Claude reads only shared comments (get_comments)">'
        + '<input type="checkbox" class="pin-share-cb" ' + (pin.shared !== false ? 'checked' : '') + '> Shared with Claude</label>'
        + '<span class="pin-spacer"></span>'
        + '<button class="pin-del" title="Delete this comment">Delete</button>'
        + '<button class="pin-reply-send" title="Send reply (↵)">Send</button></div></div>');
  openPop(el, x, y, 300, 260);
  if (ro) return;
  // A write asked for once a preview has started is refused with the hint.
  const refused = () => {
    if (!readOnly()) return false;
    note(mods.topbar.READONLY_HINT);
    return true;
  };
  const ta = el.querySelector('.pin-reply-text');
  ta.focus();
  const send = async () => {
    const text = ta.value.trim();
    if (!text || refused()) return;
    const old = el.querySelector('.pin-reply-err');
    if (old) old.remove();
    const r = await request('POST', `${ELEMENTS_PATH}/${encodeURIComponent(pin.id)}/reply`,
      { body: { text, author: 'user' }, device: true });
    const next = r.ok && r.body ? (r.body.element || r.body.pin) : null;
    // F10: only a confirmed answer with the pin clears the draft (the re-render
    // below). A refusal or a network failure keeps the typed reply and says so.
    if (!validPin(next)) {
      const err = document.createElement('div');
      err.className = 'pin-reply-err';
      err.textContent = 'Reply failed — draft kept. Try again.';
      el.querySelector('.pin-reply').appendChild(err);
      return;
    }
    applyOne(next);
    openThread(pin.id, x, y); // the thread again, in place, with the new message
  };
  el.querySelector('.pin-reply-send').addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    // F12: the first Escape only blurs a non-empty draft; the next one — focus
    // now off the field — reaches the shell's dismiss layer.
    if (ta.value.trim()) { ta.blur(); return; }
    // An empty draft closes here, so this handler also owes what the shell's
    // Escape would have done: leave pin mode.
    closePop();
    setPinMode(false);
  });
  el.querySelector('.pin-share-cb').addEventListener('change', async (ev) => {
    if (refused()) { ev.target.checked = !ev.target.checked; return; }
    const r = await request('PATCH', `${ELEMENTS_PATH}/${encodeURIComponent(pin.id)}`,
      { body: { shared: ev.target.checked }, device: true });
    const next = r.ok && r.body ? (r.body.element || r.body.pin) : null;
    if (validPin(next)) applyOne(next);
    else if (!r.ok) note(r.hint);
    else refresh();
  });
  el.querySelector('.pin-del').addEventListener('click', async () => {
    if (refused()) return;
    closePop();
    const r = await request('DELETE', `${ELEMENTS_PATH}/${encodeURIComponent(pin.id)}`, { body: {}, device: true });
    if (r.ok) dropOne(pin.id); else note(r.hint);
  });
}

// ── the rail's card (K.2-11) ────────────────────────────────────────────────
// Where a pin is on the page now: its marker's element, else its pane.
export function showOnPage(id, mount) {
  for (const c of [...marks]) {
    if (!c.isConnected || !c._commentIds || !c._commentIds.includes(String(id))) continue;
    const g = c._group;
    const at = g && (g.el || (g.range && g.range.startContainer && g.range.startContainer.parentElement));
    if (at && typeof at.scrollIntoView === 'function') { at.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true; }
  }
  if (mount != null && mods && mods.mounts.revealPane(String(mount))) return true;
  note(GONE_HINT);
  return false;
}
const cardSlots = new Set();
function renderCard(item, slot) {
  cardSlots.add(slot);
  slot._commentItem = item;
  slot.replaceChildren();
  const id = item.comment_id == null ? '' : String(item.comment_id);
  const pin = liveComments.find((c) => c.id === id) || null;
  const loc = pin ? locatorOfPin(pin) : null;
  const line = document.createElement('div');
  line.className = 'cm-card';
  const where = document.createElement('span');
  where.className = 'cm-card-where pin-anchor';
  if (loc) where.innerHTML = anchorPath(loc, 40);
  else where.textContent = item.summary ? String(item.summary) : 'Comment';
  line.appendChild(where);
  const n = pin && Array.isArray(pin.replies) ? pin.replies.length : 0;
  const count = document.createElement('span');
  count.className = 'cm-card-replies';
  count.textContent = n === 1 ? '1 reply' : `${n} replies`;
  line.appendChild(count);
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'cm-card-show';
  show.textContent = 'Show on page';
  const mount = (loc && loc.mount != null ? loc.mount : null) || item.origin_mount || null;
  show.addEventListener('click', () => showOnPage(id, mount));
  line.appendChild(show);
  slot.appendChild(line);
}
// A pin's replies or place changed: the cards on the rail redraw in place.
function refreshCards() {
  for (const slot of [...cardSlots]) {
    if (!slot.isConnected) { cardSlots.delete(slot); continue; }
    if (slot._commentItem) renderCard(slot._commentItem, slot);
  }
}

// ── init ────────────────────────────────────────────────────────────────────
// initComments() wires ✎, then (the modules loaded) the type, its card and the
// record inputs. Idempotent; no timer of any kind.
export function initComments() {
  if (inited) return;
  inited = true;
  btn = $('btn-pin-mode');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); togglePinMode(); });
  document.addEventListener('visibilitychange', onVisibility);
  load().then((m) => {
    m.types.registerElementType(TYPE, { draw, create, input: 'taps' });
    m.shell.registerQueueCard(TYPE, { render: renderCard, unmount: (slot) => { cardSlots.delete(slot); slot._commentItem = null; } });
    m.overlay.onArmedChange(syncArmed);
    syncArmed();
    m.ws.onHello(() => { refresh(); });
    m.ws.onFrame('reset', () => { refresh(); });
    m.bus.on('preview:node', (d) => { onPreview(d).catch((e) => console.error('[web-chat] comments: the preview read failed', e)); });
    m.bus.on('view', onView);
    relayLive();
    refresh();
  }).catch((e) => console.error('[web-chat] comments: the comment type could not start', e));
}

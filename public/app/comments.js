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
// THE DRAW. registerElementType('comment', {draw, create, input: 'taps',
// sourceGlyph}) (element-types.js: the reads gate runs the draw; never
// registerType). The
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
// with the tool still armed (D1 b). create() records the tap's anchor — a
// point on a fixed-aspect target (U532), a range over the word under a tap in
// text (anchors.recordRange over highlight.js snapRange's word, H.8, U588),
// else the tapped element (anchors.record) — and the legacy locator {mount,
// selector, text, ordinal} of the tapped element beside it, then opens the
// composer; Pin posts
// {type: 'comment', anchor, locator, payload: {text, shared}, device}. The
// type's targets are the default 'items' (F.3, RULED M3 (a)): a tap on a pane's
// content or on a markdown item's block (a heading, a paragraph, a list item, a
// quote, a code block) is the tool's; a tap on the chrome inside #main (a
// pane's header controls, the run controls, the Contents nav, a gap between
// blocks) passes through to the page with the tool still armed (the overlay's
// dispatch, K.2-78 (c)). M3's trade-off: a link in prose pins instead of
// following (the pointer button, C and Space put the tool down).
//
// A PIN ON MARKDOWN (F.3) is "about this section": create() records a source
// anchor over the tapped block (anchors.recordSource over the item's text and
// sourceMap, clamped at CONFIG.quote_max rendered characters, once more at
// SOURCE_RETRY_CHARS when the source span is still over the cap, else a hint
// and no pin — never a whole-item anchor) and the locator {mount: <md id>,
// selector: <the block's tag>, text, ordinal, section: <the heading>} beside
// it, which get_comments' label and the queue summary read as `on section
// "<heading>"`. Its marker sits in the item's left margin (SOURCE_GLYPH, the
// overlay's margin glyph); Show on page falls back to page.js revealMarkdown.
//
// THE CHAIN (F.6, U406; RULED L7 (a), O5 (a) "chain"): no control. create()
// asks the overlay for the live elements under the press (overlay.js
// elementsAt: a highlight, a box grab, another comment — every type it draws,
// never a list here), smallest first, keeps at most CHAIN_MAX of them and
// posts their ids as payload.chain; the daemon validates each (a live
// element) and records a comment@2 version. The composer's, the thread's and
// the marker title's anchor line name the chain smallest first ("on highlight
// h7 › box grab g3"), a member no longer on the page as "a removed highlight
// h7" (no silent detach: the comment's own anchor still resolves on its own).
// The pane and section levels are get_comments' chain_label (the daemon's,
// derived at read time); the chrome shows the members only.
//
// PREVIEWS ARE READ-ONLY (D2). A previewed older node draws its own pins (the
// overlay's preview set, from the node's lean_elements; their threads from one
// GET ?type=comment&node=<id>), and a thread opened there shows its messages
// and READONLY_HINT, with no reply, share or delete; nothing is created there.
// The rule is element-types.js's tray action guard (TRAY@guard): the tool's
// create, the composer's Pin, and the thread's reply, share, Delete and Send
// to Claude each run through trayAction, and the thread draws its read-only
// branch by trayReadOnly() — one rule, one hint, no check of this module's.
//
// SEND TO CLAUDE (F.5, M2 (a)). The thread's .pin-actions carry Send to
// Claude beside Delete, at canWrite only (element-types.js maySend): one tap
// shares a private pin and queues it, or queues a shared one that is not
// queued (element-types.js sendToClaude); Push still decides when.
// Documents (a preview document, an export, a replay) draw no pin (F-DOCS a).
//
// THE CHAT PIN (3C.1, U434; RULED CHAT@type a, REQ@chat-pin-kinds L1 a,
// REQ@chat-pin-hosts L2 a, M2 a, Q5 a). The one Comment tool also records a
// chat-comment: the chat layer (chat-pins.js, U432) registers the type on the
// overlay's 'chat' host with this tool, and this module hands it its create
// and its marker's open through registerChatPinActions — one thread engine,
// two types. A press in the chat (the dock, docked or windowed, and the phone
// sheet; never a frame, never the inspector) reaches createChat under the
// same input-mode policy as on the page, and the target names the kind:
//   a tool card's [data-item-id]                     → item
//   a prompt, reply or thinking's [data-item-id] with a non-collapsed
//     selection of its text holding the press      → item-range, its pos from
//     anchors.recordSource over the item's element and its text (the reply's
//     sourceMap(text, {flavor: 'chat'}), the identity map for a prompt or a
//     thought: the chat layer's own placement), else  → item
//   a .dl line of the turn's open diff view          → diff-line
//   the turn root outside every item                 → turn
// What is posted is a LOCATOR ({kind, conversation_id, session_id?, turn_id,
// item_id?, field?, pos?, file?, side?, line?}): the daemon takes the quote
// and the fingerprint from served, masked text (D4), never the chrome's. The
// composer is the comment's (its .pin-anchor line names the chat place, then
// the chain of the chat elements under the press, elementsAt(x, y, {host:
// 'chat'})); Pin posts {type: 'chat-comment', anchor, payload: {text, shared,
// chain}} and keeps the composer open with its draft when the daemon refuses
// (a 409 provisional target's hint in its .pin-reply-err line, F10). The
// marker's click opens the same thread (recordOf reads chat-pins chatPinOf),
// whose answers apply through applyChatPin / dropChatPin; its writes go
// through the same tray action guard, so a previewed node leaves it read-only
// with READONLY_HINT (Q5). The marker's title is the chat layer's explain
// line; the comment's text is shown only in the thread.
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
import { view } from './state.js';
import { esc } from './esc.js';
import { request } from './http.js';

export const TYPE = 'comment';
export const ELEMENTS_PATH = '/api/elements';
export const GONE_HINT = 'That comment is not on the page now.';
export const TOO_LONG_HINT = 'That block is too long to pin a comment on: pin its heading or a shorter paragraph.';
// The retry's span when a block's source span is over the cap (F.3).
export const SOURCE_RETRY_CHARS = 240;
// A markdown pin's glyph offsets from the item's left edge at the block's
// first line: the 26px pin wholly in the gutter, its top level with the line.
export const SOURCE_GLYPH = Object.freeze({ dx: -27, dy: -4 });
// The most elements a comment's chain names: lib/core/element-log CHAIN_MAX,
// which the daemon checks (test/comments-overlay-chrome.test.js holds the two
// equal; the chrome cannot import the node-only log).
export const CHAIN_MAX = 8;
// The chat pin's type (chat-pins.js CHAT_TYPE, which a test holds equal: this
// module reaches the chat layer lazily).
export const CHAT_TYPE = 'chat-comment';
// The composer's line for a press the daemon refused, when it sent no hint.
export const CHAT_REFUSED_HINT = 'That chat pin was not made — draft kept. Try again.';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const validPin = (p) => isObj(p) && typeof p.id === 'string' && p.id !== '' && (p.type == null || p.type === TYPE);
const validChat = (p) => isObj(p) && typeof p.id === 'string' && p.id !== '' && (p.type == null || p.type === CHAT_TYPE);
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
      import('./page.js'), import('./chat-pins.js'), import('./chat-state.js'),
    ]).then(([overlay, types, tools, shell, ws, topbar, mounts, bus, toolbar, page, chat, chatState]) => {
      mods = { overlay, types, tools, shell, ws, topbar, mounts, bus: bus.bus, toolbar, page, chat, chatState };
      return mods;
    });
  }
  return loading;
}
function note(text) {
  if (mods && text) mods.topbar.showReaimNote(text);
}

// ── pin mode: the comment tool in the one armed state ───────────────────────
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

// body.pin-mode follows the one armed state (the toolbar's slot draws its own
// armed look, U338).
function syncArmed() {
  const a = mods && mods.overlay.armed();
  const on = !!(a && a.type === TYPE);
  document.body.classList.toggle('pin-mode', on);
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
// then. Exported for queue.js, which derives the dot from the live pins — the
// ONE answered lookup for both families (K.2-164): a page comment's from the
// live pins here, a chat pin's (type 'chat-comment', or an id no page pin
// holds) from the chat layer's records (chat-pins.js chatPinOf, once it is
// loaded: queue.js imports this module and no-DOM tests import queue.js, so
// the chat layer is reached lazily).
export function isCommentAnswered(id, type) {
  const key = String(id);
  if (type !== CHAT_TYPE) {
    const pin = liveComments.find((c) => c.id === key);
    if (pin || type === TYPE) return !!(pin && answeredOf(pin));
  }
  const hit = mods && mods.chat ? mods.chat.chatPinOf(key) : null;
  return !!(hit && hit.record && answeredOf(hit.record));
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

// The overlay row of a pin: its anchor in the resolver's form, its state —
// and, for a pin the daemon served masked (its words hold a learned value,
// U415c), the served answer {state, visible, explain}, which beats the page
// resolver's own for it (overlay.js servedAnswerOf; X3, U415d).
function rowOf(pin, anchor) {
  const answer = mods ? mods.overlay.servedAnswerOf(pin) : null;
  return {
    id: pin.id, v: pin.v == null ? null : pin.v, type: TYPE,
    ...(typeof pin.schema === 'string' ? { schema: pin.schema } : {}),
    anchor, shared: pin.shared !== false,
    replies: Array.isArray(pin.replies) ? pin.replies.length : 0, answered: answeredOf(pin),
    ...(answer ? { answer } : {}),
  };
}
const sameRow = (a, b) => !a.pending && a.v === b.v && a.shared === b.shared && a.replies === b.replies
  && !!a.answered === !!b.answered && JSON.stringify(a.anchor) === JSON.stringify(b.anchor)
  && JSON.stringify(a.answer || null) === JSON.stringify(b.answer || null);

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

// A chat pin's record (the chat layer's: drawn in either scope, C1), or null.
function chatRecordOf(id) {
  const hit = mods && mods.chat ? mods.chat.chatPinOf(String(id)) : null;
  return hit && validChat(hit.record) ? hit.record : null;
}
// The chat anchor kinds (chat-pins.js KINDS, held equal by a test).
export const CHAT_KINDS = Object.freeze(['turn', 'item', 'item-range', 'diff-line']);
const isChatPin = (pin) => !!pin && (pin.type === CHAT_TYPE || (isObj(pin.anchor) && CHAT_KINDS.includes(pin.anchor.kind)));

// The pin `id` names in the set the page draws now (a chat pin's from the
// chat layer, U432's chatPinOf).
function recordOf(id) {
  const chat = chatRecordOf(id);
  if (chat) return chat;
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
    if (!p) return '';
    const chain = chainLabel(p.chain);
    // A pin served masked shows its state's one line (anchor-states EXPLAIN,
    // the daemon's), never a wording of this file's.
    const masked = mods && mods.overlay.servedAnswerOf(p);
    return (p.shared === false ? '(private) ' : '') + (p.text || '') + (chain ? ` (${chain})` : '')
      + (masked && masked.explain ? ` — ${masked.explain}` : '');
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

// ── the chain (F.6) ─────────────────────────────────────────────────────────
// id → the type last seen for it (the pick's answer, a live row), so a member
// that has left the page is still named by its type.
const chainTypes = new Map();
const typeWords = (t) => String(t).replace(/-/g, ' ');
// What the drawn set holds of `id` now: its type, or null when it is gone.
function memberType(id) {
  if (chatRecordOf(id)) return CHAT_TYPE;
  const scope = mods ? mods.overlay.drawnScopeOf() : (view.previewing ? 'preview' : 'live');
  if (scope === 'live' ? liveComments.some((c) => c.id === id) : previewComments.has(id)) return TYPE;
  const row = mods ? mods.overlay.elementsOf(scope).find((r) => r.id === id) : null;
  return row ? (row.type || 'element') : null;
}
// The chain's label, smallest first: "on highlight h7 › box grab g3", a member
// gone from the page "a removed highlight h7", and a null member — a private
// one, to a viewer that does not see private records (remote-policy
// dropPrivate; Q8 a) — "a private element", as the daemon's chain_label reads
// it. '' for no chain.
function chainLabel(ids) {
  if (!Array.isArray(ids) || !ids.length) return '';
  const parts = ids.filter((id) => id === null || (typeof id === 'string' && id)).map((id) => {
    if (id === null) return 'a private element';
    const t = memberType(id);
    if (t) { chainTypes.set(id, t); return `${typeWords(t)} ${id}`; }
    return `a removed ${typeWords(chainTypes.get(id) || 'element')} ${id}`;
  });
  return parts.length ? 'on ' + parts.join(' › ') : '';
}
// The anchor line's chain, after the breadcrumb ('' for no chain).
function chainHtml(ids) {
  const label = chainLabel(ids);
  return label ? '<span class="pin-path-sep"> · </span><span class="pin-chain">' + esc(label) + '</span>' : '';
}
// The live elements under a press, smallest first (overlay.js elementsAt):
// their ids, each once, at most CHAIN_MAX. In the chat (`host` 'chat'), the
// chat host's own drawn elements (U431's host reading of U406's export).
function chainAt(x, y, host) {
  if (!mods || typeof mods.overlay.elementsAt !== 'function') return [];
  const out = [];
  let hits = [];
  try { hits = host ? mods.overlay.elementsAt(x, y, { host }) : mods.overlay.elementsAt(x, y); } catch { hits = []; }
  for (const h of Array.isArray(hits) ? hits : []) {
    if (!h || typeof h.id !== 'string' || !h.id || !h.type || out.includes(h.id)) continue;
    chainTypes.set(h.id, h.type);
    out.push(h.id);
    if (out.length >= CHAIN_MAX) break;
  }
  return out;
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
  mods.types.trayAction(() => createLive(input, ctx), { note });
}
// A tap's point (4C.1; DECISIONS.md C5): on a fixed-aspect target — an img, a
// canvas, the outermost svg, a data-fixed-aspect element — found by the one
// target-frame walk (anchors targetFrame, U531), the point record and the
// TARGET's 0.8.5 locator; null on any refusal (not a target, no box, outside
// the box), and the tap takes the conversion at creation below.
function pointOf(A, input, root, target, mount) {
  if (!A || typeof A.targetFrame !== 'function' || typeof A.recordPoint !== 'function') return null;
  const x = input.clientX;
  const y = input.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    const frame = A.targetFrame(root, target, { mount });
    if (!frame || frame.refused) return null;
    const record = A.recordPoint(root, target, x, y, { mount });
    if (!record || record.refused) return null;
    return { record, locator: locatorOf(frame.target, root, mount) };
  } catch { return null; }
}
function createLive(input, ctx) {
  if (!input || input.phase !== 'click') return;
  if (input.md != null) { createOnMarkdown(input, ctx); return; }
  const { mount, root, target } = input;
  if (mount == null || !root || root === document || !target || target.nodeType !== 1) return;
  const A = (ctx && ctx.anchors) || (window.__wcMount && window.__wcMount.anchor) || null;
  const chain = chainAt(input.clientX, input.clientY);
  const point = pointOf(A, input, root, target, mount);
  if (point) { openComposer({ record: point.record, locator: point.locator, chain }, input.clientX, input.clientY); return; }
  // THE CONVERSION AT CREATION (C5): a tap that is no point — on text or a
  // control — is never a raw point over a reflowing box. A tap in text takes a
  // range over the word under it (H.8, U588); a control, an image, a tap where
  // no caret is found and a word recordRange refuses take the element. The
  // legacy locator stays the tapped element's either way.
  const x = input.clientX;
  const y = input.clientY;
  const element = () => {
    try { return A && typeof A.record === 'function' ? A.record(root, target, { mount }) : null; } catch { return null; }
  };
  const open = (record) => openComposer({ record: record || element(), locator: locatorOf(target, root, mount), chain }, x, y);
  const seed = A && typeof A.recordRange === 'function' ? textSeedAt(root, target, x, y) : null;
  if (!seed) { open(null); return; }
  if (snapMod) { open(wordRecord(A, snapMod, root, seed, mount, x, y)); return; }
  return loadSnap().then((hl) => open(wordRecord(A, hl, root, seed, mount, x, y)), () => open(null));
}

// ── a pin on a word (H.8, U588; DECISIONS.md K.2-169) ──────────────────────
// What never takes a word: a control (the tap is about the control) and an
// image (U532's point, or the element when the point refused).
export const CONTROL_TARGETS = 'button,input,select,textarea,a,label,[role="button"],[contenteditable]:not([contenteditable="false"])';
export const IMAGE_TARGETS = 'img,svg,canvas,video,picture';
// The geometry walk's bound: the most words it measures for one tap.
export const WORD_WALK_MAX = 4000;
// highlight.js's snapRange — THE word snap — loaded at first use through a
// relative dynamic import: a static one would put highlight.js (and the
// overlay it imports) on queue.js's no-DOM import chain.
let snapMod = null;
let snapLoading = null;
function loadSnap() {
  if (!snapLoading) {
    snapLoading = import('./highlight.js').then((m) => { snapMod = m; return m; }, (e) => { snapLoading = null; throw e; });
  }
  return snapLoading;
}
const NON_SPACE = /\S/;
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
// The character a caret at `offset` of a text node stands beside, as a Range:
// the one after it, else the one before (a caret past a word's last letter),
// a surrogate pair whole; null in whitespace. (A collapsed range is no seed:
// snapRange keeps one at a word's edge collapsed.)
function charRange(doc, node, offset) {
  const s = node.data;
  const o = Math.max(0, Math.min(offset, s.length));
  let a;
  if (o < s.length && NON_SPACE.test(s[o])) a = o;
  else if (o > 0 && NON_SPACE.test(s[o - 1])) a = o - 1;
  else return null;
  if (isLow(s.charCodeAt(a)) && a > 0 && isHigh(s.charCodeAt(a - 1))) a--;
  const b = a + (isHigh(s.charCodeAt(a)) && isLow(s.charCodeAt(a + 1)) ? 2 : 1);
  const r = doc.createRange();
  r.setStart(node, a);
  r.setEnd(node, b);
  return r;
}
const holdsPoint = (b, x, y) => {
  const right = b.right != null ? b.right : b.left + b.width;
  const bottom = b.bottom != null ? b.bottom : b.top + b.height;
  return x >= b.left && x <= right && y >= b.top && y <= bottom;
};
// A range's client rects, or null where the browser gives none to read.
function rectsOf(range) {
  if (typeof range.getClientRects !== 'function') return null;
  try { return [...range.getClientRects()]; } catch { return null; }
}
// The geometry walk, where no caret API pierces the pane's shadow root: a
// Range per word of the target's text, its client rects against the tap.
function wordUnder(doc, target, x, y) {
  const walk = doc.createTreeWalker(target, 4 /* NodeFilter.SHOW_TEXT */);
  let n = 0;
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    for (const m of t.data.matchAll(/\S+/g)) {
      if (++n > WORD_WALK_MAX) return null;
      const r = doc.createRange();
      r.setStart(t, m.index);
      r.setEnd(t, m.index + m[0].length);
      const rs = rectsOf(r);
      if (!rs) return null;
      if (rs.some((b) => holdsPoint(b, x, y))) return r;
    }
  }
  return null;
}
// The text under a tap, as a seed Range for the word snap: the caret at the
// tap — document.caretPositionFromPoint handed the pane's shadow root (it
// pierces only the roots it is handed; caretRangeFromPoint stops at the host)
// — inside the tapped element, else the geometry walk; null on a control or
// an image, or where no text is under the tap.
function textSeedAt(root, target, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || typeof target.closest !== 'function') return null;
  if (target.closest(CONTROL_TARGETS) || target.closest(IMAGE_TARGETS)) return null;
  const doc = target.ownerDocument || document;
  if (typeof doc.caretPositionFromPoint === 'function') {
    let pos = null;
    try { pos = doc.caretPositionFromPoint(x, y, { shadowRoots: [root] }); } catch { pos = null; }
    const node = pos && pos.offsetNode;
    if (node && node.nodeType === 3 && Number.isInteger(pos.offset) && target.contains(node)) {
      return charRange(doc, node, pos.offset);
    }
  }
  return typeof doc.createTreeWalker === 'function' ? wordUnder(doc, target, x, y) : null;
}
// The word's range record: the seed snapped to its word (highlight.js
// snapRange, the one word snap), held only while the word is under the tap
// where the browser gives its rects (a caret beside a margin or a gap is no
// word), then anchors.recordRange — null over CONFIG.quote_max or empty.
function wordRecord(A, hl, root, seed, mount, x, y) {
  if (!hl || typeof hl.snapRange !== 'function') return null;
  try {
    const word = hl.snapRange(seed, 'words', root);
    if (!word || word.collapsed) return null;
    const rs = rectsOf(word);
    if (rs && rs.length && !rs.some((b) => holdsPoint(b, x, y))) return null;
    return A.recordRange(root, word, { mount }) || null;
  } catch { return null; }
}

// ── a pin on a markdown item (F.3) ──────────────────────────────────────────
const HEADING = /^h[1-6]$/;
const blockText = (el) => (el.textContent || '').trim();
// A Range from the block's start over at most `n` of its rendered characters
// (its text nodes in order), or its whole contents when it holds fewer.
function blockRange(block, n) {
  const doc = block.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(block);
  const walk = doc.createTreeWalker(block, 4 /* NodeFilter.SHOW_TEXT */);
  let left = n;
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const len = t.data.length;
    if (len >= left) { range.setEnd(t, left); break; }
    left -= len;
  }
  return range;
}
// The heading a block is under: its own text for a heading; else the item's
// heading whose data-slug is the record's slug; else the last heading of the
// nearest earlier markdown item on the page; else none.
function sectionOf(itemEl, block, record) {
  if (HEADING.test(block.tagName.toLowerCase())) return blockText(block).slice(0, 120);
  if (record && typeof record.slug === 'string') {
    for (const h of itemEl.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (h.getAttribute('data-slug') === record.slug) return blockText(h).slice(0, 120);
    }
  }
  const items = [...document.querySelectorAll('#main [data-md-id]')];
  for (let i = items.indexOf(itemEl) - 1; i >= 0; i--) {
    const hs = items[i].querySelectorAll('h1,h2,h3,h4,h5,h6');
    if (hs.length) return blockText(hs[hs.length - 1]).slice(0, 120);
  }
  return '';
}
function mdLocatorOf(itemEl, block, md, record) {
  const tag = block.tagName.toLowerCase();
  const ordinal = Math.max(0, [...itemEl.querySelectorAll(tag)].indexOf(block));
  const loc = { mount: md, selector: tag, text: blockText(block).slice(0, 120), ordinal };
  const section = sectionOf(itemEl, block, record);
  if (section) loc.section = section;
  return loc;
}
function createOnMarkdown(input, ctx) {
  const { target, md } = input;
  if (!target || target.nodeType !== 1 || typeof target.closest !== 'function' || !mods) return;
  const itemEl = target.closest('[data-md-id]');
  const block = itemEl ? target.closest(mods.overlay.MD_BLOCKS) : null;
  if (!block || !itemEl.contains(block) || !blockText(block)) return;   // a gap: nothing pinned
  const A = ctx && ctx.anchors;
  const text = ctx && typeof ctx.markdownText === 'function' ? ctx.markdownText(md) : null;
  if (!A || typeof A.recordSource !== 'function' || text == null) return;
  const map = ctx.sourceMap(text);
  const at = (n) => {
    try { return A.recordSource(itemEl, blockRange(block, n), map, text, { md }); } catch { return null; }
  };
  // The source span counts link targets and markup, so a block under the cap
  // in rendered text may still be over it in source: one retry, shorter.
  const record = at((A.CONFIG && A.CONFIG.quote_max) || 2000) || at(SOURCE_RETRY_CHARS);
  if (!record) { note(TOO_LONG_HINT); return; }
  const chain = chainAt(input.clientX, input.clientY);
  openComposer({ record, locator: mdLocatorOf(itemEl, block, md, record), chain }, input.clientX, input.clientY);
}

// ── a chat pin (3C.1, U434) ─────────────────────────────────────────────────
// The chat host's create (registered through chat-pins.js
// registerChatPinActions): the press the overlay's dispatch gave the tool in
// the 'chat' host, under the input-mode policy. The previewed node creates
// nothing (the overlay's dispatch returns; the guard is defence in depth).
function createChat(input, ctx) {
  mods.types.trayAction(() => createChatLive(input, ctx), { note });
}
function createChatLive(input, ctx) {
  if (!input || input.phase !== 'click' || input.host !== 'chat' || !mods) return;
  const spot = chatSpotOf(input, ctx);
  if (!spot) return;   // a press on no chat place (the new pill, a gap, another detail view)
  spot.chain = chainAt(input.clientX, input.clientY, 'chat');
  openComposer(spot, input.clientX, input.clientY);
}
const isNat = (n) => Number.isInteger(n) && n >= 0;
// A plain item's map (a prompt, a thought): the identity, as the chat layer
// places it (chat-pins.js mapOf, U418's contract).
const identityMap = (len) => ({ v: 1, len, runs: [[0, len, len, 'exact']], headings: [] });
function storeTurnOf(tid) {
  const s = mods && mods.chatState && mods.chatState.mirror ? mods.chatState.mirror.stream : null;
  const turns = s && Array.isArray(s.turns) ? s.turns : [];
  return turns.find((t) => t && t.id === tid) || null;
}
function storeItemOf(turn, itemId) {
  return turn && Array.isArray(turn.items) ? turn.items.find((it) => it && it.id === itemId) || null : null;
}
// The anchor's head: the followed conversation (or the turn's own), the
// turn's session where it carries one, the turn.
function headOf(tid, cid) {
  const turn = storeTurnOf(tid);
  const head = { conversation_id: (turn && typeof turn.conversation_id === 'string' && turn.conversation_id) || cid };
  if (turn && typeof turn.session_id === 'string' && turn.session_id) head.session_id = turn.session_id;
  head.turn_id = tid;
  return head;
}
const ITEM_WORDS = Object.freeze({ prompt: 'prompt', reply: 'reply', thinking: 'thinking' });
// The composer's words for an item: "turn · reply", "tool card Bash".
function itemPlace(it, el) {
  if ((it && it.kind === 'tool_call') || (!it && !el.dataset.field)) return `tool card ${(it && (it.tool_kind || it.tool)) || ''}`.trim();
  return `turn · ${(it && ITEM_WORDS[it.kind]) || 'item'}`;
}
const numAttr = (el, name) => {
  const v = el.getAttribute(name);
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
};
// The selection the press lands in, when it is a non-collapsed one inside
// the item's element: the press inside one of its client rects (a browser's
// layout), else — no layout to read — on an element the range holds.
function selectionIn(itemEl, target, x, y) {
  const sel = typeof document.getSelection === 'function' ? document.getSelection() : null;
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!r || r.collapsed || !itemEl.contains(r.startContainer) || !itemEl.contains(r.endContainer)) return null;
  let boxes = [];
  try { boxes = typeof r.getClientRects === 'function' ? [...r.getClientRects()].filter((b) => b && b.width > 0 && b.height > 0) : []; } catch { boxes = []; }
  if (boxes.length && Number.isFinite(x) && Number.isFinite(y)) {
    return boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) ? r : null;
  }
  try { return target && r.intersectsNode(target) ? r : null; } catch { return null; }
}
// A passage's record through the page's ONE text-offset engine (S2-confirm):
// anchors.recordSource over the item's element and its LF-normalised text,
// with the reply's chat sourceMap or a plain item's identity map. Only its
// pos is sent (the daemon quotes the served text); null when it cannot align.
function passageOf(itemEl, range, it, ctx) {
  const A = ctx && ctx.anchors;
  if (!A || typeof A.recordSource !== 'function' || !it || typeof it.text !== 'string') return null;
  const text = it.text.replace(/\r\n?/g, '\n');
  const sm = ctx && typeof ctx.sourceMap === 'function' ? ctx.sourceMap : null;
  const map = it.kind === 'reply' ? (sm ? sm(text, { flavor: 'chat' }) : null) : identityMap(text.length);
  if (!map) return null;
  let rec = null;
  try { rec = A.recordSource(itemEl, range, map, text, { md: null }); } catch { rec = null; }
  return rec && rec.pos && isNat(rec.pos.start) && isNat(rec.pos.end) && rec.pos.end > rec.pos.start ? rec : null;
}
// The open diff view's line: its turn (the view's data-turn-id), its file
// (data-path), its number on the new side (data-new), or the old one's for a
// deleted line. A hunk or meta line has no number: nothing is pinned.
function diffSpot(line, cid) {
  const wrap = line.closest('.dv-diffview[data-turn-id]');
  const file = line.closest('details.dv-file[data-path]');
  if (!wrap || !file || !wrap.contains(file)) return null;
  const tid = wrap.dataset.turnId;
  const path = file.dataset.path;
  const n = numAttr(line, 'data-new');
  const o = numAttr(line, 'data-old');
  const side = n != null ? 'new' : o != null ? 'old' : null;
  if (!tid || !path || !side) return null;
  const at = side === 'new' ? n : o;
  return { chat: true, place: `${path}:${at}`, anchor: { kind: 'diff-line', ...headOf(tid, cid), file: path, side, line: at } };
}
// The chat place under a press → {chat, place, quote?, anchor} or null.
function chatSpotOf(input, ctx) {
  const target = input.target;
  if (!target || target.nodeType !== 1 || typeof target.closest !== 'function') return null;
  const cid = mods.chatState.followed();
  if (!cid) return null;
  const line = target.closest('.dl');
  if (line && line.closest('.dv-diffview[data-turn-id]')) return diffSpot(line, cid);
  const stream = document.getElementById('chat-stream');
  const turnEl = target.closest('article.ct-turn[data-turn-id]');
  if (!turnEl || !stream || !stream.contains(turnEl)) return null;
  const tid = turnEl.dataset.turnId;
  const head = headOf(tid, cid);
  const itemEl = target.closest('[data-item-id]');
  if (!itemEl || !turnEl.contains(itemEl)) return { chat: true, place: 'turn', anchor: { kind: 'turn', ...head } };
  const itemId = itemEl.dataset.itemId;
  const it = storeItemOf(storeTurnOf(tid), itemId);
  const place = itemPlace(it, itemEl);
  if (itemEl.dataset.field !== 'text') return { chat: true, place, anchor: { kind: 'item', ...head, item_id: itemId } };
  const range = selectionIn(itemEl, target, input.clientX, input.clientY);
  const rec = range ? passageOf(itemEl, range, it, ctx) : null;
  if (rec) {
    return { chat: true, place, quote: rec.quote && rec.quote.exact,
      anchor: { kind: 'item-range', ...head, item_id: itemId, field: 'text', pos: { start: rec.pos.start, end: rec.pos.end } } };
  }
  return { chat: true, place, anchor: { kind: 'item', ...head, item_id: itemId, field: 'text' } };
}
// The chat place's anchor line: the place, then a passage's quote head.
function chatPlaceHtml(place, quote) {
  const q = typeof quote === 'string' ? quote.replace(/\s+/g, ' ').trim() : '';
  const tail = q ? '<span class="pin-path-sep"> › </span>' + esc('"' + (q.length > 40 ? q.slice(0, 40) + '…' : q) + '"') : '';
  return esc(place || 'chat') + tail;
}
// A chat record's place: a diff line's file:line, else the daemon's label
// ("turn 3's reply", "tool card Read"), else its kind.
function chatPlaceOf(pin) {
  const a = isObj(pin.anchor) ? pin.anchor : {};
  if (a.kind === 'diff-line' && typeof a.file === 'string') return `${a.file}:${a.line}`;
  return (typeof a.label === 'string' && a.label) || String(a.kind || 'chat').replace(/-/g, ' ');
}
const chatQuoteOf = (pin) => {
  const a = isObj(pin.anchor) ? pin.anchor : {};
  return a.kind === 'item-range' && isObj(a.quote) && typeof a.quote.exact === 'string' ? a.quote.exact : '';
};
// The refusal line at the foot of a chat pin's composer (F10: the draft is
// kept); a later refusal replaces it.
function showErr(el, text) {
  const old = el.querySelector('.pin-reply-err');
  if (old) old.remove();
  const err = document.createElement('div');
  err.className = 'pin-reply-err';
  err.textContent = text;
  el.appendChild(err);
}
// Pin for a chat pin: ONE POST of the locator; the composer stays open with
// its draft until the daemon answers ok — a 409 provisional target's hint (the
// reply is still streaming) in its .pin-reply-err line where the press
// landed, any other refusal's hint there and in the note.
async function postChatPin(spot, text, shared, el) {
  const save = el.querySelector('.pin-save');
  if (save) save.disabled = true;
  const body = { type: CHAT_TYPE, anchor: { ...spot.anchor }, payload: { text, shared, chain: (spot.chain || []).slice() } };
  const r = await request('POST', ELEMENTS_PATH, { body, device: true });
  if (save) save.disabled = false;
  if (r.ok) {
    if (pop === el) closePop();
    setPinMode(false);
    const pin = r.body && r.body.element;
    if (validChat(pin)) mods.chat.applyChatPin(pin);
    else mods.chat.refreshChatPins();
    return;
  }
  const hint = r.hint || CHAT_REFUSED_HINT;
  const provisional = r.status === 409 && !!r.body && r.body.state === 'provisional';
  if (el.isConnected) showErr(el, hint);
  if (!provisional || !el.isConnected) note(hint);
}

async function postPin(spot, text, shared) {
  const body = { type: TYPE, anchor: spot.record || spot.locator, payload: { text, shared } };
  if (Array.isArray(spot.chain) && spot.chain.length) body.payload.chain = spot.chain.slice();
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
    '<div class="pin-anchor">' + (spot.chat ? chatPlaceHtml(spot.place, spot.quote) : anchorPath(spot.locator, 40))
    + chainHtml(spot.chain) + '</div>'
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
    if (spot.chat) {
      // A chat pin's composer stays until the daemon answers (F10).
      if (el.querySelector('.pin-save').disabled) return;
      mods.types.trayAction(() => postChatPin(spot, text, share, el).catch((e) => console.error('[web-chat] comments: the chat pin was not sent', e)), { note });
      return;
    }
    closePop();
    setPinMode(false);
    mods.types.trayAction(() => postPin(spot, text, share).catch((e) => console.error('[web-chat] comments: the pin was not sent', e)), { note });
  });
}

// A pin's thread as message rows: the root note (a user message) then each reply.
function threadMessages(pin) {
  const msgs = [{ author: 'user', text: pin.text || '' }];
  for (const r of (Array.isArray(pin.replies) ? pin.replies : [])) msgs.push(r);
  return msgs;
}

// A marker click opens the thread(s) it stands for — one pin opens its thread,
// a grouped marker opens a chooser. A chat marker's ids (`chat`) not held yet
// ask the chat layer for one read.
function openPinMenu(ids, x, y, { chat = false } = {}) {
  const pins = ids.map(recordOf).filter(Boolean);
  if (!pins.length) {
    if (chat) { if (mods) mods.chat.refreshChatPins(); } else if (!view.previewing) refresh();
    return;
  }
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
  const ro = !mods || mods.types.trayReadOnly();
  // A chat pin's answers go to the chat layer (U432's applyChatPin /
  // dropChatPin); a page pin's to this module's live set.
  const chat = isChatPin(pin);
  const valid = chat ? validChat : validPin;
  const apply = (next) => (chat ? mods.chat.applyChatPin(next) : applyOne(next));
  const reread = () => (chat ? mods.chat.refreshChatPins() : refresh());
  const el = document.createElement('div');
  el.className = 'popover pin-pop pin-thread' + (ro ? ' pin-readonly' : '');
  el.dataset.id = pin.id;
  const msgs = threadMessages(pin).map((m) =>
    '<div class="pin-msg ' + (m.author === 'claude' ? 'claude' : 'user') + '">'
    + '<div class="pin-who">' + (m.author === 'claude' ? 'Claude' : 'You') + '</div>'
    + '<div class="pin-body">' + esc(m.text || '') + '</div></div>').join('');
  el.innerHTML =
    '<div class="pin-anchor">' + (chat ? chatPlaceHtml(chatPlaceOf(pin), chatQuoteOf(pin)) : anchorPath(locatorOfPin(pin), 32))
    + chainHtml(pin.chain) + '</div>'
    + '<div class="pin-thread-msgs">' + msgs + '</div>'
    + (ro
      ? '<div class="pin-reply-err pin-ro-hint">' + esc(mods ? mods.topbar.READONLY_HINT : '') + '</div>'
      : '<div class="pin-reply"><textarea class="pin-reply-text" rows="2" placeholder="Reply…"></textarea>'
        + '<div class="pin-actions"><label class="pin-share" title="Claude reads only shared comments (get_comments)">'
        + '<input type="checkbox" class="pin-share-cb" ' + (pin.shared !== false ? 'checked' : '') + '> Shared with Claude</label>'
        + '<span class="pin-spacer"></span>'
        + '<button class="pin-del" title="Delete this comment">Delete</button>'
        + (mods.types.maySend() ? '<button class="pin-send" title="Share it with Claude and queue it: Push sends it">' + esc(mods.types.SEND_LABEL) + '</button>' : '')
        + '<button class="pin-reply-send" title="Send reply (↵)">Send</button></div></div>');
  openPop(el, x, y, 300, 260);
  if (ro) return;
  // Every write runs through the tray action guard: one asked for once a
  // preview has started is refused with READONLY_HINT and sends nothing.
  const guard = (run) => mods.types.trayAction(run, { note });
  const ta = el.querySelector('.pin-reply-text');
  ta.focus();
  const send = () => {
    const text = ta.value.trim();
    if (!text) return undefined;
    return guard(() => sendReply(text));
  };
  const sendReply = async (text) => {
    const old = el.querySelector('.pin-reply-err');
    if (old) old.remove();
    const r = await request('POST', `${ELEMENTS_PATH}/${encodeURIComponent(pin.id)}/reply`,
      { body: { text, author: 'user' }, device: true });
    const next = r.ok && r.body ? (r.body.element || r.body.pin) : null;
    // F10: only a confirmed answer with the pin clears the draft (the re-render
    // below). A refusal or a network failure keeps the typed reply and says so.
    if (!valid(next)) {
      const err = document.createElement('div');
      err.className = 'pin-reply-err';
      err.textContent = 'Reply failed — draft kept. Try again.';
      el.querySelector('.pin-reply').appendChild(err);
      return;
    }
    apply(next);
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
  const shareCb = el.querySelector('.pin-share-cb');
  shareCb.addEventListener('change', (ev) => {
    const box = ev.target;
    const done = guard(async () => {
      const r = await request('PATCH', `${ELEMENTS_PATH}/${encodeURIComponent(pin.id)}`,
        { body: { shared: box.checked }, device: true });
      const next = r.ok && r.body ? (r.body.element || r.body.pin) : null;
      if (valid(next)) apply(next);
      else if (!r.ok) note(r.hint);
      else reread();
    });
    if (done === mods.types.TRAY_REFUSAL) box.checked = !box.checked;
  });
  el.querySelector('.pin-del').addEventListener('click', () => guard(async () => {
    closePop();
    const r = await request('DELETE', `${ELEMENTS_PATH}/${encodeURIComponent(pin.id)}`, { body: {}, device: true });
    if (!r.ok) note(r.hint);
    else if (chat) mods.chat.dropChatPin(pin.id);
    else dropOne(pin.id);
  }));
  const toClaude = el.querySelector('.pin-send');
  if (toClaude) {
    toClaude.addEventListener('click', () => guard(async () => {
      const r = await mods.types.sendToClaude(pin.id);
      if (!r.ok) { note(r.hint); return; }
      if (valid(r.element)) {
        apply(r.element);
        shareCb.checked = r.element.shared !== false;   // "Shared with Claude" reads shared
      }
      note(r.note);
    }));
  }
}

// ── the rail's card (K.2-11) ────────────────────────────────────────────────
// Where a pin is on the page now: its marker's element, else its pane, else
// its markdown item.
export function showOnPage(id, mount) {
  for (const c of [...marks]) {
    if (!c.isConnected || !c._commentIds || !c._commentIds.includes(String(id))) continue;
    const g = c._group;
    const at = g && (g.el || (g.range && g.range.startContainer && g.range.startContainer.parentElement));
    if (at && typeof at.scrollIntoView === 'function') { at.scrollIntoView({ block: 'center', behavior: 'smooth' }); return true; }
  }
  if (mount != null && mods && mods.mounts.revealPane(String(mount))) return true;
  // A pin on a markdown item (F.3): its item, as the box grab's card does.
  if (mount != null && mods && mods.page.revealMarkdown(String(mount))) return true;
  note(GONE_HINT);
  return false;
}
const cardSlots = new Set();
function renderCard(item, slot) {
  cardSlots.add(slot);
  slot._commentItem = item;
  slot.replaceChildren();
  const id = String(item.element_id ?? item.comment_id ?? '');
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
// initComments() wires (the modules loaded) the type, its card and the record
// inputs; the comment tool is armed from the toolbar's slot, C and the palette
// (U338). Idempotent; no timer of any kind.
export function initComments() {
  if (inited) return;
  inited = true;
  document.addEventListener('visibilitychange', onVisibility);
  load().then((m) => {
    m.types.registerElementType(TYPE, { draw, create, input: 'taps', sourceGlyph: SOURCE_GLYPH });
    // The chat-comment's create and its marker's open (U432's seam): the one
    // thread engine serves both types.
    m.chat.registerChatPinActions({
      create: createChat,
      open: (ids, at) => openPinMenu(ids, at && at.x, at && at.y, { chat: true }),
    });
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

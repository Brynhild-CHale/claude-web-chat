// The chat layer (annotation engine 3C.1, U432): the chat-comment pins drawn
// in the chat, through the overlay's ONE host registry (overlay.js
// registerHost) — this module is the chat layer's one home.
//
// THE HOST. ONE host, 'chat', registered over the chat panel's views
// (#chat-views: the stream, the new pill and the detail views, chat-panel.js).
// The panel is one instance that moves between the dock (docked and windowed)
// and the phone sheet's Chat page on bus `chat:host`, so the host follows it
// with no re-registration: its markers sit on the same elements, re-measured.
// Its layer is the overlay's #el-layer-chat at --z-chat-pins. The well is the
// group's own scroll box — #chat-stream for a stream row, the open diff view's
// body (.cp-dbody) for a diff-line row — and the overlay clips it with the
// viewport and every clipping ancestor (the dock's, the sheet's). The awaiting
// card (#chat-awaiting) is outside #chat-views, and the overlay's census keeps
// a glyph off every displayed frame. No document draws a chat pin (L2): this
// module runs in the live chrome only, and no preview, export or replay
// builder serves it.
//
// THE RECORDS. The daemon owns the state (D5): each served chat-comment record
// carries the resolver's answer at its top level (state, visible, explain,
// how?, at?, note?, turn_id_now?; lib/server/routes/elements.js U416). They
// reach the chrome two ways, and none of them is a timer:
//   - ONE GET /api/elements?type=chat-comment through http.js `request`: at
//     init, after every hello, after every reset, when the mirror's level
//     rises to `read`, and when a frame names a pin it cannot place (one with
//     no answer); put off while the tab is hidden;
//   - the daemon's `element:chat-comment` frame (ws.js onFrame), the whole
//     live chat set.
// The list never kicks a parse (O2): a conversation is read when the chat's
// own view of it asks (chat-state.js → the mirror routes). While the followed
// conversation has a pin (any state: a terminal rewind may supersede or
// re-key its turn), or an `indexing` pin's turn is listed by another host
// (the inspector's turn list), one more read follows a bus 'mirror' change
// naming 'stream' or 'all' (a parse's scoped mirror:reset), single-flight. Below the mirror's `read` level nothing is requested and
// nothing drawn; the daemon's projection decides what a level sees (L6,
// C-15-1) and no rule here narrows or widens it.
//
// PLACE (the chrome owns placement, from the renderer's stamps):
//   turn       → the turn root, article.ct-turn[data-turn-id]
//   item       → the [data-item-id] element under it (prompt bubble, reply
//                prose, thinking text, tool card); one inside a closed
//                <details> is placed at that details' summary
//   item-range → a Range over the passage, through the page's ONE text-offset
//                engine: anchors.resolveSource over the item's element with
//                sourceMap(text, {flavor: 'chat'}) (a reply) or the identity
//                map (a prompt, a thought); a passage at or past the chat's
//                cut is drawn at the cut's note (data-src-cut, CUT@note)
//   diff-line  → the open diff view of that turn (.dv-diffview[data-turn-id]),
//                details.dv-file[data-path], the .dl line whose data-new (or
//                data-old for side 'old') is the answer's line
// The state is the row's answer. Unavailable pins, and indexing pins whose
// turn is not drawn, are LISTED: under their turn while the stream draws it,
// else in one group marker at #chat-stream's top while their conversation is
// the followed one. Nothing is ever orphaned.
//
// HIDDEN (overlay-hidden.js HIDDEN_REASONS): 'sheet' (narrow, the sheet closed
// or on Tasks), 'elsewhere' (another conversation than the followed one),
// 'covered' (a stream row under a detail view; a diff-line row whose diff view
// is not the open one), 'pruned' (a turn the stream does not draw: past its
// 150-turn window, or not paged in).
//
// DRAW. The comment's pin glyph and count (.pin-marker / .pin-count) at the
// host's glyph size, coloured as a page pin (private muted, replied green);
// the overlay adds the state's class (DRAW_RULES). A marker's title is its
// rows' explain lines — or an answer's `note` in place of its line — never a
// pin's comment text, which stays in the thread (U434's). A marker's click is
// the registered open (registerChatPinActions, the chat host) or the tap
// handler of the host it is drawn in (onMarkerTap), else openPinList.
//
// GONE (Q4 b). A pin whose whole conversation has left the mirror is reachable
// through ONE ⌘K row 'Chat pins no longer in a chat (n)', which opens the pin
// list with each pin's own quote and explain line (and in the inspector's turn
// list, get_comments and its queue item — not this module's).
//
// REVEAL. bus chat:open {view: 'turn', id, conversation_id} follows the
// conversation when it is not the followed one and scrolls the turn into view
// on the first chat:drawn that draws it, then flashes its markers once; a
// first chat:drawn of that conversation without the turn, a later follow or a
// later chat:open ends the reveal.
//
// THE SEAM (U433, U434 plug in here, never editing this file): CHAT_TYPE,
// initChatPins(), stopChatPins(), chatPins(), chatPinOf(id), applyChatPin(pin),
// dropChatPin(id), refreshChatPins(), registerChatPinActions({create, open}),
// onMarkerTap(host, fn), openPinList(ids, x, y), revealTurn({conversation_id,
// turn_id}).
//
// It creates no element id (classes only: the layer is the overlay's), adds no
// frame, route or timer, and puts no quote into a wake or an envelope (D2).
import { bus } from './bus.js';
import { request } from './http.js';
import { onFrame, onHello } from './ws.js';
import { registerHost, upsertElements, removeElements, elementsOf, hosts } from './overlay.js';
import { registerElementType } from './element-types.js';
import { HIDDEN_REASONS } from './overlay-hidden.js';
import { mirror, followed, followConversation, atLeast } from './chat-state.js';
import { isNarrow } from './viewport.js';
import { sheetState } from './chat-sheet.js';
import { registerPopover, registerPaletteSource } from './shell.js';
import { sourceMap } from './markdown.js';
import anchors from './anchors.js';
import { esc } from './esc.js';

export const CHAT_TYPE = 'chat-comment';
export const ELEMENTS_PATH = '/api/elements';
export const HOST = 'chat';
export const KINDS = Object.freeze(['turn', 'item', 'item-range', 'diff-line']);
export const PALETTE_SOURCE = 'chat-pins';
export const goneLabel = (n) => `Chat pins no longer in a chat (${n})`;
// The chat host's glyph: the type's 26 px pin, hung from its anchor's top-left
// corner (a chat element's top edge is the next one's bottom), so the stream
// top's group marker sits inside the well. A stand-in place: no designed look.
export const CHAT_GLYPH = Object.freeze({ dx: 0, dy: 0, w: 26, h: 26 });
// The reveal's one flash (a class; app.css draws no animation under
// prefers-reduced-motion).
export const FLASH_CLASS = 'el-flash';

// The states, from the one vocabulary (lib/core/anchor-states, carried by the
// resolver's module), never spelled as a bare literal here.
function stateOf(name) {
  if (!anchors.STATES || anchors.STATES.indexOf(name) < 0) throw new Error(`chat-pins: the state vocabulary has no ${name}`);
  return name;
}
const INDEXING = stateOf('indexing');
const UNAVAILABLE = stateOf('unavailable');
const ANSWER_KEYS = ['state', 'visible', 'explain', 'how', 'at', 'note', 'turn_id_now'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
const contentOk = () => atLeast(mirror.access.level, 'read');
const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

// ── the records ─────────────────────────────────────────────────────────────
let records = new Map();          // id → the served record (its answer at its top level)
let seq = 0;                      // bumped by every frame and read: an older read's answer is dropped
let inFlight = null;              // the one read in flight
let again = false;                // false, or the Set of mirror changes heard while a read was in flight
const againFor = (prev, what) => new Set([...(prev || []), ...what]);
let rerun = false;                // a read asked for while one was in flight (sent after it)
let stale = false;                // a read asked for while the tab was hidden
let levelOk = false;
const decisions = new Map();      // id → {state, how, hidden}: the last place() made

const validPin = (p) => isObj(p) && typeof p.id === 'string' && p.id !== '' && (p.type == null || p.type === CHAT_TYPE);
// The daemon's answer as the row carries it: the record's top-level answer
// fields, copied as given; null when the record carries none yet (held
// undrawn: the chrome invents no state).
function answerOf(rec) {
  if (!rec || typeof rec.state !== 'string' || !rec.state) return null;
  const out = {};
  for (const k of ANSWER_KEYS) if (rec[k] !== undefined) out[k] = isObj(rec[k]) ? { ...rec[k] } : rec[k];
  return out;
}
const answeredOf = (rec) => Array.isArray(rec.replies) && rec.replies.some((r) => isObj(r) && r.author === 'claude');
function rowOf(rec) {
  const answer = answerOf(rec);
  return {
    id: rec.id, v: rec.v == null ? null : rec.v, type: CHAT_TYPE,
    ...(typeof rec.schema === 'string' ? { schema: rec.schema } : {}),
    anchor: isObj(rec.anchor) ? rec.anchor : null, shared: rec.shared !== false,
    replies: Array.isArray(rec.replies) ? rec.replies.length : 0, answered: answeredOf(rec),
    ...(answer ? { answer } : {}),
  };
}
const sameRow = (a, b) => a.v === b.v && a.shared === b.shared && a.replies === b.replies && !!a.answered === !!b.answered
  && a.schema === b.schema && JSON.stringify(a.anchor) === JSON.stringify(b.anchor)
  && JSON.stringify(a.answer || null) === JSON.stringify(b.answer || null);

// The overlay's live chat rows brought to match the records: new or changed
// ones upserted, and the ones no record names removed.
function relay() {
  const have = new Map(elementsOf('live').filter((r) => r.type === CHAT_TYPE).map((r) => [r.id, r]));
  const fresh = [];
  for (const rec of records.values()) {
    const row = rowOf(rec);
    const prior = have.get(row.id);
    if (prior && sameRow(prior, row)) continue;
    fresh.push(row);
  }
  const gone = [...have.keys()].filter((id) => !records.has(id));
  if (gone.length) removeElements('live', gone);
  if (fresh.length) upsertElements('live', fresh);
  for (const id of [...decisions.keys()]) if (!records.has(id)) decisions.delete(id);
}
function setAll(list) {
  records = new Map((Array.isArray(list) ? list : []).filter(validPin).map((r) => [r.id, r]));
  relay();
}

// The daemon's element:chat-comment frame: the whole live chat set, applied
// with no read — unless it names a pin with no answer (one it cannot place),
// which asks for one.
function onChatFrame(msg) {
  if (!running || !contentOk()) return;
  seq++;
  const list = msg && Array.isArray(msg.elements) ? msg.elements : [];
  setAll(list);
  if (list.some((r) => validPin(r) && !answerOf(r))) refreshChatPins();
}

// One read of the live chat set (single-flight). Never below `read`, never
// while the tab is hidden (asked for again when it shows).
export function refreshChatPins() {
  if (!running || !contentOk()) return Promise.resolve(false);
  if (isHidden()) { stale = true; return Promise.resolve(false); }
  stale = false;
  if (inFlight) { rerun = true; return inFlight; }
  return read();
}
function read() {
  const mine = ++seq;
  inFlight = (async () => {
    const r = await request('GET', `${ELEMENTS_PATH}?type=${CHAT_TYPE}`);
    inFlight = null;
    const fresh = running && mine === seq && contentOk() && r.ok && r.body && Array.isArray(r.body.elements);
    if (fresh) setAll(r.body.elements);
    // One more read when one was asked for meanwhile (a hello, a reset, a
    // frame naming a pin it cannot place), or when an indexing re-read was and
    // a pin of the followed conversation still answers indexing.
    const more = rerun || (!!again && wantsReread(again));
    rerun = false;
    again = false;
    if (more) refreshChatPins();
    return !!fresh;
  })();
  return inFlight;
}
function onVisibility() {
  if (!isHidden() && stale) refreshChatPins();
}

// Whether a mirror change asks for the one single-flight re-read: on a
// 'stream' change, a pin of the followed conversation in any state (a
// terminal rewind may have superseded or re-keyed its turn, K.2-177 g3); on a
// 'stream' or 'all' change, an `indexing` pin of the followed conversation, or
// one whose turn another registered host lists — the graph inspector's turn
// list (U433), whatever conversation the chat follows (K.2-181 g7).
function wantsReread(what) {
  const cid = followed();
  const stream = what.has('stream');
  if (!stream && !what.has('all')) return false;
  let listed = null;
  for (const rec of records.values()) {
    if (!isObj(rec.anchor)) continue;
    const mine = !!cid && rec.anchor.conversation_id === cid;
    if (mine && (stream || rec.state === INDEXING)) return true;
    if (mine || rec.state !== INDEXING || !str(rec.anchor.turn_id)) continue;
    if (!listed) listed = turnsListed();
    if (listed.has(rec.anchor.turn_id)) return true;
  }
  return false;
}
// The turn ids the registered hosts other than the chat's (and the page's)
// draw rows for ([data-turn-id] under the host's root). DOM reads only.
function turnsListed() {
  const out = new Set();
  let list = [];
  try { list = hosts(); } catch { list = []; }
  for (const h of list) {
    if (!h || h.name === HOST || h.name === 'page' || !h.root || typeof h.root.querySelectorAll !== 'function') continue;
    for (const el of h.root.querySelectorAll('[data-turn-id]')) if (el.dataset.turnId) out.add(el.dataset.turnId);
  }
  return out;
}

// bus 'mirror': the level gate, and the indexing → placed re-read.
function onMirror(d) {
  const ok = contentOk();
  if (ok !== levelOk) {
    levelOk = ok;
    if (!ok) {
      seq++;
      records = new Map();
      relay();
      return;
    }
    refreshChatPins();
    return;
  }
  // A follow elsewhere ends a reveal still waiting (K.2-177 g4).
  if (reveal && followed() !== reveal.cid) reveal = null;
  const what = new Set(d && Array.isArray(d.what) ? d.what : []);
  if (ok && wantsReread(what)) {
    if (inFlight) again = againFor(again, what);
    else refreshChatPins();
  }
}

// One record a write answered with (U434's), or one the daemon removed.
export function applyChatPin(pin) {
  if (!validPin(pin)) return;
  seq++;
  records.set(pin.id, pin);
  relay();
}
export function dropChatPin(id) {
  if (id == null) return;
  seq++;
  records.delete(String(id));
  relay();
}
export function chatPins() { return [...records.values()].map((r) => ({ ...r })); }
// One pin: its record, its row, and the last placement made for it ({state,
// how, hidden} — hidden a HIDDEN_REASONS value or null — or null when it is
// unplaced).
export function chatPinOf(id) {
  const rec = records.get(String(id));
  if (!rec) return null;
  const d = decisions.get(rec.id);
  return { record: { ...rec }, row: rowOf(rec), placed: d ? { ...d } : null };
}

// ── the chat's DOM ──────────────────────────────────────────────────────────
function turnRoot(stream, tid) {
  if (!stream || !tid) return null;
  for (const t of stream.querySelectorAll('article.ct-turn')) if (t.dataset.turnId === tid) return t;
  return null;
}
function storeTurn(tid) {
  const turns = mirror.stream && Array.isArray(mirror.stream.turns) ? mirror.stream.turns : [];
  return turns.find((t) => t && t.id === tid) || null;
}
function storeItem(tid, itemId) {
  const t = storeTurn(tid);
  return t && Array.isArray(t.items) ? t.items.find((it) => it && it.id === itemId) || null : null;
}
function itemEl(turnEl, itemId, field) {
  if (!turnEl || !itemId) return null;
  let hit = null;
  for (const e of turnEl.querySelectorAll('[data-item-id]')) {
    if (e.dataset.itemId !== itemId) continue;
    if (!field || e.dataset.field === field) return e;
    if (!hit) hit = e;
  }
  return hit;
}
// An element inside a closed <details> (a turn's tool group, a thought) has no
// box: it is placed at that details' summary.
function shownEl(el, within) {
  const up = el && el.parentElement;
  let d = up && up.closest ? up.closest('details:not([open])') : null;
  if (d && within && !within.contains(d)) d = null;
  if (!d) return el;
  for (const c of d.children) if (c.localName === 'summary') return c;
  return d;
}
// The top detail view when one is open, else null.
function topDetail() {
  const views = $('chat-views');
  const host = $('chat-detail');
  if (!views || !host || !views.classList.contains('cp-detail-open')) return null;
  const all = [...host.children].filter((v) => v.classList.contains('cp-dview'));
  for (let i = all.length - 1; i >= 0; i--) if (!all[i].hidden) return all[i];
  return null;
}
// The open diff view of turn `tid` (renderDiffView's single-turn wrap).
function openDiffOf(tids) {
  const top = topDetail();
  if (!top || top.dataset.kind !== 'diff') return null;
  const wrap = top.querySelector('.dv-diffview[data-turn-id]');
  return wrap && tids.includes(wrap.dataset.turnId) ? wrap : null;
}
const IDENTITY = (len) => ({ v: 1, len, runs: [[0, len, len, 'exact']], headings: [] });
const maps = new Map();            // item id → {text, map}
function mapOf(itemId, text, kind) {
  const c = maps.get(itemId);
  if (c && c.text === text && c.kind === kind) return c.map;
  const map = kind === 'reply' ? sourceMap(text, { flavor: 'chat' }) : IDENTITY(text.length);
  maps.set(itemId, { text, kind, map });
  if (maps.size > 500) maps.delete(maps.keys().next().value);
  return map;
}
const isNum = (n) => Number.isInteger(n) && n >= 0;

// ── place (DOM queries only: the overlay reads every box) ───────────────────
function hiddenFor(a, { turnEl, listed, diff, diffOpen }) {
  if (isNarrow()) {
    const s = sheetState();
    if (!s || s.stop === 'closed' || s.view !== 'chat') return HIDDEN_REASONS.SHEET;
  }
  if (a.conversation_id !== followed()) return HIDDEN_REASONS.ELSEWHERE;
  if (diff) return diffOpen ? null : HIDDEN_REASONS.COVERED;
  const views = $('chat-views');
  if (views && views.classList.contains('cp-detail-open')) return HIDDEN_REASONS.COVERED;
  return !turnEl && !listed ? HIDDEN_REASONS.PRUNED : null;
}
function placeRow(row) {
  const a = row.anchor;
  const ans = row.answer;
  const stream = $('chat-stream');
  if (!a || !ans || typeof ans.state !== 'string' || !stream) return null;
  const state = ans.state;
  const at = isObj(ans.at) ? ans.at : {};
  const tids = [str(ans.turn_id_now), str(a.turn_id)].filter(Boolean);
  const isFollowed = a.conversation_id === followed();
  let turnEl = null;
  if (isFollowed) for (const t of tids) { turnEl = turnRoot(stream, t); if (turnEl) break; }
  const tid = (turnEl && turnEl.dataset.turnId) || tids[0] || null;
  // Listed: unavailable (the only terminal state), and indexing whose turn is
  // not drawn — under the turn while it is drawn, else at the stream's top.
  const listed = state === UNAVAILABLE || (state === INDEXING && !turnEl);
  let out = null;
  let diff = false;
  let diffOpen = false;
  if (listed) {
    out = turnEl ? { state, how: 'turn', el: turnEl } : { state, how: 'conversation', el: stream };
  } else if (!turnEl && a.kind !== 'diff-line') {
    out = { state, how: 'not-drawn', el: stream };
  } else if (a.kind === 'turn') {
    out = { state, how: 'turn', el: turnEl };
  } else if (a.kind === 'item' || a.kind === 'item-range') {
    const id = str(at.item_id) || str(a.item_id);
    const el = itemEl(turnEl, id, str(a.field));
    if (!el) out = { state, how: 'turn', el: turnEl };
    else if (a.kind === 'item') out = { state, how: 'item', el: shownEl(el, turnEl) };
    else out = placeRange(state, a, at, el, tid, id, turnEl);
  } else if (a.kind === 'diff-line') {
    diff = true;
    const wrap = openDiffOf(tids);
    diffOpen = !!wrap;
    out = wrap ? placeLine(state, a, at, wrap) : { state, how: 'not-open', el: turnEl || stream };
  }
  if (!out) return null;
  const hidden = hiddenFor(a, { turnEl, listed, diff, diffOpen });
  decisions.set(row.id, { state, how: out.how, hidden });
  return out;
}
function placeRange(state, a, at, el, tid, itemId, turnEl) {
  const it = storeItem(tid, itemId);
  const text = it && typeof it.text === 'string' ? it.text.replace(/\r\n?/g, '\n') : null;
  const pos = isNum(at.start) && isNum(at.end) ? { start: at.start, end: at.end }
    : isObj(a.pos) && isNum(a.pos.start) && isNum(a.pos.end) ? { start: a.pos.start, end: a.pos.end } : null;
  const shown = shownEl(el, turnEl);
  if (shown !== el || !text || !pos || !isObj(a.quote)) return { state, how: 'item', el: shown };
  // CUT@note: a passage at or past the chat's cut is drawn at the cut's note
  // (markdown.js CHAT_MAX_CHARS); one past the text the stream holds (its
  // own cap) at the item, beyond the shown text — never orphaned.
  const cut = el.querySelector('[data-src-cut]');
  if (cut && pos.start >= Number(cut.getAttribute('data-src-cut'))) return { state, how: 'cut', el: cut };
  if (pos.start >= text.length) return { state, how: 'cut', el };
  let got = null;
  try {
    got = anchors.resolveSource(el, text, mapOf(itemId, text, it.kind), { v: 1, kind: 'source', slug: null, quote: a.quote, pos });
  } catch { got = null; }
  if (got && got.range) return { state, how: 'range', range: got.range };
  return { state, how: 'item', el };
}
function placeLine(state, a, at, wrap) {
  const file = str(at.file) || str(a.file);
  const side = (str(at.side) || str(a.side)) === 'old' ? 'old' : 'new';
  const line = Number.isInteger(at.line) ? at.line : a.line;
  const d = file ? [...wrap.querySelectorAll('details.dv-file')].find((x) => x.dataset.path === file) : null;
  if (!d) return { state, how: 'view', el: wrap };
  const sum = [...d.children].find((c) => c.localName === 'summary') || d;
  if (!d.open) return { state, how: 'file', el: sum };
  const attr = side === 'old' ? 'data-old' : 'data-new';
  for (const s of d.querySelectorAll('.dl')) if (s.getAttribute(attr) === String(line)) return { state, how: 'line', el: s };
  return { state, how: 'file', el: sum };
}
function hiddenRow({ row }) {
  const d = row && decisions.get(row.id);
  return d ? d.hidden : null;
}
// The group's own scroll box: the diff view's body for a row drawn in it,
// else the stream.
function wellOf(g) {
  const at = g && (g.el || (g.range && g.range.startContainer));
  const node = at && at.nodeType === 3 ? at.parentNode : at;
  const body = node && typeof node.closest === 'function' ? node.closest('.cp-dbody') : null;
  return body || $('chat-stream');
}

// ── draw ────────────────────────────────────────────────────────────────────
const PIN_PATH = '<path d="M8 1.4c-2.5 0-4.4 2-4.4 4.4 0 3.2 4.4 8.8 4.4 8.8s4.4-5.6 4.4-8.8C12.4 3.4 10.5 1.4 8 1.4z" fill="currentColor"/>'
  + '<circle cx="8" cy="5.8" r="1.55" style="fill:var(--wc-panel-bg)"/>';
const pinSvg = (w, h) => `<svg viewBox="0 0 16 16" width="${w}" height="${h}" aria-hidden="true">${PIN_PATH}</svg>`;
// An answer's one line: its `note` when it carries one (U417's pending diff),
// else its explain line (the daemon's EXPLAIN, Q6's one table).
export function lineOf(answer) {
  if (!isObj(answer)) return '';
  return str(answer.note) || str(answer.explain) || '';
}
const tapHandlers = new Map();    // host → fn(ids, {x, y, host})
let actions = { create: null, open: null };
function onTap(host, ids, x, y) {
  const fn = host === HOST ? actions.open : tapHandlers.get(host);
  if (typeof fn === 'function') {
    try { fn(ids, { x, y, host }); } catch (e) { console.error('[web-chat] chat-pins: a marker\'s open failed', e); }
    return;
  }
  openPinList(ids, x, y);
}
function draw(group, ctx) {
  const c = group.container;
  if (!c) return;
  const items = Array.isArray(group.items) ? group.items : [];
  const rows = items.map((it) => it.row || {});
  const anyShared = rows.some((r) => r.shared !== false);
  c.classList.add('pin-marker');
  if (!anyShared) c.classList.add('private');
  else if (rows.some((r) => r.shared !== false && r.answered)) c.classList.add('replied');
  const gl = (ctx && ctx.glyph) || CHAT_GLYPH;
  c.innerHTML = pinSvg(gl.w, gl.h) + (items.length > 1 ? `<span class="pin-count">${items.length}</span>` : '');
  const lines = [];
  for (const r of rows) { const l = lineOf(r.answer); if (l && !lines.includes(l)) lines.push(l); }
  c.title = lines.join('\n');
  c.setAttribute('role', 'button');
  c.setAttribute('aria-label', items.length > 1 ? `${items.length} chat pins` : 'Chat pin');
  const ids = items.map((it) => String(it.id));
  c._chatPinIds = ids;
  const host = (ctx && ctx.host) || HOST;
  c.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onTap(host, ids, ev.clientX, ev.clientY);
  });
}

// ── the pin list (a stand-in popover: the chooser's classes) ───────────────
let pop = null;
function closePop() {
  if (pop) { pop.remove(); pop = null; }
}
export function closePinList() { closePop(); }
function quoteOf(rec) {
  const a = isObj(rec.anchor) ? rec.anchor : {};
  const q = isObj(a.quote) && typeof a.quote.exact === 'string' ? a.quote.exact : '';
  const s = (q || str(a.label) || str(rec.anchor_label) || '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}
// openPinList(ids, x, y): each pin with its own quote and its explain line
// (L5 d: readable after the transcript is gone). A row's click is the
// registered open, else the reveal of its turn.
export function openPinList(ids, x, y) {
  const recs = (Array.isArray(ids) ? ids : []).map((id) => records.get(String(id))).filter(Boolean);
  closePop();
  if (!recs.length || typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.className = 'popover pin-pop pin-chooser chat-pin-list';
  el.innerHTML = `<div class="pin-anchor">${recs.length === 1 ? '1 chat pin' : `${recs.length} chat pins`}</div>`
    + recs.map((r) => '<button type="button" class="pin-thread-row" data-id="' + esc(r.id) + '">'
      + '<span class="ptr-dot' + (answeredOf(r) ? ' answered' : '') + (r.shared === false ? ' private' : '') + '"></span>'
      + '<span class="ptr-text"><span class="ptr-quote">' + esc(quoteOf(r)) + '</span>'
      + '<span class="ptr-explain">' + esc(lineOf(answerOf(r))) + '</span></span></button>').join('');
  pop = el;
  document.body.appendChild(el);
  const w = 288;
  const h = 44 + recs.length * 48;
  el.style.left = Math.max(8, Math.min(Number(x) || 0, window.innerWidth - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(Number(y) || 0, window.innerHeight - h - 8)) + 'px';
  for (const b of el.querySelectorAll('.pin-thread-row')) {
    b.addEventListener('click', () => {
      const rec = records.get(b.dataset.id);
      closePop();
      if (!rec) return;
      if (typeof actions.open === 'function') onTap(HOST, [rec.id], x, y);
      else if (isObj(rec.anchor) && known(rec.anchor.conversation_id)) {
        revealTurn({ conversation_id: rec.anchor.conversation_id, turn_id: str(rec.turn_id_now) || rec.anchor.turn_id });
      }
    });
  }
  return el;
}

// ── gone conversations (Q4 b) ───────────────────────────────────────────────
const known = (cid) => !!cid && (mirror.conversations.has(cid) || mirror.status.has(cid));
function gonePins() {
  if (!contentOk() || mirror.availability !== 'ok') return [];
  return [...records.values()].filter((r) => isObj(r.anchor) && typeof r.anchor.conversation_id === 'string'
    && !known(r.anchor.conversation_id));
}

// ── reveal ──────────────────────────────────────────────────────────────────
let reveal = null;                // {cid, tid} waiting for the draw that draws it
let flashOff = null;
function tryReveal() {
  if (!reveal) return false;
  const stream = $('chat-stream');
  const t = followed() === reveal.cid ? turnRoot(stream, reveal.tid) : null;
  if (!t) return false;
  const { tid } = reveal;
  reveal = null;
  try { t.scrollIntoView({ block: 'center' }); } catch { /* no layout */ }
  // The markers are (re)drawn by the overlay's next frame: flash them then.
  if (flashOff) flashOff();
  flashOff = bus.on('overlay:frame', (f) => {
    if (f && f.done === false) return;
    if (flashOff) { flashOff(); flashOff = null; }
    flash(tid);
  });
  return true;
}
function flash(tid) {
  const ids = new Set([...records.values()].filter((r) => isObj(r.anchor)
    && (r.anchor.turn_id === tid || r.turn_id_now === tid)).map((r) => r.id));
  const layer = $('el-layer-chat');
  if (!layer || !ids.size) return;
  for (const m of layer.querySelectorAll('.el-marker')) {
    const mine = (m.dataset.elIds || '').split(' ').some((id) => ids.has(id));
    if (!mine) continue;
    m.classList.remove(FLASH_CLASS);
    m.classList.add(FLASH_CLASS);
    m.addEventListener('animationend', () => m.classList.remove(FLASH_CLASS), { once: true });
  }
}
// revealTurn({conversation_id, turn_id}): follow the conversation (when it is
// not the followed one) and scroll the turn into view on the draw that draws
// it; a turn the stream never draws leaves the chat on its conversation.
export function revealTurn({ conversation_id: cid, turn_id: tid } = {}) {
  if (!str(tid)) return false;
  const want = str(cid) || followed();
  if (!want) return false;
  reveal = { cid: want, tid };
  if (followed() !== want) followConversation(want);
  return tryReveal();
}
// The first draw of the reveal's conversation decides it: one that draws the
// turn reveals it; one that does not ends the reveal, so a turn the stream
// never draws is never scrolled to minutes later (K.2-177 g4).
function onDrawn(d) {
  if (!reveal || !d || d.conversationId !== reveal.cid) return;
  if (Array.isArray(d.turnIds) && d.turnIds.includes(reveal.tid)) tryReveal();
  else reveal = null;
}
function onOpen(d) {
  reveal = null;
  if (!d || d.view !== 'turn' || !str(d.id)) return;
  queueMicrotask(() => revealTurn({ conversation_id: d.conversation_id, turn_id: d.id }));
}

// ── the seams ───────────────────────────────────────────────────────────────
let typeOff = null;
function registerChatType() {
  if (typeOff) { try { typeOff(); } catch { /* the previous one's */ } }
  const spec = { draw, input: 'taps', host: HOST, tool: 'comment', glyph: CHAT_GLYPH };
  if (typeof actions.create === 'function') {
    const create = actions.create;
    spec.create = (input, ctx) => create(input, ctx);
  }
  typeOff = registerElementType(CHAT_TYPE, spec);
}
// registerChatPinActions({create, open}) → unregister: the chat host's create
// (U434's: the type is registered again with it, so the host hears presses)
// and its marker's open (else openPinList).
export function registerChatPinActions(spec) {
  const s = spec || {};
  if ((s.create != null && typeof s.create !== 'function') || (s.open != null && typeof s.open !== 'function')) {
    throw new TypeError('registerChatPinActions takes {create?(input, ctx), open?(ids, {x, y, host})}');
  }
  const mine = { create: s.create || null, open: s.open || null };
  actions = mine;
  if (running) registerChatType();
  return () => {
    if (actions !== mine) return;
    actions = { create: null, open: null };
    if (running) registerChatType();
  };
}
// onMarkerTap(host, fn) → unregister: a marker's click in another host (U433's
// 'turns'): fn(ids, {x, y, host}); none registered, the pin list opens.
export function onMarkerTap(host, fn) {
  if (typeof host !== 'string' || !host || typeof fn !== 'function') throw new TypeError('onMarkerTap takes (host, fn)');
  tapHandlers.set(host, fn);
  return () => { if (tapHandlers.get(host) === fn) tapHandlers.delete(host); };
}

// ── init ────────────────────────────────────────────────────────────────────
let running = false;
let offs = [];
let hostOff = null;
// The host's settle: every trigger that moves a chat element without a
// mutation under #chat-views — the stream's own settle (chat:drawn), the
// panel's move (chat:host), the sheet's stops and views, the breakpoint, the
// posture, and the dock's and the pull's own attributes (the window's move and
// resize, data-mode; --sheet-h, .kb). Two attribute-only observers, released
// with the subscription.
function settle(trigger) {
  const subs = ['chat:drawn', 'chat:host', 'sheet', 'viewport:narrow', 'chat:posture'].map((t) => bus.on(t, () => trigger()));
  subs.push(bus.on('mirror', (d) => {
    const what = d && Array.isArray(d.what) ? d.what : [];
    if (what.includes('conversations') || what.includes('all')) trigger();
  }));
  const observers = new Map();
  const watch = () => {
    if (typeof MutationObserver !== 'function') return;
    for (const id of ['chat-dock', 'chat-pull']) {
      const el = $(id);
      const prev = observers.get(id);
      if (prev && prev.el === el) continue;
      if (prev) prev.mo.disconnect();
      observers.delete(id);
      if (!el) continue;
      const mo = new MutationObserver(() => trigger());
      mo.observe(el, { attributes: true });
      observers.set(id, { el, mo });
    }
  };
  watch();
  subs.push(bus.on('viewport:narrow', watch), bus.on('chat:host', watch));
  return () => {
    for (const off of subs) off();
    for (const o of observers.values()) o.mo.disconnect();
    observers.clear();
  };
}
// The elements whose animations move the stream with no mutation, scroll or
// resize (U432a, C-3C-1): the dock (cd-slide docked, cd-pop windowed: app.css)
// and the phone's pull (its stops' transitions). Read at each animation event,
// as the settle's observers re-read them, so a re-built dock or pull is the
// one named. The overlay follows them frame by frame while one runs and
// re-places the host when the last one ends (registerHost's settle sources).
function animates() {
  return [$('chat-dock'), $('chat-pull')].filter(Boolean);
}
function registerChatHost() {
  if (hostOff) return true;
  const root = $('chat-views');
  if (!root) return false;
  hostOff = registerHost(HOST, {
    root, well: wellOf, rung: '--z-chat-pins', kinds: [...KINDS], glyph: CHAT_GLYPH,
    place: placeRow, hidden: hiddenRow, settle, animates,
  });
  return true;
}

// initChatPins() — idempotent; after the chat panel (main.js), whose
// #chat-views the host is registered over.
export function initChatPins() {
  if (running || typeof document === 'undefined') return;
  running = true;
  levelOk = contentOk();
  registerChatType();
  if (!registerChatHost()) offs.push(bus.on('chat:host', () => registerChatHost()));
  offs.push(
    onHello(() => { refreshChatPins(); }),
    onFrame('reset', () => { refreshChatPins(); }),
    onFrame(`element:${CHAT_TYPE}`, onChatFrame),
    bus.on('mirror', onMirror),
    bus.on('chat:drawn', onDrawn),
    bus.on('chat:open', onOpen),
    registerPopover({ el: () => pop, close: closePop }),
    registerPaletteSource(PALETTE_SOURCE, {
      rows: () => {
        const gone = gonePins();
        if (!gone.length) return [];
        const ids = gone.map((r) => r.id);
        return [{ kind: 'elements', label: goneLabel(gone.length), hint: 'stand-in list',
          run: () => openPinList(ids, Math.max(8, (window.innerWidth - 288) / 2), 80) }];
      },
    }),
  );
  document.addEventListener('visibilitychange', onVisibility);
  refreshChatPins();
}

// stopChatPins(): everything initChatPins set up taken down (a test's, or a
// teardown's): the host, the type, the listeners, the popover.
export function stopChatPins() {
  if (!running) return;
  running = false;
  for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
  document.removeEventListener('visibilitychange', onVisibility);
  if (flashOff) { flashOff(); flashOff = null; }
  closePop();
  if (hostOff) { hostOff(); hostOff = null; }
  if (typeOff) { typeOff(); typeOff = null; }
  seq++;
  records = new Map();
  relay();
  decisions.clear();
  reveal = null;
}

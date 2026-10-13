// The phone's pull (design spec §8.1–§8.4, §8.8): the grip tab and its badge
// riding the bottom bar's top edge, the scrim, and the half/full sheet holding
// Chat | Tasks, below 760px — at every narrow width, a phone or not (§8.1;
// CSS alone shows it: app.css, U68's section).
//
//   initChatSheet()             stamps the markup and starts; idempotent
//   stopChatSheet()             stops it: every listener, the frame, the views
//   openSheet({view = 'chat', page, min = 'open', focus})
//                               min 'open': openStopFor (half; full when an ask
//                               is pending and half is missing or short); 'half':
//                               atLeastHalf. Never lowers an open sheet.
//   closeSheet({returnFocus = true})
//   setStop(px, {view, page})   THE ONE TRANSITION (§8.4)
//   sheetState() → {open, stop, h, view, page, stops}
//   refreshPull()               redraw the tab and the badge (U72, after a dock change)
//   registerSheetView(name, mount) → unregister
//                               mount(api) runs once the sheet is initialised (at
//                               once when it is) and may return a cleanup, run on
//                               unregister and by stopChatSheet. api = {pull, sheet,
//                               scrim, tab, badge, views: {chat, tasks}, openSheet,
//                               closeSheet, setStop, state, pushPage, popPage,
//                               ensurePage, showPage, refresh, on(event, fn) → off}
//                               — on() is a bus listener ('sheet' by default) that
//                               goes with the view
//   pushPage(view, {key, title, sub, back, render, keep}) → {key, page, body} | null
//   popPage(view) → bool · ensurePage(view, spec) → handle · showPage(view, key) → bool
//
// THE MARKUP is a <template class="chat-pull-tpl"> in index.html's pull host
// (ruling B1 (a)). initChatSheet first registers the chat view 'sheet' — the
// stand-in (U22c's) retires itself at its next draw once that view
// exists — then takes out whatever element holds #chat-pull at that moment (the
// stand-in's, which this module never names) and stamps the template in its
// place: #chat-scrim, then #chat-pull, direct children of #stage, so shell.js's
// modality layer makes them inert behind the palette, the graph overlay and the
// replay player with no change there.
//
// ONE FUNCTION MAKES EVERY TRANSITION: setStop (apply, below). It writes
// --sheet-h and --sheet-frac on #chat-pull and --sheet-frac and --chat-top on
// #chat-scrim — NEVER on #stage, where a custom property restyles every pane on
// every drag frame — data-stop (closed, half, full, between), the open class,
// the tab's aria-expanded, the scrim's on class and the sheet's inert (set the
// moment it closes, after focus inside it has gone back to the tab), and emits
// bus 'sheet' {open, stop, view, page}. Every number is sheet-model.js's.
//
// THE CHAT VIEW. The sheet is chat view 'sheet' (chat-slots.js): it calls its
// registration's changed() on every open and close, so the registry sends the
// socket's posture — never this module. On open it announces chat:host
// {host: #sh-chat, variant: 'sheet'} only when the panel is not already there
// (session-control.js remounts #cp-stop's frame on every chat:host, and a moved
// iframe reloads: one announcement per real move). While narrow, chat:open
// opens the sheet on Chat ('awaiting' at openStopFor with the ask pending,
// everything else at least half) and the panel applies the view itself; while
// wide it is the dock's.
//
// OPENING focuses the selected segment, never an input, so the keyboard never
// rises by itself — except chat:open {focus: 'composer'} (M, ⌘K "Chat with
// Claude") on a narrow window that is NOT a phone, which puts the cursor in the
// message box as the desktop dock does (ruling B-defaults (a), U68@m-focus).
// isPhone() is read when it acts (U32's hand-off).
//
// BACK (§8.8), on a phone only: opening from closed pushes {…history.state,
// wcSheet: true}; a UI close calls history.back() when the top entry is ours
// and ignores the popstate that follows; a popstate without wcSheet closes an
// open sheet; init and a flip to wide clear a stale entry with replaceState.
// The chrome's only History API consumer — a second one is the moment to
// extract a back-stack engine.
//
// PAGES. Each view (chat, tasks) keeps a stack: pushPage builds div.sh-page >
// div.sh-phead (button.sh-back, .sh-ptitle, .sh-psub) + div.sh-pbody and calls
// spec.render(body) → cleanup; the page under the top one is `hidden` (the
// detail views pause their followers on it). A `keep` page (ensurePage, or its
// first push) is built once and only hidden on pop — U70's Queue page keeps
// #queue-rail in the document. registerSheetView lets Tasks (U69), the queue
// (U70) and the keyboard (U71) plug in without editing this file.
//
// REDRAWS: bus 'mirror' and 'queue' (and a window resize, which re-measures),
// coalesced to ONE pending animation frame, cancelled by stopChatSheet. A
// closed sheet updates only the tab, the badge and the segment count. No
// interval and no observer; the one timeout is the live region's self-ending
// wake for a held announcement (see announce), cleared by stopChatSheet. Every
// listener is added once at init (or per gesture, in sheet-drag.js) and
// removed by stopChatSheet.
import { bus } from './bus.js';
import { isNarrow, isPhone } from './viewport.js';
import { registerChatView, approvals, composer } from './chat-slots.js';
import { mirror, serverNow } from './chat-state.js';
import { runningCount, ANNOUNCE_GAP_MS } from './chat-present.js';
import {
  computeStops, stopName, openStopFor, atLeastHalf, scrimFrac, tabLook, tabAnnounce, badgeLook, normalizeDock,
} from './sheet-model.js';
import { panelEl } from './chat-panel.js';
import { pendingAsk } from './chat-awaiting.js';
import { attachSheetDrag } from './sheet-drag.js';

export const SHEET_VIEW = 'sheet';
const VIEWS = ['chat', 'tasks'];

let E = null;               // the stamped elements
let running = false;
let reg = null;             // the chat view's registration
let offs = [];              // bus offs and element/window removers
let detachDrag = null;
let frame = null;           // the one pending animation frame
let wantMeasure = false;

let stops = computeStops(0);
let chatTop = 0;
let h = 0;                  // the height last written
let opened = false;         // the open state (h > 0 once settled)
let view = 'chat';
let lastLook = null;
const speech = { at: -Infinity, said: '', held: null, timer: null };   // timer: the one wake for a held text
let backPending = 0;        // history.back() calls of ours whose popstate has not come
let backEntry = false;      // the open sheet's wcSheet entry: true, 'deferred' (a Back is landing), or none

const stacks = { chat: [], tasks: [] };          // [{ key, el, body, cleanup, keep, spec }], top last
const kept = { chat: new Map(), tasks: new Map() };
const sheetViews = [];      // [{ name, mount, cleanup, offs, live }]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isView = (v) => VIEWS.includes(v);

// ── stamping ─────────────────────────────────────────────────────────────────

function stamp() {
  const existing = document.getElementById('chat-pull');
  if (existing && existing.classList.contains('chat-pull')) return true;
  const tpl = document.querySelector('template.chat-pull-tpl');
  if (!tpl || !tpl.content) return false;
  const frag = tpl.content.cloneNode(true);
  if (existing) existing.replaceWith(frag);
  else tpl.before(frag);
  return true;
}

function find() {
  const $ = (id) => document.getElementById(id);
  const pull = $('chat-pull');
  const els = {
    stage: $('stage'), scrim: $('chat-scrim'), pull, badge: $('chat-badge'), tab: $('chat-tab'),
    sheet: $('chat-sheet'), live: $('chat-live'), segChat: $('sh-tab-chat'), segTasks: $('sh-tab-tasks'),
    views: { chat: $('sh-chat'), tasks: $('sh-tasks') },
  };
  if (!pull || !els.scrim || !els.tab || !els.badge || !els.sheet || !els.views.chat || !els.views.tasks) return null;
  els.word = pull.querySelector('.ct-word');
  els.count = pull.querySelector('.ct-count');
  els.badgeN = els.badge.querySelector('.cb-n');
  els.run = els.segTasks ? els.segTasks.querySelector('.sh-run') : null;
  return els;
}

// ── geometry ─────────────────────────────────────────────────────────────────

function rectOf(el) {
  try { return el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null; } catch { return null; }
}

// avail = round(#bottombar top − #topbar bottom), and the topbar's bottom
// inside #stage for the scrim's top.
function measure() {
  const top = rectOf(document.getElementById('topbar'));
  const bar = rectOf(document.getElementById('bottombar'));
  const stage = rectOf(E && E.stage);
  const tb = top ? top.bottom : 0;
  const bt = bar && (bar.top || bar.height) ? bar.top : (typeof window !== 'undefined' ? window.innerHeight : 0);
  stops = computeStops(Math.round(bt - tb));
  chatTop = Math.max(0, Math.round(tb - (stage ? stage.top : 0)));
  return stops;
}

// The height the sheet shows now: its laid-out height mid-settle, else the
// height last written (no layout: jsdom, or not drawn yet).
function rendered() {
  const r = rectOf(E && E.pull);
  return r && r.height > 0 ? Math.round(r.height) : h;
}

function writeGeometry(px) {
  const frac = scrimFrac(px, stops.full);
  E.pull.style.setProperty('--sheet-h', `${px}px`);
  E.pull.style.setProperty('--sheet-frac', String(Math.round(frac * 1000) / 1000));
  E.scrim.style.setProperty('--sheet-frac', String(Math.round(frac * 1000) / 1000));
  E.scrim.style.setProperty('--chat-top', `${chatTop}px`);
  E.pull.dataset.stop = stopName(px, stops);
}

// ── the one transition ───────────────────────────────────────────────────────

const topPage = (v) => { const s = stacks[v]; return s && s.length ? s[s.length - 1].key : null; };

function emitState() {
  bus.emit('sheet', { open: opened, stop: stopName(h, stops), view, page: topPage(view) });
}

const ours = () => { try { const s = history.state; return !!(s && typeof s === 'object' && s.wcSheet); } catch { return false; } };

function clearStaleEntry() {
  if (!ours()) return;
  try {
    const rest = { ...history.state };
    delete rest.wcSheet;
    history.replaceState(Object.keys(rest).length ? rest : null, '');
  } catch { /* no History API */ }
}

// The panel into the sheet's Chat page, once per real move.
function ensureHost() {
  const p = panelEl();
  if (p && !E.views.chat.contains(p)) bus.emit('chat:host', { host: E.views.chat, variant: 'sheet' });
}

function onOpened() {
  window.dispatchEvent(new CustomEvent('wc:close-popovers'));   // one panel at a time, as the dock does
  ensureHost();
  if (isPhone()) pushEntry();
}

// A phone's Back closes the sheet: one wcSheet entry above the page's own.
// While a Back of ours is still landing, the entry under it is about to go:
// the new one is pushed once it has (onPopState).
function pushEntry() {
  if (backPending > 0) { backEntry = 'deferred'; return; }
  if (!ours()) {
    try {
      const s = history.state && typeof history.state === 'object' ? history.state : {};
      history.pushState({ ...s, wcSheet: true }, '');
    } catch { return; }
  }
  backEntry = true;
}

function onClosed({ history: how, returnFocus }) {
  const a = document.activeElement;
  if (a && E.sheet.contains(a)) {
    if (returnFocus) { try { E.tab.focus({ preventScroll: true }); } catch { /* not focusable */ } }
    if (E.sheet.contains(document.activeElement) && typeof document.activeElement.blur === 'function') document.activeElement.blur();
  }
  if (how === 'replace') clearStaleEntry();
  else if (how === 'back' && backEntry === true && backPending === 0 && ours()) {
    backPending += 1;
    try { history.back(); } catch { backPending -= 1; }
  }
  backEntry = false;
}

// THE transition (§8.4). opts: view, page (a kept page's key), drag (a frame
// of a drag: geometry only), history ('back' by default, 'replace', 'none'),
// returnFocus.
function apply(px, { view: v, page, drag = false, history: how = 'back', returnFocus = true } = {}) {
  if (!E) return sheetState();
  const next = clamp(Math.round(Number(px) || 0), 0, Math.max(0, stops.full));
  if (isView(v)) selectView(v);
  if (page && isView(view)) showKept(view, page);
  writeGeometry(next);
  h = next;
  if (drag) {
    if (next > 0) ensureHost();
    return sheetState();
  }
  const was = opened;
  opened = next > 0;
  E.pull.classList.toggle('open', opened);
  E.tab.setAttribute('aria-expanded', opened ? 'true' : 'false');
  E.scrim.classList.toggle('on', opened);
  if (opened) {
    E.sheet.removeAttribute('inert');
    if (!was) onOpened();
  } else {
    if (was) onClosed({ history: how, returnFocus });
    E.sheet.setAttribute('inert', '');
  }
  emitState();
  if (opened !== was && reg) reg.changed();
  return sheetState();
}

export function setStop(px, { view: v, page } = {}) {
  return apply(px, { view: v, page });
}

export function sheetState() {
  return Object.freeze({ open: opened, stop: stopName(h, stops), h, view, page: topPage(view), stops });
}

const active = () => running && isNarrow();

function focusSegment() {
  const seg = view === 'tasks' ? E.segTasks : E.segChat;
  try { seg.focus({ preventScroll: true }); } catch { /* not focusable */ }
}

// The composer, as the desktop dock focuses it (focusChat): the registered one,
// when it takes focus inside the sheet; else the segment.
function focusComposer() {
  const c = composer();
  if (c) {
    try { c.focus(); } catch (e) { console.error('[web-chat] the composer failed to take focus', e); }
    if (E.sheet.contains(document.activeElement)) return true;
  }
  return false;
}

export function openSheet({ view: v = 'chat', page, min = 'open', focus } = {}) {
  if (!active() || !E) return false;
  measure();
  const target = min === 'half' ? atLeastHalf(h, stops)
    : Math.max(h, openStopFor(stops, { askPending: !!pendingAsk() || focus === 'awaiting' }));
  apply(target, { view: isView(v) ? v : 'chat', page });
  if (!(focus === 'composer' && !isPhone() && focusComposer())) focusSegment();
  return true;
}

export function closeSheet({ returnFocus = true } = {}) {
  if (!E) return false;
  if (!opened && h === 0) return false;
  apply(0, { returnFocus });
  return true;
}

// ── segments and pages ───────────────────────────────────────────────────────

function selectView(v) {
  if (!isView(v) || !E) return;
  view = v;
  const chat = v === 'chat';
  E.segChat.classList.toggle('on', chat);
  E.segTasks.classList.toggle('on', !chat);
  E.segChat.setAttribute('aria-selected', chat ? 'true' : 'false');
  E.segTasks.setAttribute('aria-selected', chat ? 'false' : 'true');
  E.views.chat.classList.toggle('hidden', !chat);
  E.views.tasks.classList.toggle('hidden', chat);
}

function onSegment(v) {
  if (view === v) {
    while (stacks[v].length) popPage(v);
    return;
  }
  selectView(v);
  emitState();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function depth(v) {
  const n = stacks[v].length;
  if (n) E.views[v].setAttribute('data-depth', String(n));
  else E.views[v].removeAttribute('data-depth');
}

function build(v, spec) {
  const page = el('div', 'sh-page');
  page.dataset.page = String(spec.key || '');
  page.hidden = true;
  const head = el('div', 'sh-phead');
  const back = el('button', 'sh-back', spec.back || '‹');
  back.type = 'button';
  const title = el('span', 'sh-ptitle', spec.title || '');
  const sub = el('span', 'sh-psub', spec.sub || '');
  head.append(back, title, sub);
  const body = el('div', 'sh-pbody');
  page.append(head, body);
  E.views[v].append(page);
  const entry = { key: spec.key ? String(spec.key) : null, el: page, head, back, title, sub, body, cleanup: null,
    keep: !!spec.keep, spec, view: v };
  back.addEventListener('click', () => { if (stacks[v].includes(entry)) { while (topEntry(v) !== entry) popPage(v); popPage(v); } });
  if (typeof spec.render === 'function') {
    try {
      const r = spec.render(body, entry);
      if (typeof r === 'function') entry.cleanup = r;
    } catch (e) { console.error(`[web-chat] the sheet page '${entry.key || spec.title || '?'}' failed to render`, e); }
  }
  if (entry.keep && entry.key) kept[v].set(entry.key, entry);
  return entry;
}

const topEntry = (v) => stacks[v][stacks[v].length - 1] || null;
const handle = (e) => (e ? Object.freeze({ key: e.key, page: e.el, body: e.body, view: e.view }) : null);

function runCleanup(entry) {
  const fn = entry.cleanup;
  entry.cleanup = null;
  if (!fn) return;
  try { fn(); } catch (e) { console.error(`[web-chat] the sheet page '${entry.key || '?'}' failed to clean up`, e); }
}

function showOnTop(v, entry) {
  const under = topEntry(v);
  if (under && under !== entry) under.el.hidden = true;
  stacks[v].push(entry);
  entry.el.hidden = false;
  depth(v);
}

export function pushPage(v, spec) {
  if (!E || !isView(v) || !spec || typeof spec !== 'object') return null;
  let entry = spec.key ? kept[v].get(String(spec.key)) : null;
  if (entry) {
    if (stacks[v].includes(entry)) {
      while (topEntry(v) !== entry) popPage(v);
      return handle(entry);
    }
  } else {
    entry = build(v, spec);
  }
  showOnTop(v, entry);
  if (v === view) emitState();
  return handle(entry);
}

export function popPage(v) {
  if (!E || !isView(v)) return false;
  const entry = stacks[v].pop();
  if (!entry) return false;
  const hadFocus = entry.el.contains(document.activeElement);
  entry.el.hidden = true;
  if (!entry.keep) {
    runCleanup(entry);
    entry.el.remove();
  }
  const top = topEntry(v);
  if (top) top.el.hidden = false;
  depth(v);
  if (hadFocus && opened) {
    try { (top ? top.back : (v === 'tasks' ? E.segTasks : E.segChat)).focus({ preventScroll: true }); } catch { /* gone */ }
  }
  if (v === view) emitState();
  return true;
}

export function ensurePage(v, spec) {
  if (!E || !isView(v) || !spec || !spec.key) return null;
  const key = String(spec.key);
  const have = kept[v].get(key);
  if (have) return handle(have);
  return handle(build(v, { ...spec, keep: true }));
}

function showKept(v, key) {
  const entry = kept[v].get(String(key));
  if (!entry) return false;
  pushPage(v, entry.spec);
  return true;
}

export function showPage(v, key) {
  if (!E || !isView(v)) return false;
  return showKept(v, key);
}

function dropPages() {
  for (const v of VIEWS) {
    while (stacks[v].length) {
      const entry = stacks[v].pop();
      if (!entry.keep) { runCleanup(entry); entry.el.remove(); }
    }
    for (const entry of kept[v].values()) { runCleanup(entry); entry.el.remove(); }
    kept[v].clear();
    if (E) depth(v);
  }
}

// ── the tab, the badge, the live region ──────────────────────────────────────

function say(text) {
  if (!E || !E.live) return;
  E.live.textContent = text;
  speech.said = text;
}

// tabAnnounce's text, at most once per ANNOUNCE_GAP_MS, the latest winning: a
// text kept from saying is said when the gap ends while its state still holds,
// unless it is the one just said (a flapping socket says 'reconnecting' once).
// The gap's end is ONE self-ending timeout (§10.1), armed while a text is held:
// it schedules a draw, whose announce() says the held text — so a held text is
// said even when the store never changes again. It is cleared when the held
// text is replaced or dropped, and by stopChatSheet.
function dropHold() {
  speech.held = null;
  if (speech.timer !== null) { clearTimeout(speech.timer); speech.timer = null; }
}

function hold(held, now) {
  dropHold();
  if (!held) return;
  speech.held = held;
  speech.timer = setTimeout(() => { speech.timer = null; schedule(); },
    Math.max(0, speech.at + ANNOUNCE_GAP_MS - now));
}

function announce(prev, next) {
  const now = Date.now();
  const text = tabAnnounce(prev, next);
  if (text) {
    if (now - speech.at < ANNOUNCE_GAP_MS) {
      hold(text === speech.said ? null : { text, state: next.state }, now);
      return;
    }
    speech.at = now;
    dropHold();
    say(text);
    return;
  }
  const held = speech.held;
  if (!held) return;
  if (held.state !== next.state) { dropHold(); return; }
  if (now - speech.at >= ANNOUNCE_GAP_MS) {
    speech.at = now;
    dropHold();
    say(held.text);
  } else if (speech.timer === null) hold(held, now);
}

function draw() {
  if (!E) return;
  const look = tabLook(mirror, { now: serverNow(), approvalsReady: !!approvals() });
  const p = E.pull;
  if (p.dataset.csState !== look.state) p.dataset.csState = look.state;
  if (look.quiet) p.dataset.csPace = 'quiet';
  else delete p.dataset.csPace;
  if (E.word && E.word.textContent !== look.word) E.word.textContent = look.word;
  p.style.setProperty('--tab-w', `${look.width}px`);
  const running = runningCount(mirror, { now: serverNow() });
  const level = mirror.access && mirror.access.level;
  const b = badgeLook({ running, working: look.state === 'working', level }, { dock: normalizeDock(p.dataset.dock) });
  E.badge.classList.toggle('off', b.off);
  E.badge.tabIndex = b.off ? -1 : 0;
  if (E.badgeN && E.badgeN.textContent !== b.text) E.badgeN.textContent = b.text;
  E.badge.setAttribute('aria-label', b.label);
  if (E.count) {
    const c = b.tabCount ? String(b.tabCount) : '';
    if (E.count.textContent !== c) E.count.textContent = c;
  }
  const label = `${look.label}${b.tabSuffix}`;
  if (E.tab.getAttribute('aria-label') !== label) E.tab.setAttribute('aria-label', label);
  if (E.run) {
    const r = running > 0 ? `${running} running` : '';
    if (E.run.textContent !== r) E.run.textContent = r;
  }
  announce(lastLook, look);
  lastLook = look;
}

// Re-measure; an open sheet keeps its named stop (half → the new half, or full
// when half went; full → the new full).
function remeasure() {
  const before = stops;
  const name = stopName(h, before);
  measure();
  if (!E || E.pull.classList.contains('dragging')) return;
  if (!opened) { writeGeometry(h); return; }
  let next = h;
  if (name === 'half') next = stops.half === null ? stops.full : stops.half;
  else if (name === 'full') next = stops.full;
  else next = Math.min(h, stops.full);
  if (next !== h) apply(next, { history: 'none' });
  else writeGeometry(h);
}

function runFrame() {
  frame = null;
  if (!running) return;
  if (wantMeasure) { wantMeasure = false; remeasure(); }
  draw();
}

function schedule({ measure: m = false } = {}) {
  if (m) wantMeasure = true;
  if (!running || frame !== null) return;
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== 'function') { runFrame(); return; }
  frame = raf(runFrame);
}

export function refreshPull() { schedule(); }

// ── registered views ─────────────────────────────────────────────────────────

function sheetApi(rec) {
  return Object.freeze({
    pull: E.pull, sheet: E.sheet, scrim: E.scrim, tab: E.tab, badge: E.badge,
    views: Object.freeze({ chat: E.views.chat, tasks: E.views.tasks }),
    openSheet, closeSheet, setStop, state: sheetState, pushPage, popPage, ensurePage, showPage,
    refresh: refreshPull,
    on(event, fn) {
      const off = bus.on(typeof event === 'string' && event ? event : 'sheet', fn);
      rec.offs.push(off);
      return () => { off(); const i = rec.offs.indexOf(off); if (i >= 0) rec.offs.splice(i, 1); };
    },
  });
}

function mountView(rec) {
  if (rec.live) return;
  rec.live = true;
  try {
    const r = rec.mount(sheetApi(rec));
    if (typeof r === 'function') rec.cleanup = r;
  } catch (e) { console.error(`[web-chat] the sheet view '${rec.name}' failed to mount`, e); }
}

function unmountView(rec) {
  if (!rec.live) return;
  rec.live = false;
  for (const off of rec.offs.splice(0)) { try { off(); } catch { /* gone */ } }
  const fn = rec.cleanup;
  rec.cleanup = null;
  if (fn) { try { fn(); } catch (e) { console.error(`[web-chat] the sheet view '${rec.name}' failed to clean up`, e); } }
}

export function registerSheetView(name, mount) {
  if (typeof name !== 'string' || !name || typeof mount !== 'function') {
    throw new TypeError('registerSheetView: expects (name, mount)');
  }
  const rec = { name, mount, cleanup: null, offs: [], live: false };
  sheetViews.push(rec);
  if (running) mountView(rec);
  return () => {
    const i = sheetViews.indexOf(rec);
    if (i < 0) return;
    sheetViews.splice(i, 1);
    unmountView(rec);
  };
}

// ── events ───────────────────────────────────────────────────────────────────

function onTabActivate() {
  if (opened) closeSheet();
  else openSheet({ view: 'chat' });
}

function onTabKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  // Ours, not the button's: preventDefault keeps the browser from also sending
  // the click a key press on a button turns into.
  e.preventDefault();
  if (e.repeat) return;
  onTabActivate();
}

function onTabKeyUp(e) {
  if (e.key === ' ' || e.key === 'Spacebar') e.preventDefault();
}

function onBadge() {
  if (!active()) return;
  while (stacks.tasks.length) popPage('tasks');
  openSheet({ view: 'tasks', min: 'half' });
}

function onChatOpen(d) {
  if (!active()) return;
  const v = d && d.view;
  const focus = d && d.focus;
  if (v === 'awaiting') openSheet({ view: 'chat', min: 'open', focus: focus || 'awaiting' });
  else openSheet({ view: 'chat', min: 'half', focus });
}

function onNarrow(d) {
  if (d && d.narrow === false) {
    // At once: no animation, the entry dropped, 'sheet' {open: false} (U70
    // returns the rail on it, U71 leaves keyboard mode).
    if (E) {
      E.pull.classList.add('dragging');
      if (opened || h > 0) apply(0, { history: 'replace', returnFocus: false });
      else clearStaleEntry();
      E.pull.classList.remove('dragging');
    }
    return;
  }
  schedule({ measure: true });
}

function onPhone() {
  // Back is a phone's: a sheet left open as the window stops being one keeps
  // no entry a later close would go back over.
  if (!isPhone()) { clearStaleEntry(); backEntry = false; }
  schedule({ measure: true });
}

function onPopState(e) {
  if (backPending > 0) {
    // The Back our own close asked for. Reopened before it landed: the open
    // sheet takes its entry now.
    backPending -= 1;
    if (opened && backEntry === 'deferred' && isPhone()) pushEntry();
    return;
  }
  const s = e && e.state;
  if (opened && !(s && s.wcSheet)) apply(0, { history: 'none' });
}

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  offs.push(() => target.removeEventListener(type, fn, opts));
}

// ── start and stop ───────────────────────────────────────────────────────────

export function initChatSheet() {
  if (typeof document === 'undefined') return null;
  if (running) return E;
  // The view first, so the stand-in steps aside at its next draw.
  reg = registerChatView({
    id: SHEET_VIEW,
    isOpen: () => opened,
    escape: () => { if (!opened) return false; closeSheet(); return true; },
    close: () => { closeSheet(); },
  });
  if (!stamp() || !(E = find())) {
    reg.unregister();
    reg = null;
    return null;
  }
  running = true;
  stacks.chat.length = 0;
  stacks.tasks.length = 0;
  view = 'chat';
  selectView('chat');
  h = 0;
  opened = false;
  lastLook = null;
  measure();
  writeGeometry(0);
  clearStaleEntry();

  detachDrag = attachSheetDrag(E.tab, {
    stops: () => measure(),
    height: rendered,
    enabled: () => !E.pull.classList.contains('kb'),
    closed: () => !opened,
    onMove: (px) => { E.pull.classList.add('dragging'); apply(px, { drag: true }); },
    onSettle: (px) => { E.pull.classList.remove('dragging'); apply(px); },
  });
  on(E.tab, 'click', onTabActivate);
  on(E.tab, 'keydown', onTabKey);
  on(E.tab, 'keyup', onTabKeyUp);
  on(E.badge, 'click', onBadge);
  on(E.scrim, 'click', () => closeSheet());
  on(E.segChat, 'click', () => onSegment('chat'));
  on(E.segTasks, 'click', () => onSegment('tasks'));
  on(window, 'resize', () => schedule({ measure: true }));
  on(window, 'popstate', onPopState);
  offs.push(
    bus.on('mirror', () => schedule()),
    bus.on('queue', () => schedule()),
    bus.on('chat:open', onChatOpen),
    bus.on('viewport:narrow', onNarrow),
    bus.on('viewport', onPhone),
  );
  for (const rec of sheetViews) mountView(rec);
  draw();
  return E;
}

export function stopChatSheet() {
  if (!running) return;
  if (frame !== null) {
    const caf = globalThis.cancelAnimationFrame;
    if (typeof caf === 'function') caf(frame);
    frame = null;
  }
  wantMeasure = false;
  if (opened || h > 0) apply(0, { history: 'replace', returnFocus: false });
  for (const rec of sheetViews) unmountView(rec);
  dropPages();
  if (detachDrag) { detachDrag(); detachDrag = null; }
  for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
  running = false;
  dropHold();
  if (reg) { reg.unregister(); reg = null; }
  backPending = 0;
  backEntry = false;
}

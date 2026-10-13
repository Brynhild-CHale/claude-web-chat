// The queue in the phone sheet (design spec §8.7; §8.4's Queue and push-feedback
// rows; §7.8's one Escape owner; deviation 17).
//
//   initSheetQueue()   registers the sheet view 'queue' (chat-sheet.js
//                      registerSheetView); idempotent
//   stopSheetQueue()   unregisters it: the rail goes home, the route and the
//                      view's bus listeners go
//
// THE PAGE is Tasks → Queue, a KEPT page (ensurePage('tasks', {key: 'queue',
// keep: true})): built once and only ever hidden, never removed, so what it
// holds never leaves the document. Its head reads 'Queue' and the queue's
// counts — the queue tray's own sub (chat-present.js categories), '⇢ parked'
// while a push waits for the next message, or 'Nothing queued' — redrawn on bus
// 'queue'. chat-sheet-tasks.js's Queue line shows it (showPage).
//
// THE MOVE. While the window is narrow (at mount when isNarrow(), and on
// viewport:narrow {narrow: true}) #queue-rail itself is MOVED into the page's
// body with the class in-sheet, its parent and next sibling remembered first;
// on {narrow: false} — and on the 'sheet' event chat-sheet.js emits as it
// closes on that flip — it goes back to exactly that place without in-sheet.
// One move per breakpoint crossing, and the element is never cloned or
// rebuilt: queue.js and wake-panel.js find it by id, and shell.js's listeners
// on it were bound once at boot, so every banner, peek, stage, revert, note and
// Push works from the page, and a session that crosses the breakpoint a
// thousand times still holds one set of listeners. A rail left open by the
// wide layout's hover or pin is closed by its own close control (shell.js)
// before it moves, so no stale pin or `.open` rides into the sheet. The queue
// is rendered once, wherever it is: never a second rail, never a copy of one of
// its controls (deviation 17).
//
// THE ROUTE (shell.js setQueueRoute). While the rail is in the sheet and the
// window narrow, the bottom bar's Queue and Q toggle the sheet on Tasks →
// Queue (at least half; again while that page shows, closed), and the opener
// queue.js raises for its push feedback opens it there and never closes it.
// Escape needs nothing here: it reaches the open sheet through shell.js's
// escapeChatViews. #bb-queue keeps 'Queue' as its label; its aria-expanded
// (and its `on` look) says whether the sheet shows Tasks → Queue, from the
// 'sheet' event. With the route unregistered every path is shell.js's own.
import { isNarrow } from './viewport.js';
import { mirror, serverNow } from './chat-state.js';
import { categories } from './chat-present.js';
import { queueSnapshot } from './queue.js';
import { EMPTY_QUEUE_LINE, atLeastHalf } from './sheet-model.js';
import { registerSheetView } from './chat-sheet.js';
import { setQueueRoute } from './shell.js';

export const VIEW = 'queue';
export const TASKS = 'tasks';
export const QUEUE_PAGE = 'queue';

let unregister = null;      // the sheet view's registration
let S = null;               // the mounted view: { api, page, unroute }
let moved = null;           // the rail while it is in the sheet: { rail, parent, next }

const $ = (id) => document.getElementById(id);

// ── the page's head ──────────────────────────────────────────────────────────

// The queue tray's sub ('2 queued · 1 held'), '⇢ parked' while a push waits for
// the next message, or 'Nothing queued'.
function subText(snap) {
  const q = snap && typeof snap === 'object' && Array.isArray(snap.items) ? snap : queueSnapshot();
  const cat = categories(mirror, q, { now: serverNow() }).find((c) => c.cat === 'queue');
  const parts = [];
  if (cat && cat.sub) parts.push(cat.sub);
  if (q.parked) parts.push('⇢ parked');
  return parts.length ? parts.join(' · ') : EMPTY_QUEUE_LINE;
}

function drawSub(snap) {
  if (!S || !S.page) return;
  const el = S.page.page.querySelector('.sh-psub');
  if (!el) return;
  const text = subText(snap);
  if (el.textContent !== text) el.textContent = text;
}

// ── the bottom bar's Queue ───────────────────────────────────────────────────

function queueShown() {
  if (!S) return false;
  const st = S.api.state();
  return !!st.open && st.view === TASKS && st.page === QUEUE_PAGE;
}

function setButton(expanded) {
  const bb = $('bb-queue');
  if (!bb) return;
  const v = expanded ? 'true' : 'false';
  if (bb.getAttribute('aria-expanded') !== v) bb.setAttribute('aria-expanded', v);
  bb.classList.toggle('on', !!expanded);
}

// ── the move ─────────────────────────────────────────────────────────────────

function moveIn() {
  if (moved || !S || !S.page || !isNarrow()) return;
  const rail = $('queue-rail');
  const body = S.page.body;
  if (!rail || !body || body.contains(rail)) return;
  // The wide layout's hover or pin, put down by the rail's own close (shell.js
  // clears its pin and its label with it), before the rail leaves.
  if (rail.classList.contains('open')) {
    const close = rail.querySelector('.rail-close');
    if (close) close.click();
    rail.classList.remove('open');
  }
  moved = { rail, parent: rail.parentNode, next: rail.nextSibling };
  body.append(rail);
  rail.classList.add('in-sheet');
  setButton(queueShown());
}

// Back to exactly the remembered place. Idempotent; also the kept page's
// cleanup, so stopping the sheet never takes the rail out of the document.
function returnRail() {
  const m = moved;
  if (!m) return;
  moved = null;
  const { rail, parent, next } = m;
  rail.classList.remove('in-sheet');
  if (parent && parent.isConnected) {
    if (next && next.parentNode === parent) parent.insertBefore(rail, next);
    else parent.append(rail);
  } else {
    console.error('[web-chat] the queue rail\'s place is gone; it stays in the sheet\'s page');
  }
  // shell.js's own answer again: the rail's open state.
  setButton(rail.classList.contains('open'));
}

// ── the route ────────────────────────────────────────────────────────────────

// Tasks → Queue at least half. Already there: nothing (a Push's feedback must
// not move the focus off the note or the button that sent it).
function openQueue() {
  if (!S) return;
  const st = S.api.state();
  if (queueShown() && atLeastHalf(st.h, st.stops) <= st.h) return;
  if (st.page !== QUEUE_PAGE || st.view !== TASKS) {
    // Queue's Back reads '‹ Tasks': it goes to the root, as the badge's open does.
    while (S.api.popPage(TASKS)) { /* to the root */ }
  }
  S.api.openSheet({ view: TASKS, page: QUEUE_PAGE, min: 'half' });
}

const route = Object.freeze({
  active: () => !!S && !!moved && isNarrow(),
  toggle() {
    if (!S) return;
    if (queueShown()) S.api.closeSheet();
    else openQueue();
  },
  open() { openQueue(); },
});

// ── the view ─────────────────────────────────────────────────────────────────

function onNarrow(d) {
  if (d && d.narrow === false) returnRail();
  else moveIn();
}

function onSheet() {
  if (!isNarrow()) { returnRail(); return; }
  if (moved) setButton(queueShown());
}

function mount(api) {
  const page = api.ensurePage(TASKS, {
    key: QUEUE_PAGE, keep: true, title: 'Queue', sub: '', back: '‹ Tasks',
    render(body) {
      body.classList.add('sh-qbody');
      return returnRail;
    },
  });
  if (!page) return undefined;
  const mine = { api, page, unroute: null };
  S = mine;
  api.on('queue', drawSub);
  api.on('sheet', onSheet);
  api.on('viewport:narrow', onNarrow);
  mine.unroute = setQueueRoute(route);
  drawSub();
  moveIn();
  return () => {
    if (S !== mine) return;
    if (mine.unroute) { mine.unroute(); mine.unroute = null; }
    returnRail();
    const st = api.state();
    if (st.view === TASKS && st.page === QUEUE_PAGE) api.popPage(TASKS);
    S = null;
  };
}

export function initSheetQueue() {
  if (unregister) return true;
  unregister = registerSheetView(VIEW, mount);
  return true;
}

export function stopSheetQueue() {
  const off = unregister;
  unregister = null;
  if (off) off();
}

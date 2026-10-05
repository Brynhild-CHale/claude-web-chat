// The chat stream (design spec §7.10, §15.4, §2.8): the followed conversation's
// turns, drawn inside the panel's #chat-stream (chat-panel.js builds it, empty,
// with #chat-new) and grouped per turn by chat-turns.js.
//
//   initChatStream()        binds #chat-stream and starts listening; idempotent
//   stopChatStream()        stops listening (the drawn turns stay)
//   setToolRenderer(fn)     the tool cards' seam (U38): fn(item, {turn, prev}) →
//                           Element; null puts the generic card back. → restore
//   setPendingRenderer(fn)  the pending messages' seam (§6.6, tranche 4):
//                           fn(container, {conversationId}) into a container after
//                           the last turn, on every queue event, when set, and when
//                           the followed conversation changes; null empties it.
//                           Tranche 2 registers none. → restore
//   stickToBottom()         re-sticks (the composer, after a send)
//
// ONE SOURCE. Every turn comes from chat-state.js — mirror.stream, which that
// store fills itself once the posture is full — and paging asks it too
// (loadOlder). Nothing here fetches turns. Below `read` the stream draws
// nothing (the panel's notice says why).
//
// KEYED. Map(turnId → entry); a turn is rebuilt only when chat-state handed a
// new Turn object for it or its context changed (the viewed node, the turn
// actions, the tool renderer, the node a rewind would set back to). Rebuilding
// keeps the entry's own elements (chat-turns.js), so nothing the user opened
// closes.
//
// SCROLL. The stream is STUCK while it shows its bottom (within 48 px), decided
// again on every user scroll. New content while stuck scrolls into view;
// otherwise it counts into #chat-new ('↓ N new'), whose click scrolls down and
// re-sticks. Expanding a group or a card never scrolls. Older turns: a top
// sentinel (an IntersectionObserver, else a scrollTop < 200 check on scroll)
// first shows turns the store holds but the DOM pruned, then asks loadOlder(),
// one request at a time; turns put in above keep the view where it was (height
// compensation: Safari has no overflow-anchor). At most 150 turns are in the
// DOM, pruned only while stuck.
//
// THE GRAPH LINK. topbar.js emits chrome-bus `view` {activeId, viewedId}; the
// turn whose node is on screen carries the accent rail, and a pill names it
// ('n1.14 ↑') while it is scrolled out of sight. Nothing ever scrolls to it on
// its own.
//
// DELEGATED on #chat-stream: a code block's Copy (drawer.js copyText) and a click
// on a remote image's placeholder (U35's span.md-img-remote), which only then
// becomes an <img>.
import { bus } from './bus.js';
import { mirror, loadOlder, atLeast } from './chat-state.js';
import { renderTurn, turnActionsVersion, setBackNodeOf, onTurnActionsChanged } from './chat-turns.js';
import { hasDetail } from './chat-panel.js';
import { copyText } from './drawer.js';
import { gateImg } from './markdown.js';
import { labelFor } from './labels.js';
import { view } from './state.js';

export const MAX_DOM_TURNS = 150;
export const STUCK_PX = 48;
const TOP_PX = 200;
const REVEAL_STEP = 30;

let S = null;                 // the bound elements
let running = false;
let offs = [];
let observer = null;
let frame = null;

const entries = new Map();    // turn id → { el, turn, key, cache, group }
let cid = null;               // the conversation drawn
let firstId = null;           // the first turn in the DOM
let firstSeq = null;
let stuck = true;
let newCount = 0;
const seen = new Set();       // item ids already drawn (what counts as new)
let olderBusy = false;
let reveal = 0;               // held turns to put back in above, next render
let viewedId = null;
let activeId = null;
let toolRenderer = null;
let rendererRev = 0;
let pendingRenderer = null;

// ── the elements ─────────────────────────────────────────────────────────────

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// Once: the panel is one element for the page's life (it moves between hosts,
// and #chat-stream with it), so the stream binds to it the first time it exists.
function bind() {
  if (S) return true;
  if (typeof document === 'undefined') return false;
  const stream = document.getElementById('chat-stream');
  const newBtn = document.getElementById('chat-new');
  if (!stream) return false;
  const top = el('div', 'st-top');
  top.setAttribute('aria-hidden', 'true');
  const turns = el('div', 'st-turns');
  const pending = el('div', 'st-pending');
  const jumpbar = el('div', 'st-jumpbar');
  const jump = el('button', 'st-jump');
  jump.type = 'button';
  jump.hidden = true;
  jumpbar.append(jump);
  stream.replaceChildren(top, turns, pending, jumpbar);
  S = { stream, newBtn, top, turns, pending, jumpbar, jump };
  stream.addEventListener('scroll', onScroll, { passive: true });
  stream.addEventListener('click', onClick);
  stream.addEventListener('keydown', onKey);
  if (newBtn) newBtn.addEventListener('click', () => stickToBottom());
  jump.addEventListener('click', onJump);
  const IO = globalThis.IntersectionObserver;
  if (typeof IO === 'function') {
    observer = new IO((list) => { if (list.some((e) => e.isIntersecting)) older(); },
      { root: stream, rootMargin: `${TOP_PX}px 0px 0px 0px` });
    observer.observe(top);
  }
  clearAll();
  renderPending();
  return true;
}

// ── scroll ───────────────────────────────────────────────────────────────────

const atBottom = (s) => s.scrollHeight - s.scrollTop - s.clientHeight <= STUCK_PX;
const toBottom = () => { S.stream.scrollTop = S.stream.scrollHeight; };

function showNew() {
  if (!S.newBtn) return;
  if (newCount > 0 && !stuck) {
    S.newBtn.textContent = `↓ ${newCount} new`;
    S.newBtn.hidden = false;
  } else {
    S.newBtn.hidden = true;
    S.newBtn.textContent = '';
  }
}

export function stickToBottom() {
  stuck = true;
  newCount = 0;
  if (!S) return;
  toBottom();
  showNew();
  schedule();   // prune back to 150 now that it is stuck
}

function onScroll() {
  if (!S) return;
  stuck = atBottom(S.stream);
  if (stuck) { newCount = 0; showNew(); }
  if (!observer && S.stream.scrollTop < TOP_PX) older();
  updateJump();
}

// The sentinel: turns the store holds above the DOM's first come back first;
// past them, one older page, one request at a time.
function older() {
  if (!S || olderBusy || !cid) return;
  const turns = mirror.stream.turns;
  const at = firstId ? turns.findIndex((t) => t.id === firstId) : 0;
  if (at > 0) {
    reveal = REVEAL_STEP;
    schedule();
    return;
  }
  const s = mirror.stream;
  if (!s.hasOlder || s.loading || s.conversationId !== cid) return;
  olderBusy = true;
  Promise.resolve()
    .then(() => loadOlder())
    .then((added) => { if (added) reveal = REVEAL_STEP; })
    .catch((e) => console.error('[web-chat] chat stream: older turns failed', e))
    .finally(() => {
      olderBusy = false;
      schedule();
    });
}

// ── the pill to the viewed turn ──────────────────────────────────────────────

function viewedEntry() {
  if (!viewedId) return null;
  let hit = null;
  for (const e of entries.values()) if (e.turn && e.turn.node && e.turn.node.id === viewedId && e.el.isConnected) hit = e;
  return hit;
}

function updateJump() {
  if (!S) return;
  const e = viewedEntry();
  let where = null;
  if (e) {
    const box = S.stream.getBoundingClientRect();
    const r = e.el.getBoundingClientRect();
    if (box.height > 0) {
      if (r.bottom <= box.top) where = 'up';
      else if (r.top >= box.bottom) where = 'down';
    }
  }
  if (!where) {
    S.jump.hidden = true;
    S.jump.textContent = '';
    return;
  }
  const node = e.turn.node;
  S.jump.textContent = `${node.label || labelFor(node.id)} ${where === 'up' ? '↑' : '↓'}`;
  S.jump.title = 'Show the turn whose node is on screen';
  S.jump.hidden = false;
}

function onJump() {
  const e = viewedEntry();
  if (e) e.el.scrollIntoView({ block: 'start' });
  updateJump();
}

// ── delegated clicks ─────────────────────────────────────────────────────────

// The text a code block holds: a diff's lines are blocks with no newline of
// their own.
function codeText(pre) {
  const lines = pre.querySelectorAll('.dl');
  if (lines.length) return [...lines].map((l) => l.textContent).join('\n');
  const code = pre.querySelector('code');
  return (code || pre).textContent;
}

function loadRemoteImage(span) {
  const src = span.getAttribute('data-src') || '';
  // The engine's own gate, again: only a remote http(s) image is fetched, and
  // only on this click.
  if (gateImg(src).kind !== 'remote') return;
  const img = document.createElement('img');
  img.alt = span.textContent || 'image';
  img.referrerPolicy = 'no-referrer';
  img.src = src;
  span.replaceWith(img);
}

function onClick(e) {
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  const copy = t.closest('.ct-copy');
  if (copy && S.stream.contains(copy)) {
    const pre = copy.parentElement && copy.parentElement.querySelector('pre');
    if (!pre) return;
    Promise.resolve(copyText(codeText(pre))).then((ok) => {
      copy.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    return;
  }
  const img = t.closest('span.md-img-remote');
  if (img && S.stream.contains(img)) loadRemoteImage(img);
}

function onKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (t && t.matches && t.matches('span.md-img-remote')) {
    e.preventDefault();
    loadRemoteImage(t);
  }
}

// ── drawing ──────────────────────────────────────────────────────────────────

function clearAll() {
  for (const e of entries.values()) e.el.remove();
  entries.clear();
  seen.clear();
  firstId = null;
  firstSeq = null;
  reveal = 0;
  newCount = 0;
  stuck = true;
  if (S) {
    S.turns.replaceChildren();
    showNew();
    updateJump();
  }
}

function contextKey(turn, ctx) {
  const viewed = !!(viewedId && turn.node && turn.node.id === viewedId);
  return `${viewed ? 1 : 0}|${ctx.actionsRev}|${rendererRev}|${ctx.level}|${ctx.diffDetail ? 1 : 0}|${setBackNodeOf(turn, ctx.turnById)}`;
}

function windowStart(turns) {
  let start = 0;
  if (firstId) {
    const at = turns.findIndex((t) => t.id === firstId);
    if (at >= 0) start = at;
    else if (Number.isFinite(firstSeq)) {
      // The first drawn turn was replaced (an alias) or dropped by the store.
      const next = turns.findIndex((t) => Number.isFinite(t.seq) && t.seq >= firstSeq);
      start = next >= 0 ? next : 0;
    }
  }
  if (reveal > 0) {
    start = Math.max(0, start - reveal);
    reveal = 0;
  }
  if (stuck && turns.length - start > MAX_DOM_TURNS) start = turns.length - MAX_DOM_TURNS;
  return start;
}

function render() {
  if (!running || !bind()) return;
  const s = mirror.stream;
  const level = mirror.access.level;
  if (!atLeast(level, 'read') || !s.conversationId) {
    const had = cid;
    if (entries.size || cid) clearAll();
    cid = null;
    if (had) renderPending();
    return;
  }
  let moved = false;
  if (s.conversationId !== cid) {
    clearAll();
    cid = s.conversationId;
    moved = true;
  }
  const initial = entries.size === 0;
  const turns = s.turns;
  const byId = new Map(turns.map((t) => [t.id, t]));
  const ctx = {
    level,
    viewedId,
    toolRenderer,
    rendererRev,
    actionsRev: turnActionsVersion(),
    diffDetail: hasDetail('diff'),
    turnById: (id) => byId.get(id) || null,
  };
  const start = windowStart(turns);
  const win = turns.slice(start);
  const keep = new Set(win.map((t) => t.id));
  const oldFirst = S.turns.firstElementChild;

  // Out: turns pruned or gone from the store.
  for (const [id, e] of entries) {
    if (keep.has(id)) continue;
    e.el.remove();
    entries.delete(id);
  }

  let changed = false;
  const built = [];
  const fresh = new Set();
  for (const t of win) {
    let e = entries.get(t.id);
    const key = contextKey(t, ctx);
    if (!e) {
      e = { el: null, turn: null, key: null, cache: null, group: null };
      entries.set(t.id, e);
      fresh.add(e);
    }
    if (e.turn !== t || e.key !== key) {
      renderTurn(e, t, ctx);
      e.key = key;
      changed = true;
    }
    built.push(e);
  }

  // In order, with the fewest moves: first the turns from the old first one
  // down (updates and appends), then any put in above it — a prepend, for
  // which the view is held where it was.
  const at = oldFirst ? built.findIndex((e) => e.el === oldFirst) : -1;
  const head = at > 0 ? built.slice(0, at) : [];
  const rest = at > 0 ? built.slice(at) : built;
  let cursor = S.turns.firstElementChild;
  for (const e of rest) {
    if (e.el === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    S.turns.insertBefore(e.el, cursor);
  }
  const before = { h: S.stream.scrollHeight, top: S.stream.scrollTop };
  const anchor = S.turns.firstElementChild;
  for (const e of head) S.turns.insertBefore(e.el, anchor);
  const prepended = head.length;

  // What is new: items not drawn before, and a new turn with none yet, below
  // the old first turn (turns put in above it are history, not news).
  let added = 0;
  const above = new Set(head);
  for (const e of built) {
    const its = e.turn.items || [];
    let count = 0;
    for (const it of its) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      count++;
    }
    if (!count && fresh.has(e) && !its.length) count = 1;
    if (!above.has(e)) added += count;
  }
  firstId = win.length ? win[0].id : null;
  firstSeq = win.length ? win[0].seq : null;

  if (initial) {
    // A conversation's first drawing: everything is already seen, and it opens
    // at its bottom.
    stuck = true;
    newCount = 0;
    toBottom();
  } else if (prepended && !stuck) {
    S.stream.scrollTop = before.top + (S.stream.scrollHeight - before.h);
  } else if (stuck) {
    if (changed || added) toBottom();
  } else if (added) {
    newCount += added;
  }
  showNew();
  if (moved) renderPending();   // another conversation's pending messages
  updateJump();
}

function schedule() {
  if (!running || frame !== null) return;
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== 'function') {
    render();
    return;
  }
  frame = raf(() => {
    frame = null;
    render();
  });
}

function renderPending() {
  if (!S) return;
  if (typeof pendingRenderer !== 'function') {
    if (S.pending.firstChild) S.pending.replaceChildren();
    return;
  }
  try {
    pendingRenderer(S.pending, { conversationId: cid });
  } catch (e) {
    console.error('[web-chat] the pending messages failed to render', e);
  }
}

// ── seams ────────────────────────────────────────────────────────────────────

export function setToolRenderer(fn) {
  const prev = toolRenderer;
  toolRenderer = typeof fn === 'function' ? fn : null;
  rendererRev++;
  schedule();
  return () => {
    if (toolRenderer !== (typeof fn === 'function' ? fn : null)) return;
    toolRenderer = prev;
    rendererRev++;
    schedule();
  };
}

export function setPendingRenderer(fn) {
  const prev = pendingRenderer;
  pendingRenderer = typeof fn === 'function' ? fn : null;
  if (S) {
    S.pending.replaceChildren();
    renderPending();
  }
  return () => {
    if (pendingRenderer !== (typeof fn === 'function' ? fn : null)) return;
    pendingRenderer = prev;
    if (S) {
      S.pending.replaceChildren();
      renderPending();
    }
  };
}

function onView(d) {
  const next = d && typeof d === 'object' ? d : {};
  if (next.viewedId === viewedId && next.activeId === activeId) return;
  viewedId = next.viewedId || null;
  activeId = next.activeId || null;
  schedule();
}

export function initChatStream() {
  if (typeof document === 'undefined') return null;
  if (running) return S ? S.stream : null;
  running = true;
  viewedId = view.viewedId || null;   // until the next `view`
  activeId = view.activeId || null;
  offs = [
    bus.on('mirror', schedule),
    bus.on('view', onView),
    bus.on('queue', renderPending),
    onTurnActionsChanged(schedule),
  ];
  bind();
  render();
  return S ? S.stream : null;
}

export function stopChatStream() {
  for (const off of offs.splice(0)) off();
  if (frame !== null && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(frame);
  frame = null;
  running = false;
}

// The session controls on the mod, in the chat panel's header (design spec
// §15.7 'Session controls', §15.5, §15.6, §7.9 #cp-ops, §8.5; rulings Q10, Q-E,
// Q-C, B1 (a), B-confirm (4); 2026-10-13: D1 (a), D-defaults (a)
// U93@controls-placement-and-timers; notes-C Q-C16..Q-C19).
//
//   initSessionOps({ timers, now })   starts it; idempotent. U94a calls it from
//                                     main.js after initSessionControl.
//                                     `timers` ({setTimeout, clearTimeout}) and
//                                     `now` are test seams (a second call swaps
//                                     them too).
//   stopSessionOps()                  empties #cp-ops, unmounts any frame,
//                                     clears its timers, unlistens
//
// WHERE AND WHEN. Everything goes into #cp-ops — chat-panel.js creates it empty
// and never writes it; app.css hides it while :empty — and ONLY while the
// followed conversation (chat-state's `followed`) has a web-chat mod attached
// (its process.mod), the daemon reports capabilities.mod, the conversation is
// live (not ended) and the viewer may act (session-control's mayAct: class P2,
// §15.5). Otherwise #cp-ops is left empty: tier 1 has no session controls.
// The controls sit here, not in chat-panel.js's session switcher, which has no
// seam for them (ruled D-defaults (a), Q-C19). No new id: classes so-… only.
//
//   (1) THE CONTEXT METER — a bar and '38% · 76k of 200k', amber from 80 %,
//       from the reading the daemon keeps of the mod's session.measure
//       (GET /api/mirror/context, lib/server/routes/mirror-context.js). Read
//       when the panel opens (chat:posture 'full'), when the followed
//       conversation changes, when one of its turns closes, and on the
//       reconnect's snapshot (bus 'mirror' with 'all'): at most once per 2 s,
//       one request in flight, never on a poll of its own. With no reading it
//       is HIDDEN — never guessed from the meta line's cumulative token counts,
//       which are not the context's size (D1 (a): the transcript fallback is not
//       built). The rate limits and the cost never reach the chrome.
//   (2) 'Compact now' — a confirm frame for session-compact. After its 'done'
//       the meter reads 'Compacting…' until the conversation's live state has
//       been 'compacting' and left it, or COMPACT_WAIT_MS (120 s, D-defaults
//       (a), Q-C18) pass: then 'Compaction did not start — run /compact in the
//       terminal'. A 'compacting' the user did not ask for (an auto-compaction)
//       shows the same line, with the same timeout. ONE bounded setTimeout.
//   (3) 'Plan mode' — a confirm frame for session-plan; its tooltip says it
//       also switches the model. While permission_mode is 'plan' it reads
//       'Plan mode on' and offers nothing: only the terminal leaves plan mode
//       (Shift+Tab). No other mode switch, no model or effort control (Q10).
//   (4) '⋯' — ONE .popover (shell.js owns its dismissal: Escape, an outside
//       press, another panel opening; no document listener here) holding
//       Rename… (a one-line input, maxlength 100, whose value becomes
//       session-rename's `name` param in the frame's URL, so the frame shows it
//       before the click), Clear (session-clear) and, only while
//       capabilities.rewind_in_place, Resume ▸ — up to 10 of this project's
//       ended, non-headless conversations by title (session-resume with
//       `target`, that conversation's session id; experimental, Q-E).
// Compact now and Plan mode open the same popover, holding just their frame:
// one frame at a time. A frame's 'done' closes the popover; a refusal stays
// for the user to read. The frame is sized 'sheet' while #cp-ops sits in the
// phone sheet's panel (data-variant="sheet"), else 'panel', as session-control
// sizes #cp-stop; a chat:host move (and the narrow posture flipping) drops an
// open frame and the popover, as a moved iframe reloads anyway.
//
// NEVER: a fetch to an acting route (every action is a frame's: §15.5, C46); a
// write into chat-panel.js's elements outside #cp-ops; innerHTML (textContent
// and classes only); an Escape or outside-press listener on the document; a
// setInterval.
import { bus } from './bus.js';
import { mirror, statusOf } from './chat-state.js';
import { PORT_EVENT } from './asks.js';
import { mountControlFrame, mayAct } from './session-control.js';

export const COMPACT_WAIT_MS = 120_000;
export const METER_GAP_MS = 2000;
export const AMBER_AT = 80;
export const RESUME_MAX = 10;
export const NAME_MAX = 100;
export const CONTEXT_URL = '/api/mirror/context';
export const LABELS = Object.freeze({
  compact: 'Compact now',
  plan: 'Plan mode',
  planTip: 'Also switches the model, as /plan does in the terminal',
  planOn: 'Plan mode on',
  planOnTip: 'leave it in the terminal (Shift+Tab)',
  more: '⋯',
  moreTip: 'More session controls',
  rename: 'Rename…',
  clear: 'Clear',
  resume: 'Resume ▸',
  review: 'Review',
  compacting: 'Compacting…',
  noStart: 'Compaction did not start — run /compact in the terminal',
  noEnded: 'No ended conversations',
  wait: 'Getting the confirm ready…',
  cannot: 'This page may not take that action.',
});
const ACTIVE = new Set(['working', 'compacting', 'question', 'waiting']);

let timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};
let now = () => Date.now();

let inited = null;
let offs = [];
let E = null;               // the built controls (kept while shown)
let shown = null;           // { cid } the controls are drawn for, or null
let frame = null;           // the pending animation frame
let reading = null;         // { cid, context: {tokens, window, percent, at} }
let turnKey = null;         // what says a turn of the followed conversation closed
let wasActive = false;
const F = { inflight: false, again: false, last: -Infinity, timer: null, cid: null };
const C = { cid: null, note: null, seen: false, timer: null };   // the compaction line
// open: the mode shown; closing: the mode just closed, until the task that
// closed it is over (a press's pointerdown and its own listener share that task);
// press: what the last pointerdown on a trigger found open.
const pop = { open: null, closing: null, closingTimer: null, press: null, handle: null, pending: null };

// ── small DOM helpers ───────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function button(cls, text, title) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}
const opsEl = () => (typeof document !== 'undefined' ? document.getElementById('cp-ops') : null);
const sizeOf = () => {
  const ops = opsEl();
  return ops && ops.closest('.chat-panel[data-variant="sheet"]') ? 'sheet' : 'panel';
};

// ── what applies ────────────────────────────────────────────────────────────

function conversationOf(cid) {
  return cid ? mirror.conversations.get(cid) || null : null;
}

// The followed conversation, when the controls apply to it.
function target() {
  const cid = mirror.followed;
  const c = conversationOf(cid);
  if (!c || !c.process || c.process.mod !== true) return null;
  if (!mirror.capabilities || mirror.capabilities.mod !== true) return null;
  const s = statusOf(cid);
  if (!s || s.state === 'ended') return null;
  if (!mayAct()) return null;
  return { cid, c, state: s.state };
}

const planOn = (c) => (c && (c.permission_mode || c.mode)) === 'plan';

// Up to RESUME_MAX ended, non-headless conversations of this project, newest
// first, each with the session id the resume takes.
function endedConversations(cid) {
  const out = [];
  for (const c of mirror.conversations.values()) {
    if (!c || c.id === cid || c.headless === true || typeof c.current_session_id !== 'string' || !c.current_session_id) continue;
    const s = statusOf(c.id);
    if (!s || s.state !== 'ended') continue;
    out.push(c);
  }
  const at = (c) => (Number.isFinite(c.ended_at) ? c.ended_at : (Number.isFinite(c.last_activity_at) ? c.last_activity_at : 0));
  return out.sort((a, b) => at(b) - at(a)).slice(0, RESUME_MAX);
}

// ── the meter ───────────────────────────────────────────────────────────────

const short = (n) => {
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
};

function contextOf(body) {
  const c = body && body.ok === true ? body.context : undefined;
  if (c === null) return null;
  if (!c || typeof c !== 'object') return undefined;
  const ok = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (!ok(c.tokens) || !ok(c.window) || c.window === 0) return undefined;
  const percent = ok(c.percent) ? c.percent : (c.tokens / c.window) * 100;
  return { tokens: c.tokens, window: c.window, percent: Math.min(100, percent), at: ok(c.at) ? c.at : 0 };
}

// Ask for the reading: one in flight, at most once per METER_GAP_MS; a call
// inside the gap is folded into one bounded timeout at its end.
function requestReading() {
  if (!inited || !shown) return;
  if (F.inflight) { F.again = true; return; }
  const wait = F.last + METER_GAP_MS - now();
  if (wait > 0) {
    if (F.timer === null) F.timer = timers.setTimeout(() => { F.timer = null; requestReading(); }, wait);
    return;
  }
  const cid = shown.cid;
  F.inflight = true;
  F.again = false;
  F.last = now();
  F.cid = cid;
  let p;
  try {
    p = globalThis.fetch(`${CONTEXT_URL}?conversation=${encodeURIComponent(cid)}`, { headers: { accept: 'application/json' } });
  } catch { p = Promise.resolve(null); }
  Promise.resolve(p)
    .then((r) => (r && r.ok ? r.json() : null))
    .catch(() => null)
    .then((body) => {
      F.inflight = false;
      if (!inited) return;
      const ctx = contextOf(body);
      // A failed read keeps what was shown; an answer replaces it.
      if (ctx !== undefined && shown && shown.cid === cid) {
        reading = ctx ? { cid, context: ctx } : null;
        drawMeter();
      }
      if (F.again || (shown && shown.cid !== cid)) { F.again = false; requestReading(); }
    });
}

function drawMeter() {
  if (!E) return;
  const ctx = shown && reading && reading.cid === shown.cid ? reading.context : null;
  const note = shown && C.cid === shown.cid ? C.note : null;
  if (!ctx && !note) {
    if (E.meter.isConnected) E.meter.remove();
    return;
  }
  const pct = ctx ? Math.round(ctx.percent) : null;
  E.bar.hidden = !ctx;
  if (ctx) E.fill.style.setProperty('--so-pct', `${pct}%`);
  E.text.textContent = note === 'compacting' ? LABELS.compacting
    : note === 'failed' ? LABELS.noStart
      : `${pct}% · ${short(ctx.tokens)} of ${short(ctx.window)}`;
  if (ctx && !note && pct >= AMBER_AT) E.meter.setAttribute('data-so-level', 'amber');
  else E.meter.removeAttribute('data-so-level');
  if (note) E.meter.setAttribute('data-so-note', note); else E.meter.removeAttribute('data-so-note');
  E.meter.setAttribute('aria-label', ctx && !note ? `Context ${pct}% used: ${ctx.tokens} of ${ctx.window} tokens` : E.text.textContent);
  if (!E.meter.isConnected && E.root.contains(E.compact)) E.root.insertBefore(E.meter, E.root.firstChild);
}

// ── the compaction line ─────────────────────────────────────────────────────

function clearCompact() {
  if (C.timer !== null) { timers.clearTimeout(C.timer); C.timer = null; }
  C.cid = null;
  C.note = null;
  C.seen = false;
}

function startCompact(cid, seen) {
  clearCompact();
  C.cid = cid;
  C.note = 'compacting';
  C.seen = seen;
  C.timer = timers.setTimeout(() => {
    C.timer = null;
    if (C.cid === cid) { C.note = 'failed'; drawMeter(); }
  }, COMPACT_WAIT_MS);
}

// The followed conversation's live state, against the line.
function followCompact(cid, state) {
  if (C.cid !== null && C.cid !== cid) clearCompact();
  if (state === 'compacting') {
    if (C.cid === cid && C.note === 'compacting') C.seen = true;
    else if (!(C.cid === cid && C.note === 'failed' && C.seen)) startCompact(cid, true);
    return;
  }
  if (C.cid === cid && C.seen) {
    // It ran and has ended: the line goes, and the meter is read again.
    clearCompact();
    requestReading();
  }
}

// ── the popover: the ⋯ menu, or one frame ───────────────────────────────────

function unmountFrame() {
  pop.pending = null;
  if (pop.handle) { try { pop.handle.unmount(); } catch { /* gone */ } pop.handle = null; }
  if (E) E.confirm.replaceChildren();
}

function isOpen() {
  return !!E && !E.pop.classList.contains('hidden');
}

// The popover went hidden (here, or by shell.js's dismiss layer).
function onClosed() {
  if (pop.open === null) return;
  // Remembered to the end of this task only: shell.js's dismiss layer closes
  // the popover on a pointerdown (capture, on the document) BEFORE the trigger
  // pressed hears it, and a browser runs this observer between the two.
  pop.closing = pop.open;
  if (pop.closingTimer === null) {
    pop.closingTimer = globalThis.setTimeout(() => { pop.closingTimer = null; pop.closing = null; }, 0);
  }
  pop.open = null;
  unmountFrame();
  if (E) {
    E.body.replaceChildren();
    E.more.setAttribute('aria-expanded', 'false');
  }
}

function closePop() {
  if (!E) return;
  if (!E.pop.classList.contains('hidden')) E.pop.classList.add('hidden');
  if (E.observer) E.observer.takeRecords();
  onClosed();
}

function openPop(mode) {
  if (!E) return;
  if (pop.open !== null) { E.pop.classList.add('hidden'); E.observer.takeRecords(); onClosed(); }
  pop.open = mode;
  E.body.replaceChildren();
  E.pop.classList.remove('hidden');
  E.observer.takeRecords();
  E.more.setAttribute('aria-expanded', mode === 'menu' ? 'true' : 'false');
  // One panel at a time: the dismiss layer closes every other.
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: E.pop } }));
}

function mountFrame(action, params, { onDone } = {}) {
  if (!E || !shown) return false;
  unmountFrame();
  const size = sizeOf();
  E.confirm.setAttribute('data-so-size', size);
  const spec = {
    action, params, layout: 'confirm', size,
    onDone: (outcome) => {
      if (outcome !== 'done') return;
      if (typeof onDone === 'function') onDone();
      closePop();
    },
  };
  const h = mountControlFrame(E.confirm, spec);
  if (!h) {
    // No answer origin yet: asks.js is refreshing the port; PORT_EVENT mounts it.
    E.confirm.replaceChildren(el('p', 'so-wait', mayAct() ? LABELS.wait : LABELS.cannot));
    pop.pending = { action, params, onDone };
    return false;
  }
  pop.handle = h;
  return true;
}

function showFrame(mode, action, params, opts) {
  openPop(mode);
  E.body.append(E.confirm);
  mountFrame(action, params, opts);
}

function showMenu() {
  openPop('menu');
  const list = el('div', 'so-menu');
  list.setAttribute('role', 'menu');
  const rename = button('menu-item so-item', LABELS.rename);
  rename.dataset.so = 'rename';
  rename.setAttribute('role', 'menuitem');
  const clear = button('menu-item so-item', LABELS.clear);
  clear.dataset.so = 'clear';
  clear.setAttribute('role', 'menuitem');
  list.append(rename, clear);
  if (mirror.capabilities && mirror.capabilities.rewind_in_place === true) {
    const resume = button('menu-item so-item', LABELS.resume);
    resume.dataset.so = 'resume';
    resume.setAttribute('role', 'menuitem');
    list.append(resume);
  }
  E.body.append(list);
}

function showRename() {
  const cid = shown && shown.cid;
  if (!cid) return;
  openPop('rename');
  const form = el('div', 'so-rename');
  const input = el('input', 'so-name');
  input.type = 'text';
  input.maxLength = NAME_MAX;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'New name for this session');
  const c = conversationOf(cid);
  if (c && typeof c.title === 'string') input.value = c.title.slice(0, NAME_MAX);
  const go = button('so-btn so-go', LABELS.review);
  const review = () => {
    const name = input.value.replace(/[\r\n]+/g, ' ');
    if (!name.trim()) { unmountFrame(); return; }
    mountFrame('session-rename', { conversation_id: cid, name });
  };
  // The frame shows the name it was minted with: a new keystroke takes it down.
  input.addEventListener('input', unmountFrame);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); review(); } });
  go.addEventListener('click', review);
  form.append(input, go);
  E.body.append(form, E.confirm);
  try { input.focus({ preventScroll: true }); } catch { /* not focusable here */ }
}

function showResume() {
  const cid = shown && shown.cid;
  if (!cid || !(mirror.capabilities && mirror.capabilities.rewind_in_place === true)) return;
  openPop('resume');
  const list = el('ul', 'so-list');
  const ended = endedConversations(cid);
  if (!ended.length) list.append(el('li', 'so-empty', LABELS.noEnded));
  for (const c of ended) {
    const li = el('li');
    const b = button('menu-item so-item', c.title || c.name || 'Untitled session');
    b.dataset.soTarget = c.current_session_id;
    li.append(b);
    list.append(li);
  }
  E.body.append(list, E.confirm);
}

// ── triggers ────────────────────────────────────────────────────────────────

// Which mode a press found open. shell.js's dismiss layer closes the popover
// on the pointerdown BEFORE this trigger hears it (capture on the document), so
// a close in the same task as this pointerdown counts as "it was open": the
// trigger then closes it rather than opening it again.
function onPress() {
  if (E && E.observer) {
    const recs = E.observer.takeRecords();
    if (recs.length && E.pop.classList.contains('hidden')) onClosed();
  }
  pop.press = pop.open !== null ? pop.open : pop.closing;
}
function wasOpen() {
  const m = pop.press !== null ? pop.press : pop.open;
  pop.press = null;
  return m;
}

function onTrigger(mode, open) {
  const was = wasOpen();
  if (was === mode) { closePop(); return; }
  open();
}

function onBodyClick(e) {
  const b = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!b || !E.body.contains(b) || !shown) return;
  const cid = shown.cid;
  if (b.dataset.so === 'rename') showRename();
  else if (b.dataset.so === 'clear') showFrame('clear', 'session-clear', { conversation_id: cid });
  else if (b.dataset.so === 'resume') showResume();
  else if (b.dataset.soTarget) {
    for (const x of E.body.querySelectorAll('.so-item[aria-current]')) x.removeAttribute('aria-current');
    b.setAttribute('aria-current', 'true');
    mountFrame('session-resume', { conversation_id: cid, target: b.dataset.soTarget });
  }
}

// ── the controls ────────────────────────────────────────────────────────────

function build() {
  const root = document.createDocumentFragment();
  const meter = el('span', 'so-meter');
  meter.setAttribute('role', 'status');
  const bar = el('span', 'so-bar');
  bar.setAttribute('aria-hidden', 'true');
  const fill = el('span', 'so-fill');
  bar.append(fill);
  const text = el('span', 'so-text');
  meter.append(bar, text);

  const compact = button('so-btn so-compact', LABELS.compact);
  const plan = button('so-btn so-plan', LABELS.plan, LABELS.planTip);
  const planOnEl = el('span', 'so-plan-on', LABELS.planOn);
  planOnEl.title = LABELS.planOnTip;
  planOnEl.setAttribute('aria-label', `${LABELS.planOn} — ${LABELS.planOnTip}`);
  const more = button('so-btn so-more', LABELS.more, LABELS.moreTip);
  more.setAttribute('aria-label', LABELS.moreTip);
  more.setAttribute('aria-haspopup', 'true');
  more.setAttribute('aria-expanded', 'false');

  const popEl = el('div', 'popover so-pop hidden');
  popEl.setAttribute('role', 'dialog');
  popEl.setAttribute('aria-label', 'Session controls');
  const body = el('div', 'so-body');
  popEl.append(body);
  const confirm = el('div', 'so-confirm');

  for (const t of [compact, plan, more]) t.addEventListener('pointerdown', onPress);
  compact.addEventListener('click', () => onTrigger('compact', () => {
    const cid = shown && shown.cid;
    if (cid) showFrame('compact', 'session-compact', { conversation_id: cid }, { onDone: () => { startCompact(cid, false); drawMeter(); } });
  }));
  plan.addEventListener('click', () => onTrigger('plan', () => {
    const cid = shown && shown.cid;
    if (cid) showFrame('plan', 'session-plan', { conversation_id: cid });
  }));
  more.addEventListener('click', () => onTrigger('menu', showMenu));
  body.addEventListener('click', onBodyClick);

  const observer = new MutationObserver(() => { if (popEl.classList.contains('hidden')) onClosed(); });
  observer.observe(popEl, { attributes: true, attributeFilter: ['class'] });
  root.append(compact, plan, more, popEl);
  return { root: null, frag: root, meter, bar, fill, text, compact, plan, planOn: planOnEl, more, pop: popEl, body, confirm, observer };
}

function teardown() {
  if (!E) return;
  closePop();
  E.observer.disconnect();
  const ops = E.root;
  E = null;
  if (ops) ops.replaceChildren();
}

function draw(t) {
  const ops = opsEl();
  if (!ops) { teardown(); shown = null; return; }
  if (E && E.root !== ops) teardown();
  if (!E) {
    E = build();
    E.root = ops;
    ops.replaceChildren(E.frag);
  }
  // Plan mode: a button, or the words that it is on.
  if (planOn(t.c)) {
    if (E.plan.isConnected) E.plan.replaceWith(E.planOn);
    if (pop.open === 'plan') closePop();
  } else if (E.planOn.isConnected) {
    E.planOn.replaceWith(E.plan);
  }
  // Resume went away under an open list or menu: the menu is drawn again.
  if (pop.open === 'resume' && !(mirror.capabilities && mirror.capabilities.rewind_in_place === true)) closePop();
  drawMeter();
}

function sync() {
  if (frame !== null) { cancelFrame(frame); frame = null; }
  if (!inited) return;
  const t = target();
  if (!t) {
    if (E || shown) {
      teardown();
      const ops = opsEl();
      if (ops && ops.firstChild) ops.replaceChildren();
    }
    shown = null;
    reading = null;
    turnKey = null;
    wasActive = false;
    clearCompact();
    return;
  }
  const changed = !shown || shown.cid !== t.cid;
  if (changed) {
    if (shown) closePop();
    reading = null;
    turnKey = null;
    wasActive = false;
  }
  shown = { cid: t.cid };
  followCompact(t.cid, t.state);
  draw(t);
  // A turn of it closed (its count or open turn moved, or it left an active
  // state): the meter is read again — and when it is first shown.
  const key = `${t.c.open_turn_id || ''}|${Number.isFinite(t.c.turn_count) ? t.c.turn_count : ''}`;
  const active = ACTIVE.has(t.state);
  const closed = (turnKey !== null && key !== turnKey) || (wasActive && !active);
  turnKey = key;
  wasActive = active;
  if (changed || closed) requestReading();
}

function cancelFrame(h) {
  const caf = globalThis.cancelAnimationFrame;
  if (typeof caf === 'function') caf(h);
}

function schedule() {
  if (!inited || frame !== null) return;
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== 'function') { sync(); return; }
  frame = raf(() => { frame = null; sync(); });
}

function onMirror(d) {
  const what = d && Array.isArray(d.what) ? d.what : [];
  // The reconnect's snapshot (a hello's hydrate notifies 'all'): read it again.
  if (what.includes('all') && shown) requestReading();
  schedule();
}

// The panel moved host (the dock, or the phone sheet): an open frame and the
// popover go — the moved iframe would reload — and the controls are redrawn
// at the new size.
function onHost() {
  closePop();
  schedule();
}

function onPosture(d) {
  if (d && d.posture === 'full' && shown) requestReading();
}

function onPort() {
  if (pop.pending && isOpen()) {
    const p = pop.pending;
    mountFrame(p.action, p.params, { onDone: p.onDone });
  }
  schedule();
}

export function initSessionOps({ timers: t, now: n } = {}) {
  if (t && typeof t.setTimeout === 'function' && typeof t.clearTimeout === 'function') timers = t;
  if (typeof n === 'function') now = n;
  if (inited) return inited;
  inited = { stop: stopSessionOps };
  offs = [
    bus.on('mirror', onMirror),
    bus.on('chat:host', onHost),
    bus.on('chat:posture', onPosture),
    bus.on('viewport:narrow', onHost),
    bus.on(PORT_EVENT, onPort),
  ];
  sync();
  return inited;
}

export function stopSessionOps() {
  for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
  if (frame !== null) { cancelFrame(frame); frame = null; }
  if (F.timer !== null) { timers.clearTimeout(F.timer); F.timer = null; }
  F.inflight = false;
  F.again = false;
  F.last = -Infinity;
  clearCompact();
  teardown();
  const ops = opsEl();
  if (ops && ops.firstChild) ops.replaceChildren();
  shown = null;
  reading = null;
  turnKey = null;
  wasActive = false;
  pop.open = null;
  pop.press = null;
  if (pop.closingTimer !== null) { globalThis.clearTimeout(pop.closingTimer); pop.closingTimer = null; }
  pop.closing = null;
  inited = null;
}

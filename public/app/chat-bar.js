// The chat mirror's 28px desktop status bar (design spec §7.5): what Claude is
// doing right now, along the bottom of the chrome, 760px and wider.
//
//   initChatBar()  starts it: renders #chat-statusbar now, then on every `mirror`,
//                  `queue` and `chat:posture` bus event (coalesced to one animation
//                  frame) and on ONE ticker; idempotent. main.js calls it once the
//                  store runs.
//   stopBar()      stops it: the ticker, the pending frame, the listeners.
//   claimChips()   the trays take #cs-chips over (see "the chips") → release
//
// WHAT IT SAYS is never decided here. chat-present.js's uiState words the store
// (chat-state.js), so the bar, the chat panel's strip and the phone's tab never
// disagree: the step is `head` with `meta` (a running clock or "4m ago") beside
// it, its title the whole line, and the bar carries `data-cs-state` and
// `data-cs-pace`, from which app.css takes every ink and pulse. Four transitions
// are spoken through #cs-live, at most one per 2 s (chat-present's announce).
//
// THE TICKER is a single setInterval(tick, 1000), unref'd where the runtime has
// unref (as version.js's poller is). A perpetual chrome timer is never a
// setTimeout chain: the jsdom suites that boot main.js stop the chrome's pollers
// by stubbing setInterval alone, and a chain would outlive their teardown (spec
// §10.1). A tick redraws only when something moves: every tick while a running
// clock shows and the page is visible, every 30th otherwise, at once when a
// registration seam changed, and while an announcement waits out its gap.
//
// THE STEP opens the chat: chat:open {view: 'chat', focus: 'composer'}, or, with
// the chat open, closes it. The graph overlay closes first: the chat would open
// under it. THE ACT AREA: Answer › (a question) and Review › (a permission or a
// plan) open the chat on what Claude waits for, chat:open {view: 'awaiting', id};
// where an answer frame may answer it (approvals().mountBar), the frame takes
// #cs-act and the step names only the tool. #cs-stop stays the Stop control's
// (spec §15.5): this module never writes it. ANOTHER conversation waiting on the
// user gets one chip before the divider; a click follows that conversation.
//
// THE CHIPS are the trays' (chat-trays.js): they claim #cs-chips at boot
// (claimChips) and the bar never writes there; released, it stays empty, and
// app.css hides it. #cs-tray is the trays' tray alone.
//
// THE FALLBACKS, should a chrome module fail before it registers: with no chat
// view (chat-slots registerChatView) the step is a plain label, disabled, that
// opens nothing; with no answer frame (chat-slots registerApprovals) a
// question, permission or plan waiting reads "Answer in the terminal".
//
// Below 760px the bar is not displayed, and that is app.css's alone: this
// module never asks the width.
import { bus } from './bus.js';
import { mirror, serverNow, followConversation } from './chat-state.js';
import { uiState, announce, createAnnounceGate } from './chat-present.js';
import { chatViews, closeChatViews, approvals } from './chat-slots.js';
import { isOverlayOpen, closeOverlay } from './graph-view.js';

const TICK_MS = 1000;
const SLOW_TICKS = 30;     // a still line (no running clock, or a hidden page) is redrawn every 30th tick

const TERMINAL_NOTE = 'Answer in the terminal';

let els = null;            // the bar's elements, while it runs
let ticker = null;
let ticks = 0;
let frame = null;          // the pending animation frame
let offs = [];             // bus unsubscribers
let shown = null;          // the uiState on screen
let clocking = false;      // a clock that moves every second is on screen
let seamsSeen = '';        // the registration seams at the last render…
let implSeen = null;       // …and the approvals provider they held
const gate = createAnnounceGate();

let actKey = null;         // what #cs-act holds, so it is rebuilt only when that changes
let mounted = null;        // { impl, id }: the answer frame in #cs-act
let refused = null;        // { impl, id, version }: an ask whose frame would not mount, not asked again
let other = null;          // the other-conversation chip, while one waits
let chipsClaim = null;     // the trays' claim on #cs-chips (claimChips); outlives a stop

const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
function setAttr(el, name, value) {
  if (value === null) el.removeAttribute(name);
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function refocus(el) {
  try { el.focus({ preventScroll: true }); } catch { /* detached, or no focus on this platform */ }
}

// ── the registration seams ───────────────────────────────────────────────────

function seams() {
  const views = chatViews();
  return { views: views.length > 0, open: views.some((v) => v.open), impl: approvals() };
}
const seamKey = (s) => `${s.views ? 1 : 0}${s.open ? 1 : 0}${s.impl ? 1 : 0}`;

// ── the answer frame (approvals().mountBar) ──────────────────────────────────

// True while the frame for this ask is in #cs-act. A provider that will not
// mount one (an ask it cannot answer here) is asked again only when the ask
// changes (its version) or another provider registers, never on every tick.
function mountFrame(impl, ask) {
  const id = ask && ask.id;
  if (!impl || !id) return false;
  if (mounted && mounted.impl === impl && mounted.id === id) return true;
  const version = Number.isFinite(ask.version) ? ask.version : 0;
  if (refused && refused.impl === impl && refused.id === id && refused.version === version) return false;
  unmountFrame();
  els.act.replaceChildren();
  actKey = null;
  let ok = false;
  try { ok = !!impl.mountBar(els.act, ask); } catch (e) {
    console.error('[web-chat] the answer frame failed to mount in the status bar', e);
  }
  if (ok) {
    mounted = { impl, id };
    refused = null;
    return true;
  }
  refused = { impl, id, version };
  els.act.replaceChildren();   // whatever a refused mount left behind
  return false;
}

function unmountFrame() {
  if (!mounted) return;
  const { impl } = mounted;
  mounted = null;
  try { impl.unmount(els.act); } catch (e) {
    console.error('[web-chat] the answer frame failed to unmount from the status bar', e);
  }
  els.act.replaceChildren();
  actKey = null;
}

// ── painting ─────────────────────────────────────────────────────────────────

function paintStep(s, seam) {
  setText(els.text, s.head);
  setText(els.meta, s.meta);
  setAttr(els.step, 'title', s.text);
  if (seam.views) {
    if (els.step.disabled) els.step.disabled = false;
    setAttr(els.step, 'aria-controls', 'chat-dock');
    setAttr(els.step, 'aria-expanded', String(seam.open));
    setAttr(els.step, 'aria-keyshortcuts', 'M');
  } else {
    // No chat to open: a plain label, which controls and promises nothing.
    if (!els.step.disabled) els.step.disabled = true;
    setAttr(els.step, 'aria-controls', null);
    setAttr(els.step, 'aria-expanded', null);
    setAttr(els.step, 'aria-keyshortcuts', null);
  }
}

function terminalNote() {
  const note = document.createElement('span');
  note.className = 'cs-act-note';
  note.textContent = TERMINAL_NOTE;
  return note;
}

function openButton(act, id) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = act === 'answer' ? 'cs-answer' : 'cs-review';
  b.textContent = act === 'answer' ? 'Answer ›' : 'Review ›';
  b.setAttribute('aria-label', act === 'answer' ? 'Answer: open the question in the chat' : 'Review: open the request in the chat');
  if (id) b.dataset.ask = id;
  return b;
}

// Rebuilt only when what it shows changes, so a focused Review › survives the
// ticker. Never touched while the answer frame is mounted: it is the frame's.
function paintAct(s, seam) {
  if (mounted) return;
  const waits = s.act === 'answer' || s.act === 'review';
  const note = waits && !seam.impl;
  const opens = waits && seam.views ? s.act : '';
  const id = (s.ask && s.ask.id) || '';
  const key = waits ? `${s.act}|${id}|${note ? 1 : 0}|${opens}` : '';
  if (key === actKey) return;
  actKey = key;
  const nodes = note ? [terminalNote()] : [];
  if (opens) nodes.push(openButton(opens, id));
  els.act.replaceChildren(...nodes);
}

function paintOther(s) {
  const list = s.others || [];
  const o = list[0];
  if (!o) {
    if (other) other.remove();
    other = null;
    return;
  }
  if (!other || !other.isConnected) {
    other = document.createElement('button');
    other.type = 'button';
    other.className = 'cs-other';
    const dot = document.createElement('span');
    dot.className = 'cs-dot';
    dot.setAttribute('aria-hidden', 'true');
    other.append(dot, document.createElement('span'));
    els.div.before(other);
  }
  setAttr(other, 'data-cs-state', o.state === 'question' ? 'question' : 'waiting');
  other.dataset.conversation = o.id;
  setText(other.lastChild, list.length === 1 ? 'other session · needs you' : `${list.length} other sessions · need you`);
  setAttr(other, 'title', `${o.title ? `“${o.title}”` : 'Another Claude session'} is waiting on you — follow it here`);
}

function render() {
  if (frame !== null) {
    cancelFrame(frame);
    frame = null;
  }
  if (!els) return;
  const seam = seams();
  seamsSeen = seamKey(seam);
  implSeen = seam.impl;
  const now = serverNow();
  let s = uiState(mirror, { now, approvalsReady: !!seam.impl });
  // A frame that will not mount leaves the wording for no frame: the full request.
  if (s.act === 'approve' && !mountFrame(seam.impl, s.ask)) s = uiState(mirror, { now, approvalsReady: false });
  if (s.act !== 'approve') unmountFrame();
  setAttr(els.bar, 'data-cs-state', s.key);
  setAttr(els.bar, 'data-cs-pace', s.pace);
  paintStep(s, seam);
  paintAct(s, seam);
  paintOther(s);
  const said = announce(shown, s, { gate });
  if (said) els.live.textContent = said;
  shown = s;
  clocking = s.key === 'offline' || (s.key === 'working' && s.pace !== 'quiet');
}

// ── scheduling ───────────────────────────────────────────────────────────────

function cancelFrame(h) {
  const caf = globalThis.cancelAnimationFrame;
  if (typeof caf === 'function') caf(h);
}

// Every event of one frame is one render.
function schedule() {
  if (!els || frame !== null) return;
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

function tick() {
  // The document is gone (a test's teardown): this ticker has nothing to draw on.
  if (typeof document === 'undefined' || !els || !els.bar.isConnected) {
    stopBar();
    return;
  }
  ticks += 1;
  const seam = seams();
  const visible = document.visibilityState !== 'hidden';
  if (seamKey(seam) !== seamsSeen || seam.impl !== implSeen || gate.held
    || (clocking && visible) || ticks % SLOW_TICKS === 0) render();
}

// ── clicks ───────────────────────────────────────────────────────────────────

function onStep() {
  const views = chatViews();
  if (!views.length) return;   // a plain label: no chat to open
  const covered = isOverlayOpen();
  if (covered) {
    closeOverlay();   // the chat opens under the graph: the graph goes first
    refocus(els.step);
  }
  // An open chat under the graph was out of sight: the click shows it, never shuts it.
  if (!covered && views.some((v) => v.open)) closeChatViews();
  else bus.emit('chat:open', { view: 'chat', focus: 'composer' });
  schedule();
}

function openAwaiting(btn) {
  if (isOverlayOpen()) {
    closeOverlay();
    refocus(btn);
  }
  const id = btn.dataset.ask;
  bus.emit('chat:open', id ? { view: 'awaiting', id } : { view: 'awaiting' });
}

function onClick(e) {
  const t = e.target;
  const btn = t && typeof t.closest === 'function' ? t.closest('button') : null;
  if (!btn || !els || !els.bar.contains(btn)) return;
  if (btn === els.step) onStep();
  else if (btn.classList.contains('cs-answer') || btn.classList.contains('cs-review')) openAwaiting(btn);
  else if (btn.classList.contains('cs-other')) {
    if (btn.dataset.conversation) followConversation(btn.dataset.conversation);
    schedule();
  }
}

// ── the module's surface ─────────────────────────────────────────────────────

export function initChatBar() {
  if (els || typeof document === 'undefined') return;
  const $ = (id) => document.getElementById(id);
  const bar = $('chat-statusbar');
  const found = bar && {
    bar, step: $('cs-step'), text: $('cs-step-text'), meta: $('cs-step-meta'), act: $('cs-act'),
    chips: $('cs-chips'), live: $('cs-live'), div: bar.querySelector('.cs-div'),
  };
  if (!found || Object.values(found).some((el) => !el)) return;   // a page from before the bar
  els = found;
  other = bar.querySelector('.cs-other');
  bar.addEventListener('click', onClick);
  offs = [bus.on('mirror', schedule), bus.on('queue', schedule), bus.on('chat:posture', schedule)];
  ticks = 0;
  ticker = setInterval(tick, TICK_MS);
  if (ticker && typeof ticker === 'object' && typeof ticker.unref === 'function') ticker.unref();
  render();
}

export function stopBar() {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
  if (frame !== null) {
    cancelFrame(frame);
    frame = null;
  }
  for (const off of offs.splice(0)) off();
  if (els && typeof document !== 'undefined') {
    els.bar.removeEventListener('click', onClick);
    unmountFrame();
  }
  els = null;
  mounted = null;
  refused = null;
  other = null;
  actKey = null;
  shown = null;
  clocking = false;
}

// The trays take #cs-chips over: the bar never writes there, not even an
// attribute of the trays' own chips. Released, #cs-chips is left as it is (the
// trays empty it first), and there is nothing for the bar to put back. A second
// claim takes over from the first, whose release then does nothing.
export function claimChips() {
  const claim = {};
  chipsClaim = claim;
  return function release() {
    if (chipsClaim === claim) chipsClaim = null;
  };
}

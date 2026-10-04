// The chat mirror's 28px desktop status bar (design spec §7.5): what Claude is
// doing right now, along the bottom of the chrome, 760px and wider.
//
//   initChatBar()  starts it: renders #chat-statusbar now, then on every `mirror`,
//                  `queue` and `chat:posture` bus event (coalesced to one animation
//                  frame) and on ONE ticker; idempotent. main.js calls it once the
//                  store runs.
//   stopBar()      stops it: the ticker, the pending frame, the listeners.
//   claimChips()   the trays take #cs-chips over (see "stand-ins") → release
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
// STAND-INS (the maintainer's ruling of 2026-10-02): what a later build brings
// is on the bar already, saying it is under development, and each stand-in goes
// by itself the moment the real thing registers:
//
//   * the step, with no chat view registered (chat-slots registerChatView), is
//     enabled and opens the "Under development" note;
//   * five muted chips, shells · agents · workflows · monitors · queue, with no
//     count and no pulse, each opening the note with its own line, until the
//     trays call claimChips() (no chat-slots seam fits the chips, so the bar
//     keeps the decision behind that one export);
//   * a question, permission or plan waiting with no answer frame registered
//     (chat-slots registerApprovals) reads "Answer in the terminal", with the
//     hint that answering from the browser is under development.
//
// The note is one .popover, so the shell's dismiss layer closes it (Esc, an
// outside click, another panel opening). It borrows the trays' reserved id,
// #cs-tray (every stand-in's aria-controls), and is built only while no #cs-tray
// exists: the trays' own tray replaces it, and is never written here.
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

// The stand-ins' words: "Under development" and one line saying what is coming.
const NOTE_TITLE = 'Under development';
const NOTE_LINES = {
  chat: 'Talking to Claude from this page lands in a later 0.8.5 build; for now the bar shows what Claude is doing.',
  tasks: 'Background shells, agents, workflows and monitors show here in a later 0.8.5 build.',
  queue: 'Messages queued for Claude show here in a later 0.8.5 build.',
};
// The five chips, in the trays' fixed order (spec §7.3): category, its note line,
// and what its tooltip calls it.
const STAND_IN_CHIPS = [
  ['shells', 'tasks', 'Background shells'],
  ['agents', 'tasks', 'Agents'],
  ['workflows', 'tasks', 'Workflows'],
  ['monitors', 'tasks', 'Monitors'],
  ['queue', 'queue', 'Messages queued for Claude'],
];
const TERMINAL_NOTE = 'Answer in the terminal';
// The hint, one sentence in two halves: app.css lets the lead give way when the
// row is short and never the tail, so "under development" shows at every width.
const TERMINAL_HINT = ['answering from the browser is', 'under development'];

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
let noteOpener = null;     // the stand-in that opened the note

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

// ── the note the stand-ins open ──────────────────────────────────────────────

function ownNote() {
  const el = document.getElementById('cs-tray');
  return el && el.classList.contains('cs-dev') ? el : null;
}

// The note, built on first need. Never a second #cs-tray: once the trays' own
// is on the page, there is no note to build.
function notePopover() {
  const mine = ownNote();
  if (mine || !els || document.getElementById('cs-tray')) return mine;
  const p = document.createElement('div');
  p.id = 'cs-tray';
  p.className = 'popover cs-dev hidden';
  p.setAttribute('role', 'status');
  const title = document.createElement('div');
  title.className = 'cs-dev-title';
  title.textContent = NOTE_TITLE;
  const line = document.createElement('p');
  line.className = 'cs-dev-line';
  p.append(title, line);
  els.bar.after(p);   // a child of #stage, among the panels: the modality layer keeps it live
  return p;
}

const noteOpen = (p) => !!p && !p.classList.contains('hidden');

// aria-expanded on the bar's own stand-ins, true on the one whose note is
// showing, and on nothing else: the five muted chips (none once the trays claim
// #cs-chips), and the step while it controls the note (with a chat view,
// paintStep gives it the chat's). Never every [aria-controls="cs-tray"]: the
// trays' own chips carry that too (spec §7.6), and their state is theirs alone.
function markStandIns() {
  if (!els) return;
  const open = noteOpen(ownNote());
  const mark = (t) => setAttr(t, 'aria-expanded', String(open && t === noteOpener));
  if (els.step.getAttribute('aria-controls') === 'cs-tray') mark(els.step);
  for (const t of els.chips.querySelectorAll('.cs-devchip')) mark(t);
}

function closeNote() {
  const p = ownNote();
  noteOpener = null;
  if (p) p.classList.add('hidden');
  markStandIns();
}

// A stand-in's click: show its line in the note, above the step or above the
// chips; the same stand-in again closes it, another swaps the line.
function toggleNote(trigger, line, anchor) {
  const p = notePopover();
  if (!p) return;
  const covered = isOverlayOpen();
  if (covered) {
    closeOverlay();   // the note would open under the graph
    refocus(trigger);
  }
  if (!covered && noteOpen(p) && noteOpener === trigger) {
    closeNote();
    return;
  }
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: p } }));
  noteOpener = trigger;
  p.dataset.csAnchor = anchor;
  p.classList.remove('hidden');
  p.querySelector('.cs-dev-line').textContent = NOTE_LINES[line] || '';   // after showing: role=status reads it
  markStandIns();
}

// Is this element (still) a stand-in on the bar?
function isStandIn(el, seam) {
  if (!el || !els) return false;
  if (el === els.step) return !seam.views;
  return el.classList.contains('cs-devchip') && el.isConnected && !chipsClaim;
}

// After a render: the note exists while any stand-in shows, and goes when the
// one that opened it is no stand-in any more (the chat or the trays arrived).
function syncNote(seam) {
  const standing = !seam.views || !chipsClaim;
  const p = standing ? notePopover() : ownNote();
  if (p && noteOpen(p) && !isStandIn(noteOpener, seam)) closeNote();
  else markStandIns();
}

// ── painting ─────────────────────────────────────────────────────────────────

function paintStep(s, seam) {
  setText(els.text, s.head);
  setText(els.meta, s.meta);
  setAttr(els.step, 'title', s.text);
  if (seam.views) {
    setAttr(els.step, 'aria-controls', 'chat-dock');
    setAttr(els.step, 'aria-expanded', String(seam.open));
    setAttr(els.step, 'aria-keyshortcuts', 'M');
  } else {
    // The stand-in: enabled, and its aria-expanded is the note's (markStandIns).
    setAttr(els.step, 'aria-controls', 'cs-tray');
    setAttr(els.step, 'aria-keyshortcuts', null);
  }
}

function terminalNote() {
  const [leadText, tailText] = TERMINAL_HINT;
  const sentence = `${leadText} ${tailText}`;
  const title = sentence.charAt(0).toUpperCase() + sentence.slice(1);   // the whole hint, wherever the row cuts it
  const note = document.createElement('span');
  note.className = 'cs-act-note';
  note.textContent = TERMINAL_NOTE;
  note.title = title;
  const lead = document.createElement('span');
  lead.className = 'cs-act-hint-lead';
  lead.textContent = leadText;
  lead.title = title;
  const tail = document.createElement('span');
  tail.className = 'cs-act-hint-tail';
  tail.textContent = tailText;
  const hint = document.createElement('span');
  hint.className = 'cs-act-hint';
  hint.append(lead, ' ', tail);   // its text stays the one sentence
  return [note, hint];
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
  const nodes = note ? terminalNote() : [];
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

function paintChips() {
  if (chipsClaim || els.chips.querySelector('.cs-devchip')) return;
  for (const [cat, line, what] of STAND_IN_CHIPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cs-devchip';
    b.dataset.csCat = cat;
    b.dataset.line = line;
    b.setAttribute('aria-controls', 'cs-tray');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', `${cat}: under development`);
    b.title = `${what}: under development`;
    const dot = document.createElement('span');
    dot.className = 'cs-devchip-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'cs-devchip-label';
    label.textContent = cat;
    b.append(dot, label);
    els.chips.append(b);
  }
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
  paintChips();
  syncNote(seam);
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
  if (!views.length) {
    toggleNote(els.step, 'chat', 'step');
    return;
  }
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
  } else if (btn.classList.contains('cs-devchip')) toggleNote(btn, btn.dataset.line, 'chips');
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
    closeNote();
  }
  els = null;
  mounted = null;
  refused = null;
  other = null;
  noteOpener = null;
  actKey = null;
  shown = null;
  clocking = false;
}

// The trays take #cs-chips over: the five stand-ins go at once, and the bar
// never writes there again, not even an attribute of the trays' own chips,
// until the returned release() is called. A second claim takes over from the
// first, whose release then does nothing.
export function claimChips() {
  const claim = {};
  chipsClaim = claim;
  if (els) {
    for (const b of els.chips.querySelectorAll('.cs-devchip')) b.remove();
    syncNote(seams());
  }
  return function release() {
    if (chipsClaim !== claim) return;
    chipsClaim = null;
    schedule();
  };
}

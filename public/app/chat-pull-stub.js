// The phone's grip tab, as an "Under development" stand-in (design spec §8.2–§8.3;
// the maintainer's ruling of 2026-10-02 for the 0.8.5 alpha installs).
//
// The ruling: every top- or bottom-bar element that a later 0.8.5 build delivers
// is on screen from the first alpha and says it is under development, instead of
// being absent. On a phone the chat lives behind a grip tab riding the bottom
// bar; the real tab, its running-tasks badge, its sheet and its drag-to-dock come
// with the phone chrome. Until then this stub, and only on a phone:
//
//   * draws the tab where the real one will sit — on the bottom bar's top edge,
//     right-justified (app.css, its own section) — in the state the desktop
//     status bar shows: uiState() (chat-present.js) over the one store
//     (chat-state.js), redrawn on the store's `mirror` event and never on a timer
//     of its own. While Claude waits on the user it widens to NEEDS YOU or
//     QUESTION, and another session waiting outranks a calmer one (§8.3: several
//     conversations collapse into the most urgent state);
//   * opens one small "Under development" note on a tap (#chat-sheet). The note
//     is a `.popover`, so the shell's dismiss layer closes it on Escape, an
//     outside tap or the window losing focus (shell.js), and the tab's
//     aria-controls keeps a second tap a toggle instead of a close-and-reopen;
//   * shows no running-tasks badge, and has no drag and no dock.
//
// ONLY ON A PHONE: viewport.js's isPhone() and its `viewport` event say where the
// phone layout applies (the stub asks no media query of its own), and app.css
// draws the tab only inside the narrow breakpoint, so neither alone can show it
// on a desktop.
//
// IT STEPS ASIDE FOR THE REAL THING. The phone chrome's sheet registers a chat
// view with id 'sheet' (chat-slots.js, §8.4). Whenever the stub next draws — the
// store changed, the viewport flipped, the socket's chat posture moved — or is
// tapped, it asks realPhoneChat(), the one decision it makes about itself; once
// the answer is yes it takes its markup out of the page and stops listening.
// chat-slots.js announces nothing when a closed view registers, so a module that
// wants the stub gone sooner calls retirePullStub(). The phone chrome then
// deletes this file, its markup in index.html's pull host, its section of
// app.css and its test.
import { $ } from './state.js';
import { bus } from './bus.js';
import { isPhone } from './viewport.js';
import { chatViews } from './chat-slots.js';
import { mirror } from './chat-state.js';
import { uiState } from './chat-present.js';

// The chat view the real phone sheet registers (§8.4). The desktop dock registers
// one too, under its own id: only this one replaces the tab.
export const PHONE_CHAT_VIEW = 'sheet';

// Whether the real phone chat has registered: the stub's one decision about its
// own life.
export function realPhoneChat() {
  return chatViews().some((v) => v.id === PHONE_CHAT_VIEW);
}

// Least urgent first (§8.3): the tab shows the most urgent state of any
// conversation, and only these two of another conversation can outrank the
// followed one's (uiState's `others` lists the ones waiting on the user).
const URGENCY = ['idle', 'suspended', 'offline', 'working', 'question', 'waiting'];
const urgency = (key) => URGENCY.indexOf(key);

// A question or a command can run long; an aria-label should not.
const LABEL_MAX = 160;
function clip(text) {
  const chars = Array.from(String(text || ''));
  return chars.length <= LABEL_MAX ? chars.join('') : `${chars.slice(0, LABEL_MAX - 1).join('').trimEnd()}…`;
}

// The tab's aria-label. No clock or age in it: nothing redraws the tab while a
// session is quiet, so a "4m" here would go stale.
function labelOf(s, elsewhere) {
  const where = elsewhere ? ' in another session' : '';
  switch (s.key) {
    case 'working': {
      if (s.pace === 'quiet') return 'Claude is working, quiet — check the terminal';
      const step = s.head.replace(/^Working(?: · |$)/, '');
      return step ? `Claude is working — ${clip(step)}` : 'Claude is working';
    }
    case 'question':
      return `Claude has a question${where} — answer it in the terminal`;
    case 'waiting': {
      const what = clip(s.detail);
      return `Claude needs you${where}: ${what}${/terminal/.test(what) ? '' : ' — answer in the terminal'}`;
    }
    case 'offline':
      return `Chat with Claude — ${s.conn === 'connecting' ? 'connecting' : 'reconnecting'}`;
    case 'suspended':
      return 'Claude is suspended — resume it in the terminal';
    default:
      return 'Chat with Claude — idle';
  }
}

// What the tab shows for a store: `key` (its data-cs-state), `quiet` (a still
// bar in the working ink), `word` (NEEDS YOU or QUESTION while alerting, in
// chat-present's own words) and `label` (its aria-label). The followed
// conversation's line, the bar's, unless another session waiting on the user
// outranks it; that session's line then comes from the same model, asked about
// that session.
export function pullLook(m = mirror) {
  const own = uiState(m);
  let s = own;
  let elsewhere = false;
  for (const o of own.others) {
    if (urgency(o.state) <= urgency(s.key)) continue;
    const theirs = uiState({ ...m, followed: o.id });
    if (urgency(theirs.key) > urgency(s.key)) { s = theirs; elsewhere = true; }
  }
  const alert = s.key === 'question' || s.key === 'waiting';
  return Object.freeze({
    key: s.key,
    quiet: s.pace === 'quiet',
    word: alert ? s.label : '',
    label: labelOf(s, elsewhere),
  });
}

let els = null;     // { pull, tab, word, note } while the stub is up
let offs = [];
let retired = false;

function closeNote() {
  if (!els || els.note.classList.contains('hidden')) return;
  els.note.classList.add('hidden');
  els.tab.setAttribute('aria-expanded', 'false');
}

function openNote() {
  // One panel at a time: the window event is how a module that shell.js imports
  // (or that imports it) asks the dismiss layer to close the others.
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: els.note } }));
  els.note.classList.remove('hidden');
  els.tab.setAttribute('aria-expanded', 'true');
}

function render() {
  if (!els) return;
  if (realPhoneChat()) { retirePullStub(); return; }
  if (!isPhone()) {
    // A note left open on a hidden tab would still count as an open panel.
    closeNote();
    els.pull.hidden = true;
    return;
  }
  const look = pullLook(mirror);
  els.pull.dataset.csState = look.key;
  if (look.quiet) els.pull.dataset.csPace = 'quiet';
  else delete els.pull.dataset.csPace;
  els.word.textContent = look.word;
  els.tab.setAttribute('aria-label', look.label);
  els.pull.hidden = false;
}

function onTap() {
  if (!els) return;
  if (realPhoneChat()) { retirePullStub(); return; }
  if (els.note.classList.contains('hidden')) openNote();
  else closeNote();
}

// Show the stub (on a phone) and keep it current. Once: a second call, or a call
// after it retired, does nothing. It takes only its own markup — the pull host's
// #chat-pull with the `pull-stub` class — so it never drives the real pull.
export function initPullStub() {
  if (els || retired) return;
  const pull = $('chat-pull');
  if (!pull || !pull.classList.contains('pull-stub')) return;
  const tab = $('chat-tab');
  const note = $('chat-sheet');
  const word = pull.querySelector('.ps-word');
  if (!tab || !note || !word || !pull.contains(tab) || !pull.contains(note)) return;
  els = { pull, tab, word, note };
  if (realPhoneChat()) { retirePullStub(); return; }
  tab.addEventListener('click', onTap);
  offs = ['mirror', 'viewport', 'chat:posture'].map((type) => bus.on(type, render));
  render();
}

// Take the stub down for good: its markup leaves the page (the note with it) and
// it stops listening. Safe before initPullStub() and more than once.
export function retirePullStub() {
  retired = true;
  for (const off of offs) off();
  offs = [];
  const pull = els ? els.pull : document.querySelector('.pull-stub');
  if (els) els.tab.removeEventListener('click', onTap);
  els = null;
  if (pull) pull.remove();
}

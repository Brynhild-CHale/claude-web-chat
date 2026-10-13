// The chat panel's composer (design spec §7.13, §6.2–§6.6, §7.9's composer slot,
// §7.10's pending messages): what the user types to Claude from the page.
//
//   initChatComposer()   registers the composer with chat-slots registerComposer
//                        and the pending bubbles with chat-stream's
//                        setPendingRenderer (idempotent) → a promise that
//                        settles once both are in place
//   stopChatComposer()   unregisters both, removes its elements, clears its
//                        debounce timer and its draft frame, aborts a fetch
//
// IT RUNS IN THE CHROME'S REALM (ruling Q4): one textarea in the chat panel,
// never a pane. The panel (chat-panel.js) calls mount(slotEl, {variant}) once
// per registration and variant, so a second mount (the phone sheet's 'sheet')
// MOVES the same element and keeps the draft; unregistering puts the panel's
// own note back on its next redraw.
//
// ONE SEND PATH. A message goes through queue.js sendMessage alone — never a
// fetch of the message route here — as {text, files, conversation_id, send:
// 'auto'} (queue.js adds the device). The text is sent exactly as typed and
// there is no `skill` field: the server's leading-skill parse (lib/server/
// composer.js, §6.3) is the one reader of a '/name' token (notes-D decision
// 10, confirmed by D-confirm (4)). Files are PATHS, never content (Q5): the
// chips under the input are the files sent.
//
// THE TWO LISTS. '/' at the very start of the text opens GET /api/skills
// (fetched once per opening, then filtered as the user types); '@' at a word
// start opens GET /api/files?q= (debounced 120 ms, one request in flight, a
// stale answer dropped). Either is a combobox popup owned by the field: the
// textarea carries aria-expanded / aria-controls / aria-activedescendant, Up
// and Down move, Enter or Tab choose, and the field's own keydown, its blur and
// a choice dismiss it. No document- or window-level listener and no .popover
// (a .popover closes when focus leaves it, and focus stays in the textarea).
// The popup is laid out inside the panel and sized from it (listMaxHeight,
// pure): never position: fixed and never a viewport unit — the phone sheet's
// keyboard mode moves the panel, and a fixed popup would stay behind (§8.5).
//
// ESCAPE inside the field (§7.8; U34: the shell's keydown skips a field, so
// the field owns it): close the list, else blur a non-empty draft, else
// escapeChatViews(). escape() answers the same for a host that asks.
//
// THE PENDING BUBBLES (§7.10, §6.6) are drawn from queue.js queueSnapshot()
// .messages — the one pending list the rail and the trays read too — for the
// conversation the stream shows, after its last turn, with §6.6's words.
// 'Received' only for a confirmed receipt; never "delivered".
//
// The draft {text, files} is kept per viewer under wc:chat-draft through
// storage.js (failing open), written at most once per animation frame.
//
// THREE SEAMS for the composer on the mod (public/app/composer-mod.js, U91;
// notes-C Q-C2, granted by ruling F7), each touching the composer only here:
//   setSkillRowsProvider(fn) → unregister   fn(conversationId) → rows that
//       lead the '/' list ({name, description?, origin?, label?}; `label`
//       is shown in place of the origin tag). One provider at a time.
//   addAttachment({path, bytes?, thumb?, onGone?}) → {ok} | {ok: false, hint}
//       a chip through the chip code below, counted toward FILES_MAX (a
//       refusal also shows its hint under the input); `thumb` a URL the chip
//       previews, `onGone(path)` called once the chip goes (removed, sent,
//       or the composer stopped), so its owner can revoke the URL.
//   registerComposerTool(el, {paste, dragover, drop}?) → {remove, hint}
//       places `el` beside Send, inside the composer's own root, so it moves
//       with a sheet mount and survives a rebuild; the optional handlers hear
//       the root's paste / dragover / drop events (element listeners, never
//       document or window); hint(text) shows a line under the input.
//
// LOADS WITH NO DOM: the pure helpers below are tested in plain node
// (test/chat-composer-model.test.js). chat-stream.js touches the DOM at load
// (through graph-view.js), so its two seams are imported when init runs —
// main.js has loaded it already by then, so the import resolves at once.
import { bus } from './bus.js';
import { mirror, followed, atLeast } from './chat-state.js';
import { registerComposer, escapeChatViews } from './chat-slots.js';
import { sendMessage, queueSnapshot } from './queue.js';
import { getLocalJson, setLocalJson, removeLocal } from './storage.js';

// ── constants ────────────────────────────────────────────────────────────────

// lib/server/composer.js's limits, pinned equal by test/chat-composer-model.test.js.
export const MESSAGE_MAX = 3000;
export const FILES_MAX = 5;
export const PATH_MAX = 240;
export const QUERY_MAX = 200;            // routes/files.js refuses a longer q
export const COUNTER_FROM = Math.ceil(MESSAGE_MAX * 0.9);   // the counter shows from 2,700
export const FILES_DEBOUNCE_MS = 120;
export const DRAFT_KEY = 'wc:chat-draft';
export const LIST_MAX_PX = 280;          // the popup's tallest
export const LIST_GAP_PX = 8;            // kept clear above it, inside the panel
export const LIST_PANEL_SHARE = 0.6;     // and never more than this much of the panel
export const LIST_ROWS_MAX = 50;
export const SENT_FILES_MAX = 50;

export const INPUT_ID = 'chat-composer-input';
export const LIST_ID = 'chat-composer-list';
export const OPTION_ID_PREFIX = 'chat-composer-opt-';

export const HINT_KEYS = '/ skills · @ files';
export const SKILLS_FOOTER = 'A skill picked here asks Claude to run it.';
export const HOST_NOTE = 'Messages are sent from the host, or with ';
export const HOST_COMMAND = 'claude-web-chat tunnel mirror on';
export const OFF_NOTE = 'Sending messages from this page is off — reply in the terminal.';

// What a refusal says when the daemon's body carries no hint (§6.3's codes).
export const REFUSAL_HINTS = Object.freeze({
  empty: 'Type a message, pick a skill or attach a file.',
  too_large: `A message is at most ${MESSAGE_MAX.toLocaleString('en-US')} characters.`,
  unknown_skill: 'That is not a skill Claude can run in this conversation.',
  user_only_skill: 'Only you can run that skill: type it in the terminal.',
  builtin_command: 'That is a Claude Code command: type it in the terminal.',
  file_refused: 'That file cannot be attached.',
  too_many_files: `A message attaches at most ${FILES_MAX} files.`,
  too_many: 'Too many messages are waiting in the queue: send or remove one first.',
  rate_limited: 'Too many messages in the last minute: wait a moment and try again.',
  disabled: 'Sending messages is turned off for this project.',
  network: 'The daemon did not answer — check that web-chat is running, then try again.',
});
const REFUSED_FALLBACK = 'The message was not sent.';
// file_refused's `why`, when the body has no hint of its own.
const FILE_WHY = Object.freeze({
  outside: 'only a file inside this project can be attached',
  symlink: 'a symbolic link cannot be attached',
  sensitive: 'it looks like it holds secrets',
  ignored: 'an ignored file cannot be attached',
  missing: 'it does not exist in this project',
  'not-a-file': 'only a regular file can be attached',
  unavailable: 'the project file index is not available yet',
});

// ── pure helpers (plain node) ────────────────────────────────────────────────

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// The popup's max-height: the room above the composer inside the panel, less a
// gap, at most LIST_MAX_PX and at most LIST_PANEL_SHARE of the panel. A panel
// that is not laid out (hidden, or jsdom) gives the cap.
export function listMaxHeight(panelHeight, inputTop) {
  const ph = isNum(panelHeight) && panelHeight > 0 ? panelHeight : 0;
  if (!ph) return LIST_MAX_PX;
  const top = isNum(inputTop) ? Math.min(Math.max(inputTop, 0), ph) : ph;
  return Math.max(0, Math.floor(Math.min(LIST_MAX_PX, top - LIST_GAP_PX, ph * LIST_PANEL_SHARE)));
}

// Where the token at the caret ends: the next whitespace, or the text's end.
function tokenEnd(text, from) {
  const rest = text.slice(from);
  const m = /\s/.exec(rest);
  return m ? from + m.index : text.length;
}

// What the caret is in: a '/' skill token at the very start of the text, an '@'
// file token at a word start, or neither. → {kind, q, start, end} | null.
export function triggerAt(text, caret) {
  const s = typeof text === 'string' ? text : '';
  const at = Number.isInteger(caret) && caret >= 0 && caret <= s.length ? caret : s.length;
  const before = s.slice(0, at);
  let m = /^\/([A-Za-z0-9:_-]*)$/.exec(before);
  if (m) return { kind: 'skill', q: m[1], start: 0, end: tokenEnd(s, at) };
  m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (m) return { kind: 'file', q: m[2], start: at - m[2].length - 1, end: tokenEnd(s, at) };
  return null;
}

// Put a choice in place of the token a trigger names, a space after it unless
// one follows already. → {text, caret}.
export function insertChoice(text, trig, value) {
  const s = typeof text === 'string' ? text : '';
  const before = s.slice(0, trig.start);
  const after = s.slice(trig.end);
  const sep = /^\s/.test(after) ? '' : ' ';
  return { text: before + value + sep + after, caret: before.length + value.length + 1 };
}

// The skills that match what was typed after '/': name prefixes first, then
// names holding it, each in the catalog's order, at most LIST_ROWS_MAX.
export function filterSkills(list, q) {
  const rows = Array.isArray(list) ? list.filter((s) => s && typeof s.name === 'string' && s.name) : [];
  const needle = String(q || '').toLowerCase();
  if (!needle) return rows.slice(0, LIST_ROWS_MAX);
  const starts = [];
  const holds = [];
  for (const s of rows) {
    const n = s.name.toLowerCase();
    if (n.startsWith(needle)) starts.push(s);
    else if (n.includes(needle)) holds.push(s);
  }
  return [...starts, ...holds].slice(0, LIST_ROWS_MAX);
}

// The words a refusal shows under the input: the body's hint, else this
// module's sentence for its code; file_refused names the path, rate_limited
// when to try again.
export function refusalHint(r) {
  const body = r && typeof r === 'object' ? r : {};
  const code = typeof body.refused === 'string' ? body.refused : null;
  let hint = typeof body.hint === 'string' && body.hint.trim() ? body.hint.trim() : (REFUSAL_HINTS[code] || REFUSED_FALLBACK);
  if (code === 'file_refused') {
    const why = typeof body.why === 'string' ? body.why : null;
    if (!(typeof body.hint === 'string' && body.hint.trim()) && why) {
      hint = FILE_WHY[why] ? `That file cannot be attached: ${FILE_WHY[why]}.` : `That file cannot be attached (${why}).`;
    }
    if (typeof body.path === 'string' && body.path) hint = `${body.path}: ${hint}`;
  }
  if (code === 'rate_limited' && isNum(body.retry_after) && body.retry_after > 0) {
    hint = `${hint} Try again in ${Math.ceil(body.retry_after)} s.`;
  }
  return hint;
}

// A pending message's state, in §6.6's words, and the action its bubble offers.
export function pendingLabel(m) {
  const state = m && m.state;
  switch (state) {
    case 'queued':
      if (isNum(m.position) && m.position >= 1) return { text: m.position === 1 ? 'next' : `#${m.position}`, action: null };
      return { text: 'queued', action: null };
    case 'held': return { text: 'held', action: null };
    case 'sending': return { text: 'sending…', action: null };
    case 'sent': return { text: 'Sent', action: null };
    case 'parked':
    case 'handed_over': return { text: 'With your next message', action: null };
    case 'unconfirmed': return { text: 'waiting for Claude to read it', action: 'Resend' };
    case 'failed': return { text: 'failed — ', action: 'Retry' };
    case 'confirmed': return { text: 'Received', action: null };
    default: return { text: '', action: null };
  }
}

// The access decision: what the composer shows. Below `full` a remote viewer
// is told where messages come from; at `full` the queue_message capability
// gates the input. (A local page is never below full once the mirror has
// answered; until then, or with the mirror off, it shows the off note.)
export function composerMode({ level, remote, queueMessage } = {}) {
  if (atLeast(level, 'full')) return queueMessage === true ? 'input' : 'off';
  return remote === true ? 'host' : 'off';
}

// A stored draft, or a blank one: {text, files}, every part checked.
export function readDraft(raw) {
  const out = { text: '', files: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.text === 'string') out.text = raw.text.slice(0, MESSAGE_MAX * 4);
  if (Array.isArray(raw.files)) {
    for (const f of raw.files) {
      if (typeof f !== 'string' || !f || f.length > PATH_MAX || out.files.includes(f)) continue;
      out.files.push(f);
      if (out.files.length >= FILES_MAX) break;
    }
  }
  return out;
}

// ── the module's state ───────────────────────────────────────────────────────

let R = null;               // the elements, once built
let running = false;
let gen = 0;                // bumped by stop: a late answer from before is dropped
let offs = [];
let unregister = null;
let restorePending = null;
let stickFn = null;
let wired = null;           // the promise initChatComposer answers
let mode = null;            // 'input' | 'host' | 'off'
let variant = 'desktop';
let files = [];             // the chips: paths, in the order added
let sending = false;
let escaping = false;
let draftFrame = null;
let draftDirty = false;
const sentFiles = new Map(); // msg_id → the files that message carried (Resend)
let rowsProvider = null;    // setSkillRowsProvider's fn (U91)
const thumbs = new Map();   // chip path → {thumb, onGone}, from addAttachment (U91)
const tools = [];           // registerComposerTool's {el, on} (U91), in order
const resendNotes = new Map(); // msg_id → a Resend's refusal

// The open list: its kind, the trigger it is for, its rows and the active row.
let L = { open: false, kind: null, trig: null, rows: [], active: -1, status: '' };
let skills = null;          // this opening's catalog, once fetched
let skillsCtl = null;
let filesTimer = null;
let filesCtl = null;        // the one /api/files request in flight
let filesAgain = false;     // the query moved while it flew

// ── small DOM helpers ────────────────────────────────────────────────────────

function el(tag, cls, content) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (content !== undefined) e.textContent = content;
  return e;
}
function setAttr(e, name, value) {
  if (value === null || value === undefined) e.removeAttribute(name);
  else if (e.getAttribute(name) !== String(value)) e.setAttribute(name, String(value));
}
const raf = (fn) => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : null);
function caf(id) {
  if (id !== null && typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id);
}

// ── the tree ─────────────────────────────────────────────────────────────────
//
//   div.cc-root[data-variant][data-mode]
//   ├─ p.cc-off                      the host / off note (no input), or
//   └─ div.cc-form
//      ├─ div.cc-pop                 the popup (hidden while closed)
//      │  ├─ p.cc-pop-status         loading / nothing matches
//      │  ├─ ul#chat-composer-list.cc-list[role=listbox] > li#chat-composer-opt-<n>.cc-opt
//      │  └─ p.cc-pop-foot           the skills footer
//      ├─ div.cc-row  textarea#chat-composer-input.cc-input · button.cc-send
//      ├─ div.cc-chips  span.cc-chip (span.cc-chip-path · button.cc-chip-x)
//      ├─ div.cc-foot  span.cc-keys · span.cc-count
//      └─ p.cc-msg                   a refusal's hint

function build() {
  const root = el('div', 'cc-root');
  const off = el('p', 'cc-off');
  const form = el('div', 'cc-form');

  const pop = el('div', 'cc-pop');
  pop.hidden = true;
  const status = el('p', 'cc-pop-status');
  status.hidden = true;
  const list = el('ul', 'cc-list');
  list.id = LIST_ID;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Suggestions');
  const foot = el('p', 'cc-pop-foot', SKILLS_FOOTER);
  foot.hidden = true;
  pop.append(status, list, foot);

  const row = el('div', 'cc-row');
  const ta = el('textarea', 'cc-input');
  ta.id = INPUT_ID;
  ta.rows = 1;
  ta.placeholder = 'Message Claude…';
  ta.setAttribute('aria-label', 'Message Claude');
  ta.setAttribute('role', 'combobox');
  ta.setAttribute('aria-multiline', 'true');
  ta.setAttribute('aria-autocomplete', 'list');
  ta.setAttribute('aria-haspopup', 'listbox');
  ta.setAttribute('aria-expanded', 'false');
  ta.setAttribute('aria-controls', LIST_ID);
  ta.setAttribute('autocomplete', 'off');
  ta.spellcheck = true;
  const send = el('button', 'cc-send', 'Send');
  send.type = 'button';
  row.append(ta, send);

  const chips = el('div', 'cc-chips');
  chips.hidden = true;
  const footer = el('div', 'cc-foot');
  const keys = el('span', 'cc-keys', HINT_KEYS);
  const count = el('span', 'cc-count');
  count.hidden = true;
  footer.append(keys, count);
  const msg = el('p', 'cc-msg');
  msg.setAttribute('role', 'status');
  msg.hidden = true;

  form.append(pop, row, chips, footer, msg);
  // The registered tools (U91), beside Send, and the root's paste and drop for
  // their handlers.
  for (const t of tools) row.insertBefore(t.el, send);
  for (const type of ['paste', 'dragover', 'drop']) root.addEventListener(type, (e) => toolEvent(type, e));

  ta.addEventListener('keydown', onKey);
  ta.addEventListener('input', onInput);
  ta.addEventListener('click', updateTrigger);
  ta.addEventListener('blur', () => closeList());
  send.addEventListener('click', () => doSend());
  // The caret leaving a token by the keys closes its list (typing re-opens it).
  ta.addEventListener('keyup', (e) => { if (/^(Arrow(Left|Right)|Home|End)$/.test(e.key)) updateTrigger(); });
  // A press on a row must not take focus from the field (its blur would close
  // the list before the click lands); the click chooses.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target && e.target.closest ? e.target.closest('.cc-opt') : null;
    if (!li || !list.contains(li)) return;
    choose(Number(li.dataset.n));
  });
  chips.addEventListener('click', (e) => {
    const x = e.target && e.target.closest ? e.target.closest('.cc-chip-x') : null;
    if (!x || !chips.contains(x)) return;
    removeFile(x.dataset.path);
  });

  R = { root, off, form, pop, status, list, foot, row, ta, send, chips, count, msg };
  const d = readDraft(getLocalJson(DRAFT_KEY, null));
  ta.value = d.text;
  files = d.files;
  renderChips();
  updateCount();
  return R;
}

// ── access: what the composer shows ──────────────────────────────────────────

function decide() {
  if (!R) return;
  const caps = mirror.capabilities || {};
  const access = mirror.access || {};
  const next = composerMode({ level: access.level, remote: access.remote, queueMessage: caps.queue_message });
  if (next === mode) return;
  mode = next;
  R.root.dataset.mode = next;
  if (next === 'input') {
    R.root.replaceChildren(R.form);
    autosize();
    return;
  }
  closeList();
  if (next === 'host') {
    const code = el('code', null, HOST_COMMAND);
    R.off.replaceChildren(document.createTextNode(HOST_NOTE), code);
  } else {
    R.off.textContent = OFF_NOTE;
  }
  R.root.replaceChildren(R.off);
}

// ── the field ────────────────────────────────────────────────────────────────

// 34 px, growing with its content to five lines (the CSS max-height), then
// scrolling inside.
function autosize() {
  if (!R) return;
  const ta = R.ta;
  ta.style.height = '';
  const h = ta.scrollHeight;
  if (h > 0) ta.style.height = `${h}px`;
}

function updateCount() {
  if (!R) return;
  const n = R.ta.value.length;
  const show = n >= COUNTER_FROM;
  R.count.hidden = !show;
  R.count.textContent = show ? `${n.toLocaleString('en-US')} / ${MESSAGE_MAX.toLocaleString('en-US')}` : '';
  setAttr(R.count, 'data-over', show && n > MESSAGE_MAX ? 'true' : null);
}

function showMsg(text) {
  if (!R) return;
  R.msg.textContent = text || '';
  R.msg.hidden = !text;
}

function onInput() {
  autosize();
  updateCount();
  showMsg('');
  scheduleDraft();
  updateTrigger();
}

function onKey(e) {
  // An Enter that ends an IME composition is the composition's, never a send.
  if (e.isComposing || e.keyCode === 229) return;
  if (L.open) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); return;
      case 'ArrowUp': e.preventDefault(); move(-1); return;
      case 'Enter':
      case 'Tab':
        if (L.rows.length && !e.shiftKey) {
          e.preventDefault();
          choose(L.active >= 0 ? L.active : 0);
          return;
        }
        if (e.key === 'Tab') { closeList(); return; }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        closeList();
        return;
      default:
    }
  }
  if (e.key === 'Escape') {
    // This press is the field's: the shell's document keydown reads the focus
    // AFTER this handler, and a blurred field (or a closed dock's returned
    // focus) would make it take a second layer for the same press.
    e.preventDefault();
    e.stopPropagation();
    escapeChain();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    doSend();
  }
}

// §7.13's Escape: the list, then a non-empty draft's focus, then the chat views.
// Re-entry answers false: a view whose own Escape asks the composer must not
// loop back through escapeChatViews().
function escapeChain() {
  if (escaping) return false;
  escaping = true;
  try {
    if (L.open) { closeList(); return true; }
    if (R && R.ta.value && R.ta.ownerDocument.activeElement === R.ta) {
      R.ta.blur();
      return true;
    }
    return escapeChatViews();
  } finally {
    escaping = false;
  }
}

// ── the draft ────────────────────────────────────────────────────────────────

function writeDraft() {
  draftDirty = false;
  if (!R) return;
  const text = R.ta.value;
  if (!text && !files.length) removeLocal(DRAFT_KEY);
  else setLocalJson(DRAFT_KEY, { text, files: [...files] });
}

function scheduleDraft() {
  draftDirty = true;
  if (draftFrame !== null) return;
  const id = raf(() => {
    draftFrame = null;
    if (draftDirty) writeDraft();
  });
  if (id === null) writeDraft();
  else draftFrame = id;
}

// ── chips ────────────────────────────────────────────────────────────────────

function renderChips() {
  if (!R) return;
  const kids = files.map((p) => {
    const chip = el('span', 'cc-chip');
    const t = thumbs.get(p);
    if (t && t.thumb) {
      const img = el('img', 'cc-chip-thumb');
      img.alt = '';
      img.src = t.thumb;
      chip.append(img);
    }
    const name = el('span', 'cc-chip-path', p);
    name.title = p;
    const x = el('button', 'cc-chip-x', '✕');
    x.type = 'button';
    x.dataset.path = p;
    x.setAttribute('aria-label', `Remove ${p}`);
    chip.append(name, x);
    return chip;
  });
  R.chips.replaceChildren(...kids);
  R.chips.hidden = kids.length === 0;
}

// The chips' previews whose chip has gone: forgotten, and their owner told.
function dropThumbs(all = false) {
  for (const [p, t] of [...thumbs]) {
    if (!all && files.includes(p)) continue;
    thumbs.delete(p);
    if (typeof t.onGone === 'function') {
      try { t.onGone(p); } catch (e) { console.error('[web-chat] an attachment\'s owner failed', e); }
    }
  }
}

function removeFile(p) {
  const at = files.indexOf(p);
  if (at < 0) return;
  files.splice(at, 1);
  dropThumbs();
  renderChips();
  showMsg('');
  scheduleDraft();
  if (R) R.ta.focus({ preventScroll: true });
}

// ── the seams for the composer on the mod (U91) ─────────────────────────────

export function setSkillRowsProvider(fn) {
  if (typeof fn !== 'function') throw new TypeError('setSkillRowsProvider needs a function');
  rowsProvider = fn;
  return () => { if (rowsProvider === fn) rowsProvider = null; };
}

// The provider's rows for this conversation: well-formed ones only; a throw
// gives none.
function providedRows(cid) {
  if (!rowsProvider) return [];
  let rows;
  try { rows = rowsProvider(cid); } catch (e) { console.error('[web-chat] the / rows provider failed', e); return []; }
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r.name === 'string' && r.name) : [];
}

export function addAttachment({ path, bytes, thumb, onGone } = {}) {
  if (!R || !running) return { ok: false, hint: 'The composer is not open.' };
  if (typeof path !== 'string' || !path || path.length > PATH_MAX) return { ok: false, hint: REFUSAL_HINTS.file_refused };
  if (!files.includes(path)) {
    if (files.length >= FILES_MAX) {
      const hint = REFUSAL_HINTS.too_many_files;
      showMsg(hint);
      return { ok: false, hint };
    }
    files.push(path);
  }
  if (typeof thumb === 'string' && thumb) {
    const prev = thumbs.get(path);
    thumbs.set(path, { thumb, onGone: typeof onGone === 'function' ? onGone : null, bytes });
    if (prev && typeof prev.onGone === 'function' && prev.thumb !== thumb) {
      try { prev.onGone(path); } catch {}
    }
  }
  renderChips();
  showMsg('');
  scheduleDraft();
  return { ok: true };
}

export function registerComposerTool(el, on = {}) {
  if (!el || typeof el !== 'object') throw new TypeError('registerComposerTool needs an element');
  const t = { el, on: on && typeof on === 'object' ? on : {} };
  tools.push(t);
  if (R) R.row.insertBefore(el, R.send);
  return {
    remove() {
      const at = tools.indexOf(t);
      if (at >= 0) tools.splice(at, 1);
      el.remove();
    },
    hint(text) {
      if (tools.includes(t)) showMsg(text);
    },
  };
}

function toolEvent(type, e) {
  for (const t of tools) {
    const fn = t.on[type];
    if (typeof fn !== 'function') continue;
    try { fn(e); } catch (err) { console.error(`[web-chat] a composer tool's ${type} failed`, err); }
  }
}

// ── the list ─────────────────────────────────────────────────────────────────

function optionId(n) { return OPTION_ID_PREFIX + n; }

function sizeList() {
  if (!R) return;
  const panel = R.root.closest ? R.root.closest('.chat-panel') : null;
  const host = panel || R.root.parentElement;
  let ph = 0;
  let top = 0;
  if (host && typeof host.getBoundingClientRect === 'function') {
    const p = host.getBoundingClientRect();
    const r = R.root.getBoundingClientRect();
    ph = p.height;
    top = r.top - p.top;
  }
  R.pop.style.maxHeight = `${listMaxHeight(ph, top)}px`;
}

function drawList() {
  if (!R) return;
  const opts = L.rows.map((row, n) => {
    const li = el('li', 'cc-opt');
    li.id = optionId(n);
    li.dataset.n = String(n);
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', n === L.active ? 'true' : 'false');
    if (L.kind === 'skill') {
      li.append(el('span', 'cc-opt-name', `/${row.name}`));
      if (row.label || row.origin) li.append(el('span', 'cc-opt-tag', row.label || row.origin));
      if (row.description) li.append(el('span', 'cc-opt-desc', row.description));
    } else {
      li.append(el('span', 'cc-opt-name', row.path));
    }
    return li;
  });
  R.list.replaceChildren(...opts);
  R.status.textContent = L.status;
  R.status.hidden = !L.status;
  R.foot.hidden = L.kind !== 'skill';
  R.pop.hidden = false;
  R.pop.dataset.kind = L.kind;
  setAttr(R.ta, 'aria-expanded', 'true');
  setAttr(R.ta, 'aria-activedescendant', L.active >= 0 ? optionId(L.active) : null);
  sizeList();
}

function openList(kind, trig) {
  if (L.open && L.kind === kind) { L.trig = trig; return false; }
  closeList();
  L = { open: true, kind, trig, rows: [], active: -1, status: '' };
  return true;
}

function setRows(rows, emptyText) {
  L.rows = rows;
  L.active = rows.length ? Math.min(Math.max(L.active, 0), rows.length - 1) : -1;
  L.status = rows.length ? '' : emptyText;
  drawList();
}

function closeList() {
  const was = L.open;
  L = { open: false, kind: null, trig: null, rows: [], active: -1, status: '' };
  skills = null;
  if (skillsCtl) { skillsCtl.abort(); skillsCtl = null; }
  if (filesTimer !== null) { clearTimeout(filesTimer); filesTimer = null; }
  filesAgain = false;
  if (!R) return;
  if (was || !R.pop.hidden) {
    R.pop.hidden = true;
    R.list.replaceChildren();
    delete R.pop.dataset.kind;
  }
  setAttr(R.ta, 'aria-expanded', 'false');
  setAttr(R.ta, 'aria-activedescendant', null);
}

function move(step) {
  if (!L.rows.length) return;
  const n = L.rows.length;
  L.active = L.active < 0 ? (step > 0 ? 0 : n - 1) : (L.active + step + n) % n;
  drawList();
  const li = R.list.querySelector(`#${optionId(L.active)}`);
  if (li && typeof li.scrollIntoView === 'function') li.scrollIntoView({ block: 'nearest' });
}

function updateTrigger() {
  if (!R || mode !== 'input') return;
  const ta = R.ta;
  const trig = ta.selectionStart === ta.selectionEnd ? triggerAt(ta.value, ta.selectionEnd) : null;
  if (!trig || trig.q.length > QUERY_MAX) { closeList(); return; }
  if (trig.kind === 'skill') {
    if (openList('skill', trig)) {
      L.status = 'Loading skills…';
      drawList();
      fetchSkills();
    } else if (skills) {
      setRows(filterSkills(skills, trig.q), 'No skill matches.');
    }
    return;
  }
  const fresh = openList('file', trig);
  if (fresh) {
    L.status = 'Searching files…';
    drawList();
  }
  if (filesTimer !== null) clearTimeout(filesTimer);
  filesTimer = setTimeout(() => {
    filesTimer = null;
    fetchFiles();
  }, FILES_DEBOUNCE_MS);
}

async function getJson(url, ctl) {
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// The catalog, once per opening; the list filters it as the user types.
async function fetchSkills() {
  const my = gen;
  const ctl = new AbortController();
  skillsCtl = ctl;
  const cid = followed();
  const url = cid ? `/api/skills?conversation=${encodeURIComponent(cid)}` : '/api/skills';
  const body = await getJson(url, ctl);
  if (my !== gen || skillsCtl !== ctl) return;
  skillsCtl = null;
  if (!L.open || L.kind !== 'skill') return;
  // Tranche 6 (U91): a registered provider's rows lead the list — with a mod
  // attached, its SAFE_MOD_COMMANDS rows (/plan, /compact, …), which Send runs
  // through the mod (lib/server/mod-transport.js).
  const lead = providedRows(cid);
  if (!body || body.ok !== true) {
    skills = lead;
    setRows(filterSkills(skills, L.trig.q), 'The skill list could not be read.');
    return;
  }
  const led = new Set(lead.map((s) => s.name));
  const listed = Array.isArray(body.skills) ? body.skills.filter((s) => s && typeof s.name === 'string' && s.name && !led.has(s.name)) : [];
  skills = [...lead, ...listed];
  setRows(filterSkills(skills, L.trig.q), body.disabled ? 'The chat mirror is off: no skills to list.' : 'No skill matches.');
}

// One request in flight: a query that moves while it flies is asked for once
// the answer is in, and an answer for a query no longer typed is dropped.
async function fetchFiles() {
  if (!L.open || L.kind !== 'file') return;
  if (filesCtl) { filesAgain = true; return; }
  const my = gen;
  const q = L.trig.q;
  const ctl = new AbortController();
  filesCtl = ctl;
  const body = await getJson(`/api/files?q=${encodeURIComponent(q)}`, ctl);
  if (my !== gen || filesCtl !== ctl) return;
  filesCtl = null;
  const again = filesAgain;
  filesAgain = false;
  if (!L.open || L.kind !== 'file') return;
  if (L.trig.q !== q) {
    if (again || filesTimer === null) fetchFiles();
    return;
  }
  if (!body || body.ok !== true) { setRows([], 'The file list could not be read.'); return; }
  const rows = (Array.isArray(body.files) ? body.files : [])
    .filter((f) => f && typeof f.path === 'string' && f.path && f.path.length <= PATH_MAX)
    .slice(0, LIST_ROWS_MAX)
    .map((f) => ({ path: f.path }));
  setRows(rows, body.disabled ? 'The chat mirror is off: no files to list.' : 'No file matches.');
}

function choose(n) {
  const row = L.rows[n];
  if (!R || !row || !L.trig) return;
  const trig = L.trig;
  const kind = L.kind;
  closeList();
  let value;
  if (kind === 'skill') {
    value = `/${row.name}`;
  } else {
    if (!files.includes(row.path)) {
      if (files.length >= FILES_MAX) {
        showMsg(`${REFUSAL_HINTS.too_many_files} Remove one to attach ${row.path}.`);
        return;
      }
      files.push(row.path);
      renderChips();
    }
    value = `@${row.path}`;
  }
  const next = insertChoice(R.ta.value, trig, value);
  R.ta.value = next.text;
  try { R.ta.setSelectionRange(next.caret, next.caret); } catch { /* a detached field */ }
  autosize();
  updateCount();
  showMsg('');
  scheduleDraft();
}

// ── sending ──────────────────────────────────────────────────────────────────

function rememberSent(msgId, list) {
  if (typeof msgId !== 'string' || !msgId) return;
  sentFiles.delete(msgId);
  sentFiles.set(msgId, list);
  while (sentFiles.size > SENT_FILES_MAX) sentFiles.delete(sentFiles.keys().next().value);
}

function stick() {
  if (typeof stickFn !== 'function') return;
  try { stickFn(); } catch (e) { console.error('[web-chat] the composer could not re-stick the stream', e); }
}

async function doSend() {
  if (!R || mode !== 'input' || sending) return;
  const text = R.ta.value;
  const list = [...files];
  if (!text.trim() && !list.length) {
    showMsg(REFUSAL_HINTS.empty);
    return;
  }
  closeList();
  sending = true;
  const my = gen;
  R.send.disabled = true;
  R.ta.readOnly = true;
  R.root.dataset.busy = 'true';
  let r;
  try {
    r = await sendMessage({ text, files: list, conversation_id: followed(), send: 'auto' });
  } catch {
    r = { ok: false, refused: 'network' };
  }
  if (my !== gen || !R) return;
  sending = false;
  R.send.disabled = false;
  R.ta.readOnly = false;
  delete R.root.dataset.busy;
  if (r && r.ok === true) {
    rememberSent(r.msg_id, list);
    R.ta.value = '';
    files = [];
    dropThumbs();
    renderChips();
    autosize();
    updateCount();
    showMsg('');
    draftDirty = false;
    caf(draftFrame);
    draftFrame = null;
    removeLocal(DRAFT_KEY);
    stick();
    return;
  }
  showMsg(refusalHint(r));
}

// ── the pending bubbles ──────────────────────────────────────────────────────

let pendingKey = null;
let pendingAt = null;       // the stream's container and conversation, as last drawn

function redrawPending() {
  pendingKey = null;
  if (pendingAt && pendingAt.box.isConnected) renderPending(pendingAt.box, { conversationId: pendingAt.conversationId });
}

async function resend(m, btn) {
  if (typeof m.text !== 'string') return;
  btn.disabled = true;
  const my = gen;
  let r;
  try {
    r = await sendMessage({ text: m.text, files: sentFiles.get(m.msg_id) || [], conversation_id: m.conversation_id || null, send: 'auto' });
  } catch {
    r = { ok: false, refused: 'network' };
  }
  if (my !== gen) return;
  if (r && r.ok === true) {
    resendNotes.delete(m.msg_id);
    rememberSent(r.msg_id, sentFiles.get(m.msg_id) || []);
    stick();
  } else {
    resendNotes.set(m.msg_id, refusalHint(r));
    btn.disabled = false;
  }
  redrawPending();
}

function bubble(m) {
  const wrap = el('div', 'cc-pending');
  wrap.dataset.state = m.state;
  wrap.dataset.msgId = m.msg_id;
  const text = typeof m.text === 'string' ? m.text
    : `message · ${isNum(m.chars) ? m.chars : 0} chars`;
  const b = el('div', 'cc-pbubble', text);
  if (typeof m.text !== 'string') b.classList.add('cc-phidden');
  const meta = el('div', 'cc-pmeta');
  const label = pendingLabel(m);
  const st = el('span', 'cc-pstate', label.text);
  if (label.action) {
    const btn = el('button', 'cc-pact', label.action);
    btn.type = 'button';
    if (typeof m.text !== 'string') btn.disabled = true;
    btn.addEventListener('click', () => resend(m, btn));
    st.append(btn);
  }
  meta.append(st);
  if (m.files_count > 0) meta.append(el('span', 'cc-pfiles', m.files_count === 1 ? '1 file' : `${m.files_count} files`));
  if (m.device === 'mobile') meta.append(el('span', 'cc-pdevice', 'sent from phone'));
  const note = resendNotes.get(m.msg_id);
  if (note) meta.append(el('span', 'cc-pnote', note));
  wrap.append(b, meta);
  return wrap;
}

// chat-stream's pending renderer: this conversation's pending messages, after
// the last turn (a null conversation_id is the server's primary one's).
function renderPending(box, { conversationId } = {}) {
  const primary = mirror.serverPrimary || null;
  const want = conversationId || null;
  const list = queueSnapshot().messages.filter((m) => (m.conversation_id || primary) === want);
  pendingAt = { box, conversationId: want };
  const key = JSON.stringify([want, list, [...resendNotes]]);
  if (key === pendingKey && box.childElementCount === list.length) return;
  pendingKey = key;
  box.replaceChildren(...list.map(bubble));
}

// ── the registration ─────────────────────────────────────────────────────────

// A fresh object per init: the panel mounts a registration it has not seen
// (chat-panel.js compares the slot's holder), so a re-init after a stop is
// mounted again even when the panel did not redraw in between.
function makeImpl() {
  return {
    mount(slotEl, opts = {}) {
      if (!slotEl || typeof document === 'undefined') return;
      if (!R) build();
      variant = opts && opts.variant === 'sheet' ? 'sheet' : 'desktop';
      R.root.dataset.variant = variant;
      if (R.root.parentNode !== slotEl) slotEl.append(R.root);
      decide();
      autosize();
    },
    focus() {
      if (!R || mode !== 'input' || !R.ta.isConnected) return;
      R.ta.focus({ preventScroll: true });
    },
    escape() {
      return escapeChain();
    },
  };
}

export function initChatComposer() {
  if (running) return wired;
  if (typeof document === 'undefined') return Promise.resolve(false);
  running = true;
  const my = gen;
  if (!R) build();
  mode = null;
  decide();
  unregister = registerComposer(makeImpl());
  offs = [bus.on('mirror', decide)];
  wired = import('./chat-stream.js').then((stream) => {
    if (my !== gen || !running) return false;
    pendingKey = null;
    restorePending = stream.setPendingRenderer(renderPending);
    stickFn = stream.stickToBottom;
    return true;
  }).catch((e) => {
    console.error('[web-chat] the composer could not reach the chat stream', e);
    return false;
  });
  return wired;
}

export function stopChatComposer() {
  if (!running) return;
  running = false;
  gen += 1;
  if (draftDirty) writeDraft();
  caf(draftFrame);
  draftFrame = null;
  draftDirty = false;
  closeList();
  if (filesCtl) { filesCtl.abort(); filesCtl = null; }
  for (const off of offs) off();
  offs = [];
  if (unregister) { unregister(); unregister = null; }
  if (restorePending) { restorePending(); restorePending = null; }
  stickFn = null;
  wired = null;
  sending = false;
  pendingKey = null;
  pendingAt = null;
  if (R) R.root.remove();
  R = null;
  mode = null;
  files = [];
  dropThumbs(true);
}

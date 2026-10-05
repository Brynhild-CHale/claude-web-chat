// The chat panel (design spec §7.9): ONE panel instance, built here, that moves
// itself into whichever host was announced last on chrome-bus `chat:host`
// {host, variant} — the desktop dock's #cd-body (chat-dock.js), and the phone
// sheet's Chat page from tranche 5 — keeping the stream's scroll offset and its
// stuck-to-the-bottom state across the move.
//
//   initChatPanel()         builds #chat-panel once (idempotent) into #cd-body when
//                           there is one, and starts listening; → the panel
//   stopPanel()             stops it: the ticker, the pending frame, the listeners
//   openDetail({kind, title, params})   pushes a detail view over the stream
//   popDetail() → bool      pops the top one ('‹ Chat', or one Escape)
//   registerDetail(kind, render) → unregister    a detail unit's view (§7.12)
//   hasDetail(kind)
//   panelEl()               the panel, once built
//
//   #chat-panel.chat-panel[data-variant=desktop|sheet]
//   ├─ header.cp-head  #chat-title "CHAT ↔ CLAUDE" · #cp-stop · #cp-ops · close
//   ├─ #chat-strip.cp-strip[data-cs-state][data-cs-pace]   dot · LABEL · detail
//   ├─ #chat-meta.cp-meta  [#chat-session ▾ title] · model · mode · tokens or $
//   ├─ #chat-notice.cp-notice    below `read`; disabled; offline
//   ├─ #chat-awaiting.cp-awaiting[role=group]               chat-awaiting.js
//   ├─ #chat-views  #chat-stream[role=log] · #chat-new · #chat-detail
//   └─ #chat-composer-slot.cp-composer
//
// WHAT IT SAYS about Claude's state is never decided here: the strip is
// chat-present's uiState (LABEL · detail, its ink from data-cs-state), the same
// line the status bar shows, read from chat-state.js — the one store, which
// this panel never fetches past. A failed turn reads as uiState reads
// live.last_turn.error ("stopped: <summary>"); the panel words nothing itself.
//
// TWO SLOTS ARE NOT OURS. #cp-stop is tranche 4's Stop control (§15.5) and
// #cp-ops tranche 6's session controls (§15.7): this module creates them empty
// and never writes into them; app.css hides each while it is :empty.
//
// THE STREAM is chat-stream.js's (U37): #chat-stream and #chat-new are built
// here, empty, and filled there. THE COMPOSER mounts into the slot when one is
// registered (chat-slots registerComposer), else the slot says where to reply.
// THE AWAITING CARD is chat-awaiting.js's.
//
// DETAILS (§7.12) are views pushed OVER the stream, which stays laid out under
// them so its scroll position survives; a detail unit registers its view by
// kind (registerDetail) without editing this file. The stack's pop is the dock's
// first Escape step (chat-dock.js addEscapeStep), so one Escape pops one detail
// and only the next closes the drawer.
//
// chat:open {view, id, node_id} is applied here, in a microtask, after the host
// has shown (the dock shows itself and applies focus, U33): 'awaiting' scrolls
// the card into view and focuses it; 'task', 'diff' and 'turn' open the
// registered detail of that kind with {id, node_id}, else stay on the chat;
// 'chat' pops back to the stream.
//
// REDRAWS: bus `mirror` and `queue`, coalesced to one animation frame, and ONE
// setInterval(…, 1000) — the strip's running clock — that runs only while a
// chat view is open (chat:posture 'full'), unref'd where the runtime has unref,
// cleared on close and by stopPanel(). Never a setTimeout chain (§10.1).
import { bus } from './bus.js';
import { mirror, serverNow, followed, followConversation, atLeast } from './chat-state.js';
import { uiState } from './chat-present.js';
import { approvals, composer, closeChatViews, posture } from './chat-slots.js';
import { addEscapeStep } from './chat-dock.js';
import { renderAwaiting, focusAwaiting } from './chat-awaiting.js';

const TICK_MS = 1000;
const RECENT_MS = 60 * 60 * 1000;    // an ended conversation stays switchable for an hour
const STUCK_PX = 48;                 // the stream's "stuck to the bottom" (§7.10)
const TITLE = 'CHAT ↔ CLAUDE';
const UNTITLED = 'Untitled session';
const COMPOSER_NOTE = 'Reply in the terminal, or add a note in the queue rail (Q) and Push.';
const REMOTE_NOTE = 'This surface is viewed remotely. The conversation stays on the host unless this project allows it.';
const REMOTE_COMMAND = 'claude-web-chat tunnel mirror on';
const OFFLINE_NOTE = 'Offline — showing the last known state.';
const DISABLED_NOTE = 'the chat mirror is off';
// Claude Code's permission modes, as the meta line words them (§7.9).
const MODE_WORDS = {
  default: 'default mode', acceptEdits: 'accept edits', plan: 'plan mode', auto: 'auto mode',
  bypassPermissions: 'bypass permissions',
};
const DANGER_MODES = new Set(['bypassPermissions']);
// A conversation's state, as a dot's ink (app.css's [data-cs-state], §7.4).
const INK = { working: 'working', compacting: 'working', question: 'question', waiting: 'waiting', suspended: 'suspended' };
const inkOf = (state) => INK[state] || 'idle';
const DETAIL_VIEWS = ['task', 'diff', 'turn'];

let P = null;               // the panel's elements, once built
let running = false;
let variant = 'desktop';
let offs = [];
let offEscape = null;
let ticker = null;
let frame = null;
let metaKey = null;         // what the meta line was last built from
let noticeKey = null;
let composerHeld = { impl: undefined, variant: null };
let sessionsKey = null;     // what the open listbox was last built from
let showHeadless = false;

const details = new Map();  // kind → render(bodyEl, params, ctx)
const stack = [];           // [{ kind, view, back, title, cleanup }], top last

// ── small DOM helpers ────────────────────────────────────────────────────────

function el(tag, cls, content) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (content !== undefined) e.textContent = content;
  return e;
}
const setText = (e, s) => { if (e.textContent !== s) e.textContent = s; };
function setAttr(e, name, value) {
  if (value === null || value === undefined) e.removeAttribute(name);
  else if (e.getAttribute(name) !== String(value)) e.setAttribute(name, String(value));
}
function focusEl(e) {
  if (!e) return false;
  try { e.focus({ preventScroll: true }); } catch { return false; }
  return document.activeElement === e;
}
function button(cls, content, label) {
  const b = el('button', cls, content);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

// ── the tree ─────────────────────────────────────────────────────────────────

function build() {
  const panel = el('div', 'chat-panel');
  panel.id = 'chat-panel';
  panel.dataset.variant = variant;

  const head = el('header', 'cp-head');
  const title = el('h2', 'cp-title', TITLE);
  title.id = 'chat-title';
  const stop = el('span', 'cp-stop');
  stop.id = 'cp-stop';
  const ops = el('span', 'cp-ops');
  ops.id = 'cp-ops';
  const close = button('cp-close', undefined, 'Close the chat');
  close.addEventListener('click', () => closeChatViews());
  head.append(title, stop, ops, close);

  const strip = el('div', 'cp-strip');
  strip.id = 'chat-strip';
  strip.setAttribute('data-cs-state', 'idle');
  const dot = el('span', 'cp-dot');
  dot.setAttribute('aria-hidden', 'true');
  const label = el('span', 'cp-label');
  const detail = el('span', 'cp-text');
  strip.append(dot, label, detail);

  const meta = el('div', 'cp-meta');
  meta.id = 'chat-meta';
  meta.hidden = true;
  const sessionsList = el('ul', 'popover cp-sessions hidden');
  sessionsList.id = 'chat-session-list';
  sessionsList.setAttribute('role', 'listbox');
  sessionsList.setAttribute('aria-label', 'Claude sessions');
  sessionsList.tabIndex = -1;
  sessionsList.addEventListener('click', onSessionClick);
  sessionsList.addEventListener('keydown', onSessionKey);

  const notice = el('div', 'cp-notice');
  notice.id = 'chat-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;

  const awaiting = el('section', 'cp-awaiting');
  awaiting.id = 'chat-awaiting';
  awaiting.setAttribute('role', 'group');
  awaiting.tabIndex = -1;
  awaiting.hidden = true;

  const views = el('div', 'cp-views');
  views.id = 'chat-views';
  const stream = el('div', 'cp-stream');
  stream.id = 'chat-stream';
  stream.setAttribute('role', 'log');
  stream.setAttribute('aria-label', 'Conversation with Claude');
  stream.tabIndex = -1;
  const newPill = button('cp-new');
  newPill.id = 'chat-new';
  newPill.hidden = true;
  const detailHost = el('div', 'cp-detail');
  detailHost.id = 'chat-detail';
  detailHost.hidden = true;
  views.append(stream, newPill, detailHost);

  const slot = el('div', 'cp-composer');
  slot.id = 'chat-composer-slot';

  panel.append(head, strip, meta, notice, awaiting, views, slot);
  return { panel, head, title, stop, ops, close, strip, label, detail, meta, session: null, sessionsList,
    notice, awaiting, views, stream, newPill, detailHost, slot };
}

function applyVariant(next) {
  variant = next === 'sheet' ? 'sheet' : 'desktop';
  P.panel.dataset.variant = variant;
  if (variant === 'sheet') {
    if (P.close.textContent !== 'Close' || P.close.firstElementChild) P.close.replaceChildren('Close');
  } else if (!P.close.querySelector('kbd')) {
    P.close.replaceChildren(el('kbd', null, 'Esc'));
  }
  P.close.title = variant === 'sheet' ? 'Close the chat' : 'Close the chat (Esc)';
}

// ── moving between hosts ─────────────────────────────────────────────────────

// The stream is stuck while it shows its bottom (within 48px). An element with
// no layout (scrollHeight 0) is not: its offset is simply kept.
function isStuck(s) {
  return s.scrollHeight > 0 && s.scrollHeight - s.scrollTop - s.clientHeight <= STUCK_PX;
}

function moveTo(host, nextVariant) {
  const s = P.stream;
  const top = s.scrollTop;
  const stuck = isStuck(s);
  closeSessions(false);
  if (P.panel.parentElement !== host) host.append(P.panel);
  applyVariant(nextVariant);
  // A browser drops an element's scroll offset when it leaves the document.
  s.scrollTop = top;
  if (stuck) s.scrollTop = s.scrollHeight;
  render();
}

function onHost(d) {
  if (!P || !d || !d.host || typeof d.host.append !== 'function') return;
  moveTo(d.host, d.variant);
}

// ── chat:open's view ─────────────────────────────────────────────────────────

function applyView(d) {
  if (!P || !running || !P.panel.isConnected) return;
  render();
  const view = d && d.view;
  if (view === 'awaiting') {
    focusAwaiting(P.awaiting);
  } else if (DETAIL_VIEWS.includes(view)) {
    if (details.has(view)) {
      const params = {};
      if (d.id !== undefined) params.id = d.id;
      if (d.node_id !== undefined) params.node_id = d.node_id;
      openDetail({ kind: view, params });
    }
  } else if (view === 'chat') {
    while (stack.length) popDetail({ refocus: false });
  }
}

function onOpen(d) {
  const detail = d && typeof d === 'object' ? { ...d } : {};
  queueMicrotask(() => applyView(detail));
}

// ── the strip, the meta line, the notice ─────────────────────────────────────

function renderStrip(now) {
  const s = uiState(mirror, { now, approvalsReady: !!approvals() });
  setAttr(P.strip, 'data-cs-state', s.key);
  setAttr(P.strip, 'data-cs-pace', s.pace);
  setText(P.label, s.label);
  setText(P.detail, s.detail);
  if (P.strip.title !== s.text) P.strip.title = s.text;
}

function fmtTokens(n) {
  if (n < 1000) return `${n} tokens`;
  const short = (v, unit) => `${(Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '')}${unit} tokens`;
  return n < 1e6 ? short(n / 1000, 'k') : short(n / 1e6, 'M');
}

function stateOf(id) {
  const c = mirror.conversations.get(id);
  if (c && c.live) return c.live.state;
  const r = mirror.status.get(id);
  return r ? r.state : 'unknown';
}

// The conversations the switcher offers: live ones, and those that ended under
// an hour ago. At `read` and above the records say which are headless and what
// each is called; below it there are only the content-free status rows.
function candidates(now) {
  const out = [];
  const recent = (endedAt) => Number.isFinite(endedAt) && now - endedAt < RECENT_MS;
  if (mirror.conversations.size) {
    for (const c of mirror.conversations.values()) {
      const state = stateOf(c.id);
      if (state === 'ended' && !recent(Number.isFinite(c.ended_at) ? c.ended_at : c.live && c.live.since)) continue;
      out.push({ id: c.id, title: c.title || '', state, headless: c.headless === true,
        last: c.last_activity_at || (c.live && c.live.last_activity_at) || 0 });
    }
  } else {
    for (const r of mirror.status.values()) {
      if (r.state === 'ended' && !recent(r.since)) continue;
      out.push({ id: r.id, title: '', state: r.state, headless: false, last: r.last_activity_at || 0 });
    }
  }
  return out.sort((a, b) => b.last - a.last || (a.id < b.id ? -1 : 1));
}

function costPart(c) {
  if (!c || !c.cost) return null;
  const ended = stateOf(c.id) === 'ended';
  if (ended && Number.isFinite(c.cost.usd)) return `$${c.cost.usd.toFixed(2)}`;
  const t = c.cost.tokens;
  if (!t) return null;
  const sum = ['input', 'output', 'cache_read', 'cache_creation'].reduce((n, k) => n + (Number.isFinite(t[k]) ? t[k] : 0), 0);
  return sum > 0 ? fmtTokens(sum) : null;
}

function renderMeta(now) {
  const cid = followed();
  const list = cid ? candidates(now) : [];
  const switcher = list.length >= 2;
  const c = cid ? mirror.conversations.get(cid) : null;
  const title = (c && c.title) || UNTITLED;
  const modeRaw = c ? c.permission_mode || c.mode || '' : '';
  const parts = [];
  if (c && c.model) parts.push({ text: c.model, cls: 'cp-model' });
  if (modeRaw) {
    parts.push({ text: MODE_WORDS[modeRaw] || modeRaw,
      cls: DANGER_MODES.has(modeRaw) ? 'cp-mode cp-ink-comment' : 'cp-mode' });
  }
  const cost = costPart(c);
  if (cost) parts.push({ text: cost, cls: 'cp-cost' });
  const key = JSON.stringify([cid, switcher, title, parts]);
  if (key !== metaKey) {
    metaKey = key;
    P.meta.hidden = !cid;
    const wasOpen = sessionsOpen();
    const hadFocus = P.session && document.activeElement === P.session;
    let session;
    if (switcher) {
      session = button('cp-session');
      session.setAttribute('aria-haspopup', 'listbox');
      session.setAttribute('aria-controls', 'chat-session-list');
      session.setAttribute('aria-expanded', String(wasOpen));
      session.title = 'Switch the Claude session this chat follows';
      session.append(el('span', 'cp-session-title', title), el('span', 'cp-caret', '▾'));
      session.lastChild.setAttribute('aria-hidden', 'true');
      session.addEventListener('click', toggleSessions);
    } else {
      session = el('span', 'cp-session');
      session.append(el('span', 'cp-session-title', title));
    }
    session.id = 'chat-session';
    const nodes = [session];
    for (const p of parts) {
      const sep = el('span', 'cp-sep', '·');
      sep.setAttribute('aria-hidden', 'true');
      nodes.push(sep, el('span', p.cls, p.text));
    }
    // The listbox stays put (moving it would drop the focus inside it); only
    // the line in front of it is rebuilt.
    for (const n of [...P.meta.childNodes]) if (n !== P.sessionsList) n.remove();
    if (P.sessionsList.parentElement !== P.meta) P.meta.append(P.sessionsList);
    for (const n of nodes) P.meta.insertBefore(n, P.sessionsList);
    P.session = session;
    if (!switcher) closeSessions(false);
    if (hadFocus) focusEl(session);
  }
  if (sessionsOpen()) renderSessions(list);
}

function renderNotice() {
  const conn = mirror.conn;
  const avail = mirror.availability;
  const level = mirror.access.level;
  let kind = null;
  if (conn !== 'live' && (conn === 'reconnecting' || avail !== 'unknown')) kind = 'offline';
  else if (avail === 'disabled') kind = 'disabled';
  else if ((avail === 'ok' || level === 'off') && !atLeast(level, 'read')) kind = 'remote';
  const key = `${kind}|${kind === 'disabled' ? mirror.hint || '' : ''}`;
  if (key === noticeKey) return;
  noticeKey = key;
  const n = P.notice;
  n.hidden = !kind;
  setAttr(n, 'data-notice', kind);
  if (kind === 'offline') n.replaceChildren(el('p', 'cp-notice-line', OFFLINE_NOTE));
  else if (kind === 'disabled') n.replaceChildren(el('p', 'cp-notice-line', mirror.hint || DISABLED_NOTE));
  else if (kind === 'remote') {
    const how = el('p', 'cp-notice-line', 'To allow it, run on the host: ');
    how.append(el('code', null, REMOTE_COMMAND));
    n.replaceChildren(el('p', 'cp-notice-line', REMOTE_NOTE), how);
  } else n.replaceChildren();
}

// ── the session switcher ─────────────────────────────────────────────────────

const sessionsOpen = () => !!P && !P.sessionsList.classList.contains('hidden');

function renderSessions(list) {
  const cid = followed();
  const shown = list.filter((x) => !x.headless || showHeadless || x.id === cid);
  const hidden = list.length - shown.length;
  const key = JSON.stringify([cid, shown, hidden]);
  if (key === sessionsKey) return;
  sessionsKey = key;
  const focusedId = document.activeElement && P.sessionsList.contains(document.activeElement)
    ? document.activeElement.dataset.conversation || null : null;
  const rows = shown.map((x) => {
    const li = el('li', 'cp-session-opt');
    li.setAttribute('role', 'option');
    li.dataset.conversation = x.id;
    li.setAttribute('aria-selected', String(x.id === cid));
    li.tabIndex = -1;
    const dot = el('span', 'cp-dot');
    dot.setAttribute('data-cs-state', inkOf(x.state));
    dot.setAttribute('aria-hidden', 'true');
    li.append(dot, el('span', 'cp-session-name', x.title || UNTITLED));
    if (x.headless) li.append(el('span', 'cp-tag', 'headless'));
    li.title = x.state;
    return li;
  });
  if (hidden > 0) {
    const more = el('li', 'cp-show-headless', `Show headless (${hidden})`);
    more.setAttribute('role', 'option');
    more.setAttribute('aria-selected', 'false');
    more.tabIndex = -1;
    rows.push(more);
  }
  P.sessionsList.replaceChildren(...rows);
  if (focusedId) focusEl(rows.find((r) => r.dataset.conversation === focusedId));
}

function openSessions() {
  if (!P || !P.session || P.session.tagName !== 'BUTTON') return;
  showHeadless = false;
  sessionsKey = null;
  P.sessionsList.classList.remove('hidden');
  P.session.setAttribute('aria-expanded', 'true');
  // One panel at a time (the shell's dismiss layer): every other popover closes.
  window.dispatchEvent(new CustomEvent('wc:close-popovers', { detail: { keep: P.sessionsList } }));
  renderSessions(candidates(serverNow()));
  const opts = [...P.sessionsList.querySelectorAll('[role="option"]')];
  focusEl(opts.find((o) => o.getAttribute('aria-selected') === 'true') || opts[0]);
}

function closeSessions(refocus = true) {
  if (!sessionsOpen()) return;
  const hadFocus = P.sessionsList.contains(document.activeElement);
  P.sessionsList.classList.add('hidden');
  if (P.session && P.session.tagName === 'BUTTON') P.session.setAttribute('aria-expanded', 'false');
  showHeadless = false;
  sessionsKey = null;
  if (refocus && hadFocus) focusEl(P.session);
}

function toggleSessions() {
  if (sessionsOpen()) closeSessions();
  else openSessions();
}

function choose(li) {
  if (!li) return;
  if (li.classList.contains('cp-show-headless')) {
    showHeadless = true;
    renderSessions(candidates(serverNow()));
    focusEl(P.sessionsList.querySelector('[role="option"]'));
    return;
  }
  const id = li.dataset.conversation;
  closeSessions();
  if (id) followConversation(id);
  schedule();
}

function onSessionClick(e) {
  const li = e.target && e.target.closest ? e.target.closest('li[role="option"]') : null;
  if (li && P.sessionsList.contains(li)) choose(li);
}

function onSessionKey(e) {
  const opts = [...P.sessionsList.querySelectorAll('[role="option"]')];
  const at = opts.indexOf(document.activeElement);
  const go = (i) => { e.preventDefault(); focusEl(opts[Math.max(0, Math.min(opts.length - 1, i))]); };
  switch (e.key) {
    case 'ArrowDown': go(at + 1); break;
    case 'ArrowUp': go(at - 1); break;
    case 'Home': go(0); break;
    case 'End': go(opts.length - 1); break;
    case 'Enter': case ' ':
      e.preventDefault();
      choose(opts[at]);
      break;
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();   // this Escape closes the list, and nothing behind it
      closeSessions();
      break;
    case 'Tab':
      closeSessions(false);
      break;
    default:
  }
}

// ── the composer slot ────────────────────────────────────────────────────────

function renderComposer() {
  const impl = composer();
  if (impl === composerHeld.impl && variant === composerHeld.variant) return;
  P.slot.replaceChildren();
  composerHeld = { impl, variant };
  if (impl) {
    try {
      impl.mount(P.slot, { variant });
      return;
    } catch (e) {
      console.error('[web-chat] the composer failed to mount', e);
      P.slot.replaceChildren();
    }
  }
  P.slot.append(el('p', 'cp-composer-note', COMPOSER_NOTE));
}

// ── details ──────────────────────────────────────────────────────────────────

export function registerDetail(kind, render) {
  if (typeof kind !== 'string' || !kind) throw new TypeError('registerDetail: kind must be a non-empty string');
  if (typeof render !== 'function') throw new TypeError('registerDetail: render must be a function');
  details.set(kind, render);
  return () => { if (details.get(kind) === render) details.delete(kind); };
}

export function hasDetail(kind) {
  return details.has(kind);
}

function showTop() {
  const open = stack.length > 0;
  P.detailHost.hidden = !open;
  P.views.classList.toggle('cp-detail-open', open);
  // The stream stays laid out under the view (its offset survives), out of reach.
  P.stream.toggleAttribute('inert', open);
  if (open) P.stream.setAttribute('aria-hidden', 'true');
  else P.stream.removeAttribute('aria-hidden');
  stack.forEach((d, i) => { d.view.hidden = i !== stack.length - 1; });
}

// A view over the stream: '‹ Chat' back, the title, and a body the registered
// render fills — render(bodyEl, params, {close, setTitle}), which may return a
// cleanup to run when the view is popped. → whether it opened.
export function openDetail({ kind, title = '', params = {} } = {}) {
  const render = details.get(kind);
  if (!P || !render) return false;
  const view = el('div', 'cp-dview');
  view.dataset.kind = kind;
  const head = el('div', 'cp-dhead');
  const back = button('cp-back', '‹ Chat', 'Back to the chat');
  const name = el('span', 'cp-dtitle', String(title || ''));
  head.append(back, name);
  const body = el('div', 'cp-dbody');
  view.append(head, body);
  const entry = { kind, view, back, cleanup: null };
  back.addEventListener('click', () => {
    const i = stack.indexOf(entry);
    if (i >= 0) popDetail();
  });
  stack.push(entry);
  P.detailHost.append(view);
  showTop();
  try {
    const ctx = { close: () => { if (stack.includes(entry)) removeEntry(entry); }, setTitle: (t) => setText(name, String(t || '')) };
    const r = render(body, params && typeof params === 'object' ? params : {}, ctx);
    if (typeof r === 'function') entry.cleanup = r;
  } catch (e) {
    console.error(`[web-chat] the '${kind}' detail view failed`, e);
    removeEntry(entry, { refocus: false });
    return false;
  }
  focusEl(back);
  return true;
}

function removeEntry(entry, { refocus = true } = {}) {
  const i = stack.indexOf(entry);
  if (i < 0) return;
  stack.splice(i, 1);
  if (entry.cleanup) {
    try { entry.cleanup(); } catch (e) { console.error(`[web-chat] the '${entry.kind}' detail view's cleanup failed`, e); }
  }
  entry.view.remove();
  showTop();
  if (!refocus) return;
  const top = stack[stack.length - 1];
  if (top) focusEl(top.back);
  else focusEl(P.stream);
}

// Pop the top detail view: '‹ Chat', the dock's first Escape step, or a
// chat:open {view: 'chat'}. → whether there was one.
export function popDetail({ refocus = true } = {}) {
  if (!stack.length) return false;
  removeEntry(stack[stack.length - 1], { refocus });
  return true;
}

// ── drawing ──────────────────────────────────────────────────────────────────

function render() {
  if (!P || typeof document === 'undefined') return;
  const now = serverNow();
  renderStrip(now);
  renderMeta(now);
  renderNotice();
  renderAwaiting(P.awaiting, { variant });
  renderComposer();
}

function cancelFrame() {
  if (frame === null) return;
  const caf = globalThis.cancelAnimationFrame;
  if (typeof caf === 'function') caf(frame);
  frame = null;
}

// Every event of one frame is one render.
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

function tick() {
  // The document is gone (a test's teardown): there is nothing to draw on.
  if (typeof document === 'undefined' || !P) {
    stopTicker();
    return;
  }
  render();
}

function startTicker() {
  if (ticker !== null) return;
  ticker = setInterval(tick, TICK_MS);
  if (ticker && typeof ticker === 'object' && typeof ticker.unref === 'function') ticker.unref();
}

function stopTicker() {
  if (ticker === null) return;
  clearInterval(ticker);
  ticker = null;
}

function onPosture(d) {
  if (d && d.posture === 'full') {
    startTicker();
    schedule();
  } else {
    stopTicker();
    closeSessions(false);
  }
}

// ── the module's surface ─────────────────────────────────────────────────────

export function panelEl() {
  return P ? P.panel : null;
}

export function initChatPanel() {
  if (typeof document === 'undefined') return null;
  if (running) return P.panel;
  if (!P) {
    P = build();
    applyVariant(variant);
    const host = document.getElementById('cd-body');
    if (host) host.append(P.panel);
  }
  running = true;
  offs = [
    bus.on('chat:host', onHost),
    bus.on('chat:open', onOpen),
    bus.on('chat:posture', onPosture),
    bus.on('mirror', schedule),
    bus.on('queue', schedule),
  ];
  offEscape = addEscapeStep(() => popDetail());
  if (posture() === 'full') startTicker();
  render();
  return P.panel;
}

export function stopPanel() {
  stopTicker();
  cancelFrame();
  for (const off of offs.splice(0)) off();
  if (offEscape) {
    offEscape();
    offEscape = null;
  }
  running = false;
}

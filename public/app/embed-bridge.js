// The embed bridge (U470; form 6 V1/V2/W2; web-chat-contracts 06 C-06.33 to
// C-06.36, schema web-chat-contracts/schemas/06-embed-message.json): the
// postMessage set between the hub shell — the parent window, at embed_parent —
// and this chrome while it is embedded in the hub's chat view.
//
// It runs only while public/app/remote.js says the page is embedded (framed AND
// health said so) and names an https embed_parent; otherwise it listens to
// nothing and posts nothing. Started by shell.js initShell, which hands it the
// shell's Escape (handleEscape) and the keyboard dispatch's context.
//
// IN (shell → chrome), each accepted only when event.isTrusted, event.source
// === window.parent and event.origin === embedParent(), and data.wc_embed is 1:
//   {type: 'command', action}  one chrome action: an id of the hotkey registry
//                              (public/app/hotkeys.js), run through runAction,
//                              which honours the action's enabled() and context
//                              exactly as its key would — an id outside COMMANDS,
//                              unregistered, descriptive, disabled or out of
//                              context is refused and nothing runs. chrome.escape
//                              is the shell's handleEscape (its registry row is
//                              descriptive). chrome.sessions is never a command.
//   {type: 'mode', mode}       light or dark, through theme.js setMode.
// OUT (chrome → shell), posted only to embedParent() with that targetOrigin:
//   {type: 'ready', package_version, actions}  when the bridge starts (health
//                              read, embedded) and again after each reconnect.
//   {type: 'status', conn, pill, node_label, title, previewing, mode,
//    mode_toggleable, queue_count}  what the hidden topbar would show, on change,
//                              at most every STATUS_MIN_MS.
//
// NOTHING HERE GRANTS ANYTHING. Every command is an action a key or a click in
// the frame already takes, with the same guards; status is display only (pane
// scripts share this realm, so the shell must never act on what it says; the
// title is agent-written text the shell sets as text).
//
// FOCUS: postMessage carries no user activation, so the shell focuses the frame
// (iframe.focus()) before it posts a command that opens a panel (the palette,
// the chat, the drawer, the bookmark, settings, wipe, new graph) — the panel's
// deferred focus() then lands inside the frame (06 C-06.36).
//
//   initEmbedBridge({escape, context})   start watching remote.js; idempotent
//   handleMessage(event) → boolean       the message listener (exported: a test
//                                        cannot dispatch a trusted event)
//   readyMessage() / statusMessage()     what would be posted now
//   COMMANDS, STATUS_MIN_MS, BRIDGE_VERSION
import { bus } from './bus.js';
import { view, $ } from './state.js';
import { isEmbedded, embedParent, frameParent, healthVersion, onEmbedChange, isRemote } from './remote.js';
import { runAction, actionOf } from './hotkeys.js';
import { setMode, effectiveMode, modeToggleable } from './theme.js';
import { pillState } from './topbar.js';
import { queueSnapshot } from './queue.js';
import { runningBuild } from './version.js';

export const BRIDGE_VERSION = 1;
export const STATUS_MIN_MS = 250;
// The schema's command enum, in its order.
export const COMMANDS = Object.freeze(['chrome.palette', 'chrome.graph', 'chrome.add', 'chrome.bookmark',
  'chrome.replay', 'chrome.prev', 'chrome.next', 'chrome.rail', 'chrome.push', 'chrome.chat', 'chrome.legend',
  'chrome.mode', 'chrome.settings', 'chrome.export', 'chrome.wipe', 'chrome.new-graph', 'chrome.escape']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cut = (s, n) => (typeof s === 'string' && s ? s.slice(0, n) : null);

let hooks = { escape: () => {}, context: () => 'page' };
let wired = false;
let started = false;
let offs = [];
let observer = null;
let lastStatus = null;     // the JSON of the last status posted
let lastPostAt = 0;
let statusTimer = null;
let lastConn = null;

function post(msg) {
  const target = frameParent();
  const origin = embedParent();
  if (!started || !target || !origin || typeof target.postMessage !== 'function') return false;
  try { target.postMessage(msg, origin); return true; } catch { return false; }
}

// The command ids this chrome accepts now: registered with a run, and Escape.
function acceptedActions() {
  return COMMANDS.filter((id) => id === 'chrome.escape' || !!(actionOf(id) && actionOf(id).run));
}

export function readyMessage() {
  return { wc_embed: BRIDGE_VERSION, type: 'ready', package_version: cut(healthVersion() || runningBuild(), 64) || '',
    actions: acceptedActions() };
}

export function statusMessage() {
  const st = pillState();
  const detached = !!(view.previewing && view.viewedId && view.viewedId !== view.activeId);
  const nl = $('node-label');
  const pt = $('page-title');
  let count = 0;
  try { count = queueSnapshot().count || 0; } catch { count = 0; }
  const conn = ['live', 'connecting', 'reconnecting'].includes(view.conn) ? view.conn : 'connecting';
  return {
    wc_embed: BRIDGE_VERSION, type: 'status', conn,
    pill: { cls: cut(st.cls, 32) || '', text: cut(st.text, 64) || '' },
    node_label: nl ? cut(nl.textContent.trim(), 64) : null,
    title: pt ? cut(pt.textContent.trim(), 200) : null,
    previewing: detached,
    mode: effectiveMode() === 'dark' ? 'dark' : 'light',
    mode_toggleable: modeToggleable(),
    queue_count: Number.isSafeInteger(count) && count > 0 ? count : 0,
  };
}

function flushStatus() {
  statusTimer = null;
  if (!started) return;
  const msg = statusMessage();
  const json = JSON.stringify(msg);
  if (json === lastStatus) return;
  if (post(msg)) { lastStatus = json; lastPostAt = Date.now(); }
}
function scheduleStatus() {
  if (!started || statusTimer) return;
  const wait = Math.max(0, lastPostAt + STATUS_MIN_MS - Date.now());
  statusTimer = setTimeout(flushStatus, wait);
}

function command(action) {
  if (typeof action !== 'string' || !COMMANDS.includes(action)) return false;
  if (action === 'chrome.escape') { hooks.escape(); return true; }
  let ctx = 'page';
  try { ctx = hooks.context() || 'page'; } catch { ctx = 'page'; }
  return runAction(action, { context: ctx }).ok === true;
}

export function handleMessage(e) {
  if (!started || !e || e.isTrusted !== true) return false;
  const parent = frameParent();
  const origin = embedParent();
  if (!parent || !origin || e.source !== parent || e.origin !== origin) return false;
  const d = e.data;
  if (!isObject(d) || d.wc_embed !== BRIDGE_VERSION) return false;
  if (d.type === 'command') return command(d.action);
  if (d.type === 'mode') {
    if (d.mode !== 'light' && d.mode !== 'dark') return false;
    setMode(d.mode);
    scheduleStatus();
    return true;
  }
  return false;
}

function start() {
  if (started) return;
  started = true;
  lastStatus = null;
  lastConn = view.conn;
  window.addEventListener('message', handleMessage);
  offs.push(() => window.removeEventListener('message', handleMessage));
  offs.push(bus.on('conn', ({ state } = {}) => {
    // A reconnect: the shell hears ready again (and answers with its mode).
    if (state === 'live' && lastConn === 'reconnecting') post(readyMessage());
    lastConn = state;
    scheduleStatus();
  }));
  for (const t of ['view', 'queue', 'mode']) offs.push(bus.on(t, scheduleStatus));
  const MO = typeof window !== 'undefined' && window.MutationObserver;
  if (MO) {
    observer = new MO(scheduleStatus);
    for (const id of ['node-label', 'page-title', 'active-pill', 'btn-theme-toggle']) {
      const el = $(id);
      if (el) observer.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
    }
  }
  post(readyMessage());
  scheduleStatus();
}

function stop() {
  if (!started) return;
  started = false;
  for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } }
  if (observer) { observer.disconnect(); observer = null; }
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  lastStatus = null;
}

function follow({ embedded, parent } = {}) {
  if (embedded && parent) start(); else stop();
}

export function initEmbedBridge({ escape, context } = {}) {
  if (typeof escape === 'function') hooks.escape = escape;
  if (typeof context === 'function') hooks.context = context;
  if (wired) return;
  wired = true;
  onEmbedChange(follow);
  isRemote().then(() => follow({ embedded: isEmbedded(), parent: embedParent() }));
}

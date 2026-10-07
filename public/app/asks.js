// The chrome's asks (spec §4.5's chrome side, §7.2 registerApprovals): the
// answer frames in the status bar, the awaiting card and the phone's sheet,
// and the one helper that mounts a frame on the answer origin — which U85's
// control frames (Stop, the confirms) go through too.
//
//   initAsks({ onFrame, onHello, fetch, now, timers, remote })   idempotent; U66a
//                                       calls it from main.js. A second call only
//                                       swaps fetch, now, timers and remote (a
//                                       stand-in for remote.js, for the tests).
//   stopAsks()                          takes every frame down, unregisters,
//                                       forgets the port (teardown, tests)
//   mountAnswerFrame(container, { kind = 'ask', id, path, query, layout,
//                    onDone, onOpenChat, clipboard = false, title })
//                                       → { frame, unmount() } | null
//   answerFrameOrigin()                 the origin frames load from now, or null
//   PORT_EVENT                          chrome-bus 'answer:port' {origin}
//
// WHY A FRAME. Pane scripts run in this realm and own the DOM around anything
// the chrome draws; an endpoint that approves a permission runs host commands.
// So the chrome never answers an ask itself: it frames a document of the
// answer origin (lib/server/answer-surface), which draws the subject beside
// its own buttons and answers only on a trusted click it has guarded (§4.5).
// The chrome names the tool at most (`Permission · Bash`, ruling Q8) and never
// touches the frame's opacity, filter, transform, clip or mask. Esc and the
// drawer's outside-click never answer anything: nothing here binds a key.
//
// THE PORT. The answer surface listens on 127.0.0.1:<ephemeral>; its port
// reaches the chrome in each mirror:ask frame's `answer` and in GET
// /api/asks?ensure=1 (which also starts the surface). This module keeps the
// last one it learned (the "cached port"). A remote page frames from the
// portal's answer origin instead (remote.js answerOrigin(), X-WC-Answer-Origin)
// and, without one, frames nothing: tranche 4 answers nothing remotely, so a
// phone through the portal keeps the read-only card.
//
// SYNCHRONOUS MOUNTS (A-confirm (1)). A mount never waits on the network:
//   * the approvals provider (mountBar, mountCard, mountSheet, unmount)
//     registers only once a port is known — the boot GET /api/asks?ensure=1, or
//     a mirror:ask frame's `answer` — so until then approvals() is null, and
//     chat-bar.js (on its 1 s tick) and chat-awaiting.js (on the panel's next
//     draw) show the terminal state; nothing is refused for want of a port. A
//     remote page registers once remote.js has answered (its "port" is the
//     answer origin, or none: then each mount answers false, for good);
//   * with a cached port every mount is at once, even when the port is more
//     than 60 s old — that one is refreshed in the background;
//   * mountAnswerFrame with no port at all answers null at once, starts the
//     refresh (one in-flight GET, shared), and when it finds a port emits
//     PORT_EVENT, on which its caller asks again (U85's session-control);
//   * a port change (an idle-closed surface reopened, a daemon restart)
//     remounts every mounted frame at the new origin.
//
// THE FRAME. <iframe class="wc-answer-frame"> at
//   <origin>/answer/ask/<id>?layout=&mode=&device=      an ask
//   <origin>/answer/<kind>/<path>?<query>&layout=&mode=&device=   a control frame
// with referrerpolicy no-referrer, a title, allow="clipboard-write" only when
// asked (the confirm layout's Copy), and no sandbox. Every message is checked
// against the frame's origin AND its contentWindow; only three are read:
// wc-answer:size {height} (clamped 22-480 into the iframe's height),
// wc-answer:open-chat {id} (onOpenChat, or chrome-bus chat:open {view:
// 'awaiting', id}) and wc-answer:done {id, outcome, result?} (onDone(outcome,
// result), the result kept to numbers and booleans). The chrome-bus 'mode'
// goes to every frame as wc-answer:mode.
//
// A FRAME THAT NEVER LOADS (§4.5 item 10). No wc-answer:size within 3 s (one
// bounded setTimeout per mount): an ask frame becomes a `Review & answer ↗`
// button opening the page layout in a popup; a control frame is never the
// popup — the port is refreshed and the frame remounted once at the fresh
// port, and if that one is silent too its slot stays empty until the next
// port refresh.
import { bus } from './bus.js';
import { registerApprovals } from './chat-slots.js';
import { effectiveMode } from './theme.js';
import { deviceKind } from './viewport.js';
import * as remote from './remote.js';
import { loopbackOrigin } from './remote.js';

export const PORT_EVENT = 'answer:port';
export const STALE_MS = 60_000;
export const LOAD_MS = 3000;
export const SIZE_MIN = 22;
export const SIZE_MAX = 480;
export const POPUP_FEATURES = 'popup,width=460,height=600';
export const POPUP_LABEL = 'Review & answer ↗';
const ASKS_URL = '/api/asks?ensure=1';
const KIND_RE = /^[a-z][a-z-]{1,23}$/;
const LAYOUT_RE = /^[a-z][a-z-]{0,23}$/;
const ASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OUTCOME_RE = /^[a-z][a-z-]{0,39}$/;
const RESULT_MAX_BYTES = 2048;
const KIND_WORD = { permission: 'permission', question: 'question', plan: 'plan' };

let fetchFn = (url, init) => globalThis.fetch(url, init);
let now = () => Date.now();
let timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h),
};

// remote.js, or (tests) a stand-in with the same four functions.
const REMOTE_FNS = ['isRemote', 'remoteNow', 'remoteKnown', 'answerOrigin'];
let R = remote;
const isRemote = () => R.isRemote();
const remoteNow = () => R.remoteNow();
const remoteKnown = () => R.remoteKnown();
const answerOrigin = () => R.answerOrigin();

let inited = null;
let offs = [];
let port = null;          // the cached answer-surface port
let portAt = 0;           // when it was last learned or confirmed
let refreshing = null;    // the one in-flight GET /api/asks?ensure=1
let unregister = null;    // the approvals provider's registration
let announced = null;     // the origin PORT_EVENT last named
let generation = 0;       // bumped by stopAsks: a refresh from before it is ignored
const frames = new Set(); // every mounted record
const slots = new Map();  // a provider container → its record

const validPort = (p) => Number.isSafeInteger(p) && p > 0 && p < 65536;
const clampSize = (h) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.ceil(h)));

// ── the origin ───────────────────────────────────────────────────────────────

// Where frames load from now, or null (no port yet, or remote-ness unknown).
export function answerFrameOrigin() {
  if (!remoteKnown()) return null;
  if (remoteNow()) return answerOrigin();
  return loopbackOrigin(port);
}

function announce() {
  const origin = answerFrameOrigin();
  if (!origin || origin === announced) return;
  announced = origin;
  bus.emit(PORT_EVENT, { origin });
}

function learnPort(p) {
  if (!validPort(p)) return;
  const changed = p !== port;
  port = p;
  portAt = now();
  if (changed) {
    for (const rec of [...frames]) { rec.retried = false; remount(rec); }
  }
  register();
  announce();
}

// GET /api/asks?ensure=1: starts the answer surface and answers its port. One
// at a time; every caller shares the one in flight. Never throws.
function refreshPort() {
  if (refreshing) return refreshing;
  const gen = generation;
  const run = (async () => {
    try {
      const r = await fetchFn(ASKS_URL);
      if (!r || !r.ok) return null;
      const j = await r.json();
      const p = j && j.answer && j.answer.port;
      if (gen !== generation || !validPort(p)) return null;
      learnPort(p);
      // A control frame left empty after a silent remount gets its next try.
      for (const rec of [...frames]) if (rec.dead) { rec.retried = false; remount(rec); }
      return p;
    } catch {
      return null;
    }
  })();
  refreshing = run;
  run.then(() => { if (refreshing === run) refreshing = null; });
  return run;
}

// ── the approvals provider ──────────────────────────────────────────────────

const answerable = (ask) => !!ask && ask.source === 'ask' && ask.state === 'pending' && ask.answerable === true
  && typeof ask.id === 'string' && ASK_ID_RE.test(ask.id);

function mountSlot(el, ask, layout) {
  if (!el || !answerable(ask)) return false;
  if (remoteNow() && !answerOrigin()) return false;
  const prev = slots.get(el);
  if (prev) { slots.delete(el); unmountRecord(prev); }
  const kindWord = KIND_WORD[ask.kind] || 'prompt';
  const rec = open(el, {
    kind: 'ask', id: ask.id, layout,
    title: `Answer Claude's ${kindWord}${ask.tool_name && ask.kind === 'permission' ? ` for ${ask.tool_name}` : ''}`,
  });
  if (!rec) return false;
  slots.set(el, rec);
  return true;
}

const provider = Object.freeze({
  mountBar: (el, ask) => mountSlot(el, ask, 'bar'),
  mountCard: (el, ask) => mountSlot(el, ask, 'card'),
  mountSheet: (el, ask) => mountSlot(el, ask, 'sheet'),
  unmount(el) {
    const rec = slots.get(el);
    if (!rec) return;
    slots.delete(el);
    unmountRecord(rec);
  },
});

// Once a port is known (or, remote, once remote-ness is): the provider
// registers, and the bar and the card pick it up on their own next draw.
function register() {
  if (unregister || !inited || !remoteKnown()) return;
  if (!remoteNow() && port === null) return;
  unregister = registerApprovals(provider);
}

// ── a frame ─────────────────────────────────────────────────────────────────

function normalize(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const kind = o.kind === undefined ? 'ask' : o.kind;
  if (kind !== 'ask' && !(typeof kind === 'string' && KIND_RE.test(kind) && kind !== 'asks' && kind !== 'api' && kind !== 'fonts')) return null;
  if (typeof o.layout !== 'string' || !LAYOUT_RE.test(o.layout)) return null;
  const id = typeof o.id === 'string' ? o.id : '';
  if (kind === 'ask' && !ASK_ID_RE.test(id)) return null;
  let path = '';
  if (kind !== 'ask' && o.path != null) {
    if (typeof o.path !== 'string' || o.path.length > 512) return null;
    const segs = o.path.split('/').filter(Boolean);
    if (segs.some((x) => x === '.' || x === '..')) return null;   // never leave the kind's own space
    path = segs.map(encodeURIComponent).join('/');
  }
  let query = [];
  if (o.query != null) {
    const q = typeof o.query === 'string' || o.query instanceof URLSearchParams ? new URLSearchParams(o.query) : null;
    query = q ? [...q.entries()] : Object.entries(o.query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]);
  }
  return {
    kind, id, path, query, layout: o.layout,
    onDone: typeof o.onDone === 'function' ? o.onDone : null,
    onOpenChat: typeof o.onOpenChat === 'function' ? o.onOpenChat : null,
    clipboard: o.clipboard === true,
    title: typeof o.title === 'string' && o.title ? o.title.slice(0, 200) : (kind === 'ask' ? 'Answer Claude' : 'web-chat control'),
  };
}

function frameUrl(rec, origin, layout = rec.layout) {
  const base = rec.kind === 'ask'
    ? `/answer/ask/${encodeURIComponent(rec.id)}`
    : `/answer/${rec.kind}${rec.path ? `/${rec.path}` : ''}`;
  const u = new URL(base, origin);
  if (rec.kind !== 'ask') for (const [k, v] of rec.query) u.searchParams.append(k, v);
  let mode = 'light';
  try { mode = effectiveMode() === 'dark' ? 'dark' : 'light'; } catch { /* the theme is not up yet */ }
  let device = 'desktop';
  try { device = deviceKind() === 'mobile' ? 'mobile' : 'desktop'; } catch { /* no viewport yet */ }
  u.searchParams.set('layout', layout);
  u.searchParams.set('mode', mode);
  u.searchParams.set('device', device);
  return u.href;
}

// Content-free: numbers and booleans only, ≤ 2 KB.
function cleanResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) continue;
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') out[k] = v;
  }
  if (!Object.keys(out).length) return undefined;
  return JSON.stringify(out).length <= RESULT_MAX_BYTES ? out : undefined;
}

function onMessage(rec, e) {
  const f = rec.el;
  if (!f || e.source == null || e.source !== f.contentWindow || e.origin !== rec.origin) return;
  const d = e.data;
  if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
  if (d.type === 'wc-answer:size') {
    const h = Number(d.height);
    if (!Number.isFinite(h)) return;
    rec.sized = true;
    rec.dead = false;
    rec.retried = false;
    if (rec.timer !== null) { timers.clearTimeout(rec.timer); rec.timer = null; }
    f.style.height = `${clampSize(h)}px`;
  } else if (d.type === 'wc-answer:open-chat') {
    const id = rec.kind === 'ask' ? rec.id : (typeof d.id === 'string' && ASK_ID_RE.test(d.id) ? d.id : rec.id);
    if (rec.onOpenChat) {
      try { rec.onOpenChat(id); } catch (err) { console.error('[web-chat] an answer frame\'s onOpenChat failed', err); }
    } else {
      bus.emit('chat:open', { view: 'awaiting', id });
    }
  } else if (d.type === 'wc-answer:done') {
    const outcome = typeof d.outcome === 'string' && OUTCOME_RE.test(d.outcome) ? d.outcome : null;
    if (!outcome || !rec.onDone) return;
    try { rec.onDone(outcome, cleanResult(d.result)); } catch (err) { console.error('[web-chat] an answer frame\'s onDone failed', err); }
  }
}

// Build (or rebuild, in place) the record's iframe at the current origin.
function remount(rec) {
  if (!frames.has(rec)) return;
  const origin = answerFrameOrigin();
  if (!origin) return;
  if (rec.timer !== null) { timers.clearTimeout(rec.timer); rec.timer = null; }
  rec.origin = origin;
  rec.sized = false;
  rec.dead = false;
  const f = document.createElement('iframe');
  f.className = 'wc-answer-frame';
  f.dataset.kind = rec.kind;
  f.dataset.layout = rec.layout;
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.title = rec.title;
  if (rec.clipboard) f.setAttribute('allow', 'clipboard-write');
  f.src = frameUrl(rec, origin);
  const old = rec.el || rec.fallback;
  if (old && old.parentNode) old.replaceWith(f); else rec.container.append(f);
  rec.el = f;
  rec.fallback = null;
  rec.mounts += 1;
  rec.timer = timers.setTimeout(() => silent(rec), LOAD_MS);
}

// No size message within LOAD_MS: the frame never loaded (§4.5 item 10).
function silent(rec) {
  rec.timer = null;
  if (!frames.has(rec) || rec.sized) return;
  if (rec.kind === 'ask') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wc-answer-popup';
    b.textContent = POPUP_LABEL;
    b.title = 'Answer in a window of its own';
    const url = frameUrl(rec, rec.origin, 'page');
    b.addEventListener('click', () => { window.open(url, '_blank', POPUP_FEATURES); });
    if (rec.el && rec.el.parentNode) rec.el.replaceWith(b); else rec.container.append(b);
    rec.el = null;
    rec.fallback = b;
    return;
  }
  // A control frame is never the popup: refresh the port, remount once; a
  // second silence leaves the slot empty until the next port refresh.
  if (!rec.retried) {
    rec.retried = true;
    const mounts = rec.mounts;
    refreshPort().then(() => {
      // A refresh that found a NEW port has remounted it already.
      if (frames.has(rec) && !rec.sized && rec.mounts === mounts) remount(rec);
    });
    return;
  }
  if (rec.el) rec.el.remove();
  rec.el = null;
  rec.dead = true;
}

function open(container, opts) {
  if (!container || typeof container.append !== 'function') return null;
  const o = normalize(opts);
  if (!o) return null;
  if (!remoteKnown()) {
    // Asked before remote.js has answered: the answer brings PORT_EVENT.
    isRemote();
    if (port === null) refreshPort();
    return null;
  }
  if (remoteNow() && !answerOrigin()) return null;
  const origin = answerFrameOrigin();
  if (!origin) {
    refreshPort();
    return null;
  }
  if (!remoteNow() && now() - portAt > STALE_MS) refreshPort();   // in the background
  const rec = { ...o, container, origin, el: null, fallback: null, timer: null, sized: false, retried: false, dead: false, mounts: 0 };
  rec.listener = (e) => onMessage(rec, e);
  window.addEventListener('message', rec.listener);
  frames.add(rec);
  remount(rec);
  return rec;
}

function unmountRecord(rec) {
  if (!frames.delete(rec)) return;
  if (rec.timer !== null) { timers.clearTimeout(rec.timer); rec.timer = null; }
  window.removeEventListener('message', rec.listener);
  if (rec.el) rec.el.remove();
  if (rec.fallback) rec.fallback.remove();
  rec.el = null;
  rec.fallback = null;
}

export function mountAnswerFrame(container, opts) {
  const rec = open(container, opts);
  if (!rec) return null;
  return {
    get frame() { return rec.el; },
    unmount() { unmountRecord(rec); },
  };
}

// ── wiring ───────────────────────────────────────────────────────────────────

function onMode(d) {
  const mode = d && (d.mode === 'dark' || d.mode === 'light') ? d.mode : null;
  if (!mode) return;
  for (const rec of frames) {
    const w = rec.el && rec.el.contentWindow;
    if (!w) continue;
    try { w.postMessage({ type: 'wc-answer:mode', mode }, rec.origin); } catch { /* the frame is going */ }
  }
}

export function initAsks({ onFrame, onHello, fetch, now: nowFn, timers: t, remote: r } = {}) {
  if (typeof fetch === 'function') fetchFn = fetch;
  if (r && REMOTE_FNS.every((k) => typeof r[k] === 'function')) R = r;
  if (typeof nowFn === 'function') now = nowFn;
  if (t && typeof t.setTimeout === 'function' && typeof t.clearTimeout === 'function') timers = t;
  if (inited) return inited;
  inited = { stop: stopAsks };
  if (typeof onFrame === 'function') {
    offs.push(onFrame('mirror:ask', (msg) => {
      const a = msg && msg.answer;
      if (a && typeof a === 'object' && validPort(a.port)) learnPort(a.port);
    }));
  }
  // A (re)connect may be a restarted daemon, with its surface on a new port.
  if (typeof onHello === 'function') offs.push(onHello(() => { refreshPort(); }));
  offs.push(bus.on('mode', onMode));
  const gen = generation;
  isRemote().then(() => {
    if (gen !== generation) return;
    register();
    announce();
  });
  refreshPort();
  return inited;
}

export function stopAsks() {
  for (const rec of [...frames]) unmountRecord(rec);
  slots.clear();
  for (const off of offs.splice(0)) { try { if (typeof off === 'function') off(); } catch { /* gone */ } }
  if (unregister) { unregister(); unregister = null; }
  generation += 1;
  inited = null;
  port = null;
  portAt = 0;
  refreshing = null;
  announced = null;
  R = remote;
}

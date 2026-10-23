// The report path's REMOTE carrier in the chrome (annotation engine PLAN.md
// 2B.1; DECISIONS.md A3; U312): on a page viewed through the tunnel portal by
// a viewer at `full`, the transport public/app/overlay-report.js hands every
// batch to, instead of the socket (a remote socket's report is refused whole,
// U311: one path per peer).
//
//   tabViewerId() → string | null
//       this tab's viewer id (K.2-56): minted once per tab into sessionStorage
//       (public/app/storage.js), so it survives a reload of the tab and
//       differs across tabs; a private window with no storage gets a fresh id
//       per load. overlay-report.js tells the daemon (setClientField
//       'viewer'), which keys a local socket's held answers by it, and the
//       report frame below carries it, so a reconnect is the same viewer.
//   initRemoteReports({setTransport, viewer, now, timers, remote, mayAct}) → stop()
//       called once from overlay-report.js's init with its setReportTransport;
//       `remote` (remote.js's isRemote, remoteKnown, remoteNow, answerOrigin)
//       and `mayAct` are stand-ins for the tests, as asks.js takes `remote`.
//
// WHY A FRAME (PLAN-T2 §2.3 2B (2); P-17). The answer surface's API answers
// only a document it served (the X-WC-Answer nonce in that document's
// <meta>), so the chrome never fetches it: it mounts ONE `elements` answer
// frame (public/app/asks.js mountAnswerFrame, on the portal's answer origin)
// and posts each batch into it; the frame's module
// (lib/server/answer-surface/public/elements-report.js) POSTs it. The frame
// sits in a container with the `hidden` attribute at the end of <body>: a
// stand-in by name, with no CSS and nothing drawn.
//
// WHEN. Only on a remote page (remote.js isRemote()) with an answer origin
// (X-WC-Answer-Origin) whose viewer may act at full (session-control.js
// mayAct(), read again on every chrome-bus `mirror` change). Below full, on a
// local page, or with no answer origin, nothing is mounted or registered, and
// a page that drops below full takes the frame and the transport down.
//
// THE HAND-OFF. A batch posted before the frame's module says it listens
// (READY_CHANNEL) waits in a queue of at most QUEUE_MAX (the oldest dropped).
// When the frame says its nonce has expired (EXPIRED_CHANNEL), it is mounted
// afresh — the first time at once, then at most once per REMOUNT_MIN_MS — and
// the last RECENT_MAX batches posted to the old one go again (the daemon's
// replace rule makes a repeat from the same viewer harmless; a stale one is
// refused stale-surface).
// Messages are checked against the frame's origin AND its contentWindow.
//
// C-15-1: a pane script shares this realm and can post into the frame (P-17);
// what it can report is bounded by the daemon exactly as a forged socket
// report is, and nothing here treats pane:<id> or user as a boundary.
import { bus } from './bus.js';
import * as remoteJs from './remote.js';
import { mayAct as mayActNow } from './session-control.js';
import { mountAnswerFrame } from './asks.js';
import { getSession, setSession } from './storage.js';

export const REPORT_CHANNEL = 'wc-elements:report';
export const READY_CHANNEL = 'wc-elements:ready';
export const EXPIRED_CHANNEL = 'wc-elements:expired';
export const VIEWER_KEY = 'wc-report-viewer';
export const VIEWER_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const QUEUE_MAX = 32;
export const RECENT_MAX = 8;
export const REMOUNT_MIN_MS = 30_000;
export const FRAME = Object.freeze({ kind: 'elements', path: 'report', layout: 'report', title: 'web-chat reports' });

function mintId() {
  const bytes = new Uint8Array(16);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let viewerId = null;
export function tabViewerId() {
  if (viewerId) return viewerId;
  const had = getSession(VIEWER_KEY, null);
  if (typeof had === 'string' && VIEWER_RE.test(had)) {
    viewerId = had;
    return viewerId;
  }
  viewerId = mintId();
  setSession(VIEWER_KEY, viewerId);
  return viewerId;
}

const REMOTE_FNS = ['isRemote', 'remoteKnown', 'remoteNow', 'answerOrigin'];

export function initRemoteReports({
  setTransport, viewer = null, now = Date.now,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
  remote = remoteJs, mayAct = mayActNow,
} = {}) {
  if (typeof setTransport !== 'function') return () => {};
  const R = remote && REMOTE_FNS.every((k) => typeof remote[k] === 'function') ? remote : remoteJs;
  const may = typeof mayAct === 'function' ? mayAct : mayActNow;
  const id = typeof viewer === 'string' && VIEWER_RE.test(viewer) ? viewer : null;
  let stopped = false;
  let container = null;
  let handle = null;
  let origin = null;
  let unregister = null;
  let readyWin = null;
  let queue = [];
  let recent = [];
  let lastRemount = -Infinity;
  let remountTimer = null;
  const counts = { posted: 0, queued: 0, dropped: 0, remounts: 0 };

  const wanted = () => R.remoteKnown() && R.remoteNow() && !!R.answerOrigin() && may();
  const frameWin = () => {
    const f = handle && handle.frame;
    return f ? f.contentWindow : null;
  };

  function postNow(item) {
    const w = frameWin();
    if (!w || w !== readyWin) return false;
    try { w.postMessage(item, origin); } catch { return false; }
    counts.posted += 1;
    recent.push(item);
    if (recent.length > RECENT_MAX) recent.shift();
    return true;
  }
  function enqueue(item) {
    queue.push(item);
    counts.queued += 1;
    while (queue.length > QUEUE_MAX) { queue.shift(); counts.dropped += 1; }
  }
  function drain() {
    const items = queue;
    queue = [];
    for (let i = 0; i < items.length; i++) {
      if (!postNow(items[i])) { queue = items.slice(i).concat(queue); return; }
    }
  }

  function transport(msg) {
    if (stopped || !msg || typeof msg !== 'object') return;
    const item = { channel: REPORT_CHANNEL, report: { surface: msg.surface, mounts: msg.mounts } };
    if (queue.length || !postNow(item)) enqueue(item);
  }

  function frameNow() {
    readyWin = null;
    handle = mountAnswerFrame(container, { ...FRAME, query: id ? { viewer: id } : undefined });
    return !!handle;
  }

  function remount() {
    remountTimer = null;
    if (stopped || !handle) return;
    // The batches the old document may not have sent go again, first.
    queue = recent.concat(queue).slice(-QUEUE_MAX);
    recent = [];
    try { handle.unmount(); } catch { /* gone */ }
    handle = null;
    lastRemount = now();
    counts.remounts += 1;
    if (!frameNow()) down();
  }

  function onMessage(e) {
    if (stopped || !handle) return;
    const w = frameWin();
    if (!w || e.source !== w || e.origin !== origin) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.channel === READY_CHANNEL) {
      readyWin = w;
      drain();
    } else if (d.channel === EXPIRED_CHANNEL) {
      readyWin = null;
      if (remountTimer !== null) return;
      const wait = Math.max(0, lastRemount + REMOUNT_MIN_MS - now());
      if (wait === 0) remount();
      else remountTimer = timers.setTimeout(remount, wait);
    }
  }

  function up() {
    origin = R.answerOrigin();
    container = document.createElement('div');
    container.hidden = true;
    container.dataset.wcStandIn = 'elements-report';
    document.body.append(container);
    if (!frameNow()) {
      container.remove();
      container = null;
      return;
    }
    window.addEventListener('message', onMessage);
    unregister = setTransport(transport);
  }

  function down() {
    if (remountTimer !== null) { timers.clearTimeout(remountTimer); remountTimer = null; }
    if (unregister) { try { unregister(); } catch { /* gone */ } unregister = null; }
    window.removeEventListener('message', onMessage);
    if (handle) { try { handle.unmount(); } catch { /* gone */ } }
    handle = null;
    if (container) container.remove();
    container = null;
    readyWin = null;
    queue = [];
    recent = [];
  }

  function evaluate() {
    if (stopped) return;
    const want = wanted();
    if (want && !handle) up();
    else if (!want && handle) down();
  }

  const offMirror = bus.on('mirror', evaluate);
  Promise.resolve(R.isRemote()).then(evaluate, () => {});
  evaluate();

  function stop() {
    if (stopped) return;
    stopped = true;
    offMirror();
    down();
  }
  stop.stats = () => ({ mounted: !!handle, ready: !!readyWin && readyWin === frameWin(), queue: queue.length, ...counts });
  return stop;
}

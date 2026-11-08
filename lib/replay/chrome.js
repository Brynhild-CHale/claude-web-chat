// Driving a system Chrome, headless, over the DevTools protocol on a PIPE.
//
// A replay GIF is a sequence of screenshots of the replay document
// (lib/server/replay/document.js) seeked to each frame's time. Something has to
// draw those frames exactly as a browser would — pane scripts, fonts, fades —
// and the only honest way is a browser. Puppeteer/Playwright are out (the
// tarball's four-dependency policy, and a bundled Chromium), so this speaks the
// DevTools protocol itself, to whichever Chrome lib/replay/find.js located.
//
// `--remote-debugging-pipe` rather than a port: Chrome reads commands on fd 3
// and writes replies on fd 4, each a JSON message terminated by a NUL byte. No
// debugging port is opened, so nothing else on the machine can attach to this
// browser while it runs, and nothing here needs a WebSocket or an HTTP client.
//
// The browser gets a throwaway profile under .web-chat/tmp/ (never the user's
// real one; lib/replay/tmp names it and sweeps a dead daemon's), no first-run UI, and a fixed device scale factor so a screenshot is
// exactly the size asked for. It also runs with --disable-gpu (software
// raster), so two screenshots of the same content are the same pixels.
//
// ── Teardown is bounded and decisive ───────────────────────────────────────
// A Chrome that outlives its render is a leak the user never sees: a headless
// browser plus its helper processes, holding memory until the next reboot.
// Test runs once left four behind, and SIGTERM did not stop them — a Chrome
// whose browser thread is wedged (the Keychain hang --use-mock-keychain now
// avoids was one way to get there) never runs its own shutdown, and does not
// act on the debugging pipe closing either. Only SIGKILL ended them. So:
//   * Chrome is spawned as the leader of its OWN process group, and every
//     signal goes to the group — the renderer/GPU/utility helpers share it, so
//     a kill reaches them too, not just the browser process.
//   * close() asks politely (Browser.close), then SIGTERMs the group, then
//     SIGKILLs it, each step with a ceiling (GRACE), and removes the profile.
//     It always settles, whatever the browser does. After the browser exits,
//     the group is swept with SIGKILL once more for any helper left behind.
//   * captureFrames tears down on EVERY way out: success, failure, its
//     wall-clock timeout, and a caller's AbortSignal (the daemon aborts an
//     in-flight render when it shuts down — lib/server/routes/replay.js).
//   * A process that exits with a browser still up (process.exit mid-render, an
//     uncaught exception) SIGKILLs its group synchronously from an 'exit' hook —
//     the last line, since nothing async runs then. A process killed outright
//     (SIGKILL) gets no say; a healthy Chrome then exits on its own when the
//     pipe closes, and a wedged one is what `ps` is for. Its profile directory
//     is swept by the next daemon to boot or render (lib/replay/tmp).
//   * A browser that exits, or a page that crashes, mid-capture fails the
//     capture at once: every command AND every event waiter on the pipe is
//     rejected with the reason, so nothing waits out the wall-clock timeout
//     (which would hold the render route's single flight for five minutes).
//     Each is handed out already handled, so one its caller abandoned (a
//     navigation that failed before its load waiter was awaited) is not an
//     unhandled rejection — which would exit the daemon.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { makeTmpDir, removeDir } = require('./tmp');

class ChromeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ChromeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// How long each teardown step waits for the browser to exit before the next,
// harder one. The worst case of close() is their sum (plus the profile removal),
// so it is bounded by construction.
const GRACE = Object.freeze({ closeMs: 3000, termMs: 1000, killMs: 2000 });
const STDERR_KEEP = 4000;

// Own process group where the platform has them (every supported one: macOS,
// Linux, WSL2). Signalling -pid reaches the browser and all its helpers.
const OWN_GROUP = process.platform !== 'win32';

// Deliver `sig` to the browser's process group (or just the process, where
// there are no groups). Only ever a child this module spawned itself. → bool
function signalGroup(proc, sig) {
  if (!proc || typeof proc.pid !== 'number') return false;
  if (OWN_GROUP) {
    try { process.kill(-proc.pid, sig); return true; } catch { /* the group is gone — fall through */ }
  }
  try { return proc.kill(sig); } catch { return false; }
}

// Every browser this process has up, for the exit hook.
const live = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous by necessity: nothing async runs during 'exit'.
  process.on('exit', () => {
    for (const b of live) {
      signalGroup(b.proc, 'SIGKILL');
      removeProfile(b.profileDir);
    }
    live.clear();
  });
}

const CHROME_FLAGS = [
  '--headless=new',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  // A picture pair's second shot must match the first outside the ink
  // (PICTURE@aligned). With the GPU compositor, content under a layer that
  // stops painting re-rounds by one level; software raster is deterministic.
  // This is the capture process only; the live chrome is untouched.
  '--disable-gpu',
  '--mute-audio',
  // Never touch the OS keychain / keyring for the throwaway profile's cookie
  // key. On macOS the first network request otherwise waits on a Keychain
  // lookup that can block forever (observed with a non-default HOME: the
  // connection opens and no request is ever written).
  '--use-mock-keychain',
  '--password-store=basic',
];

// ── the protocol ────────────────────────────────────────────────────────────

// A DevTools connection over two streams: `out` (Chrome's fd 3, we write) and
// `inp` (Chrome's fd 4, we read). send() resolves with a command's result or
// rejects with its protocol error; events go to on() listeners.
function createPipeConnection(out, inp) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  // once() waiters still listening: fn → reject. A connection that closes fails
  // them with its reason exactly as it fails pending commands — an event that
  // can no longer arrive must not leave its awaiter hanging until the render's
  // wall-clock timeout (which also held the render route's single flight).
  const waiters = new Map();
  let buffered = Buffer.alloc(0);
  let closedError = null;

  // Every promise handed out below can be rejected by failAll — on the pipe's
  // schedule, not the caller's. A caller that makes one and then throws before
  // awaiting it (Page.navigate failing while the load-event waiter is out) must
  // not leave a rejection nobody handles: the daemon installs no
  // unhandledRejection listener, so one would exit it — no answer, no
  // draft.json. So each goes out with a no-op handler already attached; whoever
  // awaits it still sees the rejection.
  const handedOut = (p) => { p.catch(() => {}); return p; };

  const failAll = (err) => {
    if (closedError) return;
    closedError = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    for (const [fn, reject] of waiters) { listeners.delete(fn); reject(err); }
    waiters.clear();
  };

  inp.on('data', (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    let nul;
    while ((nul = buffered.indexOf(0)) >= 0) {
      const raw = buffered.subarray(0, nul).toString('utf8');
      buffered = buffered.subarray(nul + 1);
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new ChromeError('cdp-error', `${method}: ${msg.error.message || 'protocol error'}`));
        else resolve(msg.result || {});
      } else if (msg.method) {
        for (const fn of listeners) { try { fn(msg); } catch { /* a listener is not the connection */ } }
      }
    }
  });
  inp.on('close', () => failAll(new ChromeError('chrome-exited', 'Chrome closed its debugging pipe')));
  inp.on('error', (e) => failAll(new ChromeError('chrome-exited', `Chrome's debugging pipe failed: ${e.message}`)));
  out.on('error', (e) => failAll(new ChromeError('chrome-exited', `Chrome's debugging pipe failed: ${e.message}`)));

  return {
    send(method, params = {}, sessionId) {
      if (closedError) return handedOut(Promise.reject(closedError));
      const id = nextId++;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      return handedOut(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        out.write(JSON.stringify(msg) + '\0');
      }));
    },
    // Resolve on the first event `method` (for `sessionId`, when given) that
    // satisfies `pred`; reject with the connection's reason if it closes first —
    // even when the caller has stopped listening (handedOut keeps that quiet).
    once(method, { sessionId, pred } = {}) {
      return handedOut(new Promise((resolve, reject) => {
        if (closedError) return reject(closedError);
        const fn = (msg) => {
          if (msg.method !== method) return;
          if (sessionId && msg.sessionId !== sessionId) return;
          if (pred && !pred(msg.params || {})) return;
          listeners.delete(fn);
          waiters.delete(fn);
          resolve(msg.params || {});
        };
        listeners.add(fn);
        waiters.set(fn, reject);
      }));
    },
    fail: failAll,
  };
}

// ── the browser process ─────────────────────────────────────────────────────

// Launch Chrome on a fresh profile under `tmpDir`. `grace` overrides GRACE
// (the tests shorten it).
// → { proc, cdp, profileDir, exited: Promise, stderr(), close() }
function launchChrome({ chromePath, tmpDir, spawnImpl = spawn, grace = {} }) {
  const g = { ...GRACE, ...grace };
  if (!chromePath) throw new ChromeError('chrome-not-found', 'no Chrome to launch');
  const profileDir = makeTmpDir(tmpDir, 'chrome');

  const args = [...CHROME_FLAGS, `--user-data-dir=${profileDir}`, 'about:blank'];
  let proc;
  try {
    proc = spawnImpl(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: OWN_GROUP });
  } catch (e) {
    removeProfile(profileDir);
    throw new ChromeError('chrome-launch-failed', `could not start ${chromePath}: ${e.message}`);
  }

  if (!proc.stdio || !proc.stdio[3] || !proc.stdio[4]) {
    signalGroup(proc, 'SIGKILL');
    removeProfile(profileDir);
    throw new ChromeError('chrome-launch-failed', `could not open the debugging pipe to ${chromePath}`);
  }
  let errTail = '';
  if (proc.stderr) {
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-STDERR_KEEP); });
  }
  const cdp = createPipeConnection(proc.stdio[3], proc.stdio[4]);
  const exited = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
    proc.once('error', (e) => {
      cdp.fail(new ChromeError('chrome-launch-failed', `could not start ${chromePath}: ${e.message}`));
      resolve({ code: null, signal: null, error: e });
    });
  });
  exited.then(({ code, signal }) => cdp.fail(new ChromeError('chrome-exited',
    `Chrome exited (${signal || `code ${code}`}) before the render finished${errTail ? `: ${lastLine(errTail)}` : ''}`)));

  const handle = { proc, profileDir, close: () => close() };
  live.add(handle);
  installExitHook();

  let closing = null;
  // Ask politely, then insist, then force — each step bounded. Always settles,
  // always sweeps the process group, always removes the profile.
  function close() {
    if (closing) return closing;
    closing = (async () => {
      const gone = () => proc.exitCode != null || proc.signalCode != null;
      const waitExit = (ms) => Promise.race([exited.then(() => true), delay(ms).then(() => false)]);
      if (!gone()) {
        cdp.send('Browser.close').catch(() => {});
        if (!(await waitExit(g.closeMs))) {
          signalGroup(proc, 'SIGTERM');
          if (!(await waitExit(g.termMs))) {
            signalGroup(proc, 'SIGKILL');
            await waitExit(g.killMs);
          }
        }
      }
      // The browser is gone (or as gone as SIGKILL makes it); a helper that
      // outlived it is not. Nothing in the group is ours to keep.
      signalGroup(proc, 'SIGKILL');
      cdp.fail(new ChromeError('chrome-closed', 'the browser was closed'));
      live.delete(handle);
      removeProfile(profileDir);
    })();
    return closing;
  }

  return { proc, cdp, profileDir, exited, stderr: () => errTail, close };
}

function lastLine(s) {
  const lines = String(s).trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

function delay(ms) { return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }); }

// Best effort; a profile a dead daemon left behind is lib/replay/tmp's sweep.
const removeProfile = removeDir;

// ── the capture ─────────────────────────────────────────────────────────────

// Evaluate `expression` in the page and return its value, awaiting a promise.
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'script error';
    throw new ChromeError('page-error', `the replay page threw: ${String(text).split('\n')[0]}`);
  }
  return r.result ? r.result.value : undefined;
}

// captureFrames({ chromePath, url, width, height, times, tmpDir, timeoutMs,
//                 onFrame(pngBuffer, index) })
// Opens `url` (a replay document served with chrome=0) at width×height, waits
// for window.__wcReplay.ready(), then for each time in `times` seeks there and
// takes a PNG screenshot, handing it to onFrame before taking the next — so a
// caller can encode as it goes and never holds every frame at once.
// `signal` (an AbortSignal) abandons the capture the same way the timeout does.
// → { frames, duration } ; rejects with a ChromeError (code: chrome-not-found,
// chrome-launch-failed, chrome-exited, page-crashed, page-error, timeout,
// aborted, cdp-error). A browser that exits, or a page that crashes, fails the
// capture at once — never by running out the wall-clock timeout.
// Whichever way it settles, the browser has been torn down (launchChrome close)
// by the time it does.
async function captureFrames({
  chromePath, url, width, height, times, tmpDir, timeoutMs = 300000, onFrame, spawnImpl, signal, grace,
}) {
  if (signal && signal.aborted) throw new ChromeError('aborted', 'the render was cancelled');
  const browser = launchChrome({ chromePath, tmpDir, spawnImpl, grace });
  let timer = null;
  let onAbort = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ChromeError('timeout',
      `the render did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    if (signal) {
      onAbort = () => reject(new ChromeError('aborted', 'the render was cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  // A renderer that crashes leaves the browser — and so the pipe — up: nothing
  // would ever answer the command in flight. Inspector.targetCrashed is the
  // only word of it, so it fails the capture outright.
  let onCrash = null;
  const crashed = new Promise((_, reject) => { onCrash = reject; });
  const run = async () => {
    const { cdp } = browser;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.once('Inspector.targetCrashed', { sessionId }).then(
      () => onCrash(new ChromeError('page-crashed', 'the replay page crashed in Chrome before the render finished')),
      () => { /* the connection closed first — its own reason fails the capture */ },
    );
    // Crash detection is a nicety: a browser that does not know the domain
    // still renders.
    await cdp.send('Inspector.enable', {}, sessionId).catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    // Armed before the navigation so the event cannot slip past. If the
    // navigation throws, nothing awaits `loaded` and the teardown rejects it —
    // harmless only because once() hands it out already handled (handedOut).
    const loaded = cdp.once('Page.loadEventFired', { sessionId });
    const nav = await cdp.send('Page.navigate', { url }, sessionId);
    if (nav.errorText) throw new ChromeError('page-error', `could not load the replay page: ${nav.errorText}`);
    await loaded;
    const info = await evaluate(cdp, sessionId,
      '(async () => { const r = window.__wcReplay; if (!r) throw new Error("no replay player on the page");'
      + ' await r.ready(); return { duration: r.duration(), steps: r.steps.length }; })()');
    for (let i = 0; i < times.length; i++) {
      const t = Number(times[i]) || 0;
      await evaluate(cdp, sessionId, `window.__wcReplay.seek(${JSON.stringify(t)}).then(() => true)`);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
      if (!shot || typeof shot.data !== 'string') throw new ChromeError('cdp-error', 'Page.captureScreenshot returned no image');
      await onFrame(Buffer.from(shot.data, 'base64'), i);
    }
    return { frames: times.length, duration: info && info.duration };
  };
  const running = run();
  // After a timeout the capture is abandoned mid-flight; close() below fails its
  // outstanding commands, and that late rejection must not surface as unhandled.
  running.catch(() => {});
  try {
    return await Promise.race([running, deadline, crashed]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await browser.close();
  }
}

// regionClip(box, rel, margin, doc) → {x, y, w, h}: the clip of a REGION
// (captureClip's `region`, U564's picture) — `rel` {x, y, w, h}, fractions of
// the element's box {left, top, width, height} (document coordinates), grown
// by `margin` CSS px on every side and clamped to the document {w, h}; whole
// pixels, rounded outward, at least 1×1. Pure and self-contained: captureClip
// runs this very function's source in the page.
function regionClip(box, rel, margin, doc) {
  const num = (n, d) => (typeof n === 'number' && isFinite(n) ? n : d);
  const m = Math.max(0, num(margin, 0));
  const bw = Math.max(0, num(box.width, 0));
  const bh = Math.max(0, num(box.height, 0));
  const rx = num(rel && rel.x, 0);
  const ry = num(rel && rel.y, 0);
  const rw = Math.max(0, num(rel && rel.w, 1));
  const rh = Math.max(0, num(rel && rel.h, 1));
  const dw = Math.max(1, num(doc && doc.w, Infinity));
  const dh = Math.max(1, num(doc && doc.h, Infinity));
  let x0 = Math.floor(Math.max(0, num(box.left, 0) + rx * bw - m));
  let y0 = Math.floor(Math.max(0, num(box.top, 0) + ry * bh - m));
  let x1 = Math.ceil(Math.min(dw, num(box.left, 0) + (rx + rw) * bw + m));
  let y1 = Math.ceil(Math.min(dh, num(box.top, 0) + (ry + rh) * bh + m));
  if (x0 > dw - 1) x0 = Math.floor(dw - 1);
  if (y0 > dh - 1) y0 = Math.floor(dh - 1);
  if (x1 < x0 + 1) x1 = x0 + 1;
  if (y1 < y0 + 1) y1 = y0 + 1;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// unionBox(box, rel, others, margin, doc, maxH) → {x, y, w, h}: the clip of a
// region that covers SEVERAL elements (captureClip's `region.selectors`, U617:
// a page stroke from one pane to the next) — the union of the primary's rel
// box (`box` × `rel`, exactly as regionClip reads them) and each of
// `others`' whole boxes {left, top, width, height} (document coordinates),
// grown by `margin` CSS px on every side and clamped to the document {w, h};
// whole pixels, rounded outward, at least 1×1. Its height is then capped at
// `maxH` (captureClip passes REGION_HEIGHT_MAX): a taller union is cut to a
// window of that height centred on the primary's rel box (± margin) and
// shifted inside the union, so the primary's rel box stays inside the cap
// whenever it fits in one. With no `others` and no cap it is regionClip.
// Pure and self-contained, like regionClip: captureClip runs its source in
// the page too.
function unionBox(box, rel, others, margin, doc, maxH) {
  const num = (n, d) => (typeof n === 'number' && isFinite(n) ? n : d);
  const b = box && typeof box === 'object' ? box : {};
  const m = Math.max(0, num(margin, 0));
  const bw = Math.max(0, num(b.width, 0));
  const bh = Math.max(0, num(b.height, 0));
  const rx = num(rel && rel.x, 0);
  const ry = num(rel && rel.y, 0);
  const rw = Math.max(0, num(rel && rel.w, 1));
  const rh = Math.max(0, num(rel && rel.h, 1));
  const dw = Math.max(1, num(doc && doc.w, Infinity));
  const dh = Math.max(1, num(doc && doc.h, Infinity));
  const kl = num(b.left, 0) + rx * bw;
  const kt = num(b.top, 0) + ry * bh;
  const kr = num(b.left, 0) + (rx + rw) * bw;
  const kb = num(b.top, 0) + (ry + rh) * bh;
  let l = kl; let t = kt; let r = kr; let btm = kb;
  for (const o of Array.isArray(others) ? others : []) {
    if (!o || typeof o !== 'object') continue;
    const ol = num(o.left, NaN);
    const ot = num(o.top, NaN);
    if (!isFinite(ol) || !isFinite(ot)) continue;
    l = Math.min(l, ol);
    t = Math.min(t, ot);
    r = Math.max(r, ol + Math.max(0, num(o.width, 0)));
    btm = Math.max(btm, ot + Math.max(0, num(o.height, 0)));
  }
  const span = (lo, hi, dmax) => {
    let a = Math.floor(Math.max(0, lo - m));
    let z = Math.ceil(Math.min(dmax, hi + m));
    if (a > dmax - 1) a = Math.floor(dmax - 1);
    if (z < a + 1) z = a + 1;
    return [a, z];
  };
  const [x0, x1] = span(l, r, dw);
  let [y0, y1] = span(t, btm, dh);
  const cap = Math.max(1, Math.floor(num(maxH, Infinity)));
  if (y1 - y0 > cap) {
    const [k0, k1] = span(kt, kb, dh);
    let w0 = Math.floor(k0 - (cap - (k1 - k0)) / 2);
    w0 = Math.min(Math.max(w0, y0), y1 - cap);
    y0 = w0;
    y1 = w0 + cap;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// How many animation frames captureClip waits for a region's element to be
// laid out (a document's element runtime places its markers after load).
const REGION_FRAMES = 120;

// The tallest clip a region with `selectors` may take, in CSS px (U617).
// 4,096: about four laptop screens — room for an arrow from one pane to a
// pane several screens below it — while the PNG stays one Chrome can encode
// in a single captureScreenshot without tiling (Chrome's GPU texture limit is
// typically 16,384) and a reader still sees detail once a vision model scales its long
// side down. A taller union is cut to this, centred on the primary.
const REGION_HEIGHT_MAX = 4096;
// How many elements beside the primary a region may name (U617).
const REGION_SELECTORS_MAX = 8;

// The page script that computes a region's clip (an expression resolving to
// regionClip's {x, y, w, h}, or null when the element is not on the page or
// never gets a box): the element `selector` names, waited for up to
// `frames` animation frames, scrolled into view, its box in document
// coordinates, and the document's scroll size as the clamp. With
// `selectors` (at most REGION_SELECTORS_MAX strings; the rest, and anything
// not a string, dropped) it resolves to unionBox's clip instead: the
// primary's rel box and the whole box of each listed element on the page and
// laid out once the primary is in view (one that is not, or whose selector
// does not parse, is ignored — the primary still clips), capped at
// REGION_HEIGHT_MAX.
function regionScript(region, frames = REGION_FRAMES) {
  const r = region && typeof region === 'object' ? region : {};
  const listed = (Array.isArray(r.selectors) ? r.selectors : [])
    .filter((s) => typeof s === 'string' && s).slice(0, REGION_SELECTORS_MAX);
  const relJson = JSON.stringify(r.rel && typeof r.rel === 'object' ? r.rel : null);
  const marginJson = JSON.stringify(Number.isFinite(r.margin) ? r.margin : 0);
  const clipExpr = listed.length
    ? `(() => {
    const boxes = [];
    for (const s of ${JSON.stringify(listed)}) {
      let o = null;
      try { o = document.querySelector(s); } catch (e) { o = null; }
      if (!o || !laid(o)) continue;
      const ob = o.getBoundingClientRect();
      boxes.push({ left: ob.left + window.scrollX, top: ob.top + window.scrollY, width: ob.width, height: ob.height });
    }
    return (${unionBox.toString()})(primary, ${relJson}, boxes, ${marginJson}, doc, ${REGION_HEIGHT_MAX});
  })()`
    : `(${regionClip.toString()})(primary, ${relJson}, ${marginJson}, doc)`;
  return `(async () => {
    const sel = ${JSON.stringify(typeof r.selector === 'string' ? r.selector : '')};
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    const laid = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    let el = null;
    for (let i = 0; i < ${Number.isInteger(frames) && frames > 0 ? frames : 1}; i++) {
      try { el = document.querySelector(sel); } catch (e) { return null; }
      if (el && laid(el)) break;
      await frame();
    }
    if (!el || !laid(el)) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await frame();
    const b = el.getBoundingClientRect();
    const de = document.documentElement;
    const body = document.body || de;
    const doc = { w: Math.max(de.scrollWidth, body.scrollWidth), h: Math.max(de.scrollHeight, body.scrollHeight) };
    const primary = { left: b.left + window.scrollX, top: b.top + window.scrollY, width: b.width, height: b.height };
    return ${clipExpr};
  })()`;
}

// The page script captureClip's second shot runs between its two screenshots
// (U617): ONE <style data-wc-second> whose text is `style` — handed in as a
// JSON string literal and set as textContent, never parsed as markup and
// never a script the caller wrote — appended to the document's head, then two
// animation frames so it is drawn before the second screenshot.
function secondScript(style) {
  return `(async () => {
    const s = document.createElement('style');
    s.setAttribute('data-wc-second', '');
    s.textContent = ${JSON.stringify(typeof style === 'string' ? style : '')};
    (document.head || document.documentElement).appendChild(s);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`;
}

// captureClip({ chromePath, html | url, width, height, mobile, colorScheme,
//               item, selector, scroll, clip | region, second, tmpDir, timeoutMs, signal, spawnImpl, grace })
// One screenshot of one region of a document — the box grab's render (U328b)
// — or, with `second`, two of the same region from ONE browser session (U617).
// The browser is launchChrome's, and it is torn down exactly as captureFrames'
// is — on success, failure, the wall-clock timeout and the caller's abort.
// `html` (a self-contained document: the export path's buildExportHtml) is
// written into the browser's own throwaway profile directory and loaded from
// there, so it goes when the profile does; `url` loads a page instead. The
// viewport is width×height CSS px at scale 1 (`mobile` and `colorScheme`
// emulated when given). `selector` names the element the clip is measured
// from — the box grab's: the item's CONTENT BOX, a pane's `.mount-host` or a
// markdown item's block (K.2-72), the frame the live chrome measures in;
// without it, `item` names it: the element carrying data-pane-id or
// data-md-id equal to it (the export shell's per-item attributes). That
// element is scrolled to the top of the viewport, and `clip` {x, y, w, h} is
// taken relative to its box — element-relative, so the coordinates the live
// chrome measured survive the topbar and the scroll. `scroll` {top, left},
// when given, is set as that element's OWN scrollTop / scrollLeft before the
// clip (K.2-80: a rows-capped pane's content box scrolls, and the live chrome
// measured the rect over what was scrolled into view) — never added to the
// clip, which would clip outside the box. With neither, clip is in document
// coordinates. `region` {selector, rel: {x, y, w, h}, margin}, given in place
// of `clip` (U564), is computed in the page once the element `selector` names
// has a box (up to REGION_FRAMES frames): regionClip over that element's box —
// a part of the element by fractions of its size, ± margin, clamped to the
// document — and scrolled into view first; the clip is then in document
// coordinates. `region.selectors` (U617; at most REGION_SELECTORS_MAX) widens
// the clip to the union of that rel box and each listed element's whole box —
// a stroke from one pane to the next — ± margin, clamped to the document and
// its height capped at REGION_HEIGHT_MAX, centred on the primary's rel box (a
// listed element not on the page is ignored; the primary is still the one
// scrolled into view). `second` {style} (U617, PICTURE@one-session): after the
// first screenshot, ONE <style data-wc-second> carrying `style` as its text is
// injected into the page (secondScript), two frames are drawn, and a second
// screenshot is taken with the SAME clip object — same browser, same layout,
// same scroll, so the two differ only where the style draws differently
// (PICTURE@aligned). Without it, exactly one screenshot. → { png: Buffer,
// png_without?: Buffer, box: {x, y, w, h}, scroll: {top, left}, clip? } (png:
// the first shot; png_without: the second, only with `second`; box: the
// element's, in document coordinates, as measured before the shot; scroll: its
// own scroll offset then, which the browser clamps to its range; clip: a
// region's computed {x, y, w, h})
// Rejects with a ChromeError (codes as captureFrames', plus page-error when the
// item is not on the page).
async function captureClip({
  chromePath, html, url, width, height, mobile = false, colorScheme = null, item = null, selector = null, scroll = null, clip,
  region = null, second = null, tmpDir, timeoutMs = 30000, signal, spawnImpl, grace,
}) {
  if (signal && signal.aborted) throw new ChromeError('aborted', 'the render was cancelled');
  const browser = launchChrome({ chromePath, tmpDir, spawnImpl, grace });
  let timer = null;
  let onAbort = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ChromeError('timeout',
      `the render did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    if (signal) {
      onAbort = () => reject(new ChromeError('aborted', 'the render was cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  deadline.catch(() => {});
  let onCrash = null;
  const crashed = new Promise((_, reject) => { onCrash = reject; });
  crashed.catch(() => {});
  const run = async () => {
    const { cdp } = browser;
    let target = url;
    if (typeof html === 'string') {
      const file = path.join(browser.profileDir, 'grab.html');
      fs.writeFileSync(file, html);
      target = pathToFileURL(file).href;
    }
    if (!target) throw new ChromeError('page-error', 'nothing to load: neither html nor url');
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.once('Inspector.targetCrashed', { sessionId }).then(
      () => onCrash(new ChromeError('page-crashed', 'the page crashed in Chrome before the grab was taken')),
      () => { /* the connection closed first — its own reason fails the capture */ },
    );
    await cdp.send('Inspector.enable', {}, sessionId).catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: !!mobile }, sessionId);
    if (colorScheme === 'light' || colorScheme === 'dark') {
      // A nicety: a browser that cannot emulate it still draws the page.
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] }, sessionId).catch(() => {});
    }
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = cdp.once('Page.loadEventFired', { sessionId });
    const nav = await cdp.send('Page.navigate', { url: target }, sessionId);
    if (nav.errorText) throw new ChromeError('page-error', `could not load the page to grab: ${nav.errorText}`);
    await loaded;
    // Fonts in, two frames drawn, the measured element scrolled within as the
    // viewer's was and at the top of the viewport; its box in document
    // coordinates.
    const inner = scroll && Number.isFinite(scroll.top) && Number.isFinite(scroll.left)
      ? { top: Math.max(0, scroll.top), left: Math.max(0, scroll.left) } : null;
    const box = await evaluate(cdp, sessionId, `(async () => {
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const given = ${JSON.stringify(typeof selector === 'string' && selector ? selector : null)};
      const id = ${JSON.stringify(item == null ? null : String(item))};
      if (given === null && id === null) return { left: 0, top: 0, width: 0, height: 0 };
      const sel = given !== null ? given : '[data-pane-id="' + CSS.escape(id) + '"], [data-md-id="' + CSS.escape(id) + '"]';
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { el = null; }
      if (!el) return null;
      const inner = ${JSON.stringify(inner)};
      if (inner) { el.scrollTop = inner.top; el.scrollLeft = inner.left; }
      el.scrollIntoView({ block: 'start', inline: 'nearest' });
      await new Promise((r) => requestAnimationFrame(r));
      const r = el.getBoundingClientRect();
      return { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height,
        scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
    })()`);
    if (!box || !Number.isFinite(box.left) || !Number.isFinite(box.top)) {
      throw new ChromeError('page-error', `the grabbed item ${JSON.stringify(item != null ? item : selector)} is not on the page`);
    }
    let shotClip = null;
    let regionOut = null;
    if (region && typeof region.selector === 'string' && region.selector) {
      regionOut = await evaluate(cdp, sessionId, regionScript(region));
      if (!regionOut || !Number.isFinite(regionOut.x) || !Number.isFinite(regionOut.y)) {
        throw new ChromeError('page-error', `the region ${JSON.stringify(region.selector)} is not on the page`);
      }
      shotClip = { x: regionOut.x, y: regionOut.y, width: regionOut.w, height: regionOut.h, scale: 1 };
    } else {
      shotClip = { x: box.left + clip.x, y: box.top + clip.y, width: clip.w, height: clip.h, scale: 1 };
    }
    // Both shots take this one clip object: the second is pixel-aligned with
    // the first by construction, not by measuring again.
    const shoot = async () => {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: shotClip,
      }, sessionId);
      if (!shot || typeof shot.data !== 'string') throw new ChromeError('cdp-error', 'Page.captureScreenshot returned no image');
      return Buffer.from(shot.data, 'base64');
    };
    const png = await shoot();
    let pngWithout = null;
    if (second && typeof second === 'object') {
      await evaluate(cdp, sessionId, secondScript(second.style));
      pngWithout = await shoot();
    }
    return { png, ...(pngWithout ? { png_without: pngWithout } : {}), box: { x: box.left, y: box.top, w: box.width, h: box.height },
      scroll: { top: Number(box.scrollTop) || 0, left: Number(box.scrollLeft) || 0 },
      ...(regionOut ? { clip: { x: regionOut.x, y: regionOut.y, w: regionOut.w, h: regionOut.h } } : {}) };
  };
  const running = run();
  running.catch(() => {});
  try {
    return await Promise.race([running, deadline, crashed]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await browser.close();
  }
}

// How many browsers this process has up right now (a test's leak check).
const liveBrowsers = () => live.size;
// Close every browser this process has up — each through its own bounded
// close(). A test's teardown backstop; the daemon aborts its render instead.
const closeAllBrowsers = () => Promise.all([...live].map((b) => b.close()));

module.exports = {
  captureFrames, captureClip, launchChrome, createPipeConnection, ChromeError, CHROME_FLAGS, GRACE, liveBrowsers, closeAllBrowsers,
  regionClip, regionScript, REGION_FRAMES, unionBox, secondScript, REGION_HEIGHT_MAX, REGION_SELECTORS_MAX,
};

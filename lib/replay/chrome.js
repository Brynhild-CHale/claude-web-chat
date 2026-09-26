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
// exactly the size asked for.
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
      if (closedError) return Promise.reject(closedError);
      const id = nextId++;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        out.write(JSON.stringify(msg) + '\0');
      });
    },
    // Resolve on the first event `method` (for `sessionId`, when given) that
    // satisfies `pred`; reject with the connection's reason if it closes first.
    once(method, { sessionId, pred } = {}) {
      return new Promise((resolve, reject) => {
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
      });
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

// How many browsers this process has up right now (a test's leak check).
const liveBrowsers = () => live.size;
// Close every browser this process has up — each through its own bounded
// close(). A test's teardown backstop; the daemon aborts its render instead.
const closeAllBrowsers = () => Promise.all([...live].map((b) => b.close()));

module.exports = {
  captureFrames, launchChrome, createPipeConnection, ChromeError, CHROME_FLAGS, GRACE, liveBrowsers, closeAllBrowsers,
};

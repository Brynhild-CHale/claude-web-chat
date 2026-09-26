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
// real one), no first-run UI, a fixed device scale factor so a screenshot is
// exactly the size asked for, and is torn down — Browser.close, then a kill if
// it has not exited in time — and its profile removed on every path out,
// including a failure half-way through a render.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

class ChromeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ChromeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const CLOSE_GRACE_MS = 3000;
const STDERR_KEEP = 4000;

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
  let buffered = Buffer.alloc(0);
  let closedError = null;

  const failAll = (err) => {
    if (closedError) return;
    closedError = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
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
    // satisfies `pred`.
    once(method, { sessionId, pred } = {}) {
      return new Promise((resolve, reject) => {
        if (closedError) return reject(closedError);
        const fn = (msg) => {
          if (msg.method !== method) return;
          if (sessionId && msg.sessionId !== sessionId) return;
          if (pred && !pred(msg.params || {})) return;
          listeners.delete(fn);
          resolve(msg.params || {});
        };
        listeners.add(fn);
      });
    },
    fail: failAll,
  };
}

// ── the browser process ─────────────────────────────────────────────────────

// Launch Chrome on a fresh profile under `tmpDir`.
// → { proc, cdp, profileDir, exited: Promise, stderr(), close() }
function launchChrome({ chromePath, tmpDir, spawnImpl = spawn }) {
  if (!chromePath) throw new ChromeError('chrome-not-found', 'no Chrome to launch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const profileDir = path.join(tmpDir, `chrome-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [...CHROME_FLAGS, `--user-data-dir=${profileDir}`, 'about:blank'];
  let proc;
  try {
    proc = spawnImpl(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  } catch (e) {
    removeProfile(profileDir);
    throw new ChromeError('chrome-launch-failed', `could not start ${chromePath}: ${e.message}`);
  }

  if (!proc.stdio || !proc.stdio[3] || !proc.stdio[4]) {
    try { proc.kill('SIGKILL'); } catch { /* never started */ }
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

  let closing = null;
  // Ask politely, then insist. Always removes the profile.
  function close() {
    if (closing) return closing;
    closing = (async () => {
      const alive = proc.exitCode == null && proc.signalCode == null;
      if (alive) {
        cdp.send('Browser.close').catch(() => {});
        const done = await Promise.race([exited.then(() => true), delay(CLOSE_GRACE_MS).then(() => false)]);
        if (!done) {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
          await Promise.race([exited, delay(CLOSE_GRACE_MS)]);
        }
      }
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

function removeProfile(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

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
// → { frames, duration } ; rejects with a ChromeError (code: chrome-not-found,
// chrome-launch-failed, chrome-exited, page-error, timeout, cdp-error).
async function captureFrames({
  chromePath, url, width, height, times, tmpDir, timeoutMs = 300000, onFrame, spawnImpl,
}) {
  const browser = launchChrome({ chromePath, tmpDir, spawnImpl });
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ChromeError('timeout',
      `the render did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  const run = async () => {
    const { cdp } = browser;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
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
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}

module.exports = { captureFrames, launchChrome, createPipeConnection, ChromeError, CHROME_FLAGS };

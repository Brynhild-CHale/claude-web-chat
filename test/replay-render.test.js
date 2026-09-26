// Rendering a replay to a file: POST /api/replay/render (GIF via a headless
// Chrome, or the replay .html), GET /api/replay/capabilities, the fenced
// GET /api/replay/file/:name, the Chrome pipe driver (lib/replay/chrome), the
// finder (lib/replay/find), and the export MCP tool / CLI formats on top.
//
// No real browser here: test-support/fake-chrome.js is a real PROCESS on the
// other end of real fd 3/4 pipes, speaking the DevTools messages the capture
// sends, so the plumbing — spawn flags, NUL framing, sessions, teardown, the
// throwaway profile — is exercised for real. test/replay-capture-e2e.test.js
// does the same against an actual Chrome, when one is installed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawn, spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const { withServer, fakeBin, waitUntil } = require('../test-support/helpers');
const { isPidAlive } = require('../lib/core/portfiles');
const { decodeGif } = require('../test-support/gif-decode');
const { PREVIEW_CSP } = require('../lib/core/cors');
const { projectPaths } = require('../lib/core/paths');
const { frameSchedule, normalizeRenderRequest, LIMITS } = require('../lib/server/replay/render');
const { timeline } = require('../lib/server/replay/player');
const { findChrome, findFfmpeg, chromeCandidates } = require('../lib/replay/find');
const { captureFrames, createPipeConnection, CHROME_FLAGS, liveBrowsers } = require('../lib/replay/chrome');
const { sweepStaleTmp, makeTmpDir } = require('../lib/replay/tmp');

const FAKE = path.join(__dirname, '..', 'test-support', 'fake-chrome.js');
// These tests pin the BUILT-IN GIF encoder: an explicit WEB_CHAT_FFMPEG is the
// only ffmpeg candidate (lib/replay/find), so a missing one means none, even on
// a machine with ffmpeg on PATH. The ffmpeg path is test/replay-encode.test.js.
const NO_FFMPEG = '/nonexistent/ffmpeg';

// An executable wrapper around the fake (spawn needs a program, and the fake is
// a node script). `exec` keeps fds 3 and 4 — the whole point. `stubborn` makes
// it a wedged browser (test-support/fake-chrome.js FAKE_CHROME_STUBBORN).
//
// Teardown does not trust the code under test: whatever the test did, every
// browser and helper the fake logged is SIGKILLed (its whole group first), so a
// regressed teardown fails ITS test and leaks nothing into the rest of the run.
// Registered before fakeBin's own after-hook, so it runs while the log exists.
function fakeChrome(t, { mode = 'ok', env = {}, stubborn = false } = {}) {
  let logFile = null;
  const read = () => {
    try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const pids = () => {
    const log = read();
    return { browsers: log.filter((l) => l.pid).map((l) => l.pid), helpers: log.filter((l) => l.helper).map((l) => l.helper) };
  };
  t.after(() => {
    const { browsers, helpers } = pids();
    for (const pid of browsers) { try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group, or gone */ } }
    for (const pid of [...browsers, ...helpers]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  });
  const { bin } = fakeBin(t, {
    name: 'chrome',
    script: FAKE,
    env: (dir) => ({
      FAKE_CHROME_LOG: (logFile = path.join(dir, 'log.jsonl')),
      FAKE_CHROME_MODE: mode,
      ...(stubborn ? { FAKE_CHROME_STUBBORN: '1' } : {}),
      ...env,
    }),
  });
  return { bin, read, pids };
}

// Every process the fake started is gone. A SIGKILLed helper can sit as a
// zombie for a moment until its (also killed) parent is reaped, so poll.
async function assertNoSurvivors(fake, what) {
  const { browsers, helpers } = fake.pids();
  assert.ok(browsers.length >= 1, 'precondition: the fake browser started');
  const all = [...browsers, ...helpers];
  const gone = await waitUntil(() => all.every((pid) => !isPidAlive(pid)), { timeout: 3000 });
  assert.ok(gone, `${what}: still alive: ${all.filter(isPidAlive).join(', ')}`);
  assert.equal(liveBrowsers(), 0, `${what}: the module still counts a browser as up`);
}

function setEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

async function seed(api) {
  await api.post('/api/render', { id: 'm1', html: '<p>one</p>' });
  await api.post('/api/commit', { message: 'first prompt, maybe private' });
  await api.post('/api/render', { id: 'm1', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'second prompt' });
}

const postJson = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/replay/render`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// ── the pure halves ─────────────────────────────────────────────────────────

test('frameSchedule: a cut is one frame per step, held for the whole step', () => {
  const tl = timeline([{}, {}, {}], { hold_ms: 2000, transition: 'cut' });
  const s = frameSchedule(tl, { fps: 10 });
  assert.deepEqual(s, [{ t: 0, delay: 2000 }, { t: 2000, delay: 2000 }, { t: 4000, delay: 2000 }]);
});

test('frameSchedule: a fade is sampled at fps across the fade, then held — delays sum to the timeline', () => {
  const tl = timeline([{}, {}], { hold_ms: 2500, transition: 'fade' });
  const fade = tl.spans[1].fade;
  assert.ok(fade > 0);
  const s = frameSchedule(tl, { fps: 10 });
  const n = Math.round(fade * 10 / 1000);
  assert.equal(s.length, 1 + n + 1, 'first step: one frame; second: n fade samples + one full-opacity frame');
  assert.equal(s[1].t, tl.spans[1].start, 'the fade starts where the step starts');
  assert.equal(s[s.length - 1].t, tl.spans[1].start + fade, 'and ends fully faded in');
  const sum = s.reduce((a, f) => a + f.delay, 0);
  assert.ok(Math.abs(sum - tl.total) < 1e-6, `delays sum to ${sum}, timeline is ${tl.total}`);
  // more fps, more samples
  assert.ok(frameSchedule(tl, { fps: 30 }).length > s.length);
});

test('normalizeRenderRequest: defaults, clamps and honest refusals', () => {
  const d = normalizeRenderRequest({});
  assert.equal(d.format, 'gif');
  assert.equal(d.width, LIMITS.width.dflt);
  assert.equal(d.docQuery.captions, 'summary', 'a rendered file defaults to SUMMARY captions');
  assert.equal(normalizeRenderRequest({ captions: 'prompt' }).docQuery.captions, 'prompt');
  assert.equal(normalizeRenderRequest({ width: 99999 }).width, LIMITS.width.max);
  assert.equal(normalizeRenderRequest({ width: 641 }).width % 2, 0, 'even width');
  assert.equal(normalizeRenderRequest({ format: 'mp4' }).format, 'mp4', 'video formats are named — whether ffmpeg is there is the render\'s question');
  assert.equal(normalizeRenderRequest({ format: 'WebM' }).format, 'webm');
  assert.equal(normalizeRenderRequest({ format: 'bmp' }).code, 'bad-format');
  assert.equal(normalizeRenderRequest({ format: 'replay' }).format, 'replay');
});

test('findChrome: an explicit WEB_CHAT_CHROME is the only candidate — a wrong one is not routed around', () => {
  const all = () => true;
  assert.equal(findChrome({ env: { WEB_CHAT_CHROME: '/x/chrome', PATH: '/usr/bin' }, isExecutable: (p) => p === '/x/chrome' }), '/x/chrome');
  assert.equal(findChrome({ env: { WEB_CHAT_CHROME: '/nonexistent', PATH: '/usr/bin' }, platform: 'linux', isExecutable: (p) => p !== '/nonexistent' }), null);
  assert.deepEqual(chromeCandidates({ env: { WEB_CHAT_CHROME: '/nonexistent' } }), ['/nonexistent']);
  // macOS: app bundles first
  assert.match(findChrome({ env: { PATH: '/usr/bin' }, platform: 'darwin', isExecutable: all }), /Google Chrome\.app/);
  // Linux / WSL2: PATH names, in order
  const found = findChrome({ env: { PATH: ['/a', '/b'].join(path.delimiter) }, platform: 'linux', isExecutable: (p) => p === path.join('/b', 'chromium') });
  assert.equal(found, path.join('/b', 'chromium'));
  assert.equal(findChrome({ env: { PATH: '/a' }, platform: 'linux', isExecutable: () => false }), null);
  // ffmpeg: override, then PATH
  assert.equal(findFfmpeg({ env: { WEB_CHAT_FFMPEG: '/nope' }, isExecutable: () => false }), null);
  assert.equal(findFfmpeg({ env: { PATH: '/opt/bin' }, isExecutable: (p) => p === path.join('/opt/bin', 'ffmpeg') }), path.join('/opt/bin', 'ffmpeg'));
});

// ── the Chrome pipe driver, against a real process ─────────────────────────

test('captureFrames: launches with the pipe flags on a throwaway profile, seeks and screenshots each time, then tears down', async (t) => {
  const fake = fakeChrome(t);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const shots = [];
  const r = await captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 64, height: 40,
    times: [0, 1500, 3000], tmpDir, timeoutMs: 20000,
    onFrame: (png, i) => { shots.push({ i, bytes: png.length, sig: png.subarray(1, 4).toString('latin1') }); },
  });
  assert.equal(r.frames, 3);
  assert.deepEqual(shots.map((s) => s.i), [0, 1, 2]);
  assert.ok(shots.every((s) => s.sig === 'PNG'));

  const log = fake.read();
  const argv = log[0].argv;
  for (const f of CHROME_FLAGS) assert.ok(argv.includes(f), `launched with ${f}`);
  assert.ok(argv.includes('--remote-debugging-pipe') && !argv.some((a) => /remote-debugging-port/.test(a)), 'a pipe, never a port');
  const udd = argv.find((a) => a.startsWith('--user-data-dir='));
  assert.ok(udd && udd.slice('--user-data-dir='.length).startsWith(tmpDir), 'the profile lives under the tmp dir given');
  const methods = log.filter((l) => l.method).map((l) => l.method);
  assert.deepEqual(methods.slice(0, 7), ['Target.createTarget', 'Target.attachToTarget', 'Inspector.enable', 'Emulation.setDeviceMetricsOverride', 'Page.enable', 'Page.navigate', 'Runtime.evaluate']);
  const metrics = log.find((l) => l.method === 'Emulation.setDeviceMetricsOverride').params;
  assert.deepEqual(metrics, { width: 64, height: 40, deviceScaleFactor: 1, mobile: false });
  const seeks = log.filter((l) => l.method === 'Runtime.evaluate' && /seek\(/.test(l.params.expression)).map((l) => l.params.expression);
  assert.deepEqual(seeks.map((e) => Number(/seek\(([\d.]+)\)/.exec(e)[1])), [0, 1500, 3000]);
  assert.equal(methods[methods.length - 1], 'Browser.close', 'asked to close');
  assert.ok(log.filter((l) => l.method && l.method !== 'Target.createTarget' && l.method !== 'Target.attachToTarget' && l.method !== 'Browser.close')
    .every((l) => l.sessionId === 'S1'), 'page commands go to the attached session');
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'the throwaway profile is removed');
});

test('captureFrames: a wall-clock timeout kills a Chrome that stops answering, and still removes the profile', async (t) => {
  const fake = fakeChrome(t, { mode: 'hang' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  await assert.rejects(captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 400, onFrame: () => {},
  }), (e) => e.code === 'timeout');
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('captureFrames: a Chrome that ignores Browser.close is killed', async (t) => {
  const fake = fakeChrome(t, { mode: 'ignore-close' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const started = Date.now();
  await captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 20000, onFrame: () => {},
  });
  const pid = fake.read()[0].pid;
  // If the kill regressed, do not leak the process into the rest of the run.
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } });
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the browser process is gone');
  assert.ok(Date.now() - started < 15000);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

// ── no Chrome outlives its render ───────────────────────────────────────────
// The stubborn fake is the browser that leaked from real test runs: deaf to
// Browser.close, to SIGTERM and to its pipe closing, with a helper process of
// its own. Teardown must end both, on every way a render can end.
// killMs is deliberately long: a SIGKILL ends the browser at once, so a test
// that takes anywhere near it proves the escalation did not happen.
const QUICK = { closeMs: 150, termMs: 150, killMs: 8000 };

test('captureFrames: a timed-out render leaves no Chrome behind — nor its helper — even deaf to SIGTERM', async (t) => {
  const fake = fakeChrome(t, { mode: 'hang', stubborn: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const started = Date.now();
  await assert.rejects(captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 400, onFrame: () => {}, grace: QUICK,
  }), (e) => e.code === 'timeout');
  const took = Date.now() - started;
  assert.ok(took < 400 + QUICK.closeMs + QUICK.termMs + 2500, `teardown escalates to SIGKILL without waiting it out (${took} ms)`);
  assert.equal(fake.pids().helpers.length, 1, 'precondition: the helper started');
  assert.ok(fake.read().some((l) => l.signal === 'SIGTERM'), 'asked with SIGTERM before SIGKILL');
  await assertNoSurvivors(fake, 'after a timeout');
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'and the profile is removed');
});

test('captureFrames: a helper the browser leaves behind on a clean close is swept with its group', async (t) => {
  const fake = fakeChrome(t, { env: { FAKE_CHROME_HELPER: '1' } });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const r = await captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 20000, onFrame: () => {}, grace: QUICK,
  });
  assert.equal(r.frames, 1, 'the render itself succeeded');
  assert.equal(fake.pids().helpers.length, 1, 'precondition: the helper started');
  await assertNoSurvivors(fake, 'after a successful render');
});

test('captureFrames: an aborted render (AbortSignal) tears the browser down the same way', async (t) => {
  const fake = fakeChrome(t, { mode: 'hang', stubborn: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const ac = new AbortController();
  const p = captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 60000, onFrame: () => {}, grace: QUICK, signal: ac.signal,
  });
  await waitUntil(() => fake.read().some((l) => l.method === 'Page.captureScreenshot'), { timeout: 10000, what: 'the capture to start' });
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
  await assertNoSurvivors(fake, 'after an abort');
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  // An already-aborted signal launches nothing at all.
  await assert.rejects(captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, onFrame: () => {}, signal: ac.signal,
  }), (e) => e.code === 'aborted');
  assert.equal(fake.pids().browsers.length, 1, 'no second browser was started');
});

test('a process that exits mid-render takes its Chrome group with it (the exit hook)', async (t) => {
  const fake = fakeChrome(t, { mode: 'hang', stubborn: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  // A child process starts a render, and exits the moment the capture is under
  // way — no close(), no finally: only the 'exit' hook stands between the
  // wedged browser and a leak.
  const script = `
    const { captureFrames } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'replay', 'chrome'))});
    captureFrames({ chromePath: process.env.BIN, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
      times: [0], tmpDir: process.env.TMPD, timeoutMs: 60000, onFrame: () => {} }).catch(() => {});
    const fs = require('fs');
    const iv = setInterval(() => {
      let log = '';
      try { log = fs.readFileSync(process.env.LOG, 'utf8'); } catch {}
      if (log.includes('Page.captureScreenshot') && log.includes('"helper"')) { clearInterval(iv); process.exit(0); }
    }, 20);`;
  const logFile = path.join(path.dirname(fake.bin), 'log.jsonl');
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, BIN: fake.bin, TMPD: tmpDir, LOG: logFile }, stdio: 'ignore',
  });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, 'the child reached the capture and exited');
  const { browsers, helpers } = fake.pids();
  const all = [...browsers, ...helpers];
  assert.equal(all.length, 2, 'precondition: a browser and its helper were up');
  assert.ok(await waitUntil(() => all.every((pid) => !isPidAlive(pid)), { timeout: 3000 }),
    `still alive after the parent exited: ${all.filter(isPidAlive).join(', ')}`);
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'the hook removes the profile too');
});

test('captureFrames: a Chrome that dies mid-render rejects with chrome-exited', async (t) => {
  const fake = fakeChrome(t, { mode: 'die' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  await assert.rejects(captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 20000, onFrame: () => {},
  }), (e) => e.code === 'chrome-exited');
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

// A pipe that closes fails what is waiting on it — an event waiter included.
// Before, once() was rejected only if the pipe was ALREADY closed when it was
// called, so a Chrome that died between Page.navigate's reply and the load event
// held the render (and its route's single flight) for the full five minutes.
test('createPipeConnection: a closed pipe rejects an outstanding once() waiter, not only send()', async () => {
  const out = new PassThrough();
  const inp = new PassThrough();
  const cdp = createPipeConnection(out, inp);
  const cmd = cdp.send('Page.navigate', { url: 'about:blank' });
  const evt = cdp.once('Page.loadEventFired', { sessionId: 'S1' });
  inp.emit('close');
  await assert.rejects(cmd, (e) => e.code === 'chrome-exited');
  await assert.rejects(evt, (e) => e.code === 'chrome-exited');
  // …and one asked for after the close is refused at once, as before.
  await assert.rejects(cdp.once('Page.loadEventFired'), (e) => e.code === 'chrome-exited');
});

test('createPipeConnection: an event that arrives settles its waiter and is not failed again on close', async () => {
  const out = new PassThrough();
  const inp = new PassThrough();
  const cdp = createPipeConnection(out, inp);
  const evt = cdp.once('Page.loadEventFired', { sessionId: 'S1' });
  inp.write(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: 'S1' }) + '\0');
  assert.deepEqual(await evt, { timestamp: 7 });
  inp.emit('close');
});

test('captureFrames: a Chrome that exits during the page load fails at once with chrome-exited, not the timeout', async (t) => {
  const fake = fakeChrome(t, { mode: 'die-on-load' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const started = Date.now();
  await assert.rejects(captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 30000, onFrame: () => {},
  }), (e) => e.code === 'chrome-exited');
  assert.ok(Date.now() - started < 10000, `failed on the exit, not the 30 s timeout (${Date.now() - started} ms)`);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('captureFrames: a page that crashes (browser still up, pipe open) fails at once with page-crashed', async (t) => {
  const fake = fakeChrome(t, { mode: 'crash-on-load' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const started = Date.now();
  await assert.rejects(captureFrames({
    chromePath: fake.bin, url: 'http://127.0.0.1:9/replay', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 30000, onFrame: () => {}, grace: QUICK,
  }), (e) => e.code === 'page-crashed');
  assert.ok(Date.now() - started < 10000, `failed on the crash, not the 30 s timeout (${Date.now() - started} ms)`);
  await assertNoSurvivors(fake, 'after a page crash');
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

// ── the tmp sweep ───────────────────────────────────────────────────────────
// A pid that is certainly dead: a child that has already exited.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '0']);
  assert.ok(r.pid && !isPidAlive(r.pid), 'precondition: the pid is dead');
  return r.pid;
}
// Plant a render directory as a process `pid` would have named it.
function plant(tmpDir, kind, pid) {
  const dir = path.join(tmpDir, `${kind}-${pid}-${'0123abcd'}`);
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{}');
  return path.basename(dir);
}

test('sweepStaleTmp: removes a dead pid\'s chrome/frames dirs, never a live pid\'s, never a name that is not ours', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sweep-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const dead = deadPid();
  const staleChrome = plant(tmpDir, 'chrome', dead);
  const staleFrames = plant(tmpDir, 'frames', dead);
  const mine = path.basename(makeTmpDir(tmpDir, 'chrome'));
  const otherLive = plant(tmpDir, 'frames', process.ppid);
  fs.mkdirSync(path.join(tmpDir, `other-${dead}-0123abcd`));
  fs.mkdirSync(path.join(tmpDir, `chrome-${dead}-not-hex!`));
  fs.writeFileSync(path.join(tmpDir, `chrome-${dead}-89abcdef`), 'a file, not a render dir');

  const removed = sweepStaleTmp(tmpDir);
  assert.deepEqual(removed.sort(), [staleChrome, staleFrames].sort());
  assert.deepEqual(fs.readdirSync(tmpDir).sort(), [
    `chrome-${dead}-89abcdef`, `chrome-${dead}-not-hex!`, mine, otherLive, `other-${dead}-0123abcd`,
  ].sort());
  assert.match(mine, new RegExp(`^chrome-${process.pid}-[0-9a-f]{8}$`), 'makeTmpDir names by this pid');
  assert.deepEqual(sweepStaleTmp(path.join(tmpDir, 'absent')), [], 'no tmp dir is nothing to sweep');
});

test('the daemon sweeps a dead daemon\'s render dirs at boot, and again before a render', async (t) => {
  const fake = fakeChrome(t);
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: NO_FFMPEG });
  const dead = deadPid();
  let planted;
  const { api, port, root } = await withServer(t, {
    seed: ({ root: r }) => {
      const tmp = projectPaths(r).tmp;
      fs.mkdirSync(tmp, { recursive: true });
      planted = [plant(tmp, 'chrome', dead), plant(tmp, 'frames', dead)];
    },
  });
  const tmp = projectPaths(root).tmp;
  assert.equal(planted.length, 2);
  assert.deepEqual(fs.readdirSync(tmp), [], 'boot removed both');

  await seed(api);
  plant(tmp, 'chrome', dead);
  const r = await postJson(port, { width: 320 });
  assert.equal(r.status, 200);
  await r.json();
  assert.deepEqual(fs.readdirSync(tmp), [], 'the render swept it (and removed its own)');
});

test('captureFrames: a program that is not there rejects with chrome-launch-failed', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cap-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  await assert.rejects(captureFrames({
    chromePath: path.join(tmpDir, 'no-such-chrome'), url: 'http://127.0.0.1:9/', width: 32, height: 20,
    times: [0], tmpDir, timeoutMs: 20000, onFrame: () => {},
  }), (e) => e.code === 'chrome-launch-failed' || e.code === 'chrome-exited');
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

// ── the routes ──────────────────────────────────────────────────────────────

test('POST /api/replay/render gif: drives Chrome at this daemon\'s own /replay and writes a real GIF', async (t) => {
  const fake = fakeChrome(t);
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: NO_FFMPEG });
  const { api, port, root } = await withServer(t);
  await seed(api);

  const res = await postJson(port, { width: 320, hold_ms: 1000 });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.format, 'gif');
  assert.equal(body.encoder, 'builtin');
  assert.equal(body.label, 'n1.0 → n1.1');
  const exportsDir = projectPaths(root).exports;
  assert.equal(path.dirname(body.path), exportsDir);
  assert.match(path.basename(body.path), /^replay-n1-0_n1-1-\d{8}-\d{6}\.gif$/);
  const gif = fs.readFileSync(body.path);
  assert.equal(gif.length, body.bytes);

  const g = decodeGif(gif);
  assert.equal(g.width, 320);
  assert.equal(g.height, 200, 'height follows the 16:10 frame');
  assert.equal(g.loop, 0, 'loops forever');
  assert.equal(g.trailer, true);
  assert.equal(g.frames.length, 2, 'two cut steps, two frames');
  assert.deepEqual(g.frames.map((f) => f.delay), [100, 100], 'each held for hold_ms');

  const log = fake.read();
  const nav = log.find((l) => l.method === 'Page.navigate').params.url;
  const u = new URL(nav);
  assert.equal(u.hostname, '127.0.0.1', 'over loopback');
  assert.equal(u.port, String(port), 'at this daemon');
  assert.equal(u.pathname, '/replay');
  assert.equal(u.searchParams.get('chrome'), '0', 'the bare document, no player controls');
  assert.equal(u.searchParams.get('from'), 'n0', 'both ends pinned by id');
  assert.equal(u.searchParams.get('to'), 'n1');
  assert.equal(u.searchParams.get('captions'), 'summary', 'summary captions by default');
  const fetched = log.find((l) => l.fetched);
  assert.equal(fetched.status, 200, 'the URL the browser was sent really loads');
  assert.equal(fetched.csp, PREVIEW_CSP, 'under the preview CSP');
  const udd = log[0].argv.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  assert.ok(udd.startsWith(projectPaths(root).tmp + path.sep), 'the profile lives under .web-chat/tmp/');
  assert.equal(fs.existsSync(udd), false, 'and is gone afterwards');
});

test('POST /api/replay/render: chrome-not-found is an honest refusal with a hint; format replay needs no browser', async (t) => {
  setEnv(t, { WEB_CHAT_CHROME: '/nonexistent/chrome', WEB_CHAT_FFMPEG: NO_FFMPEG });
  const { api, port, root } = await withServer(t);
  await seed(api);

  const res = await postJson(port, { format: 'gif' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.code, 'chrome-not-found');
  assert.match(body.hint, /WEB_CHAT_CHROME/);
  assert.ok(!fs.existsSync(projectPaths(root).exports) || !fs.readdirSync(projectPaths(root).exports).length, 'nothing written');

  const html = await postJson(port, { format: 'replay' });
  const hb = await html.json();
  assert.equal(html.status, 200, JSON.stringify(hb));
  assert.equal(hb.format, 'replay');
  assert.match(path.basename(hb.path), /^replay-n1-0_n1-1-\d{8}-\d{6}\.html$/);
  const doc = fs.readFileSync(hb.path, 'utf8');
  assert.match(doc, /id="wc-replay-data"/);
  const payload = JSON.parse(/<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(doc)[1]);
  assert.equal(payload.opts.captions, 'summary', 'a written replay defaults to summary captions');
  assert.ok(payload.steps.every((s) => !('prompt' in s.caption)), 'so no step carries a prompt field');
  assert.equal(payload.opts.chrome, true, 'a .html replay keeps its player controls');

  // …and the fenced file route hands it back, as a download, under the preview CSP.
  const f = await fetch(`http://127.0.0.1:${port}/api/replay/file/${encodeURIComponent(path.basename(hb.path))}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-security-policy'), PREVIEW_CSP);
  assert.match(f.headers.get('content-disposition'), /^attachment; filename="replay-/);
  assert.equal(await f.text(), doc);

  const mp4 = await postJson(port, { format: 'mp4' });
  assert.equal(mp4.status, 422, 'no ffmpeg: mp4 is refused by name (test/replay-encode.test.js covers it with one)');
  assert.equal((await mp4.json()).code, 'ffmpeg-not-found');

  const bad = await postJson(port, { format: 'gif', to: 'nope' });
  assert.equal(bad.status, 404, 'a bad ref is refused before any browser is looked for');
});

test('POST /api/replay/render takes JSON only', async (t) => {
  setEnv(t, { WEB_CHAT_CHROME: '/nonexistent/chrome' });
  const { port } = await withServer(t);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
    const r = await fetch(`http://127.0.0.1:${port}/api/replay/render`, { method: 'POST', headers: { 'Content-Type': type }, body: 'format=gif' });
    assert.equal(r.status, 415, `${type} is refused`);
    assert.equal((await r.json()).code, 'json-only');
  }
});

test('POST /api/replay/render is single-flight: a second render while one runs is 409 busy', async (t) => {
  const fake = fakeChrome(t, { mode: 'slow', env: { FAKE_CHROME_SLOW_MS: 700 } });
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: NO_FFMPEG });
  const { api, port } = await withServer(t);
  await seed(api);

  const first = postJson(port, { width: 320 });
  // Wait until the first has really started (the browser is up).
  const t0 = Date.now();
  while (!fake.read().some((l) => l.method === 'Page.navigate') && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 20));
  const second = await postJson(port, { width: 320 });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, 'busy');
  const done = await first;
  assert.equal(done.status, 200);
  await done.json();
  // …and the flag is released, success or not.
  const third = await postJson(port, { format: 'replay' });
  assert.equal(third.status, 200);
});

test('stopping the daemon mid-render aborts the render and leaves no Chrome behind', async (t) => {
  const fake = fakeChrome(t, { mode: 'hang', stubborn: true });
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: NO_FFMPEG });
  const { api, port, root, srv } = await withServer(t);
  await seed(api);
  const pending = postJson(port, { width: 320 });
  await waitUntil(() => fake.read().some((l) => l.method === 'Page.captureScreenshot'), { timeout: 10000, what: 'the capture to start' });
  // The server's own stop (not the harness's, which also cuts every socket):
  // the render request must be answered, then the server closes.
  const stopped = srv.stop();
  const r = await pending;
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'aborted');
  // The answered request's keep-alive socket went idle after close() began,
  // so close() would sit out the keep-alive timeout for it.
  srv.server.closeIdleConnections();
  await stopped;
  await assertNoSurvivors(fake, 'after the daemon stopped');
  const tmp = projectPaths(root).tmp;
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [], 'no profile left behind');
});

test('POST /api/replay/render: a Chrome that dies mid-render is a 502 with its code, and releases the flight', async (t) => {
  const fake = fakeChrome(t, { mode: 'die' });
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: NO_FFMPEG });
  const { api, port, root } = await withServer(t);
  await seed(api);
  const r = await postJson(port, { width: 320 });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'chrome-exited');
  const tmp = projectPaths(root).tmp;
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [], 'no profile left behind');
  const again = await postJson(port, { format: 'replay' });
  assert.equal(again.status, 200);
});

test('POST /api/replay/render: a Chrome that exits during the page load answers 502 at once and frees the flight', async (t) => {
  const fake = fakeChrome(t, { mode: 'die-on-load' });
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: NO_FFMPEG });
  const { api, port } = await withServer(t);
  await seed(api);
  const started = Date.now();
  const r = await postJson(port, { width: 320 });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'chrome-exited');
  assert.ok(Date.now() - started < 10000, `answered on the exit, not the render timeout (${Date.now() - started} ms)`);
  const again = await postJson(port, { format: 'replay' });
  assert.equal(again.status, 200, 'the single flight is free again');
});

test('POST /api/replay/render: a frame of the wrong size is refused, not stretched', async (t) => {
  const fake = fakeChrome(t, { mode: 'wrong-size' });
  setEnv(t, { WEB_CHAT_CHROME: fake.bin, WEB_CHAT_FFMPEG: NO_FFMPEG });
  const { api, port } = await withServer(t);
  await seed(api);
  const r = await postJson(port, { width: 320 });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'bad-frame');
});

test('GET /api/replay/capabilities reports what was found; refresh re-looks', async (t) => {
  setEnv(t, { WEB_CHAT_CHROME: '/nonexistent/chrome' });
  const { port } = await withServer(t);
  const a = await (await fetch(`http://127.0.0.1:${port}/api/replay/capabilities`)).json();
  assert.equal(a.chrome, null);
  assert.equal(a.formats.gif, false);
  assert.equal(a.formats.replay, true);
  assert.ok('ffmpeg' in a);

  const fake = fakeChrome(t);
  process.env.WEB_CHAT_CHROME = fake.bin;
  const cached = await (await fetch(`http://127.0.0.1:${port}/api/replay/capabilities`)).json();
  assert.equal(cached.chrome, null, 'cached until asked to refresh');
  const fresh = await (await fetch(`http://127.0.0.1:${port}/api/replay/capabilities?refresh=1`)).json();
  assert.equal(fresh.chrome, fake.bin);
  assert.equal(fresh.formats.gif, true);
});

test('GET /api/replay/file/:name is fenced to rendered replays inside .web-chat/exports/', async (t) => {
  const { port, root } = await withServer(t);
  const dir = projectPaths(root).exports;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'replay-a_b-1.gif'), 'GIF89a');
  fs.writeFileSync(path.join(dir, 'n1-7-20260101-000000.html'), '<p>a page export</p>');
  const outside = path.join(root, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  fs.symlinkSync(outside, path.join(dir, 'replay-evil.gif'));

  const get = (name) => fetch(`http://127.0.0.1:${port}/api/replay/file/${encodeURIComponent(name)}`);
  const ok = await get('replay-a_b-1.gif');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/gif');
  assert.equal(await ok.text(), 'GIF89a');

  assert.equal((await get('n1-7-20260101-000000.html')).status, 400, 'a page export is not this route\'s to serve');
  assert.equal((await get('replay-x.txt')).status, 400, 'only the rendered extensions');
  assert.equal((await get('../secret.txt')).status, 400);
  assert.equal((await get('replay-..gif')).status, 400, 'no dot-dot anywhere in the name');
  assert.equal((await get('replay-missing.gif')).status, 404);
  const evil = await get('replay-evil.gif');
  assert.equal(evil.status, 404, 'a symlink pointing out of exports/ is refused');
  assert.notEqual(await evil.text(), 'secret');
});

// ── the MCP tool and the CLI ───────────────────────────────────────────────

test('export MCP tool: format html is unchanged; replay/gif go through the render route; refusals are results', async (t) => {
  setEnv(t, { WEB_CHAT_CHROME: '/nonexistent/chrome' });
  const { api, port } = await withServer(t);
  await seed(api);
  setEnv(t, { WEB_CHAT_PORT: String(port) });
  const tool = require('../lib/mcp/tools/export');
  assert.deepEqual(tool.inputSchema.properties.format.enum, ['html', 'replay', 'gif', 'mp4', 'webm']);

  const page = await tool.handler({ node: 'n1' });
  assert.equal(page.ok, true);
  assert.match(path.basename(page.path), /^n1-1-\d{8}-\d{6}\.html$/, 'format html is the page export, as before');

  const rep = await tool.handler({ format: 'replay', to: 'n1', from: 'n0' });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.match(path.basename(rep.path), /^replay-n1-0_n1-1-/);

  const gif = await tool.handler({ format: 'gif' });
  assert.equal(gif.code, 'chrome-not-found');
  assert.match(gif.hint, /WEB_CHAT_CHROME/);
  assert.equal(gif.format, 'gif');

  const bad = await tool.handler({ format: 'gif', to: 'nope' });
  assert.equal(bad.code, 'not-found');
});

test('export CLI: --replay/--gif/--mp4/--webm with --from/--hold/--fade/--width parse into a render body', () => {
  const { parseExportArgs } = require('../lib/cli/commands/export');
  assert.deepEqual(parseExportArgs([]), { format: 'html', ref: 'active' });
  assert.deepEqual(parseExportArgs(['n1.7']), { format: 'html', ref: 'n1.7' });
  const g = parseExportArgs(['n1.7', '--gif', '--from', 'n1.2', '--hold', '1500', '--fade', '--width', '640']);
  assert.deepEqual(g.body, { format: 'gif', to: 'n1.7', from: 'n1.2', hold_ms: 1500, transition: 'fade', width: 640 });
  assert.deepEqual(parseExportArgs(['--replay']).body, { format: 'replay' });
  assert.equal(parseExportArgs(['--mp4']).body.format, 'mp4');
  assert.equal(parseExportArgs(['--webm', '--captions', 'none']).body.captions, 'none');
  assert.match(parseExportArgs(['--gif', '--replay']).error, /pick one/);
  assert.match(parseExportArgs(['--from', 'n1']).error, /need --replay, --gif, --mp4 or --webm/);
  assert.match(parseExportArgs(['--gif', '--hold']).error, /needs a value/);
  assert.match(parseExportArgs(['--bogus']).error, /unknown option/);
});

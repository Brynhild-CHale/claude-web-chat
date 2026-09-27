// Encoding a replay's frames with ffmpeg when the machine has it
// (lib/replay/encode.js): the ffconcat list and argv, the frame encoder against
// a fake ffmpeg (test-support/fake-ffmpeg.js — a real process the real spawn
// reaches, recording its argv and the list it was handed), the render route and
// capabilities with ffmpeg present and absent, and — when a real ffmpeg is
// installed — GIF, MP4 and WebM output read back by ffmpeg itself.
//
// The Chrome half is a fake too (test-support/fake-chrome.js); the whole chain
// against real binaries is test/replay-capture-e2e.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { withServer, fakeBin, e2eGate } = require('../test-support/helpers');
const { decodeGif } = require('../test-support/gif-decode');
const { encodePng, solid } = require('../test-support/png-encode');
const { projectPaths } = require('../lib/core/paths');
const {
  createFrameEncoder, pickEncoder, ffconcat, ffmpegPasses,
} = require('../lib/replay/encode');

const SUPPORT = path.join(__dirname, '..', 'test-support');

function fakeFfmpeg(t, { mode = 'ok' } = {}) {
  let calls = null;
  const { bin } = fakeBin(t, {
    name: 'ffmpeg',
    script: path.join(SUPPORT, 'fake-ffmpeg.js'),
    env: (dir) => ({ FAKE_FFMPEG_CALLS: (calls = path.join(dir, 'calls.jsonl')), FAKE_FFMPEG_MODE: mode }),
  });
  const read = () => {
    try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { bin, read };
}

function fakeChrome(t) {
  let log = null;
  const { bin } = fakeBin(t, {
    name: 'chrome',
    script: path.join(SUPPORT, 'fake-chrome.js'),
    env: (dir) => ({ FAKE_CHROME_LOG: (log = path.join(dir, 'log.jsonl')) }),
  });
  const read = () => {
    try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { bin, read };
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

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-enc-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const png = (w, h, rgb) => encodePng(solid(w, h, rgb, [2, 2, 6, 6, [0, 0, 0]]), w, h, { alpha: false });
const RED = [200, 50, 40];
const BLUE = [30, 110, 160];
const GREEN = [40, 160, 60];

async function seed(api) {
  await api.post('/api/render', { id: 'm1', html: '<p>one</p>' });
  await api.post('/api/commit', { message: 'first prompt' });
  await api.post('/api/render', { id: 'm1', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'second prompt' });
}

const postJson = (port, body) => fetch(`http://127.0.0.1:${port}/api/replay/render`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ── the pure halves ─────────────────────────────────────────────────────────

test('pickEncoder: ffmpeg for everything when present; without it, GIF only (built in)', () => {
  assert.equal(pickEncoder('gif', '/usr/bin/ffmpeg'), 'ffmpeg');
  assert.equal(pickEncoder('mp4', '/usr/bin/ffmpeg'), 'ffmpeg');
  assert.equal(pickEncoder('webm', '/usr/bin/ffmpeg'), 'ffmpeg');
  assert.equal(pickEncoder('gif', null), 'builtin');
  assert.equal(pickEncoder('mp4', null), null);
  assert.equal(pickEncoder('webm', null), null);
  assert.equal(pickEncoder('bmp', '/usr/bin/ffmpeg'), null);
});

test('ffconcat: one file + duration per frame on a 100 Hz grid; video repeats the last image to reach its end', () => {
  const frames = [{ file: 'f00000.png', delay: 333 }, { file: 'f00001.png', delay: 2500 }];
  assert.equal(ffconcat(frames), [
    'ffconcat version 1.0',
    "file 'f00000.png'", 'option framerate 100', 'duration 0.333',
    "file 'f00001.png'", 'option framerate 100', 'duration 2.500',
    '',
  ].join('\n'));
  const v = ffconcat(frames, { repeatLast: true }).trim().split('\n');
  assert.deepEqual(v.slice(-2), ["file 'f00001.png'", 'option framerate 100'], 'the repeat carries no duration');
});

test('ffmpegPasses: a GIF is palettegen then paletteuse (sierra2_4a) with its last hold as the final delay; video is libx264 / VP9 in yuv420p cut at the replay length', () => {
  const base = { list: '/w/frames.ffconcat', palette: '/w/palette.png', fps: 10, totalMs: 4067, lastMs: 2500 };
  const gif = ffmpegPasses({ ...base, format: 'gif', out: '/w/out.gif', loop: 0 });
  assert.equal(gif.length, 2, 'two passes — no split graph buffering every frame');
  for (const a of gif) {
    assert.deepEqual(a.slice(a.indexOf('-f'), a.indexOf('-f') + 6), ['-f', 'concat', '-safe', '0', '-i', '/w/frames.ffconcat']);
    assert.ok(a.includes('-nostdin'));
  }
  assert.equal(gif[0][gif[0].indexOf('-vf') + 1], 'palettegen=stats_mode=full');
  assert.equal(gif[0][gif[0].length - 1], '/w/palette.png');
  assert.match(gif[1][gif[1].indexOf('-lavfi') + 1], /paletteuse=dither=sierra2_4a/);
  assert.equal(gif[1][gif[1].indexOf('-final_delay') + 1], '250', 'centiseconds');
  assert.equal(gif[1][gif[1].indexOf('-loop') + 1], '0', 'loops forever');
  assert.equal(gif[1][gif[1].length - 1], '/w/out.gif');
  const once = ffmpegPasses({ ...base, format: 'gif', out: '/w/out.gif', loop: null })[1];
  assert.equal(once[once.indexOf('-loop') + 1], '-1', 'loop:null plays once');

  const [mp4] = ffmpegPasses({ ...base, format: 'mp4', out: '/w/out.mp4' });
  assert.equal(mp4[mp4.indexOf('-c:v') + 1], 'libx264');
  assert.equal(mp4[mp4.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(mp4[mp4.indexOf('-vf') + 1], 'fps=10');
  assert.equal(mp4[mp4.indexOf('-t') + 1], '4.067');
  const [webm] = ffmpegPasses({ ...base, format: 'webm', out: '/w/out.webm' });
  assert.equal(webm[webm.indexOf('-c:v') + 1], 'libvpx-vp9');
  assert.equal(webm[webm.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(webm[webm.length - 1], '/w/out.webm');
});

// ── the frame encoder, against a fake ffmpeg ───────────────────────────────

test('createFrameEncoder (ffmpeg): each distinct frame goes to disk once, the list carries the holds, the file is ffmpeg\'s, the frame dir is removed', async (t) => {
  const ff = fakeFfmpeg(t);
  const tmpDir = tmp(t);
  const enc = createFrameEncoder({ format: 'mp4', ffmpegPath: ff.bin, width: 16, height: 10, fps: 12, tmpDir });
  assert.equal(enc.encoder, 'ffmpeg');
  enc.addFrame(png(16, 10, RED), 1000);
  enc.addFrame(png(16, 10, RED), 500);      // identical: folds into the one before
  enc.addFrame(png(16, 10, BLUE), 750);
  const out = await enc.finish({ timeoutMs: 20000 });
  assert.equal(out.encoder, 'ffmpeg');
  assert.equal(out.frames, 2);
  assert.equal(out.data.toString(), 'FAKE:out.mp4');

  const [call] = ff.read();
  assert.deepEqual(call.images.map((i) => i.png), [true, true, true], 'every image the list names is a PNG on disk (the last, repeated)');
  assert.deepEqual(call.images.map((i) => i.name), ['f00000.png', 'f00001.png', 'f00001.png']);
  assert.match(call.list, /file 'f00000.png'\noption framerate 100\nduration 1\.500\n/);
  assert.match(call.list, /file 'f00001.png'\noption framerate 100\nduration 0\.750\n/);
  assert.equal(call.argv[call.argv.indexOf('-vf') + 1], 'fps=12');
  assert.equal(call.argv[call.argv.indexOf('-t') + 1], '2.250');

  assert.equal(fs.readdirSync(tmpDir).length, 1, 'the frame dir exists until dispose…');
  enc.dispose();
  assert.deepEqual(fs.readdirSync(tmpDir), [], '…and not after');
});

test('createFrameEncoder (ffmpeg): a frame of the wrong size is refused before it is written', (t) => {
  const tmpDir = tmp(t);
  const enc = createFrameEncoder({ format: 'gif', ffmpegPath: '/unused', width: 16, height: 10, tmpDir });
  t.after(() => enc.dispose());
  assert.throws(() => enc.addFrame(png(15, 10, RED), 100), (e) => e.code === 'bad-frame');
  assert.throws(() => enc.addFrame(Buffer.from('not a png'), 100), (e) => e.code === 'bad-png');
});

test('createFrameEncoder: a GIF whose ffmpeg fails falls back to the built-in encoder, and says so', async (t) => {
  const ff = fakeFfmpeg(t, { mode: 'fail' });
  const tmpDir = tmp(t);
  const enc = createFrameEncoder({ format: 'gif', ffmpegPath: ff.bin, width: 16, height: 10, tmpDir });
  t.after(() => enc.dispose());
  enc.addFrame(png(16, 10, RED), 1000);
  enc.addFrame(png(16, 10, BLUE), 500);
  const out = await enc.finish({ timeoutMs: 20000 });
  assert.equal(out.encoder, 'builtin');
  assert.match(out.fallback, /Error selecting an encoder/, 'the last line of ffmpeg\'s stderr');
  const g = decodeGif(out.data);
  assert.deepEqual(g.frames.map((f) => f.delay), [100, 50]);
  assert.equal(ff.read().length, 1, 'ffmpeg was tried first');
});

test('createFrameEncoder: an MP4 whose ffmpeg fails has no fallback; a hung one is killed at the deadline', async (t) => {
  const bad = fakeFfmpeg(t, { mode: 'fail' });
  const tmpDir = tmp(t);
  const enc = createFrameEncoder({ format: 'mp4', ffmpegPath: bad.bin, width: 16, height: 10, tmpDir });
  t.after(() => enc.dispose());
  enc.addFrame(png(16, 10, RED), 1000);
  await assert.rejects(enc.finish({ timeoutMs: 20000 }), (e) => e.code === 'ffmpeg-failed' && /Error selecting an encoder/.test(e.message));

  const hung = fakeFfmpeg(t, { mode: 'hang' });
  const enc2 = createFrameEncoder({ format: 'gif', ffmpegPath: hung.bin, width: 16, height: 10, tmpDir });
  t.after(() => enc2.dispose());
  enc2.addFrame(png(16, 10, RED), 1000);
  const started = Date.now();
  await assert.rejects(enc2.finish({ timeoutMs: 1500 }), (e) => e.code === 'timeout', 'a timeout is not an ffmpeg failure: no fallback past the deadline');
  assert.ok(Date.now() - started < 10000);
});

test('createFrameEncoder without ffmpeg: GIF is built in; MP4/WebM are ffmpeg-not-found', async (t) => {
  const tmpDir = tmp(t);
  const enc = createFrameEncoder({ format: 'gif', ffmpegPath: null, width: 16, height: 10, tmpDir });
  assert.equal(enc.encoder, 'builtin');
  enc.addFrame(png(16, 10, RED), 1000);
  const out = await enc.finish();
  assert.equal(out.encoder, 'builtin');
  assert.equal(decodeGif(out.data).frames.length, 1);
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'the built-in path writes no frames to disk');
  for (const format of ['mp4', 'webm']) {
    assert.throws(() => createFrameEncoder({ format, ffmpegPath: null, width: 16, height: 10, tmpDir }), (e) => e.code === 'ffmpeg-not-found');
  }
});

// ── the route and capabilities ─────────────────────────────────────────────

test('POST /api/replay/render mp4/webm/gif go through ffmpeg when it is found, and the file is what it wrote', async (t) => {
  const chrome = fakeChrome(t);
  const ff = fakeFfmpeg(t);
  setEnv(t, { WEB_CHAT_CHROME: chrome.bin, WEB_CHAT_FFMPEG: ff.bin });
  const { api, port, root } = await withServer(t);
  await seed(api);

  for (const format of ['mp4', 'webm', 'gif']) {
    const r = await postJson(port, { format, width: 320, hold_ms: 1000, fps: 8 });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.format, format);
    assert.equal(body.encoder, 'ffmpeg');
    assert.match(path.basename(body.path), new RegExp(`^replay-n1-0_n1-1-\\d{8}-\\d{6}\\.${format}$`));
    assert.equal(fs.readFileSync(body.path, 'utf8'), `FAKE:out.${format}`);
    assert.equal(body.frames, 2);
    assert.deepEqual([body.width, body.height], [320, 200]);
  }
  const calls = ff.read();
  const video = calls.filter((c) => c.argv.includes('-c:v'));
  assert.deepEqual(video.map((c) => c.argv[c.argv.indexOf('-c:v') + 1]), ['libx264', 'libvpx-vp9']);
  assert.ok(video.every((c) => c.argv[c.argv.indexOf('-vf') + 1] === 'fps=8'), 'the requested fps');
  assert.ok(video.every((c) => /duration 1\.000\n/.test(c.list)), 'each node held for hold_ms');
  assert.ok(calls.some((c) => /palettegen/.test(c.argv.join(' '))), 'the GIF took the palette pass');
  const tmpDir = projectPaths(root).tmp;
  assert.deepEqual(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [], [], 'no frames or profile left behind');

  const caps = await (await fetch(`http://127.0.0.1:${port}/api/replay/capabilities?refresh=1`)).json();
  assert.equal(caps.ffmpeg, ff.bin);
  assert.deepEqual(caps.formats, { replay: true, gif: true, mp4: true, webm: true });
  assert.equal(caps.gif_encoder, 'ffmpeg');
});

test('POST /api/replay/render mp4 with no ffmpeg is ffmpeg-not-found before any browser starts; capabilities say so', async (t) => {
  const chrome = fakeChrome(t);
  setEnv(t, { WEB_CHAT_CHROME: chrome.bin, WEB_CHAT_FFMPEG: '/nonexistent/ffmpeg' });
  const { api, port, root } = await withServer(t);
  await seed(api);
  for (const format of ['mp4', 'webm']) {
    const r = await postJson(port, { format });
    assert.equal(r.status, 422);
    const body = await r.json();
    assert.equal(body.code, 'ffmpeg-not-found');
    assert.match(body.hint, /WEB_CHAT_FFMPEG/);
  }
  assert.deepEqual(chrome.read(), [], 'no browser was launched for a render that could not be encoded');
  const exp = projectPaths(root).exports;
  assert.ok(!fs.existsSync(exp) || !fs.readdirSync(exp).length, 'nothing written');

  const caps = await (await fetch(`http://127.0.0.1:${port}/api/replay/capabilities`)).json();
  assert.equal(caps.ffmpeg, null);
  assert.deepEqual(caps.formats, { replay: true, gif: true, mp4: false, webm: false });
  assert.equal(caps.gif_encoder, 'builtin');
});

// ── a real ffmpeg ──────────────────────────────────────────────────────────
// Opt-in (WEB_CHAT_E2E_FFMPEG=1); everything above runs against the fake.

const real = e2eGate(['ffmpeg']);
const realFfmpeg = real.ffmpeg;

test('a real ffmpeg: GIF holds are exact (last one too), MP4 and WebM decode to the right frames', {
  skip: real.skip, timeout: 120000,
}, async (t) => {
  const W = 64; const H = 40;
  const frames = [[RED, 333], [BLUE, 1234], [GREEN, 2500]];
  const encode = async (format) => {
    const enc = createFrameEncoder({ format, ffmpegPath: realFfmpeg, width: W, height: H, fps: 10, tmpDir: tmp(t) });
    t.after(() => enc.dispose());
    for (const [c, d] of frames) enc.addFrame(png(W, H, c), d);
    return enc.finish({ timeoutMs: 60000 });
  };

  const gif = await encode('gif');
  assert.equal(gif.encoder, 'ffmpeg', gif.fallback);
  const g = decodeGif(gif.data);
  assert.deepEqual([g.width, g.height, g.loop], [W, H, 0]);
  // Delays land on the centisecond grid against the running clock.
  assert.deepEqual(g.frames.map((f) => f.delay), [33, 124, 250]);
  const px = (img) => [img[(20 * W + 40) * 4], img[(20 * W + 40) * 4 + 1], img[(20 * W + 40) * 4 + 2]];
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 16);
  assert.ok(near(px(g.frames[0].image), RED) && near(px(g.frames[1].image), BLUE) && near(px(g.frames[2].image), GREEN));

  for (const format of ['mp4', 'webm']) {
    const v = await encode(format);
    assert.equal(v.encoder, 'ffmpeg');
    if (format === 'mp4') assert.equal(v.data.toString('latin1', 4, 8), 'ftyp');
    else assert.equal(v.data.readUInt32BE(0), 0x1a45dfa3, 'an EBML (Matroska/WebM) header');
    const file = path.join(tmp(t), `v.${format}`);
    fs.writeFileSync(file, v.data);
    const raw = spawnSync(realFfmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(raw.status, 0, String(raw.stderr));
    const size = W * H * 3;
    const n = raw.stdout.length / size;
    assert.ok(Math.abs(n - 41) <= 1, `${format}: 4.067 s at 10 fps is ~41 frames, got ${n}`);
    const at = (k) => [...raw.stdout.subarray(k * size + (20 * W + 40) * 3, k * size + (20 * W + 40) * 3 + 3)];
    const vnear = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 24);
    assert.ok(vnear(at(0), RED), `${format} opens red, got ${at(0)}`);
    assert.ok(vnear(at(10), BLUE), `${format} is blue at 1 s, got ${at(10)}`);
    assert.ok(vnear(at(Math.floor(n) - 1), GREEN), `${format} ends green (the last hold is not dropped)`);
  }
});

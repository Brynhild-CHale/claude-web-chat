// End to end against a REAL browser: POST /api/replay/render with the Chrome
// lib/replay/find locates (or WEB_CHAT_CHROME), a real replay document, real
// screenshots, the built-in PNG decoder and GIF encoder, and an independent GIF
// decoder reading the result back — then the same through a REAL ffmpeg, as a
// GIF and an MP4.
//
// OPT-IN: it SKIPS unless WEB_CHAT_E2E_CHROME=1 (and, for the ffmpeg half,
// WEB_CHAT_E2E_FFMPEG=1) — however many browsers the machine has — and still
// skips when opted in with nothing to run. CI sets neither. To run it, opt in
// and, where discovery would not find them, point WEB_CHAT_CHROME (and
// WEB_CHAT_FFMPEG) at binaries (a Chrome for Testing download works):
//   WEB_CHAT_E2E_CHROME=1 WEB_CHAT_E2E_FFMPEG=1 node --test --test-timeout=60000 \
//     --import ./test-support/sandbox.js test/replay-capture-e2e.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { spawnSync } = require('child_process');

const { withServer, e2eGate } = require('../test-support/helpers');
const { decodeGif } = require('../test-support/gif-decode');
const { closeAllBrowsers, liveBrowsers } = require('../lib/replay/chrome');

// A REAL browser is the one that leaked from test runs. withServer's teardown
// stops the server, which aborts an in-flight render; this backstop closes
// anything still up (each through the bounded close), and the check makes a
// leak a failure of THIS file rather than a stray process on the machine.
test.after(async () => {
  const up = liveBrowsers();
  await closeAllBrowsers();
  assert.equal(up, 0, `${up} browser(s) were still up when the file finished`);
});

const builtin = e2eGate(['chrome']);
const both = e2eGate(['chrome', 'ffmpeg']);

// An explicit WEB_CHAT_FFMPEG is the only ffmpeg candidate, so a missing one
// pins the built-in encoder; restored when the test ends.
function pinFfmpeg(t, value) {
  const prev = process.env.WEB_CHAT_FFMPEG;
  process.env.WEB_CHAT_FFMPEG = value;
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_FFMPEG; else process.env.WEB_CHAT_FFMPEG = prev; });
}

async function seedColours(api) {
  await api.post('/api/render', { id: 'm1', html: '<div style="height:300px;background:#c0392b;color:#fff;font:40px sans-serif">one</div>' });
  await api.post('/api/commit', { message: 'make it red' });
  await api.post('/api/render', { id: 'm1', html: '<div style="height:300px;background:#2471a3;color:#fff;font:40px sans-serif">two</div>' });
  await api.post('/api/commit', { message: 'now blue' });
}

const render = (port, body) => fetch(`http://127.0.0.1:${port}/api/replay/render`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Somewhere in the image is the colour — the pane really rendered.
const has = (img, [r, gg, b], stride = 4) => {
  for (let o = 0; o + 2 < img.length; o += stride) {
    if (Math.abs(img[o] - r) < 24 && Math.abs(img[o + 1] - gg) < 24 && Math.abs(img[o + 2] - b) < 24) return true;
  }
  return false;
};

test('a real Chrome renders a two-step replay into a GIF whose frames differ', { skip: builtin.skip, timeout: 120000 }, async (t) => {
  pinFfmpeg(t, '/nonexistent/ffmpeg');
  const { api, port } = await withServer(t);
  await seedColours(api);

  const res = await render(port, { format: 'gif', width: 480, hold_ms: 1000 });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.encoder, 'builtin');
  const g = decodeGif(fs.readFileSync(body.path));
  assert.equal(g.width, 480);
  assert.equal(g.height, 300);
  assert.equal(g.frames.length, 2, 'one frame per cut step');
  assert.deepEqual(g.frames.map((f) => f.delay), [100, 100]);
  assert.ok(!g.frames[0].image.equals(g.frames[1].image), 'the two nodes draw differently');

  assert.ok(has(g.frames[0].image, [0xc0, 0x39, 0x2b]), 'frame 1 shows the red pane');
  assert.ok(has(g.frames[1].image, [0x24, 0x71, 0xa3]), 'frame 2 shows the blue pane');
});

test('a real Chrome and a real ffmpeg render the same replay as a GIF and an MP4', {
  skip: both.skip,
  timeout: 180000,
}, async (t) => {
  const { ffmpeg } = both;
  pinFfmpeg(t, ffmpeg);
  const { api, port } = await withServer(t);
  await seedColours(api);

  const gres = await render(port, { format: 'gif', width: 480, hold_ms: 1000 });
  const gb = await gres.json();
  assert.equal(gres.status, 200, JSON.stringify(gb));
  assert.equal(gb.encoder, 'ffmpeg', `a GIF prefers ffmpeg when there is one (${gb.fallback})`);
  assert.equal(gb.fallback, undefined);
  const g = decodeGif(fs.readFileSync(gb.path));
  assert.deepEqual([g.width, g.height], [480, 300]);
  assert.equal(g.loop, 0, 'loops forever');
  assert.deepEqual(g.frames.map((f) => f.delay), [100, 100], 'each node held for hold_ms, the last one too');
  assert.ok(has(g.frames[0].image, [0xc0, 0x39, 0x2b]));
  assert.ok(has(g.frames[1].image, [0x24, 0x71, 0xa3]));

  const mres = await render(port, { format: 'mp4', width: 480, hold_ms: 1000, fps: 10 });
  const mb = await mres.json();
  assert.equal(mres.status, 200, JSON.stringify(mb));
  assert.match(mb.path, /\.mp4$/);
  const raw = spawnSync(ffmpeg, ['-v', 'error', '-i', mb.path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(raw.status, 0, String(raw.stderr));
  const size = 480 * 300 * 3;
  const n = raw.stdout.length / size;
  assert.ok(Math.abs(n - 20) <= 1, `2 s at 10 fps is ~20 frames, got ${n}`);
  assert.ok(has(raw.stdout.subarray(0, size), [0xc0, 0x39, 0x2b], 3), 'it opens on the red node');
  assert.ok(has(raw.stdout.subarray((Math.floor(n) - 1) * size, Math.floor(n) * size), [0x24, 0x71, 0xa3], 3), 'and ends on the blue one');
});

// The scroll: a new pane far below the fold. Frame 1 of the second step still
// shows the top of the page; by the end of its hold the frame has scrolled the
// new (green) pane into view — measured and scrolled by the real preview
// document inside a real Chrome.
test('a real Chrome scrolls a replay frame down to a pane added below the fold', { skip: builtin.skip, timeout: 120000 }, async (t) => {
  pinFfmpeg(t, '/nonexistent/ffmpeg');
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'tall', html: '<div style="height:1400px;background:#c0392b"></div>' });
  await api.post('/api/commit', { message: 'a tall red pane' });
  await api.post('/api/render', { id: 'low', html: '<div style="height:200px;background:#1e8449"></div>' });
  await api.post('/api/commit', { message: 'a green pane below it' });

  const res = await render(port, { format: 'gif', width: 480, hold_ms: 2000, fps: 10 });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const g = decodeGif(fs.readFileSync(body.path));
  const green = [0x1e, 0x84, 0x49];
  const first = g.frames[0].image;
  const last = g.frames[g.frames.length - 1].image;
  assert.ok(!has(first, green), 'the replay opens on the top of the page');
  assert.ok(has(last, green), 'and ends scrolled down to the new pane');
  assert.ok(g.frames.length > 3, `the move is drawn as motion (${g.frames.length} frames)`);
});

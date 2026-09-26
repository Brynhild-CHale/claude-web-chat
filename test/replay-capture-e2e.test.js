// End to end against a REAL browser: POST /api/replay/render with the Chrome
// lib/replay/find locates (or WEB_CHAT_CHROME), a real replay document, real
// screenshots, the built-in PNG decoder and GIF encoder, and an independent GIF
// decoder reading the result back.
//
// SKIPS when no Chrome-family browser is found — CI images and most dev boxes
// without Chrome. To run it anywhere, point WEB_CHAT_CHROME at a binary (a
// Chrome for Testing download works) and run this file on its own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { withServer } = require('../test-support/helpers');
const { decodeGif } = require('../test-support/gif-decode');
const { findChrome } = require('../lib/replay/find');

const chrome = findChrome();

test('a real Chrome renders a two-step replay into a GIF whose frames differ', { skip: chrome ? false : 'no Chrome-family browser found (set WEB_CHAT_CHROME to run it)', timeout: 120000 }, async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: '<div style="height:300px;background:#c0392b;color:#fff;font:40px sans-serif">one</div>' });
  await api.post('/api/commit', { message: 'make it red' });
  await api.post('/api/render', { id: 'm1', html: '<div style="height:300px;background:#2471a3;color:#fff;font:40px sans-serif">two</div>' });
  await api.post('/api/commit', { message: 'now blue' });

  const res = await fetch(`http://127.0.0.1:${port}/api/replay/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'gif', width: 480, hold_ms: 1000 }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const g = decodeGif(fs.readFileSync(body.path));
  assert.equal(g.width, 480);
  assert.equal(g.height, 300);
  assert.equal(g.frames.length, 2, 'one frame per cut step');
  assert.deepEqual(g.frames.map((f) => f.delay), [100, 100]);
  assert.ok(!g.frames[0].image.equals(g.frames[1].image), 'the two nodes draw differently');

  // Somewhere in each frame is its pane's colour — the pane really rendered.
  const has = (img, [r, gg, b]) => {
    for (let o = 0; o < img.length; o += 4) {
      if (Math.abs(img[o] - r) < 24 && Math.abs(img[o + 1] - gg) < 24 && Math.abs(img[o + 2] - b) < 24) return true;
    }
    return false;
  };
  assert.ok(has(g.frames[0].image, [0xc0, 0x39, 0x2b]), 'frame 1 shows the red pane');
  assert.ok(has(g.frames[1].image, [0x24, 0x71, 0xa3]), 'frame 2 shows the blue pane');
});

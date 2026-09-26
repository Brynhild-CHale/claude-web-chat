// lib/core/gif — the built-in GIF89a encoder a replay render writes with.
//
// Read back by an independent decoder written from the spec
// (test-support/gif-decode.js, sharing no code with the writer), and — where the
// machine has ffmpeg — by a third-party one too, so the output is a real GIF and
// not merely self-consistent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { createGifEncoder, encodeGif, lzwEncode, diffBox, GifError } = require('../lib/core/gif');
const { decodeGif, lzwDecode } = require('../test-support/gif-decode');
const { solid } = require('../test-support/png-encode');
const { findFfmpeg } = require('../lib/replay/find');

// An image with exactly `n` distinct colours, laid out so LZW has work to do.
function fewColours(w, h, n) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = (i * 7 + Math.floor(i / w) * 3) % n;
    buf[i * 4] = (c * 53) & 0xff; buf[i * 4 + 1] = (c * 97 + 11) & 0xff; buf[i * 4 + 2] = (c * 151 + 5) & 0xff; buf[i * 4 + 3] = 255;
  }
  return buf;
}

function noise(w, h, seed = 1) {
  const buf = Buffer.alloc(w * h * 4);
  let s = seed;
  for (let i = 0; i < buf.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; buf[i] = s >> 16; }
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  return buf;
}

test('header, logical screen, NETSCAPE loop, per-frame delay and the trailer', () => {
  const w = 30; const h = 20;
  const g = encodeGif([
    { data: solid(w, h, [255, 0, 0]), delay: 500 },
    { data: solid(w, h, [0, 0, 255]), delay: 1250 },
  ], { w, h });
  assert.equal(g.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(g.readUInt16LE(6), w);
  assert.equal(g.readUInt16LE(8), h);
  assert.equal(g[g.length - 1], 0x3b, 'ends with the trailer');
  const d = decodeGif(g);
  assert.equal(d.loop, 0, 'loops forever by default');
  assert.equal(d.trailer, true);
  assert.deepEqual(d.frames.map((f) => f.delay), [50, 125], 'delays in centiseconds');
  assert.ok(d.frames.every((f) => f.disposal === 1), 'each frame is left in place for the next to draw over');
  assert.ok(d.frames[1].image.equals(solid(w, h, [0, 0, 255])));

  assert.equal(decodeGif(encodeGif([{ data: solid(4, 4, [1, 2, 3]), delay: 100 }], { w: 4, h: 4, loop: 3 })).loop, 3);
  const once = encodeGif([{ data: solid(4, 4, [1, 2, 3]), delay: 100 }], { w: 4, h: 4, loop: null });
  assert.equal(decodeGif(once).loop, null, 'loop:null writes no loop extension');
  assert.ok(!once.includes(Buffer.from('NETSCAPE2.0')));
});

test('LZW round-trips through a table that fills past 4096 codes and is cleared', () => {
  // Noise defeats the dictionary, so a big frame emits far more than 4096 codes.
  const w = 256; const h = 160;
  const idx = new Uint8Array(w * h);
  crypto.randomFillSync(idx);
  const data = lzwEncode(idx, 8);
  assert.equal(data[0], 8, 'min code size byte');
  // Unpack the sub-blocks, then decode with the independent decoder.
  const parts = [];
  for (let p = 1; data[p] !== 0; p += data[p] + 1) parts.push(data.subarray(p + 1, p + 1 + data[p]));
  const out = lzwDecode(Buffer.concat(parts), 8, idx.length);
  assert.ok(out.codes > 4096, `${out.codes} codes`);
  assert.ok(out.clears >= 2, 'the start clear plus at least one table reset');
  assert.deepEqual(Uint8Array.from(out), idx);

  // …and small code sizes, including the 2-bit minimum.
  for (const bits of [2, 3, 5]) {
    const small = Uint8Array.from({ length: 9000 }, (_, i) => (i * 7 + (i >> 5)) % (1 << bits));
    const enc = lzwEncode(small, bits);
    const ps = [];
    for (let p = 1; enc[p] !== 0; p += enc[p] + 1) ps.push(enc.subarray(p + 1, p + 1 + enc[p]));
    assert.deepEqual(Uint8Array.from(lzwDecode(Buffer.concat(ps), bits, small.length)), small, `${bits}-bit`);
  }
  const empty = lzwEncode(new Uint8Array(0), 2);
  assert.deepEqual(Array.from(lzwDecode(empty.subarray(2, 2 + empty[1]), 2, 0)), [], 'an empty image is just clear + EOI');
});

test('256 colours or fewer are kept exactly — text in a UI frame stays pixel-exact', () => {
  for (const n of [1, 2, 5, 200, 256]) {
    const img = fewColours(61, 37, n);
    const d = decodeGif(encodeGif([{ data: img, delay: 100 }], { w: 61, h: 37 }));
    assert.ok(d.frames[0].image.equals(img), `${n} colours`);
  }
});

test('more than 256 colours: median cut stays close to the source', () => {
  const w = 120; const h = 80;
  const img = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      img[o] = Math.round((x / (w - 1)) * 255); img[o + 1] = Math.round((y / (h - 1)) * 255); img[o + 2] = 128; img[o + 3] = 255;
    }
  }
  const d = decodeGif(encodeGif([{ data: img, delay: 100 }], { w, h }));
  assert.equal(d.frames[0].tableSize, 256);
  let worst = 0; let total = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    const e = Math.abs(d.frames[0].image[i] - img[i]) + Math.abs(d.frames[0].image[i + 1] - img[i + 1]) + Math.abs(d.frames[0].image[i + 2] - img[i + 2]);
    worst = Math.max(worst, e); total += e;
  }
  assert.ok(total / (w * h) < 12, `mean error ${total / (w * h)}`);
  assert.ok(worst < 48, `worst error ${worst}`);
});

test('frame differencing: only the changed rectangle is written, and an identical frame extends the one before', () => {
  const w = 50; const h = 40;
  const a = solid(w, h, [240, 240, 240]);
  const b = solid(w, h, [240, 240, 240], [10, 5, 7, 3, [20, 30, 40]]);
  assert.deepEqual(diffBox(a, b, w, h), { x: 10, y: 5, w: 7, h: 3 });
  assert.equal(diffBox(a, Buffer.from(a), w, h), null);

  const d = decodeGif(encodeGif([
    { data: a, delay: 1000 },
    { data: Buffer.from(a), delay: 1500 },   // unchanged → merged into the first
    { data: b, delay: 700 },
  ], { w, h }));
  assert.equal(d.frames.length, 2);
  assert.deepEqual(d.frames.map((f) => f.delay), [250, 70]);
  assert.deepEqual([d.frames[1].left, d.frames[1].top, d.frames[1].w, d.frames[1].h], [10, 5, 7, 3]);
  assert.ok(d.frames[1].image.equals(b), 'composited over the first, the second frame is the whole picture');
});

test('delays round against the running clock, so a replay does not drift', () => {
  const w = 4; const h = 4;
  const frames = [0, 1, 2, 3, 4, 5].map((i) => ({ data: solid(w, h, [i * 40, 0, 0]), delay: 1000 / 3 }));
  const d = decodeGif(encodeGif(frames, { w, h }));
  const cs = d.frames.map((f) => f.delay);
  assert.equal(cs.reduce((x, y) => x + y, 0), 200, `${cs} sums to exactly 2 s`);
  assert.ok(cs.every((c) => c === 33 || c === 34));
  // A delay under 2 cs is raised (browsers would substitute 10 cs).
  const fast = decodeGif(encodeGif([{ data: solid(w, h, [0, 0, 0]), delay: 5 }, { data: solid(w, h, [9, 9, 9]), delay: 5 }], { w, h }));
  assert.ok(fast.frames.every((f) => f.delay >= 2));
});

test('it refuses what would be a lie in the header', () => {
  assert.throws(() => createGifEncoder({ width: 0, height: 4 }), GifError);
  assert.throws(() => createGifEncoder({ width: 70000, height: 4 }), GifError);
  const enc = createGifEncoder({ width: 4, height: 4 });
  assert.throws(() => enc.addFrame(Buffer.alloc(10), 100), /frame is 10 bytes/);
  assert.throws(() => enc.finish(), /at least one frame/);
  const ok = createGifEncoder({ width: 2, height: 2 });
  ok.addFrame(solid(2, 2, [1, 1, 1]), 100);
  ok.finish();
  assert.throws(() => ok.addFrame(solid(2, 2, [1, 1, 1]), 100), /after finish/);
});

test('a third-party decoder (ffmpeg) reads the same pixels back', { skip: findFfmpeg() ? false : 'ffmpeg not installed' }, () => {
  const w = 64; const h = 48;
  const a = fewColours(w, h, 180);
  const b = noise(w, h, 7);
  const gif = encodeGif([{ data: a, delay: 1000 }, { data: b, delay: 1000 }], { w, h });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-gif-'));
  try {
    const file = path.join(dir, 'x.gif');
    fs.writeFileSync(file, gif);
    const r = spawnSync(findFfmpeg(), ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, String(r.stderr));
    const size = w * h * 4;
    assert.ok(r.stdout.length >= size * 2, `ffmpeg produced ${r.stdout.length} bytes`);
    assert.ok(r.stdout.subarray(0, size).equals(a), 'frame 1 — exact colours, exact pixels');
    const ours = decodeGif(gif).frames[1].image;
    assert.ok(r.stdout.subarray(r.stdout.length - size).equals(ours), 'frame 2 — the same quantized pixels our decoder sees');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

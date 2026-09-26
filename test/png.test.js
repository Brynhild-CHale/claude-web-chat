// lib/core/png — the decoder a replay render turns Chrome's screenshots into
// pixels with. Pinned against the checked-in extension icons (real PNGs from a
// writer that shares no code with it), against images filtered with EACH of the
// five scanline filters by a test-only encoder, and against every input it
// promises to refuse rather than half-decode.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { decodePng, pngSize, PngError, paeth } = require('../lib/core/png');
const { encodePng, chunk } = require('../test-support/png-encode');

const REPO = path.resolve(__dirname, '..');

// A deterministic, busy RGBA image: every filter has something to predict.
function sample(w, h, alpha = true) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = (x * 37 + y * 11) & 0xff;
      buf[o + 1] = (x * y + 91) & 0xff;
      buf[o + 2] = ((x ^ y) * 29) & 0xff;
      buf[o + 3] = alpha ? ((x + y * 7) * 13) & 0xff : 255;
    }
  }
  return buf;
}

test('the extension icons decode at their declared sizes, with real alpha', () => {
  for (const ext of ['tab-stream', 'embed-helper']) {
    for (const size of [16, 32, 48, 128]) {
      const file = path.join(REPO, 'extensions', ext, 'icons', `icon${size}.png`);
      const img = decodePng(fs.readFileSync(file));
      assert.equal(img.width, size);
      assert.equal(img.height, size);
      assert.equal(img.data.length, size * size * 4);
      let transparent = 0; let opaque = 0;
      for (let i = 3; i < img.data.length; i += 4) { if (img.data[i] === 0) transparent++; if (img.data[i] === 255) opaque++; }
      assert.ok(transparent > 0 && opaque > 0, `${ext} icon${size}: a shape on a transparent ground`);
    }
  }
});

for (const filter of [0, 1, 2, 3, 4]) {
  test(`scanline filter ${filter} round-trips exactly, RGBA and RGB`, () => {
    const w = 23; const h = 17;
    const rgba = sample(w, h, true);
    const back = decodePng(encodePng(rgba, w, h, { filter }));
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.ok(back.data.equals(rgba), `filter ${filter}, RGBA`);

    const rgb = sample(w, h, false);
    const back3 = decodePng(encodePng(rgb, w, h, { filter, alpha: false }));
    assert.ok(back3.data.equals(rgb), `filter ${filter}, RGB (alpha filled to 255)`);
  });
}

test('mixed filters per row, a split IDAT stream and ancillary chunks all decode', () => {
  const w = 40; const h = 30;
  const rgba = sample(w, h);
  const png = encodePng(rgba, w, h, {
    filter: (y) => y % 5,
    idatSplit: 4,
    extra: [['sRGB', Buffer.from([0])], ['tEXt', Buffer.from('Comment\0test', 'latin1')]],
  });
  assert.ok(decodePng(png).data.equals(rgba));
});

test('paeth picks the neighbour closest to the linear prediction, ties to left then up', () => {
  assert.equal(paeth(10, 20, 10), 20);
  assert.equal(paeth(20, 10, 10), 20);
  assert.equal(paeth(5, 5, 5), 5);
  assert.equal(paeth(100, 50, 200), 50);
  assert.equal(paeth(0, 0, 255), 0);
});

// ── refusals ─────────────────────────────────────────────────────────────────

function withIhdr(mut) {
  const png = encodePng(sample(4, 4), 4, 4);
  const ihdr = Buffer.from(png.subarray(16, 29));
  mut(ihdr);
  return Buffer.concat([png.subarray(0, 8), chunk('IHDR', ihdr), png.subarray(33)]);
}

test('it refuses what it does not fully understand, naming it', () => {
  const refuses = (buf, re) => assert.throws(() => decodePng(buf), (e) => e instanceof PngError && re.test(e.message));
  refuses(Buffer.from('GIF89a not a png'), /signature/);
  refuses(withIhdr((b) => { b[9] = 3; }), /colour type 3/);
  refuses(withIhdr((b) => { b[9] = 0; }), /colour type 0/);
  refuses(withIhdr((b) => { b[8] = 16; }), /bit depth 16/);
  refuses(withIhdr((b) => { b[12] = 1; }), /interlaced/);

  const good = encodePng(sample(4, 4), 4, 4);
  const badCrc = Buffer.from(good);
  badCrc[30] ^= 0xff; // inside the IHDR CRC
  refuses(badCrc, /CRC mismatch in IHDR/);
  refuses(good.subarray(0, good.length - 12), /IEND/);

  // A scanline with filter type 7.
  const raw = Buffer.alloc((4 * 4 + 1) * 4);
  raw[0] = 7;
  const ihdr = good.subarray(16, 29);
  const bogus = Buffer.concat([good.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  refuses(bogus, /filter type 7/);

  // Fewer scanlines than declared.
  const short = Buffer.concat([good.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw.subarray(0, 17))), chunk('IEND', Buffer.alloc(0))]);
  refuses(short, /fewer scanlines/);
});

test('pngSize reads the dimensions from IHDR without decoding, and refuses what is not a PNG', () => {
  const rgba = Buffer.alloc(7 * 3 * 4, 200);
  assert.deepEqual(pngSize(encodePng(rgba, 7, 3)), { width: 7, height: 3 });
  assert.throws(() => pngSize(Buffer.from('GIF89a…')), (e) => e instanceof PngError && /signature/.test(e.message));
  const png = encodePng(rgba, 7, 3);
  const noIhdr = Buffer.from(png);
  noIhdr.write('IHDX', 12, 'latin1');
  assert.throws(() => pngSize(noIhdr), (e) => e instanceof PngError && /IHDR/.test(e.message));
  assert.throws(() => pngSize(png.subarray(0, 20)), PngError, 'truncated before the dimensions');
});

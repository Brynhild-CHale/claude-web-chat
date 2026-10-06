// lib/core/png — the one PNG decoder (replay screenshots, the icon pipeline's
// input) and the one encoder (the icon pipeline's output, the extension icons).
// The decoder is pinned against the checked-in extension icons, against images
// filtered with EACH of the five scanline filters by a test-only encoder, against
// every colour type and bit depth the PNG spec allows (written by that encoder's
// raw writer, test-support/png-encode rawPng), and against every input it
// promises to refuse rather than half-decode. The encoder is pinned by a round
// trip, by the form it writes (8-bit RGBA, filter 0 on every row, deflate level
// 9), and by redrawing the eight extension icons in memory.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { decodePng, encodePng: writePng, pngSize, PngError, paeth } = require('../lib/core/png');
const { encodePng, rawPng, packRow, chunk } = require('../test-support/png-encode');

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
  // A palette type with no palette; a colour type the spec does not define; a
  // depth the spec does not allow; Adam7.
  refuses(withIhdr((b) => { b[9] = 3; }), /PLTE/);
  refuses(withIhdr((b) => { b[9] = 5; }), /colour type 5/);
  refuses(withIhdr((b) => { b[8] = 3; }), /bit depth 3/);
  refuses(withIhdr((b) => { b[12] = 1; }), /interlaced/);
  // Depths that exist, but not for that type.
  refuses(withIhdr((b) => { b[8] = 4; }), /bit depth 4 for colour type 6/);
  refuses(withIhdr((b) => { b[9] = 2; b[8] = 2; }), /bit depth 2 for colour type 2/);
  refuses(withIhdr((b) => { b[9] = 3; b[8] = 16; }), /bit depth 16 for colour type 3/);
  // An interlaced palette image is still refused as interlaced.
  refuses(rawPng({ width: 2, height: 1, depth: 8, colorType: 3, rows: [Buffer.from([0, 0])], plte: Buffer.from([1, 2, 3]), interlace: 1 }), /interlaced/);
  // A palette index past the end of the PLTE.
  refuses(rawPng({ width: 2, height: 1, depth: 8, colorType: 3, rows: [Buffer.from([0, 2])], plte: Buffer.from([1, 2, 3, 4, 5, 6]) }), /palette index 2/);

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

// ── every colour type and bit depth ──────────────────────────────────────────

// A deterministic sample value in 0..max for pixel (x, y), channel c.
const val = (x, y, c, max) => ((x * 7 + y * 13 + c * 5 + x * y) % (max + 1));
// The 8-bit value of a d-bit greyscale sample, by the PNG spec's scaling
// (a table, so the test does not share the decoder's arithmetic).
const UP = { 1: 255, 2: 85, 4: 17, 8: 1 };

// Build a case: the unfiltered rows to write, and the RGBA the decoder must
// return for them.
function build({ colorType, depth, width = 13, height = 7, trns = false }) {
  const max = 2 ** depth - 1;
  const rows = []; const want = Buffer.alloc(width * height * 4);
  let plte = null; let trnsBuf = null;
  let entries = 0;
  if (colorType === 3) {
    entries = Math.min(2 ** depth, 9);
    plte = Buffer.alloc(entries * 3);
    for (let e = 0; e < entries; e++) { plte[e * 3] = (e * 53) & 0xff; plte[e * 3 + 1] = (e * 97 + 11) & 0xff; plte[e * 3 + 2] = 255 - e * 20; }
    // tRNS shorter than the palette: the entries past it are opaque.
    if (trns) trnsBuf = Buffer.from(Array.from({ length: Math.max(1, entries - 1) }, (_, e) => (e * 71) & 0xff));
  }
  // The single transparent colour (types 0 and 2): a value some pixels take.
  const keyGrey = val(1, 0, 0, max);
  const keyRgb = [val(2, 1, 0, max), val(2, 1, 1, max), val(2, 1, 2, max)];
  if (trns && colorType === 0) { trnsBuf = Buffer.alloc(2); trnsBuf.writeUInt16BE(keyGrey); }
  if (trns && colorType === 2) { trnsBuf = Buffer.alloc(6); keyRgb.forEach((v, i) => trnsBuf.writeUInt16BE(v, i * 2)); }
  const hi = (v) => (depth === 16 ? v >> 8 : v);
  for (let y = 0; y < height; y++) {
    const samples = [];
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const e = val(x, y, 0, max) % entries;
        samples.push(e);
        want[o] = plte[e * 3]; want[o + 1] = plte[e * 3 + 1]; want[o + 2] = plte[e * 3 + 2];
        want[o + 3] = trnsBuf && e < trnsBuf.length ? trnsBuf[e] : 255;
      } else if (colorType === 0) {
        const v = val(x, y, 0, max);
        samples.push(v);
        want[o] = want[o + 1] = want[o + 2] = depth === 16 ? v >> 8 : v * UP[depth];
        want[o + 3] = trns && v === keyGrey ? 0 : 255;
      } else if (colorType === 4) {
        const v = val(x, y, 0, max); const a = val(x, y, 3, max);
        samples.push(v, a);
        want[o] = want[o + 1] = want[o + 2] = hi(v); want[o + 3] = hi(a);
      } else {
        const ch = colorType === 6 ? 4 : 3;
        const px = [0, 1, 2, 3].slice(0, ch).map((c) => val(x, y, c, max));
        // Make the transparent colour actually occur, and a near miss that
        // differs from it only in a 16-bit sample's low byte.
        if (colorType === 2 && x === 2 && y === 1) px.splice(0, 3, ...keyRgb);
        if (colorType === 2 && depth === 16 && x === 3 && y === 1) px.splice(0, 3, keyRgb[0] ^ 1, keyRgb[1], keyRgb[2]);
        samples.push(...px);
        want[o] = hi(px[0]); want[o + 1] = hi(px[1]); want[o + 2] = hi(px[2]);
        const keyed = colorType === 2 && trns && px[0] === keyRgb[0] && px[1] === keyRgb[1] && px[2] === keyRgb[2];
        want[o + 3] = colorType === 6 ? hi(px[3]) : keyed ? 0 : 255;
      }
    }
    rows.push(packRow(samples, depth));
  }
  return { rows, want, plte, trns: trnsBuf, width, height };
}

const CASES = [
  ...[1, 2, 4, 8].flatMap((d) => [{ colorType: 3, depth: d }, { colorType: 3, depth: d, trns: true }]),
  ...[1, 2, 4, 8, 16].flatMap((d) => [{ colorType: 0, depth: d }, { colorType: 0, depth: d, trns: true }]),
  { colorType: 4, depth: 8 }, { colorType: 4, depth: 16 },
  { colorType: 2, depth: 8, trns: true }, { colorType: 2, depth: 16 }, { colorType: 2, depth: 16, trns: true },
  { colorType: 6, depth: 16 },
];

for (const c of CASES) {
  test(`colour type ${c.colorType} at depth ${c.depth}${c.trns ? ' with tRNS' : ''} round-trips under every filter`, () => {
    const b = build(c);
    for (const filter of [0, 1, 2, 3, 4, (y) => y % 5]) {
      const png = rawPng({ width: b.width, height: b.height, depth: c.depth, colorType: c.colorType, rows: b.rows, plte: b.plte, trns: b.trns, filter });
      const got = decodePng(png);
      assert.equal(got.width, b.width);
      assert.equal(got.height, b.height);
      assert.ok(got.data.equals(b.want), `filter ${typeof filter === 'function' ? 'mixed' : filter}`);
    }
    if (c.trns && c.colorType !== 3) {
      let clear = 0;
      for (let i = 3; i < b.want.length; i += 4) if (b.want[i] === 0) clear++;
      assert.ok(clear > 0, 'the transparent colour occurs in the image');
    }
  });
}

test('a 16-bit RGB pixel one low-byte step from the tRNS colour stays opaque', () => {
  const b = build({ colorType: 2, depth: 16, trns: true });
  const got = decodePng(rawPng({ width: b.width, height: b.height, depth: 16, colorType: 2, rows: b.rows, trns: b.trns }));
  const at = (x, y) => (y * b.width + x) * 4 + 3;
  assert.equal(got.data[at(2, 1)], 0, 'the exact colour is transparent');
  assert.equal(got.data[at(3, 1)], 255, 'the near miss is not');
});

test('a C2PA-style ancillary chunk (and eXIf, iCCP) is skipped, CRC-checked', () => {
  const w = 9; const h = 5;
  const rgba = sample(w, h);
  const manifest = Buffer.alloc(23 * 1024);
  for (let i = 0; i < manifest.length; i++) manifest[i] = (i * 31) & 0xff;
  const png = encodePng(rgba, w, h, {
    extra: [['caBX', manifest], ['eXIf', Buffer.from('MM\0*', 'latin1')], ['iCCP', Buffer.from('p\0\0junk', 'latin1')]],
  });
  assert.ok(decodePng(png).data.equals(rgba));
  const at = png.indexOf('caBX');
  const torn = Buffer.from(png);
  torn[at + 100] ^= 0xff;
  assert.throws(() => decodePng(torn), (e) => e instanceof PngError && /CRC mismatch in caBX/.test(e.message));
});

// ── the encoder ──────────────────────────────────────────────────────────────

// Walk the chunks: { type: [body, …] }.
function chunksOf(png) {
  const out = {};
  for (let off = 8; off + 12 <= png.length;) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    (out[type] ||= []).push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  return out;
}

test('encodePng round-trips through decodePng', () => {
  for (const [w, h] of [[1, 1], [23, 17], [64, 3]]) {
    const rgba = sample(w, h);
    const back = decodePng(writePng(rgba, w, h));
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.ok(back.data.equals(rgba), `${w}×${h}`);
  }
});

test('encodePng writes 8-bit RGBA, no interlace, filter 0 on every row, deflate level 9', () => {
  const w = 23; const h = 17;
  const rgba = sample(w, h);
  const png = writePng(rgba, w, h);
  const c = chunksOf(png);
  const ihdr = c.IHDR[0];
  assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]], [w, h, 8, 6, 0, 0, 0]);
  assert.equal(c.IDAT.length, 1);
  const raw = zlib.inflateSync(Buffer.concat(c.IDAT));
  assert.equal(raw.length, h * (w * 4 + 1));
  for (let y = 0; y < h; y++) assert.equal(raw[y * (w * 4 + 1)], 0, `row ${y}'s filter byte`);
  assert.ok(c.IDAT[0].equals(zlib.deflateSync(raw, { level: 9 })), 'deflated at level 9');
  assert.deepEqual(Object.keys(c), ['IHDR', 'IDAT', 'IEND']);
});

test("make-icons' in-memory output for each of the eight extension icons decodes pixel-equal to the shipped file", (t) => {
  const { SIZES, SUPER, EXTENSIONS } = require('../extensions/make-icons');
  const { resample } = require('../lib/core/icon');
  assert.equal(EXTENSIONS.length * SIZES.length, 8);
  let sameBytes = 0;
  for (const ext of EXTENSIONS) {
    const master = Buffer.alloc(SUPER * SUPER * 4);
    ext.draw(master, SUPER);
    for (const size of SIZES) {
      const made = writePng(resample(master, SUPER, SUPER, size, size), size, size);
      const shipped = fs.readFileSync(path.join(REPO, 'extensions', ext.dir, 'icons', `icon${size}.png`));
      assert.ok(decodePng(made).data.equals(decodePng(shipped).data), `${ext.dir} icon${size}: pixel-equal`);
      assert.ok(chunksOf(made).IHDR[0].equals(chunksOf(shipped).IHDR[0]), `${ext.dir} icon${size}: the same IHDR`);
      if (made.equals(shipped)) sameBytes++;
    }
  }
  // Byte equality holds only where this Node's zlib deflates as the one that
  // wrote the files did: Node 26 here (zlib 1.2.12) reproduces all eight, the
  // official v22.23.3 binary (zlib 1.3.1) none of them, pixel-equal everywhere.
  // So it is logged, not asserted.
  t.diagnostic(`byte-identical: ${sameBytes}/8 (zlib ${process.versions.zlib})`);
});

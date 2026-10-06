// A PNG encoder for the tests — and ONLY for the tests.
//
// lib/core/png.js is the package's one PNG decoder and one encoder, and its
// encoder writes one form only (8-bit RGBA, filter 0 on every row). To pin the
// decoder's handling of every scanline filter and every colour type and bit
// depth, the tests need images written each of those ways, and the fake Chrome
// (test-support/fake-chrome.js) needs screenshots to hand back. encodePng writes
// 8-bit RGB or RGBA with a chosen filter per row; rawPng writes any IHDR, with
// PLTE / tRNS, from scanlines the test packed itself (packRow), filtered here.

const zlib = require('zlib');
const { crc32 } = require('../lib/core/zip');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter unfiltered scanlines (each `stride` bytes) with `filter` (0–4, or
// (y) => type), `bpp` bytes back for the left neighbour. → the raw IDAT stream.
function filterRows(rows, bpp, filter) {
  const stride = rows[0].length;
  const raw = Buffer.alloc((stride + 1) * rows.length);
  let prev = Buffer.alloc(stride);
  rows.forEach((cur, y) => {
    const type = typeof filter === 'function' ? filter(y) : filter;
    const at = y * (stride + 1);
    raw[at] = type;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      const pred = type === 0 ? 0 : type === 1 ? left : type === 2 ? up
        : type === 3 ? ((left + up) >> 1) : paeth(left, up, ul);
      raw[at + 1 + i] = (cur[i] - pred) & 0xff;
    }
    prev = cur;
  });
  return raw;
}

// The signature, IHDR, extra chunks, IDAT (split when asked) and IEND.
function assemble(ihdr, raw, { extra = [], idatSplit = 0 } = {}) {
  const z = zlib.deflateSync(raw);
  // Split the stream across several IDAT chunks when asked: a decoder has to
  // concatenate them, and Chrome's encoder does write more than one.
  const idats = [];
  if (idatSplit > 1) {
    const step = Math.ceil(z.length / idatSplit);
    for (let i = 0; i < z.length; i += step) idats.push(chunk('IDAT', z.subarray(i, i + step)));
  } else {
    idats.push(chunk('IDAT', z));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra.map(([t, d]) => chunk(t, d)),
    ...idats,
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ihdrOf(width, height, depth, colorType, interlace = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace;
  return ihdr;
}

// rgba: width*height*4. opts: { alpha = true, filter = 0 | 1 | 2 | 3 | 4 |
// (y) => type, extra: [[type, Buffer]] ancillary chunks placed before IDAT }.
function encodePng(rgba, width, height, { alpha = true, filter = 0, extra = [], idatSplit = 0 } = {}) {
  const bpp = alpha ? 4 : 3;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const cur = Buffer.alloc(width * bpp);
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      for (let c = 0; c < bpp; c++) cur[x * bpp + c] = rgba[s + c];
    }
    rows.push(cur);
  }
  return assemble(ihdrOf(width, height, 8, alpha ? 6 : 2), filterRows(rows, bpp, filter), { extra, idatSplit });
}

// Pack one scanline's samples (a flat array, channel by channel) at `depth`:
// MSB first under 8 bits (the last byte zero-padded), big-endian at 16.
function packRow(samples, depth) {
  if (depth === 8) return Buffer.from(samples);
  if (depth === 16) {
    const out = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => out.writeUInt16BE(v, i * 2));
    return out;
  }
  const out = Buffer.alloc(Math.ceil((samples.length * depth) / 8));
  samples.forEach((v, i) => {
    const bit = i * depth;
    out[bit >> 3] |= v << (8 - depth - (bit & 7));
  });
  return out;
}

// A PNG of any IHDR from unfiltered scanlines (packRow's), filtered with
// `filter`. opts: { plte, trns (Buffers, placed before IDAT), filter, extra,
// interlace, idatSplit }. The filter's left-neighbour distance is the PNG
// spec's: max(1, channels × depth / 8) bytes.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function rawPng({ width, height, depth, colorType, rows, plte = null, trns = null, filter = 0, extra = [], interlace = 0, idatSplit = 0 }) {
  const bpp = Math.max(1, ((CHANNELS[colorType] || 1) * depth) >> 3);
  const chunks = [];
  if (plte) chunks.push(['PLTE', plte]);
  if (trns) chunks.push(['tRNS', trns]);
  return assemble(ihdrOf(width, height, depth, colorType, interlace), filterRows(rows, bpp, filter),
    { extra: [...chunks, ...extra], idatSplit });
}

// A solid-colour RGBA frame, with an optional filled rectangle on top.
function solid(width, height, [r, g, b], rect) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255; }
  if (rect) {
    const [x0, y0, w, h, [rr, gg, bb]] = rect;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * width + x) * 4;
        buf[o] = rr; buf[o + 1] = gg; buf[o + 2] = bb;
      }
    }
  }
  return buf;
}

module.exports = { encodePng, rawPng, packRow, solid, chunk };

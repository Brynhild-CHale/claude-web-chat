// A PNG encoder for the tests — and ONLY for the tests.
//
// lib/core/png.js decodes; the package never writes a PNG outside
// extensions/make-icons.js (which only ever uses filter 0). To pin the decoder's
// handling of every scanline filter, the tests need images filtered each way,
// and the fake Chrome (test-support/fake-chrome.js) needs screenshots to hand
// back. This writes 8-bit RGB or RGBA with a chosen filter per row.

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

// rgba: width*height*4. opts: { alpha = true, filter = 0 | 1 | 2 | 3 | 4 |
// (y) => type, extra: [[type, Buffer]] ancillary chunks placed before IDAT }.
function encodePng(rgba, width, height, { alpha = true, filter = 0, extra = [], idatSplit = 0 } = {}) {
  const bpp = alpha ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      for (let c = 0; c < bpp; c++) cur[x * bpp + c] = rgba[s + c];
    }
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
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
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

module.exports = { encodePng, solid, chunk };

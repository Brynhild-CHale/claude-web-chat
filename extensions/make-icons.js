#!/usr/bin/env node
// Regenerate the toolbar/action icons both bundled extensions reference from
// their manifests. Chrome MV3 accepts bitmaps only (no SVG), so these have to be
// real PNGs — but a PNG checked in as an opaque blob is a thing nobody can edit.
// This script IS the source: run `node extensions/make-icons.js` and the PNGs
// under extensions/<name>/icons/ are rewritten from the shape code below.
//
// Zero dependencies: zlib (for the IDAT stream) and a CRC32 are all a valid PNG
// needs — and the CRC32 comes from lib/core/zip, the one home for it, because a
// PNG chunk and a ZIP entry carry the same IEEE checksum and this script used to
// keep a second copy of it. Everything is drawn once at 4x into an RGBA buffer
// and area-averaged down to each target size, which is where the antialiasing
// comes from.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('../lib/core/zip');

const SIZES = [16, 32, 48, 128];
const SUPER = 512; // master canvas; every size is an area-average of this

// ---------------------------------------------------------------- PNG encoding

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 8-bit RGBA (color type 6), no interlace, filter 0 on every scanline.
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- rendering

// Straight-alpha "source over" of an opaque paint at coverage `a` (0..1).
function paint(buf, w, x, y, [r, g, b], a) {
  if (a <= 0) return;
  const i = (y * w + x) * 4;
  const dstA = buf[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  buf[i] = Math.round((r * a + buf[i] * dstA * (1 - a)) / outA);
  buf[i + 1] = Math.round((g * a + buf[i + 1] * dstA * (1 - a)) / outA);
  buf[i + 2] = Math.round((b * a + buf[i + 2] * dstA * (1 - a)) / outA);
  buf[i + 3] = Math.round(outA * 255);
}

function fill(buf, w, h, color, inside) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inside(x + 0.5, y + 0.5)) paint(buf, w, x, y, color, 1);
    }
  }
}

function roundRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
}

function rect(x0, y0, x1, y1) {
  return (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

// Downward-pointing triangle spanning [x0,x1] at yTop, converging at yTip.
function downTriangle(x0, x1, yTop, yTip) {
  const cx = (x0 + x1) / 2;
  const half = (x1 - x0) / 2;
  return (x, y) => {
    if (y < yTop || y > yTip) return false;
    const t = (y - yTop) / (yTip - yTop);
    return Math.abs(x - cx) <= half * (1 - t);
  };
}

// Area-average resample. Handles non-integer ratios (512 -> 48), which is why
// this isn't a plain every-Nth-pixel decimation.
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * fy);
    const sy1 = Math.min(sh, Math.ceil((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * fx);
      const sx1 = Math.min(sw, Math.ceil((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const i = (yy * sw + xx) * 4;
          const sa = src[i + 3] / 255;
          // Premultiply so transparent pixels don't drag colour into the edges.
          r += src[i] * sa; g += src[i + 1] * sa; b += src[i + 2] * sa; a += sa;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the two marks

const WHITE = [255, 255, 255];

// tab-stream: a page being sent downward into a tray. Blue.
function drawTabStream(buf, S) {
  const u = S / 512;
  fill(buf, S, S, [9, 105, 218], roundRect(0, 0, S - 1, S - 1, 108 * u));
  fill(buf, S, S, WHITE, rect(226 * u, 96 * u, 286 * u, 268 * u));          // shaft
  fill(buf, S, S, WHITE, downTriangle(166 * u, 346 * u, 248 * u, 372 * u)); // head
  fill(buf, S, S, WHITE, rect(130 * u, 396 * u, 382 * u, 428 * u));         // tray
}

// embed-helper: a browser frame with its title bar. Purple, so the two icons are
// never confused in the toolbar.
function drawEmbedHelper(buf, S) {
  const u = S / 512;
  fill(buf, S, S, [130, 80, 223], roundRect(0, 0, S - 1, S - 1, 108 * u));
  fill(buf, S, S, WHITE, roundRect(96 * u, 120 * u, 416 * u, 392 * u, 24 * u));
  // Punch the interior back out to leave a frame + title bar.
  const inner = roundRect(128 * u, 214 * u, 384 * u, 360 * u, 8 * u);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (inner(x + 0.5, y + 0.5)) {
        const i = (y * S + x) * 4;
        buf[i] = 130; buf[i + 1] = 80; buf[i + 2] = 223; buf[i + 3] = 255;
      }
    }
  }
}

const EXTENSIONS = [
  { dir: 'tab-stream', draw: drawTabStream },
  { dir: 'embed-helper', draw: drawEmbedHelper },
];

function main() {
  for (const ext of EXTENSIONS) {
    const master = Buffer.alloc(SUPER * SUPER * 4); // transparent
    ext.draw(master, SUPER);
    const outDir = path.join(__dirname, ext.dir, 'icons');
    fs.mkdirSync(outDir, { recursive: true });
    for (const size of SIZES) {
      const px = size === SUPER ? master : resample(master, SUPER, SUPER, size, size);
      const file = path.join(outDir, `icon${size}.png`);
      fs.writeFileSync(file, encodePng(px, size, size));
      console.log(`wrote ${path.relative(process.cwd(), file)} (${size}x${size})`);
    }
  }
}

if (require.main === module) main();

module.exports = { encodePng, resample, SIZES };

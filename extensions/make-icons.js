#!/usr/bin/env node
// Regenerate the toolbar/action icons both bundled extensions reference from
// their manifests. Chrome MV3 accepts bitmaps only (no SVG), so these have to be
// real PNGs — but a PNG checked in as an opaque blob is a thing nobody can edit.
// This script IS the source: run `node extensions/make-icons.js` and the PNGs
// under extensions/<name>/icons/ are rewritten from the shape code below.
//
// Zero dependencies. The PNG encoder is lib/core/png's (the one encoder: 8-bit
// RGBA, filter 0, deflate level 9 — the bytes this script wrote when it kept a
// private copy) and the resampler is lib/core/icon's (the one area-average
// resampler, shared with the project-icon pipeline). Everything is drawn once at
// 4x into an RGBA buffer and area-averaged down to each target size, which is
// where the antialiasing comes from.

const fs = require('fs');
const path = require('path');
const { encodePng } = require('../lib/core/png');
const { resample } = require('../lib/core/icon');

const SIZES = [16, 32, 48, 128];
const SUPER = 512; // master canvas; every size is an area-average of this

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

// SIZES for anyone listing the icons; SUPER and EXTENSIONS (each one's folder
// and draw function) so a test can draw the two masters in memory and check the
// shipped PNGs against them. No encoder and no resampler: those are lib/core's.
module.exports = { SIZES, SUPER, EXTENSIONS };

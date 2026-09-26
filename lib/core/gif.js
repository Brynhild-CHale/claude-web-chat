// A GIF89a encoder — the one home for writing one.
//
// The replay renderer (lib/server/replay/render.js) captures frames from a
// headless Chrome and has to hand the user an animated image with no runtime
// dependency and no ffmpeg on the machine. GIF is the format that works
// everywhere — a chat message, an issue, an email — and its encoder is three
// well-specified pieces this file owns, like lib/core/zip owns the ZIP container:
//
//   - a palette per frame, by MEDIAN CUT over a 15-bit colour histogram (or the
//     exact colours, when a frame has 256 or fewer — UI screenshots often do, and
//     then text stays pixel-exact);
//   - LZW with the GIF variable code width, a clear code at start and whenever
//     the 4096-entry table fills, packed LSB-first into 255-byte sub-blocks;
//   - frame differencing: each frame after the first is only the bounding box of
//     the pixels that changed, drawn over the last one (disposal 1), and a frame
//     identical to the one before it adds its delay to that frame instead of
//     being written at all — a replay holding one node for 2.5 s is one frame.
//
// No dithering: the frames are UI, where error diffusion turns flat panels into
// noise. Every frame is opaque; alpha is ignored.
//
//   const enc = createGifEncoder({ width, height, loop: 0 });
//   enc.addFrame(rgba, delayMs);   // rgba: width*height*4 bytes
//   const buf = enc.finish();
//
//   encodeGif([{ data, delay }], { w, h, loop })   — the same, in one call.
//
// `loop` 0 plays forever (the NETSCAPE2.0 extension); a positive n repeats n
// times; null writes no loop extension (play once).

class GifError extends Error {
  constructor(message) { super(message); this.name = 'GifError'; this.code = 'gif-encode'; }
}

const MAX_DIM = 0xffff;
const MAX_CODES = 4096;

// ── palette ─────────────────────────────────────────────────────────────────

// The palette for the pixels of `rgba` inside box {x, y, w, h} of a frame
// `width` wide, and a function mapping a pixel offset to its palette index.
// → { palette: [[r,g,b], …], indexOf(off) }
function buildPalette(rgba, width, box) {
  // Pass 1: exact colours, if there are few enough to keep them all.
  const exact = new Map();
  let overflow = false;
  for (let y = box.y; y < box.y + box.h && !overflow; y++) {
    for (let x = box.x, o = (y * width + x) * 4; x < box.x + box.w; x++, o += 4) {
      const c = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
      if (!exact.has(c)) {
        if (exact.size === 256) { overflow = true; break; }
        exact.set(c, exact.size);
      }
    }
  }
  if (!overflow) {
    const palette = [...exact.keys()].map((c) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]);
    return {
      palette,
      indexOf: (o) => exact.get((rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]),
    };
  }

  // Pass 2: median cut over a 5-5-5 histogram, keeping exact sums per bucket so
  // each palette entry is the true mean of the pixels it stands for.
  const count = new Uint32Array(32768);
  const sr = new Float64Array(32768);
  const sg = new Float64Array(32768);
  const sb = new Float64Array(32768);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x, o = (y * width + x) * 4; x < box.x + box.w; x++, o += 4) {
      const k = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
      count[k]++; sr[k] += rgba[o]; sg[k] += rgba[o + 1]; sb[k] += rgba[o + 2];
    }
  }
  const keys = [];
  for (let k = 0; k < 32768; k++) if (count[k]) keys.push(k);
  const chan = (k, c) => (c === 0 ? (k >> 10) : c === 1 ? ((k >> 5) & 31) : (k & 31));

  const describe = (list) => {
    let pixels = 0;
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    for (const k of list) {
      pixels += count[k];
      for (let c = 0; c < 3; c++) { const v = chan(k, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    return { list, pixels, axis, range: ranges[axis] };
  };

  const boxes = [describe(keys)];
  while (boxes.length < 256) {
    // Split the box whose widest side, weighted by how many pixels it holds,
    // is largest — big flat areas keep their colour, busy ones get the entries.
    let best = -1;
    let score = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.list.length < 2 || b.range === 0) continue;
      const s = b.range * Math.sqrt(b.pixels);
      if (s > score) { score = s; best = i; }
    }
    if (best < 0) break;
    const b = boxes[best];
    const axis = b.axis;
    b.list.sort((p, q) => chan(p, axis) - chan(q, axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < b.list.length - 1; i++) {
      acc += count[b.list[i]];
      if (acc >= b.pixels / 2) { cut = i + 1; break; }
      cut = i + 1;
    }
    boxes.splice(best, 1, describe(b.list.slice(0, cut)), describe(b.list.slice(cut)));
  }

  const palette = boxes.map((bx) => {
    let n = 0; let r = 0; let g = 0; let bl = 0;
    for (const k of bx.list) { n += count[k]; r += sr[k]; g += sg[k]; bl += sb[k]; }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
  // Each bucket maps to the palette entry nearest its own mean colour.
  const lookup = new Uint8Array(32768);
  for (const k of keys) {
    const r = sr[k] / count[k]; const g = sg[k] / count[k]; const bl = sb[k] / count[k];
    let bi = 0; let bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - bl) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    lookup[k] = bi;
  }
  return {
    palette,
    indexOf: (o) => lookup[((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3)],
  };
}

// ── LZW ─────────────────────────────────────────────────────────────────────

// Compress `indices` (Uint8Array of palette indices) with GIF LZW at
// `minCodeSize`, and return the image data as sub-blocks (≤255 bytes each,
// terminated by a zero-length block), preceded by the min-code-size byte.
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bytes = [];
  let acc = 0;
  let bits = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) { bytes.push(acc & 0xff); acc >>>= 8; bits -= 8; }
  };

  let dict = new Map();
  let next = eoi + 1;
  emit(clear);
  if (indices.length) {
    let cur = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (cur << 8) | k;
      const hit = dict.get(key);
      if (hit !== undefined) { cur = hit; continue; }
      emit(cur);
      if (next === MAX_CODES) {
        // The table is full: reset it, and tell the decoder so.
        emit(clear);
        dict = new Map();
        next = eoi + 1;
        codeSize = minCodeSize + 1;
      } else {
        if (next >= (1 << codeSize)) codeSize++;
        dict.set(key, next++);
      }
      cur = k;
    }
    emit(cur);
  }
  emit(eoi);
  if (bits > 0) bytes.push(acc & 0xff);

  const out = [Buffer.from([minCodeSize])];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(Buffer.from([chunk.length]), Buffer.from(chunk));
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

// ── the container ───────────────────────────────────────────────────────────

const u16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);

// The rectangle of pixels that differ between two frames, or null when none do.
function diffBox(a, b, width, height) {
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const o = row + x * 4;
      if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function createGifEncoder({ width, height, loop = 0 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_DIM || height > MAX_DIM) {
    throw new GifError(`bad GIF dimensions ${width}x${height}`);
  }
  const parts = [];
  parts.push(Buffer.from('GIF89a', 'ascii'), u16(width), u16(height), Buffer.from([0x00, 0x00, 0x00]));
  if (loop != null && loop !== false) {
    const n = Math.max(0, Math.min(0xffff, Math.floor(Number(loop) || 0)));
    parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'),
      Buffer.from([0x03, 0x01]), u16(n), Buffer.from([0x00]));
  }

  let prev = null;          // the previous frame's source pixels
  let pending = null;       // { box, data }: encoded on flush, so a repeat can extend it
  let pendingEndMs = 0;     // when the pending frame stops showing, on the timeline
  let writtenCs = 0;        // centiseconds already committed to written frames
  let frames = 0;
  let done = false;

  function flush() {
    if (!pending) return;
    // Delays are rounded against the running clock, not per frame, so a long
    // replay does not drift from its timeline by a rounding error per frame.
    let cs = Math.round(pendingEndMs / 10) - writtenCs;
    cs = Math.max(2, Math.min(0xffff, cs)); // below 2 cs browsers substitute 10
    writtenCs += cs;
    const { box, data } = pending;
    const { palette, indexOf } = buildPalette(data, width, box);
    let bitsNeeded = 1;
    while ((1 << bitsNeeded) < palette.length) bitsNeeded++;
    const tableBits = Math.max(1, bitsNeeded);
    const table = Buffer.alloc(3 * (1 << tableBits));
    palette.forEach((c, i) => { table[i * 3] = c[0]; table[i * 3 + 1] = c[1]; table[i * 3 + 2] = c[2]; });
    const indices = new Uint8Array(box.w * box.h);
    let p = 0;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x, o = (y * width + x) * 4; x < box.x + box.w; x++, o += 4) indices[p++] = indexOf(o);
    }
    parts.push(
      // Graphic Control Extension: disposal 1 (leave in place), no transparency.
      Buffer.from([0x21, 0xf9, 0x04, 0x04]), u16(cs), Buffer.from([0x00, 0x00]),
      // Image Descriptor with a local colour table of 2^tableBits entries.
      Buffer.from([0x2c]), u16(box.x), u16(box.y), u16(box.w), u16(box.h),
      Buffer.from([0x80 | (tableBits - 1)]), table,
      lzwEncode(indices, Math.max(2, tableBits)),
    );
    frames++;
    pending = null;
  }

  return {
    addFrame(rgba, delayMs) {
      if (done) throw new GifError('addFrame after finish');
      if (!rgba || rgba.length !== width * height * 4) {
        throw new GifError(`frame is ${rgba ? rgba.length : 0} bytes; ${width}x${height} RGBA is ${width * height * 4}`);
      }
      const delay = Math.max(0, Number(delayMs) || 0);
      const box = prev ? diffBox(prev, rgba, width, height) : { x: 0, y: 0, w: width, h: height };
      if (!box && pending) {
        pendingEndMs += delay;           // unchanged: hold the frame on screen longer
        return;
      }
      flush();
      // An unchanged frame with nothing pending cannot happen (the first frame
      // is always whole), but a 1×1 no-op box keeps the invariant cheap.
      pending = { box: box || { x: 0, y: 0, w: 1, h: 1 }, data: rgba };
      pendingEndMs += delay;
      prev = rgba;
    },
    finish() {
      if (done) throw new GifError('finish called twice');
      flush();
      if (!frames) throw new GifError('a GIF needs at least one frame');
      done = true;
      parts.push(Buffer.from([0x3b]));
      return Buffer.concat(parts);
    },
    get frames() { return frames + (pending ? 1 : 0); },
  };
}

// One-shot form: frames = [{ data, delay }].
function encodeGif(frames, { w, h, loop = 0 } = {}) {
  const enc = createGifEncoder({ width: w, height: h, loop });
  for (const f of frames) enc.addFrame(f.data, f.delay);
  return enc.finish();
}

module.exports = { createGifEncoder, encodeGif, lzwEncode, buildPalette, diffBox, GifError };

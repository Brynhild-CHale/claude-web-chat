// A PNG decoder — the one home for reading one.
//
// Its caller is the replay GIF renderer (lib/server/replay/render.js), which
// asks a headless Chrome for one screenshot per frame and gets PNG bytes back.
// Turning those into pixels needs inflate (zlib ships it) plus the five scanline
// filters, which is small enough to own and too easy to get subtly wrong twice
// — so it lives here, beside the CRC-32 it verifies chunks with
// (lib/core/zip), and nowhere else.
//
// Deliberately narrow: 8-bit truecolour (RGB, colour type 2) and truecolour
// with alpha (RGBA, colour type 6), non-interlaced. That is every PNG Chrome's
// Page.captureScreenshot and extensions/make-icons.js produce. Anything else — a
// palette, 16-bit samples, Adam7 — throws a PngError naming what it met, rather
// than returning pixels it only thinks it decoded.

const zlib = require('zlib');
const { crc32 } = require('./zip');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class PngError extends Error {
  constructor(message) { super(message); this.name = 'PngError'; this.code = 'bad-png'; }
}

// The Paeth predictor (PNG spec §9.4): whichever of left / up / upper-left is
// closest to left + up − upper-left.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Reverse one scanline's filter in place. `cur` is the filtered row (no filter
// byte), `prev` the previous row already unfiltered (zeros for the first row),
// `bpp` bytes per pixel.
function unfilter(type, cur, prev, bpp) {
  const n = cur.length;
  switch (type) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff; return;
    case 2: for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 0xff; return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        const upLeft = i >= bpp ? prev[i - bpp] : 0;
        cur[i] = (cur[i] + paeth(left, prev[i], upLeft)) & 0xff;
      }
      return;
    default: throw new PngError(`unknown scanline filter type ${type}`);
  }
}

// decodePng(buf) → { width, height, data } where data is RGBA, 4 bytes per
// pixel, row-major. Throws PngError on anything it does not fully understand.
function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('not a PNG (bad signature)');
  let off = 8;
  let ihdr = null;
  const idat = [];
  let ended = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) throw new PngError(`truncated ${type} chunk`);
    const body = buf.subarray(off + 8, off + 8 + len);
    const want = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== want) throw new PngError(`CRC mismatch in ${type} chunk`);
    if (type === 'IHDR') {
      if (len !== 13) throw new PngError('IHDR has the wrong length');
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      ended = true;
      break;
    } else if (!ihdr) {
      throw new PngError(`${type} chunk before IHDR`);
    }
    // Ancillary chunks (sRGB, pHYs, tEXt …) carry nothing the pixels need.
    off = end;
  }
  if (!ihdr) throw new PngError('no IHDR chunk');
  if (!ended) throw new PngError('no IEND chunk (truncated file)');
  const { width, height, depth, colorType, compression, filter, interlace } = ihdr;
  if (depth !== 8) throw new PngError(`unsupported bit depth ${depth} (only 8)`);
  if (colorType !== 2 && colorType !== 6) {
    throw new PngError(`unsupported colour type ${colorType} (only RGB=2 and RGBA=6)`);
  }
  if (compression !== 0 || filter !== 0) throw new PngError('unknown compression or filter method');
  if (interlace !== 0) throw new PngError('interlaced PNGs are not supported');
  if (!width || !height) throw new PngError('zero-sized image');

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); }
  catch (e) { throw new PngError(`bad IDAT stream: ${e.message}`); }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) throw new PngError('IDAT holds fewer scanlines than IHDR declares');

  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const cur = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    unfilter(raw[at], cur, prev, bpp);
    const row = y * width * 4;
    if (bpp === 4) {
      cur.copy(out, row);
    } else {
      for (let x = 0, s = 0, d = row; x < width; x++, s += 3, d += 4) {
        out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

module.exports = { decodePng, PngError, paeth, PNG_SIGNATURE: SIGNATURE };

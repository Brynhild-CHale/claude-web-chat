// PNG, both directions — the one decoder and the one encoder.
//
// Three callers. The replay GIF renderer (lib/replay/encode.js) decodes the
// screenshots a headless Chrome hands back; the icon pipeline (lib/core/icon.js)
// decodes the logo or favicon a user brings and encodes the variants it makes;
// extensions/make-icons.js encodes the toolbar icons both bundled extensions
// ship. Reading a PNG takes inflate (zlib ships it) plus the five scanline
// filters, which is small enough to own and too easy to get subtly wrong
// twice — so both halves live here, beside the CRC-32 every chunk carries
// (lib/core/zip), and nowhere else.
//
// The decoder reads every colour type and bit depth the PNG spec allows, as
// long as the image is not interlaced: greyscale (type 0, depths 1/2/4/8/16),
// truecolour (2, 8/16), palette (3, 1/2/4/8, with PLTE and an optional tRNS
// giving each entry an alpha), greyscale with alpha (4, 8/16) and truecolour
// with alpha (6, 8/16); tRNS's single transparent colour for types 0 and 2.
// Every row goes through the one unfilter() whatever its type, with the
// filter's byte stride max(1, channels x depth / 8), so there is one predictor
// of each kind. A 16-bit sample keeps its high byte. Output is always 8-bit RGBA.
// Adam7 interlacing, an unknown colour type, or a depth the spec does not allow
// for its type throws a PngError naming what it met, rather than returning
// pixels it only thinks it decoded. A second IHDR is refused, and the IDAT
// stream is inflated no further than its IHDR's scanlines (plus a small
// slack), so the size pngSize and a caller's pixel cap read is the size that
// is decoded and allocated. Ancillary chunks (sRGB, iCCP, eXIf, tEXt, a
// C2PA manifest …) carry nothing the pixels need and are skipped.
//
// The encoder writes one form only: 8-bit RGBA, no interlace, filter type 0 on
// every row, deflate level 9. It does not filter on purpose: that keeps the
// extension icons byte-identical to what they were when make-icons.js owned the
// encoder, and keeps one predictor implementation in the package.

const buffer = require('buffer');
const zlib = require('zlib');
const { crc32 } = require('./zip');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// How far past its IHDR's (stride + 1) x height an IDAT stream may inflate.
const INFLATE_SLACK = 4096;

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

// The bit depths the PNG spec allows for each colour type, and how many
// samples (channels) one pixel of that type carries.
const DEPTHS = Object.freeze({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] });
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const TYPE_NAMES = 'greyscale=0, RGB=2, palette=3, grey+alpha=4 and RGBA=6';

// decodePng(buf) → { width, height, data } where data is 8-bit RGBA, 4 bytes
// per pixel, row-major. Throws PngError on anything it does not fully
// understand.
function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('not a PNG (bad signature)');
  let off = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
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
      // One IHDR only: a later one would decode pixels the size checks made
      // on the first (pngSize, a caller's pixel cap) never saw.
      if (ihdr) throw new PngError('more than one IHDR chunk');
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
    } else if (!ihdr) {
      throw new PngError(`${type} chunk before IHDR`);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'PLTE') {
      if (len === 0 || len % 3 !== 0 || len > 256 * 3) throw new PngError('PLTE has a length that is not 1 to 256 entries');
      plte = body;
    } else if (type === 'tRNS') {
      trns = body;
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    // Ancillary chunks (sRGB, pHYs, iCCP, eXIf, tEXt, a C2PA manifest …) carry
    // nothing the pixels need.
    off = end;
  }
  if (!ihdr) throw new PngError('no IHDR chunk');
  if (!ended) throw new PngError('no IEND chunk (truncated file)');
  const { width, height, depth, colorType, compression, filter, interlace } = ihdr;
  if (!Object.hasOwn(DEPTHS, colorType)) {
    throw new PngError(`unsupported colour type ${colorType} (only ${TYPE_NAMES})`);
  }
  if (!DEPTHS[colorType].includes(depth)) {
    throw new PngError(`unsupported bit depth ${depth} for colour type ${colorType} (only ${DEPTHS[colorType].join('/')})`);
  }
  if (compression !== 0 || filter !== 0) throw new PngError('unknown compression or filter method');
  if (interlace !== 0) throw new PngError('interlaced PNGs are not supported');
  if (!width || !height) throw new PngError('zero-sized image');
  if (colorType === 3 && !plte) throw new PngError('a palette image (colour type 3) has no PLTE chunk');

  // tRNS: per-entry alpha for a palette; one fully transparent colour, at the
  // image's own sample depth, for greyscale (2 bytes) and RGB (6 bytes).
  let keyGrey = -1;
  let keyRgb = null;
  if (trns && colorType === 0 && trns.length >= 2) keyGrey = trns.readUInt16BE(0);
  if (trns && colorType === 2 && trns.length >= 6) keyRgb = [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)];

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);

  // Inflate no further than the IHDR's scanlines (plus INFLATE_SLACK): a small
  // IDAT that inflates past them is refused before the excess is allocated.
  const maxOutputLength = Math.min((stride + 1) * height + INFLATE_SLACK, buffer.constants.MAX_LENGTH);
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength }); }
  catch (e) {
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new PngError('IDAT inflates past the size IHDR declares');
    throw new PngError(`bad IDAT stream: ${e.message}`);
  }
  if (raw.length < (stride + 1) * height) throw new PngError('IDAT holds fewer scanlines than IHDR declares');

  const entries = plte ? plte.length / 3 : 0;
  const maxSample = (1 << Math.min(depth, 8)) - 1; // for scaling a sub-byte sample up to 8 bits
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const cur = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    unfilter(raw[at], cur, prev, bpp);
    const row = y * width * 4;
    if (colorType === 6 && depth === 8) {
      cur.copy(out, row);
    } else if (colorType === 2 || colorType === 6) {
      // RGB 8, RGB 16 or RGBA 16: each sample's high byte.
      const step = depth >> 3;
      for (let x = 0, s = 0, d = row; x < width; x++, d += 4) {
        const r = s; const g = s + step; const b = s + 2 * step;
        out[d] = cur[r]; out[d + 1] = cur[g]; out[d + 2] = cur[b];
        if (colorType === 6) {
          out[d + 3] = cur[s + 3 * step];
        } else if (keyRgb && (step === 2
          ? cur.readUInt16BE(r) === keyRgb[0] && cur.readUInt16BE(g) === keyRgb[1] && cur.readUInt16BE(b) === keyRgb[2]
          : cur[r] === keyRgb[0] && cur[g] === keyRgb[1] && cur[b] === keyRgb[2])) {
          out[d + 3] = 0;
        } else {
          out[d + 3] = 255;
        }
        s += channels * step;
      }
    } else if (colorType === 4) {
      // Grey + alpha, 8 or 16.
      const step = depth >> 3;
      for (let x = 0, s = 0, d = row; x < width; x++, s += 2 * step, d += 4) {
        out[d] = out[d + 1] = out[d + 2] = cur[s];
        out[d + 3] = cur[s + step];
      }
    } else {
      // Greyscale (0) or palette (3): one sample per pixel, packed MSB first
      // when the depth is under 8.
      for (let x = 0, d = row; x < width; x++, d += 4) {
        let v;
        if (depth === 16) v = cur.readUInt16BE(x * 2);
        else if (depth === 8) v = cur[x];
        else {
          const bit = x * depth;
          v = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & maxSample;
        }
        if (colorType === 3) {
          if (v >= entries) throw new PngError(`palette index ${v} is outside the ${entries}-entry PLTE`);
          out[d] = plte[v * 3]; out[d + 1] = plte[v * 3 + 1]; out[d + 2] = plte[v * 3 + 2];
          out[d + 3] = trns && v < trns.length ? trns[v] : 255;
        } else {
          const g8 = depth === 16 ? v >> 8 : Math.round((v * 255) / maxSample);
          out[d] = out[d + 1] = out[d + 2] = g8;
          out[d + 3] = v === keyGrey ? 0 : 255;
        }
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

// pngSize(buf) → { width, height }, read from the IHDR chunk alone (the spec
// puts it first) without inflating anything — for a caller that hands the
// bytes on to another decoder (ffmpeg) and only needs to check the dimensions.
// Throws PngError when the bytes do not start like a PNG.
function pngSize(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('not a PNG (bad signature)');
  if (buf.length < 8 + 8 + 13 + 4 || buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new PngError('no IHDR chunk first');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// One chunk: its length, type, body and the CRC-32 of type + body.
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// encodePng(rgba, w, h) → PNG bytes: 8-bit RGBA (color type 6), no interlace,
// filter 0 on every scanline, deflate level 9. `rgba` is w*h*4 bytes.
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
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { decodePng, encodePng, pngSize, PngError, paeth, PNG_SIGNATURE: SIGNATURE };

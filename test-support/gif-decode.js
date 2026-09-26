// A GIF decoder for the tests — and ONLY for the tests.
//
// lib/core/gif.js writes GIFs; nothing in the package reads them. To prove the
// writer's output is a real GIF rather than merely self-consistent, the tests
// need a reader that shares no code with it: this one is written straight from
// the GIF89a spec (§17–§24 and Appendix F for LZW), and composites frames onto
// a canvas the way a viewer would, honouring disposal 1 and each frame's local
// colour table. It is deliberately forgiving of nothing: any structural surprise
// throws.

function decodeGif(buf) {
  let p = 0;
  const u8 = () => buf[p++];
  const u16 = () => { const v = buf[p] | (buf[p + 1] << 8); p += 2; return v; };
  const header = buf.toString('ascii', 0, 6);
  if (header !== 'GIF89a' && header !== 'GIF87a') throw new Error(`bad header ${JSON.stringify(header)}`);
  p = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); u8(); // background, aspect
  let globalTable = null;
  if (packed & 0x80) {
    const n = 1 << ((packed & 7) + 1);
    globalTable = buf.subarray(p, p + n * 3);
    p += n * 3;
  }

  const out = { header, width, height, loop: null, frames: [], trailer: false };
  const canvas = Buffer.alloc(width * height * 4);
  let gce = null;

  const readBlocks = () => {
    const parts = [];
    for (;;) {
      const n = u8();
      if (n === undefined) throw new Error('ran off the end inside sub-blocks');
      if (n === 0) break;
      parts.push(buf.subarray(p, p + n));
      p += n;
    }
    return Buffer.concat(parts);
  };

  while (p < buf.length) {
    const intro = u8();
    if (intro === 0x3b) { out.trailer = true; break; }
    if (intro === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        const len = u8();
        if (len !== 4) throw new Error('GCE length is not 4');
        const flags = u8();
        const delay = u16();
        const trans = u8();
        if (u8() !== 0) throw new Error('GCE not terminated');
        gce = { disposal: (flags >> 2) & 7, transparent: (flags & 1) ? trans : null, delay };
      } else if (label === 0xff) {
        const len = u8();
        const id = buf.toString('ascii', p, p + len);
        p += len;
        const data = readBlocks();
        if (id === 'NETSCAPE2.0' && data[0] === 1) out.loop = data[1] | (data[2] << 8);
      } else {
        readBlocks();
      }
      continue;
    }
    if (intro !== 0x2c) throw new Error(`unexpected block 0x${(intro || 0).toString(16)} at ${p - 1}`);
    const left = u16(); const top = u16(); const w = u16(); const h = u16();
    const fl = u8();
    if (fl & 0x40) throw new Error('interlaced frames are not expected');
    let table = globalTable;
    let tableSize = globalTable ? globalTable.length / 3 : 0;
    if (fl & 0x80) {
      tableSize = 1 << ((fl & 7) + 1);
      table = buf.subarray(p, p + tableSize * 3);
      p += tableSize * 3;
    }
    if (!table) throw new Error('frame has no colour table');
    const minCodeSize = u8();
    const data = readBlocks();
    const indices = lzwDecode(data, minCodeSize, w * h);
    if (indices.length !== w * h) throw new Error(`frame decoded to ${indices.length} pixels, expected ${w * h}`);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = indices[y * w + x];
        if (idx >= tableSize) throw new Error(`index ${idx} outside a ${tableSize}-entry table`);
        if (gce && gce.transparent === idx) continue;
        const o = ((top + y) * width + (left + x)) * 4;
        canvas[o] = table[idx * 3]; canvas[o + 1] = table[idx * 3 + 1]; canvas[o + 2] = table[idx * 3 + 2]; canvas[o + 3] = 255;
      }
    }
    out.frames.push({
      left, top, w, h, minCodeSize, tableSize,
      delay: gce ? gce.delay : 0,
      disposal: gce ? gce.disposal : 0,
      codes: indices.codes,
      image: Buffer.from(canvas),
    });
    gce = null;
  }
  return out;
}

// Appendix F LZW, decoder side. Returns the index array with `.codes` = how
// many codes were read (so a test can prove the table filled and was cleared).
function lzwDecode(data, minCodeSize, expect) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let table = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push(null, null);
    codeSize = minCodeSize + 1;
  };
  reset();
  const out = [];
  let bitPos = 0;
  let prev = null;
  let codes = 0;
  let clears = 0;
  const totalBits = data.length * 8;
  for (;;) {
    if (bitPos + codeSize > totalBits) throw new Error('LZW stream ended without an EOI code');
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const bit = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;
    codes++;
    if (code === clear) { reset(); prev = null; clears++; continue; }
    if (code === eoi) break;
    let entry;
    if (code < table.length && table[code]) entry = table[code];
    else if (code === table.length && prev) entry = prev.concat(prev[0]);
    else throw new Error(`bad LZW code ${code} (table ${table.length})`);
    for (const v of entry) out.push(v);
    if (prev && table.length < 4096) table.push(prev.concat(entry[0]));
    prev = entry;
    if (table.length === (1 << codeSize) && codeSize < 12) codeSize++;
    if (out.length > expect) throw new Error('LZW produced more pixels than the frame holds');
  }
  out.codes = codes;
  out.clears = clears;
  return out;
}

module.exports = { decodeGif, lzwDecode };

// CRC-32 and a store-only ZIP writer — the one home for both.
//
// Neither is a route concern, and both had been hand-copied. `crc32` existed
// twice (a table-free bitwise loop inside lib/server/routes/extensions.js and a
// table-driven copy in extensions/make-icons.js) for a checksum Node itself
// ships; the ZIP encoder sat inline in an Express route file where nothing could
// test it without standing up the router. Both are primitives, and this package
// keeps a primitive in exactly one place.
//
// The container is deliberately minimal — stored entries (no compression), no
// directory records, zeroed timestamps — because its whole job is to hand a
// browser an unpackable folder for a temporary-extension load. It is not a
// general archiver: no ZIP64, no encryption, no Unicode flag beyond the UTF-8
// bytes it writes. What it refuses to do is emit a header it knows is a lie,
// which is why the field guards below throw rather than truncate.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC-32 (the IEEE 802.3 polynomial), the checksum both a ZIP entry and a PNG
// chunk carry. Node exposes it natively from 22.2; the package floor is 22
// (lib/core/versions NODE_FLOOR), so the two point releases below it get a
// lazily-built table here rather than a floor bump nobody asked for. One home,
// one fallback — not a copy per caller.
let CRC_TABLE = null;
function crc32Fallback(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function'
  ? (buf) => zlib.crc32(buf) >>> 0
  : crc32Fallback;

// The 32-bit ceilings the format's fields impose. Past them a writer must move
// to ZIP64, and this one does not — so it says so instead of writing a wrapped
// value that unpacks as garbage a long way from here.
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

// Every regular file under `dir`, recursively, as {name, data} with forward-slash
// relative names. Sorted, so the same tree produces the same bytes on every OS
// (readdir order is not defined). Directories contribute nothing but their path
// prefix, and anything that is neither a directory nor a regular file — a
// symlink, a socket — is skipped: a store-only writer has nowhere to put it.
function collectEntries(dir) {
  const entries = [];
  const walk = (abs, rel) => {
    const kids = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of kids) {
      const child = path.join(abs, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(child, r);
      else if (e.isFile()) entries.push({ name: r, data: fs.readFileSync(child) });
    }
  };
  walk(dir, '');
  return entries;
}

// Pack a directory into a store-only ZIP and return the bytes.
function writeZipStore(dir) {
  const entries = collectEntries(dir);
  if (entries.length > U16_MAX) {
    throw new Error(`writeZipStore: ${entries.length} entries exceeds the ${U16_MAX} this writer can record (ZIP64 required)`);
  }

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    if (nameBuf.length > U16_MAX) throw new Error(`writeZipStore: entry name too long: ${e.name}`);
    const size = e.data.length;
    if (size > U32_MAX || offset > U32_MAX) {
      throw new Error(`writeZipStore: ${e.name} crosses the 4 GiB limit of a non-ZIP64 archive`);
    }
    const crc = crc32(e.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);     // local file header signature
    local.writeUInt16LE(20, 4);             // version needed
    local.writeUInt16LE(0, 6);              // flags
    local.writeUInt16LE(0, 8);              // method = store
    local.writeUInt16LE(0, 10);             // time
    local.writeUInt16LE(0, 12);             // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);          // compressed size
    local.writeUInt32LE(size, 22);          // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);             // extra length
    nameBuf.copy(local, 30);
    localChunks.push(local, e.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);   // central directory signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);           // extra length
    central.writeUInt16LE(0, 32);           // comment length
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralChunks.push(central);

    offset += local.length + e.data.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, centralBuf, end]);
}

module.exports = { writeZipStore, crc32 };

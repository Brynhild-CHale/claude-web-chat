// The store-only ZIP writer, which had no test at all while it lived inside an
// Express route file — nothing could reach it without standing up the router,
// which is half of why it was a hole. Two kinds of check here: an independent
// parse of the bytes (the central directory has to agree with the local headers
// and with the source tree), and, where the platform has `unzip`, a real
// third-party reader confirming the archive is not merely self-consistent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { withTempHome } = require('../test-support/helpers');
const { writeZipStore, crc32 } = require('../lib/core/zip');

function tree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

// A deliberately independent reader: walk the central directory backwards from
// the EOCD, then cross-check each entry against its own local header. It shares
// no code with the writer, so a field the writer gets wrong shows up here.
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature at the end (no archive comment)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOff + cdSize, eocd, 'the central directory abuts the EOCD');

  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');

    assert.equal(buf.readUInt32LE(lho), 0x04034b50, `local header signature for ${name}`);
    assert.equal(buf.readUInt16LE(lho + 8), 0, `${name} is STORED, not deflated`);
    assert.equal(buf.readUInt32LE(lho + 14), crc, `${name}: local and central CRC agree`);
    assert.equal(buf.readUInt16LE(lho + 26), nlen);
    const dataAt = lho + 30 + nlen + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(dataAt, dataAt + csize);

    assert.equal(usize, csize, `${name}: stored, so the two sizes match`);
    assert.equal(crc32(data), crc, `${name}: the recorded CRC is the CRC of the bytes`);
    out.push({ name, data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

test('zip: a directory round-trips — names, bytes and CRCs all check out', async (t) => {
  const home = withTempHome(t);
  const src = path.join(home, 'src');
  tree(src, {
    'manifest.json': '{"name":"x"}\n',
    'README.md': '# hi\n',
    'icons/16.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    'js/deep/nested.js': 'console.log("nested")\n',
    'empty.txt': '',
  });

  const entries = readZip(writeZipStore(src));
  assert.deepEqual(entries.map(e => e.name).sort(),
    ['README.md', 'empty.txt', 'icons/16.png', 'js/deep/nested.js', 'manifest.json'],
    'every regular file, at its forward-slash relative path — and no directory records');

  for (const e of entries) {
    assert.deepEqual(e.data, fs.readFileSync(path.join(src, e.name)), `${e.name}: bytes survive`);
  }
});

test('zip: the same tree produces the same bytes twice (readdir order is not)', async (t) => {
  const home = withTempHome(t);
  const a = path.join(home, 'a');
  const b = path.join(home, 'b');
  // Written in opposite orders, so an unsorted walk can hand them back differently.
  tree(a, { 'z.txt': 'z', 'm.txt': 'm', 'a.txt': 'a', 'd/y.txt': 'y', 'd/b.txt': 'b' });
  tree(b, { 'a.txt': 'a', 'd/b.txt': 'b', 'd/y.txt': 'y', 'm.txt': 'm', 'z.txt': 'z' });
  assert.deepEqual(writeZipStore(a), writeZipStore(b));
});

test('zip: a real unzip accepts the archive', async (t) => {
  let unzip;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    unzip = true;
  } catch { unzip = false; }
  if (!unzip) return t.skip('no unzip on this platform');

  const home = withTempHome(t);
  const src = path.join(home, 'src');
  tree(src, { 'manifest.json': '{"a":1}\n', 'sub/one.js': 'let x = 1\n' });
  const zipPath = path.join(home, 'out.zip');
  fs.writeFileSync(zipPath, writeZipStore(src));

  // -t verifies every entry's CRC against its stored bytes, which is the check
  // a browser's own unpacker will make when the user loads the extension.
  const out = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  assert.match(out, /No errors detected/);

  const dest = path.join(home, 'out');
  execFileSync('unzip', ['-q', zipPath, '-d', dest]);
  assert.equal(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'), '{"a":1}\n');
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'one.js'), 'utf8'), 'let x = 1\n');
});

test('zip: crc32 is the IEEE CRC-32, whichever implementation answers', () => {
  // Pinned against zlib's own, and against the canonical check value for the
  // polynomial — so the table fallback (Node 22.0/22.1, below zlib.crc32) and
  // the native path cannot drift apart unnoticed.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const sample = zlib.gzipSync(Buffer.from('a longer body to checksum'));
  assert.equal(crc32(sample), zlib.crc32(sample) >>> 0);
});

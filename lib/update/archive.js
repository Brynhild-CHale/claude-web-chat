// The ONE place this package shells out to `tar`.
//
// Extracted from lib/update/release.js, which held the single `spawnSync('tar')`
// and its ENOENT message. Pack fetching needs the same primitive, and a second
// hand-rolled `tar` invocation would be mechanism N+1 — with its own idea of
// which flags are portable and its own (or absent) error message. So the
// invocation lives here, `release.unpackTarball` is a thin wrapper that keeps its
// own "is this actually a release?" assertion, and lib/packs/fetch.js consumes
// the same function.
//
// Portability note: GNU tar and BSD tar both read the plain ustar that
// scripts/build-release.js writes, and both accept `-xzf` / `--strip-components`
// / `-C`. Nothing fancier than that is used here on purpose.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

// Extract a .tar.gz into `dest` (created if missing). `strip` maps to
// --strip-components; 0 (the default) keeps the archive's own prefix directory,
// which is what a pack fetch wants — see rootOf below.
function extractTarGz(tarball, dest, { strip = 0 } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const args = ['-xzf', tarball];
  if (strip > 0) args.push('--strip-components', String(strip));
  args.push('-C', dest);
  const r = spawnSync('tar', args, { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('`tar` is not installed — it is needed to unpack an archive');
  }
  if (r.status !== 0) {
    throw new Error(`tar failed (${r.status}): ${(r.stderr || '').trim()}`);
  }
  return dest;
}

// A GitHub `/archive/<sha>.tar.gz` unpacks to exactly one top-level directory
// named `<repo>-<sha>`, whose name a caller cannot predict. Rather than guess
// (or blindly --strip-components 1, which silently flattens a tarbomb), extract
// with strip 0 and ask what the single root is.
//
// Returns the absolute path of that lone directory, or `dir` itself when the
// archive had no single wrapper (several top-level entries, or a file at top
// level). Never throws on a missing dir — returns `dir`.
function rootOf(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return dir; }
  const visible = entries.filter((e) => e.name !== '.DS_Store');
  if (visible.length === 1 && visible[0].isDirectory()) return path.join(dir, visible[0].name);
  return dir;
}

// ─────────────────────────────────────────────────────────── reading members ──
// A pure-JS LISTER (not a second extractor). It exists because "which members
// does this archive contain, and of what type?" must be answered BEFORE
// extraction and must answer the same way on every platform.
//
// BSD tar refuses a `..` member outright; GNU tar historically strips the
// leading `../` and carries on. Both are safe, neither is a contract, and
// "refused" vs "silently renamed" is exactly the distinction a pack install
// needs to make. So the decision is ours: list first, refuse on our own terms,
// and only then hand the file to `tar`.
//
// Returns [{ name, type, size }] where type is 'file' | 'dir' | 'link' |
// 'other'. Extended headers (pax 'x'/'g', GNU 'L') are consumed and applied to
// the entry they describe rather than reported, so a long or pax-overridden
// path is listed under the name it will actually extract to — which is the
// whole point of listing.
const BLOCK = 512;

// The ceiling on what an archive may inflate to. lib/packs/fetch.js caps the
// DOWNLOAD at 64 MB, which bounds nothing here: deflate compresses a run of
// zeros at roughly 1000:1, so a 64 MB body expands to tens of gigabytes, and
// Buffer.MAX_LENGTH is 2^53-1 — nothing refuses that allocation, so the process
// is OOM-killed rather than throwing something a caller could catch. This runs
// in the DAEMON, on an install endpoint any pane can reach, so the failure mode
// is "the process holding the live graph disappears".
//
// 256 MB is 4x the download cap: comfortably more than any real pack and far
// below what a bomb wants. It bounds extraction too — stagePack lists before it
// hands the file to `tar`, and the inflated stream measured here is exactly the
// bytes tar would write.
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

// ustar stores numbers as NUL-terminated octal. GNU tar encodes a value too
// large for the field (>8 GB for a size) in "base-256": the high bit of the
// first byte is set and the rest is a big-endian integer.
//
// Reading such a field as octal yields 0, and a 0-length member makes the walker
// treat that member's DATA as the next header — every offset after it is wrong,
// and the listing stops describing the archive. Since the listing IS the
// pre-extraction security gate, a desynced one is a hole, not a cosmetic bug. A
// pack has no business shipping an 8 GB file, so the honest answer is to refuse
// the archive rather than to grow a second number format.
function readOctal(buf, off, len) {
  if (buf[off] & 0x80) {
    const e = new Error('archive uses GNU base-256 number fields (a member larger than 8 GB) — refusing to read it');
    e.userFacing = true;
    throw e;
  }
  const s = buf.toString('ascii', off, off + len).replace(/\0.*$/, '').trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function typeOf(flag) {
  if (flag === '0' || flag === '\0' || flag === '') return 'file';
  if (flag === '5') return 'dir';
  if (flag === '1' || flag === '2') return 'link';   // hard link / symlink
  return 'other';                                     // char/block/fifo/contiguous
}

// The `path=` record of a pax extended header. Records are
// "<len> <key>=<value>\n" — a malicious archive can hide a traversal here, so
// it is parsed rather than ignored.
function paxPath(buf) {
  const text = buf.toString('utf8');
  const re = /(\d+) ([^=]+)=([\s\S]*?)\n/g;
  let m;
  let found = null;
  while ((m = re.exec(text))) {
    if (m[2] === 'path') found = m[3];
  }
  return found;
}

function listTarGz(tarball, { maxBytes = MAX_INFLATED_BYTES } = {}) {
  let buf;
  try {
    buf = zlib.gunzipSync(fs.readFileSync(tarball), { maxOutputLength: maxBytes });
  } catch (err) {
    // zlib reports the ceiling as RangeError ERR_BUFFER_TOO_LARGE. Said in our
    // own words, and flagged userFacing, so it reads as a refusal rather than
    // an internal allocation failure.
    if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
      const e = new Error(`archive inflates to more than ${Math.round(maxBytes / (1024 * 1024))} MB — refusing to read it`);
      e.userFacing = true;
      throw e;
    }
    throw err;
  }
  const out = [];
  let off = 0;
  let nextName = null;   // pending pax/GNU long-name override
  while (off + BLOCK <= buf.length) {
    const head = buf.subarray(off, off + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop us.
    if (head.every((b) => b === 0)) break;
    const rawName = head.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = head.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const size = readOctal(head, 124, 12);
    const flag = head.toString('ascii', 156, 157);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    const padded = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === 'x' || flag === 'g') {
      const p = paxPath(buf.subarray(dataStart, dataEnd));
      if (flag === 'x' && p) nextName = p;
      off = padded;
      continue;
    }
    if (flag === 'L') {
      nextName = buf.toString('utf8', dataStart, dataEnd).replace(/\0.*$/, '');
      off = padded;
      continue;
    }
    if (flag === 'K') { off = padded; continue; }   // GNU long LINK name — not the member's path

    const name = nextName != null ? nextName : (prefix ? `${prefix}/${rawName}` : rawName);
    nextName = null;
    out.push({ name, type: typeOf(flag), size });
    off = padded;
  }
  return out;
}

module.exports = { extractTarGz, rootOf, listTarGz, MAX_INFLATED_BYTES };

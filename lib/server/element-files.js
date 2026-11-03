'use strict';
// Read a listed element type's file (annotation engine tranche 4, U511;
// PLAN.md 4A.1 and 4A.2; DECISIONS.md B1 review-approve and B3 fenced-route).
//
//   readFenced(ctx, row, rel, max, {noun?, fileNoun?})
//        → {bytes, sha256}, or throws TypeFileRefusal
//     The ONE fenced read of a file inside a listed type's installed directory
//     (ctx.elementTypes.dirOf), shared by the toolbar's icon route
//     (routes/toolbar.js readIcon) and the element-type file route
//     (routes/element-files.js, through readTypeFile):
//       - the path is fenced inside the directory (lib/core/paths fence and
//         isInside), and is never the directory itself;
//       - no segment from the directory down may be a link (an lstat walk);
//       - the file is opened without following a link (READ_FLAGS: O_RDONLY |
//         O_NOFOLLOW | O_NONBLOCK) and must be a regular file of at most `max`
//         bytes (fstat on the open descriptor);
//       - its bytes' sha256 must equal every digest recordedDigests answers —
//         the pack record's for that unit file and, for a project install,
//         this machine's ledger entry's — else 403 "changed on disk since the
//         pack was reviewed". Re-run on EVERY read: the registry caches its
//         listing until a `packs` event, so the bytes on disk can change after
//         a type lists; nothing here keeps bytes across reads.
//     `noun` / `fileNoun` word the refusals ('the file' by default; the icon
//     route passes 'the icon' / 'the icon file', its answers unchanged).
//
//   readTypeFile(ctx, type, rel) → {bytes, sha256, type, kind}, or throws
//     TypeFileRefusal. `rel` is 'draw.js' or 'assets/<…>.<ext>'
//     (lib/core/element-assets mediaOf). The type must be one the registry
//     lists (isSafeId, then ctx.elementTypes.descriptor: an unreviewed,
//     quarantined, pending, forged or drifted type is 404) and not a built-in
//     (a built-in draws from the chrome's own modules: 404 with that hint);
//     then mediaOf, readFenced at element-assets FILE_MAX, and element-assets
//     sniff. The reader the route serves from and a document inlines from
//     (U521): no second reader of a type's files is written anywhere.
//
//   drawDigest(ctx, row) → the sha256 the records hold for the type's draw.js
//     (every recorded digest equal), or null — the listing's `draw.sha256`
//     (routes/element-types.js), read through recordedDigests so the listing
//     and the route's ETag can never disagree.
//
//   TypeFileRefusal {status, why, hint}: the route answers {ok: false, error:
//     why, hint} with `status`.
//
// Writes nothing, caches nothing, adds no ctx member. Nothing here evals or
// loads a pack's code (B1): it hands bytes to a route.

const fs = require('fs');
const path = require('path');

const { fence, isInside, isSafeId } = require('../core/paths');
const { mediaOf, sniff, FILE_MAX, DRAW_FILE, ALLOWED_HINT } = require('../core/element-assets');
const { findPack, findLedgerEntry, sha256 } = require('../packs/store');
const { unitsOf } = require('../packs/kinds');

const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

const HINTS = Object.freeze({
  unlisted: 'only an element type installed through pack review and approve, and listed by GET /api/elements/types, has files to serve',
  builtin: "a built-in type draws from the chrome's own modules",
  allowed: ALLOWED_HINT,
  reviewed: 'only the bytes the pack was reviewed with are served: reinstall the pack through review and approve (claude-web-chat pack get, pack review, pack approve)',
  cap: `a type's file is at most ${FILE_MAX} bytes`,
});

class TypeFileRefusal extends Error {
  constructor(status, why, hint = null) {
    super(why);
    this.status = status;
    this.why = why;
    this.hint = hint;
  }
}

// The digests the pack's record (and, for a project install, the ledger) hold
// for one file of a type's unit. Every one must equal the bytes served.
function recordedDigests(ctx, row, rel) {
  const unitOf = (rec) => unitsOf(rec && rec.units, 'element').find((u) => u.name === row.type) || null;
  const digestOf = (unit) => {
    const f = unit && Array.isArray(unit.files) ? unit.files.find((x) => x && x.path === rel) : null;
    return f && typeof f.sha256 === 'string' ? f.sha256 : null;
  };
  const found = findPack(ctx.root, row.pack, row.tier);
  const out = [digestOf(unitOf(found && found.pack))];
  if (row.tier === 'local') out.push(digestOf(unitOf(findLedgerEntry(ctx.root, row.pack))));
  return out;
}

// The files a type's unit records in its install record (the project's or
// the system tier's packs.json), [] when there is none: the one lookup of a
// type's recorded files (document-elements typeRecordOf reads its asset list
// through it, U590 / engineering contract (g)).
function typeFiles(ctx, row) {
  if (!row || row.builtin) return [];
  const found = findPack(ctx.root, row.pack, row.tier);
  const unit = unitsOf(found && found.pack && found.pack.units, 'element').find((u) => u.name === row.type) || null;
  return unit && Array.isArray(unit.files) ? unit.files : [];
}

function drawDigest(ctx, row) {
  if (!row || row.builtin) return null;
  let digests;
  try { digests = recordedDigests(ctx, row, DRAW_FILE); } catch { return null; }
  const first = digests[0];
  return typeof first === 'string' && digests.every((d) => d === first) ? first : null;
}

function readFenced(ctx, row, rel, max, { noun = 'the file', fileNoun = noun } = {}) {
  const dir = ctx.elementTypes && row ? ctx.elementTypes.dirOf(row.type) : null;
  const abs = dir ? fence(dir, rel) : null;
  if (!abs || abs === path.resolve(dir) || !isInside(dir, abs)) {
    throw new TypeFileRefusal(403, `${noun} is outside its type's directory`, HINTS.reviewed);
  }
  // No segment from the type's directory down may be a link.
  let cur = path.resolve(dir);
  for (const seg of path.relative(cur, abs).split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch { throw new TypeFileRefusal(404, `${fileNoun} is missing`, HINTS.reviewed); }
    if (st.isSymbolicLink()) throw new TypeFileRefusal(403, `${noun} is a link`, HINTS.reviewed);
  }
  let fd;
  try { fd = fs.openSync(abs, READ_FLAGS); } catch {
    throw new TypeFileRefusal(403, `${noun} could not be opened without following a link`, HINTS.reviewed);
  }
  let bytes;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new TypeFileRefusal(403, `${noun} is not a regular file`, HINTS.reviewed);
    if (st.size > max) throw new TypeFileRefusal(403, `${noun} is over ${max} bytes`, HINTS.cap);
    bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < bytes.length) {
      const n = fs.readSync(fd, bytes, off, bytes.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    bytes = bytes.subarray(0, off);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  const digest = sha256(bytes);
  const recorded = recordedDigests(ctx, row, rel);
  if (!recorded.every((d) => d === digest)) {
    throw new TypeFileRefusal(403, `${noun} changed on disk since the pack was reviewed`, HINTS.reviewed);
  }
  return { bytes, sha256: digest };
}

function readTypeFile(ctx, type, rel) {
  const row = isSafeId(type) && ctx.elementTypes ? ctx.elementTypes.descriptor(type) : null;
  if (!row) throw new TypeFileRefusal(404, 'no listed element type by that name', HINTS.unlisted);
  if (row.builtin) throw new TypeFileRefusal(404, `'${row.type}' is a built-in type and has no files to serve`, HINTS.builtin);
  const media = mediaOf(rel);
  if (media.refused) throw new TypeFileRefusal(403, media.refused, HINTS.allowed);
  const { bytes, sha256: digest } = readFenced(ctx, row, rel, FILE_MAX);
  const why = sniff(bytes, media);
  if (why) throw new TypeFileRefusal(403, `the file is refused: ${why}`, media.kind === 'draw' ? HINTS.reviewed : HINTS.allowed);
  return { bytes, sha256: digest, type: media.type, kind: media.kind };
}

module.exports = { readTypeFile, readFenced, recordedDigests, drawDigest, typeFiles, TypeFileRefusal, READ_FLAGS };

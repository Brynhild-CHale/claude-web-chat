// lib/server/routes/attachments.js — an image the user adds in the composer
// (spec §15.7, U91).
//
//   POST /api/attachments   body = the raw image, Content-Type image/png,
//                           image/jpeg, image/gif or image/webp
//     → {ok: true, path: '.web-chat/attachments/<yyyymmdd>-<8 hex>.<ext>', bytes, type}
//     | {ok: false, refused, hint} with the 4xx status:
//         403 origin       an Origin that is not one of this machine's surfaces
//         403 (audience)   a remote viewer below level `full` (requireMirror)
//         415 type         a Content-Type outside the four, or bytes that are
//                          not what it says (sniffed)
//         400 empty        no bytes
//         413 too_large    over ATTACHMENT_MAX_BYTES
//         429 rate_limited over ATTACHMENTS_RATE_MAX a minute (retry_after)
//         400 unreadable   a body that could not be read
//
// The image is named in the message BY PATH, for Claude to Read (Q5: a path,
// never content — the bytes never ride a message, a park or a wake). There is
// no GET: the bytes are never served back; the chrome previews the user's own
// File object.
//
// CLASS P3 (§5.7): a surface action, reachable by a pane's fetch like the
// queue's message route. A cross-origin page cannot reach it without a
// preflight — an image Content-Type is not a CORS-simple one, and nothing
// answers the preflight — and a foreign Origin is refused here as the queue's
// write guard refuses it; a rate limit bounds what a pane can write; and
// remotely it needs mirror level `full` (remote-policy's RULES row, and this
// daemon's own lock behind the portal's table).
//
// ON DISK: written through lib/core/fsjson writeFileAtomic under
// projectPaths(root).attachmentsDir (created on demand under the existing
// .web-chat, as the mirror's writers create theirs), the target fenced with
// lib/core/paths fence. After each save the directory keeps the newest
// ATTACHMENTS_KEEP images; older copies are deleted then, with no timer
// (ruled D6 (a), U91@attachments-policy). Only names of the attachment
// grammar are ever pruned.
//
// withAttachments(projectFiles, {root}) → the `@` index adapter the composer's
// validation checks files through (lib/server/composer.js), answering for a
// saved attachment's path itself — the index never lists .web-chat (its walk
// skips it; git ignores it) — and delegating every other path, and search,
// refresh and stop, to the real index. U94a sets it as ctx.projectFiles, so
// the message's File line names the image.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectPaths, fence } = require('../../core/paths');
const { writeFileAtomic } = require('../../core/fsjson');
const { isLocalOrigin } = require('../../core/cors');
const { PNG_SIGNATURE } = require('../../core/png');
const { createRateLimit } = require('../composer');
const { rawBodyReader } = require('./brand');

const ATTACHMENTS_ROUTE = '/api/attachments';
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENTS_KEEP = 50;
const ATTACHMENTS_RATE_MAX = 20;
const ATTACHMENTS_RATE_WINDOW_MS = 60000;
// The declared type → the sniffed format and the file's extension.
const TYPES = Object.freeze({
  'image/png': { kind: 'png', ext: 'png' },
  'image/jpeg': { kind: 'jpeg', ext: 'jpg' },
  'image/gif': { kind: 'gif', ext: 'gif' },
  'image/webp': { kind: 'webp', ext: 'webp' },
});
const ATTACHMENT_TYPES = Object.freeze(Object.keys(TYPES));
// A saved attachment as the message names it (relative to the project root).
const ATTACHMENT_RE = /^\.web-chat\/attachments\/\d{8}-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;
// A saved attachment's file name: the only names the prune ever touches.
const NAME_RE = /^\d{8}-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;

const HINTS = Object.freeze({
  origin: 'this request came from a page that is not the web-chat surface — add the image from the surface itself',
  type: 'add a PNG, JPEG, GIF or WebP image',
  mismatch: 'the file is not the image its type says — add a PNG, JPEG, GIF or WebP image',
  empty: 'the image is empty',
  too_large: `an image is at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB`,
  rate_limited: 'too many images in the last minute: wait a moment and try again',
  unreadable: 'the image could not be read: try adding it again',
  unavailable: 'the image could not be saved in this project',
});

const refusal = (res, status, refused, extra = {}) => res.status(status).json({ ok: false, refused, hint: HINTS[refused], ...extra });

// ── sniffing ────────────────────────────────────────────────────────────────

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
// A GIF's six header bytes, 'G' 'I' 'F' '8', then '7' or '9', then 'a',
// compared as bytes. Reading a header writes no GIF, so the GIF writer's
// signature ratchet (test/conventions.test.js, home lib/core/gif.js) is
// never spelled here.
const GIF_LEAD = Buffer.from([0x47, 0x49, 0x46, 0x38]);
const GIF_VERSIONS = new Set([0x37, 0x39]);
const GIF_TAIL = 0x61;
const RIFF = Buffer.from('RIFF', 'latin1');
const WEBP = Buffer.from('WEBP', 'latin1');

const startsWith = (buf, magic, at = 0) => buf.length >= at + magic.length && buf.subarray(at, at + magic.length).equals(magic);

// Which image format these bytes are: 'png' | 'jpeg' | 'gif' | 'webp' | null.
// Pure: the leading bytes only.
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (startsWith(buf, PNG_SIGNATURE)) return 'png';
  if (startsWith(buf, JPEG_MAGIC)) return 'jpeg';
  if (buf.length >= 6 && startsWith(buf, GIF_LEAD) && GIF_VERSIONS.has(buf[4]) && buf[5] === GIF_TAIL) return 'gif';
  if (startsWith(buf, RIFF) && startsWith(buf, WEBP, 8)) return 'webp';
  return null;
}

// ── saving and pruning ──────────────────────────────────────────────────────

function stamp(t) {
  const d = new Date(t);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
}

// The relative POSIX path the message names, for a name in attachmentsDir.
function relOf(root, name) {
  return path.relative(root, path.join(projectPaths(root).attachmentsDir, name)).split(path.sep).join('/');
}

// The newest ATTACHMENTS_KEEP attachment files stay; the rest are deleted.
// Newest by mtime, then by name. Only regular files of the name grammar count.
function prune(dir, keep = ATTACHMENTS_KEEP) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const rows = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    let st;
    try { st = fs.lstatSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    rows.push({ name, at: st.mtimeMs });
  }
  if (rows.length <= keep) return 0;
  rows.sort((a, b) => (b.at - a.at) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  let gone = 0;
  for (const r of rows.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, r.name)); gone += 1; } catch {}
  }
  return gone;
}

// Save the bytes under a fresh name → {name, rel} or null when the target is
// outside the fence or the write fails.
function save(root, bytes, ext, now) {
  const dir = projectPaths(root).attachmentsDir;
  for (let i = 0; i < 4; i += 1) {
    const name = `${stamp(now())}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const rel = relOf(root, name);
    const abs = fence(root, rel);
    if (!abs) return null;
    if (fs.existsSync(abs)) continue;
    writeFileAtomic(abs, bytes);
    return { name, rel, dir };
  }
  return null;
}

// ── the route ───────────────────────────────────────────────────────────────

function mountAttachmentRoutes(app, ctx, { now = Date.now, rateMax = ATTACHMENTS_RATE_MAX, keep = ATTACHMENTS_KEEP } = {}) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    throw new TypeError('mountAttachmentRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  const root = ctx.root;
  if (typeof root !== 'string' || !root) throw new TypeError('mountAttachmentRoutes needs ctx.root');
  const rate = createRateLimit({ max: rateMax, windowMs: ATTACHMENTS_RATE_WINDOW_MS, now });

  // §5.7 P3's local-Origin rule (routes/queue.js's write guard): no Origin — a
  // local process, a test — passes; the portal rewrites a remote viewer's.
  const localOrigin = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) return refusal(res, 403, 'origin');
    next();
  };
  // A Content-Type outside the four is refused before a byte is read, and
  // before the rate limit is spent.
  const imageType = (req, res, next) => {
    if (!req.is(ATTACHMENT_TYPES)) return refusal(res, 415, 'type');
    next();
  };
  const limited = (req, res, next) => {
    const taken = rate.take();
    if (!taken.ok) return refusal(res, 429, 'rate_limited', { retry_after: taken.retry_after });
    next();
  };
  const readBody = rawBodyReader({
    types: ATTACHMENT_TYPES,
    maxBytes: ATTACHMENT_MAX_BYTES,
    refuse(res, why, status) {
      if (why === 'too-large') return refusal(res, 413, 'too_large', { max: ATTACHMENT_MAX_BYTES });
      // The type was checked above, so no Buffer here is no body at all.
      if (why === 'type') return refusal(res, 400, 'empty');
      return refusal(res, status >= 400 && status < 500 ? status : 400, 'unreadable');
    },
  });

  app.post(ATTACHMENTS_ROUTE, localOrigin, audience.requireMirror('full'), imageType, limited, readBody, (req, res) => {
    const bytes = req.body;
    if (!bytes.length) return refusal(res, 400, 'empty');
    if (bytes.length > ATTACHMENT_MAX_BYTES) return refusal(res, 413, 'too_large', { max: ATTACHMENT_MAX_BYTES });
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const want = TYPES[declared];
    if (!want || sniffImage(bytes) !== want.kind) return refusal(res, 415, 'mismatch');
    let saved = null;
    try { saved = save(root, bytes, want.ext, now); } catch { saved = null; }
    if (!saved) return refusal(res, 500, 'unavailable');
    prune(saved.dir, keep);
    res.json({ ok: true, path: saved.rel, bytes: bytes.length, type: declared });
  });
}

// ── the `@` index adapter ───────────────────────────────────────────────────

function withAttachments(projectFiles, { root } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('withAttachments needs { root }');
  const base = projectFiles && typeof projectFiles === 'object' ? projectFiles : {};
  const out = {};
  for (const k of ['search', 'refresh', 'stop']) {
    if (typeof base[k] === 'function') out[k] = (...args) => base[k](...args);
  }
  out.check = (rel) => {
    if (typeof rel !== 'string' || !ATTACHMENT_RE.test(rel)) {
      return typeof base.check === 'function' ? base.check(rel) : { ok: false, why: 'unavailable' };
    }
    const abs = fence(root, rel);
    if (!abs) return { ok: false, why: 'outside' };
    let st;
    try { st = fs.lstatSync(abs); } catch { return { ok: false, why: 'missing' }; }
    if (st.isSymbolicLink()) return { ok: false, why: 'symlink' };
    if (!st.isFile()) return { ok: false, why: 'not-a-file' };
    return { ok: true, path: rel, bytes: st.size };
  };
  return out;
}

module.exports = {
  mountAttachmentRoutes,
  withAttachments,
  sniffImage,
  ATTACHMENTS_ROUTE,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_KEEP,
  ATTACHMENTS_RATE_MAX,
  ATTACHMENT_TYPES,
  ATTACHMENT_RE,
};

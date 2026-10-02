// lib/core/image-file.js — the one store for a logo-type image under .web-chat/.
//
// A brand slot (.web-chat/brand/themes/<key>/<slot>, lib/server/brand.js) and
// each of a project's identity images (.web-chat/project-logo and the rest,
// lib/core/project-identity) are the same kind of thing on disk: ONE file,
// `<base>.svg` or `<base>.png`, that passed lib/core/brand-image's validate()
// when it was written and is served as an image. This module is that file:
//
//   imageFile(root, base) → { locate, read, meta, write, remove }
//
// `base` is an ABSOLUTE path without an extension, minted by lib/core/paths or
// lib/core/brand-store — never built from request text. Every path is fenced to
// projectPaths(root).dir: the folder the image lives in must be inside
// .web-chat/, by real path, so a folder that is (or is reached through) a link
// out of the project is never read, written or cleared.
//
// THE FILE ITSELF IS NEVER A LINK. .web-chat/ can be committed, so what is in it
// is whatever the repository shipped:
//
//   - locate() uses lstat: a symlink at `<base>.<ext>` is skipped (and logged
//     once), wherever it points — inside .web-chat/ or out of it, dangling or
//     not. Only a regular file is an image. (Brand slot files that are links
//     stopped being served when the slots moved onto this module, deliberately.)
//   - read() opens with O_NOFOLLOW, re-checks that what it opened is a regular
//     file within the size limit, and re-sniffs the bytes: a file whose format
//     is not what its extension says reads as null. (The active-SVG refusal is
//     write()'s, as it always was: the bytes are only ever served as an image —
//     an <img>, or a document under BRAND_CSP — where an SVG runs nothing.)
//   - write() goes through validate() and lib/core/fsjson writeFileAtomic,
//     whose temp file is created exclusively and renamed into place: a link at
//     the destination is REPLACED, never written through. A repository that
//     ships `project-logo.png -> graph/_meta.json` gets its link swapped for
//     the user's upload, and graph state is untouched. Then the other format is
//     unlinked, so an image is always one file.
//   - remove() unlinks both formats; unlink removes a link, never its target.
//
// If a crash (or a hand edit) left both formats behind, the newer one wins.
//
// meta() is what a chrome needs to show and cache-bust the image: its type,
// size, a version that changes whenever the file does (`<mtime ms>-<size>`), and
// its width and height — from the PNG's IHDR, or the SVG's viewBox — or null
// when they cannot be read (an SVG with no viewBox). imageSize(bytes) is the
// same measurement for bytes not yet written, so a caller that refuses a shape
// (a favicon that is not square) measures exactly as the store will.
//
// Imports only fs, path and lib/core (paths, fsjson, brand-image, png).

const fs = require('fs');
const path = require('path');
const { projectPaths, fence } = require('./paths');
const { writeFileAtomic } = require('./fsjson');
const { MAX_BYTES, TYPES, BrandError, sniff, validate } = require('./brand-image');
const { pngSize } = require('./png');

// The formats an image may be stored in, by extension.
const EXTS = Object.freeze(Object.keys(TYPES));

// Open for reading without following a link at the last component, and
// without blocking should a FIFO have been swapped in after locate()'s lstat
// (fstat then says it is not a file). Where the platform has no O_NOFOLLOW the
// lstat in locate() is the only guard.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

// One log line per problem per version of a file, not one per request.
const warned = new Set();
function warnOnce(log, file, stat, why) {
  const key = `${file}|${stat.ino}|${stat.mtimeMs}|${stat.size}|${why}`;
  if (warned.has(key)) return;
  warned.add(key);
  try { log(`web-chat: ignoring image ${file}: ${why}`); } catch {}
}

// ── measuring ───────────────────────────────────────────────────────────────

// A viewBox number: SVG's grammar, so nothing Number() alone would also take
// (hex, Infinity, an empty string). Written so no two parts of it can claim
// the same digits — a long run of them that fails at its end is one pass, not
// a quadratic backtrack — and capped in length besides.
const SVG_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SVG_NUMBER_MAX = 40;

// The index just past the `>` that closes the markup starting at `from`, quotes
// respected, with `[`…`]` nesting when `brackets` (a DOCTYPE's internal
// subset); -1 when it never closes.
function closeOf(text, from, { brackets = false } = {}) {
  let quote = null;
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (brackets && c === '[') depth++;
    else if (brackets && c === ']') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i + 1;
  }
  return -1;
}

// The root <svg> element's viewBox width and height, or null. The root is the
// first element after the prolog sniff() allows (an XML declaration, comments,
// a DOCTYPE), found by a linear scan rather than a regex over the whole text,
// so no file can make it slow.
function svgSize(bytes) {
  const text = bytes.toString('utf8');
  let at = 0;
  let lt;
  for (;;) {
    lt = text.indexOf('<', at);
    if (lt < 0) return null;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return null;
      at = end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return null;
      at = end + 2;
    } else if (text.startsWith('<!', lt)) {
      at = closeOf(text, lt + 2, { brackets: true });
      if (at < 0) return null;
    } else {
      break;
    }
  }
  if (!/^<svg[\s>/]/i.test(text.slice(lt, lt + 5))) return null;
  const end = closeOf(text, lt + 4);
  if (end < 0) return null;
  const m = /(?:^|\s)viewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text.slice(lt + 4, end - 1));
  if (!m) return null;
  const parts = (m[1] ?? m[2]).trim().split(/[\s,]+/);
  if (parts.length !== 4 || !parts.every((p) => p.length <= SVG_NUMBER_MAX && SVG_NUMBER_RE.test(p))) return null;
  const width = Number(parts[2]);
  const height = Number(parts[3]);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

function pngDims(bytes) {
  try {
    const { width, height } = pngSize(bytes);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

// { width, height } of an image's bytes — the PNG's IHDR, or the SVG's viewBox —
// or null when the bytes are neither, or the size cannot be read.
function imageSize(bytes) {
  const ext = sniff(bytes);
  if (ext === 'png') return pngDims(bytes);
  if (ext === 'svg') return svgSize(bytes);
  return null;
}

// ── the store ───────────────────────────────────────────────────────────────

// Remove one directory entry — a file or a link, never what a link points at,
// and never a directory. Whether something was removed.
function unlinkEntry(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return false; }
  if (st.isDirectory()) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// `log` receives the one-line notices (a link skipped, a file refused on read);
// the daemon's stderr is its log.
function imageFile(root, base, { log = console.error } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('imageFile: root must be a project directory');
  if (typeof base !== 'string' || !path.isAbsolute(base) || path.extname(base)) {
    throw new TypeError('imageFile: base must be an absolute path without an extension');
  }
  const pp = projectPaths(root);
  const fileOf = (ext) => `${base}.${ext}`;
  // The folder, fenced to .web-chat/ (null when it escapes, by path or by link).
  const folder = () => fence(pp.dir, path.dirname(base));

  // The file the image resolves to: { file, ext, type, stat } or null.
  function locate() {
    if (!folder()) return null;
    let best = null;
    for (const ext of EXTS) {
      const file = fileOf(ext);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isSymbolicLink()) {
        warnOnce(log, file, stat, 'it is a symlink — an image must be the file itself, not a link to one');
        continue;
      }
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.stat.mtimeMs) best = { file, ext, type: TYPES[ext], stat };
    }
    return best;
  }

  // The located file's bytes, re-sniffed: { bytes, ext, type, stat } or null.
  function load() {
    const hit = locate();
    if (!hit) return null;
    let fd;
    try { fd = fs.openSync(hit.file, READ_FLAGS); } catch { return null; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return null;
      if (stat.size > MAX_BYTES) {
        warnOnce(log, hit.file, stat, `it is ${stat.size} bytes; the limit is ${MAX_BYTES}`);
        return null;
      }
      const bytes = fs.readFileSync(fd);
      const ext = sniff(bytes);
      if (ext !== hit.ext) {
        warnOnce(log, hit.file, stat, ext
          ? `its bytes are ${ext.toUpperCase()}, not what its .${hit.ext} name says`
          : 'its bytes are not an SVG or PNG image');
        return null;
      }
      return { bytes, ext, type: TYPES[ext], stat };
    } catch {
      return null;
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  }

  // { bytes, type } or null when there is no image, or none that may be shown.
  function read() {
    const r = load();
    return r ? { bytes: r.bytes, type: r.type } : null;
  }

  // { type, bytes, version, width, height } or null, exactly when read() is.
  function meta() {
    const r = load();
    if (!r) return null;
    const size = r.ext === 'png' ? pngDims(r.bytes) : svgSize(r.bytes);
    return {
      type: r.type,
      bytes: r.bytes.length,
      version: `${Math.round(r.stat.mtimeMs)}-${r.stat.size}`,
      width: size ? size.width : null,
      height: size ? size.height : null,
    };
  }

  // Validate and store; then the other format goes. Throws BrandError: 400
  // empty or the folder not inside .web-chat, 413 over MAX_BYTES, 415 not PNG
  // or SVG, 422 an SVG carrying active content.
  function write(bytes) {
    const ext = validate(bytes);
    const dir = folder();
    if (!dir) throw new BrandError(400, 'the image folder is not inside .web-chat');
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(fileOf(ext), bytes, { mkdir: false });
    for (const other of EXTS) if (other !== ext) unlinkEntry(fileOf(other));
    return { type: TYPES[ext], bytes: bytes.length };
  }

  // Both formats; a link is removed, never its target. Whether anything was.
  function remove() {
    if (!folder()) return false;
    let removed = false;
    for (const ext of EXTS) if (unlinkEntry(fileOf(ext))) removed = true;
    return removed;
  }

  return { locate, read, meta, write, remove };
}

module.exports = { imageFile, imageSize };

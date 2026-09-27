const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths, fence } = require('../core/paths');
const { resolveDefault, getBuiltin } = require('./theme');

// ---------------------------------------------------------------------------
// Per-project brand images.
//
// Three fixed SLOTS, each one file under .web-chat/brand/: the `logotype` the
// topbar shows beside the wordmark, and the `lockup` and `seal` an exported page
// carries in its header and footer. A theme applies colour and type only; these
// are the project's own artwork, so they live with the project, not the theme.
//
// SVG or PNG, nothing else, decided by SNIFFING the bytes — never by a filename
// or a Content-Type a caller chose. Two layers keep an SVG inert:
//
//   1. write() refuses one that carries anything active (a <script>, an on*=
//      handler, a javascript: url, a <foreignObject>, an entity declaration).
//      Refusing beats rewriting: a sanitiser that edits markup is a parser we
//      would have to get exactly right, and a logo has no business with any of it.
//   2. Nothing ever inlines the markup into a document. The chrome loads a slot
//      through <img src="/brand/<slot>"> and an export through an <img> data:
//      URI — an image context runs no script and fetches nothing. The one way to
//      open the file AS a document is to navigate to /brand/<slot>, and that
//      response carries BRAND_CSP + nosniff (routes/brand.js).
//
// The slot name is the only thing a caller hands us that becomes a path, and it
// is looked up in SLOTS, never joined; `fence` then refuses a slot file that is
// a symlink pointing out of .web-chat/.
// ---------------------------------------------------------------------------

// Display sizes are the design's (the chrome and the export draw them at these
// boxes, object-fit: contain); they are advice for the artwork, not validated.
const SLOTS = Object.freeze({
  logotype: { label: 'Logotype', where: 'topbar', width: 150, height: 22 },
  lockup: { label: 'Lockup', where: 'export header', width: 260, height: 52 },
  seal: { label: 'Seal', where: 'export footer', width: 44, height: 44 },
});

// Per slot. A logo is a few KB of SVG or a small PNG; every export inlines the
// lockup and the seal as base64, so a slot must stay cheap to carry.
const MAX_BYTES = 256 * 1024;

const TYPES = Object.freeze({ png: 'image/png', svg: 'image/svg+xml' });
const EXTS = Object.keys(TYPES);

// What a response serving a slot is allowed to do if someone opens it as a
// document: nothing. An SVG's own <style> is the one thing it may keep.
const BRAND_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Markup an image has no use for. Case-insensitive, over the whole text.
const SVG_ACTIVE = [
  [/<\s*script/i, 'a <script> element'],
  [/<\s*foreignObject/i, 'a <foreignObject> element'],
  [/<!ENTITY/i, 'an entity declaration'],
  [/[\s"'/]on[a-z]+\s*=/i, 'an on* event handler'],
  [/javascript\s*:/i, 'a javascript: url'],
];

class BrandError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isSlot(slot) {
  return typeof slot === 'string' && Object.prototype.hasOwnProperty.call(SLOTS, slot);
}

// Which format these bytes are: 'png', 'svg', or null. An SVG is UTF-8 text
// whose first element is <svg — after an optional BOM, XML declaration,
// comments and a DOCTYPE.
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (buf.length >= PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'png';
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const lead = text.replace(/^(?:\s+|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)*/i, '');
  return /^<svg[\s>/]/i.test(lead) ? 'svg' : null;
}

// The reason an SVG is refused, or null when it is inert.
function svgRefusal(buf) {
  const text = buf.toString('utf8');
  for (const [re, what] of SVG_ACTIVE) if (re.test(text)) return what;
  return null;
}

// Absolute path of a slot's file in one format, fenced to .web-chat/; null when
// it escapes (a symlink out) or the slot is not one of SLOTS.
function slotFile(root, slot, ext) {
  if (!isSlot(slot) || !EXTS.includes(ext)) return null;
  const p = projectPaths(root);
  return fence(p.dir, path.join(path.relative(p.dir, p.brandDir), `${slot}.${ext}`));
}

// The file a slot currently resolves to: { file, ext, type, stat } or null. If
// a crash left both formats behind, the newer one wins.
function locate(root, slot) {
  let best = null;
  for (const ext of EXTS) {
    const file = slotFile(root, slot, ext);
    if (!file) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (!best || stat.mtimeMs > best.stat.mtimeMs) best = { file, ext, type: TYPES[ext], stat };
  }
  return best;
}

// { bytes, type } for a slot, or null when it is unset or unreadable. The bytes
// are re-sniffed: a file that is not what its extension says is not served.
function read(root, slot) {
  const hit = locate(root, slot);
  if (!hit) return null;
  let bytes;
  try { bytes = fs.readFileSync(hit.file); } catch { return null; }
  if (sniff(bytes) !== hit.ext) return null;
  return { bytes, type: hit.type };
}

// Every slot's metadata — { slot: {type, bytes, version} | null }. `version`
// changes whenever the file does, so the chrome can cache-bust /brand/<slot>.
function list(root) {
  const out = {};
  for (const slot of Object.keys(SLOTS)) {
    const hit = locate(root, slot);
    out[slot] = hit
      ? { type: hit.type, bytes: hit.stat.size, version: `${Math.round(hit.stat.mtimeMs)}-${hit.stat.size}` }
      : null;
  }
  return out;
}

// The one image check, for an upload and for a pack's logos file alike: the
// format ('png' | 'svg') when the bytes may be shown, else a BrandError — 400
// empty, 413 over MAX_BYTES, 415 not PNG/SVG, 422 an SVG carrying active content.
function validate(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new BrandError(400, 'empty image');
  if (bytes.length > MAX_BYTES) throw new BrandError(413, `image is ${bytes.length} bytes; the limit is ${MAX_BYTES}`);
  const ext = sniff(bytes);
  if (!ext) throw new BrandError(415, 'not an SVG or PNG image');
  if (ext === 'svg') {
    const why = svgRefusal(bytes);
    if (why) throw new BrandError(422, `SVG refused: it contains ${why}`);
  }
  return ext;
}

// Validate and store a slot. Throws BrandError(status) on refusal: 404 for an
// unknown slot, else validate()'s.
function write(root, slot, bytes) {
  if (!isSlot(slot)) throw new BrandError(404, `unknown brand slot '${slot}' (one of ${Object.keys(SLOTS).join(', ')})`);
  const ext = validate(bytes);
  const file = slotFile(root, slot, ext);
  if (!file) throw new BrandError(400, 'brand directory is not inside .web-chat');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  // Then drop the other format, so a slot is always exactly one file.
  for (const other of EXTS) {
    if (other === ext) continue;
    const f = slotFile(root, slot, other);
    if (f) { try { fs.unlinkSync(f); } catch {} }
  }
  return { slot, type: TYPES[ext], bytes: bytes.length };
}

// Clear a slot. Returns whether anything was there.
function remove(root, slot) {
  if (!isSlot(slot)) throw new BrandError(404, `unknown brand slot '${slot}'`);
  let removed = false;
  for (const ext of EXTS) {
    const f = slotFile(root, slot, ext);
    if (!f) continue;
    try { fs.unlinkSync(f); removed = true; } catch {}
  }
  return removed;
}

// ---------------------------------------------------------------------------
// A pack's per-user logos: the fill for an EMPTY project slot.
//
// Some builtin packs are an institution's look (Georgetown Blue), and that
// look wants its marks — which are trademarks, so none ship. Instead the user
// may drop them into a per-user folder, userPaths().themeLogosDir(<pack>)
// (~/.web-chat/themes/georgetown-blue/logos/), and while the project's global
// theme resolves to that pack, a slot the PROJECT left empty is filled from it:
// the topbar logotype, and an export's lockup and seal. A project's own upload
// always wins.
//
// Deliberately quiet: nothing in the UI, the docs, the CHANGELOG, the rules
// file or --help mentions the folder. The only description of it is the
// README.txt written into it, once, the first time the pack is in use.
//
// Files are named <slot>.svg|png, plus an optional <slot>-reversed.svg|png (a
// white mark) that dark mode uses instead. Each goes through validate() — the
// SAME check as an upload — and one that fails is ignored with one log line.
// ---------------------------------------------------------------------------

const FILL_PACKS = Object.freeze(['georgetown-blue']);
const FILL_MODES = Object.freeze(['light', 'dark']);

const LOGOS_README = `Georgetown Blue logos
=====================

Put your logos in this folder and web-chat shows them whenever a project
uses the Georgetown Blue theme and has not set its own (a project's own
images, from Settings > Brand, always win). No logos ship with web-chat.

The three files
---------------
  logotype   the topbar, drawn at 150 x 22
  lockup     the header of an exported page, drawn at 260 x 52
  seal       the footer of an exported page, drawn at 44 x 44

Exact filenames
---------------
  logotype.svg  or  logotype.png
  lockup.svg    or  lockup.png
  seal.svg      or  seal.png

Optional reversed (white) versions for dark mode:
  logotype-reversed.svg|png, lockup-reversed.svg|png, seal-reversed.svg|png

If both an .svg and a .png are here, the .svg is used.

Format
------
  SVG is preferred. It must not contain scripts, event handlers
  (onload= and the like) or <foreignObject> -- the same rules as
  Settings > Brand uploads -- and should not use external references
  (linked images or fonts): a logo is drawn where nothing is fetched,
  so they would not show. Convert text to outlines.
  Or PNG at 2x on a transparent background:
    logotype 300 x 44, lockup 520 x 104, seal 88 x 88.
  At most 256 KB each.

Colour
------
  Georgetown Blue #041E42 on light backgrounds. The reversed files are
  for dark backgrounds.

A file that breaks these rules is skipped (the web-chat log says which
one). Changes show the next time the page loads. web-chat wrote this
file once and never rewrites it; edit or delete it as you like.
`;

// Write the folder's README the first time the pack is in use: into a folder
// that does not exist yet, or one a crash left empty. A folder with anything
// in it is the user's — never touched, never rewritten.
function ensureLogosFolder(pack) {
  const dir = userPaths().themeLogosDir(pack);
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.txt'), LOGOS_README, { flag: 'wx' });
  } catch {}
}

// The fill pack a project's global theme resolves to, or null.
function fillPack(root) {
  if (!root) return null;
  const pp = projectPaths(root);
  const t = resolveDefault({ THEME_PATH: pp.theme, SYSTEM_THEME_PATH: userPaths().theme, THEME_DEFAULT_PATH: pp.themeDefault });
  // a stored name that matches a builtin was always an applied builtin (save
  // refuses builtin names) — the same rule resolveScope reports by
  const b = t && t.name ? getBuiltin(t.name) : null;
  if (!b || !FILL_PACKS.includes(b.name)) return null;
  ensureLogosFolder(b.name);
  return b.name;
}

// One log line per bad file (per version of it), not one per request.
const warned = new Set();
function warnOnce(file, stat, why) {
  const key = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`web-chat: ignoring logo ${file}: ${why}`);
}

// { bytes, type, version } for one logos-folder file (`logotype`,
// `logotype-reversed`, …), svg first, or null when there is no valid one.
function logoFile(pack, base) {
  const dir = userPaths().themeLogosDir(pack);
  for (const ext of ['svg', 'png']) {
    const file = path.join(dir, `${base}.${ext}`);
    let stat, bytes;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) { warnOnce(file, stat, `it is ${stat.size} bytes; the limit is ${MAX_BYTES}`); continue; }
    try { bytes = fs.readFileSync(file); } catch { continue; }
    let got;
    try { got = validate(bytes); } catch (e) { warnOnce(file, stat, e.message); continue; }
    if (got !== ext) { warnOnce(file, stat, `it is not ${ext === 'svg' ? 'an SVG' : 'a PNG'}`); continue; }
    return { bytes, type: TYPES[ext], version: `${Math.round(stat.mtimeMs)}-${stat.size}` };
  }
  return null;
}

// A slot's fill per mode — { light, dark }, each { bytes, type, version } or
// null (dark is the reversed file, else the regular one) — or null when the
// project set the slot itself, no fill pack is in use, or the folder has
// nothing valid for it.
function fillFor(root, slot, pack = fillPack(root)) {
  if (!pack || !isSlot(slot) || locate(root, slot)) return null;
  const light = logoFile(pack, slot);
  const dark = logoFile(pack, `${slot}-reversed`) || light;
  return light || dark ? { light, dark } : null;
}

// Every slot's fill as metadata — { slot: { light: {type, bytes, version} |
// null, dark: … } | null } — beside list()'s own slots. Kept apart from them,
// so Settings → Brand shows only what the project set.
function fills(root) {
  const pack = fillPack(root);
  const meta = (f) => (f ? { type: f.type, bytes: f.bytes.length, version: f.version } : null);
  const out = {};
  for (const slot of Object.keys(SLOTS)) {
    const f = pack ? fillFor(root, slot, pack) : null;
    out[slot] = f ? { light: meta(f.light), dark: meta(f.dark) } : null;
  }
  return out;
}

// What a slot shows in `mode`: the project's own image, else the fill pack's.
function effective(root, slot, { mode = 'light' } = {}) {
  if (!root) return null;
  const own = read(root, slot);
  if (own) return own;
  const f = fillFor(root, slot);
  const hit = f && f[FILL_MODES.includes(mode) ? mode : 'light'];
  return hit ? { bytes: hit.bytes, type: hit.type } : null;
}

// A slot as a data: URI (base64 — only [A-Za-z0-9+/=] after the fixed prefix,
// so it is attribute-safe), or null when unset. For documents that cannot
// fetch /brand/, i.e. an export — light unless a mode is named.
function dataUri(root, slot, opts) {
  const r = effective(root, slot, opts);
  return r ? `data:${r.type};base64,${r.bytes.toString('base64')}` : null;
}

module.exports = {
  SLOTS, MAX_BYTES, TYPES, BRAND_CSP, BrandError,
  isSlot, sniff, svgRefusal, validate, read, list, write, remove, dataUri,
  fills, effective, LOGOS_README,
};

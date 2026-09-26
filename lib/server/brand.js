const fs = require('fs');
const path = require('path');
const { projectPaths, fence } = require('../core/paths');

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

// Validate and store a slot. Throws BrandError(status) on refusal: 404 for an
// unknown slot, 413 over MAX_BYTES, 415 for anything not PNG/SVG, 422 for an
// SVG carrying active content.
function write(root, slot, bytes) {
  if (!isSlot(slot)) throw new BrandError(404, `unknown brand slot '${slot}' (one of ${Object.keys(SLOTS).join(', ')})`);
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new BrandError(400, 'empty image');
  if (bytes.length > MAX_BYTES) throw new BrandError(413, `image is ${bytes.length} bytes; the limit is ${MAX_BYTES}`);
  const ext = sniff(bytes);
  if (!ext) throw new BrandError(415, 'not an SVG or PNG image');
  if (ext === 'svg') {
    const why = svgRefusal(bytes);
    if (why) throw new BrandError(422, `SVG refused: it contains ${why}`);
  }
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

// A slot as a data: URI (base64 — only [A-Za-z0-9+/=] after the fixed prefix,
// so it is attribute-safe), or null when unset. For documents that cannot
// fetch /brand/, i.e. an export.
function dataUri(root, slot) {
  const r = root ? read(root, slot) : null;
  return r ? `data:${r.type};base64,${r.bytes.toString('base64')}` : null;
}

module.exports = {
  SLOTS, MAX_BYTES, TYPES, BRAND_CSP, BrandError,
  isSlot, sniff, svgRefusal, read, list, write, remove, dataUri,
};

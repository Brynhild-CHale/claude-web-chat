// lib/core/brand-image.js — the one check an image must pass before web-chat
// shows it as a logo.
//
// Two callers, one rule. lib/server/brand.js validates a Settings → Brand
// upload and a builtin pack's per-user logos folder with it; lib/packs
// validates a theme pack's `themes/<name>/logos/` files with it AT PLAN TIME, so
// a bad logo fails the review rather than being skipped later. The check lives
// here, in the leaf layer, because `lib/packs → lib/server` is backwards (see
// test/dependency-direction.test.js) and a second copy of an image check is
// exactly the drift this layer exists to prevent. lib/server/brand.js re-exports
// every name below, so its callers did not move.
//
// SVG or PNG, nothing else, decided by SNIFFING the bytes — never by a filename
// or a Content-Type a caller chose. An SVG that carries anything active (a
// <script>, an on*= handler, a javascript: url, a <foreignObject>, an entity
// declaration) is refused rather than rewritten: a sanitiser that edits markup
// is a parser we would have to get exactly right, and a logo has no business
// with any of it. Nothing ever inlines the markup into a document either (see
// lib/server/brand.js) — this is the first of two layers, not the only one.
//
// Imports nothing (dependency direction: core is the leaf).

// The three slots. Display sizes are the design's (the chrome and the export
// draw them at these boxes, object-fit: contain); they are advice for the
// artwork, not validated.
const SLOTS = Object.freeze({
  logotype: { label: 'Logotype', where: 'topbar', width: 150, height: 22 },
  lockup: { label: 'Lockup', where: 'export header', width: 260, height: 52 },
  seal: { label: 'Seal', where: 'export footer', width: 44, height: 44 },
});

// Per image. A logo is a few KB of SVG or a small PNG; every export inlines the
// lockup and the seal as base64, so one must stay cheap to carry.
const MAX_BYTES = 256 * 1024;

const TYPES = Object.freeze({ png: 'image/png', svg: 'image/svg+xml' });

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

// The one image check: the format ('png' | 'svg') when the bytes may be shown,
// else a BrandError — 400 empty, 413 over MAX_BYTES, 415 not PNG/SVG, 422 an
// SVG carrying active content.
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

// A logo FILE (a logos folder's, a theme pack's) is named `<slot>.svg|png`, or
// `<slot>-reversed.svg|png` for the white mark dark mode uses. Returns
// { slot, reversed, ext } for a legal name, else null.
function parseLogoName(file) {
  const m = /^([a-z]+)(-reversed)?\.(svg|png)$/.exec(String(file || ''));
  if (!m || !Object.prototype.hasOwnProperty.call(SLOTS, m[1])) return null;
  return { slot: m[1], reversed: Boolean(m[2]), ext: m[3] };
}

// validate() plus the name's promise: a `.png` must BE a PNG and a `.svg` an
// SVG. Returns the ext, or throws BrandError.
function validateLogoFile(file, bytes) {
  const want = parseLogoName(file);
  const ext = validate(bytes);
  if (want && want.ext !== ext) throw new BrandError(415, `it is not ${want.ext === 'svg' ? 'an SVG' : 'a PNG'}`);
  return ext;
}

module.exports = {
  SLOTS, MAX_BYTES, TYPES, BrandError,
  sniff, svgRefusal, validate, parseLogoName, validateLogoFile,
};

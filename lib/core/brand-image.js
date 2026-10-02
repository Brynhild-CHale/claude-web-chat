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
// <script>, <foreignObject>, <iframe>, <embed>, <object> or <handler> under any
// namespace prefix, an on*= handler, a javascript: url however its characters
// are referenced, an animation that sets a handler or a link, an entity
// declaration, a namespace other than SVG and XLink) is refused rather than
// rewritten: a sanitiser that edits markup is a parser we would have to get
// exactly right, and a logo has no business with any of it. Nothing ever
// inlines the markup into a document either (see lib/server/brand.js) — this
// is the first of two layers, not the only one.
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
//
// This is a TEXT check, and an XML parser reads two things a plain regex does
// not: namespace prefixes and character references. So an element is matched
// under any prefix (`<x:script>` IS a script once x is bound to the SVG
// namespace), and every rule about an attribute VALUE — which may spell itself
// in character references (`javascript&#58;`) — is judged on the decoded text
// as well as the raw one. Element and attribute NAMES cannot be written as
// references, so the element and on*= rules read the raw text only.
const PREFIX = '(?:[\\w.-]+:)?';
const SVG_ACTIVE = [
  [new RegExp(`<\\s*${PREFIX}script`, 'i'), 'a <script> element'],
  [new RegExp(`<\\s*${PREFIX}foreignObject`, 'i'), 'a <foreignObject> element'],
  [new RegExp(`<\\s*${PREFIX}(?:iframe|embed|object|handler)\\b`, 'i'), 'an <iframe>, <embed>, <object> or <handler> element'],
  [/<!ENTITY/i, 'an entity declaration'],
  [/[\s"'/]on[a-z]+\s*=/i, 'an on* event handler'],
];

// The value rules: each takes the text and says whether it is refused. Run on
// the raw text and on the text with its character references decoded.
// The optional quote takes the whitespace after it as its own group: with two
// bare \\s* either side of an optional quote, a long unquoted run of spaces can
// be split between them every possible way (quadratic: 60 KB took 2.6 s, a
// 256 KB upload about 35 s on the daemon's thread). The language is unchanged.
const SMIL_TARGET_RE = new RegExp(`attributeName\\s*=\\s*(?:["']\\s*)?${PREFIX}(?:on|href)`, 'i');
const SVG_ACTIVE_VALUES = [
  // A URL parser drops tabs and line breaks anywhere in a URL, so
  // `java&#9;script:` is a javascript: url too — judged with them removed.
  [(text) => /javascript\s*:/i.test(text.replace(/[\t\n\r]/g, '')), 'a javascript: url'],
  // SMIL can SET an attribute: an animation that targets an event handler or a
  // link carries its script in to=/values=, with no on*= or javascript: to see.
  [(text) => SMIL_TARGET_RE.test(text), 'an animation of an event handler or a link'],
  [(text) => foreignNamespace(text), 'a namespace other than SVG and XLink (save it as a plain SVG)'],
];

// The only namespace bindings a logo needs: the default one (SVG) and the two
// prefixes that name SVG and XLink. Anything else — a prefix bound to XHTML, SVG
// bound under another prefix, an editor's private namespace — is a way for the
// markup to mean something this check does not read.
const NS_ALLOWED = Object.freeze({
  '': 'http://www.w3.org/2000/svg',
  svg: 'http://www.w3.org/2000/svg',
  xlink: 'http://www.w3.org/1999/xlink',
});
const NS_RE = /\bxmlns(?::([^\s=>/]*))?\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;

// Whether `text` binds a namespace NS_ALLOWED does not name.
function foreignNamespace(text) {
  for (const m of text.matchAll(NS_RE)) {
    const prefix = m[1] || '';
    const uri = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!Object.hasOwn(NS_ALLOWED, prefix) || NS_ALLOWED[prefix] !== uri) return true;
  }
  return false;
}

// `text` with its character references resolved: numeric ones (with or without
// the `;` an HTML parser forgives), the five XML predefined names, and the HTML
// names for a colon, a tab and a line break — the characters a URL scheme can
// be spelled around. A numeric reference that is not a code point decodes to
// nothing.
const NAMED_REFS = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n' });
function decodeCharRefs(text) {
  return text
    .replace(/&#x([0-9a-f]+);?|&#(\d+);?/gi, (_, hex, dec) => {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&(lt|gt|amp|quot|apos|colon|tab|newline);/gi, (_, n) => NAMED_REFS[n.toLowerCase()]);
}

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
  const decoded = decodeCharRefs(text);
  for (const [refused, what] of SVG_ACTIVE_VALUES) {
    if (refused(text) || (decoded !== text && refused(decoded))) return what;
  }
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

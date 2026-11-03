// lib/core/element-assets.js — which files of an element type may be served,
// as what, and how large (annotation engine tranche 4, U511; PLAN.md 4A.1 and
// 4A.2; DECISIONS.md B1 review-approve and B3 fenced-route; ruling
// U511@file-cap a).
//
// A plug-in element type is one directory of a reviewed, approved pack
// (lib/packs/elements: element.json, draw.js, assets/**). The chrome loads its
// draw.js by a dynamic import() of a same-origin route (DRAW@loader — never
// eval), and the type's assets (an image, a font) by URL; a document inlines
// the same bytes. This module is the one answer to "may this relative path be
// served, as which media type, and do its bytes say they are that":
//
//   DRAW_FILE    'draw.js', served as DRAW_TYPE — that one path, at the
//                type's root, never a JavaScript file under assets/
//                (PFH@inline: a type inlines its libraries into draw.js)
//   ASSET_TYPES  {ext: media type} for files under assets/ only: PNG, SVG,
//                WebP, WOFF2 — nothing executable or markup-bearing
//   FILE_MAX     bytes per file, draw.js included: brand-image's 256 KB
//   mediaOf(rel) → {type, kind: 'draw' | 'image' | 'font', ext}, or {refused}
//   sniff(bytes, media) → null when the bytes are what the media says, else
//                the reason. PNG and SVG go through lib/core/brand-image
//                validate (the one image check: an active SVG is refused,
//                never rewritten); WebP by its RIFF…WEBP header, WOFF2 by its
//                'wOF2' signature; draw.js must decode as UTF-8.
//
// Pure: no file is read here. The fenced read of a listed type's file is
// lib/server/element-files.js (readFenced / readTypeFile), which asks this
// module before and after it reads. Imports only lib/core/brand-image (the
// image check) and lib/core/text (the one control, bidi and invisible
// character set) — dependency direction: core is the leaf.
'use strict';

const brandImage = require('./brand-image');
const { hasForbidden } = require('./text');

const DRAW_FILE = 'draw.js';
const DRAW_TYPE = 'text/javascript; charset=utf-8';
const ASSETS_DIR = 'assets';

const ASSET_TYPES = Object.freeze({
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff2: 'font/woff2',
});
const KIND_OF_EXT = Object.freeze({ png: 'image', svg: 'image', webp: 'image', woff2: 'font' });

// Per file, draw.js and assets alike (ruling U511@file-cap a: brand-image's
// precedent; perfect-freehand inlined into a draw.js is well under it).
const FILE_MAX = 256 * 1024;

// A relative path's length (lib/packs/elements ICON_PATH_MAX's figure).
const REL_MAX = 200;

const ALLOWED_HINT = `only ${DRAW_FILE} and ${ASSETS_DIR}/<path>.${Object.keys(ASSET_TYPES).join('|')} are served`;

// A path segment no served name may hold: empty, '.', '..', or one carrying a
// backslash, or a control, bidi or invisible character (lib/core/text).
const badSegment = (s) => !s || s === '.' || s === '..' || s.includes('\\') || hasForbidden(s);

// rel → {type, kind, ext} or {refused: reason}.
function mediaOf(rel) {
  if (typeof rel !== 'string' || !rel) return { refused: `not an allowed file: ${ALLOWED_HINT}` };
  if (rel.length > REL_MAX) return { refused: `not an allowed file: a path is at most ${REL_MAX} characters` };
  if (rel === DRAW_FILE) return { type: DRAW_TYPE, kind: 'draw', ext: 'js' };
  const segs = rel.split('/');
  if (segs.some(badSegment)) return { refused: 'not an allowed file: a path segment is empty, \'.\', \'..\' or holds a backslash or a control, bidi or invisible character' };
  if (segs.length < 2 || segs[0] !== ASSETS_DIR) return { refused: `not an allowed file: ${ALLOWED_HINT}` };
  const last = segs[segs.length - 1];
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
  if (!Object.hasOwn(ASSET_TYPES, ext)) return { refused: `not an allowed file: ${ALLOWED_HINT}` };
  return { type: ASSET_TYPES[ext], kind: KIND_OF_EXT[ext], ext };
}

const WEBP_RIFF = Buffer.from('RIFF', 'latin1');
const WEBP_TAG = Buffer.from('WEBP', 'latin1');
const WOFF2_TAG = Buffer.from('wOF2', 'latin1');

// The bytes against the media mediaOf answered → null, or the reason they are
// refused.
function sniff(bytes, media) {
  if (!Buffer.isBuffer(bytes)) return 'not bytes';
  if (!media || typeof media !== 'object' || media.refused) return 'not an allowed file';
  if (bytes.length > FILE_MAX) return `over the cap: ${bytes.length} bytes; the limit is ${FILE_MAX}`;
  switch (media.ext) {
    case 'js':
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return `${DRAW_FILE} is not UTF-8 text`;
      }
      return null;
    case 'png':
    case 'svg': {
      let ext;
      try { ext = brandImage.validate(bytes); } catch (e) { return String((e && e.message) || e); }
      return ext === media.ext ? null : `the bytes are not ${media.ext === 'png' ? 'a PNG' : 'an SVG'} (they are ${ext === 'png' ? 'a PNG' : 'an SVG'})`;
    }
    case 'webp':
      return bytes.length >= 16 && bytes.subarray(0, 4).equals(WEBP_RIFF) && bytes.subarray(8, 12).equals(WEBP_TAG)
        ? null : 'the bytes are not a WebP image';
    case 'woff2':
      return bytes.length >= 48 && bytes.subarray(0, 4).equals(WOFF2_TAG) ? null : 'the bytes are not a WOFF2 font';
    default:
      return 'not an allowed file';
  }
}

module.exports = {
  DRAW_FILE, DRAW_TYPE, ASSETS_DIR, ASSET_TYPES, FILE_MAX, REL_MAX, ALLOWED_HINT,
  mediaOf, sniff,
};

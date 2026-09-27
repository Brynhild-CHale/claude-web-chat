// lib/core/fonts.js — which font faces web-chat ships, read from the one file
// that declares them.
//
// public/fonts/fonts.css is THE declaration of every face web-chat bundles; the
// live chrome links it and the browser fetches each file same-origin. Two
// layers need to know what it declares: lib/server/fonts.js (an export inlines
// exactly the faces its theme names) and lib/packs (a theme pack may name a
// bundled family in its `fonts` list, and only a bundled one, unless it ships
// the file). The parser lives here, in the leaf layer, because lib/packs may not
// import lib/server — and reading fonts.css rather than keeping a table means a
// face added there is known to both the moment it lands.
//
// Imports only lib/core (dependency direction: core is the leaf).

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('./paths');

const FONTS_CSS = 'fonts.css';
const FACE_RE = /@font-face\s*\{([^}]*)\}/g;
const FAMILY_RE = /font-family\s*:\s*(['"]?)([^;'"]+)\1\s*;/;
// A src a face may carry: one bundled file in the fonts directory, nothing else
// (no subdirectories, no `..`, no other origin), so inlining can only ever read
// a font file that directory holds.
const SRC_RE = /url\(\s*(['"]?)\/fonts\/([\w-][\w.-]*)\1\s*\)/g;

// Parse fonts.css into [{ family, files, css }] — one entry per @font-face,
// `css` the block verbatim. Memoized per directory: the file ships with the
// package and never changes under a running daemon.
const faceCache = new Map();
function fontFaces(publicDir = PUBLIC_DIR) {
  if (faceCache.has(publicDir)) return faceCache.get(publicDir);
  let text = '';
  try { text = fs.readFileSync(path.join(publicDir, 'fonts', FONTS_CSS), 'utf8'); } catch {}
  const faces = [];
  for (const m of text.matchAll(FACE_RE)) {
    const fam = FAMILY_RE.exec(m[1]);
    if (!fam) continue;
    const files = [...m[1].matchAll(SRC_RE)].map((s) => s[2]);
    faces.push({ family: fam[2].trim(), files, css: m[0] });
  }
  faceCache.set(publicDir, faces);
  return faces;
}

// The bundled family names, once each, in declaration order.
function bundledFamilies(publicDir = PUBLIC_DIR) {
  return [...new Set(fontFaces(publicDir).map((f) => f.family))];
}

module.exports = { FONTS_CSS, SRC_RE, fontFaces, bundledFamilies };

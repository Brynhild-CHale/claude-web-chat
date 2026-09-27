const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('../core/paths');

// ---------------------------------------------------------------------------
// Bundled fonts, for the documents that cannot fetch them.
//
// public/fonts/fonts.css is THE declaration of every face web-chat ships; the
// live chrome links it and the browser fetches each file same-origin. An export
// has no origin to fetch from, so it needs the same faces with every `url()`
// swapped for a data: URI — and only the faces its theme actually names, since a
// base64 font is not cheap (Geist alone is ~93KB inlined).
//
// This reads fonts.css (through lib/core/fonts) rather than keeping a second
// table, so the two cannot drift: a face added there reaches exports the moment
// a theme names it.
// ---------------------------------------------------------------------------

// The parser for fonts.css (FONTS_CSS, SRC_RE, fontFaces) lives in
// lib/core/fonts.js — lib/packs reads the bundled family list too.
const { FONTS_CSS, SRC_RE, fontFaces } = require('../core/fonts');

const MIME = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

// The bundled families a set of CSS strings (token values, raw theme css)
// names. A family counts when it appears as a whole name in a font stack —
// quoted, or bare and bounded by a comma/quote/semicolon/end — compared without
// case, as CSS does. So `'Geist Mono', monospace` names Geist Mono and NOT
// Geist, and a token that merely says `var(--wc-font)` names nothing: the token
// it points at is in the same set and is read on its own.
function familiesIn(strings, publicDir = PUBLIC_DIR) {
  const text = strings.filter((s) => typeof s === 'string').join('\n');
  const found = new Set();
  for (const { family } of fontFaces(publicDir)) {
    const literal = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,:'"])${literal}(?=\\s*(?:['",;!}]|$))`, 'im');
    if (re.test(text)) found.add(family);
  }
  return found;
}

// base64 of one bundled file, memoized (the same few files inline into every
// export of a themed project).
const dataCache = new Map();
function dataUri(publicDir, file) {
  const abs = path.join(publicDir, 'fonts', file);
  if (dataCache.has(abs)) return dataCache.get(abs);
  const mime = MIME[path.extname(file).toLowerCase()];
  let uri = null;
  if (mime) {
    try { uri = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`; } catch {}
  }
  dataCache.set(abs, uri);
  return uri;
}

// @font-face CSS for exactly the bundled families `strings` name, each url()
// replaced by its data: URI — '' when they name none. A face whose file cannot
// be read is dropped whole rather than shipped with a dangling /fonts/ url that
// resolves nowhere once the page leaves the server; the stack's fallbacks then
// carry the text, exactly as they do when a font never loads.
function inlineFontCss(strings, publicDir = PUBLIC_DIR) {
  const want = familiesIn(strings, publicDir);
  if (!want.size) return '';
  const out = [];
  for (const face of fontFaces(publicDir)) {
    if (!want.has(face.family)) continue;
    let ok = true;
    const css = face.css.replace(SRC_RE, (_, _q, file) => {
      const uri = dataUri(publicDir, file);
      if (!uri) { ok = false; return 'url()'; }
      return `url('${uri}')`;
    });
    // Any url() the pattern above refused (a subdirectory, `..`, another
    // origin) is still pointing off the page — drop that face too.
    if (ok && !/url\(\s*(?!['"]?data:)/.test(css)) out.push(css);
  }
  return out.join('\n');
}

module.exports = { fontFaces, familiesIn, inlineFontCss, FONTS_CSS };

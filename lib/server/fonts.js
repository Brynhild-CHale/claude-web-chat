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
// This reads fonts.css rather than keeping a second table, so the two cannot
// drift: a face added there reaches exports the moment a theme names it.
// ---------------------------------------------------------------------------

const FONTS_CSS = 'fonts.css';
const FACE_RE = /@font-face\s*\{([^}]*)\}/g;
const FAMILY_RE = /font-family\s*:\s*(['"]?)([^;'"]+)\1\s*;/;
// A src a face may carry: one bundled file in the fonts directory, nothing else
// (no subdirectories, no `..`, no other origin), so inlining can only ever read
// a font file that directory holds.
const SRC_RE = /url\(\s*(['"]?)\/fonts\/([\w-][\w.-]*)\1\s*\)/g;

const MIME = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

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

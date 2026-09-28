const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { PUBLIC_DIR } = require('../lib/core/paths');
const { fontFaces, familiesIn, inlineFontCss } = require('../lib/server/fonts');
const { assembleExport, resolveExportTheme } = require('../lib/server/export');
const { getBuiltin, flattenTheme } = require('../lib/server/theme');
const { previewThemeCss, renderPreviewHtml } = require('../lib/server/preview');
const { assembleReplay } = require('../lib/server/replay/document');
const { PREVIEW_CSP } = require('../lib/core/cors');
const { withServer } = require('../test-support/helpers');

const FONTS_DIR = path.join(PUBLIC_DIR, 'fonts');
const CASLON = 'Libre Caslon Text';

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// --- the bundle ---------------------------------------------------------------

test('fonts.css is the one place @font-face is declared', () => {
  const others = walk(PUBLIC_DIR)
    .filter((f) => /\.(css|html|js)$/.test(f) && f !== path.join(FONTS_DIR, 'fonts.css'))
    .filter((f) => /@font-face\s*\{/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(others.map((f) => path.relative(PUBLIC_DIR, f)), [],
    'a face declared outside public/fonts/fonts.css reaches the chrome but never an export');
  // …and the chrome loads it, ahead of the stylesheet that names the families.
  const index = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const fontsAt = index.indexOf('href="/fonts/fonts.css"');
  assert.ok(fontsAt > 0, 'index.html links /fonts/fonts.css');
  assert.ok(fontsAt < index.indexOf('href="/app.css"'), 'before app.css');
});

test('every face points at a bundled file, every bundled font is declared, each family ships its OFL', () => {
  const faces = fontFaces();
  assert.deepEqual([...new Set(faces.map((f) => f.family))].sort(), ['Geist', 'Geist Mono', CASLON]);
  const declared = new Set();
  for (const f of faces) {
    assert.equal(f.files.length, 1, `${f.family}: one src file per face`);
    for (const file of f.files) {
      assert.ok(fs.existsSync(path.join(FONTS_DIR, file)), `${file} is bundled`);
      declared.add(file);
    }
  }
  const shipped = fs.readdirSync(FONTS_DIR).filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
  assert.deepEqual(shipped.sort(), [...declared].sort(), 'no undeclared font file rides the tarball');
  // Caslon: the three styles the Georgetown pack draws, each in both subsets.
  const caslon = faces.filter((f) => f.family === CASLON).map((f) => f.css);
  for (const [w, s] of [['400', 'normal'], ['700', 'normal'], ['400', 'italic']]) {
    assert.equal(caslon.filter((c) => c.includes(`font-weight: ${w};`) && c.includes(`font-style: ${s};`)).length, 2,
      `Caslon ${w} ${s}: latin + latin-ext`);
  }
  for (const lic of ['Geist-OFL.txt', 'LibreCaslonText-OFL.txt']) {
    assert.match(fs.readFileSync(path.join(FONTS_DIR, lic), 'utf8'), /SIL Open Font License, Version 1\.1/);
  }
});

// --- which families a theme names ---------------------------------------------

test('familiesIn: whole family names in a stack, case-insensitive; var() indirection names nothing', () => {
  assert.deepEqual([...familiesIn(["'Geist Mono', ui-monospace, monospace"])], ['Geist Mono'],
    "'Geist Mono' is not also Geist");
  assert.deepEqual([...familiesIn(["'Geist', sans-serif"])], ['Geist']);
  assert.deepEqual([...familiesIn(['geist, sans-serif'])], ['Geist'], 'bare and lower-case still count');
  assert.deepEqual([...familiesIn(['h1 { font-family:"Libre Caslon Text"; }'])], [CASLON], 'raw css counts');
  assert.deepEqual([...familiesIn(['var(--wc-font)', '#fff', 'Geistly, serif', 'Libre Caslon', undefined])], []);
});

test('familiesIn: the packs name the faces they are drawn in', () => {
  const named = (name) => [...familiesIn(Object.values(flattenTheme(getBuiltin(name)).tokens))].sort();
  assert.deepEqual(named('earthy'), ['Geist', 'Geist Mono']);
  assert.deepEqual(named('paper'), ['Geist', 'Geist Mono']);
  // Georgetown Blue's UI stack is Helvetica (a system face) — only its mono and
  // its Caslon display/reading are bundled.
  assert.deepEqual(named('georgetown-blue'), ['Geist Mono', CASLON]);
});

// --- inlining ------------------------------------------------------------------

test('inlineFontCss: the named faces only, every url() a data: URI of the bundled bytes', () => {
  assert.equal(inlineFontCss(['var(--wc-font)', "Georgia, serif"]), '');
  const css = inlineFontCss(["'Libre Caslon Text', Georgia, serif"]);
  assert.equal((css.match(/@font-face/g) || []).length, 6);
  assert.ok(!/\/fonts\//.test(css), 'no url left pointing back at the server');
  assert.ok(!/Geist/.test(css), 'a family nobody named is not inlined');
  const m = /url\('data:font\/woff2;base64,([A-Za-z0-9+/=]+)'\)/.exec(css);
  assert.ok(m, 'a woff2 data URI');
  const bytes = Buffer.from(m[1], 'base64');
  const first = fontFaces().find((f) => f.family === CASLON).files[0];
  assert.ok(bytes.equals(fs.readFileSync(path.join(FONTS_DIR, first))), 'the bytes are the bundled file');
  assert.match(css, /unicode-range:/, 'the rest of the block rides along verbatim');
});

test('inlineFontCss: an unreadable or out-of-directory src drops its face instead of dangling', () => {
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fonts-'));
  fs.mkdirSync(path.join(pub, 'fonts'));
  fs.writeFileSync(path.join(pub, 'secret.woff2'), 'nope');
  fs.writeFileSync(path.join(pub, 'fonts', 'Ok.woff2'), 'wOF2ok');
  fs.writeFileSync(path.join(pub, 'fonts', 'fonts.css'), [
    "@font-face { font-family: 'Ok'; src: url('/fonts/Ok.woff2') format('woff2'); }",
    "@font-face { font-family: 'Gone'; src: url('/fonts/Gone.woff2') format('woff2'); }",
    "@font-face { font-family: 'Up'; src: url('/fonts/../secret.woff2') format('woff2'); }",
    "@font-face { font-family: 'Dots'; src: url('/fonts/..') format('woff2'); }",
  ].join('\n'));
  const css = inlineFontCss(["Ok, Gone, Up, Dots"], pub);
  assert.match(css, /font-family: 'Ok'/);
  assert.match(css, new RegExp(Buffer.from('wOF2ok').toString('base64')));
  assert.ok(!/Gone|Dots|'Up'/.test(css), 'a missing or out-of-directory file drops the face');
  assert.ok(!css.includes(Buffer.from('nope').toString('base64')), 'nothing outside fonts/ is ever read');
  fs.rmSync(pub, { recursive: true, force: true });
});

// --- export --------------------------------------------------------------------

function themeCtx(theme) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fontexp-'));
  const THEME_PATH = path.join(dir, 'theme.json');
  if (theme) fs.writeFileSync(THEME_PATH, JSON.stringify(theme));
  return { paths: { THEME_PATH, SYSTEM_THEME_PATH: path.join(dir, 'none.json'), PUBLIC_DIR } };
}

test('resolveExportTheme: inlines the faces the resolved theme names, and none for an unthemed page', () => {
  const plain = resolveExportTheme(themeCtx(null), { mounts: [{ id: 'p', html: '' }], node: null });
  assert.equal(plain.page.fonts, '');

  const gt = resolveExportTheme(themeCtx({ name: 'georgetown-blue', builtin: true }), { mounts: [], node: null });
  assert.match(gt.page.fonts, /font-family: 'Libre Caslon Text'/);
  assert.match(gt.page.fonts, /font-family: 'Geist Mono'/);
  assert.ok(!/font-family: 'Geist';/.test(gt.page.fonts), 'Georgetown Blue draws no Geist sans');

  // A pane themed into a face the page does not use still gets it: @font-face
  // on the document reaches into the pane's shadow root.
  const pane = resolveExportTheme(themeCtx(null), {
    mounts: [{ id: 'p', html: '', theme: { tokens: { '--wc-reading': "'Libre Caslon Text', serif" } } }],
    node: null,
  });
  assert.match(pane.page.fonts, /Libre Caslon Text/);
  // …and a node's raw css naming one counts too.
  const node = resolveExportTheme(themeCtx(null), {
    mounts: [], node: { theme: { css: "h1 { font-family: 'Geist Mono'; }" } },
  });
  assert.match(node.page.fonts, /Geist Mono/);
});

test('assembleExport: page fonts land in the head style, self-contained', () => {
  const fonts = inlineFontCss(["'Geist Mono'"]);
  const html = assembleExport({ mounts: [], page: { tokens: {}, fonts } });
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(style.includes(fonts), 'the inlined faces are in the document style');
  assert.ok(!/url\('\/fonts\//.test(html), 'no server-relative font url');
});

test('route: a Georgetown Blue export carries Caslon inline; the chrome serves the same files same-origin', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/theme/apply', { name: 'georgetown-blue', scope: 'global' });
  await api.post('/api/render', { id: 'p1', html: '<h1>Title</h1>' });
  await api.post('/api/commit', { message: 'seed' });
  const dl = await api.get('/api/export/active');
  assert.equal(dl.status, 200);
  assert.match(dl.text, /font-family: 'Libre Caslon Text';\s*src: url\('data:font\/woff2;base64,/);
  assert.ok(!/url\('\/fonts\//.test(dl.text));

  const css = await api.get('/fonts/fonts.css');
  assert.equal(css.status, 200);
  assert.match(css.text, /@font-face/);
  const face = await api.get('/fonts/LibreCaslonText-Regular.latin.woff2');
  assert.equal(face.status, 200);
});

// --- previews and replays --------------------------------------------------------
// The preview document (graph inspector, glance, pane history, node-render) and
// every replay frame — the player, a downloaded replay.html, a GIF/video render —
// are filled from previewThemeCss. None of them can fetch /fonts/ (a sandboxed
// frame's origin is opaque; a replay.html has no server), so the faces ride
// inline, and PREVIEW_CSP admits data: fonts and nothing else.

const georgetown = (mode = 'light') => flattenTheme(getBuiltin('georgetown-blue'), mode);

test('previewThemeCss: the bundled faces a theme names, inline as data: URIs; an empty theme adds none', () => {
  for (const mode of ['light', 'dark']) {
    const css = previewThemeCss(georgetown(mode));
    assert.match(css, /@font-face\s*\{[^}]*font-family: 'Libre Caslon Text';\s*src: url\('data:font\/woff2;base64,/,
      `Georgetown Blue ${mode}: Caslon, inline`);
    assert.match(css, /font-family: 'Geist Mono';\s*src: url\('data:font\/woff2;base64,/, 'and its mono');
    assert.ok(!/font-family: 'Geist';/.test(css), 'a family the theme does not name is not inlined');
    assert.ok(!/url\('\/fonts\//.test(css), 'no url pointing back at the server');
  }
  // Earthy names Geist for its UI stack.
  assert.match(previewThemeCss(flattenTheme(getBuiltin('earthy'), 'light')), /font-family: 'Geist';\s*src: url\('data:/);
  // A node's raw css counts, as it does for an export.
  assert.match(previewThemeCss({ tokens: {}, css: "h1 { font-family: 'Libre Caslon Text'; }" }), /@font-face/);
  // Nothing named, nothing added: the stock fallback look stays as it was.
  for (const empty of [undefined, null, {}, { tokens: {} }, { tokens: { '--wc-font': 'Georgia, serif' }, css: 'p { color: red; }' }]) {
    assert.ok(!/@font-face/.test(previewThemeCss(empty)), `${JSON.stringify(empty)} adds no face`);
  }
  assert.equal(previewThemeCss({ tokens: {} }), '');
});

test('previewThemeCss: the faces go ahead of the raw css, so an unbalanced theme rule cannot swallow them', () => {
  const css = previewThemeCss({ tokens: { '--wc-reading': "'Libre Caslon Text', serif" }, css: 'h1 { color: red' });
  assert.ok(css.indexOf('@font-face') >= 0, 'Caslon is named, so it is inlined');
  assert.ok(css.indexOf('@font-face') < css.indexOf(':root'), 'faces, then tokens');
  assert.ok(css.indexOf(':root') < css.indexOf('h1 { color: red'), 'then the raw css');
});

test('the preview document carries the faces in its head style, under a CSP that admits data: fonts only', () => {
  const html = renderPreviewHtml({ id: 'n1', mounts: [{ id: 'p', html: '<h1>t</h1>' }], store: {} }, georgetown());
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(style, /font-family: 'Libre Caslon Text';\s*src: url\('data:font\/woff2;base64,/);
  const fontSrc = PREVIEW_CSP.split(';').map((d) => d.trim()).filter((d) => d.startsWith('font-src'));
  assert.deepEqual(fontSrc, ['font-src data:'], 'one font-src, data: only — not self, not the network');
  assert.match(PREVIEW_CSP, /default-src 'none'/, 'the floor still stands');
  assert.match(PREVIEW_CSP, /connect-src 'none'/);
});

test('a replay document carries the faces with each theme its frames are filled from', () => {
  const html = assembleReplay({
    steps: [{ id: 'a', label: 'n1.1', theme: 0, node: { id: 'a', mounts: [{ id: 'p', html: '<h1>t</h1>' }], store: {} } }],
    themes: [georgetown()],
  });
  const data = JSON.parse(/<script id="wc-replay-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.match(data.themes[0], /font-family: 'Libre Caslon Text';\s*src: url\('data:font\/woff2;base64,/);
});

test('route: /preview/node and /preview/pane under Georgetown Blue carry Caslon inline, under PREVIEW_CSP', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/theme/apply', { name: 'georgetown-blue', scope: 'global' });
  await api.post('/api/render', { id: 'p1', html: '<h1>Title</h1>' });
  await api.post('/api/commit', { message: 'seed' });
  const active = (await api.get('/api/graph')).json.active;
  for (const url of [`/preview/node/${active}`, `/preview/node/${active}?mode=dark`, `/preview/pane/${active}/p1`]) {
    const r = await api.get(url);
    assert.equal(r.status, 200, url);
    assert.equal(r.headers.get('content-security-policy'), PREVIEW_CSP, url);
    assert.match(r.text, /font-family: 'Libre Caslon Text';\s*src: url\('data:font\/woff2;base64,/, url);
  }
});

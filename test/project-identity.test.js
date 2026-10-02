// The project identity engine: lib/core/project-identity.js (spec §9.2, the
// D11 rulings with their dark variants). The name rules; identity() with the
// dark variants and the mark; each image kind's write rules (square, the dark
// variant's shape, no dark variant without its light image); removal taking
// the dark variant; readImage falling back from dark to light; a corrupt
// project.json reading as the defaults; and project.json staying display-only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pi = require('../lib/core/project-identity');
const { projectPaths } = require('../lib/core/paths');
const { MAX_BYTES } = require('../lib/core/brand-image');
const { run } = require('../lib/update/migrations');
const { withTempHome } = require('../test-support/helpers');
const { encodePng, solid } = require('../test-support/png-encode');

const { ProjectError, NAME_MAX } = pi;

const png = (w, h, rgb = [20, 40, 200]) => encodePng(solid(w, h, rgb), w, h);
const svg = (viewBox, fill = '#041E42') => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"${viewBox ? ` viewBox="${viewBox}"` : ''}><rect width="10" height="10" fill="${fill}"/></svg>`);

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tmpProject(t, name = 'acme-web') {
  const root = path.join(tmpDir(t, 'wc-pid-'), name);
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  return root;
}
const record = (root) => fs.readFileSync(projectPaths(root).projectJson, 'utf8');
const hasRecord = (root) => fs.existsSync(projectPaths(root).projectJson);
const writeRecord = (root, body) => fs.writeFileSync(projectPaths(root).projectJson, typeof body === 'string' ? body : JSON.stringify(body));
// The status a call refuses with, or 200.
function status(fn) {
  try { fn(); return 200; } catch (e) {
    assert.ok(e instanceof ProjectError, `${e.name}: ${e.message}`);
    return e.status;
  }
}
// Keep the store's one-line notices (a link skipped, a file refused) out of
// the suite's output, and hand them back.
function quiet(fn) {
  const orig = console.error;
  const said = [];
  console.error = (m) => said.push(String(m));
  try { return { value: fn(), said }; } finally { console.error = orig; }
}

const DISPLAY_KEYS = ['custom', 'default_name', 'favicon', 'favicon_dark', 'logo', 'logo_dark', 'mark', 'mark_dark', 'name',
  'show_name', 'touch'];

// ── the name ────────────────────────────────────────────────────────────────

test('ProjectError is an Error with a status', () => {
  const e = new ProjectError(422, 'nope');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 422);
  assert.equal(e.message, 'nope');
  assert.equal(e.name, 'ProjectError');
  assert.equal(NAME_MAX, 64);
});

test('defaultName: the folder\'s name, NFC, with nothing the lockup may not show, else web-chat', () => {
  assert.equal(pi.defaultName('/work/acme-web'), 'acme-web');
  assert.equal(pi.defaultName('/work/acme-web/'), 'acme-web');
  assert.equal(pi.defaultName('/work/Cafe\u0301'), 'Caf\u00E9');
  assert.equal(pi.defaultName('/work/evil\u202eexe.txt'), 'evilexe.txt');
  assert.equal(pi.defaultName('/work/\u202e\u200b'), 'web-chat');
  assert.equal(pi.defaultName('/'), 'web-chat');
});

test('normalizeName: NFC, trimmed, whitespace collapsed; empty or null resets', () => {
  assert.deepEqual(pi.normalizeName('Acme Web'), { name: 'Acme Web' });
  assert.deepEqual(pi.normalizeName('  Acme \u00A0  Web\u3000 '), { name: 'Acme Web' });
  assert.deepEqual(pi.normalizeName('Cafe\u0301'), { name: 'Caf\u00E9' });
  for (const empty of ['', '   ', '\u00A0', null, undefined]) {
    assert.deepEqual(pi.normalizeName(empty), { reset: true }, JSON.stringify(empty));
  }
});

test('normalizeName: every control, bidi and invisible character is refused, not cleaned — a newline and a tab too', () => {
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const forbidden = [...range(0x00, 0x1f), 0x7f, ...range(0x80, 0x9f), 0x2028, 0x2029, 0x061c, 0x200e, 0x200f,
    ...range(0x202a, 0x202e), ...range(0x2066, 0x2069), 0x200b, 0xfeff];
  for (const cp of forbidden) {
    const c = String.fromCodePoint(cp);
    for (const s of [`Acme${c}Web`, `${c}Acme`, `Acme${c}`]) {
      assert.equal(status(() => pi.normalizeName(s)), 400, `U+${cp.toString(16).padStart(4, '0')} in ${JSON.stringify(s)}`);
    }
  }
  // even where trimming would have taken it
  assert.equal(status(() => pi.normalizeName('Acme Web\n')), 400);
  assert.equal(status(() => pi.normalizeName('\t')), 400);
});

test('normalizeName: the joiner, variation selectors and the non-joiner are allowed, so emoji and scripts work', () => {
  for (const s of [
    '\u{1F469}\u200D\u{1F4BB} Studio', // a ZWJ sequence
    '\u2764\uFE0F Acme', // VS16
    '\u{1F1EF}\u{1F1F5} Tokyo', // a flag
    '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', // a ZWNJ in Persian
    '\u05E2\u05D1\u05E8\u05D9\u05EA', // a right-to-left name with no control characters
  ]) {
    assert.deepEqual(pi.normalizeName(s), { name: s.normalize('NFC') });
  }
});

test('normalizeName: 1 to 64 code points; a string, nothing else', () => {
  const grin = '\u{1F600}';
  assert.deepEqual(pi.normalizeName(grin.repeat(64)), { name: grin.repeat(64) }, '64 code points (128 UTF-16 units) fit');
  assert.equal(status(() => pi.normalizeName(grin.repeat(65))), 400);
  assert.deepEqual(pi.normalizeName('a'.repeat(64)), { name: 'a'.repeat(64) });
  assert.equal(status(() => pi.normalizeName('a'.repeat(65))), 400);
  assert.deepEqual(pi.normalizeName(`  ${'a'.repeat(64)}  `), { name: 'a'.repeat(64) }, 'counted after trimming');
  for (const v of [42, true, {}, ['Acme']]) assert.equal(status(() => pi.normalizeName(v)), 400, String(v));
});

// ── project.json ────────────────────────────────────────────────────────────

test('identity with nothing set: the folder\'s name and no images', (t) => {
  const root = tmpProject(t);
  assert.deepEqual(pi.identity(root), {
    name: 'acme-web', default_name: 'acme-web', custom: false, show_name: true,
    logo: null, logo_dark: null, favicon: null, favicon_dark: null, touch: null,
    mark: null, mark_dark: false,
  });
  assert.deepEqual(pi.frame(root), { type: 'project', identity: pi.identity(root) });
});

test('setName, setShowName, resetName: one small record, written only when it changes', (t) => {
  const root = tmpProject(t);
  let id = pi.setName(root, '  Acme   Web ');
  assert.equal(id.name, 'Acme Web');
  assert.equal(id.custom, true);
  assert.equal(id.default_name, 'acme-web');
  assert.equal(record(root), '{\n  "name": "Acme Web"\n}\n', '2-space indent, trailing newline');

  const ino = fs.statSync(projectPaths(root).projectJson).ino;
  pi.setName(root, 'Acme Web');
  assert.equal(fs.statSync(projectPaths(root).projectJson).ino, ino, 'the same name again rewrites nothing');

  id = pi.setShowName(root, false);
  assert.equal(id.show_name, false);
  assert.equal(record(root), '{\n  "name": "Acme Web",\n  "show_name": false\n}\n');

  let r = pi.resetName(root);
  assert.equal(r.removed, true);
  assert.equal(r.identity.name, 'acme-web');
  assert.equal(r.identity.custom, false);
  assert.equal(record(root), '{\n  "show_name": false\n}\n', 'the show-name switch is left, so the file stays');

  id = pi.setShowName(root, true);
  assert.equal(id.show_name, true);
  assert.equal(hasRecord(root), false, 'on is the default: nothing is left to store, so there is no file');

  r = pi.resetName(root);
  assert.equal(r.removed, false, 'no name was set');
  assert.equal(hasRecord(root), false);

  pi.setName(root, 'Acme');
  r = pi.resetName(root);
  assert.equal(hasRecord(root), false, 'a reset that leaves nothing removes the file');

  pi.setName(root, 'Acme');
  id = pi.setName(root, '   ');
  assert.equal(id.custom, false, 'an empty name resets');
  assert.equal(hasRecord(root), false);
  assert.equal(pi.setName(root, null).name, 'acme-web');

  assert.equal(status(() => pi.setShowName(root, 'off')), 400);
  assert.equal(status(() => pi.setShowName(root, 0)), 400);
  assert.equal(status(() => pi.setName(root, 'bad\u202ename')), 400);
  assert.equal(hasRecord(root), false, 'a refusal writes nothing');
});

test('a save keeps the keys it does not know', (t) => {
  const root = tmpProject(t);
  writeRecord(root, { name: 'Old', accent: 'teal', future: { a: 1 } });
  pi.setName(root, 'New');
  assert.deepEqual(JSON.parse(record(root)), { name: 'New', accent: 'teal', future: { a: 1 } });
  pi.setShowName(root, false);
  pi.resetName(root);
  assert.deepEqual(JSON.parse(record(root)), { accent: 'teal', future: { a: 1 }, show_name: false });
  pi.setShowName(root, true);
  assert.deepEqual(JSON.parse(record(root)), { accent: 'teal', future: { a: 1 } }, 'unknown keys keep the file');
});

test('a hand-edited name is read as a setter would store it; an empty one is no name', (t) => {
  const root = tmpProject(t);
  writeRecord(root, { name: '  Acme \t Web ' });
  assert.equal(pi.identity(root).corrupt, true, 'a tab is refused on read as on write');
  writeRecord(root, { name: '  Acme   Web ', show_name: true });
  let id = pi.identity(root);
  assert.equal(id.name, 'Acme Web');
  assert.equal(id.custom, true);
  assert.equal(id.corrupt, undefined);
  writeRecord(root, { name: '', show_name: null });
  id = pi.identity(root);
  assert.equal(id.custom, false);
  assert.equal(id.show_name, true);
  assert.equal('corrupt' in id, false);
});

test('a corrupt or wrong-shaped project.json reads as the defaults with corrupt:true, and the next save replaces it', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  const cases = [
    ['torn', '{"name": "Ac'],
    ['an array', '[]'],
    ['a string', '"Acme"'],
    ['null', 'null'],
    ['a number name', { name: 42 }],
    ['a bidi name', { name: 'evil\u202eexe' }],
    ['a name too long', { name: 'x'.repeat(65) }],
    ['a show_name that is not a boolean', { name: 'Acme', show_name: 'no' }],
    ['too big to be one', JSON.stringify({ name: 'Acme', pad: 'x'.repeat(70 * 1024) })],
  ];
  for (const [what, body] of cases) {
    writeRecord(root, body);
    const id = pi.identity(root);
    assert.equal(id.corrupt, true, what);
    assert.equal(id.name, 'acme-web', `${what}: the default name`);
    assert.equal(id.custom, false, what);
    assert.equal(id.show_name, true, what);
  }
  // The next save replaces it…
  writeRecord(root, '{"name": "Ac');
  let id = pi.setName(root, 'Fresh');
  assert.equal(id.corrupt, undefined);
  assert.equal(record(root), '{\n  "name": "Fresh"\n}\n');
  // …and so does a reset, which leaves nothing to store.
  writeRecord(root, '{"name": 7, "accent": "teal"}');
  const r = pi.resetName(root);
  assert.equal(r.removed, false);
  assert.equal(r.identity.corrupt, undefined);
  assert.equal(hasRecord(root), false);
  // A directory in its place is corrupt too, and is never removed.
  fs.mkdirSync(pp.projectJson);
  assert.equal(pi.identity(root).corrupt, true);
  pi.setShowName(root, true);
  assert.ok(fs.statSync(pp.projectJson).isDirectory());
});

test('project.json as a symlink is not followed: corrupt, and a save replaces the link, never its target', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  // A JSON file elsewhere with a `name` — a package.json, say. Following the
  // link would put another file's contents in the topbar, which the portal
  // can show remotely.
  const elsewhere = path.join(tmpDir(t, 'wc-pid-out-'), 'package.json');
  fs.writeFileSync(elsewhere, '{"name":"secret-internal-tool"}');
  fs.symlinkSync(elsewhere, pp.projectJson);
  let id = pi.identity(root);
  assert.equal(id.corrupt, true);
  assert.equal(id.name, 'acme-web', 'not the linked file\'s name');
  id = pi.setName(root, 'Acme');
  assert.ok(fs.lstatSync(pp.projectJson).isFile(), 'the link entry is now the record');
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{"name":"secret-internal-tool"}', 'its target is untouched');
  assert.equal(id.name, 'Acme');
  // and a reset removes a link, not what it points at
  fs.rmSync(pp.projectJson);
  fs.symlinkSync(elsewhere, pp.projectJson);
  pi.resetName(root);
  assert.equal(hasRecord(root), false);
  assert.ok(fs.existsSync(elsewhere));
});

test('a relative root works like the absolute one', (t) => {
  const root = tmpProject(t);
  const rel = path.relative(process.cwd(), root);
  assert.ok(!path.isAbsolute(rel));
  pi.setName(rel, 'Acme');
  pi.writeImage(rel, 'favicon', png(16, 16));
  const id = pi.identity(rel);
  assert.equal(id.name, 'Acme');
  assert.equal(id.default_name, 'acme-web');
  assert.equal(id.mark, 'favicon');
  assert.deepEqual(pi.readImage(rel, 'mark'), { bytes: png(16, 16), type: 'image/png' });
  assert.deepEqual(pi.identity(root), id);
});

test('a folder with no .web-chat/ is not a project: reads give the defaults, writes refuse and create nothing', (t) => {
  const root = path.join(tmpDir(t, 'wc-pid-bare-'), 'plain');
  fs.mkdirSync(root);
  assert.equal(pi.identity(root).name, 'plain');
  assert.equal(status(() => pi.setName(root, 'Acme')), 404);
  assert.equal(status(() => pi.setShowName(root, false)), 404);
  assert.equal(status(() => pi.writeImage(root, 'logo', png(4, 1))), 404);
  assert.equal(pi.resetName(root).removed, false);
  assert.equal(pi.removeImage(root, 'logo').removed, false);
  assert.deepEqual(fs.readdirSync(root), [], 'no .web-chat/ was made');
});

// ── images ──────────────────────────────────────────────────────────────────

test('the image kinds and the identity fields they report as', () => {
  assert.deepEqual(pi.IMAGE_FIELDS, {
    logo: 'logo', favicon: 'favicon', touch: 'touch', 'logo-dark': 'logo_dark', 'favicon-dark': 'favicon_dark',
  });
  assert.deepEqual(pi.READ_KINDS, ['logo', 'favicon', 'touch', 'mark']);
});

test('writeImage: a logo of any shape; its metadata in the identity', (t) => {
  const root = tmpProject(t);
  const wide = png(40, 10);
  const r = pi.writeImage(root, 'logo', wide);
  assert.equal(r.type, 'image/png');
  assert.equal(r.bytes, wide.length);
  assert.equal(r.dark_removed, false);
  const { logo } = r.identity;
  assert.deepEqual({ ...logo, version: typeof logo.version }, { type: 'image/png', bytes: wide.length, version: 'string', width: 40, height: 10 });
  const st = fs.statSync(`${projectPaths(root).projectLogo}.png`);
  assert.equal(logo.version, `${Math.round(st.mtimeMs)}-${st.size}`);
  assert.equal(r.identity.mark, null, 'a wide logo is no mark');
  pi.writeImage(root, 'logo', svg('0 0 300 40'));
  assert.equal(pi.identity(root).logo.type, 'image/svg+xml');
  pi.writeImage(root, 'logo', svg(null));
  assert.equal(pi.identity(root).logo.width, null, 'an SVG logo needs no viewBox');
  assert.deepEqual(fs.readdirSync(projectPaths(root).dir), ['project-logo.svg']);
});

test('writeImage: validate()\'s refusals, as ProjectError, and an unknown kind', (t) => {
  const root = tmpProject(t);
  for (const kind of Object.keys(pi.IMAGE_FIELDS)) {
    assert.equal(status(() => pi.writeImage(root, kind, Buffer.alloc(0))), 400, kind);
    assert.equal(status(() => pi.writeImage(root, kind, Buffer.concat([png(2, 2), Buffer.alloc(MAX_BYTES)]))), 413, kind);
    assert.equal(status(() => pi.writeImage(root, kind, Buffer.from('GIF89a....'))), 415, kind);
    assert.equal(status(() => pi.writeImage(root, kind, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>x()</script></svg>'))), 422, kind);
  }
  for (const kind of ['mark', 'wordmark', '../project', '', null, 'constructor', '__proto__']) {
    assert.equal(status(() => pi.writeImage(root, kind, png(2, 2))), 400, String(kind));
    assert.equal(status(() => pi.removeImage(root, kind)), 400, String(kind));
  }
  assert.deepEqual(fs.readdirSync(projectPaths(root).dir), [], 'no refusal wrote anything');
});

test('writeImage: a favicon and a touch icon are square, within 2%; a touch icon is a PNG', (t) => {
  const root = tmpProject(t);
  for (const kind of ['favicon', 'touch']) {
    assert.equal(status(() => pi.writeImage(root, kind, png(32, 16))), 422, `${kind}: 2:1`);
    assert.equal(status(() => pi.writeImage(root, kind, png(100, 97))), 422, `${kind}: 3% off`);
    assert.equal(status(() => pi.writeImage(root, kind, png(50, 49))), 200, `${kind}: 2% off counts as square`);
    assert.equal(status(() => pi.writeImage(root, kind, png(32, 32))), 200, kind);
  }
  assert.equal(status(() => pi.writeImage(root, 'favicon', svg('0 0 24 24'))), 200, 'an SVG favicon with a square viewBox');
  assert.equal(status(() => pi.writeImage(root, 'favicon', svg(null))), 422, 'an SVG favicon must say its shape');
  assert.equal(status(() => pi.writeImage(root, 'favicon', svg('0 0 24 12'))), 422);
  assert.equal(status(() => pi.writeImage(root, 'touch', svg('0 0 24 24'))), 415, 'a touch icon is a PNG');
  const id = pi.identity(root);
  assert.equal(id.favicon.type, 'image/svg+xml');
  assert.equal(id.touch.width, 32);
  try { pi.writeImage(root, 'favicon', png(32, 16)); } catch (e) { assert.match(e.message, /square.*32x16/); }
});

test('writeImage: a dark variant needs its light image (409) and its shape, within 2% (422)', (t) => {
  const root = tmpProject(t);
  assert.equal(status(() => pi.writeImage(root, 'logo-dark', png(40, 10))), 409);
  assert.equal(status(() => pi.writeImage(root, 'favicon-dark', png(32, 32))), 409);
  try { pi.writeImage(root, 'logo-dark', png(40, 10)); } catch (e) { assert.match(e.message, /set the logo first/); }

  pi.writeImage(root, 'logo', png(100, 25)); // 4:1
  assert.equal(status(() => pi.writeImage(root, 'logo-dark', png(100, 50))), 422, '2:1 beside 4:1');
  assert.equal(status(() => pi.writeImage(root, 'logo-dark', png(104, 25))), 422, 'an aspect 4% off');
  assert.equal(status(() => pi.writeImage(root, 'logo-dark', svg(null))), 422, 'an SVG with no viewBox has no shape to compare');
  assert.equal(status(() => pi.writeImage(root, 'logo-dark', png(101, 25))), 200, 'an aspect 1% off');
  assert.equal(status(() => pi.writeImage(root, 'logo-dark', png(200, 50))), 200, 'the same shape at another size');
  assert.equal(status(() => pi.writeImage(root, 'logo-dark', svg('0 0 4 1'))), 200, 'an SVG whose viewBox has the shape');
  let id = pi.identity(root);
  assert.equal(id.logo_dark.type, 'image/svg+xml');
  assert.equal(id.mark, null, 'a wide logo and its dark variant: still no mark');
  assert.equal(id.mark_dark, false);

  pi.writeImage(root, 'favicon', png(32, 32));
  assert.equal(status(() => pi.writeImage(root, 'favicon-dark', png(32, 30))), 422, 'a dark favicon is square too');
  assert.equal(status(() => pi.writeImage(root, 'favicon-dark', png(64, 64))), 200);
  id = pi.identity(root);
  assert.equal(id.favicon_dark.width, 64);
  assert.equal(id.mark, 'favicon');
  assert.equal(id.mark_dark, true);
});

test('the mark: the favicon when set, else the logo when square, else none', (t) => {
  const root = tmpProject(t);
  assert.equal(pi.identity(root).mark, null);
  pi.writeImage(root, 'logo', png(40, 10));
  assert.equal(pi.identity(root).mark, null, 'a wide logo');
  pi.writeImage(root, 'logo', png(40, 40));
  assert.equal(pi.identity(root).mark, 'logo', 'a square logo');
  pi.writeImage(root, 'logo', png(50, 49));
  assert.equal(pi.identity(root).mark, 'logo', 'nearly square counts');
  pi.writeImage(root, 'logo-dark', png(50, 49, [200, 160, 20]));
  let id = pi.identity(root);
  assert.equal(id.mark_dark, true, 'the square logo\'s dark variant');
  pi.writeImage(root, 'favicon', png(32, 32));
  id = pi.identity(root);
  assert.equal(id.mark, 'favicon', 'a favicon beats a square logo');
  assert.equal(id.mark_dark, false, 'the favicon has no dark variant, whatever the logo has');
  pi.writeImage(root, 'logo', png(40, 10));
  assert.equal(pi.identity(root).mark, 'favicon');
  pi.removeImage(root, 'favicon');
  assert.equal(pi.identity(root).mark, null, 'no favicon and a wide logo: none');
});

test('replacing a light image with different bytes takes its dark variant; the same bytes keep it', (t) => {
  const root = tmpProject(t);
  const logo = png(40, 10);
  pi.writeImage(root, 'logo', logo);
  pi.writeImage(root, 'logo-dark', png(40, 10, [230, 200, 40]));
  let r = pi.writeImage(root, 'logo', logo);
  assert.equal(r.dark_removed, false);
  assert.ok(r.identity.logo_dark, 'the same light image again keeps its variant');
  r = pi.writeImage(root, 'logo', png(40, 10, [1, 2, 3]));
  assert.equal(r.dark_removed, true, 'a new light image: the old variant was made for the old one');
  assert.equal(r.identity.logo_dark, null);
  assert.equal(fs.existsSync(`${projectPaths(root).projectLogoDark}.png`), false);
  // A dark variant's own write never touches its light image.
  pi.writeImage(root, 'logo-dark', png(80, 20));
  assert.equal(pi.writeImage(root, 'logo-dark', png(40, 10)).dark_removed, false);
  assert.ok(pi.identity(root).logo);
});

test('removeImage: a light image takes its dark variant; a dark variant goes alone; the touch icon stays', (t) => {
  const root = tmpProject(t);
  pi.writeImage(root, 'logo', png(40, 10));
  pi.writeImage(root, 'logo-dark', png(40, 10, [230, 200, 40]));
  pi.writeImage(root, 'favicon', png(16, 16));
  pi.writeImage(root, 'favicon-dark', png(16, 16, [230, 200, 40]));
  pi.writeImage(root, 'touch', png(18, 18));

  let r = pi.removeImage(root, 'logo-dark');
  assert.equal(r.removed, true);
  assert.equal(r.identity.logo_dark, null);
  assert.ok(r.identity.logo, 'the light logo stays');
  pi.writeImage(root, 'logo-dark', png(40, 10, [230, 200, 40]));

  r = pi.removeImage(root, 'logo');
  assert.equal(r.removed, true);
  assert.equal(r.identity.logo, null);
  assert.equal(r.identity.logo_dark, null, 'and its dark variant with it');
  assert.equal(fs.existsSync(`${projectPaths(root).projectLogoDark}.png`), false);

  r = pi.removeImage(root, 'favicon');
  assert.equal(r.identity.favicon, null);
  assert.equal(r.identity.favicon_dark, null);
  assert.ok(r.identity.touch, 'the touch icon is not a dark variant: it stays');
  assert.equal(pi.removeImage(root, 'favicon').removed, false, 'nothing left to remove');
  assert.equal(pi.removeImage(root, 'touch').removed, true);
  assert.deepEqual(fs.readdirSync(projectPaths(root).dir), []);
});

test('readImage: dark gives the dark variant when one is set, else the light image; the mark resolves by the rule', (t) => {
  const root = tmpProject(t);
  for (const kind of pi.READ_KINDS) {
    assert.equal(pi.readImage(root, kind), null, kind);
    assert.equal(pi.readImage(root, kind, { dark: true }), null, kind);
  }
  const logo = png(40, 40);
  const logoDark = png(40, 40, [230, 200, 40]);
  pi.writeImage(root, 'logo', logo);
  assert.deepEqual(pi.readImage(root, 'logo'), { bytes: logo, type: 'image/png' });
  assert.deepEqual(pi.readImage(root, 'logo', { dark: true }), { bytes: logo, type: 'image/png' }, 'no dark variant: the light one');
  assert.deepEqual(pi.readImage(root, 'mark', { dark: true }), { bytes: logo, type: 'image/png' }, 'a square logo is the mark');
  pi.writeImage(root, 'logo-dark', logoDark);
  assert.deepEqual(pi.readImage(root, 'logo', { dark: true }), { bytes: logoDark, type: 'image/png' });
  assert.deepEqual(pi.readImage(root, 'logo', { dark: false }), { bytes: logo, type: 'image/png' });
  assert.deepEqual(pi.readImage(root, 'mark', { dark: true }), { bytes: logoDark, type: 'image/png' });

  const fav = svg('0 0 16 16', '#123456');
  pi.writeImage(root, 'favicon', fav);
  assert.deepEqual(pi.readImage(root, 'mark'), { bytes: fav, type: 'image/svg+xml' }, 'the favicon is the mark now');
  assert.deepEqual(pi.readImage(root, 'mark', { dark: true }), { bytes: fav, type: 'image/svg+xml' },
    'the favicon has no dark variant: its light image, never the logo\'s dark one');
  const favDark = svg('0 0 32 32', '#c79a12');
  pi.writeImage(root, 'favicon-dark', favDark);
  assert.deepEqual(pi.readImage(root, 'favicon', { dark: true }), { bytes: favDark, type: 'image/svg+xml' });
  assert.deepEqual(pi.readImage(root, 'mark', { dark: true }), { bytes: favDark, type: 'image/svg+xml' });

  const touch = png(18, 18);
  pi.writeImage(root, 'touch', touch);
  assert.deepEqual(pi.readImage(root, 'touch', { dark: true }), { bytes: touch, type: 'image/png' }, 'a touch icon has no dark variant');
  for (const kind of ['logo-dark', 'favicon-dark', 'wordmark', undefined]) assert.equal(pi.readImage(root, kind), null, String(kind));
});

test('what is on disk is held to the write rules: a committed .web-chat/ cannot show what an upload could not', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  const put = (base, ext, bytes) => fs.writeFileSync(`${base}.${ext}`, bytes);
  const { value: id, said } = quiet(() => {
    put(pp.projectFavicon, 'png', png(32, 16)); // not square
    put(pp.projectTouchIcon, 'svg', svg('0 0 10 10')); // a touch icon that is not a PNG
    put(pp.projectLogoDark, 'png', png(40, 10)); // a dark variant with no light image
    put(pp.projectFaviconDark, 'png', png(16, 16)); // beside a favicon that does not count
    fs.symlinkSync(path.join(pp.dir, 'elsewhere.png'), `${pp.projectLogo}.png`); // a link, dangling
    return pi.identity(root);
  });
  assert.equal(id.favicon, null);
  assert.equal(id.favicon_dark, null);
  assert.equal(id.touch, null);
  assert.equal(id.logo, null);
  assert.equal(id.logo_dark, null);
  assert.equal(id.mark, null);
  assert.ok(said.some((m) => /project-logo\.png: it is a symlink/.test(m)), 'the link is named in the log');
  assert.equal(quiet(() => pi.readImage(root, 'favicon')).value, null);
  assert.equal(quiet(() => pi.readImage(root, 'touch')).value, null);
  assert.equal(quiet(() => pi.readImage(root, 'mark')).value, null);

  // A dark variant whose light image is there but of another shape.
  fs.rmSync(`${pp.projectLogo}.png`);
  put(pp.projectLogo, 'png', png(30, 30));
  const again = quiet(() => pi.identity(root)).value;
  assert.ok(again.logo);
  assert.equal(again.logo_dark, null, 'a 4:1 dark variant beside a square logo does not count');
  assert.equal(again.mark, 'logo');
  assert.equal(again.mark_dark, false);
  assert.deepEqual(quiet(() => pi.readImage(root, 'mark', { dark: true })).value.bytes, png(30, 30), 'so dark mode shows the light mark');
});

// ── display-only ────────────────────────────────────────────────────────────

test('project.json is display-only: a key that widens access is never read, reported or acted on', (t) => {
  const root = tmpProject(t);
  writeRecord(root, {
    name: 'Acme', show_name: false,
    mirror: 'full', remote: true, mirror_network: true, trust: ['git-dashboard'], expose: '0.0.0.0', no_remote: false,
  });
  const id = pi.identity(root);
  assert.deepEqual(Object.keys(id).sort(), DISPLAY_KEYS, 'the identity carries display fields only');
  assert.deepEqual(Object.keys(pi.frame(root).identity).sort(), DISPLAY_KEYS);
  assert.equal(id.name, 'Acme');
  assert.equal(id.show_name, false);
  // Kept across a save (they are not this build's to delete), never interpreted.
  pi.setName(root, 'Acme Web');
  assert.equal(JSON.parse(record(root)).remote, true);
  assert.deepEqual(Object.keys(pi.identity(root)).sort(), DISPLAY_KEYS);
});

test('only the identity engine reads project.json: no other file in lib/, bin/ or scripts/ names it', () => {
  const REPO = path.join(__dirname, '..');
  // The path authority mints it; the engine is its one reader and writer. Any
  // other reader is where an access setting could start being honoured from a
  // file a repository ships — add one here only with the reason it is safe.
  const ALLOWED = new Set(['lib/core/paths.js', 'lib/core/project-identity.js']);
  const offenders = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(r); continue; }
      if (!/\.(c|m)?js$/.test(e.name) || ALLOWED.has(r)) continue;
      const src = fs.readFileSync(path.join(REPO, r), 'utf8');
      if (/\bprojectJson\b|project\.json/.test(src)) offenders.push(r);
    }
  };
  for (const dir of ['lib', 'bin', 'scripts']) if (fs.existsSync(path.join(REPO, dir))) walk(dir);
  assert.deepEqual(offenders, []);
});

test('the v2→v3 brand migration leaves the identity\'s files alone: they sit outside .web-chat/brand/', (t) => {
  withTempHome(t);
  const root = tmpProject(t);
  const pp = projectPaths(root);
  fs.writeFileSync(pp.version, JSON.stringify({ version: 2 }) + '\n');
  fs.mkdirSync(pp.brandDir, { recursive: true });
  fs.writeFileSync(path.join(pp.brandDir, 'logotype.png'), png(4, 1)); // a 0.8.0 brand image, which moves
  pi.setName(root, 'Acme');
  pi.writeImage(root, 'logo', png(40, 10));
  pi.writeImage(root, 'logo-dark', png(40, 10, [230, 200, 40]));
  pi.writeImage(root, 'favicon', svg('0 0 16 16'));
  pi.writeImage(root, 'touch', png(18, 18));
  const files = ['project.json', 'project-logo.png', 'project-logo-dark.png', 'project-favicon.svg', 'project-touch-icon.png'];
  const before = Object.fromEntries(files.map((f) => {
    const p = path.join(pp.dir, f);
    return [f, { bytes: fs.readFileSync(p), mtime: fs.statSync(p).mtimeMs, ino: fs.statSync(p).ino }];
  }));
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try { run(pp.dir); } finally { process.stderr.write = orig; }
  assert.ok(fs.existsSync(path.join(pp.brandThemeDir('earthy'), 'logotype.png')), 'the brand image moved');
  for (const f of files) {
    const p = path.join(pp.dir, f);
    assert.deepEqual(fs.readFileSync(p), before[f].bytes, f);
    assert.equal(fs.statSync(p).mtimeMs, before[f].mtime, `${f}: not rewritten`);
    assert.equal(fs.statSync(p).ino, before[f].ino, `${f}: not moved`);
  }
  assert.equal(pi.identity(root).name, 'Acme');
});

test('project-identity imports only lib/core and Node built-ins', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'project-identity.js'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  for (const r of reqs) assert.ok(/^\.\/[a-z-]+$/.test(r) || ['fs', 'path'].includes(r), r);
});

// The one store for a logo-type image under .web-chat/ (lib/core/image-file),
// and the bytes half of the durable-write idiom it writes through
// (lib/core/fsjson writeFileAtomic). Spec §9.2: `<base>.svg` OR `<base>.png`,
// lstat and regular files only (a symlink is skipped and logged once), every
// path fenced to .web-chat/, the newer of two formats wins, re-checked on read,
// and no write ever follows a link.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomic, writeJsonAtomic } = require('../lib/core/fsjson');
const { imageFile, imageSize } = require('../lib/core/image-file');
const { BrandError, MAX_BYTES } = require('../lib/core/brand-image');
const { projectPaths } = require('../lib/core/paths');
const { encodePng, solid } = require('../test-support/png-encode');

const png = (w, h, rgb = [20, 40, 200]) => encodePng(solid(w, h, rgb), w, h);
const svg = (viewBox, fill = '#041E42') => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg"${viewBox ? ` viewBox="${viewBox}"` : ''}><rect width="10" height="10" fill="${fill}"/></svg>`);

function tmpDir(t, prefix = 'wc-img-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tmpProject(t) {
  const root = tmpDir(t, 'wc-img-proj-');
  fs.mkdirSync(projectPaths(root).dir);
  return root;
}
// An image store whose notices are collected rather than printed.
function store(root, base) {
  const notes = [];
  return { img: imageFile(root, base, { log: (m) => notes.push(m) }), notes };
}
const ls = (dir) => fs.readdirSync(dir).sort();
// Wall-clock bounds hold only under WEB_CHAT_PERF=1 (spec §10.1: a loaded
// machine stalls); by default the measurement is just logged.
const SVG_PERF_OK = (ms) => {
  if (process.env.WEB_CHAT_PERF === '1') return ms < 1000;
  if (ms > 1000) console.log(`imageSize on hostile input took ${ms} ms`);
  return true;
};
const status = (fn) => { try { fn(); return 200; } catch (e) { assert.ok(e instanceof BrandError, e.message); return e.status; } };

// ── fsjson.writeFileAtomic ──────────────────────────────────────────────────

test('writeFileAtomic: lands the exact bytes, returns the path, leaves no temp file', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'img.png');
  const bytes = png(3, 2);
  assert.equal(writeFileAtomic(f, bytes), f);
  assert.deepEqual(fs.readFileSync(f), bytes);
  assert.deepEqual(ls(dir), ['img.png']);
  writeFileAtomic(f, 'naïve — text');
  assert.equal(fs.readFileSync(f, 'utf8'), 'naïve — text', 'a string is written as UTF-8');
  const nested = path.join(dir, 'a', 'b', 'c.bin');
  writeFileAtomic(nested, Buffer.from([0, 1, 2]), { fsync: true });
  assert.deepEqual(fs.readFileSync(nested), Buffer.from([0, 1, 2]), 'mkdir by default, and fsync lands the same bytes');
  assert.throws(() => writeFileAtomic(path.join(dir, 'nope', 'x.bin'), 'x', { mkdir: false }), /ENOENT/);
  assert.deepEqual(ls(dir), ['a', 'img.png'], 'a failed write leaves no temp file');
});

test('writeJsonAtomic writes exactly the bytes it wrote before writeFileAtomic existed', (t) => {
  const dir = tmpDir(t);
  // Golden output: JSON.stringify(value, null, pretty), plus '\n' when asked —
  // what writeJsonAtomic wrote before it became a call to writeFileAtomic.
  const golden = [
    [{ a: 1 }, {}, '{\n  "a": 1\n}'],
    [{ a: 1 }, { newline: true }, '{\n  "a": 1\n}\n'],
    [{ a: 1, b: [1, 'x', null] }, { pretty: 0 }, '{"a":1,"b":[1,"x",null]}'],
    [{ name: 'Acme Web', show_name: false }, { pretty: 2, newline: true }, '{\n  "name": "Acme Web",\n  "show_name": false\n}\n'],
    [{ é: 'naïve', e: '👩\u200D💻' }, { pretty: 4 }, '{\n    "é": "naïve",\n    "e": "👩\u200D💻"\n}'],
    [[], {}, '[]'],
    ['s', { newline: true }, '"s"\n'],
    [null, { fsync: true }, 'null'],
  ];
  for (const [i, [value, opts, want]] of golden.entries()) {
    const a = writeJsonAtomic(path.join(dir, `a${i}.json`), value, opts);
    assert.equal(fs.readFileSync(a, 'utf8'), want, `case ${i}`);
    const body = JSON.stringify(value, null, opts.pretty ?? 2) + (opts.newline ? '\n' : '');
    const b = writeFileAtomic(path.join(dir, `b${i}.json`), body);
    assert.deepEqual(fs.readFileSync(b), fs.readFileSync(a), `case ${i}: the two halves agree byte for byte`);
  }
  assert.deepEqual(ls(dir).filter((f) => f.includes('.tmp')), [], 'no temp file left behind');
});

test('writeFileAtomic never writes through a link at the destination: it replaces the link', (t) => {
  const dir = tmpDir(t);
  const outside = path.join(tmpDir(t, 'wc-img-out-'), 'target.json');
  fs.writeFileSync(outside, '{"keep":true}');
  const f = path.join(dir, 'rec.json');
  fs.symlinkSync(outside, f);
  writeFileAtomic(f, Buffer.from('new'));
  assert.ok(fs.lstatSync(f).isFile(), 'the link entry is now a regular file');
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"keep":true}', 'its target is untouched');
  // The JSON half is the same write.
  const g = path.join(dir, 'other.json');
  fs.symlinkSync(outside, g);
  writeJsonAtomic(g, { a: 1 });
  assert.ok(fs.lstatSync(g).isFile());
  assert.equal(fs.readFileSync(outside, 'utf8'), '{"keep":true}');
});

test('writeFileAtomic never writes through a link planted at its temp name', (t) => {
  const dir = tmpDir(t);
  const outsideDir = tmpDir(t, 'wc-img-out-');
  const outside = path.join(outsideDir, 'victim');
  fs.writeFileSync(outside, 'precious');
  const f = path.join(dir, 'img.png');
  const tmpName = `${f}.${process.pid}.tmp`;
  fs.symlinkSync(outside, tmpName);
  writeFileAtomic(f, Buffer.from('bytes'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'precious', 'the planted link was not followed');
  assert.equal(fs.readFileSync(f, 'utf8'), 'bytes');
  assert.deepEqual(ls(dir), ['img.png'], 'and nothing is left at the temp name');
  // a dangling one too: following it would CREATE a file outside
  const dangling = path.join(outsideDir, 'created');
  fs.symlinkSync(dangling, tmpName);
  writeJsonAtomic(f, { a: 1 });
  assert.equal(fs.existsSync(dangling), false, 'nothing was created through the dangling link');
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": 1\n}');
  assert.deepEqual(ls(dir), ['img.png']);
});

test('the per-pid temp spelling still occurs once in fsjson.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'fsjson.js'), 'utf8');
  // The conventions tripwire's own pattern for the idiom.
  assert.equal((src.match(/\$\{process\.pid\}\.tmp|\.tmp-\$\{process\.pid\}/g) || []).length, 1);
});

// ── imageFile: the basics ───────────────────────────────────────────────────

test('imageFile takes an absolute, extension-less base', (t) => {
  const root = tmpProject(t);
  assert.throws(() => imageFile(root, 'project-logo'), TypeError);
  assert.throws(() => imageFile(root, `${projectPaths(root).projectLogo}.png`), TypeError);
  assert.throws(() => imageFile('', projectPaths(root).projectLogo), TypeError);
  assert.doesNotThrow(() => imageFile(root, projectPaths(root).projectLogo));
});

test('write, read, meta: one file per image, its size from the PNG or the viewBox', (t) => {
  const root = tmpProject(t);
  const base = projectPaths(root).projectLogo;
  const { img } = store(root, base);
  assert.equal(img.locate(), null);
  assert.equal(img.read(), null);
  assert.equal(img.meta(), null);
  assert.equal(img.remove(), false, 'nothing to remove');

  const p = png(8, 2);
  assert.deepEqual(img.write(p), { type: 'image/png', bytes: p.length });
  assert.deepEqual(ls(projectPaths(root).dir), ['project-logo.png']);
  assert.deepEqual(img.read(), { bytes: p, type: 'image/png' });
  const hit = img.locate();
  assert.equal(hit.file, `${base}.png`);
  assert.equal(hit.ext, 'png');
  assert.equal(hit.type, 'image/png');
  const m = img.meta();
  assert.deepEqual({ ...m, version: undefined }, { type: 'image/png', bytes: p.length, version: undefined, width: 8, height: 2 });
  const st = fs.statSync(`${base}.png`);
  assert.equal(m.version, `${Math.round(st.mtimeMs)}-${st.size}`);

  const s = svg('0 0 40 20');
  assert.deepEqual(img.write(s), { type: 'image/svg+xml', bytes: s.length });
  assert.deepEqual(ls(projectPaths(root).dir), ['project-logo.svg'], 'the other format is dropped');
  assert.deepEqual(img.read(), { bytes: s, type: 'image/svg+xml' });
  const ms = img.meta();
  assert.equal(ms.width, 40);
  assert.equal(ms.height, 20);
  assert.notEqual(ms.version, m.version);

  img.write(svg(null));
  assert.equal(img.meta().width, null, 'an SVG with no viewBox has no known size');
  assert.equal(img.meta().height, null);

  assert.equal(img.remove(), true);
  assert.deepEqual(ls(projectPaths(root).dir), []);
  assert.equal(img.read(), null);
});

test('write refuses what validate() refuses, and writes nothing', (t) => {
  const root = tmpProject(t);
  const { img } = store(root, projectPaths(root).projectFavicon);
  assert.equal(status(() => img.write(Buffer.alloc(0))), 400);
  assert.equal(status(() => img.write('not a buffer')), 400);
  assert.equal(status(() => img.write(Buffer.concat([png(1, 1), Buffer.alloc(MAX_BYTES)]))), 413);
  assert.equal(status(() => img.write(Buffer.from('GIF89a....'))), 415);
  assert.equal(status(() => img.write(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>'))), 422);
  assert.deepEqual(ls(projectPaths(root).dir), []);
});

// ── links ───────────────────────────────────────────────────────────────────

test('a symlink is never an image: skipped wherever it points, and logged once', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  const inside = path.join(pp.dir, 'captures', 'shot.png');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, png(4, 4));
  const outside = path.join(tmpDir(t, 'wc-img-out-'), 'secret.png');
  fs.writeFileSync(outside, png(4, 4));

  for (const [label, target] of [['inside .web-chat', inside], ['outside', outside], ['dangling', path.join(pp.dir, 'nope.png')]]) {
    fs.rmSync(`${pp.projectLogo}.png`, { force: true });
    fs.symlinkSync(target, `${pp.projectLogo}.png`);
    const { img, notes } = store(root, pp.projectLogo);
    assert.equal(img.locate(), null, label);
    assert.equal(img.read(), null, label);
    assert.equal(img.meta(), null, label);
    img.locate();
    img.read();
    assert.equal(notes.length, 1, `${label}: one notice for the link, however often it is asked`);
    assert.match(notes[0], /project-logo\.png: it is a symlink/);
  }
  // A real file beside the link is still found.
  fs.writeFileSync(`${pp.projectLogo}.svg`, svg('0 0 2 1'));
  assert.equal(store(root, pp.projectLogo).img.locate().ext, 'svg');
});

test('a write replaces a link at the image, never writing through it', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  // The spec's case: a committed project-logo.png -> graph/_meta.json.
  fs.mkdirSync(pp.graphDir, { recursive: true });
  const meta = '{"active":"n1","nodes":["n1"]}';
  fs.writeFileSync(pp.meta, meta);
  fs.symlinkSync(pp.meta, `${pp.projectLogo}.png`);
  // and an SVG slot linked out of the project, dangling
  const outsideDir = tmpDir(t, 'wc-img-out-');
  fs.symlinkSync(path.join(outsideDir, 'planted.svg'), `${pp.projectLogo}.svg`);

  const { img } = store(root, pp.projectLogo);
  const p = png(2, 2);
  img.write(p);
  assert.equal(fs.readFileSync(pp.meta, 'utf8'), meta, 'graph state is untouched');
  assert.ok(fs.lstatSync(`${pp.projectLogo}.png`).isFile(), 'the link entry is now the image itself');
  assert.deepEqual(fs.readFileSync(`${pp.projectLogo}.png`), p);
  assert.equal(fs.existsSync(`${pp.projectLogo}.svg`), false, 'the other format, a link, is unlinked');
  assert.deepEqual(ls(outsideDir), [], 'and nothing was created through it');
  assert.deepEqual(img.read(), { bytes: p, type: 'image/png' });
});

test('remove unlinks a link, never its target', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  const outside = path.join(tmpDir(t, 'wc-img-out-'), 'logo.png');
  fs.writeFileSync(outside, png(2, 2));
  fs.symlinkSync(outside, `${pp.projectFavicon}.png`);
  fs.writeFileSync(`${pp.projectFavicon}.svg`, svg('0 0 1 1'));
  const { img } = store(root, pp.projectFavicon);
  assert.equal(img.remove(), true);
  assert.deepEqual(ls(pp.dir), [], 'both formats are gone, the link with them');
  assert.deepEqual(fs.readFileSync(outside), png(2, 2), 'the link\'s target is untouched');
  assert.equal(img.remove(), false);
  // A directory at the image's name is not an image and is not removed.
  fs.mkdirSync(`${pp.projectFavicon}.png`);
  assert.equal(img.remove(), false);
  assert.ok(fs.statSync(`${pp.projectFavicon}.png`).isDirectory());
  assert.equal(img.locate(), null);
});

test('fenced: a folder that is, or is reached through, a link out of .web-chat is never read, written or cleared', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  const outside = tmpDir(t, 'wc-img-out-');
  fs.writeFileSync(path.join(outside, 'seal.png'), png(2, 2));
  fs.mkdirSync(pp.brandThemesDir, { recursive: true });
  fs.symlinkSync(outside, pp.brandThemeDir('earthy'));
  const { img } = store(root, path.join(pp.brandThemeDir('earthy'), 'seal'));
  assert.equal(img.locate(), null);
  assert.equal(img.read(), null);
  assert.equal(img.meta(), null);
  assert.equal(status(() => img.write(png(3, 3))), 400);
  assert.equal(img.remove(), false);
  assert.deepEqual(ls(outside), ['seal.png'], 'nothing was written or removed outside');
  assert.deepEqual(fs.readFileSync(path.join(outside, 'seal.png')), png(2, 2));
  // and a base outside .web-chat altogether
  const stray = store(root, path.join(root, 'logo')).img;
  assert.equal(status(() => stray.write(png(1, 1))), 400);
  assert.equal(fs.existsSync(path.join(root, 'logo.png')), false);
});

test('only a regular file is an image: a FIFO at its name is skipped, and nothing blocks on it', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  try {
    require('child_process').execFileSync('mkfifo', [`${pp.projectLogo}.png`], { stdio: 'ignore' });
  } catch {
    t.skip('mkfifo is not available here');
    return;
  }
  const { img } = store(root, pp.projectLogo);
  assert.equal(img.locate(), null);
  assert.equal(img.read(), null);
  assert.equal(img.meta(), null);
  img.write(png(2, 2));
  assert.ok(fs.lstatSync(`${pp.projectLogo}.png`).isFile(), 'a write replaces it with the image');
});

// ── what is read back ───────────────────────────────────────────────────────

test('a file that is not what its extension says reads as null (and says so once)', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  for (const [ext, bytes] of [['png', svg('0 0 1 1')], ['svg', png(1, 1)], ['png', Buffer.from('<html><script>1</script></html>')]]) {
    fs.rmSync(`${pp.projectLogo}.png`, { force: true });
    fs.rmSync(`${pp.projectLogo}.svg`, { force: true });
    fs.writeFileSync(`${pp.projectLogo}.${ext}`, bytes);
    const { img, notes } = store(root, pp.projectLogo);
    assert.equal(img.locate().ext, ext, 'it is located…');
    assert.equal(img.read(), null, `…but a .${ext} holding other bytes is not read`);
    assert.equal(img.meta(), null);
    assert.equal(notes.length, 1);
  }
});

test('read: a file placed by hand over the size limit is not read at all', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  fs.writeFileSync(`${pp.projectLogo}.png`, Buffer.concat([png(1, 1), Buffer.alloc(MAX_BYTES)]));
  const big = store(root, pp.projectLogo);
  assert.equal(big.img.read(), null);
  assert.equal(big.img.meta(), null);
  assert.match(big.notes[0], /bytes; the limit is/);
  // The active-SVG refusal is the write's (above). A file placed by hand is
  // re-sniffed, not re-scanned: it is only ever served as an image — an <img>,
  // or a document under BRAND_CSP — where an SVG runs nothing.
  fs.rmSync(`${pp.projectLogo}.png`);
  const active = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(`${pp.projectLogo}.svg`, active);
  assert.deepEqual(store(root, pp.projectLogo).img.read(), { bytes: active, type: 'image/svg+xml' });
});

test('both formats on disk: the newer wins, and the next write leaves one', (t) => {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  const p = png(2, 2);
  const s = svg('0 0 3 1');
  fs.writeFileSync(`${pp.projectLogo}.png`, p);
  fs.writeFileSync(`${pp.projectLogo}.svg`, s);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${pp.projectLogo}.png`, old, old);
  const { img } = store(root, pp.projectLogo);
  assert.equal(img.locate().ext, 'svg');
  assert.deepEqual(img.read(), { bytes: s, type: 'image/svg+xml' });
  assert.equal(img.meta().width, 3);
  fs.utimesSync(`${pp.projectLogo}.svg`, new Date(old - 60_000), new Date(old - 60_000));
  assert.equal(img.locate().ext, 'png', 'the PNG is newer now');
  assert.deepEqual(img.read(), { bytes: p, type: 'image/png' });
  img.write(svg('0 0 5 5'));
  assert.deepEqual(ls(pp.dir), ['project-logo.svg'], 'a write leaves exactly one file');
});

// ── measuring ───────────────────────────────────────────────────────────────

test('imageSize: the PNG\'s IHDR, or the root SVG\'s viewBox, else null', () => {
  assert.deepEqual(imageSize(png(17, 9)), { width: 17, height: 9 });
  assert.deepEqual(imageSize(svg('0 0 120 60.5')), { width: 120, height: 60.5 });
  assert.deepEqual(imageSize(svg('-5,-5,10,1e1')), { width: 10, height: 10 }, 'commas, negative origin, exponent');
  assert.deepEqual(imageSize(Buffer.from("<svg viewBox='0 0 4 2' xmlns='http://www.w3.org/2000/svg'/>")), { width: 4, height: 2 });
  // The prolog sniff() allows comes first, and markup in it is not the root.
  const prolog = '\ufeff<?xml version="1.0"?>\n<!-- <svg viewBox="0 0 1 1"> -->\n'
    + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n';
  assert.deepEqual(imageSize(Buffer.from(`${prolog}<svg xmlns="http://www.w3.org/2000/svg" data-x="a>b" viewBox="0 0 30 10"/>`)),
    { width: 30, height: 10 });
  // viewBox belongs to the root element only, and the attribute name is exact.
  assert.equal(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><svg viewBox="0 0 9 9"/></svg>')), null);
  assert.equal(imageSize(Buffer.from('<svg data-viewBox="0 0 9 9"/>')), null);
  assert.equal(imageSize(Buffer.from('<svg viewbox="0 0 9 9"/>')), null);
  for (const bad of ['0 0 0 10', '0 0 10 -1', '0 0 10', '0 0 a 10', '0 0 0x10 10', '0 0 Infinity 1', '']) {
    assert.equal(imageSize(svg(bad || null)), null, JSON.stringify(bad));
  }
  assert.equal(imageSize(Buffer.from('GIF89a')), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
  // A truncated PNG has its magic but no IHDR to read.
  assert.equal(imageSize(png(2, 2).subarray(0, 12)), null);
  // And a hostile file cannot make it slow: a long run of unclosed comments,
  // an unclosed start tag, a viewBox number that is a long run of digits.
  const t0 = Date.now();
  assert.equal(imageSize(Buffer.from('<!--'.repeat(60_000))), null);
  assert.equal(imageSize(Buffer.from(`<svg ${'a="b" '.repeat(40_000)}`)), null);
  assert.equal(imageSize(Buffer.from(`<svg viewBox="0 0 ${'1'.repeat(200_000)}x 1"/>`)), null);
  assert.ok(SVG_PERF_OK(Date.now() - t0));
});

test('image-file imports only fs, path and its four lib/core neighbours', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'core', 'image-file.js'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reqs, ['./brand-image', './fsjson', './paths', './png', 'fs', 'path']);
});

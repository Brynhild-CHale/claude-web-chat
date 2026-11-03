// lib/core/element-assets (annotation engine tranche 4, U511; PLAN.md 4A.2,
// DECISIONS.md B3, ruling U511@file-cap a): which files of an element type
// may be served, as what (mediaOf), whether the bytes say so (sniff), and the
// per-file cap (FILE_MAX). Pure: no daemon, no disk.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DRAW_FILE, DRAW_TYPE, ASSET_TYPES, FILE_MAX, mediaOf, sniff,
} = require('../lib/core/element-assets');
const { encodePng } = require('../lib/core/png');
const brandImage = require('../lib/core/brand-image');

const PNG = encodePng(Buffer.alloc(4 * 4 * 4, 0x80), 4, 4);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n');
const ACTIVE_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
function webp() {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(24, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  return b;
}
function woff2() {
  const b = Buffer.alloc(64);
  b.write('wOF2', 0, 'latin1');
  return b;
}

test('FILE_MAX is 262144 bytes (ruling U511@file-cap a: brand-image\'s precedent)', () => {
  assert.equal(FILE_MAX, 262144);
  assert.equal(FILE_MAX, brandImage.MAX_BYTES);
});

test('mediaOf: draw.js exactly, and assets/<…>.png|svg|webp|woff2 with their types', () => {
  assert.equal(DRAW_FILE, 'draw.js');
  assert.deepEqual(mediaOf('draw.js'), { type: DRAW_TYPE, kind: 'draw', ext: 'js' });
  assert.equal(DRAW_TYPE, 'text/javascript; charset=utf-8');
  assert.deepEqual({ ...ASSET_TYPES }, { png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp', woff2: 'font/woff2' });
  assert.deepEqual(mediaOf('assets/mark.png'), { type: 'image/png', kind: 'image', ext: 'png' });
  assert.deepEqual(mediaOf('assets/a/b/mark.svg'), { type: 'image/svg+xml', kind: 'image', ext: 'svg' });
  assert.deepEqual(mediaOf('assets/tex.webp'), { type: 'image/webp', kind: 'image', ext: 'webp' });
  assert.deepEqual(mediaOf('assets/fonts/hand.woff2'), { type: 'font/woff2', kind: 'font', ext: 'woff2' });
});

test('mediaOf refuses: JavaScript, HTML, JSON or any other file under assets/ (PFH@inline), draw.js anywhere else, and every unsound path', () => {
  for (const rel of [
    'assets/x.js', 'assets/x.mjs', 'assets/x.html', 'assets/x.htm', 'assets/x.json', 'assets/x.css', 'assets/x.txt',
    'assets/draw.js', 'assets/png', 'assets/.png', 'assets/', 'assets', 'element.json', 'x.png', 'other/x.png',
    'sub/draw.js', './draw.js', '/draw.js', 'draw.js/', 'assets/../draw.js', 'assets/./x.png', 'assets//x.png',
    'assets/a\\b.png', 'assets/a\u0000.png', 'assets/a‮.png', '', null, undefined, 42,
    `assets/${'a'.repeat(300)}.png`,
  ]) {
    const m = mediaOf(rel);
    assert.ok(m.refused, `${JSON.stringify(rel)} refused`);
    assert.match(m.refused, /not an allowed file/);
    assert.equal(m.type, undefined);
  }
});

test('sniff: each allowed format\'s bytes pass; bytes that do not match their extension, an active SVG and an over-cap file are refused', () => {
  assert.equal(sniff(Buffer.from('export default function draw() {}\n'), mediaOf('draw.js')), null);
  assert.equal(sniff(PNG, mediaOf('assets/a.png')), null);
  assert.equal(sniff(SVG, mediaOf('assets/a.svg')), null);
  assert.equal(sniff(webp(), mediaOf('assets/a.webp')), null);
  assert.equal(sniff(woff2(), mediaOf('assets/a.woff2')), null);
  // Mismatches, every way round.
  assert.match(sniff(SVG, mediaOf('assets/a.png')), /not a PNG/);
  assert.match(sniff(PNG, mediaOf('assets/a.svg')), /not an SVG/);
  assert.match(sniff(PNG, mediaOf('assets/a.webp')), /not a WebP/);
  assert.match(sniff(webp(), mediaOf('assets/a.woff2')), /not a WOFF2/);
  assert.match(sniff(woff2(), mediaOf('assets/a.png')), /not an SVG or PNG/);
  // The one image check: an active SVG is refused in brand-image's words.
  assert.match(sniff(ACTIVE_SVG, mediaOf('assets/a.svg')), /script/);
  // draw.js must be UTF-8.
  assert.match(sniff(Buffer.from([0x66, 0xff, 0xfe, 0x00]), mediaOf('draw.js')), /not UTF-8/);
  // The cap, for every kind.
  const big = Buffer.concat([PNG, Buffer.alloc(FILE_MAX)]);
  assert.match(sniff(big, mediaOf('assets/a.png')), /over the cap/);
  assert.match(sniff(Buffer.alloc(FILE_MAX + 1, 0x20), mediaOf('draw.js')), /over the cap/);
  assert.equal(sniff(Buffer.alloc(FILE_MAX, 0x20), mediaOf('draw.js')), null, 'exactly the cap is allowed');
  // A refused media answers a refusal, never null.
  assert.ok(sniff(PNG, mediaOf('assets/a.js')));
  assert.ok(sniff('not bytes', mediaOf('draw.js')));
});

test('browserModuleSource: the served mediaOf answers exactly as this module\'s, over the allowlist and the refusals (U512\'s asset(rel))', async () => {
  const { browserModuleSource, mediaOf: hostMediaOf } = require('../lib/core/element-assets');
  // Memoised: the source is assembled once (mediaOf's own text read once),
  // however often it is asked for. An own toString counts the reads.
  let reads = 0;
  const ownText = Function.prototype.toString.call(hostMediaOf);
  hostMediaOf.toString = () => { reads += 1; return ownText; };
  let src;
  try {
    src = browserModuleSource();
    assert.strictEqual(browserModuleSource(), src);
  } finally {
    delete hostMediaOf.toString;
  }
  assert.ok(reads <= 1, `memoised: assembled at most once here, read ${reads} times`);
  const mod = await import('data:text/javascript,' + encodeURIComponent(src));
  const rels = ['draw.js', 'assets/mark.png', 'assets/fonts/hand.woff2', 'assets/a.SVG', 'assets/x.webp', 'assets/x.js', 'assets/../draw.js',
    'assets//x.png', '/assets/x.png', 'assets/x\u202e.png', 'assets/x\u0007.png', 'assets/a\\b.png', 'lib/x.png', 'assets/' + 'a'.repeat(300) + '.png', '', 'assets/x',
    'assets/x\u200b.png', 'assets/./x.png', null, 7];
  for (const rel of rels) assert.deepEqual(mod.mediaOf(rel), hostMediaOf(rel), rel);
});

test('GET /app/element-assets.js serves browserModuleSource() as JavaScript, under the existing /app/* row (the import element-types.js makes)', async (t) => {
  const { withServer } = require('../test-support/helpers');
  const { classify } = require('../lib/core/remote-policy');
  const { browserModuleSource } = require('../lib/core/element-assets');
  const { port } = await withServer(t);
  const res = await fetch(`http://localhost:${port}/app/element-assets.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
  assert.strictEqual(await res.text(), browserModuleSource());
  assert.equal(classify('GET', '/app/element-assets.js').allow, true);
});

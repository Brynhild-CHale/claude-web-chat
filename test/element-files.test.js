// The element-type file route (annotation engine tranche 4, U511; PLAN.md
// 4A.1 and 4A.2; DECISIONS.md B1 review-approve, B3 fenced-route; ruling
// U511@file-cap a): GET /api/elements/types/:type/draw.js and
// /api/elements/types/:type/assets/* (lib/server/routes/element-files.js)
// serve a listed, approved, intact plug-in type's files through
// lib/server/element-files readTypeFile and nothing else; GET
// /api/elements/types carries each plug-in row's draw.sha256.
//
// Fixture types are staged and approved through
// test-support/element-type-fixture.js (the one element-pack helper).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withServer } = require('../test-support/helpers');
const { tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');
const { elementPack, elementJson, approveElementPack, DRAW } = require('../test-support/element-type-fixture');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { readStore, putPending, clearPending } = require('../lib/packs/store');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { encodePng } = require('../lib/core/png');
const { BRAND_CSP } = require('../lib/server/brand');
const { BUILTIN_ELEMENT_TYPE_NAMES } = require('../lib/core/names');
const { FILE_MAX } = require('../lib/core/element-assets');
const client = require('../lib/client');

const SHA = 'c'.repeat(40);
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

const PNG = encodePng(Buffer.alloc(4 * 4 * 4, 0x80), 4, 4);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n';
const ACTIVE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script></svg>\n';
const WEBP = (() => {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(24, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  return b;
})();
const WOFF2 = (() => {
  const b = Buffer.alloc(64);
  b.write('wOF2', 0, 'latin1');
  return b;
})();

const typeDir = (root, type) => path.join(projectPaths(root).elementTypesDir, type);
const url = (type, rel) => `/api/elements/types/${type}/${rel}`;

// The digest the project's packs.json records for one file of a type's unit.
function recorded(root, packName, type, rel) {
  const pack = readStore(projectPaths(root).packs).packs.find((p) => p.name === packName);
  const unit = pack.units.find((u) => u.kind === 'element' && u.name === type);
  return unit.files.find((f) => f.path === rel).sha256;
}

async function fetchRaw(d, p, init) {
  const res = await d.anonApi.raw(p, init);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

function jsonOf(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

test('a listed type\'s draw.js is served: text/javascript, nosniff, CORP same-origin, no-store, the recorded sha256 as its ETag, the installed bytes; an equal If-None-Match is a 304', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, { name: 'ink-pack', type: 'inky' });
  const sha = recorded(d.root, 'ink-pack', 'inky', 'draw.js');
  const { res, bytes } = await fetchRaw(d, url('inky', 'draw.js'));
  assert.equal(res.status, 200, bytes.toString());
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('etag'), `"${sha}"`);
  assert.equal(res.headers.get('content-security-policy'), null, 'a module carries no image CSP');
  assert.deepEqual(bytes, fs.readFileSync(path.join(typeDir(d.root, 'inky'), 'draw.js')));
  assert.equal(bytes.toString('utf8'), DRAW);
  // The chrome's cache key is ignored.
  const keyed = await fetchRaw(d, `${url('inky', 'draw.js')}?d=${sha}`);
  assert.equal(keyed.res.status, 200);
  assert.deepEqual(keyed.bytes, bytes);
  // Revalidation.
  const again = await fetchRaw(d, url('inky', 'draw.js'), { headers: { 'If-None-Match': `"${sha}"` } });
  assert.equal(again.res.status, 304);
  assert.equal(again.bytes.length, 0);
  assert.equal(again.res.headers.get('etag'), `"${sha}"`);
  const other = await fetchRaw(d, url('inky', 'draw.js'), { headers: { 'If-None-Match': `"${'0'.repeat(64)}"` } });
  assert.equal(other.res.status, 200, 'a different tag gets the bytes');
});

test('GET /api/elements/types carries draw.sha256 on a plug-in row, none on a built-in; the digest equals the route\'s ETag', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, { name: 'ink-pack', type: 'inky' });
  const r = await d.anonApi.get('/api/elements/types');
  assert.equal(r.status, 200, r.text);
  const inky = r.json.types.find((x) => x.type === 'inky');
  assert.deepEqual(inky.draw, { sha256: recorded(d.root, 'ink-pack', 'inky', 'draw.js') });
  for (const name of BUILTIN_ELEMENT_TYPE_NAMES) {
    const row = r.json.types.find((x) => x.type === name);
    assert.ok(row, name);
    assert.equal(Object.hasOwn(row, 'draw'), false, `${name} carries no draw`);
  }
  const { res } = await fetchRaw(d, url('inky', 'draw.js'));
  assert.equal(res.headers.get('etag'), `"${inky.draw.sha256}"`);
});

test('assets/: a PNG, an inert SVG, a WebP and a WOFF2 are served with their types and BRAND_CSP; bytes that are not what their name says are refused', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, {
    name: 'ink-pack', type: 'inky',
    files: {
      'assets/mark.png': PNG, 'assets/sub/mark.svg': SVG, 'assets/tex.webp': WEBP, 'assets/fonts/hand.woff2': WOFF2,
      'assets/fake.png': SVG, 'assets/fake.woff2': PNG,
    },
  });
  for (const [rel, type, body] of [
    ['assets/mark.png', 'image/png', PNG],
    ['assets/sub/mark.svg', 'image/svg+xml', Buffer.from(SVG)],
    ['assets/tex.webp', 'image/webp', WEBP],
    ['assets/fonts/hand.woff2', 'font/woff2', WOFF2],
  ]) {
    const { res, bytes } = await fetchRaw(d, url('inky', rel));
    assert.equal(res.status, 200, `${rel}: ${bytes}`);
    assert.equal(res.headers.get('content-type'), type, rel);
    assert.equal(res.headers.get('content-security-policy'), BRAND_CSP, rel);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', rel);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin', rel);
    assert.equal(res.headers.get('cache-control'), 'no-store', rel);
    assert.equal(res.headers.get('etag'), `"${recorded(d.root, 'ink-pack', 'inky', rel)}"`, rel);
    assert.deepEqual(bytes, body, rel);
  }
  for (const rel of ['assets/fake.png', 'assets/fake.woff2']) {
    const r = await d.anonApi.get(url('inky', rel));
    assert.equal(r.status, 403, `${rel}: ${r.text}`);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /not a PNG|not a WOFF2/);
    assert.equal(typeof r.json.hint, 'string');
  }
});

test('refused: an unlisted type, a quarantined one never approved, a pending install, a committed element-types/<x>/ with no record (404), a built-in (404, the built-in hint)', async (t) => {
  const d = await withServer(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack({ name: 'mark-pack', type: 'sticky', files: { 'assets/a.png': PNG } }), { sha: SHA }) } });
  const q = await d.api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') });
  assert.equal(q.json.ok, true, q.text);
  // A committed directory no record names.
  const forged = typeDir(d.root, 'forged');
  fs.mkdirSync(path.join(forged, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(forged, 'element.json'), JSON.stringify(elementJson('forged')));
  fs.writeFileSync(path.join(forged, 'draw.js'), DRAW);
  fs.writeFileSync(path.join(forged, 'assets', 'a.png'), PNG);
  // A pending install: approved, then a pending marker names its pack.
  approveElementPack(d, { name: 'pend-pack', type: 'pendy', files: { 'assets/a.png': PNG } });
  assert.equal((await d.anonApi.raw(url('pendy', 'draw.js'))).status, 200, 'served before the marker');
  putPending(d.root, 'local', { name: 'pend-pack', version: '1.1.0', started_at: new Date().toISOString() });
  d.srv.elementTypes.invalidate();
  for (const type of ['nope', 'sticky', 'forged', 'pendy']) {
    for (const rel of ['draw.js', 'assets/a.png']) {
      const r = await d.anonApi.get(url(type, rel));
      assert.equal(r.status, 404, `${type}/${rel}: ${r.text}`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error, 'no listed element type by that name');
      assert.match(r.json.hint, /review and approve/);
    }
  }
  clearPending(d.root, 'local', 'pend-pack');
  d.srv.elementTypes.invalidate();
  assert.equal((await d.anonApi.raw(url('pendy', 'draw.js'))).status, 200, 'served once the marker is gone');
  for (const name of BUILTIN_ELEMENT_TYPE_NAMES) {
    assert.ok(d.srv.elementTypes.listed(name), `${name} listed`);
    for (const rel of ['draw.js', 'assets/a.png', 'assets/icon-light.svg']) {
      const r = await d.anonApi.get(url(name, rel));
      assert.equal(r.status, 404, `${name}/${rel}: ${r.text}`);
      assert.equal(r.json.hint, "a built-in type draws from the chrome's own modules");
    }
  }
});

test('refused: draw.js edited on disk after approve (403 changed on disk), every read re-checked; back to the reviewed bytes, served again', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, { name: 'ink-pack', type: 'inky', files: { 'assets/mark.png': PNG } });
  const draw = path.join(typeDir(d.root, 'inky'), 'draw.js');
  const reviewed = fs.readFileSync(draw);
  assert.equal((await d.anonApi.raw(url('inky', 'draw.js'))).status, 200, 'listed and served first');
  fs.writeFileSync(draw, "export default function draw() { fetch('https://evil.example'); }\n");
  let r = await d.anonApi.get(url('inky', 'draw.js'));
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /changed on disk since the pack was reviewed/);
  assert.match(r.json.hint, /review and approve/);
  // An asset too.
  const png = path.join(typeDir(d.root, 'inky'), 'assets', 'mark.png');
  fs.writeFileSync(png, encodePng(Buffer.alloc(4 * 4 * 4, 0x10), 4, 4));
  r = await d.anonApi.get(url('inky', 'assets/mark.png'));
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /changed on disk/);
  // A file under assets/ the record never named.
  fs.writeFileSync(path.join(typeDir(d.root, 'inky'), 'assets', 'added.png'), PNG);
  r = await d.anonApi.get(url('inky', 'assets/added.png'));
  assert.equal(r.status, 403, r.text);
  // Back to the reviewed bytes: nothing was cached either way.
  fs.writeFileSync(draw, reviewed);
  const { res, bytes } = await fetchRaw(d, url('inky', 'draw.js'));
  assert.equal(res.status, 200);
  assert.deepEqual(bytes, reviewed);
});

test('refused: a symlinked draw.js and a symlinked assets/ directory (403), even to the reviewed bytes', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, { name: 'ink-pack', type: 'inky', files: { 'assets/mark.png': PNG } });
  const dir = typeDir(d.root, 'inky');
  assert.equal((await d.anonApi.raw(url('inky', 'draw.js'))).status, 200);
  assert.equal((await d.anonApi.raw(url('inky', 'assets/mark.png'))).status, 200);
  // draw.js → a copy of itself outside the directory.
  const draw = path.join(dir, 'draw.js');
  const copy = path.join(d.root, 'draw-copy.js');
  fs.copyFileSync(draw, copy);
  fs.unlinkSync(draw);
  fs.symlinkSync(copy, draw);
  let r = await d.anonApi.get(url('inky', 'draw.js'));
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.ok, false);
  // A link inside the directory is still a link.
  fs.unlinkSync(draw);
  fs.copyFileSync(copy, path.join(dir, 'assets', 'same.js'));
  fs.symlinkSync(path.join(dir, 'assets', 'same.js'), draw);
  r = await d.anonApi.get(url('inky', 'draw.js'));
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /is a link/);
  // assets/ swapped for a link to a copy of itself.
  const assets = path.join(dir, 'assets');
  const moved = path.join(d.root, 'assets-copy');
  fs.renameSync(assets, moved);
  fs.symlinkSync(moved, assets);
  r = await d.anonApi.get(url('inky', 'assets/mark.png'));
  assert.equal(r.status, 403, r.text);
});

test('refused before the fence (400): a .. segment, an encoded %2F or %5C, a backslash, an empty segment, a NUL, a \'..\' or encoded type', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, { name: 'ink-pack', type: 'inky', files: { 'assets/mark.png': PNG } });
  for (const p of [
    url('inky', 'assets/../draw.js'),
    url('inky', 'assets/sub/../mark.png'),
    url('inky', 'assets/%2E%2E/draw.js'),
    url('inky', 'assets/..%2Fdraw.js'),
    url('inky', 'assets/sub%2Fmark.png'),
    url('inky', 'assets/sub%2fmark.png'),
    url('inky', 'assets/sub%5Cmark.png'),
    url('inky', 'assets/sub\\mark.png'),
    url('inky', 'assets//mark.png'),
    url('inky', 'assets/./mark.png'),
    url('inky', 'assets/mark%00.png'),
    url('..', 'draw.js'),
    url('in%2Fky', 'draw.js'),
  ]) {
    const r = await client.request(d.port, 'GET', p, undefined, { timeout: 10000 });
    assert.equal(r.status, 400, `${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, false);
    assert.match(r.body.hint, /draw\.js and assets/);
  }
});

test('refused: assets/x.js and assets/x.html (not an allowed file), a PNG over 256 KB (over the cap), an active SVG (brand-image)', async (t) => {
  const d = await withServer(t);
  approveElementPack(d, {
    name: 'ink-pack', type: 'inky',
    files: {
      'assets/x.js': 'export const x = 1;\n',
      'assets/x.html': '<p>hi</p>\n',
      'assets/x.json': '{}\n',
      'assets/big.png': Buffer.concat([PNG, Buffer.alloc(FILE_MAX)]),
      'assets/active.svg': ACTIVE_SVG,
    },
  });
  for (const rel of ['assets/x.js', 'assets/x.html', 'assets/x.json']) {
    assert.ok(fs.existsSync(path.join(typeDir(d.root, 'inky'), rel)), `${rel} installed (only the route refuses it)`);
    const r = await d.anonApi.get(url('inky', rel));
    assert.equal(r.status, 403, `${rel}: ${r.text}`);
    assert.match(r.json.error, /not an allowed file/);
    assert.match(r.json.hint, /png\|svg\|webp\|woff2/);
  }
  let r = await d.anonApi.get(url('inky', 'assets/big.png'));
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, new RegExp(`over ${FILE_MAX} bytes`));
  r = await d.anonApi.get(url('inky', 'assets/active.svg'));
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /SVG refused: it contains a <script> element/);
  assert.ok(!String(r.headers.get('content-type')).startsWith('image/'));
});

test('remote: a read viewer is served, a basic viewer refused 403, and a type whose gate.see is full refused to a read viewer', async (t) => {
  const readRoot = tmpDir('wc-ef-read-');
  const seed = () => writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(readRoot)]: 'read' } } });
  const read = await withServer(t, { root: readRoot, seed });
  approveElementPack(read, { name: 'ink-pack', type: 'inky', files: { 'assets/mark.png': PNG } });
  approveElementPack(read, { name: 'full-pack', type: 'fully', json: { remote: { see: 'full', send: 'full' } } });
  assert.equal(read.srv.elementTypes.gate('fully').see, 'full');
  for (const rel of ['draw.js', 'assets/mark.png']) {
    const r = await client.request(read.port, 'GET', url('inky', rel), undefined, { headers: REMOTE, timeout: 10000 });
    assert.equal(r.status, 200, `${rel}: ${JSON.stringify(r.body)}`);
  }
  let r = await client.request(read.port, 'GET', url('fully', 'draw.js'), undefined, { headers: REMOTE, timeout: 10000 });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.ok, false);
  assert.match(r.body.hint, /full mirror access/);
  r = await client.request(read.port, 'GET', url('fully', 'draw.js'), undefined, { timeout: 10000 });
  assert.equal(r.status, 200, 'a local caller is served the see-full type');
  // A daemon whose project is not shared: basic.
  const basic = await withServer(t);
  approveElementPack(basic, { name: 'ink-pack', type: 'inky' });
  r = await client.request(basic.port, 'GET', url('inky', 'draw.js'), undefined, { headers: REMOTE, timeout: 10000 });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.mirror, 'basic');
});

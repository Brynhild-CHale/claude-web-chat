// The toolbar route's type-aware half (lib/server/routes/toolbar.js; annotation
// engine 2D.7, U337): GET /api/toolbar's tools[] from the record-gated element
// type registry (ctx.elementTypes, U324 — GT-17: an unreviewed type is listed
// nowhere), the default `pinned`, `installed` on the merged bindings, the
// manifest's settings and profiles checked on PATCH, and the fenced,
// re-validated icon route served through routes/brand.js sendImage.
//
// Fixture types are installed in process through lib/packs/install's approve
// path (installFromStage, via 'approve') — a reviewed install with a record and
// a ledger entry — and the registry is told with invalidate() (no packs event
// is emitted by an in-process install).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { withServer } = require('../test-support/helpers');
const { packFixture, fakeForge, repoWithArchive } = require('../test-support/packs');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { readStore, writeStore } = require('../lib/packs/store');
const { readJson, writeJsonAtomic } = require('../lib/core/fsjson');
const { BRAND_CSP } = require('../lib/server/brand');
const packs = require('../lib/packs/install');

const SHA = 'b'.repeat(40);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const plain = (v) => JSON.parse(JSON.stringify(v));
const TEMPLATE = path.join(__dirname, '..', 'templates', 'elements', 'web-chat-builtins', 'elements');
const DRAW = "export default function draw(group) { group.container.textContent = 'x'; }\n";
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24"/></svg>\n';

function elementJson(type, json = {}) {
  return { type, family: 'page', remote: { see: 'read', send: 'full' }, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element', 'range'], ...json };
}

function elementPack({ name = 'fixture-pack', version = '2.3.4', type = 'fixture', json = {}, files = {} } = {}) {
  const extra = {
    [`elements/${type}/element.json`]: JSON.stringify(elementJson(type, json), null, 2) + '\n',
    [`elements/${type}/draw.js`]: DRAW,
  };
  for (const [rel, body] of Object.entries(files)) extra[`elements/${type}/${rel}`] = body;
  return packFixture({
    name, version, components: [], skill: false,
    manifest: { name, version, description: 'A fixture element type.', elements: [type] },
    extraFiles: extra,
  });
}

function approve(d, opts) {
  packs.installFromStage({ stageDir: elementPack(opts), source: { via: 'test' }, tier: 'local', root: d.root, via: 'approve' });
  d.srv.elementTypes.invalidate();
}

async function ok(p, what = 'request') {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text}`);
  return r.json;
}

const typeDir = (root, type) => path.join(projectPaths(root).elementTypesDir, type);

// Re-record one installed file's digest in the project's packs.json and the
// machine's ledger, so a check past the digest (brand-image validate) is the
// one that answers.
function rerecord(root, packName, type, rel) {
  const digest = sha256(fs.readFileSync(path.join(typeDir(root, type), rel)));
  const fix = (units) => units.map((u) => (u.kind === 'element' && u.name === type
    ? { ...u, files: u.files.map((f) => (f.path === rel ? { ...f, sha256: digest } : f)) } : u));
  const file = projectPaths(root).packs;
  const store = readStore(file);
  store.packs = store.packs.map((p) => (p.name === packName ? { ...p, units: fix(p.units) } : p));
  writeStore(file, store);
  const ledger = readJson(userPaths().packsLedger).value;
  ledger.installs = ledger.installs.map((e) => (e.name === packName ? { ...e, units: fix(e.units) } : e));
  writeJsonAtomic(userPaths().packsLedger, ledger, { newline: true });
}

test('GET /api/toolbar lists the built-ins first in manifest order, each with its manifest toolbar fields, installed:true', async (t) => {
  const d = await withServer(t);
  approve(d, { name: 'aaa-pack', version: '0.1.0', type: 'aardvark' });
  const body = await ok(d.anonApi.get('/api/toolbar'), 'GET');
  assert.deepEqual(body.tools.map((x) => x.type), ['comment', 'highlight', 'box-grab', 'aardvark'],
    'the built-in pack first in its manifest order (not by type), then every other listed type');
  const comment = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'comment', 'element.json'), 'utf8'));
  assert.deepEqual(body.tools[0], {
    type: 'comment',
    label: 'Comment',
    pack: { name: 'web-chat-builtins', version: '1.0.0' },
    builtin: true,
    icons: { light: '/api/toolbar/icon/comment', dark: '/api/toolbar/icon/comment?mode=dark' },
    hotkeys: [{ action: 'arm', label: 'Pin comment', default: 'C' }],
    settings: comment.settings,
    profiles: false,
    input: 'taps',
    installed: true,
  });
  assert.deepEqual(body.tools.map((x) => [x.input, x.profiles]), [['taps', false], ['selection', true], ['strokes', false], ['taps', false]]);
  // The label: element.json's when it names one, else the type with its first
  // letter upper-cased (K.2-46).
  assert.deepEqual(body.tools.map((x) => x.label), ['Comment', 'Highlight', 'Box grab', 'Aardvark']);
  const fixture = body.tools[3];
  assert.deepEqual(fixture, {
    type: 'aardvark', label: 'Aardvark', pack: { name: 'aaa-pack', version: '0.1.0' }, builtin: false,
    icons: null, hotkeys: [], settings: null, profiles: false, input: 'taps', installed: true,
  });
  assert.ok(!body.tools.some((x) => JSON.stringify(x).includes(d.root)), 'no tool carries a path');
});

test('a type staged in quarantine but not approved, and a committed element-types/<x>/ with no record, are not listed and their icons 404', async (t) => {
  const d = await withServer(t);
  const forge = await fakeForge(t, { repos: { 'acme/marks': repoWithArchive(elementPack({ name: 'mark-pack', type: 'sticky', json: { icons: { light: 'i.svg', dark: 'i.svg' } }, files: { 'i.svg': ICON_SVG } }), { sha: SHA }) } });
  const q = await d.api.post('/api/packs/quarantine', { url: forge.url('acme', 'marks') });
  assert.equal(q.json.ok, true, q.text);
  // A committed directory, icons and all, that no record names.
  const forged = typeDir(d.root, 'forged');
  fs.mkdirSync(forged, { recursive: true });
  fs.writeFileSync(path.join(forged, 'element.json'), JSON.stringify(elementJson('forged', { icons: { light: 'i.svg', dark: 'i.svg' } })));
  fs.writeFileSync(path.join(forged, 'i.svg'), ICON_SVG);
  d.srv.elementTypes.invalidate();
  const body = await ok(d.anonApi.get('/api/toolbar'), 'GET');
  assert.deepEqual(body.tools.map((x) => x.type), ['comment', 'highlight', 'box-grab']);
  for (const type of ['sticky', 'forged']) {
    for (const q2 of ['', '?mode=dark']) {
      const r = await d.anonApi.get(`/api/toolbar/icon/${type}${q2}`);
      assert.equal(r.status, 404, `${type}${q2}: ${r.text}`);
      assert.ok(!String(r.headers.get('content-type')).startsWith('image/'));
    }
  }
});

test('with no project record pinned defaults to the built-ins in manifest order; a PATCH that names pinned replaces it, one that does not keeps the default', async (t) => {
  const d = await withServer(t);
  const file = projectPaths(d.root).toolbar;
  let body = await ok(d.anonApi.get('/api/toolbar'), 'GET');
  assert.deepEqual(body.project.pinned, ['comment', 'highlight', 'box-grab']);
  // A write of something else keeps `pinned` off the disk, so the default holds;
  // a hidden built-in leaves the default.
  body = await ok(d.anonApi.patch('/api/toolbar', { hidden: ['comment'] }), 'hide');
  assert.deepEqual(body.project.pinned, ['highlight', 'box-grab']);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'pinned'), false, 'no pinned field written');
  body = await ok(d.anonApi.patch('/api/toolbar', { pinned: ['highlight'], hidden: [] }), 'pin');
  assert.deepEqual(body.project.pinned, ['highlight']);
  assert.deepEqual((await ok(d.anonApi.get('/api/toolbar'))).project.pinned, ['highlight']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pinned, ['highlight']);
  // Once named, even empty, the record's own list stands.
  body = await ok(d.anonApi.patch('/api/toolbar', { pinned: [] }), 'unpin all');
  assert.deepEqual(body.project.pinned, []);
  body = await ok(d.anonApi.patch('/api/toolbar', { settings: { highlight: { color: 'green' } } }), 'settings');
  assert.deepEqual(body.project.pinned, []);
});

test('the toolbar frame carries the same default pinned and installed marks as GET, and keeps its keys', async (t) => {
  const d = await withServer(t);
  const ws = d.ws();
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  let hello = false;
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch {}
    if (msg && msg.type === 'hello') hello = true;
    if (msg && msg.type === 'toolbar') frames.push(msg);
  });
  const { waitUntil } = require('../test-support/helpers');
  await waitUntil(() => hello, { what: 'hello' });
  await ok(d.anonApi.patch('/api/toolbar/user', { bindings: { H: { kind: 'tool', type: 'highlight' } } }), 'user PATCH');
  await waitUntil(() => frames.length >= 1, { what: 'the toolbar frame' });
  assert.deepEqual(Object.keys(frames[0]).sort(), ['merged', 'project', 'type', 'user', 'v']);
  assert.deepEqual(frames[0].project.pinned, ['comment', 'highlight', 'box-grab']);
  assert.equal(frames[0].merged.bindings.H.value.installed, true);
});

test('merged bindings mark each tool target installed or not; the records stay as written and a user-tier pack row passes through', async (t) => {
  const d = await withServer(t);
  const pack = { name: 'stickers', source: 'https://example.test/stickers.git' };
  await ok(d.anonApi.patch('/api/toolbar/user', { bindings: {
    H: { kind: 'tool', type: 'highlight' }, S: { kind: 'tool', type: 'sticker', pack }, P: { kind: 'chrome', action: 'chrome.push' },
  } }), 'user');
  const body = await ok(d.anonApi.patch('/api/toolbar', { bindings: { 1: { kind: 'slot', n: 1 }, X: { kind: 'tool', type: 'nope' }, H: { kind: 'tool', type: 'box-grab' } } }), 'project');
  const m = body.merged.bindings;
  assert.deepEqual(plain(m.H), { value: { kind: 'tool', type: 'box-grab', installed: true }, tier: 'project',
    shadows: [{ tier: 'user', value: { kind: 'tool', type: 'highlight', installed: true } }] });
  assert.deepEqual(plain(m.S.value), { kind: 'tool', type: 'sticker', pack, installed: false });
  assert.deepEqual(plain(m.X.value), { kind: 'tool', type: 'nope', installed: false });
  assert.deepEqual(plain(m['1'].value), { kind: 'slot', n: 1 }, 'a slot target is not a type: no mark');
  assert.deepEqual(plain(m.P.value), { kind: 'chrome', action: 'chrome.push' });
  assert.deepEqual(plain(body.user.bindings.S), { kind: 'tool', type: 'sticker', pack }, 'the user record as written');
  assert.deepEqual(plain(body.project.bindings.X), { kind: 'tool', type: 'nope' }, 'the project record as written');
  // A binding read back from the record round-trips through PATCH.
  await ok(d.anonApi.patch('/api/toolbar', { bindings: { Y: body.project.bindings.X } }), 'round trip');
});

test('PATCH settings and profiles are checked against the listed type\'s manifest schema; an unlisted type keeps the record\'s bounds only', async (t) => {
  const d = await withServer(t);
  approve(d, { type: 'fixture', json: { settings: { small: { type: 'object', properties: { color: { type: 'string', enum: ['gold', 'green'] } } },
    large: { type: 'object', properties: { size: { type: 'integer', minimum: 1, maximum: 9 } } } }, profiles: true } });
  const file = projectPaths(d.root).toolbar;
  let r = await d.anonApi.patch('/api/toolbar', { settings: { fixture: { color: 'pink' } } });
  assert.equal(r.status, 400, r.text);
  assert.deepEqual([r.json.ok, r.json.field], [false, 'settings.fixture.color']);
  assert.match(r.json.error, /gold/);
  assert.ok(!fs.existsSync(file), 'nothing written');
  await ok(d.anonApi.patch('/api/toolbar', { settings: { fixture: { color: 'gold' } } }), 'gold');
  // small ∪ large: a key from either; an unknown key is refused by name.
  await ok(d.anonApi.patch('/api/toolbar', { settings: { fixture: { color: 'green', size: 3 } } }), 'both levels');
  r = await d.anonApi.patch('/api/toolbar', { settings: { fixture: { size: 12 } } });
  assert.deepEqual([r.status, r.json.field], [400, 'settings.fixture.size']);
  r = await d.anonApi.patch('/api/toolbar', { settings: { fixture: { shade: 'dark' } } });
  assert.deepEqual([r.status, r.json.field], [400, 'settings.fixture.shade']);
  // The user tier's per-tool defaults are checked the same way.
  r = await d.anonApi.patch('/api/toolbar/user', { settings: { fixture: { color: 'pink' } } });
  assert.deepEqual([r.status, r.json.field], [400, 'settings.fixture.color']);
  // A profile's settings too; a type whose manifest says profiles: false (or
  // says nothing) takes none (H-1).
  r = await d.anonApi.patch('/api/toolbar', { profiles: { fixture: [{ name: 'warm', settings: { color: 'pink' } }] } });
  assert.deepEqual([r.status, r.json.field], [400, 'profiles.fixture[0].settings.color']);
  await ok(d.anonApi.patch('/api/toolbar', { profiles: { fixture: [{ name: 'warm', settings: { color: 'gold' } }] } }), 'profile');
  r = await d.anonApi.patch('/api/toolbar', { profiles: { comment: [{ name: 'a', settings: {} }] } });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.field, 'profiles.comment');
  r = await d.anonApi.patch('/api/toolbar', { profiles: { 'box-grab': [{ name: 'a', settings: {} }] } });
  assert.deepEqual([r.status, r.json.field], [400, 'profiles.box-grab']);
  await ok(d.anonApi.patch('/api/toolbar', { profiles: { highlight: [{ name: 'Rust', settings: { color: 'rust' } }] } }), 'highlight profile');
  // A type the registry does not list: the record's bounds only.
  await ok(d.anonApi.patch('/api/toolbar', { settings: { 'not-here': { anything: 'goes' } }, profiles: { 'not-here': [{ name: 'p', settings: {} }] } }), 'unlisted');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(rec.settings.fixture, { color: 'green', size: 3 });
});

test('GET /api/toolbar/icon/:type serves the installed icon through sendImage; ?mode=dark the dark file', async (t) => {
  const d = await withServer(t);
  for (const [q, file] of [['', 'icon-light.svg'], ['?mode=light', 'icon-light.svg'], ['?mode=dark', 'icon-dark.svg']]) {
    const res = await d.anonApi.raw(`/api/toolbar/icon/comment${q}`);
    assert.equal(res.status, 200, q);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, fs.readFileSync(path.join(typeDir(d.root, 'comment'), file)), `${q} serves ${file}`);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), BRAND_CSP);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  }
  assert.notDeepEqual(fs.readFileSync(path.join(typeDir(d.root, 'comment'), 'icon-light.svg')),
    fs.readFileSync(path.join(typeDir(d.root, 'comment'), 'icon-dark.svg')), 'the two files differ, so the mode is proven');
  assert.equal((await d.anonApi.get('/api/toolbar/icon/comment?mode=sepia')).status, 400);
  assert.equal((await d.anonApi.get('/api/toolbar/icon/not-a-type')).status, 404);
  assert.equal((await d.anonApi.get('/api/toolbar/icon/..%2F..%2Fgraph')).status, 404);
  // A listed type that names no icons.
  approve(d, { type: 'plain' });
  assert.equal((await d.anonApi.get('/api/toolbar/icon/plain')).status, 404);
  // A fixture's PNG-free SVG icons under assets/ are served too.
  approve(d, { name: 'iconic', type: 'iconic', json: { icons: { light: 'assets/l.svg', dark: 'assets/d.svg' } },
    files: { 'assets/l.svg': ICON_SVG, 'assets/d.svg': ICON_SVG.replace('<rect', '<circle r="9"').replace(' width="24" height="24"/>', '/>') } });
  const res = await d.anonApi.raw('/api/toolbar/icon/iconic?mode=dark');
  assert.equal(res.status, 200);
  assert.match(Buffer.from(await res.arrayBuffer()).toString('utf8'), /circle/);
});

test('an icon replaced after approval is refused, never served: an active SVG (its digest re-recorded, so validate answers), and any change to the reviewed bytes', async (t) => {
  const d = await withServer(t);
  const icon = path.join(typeDir(d.root, 'comment'), 'icon-light.svg');
  const reviewed = fs.readFileSync(icon);
  // A running daemon has listed its types already (the registry is lazy and
  // keeps its listing until a packs event): the route's own checks answer.
  assert.equal((await d.anonApi.raw('/api/toolbar/icon/comment')).status, 200);
  // 1. bytes that differ from the record's digest: refused whatever they hold.
  fs.writeFileSync(icon, ICON_SVG);
  let r = await d.anonApi.get('/api/toolbar/icon/comment');
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /changed on disk/);
  // 2. an SVG with a <script>, its digest re-recorded in packs.json and the
  // ledger: brand-image validate refuses it.
  fs.writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script></svg>\n');
  rerecord(d.root, 'web-chat-builtins', 'comment', 'icon-light.svg');
  r = await d.anonApi.get('/api/toolbar/icon/comment');
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /script/i);
  assert.ok(!String(r.headers.get('content-type')).startsWith('image/'));
  // 3. back to the reviewed bytes: served again (the dark file never stopped).
  fs.writeFileSync(icon, reviewed);
  rerecord(d.root, 'web-chat-builtins', 'comment', 'icon-light.svg');
  assert.equal((await d.anonApi.raw('/api/toolbar/icon/comment')).status, 200);
  assert.equal((await d.anonApi.raw('/api/toolbar/icon/comment?mode=dark')).status, 200);
  // And once the registry recomputes over a changed file, the type is not
  // listed at all (its drift gate): no tool, no icon.
  fs.writeFileSync(icon, ICON_SVG);
  d.srv.elementTypes.invalidate();
  assert.equal((await d.anonApi.get('/api/toolbar/icon/comment')).status, 404);
  assert.ok(!(await ok(d.anonApi.get('/api/toolbar'))).tools.some((x) => x.type === 'comment'));
});

test('an icon path that became a symlink is refused, even to the reviewed bytes, and so is a linked directory on its path', async (t) => {
  const d = await withServer(t);
  const dir = typeDir(d.root, 'comment');
  const icon = path.join(dir, 'icon-dark.svg');
  assert.equal((await d.anonApi.raw('/api/toolbar/icon/comment?mode=dark')).status, 200, 'listed and served first');
  const copy = path.join(d.root, 'elsewhere.svg');
  fs.copyFileSync(icon, copy);
  fs.unlinkSync(icon);
  fs.symlinkSync(copy, icon);
  let r = await d.anonApi.get('/api/toolbar/icon/comment?mode=dark');
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /outside its type's directory/, 'a link out of the directory: the fence');
  // A link inside the directory, to a sibling, is still a link.
  fs.unlinkSync(icon);
  fs.symlinkSync(path.join(dir, 'icon-light.svg'), icon);
  r = await d.anonApi.get('/api/toolbar/icon/comment?mode=dark');
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /is a link/);
  // A type whose icon sits under assets/, the assets/ directory swapped for a
  // link to a copy of itself.
  approve(d, { name: 'iconic', type: 'iconic', json: { icons: { light: 'assets/l.svg', dark: 'assets/l.svg' } }, files: { 'assets/l.svg': ICON_SVG } });
  assert.equal((await d.anonApi.raw('/api/toolbar/icon/iconic')).status, 200);
  const assets = path.join(typeDir(d.root, 'iconic'), 'assets');
  const moved = path.join(d.root, 'assets-copy');
  fs.renameSync(assets, moved);
  fs.symlinkSync(moved, assets);
  r = await d.anonApi.get('/api/toolbar/icon/iconic');
  assert.equal(r.status, 403, r.text);
});

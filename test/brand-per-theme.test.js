// Brand images are kept per THEME (lib/server/brand.js over lib/core/brand-store
// and lib/core/theme-identity): an image belongs to the theme that was the
// project's GLOBAL theme when it was added. Switching the global theme shows
// that theme's images — or, for a slot it has none in, its logo fill — and
// switching back brings the first theme's back. Here: the theme key and its
// path safety, a switch away and back (engine, HTTP, export), the `brand` frame
// every global theme change sends, and the v2→v3 migration that moved the
// per-project images earlier builds kept in .web-chat/brand/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const brand = require('../lib/server/brand');
const identity = require('../lib/core/theme-identity');
const brandStore = require('../lib/core/brand-store');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { run, SCHEMA_VERSION } = require('../lib/update/migrations');
const v2ToV3 = require('../lib/update/migrations/v2-to-v3');
const { withServer, withTempHome, existingProject, waitUntil, wsConnect } = require('../test-support/helpers');

// A real 1×1 PNG, and SVG marks that differ only in colour (so in nothing a
// size could tell apart).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const svg = (fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`);
const RED = svg('#aa0000');
const BLUE = svg('#0000aa');
const WHITE = svg('#ffffff');

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function tmpProject(t) {
  const root = tmpDir(t, 'wc-bpt-');
  fs.mkdirSync(projectPaths(root).dir);
  return root;
}
const setTheme = (root, theme) => fs.writeFileSync(projectPaths(root).theme, JSON.stringify(theme));
const bucket = (root, key) => projectPaths(root).brandThemeDir(key);
const ls = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// A theme in the project's library with logos beside it — the shape a theme
// pack installs (lib/server/brand.js fillSource reads the library, not the
// pack record, so no pack pipeline is needed to stand one up).
function libraryTheme(root, name, logos = {}) {
  const pp = projectPaths(root);
  fs.mkdirSync(pp.themeLogosDir(name), { recursive: true });
  fs.writeFileSync(path.join(pp.themesDir, `${name}.json`), JSON.stringify({ name, tokens: { '--wc-accent': '#0b5cad' } }));
  for (const [file, bytes] of Object.entries(logos)) fs.writeFileSync(path.join(pp.themeLogosDir(name), file), bytes);
}

// The runner and the step report on stderr; keep the suite's output readable,
// and hand back what was written so a warning can be asserted.
async function quiet(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += chunk; return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return out;
}

// A socket that records every frame the daemon broadcasts.
async function listen(t, port) {
  const frames = [];
  const sock = wsConnect(port);
  sock.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((resolve, reject) => { sock.once('open', resolve); sock.once('error', reject); });
  t.after(() => { try { sock.terminate(); } catch {} });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { what: 'hello' });
  return frames;
}

// ── the theme key ───────────────────────────────────────────────────────────

test('the theme key: a pack id, a kebab-case name, one bucket for an unnamed theme, a digest for any other name', () => {
  const key = identity.themeKey;
  assert.equal(key(null), 'earthy', 'nothing set: the stock look is on screen');
  assert.equal(key({ name: 'georgetown-blue', builtin: true }), 'georgetown-blue');
  assert.equal(key({ name: 'Paper', builtin: true }), 'paper', 'a pack under any spelling');
  assert.equal(key({ name: 'georgetown', builtin: true }), 'georgetown-blue', 'a retired id: the pack that replaced it');
  assert.equal(key({ name: 'web-chat', tokens: {} }), 'earthy', 'the retired stock name, with or without the flag');
  assert.equal(key({ name: 'harbor', tokens: {} }), 'harbor');
  assert.equal(key({ name: 'Harbor', tokens: {} }), 'harbor', 'case-folded, as apply finds the file on macOS');
  assert.equal(key({ tokens: { '--wc-bg': '#000000' } }), identity.UNNAMED_THEME_KEY, 'raw set_theme tokens');
  assert.equal(key({ name: '', tokens: {} }), identity.UNNAMED_THEME_KEY);

  // save_theme takes spaces and dots: such a theme gets a bucket of its own,
  // not the unnamed one, and not another such theme's.
  const ocean = key({ name: 'Ocean Dusk' });
  assert.match(ocean, /^_n-[0-9a-f]{16}$/);
  assert.notEqual(ocean, key({ name: 'Midnight Blue' }));
  assert.notEqual(ocean, identity.UNNAMED_THEME_KEY);
  assert.equal(ocean, key({ name: 'ocean dusk' }));

  // A 0.7.6 copy saved under a builtin's name paints its own tokens: it is not
  // the pack, and its images do not mix with the pack's.
  const shadow = key({ name: 'paper', tokens: { '--wc-bg': '#123456' } });
  assert.match(shadow, /^_n-/);
  assert.notEqual(shadow, 'paper');

  // and what the Settings line reads beside the key
  assert.deepEqual(identity.themeIdentity({ name: 'Ocean Dusk' }), { key: ocean, name: 'Ocean Dusk', builtin: false });
  assert.deepEqual(identity.themeIdentity(null), { key: 'earthy', name: 'earthy', builtin: true });
});

test('the theme key follows the order resolveDefault resolves in: project, user tier, the default pack', (t) => {
  const home = withTempHome(t);
  const root = tmpProject(t);
  const pp = projectPaths(root);
  assert.equal(brand.themeKey(root), 'earthy');
  fs.writeFileSync(pp.themeDefault, JSON.stringify({ name: 'georgetown-blue' }));
  assert.equal(brand.themeKey(root), 'georgetown-blue', 'a project born on 0.8 starts on its default pack');
  fs.mkdirSync(path.dirname(userPaths().theme), { recursive: true });
  fs.writeFileSync(userPaths().theme, JSON.stringify({ name: 'mine', tokens: {} }));
  assert.ok(userPaths().theme.startsWith(home));
  assert.equal(brand.themeKey(root), 'mine', 'the user tier beats the default pack');
  setTheme(root, { name: 'paper', builtin: true });
  assert.equal(brand.themeKey(root), 'paper', 'the project beats both');
  fs.writeFileSync(pp.theme, '{torn');
  assert.equal(brand.themeKey(root), 'mine', 'a torn project theme.json is passed over, as resolveDefault does');
  assert.deepEqual(brand.themeOf(root), { key: 'mine', name: 'mine', title: null });
  setTheme(root, { name: 'georgetown', builtin: true });
  assert.deepEqual(brand.themeOf(root), { key: 'georgetown-blue', name: 'georgetown-blue', title: 'Georgetown Blue' });
});

test('a theme name never becomes a path: hostile names stay one segment inside .web-chat/brand/themes/', (t) => {
  withTempHome(t);
  const root = tmpProject(t);
  const pp = projectPaths(root);
  const hostile = ['../escape', '../../../../tmp/wc-pwn', 'a/b', 'a\\b', '..', '.', 'x/../../y', '/abs/path', 'C:\\x', 'nul\u0000byte', '_unnamed/../..'];
  const keys = new Set();
  for (const name of hostile) {
    const k = identity.themeKey({ name, tokens: {} });
    assert.ok(identity.isThemeKey(k), `${JSON.stringify(name)} → ${k}`);
    assert.ok(!/[/\\]|\.\./.test(k), `${JSON.stringify(name)} → ${k}`);
    keys.add(k);
    // as the project's theme.json (a committed one, say), through the engine
    setTheme(root, { name, tokens: {} });
    assert.equal(brand.themeKey(root), k);
    brand.write(root, 'seal', PNG);
    assert.ok(fs.existsSync(path.join(pp.brandThemesDir, k, 'seal.png')), `${JSON.stringify(name)}: kept inside the themes folder`);
    assert.deepEqual(brand.read(root, 'seal').bytes, PNG);
  }
  assert.equal(keys.size, hostile.length, 'and each its own');
  // Everything landed one level under brand/themes/, and nowhere else.
  assert.deepEqual(ls(pp.brandDir), ['themes']);
  assert.deepEqual(ls(pp.brandThemesDir), [...keys].sort());
  for (const k of keys) assert.deepEqual(ls(path.join(pp.brandThemesDir, k)), ['seal.png']);

  // A key handed in is checked before it is joined.
  for (const bad of ['../x', 'a/b', '', '.', '..', 'Has Space', '_n-zz', null, undefined, 7]) {
    assert.equal(brandStore.slotFile(root, bad, 'seal', 'png'), null, String(bad));
  }
  assert.equal(brandStore.slotFile(root, 'paper', '../seal', 'png'), null, 'and so is the slot');
  assert.equal(brandStore.slotFile(root, 'paper', 'seal', 'gif'), null, 'and the format');
});

// ── switching themes ──────────────────────────────────────────────────────────

test('an image stays with the theme it was added under: switch away (its pack fill shows) and back', (t) => {
  withTempHome(t);
  const root = tmpProject(t);
  libraryTheme(root, 'harbor', { 'logotype.svg': BLUE });

  setTheme(root, { name: 'paper', builtin: true }); // A
  brand.write(root, 'logotype', PNG);
  assert.deepEqual(brand.effective(root, 'logotype').bytes, PNG);

  setTheme(root, { name: 'harbor', tokens: {} }); // B: none of its own, and a logo of its pack's
  assert.equal(brand.list(root).logotype, null, "A's image is not B's");
  assert.equal(brand.fills(root).logotype.light.type, 'image/svg+xml', "B's pack fills the empty slot");
  assert.deepEqual(brand.effective(root, 'logotype').bytes, BLUE, "B's fill shows, not A's image");

  brand.write(root, 'logotype', RED); // under B
  assert.deepEqual(brand.effective(root, 'logotype').bytes, RED, "B's own image beats its fill");
  assert.equal(brand.fills(root).logotype, null);

  setTheme(root, { name: 'paper', builtin: true }); // back to A
  assert.deepEqual(brand.effective(root, 'logotype').bytes, PNG, "A's image is back");
  assert.equal(brand.remove(root, 'logotype'), true, 'and Remove takes only the theme on screen');
  setTheme(root, { name: 'harbor', tokens: {} });
  assert.deepEqual(brand.effective(root, 'logotype').bytes, RED, "B's image survives A's removal");

  assert.deepEqual(ls(bucket(root, 'harbor')), ['logotype.svg']);
  assert.deepEqual(ls(bucket(root, 'paper')), []);
  // Two images of one size and one millisecond are still two urls: the version
  // the chrome busts /brand/<slot> with names the theme.
  setTheme(root, { name: 'paper', builtin: true });
  brand.write(root, 'logotype', BLUE);
  const stamp = new Date(Date.now() - 60_000);
  for (const k of ['paper', 'harbor']) fs.utimesSync(path.join(bucket(root, k), 'logotype.svg'), stamp, stamp);
  const vPaper = brand.list(root).logotype.version;
  setTheme(root, { name: 'harbor', tokens: {} });
  assert.notEqual(brand.list(root).logotype.version, vPaper);
});

test('over HTTP: upload under A, switch to B (empty, its fill shows), upload under B, back to A — each topbar told', async (t) => {
  const { api, port, root } = await withServer(t, { seed: existingProject });
  libraryTheme(root, 'harbor', { 'logotype.svg': BLUE, 'logotype-reversed.svg': WHITE });
  const frames = await listen(t, port);
  // The first brand frame for `key` that `action` causes.
  const brandFrame = async (key, action) => {
    const mark = frames.length;
    await action();
    return waitUntil(() => frames.slice(mark).find((f) => f.type === 'brand' && f.theme && f.theme.key === key),
      { what: `a brand frame for ${key}` });
  };
  const image = async (q = '') => {
    const r = await api.raw(`/brand/logotype${q}`);
    return r.status === 200 ? Buffer.from(await r.arrayBuffer()) : r.status;
  };
  const put = (bytes, type) => api.raw('/api/brand/logotype', { method: 'PUT', headers: { 'Content-Type': type }, body: bytes })
    .then((r) => r.json());

  await brandFrame('paper', () => api.post('/api/theme/apply', { name: 'paper', scope: 'global' }));
  let up;
  const setA = await brandFrame('paper', async () => { up = await put(PNG, 'image/png'); });
  assert.equal(up.ok, true);
  assert.deepEqual(up.theme, { key: 'paper', name: 'paper', title: 'Paper' }, 'the reply says whose image it is now');
  assert.equal(setA.slots.logotype.type, 'image/png', 'and every topbar is told');
  assert.deepEqual(await image(), PNG);

  const toB = await brandFrame('harbor', () => api.post('/api/theme/apply', { name: 'harbor', scope: 'global' }));
  assert.deepEqual(toB.theme, { key: 'harbor', name: 'harbor', title: null });
  assert.equal(toB.slots.logotype, null, 'B has no image of its own…');
  assert.equal(toB.fill.logotype.light.type, 'image/svg+xml', '…so its fill is what the topbar draws');
  assert.deepEqual(await image('?mode=light'), BLUE);
  assert.deepEqual(await image('?mode=dark'), WHITE);
  let state = (await api.get('/api/brand')).json;
  assert.equal(state.theme.key, 'harbor');
  assert.equal(state.slots.logotype, null);

  let upB;
  const setB = await brandFrame('harbor', async () => { upB = await put(RED, 'image/svg+xml'); });
  assert.equal(upB.theme.key, 'harbor');
  assert.equal(upB.fill.logotype, null, 'the fill steps aside for B\'s own');
  assert.equal(setB.slots.logotype.type, 'image/svg+xml');
  assert.deepEqual(await image('?mode=dark'), RED);

  const backToA = await brandFrame('paper', () => api.post('/api/theme/apply', { name: 'paper', scope: 'global' }));
  assert.equal(backToA.slots.logotype.type, 'image/png', "A's image is back in the frame…");
  assert.equal(backToA.fill.logotype, null, 'Paper has no logos to fill with');
  assert.deepEqual(await image(), PNG, '…and at /brand/logotype');
  state = (await api.get('/api/brand')).json;
  assert.deepEqual(state.theme, { key: 'paper', name: 'paper', title: 'Paper' });
  assert.equal(state.slots.logotype.type, 'image/png');

  const { events } = (await api.get('/api/events?since=0')).json;
  const trail = events.filter((e) => e.kind === 'brand').map((e) => `${e.op}${e.slot ? ':' + e.slot : ''}@${e.theme}`);
  assert.deepEqual(trail, ['theme@paper', 'set:logotype@paper', 'theme@harbor', 'set:logotype@harbor', 'theme@paper']);
});

test('every way the global theme moves sends a `brand` frame for the theme now on; a node or pane theme sends none', async (t) => {
  const { api, port } = await withServer(t, { seed: existingProject });
  const frames = await listen(t, port);
  const brandFrames = () => frames.filter((f) => f.type === 'brand');
  const next = async (what, fn) => {
    const n = brandFrames().length;
    await fn();
    return waitUntil(() => brandFrames()[n], { what: `a brand frame after ${what}` });
  };

  let f = await next('apply_theme', () => api.post('/api/theme/apply', { name: 'paper', scope: 'global' }));
  assert.deepEqual(f.theme, { key: 'paper', name: 'paper', title: 'Paper' });
  f = await next('set_theme global', () => api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#123456' } }));
  assert.deepEqual(f.theme, { key: identity.UNNAMED_THEME_KEY, name: null, title: null });
  f = await next('save_theme set_default', () => api.post('/api/themes', { name: 'harbor', tokens: {}, set_default: true }));
  assert.equal(f.theme.key, 'harbor');
  f = await next('set_theme clear', () => api.post('/api/theme', { scope: 'global', clear: true }));
  assert.equal(f.theme.key, 'earthy', 'cleared: an existing project is back on the stock look');
  f = await next("a pack's theme reset, announced by the CLI", () => api.post('/api/packs/announce', { theme_reset: { name: 'gone' } }));
  assert.equal(f.theme.key, 'earthy');
  for (const fr of brandFrames()) assert.ok(fr.slots && 'fill' in fr, 'each frame carries the slots and the fill');

  const { events } = (await api.get('/api/events?since=0')).json;
  assert.deepEqual(events.filter((e) => e.kind === 'brand').map((e) => [e.op, e.theme]),
    [['theme', 'paper'], ['theme', '_unnamed'], ['theme', 'harbor'], ['theme', 'earthy'], ['theme', 'earthy']]);

  // Not the global theme, so not the brand: a pane's theme, a node's, a save
  // that does not set the default.
  const before = brandFrames().length;
  await api.post('/api/render', { id: 'p1', html: '<p>x</p>' });
  await api.post('/api/theme/apply', { name: 'paper', scope: 'pane', target: 'p1' });
  await api.post('/api/theme', { scope: 'pane', target: 'p1', tokens: { '--wc-bg': '#000000' } });
  await api.post('/api/themes', { name: 'other', tokens: {} });
  const c = (await api.post('/api/commit', { message: 'seed' })).json;
  const nodeId = c.id || c.node_id;
  assert.ok(nodeId, 'a node to theme');
  await api.post('/api/theme/apply', { name: 'paper', scope: 'node', target: nodeId });
  // A brand frame would be broadcast before the frame of the route that caused
  // it, on the same socket — so once this last one is in, none is on the way.
  await api.post('/api/theme', { scope: 'pane', target: 'p1', clear: true });
  await waitUntil(() => frames.some((fr) => fr.type === 'theme' && fr.scope === 'pane' && fr.theme === null),
    { what: 'the last pane theme frame' });
  assert.equal(brandFrames().length, before);
});

test('an export inlines the lockup and seal of the theme it is exported under', async (t) => {
  const { api, root } = await withServer(t, { seed: existingProject });
  await api.post('/api/render', { id: 'p1', html: '<div>body</div>' });
  await api.post('/api/commit', { message: 'seed' });
  const exported = async () => (await api.get('/api/export/active')).text;
  const lockupOf = (bytes, type) => `<img class="brand-lockup" alt="lockup" src="data:${type};base64,${bytes.toString('base64')}">`;

  await api.post('/api/theme/apply', { name: 'paper', scope: 'global' });
  brand.write(root, 'lockup', PNG);
  assert.ok((await exported()).includes(lockupOf(PNG, 'image/png')));

  await api.post('/api/theme/apply', { name: 'earthy', scope: 'global' });
  assert.doesNotMatch(await exported(), /class="brand-lockup"/, "Earthy has no lockup: Paper's stays with Paper");
  brand.write(root, 'lockup', RED);
  let html = await exported();
  assert.ok(html.includes(lockupOf(RED, 'image/svg+xml')));
  assert.ok(!html.includes(PNG.toString('base64')));

  await api.post('/api/theme/apply', { name: 'paper', scope: 'global' });
  html = await exported();
  assert.ok(html.includes(lockupOf(PNG, 'image/png')), "Paper's lockup again");
  assert.ok(!html.includes(RED.toString('base64')));
});

// ── the v2 → v3 migration ─────────────────────────────────────────────────────

// A project as 0.8.0 left it: schema v2, its images in .web-chat/brand/.
function v2Project(t, { theme = null, files = {} } = {}) {
  const root = tmpProject(t);
  const pp = projectPaths(root);
  fs.writeFileSync(pp.version, JSON.stringify({ version: 2 }) + '\n');
  if (theme) fs.writeFileSync(pp.theme, JSON.stringify(theme));
  fs.mkdirSync(pp.brandDir, { recursive: true });
  for (const [f, bytes] of Object.entries(files)) fs.writeFileSync(path.join(pp.brandDir, f), bytes);
  return { root, pp, stateDir: pp.dir };
}
const versionOf = (pp) => JSON.parse(fs.readFileSync(pp.version, 'utf8')).version;

test('migration: a v2 project\'s images move into the bucket of the theme it is on, bytes and mtime intact', async (t) => {
  withTempHome(t);
  const { root, pp, stateDir } = v2Project(t, { theme: { name: 'paper', builtin: true }, files: { 'logotype.png': PNG, 'seal.svg': RED } });
  const mtime = fs.statSync(path.join(pp.brandDir, 'logotype.png')).mtimeMs;
  const said = await quiet(() => run(stateDir));
  assert.match(said, /migrated state 2 → 3/);
  assert.equal(versionOf(pp), SCHEMA_VERSION);
  assert.deepEqual(ls(pp.brandDir), ['themes'], 'nothing is left where it was');
  assert.deepEqual(ls(bucket(root, 'paper')), ['logotype.png', 'seal.svg']);
  assert.equal(fs.statSync(path.join(bucket(root, 'paper'), 'logotype.png')).mtimeMs, mtime, 'moved, not rewritten');
  assert.deepEqual(brand.read(root, 'logotype').bytes, PNG, 'the user sees what they saw before the upgrade');
  assert.deepEqual(brand.read(root, 'seal').bytes, RED);

  setTheme(root, { name: 'earthy', builtin: true });
  assert.equal(brand.read(root, 'logotype'), null, 'and from now on they are Paper\'s');
});

test('migration: the theme is the one the project is on — nothing set, a 0.8 default pack, the user tier', async (t) => {
  withTempHome(t);
  const none = v2Project(t, { files: { 'logotype.png': PNG } });
  await quiet(() => run(none.stateDir));
  assert.deepEqual(ls(bucket(none.root, 'earthy')), ['logotype.png'], 'no theme set: the stock look\'s');

  const born08 = v2Project(t, { files: { 'lockup.png': PNG } });
  fs.writeFileSync(born08.pp.themeDefault, JSON.stringify({ name: 'georgetown-blue' }));
  await quiet(() => run(born08.stateDir));
  assert.deepEqual(ls(bucket(born08.root, 'georgetown-blue')), ['lockup.png'], 'a project born on 0.8: its default pack');

  fs.mkdirSync(path.dirname(userPaths().theme), { recursive: true });
  fs.writeFileSync(userPaths().theme, JSON.stringify({ name: 'Ocean Dusk', tokens: {} }));
  const user = v2Project(t, { files: { 'seal.png': PNG } });
  await quiet(() => run(user.stateDir));
  const k = identity.themeKey({ name: 'Ocean Dusk' });
  assert.deepEqual(ls(bucket(user.root, k)), ['seal.png'], 'the user tier\'s theme, under its digest');
  assert.deepEqual(brand.read(user.root, 'seal').bytes, PNG);
});

test('migration: idempotent — a second pass of the step, and a re-run of the runner, change nothing', async (t) => {
  withTempHome(t);
  const { root, pp, stateDir } = v2Project(t, { theme: { name: 'paper', builtin: true }, files: { 'logotype.svg': RED } });
  await quiet(() => run(stateDir));
  const snapshot = () => ({ brand: ls(pp.brandDir), bucket: ls(bucket(root, 'paper')), bytes: fs.readFileSync(path.join(bucket(root, 'paper'), 'logotype.svg')) });
  const after = snapshot();
  await quiet(() => v2ToV3(stateDir));
  assert.deepEqual(snapshot(), after);
  // A torn _version.json makes the runner assume v1 and re-run every step.
  fs.writeFileSync(pp.version, '{"version": 3');
  await quiet(() => run(stateDir));
  assert.deepEqual(snapshot(), after);
  assert.equal(versionOf(pp), SCHEMA_VERSION);
});

test('migration: an image already in the bucket wins; the old file is renamed aside, never deleted', async (t) => {
  withTempHome(t);
  const { root, pp, stateDir } = v2Project(t, {
    theme: { name: 'paper', builtin: true },
    files: { 'logotype.png': PNG, 'lockup.svg': RED },
  });
  fs.mkdirSync(bucket(root, 'paper'), { recursive: true });
  fs.writeFileSync(path.join(bucket(root, 'paper'), 'logotype.svg'), BLUE); // the other format, even
  await quiet(() => run(stateDir));

  assert.deepEqual(ls(bucket(root, 'paper')), ['lockup.svg', 'logotype.svg']);
  assert.deepEqual(fs.readFileSync(path.join(bucket(root, 'paper'), 'logotype.svg')), BLUE, 'the bucket\'s copy is untouched');
  assert.deepEqual(brand.read(root, 'logotype').bytes, BLUE);
  const aside = ls(pp.brandDir).filter((f) => f.startsWith('logotype.png.superseded-'));
  assert.equal(aside.length, 1, ls(pp.brandDir).join(', '));
  assert.deepEqual(fs.readFileSync(path.join(pp.brandDir, aside[0])), PNG, 'the old image is kept, beside where it was');
  assert.deepEqual(ls(pp.brandDir), [...aside, 'themes'].sort(), 'and nothing else is left');

  await quiet(() => v2ToV3(stateDir));
  assert.deepEqual(ls(pp.brandDir).filter((f) => f.startsWith('logotype.png.superseded-')), aside, 'a second pass leaves it alone');
});

test('migration: a symlinked image is not followed, read or moved; a brand/ folder linked out of the project moves nothing', async (t) => {
  withTempHome(t);
  const outside = tmpDir(t, 'wc-bpt-out-');
  const secret = path.join(outside, 'secret.png');
  fs.writeFileSync(secret, PNG);
  const { root, pp, stateDir } = v2Project(t, { files: { 'logotype.svg': RED } });
  // one link out of the project, one to a file inside it
  fs.symlinkSync(secret, path.join(pp.brandDir, 'seal.png'));
  const inside = path.join(pp.dir, 'captures', 'shot.png');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, PNG);
  fs.symlinkSync(inside, path.join(pp.brandDir, 'lockup.png'));
  await quiet(() => run(stateDir));
  assert.deepEqual(ls(bucket(root, 'earthy')), ['logotype.svg'], 'the regular file moved; neither link did');
  for (const f of ['seal.png', 'lockup.png']) {
    assert.ok(fs.lstatSync(path.join(pp.brandDir, f)).isSymbolicLink(), `${f}: the link stays put, where nothing reads`);
  }
  assert.deepEqual(fs.readFileSync(secret), PNG, 'their targets untouched');
  assert.deepEqual(fs.readFileSync(inside), PNG);
  assert.deepEqual(ls(outside), ['secret.png']);
  assert.equal(brand.read(root, 'seal'), null);
  assert.equal(brand.read(root, 'lockup'), null);

  // The whole brand/ folder a link out of the project: fenced, so nothing moves
  // out of it — and no themes/ folder is made inside it.
  const elsewhere = tmpDir(t, 'wc-bpt-else-');
  fs.writeFileSync(path.join(elsewhere, 'logotype.png'), PNG);
  const linked = v2Project(t);
  fs.rmSync(linked.pp.brandDir, { recursive: true });
  fs.symlinkSync(elsewhere, linked.pp.brandDir);
  await quiet(() => run(linked.stateDir));
  assert.deepEqual(ls(elsewhere), ['logotype.png']);
  assert.equal(versionOf(linked.pp), SCHEMA_VERSION, 'and the project still migrates');
});

test('migration on boot: a 0.8.0 project keeps its logo, under the theme it was on, and the logo stays with that theme', async (t) => {
  let ctx;
  await quiet(async () => {
    ctx = await withServer(t, {
      seed: ({ root }) => {
        const pp = projectPaths(root);
        fs.writeFileSync(pp.version, JSON.stringify({ version: 2 }) + '\n');
        fs.writeFileSync(pp.themeDefault, JSON.stringify({ name: 'georgetown-blue' }));
        fs.mkdirSync(pp.brandDir, { recursive: true });
        fs.writeFileSync(path.join(pp.brandDir, 'logotype.png'), PNG);
      },
    });
  });
  const { api, root } = ctx;
  let r = (await api.get('/api/brand')).json;
  assert.deepEqual(r.theme, { key: 'georgetown-blue', name: 'georgetown-blue', title: 'Georgetown Blue' });
  assert.equal(r.slots.logotype.type, 'image/png', 'the logo the user had is still in the topbar');
  assert.equal(versionOf(projectPaths(root)), SCHEMA_VERSION);

  await api.post('/api/theme/apply', { name: 'paper', scope: 'global' });
  r = (await api.get('/api/brand')).json;
  assert.equal(r.slots.logotype, null, 'Paper does not wear it');
  await api.post('/api/theme/apply', { name: 'georgetown-blue', scope: 'global' });
  assert.equal((await api.get('/api/brand')).json.slots.logotype.type, 'image/png', 'Georgetown Blue does');
});

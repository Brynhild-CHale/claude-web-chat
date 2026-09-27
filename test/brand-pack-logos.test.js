// A theme pack's per-user logos (lib/server/brand.js, "A pack's per-user
// logos"): while a project's global theme resolves to Georgetown Blue, a brand
// slot the PROJECT left empty is filled from
// userPaths().themeLogosDir('georgetown-blue') — the topbar logotype, and an
// export's lockup and seal — with `<slot>-reversed.*` used in dark mode. The
// folder is created holding only a README.txt by `install` and `update` (never
// lazily on first use), never rewritten, and deliberately advertised nowhere
// else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const brand = require('../lib/server/brand');
const themeLogos = require('../lib/setup/theme-logos');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { withServer, withTempHome, existingProject } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const PACK = 'georgetown-blue';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');
const svg = (fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`);
const NAVY = svg('#041E42');
const WHITE = svg('#ffffff');

function project(t, themeName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-packlogo-'));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (themeName) fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: themeName, builtin: true, tokens: {} }));
  return root;
}
const logos = () => userPaths().themeLogosDir(PACK);
function drop(name, bytes) {
  fs.mkdirSync(logos(), { recursive: true });
  fs.writeFileSync(path.join(logos(), name), bytes);
}
// console.error, captured for the length of fn
async function captureErrors(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

// --- the folder ----------------------------------------------------------------

test('the folder lives under the user tier, beside the system theme library', (t) => {
  const home = withTempHome(t);
  assert.equal(logos(), path.join(home, '.web-chat', 'themes', PACK, 'logos'));
});

// `install` with its daemon pre-warm patched out — install destructures
// spawnDaemon at module load, so the patch has to happen first — and its
// console output captured.
async function runInstall(t, root) {
  const daemonMod = require('../lib/util/daemon');
  const realSpawn = daemonMod.spawnDaemon;
  daemonMod.spawnDaemon = async () => null;
  const install = require('../lib/cli/commands/install');
  daemonMod.spawnDaemon = realSpawn;
  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await install([], { cwd: root, runClaude: () => ({ ok: false, stderr: 'not in a test' }) });
  } finally {
    console.log = prevLog;
  }
  return lines.join('\n');
}

test('`install` makes the folder, holding only README.txt, whatever theme the project is on — reading a fill never does', async (t) => {
  withTempHome(t);
  brand.fills(project(t, PACK));
  brand.effective(project(t, PACK), 'logotype');
  assert.ok(!fs.existsSync(logos()), 'first use of the pack creates nothing: the folder is made at install/update, not lazily');

  const out = await runInstall(t, project(t, 'earthy'));
  assert.deepEqual(fs.readdirSync(logos()), ['README.txt'], 'a project on another pack still gets it');
  assert.doesNotMatch(out, /logos|georgetown/i, 'install says nothing about it');
  const readme = fs.readFileSync(path.join(logos(), 'README.txt'), 'utf8');
  assert.equal(readme, brand.LOGOS_README);
  assert.equal(readme, themeLogos.LOGOS_README);
  // the exact specs
  for (const want of [
    /logotype\s+the topbar, drawn at 150 x 22/, /lockup\s+the header of an exported page, drawn at 260 x 52/,
    /seal\s+the footer of an exported page, drawn at 44 x 44/,
    /logotype\.svg\s+or\s+logotype\.png/, /lockup\.svg\s+or\s+lockup\.png/, /seal\.svg\s+or\s+seal\.png/,
    /logotype-reversed\.svg\|png, lockup-reversed\.svg\|png, seal-reversed\.svg\|png/,
    /SVG is preferred/, /scripts/, /event handlers/, /external references/, /<foreignObject>/,
    /PNG at 2x on a transparent background/, /logotype 300 x 44, lockup 520 x 104, seal 88 x 88/,
    /At most 256 KB each/, /#041E42 on light backgrounds/,
  ]) assert.match(readme, want);
  assert.ok(!/[^\x00-\x7f]/.test(readme), 'plain ASCII text');

  // idempotent: a second install leaves an edited README as it is
  fs.writeFileSync(path.join(logos(), 'README.txt'), 'my notes');
  await runInstall(t, project(t, null));
  assert.equal(fs.readFileSync(path.join(logos(), 'README.txt'), 'utf8'), 'my notes');
});

test('the old id `georgetown` counts as the pack too', (t) => {
  withTempHome(t);
  drop('logotype.svg', NAVY);
  const f = brand.fills(project(t, 'georgetown'));
  assert.equal(f.logotype.light.type, 'image/svg+xml');
});

test('README.txt is never rewritten: an edited one, a folder with files, a deleted one', (t) => {
  withTempHome(t);
  themeLogos.seedThemeLogos();
  const readme = path.join(logos(), 'README.txt');
  fs.writeFileSync(readme, 'my notes');
  themeLogos.seedThemeLogos();
  assert.equal(fs.readFileSync(readme, 'utf8'), 'my notes', 'an edit survives');

  fs.rmSync(readme);
  drop('seal.png', PNG);
  themeLogos.seedThemeLogos();
  assert.deepEqual(fs.readdirSync(logos()), ['seal.png'], 'a folder the user filled is left as it is');

  // a crash between mkdir and write leaves it empty: then, and only then, again
  fs.rmSync(path.join(logos(), 'seal.png'));
  themeLogos.seedThemeLogos();
  assert.deepEqual(fs.readdirSync(logos()), ['README.txt']);
});

test('a `gtown` theme PACK beside the seeded folder: its own logos fill through the pack path, the folder is not consulted', (t) => {
  withTempHome(t);
  themeLogos.seedThemeLogos();
  drop('logotype.svg', NAVY);
  const up = userPaths();
  fs.mkdirSync(up.themeLogosDir('gtown'), { recursive: true });
  fs.writeFileSync(path.join(up.themesDir, 'gtown.json'), JSON.stringify({ name: 'gtown', tokens: {} }));
  fs.writeFileSync(path.join(up.themeLogosDir('gtown'), 'logotype.svg'), WHITE);
  const root = project(t, null);
  fs.writeFileSync(projectPaths(root).theme, JSON.stringify({ name: 'gtown', tokens: {} }));

  assert.deepEqual(brand.fillSource(root), { name: 'gtown', dir: up.themeLogosDir('gtown') });
  assert.deepEqual(brand.effective(root, 'logotype').bytes, WHITE, 'the pack\'s mark, not the builtin folder\'s');
  assert.deepEqual(brand.effective(project(t, PACK), 'logotype').bytes, NAVY, 'Georgetown Blue itself still reads its folder');
});

// --- the fill -------------------------------------------------------------------

test('fill: an empty project slot takes the folder file; a project upload wins; other packs never fill', (t) => {
  withTempHome(t);
  const gt = project(t, PACK);
  drop('logotype.svg', NAVY);
  drop('seal.png', PNG);

  const f = brand.fills(gt);
  assert.equal(f.logotype.light.type, 'image/svg+xml');
  assert.equal(f.logotype.dark.type, 'image/svg+xml', 'no reversed file: dark uses the regular one');
  assert.equal(f.seal.light.type, 'image/png');
  assert.equal(f.lockup, null);
  assert.ok(f.logotype.light.version);
  assert.deepEqual(brand.list(gt), { logotype: null, lockup: null, seal: null }, 'the project slots stay empty');
  assert.deepEqual(brand.effective(gt, 'logotype').bytes, NAVY);

  brand.write(gt, 'logotype', PNG);
  assert.equal(brand.fills(gt).logotype, null, 'the project set it: no fill');
  assert.deepEqual(brand.effective(gt, 'logotype', { mode: 'dark' }).bytes, PNG, 'the upload wins in either mode');

  const earthy = project(t, 'earthy');
  assert.deepEqual(brand.fills(earthy), { logotype: null, lockup: null, seal: null });
  assert.equal(brand.effective(earthy, 'seal'), null);
  assert.equal(brand.effective(null, 'seal'), null, 'no project, no fill');
});

test('fill: reversed variants are dark mode\'s; svg is preferred over png', (t) => {
  withTempHome(t);
  const gt = project(t, PACK);
  drop('lockup.png', PNG);
  drop('lockup.svg', NAVY);
  drop('lockup-reversed.svg', WHITE);
  drop('seal-reversed.svg', WHITE);

  assert.deepEqual(brand.effective(gt, 'lockup').bytes, NAVY, 'light: the regular file, svg first');
  assert.deepEqual(brand.effective(gt, 'lockup', { mode: 'dark' }).bytes, WHITE, 'dark: the reversed file');
  assert.equal(brand.effective(gt, 'seal'), null, 'a white mark alone is not drawn on light');
  assert.deepEqual(brand.effective(gt, 'seal', { mode: 'dark' }).bytes, WHITE);
  const f = brand.fills(gt);
  assert.equal(f.seal.light, null);
  assert.equal(f.seal.dark.type, 'image/svg+xml');
});

test('fill: the files go through the upload validation; a bad one is ignored with ONE log line', async (t) => {
  withTempHome(t);
  const gt = project(t, PACK);
  drop('logotype.svg', Buffer.from('<svg onload="alert(1)"><rect/></svg>'));
  drop('logotype.png', PNG);                                    // the valid fallback beside it
  drop('lockup.svg', Buffer.from('<svg><script>1</script></svg>'));
  drop('seal.png', Buffer.concat([PNG, Buffer.alloc(brand.MAX_BYTES)]));
  drop('seal-reversed.png', Buffer.from('<svg></svg>'));        // an svg dressed as a png

  const lines = await captureErrors(async () => {
    for (let i = 0; i < 3; i++) brand.fills(gt);
    brand.effective(gt, 'seal', { mode: 'dark' });
  });
  assert.deepEqual(brand.effective(gt, 'logotype').bytes, PNG, 'the refused svg is skipped for the png');
  assert.equal(brand.effective(gt, 'lockup'), null);
  assert.equal(brand.effective(gt, 'seal'), null);
  assert.equal(brand.effective(gt, 'seal', { mode: 'dark' }), null);
  assert.equal(lines.length, 4, `one line per bad file, however often it is read:\n${lines.join('\n')}`);
  assert.ok(lines.some((l) => l.includes('logotype.svg') && /event handler/.test(l)));
  assert.ok(lines.some((l) => l.includes('lockup.svg') && /script/.test(l)));
  assert.ok(lines.some((l) => l.includes('seal.png') && /limit/.test(l)));
  assert.ok(lines.some((l) => l.includes('seal-reversed.png') && /not a PNG/.test(l)));
});

// --- routes and export ------------------------------------------------------------

test('routes: /api/brand reports the fill beside empty slots; /brand/:slot serves it per mode', async (t) => {
  // An existing project, so it starts on Earthy (a new one starts on the pack).
  const { baseUrl: b0, root, api } = await withServer(t, { seed: existingProject });
  const baseUrl = b0.replace('localhost', '127.0.0.1');
  drop('logotype.svg', NAVY);
  drop('logotype-reversed.svg', WHITE);

  let r = await (await fetch(`${baseUrl}/api/brand`)).json();
  assert.deepEqual(r.fill, { logotype: null, lockup: null, seal: null }, 'Earthy: nothing fills');
  assert.equal((await fetch(`${baseUrl}/brand/logotype`)).status, 404);

  await api.post('/api/theme/apply', { name: PACK, scope: 'global' });
  r = await (await fetch(`${baseUrl}/api/brand`)).json();
  assert.deepEqual(r.slots, { logotype: null, lockup: null, seal: null }, 'Settings still sees empty slots');
  assert.equal(r.fill.logotype.light.type, 'image/svg+xml');
  assert.notEqual(r.fill.logotype.light.version, undefined);
  const light = await fetch(`${baseUrl}/brand/logotype?mode=light`);
  assert.equal(light.status, 200);
  assert.equal(light.headers.get('content-security-policy'), brand.BRAND_CSP, 'locked down like an upload');
  assert.deepEqual(Buffer.from(await light.arrayBuffer()), NAVY);
  const dark = await fetch(`${baseUrl}/brand/logotype?mode=dark`);
  assert.deepEqual(Buffer.from(await dark.arrayBuffer()), WHITE);

  // an upload takes the slot, and its reply says the fill stepped aside
  const up = await (await fetch(`${baseUrl}/api/brand/logotype`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG })).json();
  assert.equal(up.fill.logotype, null);
  assert.deepEqual(Buffer.from(await (await fetch(`${baseUrl}/brand/logotype?mode=dark`)).arrayBuffer()), PNG);
  const del = await (await fetch(`${baseUrl}/api/brand/logotype`, { method: 'DELETE' })).json();
  assert.equal(del.fill.logotype.dark.type, 'image/svg+xml', 'removed: the fill is back');
  void root;
});

test('export: an empty lockup and seal are inlined from the folder, in the light mode', async (t) => {
  const { api, root } = await withServer(t);
  await api.post('/api/theme/apply', { name: PACK, scope: 'global' });
  drop('lockup.svg', NAVY);
  drop('lockup-reversed.svg', WHITE);
  drop('seal.png', PNG);
  await api.post('/api/render', { id: 'p1', html: '<div>body</div>' });
  await api.post('/api/commit', { message: 'seed' });
  let html = (await api.get('/api/export/active')).text;
  assert.ok(html.includes(`<img class="brand-lockup" alt="lockup" src="data:image/svg+xml;base64,${NAVY.toString('base64')}">`));
  assert.ok(!html.includes(WHITE.toString('base64')), 'the reversed mark stays out of a light export');
  assert.ok(html.includes(`<img class="brand-seal" alt="seal" src="data:image/png;base64,${PNG.toString('base64')}">`));

  brand.write(root, 'seal', NAVY);
  html = (await api.get('/api/export/active')).text;
  assert.ok(html.includes(`<img class="brand-seal" alt="seal" src="data:image/svg+xml;base64,${NAVY.toString('base64')}">`),
    "the project's own seal wins");
});

// --- the chrome ---------------------------------------------------------------------

async function bootChrome(t) {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  };
  const calls = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u === '/api/brand') return json({ slots: { logotype: null, lockup: null, seal: null } });
    if (u === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.3.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
    return json({ ok: true });
  };
  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element', 'MutationObserver'];
  for (const k of keys) {
    try { saved[k] = global[k]; } catch {}
    try { Object.defineProperty(global, k, { value: window[k], configurable: true, writable: true }); } catch { try { global[k] = window[k]; } catch {} }
  }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));
  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 400)); // let a theme swap's transition timer lapse
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  });
  await new Promise((r) => setTimeout(r, 40));
  return { window, calls, ws: () => wsInstances[0] };
}

test('chrome: the topbar shows the fill per mode, the project slot wins, Settings never shows it', async (t) => {
  const { window, ws, calls } = await bootChrome(t);
  const doc = window.document;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const frame = (msg) => ws().onmessage({ data: JSON.stringify(msg) });
  const logo = () => doc.getElementById('brand-logotype');
  const empty = { logotype: null, lockup: null, seal: null };
  const fill = {
    logotype: { light: { type: 'image/svg+xml', bytes: 9, version: 'L1' }, dark: { type: 'image/svg+xml', bytes: 9, version: 'D1' } },
    lockup: null, seal: null,
  };

  assert.equal(doc.documentElement.dataset.theme, 'light');
  frame({ type: 'brand', slots: empty, fill });
  assert.equal(logo().getAttribute('src'), '/brand/logotype?mode=light&v=L1');

  delete doc.documentElement.dataset.theme; // theme.js's dark
  await tick();
  assert.equal(logo().getAttribute('src'), '/brand/logotype?mode=dark&v=D1', 'a mode flip swaps to the reversed mark');
  doc.documentElement.dataset.theme = 'light';
  await tick();
  assert.equal(logo().getAttribute('src'), '/brand/logotype?mode=light&v=L1');

  // only a reversed mark: nothing on light, drawn on dark
  frame({ type: 'brand', slots: empty, fill: { ...fill, logotype: { light: null, dark: fill.logotype.dark } } });
  assert.equal(logo(), null);
  delete doc.documentElement.dataset.theme;
  await tick();
  assert.equal(logo().getAttribute('src'), '/brand/logotype?mode=dark&v=D1');
  doc.documentElement.dataset.theme = 'light';
  await tick();

  // the project's own logotype wins; a frame without `fill` keeps the known one
  frame({ type: 'brand', slots: { ...empty, logotype: { type: 'image/png', bytes: 5, version: 'own' } }, fill });
  assert.equal(logo().getAttribute('src'), '/brand/logotype?v=own');
  frame({ type: 'brand', slots: empty });
  assert.equal(logo().getAttribute('src'), '/brand/logotype?mode=light&v=L1');

  // Settings → Brand shows the project's slots only: all three empty
  const rows = [...doc.querySelectorAll('#settings-panel .brand-slot')];
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.querySelector('.brand-drop img'), null, `${row.dataset.slot}: no fill preview`);
    assert.equal(row.querySelector('.brand-remove').disabled, true);
  }

  // a global theme change re-reads the brand (the pack decides the fill)
  const before = calls.filter((u) => u === '/api/brand').length;
  frame({ type: 'theme', scope: 'global', theme: { name: 'earthy', tokens: {} } });
  await tick();
  assert.equal(calls.filter((u) => u === '/api/brand').length, before + 1);
});

// --- not advertised ------------------------------------------------------------------

test('the folder is advertised nowhere a user reads: docs, rules, CHANGELOG, help, the chrome\'s UI', () => {
  const texts = [];
  const walk = (dir, keep) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel, keep);
      else if (keep(rel)) texts.push([rel, fs.readFileSync(path.join(REPO, rel), 'utf8')]);
    }
  };
  walk('docs', (f) => f.endsWith('.md'));
  walk('templates', (f) => /\.(md|txt|json)$/.test(f));
  for (const f of ['README.md', 'CHANGELOG.md', '.claude/rules/web-chat.md', 'public/index.html']) {
    texts.push([f, fs.readFileSync(path.join(REPO, f), 'utf8')]);
  }
  walk('lib/cli', (f) => f.endsWith('.js'));
  walk('lib/mcp', (f) => f.endsWith('.js'));
  // Narrowed when theme PACKS gained logos (docs/component-packs.md documents a
  // pack's `themes/<name>/logos/` and its `-reversed` marks — the maintainer
  // asked for exactly that). What stays unadvertised is the builtin pack's
  // per-user folder: its path, in any spelling, and the idea of a logos folder
  // a user drops files into.
  for (const [f, text] of texts) {
    assert.doesNotMatch(text, /themes\/georgetown-blue|georgetown-blue\/logos|logos folder|themeLogosDir|\.web-chat\/themes\/[^\s`'")]*\/logos/i, f);
  }
});

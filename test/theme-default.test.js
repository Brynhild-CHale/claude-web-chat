// s2-3 — Georgetown Blue is the look a NEW project starts in; an existing
// project keeps Earthy. And the documents the daemon renders for a viewer
// (/preview/node, /preview/pane, /replay) follow that viewer's light/dark,
// while downloads, exports and rendered files stay light unless asked.
//
// "New" is decided once, by the migration runner: a first touch (no
// _version.json) seeds .web-chat/theme-default.json, the LAST step of
// resolveDefault. A project that has ever booted a daemon has a version file,
// never gets the marker, and resolves exactly as it did before this build.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { withServer, withTempHome, existingProject } = require('../test-support/helpers');
const { run, NEW_PROJECT_PACK } = require('../lib/update/migrations');
const { getBuiltin, normalizeTheme, resolveDefault } = require('../lib/server/theme');
const { projectPaths } = require('../lib/core/paths');
const { normalizeRenderRequest, renderReplay } = require('../lib/server/replay/render');
const { createScriptStore } = require('../lib/server/replay/scripts');
const { createGraph } = require('../lib/server/graph');
const { createState } = require('../lib/server/state');

const GT = normalizeTheme({ name: 'georgetown-blue', builtin: true });
const EARTHY = normalizeTheme({ name: 'earthy', builtin: true });
const bgOf = (html) => (html.match(/--wc-bg:\s*([^;]+);/) || [])[1];

function tmpProject(prefix = 'wc-td-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.web-chat'));
  return { root, stateDir: path.join(root, '.web-chat'), pp: projectPaths(root) };
}
const resolve = (pp, home) => resolveDefault({
  THEME_PATH: pp.theme, SYSTEM_THEME_PATH: path.join(home || '/nonexistent', 'theme.json'), THEME_DEFAULT_PATH: pp.themeDefault,
});

// ── the marker ──────────────────────────────────────────────────────────────

test('the new-project pack is a builtin — Georgetown Blue', () => {
  assert.equal(NEW_PROJECT_PACK, 'georgetown-blue');
  assert.ok(getBuiltin(NEW_PROJECT_PACK), 'a name resolveDefault can resolve');
});

test('a first touch seeds the marker; an existing project (any recorded version) never gets one', () => {
  const fresh = tmpProject();
  run(fresh.stateDir);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh.pp.themeDefault, 'utf8')), { name: 'georgetown-blue' });
  assert.equal(resolve(fresh.pp).name, 'georgetown-blue');

  for (const version of [1, 2]) {
    const old = tmpProject();
    fs.writeFileSync(old.pp.version, JSON.stringify({ version }) + '\n');
    run(old.stateDir);
    assert.equal(fs.existsSync(old.pp.themeDefault), false, `a v${version} project is not new`);
    assert.deepEqual(resolve(old.pp), { tokens: {} }, `a v${version} project keeps the stock (Earthy) fallback`);
  }
});

test('the marker is never rewritten, and only a builtin name in it counts', () => {
  const p = tmpProject();
  fs.writeFileSync(p.pp.themeDefault, JSON.stringify({ name: 'paper' }));
  run(p.stateDir); // a first touch, but the marker is there already
  assert.deepEqual(JSON.parse(fs.readFileSync(p.pp.themeDefault, 'utf8')), { name: 'paper' });
  assert.equal(resolve(p.pp).name, 'paper');
  fs.writeFileSync(p.pp.themeDefault, JSON.stringify({ name: 'no-such-pack' }));
  assert.deepEqual(resolve(p.pp), { tokens: {} }, 'an unknown name falls through to the stock look');
  fs.writeFileSync(p.pp.themeDefault, '{torn');
  assert.deepEqual(resolve(p.pp), { tokens: {} }, 'a torn marker too');
});

test('the marker is the LAST step: a project or user theme.json still wins', () => {
  const p = tmpProject();
  run(p.stateDir);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-td-home-'));
  fs.writeFileSync(path.join(home, 'theme.json'), JSON.stringify({ name: 'mine', tokens: { '--wc-bg': '#010203' } }));
  assert.equal(resolve(p.pp, home).name, 'mine', 'the user tier beats the new-project default');
  fs.writeFileSync(p.pp.theme, JSON.stringify({ name: 'paper', builtin: true }));
  assert.equal(resolve(p.pp, home).name, 'paper', 'the project tier beats both');
});

// ── over HTTP ──────────────────────────────────────────────────────────────

test('a new project boots on Georgetown Blue — the chrome\'s hello and /api/theme agree; clearing returns to it', async (t) => {
  withTempHome(t);
  const { api, wsHello } = await withServer(t);
  const g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.name, 'georgetown-blue');
  assert.equal(g.tokens['--wc-bg'], GT.modes.light.tokens['--wc-bg']);
  assert.equal((await wsHello()).theme.name, 'georgetown-blue', 'the chrome paints it from the first frame');

  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#111111' } });
  assert.equal((await api.get('/api/theme?scope=global')).json.tokens['--wc-accent'], '#111111');
  await api.post('/api/theme', { scope: 'global', clear: true });
  assert.equal((await api.get('/api/theme?scope=global')).json.name, 'georgetown-blue',
    'clearing the project theme falls back to the new-project default, not to Earthy');
});

test('an existing project keeps its look across the upgrade — the empty stock global', async (t) => {
  withTempHome(t);
  const { root, api, wsHello } = await withServer(t, { seed: existingProject });
  assert.deepEqual((await api.get('/api/theme?scope=global')).json.tokens, {});
  assert.deepEqual((await wsHello()).theme.tokens, {});
  assert.equal(fs.existsSync(projectPaths(root).themeDefault), false);
});

// ── previews follow the viewer's mode; files stay light ───────────────────

async function oneNode(api) {
  await api.post('/api/render', { id: 'p1', html: '<p>x</p>' });
  const c = (await api.post('/api/commit', { message: 'seed' })).json;
  return c.id || c.node_id || 'n0';
}

test('under a two-mode pack: previews and the player take ?mode=; downloads and exports are light unless asked', async (t) => {
  withTempHome(t);
  const { api } = await withServer(t); // new project → Georgetown Blue
  const id = await oneNode(api);
  const light = GT.modes.light.tokens['--wc-bg'];
  const dark = GT.modes.dark.tokens['--wc-bg'];
  for (const p of [`/preview/node/${id}`, `/preview/pane/${id}/p1`, `/replay?from=${id}&to=${id}`]) {
    const q = p.includes('?') ? '&' : '?';
    assert.equal(bgOf((await api.get(p)).text), light, `${p}: light with no mode`);
    assert.equal(bgOf((await api.get(`${p}${q}mode=dark`)).text), dark, `${p}: the viewer's dark`);
    assert.equal(bgOf((await api.get(`${p}${q}mode=light`)).text), light, `${p}: the viewer's light`);
  }
  // Files: light by default, whatever the viewer shows; a mode only when named.
  assert.equal(bgOf((await api.get(`/api/replay/html?from=${id}&to=${id}`)).text), light, 'replay.html download: light');
  assert.equal(bgOf((await api.get(`/api/replay/html?from=${id}&to=${id}&mode=dark`)).text), dark, 'replay.html: dark when asked');
  assert.equal(bgOf((await api.get(`/api/export/${id}`)).text), light, 'page export: light');
  assert.equal(bgOf((await api.get(`/api/export/${id}?mode=dark`)).text), dark, 'page export: dark when asked');
});

test('an existing project on the stock look: a named mode draws it over Earthy, as the chrome does; no mode changes nothing', async (t) => {
  withTempHome(t);
  const { api } = await withServer(t, { seed: existingProject });
  const id = await oneNode(api);
  const plain = (await api.get(`/preview/node/${id}`)).text;
  assert.equal(bgOf(plain), undefined, 'no mode: no tokens baked — byte-for-byte the pre-upgrade preview');
  assert.equal(bgOf((await api.get(`/preview/node/${id}?mode=dark`)).text), EARTHY.modes.dark.tokens['--wc-bg'],
    'a dark viewer gets Earthy dark — what app.css paints the live page with');
  assert.equal(bgOf((await api.get(`/preview/node/${id}?mode=light`)).text), EARTHY.modes.light.tokens['--wc-bg']);
  assert.equal(bgOf((await api.get(`/api/export/${id}`)).text), undefined, 'an export is unchanged');
});

test('a rendered replay file is light unless the request names a mode, which reaches the page it draws', async () => {
  assert.equal(normalizeRenderRequest({ format: 'gif' }).mode, null);
  assert.equal(normalizeRenderRequest({ format: 'gif', mode: 'dark' }).mode, 'dark');
  assert.equal(normalizeRenderRequest({ format: 'gif', mode: 'sepia' }).mode, null, 'an unknown mode is ignored');

  const p = tmpProject();
  const graph = createGraph({ paths: { GRAPH_DIR: p.pp.graphDir, META_PATH: p.pp.meta }, state: createState() });
  graph.registerNode({ id: 'n0', parent_id: null, created_at: 1, author: 'claude', trigger: { kind: 'turn', message: 'x' }, mounts: [], store: {} });
  graph.active = 'n0';
  const ctx = { graph, paths: { THEME_PATH: p.pp.theme, SYSTEM_THEME_PATH: '/nonexistent/theme.json', THEME_DEFAULT_PATH: p.pp.themeDefault, EXPORTS_DIR: p.pp.exports, root: p.root }, root: p.root };
  const urls = [];
  const opts = {
    port: 1, findChromeImpl: () => '/x/chrome', findFfmpegImpl: () => null, scripts: createScriptStore(),
    captureImpl: async ({ url }) => { urls.push(url); throw Object.assign(new Error('stub'), { code: 'stub' }); },
  };
  await renderReplay(ctx, { format: 'gif', from: 'n0', to: 'n0' }, opts);
  await renderReplay(ctx, { format: 'gif', from: 'n0', to: 'n0', mode: 'dark' }, opts);
  assert.equal(urls.length, 2, 'both reached the capture');
  assert.equal(new URL(urls[0]).searchParams.get('mode'), null, 'no mode: the headless page is light');
  assert.equal(new URL(urls[1]).searchParams.get('mode'), 'dark', 'a named mode reaches the page it draws');
});

test('the export tool is light unless given `mode` — for a page and for a replay file', async (t) => {
  withTempHome(t);
  const { api, port } = await withServer(t); // new project → Georgetown Blue
  const id = await oneNode(api);
  const prev = process.env.WEB_CHAT_PORT;
  process.env.WEB_CHAT_PORT = String(port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_PORT; else process.env.WEB_CHAT_PORT = prev; });
  const tool = require('../lib/mcp/tools/export');
  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['light', 'dark']);
  const light = GT.modes.light.tokens['--wc-bg'];
  const dark = GT.modes.dark.tokens['--wc-bg'];
  const bgFile = (r) => { assert.ok(r.ok, JSON.stringify(r)); return bgOf(fs.readFileSync(r.path, 'utf8')); };
  assert.equal(bgFile(await tool.handler({ node: id })), light, 'a page: light by default');
  assert.equal(bgFile(await tool.handler({ node: id, mode: 'dark' })), dark, 'a page: dark when asked');
  assert.equal(bgFile(await tool.handler({ format: 'replay', to: id, from: id })), light, 'a replay file: light by default');
  assert.equal(bgFile(await tool.handler({ format: 'replay', to: id, from: id, mode: 'dark' })), dark, 'a replay file: dark when asked');
});

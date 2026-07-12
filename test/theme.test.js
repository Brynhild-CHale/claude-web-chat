const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, withTempHome } = require('../test-support/helpers');

test('theme: pane resolution applies global ⊕ node ⊕ pane cascade', async (t) => {
  const { api } = await withServer(t);

  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#111111' } });
  await api.post('/api/render', { id: 'p1', html: '<div>x</div>' });
  await api.post('/api/commit', { message: 'seed' }); // active node = n0

  await api.post('/api/theme', { scope: 'node', target: 'n0', tokens: { '--wc-fg': '#222222' } });
  await api.post('/api/theme', { scope: 'pane', target: 'p1', tokens: { '--wc-content-bg': '#333333' } });

  const resolved = (await api.get('/api/theme?scope=pane&target=p1')).json;
  assert.equal(resolved.tokens['--wc-accent'], '#111111', 'global token falls through');
  assert.equal(resolved.tokens['--wc-fg'], '#222222', 'node token layered');
  assert.equal(resolved.tokens['--wc-content-bg'], '#333333', 'pane token most specific');
});

test('theme: most-specific layer wins on token conflict', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#aaaaaa' } });
  await api.post('/api/render', { id: 'p1', html: '<div>x</div>' });
  await api.post('/api/commit', { message: 'seed' });
  await api.post('/api/theme', { scope: 'node', target: 'n0', tokens: { '--wc-accent': '#bbbbbb' } });
  await api.post('/api/theme', { scope: 'pane', target: 'p1', tokens: { '--wc-accent': '#cccccc' } });
  const resolved = (await api.get('/api/theme?scope=pane&target=p1')).json;
  assert.equal(resolved.tokens['--wc-accent'], '#cccccc');
});

test('theme: default fallback chain project → system → builtin', async (t) => {
  withTempHome(t);
  const { api } = await withServer(t);

  // builtin: nothing set → empty tokens
  let g = (await api.get('/api/theme?scope=global')).json;
  assert.deepEqual(g.tokens, {});

  // system default only → resolves to system
  await api.post('/api/themes', { name: 'sys', location: 'system', tokens: { '--wc-bg': '#005500' }, set_default: true });
  g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.tokens['--wc-bg'], '#005500', 'falls back to system default');

  // project default → overrides system
  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-bg': '#000099' } });
  g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.tokens['--wc-bg'], '#000099', 'project default wins over system');
});

test('theme: node.theme persists across restart', async (t) => {
  const { root, api, graceful } = await withServer(t);
  await api.post('/api/render', { id: 'p1', html: '<div>x</div>' });
  await api.post('/api/commit', { message: 'seed' }); // n0
  await api.post('/api/theme', { scope: 'node', target: 'n0', tokens: { '--wc-fg': '#abcabc' } });
  await graceful();

  const { api: api2 } = await withServer(t, { root });
  const resolved = (await api2.get('/api/theme?scope=node&target=n0')).json;
  assert.equal(resolved.tokens['--wc-fg'], '#abcabc', 'node theme survived reboot');
  // and it's on the persisted node file
  const node = JSON.parse(fs.readFileSync(path.join(root, '.web-chat', 'graph', 'n0.json'), 'utf8'));
  assert.equal(node.theme.tokens['--wc-fg'], '#abcabc');
});

test('theme: pane theme round-trips through set-active and reboot', async (t) => {
  const { root, api, graceful } = await withServer(t);

  await api.post('/api/render', { id: 'p1', html: '<div>x</div>' });
  await api.post('/api/theme', { scope: 'pane', target: 'p1', tokens: { '--wc-content-bg': '#abc123' } });
  await api.post('/api/commit', { message: 'seed' }); // n0 bakes p1.theme

  await api.post('/api/render', { id: 'p2', html: '<div>y</div>' });
  await api.post('/api/commit', { message: 'second' }); // n1

  // set active back to n0 → restoreLiveToNode must rehydrate p1 with its theme
  await api.post('/api/graph/active', { id: 'n0' });
  let resolved = (await api.get('/api/theme?scope=pane&target=p1')).json;
  assert.equal(resolved.tokens['--wc-content-bg'], '#abc123', 'pane theme restored on set-active');

  await graceful();
  const { api: api2 } = await withServer(t, { root }); // boot restores active n0
  resolved = (await api2.get('/api/theme?scope=pane&target=p1')).json;
  assert.equal(resolved.tokens['--wc-content-bg'], '#abc123', 'pane theme survived reboot');
});

test('theme: save and list across local + system libraries', async (t) => {
  withTempHome(t);
  const { api } = await withServer(t);
  await api.post('/api/themes', { name: 'violet', location: 'local', tokens: { '--wc-accent': '#7c3aed' } });
  await api.post('/api/themes', { name: 'midnight', location: 'system', tokens: { '--wc-bg': '#0b0b14' } });
  const { themes } = (await api.get('/api/themes')).json;
  const byName = Object.fromEntries(themes.map(t => [t.name, t]));
  assert.equal(byName.violet.location, 'local');
  assert.equal(byName.violet.tokens['--wc-accent'], '#7c3aed');
  assert.equal(byName.midnight.location, 'system');
  assert.equal(byName.midnight.tokens['--wc-bg'], '#0b0b14');
});

test('theme: apply_theme by name at a scope', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/themes', { name: 'violet', location: 'local', tokens: { '--wc-accent': '#7c3aed' } });
  const r = (await api.post('/api/theme/apply', { name: 'violet', scope: 'global' })).json;
  assert.equal(r.ok, true);
  const g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.tokens['--wc-accent'], '#7c3aed');
});

test('theme: apply resolves a builtin name case-insensitively (Phase 5 regression guard)', async (t) => {
  const { api } = await withServer(t);
  // The builtin is 'web-chat'; getBuiltin is case-insensitive, so 'Web-Chat'
  // must resolve it (apply stock), not 404. A case-sensitive registry lookup
  // would 404 here — the bug the adversarial review caught.
  const r = await api.post('/api/theme/apply', { name: 'Web-Chat', scope: 'global' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('theme: clear removes the theme at each scope', async (t) => {
  const { root, api } = await withServer(t);

  // global
  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#111111' } });
  await api.post('/api/theme', { scope: 'global', clear: true });
  assert.deepEqual((await api.get('/api/theme?scope=global')).json.tokens, {});
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'theme.json')), false);

  // pane
  await api.post('/api/render', { id: 'p1', html: '<div>x</div>' });
  await api.post('/api/theme', { scope: 'pane', target: 'p1', tokens: { '--wc-content-bg': '#333333' } });
  await api.post('/api/theme', { scope: 'pane', target: 'p1', clear: true });
  assert.equal((await api.get('/api/theme?scope=pane&target=p1')).json.tokens['--wc-content-bg'], undefined);

  // node
  await api.post('/api/commit', { message: 'seed' }); // n0
  await api.post('/api/theme', { scope: 'node', target: 'n0', tokens: { '--wc-fg': '#222222' } });
  await api.post('/api/theme', { scope: 'node', target: 'n0', clear: true });
  assert.equal((await api.get('/api/theme?scope=node&target=n0')).json.tokens['--wc-fg'], undefined);
});

test('theme: web-chat built-in is listed, read-only, and resets to stock', async (t) => {
  withTempHome(t);
  const { api } = await withServer(t);

  // listed as a builtin
  const { themes } = (await api.get('/api/themes')).json;
  const builtin = themes.find(t => t.name === 'web-chat');
  assert.ok(builtin, 'web-chat present');
  assert.equal(builtin.location, 'builtin');
  assert.deepEqual(builtin.tokens, {}, 'stock look = empty tokens');

  // cannot be saved over
  const save = await api.post('/api/themes', { name: 'web-chat', location: 'local', tokens: { '--wc-bg': '#000' } });
  assert.equal(save.status, 400, 'saving over a builtin is rejected');

  // applying it resets the global default to stock (empty tokens)
  await api.post('/api/theme', { scope: 'global', tokens: { '--wc-accent': '#7c3aed' } });
  await api.post('/api/theme/apply', { name: 'web-chat', scope: 'global' });
  const g = (await api.get('/api/theme?scope=global')).json;
  assert.deepEqual(g.tokens, {}, 'web-chat clears tokens back to fallbacks');
  assert.equal(g.name, 'web-chat');
});

test('theme: tokens are sanitized (bad keys dropped, values stripped)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/theme', { scope: 'global', tokens: {
    '--wc-accent': '#7c3aed',
    'color': 'red',                 // not a --wc- token → dropped
    '--wc-bg': 'red; } body {',      // breakout chars stripped
  } });
  const g = (await api.get('/api/theme?scope=global')).json;
  assert.equal(g.tokens['--wc-accent'], '#7c3aed');
  assert.equal(g.tokens['color'], undefined, 'non --wc- key dropped');
  assert.equal(g.tokens['--wc-bg'], 'red  body', 'breakout chars stripped');
});

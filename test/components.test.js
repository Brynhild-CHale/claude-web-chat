const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { withServer, withTempHome } = require('../test-support/helpers');

// Behaviour contract for the component resource routes, pinned BEFORE the Phase 5
// registry migration so it stays behaviour-preserving. Builtins (form-renderer,
// node-render, website) are seeded to COMPONENTS_DIR at boot by createServer.

test('components: list returns builtins with the {name,description,params_schema,has_seed} shape', async (t) => {
  const { api } = await withServer(t);
  const { json } = await api.get('/api/components');
  assert.ok(Array.isArray(json.components));
  const fr = json.components.find((c) => c.name === 'form-renderer');
  assert.ok(fr, 'builtin form-renderer is seeded + listed');
  assert.ok(['description', 'has_seed', 'name', 'params_schema'].every((k) => k in fr));
  assert.equal(typeof fr.description, 'string');
  assert.equal(typeof fr.has_seed, 'boolean');
});

test('components: save validates kebab + persists; get returns {...meta, source}', async (t) => {
  const { api } = await withServer(t);
  const bad = await api.post('/api/components', { name: 'Bad Name', source: '<p>x</p>' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /kebab/);
  const noSrc = await api.post('/api/components', { name: 'ok-name' });
  assert.equal(noSrc.status, 400, 'name + source required');

  const ok = await api.post('/api/components', { name: 'my-widget', source: '<p>hi</p>', description: 'a widget', params_schema: { x: 'number' } });
  assert.equal(ok.json.ok, true);
  const got = await api.get('/api/components/my-widget');
  assert.equal(got.json.name, 'my-widget');
  assert.equal(got.json.description, 'a widget');
  assert.deepEqual(got.json.params_schema, { x: 'number' });
  assert.equal(got.json.source, '<p>hi</p>');
  const list = await api.get('/api/components');
  assert.ok(list.json.components.some((c) => c.name === 'my-widget'));
});

test('components: get 404 on missing; seed 404 without a seed.js', async (t) => {
  const { api } = await withServer(t);
  assert.equal((await api.get('/api/components/nope')).status, 404);
  await api.post('/api/components', { name: 'no-seed', source: '<p></p>' });
  assert.equal((await api.get('/api/components/no-seed/seed')).status, 404);
});

test('components: use mounts the component (render event carrying component provenance)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/components', { name: 'w1', source: '<p>W</p>' });
  const used = await api.post('/api/components/w1/use', { id: 'c1', params: { a: 1 } });
  assert.equal(used.json.ok, true);
  assert.equal(used.json.id, 'c1');
  const { json: ev } = await api.get('/api/events');
  const r = ev.events.find((e) => e.kind === 'render' && e.id === 'c1');
  assert.ok(r, 'use emitted a render event');
  assert.equal(r.component, 'w1');
  assert.equal((await api.post('/api/components/nope/use', {})).status, 404);
});

test('components: use is soft-rejected on a locked pane (lockReject)', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/components', { name: 'w2', source: '<p>W2</p>' });
  await api.post('/api/render', { id: 'c2', html: '<p>seed</p>' }); // create the mount
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'pane:state', id: 'c2', pane_state: { locked: true } }));
  await new Promise((r) => setTimeout(r, 60));
  ws.close();
  const used = await api.post('/api/components/w2/use', { id: 'c2' });
  assert.equal(used.json.ok, false);
  assert.equal(used.json.locked, true);
});

test('components: system tier — save to ~/.web-chat/components, visible, project shadows it (Phase 5)', async (t) => {
  const home = withTempHome(t); // redirect HOME before the server resolves SYSTEM_COMPONENTS_DIR
  const { api } = await withServer(t);

  // save to the system tier
  const s = await api.post('/api/components', { name: 'shared-widget', source: '<p>SYS</p>', description: 'sys', location: 'system' });
  assert.equal(s.json.ok, true);
  assert.equal(s.json.location, 'system');
  // it landed under the (throwaway) home — lazily created, not by ensureProjectDirs
  assert.ok(fs.existsSync(path.join(home, '.web-chat', 'components', 'shared-widget', 'component.html')), 'written under ~/.web-chat/components');

  // visible in list tagged location:'system'; get/use resolve to it (fall through local→system)
  const list1 = await api.get('/api/components');
  assert.equal(list1.json.components.find((c) => c.name === 'shared-widget').location, 'system');
  assert.equal((await api.get('/api/components/shared-widget')).json.source, '<p>SYS</p>');

  // a project component with the same name SHADOWS the system one
  await api.post('/api/components', { name: 'shared-widget', source: '<p>PROJ</p>', description: 'proj', location: 'local' });
  assert.equal((await api.get('/api/components/shared-widget')).json.source, '<p>PROJ</p>', 'project shadows system');

  // list has BOTH (no cross-tier dedup) — one local, one system
  const both = (await api.get('/api/components')).json.components.filter((c) => c.name === 'shared-widget');
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((c) => c.location).sort(), ['local', 'system']);

  // builtins seed into the PROJECT tier only
  const frLocs = (await api.get('/api/components')).json.components.filter((c) => c.name === 'form-renderer').map((c) => c.location);
  assert.deepEqual(frLocs, ['local'], 'builtins seed project-only, never system');
});

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

// A builtin's description is what Claude reads to decide whether the component
// is appropriate — it is the component's only contract at the point of choosing.
// node-render's promised "HTML previews of each mount (scripts stripped for
// safety)" and a store snapshot. It has neither: the pane is an iframe onto the
// LIVE /preview/node/<id> document, which splices in the mount runtime and runs
// every mount's scripts, and the sandbox attribute grants allow-scripts. A reader
// trusting that description to embed an untrusted node "safely" was misled.
test('components: node-render describes the sandbox it has, not one it does not', async (t) => {
  const { api } = await withServer(t);
  const nr = (await api.get('/api/components')).json.components.find((c) => c.name === 'node-render');
  assert.ok(nr, 'node-render is a seeded builtin');
  assert.doesNotMatch(nr.description, /stripp?ed/i, 'nothing is stripped — say so');
  assert.doesNotMatch(nr.description, /store snapshot/i, 'and no store snapshot is rendered anywhere');
  assert.match(nr.description, /scripts run/i, 'the pane runs the node\'s scripts; that is the fact that matters');
  assert.match(nr.description, /allow-scripts/, 'named exactly as the iframe spells it');
  assert.match(nr.description, /same-origin/, 'and paired with the containment that actually holds');

  // The component itself, so the description cannot drift back out of step.
  const src = (await api.get('/api/components/node-render')).json.source;
  assert.match(src, /sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin/.test(src), 'no same-origin escape hatch');
  assert.match(src, /\/preview\/node\//, 'it is the live preview document, not a re-render');
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

test('components: save writes optional seed.js + service.js and surfaces has_service', async (t) => {
  const { api, webChatDir } = await withServer(t);
  const service = 'module.exports = { async start(){} };';
  const seed = 'return { x: 1 };';
  const ok = await api.post('/api/components', { name: 'svc-widget', source: '<p>S</p>', description: 'svc', seed, service });
  assert.equal(ok.json.ok, true);

  // sidecars land in the component dir
  const dir = path.join(webChatDir, 'components', 'svc-widget');
  assert.equal(fs.readFileSync(path.join(dir, 'service.js'), 'utf8'), service);
  assert.equal(fs.readFileSync(path.join(dir, 'seed.js'), 'utf8'), seed);

  // has_service surfaces in both list and get; has_seed too
  const listed = (await api.get('/api/components')).json.components.find((c) => c.name === 'svc-widget');
  assert.equal(listed.has_service, true);
  assert.equal(listed.has_seed, true);
  const got = await api.get('/api/components/svc-widget');
  assert.equal(got.json.has_service, true);

  // a component without a service reports has_service:false
  await api.post('/api/components', { name: 'plain-widget', source: '<p>P</p>' });
  const plain = (await api.get('/api/components')).json.components.find((c) => c.name === 'plain-widget');
  assert.equal(plain.has_service, false);
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

// ── /use is the SAME mount-set as /api/render (routes-2) ─────────────────────
// It used to hand-copy a third of it: the lock check and the form_state carry,
// with no owner gate, no owner stamp, no gen bump and no theme carry. Each
// omission was load-bearing — public/app/drawer.js already tells the user "a
// locked or driver-owned pane answers 200 with {ok:false}", and the queue's
// Revert generation guard degrades to delete-if-present against a gen-less
// mount. All four are pinned here.

test('components: use over a pane owned by a driver is soft-rejected (owned envelope)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/components', { name: 'w-own', source: '<p>W</p>' });
  await api.post('/api/render', { id: 'svc', html: '<p>driver</p>', owner: 'service:git' });
  const rejected = (await api.post('/api/components/w-own/use', { id: 'svc' })).json;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.owned, true);
  assert.equal(rejected.owner, 'service:git');
  assert.match(rejected.hint, /force:true/);
  const forced = (await api.post('/api/components/w-own/use', { id: 'svc', force: true })).json;
  assert.equal(forced.ok, true);
  assert.equal(forced.owner, 'claude', 'the takeover re-stamps the pane as Claude\'s');
});

test('components: use stamps owner claude, so Claude may re-render and clear its own pane', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/components', { name: 'w-gen', source: '<p>W</p>' });
  const first = (await api.post('/api/components/w-gen/use', { id: 'g1' })).json;
  assert.equal(first.owner, 'claude', 'the response reports the owner, as /api/render does');
  const { json: mounts } = await api.get('/api/mounts');
  assert.equal(mounts.mounts.find((m) => m.id === 'g1').owner, 'claude');
  // 'claude' is not a `service:` prefix, so activity routing stays 'auto' (the
  // first-run tour depends on that) and a same-owner render/clear still passes.
  assert.equal((await api.post('/api/render', { id: 'g1', html: '<p>x</p>' })).json.ok, true);
  assert.equal((await api.post('/api/clear', { id: 'g1' })).json.ok, true);
});

test('components: use preserves a per-pane theme across a re-use', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/components', { name: 'w-theme', source: '<p>W</p>' });
  await api.post('/api/components/w-theme/use', { id: 't1' });
  await api.post('/api/theme', { scope: 'pane', target: 't1', tokens: { '--wc-accent': '#abcdef' } });
  await api.post('/api/components/w-theme/use', { id: 't1' });
  const resolved = (await api.get('/api/theme?scope=pane&target=t1')).json;
  assert.equal(resolved.tokens['--wc-accent'], '#abcdef', 're-using a component must not drop the pane theme');
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

  // list is DEDUPED by name and agrees with get: one row, the winning tier.
  // It used to emit both, identically, giving the agent reading this list no
  // signal about which one `use_component` would actually resolve to.
  const both = (await api.get('/api/components')).json.components.filter((c) => c.name === 'shared-widget');
  assert.equal(both.length, 1, 'one row per name — list agrees with get');
  assert.equal(both[0].location, 'local', 'the resolved (most-specific) tier wins');
  assert.deepEqual(both[0].shadows, ['system'], 'the shadowed tier is still reported, not silently dropped');

  // builtins seed into the PROJECT tier only
  const frLocs = (await api.get('/api/components')).json.components.filter((c) => c.name === 'form-renderer').map((c) => c.location);
  assert.deepEqual(frLocs, ['local'], 'builtins seed project-only, never system');
});

test('use_component tool: force and signals reach the route, signals nested under params', async () => {
  // The description has always claimed parity with `render`. The schema had
  // neither parameter, and a top-level `signals` array was dropped by the
  // handler's destructuring — so a declared wake silently never registered
  // (lib/server/domain/signals reads params.signals, nothing else).
  const client = require('../lib/mcp/client');
  const tool = require('../lib/mcp/tools/use_component');
  assert.ok(tool.inputSchema.properties.force, 'schema declares force');
  assert.ok(tool.inputSchema.properties.signals, 'schema declares signals');
  const seen = [];
  const orig = client.post;
  client.post = async (p, body) => { seen.push([p, body]); return {}; };
  try {
    await tool.handler({
      name: 'w', id: 'p1', force: true,
      params: { a: 1 },
      signals: [{ key: 'form_submit', wake: 'queue' }],
    });
    await tool.handler({ name: 'w', id: 'p2', params: { a: 1 } });
  } finally {
    client.post = orig;
  }
  assert.equal(seen[0][0], '/api/components/w/use');
  assert.equal(seen[0][1].force, true);
  assert.deepEqual(seen[0][1].params, { a: 1, signals: [{ key: 'form_submit', wake: 'queue' }] });
  assert.deepEqual(seen[1][1].params, { a: 1 }, 'no signals → params untouched');
});

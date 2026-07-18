// form_state — the per-mount typed-values snapshot. The shell debounce-captures
// a pane's form-element values over WS ('pane:form'); the mount record carries
// them through /api/mounts, node commits, restores, drafts, and exports, so
// user input survives refresh / navigation / re-render without the pane's
// script (or Claude) doing anything.

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { withServer } = require('../test-support/helpers');
const { SNAPSHOT_FIELDS } = require('../lib/server/domain/turns');

function wsOpen(port) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') resolve(sock);
    });
    sock.on('error', reject);
  });
}
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

async function typeInto(port, id, form_state) {
  const sock = await wsOpen(port);
  sock.send(JSON.stringify({ type: 'pane:form', id, form_state }));
  await settle();
  sock.close();
}

test('form_state is a persisted-and-restored mount field', () => {
  assert.ok(SNAPSHOT_FIELDS.includes('form_state'));
});

test('pane:form REPLACES the mount snapshot and reaches /api/mounts', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'signoff', html: '<textarea id="notes"></textarea>' });

  await typeInto(port, 'signoff', { '#notes:0': { value: 'looks good' }, '#extra:1': { value: 'tmp' } });
  await typeInto(port, 'signoff', { '#notes:0': { value: 'looks good, ship it' } });

  const { json } = await api.get('/api/mounts');
  const m = json.mounts.find((x) => x.id === 'signoff');
  // full-snapshot replace: the cleared '#extra:1' key must not resurrect
  assert.deepEqual(m.form_state, { '#notes:0': { value: 'looks good, ship it' } });
});

test('form_state rides a commit and a restore', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'form', html: '<input id="a">' });
  await typeInto(port, 'form', { '#a:0': { value: 'draft one' } });
  const c1 = await api.post('/api/commit', { message: 'one' });

  await typeInto(port, 'form', { '#a:0': { value: 'draft two' } });
  await api.post('/api/commit', { message: 'two' });

  // navigate back: the restored live mount carries node one's typed values
  await api.post('/api/graph/active', { id: c1.json.node_id });
  const { json } = await api.get('/api/mounts');
  assert.deepEqual(json.mounts[0].form_state, { '#a:0': { value: 'draft one' } });
});

test('a stable-id re-render preserves form_state; params.form_reset drops it', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'form', html: '<input id="a">' });
  await typeInto(port, 'form', { '#a:0': { value: 'typed' } });

  await api.post('/api/render', { id: 'form', html: '<input id="a"><p>v2</p>' });
  let m = (await api.get('/api/mounts')).json.mounts[0];
  assert.deepEqual(m.form_state, { '#a:0': { value: 'typed' } }, 're-render must not eat user input');

  await api.post('/api/render', { id: 'form', html: '<input id="a">', params: { form_reset: true } });
  m = (await api.get('/api/mounts')).json.mounts[0];
  assert.equal(m.form_state, null, 'form_reset opts a render out of preservation');
});

test('an export inlines form_state so the frozen page rehydrates typed values', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'form', html: '<input id="a">' });
  await typeInto(port, 'form', { '#a:0': { value: 'exported draft' } });

  const res = await api.get('/api/export/live');
  assert.match(res.text, /exported draft/);
});

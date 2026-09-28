// POST /api/clear through the tunnel portal (E2-2). The remote policy allows the
// path — the chrome's × closes one pane with {id, force:true} — but a clear with
// no `id` empties the page as a wipe does (and `force:true` takes the pinned
// panes too), so the route refuses that body when the portal's X-WC-Remote label
// is on the request. The row in lib/core/remote-policy.js records the rule.

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { REMOTE_HEADER, REMOTE_HEADER_VALUE } = require('../lib/core/cors');

const REMOTE = { [REMOTE_HEADER]: REMOTE_HEADER_VALUE };

async function ids(api) {
  return (await api.get('/api/mounts')).json.mounts.map((m) => m.id).sort();
}

test('remote clear: a bulk clear is refused whole, however it is spelled', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>a</p>' });
  await api.post('/api/render', { id: 'b', html: '<p>b</p>' });
  await api.post('/api/markdown', { id: 'md-1', text: '# Title' });

  for (const body of [{}, { force: true }, { target: 'main' }, { target: 'main', force: true }, { id: '' }]) {
    const r = await api.post('/api/clear', body, REMOTE);
    assert.equal(r.status, 403, `${JSON.stringify(body)} → ${r.status}`);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.remote, true, 'the refusal says it is because the viewer is remote');
    assert.match(r.json.hint, /one at a time/);
    assert.match(r.json.hint, /host/);
  }
  assert.deepEqual(await ids(api), ['a', 'b'], 'nothing was cleared');
  assert.ok((await api.get('/api/mounts')).json.markdown.some((m) => m.id === 'md-1'), 'the markdown stays');
});

test('remote clear: closing one pane by id still lands — forced (the ×) or not', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>a</p>' });
  await api.post('/api/render', { id: 'b', html: '<p>b</p>' });
  await api.post('/api/render', { id: 'svc', html: '<p>driver</p>', owner: 'service:git' });

  const forced = await api.post('/api/clear', { id: 'svc', force: true }, REMOTE);
  assert.equal(forced.status, 200, forced.text);
  assert.equal(forced.json.ok, true, 'the chrome\'s ×: {id, force:true}');
  const plain = await api.post('/api/clear', { id: 'a' }, REMOTE);
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.json.ok, true);
  assert.deepEqual(await ids(api), ['b']);
});

test('remote clear: a local bulk clear is unchanged', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>a</p>' });
  await api.post('/api/render', { id: 'b', html: '<p>b</p>' });
  const r = await api.post('/api/clear', {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.deepEqual(await ids(api), []);
});

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { createDriver } = require('../lib/driver');

test('createDriver round-trips render + store + events; owner is tagged', async (t) => {
  const { port, api } = await withServer(t);
  const wc = createDriver({ owner: 'test-runner', port });
  assert.equal(wc.owner, 'service:test-runner');

  const r = await wc.render({ id: 'tr', html: '<p>hi</p>' });
  assert.equal(r.ok, true);
  assert.equal(r.owner, 'service:test-runner');

  // list_mounts (/api/mounts) surfaces the owner.
  const mounts = (await api.get('/api/mounts')).json;
  const m = mounts.mounts.find((x) => x.id === 'tr');
  assert.equal(m.owner, 'service:test-runner');

  await wc.setStore({ test_run: { seq: 1, status: 'pass' } });
  const store = await wc.getStore(['test_run']);
  assert.equal(store.test_run.status, 'pass');

  const ev = await wc.getEvents({ since: 0 });
  const renderEv = ev.events.find((e) => e.kind === 'render' && e.id === 'tr');
  assert.equal(renderEv.source, 'service:test-runner');
});

test('cross-owner overwrite is rejected; force overrides; same owner is fine', async (t) => {
  const { port, api } = await withServer(t);
  const driver = createDriver({ owner: 'svc', port });
  await driver.render({ id: 'p', html: '<p>driver</p>' });

  // Same owner re-render: allowed.
  const same = await driver.render({ id: 'p', html: '<p>driver v2</p>' });
  assert.equal(same.ok, true);

  // Claude (no owner) rendering over a driver-owned pane: rejected.
  const claude = (await api.post('/api/render', { id: 'p', html: '<p>claude</p>' })).json;
  assert.equal(claude.ok, false);
  assert.equal(claude.owned, true);
  assert.equal(claude.owner, 'service:svc');

  // force:true takes it over.
  const forced = (await api.post('/api/render', { id: 'p', html: '<p>claude</p>', force: true })).json;
  assert.equal(forced.ok, true);
  assert.equal(forced.owner, 'claude');
});

test('clear honours the SAME ownership guard render does', async (t) => {
  const { port, api } = await withServer(t);
  const driver = createDriver({ owner: 'svc', port });
  await driver.render({ id: 'p', html: '<p>driver</p>' });
  await api.post('/api/render', { id: 'mine', html: '<p>claude</p>' });

  // render refused this exact clobber; clear was the unguarded back door to it.
  const rejected = (await api.post('/api/clear', { id: 'p' })).json;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.owned, true);
  assert.equal(rejected.owner, 'service:svc');
  let mounts = (await api.get('/api/mounts')).json.mounts.map((m) => m.id);
  assert.ok(mounts.includes('p'), 'the driver-owned pane survives');

  // A blanket clear must not sweep a foreign pane away either.
  const blanket = (await api.post('/api/clear', {})).json;
  assert.equal(blanket.ok, false, 'clear-all refuses whole rather than partially wiping');
  mounts = (await api.get('/api/mounts')).json.mounts.map((m) => m.id);
  assert.ok(mounts.includes('p') && mounts.includes('mine'), 'both panes survive');

  // Claude clearing its OWN pane is unaffected.
  assert.equal((await api.post('/api/clear', { id: 'mine' })).json.ok, true);

  // And force:true is the deliberate takeover, matching render.
  assert.equal((await api.post('/api/clear', { id: 'p', force: true })).json.ok, true);
  mounts = (await api.get('/api/mounts')).json.mounts.map((m) => m.id);
  assert.equal(mounts.includes('p'), false, 'force actually clears it');
});

test('owner survives a turn-end commit and restore', async (t) => {
  const { root, port, api, stop } = await withServer(t);
  const driver = createDriver({ owner: 'svc', port });

  await api.post('/api/turn-begin', { message: 'turn' });
  await driver.render({ id: 'owned', html: '<p>x</p>' });
  const te = (await api.post('/api/turn-end', { author: 'claude' })).json;
  assert.equal(te.ok, true);

  // The committed node records the owner.
  const node = (await api.get(`/api/graph/node/${te.node_id}`)).json;
  const om = node.mounts.find((m) => m.id === 'owned');
  assert.equal(om.owner, 'service:svc');
  await stop();

  // And it restores into live state on a fresh boot at that node.
  const { api: api2 } = await withServer(t, { root });
  const mounts = (await api2.get('/api/mounts')).json;
  const rm = mounts.mounts.find((m) => m.id === 'owned');
  assert.equal(rm.owner, 'service:svc');
});

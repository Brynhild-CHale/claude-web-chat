const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { PROTOCOL_VERSION, packageVersion } = require('../lib/core/versions');

test('GET /api/health returns liveness shape', async (t) => {
  const { api } = await withServer(t);
  const { status, json: body } = await api.get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.pid, 'number');
  assert.equal(body.pid, process.pid);
  assert.equal(typeof body.nodes, 'number');
  assert.ok('active' in body);
  assert.ok('lock' in body);
});

test('health advertises role instance + protocol version', async (t) => {
  const { api } = await withServer(t);
  const { json: body } = await api.get('/api/health');
  assert.equal(body.role, 'instance', 'role distinguishes an instance from the hub');
  assert.equal(body.version, PROTOCOL_VERSION);
});

test('health names the web-chat release beside the protocol number', async (t) => {
  const { api } = await withServer(t);
  const { json: body } = await api.get('/api/health');
  assert.equal(body.package_version, packageVersion(), 'the release a person reads (sessions view)');
  assert.equal(body.version, PROTOCOL_VERSION, 'and `version` keeps meaning the protocol');
});

test('health reflects an active lock', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'x' });
  const { json: body } = await api.get('/api/health');
  assert.ok(body.lock);
  assert.equal(body.lock.message, 'x');
});

test('HEAD /api/health answers (probeReachable target)', async (t) => {
  const { api } = await withServer(t);
  const r = await api.raw('/api/health', { method: 'HEAD' });
  assert.ok(r.status >= 200 && r.status < 400);
});

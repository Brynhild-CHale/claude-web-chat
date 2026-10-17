// createServer's return value hands a test the daemon's OWN engines (PLAN
// 1B.6, readiness R6 §3 seam 8): the audience, the live state, the change bus,
// the turn graph and the writers domain, each a getter over the variable the
// routes were built with — never a copy, never a snapshot. GT-06's and
// GT-16's harnesses (tests/F9) built a second createAudience because the
// return value exposed none; these tests pin that the handle IS the routes'.
//
// A remote viewer is a loopback request carrying the portal's X-WC-Remote: 1;
// a network peer is a request whose socket's remoteAddress is not loopback
// (test/comments-remote.test.js's shapes).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { WRITER_HEADER } = require('../lib/core/writer-token');
const client = require('../lib/client');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });

// A request as the audience and the writers read one: a socket's peer and
// the headers.
function fakeReq(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

test('srv.audience answers levelOf: local for a loopback request, basic for a network peer', async (t) => {
  const { srv } = await withServer(t);
  assert.ok(srv.audience, 'the audience is exposed');
  assert.equal(srv.audience.levelOf(fakeReq('127.0.0.1')), 'local');
  assert.equal(srv.audience.levelOf(fakeReq('::1')), 'local');
  assert.equal(srv.audience.levelOf(fakeReq('10.0.0.5')), 'basic');
  // A remote viewer with no opt-in is basic too.
  assert.equal(srv.audience.levelOf(fakeReq('127.0.0.1', { 'x-wc-remote': '1' })), 'basic');
});

test('srv.audience is the instance the routes use: an opt-in moves remoteLevel() and the route together', async (t) => {
  const d = await withServer(t);
  const call = (p) => client.request(d.port, 'GET', p, null, { headers: REMOTE, timeout: 10000 });

  assert.equal(d.srv.audience.remoteLevel(), 'off');
  const before = await call('/api/comments');
  assert.equal(before.status, 403, JSON.stringify(before.body));
  assert.equal(before.body.mirror, 'basic');

  // `tunnel mirror on --read-only`, as it writes the sandbox tunnel.json.
  writeJsonAtomic(userPaths().tunnelConfig, { ...TUNNEL, remote: { mirror: { [path.resolve(d.root)]: 'read' } } });
  await waitUntil(() => d.srv.audience.remoteLevel() === 'read', { timeout: 10000, what: 'the opt-in at srv.audience' });
  assert.equal(d.srv.audience.levelOf(fakeReq('127.0.0.1', { 'x-wc-remote': '1' })), 'read');
  const after = await call('/api/comments');
  assert.equal(after.status, 200, `the route's requireMirror follows the same audience: ${JSON.stringify(after.body)}`);
});

test('srv.state and srv.bus are the routes\': a render lands in state.mounts and on the ring', async (t) => {
  const { srv, api } = await withServer(t);
  const r = await api.post('/api/render', { id: 'm1', html: '<div>one</div>' });
  assert.equal(r.status, 200, r.text);
  assert.ok(srv.state.mounts.has('m1'), 'the mount is in srv.state');
  const ring = srv.bus.read({ since: 0 });
  const ev = ring.events.find((e) => e.kind === 'render' && e.id === 'm1');
  assert.ok(ev, `the render event is on srv.bus: ${JSON.stringify(ring.events.map((e) => e.kind))}`);
});

test('srv.graph is the routes\' graph: graph.active equals GET /api/graph\'s active', async (t) => {
  const { srv, api } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: '<div>one</div>' });
  const end = await api.post('/api/turn-end', { author: 'claude', summary: 't' });
  assert.equal(end.status, 200, end.text);
  const g = await api.get('/api/graph');
  assert.equal(g.status, 200, g.text);
  assert.ok(g.json.active, 'a node was committed');
  assert.equal(srv.graph.active, g.json.active);
  assert.ok(srv.graph.nodes.has(g.json.active));
});

test('srv.writers resolves a token-carrying request as verified claude', async (t) => {
  const { srv, writerToken } = await withServer(t);
  const token = writerToken();
  assert.ok(token, 'the boot wrote its writer token');
  const key = WRITER_HEADER.toLowerCase();
  assert.deepStrictEqual(srv.writers.resolveWriter(fakeReq('127.0.0.1', { [key]: token }), {}),
    { class: 'claude', owner: 'claude', verified: true });
  assert.deepStrictEqual(srv.writers.resolveWriter(fakeReq('127.0.0.1', { [key]: 'not-the-token' }), {}), { stale: true });
  assert.equal(srv.writers.resolveWriter(fakeReq('10.0.0.5', { [key]: token }), {}).class, 'remote');
});

test('after srv.stop() every getter still answers without throwing', async (t) => {
  const { srv, api } = await withServer(t);
  await api.post('/api/render', { id: 'm1', html: '<div>one</div>' });
  await srv.stop();
  assert.equal(srv.audience.levelOf(fakeReq('127.0.0.1')), 'local');
  assert.ok(srv.state.mounts.has('m1'));
  assert.ok(Array.isArray(srv.bus.read({ since: 0 }).events));
  assert.ok(srv.graph && srv.graph.nodes instanceof Map);
  // The writers domain is not stopped by teardown today (it holds no handle);
  // whatever it answers, the getter reads the variable.
  assert.equal(typeof srv.writers.resolveWriter, 'function');
});

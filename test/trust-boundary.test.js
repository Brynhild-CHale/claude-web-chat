// The Host gate — lib/core/cors's answer to "did this client dial a name we
// answer to?".
//
// The hole it closes is DNS rebinding. Binding loopback stops a remote packet,
// but it does not stop a page at attacker.example whose DNS is rebound to
// 127.0.0.1: to the browser that fetch is SAME-ORIGIN, so it carries no Origin
// header at all, setCors reflects `*`, and isLocalOrigin is never consulted.
// The one header that still names the truth is Host — and it is a forbidden
// header name in fetch and XHR, so page script cannot forge it.
//
// Which is also why these tests use raw http.request rather than the fetch-based
// makeApi: fetch refuses to set Host. wsConnect takes ws options, which do reach
// the upgrade request's headers.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const {
  isLocalHost, hostGateApplies, requireLocalHost, verifyUpgrade,
} = require('../lib/core/cors');
const { withServer, withTempHome } = require('../test-support/helpers');
const { createHub } = require('../lib/hub');

// A request that dials 127.0.0.1 but ASSERTS whatever name the caller passes —
// exactly the shape a rebound browser produces.
function raw(port, pathStr, { host, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathStr, method,
      // setHost:false stops Node adding its own Host beside ours.
      setHost: false,
      headers: { ...(host === null ? {} : { host }), ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch {}
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('isLocalHost: the names this machine answers to', () => {
  const table = [
    ['localhost:5173', true, 'the name every doc tells users to open'],
    ['localhost', true, 'no port is still localhost'],
    ['127.0.0.1:5173', true, 'the literal loopback address'],
    ['[::1]:5173', true, 'IPv6 literal keeps its brackets'],
    ['LOCALHOST:5173', true, 'host names are case-insensitive'],
    [' localhost:5173 ', true, 'surrounding whitespace is not a different host'],
    ['evil.example:5173', false, 'the rebinding case'],
    ['evil.example', false, '…with or without a port'],
    ['localhost.evil.example', false, 'a suffix match is not a match'],
    ['127.0.0.1.evil.example', false, 'nor a prefix match'],
    [undefined, false, 'an absent Host is refused, not assumed local'],
    ['', false, 'so is an empty one'],
    [42, false, 'and a non-string never throws'],
  ];
  for (const [host, want, why] of table) {
    assert.equal(isLocalHost(host), want, `${JSON.stringify(host)} — ${why}`);
  }
});

test('isLocalHost: a single non-loopback bind adds exactly that address', () => {
  assert.equal(isLocalHost('10.0.0.7:5173', '10.0.0.7'), true, 'the address the user bound');
  assert.equal(isLocalHost('localhost:5173', '10.0.0.7'), true, 'loopback still answers');
  assert.equal(isLocalHost('evil.example:5173', '10.0.0.7'), false, 'nothing else does');
});

test('hostGateApplies: a wildcard bind makes the gate undecidable', () => {
  assert.equal(hostGateApplies('127.0.0.1'), true);
  assert.equal(hostGateApplies('10.0.0.7'), true);
  assert.equal(hostGateApplies('0.0.0.0'), false, 'every interface — no one correct name');
  assert.equal(hostGateApplies('::'), false);
});

test('requireLocalHost refuses a foreign Host with 421 and says why', async () => {
  const app = express();
  app.use(requireLocalHost);
  app.get('/x', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const bad = await raw(port, '/x', { host: 'evil.example:' + port });
    assert.equal(bad.status, 421, '421 Misdirected Request');
    assert.equal(bad.json.host, 'evil.example:' + port, 'the refused name is reported back');
    assert.match(bad.json.hint, /WEB_CHAT_HOST/, 'a legitimate remote setup is diagnosable');

    const ok = await raw(port, '/x', { host: 'localhost:' + port });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('instance app: a rebound Host is refused on every kind of route', async (t) => {
  const ctx = await withServer(t);
  const paths = ['/api/health', '/api/graph', '/api/mounts', '/api/store', '/index.html'];
  for (const p of paths) {
    const bad = await raw(ctx.port, p, { host: 'evil.example:' + ctx.port });
    assert.equal(bad.status, 421, `${p} refused under a foreign Host`);
    const ok = await raw(ctx.port, p, { host: 'localhost:' + ctx.port });
    assert.notEqual(ok.status, 421, `${p} still served under localhost`);
  }
});

test('instance app: the gate runs above express.json, so no body is parsed', async (t) => {
  const ctx = await withServer(t);
  const before = await raw(ctx.port, '/api/mounts', { host: 'localhost:' + ctx.port });
  const bad = await raw(ctx.port, '/api/render', {
    host: 'evil.example:' + ctx.port,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(bad.status, 421);
  const after = await raw(ctx.port, '/api/mounts', { host: 'localhost:' + ctx.port });
  assert.deepEqual(after.json, before.json, 'the refused POST changed nothing');
});

test('WS upgrade: a rebound Host never reaches the hello dump', async (t) => {
  const ctx = await withServer(t);

  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const sock = ctx.ws('/ws', { headers: { Host: 'evil.example:' + ctx.port } });
      sock.on('open', () => { sock.close(); resolve(); });
      sock.on('error', reject);
    }),
    /Unexpected server response/,
    'the upgrade is refused, so `hello` is never sent',
  );

  // …and the ordinary handshake still works.
  const hello = await ctx.wsHello();
  assert.equal(hello.type, 'hello');
});

test('verifyUpgrade folds the Origin gate together with the Host gate', () => {
  const info = (origin, host) => ({ origin, req: { headers: { host } } });
  assert.equal(verifyUpgrade(info(undefined, 'localhost:5173')), true, 'a driver: no Origin, local Host');
  assert.equal(verifyUpgrade(info('http://localhost:5173', 'localhost:5173')), true, 'the surface itself');
  assert.equal(verifyUpgrade(info('http://evil.example', 'localhost:5173')), false, 'foreign Origin still refused');
  assert.equal(verifyUpgrade(info(undefined, 'evil.example:5173')), false, 'rebound, same-origin, no Origin header');
  assert.equal(verifyUpgrade(info(undefined, undefined)), false, 'an absent Host is refused');
});

test('hub app: the fixed-port listing is not readable under a foreign Host', async (t) => {
  // GET /api/instances reads the cross-project registry, and that read PRUNES
  // dead-pid rows and rewrites ~/.web-chat/instances.json (lib/util/registry
  // readAllLive). Under the ambient HOME this test would edit the developer's
  // own registry, so it runs inside a temp HOME like every other test that
  // touches user-scope state.
  withTempHome(t);
  const hub = createHub({ port: 0 });
  await new Promise((r) => hub.server.listen(0, '127.0.0.1', r));
  const port = hub.server.address().port;
  t.after(() => hub.stop());

  const bad = await raw(port, '/api/instances', { host: 'evil.example:5170' });
  assert.equal(bad.status, 421, 'the rebinding target with the guessable port');
  assert.equal(bad.json.error, 'host not allowed');

  const ok = await raw(port, '/api/instances', { host: 'localhost:' + port });
  assert.equal(ok.status, 200, 'the extension, which dials localhost:5170');
  assert.ok(Array.isArray(ok.json.instances));
});

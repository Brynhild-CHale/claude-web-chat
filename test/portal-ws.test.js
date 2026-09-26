// The tunnel portal's WebSocket relay (lib/portal/ws-relay.js): the live
// surface's socket, relayed from a remote viewer to a real daemon.
//
// The client here is the `ws` library pointed at the portal's loopback port
// with the PUBLIC Host and Origin a browser on the session hostname would
// send — options reach the handshake headers, which is how Host is set.

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { withServer, withPortal, waitUntil } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { sessionHost } = require('../lib/portal/config');
const { CLOSE_EXPIRED, armDeadline } = require('../lib/portal/ws-relay');

async function rig(t, { wsGraceMs } = {}) {
  const srv = await withServer(t);
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const access = createFakeAccess();
  const p = await withPortal(t, { config: access.config(), fetchJwks: access.fetchJwks, wsGraceMs });
  const host = sessionHost(p.config, instanceId(srv.root));
  const origin = `https://${host}`;
  return { srv, p, access, host, origin };
}

// Open a relayed socket. Resolves { ws, hello, frames } on the first hello, or
// rejects with .statusCode when the handshake is refused.
function open(t, r, { origin = r.origin, token = r.access.mint(), path = '/ws', host = r.host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (token) headers['cf-access-jwt-assertion'] = token;
    const ws = new WebSocket(`ws://127.0.0.1:${r.p.port}${path}`, { headers, ...(origin ? { origin } : {}) });
    t.after(() => { try { ws.terminate(); } catch {} });
    const frames = [];
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      const e = new Error(`refused: HTTP ${res.statusCode}`);
      e.statusCode = res.statusCode;
      reject(e);
    });
    ws.on('error', reject);
    ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      frames.push(msg);
      if (msg && msg.type === 'hello') resolve({ ws, hello: msg, frames });
    });
  });
}

test('portal ws: the daemon\'s hello arrives through the relay, and frames flow both ways', async (t) => {
  const r = await rig(t);
  const { ws, hello, frames } = await open(t, r);
  assert.equal(hello.type, 'hello');
  assert.ok(hello.store && typeof hello.store === 'object');

  // viewer → daemon
  ws.send(JSON.stringify({ type: 'store:set', patch: { from_remote: 'yes' } }));
  assert.ok(await waitUntil(async () => (await r.srv.api.get('/api/store')).json.from_remote === 'yes'),
    'the remote viewer\'s store write reached the daemon');

  // daemon → viewer (a broadcast after the hello)
  await r.srv.api.post('/api/store', { patch: { from_host: 1 } });
  assert.ok(await waitUntil(() => frames.some((f) => f && f.type === 'store:patch' && f.patch && f.patch.from_host === 1)),
    'a later broadcast reached the remote viewer');

  const h = await r.p.request('/api/health', { host: `127.0.0.1:${r.p.port}` });
  assert.equal(h.json.relays, 1);
});

test('portal ws: a foreign or missing Origin, no token, or another path is refused', async (t) => {
  const r = await rig(t);
  await assert.rejects(open(t, r, { origin: 'https://evil.example' }), (e) => e.statusCode === 403);
  await assert.rejects(open(t, r, { origin: null }), (e) => e.statusCode === 403, 'missing Origin');
  await assert.rejects(open(t, r, { token: null }), (e) => e.statusCode === 401);
  await assert.rejects(open(t, r, { path: '/api/events/stream' }), (e) => e.statusCode === 403, 'a refused route');
  await assert.rejects(open(t, r, { path: '/api/graph' }), (e) => e.statusCode === 403, 'an allowed route that is not the socket');
  await assert.rejects(open(t, r, { host: 'wc.example.test', origin: 'https://wc.example.test' }), (e) => e.statusCode === 404, 'the picker has no socket');
  await assert.rejects(open(t, r, { host: sessionHost(r.p.config, 'deadbeef'), origin: `https://${sessionHost(r.p.config, 'deadbeef')}` }),
    (e) => e.statusCode === 404, 'an unknown session');
});

test('portal ws: the relay is cut when the admitting token expires', async (t) => {
  const r = await rig(t, { wsGraceMs: 0 });
  const exp = Math.ceil(Date.now() / 1000) + 1;
  const { ws } = await open(t, r, { token: r.access.mint({ exp }) });
  const code = await new Promise((resolve) => ws.on('close', (c) => resolve(c)));
  assert.equal(code, CLOSE_EXPIRED);
  assert.ok(Date.now() >= exp * 1000 - 50, 'not before exp');
});

test('portal ws: a token a month from expiry keeps the relay open (no setTimeout overflow)', async (t) => {
  // Access offers a one-month session; exp 30 days out is past setTimeout's
  // 2^31-1 ms ceiling, which Node would clamp to 1ms and cut the relay at once.
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const r = await rig(t, { wsGraceMs: 0 });
  const exp = Math.ceil(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const { ws } = await open(t, r, { token: r.access.mint({ exp }) });
  let closed = null;
  ws.on('close', (c) => { closed = c; });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(closed, null, 'the relay is still open a second later');
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.deepEqual(warnings.filter((n) => n === 'TimeoutOverflowWarning'), [], 'no delay was clamped');
});

test('armDeadline: a wait longer than the cap is taken in steps and fires at the deadline, not the cap', async () => {
  const start = Date.now();
  const firedAt = await new Promise((resolve) => {
    armDeadline(start + 300, () => resolve(Date.now()), { maxMs: 40 });
  });
  assert.ok(firedAt - start >= 290, `fired after ${firedAt - start}ms, not at the 40ms cap`);

  let fired = false;
  const h = armDeadline(Date.now() + 200, () => { fired = true; }, { maxMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  h.clear();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fired, false, 'clear() cancels a later step too');

  const now = await new Promise((resolve) => armDeadline(NaN, () => resolve(true)));
  assert.equal(now, true, 'a non-number deadline fires at once');
});

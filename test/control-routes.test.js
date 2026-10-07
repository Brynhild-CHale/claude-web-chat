// The control domain's main-origin route (lib/server/routes/control.js, spec
// §15.3, §3.1 step 5, C47) and the events route's control-only stream
// (lib/server/routes/events.js, ruling B3 (a)), each on a bare Express app.
//
//   * POST /api/control/notices/claim is host only (P1): a browser (Origin or
//     Sec-Fetch metadata), a remote viewer (X-WC-Remote) and a network peer are
//     403 with the host-only hint; a host request through lib/client gets its
//     notices as [{id, text}]; every malformed body is 400.
//   * A stream whose ?kinds= is exactly 'control' neither retains nor releases
//     the daemon (the Esc injector holds one for a session's whole life);
//     kinds=wake still does; shutdown closes both.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { withTempHome, tmpRoot, openSSE, waitUntil } = require('../test-support/helpers');
const client = require('../lib/client');
const { createBus } = require('../lib/core/bus');
const { HOST_ONLY } = require('../lib/server/audience');
const { createControl } = require('../lib/server/control');
const { mountControlRoutes } = require('../lib/server/routes/control');
const { mountEventRoutes } = require('../lib/server/routes/events');

const S1 = '11111111-1111-4111-8111-111111111111';

// The audience as the routes ask it: Origin and Sec-Fetch-* are a browser,
// X-WC-Remote a remote viewer, x-test-peer a network peer.
function fakeAudience() {
  const levelOf = (req) => {
    if (req.headers['x-test-peer']) return 'basic';
    if (req.headers['x-wc-remote']) return 'full';
    return 'local';
  };
  const browser = (req) => !!(req.headers.origin || req.headers['sec-fetch-mode'] || req.headers['sec-fetch-site']);
  const isHost = (req) => levelOf(req) === 'local' && !browser(req);
  return {
    levelOf,
    isHost,
    requireHost: () => (req, res, next) => (isHost(req) ? next() : res.status(403).json({ ok: false, hint: HOST_ONLY })),
  };
}

async function listen(t, app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

function raw(port, { method = 'POST', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: { 'content-type': 'application/json', ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

async function claimRig(t) {
  withTempHome(t);
  const root = tmpRoot('wc-control-routes-');
  const mirror = { conversationOfPid: (pid) => (pid === 777 ? 'c1' : null), subscribe: () => () => {}, snapshot: () => ({ conversations: [] }) };
  const control = createControl({ root, mirror });
  t.after(() => control.stop());
  const app = express();
  app.use(express.json());
  mountControlRoutes(app, { control, audience: fakeAudience() });
  app.use((err, req, res, next) => { void next; res.status(err.status || 500).json({ ok: false }); });
  const port = await listen(t, app);
  return { control, port };
}

const CLAIM = '/api/control/notices/claim';

test('the claim is host only: a browser, a remote viewer and a network peer are 403 with the host-only hint', async (t) => {
  const { control, port } = await claimRig(t);
  control.notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'Files restored' });
  const body = { session_id: S1, max_chars: 9000 };
  for (const [label, headers] of [
    ['a browser (Origin)', { origin: 'http://127.0.0.1:5173' }],
    ['a browser (fetch metadata)', { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }],
    ['a remote viewer', { 'x-wc-remote': '1' }],
    ['a network peer', { 'x-test-peer': '1' }],
  ]) {
    const r = await raw(port, { path: CLAIM, headers, body });
    assert.equal(r.status, 403, label);
    assert.deepEqual(r.json, { ok: false, hint: HOST_ONLY }, label);
  }
  assert.equal(control.notices.pending().length, 1, 'no refused request claimed anything');
});

test('a host request through lib/client gets its notices as [{id, text}], exactly once', async (t) => {
  const { control, port } = await claimRig(t);
  const id = control.notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'Files restored from the web-chat page' });
  const a = await client.post(CLAIM, { session_id: S1, max_chars: 9000 }, { port });
  assert.deepEqual(a, { ok: true, notices: [{ id, text: 'Files restored from the web-chat page' }] });
  assert.ok(Array.isArray(a.notices) && a.notices.every((n) => Object.keys(n).sort().join() === 'id,text'));
  assert.deepEqual(await client.post(CLAIM, { session_id: S1, max_chars: 9000 }, { port }), { ok: true, notices: [] });
  // By the Claude Code process, through the facade's conversationOfPid.
  control.notices.put({ conversation_id: 'c1', session_ids: [], text: 'again' });
  assert.deepEqual((await client.post(CLAIM, { claude_pid: 777, max_chars: 9000 }, { port })).notices.map((n) => n.text), ['again']);
});

test('the claim body: an extra key, neither id, a bad id or pid, a missing or bad max_chars → 400', async (t) => {
  const { control, port } = await claimRig(t);
  control.notices.put({ conversation_id: 'c1', session_ids: [S1], text: 'kept' });
  for (const [label, body] of [
    ['an extra key', { session_id: S1, max_chars: 9000, text: 'x' }],
    ['neither id', { max_chars: 9000 }],
    ['a bad session id', { session_id: '../etc', max_chars: 9000 }],
    ['a number for a session id', { session_id: 12, max_chars: 9000 }],
    ['a string pid', { claude_pid: '777', max_chars: 9000 }],
    ['a zero pid', { claude_pid: 0, max_chars: 9000 }],
    ['a fractional pid', { claude_pid: 7.5, max_chars: 9000 }],
    ['no max_chars', { session_id: S1 }],
    ['a zero max_chars', { session_id: S1, max_chars: 0 }],
    ['a string max_chars', { session_id: S1, max_chars: '9000' }],
    ['an array body', [S1]],
  ]) {
    const r = await raw(port, { path: CLAIM, body });
    assert.equal(r.status, 400, `${label}: ${r.text}`);
    assert.equal(r.json.ok, false, label);
  }
  assert.equal(control.notices.pending().length, 1, 'no malformed request claimed anything');
});

test('no control wired: 503, never a crash', async (t) => {
  const app = express();
  app.use(express.json());
  mountControlRoutes(app, { audience: fakeAudience() });
  const port = await listen(t, app);
  const r = await raw(port, { path: CLAIM, body: { session_id: S1, max_chars: 10 } });
  assert.equal(r.status, 503);
  // And with no audience at all the route fails closed.
  const app2 = express();
  app2.use(express.json());
  mountControlRoutes(app2, {});
  const port2 = await listen(t, app2);
  assert.equal((await raw(port2, { path: CLAIM, body: { session_id: S1, max_chars: 10 } })).status, 403);
});

// ── the events route: a control-only stream does not keep the daemon up ────

async function eventsRig(t) {
  const calls = { retain: 0, release: 0 };
  const sseClients = new Set();
  const state = { wakeConsumers: 0, pendingWake: null, pendingAck: null };
  const bus = createBus();
  const app = express();
  mountEventRoutes(app, {
    state, bus, graph: null,
    retain: () => { calls.retain += 1; },
    release: () => { calls.release += 1; },
    sseClients,
  });
  const port = await listen(t, app);
  const shutdown = () => { for (const res of [...sseClients]) { try { res.end(); } catch {} } };
  return { calls, sseClients, state, bus, port, shutdown };
}

test('events (ruling B3 (a)): a kinds=control stream calls neither retain nor release; kinds=wake still does; shutdown closes both', async (t) => {
  const r = await eventsRig(t);
  const control = await openSSE(r.port, { kinds: ['control'] });
  t.after(() => control.close());
  await waitUntil(() => r.sseClients.size === 1, { what: 'the control stream registered' });
  assert.deepEqual(r.calls, { retain: 0, release: 0 }, 'a control-only stream does not hold the daemon');
  assert.equal(r.state.wakeConsumers, 0, 'nor is it a wake consumer');
  // It still hears control events.
  r.bus.emit({ event: { kind: 'control', op: 'interrupt', id: 'ci_x', via: 'tty' } });
  await waitUntil(() => control.events.some((e) => e.id === 'ci_x'), { what: 'the control event on the stream' });

  const wake = await openSSE(r.port, { kinds: ['wake'] });
  t.after(() => wake.close());
  await waitUntil(() => r.sseClients.size === 2, { what: 'the wake stream registered' });
  assert.deepEqual(r.calls, { retain: 1, release: 0 }, 'kinds=wake retains');
  // A mixed list is not control-only: it retains.
  const mixed = await openSSE(r.port, { kinds: ['control', 'store'] });
  t.after(() => mixed.close());
  await waitUntil(() => r.sseClients.size === 3, { what: 'the mixed stream registered' });
  assert.equal(r.calls.retain, 2);

  r.shutdown();
  await waitUntil(() => r.sseClients.size === 0, { what: 'shutdown closed every stream' });
  assert.deepEqual(r.calls, { retain: 2, release: 2 }, 'only the retaining streams release');
});

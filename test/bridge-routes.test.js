// The mod bridge's routes (lib/server/routes/bridge.js, spec §15.7, §5.7 class
// P1) and the fake mod that drives them (test-support/fake-mod.js).
//
// The routes are mounted on a BARE Express app (spec §10.1) with a ctx of a
// REAL audience (lib/server/audience, no remote opt-in), a real hook tap, a
// fake mirror and a real bridge on real timers. U94a mounts them in the daemon
// and creates ctx.bridge; this file proves the routes alone.
//
// Who is refused, and how each is simulated:
//   a browser (a pane's fetch)  an Origin header, or Node's fetch, which sends
//                               sec-fetch-mode as every browser does
//   a remote viewer             X-WC-Remote: 1 from loopback, what the portal sends
//   a network peer (Q9)         the request's socket remoteAddress stubbed to a
//                               LAN address for that one request
// The host is lib/client — no Origin, no Sec-Fetch-* — as the mod's
// $.http.fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { mountBridgeRoutes } = require('../lib/server/routes/bridge');
const { createBridge } = require('../lib/server/domain/bridge');
const { createHookTap } = require('../lib/server/hook-tap');
const { createAudience } = require('../lib/server/audience');
const { classify } = require('../lib/core/remote-policy');
const { request } = require('../lib/client');
const P = require('../lib/core/mod-protocol');
const { fakeMod } = require('../test-support/fake-mod');
const { waitUntil } = require('../test-support/helpers');

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const HOST_HINT = classify('POST', '/api/bridge/hello').hint;

const ROUTES = [
  ['POST', '/api/bridge/hello'],
  ['GET', '/api/bridge/ops?wait=0'],
  ['POST', '/api/bridge/result'],
  ['POST', '/api/bridge/events'],
  ['GET', '/api/bridge/status'],
];

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bridge-routes-'));
  fs.mkdirSync(path.join(dir, '.web-chat'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function host(t, { globalJson = true, withBridge = true } = {}) {
  const root = project(t);
  const hooks = createHookTap();
  const published = [];
  hooks.subscribe((e) => { if (e.event === P.MOD_EVENT) published.push(e); });
  const audience = createAudience({ configFile: null });
  const mirror = { subscribe: () => () => {}, conversationOf: () => null };
  const bridge = withBridge ? createBridge({ root, hooks, mirror }) : null;
  if (bridge) bridge.start();
  const app = express();
  // A network peer: this one request's socket answers a LAN address.
  app.use((req, res, next) => {
    const peer = req.headers['x-test-peer'];
    if (peer) {
      const real = req.socket;
      Object.defineProperty(req, 'socket', {
        configurable: true,
        value: new Proxy(real, { get: (o, k) => (k === 'remoteAddress' ? peer : Reflect.get(o, k)) }),
      });
    }
    next();
  });
  if (globalJson) app.use(express.json({ limit: '200mb' }));
  mountBridgeRoutes(app, { audience, hooks, mirror, bridge });
  app.use((err, req, res, next) => { res.status(err.status || 500).json({ ok: false }); }); // eslint-disable-line no-unused-vars
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    if (bridge) await bridge.stop();
    audience.stop();
    await new Promise((r) => server.close(r));
  });
  const port = server.address().port;
  return {
    root, port, hooks, published, bridge,
    mod: (sessionId = S1, opts = {}) => {
      const m = fakeMod({ port, sessionId, root, ...opts });
      t.after(() => m.close());
      return m;
    },
    call: (method, p, body, headers) => request(port, method, p, body, { headers }),
    fetch: async (method, p, body, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      let json = null;
      try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    },
  };
}

// ── the fake mod, end to end ────────────────────────────────────────────────

test('fake mod: hello → runOps answers a queued op through result → events reach the tap once; close() leaves nothing running', async (t) => {
  const h = await host(t);
  const mod = h.mod();
  const hi = await mod.hello();
  assert.equal(hi.status, 200);
  assert.match(hi.body.token, /^[0-9a-f]{48}$/);
  assert.deepEqual(hi.body.ops, [...P.OPS]);
  assert.deepEqual(hi.body.events, [...P.EVENT_KINDS]);
  const seen = [];
  const stop = mod.runOps({
    abort: (args) => { seen.push(['abort', args]); return { aborted: true }; },
    command: (args) => { seen.push(['command', args]); return { refused: 'busy' }; },
  });
  assert.deepEqual(await h.bridge.enqueue(S1, { op: 'abort' }), { ok: true, result: { aborted: true } });
  assert.deepEqual(await h.bridge.enqueue(S1, { op: 'command', args: { name: 'compact' } }), { ok: false, refused: 'busy', delivered: true });
  assert.deepEqual(await h.bridge.enqueue(S1, { op: 'usage' }), { ok: false, refused: 'unsupported', delivered: true });
  assert.deepEqual(seen, [['abort', {}], ['command', { name: 'compact' }]]);

  const r = await mod.events([
    { kind: 'turn.start', at: Date.now() - 50, turn_id: 't1' },
    { kind: 'tool.call', at: Date.now() - 40, tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: '/p/a.js' } },
  ]);
  assert.deepEqual(r, { status: 200, body: { ok: true, accepted: 2, dropped: 0 } });
  await waitUntil(() => h.published.length === 2, { what: 'two envelopes on the tap' });
  assert.deepEqual(h.published.map((e) => [e.event, e.synthetic, e.session_id, e.mod.kind]), [
    ['ModEvent', true, S1, 'turn.start'], ['ModEvent', true, S1, 'tool.call'],
  ]);
  assert.equal(h.published[1].tool.name, 'Read');
  await stop();
  await mod.close();
  assert.equal(h.bridge.status().sessions[0].polling, false, 'the loop\'s last poll is over');
});

// ── host only ────────────────────────────────────────────────────────────────

test('host only: every bridge route refuses a browser, a remote viewer and a network peer with classify()\'s hint', async (t) => {
  const h = await host(t);
  const mod = h.mod();
  await mod.hello();
  const auth = { 'X-WC-Bridge': mod.token };
  const refusals = [
    ['an Origin', { Origin: 'http://127.0.0.1:5173', ...auth }],
    ['sec-fetch metadata', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', ...auth }],
    ['X-WC-Remote', { 'X-WC-Remote': '1', ...auth }],
    ['a network peer', { 'X-Test-Peer': '192.168.1.20', ...auth }],
  ];
  for (const [method, p] of ROUTES) {
    for (const [who, headers] of refusals) {
      const r = await h.call(method, p, method === 'POST' ? {} : null, headers);
      assert.equal(r.status, 403, `${method} ${p} from ${who}`);
      assert.deepEqual(r.body, { ok: false, hint: HOST_HINT });
    }
    const viaFetch = await h.fetch(method, p, {}, auth);
    assert.equal(viaFetch.status, 403, `${method} ${p} from Node's fetch (a browser)`);
  }
  // The stub is what refused the peer: the same request from a loopback
  // address passes.
  assert.equal((await h.call('GET', '/api/bridge/status', null, { 'X-Test-Peer': '127.0.0.1' })).status, 200);
  assert.equal((await h.call('GET', '/api/bridge/ops?wait=0', null, { 'X-Test-Peer': '::1', ...auth })).status, 200);
  // A pane's hello attaches nothing.
  const pane = await h.fetch('POST', '/api/bridge/hello', {
    v: 1, protocol: 1, session_id: S2, cc_version: '2.1.296', mod_version: '0.8.5', ops: [], events: [], root: h.root,
  });
  assert.equal(pane.status, 403);
  assert.equal(h.bridge.attached(S2), false);
  assert.equal(h.bridge.status().counters.ops_enqueued, 0);
});

test('no ctx.bridge → 503 for every route; no audience → 403', async (t) => {
  const h = await host(t, { withBridge: false });
  for (const [method, p] of ROUTES) {
    const r = await h.call(method, p, method === 'POST' ? {} : null, { 'X-WC-Bridge': 'a'.repeat(48) });
    assert.equal(r.status, 503, `${method} ${p}`);
    assert.equal(r.body.unavailable, true);
  }
  const app = express();
  mountBridgeRoutes(app, { bridge: { hello: () => ({ status: 200, body: {} }) } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const r = await request(server.address().port, 'GET', '/api/bridge/status');
  assert.equal(r.status, 403, 'fails closed');
});

test('token: no or a wrong X-WC-Bridge → 401; a token in the query string is ignored', async (t) => {
  const h = await host(t);
  const mod = h.mod();
  await mod.hello();
  for (const [method, p] of ROUTES.slice(1, 4)) {
    const none = await h.call(method, p, method === 'POST' ? { events: [] } : null);
    assert.equal(none.status, 401, `${method} ${p} with none`);
    assert.equal(none.body.refused, 'token');
    const wrong = await h.call(method, p, method === 'POST' ? { events: [] } : null, { 'X-WC-Bridge': 'f'.repeat(48) });
    assert.equal(wrong.status, 401, `${method} ${p} with a wrong one`);
    assert.equal(wrong.body.refused, 'token');
  }
  const viaQuery = await h.call('GET', `/api/bridge/ops?wait=0&token=${mod.token}`);
  assert.equal(viaQuery.status, 401);
  const viaQuery2 = await h.call('POST', `/api/bridge/events?x-wc-bridge=${mod.token}`, { events: [] });
  assert.equal(viaQuery2.status, 401);
  // The real one works.
  assert.equal((await mod.poll()).status, 200);
  // A superseded one says so.
  const old = mod.token;
  await mod.hello();
  assert.equal((await h.call('GET', '/api/bridge/ops', null, { 'X-WC-Bridge': old })).body.refused, 'superseded');
});

// ── bodies ───────────────────────────────────────────────────────────────────

for (const globalJson of [true, false]) {
  test(`bodies (${globalJson ? 'behind the daemon\'s 200 MB parser' : 'the route\'s own parser'}): 70 KB → 413, not JSON → 415, malformed → 400, 51 events → 400`, async (t) => {
    const h = await host(t, { globalJson });
    const mod = h.mod();
    await mod.hello();
    const auth = { 'X-WC-Bridge': mod.token };
    const big = { events: [{ kind: 'turn.step', at: Date.now(), turn_id: 't', index: 0, delta: 'x'.repeat(70 * 1024) }] };
    assert.equal((await h.call('POST', '/api/bridge/events', big, auth)).status, 413);
    assert.equal((await h.call('POST', '/api/bridge/hello', { pad: 'x'.repeat(70 * 1024) })).status, 413);
    assert.equal((await h.call('POST', '/api/bridge/result', { id: 'op_1', ok: true, result: 'x'.repeat(70 * 1024) }, auth)).status, 413);
    assert.equal((await h.call('POST', '/api/bridge/events', 'events=1', { ...auth, 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await h.call('POST', '/api/bridge/hello', '{"v":1,', {})).status, 400);
    const many = { events: Array.from({ length: 51 }, () => ({ kind: 'turn.start', at: Date.now(), turn_id: 't' })) };
    assert.equal((await h.call('POST', '/api/bridge/events', many, auth)).status, 400);
    const extra = await mod.hello({ messaging_token: 'never' });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error, 'bad_request');
    assert.equal(h.published.length, 0);
  });
}

test('hello over HTTP: a 409 refusal mints no token; wait= must be a number', async (t) => {
  const h = await host(t);
  const old = await h.mod(S1, { ccVersion: '2.1.286' }).hello();
  assert.equal(old.status, 409);
  assert.equal(old.body.refused, 'too-old');
  assert.equal(old.body.token, undefined);
  const other = await h.mod(S1).hello({ root: os.tmpdir() });
  assert.equal(other.status, 409);
  assert.equal(other.body.refused, 'wrong-project');
  const mod = h.mod(S2);
  await mod.hello();
  assert.equal((await h.call('GET', '/api/bridge/ops?wait=soon', null, { 'X-WC-Bridge': mod.token })).status, 400);
});

// ── the long-poll over HTTP ─────────────────────────────────────────────────

test('ops over HTTP: a waiting poll is answered by an enqueue; a client that goes away frees its waiter', async (t) => {
  const h = await host(t);
  const mod = h.mod();
  await mod.hello();
  const waiting = mod.poll({ wait: 20000 });
  await waitUntil(() => h.bridge.status().sessions[0].polling, { what: 'the poll to wait' });
  const done = h.bridge.enqueue(S1, { op: 'taskStop', args: { task_id: 'b3k9x2' } });
  const r = await waiting;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.ops.map((o) => [o.op, o.args]), [['taskStop', { task_id: 'b3k9x2' }]]);
  await mod.result(r.body.ops[0].id, { result: { stopped: true } });
  assert.deepEqual(await done, { ok: true, result: { stopped: true } });

  // A poll whose client goes away: the waiter is freed at once.
  const gone = http.request({
    hostname: '127.0.0.1', port: h.port, path: '/api/bridge/ops?wait=20000', method: 'GET', headers: { 'X-WC-Bridge': mod.token },
  });
  gone.on('error', () => {});
  gone.end();
  await waitUntil(() => h.bridge.status().sessions[0].polling, { what: 'the second poll to wait' });
  gone.destroy();
  await waitUntil(() => !h.bridge.status().sessions[0].polling, { what: 'the waiter to be freed' });
});

test('GET /api/bridge/status: host only, no token needed, and none in it', async (t) => {
  const h = await host(t);
  const mod = h.mod();
  await mod.hello();
  h.bridge.enqueue(S1, { op: 'submit', args: { text: 'SECRET-PROMPT' } });
  await mod.events([{ kind: 'turn.complete', at: Date.now(), turn_id: 't', text: 'SECRET-REPLY' }]);
  const r = await h.call('GET', '/api/bridge/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sessions.length, 1);
  assert.equal(r.body.sessions[0].session_id, S1);
  const text = JSON.stringify(r.body);
  for (const needle of [mod.token, 'SECRET-PROMPT', 'SECRET-REPLY']) assert.ok(!text.includes(needle), needle);
});

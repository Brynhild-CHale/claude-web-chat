// Self-tests for the shared harness engine (test-support/helpers.js). The whole
// suite synchronises through waitUntil and openSSE, so their contracts are load
// bearing: if waitUntil silently stopped returning the first truthy VALUE, ~20
// call sites would start asserting on `true` and pass for the wrong reason; if
// openSSE lost a rejection path, a transport hiccup would go back to hanging the
// run instead of failing it.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, withHub, withTempHome, waitUntil, openSSE } = require('../test-support/helpers');

// ── waitUntil ────────────────────────────────────────────────────────────────

test('waitUntil: resolves with the first TRUTHY VALUE, not `true`', async () => {
  let n = 0;
  const v = await waitUntil(() => (++n >= 3 ? { nonce: 'abc' } : null), { timeout: 1000, interval: 5 });
  assert.deepEqual(v, { nonce: 'abc' }, 'the caller gets the thing it waited for');
});

test('waitUntil: awaits an async predicate', async () => {
  let n = 0;
  const v = await waitUntil(async () => (++n >= 2 ? 'ok' : false), { timeout: 1000, interval: 5 });
  assert.equal(v, 'ok');
});

test('waitUntil: returns false on timeout when no `what` is given', async () => {
  const v = await waitUntil(() => false, { timeout: 40, interval: 10 });
  assert.equal(v, false, 'assert.ok(await waitUntil(…), "msg") keeps its own message');
});

test('waitUntil: throws a LABELLED error on timeout when `what` is given', async () => {
  await assert.rejects(
    () => waitUntil(() => false, { timeout: 40, interval: 10, what: 'the thing' }),
    /timed out waiting for the thing/,
  );
});

test('waitUntil: evaluates ONCE MORE after the deadline', async () => {
  // queue.test.js and version.test.js both relied on this last chance: a
  // predicate that only becomes true as the budget runs out is not lost to the
  // final sleep. With timeout 0 the loop gets exactly one look, so the second
  // call can only be the post-deadline re-check.
  let calls = 0;
  const v = await waitUntil(() => ++calls >= 2, { timeout: 0 });
  assert.equal(v, true);
  assert.equal(calls, 2, 'the post-deadline re-evaluation is what saw it');
});

// ── openSSE ──────────────────────────────────────────────────────────────────

test('openSSE: opens, collects events, and closes', async (t) => {
  const { api, port } = await withServer(t);
  const sse = await openSSE(port, { kinds: ['render'] });
  t.after(() => sse.close());

  await api.post('/api/render', { id: 'm1', html: '<p>x</p>' });
  const ev = await waitUntil(() => sse.events.find((e) => e.kind === 'render'), { timeout: 2000, what: 'a render event' });
  assert.equal(ev.id, 'm1');
});

test('openSSE: REJECTS on the TRANSPORT error when nothing is listening', async () => {
  // The hole this engine closes: the three private copies passed onOpen only, so
  // a refused connection left the promise pending forever and the runner hung.
  //
  // Both halves of this are load bearing. A bare `assert.rejects` passed with
  // subscribeSSE's onError AND onClose rejections replaced by no-ops — it just
  // took 2 s, because openSSE's own deadline fired. So the assertion said
  // nothing about the paths it is named for. Name the error, and give the
  // deadline enough rope (10 s) that reaching it is unmistakable in the elapsed
  // time.
  const t0 = Date.now();
  await assert.rejects(
    () => openSSE(1, { timeout: 10000 }),
    /ECONNREFUSED|closed before it opened/,
  );
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `rejected after ${ms}ms — that is the deadline, not the transport error path`);
});

test('openSSE: REJECTS on its own DEADLINE when the socket accepts and never answers', async (t) => {
  // The third path, pinned separately so the two cannot cover for each other: a
  // listener that completes the TCP handshake and then says nothing produces no
  // error and no close, and only the deadline ends the wait.
  const net = require('node:net');
  const sockets = new Set();
  const srv = net.createServer((sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }));

  await assert.rejects(
    () => openSSE(srv.address().port, { timeout: 300 }),
    /did not open within 300ms/,
  );
});

test('openSSE: awaitChannel waits for the server to COUNT the stream as a channel', async (t) => {
  const { api, port } = await withServer(t);
  assert.equal((await api.get('/api/queue/policy')).json.channel_connected, false, 'baseline');
  const sse = await openSSE(port, { kinds: ['wake'], awaitChannel: api });
  t.after(() => sse.close());
  assert.equal((await api.get('/api/queue/policy')).json.channel_connected, true,
    'awaitChannel resolved only once the server agreed a channel is connected');
});

// ── withHub ──────────────────────────────────────────────────────────────────

test('withHub: boots a hub the harness bound to loopback, and tears it down on t.after', async (t) => {
  // The bind asserted here is withHub's own `hub.server.listen(port, LISTEN_HOST)`
  // — the harness matching production, not evidence about production. The real
  // start() is pinned by the next test.
  const { api, server } = await withHub(t);
  assert.equal(server.address().address, '127.0.0.1', 'the harness binds loopback, not a wildcard');
  const h = await api.get('/api/health');
  assert.equal(h.json.role, 'hub');
});

// lib/hub's own start(). Nothing in the tree called it: every hub test bound the
// server itself, so deleting LISTEN_HOST from start() — the line that keeps the
// capture hub off every interface on the machine — passed the whole suite. The
// happy path does not process.exit (only the already-running and EADDRINUSE
// branches do), so it can be driven in-process. registerHub-on-start gets its
// first coverage here too.
test('hub.start(): binds LISTEN_HOST and registers itself', async (t) => {
  const net = require('node:net');
  const { LISTEN_HOST } = require('../lib/core/cors');
  const { createHub } = require('../lib/hub');
  const { readHubEntry, deregisterHub } = require('../lib/util/registry');

  const home = withTempHome(t);
  assert.ok(home, 'registerHub writes under HOME — never the developer\'s');

  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });

  const hub = createHub({ port });
  const say = console.log;
  console.log = () => {};
  try {
    await hub.start();
  } finally {
    console.log = say;
  }
  try {
    assert.equal(hub.server.address().address, LISTEN_HOST,
      'start() must bind LISTEN_HOST — a wildcard bind exposes the capture hub to the network');
    const entry = readHubEntry();
    assert.ok(entry, 'start() registers the hub so ensureHub and doctor can find it');
    assert.equal(entry.port, port);
    assert.equal(entry.pid, process.pid);
  } finally {
    await hub.stop();
    deregisterHub({ pid: process.pid });
  }
});

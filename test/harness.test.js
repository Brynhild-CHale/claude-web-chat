// Self-tests for the shared harness engine (test-support/helpers.js). The whole
// suite synchronises through waitUntil and openSSE, so their contracts are load
// bearing: if waitUntil silently stopped returning the first truthy VALUE, ~20
// call sites would start asserting on `true` and pass for the wrong reason; if
// openSSE lost a rejection path, a transport hiccup would go back to hanging the
// run instead of failing it.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, withHub, waitUntil, openSSE } = require('../test-support/helpers');

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

test('openSSE: REJECTS instead of hanging when nothing is listening', async () => {
  // The hole this engine closes: the three private copies passed onOpen only, so
  // a refused connection left the promise pending forever and the runner hung.
  await assert.rejects(() => openSSE(1, { timeout: 2000 }));
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

test('withHub: boots a hub on loopback and tears it down on t.after', async (t) => {
  const { api, server } = await withHub(t);
  assert.equal(server.address().address, '127.0.0.1', 'the hub binds loopback, not a wildcard');
  const h = await api.get('/api/health');
  assert.equal(h.json.role, 'hub');
});

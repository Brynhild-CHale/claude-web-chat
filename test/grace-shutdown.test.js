const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { withServer, waitUntil, deafWs } = require('../test-support/helpers');

// Resolve once the socket receives its first frame, then hand back the live
// socket (the caller closes it to exercise the grace timer).
function awaitHello(sock) {
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.on('message', () => resolve(sock));
  });
}

test('grace: WS close does not synchronously trigger shutdown', async (t) => {
  const { api, ws } = await withServer(t);

  const sock = await awaitHello(ws());
  sock.close();
  await new Promise((r) => setTimeout(r, 200));
  // Server should still be reachable — grace window has not elapsed.
  const r = await api.get('/api/graph');
  assert.equal(r.status, 200);
});

test('grace: reconnect within grace cancels shutdown timer', async (t) => {
  const { api, ws } = await withServer(t);

  const ws1 = await awaitHello(ws());
  ws1.close();
  await new Promise((r) => setTimeout(r, 50));
  const ws2 = await awaitHello(ws());

  const r = await api.get('/api/graph');
  assert.equal(r.status, 200);
  ws2.close();
});

// ── the SHUTDOWN's own budget ──────────────────────────────────────────────
//
// gracefulShutdown ends with `await server.close()`, which resolves only once
// EVERY remaining connection is gone. Two kinds of client can hold one open
// forever: an HTTP socket that started a request and never finished sending it,
// and a WebSocket that never answers the polite close frame `wsApi.shutdown()`
// sends it (a wedged tab, a suspended laptop). Neither is reached by
// `closeIdleConnections()`, which by definition only touches idle sockets.
//
// An unbounded shutdown is not a slow shutdown, it is a broken contract: `stop`
// sizes its wait on the daemon's worst case, so a close that can never finish
// means no budget the CLI picks is ever correct.

// A client that pins a connection open and will not let go. `kind:'http'` sends
// request headers it never terminates (an ACTIVE connection, so closeIdle skips
// it); `kind:'ws'` is the harness's `deafWs` — a completed upgrade that then
// ignores everything, which closeAllConnections() cannot reach either, because
// Node drops a socket from the HTTP server's connection list the moment it is
// upgraded. Only the http half is local: it is this file's own idiom, and no
// second copy of it exists.
function pinConnection(t, port, kind = 'http') {
  if (kind === 'ws') return deafWs(t, port);
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n'); // never terminated
      resolve(sock);
    });
    sock.on('error', reject);
    t.after(() => { try { sock.destroy(); } catch {} });
  });
}

for (const kind of ['http', 'ws']) {
  test(`grace: gracefulShutdown is bounded when a ${kind} client holds a socket open`, async (t) => {
    const { port, graceful } = await withServer(t);
    const sock = await pinConnection(t, port, kind);

    const outcome = await Promise.race([
      graceful().then(() => 'done'),
      new Promise((r) => setTimeout(() => r('stalled'), 8000)),
    ]);
    assert.equal(outcome, 'done', 'the shutdown must finish on its own budget, not the client\'s');
    // Settling is not enough: the hard deadline at CLOSE_DRAIN_TIMEOUT_MS*2 would
    // resolve the promise even if nothing had hung the socket up, which is how
    // `wsApi.terminate()` sat unpinned. The force step must actually END the
    // connection — and for the ws case only terminate() can, because Node drops a
    // socket from the HTTP server's connection list the moment it is upgraded, so
    // closeAllConnections() cannot see it.
    await waitUntil(() => sock.destroyed, { timeout: 1000, interval: 20 });
    assert.ok(sock.destroyed, `the ${kind} socket must be hung up by the shutdown, not merely outlived by it`);
  });
}

// The other half of the same defect. gracefulShutdown was guarded by a boolean,
// so a SECOND entry returned instantly — and every caller in the tree follows
// its await with process.exit(). A signal arriving during an in-flight shutdown
// therefore exited the process mid-drain, before the release() that drops the
// portfile and the registry entry. One shared promise is the fix: a second
// trigger waits for the first to finish rather than overtaking it.
test('grace: a second shutdown trigger awaits the first instead of overtaking it', async (t) => {
  const { port, graceful } = await withServer(t);
  await pinConnection(t, port, 'ws');

  const order = [];
  await Promise.all([
    graceful().then(() => order.push('first')),
    graceful().then(() => order.push('second')),
  ]);
  assert.deepEqual(order, ['first', 'second'], 'the second caller must not be released early');
});

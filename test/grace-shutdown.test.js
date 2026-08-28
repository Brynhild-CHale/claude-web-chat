const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const { withServer } = require('../test-support/helpers');

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
// it); `kind:'ws'` completes the WebSocket upgrade and then goes deaf, which
// closeAllConnections() cannot reach either — Node drops a socket from the HTTP
// server's connection list the moment it is upgraded.
function pinConnection(t, port, kind = 'http') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      if (kind === 'ws') {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(
          'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      } else {
        sock.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n'); // never terminated
        resolve(sock);
      }
    });
    // For the WS pin, wait for the upgrade response so the socket is genuinely
    // upgraded before the test proceeds. Then ignore everything, close frame
    // included.
    sock.on('data', (d) => { if (kind === 'ws' && /101/.test(d.toString().slice(0, 16))) resolve(sock); });
    sock.on('error', reject);
    t.after(() => { try { sock.destroy(); } catch {} });
  });
}

for (const kind of ['http', 'ws']) {
  test(`grace: gracefulShutdown is bounded when a ${kind} client holds a socket open`, async (t) => {
    const { port, graceful } = await withServer(t);
    await pinConnection(t, port, kind);

    const outcome = await Promise.race([
      graceful().then(() => 'done'),
      new Promise((r) => setTimeout(() => r('stalled'), 8000)),
    ]);
    assert.equal(outcome, 'done', 'the shutdown must finish on its own budget, not the client\'s');
  });
}

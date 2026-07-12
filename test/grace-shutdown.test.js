const test = require('node:test');
const assert = require('node:assert');
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

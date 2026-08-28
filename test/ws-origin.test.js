// The WebSocket Origin gate — lib/server/ws.js's `verifyClient`.
//
// That one line is the whole defence for the `hello` frame, which is an
// unconditional full-state disclosure (every pane's HTML plus the entire shared
// store, which holds whatever a file-editor pane has open) sent before the
// client says anything. Browsers apply NO same-origin policy to WebSocket
// connects and ports 5173+ are trivially scannable, so without the gate any page
// the user happens to visit could read all of it and write store keys back.
//
// It had no test until now — not because nobody tried, but because
// test-support's wsConnect could not send a header, so every WS connection in
// the suite took the `!origin` branch. Deleting `verifyClient` passed the whole
// suite. `wsConnect(port, path, { headers })` is what closed that.
//
// isLocalOrigin itself is unit-tested in shutdown-route.test.js; what these
// three pin is the WIRING — that the predicate is actually consulted on upgrade,
// and which way each of its three answers goes.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, wsHello } = require('../test-support/helpers');

test('ws: a FOREIGN Origin is refused at the upgrade — no hello, HTTP 401', async (t) => {
  const { port } = await withServer(t);
  await assert.rejects(
    () => wsHello(port, '/ws', { headers: { Origin: 'https://evil.example' } }),
    (e) => {
      assert.equal(e.statusCode, 401, 'ws refuses the upgrade rather than completing it');
      return true;
    },
  );
});

test('ws: a localhost Origin — our own surface — receives hello', async (t) => {
  const ctx = await withServer(t);
  const hello = await ctx.wsHello('/ws', { headers: { Origin: `http://localhost:${ctx.port}` } });
  assert.equal(hello.type, 'hello');
});

test('ws: an ABSENT Origin (a driver, the CLI, a test) receives hello', async (t) => {
  // Deliberate policy, not an oversight: a non-browser client already has
  // filesystem access to everything the hello frame carries.
  const ctx = await withServer(t);
  const hello = await ctx.wsHello();
  assert.equal(hello.type, 'hello');
});

test('ws: a 127.0.0.1 Origin is local too (the surface can be opened either way)', async (t) => {
  const ctx = await withServer(t);
  const hello = await ctx.wsHello('/ws', { headers: { Origin: `http://127.0.0.1:${ctx.port}` } });
  assert.equal(hello.type, 'hello');
});

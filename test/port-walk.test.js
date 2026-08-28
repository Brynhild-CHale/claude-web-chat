const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { LISTEN_HOST } = require('../lib/core/cors');

test('two auto servers bind to different ports', async (t) => {
  const { port: aPort } = await withServer(t, { mode: 'start' });
  assert.ok(aPort >= 5173, `first server should be ≥5173, got ${aPort}`);

  const { port: bPort } = await withServer(t, { mode: 'start' });
  assert.ok(bPort >= 5173, `second server should be ≥5173, got ${bPort}`);

  assert.notEqual(aPort, bPort, 'two auto servers should bind to different ports');
});

// The other half of the audit's two security fixes (the WS Origin gate is
// test/ws-origin.test.js). Everything web-chat serves is unauthenticated by
// design, so the bind ADDRESS is the access control — and nothing pinned it:
// deleting the LISTEN_HOST argument at lib/server/index.js's listen() call makes
// the server bind the wildcard, which passed the whole suite. Only the
// {mode:'start'} branch of withServer goes through start(); the default
// listen(0) does not, which is why the assertion lives here.
test('a started server binds loopback, not a wildcard', async (t) => {
  assert.equal(LISTEN_HOST, '127.0.0.1', 'test premise: WEB_CHAT_HOST is not overriding the default');
  const { server } = await withServer(t, { mode: 'start' });
  assert.equal(server.address().address, LISTEN_HOST,
    'listen() must be passed LISTEN_HOST — a wildcard bind exposes the graph, store and /api/update to the network');
});

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');

test('two auto servers bind to different ports', async (t) => {
  const { port: aPort } = await withServer(t, { mode: 'start' });
  assert.ok(aPort >= 5173, `first server should be ≥5173, got ${aPort}`);

  const { port: bPort } = await withServer(t, { mode: 'start' });
  assert.ok(bPort >= 5173, `second server should be ≥5173, got ${bPort}`);

  assert.notEqual(aPort, bPort, 'two auto servers should bind to different ports');
});

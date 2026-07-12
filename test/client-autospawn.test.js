const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readPortfileAt: readPortfile, deletePortfileAt: deletePortfile } = require('../lib/core/portfiles');

// The headline resilience fix: with nothing running, the very first MCP client
// call auto-spawns the daemon and succeeds — instead of throwing NoServerError.
//
// The client discovers its root from process.cwd(), so we chdir into a fresh
// temp project. node --test runs each file in its own process, so this chdir
// and the client module's once-per-process spawn guard are isolated here.
test('first client call with no server auto-spawns the daemon', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-autospawn-'));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  const webChatDir = path.join(root, '.web-chat');

  const prevCwd = process.cwd();
  const prevPort = process.env.WEB_CHAT_PORT;
  delete process.env.WEB_CHAT_PORT; // force portfile/spawn discovery
  process.chdir(root);

  let info;
  try {
    const client = require('../lib/mcp/client');
    assert.equal(readPortfile(webChatDir), null, 'precondition: no server running');

    const health = await client.get('/api/health');
    assert.equal(health.ok, true);
    assert.equal(typeof health.pid, 'number');

    info = readPortfile(webChatDir);
    assert.ok(info, 'a portfile should now exist');
  } finally {
    process.chdir(prevCwd);
    if (prevPort !== undefined) process.env.WEB_CHAT_PORT = prevPort;
    // Tear down the daemon we spawned.
    if (info && info.pid) { try { process.kill(info.pid, 'SIGTERM'); } catch {} }
    // Give it a moment to clean up its own portfile; remove ours regardless.
    await new Promise((r) => setTimeout(r, 300));
    deletePortfile(webChatDir);
  }
});

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  readPortfileAt: readPortfile, deletePortfileAt: deletePortfile, isPidAlive,
} = require('../lib/core/portfiles');
const { withTempHome, waitUntil } = require('../test-support/helpers');

// The headline resilience fix: with nothing running, the very first MCP client
// call auto-spawns the daemon and succeeds — instead of throwing NoServerError.
//
// The client discovers its root from process.cwd(), so we chdir into a fresh
// temp project. node --test runs each file in its own process, so this chdir
// and the client module's once-per-process spawn guard are isolated here.
//
// This is the ONE test that spawns a production daemon through the real
// lib/util/daemon.js path, and that spawn passes no `env` — the child inherits
// whatever HOME this process has. Without a redirect the daemon's start() wrote
// this throwaway tmp root into the developer's real ~/.web-chat/instances.json
// and called ensureHub() against their live capture hub, SIGTERMing and
// respawning it whenever the running hub's protocol version was behind this
// checkout. withTempHome is the braces; test-support/sandbox is the belt (it
// redirects HOME for the whole process before any require, which is what covers
// the OTHER env-less spawns in the suite, e.g. profile-cli's real CLI).
test('first client call with no server auto-spawns the daemon', async (t) => {
  withTempHome(t);
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
    // Tear down the daemon we spawned, and wait for it to actually EXIT instead
    // of sleeping a fixed 300ms and hoping — otherwise a still-draining daemon
    // outlives the test.
    if (info && info.pid) {
      try { process.kill(info.pid, 'SIGTERM'); } catch {}
      await waitUntil(() => !isPidAlive(info.pid), { timeout: 8000, interval: 50 });
    }
    deletePortfile(webChatDir);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

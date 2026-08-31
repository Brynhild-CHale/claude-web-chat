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

// core-7. Every detached spawn logs to a file, and the parent's copy of that
// file descriptor was never closed — daemon.js opened it TWICE (stdout and
// stderr) and closed neither, hub.js opened it once and closed it either. In a
// one-shot CLI that is invisible. The MCP server is not one-shot: it respawns a
// dead daemon on demand (lib/client), so a Claude Code session leaked a pair of
// descriptors per respawn until it exited.
//
// Descriptors are handed out lowest-available, so an open/close probe before and
// after N spawns reads the parent's fd table without /proc (which macOS lacks).
test('a detached spawn does not leak the log file descriptor into the parent', async (t) => {
  const { spawnDetached } = require('../lib/util/daemon');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fd-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const log = path.join(dir, 'child.log');
  // Not the CLI: a child that says hello and exits, so nothing is left running.
  const bin = path.join(dir, 'say-hi.js');
  fs.writeFileSync(bin, "process.stdout.write('hi\\n');\n");

  const probe = () => { const fd = fs.openSync(log, 'a'); fs.closeSync(fd); return fd; };
  const before = probe();
  const kids = [];
  for (let i = 0; i < 5; i++) kids.push(spawnDetached({ bin, log }));
  const after = probe();

  assert.equal(after, before, `the lowest free descriptor must not move (${before} -> ${after})`);
  // And the child really did inherit one: five lines in the shared log.
  await waitUntil(() => (fs.readFileSync(log, 'utf8').match(/hi/g) || []).length === 5, { timeout: 8000, interval: 50 });
  for (const c of kids) { try { c.kill(); } catch {} }
});

// The MCP client's auto-spawn must survive the daemon DYING, not just being
// absent at first use.
//
// `ensureDaemon` memoised its settled result, so the first successful spawn was
// remembered forever. Once that daemon stopped or crashed, every remaining MCP
// tool call and hook in the Claude Code session failed with "server is not
// running and could not be auto-started" — even though spawning it again would
// have worked — and the only cure was to /exit and reopen Claude Code. The
// documented behaviour (CLAUDE.md, docs/driving-the-surface.md) is that the
// client auto-spawns; this pins it.
//
// Its own file on purpose: `node --test` gives each file a fresh process, and
// this test needs an uncontaminated module-level memo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const portfiles = require('../lib/core/portfiles');
const { waitUntil } = require('../test-support/helpers');

// Spawning a real daemon and waiting for it to die are both slow next to an
// in-process assertion, so this file waits on a longer budget than the shared
// default.
const SPAWN = { timeout: 8000, interval: 50 };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the MCP client respawns a daemon that has died mid-session', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-respawn-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-respawn-'));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });

  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(root);

  const cleanup = () => {
    const info = portfiles.readPortfile('server', { root, checkLiveness: false });
    if (info && info.pid) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    try { process.chdir(prevCwd); } catch {}
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  };
  t.after(cleanup);

  const client = require('../lib/mcp/client');

  // First use spawns it.
  const first = await client.get('/api/health');
  assert.ok(first && first.ok, 'auto-spawned on first use');
  const firstPid = portfiles.readPortfile('server', { root }).pid;
  assert.ok(firstPid, 'a portfile was written');

  // The daemon goes away — a crash, an OOM kill, a `claude-web-chat stop`.
  process.kill(firstPid, 'SIGTERM');
  assert.ok(await waitUntil(() => !alive(firstPid), SPAWN), 'the first daemon is gone');

  // The very next tool call must bring one back, not fail for the rest of the session.
  const second = await client.get('/api/health');
  assert.ok(second && second.ok, 'a dead daemon is respawned rather than wedging the session');
  const secondPid = portfiles.readPortfile('server', { root }).pid;
  assert.ok(secondPid && secondPid !== firstPid, 'it really is a new process');
});

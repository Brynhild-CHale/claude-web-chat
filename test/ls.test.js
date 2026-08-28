// `claude-web-chat ls` and `--reap` — the machine inventory and what it is
// allowed to do to other people's processes. Nothing covered either before.
//
// The registry is a USER-scope file that outlives every daemon, so after a
// reboot it is full of pids the OS has handed to unrelated processes. Three
// kinds of row therefore exist and must be told apart:
//
//   dead        the pid is gone           -> a ghost record; clear it, signal nothing
//   unreachable pid alive, port silent    -> could be a wedged daemon, could be a
//                                            stranger who inherited the pid. Print a
//                                            hint. NEVER signal.
//   reachable   a daemon answers as us    -> stop it through the acknowledged
//                                            shutdown path, so its draft is written
//
// The old code got this exactly backwards: it signalled on pid-liveness (so the
// "(not answering)" row — the recycled pid — was the one that got SIGTERM) and
// skipped /api/shutdown entirely (so every reaped project lost its uncommitted
// surface). Both halves are pinned here.
//
// HOME is redirected before the registry module resolves it, so this never reads
// or writes the developer's real ~/.web-chat.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lshome-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const registry = require('../lib/util/registry');
const portfiles = require('../lib/core/portfiles');
const { reap, stopRow } = require('../lib/cli/reap');
const ls = require('../lib/cli/commands/ls');

const DEAD_PID = 2 ** 30;

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-ls-${name}-`));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

function resetRegistry() {
  try { fs.rmSync(path.join(FAKE_HOME, '.web-chat', 'instances.json'), { force: true }); } catch {}
}

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.text = () => lines.join('\n');
  return fn;
}

// A stub daemon: answers /api/health with a pid we choose, and ACKs
// /api/shutdown by removing the portfile and closing — the same observable
// contract the real gracefulShutdown has, without a child process.
function stubDaemon(t, { root, pid, ack = true }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, role: 'server', pid }));
    }
    if (req.url === '/api/shutdown' && req.method === 'POST') {
      if (!ack) { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      // What the daemon's own shutdown does, as far as any caller can see.
      setTimeout(() => {
        try { fs.rmSync(path.join(root, '.web-chat', 'server.json'), { force: true }); } catch {}
        registry.deregisterInstance(root);
      }, 20);
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(() => new Promise((r) => server.close(r)));
      resolve({ server, port });
    });
  });
}

// ─────────────────────────────────────────── classification ────

test('rows(): one honest classification of dead / unreachable / reachable', async (t) => {
  resetRegistry();
  const reachableRoot = project('reachable');
  const silentRoot = project('silent');
  const ghostRoot = project('ghost');

  const daemon = await stubDaemon(t, { root: reachableRoot, pid: process.pid });

  // A live pid on a port nothing listens on. Port 1 is privileged and free here.
  registry.registerInstance({ root: reachableRoot, port: daemon.port, pid: process.pid, title: 'reachable' });
  registry.registerInstance({ root: silentRoot, port: 1, pid: process.pid, title: 'silent' });
  // Last, because registerInstance drops dead-pid others as it writes.
  registry.registerInstance({ root: ghostRoot, port: 5999, pid: DEAD_PID, title: 'ghost' });

  const rows = await registry.rows({ timeoutMs: 300 });
  const by = Object.fromEntries(rows.map((r) => [r.title, r]));

  assert.equal(rows.length, 3, 'the ghost is REPORTED, not silently pruned away');
  assert.deepEqual(
    { pid_alive: by.ghost.pid_alive, reachable: by.ghost.reachable },
    { pid_alive: false, reachable: false },
  );
  assert.deepEqual(
    { pid_alive: by.silent.pid_alive, reachable: by.silent.reachable },
    { pid_alive: true, reachable: false },
    'pid alive, nothing answering — the recycled-pid shape',
  );
  assert.deepEqual(
    { pid_alive: by.reachable.pid_alive, reachable: by.reachable.reachable },
    { pid_alive: true, reachable: true },
  );
  assert.equal('live' in by.ghost, false, 'the always-true `live` field is gone');
});

test('rows(): the hub entry is never listed as an instance', async () => {
  resetRegistry();
  const root = project('withhub');
  registry.registerInstance({ root, port: 1, pid: process.pid, title: 'inst' });
  registry.registerHub({ port: 5170, pid: process.pid });
  const rows = await registry.rows({ probe: false });
  assert.deepEqual(rows.map((r) => r.title), ['inst']);
});

test('ls prints the stale annotation for a row that really is stale', async (t) => {
  resetRegistry();
  const ghostRoot = project('lsghost');
  registry.registerInstance({ root: ghostRoot, port: 5999, pid: DEAD_PID, title: 'ghost' });
  const log = sink();
  await ls([], { log, here: null });
  assert.match(log.text(), /\(dead — registry entry is stale\)/,
    'a branch that could never print before readAllEntries existed');
  assert.match(log.text(), /1 stale entry — clear with/);
});

// ─────────────────────────────────────────────────── reaping ────

test('--reap stops only the row that ANSWERS as the pid we listed', async (t) => {
  resetRegistry();
  const reachableRoot = project('r-reachable');
  const silentRoot = project('r-silent');
  const ghostRoot = project('r-ghost');

  const daemon = await stubDaemon(t, { root: reachableRoot, pid: process.pid });
  portfiles.writePortfile('server', { root: reachableRoot, pid: process.pid, port: daemon.port });
  // The silent row's portfile names a LIVE pid: if anything unlinked it blindly,
  // this is the record that would disappear.
  portfiles.writePortfile('server', { root: silentRoot, pid: process.pid, port: 1 });

  registry.registerInstance({ root: reachableRoot, port: daemon.port, pid: process.pid, title: 'reachable' });
  registry.registerInstance({ root: silentRoot, port: 1, pid: process.pid, title: 'silent' });
  registry.registerInstance({ root: ghostRoot, port: 5999, pid: DEAD_PID, title: 'ghost' });

  const rows = await registry.rows({ timeoutMs: 300 });
  const log = sink();
  const out = await reap(rows, { here: null, log, ackWaitMs: 2000, signalWaitMs: 500 });

  assert.equal(out.stopped, 1, 'exactly the reachable row was stopped');
  assert.equal(out.cleared, 1, 'exactly the ghost record was cleared');
  assert.deepEqual(out.skipped.map((s) => [s.row.title, s.reason]), [['silent', 'unreachable']]);

  // The stop went through the ACK path, not a signal — that is what writes draft.json.
  assert.match(log.text(), /stopped cleanly/);
  assert.doesNotMatch(log.text(), /SIGTERM/);
  // The unreachable row is reported with its pid and a kill hint, and untouched.
  assert.match(log.text(), /kill \d+/);
  assert.ok(portfiles.readPortfile('server', { root: silentRoot, checkLiveness: false }),
    "the unreachable row's portfile is left alone");
  assert.ok(registry.readAllEntries().some((e) => e.title === 'silent'),
    "and so is its registry entry");
  assert.equal(registry.readAllEntries().some((e) => e.title === 'ghost'), false,
    'the ghost entry is gone from ~/.web-chat/instances.json, not just from a portfile');
});

test('--reap never touches the project you are standing in', async (t) => {
  resetRegistry();
  const here = project('r-here');
  const daemon = await stubDaemon(t, { root: here, pid: process.pid });
  portfiles.writePortfile('server', { root: here, pid: process.pid, port: daemon.port });
  registry.registerInstance({ root: here, port: daemon.port, pid: process.pid, title: 'here' });

  const rows = await registry.rows({ timeoutMs: 300 });
  const out = await reap(rows, { here, log: sink(), ackWaitMs: 2000 });
  assert.deepEqual({ stopped: out.stopped, cleared: out.cleared }, { stopped: 0, cleared: 0 });
  assert.ok(portfiles.readPortfile('server', { root: here }));
});

test('stopRow refuses a reachable row whose daemon reports a DIFFERENT pid', async (t) => {
  resetRegistry();
  const root = project('r-identity');
  // The port answers, but as somebody else — a restarted daemon, or an unrelated
  // server that took the port. The registry entry is out of date.
  const daemon = await stubDaemon(t, { root, pid: process.pid + 1 });
  portfiles.writePortfile('server', { root, pid: process.pid, port: daemon.port });
  registry.registerInstance({ root, port: daemon.port, pid: process.pid, title: 'identity' });

  const rows = await registry.rows({ timeoutMs: 300 });
  const res = await stopRow(rows[0], { ackWaitMs: 1000 });
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'identity' });
  assert.ok(portfiles.readPortfile('server', { root, checkLiveness: false }), 'nothing removed');
});

test('stopRow refuses an unreachable row outright, without probing identity', async () => {
  const res = await stopRow({ root: '/nope', port: 1, pid: process.pid, pid_alive: true, reachable: false });
  assert.deepEqual({ ok: res.ok, reason: res.reason, pid: res.pid },
    { ok: false, reason: 'unreachable', pid: process.pid });
});

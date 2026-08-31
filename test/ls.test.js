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
const { spawn } = require('child_process');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lshome-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const registry = require('../lib/util/registry');
const portfiles = require('../lib/core/portfiles');
const { reap, stopRow } = require('../lib/cli/reap');
const ls = require('../lib/cli/commands/ls');

const DEAD_PID = 2 ** 30;

// Everything this file makes under os.tmpdir() goes away with the process — the
// fake HOME included, since nothing outside it may be left holding a registry.
const MADE = [FAKE_HOME];
process.on('exit', () => {
  for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wc-ls-${name}-`));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  MADE.push(dir);
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
//
// `drain:true` is the correctly-behaving daemon that is simply SLOW: it
// acknowledges and then never drops its portfile within the caller's budget,
// which is what a live turn holding the graph lock looks like from out here.
function stubDaemon(t, { root, pid, ack = true, drain = false }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, role: 'server', pid }));
    }
    if (req.url === '/api/shutdown' && req.method === 'POST') {
      if (!ack) { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      if (drain) return; // acknowledged, still working
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

// A real, innocent process to hang the records off, so a stray SIGTERM is
// OBSERVABLE rather than theoretical: node's default SIGTERM handler exits, so
// if anything signals this pid the liveness assertion below fails.
function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child;
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

// The whole point of asking instead of signalling: a daemon mid-turn holds the
// graph lock for up to 30s inside gracefulShutdown, and the reap budget is 5s.
// If the expiry escalated to SIGTERM, the signal handler would find
// `shuttingDown` already true and process.exit() before writeDraft — destroying
// exactly the draft the /api/shutdown ask exists to preserve. The budget is
// OURS; it is not evidence about the daemon.
test('--reap leaves an acknowledged-but-still-draining daemon alone rather than SIGTERMing it', async (t) => {
  resetRegistry();
  const root = project('r-draining');
  const innocent = bystander(t);
  const daemon = await stubDaemon(t, { root, pid: innocent.pid, drain: true });
  portfiles.writePortfile('server', { root, pid: innocent.pid, port: daemon.port });
  registry.registerInstance({ root, port: daemon.port, pid: innocent.pid, title: 'draining' });

  const rows = await registry.rows({ timeoutMs: 300 });
  const log = sink();
  const out = await reap(rows, { here: null, log, ackWaitMs: 600, signalWaitMs: 300 });

  assert.equal(out.stopped, 0, 'a daemon still draining was not stopped, and is not reported as stopped');
  assert.deepEqual(out.skipped.map((s) => [s.row.title, s.reason]), [['draining', 'draining']]);
  assert.doesNotMatch(log.text(), /SIGTERM/, 'nothing escalated');
  assert.match(log.text(), /still draining/);
  assert.equal(portfiles.isPidAlive(innocent.pid), true,
    'the daemon pid was never signalled — a SIGTERM would have killed this process');
  assert.ok(portfiles.readPortfile('server', { root, checkLiveness: false }),
    'and its portfile is left where it is: the daemon removes it when it finishes');
});

// stop() answers `{ok:true, path:'none'}` for a root with no live portfile.
// It is true that nothing was stopped, but it is not a stopped surface — the
// daemon answered as this pid moments ago and is still up.
test('--reap does not count a row it could not even ask as stopped', async (t) => {
  resetRegistry();
  const root = project('r-noportfile');
  const daemon = await stubDaemon(t, { root, pid: process.pid });
  // No writePortfile: the record `stop` reads is missing.
  registry.registerInstance({ root, port: daemon.port, pid: process.pid, title: 'noportfile' });

  const rows = await registry.rows({ timeoutMs: 300 });
  const log = sink();
  const out = await reap(rows, { here: null, log, ackWaitMs: 600 });

  assert.equal(out.stopped, 0);
  assert.deepEqual(out.skipped.map((s) => [s.row.title, s.reason]), [['noportfile', 'no-portfile']]);
  assert.match(log.text(), /no portfile/);
  assert.ok(registry.readAllEntries().some((e) => e.title === 'noportfile'),
    'and the entry it left behind is still listed, so the next `ls` still shows it');
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

// A registry entry with no `root`. registerInstance always writes one, so this
// is a hand-edited or legacy record — but `ls` kept printing it forever with the
// "--reap clears" hint and --reap could never clear it: release({root:null})
// went to instanceId(null) -> path.resolve(null), which throws
// ERR_INVALID_ARG_TYPE into release()'s own catch, and to a deletePortfile that
// resolved the null root to process.cwd() — reaching for the records of the
// project the user is standing in.
test('--reap clears a ghost registry entry that names no project root', async () => {
  resetRegistry();
  const file = path.join(FAKE_HOME, '.web-chat', 'instances.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    instances: [{ id: 'deadbeef', role: 'instance', title: 'rootless', port: 5999, pid: DEAD_PID }],
  }));

  const rows = await registry.rows({ timeoutMs: 300 });
  assert.equal(rows.length, 1, 'the row is listed (that is why it needs clearing)');

  const out = await reap(rows, { here: null, log: sink(), ackWaitMs: 600 });
  assert.equal(out.cleared, 1, 'the ghost was cleared by the id it carries');
  assert.deepEqual(registry.readAllEntries(), [], 'and is gone from the registry for good');
});

// The same rootless entry with a LIVE pid may not be acted on at all: stop()
// resolves a null root to process.cwd() too, so acting on it would ask the
// daemon of whatever project the user happens to be standing in to shut down.
test('--reap refuses to act on a rootless row whose pid is alive', async () => {
  resetRegistry();
  const file = path.join(FAKE_HOME, '.web-chat', 'instances.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    instances: [{ id: 'deadbeef', role: 'instance', title: 'rootless-live', port: 1, pid: process.pid }],
  }));

  const rows = await registry.rows({ timeoutMs: 300 });
  const log = sink();
  const out = await reap(rows, { here: null, log, ackWaitMs: 600 });

  assert.deepEqual({ stopped: out.stopped, cleared: out.cleared }, { stopped: 0, cleared: 0 });
  assert.deepEqual(out.skipped.map((s) => [s.row.title, s.reason]), [['rootless-live', 'no-root']]);
  assert.match(log.text(), /names no project root/);
  assert.equal(registry.readAllEntries().length, 1, 'and the entry is left where it is');
});

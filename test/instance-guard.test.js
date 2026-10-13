// The instance guard (U106; design/tools/t567-inputs/lifecycle-bugs.md bugs 1
// and 2, the daemon's half). A running daemon looked at its portfile and its
// .web-chat/ once, at boot: a deleted portfile stayed deleted, two daemons on
// one root both kept writing it, and a daemon whose .web-chat/ the user removed
// re-created it. lib/server/instance-guard looks again every 5 s: re-writes a
// vanished portfile (and a missing registry entry), and hands the caller
// 'orphan' or 'state-removed', on which lib/cli/commands/start.js ends the
// process without writing anything into the project (ruled A6 (b)).
//
// Every guard here is constructed directly on a temp root with an injected
// probeHealth, under a per-test sandbox HOME (withTempHome), so no port in the
// 5173.. range is probed and no real registry is touched. The one subprocess
// case runs a real foreground `start` (it port-walks from 5173 like any start,
// as test/one-daemon.test.js's does) against a stand-in hub on a port this file
// opened, and kills it on the way out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const { withTempHome, waitUntil } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { projectPaths } = require('../lib/core/paths');
const { writePortfile, isPidAlive } = require('../lib/core/portfiles');
const { PROTOCOL_VERSION } = require('../lib/core/versions');
const { LISTEN_HOST } = require('../lib/core/cors');
const { CLI_BIN } = require('../lib/util/daemon');
const { createInstanceGuard, describeExit, GUARD_INTERVAL_MS } = require('../lib/server/instance-guard');
const start = require('../lib/cli/commands/start');

// A realpath'd project root with its .web-chat/ (the instance id is a hash of
// the root string, and a subprocess's cwd reads back as the realpath).
function projectRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-instance-guard-')));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A pid that is certainly not running: a child that has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// A live process that is not this one.
function otherLivePid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child.pid;
}

function readPf(root) {
  try { return JSON.parse(fs.readFileSync(projectPaths(root).serverJson, 'utf8')); } catch { return null; }
}

function entriesFor(root) {
  return registry.readAllEntries().filter((e) => e.id === registry.instanceId(root));
}

// A guard with spies on every way out.
function guardFor(t, root, opts = {}) {
  const exits = [];
  const lines = [];
  const probed = [];
  const guard = createInstanceGuard({
    root,
    pid: process.pid,
    port: 45001,
    probeHealth: async (port) => { probed.push(port); return null; },
    onExit: (reason, info) => exits.push({ reason, info }),
    log: (m) => lines.push(m),
    ...opts,
  });
  t.after(() => guard.stop());
  return { guard, exits, lines, probed };
}

test('the cadence is the ruled 5 s (U106@cadence, A-defaults (a))', () => {
  assert.equal(GUARD_INTERVAL_MS, 5000);
});

// ── (c): a portfile nobody owns is put back ────────────────────────────────

test('portfile deleted → one pass re-writes it naming this pid and port', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  writePortfile('server', { root, pid: process.pid, port: 45001 });
  const { guard, exits, lines } = guardFor(t, root);
  guard.start();
  fs.rmSync(projectPaths(root).serverJson);

  assert.equal(await guard.check(), 'rewrote');
  const pf = readPf(root);
  assert.equal(pf.pid, process.pid);
  assert.equal(pf.port, 45001);
  assert.deepEqual(exits, []);
  assert.ok(lines.some((l) => /re-wrote the portfile .*missing or unreadable/.test(l)), lines.join('\n'));
  // And the next pass finds it mine: nothing more to do.
  assert.equal(await guard.check(), 'ok');
});

test('an unreadable portfile is re-written', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const { guard } = guardFor(t, root);
  guard.start();
  fs.writeFileSync(projectPaths(root).serverJson, '{ torn');
  assert.equal(await guard.check(), 'rewrote');
  assert.equal(readPf(root).pid, process.pid);
});

test('a portfile naming a dead pid → re-written', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const dead = deadPid();
  writePortfile('server', { root, pid: dead, port: 45999 });
  const { guard, exits, probed, lines } = guardFor(t, root);
  guard.start();

  assert.equal(await guard.check(), 'rewrote');
  assert.deepEqual([readPf(root).pid, readPf(root).port], [process.pid, 45001]);
  assert.deepEqual(probed, [], 'a dead pid is not probed');
  assert.deepEqual(exits, []);
  assert.ok(lines.some((l) => l.includes(`it named pid ${dead}, not running`)), lines.join('\n'));
});

test('registry entry missing → re-registered (sandbox HOME)', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  writePortfile('server', { root, pid: process.pid, port: 45001 });
  assert.deepEqual(entriesFor(root), []);
  const { guard } = guardFor(t, root);
  guard.start();

  assert.equal(await guard.check(), 're-registered');
  const mine = entriesFor(root);
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].pid, mine[0].port, mine[0].root], [process.pid, 45001, root]);
  assert.equal(await guard.check(), 'ok', 'registered once, not every pass');
});

test('a registry entry naming a dead pid is replaced when the portfile is re-written', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  // registerInstance prunes dead entries of OTHER ids only, so this one stays.
  registry.registerInstance({ root, port: 45999, pid: deadPid() });
  const { guard } = guardFor(t, root);
  guard.start();
  assert.equal(await guard.check(), 'rewrote');
  const mine = entriesFor(root);
  assert.deepEqual(mine.map((e) => [e.pid, e.port]), [[process.pid, 45001]]);
});

test('a registry entry naming another LIVE pid is left alone', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const other = otherLivePid(t);
  writePortfile('server', { root, pid: process.pid, port: 45001 });
  registry.registerInstance({ root, port: 45777, pid: other });
  const { guard } = guardFor(t, root);
  guard.start();
  assert.equal(await guard.check(), 'ok');
  assert.deepEqual(entriesFor(root).map((e) => e.pid), [other]);
});

// Rule (c)'s two last-moment checks, between the read that found the portfile
// unowned and the write: a file that appeared meanwhile is never written over,
// and a .web-chat/ that went meanwhile is not re-created by the write. The guard
// reads through the portfiles module object, so the test steps in at the read.
function interceptReads(t, onCall) {
  const pf = require('../lib/core/portfiles');
  const real = pf.readPortfile;
  let n = 0;
  pf.readPortfile = (...args) => { n++; onCall(n); return real(...args); };
  t.after(() => { pf.readPortfile = real; });
}

test('a portfile that appears between the read and the write is not written over', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const other = otherLivePid(t);
  const { guard, exits, probed } = guardFor(t, root);
  guard.start();
  // The first read finds no portfile; another daemon's lands before the re-read.
  interceptReads(t, (n) => { if (n === 2) writePortfile('server', { root, pid: other, port: 45030 }); });

  assert.equal(await guard.check(), 'raced');
  assert.deepEqual([readPf(root).pid, readPf(root).port], [other, 45030]);
  assert.deepEqual(exits, []);
  assert.deepEqual(probed, []);
});

test('a .web-chat/ removed between the read and the write → state-removed, and the write does not re-create it', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const { dir } = projectPaths(root);
  const { guard, exits } = guardFor(t, root);
  guard.start();
  interceptReads(t, (n) => { if (n === 2) fs.rmSync(dir, { recursive: true, force: true }); });

  assert.equal(await guard.check(), 'state-removed');
  assert.deepEqual(exits, [{ reason: 'state-removed', info: { dir, recreated: false } }]);
  assert.equal(fs.existsSync(dir), false, 'the portfile write did not re-create the folder');
});

// ── (d): another live pid owns the portfile ────────────────────────────────

test('a portfile naming another pid whose health answers with that pid and this instance → onExit(orphan), file untouched', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const other = otherLivePid(t);
  writePortfile('server', { root, pid: other, port: 45002 });
  const before = fs.readFileSync(projectPaths(root).serverJson, 'utf8');
  const { guard, exits, probed } = guardFor(t, root, {
    probeHealth: async (port) => {
      probed.push(port);
      return port === 45002 ? { ok: true, role: 'instance', pid: other, instance: registry.instanceId(root) } : null;
    },
  });
  guard.start();

  assert.equal(await guard.check(), 'orphan');
  assert.deepEqual(probed, [45002]);
  assert.deepEqual(exits, [{ reason: 'orphan', info: { other: { pid: other, port: 45002 } } }]);
  assert.equal(fs.readFileSync(projectPaths(root).serverJson, 'utf8'), before);
  assert.equal(guard.running, false, 'the guard stops itself on exit');
  assert.equal(await guard.check(), 'exited', 'onExit is called once');
  assert.equal(exits.length, 1);
});

test('a portfile naming another live pid whose health does not answer → no exit, file untouched', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const other = otherLivePid(t);
  writePortfile('server', { root, pid: other, port: 45003 });
  const before = fs.readFileSync(projectPaths(root).serverJson, 'utf8');
  const { guard, exits, lines } = guardFor(t, root); // probeHealth → null
  guard.start();

  assert.equal(await guard.check(), 'unconfirmed');
  assert.equal(await guard.check(), 'unconfirmed');
  assert.deepEqual(exits, []);
  assert.equal(fs.readFileSync(projectPaths(root).serverJson, 'utf8'), before);
  assert.equal(lines.filter((l) => /did not answer for this project/.test(l)).length, 1, 'said once, not every pass');
});

test('an answer for another pid, or another project, is no proof either', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const other = otherLivePid(t);
  writePortfile('server', { root, pid: other, port: 45004 });
  const answers = [
    { ok: true, role: 'instance', pid: other + 1, instance: registry.instanceId(root) }, // a port now held by someone else
    { ok: true, role: 'instance', pid: other, instance: 'deadbeef' },                     // another project's daemon
    { ok: true, role: 'instance', pid: other },                                           // a build that names no instance
    { ok: true, role: 'hub', pid: other, instance: registry.instanceId(root) },
  ];
  for (const a of answers) {
    const { guard, exits } = guardFor(t, root, { probeHealth: async () => a });
    assert.equal(await guard.check(), 'unconfirmed', JSON.stringify(a));
    assert.deepEqual(exits, []);
  }
  assert.equal(readPf(root).pid, other);
});

// ── (a): the state directory went ──────────────────────────────────────────

test('.web-chat/ removed → onExit(state-removed), and the guard re-creates nothing', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  writePortfile('server', { root, pid: process.pid, port: 45001 });
  const { guard, exits } = guardFor(t, root);
  guard.start();
  fs.rmSync(projectPaths(root).dir, { recursive: true, force: true });

  assert.equal(await guard.check(), 'state-removed');
  assert.deepEqual(exits, [{ reason: 'state-removed', info: { dir: projectPaths(root).dir, recreated: false } }]);
  assert.equal(fs.existsSync(projectPaths(root).dir), false, 'the directory is not re-created');
  assert.deepEqual(entriesFor(root), [], 'and the registry is not written for it');
});

test('.web-chat/ removed and re-created (a new inode) → onExit(state-removed), nothing written into it', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const { dir } = projectPaths(root);
  writePortfile('server', { root, pid: process.pid, port: 45001 });
  const { guard, exits } = guardFor(t, root);
  guard.start();
  // A fresh directory made while the old one still exists cannot share its
  // inode; it takes the old one's place.
  const fresh = `${dir}-fresh`;
  fs.mkdirSync(fresh);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(fresh, dir);

  assert.equal(await guard.check(), 'state-removed');
  assert.deepEqual(exits, [{ reason: 'state-removed', info: { dir, recreated: true } }]);
  assert.deepEqual(fs.readdirSync(dir), [], 'no portfile (or anything else) written into the new folder');
  assert.match(describeExit('state-removed', exits[0].info), /re-created since \(left on disk, not deleted\)/);
});

test('a stopped guard does nothing, and its timer passes at the interval while running', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const { guard: idle } = guardFor(t, root, { intervalMs: 20 });
  idle.start();
  idle.stop();
  assert.equal(await idle.check(), 'stopped');
  assert.equal(readPf(root), null, 'a stopped guard writes nothing');

  const { guard } = guardFor(t, root, { intervalMs: 20 });
  guard.start();
  assert.ok(guard.running);
  await waitUntil(() => readPf(root), { timeout: 2000, what: 'a timer pass to re-write the portfile' });
  assert.equal(readPf(root).pid, process.pid);
});

// ── two daemons on one root ────────────────────────────────────────────────

test('two daemons on one root: the orphan exits, the owner does nothing, and the orphan\'s release keeps the owner\'s records', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const B = process.pid;            // the daemon that owns the records — alive
  const A = deadPid();              // the orphan: neither B nor alive
  assert.ok(A !== B && !isPidAlive(A));
  const PA = 45010;
  const PB = 45011;
  const id = registry.instanceId(root);
  writePortfile('server', { root, pid: B, port: PB });
  registry.registerInstance({ root, port: PB, pid: B });
  const probeHealth = async (port) => (port === PB ? { ok: true, role: 'instance', pid: B, instance: id } : null);

  const a = guardFor(t, root, { pid: A, port: PA, intervalMs: 100, probeHealth });
  const b = guardFor(t, root, { pid: B, port: PB, intervalMs: 100, probeHealth });
  a.guard.start();
  b.guard.start();
  await waitUntil(() => a.exits.length > 0, { timeout: 3000, what: "A's guard to call onExit" });
  await new Promise((r) => setTimeout(r, 250)); // two more of B's passes

  assert.deepEqual(a.exits, [{ reason: 'orphan', info: { other: { pid: B, port: PB } } }]);
  assert.deepEqual(b.exits, [], "B's guard matched rule (b)");
  assert.equal(readPf(root).pid, B);

  // A's way out (start.js): stop the services, release its records pid-guarded,
  // one line, exit 0 — never a graceful shutdown.
  const calls = [];
  const srv = {
    services: { stopAll: () => calls.push('stopAll') },
    gracefulShutdown: () => calls.push('gracefulShutdown'),
    stop: () => calls.push('stop'),
  };
  start.exitWithoutWriting(srv, {
    root, reason: 'orphan', info: a.exits[0].info, pid: A,
    log: (m) => calls.push(m), exit: (c) => calls.push(`exit ${c}`),
  });
  assert.deepEqual(calls, ['stopAll', describeExit('orphan', a.exits[0].info), 'exit 0']);
  assert.match(calls[1], new RegExp(`another daemon \\(pid ${B}, port ${PB}\\)`));
  assert.deepEqual([readPf(root).pid, readPf(root).port], [B, PB], "B's portfile stays");
  assert.deepEqual(entriesFor(root).map((e) => [e.pid, e.port]), [[B, PB]], "B's registry entry stays");
});

// ── the wiring in start.js ─────────────────────────────────────────────────

test('foreground start arms the guard after the server starts, stops it on a signal, and its onExit leaves without writing', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  writePortfile('server', { root, pid: process.pid, port: 45020 });
  registry.registerInstance({ root, port: 45020, pid: process.pid });
  const calls = [];
  const made = [];
  const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  t.after(() => {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.off(sig, l);
    }
  });
  await start([], {
    root,
    daemonFor: async () => null,
    errlog: (m) => calls.push(m),
    exit: (c) => calls.push(`exit ${c}`),
    createServer: () => ({
      start: async () => { calls.push('srv.start'); return { port: 45020 }; },
      installSignalHandlers: () => calls.push('signals'),
      services: { stopAll: () => calls.push('stopAll') },
      gracefulShutdown: () => calls.push('gracefulShutdown'),
      stop: () => calls.push('stop'),
    }),
    createInstanceGuard: (opts) => {
      made.push(opts);
      calls.push('guard.create');
      return { start: () => calls.push('guard.start'), stop: () => calls.push('guard.stop') };
    },
  });
  assert.deepEqual(calls, ['srv.start', 'guard.create', 'signals', 'guard.start']);
  assert.equal(made[0].root, root);
  assert.equal(made[0].port, 45020);

  const added = process.listeners('SIGTERM').filter((l) => !before.SIGTERM.includes(l));
  assert.equal(added.length, 1, 'one SIGTERM listener, registered before the server\'s own');
  calls.length = 0;
  added[0]();
  assert.deepEqual(calls, ['guard.stop']);

  calls.length = 0;
  made[0].onExit('state-removed', { dir: projectPaths(root).dir, recreated: false });
  assert.deepEqual(calls, ['stopAll', describeExit('state-removed', { dir: projectPaths(root).dir, recreated: false }), 'exit 0']);
  assert.equal(readPf(root), null, 'this daemon\'s own portfile is released');
  assert.deepEqual(entriesFor(root), [], 'and its registry entry');
});

test('a stand-in server that reports no port gets no guard', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  let made = 0;
  await start([], {
    root,
    daemonFor: async () => null,
    createServer: () => ({ start: async () => {}, installSignalHandlers: () => {} }),
    createInstanceGuard: () => { made++; return { start() {}, stop() {} }; },
  });
  assert.equal(made, 0);
});

// ── a real foreground `start`, at the default cadence ──────────────────────

// A stand-in capture hub on a port this file opened: a booting daemon calls
// ensureHub(), which would otherwise probe — and could bounce — the machine's
// real hub. This answers as a CURRENT hub, so nothing is spawned.
async function fakeHub(t) {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, role: 'hub', version: PROTOCOL_VERSION, pid: process.pid }));
  });
  await new Promise((r) => srv.listen(0, LISTEN_HOST, r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return srv.address().port;
}

test('a foreground `start` whose .web-chat/ is deleted exits 0 within 12 s and writes no draft.json', async (t) => {
  withTempHome(t); // the child inherits this HOME
  const root = projectRoot(t);
  const hubPort = await fakeHub(t);
  const child = spawn(process.execPath, [CLI_BIN, 'start'], {
    cwd: root,
    env: { ...process.env, WEB_CHAT_HUB_PORT: String(hubPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { stdout: '', stderr: '', code: undefined };
  child.stdout.on('data', (d) => { run.stdout += d; });
  child.stderr.on('data', (d) => { run.stderr += d; });
  const exited = new Promise((r) => child.on('exit', (code) => { run.code = code; r(code); }));
  t.after(() => { if (run.code === undefined) { try { child.kill('SIGKILL'); } catch {} } });

  const port = await waitUntil(() => {
    const m = /listening on http:\/\/localhost:(\d+)/.exec(run.stdout);
    return m ? Number(m[1]) : (run.code !== undefined ? -1 : null);
  }, { timeout: 15000, interval: 50, what: 'the daemon to listen' });
  assert.ok(port > 0, `start exited early (${run.code}): stdout=${run.stdout} stderr=${run.stderr}`);

  const { dir, draft } = projectPaths(root);
  fs.rmSync(dir, { recursive: true, force: true });
  const deletedAt = Date.now();

  let timer;
  const how = await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => r('timeout'), 12000); })]);
  clearTimeout(timer);
  assert.notEqual(how, 'timeout', `still running 12 s after .web-chat/ went; stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(run.code, 0, `stderr=${run.stderr}`);
  assert.ok(Date.now() - deletedAt <= 12000);
  assert.match(run.stderr, /\.web-chat was removed.* this daemon stops without writing into the project/);
  // The directory may exist again only if one of the daemon's writers re-created
  // it before the pass noticed — and then it holds no draft.json.
  assert.equal(fs.existsSync(draft), false, 'no draft.json');
  assert.deepEqual(entriesFor(root), [], 'its registry entry is released');
});

// `stop` reaches every daemon rooted at the project, and `uninstall` stops it
// (U107; design/tools/t567-inputs/lifecycle-bugs.md bugs 1 and 2). `stop` used
// to address only the daemon its portfile named, so a daemon whose portfile went
// with a deleted .web-chat/ — and the duplicate a later spawn started beside it —
// kept running, and `uninstall` stopped nothing at all. lib/util/registry
// daemonsFor finds them all: the portfile's, the registry's, and (asked for)
// every port of the scan range whose /api/health names this root's instance; a
// daemon that answers with no instance (a build before 0.8.5) is only named,
// with a kill hint.
//
// Every port a case probes is one this file opened — the scan range is always
// injected — so nothing here probes 5173..5272, where the maintainer's own
// daemons listen. (The `start` subprocess binds by walking up from 5173 itself,
// as test/one-daemon.test.js's subprocess case does; this file never probes
// those ports.) Every registry write goes to a per-test sandbox HOME.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { withServer, withTempHome, waitUntil } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { projectPaths } = require('../lib/core/paths');
const { isPidAlive } = require('../lib/core/portfiles');
const { PROTOCOL_VERSION } = require('../lib/core/versions');
const { LISTEN_HOST } = require('../lib/core/cors');
const { CLI_BIN } = require('../lib/util/daemon');
const stop = require('../lib/cli/commands/stop');
const uninstall = require('../lib/cli/commands/uninstall');

// A realpath'd project root: a subprocess's cwd reads back as the realpath
// (/private/var/… on macOS), and the instance id is a hash of the root string.
function projectRoot(t, prefix = 'wc-every-daemon-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.text = () => lines.join('\n');
  return fn;
}

// A real, innocent process: a pid a stub can answer for, so a stray SIGTERM is
// observable (node's default handler exits) and a wait on the pid can end.
function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return { child, pid: child.pid, exited };
}

// An HTTP server on a loopback port this file opened, answering /api/health
// with `health` and recording every /api/shutdown. With `onShutdown`, it
// acknowledges and then runs it (what a daemon's own exit does).
async function stubServer(t, { health, onShutdown = null }) {
  const seen = { shutdowns: 0 };
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify(health));
    if (req.url === '/api/shutdown' && req.method === 'POST') {
      seen.shutdowns++;
      if (!onShutdown) { res.statusCode = 500; return res.end('{}'); }
      res.end(JSON.stringify({ ok: true }));
      setTimeout(onShutdown, 20);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, LISTEN_HOST, r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  seen.port = srv.address().port;
  return seen;
}

// A daemon of a build before 0.8.5, as the scan sees it: a web-chat instance
// health with no `instance`.
function oldBuildHealth(pid) {
  return { ok: true, role: 'instance', version: PROTOCOL_VERSION, package_version: '0.8.2', pid, active: null, nodes: 0 };
}

// ── the real daemon, found by the scan alone ───────────────────────────────

// A stand-in capture hub on a port this file opened: a booting daemon calls
// ensureHub(), which would otherwise probe — and could bounce — the machine's
// real hub on 5170. This answers as a CURRENT hub, so nothing is spawned.
async function fakeHub(t) {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, role: 'hub', version: PROTOCOL_VERSION, pid: process.pid }));
  });
  await new Promise((r) => srv.listen(0, LISTEN_HOST, r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return srv.address().port;
}

test('stop with the scan reaches a `start` daemon that is in neither the portfile nor the registry, and it exits', async (t) => {
  withTempHome(t); // the child inherits it
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
  t.after(async () => {
    if (run.code !== undefined) return;
    try { child.kill('SIGKILL'); } catch {}
    await exited;
  });

  const port = await waitUntil(() => {
    const m = /listening on http:\/\/localhost:(\d+)/.exec(run.stdout);
    return m ? Number(m[1]) : (run.code !== undefined ? -1 : null);
  }, { timeout: 15000, interval: 50, what: 'the daemon to listen' });
  assert.ok(port > 0, `start exited early (${run.code}): stdout=${run.stdout} stderr=${run.stderr}`);
  await waitUntil(() => fs.existsSync(projectPaths(root).serverJson)
    && registry.readAllEntries().some((e) => e.id === registry.instanceId(root)), { timeout: 5000, what: 'both records' });

  // What deleting .web-chat/ under it (and a second start replacing its entry)
  // left: a live daemon no record names.
  fs.rmSync(projectPaths(root).serverJson, { force: true });
  assert.ok(registry.deregisterInstance(root), 'its registry entry removed by hand');
  assert.equal(await registry.daemonFor(root), null, 'no record finds it any more');

  const log = sink();
  const out = await stop([], { root, scan: true, scanPorts: [port], log, ackWaitMs: 20_000 });
  assert.equal(out.path, 'request', log.text());
  assert.equal(out.ok, true, log.text());
  assert.equal(out.pid, child.pid);
  assert.match(log.text(), new RegExp(`stopped cleanly \\(pid ${child.pid} on port ${port}, found by the port scan\\)`));
  assert.doesNotMatch(log.text(), /SIGTERM/);
  // The wait was on the pid: by the time stop() returned, the process was gone.
  assert.equal(isPidAlive(child.pid), false, 'the daemon process has exited');
  await exited;
});

// ── daemonsFor ──────────────────────────────────────────────────────────────

test('daemonsFor with the scan finds a daemon in no record by its instance, and ignores another project\'s', async (t) => {
  const mine = await withServer(t, { root: projectRoot(t) });
  const other = await withServer(t, { root: projectRoot(t, 'wc-every-daemon-other-') });
  // withServer on an ephemeral port writes neither record.
  assert.equal(fs.existsSync(projectPaths(mine.root).serverJson), false);
  assert.equal(await registry.daemonFor(mine.root), null);

  const found = await registry.daemonsFor(mine.root, { scan: true, ports: [other.port, mine.port] });
  assert.deepEqual(found.daemons, [{ pid: process.pid, port: mine.port, url: `http://localhost:${mine.port}`, source: 'scan' }]);
  assert.deepEqual(found.unknown, [], 'a daemon naming another instance is neither this root\'s nor unknown');

  const none = await registry.daemonsFor(mine.root, { ports: [mine.port] });
  assert.deepEqual(none, { daemons: [], unknown: [] }, 'without `scan` no port is probed');
});

test('daemonsFor: the portfile and the registry are read first, and a pid is listed once', async (t) => {
  const ctx = await withServer(t, { root: projectRoot(t), writePortfile: true });
  registry.registerInstance({ root: ctx.root, port: ctx.port, pid: process.pid });
  const found = await registry.daemonsFor(ctx.root, { scan: true, ports: [ctx.port] });
  assert.deepEqual(found.daemons.map((d) => [d.pid, d.port, d.source]), [[process.pid, ctx.port, 'portfile']]);
});

test('daemonsFor returns a web-chat health with no instance as unknown, and `stop` names it with a kill hint and signals nothing', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const innocent = bystander(t);
  const old = await stubServer(t, { health: oldBuildHealth(innocent.pid) });
  // Not web-chat instances: the hub, and a server that is not web-chat at all.
  const hub = await stubServer(t, { health: { ok: true, role: 'hub', pid: innocent.pid } });
  const stranger = await stubServer(t, { health: { hello: 'world' } });
  const ports = [old.port, hub.port, stranger.port];

  const found = await registry.daemonsFor(root, { scan: true, ports });
  assert.deepEqual(found.daemons, []);
  assert.deepEqual(found.unknown, [{ pid: innocent.pid, port: old.port, url: `http://localhost:${old.port}`, package_version: '0.8.2' }]);

  const log = sink();
  const out = await stop([], { root, scan: true, scanPorts: ports, log, signalWaitMs: 300 });
  assert.match(log.text(), new RegExp(`pid ${innocent.pid} on port ${old.port} is a web-chat daemon of an older build; if it is this project's: kill ${innocent.pid}`));
  assert.doesNotMatch(log.text(), /no server running/, 'the hint is the whole answer');
  assert.equal(out.path, 'none');
  assert.deepEqual(out.unknown.map((u) => u.pid), [innocent.pid]);
  assert.equal(old.shutdowns, 0, 'it was not even asked');
  assert.equal(isPidAlive(innocent.pid), true, 'and never signalled');
});

// ── the scan runs only when asked (U107@scan-callers) ──────────────────────

test('stop without deps.scan, as restart and reap call it, makes no probe; with it, exactly the injected range', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const a = await stubServer(t, { health: { ok: false } });
  const b = await stubServer(t, { health: { ok: false } });
  const calls = [];
  const probeHealth = async (port) => { calls.push(port); return null; };

  const quiet = await stop([], { root, log: sink(), probeHealth, scanPorts: [a.port, b.port] });
  assert.deepEqual(quiet, { ok: true, path: 'none', pid: null });
  assert.deepEqual(calls, [], 'no port probed');

  const log = sink();
  const scanned = await stop([], { root, scan: true, log, probeHealth, scanPorts: [a.port, b.port] });
  assert.deepEqual(calls.sort((x, y) => x - y), [a.port, b.port].sort((x, y) => x - y));
  assert.equal(scanned.path, 'none');
  assert.match(log.text(), /no server running/);
});

test('stop with deps.target asks that daemon and waits on its pid; a port answering as another pid is left alone', async (t) => {
  withTempHome(t);
  const root = projectRoot(t);
  const gone = bystander(t);
  const d = await stubServer(t, { health: { ok: true, role: 'instance', pid: gone.pid }, onShutdown: () => gone.child.kill('SIGKILL') });
  const out = await stop([], { root, target: { pid: gone.pid, port: d.port }, log: sink(), ackWaitMs: 3000 });
  assert.deepEqual(out, { ok: true, path: 'request', pid: gone.pid });
  assert.equal(d.shutdowns, 1);
  assert.equal(isPidAlive(gone.pid), false);

  const innocent = bystander(t);
  const imposter = await stubServer(t, { health: { ok: true, role: 'instance', pid: process.pid } });
  const log = sink();
  const refused = await stop([], { root, target: { pid: innocent.pid, port: imposter.port }, log, signalWaitMs: 300 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'identity');
  assert.equal(imposter.shutdowns, 0, 'nothing is asked of a port that answers as someone else');
  assert.match(log.text(), new RegExp(`kill ${innocent.pid}`));
  assert.equal(isPidAlive(innocent.pid), true);
});

// ── uninstall ───────────────────────────────────────────────────────────────

function fakeClaude() {
  const calls = [];
  return { fn: (argv) => { calls.push(argv); return { ok: true }; }, calls };
}

function installedProject(t) {
  const root = projectRoot(t, 'wc-every-daemon-uninst-');
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: ['/x.js'] } } }));
  return root;
}

async function captured(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = prev; }
  return lines.join('\n');
}

// A daemon of this root that only the scan can find: health names the root's
// instance and a bystander's pid, which ends when the shutdown is acknowledged.
async function scanOnlyDaemon(t, root, onShutdown = () => {}) {
  const proc = bystander(t);
  const d = await stubServer(t, {
    health: { ok: true, role: 'instance', pid: proc.pid, instance: registry.instanceId(root) },
    onShutdown: () => { onShutdown(); proc.child.kill('SIGKILL'); },
  });
  d.proc = proc; // the record itself: `shutdowns` counts on it
  return d;
}

test('uninstall stops the project\'s daemon after removing the wiring, and says so', async (t) => {
  withTempHome(t);
  const root = installedProject(t);
  let wiredAtShutdown = null;
  const d = await scanOnlyDaemon(t, root, () => {
    const file = path.join(root, '.mcp.json');
    wiredAtShutdown = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('web-chat');
  });
  const text = await captured(() => uninstall([], { cwd: root, runClaude: fakeClaude().fn, knownRoots: [], scanPorts: [d.port], ackWaitMs: 3000 }));
  assert.equal(d.shutdowns, 1, text);
  assert.equal(wiredAtShutdown, false, 'the wiring was already gone when the daemon was asked to stop');
  assert.ok(text.indexOf('uninstalled from') < text.indexOf('stopped cleanly'), text);
  assert.match(text, /Stopping this project's web-chat daemon/);
  assert.match(text, new RegExp(`stopped cleanly \\(pid ${d.proc.pid} on port ${d.port}, found by the port scan\\)`));
  await d.proc.exited;
});

test('uninstall --keep-running leaves the daemon up and prints the stop command', async (t) => {
  withTempHome(t);
  const root = installedProject(t);
  const d = await scanOnlyDaemon(t, root);
  const text = await captured(() => uninstall(['--keep-running'], { cwd: root, runClaude: fakeClaude().fn, knownRoots: [], scanPorts: [d.port] }));
  assert.equal(d.shutdowns, 0, text);
  assert.equal(isPidAlive(d.proc.pid), true);
  assert.match(text, /--keep-running/);
  assert.match(text, new RegExp(`\`claude-web-chat stop\` in ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /uninstalled from/, 'the wiring is still removed');
});

test('uninstall names the Claude Code sessions still open in the project', async (t) => {
  withTempHome(t);
  const root = installedProject(t);
  registry.registerMcp({ root, pid: process.pid, ppid: process.ppid });
  t.after(() => registry.deregisterMcp({ pid: process.pid }));
  const text = await captured(() => uninstall([], { cwd: root, runClaude: fakeClaude().fn, knownRoots: [], scanPorts: [] }));
  assert.match(text, new RegExp(`1 Claude Code session is still open in this project \\(pid ${process.ppid}\\): their web-chat MCP servers can start the daemon again until those sessions exit`));

  registry.deregisterMcp({ pid: process.pid });
  const after = await captured(() => uninstall([], { cwd: root, runClaude: fakeClaude().fn, knownRoots: [], scanPorts: [] }));
  assert.doesNotMatch(after, /still open in this project/, 'no sessions, no sentence');
});

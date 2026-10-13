// One daemon per project root (U105; design/tools/t567-inputs/lifecycle-bugs.md
// bug 2). Deleting .web-chat/ under a live daemon took its portfile with it, and
// every spawn path read "no portfile" as "no daemon": the next one started a
// second daemon for the same root, which registered under the same id and
// replaced the first's registry entry. lib/util/registry daemonFor finds the
// live daemon whatever the portfile says — the portfile, else the registry
// entry, each accepted only once /api/health on its port has answered with its
// pid and this root's instance id — and every spawn path asks it first: start
// (foreground and --daemon) refuses, spawnDaemon and open adopt.
//
// Every port a case probes is one this file opened (an in-process withServer on
// an ephemeral port, or a subprocess it started); none probes the 5173.. range
// where the maintainer's own daemons listen. Every registry write goes to the
// per-test sandbox HOME withServer makes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const { withServer, waitUntil } = require('../test-support/helpers');
const client = require('../lib/client');
const registry = require('../lib/util/registry');
const { projectPaths } = require('../lib/core/paths');
const { isPidAlive } = require('../lib/core/portfiles');
const { PROTOCOL_VERSION } = require('../lib/core/versions');
const { SHUTDOWN_HEADER, SHUTDOWN_HEADER_VALUE, LISTEN_HOST } = require('../lib/core/cors');
const { spawnDaemon, CLI_BIN } = require('../lib/util/daemon');
const open = require('../lib/cli/commands/open');

// A realpath'd project root: a subprocess's cwd reads back as the realpath
// (/private/var/… on macOS), and the instance id is a hash of the root string.
function projectRoot(t, prefix = 'wc-one-daemon-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// An in-process daemon for `root` with both records: its portfile and its
// registry entry (withServer writes neither on its ephemeral port by default).
async function liveDaemon(t, root) {
  const ctx = await withServer(t, { root: root || projectRoot(t), writePortfile: true });
  registry.registerInstance({ root: ctx.root, port: ctx.port, pid: process.pid });
  return ctx;
}

function deletePortfile(root) {
  fs.rmSync(projectPaths(root).serverJson, { force: true });
}

// A pid that is certainly not running: a child that has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// A live process that is not the daemon (so not the pid /api/health reports).
function otherLivePid(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child.pid;
}

// Rewrite this root's registry entry to name another pid/port.
function pointEntry(root, { pid, port }) {
  const file = registry.registryPath();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = registry.instanceId(root);
  raw.instances = raw.instances.map((e) => (e && e.id === id ? { ...e, ...(pid !== undefined ? { pid } : {}), ...(port !== undefined ? { port } : {}) } : e));
  fs.writeFileSync(file, JSON.stringify(raw));
}

// ── daemonFor ───────────────────────────────────────────────────────────────

test('daemonFor finds a live daemon by its portfile', async (t) => {
  const { root, port } = await liveDaemon(t);
  const found = await registry.daemonFor(root);
  assert.deepEqual(found, { pid: process.pid, port, url: `http://localhost:${port}`, source: 'portfile' });
});

test('daemonFor finds it by its registry entry when the portfile is gone', async (t) => {
  const { root, port } = await liveDaemon(t);
  deletePortfile(root);
  const found = await registry.daemonFor(root);
  assert.deepEqual(found, { pid: process.pid, port, url: `http://localhost:${port}`, source: 'registry' });
});

test('daemonFor finds it with the whole .web-chat/ deleted under it', async (t) => {
  const { root, port } = await liveDaemon(t);
  fs.rmSync(path.join(root, '.web-chat'), { recursive: true, force: true });
  const found = await registry.daemonFor(root);
  assert.equal(found && found.port, port);
  assert.equal(found.source, 'registry');
});

test('daemonFor: no records at all is null', async (t) => {
  await withServer(t); // the sandbox HOME, empty registry
  assert.equal(await registry.daemonFor(projectRoot(t)), null);
});

test('daemonFor: a registry entry naming a dead pid is null', async (t) => {
  const { root, port } = await liveDaemon(t);
  deletePortfile(root);
  pointEntry(root, { pid: deadPid() });
  assert.equal(await registry.daemonFor(root), null, 'a port that answers is not enough: the pid it names is gone');
  assert.ok(port);
});

test('daemonFor: a registry entry whose port answers with another pid is null', async (t) => {
  const { root } = await liveDaemon(t);
  deletePortfile(root);
  pointEntry(root, { pid: otherLivePid(t) });
  assert.equal(await registry.daemonFor(root), null, 'the daemon on that port is not the process the entry names');
});

test('daemonFor: a registry entry whose port answers for ANOTHER project is null', async (t) => {
  const other = await withServer(t, { root: projectRoot(t, 'wc-one-daemon-other-') });
  const root = projectRoot(t);
  // Same pid (both in-process), so only the instance id tells them apart.
  registry.registerInstance({ root, port: other.port, pid: process.pid });
  assert.equal(await registry.daemonFor(root), null, 'the daemon there names another root');
  // …and that daemon IS found for its own root.
  registry.registerInstance({ root: other.root, port: other.port, pid: process.pid });
  const found = await registry.daemonFor(other.root);
  assert.equal(found && found.source, 'registry');
});

test('daemonFor: a portfile whose port answers for another project falls through to the registry', async (t) => {
  const { root, port } = await liveDaemon(t);
  const other = await withServer(t, { root: projectRoot(t, 'wc-one-daemon-other-') });
  fs.writeFileSync(projectPaths(root).serverJson, JSON.stringify({ pid: process.pid, port: other.port }));
  const found = await registry.daemonFor(root);
  assert.deepEqual([found && found.port, found && found.source], [port, 'registry']);
});

// ── spawnDaemon and open adopt ─────────────────────────────────────────────

test('spawnDaemon adopts a portfile-less live daemon: its port, and nothing spawned', async (t) => {
  const { root, port } = await liveDaemon(t);
  deletePortfile(root);
  let spawned = 0;
  const info = await spawnDaemon(root, { maxMs: 500, spawn: () => { spawned++; } });
  assert.equal(info && info.port, port);
  assert.equal(info.pid, process.pid);
  assert.equal(spawned, 0, 'no second daemon');
});

test('spawnDaemon with no live daemon spawns (the seam), then waits on the portfile', async (t) => {
  await withServer(t);
  const root = projectRoot(t);
  const spawnedFor = [];
  const info = await spawnDaemon(root, { maxMs: 200, spawn: (r) => { spawnedFor.push(r); } });
  assert.deepEqual(spawnedFor, [root]);
  assert.equal(info, null, 'nothing came up within maxMs');
});

test('open adopts a portfile-less live daemon: opens it, spawns nothing', async (t) => {
  const { root, port } = await liveDaemon(t);
  deletePortfile(root);
  const browsed = [];
  const logs = [];
  let spawned = 0;
  await open([], {
    root,
    launchBrowser: (u) => browsed.push(u),
    log: (m) => logs.push(String(m)),
    errlog: (m) => logs.push(String(m)),
    exit: (c) => logs.push(`exit ${c}`),
    spawnDaemonProcess: () => { spawned++; },
    waitForPortfile: async () => null,
    restartIfStale: async () => ({ restarted: false }),
  });
  assert.equal(spawned, 0);
  assert.deepEqual(browsed, [`http://localhost:${port}`]);
  assert.ok(logs.includes(`web-chat server already running at http://localhost:${port}`), JSON.stringify(logs));
});

// ── the foreground `start`, as a real subprocess ───────────────────────────

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

function runStart(root, hubPort) {
  const child = spawn(process.execPath, [CLI_BIN, 'start'], {
    cwd: root,
    env: { ...process.env, WEB_CHAT_HUB_PORT: String(hubPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '', code: undefined, child };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  out.exited = new Promise((r) => child.on('exit', (code) => { out.code = code; r(code); }));
  return out;
}

test('a foreground `start` against a live, portfile-less daemon exits 1 with the refusal and binds nothing', async (t) => {
  const { root, port } = await liveDaemon(t, projectRoot(t));
  deletePortfile(root);
  const hubPort = await fakeHub(t);
  const run = runStart(root, hubPort);
  t.after(() => { try { run.child.kill('SIGKILL'); } catch {} });

  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r('timeout'), 5000); });
  const how = await Promise.race([run.exited, timeout]);
  clearTimeout(timer);
  assert.notEqual(how, 'timeout', `start did not exit within 5 s; stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(run.code, 1, `stdout=${run.stdout} stderr=${run.stderr}`);
  assert.match(run.stderr, new RegExp(`already running at http://localhost:${port} \\(pid ${process.pid}\\) — use \`claude-web-chat restart\` to bounce it`));
  assert.doesNotMatch(run.stdout, /listening on/, 'no server was bound');
  assert.equal(fs.existsSync(projectPaths(root).serverJson), false, 'no portfile written');
  const mine = registry.readAllEntries().filter((e) => e.id === registry.instanceId(root));
  assert.deepEqual(mine.map((e) => [e.pid, e.port]), [[process.pid, port]], 'the live daemon\'s entry is untouched');
});

test('a foreground `start` with no daemon starts one', async (t) => {
  await withServer(t); // the sandbox HOME (the child inherits it)
  const root = projectRoot(t);
  const hubPort = await fakeHub(t);
  const run = runStart(root, hubPort);
  let port = null;
  t.after(async () => {
    if (port) {
      // Through lib/client, as `stop` asks: fetch() sends Sec-Fetch-Mode, which
      // the route refuses as a browser request.
      try {
        await client.post('/api/shutdown', { reason: 'test' }, {
          port, root, noSpawn: true, timeout: 5000, headers: { [SHUTDOWN_HEADER]: SHUTDOWN_HEADER_VALUE },
        });
      } catch {}
    }
    let timer;
    const gone = await Promise.race([run.exited.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), 8000); })]);
    clearTimeout(timer);
    if (!gone) { try { run.child.kill('SIGKILL'); } catch {} }
  });

  port = await waitUntil(() => {
    const m = /listening on http:\/\/localhost:(\d+)/.exec(run.stdout);
    return m ? Number(m[1]) : (run.code !== undefined ? -1 : null);
  }, { timeout: 15000, interval: 50, what: 'the daemon to listen' });
  assert.ok(port > 0, `start exited early (${run.code}): stdout=${run.stdout} stderr=${run.stderr}`);

  const found = await registry.daemonFor(root);
  assert.equal(found && found.port, port);
  assert.equal(found.pid, run.child.pid);
  assert.ok(isPidAlive(run.child.pid));
});

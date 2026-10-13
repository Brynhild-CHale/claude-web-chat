// `claude-web-chat start --daemon` and a daemon already running here.
//
// After an `update`, every other project's daemon keeps serving the build it
// booted on (a tab attached means it never exits on its own). `start --daemon`
// is one of the three commands a user runs in such a project, and it asks the
// running daemon which build it serves: another build is restarted onto this
// one through restart (lib/cli/stale-daemon restartIfStale, one line), the same
// build is "already running" and exits 1. Neither may spawn a second daemon.
//
// `open` and `install` have call-site tests of the same bounce; this one had
// none, so a regression in start's branch (say `stale.restarted` never read)
// shipped with every test green. Nothing here starts a daemon: the live-daemon
// lookup (daemonFor), the spawn and the wait are all injected, and the real
// restartIfStale runs with its own build and restart injected. The last case
// runs the real wait (daemonFor polled) against stand-ins this file opened.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const start = require('../lib/cli/commands/start');
const stale = require('../lib/cli/stale-daemon');

const INFO = { port: 5999, url: 'http://localhost:5999', pid: 4242 };

function project(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-start-stale-')));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// Every seam start --daemon has, each one recording what reached it. `build`
// is the release the running daemon says it serves; this CLI is v0.8.0.
function harness(root, { build = '0.7.6', restartOk = true, portfile = INFO, reachable = true } = {}) {
  const h = { lines: [], errs: [], exits: [], spawned: [], restarts: [], asked: [], found: [], handed: [], waited: 0 };
  h.live = () => (portfile && reachable ? { ...portfile, source: 'portfile' } : null);
  h.deps = {
    root,
    log: (m) => h.lines.push(m),
    errlog: (m) => h.errs.push(m),
    exit: (c) => h.exits.push(c),
    // start asks lib/util/registry daemonFor for the live daemon (U105); the
    // portfile + probe pair this harness models is that call's portfile arm.
    daemonFor: async (r) => { h.found.push(r); return portfile && reachable ? { ...portfile, source: 'portfile' } : null; },
    restartIfStale: (r, o) => {
      h.asked.push(r);
      h.handed.push(o.daemon);
      return stale.restartIfStale(r, {
        ...o,
        expected: '0.8.0',
        // U107b: the bounce acts only on a daemon daemonFor verified. U107c:
        // start hands it the record its own daemonFor call verified (o.daemon),
        // so this lookup is the fallback only and is not reached here.
        daemonFor: async () => { throw new Error('start hands restartIfStale its verified daemon; it must not look again'); },
        build: async () => build,
        restart: async (args, d) => { h.restarts.push(d.root); return { ok: restartOk }; },
      });
    },
    spawnDaemonProcess: (r) => { h.spawned.push(r); return { pid: 31337 }; },
    // U107c: start --daemon waits for a record daemonFor verified, not the raw
    // portfile (waitUntilReachable); this is that wait's seam.
    waitForDaemon: async () => { h.waited++; return { url: 'http://localhost:6000', pid: 31337, source: 'portfile' }; },
  };
  return h;
}

test('start --daemon: a reachable daemon on another build is restarted onto this one — one line, no spawn, no exit', async (t) => {
  const root = project(t);
  const h = harness(root, { build: '0.7.6' });
  await start(['--daemon'], h.deps);

  assert.deepEqual(h.asked, [root], 'restartIfStale is asked about THIS project');
  assert.deepEqual(h.handed, [{ ...INFO, source: 'portfile' }], 'handed the daemon start verified (U107c)');
  assert.deepEqual(h.restarts, [root], 'and restarts it through restart, for that root');
  assert.deepEqual(h.lines, ['Restarted the web-chat server on v0.8.0 — it was still running v0.7.6.']);
  assert.deepEqual(h.spawned, [], 'no second daemon beside the restarted one');
  assert.equal(h.waited, 0);
  assert.deepEqual(h.exits, [], 'a bounce is a success, not a conflict');
  assert.deepEqual(h.errs, []);
});

test('start --daemon: a reachable daemon on THIS build is "already running" and exits 1, spawning nothing', async (t) => {
  const root = project(t);
  const h = harness(root, { build: '0.8.0' });
  await start(['--daemon'], h.deps);

  assert.deepEqual(h.asked, [root]);
  assert.deepEqual(h.restarts, [], 'the same build is never restarted');
  assert.deepEqual(h.errs, ['already running at http://localhost:5999 (pid 4242) — use `claude-web-chat restart` to bounce it']);
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.spawned, [], 'and nothing is spawned after the exit — an injected exit returns, so start must too');
  assert.deepEqual(h.lines, []);
});

test('start --daemon: a stale daemon that will not restart is reported, then "already running", exit 1', async (t) => {
  const root = project(t);
  const h = harness(root, { build: '0.7.6', restartOk: false });
  await start(['--daemon'], h.deps);

  assert.deepEqual(h.restarts, [root]);
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /running v0\.7\.6, not v0\.8\.0, and could not be restarted — run `claude-web-chat restart`/);
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.spawned, []);
});

test('start --daemon: a portfile nothing answers on is not asked about — a fresh daemon is spawned', async (t) => {
  const root = project(t);
  const h = harness(root, { reachable: false });
  await start(['--daemon'], h.deps);

  assert.deepEqual(h.asked, [], 'no build question for a daemon that is not there');
  assert.deepEqual(h.spawned, [root]);
  assert.equal(h.waited, 1);
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /^web-chat server started as daemon at http:\/\/localhost:6000 \(pid 31337, log /);
  assert.deepEqual(h.exits, []);
});

test('start --daemon: no portfile at all spawns without asking', async (t) => {
  const root = project(t);
  const h = harness(root, { portfile: null });
  await start(['--daemon'], h.deps);
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.spawned, [root]);
});

// U105: the live daemon need not have a portfile. Deleting .web-chat/ under a
// running daemon takes its portfile with it; daemonFor still finds it through
// its registry entry, and start --daemon refuses it exactly as it refuses the
// portfile case — the bounce is asked first (with no portfile it finds nothing
// to restart), then "already running", exit 1, nothing spawned.
test('start --daemon: a live daemon found through the registry is refused as the portfile case is', async (t) => {
  const root = project(t);
  const h = harness(root, { portfile: null, build: '0.8.0' });
  h.live = () => ({ ...INFO, source: 'registry' });
  h.deps.daemonFor = async (r) => { h.found.push(r); return h.live(); };
  await start(['--daemon'], h.deps);
  assert.deepEqual(h.found, [root], 'the lookup is asked about THIS project');
  assert.deepEqual(h.asked, [root]);
  assert.deepEqual(h.restarts, [], 'the same build: nothing to bounce');
  assert.deepEqual(h.errs, ['already running at http://localhost:5999 (pid 4242) — use `claude-web-chat restart` to bounce it']);
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.spawned, []);
  assert.equal(h.waited, 0);
});

// The foreground path checked nothing (INCIDENT-2026-10-06 finding 2), and
// every spawned daemon IS a foreground start in a detached child: it now asks
// the same question, and never builds a server when the answer is a live one.
test('start (foreground): a live daemon is refused before any server is built', async (t) => {
  const root = project(t);
  const h = harness(root, { portfile: null, build: '0.8.0' });
  let built = 0;
  h.deps.createServer = () => { built++; return { start: async () => {}, installSignalHandlers: () => {} }; };
  h.deps.daemonFor = async () => ({ ...INFO, source: 'registry' });
  await start([], h.deps);
  assert.equal(built, 0, 'no server, no bind');
  assert.deepEqual(h.errs, ['already running at http://localhost:5999 (pid 4242) — use `claude-web-chat restart` to bounce it']);
  assert.deepEqual(h.exits, [1]);
});

test('start (foreground): with no live daemon it builds and starts the server', async (t) => {
  const root = project(t);
  const h = harness(root, { portfile: null });
  const calls = [];
  h.deps.createServer = (o) => { calls.push(o.root); return { start: async () => calls.push('start'), installSignalHandlers: () => calls.push('signals') }; };
  await start([], h.deps);
  assert.deepEqual(calls, [root, 'start', 'signals']);
  assert.deepEqual(h.exits, []);
  assert.deepEqual(h.errs, []);
});

// U107b: the bounce acts on the daemon daemonFor verified, wherever it was
// found — a registry-only daemon on an older build is restarted, and restart is
// handed exactly that daemon as stop's target (never the portfile's pid).
test('start --daemon: a live daemon found through the registry on an older build is bounced, as that daemon', async (t) => {
  const root = project(t);
  const h = harness(root, { portfile: null, build: '0.7.6' });
  const targets = [];
  h.live = () => ({ ...INFO, source: 'registry' });
  h.deps.daemonFor = async (r) => { h.found.push(r); return h.live(); };
  // the harness's bounce, with a restart recorder that keeps the target too
  h.deps.restartIfStale = (r, o) => {
    h.asked.push(r);
    return stale.restartIfStale(r, {
      ...o,
      expected: '0.8.0',
      build: async () => '0.7.6',
      restart: async (args, d) => { h.restarts.push(d.root); targets.push(d.target); return { ok: true }; },
    });
  };
  await start(['--daemon'], h.deps);
  assert.deepEqual(h.restarts, [root]);
  assert.deepEqual(targets, [{ pid: INFO.pid, port: INFO.port, url: INFO.url, source: 'registry' }]);
  assert.deepEqual(h.lines, ['Restarted the web-chat server on v0.8.0 — it was still running v0.7.6.']);
  assert.deepEqual(h.exits, []);
  assert.deepEqual(h.spawned, []);
});

// U107c: the 'started as daemon at' line names THIS root's new daemon. A
// .web-chat/ copied from another project carries a portfile naming THAT
// project's live daemon; start --daemon used to wait on the raw portfile
// (waitUntilReachable) and print the other project's URL as the one it had just
// started. Now it waits for a record lib/util/registry daemonFor verifies. The
// real wait and the real daemonFor run here, against two stand-ins on ports
// this file opened: the other project's (its health names its own instance)
// behind the copied portfile, and this root's "new daemon", which the injected
// spawn brings up and registers in the sandboxed registry.
const http = require('http');
const { withTempHome } = require('../test-support/helpers');
const portfiles = require('../lib/core/portfiles');
const registry = require('../lib/util/registry');

async function standIn(t, instance) {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, role: 'instance', pid: process.pid, instance }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  return srv.address().port;
}

test('start --daemon with a copied portfile: the "started as daemon at" line names this root\'s new daemon', async (t) => {
  withTempHome(t);
  const root = project(t);
  const otherRoot = project(t);
  const otherPort = await standIn(t, registry.instanceId(otherRoot));
  // The copied record: this root's portfile names the other project's daemon.
  portfiles.writePortfile('server', { root, pid: process.pid, port: otherPort });
  t.after(() => { try { portfiles.deletePortfile('server', { root, pid: process.pid }); } catch {} });

  // The stand-in for the daemon start spawns: listening already, but no
  // record names it until the injected spawn registers it, a moment later, in
  // the registry only (its portfile write would lose to the live record there).
  const minePort = await standIn(t, registry.instanceId(root));
  let timer = null;
  t.after(() => {
    clearTimeout(timer);
    try { registry.deregisterInstance(root, { pid: process.pid }); } catch {}
  });

  const lines = [];
  const errs = [];
  const exits = [];
  await start(['--daemon'], {
    root,
    log: (m) => lines.push(String(m)),
    errlog: (m) => errs.push(String(m)),
    exit: (c) => exits.push(c),
    restartIfStale: async () => { throw new Error('no live daemon of this root: nothing to bounce'); },
    spawnDaemonProcess: (r) => {
      timer = setTimeout(() => registry.registerInstance({ root: r, port: minePort, pid: process.pid }), 150);
      return { pid: process.pid };
    },
  });

  assert.deepEqual(errs, []);
  assert.deepEqual(exits, []);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], new RegExp(`^web-chat server started as daemon at http://localhost:${minePort} \\(pid ${process.pid}, log `));
  assert.doesNotMatch(lines[0], new RegExp(`:${otherPort}\\b`), "never the other project's URL");
});

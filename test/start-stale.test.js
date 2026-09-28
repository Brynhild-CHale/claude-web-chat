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
// shipped with every test green. Nothing here starts a daemon: the portfile,
// the probe, the spawn and the wait are all injected, and the real
// restartIfStale runs with its own build and restart injected.

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
  const h = { lines: [], errs: [], exits: [], spawned: [], restarts: [], asked: [], waited: 0 };
  h.deps = {
    root,
    log: (m) => h.lines.push(m),
    errlog: (m) => h.errs.push(m),
    exit: (c) => h.exits.push(c),
    readPortfile: () => portfile,
    probeReachable: async () => reachable,
    restartIfStale: (r, o) => {
      h.asked.push(r);
      return stale.restartIfStale(r, {
        ...o,
        expected: '0.8.0',
        readPortfile: () => portfile,
        build: async () => build,
        restart: async (args, d) => { h.restarts.push(d.root); return { ok: restartOk }; },
      });
    },
    spawnDaemonProcess: (r) => { h.spawned.push(r); return { pid: 31337 }; },
    waitUntilReachable: async () => { h.waited++; return { url: 'http://localhost:6000', pid: 31337 }; },
  };
  return h;
}

test('start --daemon: a reachable daemon on another build is restarted onto this one — one line, no spawn, no exit', async (t) => {
  const root = project(t);
  const h = harness(root, { build: '0.7.6' });
  await start(['--daemon'], h.deps);

  assert.deepEqual(h.asked, [root], 'restartIfStale is asked about THIS project');
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

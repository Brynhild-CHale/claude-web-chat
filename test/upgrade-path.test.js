// The upgrade path, outside `update` itself (test/update-cli.test.js has that):
//
//   * a daemon an update left on an OLDER build is found (GET /api/health
//     `build`, else GET /api/version `current` — what 0.7.6 serves) and bounced
//     by `install` / `open` / `start --daemon` through restart, in one line
//     (lib/cli/stale-daemon.js);
//   * no daemon is ever rooted outside an initialised project — `start` and
//     `restart` typed in ~ or any non-project directory used to boot one there,
//     and 0.8 would then remember it as a project the portal can start;
//   * a daemon boot seeds the builtin theme pack's per-user folder, because the
//     updater that performs the hop onto this build is the old one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { withServer, withTempHome, freePort } = require('../test-support/helpers');
const { userPaths } = require('../lib/core/paths');
const { packageVersion } = require('../lib/core/versions');
const stale = require('../lib/cli/stale-daemon');
const start = require('../lib/cli/commands/start');
const restart = require('../lib/cli/commands/restart');

function inDir(t, dir) {
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prev));
  return dir;
}

function scratch(prefix = 'wc-noproj-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A stand-in for a 0.7.6 daemon: /api/health without `build`, /api/version
// with `current`.
async function oldDaemon(t, current = '0.7.6') {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, role: 'instance', version: 3, pid: 4242 }));
    if (req.url === '/api/version') return res.end(JSON.stringify({ ok: true, current, latest: null }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  return port;
}

// ── which build a running daemon serves ─────────────────────────────────────

test('a daemon reports its package build on /api/health, and runningBuild reads it', async (t) => {
  const { port } = await withServer(t);
  const h = await require('../lib/core/portfiles').probeHealth(port);
  assert.equal(h.build, packageVersion());
  assert.equal(await stale.runningBuild(port), packageVersion());
});

test('runningBuild falls back to /api/version `current` for a build with no health `build` (0.7.6)', async (t) => {
  const port = await oldDaemon(t);
  assert.equal(await stale.runningBuild(port), '0.7.6');
  assert.equal(await stale.runningBuild(await freePort()), null, 'nothing answering: unknown, never a guess');
});

// ── restartIfStale ──────────────────────────────────────────────────────────

test('restartIfStale bounces a daemon on another build, in one line; the same build or an unknown one is left alone', async () => {
  const calls = [];
  const lines = [];
  const base = {
    log: (m) => lines.push(m),
    expected: '0.8.0',
    readPortfile: () => ({ port: 5999, url: 'http://localhost:5999', pid: 1 }),
    restart: async (args, deps) => { calls.push(deps.root); return { ok: true }; },
  };

  let r = await stale.restartIfStale('/p', { ...base, build: async () => '0.8.0' });
  assert.deepEqual([r.restarted, calls.length, lines.length], [false, 0, 0], 'same build: nothing');

  r = await stale.restartIfStale('/p', { ...base, build: async () => null });
  assert.deepEqual([r.restarted, calls.length, lines.length], [false, 0, 0], 'unknown build: never restarted');

  r = await stale.restartIfStale('/p', { ...base, readPortfile: () => null, build: async () => '0.7.6' });
  assert.deepEqual([r.restarted, calls.length], [false, 0], 'no daemon: nothing');

  r = await stale.restartIfStale('/p', { ...base, build: async () => '0.7.6' });
  assert.equal(r.restarted, true);
  assert.deepEqual(calls, ['/p'], 'restarted through restart, for THAT root');
  assert.deepEqual(lines, ['Restarted the web-chat server on v0.8.0 — it was still running v0.7.6.']);

  lines.length = 0;
  r = await stale.restartIfStale('/p', { ...base, build: async () => '0.7.6', restart: async () => ({ ok: false }) });
  assert.equal(r.restarted, false);
  assert.match(lines[0], /running v0\.7\.6, not v0\.8\.0, and could not be restarted — run `claude-web-chat restart`/);
});

// ── no daemon outside a project ─────────────────────────────────────────────

// Asked of start.projectRoot — the one question start answers before it
// spawns anything — so a regression here fails the test instead of forking a
// daemon. (withTempHome's HOME is a /var/folders path whose real path is
// /private/var/…: the symlinked-$HOME case, which the literal comparison in
// findProjectRoot used to miss.)
test('start refuses a directory that is not a web-chat project, naming init — and $HOME is never one', async (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.web-chat'), { recursive: true });   // the USER tier, on every machine
  inDir(t, scratch());
  assert.throws(() => start.projectRoot({}), (e) => e.userFacing && /no \.web-chat\/ in .*claude-web-chat init/.test(e.message));
  await assert.rejects(start(['--daemon']), (e) => e.userFacing, 'start itself asks it first');
  process.chdir(home);
  assert.throws(() => start.projectRoot({}), (e) => e.userFacing, '~/.web-chat is not a project');
  const proj = scratch('wc-proj-');
  fs.mkdirSync(path.join(proj, '.web-chat'));
  process.chdir(proj);
  assert.equal(start.projectRoot({}), proj, 'an initialised project is');
});

test('restart outside a project says so and starts nothing (the 0.7.6 updater calls it from anywhere)', async (t) => {
  withTempHome(t);
  const dir = inDir(t, scratch());
  const lines = [];
  let started = 0;
  const r = await restart([], { log: (m) => lines.push(m), start: async () => { started++; } });
  assert.equal(started, 0);
  assert.equal(r.reason, 'no-project');
  assert.match(lines.join('\n'), new RegExp(`No web-chat project here \\(${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.equal(fs.existsSync(path.join(dir, '.web-chat')), false, 'and no .web-chat/ was made');
});

test('restart hands start the root it was given, not the cwd', async (t) => {
  withTempHome(t);
  inDir(t, scratch());
  const root = scratch('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'));
  const seen = [];
  const r = await restart([], { root, log: () => {}, start: async (args, deps) => { seen.push([args, deps.root]); } });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [[['--daemon'], root]]);
});

// ── the hop's missing seed ──────────────────────────────────────────────────

test('a daemon boot seeds the builtin theme pack folder', async (t) => {
  await withServer(t);
  const folders = require('../lib/setup/theme-logos').FILL_PACKS.map((p) => userPaths().themeLogosDir(p));
  for (const dir of folders) assert.deepEqual(fs.readdirSync(dir), ['README.txt']);
});

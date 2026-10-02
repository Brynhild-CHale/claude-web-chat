// The upgrade path, outside `update` itself (test/update-cli.test.js has that):
//
//   * a daemon an update left on an OLDER build is found (GET /api/health
//     `package_version`, else GET /api/version `current` — what 0.7.6 serves) and bounced
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

const { withServer, withTempHome, freePort, existingProject } = require('../test-support/helpers');
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

// A stand-in for a 0.7.6 daemon: /api/health without `package_version`, /api/version
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
  assert.equal(h.package_version, packageVersion());
  assert.equal(await stale.runningBuild(port), packageVersion());
});

test('runningBuild falls back to /api/version `current` for a build with no health `package_version` (0.7.6)', async (t) => {
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

// ── the hop's post-update checklist ─────────────────────────────────────────
// 0.7.6's frozen `update` performs the hop: it activates 0.8, syncs this
// project, calls 0.8's restart as `restart(args)` from the project directory and
// returns. So 0.8's restart is the last 0.8 code that prints, and when the
// daemon it replaces is a pre-0.8 build it prints what the release notes ask.

test('runningBuild with exact:false names a pre-0.8 daemon LEGACY_BUILD from health alone; isLegacyBuild asks it that way', async (t) => {
  const { LEGACY_BUILD } = require('../lib/util/registry');
  const asked = [];
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    asked.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, role: 'instance', version: 3, pid: 4242 }));
    res.end(JSON.stringify({ ok: true, current: '0.7.6' }));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  t.after(() => { srv.close(); srv.closeAllConnections(); });

  assert.equal(await stale.runningBuild(port, { exact: false }), LEGACY_BUILD);
  assert.equal(await stale.isLegacyBuild(port), true);
  assert.deepEqual(asked, ['/api/health', '/api/health'], 'never GET /api/version — on 0.7.x that may fetch from GitHub first');

  const { port: current } = await withServer(t);
  assert.equal(await stale.isLegacyBuild(current), false, 'a 0.8 daemon names its release');
  assert.equal(await stale.isLegacyBuild(await freePort()), false, 'nothing answering is never called old');
});

// A stand-in for the daemon a restart replaces, owning `root`'s portfile (as
// this process, so the pid is alive), that acknowledges POST /api/shutdown the
// way a real one does — by dropping its portfile — unless `wedge` says to ack
// and stay. `packageVersion` null is a pre-0.8 build: health names no release.
async function replacedDaemon(t, root, { packageVersion: pv = null, wedge = false } = {}) {
  const portfiles = require('../lib/core/portfiles');
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') {
      return res.end(JSON.stringify({ ok: true, role: 'instance', version: 3, pid: process.pid, ...(pv ? { package_version: pv } : {}) }));
    }
    if (req.url === '/api/version') return res.end(JSON.stringify({ ok: true, current: pv || '0.7.6' }));
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      if (!wedge) portfiles.deletePortfile('server', { root, pid: process.pid });
      return res.end(JSON.stringify({ ok: true, shutting_down: true, pid: process.pid }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  portfiles.writePortfile('server', { root, pid: process.pid, port });
  t.after(() => {
    srv.close(); srv.closeAllConnections();
    try { portfiles.deletePortfile('server', { root, pid: process.pid }); } catch {}
  });
  return port;
}

function hopProject(t) {
  withTempHome(t);
  const root = scratch('wc-hop-');
  fs.mkdirSync(path.join(root, '.web-chat'));
  return root;
}

const CHECKLIST = [
  /The server here was on a build older than 0\.8; it now runs v\S+\. To finish the upgrade:/,
  /1\. Reload every open web-chat tab/,
  /2\. \/exit and reopen Claude Code — a running session keeps the MCP server it started with/,
  /3\. Run `claude-web-chat update --restart-all`: it restarts every server still on the old build/,
  // Only where web-chat is registered: `--restart-all` restarts a stray or
  // uninstalled project's server and writes nothing there.
  /and refreshes the rules, command and skills of each project web-chat is registered in\. In/,
  /any other web-chat project you did not run `update` in, run `claude-web-chat install` — this/,
  /one too, if you ran `restart` here\./,
];

test('restart of a pre-0.8 daemon prints the post-update checklist, after the new server started — called the way 0.7.6\'s update calls it', async (t) => {
  const root = inDir(t, hopProject(t));
  await replacedDaemon(t, root);
  const lines = [];
  const log = (m = '') => lines.push(String(m));
  // restart(args) with the project read off the cwd, as the frozen updater does;
  // only `start` is stubbed (a real one would fork a daemon), and it logs.
  const r = await restart([], { log, start: async () => { log('STARTED'); } });
  assert.equal(r.ok, true);
  assert.equal(r.checklist, true, 'the result says it was printed, so 0.8\'s own update does not repeat its line');
  const text = lines.join('\n');
  for (const re of CHECKLIST) assert.match(text, re);
  assert.match(text, /stopped cleanly/, 'the real stop engine replaced it');
  const started = lines.indexOf('STARTED');
  const heading = lines.findIndex((l) => /To finish the upgrade/.test(l));
  assert.ok(started >= 0 && heading > started, 'printed after the restart, never before it');
  const v = packageVersion();
  if (!require('../lib/core/versions').isDevVersion(v)) {
    assert.ok(text.includes(require('../lib/core/versions').releaseTagUrl(`v${v}`)), 'and it says where the release notes are');
  }
});

test('restart of an 0.8 daemon prints no checklist', async (t) => {
  const root = hopProject(t);
  await replacedDaemon(t, root, { packageVersion: '0.8.0' });
  const lines = [];
  const r = await restart([], { root, log: (m) => lines.push(String(m)), start: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.checklist, undefined);
  assert.doesNotMatch(lines.join('\n'), /To finish the upgrade|reopen Claude Code/);
});

test('no checklist when nothing was running, or when the old daemon could not be stopped', async (t) => {
  const root = hopProject(t);
  const lines = [];
  const log = (m) => lines.push(String(m));
  let r = await restart([], { root, log, start: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.checklist, undefined, 'no daemon to ask: nothing is claimed');

  await replacedDaemon(t, root, { wedge: true });
  let started = 0;
  r = await restart([], { root, log, ackWaitMs: 200, signalAfterAck: false, start: async () => { started++; } });
  assert.equal(r.ok, false);
  assert.equal(started, 0);
  assert.equal(r.checklist, undefined);
  assert.doesNotMatch(lines.join('\n'), /To finish the upgrade/, 'the checklist is for a restart that happened');
});

test('the checklist can never break the restart: a probe that throws, a log that throws on it', async (t) => {
  const root = hopProject(t);
  await replacedDaemon(t, root);
  let started = 0;
  let r = await restart([], {
    root, log: () => {}, start: async () => { started++; },
    isLegacyBuild: async () => { throw new Error('probe blew up'); },
  });
  assert.deepEqual([r.ok, started, r.checklist], [true, 1, undefined]);

  await replacedDaemon(t, root);
  r = await restart([], {
    root,
    log: (m = '') => { if (/finish the upgrade/.test(m)) throw new Error('EPIPE'); },
    start: async () => { started++; },
  });
  assert.deepEqual([r.ok, started, r.checklist], [true, 2, undefined]);
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

// ── state a 0.7.x build left behind ─────────────────────────────────────────
// No migration runs on the hop to 0.8, so a node or a draft 0.7.x wrote is
// restored as-is. These fixtures are shaped exactly as 0.7.6 writes them.

function seedGraph(webChatDir, nodes, extra = {}) {
  const graphDir = path.join(webChatDir, 'graph');
  fs.mkdirSync(graphDir, { recursive: true });
  for (const n of nodes) fs.writeFileSync(path.join(graphDir, `${n.id}.json`), JSON.stringify(n));
  fs.writeFileSync(path.join(graphDir, '_meta.json'), JSON.stringify({ active: nodes[nodes.length - 1].id, lock: null, ...extra }));
}
const pane = (id, html) => ({ id, html, target: 'main', params: {}, pane_state: {}, owner: 'claude' });

// R2-1. A rollback round trip: 0.8 commits a page with markdown; `update --to
// 0.7.6` runs 0.7.6, whose graceful stop writes a draft from a live state that
// cannot hold markdown (same schema_version 1, no `markdown`/`order` keys); then
// `update` returns to 0.8. The draft used to restore as "no markdown": the
// page lost its title and prose, and the next chat-only turn committed a node
// without them.
test('a 0.7.6 draft over a node with markdown keeps the node\'s page, and a chat-only turn after it folds', async (t) => {
  const node = {
    id: 'n0', parent_id: null, created_at: 1000, author: 'claude',
    trigger: { kind: 'turn', message: 'build a page', summary: 'build a page' },
    mounts: [pane('pane-a', '<p>a</p>'), pane('pane-b', '<p>b</p>')],
    markdown: [{ id: 'md-title', text: '# Upgrade test page', owner: 'claude' }, { id: 'md-2', text: '## Part two', owner: 'claude' }],
    order: ['md-title', 'pane-a', 'md-2', 'pane-b'],
    store: { k: 1 }, comments: [], captures: [],
  };
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      existingProject({ webChatDir });
      seedGraph(webChatDir, [node]);
      // What 0.7.6's writeDraft writes: the same panes, no page fields.
      fs.writeFileSync(path.join(webChatDir, 'draft.json'), JSON.stringify({
        schema_version: 1, saved_at: 2000, base_active: 'n0',
        mounts: node.mounts, store: { k: 1 }, comments: [], captures: [], queue: [],
        pendingWake: null, pendingAck: null,
      }));
    },
  });
  const live = (await api.get('/api/mounts')).json;
  assert.deepEqual(live.markdown.map((m) => m.id), ['md-title', 'md-2'], 'the node\'s markdown is live');
  assert.deepEqual(live.order, node.order, 'in the node\'s page order');

  await api.post('/api/turn-begin', { message: 'just a question' });
  const te = await api.post('/api/turn-end', {});
  assert.equal(te.json.skipped, 'no-change', 'the surface IS the node — nothing to commit');
});

test('a 0.7.6 draft that added a pane keeps the node\'s page with the new pane appended', async (t) => {
  const node = {
    id: 'n0', parent_id: null, created_at: 1000, author: 'claude',
    trigger: { kind: 'turn', message: 'build a page', summary: 'build a page' },
    mounts: [pane('pane-a', '<p>a</p>'), pane('pane-b', '<p>b</p>')],
    markdown: [{ id: 'md-title', text: '# Upgrade test page', owner: 'claude' }],
    order: ['md-title', 'pane-b', 'pane-a'],
    store: {}, comments: [], captures: [],
  };
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => {
      existingProject({ webChatDir });
      seedGraph(webChatDir, [node]);
      fs.writeFileSync(path.join(webChatDir, 'draft.json'), JSON.stringify({
        schema_version: 1, saved_at: 2000, base_active: 'n0',
        mounts: [...node.mounts, pane('pane-new', '<p>made on 0.7.6</p>')],
        store: {}, comments: [], captures: [], queue: [], pendingWake: null, pendingAck: null,
      }));
    },
  });
  const live = (await api.get('/api/mounts')).json;
  assert.deepEqual(live.order, ['md-title', 'pane-b', 'pane-a', 'pane-new']);
  assert.deepEqual(live.markdown.map((m) => m.id), ['md-title']);
});

// R3-5. 0.7.x did not reserve 'start', so a node it committed can hold a pane by
// that name. The reservation was write-side only: such a pane came back live but
// could be neither re-rendered nor restored from history.
test('a 0.7.6 pane named \'start\' stays addressable; a new \'start\' is still refused, and after:\'start\' is still the top', async (t) => {
  const node = {
    id: 'n0', parent_id: null, created_at: 1000, author: 'claude',
    trigger: { kind: 'turn', message: 'a start screen', summary: 'a start screen' },
    mounts: [pane('x', '<p>x</p>'), pane('start', '<p>start screen</p>')],
    store: {}, comments: [], captures: [],
  };
  const { api } = await withServer(t, {
    seed: ({ webChatDir }) => { existingProject({ webChatDir }); seedGraph(webChatDir, [node]); },
  });
  assert.deepEqual((await api.get('/api/mounts')).json.order, ['x', 'start'], 'precondition: restored as-is');

  const r = await api.post('/api/render', { id: 'start', html: '<p>start screen, v2</p>' });
  assert.equal(r.json.ok, true, 'Claude can update the pane it already has');
  const h = await api.post('/api/mounts/start/restore', { node_id: 'n0' });
  assert.equal(h.json.ok, true, 'and the user can put an older version back');
  assert.equal(h.json.restored_from, 'n0');

  const top = await api.post('/api/render', { id: 'new', html: '<p>new</p>', after: 'start' });
  assert.equal(top.json.ok, true);
  assert.deepEqual((await api.get('/api/mounts')).json.order, ['new', 'x', 'start'], "after:'start' still means the page top");

  await api.post('/api/clear', { id: 'start' });
  const again = await api.post('/api/render', { id: 'start', html: '<p>a new one</p>' });
  assert.equal(again.json.ok, false);
  assert.equal(again.json.reserved, true, 'once it is gone the name is reserved again');
});

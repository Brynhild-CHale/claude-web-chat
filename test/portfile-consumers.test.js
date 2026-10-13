// The CLI commands that talk to a daemon act on THIS project's verified daemon,
// never on whatever port .web-chat/server.json names.
//
// A portfile can name another project's daemon: a .web-chat/ copied from one
// checkout into another carries its server.json along, and a daemon older than
// 0.8.5 wrote no root field into it, so the file alone cannot say whose it is.
// export, trust (its listing, --pack and the refresh nudge), unlock, identity
// and init's report state each ask lib/util/registry daemonFor instead — the
// portfile, else this root's registry entry, accepted only once /api/health
// answers with that pid as this project's instance — with stop's 1.5 s budget
// (PORTFILE_PROBE_MS: a slow-but-alive daemon is still ours). None of them
// spawns.
//
// The shape of every case: two roots A and B; a stand-in HTTP server on a port
// this test opened answers GET /api/health as one project's daemon and records
// every other request. B's portfile is hand-written in an older daemon's shape
// (no root field), so what is proved is the probe, not the field. Every port
// probed here is one the test opened; nothing scans 5173–5272.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { withTempHome, tmpRoot } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { PORTFILE_PROBE_MS } = require('../lib/cli/commands/stop');
const trust = require('../lib/cli/commands/trust');
const identity = require('../lib/cli/commands/identity');
const { gatherState } = require('../lib/cli/init/state');
const project = require('../lib/core/project-identity');

const BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat.js');

// A project root, realpath'd: a subprocess's process.cwd() is the real path
// (/private/var/… on macOS), and the instance id hashes the path it is given.
function root(t, prefix) {
  const dir = fs.realpathSync(tmpRoot(prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The stand-in daemon. Health answers as `answerAs`'s instance (after
// `delayMs`), with this process's pid — alive, and what the portfile names.
// Every other request is recorded and answered with what its route returns.
async function standIn(t, { answerAs, delayMs = 0 }) {
  const seen = [];
  const replies = {
    'GET /api/export/active': { label: 'n1.1', path: '/tmp/stand-in.html' },
    'GET /api/services/pending': { ok: true, pending: [] },
    'GET /api/services/pack/acme-ops': { ok: true, pack: null, requests: [], skipped: [] },
    'POST /api/services/refresh-trust': { ok: true },
    'POST /api/unlock': { cleared: true },
    'PUT /api/project/name': { ok: true, identity: { name: 'Acme Web', custom: true } },
    'GET /api/queue/policy': { channel_connected: false },
  };
  const server = http.createServer((req, res) => {
    req.resume();
    const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/api/health') {
      const body = { ok: true, role: 'instance', pid: process.pid, instance: registry.instanceId(answerAs), viewers: 0 };
      if (delayMs) setTimeout(() => send(body), delayMs); else send(body);
      return;
    }
    const key = `${req.method} ${req.url.split('?')[0]}`;
    seen.push(key);
    send(replies[key] || { ok: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { port: server.address().port, seen };
}

// What a daemon before 0.8.5 wrote: pid, port, url, started_at — no root.
function oldPortfile(dir, port) {
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.web-chat', 'server.json'), JSON.stringify({
    pid: process.pid, port, url: `http://localhost:${port}`, started_at: Date.now(),
  }, null, 2));
}

// The real CLI as a child process, cwd `cwd`, HOME the test's sandbox. Async:
// the stand-in it talks to runs in THIS process.
function cli(args, cwd) {
  const env = { ...process.env, HOME: process.env.HOME, USERPROFILE: process.env.HOME, CI: '1', NO_COLOR: '1' };
  delete env.WEB_CHAT_PORT;
  delete env.FORCE_COLOR;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// The three setups. Each returns { b, port, seen }.
//   foreign — B holds a field-less copy of a portfile naming A's daemon.
//   own     — B's portfile names a daemon that answers as B's.
//   registry — no portfile in B; B's daemon is known only by its registry entry.
async function foreign(t) {
  withTempHome(t);
  const a = root(t, 'wc-pfc-a-');
  const b = root(t, 'wc-pfc-b-');
  const s = await standIn(t, { answerAs: a });
  oldPortfile(b, s.port);
  return { b, ...s };
}

async function own(t, opts = {}) {
  withTempHome(t);
  const b = root(t, 'wc-pfc-b-');
  const s = await standIn(t, { answerAs: b, ...opts });
  oldPortfile(b, s.port);
  return { b, ...s };
}

async function registryOnly(t) {
  withTempHome(t);
  const b = root(t, 'wc-pfc-b-');
  const s = await standIn(t, { answerAs: b });
  registry.registerInstance({ root: b, port: s.port, pid: process.pid });
  assert.equal(fs.existsSync(path.join(b, '.web-chat', 'server.json')), false);
  return { b, ...s };
}

test('the budget is stop\'s PORTFILE_PROBE_MS (1.5 s)', () => {
  assert.equal(PORTFILE_PROBE_MS, 1500);
});

// ── export ──────────────────────────────────────────────────────────────────

test('export: a copied portfile naming another project\'s daemon is "no server running"', async (t) => {
  const { b, seen } = await foreign(t);
  const r = await cli(['export'], b);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /no server running — run `claude-web-chat open` first/);
  assert.deepEqual(seen, [], 'nothing but /api/health reached the other project\'s daemon');
});

test('export: this project\'s daemon is reached, through the portfile or the registry', async (t) => {
  for (const setup of [own, registryOnly]) {
    await t.test(setup.name, async (t) => {
      const { b, seen } = await setup(t);
      const r = await cli(['export'], b);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /exported n1\.1 → \/tmp\/stand-in\.html/);
      assert.deepEqual(seen, ['GET /api/export/active']);
    });
  }
});

// ── trust ───────────────────────────────────────────────────────────────────

test('trust: the listing and --pack say no running server, and ask the other project nothing', async (t) => {
  const { b, seen } = await foreign(t);
  const list = await cli(['trust'], b);
  assert.equal(list.status, 1, list.stdout);
  assert.match(list.stderr, /no running web-chat server for this project\./);
  assert.match(list.stderr, /Start it with `claude-web-chat open`, then open a pane that uses the service\./);
  const pack = await cli(['trust', '--pack', 'acme-ops'], b);
  assert.equal(pack.status, 1, pack.stdout);
  assert.match(pack.stderr, /no running web-chat server for this project\./);
  assert.match(pack.stderr, /No pane needs to be open/);
  assert.deepEqual(seen, []);
});

test('trust: the nudge after a grant goes to this project\'s daemon only', async (t) => {
  const { b, seen } = await foreign(t);
  assert.deepEqual(await trust.fetchPending(b), { ok: false, reason: 'no running web-chat server for this project' });
  assert.equal((await trust.fetchPackRequests(b, 'acme-ops')).reason, 'no running web-chat server for this project');
  await trust.nudge(b);
  assert.deepEqual(seen, []);
});

test('trust: this project\'s daemon is reached, through the portfile or the registry', async (t) => {
  for (const setup of [own, registryOnly]) {
    await t.test(setup.name, async (t) => {
      const { b, seen } = await setup(t);
      const list = await cli(['trust'], b);
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stdout, /No services are waiting for approval\./);
      const pack = await cli(['trust', '--pack', 'acme-ops'], b);
      assert.match(pack.stderr, /no pack named "acme-ops" is installed/);
      await trust.nudge(b);
      assert.deepEqual(seen, ['GET /api/services/pending', 'GET /api/services/pack/acme-ops', 'POST /api/services/refresh-trust']);
    });
  }
});

// ── unlock ──────────────────────────────────────────────────────────────────

test('unlock: a copied portfile is "(no server running)" and posts nothing', async (t) => {
  const { b, seen } = await foreign(t);
  const r = await cli(['unlock'], b);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '(no server running)');
  assert.deepEqual(seen, []);
});

test('unlock: this project\'s daemon is reached, through the portfile or the registry, and named by its url', async (t) => {
  for (const setup of [own, registryOnly]) {
    await t.test(setup.name, async (t) => {
      const { b, port, seen } = await setup(t);
      const r = await cli(['unlock'], b);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), `lock cleared (server http://localhost:${port})`);
      assert.deepEqual(seen, ['POST /api/unlock']);
    });
  }
});

test('unlock: a daemon that answers health only after 1 s is still this project\'s', async (t) => {
  const { b, seen } = await own(t, { delayMs: 1000 });
  const r = await cli(['unlock'], b);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^lock cleared/);
  assert.deepEqual(seen, ['POST /api/unlock']);
});

// ── identity ────────────────────────────────────────────────────────────────

test('identity: a copied portfile is no surface — the write goes direct, never to the other project', async (t) => {
  const { b, seen } = await foreign(t);
  const lines = [];
  const r = await identity(['name', 'Acme Web'], { cwd: b, log: (s) => lines.push(s) });
  assert.equal(r.via, 'direct');
  assert.match(lines.join('\n'), /written directly \(no surface running\)/);
  assert.equal(project.identity(b).name, 'Acme Web');
  assert.deepEqual(seen, []);
});

test('identity: this project\'s daemon takes the write, through the portfile or the registry', async (t) => {
  for (const setup of [own, registryOnly]) {
    await t.test(setup.name, async (t) => {
      const { b, seen } = await setup(t);
      const r = await identity(['name', 'Acme Web'], { cwd: b, log: () => {} });
      assert.equal(r.via, 'daemon');
      assert.deepEqual(seen, ['PUT /api/project/name']);
    });
  }
});

// ── init's report state ─────────────────────────────────────────────────────

test('init\'s state: a copied portfile reads as not running, and the other project is asked nothing', async (t) => {
  const { b, seen } = await foreign(t);
  const state = await gatherState({ root: b, mode: 'test', deps: { collectRows: async () => [] } });
  assert.deepEqual(state.daemon, { running: false, port: null, url: null });
  assert.deepEqual(seen, []);
});

test('init\'s state: this project\'s daemon is running, through the portfile, the registry, or a slow answer', async (t) => {
  const slow = (t) => own(t, { delayMs: 1000 });
  for (const [label, setup] of [['own', own], ['registryOnly', registryOnly], ['slow', slow]]) {
    await t.test(label, async (t) => {
      const { b, port, seen } = await setup(t);
      const state = await gatherState({ root: b, mode: 'test', deps: { collectRows: async () => [] } });
      assert.deepEqual(state.daemon, { running: true, port, url: `http://localhost:${port}` });
      assert.ok(seen.includes('GET /api/services/pending'), seen.join(', '));
    });
  }
});

test('init --tour: a copied portfile is "not running", and no tour goes to the other project', async (t) => {
  const init = require('../lib/cli/commands/init');
  const { b, seen } = await foreign(t);
  const lines = [];
  const refuse = async () => { throw new Error('no daemon call expected'); };
  await init(['--tour'], {
    cwd: b, log: (s) => lines.push(s), client: { get: refuse, post: refuse },
    collectRows: async () => [], viewerWaitMs: 0, latest: null,
  });
  assert.match(lines.join('\n'), /The surface is not running — start it with `claude-web-chat open`/);
  assert.deepEqual(seen, []);
});

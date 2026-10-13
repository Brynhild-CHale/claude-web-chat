// `uninstall --self` stops every web-chat server it can verify, the capture hub
// and the portal, then removes the program (U113@self-stops, ruled (a) by the
// maintainer 2026-10-13). It used to stop only the portal: every project's
// daemon and the hub went on running from a deleted install, with no
// `claude-web-chat stop` left on PATH to stop them.
//
// Every port a case probes is one this file opened (a stub HTTP server on port
// 0): the scan range is always injected as `scanPorts`, and the hub stop is
// always the `hubStop` seam — nothing here probes 5173..5272, where the
// maintainer's own daemons listen, or the real hub port. Every registry write
// goes to a per-test sandbox HOME. A stand-in daemon is a stub server answering
// /api/health for a real, innocent child process (a "bystander"): a stray
// SIGTERM would kill it (node's default handler), so a bystander still alive at
// the end is proof that nothing signalled it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { withTempHome } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { isPidAlive } = require('../lib/core/portfiles');
const { PROTOCOL_VERSION } = require('../lib/core/versions');
const { LISTEN_HOST } = require('../lib/core/cors');
const uninstall = require('../lib/cli/commands/uninstall');

function projectRoot(t, prefix = 'wc-unself-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function fakeClaude() {
  return () => ({ ok: true });
}

function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return { child, pid: child.pid, exited };
}

// A stub on a loopback port this file opened, answering /api/health with
// `health` and recording every /api/shutdown; with `onShutdown` it acknowledges
// and then runs it (what a daemon's own exit does).
async function stubServer(t, { health, onShutdown = null }) {
  const seen = { shutdowns: 0 };
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify(typeof health === 'function' ? health() : health));
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

function instanceHealth(pid, instance) {
  return { ok: true, role: 'instance', version: PROTOCOL_VERSION, package_version: '0.8.5', pid, ...(instance ? { instance } : {}) };
}

// A daemon of another project: a bystander pid, a stub answering as it with
// that root's instance, acknowledging a shutdown and then exiting. Registered
// in the (sandboxed) instance registry unless `register: false`.
async function standIn(t, { root, order = null, register = true, instance } = {}) {
  const b = bystander(t);
  const stub = await stubServer(t, {
    health: instanceHealth(b.pid, instance === undefined ? registry.instanceId(root) : instance),
    onShutdown: () => { if (order) order.push(`shutdown:${path.basename(root)}`); b.child.kill('SIGKILL'); },
  });
  if (register) registry.registerInstance({ root, port: stub.port, pid: b.pid });
  return { ...b, stub, root, port: stub.port };
}

async function captured(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let res;
  try { res = await fn(); } finally { console.log = prev; }
  return { res, text: lines.join('\n') };
}

// The seams every --self call here passes: a recorded hub stop and program
// removal, the injected scan, short waits, no portal.
function seams(order, extra = {}) {
  return {
    runClaude: fakeClaude(),
    knownRoots: [],
    readPortal: () => null,
    ackWaitMs: 3000,
    signalWaitMs: 1000,
    hubStop: async () => { order.push('hub'); return { stopped: true }; },
    removeProgram: () => { order.push('remove'); },
    ...extra,
  };
}

test('uninstall --self asks two verified daemons of other roots to shut down, then stops the hub, then removes the program', async (t) => {
  withTempHome(t);
  const here = projectRoot(t, 'wc-unself-here-');
  const order = [];
  const a = await standIn(t, { root: projectRoot(t, 'wc-unself-a-'), order });
  const b = await standIn(t, { root: projectRoot(t, 'wc-unself-b-'), order });
  // A Claude Code session still open in project a (a live MCP presence row).
  const mcp = bystander(t);
  const claudeParent = bystander(t);
  registry.registerMcp({ root: a.root, pid: mcp.pid, ppid: claudeParent.pid });

  const { res, text } = await captured(() => uninstall(['--self'], {
    cwd: here,
    ...seams(order, { scanPorts: [a.port, b.port] }),
  }));

  assert.equal(a.stub.shutdowns, 1, 'daemon a was asked to shut down');
  assert.equal(b.stub.shutdowns, 1, 'daemon b was asked to shut down');
  await a.exited;
  await b.exited;
  assert.deepEqual(order.slice(-2), ['hub', 'remove'], 'the hub after every daemon, the removal last');
  assert.deepEqual(new Set(order.slice(0, 2)), new Set([`shutdown:${path.basename(a.root)}`, `shutdown:${path.basename(b.root)}`]),
    'both daemons were asked before the hub and before the program was removed');
  assert.equal(res.others.stopped, 2);
  assert.deepEqual(res.hub, { stopped: true });
  assert.deepEqual(res.unverified, []);
  assert.match(text, /Stopping every other web-chat server on this machine:/);
  assert.match(text, /Claude Code sessions still open elsewhere/);
  assert.ok(text.includes(a.root), 'the open session is named by its project');
});

test('a registered row whose port answers as another pid is listed with its reason and kill hint, and never signalled', async (t) => {
  withTempHome(t);
  const order = [];
  const recorded = bystander(t); // the pid the registry names
  const answering = bystander(t); // the pid the port says it is
  const other = projectRoot(t, 'wc-unself-other-');
  const stub = await stubServer(t, { health: instanceHealth(answering.pid, registry.instanceId(other)), onShutdown: () => {} });
  registry.registerInstance({ root: other, port: stub.port, pid: recorded.pid });

  const { res, text } = await captured(() => uninstall(['--self'], {
    cwd: projectRoot(t),
    ...seams(order, { scanPorts: [] }),
  }));

  assert.equal(stub.shutdowns, 0, 'nothing was asked of a port that does not answer as the recorded pid');
  assert.ok(isPidAlive(recorded.pid) && isPidAlive(answering.pid), 'and neither pid was signalled');
  const row = res.unverified.find((u) => u.pid === recorded.pid);
  assert.ok(row, 'the row is listed');
  assert.equal(row.reason, 'identity');
  assert.equal(row.hint, `kill ${recorded.pid}`);
  assert.match(text, new RegExp(`pid ${recorded.pid} on port ${stub.port}\\) — its port answers, but not as that pid.*kill ${recorded.pid}`));
  assert.match(text, /was not stopped; the program was removed anyway/);
  assert.deepEqual(order, ['hub', 'remove'], 'a daemon that will not be stopped does not hold the removal');
});

test('the one scan stops an unregistered daemon naming a known project, and lists an older build or an unknown project with `kill <pid>`', async (t) => {
  withTempHome(t);
  const order = [];
  const known = projectRoot(t, 'wc-unself-known-');
  registry.rememberProject({ root: known });
  const found = await standIn(t, { root: known, order, register: false });
  const oldPid = bystander(t);
  const old = await stubServer(t, { health: instanceHealth(oldPid.pid, null), onShutdown: () => {} });
  const strangerPid = bystander(t);
  const stranger = await stubServer(t, { health: instanceHealth(strangerPid.pid, 'deadbeef'), onShutdown: () => {} });

  const { res, text } = await captured(() => uninstall(['--self'], {
    cwd: projectRoot(t),
    ...seams(order, { scanPorts: [found.port, old.port, stranger.port] }),
  }));

  assert.equal(found.stub.shutdowns, 1, "the known project's daemon was asked to shut down");
  await found.exited;
  assert.equal(res.others.stopped, 1);
  assert.equal(old.shutdowns, 0);
  assert.equal(stranger.shutdowns, 0);
  assert.ok(isPidAlive(oldPid.pid) && isPidAlive(strangerPid.pid), 'neither was signalled');
  const byPid = new Map(res.unverified.map((u) => [u.pid, u]));
  assert.equal(byPid.get(oldPid.pid).reason, 'older-build');
  assert.equal(byPid.get(oldPid.pid).hint, `kill ${oldPid.pid}`);
  assert.equal(byPid.get(strangerPid.pid).reason, 'unknown-instance');
  assert.match(text, new RegExp(`pid ${oldPid.pid} on port ${old.port}\\) — a web-chat server of a build before 0\\.8\\.5.*kill ${oldPid.pid}`));
  assert.match(text, new RegExp(`kill ${strangerPid.pid}`));
  assert.deepEqual(order.slice(-2), ['hub', 'remove']);
});

test('--self --keep-running stops no daemon and not the hub, and prints the kill hints instead', async (t) => {
  withTempHome(t);
  const order = [];
  const a = await standIn(t, { root: projectRoot(t, 'wc-unself-a-'), order });
  const oldPid = bystander(t);
  const old = await stubServer(t, { health: instanceHealth(oldPid.pid, null), onShutdown: () => {} });
  const hubPid = bystander(t);
  registry.registerHub({ port: 1, pid: hubPid.pid });
  // A registered row whose port answers as another pid: listed as an out-of-date
  // record ('identity'), not as a running server, and never asked.
  const recorded = bystander(t);
  const answering = bystander(t);
  const stale = projectRoot(t, 'wc-unself-stale-');
  const staleStub = await stubServer(t, { health: instanceHealth(answering.pid, registry.instanceId(stale)), onShutdown: () => {} });
  registry.registerInstance({ root: stale, port: staleStub.port, pid: recorded.pid });

  const { res, text } = await captured(() => uninstall(['--self', '--keep-running'], {
    cwd: projectRoot(t),
    ...seams(order, { scanPorts: [a.port, old.port] }),
  }));
  assert.equal(res.unverified.find((u) => u.pid === recorded.pid).reason, 'identity');
  assert.equal(res.unverified.find((u) => u.pid === a.pid).reason, 'running');
  assert.equal(staleStub.shutdowns, 0);

  assert.equal(a.stub.shutdowns, 0);
  assert.equal(old.shutdowns, 0);
  assert.deepEqual(order, ['remove'], 'the hub stop was never called; the program was still removed');
  assert.ok(isPidAlive(a.pid) && isPidAlive(oldPid.pid) && isPidAlive(hubPid.pid));
  assert.equal(res.others, null);
  assert.equal(res.hub, null);
  assert.match(text, /Left running \(--keep-running\)/);
  for (const pid of [a.pid, oldPid.pid, hubPid.pid]) assert.match(text, new RegExp(`kill ${pid}\\b`));
  assert.match(text, new RegExp(`the capture hub \\(pid ${hubPid.pid}`));
  assert.doesNotMatch(text, /Stopping every other web-chat server/);
});

test('a portal that will not stop: nothing removed, no daemon asked, the hub left alone (today\'s refusal first)', async (t) => {
  withTempHome(t);
  const order = [];
  const a = await standIn(t, { root: projectRoot(t, 'wc-unself-a-'), order });
  await assert.rejects(
    () => captured(() => uninstall(['--self'], {
      cwd: projectRoot(t),
      ...seams(order, { scanPorts: [a.port] }),
      readPortal: () => ({ role: 'portal', pid: 4242, port: 45678 }),
      tunnelDown: async () => { throw new Error('still answering'); },
    })),
    (e) => e.userFacing === true && /Nothing was removed/.test(e.message),
  );
  assert.equal(a.stub.shutdowns, 0, 'no daemon was asked');
  assert.deepEqual(order, [], 'neither the hub stop nor the removal ran');
  assert.ok(isPidAlive(a.pid));
});

test('the seam guard: --self inside the test sandbox without scanPorts or hubStop fails loudly, before anything runs', async (t) => {
  withTempHome(t);
  assert.ok(process.env.WEB_CHAT_TEST_SANDBOX, 'this file runs inside the sandbox');
  const order = [];
  const base = seams(order);
  const noScan = { ...base, cwd: projectRoot(t) };
  await assert.rejects(() => captured(() => uninstall(['--self'], noScan)), /without scanPorts/);
  const noHub = { ...base, cwd: projectRoot(t), scanPorts: [] };
  delete noHub.hubStop;
  await assert.rejects(() => captured(() => uninstall(['--self'], noHub)), /without hubStop/);
  await assert.rejects(() => captured(() => uninstall(['--self', '--keep-running'], noHub)), /without hubStop/);
  assert.deepEqual(order, []);
  // A plain uninstall needs neither.
  await captured(() => uninstall([], { ...noHub, scanPorts: [] }));
});

test('every --self call in the test tree passes scanPorts and hubStop (the sandbox guard is the backstop)', () => {
  const dir = path.join(__dirname);
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/uninstall\(\s*\[\s*'--self'/.test(src) && !(/scanPorts/.test(src) && /hubStop/.test(src))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'a test file calls uninstall --self without the scan and hub seams');
});

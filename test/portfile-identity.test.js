// The portfile says whose it is (U112). A .web-chat/ copied from another
// project carried a server.json naming THAT project's live daemon, and every
// reader acted on it: project B's MCP tools, hooks, driver and CLI talked to
// project A's daemon (design/tools/t5/run-w67-result.json, LIFECYCLE RESIDUE;
// _logs/t5/U107d/handoff.md, Open issues). A 0.8.5 daemon now writes its root
// beside pid and port (lib/core/portfiles writePortfileFile), and a reader at
// another root treats the record as absent — so a copy reads as no daemon, and
// the normal spawn path starts B's own.
//
// Two roots A and B under one tmp dir. A's daemon is an in-process stand-in
// that answers /api/health as A's instance and records every request it sees;
// A's portfile is written by the engine (its pid is this process, alive); B's
// .web-chat/server.json is a byte copy of it. Every port probed here is one this
// file opened; nothing scans 5173-5272. Each flow has a control: the record at
// its own root works exactly as before.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Writable } = require('stream');

const { withTempHome } = require('../test-support/helpers');
const portfiles = require('../lib/core/portfiles');
const { projectPaths } = require('../lib/core/paths');
const registry = require('../lib/util/registry');
const daemon = require('../lib/util/daemon');
const client = require('../lib/client');
const { createDriver } = require('../lib/driver');
const turnBegin = require('../lib/hooks/turn-begin');
const turnEnd = require('../lib/hooks/turn-end');
const mirror = require('../lib/hooks/mirror');
const ask = require('../lib/hooks/ask');
const doctor = require('../lib/cli/commands/doctor');
const status = require('../lib/cli/commands/status');

// The client and driver honour WEB_CHAT_PORT before any portfile.
delete process.env.WEB_CHAT_PORT;

const PROBE = { probeMs: 5000 };
const NOW = 1790000000123;
const SID = '9d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
const ENV = { CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli' };
const silent = () => {};

// <base>/<name> with its .web-chat/ (and graph/, which doctor reads).
function projectIn(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.web-chat', 'graph'), { recursive: true });
  return root;
}

// A's daemon: answers /api/health as A's instance (this pid), /api/asks with
// "no viewer", everything else {ok:true}; records each request.
async function standIn(t, root) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      let out = { ok: true };
      if (req.url === '/api/health') out = { ok: true, role: 'instance', pid: process.pid, instance: registry.instanceId(root) };
      else if (req.method === 'POST' && req.url === '/api/asks') out = { ok: true, id: 'ask_0123456789ab', wait: false, reason: 'no-viewer' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    return new Promise((r) => server.close(r));
  });
  return { port: server.address().port, requests };
}

// A and B; A's daemon is up and wrote its record; B holds a byte copy.
async function copied(t) {
  withTempHome(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pf-identity-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const A = projectIn(base, 'a');
  const B = projectIn(base, 'b');
  const a = await standIn(t, A);
  portfiles.writePortfile('server', { root: A, pid: process.pid, port: a.port });
  fs.copyFileSync(projectPaths(A).serverJson, projectPaths(B).serverJson);
  return { base, A, B, a };
}

// A port this test opened and closed: nothing answers on it.
async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

// String writes to stdout across an async run (Buffers pass through: the test
// runner's own protocol).
async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') { out += chunk; return true; }
    return orig(chunk, ...rest);
  };
  try { await fn(); } finally { process.stdout.write = orig; }
  return out;
}

async function captureLog(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = prev; }
  return lines.join('\n');
}

function sink() {
  return new Writable({ write(chunk, enc, cb) { cb(); } });
}

const stopPayload = (root) => ({
  hook_event_name: 'Stop', session_id: SID, transcript_path: `/u/.claude/projects/-u-p/${SID}.jsonl`, cwd: root,
  prompt_id: 'pr-1', permission_mode: 'acceptEdits', stop_hook_active: false, session_crons: [],
  last_assistant_message: 'Done.', background_tasks: [],
});
const askPayload = (root) => ({
  session_id: SID, transcript_path: `/Users/someone/.claude/projects/-p/${SID}.jsonl`, cwd: root,
  hook_event_name: 'PermissionRequest', prompt_id: 'c0ffee00-prompt', permission_mode: 'default',
  tool_name: 'Bash', tool_input: { command: 'npm run build', description: 'Build' },
});

// doctor looks for the capture hub: on a port this file opened and closed.
test.before(async () => { process.env.WEB_CHAT_HUB_PORT = String(await closedPort()); });

// ── the reader's rule ───────────────────────────────────────────────────────

test("B's byte copy of A's record reads as no record; asked for by name it is marked foreign", async (t) => {
  const { A, B, a } = await copied(t);
  assert.equal(portfiles.readPortfile('server', { root: B }), null);
  assert.equal(portfiles.readPortfile('server', { root: B, checkLiveness: false }), null);
  const raw = portfiles.readPortfile('server', { root: B, checkLiveness: false, includeForeign: true });
  assert.equal(raw.foreign, path.resolve(A));
  assert.equal(raw.port, a.port);
  // Control: A's own record.
  const own = portfiles.readPortfile('server', { root: A });
  assert.equal(own.port, a.port);
  assert.equal(own.root, path.resolve(A));
  assert.equal(own.instance, registry.instanceId(A));
  assert.equal(own.foreign, undefined);
});

test('a record with no root field (an older daemon wrote it) reads exactly as today, wherever it is', async (t) => {
  const { B, a } = await copied(t);
  const file = projectPaths(B).serverJson;
  const { root: _r, instance: _i, proc_start: _p, ...older } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(older));
  const info = portfiles.readPortfile('server', { root: B });
  assert.deepEqual(info, {
    pid: process.pid, port: a.port, url: `http://localhost:${a.port}`, started_at: older.started_at,
    root: null, instance: null, proc_start: null,
  });
  // Pinned as today's behaviour (a later change to it is deliberate): the
  // client still discovers what such a record names.
  assert.equal(client.discoverPort({ root: B }), a.port);
});

test('two spellings of one root are the same root: a symlink, and /var vs /private/var on macOS', async (t) => {
  withTempHome(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pf-identity-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const real = projectIn(base, 'real');
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link);
  portfiles.writePortfile('server', { root: link, pid: process.pid, port: 45021 });
  assert.equal(JSON.parse(fs.readFileSync(projectPaths(real).serverJson, 'utf8')).root, link);
  const viaReal = portfiles.readPortfile('server', { root: real });
  assert.ok(viaReal, 'written through the link, read through the real path');
  assert.equal(viaReal.foreign, undefined);

  const tmp = os.tmpdir();
  const tmpReal = fs.realpathSync(tmp);
  if (tmp === tmpReal) { t.diagnostic('os.tmpdir() is already its realpath here; the symlink case covers it'); return; }
  const spelled = fs.mkdtempSync(path.join(tmp, 'wc-pf-var-'));
  t.after(() => { try { fs.rmSync(spelled, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(spelled, '.web-chat'), { recursive: true });
  const privateSpelling = fs.realpathSync(spelled);
  assert.notEqual(privateSpelling, spelled);
  portfiles.writePortfile('server', { root: privateSpelling, pid: process.pid, port: 45022 });
  const info = portfiles.readPortfile('server', { root: spelled });
  assert.ok(info, `${privateSpelling} and ${spelled} are one root`);
  assert.equal(info.port, 45022);
});

// ── the consumers ───────────────────────────────────────────────────────────

test('lib/client: api() with root B and no spawn throws NoServerError, and A sees no request', async (t) => {
  const { A, B, a } = await copied(t);
  assert.equal(client.discoverPort({ root: B }), null);
  await assert.rejects(client.api('GET', '/api/health', null, { root: B, spawn: false }), (e) => e instanceof client.NoServerError);
  assert.deepEqual(a.requests, [], "A's daemon is never reached");
  // Control.
  const h = await client.api('GET', '/api/health', null, { root: A, spawn: false });
  assert.equal(h.instance, registry.instanceId(A));
  assert.equal(a.requests.length, 1);
});

test('lib/driver: createDriver with root B throws NoServerError', async (t) => {
  const { A, B, a } = await copied(t);
  assert.throws(() => createDriver({ owner: 'pf-test', root: B }), (e) => e instanceof client.NoServerError);
  // Control.
  const d = createDriver({ owner: 'pf-test', root: A });
  assert.equal(d.port, a.port);
});

test('turn-begin with root B reports no server and posts nothing to A', async (t) => {
  const { A, B, a } = await copied(t);
  const out = await captureStdout(() => turnBegin({ prompt: 'hi' }, { root: B, ...PROBE, env: {} }));
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /No web-chat daemon is running/);
  assert.deepEqual(a.requests, [], 'no probe, no /api/turn-begin');
  // Control.
  await captureStdout(() => turnBegin({ prompt: 'hi' }, { root: A, ...PROBE, env: {}, now: NOW }));
  assert.ok(a.requests.some((r) => r.method === 'POST' && r.url === '/api/turn-begin'));
});

test('turn-end with root B makes A record no request at all (neither /api/turn-end nor /api/unlock)', async (t) => {
  const { A, B, a } = await copied(t);
  await turnEnd(stopPayload(B), { root: B, ...PROBE, env: ENV, now: NOW });
  assert.deepEqual(a.requests, []);
  // Control.
  await turnEnd(stopPayload(A), { root: A, ...PROBE, env: ENV, now: NOW });
  assert.ok(a.requests.some((r) => r.method === 'POST' && r.url === '/api/turn-end'));
});

test("mirror's postEnvelope with root B returns 'no-server'", async (t) => {
  const { A, B, a } = await copied(t);
  const envelope = { v: 1, event: 'SessionStart', ts: NOW, session_id: SID };
  assert.equal(await mirror.postEnvelope(envelope, { root: B }), 'no-server');
  assert.deepEqual(a.requests, []);
  // Control.
  assert.equal(await mirror.postEnvelope(envelope, { root: A }), 'posted');
  assert.ok(a.requests.some((r) => r.url === mirror.INTAKE_PATH));
});

test("ask with root B returns 'no-daemon' and posts nothing to A", async (t) => {
  const { A, B, a } = await copied(t);
  assert.equal(await ask(askPayload(B), { root: B, now: NOW, env: ENV, stdout: sink() }), 'no-daemon');
  assert.deepEqual(a.requests, []);
  // Control.
  const r = await ask(askPayload(A), { root: A, now: NOW, env: ENV, stdout: sink() });
  assert.notEqual(r, 'no-daemon');
  assert.ok(a.requests.some((q) => q.method === 'POST' && q.url === '/api/asks'));
});

test("registry.daemonFor(B) is null and never probes A's port", async (t) => {
  const { A, B, a } = await copied(t);
  const probed = [];
  const probe = async (port, ms) => { probed.push(port); return portfiles.probeHealth(port, ms); };
  assert.equal(await registry.daemonFor(B, { probe }), null);
  assert.deepEqual(probed, []);
  // Control.
  const found = await registry.daemonFor(A, { probe });
  assert.deepEqual([found && found.port, found && found.source], [a.port, 'portfile']);
  assert.deepEqual(probed, [a.port]);
});

test("doctor removes B's copy with the copied-from line, and leaves it under --dry-run", async (t) => {
  const { A, B, a } = await copied(t);
  const runClaude = () => ({ ok: true });
  const file = projectPaths(B).serverJson;
  const line = `removed .web-chat/server.json: it was copied from ${path.resolve(A)} and named that project's server`;

  const dry = await doctor([], { cwd: B, runClaude, log: silent, dryRun: true });
  assert.equal(fs.existsSync(file), true, 'dry-run removes nothing');
  const hit = dry.checks.find((c) => c.m === line);
  assert.ok(hit, dry.checks.map((c) => c.m).join('\n'));
  assert.equal(hit.dry, true);

  const summary = await doctor([], { cwd: B, runClaude, log: silent });
  assert.equal(fs.existsSync(file), false);
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && c.m === line));
  assert.ok(fs.existsSync(projectPaths(A).serverJson), "A's own record is A's");
  assert.ok(!a.requests.some((r) => r.url === '/api/health'), "A's daemon was never probed for B");

  // Control: A's own record is a running daemon to doctor.
  const own = await doctor([], { cwd: A, runClaude, log: silent, dryRun: true });
  assert.ok(own.checks.some((c) => c.status === 'ok' && /daemon running at/.test(c.m)));
});

test('status names B\'s copy on the Server line instead of "running"', async (t) => {
  const { A, B, a } = await copied(t);
  const out = await captureLog(() => status([], { cwd: B }));
  assert.match(out, new RegExp(`Server: +not running — \\.web-chat/server\\.json was copied from ${path.resolve(A).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and names that project's server \\(\`claude-web-chat doctor\` removes it\\)`));
  assert.doesNotMatch(out, /Server: +running/);
  assert.deepEqual(a.requests, [], 'status never asked A anything');
  // Control.
  const own = await captureLog(() => status([], { cwd: A }));
  assert.match(own, new RegExp(`Server: +running at http://localhost:${a.port} \\(pid ${process.pid}`));
});

// ── a reused pid ────────────────────────────────────────────────────────────

// A record of `root` naming a live child the test spawned (not a daemon), on a
// port nothing answers, with the given proc_start.
async function reusedRecord(t, startOffsetMs) {
  withTempHome(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pf-identity-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const root = projectIn(base, 'p');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const real = (await portfiles.sampleProcs([child.pid])).get(child.pid);
  assert.equal(real.alive, true, 'the child is sampled alive');
  const port = await closedPort();
  fs.writeFileSync(projectPaths(root).serverJson, JSON.stringify({
    pid: child.pid, port, url: `http://localhost:${port}`, started_at: Date.now(),
    root: path.resolve(root), instance: registry.instanceId(root), proc_start: real.startedAt + startOffsetMs,
  }));
  return { root, pid: child.pid, port };
}

test('doctor removes a record whose live pid is another process now (its proc_start is not that process\'s)', async (t) => {
  const { root, pid } = await reusedRecord(t, -3_600_000);
  const summary = await doctor([], { cwd: root, runClaude: () => ({ ok: true }), log: silent });
  assert.equal(fs.existsSync(projectPaths(root).serverJson), false);
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && c.m === `removed .web-chat/server.json: its pid ${pid} is another process now, not this project's server`),
    summary.checks.map((c) => c.m).join('\n'));
});

test("status says the portfile's pid is another process now", async (t) => {
  const { root, pid } = await reusedRecord(t, -3_600_000);
  const out = await captureLog(() => status([], { cwd: root }));
  assert.match(out, new RegExp(`Server: +not running — the portfile names pid ${pid}, which is another process now`));
});

test("the child's real start: doctor leaves the record and keeps today's 'try restart' warning", async (t) => {
  const { root, pid, port } = await reusedRecord(t, 0);
  const summary = await doctor([], { cwd: root, runClaude: () => ({ ok: true }), log: silent });
  assert.equal(fs.existsSync(projectPaths(root).serverJson), true);
  assert.ok(summary.checks.some((c) => c.status === 'problem' && c.m.includes(`daemon pid ${pid} is alive but not answering on port ${port}`)),
    summary.checks.map((c) => `${c.status} ${c.m}`).join('\n'));
});

// ── a dead pid ──────────────────────────────────────────────────────────────

test('a dead-pid record: lib/client discovery returns null and api() takes the spawn path', async (t) => {
  withTempHome(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pf-identity-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const root = projectIn(base, 'p');
  const dead = require('child_process').spawnSync(process.execPath, ['-e', '']).pid;
  const port = await closedPort();
  portfiles.writePortfile('server', { root, pid: dead, port });
  // A dead daemon's port may be some other server's now: never the target.
  assert.equal(client.discoverPort({ root }), null);

  const spawned = [];
  const real = daemon.spawnDaemon;
  daemon.spawnDaemon = async (r) => { spawned.push(r); return null; };
  t.after(() => { daemon.spawnDaemon = real; });
  await assert.rejects(client.api('GET', '/api/health', null, { root, spawn: true }), (e) => e instanceof client.NoServerError);
  assert.deepEqual(spawned, [root], 'the spawn path, for this root');
});

// ── a dead pid, through the core engine (U117) ──────────────────────────────
// lib/core/portfiles discoverPort is what the driver, `profile reload` and a
// pack's announce use. A crashed daemon's record still names its port, and
// that port is often another project's daemon now: here, a listener this test
// opened, which counts every request it sees.

// A pid that was real and is gone: a child spawned and awaited to exit.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.once('exit', r));
  assert.equal(portfiles.isPidAlive(child.pid), false, 'the child has exited');
  return child.pid;
}

// A root whose portfile names `pid` and a listener's port.
async function recordAt(t, pid) {
  withTempHome(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pf-identity-'));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const root = projectIn(base, 'p');
  const other = await standIn(t, projectIn(base, 'other'));
  portfiles.writePortfile('server', { root, pid, port: other.port });
  return { root, other };
}

test('a dead-pid record: portfiles.discoverPort is null, createDriver throws NoServerError, profile reload finds no daemon, and the port\'s new owner sees nothing', async (t) => {
  const { root, other } = await recordAt(t, await deadPid());
  assert.equal(portfiles.discoverPort({ role: 'server', root, env: true }), null);

  let driver = null;
  let err = null;
  try { driver = createDriver({ owner: 'pf-test', root }); } catch (e) { err = e; }
  // Were a driver handed back, show what it would do: write to that surface.
  if (driver) await driver.getStore().catch(() => {});
  assert.ok(err instanceof client.NoServerError, `createDriver threw ${err && err.message}`);

  const profile = require('../lib/cli/commands/profile');
  const cwd = process.cwd();
  let out;
  try {
    process.chdir(root);
    out = await captureLog(() => profile(['reload']));
  } finally { process.chdir(cwd); }
  assert.match(out, /no running daemon/);

  assert.deepEqual(other.requests, [], 'the listener on the dead daemon\'s port is never reached');
});

test('the same record with a live pid (this process) discovers its port (control)', async (t) => {
  const { root, other } = await recordAt(t, process.pid);
  assert.equal(portfiles.discoverPort({ role: 'server', root, env: true }), other.port);
  assert.equal(createDriver({ owner: 'pf-test', root }).port, other.port);
  assert.equal(client.discoverPort({ root }), other.port);
});

test('an explicit port and WEB_CHAT_PORT still win over a dead-pid record', async (t) => {
  const { root } = await recordAt(t, await deadPid());
  const explicit = await closedPort();
  assert.equal(portfiles.discoverPort({ role: 'server', root, port: explicit, env: true }), explicit);
  assert.equal(portfiles.discoverPort({ role: 'server', root, port: String(explicit) }), explicit);
  assert.equal(createDriver({ owner: 'pf-test', root, port: explicit }).port, explicit);

  const envPort = await closedPort();
  process.env.WEB_CHAT_PORT = String(envPort);
  t.after(() => { delete process.env.WEB_CHAT_PORT; });
  assert.equal(portfiles.discoverPort({ role: 'server', root, env: true }), envPort);
  assert.equal(createDriver({ owner: 'pf-test', root }).port, envPort);
  assert.equal(client.discoverPort({ root }), envPort);
  // env stays opt-in on the core engine: without it the dead record is no daemon.
  assert.equal(portfiles.discoverPort({ role: 'server', root }), null);
});

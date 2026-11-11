// Tranche 6 end to end (U790): THE CONNECTOR, and the daemon halves, against
// test-support/fake-hub.js — the connector composed in process through
// lib/connector/run.js (CONNECTOR@install-seam), the daemons real children of
// `claude-web-chat start` spawned through the walk seam (WEB_CHAT_FIRST_PORT)
// in the band 6420–6439, the relay secret handed on fd 3.
//
// THE SANDBOX. A short HOME under /tmp (a Unix socket path must fit sun_path:
// the connector's local socket lives in ~/.web-chat/connector), realpath'd so
// every root is its canonical spelling, over npm test's process sandbox; the
// Claude tier is test-support/claude-home's (one enabled plugin); every
// connector path is resolved through lib/core/paths and asserted inside that
// HOME before a write. The service manager is a stub that records argv (no
// launchctl, systemctl or tmux runs); `connect attach`'s session command is a
// stub script named claude on a PATH holding nothing else (never Claude Code);
// `claude --version` is a stub; the capture hub port is held by a dummy
// listener in the band, so a daemon's ensureHub starts no hub. The fake hub
// listens on 127.0.0.1:0 and its port is asserted outside 5170, 5171 and
// 5173–5272; the band is probed by binding, never by connecting.
//
// The steps, one test each, in the order the world allows (13 stops every
// daemon, so 15, 16 and 17 run before it; 14 sweeps everything after it):
//   (1) pair · (2) hello · (3) offer · (4) assign · (5) supervised daemons ·
//   (6) a relayed read, a refused write · (7) the clamped stamp · (8) the WS
//   read-drop and 4403 · (9) events.batch across a restart · (10) one
//   delivery for a repeated client_msg_id · (11) heartbeats and viewer_peers ·
//   (12) connect attach · (15) C-04.25's second proof · (16) machine.facts
//   with a plugin · (17) the relayed resolver report · the AG-1 shape check
//   against alpha.6 and alpha.5 (it needs the daemon) · (13) disconnect ·
//   (14) the secret sweep · (18) a revocation, in a second world of its own
//   (no machine.leave; hand fold 6 (f)'s secret-holding deny).
//
// Nothing here prints a pairing code, a key, a relay secret or a token: a
// failure message passes masked().

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const { waitUntil } = require('../test-support/helpers');
const { createFakeHub, isReservedPort } = require('../test-support/fake-hub');
const { claudeHome } = require('../test-support/claude-home');
const { createValidator } = require('../test-support/contracts-loader');
const { userPaths, projectPaths, isInside } = require('../lib/core/paths');
const { LISTEN_HOST } = require('../lib/core/cors');
const { RELAY_HEADER } = require('../lib/core/writer-token');
const { LEVEL_HEADER } = require('../lib/core/cors');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const client = require('../lib/client');
const registry = require('../lib/util/registry');
const daemonUtil = require('../lib/util/daemon');
const setup = require('../lib/setup/connector');
const cli = require('../lib/connector/cli');
const runMod = require('../lib/connector/run');
const factsMod = require('../lib/connector/facts');
const supervisorMod = require('../lib/connector/supervisor');
const chatsMod = require('../lib/connector/chats');
const alogMod = require('../lib/connector/authority-log');

const SCALED = Object.freeze({ setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 300)), clearTimeout });

const HUB = 'hub-test';
const BAND = [6420, 6439];
const RESERVED = (p) => p === 5170 || p === 5171 || (p >= 5173 && p <= 5272);
const inBand = (p) => Number.isInteger(p) && p >= BAND[0] && p <= BAND[1];
const LINE_RE = /^pairing code ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}) · fingerprint (SHA256:[A-Za-z0-9+/]{43}) · expires /;
// A path (perhaps not made yet) inside dir: lib/core/paths isInside over the
// nearest existing spelling.
const within = (dir, p) => isInside(dir, p);
const modeOf = (file) => fs.statSync(file).mode & 0o777;
const validator = createValidator({ folders: 'all' });

// ── the world every step shares ────────────────────────────────────────────
const W = {
  cleanups: [],
  secrets: [],          // every relay secret the supervisor's generator made
  out: [],              // the connector's and the CLI's own output lines
  calls: [],            // every argv the stubbed service manager was handed
  stubArgv: [],         // what the stub session command recorded
};
const W2 = { secrets: [], out: [] };   // (18)'s world
const masked = (s) => {
  let t = String(s);
  for (const x of [...W.secrets, ...W2.secrets, W.code, W.code && W.code.replace('-', '')]) if (x) t = t.split(x).join('<masked>');
  return t;
};
test.after(async () => {
  for (const fn of W.cleanups.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
});

// A short, canonical HOME under /tmp (sun_path), restored at the end.
function shortHome() {
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(base, 'wce-')));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  W.cleanups.push(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return home;
}

// A port in the band is free when it can be bound (never probed by a connect).
function bindable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, LISTEN_HOST, () => s.close(() => resolve(true)));
  });
}

// The capture hub's port, held by a listener that is not a hub: a daemon's
// ensureHub then finds it taken and starts no hub process.
async function holdHubPort() {
  for (let p = BAND[1]; p >= BAND[0]; p--) {
    if (!(await bindable(p))) continue;
    const socks = new Set();
    const s = net.createServer((sock) => {
      socks.add(sock);
      sock.on('close', () => socks.delete(sock));
      sock.on('error', () => {});
      sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(p, LISTEN_HOST, resolve); });
    W.cleanups.push(() => new Promise((r) => { for (const k of socks) k.destroy(); s.close(() => r()); }));
    return p;
  }
  throw new Error('no free port in the band for the hub stand-in');
}

async function firstFree() {
  for (let p = BAND[0]; p <= BAND[1] - 4; p++) {
    let all = true;
    for (let i = 0; i < 4; i++) if (!(await bindable(p + i))) { all = false; break; }
    if (all) return p;
  }
  throw new Error('no run of four free ports in the band');
}

// The env every daemon this file starts inherits: the walk seam, the hub
// stand-in, nothing of WEB_CHAT_PORT.
function daemonEnv() {
  const env = { ...process.env, WEB_CHAT_FIRST_PORT: String(W.firstPort), WEB_CHAT_HUB_PORT: String(W.hubPort) };
  delete env.WEB_CHAT_PORT;
  return env;
}

// Every daemon of a root this file may have started, stopped at the end.
function reapRoot(root) {
  W.cleanups.push(async () => {
    let rows = [];
    try { rows = (await registry.daemonsFor(root, { scan: false })).daemons; } catch { rows = []; }
    for (const r of rows || []) {
      try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ }
    }
    await waitUntil(async () => !(await registry.daemonFor(root)), { timeout: 5000 }).catch(() => {});
  });
}

const host = (port, method, p, body, headers = {}) => client.request(port, method, p, body, { headers, timeout: 10000 });
const json = (r) => { try { return typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch { return null; } };
const readRec = () => { const r = setup.readRecord(HUB); return r.ok ? r.value : null; };
const framesIn = (kind) => W.fake.frames.filter((f) => f.dir === 'in' && f.kind === kind);
const chatStatus = (id) => framesIn('chat.status').map((f) => f.frame.status).filter((s) => s.chat_id === id);

// ── (1) pairing ─────────────────────────────────────────────────────────────

test('(1) pair with a single-use code: the code printed once and logged nowhere; the key file 0600 in the 0700 connector directory; the unit written inside the sandbox HOME through the stubbed service manager', async () => {
  const home = shortHome();
  W.home = home;
  assert.ok(within(home, userPaths().root), 'the user tier is the sandbox HOME\'s');
  W.firstPort = await firstFree();
  W.hubPort = await holdHubPort();
  assert.ok(inBand(W.firstPort) && inBand(W.hubPort));

  // The Claude tier: one enabled plugin with a server and a skill (16).
  const tierRoot = path.join(home, 'tier-root');
  fs.mkdirSync(tierRoot);
  const ch = claudeHome({ after: (fn) => W.cleanups.push(fn) }, { root: tierRoot, isolate: true });
  const install = path.join(ch.dir, 'plugins', 'cache', 'mk', 'inkwell', '1.0.0');
  ch.write('.claude.json', JSON.stringify({ mcpServers: { 'user-srv': { command: 'x' } } }));
  ch.write('skills/user-skill/SKILL.md', '---\nname: user-skill\n---\n');
  ch.write('settings.json', JSON.stringify({ enabledPlugins: { 'inkwell@mk': true } }));
  ch.write('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'inkwell@mk': [{ scope: 'user', installPath: install, version: '1.0.0' }] } }));
  ch.write('plugins/cache/mk/inkwell/1.0.0/.mcp.json', JSON.stringify({ mcpServers: { pens: { command: 'x' } } }));
  ch.write('plugins/cache/mk/inkwell/1.0.0/skills/sketch/SKILL.md', '---\nname: sketch\n---\n');

  // The fake hub on 127.0.0.1:0, outside the reserved ports.
  W.fake = createFakeHub({ pollAfterMs: 10, pollHoldMs: 50, heartbeatMs: 5000, deadAfterMs: 15000 });
  await W.fake.start();
  W.cleanups.push(() => W.fake.stop());
  assert.ok(!isReservedPort(W.fake.port) && !RESERVED(W.fake.port), `the fake's port ${W.fake.port} is outside 5170, 5171, 5173–5272`);

  // The managed install's ~/.local/bin link, a PATH directory, the workdir.
  const target = path.join(home, '.web-chat', 'versions', '0.9.0-alpha.7', 'bin', 'claude-web-chat.js');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const linkPath = path.join(home, '.local', 'bin', 'claude-web-chat');
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
  W.pathDir = path.join(home, 'path-bin');
  fs.mkdirSync(W.pathDir);
  W.workdir = path.join(home, 'work');
  fs.mkdirSync(W.workdir);

  // The unit and the key: inside this HOME, by lib/core/paths, before any write.
  W.unitFile = setup.unitFor('launchd').unit_path;
  assert.ok(within(home, W.unitFile), 'the LaunchAgent is the sandbox HOME\'s');
  assert.ok(within(home, setup.unitFor('systemd-user').unit_path), 'the systemd unit is the sandbox HOME\'s');
  assert.ok(within(home, userPaths().connectorKey(HUB)) && within(home, userPaths().connectorSocket(HUB)));
  assert.ok(Buffer.byteLength(userPaths().connectorSocket(HUB)) < 104, 'the socket path fits sun_path');

  const deps = {
    out: (l) => W.out.push(String(l)),
    err: (l) => W.out.push(String(l)),
    describeInstall: () => ({ kind: 'managed', linkPath }),
    getuid: () => 501,
    platform: 'darwin',
    platformKind: () => 'launchd',
    env: { PATH: W.pathDir },
    findClaude: () => null,
    run: (argv) => { W.calls.push(argv.slice()); return Buffer.alloc(0); },
    waitMs: 20000,
    signals: new EventEmitter(),
    connectorRow: () => null,
  };
  const done = cli.main([W.fake.url, '--insecure-loopback', '--workdir', W.workdir], deps);
  W.code = await waitUntil(() => { const m = W.out.length && LINE_RE.exec(W.out[0]); return m && m[1]; }, { timeout: 10000, what: 'the pairing line' });
  assert.equal(W.fake.pairing.confirm(W.code, { name: 'Studio Mac' }).ok, true);
  assert.equal(W.fake.pairing.confirm(W.code, { name: 'Again' }).ok, false, 'the code is single-use');

  // The connector, composed in process, starts once the record is paired; the
  // install's step (5) waits for its first acknowledged hello.
  await waitUntil(() => { const r = readRec(); return r && r.credential.state === 'paired'; }, { timeout: 10000, what: 'the paired record' });
  startConnector();
  assert.equal(await done, 0, masked(W.out.join('\n')));

  const rec = readRec();
  W.machineId = rec.machine.id;
  const keyFile = userPaths().connectorKey(HUB);
  assert.equal(rec.credential.key_file, keyFile);
  assert.equal(modeOf(keyFile), 0o600, 'the key file 0600');
  assert.equal(modeOf(userPaths().connectorDir), 0o700, 'in the 0700 connector directory');
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
  W.keyForms = keyForms(key, fs.readFileSync(keyFile, 'utf8'));
  assert.equal(W.out.filter((l) => l.includes(W.code)).length, 1, 'the code printed once');
  assert.ok(fs.existsSync(W.unitFile), 'the LaunchAgent written');
  assert.ok(!fs.readFileSync(W.unitFile, 'utf8').includes(W.code));
  assert.ok(W.calls.length >= 1 && W.calls.every((a) => a[0] === 'launchctl'), 'the service manager is the stub: launchctl argv recorded, never run');
  assert.equal(rec.workdir, W.workdir);
});

// The private key's every text form this file sweeps for (14).
function keyForms(key, pem) {
  const jwk = key.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.d, 'base64url');
  const der = key.export({ type: 'pkcs8', format: 'der' });
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return [jwk.d, raw.toString('hex'), raw.toString('base64'), der.toString('base64'), body.slice(0, 40)];
}

// The connector: lib/connector/run.js in process, every program it would run
// stubbed and every generator it draws a relay secret from recorded.
function startConnector(S = W, extra = {}) {
  S.signals = new EventEmitter();
  S.skew = 0;
  const runInit = async (root) => {
    fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
    return 0;
  };
  // The service manager, stubbed for every path the connector may take to it
  // (a revocation's unload included): argv recorded, nothing run.
  const stubRun = (argv) => { W.calls.push(argv.slice()); return Buffer.alloc(0); };
  S.done = runMod.run(['--insecure-loopback'], {
    out: (l) => S.out.push(String(l)),
    err: (l) => S.out.push(String(l)),
    getuid: () => 501,
    signals: S.signals,
    createFacts: (o) => factsMod.createFacts({
      ...o,
      runClaude: async () => ({ ok: true, stdout: '2.1.300 (Claude Code)\n' }),
      exec: { findProgram: () => null, isExecutable: () => false, run: async () => ({ ok: false }) },
      platform: 'linux',
    }),
    createSupervisor: (o) => {
      const sup = supervisorMod.createSupervisor({
        ...o,
        deps: {
          env: daemonEnv(),
          now: () => Date.now() + S.skew,
          randomBytes: (n) => {
            const b = crypto.randomBytes(n);
            S.secrets.push(b.toString('hex'));
            return b;
          },
        },
      });
      S.supervisor = sup;
      return sup;
    },
    createChats: (o) => chatsMod.createChats({ ...o, deps: { runInit } }),
    // The authority log's 60 s coalescing window, scaled to 300 ms through its
    // install's timers seam, so a deny ships within the step.
    installAuthorityLog: (ctx) => alogMod.install({ ...ctx, timers: SCALED }),
    disconnectLocal: (o) => setup.disconnectLocal({ ...o, deps: { ...(o.deps || {}), run: stubRun } }),
    ...extra,
  });
  S.stopped = false;
  S.stop = async () => { if (!S.stopped) { S.stopped = true; S.signals.emit('SIGTERM'); } return S.done; };
  W.cleanups.push(() => S.stop());
}

// ── (2) hello ───────────────────────────────────────────────────────────────

test('(2) hello and hello.ack in the compat window; every frame sent and received validates against its schema in test-support/contracts', async () => {
  await W.fake.waitFor('hello', { dir: 'in' });
  await W.fake.waitFor('hello.ack', { dir: 'out' });
  const ack = W.fake.find('hello.ack', { dir: 'out' })[0].frame;
  assert.equal(ack.compat.state, 'ok', 'inside the compat window');
  const hello = W.fake.find('hello', { dir: 'in' })[0].frame;
  assert.equal(hello.route_table.table_version, 1);
  await W.fake.waitFor('machine.facts', { dir: 'in' });
  for (const f of W.fake.frames) {
    if (f.ch === 'pairing') continue;
    assert.ok(validator.validateFrame(f.frame).ok, `${f.dir} ${f.kind} validates`);
  }
  assert.deepEqual(W.fake.errors, [], 'the fake recorded no invalid frame');
});

// ── (3) a folder offered ────────────────────────────────────────────────────

test('(3) offer a folder: C-06.13\'s refusals for HOME, the user tier, the workdir and a missing path; an offered folder re-sends machine.facts', async () => {
  const folders = require('../lib/connector/folders');
  const deps = { runInit: async () => assert.fail('no init for a refused or initialised folder') };
  const refusedFor = async (p) => (await folders.offer(p, { hubId: HUB, deps })).refused;
  assert.equal(await refusedFor(W.home), 'home-directory');
  assert.equal(await refusedFor(userPaths().root), 'inside-user-tier');
  assert.match(await refusedFor(W.workdir), /workdir/);
  assert.equal(await refusedFor(path.join(W.home, 'no-such-folder')), 'missing');
  // The user's own project: initialised already, offered with a label.
  W.folder = path.join(W.home, 'notes');
  fs.mkdirSync(path.join(W.folder, '.web-chat'), { recursive: true });
  const factsBefore = framesIn('machine.facts').length;
  const out = [];
  const code = await cli.main(['offer', W.folder, '--label', 'notes'], { out: (l) => out.push(l), err: (l) => out.push(l), folderDeps: deps });
  assert.equal(code, 0, out.join('\n'));
  const f = readRec().folders.find((x) => x.path === W.folder);
  assert.ok(f, 'the folder is in the record at its real path');
  W.folderId = f.id;
  await waitUntil(() => framesIn('machine.facts').length > factsBefore, { timeout: 10000, what: 'machine.facts re-sent' });
  const facts = framesIn('machine.facts').pop().frame;
  const sent = facts.folders.find((x) => x.id === W.folderId);
  assert.ok(sent, 'the offered folder travels');
  assert.equal(sent.path, W.folder, 'whole, as 06\'s folder object (C-11.6: the only paths the hub learns)');
});

// ── (4) two chats, in rev order ─────────────────────────────────────────────

test('(4) assign a space chat and a folder chat in rev order: a stale rev is ignored; a refused assignment reaches the hub as chat.status refused', async () => {
  // The folder's own daemon, started by its user before any assignment (no
  // secret): the connector adopts it, started_by other.
  W.userDaemon = await daemonUtil.spawnDaemon(W.folder, { env: daemonEnv() });
  reapRoot(W.folder);
  assert.ok(W.userDaemon && inBand(W.userDaemon.port), `the user's daemon in the band (${W.userDaemon && W.userDaemon.port})`);
  // Its user's browser is watching (a local socket), so the lifecycle's idle
  // restart (C-06.19: an adopted daemon with no viewer becomes the
  // connector's own) leaves it adopted while (5) and (7) look at it.
  W.viewer = new WebSocket(`ws://localhost:${W.userDaemon.port}/ws`);
  await new Promise((resolve, reject) => { W.viewer.once('open', resolve); W.viewer.once('error', reject); });
  W.viewer.on('error', () => { /* the daemon goes at the end */ });
  W.cleanups.push(() => { try { W.viewer.terminate(); } catch { /* closed */ } });
  W.space = W.fake.mintLabel();
  W.folderChat = W.fake.mintLabel();
  W.unknown = W.fake.mintLabel();
  W.fake.assign({ chat_id: W.space, rev: 1, scope: { kind: 'space' } });
  W.fake.assign({ chat_id: W.folderChat, rev: 1, scope: { kind: 'folder', folder_id: W.folderId } });
  await waitUntil(() => { const r = readRec(); return r && r.chats.length === 2; }, { timeout: 20000, what: 'both chats mapped' });
  W.spaceRoot = readRec().chats.find((c) => c.chat_id === W.space).root;
  reapRoot(W.spaceRoot);
  assert.equal(W.spaceRoot, path.join(W.workdir, 'spaces', W.space), 'the space root under the workdir');
  assert.equal(readRec().chats.find((c) => c.chat_id === W.folderChat).root, W.folder);
  // rev 2, then a late rev 1: the record keeps 2.
  W.fake.assign({ chat_id: W.folderChat, rev: 2, scope: { kind: 'folder', folder_id: W.folderId } });
  await waitUntil(() => readRec().chats.find((c) => c.chat_id === W.folderChat).rev === 2, { timeout: 10000, what: 'rev 2 applied' });
  W.fake.send({ ch: 'control', kind: 'chat.assign', assignment: W.fake.assignment({ chat_id: W.folderChat, rev: 1, scope: { kind: 'folder', folder_id: W.folderId } }), cursor: { type: 'source', chat_id: W.folderChat, ring: 'main', boot: null, seq: 0, capture_seq: 0, element_seq: 0 } });
  // A folder this machine never offered: refused, and the hub is told.
  W.fake.assign({ chat_id: W.unknown, rev: 1, scope: { kind: 'folder', folder_id: 'f_0000000000000000' } });
  await waitUntil(() => chatStatus(W.unknown).some((s) => s.state === 'refused' && s.reason === 'unknown-folder'), { timeout: 10000, what: 'chat.status refused for the unknown folder' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readRec().chats.find((c) => c.chat_id === W.folderChat).rev, 2, 'the late rev 1 was ignored');
  assert.equal(readRec().chats.length, 2, 'the refused chat is not mapped');
});

// ── (5) supervised daemons ──────────────────────────────────────────────────

test('(5) a supervised daemon per chat: the space chat\'s spawned with the secret on fd 3 (started_by connector, its relay credential valid), the folder chat\'s adopted (other); a second racing spawn adopts', async () => {
  await waitUntil(() => chatStatus(W.space).some((s) => s.state === 'running') && chatStatus(W.folderChat).some((s) => s.state === 'running'),
    { timeout: 30000, interval: 100, what: 'both chats running' });
  assert.equal(W.supervisor.startedBy(W.space), 'connector');
  assert.equal(W.supervisor.startedBy(W.folderChat), 'other');
  const spaceStatus = chatStatus(W.space).filter((s) => s.state === 'running').pop();
  assert.equal(spaceStatus.daemon.started_by, 'connector');
  assert.equal(chatStatus(W.folderChat).filter((s) => s.state === 'running').pop().daemon.started_by, 'other');
  W.spaceDaemon = await registry.daemonFor(W.spaceRoot);
  assert.ok(W.spaceDaemon && inBand(W.spaceDaemon.port), `the space daemon in the band (${W.spaceDaemon && W.spaceDaemon.port})`);
  assert.equal((await registry.daemonFor(W.folder)).pid, W.userDaemon.pid, 'the folder\'s own daemon, adopted');

  // The secret: the generator's, handed on fd 3 and never through the env.
  W.secret = W.supervisor.relayCredential(W.space);
  assert.ok(W.secret && W.secrets.includes(W.secret), 'the secret the injected generator made');
  assert.equal(W.supervisor.relayCredential(W.folderChat), null, 'an adopted daemon holds no secret of ours');
  const log = fs.readFileSync(projectPaths(W.spaceRoot).serverLog, 'utf8');
  assert.match(log, /connected mode: a relay secret was handed \(fd\)/, 'the daemon took it on fd 3');
  // The credential is valid: a read stamp beside it reads at read; without it basic.
  const at = (headers) => host(W.spaceDaemon.port, 'GET', '/api/mirror/tasks', null, { 'X-WC-Remote': '1', ...headers });
  assert.equal((await at({ [RELAY_HEADER]: W.secret, [LEVEL_HEADER]: 'read' })).status, 200, 'a valid credential at read');
  assert.equal((await at({ [RELAY_HEADER]: crypto.randomBytes(32).toString('hex'), [LEVEL_HEADER]: 'read' })).status, 403, 'a wrong secret is basic');

  // A second spawn for the same root, racing the first: it adopts.
  const other = supervisorMod.createSupervisor({ hubId: HUB, deps: { env: daemonEnv() } });
  const r = await other.ensureRunning({ id: W.space, root: W.spaceRoot });
  assert.equal(r.state, 'running');
  assert.equal(r.pid, W.spaceDaemon.pid, 'the same daemon');
  assert.equal(r.started_by, 'other', 'adopted, never ours');
  const all = (await registry.daemonsFor(W.spaceRoot, { scan: false })).daemons;
  assert.deepEqual(all.map((x) => x.pid), [W.spaceDaemon.pid], 'one daemon for the root');
});

// ── helpers for the relayed steps ───────────────────────────────────────────

// A decision for a chat at a level, its version above every one this file has
// handed the chat before (the relay keeps the highest per principal and chat).
const versions = new Map();
function dec(chat, daemonLevel, extra = {}) {
  const v = (versions.get(chat) || 0) + 1;
  versions.set(chat, v);
  return W.fake.decision({ chat, daemon_level: daemonLevel, version: v, ...extra });
}
const relayed = (secret, level, extra = {}) => ({
  'X-WC-Remote': '1', ...(secret ? { [RELAY_HEADER]: secret } : {}), ...(level ? { [LEVEL_HEADER]: level } : {}), ...extra,
});
const bodyOf = (r) => { try { return JSON.parse(Buffer.isBuffer(r.body) ? r.body.toString('utf8') : r.body); } catch { return null; } };
async function ringSince(port, since) {
  const r = await host(port, 'GET', `/api/events?since=${since}`);
  const b = json(r);
  return (b && b.events) || [];
}
async function latestSeq(port) {
  const r = json(await host(port, 'GET', '/api/events?since=0'));
  return (r && Number.isInteger(r.latest)) ? r.latest : ((r && r.events) || []).reduce((m, e) => Math.max(m, e.seq || 0), 0);
}
const COMMENT = (shared) => ({ type: 'comment', anchor: { mount: 'e2e-m1', selector: 'p.lead', text: 'Hello', ordinal: 0 }, payload: { text: 'a relayed note', shared } });

// ── (6) a relayed read, a refused write ─────────────────────────────────────

test('(6) a relayed GET at read answers; a write at the hub\'s read decision is refused by the connector first (no daemon entry), and sent straight to the daemon with a valid credential and a read stamp is refused by the daemon second', async () => {
  const port = W.spaceDaemon.port;
  const rendered = await host(port, 'POST', '/api/render', { id: 'e2e-m1', html: '<p class="lead">Hello world</p>' });
  assert.equal(rendered.status, 200, `render: ${masked(rendered.body)}`);
  const read = await W.fake.relayHttp({ chat: W.space, method: 'GET', path: '/api/graph', decision: dec(W.space, 'read') });
  assert.equal(read.status, 200, 'a relayed read at read answers');
  assert.ok(bodyOf(read) && bodyOf(read).nodes, 'the graph, relayed');

  const before = await latestSeq(port);
  const deniesBefore = W.fake.find('authority.log', { dir: 'in' }).length;
  const body = Buffer.from(JSON.stringify(COMMENT(true)));
  const w = await W.fake.relayHttp({
    chat: W.space, method: 'POST', path: '/api/elements', body,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    decision: dec(W.space, 'read'),
  });
  assert.equal(w.status, 403, 'the connector refuses it');
  assert.ok(bodyOf(w) && bodyOf(w).ok === false);
  const after = await ringSince(port, before);
  assert.ok(!after.some((e) => /element/.test(String(e.kind))), 'the daemon\'s ring holds no entry for it');
  await waitUntil(() => W.fake.find('authority.log', { dir: 'in' }).length > deniesBefore, { timeout: 10000, what: 'the connector\'s deny shipped' });
  const rec = W.fake.find('authority.log', { dir: 'in' }).flatMap((f) => f.frame.records).pop();
  assert.equal(rec.enforcer, 'connector', 'refused at the connector');
  assert.equal(rec.sink, 'log');

  const direct = await host(port, 'POST', '/api/elements', COMMENT(true), relayed(W.secret, 'read'));
  assert.equal(direct.status, 403, 'the daemon refuses a read stamp beside a valid credential');
  assert.equal((await ringSince(port, before)).filter((e) => /element/.test(String(e.kind))).length, 0, 'still no element entry');
});

// ── (7) the stamp, the ceiling, and what is basic ───────────────────────────

test('(7) a stamp of full under a ceiling of read is served at read (the lesser); no credential, a repeated stamp and an adopted daemon\'s request are basic', async () => {
  const port = W.spaceDaemon.port;
  const READ_ROUTE = '/api/mirror/tasks';
  setup.setCeiling(HUB, 'read');
  // The daemon follows the record (lib/core/watch): a full stamp now writes nothing.
  await waitUntil(async () => (await host(port, 'POST', '/api/elements', COMMENT(true), relayed(W.secret, 'full'))).status === 403,
    { timeout: 10000, interval: 100, what: 'the read ceiling applied' });
  assert.equal((await host(port, 'GET', READ_ROUTE, null, relayed(W.secret, 'full'))).status, 200, 'served at read');
  // The connector refuses a full decision's write under the read ceiling first.
  const body = Buffer.from(JSON.stringify(COMMENT(true)));
  const viaHub = await W.fake.relayHttp({
    chat: W.space, method: 'POST', path: '/api/elements', body,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) }, decision: dec(W.space, 'full'),
  });
  assert.equal(viaHub.status, 403, 'the connector\'s ceiling');
  setup.setCeiling(HUB, 'full');
  await waitUntil(async () => (await host(port, 'GET', READ_ROUTE, null, relayed(W.secret, 'full'))).status === 200, { timeout: 10000 });

  assert.equal((await host(port, 'GET', READ_ROUTE, null, relayed(null, 'full'))).status, 403, 'a stamp with no credential is basic');
  const twice = await host(port, 'GET', READ_ROUTE, null, { 'X-WC-Remote': '1', [RELAY_HEADER]: W.secret, [LEVEL_HEADER]: ['read', 'read'] });
  assert.equal(twice.status, 403, 'a repeated stamp is basic');
  // The adopted (folder) daemon holds no secret of ours: the relay sends no
  // credential, so the daemon reads the hub's read decision as basic.
  const adopted = await W.fake.relayHttp({ chat: W.folderChat, method: 'GET', path: READ_ROUTE, decision: dec(W.folderChat, 'read') });
  assert.equal(adopted.status, 403, 'an adopted daemon\'s request is basic');
});

// ── (8) the WS read-drop and 4403 ───────────────────────────────────────────

test('(8) a relayed WS at read: store:set, event, pane:form, pane:state and script:error are dropped (C-04.18a); a decision change closes it with 4403', async () => {
  const port = W.spaceDaemon.port;
  const ws = W.fake.relayWs({ chat: W.space, decision: dec(W.space, 'read') });
  assert.equal(await ws.opened, true);
  await waitUntil(() => ws.messages.length >= 1, { timeout: 10000, what: 'the hello' });
  const before = await latestSeq(port);
  const storeBefore = json(await host(port, 'GET', '/api/store'));
  for (const m of [
    { type: 'store:set', patch: { e2e_dropped: 1 } },
    { type: 'event', event: { kind: 'click', mount: 'e2e-m1' } },
    { type: 'pane:form', mount: 'e2e-m1', form_state: { ':0': 'x' } },
    { type: 'pane:state', mount: 'e2e-m1', state: { minimized: true } },
    { type: 'script:error', mount: 'e2e-m1', message: 'x' },
  ]) ws.send(JSON.stringify(m));
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(json(await host(port, 'GET', '/api/store')), storeBefore, 'the store unchanged');
  const entries = await ringSince(port, before);
  assert.ok(!entries.some((e) => ['store', 'event', 'script-error', 'pane'].includes(e.kind)), `nothing entered the ring: ${entries.map((e) => e.kind).join(',')}`);
  W.fake.sendDecision(dec(W.space, 'full'));
  const closed = await ws.closed;
  assert.equal(closed.code, 4403, 'a decision change closes it with 4403');
});

// ── (9) events.batch across a restart ───────────────────────────────────────

test('(9) a capture, then a daemon restart: an events.batch carries the capture; after the restart the ring is re-based by X-WC-Boot with no gap and no duplicate', async () => {
  const port = W.spaceDaemon.port;
  const boot1 = (await client.request(port, 'GET', '/api/health', null, {})).headers['x-wc-boot'];
  assert.match(boot1, /^[0-9a-f]{32}$/);
  const cap = await host(port, 'POST', '/api/capture', { url: 'https://example.test/page', title: 'Example', html: '<p>captured</p>', kind: 'selection' });
  assert.equal(cap.status, 200, masked(cap.body));
  await waitUntil(() => framesIn('events.batch').some((f) => f.frame.batch.chat_id === W.space && f.frame.batch.boot === boot1
    && f.frame.batch.entries.some((e) => e.kind === 'capture')), { timeout: 15000, what: 'the capture in an events.batch' });

  // The restart: the connector's daemon stops; the lifecycle reconnects and the
  // supervisor spawns again (its once-per-10 s limit passed, on its clock).
  W.skew += 11000;
  const before = W.secrets.length;
  process.kill(W.spaceDaemon.pid, 'SIGTERM');
  await waitUntil(async () => { const d = await registry.daemonFor(W.spaceRoot); return d && d.pid !== W.spaceDaemon.pid && d; },
    { timeout: 30000, interval: 200, what: 'the respawned daemon' });
  W.spaceDaemon = await registry.daemonFor(W.spaceRoot);
  assert.ok(inBand(W.spaceDaemon.port));
  assert.ok(W.secrets.length > before, 'a new secret for the new daemon');
  await waitUntil(() => W.supervisor.relayCredential(W.space), { timeout: 10000, what: 'the new credential' });
  W.secret = W.supervisor.relayCredential(W.space);
  const boot2 = (await client.request(W.spaceDaemon.port, 'GET', '/api/health', null, {})).headers['x-wc-boot'];
  assert.notEqual(boot2, boot1);
  await host(W.spaceDaemon.port, 'POST', '/api/store', { patch: { e2e_after_restart: 1 } });
  await waitUntil(() => framesIn('events.batch').some((f) => f.frame.batch.chat_id === W.space && f.frame.batch.boot === boot2
    && f.frame.batch.entries.some((e) => e.kind === 'store')), { timeout: 15000, what: 'the new boot\'s batch' });

  const batches = framesIn('events.batch').map((f) => f.frame.batch).filter((b) => b.chat_id === W.space);
  const seen = new Set();
  for (const b of batches) {
    for (const e of b.entries) {
      const k = `${b.boot}:${e.seq}`;
      assert.ok(!seen.has(k), `no duplicate: ${k}`);
      seen.add(k);
    }
    if (b.gap) assert.equal(b.gap.dropped, 0, 'no entry dropped');
  }
  const first2 = batches.find((b) => b.boot === boot2);
  assert.equal(first2.contiguous, false, 'the new boot starts a new run');
  assert.ok(first2.gap && first2.gap.reset === true && first2.gap.dropped === 0, 'one restart gap, nothing dropped');
  const seqs2 = batches.filter((b) => b.boot === boot2).flatMap((b) => b.entries.map((e) => e.seq));
  assert.deepEqual(seqs2, [...seqs2].sort((a, b) => a - b), 'in ring order');
  assert.equal(seqs2[0], 1, 're-based: the new ring from its first entry');
});

// ── (10) one delivery for a repeated client_msg_id ──────────────────────────

test('(10) a queue delivery repeated once with the same client_msg_id: one message in the daemon\'s queue, the second answered duplicate: true, one queue.ack each', async () => {
  const port = W.spaceDaemon.port;
  const first = W.fake.queue.hold(W.space, { message: { text: 'from the hub, once', send: 'auto' } }, { decision: dec(W.space, 'full') });
  await waitUntil(() => W.fake.queue.delivered.filter((d) => d.hub_msg_id === first.hub_msg_id).length === 1, { timeout: 15000, what: 'the first ack' });
  W.fake.queue.hold(W.space, { hub_msg_id: first.hub_msg_id, attempt: 2, message: { text: 'from the hub, once', send: 'auto' } }, { decision: dec(W.space, 'full') });
  await waitUntil(() => W.fake.queue.delivered.filter((d) => d.hub_msg_id === first.hub_msg_id).length === 2, { timeout: 15000, what: 'the second ack' });
  const acks = W.fake.queue.delivered.filter((d) => d.hub_msg_id === first.hub_msg_id).map((d) => d.ack);
  assert.equal(acks[0].outcome, 'accepted');
  assert.equal(acks[1].outcome, 'duplicate', 'the second answered duplicate');
  assert.equal(acks[0].daemon.msg_id, acks[1].daemon.msg_id, 'the first message\'s id');
  // The daemon's record of what it accepted (U748): one entry for the id.
  const accepted = JSON.parse(fs.readFileSync(projectPaths(W.spaceRoot).acceptedMessages, 'utf8')).accepted;
  assert.equal(accepted.filter((a) => a.client_msg_id === first.hub_msg_id).length, 1, 'accepted once');
  // One message: no channel here, so it is parked — one receipt, one id.
  const q = json(await host(port, 'GET', '/api/queue'));
  const held = [...(q.items || []), ...(q.receipts || [])].filter((i) => i.msg_id === acks[0].daemon.msg_id);
  assert.equal(held.length, 1, 'one message in the daemon\'s queue');
  assert.equal((q.items || []).length + (q.receipts || []).length, 1, 'and nothing else');
});

// ── (11) heartbeats ─────────────────────────────────────────────────────────

test('(11) heartbeats carry the chats\' rows and the status viewer_peers (a relayed socket counted remote); a stopped chat\'s row reads stopped', async () => {
  const ws = W.fake.relayWs({ chat: W.space, decision: dec(W.space, 'read') });
  assert.equal(await ws.opened, true);
  await waitUntil(() => chatStatus(W.space).some((s) => s.daemon && s.daemon.viewer_peers && s.daemon.viewer_peers.remote === 1),
    { timeout: 15000, interval: 100, what: 'viewer_peers with the relayed socket remote' });
  const s = chatStatus(W.space).filter((x) => x.daemon && x.daemon.viewer_peers && x.daemon.viewer_peers.remote === 1).pop();
  assert.equal(s.daemon.viewer_peers.local, 0);
  const n = framesIn('heartbeat').length;
  await waitUntil(() => framesIn('heartbeat').slice(n).some((f) => f.frame.beat.chats.some((c) => c.chat_id === W.space && c.daemon === 'running' && c.viewers === 1)),
    { timeout: 15000, interval: 100, what: 'a heartbeat row with the viewer' });
  ws.close(1000);
  await ws.closed;

  // The folder chat stopped by the hub (desired stopped): its row reads stopped.
  W.fake.assign({ chat_id: W.folderChat, rev: 3, scope: { kind: 'folder', folder_id: W.folderId }, desired: 'stopped' });
  const m = framesIn('heartbeat').length;
  await waitUntil(() => framesIn('heartbeat').slice(m).some((f) => f.frame.beat.chats.some((c) => c.chat_id === W.folderChat && c.daemon === 'stopped')),
    { timeout: 15000, interval: 100, what: 'the stopped chat\'s heartbeat row' });
  const last = framesIn('heartbeat').pop().frame.beat.chats.find((c) => c.chat_id === W.folderChat);
  assert.notEqual(last.daemon, 'running');
});

// ── (12) connect attach ─────────────────────────────────────────────────────

test('(12) connect attach <label> runs the stub session command in the chat root with WEB_CHAT_CHANNEL=1 and WEB_CHAT_SUPERVISED=<root>', async () => {
  const bin = path.join(W.home, 'stub-bin');
  fs.mkdirSync(bin);
  const record = path.join(W.home, 'stub-session.txt');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n{ pwd; echo "$WEB_CHAT_CHANNEL"; echo "$WEB_CHAT_SUPERVISED"; for a in "$@"; do echo "$a"; done; } > '${record}'\nexit 0\n`, { mode: 0o755 });
  const out = [];
  const code = await cli.main(['attach', W.space], {
    out: (l) => out.push(l), err: (l) => out.push(l),
    env: { ...process.env, PATH: bin }, stdio: 'ignore',
  });
  assert.equal(code, 0, out.join('\n'));
  const lines = fs.readFileSync(record, 'utf8').trim().split('\n');
  W.stubArgv.push(...lines);
  assert.equal(fs.realpathSync(lines[0]), W.spaceRoot, 'in the chat root');
  assert.equal(lines[1], '1', 'WEB_CHAT_CHANNEL=1');
  assert.equal(lines[2], W.spaceRoot, 'WEB_CHAT_SUPERVISED=<root>');
  assert.deepEqual(lines.slice(3), ['--dangerously-load-development-channels', 'server:web-chat']);
  assert.equal(typeof readRec().chats.find((c) => c.chat_id === W.space).manual_attach_at, 'number');
});

// ── (15) C-04.25's second proof ─────────────────────────────────────────────

test('(15) C-04.25, the second proof: a remote create with payload.shared: false — portal-shaped and relayed — is refused for a page family and a chat family before the family switch', async () => {
  const port = W.spaceDaemon.port;
  // The tunnel's opt-in at full for this root, so a portal-shaped request
  // reaches the element routes at all (the daemon follows the file).
  writeJsonAtomic(userPaths().tunnelConfig, {
    hostname: 'wc.example.test', style: 'flat',
    access: { team: 'testteam', aud: 'test-aud-0123456789' },
    allow: { emails: ['me@example.com'], domains: [] },
    remote: { mirror: { [W.spaceRoot]: 'full' } },
  });
  await host(port, 'POST', '/api/render', { id: 'e2e-m1', html: '<p class="lead">Hello world</p>' });
  const bodies = {
    'a page family (comment)': COMMENT(false),
    'a chat family (chat-comment)': { type: 'chat-comment', anchor: { kind: 'turn', turn_id: 't-1' }, payload: { text: 'a private chat pin', shared: false } },
  };
  const PRIVATE = 'private elements are not available remotely';
  for (const [what, body] of Object.entries(bodies)) {
    for (const [via, headers] of [['portal-shaped', { 'X-WC-Remote': '1' }], ['relayed at full', relayed(W.secret, 'full')]]) {
      const r = await waitUntil(async () => {
        const x = await host(port, 'POST', '/api/elements', body, headers);
        return json(x) && json(x).error === PRIVATE ? x : null;
      }, { timeout: 10000, interval: 100, what: `${what} ${via}: the private refusal` });
      assert.equal(r.status, 403, `${what}, ${via}`);
      assert.deepEqual({ ok: json(r).ok, remote: json(r).remote }, { ok: false, remote: true });
    }
  }
  // Through the hub at full: the daemon's refusal, passed through as it is.
  const b = Buffer.from(JSON.stringify(COMMENT(false)));
  const viaHub = await W.fake.relayHttp({
    chat: W.space, method: 'POST', path: '/api/elements', body: b,
    headers: { 'content-type': 'application/json', 'content-length': String(b.length) }, decision: dec(W.space, 'full'),
  });
  assert.equal(viaHub.status, 403);
  assert.equal(bodyOf(viaHub).error, PRIVATE);
  // A shared create through the same path is accepted (the refusal is the private one).
  const shared = await host(port, 'POST', '/api/elements', COMMENT(true), relayed(W.secret, 'full'));
  assert.equal(shared.status, 200, masked(JSON.stringify(shared.body)));
});

// ── (16) machine.facts with an enabled plugin ───────────────────────────────

test('(16) machine.facts with one enabled plugin in the Claude tier lists its MCP server and skill names beside the user-scope names, and validates against 05-machine-facts (H9 b; GT-23)', async () => {
  const facts = framesIn('machine.facts').pop().frame;
  for (const n of ['plugin:inkwell:pens', 'user-srv']) assert.ok(facts.mcp_servers.includes(n), `server ${n}`);
  for (const n of ['inkwell:sketch', 'user-skill']) assert.ok(facts.skills.includes(n), `skill ${n}`);
  const v = validator.validateFrame(facts);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.ok(!JSON.stringify(facts).includes('installPath') && !JSON.stringify(facts).includes(path.join('plugins', 'cache')), 'names only');
});

// ── (17) the relayed resolver report ────────────────────────────────────────

test('(17) a relayed resolver report through the answer origin: at full under a full ceiling accepted; at read refused by the connector first; straight to the daemon with a read stamp or no stamp refused (H17 b, held at full; GT-24)', async () => {
  const port = W.spaceDaemon.port;
  await host(port, 'GET', '/api/asks?ensure=1');
  const health = json(await host(port, 'GET', '/api/health'));
  const aport = health.answer && health.answer.port;
  assert.ok(Number.isInteger(aport), 'the answer surface is up');
  // A shared pin on a pane, and the surface counter a viewer's hello carries.
  const pinned = json(await host(port, 'POST', '/api/elements', COMMENT(true)));
  const pin = pinned.pin || pinned.element;
  const viewer = new WebSocket(`ws://localhost:${port}/ws`);
  const hello = await new Promise((resolve, reject) => {
    viewer.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'hello') resolve(m); });
    viewer.once('error', reject);
  });
  viewer.terminate();
  const mount = (hello.mounts || []).find((m) => m.id === 'e2e-m1');
  const report = () => ({ reports: [{ surface: hello.surface, mounts: [{ mount: 'e2e-m1', gen: (mount && mount.gen) || 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }] }] });

  // The frame's document through the hub, for its nonce.
  const doc = await W.fake.relayHttp({
    chat: W.space, surface: 'answer', method: 'GET', path: '/answer/elements/report?layout=report&mode=light&device=mobile',
    headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' }, decision: dec(W.space, 'full'),
  });
  assert.equal(doc.status, 200, doc.body.toString().slice(0, 200));
  const nonce = /name="wc-answer-nonce" content="([^"]*)"/.exec(doc.body.toString())[1];
  const answerOrigin = W.fake.decision({ chat: W.space }).origins.answer;
  const post = (decision) => {
    const b = Buffer.from(JSON.stringify(report()));
    return W.fake.relayHttp({
      chat: W.space, surface: 'answer', method: 'POST', path: '/answer/api/elements/report', body: b, decision,
      headers: {
        'content-type': 'application/json', 'content-length': String(b.length), origin: answerOrigin,
        'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'x-wc-answer': nonce,
      },
    });
  };
  const full = await post(dec(W.space, 'full'));
  assert.equal(full.status, 200, full.body.toString().slice(0, 300));
  assert.equal(bodyOf(full).ok, true);
  assert.equal(bodyOf(full).accepted, 1, 'accepted');

  const shippedBefore = W.fake.find('authority.log', { dir: 'in' }).length;
  const atRead = await post(dec(W.space, 'read'));
  assert.equal(atRead.status, 403, 'refused at read');
  assert.equal(bodyOf(atRead).ok, false);
  // By the connector first: its table's write_page row (C-06.27), shipped as
  // a connector deny on the answer origin.
  await waitUntil(() => W.fake.find('authority.log', { dir: 'in' }).slice(shippedBefore).flatMap((f) => f.frame.records)
    .some((r) => r.enforcer === 'connector' && r.origin === 'answer' && r.path === '/answer/api/elements/report' && r.need === 'write_page'),
  { timeout: 10000, what: 'the connector\'s deny for the report at read' });

  // Straight to the daemon's answer port: a valid credential with a read
  // stamp, and with no stamp — refused by the daemon (its rule).
  const direct = (stamp) => client.request(aport, 'POST', '/answer/api/elements/report', report(), {
    headers: {
      origin: `http://127.0.0.1:${aport}`, 'sec-fetch-site': 'same-origin', 'x-wc-answer': nonce, ...relayed(W.secret, stamp),
    },
    timeout: 10000,
  });
  for (const [what, stamp] of [['a read stamp', 'read'], ['no stamp', null]]) {
    const r = await direct(stamp);
    assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  const ok = await direct('full');
  assert.equal(ok.status, 200, 'the same request at full is the daemon\'s to accept');
});

// ── AG-1: the tranche-6 project read as alpha.6 and alpha.5 read it ─────────

const SHAPES = {
  'alpha.6': JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alpha6-log-shape.json'), 'utf8')),
  'alpha.5': JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alpha5-log-shape.json'), 'utf8')),
};
const ACTOR = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-support', 'contracts', 'examples', '03-actor-header.json'), 'utf8'));
// The residuals tranche 6 adds, each kept by an older reader and ignored: the
// actor sibling on a relayed version (U743) and the accepted-message record
// (U748). Anything else outside a shape fails.
const RESIDUAL_VER_KEYS = ['actor'];

// lib/core/element-log.js compiled with an older build's SIBLINGS (U743's
// in-process half): the reader alpha.6 and alpha.5 run over these records.
function olderElementLog(siblings) {
  const Module = require('module');
  const file = require.resolve('../lib/core/element-log');
  const { SIBLINGS } = require('../lib/core/element-log');
  const src = fs.readFileSync(file, 'utf8');
  const now = `const SIBLINGS = [${SIBLINGS.map((k) => `'${k}'`).join(', ')}];`;
  assert.equal(src.split(now).length, 2, 'the SIBLINGS line is spelled once');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src.replace(now, `const SIBLINGS = [${siblings.map((k) => `'${k}'`).join(', ')}];`), file);
  assert.deepEqual(m.exports.SIBLINGS, siblings);
  return m.exports;
}

test('AG-1 (in-suite half): the tranche-6 project\'s log records and node files read as alpha.6 and alpha.5 read them, against the two fixtures; node ids, the comment count and the log\'s prefix unchanged; the actor sibling and the accepted-message record kept and ignored', async () => {
  const port = W.spaceDaemon.port;
  // Plant the actor sibling: a relayed create carrying 03's actor header.
  const planted = await host(port, 'POST', '/api/elements', COMMENT(true), relayed(W.secret, 'full', { 'X-WC-Actor': JSON.stringify(ACTOR) }));
  assert.equal(planted.status, 200, JSON.stringify(planted.body).slice(0, 200));
  // Commit a node that pins it.
  assert.equal((await host(port, 'POST', '/api/turn-begin', { message: 'ag-1' })).status, 200);
  assert.equal((await host(port, 'POST', '/api/turn-end', { author: 'claude', summary: 'ag-1' })).status, 200);
  const pp = projectPaths(W.spaceRoot);
  assert.ok(fs.existsSync(pp.acceptedMessages), 'the accepted-message record is on disk (10)');
  const logFile = pp.elementsLog;
  const bytes = fs.readFileSync(logFile, 'utf8');
  const recs = bytes.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const withActor = recs.filter((r) => r.t === 'ver' && r.actor);
  assert.equal(withActor.length, 1, 'one version carries the actor sibling');

  for (const [name, SHAPE] of Object.entries(SHAPES)) {
    const residual = new Set();
    let comments = 0;
    for (const r of recs) {
      assert.ok(SHAPE.record_types.includes(r.t), `${name}: its index knows every record type: ${r.t}`);
      if (r.t === 'el' || r.t === 'commit') {
        assert.deepStrictEqual(Object.keys(r).filter((k) => !SHAPE.record_keys[r.t].includes(k)), [], `${name}: ${r.t} keys`);
      }
      if (r.t === 'commit') assert.ok(new RegExp(SHAPE.node_id).test(r.node), r.node);
      if (r.t !== 'ver') continue;
      const extra = Object.keys(r).filter((k) => !SHAPE.record_keys.ver.includes(k));
      for (const k of extra) {
        assert.ok(RESIDUAL_VER_KEYS.includes(k), `${name}: ${r.id}@${r.v} key ${k} is a named residual`);
        residual.add(k);
      }
      assert.ok(SHAPE.id_letters.includes(r.id[0]), `${name}: ${r.id}: an id letter it knows`);
      const row = SHAPE.schemas[r.schema];
      assert.ok(row, `${name}: ${r.schema} is a schema it knows`);
      for (const k of Object.keys(r.payload || {})) assert.ok(row.keys.includes(k), `${name}: payload key ${k}`);
      const anchor = r.payload && r.payload.anchor;
      if (anchor && anchor.kind) assert.ok(SHAPE.engine_kinds.includes(anchor.kind), `${name}: anchor kind ${anchor.kind}`);
      if (row.type === 'comment') comments++;
    }
    assert.deepEqual([...residual], ['actor'], `${name}: the one residual on a version is the actor sibling`);
    assert.ok(comments >= 3, `${name}: the comments read (${comments})`);

    // The older reader over a copy: every version found, the actor kept as an
    // unknown field and ignored, nothing rewritten.
    const older = olderElementLog(SHAPE.siblings);
    const dir = fs.mkdtempSync(path.join(W.home, 'ag1-'));
    const copy = path.join(dir, 'log.jsonl');
    fs.writeFileSync(copy, bytes);
    const reader = older.createElementLog({ file: copy, redactor: require('../lib/core/redact').createRedactor() });
    reader.load();
    for (const r of recs.filter((x) => x.t === 'ver')) assert.ok(reader.version(r.id, r.v), `${name} reads ${r.id}@${r.v}`);
    const v = reader.version(withActor[0].id, withActor[0].v);
    assert.deepEqual(v.actor, withActor[0].actor, `${name}: the actor kept as an unknown field`);
    assert.equal(v.payload_hash, withActor[0].payload_hash, `${name}: and outside the hash`);
    reader.close();
    assert.ok(fs.readFileSync(copy, 'utf8').startsWith(bytes), `${name}: the log's prefix unchanged`);
  }
  // The accepted-message record: alpha.6 names it nowhere and its paths hold
  // no key for it, so it is left as it is (alpha.5's fixture predates the
  // field; an older build cannot know a newer file).
  assert.deepEqual(SHAPES['alpha.6'].accepted_messages_named_in, []);
  assert.ok(!SHAPES['alpha.6'].project_paths_keys.includes('acceptedMessages'));
  assert.ok('acceptedMessages' in pp, 'named by this build only');

  // The node files: ids and comment counts as both read them.
  const nodes = fs.readdirSync(pp.graphDir).filter((x) => /^n\d+\.json$/.test(x));
  assert.ok(nodes.length >= 1, 'a node committed');
  for (const f of nodes) {
    const n = JSON.parse(fs.readFileSync(path.join(pp.graphDir, f), 'utf8'));
    for (const [name, SHAPE] of Object.entries(SHAPES)) {
      assert.ok(new RegExp(SHAPE.node_id).test(n.id) && Number.isFinite(n.created_at), `${name}: ${f} a node it reads`);
      for (const c of n.comments || []) assert.ok(SHAPE.id_letters.includes(String(c.id)[0]), `${name}: ${n.id}'s comment copy`);
    }
  }
});

// ── (13) disconnect ─────────────────────────────────────────────────────────

test('(13) connect disconnect with the composed connector running: machine.leave then connector.release-all over the local socket (handled once in process, no frame for it); every started_by connector daemon stopped; no key, no unit file, the record revoked, the roots kept', async () => {
  const before = { leave: framesIn('machine.leave').length, frames: W.fake.frames.length };
  const releaseLines = () => W.out.filter((l) => / release-all: /.test(l)).length;
  assert.equal(releaseLines(), 0);
  assert.ok(fs.existsSync(userPaths().connectorSocket(HUB)), 'the connector\'s socket is up');
  const out = [];
  const exitCode = process.exitCode;
  // THE CLI FACE: lib/cli/commands/connect.js binds the row's ask to
  // askConnector; the service manager is the stub (never launchctl).
  await require('../lib/cli/commands/connect')(['disconnect'], {
    out: (l) => out.push(String(l)), err: (l) => out.push(String(l)),
    prompt: { close() {} },
    run: (argv) => { W.calls.push(argv.slice()); return Buffer.alloc(0); },
  });
  const code = process.exitCode;
  process.exitCode = exitCode;
  const text = out.join('\n');
  assert.equal(code, 0, masked(text));
  assert.match(text, /the running connector released every hold and stopped its daemons/, 'via the connector, no direct shutdown');
  assert.match(text, /the hub was told this machine is leaving/);
  assert.match(text, new RegExp(`left running: chat ${W.folderChat}'s daemon`), 'the folder chat\'s own daemon left running and named (H10 a)');
  assert.equal(framesIn('machine.leave').length, before.leave + 1, 'one machine.leave');
  assert.equal(releaseLines(), 1, 'the in-process release ran once');
  const after = W.fake.frames.slice(before.frames);
  assert.ok(!after.some((f) => f.kind === 'hub.request' || JSON.stringify(f.frame).includes('release-all')), 'no frame for connector.release-all');
  assert.equal(await registry.daemonFor(W.spaceRoot), null, 'the connector\'s daemon stopped');
  assert.ok(await registry.daemonFor(W.folder), 'the user\'s folder daemon kept');
  assert.ok(!fs.existsSync(userPaths().connectorKey(HUB)), 'no key');
  assert.ok(!fs.existsSync(W.unitFile), 'no unit file');
  assert.equal(readRec().credential.state, 'revoked', 'the record revoked');
  assert.ok(fs.existsSync(W.spaceRoot) && fs.existsSync(W.folder) && fs.existsSync(W.workdir), 'the roots kept');
  assert.ok(W.calls.some((a) => a[0] === 'launchctl' && a.includes('bootout')), 'the unload went to the stub');
});

// ── (14) the secret sweep ───────────────────────────────────────────────────

// Every file under dir, as bytes.
function filesUnder(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
function sweep(where, needles, extraTexts = {}) {
  const hits = [];
  for (const f of where) {
    let text;
    try { text = fs.readFileSync(f).toString('latin1'); } catch { continue; }
    for (const [what, n] of needles) if (n && text.includes(n)) hits.push(`${what} in ${path.relative(W.home, f)}`);
  }
  for (const [label, text] of Object.entries(extraTexts)) {
    for (const [what, n] of needles) if (n && text.includes(n)) hits.push(`${what} in ${label}`);
  }
  return hits;
}

test('(14) THE SECRET SWEEP: the relay secrets, the private key\'s bytes and the pairing code are found nowhere — the sandbox HOME (roots, logs, the connector\'s and the authority log, the daemons\' server.log), the fake hub\'s frame record, the stubs\' argv', async () => {
  assert.ok(W.secrets.length >= 2, 'the space daemon\'s secret, and its restart\'s');
  const needles = [
    ...W.secrets.map((s) => ['a relay secret', s]),
    ...W.keyForms.map((k) => ['the private key', k]),
    ['the pairing code', W.code], ['the pairing code', W.code.replace('-', '')],
  ];
  const files = [...filesUnder(W.home), ...filesUnder(path.dirname(process.env.CLAUDE_CONFIG_DIR || W.home))];
  assert.ok(files.some((f) => f === userPaths().connectorAuthorityLog), 'the authority log is swept');
  assert.ok(files.some((f) => f === projectPaths(W.spaceRoot).serverLog), 'a daemon\'s server.log is swept');
  // The code's one contracted appearance: the pairing line printed once (1).
  const printed = W.out.filter((l) => !LINE_RE.test(l));
  const hits = sweep(files, needles, {
    'the fake hub\'s frames': JSON.stringify(W.fake.frames.map((f) => f.frame)),
    'the connector\'s log and the CLI output': printed.join('\n'),
    'the stub session\'s argv': W.stubArgv.join('\n'),
    'the service manager\'s argv': JSON.stringify(W.calls),
  });
  assert.deepEqual(hits, [], 'seen nowhere');
  // The sweep can see: the pairing line itself holds the code.
  assert.equal(sweep([], needles, { 'the pairing line': W.out.find((l) => LINE_RE.test(l)) }).length, 1);
  assert.deepEqual(W.fake.errors, [], 'every frame validated');
});

// ── (18) a revocation, in a world of its own ────────────────────────────────

test('(18) a revocation: machine.revoked runs the local half in process — no machine.leave, the connector\'s daemon stopped, no key, the record revoked — and the connector stops; a deny whose path holds a registered relay secret never ships it and blocks nothing behind it', async () => {
  // World 1's connector stops first (paths follow HOME).
  assert.equal(await W.stop(), 0, 'connect run resolved 0 after its stop');
  const home = shortHome();
  W2.home = home;
  const fake = createFakeHub({ hubId: HUB, heartbeatMs: 5000, deadAfterMs: 15000 });
  await fake.start();
  W.cleanups.push(() => fake.stop());
  assert.ok(!RESERVED(fake.port));
  W2.fake = fake;
  // A machine the hub knows (paired earlier), its key through the one writer.
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  const m = fake.addMachine({ publicKey: raw, name: 'Revoked Mac' });
  const workdir = path.join(home, 'work');
  fs.mkdirSync(workdir);
  assert.ok(within(home, userPaths().connectorKey(HUB)));
  setup.writeMachineKey({
    hubId: HUB,
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    update: () => ({
      ...setup.newRecord({ hubId: HUB, origin: fake.url }),
      machine: { id: m.id, name: 'Revoked Mac' },
      credential: { state: 'paired', algorithm: 'ed25519', paired_at: Date.now() - 1000 },
      workdir,
    }),
  });
  assert.equal(setup.unitFor('launchd').unit_path.startsWith(home), true);
  startConnector(W2);
  await fake.waitFor('hello.ack', { dir: 'out' });
  const chat = fake.mintLabel();
  fake.assign({ chat_id: chat, rev: 1, scope: { kind: 'space' } });
  await waitUntil(() => { const r = readRec(); return r && r.chats.length === 1; }, { timeout: 15000, what: 'the chat mapped' });
  const root = readRec().chats[0].root;
  reapRoot(root);
  await waitUntil(() => W2.supervisor.relayCredential(chat), { timeout: 30000, interval: 100, what: 'the connector\'s daemon' });
  const secret = W2.supervisor.relayCredential(chat);
  const daemon = await registry.daemonFor(root);
  assert.ok(daemon && inBand(daemon.port));

  // Hand fold 6 (f): a refused request whose path holds the relay secret —
  // the hub's own frame carries it, never one the connector sends — and a
  // second refusal behind it, which ships.
  const decision = (v) => fake.decision({ chat, daemon_level: 'read', version: v });
  const r1 = await fake.relayHttp({ chat, method: 'GET', path: `/api/no-such-route/${secret}`, decision: decision(1) });
  assert.equal(r1.status, 403);
  const body = Buffer.from(JSON.stringify(COMMENT(true)));
  const r2 = await fake.relayHttp({
    chat, method: 'POST', path: '/api/elements', body,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) }, decision: decision(2),
  });
  assert.equal(r2.status, 403);
  await waitUntil(() => fake.find('authority.log', { dir: 'in' }).flatMap((f) => f.frame.records).some((r) => r.path === '/api/elements'),
    { timeout: 10000, what: 'the record behind it shipped' });
  const inbound = JSON.stringify(fake.frames.filter((f) => f.dir === 'in').map((f) => f.frame));
  assert.ok(!inbound.includes(secret), 'no frame the connector sent holds the secret');

  // The revocation.
  const leaves = fake.find('machine.leave', { dir: 'in' }).length;
  fake.revoke();
  assert.equal(await W2.done, 0, 'the connector stopped on the revocation');
  assert.equal(fake.find('machine.leave', { dir: 'in' }).length, leaves, 'no machine.leave on a revocation');
  assert.equal(await registry.daemonFor(root), null, 'the connector\'s daemon stopped (in-process release)');
  assert.ok(W2.out.some((l) => / release-all: 1 stopped, 0 left/.test(l)), 'released through ctx.releaseAll');
  assert.ok(W2.out.some((l) => /revoked: local half done/.test(l)));
  assert.ok(!fs.existsSync(userPaths().connectorKey(HUB)), 'no key');
  assert.equal(readRec().credential.state, 'revoked');
  assert.ok(fs.existsSync(root), 'the root kept');
  // This world's sweep: its secrets in no file under its HOME and no frame it sent.
  const hits = sweep(filesUnder(home), W2.secrets.map((x) => ['a relay secret', x]), {
    'the connector\'s log': W2.out.join('\n'),
    'its frames': inbound,
  });
  assert.deepEqual(hits, [], 'seen nowhere');
  assert.deepEqual(fake.errors, []);
});

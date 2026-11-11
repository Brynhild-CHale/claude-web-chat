'use strict';

// The connector's local socket and hub.request (lib/connector/local-socket.js)
// and `connect ls|open|shell|code` (lib/connector/terminal.js), tranche 6,
// U731: contract 05 C-05.47 and C-05.26a as A-05.3 amends them, 06 C-06.26a,
// 10 C-10.14a.
//
// HOME. A Unix socket path must fit sun_path (104 bytes on macOS), and the
// process sandbox's HOME under os.tmpdir() is too long for one, so each socket
// test points HOME at a short throwaway directory under /tmp (shortHome) for
// its own duration. Nothing here dials a host but loopback (the fake hub) or
// runs ssh, tmux, a shell or an opener: every plan goes to an injected runner,
// and the exec.js runner is checked with an injected spawn.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { once, EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { withFakeHub } = require('../test-support/fake-hub');
const { createValidator } = require('../test-support/contracts-loader');
const { createLink } = require('../lib/connector/link');
const { hubOrigin, newRecord, keyIdOf, fingerprintOf } = require('../lib/setup/connector');
const { versionsRecord, machineFacts } = require('../lib/connector/facts');
const { TABLE_VERSION, TABLE_SHA256 } = require('../lib/core/connected-policy');
const { userPaths } = require('../lib/core/paths');
const localSocket = require('../lib/connector/local-socket');
const terminal = require('../lib/connector/terminal');
const exec = require('../lib/connector/exec');
const cli = require('../lib/connector/cli');
const { openerCommand } = require('../lib/util/os-opener');
const openCmd = require('../lib/cli/commands/open');

const REPO_ROOT = path.resolve(__dirname, '..');
const HUB_REQUEST_SCHEMA = 'https://web-chat-contracts/schemas/05-hub-request.json';
const validator = createValidator({ folders: 'all' });

// ── a short HOME ───────────────────────────────────────────────────────────
function shortHome(t) {
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const home = fs.mkdtempSync(path.join(base, 'wcs-'));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return home;
}

function connectorDir(mode = 0o700) {
  const dir = userPaths().connectorDir;
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
  return dir;
}

// One line over the socket by hand, the raw answer line back.
function rawAsk(file, line) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const sock = net.connect({ path: file }, () => sock.write(line));
    sock.setEncoding('utf8');
    sock.on('data', (c) => { buf += c; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

// An install a test expects to be refused: should it succeed after all, its
// socket is still stopped when the test ends (a listening server left behind
// would keep the run alive).
function tryInstall(t, ctx) {
  const p = localSocket.install(ctx);
  p.then((stop) => t.after(stop), () => {});
  return p;
}

const upLink = () => ({ state: 'up', calls: [], request(...a) { this.calls.push(a); return Promise.reject(new Error('unexpected')); } });

// ── the socket file ────────────────────────────────────────────────────────
test('the socket is a Unix socket, 0600, in the 0700 connector directory, and removed at stop', async (t) => {
  shortHome(t);
  const dir = connectorDir();
  const ctx = { hubId: 'h01', link: upLink(), log: () => {} };
  const stop = await localSocket.install(ctx);
  t.after(stop);
  const file = userPaths().connectorSocket('h01');
  assert.strictEqual(ctx.localSocket.path, file);
  const st = fs.lstatSync(file);
  assert.ok(st.isSocket(), 'a Unix domain socket');
  assert.strictEqual(st.mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  await assert.rejects(tryInstall(t, ctx), /already installed/);
  await stop();
  assert.strictEqual(fs.existsSync(file), false, 'removed at stop');
  assert.strictEqual(ctx.localSocket, null);
});

test('an absent connector directory is made 0700; one at 0755 is refused and nothing is created', async (t) => {
  shortHome(t);
  const ctx = { hubId: 'h01', link: upLink(), log: () => {} };
  const stop = await localSocket.install(ctx);
  t.after(stop);
  assert.strictEqual(fs.statSync(userPaths().connectorDir).mode & 0o777, 0o700);
  await stop();

  shortHome(t);
  connectorDir(0o755);
  const logs = [];
  await assert.rejects(tryInstall(t, { hubId: 'h01', link: upLink(), log: (l) => logs.push(l) }),
    (e) => e.code === 'ESOCKETDIR' && /0755, not 0700/.test(e.message));
  assert.strictEqual(fs.existsSync(userPaths().connectorSocket('h01')), false);
  assert.strictEqual(fs.statSync(userPaths().connectorDir).mode & 0o777, 0o755, 'never repaired');
  assert.deepStrictEqual(logs, ['local socket refused code=ESOCKETDIR']);
});

test('a stale socket file (no listener) is removed at start; a live one makes a second start refuse', async (t) => {
  shortHome(t);
  connectorDir();
  const file = userPaths().connectorSocket('h01');
  // A connector killed outright leaves its socket file behind: install the
  // socket in a child (this HOME), then SIGKILL it.
  const mod = path.join(REPO_ROOT, 'lib', 'connector', 'local-socket.js');
  const r = spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(mod)}).install({ hubId: 'h01', link: null, log() {} }).then(() => process.kill(process.pid, 'SIGKILL'))`],
  { env: process.env });
  assert.strictEqual(r.signal, 'SIGKILL');
  assert.ok(fs.lstatSync(file).isSocket(), 'the stale file is there');

  const first = { hubId: 'h01', link: null, log: () => {} };
  const stop = await localSocket.install(first);
  t.after(stop);
  assert.ok(fs.lstatSync(file).isSocket());

  const logs = [];
  await assert.rejects(tryInstall(t, { hubId: 'h01', link: null, log: (l) => logs.push(l) }),
    (e) => e.code === 'ESOCKETBUSY');
  assert.deepStrictEqual(logs, ['local socket refused code=ESOCKETBUSY']);
  // The first still answers.
  const answer = JSON.parse(await rawAsk(file, '{"type":"ListChats","params":{}}\n'));
  assert.deepStrictEqual(answer, { ok: false, local: true, error: localSocket.NOT_CONNECTED });
});

test('a regular file at the socket path is refused, never removed', async (t) => {
  shortHome(t);
  connectorDir();
  const file = userPaths().connectorSocket('h01');
  fs.writeFileSync(file, 'x');
  await assert.rejects(tryInstall(t, { hubId: 'h01', link: null, log: () => {} }), (e) => e.code === 'ESOCKETPATH');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'x');
});

test('a socket path past sun_path is refused naming its length and the limit; nothing is created', async (t) => {
  const home = shortHome(t);
  const deep = path.join(home, 'h'.repeat(24));
  fs.mkdirSync(deep);
  process.env.HOME = deep;
  const hubId = `h${'a'.repeat(62)}`;
  const file = userPaths().connectorSocket(hubId);
  assert.ok(file, 'a valid hub id');
  const bytes = Buffer.byteLength(file);
  assert.ok(bytes + 1 > localSocket.sunPathMax(process.platform), `${bytes} bytes passes the limit`);
  await assert.rejects(tryInstall(t, { hubId, link: null, log: () => {} }),
    (e) => e.code === 'ESOCKETPATH' && e.message.includes(`${bytes} bytes`) && e.message.includes(String(localSocket.sunPathMax(process.platform) - 1)));
  assert.strictEqual(fs.existsSync(userPaths().connectorDir), false, 'not even the directory');

  // The arithmetic per platform: 103 path bytes fit macOS, 104 do not; Linux allows 107.
  const at = (n) => `/${'x'.repeat(n - 1)}`;
  assert.strictEqual(localSocket.pathTooLong(at(103), 'darwin'), null);
  assert.match(localSocket.pathTooLong(at(104), 'darwin'), /104 bytes and darwin allows 103/);
  assert.strictEqual(localSocket.pathTooLong(at(107), 'linux'), null);
  assert.match(localSocket.pathTooLong(at(108), 'linux'), /108 bytes and linux allows 107/);
});

// ── the protocol, against the fake hub ─────────────────────────────────────
function machineOn(fake) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  const m = fake.addMachine({ publicKey: raw, name: 'Test machine' });
  const record = newRecord({ hubId: 'hub-test', origin: hubOrigin(fake.url, { insecureLoopback: true }) });
  record.machine = { id: m.id, name: m.name };
  record.credential = {
    state: 'paired', algorithm: 'ed25519', key_file: userPaths().connectorKey('hub-test'),
    key_id: keyIdOf(raw), public_key: raw.toString('base64url'), fingerprint: fingerprintOf(raw), paired_at: 1,
  };
  return { privateKey, record };
}

// The fake hub, with a cleanup list that runs BEFORE its own stop and
// assertClean (which throws on a bad frame): the link and the socket are
// closed whatever the test or the fake's check does, so a failing test never
// leaves a handle that keeps the run alive.
const cleanups = new WeakMap();
async function fakeHub(t) {
  const list = [];
  t.after(async () => {
    for (const fn of list.reverse()) {
      try { await fn(); } catch { /* the next one still runs */ }
    }
  });
  const fake = await withFakeHub(t);
  cleanups.set(fake, list);
  return fake;
}

async function linkedSocket(t, fake, { releaseAll } = {}) {
  const later = cleanups.get(fake);
  const m = machineOn(fake);
  const link = createLink({
    record: m.record,
    key: m.privateKey,
    versions: () => versionsRecord({ claudeVersion: null }),
    facts: () => machineFacts({ record: m.record, names: { mcp_servers: [], skills: [] }, hostname: 'test-host', login: 'tester' }),
    routeTable: () => ({ table_version: TABLE_VERSION, sha256: TABLE_SHA256 }),
    onSettings: () => {},
    log: () => {},
    writeKey: () => {},
  });
  later.push(() => link.stop());
  const ready = once(link, 'ready');
  link.start();
  await ready;
  const ctx = { hubId: 'hub-test', link, releaseAll, log: () => {} };
  const stop = await localSocket.install(ctx);
  later.push(stop);
  return { link, ctx, file: ctx.localSocket.path, record: m.record };
}

const hubRequestsIn = (fake) => fake.frames.filter((f) => f.dir === 'in' && f.kind === 'hub.request');

test('the three reads reach the fake as valid hub.request frames and come back as received; nothing is cached', async (t) => {
  shortHome(t);
  connectorDir();
  const fake = await fakeHub(t);
  const { file } = await linkedSocket(t, fake);
  const schema = validator.ajv.getSchema(HUB_REQUEST_SCHEMA);
  assert.ok(schema, 'the 05-hub-request schema loads');

  const asks = [
    ['ListMachines', {}],
    ['ListChats', {}],
    ['GetChatAttach', { chat_id: 'cht_01jbz9a1b2c3d4e5f6g7h8j9k0' }],
  ];
  for (const [i, [type, params]] of asks.entries()) {
    const line = await rawAsk(file, `${JSON.stringify({ type, params })}\n`);
    const sent = hubRequestsIn(fake)[i];
    assert.ok(sent, `${type} reached the fake`);
    assert.ok(schema(sent.frame), `${type}: ${JSON.stringify(schema.errors)}`);
    assert.deepStrictEqual(sent.frame.request, { type, params });
    const out = fake.frames.find((f) => f.dir === 'out' && f.kind === 'hub.response' && f.frame.re === sent.frame.id);
    assert.ok(out, `the fake answered ${type}`);
    assert.ok(schema(out.frame), JSON.stringify(schema.errors));
    assert.strictEqual(line, `${JSON.stringify(out.frame.response)}\n`, `${type} is answered byte for byte as received`);
  }

  // The same ask again goes to the hub again.
  const again = JSON.parse(await rawAsk(file, '{"type":"ListChats","params":{}}\n'));
  assert.strictEqual(again.ok, true);
  assert.strictEqual(hubRequestsIn(fake).filter((f) => f.frame.request.type === 'ListChats').length, 2);

  // askConnector, the CLI's half, gets the same answer.
  const viaClient = await localSocket.askConnector({ path: file, request: { type: 'ListMachines', params: {} } });
  assert.strictEqual(viaClient.type, 'ListMachines');
  assert.ok(Array.isArray(viaClient.result.machines));
  assert.strictEqual(hubRequestsIn(fake).length, 5);
});

test('a type outside the three (GetChat, PullEventStream, a local-looking one) is refused locally; the fake records no frame', async (t) => {
  shortHome(t);
  connectorDir();
  const fake = await fakeHub(t);
  const { file } = await linkedSocket(t, fake);
  const before = fake.frames.length;
  for (const request of [
    { type: 'GetChat', params: {} },
    { type: 'PullEventStream', params: {} },
    { type: 'connector.write-record', params: {} },
    { type: 'ListChats', params: [] },
    { type: 'ListChats' },
    { params: {} },
  ]) {
    const answer = await localSocket.askConnector({ path: file, request });
    assert.deepStrictEqual(answer, { ok: false, local: true, error: 'only ListMachines, ListChats and GetChatAttach' }, JSON.stringify(request));
  }
  assert.deepStrictEqual(JSON.parse(await rawAsk(file, 'not json\n')), { ok: false, local: true, error: localSocket.ONLY_THREE });
  const big = JSON.parse(await rawAsk(file, `${'x'.repeat(localSocket.MAX_REQUEST_BYTES + 10)}\n`));
  assert.strictEqual(big.local, true);
  // Nothing was sent: no hub.request, and no frame of the link's that names a
  // refused type (the link's own heartbeats carry on beside).
  assert.strictEqual(hubRequestsIn(fake).length, 0);
  const sent = fake.frames.slice(before).filter((f) => f.dir === 'in');
  assert.ok(sent.every((f) => f.kind === 'heartbeat' || f.kind === 'machine.facts'), sent.map((f) => f.kind).join(','));
  assert.ok(!sent.some((f) => /GetChat"|PullEventStream|write-record/.test(JSON.stringify(f.frame))));
});

test('connector.release-all is answered in process with the link up and down, and never reaches the hub', async (t) => {
  shortHome(t);
  connectorDir();
  const fake = await fakeHub(t);
  const calls = [];
  const { file, link } = await linkedSocket(t, fake, {
    releaseAll: async () => { calls.push(calls.length + 1); return { released: calls.length }; },
  });
  const ask = (request) => localSocket.askConnector({ path: file, request });

  const up = await ask({ type: 'connector.release-all', params: {} });
  assert.deepStrictEqual(up, { ok: true, local: true, type: 'connector.release-all', result: { released: 1 } });
  assert.deepStrictEqual(calls, [1], 'called once');

  await link.stop();
  assert.notStrictEqual(link.state, 'up');
  const down = await ask({ type: 'connector.release-all', params: {} });
  assert.deepStrictEqual(down, { ok: true, local: true, type: 'connector.release-all', result: { released: 2 } });
  assert.deepStrictEqual(calls, [1, 2]);

  // The hub reads with the link down: the connector's own answer.
  assert.deepStrictEqual(await ask({ type: 'ListChats', params: {} }), { ok: false, local: true, error: 'the connector is not connected to the hub' });
  assert.strictEqual(hubRequestsIn(fake).length, 0, 'release-all is never a hub.request');
  assert.ok(!fake.frames.some((f) => f.dir === 'in' && JSON.stringify(f.frame).includes('release-all')));
});

test('the CLI half: the link down says "not connected to the hub"; no connector names `connect status`; both exit non-zero', async (t) => {
  shortHome(t);
  connectorDir();
  const fake = await fakeHub(t);
  const { file, link, record } = await linkedSocket(t, fake);
  const listRecords = () => [{ hubId: 'hub-test', read: { ok: true, value: record } }];
  assert.strictEqual(file, userPaths().connectorSocket('hub-test'));

  // Through the real socket, the link up: ls lists the fake's chats.
  const out = [];
  assert.strictEqual(await terminal.ls([], { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`), listRecords }), 0);
  assert.ok(out.length >= 1 && /^1 {2}/.test(out[0]), out.join('\n'));

  await link.stop();
  const err = [];
  assert.strictEqual(await terminal.ls([], { out: () => {}, err: (l) => err.push(l), listRecords }), 1);
  assert.match(err.join('\n'), /not connected to the hub/);

  // No connector answering: askConnector names `connect status`, and the row exits 1.
  await assert.rejects(localSocket.askConnector({ path: userPaths().connectorSocket('hub-none'), request: { type: 'ListChats', params: {} } }),
    (e) => e.code === 'ENOCONNECTOR' && /claude-web-chat connect status/.test(e.message) && /Copy commands/.test(e.message));
  const none = [];
  const otherHub = () => [{ hubId: 'hub-none', read: { ok: true, value: { ...record, hub: { ...record.hub, id: 'hub-none' } } } }];
  assert.strictEqual(await terminal.open(['abc'], { out: () => {}, err: (l) => none.push(l), listRecords: otherHub }), 1);
  assert.match(none.join('\n'), /connect status/);
});

// ── connect open|shell|code: argument lists ────────────────────────────────
const LOCAL_ID = `mch_${'1'.repeat(26)}`;
const REMOTE_ID = `mch_${'2'.repeat(26)}`;
const LABEL = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHAT_ID = `cht_${LABEL}`;
const HOST = 'studio-mbp.yak-bebop.ts.net';

function localRecord({ root = '/tmp/a b', pathEnv } = {}) {
  return {
    hub: { id: 'hub-test' },
    credential: { state: 'paired' },
    machine: { id: LOCAL_ID, name: 'here' },
    chats: [{ chat_id: LABEL, root, owned_root: false }],
    service: pathEnv ? { kind: 'launchd', unit_path: '/x', path_env: pathEnv, installed_at: 1 } : null,
  };
}

function attachResult({ machineId = REMOTE_ID, login = 'me', tailnet = HOST, session = null, launch = 'manual', commands = {} } = {}) {
  return {
    chat_id: CHAT_ID,
    machine: { id: machineId, name: 'studio-mbp', tailnet_name: tailnet, login, online: true },
    folder: null,
    session,
    launch,
    commands: { terminal: null, shell: null, code: null, unavailable: {}, ...commands },
  };
}

const CHATS = [
  { chat_id: CHAT_ID, title: 'First', machine_id: REMOTE_ID, state: 'idle' },
  { chat_id: 'cht_aaaabbbbbbbbbbbbbbbbbbbbbb', title: 'Second', machine_id: LOCAL_ID, state: 'working' },
  { chat_id: 'cht_bbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'Third', machine_id: null, state: 'offline' },
];

function harness({ result = attachResult(), record = localRecord(), prompt = null, chats = CHATS } = {}) {
  const h = { plans: [], asks: [], dispatched: [], out: [], err: [] };
  h.deps = {
    out: (l) => h.out.push(l),
    err: (l) => h.err.push(l),
    listRecords: () => [{ hubId: 'hub-test', read: { ok: true, value: record } }],
    prompt,
    ask: async (request, socketPath) => {
      h.asks.push({ request, socketPath });
      if (request.type === 'ListMachines') {
        return { ok: true, type: request.type, request_id: 'rq_00000001', result: { machines: [{ machine_id: REMOTE_ID, name: 'studio-mbp' }, { machine_id: LOCAL_ID, name: 'here' }] } };
      }
      if (request.type === 'ListChats') return { ok: true, type: request.type, request_id: 'rq_00000002', result: { chats } };
      return { ok: true, type: request.type, request_id: 'rq_00000003', result: { ...result, chat_id: request.params.chat_id } };
    },
    runPlan: async (plan) => { h.plans.push(plan); return { code: 0, reason: null }; },
    dispatch: async (args) => { h.dispatched.push(args); return 0; },
  };
  h.argv = () => h.plans.map((p) => [p.program, ...p.argv]);
  return h;
}

test('remote open with a live session: ssh -t <login>@<tailnet> tmux attach-session -t \'=<name>\'; login null is the bare host', async () => {
  const h = harness({ result: attachResult({ session: { multiplexer: 'tmux', name: 'wc-01abc' }, launch: 'connector' }) });
  assert.strictEqual(await terminal.open([LABEL], h.deps), 0);
  assert.deepStrictEqual(h.argv(), [['ssh', '-t', 'me@studio-mbp.yak-bebop.ts.net', 'tmux', 'attach-session', '-t', "'=wc-01abc'"]]);
  assert.deepStrictEqual(h.asks.map((a) => a.request.type), ['ListMachines', 'ListChats', 'GetChatAttach']);
  assert.deepStrictEqual(h.asks[2].request.params, { chat_id: CHAT_ID });
  assert.strictEqual(h.asks[2].socketPath, userPaths().connectorSocket('hub-test'));

  const bare = harness({ result: attachResult({ login: null, session: { multiplexer: 'tmux', name: 'wc-01abc' }, launch: 'connector' }) });
  assert.strictEqual(await terminal.open([LABEL], bare.deps), 0);
  assert.deepStrictEqual(bare.argv(), [['ssh', '-t', HOST, 'tmux', 'attach-session', '-t', "'=wc-01abc'"]]);
});

test('open with no live session: manual (or connector with a terminal command) attaches; start-first, none and no tailnet refuse', async () => {
  const manual = harness({ result: attachResult({ launch: 'manual', commands: { terminal: 'ssh … (never run)' } }) });
  assert.strictEqual(await terminal.open([LABEL], manual.deps), 0);
  assert.deepStrictEqual(manual.argv(), [['ssh', '-t', `me@${HOST}`, 'claude-web-chat', 'connect', 'attach', LABEL]]);

  const trust = harness({ result: attachResult({ launch: 'connector', commands: { terminal: 'ssh … connect attach' } }) });
  assert.strictEqual(await terminal.open([LABEL], trust.deps), 0);
  assert.deepStrictEqual(trust.argv(), [['ssh', '-t', `me@${HOST}`, 'claude-web-chat', 'connect', 'attach', LABEL]]);

  // Here: the table's attach row, in process; no program.
  const here = harness({ result: attachResult({ machineId: LOCAL_ID, launch: 'manual' }) });
  assert.strictEqual(await terminal.open([LABEL], here.deps), 0);
  assert.deepStrictEqual(here.dispatched, [['attach', LABEL]]);
  assert.deepStrictEqual(here.plans, []);

  for (const [result, why] of [
    [attachResult({ launch: 'connector', commands: { unavailable: { terminal: 'start-first' } } }), /started from the hub|start it from the hub/],
    [attachResult({ launch: 'none', commands: { unavailable: { terminal: 'no-agent' } } }), /no agent/],
    [attachResult({ tailnet: null, session: { multiplexer: 'tmux', name: 'wc-01abc' }, launch: 'connector' }), /no tailnet name/],
    [attachResult({ tailnet: null, launch: 'manual' }), /no tailnet name/],
  ]) {
    const h = harness({ result });
    assert.strictEqual(await terminal.open([LABEL], h.deps), 1);
    assert.match(h.err.join('\n'), why);
    assert.deepStrictEqual(h.plans, []);
    assert.deepStrictEqual(h.dispatched, []);
  }
});

test('local open with a live session: tmux attach-session -t =<name>, the tmux on the record\'s path_env', async () => {
  const h = harness({
    result: attachResult({ machineId: LOCAL_ID, session: { multiplexer: 'tmux', name: 'wc-01abc' }, launch: 'connector' }),
    record: localRecord({ pathEnv: '/opt/tmuxdir:/usr/bin' }),
  });
  assert.strictEqual(await terminal.open([LABEL], h.deps), 0);
  assert.deepStrictEqual(h.argv(), [['tmux', 'attach-session', '-t', '=wc-01abc']]);
  assert.strictEqual(h.plans[0].pathEnv, '/opt/tmuxdir:/usr/bin');
});

test('shell and code: here a login shell and vscode://file<root>; elsewhere ssh to the remote CLI and a checked commands.code', async (t) => {
  const remoteShell = harness({ result: attachResult({ commands: { shell: "ssh … 'cd /x && exec \"$SHELL\" -l'" } }) });
  assert.strictEqual(await terminal.shell([LABEL], remoteShell.deps), 0);
  assert.deepStrictEqual(remoteShell.argv(), [['ssh', '-t', `me@${HOST}`, 'claude-web-chat', 'connect', 'shell', LABEL]]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localShell = harness({ result: attachResult({ machineId: LOCAL_ID }), record: localRecord({ root }) });
  assert.strictEqual(await terminal.shell([LABEL], localShell.deps), 0);
  assert.deepStrictEqual(localShell.plans, [{ program: 'shell', argv: ['-l'], cwd: root }]);

  const localCode = harness({ result: attachResult({ machineId: LOCAL_ID }), record: localRecord({ root: '/tmp/a b' }) });
  assert.strictEqual(await terminal.code([LABEL], localCode.deps), 0);
  assert.deepStrictEqual(localCode.argv(), [['opener', 'vscode://file/tmp/a%20b']]);

  const url = `vscode://vscode-remote/ssh-remote+me@${HOST}/Users/me/Dev/x`;
  const remoteCode = harness({ result: attachResult({ commands: { code: url } }) });
  assert.strictEqual(await terminal.code([LABEL], remoteCode.deps), 0);
  assert.deepStrictEqual(remoteCode.argv(), [['opener', url]]);

  for (const bad of ['vscode://file/etc/passwd', 'https://evil.example/x', '-a Terminal', `${url} --x`, `${url}\nrm`]) {
    const h = harness({ result: attachResult({ commands: { code: bad } }) });
    assert.strictEqual(await terminal.code([LABEL], h.deps), 1, bad);
    assert.deepStrictEqual(h.plans, [], bad);
  }
  const owned = harness({ result: attachResult({ commands: { code: null, unavailable: { code: 'owned-root' } } }) });
  assert.strictEqual(await terminal.code([LABEL], owned.deps), 1);
  assert.match(owned.err.join('\n'), /connector's own folder/);
  assert.deepStrictEqual(owned.plans, []);
});

test('the same machine id never yields an ssh argv; a hostile tailnet name or login never becomes one either', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const sub of ['open', 'shell', 'code']) {
    const h = harness({
      result: attachResult({ machineId: LOCAL_ID, session: { multiplexer: 'tmux', name: 'wc-01abc' }, launch: 'connector' }),
      record: localRecord({ root }),
    });
    await terminal[sub]([LABEL], h.deps);
    assert.ok(!h.plans.some((p) => p.program === 'ssh'), sub);
  }
  for (const machine of [{ tailnet: '-oProxyCommand=sh' }, { tailnet: 'a b' }, { login: '-oProxyCommand=sh' }, { login: 'a@b' }]) {
    const h = harness({ result: attachResult({ ...machine, launch: 'manual' }) });
    assert.strictEqual(await terminal.open([LABEL], h.deps), 1, JSON.stringify(machine));
    assert.deepStrictEqual(h.plans, []);
  }
  // A session name outside 10's grammar is refused too.
  const h = harness({ result: attachResult({ session: { multiplexer: 'tmux', name: "wc-x'; rm" }, launch: 'connector' }) });
  assert.strictEqual(await terminal.open([LABEL], h.deps), 1);
  assert.deepStrictEqual(h.plans, []);
});

test('<chat>: a unique prefix of a label or id resolves; an ambiguous one prints the rows and exits non-zero', async () => {
  const unique = harness({ result: attachResult({ launch: 'manual' }) });
  assert.strictEqual(await terminal.open(['bbb'], unique.deps), 0);
  assert.deepStrictEqual(unique.asks[2].request.params, { chat_id: 'cht_bbbbbbbbbbbbbbbbbbbbbbbbbb' });

  const byId = harness();
  assert.strictEqual(await terminal.shell(['cht_aaaab'], byId.deps), 0);
  assert.deepStrictEqual(byId.asks[2].request.params, { chat_id: 'cht_aaaabbbbbbbbbbbbbbbbbbbbbb' });

  const exact = harness();
  assert.strictEqual(await terminal.shell([LABEL], exact.deps), 0, 'an exact label wins over the prefix it is of another');
  assert.deepStrictEqual(exact.asks[2].request.params, { chat_id: CHAT_ID });

  const ambiguous = harness();
  assert.strictEqual(await terminal.open(['aaaa'], ambiguous.deps), 1);
  const text = ambiguous.err.join('\n');
  assert.match(text, /matches 2 chats/);
  assert.match(text, /First {2}studio-mbp {2}a{26} {2}idle/);
  assert.match(text, /Second {2}here {2}aaaab{22} {2}working/);
  assert.ok(!ambiguous.asks.some((a) => a.request.type === 'GetChatAttach'));

  const none = harness();
  assert.strictEqual(await terminal.code(['zz'], none.deps), 1);
  assert.match(none.err.join('\n'), /no chat matches zz/);
});

test('no <chat>: the pick list, then a number through the prompt; with no terminal it refuses with the hint', async () => {
  const noTty = harness({ prompt: { interactive: false, line: async () => '1' } });
  assert.strictEqual(await terminal.open([], noTty.deps), 1);
  assert.match(noTty.err.join('\n'), /name the chat, e\.g\. claude-web-chat connect open <chat-label>/);
  assert.deepStrictEqual(noTty.plans, []);
  assert.strictEqual(noTty.out.length, 3, 'the pick list was printed');

  const noPrompt = harness();
  assert.strictEqual(await terminal.shell([], noPrompt.deps), 1);
  assert.match(noPrompt.err.join('\n'), /name the chat/);

  const asked = [];
  const tty = harness({ result: attachResult({ launch: 'manual' }), prompt: { interactive: true, line: async (q) => { asked.push(q); return '3'; } } });
  assert.strictEqual(await terminal.open([], tty.deps), 0);
  assert.deepStrictEqual(asked, ['Chat number (1-3):']);
  assert.deepStrictEqual(tty.asks[2].request.params, { chat_id: 'cht_bbbbbbbbbbbbbbbbbbbbbbbbbb' });

  const wrong = harness({ prompt: { interactive: true, line: async () => '9' } });
  assert.strictEqual(await terminal.open([], wrong.deps), 1);
  assert.deepStrictEqual(wrong.plans, []);
});

test('connect ls prints one numbered row per chat: number, title, machine name, label, state; extra arguments are usage', async () => {
  const h = harness();
  assert.strictEqual(await terminal.ls([], h.deps), 0);
  assert.deepStrictEqual(h.out, [
    `1  First  studio-mbp  ${LABEL}  idle`,
    `2  Second  here  aaaabbbbbbbbbbbbbbbbbbbbbb  working`,
    '3  Third  -  bbbbbbbbbbbbbbbbbbbbbbbbbb  offline',
  ]);
  assert.deepStrictEqual(h.asks.map((a) => a.request.type), ['ListMachines', 'ListChats']);
  const extra = harness();
  assert.strictEqual(await terminal.ls(['x'], extra.deps), 1);
  assert.deepStrictEqual(extra.asks, []);

  // A hub error answer is printed, never a stack.
  const refused = harness();
  refused.deps.ask = async (request) => ({ ok: false, type: request.type, request_id: 'rq_00000009', error: { code: 'forbidden', message: 'Not yours.', hint: 'Ask the owner.' } });
  assert.strictEqual(await terminal.ls([], refused.deps), 1);
  assert.match(refused.err.join('\n'), /connect ls: Not yours\. Ask the owner\./);

  // Unpaired: nothing asked.
  const unpaired = harness();
  unpaired.deps.listRecords = () => [];
  assert.strictEqual(await terminal.ls([], unpaired.deps), 1);
  assert.match(unpaired.err.join('\n'), /not paired/);
});

test('the four rows are appended to the connect table and dispatched through it', async () => {
  const names = cli.ROWS.map((r) => r.name);
  // Appended together, in this order (later units append their own rows after them).
  const at = names.indexOf('ls');
  assert.ok(at > 0);
  assert.deepStrictEqual(names.slice(at, at + 4), ['ls', 'open', 'shell', 'code']);
  assert.strictEqual(names[0], 'status');
  const out = [];
  assert.strictEqual(await cli.main(['help'], { out: (l) => out.push(l) }), 0);
  for (const u of ['connect ls', 'connect open [<chat>]', 'connect shell [<chat>]', 'connect code [<chat>]']) {
    assert.ok(out.join('\n').includes(`claude-web-chat ${u}`), u);
  }
  const h = harness();
  assert.strictEqual(await cli.main(['ls'], h.deps), 0);
  assert.strictEqual(h.out.length, 3);
});

// ── exec.js: the plans and the runner ──────────────────────────────────────
test('quoteRemoteWord: the safe set unchanged, everything else POSIX single-quoted (10 C-10.14a)', () => {
  const q = exec.quoteRemoteWord;
  assert.strictEqual(q('tmux'), 'tmux');
  assert.strictEqual(q('a/b._~@-Z9'), 'a/b._~@-Z9');
  assert.strictEqual(q('=wc-01abc'), "'=wc-01abc'");
  assert.strictEqual(q('~/x'), "'~/x'");
  assert.strictEqual(q("it's"), "'it'\\''s'");
  assert.strictEqual(q('a b'), "'a b'");
  assert.strictEqual(q('$(id)'), "'$(id)'");
  assert.strictEqual(q(''), "''");
});

function fakeSpawn(calls, { code = 0, signal = null, error = null } = {}) {
  return (bin, argv, opts) => {
    calls.push({ bin, argv, opts });
    const child = new EventEmitter();
    setImmediate(() => (error ? child.emit('error', error) : child.emit('exit', code, signal)));
    return child;
  };
}

test('runPlan spawns the resolved program with an argument list, the terminal inherited, never a shell', async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const name of ['ssh', 'tmux', 'open', 'xdg-open', 'myshell']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const env = { PATH: bin, SHELL: path.join(bin, 'myshell') };
  const calls = [];
  const spawn = fakeSpawn(calls);
  const run = (plan, platform = 'darwin') => exec.runPlan(plan, { env, platform, spawn });

  assert.deepStrictEqual(await run(exec.sshPlan('me@h.ts.net', ['tmux', 'attach-session', '-t', '=wc-01abc'])), { code: 0, reason: null });
  assert.deepStrictEqual(await run(exec.tmuxAttachPlan('wc-01abc', `/nowhere:${bin}`)), { code: 0, reason: null });
  assert.deepStrictEqual(await run(exec.loginShellPlan('/tmp')), { code: 0, reason: null });
  assert.deepStrictEqual(await run(exec.openerPlan('vscode://file/tmp/a%20b'), 'darwin'), { code: 0, reason: null });
  assert.deepStrictEqual(await run(exec.openerPlan('vscode://file/x'), 'linux'), { code: 0, reason: null });
  assert.deepStrictEqual(calls.map((c) => [c.bin, c.argv]), [
    [path.join(bin, 'ssh'), ['-t', 'me@h.ts.net', 'tmux', 'attach-session', '-t', "'=wc-01abc'"]],
    [path.join(bin, 'tmux'), ['attach-session', '-t', '=wc-01abc']],
    [path.join(bin, 'myshell'), ['-l']],
    [path.join(bin, 'open'), ['vscode://file/tmp/a%20b']],
    [path.join(bin, 'xdg-open'), ['vscode://file/x']],
  ]);
  for (const c of calls) {
    assert.strictEqual(c.opts.shell, false);
    assert.strictEqual(c.opts.stdio, 'inherit');
    assert.ok(Array.isArray(c.argv) && c.argv.every((a) => typeof a === 'string'));
  }
  assert.strictEqual(calls[2].opts.cwd, '/tmp');

  // Not found, another platform, a signal, a spawn error.
  assert.deepStrictEqual(await exec.runPlan(exec.sshPlan('h', []), { env: { PATH: '/nowhere' }, spawn }), { code: 127, reason: 'not-found' });
  assert.deepStrictEqual(await exec.runPlan(exec.openerPlan('x'), { env, platform: 'win32', spawn }), { code: 127, reason: 'platform' });
  assert.deepStrictEqual(await exec.runPlan(exec.loginShellPlan('/'), { env: { PATH: bin, SHELL: 'sh' }, spawn }), { code: 127, reason: 'not-found' });
  const sig = await exec.runInteractive(path.join(bin, 'ssh'), [], { spawn: fakeSpawn([], { code: null, signal: 'SIGINT' }) });
  assert.strictEqual(sig.code, 128 + os.constants.signals.SIGINT);
  const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
  assert.deepStrictEqual(await exec.runInteractive(path.join(bin, 'ssh'), [], { spawn: fakeSpawn([], { error: enoent }) }), { code: 127, reason: 'not-found' });
});

test('runInteractive leaves no signal listener behind', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  await exec.runInteractive(process.execPath, [], { spawn: fakeSpawn([]) });
  assert.deepStrictEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
});

test('encodePath percent-encodes only where RFC 3986 requires', () => {
  assert.strictEqual(terminal.encodePath('/tmp/a b'), '/tmp/a%20b');
  assert.strictEqual(terminal.encodePath("/x/a-b_c.d~e!$&'()*+,;=:@"), "/x/a-b_c.d~e!$&'()*+,;=:@");
  assert.strictEqual(terminal.encodePath('/x/100%#?é'), '/x/100%25%23%3F%C3%A9');
});

// ── the OS opener's one home ───────────────────────────────────────────────
test('the opener per platform: open on darwin, xdg-open on linux; lib/cli/commands/open.js launches through it', () => {
  assert.deepStrictEqual(openerCommand('darwin'), { cmd: 'open', args: [] });
  assert.deepStrictEqual(openerCommand('linux'), { cmd: 'xdg-open', args: [] });
  assert.deepStrictEqual(openerCommand('win32'), { cmd: 'cmd', args: ['/c', 'start', ''] });
  for (const [platform, cmd, args] of [['darwin', 'open', []], ['linux', 'xdg-open', []], ['win32', 'cmd', ['/c', 'start', '']]]) {
    const calls = [];
    openCmd.launchBrowser('http://127.0.0.1:5999/', {
      platform,
      spawn: (c, a, o) => { calls.push([c, a, o]); const ch = new EventEmitter(); ch.unref = () => {}; return ch; },
    });
    assert.deepStrictEqual(calls, [[cmd, [...args, 'http://127.0.0.1:5999/'], { stdio: 'ignore', detached: true }]], platform);
  }
  // One mapping: 'xdg-open' is spelled as a string in lib/ only in lib/util/os-opener.js.
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && /['"]xdg-open['"]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(REPO_ROOT, p));
    }
  };
  walk(path.join(REPO_ROOT, 'lib'));
  assert.deepStrictEqual(hits, [path.join('lib', 'util', 'os-opener.js')]);
});

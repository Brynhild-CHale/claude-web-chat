// Disconnect, revocation, the ceiling and the cap (contract 06 C-06.9,
// C-06.22, C-06.23, C-06.23a; 04 C-04.11; tranche 6 U727). Pins:
//
//   * disconnectLocal is ONE function for `connect disconnect` and a hub
//     revocation: with no connector answering it posts /api/shutdown (the
//     X-WC-Shutdown header, the port explicit, noSpawn) to the owned root's
//     daemon only and names the folder chat's daemon in `left`; it deletes the
//     key, marks the record revoked with revoked_at, runs the unload argv
//     through deps.run, removes the unit file and the stale socket, and leaves
//     the roots and the workdir on disk. With viaConnector answering it asks
//     the connector once and posts nothing itself. A revocation takes the same
//     steps in the same order, the unload last of all.
//   * `connect ceiling <read|full>` writes exactly that, anything else is
//     refused with the record byte-identical; the read-back is readCeiling
//     (lib/core/connected-ceiling.js), the daemon's own reader, and a live
//     connected daemon follows the write without a restart.
//   * `connect cap <n>` writes settings.local_cap (0–64) and prints the
//     effective cap, which never rises above the hub's.
//   * no pause or resume row exists.
//   * U716b: a connected `connect disconnect` asks the running connector
//     connector.leave (the link's machine.leave: the fake hub records exactly
//     one) and then connector.release-all, over the real local socket; a
//     revocation sends none; with no connector answering it prints that the
//     hub keeps the machine; the record's service is null once the unit file
//     is gone.
//
// Every case runs in a throwaway HOME (withTempHome, under
// test-support/sandbox.js); no service manager runs (deps.run records), no
// daemon is dialled but the in-process withServer on an ephemeral port.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { withServer, withTempHome, waitUntil } = require('../test-support/helpers');
const { userPaths } = require('../lib/core/paths');
const { readCeiling, ceilingOf } = require('../lib/core/connected-ceiling');
const { readJson } = require('../lib/core/fsjson');
const setup = require('../lib/setup/connector');
const table = require('../lib/connector/cli');
const { createServer } = require('../lib/server');
const { withFakeHub } = require('../test-support/fake-hub');
const { createLink } = require('../lib/connector/link');
const localSocket = require('../lib/connector/local-socket');
const { versionsRecord, machineFacts } = require('../lib/connector/facts');
const { TABLE_VERSION, TABLE_SHA256 } = require('../lib/core/connected-policy');

const HUB = 'hale-hub';
const OWNED_CHAT = '01jbz9a1b2c3d4e5f6g7h8j9k1';
const FOLDER_CHAT = '01jbz9a1b2c3d4e5f6g7h8j9k0';
const FOLDER_ID = 'f_3a9c1e07b54d2f68';
const NOW = 1793200000000;

// A paired machine in the sandbox HOME: a record with an owned space chat and
// a folder chat, both roots and the workdir on disk, the key in its own 0600
// file, a stub unit file at the launchd unit's contracted path, and a stale
// socket file. → the paths and the key's PEM body lines (never to be printed).
function pairedMachine(t, { ceiling = 'full', service = true, settings = {}, short = false } = {}) {
  const home = short ? shortHome(t) : withTempHome(t);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u727-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const ownedRoot = path.join(scratch, 'workdir', 'chats', OWNED_CHAT);
  const folderRoot = path.join(scratch, 'Offered');
  const workdir = path.join(scratch, 'workdir');
  fs.mkdirSync(ownedRoot, { recursive: true });
  fs.mkdirSync(folderRoot, { recursive: true });
  fs.writeFileSync(path.join(ownedRoot, 'notes.md'), 'kept\n');
  fs.writeFileSync(path.join(folderRoot, 'README.md'), 'kept\n');

  setup.ensureConnectorDir();
  const keyFile = userPaths().connectorKey(HUB);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(keyFile, pem, { mode: 0o600 });

  const unit = setup.unitFor('launchd');
  fs.mkdirSync(path.dirname(unit.unit_path), { recursive: true });
  fs.writeFileSync(unit.unit_path, '<plist>stub</plist>\n');
  const socketFile = userPaths().connectorSocket(HUB);
  fs.writeFileSync(socketFile, '');

  const record = {
    v: 1,
    hub: { id: HUB, origin: 'https://hub.example.com', name: 'Test hub' },
    machine: { id: 'mch_01jbz3k9q4w8r2t6v0x5m7n8p1', name: 'studio-mbp' },
    credential: {
      state: 'paired',
      algorithm: 'ed25519',
      key_file: keyFile,
      key_id: 'mky_y4881352x9v335ap1wtpd4q6ef',
      public_key: 'kTCi0MViCOcU8LqIYhIzSR1xC7jW0kmKgaBHqjV2eo4',
      fingerprint: 'SHA256:8RCAjKLqdjGVVg81ZpLmc+7/fOPgiDSG8BRyRVXXMGs',
      paired_at: 1793177460000,
      revoked_at: null,
    },
    workdir,
    settings: { agents_at_once: 4, local_cap: null, accept_new_chats: true, let_home_start_agents: false, paused: false, rev: 4, ...settings },
    folders: [{ id: FOLDER_ID, path: folderRoot, display: '~/Offered', label: 'Offered', access: 'read-write', offered_at: 1793177520000 }],
    chats: [
      { chat_id: OWNED_CHAT, rev: 1, scope_kind: 'space', root: ownedRoot, instance: null, owned_root: true, desired: 'running', assigned_at: 1793177700000 },
      { chat_id: FOLDER_CHAT, rev: 3, scope_kind: 'folder', folder_id: FOLDER_ID, root: folderRoot, instance: '5b1e9c04', owned_root: false, desired: 'running', manual_attach_at: 1793177760000, assigned_at: 1793177700000 },
    ],
    service: service ? { kind: 'launchd', label: unit.label, unit_path: unit.unit_path, path_env: '/usr/bin:/bin', installed_at: 1793177465000 } : null,
  };
  if (ceiling !== undefined) record.ceiling = ceiling;
  setup.writeRecord(record);
  return {
    home, keyFile, socketFile, unitFile: unit.unit_path, ownedRoot, folderRoot, workdir,
    recordFile: userPaths().connectorRecord(HUB),
    pemLines: pem.split('\n').filter((l) => l && !l.startsWith('-----')),
  };
}

// A HOME short enough for a Unix socket path (sun_path is 104 bytes on macOS;
// the sandbox's HOME under os.tmpdir() is too long), for the cases that run
// the real local socket. Restored, and removed, when the test ends.
function shortHome(t) {
  const base = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const home = fs.mkdtempSync(path.join(base, 'wcd-'));
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

// The running connector, in this process: a link up to the fake hub for the
// paired machine (its key the fake knows; the record dialled is the disk
// record's, pointed at the fake) and the real local socket, its releaseAll
// recording how many machine.leave frames the fake had seen when it ran.
async function runningConnector(t, fake) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  const machine = fake.addMachine({ publicKey: raw, name: 'studio-mbp' });
  const disk = setup.readRecord(HUB).value;
  const record = { ...disk, hub: { ...disk.hub, origin: setup.hubOrigin(fake.url, { insecureLoopback: true }) }, machine: { id: machine.id, name: machine.name } };
  const link = createLink({
    record,
    key: privateKey,
    versions: () => versionsRecord({ claudeVersion: null }),
    facts: () => machineFacts({ record, names: { mcp_servers: [], skills: [] }, hostname: 'test-host', login: 'tester' }),
    routeTable: () => ({ table_version: TABLE_VERSION, sha256: TABLE_SHA256 }),
    log: () => {},
    writeKey: () => assert.fail('no rotation here'),
  });
  t.after(() => link.stop());
  const up = new Promise((resolve) => link.once('ready', resolve));
  link.start();
  await up;
  const releases = [];
  // The stale socket file pairedMachine left goes first (as a fresh
  // connector's install clears a stale one only when it is a socket).
  fs.rmSync(userPaths().connectorSocket(HUB), { force: true });
  const ctx = {
    hubId: HUB,
    link,
    log: () => {},
    releaseAll: async () => { releases.push(fake.find('machine.leave', { dir: 'in' }).length); return { released: 2, left: [] }; },
  };
  const stop = await localSocket.install(ctx);
  t.after(stop);
  const ask = (request) => localSocket.askConnector({ path: userPaths().connectorSocket(HUB), request });
  return { link, ask, releases, stop };
}

// The direct path's stubs: a daemon answers for each root (ports outside every
// reserved band; nothing listens — the client is a stub), a client that
// records its posts, a service-manager runner that records its argv and, at
// the moment it is called, whether the unit file was still there.
function stubs(m, { daemons = true } = {}) {
  const ports = new Map([[m.ownedRoot, 40011], [m.folderRoot, 40012]]);
  const posts = [];
  const runs = [];
  const daemonForCalls = [];
  return {
    posts, runs, daemonForCalls,
    deps: {
      now: () => NOW,
      daemonFor: async (root) => {
        daemonForCalls.push(root);
        return daemons && ports.has(root) ? { pid: 1000 + ports.get(root), port: ports.get(root), source: 'portfile' } : null;
      },
      client: {
        post: async (p, body, opts) => { posts.push({ path: p, body, opts }); return { ok: true }; },
      },
      run: (argv) => { runs.push({ argv, unitPresent: fs.existsSync(m.unitFile) }); return ''; },
    },
  };
}

// The connect table run in-process with captured output.
async function connect(args, deps = {}) {
  const out = [];
  const err = [];
  const code = await table.main(args, { out: (l) => out.push(l), err: (l) => err.push(l), ...deps });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const unloadArgv = () => setup.serviceArgv('launchd').unload;
const stepNames = (r) => r.steps.map((s) => s.step);

// ── disconnectLocal ────────────────────────────────────────────────────────

test('disconnect with no connector answering: the owned root\'s daemon is stopped now, the folder chat\'s is left and named; key, record, unit and socket done; roots stay', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  const r = await setup.disconnectLocal({ hubId: HUB, reason: 'disconnect', deps: s.deps });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(stepNames(r), ['daemons', 'key', 'record', 'unload', 'unit', 'socket']);
  assert.equal(r.steps[0].via, 'direct');
  assert.deepEqual(r.steps[0].stopped, [OWNED_CHAT]);

  // The one shutdown: the owned root's daemon, with the header, its port
  // explicit and never a spawn.
  assert.equal(s.posts.length, 1, JSON.stringify(s.posts));
  const [post] = s.posts;
  assert.equal(post.path, '/api/shutdown');
  assert.equal(post.opts.port, 40011);
  assert.equal(post.opts.noSpawn, true);
  assert.equal(post.opts.headers['x-wc-shutdown'], '1');
  // The folder chat's daemon is left running, named.
  assert.deepEqual(r.left.map((l) => [l.chat_id, l.why, l.root]), [[FOLDER_CHAT, 'other', m.folderRoot]]);

  // The key, the record, the unit, the socket.
  assert.equal(fs.existsSync(m.keyFile), false, 'the key file is deleted');
  const after = setup.readRecord(HUB);
  assert.ok(after.ok, 'the record is still a record');
  assert.equal(after.value.credential.state, 'revoked');
  assert.equal(after.value.credential.revoked_at, NOW);
  assert.equal('key_file' in after.value.credential, false, 'the record no longer names a key file');
  assert.equal(after.value.chats.length, 2, 'the chats are kept');
  assert.equal(after.value.ceiling, 'full', 'the ceiling the user set is kept');
  assert.equal(after.value.service, null, 'the record names no unit once its file is gone (U716b)');
  assert.deepEqual(s.runs.map((x) => x.argv), [unloadArgv()]);
  assert.equal(s.runs[0].unitPresent, true, 'a disconnect unloads before it removes the file');
  assert.equal(fs.existsSync(m.unitFile), false, 'the unit file is removed');
  assert.equal(fs.existsSync(m.socketFile), false, 'the stale socket is removed');

  // Roots, folders and the workdir stay on disk.
  assert.ok(fs.existsSync(path.join(m.ownedRoot, 'notes.md')), 'the owned root stays');
  assert.ok(fs.existsSync(path.join(m.folderRoot, 'README.md')), 'the offered folder stays');
  assert.ok(fs.statSync(m.workdir).isDirectory(), 'the workdir stays');
});

test('with viaConnector answering it is asked once and nothing is posted directly', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  let asked = 0;
  const r = await setup.disconnectLocal({
    hubId: HUB,
    reason: 'disconnect',
    deps: { ...s.deps, viaConnector: async () => { asked += 1; return { ok: true }; } },
  });
  assert.equal(asked, 1);
  assert.deepEqual(s.posts, [], 'no direct shutdown');
  assert.deepEqual(s.daemonForCalls, [], 'no daemon looked up: the connector did it');
  assert.deepEqual(r.steps[0], { step: 'daemons', via: 'connector' });
  assert.deepEqual(stepNames(r), ['daemons', 'key', 'record', 'unload', 'unit', 'socket']);
  assert.equal(fs.existsSync(m.keyFile), false);
  assert.equal(setup.readRecord(HUB).value.credential.state, 'revoked');
});

test('a viaConnector that cannot answer (throws, or ok:false) falls back to the direct path', async (t) => {
  for (const via of [async () => { throw Object.assign(new Error('no connector'), { code: 'ECONNREFUSED' }); }, async () => ({ ok: false })]) {
    await t.test(String(via).slice(0, 40), async (st) => {
      const m = pairedMachine(st);
      const s = stubs(m);
      const r = await setup.disconnectLocal({ hubId: HUB, deps: { ...s.deps, viaConnector: via } });
      assert.equal(r.steps[0].via, 'direct');
      assert.equal(s.posts.length, 1);
      assert.equal(s.posts[0].opts.port, 40011);
    });
  }
});

test('a revocation takes the same steps in the same order, the unload last of all (it ends the service)', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  let asked = 0;
  const r = await setup.disconnectLocal({
    hubId: HUB,
    reason: 'revoked',
    deps: { ...s.deps, viaConnector: async () => { asked += 1; return { ok: true }; } },
  });
  assert.equal(r.ok, true);
  assert.equal(asked, 1, 'the in-process connector releases and stops');
  assert.deepEqual(stepNames(r), ['daemons', 'key', 'record', 'unit', 'socket', 'unload']);
  assert.deepEqual(s.runs.map((x) => x.argv), [unloadArgv()]);
  assert.equal(s.runs[0].unitPresent, false, 'the unit file was already gone when the unload ran');
  assert.equal(fs.existsSync(m.keyFile), false);
  assert.equal(fs.existsSync(m.socketFile), false);
  const after = setup.readRecord(HUB).value;
  assert.equal(after.credential.state, 'revoked');
  assert.equal(after.credential.revoked_at, NOW);
  assert.ok(fs.existsSync(m.ownedRoot) && fs.existsSync(m.folderRoot) && fs.existsSync(m.workdir));
});

test('an unload that fails (the unit was not loaded) is tolerated; the unit file still goes', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  const r = await setup.disconnectLocal({
    hubId: HUB,
    deps: { ...s.deps, run: () => { throw Object.assign(new Error('Boot-out failed: 3: No such process'), { status: 3 }); } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.steps.find((x) => x.step === 'unload').tolerated, '3');
  assert.equal(fs.existsSync(m.unitFile), false);
});

test('a second disconnect finds nothing left to do and still answers ok', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  await setup.disconnectLocal({ hubId: HUB, deps: s.deps });
  const again = await setup.disconnectLocal({ hubId: HUB, deps: { ...s.deps, now: () => NOW + 1 } });
  assert.equal(again.ok, true);
  assert.equal(again.steps.find((x) => x.step === 'key').removed, false);
  assert.equal(again.steps.find((x) => x.step === 'unit').removed, false);
  assert.equal(setup.readRecord(HUB).value.credential.revoked_at, NOW + 1);
  assert.ok(fs.existsSync(m.ownedRoot));
});

test('disconnectLocal refuses a reason it does not know', async (t) => {
  pairedMachine(t);
  await assert.rejects(setup.disconnectLocal({ hubId: HUB, reason: 'pause' }), TypeError);
});

// ── `connect disconnect` ───────────────────────────────────────────────────

test('`connect disconnect` prints what it did and what it left, and never the key', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  const r = await connect(['disconnect'], { disconnectDeps: s.deps });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Disconnected this machine from hub hale-hub/);
  assert.match(r.out, /stopped 1 daemon on owned roots/);
  assert.match(r.out, /the machine key deleted/);
  assert.match(r.out, /the record marked revoked/);
  assert.match(r.out, /the unit unloaded/);
  assert.match(r.out, /the unit file removed/);
  assert.ok(r.out.includes(`left running: chat ${FOLDER_CHAT}'s daemon at ${m.folderRoot}`), r.out);
  assert.match(r.out, /Chat roots, offered folders and the workdir stay on disk/);
  for (const line of m.pemLines) assert.ok(!r.out.includes(line) && !r.err.includes(line), 'no key text');
  assert.deepEqual(s.runs.map((x) => x.argv), [unloadArgv()]);
  assert.equal(s.posts.length, 1);
});

test('`connect disconnect` with the running connector answering hands it the release', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  let asked = 0;
  const r = await connect(['disconnect'], { disconnectDeps: s.deps, viaConnector: async () => { asked += 1; return { ok: true }; } });
  assert.equal(r.code, 0, r.err);
  assert.equal(asked, 1);
  assert.deepEqual(s.posts, []);
  assert.match(r.out, /the running connector released every hold/);
});

test('record.service is null after a disconnect, and `connect status` names no vanished unit (U716b)', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  assert.equal(setup.readRecord(HUB).value.service.kind, 'launchd');
  const r = await connect(['disconnect'], { disconnectDeps: s.deps });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(m.unitFile), false);
  assert.strictEqual(setup.readRecord(HUB).value.service, null);
  const status = await connect(['status'], { listRecords: setup.listRecords });
  assert.ok(!status.out.includes(m.unitFile), status.out);
  assert.match(status.out, /service: foreground only/);

  // A revocation clears it the same way (its unit file goes before the unload).
  const m2 = pairedMachine(t);
  const s2 = stubs(m2);
  await setup.disconnectLocal({ hubId: HUB, reason: 'revoked', deps: s2.deps });
  assert.strictEqual(setup.readRecord(HUB).value.service, null);
});

test('a unit file that cannot be removed leaves record.service naming it', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  fs.rmSync(m.unitFile);
  fs.mkdirSync(m.unitFile); // a directory where the unit file was: removeFile refuses it
  const r = await setup.disconnectLocal({ hubId: HUB, deps: s.deps });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((x) => x.step === 'unit').error, 'EISDIR');
  assert.equal(setup.readRecord(HUB).value.service.unit_path, m.unitFile);
});

test('a running connector whose link is down: the leave is not sent, release-all still runs, and the hub keeps this machine (U716b)', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  const asked = [];
  // The local socket's own answers: connector.leave with no link up, then the release.
  const ask = async (request) => {
    asked.push(request.type);
    return request.type === 'connector.leave'
      ? { ok: false, local: true, error: 'the connector is not connected to the hub' }
      : { ok: true, local: true, type: request.type, result: { released: 2, left: [] } };
  };
  const r = await connect(['disconnect'], { disconnectDeps: s.deps, ask });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(asked, ['connector.leave', 'connector.release-all']);
  assert.deepEqual(s.posts, [], 'the connector released: nothing posted directly');
  assert.match(r.out, /the running connector released every hold/);
  assert.ok(r.out.includes(setup.HUB_KEEPS), r.out);
  assert.doesNotMatch(r.out, /the hub was told this machine is leaving/);
});

test('offline, with no connector answering, `connect disconnect` says the hub keeps this machine until it is revoked there (U716b)', async (t) => {
  const m = pairedMachine(t);
  const s = stubs(m);
  const asked = [];
  // askConnector over a socket nobody listens on: ENOCONNECTOR.
  const ask = (request) => { asked.push(request.type); return localSocket.askConnector({ path: path.join(m.home, 'none.sock'), request }); };
  const r = await connect(['disconnect'], { disconnectDeps: s.deps, ask });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(asked, ['connector.leave'], 'nothing answered the first ask');
  assert.match(r.out, /stopped 1 daemon on owned roots \(the connector was not running\)/);
  assert.ok(r.out.includes(setup.HUB_KEEPS), r.out);
  assert.equal(setup.HUB_KEEPS, 'The hub keeps this machine until you revoke it there.', 'the sentence uninstall --self prints');
});

test('a connected `connect disconnect` asks connector.leave, then connector.release-all: the fake hub records exactly one machine.leave (U716b)', async (t) => {
  const m = pairedMachine(t, { short: true });
  const s = stubs(m);
  const fake = await withFakeHub(t, { hubId: HUB });
  const c = await runningConnector(t, fake);
  const r = await connect(['disconnect'], { disconnectDeps: s.deps, ask: c.ask });
  assert.equal(r.code, 0, r.err);
  assert.equal(fake.find('machine.leave', { dir: 'in' }).length, 1, 'exactly one machine.leave');
  assert.ok(fake.find('machine.leave', { dir: 'in' })[0].ok, 'the locked frame');
  assert.deepEqual(c.releases, [1], 'release-all ran once, after the leave was on the wire');
  assert.equal(c.link.state, 'stopped', 'the hub closed 1000: no redial');
  assert.equal(fake.machine().revoked, true);
  assert.deepEqual(s.posts, [], 'the connector stopped the daemons: nothing posted directly');
  assert.match(r.out, /the running connector released every hold/);
  assert.match(r.out, /the hub was told this machine is leaving/);
  assert.ok(!r.out.includes(setup.HUB_KEEPS));
  assert.equal(fs.existsSync(m.keyFile), false);
  assert.equal(setup.readRecord(HUB).value.credential.state, 'revoked');
});

test('a revocation (machine.revoked, then 4403) sends no machine.leave; the leave a later ask would make sends nothing (U716b)', async (t) => {
  pairedMachine(t, { short: true });
  const fake = await withFakeHub(t, { hubId: HUB });
  const c = await runningConnector(t, fake);
  const revoked = new Promise((resolve) => c.link.once('revoked', resolve));
  fake.revoke();
  await revoked;
  assert.equal(c.link.state, 'revoked');
  assert.deepEqual(await c.ask({ type: 'connector.leave', params: {} }), { ok: false, local: true, error: 'the connector is not connected to the hub' });
  // The revocation's local half: the in-process release, never the leave.
  const r = await setup.disconnectLocal({
    hubId: HUB,
    reason: 'revoked',
    deps: { viaConnector: async () => ({ ok: true }), run: () => '', now: () => NOW },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hub, 'revoked');
  assert.equal(fake.find('machine.leave', { dir: 'in' }).length, 0, 'none on a revocation');
});

test('`connect disconnect` with no record says so and touches nothing', async (t) => {
  withTempHome(t);
  const r = await connect(['disconnect'], { disconnectDeps: { run: () => assert.fail('no service manager') } });
  assert.equal(r.code, 0);
  assert.match(r.out, /not paired/);
  assert.equal(fs.existsSync(userPaths().connectorDir), false, 'nothing created');
});

// ── the ceiling ────────────────────────────────────────────────────────────

test('`connect ceiling read|full` writes exactly that; any other word exits 1 and leaves the record byte-identical', async (t) => {
  const m = pairedMachine(t);
  const dir = userPaths().connectorDir;

  let r = await connect(['ceiling', 'read']);
  assert.equal(r.code, 0, r.err);
  assert.equal(setup.readRecord(HUB).value.ceiling, 'read');
  assert.match(r.out, /^Ceiling: read$/m);
  assert.match(r.out, /apply it at once/);
  assert.match(r.out, /no hub frame changes it/);
  assert.equal(readCeiling(m.recordFile, { connectorDir: dir }), 'read');

  r = await connect(['ceiling', 'full']);
  assert.equal(r.code, 0, r.err);
  assert.equal(setup.readRecord(HUB).value.ceiling, 'full');
  assert.equal(readCeiling(m.recordFile, { connectorDir: dir }), 'full');

  const before = fs.readFileSync(m.recordFile);
  for (const word of ['admin', 'basic', 'local', 'READ', '']) {
    r = await connect(['ceiling', word]);
    assert.equal(r.code, 1, `ceiling ${JSON.stringify(word)}`);
    assert.match(r.err, /the ceiling is read or full/);
    assert.ok(fs.readFileSync(m.recordFile).equals(before), `the record is byte-identical after ${JSON.stringify(word)}`);
  }
  r = await connect(['ceiling', 'read', 'full']);
  assert.equal(r.code, 1);
  assert.ok(fs.readFileSync(m.recordFile).equals(before));
});

test('`connect ceiling` alone prints readCeiling\'s reading; a record pairing wrote (no ceiling set since) reads full', async (t) => {
  withTempHome(t);
  // As pairing writes it: newRecord through withDefaults.
  setup.writeRecord(setup.newRecord({ hubId: HUB, origin: 'https://hub.example.com' }));
  const file = userPaths().connectorRecord(HUB);
  const dir = userPaths().connectorDir;
  assert.equal(readCeiling(file, { connectorDir: dir }), 'full');
  assert.equal(readCeiling(file, { connectorDir: dir }), ceilingOf(readJson(file)), 'readCeiling applies ceilingOf');
  let r = await connect(['ceiling']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Ceiling: full');

  // A record with no `ceiling` key at all is full too (case ii).
  const rec = setup.readRecord(HUB).value;
  delete rec.ceiling;
  setup.writeRecord(rec);
  assert.equal(readCeiling(file, { connectorDir: dir }), 'full');
  r = await connect(['ceiling']);
  assert.equal(r.out, 'Ceiling: full');
  // withDefaults never overwrites a value the user set.
  await connect(['ceiling', 'read']);
  assert.equal(setup.withDefaults(setup.readRecord(HUB).value).ceiling, 'read');
});

test('`connect ceiling` with no record prints not paired; setting one with no record exits 1 and creates nothing', async (t) => {
  withTempHome(t);
  let r = await connect(['ceiling']);
  assert.equal(r.code, 0);
  assert.match(r.out, /not paired/);
  r = await connect(['ceiling', 'read']);
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(userPaths().connectorDir), false);
});

test('a connected daemon follows `connect ceiling` without a restart, through the reader `connect ceiling` prints', async (t) => {
  const m = pairedMachine(t);
  const secret = crypto.randomBytes(32).toString('hex');
  const d = await withServer(t, {
    createServer: (o) => createServer({ ...o, relaySecret: secret, relaySecretVia: 'option', connectorRecord: m.recordFile }),
  });
  assert.ok(d.port > 0 && !(d.port >= 5170 && d.port <= 5272), `an ephemeral port outside the band: ${d.port}`);
  assert.equal(d.srv.audience.connected(), true);
  assert.equal(d.srv.audience.ceiling(), 'full');

  let r = await connect(['ceiling', 'read']);
  assert.equal(r.code, 0, r.err);
  await waitUntil(() => d.srv.audience.ceiling() === 'read', { timeout: 15000, interval: 20, what: 'the daemon reading read' });
  assert.equal(d.srv.audience.ceiling(), readCeiling(m.recordFile, { connectorDir: userPaths().connectorDir }));

  r = await connect(['ceiling', 'full']);
  assert.equal(r.code, 0, r.err);
  await waitUntil(() => d.srv.audience.ceiling() === 'full', { timeout: 15000, interval: 20, what: 'the daemon reading full' });
});

// ── the cap ────────────────────────────────────────────────────────────────

test('`connect cap 2` writes local_cap 2 and prints the effective cap; a cap above the hub\'s never raises it', async (t) => {
  pairedMachine(t, { settings: { agents_at_once: 4 } });
  let r = await connect(['cap', '2']);
  assert.equal(r.code, 0, r.err);
  assert.equal(setup.readRecord(HUB).value.settings.local_cap, 2);
  assert.match(r.out, /^Effective cap: 2 /m);

  r = await connect(['cap', '9']);
  assert.equal(r.code, 0, r.err);
  const s = setup.readRecord(HUB).value.settings;
  assert.equal(s.local_cap, 9);
  assert.equal(s.agents_at_once, 4, 'the hub\'s cap is untouched');
  assert.match(r.out, /^Effective cap: 4 /m, 'the lesser: a local cap never raises the hub\'s');
  assert.equal(setup.effectiveCapOf(s), 4);

  r = await connect(['cap', '0']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Effective cap: 0 /m);
  r = await connect(['cap', '64']);
  assert.equal(r.code, 0);
});

test('`connect cap 65`, `-1`, `x`, `2.5`, `02` and no argument exit 1 with the record untouched', async (t) => {
  const m = pairedMachine(t);
  const before = fs.readFileSync(m.recordFile);
  for (const args of [['65'], ['-1'], ['x'], ['2.5'], ['02'], [], ['2', '3']]) {
    const r = await connect(['cap', ...args]);
    assert.equal(r.code, 1, `cap ${args.join(' ')}`);
    assert.match(r.err, /usage: claude-web-chat connect cap <n>/);
    assert.ok(fs.readFileSync(m.recordFile).equals(before));
  }
  assert.throws(() => setup.setLocalCap(HUB, 65), { code: 'EBADCAP' });
  assert.throws(() => setup.setCeiling(HUB, 'admin'), { code: 'EBADCEILING' });
  assert.ok(fs.readFileSync(m.recordFile).equals(before));
});

// ── no pause, no resume ────────────────────────────────────────────────────

test('no pause or resume row: `connect pause` prints the usage and exits 1', async (t) => {
  withTempHome(t);
  assert.ok(!table.ROWS.some((row) => row.name === 'pause' || row.name === 'resume'));
  for (const word of ['pause', 'resume']) {
    const r = await connect([word]);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown subcommand/);
    assert.match(r.err, /usage: claude-web-chat connect <subcommand>/);
  }
  const help = await connect(['help']);
  for (const usage of ['connect disconnect', 'connect ceiling [read|full]', 'connect cap <n>']) {
    assert.ok(help.out.includes(`claude-web-chat ${usage}`), usage);
  }
});

// ── hand fold 7 (i), U790: the leave outlives a failed release ─────────────

test('the leave was sent, then release-all answers ok:false or throws: the output names the leave, not HUB_KEEPS, and the direct path stops the daemons (U790)', async (t) => {
  for (const failure of ['ok-false', 'throws']) {
    const m = pairedMachine(t);
    const s = stubs(m);
    const asked = [];
    const ask = async (request) => {
      asked.push(request.type);
      if (request.type === 'connector.leave') return { ok: true, local: true, type: request.type, result: { sent: true, closed: true } };
      // The connector exits on the hub's 1000 close: the second ask fails.
      if (failure === 'throws') throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
      return { ok: false, local: true, error: 'the release failed (error)' };
    };
    const r = await connect(['disconnect'], { disconnectDeps: s.deps, ask });
    assert.equal(r.code, 0, `${failure}: ${r.err}`);
    assert.deepEqual(asked, ['connector.leave', 'connector.release-all'], failure);
    assert.match(r.out, /the hub was told this machine is leaving/, failure);
    assert.ok(!r.out.includes(setup.HUB_KEEPS), `${failure}: ${r.out}`);
    assert.match(r.out, /stopped \d+ daemons? on owned roots/, `${failure}: the release was not done, so the direct path ran`);
  }
});

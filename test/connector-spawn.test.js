// The supervised spawn (tranche 6, U718): lib/util/daemon spawnDaemon's relay
// secret on fd 3 and its child_pid, and lib/connector/supervisor.js — adopt
// first, spawn with the secret and the record path, started_by by the pid
// compare, the per-chat rate limit (contract 06 C-06.19; 03 C-03.22; 10 C-10.5).
//
// No daemon runs here: the "daemon" is a stub node script started through
// spawnDaemon's spawn seam as spawnDetached({bin: stub, …}); it reads fd 3,
// writes what it saw (a sha256 of the bytes, never the bytes) and exits.
// daemonFor and answersFor are stubs, so nothing is probed and no port is bound.
// The minted secret is held in this file's memory and compared, never printed
// or written: every assertion that touches it compares with `===` under
// assert.ok, so a failure cannot echo it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

const { spawnDaemon, spawnDetached } = require('../lib/util/daemon');
const { createSupervisor, STARTED_BY } = require('../lib/connector/supervisor');
const { START_EVERY_MS, START_WAIT_MS } = require('../lib/relay');
const { instanceId } = require('../lib/util/registry');
const { withTempHome, waitUntil } = require('../test-support/helpers');

const HEX64 = /[0-9a-f]{64}/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const CHAT = '01jbzam3n5p7q9r1s3t5v7w9x1';
const FAKE_PORT = 1; // never bound: daemonFor and answersFor are stubs

function scratch(t, prefix = 'wc-connector-spawn-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// The stub daemon: read fd 3 to EOF (blocking; EAGAIN retried), close it, and
// write a result file named by argv[2]. It reports a sha of what it read, never
// the bytes.
const STUB = `
const fs = require('fs');
const crypto = require('crypto');
const buf = Buffer.alloc(256);
let got = '';
let err = null;
const deadline = Date.now() + 5000;
for (;;) {
  let n = 0;
  try { n = fs.readSync(3, buf, 0, buf.length, null); }
  catch (e) {
    if (e.code === 'EAGAIN' && Date.now() < deadline) continue;
    err = e.code || 'error';
    break;
  }
  if (n <= 0) break;
  got += buf.toString('utf8', 0, n);
}
try { fs.closeSync(3); } catch {}
const out = {
  err,
  len: got.length,
  sha: crypto.createHash('sha256').update(got).digest('hex'),
  fd: process.env.WEB_CHAT_RELAY_SECRET_FD === undefined ? null : process.env.WEB_CHAT_RELAY_SECRET_FD,
  record: process.env.WEB_CHAT_CONNECTOR_RECORD === undefined ? null : process.env.WEB_CHAT_CONNECTOR_RECORD,
  secretEnv: Object.prototype.hasOwnProperty.call(process.env, 'WEB_CHAT_RELAY_SECRET'),
  portEnv: Object.prototype.hasOwnProperty.call(process.env, 'WEB_CHAT_PORT'),
  firstPort: process.env.WEB_CHAT_FIRST_PORT === undefined ? null : process.env.WEB_CHAT_FIRST_PORT,
};
fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify(out));
fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
`;

// A supervisor over the REAL spawnDaemon whose spawn seam starts the stub.
// `answerPid(child)` is what daemonFor answers once the stub has reported
// (child.pid: our own spawn won; another pid: a racing spawn won).
function stubRig(t, { answerPid = (child) => child.pid, env: extraEnv = {} } = {}) {
  const dir = scratch(t);
  const stub = path.join(dir, 'stub-daemon.js');
  fs.writeFileSync(stub, STUB);
  const result = path.join(dir, 'result.json');
  const log = path.join(dir, 'logs', 'server.log');
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  const recordPath = path.join(dir, 'connector', 'hub-one.json');

  const rig = { dir, stub, result, root, recordPath, child: null, seamCalls: [], spawnReturns: [], lines: [], minted: [] };
  rig.daemonFor = async () => {
    if (!rig.child || !fs.existsSync(result)) return null;
    return { pid: answerPid(rig.child), port: FAKE_PORT, url: `http://localhost:${FAKE_PORT}`, source: 'portfile' };
  };
  const seam = (r, opts) => {
    rig.seamCalls.push({ root: r, opts });
    rig.child = spawnDetached({ bin: stub, args: [result], log, env: opts.env, extraFds: opts.extraFds });
    return rig.child;
  };
  rig.supervisor = createSupervisor({
    recordPath,
    log: (line) => rig.lines.push(line),
    deps: {
      spawnDaemon: async (r, opts) => {
        const rec = await spawnDaemon(r, { ...opts, spawn: seam, daemonFor: rig.daemonFor });
        rig.spawnReturns.push(rec);
        return rec;
      },
      daemonFor: rig.daemonFor,
      answersFor: async () => true,
      randomBytes: (n) => {
        const b = crypto.randomBytes(n);
        rig.minted.push(b.toString('hex'));
        return b;
      },
      now: () => 1_000_000,
      env: {
        ...process.env,
        WEB_CHAT_FIRST_PORT: '41000', // an unrelated variable (U749's walk seam) passes through
        WEB_CHAT_RELAY_SECRET: 'inherited-not-a-secret',
        WEB_CHAT_PORT: '41999',
        ...extraEnv,
      },
    },
  });
  rig.readResult = () => JSON.parse(fs.readFileSync(result, 'utf8'));
  return rig;
}

function noHex64In(value, what) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!HEX64.test(text), `${what} holds a 64-hex value`);
}

// ── the spawn: the secret on fd 3, the record path, nothing else of it ─────

test('a spawned daemon reads the minted secret on fd 3, the fd named 3 and the record path, and nothing else of the secret exists', async (t) => {
  const rig = stubRig(t);
  const answer = await rig.supervisor.ensureRunning({ id: CHAT, root: rig.root });
  const r = rig.readResult();

  assert.equal(rig.minted.length, 1, 'one secret minted');
  const secret = rig.minted[0];
  assert.ok(/^[0-9a-f]{64}$/.test(secret), 'the minted secret is 64 lowercase hex');
  assert.equal(r.err, null);
  assert.equal(r.len, 64);
  assert.ok(r.sha === sha256(secret), 'the stub read exactly the minted secret on fd 3');
  assert.equal(r.fd, '3');
  assert.equal(r.record, rig.recordPath);
  assert.ok(path.isAbsolute(r.record));
  assert.equal(r.secretEnv, false, 'an inherited WEB_CHAT_RELAY_SECRET is removed');
  assert.equal(r.portEnv, false, 'no WEB_CHAT_PORT reaches the child');
  assert.equal(r.firstPort, '41000', 'an unrelated variable passes through untouched');

  // The env handed to the spawn seam and the stub's argv hold no 64-hex value.
  assert.equal(rig.seamCalls.length, 1);
  const { opts } = rig.seamCalls[0];
  noHex64In(opts.env, 'the env handed to the spawn seam');
  assert.equal(opts.env.WEB_CHAT_RELAY_SECRET_FD, '3');
  assert.equal(opts.env.WEB_CHAT_CONNECTOR_RECORD, rig.recordPath);
  assert.ok(!('WEB_CHAT_PORT' in opts.env));
  assert.ok(!('WEB_CHAT_RELAY_SECRET' in opts.env));
  assert.deepEqual(opts.extraFds, ['pipe']);
  noHex64In(rig.child.spawnargs, "the stub's argv");

  // spawnDaemon returned the record plus the child's pid.
  assert.equal(rig.spawnReturns[0].child_pid, rig.child.pid);
  assert.equal(rig.spawnReturns[0].pid, rig.child.pid);
  // The secret pipe is gone from the parent.
  assert.ok(rig.child.stdio[3].destroyed, 'the parent end of the fd-3 pipe is destroyed');

  assert.deepEqual(answer, { state: 'running', port: FAKE_PORT, pid: rig.child.pid, started_by: 'connector' });
  assert.equal(rig.supervisor.startedBy(CHAT), STARTED_BY.CONNECTOR);
  assert.ok(rig.supervisor.relayCredential(CHAT) === secret, 'relayCredential answers the secret for its own spawn');

  // The log names the chat, pid, port and started_by; never the secret or its sha.
  assert.ok(rig.lines.length > 0);
  for (const line of rig.lines) {
    noHex64In(line, 'a supervisor log line');
    assert.ok(!line.includes(sha256(secret)));
  }
  assert.ok(rig.lines.some((l) => l.includes(CHAT) && l.includes(String(rig.child.pid)) && l.includes('started_by connector')));

  // Asked again while the same pid answers: still ours, no second spawn.
  const again = await rig.supervisor.ensureRunning({ id: CHAT, root: rig.root });
  assert.equal(again.started_by, 'connector');
  assert.equal(rig.seamCalls.length, 1);
  assert.ok(rig.supervisor.relayCredential(CHAT) === secret);

  // forget drops the secret and started_by.
  rig.supervisor.forget(CHAT);
  assert.equal(rig.supervisor.relayCredential(CHAT), null);
  assert.equal(rig.supervisor.startedBy(CHAT), null);
});

test('a racing spawn wins the bind: the verified pid is not our child, so other and no relay credential', async (t) => {
  const rig = stubRig(t, { answerPid: () => process.pid });
  const answer = await rig.supervisor.ensureRunning({ id: CHAT, root: rig.root });
  assert.equal(rig.seamCalls.length, 1, 'it spawned');
  assert.equal(rig.spawnReturns[0].child_pid, rig.child.pid);
  assert.notEqual(rig.spawnReturns[0].pid, rig.child.pid);
  assert.deepEqual(answer, { state: 'running', port: FAKE_PORT, pid: process.pid, started_by: 'other' });
  assert.equal(rig.supervisor.startedBy(CHAT), 'other');
  assert.equal(rig.supervisor.relayCredential(CHAT), null);
  for (const line of rig.lines) noHex64In(line, 'a supervisor log line');
});

test('our daemon replaced by another pid (a restart without fd 3) is demoted to other', async (t) => {
  let pidNow = null;
  const rig = stubRig(t, { answerPid: (child) => (pidNow == null ? child.pid : pidNow) });
  await rig.supervisor.ensureRunning({ id: CHAT, root: rig.root });
  assert.equal(rig.supervisor.startedBy(CHAT), 'connector');
  pidNow = process.pid;
  const answer = await rig.supervisor.ensureRunning({ id: CHAT, root: rig.root });
  assert.equal(answer.started_by, 'other');
  assert.equal(rig.supervisor.relayCredential(CHAT), null);
  assert.equal(rig.seamCalls.length, 1, 'adopted, not respawned');
});

// ── the supervisor's other paths (no child at all) ─────────────────────────

function fakeRig({ live = null, spawnAnswer = null, answers = true, now = () => 0 } = {}) {
  const calls = { spawn: [], answersFor: [], minted: [], lines: [] };
  const sup = createSupervisor({
    recordPath: '/tmp/wc-connector-spawn-record/hub-one.json',
    log: (l) => calls.lines.push(l),
    deps: {
      daemonFor: async () => (typeof live === 'function' ? live() : live),
      spawnDaemon: async (root, opts) => {
        calls.spawn.push({ root, maxMs: opts.maxMs, envKeys: Object.keys(opts.env || {}) });
        return typeof spawnAnswer === 'function' ? spawnAnswer() : spawnAnswer;
      },
      answersFor: async (rec, id, opts) => { calls.answersFor.push({ rec, id, opts }); return answers; },
      randomBytes: (n) => { const b = crypto.randomBytes(n); calls.minted.push(b.toString('hex')); return b; },
      now,
    },
  });
  return { sup, calls };
}

test('an adopted live daemon spawns nothing, mints nothing, and is other with no credential', async () => {
  const { sup, calls } = fakeRig({ live: { pid: 4321, port: FAKE_PORT, url: 'x', source: 'registry' } });
  const answer = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.deepEqual(answer, { state: 'running', port: FAKE_PORT, pid: 4321, started_by: 'other' });
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.minted.length, 0);
  assert.equal(sup.relayCredential(CHAT), null);
  assert.equal(sup.startedBy(CHAT), 'other');
  // Identity confirmed with the strict rule against this root's instance id.
  assert.equal(calls.answersFor.length, 1);
  assert.equal(calls.answersFor[0].id, instanceId('/tmp/wc-chat-root'));
  assert.deepEqual(calls.answersFor[0].opts, { strictInstance: true });
});

test('starts are rate-limited per chat with START_EVERY_MS, counted from the attempt', async () => {
  let t = 5_000_000;
  const { sup, calls } = fakeRig({ spawnAnswer: null, now: () => t });
  const first = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.deepEqual(first, { state: 'failed', reason: 'daemon-timeout' });
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.spawn[0].maxMs, START_WAIT_MS, 'the wait is START_WAIT_MS');

  t += 4000;
  const second = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.deepEqual(second, { state: 'starting', retry_in_ms: START_EVERY_MS - 4000 });
  assert.equal(calls.spawn.length, 1, 'the second attempt spawned nothing');

  // Another chat is not limited by this one.
  const other = await sup.ensureRunning({ id: '01jbzam3n5p7q9r1s3t5v7w9x2', root: '/tmp/wc-chat-root-2' });
  assert.equal(other.state, 'failed');
  assert.equal(calls.spawn.length, 2);

  t += START_EVERY_MS - 4000;
  await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.equal(calls.spawn.length, 3, 'after START_EVERY_MS a third attempt spawns');
});

test('two concurrent first calls for one chat spawn once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { sup, calls } = fakeRig({ spawnAnswer: () => gate.then(() => null) });
  const a = sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  const b = sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  const second = await b;
  assert.equal(second.state, 'starting');
  release();
  assert.equal((await a).reason, 'daemon-timeout');
  assert.equal(calls.spawn.length, 1);
});

test('no daemon within START_WAIT_MS is failed daemon-timeout and the secret is dropped', async () => {
  const { sup, calls } = fakeRig({ spawnAnswer: null });
  const answer = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.deepEqual(answer, { state: 'failed', reason: 'daemon-timeout' });
  assert.equal(calls.minted.length, 1, 'a secret was minted for the attempt');
  assert.equal(sup.relayCredential(CHAT), null);
  assert.equal(sup.startedBy(CHAT), null);
  assert.ok(calls.spawn[0].envKeys.includes('WEB_CHAT_CONNECTOR_RECORD'));
  assert.ok(!calls.spawn[0].envKeys.includes('WEB_CHAT_PORT'));
  for (const line of calls.lines) noHex64In(line, 'a supervisor log line');
});

test('a daemon that fails the strict identity check is failed identity-mismatch, with no credential', async () => {
  const { sup, calls } = fakeRig({ spawnAnswer: { pid: 77, port: FAKE_PORT, url: 'x', source: 'portfile', child_pid: 77 }, answers: false });
  const answer = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.deepEqual(answer, { state: 'failed', reason: 'identity-mismatch' });
  assert.equal(calls.answersFor[0].opts.strictInstance, true);
  assert.equal(sup.relayCredential(CHAT), null);
  assert.equal(sup.startedBy(CHAT), null);
});

test('a spawn that throws is failed, and a record with no child_pid is other', async () => {
  const thrower = fakeRig({ spawnAnswer: () => { throw new Error('spawn ENOENT'); } });
  assert.deepEqual(await thrower.sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' }), { state: 'failed', reason: 'other' });
  assert.equal(thrower.sup.relayCredential(CHAT), null);

  const noChild = fakeRig({ spawnAnswer: { pid: 77, port: FAKE_PORT, url: 'x', source: 'portfile' } });
  const answer = await noChild.sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.equal(answer.started_by, 'other');
  assert.equal(noChild.sup.relayCredential(CHAT), null);
});

test('createSupervisor: the record path is absolute, from recordPath or the hub id; install puts one supervisor on the context', (t) => {
  const home = withTempHome(t);
  const derived = createSupervisor({ hubId: 'hub-one', deps: { daemonFor: async () => null } });
  assert.equal(typeof derived.ensureRunning, 'function');
  assert.throws(() => createSupervisor({ hubId: '../evil' }), /absolute path/);
  assert.throws(() => createSupervisor({ recordPath: 'relative/hub-one.json' }), /absolute path/);
  assert.ok(home);

  const ctx = {};
  const uninstall = derived.install(ctx);
  assert.equal(ctx.supervisor.relayCredential, derived.relayCredential);
  const second = createSupervisor({ recordPath: '/tmp/x/hub-one.json' });
  assert.throws(() => second.install(ctx), /already installed/);
  uninstall();
  assert.equal(ctx.supervisor, undefined);
});

test('ensureRunning refuses a chat with no id or a relative root', async () => {
  const { sup } = fakeRig();
  await assert.rejects(sup.ensureRunning({ root: '/tmp/x' }), /id/);
  await assert.rejects(sup.ensureRunning({ id: CHAT, root: 'x' }), /absolute root/);
});

// ── spawnDaemon on its own ─────────────────────────────────────────────────

test('spawnDaemon refuses a secret that is not 64 lowercase hex before spawning or probing', async () => {
  const bad = ['abc', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 42, {}];
  for (const secret of bad) {
    let probed = 0;
    let spawned = 0;
    await assert.rejects(
      spawnDaemon('/tmp/wc-x', { secret, daemonFor: async () => { probed++; return null; }, spawn: () => { spawned++; } }),
      (e) => e instanceof TypeError && /64 lowercase hex/.test(e.message) && !HEX64.test(e.message),
    );
    assert.equal(spawned, 0);
    assert.equal(probed, 0);
  }
});

test('spawnDaemon with a secret: a seam that returns no pipe at stdio[3] is refused', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  await assert.rejects(
    spawnDaemon('/tmp/wc-x', { secret, maxMs: 50, daemonFor: async () => null, spawn: () => ({ pid: 9, stdio: [null, null, null] }) }),
    (e) => /no pipe for the secret/.test(e.message) && !HEX64.test(e.message),
  );
  await assert.rejects(
    spawnDaemon('/tmp/wc-x', { secret, maxMs: 50, daemonFor: async () => null, spawn: () => undefined }),
    /no pipe for the secret/,
  );
});

function fakePipe({ fail = false } = {}) {
  const chunks = [];
  const w = new Writable({
    write(chunk, enc, cb) {
      if (fail) { const e = new Error('write EPIPE'); e.code = 'EPIPE'; cb(e); return; }
      chunks.push(Buffer.from(chunk)); cb();
    },
  });
  w.unref = () => { w.unrefd = true; };
  w.read = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

test('spawnDaemon writes the secret once to fd 3, ends and destroys the stream, and strips an inherited WEB_CHAT_RELAY_SECRET', async (t) => {
  const prev = process.env.WEB_CHAT_RELAY_SECRET;
  process.env.WEB_CHAT_RELAY_SECRET = 'inherited';
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_RELAY_SECRET; else process.env.WEB_CHAT_RELAY_SECRET = prev; });

  const secret = crypto.randomBytes(32).toString('hex');
  const pipe = fakePipe();
  let seen = null;
  let found = 0;
  const rec = await spawnDaemon('/tmp/wc-x', {
    secret,
    maxMs: 2000,
    daemonFor: async () => (found++ === 0 ? null : { pid: 31337, port: FAKE_PORT, url: 'x', source: 'portfile' }),
    spawn: (root, opts) => { seen = opts; return { pid: 31337, stdio: [null, null, null, pipe] }; },
  });
  assert.ok(pipe.read() === secret, 'the secret was written to the pipe, exactly');
  assert.ok(pipe.destroyed, 'the stream is destroyed');
  assert.ok(pipe.unrefd, 'the stream is unref\'d');
  assert.equal(seen.env.WEB_CHAT_RELAY_SECRET_FD, '3');
  assert.ok(!('WEB_CHAT_RELAY_SECRET' in seen.env));
  assert.ok(!('WEB_CHAT_PORT' in seen.env));
  assert.equal(seen.env.HOME, process.env.HOME, 'the environment otherwise passes through');
  noHex64In(seen.env, 'the env handed to the spawn seam');
  assert.deepEqual(rec, { pid: 31337, port: FAKE_PORT, url: 'x', source: 'portfile', child_pid: 31337 });
});

test('spawnDaemon swallows an EPIPE from a child that died and reports the wait as usual', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const pipe = fakePipe({ fail: true });
  const rec = await spawnDaemon('/tmp/wc-x', {
    secret, maxMs: 150, daemonFor: async () => null,
    spawn: () => ({ pid: 5, stdio: [null, null, null, pipe] }),
  });
  assert.equal(rec, null);
  assert.ok(pipe.destroyed);
});

test('spawnDaemon without a secret: the seam gets (root) only, adoption returns the record unchanged, a spawn adds child_pid', async () => {
  const live = { pid: 11, port: FAKE_PORT, url: 'x', source: 'registry' };
  let spawned = 0;
  const adopted = await spawnDaemon('/tmp/wc-x', { daemonFor: async () => live, spawn: () => { spawned++; } });
  assert.equal(adopted, live, 'the adoption path returns daemonFor\'s record itself');
  assert.ok(!('child_pid' in adopted));
  assert.equal(spawned, 0);

  const args = [];
  let n = 0;
  const rec = await spawnDaemon('/tmp/wc-x', {
    maxMs: 2000,
    daemonFor: async () => (n++ === 0 ? null : { ...live }),
    spawn: (...a) => { args.push(a); return { pid: 4242 }; },
  });
  assert.deepEqual(args, [['/tmp/wc-x']], 'the old seam signature, nothing more');
  assert.deepEqual(rec, { ...live, child_pid: 4242 });

  // A seam that returns no child (the existing tests' shape): no child_pid.
  let m = 0;
  const bare = await spawnDaemon('/tmp/wc-x', { maxMs: 2000, daemonFor: async () => (m++ === 0 ? null : { ...live }), spawn: () => {} });
  assert.deepEqual(bare, live);
});

test('spawnDetached appends extraFds after stdout and stderr: the first is the child\'s fd 3', async (t) => {
  const dir = scratch(t);
  const script = path.join(dir, 'fds.js');
  const out = path.join(dir, 'fds.json');
  // With an fd-3 pipe the child reads it to EOF; without one it reads nothing.
  fs.writeFileSync(script, `
const fs = require('fs');
let got = '';
if (process.argv[3] === 'read') {
  const buf = Buffer.alloc(64);
  for (;;) {
    let n = 0;
    try { n = fs.readSync(3, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') continue; break; }
    if (n <= 0) break;
    got += buf.toString('utf8', 0, n);
  }
}
fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ got }));
fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
`);
  const plain = spawnDetached({ bin: script, args: [out, 'skip'], log: path.join(dir, 'a.log') });
  assert.equal(plain.stdio.length, 3, 'no extra stdio without extraFds');
  await waitUntil(() => fs.existsSync(out), { timeout: 10000, what: 'the plain child' });
  fs.rmSync(out);

  const piped = spawnDetached({ bin: script, args: [out, 'read'], log: path.join(dir, 'b.log'), extraFds: ['pipe'] });
  assert.equal(piped.stdio.length, 4);
  piped.stdio[3].end('fd-three', () => piped.stdio[3].destroy());
  await waitUntil(() => fs.existsSync(out), { timeout: 10000, what: 'the piped child' });
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).got, 'fd-three');
});

// ── the source: constants from lib/relay; no portal, no port, no kill ──────

test('supervisor.js takes START_* from lib/relay and never requires lib/portal, reads server.json, sets WEB_CHAT_PORT or kills', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'connector', 'supervisor.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(requires.includes('../relay'), 'START_EVERY_MS and START_WAIT_MS come from lib/relay');
  assert.ok(!requires.some((r) => /portal/.test(r)), `no lib/portal require: ${requires.join(', ')}`);
  assert.ok(!/server\.json/.test(src));
  assert.ok(!/process\.kill\(/.test(src));
  assert.ok(!/WEB_CHAT_PORT\s*[:=]/.test(src), 'WEB_CHAT_PORT is never set');
  assert.ok(!/WEB_CHAT_RELAY_SECRET\s*[:=]/.test(src), 'the secret never goes in the environment');
  const daemonSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'util', 'daemon.js'), 'utf8');
  assert.equal((daemonSrc.match(/openSync\(/g) || []).length, 1, 'one append-mode open, as before');
  assert.ok(!/WEB_CHAT_PORT\b/.test(daemonSrc));
});

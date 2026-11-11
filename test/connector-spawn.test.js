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

const daemonUtil = require('../lib/util/daemon');
const { spawnDaemon, spawnDetached } = daemonUtil;
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

// The world is consistent (U718b): once spawnDaemon has handed back a record,
// daemonFor answers that record (spawnDaemon verified it through daemonFor),
// unless the case says what daemonFor answers (`live`).
function fakeRig({ live = null, spawnAnswer = null, answers = true, now = () => 0, ...extra } = {}) {
  const calls = { spawn: [], answersFor: [], minted: [], lines: [], spawned: null };
  const sup = createSupervisor({
    recordPath: '/tmp/wc-connector-spawn-record/hub-one.json',
    log: (l) => calls.lines.push(l),
    deps: {
      daemonFor: async () => (typeof live === 'function' ? live() : (live || calls.spawned)),
      spawnDaemon: async (root, opts) => {
        calls.spawn.push({ root, maxMs: opts.maxMs, envKeys: Object.keys(opts.env || {}) });
        const rec = await (typeof spawnAnswer === 'function' ? spawnAnswer() : spawnAnswer);
        calls.spawned = rec ? { ...rec } : null;
        if (calls.spawned) delete calls.spawned.child_pid;
        return rec;
      },
      ...extra,
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

// ── the survivor (U718b): never a record whose pid is not daemonFor's ──────

test('a supervisor whose recorded pid stepped aside adopts the survivor: other, no credential, nothing spawned again', async () => {
  const { sup, calls } = fakeRig({
    spawnAnswer: { pid: 501, port: FAKE_PORT, url: 'x', source: 'portfile', child_pid: 501 },
    // The first check after the spawn: the root's daemon is another one.
    live: () => (calls.spawn.length ? { pid: 777, port: FAKE_PORT + 1, url: 'y', source: 'portfile' } : null),
  });
  const answer = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.deepEqual(answer, { state: 'running', port: FAKE_PORT + 1, pid: 777, started_by: 'other' });
  assert.equal(calls.spawn.length, 1, 'adopted, not spawned again');
  assert.equal(sup.startedBy(CHAT), 'other');
  assert.equal(sup.relayCredential(CHAT), null, 'the secret handed to the child that stepped aside is dropped');
  // Identity confirmed for the spawned record and again for the survivor.
  assert.deepEqual(calls.answersFor.map((c) => c.rec.pid), [501, 777]);
  assert.ok(calls.lines.some((l) => /pid 501 stepped aside for pid 777/.test(l)), calls.lines.join('\n'));
  for (const line of calls.lines) noHex64In(line, 'a supervisor log line');
});

test('the handed pid gone and no daemon up: the supervisor spawns once more through spawnDaemon, and only once', async () => {
  let n = 0;
  const pids = [601, 602];
  const recs = [];
  const { sup, calls } = fakeRig({
    spawnAnswer: () => { const pid = pids[n++]; const r = { pid, port: FAKE_PORT, url: 'x', source: 'portfile', child_pid: pid }; recs.push(r); return r; },
    // 601 is gone the moment it is handed back; 602 is the root's daemon.
    live: () => (n >= 2 ? { pid: 602, port: FAKE_PORT, url: 'x', source: 'portfile' } : null),
    isPidAlive: (pid) => pid === 602,
  });
  const answer = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.equal(calls.spawn.length, 2);
  assert.deepEqual(answer, { state: 'running', port: FAKE_PORT, pid: 602, started_by: 'connector' });
  assert.equal(calls.minted.length, 2, 'a fresh secret for the second spawn');
  assert.ok(sup.relayCredential(CHAT) === calls.minted[1], 'the credential is the second child\'s secret');
  assert.ok(calls.lines.some((l) => /pid 601 is gone and none is up; spawning again/.test(l)));

  // Never more than once more: a world where nothing stays up is daemon-timeout.
  let m = 0;
  const never = fakeRig({
    spawnAnswer: () => { m++; return { pid: 700 + m, port: FAKE_PORT, url: 'x', source: 'portfile', child_pid: 700 + m }; },
    live: () => null,
    isPidAlive: () => false,
  });
  assert.deepEqual(await never.sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' }), { state: 'failed', reason: 'daemon-timeout' });
  assert.equal(never.calls.spawn.length, 2, 'two attempts in all, never a third');
  assert.equal(never.sup.relayCredential(CHAT), null);
});

test('the handed pid alive but not answering for a moment is waited for, and kept: no second spawn', async () => {
  const waits = [];
  const { sup, calls } = fakeRig({
    spawnAnswer: { pid: 801, port: FAKE_PORT, url: 'x', source: 'portfile', child_pid: 801 },
    live: () => null,
    isPidAlive: (pid) => pid === 801,
    waitForDaemon: async (root, opts) => { waits.push(opts.maxMs); return { pid: 801, port: FAKE_PORT, url: 'x', source: 'registry' }; },
  });
  const answer = await sup.ensureRunning({ id: CHAT, root: '/tmp/wc-chat-root' });
  assert.deepEqual(answer, { state: 'running', port: FAKE_PORT, pid: 801, started_by: 'connector' });
  assert.deepEqual(waits, [START_WAIT_MS]);
  assert.equal(calls.spawn.length, 1);
});

// A stub daemon that STAYS UP (until killed or 30 s): it announces itself in
// `<dir>/up-<pid>` once "booted". The world's daemonFor answers the FIRST
// child that announced and is still alive, as daemonFor answers the one
// daemon that bound.
const LIVE_STUB = `
const fs = require('fs');
const dir = process.argv[2];
setTimeout(() => {
  fs.writeFileSync(dir + '/up-' + process.pid + '.tmp', '1');
  fs.renameSync(dir + '/up-' + process.pid + '.tmp', dir + '/up-' + process.pid);
}, 150);
setTimeout(() => process.exit(0), 30000);
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('two supervisors and one plain spawnDaemon race one root: one child, one connector with its live pid, the rest adopt it', async (t) => {
  withTempHome(t); // the spawn lock's user tier
  const dir = scratch(t);
  const stub = path.join(dir, 'live-stub.js');
  fs.writeFileSync(stub, LIVE_STUB);
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  const children = [];
  t.after(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } });
  const seam = (r, opts = {}) => {
    const c = spawnDetached({ bin: stub, args: [dir], log: path.join(dir, 'stub.log'), env: opts.env, extraFds: opts.extraFds });
    children.push(c);
    return c;
  };
  const daemonFor = async () => {
    const c = children.find((x) => alive(x.pid) && fs.existsSync(path.join(dir, `up-${x.pid}`)));
    return c ? { pid: c.pid, port: FAKE_PORT, url: 'x', source: 'portfile' } : null;
  };
  const mk = () => createSupervisor({
    recordPath: path.join(dir, 'connector', 'hub-one.json'),
    deps: {
      daemonFor,
      answersFor: async () => true,
      spawnDaemon: (r, opts) => spawnDaemon(r, { ...opts, spawn: seam, daemonFor }),
      env: { ...process.env },
    },
  });
  const supA = mk();
  const supB = mk();
  const ids = ['01jbzam3n5p7q9r1s3t5v7w9xa', '01jbzam3n5p7q9r1s3t5v7w9xb'];
  // The supervisors first (each awaits its adopt check), the plain call a tick later.
  const a = supA.ensureRunning({ id: ids[0], root });
  const b = supB.ensureRunning({ id: ids[1], root });
  await new Promise((r) => setImmediate(r));
  const c = spawnDaemon(root, { maxMs: 8000, spawn: seam, daemonFor });
  const [ra, rb, rc] = await Promise.all([a, b, c]);

  assert.equal(children.length, 1, `one child started, not ${children.length}`);
  const pid = children[0].pid;
  assert.equal(ra.state, 'running');
  assert.equal(rb.state, 'running');
  assert.deepEqual([ra.pid, rb.pid, rc && rc.pid], [pid, pid, pid], 'every caller handed the one child');
  const by = [supA.startedBy(ids[0]), supB.startedBy(ids[1])].sort();
  assert.deepEqual(by, ['connector', 'other'], 'one supervisor spawned it; the other adopted');
  const owner = supA.startedBy(ids[0]) === 'connector' ? [supA, ids[0], supB, ids[1]] : [supB, ids[1], supA, ids[0]];
  assert.ok(owner[0].relayCredential(owner[1]) != null, 'the spawner holds the credential');
  assert.equal(owner[2].relayCredential(owner[3]), null, 'the adopter holds none');
  assert.ok(!('child_pid' in rc), 'the plain call adopted: no child_pid');
  assert.ok(alive(pid), 'the handed pid is alive');
  assert.equal(fs.existsSync(daemonUtil.spawnLockFor(root)), false, 'the spawn lock is released');
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
    autoDestroy: false, // so "destroyed" proves handOverSecret destroyed it, not the stream itself
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

// ── one real race: five first spawns of `claude-web-chat start` ────────────
//
// The gate's race (6A, GT-23) in the suite's terms: two plain spawnDaemon
// calls, lib/client's auto-spawn and two supervisors, all at once, for one
// fresh root, each spawn a real detached `start` (spawnDaemonProcess, counted
// at spawnDaemon's seam) on the walk seam WEB_CHAT_FIRST_PORT in the test band
// 6420–6439 (never 5170, 5171 or 5173–5272; the band is probed by binding),
// in a sandbox HOME, with the capture hub's port held by a stand-in that
// answers as a current hub (so a daemon's ensureHub starts nothing). Sampled
// at 0, 2 and 7 s (past the instance guard's 5 s check): exactly one live
// daemon for the root on the band, and the pid every caller was handed alive
// and still daemonFor's.

const net = require('net');
const http = require('http');
const client = require('../lib/client');
const registry = require('../lib/util/registry');
const { LISTEN_HOST } = require('../lib/core/cors');
const { PROTOCOL_VERSION } = require('../lib/core/versions');

const BAND = [6420, 6439];
const reserved = (p) => p === 5170 || p === 5171 || (p >= 5173 && p <= 5272);

function bindable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, LISTEN_HOST, () => s.close(() => resolve(true)));
  });
}

async function standInHub(t) {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, role: 'hub', version: PROTOCOL_VERSION, pid: process.pid }));
  });
  await new Promise((r) => srv.listen(0, LISTEN_HOST, r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  const port = srv.address().port;
  assert.ok(!reserved(port));
  return port;
}

async function bandLive(root) {
  const inst = registry.instanceId(root);
  const found = [];
  for (let p = BAND[0]; p <= BAND[1]; p++) {
    let r = null;
    try { r = await client.request(p, 'GET', '/api/health', null, { timeout: 1500 }); } catch { r = null; }
    let b = r && r.status === 200 ? r.body : null;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (b && b.instance === inst && Number.isInteger(b.pid)) found.push({ port: p, pid: b.pid });
  }
  return found;
}

test('five real concurrent first spawns for one root leave one live daemon at 0, 2 and 7 s, and every caller holds its live pid', { timeout: 60000 }, async (t) => {
  withTempHome(t);
  let first = null;
  for (let p = BAND[0]; p <= BAND[1] - 5 && first == null; p++) {
    let all = true;
    for (let i = 0; i < 5; i++) if (!(await bindable(p + i))) { all = false; break; }
    if (all) first = p;
  }
  if (first == null) { t.skip('no run of free ports in the test band'); return; }
  const hubPort = await standInHub(t);

  const saved = {};
  for (const k of ['WEB_CHAT_FIRST_PORT', 'WEB_CHAT_HUB_PORT', 'WEB_CHAT_PORT', 'WEB_CHAT_SUPERVISED']) saved[k] = process.env[k];
  process.env.WEB_CHAT_FIRST_PORT = String(first);
  process.env.WEB_CHAT_HUB_PORT = String(hubPort);
  delete process.env.WEB_CHAT_PORT;
  delete process.env.WEB_CHAT_SUPERVISED;
  const original = daemonUtil.spawnDaemon;
  const children = [];
  const counted = (r, opts = {}) => original(r, {
    ...opts,
    spawn: (root2, o) => { const c = daemonUtil.spawnDaemonProcess(root2, o); children.push(c.pid); return c; },
  });
  // lib/client reads daemon.spawnDaemon at call time: its auto-spawn is counted too.
  daemonUtil.spawnDaemon = counted;
  t.after(async () => {
    daemonUtil.spawnDaemon = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const pid of children) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await waitUntil(() => children.every((pid) => !alive(pid)), { timeout: 10000, what: 'the spawned daemons to stop' }).catch(() => {
      for (const pid of children) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    });
  });

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-race-')));
  fs.mkdirSync(path.join(root, '.web-chat'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  const mk = () => createSupervisor({ recordPath: path.join(root, '..', `wc-race-rec-${process.pid}.json`), deps: { spawnDaemon: counted, env: { ...process.env } } });
  const supA = mk();
  const supB = mk();
  const rs = await Promise.allSettled([
    daemonUtil.spawnDaemon(root),
    daemonUtil.spawnDaemon(root),
    client.get('/api/health', { root, spawn: true }).then((h) => ({ pid: h && h.pid })),
    supA.ensureRunning({ id: '01jbzam3n5p7q9r1s3t5v7w9xc', root }),
    supB.ensureRunning({ id: '01jbzam3n5p7q9r1s3t5v7w9xd', root }),
  ]);
  const why = JSON.stringify(rs.map((r) => (r.status === 'fulfilled' ? { pid: r.value && r.value.pid, port: r.value && r.value.port, by: r.value && r.value.started_by } : String(r.reason && r.reason.message))));
  assert.ok(rs.every((r) => r.status === 'fulfilled' && r.value && Number.isInteger(r.value.pid)), why);
  const handed = new Set(rs.map((r) => r.value.pid));
  assert.equal(handed.size, 1, `one pid handed to every caller: ${why}`);
  const [pid] = [...handed];
  assert.equal(children.length, 1, `one child started, not ${children.length}`);
  assert.equal(pid, children[0], 'the handed pid is the one child');
  for (const r of rs.slice(0, 2).concat(rs.slice(3))) {
    if (r.value.port != null) assert.ok(r.value.port >= BAND[0] && r.value.port <= BAND[1] && !reserved(r.value.port), `port ${r.value.port} in the band`);
  }
  assert.deepEqual([supA.startedBy('01jbzam3n5p7q9r1s3t5v7w9xc'), supB.startedBy('01jbzam3n5p7q9r1s3t5v7w9xd')].filter((x) => x === 'connector').length <= 1, true);

  let last = 0;
  for (const at of [0, 2000, 7000]) {
    if (at > last) await new Promise((r) => setTimeout(r, at - last));
    last = at;
    const live = await bandLive(root);
    assert.deepEqual(live.map((x) => x.pid), [pid], `at ${at} ms: one live daemon for the root on the band (${JSON.stringify(live)})`);
    assert.ok(alive(pid), `at ${at} ms: the handed pid is alive`);
    const d = await registry.daemonFor(root);
    assert.equal(d && d.pid, pid, `at ${at} ms: the handed pid is still the root's daemon`);
  }
});

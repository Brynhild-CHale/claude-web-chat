// The relay credential and the relay secret's intake (tranche 6 U741; contract
// 03 C-03.19 to C-03.22, C-03.21a; 11 C-11.7; OQ-1 (B)):
//   * takeRelaySecret through a real child process handed fd 3 as a pipe (the
//     connector's spawn, 06 C-06.19): the 64 hex characters are taken, the fd is
//     closed, the variable is gone — and every other input (a short read, a
//     non-hex or uppercase value, a closed fd, fd 2, an fd 3 nobody handed)
//     leaves no secret without blocking the boot. The env fallback is taken
//     once and deleted, valid or not. EAGAIN and a not-ours fd through an
//     injected fs.
//   * valid(req): loopback peer + the remote label === '1' + exactly one relay
//     header equal to the secret, over fake requests and real ones.
//   * actorOf: the three locked examples, and agreement with ajv over the locked
//     schema (test-support/contracts) on a mutated set; storedActor / actorName.
//   * a daemon built with relaySecret: a relayed element write is still
//     {class: 'remote', owner: 'remote', verified: false}; the secret is in no
//     health answer, ring entry or log line; the boot line names the channel.
//   * the answer surface and the control domain read the remote label as
//     cors.isRemoteRequest (X-WC-Remote: 0 is not remote there).
//   * start() takes the secret before it asks for the live daemon, and hands it
//     to the in-process server only.
// A secret is never printed: a child reports the sha256 of what it read.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { withServer, withTempHome, tmpRoot } = require('../test-support/helpers');
const { createValidator } = require('../test-support/contracts-loader');
const {
  takeRelaySecret, createRelayCredential, storedActor, actorName, isActor,
  SECRET_FD_VAR, SECRET_ENV_VAR, EAGAIN_STEP_MS, EAGAIN_MAX_MS, ACTOR_MAX_BYTES,
} = require('../lib/server/relay-credential');
const { RELAY_HEADER, ACTOR_HEADER, soleHeader } = require('../lib/core/writer-token');
const { createRedactor, MASK } = require('../lib/core/redact');
const { createServer } = require('../lib/server');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { createControl } = require('../lib/server/control');
const { createBus } = require('../lib/core/bus');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const start = require('../lib/cli/commands/start');

const MODULE = path.join(__dirname, '..', 'lib', 'server', 'relay-credential.js');
const EXAMPLES = path.join(__dirname, '..', 'test-support', 'contracts', 'examples');
// A fixed test secret (not one a connector minted): 64 lowercase hex.
const SECRET = crypto.createHash('sha256').update('wc-u741-relay-secret').digest('hex');
const OTHER = crypto.createHash('sha256').update('wc-u741-another-secret').digest('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const example = (name) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));
const ACTOR = example('03-actor-header');
const NAMED = example('03-actor-header-named');
const AGENT = example('03-actor-header-agent');

// ── takeRelaySecret through a real child ────────────────────────────────────

// The child: take the secret, report its sha256 (never the value), the
// channel, whether either variable survived, and fd 3's state after the take;
// then prove its event loop still runs (a timer fires).
const CHILD = `
const crypto = require('crypto');
const fs = require('fs');
const { takeRelaySecret } = require(${JSON.stringify(MODULE)});
let via = null;
const t0 = Date.now();
const s = takeRelaySecret({ onTaken: (v) => { via = v; } });
const ms = Date.now() - t0;
let fd3 = 'open';
try { fs.fstatSync(3); } catch (e) { fd3 = e.code; }
const out = {
  sha: s ? crypto.createHash('sha256').update(s).digest('hex') : null,
  via, ms, fd3,
  fdVar: ${JSON.stringify(SECRET_FD_VAR)} in process.env,
  envVar: ${JSON.stringify(SECRET_ENV_VAR)} in process.env,
};
setTimeout(() => { out.loop = true; process.stdout.write(JSON.stringify(out)); }, 20);
`;

// Run the child with stdio[3] = `fd3` and `env` added; `feed(pipe)` writes to
// fd 3's other end (when it is a pipe). → the child's report.
function runChild(t, { fd3 = 'pipe', env = {}, feed = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv[SECRET_ENV_VAR];
    if (!(SECRET_FD_VAR in env)) delete childEnv[SECRET_FD_VAR];
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'pipe', fd3], env: childEnv });
    const kill = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    t.after(() => { clearTimeout(kill); try { child.kill('SIGKILL'); } catch {} });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(kill);
      let report = null;
      try { report = JSON.parse(out); } catch {}
      if (!report) return reject(new Error(`child failed (${code} ${signal}): ${err.slice(0, 400)}`));
      resolve({ ...report, wall: Date.now() - started });
    });
    if (feed && child.stdio[3]) {
      child.stdio[3].on('error', () => {});
      feed(child.stdio[3]);
    }
  });
}

const writeAndEnd = (text) => (pipe) => { pipe.end(text); };

test('the fd: 64 lowercase hex on fd 3 are taken, the fd is closed, the variable is gone (the sha matches; the value is never printed)', async (t) => {
  const r = await runChild(t, { env: { [SECRET_FD_VAR]: '3' }, feed: writeAndEnd(SECRET) });
  assert.equal(r.sha, sha(SECRET));
  assert.equal(r.via, 'fd');
  assert.equal(r.fdVar, false, 'WEB_CHAT_RELAY_SECRET_FD is deleted');
  assert.equal(r.envVar, false);
  assert.equal(r.fd3, 'EBADF', 'fd 3 is closed after the take');
  assert.equal(r.loop, true);
});

test('the fd: a short read keeps reading (32 characters, a pause, 32 more)', async (t) => {
  const r = await runChild(t, {
    env: { [SECRET_FD_VAR]: '3' },
    feed: (pipe) => { pipe.write(SECRET.slice(0, 32)); setTimeout(() => pipe.end(SECRET.slice(32)), 60); },
  });
  assert.equal(r.sha, sha(SECRET));
  assert.equal(r.fd3, 'EBADF');
});

test('the fd: a short read (40 hex then EOF), a non-hex read and 64 uppercase hex each give null, the fd closed and the variable gone', async (t) => {
  for (const [what, text] of [
    ['40 hex then EOF', SECRET.slice(0, 40)],
    ['non-hex', 'z'.repeat(64)],
    ['uppercase hex', SECRET.toUpperCase()],
    ['nothing at all', ''],
  ]) {
    const r = await runChild(t, { env: { [SECRET_FD_VAR]: '3' }, feed: writeAndEnd(text) });
    assert.equal(r.sha, null, what);
    assert.equal(r.via, null, what);
    assert.equal(r.fdVar, false, `${what}: the variable is gone`);
    assert.equal(r.fd3, 'EBADF', `${what}: the fd is closed`);
  }
});

test('the fd: the variable naming a closed fd, fd 2, or no fd at all gives null and is deleted; fd 2 is never closed', async (t) => {
  const closed = await runChild(t, { fd3: 'ignore', env: { [SECRET_FD_VAR]: '63' } });
  assert.deepEqual([closed.sha, closed.fdVar], [null, false]);
  const two = await runChild(t, { fd3: 'ignore', env: { [SECRET_FD_VAR]: '2' } });
  assert.deepEqual([two.sha, two.fdVar], [null, false]);
  for (const bad of ['', 'x', '-3', '3.0', '0x3', ' 3']) {
    const r = await runChild(t, { fd3: 'ignore', env: { [SECRET_FD_VAR]: bad } });
    assert.deepEqual([r.sha, r.fdVar], [null, false], JSON.stringify(bad));
  }
  // fd 2 untouched: the in-process fake sees no fstat, read or close of it.
  const calls = [];
  const fakeFs = { fstatSync: (fd) => { calls.push(['fstat', fd]); throw new Error('no'); }, readSync: () => { calls.push('read'); }, closeSync: () => { calls.push('close'); } };
  assert.equal(takeRelaySecret({ env: { [SECRET_FD_VAR]: '2' }, fs: fakeFs }), null);
  assert.deepEqual(calls, []);
});

test('the fd: a child with stdio[3] = ignore and the variable set exits with null in under 1 s, its event loop intact', async (t) => {
  const r = await runChild(t, { fd3: 'ignore', env: { [SECRET_FD_VAR]: '3' } });
  assert.equal(r.sha, null);
  assert.equal(r.fdVar, false);
  assert.ok(r.ms < 1000, `the take took ${r.ms} ms`);
  assert.ok(r.wall < 5000, `the child took ${r.wall} ms`);
  // Whatever libuv put at fd 3 (macOS: its kqueue) is left open: not ours.
  assert.equal(r.loop, true, 'a timer still fires after the take');
});

// ── takeRelaySecret over an injected fs ─────────────────────────────────────

function fakeFd({ kind = 'fifo', reads }) {
  const calls = { read: 0, close: 0, sleeps: [] };
  const queue = [...reads];
  const fsImpl = {
    fstatSync: () => ({ isFIFO: () => kind === 'fifo', isSocket: () => kind === 'socket' }),
    readSync: (fd, buf, off, len) => {
      calls.read += 1;
      const next = queue.length ? queue.shift() : '';
      if (next instanceof Error) throw next;
      const b = Buffer.from(next, 'latin1').subarray(0, len);
      b.copy(buf, off);
      return b.length;
    },
    closeSync: () => { calls.close += 1; },
  };
  return { fsImpl, calls, sleep: (ms) => calls.sleeps.push(ms) };
}
const errno = (code) => Object.assign(new Error(code), { code });

test('injected fs: EAGAIN is retried in 10 ms steps, then the secret; EAGAIN past 2 s is no secret; the fd is closed either way', () => {
  const ok = fakeFd({ reads: [errno('EAGAIN'), errno('EAGAIN'), SECRET.slice(0, 10), errno('EAGAIN'), SECRET.slice(10)] });
  const env = { [SECRET_FD_VAR]: '3' };
  assert.equal(takeRelaySecret({ env, fs: ok.fsImpl, sleep: ok.sleep }), SECRET);
  assert.deepEqual(ok.calls.sleeps, [EAGAIN_STEP_MS, EAGAIN_STEP_MS, EAGAIN_STEP_MS]);
  assert.equal(ok.calls.close, 1);
  assert.deepEqual(env, {});

  const never = fakeFd({ reads: Array.from({ length: 1000 }, () => errno('EAGAIN')) });
  assert.equal(takeRelaySecret({ env: { [SECRET_FD_VAR]: '3' }, fs: never.fsImpl, sleep: never.sleep }), null);
  assert.equal(never.calls.sleeps.reduce((a, b) => a + b, 0), EAGAIN_MAX_MS, 'at most 2 s of waiting');
  assert.equal(never.calls.close, 1);
});

test('injected fs: a socket is read like a FIFO; anything else is never read; an fd whose first read fails outright is not closed', () => {
  const sock = fakeFd({ kind: 'socket', reads: [SECRET] });
  assert.equal(takeRelaySecret({ env: { [SECRET_FD_VAR]: '4' }, fs: sock.fsImpl, sleep: sock.sleep }), SECRET);
  const file = fakeFd({ kind: 'file', reads: [SECRET] });
  assert.equal(takeRelaySecret({ env: { [SECRET_FD_VAR]: '3' }, fs: file.fsImpl, sleep: file.sleep }), null);
  assert.deepEqual([file.calls.read, file.calls.close], [0, 0], 'a regular file is neither read nor closed');
  const kq = fakeFd({ reads: [errno('ENXIO')] });
  assert.equal(takeRelaySecret({ env: { [SECRET_FD_VAR]: '3' }, fs: kq.fsImpl, sleep: kq.sleep }), null);
  assert.deepEqual([kq.calls.read, kq.calls.close], [1, 0], 'not a readable stream: never ours to close');
  const midway = fakeFd({ reads: [SECRET.slice(0, 20), errno('EIO')] });
  assert.equal(takeRelaySecret({ env: { [SECRET_FD_VAR]: '3' }, fs: midway.fsImpl, sleep: midway.sleep }), null);
  assert.equal(midway.calls.close, 1, 'a stream that failed midway is closed');
});

test('the env fallback: taken once and deleted; a malformed value gives null and is still deleted; the fd wins when both are set', () => {
  const env = { [SECRET_ENV_VAR]: SECRET, OTHER: 'kept' };
  const seen = [];
  assert.equal(takeRelaySecret({ env, onTaken: (v) => seen.push(v) }), SECRET);
  assert.deepEqual(env, { OTHER: 'kept' });
  assert.deepEqual(seen, ['env']);
  assert.equal(takeRelaySecret({ env }), null, 'taken once: nothing is left to take');
  for (const bad of [SECRET.slice(0, 63), `${SECRET}0`, SECRET.toUpperCase(), ` ${SECRET}`, '', 'z'.repeat(64)]) {
    const e = { [SECRET_ENV_VAR]: bad };
    assert.equal(takeRelaySecret({ env: e }), null, JSON.stringify(bad.length));
    assert.deepEqual(e, {});
  }
  const both = fakeFd({ reads: [OTHER] });
  const e2 = { [SECRET_FD_VAR]: '3', [SECRET_ENV_VAR]: SECRET };
  assert.equal(takeRelaySecret({ env: e2, fs: both.fsImpl, sleep: both.sleep }), OTHER);
  assert.deepEqual(e2, {}, 'both variables are deleted');
});

// ── valid(req) ──────────────────────────────────────────────────────────────

function fakeReq({ peer = '127.0.0.1', headers = [] } = {}) {
  const rawHeaders = [];
  const lower = {};
  for (const [k, v] of headers) {
    rawHeaders.push(k, v);
    const lk = k.toLowerCase();
    lower[lk] = lk in lower ? `${lower[lk]}, ${v}` : v;
  }
  return { socket: { remoteAddress: peer }, headers: lower, rawHeaders };
}
const relayed = (extra = [], { secret = SECRET, remote = '1', peer } = {}) => fakeReq({
  peer,
  headers: [...(remote == null ? [] : [['X-WC-Remote', remote]]), [RELAY_HEADER, secret], ...extra],
});

test('valid(req): the right secret from a loopback peer with X-WC-Remote: 1 is valid; every other shape is not', () => {
  const relay = createRelayCredential({ secret: SECRET });
  assert.equal(relay.connected, true);
  assert.equal(relay.valid(relayed()), true);
  assert.equal(relay.valid(relayed([], { peer: '::1' })), true);
  assert.equal(relay.valid(relayed([], { peer: '::ffff:127.0.0.1' })), true);
  assert.equal(relay.valid(fakeReq({ headers: [['x-wc-remote', '1'], [RELAY_HEADER.toLowerCase(), SECRET]] })), true, 'names are case-insensitive');
  assert.equal(relay.valid(relayed([], { secret: OTHER })), false, 'a wrong secret');
  assert.equal(relay.valid(relayed([], { secret: SECRET.toUpperCase() })), false);
  assert.equal(relay.valid(relayed([], { secret: SECRET.slice(1) })), false);
  assert.equal(relay.valid(relayed([], { remote: null })), false, 'X-WC-Remote absent');
  assert.equal(relay.valid(relayed([], { remote: '0' })), false, "X-WC-Remote '0'");
  assert.equal(relay.valid(relayed([], { remote: '' })), false);
  assert.equal(relay.valid(relayed([], { peer: '192.168.1.23' })), false, 'a network peer');
  const gone = relayed();
  gone.socket = { remoteAddress: undefined };
  assert.equal(relay.valid(gone), false, 'a socket that has gone');
  assert.equal(relay.valid({ ...relayed(), socket: null }), false, 'no socket');
  assert.equal(relay.valid(relayed([[RELAY_HEADER, SECRET]])), false, 'the relay header repeated');
  assert.equal(relay.valid(relayed([['x-wc-relay', OTHER]])), false, 'repeated with another value');
  assert.equal(relay.valid(relayed([['X-WC-Remote', '1']])), false, 'the remote label repeated');
  assert.equal(relay.valid(fakeReq({ headers: [['X-WC-Remote', '1']] })), false, 'no relay header');
  assert.equal(relay.valid({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-wc-remote': '1', 'x-wc-relay': SECRET } }), false, 'no rawHeaders: never req.headers alone');
  assert.equal(relay.valid(null), false);
  for (const secret of [null, undefined, '', SECRET.toUpperCase(), SECRET.slice(2)]) {
    const none = createRelayCredential({ secret });
    assert.equal(none.connected, false);
    assert.equal(none.valid(relayed()), false, `a credential built with ${JSON.stringify(secret && secret.length)}`);
    assert.equal(none.actorOf(relayed([[ACTOR_HEADER, JSON.stringify(ACTOR)]])), null);
  }
});

test('soleHeader: the value of a header carried exactly once, counted over rawHeaders', () => {
  assert.equal(soleHeader(fakeReq({ headers: [['X-A', 'v']] }), 'x-a'), 'v');
  assert.equal(soleHeader(fakeReq({ headers: [['X-A', 'v'], ['x-a', 'v']] }), 'X-A'), null);
  assert.equal(soleHeader(fakeReq({ headers: [['X-B', 'v']] }), 'X-A'), null);
  assert.equal(soleHeader(fakeReq({ headers: [['X-A', '']] }), 'X-A'), '');
  assert.equal(soleHeader({ headers: { 'x-a': 'v' } }, 'X-A'), null);
  assert.equal(soleHeader(null, 'X-A'), null);
});

test('valid(req) and actorOf over real requests: a repeated header on the wire is refused', async (t) => {
  const relay = createRelayCredential({ secret: SECRET });
  const server = http.createServer((req, res) => {
    res.end(JSON.stringify({ valid: relay.valid(req), actor: relay.actorOf(req) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  // Raw HTTP so a header can be sent twice.
  const send = (lines) => new Promise((resolve, reject) => {
    const sock = require('net').connect(port, '127.0.0.1');
    let data = '';
    sock.on('data', (c) => { data += c; });
    sock.on('end', () => resolve(JSON.parse(data.slice(data.indexOf('\r\n\r\n') + 4))));
    sock.on('error', reject);
    sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${lines.join('\r\n')}\r\n\r\n`);
  });
  const actor = JSON.stringify(NAMED);
  assert.deepEqual(await send(['X-WC-Remote: 1', `${RELAY_HEADER}: ${SECRET}`, `${ACTOR_HEADER}: ${actor}`]), { valid: true, actor: NAMED });
  assert.deepEqual(await send(['X-WC-Remote: 1', `${RELAY_HEADER}: ${SECRET}`, `${RELAY_HEADER}: ${SECRET}`]), { valid: false, actor: null });
  assert.deepEqual(await send(['X-WC-Remote: 1', `${RELAY_HEADER}: ${SECRET}`, `${ACTOR_HEADER}: ${actor}`, `${ACTOR_HEADER}: ${actor}`]), { valid: true, actor: null });
  assert.deepEqual(await send(['X-WC-Remote: 1', 'X-WC-Remote: 1', `${RELAY_HEADER}: ${SECRET}`]), { valid: false, actor: null });
});

// ── actorOf ─────────────────────────────────────────────────────────────────

const withActor = (value, opts) => relayed([[ACTOR_HEADER, typeof value === 'string' ? value : JSON.stringify(value)]], opts);

test('actorOf: the three locked examples are accepted beside a valid credential, and nothing without one', () => {
  const relay = createRelayCredential({ secret: SECRET });
  for (const a of [ACTOR, NAMED, AGENT]) {
    assert.deepEqual(relay.actorOf(withActor(a)), a);
    assert.equal(relay.actorOf(withActor(a, { secret: OTHER })), null, 'a wrong secret');
    assert.equal(relay.actorOf(withActor(a, { remote: null })), null, 'no remote label');
    assert.equal(relay.actorOf(withActor(a, { peer: '10.0.0.2' })), null, 'a network peer');
  }
  assert.equal(relay.actorOf(relayed()), null, 'no actor header');
  assert.equal(relay.actorOf(relayed([[ACTOR_HEADER, JSON.stringify(ACTOR)], [ACTOR_HEADER, JSON.stringify(ACTOR)]])), null, 'the actor header repeated');
  assert.equal(relay.actorOf(withActor('{"v":1')), null, 'not JSON');
  assert.equal(relay.actorOf(withActor('null')), null);
  assert.equal(relay.actorOf(withActor('[]')), null);
});

test('actorOf: at most 512 bytes of printable ASCII', () => {
  const relay = createRelayCredential({ secret: SECRET });
  const compact = JSON.stringify(NAMED);
  const padTo = (n) => `${compact.slice(0, -1)}${' '.repeat(n - compact.length)}}`;
  assert.equal(padTo(ACTOR_MAX_BYTES).length, 512);
  assert.deepEqual(relay.actorOf(withActor(padTo(512))), NAMED, '512 bytes');
  assert.equal(relay.actorOf(withActor(padTo(513))), null, '513 bytes');
  assert.equal(relay.actorOf(withActor({ ...NAMED, name: 'Halé' })), null, 'a non-ASCII name (latin1 on the wire)');
  assert.equal(relay.actorOf(withActor(JSON.stringify(NAMED).replace('"Hale"', '"Hal\\u00e9"'))), null, 'an escaped non-ASCII name');
  assert.equal(relay.actorOf(withActor(`${compact.slice(0, -1)}\t}`)), null, 'a control character');
});

test('actorOf: the hand-written validator agrees with ajv over the locked schema on a mutated set', () => {
  const v = createValidator();
  const ajv = (a) => v.validateExample('03-actor-header', a).ok;
  const ulid = (c) => c.repeat(26);
  const omit = (o, k) => { const c = { ...o }; delete c[k]; return c; };
  const cases = {
    'the shell example': ACTOR,
    'the named example': NAMED,
    'the agent example': AGENT,
    'missing activity': omit(ACTOR, 'activity'),
    'missing session': omit(ACTOR, 'session'),
    'missing user': omit(ACTOR, 'user'),
    'missing v': omit(ACTOR, 'v'),
    'an extra key': { ...ACTOR, extra: 1 },
    'a __proto__ key': JSON.parse(`{"__proto__":1,${JSON.stringify(ACTOR).slice(1)}`),
    'an agt_ session with a name': { ...AGENT, name: 'Bot' },
    'a user on the agt_ arm': { ...AGENT, user: NAMED.user },
    'the agt_ arm without chat': omit(AGENT, 'chat'),
    'the agt_ arm via shell': { ...AGENT, via: 'shell' },
    'chat outside the agt_ arm': { ...ACTOR, chat: AGENT.chat },
    'a null user outside the agt_ arm': { ...ACTOR, user: null },
    'svc_home': { ...ACTOR, user: 'svc_home', via: 'scheduler', session: `ses_${ulid('a')}` },
    'a service user': { ...ACTOR, user: `svc_${ulid('0')}`, session: `key_${ulid('z')}`, via: 'api' },
    'v 2': { ...ACTOR, v: 2 },
    'v "1"': { ...ACTOR, v: '1' },
    'an unknown via': { ...ACTOR, via: 'cli' },
    'an uppercase ULID': { ...ACTOR, activity: `act_${ulid('A')}` },
    'an excluded ULID letter': { ...ACTOR, activity: `act_${ulid('u')}` },
    'a short ULID': { ...ACTOR, session: 'srf_abc' },
    'a cxs_ session': { ...ACTOR, session: `cxs_${ulid('1')}` },
    'a name with @': { ...NAMED, name: 'me@x' },
    'a name with a leading space': { ...NAMED, name: ' Hale' },
    'a name of 64': { ...NAMED, name: 'a'.repeat(64) },
    'a name of 65': { ...NAMED, name: 'a'.repeat(65) },
    "a name with ' + - . and spaces": { ...NAMED, name: "O'Neil +1 .x-y" },
    'a non-ASCII name': { ...NAMED, name: 'Halé' },
    'a number name': { ...NAMED, name: 5 },
    'an array': [ACTOR],
    'null': null,
    'a string': 'actor',
  };
  for (const [what, a] of Object.entries(cases)) {
    assert.equal(isActor(a), ajv(a), `${what}: the hand-written validator and ajv disagree`);
  }
  // The set means something: both verdicts occur.
  const verdicts = new Set(Object.values(cases).map(ajv));
  assert.deepEqual([...verdicts].sort(), [false, true]);
});

test('storedActor drops name; actorName answers the name or null', () => {
  assert.deepEqual(storedActor(NAMED), omitName(NAMED));
  assert.equal('name' in storedActor(NAMED), false);
  assert.deepEqual(storedActor(ACTOR), ACTOR);
  assert.deepEqual(storedActor(AGENT), AGENT);
  assert.equal(storedActor({ ...ACTOR, extra: 1 }), null);
  assert.equal(actorName(NAMED), 'Hale');
  assert.equal(actorName(ACTOR), null);
  assert.equal(actorName(null), null);
});
function omitName(a) { const c = { ...a }; delete c.name; return c; }

test('the secret is a known value of the redactor, labelled relay-secret (11 C-11.7)', () => {
  const added = [];
  createRelayCredential({ secret: SECRET, redactor: { addKnown: (v, l) => added.push([sha(v), l]) } });
  assert.deepEqual(added, [[sha(SECRET), 'relay-secret']]);
  const none = [];
  createRelayCredential({ secret: null, redactor: { addKnown: (v, l) => none.push(l) } });
  assert.deepEqual(none, []);
  const redactor = createRedactor();
  createRelayCredential({ secret: SECRET, redactor });
  const out = redactor.text(`ps eww shows WEB_CHAT_RELAY_SECRET=${SECRET} here`);
  assert.ok(!out.includes(SECRET.slice(0, 16)), 'masked');
  assert.ok(out.includes(MASK('relay-secret')), out.replace(SECRET, '<secret>'));
});

// ── a daemon built with relaySecret ─────────────────────────────────────────

test('withServer({relaySecret}): a relayed element write stays remote and unverified; the secret is in no health answer, ring entry or log line', async (t) => {
  const logs = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(real)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  t.after(() => { Object.assign(console, real); });
  const root = tmpRoot('wc-relay-');
  const d = await withServer(t, {
    root,
    seed: () => writeJsonAtomic(userPaths().tunnelConfig, {
      hostname: 'wc.example.test', style: 'flat',
      access: { team: 'testteam', aud: 'test-aud-0123456789' }, allow: { emails: ['me@example.com'], domains: [] },
      remote: { mirror: { [path.resolve(root)]: 'full' } },
    }),
    createServer: (o) => createServer({ ...o, relaySecret: SECRET, relaySecretVia: 'fd' }),
  });
  assert.equal(d.srv.relay.connected, true);
  const r1 = await d.api.post('/api/render', { id: 'm1', html: '<p class="lead">Hello world</p>' });
  assert.equal(r1.status, 200, r1.text);
  const RELAYED = { 'X-WC-Remote': '1', [RELAY_HEADER]: SECRET, [ACTOR_HEADER]: JSON.stringify(NAMED) };
  const w = await d.anonApi.post('/api/elements', {
    type: 'highlight',
    anchor: { v: 1, kind: 'range', mount: 'm1', quote: { exact: 'Hello', prefix: '', suffix: '' }, pos: { start: 0, end: 5 } },
    payload: { color: 'gold', note: 'a note' },
  }, RELAYED);
  assert.ok(w.status >= 200 && w.status < 300, `${w.status} ${w.text.replace(SECRET, '<secret>')}`);
  assert.deepEqual(w.json.element.writer, { class: 'remote', owner: 'remote', verified: false });
  // A turn whose message carries the secret: the graph keeps it masked.
  const tb = await d.api.post('/api/turn-begin', { message: `deploy with ${SECRET}` });
  assert.equal(tb.status, 200, tb.text.replace(SECRET, '<secret>'));
  const texts = [
    ['the write', w.text],
    ['health', (await d.api.get('/api/health')).text],
    ['health, relayed', (await d.anonApi.get('/api/health', RELAYED)).text],
    ['the ring', (await d.api.get('/api/events?since=0')).text],
    ['the graph', (await d.api.get('/api/graph')).text],
  ];
  const graph = texts.at(-1)[1];
  assert.ok(graph.includes(MASK('relay-secret')), 'the lock\'s message shows the mask');
  for (const [what, text] of [...texts, ['the log', logs.join('\n')]]) {
    for (let i = 0; i + 8 <= SECRET.length; i++) {
      assert.ok(!text.includes(SECRET.slice(i, i + 8)), `${what}: an 8-character window of the secret at ${i}`);
    }
  }
  const boot = logs.filter((l) => l.includes('connected mode'));
  assert.deepEqual(boot, ['[web-chat] connected mode: a relay secret was handed (fd)']);
});

test('a daemon built without relaySecret is not connected and logs no connected-mode line', async (t) => {
  const logs = [];
  const real = console.error;
  console.error = (...a) => { logs.push(a.map(String).join(' ')); };
  t.after(() => { console.error = real; });
  const d = await withServer(t);
  assert.equal(d.srv.relay.connected, false);
  assert.equal((await d.api.get('/api/health')).status, 200);
  assert.equal(logs.some((l) => l.includes('connected mode')), false);
});

// ── the remote label in the answer surface and the control domain ──────────

const FONTS = path.join(__dirname, '..', 'public', 'fonts');
const ASK = 'ask_0a1b2c3d4e5f';

function answerReq(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { ...(data != null ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

test('the answer surface reads the remote label as cors.isRemoteRequest: X-WC-Remote: 0 is a local decide, 1 a remote one', async (t) => {
  const pub = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-u741-pub-'));
  t.after(() => fs.rmSync(pub, { recursive: true, force: true }));
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><html><head><meta name="wc-answer-nonce" content="{{NONCE}}"></head><body></body></html>\n');
  const decides = [];
  const asks = {
    pending: () => [{ id: ASK }],
    decide: (id, decision, meta) => { decides.push(meta); return { ok: true, state: 'decided', outcome: 'allowed', version: 2 }; },
    noteRefusal: () => {},
    waitView: async (id) => ({ id, version: 1, state: 'pending' }),
  };
  // The project is opted in at full and every request judged full, so the
  // engine's own gate lets an X-WC-Remote request of any value through.
  const audience = { remoteLevel: () => 'full', levelOf: () => 'full' };
  const s = createAnswerSurface({ asks, mainPort: () => 54322, audience, relay: createRelayCredential({ secret: SECRET }), publicDir: pub, fontsDir: FONTS, idleMs: 60_000 });
  t.after(() => s.close());
  const { origin, port } = await s.ensure();
  for (const [value, remote] of [['0', false], ['1', true]]) {
    const doc = await answerReq(port, { path: `/answer/ask/${ASK}?layout=bar`, headers: { 'sec-fetch-dest': 'iframe', 'x-wc-remote': value } });
    assert.equal(doc.status, 200, doc.text);
    const nonce = /name="wc-answer-nonce" content="([^"]*)"/.exec(doc.text)[1];
    const r = await answerReq(port, {
      method: 'POST', path: `/answer/api/asks/${ASK}/decide`,
      headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-wc-answer': nonce, 'x-wc-remote': value },
      body: { decision: { behavior: 'allow' }, version: 1 },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(decides.at(-1).remote, remote, `X-WC-Remote: ${value}`);
  }
});

test('the control domain reads the remote label as cors.isRemoteRequest: X-WC-Remote: 0 is local, 1 remote', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-u741-control-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const surface = { spec: null, register(kind, spec) { surface.spec = spec; return () => {}; }, ensure: async () => ({ port: 1 }) };
  const mirror = { conversations: [], snapshot: () => ({ conversations: [] }), subscribe: () => () => {} };
  const control = createControl({ root, bus: createBus(), mirror, answerSurface: surface, relay: createRelayCredential({ secret: SECRET }) });
  t.after(() => control.stop());
  const seen = [];
  control.action('probe', {
    fields: ['x'], params: (q) => ({ x: String(q.x || '') }), key: () => 'k', layouts: ['confirm'],
    limit: { scope: 'project', ms: 1 },
    describe: async () => ({ title: 'probe', summary: 'probe' }),
    check: async () => null,
    run: async (target, ctx) => { seen.push(['run', ctx.remote, ctx.origin]); return { ok: true }; },
    state: async (target, ctx) => { seen.push(['state', ctx.remote, ctx.origin]); return { remote: ctx.remote }; },
  });
  await control.start();
  assert.ok(surface.spec && typeof surface.spec.api === 'function');
  const drive = (headers, info) => new Promise((resolve) => {
    const res = { writableEnded: false, destroyed: false };
    const kit = { json: (_res, status, body) => { res.writableEnded = true; resolve({ status, body }); } };
    surface.spec.api({ method: info.method, headers }, res, kit, info);
  });
  for (const [value, remote] of [['0', false], ['1', true], ['', false]]) {
    const st = await drive({ 'x-wc-remote': value }, { method: 'GET', rest: 'state', query: { action: 'probe', x: '1' }, body: null });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    await new Promise((r) => setTimeout(r, 5));
    const run = await drive({ 'x-wc-remote': value }, { method: 'POST', rest: 'probe', query: {}, body: { x: '1' } });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.deepEqual(seen.splice(0), [['state', remote, remote ? 'remote' : 'local'], ['run', remote, remote ? 'remote' : 'local']], `X-WC-Remote: ${JSON.stringify(value)}`);
  }
});

// ── start(): the intake comes first ─────────────────────────────────────────

test('start(): takeRelaySecret runs before daemonFor and the value reaches the in-process server only', async (t) => {
  withTempHome(t);
  const root = tmpRoot('wc-u741-start-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const order = [];
  const made = [];
  const take = (opts) => { order.push('take'); opts.onTaken('fd'); return SECRET; };
  await start([], {
    root,
    takeRelaySecret: take,
    daemonFor: async () => { order.push('daemonFor'); return null; },
    errlog: () => {},
    exit: () => {},
    createServer: (opts) => {
      order.push('createServer');
      made.push(opts);
      return { start: async () => ({}), installSignalHandlers: () => {} };
    },
  });
  assert.deepEqual(order, ['take', 'daemonFor', 'createServer']);
  assert.equal(made.length, 1);
  assert.equal(made[0].root, root);
  assert.equal(made[0].tokenAtClaim, true);
  assert.equal(made[0].relaySecretVia, 'fd');
  assert.ok(made[0].relaySecret === SECRET, 'the taken secret reaches createServer');

  // --daemon: taken first, then dropped — the spawn is handed only the root.
  const order2 = [];
  const spawned = [];
  await start(['--daemon'], {
    root,
    log: () => {},
    takeRelaySecret: () => { order2.push('take'); return SECRET; },
    daemonFor: async () => { order2.push('daemonFor'); return null; },
    spawnDaemonProcess: (...a) => { order2.push('spawn'); spawned.push(a); return { pid: 1 }; },
    waitForDaemon: async () => null,
  });
  assert.deepEqual(order2, ['take', 'daemonFor', 'spawn']);
  assert.deepEqual(spawned, [[root]]);

  // Already running: taken first, then dropped; nothing is built.
  const order3 = [];
  await start([], {
    root,
    errlog: () => {},
    exit: () => { order3.push('exit'); },
    takeRelaySecret: () => { order3.push('take'); return SECRET; },
    daemonFor: async () => { order3.push('daemonFor'); return { url: 'http://localhost:1', pid: 1 }; },
    restartIfStale: async (r, o) => { order3.push(['stale', Object.keys(o).sort().join(',')]); return null; },
    createServer: () => { order3.push('createServer'); },
  });
  assert.deepEqual(order3, ['take', 'daemonFor', ['stale', 'daemon,log'], 'exit']);
});

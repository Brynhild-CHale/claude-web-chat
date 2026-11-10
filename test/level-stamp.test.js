// The stamp, the ceiling and the read-drop (tranche 6 U742; OQ-1 ruled B; 04
// C-04.10, C-04.11, C-04.12, C-04.18a; 06 C-06.23a): the daemon is the second
// lock. A request carrying a valid relay credential (03 C-03.21) is the peer
// kind 'relayed', at the lesser of its X-WC-Level stamp and the machine's
// ceiling — the connector record's `ceiling`, read only in connected mode,
// only from a record inside the user tier's connector directory, and followed
// through lib/core/watch. Relayed is never local, never the host and never
// sees private; a relayed socket below full has its writing frames dropped.
// Every other request keeps 0.9's rule (the tunnel opt-in).
//
// The relay secret is a fresh random value per test process, carried only in
// request headers here: never printed. HOME is a sandbox (npm test's
// test-support/sandbox.js, and withServer's / withTempHome's own), so the
// connector directory is a throwaway one.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const asyncHooks = require('async_hooks');
const { withServer, withTempHome, waitUntil, wsConnect, commentBody } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { stampOf, LEVEL_HEADER, GRANTS_HEADER, DECISION_HEADER, REMOTE_HEADER } = require('../lib/core/cors');
const { RELAY_HEADER } = require('../lib/core/writer-token');
const { ceilingOf, readCeiling, fencedRecord } = require('../lib/core/connected-ceiling');
const { ANSWER_HINT } = require('../lib/core/remote-policy');
const { createBus } = require('../lib/core/bus');
const { createState } = require('../lib/server/state');
const { createAudience, HOST_ONLY } = require('../lib/server/audience');
const { attachWebSocket } = require('../lib/server/ws');
const { createAnswerSurface } = require('../lib/server/answer-surface');
const { createRelayCredential } = require('../lib/server/relay-credential');
const { registerRemoteReports } = require('../lib/server/domain/reports-remote');
const { createServer } = require('../lib/server');

const SECRET = crypto.randomBytes(32).toString('hex');
const OTHER_SECRET = crypto.randomBytes(32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const writeTunnel = (file, root, optIn) =>
  writeJsonAtomic(file, optIn ? { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: optIn } } } : { ...TUNNEL });

// A record body: `ceiling` omitted when undefined is passed as NO_KEY.
const NO_KEY = Symbol('no ceiling key');
const recordBody = (ceiling) => (ceiling === NO_KEY ? { record_version: 1, hub: { id: 'hub-test' } } : { record_version: 1, hub: { id: 'hub-test' }, ceiling });

// The connector directory of the current (sandboxed) HOME, made; the record path.
function connectorRecord(ceiling = NO_KEY, name = 'hub-test.json') {
  const dir = userPaths().connectorDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (ceiling !== undefined) writeJsonAtomic(file, recordBody(ceiling));
  return file;
}

// ── a request as the gate reads it ──────────────────────────────────────────
// headers: [[name, value], …] — a name twice is a repeated header (rawHeaders
// keeps both, as Node's parser does).
function fakeReq(headers = [], addr = '127.0.0.1') {
  const rawHeaders = [];
  const h = {};
  for (const [k, v] of headers) {
    rawHeaders.push(k, v);
    const lk = k.toLowerCase();
    h[lk] = h[lk] == null ? v : `${h[lk]}, ${v}`;
  }
  return { socket: { remoteAddress: addr }, headers: h, rawHeaders };
}
const REMOTE_H = [REMOTE_HEADER, '1'];
const RELAY_H = (s = SECRET) => [RELAY_HEADER, s];
const STAMP_H = (v) => [LEVEL_HEADER, v];
const relayedReq = (stamp, more = []) => fakeReq([REMOTE_H, RELAY_H(), ...(stamp == null ? [] : [STAMP_H(stamp)]), ...more]);

// Runs one Express middleware against a request.
function run(mw, r) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  let passed = false;
  mw(r, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
}

// Every reader of a request's level agrees: levelOf, requireMirror at each
// need, and socketLevel over the socket record ws.js keeps for it.
function readersAgree(a, r, expected, what) {
  assert.equal(a.levelOf(r), expected, `${what}: levelOf`);
  for (const need of ['basic', 'read', 'full', 'local']) {
    const out = run(a.requireMirror(need), r);
    assert.equal(out.passed, a.atLeast(expected, need), `${what}: requireMirror(${need})`);
    if (!out.passed) {
      assert.equal(out.status, 403);
      assert.equal(out.body.mirror, expected, `${what}: requireMirror(${need}) names the level`);
    }
  }
  const peer = a.peerOf(r);
  const wc = { peer, ...(peer === 'relayed' ? { stamp: stampOf(r) } : {}) };
  assert.equal(a.socketLevel({ _wc: wc }), expected, `${what}: socketLevel`);
}

// A scratch tunnel.json; the audience over it, connected (with a relay
// credential and a record path) or not; stopped when the test ends.
function audienceOf(t, { optIn = null, relay = null, connectorRecord: rec, pollMs = 25 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-level-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const configFile = path.join(dir, 'tunnel', 'tunnel.json');
  writeTunnel(configFile, root, optIn);
  const a = createAudience({ root, configFile, pollMs, relay, connectorRecord: rec });
  t.after(() => a.stop());
  return { a, root, configFile, setOptIn: (level) => writeTunnel(configFile, root, level) };
}
const connectedRelay = () => createRelayCredential({ secret: SECRET });

// ── a live daemon ───────────────────────────────────────────────────────────
// secret: the relay secret it is handed (null: none); record(): the record
// path, called once HOME is sandboxed; optIn: the tunnel opt-in it boots with.
async function boot(t, { secret = SECRET, record = null, optIn = null } = {}) {
  let recordPath;
  const d = await withServer(t, {
    seed: ({ root }) => {
      writeTunnel(userPaths().tunnelConfig, root, optIn);
      recordPath = typeof record === 'function' ? record() : record;
    },
    createServer: (o) => createServer({
      ...o,
      relaySecret: secret,
      relaySecretVia: secret ? 'option' : null,
      connectorRecord: recordPath === undefined ? null : recordPath,
    }),
  });
  d.recordPath = recordPath;
  return d;
}

// One HTTP request with headers as [[name, value], …] (a name twice is sent
// twice). → {status, json, text}.
function send(port, { method = 'GET', path: p = '/', headers = [], body = null, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const h = {};
    for (const [k, v] of headers) {
      if (h[k] === undefined) h[k] = v;
      else h[k] = [].concat(h[k], v);
    }
    if (data != null) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host, port, method, path: p, agent: false, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}
const relayedHeaders = (stamp, secret = SECRET) => [REMOTE_H, RELAY_H(secret), ...(stamp == null ? [] : [STAMP_H(stamp)])];
const accessLevel = async (d, headers) => {
  const r = await send(d.port, { path: '/api/mirror/access', headers });
  assert.equal(r.status, 200, r.text);
  return r.json.level;
};

// A socket with its frames collected; resolves once its hello arrived.
async function openSocket(t, port, headers) {
  const h = {};
  for (const [k, v] of headers) h[k] = v;
  const ws = wsConnect(port, '/ws', { headers: h });
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { timeout: 10000, interval: 5, what: 'the hello' });
  return { ws, frames, send: (f) => ws.send(JSON.stringify(f)) };
}

// console.error lines while `fn` runs (the daemon's log is console.error).
function captureLog(t) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  const restore = () => { console.error = orig; };
  t.after(restore);
  return { lines, restore };
}

// ── (1) the parser and the headers ──────────────────────────────────────────

test('cors: the three header names sit beside X-WC-Remote; stampOf reads exactly one enum value, else basic', () => {
  assert.equal(LEVEL_HEADER, 'X-WC-Level');
  assert.equal(GRANTS_HEADER, 'X-WC-Grants');
  assert.equal(DECISION_HEADER, 'X-WC-Decision');
  for (const v of ['basic', 'read', 'full']) assert.equal(stampOf(fakeReq([STAMP_H(v)])), v, v);
  assert.equal(stampOf(fakeReq([['x-wc-level', 'read']])), 'read', 'the name is case-insensitive');
  assert.equal(stampOf(fakeReq([])), 'basic', 'absent');
  assert.equal(stampOf(fakeReq([STAMP_H('full'), STAMP_H('full')])), 'basic', 'repeated, even with one value');
  for (const v of ['local', 'admin', '', 'FULL', ' full', 'read,full']) assert.equal(stampOf(fakeReq([STAMP_H(v)])), 'basic', JSON.stringify(v));
  assert.equal(stampOf(null), 'basic');
  assert.equal(stampOf({ headers: { 'x-wc-level': 'full' } }), 'basic', 'no rawHeaders: nothing is sole');
});

// ── (2) the tunnel path is 0.9's ────────────────────────────────────────────

test('the tunnel path is unchanged: no secret, or a secret with X-WC-Remote and no X-WC-Relay, keeps the opt-in through levelOf, requireMirror and a socket', async (t) => {
  withTempHome(t);
  const rec = connectorRecord('full');
  for (const optIn of [null, 'read', 'full']) {
    const expected = optIn || 'basic';
    const plain = audienceOf(t, { optIn });
    const connected = audienceOf(t, { optIn, relay: connectedRelay(), connectorRecord: rec });
    for (const [name, a] of [['no secret', plain.a], ['a secret', connected.a]]) {
      readersAgree(a, fakeReq([REMOTE_H]), expected, `${name}, opt-in ${optIn}: a tunnel viewer`);
      readersAgree(a, fakeReq([REMOTE_H, STAMP_H('full')]), expected, `${name}, opt-in ${optIn}: a stamp with no credential is ignored`);
      readersAgree(a, fakeReq([]), 'local', `${name}: a local peer`);
      readersAgree(a, fakeReq([REMOTE_H], '10.0.0.7'), 'basic', `${name}: a network peer`);
      assert.equal(a.peerOf(fakeReq([REMOTE_H])), 'remote');
    }
  }

  // The same through two live daemons, opted in at read: one handed no
  // secret, one handed a secret under a full ceiling.
  for (const secret of [null, SECRET]) {
    const d = await boot(t, { secret, optIn: 'read', record: () => connectorRecord('full') });
    const what = secret ? 'a connected daemon' : 'a daemon handed no secret';
    assert.equal(await accessLevel(d, [REMOTE_H]), 'read', `${what}: a tunnel viewer's level`);
    assert.equal(await accessLevel(d, [REMOTE_H, STAMP_H('full')]), 'read', `${what}: a stamp without the credential is ignored`);
    const files = await send(d.port, { path: '/api/files', headers: [REMOTE_H] });
    assert.equal(files.status, 403, `${what}: /api/files (full) refuses a tunnel viewer at read`);
    assert.equal(files.json.mirror, 'read');
    const sock = await openSocket(t, d.port, [REMOTE_H]);
    assert.ok(sock.frames.find((f) => f.type === 'hello'), `${what}: the tunnel viewer's socket opens`);
    assert.equal(d.srv.audience.socketLevel({ _wc: { peer: 'remote' } }), 'read', `${what}: a tunnel socket's level`);
    assert.equal(d.srv.audience.connected(), !!secret);
    assert.equal(d.srv.audience.ceiling(), secret ? 'full' : null);
  }
});

// ── (3) the stamp and the ceiling ───────────────────────────────────────────

test('a credentialed request is relayed at the lesser of stamp and ceiling; absent, repeated or unknown stamps are basic; a stamp without the credential is ignored', async (t) => {
  withTempHome(t);
  const readCeil = audienceOf(t, { optIn: 'full', relay: connectedRelay(), connectorRecord: connectorRecord('read', 'hub-read.json') }).a;
  const fullCeil = audienceOf(t, { optIn: 'off', relay: connectedRelay(), connectorRecord: connectorRecord('full', 'hub-full.json') }).a;

  assert.equal(readCeil.peerOf(relayedReq('full')), 'relayed');
  readersAgree(readCeil, relayedReq('full'), 'read', 'stamp full, ceiling read');
  readersAgree(readCeil, relayedReq('read'), 'read', 'stamp read, ceiling read');
  readersAgree(readCeil, relayedReq('basic'), 'basic', 'stamp basic, ceiling read');
  readersAgree(fullCeil, relayedReq('read'), 'read', 'stamp read, ceiling full');
  readersAgree(fullCeil, relayedReq('full'), 'full', 'stamp full, ceiling full');
  readersAgree(fullCeil, relayedReq(null), 'basic', 'no stamp');
  readersAgree(fullCeil, fakeReq([REMOTE_H, RELAY_H(), STAMP_H('full'), STAMP_H('full')]), 'basic', 'a repeated stamp');
  readersAgree(fullCeil, relayedReq('local'), 'basic', 'stamp local');
  readersAgree(fullCeil, relayedReq('admin'), 'basic', 'stamp admin');

  // Without the credential the stamp is nothing: the opt-in (read-ceiling
  // audience: full; full-ceiling audience: off) or local.
  readersAgree(readCeil, fakeReq([REMOTE_H, RELAY_H(OTHER_SECRET), STAMP_H('read')]), 'full', 'a wrong secret: the opt-in, not the stamp');
  readersAgree(readCeil, fakeReq([REMOTE_H, RELAY_H(), RELAY_H(), STAMP_H('read')]), 'full', 'a repeated relay header');
  readersAgree(fullCeil, fakeReq([REMOTE_H, RELAY_H(), STAMP_H('full')], '10.0.0.7'), 'basic', 'a network peer with the secret');
  readersAgree(fullCeil, fakeReq([RELAY_H(), STAMP_H('full')]), 'local', 'no X-WC-Remote: local, the relay header means nothing');
  const unconnected = audienceOf(t, { optIn: 'read' }).a;
  readersAgree(unconnected, relayedReq('full'), 'read', 'a daemon handed no secret: the opt-in');
  assert.equal(unconnected.peerOf(relayedReq('full')), 'remote');

  // Through a live daemon under a read ceiling: /api/files (full) refuses a
  // full stamp — the hole C-04.10 names, closed.
  const d = await boot(t, { record: () => connectorRecord('read') });
  assert.equal(await accessLevel(d, relayedHeaders('full')), 'read', 'stamp full, ceiling read');
  assert.equal(await accessLevel(d, relayedHeaders('read')), 'read');
  assert.equal(await accessLevel(d, relayedHeaders(null)), 'basic', 'no stamp');
  assert.equal(await accessLevel(d, [...relayedHeaders('read'), STAMP_H('read')]), 'basic', 'a repeated stamp');
  assert.equal(await accessLevel(d, relayedHeaders('local')), 'basic', 'stamp local');
  assert.equal(await accessLevel(d, relayedHeaders('full', OTHER_SECRET)), 'basic', 'a wrong secret: the opt-in (none)');
  const files = await send(d.port, { path: '/api/files', headers: relayedHeaders('full') });
  assert.equal(files.status, 403, files.text);
  assert.equal(files.json.mirror, 'read');
  const access = await send(d.port, { path: '/api/mirror/access', headers: relayedHeaders('full') });
  assert.equal(access.json.project, undefined, 'the opt-in is the host\'s business: never told to a relayed request');
  assert.ok(!access.text.includes(SECRET), `no answer carries the secret (sha ${sha(SECRET)})`);
});

// ── (4) the four ceiling cases ──────────────────────────────────────────────

test('the four ceiling cases through readCeiling (U714\'s ceilingOf, no second table) and through a live daemon', async (t) => {
  withTempHome(t);
  const dir = userPaths().connectorDir;
  fs.mkdirSync(dir, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideRecord = path.join(outside, 'hub-out.json');
  writeJsonAtomic(outsideRecord, recordBody('full'));
  const link = path.join(dir, 'hub-link.json');
  fs.symlinkSync(outsideRecord, link);
  const missing = path.join(dir, 'hub-missing.json');
  const torn = path.join(dir, 'hub-torn.json');
  fs.writeFileSync(torn, '{"ceiling": "full"');
  const arr = path.join(dir, 'hub-array.json');
  fs.writeFileSync(arr, '["full"]');
  const write = (name, value) => { const f = path.join(dir, name); writeJsonAtomic(f, value); return f; };

  const cases = [
    // (i) as an absent record
    ['(i) the variable unset', undefined, 'basic'],
    ['(i) an empty value', '', 'basic'],
    ['(i) a relative path', 'hub-test.json', 'basic'],
    ['(i) a record outside the connector directory', outsideRecord, 'basic'],
    ['(i) a symlink inside pointing outside', link, 'basic'],
    ['(i) the directory itself', dir, 'basic'],
    ['(i) a missing record', missing, 'basic'],
    ['(i) an unparsable record', torn, 'basic'],
    ['(i) a parsable non-object', arr, 'basic'],
    // (ii) no ceiling key
    ['(ii) no ceiling', write('hub-none.json', recordBody(NO_KEY)), 'full'],
    // (iii)
    ['(iii) read', write('hub-r.json', recordBody('read')), 'read'],
    ['(iii) full', write('hub-f.json', recordBody('full')), 'full'],
    // (iv)
    ['(iv) "admin"', write('hub-admin.json', recordBody('admin')), 'basic'],
    ['(iv) ""', write('hub-empty.json', recordBody('')), 'basic'],
    ['(iv) null', write('hub-null.json', recordBody(null)), 'basic'],
    ['(iv) 3', write('hub-3.json', recordBody(3)), 'basic'],
  ];
  for (const [what, file, expected] of cases) {
    assert.equal(readCeiling(file, { connectorDir: dir }), expected, `readCeiling: ${what}`);
  }
  assert.equal(fencedRecord(link, { connectorDir: dir }), null, 'the fence refuses the symlink out');
  assert.equal(fencedRecord(outsideRecord, { connectorDir: dir }), null);
  assert.equal(readCeiling(path.join(dir, 'hub-f.json'), { connectorDir: outside }), 'basic', 'a record outside the directory it is fenced to');
  assert.equal(readCeiling(path.join(dir, 'hub-f.json'), {}), 'basic', 'no directory: nothing is inside');
  // The cases after the fence are ceilingOf's: the same answers from it.
  for (const [what, file, expected] of cases.slice(-7)) {
    assert.equal(ceilingOf(require('../lib/core/fsjson').readJson(file)), expected, `ceilingOf: ${what}`);
  }

  // A live daemon per case, connected, read with a full stamp (so the level
  // IS the ceiling).
  for (const [what, file, expected] of cases) {
    const d = await boot(t, { record: () => file });
    assert.equal(await accessLevel(d, relayedHeaders('full')), expected, `a live daemon: ${what}`);
    assert.equal(d.srv.audience.ceiling(), expected, `a live daemon's ceiling: ${what}`);
  }
});

// ── (5) the watch ───────────────────────────────────────────────────────────

test('a watched edit of the record (full → read) re-levels an open relayed socket in place: mirror:access at read, no restart', async (t) => {
  const log = captureLog(t);
  const d = await boot(t, { record: () => connectorRecord('full') });
  const sock = await openSocket(t, d.port, relayedHeaders('full'));
  const tunnelSock = await openSocket(t, d.port, [REMOTE_H]);
  assert.equal(await accessLevel(d, relayedHeaders('full')), 'full');
  writeJsonAtomic(d.recordPath, recordBody('read'));
  await waitUntil(() => sock.frames.some((f) => f.type === 'mirror:access'), { timeout: 10000, interval: 10, what: 'the re-level' });
  const access = sock.frames.filter((f) => f.type === 'mirror:access');
  assert.deepStrictEqual(access, [{ type: 'mirror:access', level: 'read', remote: true }]);
  assert.equal(await accessLevel(d, relayedHeaders('full')), 'read', 'a request now is read too');
  assert.equal(tunnelSock.frames.filter((f) => f.type === 'mirror:access').length, 0, 'a tunnel viewer never moves with the ceiling');
  const moved = log.lines.filter((l) => /ceiling full → read/.test(l));
  assert.equal(moved.length, 1, `one line for the move: ${JSON.stringify(log.lines)}`);
  // And back (read → full) — the ceiling follows both ways.
  writeJsonAtomic(d.recordPath, recordBody(NO_KEY));
  await waitUntil(() => sock.frames.filter((f) => f.type === 'mirror:access').length === 2, { timeout: 10000, interval: 10, what: 'the re-level back' });
  assert.equal(sock.frames.filter((f) => f.type === 'mirror:access')[1].level, 'full');
  log.restore();
  assert.ok(!log.lines.some((l) => l.includes(SECRET)), 'no log line carries the secret');
});

test('one watcher only in connected mode: a daemon handed no secret, or a record outside the directory, arms no ceiling watcher', async (t) => {
  withTempHome(t);
  const rec = connectorRecord('full');
  // The handles each audience opens at construction (an unref'd handle never
  // shows in process.getActiveResourcesInfo(), so async_hooks it is).
  const TRACKED = new Set(['Timeout', 'FSEVENTWRAP', 'STATWATCHER']);
  function opened(make) {
    const live = [];
    const hook = asyncHooks.createHook({ init(id, type) { if (TRACKED.has(type)) live.push(type); } });
    hook.enable();
    let a;
    try { a = make(); } finally { hook.disable(); }
    t.after(() => a.stop());
    return { a, live };
  }
  const none = opened(() => createAudience({ configFile: null, connectorRecord: rec }));
  assert.deepStrictEqual(none.live, [], 'no relay credential: nothing armed, the record never read');
  assert.equal(none.a.connected(), false);
  assert.equal(none.a.ceiling(), null);
  const noSecret = opened(() => createAudience({ configFile: null, relay: createRelayCredential({ secret: null }), connectorRecord: rec }));
  assert.deepStrictEqual(noSecret.live, [], 'a credential with no secret: not connected, nothing armed');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-out-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outsideRec = path.join(outsideDir, 'hub-test.json');
  writeJsonAtomic(outsideRec, recordBody('full'));
  const outside = opened(() => createAudience({ configFile: null, relay: connectedRelay(), connectorRecord: outsideRec }));
  assert.deepStrictEqual(outside.live, [], 'a record outside the connector directory: static basic, nothing armed');
  assert.equal(outside.a.ceiling(), 'basic');
  const unset = opened(() => createAudience({ configFile: null, relay: connectedRelay(), connectorRecord: undefined }));
  assert.deepStrictEqual(unset.live, [], 'connected with the variable unset: static basic, nothing armed');
  assert.equal(unset.a.ceiling(), 'basic');
  const armed = opened(() => createAudience({ configFile: null, relay: connectedRelay(), connectorRecord: rec, pollMs: 50 }));
  assert.ok(armed.live.length > 0, `connected with a fenced record: the watcher is armed (${armed.live})`);
  assert.equal(armed.a.ceiling(), 'full');
  await armed.a.stop();
});

// ── (6) never the host, never private ───────────────────────────────────────

test('relayed is never the host and never sees private: isHost, seesPrivate and requireHost refuse it at every stamp and ceiling', async (t) => {
  withTempHome(t);
  const BROWSER = [['Origin', 'http://localhost:5173'], ['Sec-Fetch-Mode', 'cors']];
  for (const ceiling of ['read', 'full', NO_KEY, 'admin']) {
    const a = audienceOf(t, { optIn: 'full', relay: connectedRelay(), connectorRecord: connectorRecord(ceiling, `hub-${String(ceiling.toString()).replace(/\W/g, '')}.json`) }).a;
    for (const stamp of [null, 'basic', 'read', 'full', 'local']) {
      for (const more of [[], BROWSER]) {
        const r = relayedReq(stamp, more);
        const what = `ceiling ${String(ceiling.toString())}, stamp ${stamp}, browser ${more.length > 0}`;
        assert.equal(a.peerOf(r), 'relayed', what);
        assert.notEqual(a.levelOf(r), 'local', what);
        assert.equal(a.isHost(r), false, `isHost: ${what}`);
        assert.equal(a.seesPrivate(r), false, `seesPrivate: ${what}`);
        const out = run(a.requireHost(), r);
        assert.equal(out.passed, false, `requireHost: ${what}`);
        assert.deepStrictEqual([out.status, out.body], [403, { ok: false, hint: HOST_ONLY }]);
        assert.equal(a.accessView(r).project, undefined, `accessView keeps project for local only: ${what}`);
      }
    }
  }

  const d = await boot(t, { record: () => connectorRecord('full') });
  const hook = await send(d.port, { method: 'POST', path: '/api/hooks/event', headers: relayedHeaders('full'), body: { v: 1, event: 'SessionStart' } });
  assert.equal(hook.status, 403, hook.text);
  assert.deepStrictEqual(hook.json, { ok: false, hint: HOST_ONLY });
  // A private and a shared pin, made as the chrome makes them (a local browser).
  assert.equal((await d.api.post('/api/render', { id: 'm1', html: '<p class="x">m1</p>' })).status, 200);
  const anchor = { mount: 'm1', selector: 'p.x', text: 'm1', ordinal: 0 };
  assert.equal((await d.anonApi.post('/api/elements', commentBody({ text: 'SHARED-PIN', shared: true, anchor }))).status, 200);
  assert.equal((await d.anonApi.post('/api/elements', commentBody({ text: 'PRIVATE-PIN', shared: false, anchor }))).status, 200);
  const local = await d.anonApi.get('/api/elements?type=comment');
  assert.deepStrictEqual(local.json.elements.map((e) => e.text), ['SHARED-PIN', 'PRIVATE-PIN'], 'a local browser sees both');
  for (const extra of [[], [['Origin', 'http://localhost:5173'], ['Sec-Fetch-Mode', 'cors']]]) {
    const r = await send(d.port, { path: '/api/elements?type=comment', headers: [...relayedHeaders('full'), ...extra] });
    assert.equal(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.elements.map((e) => e.text), ['SHARED-PIN'], 'a relayed full request: the private pin is omitted');
    assert.ok(!r.text.includes('PRIVATE-PIN'));
  }
});

// ── (7) the read-drop ───────────────────────────────────────────────────────

test('the read-drop: a relayed socket at read sends store:set, event, pane:form, pane:state and script:error — nothing lands, one log line each naming the type only; at full they land', async (t) => {
  const d = await boot(t, { record: () => connectorRecord('read') });
  assert.equal((await d.api.post('/api/render', { id: 'p1', html: '<p>one <input id="f"></p>' })).status, 200);
  const mount = () => d.srv.state.mounts.get('p1');
  const formBefore = JSON.stringify(mount().form_state || null);
  const paneBefore = JSON.stringify(mount().pane_state || null);
  const storeBefore = JSON.stringify(d.srv.state.store);
  const latest = () => d.srv.bus.read(0).latest;
  const seqBefore = latest();

  const MARK = 'CONTENT-NEVER-LOGGED';
  const frames = [
    { type: 'store:set', patch: { dropped_key: MARK } },
    { type: 'event', payload: { type: 'click', mountId: 'p1', tag: 'button', value: MARK } },
    { type: 'pane:form', id: 'p1', form_state: { '#f:0': MARK } },
    { type: 'pane:state', id: 'p1', pane_state: { minimized: true } },
    { type: 'script:error', id: 'p1', message: MARK },
  ];
  const log = captureLog(t);
  const sock = await openSocket(t, d.port, relayedHeaders('full')); // level: read (the ceiling)
  for (const f of frames) sock.send(f);
  const drops = () => log.lines.filter((l) => /dropped a .* frame from a relayed socket/.test(l));
  await waitUntil(() => drops().length === frames.length, { timeout: 10000, interval: 10, what: 'one drop line per frame' });
  log.restore();
  assert.deepStrictEqual(drops().map((l) => /dropped a (\S+) frame from a relayed socket at level (\w+)/.exec(l).slice(1)),
    frames.map((f) => [f.type, 'read']));
  assert.ok(!log.lines.some((l) => l.includes(MARK)), 'no line carries a frame\'s content');
  assert.equal(JSON.stringify(d.srv.state.store), storeBefore, 'the store is unchanged');
  assert.equal(JSON.stringify(mount().form_state || null), formBefore, 'the form_state is unchanged');
  assert.equal(JSON.stringify(mount().pane_state || null), paneBefore, 'the pane_state is unchanged');
  assert.equal(latest(), seqBefore, 'the ring is unchanged');

  // A relayed socket at basic (no stamp) is dropped the same way.
  const log2 = captureLog(t);
  const bare = await openSocket(t, d.port, relayedHeaders(null));
  bare.send(frames[0]);
  await waitUntil(() => log2.lines.some((l) => /dropped a store:set frame from a relayed socket at level basic/.test(l)), { timeout: 10000, interval: 10, what: 'the basic drop' });
  log2.restore();
  assert.equal(JSON.stringify(d.srv.state.store), storeBefore);

  // The ceiling moves to full: the same socket is full now, and its frames land.
  writeJsonAtomic(d.recordPath, recordBody('full'));
  await waitUntil(() => sock.frames.some((f) => f.type === 'mirror:access' && f.level === 'full'), { timeout: 10000, interval: 10, what: 'the re-level to full' });
  const log3 = captureLog(t);
  for (const f of frames) sock.send(f);
  await waitUntil(() => d.srv.state.store.dropped_key === MARK
    && mount().form_state && mount().form_state['#f:0'] === MARK
    && mount().pane_state && mount().pane_state.minimized === true
    && d.srv.bus.read(seqBefore).events.some((e) => e.kind === 'script-error'), { timeout: 10000, interval: 10, what: 'the frames landing' });
  log3.restore();
  assert.ok(d.srv.bus.read(seqBefore).events.some((e) => e.kind === 'dom' && e.type === 'click'), 'the event landed');
  assert.equal(log3.lines.filter((l) => /dropped a/.test(l)).length, 0, 'nothing dropped at full');
});

// ── (8) the viewer counts and remote answering ──────────────────────────────

test('getViewerSummary counts a relayed socket as remote (at full: last_full_remote_at); remoteAnswering follows the ceiling in connected mode and the opt-in otherwise', async (t) => {
  withTempHome(t);
  const rec = connectorRecord('full');
  const { a } = audienceOf(t, { optIn: null, relay: connectedRelay(), connectorRecord: rec });
  const httpServer = http.createServer((r, res) => { res.statusCode = 404; res.end(); });
  const api = attachWebSocket(httpServer, {
    state: createState(), graph: { active: null, nodes: new Map(), lock: null }, paths: null,
    bus: createBus(), projectName: 'proj', audience: a, relay: connectedRelay(), log: () => {},
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { api.shutdown(); api.terminate(); httpServer.closeAllConnections(); httpServer.close(r); }));
  const port = httpServer.address().port;
  assert.deepStrictEqual([api.getViewerSummary().local, api.getViewerSummary().remote], [0, 0]);
  await openSocket(t, port, relayedHeaders('full'));
  await openSocket(t, port, []);
  await waitUntil(() => api.clients.size === 2, { timeout: 10000, interval: 5, what: 'both sockets' });
  const s = api.getViewerSummary();
  assert.equal(s.local, 1);
  assert.equal(s.remote, 1, 'the relayed socket counts as remote');
  assert.ok(Number.isFinite(s.last_full_remote_at), 'a relayed socket at full stamps last_full_remote_at');
  const relayedWc = [...api.clients].map((c) => c._wc).find((w) => w.peer === 'relayed');
  assert.equal(relayedWc.stamp, 'full', 'the socket keeps its stamp');
  assert.ok(!('actor' in relayedWc) || relayedWc.actor === null, 'no actor header: no actor');

  // remoteAnswering. Not connected: the opt-in.
  const asks = { decide() {}, pending: () => [] };
  const surfaceOf = (aud) => {
    const sfc = createAnswerSurface({ asks, mainPort: () => 1, audience: aud });
    t.after(() => sfc.close());
    return sfc;
  };
  const plain = audienceOf(t, { optIn: 'full' });
  const plainSurface = surfaceOf(plain.a);
  assert.equal(plainSurface.remoteAnswering(), true, 'not connected, opt-in full');
  plain.setOptIn('read');
  await waitUntil(() => plain.a.remoteLevel() === 'read', { timeout: 10000, interval: 10, what: 'the opt-in' });
  assert.equal(plainSurface.remoteAnswering(), false, 'not connected, opt-in read');

  // Connected: the ceiling — and a full opt-in under a read ceiling is narrowed.
  const rec2 = connectorRecord('read', 'hub-two.json');
  const conn = audienceOf(t, { optIn: 'full', relay: connectedRelay(), connectorRecord: rec2 });
  const connSurface = surfaceOf(conn.a);
  assert.equal(connSurface.remoteAnswering(), false, 'connected, ceiling read: off whatever the opt-in');
  writeJsonAtomic(rec2, recordBody('full'));
  await waitUntil(() => conn.a.ceiling() === 'full', { timeout: 10000, interval: 10, what: 'the ceiling' });
  assert.equal(connSurface.remoteAnswering(), true, 'connected, ceiling full');
  conn.setOptIn(null);
  await waitUntil(() => conn.a.remoteLevel() === 'off', { timeout: 10000, interval: 10, what: 'the opt-in off' });
  assert.equal(connSurface.remoteAnswering(), true, 'connected: the opt-in plays no part');
});

// ── (9) the resolver report through the answer surface ──────────────────────

test('POST /answer/api/elements/report: a relayed request at full under a full ceiling is accepted; a read stamp and no stamp are refused; a tunnel viewer at full still accepted, a local peer refused', async (t) => {
  const d = await boot(t, { optIn: 'full', record: () => connectorRecord('full') });
  const call = { port: d.port, noSpawn: true, timeout: 10000 };
  const client = require('../lib/client');
  await client.get('/api/asks?ensure=1', call);
  const health = await client.get('/api/health', call);
  const aport = health.answer.port;
  const origin = `http://127.0.0.1:${aport}`;
  // A pane with a pin, and a report naming the pin.
  assert.equal((await d.api.post('/api/render', { id: 'p1', html: '<p>one</p>' })).status, 200);
  const pin = (await d.anonApi.post('/api/elements', commentBody({ text: 'a note', shared: true, anchor: { mount: 'p1', selector: 'p', text: 'x' } }))).json.pin;
  const batch = () => ({ surface: d.srv.reports.surface(), mounts: [{ mount: 'p1', gen: d.srv.state.mounts.get('p1').gen || 0, items: [{ id: pin.id, v: pin.v, state: 'exact' }] }] });
  const docRes = await send(aport, { path: '/answer/elements/report?layout=report&mode=light&device=mobile', headers: [['sec-fetch-dest', 'iframe']] });
  const nonce = /name="wc-answer-nonce" content="([^"]*)"/.exec(docRes.text)[1];
  const post = (headers) => send(aport, {
    method: 'POST', path: '/answer/api/elements/report',
    headers: [['origin', origin], ['sec-fetch-site', 'same-origin'], ['x-wc-answer', nonce], ...headers],
    body: { reports: [batch()] },
  });
  const held = () => d.srv.reports.stats().held;

  const relayedFull = await post(relayedHeaders('full'));
  assert.equal(relayedFull.status, 200, relayedFull.text);
  assert.equal(relayedFull.json.ok, true);
  assert.equal(relayedFull.json.accepted, 1, relayedFull.text);

  for (const [what, stamp] of [['a read stamp', 'read'], ['no stamp', null]]) {
    const before = JSON.stringify(d.srv.reports.stats());
    const r = await post(relayedHeaders(stamp));
    assert.equal(r.status, 403, `${what}: ${r.text}`);
    assert.equal(r.json.ok, false, what);
    assert.equal(JSON.stringify(d.srv.reports.stats().held), JSON.stringify(JSON.parse(before).held), `${what}: nothing more held`);
  }
  const tunnel = await post([REMOTE_H]);
  assert.equal(tunnel.status, 200, `a tunnel viewer at full: ${tunnel.text}`);
  const local = await post([]);
  assert.equal(local.status, 403, local.text);
  assert.equal(local.json.refused, 'local', 'a local peer is refused as today');
  assert.ok(held() >= 1);

  // The kind's own check behind the engine's lock: a relayed request below
  // full is refused 'mirror' (the engine refuses it first through the live
  // surface, above); at full it reaches accept.
  for (const [level, expectStatus] of [['read', 403], ['basic', 403], ['full', 200]]) {
    let spec = null;
    const accepted = [];
    const off = registerRemoteReports({
      accept: (msg, opts) => { accepted.push(opts.peer); return { ok: true, accepted: 1, confirmed: 0 }; },
      answerSurface: { register: (kind, s) => { spec = s; return () => {}; } },
      audience: { peerOf: () => 'relayed', levelOf: () => level },
    });
    t.after(off);
    const sent = [];
    spec.api({ method: 'POST', headers: { 'x-wc-answer': 'n' } }, null, { json: (res, status, body) => sent.push({ status, body }) },
      { rest: 'report', query: {}, body: { reports: [batch()] } });
    assert.equal(sent[0].status, expectStatus, `relayed at ${level}`);
    if (expectStatus === 403) assert.deepStrictEqual(sent[0].body, { ok: false, refused: 'mirror', hint: ANSWER_HINT });
    else assert.deepStrictEqual(accepted, ['remote'], 'a relayed report is recorded as a remote peer\'s');
  }
});

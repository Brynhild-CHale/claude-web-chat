'use strict';

// lib/connector/relay.js (tranche 6, U717): the relay over the link and the
// connector's gate, against the fake hub (test-support/fake-hub.js, U735) over
// a real link (lib/connector/link.js, U716) to an in-process daemon built
// through createServer's seam with a relay secret (U741) and a connector record
// at ceiling full (U742). The fake validates every frame both ways against the
// locked schemas and fails the test on any that does not pass (withFakeHub's
// t.after).
//
// A STUB DAEMON (an http server answering /api/health with this process's pid
// and its own root's instance id, and a ws server at /ws) stands in where the
// test must see what reaches the daemon's socket, or make the daemon close
// with a code of its choosing — the real daemon does neither on request.
//
// Nothing here dials a host but loopback, binds a reserved port, or touches
// the developer's HOME (npm test's sandbox and withServer's own).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { once } = require('events');
const { WebSocketServer } = require('ws');
const { withFakeHub, mintLabel, isReservedPort } = require('../test-support/fake-hub');
const { createValidator } = require('../test-support/contracts-loader');
const { withServer, waitUntil } = require('../test-support/helpers');
const { createLink } = require('../lib/connector/link');
const { hubOrigin, newRecord, keyIdOf, fingerprintOf } = require('../lib/setup/connector');
const { versionsRecord, machineFacts } = require('../lib/connector/facts');
const connectedPolicy = require('../lib/core/connected-policy');
const { userPaths } = require('../lib/core/paths');
const { instanceId } = require('../lib/core/portfiles');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { LISTEN_HOST } = require('../lib/core/cors');
const { createServer } = require('../lib/server');
const { NOT_ANSWERING } = require('../lib/relay');
const {
  createRelay, install, mapCloseCode, cutReason, grantsOf, actorLine,
} = require('../lib/connector/relay');

const validator = createValidator({ folders: 'all' });
const S = 'https://web-chat-contracts/schemas/';
const UPSTREAM = validator.ajv.getSchema(`${S}06-relay-headers.json#/properties/upstream_request`);
const DOWNSTREAM = validator.ajv.getSchema(`${S}06-relay-headers.json#/properties/downstream_response`);
const REFUSAL = validator.ajv.getSchema(`${S}04-refusal-body.json`);
const DENY = validator.ajv.getSchema(`${S}04-deny-record.json`);
const DENY_FIELDS = new Set(Object.keys(validator.ajv.getSchema(`${S}04-deny-record.json`).schema.properties));
const DOWNSTREAM_NAMES = Object.keys(DOWNSTREAM.schema.properties);

const SECRET = crypto.randomBytes(32).toString('hex');
const KiB = 1024;
const MiB = 1024 * KiB;
const SHELL = 'https://hub.test:8443';
const originsOf = (label) => ({
  surface: `https://chat-${label}.hub.test:8443`,
  answer: `https://chat-${label}-a.hub.test:8443`,
  shell: SHELL,
});

function ajvSays(v, data, what) {
  assert.ok(v(data), `${what}: ${JSON.stringify(v.errors)}`);
}

// ── the machine and its link ───────────────────────────────────────────────
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
  return { privateKey, record, machine: m };
}

async function upLink(t, fake, m, logs) {
  const link = createLink({
    record: m.record,
    key: m.privateKey,
    versions: () => versionsRecord({ claudeVersion: null }),
    facts: () => machineFacts({ record: m.record, names: { mcp_servers: [], skills: [] }, hostname: 'test-host', login: 'tester' }),
    routeTable: () => ({ table_version: connectedPolicy.TABLE_VERSION, sha256: connectedPolicy.TABLE_SHA256 }),
    log: (line) => logs.push(line),
    writeKey: () => {},
  });
  t.after(() => link.stop());
  const ready = once(link, 'ready');
  link.start();
  await ready;
  return link;
}

// ── a daemon handed the secret, its record at ceiling full ────────────────
async function daemon(t) {
  let recordPath;
  const d = await withServer(t, {
    seed: () => {
      const dir = userPaths().connectorDir;
      fs.mkdirSync(dir, { recursive: true });
      recordPath = path.join(dir, 'hub-test.json');
      writeJsonAtomic(recordPath, { record_version: 1, hub: { id: 'hub-test' }, ceiling: 'full' });
    },
    createServer: (o) => createServer({ ...o, relaySecret: SECRET, relaySecretVia: 'option', connectorRecord: recordPath }),
  });
  d.seen = tap(d.server);
  return d;
}

// Every HTTP request and upgrade the daemon receives, before Express sees it,
// with the bytes its response wrote (never altered).
function tap(server) {
  const seen = [];
  server.prependListener('request', (req, res) => {
    const e = { method: req.method, url: req.url, headers: { ...req.headers }, rawHeaders: req.rawHeaders.slice(), wrote: [] };
    seen.push(e);
    const w = res.write;
    const end = res.end;
    const keep = (chunk, enc) => {
      if (chunk == null || typeof chunk === 'function') return;
      e.wrote.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
    };
    res.write = function write(chunk, enc, cb) { keep(chunk, enc); return w.call(this, chunk, enc, cb); };
    res.end = function endIt(chunk, enc, cb) { keep(chunk, enc); return end.call(this, chunk, enc, cb); };
  });
  server.prependListener('upgrade', (req) => {
    seen.push({ upgrade: true, method: 'GET', url: req.url, headers: { ...req.headers }, rawHeaders: req.rawHeaders.slice() });
  });
  return seen;
}
const relayed = (seen) => seen.filter((e) => e.headers['x-wc-remote'] === '1');
const probes = (seen) => seen.filter((e) => !e.upgrade && e.url === '/api/health' && e.headers['x-wc-remote'] == null);

// The hub's hint wording, stubbed with U745's one signature.
function hintStub() {
  const calls = [];
  const fn = (need, opts) => {
    calls.push({ need, opts: { ...opts } });
    return `hub hint: ${need} ${opts && opts.destructive ? 'destructive' : 'level'}`;
  };
  fn.calls = calls;
  return fn;
}

// One relay over a link to the fake, its target a daemon (real or stub).
async function setup(t, { stub = false, secret = SECRET, ceiling, connected } = {}) {
  const fake = await withFakeHub(t);
  const m = machineOn(fake);
  const logs = [];
  const link = await upLink(t, fake, m, logs);
  const d = stub ? await stubDaemon(t) : await daemon(t);
  const label = mintLabel();
  const ctx = {
    fake, link, d, label, logs, m,
    record: { ...m.record, ...(ceiling ? { ceiling } : {}) },
    target: {
      running: true, root: d.root, instance: instanceId(d.root), rec: { pid: process.pid, port: d.port },
      origins: originsOf(label), secret,
    },
    denies: [],
    unconfirmed: [],
    hint: hintStub(),
  };
  ctx.relay = install({
    link,
    targetOf: (l) => (l === label ? ctx.target : null),
    record: () => ctx.record,
    hintFor: ctx.hint,
    log: (line) => logs.push(line),
    onUnconfirmed: (l) => ctx.unconfirmed.push(l),
    ...(connected ? { connected } : {}),
  });
  ctx.relay.on('deny', (e) => ctx.denies.push(e));
  t.after(() => ctx.relay.stop());
  ctx.decision = (o = {}) => fake.decision({ chat: label, ...o });
  ctx.http = (o) => fake.relayHttp({ chat: label, ...o });
  return ctx;
}

// ── a stub daemon: health names this process and its own root; /ws records ──
async function stubDaemon(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-relay-stub-'));
  const seen = [];
  const sockets = [];
  const held = []; // responses left open after their head (a long read), with a promise of their socket's close
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'instance', pid: process.pid, instance: instanceId(root) }));
      return;
    }
    if (req.url.startsWith('/api/store?hold=')) {
      held.push({ res, closed: new Promise((r) => res.on('close', r)) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"held":');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ upgrade: true, url: req.url, headers: { ...req.headers } });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = { ws, received: [], closed: null };
      s.closedP = new Promise((r) => ws.on('close', (code) => { s.closed = code; r(code); }));
      ws.on('message', (data, isBinary) => s.received.push({ data: isBinary ? data : data.toString('utf8'), isBinary }));
      sockets.push(s);
    });
  });
  for (let i = 0; ; i++) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, LISTEN_HOST, resolve); });
    if (!isReservedPort(server.address().port)) break;
    await new Promise((r) => server.close(r));
    if (i > 4) throw new Error('stub daemon: only reserved ports');
  }
  t.after(async () => {
    for (const s of sockets) s.ws.terminate();
    for (const h of held) h.res.destroy();
    wss.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, port: server.address().port, seen, sockets, held, server };
}

const json = (r) => JSON.parse(r.body.toString('utf8'));
// A promise, or a failure naming `what` after `ms` (so a missing close fails
// fast instead of timing the test out).
function within(p, ms, what) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}
const relayFramesIn = (fake) => fake.frames.filter((f) => f.dir === 'in' && f.ch === 'relay').length;

// Each deny event carries 04-deny-record.json's fields this module knows, its
// path without a query; with the coalescing fields U730 adds it is a valid
// record when it names a principal.
function checkDeny(e) {
  for (const k of Object.keys(e)) assert.ok(DENY_FIELDS.has(k), `deny field ${k} is 04-deny-record.json's`);
  assert.ok(!String(e.path).includes('?'), 'no query string in a deny path');
  if (e.principal) {
    const ts = new Date().toISOString();
    ajvSays(DENY, { ts, first_ts: ts, count: 1, sink: 'log', ...e }, 'deny record');
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────
test('close codes: 1005 is sent as 1000, 1006 as 1011, codes outside 1000–4999 as 1011; a reason is cut at 123 bytes on a code point', () => {
  assert.strictEqual(mapCloseCode(1005), 1000);
  assert.strictEqual(mapCloseCode(1006), 1011);
  assert.strictEqual(mapCloseCode(4403), 4403);
  assert.strictEqual(mapCloseCode(1000), 1000);
  assert.strictEqual(mapCloseCode(999), 1011);
  assert.strictEqual(mapCloseCode(5000), 1011);
  const r = cutReason(Buffer.from('é'.repeat(100)));
  assert.ok(Buffer.byteLength(r) <= 123);
  assert.ok(!r.includes('�'));
  assert.strictEqual(cutReason('bye'), 'bye');
});

test('the grants are the held levels and true specifics in 04\'s order; the actor is one line of compact ASCII JSON', () => {
  const d = { levels: ['files', 'read'], specifics: { status: true, steer: true, destructive: false } };
  assert.strictEqual(grantsOf(d), 'status,read,files,steer');
  assert.strictEqual(grantsOf({ levels: [], specifics: { status: true, steer: false, destructive: false } }), 'status');
  const a = { v: 1, user: null, session: 'srf_x', via: 'shell', activity: 'act_y', name: 'Zoë' };
  const line = actorLine(a);
  assert.match(line, /^[\x20-\x7e]+$/);
  assert.deepStrictEqual(JSON.parse(line), a);
  assert.strictEqual(actorLine({ pad: 'x'.repeat(600) }), null);
});

test('install throws without hintFor (no default is in the hub\'s words) and without a link or targetOf', () => {
  const link = { channel: () => () => {}, send: () => null, streams: {}, on() {}, removeListener() {} };
  assert.throws(() => install({ link, targetOf: () => null, record: () => ({}) }), /hintFor/);
  assert.throws(() => createRelay({ targetOf: () => null, record: () => ({}), hintFor: () => 'x' }), /link/);
  assert.throws(() => createRelay({ link, record: () => ({}), hintFor: () => 'x' }), /targetOf/);
});

// ── round trips ────────────────────────────────────────────────────────────
test('a relayed GET at read and a relayed POST at full round-trip byte for byte; a 600 KiB body in credit-limited frames arrives intact', async (t) => {
  const c = await setup(t);
  const read = await c.http({ method: 'GET', path: '/api/store', decision: c.decision({ daemon_level: 'read' }) });
  assert.strictEqual(read.status, 200);
  const got = relayed(c.d.seen).find((e) => e.url === '/api/store');
  assert.ok(got, 'the GET reached the daemon');
  assert.ok(read.body.equals(Buffer.concat(got.wrote)), 'the body the daemon wrote is the body the fake received');

  const big = crypto.randomBytes(300 * KiB).toString('hex'); // 600 KiB of text
  const payload = Buffer.from(JSON.stringify({ patch: { relay_big: big } }));
  const before = relayed(c.d.seen).length;
  const post = await within(c.http({
    method: 'POST', path: '/api/store', body: payload,
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    decision: c.decision({ daemon_level: 'full' }),
  }), 10000, 'the 600 KiB round trip');
  assert.strictEqual(post.status, 200, post.body.toString('utf8').slice(0, 200));
  const e = relayed(c.d.seen).slice(before).find((x) => x.method === 'POST' && x.url === '/api/store');
  assert.ok(post.body.equals(Buffer.concat(e.wrote)), 'the response (over 256 KiB) arrived byte for byte');
  const bodyFrames = c.fake.frames.filter((f) => f.dir === 'out' && f.kind === 'relay.http.body');
  assert.ok(bodyFrames.length >= 2, 'the request body travelled in more than one frame');
  assert.ok(c.fake.frames.some((f) => f.dir === 'in' && f.kind === 'relay.window'), 'the connector granted credit as the body drained');
  const host = await c.d.api.get('/api/store?keys=relay_big');
  assert.strictEqual(host.json.relay_big, big, 'the daemon received the 600 KiB body intact');
});

test('the upstream headers are the closed set: the stamp at the decision\'s level beside the secret, X-WC-Remote last, every viewer x-wc-*, cookie and authorization dropped', async (t) => {
  const c = await setup(t);
  const d = c.decision({ daemon_level: 'read' });
  const actor = JSON.parse(JSON.stringify(validator.view.examples.get('03-actor-header').data));
  const r = await c.http({
    method: 'GET', path: '/api/store', decision: d, actor,
    headers: {
      accept: 'application/json', 'sec-fetch-mode': 'cors', origin: c.target.origins.surface,
      'x-wc-level': 'full', 'x-wc-relay': 'f'.repeat(64), 'x-wc-remote': '0', 'x-wc-shutdown': '1',
      cookie: 'a=b', authorization: 'Bearer x', 'x-api-key': 'k',
    },
  });
  assert.strictEqual(r.status, 200);
  const e = relayed(c.d.seen).find((x) => x.url === '/api/store');
  const h = { ...e.headers };
  delete h.host; delete h.connection; // the transport's, not the relay's
  ajvSays(UPSTREAM, h, 'upstream_request');
  assert.strictEqual(h['x-wc-remote'], '1');
  assert.strictEqual(h['x-wc-level'], 'read');
  assert.strictEqual(h['x-wc-decision'], d.decision_id);
  assert.strictEqual(h['x-wc-relay'], SECRET);
  assert.strictEqual(h['x-wc-actor'], JSON.stringify(actor));
  assert.strictEqual(h['x-wc-grants'], 'status,read');
  assert.strictEqual(h.origin, `http://localhost:${c.d.port}`, 'Origin rewritten to the daemon\'s loopback origin');
  for (const k of ['cookie', 'authorization', 'x-api-key', 'x-wc-shutdown']) assert.strictEqual(h[k], undefined, k);
  const names = e.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()).filter((n) => n.startsWith('x-wc-'));
  assert.strictEqual(names[names.length - 1], 'x-wc-remote', 'X-WC-Remote is set last');
  assert.strictEqual(names.filter((n) => n === 'x-wc-level').length, 1, 'one level header');

  // No secret held for this daemon: neither credential header goes upstream.
  c.target = { ...c.target, secret: null };
  const before = relayed(c.d.seen).length;
  await c.http({ method: 'GET', path: '/api/store', decision: c.decision({ daemon_level: 'read' }), headers: { 'x-wc-relay': 'e'.repeat(64) } });
  const e2 = relayed(c.d.seen).slice(before).find((x) => x.url === '/api/store');
  assert.strictEqual(e2.headers['x-wc-relay'], undefined);
  assert.strictEqual(e2.headers['x-wc-actor'], undefined);
  assert.strictEqual(e2.headers['x-wc-level'], 'read');
  assert.strictEqual(e2.headers.origin, undefined, 'no Origin when the hub forwarded none');

  // No secret in any frame or log line.
  assert.ok(!JSON.stringify(c.fake.frames).includes(SECRET), 'no secret on the link');
  assert.ok(!c.logs.join('\n').includes(SECRET), 'no secret in the log');
});

// ── the gate ───────────────────────────────────────────────────────────────
const HARNESS_ROWS = [
  ['POST', '/api/turn-begin'], ['POST', '/api/turn-end'], ['POST', '/api/commit'], ['GET', '/api/wait'],
  ['POST', '/api/render'], ['POST', '/api/markdown'], ['POST', '/api/marks'],
  ['POST', '/api/channel/push'], ['GET', '/api/events/stream'], ['POST', '/api/hooks/event'], ['POST', '/api/writers/claim'],
  ['POST', '/api/queue/items/q1/resend'], ['POST', '/api/mirror/x'], ['POST', '/api/asks/a1/decide'], ['POST', '/api/code/x'],
  ['POST', '/api/control/interrupt'], ['GET', '/api/bridge/poll'],
];
const EXTRA_ROWS = [
  ['POST', '/api/unlock'], ['POST', '/api/shutdown'], ['GET', '/api/machine/x'], ['GET', '/api/captures/x'],
  ['POST', '/api/capture/x'], ['GET', '/api/profiles/x'], ['GET', '/tunnel/setup'], ['GET', '/setup/x'],
  ['POST', '/api/packs/install'], ['POST', '/api/components/x'], ['POST', '/api/services/x'], ['POST', '/api/theme'],
  ['POST', '/api/themes'], ['POST', '/api/brand/logo'], ['POST', '/api/project/identity'], ['POST', '/api/toolbar/x'],
];
const NO_APEX = [['POST', '/api/sessions/s1/start'], ['GET', '/api/sessions']];

test('C-06.27: every harness row, the extra list, the session start and a picker path are refused 403 at the gate and never reach the daemon, whatever the decision', async (t) => {
  const c = await setup(t);
  const owner = c.decision({ daemon_level: 'full', specifics: { destructive: true, steer: true } });
  for (const [method, p] of [...HARNESS_ROWS, ...EXTRA_ROWS, ...NO_APEX]) {
    const r = await c.http({ method, path: p, decision: owner });
    assert.strictEqual(r.status, 403, `${method} ${p}`);
    const body = json(r);
    ajvSays(REFUSAL, body, `${method} ${p} refusal body`);
    assert.ok(['host-only', 'unknown'].includes(body.authority.reason), `${method} ${p}: ${body.authority.reason}`);
    assert.strictEqual(body.authority.decision_id, owner.decision_id);
  }
  assert.strictEqual(relayed(c.d.seen).length, 0, 'no refused route reached the daemon');
  const n = HARNESS_ROWS.length + EXTRA_ROWS.length + NO_APEX.length;
  assert.strictEqual(c.denies.length, n, 'exactly one deny per refusal');
  for (const e of c.denies) {
    checkDeny(e);
    assert.strictEqual(e.enforcer, 'connector');
    assert.strictEqual(e.origin, 'session');
    assert.strictEqual(e.machine_id, c.m.machine.id);
    assert.strictEqual(e.chat_id, c.label);
  }

  // A pending route the v1 wildcard admits (U744's list, I3 (a)) passes the
  // gate and reaches the daemon, which refuses it 403 host-only.
  const r = await c.http({ method: 'POST', path: '/api/elements/e1/picture', decision: owner, headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(relayed(c.d.seen).filter((e) => e.url === '/api/elements/e1/picture').length, 1, 'the daemon saw it');
  const last = c.denies[c.denies.length - 1];
  assert.strictEqual(last.enforcer, 'daemon', 'the daemon\'s refusal is told as the daemon\'s');
  assert.ok(['second-lock', 'daemon-rule'].includes(last.reason));
  assert.strictEqual(last.rule, 'POST|PATCH|DELETE /api/elements/*');
  checkDeny(last);
});

test('the decision: a read decision on a Message row is refused level with mirror read; expired → expired; another machine → no-decision; the hint is hintFor\'s', async (t) => {
  const c = await setup(t);
  const read = c.decision({ daemon_level: 'read' });
  const r = await c.http({ method: 'POST', path: '/api/queue/message', decision: read, headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
  assert.strictEqual(r.status, 403);
  const b = json(r);
  ajvSays(REFUSAL, b, 'level refusal');
  assert.strictEqual(b.authority.reason, 'level');
  assert.strictEqual(b.authority.need, 'message');
  assert.strictEqual(b.mirror, 'read');
  assert.strictEqual(b.hint, 'hub hint: message level');
  assert.deepStrictEqual(c.hint.calls.at(-1), { need: 'message', opts: { connected: true, destructive: false } });

  const expired = c.decision({ daemon_level: 'full', expiresInMs: -1000 });
  const e = json(await c.http({ method: 'GET', path: '/api/store', decision: expired }));
  ajvSays(REFUSAL, e, 'expired refusal');
  assert.strictEqual(e.authority.reason, 'expired');
  assert.strictEqual(e.authority.decision_id, null);

  const other = c.decision({ daemon_level: 'full', machineId: `mch_${mintLabel()}` });
  const o = json(await c.http({ method: 'GET', path: '/api/store', decision: other }));
  ajvSays(REFUSAL, o, 'another machine');
  assert.strictEqual(o.authority.reason, 'no-decision');

  // A requires refusal (wipe needs destructive) calls hintFor with destructive.
  const w = json(await c.http({ method: 'POST', path: '/api/graph/wipe', decision: c.decision({ daemon_level: 'full' }) }));
  ajvSays(REFUSAL, w, 'requires refusal');
  assert.strictEqual(w.authority.reason, 'requires');
  assert.deepStrictEqual(w.authority.requires, ['destructive']);
  assert.deepStrictEqual(c.hint.calls.at(-1), { need: 'write_page', opts: { connected: true, destructive: true } });
  assert.strictEqual(w.hint, 'hub hint: write_page destructive');

  // A lower version than one held for this (principal, chat) is never used.
  const v3 = c.decision({ daemon_level: 'full', version: 3 });
  assert.strictEqual((await c.http({ method: 'GET', path: '/api/store', decision: v3 })).status, 200);
  const v2 = c.decision({ daemon_level: 'full', version: 2 });
  assert.strictEqual(json(await c.http({ method: 'GET', path: '/api/store', decision: v2 })).authority.reason, 'no-decision');

  // The query on a refused path is not in the deny record.
  await c.http({ method: 'GET', path: '/api/unlock?token=x', decision: v3 });
  assert.strictEqual(c.denies.at(-1).path, '/api/unlock');
  assert.strictEqual(c.denies.length, 6, 'one deny per refusal');
  for (const d of c.denies) checkDeny(d);
  assert.strictEqual(relayed(c.d.seen).filter((x) => x.url !== '/api/store').length, 0, 'no refused request reached the daemon');
});

test('the ceiling: a record ceiling read refuses a write row a full decision holds; a chat not running is the connector\'s 404', async (t) => {
  const c = await setup(t, { ceiling: 'read' });
  const full = c.decision({ daemon_level: 'full' });
  const r = await c.http({ method: 'POST', path: '/api/store', decision: full, headers: { 'content-type': 'application/json' }, body: '{"patch":{}}' });
  assert.strictEqual(r.status, 403);
  const b = json(r);
  ajvSays(REFUSAL, b, 'ceiling refusal');
  assert.strictEqual(b.authority.reason, 'ceiling');
  assert.strictEqual(b.authority.need, 'write_page');
  assert.strictEqual((await c.http({ method: 'GET', path: '/api/store', decision: full })).status, 200, 'a read row stays under a read ceiling');

  c.target = { ...c.target, running: false };
  const nr = await c.http({ method: 'GET', path: '/api/store', decision: full });
  assert.strictEqual(nr.status, 404);
  assert.deepStrictEqual(json(nr), { ok: false, connector: true, reason: 'not-running' });
  const other = await c.fake.relayHttp({ chat: mintLabel(), method: 'GET', path: '/api/store' });
  assert.strictEqual(other.status, 404, 'a chat not assigned here');
  assert.strictEqual(relayed(c.d.seen).filter((x) => x.method === 'POST').length, 0);
});

test('identity: a port held by another root is 502 NOT_ANSWERING and onUnconfirmed; the HTTP probe is memoised for 1 s, every upgrade probes fresh', async (t) => {
  const c = await setup(t);
  const other = await daemon(t);
  const good = c.target;
  c.target = { ...good, rec: { pid: process.pid, port: other.port } };
  const r = await c.http({ method: 'GET', path: '/api/store', decision: c.decision({ daemon_level: 'read' }) });
  assert.strictEqual(r.status, 502);
  assert.deepStrictEqual(json(r), NOT_ANSWERING);
  assert.deepStrictEqual(c.unconfirmed, [c.label]);
  assert.strictEqual(relayed(other.seen).length, 0, 'nothing relayed to the wrong daemon');

  c.target = good;
  const d = c.decision({ daemon_level: 'read' });
  const p0 = probes(c.d.seen).length;
  await c.http({ method: 'GET', path: '/api/store', decision: d });
  await c.http({ method: 'GET', path: '/api/store', decision: d });
  assert.strictEqual(probes(c.d.seen).length - p0, 1, 'two HTTP requests within 1 s, one probe');
  for (let i = 0; i < 2; i++) {
    const ws = c.fake.relayWs({ chat: c.label, decision: d });
    assert.strictEqual(await ws.opened, true);
    ws.close(1000);
  }
  assert.strictEqual(probes(c.d.seen).length - p0, 3, 'each upgrade probed fresh');
});

test('embedded: a relayed health read carries x-wc-embedded, x-wc-embed-parent and x-wc-answer-origin; a surface document frame-ancestors the shell and no x-frame-options', async (t) => {
  const c = await setup(t);
  const owner = c.decision({ daemon_level: 'full' });
  const h = await c.http({ method: 'GET', path: '/api/health', decision: owner });
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.headers['x-wc-embedded'], '1');
  assert.strictEqual(h.headers['x-wc-embed-parent'], SHELL);
  assert.strictEqual(h.headers['x-wc-answer-origin'], owner.origins.answer);
  const pick = (hh) => Object.fromEntries(DOWNSTREAM_NAMES.filter((k) => hh[k] !== undefined).map((k) => [k, hh[k]]));
  ajvSays(DOWNSTREAM, pick(h.headers), 'health downstream');

  const doc = await c.http({ method: 'GET', path: '/', decision: c.decision({ daemon_level: 'read' }) });
  assert.strictEqual(doc.status, 200);
  assert.strictEqual(doc.headers['x-frame-options'], undefined);
  const csp = [].concat(doc.headers['content-security-policy']);
  assert.ok(csp.includes(`frame-ancestors ${SHELL}`), JSON.stringify(csp));
  assert.strictEqual(doc.headers['x-wc-embedded'], undefined, 'the embed headers ride the health read only');
  // A surface document's cache-control is the daemon's own, passed through
  // (securityHeaders adds no-store on /api/* and the previews only).
  const { 'cache-control': _own, ...docSet } = pick(doc.headers);
  ajvSays(DOWNSTREAM, docSet, 'document downstream');

  // A decision whose origins.answer is null (a Read grantee) adds none.
  const grantee = c.decision({ daemon_level: 'read', relation: 'grantee' });
  assert.strictEqual(grantee.origins.answer, null);
  const hr = await c.http({ method: 'GET', path: '/api/health', decision: grantee });
  assert.strictEqual(hr.headers['x-wc-embedded'], '1');
  assert.strictEqual(hr.headers['x-wc-answer-origin'], undefined);
});

// ── WebSocket ──────────────────────────────────────────────────────────────
test('WS: relay.ws.open at read reaches the daemon\'s /ws and relay.ws.opened follows; a hello over 256 KiB arrives fragmented with more', async (t) => {
  const c = await setup(t);
  await c.d.api.post('/api/store', { patch: { relay_hello_pad: 'h'.repeat(300 * KiB) } });
  const d = c.decision({ daemon_level: 'read' });
  const ws = c.fake.relayWs({ chat: c.label, decision: d, userAgent: 'test-agent/1' });
  assert.strictEqual(await ws.opened, true);
  await waitUntil(() => ws.messages.length >= 1, { timeout: 5000, what: 'the hello' });
  const hello = JSON.parse(ws.messages[0].data);
  assert.strictEqual(hello.type, 'hello');
  assert.ok(ws.messages[0].fragments >= 2, 'the hello travelled in more than one relay.ws.data');
  const frags = c.fake.frames.filter((f) => f.dir === 'in' && f.kind === 'relay.ws.data' && f.frame.stream === ws.stream);
  assert.strictEqual(frags[0].frame.more, true);
  const up = c.d.seen.find((e) => e.upgrade);
  assert.strictEqual(up.headers['x-wc-level'], 'read');
  assert.strictEqual(up.headers['x-wc-relay'], SECRET);
  assert.strictEqual(up.headers['x-wc-remote'], '1');
  assert.strictEqual(up.headers['user-agent'], 'test-agent/1');
  assert.strictEqual(up.headers.origin, undefined, 'no Origin on the upgrade');
  const opened = c.fake.frames.findIndex((f) => f.dir === 'in' && f.kind === 'relay.ws.opened');
  const firstData = c.fake.frames.findIndex((f) => f.dir === 'in' && f.kind === 'relay.ws.data');
  assert.ok(opened !== -1 && opened < firstData, 'opened before the first data');
  ws.close(1000);
  await ws.closed;
});

test('WS inbound filter: a store:set at read, a binary message and a 1 MiB + 1 B message are dropped before the daemon, each one deny; an allowed type passes; the daemon\'s 4403 passes through', async (t) => {
  const c = await setup(t, { stub: true });
  const d = c.decision({ daemon_level: 'read' });
  const ws = c.fake.relayWs({ chat: c.label, decision: d });
  assert.strictEqual(await ws.opened, true);
  await waitUntil(() => c.d.sockets.length === 1);
  const s = c.d.sockets[0];
  ws.send(JSON.stringify({ type: 'store:set', patch: { k: 1 } }));
  ws.send(Buffer.from([1, 2, 3]));
  // Valid JSON of an allowed type, exactly 1 MiB + 1 B: only the size rule drops it.
  const over = JSON.stringify({ type: 'client', pad: 'p'.repeat(MiB + 1 - JSON.stringify({ type: 'client', pad: '' }).length) });
  assert.strictEqual(Buffer.byteLength(over), MiB + 1);
  assert.strictEqual(JSON.parse(over).type, 'client');
  ws.send(over);
  ws.send('not json');
  ws.send(JSON.stringify({ type: 'nope' }));
  ws.send(JSON.stringify({ type: 'report' }));
  ws.send(JSON.stringify({ type: 'client', posture: 'desk' }));
  await waitUntil(() => s.received.length >= 1, { timeout: 5000, what: 'the allowed message' });
  assert.deepStrictEqual(s.received.map((m) => JSON.parse(m.data).type), ['client'], 'only the allowed type reached the daemon');
  await waitUntil(() => c.denies.length >= 6);
  assert.strictEqual(c.denies.length, 6);
  const [set, bin, big, bad, nope, rep] = c.denies;
  assert.deepStrictEqual([nope.path, nope.reason, nope.need], ['nope', 'unknown', null]);
  assert.deepStrictEqual([set.origin, set.method, set.path, set.reason, set.need, set.status], ['ws-inbound', 'MSG', 'store:set', 'level', 'write_page', null]);
  assert.strictEqual(bin.reason, 'malformed');
  assert.strictEqual(big.reason, 'malformed');
  assert.strictEqual(bad.reason, 'malformed');
  assert.deepStrictEqual([rep.path, rep.reason], ['report', 'host-only']);
  for (const e of c.denies) { checkDeny(e); assert.strictEqual(e.enforcer, 'connector'); }

  s.ws.close(4403, 'access changed');
  const closed = await ws.closed;
  assert.deepStrictEqual([closed.code, closed.by], [4403, 'connector']);
});

test('WS closes: a daemon close with no code reaches the hub as 1000, a dropped daemon socket as 1011; the hub\'s close closes the daemon socket', async (t) => {
  const c = await setup(t, { stub: true });
  const d = c.decision({ daemon_level: 'read' });
  const open = async () => {
    const ws = c.fake.relayWs({ chat: c.label, decision: d });
    assert.strictEqual(await ws.opened, true);
    const n = c.d.sockets.length;
    await waitUntil(() => c.d.sockets.length >= n || c.d.sockets.length > 0);
    return { ws, s: c.d.sockets[c.d.sockets.length - 1] };
  };
  const a = await open();
  a.s.ws.close();
  assert.strictEqual((await a.ws.closed).code, 1000);
  const b = await open();
  b.s.ws.terminate();
  assert.strictEqual((await b.ws.closed).code, 1011);
  const h = await open();
  const t0 = Date.now();
  h.ws.close(4001, 'bye');
  assert.strictEqual(await h.s.closedP, 4001);
  assert.ok(Date.now() - t0 < 1000, 'the daemon socket closed within 1 s');
});

test('a decision change closes the open relay with 4403 within 1 s and the daemon socket; a decision_ref after the link is re-established refers to nothing', async (t) => {
  const c = await setup(t, { stub: true });
  const d1 = c.decision({ daemon_level: 'full', version: 1 });
  const ref1 = c.fake.sendDecision(d1);
  const ws = c.fake.relayWs({ chat: c.label, decisionRef: ref1 });
  assert.strictEqual(await ws.opened, true, 'opened on a decision_ref');
  await waitUntil(() => c.d.sockets.length === 1);
  const same = c.decision({ daemon_level: 'full', version: 2 });
  same.levels = d1.levels;
  same.specifics = d1.specifics;
  c.fake.sendDecision(same);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(ws.state, 'open', 'a newer version with the same material leaves the relay open');
  const t0 = Date.now();
  c.fake.sendDecision(c.decision({ daemon_level: 'read', version: 3 }));
  const closed = await within(ws.closed, 1000, 'the 4403 close');
  assert.strictEqual(closed.code, 4403);
  assert.ok(Date.now() - t0 < 1000, 'within 1 s');
  await within(c.d.sockets[0].closedP, 2000, 'the daemon socket close');

  const ref = c.fake.sendDecision(c.decision({ daemon_level: 'read', version: 4 }));
  assert.strictEqual((await c.http({ method: 'GET', path: '/api/health', decisionRef: ref })).status, 200);
  const again = once(c.link, 'ready');
  c.fake.close(4408);
  await again;
  const r = await c.http({ method: 'GET', path: '/api/health', decisionRef: ref });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(json(r).authority.reason, 'no-decision');
});

test('a decision change aborts an in-flight relayed HTTP request within 1 s (relay.http.abort access_changed) and drops the daemon request', async (t) => {
  const c = await setup(t, { stub: true });
  const d1 = c.decision({ daemon_level: 'full', version: 1 });
  const ref1 = c.fake.sendDecision(d1);
  const p = c.http({ method: 'GET', path: '/api/store?hold=1', decisionRef: ref1 });
  await waitUntil(() => c.d.held.length === 1, { timeout: 5000, what: 'the held daemon request' });
  await waitUntil(() => c.fake.frames.some((f) => f.dir === 'in' && f.kind === 'relay.http.response'), { timeout: 5000, what: 'the response head' });
  const t0 = Date.now();
  c.fake.sendDecision(c.decision({ daemon_level: 'read', version: 2 }));
  const err = await within(p.then(() => { throw new Error('the request completed'); }, (e) => e), 1000, 'the abort');
  assert.strictEqual(err.close && err.close.reason, 'access_changed');
  await within(c.d.held[0].closed, 1000, 'the daemon request dropped');
  assert.ok(Date.now() - t0 < 1000, 'within 1 s');
  assert.strictEqual(c.relay.openCount, 0, 'the stream is released');
});

test('relay.request: a connector-originated POST is refused at read (one deny, never at the daemon) and reaches the daemon at full with the closed header set, taking no stream slot', async (t) => {
  const c = await setup(t);
  const body = JSON.stringify({ patch: { delivered: 1 } });
  const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  const actor = JSON.parse(JSON.stringify(validator.view.examples.get('03-actor-header').data));
  const r = await c.relay.request({
    chat: c.label, decision: c.decision({ daemon_level: 'read' }), surface: 'session', method: 'POST', path: '/api/store', headers, body, actor,
  });
  assert.strictEqual(r.status, 403);
  ajvSays(REFUSAL, JSON.parse(r.body.toString('utf8')), 'one-shot refusal');
  assert.strictEqual(c.denies.length, 1);
  checkDeny(c.denies[0]);
  assert.strictEqual(relayed(c.d.seen).length, 0);

  const framesBefore = relayFramesIn(c.fake);
  const full = c.decision({ daemon_level: 'full' });
  const ok = await c.relay.request({ chat: c.label, decision: full, method: 'POST', path: '/api/store', headers, body, actor });
  assert.strictEqual(ok.status, 200, ok.body.toString('utf8').slice(0, 200));
  assert.strictEqual(c.link.streams.count, 0, 'no stream slot');
  assert.strictEqual(relayFramesIn(c.fake), framesBefore, 'nothing on the link');
  const e = relayed(c.d.seen).find((x) => x.method === 'POST');
  const h = { ...e.headers };
  delete h.host; delete h.connection;
  ajvSays(UPSTREAM, h, 'one-shot upstream_request');
  assert.strictEqual(h['x-wc-level'], 'full');
  assert.strictEqual(h['x-wc-decision'], full.decision_id);
  assert.strictEqual(h['x-wc-relay'], SECRET);
  assert.strictEqual(h['x-wc-actor'], JSON.stringify(actor));
  assert.ok(ok.body.equals(Buffer.concat(e.wrote)));
  assert.strictEqual((await c.d.api.get('/api/store?keys=delivered')).json.delivered, 1);
});

test('the answer origin: a request reaches the answer surface\'s own port (asked as a local caller) in the answer mode, its frame-ancestors the surface then the shell', async (t) => {
  const c = await setup(t);
  const owner = c.decision({ daemon_level: 'full' });
  const r = await c.http({ surface: 'answer', method: 'GET', path: '/answer/answer.css', decision: owner });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/css/);
  const csp = [].concat(r.headers['content-security-policy']);
  assert.strictEqual(csp.length, 1);
  assert.ok(csp[0].endsWith(`frame-ancestors ${c.target.origins.surface} ${SHELL}`), csp[0]);
  assert.strictEqual(r.headers['x-frame-options'], undefined);
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  // The port came from the daemon's GET /api/asks?ensure=1, a host read.
  const ask = c.d.seen.find((e) => e.url === '/api/asks?ensure=1');
  assert.ok(ask && ask.headers['x-wc-remote'] == null && ask.headers.origin == null, 'the answer port asked as a local caller');
  // A read decision is refused at the gate on the answer origin.
  const ro = await c.http({ surface: 'answer', method: 'GET', path: '/answer/answer.css', decision: c.decision({ daemon_level: 'read' }) });
  assert.strictEqual(ro.status, 403);
  const b = json(ro);
  ajvSays(REFUSAL, b, 'answer refusal');
  assert.strictEqual(b.authority.reason, 'level');
  assert.strictEqual(c.denies.length, 1);
  assert.strictEqual(c.denies[0].origin, 'answer');
  checkDeny(c.denies[0]);
});

test('step 5 is a lock of its own: a route a (substituted) connected table admits is still refused when classify() refuses it at the hub\'s level', async (t) => {
  // A table that admits everything at read, no requires: only remote-policy's
  // own verdict at the decision's daemon level stands between it and the daemon.
  const row = (level) => ({ methods: '*', path: '/*', allow: true, level, requires: [], daemon_mirror: null, from_rule: '*' });
  const open = {
    classifySession: () => ({ allow: true, key: '* /*', row: row('read') }),
    classifyAnswerRoute: () => ({ allow: true, key: '* /*', row: row('read') }),
    wsInboundLevel: () => 'read',
  };
  const c = await setup(t, { connected: open });
  const owner = c.decision({ daemon_level: 'full' });
  const unlock = json(await c.http({ method: 'POST', path: '/api/unlock', decision: owner }));
  ajvSays(REFUSAL, unlock, 'host-only by classify');
  assert.deepStrictEqual([unlock.authority.reason, unlock.authority.rule, unlock.authority.need], ['host-only', '* /api/unlock', 'read']);
  const wipe = json(await c.http({ method: 'POST', path: '/api/graph/wipe', decision: owner }));
  assert.deepStrictEqual([wipe.authority.reason, wipe.authority.requires], ['requires', ['destructive']]);
  assert.deepStrictEqual(c.hint.calls.at(-1).opts, { connected: true, destructive: true });
  const read = c.decision({ daemon_level: 'read' });
  const msg = json(await c.http({ method: 'POST', path: '/api/queue/message', decision: read }));
  assert.deepStrictEqual([msg.authority.reason, msg.mirror], ['level', 'read'], 'classify at the hub\'s level, not the table\'s');
  assert.strictEqual(relayed(c.d.seen).length, 0, 'none reached the daemon');
  assert.strictEqual(c.denies.length, 3);
  for (const e of c.denies) checkDeny(e);
});

// ── hand fold 7 (h), U790: a ws piece holding a registered secret ──────────

test('WS: a daemon message holding a registered secret is never sent (link.send throws secret); the stream ends with relay.ws.close and the daemon socket closes, and the next stream still relays', async (t) => {
  const c = await setup(t, { stub: true });
  const d = c.decision({ daemon_level: 'read' });
  const token = 'tok-7f3a9c1e07b54d2f68aa';
  c.link.registerSecret(token);
  const ws = c.fake.relayWs({ chat: c.label, decision: d });
  assert.strictEqual(await ws.opened, true);
  await waitUntil(() => c.d.sockets.length === 1, { timeout: 5000, what: 'the daemon socket' });
  const s = c.d.sockets[0];
  s.ws.send(JSON.stringify({ type: 'hello', leak: token }));
  const closed = await within(ws.closed, 2000, 'the relay closed');
  assert.strictEqual(closed.code, 1011);
  assert.strictEqual(await within(s.closedP, 2000, 'the daemon socket closed'), 1011, 'the upstream closed, never left paused');
  assert.ok(!JSON.stringify(c.fake.frames.map((f) => f.frame)).includes(token), 'the secret reached no frame');
  assert.ok(c.logs.some((l) => /relay stream \d+ data refused: secret/.test(l)), 'logged by code');
  // The link is not stuck: another stream relays a message.
  const ws2 = c.fake.relayWs({ chat: c.label, decision: d });
  assert.strictEqual(await ws2.opened, true);
  await waitUntil(() => c.d.sockets.length === 2, { timeout: 5000, what: 'the second daemon socket' });
  c.d.sockets[1].ws.send(JSON.stringify({ type: 'hello' }));
  await waitUntil(() => ws2.messages.length === 1, { timeout: 5000, what: 'the second stream\'s message' });
  ws2.close(1000);
  await ws2.closed;
});

// ── hand fold 5 (b), U790: a GET whose daemon response head never comes ────

test('a relayed GET whose daemon holds its response head is dropped at the daemon within 1 s of an access change or the hub\'s abort (C-03.31)', async (t) => {
  const c = await setup(t, { stub: true });
  // The stub's own root and identity, on a server that never writes a head.
  const pending = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'instance', pid: process.pid, instance: instanceId(c.d.root) }));
      return;
    }
    pending.push({ url: req.url, closed: new Promise((r) => req.socket.on('close', r)) });
  });
  await new Promise((resolve) => server.listen(0, LISTEN_HOST, resolve));
  assert.ok(!isReservedPort(server.address().port));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  c.target.rec.port = server.address().port;

  // (1) a newer decision version that changes the access.
  const ref1 = c.fake.sendDecision(c.decision({ daemon_level: 'full', version: 1 }));
  const p1 = c.http({ method: 'GET', path: '/api/store?nohead=1', decisionRef: ref1 });
  await waitUntil(() => pending.length === 1, { timeout: 5000, what: 'the daemon request' });
  const t0 = Date.now();
  c.fake.sendDecision(c.decision({ daemon_level: 'read', version: 2 }));
  await within(p1.then(() => null, (e) => e), 1000, 'the hub told');
  await within(pending[0].closed, 1000, 'the daemon request dropped on access_changed');
  assert.ok(Date.now() - t0 < 1000);

  // (2) the hub's own abort of the stream.
  const ref3 = c.fake.sendDecision(c.decision({ daemon_level: 'full', version: 3 }));
  const p2 = c.http({ method: 'GET', path: '/api/store?nohead=2', decisionRef: ref3 });
  p2.catch(() => {});
  await waitUntil(() => pending.length === 2, { timeout: 5000, what: 'the second daemon request' });
  const req = c.fake.frames.filter((f) => f.dir === 'out' && f.kind === 'relay.http.request').pop();
  const t1 = Date.now();
  c.fake.send({ ch: 'relay', kind: 'relay.http.abort', stream: req.frame.stream, reason: 'client_gone' });
  await within(pending[1].closed, 1000, 'the daemon request dropped on the hub\'s abort');
  assert.ok(Date.now() - t1 < 1000);
  await waitUntil(() => c.relay.openCount === 0, { timeout: 2000, what: 'the streams released' });
});

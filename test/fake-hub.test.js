'use strict';

// The fake hub (test-support/fake-hub.js, contract 12 C-12.22) against a
// minimal client built here from ws and crypto: the connector is not built yet,
// and this client is not one — it speaks just enough of contract 05 to drive
// each capability the fake plays.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const WebSocket = require('ws');
const {
  withFakeHub, createFakeHub, isReservedPort, keyIdOf, fingerprintOf, SUBPROTOCOL, CHUNK, CREDIT, MAX_PAYLOAD,
} = require('../test-support/fake-hub');
const { createValidator } = require('../test-support/contracts-loader');
const { waitUntil } = require('../test-support/helpers');

const validator = createValidator({ folders: 'all' });
const example = (name) => JSON.parse(JSON.stringify(validator.view.examples.get(name).data));
const HELLO = example('05-hello');

// ── the minimal client ─────────────────────────────────────────────────────
function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey, wire: publicKey.export({ format: 'jwk' }).x };
}
const sign = (key, text) => crypto.sign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('base64url');

async function openLink(fake, { protocols = [SUBPROTOCOL], path = '/connector' } = {}) {
  const ws = new WebSocket(fake.wsUrl.replace('/connector', path), protocols, { maxPayload: MAX_PAYLOAD });
  const c = { ws, frames: [], seq: {}, ids: 0, hooks: [] };
  ws.on('error', () => {});
  c.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString('utf8'));
    c.frames.push(f);
    for (const h of c.hooks) h(f);
  });
  c.on = (fn) => c.hooks.push(fn);
  c.send = (frame) => {
    const { ch, kind, ...rest } = frame;
    c.seq[ch] = (c.seq[ch] || 0) + 1;
    const full = { ch, kind, id: `c${++c.ids}`, seq: c.seq[ch], ...rest };
    ws.send(JSON.stringify(full));
    return full;
  };
  c.next = (kind, n = 1, timeout = 5000) => waitUntil(() => c.frames.filter((f) => f.kind === kind)[n - 1], { timeout, what: `${kind} #${n}` });
  c.count = (kind) => c.frames.filter((f) => f.kind === kind).length;
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return c;
}

async function authenticate(fake, c, machine, key, { host = fake.host } = {}) {
  const challenge = await c.next('auth.challenge');
  const keyId = keyIdOf(key.wire);
  c.send({
    ch: 'control', kind: 'auth.response', re: challenge.id, machine_id: machine.id, key_id: keyId, public_key: key.wire,
    signature: sign(key, `web-chat-connector-auth/1\n${host}\n${challenge.nonce}\n${machine.id}\n${keyId}`),
  });
  return waitUntil(() => c.frames.find((f) => f.kind === 'auth.ok' || f.kind === 'auth.refused'), { timeout: 5000, what: 'auth answer' });
}

function hello(c, { protocol } = {}) {
  const versions = { ...HELLO.versions, ...(protocol ? { protocol } : {}) };
  c.send({ ch: 'control', kind: 'hello', versions, route_table: HELLO.route_table, capabilities: HELLO.capabilities });
  return waitUntil(() => c.frames.find((f) => f.kind === 'hello.ack' || f.kind === 'hello.refused'), { timeout: 5000, what: 'hello answer' });
}

async function connect(fake, machine, key) {
  const c = await openLink(fake);
  const ok = await authenticate(fake, c, machine, key);
  assert.strictEqual(ok.kind, 'auth.ok');
  c.ack = await hello(c);
  assert.strictEqual(c.ack.kind, 'hello.ack');
  return c;
}

async function paired(t, opts) {
  const fake = await withFakeHub(t, opts);
  const key = newKey();
  const machine = fake.addMachine({ publicKey: key.wire, name: 'Studio Mac' });
  return { fake, key, machine };
}

function post(fake, path, body) {
  return fetch(`${fake.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
}

// ── the port and the bind ──────────────────────────────────────────────────
test('the fake listens on 127.0.0.1 only, on a port outside {5170, 5171} and 5173-5272', async (t) => {
  const fake = await withFakeHub(t);
  assert.strictEqual(fake.address.address, '127.0.0.1');
  assert.ok(!isReservedPort(fake.port), `port ${fake.port}`);
  assert.ok(fake.port !== 5170 && fake.port !== 5171 && (fake.port < 5173 || fake.port > 5272));
  assert.strictEqual(fake.url, `http://127.0.0.1:${fake.port}`);
  assert.strictEqual(fake.connectUrl, `wss://127.0.0.1:${fake.port}/connector`);
  for (const p of [5170, 5171, 5173, 5200, 5272]) assert.ok(isReservedPort(p), String(p));
  for (const p of [5169, 5172, 5273, 0, 51000]) assert.ok(!isReservedPort(p), String(p));
});

test('a reserved port is re-listened up to five times, then refused', async (t) => {
  let calls = 0;
  const lucky = createFakeHub({ isReserved: () => { calls += 1; return calls <= 2; } });
  await lucky.start();
  t.after(() => lucky.stop());
  assert.strictEqual(calls, 3);
  let tries = 0;
  const unlucky = createFakeHub({ isReserved: () => { tries += 1; return true; } });
  await assert.rejects(unlucky.start(), /reserved band/);
  assert.strictEqual(tries, 5);
});

test('the link wants /connector and the web-chat-connector subprotocol', async (t) => {
  const fake = await withFakeHub(t);
  await assert.rejects(openLink(fake, { protocols: ['other'] }), /400/);
  await assert.rejects(openLink(fake, { path: '/elsewhere' }), /400/);
  const c = await openLink(fake);
  assert.strictEqual(c.ws.protocol, SUBPROTOCOL);
  assert.strictEqual((await c.next('auth.challenge')).nonce.length, 43);
});

// ── pairing ────────────────────────────────────────────────────────────────
test('the key id and fingerprint reproduce contract 03\'s test vector', () => {
  const vector = example('03-credential-machine');
  assert.strictEqual(keyIdOf(vector.public_key.value), 'mky_v6men077h4s9p7hvxfv5etvn01');
  assert.strictEqual(keyIdOf(vector.public_key.value), vector.key_id);
  assert.strictEqual(fingerprintOf(vector.public_key.value), 'SHA256:2ajqgOeJMpseO+v2V2t1AFIewl46CYiSZ6HzUasBleQ');
  assert.strictEqual(fingerprintOf(vector.public_key.value), vector.fingerprint);
});

test('pairing: a signed start, a confirmed code, a bound poll; reuse, expiry and skew refused', async (t) => {
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const fake = await withFakeHub(t, { now: () => clock, pollHoldMs: 40 });
  const key = newKey();
  const start = async (k = key) => {
    const nonce = crypto.randomBytes(32).toString('base64url');
    return post(fake, '/connector/pair', {
      v: 1, public_key: k.wire, client_nonce: nonce, proof: sign(k, `web-chat-connector-pair/1\n${fake.host}\n${nonce}`),
      connector: { hostname: 'studio', platform: 'darwin', package_version: '0.9.0-alpha.7' },
    });
  };
  const poll = (id, { ts = clock, k = key } = {}) => post(fake, '/connector/pair/poll', {
    v: 1, pairing_id: id, ts, proof: sign(k, `web-chat-connector-pair-poll/1\n${fake.host}\n${id}\n${ts}`),
  });

  const s = await start();
  assert.strictEqual(s.status, 200);
  assert.match(s.body.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.match(s.body.pairing_id, /^pr_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.strictEqual(s.body.expires_at, clock + 300 * 1000);
  assert.strictEqual(s.body.fingerprint, fingerprintOf(key.wire));
  assert.strictEqual(s.body.hub_id, 'hub-test');

  assert.strictEqual((await poll(s.body.pairing_id)).body.state, 'pending');

  // The record keeps only a mask of the code; the hash is what it holds.
  const recorded = fake.find('pairing.start_response', { dir: 'out' })[0];
  assert.strictEqual(recorded.frame.code, '****-****');
  assert.ok(!JSON.stringify(fake.frames).includes(s.body.code));

  const confirmed = fake.pairing.confirm(s.body.code, { name: 'Studio Mac' });
  assert.strictEqual(confirmed.ok, true);
  const bound = await poll(s.body.pairing_id);
  assert.strictEqual(bound.status, 200);
  assert.deepStrictEqual(Object.keys(bound.body).sort(), ['connect_url', 'hub_id', 'key_id', 'machine_id', 'machine_name', 'ok', 'state']);
  assert.strictEqual(bound.body.state, 'bound');
  assert.strictEqual(bound.body.key_id, keyIdOf(key.wire));
  assert.strictEqual(bound.body.machine_name, 'Studio Mac');
  assert.strictEqual(bound.body.connect_url, fake.connectUrl);
  assert.strictEqual(fake.machine(bound.body.machine_id).key_id, keyIdOf(key.wire));

  assert.deepStrictEqual(fake.pairing.confirm(s.body.code), { ok: false, reason: 'used' });

  // A long poll is woken by the confirmation.
  const key2 = newKey();
  const s2 = await start(key2);
  fake.options.pollHoldMs = 10 * 1000;
  const polls = fake.find('pairing.poll_request').length;
  const waiting = poll(s2.body.pairing_id, { k: key2 });
  await waitUntil(() => fake.find('pairing.poll_request').length > polls, { what: 'the poll held' });
  fake.pairing.confirm(s2.body.code);
  assert.strictEqual((await waiting).body.state, 'bound');
  fake.options.pollHoldMs = 40;

  // A code past its TTL polls expired, and cannot be confirmed.
  const s3 = await start();
  clock += 301 * 1000;
  const expired = await poll(s3.body.pairing_id);
  assert.strictEqual(expired.body.state, 'expired');
  assert.deepStrictEqual(fake.pairing.confirm(s3.body.code), { ok: false, reason: 'expired' });

  // A poll 121 s off the hub's clock.
  const s4 = await start();
  const skewed = await poll(s4.body.pairing_id, { ts: clock - 121 * 1000 });
  assert.strictEqual(skewed.status, 400);
  assert.strictEqual(skewed.body.error, 'clock_skew');

  // A proof by another key, and over another host.
  const other = newKey();
  assert.strictEqual((await poll(s4.body.pairing_id, { k: other })).body.error, 'bad_proof');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const wrongHost = await post(fake, '/connector/pair', {
    v: 1, public_key: key.wire, client_nonce: nonce, proof: sign(key, `web-chat-connector-pair/1\nhub.example\n${nonce}`),
    connector: { hostname: 'studio', platform: 'darwin', package_version: '0.9.0-alpha.7' },
  });
  assert.deepStrictEqual([wrongHost.status, wrongHost.body.error], [400, 'bad_proof']);
});

test('pairing limits: the sixth start from one address is 429 with Retry-After', async (t) => {
  const fake = await withFakeHub(t, { limits: true });
  const key = newKey();
  const statuses = [];
  let last;
  for (let i = 0; i < 6; i++) {
    const nonce = crypto.randomBytes(32).toString('base64url');
    last = await post(fake, '/connector/pair', {
      v: 1, public_key: key.wire, client_nonce: nonce, proof: sign(key, `web-chat-connector-pair/1\n${fake.host}\n${nonce}`),
      connector: { hostname: 'studio', platform: 'linux', package_version: '0.9.0-alpha.7' },
    });
    statuses.push(last.status);
  }
  assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.strictEqual(last.body.error, 'rate_limited');
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});

// ── authentication and rotation ────────────────────────────────────────────
test('auth: a correct signature gets auth.ok; a wrong host, a stale nonce and an unknown key are refused', async (t) => {
  let clock = Date.now();
  const { fake, key, machine } = await paired(t, { now: () => clock });

  const good = await openLink(fake);
  const ok = await authenticate(fake, good, machine, key);
  assert.strictEqual(ok.kind, 'auth.ok');
  assert.strictEqual(ok.machine_id, machine.id);
  assert.strictEqual(ok.key_id, keyIdOf(key.wire));
  assert.strictEqual(ok.rotate, false);
  assert.match(ok.connection, /^cxs_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.ok(ok.expires_at <= clock + 24 * 3600 * 1000);
  good.ws.close();

  const wrongHost = await openLink(fake);
  const refusedHost = await authenticate(fake, wrongHost, machine, key, { host: 'hub.example' });
  assert.deepStrictEqual([refusedHost.kind, refusedHost.reason], ['auth.refused', 'bad_signature']);
  assert.strictEqual((await wrongHost.closed).code, 4401);

  const stale = await openLink(fake);
  const challenge = await stale.next('auth.challenge');
  clock += 11 * 1000;
  stale.send({
    ch: 'control', kind: 'auth.response', re: challenge.id, machine_id: machine.id, key_id: keyIdOf(key.wire), public_key: key.wire,
    signature: sign(key, `web-chat-connector-auth/1\n${fake.host}\n${challenge.nonce}\n${machine.id}\n${keyIdOf(key.wire)}`),
  });
  assert.strictEqual((await stale.next('auth.refused')).reason, 'nonce_expired');
  assert.strictEqual((await stale.closed).code, 4401);

  // A nonce from another socket is not this socket's.
  const replay = await openLink(fake);
  await replay.next('auth.challenge');
  replay.send({
    ch: 'control', kind: 'auth.response', re: 'h1', machine_id: machine.id, key_id: keyIdOf(key.wire), public_key: key.wire,
    signature: sign(key, `web-chat-connector-auth/1\n${fake.host}\n${challenge.nonce}\n${machine.id}\n${keyIdOf(key.wire)}`),
  });
  assert.strictEqual((await replay.next('auth.refused')).reason, 'bad_signature');

  const stranger = newKey();
  const unknown = await openLink(fake);
  const held = await authenticate(fake, unknown, machine, stranger);
  assert.deepStrictEqual([held.kind, held.reason], ['auth.refused', 'key_held']);
  assert.strictEqual((await unknown.closed).code, 4423);
  assert.strictEqual(fake.machine(machine.id).held, keyIdOf(stranger.wire));
});

test('rotate: auth.ok asks for a new key; a doubly signed key.rotate is key.rotated; the old key authenticates for 24 h', async (t) => {
  const { fake, key, machine } = await paired(t, { rotate: true });
  const c = await openLink(fake);
  const ok = await authenticate(fake, c, machine, key);
  assert.strictEqual(ok.rotate, true);
  const next = newKey();
  const newId = keyIdOf(next.wire);
  const text = `web-chat-connector-rotate/1\n${fake.host}\n${machine.id}\n${newId}`;

  // One signature is not enough.
  c.send({ ch: 'control', kind: 'key.rotate', new_public_key: next.wire, new_key_id: newId, sig_old: sign(key, text), sig_new: sign(key, text) });
  assert.strictEqual((await c.next('control.error')).code, 'not_allowed');

  c.send({ ch: 'control', kind: 'key.rotate', new_public_key: next.wire, new_key_id: newId, sig_old: sign(key, text), sig_new: sign(next, text) });
  const rotated = await c.next('key.rotated');
  assert.strictEqual(rotated.key_id, newId);
  assert.strictEqual(fake.machine(machine.id).key_id, newId);
  assert.strictEqual(fake.machine(machine.id).retiring, keyIdOf(key.wire));

  const withOld = await openLink(fake);
  const oldOk = await authenticate(fake, withOld, machine, key);
  assert.deepStrictEqual([oldOk.kind, oldOk.key_id], ['auth.ok', newId]);
  const withNew = await openLink(fake);
  assert.strictEqual((await authenticate(fake, withNew, machine, next)).kind, 'auth.ok');
});

// ── hello and the compat window ────────────────────────────────────────────
test('hello: the window set to ok, ahead and behind answers hello.ack with that verdict; refused is hello.refused and 4426', async (t) => {
  const { fake, key, machine } = await paired(t);
  for (const state of ['ok', 'ahead', 'behind']) {
    fake.setWindow(state);
    const c = await connect(fake, machine, key);
    assert.strictEqual(c.ack.compat.state, state);
    assert.strictEqual(c.ack.protocol, 1);
    assert.deepStrictEqual(c.ack.hub, { id: 'hub-test', origin: fake.origin });
    assert.deepStrictEqual(c.ack.machine, { id: machine.id, name: 'Studio Mac' });
    assert.deepStrictEqual([c.ack.heartbeat_ms, c.ack.dead_after_ms], [15000, 45000]);
    assert.deepStrictEqual(c.ack.windows, {
      relay_stream_bytes: 262144, relay_streams_max: 256, relay_streams_per_chat: 64, signals_unacked: 256, batches_unacked_per_chat: 4, frame_bytes_max: 1048576,
    });
    // machine.settings follows every hello.ack.
    assert.strictEqual((await c.next('machine.settings')).settings.paused, false);
    c.ws.close();
    await c.closed;
  }
  fake.setWindow('refused');
  const r = await openLink(fake);
  await authenticate(fake, r, machine, key);
  const refused = await hello(r);
  assert.strictEqual(refused.kind, 'hello.refused');
  assert.deepStrictEqual([refused.compat.state, refused.compat.protocol], ['refused', null]);
  assert.strictEqual((await r.closed).code, 4426);

  // Ranges that do not meet are refused whatever the window says.
  fake.setWindow('ok');
  const p = await openLink(fake);
  await authenticate(fake, p, machine, key);
  assert.strictEqual((await hello(p, { protocol: { min: 2, max: 3 } })).kind, 'hello.refused');
  assert.strictEqual((await p.closed).code, 4426);

  // compat.update carries a later verdict.
  const up = await connect(fake, machine, key);
  fake.compatUpdate('behind');
  assert.strictEqual((await up.next('compat.update')).compat.state, 'behind');
});

test('a second authenticated link closes the first with 4409', async (t) => {
  const { fake, key, machine } = await paired(t);
  const first = await connect(fake, machine, key);
  const second = await openLink(fake);
  assert.strictEqual((await authenticate(fake, second, machine, key)).kind, 'auth.ok');
  assert.strictEqual((await first.closed).code, 4409);
});

// ── liveness ───────────────────────────────────────────────────────────────
test('liveness: pings every heartbeat_ms, silence stops every frame, drop is 1006, a silent client is closed 4408', async (t) => {
  const SCALE = 50;
  const asked = { interval: [], timeout: [] };
  const timers = {
    setTimeout: (fn, ms) => { asked.timeout.push(ms); return setTimeout(fn, ms / SCALE); },
    clearTimeout,
    setInterval: (fn, ms) => { asked.interval.push(ms); return setInterval(fn, ms / SCALE); },
    clearInterval,
  };
  const { fake, key, machine } = await paired(t, { heartbeatMs: 5000, deadAfterMs: 15000, challengeTtlMs: 60000, timers });
  const c = await connect(fake, machine, key);
  assert.deepStrictEqual([c.ack.heartbeat_ms, c.ack.dead_after_ms], [5000, 15000]);
  const beat = example('05-heartbeat').beat;
  const beating = setInterval(() => c.send({ ch: 'control', kind: 'heartbeat', beat: { ...beat, machine_id: machine.id, interval_ms: 5000 } }), 40);
  t.after(() => clearInterval(beating));

  await c.next('ping', 3, 3000);
  assert.ok(asked.interval.includes(5000), `intervals asked: ${asked.interval}`);
  assert.ok(asked.timeout.includes(15000), `timeouts asked: ${asked.timeout}`);

  fake.silence(true);
  const before = c.frames.length;
  await new Promise((r) => setTimeout(r, 400));   // four ping periods: the assertion is that nothing came
  assert.strictEqual(c.frames.length, before);
  const heldPings = fake.find('ping', { dir: 'out' }).length;
  fake.silence(false);
  await waitUntil(() => c.count('ping') >= heldPings, { timeout: 2000, what: 'the held pings' });

  fake.drop();
  assert.strictEqual((await c.closed).code, 1006);
  clearInterval(beating);

  const quiet = await connect(fake, machine, key);
  assert.strictEqual((await quiet.closed).code, 4408);
  assert.strictEqual((await fake.links[fake.links.length - 1].closed).code, 4408);
});

// ── relays ─────────────────────────────────────────────────────────────────
// The client's side of C-05.22's credit: it grants what it read only after a
// quiet 20 ms, so a fake that sent past its credit is caught (the bytes arrive
// before any grant could have reached it). Violations are kept for the test to
// assert, never thrown inside a socket listener.
function creditMeter(c, violations) {
  const meters = new Map();
  return (stream, bytes, { grant = true } = {}) => {
    if (!meters.has(stream)) meters.set(stream, { received: 0, granted: CREDIT, owed: 0, timer: null });
    const m = meters.get(stream);
    m.received += bytes;
    if (m.received > m.granted) violations.push(`stream ${stream}: ${m.received} bytes on ${m.granted} of credit`);
    if (!grant || !bytes) return;
    m.owed += bytes;
    clearTimeout(m.timer);
    m.timer = setTimeout(() => {
      m.granted += m.owed;
      c.send({ ch: 'relay', kind: 'relay.window', stream, bytes: m.owed });
      m.owed = 0;
    }, 20);
  };
}

// The connector's half, stubbed: echoes a relayed request's body as its
// response, taking and granting credit as C-05.22 says.
function echoHttp(c, violations) {
  const meter = creditMeter(c, violations);
  const streams = new Map();
  const pump = (id) => {
    const s = streams.get(id);
    if (!s.out) return;
    while (s.out.off < s.out.buf.length && s.credit > 0) {
      const n = Math.min(CHUNK, s.credit, s.out.buf.length - s.out.off);
      const piece = s.out.buf.subarray(s.out.off, s.out.off + n);
      s.out.off += n;
      s.credit -= n;
      c.send({ ch: 'relay', kind: 'relay.http.body', stream: id, body: piece.toString('base64'), end: s.out.off === s.out.buf.length });
    }
  };
  const take = (id, b64, end) => {
    const s = streams.get(id);
    if (b64) {
      const b = Buffer.from(b64, 'base64');
      meter(id, b.length, { grant: !end });
      s.parts.push(b);
    }
    if (end) {
      s.out = { buf: Buffer.concat(s.parts), off: 0 };
      c.send({ ch: 'relay', kind: 'relay.http.response', re: s.req.id, stream: id, status: 200, headers: { 'content-type': 'application/octet-stream' }, end: s.out.buf.length === 0 });
      pump(id);
    }
  };
  c.on((f) => {
    if (f.kind === 'relay.http.request') {
      streams.set(f.stream, { req: f, parts: [], credit: CREDIT, out: null });
      take(f.stream, f.body, f.end);
    } else if (f.kind === 'relay.http.body') take(f.stream, f.body, f.end);
    else if (f.kind === 'relay.window' && streams.has(f.stream)) {
      streams.get(f.stream).credit += f.bytes;
      pump(f.stream);
    }
  });
  return streams;
}

test('relayHttp: 600 KiB up and back across credit windows, byte for byte', async (t) => {
  const { fake, key, machine } = await paired(t);
  const c = await connect(fake, machine, key);
  const violations = [];
  const streams = echoHttp(c, violations);
  const chat = fake.mintLabel();
  const sent = crypto.randomBytes(600 * 1024);
  const res = await fake.relayHttp({ chat, method: 'POST', path: '/api/store', headers: { 'content-type': 'application/octet-stream' }, body: sent });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'application/octet-stream');
  assert.ok(res.body.equals(sent), 'the response is the exact bytes the client streamed');
  assert.deepStrictEqual(violations, [], 'the fake never sent past the client\'s credit');
  const req = streams.values().next().value.req;
  assert.strictEqual(req.chat, chat);
  assert.strictEqual(req.surface, 'session');
  assert.ok(req.decision && !req.decision_ref);
  assert.ok(fake.find('relay.http.body', { dir: 'out' }).length >= 2, 'the request body went in pieces');
  assert.ok(fake.find('relay.window', { dir: 'out' }).length >= 2, 'the fake granted credit as it read');
  assert.ok(fake.find('relay.window', { dir: 'in' }).length >= 2, 'the fake waited for the client\'s credit');
  for (const e of fake.find('relay.http.body', { dir: 'out' })) assert.ok(Buffer.from(e.frame.body, 'base64').length <= CHUNK);

  // A decision sent ahead and named by reference.
  const d = fake.decision({ chat, daemon_level: 'read' });
  const ref = fake.sendDecision(d);
  const small = await fake.relayHttp({ chat, path: '/api/health', decisionRef: ref });
  assert.strictEqual(small.body.length, 0);
  assert.deepStrictEqual([...streams.values()][1].req.decision_ref, { decision_id: d.decision_id, version: 1 });
});

test('relayWs: a 300 KiB text message goes in fragments with more; the client\'s fragments are reassembled', async (t) => {
  const { fake, key, machine } = await paired(t);
  const c = await connect(fake, machine, key);
  const got = [];
  let frag = [];
  const violations = [];
  const meter = creditMeter(c, violations);
  c.on((f) => {
    if (f.kind === 'relay.ws.open') c.send({ ch: 'relay', kind: 'relay.ws.opened', re: f.id, stream: f.stream });
    if (f.kind === 'relay.ws.data') {
      const b = f.binary ? Buffer.from(f.data, 'base64') : Buffer.from(f.data, 'utf8');
      frag.push(f);
      meter(f.stream, b.length);
      if (!f.more) { got.push(frag); frag = []; }
    }
  });
  const chat = fake.mintLabel();
  const viewer = fake.relayWs({ chat, userAgent: 'test-viewer' });
  assert.strictEqual(await viewer.opened, true);
  assert.strictEqual(await viewer.refused, null);

  // 300 KiB of UTF-8 with 3- and 4-byte code points; the one-byte lead puts
  // byte 262144 (the first credit window, one CHUNK) inside a 4-byte code point,
  // so the first fragment must be cut short at the code point before it.
  const text = `x${'a€😀'.repeat(38400)}`;
  viewer.send(text);
  await waitUntil(() => got.length === 1, { timeout: 5000, what: 'the reassembled message' });
  const frags = got[0];
  assert.ok(frags.length >= 2);
  assert.ok(Buffer.byteLength(frags[0].data) < CHUNK, 'the first fragment ends at a code point before the window');
  assert.ok(frags.slice(0, -1).every((f) => f.more === true && f.binary === false));
  assert.ok(frags.every((f) => Buffer.byteLength(f.data) <= CHUNK));
  assert.strictEqual(frags.map((f) => f.data).join(''), text);

  const bin = crypto.randomBytes(300 * 1024);
  viewer.send(bin);
  await waitUntil(() => got.length === 2, { timeout: 5000, what: 'the binary message' });
  assert.ok(Buffer.concat(got[1].map((f) => Buffer.from(f.data, 'base64'))).equals(bin));
  assert.deepStrictEqual(violations, [], 'the fake never sent past the client\'s credit');

  // The client's 300 KiB back, cut at a code point, the second fragment after credit.
  const back = '😀b€'.repeat(38400);
  const buf = Buffer.from(back, 'utf8');
  let cut = CHUNK;
  while ((buf[cut] & 0xc0) === 0x80) cut -= 1;
  const windowsBefore = fake.find('relay.window', { dir: 'out' }).length;
  c.send({ ch: 'relay', kind: 'relay.ws.data', stream: viewer.stream, binary: false, more: true, data: buf.subarray(0, cut).toString('utf8') });
  await waitUntil(() => fake.find('relay.window', { dir: 'out' }).length > windowsBefore, { timeout: 5000, what: 'the fake\'s credit' });
  c.send({ ch: 'relay', kind: 'relay.ws.data', stream: viewer.stream, binary: false, data: buf.subarray(cut).toString('utf8') });
  await waitUntil(() => viewer.messages.length === 1, { timeout: 5000, what: 'the fake reassembling' });
  assert.deepStrictEqual([viewer.messages[0].binary, viewer.messages[0].fragments], [false, 2]);
  assert.strictEqual(viewer.messages[0].data, back);

  c.send({ ch: 'relay', kind: 'relay.ws.close', stream: viewer.stream, code: 4403, reason: 'access changed' });
  assert.deepStrictEqual(await viewer.closed, { code: 4403, reason: 'access changed', by: 'connector' });

  // A refusal, and a viewer the lost link closes with 4502.
  c.hooks.unshift((f) => {
    if (f.kind === 'relay.ws.open' && f.user_agent === 'refuse-me') {
      c.send({ ch: 'relay', kind: 'relay.ws.refused', re: f.id, stream: f.stream, status: 502, body: { ok: false, remote: true, error: 'not answering' } });
    }
  });
  const refusedViewer = fake.relayWs({ chat, userAgent: 'refuse-me' });
  assert.strictEqual((await refusedViewer.refused).status, 502);
  assert.strictEqual(await refusedViewer.opened, false);
  const orphan = fake.relayWs({ chat });
  await orphan.opened;
  fake.drop();
  assert.strictEqual((await orphan.closed).code, 4502);
});

test('decisions fake.decision builds validate against 04-policy-decision.json under A-04.1', async (t) => {
  const { fake } = await paired(t);
  const chat = fake.mintLabel();
  for (const daemon_level of ['full', 'read', 'basic']) {
    const d = fake.decision({ chat, daemon_level, version: 3 });
    const v = validator.validateExample('04-policy-decision', d);
    assert.ok(v.ok, `${daemon_level}: ${JSON.stringify(v.errors)}`);
    assert.strictEqual(v.schema, '04-policy-decision');
    assert.ok(fake.checkDecision(d).ok);
    assert.strictEqual(d.origins.surface, `https://chat-${chat}.hub.test:8443`);
  }
  assert.ok(validator.view.schemas.get('04-policy-decision').file.startsWith('amendments/04-1/'));
  const d = fake.decision({ chat, expiresInMs: 60 * 1000 });
  assert.strictEqual(Date.parse(d.expires_at) - Date.parse(d.issued_at), 60 * 1000);
});

// ── queue delivery ─────────────────────────────────────────────────────────
function queueAck(c, deliverFrame, outcome = 'accepted') {
  const d = deliverFrame.delivery;
  c.send({
    ch: 'queue', kind: 'queue.ack', re: deliverFrame.id,
    ack: {
      type: 'queue.ack', hub_msg_id: d.hub_msg_id, chat_id: d.chat_id, attempt: d.attempt, outcome,
      daemon: { boot: '48302:1793181402551', msg_id: `m-${crypto.randomBytes(4).toString('hex')}`, item_id: 'q1', mode: 'queued' }, dedupe: 'daemon',
    },
  });
}

test('queue: held deliveries go out one at a time in order; a drop re-sends the unacknowledged one first; pause withholds', async (t) => {
  const { fake, key, machine } = await paired(t);
  const chat = fake.mintLabel();
  fake.assign({ chat });
  const held = [1, 2].map((n) => fake.queue.hold(chat, { message: { text: `message ${n}`, send: 'auto' } }));

  let c = await connect(fake, machine, key);
  assert.strictEqual((await c.next('chat.assign')).assignment.chat_id, chat);
  const first = await c.next('queue.deliver');
  assert.strictEqual(first.delivery.hub_msg_id, held[0].hub_msg_id);
  held.push(fake.queue.hold(chat, { message: { text: 'message 3', send: 'auto' } }));   // a hold re-runs the pump
  assert.deepStrictEqual(held.map((h) => h.hub_msg_id), [...held.map((h) => h.hub_msg_id)].sort(), 'ids sort in hold order');
  await new Promise((r) => setTimeout(r, 100));   // the assertion is that no second delivery comes before the ack
  assert.strictEqual(c.count('queue.deliver'), 1);
  queueAck(c, first);
  const second = await c.next('queue.deliver', 2);
  assert.strictEqual(second.delivery.hub_msg_id, held[1].hub_msg_id);

  // The link drops with the second unacknowledged.
  fake.drop();
  await c.closed;
  c = await connect(fake, machine, key);
  const again = await c.next('queue.deliver');
  assert.deepStrictEqual([again.delivery.hub_msg_id, again.delivery.attempt], [held[1].hub_msg_id, 2]);
  queueAck(c, again, 'duplicate');
  const third = await c.next('queue.deliver', 2);
  assert.strictEqual(third.delivery.hub_msg_id, held[2].hub_msg_id);
  queueAck(c, third);
  await waitUntil(() => fake.queue.delivered.length === 3, { timeout: 2000, what: 'three acks' });
  assert.deepStrictEqual(fake.queue.delivered.map((d) => [d.hub_msg_id, d.outcome]), [
    [held[0].hub_msg_id, 'accepted'], [held[1].hub_msg_id, 'duplicate'], [held[2].hub_msg_id, 'accepted'],
  ]);

  // Paused: a new hold waits, and goes when the pause lifts.
  fake.settings({ paused: true });
  assert.strictEqual((await c.next('machine.settings', 2)).settings.paused, true);
  const later = fake.queue.hold(chat);
  await new Promise((r) => setTimeout(r, 100));   // the assertion is that nothing is delivered while paused
  assert.strictEqual(c.count('queue.deliver'), 2);
  fake.settings({ paused: false });
  assert.strictEqual((await c.next('queue.deliver', 3)).delivery.hub_msg_id, later.hub_msg_id);
});

// ── events ─────────────────────────────────────────────────────────────────
test('events: a batch is answered with events.ack (or held), a derived signal with signals.ack', async (t) => {
  const { fake, key, machine } = await paired(t);
  const chat = fake.mintLabel();
  fake.assign({ chat });
  const c = await connect(fake, machine, key);
  const batch = (n) => ({
    type: 'events.batch', batch_id: `b_${'0'.repeat(25)}${n}`, chat_id: chat, ring: 'main', boot: '48302:1793181402551', since: 10 * (n - 1),
    contiguous: true, entries: [{ seq: 10 * n, ts: 1793181402551, kind: 'graph' }],
  });
  c.send({ ch: 'events', kind: 'events.batch', batch: batch(1) });
  const ack = await c.next('events.ack');
  assert.deepStrictEqual([ack.ack.batch_id, ack.ack.cursor.seq, ack.ack.ingested], [batch(1).batch_id, 10, 1]);

  fake.events.manualAck = true;
  c.send({ ch: 'events', kind: 'events.batch', batch: batch(2) });
  await fake.waitFor('events.batch', { count: 2 });
  assert.strictEqual(c.count('events.ack'), 1);
  assert.strictEqual(fake.events.ack(), 1);
  assert.strictEqual((await c.next('events.ack', 2)).ack.cursor.seq, 20);

  const signal = c.send({ ch: 'events', kind: 'turn.begun', chat, boot: '48302:1793181402551', daemon_seq: 21, daemon_at: 1793181402551, author: 'user' });
  assert.strictEqual((await c.next('signals.ack')).up_to, signal.seq);

  // The cursor rides the next chat.assign.
  fake.drop();
  await c.closed;
  const c2 = await connect(fake, machine, key);
  assert.strictEqual((await c2.next('chat.assign')).cursor.seq, 20);
});

// ── hub.request ────────────────────────────────────────────────────────────
test('hub.request: the three types each get exactly one hub.response; GetChat closes the link 4400 after a fatal bad_frame', async (t) => {
  const { fake, key, machine } = await paired(t);
  const c = await connect(fake, machine, key);
  const asks = [
    { type: 'ListMachines', params: {} },
    { type: 'ListChats', params: {} },
    { type: 'GetChatAttach', params: { chat_id: 'cht_01jbz9a1b2c3d4e5f6g7h8j9k0' } },
  ];
  const sent = asks.map((request) => c.send({ ch: 'control', kind: 'hub.request', request }));
  await c.next('hub.response', 3);
  await new Promise((r) => setTimeout(r, 50));   // the assertion is that no fourth answer comes
  const answers = c.frames.filter((f) => f.kind === 'hub.response');
  assert.strictEqual(answers.length, 3);
  for (const [i, s] of sent.entries()) {
    const mine = answers.filter((a) => a.re === s.id);
    assert.strictEqual(mine.length, 1, `${asks[i].type}: one answer`);
    assert.deepStrictEqual([mine[0].response.ok, mine[0].response.type], [true, asks[i].type]);
    assert.ok(validator.ajv.getSchema('https://web-chat-contracts/schemas/10-hub-request.json')(mine[0].response));
  }
  assert.strictEqual(answers.find((a) => a.response.type === 'ListMachines').response.result.machines[0].machine_id, machine.id);

  // A result the test sets, and an error.
  fake.hubRequests.set('ListChats', { chats: [] });
  const set = c.send({ ch: 'control', kind: 'hub.request', request: { type: 'ListChats', params: {} } });
  assert.deepStrictEqual((await c.next('hub.response', 4)).response.result, { chats: [] });
  assert.strictEqual(c.frames.filter((f) => f.kind === 'hub.response')[3].re, set.id);
  assert.throws(() => fake.hubRequests.set('GetChat', {}), /three/);

  const bad = c.send({ ch: 'control', kind: 'hub.request', request: { type: 'GetChat', params: {} } });
  const err = await c.next('control.error');
  assert.deepStrictEqual([err.code, err.fatal, err.re], ['bad_frame', true, bad.id]);
  assert.strictEqual((await c.closed).code, 4400);
  const taken = fake.takeErrors();
  assert.deepStrictEqual(taken.map((e) => [e.dir, e.kind]), [['in', 'hub.request']]);
});

// ── the record and validation ──────────────────────────────────────────────
test('validation: a bad client frame lands in fake.errors and assertClean names it; every frame the fake sent validated', async (t) => {
  const { fake, key, machine } = await paired(t);
  const chat = fake.mintLabel();
  fake.assign({ chat });
  fake.queue.hold(chat);
  const c = await connect(fake, machine, key);
  await c.next('queue.deliver');
  const beat = example('05-heartbeat').beat;
  c.send({ ch: 'control', kind: 'heartbeat', beat: { ...beat, machine_id: machine.id }, extra: true });
  await fake.waitFor('heartbeat');
  assert.strictEqual(fake.errors.length, 1);
  assert.deepStrictEqual([fake.errors[0].dir, fake.errors[0].kind], ['in', 'heartbeat']);
  assert.match(fake.errors[0].message, /extra/);
  assert.throws(() => fake.assertClean(), /in heartbeat .*extra/s);
  fake.takeErrors();
  assert.doesNotThrow(() => fake.assertClean());

  // An unknown kind on a known channel is non-fatal; a seq jump is fatal.
  c.send({ ch: 'control', kind: 'machine.dance' });
  assert.strictEqual((await c.next('control.error')).code, 'unknown_kind');
  c.seq.control += 5;
  c.send({ ch: 'control', kind: 'heartbeat', beat: { ...beat, machine_id: machine.id } });
  const gap = await c.next('control.error', 2);
  assert.deepStrictEqual([gap.code, gap.fatal], ['seq_gap', true]);
  assert.strictEqual((await c.closed).code, 4400);
  assert.deepStrictEqual(fake.takeErrors().map((e) => e.kind), ['machine.dance', 'heartbeat']);

  const out = fake.frames.filter((e) => e.dir === 'out');
  assert.ok(out.length > 5);
  assert.ok(out.every((e) => e.ok), 'every frame the fake sent validated');
  assert.ok(!fake.frames.some((e) => /update|restart|command/.test(String(e.kind))), 'no update, restart or command frame');
});

test('a frame above 1 MiB is a fatal too_large and 4400', async (t) => {
  const { fake, key, machine } = await paired(t);
  const c = await connect(fake, machine, key);
  c.send({ ch: 'control', kind: 'machine.facts', hostname: 'x'.repeat(1024 * 1024 + 10) });
  const err = await c.next('control.error');
  assert.deepStrictEqual([err.code, err.fatal, err.re], ['too_large', true, undefined]);
  assert.strictEqual((await c.closed).code, 4400);
  assert.strictEqual(fake.takeErrors().length, 1);
});

test('revoke: machine.revoked then 4403, and the machine is refused after', async (t) => {
  const { fake, key, machine } = await paired(t);
  const c = await connect(fake, machine, key);
  fake.revoke();
  await c.next('machine.revoked');
  assert.strictEqual((await c.closed).code, 4403);
  const again = await openLink(fake);
  assert.strictEqual((await authenticate(fake, again, machine, key)).reason, 'machine_revoked');
  assert.strictEqual((await again.closed).code, 4403);
});

// ── the source cursor's counters (contract 07 C-07.12a; PQ-6A3-2) ─────────
// The real hub keeps capture_seq and element_seq across a boot change and sets
// them to 0 only on a batch carrying reinit (ServerWebChat lib/ingest/batch.js
// plan()); element_reset on a new boot's batch sets element_seq alone to 0.
const COUNTED = (chat) => ({ type: 'source', chat_id: chat, ring: 'main', boot: 'boot-a', seq: 40, capture_seq: 5, element_seq: 30 });
const newBootBatch = (chat, n, extra = {}) => ({
  type: 'events.batch', batch_id: `b_${'0'.repeat(25)}${n}`, chat_id: chat, ring: 'main', boot: 'boot-b', since: 0,
  contiguous: false, gap: { gap: true, dropped: 0, oldest: 1, reset: true }, entries: [{ seq: 1, ts: 1793181402551, kind: 'graph' }], ...extra,
});

test('the cursor: a boot change keeps capture_seq and element_seq (C-07.12a); seq starts again in the new boot', async (t) => {
  const { fake, key, machine } = await paired(t);
  const chat = fake.mintLabel();
  fake.assign({ chat }, { cursor: COUNTED(chat) });
  const c = await connect(fake, machine, key);
  assert.strictEqual((await c.next('chat.assign')).cursor.capture_seq, 5);
  c.send({ ch: 'events', kind: 'events.batch', batch: newBootBatch(chat, 1) });
  const { cursor } = (await c.next('events.ack')).ack;
  assert.deepStrictEqual([cursor.boot, cursor.seq, cursor.capture_seq, cursor.element_seq], ['boot-b', 1, 5, 30], 'the counters survive the boot change');
  assert.deepStrictEqual(fake.takeErrors(), []);
});

test('the cursor: a batch carrying reinit sets capture_seq and element_seq to 0; element_reset alone sets element_seq to 0', async (t) => {
  const { fake, key, machine } = await paired(t);
  const chat = fake.mintLabel();
  fake.assign({ chat }, { cursor: COUNTED(chat) });
  const c = await connect(fake, machine, key);
  await c.next('chat.assign');
  c.send({ ch: 'events', kind: 'events.batch', batch: newBootBatch(chat, 1, { reinit: true }) });
  const { cursor } = (await c.next('events.ack')).ack;
  assert.deepStrictEqual([cursor.boot, cursor.capture_seq, cursor.element_seq], ['boot-b', 0, 0], 'reinit: both counters to 0');

  const other = fake.mintLabel();
  fake.assign({ chat: other }, { cursor: COUNTED(other) });
  await c.next('chat.assign', 2);
  c.send({ ch: 'events', kind: 'events.batch', batch: newBootBatch(other, 2, { element_reset: true }) });
  const second = (await c.next('events.ack', 2)).ack.cursor;
  assert.deepStrictEqual([second.capture_seq, second.element_seq], [5, 0], 'element_reset: element_seq alone');
  assert.deepStrictEqual(fake.takeErrors(), []);
});

// The real hub reads both flags only on a batch of a boot it does not hold
// (plan(): reinit is the gap reason of a boot change, element_reset needs
// !sameBoot): on a batch of the held boot they change nothing.
test('the cursor: reinit or element_reset on a batch of the boot the cursor already holds changes neither counter', async (t) => {
  const { fake, key, machine } = await paired(t);
  const sameBootBatch = (chat, n, extra) => ({
    type: 'events.batch', batch_id: `b_${'0'.repeat(25)}${n}`, chat_id: chat, ring: 'main', boot: 'boot-a', since: 40,
    contiguous: true, entries: [{ seq: 41, ts: 1793181402551, kind: 'graph' }], ...extra,
  });
  const c = await connect(fake, machine, key);
  const flags = [{ reinit: true }, { element_reset: true }];
  for (let i = 0; i < flags.length; i++) {
    const chat = fake.mintLabel();
    fake.assign({ chat }, { cursor: COUNTED(chat) });
    await c.next('chat.assign', i + 1);
    c.send({ ch: 'events', kind: 'events.batch', batch: sameBootBatch(chat, i + 1, flags[i]) });
    const { cursor } = (await c.next('events.ack', i + 1)).ack;
    assert.deepStrictEqual([cursor.boot, cursor.seq, cursor.capture_seq, cursor.element_seq], ['boot-a', 41, 5, 30], `${Object.keys(flags[i])[0]} on the held boot: the counters stay`);
  }
  assert.deepStrictEqual(fake.takeErrors(), []);
});

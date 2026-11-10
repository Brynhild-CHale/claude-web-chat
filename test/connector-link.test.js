'use strict';

// lib/connector/link.js (tranche 6, U716) against the fake hub
// (test-support/fake-hub.js, U735): contract 05's link — dial, auth and
// rotation, hello with the versions record, compat, heartbeats, close codes
// and backoff, flow control, the channel seam and the secrets guard. The fake
// validates every frame both ways against the locked schemas and fails the
// test (withFakeHub's t.after) on any that does not pass.
//
// TIME. The link's timers and random source are injected: each test runs the
// 05 cadence (15 s beats, 45 s dead, backoff, 15-minute slow) in virtual time
// through `clock()` below, while the fake runs on real timers and the wire
// carries the contracted values.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { withFakeHub } = require('../test-support/fake-hub');
const { createValidator } = require('../test-support/contracts-loader');
const { waitUntil } = require('../test-support/helpers');
const {
  createLink, dialUrl, closeAction, backoffDelay, slowDelay, CAPABILITIES, SLOW_MS, BACKOFF_CAP_MS,
} = require('../lib/connector/link');
const { hubOrigin, newRecord, keyIdOf, fingerprintOf, writeRecord, readRecord } = require('../lib/setup/connector');
const { versionsRecord, machineFacts } = require('../lib/connector/facts');
const { TABLE_VERSION, TABLE_SHA256 } = require('../lib/core/connected-policy');
const { userPaths } = require('../lib/core/paths');

const validator = createValidator({ folders: 'all' });
const VERSIONS_DEF = 'https://web-chat-contracts/schemas/12-compat.json#/$defs/versions';
const MiB = 1024 * 1024;

// ── a virtual clock ────────────────────────────────────────────────────────
function clock(start = 1793181400000) {
  let t = 0;
  let n = 0;
  const q = new Map();
  const add = (fn, ms, every) => { const id = ++n; q.set(id, { at: t + Math.max(0, ms), fn, every }); return id; };
  const timers = {
    setTimeout: (fn, ms) => add(fn, ms, null),
    clearTimeout: (id) => { q.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)),
    clearInterval: (id) => { q.delete(id); },
  };
  return {
    timers,
    now: () => start + t,
    get elapsed() { return t; },
    pending: () => [...q.values()].map((e) => e.at - t),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let id = null;
        let next = null;
        for (const [k, e] of q) if (e.at <= end && (!next || e.at < next.at)) { id = k; next = e; }
        if (!next) break;
        t = next.at;
        if (next.every) next.at = t + next.every; else q.delete(id);
        next.fn();
      }
      t = end;
    },
  };
}

// ── a machine the fake knows, and its record ───────────────────────────────
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
  return { privateKey, raw, machine: m, record };
}

function openLink(t, fake, opts = {}) {
  const m = opts.machine || machineOn(fake);
  const vt = opts.clock || clock();
  const logs = [];
  const settings = [];
  const written = [];
  const link = createLink({
    record: m.record,
    key: m.privateKey,
    versions: () => versionsRecord({ claudeVersion: null }),
    facts: () => machineFacts({ record: m.record, names: { mcp_servers: [], skills: [] }, hostname: 'test-host', login: 'tester' }),
    routeTable: () => ({ table_version: TABLE_VERSION, sha256: TABLE_SHA256 }),
    onSettings: (s) => settings.push(s),
    log: (line) => logs.push(line),
    timers: vt.timers,
    random: opts.random || (() => 0.5),
    now: vt.now,
    ...(opts.writeKey === undefined ? { writeKey: (k) => written.push(k) } : opts.writeKey ? { writeKey: opts.writeKey } : {}),
  });
  t.after(() => link.stop());
  return { link, vt, logs, settings, written, m };
}

const ready = (link) => once(link, 'ready');
const closed = (link) => once(link, 'closed').then(([c]) => c);

// ── dial ───────────────────────────────────────────────────────────────────
test('the dial URL comes from the record origin alone: https → wss, loopback http → ws, anything else throws before a socket', async (t) => {
  assert.strictEqual(dialUrl('https://hub.test:8443'), 'wss://hub.test:8443/connector');
  assert.strictEqual(dialUrl('https://hub.example.com'), 'wss://hub.example.com/connector');
  assert.strictEqual(dialUrl('http://127.0.0.1:41234'), 'ws://127.0.0.1:41234/connector');
  assert.strictEqual(dialUrl('http://localhost:9'), 'ws://localhost:9/connector');
  for (const bad of ['http://10.0.0.1:1', 'ftp://127.0.0.1', 'http://hub.example.com', 'wss://hub.test', 'https://hub.test/x', 'https://u:p@hub.test', 'nope']) {
    assert.throws(() => dialUrl(bad), (e) => e.code === 'EHUBORIGIN', bad);
  }
  const fake = await withFakeHub(t);
  const m = machineOn(fake);
  for (const origin of ['http://10.0.0.1:1', 'ftp://127.0.0.1']) {
    const record = { ...m.record, hub: { ...m.record.hub, origin } };
    assert.throws(() => createLink({ record, key: m.privateKey, versions: () => ({}), facts: () => ({}), routeTable: () => ({}) }),
      (e) => e.code === 'EHUBORIGIN', origin);
  }
  assert.strictEqual(fake.links.length, 0, 'no socket ever opened');
});

test('auth, hello and facts: the fake verifies the signature; hello carries the versions record, the route table and the capabilities; machine.facts follows hello.ack', async (t) => {
  const fake = await withFakeHub(t);
  const { link, vt, logs, settings, m } = openLink(t, fake);
  const up = ready(link);
  link.start();
  const info = (await up)[0];
  assert.strictEqual(link.state, 'up');
  assert.strictEqual(info.hub.id, 'hub-test');
  assert.strictEqual(info.hub.origin, fake.origin, 'hello.ack hub.origin is kept as information');
  assert.strictEqual(link.url, fake.wsUrl, 'and never replaces the origin dialled');
  assert.match(fake.links[0].userAgent, /^claude-web-chat-connector\/\S+$/);
  assert.strictEqual(fake.links[0].host, new URL(m.record.hub.origin).host);

  const [resp] = fake.find('auth.response', { dir: 'in' });
  assert.strictEqual(resp.frame.key_id, keyIdOf(m.raw));
  assert.strictEqual(resp.frame.public_key, m.raw.toString('base64url'));
  assert.strictEqual(fake.link.state, 'up', 'the fake took the signature');

  const [hello] = fake.find('hello', { dir: 'in' });
  assert.ok(validator.ajv.getSchema(VERSIONS_DEF)(hello.frame.versions), JSON.stringify(validator.ajv.getSchema(VERSIONS_DEF).errors));
  assert.deepStrictEqual(hello.frame.route_table, { table_version: TABLE_VERSION, sha256: TABLE_SHA256 });
  assert.deepStrictEqual(hello.frame.capabilities, [...CAPABILITIES]);

  // One for hello.ack, one answering the machine.settings the fake sends after it.
  await fake.waitFor('machine.facts', { count: 2 });
  assert.strictEqual(fake.find('machine.settings', { dir: 'out' }).length, 1);
  assert.strictEqual(fake.find('machine.facts', { dir: 'in' }).length, 2);
  const at =(kind, dir) => fake.frames.findIndex((e) => e.kind === kind && e.dir === dir);
  assert.ok(at('machine.facts', 'in') > at('hello.ack', 'out'), 'machine.facts after hello.ack');
  const helloAt = at('hello', 'in');
  const before = fake.frames.slice(0, at('hello.ack', 'out')).filter((e) => e.dir === 'in' && fake.frames.indexOf(e) > helloAt);
  assert.ok(before.every((e) => e.kind === 'heartbeat'), 'only a heartbeat may precede the answer');

  // A ping, then a beat that echoes its at, in virtual time.
  const ping = fake.send({ ch: 'control', kind: 'ping' });
  const applied = settings.length;
  fake.settings({ paused: false });   // a frame behind the ping: once it is applied, so is the ping
  await waitUntil(() => settings.length > applied, { what: 'the frame behind the ping' });
  vt.advance(15000);
  const beat = await fake.waitFor('heartbeat');
  assert.strictEqual(beat.frame.beat.interval_ms, 15000);
  assert.strictEqual(beat.frame.beat.machine_id, m.machine.id);
  assert.strictEqual(beat.frame.beat.echo_at, ping.at);
  assert.deepStrictEqual(beat.frame.beat.chats, []);
  assert.ok(logs.every((l) => !l.includes(resp.frame.signature)), 'no signature in a log line');
});

test('machine.settings: applied, answered with machine.facts; an older rev is ignored', async (t) => {
  const fake = await withFakeHub(t);
  const { link, settings } = openLink(t, fake);
  const up = ready(link);
  link.start();
  await up;
  await waitUntil(() => settings.length === 1, { what: 'the first settings' });
  const facts1 = fake.find('machine.facts', { dir: 'in' }).length;
  fake.settings({ paused: true });
  await waitUntil(() => settings.length === 2, { what: 'the changed settings' });
  assert.strictEqual(settings[1].paused, true);
  await fake.waitFor('machine.facts', { count: facts1 + 1 });
  fake.send({ ch: 'control', kind: 'machine.settings', settings: { ...fake.currentSettings, rev: 0 } });
  fake.send({ ch: 'control', kind: 'ping' });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(settings.length, 2, 'rev 0 is older than rev 2');
});

// ── compat ─────────────────────────────────────────────────────────────────
test('compat: ok, ahead and behind keep the link up with link.compat the verdict; compat.update replaces it', async (t) => {
  const fake = await withFakeHub(t);
  for (const state of ['ok', 'ahead', 'behind']) {
    fake.setWindow(state);
    const { link } = openLink(t, fake);
    const up = ready(link);
    link.start();
    await up;
    assert.strictEqual(link.compat.state, state);
    assert.strictEqual(link.state, 'up');
    assert.strictEqual(link.needsUpdate, false);
    if (state === 'ok') {
      const seen = once(link, 'compat');
      fake.compatUpdate('behind');
      assert.strictEqual((await seen)[0].state, 'behind');
      assert.strictEqual(link.compat.state, 'behind');
      assert.strictEqual(link.state, 'up');
    }
    await link.stop();
  }
});

test('compat refused: hello.refused, close 4426, slow backoff (15 min ± 20%), never an exit', async (t) => {
  const fake = await withFakeHub(t);
  fake.setWindow('refused');
  const { link, vt } = openLink(t, fake, { random: () => 0.99 });
  const shut = closed(link);
  link.start();
  const c = await shut;
  assert.strictEqual(c.code, 4426);
  assert.strictEqual(c.action, 'slow');
  assert.ok(c.delayMs >= SLOW_MS * 0.8 && c.delayMs <= SLOW_MS * 1.2, String(c.delayMs));
  assert.strictEqual(link.compat.state, 'refused');
  assert.strictEqual(link.needsUpdate, true);
  assert.strictEqual(link.state, 'backoff');
  assert.strictEqual((await fake.links[0].closed).code, 4426);
  vt.advance(c.delayMs - 1);
  assert.strictEqual(fake.links.length, 1, 'not before the slow delay');
  fake.setWindow('ok');
  const up = ready(link);
  vt.advance(1);
  await up;
  assert.strictEqual(link.needsUpdate, false);
  assert.strictEqual(link.compat.state, 'ok');
});

// ── liveness and close codes ───────────────────────────────────────────────
test('the fake goes silent: after dead_after_ms of virtual time the link closes 4408 and redials at once', async (t) => {
  const fake = await withFakeHub(t);
  const { link, vt } = openLink(t, fake);
  let up = ready(link);
  link.start();
  await up;
  fake.silence(true);
  const shut = closed(link);
  vt.advance(44999);
  assert.strictEqual(link.state, 'up');
  vt.advance(1);
  const c = await shut;
  assert.deepStrictEqual([c.code, c.action, c.delayMs], [4408, 'redial', 0]);
  assert.strictEqual((await fake.links[0].closed).code, 4408);
  await waitUntil(() => fake.links.length === 2, { what: 'the redial' });
  // "Redial at once, then normal backoff": the redial that never came up is
  // not redialled at once again.
  const again = closed(link);
  fake.close(4440, undefined, fake.links[1]);
  const c2 = await again;
  assert.deepStrictEqual([c2.code, c2.action], [4440, 'normal']);
  up = ready(link);
  fake.silence(false);
  vt.advance(c2.delayMs);
  await up;
  assert.strictEqual(fake.links.length, 3);
});

test('any inbound frame resets the dead timer: a frame 30 s in keeps the link up past 45 s from hello.ack', async (t) => {
  const fake = await withFakeHub(t);
  const { link, vt, settings } = openLink(t, fake);
  const up = ready(link);
  link.start();
  await up;
  await waitUntil(() => settings.length === 1, { what: 'the settings after hello.ack' });
  vt.advance(30000);
  const applied = settings.length;
  fake.settings({ paused: false });
  await waitUntil(() => settings.length > applied, { what: 'a frame 30 s after hello.ack' });
  vt.advance(30000);
  assert.strictEqual(link.state, 'up', '60 s after hello.ack, 30 s after the last frame: not dead');
  fake.silence(true);
  const shut = closed(link);
  vt.advance(15000);
  const c = await shut;
  assert.deepStrictEqual([c.code, c.action], [4408, 'redial']);
});

test('4429 waits at least 60 s before the next dial', async (t) => {
  const fake = await withFakeHub(t);
  const { link, vt } = openLink(t, fake);
  let up = ready(link);
  link.start();
  await up;
  const shut = closed(link);
  fake.close(4429);
  const c = await shut;
  assert.strictEqual(c.action, 'rate');
  assert.ok(c.delayMs >= 60000, String(c.delayMs));
  vt.advance(59999);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fake.links.length, 1, 'no dial before 60 s');
  up = ready(link);
  vt.advance(c.delayMs - 59999);
  await up;
  assert.strictEqual(fake.links.length, 2);
});

test('a dropped socket (1006) takes normal backoff with full jitter under min(60 s, 2^n s); an unnamed code too', async (t) => {
  const fake = await withFakeHub(t);
  const { link, vt } = openLink(t, fake, { random: () => 0.999 });
  let up = ready(link);
  link.start();
  await up;
  for (let n = 0; n < 3; n++) {
    const shut = closed(link);
    fake.drop();
    const c = await shut;
    assert.strictEqual(c.code, 1006);
    assert.strictEqual(c.action, 'normal');
    assert.ok(c.delayMs <= Math.min(BACKOFF_CAP_MS, 1000 * 2 ** n) && c.delayMs >= Math.min(BACKOFF_CAP_MS, 1000 * 2 ** n) * 0.99, `n=${n}: ${c.delayMs}`);
    up = ready(link);
    vt.advance(c.delayMs);
    await up;
  }
  const shut = closed(link);
  fake.close(4321);
  const c = await shut;
  assert.deepStrictEqual([c.code, c.action], [4321, 'normal']);
  // 60 s up resets n.
  up = ready(link);
  vt.advance(c.delayMs);
  await up;
  vt.advance(60000);
  const again = closed(link);
  fake.drop();
  assert.ok((await again).delayMs <= 1000, 'the attempt count reset after 60 s connected');
});

test('4409 stops without redialling; 4403 after machine.revoked emits revoked and stops for good', async (t) => {
  const fake = await withFakeHub(t);
  const a = openLink(t, fake);
  let up = ready(a.link);
  a.link.start();
  await up;
  const shut = closed(a.link);
  fake.close(4409);
  assert.deepStrictEqual([(await shut).code, (await shut).action], [4409, 'superseded']);
  a.vt.advance(30 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fake.links.length, 1, 'never redialled');
  assert.strictEqual(a.link.state, 'superseded');

  const b = openLink(t, fake);
  up = ready(b.link);
  b.link.start();
  await up;
  const revoked = once(b.link, 'revoked');
  fake.revoke();
  assert.deepStrictEqual((await revoked)[0], { afterNotice: true });
  assert.strictEqual(b.link.state, 'revoked');
  assert.strictEqual(b.link.start(), false, 'a revoked link never dials again');
  b.vt.advance(60 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fake.links.length, 2);
});

test("C-05.9's table as A-05.1 replaces it, and the delays", () => {
  const want = {
    1000: 'stop', 1001: 'normal', 1006: 'normal', 1009: 'normal', 1011: 'normal', 4400: 'normal', 4401: 'normal', 4403: 'revoked',
    4408: 'redial', 4409: 'superseded', 4423: 'slow', 4426: 'slow', 4429: 'rate', 4440: 'redial', 4503: 'normal', 4999: 'normal',
  };
  for (const [code, action] of Object.entries(want)) assert.strictEqual(closeAction(Number(code)), action, code);
  assert.strictEqual(backoffDelay(0, () => 0.999999), 999);
  assert.strictEqual(backoffDelay(10, () => 0.999999), 59999, 'capped at 60 s');
  assert.strictEqual(backoffDelay(3, () => 0), 0);
  assert.strictEqual(slowDelay(() => 0), SLOW_MS * 0.8);
  assert.strictEqual(slowDelay(() => 1), SLOW_MS * 1.2);
});

// ── rotation ───────────────────────────────────────────────────────────────
test('rotation: auth.ok rotate → key.rotate signed by both keys; key.rotated → the writer gets the PKCS#8 PEM and the new key id', async (t) => {
  // 03's test vector for the one id helper.
  const vector = validator.view.examples.get('03-credential-machine').data;
  assert.strictEqual(keyIdOf(Buffer.from(vector.public_key.value, 'base64url')), vector.key_id);

  const fake = await withFakeHub(t, { rotate: true });
  const { link, vt, written, m } = openLink(t, fake);
  const oldId = keyIdOf(m.raw);
  const rotated = once(link, 'rotated');
  let up = ready(link);
  link.start();
  await up;
  const [ev] = await rotated;
  const [rot] = fake.find('key.rotate', { dir: 'in' });
  assert.strictEqual(rot.frame.new_key_id, ev.keyId);
  const signed = Buffer.from(`web-chat-connector-rotate/1\n${fake.host}\n${m.machine.id}\n${ev.keyId}`);
  const pub = (wire) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: wire }, format: 'jwk' });
  assert.ok(crypto.verify(null, signed, pub(m.raw.toString('base64url')), Buffer.from(rot.frame.sig_old, 'base64url')));
  assert.ok(crypto.verify(null, signed, pub(rot.frame.new_public_key), Buffer.from(rot.frame.sig_new, 'base64url')));

  assert.strictEqual(written.length, 1);
  const w = written[0];
  const key = crypto.createPrivateKey(w.pem);
  assert.strictEqual(key.asymmetricKeyType, 'ed25519');
  assert.strictEqual(key.export({ type: 'pkcs8', format: 'pem' }), w.pem, 'the PEM is PKCS#8');
  const raw = Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
  assert.strictEqual(w.keyId, keyIdOf(raw));
  assert.strictEqual(w.fingerprint, fingerprintOf(raw));
  assert.strictEqual(w.publicKey, rot.frame.new_public_key);
  assert.strictEqual(w.hubId, 'hub-test');
  assert.strictEqual(fake.machine().key_id, ev.keyId);
  assert.strictEqual(fake.machine().retiring, oldId);
  assert.strictEqual(link.keyId, ev.keyId);

  // The next link signs with the new key.
  fake.options.rotate = false;
  const shut = closed(link);
  fake.drop();
  const c = await shut;
  up = ready(link);
  vt.advance(c.delayMs);
  await up;
  const auths = fake.find('auth.response', { dir: 'in' });
  assert.strictEqual(auths[auths.length - 1].frame.key_id, ev.keyId);
});

test('rotation: the link drops before key.rotated — the next auth uses the old key and auth.ok.key_id completes it', async (t) => {
  const fake = await withFakeHub(t, { rotate: true });
  const { link, vt, written, m } = openLink(t, fake);
  link.once('compat', () => fake.silence(true));   // hello.ack is in; hold key.rotated
  const first = closed(link);
  link.start();
  await fake.waitFor('key.rotate');
  const newId = fake.find('key.rotate', { dir: 'in' })[0].frame.new_key_id;
  assert.strictEqual(written.length, 0, 'no key.rotated reached the link');
  fake.drop();
  const c = await first;
  fake.silence(false);
  fake.options.rotate = false;
  const up = ready(link);
  vt.advance(c.delayMs);
  await up;
  const auths = fake.find('auth.response', { dir: 'in' });
  assert.strictEqual(auths[auths.length - 1].frame.key_id, keyIdOf(m.raw), 'signed with the old, retiring key');
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].keyId, newId);
  assert.strictEqual(link.keyId, newId);
});

test('rotation with the default writer: the key file atomically at 0600, then the record\'s key_id, public key and fingerprint', async (t) => {
  const fake = await withFakeHub(t, { rotate: true });
  const m = machineOn(fake);
  writeRecord(m.record);
  const { link } = openLink(t, fake, { machine: m, writeKey: null });
  const rotated = once(link, 'rotated');
  link.start();
  const [ev] = await rotated;
  assert.strictEqual(ev.written, true);
  const file = userPaths().connectorKey('hub-test');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const key = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
  const raw = Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
  const rec = readRecord('hub-test');
  assert.ok(rec.ok);
  assert.strictEqual(rec.value.credential.key_id, keyIdOf(raw));
  assert.strictEqual(rec.value.credential.key_id, ev.keyId);
  assert.strictEqual(rec.value.credential.public_key, raw.toString('base64url'));
  assert.strictEqual(rec.value.credential.fingerprint, fingerprintOf(raw));
  assert.strictEqual(rec.value.credential.state, 'paired');
  // The writer is lib/setup/connector.js writeMachineKey (U716b): it names the
  // key file in the record as it moves the key fields, under the record's lock.
  assert.strictEqual(rec.value.credential.key_file, file);
  assert.ok(!fs.existsSync(userPaths().connectorRecordLock('hub-test')), 'the record\'s lock released');
});

// ── frames ─────────────────────────────────────────────────────────────────
test('inbound malformed JSON, an unknown channel, a seq jump and a frame failing FRAME_SHAPES each answer control.error fatal and close 4400', async (t) => {
  const fake = await withFakeHub(t);
  const { link, vt } = openLink(t, fake);
  let up = ready(link);
  link.start();
  await up;
  const cases = [
    ['bad_frame', () => fake.link.ws.send('{"ch":"control",')],
    ['unknown_channel', () => fake.send({ ch: 'blobs', kind: 'blob.put' })],
    ['seq_gap', () => fake.link.ws.send(JSON.stringify({ ch: 'control', kind: 'ping', id: 'hz', seq: 999, at: 1 }))],
    ['bad_frame', () => fake.send({ ch: 'control', kind: 'ping', extra: true })],
    ['bad_frame', () => fake.send({ ch: 'control', kind: 'machine.settings', settings: 'paused' })],
  ];
  let n = 0;
  for (const [code, inject] of cases) {
    const linkNo = fake.links.length - 1;
    const shut = closed(link);
    inject();
    const err = await fake.waitFor('control.error', { count: ++n });
    assert.deepStrictEqual([err.frame.code, err.frame.fatal], [code, true], code);
    assert.strictEqual((await fake.links[linkNo].closed).code, 4400);
    const c = await shut;
    assert.deepStrictEqual([c.code, c.action], [4400, 'normal']);
    fake.takeErrors((e) => e.dir === 'out');   // the fake's own deliberate bad frames
    up = ready(link);
    vt.advance(c.delayMs);
    await up;
  }
});

test("an unknown kind on 'control' (connector.update) answers a non-fatal unknown_kind; nothing runs and the link stays up", async (t) => {
  const fake = await withFakeHub(t);
  const { link, settings } = openLink(t, fake);
  let ran = 0;
  link.channel('control', { kinds: ['connector.update'], handle: () => { ran++; } });
  const up = ready(link);
  link.start();
  await up;
  fake.send({ ch: 'control', kind: 'connector.update', version: '9.9.9' });
  const err = await fake.waitFor('control.error');
  assert.deepStrictEqual([err.frame.code, err.frame.fatal], ['unknown_kind', false]);
  fake.takeErrors((e) => e.dir === 'out' && e.kind === 'connector.update');
  const before = settings.length;
  fake.settings({ accept_new_chats: true });
  await waitUntil(() => settings.length > before, { what: 'a frame after the unknown kind' });
  assert.strictEqual(ran, 0);
  assert.strictEqual(link.state, 'up');
  assert.strictEqual(fake.links.length, 1);
});

test('the channel seam: a kind registered twice throws, the link\'s own kinds are refused, request() returns the answer by re', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = openLink(t, fake);
  const seen = [];
  link.channel('control', { kinds: ['chat.assign'], handle: (f, l) => seen.push([f.kind, l === link]) });
  assert.throws(() => link.channel('control', { kinds: ['chat.assign'], handle: () => {} }), /registered twice/);
  assert.throws(() => link.channel('control', { kinds: ['machine.settings'], handle: () => {} }), /link's own/);
  assert.throws(() => link.channel('blobs', { kinds: ['x.y'], handle: () => {} }), TypeError);
  const up = ready(link);
  link.start();
  await up;
  fake.assign({ chat: fake.mintLabel() });
  await waitUntil(() => seen.length === 1, { what: 'chat.assign' });
  assert.deepStrictEqual(seen[0], ['chat.assign', true]);
  const answer = await link.request('control', 'hub.request', { request: { type: 'ListMachines', params: {} } });
  assert.strictEqual(answer.kind, 'hub.response');
  assert.strictEqual(answer.response.ok, true);
  assert.strictEqual(answer.response.type, 'ListMachines');
});

// ── flow control ───────────────────────────────────────────────────────────
test('flow control: 256 streams per link and 64 per chat; credit waits for relay.window; past the credit aborts with window_exceeded; four batches per chat', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = openLink(t, fake);
  const opened = [];
  link.channel('relay', {
    kinds: ['relay.http.request'],
    handle: (f) => opened.push({ stream: f.stream, r: link.streams.open(f.stream, f.chat, { onEnd: (why) => opened.push({ ended: f.stream, why }) }) }),
  });
  const up = ready(link);
  link.start();
  await up;

  // The table, with stream ids of our own (the relay module opens the hub's).
  for (let i = 1000; i < 1064; i++) assert.ok(link.streams.open(i, 'chat-a').ok);
  assert.deepStrictEqual(link.streams.open(1064, 'chat-a'), { ok: false, reason: 'chat_full' });
  let id = 2000;
  for (const chat of ['chat-b', 'chat-c', 'chat-d']) for (let i = 0; i < 64; i++) assert.ok(link.streams.open(id++, chat).ok);
  assert.strictEqual(link.streams.count, 256);
  assert.deepStrictEqual(link.streams.open(id++, 'chat-e'), { ok: false, reason: 'link_full' });
  for (let i = 1000; i < 1064; i++) link.streams.close(i);
  for (let i = 2000; i < 2192; i++) link.streams.close(i);
  assert.strictEqual(link.streams.count, 0);

  // Credit: the hub's stream; 256 KiB at once, then a wait for relay.window.
  const chat = fake.mintLabel();
  fake.relayHttp({ chat, path: '/api/health' }).catch(() => {});
  await waitUntil(() => opened.length === 1, { what: 'the relayed request' });
  const s1 = opened[0].stream;
  assert.ok(opened[0].r.ok);
  assert.strictEqual(await link.streams.sendCredit(s1, 256 * 1024), 256 * 1024);
  let granted = false;
  const waiting = link.streams.sendCredit(s1, 1000).then(() => { granted = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(granted, false, 'no credit, no send');
  fake.send({ ch: 'relay', kind: 'relay.window', stream: s1, bytes: 1000 });
  await waiting;
  assert.strictEqual(granted, true);

  // Grant: relay.window goes out as the sink drains.
  link.streams.grant(s1, 4096);
  const win = await fake.waitFor('relay.window');
  assert.deepStrictEqual([win.frame.stream, win.frame.bytes], [s1, 4096]);

  // The hub past its credit.
  let rejected = null;
  fake.relayHttp({ chat, path: '/api/health' }).catch((e) => { rejected = e; });
  await waitUntil(() => opened.length >= 2 && opened.some((o) => o.stream !== s1 && o.r), { what: 'the second request' });
  const s2 = opened.find((o) => o.r && o.stream !== s1).stream;
  fake.send({ ch: 'relay', kind: 'relay.http.body', stream: s2, body: Buffer.alloc(256 * 1024 + 1, 7).toString('base64'), end: false });
  const abort = await fake.waitFor('relay.http.abort');
  assert.deepStrictEqual([abort.frame.stream, abort.frame.reason], [s2, 'window_exceeded']);
  await waitUntil(() => rejected, { what: 'the aborted relay' });
  assert.ok(opened.some((o) => o.ended === s2 && o.why === 'window_exceeded'));
  assert.strictEqual(link.streams.has(s2), false);

  // Ring batches: four unacknowledged per chat, then events.ack frees one.
  const ringChat = fake.mintLabel();
  for (let i = 0; i < 4; i++) assert.strictEqual(link.batchSlot(ringChat), true);
  assert.strictEqual(link.batchSlot(ringChat), false);
  assert.strictEqual(link.batchSlot(fake.mintLabel()), true, 'per chat');
  const ack = JSON.parse(JSON.stringify(validator.view.examples.get('05-event.ack').data.ack));
  ack.chat_id = ringChat;
  ack.cursor.chat_id = ringChat;
  fake.send({ ch: 'events', kind: 'events.ack', re: 'c1', ack });
  await waitUntil(() => link.batchSlot(ringChat), { what: 'the freed slot' });
  assert.strictEqual(link.batchSlot(ringChat), false);
});

test('the derived signals window: each signal sent takes a place, signals.ack frees every one up to its seq and no later one (C-05.24)', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = openLink(t, fake);
  const up = ready(link);
  link.start();
  await up;
  fake.events.holdSignals = true;
  assert.strictEqual(link.signalRoom(), 256);
  const { ch, kind, id, seq, at, re, ...body } = JSON.parse(JSON.stringify(validator.view.examples.get('05-event.turn-begun').data));
  for (let i = 0; i < 3; i++) assert.ok(link.send(ch, kind, body));
  assert.strictEqual(link.signalRoom(), 253);
  await waitUntil(() => fake.find(kind, { dir: 'in' }).length === 3, { what: 'three signals at the fake' });
  const seqs = fake.find(kind, { dir: 'in' }).map((e) => e.frame.seq);
  fake.send({ ch: 'events', kind: 'signals.ack', up_to: seqs[0] });
  await waitUntil(() => link.signalRoom() === 254, { what: 'the first signal acknowledged' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(link.signalRoom(), 254, 'the acknowledged seq is freed, the later two are not');
  fake.send({ ch: 'events', kind: 'signals.ack', up_to: seqs[2] });
  await waitUntil(() => link.signalRoom() === 256, { what: 'every signal acknowledged' });
  fake.takeErrors((e) => e.kind === kind);   // the fake has no such chat
});

test("hello.ack's values are checked by the link: windows capped at 256 streams per link and 64 per chat (C-05.23)", async (t) => {
  const fake = await withFakeHub(t, {
    windows: {
      relay_stream_bytes: 256 * 1024, relay_streams_max: 100000, relay_streams_per_chat: 100000,
      signals_unacked: 256, batches_unacked_per_chat: 4, frame_bytes_max: MiB,
    },
  });
  const { link } = openLink(t, fake);
  const up = ready(link);
  link.start();
  const info = (await up)[0];
  assert.strictEqual(info.windows.relay_streams_max, 256);
  assert.strictEqual(info.windows.relay_streams_per_chat, 64);
  let id = 1;
  for (let chat = 0; chat < 4; chat++) for (let i = 0; i < 64; i++) assert.ok(link.streams.open(id++, `chat-${chat}`).ok);
  assert.deepStrictEqual(link.streams.open(id++, 'chat-z'), { ok: false, reason: 'link_full' }, 'the 257th stream');
  for (let i = 1; i < 257; i++) link.streams.close(i);
  for (let i = 0; i < 64; i++) assert.ok(link.streams.open(id++, 'chat-one').ok);
  assert.deepStrictEqual(link.streams.open(id++, 'chat-one'), { ok: false, reason: 'chat_full' }, 'the 65th on one chat');
});

test('a hello.ack out of 05-hello.json\'s bounds (heartbeat_ms 1) is bad_frame: control.error fatal, close 4400, no heartbeat faster than 5 s', async (t) => {
  const fake = await withFakeHub(t, {
    heartbeatMs: 1,
    // The fake's own pings would follow heartbeat_ms on real timers: hold them at 15 s.
    timers: { setTimeout, clearTimeout, setInterval: (fn, ms) => setInterval(fn, Math.max(ms, 15000)), clearInterval },
  });
  const { link, vt } = openLink(t, fake);
  link.start();
  await fake.waitFor('hello.ack', { dir: 'out' });
  await waitUntil(() => link.state !== 'hello', { what: 'the hello.ack handled' });
  vt.advance(4999);
  await new Promise((r) => setTimeout(r, 50));   // what the link wrote reaches the fake
  assert.strictEqual(fake.find('heartbeat', { dir: 'in' }).length, 0, 'no heartbeat within 5 s');
  const err = await fake.waitFor('control.error');
  assert.deepStrictEqual([err.frame.code, err.frame.fatal], ['bad_frame', true]);
  assert.strictEqual((await fake.links[0].closed).code, 4400);
  await waitUntil(() => link.nextRetry, { what: 'the link closed' });
  assert.deepStrictEqual([link.nextRetry.code, link.nextRetry.action], [4400, 'normal']);
  assert.strictEqual(link.compat, null, 'nothing from the refused hello.ack is kept');
  const taken = fake.takeErrors((e) => e.dir === 'out' && e.kind === 'hello.ack');
  assert.ok(taken.length >= 1, 'the fake sent a hello.ack its own schema refuses');
});

test('the outbound queues are written in priority: control, queue, ring batches, derived signals, relay (C-05.21)', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = openLink(t, fake);
  const strip = (name) => {
    const { ch, kind, id, seq, at, re, ...body } = JSON.parse(JSON.stringify(validator.view.examples.get(name).data));
    return { ch, kind, re, body };
  };
  link.start();
  // The fake answers hello with hello.ack in the same tick; the link reads it
  // only on a later one, so frames sent now wait in the queues until it does.
  await fake.waitFor('hello');
  assert.strictEqual(link.state, 'hello');
  const sent = [];
  for (const name of ['05-relay-http.window', '05-event.turn-begun', '05-event', '05-queue-deliver.ack']) {
    const { ch, kind, re, body } = strip(name);
    assert.ok(link.send(ch, kind, body, { re }), name);
    sent.push(kind);
  }
  assert.deepStrictEqual(sent, ['relay.window', 'turn.begun', 'events.batch', 'queue.ack'], 'queued in reverse priority');
  await fake.waitFor('relay.window');
  const order = fake.frames.filter((e) => e.dir === 'in' && sent.includes(e.kind)).map((e) => e.kind);
  assert.deepStrictEqual(order, ['queue.ack', 'events.batch', 'turn.begun', 'relay.window']);
  const facts = fake.frames.findIndex((e) => e.dir === 'in' && e.kind === 'machine.facts');
  const first = fake.frames.findIndex((e) => e.dir === 'in' && e.kind === 'queue.ack');
  assert.ok(facts >= 0 && facts < first, 'the link\'s own control frame goes first');
  await new Promise((r) => setTimeout(r, 50));
  fake.takeErrors((e) => sent.includes(e.kind));   // the fake has none of these chats or streams
});

// ── what never leaves ──────────────────────────────────────────────────────
test('send() refuses a frame past 1 MiB encoded; a frame holding a registered secret or the key is dropped, logged by code only', async (t) => {
  const fake = await withFakeHub(t);
  const { link, logs, m } = openLink(t, fake);
  const up = ready(link);
  link.start();
  await up;
  assert.throws(() => link.send('control', 'control.error', { code: 'internal', fatal: false, hint: 'x'.repeat(MiB) }),
    (e) => e.code === 'ELINKFRAME');
  assert.throws(() => link.send('blobs', 'blob.put', {}), (e) => e.code === 'EFRAME');
  assert.throws(() => link.send('control', 'heartbeat', { seq: 4 }), (e) => e.code === 'EFRAME');

  const secret = crypto.randomBytes(32).toString('hex');
  link.registerSecret(secret);
  // U716b: a refused frame throws code 'secret' (null is only "no connection").
  assert.throws(() => link.send('control', 'control.error', { code: 'internal', fatal: false, hint: `a ${secret} b` }),
    (e) => e.code === 'secret' && !e.message.includes(secret));
  const d = m.privateKey.export({ format: 'jwk' }).d;
  assert.throws(() => link.send('control', 'control.error', { code: 'internal', fatal: false, hint: d }),
    (e) => e.code === 'secret' && !e.message.includes(d), 'the private key never leaves');
  assert.ok(link.send('control', 'control.error', { code: 'internal', fatal: false, hint: 'harmless' }));
  await waitUntil(() => fake.find('control.error', { dir: 'in' }).length === 1, { what: 'the harmless frame' });
  const all = JSON.stringify(fake.frames) + logs.join('\n');
  assert.ok(!all.includes(secret) && !all.includes(d));
  assert.strictEqual(logs.filter((l) => /code=secret/.test(l)).length, 2);
  assert.throws(() => link.registerSecret('short'), TypeError);
});

test('send onWritten: null from ws.send\'s callback once the frame is written; ELINKDOWN for a frame still queued when the connection closes; no connection returns null (U716b)', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = openLink(t, fake);
  const writtenNow = (fn) => new Promise((resolve) => fn((err) => resolve(err)));

  // Queued before hello.ack (the connection is in hand, not up): the stop
  // closes it with the frame never written.
  link.start();
  let queuedErr;
  const queued = writtenNow((cb) => {
    const id = link.send('control', 'control.error', { code: 'internal', fatal: false, hint: 'queued' }, { onWritten: cb });
    assert.ok(id, 'queued while the connection is opening');
  });
  const calls = [];
  link.send('control', 'control.error', { code: 'internal', fatal: false, hint: 'queued too' }, { onWritten: (e) => calls.push(e) });
  await link.stop();
  queuedErr = await queued;
  assert.strictEqual(queuedErr && queuedErr.code, 'ELINKDOWN');
  assert.strictEqual(calls.length, 1, 'each frame hears once');
  assert.strictEqual(calls[0].code, 'ELINKDOWN');
  assert.ok(!fake.find('control.error', { dir: 'in' }).some((e) => /queued/.test(e.frame.hint || '')), 'never written');

  // No connection in hand: null, and onWritten is never called.
  let heard = false;
  assert.strictEqual(link.send('control', 'control.error', { code: 'internal', fatal: false }, { onWritten: () => { heard = true; } }), null);
  assert.throws(() => link.send('control', 'control.error', { code: 'internal', fatal: false }, { onWritten: 'x' }), TypeError);

  // Up: the callback says written, after the frame went out.
  const up = ready(link);
  link.start();
  await up;
  const err = await writtenNow((cb) => {
    assert.ok(link.send('control', 'control.error', { code: 'internal', fatal: false, hint: 'written' }, { onWritten: cb }));
  });
  assert.strictEqual(err, null);
  await waitUntil(() => fake.find('control.error', { dir: 'in' }).some((e) => e.frame.hint === 'written'), { what: 'the written frame' });

  // A secret: thrown, never queued, onWritten never called.
  const secret = crypto.randomBytes(16).toString('hex');
  link.registerSecret(secret);
  assert.throws(() => link.send('control', 'control.error', { code: 'internal', fatal: false, hint: secret }, { onWritten: () => { heard = true; } }),
    (e) => e.code === 'secret');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(heard, false);
});

test('leave(): machine.leave on the control channel, resolved when the hub closes 1000; the link stops, and with no link up nothing is sent (U716b)', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = openLink(t, fake);
  assert.deepStrictEqual(await link.leave(), { sent: false, closed: false }, 'nothing up: nothing sent');
  const up = ready(link);
  link.start();
  await up;
  const [a, b] = await Promise.all([link.leave(), link.leave()]);
  assert.deepStrictEqual(a, { sent: true, closed: true, code: 1000 });
  assert.strictEqual(a, b, 'one leave per connection');
  const leaves = fake.find('machine.leave', { dir: 'in' });
  assert.strictEqual(leaves.length, 1);
  assert.strictEqual(leaves[0].ok, true, 'the frame is 05-machine-facts.json\'s machine_leave');
  assert.deepStrictEqual(Object.keys(leaves[0].frame).sort(), ['at', 'ch', 'id', 'kind', 'seq']);
  assert.strictEqual(link.state, 'stopped', '1000 is the stop row: no redial');
  assert.strictEqual(fake.machine().revoked, true);
});

test('a source scan of lib/connector: no option that relaxes TLS verification, and no non-loopback ws:// literal', () => {
  const dir = path.join(__dirname, '..', 'lib', 'connector');
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(text, /\brejectUnauthorized\b/, name);
    assert.doesNotMatch(text, /\bcheckServerIdentity\b/, name);
    assert.doesNotMatch(text, /[{,]\s*ca\s*[:,}]/, name);
    for (const mm of text.matchAll(/\bws:\/\/([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])/g)) {
      assert.ok(loopback.has(mm[1]), `${name}: ws://${mm[1]}`);
    }
  }
  const link = fs.readFileSync(path.join(dir, 'link.js'), 'utf8');
  assert.match(link, /maxPayload: MAX_PAYLOAD/);
  assert.match(link, /ws\.on\('error'/);
  assert.doesNotMatch(link, /\.listen\(|createServer\(|http\.request\(|os\.homedir\(\)|require\('ajv/);
});

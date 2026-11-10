'use strict';

// Pairing on the machine (tranche 6, U715; contract 06 C-06.2, C-06.7, C-06.8
// over 05 C-05.1 to C-05.3, 03 C-03.8): lib/connector/pairing.js pair() against
// the fake hub (test-support/fake-hub.js withFakeHub, plain http on
// 127.0.0.1:0, its port asserted outside 5170, 5171 and 5173–5272), through
// lib/util/outbound with deps.insecureLoopback for the fake's http origin.
//
// Every case runs under a throwaway HOME (withTempHome, over npm test's
// sandbox). No hub but the fake is dialled; the code is read from the
// connector's own deps.print (the fake keeps only its sha256), and never
// printed, logged or written by this file.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { withTempHome, waitUntil } = require('../test-support/helpers');
const { withFakeHub, isReservedPort } = require('../test-support/fake-hub');
const outbound = require('../lib/util/outbound');
const conn = require('../lib/setup/connector');
const { userPaths } = require('../lib/core/paths');
const pairing = require('../lib/connector/pairing');

const { pair, keyIdOf, fingerprintOf } = pairing;
const PAIRING_MODULE = path.join(__dirname, '..', 'lib', 'connector', 'pairing.js');
const CONTRACTS = path.join(__dirname, '..', 'test-support', 'contracts');
const STATE_SCHEMA_ID = 'https://web-chat-contracts/schemas/06-connector-state.json';
const CODE_RE = /\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/;

const modeOf = (file) => fs.statSync(file).mode & 0o777;
const exists = (file) => fs.existsSync(file);
const readExample = (name) => JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'examples', `${name}.json`), 'utf8'));

// ONE validator per file (U734's loader compiles ~47 schemas).
let validator = null;
function stateSchema() {
  if (!validator) validator = require('../test-support/contracts-loader').createValidator();
  const fn = validator.ajv.getSchema(STATE_SCHEMA_ID);
  assert.ok(fn, '06-connector-state.json is in the contracts copy');
  return fn;
}
// The fake's origin is http://127.0.0.1:<port> (insecureLoopback); the schema's
// pattern is https-only (Q2 in T6/notes-B.md), so the scheme is mapped first.
function forSchema(record) {
  const r = structuredClone(record);
  if (r.hub.origin.startsWith('http://')) r.hub.origin = `https://${r.hub.origin.slice('http://'.length)}`;
  return r;
}

async function fakeHub(t, opts = {}) {
  const fake = await withFakeHub(t, { pollAfterMs: 10, pollHoldMs: 50, ...opts });
  assert.ok(!isReservedPort(fake.port), `the fake's port ${fake.port} is outside the reserved band`);
  assert.ok(fake.port !== 5170 && fake.port !== 5171 && !(fake.port >= 5173 && fake.port <= 5272));
  return fake;
}

// One pairing run: its printed lines, its requests, its abort, its result.
function run(fake, { rePair = false, tamper, abortOnCode = false, extra = {} } = {}) {
  const lines = [];
  const requests = [];
  const ac = new AbortController();
  const request = async (url, opts) => {
    requests.push({ url, body: opts.body });
    const res = await outbound.request(url, opts);
    return tamper ? tamper(url, res) || res : res;
  };
  const print = (l) => {
    lines.push(String(l));
    // A run that must never show a code ends the moment it does, so a missing
    // refusal fails the test instead of polling until the timeout.
    if (abortOnCode && CODE_RE.test(String(l))) ac.abort();
  };
  const deps = { insecureLoopback: true, print, signal: ac.signal, request, ...extra };
  const result = pair({ hubUrl: fake.url, rePair, deps });
  const code = () => waitUntil(() => {
    const line = lines.find((l) => CODE_RE.test(l));
    return line && line.match(CODE_RE)[0];
  }, { timeout: 5000, what: 'the printed code' });
  return { lines, requests, ac, result, code };
}

function readRec(hubId) {
  const r = conn.readRecord(hubId);
  return r.ok ? r.value : null;
}

// Every file under `dir`, recursively (the sandbox HOME).
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// ── the vectors ─────────────────────────────────────────────────────────────

test('keyIdOf and fingerprintOf are lib/setup/connector.js\'s, and reproduce the contract examples\' key', () => {
  assert.strictEqual(keyIdOf, conn.keyIdOf, 'one derivation, re-exported');
  assert.strictEqual(fingerprintOf, conn.fingerprintOf, 'one derivation, re-exported');
  // The published example key (CF/docs/example-keys.json "machine") is the one
  // the 05-pairing examples carry; the contracts copy holds the examples.
  const start = readExample('05-pairing');
  const answer = readExample('05-pairing.start-response');
  const bound = readExample('05-pairing.bound');
  const raw = Buffer.from(start.public_key, 'base64url');
  assert.equal(keyIdOf(raw), 'mky_y4881352x9v335ap1wtpd4q6ef');
  assert.equal(keyIdOf(raw), bound.key_id);
  assert.equal(fingerprintOf(raw), 'SHA256:8RCAjKLqdjGVVg81ZpLmc+7/fOPgiDSG8BRyRVXXMGs');
  assert.equal(fingerprintOf(raw), answer.fingerprint);
  const keys = path.join(CONTRACTS, 'docs', 'example-keys.json');
  if (exists(keys)) {
    const k = JSON.parse(fs.readFileSync(keys, 'utf8')).keys.machine;
    assert.equal(keyIdOf(Buffer.from(k.public_key, 'base64url')), k.key_id);
    assert.equal(fingerprintOf(Buffer.from(k.public_key, 'base64url')), k.fingerprint);
  }
});

test('the signed strings are the contract\'s: the examples\' proofs verify over the prefixes pairing signs', () => {
  const start = readExample('05-pairing');
  const poll = readExample('05-pairing.poll');
  const host = 'hub.hale.dev'; // CF/docs/example-keys.json "host"
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: start.public_key }, format: 'jwk' });
  const ok = (text, proof) => crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(proof, 'base64url'));
  assert.ok(ok(`${pairing.PAIR_PROOF_PREFIX}\n${host}\n${start.client_nonce}`, start.proof), 'the start proof');
  assert.ok(ok(`${pairing.POLL_PROOF_PREFIX}\n${host}\n${poll.pairing_id}\n${poll.ts}`, poll.proof), 'the poll proof');
});

// ── the whole pairing ───────────────────────────────────────────────────────

test('a pairing the fake binds: pending without a key, then the key 0600 PKCS#8 and the record paired', async (t) => {
  const home = withTempHome(t);
  const fake = await fakeHub(t);
  const keyFile = userPaths().connectorKey('hub-test');
  const r = run(fake);
  const code = await r.code();

  // Pending: a record with the fingerprint, no key on disk, between polls.
  await fake.waitFor('pairing.poll_request', { count: 2 });
  assert.equal(exists(keyFile), false, 'no key file while the hub answers pending');
  const pending = readRec('hub-test');
  assert.equal(pending.credential.state, 'pending');
  assert.equal(pending.credential.algorithm, 'ed25519');
  assert.match(pending.credential.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(pending.credential.fingerprint, fingerprintOf(Buffer.from(pending.credential.public_key, 'base64url')));
  assert.equal(pending.credential.key_file, undefined);
  assert.equal(pending.machine, null);
  await fake.waitFor('pairing.poll_request', { count: 3 });
  assert.equal(exists(keyFile), false, 'still no key file after another pending poll');

  const confirmed = fake.pairing.confirm(code, { name: 'Studio Mac' });
  assert.equal(confirmed.ok, true);
  const result = await r.result;
  assert.equal(result.ok, true, r.lines.join('\n'));
  assert.equal(result.state, 'paired');
  assert.equal(result.hubId, 'hub-test');

  // The key: 0600, PKCS#8, readable, and the public half the hub bound.
  assert.equal(modeOf(keyFile), 0o600);
  assert.equal(modeOf(userPaths().connectorDir), 0o700);
  const pem = fs.readFileSync(keyFile, 'utf8');
  const priv = crypto.createPrivateKey(pem);
  assert.equal(priv.asymmetricKeyType, 'ed25519');
  assert.equal(priv.export({ type: 'pkcs8', format: 'pem' }), pem, 'PKCS#8 PEM as written');
  const pubWire = crypto.createPublicKey(priv).export({ format: 'jwk' }).x;
  const raw = Buffer.from(pubWire, 'base64url');

  // The record: paired, the machine, the key id, the public key, the fingerprint.
  const rec = readRec('hub-test');
  assert.equal(rec.credential.state, 'paired');
  assert.equal(rec.machine.id, confirmed.machine_id);
  assert.equal(rec.machine.name, 'Studio Mac');
  assert.equal(rec.credential.key_id, keyIdOf(raw));
  assert.equal(rec.credential.key_id, confirmed.key_id);
  assert.equal(rec.credential.public_key, pubWire);
  assert.equal(rec.credential.fingerprint, fingerprintOf(raw));
  assert.equal(rec.credential.key_file, keyFile);
  assert.equal(typeof rec.credential.paired_at, 'number');
  assert.equal(rec.ceiling, 'full');
  assert.equal(rec.hub.origin, fake.url);
  assert.equal(rec.workdir, userPaths().defaultWorkdir('hub-test'));
  assert.equal(modeOf(userPaths().connectorRecord('hub-test')), 0o600);
  const validate = stateSchema();
  assert.equal(validate(forSchema(rec)), true, JSON.stringify(validate.errors));

  // The bodies: each validated by the fake against 05-pairing.json, start first.
  const ins = fake.frames.filter((f) => f.ch === 'pairing' && f.dir === 'in');
  assert.equal(ins[0].kind, 'pairing.start_request');
  assert.ok(ins.slice(1).every((f) => f.kind === 'pairing.poll_request'));
  assert.ok(ins.length >= 4);
  assert.ok(fake.frames.filter((f) => f.ch === 'pairing').every((f) => f.ok), 'every pairing body fits 05-pairing.json');
  const startBody = ins[0].frame;
  assert.equal(startBody.public_key, pubWire, 'the start named the key that was written');
  assert.deepEqual(Object.keys(startBody.connector).sort(), ['hostname', 'package_version', 'platform']);
  assert.ok(['darwin', 'linux'].includes(startBody.connector.platform));

  // The code: printed once, and nowhere else.
  assert.equal(r.lines.filter((l) => l.includes(code)).length, 1, 'the code is printed once');
  assert.ok(r.lines.some((l) => l.includes(fake.url)), 'the hub address is printed');
  assert.ok(r.lines.some((l) => /expires in about \d+ minute/.test(l)), 'the minutes left are printed');
  assert.ok(r.lines.some((l) => l.includes(fingerprintOf(raw))), 'the fingerprint is printed');
  assert.equal(r.lines.findIndex((l) => l.includes(code)) < r.lines.findIndex((l) => l.includes('Paired')), true);

  // The code, the private key and every proof appear in no file under HOME but
  // the key in its own file, and in no environment variable or argv.
  const proofs = ins.map((f) => f.frame.proof);
  const der = priv.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const files = filesUnder(home);
  assert.ok(files.length >= 2);
  for (const file of files) {
    const text = fs.readFileSync(file, 'latin1');
    assert.ok(!text.includes(code), `the code is not in ${path.relative(home, file)}`);
    for (const p of proofs) assert.ok(!text.includes(p), `no proof in ${path.relative(home, file)}`);
    if (file !== keyFile) {
      assert.ok(!text.includes(pem.trim().split('\n')[1]), `no key bytes in ${path.relative(home, file)}`);
      assert.ok(!text.includes(der), `no key bytes in ${path.relative(home, file)}`);
    }
  }
  assert.equal(exists(userPaths().connectorLog), false, 'pairing logs nothing');
  for (const v of [...Object.values(process.env), ...process.argv]) {
    assert.ok(!String(v).includes(code));
  }
});

test('the code and the key reach no console line, and pairing spawns nothing', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t);
  const said = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...a) => { said.push(a.map(String).join(' ')); };
  let code;
  try {
    const r = run(fake);
    code = await r.code();
    fake.pairing.confirm(code);
    assert.equal((await r.result).ok, true);
  } finally {
    methods.forEach((m, i) => { console[m] = saved[i]; });
  }
  const pem = fs.readFileSync(userPaths().connectorKey('hub-test'), 'utf8');
  for (const line of said) {
    assert.ok(!line.includes(code), 'no console line carries the code');
    assert.ok(!line.includes(pem.trim().split('\n')[1]), 'no console line carries the key');
  }
  const src = fs.readFileSync(PAIRING_MODULE, 'utf8');
  assert.doesNotMatch(src, /child_process|console\.|appendFile|applog/, 'pairing runs no program and writes no log');
});

test('--workdir reaches the new record, pending and paired alike', async (t) => {
  const home = withTempHome(t);
  const fake = await fakeHub(t);
  const workdir = path.join(home, 'agents-here');
  const lines = [];
  const result = pair({ hubUrl: fake.url, workdir, deps: { insecureLoopback: true, print: (l) => lines.push(String(l)) } });
  const code = await waitUntil(() => {
    const line = lines.find((l) => CODE_RE.test(l));
    return line && line.match(CODE_RE)[0];
  }, { timeout: 5000, what: 'the printed code' });
  await fake.waitFor('pairing.poll_request');
  assert.equal(readRec('hub-test').workdir, workdir, 'the pending record carries --workdir');
  fake.pairing.confirm(code);
  assert.equal((await result).ok, true);
  assert.equal(readRec('hub-test').workdir, workdir, 'the paired record keeps it');
});

// ── the ways it ends without a key ──────────────────────────────────────────

test('a code the fake lets expire: non-zero, no key, the record unpaired', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t, { codeTtlMs: 300 });
  const r = run(fake);
  await r.code();
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
  assert.match(result.message, /run `claude-web-chat connect http:\/\/127\.0\.0\.1:\d+` again/);
  assert.ok(r.lines.some((l) => l.includes('Run connect again')), 'the hub\'s hint is shown');
  assert.equal(exists(userPaths().connectorKey('hub-test')), false);
  assert.equal(readRec('hub-test').credential.state, 'unpaired');
  assert.deepEqual(readRec('hub-test').credential, { state: 'unpaired' });
});

test('a code the hub refuses: non-zero, no key, the record unpaired', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t);
  const r = run(fake);
  const code = await r.code();
  await fake.waitFor('pairing.poll_request');
  assert.equal(fake.pairing.refuse(code).ok, true);
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refused');
  assert.match(result.message, /again/);
  assert.equal(exists(userPaths().connectorKey('hub-test')), false);
  assert.equal(readRec('hub-test').credential.state, 'unpaired');
});

test('a consumed code entered for a second pairing is refused by the fake; the second writes no key', async (t) => {
  const fake = await fakeHub(t);
  let firstCode;
  await withTempHome(async () => {
    const r = run(fake);
    firstCode = await r.code();
    assert.equal(fake.pairing.confirm(firstCode).ok, true);
    assert.equal((await r.result).ok, true);
    assert.ok(exists(userPaths().connectorKey('hub-test')));
  });
  await withTempHome(async () => {
    const r = run(fake);
    const secondCode = await r.code();
    assert.notEqual(secondCode, firstCode);
    await fake.waitFor('pairing.poll_request', { count: 1 + fake.find('pairing.poll_request').length });
    assert.deepEqual(fake.pairing.confirm(firstCode), { ok: false, reason: 'used' });
    assert.equal(fake.machines.size, 1, 'no second machine from a used code');
    r.ac.abort();
    const result = await r.result;
    assert.equal(result.ok, false);
    assert.equal(exists(userPaths().connectorKey('hub-test')), false);
    assert.equal(readRec('hub-test').credential.state, 'unpaired');
  });
});

test('Ctrl-C (the AbortSignal) during the poll: non-zero at once, no key, the record unpaired', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t, { pollHoldMs: 5000 });
  const r = run(fake);
  await r.code();
  await fake.waitFor('pairing.poll_request');
  assert.equal(readRec('hub-test').credential.state, 'pending');
  const t0 = Date.now();
  r.ac.abort();
  const result = await r.result;
  assert.ok(Date.now() - t0 < 2000, 'the held poll is not waited out');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'aborted');
  assert.equal(exists(userPaths().connectorKey('hub-test')), false);
  assert.equal(readRec('hub-test').credential.state, 'unpaired');
});

test('Ctrl-C before the start answers writes nothing at all', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t);
  const ac = new AbortController();
  ac.abort();
  const result = await pair({ hubUrl: fake.url, deps: { insecureLoopback: true, print: () => {}, signal: ac.signal } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'aborted');
  assert.equal(exists(userPaths().connectorDir), false, 'nothing written before the start answers');
  assert.equal(fake.frames.length, 0);
});

test('a fingerprint in the start answer that is not the local one refuses: no record, no key', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t);
  const stranger = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const r = run(fake, {
    abortOnCode: true,
    tamper: (url, res) => (url.endsWith('/connector/pair') && res.json && res.json.ok
      ? { ...res, json: { ...res.json, fingerprint: fingerprintOf(Buffer.from(stranger, 'base64url')) } } : null),
  });
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fingerprint_mismatch');
  assert.ok(!r.lines.some((l) => CODE_RE.test(l)), 'the code is never shown for a mismatched key');
  assert.equal(exists(userPaths().connectorKey('hub-test')), false);
  assert.equal(conn.readRecord('hub-test').absent, true);
});

for (const [why, edit, reason] of [
  ['a bound key_id that is not keyIdOf the local key', (j) => ({ ...j, key_id: 'mky_0000000000000000000000000a' }), 'key_id_mismatch'],
  ['a connect_url on another host', (j) => ({ ...j, connect_url: 'wss://hub.other.example/connector' }), 'connect_url_mismatch'],
  ['a connect_url on the same host but another port', (j) => ({ ...j, connect_url: j.connect_url.replace(/:(\d+)\//, (m, p) => `:${Number(p) + 1}/`) }), 'connect_url_mismatch'],
  ['a bound hub_id that is not the start\'s', (j) => ({ ...j, hub_id: 'hub-elsewhere' }), 'hub_id_mismatch'],
]) {
  test(`${why} refuses: no key, the record unpaired`, async (t) => {
    withTempHome(t);
    const fake = await fakeHub(t);
    const r = run(fake, {
      tamper: (url, res) => (url.endsWith('/poll') && res.json && res.json.state === 'bound' ? { ...res, json: edit(res.json) } : null),
    });
    fake.pairing.confirm(await r.code());
    const result = await r.result;
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(exists(userPaths().connectorKey('hub-test')), false);
    assert.equal(readRec('hub-test').credential.state, 'unpaired');
  });
}

test('clock_skew from the hub: non-zero, the clock sentence, no second poll', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t, { now: () => Date.now() + 10 * 60 * 1000 });
  const r = run(fake);
  await r.code();
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'clock_skew');
  assert.match(result.message, /set this machine's clock/);
  assert.equal(fake.find('pairing.poll_request').length, 1, 'no second poll');
  assert.equal(r.requests.filter((q) => q.url.endsWith('/poll')).length, 1);
  assert.equal(exists(userPaths().connectorKey('hub-test')), false);
  assert.equal(readRec('hub-test').credential.state, 'unpaired');
});

test('a 429 on the start prints the wait from retry_after_s and writes nothing', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t, { limits: { startsPerAddress: 1 } });
  const first = run(fake);
  await first.code();
  first.ac.abort();
  assert.equal((await first.result).reason, 'aborted');
  fs.rmSync(userPaths().connectorDir, { recursive: true, force: true });

  const second = run(fake);
  const result = await second.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rate_limited');
  const refusal = fake.find('pairing.error_response', { dir: 'out' }).at(-1).frame;
  assert.equal(refusal.error, 'rate_limited');
  assert.ok(Number.isInteger(refusal.retry_after_s));
  const wait = refusal.retry_after_s < 120 ? `${refusal.retry_after_s} s` : `about ${Math.ceil(refusal.retry_after_s / 60)} minutes`;
  assert.ok(second.lines.some((l) => l.includes(`wait ${wait}`)), second.lines.join('\n'));
  assert.equal(exists(userPaths().connectorDir), false, 'a refused start writes nothing');
});

test('too_many_pending (429) and bad_proof each exit non-zero naming the word, no body dump', async (t) => {
  withTempHome(t);
  const busy = await fakeHub(t, { limits: { pending: 0 } });
  const a = await run(busy).result;
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'too_many_pending');
  assert.match(a.message, /wait 60 s/);

  const fake = await fakeHub(t);
  const lines = [];
  const b = await pair({
    hubUrl: fake.url,
    deps: {
      insecureLoopback: true,
      print: (l) => lines.push(l),
      request: (url, opts) => outbound.request(url, { ...opts, body: { ...opts.body, client_nonce: crypto.randomBytes(32).toString('base64url') } }),
    },
  });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'bad_proof');
  assert.match(b.message, /\(bad_proof\)/);
  assert.doesNotMatch(lines.join('\n'), /\{|"ok"/, 'never a body dump');
  assert.equal(exists(userPaths().connectorDir), false);
});

// ── one hub per machine, and the re-pair ────────────────────────────────────

function pairedRecordFor(hubId, origin) {
  const k = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  const raw = Buffer.from(k, 'base64url');
  return conn.withDefaults({
    ...conn.newRecord({ hubId, origin }),
    machine: { id: 'mch_01jbz3k9q4w8r2t6v0x5m7n8p1', name: 'studio' },
    credential: {
      state: 'paired', algorithm: 'ed25519', key_file: userPaths().connectorKey(hubId),
      key_id: keyIdOf(raw), public_key: k, fingerprint: fingerprintOf(raw), paired_at: 1793177460000,
    },
  });
}

test('one hub per machine: paired with hub-one, pairing hub-two refuses naming `connect disconnect` and sends nothing', async (t) => {
  withTempHome(t);
  conn.writeRecord(pairedRecordFor('hub-one', 'https://hub-one.example.com'));
  const fake = await fakeHub(t, { hubId: 'hub-two' });
  const r = run(fake);
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'other_hub');
  assert.match(result.message, /already paired with https:\/\/hub-one\.example\.com; run `claude-web-chat connect disconnect` first/);
  assert.equal(r.requests.length, 0, 'no request');
  assert.equal(fake.frames.length, 0, 'the fake heard nothing');
  assert.equal(conn.readRecord('hub-two').absent, true);
  assert.equal(readRec('hub-one').credential.state, 'paired', 'the paired record is untouched');
});

test('one hub per machine: a pending or unpaired record for another hub does not block', async (t) => {
  withTempHome(t);
  conn.writeRecord(conn.newRecord({ hubId: 'hub-one', origin: 'https://hub-one.example.com' }));
  const fake = await fakeHub(t, { hubId: 'hub-two' });
  const r = run(fake);
  fake.pairing.confirm(await r.code());
  assert.equal((await r.result).ok, true);
  assert.equal(readRec('hub-two').credential.state, 'paired');
});

test('a paired hub without --re-pair refuses before any request', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t, { hubId: 'hub-one' });
  conn.writeRecord(pairedRecordFor('hub-one', fake.url));
  const r = run(fake);
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already_paired');
  assert.match(result.message, /--re-pair/);
  assert.equal(r.requests.length, 0);
});

test('rePair against the paired hub-one pairs again; the key is replaced only on bound', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t, { hubId: 'hub-one' });
  const keyFile = userPaths().connectorKey('hub-one');

  const first = run(fake);
  fake.pairing.confirm(await first.code(), { name: 'first' });
  assert.equal((await first.result).ok, true);
  const oldPem = fs.readFileSync(keyFile, 'utf8');
  const oldRec = readRec('hub-one');
  const folders = [{ id: 'f_0123456789abcdef', path: '/tmp/x', display: '~/x', access: 'read-write', offered_at: 1 }];
  conn.updateRecord('hub-one', (cur) => ({ ...cur, ceiling: 'read', folders, settings: { ...cur.settings, agents_at_once: 3 } }));

  const again = run(fake, { rePair: true });
  const code = await again.code();
  const polls = fake.find('pairing.poll_request').length;
  await fake.waitFor('pairing.poll_request', { count: polls + 2 });
  assert.equal(fs.readFileSync(keyFile, 'utf8'), oldPem, 'the old key stays while the re-pair is pending');
  assert.deepEqual(readRec('hub-one').credential, oldRec.credential, 'the paired record stays while pending');

  const confirmed = fake.pairing.confirm(code, { name: 'second' });
  const result = await again.result;
  assert.equal(result.ok, true);
  const newPem = fs.readFileSync(keyFile, 'utf8');
  assert.notEqual(newPem, oldPem, 'bound replaced the key');
  assert.equal(modeOf(keyFile), 0o600);
  const raw = Buffer.from(crypto.createPublicKey(crypto.createPrivateKey(newPem)).export({ format: 'jwk' }).x, 'base64url');
  const rec = readRec('hub-one');
  assert.equal(rec.credential.key_id, keyIdOf(raw));
  assert.notEqual(rec.credential.key_id, oldRec.credential.key_id);
  assert.equal(rec.machine.id, confirmed.machine_id);
  assert.equal(rec.machine.name, 'second');
  assert.equal(rec.ceiling, 'read', 'the ceiling the user set is kept');
  assert.deepEqual(rec.folders, folders, 'the folders are kept');
  assert.equal(rec.settings.agents_at_once, 3, 'the settings are kept');
});

test('a re-pair that is abandoned leaves the working key and the paired record as they were', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t, { hubId: 'hub-one' });
  const keyFile = userPaths().connectorKey('hub-one');
  const first = run(fake);
  fake.pairing.confirm(await first.code());
  assert.equal((await first.result).ok, true);
  const oldPem = fs.readFileSync(keyFile, 'utf8');
  const oldRec = readRec('hub-one');

  const again = run(fake, { rePair: true });
  await again.code();
  again.ac.abort();
  const result = await again.result;
  assert.equal(result.ok, false);
  assert.equal(result.state, 'paired');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), oldPem);
  assert.deepEqual(readRec('hub-one'), oldRec);
});

// ── refusals before the key ─────────────────────────────────────────────────

test('a platform other than darwin or linux, and an http origin that is not loopback, refuse before any request', async (t) => {
  withTempHome(t);
  const fake = await fakeHub(t);
  const r = run(fake, { extra: { platform: 'win32' } });
  const result = await r.result;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'platform');
  assert.equal(r.requests.length, 0);

  const plain = await pair({ hubUrl: 'http://hub.example.com', deps: { insecureLoopback: true, print: () => {}, request: () => assert.fail('no request') } });
  assert.equal(plain.ok, false);
  assert.equal(plain.reason, 'bad_origin');
  const noFlag = await pair({ hubUrl: fake.url, deps: { print: () => {}, request: () => assert.fail('no request') } });
  assert.equal(noFlag.reason, 'bad_origin', 'loopback http needs insecureLoopback');
  assert.equal(exists(userPaths().connectorDir), false);
});

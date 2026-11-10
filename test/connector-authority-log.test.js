'use strict';

// lib/connector/authority-log.js (tranche 6, U730): the connector's authority
// log — deny events coalesced per 60 s, written as 0600 JSONL on lib/core/applog
// with the principal id, rotated at 1 MiB with one .1, and shipped as
// authority.log frames that survive a dropped link.
//
// Time is virtual for the log (its own clock and timers); the link and the
// fake hub (test-support/fake-hub.js, U735) run on real time over loopback.
// The fake validates every frame against the locked schemas and fails the
// test on any that does not pass (withFakeHub's t.after). Nothing here dials
// a host but loopback, binds a reserved port or reads the developer's HOME
// (the sandbox's HOME, test-support/sandbox.js).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');
const { withFakeHub, mintLabel } = require('../test-support/fake-hub');
const { createValidator } = require('../test-support/contracts-loader');
const { fakeSecrets } = require('../test-support/fake-secrets');
const { waitUntil } = require('../test-support/helpers');
const { createLink } = require('../lib/connector/link');
const { install: installRelay } = require('../lib/connector/relay');
const { hubOrigin, newRecord, keyIdOf, fingerprintOf } = require('../lib/setup/connector');
const { versionsRecord, machineFacts } = require('../lib/connector/facts');
const connectedPolicy = require('../lib/core/connected-policy');
const { userPaths } = require('../lib/core/paths');
const {
  createAuthorityLog, install, principalId, principalOk, POISON_CLOSES, WINDOW_MS, MAX_BYTES, QUEUE_MAX, FRAME_RECORDS, PATH_MAX, HOLD_MS, GRAMMAR,
} = require('../lib/connector/authority-log');

const validator = createValidator({ folders: 'all' });
const S = 'https://web-chat-contracts/schemas/';
const DENY = validator.ajv.getSchema(`${S}04-deny-record.json`);
const DENY_SCHEMA = DENY.schema;
const AUTH_LOG = validator.ajv.getSchema(`${S}05-event.json#/$defs/authority_log`);
const PRINCIPAL = JSON.parse(JSON.stringify(validator.view.examples.get('03-principal').data));
const LINE_KEYS = ['t', 'ts', 'first_ts', 'count', 'enforcer', 'principal', 'chat_id', 'machine_id', 'decision_id',
  'origin', 'method', 'path', 'rule', 'need', 'reason', 'status'].sort();
const T0 = Date.parse('2026-11-10T12:00:00.000Z');
const id26 = () => mintLabel();

function ajvSays(v, data, what) {
  assert.ok(v(data), `${what}: ${JSON.stringify(v.errors)}`);
}

// A virtual clock: now() and {setTimeout, clearTimeout}; advance(ms) runs what
// falls due, in order.
function virtualClock(start = T0) {
  let t = start;
  const due = new Set();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const h = { at: t + Math.max(0, Number(ms) || 0), fn }; due.add(h); return h; },
      clearTimeout(h) { due.delete(h); },
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const h of due) if (h.at <= end && (!next || h.at < next.at)) next = h;
        if (!next) break;
        due.delete(next);
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-authlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'connector');
}

// One deny event as U717's relay emits it.
function deny(o = {}) {
  return {
    enforcer: 'connector', origin: 'session', method: 'POST', path: '/api/shutdown',
    rule: '* /api/shutdown', need: 'host_only', reason: 'host-only', status: 403,
    principal: PRINCIPAL, chat_id: o.chat_id || CHAT, machine_id: MACHINE, decision_id: DECISION,
    ...o,
  };
}
const CHAT = id26();
const MACHINE = `mch_${id26()}`;
const DECISION = `dec_${id26()}`;

const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// A stand-in for U716's link where a test needs only state and send.
function stubLink() {
  const link = new EventEmitter();
  link.state = 'up';
  link.sent = [];
  link.send = (ch, kind, body) => { link.sent.push({ ch, kind, body }); return `c${link.sent.length}`; };
  return link;
}

// ── the machine and its link to the fake ───────────────────────────────────
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

async function upLink(t, fake) {
  const m = machineOn(fake);
  const link = createLink({
    record: m.record,
    key: m.privateKey,
    versions: () => versionsRecord({ claudeVersion: null }),
    facts: () => machineFacts({ record: m.record, names: { mcp_servers: [], skills: [] }, hostname: 'test-host', login: 'tester' }),
    routeTable: () => ({ table_version: connectedPolicy.TABLE_VERSION, sha256: connectedPolicy.TABLE_SHA256 }),
    log: () => {},
    writeKey: () => {},
    random: () => 0, // a redial after a drop comes at once
  });
  t.after(() => link.stop());
  const ready = once(link, 'ready');
  link.start();
  await ready;
  return { link, m };
}

const shippedRecords = (fake) => fake.find('authority.log', { dir: 'in' }).flatMap((e) => e.frame.records);

// ── the grammar ────────────────────────────────────────────────────────────
test('the grammar is 04-deny-record.json\'s and 05\'s: enums, patterns, the path cut and the frame size', () => {
  const p = DENY_SCHEMA.properties;
  assert.deepStrictEqual([...GRAMMAR.reasons].sort(), [...DENY_SCHEMA.$defs.reason.enum].sort());
  assert.deepStrictEqual([...GRAMMAR.needs].sort(), [...p.need.oneOf[1].enum].sort());
  assert.deepStrictEqual([...GRAMMAR.origins].sort(), [...p.origin.enum].sort());
  assert.deepStrictEqual([...GRAMMAR.enforcers, 'hub'].sort(), [...p.enforcer.enum].sort());
  const same = (re, pattern) => assert.strictEqual(re.source, new RegExp(pattern).source);
  same(GRAMMAR.method, p.method.pattern);
  same(GRAMMAR.label, p.chat_id.pattern);
  same(GRAMMAR.machine, p.machine_id.oneOf[1].pattern);
  same(GRAMMAR.decision, p.decision_id.oneOf[1].pattern);
  same(GRAMMAR.rule, p.rule.oneOf[1].pattern);
  assert.strictEqual(PATH_MAX, p.path.maxLength);
  const frame = validator.ajv.getSchema(`${S}05-event.json`).schema.$defs.authority_log;
  assert.strictEqual(FRAME_RECORDS, frame.properties.records.maxItems);
  assert.strictEqual(WINDOW_MS, 60 * 1000);
  assert.strictEqual(MAX_BYTES, 1024 * 1024);
  assert.strictEqual(QUEUE_MAX, 10000);
  // The principal's id: the account, else the credential, never an email.
  assert.strictEqual(principalId(PRINCIPAL), PRINCIPAL.user);
  assert.strictEqual(principalId({ ...PRINCIPAL, user: null }), PRINCIPAL.session);
  assert.strictEqual(principalId({ ...PRINCIPAL, user: 'me@example.com', session: null }), null);
});

test('principalOk is 03-principal.json: the examples and every one-field change of them agree with the schema', () => {
  const v = validator.ajv.getSchema(`${S}03-principal.json`);
  const examples = ['03-principal', '03-principal-home', '03-principal-service'].map((n) => validator.view.examples.get(n).data);
  const L = () => id26();
  const pool = [
    null, true, false, 1, 2, '', 'x', 'me@example.com', `usr_${L()}`, `svc_${L()}`, 'svc_home', `mch_${L()}`, `cht_${L()}`,
    `ses_${L()}`, `srf_${L()}`, `key_${L()}`, `cxs_${L()}`, `agt_${L()}`, 'cc:12345678-1234-1234-1234-123456789abc',
    'claude', 'service', 'driver', 'pane', 'user', 'remote', 'service:git-dashboard', 'hub', 'daemon',
    'shell', 'phone', 'notification', 'api', 'mcp', 'scheduler', 'connector',
  ];
  const keys = ['v', 'user', 'machine', 'chat', 'session', 'writer_class', 'owner', 'verified', 'verified_by', 'via', 'extra'];
  // An agent acting by grant (via mcp, agt_ session) as a further base.
  const agent = { v: 1, user: null, machine: `mch_${L()}`, chat: `cht_${L()}`, session: `agt_${L()}`, writer_class: 'remote', verified: true, verified_by: 'hub', via: 'mcp' };
  const hubJob = { v: 1, user: null, machine: null, session: null, writer_class: null, verified: false, verified_by: null, via: 'hub' };
  let checked = 0;
  for (const base of [...examples, agent, hubJob]) {
    assert.strictEqual(principalOk(base), v(base), `base ${JSON.stringify(base)}`);
    for (const k of keys) {
      const gone = { ...base };
      delete gone[k];
      assert.strictEqual(principalOk(gone), v(gone), `without ${k}: ${JSON.stringify(gone)}`);
      for (const x of pool) {
        const m = { ...base, [k]: x };
        assert.strictEqual(principalOk(m), v(m), `${k} = ${JSON.stringify(x)}: ${JSON.stringify(m)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 1500);
  assert.strictEqual(principalOk(null), false);
  assert.strictEqual(principalOk([]), false);
});

// ── coalescing ─────────────────────────────────────────────────────────────
test('three identical denials within 60 s are one record (count 3, first_ts the first, ts the last); a fourth after the window is a second', (t) => {
  const vc = virtualClock();
  const file = path.join(tmpDir(t), 'authority.log');
  const alog = createAuthorityLog({ file, now: vc.now, timers: vc.timers });
  t.after(() => alog.stop());
  alog.record(deny());
  vc.advance(10 * 1000);
  alog.record(deny());
  vc.advance(39 * 1000);
  alog.record(deny());
  assert.ok(!fs.existsSync(file), 'nothing is written while the window is open');
  vc.advance(11 * 1000); // 60 s after the first: the window closes
  let lines = readLines(file);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].count, 3);
  assert.strictEqual(lines[0].first_ts, new Date(T0).toISOString());
  assert.strictEqual(lines[0].ts, new Date(T0 + 49 * 1000).toISOString());

  vc.advance(5 * 1000);
  alog.record(deny());
  vc.advance(WINDOW_MS);
  lines = readLines(file);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[1].count, 1);
  assert.strictEqual(lines[1].first_ts, lines[1].ts);

  // A different principal, chat, rule or reason is its own record, even while
  // a window of the other three is open; stop closes the windows still open.
  alog.record(deny());
  alog.record(deny({ principal: { ...PRINCIPAL, user: `usr_${id26()}` } }));
  alog.record(deny({ chat_id: id26() }));
  alog.record(deny({ rule: '* /api/unlock', path: '/api/unlock' }));
  alog.record(deny({ reason: 'ceiling' }));
  alog.stop();
  lines = readLines(file);
  assert.strictEqual(lines.length, 7);
  assert.ok(lines.slice(2).every((l) => l.count === 1));
});

test('the window is keyed by principal id, chat, rule and reason: N denials of distinct paths under one rule and reason within 60 s are one line (count N) and one queued record carrying the first', (t) => {
  const vc = virtualClock();
  const file = path.join(tmpDir(t), 'authority.log');
  const link = stubLink();
  link.state = 'backoff'; // queued, not sent: stats().pending counts the records
  const alog = createAuthorityLog({ file, link, now: vc.now, timers: vc.timers });
  t.after(() => alog.stop());
  const N = 250;
  for (let i = 0; i < N; i++) {
    alog.record(deny({ method: 'GET', path: `/api/files/f${i}`, rule: 'GET /api/files/*', need: 'files', reason: 'level' }));
    vc.advance(100);
  }
  assert.strictEqual(alog.stats().open_windows, 1, 'one window for the flood');
  vc.advance(WINDOW_MS);
  const lines = readLines(file);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].count, N);
  assert.strictEqual(lines[0].path, '/api/files/f0', 'the record carries the window\'s first event');
  assert.strictEqual(lines[0].first_ts, new Date(T0).toISOString());
  assert.strictEqual(lines[0].ts, new Date(T0 + (N - 1) * 100).toISOString());
  assert.strictEqual(alog.stats().pending, 1);
  link.state = 'up';
  link.emit('ready', {});
  const recs = link.sent.flatMap((s) => s.body.records);
  assert.strictEqual(recs.length, 1);
  ajvSays(DENY, recs[0], 'the coalesced record');
  assert.strictEqual(recs[0].count, N);

  // The window is shippable only when the event whose fields it carries is
  // valid: an invalid first event keeps the window local, a valid later one
  // does not change that.
  alog.record(deny({ origin: 'elsewhere', reason: 'ceiling' }));
  alog.record(deny({ reason: 'ceiling' }));
  alog.flush();
  assert.strictEqual(readLines(file).length, 2);
  assert.strictEqual(readLines(file)[1].count, 2);
  assert.strictEqual(alog.stats().local_only, 1);
  assert.strictEqual(alog.stats().pending, 1);
});

test('the line: the principal\'s id only, the path without its query and at most 512 characters, no hint or body; 0600 in the 0700 connector directory under the sandbox HOME; a token in the path is masked', (t) => {
  const file = userPaths().connectorAuthorityLog;
  assert.ok(file.startsWith(os.homedir()), 'the sandbox HOME');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const vc = virtualClock();
  const link = stubLink();
  const alog = createAuthorityLog({ file, link, now: vc.now, timers: vc.timers });
  const long = `/api/files/${'a'.repeat(700)}?token=abc&x=1#frag`;
  alog.record({ ...deny({ method: 'GET', path: long, rule: null, need: null, reason: 'unknown' }), hint: 'go run claude-web-chat unlock', body: '{"secret":1}', headers: { cookie: 'a=b' } });
  const ghp = fakeSecrets({ seed: 11 }).find((f) => f.id === 'github-ghp').secrets[0];
  // Its own chat: the window key is (principal id, chat, rule, reason), so a
  // second path under the same four would join the first record.
  alog.record(deny({ chat_id: id26(), method: 'GET', path: `/api/files/${ghp}/x?q=${ghp}`, rule: null, need: null, reason: 'unknown' }));
  alog.stop();

  const text = fs.readFileSync(file, 'utf8');
  const lines = readLines(file);
  assert.strictEqual(lines.length, 2);
  for (const l of lines) {
    assert.deepStrictEqual(Object.keys(l).sort(), LINE_KEYS, 'a deny line and nothing else');
    assert.strictEqual(l.t, 'deny');
    assert.strictEqual(typeof l.principal, 'string');
    assert.strictEqual(l.principal, PRINCIPAL.user, 'the principal id, not the record');
    assert.ok(!l.path.includes('?') && !l.path.includes('#'), 'no query string or fragment');
    assert.ok(l.path.length <= 512);
  }
  assert.strictEqual(lines[0].path, `/api/files/${'a'.repeat(700)}`.slice(0, 512));
  assert.ok(!text.includes('hint') && !text.includes('secret') && !text.includes('cookie') && !text.includes('token=abc'));
  assert.ok(!text.includes(ghp), 'the token is masked');
  assert.match(lines[1].path, /^\/api\/files\/‹redacted:[a-z-]+›\/x$/);
  assert.ok(!text.includes('epoch') && !text.includes(String(process.pid)), 'no epoch line, no pid');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  // The shipped records carry the full principal, the same masked path, sink log.
  const recs = link.sent.flatMap((s) => s.body.records);
  assert.strictEqual(recs.length, 2);
  for (const r of recs) {
    ajvSays(DENY, r, 'shipped record');
    assert.strictEqual(r.sink, 'log');
    assert.ok(!('summary' in r));
    assert.deepStrictEqual(r.principal, PRINCIPAL);
  }
  assert.ok(!JSON.stringify(recs).includes(ghp));
  assert.strictEqual(recs[1].path, lines[1].path);
});

test('rotation: past 1 MiB the file moves to <file>.1 and a new file starts; a second rotation replaces .1; nothing else in the directory', (t) => {
  const vc = virtualClock();
  const dir = tmpDir(t);
  const file = path.join(dir, 'authority.log');
  const alog = createAuthorityLog({ file, now: vc.now, timers: vc.timers });
  t.after(() => alog.stop());
  let n = 0;
  const writeSome = (k) => {
    // A chat each: distinct paths alone share one window (the key is principal id, chat, rule, reason).
    for (let i = 0; i < k; i++) alog.record(deny({ chat_id: id26(), method: 'GET', path: `/api/x/${n++}/${'p'.repeat(400)}`, rule: null, need: null, reason: 'unknown' }));
    alog.flush();
  };
  writeSome(100);
  const perLine = fs.statSync(file).size / 100;
  const toFill = Math.ceil(MAX_BYTES / perLine) + 10;
  writeSome(toFill - 100);
  assert.ok(fs.existsSync(`${file}.1`), 'rotated once');
  assert.ok(fs.statSync(`${file}.1`).size <= MAX_BYTES);
  assert.ok(fs.statSync(file).size < MAX_BYTES / 2, 'a new file started');
  const firstOfOne = readLines(`${file}.1`)[0].path;
  writeSome(toFill);
  assert.strictEqual(alog.stats().rotations, 2);
  const firstOfTwo = readLines(`${file}.1`)[0].path;
  assert.notStrictEqual(firstOfTwo, firstOfOne, 'the second rotation replaced .1');
  assert.ok(fs.statSync(`${file}.1`).size <= MAX_BYTES);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['authority.log', 'authority.log.1']);
  const total = readLines(`${file}.1`).length + readLines(file).length;
  assert.ok(total < n, 'the oldest lines went with the first .1');
  assert.strictEqual(alog.stats().written, n);
  assert.strictEqual(fs.statSync(`${file}.1`).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('a write that fails is reported once (a code) and never thrown; the record still ships', (t) => {
  const vc = virtualClock();
  const dir = tmpDir(t);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'blocked', 'authority.log');
  fs.writeFileSync(path.join(dir, 'blocked'), 'a file where the directory should be');
  const logs = [];
  const link = stubLink();
  const alog = createAuthorityLog({ file, link, now: vc.now, timers: vc.timers, log: (l) => logs.push(l) });
  alog.record(deny());
  alog.record(deny({ reason: 'ceiling' }));
  assert.doesNotThrow(() => alog.flush());
  alog.stop();
  assert.strictEqual(logs.filter((l) => l.startsWith('authority log write failed')).length, 1);
  assert.match(logs[0], /^authority log write failed code=[A-Z]+$/);
  assert.strictEqual(link.sent.flatMap((s) => s.body.records).length, 2);
});

// ── shipping over the link to the fake hub ─────────────────────────────────
test('records ship as schema-valid authority.log frames; records closed while the link was down go first after the reconnect, and none is sent twice once its send completed', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = await upLink(t, fake);
  const vc = virtualClock();
  const relay = new EventEmitter();
  const file = path.join(tmpDir(t), 'authority.log');
  const alog = install({ relay, link, authorityLogFile: file, now: vc.now, timers: vc.timers });
  t.after(() => alog.stop());

  relay.emit('deny', deny());
  relay.emit('deny', deny());
  relay.emit('deny', deny({ reason: 'level', need: 'message', rule: 'POST /api/queue/message', path: '/api/queue/message' }));
  vc.advance(WINDOW_MS);
  await fake.waitFor('authority.log');
  let frames = fake.find('authority.log', { dir: 'in' });
  assert.strictEqual(frames.length, 1, 'one frame for the two records');
  ajvSays(AUTH_LOG, frames[0].frame, 'the authority.log frame');
  assert.strictEqual(frames[0].ok, true);
  assert.strictEqual(frames[0].frame.records.length, 2);
  for (const r of frames[0].frame.records) {
    ajvSays(DENY, r, 'record');
    assert.strictEqual(r.enforcer, 'connector');
    assert.strictEqual(r.sink, 'log');
  }
  assert.strictEqual(frames[0].frame.records[0].count, 2);

  // The connection stays up past the hold: the first records are shipped.
  vc.advance(HOLD_MS + 1000);
  assert.strictEqual(alog.stats().pending, 0);
  assert.strictEqual(alog.stats().shipped, 2);

  // The link drops; records close while it is down; they go first after.
  const closed = once(link, 'closed');
  fake.drop();
  await closed;
  relay.emit('deny', deny({ enforcer: 'daemon', reason: 'daemon-rule', rule: 'POST /api/render', need: 'write_page', path: '/api/render' }));
  relay.emit('deny', deny({ reason: 'expired', rule: null, need: null, decision_id: null }));
  vc.advance(WINDOW_MS);
  assert.strictEqual(fake.find('authority.log', { dir: 'in' }).length, 1, 'nothing sent while the link is down');
  assert.strictEqual(alog.stats().pending, 2);
  await once(link, 'ready');
  await waitUntil(() => fake.find('authority.log', { dir: 'in' }).length === 2, { timeoutMs: 5000 });
  frames = fake.find('authority.log', { dir: 'in' });
  assert.notStrictEqual(frames[1].link, frames[0].link, 'on the new link');
  const second = frames[1].frame.records;
  assert.deepStrictEqual(second.map((r) => r.reason), ['daemon-rule', 'expired']);
  assert.strictEqual(second[0].enforcer, 'daemon');
  const all = shippedRecords(fake);
  assert.strictEqual(all.length, 4, 'none sent twice');
  assert.strictEqual(new Set(all.map((r) => JSON.stringify(r))).size, 4);
});

test('a frame sent less than the hold before the link drops is sent again first after the reconnect (at least once)', async (t) => {
  const fake = await withFakeHub(t);
  const { link } = await upLink(t, fake);
  const vc = virtualClock();
  const relay = new EventEmitter();
  const alog = install({ relay, link, authorityLogFile: path.join(tmpDir(t), 'authority.log'), now: vc.now, timers: vc.timers });
  t.after(() => alog.stop());
  relay.emit('deny', deny({ reason: 'query', rule: 'GET /api/files/*', need: 'files', method: 'GET', path: '/api/files/x' }));
  vc.advance(WINDOW_MS);
  await fake.waitFor('authority.log');
  vc.advance(5000); // sent, but the connection has not yet stayed up the hold
  assert.strictEqual(alog.stats().in_flight, 1);
  const closed = once(link, 'closed');
  fake.drop();
  await closed;
  assert.strictEqual(alog.stats().in_flight, 0);
  relay.emit('deny', deny({ reason: 'ceiling' }));
  vc.advance(WINDOW_MS);
  await once(link, 'ready');
  await fake.waitFor('authority.log', { count: 2 });
  const second = fake.find('authority.log', { dir: 'in' })[1].frame.records;
  assert.deepStrictEqual(second.map((r) => r.reason), ['query', 'ceiling'], 'the unconfirmed record first, then the new one');
  vc.advance(HOLD_MS + 1000);
  assert.strictEqual(alog.stats().pending, 0);
  assert.strictEqual(alog.stats().resent, 1);
});

test('through the relay: a denied READ (a GET refused at status level) is logged and shipped; a no-decision refusal with no principal is written and not shipped', async (t) => {
  const fake = await withFakeHub(t);
  const { link, m } = await upLink(t, fake);
  const label = mintLabel();
  const relay = installRelay({
    link,
    targetOf: (l) => (l === label ? {
      running: true, root: os.tmpdir(), instance: 'x', rec: { pid: process.pid, port: 1 },
      origins: { surface: `https://chat-${label}.hub.test:8443`, answer: null, shell: 'https://hub.test:8443' }, secret: null,
    } : null),
    record: () => m.record,
    hintFor: () => 'hub hint',
    log: () => {},
  });
  t.after(() => relay.stop());
  const vc = virtualClock();
  const file = path.join(tmpDir(t), 'authority.log');
  const logs = [];
  const alog = install({ relay, link, authorityLogFile: file, now: vc.now, timers: vc.timers, log: (l) => logs.push(l) });
  t.after(() => alog.stop());

  const statusOnly = fake.decision({ chat: label, daemon_level: 'basic', levels: [], specifics: { status: true } });
  const r = await fake.relayHttp({ chat: label, method: 'GET', path: '/api/store?keys=a', decision: statusOnly });
  assert.strictEqual(r.status, 403);
  const none = await fake.relayHttp({ chat: label, method: 'GET', path: '/api/store', decisionRef: { decision_id: `dec_${mintLabel()}`, version: 1 } });
  assert.strictEqual(none.status, 403);
  vc.advance(WINDOW_MS);
  await fake.waitFor('authority.log');

  const lines = readLines(file);
  assert.strictEqual(lines.length, 2);
  const read = lines.find((l) => l.reason === 'level');
  assert.strictEqual(read.method, 'GET');
  assert.strictEqual(read.path, '/api/store');
  assert.strictEqual(read.need, 'read');
  assert.strictEqual(read.principal, statusOnly.principal.user);
  const nd = lines.find((l) => l.reason === 'no-decision');
  assert.strictEqual(nd.principal, null);
  assert.strictEqual(nd.decision_id, null);

  const shipped = shippedRecords(fake);
  assert.strictEqual(shipped.length, 1, 'the no-principal record is not shipped');
  assert.strictEqual(shipped[0].reason, 'level');
  assert.strictEqual(shipped[0].method, 'GET');
  assert.strictEqual(shipped[0].decision_id, statusOnly.decision_id);
  ajvSays(DENY, shipped[0], 'the read refusal');
  assert.strictEqual(alog.stats().local_only, 1);
  assert.ok(logs.includes('authority log record kept local code=no-principal'));
});

test('the queue holds at most its cap: past it the oldest are dropped, counted and told once; what is left ships oldest first', (t) => {
  const vc = virtualClock();
  const link = stubLink();
  link.state = 'backoff';
  const logs = [];
  const alog = createAuthorityLog({ file: path.join(tmpDir(t), 'authority.log'), link, now: vc.now, timers: vc.timers, log: (l) => logs.push(l), queueMax: 5 });
  t.after(() => alog.stop());
  for (let i = 0; i < 8; i++) alog.record(deny({ chat_id: id26(), path: `/api/x/${i}`, rule: null, need: null, reason: 'unknown', method: 'GET' }));
  alog.flush();
  assert.strictEqual(alog.stats().pending, 5);
  assert.strictEqual(alog.stats().dropped, 3);
  assert.deepStrictEqual(logs.filter((l) => l.includes('queue-full')), ['authority log queue full; oldest dropped code=queue-full']);
  assert.strictEqual(link.sent.length, 0, 'nothing sent while the link is down');
  link.state = 'up';
  link.emit('ready', {});
  const paths = link.sent.flatMap((s) => s.body.records).map((r) => r.path);
  assert.deepStrictEqual(paths, ['/api/x/3', '/api/x/4', '/api/x/5', '/api/x/6', '/api/x/7']);
  for (const s of link.sent) {
    assert.strictEqual(s.ch, 'events');
    assert.strictEqual(s.kind, 'authority.log');
  }
});

test('frames carry at most 200 records and go at most once a second', (t) => {
  const vc = virtualClock();
  const link = stubLink();
  // holdMs 0: nothing stays in flight, so only the rate holds the next frame.
  const alog = createAuthorityLog({ file: path.join(tmpDir(t), 'authority.log'), link, now: vc.now, timers: vc.timers, holdMs: 0 });
  t.after(() => alog.stop());
  for (let i = 0; i < 450; i++) alog.record(deny({ chat_id: id26(), path: `/api/x/${i}`, rule: null, need: null, reason: 'unknown', method: 'GET' }));
  alog.flush();
  vc.advance(0);
  assert.deepStrictEqual(link.sent.map((s) => s.body.records.length), [200, 200, 50]);
  for (const s of link.sent) ajvSays(AUTH_LOG, { ch: 'events', kind: 'authority.log', id: 'c1', seq: 1, ...s.body }, 'frame');
  alog.record(deny({ reason: 'ceiling' }));
  alog.flush();
  vc.advance(0);
  assert.strictEqual(link.sent.length, 3, 'the next frame waits for the second');
  vc.advance(1000);
  assert.strictEqual(link.sent.length, 4);
});

test('install: subscribes to the relay\'s deny, defaults the file to userPaths().connectorAuthorityLog, and stop detaches', (t) => {
  assert.throws(() => install({}), /relay/);
  const relay = new EventEmitter();
  const dir = tmpDir(t);
  const paths = { connectorAuthorityLog: path.join(dir, 'authority.log') };
  const alog = install({ relay, paths, link: null });
  assert.strictEqual(alog.file, paths.connectorAuthorityLog);
  assert.strictEqual(relay.listenerCount('deny'), 1);
  relay.emit('deny', deny());
  alog.stop();
  assert.strictEqual(relay.listenerCount('deny'), 0);
  assert.strictEqual(readLines(paths.connectorAuthorityLog).length, 1, 'stop closed the open window');
  relay.emit('deny', deny());
  assert.strictEqual(readLines(paths.connectorAuthorityLog).length, 1);
  assert.doesNotThrow(() => { const a = createAuthorityLog({ file: path.join(dir, 'b.log') }); a.record(null); a.record('x'); a.stop(); });
});

test('a record in flight at three 4400 closes is dropped from the queue and told once; another close never drops one', (t) => {
  const vc = virtualClock();
  const link = stubLink();
  const logs = [];
  const file = path.join(tmpDir(t), 'authority.log');
  const alog = createAuthorityLog({ file, link, now: vc.now, timers: vc.timers, log: (l) => logs.push(l) });
  t.after(() => alog.stop());
  alog.record(deny());
  alog.flush();
  vc.advance(0);
  assert.strictEqual(alog.stats().in_flight, 1);
  for (let i = 0; i < 5; i++) {
    link.emit('closed', { code: 1006, action: 'normal', delayMs: 0 });
    link.emit('ready', {});
  }
  assert.strictEqual(alog.stats().pending, 1, 'a dropped connection never drops a record');
  for (let i = 1; i <= POISON_CLOSES; i++) {
    link.emit('closed', { code: 4400, action: 'normal', delayMs: 0 });
    assert.strictEqual(alog.stats().pending, i < POISON_CLOSES ? 1 : 0);
    link.emit('ready', {});
  }
  assert.strictEqual(alog.stats().poisoned, 1);
  assert.deepStrictEqual(logs.filter((l) => l.includes('bad-frame')), ['authority log record dropped after protocol errors code=bad-frame']);
  assert.strictEqual(readLines(file).length, 1, 'it stays in the file');
  assert.strictEqual(link.sent.length, 5 + POISON_CLOSES, 'resent after each reconnect until dropped');
});

test('a record whose principal is valid but whose line breaks 04-deny-record\'s grammar is written and not shipped', (t) => {
  const vc = virtualClock();
  const link = stubLink();
  const logs = [];
  const file = path.join(tmpDir(t), 'authority.log');
  const alog = createAuthorityLog({ file, link, now: vc.now, timers: vc.timers, log: (l) => logs.push(l) });
  t.after(() => alog.stop());
  alog.record(deny({ origin: 'elsewhere' }));
  alog.record(deny({ chat_id: 'not-a-label' }));
  alog.record(deny({ chat_id: id26(), status: 200 })); // its own chat: not the first one's window
  alog.flush();
  vc.advance(0);
  assert.strictEqual(readLines(file).length, 3, 'every line is written');
  assert.strictEqual(link.sent.length, 0, 'none is shipped');
  assert.strictEqual(alog.stats().local_only, 3);
  assert.strictEqual(alog.stats().pending, 0);
  assert.ok(logs.includes('authority log record kept local code=invalid'));
});

test('stop detaches from the link: a later ready or closed changes nothing', (t) => {
  const vc = virtualClock();
  const link = stubLink();
  const alog = createAuthorityLog({ file: path.join(tmpDir(t), 'authority.log'), link, now: vc.now, timers: vc.timers });
  assert.strictEqual(link.listenerCount('ready'), 1);
  assert.strictEqual(link.listenerCount('closed'), 1);
  alog.stop();
  assert.strictEqual(link.listenerCount('ready'), 0);
  assert.strictEqual(link.listenerCount('closed'), 0);
});

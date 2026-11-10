'use strict';

// lib/connector/delivery.js (tranche 6, U728): queue delivery and the ledger
// (07 C-07.24 to C-07.29; 05 C-05.27, C-05.44 to C-05.46).
//
// The fake hub (test-support/fake-hub.js, U735) on 127.0.0.1:0 sends the
// queue.deliver frames over a real link (lib/connector/link.js, U716) and
// validates every frame both ways against the locked schemas (withFakeHub's
// t.after fails the test on one that does not pass). Every delivery goes
// through U717's relay (lib/connector/relay.js) to a daemon on loopback: the
// real one, built through createServer's seam with a relay secret (U741) and a
// connector record at ceiling full (U742), which echoes client_msg_id (U748);
// or a STUB daemon (health names this process and its own root's instance id,
// POST /api/queue/message answers what the test says, and never echoes the
// key) where the test must hold an answer, pick one, or see a daemon that
// does not echo.
//
// Nothing here dials a host but loopback, binds a reserved port, or touches
// the developer's HOME (npm test's sandbox and withTempHome / withServer).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter, once } = require('events');
const { withFakeHub, mintLabel, isReservedPort } = require('../test-support/fake-hub');
const { createValidator } = require('../test-support/contracts-loader');
const { withServer, withTempHome, waitUntil } = require('../test-support/helpers');
const { createLink } = require('../lib/connector/link');
const { createRelay } = require('../lib/connector/relay');
const { createLifecycle } = require('../lib/connector/lifecycle');
const { hubOrigin, newRecord, keyIdOf, fingerprintOf } = require('../lib/setup/connector');
const { versionsRecord, machineFacts } = require('../lib/connector/facts');
const connectedPolicy = require('../lib/core/connected-policy');
const { userPaths } = require('../lib/core/paths');
const { instanceId } = require('../lib/core/portfiles');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { LISTEN_HOST } = require('../lib/core/cors');
const { createServer } = require('../lib/server');
const {
  createDelivery, outcomeOf, ANSWER_WAIT_MS, LEDGER_MODE, MESSAGE_PATH,
} = require('../lib/connector/delivery');

const validator = createValidator({ folders: 'all' });
const S = 'https://web-chat-contracts/schemas/';
const QUEUE_ACK = validator.ajv.getSchema(`${S}07-ack.json#/$defs/queueAck`);
const DELIVER_FRAME = validator.ajv.getSchema(`${S}05-queue-deliver.json#/$defs/deliver`);
const ACTOR = JSON.parse(JSON.stringify(validator.view.examples.get('03-actor-header').data));

const SECRET = crypto.randomBytes(32).toString('hex');
const HUB = 'hub-test';
const TEXT = 'a private message the ledger must never hold 7f3a';
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SHELL = 'https://hub.test:8443';
const originsOf = (label) => ({
  surface: `https://chat-${label}.hub.test:8443`,
  answer: `https://chat-${label}-a.hub.test:8443`,
  shell: SHELL,
});

function ajvSays(v, data, what) {
  assert.ok(v(data), `${what}: ${JSON.stringify(v.errors)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hubMsgId() {
  const b = crypto.randomBytes(26);
  let s = 'hm_';
  for (let i = 0; i < 26; i++) s += CROCK[b[i] & 31];
  return s;
}
const ledgerFile = () => userPaths().connectorLedger(HUB);

// ── the machine and its link (as test/connector-relay.test.js) ─────────────
function machineOn(fake) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  const m = fake.addMachine({ publicKey: raw, name: 'Test machine' });
  const record = newRecord({ hubId: HUB, origin: hubOrigin(fake.url, { insecureLoopback: true }) });
  record.machine = { id: m.id, name: m.name };
  record.credential = {
    state: 'paired', algorithm: 'ed25519', key_file: userPaths().connectorKey(HUB),
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

// ── the real daemon: handed the secret, its record at ceiling full ────────
async function daemon(t) {
  let recordPath;
  const d = await withServer(t, {
    seed: () => {
      const dir = userPaths().connectorDir;
      fs.mkdirSync(dir, { recursive: true });
      recordPath = path.join(dir, `${HUB}.json`);
      writeJsonAtomic(recordPath, { record_version: 1, hub: { id: HUB }, ceiling: 'full' });
    },
    createServer: (o) => createServer({ ...o, relaySecret: SECRET, relaySecretVia: 'option', connectorRecord: recordPath }),
  });
  d.seen = tap(d.server);
  return d;
}

// Every HTTP request the daemon receives, before Express sees it.
function tap(server) {
  const seen = [];
  server.prependListener('request', (req) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
  });
  return seen;
}
const relayed = (seen) => seen.filter((e) => e.headers['x-wc-remote'] === '1');
const messagePosts = (seen) => relayed(seen).filter((e) => e.method === 'POST' && e.url === MESSAGE_PATH);

// ── the stub daemon: never echoes client_msg_id ───────────────────────────
// s.answer(body, post) → {status, body} (answered at once), or the same with
// hold: true (answered when the test calls s.release()).
async function stubDaemon(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-delivery-stub-'));
  const s = { root, posts: [], held: [], boot: 'stub-boot-1', answer: null };
  let n = 0;
  s.okAnswer = () => {
    n += 1;
    return { status: 200, body: { ok: true, id: `q${n}`, msg_id: `m-${(0xa0000000 + n).toString(16)}`, mode: 'queued' } };
  };
  s.release = () => { const h = s.held.shift(); if (h) h(); return Boolean(h); };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'instance', pid: process.pid, instance: instanceId(root), boot: s.boot }));
      return;
    }
    if (req.method === 'POST' && req.url === MESSAGE_PATH) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        const post = { headers: { ...req.headers }, body, at: Date.now(), answeredAt: null };
        s.posts.push(post);
        const a = s.answer ? s.answer(body, post) : s.okAnswer();
        const reply = () => {
          post.answeredAt = Date.now();
          res.writeHead(a.status, { 'content-type': 'application/json', 'x-wc-boot': s.boot });
          res.end(JSON.stringify(a.body));
        };
        if (a.hold) s.held.push(reply); else reply();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  for (let i = 0; ; i++) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, LISTEN_HOST, resolve); });
    if (!isReservedPort(server.address().port)) break;
    await new Promise((r) => server.close(r));
    if (i > 4) throw new Error('stub daemon: only reserved ports');
  }
  t.after(async () => {
    while (s.release()) { /* answer what is held so nothing hangs */ }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, port: server.address().port, s, server };
}

// A lifecycle over an in-memory record (applySettings / isPaused are its own).
function memoryLifecycle(rec) {
  let cur = JSON.parse(JSON.stringify(rec));
  return createLifecycle({
    supervisor: { ensureRunning: async () => null, startedBy: () => null, forget: () => {} },
    hubId: HUB,
    deps: {
      record: {
        readRecord: () => ({ ok: true, value: cur }),
        updateRecord: (_id, fn) => {
          const next = fn(JSON.parse(JSON.stringify(cur)));
          if (next) cur = next;
          return next;
        },
      },
    },
  });
}

// A link stand-in for frames handed to deliver() directly: it records acks
// (or throws on them).
function ackSink({ throws = false } = {}) {
  const l = new EventEmitter();
  l.acks = [];
  l.send = (ch, kind, body, opts) => {
    if (throws) throw Object.assign(new Error('the link refused the ack'), { code: 'ELINKDOWN' });
    l.acks.push({ ch, kind, ack: body.ack, re: opts && opts.re });
    return `c${l.acks.length}`;
  };
  return l;
}

// The real link, but its first queue.ack is lost (returns null, as a link
// that is not up does): the hub then replays after a drop.
function losingFirstAck(link) {
  const p = { lost: [] };
  p.channel = (...a) => link.channel(...a);
  p.on = (...a) => { link.on(...a); return p; };
  p.send = (ch, kind, body, opts) => {
    if (kind === 'queue.ack' && p.lost.length === 0) { p.lost.push(body.ack); return null; }
    return link.send(ch, kind, body, opts);
  };
  return p;
}

// One delivery over a link to the fake, its target a daemon (real or stub).
async function setup(t, { stub = false, wrapLink, deps } = {}) {
  withTempHome(t);
  const fake = await withFakeHub(t);
  assert.ok(!isReservedPort(fake.port), `the fake's port ${fake.port} is outside the band`);
  const m = machineOn(fake);
  const logs = [];
  const link = await upLink(t, fake, m, logs);
  const d = stub ? await stubDaemon(t) : await daemon(t);
  const label = mintLabel();
  const c = { fake, link, d, label, logs, m, running: true, calls: [] };
  c.target = {
    running: true, root: d.root, instance: instanceId(d.root), rec: { pid: process.pid, port: d.port },
    origins: originsOf(label), secret: SECRET,
  };
  c.relay = createRelay({
    link,
    targetOf: (l) => (l === label && c.running ? c.target : null),
    record: () => m.record,
    hintFor: () => 'not allowed through the hub',
    log: (line) => logs.push(line),
  });
  t.after(() => c.relay.stop());
  // A spy on the relay: every call delivery.js makes, by name.
  c.spy = { request: (q) => { c.calls.push(q); return c.relay.request(q); } };
  c.lifecycle = memoryLifecycle(m.record);
  c.delivery = createDelivery({
    relay: c.spy, ring: { cursorOf: () => null }, lifecycle: c.lifecycle, hubId: HUB, log: (line) => logs.push(line), deps,
  });
  c.ackLink = wrapLink ? wrapLink(link) : link;
  t.after(c.delivery.install({ link: c.ackLink }));
  c.decision = (o = {}) => fake.decision({ chat: label, ...o });
  let fid = 0;
  // A queue.deliver frame as the fake would send it, for deliver() directly.
  c.frame = ({ hub = hubMsgId(), attempt = 1, message = { text: TEXT, send: 'hold' }, within, decision, from } = {}) => {
    fid += 1;
    const delivery = {
      type: 'queue.deliver', hub_msg_id: hub, chat_id: label, attempt, enqueued_at: Date.now(), message,
      ...(within != null ? { deliver_within_ms: within } : {}),
      ...(from !== undefined ? { from } : {}),
    };
    const f = { ch: 'queue', kind: 'queue.deliver', id: `f${fid}`, seq: fid, delivery, actor: ACTOR, decision: decision || c.decision() };
    ajvSays(DELIVER_FRAME, f, 'the hand-built queue.deliver');
    return f;
  };
  return c;
}

const acksIn = (fake) => fake.find('queue.ack', { dir: 'in' }).map((e) => e.frame.ack);
const noText = (s, what) => assert.ok(!String(s).includes(TEXT), `${what} carries no message text`);

// ── the outcome table, pure ────────────────────────────────────────────────
test('outcomeOf: C-07.27\'s table over a relay.request answer', () => {
  const j = (status, body, headers = {}) => ({ status, headers, body: Buffer.from(JSON.stringify(body)) });
  const H = 'hm_01JBF7A0B1C2D3E4F5G6H7J8K9';
  let o = outcomeOf(j(200, { ok: true, id: 'q1', msg_id: 'm-0000abcd', mode: 'held', client_msg_id: H }, { 'x-wc-boot': 'b1' }), H);
  assert.deepStrictEqual(o, { outcome: 'accepted', msg_id: 'm-0000abcd', item_id: 'q1', mode: 'held', echoed: true, boot: 'b1' });
  o = outcomeOf(j(200, { ok: true, id: 'q1', msg_id: 'm-0000abcd', duplicate: true }), H);
  assert.strictEqual(o.outcome, 'duplicate');
  assert.strictEqual(o.echoed, false);
  assert.deepStrictEqual(outcomeOf(j(200, { ok: false, refused: 'rate_limited', retry_after: 3 }), H), { outcome: 'retry', retry_after_ms: 3000, refused: 'rate_limited' });
  assert.ok(outcomeOf(j(200, { ok: false, refused: 'too_many', max: 20 }), H).retry_after_ms >= 5000);
  assert.deepStrictEqual(outcomeOf(j(200, { ok: false, refused: 'file_refused', why: 'unavailable' }), H), { outcome: 'retry', retry_after_ms: 10000, refused: 'file_refused' });
  assert.deepStrictEqual(outcomeOf(j(200, { ok: false, refused: 'file_refused', why: 'outside' }), H), { outcome: 'refused', refused: 'file_refused' });
  assert.deepStrictEqual(outcomeOf(j(200, { ok: false, refused: 'disabled' }), H), { outcome: 'refused', refused: 'disabled' });
  assert.deepStrictEqual(outcomeOf(null, H), { outcome: 'retry', retry_after_ms: 10000 });
  assert.deepStrictEqual(outcomeOf({ status: 502, headers: {}, body: Buffer.alloc(0) }, H), { outcome: 'retry', retry_after_ms: 10000 });
  assert.deepStrictEqual(outcomeOf(j(404, { ok: false, connector: true, reason: 'not-running' }), H), { outcome: 'retry', retry_after_ms: 10000 });
  assert.deepStrictEqual(outcomeOf(j(403, { ok: false, remote: true, hint: 'h', authority: { reason: 'no-decision' } }), H), { outcome: 'refused', refused: 'no_decision' });
  assert.deepStrictEqual(outcomeOf(j(200, { ok: true, id: 'q1' }), H), { outcome: 'refused', refused: 'bad_answer' });
});

// ── the main path, against the real daemon ─────────────────────────────────
test('a queue.deliver reaches the daemon\'s queue once as a relayed POST at the decision\'s level (origin remote, the body\'s device, the frame\'s actor, never `from`); the ack is accepted with the daemon\'s msg_id, dedupe daemon, and the ledger holds ids only at 0600', async (t) => {
  const c = await setup(t);
  const from = { class: 'user', id: 'u_somebody_else' };
  const held = c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold', device: 'mobile' }, from });
  const ackFrame = await c.fake.waitFor('queue.ack', { dir: 'in' });
  const deliverFrame = c.fake.find('queue.deliver', { dir: 'out' })[0].frame;
  assert.strictEqual(ackFrame.frame.re, deliverFrame.id, 'the ack answers the frame');
  const ack = ackFrame.frame.ack;
  ajvSays(QUEUE_ACK, ack, 'queue.ack');
  assert.strictEqual(ack.outcome, 'accepted');
  assert.strictEqual(ack.hub_msg_id, held.hub_msg_id);
  assert.strictEqual(ack.attempt, 1);
  assert.strictEqual(ack.dedupe, 'daemon');

  // The daemon's queue holds it once, as a relayed remote push from a phone.
  const items = (await c.d.api.get('/api/queue')).json.items.filter((it) => it.msg_id === ack.daemon.msg_id);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, ack.daemon.item_id);
  assert.strictEqual(items[0].origin, 'remote');
  assert.strictEqual(items[0].device, 'mobile');
  assert.strictEqual(ack.daemon.boot, (await c.d.api.get('/api/health')).json.boot);

  // One relayed POST, stamped by the relay at the decision's level, its actor the frame's.
  const posts = messagePosts(c.d.seen);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].headers['x-wc-level'], 'full');
  assert.strictEqual(posts[0].headers['x-wc-relay'], SECRET);
  assert.strictEqual(posts[0].headers['x-wc-decision'], deliverFrame.decision.decision_id);
  assert.strictEqual(posts[0].headers['x-wc-actor'], JSON.stringify(deliverFrame.actor));
  assert.notStrictEqual(posts[0].headers['x-wc-actor'], JSON.stringify(from));
  assert.ok(!posts[0].headers['x-wc-actor'].includes('u_somebody_else'), 'from never reaches the actor header');

  // relay.request, by name, once: the frame's chat, decision and actor.
  assert.strictEqual(c.calls.length, 1);
  const q = c.calls[0];
  assert.strictEqual(q.chat, c.label);
  assert.deepStrictEqual(q.decision, deliverFrame.decision);
  assert.strictEqual(q.method, 'POST');
  assert.strictEqual(q.path, '/api/queue/message');
  assert.strictEqual(q.surface, 'session');
  assert.deepStrictEqual(q.actor, deliverFrame.actor);
  assert.deepStrictEqual(JSON.parse(q.body.toString('utf8')), { text: TEXT, send: 'hold', device: 'mobile', client_msg_id: held.hub_msg_id });

  // The ledger: ids and the boot, 0600, never text.
  const raw = fs.readFileSync(ledgerFile(), 'utf8');
  noText(raw, 'the ledger');
  assert.strictEqual(fs.statSync(ledgerFile()).mode & 0o777, LEDGER_MODE);
  const led = JSON.parse(raw);
  assert.deepStrictEqual(led.entries, [{
    hub_msg_id: held.hub_msg_id, msg_id: ack.daemon.msg_id, item_id: ack.daemon.item_id, boot: ack.daemon.boot, dedupe: 'daemon',
  }]);
  noText(c.logs.join('\n'), 'the log');
  noText(JSON.stringify(ack), 'the ack');
});

test('the ack is sent only after the daemon answered: none while the POST is held, then one, after the answer', async (t) => {
  const c = await setup(t, { stub: true });
  const { s } = c.d;
  s.answer = () => ({ ...s.okAnswer(), hold: true });
  c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold' } });
  await waitUntil(() => s.posts.length === 1, { timeout: 5000, what: 'the POST' });
  await sleep(300);
  assert.strictEqual(acksIn(c.fake).length, 0, 'no ack while the daemon has not answered');
  assert.ok(s.release());
  const f = await c.fake.waitFor('queue.ack', { dir: 'in' });
  assert.ok(s.posts[0].answeredAt != null && f.at >= s.posts[0].answeredAt, 'the fake records the ack after the answer');
  ajvSays(QUEUE_ACK, f.frame.ack, 'queue.ack');
  assert.strictEqual(f.frame.ack.outcome, 'accepted');
  assert.strictEqual(f.frame.ack.dedupe, 'connector', 'the stub does not echo client_msg_id');
  assert.strictEqual(f.frame.ack.daemon.boot, s.boot, 'the boot from the answer\'s boot header');
});

// ── exactly once (C-07.29) ─────────────────────────────────────────────────
test('a replayed hub_msg_id against the echoing daemon: the daemon answers the second POST duplicate, the ack reads duplicate with dedupe daemon, and the queue holds it once', async (t) => {
  const c = await setup(t, { wrapLink: losingFirstAck });
  const held = c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold' } });
  await waitUntil(() => c.ackLink.lost.length === 1, { timeout: 5000, what: 'the first (lost) ack' });
  const first = c.ackLink.lost[0];
  assert.strictEqual(first.outcome, 'accepted');
  c.fake.drop();
  const f = await c.fake.waitFor('queue.ack', { dir: 'in', timeoutMs: 15000 });
  const ack = f.frame.ack;
  ajvSays(QUEUE_ACK, ack, 'the replay\'s ack');
  assert.strictEqual(ack.hub_msg_id, held.hub_msg_id);
  assert.strictEqual(ack.attempt, 2, 'the fake replayed attempt 2');
  assert.strictEqual(ack.outcome, 'duplicate');
  assert.strictEqual(ack.dedupe, 'daemon');
  assert.strictEqual(ack.daemon.msg_id, first.daemon.msg_id, 'the first msg_id');
  assert.strictEqual(messagePosts(c.d.seen).length, 2, 'the daemon deduplicated the second POST');
  const items = (await c.d.api.get('/api/queue')).json.items.filter((it) => it.msg_id === first.daemon.msg_id);
  assert.strictEqual(items.length, 1, 'enqueued once');
  assert.strictEqual((await c.d.api.get('/api/queue')).json.items.length, 1);
});

test('a replayed hub_msg_id against a daemon that does not echo: the ledger answers duplicate with dedupe connector and no second POST', async (t) => {
  const c = await setup(t, { stub: true, wrapLink: losingFirstAck });
  const held = c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold' } });
  await waitUntil(() => c.ackLink.lost.length === 1, { timeout: 5000, what: 'the first (lost) ack' });
  const first = c.ackLink.lost[0];
  assert.strictEqual(first.outcome, 'accepted');
  assert.strictEqual(first.dedupe, 'connector');
  c.fake.drop();
  const f = await c.fake.waitFor('queue.ack', { dir: 'in', timeoutMs: 15000 });
  const ack = f.frame.ack;
  ajvSays(QUEUE_ACK, ack, 'the replay\'s ack');
  assert.strictEqual(ack.attempt, 2);
  assert.strictEqual(ack.outcome, 'duplicate');
  assert.strictEqual(ack.dedupe, 'connector');
  assert.deepStrictEqual(ack.daemon, { boot: c.d.s.boot, msg_id: first.daemon.msg_id, item_id: first.daemon.item_id });
  assert.strictEqual(c.d.s.posts.length, 1, 'no second POST');
  assert.strictEqual(c.calls.length, 1, 'one relay.request');
  assert.strictEqual(c.delivery.ledgerOf(held.hub_msg_id).dedupe, 'connector');
});

test('a link that closes while the daemon answers gets no ack for that frame; the replay waits for the answer and the ledger answers it duplicate', async (t) => {
  const c = await setup(t, { stub: true });
  const { s } = c.d;
  s.answer = () => ({ ...s.okAnswer(), hold: true });
  const held = c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold' } });
  await waitUntil(() => s.posts.length === 1, { timeout: 5000, what: 'the POST' });
  const ready = once(c.link, 'ready');
  c.fake.drop();
  await ready;
  await waitUntil(() => c.fake.find('queue.deliver', { dir: 'out' }).length === 2, { timeout: 5000, what: 'the replay' });
  s.answer = null;
  s.release();
  const f = await c.fake.waitFor('queue.ack', { dir: 'in' });
  await sleep(200);
  const acks = acksIn(c.fake);
  assert.strictEqual(acks.length, 1, 'one ack, for the replay only');
  assert.deepStrictEqual([f.frame.ack.attempt, f.frame.ack.outcome, f.frame.ack.dedupe], [2, 'duplicate', 'connector']);
  assert.strictEqual(f.frame.ack.hub_msg_id, held.hub_msg_id);
  assert.strictEqual(c.fake.find('control.error', { dir: 'out' }).length, 0, 'no stray ack answered not_allowed');
  assert.strictEqual(s.posts.length, 1, 'one POST');
});

test('the ledger is written before the ack: a link that throws on the ack still leaves the entry (hub_msg_id, msg_id, boot), at 0600, without text', async (t) => {
  const c = await setup(t);
  const sink = ackSink({ throws: true });
  const f = c.frame();
  const sent = await c.delivery.deliver(f, sink);
  assert.strictEqual(sent, null, 'no ack went');
  const e = c.delivery.ledgerOf(f.delivery.hub_msg_id);
  assert.ok(e, 'the entry is there');
  assert.match(e.msg_id, /^m-[0-9a-f]{8}$/);
  assert.strictEqual(e.boot, (await c.d.api.get('/api/health')).json.boot);
  const onDisk = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')).entries;
  assert.deepStrictEqual(onDisk.map((x) => [x.hub_msg_id, x.msg_id, x.boot]), [[f.delivery.hub_msg_id, e.msg_id, e.boot]]);
  assert.strictEqual(fs.statSync(ledgerFile()).mode & 0o777, LEDGER_MODE);
  noText(fs.readFileSync(ledgerFile(), 'utf8'), 'the ledger');
  assert.strictEqual((await c.d.api.get('/api/queue')).json.items.filter((it) => it.msg_id === e.msg_id).length, 1);
});

// ── C-07.27's outcomes ─────────────────────────────────────────────────────
test('outcomes through the relay: rate_limited → retry after retry_after, too_many → retry ≥ 5 s, file_refused unavailable → retry 10 s, any other word → refused with it; nothing but ok reaches the ledger', async (t) => {
  const c = await setup(t, { stub: true });
  const { s } = c.d;
  const cases = [
    [{ ok: false, refused: 'rate_limited', retry_after: 7, hint: '' }, { outcome: 'retry', retry_after_ms: 7000, refused: 'rate_limited' }],
    [{ ok: false, refused: 'too_many', max: 20, hint: '' }, { outcome: 'retry', refused: 'too_many' }, (a) => a.retry_after_ms >= 5000],
    [{ ok: false, refused: 'file_refused', why: 'unavailable', path: 'a.js', hint: '' }, { outcome: 'retry', retry_after_ms: 10000, refused: 'file_refused' }],
    [{ ok: false, refused: 'file_refused', why: 'outside', path: '../a', hint: '' }, { outcome: 'refused', refused: 'file_refused' }],
    [{ ok: false, refused: 'empty', hint: '' }, { outcome: 'refused', refused: 'empty' }],
    [{ ok: false, refused: 'disabled', hint: '' }, { outcome: 'refused', refused: 'disabled' }],
    [{ status: 500, body: { ok: false } }, { outcome: 'retry', retry_after_ms: 10000 }],
  ];
  for (const [answer, want, extra] of cases) {
    s.answer = () => (answer.status ? answer : { status: 200, body: answer });
    const sink = ackSink();
    const f = c.frame();
    const ack = await c.delivery.deliver(f, sink);
    const what = JSON.stringify(answer);
    assert.ok(ack, `an ack for ${what}`);
    ajvSays(QUEUE_ACK, ack, `the ack for ${what}`);
    assert.deepStrictEqual(sink.acks.map((a) => a.ack), [ack]);
    assert.strictEqual(sink.acks[0].re, f.id);
    for (const [k, v] of Object.entries(want)) assert.strictEqual(ack[k], v, `${k} for ${what}`);
    if (extra) assert.ok(extra(ack), `the bound for ${what}`);
    assert.strictEqual(ack.daemon, undefined);
    assert.strictEqual(c.delivery.ledgerOf(f.delivery.hub_msg_id), null);
  }
  assert.strictEqual(s.posts.length, cases.length);
});

test('a daemon not running, or not answering, is retry after 10 s with no ack before the relay answered', async (t) => {
  const c = await setup(t, { stub: true });
  // Not running here (the relay's gate step 1, before any daemon).
  c.running = false;
  let sink = ackSink();
  let ack = await c.delivery.deliver(c.frame(), sink);
  ajvSays(QUEUE_ACK, ack, 'not running');
  assert.deepStrictEqual([ack.outcome, ack.retry_after_ms], ['retry', 10000]);
  assert.strictEqual(c.d.s.posts.length, 0);
  // Stopped: the port answers nothing (the identity probe fails; 502).
  c.running = true;
  const gone = http.createServer();
  await new Promise((r) => gone.listen(0, LISTEN_HOST, r));
  const port = gone.address().port;
  await new Promise((r) => gone.close(r));
  c.target = { ...c.target, rec: { ...c.target.rec, port } };
  sink = ackSink();
  ack = await c.delivery.deliver(c.frame(), sink);
  ajvSays(QUEUE_ACK, ack, 'stopped');
  assert.deepStrictEqual([ack.outcome, ack.retry_after_ms], ['retry', 10000]);
  assert.strictEqual(c.d.s.posts.length, 0);
});

test('deliver_within_ms 0 is expired with no POST', async (t) => {
  const c = await setup(t, { stub: true });
  c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold' }, deliver_within_ms: 0 });
  const f = await c.fake.waitFor('queue.ack', { dir: 'in' });
  ajvSays(QUEUE_ACK, f.frame.ack, 'expired');
  assert.strictEqual(f.frame.ack.outcome, 'expired');
  assert.strictEqual(c.d.s.posts.length, 0);
  assert.strictEqual(c.calls.length, 0, 'no relay.request');
});

test('the relay\'s gate refuses above the decision\'s level before the daemon: refused with the gate\'s word', async (t) => {
  const c = await setup(t, { stub: true });
  c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold' } }, { decision: c.decision({ daemon_level: 'read' }) });
  const f = await c.fake.waitFor('queue.ack', { dir: 'in' });
  ajvSays(QUEUE_ACK, f.frame.ack, 'gate refusal');
  assert.deepStrictEqual([f.frame.ack.outcome, f.frame.ack.refused], ['refused', 'level']);
  assert.strictEqual(c.d.s.posts.length, 0, 'nothing reached the daemon');
  assert.strictEqual(c.calls.length, 1);
});

// ── pause (05 C-05.27, ruling W3) ──────────────────────────────────────────
test('paused: a delivery is answered retry with the word paused and no POST; a Stop through the relay still reaches the daemon; after the resume the hub\'s redelivery is accepted', async (t) => {
  const c = await setup(t);
  assert.strictEqual(c.lifecycle.applySettings({ rev: 1, paused: true }).applied, true);
  assert.strictEqual(c.lifecycle.isPaused(), true);
  const held = c.fake.queue.hold(c.label, { message: { text: TEXT, send: 'hold' } });
  const f = await c.fake.waitFor('queue.ack', { dir: 'in' });
  c.fake.settings({ paused: true }); // the hub withholds from here (its retry of 0 ms may have redelivered meanwhile)
  ajvSays(QUEUE_ACK, f.frame.ack, 'paused');
  assert.deepStrictEqual(
    { outcome: f.frame.ack.outcome, refused: f.frame.ack.refused, retry_after_ms: f.frame.ack.retry_after_ms },
    { outcome: 'retry', refused: 'paused', retry_after_ms: 0 },
  );
  await sleep(100);
  for (const a of acksIn(c.fake)) assert.deepStrictEqual([a.outcome, a.refused], ['retry', 'paused']);
  assert.strictEqual(messagePosts(c.d.seen).length, 0, 'no POST while paused');
  assert.strictEqual(c.calls.length, 0);

  // W3: a paused chat can still be stopped (a relayed control at Message).
  const r = await c.fake.relayHttp({
    chat: c.label, method: 'POST', path: '/api/queue/task-stop',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: 'bxyz12345' }), decision: c.decision(),
  });
  assert.ok(r.status < 500 && r.status !== 403 && r.status !== 404, `the daemon answered the Stop (${r.status})`);
  assert.strictEqual(relayed(c.d.seen).filter((e) => e.method === 'POST' && e.url === '/api/queue/task-stop').length, 1, 'the Stop reached the daemon');

  // The resume: the hub redelivers and the delivery goes through.
  c.lifecycle.applySettings({ rev: 2, paused: false });
  c.fake.settings({ paused: false });
  await waitUntil(() => acksIn(c.fake).some((a) => a.outcome === 'accepted'), { timeout: 5000, what: 'the accepted redelivery' });
  const ok = acksIn(c.fake).find((a) => a.outcome === 'accepted');
  assert.strictEqual(ok.hub_msg_id, held.hub_msg_id);
  assert.strictEqual(messagePosts(c.d.seen).length, 1);
});

// ── order and the 30 s rule ────────────────────────────────────────────────
test('two deliveries for one chat are POSTed in arrival order, the second only after the first answered', async (t) => {
  const c = await setup(t, { stub: true });
  const { s } = c.d;
  s.answer = () => ({ ...s.okAnswer(), hold: true });
  const sink = ackSink();
  const f1 = c.frame();
  const f2 = c.frame();
  const p1 = c.delivery.deliver(f1, sink);
  const p2 = c.delivery.deliver(f2, sink);
  await waitUntil(() => s.posts.length === 1, { timeout: 5000, what: 'the first POST' });
  await sleep(300);
  assert.strictEqual(s.posts.length, 1, 'the second waits for the first answer');
  assert.strictEqual(sink.acks.length, 0);
  s.release();
  await p1;
  await waitUntil(() => s.posts.length === 2, { timeout: 5000, what: 'the second POST' });
  assert.ok(s.posts[1].at >= s.posts[0].answeredAt);
  s.release();
  await p2;
  assert.deepStrictEqual(s.posts.map((p) => p.body.client_msg_id), [f1.delivery.hub_msg_id, f2.delivery.hub_msg_id]);
  assert.deepStrictEqual(sink.acks.map((a) => a.ack.hub_msg_id), [f1.delivery.hub_msg_id, f2.delivery.hub_msg_id]);
});

test('a POST the daemon does not answer within the wait is not acked; its late answer still writes the ledger, which answers the replay', async (t) => {
  const c = await setup(t, {
    stub: true,
    deps: { setTimeout: (fn, ms) => setTimeout(fn, ms === ANSWER_WAIT_MS ? 150 : ms), clearTimeout },
  });
  const { s } = c.d;
  s.answer = () => ({ ...s.okAnswer(), hold: true });
  const sink = ackSink();
  const f = c.frame();
  const sent = await c.delivery.deliver(f, sink);
  assert.strictEqual(sent, null);
  assert.strictEqual(sink.acks.length, 0, 'no ack: the message stays delivering at the hub');
  assert.strictEqual(c.delivery.ledgerOf(f.delivery.hub_msg_id), null);
  // The hub replays while the first POST is still unanswered: the replay waits
  // for that answer instead of posting again.
  const replay = c.frame({ hub: f.delivery.hub_msg_id, attempt: 2 });
  const p = c.delivery.deliver(replay, sink);
  await sleep(200);
  assert.strictEqual(s.posts.length, 1, 'the replay did not post');
  s.answer = null;
  s.release();
  const ack = await p;
  assert.ok(c.delivery.ledgerOf(f.delivery.hub_msg_id), 'the late answer wrote the ledger');
  ajvSays(QUEUE_ACK, ack, 'the replay');
  assert.deepStrictEqual([ack.outcome, ack.dedupe, ack.attempt], ['duplicate', 'connector', 2]);
  assert.deepStrictEqual(sink.acks.map((a) => a.ack.attempt), [2], 'only the replay was acked');
  assert.strictEqual(s.posts.length, 1);
});

test('the frame\'s `from` is never read, and the POST body carries only the message fields and client_msg_id', async (t) => {
  const c = await setup(t, { stub: true });
  const f = c.frame({ message: { text: TEXT, skill: null, files: [], send: 'auto', conversation_id: null, device: 'desktop' } });
  let read = false;
  Object.defineProperty(f.delivery, 'from', { enumerable: true, get() { read = true; return { class: 'user', id: 'u_trap' }; } });
  const ack = await c.delivery.deliver(f, ackSink());
  assert.strictEqual(ack.outcome, 'accepted');
  assert.strictEqual(read, false, 'from was never read');
  assert.deepStrictEqual(Object.keys(c.d.s.posts[0].body).sort(), ['client_msg_id', 'conversation_id', 'device', 'files', 'send', 'skill', 'text']);
  assert.strictEqual(c.d.s.posts[0].headers['x-wc-actor'], JSON.stringify(ACTOR));
});

// ── the source ─────────────────────────────────────────────────────────────
test('lib/connector/delivery.js spells no header of the relay\'s, sends no Push, and reaches a daemon only through relay.request', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'connector', 'delivery.js'), 'utf8');
  assert.ok(!/x-wc-/i.test(src), 'no X-WC-* header spelled');
  assert.ok(!/queue\/push|queue\.push/.test(src), 'no Push');
  assert.ok(!/require\(['"]\.\.\/client['"]\)|http\.request|require\(['"]https?['"]\)/.test(src), 'no daemon request of its own');
  assert.ok(/relay\.request\(/.test(src), 'relay.request by name');
  assert.ok(!/\.from\b(?!\()/.test(src.replace(/Buffer\.from/g, '')), 'no read of `from`');
});

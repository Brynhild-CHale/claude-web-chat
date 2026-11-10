// U748 — client_msg_id and mod_attached (07 C-07.29, 05 C-05.45, 06 C-06.24 /
// Q-06.6).
//
// POST /api/queue/message answers a repeated client_msg_id as a duplicate
// FIRST — before the disabled refusal, validation, the queue bound and the
// rate limit — with the first item's id and msg_id, enqueueing nothing; it
// records every accepted id durably (the last 1000, through writeJsonAtomic,
// before the ok) and echoes the key in every ok answer. GET /api/queue/policy
// reports mod_attached from ctx.bridge.any().
//
// Two harnesses: the routes on a bare Express app with a fake ctx (the shape
// of test/queue-messages.test.js), and the real daemon through withServer for
// the restart.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { createBus } = require('../lib/core/bus');
const queue = require('../lib/server/domain/queue');
const { mountQueueRoutes } = require('../lib/server/routes/queue');
const { createAcceptedMessages, ACCEPTED_MAX } = require('../lib/server/domain/accepted-messages');
const composer = require('../lib/server/composer');
const { projectPaths } = require('../lib/core/paths');
const { withServer, tmpRoot } = require('../test-support/helpers');

const CID = 'hub-msg-0001';

function freshState() {
  return {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: 1, wakeConsumerSeenAt: Date.now(),
    pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}

function fakeMirror() {
  const m = { on: { enabled: true } };
  m.enabled = () => m.on;
  return m;
}

// A plain loopback request is local (every level).
const localAudience = () => ({
  levelOf: () => 'local',
  requireMirror: () => (req, res, next) => next(),
});

async function host(t, { root = null, acceptedMessages, bridge, now } = {}) {
  const state = freshState();
  const bus = createBus({ bootId: 'boot-1' });
  bus.setBroadcaster(() => {});
  const mirror = fakeMirror();
  const ctx = {
    state, bus, graph: { lock: null, active: 'n0', saveMeta() {} }, mirror,
    audience: localAudience(), skills: { resolve: () => null }, projectFiles: { check: () => ({ ok: false, why: 'missing' }) },
  };
  if (root) ctx.root = root;
  if (acceptedMessages) ctx.acceptedMessages = acceptedMessages;
  if (bridge !== undefined) ctx.bridge = bridge;
  const app = express();
  app.use(express.json());
  mountQueueRoutes(app, ctx, now ? { now } : undefined);
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const send = (body) => call('POST', '/api/queue/message', body);
  const messages = () => state.queue.filter(queue.isMessage);
  return { state, ctx, mirror, call, send, messages };
}

test('a client_msg_id is echoed; the same id again is a duplicate with the first item\'s ids, and the queue holds one', async (t) => {
  const h = await host(t);
  const first = await h.send({ text: 'hello from the hub', send: 'hold', client_msg_id: CID });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.client_msg_id, CID, 'the key is echoed');
  assert.equal(first.json.mode, 'held');
  assert.equal(first.json.duplicate, undefined);
  assert.equal(h.messages().length, 1);
  assert.equal(h.messages()[0].client_msg_id, CID, 'the id is stored on the item');
  assert.equal('client_msg_id' in queue.publicItem(h.messages()[0]), false, 'the projection is unchanged');

  const again = await h.send({ text: 'hello from the hub', send: 'hold', client_msg_id: CID });
  assert.deepEqual(again.json, { ok: true, id: first.json.id, msg_id: first.json.msg_id, duplicate: true, client_msg_id: CID });
  assert.equal(h.messages().length, 1, 'nothing enqueued');

  // Every ok answer echoes it: now and auto as well as hold.
  for (const mode of ['now', 'auto']) {
    const cid = `hub-msg-echo-${mode}`;
    const r = await h.send({ text: `go ${mode}`, send: mode, client_msg_id: cid });
    assert.equal(r.json.ok, true, r.text);
    assert.equal(r.json.client_msg_id, cid, `${mode}: echoed`);
  }
});

test('two concurrent sends of one client_msg_id enqueue once', async (t) => {
  const h = await host(t);
  const body = { text: 'twice at once', send: 'hold', client_msg_id: 'hub-msg-race' };
  const [a, b] = await Promise.all([h.send(body), h.send(body)]);
  assert.equal(a.json.ok, true);
  assert.equal(b.json.ok, true);
  assert.equal([a, b].filter((r) => r.json.duplicate === true).length, 1, 'one of them is the duplicate');
  assert.equal(a.json.id, b.json.id);
  assert.equal(a.json.msg_id, b.json.msg_id);
  assert.equal(h.messages().length, 1);
});

test('the order of checks: a repeat is a duplicate while disabled, invalid, at the bound and rate limited; a new id is refused as today', async (t) => {
  // disabled
  {
    const h = await host(t);
    const first = await h.send({ text: 'before the switch-off', send: 'hold', client_msg_id: CID });
    assert.equal(first.json.ok, true);
    h.mirror.on = { enabled: false, scope: 'project' };
    const dup = await h.send({ text: 'before the switch-off', send: 'hold', client_msg_id: CID });
    assert.equal(dup.json.duplicate, true, 'disabled: duplicate');
    assert.equal(dup.json.id, first.json.id);
    const fresh = await h.send({ text: 'after', send: 'hold', client_msg_id: 'hub-msg-fresh-1' });
    assert.equal(fresh.json.ok, false);
    assert.equal(fresh.json.refused, 'disabled');
    assert.equal(fresh.json.client_msg_id, undefined, 'a refusal never echoes');
    assert.equal(h.messages().length, 1);
  }
  // validation (a body that would fail: empty, and a malformed field)
  {
    const h = await host(t);
    const first = await h.send({ text: 'valid once', send: 'hold', client_msg_id: CID });
    assert.equal(first.json.ok, true);
    for (const bad of [{ text: '' }, { text: 'x', files: 'not-an-array' }, { text: 7 }]) {
      const dup = await h.send({ ...bad, client_msg_id: CID });
      assert.equal(dup.json.duplicate, true, `validation ${JSON.stringify(bad)}: duplicate`);
      assert.equal(dup.json.msg_id, first.json.msg_id);
    }
    const empty = await h.send({ text: '', client_msg_id: 'hub-msg-fresh-2' });
    assert.equal(empty.json.refused, 'empty');
    const malformed = await h.send({ text: 'x', files: 'not-an-array', client_msg_id: 'hub-msg-fresh-3' });
    assert.equal(malformed.json.refused, 'bad_request');
    assert.equal(malformed.json.field, 'files');
    assert.equal(h.messages().length, 1);
  }
  // the queue bound
  {
    const h = await host(t);
    const first = await h.send({ text: 'first of many', send: 'hold', client_msg_id: CID });
    assert.equal(first.json.ok, true);
    while (queue.queuedMessageCount(h.state) < composer.QUEUED_MESSAGES_MAX) {
      queue.enqueueMessage(h.state, h.ctx.bus, { text: 'filler', chars: 6 }, { staged: false });
    }
    const dup = await h.send({ text: 'first of many', send: 'hold', client_msg_id: CID });
    assert.equal(dup.json.duplicate, true, 'bound: duplicate');
    assert.equal(dup.json.id, first.json.id);
    const fresh = await h.send({ text: 'one more', send: 'hold', client_msg_id: 'hub-msg-fresh-4' });
    assert.equal(fresh.json.refused, 'too_many');
    assert.equal(queue.queuedMessageCount(h.state), composer.QUEUED_MESSAGES_MAX);
  }
  // the rate limit (and a duplicate takes none of it)
  {
    const h = await host(t, { now: () => 1_000_000 });
    const first = await h.send({ text: 'rate 0', send: 'hold', client_msg_id: CID });
    assert.equal(first.json.ok, true);
    for (let i = 0; i < 5; i++) {
      assert.equal((await h.send({ text: 'rate 0', send: 'hold', client_msg_id: CID })).json.duplicate, true);
    }
    for (let i = 1; i < composer.RATE_MAX; i++) {
      const r = await h.send({ text: `rate ${i}`, send: 'hold' });
      assert.equal(r.json.ok, true, `send ${i} is inside the budget (the duplicates took none): ${r.text}`);
    }
    const dup = await h.send({ text: 'rate 0', send: 'hold', client_msg_id: CID });
    assert.equal(dup.json.duplicate, true, 'rate: duplicate');
    const fresh = await h.send({ text: 'over', send: 'hold', client_msg_id: 'hub-msg-fresh-5' });
    assert.equal(fresh.json.refused, 'rate_limited');
    assert.equal(typeof fresh.json.retry_after, 'number');
    assert.equal(h.messages().length, composer.RATE_MAX);
  }
});

test('a malformed client_msg_id is refused by badField; a body without one behaves as today', async (t) => {
  const h = await host(t);
  for (const bad of ['abcdefg', 'a'.repeat(65), 'has a space', 'bad/slash1', 12345678, null, '']) {
    const r = await h.send({ text: 'hello', client_msg_id: bad });
    assert.equal(r.json.ok, false, `${JSON.stringify(bad)}: refused`);
    assert.equal(r.json.refused, 'bad_request');
    assert.equal(r.json.field, 'client_msg_id');
    assert.equal(r.json.hint, composer.HINTS.bad_request, 'the composer\'s own words');
  }
  assert.equal(h.messages().length, 0);
  assert.equal(await composer.validateMessage({ text: 'x', client_msg_id: 'a'.repeat(8) }).then((v) => v.ok), true, '8 is the floor');
  assert.equal(await composer.validateMessage({ text: 'x', client_msg_id: 'A_-9'.repeat(16) }).then((v) => v.ok), true, '64 is the ceiling');

  const plain = await h.send({ text: 'no id', send: 'hold' });
  assert.deepEqual(Object.keys(plain.json).sort(), ['id', 'mode', 'msg_id', 'ok']);
  assert.equal('client_msg_id' in h.messages()[0], false, 'no key on the item');
  const twice = await h.send({ text: 'no id', send: 'hold' });
  assert.equal(twice.json.ok, true);
  assert.notEqual(twice.json.id, plain.json.id, 'without the key, a repeat is a new message');
  assert.equal(h.messages().length, 2);
});

test('the record: written before ok under projectPaths, unreadable renamed aside, a failed write answers without the echo', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (line) => errors.push(String(line)));

  // Written durably, the shape read back.
  const root = tmpRoot('wc-cmid-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = projectPaths(root).acceptedMessages;
  assert.equal(file, path.join(root, '.web-chat', 'queue', 'accepted-messages.json'));
  const h = await host(t, { root });
  const r = await h.send({ text: 'durable', send: 'hold', client_msg_id: CID });
  assert.equal(r.json.client_msg_id, CID);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
    { v: 1, accepted: [{ client_msg_id: CID, id: r.json.id, msg_id: r.json.msg_id }] });

  // Garbage, then a file that cannot be read: renamed aside, started empty,
  // the route still answers.
  const variants = [['garbage', (f) => fs.writeFileSync(f, '{"v":1,"accep')]];
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    variants.push(['unreadable', (f) => { fs.writeFileSync(f, JSON.stringify({ v: 1, accepted: [] })); fs.chmodSync(f, 0o000); }]);
  }
  variants.push(['wrong shape', (f) => fs.writeFileSync(f, JSON.stringify({ v: 1, accepted: [{ client_msg_id: 'short', id: 1 }] }))]);
  for (const [what, spoil] of variants) {
    const r2 = tmpRoot('wc-cmid-');
    t.after(() => fs.rmSync(r2, { recursive: true, force: true }));
    const f2 = projectPaths(r2).acceptedMessages;
    fs.mkdirSync(path.dirname(f2), { recursive: true });
    spoil(f2);
    const before = errors.length;
    const h2 = await host(t, { root: r2 });
    const ok = await h2.send({ text: `after ${what}`, send: 'hold', client_msg_id: 'hub-msg-after' });
    assert.equal(ok.json.ok, true, `${what}: ${ok.text}`);
    assert.equal(ok.json.client_msg_id, 'hub-msg-after', `${what}: echoed`);
    const aside = fs.readdirSync(path.dirname(f2)).filter((n) => n.startsWith('accepted-messages.json.') && !n.endsWith('.tmp'));
    assert.equal(aside.length, 1, `${what}: one copy renamed aside (${aside})`);
    assert.deepEqual(JSON.parse(fs.readFileSync(f2, 'utf8')).accepted.map((e) => e.client_msg_id), ['hub-msg-after']);
    assert.equal(errors.length - before, 1, `${what}: one log line`);
    assert.ok(!errors.at(-1).includes('hub-msg-after'));
  }

  // A record write that throws: ok, enqueued, no echo, one log line.
  const throwing = { seen: () => null, record() { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } };
  const h3 = await host(t, { acceptedMessages: throwing });
  const before = errors.length;
  const nf = await h3.send({ text: 'no record', send: 'hold', client_msg_id: CID });
  assert.equal(nf.json.ok, true);
  assert.equal(nf.json.client_msg_id, undefined, 'no echo: the sender keeps its own ledger');
  assert.equal(h3.messages().length, 1);
  assert.equal(h3.messages()[0].client_msg_id, CID, 'still stored on the item');
  assert.equal(errors.length - before, 1);
  assert.match(errors.at(-1), /ENOSPC/);
});

test('the record keeps the last 1000: the 1001st evicts the first, across a reload', (t) => {
  const root = tmpRoot('wc-cmid-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = projectPaths(root).acceptedMessages;
  assert.equal(ACCEPTED_MAX, 1000);
  const rec = createAcceptedMessages({ file });
  const cid = (i) => `hub-msg-${String(i).padStart(5, '0')}`;
  for (let i = 1; i <= ACCEPTED_MAX + 1; i++) rec.record({ client_msg_id: cid(i), id: `q${i}`, msg_id: `m-${i}` });
  assert.equal(rec.seen(cid(1)), null, 'the first is evicted');
  assert.deepEqual(rec.seen(cid(2)), { id: 'q2', msg_id: 'm-2' });
  assert.deepEqual(rec.seen(cid(ACCEPTED_MAX + 1)), { id: `q${ACCEPTED_MAX + 1}`, msg_id: `m-${ACCEPTED_MAX + 1}` });

  const back = createAcceptedMessages({ file });
  assert.equal(back.seen(cid(1)), null);
  assert.deepEqual(back.seen(cid(2)), { id: 'q2', msg_id: 'm-2' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).accepted;
  assert.equal(onDisk.length, ACCEPTED_MAX);
  assert.equal(onDisk[0].client_msg_id, cid(2), 'acceptance order');
  assert.equal(onDisk.at(-1).client_msg_id, cid(ACCEPTED_MAX + 1));
});

test('a duplicate after a restart is answered from the record', async (t) => {
  const s1 = await withServer(t);
  const first = await s1.api.post('/api/queue/message', { text: 'across a restart', send: 'hold', client_msg_id: CID });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.ok, true, first.text);
  assert.equal(first.json.client_msg_id, CID);
  await s1.stop();

  const s2 = await withServer(t, { root: s1.root });
  const queuedBefore = s2.srv.state.queue.filter(queue.isMessage).length;
  const again = await s2.api.post('/api/queue/message', { text: 'across a restart', send: 'hold', client_msg_id: CID });
  assert.deepEqual(again.json, { ok: true, id: first.json.id, msg_id: first.json.msg_id, duplicate: true, client_msg_id: CID });
  assert.equal(s2.srv.state.queue.filter(queue.isMessage).length, queuedBefore, 'nothing enqueued');
  const policy = await s2.api.get('/api/queue/policy');
  assert.equal(policy.json.mod_attached, false, 'the real daemon: no mod attached');
});

test('GET /api/queue/policy reports mod_attached from ctx.bridge.any()', async (t) => {
  const cases = [
    ['no bridge', undefined, false],
    ['a null bridge', null, false],
    ['a bridge without any()', {}, false],
    ['none attached', { any: () => false }, false],
    ['a truthy non-true answer', { any: () => 1 }, false],
    ['one attached', { any: () => true }, true],
  ];
  for (const [what, bridge, want] of cases) {
    const h = await host(t, { bridge });
    const r = await h.call('GET', '/api/queue/policy');
    assert.equal(r.status, 200);
    assert.strictEqual(r.json.mod_attached, want, what);
    assert.equal(typeof r.json.channel_connected, 'boolean', `${what}: the rest unchanged`);
  }
});

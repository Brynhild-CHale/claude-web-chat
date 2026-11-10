// The connector's ring reader (tranche 6, U723): lib/connector/ring.js — one
// chat daemon's main ring as events.batch frames from the hub's cursor, read
// through the lifecycle's one hold (contract 07 C-07.7 to C-07.15; 05 C-05.24;
// 11 C-11.18) — and lib/client's response headers, which the ring reads the
// boot from (C-07.9).
//
// The stream tests run a real daemon through withServer on an ephemeral port
// (sandbox HOME) under the real lifecycle with a stub supervisor that answers
// that port, and a stub link that records every batch (and acks it, unless a
// test holds the acks). The reinit and buffer tests drive the ring through a
// stub lifecycle and a stub client. The last test runs the real link against
// test-support/fake-hub.js, which validates every frame against the locked
// schemas. No port in the band, no hub but the fake, nothing spawned.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, once } = require('events');

const realClient = require('../lib/client');
const { createLifecycle } = require('../lib/connector/lifecycle');
const {
  createRing, mintBatchId, UNACKED_MAX_ENTRIES, BATCH_MAX_ENTRIES, POLL_IDLE_MS, POLL_VIEWER_MS,
} = require('../lib/connector/ring');
const { createLink } = require('../lib/connector/link');
const { hubOrigin, newRecord, keyIdOf, fingerprintOf } = require('../lib/setup/connector');
const { versionsRecord, machineFacts } = require('../lib/connector/facts');
const { TABLE_VERSION, TABLE_SHA256 } = require('../lib/core/connected-policy');
const { userPaths } = require('../lib/core/paths');
const { withServer, waitUntil } = require('../test-support/helpers');
const { withFakeHub } = require('../test-support/fake-hub');
const { createValidator } = require('../test-support/contracts-loader');

const CHAT = '01jbzam3n5p7q9r1s3t5v7w9y1';
const BATCH_SCHEMA = 'https://web-chat-contracts/schemas/07-source-batch.json';
const validator = createValidator({ folders: 'all' });
const validBatch = validator.ajv.getSchema(BATCH_SCHEMA);
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// The stub-driven chats' root: a real folder (track() takes its real path).
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ring-root-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const rootedRing = (opts) => { const r = createRing(opts); r.track({ id: CHAT, root: ROOT }); return r; };

function assertOutsideBand(port) {
  assert.ok(![5170, 5171, 5172].includes(port) && !(port >= 5173 && port <= 5272), `port ${port} is outside the band`);
}

function assertSchema(batch) {
  assert.ok(validBatch(batch), `events.batch fails 07-source-batch.json: ${JSON.stringify(validBatch.errors)}`);
}

// ── stubs ──────────────────────────────────────────────────────────────────

// The link's surface the ring uses: batchSlot (4 per chat), send, channel and
// 'ready'. autoAck answers each batch as the fake hub does.
function stubLink({ autoAck = true, window = 4 } = {}) {
  const l = new EventEmitter();
  l.sent = [];
  l.slots = new Map();
  l.handlers = new Map();
  l.cursors = new Map();
  l.batchSlot = (chat) => {
    const n = l.slots.get(chat) || 0;
    if (n >= window) return false;
    l.slots.set(chat, n + 1);
    return true;
  };
  l.channel = (ch, { kinds, handle }) => {
    for (const k of kinds) l.handlers.set(`${ch}/${k}`, handle);
    return () => { for (const k of kinds) l.handlers.delete(`${ch}/${k}`); };
  };
  l.cursorAfter = (b) => {
    const prev = l.cursors.get(b.chat_id) || { boot: null, capture_seq: 0, element_seq: 0 };
    const same = prev.boot === b.boot;
    return {
      type: 'source', chat_id: b.chat_id, ring: 'main', boot: b.boot,
      seq: Math.max(b.since, ...b.entries.map((e) => e.seq)),
      capture_seq: Math.max(same && !b.reinit ? prev.capture_seq : 0, ...(b.reconciled || []).map((r) => r.seq)),
      element_seq: same && !b.reinit && !b.element_reset ? prev.element_seq : 0,
    };
  };
  l.ack = (b, cursor = l.cursorAfter(b)) => {
    l.cursors.set(b.chat_id, cursor);
    const n = l.slots.get(b.chat_id) || 0;
    l.slots.set(b.chat_id, Math.max(0, n - 1));
    const h = l.handlers.get('events/events.ack');
    if (h) h({ ch: 'events', kind: 'events.ack', re: 'x', ack: { type: 'events.ack', chat_id: b.chat_id, batch_id: b.batch_id, cursor, ingested: b.entries.length, duplicates: 0 } }, l);
  };
  l.send = (ch, kind, body) => {
    l.sent.push({ ch, kind, body });
    if (autoAck) setImmediate(() => l.ack(body.batch));
    return `c${l.sent.length}`;
  };
  l.batches = () => l.sent.map((s) => s.body.batch);
  l.entries = () => l.batches().flatMap((b) => b.entries);
  return l;
}

// The lifecycle's surface the ring uses, driven by hand.
function stubLifecycle({ boot = 'boot-a' } = {}) {
  const lc = { listeners: new Set(), provider: null, boot, healthReads: 0, viewers: 0 };
  lc.subscribe = (fn) => { lc.listeners.add(fn); return () => lc.listeners.delete(fn); };
  lc.setCursorProvider = (fn) => { lc.provider = fn; };
  lc.healthOf = async () => { lc.healthReads++; return { boot: typeof lc.boot === 'function' ? lc.boot() : lc.boot, viewers: lc.viewers }; };
  lc.emit = (msg) => { for (const fn of lc.listeners) fn({ chatId: CHAT, ...msg }); };
  lc.open = (headers = { 'x-wc-boot': lc.boot }) => {
    const since = lc.provider(CHAT);
    lc.emit({ type: 'open', since, response: { headers } });
    return since;
  };
  return lc;
}

// A client that answers /api/captures and /api/elements from `records`.
function recordsClient(records) {
  const c = { reads: [] };
  c.get = async (p, o) => {
    c.reads.push(p);
    if (p.startsWith('/api/events')) {
      const ring = records.ring || [];
      const since = Number(new URL(p, 'http://x').searchParams.get('since')) || 0;
      const events = ring.filter((e) => e.seq > since);
      const body = { events, latest: ring.length ? ring[ring.length - 1].seq : 0, oldest: ring.length ? ring[0].seq : null, gap: false, dropped: 0 };
      return o && o.withHeaders ? { body, headers: records.boot ? { 'x-wc-boot': records.boot } : {} } : body;
    }
    if (p.startsWith('/api/captures')) return { captures: records.captures || [], next_cursor: records.captureNext ?? 0 };
    if (p.startsWith('/api/elements')) return { elements: records.elements || [], next_cursor: records.elementNext ?? 0 };
    return {};
  };
  return c;
}

// A wrapper over lib/client INJECTED INTO the lifecycle, which does the
// subscribing (the ring opens no stream): it counts the streams and may adjust
// what the lifecycle passed (onOpen's headers, onEvent's order).
function streamSpy(adjust = (o) => o, extra = {}) {
  const w = { ...realClient, ...extra, streams: 0 };
  w.subscribeSSE = (o) => { w.streams++; return realClient.subscribeSSE(adjust(o)); };
  return w;
}

function supervisorFor(state) {
  return {
    ensures: 0,
    async ensureRunning() { this.ensures++; return { state: 'running', port: state.port, pid: process.pid, started_by: 'connector' }; },
    startedBy: () => 'connector',
    forget() {},
  };
}

// A daemon under the real lifecycle, the ring installed, a stub link.
async function ringOn(t, d, { client = realClient, link = stubLink(), cursor = null, ringDeps = {} } = {}) {
  const state = { port: d.port };
  const supervisor = supervisorFor(state);
  const lifecycle = createLifecycle({ supervisor, deps: { client } });
  const logs = [];
  const ring = createRing({ log: (l) => logs.push(l), deps: { client, portOf: () => state.port, ...ringDeps } });
  const ctx = { lifecycle, link };
  const uninstall = ring.install(ctx);
  ring.track({ id: CHAT, root: d.root });
  if (cursor) ring.setCursor(CHAT, cursor);
  const chat = { id: CHAT, root: d.root, owned_root: false };
  t.after(async () => { await lifecycle.stop(chat); uninstall(); });
  return { lifecycle, ring, link, chat, state, supervisor, logs, run: () => lifecycle.run(chat) };
}

const emit = (d, event) => d.srv.bus.emit({ event });
const bootOf = (d) => d.srv.bus.bootId;
const latestOf = (d) => d.srv.bus.read({ since: 0 }).latest;
const cursor = (boot, seq, extra = {}) => ({ type: 'source', chat_id: CHAT, ring: 'main', boot, seq, capture_seq: 0, element_seq: 0, ...extra });

// ── lib/client: response headers, additively ─────────────────────────────────

test('lib/client: request() resolves headers beside status and body; get(withHeaders) resolves {body, headers}; get() alone the body', async (t) => {
  const d = await withServer(t);
  assertOutsideBand(d.port);
  const r = await realClient.request(d.port, 'GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.headers['x-wc-boot'], bootOf(d), 'X-WC-Boot rides the response');
  // Additively: a caller that keys, spreads or deep-compares the result sees
  // {status, body}, what it always saw.
  assert.deepStrictEqual(Object.keys(r), ['status', 'body']);
  assert.deepStrictEqual({ ...r }, { status: 200, body: r.body });
  const w =await realClient.get('/api/health', { port: d.port, noSpawn: true, withHeaders: true });
  assert.deepStrictEqual(Object.keys(w).sort(), ['body', 'headers']);
  assert.strictEqual(w.body.boot, bootOf(d));
  assert.strictEqual(w.headers['x-wc-boot'], bootOf(d));
  const plain = await realClient.get('/api/health', { port: d.port, noSpawn: true });
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(plain.boot, bootOf(d));
  assert.ok(!('headers' in plain) && !('body' in plain), 'without the option the body alone, as before');
  await assert.rejects(realClient.get('/api/nope-404', { port: d.port, noSpawn: true, withHeaders: true }), (e) => e.status === 404);
});

// ── the first attach, resume, the ring's one hold ────────────────────────────

test('first attach: no cursor reads from 0, sends the whole ring in order, every entry projected; the hold opens with {headers} carrying x-wc-boot', async (t) => {
  const d = await withServer(t);
  emit(d, { kind: 'render', op: 'set', id: 'p1', html: '<b>secret html</b>', bytes: 18 });
  emit(d, { kind: 'store', patch: { plan: 'secret value', n: 3 }, source: 'browser' });
  emit(d, { kind: 'wake', reason: 'push', source: 'browser', note: 'secret note', batch: [{ text: 'secret batch' }] });
  const opens = [];
  const spy = streamSpy((o) => ({ ...o, onOpen: (arg) => { opens.push(arg); o.onOpen(arg); } }));
  const h = await ringOn(t, d, { client: spy });
  await h.run();
  const want = latestOf(d);
  await waitUntil(() => h.link.entries().length >= want, { what: 'the whole ring in batches' });
  assert.strictEqual(spy.streams, 1, 'one stream: the hold; the ring opens none');
  assert.ok(opens[0] && opens[0].headers && opens[0].headers['x-wc-boot'] === bootOf(d), 'onOpen receives {headers} with x-wc-boot');
  const batches = h.link.batches();
  batches.forEach(assertSchema);
  assert.strictEqual(batches[0].since, 0);
  assert.strictEqual(batches[0].boot, bootOf(d));
  assert.strictEqual(batches[0].contiguous, true, 'the ring starts at 1: provably whole');
  const seqs = h.link.entries().map((e) => e.seq);
  assert.deepStrictEqual(seqs, Array.from({ length: want }, (_, i) => i + 1), 'ascending, no gap, no duplicate');
  const render = h.link.entries().find((e) => e.kind === 'render');
  assert.deepStrictEqual(render, { kind: 'render', seq: render.seq, ts: render.ts, op: 'set', id: 'p1', bytes: 18 });
  const store = h.link.entries().find((e) => e.kind === 'store');
  assert.deepStrictEqual(store.keys, ['plan', 'n']);
  assert.ok(!('patch' in store));
  const wake = h.link.entries().find((e) => e.kind === 'wake');
  assert.ok(!('note' in wake) && !('batch' in wake));
  const wire = JSON.stringify(batches);
  for (const s of ['secret html', 'secret value', 'secret note', 'secret batch']) assert.ok(!wire.includes(s), `${s} never leaves`);
  // A live entry continues the cursor.
  const n = h.link.batches().length;
  emit(d, { kind: 'clear', id: 'p1' });
  await waitUntil(() => h.link.batches().length > n, { what: 'the live batch' });
  const live = h.link.batches()[n];
  assert.strictEqual(live.contiguous, true);
  assert.strictEqual(live.entries[0].seq, want + 1);
  assert.strictEqual(spy.streams, 1);
});

test('resume: a cursor naming the live boot and seq n reads since n; the first batch starts at n + 1 and is contiguous; nothing at or below n is sent', async (t) => {
  const d = await withServer(t);
  for (let i = 0; i < 6; i++) emit(d, { kind: 'store', patch: { [`k${i}`]: i } });
  const n = latestOf(d) - 2;
  const h = await ringOn(t, d, { cursor: cursor(bootOf(d), n) });
  await h.run();
  await waitUntil(() => h.link.entries().length >= 2, { what: 'the resumed batch' });
  const [b] = h.link.batches();
  assertSchema(b);
  assert.strictEqual(b.since, n);
  assert.strictEqual(b.contiguous, true);
  assert.strictEqual(b.entries[0].seq, n + 1);
  assert.ok(h.link.entries().every((e) => e.seq > n), 'no duplicate of what the hub holds');
});

// ── restart, the header-less boot, eviction ─────────────────────────────────

test('restart: a new daemon on the same root (a new boot) gives since 0, one restart gap, then the new ring once; the old boot is not sent again', async (t) => {
  const d1 = await withServer(t);
  for (let i = 0; i < 3; i++) emit(d1, { kind: 'store', patch: { a: i } });
  const h = await ringOn(t, d1);
  await h.run();
  await waitUntil(() => h.link.entries().length >= latestOf(d1), { what: 'the first boot' });
  const boot1 = bootOf(d1);
  const sentBefore = h.link.batches().length;
  await d1.graceful();
  const d2 = await withServer(t, { root: d1.root });
  assert.notStrictEqual(bootOf(d2), boot1);
  // More entries on the new boot than the old cursor's seq: the hold reopens
  // with the stale since, so the stream REPLAYS what the re-base poll from 0
  // also reads — every new-boot position must still reach the link once.
  const staleSince = latestOf(d1);
  for (let i = 0; i < staleSince + 5; i++) emit(d2, { kind: 'store', patch: { b: i } });
  assert.ok(latestOf(d2) > staleSince + 1, 'the stream replays from the stale since');
  h.state.port = d2.port;
  await waitUntil(() => h.link.batches().some((b) => b.boot === bootOf(d2)), { what: 'the new boot', timeout: 15000 });
  const newBoot = () => h.link.batches().filter((b) => b.boot === bootOf(d2)).flatMap((b) => b.entries);
  await waitUntil(() => newBoot().length >= latestOf(d2), { what: 'the new ring' });
  await settle(150);   // a late duplicate would land here
  const after = h.link.batches().slice(sentBefore);
  after.forEach(assertSchema);
  const first = after.find((b) => b.boot === bootOf(d2));
  assert.strictEqual(first.since, 0, 're-based from 0');
  assert.strictEqual(first.contiguous, false);
  assert.deepStrictEqual(first.gap, { gap: true, dropped: 0, oldest: 1, reset: true }, 'one restart gap');
  assert.strictEqual(after.filter((b) => b.gap).length, 1);
  assert.ok(!after.some((b) => b.boot === boot1 && b.entries.length), 'nothing of the old boot again');
  const newSeqs = after.filter((b) => b.boot === bootOf(d2)).flatMap((b) => b.entries.map((e) => e.seq));
  assert.strictEqual(newSeqs[0], 1);
  newSeqs.forEach((s, i) => { if (i) assert.strictEqual(s, newSeqs[i - 1] + 1, 'the new ring in order, once'); });
  assert.deepStrictEqual(newSeqs, Array.from({ length: latestOf(d2) }, (_, i) => i + 1), 'every new-boot position exactly once');
});

test('no header: the boot is read from health as the hold opens and again after the first entry; a boot that moves between the two discards the read and re-bases', async (t) => {
  const d = await withServer(t);
  for (let i = 0; i < 3; i++) emit(d, { kind: 'store', patch: { a: i } });
  const order = [];
  let healthBoots = null;   // when set, the boots health answers, in turn
  const strip = (h) => { const o = { ...h }; delete o['x-wc-boot']; return o; };
  const client = streamSpy((o) => {
    order.push('open');
    let first = true;
    return {
      ...o,
      onOpen: (arg) => o.onOpen({ headers: strip(arg.headers) }),
      onEvent: (e) => { if (first) { first = false; order.push('entry'); } o.onEvent(e); },
    };
  }, {
    get: async (p, o) => {
      if (p === '/api/health') {
        order.push('health');
        const body = await realClient.get(p, o);
        return healthBoots && healthBoots.length ? { ...body, boot: healthBoots.shift() } : body;
      }
      const r = await realClient.get(p, o);
      return o && o.withHeaders ? { body: r.body, headers: strip(r.headers) } : r;
    },
  });
  const h = await ringOn(t, d, { client });
  await h.run();
  await waitUntil(() => h.link.entries().length >= latestOf(d), { what: 'the ring without the header' });
  // The provider runs just before the open and issues the first health read;
  // lifecycle's healthOf sends it a microtask after the stream request, and
  // before any entry is accepted. The second follows the first entry.
  assert.deepStrictEqual(order.slice(0, 4), ['open', 'health', 'entry', 'health'], 'health as the hold opens, and again after the first entry');
  assert.strictEqual(order.filter((x) => x === 'health').length, 2, 'two health reads, no more');
  assert.strictEqual(h.link.batches()[0].boot, bootOf(d));

  // A second chat state: the stream reopens and health names a boot, then
  // another after the first entry: the read is discarded and re-based.
  const moved = 'moved-boot-0001';
  const sent = h.link.batches().length;
  healthBoots = [bootOf(d), moved, moved, moved, moved];
  await h.lifecycle.stop(h.chat);
  emit(d, { kind: 'store', patch: { c: 1 } });
  await h.run();
  await waitUntil(() => h.link.batches().slice(sent).some((b) => b.boot === moved), { what: 'the re-based read' });
  const after = h.link.batches().slice(sent);
  after.forEach(assertSchema);
  const reb = after.find((b) => b.boot === moved);
  assert.strictEqual(reb.since, 0, 're-based from 0');
  assert.strictEqual(reb.gap.reset, true);
  assert.strictEqual(reb.entries[0].seq, 1);
  assert.ok(!after.some((b) => b.boot === bootOf(d) && b.entries.length), 'what the moved read delivered under the old boot is discarded');
});

test('evicted: past the ring while the hold is closed, the reopen reports one evicted gap with the dropped count and invents nothing', async (t) => {
  const d = await withServer(t, { createServer: (o) => require('../lib/server').createServer({ ...o, eventRing: 1000 }) });
  emit(d, { kind: 'store', patch: { a: 1 } });
  const h = await ringOn(t, d);
  await h.run();
  await waitUntil(() => h.link.entries().length >= latestOf(d), { what: 'the first read' });
  const had = latestOf(d);
  const sent = h.link.batches().length;
  await h.lifecycle.stop(h.chat);
  for (let i = 0; i < 1100; i++) emit(d, { kind: 'store', patch: { [`k${i % 7}`]: i } });
  const ring = d.srv.bus.read({ since: 0 });
  const oldest = ring.oldest;
  assert.ok(oldest > had + 1, 'the ring evicted entries the cursor needed');
  await h.run();
  await waitUntil(() => h.link.entries().length >= had + ring.events.length, { what: 'the catch-up', timeout: 15000 });
  const after = h.link.batches().slice(sent);
  after.forEach(assertSchema);
  const gaps = after.filter((b) => b.gap);
  assert.strictEqual(gaps.length, 1, 'one evicted gap');
  assert.deepStrictEqual(gaps[0].gap, { gap: true, dropped: oldest - 1 - had, oldest });
  assert.strictEqual(gaps[0].since, had, 'since unchanged');
  assert.strictEqual(gaps[0].contiguous, false);
  const seqs = after.flatMap((b) => b.entries.map((e) => e.seq));
  assert.strictEqual(seqs[0], oldest, 'nothing invented below the oldest kept');
  assert.deepStrictEqual(seqs, ring.events.map((e) => e.seq), 'exactly what the ring holds, in order');
});

// ── captures and the reconcile ─────────────────────────────────────────────

test('captures: a capture keeps its ring position with capture_seq projected; after a read with since > 0 the reconcile sends each live capture record projected', async (t) => {
  const d = await withServer(t);
  emit(d, { kind: 'store', patch: { a: 1 } });
  const cap = await d.api.post('/api/capture', { url: 'https://x.test/secret-path', title: 'Doc', html: '<p>secret body</p>' });
  assert.strictEqual(cap.json.capture_id, 'cap1');
  const ringEntries = d.srv.bus.read({ since: 0 }).events;
  const capEntry = ringEntries.find((e) => e.kind === 'capture');
  const base = capEntry.seq - 1;
  const h = await ringOn(t, d, { cursor: cursor(bootOf(d), base) });
  await h.run();
  await waitUntil(() => h.link.batches().some((b) => (b.reconciled || []).length), { what: 'the reconcile' });
  const batches = h.link.batches();
  batches.forEach(assertSchema);
  const sentCap = h.link.entries().find((e) => e.kind === 'capture');
  assert.strictEqual(sentCap.seq, capEntry.seq, 'the ring position is kept');
  assert.strictEqual(sentCap.seq, base + 1);
  assert.ok(Number.isInteger(sentCap.capture_seq) && sentCap.capture_seq >= 0, 'capture_seq crosses (U724-U750@capture-seq-crosses)');
  assert.strictEqual(sentCap.capture_seq, 1);
  assert.strictEqual(sentCap.capture_id, 'cap1');
  assert.ok(!('url' in sentCap));
  const rec = batches.flatMap((b) => b.reconciled || [])[0];
  assert.deepStrictEqual(Object.keys(rec).sort(), ['capture_id', 'kind', 'seq', 'source', 'ts'].filter((k) => k in rec).sort());
  assert.strictEqual(rec.kind, 'capture');
  assert.strictEqual(rec.capture_id, 'cap1');
  assert.strictEqual(rec.seq, 1);
  const wire = JSON.stringify(batches);
  for (const s of ['secret-path', 'secret body', 'distilled', 'raw_ref', 'https://']) assert.ok(!wire.includes(s), `${s} never leaves`);
});

test('reconcile: an element record goes through projectAudit\'s element row to the onElementRecords seam, never onto the batch', async () => {
  const lc = stubLifecycle();
  const link = stubLink();
  const seen = [];
  const client = recordsClient({
    captures: [{ id: 'cap4', seq: 4, ts: 5, url: 'https://x.test/p', title: 'T', distilled: 'body', raw_ref: 'captures/cap4.html', source: 'ext:tab-stream', profile: 'default' }],
    elements: [{ id: 'cmt_1', type: 'comment', seq: 9, ts: 6, v: 2, shared: true, mount: 'p1', text: 'secret comment text', anchor: { x: 1 } }],
    captureNext: 4,
    elementNext: 9,
  });
  const ring = rootedRing({ onElementRecords: (id, recs) => seen.push({ id, recs }), deps: { client, portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 2));
  lc.open();
  lc.emit({ type: 'entry', entry: { seq: 3, ts: 1, kind: 'store', patch: { a: 1 } } });
  await waitUntil(() => link.batches().some((b) => (b.reconciled || []).length), { what: 'the reconcile' });
  link.batches().forEach(assertSchema);
  assert.deepStrictEqual(link.batches().flatMap((b) => b.reconciled || []), [{ kind: 'capture', capture_id: 'cap4', seq: 4, ts: 5, source: 'ext:tab-stream' }]);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].id, CHAT);
  assert.deepStrictEqual(seen[0].recs, [{ seq: 9, ts: 6, type: 'comment', id: 'cmt_1', v: 2, shared: true, mount: 'p1' }]);
  assert.ok(!JSON.stringify(seen).includes('secret comment text'));
  assert.ok(!JSON.stringify(link.batches()).includes('cmt_1'), 'no element record on the wire (07-source-batch has no field for one)');
  assert.ok(client.reads.includes('/api/captures?since=0') && client.reads.includes('/api/elements?since=0'));
});

// ── reinit, element reset ────────────────────────────────────────────────────

test('reinit: at a boot change a capture next_cursor below the cursor\'s capture_seq sets reinit on the new boot\'s first batch', async () => {
  const lc = stubLifecycle({ boot: 'boot-b' });
  const link = stubLink();
  const client = recordsClient({ captureNext: 2, elementNext: 50, boot: 'boot-b', ring: [{ seq: 1, ts: 1, kind: 'store', patch: { z: 1 } }] });
  const ring = rootedRing({ deps: { client, portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 40, { capture_seq: 5, element_seq: 30 }));
  assert.strictEqual(lc.open(), 40, 'since chosen against the cursor\'s boot');
  lc.emit({ type: 'entry', entry: { seq: 41, ts: 1, kind: 'store', patch: { a: 1 } } });
  await waitUntil(() => link.entries().length >= 2, { what: 'the new boot re-based from 0, then the stream past it' });
  const [b] = link.batches();
  assertSchema(b);
  assert.strictEqual(b.boot, 'boot-b');
  assert.strictEqual(b.reinit, true);
  assert.ok(!('element_reset' in b), 'reinit carries the element reset itself');
  assert.strictEqual(b.since, 0);
  assert.strictEqual(b.gap.reset, true);
  assert.deepStrictEqual(link.entries().map((e) => e.seq), [1, 41], 'the re-base read 1; the stream continues at 41');
  assert.ok(link.batches().slice(1).every((x) => !('reinit' in x)), 'only the first batch of the boot');
  assert.ok(client.reads.includes('/api/captures?since=5') && client.reads.includes('/api/elements?since=30'), 'both routes read once at the boot change');
});

test('element_reset: an element next_cursor below element_seq alone sets element_reset, never reinit; a capture counter below capture_seq in the first batch sets reinit', async () => {
  const lc = stubLifecycle({ boot: 'boot-b' });
  const link = stubLink();
  const client = recordsClient({ captureNext: 5, elementNext: 3 });
  const ring = rootedRing({ deps: { client, portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0, { capture_seq: 5, element_seq: 30 }));
  lc.open();
  lc.emit({ type: 'entry', entry: { seq: 1, ts: 1, kind: 'store', patch: { a: 1 } } });
  await waitUntil(() => link.batches().length >= 1, { what: 'the first batch' });
  assertSchema(link.batches()[0]);
  assert.strictEqual(link.batches()[0].element_reset, true);
  assert.ok(!('reinit' in link.batches()[0]));

  const lc2 = stubLifecycle({ boot: 'boot-c' });
  const link2 = stubLink();
  const ring2 = rootedRing({ deps: { client: recordsClient({ captureNext: 9, elementNext: 30 }), portOf: () => 40999, home: null } });
  ring2.install({ lifecycle: lc2, link: link2 });
  ring2.setCursor(CHAT, cursor('boot-a', 0, { capture_seq: 5, element_seq: 30 }));
  lc2.open();
  lc2.emit({ type: 'entry', entry: { seq: 1, ts: 1, kind: 'capture', capture_id: 'cap2', capture_seq: 2, url: 'https://x' } });
  await waitUntil(() => link2.batches().length >= 1, { what: 'the first batch' });
  assertSchema(link2.batches()[0]);
  assert.strictEqual(link2.batches()[0].reinit, true, 'a capture counter below the cursor\'s capture_seq');
});

// ── the unacknowledged buffer, the ack, a reconnect ──────────────────────────

test('the unacknowledged buffer: past 2000 entries the oldest are dropped; when the ring no longer holds them the re-read is abandoned and the next batch goes not contiguous; an events.ack moves the cursor', async () => {
  const lc = stubLifecycle();
  const link = stubLink({ autoAck: false });
  const ring = rootedRing({ deps: { client: recordsClient({}), portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0));
  lc.open();
  const total = UNACKED_MAX_ENTRIES + 600;
  for (let s = 1; s <= total; s++) lc.emit({ type: 'entry', entry: { seq: s, ts: s, kind: 'store', patch: { a: s } } });
  await settle();
  const held = link.batches();
  assert.strictEqual(held.length, 4, 'four unacknowledged batches per chat (C-05.24)');
  held.forEach(assertSchema);
  assert.ok(held.every((b) => b.contiguous));
  assert.strictEqual(ring.stats(CHAT).unacked, UNACKED_MAX_ENTRIES, 'capped at 2000 in memory');
  assert.strictEqual(ring.stats(CHAT).dropped, 600);
  const lastHeld = held[3].entries[held[3].entries.length - 1].seq;
  assert.strictEqual(lastHeld, 4 * BATCH_MAX_ENTRIES);

  link.ack(held[0]);
  assert.deepStrictEqual(ring.cursorOf(CHAT), { ...cursor('boot-a', BATCH_MAX_ENTRIES), capture_seq: 0, element_seq: 0 }, 'the ack moves the cursor');
  // The ack starts the re-read from the hub's cursor; this stub's ring holds
  // nothing, so it is abandoned and what was kept goes on.
  await waitUntil(() => link.batches().length >= 5, { what: 'the batch after the abandoned re-read' });
  const next = link.batches()[4];
  assertSchema(next);
  assert.strictEqual(next.contiguous, false, 'the dropped entries are not papered over');
  assert.ok(next.entries[0].seq > lastHeld + 1);
  assert.ok(!('gap' in next), 'the hub records the gap as unknown');
  const all = link.entries().map((e) => e.seq);
  assert.deepStrictEqual(all, [...all].sort((a, b) => a - b), 'still ascending');
  assert.strictEqual(new Set(all).size, all.length, 'no duplicate');
});

test('the unacknowledged buffer: what the cap dropped is re-read from the hub\'s cursor after each ack, in order, once — every seq reaches the link', async () => {
  const lc = stubLifecycle();
  const link = stubLink({ autoAck: false });
  const total = UNACKED_MAX_ENTRIES + 600;
  const ringEntries = Array.from({ length: total }, (_, i) => ({ seq: i + 1, ts: i + 1, kind: 'store', patch: { a: i + 1 } }));
  const client = recordsClient({ ring: ringEntries, boot: 'boot-a' });
  const ring = rootedRing({ deps: { client, portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0));
  lc.open();
  for (const e of ringEntries) lc.emit({ type: 'entry', entry: e });
  await settle();
  assert.strictEqual(ring.stats(CHAT).dropped, 600, 'the cap dropped the oldest pending');
  assert.strictEqual(ring.stats(CHAT).reread, true, 'a re-read is owed');
  assert.ok(!client.reads.some((p) => p.startsWith('/api/events')), 'no re-read before an ack');
  // The hub acks each batch in turn; the ring re-reads after the acks.
  let acked = 0;
  for (let i = 0; i < 400 && link.entries().length < total; i++) {
    const sent = link.batches();
    if (acked < sent.length) link.ack(sent[acked++]);
    else await settle(5);
  }
  await settle();
  const seqs = link.entries().map((e) => e.seq);
  assert.deepStrictEqual(seqs, ringEntries.map((e) => e.seq), 'every seq 1..total once, in order');
  link.batches().forEach(assertSchema);
  assert.ok(link.batches().every((b) => b.contiguous), 'the hole was filled from the ring, so nothing is reported missing');
  const rereads = client.reads.filter((p) => p.startsWith('/api/events'));
  assert.ok(rereads.length >= 1 && rereads.every((p) => /^\/api\/events\?since=\d+$/.test(p)), 'one-shot polls from the hub\'s cursor');
  assert.ok(Number(rereads[0].split('=')[1]) >= BATCH_MAX_ENTRIES, 'the first re-read starts at the acked cursor');
  assert.strictEqual(ring.stats(CHAT).reread, false);
});

test('the re-read of a dropped hole reports what the ring evicted meanwhile as one evicted gap, and invents nothing', async () => {
  const lc = stubLifecycle();
  const link = stubLink({ autoAck: false });
  const total = UNACKED_MAX_ENTRIES + 600;
  const all = Array.from({ length: total }, (_, i) => ({ seq: i + 1, ts: i + 1, kind: 'store', patch: { a: i + 1 } }));
  // The daemon's ring has since evicted 1..1300: the hole (1001..1600) is
  // only partly there when the re-read runs.
  const client = recordsClient({ ring: all.filter((e) => e.seq > 1300), boot: 'boot-a' });
  const ring = rootedRing({ deps: { client, portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0));
  lc.open();
  for (const e of all) lc.emit({ type: 'entry', entry: e });
  await settle();
  assert.strictEqual(ring.stats(CHAT).dropped, 600);
  let acked = 0;
  for (let i = 0; i < 400 && link.entries().length < total - 300; i++) {
    const sent = link.batches();
    if (acked < sent.length) link.ack(sent[acked++]);
    else await settle(5);
  }
  await settle();
  link.batches().forEach(assertSchema);
  const seqs = link.entries().map((e) => e.seq);
  const want = all.map((e) => e.seq).filter((s) => s <= 1000 || s > 1300);
  assert.deepStrictEqual(seqs, want, 'what the ring still holds, once, in order; nothing below its oldest invented');
  const gaps = link.batches().filter((b) => b.gap);
  assert.strictEqual(gaps.length, 1, 'one evicted gap');
  assert.deepStrictEqual(gaps[0].gap, { gap: true, dropped: 300, oldest: 1301 });
  assert.strictEqual(gaps[0].entries[0].seq, 1301);
  assert.strictEqual(gaps[0].contiguous, false);
});

test('a gap read while earlier entries still wait for the window opens a batch of its own: it is never folded into a batch that claims to continue', async () => {
  const lc = stubLifecycle();
  const link = stubLink({ autoAck: false, window: 1 });
  const ring = rootedRing({ deps: { client: recordsClient({}), portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0));
  lc.open();
  lc.emit({ type: 'entry', entry: { seq: 1, ts: 1, kind: 'store', patch: { a: 1 } } });
  await settle(10);
  lc.emit({ type: 'entry', entry: { seq: 2, ts: 2, kind: 'store', patch: { a: 2 } } });
  lc.emit({ type: 'entry', entry: { seq: 3, ts: 3, kind: 'store', patch: { a: 3 } } });
  lc.emit({ type: 'close' });
  // The hold reopens past an eviction; 2 and 3 are still waiting for the slot.
  assert.strictEqual(lc.open(), 3);
  lc.emit({ type: 'gap', gap: { gap: true, dropped: 5, oldest: 9, since: 3 } });
  lc.emit({ type: 'entry', entry: { seq: 9, ts: 9, kind: 'store', patch: { a: 9 } } });
  lc.emit({ type: 'entry', entry: { seq: 10, ts: 10, kind: 'store', patch: { a: 10 } } });
  await settle(10);
  assert.strictEqual(link.batches().length, 1, 'the window holds one');
  link.ack(link.batches()[0]);
  await waitUntil(() => link.batches().length >= 2, { what: 'the batch after the ack' });
  link.ack(link.batches()[1]);
  await waitUntil(() => link.batches().length >= 3, { what: 'the gap batch' });
  link.batches().forEach(assertSchema);
  const [, b2, b3] = link.batches();
  assert.deepStrictEqual(b2.entries.map((e) => e.seq), [2, 3]);
  assert.strictEqual(b2.contiguous, true);
  assert.deepStrictEqual(b3.entries.map((e) => e.seq), [9, 10]);
  assert.strictEqual(b3.contiguous, false);
  assert.deepStrictEqual(b3.gap, { gap: true, dropped: 5, oldest: 9 });
});

test('first attach over a ring whose oldest is above 1: not contiguous with no gap object (the hub records unknown), and the non-contiguous batch starts the reconcile', async () => {
  const lc = stubLifecycle();
  const link = stubLink();
  const client = recordsClient({ captures: [{ id: 'cap3', seq: 3, ts: 1, source: 'ext:tab-stream', url: 'https://x.test/s' }], captureNext: 3 });
  const ring = rootedRing({ deps: { client, portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  assert.strictEqual(lc.open(), 0, 'no cursor: since 0');
  lc.emit({ type: 'entry', entry: { seq: 5, ts: 5, kind: 'store', patch: { a: 5 } } });
  lc.emit({ type: 'entry', entry: { seq: 6, ts: 6, kind: 'store', patch: { a: 6 } } });
  await waitUntil(() => link.batches().some((b) => (b.reconciled || []).length), { what: 'the reconcile after the break' });
  link.batches().forEach(assertSchema);
  const [b] = link.batches();
  assert.strictEqual(b.since, 0);
  assert.strictEqual(b.contiguous, false);
  assert.ok(!('gap' in b), 'no gap object: the hub records one unknown with dropped null');
  assert.ok(client.reads.includes('/api/captures?since=0') && client.reads.includes('/api/elements?since=0'), 'both routes read after the non-contiguous batch');
  assert.deepStrictEqual(link.batches().flatMap((x) => x.reconciled || []), [{ kind: 'capture', capture_id: 'cap3', seq: 3, ts: 1, source: 'ext:tab-stream' }]);
});

// ── the root: nothing is projected before it is known ──────────────────────

test('the root: a label holding the chat\'s root leaves as <project>, never the path', async () => {
  const lc = stubLifecycle();
  const link = stubLink();
  const ring = rootedRing({ deps: { client: recordsClient({}), portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0));
  lc.open();
  lc.emit({ type: 'entry', entry: { seq: 1, ts: 1, kind: 'graph', op: 'bookmark', id: 'n1', name: `${ROOT}/plan` } });
  lc.emit({ type: 'entry', entry: { seq: 2, ts: 2, kind: 'capture', capture_id: 'cap1', capture_seq: 1, label: `see ${ROOT}/doc.md` } });
  await waitUntil(() => link.entries().length >= 2, { what: 'the two entries' });
  const [g, c] = link.entries();
  assert.strictEqual(g.name, '<project>/plan');
  assert.strictEqual(c.label, 'see <project>/doc.md');
  const wire = JSON.stringify(link.batches());
  assert.ok(!wire.includes(ROOT), 'the root path never leaves');
});

test('the root: a ring installed without track sends nothing until track names the root; then the held read goes, masked', async () => {
  const lc = stubLifecycle();
  const link = stubLink();
  const logs = [];
  const ring = createRing({ log: (l) => logs.push(l), deps: { client: recordsClient({}), portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0));
  lc.open();
  lc.emit({ type: 'entry', entry: { seq: 1, ts: 1, kind: 'graph', op: 'bookmark', id: 'n1', name: `${ROOT}/plan` } });
  lc.emit({ type: 'entry', entry: { seq: 2, ts: 2, kind: 'store', patch: { a: 1 } } });
  await settle(60);
  assert.strictEqual(link.sent.length, 0, 'nothing leaves before the root is known');
  assert.ok(logs.some((l) => /read held: no root/.test(l)), 'the hold is logged as a code');
  assert.ok(!logs.some((l) => l.includes(ROOT)), 'the log line carries no path');
  ring.track({ id: CHAT, root: ROOT });
  await waitUntil(() => link.entries().length >= 2, { what: 'the held read' });
  assert.deepStrictEqual(link.entries().map((e) => e.seq), [1, 2], 'in order, nothing lost');
  assert.strictEqual(link.entries()[0].name, '<project>/plan');
  assert.ok(!JSON.stringify(link.batches()).includes(ROOT));
});

test('a link reconnect resends every unacknowledged batch first, in order, with its batch id', async () => {
  const lc = stubLifecycle();
  const link = stubLink({ autoAck: false });
  const ring = rootedRing({ deps: { client: recordsClient({}), portOf: () => 40999, home: null } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 0));
  lc.open();
  for (let s = 1; s <= 3; s++) {
    lc.emit({ type: 'entry', entry: { seq: s, ts: s, kind: 'store', patch: { a: s } } });
    await settle(5);
  }
  const first = link.batches().map((b) => b.batch_id);
  assert.strictEqual(first.length, 3);
  link.slots.clear();
  link.emit('ready', {});
  assert.deepStrictEqual(link.batches().slice(3).map((b) => b.batch_id), first);
  assert.match(mintBatchId(Date.now, crypto.randomBytes), /^b_[0-9A-HJKMNP-TV-Z]{26}$/);
});

// ── the poll fallback ───────────────────────────────────────────────────────

test('the poll: three failed opens while health answers poll /api/events?since with latest as the cursor, every 10 s with no viewer and 2 s with one, until the stream opens', async () => {
  const lc = stubLifecycle();
  const link = stubLink();
  const timers = [];
  const client = {
    reads: [],
    async get(p, o) {
      client.reads.push(p);
      if (p.startsWith('/api/events')) {
        return { body: { events: [{ seq: 6, ts: 1, kind: 'store', patch: { a: 1 } }], latest: 7, oldest: 1, gap: false, dropped: 0 }, headers: { 'x-wc-boot': 'boot-a' } };
      }
      return { captures: [], next_cursor: 0, elements: [] };
    },
  };
  const ring = rootedRing({ deps: { client, portOf: () => 40999, home: null, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} } });
  ring.install({ lifecycle: lc, link });
  ring.setCursor(CHAT, cursor('boot-a', 5));
  for (let i = 0; i < 3; i++) { lc.provider(CHAT); lc.emit({ type: 'close' }); }
  await waitUntil(() => client.reads.includes('/api/events?since=5'), { what: 'the first poll' });
  await waitUntil(() => timers.length >= 1, { what: 'the next poll armed' });
  assert.strictEqual(timers[0].ms, POLL_IDLE_MS);
  await waitUntil(() => link.batches().length >= 1, { what: 'the poll batch' });
  assertSchema(link.batches()[0]);
  assert.strictEqual(link.batches()[0].contiguous, true);
  // A viewer arrives: the next poll is armed at the viewer cadence.
  lc.viewers = 1;
  timers[0].fn();
  await waitUntil(() => client.reads.includes('/api/events?since=7'), { what: 'the poll from latest' });
  await waitUntil(() => timers.length >= 2, { what: 'the poll after it armed' });
  assert.strictEqual(timers[1].ms, POLL_VIEWER_MS, 'every 2 s with a viewer');
  assert.ok(ring.stats(CHAT).polling);
  lc.open();
  assert.strictEqual(ring.stats(CHAT).polling, false, 'the stream opened again: the poll stops');
});

// ── against the fake hub ─────────────────────────────────────────────────────

test('fake hub: every events.batch the ring sends over the real link validates against the locked schemas, and its events.ack moves the cursor', async (t) => {
  const fake = await withFakeHub(t);
  assertOutsideBand(new URL(fake.url).port | 0);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  const m = fake.addMachine({ publicKey: raw, name: 'Test machine' });
  const record = newRecord({ hubId: 'hub-test', origin: hubOrigin(fake.url, { insecureLoopback: true }) });
  record.machine = { id: m.id, name: m.name };
  record.credential = {
    state: 'paired', algorithm: 'ed25519', key_file: userPaths().connectorKey('hub-test'),
    key_id: keyIdOf(raw), public_key: raw.toString('base64url'), fingerprint: fingerprintOf(raw), paired_at: 1,
  };
  const link = createLink({
    record,
    key: privateKey,
    versions: () => versionsRecord({ claudeVersion: null }),
    facts: () => machineFacts({ record, names: { mcp_servers: [], skills: [] }, hostname: 'test-host', login: 'tester' }),
    routeTable: () => ({ table_version: TABLE_VERSION, sha256: TABLE_SHA256 }),
    writeKey: () => {},
  });
  t.after(() => link.stop());
  const up = once(link, 'ready');
  link.start();
  await up;

  const d = await withServer(t);
  emit(d, { kind: 'render', op: 'set', id: 'p1', html: '<i>x</i>' });
  await d.api.post('/api/capture', { url: 'https://x.test/a', html: '<p>a</p>' });
  const spyClient = streamSpy();
  const h = await ringOn(t, d, { client: spyClient, link });
  await h.run();
  const want = latestOf(d);
  await waitUntil(() => fake.find('events.batch', { dir: 'in' }).flatMap((f) => f.frame.batch.entries).length >= want, { what: 'the batches at the fake' });
  await waitUntil(() => { const c = h.ring.cursorOf(CHAT); return c && c.seq === want; }, { what: 'the ack\'s cursor' });
  const frames = fake.find('events.batch', { dir: 'in' });
  assert.ok(frames.length >= 1);
  for (const f of frames) {
    assert.strictEqual(f.ok, true, 'the fake validated the frame');
    assertSchema(f.frame.batch);
  }
  assert.deepStrictEqual(fake.errors, []);
  assert.strictEqual(spyClient.streams, 1, 'one hold per chat; the ring opens no stream');
  assert.strictEqual(h.ring.cursorOf(CHAT).boot, bootOf(d));
});

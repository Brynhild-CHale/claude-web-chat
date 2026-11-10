// The hold and the daemon's lifecycle (tranche 6, U719): lib/connector/lifecycle.js
// — one all-kinds event stream per running chat with an explicit since, its
// reconnect, the per-chat tick and its one health read, release and now, the
// idle restart of an adopted daemon, the cap and pause (contract 06 C-06.20 to
// C-06.23; 07 C-07.8; 05 C-05.19, C-05.27).
//
// The stream tests run a real daemon through withServer on an ephemeral port
// (sandbox HOME) with a stub supervisor that answers that port; the rest use a
// stub client, a stub supervisor and a stub registry, so nothing is spawned,
// probed or shut down for real. The record's settings live in a withTempHome.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const realClient = require('../lib/client');
const conn = require('../lib/setup/connector');
const { createLifecycle, TICK_MS } = require('../lib/connector/lifecycle');
const { withServer, withTempHome, waitUntil } = require('../test-support/helpers');

const HUB = 'hub-test';
const CHAT = { id: '01jbzam3n5p7q9r1s3t5v7w9x1', root: '/tmp/wc-hold-chat-a', owned_root: false };
const CHAT_B = { id: '01jbzam3n5p7q9r1s3t5v7w9x2', root: '/tmp/wc-hold-chat-b', owned_root: false };
const STUB_PORT = 40411; // never bound: the stub client answers for it
const fast = (fn) => setTimeout(fn, 0);
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function assertOutsideBand(port) {
  assert.ok(![5170, 5171, 5172].includes(port) && !(port >= 5173 && port <= 5272), `port ${port} is outside the band`);
}

// A supervisor stand-in. `order` is shared with the stub client so a test can
// read the sequence of forget, shutdown, ensure and subscribe.
function stubSupervisor({ port = STUB_PORT, pid = 111, startedBy = 'connector', order = [] } = {}) {
  const s = {
    order,
    port,
    pid,
    sb: startedBy,
    ensures: 0,
    forgets: [],
    async ensureRunning(chat) {
      s.ensures++;
      order.push('ensure');
      return { state: 'running', port: s.port, pid: s.pid, started_by: s.sb, chat: chat.id };
    },
    startedBy: () => s.sb,
    forget(id) { s.forgets.push(id); order.push('forget'); },
  };
  return s;
}

function stubClient({ order = [], health = { lock: null, viewers: 0, pid: 111 } } = {}) {
  const c = {
    order,
    health,
    streams: [],
    gets: [],
    posts: [],
    subscribeSSE(opts) {
      order.push('subscribe');
      const s = { opts, closed: false, close() { s.closed = true; } };
      c.streams.push(s);
      return s;
    },
    async get(p, o) {
      c.gets.push({ p, o });
      if (p === '/api/health') order.push('health');
      return typeof c.health === 'function' ? c.health() : c.health;
    },
    async post(p, body, o) {
      c.posts.push({ p, body, o });
      if (p === '/api/shutdown') order.push('shutdown');
      return { ok: true };
    },
  };
  return c;
}

function stubRegistry({ sessions = {}, daemon = null } = {}) {
  return {
    async daemonFor() { return daemon; },
    mcpSessionsFor(root) { return sessions[root] || []; },
  };
}

// A lifecycle over stubs, with the tick timers captured so a test runs a tick.
function stubbed({ sup, client, registry, hubId = HUB } = {}) {
  const ticks = [];
  const lc = createLifecycle({
    supervisor: sup,
    hubId,
    deps: {
      client,
      registry: registry || stubRegistry(),
      setInterval: (fn, ms) => { ticks.push({ fn, ms }); return { unref() {} }; },
      clearInterval: () => {},
      setTimeout: fast,
      clearTimeout: (t) => clearTimeout(t),
    },
  });
  return { lc, ticks };
}

function seedRecord(settings) {
  const rec = conn.newRecord({ hubId: HUB, origin: conn.hubOrigin('hub.example.com') });
  rec.settings = { ...rec.settings, ...settings };
  conn.writeRecord(rec);
}

// ── the stream, against a real daemon ──────────────────────────────────────

function spyClient() {
  const calls = [];
  return {
    calls,
    client: {
      ...realClient,
      subscribeSSE(opts) { calls.push(opts); return realClient.subscribeSSE(opts); },
    },
  };
}

async function realHold(t) {
  const srv = await withServer(t);
  assertOutsideBand(srv.port);
  const sup = stubSupervisor({ port: srv.port, pid: process.pid });
  const spy = spyClient();
  const lc = createLifecycle({
    supervisor: sup,
    hubId: HUB,
    deps: { client: spy.client, setTimeout: fast },
  });
  const chat = { ...CHAT, root: srv.root };
  t.after(() => lc.stop(chat));
  return { srv, sup, spy, lc, chat };
}

test('run opens one all-kinds stream on the daemon\'s port, with a numeric since and no kinds', async (t) => {
  const { srv, spy, lc, chat } = await realHold(t);
  const r = await lc.run(chat);
  assert.equal(r.state, 'running');
  await waitUntil(() => lc.heldBy(chat.id), { what: 'the hold to open' });
  assert.equal(spy.calls.length, 1, 'one stream');
  const opts = spy.calls[0];
  assert.equal(opts.port, srv.port, 'the supervisor\'s port, explicitly');
  assert.equal(typeof opts.since, 'number', 'since is always a number');
  assert.ok(!('kinds' in opts), 'the open call carries no kinds key at all');
  assert.ok(!('root' in opts), 'no root: lib/client never discovers a port');

  await lc.run(chat);
  await settle(50);
  assert.equal(spy.calls.length, 1, 'a second run opens no second stream');

  const health = await realClient.get('/api/health', { port: srv.port, noSpawn: true });
  assert.equal(health.viewers, 0, 'the hold is no viewer: no socket is held');
});

test('the hold pin: routes/events.js holdsDaemon and isWakeConsumer as the hold relies on them (C-06.21)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'routes', 'events.js'), 'utf8');
  const why = 'the connector\'s HOLD (lib/connector/lifecycle.js, 06 C-06.21) relies on this expression: '
    + 'an all-kinds host stream must retain the daemon and must not count as a wake consumer';
  assert.ok(src.includes('const controlOnly = Array.isArray(kinds) && kinds.length > 0 && kinds.every((k) => k === \'control\');'), why);
  assert.ok(src.includes('const noHold = req.query.hold === \'0\' && isHost(req);'), why);
  assert.ok(src.includes('const holdsDaemon = !controlOnly && !noHold;'), why);
  assert.ok(src.includes('const isWakeConsumer = Array.isArray(kinds) && kinds.includes(\'wake\') && isHost(req);'), why);
});

test('with the hold open the channel is not connected and a Push stays parked', async (t) => {
  const { srv, lc, chat } = await realHold(t);
  await lc.run(chat);
  await waitUntil(() => lc.heldBy(chat.id), { what: 'the hold to open' });
  const host = { port: srv.port, noSpawn: true };

  const policy = await realClient.get('/api/queue/policy', host);
  assert.equal(policy.channel_connected, false, 'the hold is not a wake consumer');

  await srv.api.post('/api/capture', { url: 'https://example.com/page', title: 'Ex', html: '<html><body><p>hi</p></body></html>' });
  const push = (await srv.api.post('/api/queue/push', {})).json;
  assert.equal(push.mode, 'parked');
  await settle(80);
  const pending = await realClient.get('/api/queue/pending', host);
  assert.ok(pending.pending, 'the parked wake is still parked: the hold did not drain it');
});

test('a dropped stream reconnects with since = the last seq it delivered', async (t) => {
  const { srv, spy, lc, chat } = await realHold(t);
  const entries = [];
  lc.subscribe((m) => { if (m.type === 'entry') entries.push(m.entry); });
  await lc.run(chat);
  await waitUntil(() => lc.heldBy(chat.id), { what: 'the hold to open' });

  for (const v of [1, 2, 3]) await srv.api.post('/api/store', { patch: { [`hold_${v}`]: v } });
  await waitUntil(() => entries.filter((e) => e.kind === 'store').length >= 3, { what: 'three store events' });
  const third = entries.filter((e) => e.kind === 'store')[2];
  assert.equal(entries[entries.length - 1].seq, third.seq, 'the third store event is the last delivered');

  srv.server.closeAllConnections();
  await waitUntil(() => spy.calls.length >= 2, { what: 'the reconnect' });
  assert.equal(spy.calls[1].since, third.seq, 'reopened from the last seq seen');
  assert.ok(!('kinds' in spy.calls[1]));
  await waitUntil(() => lc.heldBy(chat.id), { what: 'the hold to reopen' });
});

// ── the stream, against stubs ───────────────────────────────────────────────

test('every open, entry, gap and close fans out to subscribe()\'s listeners; the cursor provider sets since', async () => {
  const order = [];
  const sup = stubSupervisor({ order });
  const client = stubClient({ order });
  const { lc } = stubbed({ sup, client });
  const seen = [];
  lc.subscribe((m) => seen.push(m));
  lc.setCursorProvider(() => 42);
  await lc.run(CHAT);
  assert.equal(client.streams.length, 1);
  assert.equal(client.streams[0].opts.since, 42, 'the provider\'s cursor');
  const headers = { 'x-wc-boot': 'b' };
  client.streams[0].opts.onOpen(headers);
  client.streams[0].opts.onEvent({ seq: 43, kind: 'store' });
  assert.ok(lc.heldBy(CHAT.id));
  lc.setCursorProvider(() => null); // no cursor: the last seq seen
  client.streams[0].opts.onClose();
  assert.equal(lc.heldBy(CHAT.id), false);
  await waitUntil(() => client.streams.length === 2, { what: 'the reconnect' });
  assert.equal(client.streams[1].opts.since, 43);
  assert.deepEqual(seen.map((m) => m.type), ['open', 'entry', 'close']);
  assert.equal(seen[0].response, headers, 'onOpen\'s argument passed through unchanged');
  assert.equal(seen[1].entry.seq, 43);
  await lc.stop(CHAT);
});

test('a fresh hold with no cursor opens from 0', async () => {
  const client = stubClient();
  const { lc } = stubbed({ sup: stubSupervisor(), client });
  await lc.run(CHAT);
  assert.equal(client.streams[0].opts.since, 0);
  await lc.stop(CHAT);
});

test('a gap re-reads health once; a changed pid is forgotten and the hold reopens after that read', async () => {
  const order = [];
  const sup = stubSupervisor({ order, pid: 111 });
  const client = stubClient({ order, health: { lock: null, viewers: 1, pid: 111 } });
  const { lc } = stubbed({ sup, client });
  await lc.run(CHAT);
  const s1 = client.streams[0];
  s1.opts.onOpen();
  s1.opts.onEvent({ seq: 7 });

  s1.opts.onGap({ gap: true, reset: true, since: 7 });
  await waitUntil(() => client.gets.length === 1, { what: 'the health read' });
  await settle();
  assert.equal(client.gets[0].p, '/api/health');
  assert.equal(client.gets[0].o.port, STUB_PORT);
  assert.equal(client.gets[0].o.noSpawn, true);
  assert.equal(client.streams.length, 1, 'same pid: the stream stays');
  assert.equal(sup.forgets.length, 0);

  order.length = 0;
  client.health = { lock: null, viewers: 1, pid: 222 };
  sup.pid = 222;
  s1.opts.onGap({ gap: true, reset: true, since: 7 });
  await waitUntil(() => client.streams.length === 2, { what: 'the reopen' });
  assert.deepEqual(order, ['health', 'forget', 'ensure', 'subscribe'], 'one health read before the reopen');
  assert.equal(client.streams[1].opts.since, 7);
  assert.equal(s1.closed, true);
  await lc.stop(CHAT);
});

// ── release and now ───────────────────────────────────────────────────────

test('release closes the hold and forgets the secret; nothing is posted', async () => {
  const sup = stubSupervisor();
  const client = stubClient();
  const { lc } = stubbed({ sup, client });
  await lc.run(CHAT);
  client.streams[0].opts.onOpen();
  const r = await lc.stop(CHAT);
  assert.deepEqual(r, { released: true, shutdown: false });
  assert.equal(client.streams[0].closed, true);
  assert.equal(lc.heldBy(CHAT.id), false);
  assert.deepEqual(sup.forgets, [CHAT.id]);
  assert.equal(client.posts.length, 0);
  await settle();
  assert.equal(client.streams.length, 1, 'a released hold does not reconnect');
});

test('now on a started_by connector daemon posts /api/shutdown with x-wc-shutdown: 1', async () => {
  const sup = stubSupervisor({ startedBy: 'connector' });
  const client = stubClient();
  const { lc } = stubbed({ sup, client });
  await lc.run(CHAT);
  const r = await lc.stop(CHAT, 'now');
  assert.equal(r.shutdown, true);
  assert.equal(client.posts.length, 1);
  const { p, o } = client.posts[0];
  assert.equal(p, '/api/shutdown');
  assert.equal(o.port, STUB_PORT);
  assert.equal(o.noSpawn, true);
  assert.equal(o.headers['x-wc-shutdown'], '1');
  assert.deepEqual(sup.forgets, [CHAT.id]);
});

test('now on an `other` daemon on an offered folder only releases', async () => {
  const sup = stubSupervisor({ startedBy: 'other' });
  const client = stubClient();
  const { lc } = stubbed({ sup, client });
  await lc.run(CHAT);
  const r = await lc.stop(CHAT, 'now');
  assert.deepEqual(r, { released: true, shutdown: false });
  assert.equal(client.posts.length, 0);
  assert.equal(client.streams[0].closed, true);
  assert.deepEqual(sup.forgets, [CHAT.id]);
});

test('now on an owned root posts whatever started_by says', async () => {
  const owned = { ...CHAT, owned_root: true };
  for (const sb of ['other', 'connector']) {
    const sup = stubSupervisor({ startedBy: sb });
    const client = stubClient();
    const { lc } = stubbed({ sup, client });
    await lc.run(owned);
    await lc.stop(owned, 'now');
    assert.equal(client.posts.length, 1, `owned root, started_by ${sb}`);
    assert.equal(client.posts[0].o.headers['x-wc-shutdown'], '1');
  }
  // Never run here: the port comes from the registry's verified record.
  const sup = stubSupervisor({ startedBy: null });
  const client = stubClient();
  const { lc } = stubbed({ sup, client, registry: stubRegistry({ daemon: { port: 40412, pid: 9 } }) });
  await lc.stop(owned, 'now');
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].o.port, 40412);
  await assert.rejects(() => lc.stop(owned, 'later'), TypeError);
});

// ── the tick: the idle restart and the one health read ─────────────────────

test('the idle restart: an `other` daemon with no lock and no viewers is forgotten, shut down, then ensured', async () => {
  const order = [];
  const sup = stubSupervisor({ order, startedBy: 'other' });
  const client = stubClient({ order, health: { lock: null, viewers: 0, pid: 111 } });
  const { lc, ticks } = stubbed({ sup, client });
  await lc.run(CHAT);
  client.streams[0].opts.onOpen();
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].ms, TICK_MS);
  order.length = 0;
  await ticks[0].fn();
  assert.deepEqual(order, ['health', 'forget', 'shutdown', 'ensure', 'subscribe']);
  assert.equal(client.posts.length, 1, 'one shutdown');
  assert.equal(client.posts[0].body.reason, 'connector idle restart');
  assert.equal(client.posts[0].o.headers['x-wc-shutdown'], '1');
  assert.equal(client.streams[0].closed, true);
  await lc.stop(CHAT);
});

test('an idle restart whose old pid still answers waits before it tries again', async () => {
  const sup = stubSupervisor({ startedBy: 'other' });
  const client = stubClient({ health: { lock: null, viewers: 0, pid: 111 } });
  let clock = 1_000_000;
  const ticks = [];
  const lc = createLifecycle({
    supervisor: sup,
    hubId: HUB,
    deps: {
      client,
      registry: stubRegistry({ daemon: { port: STUB_PORT, pid: 111 } }),
      now: () => (clock += 1_000),
      setInterval: (fn, ms) => { ticks.push({ fn, ms }); return { unref() {} }; },
      clearInterval: () => {},
      setTimeout: fast,
      clearTimeout: (t) => clearTimeout(t),
    },
  });
  await lc.run(CHAT);
  client.streams[0].opts.onOpen();
  await ticks[0].fn();
  assert.equal(client.posts.length, 1, 'one shutdown');
  assert.equal(sup.ensures, 2, 'asked again after the wait (the supervisor adopts what still answers)');
  client.streams[client.streams.length - 1].opts.onOpen();
  await ticks[0].fn();
  assert.equal(client.posts.length, 1, 'no second shutdown inside the retry wait');
  await lc.stop(CHAT);
});

test('no idle restart with a viewer, a held lock, or a connector daemon', async () => {
  const cases = [
    { sb: 'other', health: { lock: null, viewers: 1, pid: 111 } },
    { sb: 'other', health: { lock: { session_id: 's' }, viewers: 0, pid: 111 } },
    { sb: 'connector', health: { lock: null, viewers: 0, pid: 111 } },
  ];
  for (const c of cases) {
    const sup = stubSupervisor({ startedBy: c.sb });
    const client = stubClient({ health: c.health });
    const { lc, ticks } = stubbed({ sup, client });
    await lc.run(CHAT);
    client.streams[0].opts.onOpen();
    await ticks[0].fn();
    assert.equal(client.posts.length, 0);
    assert.equal(sup.forgets.length, 0);
    assert.equal(sup.ensures, 1);
    await lc.stop(CHAT);
  }
});

test('healthOf is one GET per chat per tick, however many listeners ask', async () => {
  const sup = stubSupervisor({ startedBy: 'other' });
  const client = stubClient({ health: { lock: null, viewers: 2, pid: 111 } });
  const { lc, ticks } = stubbed({ sup, client });
  const asked = [];
  for (let i = 0; i < 3; i++) {
    lc.onTick(({ chatId }) => { asked.push(chatId); lc.healthOf(chatId); return lc.healthOf(chatId); });
  }
  await lc.run(CHAT);
  await lc.run(CHAT_B);
  client.streams.forEach((s) => s.opts.onOpen());
  assert.equal(ticks.length, 2, 'one tick per running chat');

  await Promise.all(ticks.map((tk) => tk.fn()));
  await settle();
  assert.equal(asked.length, 6);
  const healthGets = () => client.gets.filter((g) => g.p === '/api/health');
  assert.equal(healthGets().length, 2, 'one read per chat for the idle check and three listeners');
  assert.deepEqual(await lc.healthOf(CHAT.id), client.health);
  assert.equal(healthGets().length, 2, 'between ticks the memo answers');

  await ticks[0].fn();
  await settle();
  assert.equal(healthGets().length, 3, 'the next tick reads again');
  await lc.stop(CHAT);
  await lc.stop(CHAT_B);
  assert.equal(await lc.healthOf(CHAT.id), null, 'a stopped chat has no health');
});

// ── pause and the cap ───────────────────────────────────────────────────────

test('pause: applySettings writes the record, ignores an older rev, and touches no run, stop or hold', async (t) => {
  withTempHome(t);
  seedRecord({ agents_at_once: 2, local_cap: 1, rev: 1 });
  const sup = stubSupervisor({ startedBy: 'connector' });
  const client = stubClient();
  const { lc } = stubbed({ sup, client });
  assert.equal(lc.isPaused(), false);

  assert.deepEqual(lc.applySettings({ paused: true, rev: 2, local_cap: 9 }), { applied: true });
  assert.equal(lc.isPaused(), true);
  const read = conn.readRecord(HUB);
  assert.ok(read.ok);
  assert.equal(read.value.settings.paused, true);
  assert.equal(read.value.settings.rev, 2);
  assert.equal(read.value.settings.local_cap, 1, 'the hub never sets the local cap');
  assert.equal(read.value.settings.agents_at_once, 2, 'a field the frame left out is kept');

  assert.deepEqual(lc.applySettings({ paused: false, rev: 1 }), { applied: false, reason: 'stale' });
  assert.deepEqual(lc.applySettings({ paused: false, rev: 2 }), { applied: false, reason: 'stale' });
  assert.equal(lc.isPaused(), true, 'an older or equal rev is ignored');
  assert.equal(lc.applySettings({ paused: false }).applied, false, 'no rev, no change');

  await lc.run(CHAT);
  assert.equal(client.streams.length, 1, 'a paused chat is still held');
  const r = await lc.stop(CHAT, 'now');
  assert.equal(r.shutdown, true, 'a paused chat can still be stopped');
  assert.equal(client.posts.length, 1);
});

test('the cap: the local cap lowers and never raises; overCap counts chats with an attached session', async (t) => {
  withTempHome(t);
  seedRecord({ agents_at_once: 3, local_cap: 1 });
  const sup = stubSupervisor();
  const client = stubClient();
  const sessions = { [CHAT.root]: [{ id: 'mcp:1' }], [CHAT_B.root]: [{ id: 'mcp:2' }] };
  const { lc } = stubbed({ sup, client, registry: stubRegistry({ sessions }) });
  assert.equal(lc.effectiveCap(), 1);
  conn.updateRecord(HUB, (rec) => { rec.settings.local_cap = 5; return rec; });
  assert.equal(lc.effectiveCap(), 3, 'a local cap above the hub\'s does not raise it');
  conn.updateRecord(HUB, (rec) => { rec.settings.local_cap = null; return rec; });
  assert.equal(lc.effectiveCap(), 3);

  await lc.run(CHAT);
  await lc.run(CHAT_B);
  assert.equal(lc.overCap(), false, 'two attached against three');
  conn.updateRecord(HUB, (rec) => { rec.settings.local_cap = 1; return rec; });
  assert.equal(lc.overCap(), true, 'two attached against one');
  await lc.stop(CHAT_B);
  assert.equal(lc.overCap(), false);
  await lc.stop(CHAT);
});

test('with no record the settings are the conservative defaults', (t) => {
  withTempHome(t);
  const { lc } = stubbed({ sup: stubSupervisor(), client: stubClient() });
  assert.equal(lc.isPaused(), false);
  assert.equal(lc.effectiveCap(), 0);
  assert.deepEqual(lc.applySettings({ paused: true, rev: 3 }), { applied: false, reason: 'no-record' });
});

// ── the seams and the source ───────────────────────────────────────────────

test('install sets ctx.lifecycle once and registers nothing else', () => {
  const { lc } = stubbed({ sup: stubSupervisor(), client: stubClient() });
  const ctx = {};
  const undo = lc.install(ctx);
  assert.equal(ctx.lifecycle.run, lc.run);
  assert.deepEqual(Object.keys(ctx), ['lifecycle']);
  const other = stubbed({ sup: stubSupervisor(), client: stubClient() }).lc;
  assert.throws(() => other.install(ctx), /already installed/);
  undo();
  assert.equal(ctx.lifecycle, undefined);
  assert.throws(() => createLifecycle({}), TypeError);
});

test('the source: no capture hub, no CLI, no kinds or non-holding read on the stream', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'connector', 'lifecycle.js'), 'utf8');
  const requires = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  for (const r of requires) {
    assert.ok(!/util\/hub$|(^|\/)hub(\/|$)/.test(r), `no capture-hub module: ${r}`);
    assert.ok(!/(^|\/)cli(\/|$)/.test(r), `no lib/cli path: ${r}`);
    assert.ok(!/(^|\/)(server|portal)(\/|$)/.test(r), `no lib/server or lib/portal: ${r}`);
  }
  for (const banned of ['5170', 'HUB_PORT', 'ensureHub', 'stopHub', 'process.kill(', 'server.json', 'commands/stop']) {
    assert.ok(!src.includes(banned), `lifecycle.js names ${banned}`);
  }
  const call = src.match(/subscribeSSE\(\{([\s\S]*?)\n {4}\}\);/);
  assert.ok(call, 'the one subscribeSSE call');
  assert.ok(!/\bkinds\b/.test(call[1]), 'the hold names no kinds');
  assert.ok(!/\bhold\b|\/ws/.test(call[1]), 'the hold sends no hold parameter and opens no socket');
  assert.equal((src.match(/subscribeSSE\(/g) || []).length, 1, 'one stream opener');
});

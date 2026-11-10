// The event-anchor stats exposure (annotation engine tranche 6, 6C.1, U761;
// C-5C-BD6; BD6@which-events L1 = a; REQ@stats-exposure A5 = a;
// U761@counts-whose-sockets H15 = a). The chrome sends its event-anchor
// engine's counts as `anchor_stats` on its client frame
// (public/app/anchor-stats.js); the daemon keeps the newest per LOCAL socket
// (lib/server/ws.js anchorStatsOf) and GET /api/elements/anchor-stats answers
// the host their sum and per-socket rows — counts only, never text or an id.
//
//   1. the route: two local sockets, the sum and the rows, the row's keys
//   2. host only: a browser, a remote, a network-less relayed request → 403
//   3. counts only: bad values and unknown keys dropped; non-objects no row
//   4. whose sockets: a remote socket's field ignored; a frame without the
//      field clears; a closed socket's row goes
//   5. the chrome module, as an ES module with no DOM
//
// The relay secret is a fresh random value per test process, carried only in
// request headers here: never printed. HOME is a sandbox (withServer's own).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const client = require('../lib/client');
const { withServer, waitUntil, wsConnect } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { LEVEL_HEADER, REMOTE_HEADER } = require('../lib/core/cors');
const { RELAY_HEADER } = require('../lib/core/writer-token');
const { HOST_ONLY } = require('../lib/server/audience');
const { anchorStatsOf, ANCHOR_STATS_KEYS, ANCHOR_STATS_MAX } = require('../lib/server/ws');
const { mountElementRoutes } = require('../lib/server/routes/elements');
const { createServer } = require('../lib/server');

const ROUTE = '/api/elements/anchor-stats';
const SECRET = crypto.randomBytes(32).toString('hex');
const KEYS = ['entries', 'observing', 'dirty', 'idlePending',
  'warm', 'cold', 'cold_missing', 'cold_dirty', 'built', 'idle', 'expired', 'released', 'oversize', 'none'];

// A full stats answer: every count `n + i`, idlePending as given.
function statsOf(n, idlePending = false) {
  const out = {};
  KEYS.forEach((k, i) => { out[k] = k === 'idlePending' ? idlePending : n + i; });
  return out;
}

// A socket with its frames collected; resolves once its hello is in. A local
// one carries a local Origin, as the chrome's does.
async function openSocket(t, port, headers = {}) {
  const ws = wsConnect(port, '/ws', { headers });
  t.after(() => { try { ws.terminate(); } catch {} });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await waitUntil(() => frames.some((f) => f.type === 'hello'), { timeout: 10000, interval: 5, what: 'the hello' });
  return { ws, send: (f) => ws.send(JSON.stringify(f)) };
}
const openLocal = (t, port) => openSocket(t, port, { Origin: `http://localhost:${port}` });
const clientFrame = (device, anchorStats) => ({ type: 'client', device, mirror: 'status', ...(anchorStats === undefined ? {} : { anchor_stats: anchorStats }) });

const read = async (port, headers) => client.request(port, 'GET', ROUTE, null, headers ? { headers } : undefined);
async function readUntil(port, pred, what) {
  let last = null;
  await waitUntil(async () => {
    last = await read(port);
    return last.status === 200 && pred(last.body);
  }, { timeout: 5000, interval: 10, what });
  return last.body;
}

// Every string in a JSON value, with the key it sits under.
function stringsIn(v, key = null, out = []) {
  if (typeof v === 'string') out.push([key, v]);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, key, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stringsIn(x, k, out);
  return out;
}

// ── 1. the route ────────────────────────────────────────────────────────────

test('the fourteen keys are the engine\'s stats() keys (event-anchor.js), in the chrome module and the daemon alike', async () => {
  assert.deepStrictEqual([...ANCHOR_STATS_KEYS], KEYS);
  assert.equal(ANCHOR_STATS_MAX, 1e9);
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'public/app/anchor-stats.js')).href);
  assert.deepStrictEqual([...mod.ANCHOR_STATS_KEYS], KEYS);
  // The engine's own answer has exactly these keys.
  const ea = await import(pathToFileURL(path.join(__dirname, '..', 'public/app/event-anchor.js')).href);
  const engine = ea.createEventAnchors({ anchors: { index() { return null; }, record() { return null; } }, MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } } });
  assert.deepStrictEqual(Object.keys(engine.stats()).sort(), [...KEYS].sort());
});

test('two local sockets: the host reads {ok, sockets, reporting, sum, rows} — the per-key sum, each row socket, device, at and the fourteen counts', async (t) => {
  const d = await withServer(t);
  const a = await openLocal(t, d.port);
  const b = await openLocal(t, d.port);
  const empty = await readUntil(d.port, (x) => x.sockets === 2, 'two sockets');
  assert.deepStrictEqual({ ...empty, sum: undefined }, { ok: true, sockets: 2, reporting: 0, sum: undefined, rows: [] });
  for (const k of KEYS) assert.equal(empty.sum[k], 0, k);

  const before = Date.now();
  a.send(clientFrame('desktop', statsOf(1, true)));
  b.send(clientFrame('mobile', statsOf(100, false)));
  const body = await readUntil(d.port, (x) => x.reporting === 2, 'both reporting');
  assert.equal(body.ok, true);
  assert.equal(body.sockets, 2);
  assert.deepStrictEqual(Object.keys(body).sort(), ['ok', 'reporting', 'rows', 'sockets', 'sum']);
  assert.equal(body.rows.length, 2);
  for (const r of body.rows) {
    assert.deepStrictEqual(Object.keys(r).sort(), ['at', 'device', 'socket', ...KEYS].sort());
    assert.ok(Number.isInteger(r.at) && r.at >= before && r.at <= Date.now() + 1, String(r.at));
  }
  const bySocket = [...body.rows].sort((x, y) => x.socket - y.socket);
  assert.deepStrictEqual(bySocket.map((r) => r.socket), [1, 2], '1-based ordinals in connection order');
  assert.deepStrictEqual(bySocket.map((r) => r.device), ['desktop', 'mobile']);
  for (const k of KEYS) {
    if (k === 'idlePending') assert.equal(body.sum[k], 1, 'idlePending: the rows where it is true');
    else assert.equal(body.sum[k], statsOf(1)[k] + statsOf(100)[k], k);
  }
  assert.deepStrictEqual(Object.keys(body.sum).sort(), [...KEYS].sort());
  // Counts only: the one string in the answer is a row's device.
  for (const [k] of stringsIn(body)) assert.equal(k, 'device');
  // lib/client's get reads it too (the main session's own way in).
  const viaGet = await client.get(ROUTE, { port: d.port, noSpawn: true });
  assert.equal(viaGet.reporting, 2);
});

// ── 2. host only ────────────────────────────────────────────────────────────

test('host only: a browser request (Origin, fetch metadata) and a remote request are refused 403 with the host-only hint', async (t) => {
  const d = await withServer(t);
  assert.equal((await read(d.port)).status, 200, 'the host\'s own process reads it');
  const withOrigin = await read(d.port, { Origin: `http://localhost:${d.port}` });
  assert.deepStrictEqual([withOrigin.status, withOrigin.body], [403, { ok: false, hint: HOST_ONLY }]);
  const pane = await d.anonApi.get(ROUTE);
  assert.equal(pane.status, 403, 'a pane\'s fetch (fetch metadata) is not the host');
  const remote = await read(d.port, { [REMOTE_HEADER]: '1' });
  assert.deepStrictEqual([remote.status, remote.body], [403, { ok: false, hint: HOST_ONLY }]);
});

test('host only: a relayed request (a valid relay credential, read or full stamp) is refused 403 — relayed is never the host', async (t) => {
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
  // The credential is live: the same headers read the mirror at the stamp.
  const access = await client.request(d.port, 'GET', '/api/mirror/access', null,
    { headers: { [REMOTE_HEADER]: '1', [RELAY_HEADER]: SECRET, [LEVEL_HEADER]: 'read' } });
  assert.equal(access.status, 200);
  assert.equal(access.body.level, 'read', 'a valid credential at its read stamp');
  for (const stamp of ['read', 'full']) {
    const r = await read(d.port, { [REMOTE_HEADER]: '1', [RELAY_HEADER]: SECRET, [LEVEL_HEADER]: stamp });
    assert.deepStrictEqual([r.status, r.body], [403, { ok: false, hint: HOST_ONLY }], stamp);
  }
  assert.equal((await read(d.port)).status, 200);
});

test('a route context without anchorStats (a server built with no WebSocket API) answers 503 with a hint', () => {
  const routes = new Map();
  const app = new Proxy({}, { get: (_, verb) => (p, ...handlers) => { routes.set(`${String(verb).toUpperCase()} ${p}`, handlers); } });
  const pass = () => (req, res, next) => next();
  const audience = { requireHost: pass, requireMirror: pass, levelOf: () => 'local', rank: () => 0, seesPrivate: () => false, isHost: () => true };
  mountElementRoutes(app, { state: {}, bus: {}, audience, writers: { resolveWriter() {} }, graph: { elements: {} } });
  const handlers = routes.get(`GET ${ROUTE}`);
  assert.ok(handlers, 'the route is mounted');
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const run = (i) => (i < handlers.length ? handlers[i]({ headers: {} }, res, () => run(i + 1)) : undefined);
  run(0);
  assert.equal(res.code, 503);
  assert.equal(res.body.ok, false);
  assert.equal(typeof res.body.hint, 'string');
});

// ── 3. counts only ──────────────────────────────────────────────────────────

test('anchorStatsOf keeps the fourteen known keys only — non-negative safe integers up to 1e9, idlePending a boolean; a non-object is null', () => {
  const kept = anchorStatsOf({
    entries: 3, observing: 'two', dirty: -1, idlePending: 'yes', warm: 1.5, cold: 1e9 + 1, cold_missing: 1e9,
    cold_dirty: { n: 1 }, built: [1], idle: 0, expired: Number.MAX_SAFE_INTEGER, released: NaN, oversize: Infinity, none: 7,
    extra: 5, __proto__x: 1, label: 'secret text',
  }, 1234);
  assert.deepStrictEqual(kept, { at: 1234, counts: { entries: 3, cold_missing: 1e9, idle: 0, none: 7 } });
  assert.deepStrictEqual(anchorStatsOf({ idlePending: true }, 1).counts, { idlePending: true });
  assert.deepStrictEqual(anchorStatsOf({ idlePending: false }, 1).counts, { idlePending: false });
  for (const bad of ['a string', [1, 2], null, undefined, 5, true, new Date(0), Object.create({ entries: 1 })]) {
    assert.equal(anchorStatsOf(bad, 1), null, String(bad));
  }
  // An inherited key is not the value's own.
  assert.deepStrictEqual(anchorStatsOf(Object.assign(Object.create(null), { dirty: 2 }), 1).counts, { dirty: 2 });
});

test('counts only, through the socket: bad values and unknown keys are dropped; a non-object anchor_stats leaves the socket with no row', async (t) => {
  const d = await withServer(t);
  const a = await openLocal(t, d.port);
  const b = await openLocal(t, d.port);
  a.send(clientFrame('desktop', {
    entries: 4, observing: 'x', dirty: -2, warm: 0.5, cold: 2e9, cold_missing: { deep: 1 }, built: 9,
    mount: 'm1', text: 'hello', id: 'el-1', idlePending: 'no',
  }));
  const body = await readUntil(d.port, (x) => x.reporting === 1, 'one reporting');
  assert.equal(body.rows.length, 1);
  const row = body.rows[0];
  assert.deepStrictEqual(Object.keys(row).sort(), ['at', 'built', 'device', 'entries', 'socket']);
  assert.deepStrictEqual([row.entries, row.built, row.device], [4, 9, 'desktop']);
  for (const [k] of stringsIn(body)) assert.equal(k, 'device');
  assert.equal(body.sum.entries, 4);
  assert.equal(body.sum.observing, 0);
  // A string, an array, null: no row (the socket's earlier stats are cleared too).
  for (const bad of ['counts', [1, 2, 3], null]) {
    b.send(clientFrame('desktop', statsOf(5)));
    await readUntil(d.port, (x) => x.reporting === 2, 'b reporting');
    b.send(clientFrame('desktop', bad));
    const after = await readUntil(d.port, (x) => x.reporting === 1, `b cleared by ${JSON.stringify(bad)}`);
    assert.deepStrictEqual(after.rows.map((r) => r.socket), [1]);
    assert.equal(after.sockets, 2);
  }
});

// ── 4. whose sockets ────────────────────────────────────────────────────────

test('local sockets only: a remote socket\'s anchor_stats is ignored; a frame without the field clears; a closed socket\'s row is gone', async (t) => {
  const d = await withServer(t);
  const local = await openLocal(t, d.port);
  const remote = await openSocket(t, d.port, { [REMOTE_HEADER]: '1' });
  local.send(clientFrame('desktop', statsOf(10)));
  const base = await readUntil(d.port, (x) => x.reporting === 1, 'the local one');
  assert.equal(base.sockets, 1, 'a remote socket is not counted among the sockets');
  remote.send(clientFrame('mobile', statsOf(1000, true)));
  // A marker frame on the local socket after it: once that lands, the remote
  // frame (sent first) has been handled.
  const marker = await openLocal(t, d.port);
  marker.send(clientFrame('desktop', statsOf(0)));
  const seen = await readUntil(d.port, (x) => x.reporting === 2, 'the marker');
  assert.equal(seen.sockets, 2);
  for (const k of KEYS) {
    if (k === 'idlePending') assert.equal(seen.sum[k], 0, 'the remote socket\'s idlePending is not counted');
    else assert.equal(seen.sum[k], statsOf(10)[k] + statsOf(0)[k], k);
  }
  assert.ok(!seen.rows.some((r) => r.device === 'mobile'), 'no row from the remote socket');
  // A later client frame without the field clears that socket's row.
  marker.send(clientFrame('desktop'));
  const cleared = await readUntil(d.port, (x) => x.reporting === 1, 'the marker cleared');
  assert.deepStrictEqual(cleared.rows.map((r) => r.socket), [1]);
  assert.equal(cleared.sum.entries, statsOf(10).entries);
  // A closed socket's row goes with it.
  local.ws.close();
  const closed = await readUntil(d.port, (x) => x.sockets === 1, 'the local socket closed');
  assert.deepStrictEqual([closed.reporting, closed.rows], [0, []]);
  for (const k of KEYS) assert.equal(closed.sum[k], 0, k);
});

// ── 5. the chrome module ────────────────────────────────────────────────────

async function chromeModule() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public/app/anchor-stats.js')).href);
}
// A fake ws.js and window: the field sets, the hello hooks and one interval.
function harness(statsFn) {
  const sets = [];
  const hellos = [];
  const intervals = new Map();
  let nextId = 1;
  let pagehide = null;
  const deps = {
    stats: statsFn,
    setClientField: (k, v) => sets.push([k, v]),
    onHello: (fn) => { hellos.push(fn); return () => { const i = hellos.indexOf(fn); if (i >= 0) hellos.splice(i, 1); }; },
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { intervals.delete(id); },
    onPageHide: (fn) => { pagehide = fn; },
  };
  return {
    deps, sets, hellos, intervals,
    hello: () => { for (const h of [...hellos]) h({ type: 'hello' }); },
    tick: () => { for (const i of [...intervals.values()]) i.fn(); },
    pagehide: () => pagehide && pagehide(),
  };
}

test('chrome: anchor_stats is set on init when stats() answers, nothing when it is null; a fresh plain object of the known keys', async () => {
  const m = await chromeModule();
  assert.equal(m.ANCHOR_STATS_EVERY_MS, 30000);
  const none = harness(() => null);
  m.initAnchorStats(none.deps);
  assert.deepStrictEqual(none.sets, [], 'no engine, nothing sent');
  none.hello();
  none.tick();
  assert.deepStrictEqual(none.sets, [], 'still nothing on a hello or a tick');
  assert.equal([...none.intervals.values()][0].ms, 30000);

  const engine = { ...statsOf(2), extra: 'text', mount: 'm-1' };
  const h = harness(() => engine);
  m.initAnchorStats(h.deps);
  assert.equal(h.sets.length, 1);
  const [key, value] = h.sets[0];
  assert.equal(key, 'anchor_stats');
  assert.deepStrictEqual(value, statsOf(2));
  assert.notStrictEqual(value, engine, 'a fresh object, never the engine\'s');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
});

test('chrome: re-set on every hello; the 30 s tick re-sets only when dirty > 0 or a count moved; never a key outside the fourteen', async () => {
  const m = await chromeModule();
  let s = null;
  const h = harness(() => s);
  m.initAnchorStats(h.deps);
  assert.equal(h.sets.length, 0);
  // The engine is made between ticks: the next tick sends it (a count moved from nothing).
  s = { ...statsOf(0), dirty: 0 };
  h.tick();
  assert.equal(h.sets.length, 1, 'the first answer after the engine exists');
  // Unchanged and clean: nothing.
  h.tick();
  h.tick();
  assert.equal(h.sets.length, 1, 'no change, no dirt: no re-send');
  // A hello re-sets whatever stats() answers.
  h.hello();
  assert.equal(h.sets.length, 2, 'a hello re-sets');
  // A count moved: one re-send, then quiet again.
  s = { ...s, warm: s.warm + 1 };
  h.tick();
  assert.equal(h.sets.length, 3);
  h.tick();
  assert.equal(h.sets.length, 3);
  // dirty > 0: re-sent every tick while it lasts.
  s = { ...s, dirty: 2 };
  h.tick();
  h.tick();
  assert.equal(h.sets.length, 5, 'dirty re-sends each tick');
  s = { ...s, dirty: 0 };
  h.tick();
  h.tick();
  assert.equal(h.sets.length, 6, 'the move back to clean once, then quiet');
  // Never a key outside the fourteen.
  s = { ...s, extra: 1, text: 'x', released: s.released + 1 };
  h.tick();
  for (const [k, v] of h.sets) {
    assert.equal(k, 'anchor_stats');
    for (const key of Object.keys(v)) assert.ok(KEYS.includes(key), key);
  }
  // A throwing stats() sends nothing.
  const bad = harness(() => { throw new Error('no'); });
  m.initAnchorStats(bad.deps);
  bad.tick();
  bad.hello();
  assert.deepStrictEqual(bad.sets, []);
});

test('chrome: pagehide clears the interval (no armed timer left); a later hello re-arms it; stop() takes the hello hook off', async () => {
  const m = await chromeModule();
  const h = harness(() => statsOf(1));
  const api = m.initAnchorStats(h.deps);
  assert.equal(h.intervals.size, 1);
  h.pagehide();
  assert.equal(h.intervals.size, 0, 'cleared on pagehide');
  h.hello();
  assert.equal(h.intervals.size, 1, 're-armed by a hello (back from the cache)');
  api.stop();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.hellos.length, 0);
});

test('chrome: anchorStatsKey moves with any count and only with a known key', async () => {
  const m = await chromeModule();
  assert.equal(m.anchorStatsKey(null), null);
  assert.equal(m.anchorStatsKey('x'), null);
  const a = statsOf(3);
  assert.equal(m.anchorStatsKey(a), m.anchorStatsKey({ ...a }));
  assert.equal(m.anchorStatsKey(a), m.anchorStatsKey({ ...a, other: 9 }), 'an unknown key does not move it');
  for (const k of KEYS) {
    const b = { ...a, [k]: k === 'idlePending' ? !a[k] : a[k] + 1 };
    assert.notEqual(m.anchorStatsKey(b), m.anchorStatsKey(a), k);
  }
});

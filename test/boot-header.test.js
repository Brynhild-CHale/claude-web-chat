// The boot (PLAN-T6 U749; 07 C-07.8, C-07.9, C-07.10a, C-07.15):
//
//   * the boot id is random per createServer and carries no pid — two servers
//     built in one millisecond (a frozen clock) differ — and GET /api/health's
//     `boot` is the X-WC-Boot header;
//   * X-WC-Boot is on every response: a 200, a 404, the Host gate's 421 and the
//     event stream's headers;
//   * the main ring's size follows `eventRing` / WEB_CHAT_EVENT_RING up to
//     10000, with today's 1000 as the floor and the default;
//   * the walk seam (`firstPort` / WEB_CHAT_FIRST_PORT): set, start()'s 'auto'
//     walk begins there and never lands on 5170, 5171 or 5173–5272; unset, its
//     first candidate is 5173 — read through an injected portIsTaken that
//     answers "taken" for every candidate, so nothing in the production range is
//     ever bound or dialled;
//   * `?hold=0` keeps a HOST stream from retaining the daemon; from a labelled
//     remote request (or a browser) it is ignored and the stream retains.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const express = require('express');

const { withServer, waitUntil } = require('../test-support/helpers');
const { createServer } = require('../lib/server');
const { createBus, MAX_EVENTS } = require('../lib/core/bus');
const { BOOT_HEADER, REMOTE_HEADER, REMOTE_HEADER_VALUE, LISTEN_HOST } = require('../lib/core/cors');
const { mountEventRoutes } = require('../lib/server/routes/events');

const BOOT = BOOT_HEADER.toLowerCase();
const isReserved = (p) => p === 5170 || p === 5171 || (p >= 5173 && p <= 5272);

// One GET over a fresh socket. A stream's answer resolves at its headers (the
// request is then destroyed); any other answer resolves with its body read.
function rawGet(port, path, { headers = {}, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false }, (res) => {
      if (stream) {
        resolve({ status: res.statusCode, headers: res.headers });
        req.destroy();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => { if (!stream || e.code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

// A stream left open until the test ends (so the retain it took is visible).
function openStream(t, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false }, (res) => {
      res.on('data', () => {});
      resolve({ status: res.statusCode, headers: res.headers, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
    t.after(() => req.destroy());
  });
}

const withOpts = (extra) => (o) => createServer({ ...o, ...extra });

// withServer, then one turn of the event loop: the daemon writes its graph
// index on the first immediate after the listen (lib/server/index.js), and a
// test body that finishes synchronously would otherwise tear the root down
// first (a harmless "could not write the graph index" line on stderr).
async function serve(t, opts) {
  const ctx = await withServer(t, opts);
  await new Promise((resolve) => setImmediate(resolve));
  return ctx;
}

// ── the boot id ──────────────────────────────────────────────────────────────

test('boot id: two servers built in one millisecond (a frozen clock) get different, pid-free ids', async (t) => {
  const realNow = Date.now;
  const frozen = (o) => {
    Date.now = () => 1_800_000_000_000;
    try { return createServer(o); } finally { Date.now = realNow; }
  };
  const a = await serve(t, { createServer: frozen });
  const b = await serve(t, { createServer: frozen });
  const ida = a.srv.bus.bootId;
  const idb = b.srv.bus.bootId;
  assert.equal(typeof ida, 'string');
  assert.match(ida, /^[0-9a-f]{32}$/, 'random hex, 16 bytes');
  assert.match(idb, /^[0-9a-f]{32}$/);
  assert.notEqual(ida, idb, 'unique per createServer, whatever the clock says');
  // No pid: not the old `${pid}:${ms}` form, and nothing but the random hex
  // (a pid's digits may appear in 32 random hex characters by chance, so the
  // shape is the assertion, not a substring search).
  for (const id of [ida, idb]) {
    assert.ok(!id.includes(':'), 'not the old pid:ms form');
    assert.ok(!id.startsWith(`${process.pid}:`), 'carries no pid');
    assert.notEqual(id, `${process.pid}:1800000000000`);
  }
  assert.equal(a.srv.bus.bootId, ida, 'the main bus carries it');
});

test('boot id: injectable for tests; health.boot equals the X-WC-Boot header', async (t) => {
  const { port, srv } = await serve(t, { createServer: withOpts({ bootId: 'boot-under-test' }) });
  assert.equal(srv.bus.bootId, 'boot-under-test');
  const health = await rawGet(port, '/api/health');
  assert.equal(health.status, 200);
  const body = JSON.parse(health.body);
  assert.equal(body.boot, 'boot-under-test');
  assert.equal(health.headers[BOOT], body.boot, 'the header names the boot health reports');

  // And with the random id: still equal.
  const r = await serve(t);
  const h2 = await rawGet(r.port, '/api/health');
  assert.equal(h2.headers[BOOT], JSON.parse(h2.body).boot);
  assert.equal(h2.headers[BOOT], r.srv.bus.bootId);
});

// ── the header on every response ─────────────────────────────────────────────

test('X-WC-Boot is on a 200, a 404, a 421 (wrong Host) and the event stream', async (t) => {
  const { port, srv } = await serve(t);
  const boot = srv.bus.bootId;

  const ok = await rawGet(port, '/api/health');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers[BOOT], boot, 'a 200');

  const missing = await rawGet(port, '/api/no-such-route-u749');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers[BOOT], boot, 'a 404');

  const misdirected = await rawGet(port, '/api/health', { headers: { host: `rebound.example:${port}` } });
  assert.equal(misdirected.status, 421, 'the Host gate refused it');
  assert.equal(misdirected.headers[BOOT], boot, 'a 421: the boot middleware sits above the Host gate');

  const stream = await rawGet(port, '/api/events/stream?since=0', { stream: true });
  assert.equal(stream.status, 200);
  assert.match(String(stream.headers['content-type']), /text\/event-stream/);
  assert.equal(stream.headers[BOOT], boot, 'the stream names its boot');
});

// ── the ring size ────────────────────────────────────────────────────────────

async function ringAfter(t, opts, emits) {
  const { srv } = await serve(t, opts);
  for (let i = 0; i < emits; i++) srv.bus.emit({ event: { kind: 'u749-probe', i } });
  return srv.bus.events.length;
}

test('ring: eventRing 5000 keeps 5000 events; 20000 is capped at 10000', async (t) => {
  assert.equal(MAX_EVENTS, 1000, 'the floor this unit reads');
  assert.equal(await ringAfter(t, { createServer: withOpts({ eventRing: 5000 }) }, 6000), 5000);
  assert.equal(await ringAfter(t, { createServer: withOpts({ eventRing: 20000 }) }, 12000), 10000);
});

test('ring: 10 and "x" give the default 1000; unset is 1000', async (t) => {
  assert.equal(await ringAfter(t, { createServer: withOpts({ eventRing: 10 }) }, 1100), 1000);
  assert.equal(await ringAfter(t, { createServer: withOpts({ eventRing: 'x' }) }, 1100), 1000);
  assert.equal(await ringAfter(t, {}, 1100), 1000, 'no option and no variable: today\'s ring');
});

test('ring: WEB_CHAT_EVENT_RING is read once at construction', async (t) => {
  const prev = process.env.WEB_CHAT_EVENT_RING;
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_EVENT_RING; else process.env.WEB_CHAT_EVENT_RING = prev; });
  process.env.WEB_CHAT_EVENT_RING = '2500';
  const { srv } = await serve(t);
  // Changed after construction: no effect on this server.
  process.env.WEB_CHAT_EVENT_RING = '1000';
  for (let i = 0; i < 3000; i++) srv.bus.emit({ event: { kind: 'u749-probe', i } });
  assert.equal(srv.bus.events.length, 2500);
});

// ── the walk seam ────────────────────────────────────────────────────────────

// A free loopback port, from a listen(0) probe that is closed again at once.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, LISTEN_HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// A server built with port 'auto' whose walk only RECORDS: every candidate
// answers "taken", so start() binds nothing and dials nothing and throws when
// the walk runs out. withServer itself listens on an ephemeral loopback port.
async function recordingWalk(t, extra = {}) {
  const candidates = [];
  const portIsTaken = async (p) => { candidates.push(p); return true; };
  const ctx = await serve(t, { createServer: (o) => createServer({ ...o, port: 'auto', portIsTaken, ...extra }) });
  await assert.rejects(ctx.srv.start({ writePortfile: false }), /no free port found/);
  return candidates;
}

test('walk seam: firstPort set to a free band port binds at or above it, never on a reserved port', async (t) => {
  const first = await freePort();
  assert.ok(!isReserved(first), 'the probe gave an ephemeral port outside the reserved band');
  const { srv } = await serve(t, { mode: 'start', createServer: withOpts({ firstPort: first }) });
  const bound = srv.server.address().port;
  assert.ok(bound >= first, `bound ${bound} at or above ${first}`);
  assert.ok(bound < first + 100, 'within the walk');
  assert.ok(!isReserved(bound), `bound ${bound} is not 5170, 5171 or 5173–5272`);
});

test('walk seam: from a first port below the band, every reserved port is skipped', async (t) => {
  const candidates = await recordingWalk(t, { firstPort: 5168 });
  assert.equal(candidates.length, 100, 'one hundred ports tried');
  assert.deepEqual(candidates.slice(0, 4), [5168, 5169, 5172, 5273], '5170, 5171 and 5173–5272 skipped');
  assert.deepEqual(candidates.filter(isReserved), [], 'no reserved candidate was ever probed');
});

test('walk seam: unset, the walk is today\'s — its first candidate is 5173', async (t) => {
  const prev = process.env.WEB_CHAT_FIRST_PORT;
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_FIRST_PORT; else process.env.WEB_CHAT_FIRST_PORT = prev; });
  delete process.env.WEB_CHAT_FIRST_PORT;
  const candidates = await recordingWalk(t);
  assert.equal(candidates[0], 5173);
  assert.deepEqual(candidates, Array.from({ length: 100 }, (_, i) => 5173 + i), 'byte-for-byte today\'s 5173..5272');
});

test('walk seam: WEB_CHAT_FIRST_PORT is read once; a malformed value is ignored with one log line', async (t) => {
  const prev = process.env.WEB_CHAT_FIRST_PORT;
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_FIRST_PORT; else process.env.WEB_CHAT_FIRST_PORT = prev; });

  process.env.WEB_CHAT_FIRST_PORT = '5150';
  const fromEnv = await recordingWalk(t);
  assert.equal(fromEnv[0], 5150, 'the variable names the first port');
  assert.deepEqual(fromEnv.filter(isReserved), []);

  for (const bad of ['not-a-port', '80', '70000']) {
    process.env.WEB_CHAT_FIRST_PORT = bad;
    const lines = [];
    const realError = console.error;
    console.error = (...a) => { lines.push(a.join(' ')); };
    let candidates;
    try { candidates = await recordingWalk(t); } finally { console.error = realError; }
    assert.equal(candidates[0], 5173, `${bad}: ignored, the walk is today's`);
    assert.equal(lines.filter((l) => /WEB_CHAT_FIRST_PORT/.test(l)).length, 1, `${bad}: one log line`);
  }
});

// ── hold=0 ───────────────────────────────────────────────────────────────────

// The events route on a bare app, with counting retain/release and the route's
// own fallback audience (no opt-in: a labelled remote request is never host).
async function eventsRig(t) {
  const calls = { retain: 0, release: 0 };
  const sseClients = new Set();
  const state = { wakeConsumers: 0, pendingWake: null, pendingAck: null };
  const bus = createBus({ bootId: 'rig-boot' });
  const app = express();
  mountEventRoutes(app, {
    state, bus, graph: null,
    retain: () => { calls.retain += 1; },
    release: () => { calls.release += 1; },
    sseClients,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => {
    for (const res of [...sseClients]) { try { res.end(); } catch {} }
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { calls, sseClients, port: server.address().port };
}

test('hold=0: a host stream does not retain the daemon; a labelled remote or browser request retains as today', async (t) => {
  const r = await eventsRig(t);

  const host = await openStream(t, r.port, '/api/events/stream?since=0&hold=0');
  assert.equal(host.status, 200);
  assert.equal(host.headers[BOOT], 'rig-boot', 'the stream names its bus\'s boot');
  await waitUntil(() => r.sseClients.size === 1, { what: 'the host stream registered' });
  assert.deepEqual(r.calls, { retain: 0, release: 0 }, 'a host hold=0 stream leaves the retain counter unchanged');

  const remote = await openStream(t, r.port, '/api/events/stream?since=0&hold=0', { [REMOTE_HEADER]: REMOTE_HEADER_VALUE });
  assert.equal(remote.status, 200);
  await waitUntil(() => r.sseClients.size === 2, { what: 'the remote stream registered' });
  assert.equal(r.calls.retain, 1, 'from a labelled remote request hold=0 is ignored: it retains');

  const browser = await openStream(t, r.port, '/api/events/stream?since=0&hold=0', { origin: `http://127.0.0.1:${r.port}` });
  assert.equal(browser.status, 200);
  await waitUntil(() => r.sseClients.size === 3, { what: 'the browser stream registered' });
  assert.equal(r.calls.retain, 2, 'from a browser hold=0 is ignored: it retains');

  const plain = await openStream(t, r.port, '/api/events/stream?since=0');
  assert.equal(plain.status, 200);
  await waitUntil(() => r.sseClients.size === 4, { what: 'the plain host stream registered' });
  assert.equal(r.calls.retain, 3, 'a host stream without hold=0 retains, as today');

  // Closing: only the retaining streams release.
  host.close();
  await waitUntil(() => r.sseClients.size === 3, { what: 'the hold=0 stream closed' });
  assert.equal(r.calls.release, 0, 'the hold=0 stream releases nothing');
  remote.close(); browser.close(); plain.close();
  await waitUntil(() => r.sseClients.size === 0, { what: 'every stream closed' });
  assert.deepEqual(r.calls, { retain: 3, release: 3 });
});

// The daemon's keep-alive (lib/server/ws.js): every HEARTBEAT_INTERVAL_MS it
// pings each socket, and a socket that has not answered the PREVIOUS interval's
// ping by the next one is terminated. It used to be terminated 5 s after a
// ping, through a per-socket backup timer armed on every interval — so a
// laptop that slept for a few seconds, or a background tab WebKit had frozen,
// lost its socket, and the viewer count's drop to zero restarted every service
// (design/tools/t567-inputs/safari-report.md item 2; ruled 2026-10-13,
// U101@heartbeat: dropped only after missing a whole interval).
//
// A real server through withServer, with the interval set to 100 ms through the
// module's own export before boot (attachWebSocket reads its default from there
// at attach time) and put back after. The viewer count is /api/health's.

const test = require('node:test');
const assert = require('node:assert');
const { withServer, waitUntil, deafWs } = require('../test-support/helpers');
const wsModule = require('../lib/server/ws');

const INTERVAL = 100;

function fastHeartbeat(t) {
  const prev = wsModule.HEARTBEAT_INTERVAL_MS;
  wsModule.HEARTBEAT_INTERVAL_MS = INTERVAL;
  t.after(() => { wsModule.HEARTBEAT_INTERVAL_MS = prev; });
}

const viewers = async (api) => (await api.get('/api/health')).json.viewers;

async function openClient(t, ctx, opts) {
  const sock = ctx.ws('/ws', opts);
  t.after(() => { try { sock.terminate(); } catch {} });
  await new Promise((res, rej) => { sock.once('open', res); sock.once('error', rej); });
  return sock;
}

test('the interval is exported, 30 s by default, and the 5 s after-ping timeout is gone', () => {
  assert.equal(wsModule.HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal('HEARTBEAT_TIMEOUT_MS' in wsModule, false, 'no per-ping timeout any more');
});

test('a socket that answers every ping is kept across ten intervals', async (t) => {
  fastHeartbeat(t);
  const ctx = await withServer(t);
  const sock = await openClient(t, ctx);
  let pings = 0;
  sock.on('ping', () => { pings += 1; });
  let closed = false;
  sock.on('close', () => { closed = true; });
  await waitUntil(async () => (await viewers(ctx.api)) === 1, { what: 'the viewer to count' });
  await waitUntil(() => pings >= 10, { timeout: 10 * INTERVAL + 2000, what: 'ten pings' });
  assert.equal(closed, false, 'the server never dropped it');
  assert.equal(sock.readyState, 1);
  assert.equal(await viewers(ctx.api), 1, 'still one viewer');
});

test('a socket that answers each ping late, but within the interval, is never dropped', async (t) => {
  fastHeartbeat(t);
  const ctx = await withServer(t);
  // ws answers a ping itself unless autoPong is off: this one answers 60 % of
  // an interval late — the shape of a tab that was frozen for a moment.
  const sock = await openClient(t, ctx, { autoPong: false });
  let pings = 0;
  sock.on('ping', (data) => {
    pings += 1;
    setTimeout(() => { try { sock.pong(data); } catch {} }, INTERVAL * 0.6);
  });
  let closed = false;
  sock.on('close', () => { closed = true; });
  await waitUntil(() => pings >= 6, { timeout: 6 * INTERVAL + 2000, what: 'six pings' });
  assert.equal(closed, false, 'a late pong inside the interval keeps the socket');
  assert.equal(await viewers(ctx.api), 1);
});

test('a deaf socket is terminated one whole interval after the ping it ignored, not before; the viewer count follows', async (t) => {
  fastHeartbeat(t);
  const ctx = await withServer(t);
  const sock = await deafWs(t, ctx.port);
  const joined = Date.now();
  // The server's ping is an unmasked, empty control frame: 0x89 0x00. The
  // deaf socket reads it and never answers.
  const PING = Buffer.from([0x89, 0x00]);
  let firstPingAt = null;
  let closedAt = null;
  sock.on('data', (d) => { if (firstPingAt === null && d.includes(PING)) firstPingAt = Date.now(); });
  sock.on('close', () => { closedAt = Date.now(); });
  await waitUntil(async () => (await viewers(ctx.api)) === 1, { what: 'the deaf viewer to count' });
  await waitUntil(() => firstPingAt !== null, { timeout: 2 * INTERVAL + 2000, what: 'the first ping' });
  assert.equal(closedAt, null, 'the ping that found it alive did not drop it');
  await waitUntil(async () => (await viewers(ctx.api)) === 0, { timeout: 4 * INTERVAL + 2000, what: 'the deaf viewer to go' });
  await waitUntil(() => closedAt !== null, { what: 'the server to terminate the deaf socket' });
  assert.ok(closedAt - firstPingAt >= INTERVAL - 10,
    `terminated ${closedAt - firstPingAt} ms after the ping it missed: no sooner than one interval (${INTERVAL} ms)`);
  assert.ok(closedAt - joined < 3 * INTERVAL + 1000, 'and not kept much past its second interval');
});

// The regression itself: the old 5 s per-ping timeout is longer than the
// 100 ms interval above, so those tests cannot see it come back. Here the
// interval is longer than 5 s and the pong comes 5.5 s after the ping: the old
// timer dropped the socket at 5 s; now it lives to the next ping.
test('a pong 5.5 s late, inside a 7 s interval, keeps the socket (no fixed 5 s timeout)', { timeout: 30_000 }, async (t) => {
  const prev = wsModule.HEARTBEAT_INTERVAL_MS;
  wsModule.HEARTBEAT_INTERVAL_MS = 7000;
  t.after(() => { wsModule.HEARTBEAT_INTERVAL_MS = prev; });
  const ctx = await withServer(t);
  const sock = await openClient(t, ctx, { autoPong: false });
  let pings = 0;
  const late = [];
  t.after(() => late.forEach(clearTimeout));
  sock.on('ping', (data) => {
    pings += 1;
    late.push(setTimeout(() => { try { sock.pong(data); } catch {} }, 5500));
  });
  let closed = false;
  sock.on('close', () => { closed = true; });
  await waitUntil(() => pings >= 2 || closed, { timeout: 20_000, what: 'the second ping, or a drop' });
  assert.equal(closed, false, 'dropped before the next ping: a fixed timeout shorter than the interval is back');
  assert.equal(await viewers(ctx.api), 1);
});

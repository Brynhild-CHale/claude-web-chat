// lib/server/ws.js getViewerSummary() (spec §4.3): who is watching, for the asks
// domain's `answerable` — the open sockets of each kind of peer, and when each
// kind was last connected (now while one is open, the close time after).
//
// Real `ws` clients against the real attachWebSocket on a bare loopback http
// server, with a real audience over a scratch tunnel.json (test/ws-projection's
// rig): a remote viewer connects as the portal's relay does, with
// `X-WC-Remote: 1` from loopback; a network peer is a stubbed
// `req.socket.remoteAddress` on its upgrade (spec §10.1) and counts as neither
// local nor remote (Q9, carve-strict).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { waitUntil, wsConnect } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { createBus } = require('../lib/core/bus');
const { createState } = require('../lib/server/state');
const { createAudience } = require('../lib/server/audience');
const { attachWebSocket } = require('../lib/server/ws');

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});

async function wsHost(t, { optIn } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-viewers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const configFile = path.join(dir, 'tunnel', 'tunnel.json');
  writeJsonAtomic(configFile, optIn ? { ...TUNNEL, remote: { mirror: { [root]: optIn } } } : { ...TUNNEL });
  const audience = createAudience({ root, configFile, pollMs: 25 });
  t.after(() => audience.stop());
  const httpServer = http.createServer((r, res) => { res.statusCode = 404; res.end(); });
  httpServer.prependListener('upgrade', (r) => {
    const addr = r.headers['x-test-peer'];
    if (addr) Object.defineProperty(r.socket, 'remoteAddress', { value: addr, configurable: true });
  });
  const api = attachWebSocket(httpServer, {
    state: createState(), graph: { active: null, nodes: new Map(), lock: null }, paths: null,
    bus: createBus(), projectName: 'proj', audience,
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    api.shutdown();
    api.terminate();
    httpServer.closeAllConnections();
    httpServer.close(r);
  }));
  return { api, port: httpServer.address().port, optIn: (level) => writeJsonAtomic(configFile, { ...TUNNEL, remote: { mirror: { [root]: level } } }) };
}

async function connect(t, host, headers) {
  const before = host.api.clients.size;
  const ws = wsConnect(host.port, '/ws', headers ? { headers } : undefined);
  t.after(() => { try { ws.terminate(); } catch {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await waitUntil(() => host.api.clients.size > before, { timeout: 10000, interval: 5, what: 'the socket joining' });
  return ws;
}

async function close(host, ws) {
  const before = host.api.clients.size;
  ws.close();
  await waitUntil(() => host.api.clients.size < before, { timeout: 10000, interval: 5, what: 'the socket leaving' });
}

test('getViewerSummary: a local, a remote and a network-peer socket count as local 1, remote 1 and neither', async (t) => {
  const host = await wsHost(t, { optIn: 'read' });
  assert.deepEqual(host.api.getViewerSummary(), { local: 0, remote: 0, last_local_at: null, last_remote_at: null, last_full_remote_at: null });
  await connect(t, host);
  await connect(t, host, { 'X-WC-Remote': '1' });
  await connect(t, host, { 'x-test-peer': '192.168.1.20' });
  assert.equal(host.api.clients.size, 3);
  const before = Date.now();
  const s = host.api.getViewerSummary();
  assert.equal(s.local, 1);
  assert.equal(s.remote, 1);
  assert.ok(s.last_local_at >= before, 'now while one is open');
  assert.ok(s.last_remote_at >= before);
  assert.equal(s.last_full_remote_at, null, 'a remote viewer at read is not a full one');
});

test('getViewerSummary: last_local_at holds the close time after the socket closes; a network peer never stamps it', async (t) => {
  const host = await wsHost(t);
  const peer = await connect(t, host, { 'x-test-peer': '10.1.2.3' });
  await close(host, peer);
  assert.equal(host.api.getViewerSummary().last_local_at, null);
  const ws = await connect(t, host);
  const t0 = Date.now();
  await close(host, ws);
  const t1 = Date.now();
  const s = host.api.getViewerSummary();
  assert.equal(s.local, 0);
  assert.ok(s.last_local_at >= t0 && s.last_local_at <= t1, 'the close time');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.api.getViewerSummary().last_local_at, s.last_local_at, 'it stays put');
});

test('getViewerSummary: last_full_remote_at moves only for a remote socket at full', async (t) => {
  const host = await wsHost(t, { optIn: 'read' });
  const local = await connect(t, host);
  const reader = await connect(t, host, { 'X-WC-Remote': '1' });
  await close(host, reader);
  await close(host, local);
  let s = host.api.getViewerSummary();
  assert.equal(s.last_full_remote_at, null, 'neither a local socket nor a remote one at read');
  assert.ok(s.last_remote_at > 0);

  const full = await wsHost(t, { optIn: 'full' });
  const viewer = await connect(t, full, { 'X-WC-Remote': '1' });
  const t0 = Date.now();
  s = full.api.getViewerSummary();
  assert.ok(s.last_full_remote_at >= t0, 'now while it is open');
  await close(full, viewer);
  const closedAt = full.api.getViewerSummary().last_full_remote_at;
  assert.ok(closedAt >= t0 && closedAt <= Date.now());

  // A full viewer whose level drops to read stops counting from that moment.
  await connect(t, full, { 'X-WC-Remote': '1' });
  assert.ok(full.api.getViewerSummary().last_full_remote_at >= closedAt);
  full.optIn('read');
  await waitUntil(() => [...full.api.clients].every((c) => c._wc.level === 'read'), { timeout: 10000, interval: 5, what: 'the level drop' });
  const dropped = full.api.getViewerSummary();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(full.api.getViewerSummary().last_full_remote_at, dropped.last_full_remote_at, 'no longer now');
  assert.equal(dropped.remote, 1);
});

// The WebSocket's upstream half (lib/relay/ws-upstream.js, openUpstream) and
// the portal's createWsRelay rebuilt over it (lib/portal/ws-relay.js).
//
// A ws.Server on 127.0.0.1:0 stands in for the daemon's /ws; nothing here
// reaches a real daemon. The portal's leg is pinned byte for byte where its
// bytes are the point (the 502 refusals, the code-less close).

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { waitUntil, freePort } = require('../test-support/helpers');
const relay = require('../lib/relay');
const { openUpstream, upstreamOptions, UPSTREAM_TIMEOUT_MS } = require('../lib/relay/ws-upstream');
const { createWsRelay, CLOSE_EXPIRED } = require('../lib/portal/ws-relay');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in daemon. `upgrade(req, socket, head)` answers a handshake itself
// (a refusal); otherwise the socket is accepted and `onConnection(ws, req)`
// runs. Every upgrade request it saw is in `.requests`.
async function stub(t, { onConnection = () => {}, upgrade = null } = {}) {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
  const requests = [];
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    requests.push(req);
    socket.on('error', () => {});
    if (upgrade) { upgrade(req, socket, head); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('error', () => {});
      onConnection(ws, req);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const s of sockets) { try { s.terminate(); } catch {} }
    wss.close();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { port: server.address().port, requests, sockets };
}

// An upstream whose every event is recorded in `.events` (in order).
function watch(t, opts) {
  const h = openUpstream(opts);
  const events = [];
  h.on('open', () => events.push(['open']));
  h.on('refused', (status, body) => events.push(['refused', status, body]));
  h.on('error', (err) => events.push(['error', err]));
  h.on('close', (code, reason) => events.push(['close', code, String(reason)]));
  t.after(() => { try { h.terminate(); } catch {} });
  h.events = events;
  h.opened = () => waitUntil(() => events.some((e) => e[0] === 'open'), { what: 'the upstream open' });
  h.closed = () => waitUntil(() => events.find((e) => e[0] === 'close'), { timeout: 4000, what: 'the upstream close' });
  return h;
}

test('relay ws: lib/relay exports openUpstream and UPSTREAM_TIMEOUT_MS from ws-upstream.js', () => {
  assert.equal(relay.openUpstream, openUpstream);
  assert.equal(relay.UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS);
  assert.equal(UPSTREAM_TIMEOUT_MS, 5000);
});

test('relay ws: messages sent before deliver() are kept and handed over first, in order, binary kept binary', async (t) => {
  let sentEarly = 0;
  let conn = null;
  const s = await stub(t, {
    onConnection(ws) {
      conn = ws;
      const done = () => { sentEarly += 1; };
      ws.send('one', done);
      ws.send('two', done);
      ws.send('three', done);
      ws.send(Buffer.from([0, 1, 2, 255]), { binary: true }, done);
      ws.on('message', (m) => { if (String(m) === 'go') ws.send('later'); });
    },
  });
  const h = watch(t, { port: s.port });
  const got = [];
  h.on('message', (data, isBinary) => got.push([isBinary ? [...data] : String(data), isBinary]));
  await h.opened();
  await waitUntil(() => sentEarly === 4 && conn && conn.bufferedAmount === 0, { what: 'the early sends' });
  await sleep(100);
  assert.deepEqual(got, [], 'nothing is handed over before deliver()');
  h.deliver();
  assert.deepEqual(got, [['one', false], ['two', false], ['three', false], [[0, 1, 2, 255], true]],
    'deliver() hands the kept messages over at once, in arrival order');
  assert.equal(h.send('go'), true);
  await waitUntil(() => got.length === 5, { what: 'the later message' });
  assert.deepEqual(got[4], ['later', false], 'a later message follows the early ones');
});

test('relay ws: pause() stops reading the daemon (its sends back up), resume() drains them in order', async (t) => {
  const N = 32;
  const SIZE = 1024 * 1024;
  let conn = null;
  const s = await stub(t, {
    onConnection(ws) {
      conn = ws;
      ws.on('message', (m) => {
        if (String(m) !== 'go') return;
        for (let i = 0; i < N; i++) {
          const b = Buffer.alloc(SIZE, i);
          ws.send(b, { binary: true });
        }
      });
    },
  });
  const h = watch(t, { port: s.port });
  const got = [];
  h.on('message', (data, isBinary) => got.push([data[0], data.length, isBinary]));
  await h.opened();
  h.deliver();
  h.pause();
  assert.equal(h.isPaused, true);
  h.send('go');
  await waitUntil(() => conn && conn.bufferedAmount > 0, { what: 'the stub\'s sends to back up' });
  await sleep(500);
  assert.equal(got.length, 0, 'no message while paused');
  assert.ok(conn.bufferedAmount > 0, `the stub's sends are still buffered after 500 ms (${conn.bufferedAmount} bytes)`);
  h.resume();
  assert.equal(h.isPaused, false);
  await waitUntil(() => got.length === N, { timeout: 10000, what: 'every message after resume()' });
  assert.deepEqual(got.map((g) => g[0]), [...Array(N).keys()], 'in the order sent');
  assert.ok(got.every((g) => g[1] === SIZE && g[2] === true));
  await waitUntil(() => conn.bufferedAmount === 0, { what: 'the stub to drain' });
});

test('relay ws: a message already parsed when pause() is called is held until resume()', async (t) => {
  const s = await stub(t, {
    onConnection(ws) {
      ws.on('message', () => { ws.send('a'); ws.send('b'); ws.send('c'); });
    },
  });
  const h = watch(t, { port: s.port });
  const got = [];
  // Pause from inside the first delivery: 'b' and 'c' may already be parsed.
  h.on('message', (data) => { got.push(String(data)); if (got.length === 1) h.pause(); });
  await h.opened();
  h.deliver();
  h.send('go');
  await waitUntil(() => got.length === 1, { what: 'the first message' });
  await sleep(150);
  assert.deepEqual(got, ['a'], 'nothing after pause()');
  h.resume();
  await waitUntil(() => got.length === 3, { what: 'the rest' });
  assert.deepEqual(got, ['a', 'b', 'c']);
});

test('relay ws: the daemon\'s close code and reason reach the caller (4403, 1000, 1006 for a destroyed socket)', async (t) => {
  for (const [how, expect] of [
    [(ws) => ws.close(4403, 'x'), [4403, 'x']],
    [(ws) => ws.close(1000), [1000, '']],
    [(ws) => ws._socket.destroy(), [1006, '']],
  ]) {
    const s = await stub(t, { onConnection: (ws) => setTimeout(() => how(ws), 20) });
    const h = watch(t, { port: s.port });
    const ev = await h.closed();
    assert.deepEqual(ev.slice(1), expect);
    assert.equal(h.events.filter((e) => e[0] === 'close').length, 1, 'one close');
  }
});

test('relay ws: a message over maxPayload closes with 1009 (a small cap, no large allocation)', async (t) => {
  const s = await stub(t, { onConnection: (ws) => ws.send(Buffer.alloc(64 * 1024 + 1), { binary: true }) });
  const h = watch(t, { port: s.port, maxPayload: 65536 });
  const got = [];
  h.on('message', (d) => got.push(d));
  h.deliver();
  const ev = await h.closed();
  assert.equal(ev[1], 1009, 'the code ws closed with, not the 1006 it reports');
  assert.equal(got.length, 0);
});

test('relay ws: maxPayload reaches the ws client only when given (ws\'s 100 MiB default otherwise)', () => {
  const plain = upstreamOptions({ port: 4000 });
  assert.equal(plain.url, 'ws://127.0.0.1:4000/ws');
  assert.equal(Object.prototype.hasOwnProperty.call(plain.options, 'maxPayload'), false, 'no maxPayload key: ws\'s default stands');
  assert.equal(plain.options.perMessageDeflate, false);
  assert.equal(plain.options.handshakeTimeout, UPSTREAM_TIMEOUT_MS);
  assert.equal(Object.prototype.hasOwnProperty.call(plain.options, 'origin'), false);
  assert.deepEqual(plain.options.headers, { 'x-wc-remote': '1' });
  assert.equal(upstreamOptions({ port: 4000, maxPayload: 65536 }).options.maxPayload, 65536);
});

test('relay ws: the upgrade carries the stamp, then X-WC-Remote, then the User-Agent — never Origin, Cookie or Authorization', async (t) => {
  const s = await stub(t);
  const stamp = { 'x-wc-test-one': 'a', 'x-wc-test-two': 'b c' };
  const h = watch(t, { port: s.port, stamp, userAgent: 'Viewer/1.0' });
  await h.opened();
  const req = s.requests[0];
  const xwc = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-wc-')));
  assert.deepEqual(xwc, { 'x-wc-test-one': 'a', 'x-wc-test-two': 'b c', 'x-wc-remote': '1' });
  assert.equal(req.headers['user-agent'], 'Viewer/1.0');
  for (const k of ['origin', 'cookie', 'authorization']) assert.equal(req.headers[k], undefined, `no ${k}`);
  const names = req.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
  const at = (n) => names.indexOf(n);
  assert.ok(at('x-wc-test-one') < at('x-wc-test-two') && at('x-wc-test-two') < at('x-wc-remote') && at('x-wc-remote') < at('user-agent'),
    `the order is stamp, x-wc-remote, user-agent (${names.join(', ')})`);
});

test('relay ws: a stamp that names x-wc-remote, or anything but a lowercase x-wc-* header, throws before dialling', async (t) => {
  const s = await stub(t);
  for (const stamp of [
    { 'x-wc-remote': '0' },
    { 'X-WC-Test': '1' },
    { cookie: 'a=b' },
    { authorization: 'Bearer x' },
    { origin: 'https://evil.example' },
    { 'x-wc-test': 1 },
    ['x-wc-test'],
  ]) {
    assert.throws(() => openUpstream({ port: s.port, stamp }), TypeError, JSON.stringify(stamp));
  }
  assert.throws(() => openUpstream({ port: 0 }), TypeError, 'no port');
  await sleep(100);
  assert.equal(s.requests.length, 0, 'nothing was dialled');
});

test('relay ws: an HTTP answer to the upgrade is \'refused\' with its status, and its body only when asked', async (t) => {
  const body = '{"ok":false,"error":"forbidden","code":"no"}';
  const s = await stub(t, {
    upgrade(_req, socket) {
      socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    },
  });
  const a = watch(t, { port: s.port, collectRefusal: true });
  await waitUntil(() => a.events.length > 0, { what: 'the refusal' });
  const b = watch(t, { port: s.port });
  await waitUntil(() => b.events.length > 0, { what: 'the refusal' });
  const c = watch(t, { port: s.port, collectRefusal: true, maxRefusalBytes: 10 });
  await waitUntil(() => c.events.length > 0, { what: 'the refusal' });
  await sleep(100);
  assert.equal(a.events.length, 1, `one event, no error or close after it (${a.events.map((e) => e[0])})`);
  assert.equal(a.events[0][0], 'refused');
  assert.equal(a.events[0][1], 403);
  assert.ok(Buffer.isBuffer(a.events[0][2]));
  assert.equal(a.events[0][2].toString(), body);
  assert.deepEqual(b.events, [['refused', 403, null]]);
  assert.equal(c.events[0][2].toString(), body.slice(0, 10), 'at most maxRefusalBytes');
  assert.equal(c.events.length, 1);
});

test('relay ws: a port nothing answers is one \'error\', no close', async (t) => {
  const port = await freePort();
  const h = watch(t, { port });
  await waitUntil(() => h.events.length > 0, { what: 'the error' });
  await sleep(100);
  assert.deepEqual(h.events.map((e) => e[0]), ['error']);
});

test('relay ws: the caller\'s terminate() before open ends it silently', async (t) => {
  const s = await stub(t);
  const h = watch(t, { port: s.port });
  h.terminate();
  await sleep(150);
  assert.deepEqual(h.events, []);
});

// ── the portal's leg ─────────────────────────────────────────────────────────

// A portal stand-in: an HTTP server whose every upgrade is handed to one
// createWsRelay toward `port`.
async function portal(t, { port, expSec = (Date.now() / 1000) + 3600, graceMs } = {}) {
  const r = createWsRelay(graceMs === undefined ? {} : { graceMs });
  const statuses = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    r.relay(req, socket, head, { port, id: 'sess', expSec, onStatus: (c) => statuses.push(c) });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { r.closeAll(); server.closeAllConnections(); server.close(() => resolve()); }));
  return { port: server.address().port, relay: r, statuses };
}

function viewer(t, p) {
  const ws = new WebSocket(`ws://127.0.0.1:${p.port}/ws`, {
    origin: 'https://viewer.example', headers: { 'user-agent': 'Viewer/2.0', cookie: 'a=b' },
  });
  ws.on('error', () => {});
  t.after(() => { try { ws.terminate(); } catch {} });
  return ws;
}

// What a viewer reads back from one refused upgrade through the portal: the
// status line, the raw header lines in order, and the body bytes.
function refusal(p) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p.port}/ws`);
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('the upgrade was not refused')); });
    ws.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`,
          headers: res.rawHeaders,
          body: Buffer.concat(chunks).toString('latin1'),
        });
        ws.terminate();
      });
    });
  });
}

test('portal ws leg: the daemon\'s early messages first, both ways, the same two headers upstream', async (t) => {
  let fromViewer = null;
  const s = await stub(t, {
    onConnection(ws) {
      ws.send('hello-1');
      ws.send(Buffer.from([9, 8]), { binary: true });
      ws.on('message', (m, isBinary) => { fromViewer = [String(m), isBinary]; ws.send('after'); });
    },
  });
  const p = await portal(t, { port: s.port });
  const v = viewer(t, p);
  const got = [];
  v.on('message', (d, isBinary) => got.push(isBinary ? [...d] : String(d)));
  await waitUntil(() => got.length === 2, { what: 'the early messages' });
  v.send('hi');
  await waitUntil(() => got.length === 3, { what: 'the reply' });
  assert.deepEqual(got, ['hello-1', [9, 8], 'after']);
  assert.deepEqual(fromViewer, ['hi', false]);
  assert.deepEqual(p.statuses, [101]);
  const req = s.requests[0];
  assert.equal(req.headers['x-wc-remote'], '1');
  assert.equal(req.headers['user-agent'], 'Viewer/2.0');
  for (const k of ['origin', 'cookie', 'authorization']) assert.equal(req.headers[k], undefined, `no ${k} upstream`);
  assert.deepEqual(Object.keys(req.headers).filter((k) => k.startsWith('x-wc-')), ['x-wc-remote']);
});

test('portal ws leg: the daemon\'s 4403 closes the viewer WITHOUT a code (1005); the viewer\'s close reaches the daemon without one', async (t) => {
  let conn = null;
  const s = await stub(t, { onConnection: (ws) => { conn = ws; ws.send('hi'); } });
  const p = await portal(t, { port: s.port });
  const v = viewer(t, p);
  await new Promise((resolve) => v.once('message', resolve));
  const closed = new Promise((resolve) => v.on('close', (code, reason) => resolve([code, String(reason)])));
  conn.close(4403, 'x');
  assert.deepEqual(await closed, [1005, '']);
  await waitUntil(() => p.relay.size === 0, { what: 'the pair to go' });

  let conn2 = null;
  const s2 = await stub(t, { onConnection: (ws) => { conn2 = ws; ws.send('hi'); } });
  const p2 = await portal(t, { port: s2.port });
  const v2 = viewer(t, p2);
  await new Promise((resolve) => v2.once('message', resolve));
  const daemonSaw = new Promise((resolve) => conn2.on('close', (code) => resolve(code)));
  v2.close(4000, 'bye');
  assert.equal(await daemonSaw, 1005);
});

test('portal ws leg: the 502 refusal bytes are today\'s (an HTTP answer, and a port nothing answers)', async (t) => {
  const s = await stub(t, {
    upgrade(_req, socket) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno'); },
  });
  const p = await portal(t, { port: s.port });
  assert.deepEqual(await refusal(p), {
    status: 'HTTP/1.1 502 Bad Gateway',
    headers: ['Connection', 'close', 'Content-Type', 'application/json', 'Content-Length', '67', 'Referrer-Policy', 'no-referrer'],
    body: '{"ok":false,"remote":true,"error":"the session refused the socket"}',
  });
  assert.deepEqual(p.statuses, [502]);

  const dead = await portal(t, { port: await freePort() });
  assert.deepEqual(await refusal(dead), {
    status: 'HTTP/1.1 502 Bad Gateway',
    headers: ['Connection', 'close', 'Content-Type', 'application/json', 'Content-Length', '75', 'Referrer-Policy', 'no-referrer'],
    body: '{"ok":false,"remote":true,"error":"this session\'s daemon is not answering"}',
  });
  assert.deepEqual(dead.statuses, [502]);
});

test('portal ws leg: the token\'s expiry closes the viewer with 4401', async (t) => {
  const s = await stub(t, { onConnection: (ws) => ws.send('hi') });
  const p = await portal(t, { port: s.port, expSec: (Date.now() + 300) / 1000, graceMs: 0 });
  const v = viewer(t, p);
  const code = await new Promise((resolve) => v.on('close', (c) => resolve(c)));
  assert.equal(code, CLOSE_EXPIRED);
  assert.equal(CLOSE_EXPIRED, 4401);
});

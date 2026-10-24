// Only the host's own kinds=wake stream is a wake consumer (K.2-128, after
// U332c's review). GET /api/events/stream?kinds=wake used to count ANY such
// stream as the channel bridge: state.wakeConsumers went up, the liveness
// stamp (wakeConsumerSeenAt) was set, and on connect it drained the parked
// push — so a network peer at `basic` (a WEB_CHAT_HOST bind), a remote viewer
// or a page's fetch could steer WHEN a parked delivery drains. The channel
// bridge (lib/channel, the MCP process on this machine, through lib/client) is
// the one intended consumer, and it is the host's own request: audience
// isHost(req). Every other caller still receives the wake events it asked for,
// as the text rules leave them, and counts for nothing.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { withServer, openSSE, waitUntil } = require('../test-support/helpers');

const HTML = '<html><head><title>Doc</title></head><body><p>hi</p></body></html>';
const REMOTE = Object.freeze({ 'X-WC-Remote': '1' });
const PEER = Object.freeze({ 'x-test-peer': '10.0.0.9' });
// Node's own fetch sends fetch metadata: a local page's request, never the host's.
const BROWSER = Object.freeze({ 'Sec-Fetch-Mode': 'cors' });

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

// Requests carrying x-test-peer arrive from that address (spec §10.1), as the
// audience and the text-route tests stub a network peer.
function stubPeers(server) {
  const onRequest = (req, res) => {
    const addr = req.headers['x-test-peer'];
    if (!addr) return;
    Object.defineProperty(req.socket, 'remoteAddress', { value: addr, configurable: true });
    res.once('close', () => { delete req.socket.remoteAddress; });
  };
  server.prependListener('request', onRequest);
  return () => server.off('request', onRequest);
}

// A raw kinds=wake stream with the caller's headers. Resolves once the route's
// handler has run (it writes `retry:` and runs to completion with no awaits, so
// any drain it made is already on the bus); `events` collects what arrives.
function rawWakeStream(port, headers) {
  return new Promise((resolve, reject) => {
    let text = '';
    let opened = false;
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events/stream?kinds=wake', headers }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`stream: ${res.statusCode}`)); req.destroy(); return; }
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (!opened && text.includes('retry:')) {
          opened = true;
          resolve({
            get text() { return text; },
            get wakes() { return (text.match(/^event: wake$/gm) || []).length; },
            close: () => req.destroy(),
          });
        }
      });
    });
    req.on('error', (e) => { if (!opened) reject(e); });
  });
}

// A daemon with a parked push: a capture queued and pushed with no channel
// connected, the queue's own way (test/queue.test.js).
async function parked(t) {
  const d = await withServer(t);
  t.after(stubPeers(d.server));
  await d.api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  const push = await d.api.post('/api/queue/push', {});
  assert.equal(push.json.mode, 'parked', 'no channel → parked');
  assert.ok(d.srv.state.pendingWake, 'a park is pending');
  return d;
}

const wakesOnBus = (d) => d.srv.bus.read({ kinds: ['wake'] }).events.length;
const snapshot = (d) => ({
  consumers: d.srv.state.wakeConsumers,
  seenAt: d.srv.state.wakeConsumerSeenAt,
  park: d.srv.state.pendingWake && d.srv.state.pendingWake.id,
  wakes: wakesOnBus(d),
});

for (const [name, headers] of [
  ['(a) a remote viewer at basic (X-WC-Remote)', REMOTE],
  ['(b) a network peer (basic at every opt-in)', PEER],
  ['(b) a network peer with fetch metadata', { ...PEER, ...BROWSER }],
  ['(b) a local page\'s fetch (local, but not the host\'s)', BROWSER],
]) {
  test(`${name}: a kinds=wake stream leaves the park parked and the consumer count unchanged`, async (t) => {
    const d = await parked(t);
    const before = snapshot(d);
    assert.equal(before.consumers, 0, 'no consumer yet');
    const s = await rawWakeStream(d.port, headers);
    t.after(() => s.close());
    await settle();
    assert.deepStrictEqual(snapshot(d), before, 'the count, the liveness stamp, the park and the ring are as they were');
    assert.equal(s.wakes, 0, 'no drained wake reached the stream');
    // It cannot time the delivery either: a Push while it is the only stream still parks.
    await d.api.post('/api/capture', { url: 'https://example.com/two', title: 'Two', html: HTML });
    const again = await d.api.post('/api/queue/push', {});
    assert.equal(again.json.mode, 'parked', 'a Push with only this stream connected parks');
    assert.equal(wakesOnBus(d), 0, 'no wake emitted');
    s.close();
    await settle();
    assert.equal(d.srv.state.wakeConsumers, 0, 'closing it decrements nothing');
  });
}

test('(c) the host\'s own kinds=wake stream counts, drains the park, and decrements on close', async (t) => {
  const d = await parked(t);
  const t0 = Date.now();
  const wakes = [];
  // lib/client's stream, as the channel bridge opens it: no Origin, no fetch metadata.
  const host = await openSSE(d.port, { kinds: ['wake'], onEvent: (e) => { if (e.kind === 'wake') wakes.push(e); } });
  t.after(() => host.close());
  assert.equal(d.srv.state.wakeConsumers, 1, 'the host\'s stream counts');
  assert.ok(d.srv.state.wakeConsumerSeenAt >= t0, 'and stamps liveness at connect');
  await waitUntil(() => wakes.length >= 1, { what: 'the parked wake to drain to the host' });
  assert.equal(d.srv.state.pendingWake, null, 'the park drained');
  assert.equal(wakes[0].batch[0].capture_id, 'cap1');
  await settle(60);
  assert.equal(wakes.length, 1, 'into exactly one wake');
  host.close();
  await waitUntil(() => d.srv.state.wakeConsumers === 0, { what: 'the host\'s close to decrement' });
});

test('(e) a remote kinds=wake stream beside the host\'s still receives the wake, and its close leaves the host\'s count', async (t) => {
  const d = await parked(t);
  const remote = await rawWakeStream(d.port, REMOTE);
  t.after(() => remote.close());
  await settle();
  assert.ok(d.srv.state.pendingWake, 'still parked');
  const wakes = [];
  const host = await openSSE(d.port, { kinds: ['wake'], onEvent: (e) => { if (e.kind === 'wake') wakes.push(e); } });
  t.after(() => host.close());
  assert.equal(d.srv.state.wakeConsumers, 1, 'only the host\'s stream counts');
  await waitUntil(() => wakes.length >= 1, { what: 'the parked wake to drain to the host' });
  // The remote stream asked for wake events and gets them (as the text rules leave them).
  await waitUntil(() => remote.wakes >= 1, { what: 'the remote stream to receive the wake' });
  remote.close();
  await settle();
  assert.equal(d.srv.state.wakeConsumers, 1, 'closing the remote stream leaves the host\'s count');
  host.close();
  await waitUntil(() => d.srv.state.wakeConsumers === 0, { what: 'the host\'s close to decrement' });
});

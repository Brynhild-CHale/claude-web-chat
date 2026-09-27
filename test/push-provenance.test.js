// Push provenance: every push — Push → Claude, a Retry, an immediate signal, a
// parked delivery and its drain — says where it came from. `origin` is 'remote'
// when it arrived through the tunnel portal, 'local' otherwise; `device` is
// 'mobile' when the chrome was in its phone view (or, failing a claim, the UA
// says Mobile), 'desktop' otherwise. Both ride the wake event, the park and the
// channel envelope (meta push_origin/device + a "Pushed from:" content line),
// so Claude can adapt — answer on the surface when the user is away from the
// terminal, keep panes compact on a phone.

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { withServer, withPortal, waitUntil, openSSE } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { sessionHost } = require('../lib/tunnel/config');
const { createBus } = require('../lib/core/bus');
const queue = require('../lib/server/domain/queue');
const { wakeEnvelope, META_KEYS } = require('../lib/channel/envelope');
const turnBegin = require('../lib/hooks/turn-begin');

const HTML = '<html><head><title>Doc</title></head><body><p>hi</p></body></html>';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function freshState({ live = true } = {}) {
  return {
    queue: [], queueSeq: 0, mounts: new Map(), store: {}, signals: {},
    wakeConsumers: live ? 1 : 0, wakeConsumerSeenAt: live ? Date.now() : 0,
    pendingAck: null, pendingWake: null, pendingWakeSeq: 0,
  };
}
const item = (summary) => ({ kind: 'capture', source: 'ext:tab-stream', summary, capture_id: 'cap1' });
const wakesIn = (json) => (json.events || []).filter((e) => e.kind === 'wake');

async function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') { out += chunk; return true; }
    return orig(chunk, ...rest);
  };
  try { await fn(); } finally { process.stdout.write = orig; }
  return out;
}

// ── the one reading ─────────────────────────────────────────────────────────

test('provenance: remote from the portal label, device from the claim, else the UA', () => {
  assert.deepEqual(queue.provenance({}), { origin: 'local', device: 'desktop' });
  assert.deepEqual(queue.provenance({ remote: true }), { origin: 'remote', device: 'desktop' });
  assert.deepEqual(queue.provenance({ device: 'mobile' }), { origin: 'local', device: 'mobile' });
  assert.deepEqual(queue.provenance({ userAgent: PHONE_UA }), { origin: 'local', device: 'mobile' }, 'UA fallback');
  assert.deepEqual(queue.provenance({ userAgent: DESKTOP_UA }).device, 'desktop');
  // The chrome's claim wins over the UA both ways (a desktop-shaped window on a
  // phone UA is the desktop view; the phone view on a tablet UA is mobile).
  assert.equal(queue.provenance({ device: 'desktop', userAgent: PHONE_UA }).device, 'desktop');
  assert.equal(queue.provenance({ device: 'mobile', userAgent: DESKTOP_UA }).device, 'mobile');
  // An unknown claim is no claim.
  assert.equal(queue.provenance({ device: 'toaster', userAgent: PHONE_UA }).device, 'mobile');
  assert.equal(queue.provenance({ device: 'toaster' }).device, 'desktop');
});

// ── the envelope ────────────────────────────────────────────────────────────

test('envelope: provenance lands as meta push_origin/device and one content line', () => {
  const env = wakeEnvelope([{ id: 'q1', ...item('a') }], { source: 'queue', seq: 3, origin: 'remote', device: 'mobile' });
  assert.equal(env.meta.push_origin, 'remote');
  assert.equal(env.meta.device, 'mobile');
  assert.equal(env.meta.origin, 'queue', 'meta origin keeps meaning the event source');
  assert.match(env.content, /^Pushed from: origin=remote device=mobile$/m);
  for (const k of Object.keys(env.meta)) assert.ok(META_KEYS.includes(k), k);

  const bare = wakeEnvelope([{ id: 'q1', ...item('a') }], { source: 'queue', seq: 3 });
  assert.equal('push_origin' in bare.meta, false, 'no provenance, no key');
  assert.equal('device' in bare.meta, false);
  assert.doesNotMatch(bare.content, /Pushed from/);

  const junk = wakeEnvelope([], { origin: 'mars', device: '"><x' });
  assert.equal('push_origin' in junk.meta, false, 'only the vocabulary survives');
  assert.equal('device' in junk.meta, false);
  assert.doesNotMatch(junk.content, /Pushed from/);
});

// ── the domain: every producer carries it ───────────────────────────────────

test('domain: a live flush stamps the wake, the retain and the flushed remove', () => {
  const state = freshState();
  const bus = createBus();
  queue.enqueue(state, bus, item('a'));
  const { wake } = queue.flush(state, bus, { origin: 'remote', device: 'mobile' });
  assert.equal(wake.origin, 'remote');
  assert.equal(wake.device, 'mobile');
  assert.equal(state.pendingAck.origin, 'remote');
  assert.equal(state.pendingAck.device, 'mobile');
  const removed = bus.read({}).events.find((e) => e.kind === 'queue' && e.reason === 'flushed');
  assert.equal(removed.origin, 'remote');
  assert.equal(removed.device, 'mobile');

  // A flush with no provenance (a driver, an older caller) keeps the old shape.
  queue.enqueue(state, bus, item('b'));
  const plain = queue.flush(state, bus, {}).wake;
  assert.equal('origin' in plain, false);
  assert.equal('device' in plain, false);
});

test('domain: a park carries it; a merge re-stamps from the latest push that has one', () => {
  const state = freshState({ live: false });
  const bus = createBus();
  queue.enqueue(state, bus, item('first'));
  queue.flush(state, bus, { origin: 'local', device: 'desktop' });
  assert.equal(state.pendingWake.origin, 'local');
  assert.equal(state.pendingWake.envelope.meta.push_origin, 'local');

  queue.enqueue(state, bus, item('second'));
  queue.flush(state, bus, { origin: 'remote', device: 'mobile' });
  assert.equal(state.pendingWake.origin, 'remote', 'the latest push re-stamps');
  assert.equal(state.pendingWake.device, 'mobile');
  assert.match(state.pendingWake.envelope.content, /Pushed from: origin=remote device=mobile/);

  queue.enqueue(state, bus, item('third'));
  queue.flush(state, bus, {});
  assert.equal(state.pendingWake.origin, 'remote', 'a push without provenance keeps the parked one');
  assert.equal(state.pendingWake.envelope.meta.device, 'mobile');

  // Path B: the drain re-emits the park as a live wake with its provenance.
  state.wakeConsumers = 1; state.wakeConsumerSeenAt = Date.now();
  const wake = queue.drainPending(state, bus);
  assert.equal(wake.origin, 'remote');
  assert.equal(wake.device, 'mobile');
  assert.equal(state.pendingAck.origin, 'remote', 'the drained wake is retained with it');
});

test('domain: an un-acked wake folds into the park with its provenance; a Retry re-stamps', () => {
  const state = freshState();
  const bus = createBus();
  queue.enqueue(state, bus, item('a'));
  const { wake } = queue.flush(state, bus, { origin: 'remote', device: 'mobile' });

  // Retry from the desktop: the retry's provenance wins.
  const retried = queue.repush(state, bus, wake.seq, { origin: 'local', device: 'desktop' });
  assert.equal(retried.wake.origin, 'local');
  assert.equal(retried.wake.device, 'desktop');

  // Retry with nothing: the original push's provenance carries.
  const again = queue.repush(state, bus, retried.wake.seq, {});
  assert.equal(again.wake.origin, 'local');

  // The backstop fold keeps it.
  queue.foldPendingAck(state);
  assert.equal(state.pendingWake.origin, 'local');
  assert.equal(state.pendingWake.device, 'desktop');
});

// ── local, over HTTP ────────────────────────────────────────────────────────

test('local push: the chrome\'s device claim, else the UA; parked delivery carries both', async (t) => {
  const { api, root } = await withServer(t, { writePortfile: true });
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  const push = await api.post('/api/queue/push', { device: 'mobile' });
  assert.equal(push.json.mode, 'parked');
  assert.equal(push.json.origin, 'local');
  assert.equal(push.json.device, 'mobile');

  const pending = (await api.get('/api/queue/pending')).json.pending;
  assert.equal(pending.origin, 'local');
  assert.equal(pending.device, 'mobile');
  assert.equal(pending.envelope.meta.push_origin, 'local');
  assert.equal(pending.envelope.meta.device, 'mobile');

  const ev = await api.get('/api/events');
  const flushed = ev.json.events.find((e) => e.kind === 'queue' && e.reason === 'flushed');
  assert.equal(flushed.origin, 'local', 'the event log records a parked push too');
  assert.equal(flushed.device, 'mobile');

  // The parked delivery reaches Claude as the envelope content, line and all.
  const out = await captureStdout(() => turnBegin({ prompt: 'hi' }, { root, probeMs: 5000 }));
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Pushed from: origin=local device=mobile/);
});

test('local push: no claim falls back to the User-Agent; a live wake carries it', async (t) => {
  const { api, port } = await withServer(t);
  const ch = await openSSE(port, { kinds: ['wake'], awaitChannel: api });
  t.after(() => ch.close());
  await api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  const res = await fetch(`http://127.0.0.1:${port}/api/queue/push`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': PHONE_UA }, body: '{}',
  });
  const body = await res.json();
  assert.equal(body.mode, 'wake');
  assert.equal(body.device, 'mobile');
  const w = wakesIn((await api.get('/api/events')).json);
  assert.equal(w.length, 1);
  assert.equal(w[0].origin, 'local');
  assert.equal(w[0].device, 'mobile');
});

// An immediate signal wakes straight from the socket's store:set, so the socket
// itself has to know where it is: the chrome's `client` frame names the device.
function wsImmediate(url, { headers, client } = {}) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { headers });
    sock.on('unexpected-response', (_q, res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    sock.on('error', reject);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type !== 'hello') return;
      if (client) sock.send(JSON.stringify({ type: 'client', device: client }));
      sock.send(JSON.stringify({ type: 'store:set', patch: { ask_now: { seq: 1 } } }));
      setTimeout(() => { sock.close(); resolve(); }, 80);
    });
  });
}

test('immediate signal: the socket\'s client frame names the device; local origin', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'panel', html: '<div>x</div>', params: { signals: [{ key: 'ask_now', wake: 'immediate' }] } });
  await wsImmediate(`ws://localhost:${port}/ws`, { client: 'mobile' });
  const w = wakesIn((await api.get('/api/events')).json);
  assert.equal(w.length, 1);
  assert.equal(w[0].reason, 'immediate');
  assert.equal(w[0].origin, 'local');
  assert.equal(w[0].device, 'mobile');
});

// ── remote, through the portal ──────────────────────────────────────────────

async function portalRig(t) {
  const srv = await withServer(t, { writePortfile: true });
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const access = createFakeAccess();
  const p = await withPortal(t, { config: access.config(), fetchJwks: access.fetchJwks });
  const host = sessionHost(p.config, instanceId(srv.root));
  const origin = `https://${host}`;
  const auth = { 'cf-access-jwt-assertion': access.mint() };
  const post = (path, body, headers = {}) => p.request(path, {
    host, method: 'POST', body, headers: { ...auth, origin, 'content-type': 'application/json', ...headers },
  });
  return { srv, p, access, host, origin, auth, post };
}

test('remote push: origin=remote through the portal, parked delivery and all', async (t) => {
  const r = await portalRig(t);
  await r.srv.api.post('/api/capture', { url: 'https://example.com/doc', title: 'Doc', html: HTML });
  const push = await r.post('/api/queue/push', { device: 'mobile' });
  assert.equal(push.status, 200, push.text);
  assert.equal(push.json.origin, 'remote');
  assert.equal(push.json.device, 'mobile');

  const pending = (await r.srv.api.get('/api/queue/pending')).json.pending;
  assert.equal(pending.origin, 'remote');
  assert.equal(pending.envelope.meta.push_origin, 'remote');
  assert.match(pending.envelope.content, /Pushed from: origin=remote device=mobile/);

  const out = await captureStdout(() => turnBegin({ prompt: 'hi' }, { root: r.srv.root, probeMs: 5000 }));
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /origin=remote/);
});

test('remote push: the viewer\'s UA crosses the proxy for the device fallback', async (t) => {
  const r = await portalRig(t);
  const push = await r.post('/api/queue/push', { note: 'from the train' }, { 'user-agent': PHONE_UA });
  assert.equal(push.json.origin, 'remote');
  assert.equal(push.json.device, 'mobile');
});

test('remote immediate signal: the relayed socket is remote, and its UA is the fallback', async (t) => {
  const r = await portalRig(t);
  await r.srv.api.post('/api/render', { id: 'panel', html: '<div>x</div>', params: { signals: [{ key: 'ask_now', wake: 'immediate' }] } });
  await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${r.p.port}/ws`, {
      headers: { host: r.host, ...r.auth, 'user-agent': PHONE_UA }, origin: r.origin,
    });
    t.after(() => { try { sock.terminate(); } catch {} });
    sock.on('unexpected-response', (_q, res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    sock.on('error', reject);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type !== 'hello') return;
      sock.send(JSON.stringify({ type: 'store:set', patch: { ask_now: { seq: 1 } } }));
      resolve();
    });
  });
  assert.ok(await waitUntil(async () => wakesIn((await r.srv.api.get('/api/events')).json).length === 1));
  const [w] = wakesIn((await r.srv.api.get('/api/events')).json);
  assert.equal(w.origin, 'remote');
  assert.equal(w.device, 'mobile');
});

// The bridge half (the live wake's <channel> carries push_origin/device) is in
// test/channel-bridge.test.js, beside its SSE harness.

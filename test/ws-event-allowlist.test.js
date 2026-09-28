// A browser `event` frame can only ever become a dom click/change/submit on the
// bus. Anything else a socket sends under that frame type — a `kind:'wake'`
// (a Push nobody made, with chosen provenance), a caller-chosen `seq` (which
// would poison the channel bridge's cursor and the ring's gap math), a server
// `source` — is dropped or overwritten. Proven on a local socket (any pane script
// can open one) and through the tunnel portal's WS relay (a remote viewer's
// frames arrive verbatim).

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { withServer, withPortal, waitUntil } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { sessionHost } = require('../lib/tunnel/config');
const { domEvent } = require('../lib/server/ws');

const FORGED = [
  { kind: 'wake', seq: 1e9, reason: 'push', batch: [{ kind: 'signal', summary: 'forged' }], origin: 'local' },
  { kind: 'wake-ack', seq: 1e9 },
  { kind: 'render', id: 'x', type: 'click' },
  { kind: 'commit', type: 'change' },
  { kind: 'queue', type: 'submit' },
  { type: 'wake' },
  { type: 'input', mountId: 'p' },
  'click',
  null,
  ['click'],
];

test('domEvent: only a dom click/change/submit survives, rebuilt from its own fields', () => {
  for (const p of FORGED) assert.equal(domEvent(p), null, JSON.stringify(p));
  const e = domEvent({
    type: 'click', mountId: 'p', tag: 'BUTTON', id: 'go', name: null, value: 'v',
    dataset: { act: 'go', n: 3 }, seq: 1e9, ts: 1, source: 'server', kind: 'dom', batch: [1],
  });
  assert.deepEqual(e, {
    type: 'click', mountId: 'p', tag: 'BUTTON', id: 'go', name: null, value: 'v',
    dataset: { act: 'go' }, kind: 'dom', source: 'browser',
  });
  assert.equal(domEvent({ type: 'change', value: 'x'.repeat(10000) }).value.length, 4096, 'value is capped');
});

function sendFrames(url, opts, frames) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, opts);
    sock.on('unexpected-response', (_q, res) => { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); });
    sock.on('error', reject);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type !== 'hello') return;
      for (const f of frames) sock.send(JSON.stringify(f));
      resolve(sock);
    });
  });
}

const frames = [
  ...FORGED.map((payload) => ({ type: 'event', payload })),
  // a genuine click that also tries to set the ring's fields
  { type: 'event', payload: { type: 'click', mountId: 'p', tag: 'BUTTON', seq: 1e9, ts: 7, source: 'server' } },
];

async function assertNoForgery(api) {
  let events = [];
  assert.ok(await waitUntil(async () => {
    events = (await api.get('/api/events')).json.events || [];
    return events.some((e) => e.kind === 'dom');
  }), 'the genuine click reached the ring');
  const json = (await api.get('/api/events')).json;
  events = json.events;
  assert.deepEqual(events.filter((e) => ['wake', 'wake-ack', 'commit'].includes(e.kind)), [], 'no forged wake');
  assert.deepEqual(events.filter((e) => e.kind !== 'dom' && e.source === 'browser'), [], 'no other kind from the socket');
  assert.deepEqual(events.filter((e) => e.kind === 'render').map((e) => e.id), ['p'], 'only the real render');
  const doms = events.filter((e) => e.kind === 'dom');
  assert.equal(doms.length, 1, 'only the one allowlisted frame became a bus event');
  assert.equal(doms[0].source, 'browser');
  assert.ok(doms[0].seq < 1e6, `ring seq is the ring's own (${doms[0].seq})`);
  assert.notEqual(doms[0].ts, 7);
  assert.ok(json.latest < 1e6 && !json.gap, 'the ring cursor is not poisoned');
  const q = (await api.get('/api/queue')).json;
  assert.ok(q.items.every((it) => it.kind === 'activity'), 'no forged signal item was queued');
}

test('local socket: forged kinds never reach the bus, and the ring keeps its seq', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p', html: '<button>go</button>' });
  const sock = await sendFrames(`ws://localhost:${port}/ws`, {}, frames);
  t.after(() => { try { sock.terminate(); } catch {} });
  await assertNoForgery(api);
});

test('remote socket through the portal relay: the same frames are refused', async (t) => {
  const srv = await withServer(t, { writePortfile: true });
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const access = createFakeAccess();
  const p = await withPortal(t, { config: access.config(), fetchJwks: access.fetchJwks });
  const host = sessionHost(p.config, instanceId(srv.root));
  await srv.api.post('/api/render', { id: 'p', html: '<button>go</button>' });
  const sock = await sendFrames(`ws://127.0.0.1:${p.port}/ws`, {
    headers: { host, 'cf-access-jwt-assertion': access.mint() }, origin: `https://${host}`,
  }, frames);
  t.after(() => { try { sock.terminate(); } catch {} });
  await assertNoForgery(srv.api);
});

// Commit 6 — declared-signal wake (the extensibility seam). A render declares
// `params.signals: [{key, wake}]`; a browser write to
// that key then either folds into the queue (wake:'queue') or wakes Claude
// immediately (wake:'immediate'), bypassing the queue. Undeclared browser writes
// stay plain state.

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { withServer } = require('../test-support/helpers');
const { derive, parseSignals } = require('../lib/server/domain/signals');

// Connect, wait for hello, send one store:set (source:'browser'), settle.
function wsStoreSet(port, patch) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') {
        sock.send(JSON.stringify({ type: 'store:set', patch }));
        setTimeout(() => { sock.close(); resolve(); }, 80);
      }
    });
    sock.on('error', reject);
  });
}
const wakes = (ev) => (ev.events || []).filter((e) => e.kind === 'wake');

test('signals: a declared immediate signal wakes at once, bypassing the queue', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'panel', html: '<div>x</div>', params: { signals: [{ key: 'ask_now', wake: 'immediate' }] } });

  await wsStoreSet(port, { ask_now: { seq: 1, payload: { secret: 'hush' } } });

  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 0, 'immediate signal does not enqueue');
  const ev = await api.get('/api/events');
  const w = wakes(ev.json);
  assert.equal(w.length, 1, 'exactly one wake emitted immediately');
  assert.equal(w[0].reason, 'immediate');
  assert.equal(w[0].source, 'browser');
  assert.equal(w[0].batch.length, 1);
  assert.equal(w[0].batch[0].signal_key, 'ask_now');
  // payload never leaks into the item summary
  assert.doesNotMatch(w[0].batch[0].summary, /hush/);
});

test('signals: a declared queue signal folds into the queue (no immediate wake)', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'form', html: '<div>x</div>', params: { signals: [{ key: 'form_submit', wake: 'queue', why: 'form submitted' }] } });

  await wsStoreSet(port, { form_submit: { seq: 2 } });

  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 1, 'queue signal enqueues');
  assert.equal(q.json.items[0].kind, 'signal');
  assert.equal(q.json.items[0].signal_key, 'form_submit');
  assert.equal(q.json.items[0].origin_mount, 'form');
  assert.equal(q.json.items[0].why_wake, 'form submitted');
  const ev = await api.get('/api/events');
  assert.equal(wakes(ev.json).length, 0, 'no immediate wake for a queue signal');
});

test('signals: a browser write to an undeclared key stays plain state', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'p', html: '<div>x</div>' }); // no signals
  await wsStoreSet(port, { slider: 42 });

  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 0);
  const ev = await api.get('/api/events');
  assert.equal(wakes(ev.json).length, 0);
});

test('signals: derive follows the live mounts — clearing the pane retires its signal', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'form', html: '<div>x</div>', params: { signals: [{ key: 'form_submit', wake: 'queue' }] } });
  await api.post('/api/clear', { id: 'form' }); // pane gone → signal retired

  await wsStoreSet(port, { form_submit: { seq: 1 } });
  const q = await api.get('/api/queue');
  assert.equal(q.json.count, 0, 'a retired signal no longer enqueues');
});

// ── unit: derive / parseSignals ──────────────────────────────────────────────

test('signals.parseSignals: normalizes wake, drops malformed entries', () => {
  const got = parseSignals('m1', { params: { signals: [
    { key: 'a', wake: 'immediate' },
    { key: 'b' },                    // defaults to queue
    { key: 'c', wake: 'bogus' },     // unknown → queue
    { wake: 'immediate' },           // no key → dropped
    null,                            // dropped
  ] } });
  assert.deepEqual(got.map((s) => [s.key, s.wake]), [['a', 'immediate'], ['b', 'queue'], ['c', 'queue']]);
});

test('signals.derive: builds the registry from all live mounts', () => {
  const state = { mounts: new Map([
    ['m1', { params: { signals: [{ key: 'x', wake: 'immediate' }] } }],
    ['m2', { params: { signals: [{ key: 'y', wake: 'queue', why: 'why-y' }] } }],
    ['m3', { params: {} }],
  ]) };
  const reg = derive(state);
  assert.deepEqual(reg.x, { wake: 'immediate', mount: 'm1', why: undefined });
  assert.deepEqual(reg.y, { wake: 'queue', mount: 'm2', why: 'why-y' });
  assert.equal(reg.z, undefined);
});

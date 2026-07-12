const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { MAX_EVENTS } = require('../lib/core/bus');

test('events: no gap within the retained window', async (t) => {
  const { api } = await withServer(t);

  for (let i = 0; i < 10; i++) await api.post('/api/store', { patch: { [`k${i}`]: i } });
  const { json: ev } = await api.get('/api/events?since=3');
  assert.equal(ev.gap, false);
  assert.equal(ev.dropped, 0);
  assert.equal(ev.oldest, 1);
  assert.ok(ev.events.every((e) => e.seq > 3));
});

test('events: gap + dropped flagged when cursor predates the ring buffer', async (t) => {
  const { api } = await withServer(t);

  const total = MAX_EVENTS + 110; // force eviction of the oldest ~110
  for (let b = 0; b * 100 < total; b++) {
    const n = Math.min(100, total - b * 100);
    await Promise.all(Array.from({ length: n }, (_, i) => api.post('/api/store', { patch: { [`k${b * 100 + i}`]: 1 } })));
  }

  const { json: ev } = await api.get('/api/events?since=5');
  assert.equal(ev.gap, true, 'cursor 5 predates the retained window');
  assert.ok(ev.oldest > 6, `oldest (${ev.oldest}) should have advanced past the cursor`);
  assert.equal(ev.dropped, ev.oldest - 1 - 5);
  assert.ok(ev.dropped > 0);

  // a fresh cursor at latest sees no gap
  const { json: ev2 } = await api.get(`/api/events?since=${ev.latest}`);
  assert.equal(ev2.gap, false);
  assert.equal(ev2.dropped, 0);
});

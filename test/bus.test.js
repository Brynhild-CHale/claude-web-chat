const test = require('node:test');
const assert = require('node:assert');
const { createBus, MAX_EVENTS } = require('../lib/core/bus');

test('bus: emit builds a ring entry with seq + ts and returns it', () => {
  const bus = createBus();
  const e = bus.emit({ event: { kind: 'store', patch: { a: 1 } } });
  assert.equal(e.seq, 1);
  assert.equal(typeof e.ts, 'number');
  assert.equal(e.kind, 'store');
  assert.deepEqual(e.patch, { a: 1 });
});

test('bus: seq is monotonic across emits', () => {
  const bus = createBus();
  const seqs = [];
  for (let i = 0; i < 5; i++) seqs.push(bus.emit({ event: { kind: 'x' } }).seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(bus.read().latest, 5);
});

test('bus: an event field overrides the ring seq (matches pre-bus pushEvent)', () => {
  // capture emits with its own `seq` field; the spread after `{seq: nextSeq++}`
  // makes the event field win, while nextSeq still advances.
  const bus = createBus();
  bus.emit({ event: { kind: 'store' } });               // ring seq 1
  const cap = bus.emit({ event: { kind: 'capture', seq: 99 } });
  assert.equal(cap.seq, 99, 'event.seq overrides the ring seq');
  assert.equal(bus.read().latest, 2, 'nextSeq still advanced to 2');
});

test('bus: read({since}) returns only newer events + latest', () => {
  const bus = createBus();
  for (let i = 0; i < 4; i++) bus.emit({ event: { kind: 'k', i } });
  const r = bus.read({ since: 2 });
  assert.deepEqual(r.events.map((e) => e.seq), [3, 4]);
  assert.equal(r.latest, 4);
  assert.equal(r.gap, false);
  assert.equal(r.dropped, 0);
  assert.equal(r.oldest, 1);
});

test('bus: read({kinds}) filters by kind but gap uses the full ring', () => {
  const bus = createBus();
  bus.emit({ event: { kind: 'store' } });
  bus.emit({ event: { kind: 'render' } });
  bus.emit({ event: { kind: 'store' } });
  const r = bus.read({ since: 0, kinds: ['store'] });
  assert.deepEqual(r.events.map((e) => e.kind), ['store', 'store']);
  assert.equal(r.oldest, 1, 'oldest is over the full ring, not the filtered set');
});

test('bus: ring evicts oldest past maxEvents; gap/dropped flagged', () => {
  const bus = createBus({ maxEvents: 10 });
  for (let i = 0; i < 25; i++) bus.emit({ event: { kind: 'k' } });
  const r = bus.read({ since: 1 });
  assert.equal(bus.events.length, 10, 'ring capped at maxEvents');
  assert.equal(r.oldest, 16, 'oldest advanced past the evicted window');
  assert.equal(r.latest, 25);
  assert.equal(r.gap, true);
  assert.equal(r.dropped, r.oldest - 1 - 1);
});

test('bus: default maxEvents is MAX_EVENTS', () => {
  const bus = createBus();
  for (let i = 0; i < MAX_EVENTS + 5; i++) bus.emit({ event: { kind: 'k' } });
  assert.equal(bus.events.length, MAX_EVENTS);
});

test('bus: subscribe taps live events; unsubscribe stops delivery', () => {
  const bus = createBus();
  const got = [];
  const unsub = bus.subscribe((e) => got.push(e.seq));
  bus.emit({ event: { kind: 'a' } });
  bus.emit({ event: { kind: 'b' } });
  unsub();
  bus.emit({ event: { kind: 'c' } });
  assert.deepEqual(got, [1, 2]);
});

test('bus: a throwing subscriber is swallowed and does not block others', () => {
  const bus = createBus();
  const got = [];
  bus.subscribe(() => { throw new Error('boom'); });
  bus.subscribe((e) => got.push(e.seq));
  const e = bus.emit({ event: { kind: 'a' } });
  assert.equal(e.seq, 1);
  assert.deepEqual(got, [1], 'second subscriber still fired after the first threw');
});

test('bus: emit fans WS frames to the registered broadcaster, skipping except', () => {
  const bus = createBus();
  const sent = [];
  bus.setBroadcaster((msg, except) => sent.push({ msg, except }));
  bus.emit({ ws: { type: 'render', id: 'm1' } });
  bus.emit({ ws: [{ type: 'a' }, { type: 'b' }], except: 'sock' });
  assert.deepEqual(sent, [
    { msg: { type: 'render', id: 'm1' }, except: undefined },
    { msg: { type: 'a' }, except: 'sock' },
    { msg: { type: 'b' }, except: 'sock' },
  ]);
});

test('bus: a ws-only emit never enters the ring', () => {
  const bus = createBus();
  bus.setBroadcaster(() => {});
  bus.emit({ ws: { type: 'clear', id: 'legacy' } });
  assert.equal(bus.events.length, 0);
  assert.equal(bus.read().latest, 0);
});

test('bus: emit with both event and ws does both, event first', () => {
  const order = [];
  const bus = createBus();
  bus.subscribe(() => order.push('event'));
  bus.setBroadcaster(() => order.push('ws'));
  const built = bus.emit({ event: { kind: 'store' }, ws: { type: 'store:patch' } });
  assert.equal(built.seq, 1);
  assert.deepEqual(order, ['event', 'ws']);
});

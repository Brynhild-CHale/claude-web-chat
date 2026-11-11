// The main ring's seq is its ring position, whatever an emitter passes (U748b;
// contract 07 C-07.11, C-07.12). createBus's `seqIsPosition` option, set only
// where lib/server/index.js makes the main bus, drops an event's own `seq` from
// the entry; the hook tap and the mirror bus are made without it and keep the
// spread's override exactly (the hook tap's envelope `ts` above all).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createBus } = require('../lib/core/bus');
const { createHookTap } = require('../lib/server/hook-tap');
const { withServer, waitUntil } = require('../test-support/helpers');

test('seqIsPosition: an emitter\'s own seq never reaches the entry; the ring stays contiguous', () => {
  const bus = createBus({ seqIsPosition: true });
  const got = [];
  bus.subscribe((e) => got.push(e));
  bus.emit({ event: { kind: 'store' } });
  const forged = bus.emit({ event: { kind: 'x', seq: 1 } });
  bus.emit({ event: { kind: 'y' } });
  assert.equal(forged.seq, 2, 'the forged seq gave way to the ring position');
  assert.deepEqual(bus.events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(got.map((e) => e.seq), [1, 2, 3], 'subscribers see the position too');
  assert.deepEqual(Object.keys(forged), ['seq', 'ts', 'kind'], 'seq stays the first key; nothing else of the caller\'s seq kept');
  assert.equal(bus.read({ since: 1 }).events.length, 2);
});

test('seqIsPosition: an event\'s own ts still wins (only seq is the ring\'s)', () => {
  const bus = createBus({ seqIsPosition: true });
  assert.equal(bus.emit({ event: { kind: 'x', ts: 7 } }).ts, 7);
});

test('without the option (the hook tap, the mirror bus) the spread is unchanged: an event\'s seq and ts still override', () => {
  const bus = createBus();
  bus.emit({ event: { kind: 'store' } });
  const over = bus.emit({ event: { kind: 'x', seq: 99, ts: 5 } });
  assert.equal(over.seq, 99);
  assert.equal(over.ts, 5);
  assert.equal(bus.read().latest, 2);
});

test('the hook tap: an envelope\'s own ts still overrides the built one', () => {
  const tap = createHookTap();
  const e = tap.publish({ v: 1, event: 'PreToolUse', ts: 1234, session_id: 's' });
  assert.equal(e.ts, 1234, 'the envelope\'s ts kept');
  assert.equal(e.seq, 1);
  assert.equal(e.kind, 'hook');
});

test('the main bus is made with seqIsPosition, and only there', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('seqIsPosition: true')) hits.push(path.relative(lib, p));
    }
  };
  walk(lib);
  assert.deepEqual(hits, ['server/index.js']);
});

test('a real server\'s main ring: every entry\'s seq is its position', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/store', { patch: { a: 1 } });
  await api.post('/api/render', { id: 'u748b-p', html: '<p>x</p>' });
  await api.post('/api/store', { patch: { b: 2 } });
  let ring;
  await waitUntil(async () => { ring = (await api.get('/api/events?since=0')).json; return ring.events.length >= 3; });
  ring.events.forEach((e, i) => assert.equal(e.seq, ring.events[0].seq + i));
  assert.equal(ring.latest, ring.events[ring.events.length - 1].seq);
});

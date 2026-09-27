// public/app/bus.js — the chrome's tiny pub/sub. A plain listener map (s2-3):
// it used to dispatch DOM CustomEvents on an EventTarget, which threw under a
// test DOM whose CustomEvent came from another realm than its EventTarget.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

test('bus: emit hands detail to every listener; off unsubscribes; a throwing listener does not stop the rest', async () => {
  const { bus } = await import(pathToFileURL(path.join(__dirname, '..', 'public/app/bus.js')).href);
  const got = [];
  const offA = bus.on('t-bus', (d) => got.push(['a', d]));
  bus.on('t-bus', () => { throw new Error('boom'); });
  bus.on('t-bus', (d) => got.push(['c', d]));
  const err = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    bus.emit('t-bus', { n: 1 });
    offA();
    bus.emit('t-bus', { n: 2 });
    bus.emit('t-nobody', { n: 3 });
  } finally {
    console.error = err;
  }
  assert.deepEqual(got, [['a', { n: 1 }], ['c', { n: 1 }], ['c', { n: 2 }]]);
  assert.equal(logged.length, 2, 'each throw is reported, not raised to the emitter');
  assert.match(logged[0], /t-bus/);
});

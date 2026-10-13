// The chrome's reconnect (public/app/ws.js): a dropped socket is retried on a
// backoff — 0.5, 1, 2, 4, then every 5 s, each ±20 % — counted from the last
// `hello`, and a tab that comes back into view or a network that comes back
// reconnects at once (ruled 2026-10-13, U101@backoff). It used to retry once a
// second forever, so a daemon that was down was knocked on by every open tab
// every second (design/tools/t567-inputs/safari-report.md item 2).
//
// The real chrome in jsdom (test-support/chrome-shell). A drop's reconnect is
// read where ws.js schedules it: setTimeout is wrapped for the one synchronous
// drop() call, and the call whose callback is ws.js's own `connect` is the
// reconnect, so a test reads the delay without waiting it out.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

let shell, ws;

before(async () => {
  shell = await bootShell();
  ws = await shell.importApp('ws.js');
  await shell.frame(helloFrame());
});

after(() => shell.restore());

// Drop the current socket and return the delay ws.js scheduled its reconnect at.
function drop() {
  const seen = [];
  const inner = globalThis.setTimeout;
  globalThis.setTimeout = function wrapped(fn, ms, ...rest) {
    if (fn === ws.connect) seen.push(ms);
    return inner.call(this, fn, ms, ...rest);
  };
  try { shell.socket().drop(); } finally { globalThis.setTimeout = inner; }
  assert.equal(seen.length, 1, 'one drop schedules exactly one reconnect');
  return seen[0];
}

const isOpen = () => shell.socket() && shell.socket().readyState === 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Back to a live socket that has said hello: the schedule starts over.
async function settle() {
  if (!isOpen()) await waitUntil(isOpen, { timeout: 8000, what: 'a live socket' });
  await shell.frame(helloFrame());
}

const within = (ms, base) => ms >= base * 0.8 && ms <= base * 1.2;

test('reconnectDelay: 500, 1000, 2000, 4000, then 5000 at the midpoint, and never more than ±20 % off', () => {
  const mid = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((n) => ws.reconnectDelay(n, mid)),
    [500, 1000, 2000, 4000, 5000, 5000, 5000]);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => ws.reconnectDelay(n, () => 0)), [400, 800, 1600, 3200, 4000, 4000]);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => ws.reconnectDelay(n, () => 1)), [600, 1200, 2400, 4800, 6000, 6000]);
  for (let i = 0; i < 200; i++) {
    const n = i % 8;
    const d = ws.reconnectDelay(n);
    assert.ok(within(d, [500, 1000, 2000, 4000][n] || 5000), `attempt ${n}: ${d} ms`);
  }
  assert.equal(ws.reconnectDelay(-1, mid), 500, 'a nonsense attempt is the first one');
  assert.equal(ws.reconnectDelay(undefined, mid), 500);
});

test('drops with no hello between them back off; a hello resets the schedule', async (t) => {
  t.after(settle);
  await settle();
  const first = drop();
  assert.ok(within(first, 500), `the first retry is fast: ${first} ms`);
  const n = shell.sockets.length;
  await waitUntil(() => shell.sockets.length === n + 1 && isOpen(), { timeout: 3000, what: 'the scheduled reconnect' });
  // Open, but no hello: a daemon that accepts the upgrade and drops it at once.
  const second = drop();
  assert.ok(second > first, `the second waits longer than the first (${second} > ${first})`);
  assert.ok(within(second, 1000), `${second} ms`);
  const rest = [];
  for (let i = 0; i < 4; i++) {
    window.dispatchEvent(new window.Event('online'));   // skip the wait: the count is kept
    await waitUntil(isOpen, { what: 'the immediate reconnect' });
    rest.push(drop());
  }
  assert.ok(within(rest[0], 2000) && within(rest[1], 4000) && within(rest[2], 5000) && within(rest[3], 5000),
    `then 2, 4, 5, 5 s, ±20 %: ${rest.join(', ')}`);
  window.dispatchEvent(new window.Event('online'));
  await waitUntil(isOpen, { what: 'the immediate reconnect' });
  await shell.frame(helloFrame());
  const fresh = drop();
  assert.ok(within(fresh, 500), `after a hello the next drop is the fast one again: ${fresh} ms`);
});

test('a tab that becomes visible while the socket is closed reconnects at once, and the pending reconnect is cancelled', async (t) => {
  t.after(settle);
  await settle();
  const pending = drop();
  const n = shell.sockets.length;
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(shell.sockets.length, n + 1, 'a new socket at once');
  await waitUntil(isOpen, { what: 'the new socket to open' });
  await sleep(pending + 250);   // past the moment the cancelled reconnect was due
  assert.equal(shell.sockets.length, n + 1, 'exactly one new socket: the scheduled reconnect never ran');
});

test('visibilitychange does nothing while the socket is open, or when the tab is going hidden', async (t) => {
  t.after(settle);
  await settle();
  const n = shell.sockets.length;
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(shell.sockets.length, n, 'open: nothing to reconnect');
  drop();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  try {
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(shell.sockets.length, n, 'hidden: the scheduled reconnect is left to run');
  } finally {
    delete document.visibilityState;
  }
  assert.equal(document.visibilityState, 'visible');
  await waitUntil(() => shell.sockets.length === n + 1 && isOpen(), { timeout: 3000, what: 'the scheduled reconnect' });
});

test('the network coming back while the socket is closed reconnects at once, and the pending reconnect is cancelled', async (t) => {
  t.after(settle);
  await settle();
  const n = shell.sockets.length;
  window.dispatchEvent(new window.Event('online'));
  assert.equal(shell.sockets.length, n, 'online with an open socket: nothing');
  const pending = drop();
  window.dispatchEvent(new window.Event('online'));
  assert.equal(shell.sockets.length, n + 1, 'a new socket at once');
  await waitUntil(isOpen, { what: 'the new socket to open' });
  await sleep(pending + 250);
  assert.equal(shell.sockets.length, n + 1, 'exactly one new socket: the scheduled reconnect never ran');
});

test('the conn event is unchanged: reconnecting on a drop, live on the reconnect', async (t) => {
  t.after(settle);
  await settle();
  const { bus } = await shell.importApp('bus.js');
  const log = [];
  const off = bus.on('conn', (d) => log.push(d.state));
  t.after(() => { if (typeof off === 'function') off(); });
  drop();
  assert.deepEqual(log, ['reconnecting']);
  window.dispatchEvent(new window.Event('online'));
  await waitUntil(isOpen, { what: 'the reconnect' });
  assert.deepEqual(log, ['reconnecting', 'live']);
});

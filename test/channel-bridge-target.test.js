// U63 — the channel bridge honours a wake's target (spec §6.4, Targeting).
//
// Every bridge used to deliver every wake, so two sessions with live channels
// both ran one message. The bridge now knows its Claude Code process (the MCP
// server's parent, injected here as 111), reports it on every heartbeat
// ({pid}), and skips a wake aimed at another process: no notification, no
// ack, and its seq consumed, so a replay after a reconnect never delivers it
// later. An untargeted wake is delivered as before. Fake client and fake
// notify sink, as the cursor tests in test/channel-bridge.test.js.

const test = require('node:test');
const assert = require('node:assert');
const { startChannelBridge } = require('../lib/channel/bridge');

const BACKOFF_TICK = 1000; // > BACKOFF_MIN_MS (500)
const microflush = () => new Promise((r) => setImmediate(r));

function harness(t, { pid = 111, boot = 'B' } = {}) {
  const connects = [];
  const posts = [];
  const logs = [];
  const notified = [];
  const client = {
    subscribeSSE(opts) { connects.push(opts); return { close() {} }; },
    get: async () => ({ boot }),
    post: async (path, body) => { posts.push({ path, body }); return { ok: true }; },
  };
  const bridge = startChannelBridge({
    notify: (method, params) => { notified.push({ method, params }); return Promise.resolve(); },
    client, root: 'x', log: (m) => logs.push(m), pid,
  });
  t.after(() => bridge.stop());
  const acks = () => posts.filter((p) => p.path === '/api/channel/ack');
  const beats = () => posts.filter((p) => p.path === '/api/channel/heartbeat');
  return { connects, posts, logs, notified, bridge, acks, beats };
}

const wake = (seq, extra = {}) => ({ kind: 'wake', seq, boot: 'B', batch: [{ id: `q${seq}`, kind: 'signal', summary: 's' }], ...extra });

test('the heartbeat reports the bridge\'s Claude Code process: {pid}', async (t) => {
  const h = harness(t);
  await microflush();
  h.connects[0].onOpen();
  await microflush();
  assert.equal(h.beats().length, 1);
  assert.deepEqual(h.beats()[0].body, { pid: 111 });
});

test('the default pid is the MCP server\'s parent, process.ppid', async (t) => {
  const posts = [];
  const connects = [];
  const bridge = startChannelBridge({
    notify: () => {},
    client: { subscribeSSE(o) { connects.push(o); return { close() {} }; }, get: async () => ({}), post: async (p, b) => { posts.push(b); } },
    root: 'x',
  });
  t.after(() => bridge.stop());
  await microflush();
  connects[0].onOpen();
  await microflush();
  assert.deepEqual(posts[0], { pid: process.ppid });
});

test('a wake targeted at another process is not notified, not acked, and logged once naming the pid', async (t) => {
  const h = harness(t);
  await microflush();
  h.connects[0].onEvent(wake(4, { target_pid: 222 }));
  await microflush();
  await microflush();
  assert.equal(h.notified.length, 0);
  assert.equal(h.acks().length, 0);
  assert.equal(h.logs.filter((m) => /222/.test(m)).length, 1);
});

test('a skipped wake is never delivered by a replay after a reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  await microflush();
  h.connects[0].onEvent(wake(4, { target_pid: 222 }));
  h.connects[0].onClose();
  t.mock.timers.tick(BACKOFF_TICK);
  await microflush();
  assert.equal(h.connects.length, 2);
  assert.equal(h.connects[1].since, 4, 'the cursor moved past the skipped wake');
  h.connects[1].onEvent(wake(4, { target_pid: 222 }));
  h.connects[1].onEvent(wake(4)); // even stripped of its target, seq 4 is spent
  await microflush();
  assert.equal(h.notified.length, 0);
  assert.equal(h.acks().length, 0);
});

test('a wake targeted at this process, or at none, is delivered and acked as before', async (t) => {
  const h = harness(t);
  await microflush();
  h.connects[0].onEvent(wake(5, { target_pid: 111 }));
  h.connects[0].onEvent(wake(6));
  await microflush();
  await microflush();
  assert.equal(h.notified.length, 2);
  assert.ok(h.notified.every((n) => n.method === 'notifications/claude/channel'));
  assert.deepEqual(h.acks().map((a) => a.body), [{ seq: 5, boot: 'B' }, { seq: 6, boot: 'B' }], 'the ack body is unchanged');
  assert.equal(h.logs.length, 0);
});

test('a non-numeric target_pid is not a target', async (t) => {
  const h = harness(t);
  await microflush();
  h.connects[0].onEvent(wake(7, { target_pid: '222' }));
  await microflush();
  await microflush();
  assert.equal(h.notified.length, 1);
});

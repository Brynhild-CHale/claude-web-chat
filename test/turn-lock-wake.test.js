// turn-begin-on-push + pending re-aim — the post-channels turn-lock model.
//
// Wake locks: every wake goes through queue.emitWake, which (given graph)
// acquires a turn lock with author:'wake' and a short TTL — so a channel-woken
// turn commits its own first-class node at Stop instead of folding into the
// next typed turn's commit. A typed turn-begin UPGRADES a wake lock in place
// (same turn, same base); a wake during a fresh user lock folds silently.
//
// Pending re-aim: a user re-aim during ANY fresh lock queues (last wins) and
// applies after the turn-end commit (or on manual unlock) — never a 409.

const test = require('node:test');
const assert = require('node:assert');
const { withServer } = require('../test-support/helpers');
const { subscribeSSE } = require('../lib/client');
const {
  acquireWakeLock, lockIsStale, WAKE_LOCK_TTL_MS, LOCK_TTL_MS,
} = require('../lib/server/domain/turns');

const busStub = () => ({ emit() {} });
const graphStub = (lock) => ({ lock, active: 'n0', saveMeta() {} });

// ── unit: acquireWakeLock / per-lock TTL ─────────────────────────────────────

test('acquireWakeLock: acquires with author wake + short TTL when unlocked', () => {
  const g = graphStub(null);
  const r = acquireWakeLock(g, busStub(), { message: 'channel wake: 2 signals' });
  assert.equal(r.ok, true);
  assert.equal(g.lock.author, 'wake');
  assert.equal(g.lock.base, 'n0');
  assert.equal(g.lock.ttl_ms, WAKE_LOCK_TTL_MS);
});

test('acquireWakeLock: folds into a fresh user lock; extends a fresh wake lock', () => {
  const userLock = { base: 'n0', started_at: Date.now(), author: 'user', message: 'typing' };
  const g1 = graphStub(userLock);
  assert.equal(acquireWakeLock(g1, busStub(), {}).folded, true);
  assert.equal(g1.lock, userLock, 'user lock untouched');

  const g2 = graphStub({ base: 'n0', started_at: Date.now() - 1000, author: 'wake', ttl_ms: WAKE_LOCK_TTL_MS });
  const r2 = acquireWakeLock(g2, busStub(), { message: 'channel wake: 1 signal' });
  assert.equal(r2.extended, true);
  assert.ok(Date.now() - g2.lock.started_at < 500, 'clock re-stamped');
});

test('lockIsStale: honors the per-lock ttl_ms (wake locks go stale sooner)', () => {
  const age = WAKE_LOCK_TTL_MS + 1000; // stale for a wake lock, fresh for a user lock
  assert.ok(age < LOCK_TTL_MS, 'test premise: wake TTL ≪ default TTL');
  assert.equal(lockIsStale({ started_at: Date.now() - age, ttl_ms: WAKE_LOCK_TTL_MS }), true);
  assert.equal(lockIsStale({ started_at: Date.now() - age }), false);
});

// ── HTTP: wake locks the turn; turn-end commits a wake node ──────────────────

const openWakeSSE = (port) => new Promise((resolve) => {
  const h = subscribeSSE({ port, kinds: ['wake'], onOpen: () => resolve(h) });
});

test('a live push acquires a wake lock; turn-end commits the channel turn as its own node', async (t) => {
  const { api, port } = await withServer(t);
  const sse = await openWakeSSE(port);
  t.after(() => sse.close());

  await api.post('/api/queue/push', { note: 'look at this' });
  let g = await api.get('/api/graph');
  assert.ok(g.json.lock, 'push locked the turn');
  assert.equal(g.json.lock.author, 'wake');
  assert.match(g.json.lock.message, /channel wake/);

  await api.post('/api/render', { id: 'p', html: '<p>woken work</p>' });
  const te = await api.post('/api/turn-end', {});
  assert.ok(te.json.node_id, 'channel turn committed its own node');
  g = await api.get('/api/graph');
  assert.equal(g.json.lock, null);
  const node = await api.get('/api/graph/node/' + te.json.node_id);
  assert.match(node.json.trigger.message, /channel wake/, 'provenance names the wake');
});

test('an immediate declared signal also locks the turn', async (t) => {
  const { api, port } = await withServer(t);
  const sse = await openWakeSSE(port);
  t.after(() => sse.close());
  await api.post('/api/render', { id: 'panel', html: '<div>x</div>', params: { signals: [{ key: 'ask_now', wake: 'immediate' }] } });

  // a browser write to the immediate key (via the store route would be
  // server-sourced; go through WS like a real pane)
  const WebSocket = require('ws');
  await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://localhost:${port}/ws`);
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') {
        sock.send(JSON.stringify({ type: 'store:set', patch: { ask_now: { seq: 1 } } }));
        setTimeout(() => { sock.close(); resolve(); }, 100);
      }
    });
    sock.on('error', reject);
  });

  const g = await api.get('/api/graph');
  assert.ok(g.json.lock, 'immediate wake locked the turn');
  assert.equal(g.json.lock.author, 'wake');
});

test('a typed turn-begin UPGRADES a fresh wake lock instead of 409ing', async (t) => {
  const { api, port } = await withServer(t);
  const sse = await openWakeSSE(port);
  t.after(() => sse.close());
  await api.post('/api/queue/push', { note: 'wake first' });
  assert.equal((await api.get('/api/graph')).json.lock.author, 'wake');

  const r = await api.post('/api/turn-begin', { message: 'and then the user typed' });
  assert.equal(r.status, 200);
  assert.equal(r.json.upgraded_wake_lock, true);
  const lock = (await api.get('/api/graph')).json.lock;
  assert.equal(lock.author, 'user');
  assert.equal(lock.message, 'and then the user typed');
});

test('a wake during a fresh user turn folds — the user lock is untouched', async (t) => {
  const { api, port } = await withServer(t);
  const sse = await openWakeSSE(port);
  t.after(() => sse.close());
  await api.post('/api/turn-begin', { message: 'typed turn' });

  await api.post('/api/queue/push', { note: 'mid-turn push' });
  const lock = (await api.get('/api/graph')).json.lock;
  assert.equal(lock.author, 'user');
  assert.equal(lock.message, 'typed turn');
});

test('a parked push (no channel) stays lock-less', async (t) => {
  const { api } = await withServer(t);
  const r = await api.post('/api/queue/push', { note: 'nobody listening' });
  assert.equal(r.json.mode, 'parked');
  assert.equal((await api.get('/api/graph')).json.lock, null, 'a park is not a turn');
});

// ── HTTP: pending re-aim ─────────────────────────────────────────────────────

test('set-active during a turn queues; turn-end commits on base THEN applies (last intent wins)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  const c2 = await api.post('/api/commit', { message: 'two' });

  await api.post('/api/turn-begin', { message: 'working' });
  await api.post('/api/render', { id: 'b', html: '<p>turn work</p>' });

  const p1 = await api.post('/api/graph/active', { id: c1.json.node_id });
  assert.equal(p1.status, 200);
  assert.equal(p1.json.pending, true);
  const p2 = await api.post('/api/graph/active', { id: c2.json.node_id });
  assert.equal(p2.json.pending, true);
  assert.equal((await api.get('/api/graph')).json.active, c2.json.node_id, 'active untouched mid-turn');

  const te = await api.post('/api/turn-end', {});
  assert.equal(te.json.reaim.op, 'set-active');
  assert.equal(te.json.reaim.id, c2.json.node_id, 'last queued intent wins');
  const g = await api.get('/api/graph');
  // the turn's node committed as a child of the lock base…
  const committed = g.json.nodes.find((n) => n.id === te.json.node_id);
  assert.equal(committed.parent_id, c2.json.node_id);
  // …and then the queued jump applied
  assert.equal(g.json.active, c2.json.node_id);
});

test('a queued wipe applies at turn-end', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>x</p>' });
  await api.post('/api/commit', { message: 'seed' });
  await api.post('/api/turn-begin', { message: 'working' });

  const r = await api.post('/api/graph/wipe', {});
  assert.equal(r.json.pending, true);
  assert.equal((await api.get('/api/mounts')).json.mounts.length, 1, 'mounts intact mid-turn');

  await api.post('/api/turn-end', {});
  assert.equal((await api.get('/api/mounts')).json.mounts.length, 0, 'wipe applied after commit');
});

test('manual unlock applies the queued re-aim', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  await api.post('/api/commit', { message: 'two' });
  await api.post('/api/turn-begin', { message: 'working' });

  await api.post('/api/graph/active', { id: c1.json.node_id });
  const u = await api.post('/api/unlock', {});
  assert.equal(u.json.reaim.op, 'set-active');
  assert.equal((await api.get('/api/graph')).json.active, c1.json.node_id);
});

test('an immediate (unlocked) re-aim supersedes a stale queued intent', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/render', { id: 'a', html: '<p>one</p>' });
  const c1 = await api.post('/api/commit', { message: 'one' });
  await api.post('/api/render', { id: 'a', html: '<p>two</p>' });
  const c2 = await api.post('/api/commit', { message: 'two' });

  await api.post('/api/turn-begin', { message: 'working' });
  await api.post('/api/graph/active', { id: c1.json.node_id }); // queued
  await api.post('/api/unlock', {});                            // applies → active c1
  await api.post('/api/graph/active', { id: c2.json.node_id }); // immediate
  const te = await api.post('/api/turn-end', {});
  assert.equal(te.json.skipped, 'no-lock');
  assert.equal((await api.get('/api/graph')).json.active, c2.json.node_id, 'no ghost re-aim re-applied');
});

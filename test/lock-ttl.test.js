const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');

// LOCK_TTL_MS is read once, at lib/server/domain/turns LOAD, so the only way to
// test the stale-lock path in reasonable time is to set the env var and re-read
// the module — which means evicting turns.js and everything that top-imports it
// (graph.js pulls in turns; routes/graph and the server index pull in graph), or
// two turns instances end up loaded at once.
const TTL_MODULES = ['../lib/server/domain/turns', '../lib/server/graph', '../lib/server/routes/graph', '../lib/server'];
const bustTtlModules = () => { for (const m of TTL_MODULES) delete require.cache[require.resolve(m)]; };

// Returns the FRESH createServer for withServer to boot. Passing it explicitly
// matters: helpers used to capture createServer at require time, so a test that
// busted the cache got the STALE module back and passed while exercising the old
// TTL — a silent false green in a lock-correctness test. Both the env var and the
// cache are restored on t.after, so a failing assertion cannot leak either.
function shortTtlServer(t, ms = 50) {
  const prev = process.env.WEB_CHAT_LOCK_TTL_MS;
  process.env.WEB_CHAT_LOCK_TTL_MS = String(ms);
  bustTtlModules();
  const { createServer } = require('../lib/server');
  t.after(() => {
    if (prev === undefined) delete process.env.WEB_CHAT_LOCK_TTL_MS; else process.env.WEB_CHAT_LOCK_TTL_MS = prev;
    bustTtlModules();
  });
  return createServer;
}

// A real elapsed wait, not a synchronisation point: the assertion IS that the
// TTL has passed.
const elapse = (ms) => new Promise((r) => setTimeout(r, ms));

test('fresh lock blocks a second turn-begin (409)', async (t) => {
  const { api } = await withServer(t);
  const r1 = await api.post('/api/turn-begin', { message: 'first' });
  assert.equal(r1.status, 200);
  const r2 = await api.post('/api/turn-begin', { message: 'second' });
  assert.equal(r2.status, 409);
});

test('stale lock is stolen by a new turn-begin', async (t) => {
  const { api } = await withServer(t, { createServer: shortTtlServer(t) });

  await api.post('/api/turn-begin', { message: 'first' });
  await elapse(120); // exceed the 50ms TTL
  const r2 = await api.post('/api/turn-begin', { message: 'second' });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.stole_stale_lock, true);
});

test('new-graph during a fresh lock QUEUES as a pending re-aim (guardReaim block path)', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'x' });
  const r = await api.post('/api/graph/new', { name: 'fresh' });
  assert.equal(r.status, 200);
  assert.equal(r.json.pending, true);
  assert.equal(r.json.applies, 'turn-end');
  // nothing happened yet — the graph is untouched until the turn ends
  const { json: g } = await api.get('/api/graph');
  assert.ok(g.lock, 'lock still held');
});

test('new-graph steals + persists a stale lock (guardReaim wiring / drift-fix path)', async (t) => {
  const { api, root } = await withServer(t, { createServer: shortTtlServer(t) });

  await api.post('/api/turn-begin', { message: 'first' });
  await elapse(120); // exceed the 50ms TTL → lock stale
  // new-graph must STEAL the stale lock (200), not block (409) — i.e. it routes
  // through guardReaim, not lockHeld.
  const r = await api.post('/api/graph/new', { name: 'fresh' });
  assert.equal(r.status, 200);
  // …and the steal must be PERSISTED to _meta.json (the drift the fix closes):
  // reloading from disk shows no stale lock.
  const meta = JSON.parse(fs.readFileSync(path.join(root, '.web-chat', 'graph', '_meta.json'), 'utf8'));
  assert.equal(meta.lock, null, 'stale lock cleared + persisted');
  assert.equal(meta.active, null, 'new-graph detached active');
});

test('boot clears a stale lock persisted in _meta.json', async (t) => {
  const { api, root } = await withServer(t, {
    seed: async ({ webChatDir }) => {
      const graphDir = path.join(webChatDir, 'graph');
      fs.mkdirSync(graphDir, { recursive: true });
      // A lock with started_at=0 is well past the TTL → stale.
      fs.writeFileSync(path.join(graphDir, '_meta.json'),
        JSON.stringify({ active: null, lock: { base: null, started_at: 0, author: 'user' } }));
    },
  });
  const graphDir = path.join(root, '.web-chat', 'graph');

  const { json: health } = await api.get('/api/health');
  assert.equal(health.lock, null);
  const meta = JSON.parse(fs.readFileSync(path.join(graphDir, '_meta.json'), 'utf8'));
  assert.equal(meta.lock, null);
});

test('boot also clears a still-fresh-looking persisted lock (no live holder after restart)', async (t) => {
  // The fresh case is the dangerous one: a lock persisted by a crashed mid-turn
  // daemon still looks within-TTL, but its holder is gone, so restoring it would
  // wedge the next session. Boot must clear it regardless of age.
  const { api } = await withServer(t, {
    seed: async ({ webChatDir }) => {
      const graphDir = path.join(webChatDir, 'graph');
      fs.mkdirSync(graphDir, { recursive: true });
      fs.writeFileSync(path.join(graphDir, '_meta.json'),
        JSON.stringify({ active: null, lock: { base: null, started_at: Date.now(), author: 'user' } }));
    },
  });
  const { json: health } = await api.get('/api/health');
  assert.equal(health.lock, null, 'a persisted lock has no live holder after restart → cleared');
});

test('unlock clears a lock', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'x' });
  const { json: body } = await api.post('/api/unlock');
  assert.equal(body.ok, true);
  assert.equal(body.cleared, true);

  const { json: g } = await api.get('/api/graph');
  assert.equal(g.lock, null);
});

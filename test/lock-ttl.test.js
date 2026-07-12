const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { withServer } = require('../test-support/helpers');

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lockttl-'));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

test('fresh lock blocks a second turn-begin (409)', async (t) => {
  const { api } = await withServer(t);
  const r1 = await api.post('/api/turn-begin', { message: 'first' });
  assert.equal(r1.status, 200);
  const r2 = await api.post('/api/turn-begin', { message: 'second' });
  assert.equal(r2.status, 409);
});

test('stale lock is stolen by a new turn-begin', async () => {
  process.env.WEB_CHAT_LOCK_TTL_MS = '50';
  // Re-require the whole server subtree so the env override takes effect in a
  // fresh module cache. LOCK_TTL_MS is read at lib/server/domain/turns load; bust
  // graph.js too (it top-imports turns) so a single turns instance is loaded.
  delete require.cache[require.resolve('../lib/server/domain/turns')];
  delete require.cache[require.resolve('../lib/server/graph')];
  delete require.cache[require.resolve('../lib/server/routes/graph')];
  delete require.cache[require.resolve('../lib/server')];
  const { createServer: cs } = require('../lib/server');
  const root = tmpRoot();
  const srv = cs({ root, port: 0 });
  await new Promise((r) => srv.server.listen(0, r));
  const port = srv.server.address().port;

  await fetch(`http://localhost:${port}/api/turn-begin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'first' }),
  });
  await new Promise((r) => setTimeout(r, 120)); // exceed the 50ms TTL
  const r2 = await fetch(`http://localhost:${port}/api/turn-begin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'second' }),
  });
  assert.equal(r2.status, 200);
  const body = await r2.json();
  assert.equal(body.stole_stale_lock, true);

  await srv.stop();
  delete process.env.WEB_CHAT_LOCK_TTL_MS;
  delete require.cache[require.resolve('../lib/server/domain/turns')];
  delete require.cache[require.resolve('../lib/server/graph')];
  delete require.cache[require.resolve('../lib/server/routes/graph')];
  delete require.cache[require.resolve('../lib/server')];
});

test('new-graph is blocked by a fresh lock (409) — guardReaim block path', async (t) => {
  const { api } = await withServer(t);
  await api.post('/api/turn-begin', { message: 'x' });
  const r = await api.post('/api/graph/new', { name: 'fresh' });
  assert.equal(r.status, 409);
});

test('new-graph steals + persists a stale lock (guardReaim wiring / drift-fix path)', async () => {
  process.env.WEB_CHAT_LOCK_TTL_MS = '50';
  delete require.cache[require.resolve('../lib/server/domain/turns')];
  delete require.cache[require.resolve('../lib/server/graph')];
  delete require.cache[require.resolve('../lib/server/routes/graph')];
  delete require.cache[require.resolve('../lib/server')];
  const { createServer: cs } = require('../lib/server');
  const root = tmpRoot();
  const srv = cs({ root, port: 0 });
  await new Promise((r) => srv.server.listen(0, r));
  const port = srv.server.address().port;
  const post = (p, b) => fetch(`http://localhost:${port}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}),
  });

  await post('/api/turn-begin', { message: 'first' });
  await new Promise((r) => setTimeout(r, 120)); // exceed the 50ms TTL → lock stale
  // new-graph must STEAL the stale lock (200), not block (409) — i.e. it routes
  // through guardReaim, not lockHeld.
  const r = await post('/api/graph/new', { name: 'fresh' });
  assert.equal(r.status, 200);
  // …and the steal must be PERSISTED to _meta.json (the drift the fix closes):
  // reloading from disk shows no stale lock.
  const meta = JSON.parse(fs.readFileSync(path.join(root, '.web-chat', 'graph', '_meta.json'), 'utf8'));
  assert.equal(meta.lock, null, 'stale lock cleared + persisted');
  assert.equal(meta.active, null, 'new-graph detached active');

  await srv.stop();
  delete process.env.WEB_CHAT_LOCK_TTL_MS;
  delete require.cache[require.resolve('../lib/server/domain/turns')];
  delete require.cache[require.resolve('../lib/server/graph')];
  delete require.cache[require.resolve('../lib/server/routes/graph')];
  delete require.cache[require.resolve('../lib/server')];
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

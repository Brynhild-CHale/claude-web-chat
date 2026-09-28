const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer, waitUntil } = require('../test-support/helpers');

// LOCK_TTL_MS is read once, at lib/server/domain/turns LOAD, so the only way to
// test the stale-lock path in reasonable time is to set the env var and re-read
// the module — which means evicting turns.js and everything that imports it, or
// two turns instances end up loaded at once. That set kept growing (graph, the
// graph and health and queue and events routes, ws.js, domain/queue — whose
// wake lock then judged staleness by the OLD TTL) and a hand-kept list of it
// silently went stale, so every module under lib/server is evicted: nothing
// outside it imports one of them.
const SERVER_DIR = path.join(__dirname, '..', 'lib', 'server') + path.sep;
const bustTtlModules = () => {
  for (const k of Object.keys(require.cache)) if (k.startsWith(SERVER_DIR)) delete require.cache[k];
};

// Set the TTL and evict, for this test only. Both the env var and the cache are
// restored on t.after, so a failing assertion cannot leak either.
function shortTtl(t, ms) {
  const prev = process.env.WEB_CHAT_LOCK_TTL_MS;
  process.env.WEB_CHAT_LOCK_TTL_MS = String(ms);
  bustTtlModules();
  t.after(() => {
    if (prev === undefined) delete process.env.WEB_CHAT_LOCK_TTL_MS; else process.env.WEB_CHAT_LOCK_TTL_MS = prev;
    bustTtlModules();
  });
}

// Returns the FRESH createServer for withServer to boot. Passing it explicitly
// matters: helpers used to capture createServer at require time, so a test that
// busted the cache got the STALE module back and passed while exercising the old
// TTL — a silent false green in a lock-correctness test.
function shortTtlServer(t, ms = 50) {
  shortTtl(t, ms);
  return require('../lib/server').createServer;
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

// ── the turn holder keeps its lock; a stolen one keeps its work ─────────────

test("Claude's own writes re-stamp the lock clock", async (t) => {
  const { api } = await withServer(t);
  const before = (await api.post('/api/turn-begin', { message: 'a long turn' })).json.lock.started_at;
  await elapse(25);
  await api.post('/api/render', { id: 'p', html: '<p>still working</p>' });
  const after = (await api.get('/api/graph')).json.lock.started_at;
  assert.ok(after > before, 'a render proves the turn is alive, so its TTL restarts');
});

// The wake lock's TTL is minutes, and an agentic turn routinely runs longer. Once
// it went stale, a user click on a graph node stole the lock and restoreLiveToNode
// threw away every render the woken turn had made — uncommitted, so with no undo.
test('a re-aim that steals a stale lock preserves the abandoned turn\'s work', async (t) => {
  const { api } = await withServer(t, { createServer: shortTtlServer(t) });
  await api.post('/api/render', { id: 'a', html: '<p>committed</p>' });
  const n1 = (await api.post('/api/commit', { message: 'seed' })).json.node_id;

  await api.post('/api/turn-begin', { message: 'a turn that never Stops' });
  await api.post('/api/render', { id: 'b', html: '<p>woken work</p>' });
  await elapse(120); // exceed the 50ms TTL → the lock is stealable

  const r = await api.post('/api/graph/active', { id: n1 });
  assert.equal(r.status, 200, 'a stale lock does not block the user');
  const g = (await api.get('/api/graph')).json;
  assert.equal(g.active, n1, 'the user went where they clicked');

  const preserved = g.nodes.find((n) => n.id !== n1);
  assert.ok(preserved, 'the abandoned turn left a node behind');
  const node = (await api.get('/api/graph/node/' + preserved.id)).json;
  assert.equal(node.trigger.kind, 'preserve');
  assert.match(node.trigger.summary, /abandoned/);
  assert.equal(node.parent_id, n1, 'committed on the commit point the turn was working from');
  assert.ok(node.mounts.some((m) => m.id === 'b'), 'the render survived the steal');
});

// ── the stale moment reaches the chrome ─────────────────────────────────────
// A lock goes stale by the clock alone. The chrome gates Set active / ⑃ Branch
// on a FRESH lock (public/app/topbar lockHoldsReaim), so the server has to say
// when that happens — on every lock it shows, and with a frame at the moment.

test('a lock frame says stale:true once the TTL passes; hello and GET /api/graph agree', async (t) => {
  const { api, ws, wsHello, root } = await withServer(t, { createServer: shortTtlServer(t, 150) });
  const sock = ws();
  const frames = [];
  sock.on('message', (d) => { try { frames.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); });
  t.after(() => sock.close());
  const hello = await waitUntil(() => frames.find((f) => f.type === 'hello'), { what: 'hello' });
  assert.equal(hello.lock, null);

  await api.post('/api/turn-begin', { message: 'a turn that never Stops' });
  const fresh = await waitUntil(() => frames.find((f) => f.type === 'lock' && f.lock), { what: 'the turn-begin lock frame' });
  assert.equal(fresh.lock.stale, false, 'a new lock is fresh');
  assert.equal((await api.get('/api/graph')).json.lock.stale, false);

  const stale = await waitUntil(() => frames.find((f) => f.type === 'lock' && f.lock && f.lock.stale === true),
    { timeout: 3000, what: 'a stale:true lock frame' });
  assert.equal(stale.lock.message, 'a turn that never Stops', 'it is the same lock, now stale');
  assert.equal((await api.get('/api/graph')).json.lock.stale, true);
  assert.equal((await wsHello()).lock.stale, true, 'a (re)connecting chrome is told too');

  // `stale` is a view, never the record: _meta.json keeps the lock as it was.
  const meta = JSON.parse(fs.readFileSync(path.join(root, '.web-chat', 'graph', '_meta.json'), 'utf8'));
  assert.ok(meta.lock, 'still held until someone steals it');
  assert.equal('stale' in meta.lock, false);
});

// The stale timer as a unit: an unref'd handle (a lock nobody releases must not
// hold a daemon or a test run open), cleared with the lock, and re-armed when a
// keep-alive re-stamp moved the deadline.
function fakeLockBus() {
  const frames = [];
  return { frames, emit: (arg) => { if (arg && arg.ws) frames.push(arg.ws); return null; } };
}
const graphStub = () => ({ lock: null, active: 'n0', pendingReaim: null, saveMeta() {} });
const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const staleFrames = (bus) => bus.frames.filter((f) => f.type === 'lock' && f.lock && f.lock.stale === true);

test('the stale timer holds no handle open, and fires one stale lock frame', async (t) => {
  shortTtl(t, 60);
  const turns = require('../lib/server/domain/turns');
  const graph = graphStub();
  const bus = fakeLockBus();
  const before = timeouts();
  turns.acquireLock(graph, bus, { message: 'x' });
  assert.equal(timeouts(), before, 'the timer is unref\'d — it never keeps the process alive');
  await waitUntil(() => staleFrames(bus).length === 1, { timeout: 2000, what: 'the stale frame' });
  await elapse(120);
  assert.equal(staleFrames(bus).length, 1, 'once, not on a loop');
  turns.releaseLock(graph, bus);
});

test('the stale timer is cleared with the lock: a released lock never reports stale', async (t) => {
  shortTtl(t, 60);
  const turns = require('../lib/server/domain/turns');
  const graph = graphStub();
  const bus = fakeLockBus();
  turns.acquireLock(graph, bus, { message: 'x' });
  turns.releaseLock(graph, bus);
  await elapse(200);
  assert.equal(staleFrames(bus).length, 0);
});

test('the stale timer follows a keep-alive re-stamp instead of firing on the old deadline', async (t) => {
  shortTtl(t, 150);
  const turns = require('../lib/server/domain/turns');
  const graph = graphStub();
  const bus = fakeLockBus();
  turns.acquireLock(graph, bus, { message: 'x' });
  await elapse(100);
  graph.lock.started_at = Date.now(); // what installLockKeepalive does on a Claude write
  await elapse(110);                  // past the ORIGINAL deadline, before the new one
  assert.equal(staleFrames(bus).length, 0, 'a lock still being worked under is not reported stale');
  await waitUntil(() => staleFrames(bus).length === 1, { timeout: 2000, what: 'the stale frame at the new deadline' });
  turns.releaseLock(graph, bus);
});

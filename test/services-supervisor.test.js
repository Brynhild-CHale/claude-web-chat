const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withServer } = require('../test-support/helpers');

// The service supervisor: spawns/stops host-side service.js children for
// service-backed components, bound to the active graph node + viewer presence.
// Spawn requires viewers >= 1, so every test opens a real WS client. Children are
// forked processes that write the shared store via lib/driver; liveness is
// asserted by polling GET /api/store.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves to the first truthy value `fn` returns (not just `true`), so a caller
// can both assert on it and use it — e.g. to read the nonce off a trust prompt.
// Falls back to `false` on timeout, keeping every `assert.ok(await waitUntil(…))`
// call site working unchanged.
async function waitUntil(fn, { timeout = 4000, interval = 40 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  return false;
}

// A service that heartbeats a per-mount clock into the store, so tests can observe
// "running" (clock advances) vs "stopped" (clock freezes).
const CLOCK_SERVICE = `
let timer = null;
module.exports = {
  async start(ctx) {
    const tick = () => ctx.driver.setStore({ clock: { seq: Date.now(), mount: ctx.mountId } });
    tick();
    timer = setInterval(tick, 40);
  },
  async stop() { if (timer) clearInterval(timer); timer = null; },
};`;

const CRASH_SERVICE = `module.exports = { async start() { process.exit(1); } };`;

function hashOf(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

// Seed a consent record. USER-tier (ctx.userWebChat), not project-tier: a repo
// must not be able to ship its own approval and get host code execution on clone.
function trustedPath(ctx) {
  return path.join(ctx.userWebChat, 'services', 'trusted.json');
}

function trust(ctx, source, name) {
  const p = trustedPath(ctx);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ [hashOf(source)]: { name, approved_at: 1 } }, null, 2));
}

// Open a viewer socket, resolve once hello arrives, and collect every frame.
function openViewer(ctx) {
  return new Promise((resolve, reject) => {
    const sock = ctx.ws();
    const frames = [];
    sock.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (!msg) return;
      frames.push(msg);
      if (msg.type === 'hello') resolve({ sock, frames });
    });
    sock.on('error', reject);
  });
}

const children = (ctx) => ctx.srv.services._children;

test('services: spawn on active use — child runs and the store clock advances', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>clock</p>', description: 'clock', service: CLOCK_SERVICE });
  trust(ctx, CLOCK_SERVICE, 'clock');

  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/clock/use', { id: 'm1' });

  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'child spawned for the active pane');
  const first = await waitUntil(async () => (await api.get('/api/store')).json.clock);
  assert.ok(first, 'clock key appeared');
  const s1 = (await api.get('/api/store')).json.clock.seq;
  assert.equal((await api.get('/api/store')).json.clock.mount, 'm1', 'clock carries the mount id');
  assert.ok(await waitUntil(async () => (await api.get('/api/store')).json.clock.seq > s1), 'clock advances (service alive)');
});

test('services: stop on clear — clearing the pane stops the child', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  trust(ctx, CLOCK_SERVICE, 'clock');
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/clock/use', { id: 'm1' });
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'spawned');

  await api.post('/api/clear', { id: 'm1' });
  assert.ok(await waitUntil(() => !children(ctx).has('m1')), 'child stopped on clear');
});

test('services: graph-aware — stops on navigate-away, respawns on navigate-back', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  trust(ctx, CLOCK_SERVICE, 'clock');
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  // Put the service pane on the surface and commit it as a node.
  await api.post('/api/components/clock/use', { id: 'm1' });
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'spawned on the live surface');
  const committed = await api.post('/api/commit', { message: 'has-service' });
  const nodeA = committed.json.node_id;
  assert.ok(nodeA, 'committed a node containing the service pane');

  // Navigate away to a fresh (empty) graph — active becomes null, mounts cleared.
  await api.post('/api/graph/new', {});
  assert.ok(await waitUntil(() => !children(ctx).has('m1')), 'child stopped when its pane left the active surface');

  // Navigate back to the node that contains the pane — it should respawn.
  const back = await api.post('/api/graph/active', { id: nodeA });
  assert.equal(back.json.ok, true);
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'child respawned on navigate-back');
});

test('services: last-viewer disconnect stops children; reconnect respawns', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  trust(ctx, CLOCK_SERVICE, 'clock');

  const v1 = await openViewer(ctx);
  await api.post('/api/components/clock/use', { id: 'm1' });
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'spawned with a viewer present');

  await new Promise((r) => { v1.sock.on('close', r); v1.sock.close(); });
  assert.ok(await waitUntil(() => !children(ctx).has('m1')), 'stopped when the last viewer left');

  const v2 = await openViewer(ctx);
  t.after(() => { try { v2.sock.close(); } catch {} });
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'respawned when a viewer reconnected');
});

test('services: trust gate blocks first spawn; approval unblocks it', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  // NOTE: no trust seeded.
  const { sock, frames } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/clock/use', { id: 'm1' });

  // No child, but a trust prompt was broadcast to the viewer. It must be its OWN
  // frame type — NOT a `render`. A render carried a `target`, and the client
  // resolves an unknown target with `$(target) || $('main')`; the old code sent
  // target:'overlay', which is a real element (the graph viewer, display:none),
  // so the prompt was invisible and no service could ever be approved.
  const prompt = await waitUntil(
    () => frames.find((f) => f.type === 'service:trust' && f.hash === hashOf(CLOCK_SERVICE)),
    { timeout: 4000 },
  );
  assert.ok(prompt, 'trust prompt broadcast on its own frame type');
  assert.equal(prompt.name, 'clock');
  assert.ok(prompt.nonce, 'prompt carries a nonce');
  assert.ok(!frames.some((f) => f.type === 'render' && String(f.id).startsWith('wc-service-approve')),
    'trust prompt is never a mount (a pane target could hide it)');
  await sleep(300);
  assert.equal(children(ctx).has('m1'), false, 'trust gate blocked the spawn');

  // A store write must NOT be able to approve — any pane can write the store, so
  // the old control-key path let a component approve its own service.js.
  sock.send(JSON.stringify({ type: 'store:set', patch: { wc_service_approval: { seq: 2, hash: hashOf(CLOCK_SERVICE), name: 'clock', decision: 'approve' } } }));
  await sleep(400);
  assert.equal(children(ctx).has('m1'), false, 'a store key cannot grant host execution');

  // Nor may a decision frame carrying the wrong nonce.
  sock.send(JSON.stringify({ type: 'service:decision', hash: hashOf(CLOCK_SERVICE), decision: 'approve', nonce: 'not-the-nonce' }));
  await sleep(400);
  assert.equal(children(ctx).has('m1'), false, 'a forged nonce cannot grant host execution');

  // The real path: the chrome modal returns the server-issued nonce.
  sock.send(JSON.stringify({ type: 'service:decision', hash: hashOf(CLOCK_SERVICE), decision: 'approve', nonce: prompt.nonce }));

  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'child spawns after approval');
  // approval was persisted to trusted.json
  const trusted = JSON.parse(fs.readFileSync(trustedPath(ctx), 'utf8'));
  assert.ok(trusted[hashOf(CLOCK_SERVICE)], 'approval persisted (content-hash keyed)');
  assert.ok(!fs.existsSync(path.join(ctx.webChatDir, 'services', 'trusted.json')),
    'consent is never written inside the project — a repo could otherwise ship it');
});

test('services: a denied service stays denied across viewers', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  const v1 = await openViewer(ctx);
  t.after(() => { try { v1.sock.close(); } catch {} });
  await api.post('/api/components/clock/use', { id: 'm1' });

  const first = await waitUntil(() => v1.frames.find((f) => f.type === 'service:trust'), { timeout: 4000 });
  assert.ok(first, 'prompted on first use');
  v1.sock.send(JSON.stringify({ type: 'service:decision', hash: first.hash, decision: 'deny', nonce: first.nonce }));
  await sleep(400);
  assert.equal(children(ctx).has('m1'), false, 'denied service does not run');

  // Deny is sticky for the life of the daemon — a reconnect must not re-ask and
  // must not run it.
  v1.sock.close();
  await sleep(300);
  const v2 = await openViewer(ctx);
  t.after(() => { try { v2.sock.close(); } catch {} });
  await api.post('/api/render', { id: 'noop', html: '<p>noop</p>' });
  await sleep(600);
  assert.equal(v2.frames.some((f) => f.type === 'service:trust'), false, 'a denied hash is not re-prompted');
  assert.equal(children(ctx).has('m1'), false, 'still not running');
});

test('services: an UNDECIDED prompt is re-issued after the last viewer leaves', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  const v1 = await openViewer(ctx);
  await api.post('/api/components/clock/use', { id: 'm1' });
  assert.ok(await waitUntil(() => v1.frames.find((f) => f.type === 'service:trust'), { timeout: 4000 }), 'prompted');

  // The user refreshes instead of answering. The prompt lived only in that
  // browser, so it died with the socket — and the supervisor's `prompted` memo
  // used to keep the hash forever, leaving the service permanently unpromptable:
  // the pane just waited with no prompt and no error, for the life of the daemon.
  v1.sock.close();
  await sleep(400);
  const v2 = await openViewer(ctx);
  t.after(() => { try { v2.sock.close(); } catch {} });
  await api.post('/api/render', { id: 'noop', html: '<p>noop</p>' });
  assert.ok(await waitUntil(() => v2.frames.some((f) => f.type === 'service:trust'), { timeout: 4000 }),
    're-prompted for the fresh viewer');
});

test('services: a crashing service is recorded and not respawned', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'crasher', source: '<p>x</p>', description: 'x', service: CRASH_SERVICE });
  trust(ctx, CRASH_SERVICE, 'crasher');
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/crasher/use', { id: 'm1' });

  // It spawns, crashes, is removed, and does not come back.
  assert.ok(await waitUntil(() => !children(ctx).has('m1'), { timeout: 4000 }), 'crashed child removed');
  // Nudge another reconcile; it must stay dead (failed set blocks respawn of this hash).
  await api.post('/api/render', { id: 'noop', html: '<p>noop</p>' });
  await sleep(400);
  assert.equal(children(ctx).has('m1'), false, 'not respawned after crash');
});

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

// Approve (or deny) exactly the way `claude-web-chat trust` does: read the
// pending request from the daemon, then WRITE THE USER-TIER TRUST FILE. The
// browser is deliberately not part of this path — pane scripts share the page's
// realm and origin, so nothing sent to the page can gate the code being gated.
// Using the server-reported `key` rather than re-deriving it keeps the test on
// the real contract, and is what the CLI itself does.
function trustedPath(ctx) {
  return path.join(ctx.userWebChat, 'services', 'trusted.json');
}

async function pendingFor(ctx, name) {
  const { pending } = (await ctx.api.get('/api/services/pending')).json;
  return pending.filter((p) => p.name === name);
}

async function approve(ctx, name, { deny = false } = {}) {
  const match = await waitUntil(async () => {
    const p = await pendingFor(ctx, name);
    return p.length ? p : false;
  }, { timeout: 4000 });
  assert.ok(match, `expected a pending trust request for "${name}"`);
  const file = trustedPath(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const p of match) {
    data[p.key] = { name: p.name, hash: p.hash, root: p.root, params: p.params, approved: !deny, approved_at: 1 };
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  await ctx.api.post('/api/services/refresh-trust', {});
  return match;
}

// Mount a service-backed component and approve it — the ordinary first-run flow.
async function useApproved(ctx, name, id, params) {
  await ctx.api.post(`/api/components/${name}/use`, params ? { id, params } : { id });
  await approve(ctx, name);
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
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await useApproved(ctx, 'clock', 'm1');

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
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await useApproved(ctx, 'clock', 'm1');
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'spawned');

  await api.post('/api/clear', { id: 'm1' });
  assert.ok(await waitUntil(() => !children(ctx).has('m1')), 'child stopped on clear');
});

test('services: graph-aware — stops on navigate-away, respawns on navigate-back', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  // Put the service pane on the surface and commit it as a node.
  await useApproved(ctx, 'clock', 'm1');
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
  const v1 = await openViewer(ctx);
  await useApproved(ctx, 'clock', 'm1');
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'spawned with a viewer present');

  await new Promise((r) => { v1.sock.on('close', r); v1.sock.close(); });
  assert.ok(await waitUntil(() => !children(ctx).has('m1')), 'stopped when the last viewer left');

  const v2 = await openViewer(ctx);
  t.after(() => { try { v2.sock.close(); } catch {} });
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'respawned when a viewer reconnected');
});

test('services: trust gate blocks the spawn, and ONLY a filesystem write unblocks it', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  // NOTE: no trust seeded.
  const { sock, frames } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await api.post('/api/components/clock/use', { id: 'm1' });

  // The browser is TOLD about the request, but is given nothing that could grant
  // it. Pane scripts run in the page's own realm with document/fetch/WebSocket
  // and no CSP, so anything sent here — a nonce, a token — is readable by the
  // very code being gated. The frame is informational: a name and a command.
  const prompt = await waitUntil(
    () => frames.find((f) => f.type === 'service:trust' && f.hash === hashOf(CLOCK_SERVICE)),
    { timeout: 4000 },
  );
  assert.ok(prompt, 'the viewer is told a service is waiting');
  assert.match(prompt.command, /claude-web-chat trust clock/, 'it names the terminal command');
  assert.equal(prompt.nonce, undefined, 'no capability is shipped to the page');
  assert.ok(!frames.some((f) => f.type === 'render' && String(f.id).startsWith('wc-service-approve')),
    'the notice is never a mount — a pane target could hide it');
  await sleep(300);
  assert.equal(children(ctx).has('m1'), false, 'trust gate blocked the spawn');

  // Every in-page route a hostile pane could take must be a no-op.
  sock.send(JSON.stringify({ type: 'store:set', patch: { wc_service_approval: { hash: hashOf(CLOCK_SERVICE), name: 'clock', decision: 'approve' } } }));
  sock.send(JSON.stringify({ type: 'service:decision', hash: hashOf(CLOCK_SERVICE), decision: 'approve', nonce: 'anything' }));
  await sleep(500);
  assert.equal(children(ctx).has('m1'), false, 'nothing sent from the page can grant host execution');

  // The real path: the CLI writes the user-tier trust file.
  await approve(ctx, 'clock');

  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'child spawns once consent is on disk');
  assert.ok(!fs.existsSync(path.join(ctx.webChatDir, 'services', 'trusted.json')),
    'consent is never written inside the project — a repo could otherwise ship it');
});

test('services: approving one params shape does not approve another', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  // Approve the no-params form only.
  await useApproved(ctx, 'clock', 'm1');
  assert.ok(await waitUntil(() => children(ctx).has('m1')), 'the approved shape runs');
  await api.post('/api/clear', { id: 'm1' });
  await sleep(300);

  // Spawning with params is a DIFFERENT request. This is what stops an approval
  // of `file-editor` (fenced to the project) silently covering `unfenced:true`.
  await api.post('/api/components/clock/use', { id: 'm2', params: { unfenced: true } });
  await sleep(600);
  assert.equal(children(ctx).has('m2'), false, 'different params re-ask rather than inherit the grant');

  const pending = (await api.get('/api/services/pending')).json.pending;
  assert.ok(pending.some((p) => p.name === 'clock' && p.params && p.params.unfenced === true),
    'the pending request reports the params the user is being asked about');
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
  // `claude-web-chat trust clock --deny` records the refusal on disk.
  await approve(ctx, 'clock', { deny: true });
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
  assert.equal(v2.frames.some((f) => f.type === 'service:trust'), false, 'a denied request is not re-prompted');
  assert.equal(children(ctx).has('m1'), false, 'still not running');
});

test('services: an UNDECIDED prompt is re-announced to every arriving viewer', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'clock', source: '<p>c</p>', description: 'c', service: CLOCK_SERVICE });
  const v1 = await openViewer(ctx);
  await api.post('/api/components/clock/use', { id: 'm1' });
  assert.ok(await waitUntil(() => v1.frames.find((f) => f.type === 'service:trust'), { timeout: 4000 }), 'prompted');

  // A SECOND viewer arrives while the first is still connected, so the viewer
  // count never touches zero. Re-announcing only on a zero transition was not
  // enough: with another tab open — or a half-open socket the 30s heartbeat has
  // not yet reaped — a refreshing user would see the pane sitting there with no
  // explanation at all.
  const v2 = await openViewer(ctx);
  t.after(() => { try { v2.sock.close(); } catch {} });
  t.after(() => { try { v1.sock.close(); } catch {} });
  assert.ok(await waitUntil(() => v2.frames.some((f) => f.type === 'service:trust'), { timeout: 4000 }),
    're-announced to the arriving viewer even though a viewer was already connected');
});

test('services: a crashing service is recorded and not respawned', async (t) => {
  const ctx = await withServer(t);
  const { api } = ctx;
  await api.post('/api/components', { name: 'crasher', source: '<p>x</p>', description: 'x', service: CRASH_SERVICE });
  const { sock } = await openViewer(ctx);
  t.after(() => { try { sock.close(); } catch {} });

  await useApproved(ctx, 'crasher', 'm1');

  // It spawns, crashes, is removed, and does not come back.
  assert.ok(await waitUntil(() => !children(ctx).has('m1'), { timeout: 4000 }), 'crashed child removed');
  // Nudge another reconcile; it must stay dead (failed set blocks respawn of this hash).
  await api.post('/api/render', { id: 'noop', html: '<p>noop</p>' });
  await sleep(400);
  assert.equal(children(ctx).has('m1'), false, 'not respawned after crash');
});

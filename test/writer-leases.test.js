// Writer identity, the service and driver classes (PLAN 1B.4; DECISIONS A1;
// unit U214b): a per-child writer token the supervisor hands each service over
// IPC and revokes when it ends; the driver lease (POST/DELETE
// /api/writers/lease), one owner per live driver INSTANCE (ruling
// U214b@lease-scope: two drivers in one process collide, and a starting service
// revokes a lease on its name); and the gate, which refuses an unproven
// `service:`/`pane:` owner and lets a credential's owner replace the body's.
//
// F9 S-9 part 2 is the measured case: two createDriver({owner:'git-dashboard'})
// instances in ONE process used to replace each other's panes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { withServer, waitUntil: harnessWaitUntil } = require('../test-support/helpers');
const client = require('../lib/client');
const { createDriver, guardDriver } = require('../lib/driver');
const { WRITER_HEADER } = require('../lib/core/writer-token');
const { REMOTE_HEADER, REMOTE_HEADER_VALUE } = require('../lib/core/cors');
const { createWriters, isLeasableOwner } = require('../lib/server/domain/writers');

const LEASE = '/api/writers/lease';
const REMOTE = { [REMOTE_HEADER]: REMOTE_HEADER_VALUE };
const BROWSER = { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' };
// Forked children start, write and exit an order of magnitude slower than the
// in-process work the harness default is sized for (as services-supervisor).
const waitUntil = (fn, opts) => harnessWaitUntil(fn, { timeout: 4000, interval: 40, ...opts });

const leaseReq = (port, owner, pid = process.pid, headers) => client.request(port, 'POST', LEASE, { owner, pid }, headers ? { headers } : {});
const withToken = (tok) => ({ headers: { [WRITER_HEADER]: tok } });
const mountsOf = async (api) => Object.fromEntries((await api.get('/api/mounts')).json.mounts.map((m) => [m.id, m]));

// ── the domain ──────────────────────────────────────────────────────────────

test('domain: leasable owners are service:<kebab> only', () => {
  for (const ok of ['service:git-dashboard', 'service:x', 'service:a1-b2']) assert.equal(isLeasableOwner(ok), true, ok);
  for (const bad of ['claude', 'user', 'remote', 'pane:x', 'foo', 'service:', 'service:Git', 'service:a b', 'service:-x', null, 7]) {
    assert.equal(isLeasableOwner(bad), false, String(bad));
  }
});

test('domain: a credential resolves verified to its owner; revoked or released it is stale', (t) => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-leases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.web-chat'));
  const { projectPaths } = require('../lib/core/paths');
  const alive = new Set([process.pid]);
  const writers = createWriters({
    paths: projectPaths(root), audience: { peerOf: () => 'local' }, pidAlive: (pid) => alive.has(pid),
  });
  const req = (tok) => ({ headers: { [WRITER_HEADER.toLowerCase()]: tok }, socket: { remoteAddress: '127.0.0.1' } });

  const svc = writers.mintService({ mountId: 'm1', name: 'git-dashboard' });
  assert.deepEqual(writers.resolveWriter(req(svc), { owner: 'service:other' }), { class: 'service', owner: 'service:git-dashboard', verified: true });
  assert.deepEqual(writers.lease({ owner: 'service:git-dashboard', pid: process.pid }),
    { ok: false, refused: 'owner_taken', owner: 'service:git-dashboard', holder: 'service' }, 'a running service holds its name');
  assert.equal(writers.release(svc), false, 'release never gives up a service token');
  assert.equal(writers.revoke(svc), true);
  assert.deepEqual(writers.resolveWriter(req(svc), {}), { stale: true });

  const l = writers.lease({ owner: 'service:git-dashboard', pid: process.pid });
  assert.equal(l.ok, true);
  assert.deepEqual(writers.resolveWriter(req(l.token), {}), { class: 'driver', owner: 'service:git-dashboard', verified: true });
  assert.equal(writers.lease({ owner: 'service:git-dashboard', pid: process.pid }).refused, 'owner_taken', 'the same pid collides');
  alive.delete(process.pid);
  const reaped = writers.lease({ owner: 'service:git-dashboard', pid: 4242 });
  assert.equal(reaped.ok, true, 'a dead holder is reaped by the next request');
  assert.deepEqual(writers.resolveWriter(req(l.token), {}), { stale: true });

  // A starting service revokes the lease on its name.
  writers.mintService({ mountId: 'm2', name: 'git-dashboard' });
  assert.deepEqual(writers.resolveWriter(req(reaped.token), {}), { stale: true });

  assert.equal(writers.lease({ owner: 'service:x', pid: 0 }).refused, 'bad_pid');
  assert.throws(() => writers.mintService({ mountId: 'm', name: 'Not A Name' }), TypeError);
  const l2 = writers.lease({ owner: 'service:y', pid: 4242 });
  writers.stop();
  assert.deepEqual(writers.resolveWriter(req(l2.token), {}), { stale: true }, 'after stop every credential is stale');
});

// ── the lease routes ────────────────────────────────────────────────────────

test('lease: 200 with a token; the same pid again 409; after DELETE the second succeeds', async (t) => {
  const { port } = await withServer(t);
  const first = await leaseReq(port, 'service:git-dashboard');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.owner, 'service:git-dashboard');
  assert.match(first.body.token, /^[0-9a-f]{64}$/);

  const second = await leaseReq(port, 'service:git-dashboard');
  assert.equal(second.status, 409);
  assert.deepEqual([second.body.ok, second.body.refused, second.body.owner], [false, 'owner_taken', 'service:git-dashboard']);
  assert.match(second.body.hint, /release/);

  // The typed client throws the 409 as an HttpError carrying the body.
  await assert.rejects(client.post(LEASE, { owner: 'service:git-dashboard', pid: process.pid }, { port }),
    (e) => e.status === 409 && e.body.refused === 'owner_taken');

  const none = await client.request(port, 'DELETE', LEASE, null);
  assert.deepEqual(none.body, { ok: true, released: false }, 'no token releases nothing');
  const rel = await client.request(port, 'DELETE', LEASE, null, withToken(first.body.token));
  assert.equal(rel.status, 200);
  assert.deepEqual(rel.body, { ok: true, released: true });
  const again = await client.request(port, 'DELETE', LEASE, null, withToken(first.body.token));
  assert.deepEqual(again.body, { ok: true, released: false }, 'a second release is a no-op');

  const third = await leaseReq(port, 'service:git-dashboard');
  assert.equal(third.status, 200);
  assert.notEqual(third.body.token, first.body.token);
});

test('lease: a holder whose pid is dead is reaped and the owner leased again', async (t) => {
  const { port } = await withServer(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((r) => child.once('exit', r));
  const dead = await leaseReq(port, 'service:reaped', pid);
  assert.equal(dead.status, 200, 'the lease names whatever pid it is given');
  const next = await leaseReq(port, 'service:reaped');
  assert.equal(next.status, 200, `the dead holder is reaped: ${JSON.stringify(next.body)}`);
  // The reaped token claims nothing now.
  const r = await client.request(port, 'POST', '/api/render', { id: 'x', html: '<p>x</p>' }, withToken(dead.body.token));
  assert.equal(r.status, 401);
  assert.equal(r.body.writer, 'stale');
});

test('lease: claude, pane:x, foo and a bad pid are 400; a browser or the portal is 403', async (t) => {
  const { port, anonApi } = await withServer(t);
  for (const owner of ['claude', 'pane:x', 'foo', 'user', 'remote', 'service:Git', undefined]) {
    const r = await leaseReq(port, owner);
    assert.equal(r.status, 400, `${owner} → ${r.status}`);
    assert.equal(r.body.refused, 'bad_owner');
  }
  const pid = await client.request(port, 'POST', LEASE, { owner: 'service:x', pid: 'me' });
  assert.equal(pid.status, 400);
  assert.equal(pid.body.refused, 'bad_pid');

  const browser = await leaseReq(port, 'service:x', process.pid, BROWSER);
  assert.equal(browser.status, 403);
  const fetched = await anonApi.post(LEASE, { owner: 'service:x', pid: process.pid });
  assert.equal(fetched.status, 403, "Node's fetch carries fetch metadata: a browser to the daemon");
  const remote = await leaseReq(port, 'service:x', process.pid, REMOTE);
  assert.equal(remote.status, 403);
  const del = await client.request(port, 'DELETE', LEASE, null, { headers: REMOTE });
  assert.equal(del.status, 403);
  // None of those took the owner.
  assert.equal((await leaseReq(port, 'service:x')).status, 200);
});

// ── F9 S-9 part 2: two drivers, one owner, one process ─────────────────────

test('S-9 part 2: two drivers on one owner in one process — the second is refused until the first releases', async (t) => {
  const { port, api } = await withServer(t);
  const first = createDriver({ owner: 'git-dashboard', port });
  const second = createDriver({ owner: 'git-dashboard', port });

  const r1 = await first.render({ id: 'g1', html: '<p>first</p>' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.owner, 'service:git-dashboard');

  for (const id of ['g1', 'g2']) {
    const r = await second.render({ id, html: '<p>second</p>' });
    assert.equal(r.ok, false, `${id}: ${JSON.stringify(r)}`);
    assert.equal(r.rejected, true);
    assert.equal(r.owner_taken, true);
    assert.equal(r.owner, 'service:git-dashboard');
    assert.equal(typeof r.hint, 'string');
  }
  for (const r of [await second.writeMarkdown({ id: 'g-h', text: '# x' }), await second.clear({ id: 'g1' })]) {
    assert.equal(r.owner_taken, true, 'markdown and clear are refused alike');
  }
  const rendersOf = async (id) => (await api.get('/api/events?since=0')).json.events.filter((e) => e.kind === 'render' && e.id === id).length;
  let mounts = await mountsOf(api);
  assert.equal(await rendersOf('g1'), 1, 'g1 is unchanged: rendered once, by the first');
  assert.equal(mounts.g2, undefined);

  assert.deepEqual(await first.release(), { ok: true, released: true });
  const r2 = await second.render({ id: 'g1', html: '<p>second</p>' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  mounts = await mountsOf(api);
  assert.equal(await rendersOf('g1'), 2);
  assert.equal(mounts.g1.owner, 'service:git-dashboard');

  // The first, having released, now collides with the second.
  assert.equal((await first.render({ id: 'g1', html: '<p>back</p>' })).owner_taken, true);
  assert.deepEqual(await first.release(), { ok: true, released: false }, 'nothing held, nothing released');
});

// ── services: the per-child token ───────────────────────────────────────────

const RENDER_SERVICE = `
module.exports = {
  async start(ctx) {
    const r = await ctx.driver.render({ id: 'svc-out', html: '<p>from the service</p>', owner: 'service:someone-else' });
    await ctx.driver.setStore({ svc_render: { mount: ctx.mountId, ok: r.ok, owner: r.owner } });
  },
  async stop() {},
};`;

async function approve(ctx, name) {
  const match = await waitUntil(async () => {
    const { pending } = (await ctx.api.get('/api/services/pending')).json;
    const p = pending.filter((x) => x.name === name);
    return p.length ? p : false;
  });
  assert.ok(match, `expected a pending trust request for "${name}"`);
  const file = path.join(ctx.userWebChat, 'services', 'trusted.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const p of match) data[p.key] = { name: p.name, hash: p.hash, root: p.root, params: p.params, approved: true, approved_at: 1 };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  await ctx.api.post('/api/services/refresh-trust', {});
}

// A viewer socket held open (a service runs only while a browser watches).
function viewer(t, ctx) {
  return new Promise((resolve, reject) => {
    const sock = ctx.ws();
    t.after(() => { try { sock.close(); } catch {} });
    sock.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (msg && msg.type === 'hello') resolve(sock);
    });
    sock.on('error', reject);
  });
}

test('services: a child writes under its IPC token as service:<name>; stopped, the token is stale', async (t) => {
  const ctx = await withServer(t);
  const { api, port } = ctx;
  await api.post('/api/components', { name: 'lease-svc', source: '<p>s</p>', description: 's', service: RENDER_SERVICE });
  await viewer(t, ctx);
  await api.post('/api/components/lease-svc/use', { id: 'm1' });
  await approve(ctx, 'lease-svc');

  const done = await waitUntil(async () => (await api.get('/api/store')).json.svc_render);
  assert.ok(done, 'the service rendered');
  assert.deepEqual(done, { mount: 'm1', ok: true, owner: 'service:lease-svc' }, 'the credential\'s owner replaced the body\'s');
  assert.equal((await mountsOf(api))['svc-out'].owner, 'service:lease-svc');

  const entry = ctx.srv.services._children.get('m1');
  const tok = entry && entry.writerToken;
  assert.match(tok || '', /^[0-9a-f]{64}$/, 'the supervisor holds the child\'s token');

  const taken = await leaseReq(port, 'service:lease-svc');
  assert.equal(taken.status, 409, 'a running service holds its name');
  assert.match(taken.body.hint, /service/);

  await api.post('/api/clear', { id: 'm1' });
  assert.ok(await waitUntil(() => !ctx.srv.services._children.has('m1')), 'child stopped');
  const stale = await client.request(port, 'POST', '/api/render', { id: 'svc-out', html: '<p>late</p>' }, withToken(tok));
  assert.equal(stale.status, 401);
  assert.equal(stale.body.writer, 'stale');
  assert.equal((await leaseReq(port, 'service:lease-svc')).status, 200, 'and the name is free again');
});

// A child that ends on its own (a crash, not a requested stop) goes through
// onChildExit, not stopChild: its token must die there too.
const EXIT_SERVICE = `
module.exports = {
  async start(ctx) {
    await ctx.driver.setStore({ exit_ready: { mount: ctx.mountId } });
    setInterval(async () => {
      try { const s = await ctx.driver.getStore(['exit_now']); if (s && s.exit_now) process.exit(3); } catch {}
    }, 50);
  },
  async stop() {},
};`;

test('services: a child that exits on its own takes its token with it', async (t) => {
  const ctx = await withServer(t);
  const { api, port } = ctx;
  await api.post('/api/components', { name: 'exit-svc', source: '<p>s</p>', description: 's', service: EXIT_SERVICE });
  await viewer(t, ctx);
  await api.post('/api/components/exit-svc/use', { id: 'm1' });
  await approve(ctx, 'exit-svc');
  assert.ok(await waitUntil(async () => (await api.get('/api/store')).json.exit_ready), 'the service started');

  const tok = ctx.srv.services._children.get('m1').writerToken;
  const live = await client.request(port, 'POST', '/api/render', { id: 'exit-out', html: '<p>live</p>' }, withToken(tok));
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.equal(live.body.owner, 'service:exit-svc');

  await api.post('/api/store', { patch: { exit_now: true } });
  assert.ok(await waitUntil(() => !ctx.srv.services._children.has('m1')), 'the child exited');
  const stale = await client.request(port, 'POST', '/api/render', { id: 'exit-out', html: '<p>late</p>' }, withToken(tok));
  assert.equal(stale.status, 401, 'the exit revoked the token');
  assert.equal(stale.body.writer, 'stale');
  assert.equal((await leaseReq(port, 'service:exit-svc')).status, 200, 'and the name is free again');
});

test('services: a child starting while a lease holds its name revokes the lease', async (t) => {
  const ctx = await withServer(t);
  const { api, port } = ctx;
  const held = await leaseReq(port, 'service:lease-svc');
  assert.equal(held.status, 200);
  const before = await client.request(port, 'POST', '/api/render', { id: 'drv', html: '<p>d</p>' }, withToken(held.body.token));
  assert.equal(before.status, 200);

  await api.post('/api/components', { name: 'lease-svc', source: '<p>s</p>', description: 's', service: RENDER_SERVICE });
  await viewer(t, ctx);
  await api.post('/api/components/lease-svc/use', { id: 'm1' });
  await approve(ctx, 'lease-svc');
  assert.ok(await waitUntil(async () => (await api.get('/api/store')).json.svc_render), 'the service started');

  const after = await client.request(port, 'POST', '/api/render', { id: 'drv', html: '<p>d2</p>' }, withToken(held.body.token));
  assert.equal(after.status, 401, 'the trust approval outranks the lease');
  assert.equal(after.body.writer, 'stale');
});

// ── the gate ────────────────────────────────────────────────────────────────

test('gate: an unproven service: owner is 403 unverified — under Claude\'s token and tokenless', async (t) => {
  const { api, port } = await withServer(t);
  const claude = await api.post('/api/render', { id: 's', html: '<p>s</p>', owner: 'service:x' });
  assert.equal(claude.status, 403);
  assert.deepEqual([claude.json.ok, claude.json.writer, claude.json.owner], [false, 'unverified', 'service:x']);
  assert.match(claude.json.hint, /createDriver/);

  const local = await client.request(port, 'POST', '/api/render', { id: 's', html: '<p>s</p>', owner: 'service:x' });
  assert.equal(local.status, 403);
  assert.equal(local.body.writer, 'unverified');

  for (const [route, body] of [['/api/markdown', { id: 'h', text: '# h', owner: 'service:x' }], ['/api/clear', { id: 's', owner: 'service:x' }]]) {
    assert.equal((await api.post(route, body)).status, 403, route);
    assert.equal((await client.request(port, 'POST', route, body)).status, 403, `${route} tokenless`);
  }
  assert.deepEqual(await mountsOf(api), {}, 'nothing landed');
});

test('gate: a pane: owner on render, markdown or clear is 403 from anyone', async (t) => {
  const { api, port } = await withServer(t);
  const drv = await leaseReq(port, 'service:x');
  const bodies = [
    ['/api/render', { id: 'p', html: '<p>p</p>', owner: 'pane:p1' }],
    ['/api/markdown', { id: 'h', text: '# h', owner: 'pane:p1' }],
    ['/api/clear', { id: 'p', owner: 'pane:p1' }],
  ];
  for (const [route, body] of bodies) {
    const claude = await api.post(route, body);
    assert.equal(claude.status, 403, `${route} under Claude's token`);
    assert.equal(claude.json.writer, 'unverified');
    assert.match(claude.json.hint, /spawn/);
    assert.equal((await client.request(port, 'POST', route, body)).status, 403, `${route} tokenless`);
  }
  // A credential's owner replaces even a pane: claim — it is the lease's.
  const asDriver = await client.request(port, 'POST', '/api/render', bodies[0][1], withToken(drv.body.token));
  assert.equal(asDriver.status, 200);
  assert.equal(asDriver.body.owner, 'service:x');
});

test('gate: a lease token with body owner service:other writes as the lease\'s owner', async (t) => {
  const { api, port } = await withServer(t);
  const l = await leaseReq(port, 'service:mine');
  const r = await client.request(port, 'POST', '/api/render', { id: 'p', html: '<p>p</p>', owner: 'service:other' }, withToken(l.body.token));
  assert.equal(r.status, 200);
  assert.equal(r.body.owner, 'service:mine');
  const md = await client.request(port, 'POST', '/api/markdown', { id: 'h', text: '# h', owner: 'claude' }, withToken(l.body.token));
  assert.equal(md.body.owner, 'service:mine');
  const m = await mountsOf(api);
  assert.equal(m.p.owner, 'service:mine');
  // A clear under the lease is the lease owner's: its own pane goes without force.
  const c = await client.request(port, 'POST', '/api/clear', { id: 'p', owner: 'service:other' }, withToken(l.body.token));
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
});

// ── the driver ──────────────────────────────────────────────────────────────

test('driver: createDriver stays synchronous — nothing is requested until the first call', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const d = createDriver({ owner: 'sync-check', port: server.address().port });
  assert.equal(typeof d.render, 'function');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [], 'no lease, no request');
  await d.getStore();
  assert.deepEqual(seen, ['GET /api/store'], 'a read never leases');
  assert.equal(typeof guardDriver(d).release, 'function', 'guardDriver wraps release');
});

test('driver: concurrent first writes share one lease request', async (t) => {
  const { port, api } = await withServer(t);
  const d = createDriver({ owner: 'burst', port });
  const rs = await Promise.all([1, 2, 3, 4].map((n) => d.render({ id: `b${n}`, html: `<p>${n}</p>` })));
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true, true], JSON.stringify(rs));
  assert.equal(Object.keys(await mountsOf(api)).length, 4);
});

test('driver: a 401 stale after a daemon restart in the same root re-leases once and the write succeeds', async (t) => {
  const first = await withServer(t);
  const { root } = first;
  // The driver's port is fixed at creation; a forwarding listener keeps it
  // fixed across the restart (the daemon itself comes back on a new port).
  let target = first.port;
  const proxy = http.createServer((req, res) => {
    client.pipe(target, { method: req.method, path: req.url, headers: req.headers }, req)
      .then((up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }, () => { res.statusCode = 502; res.end(); });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => proxy.close(r)));

  const d = createDriver({ owner: 'restart', port: proxy.address().port });
  assert.equal((await d.render({ id: 'r1', html: '<p>1</p>' })).ok, true);
  await first.stop();

  const second = await withServer(t, { root });
  target = second.port;
  const r = await d.render({ id: 'r2', html: '<p>2</p>' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.owner, 'service:restart');
  // Exactly one lease is held now: a second driver on the owner collides.
  const other = createDriver({ owner: 'restart', port: proxy.address().port });
  assert.equal((await other.render({ id: 'r3', html: '<p>3</p>' })).owner_taken, true);
});

test('driver: a service driver (writerToken) sends it on every call and never leases', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([`${req.method} ${req.url}`, req.headers[WRITER_HEADER.toLowerCase()] || null]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const d = createDriver({ owner: 'service:svc', port: server.address().port, writerToken: 'a'.repeat(64) });
  await d.render({ id: 'x', html: '<p>x</p>' });
  await d.setStore({ k: 1 });
  await d.clear({ id: 'x' });
  assert.deepEqual(await d.release(), { ok: true, released: false });
  assert.deepEqual(seen, [
    ['POST /api/render', 'a'.repeat(64)],
    ['POST /api/store', 'a'.repeat(64)],
    ['POST /api/clear', 'a'.repeat(64)],
  ]);
});

// GT-15's enforcement prerequisites (unit U355; plan.json 2E.4; results/
// gate-t1-exit.md C-15-1..3; DECISIONS I.3 D2):
//   (1) the writer token follows the live daemon — createWriters'
//       `writeAtConstruction: false` and publishToken(), createServer's
//       `tokenAtClaim` (the token written right after the portfile claim);
//       the instance guard's `syncToken` cases are in test/instance-guard.test.js;
//   (2) the MCP client's tokenless retry is gone: a token still stale after its
//       one re-read fails with the daemon's 401 and hint, and no tokenless
//       request ever goes out after a refused token (ruling
//       U214a@stale-token-fallback); the first call of a process that finds no
//       token file still goes out tokenless (ruling U355@no-token-first-call;
//       test/writers.test.js pins that one);
//   (3) the lease and service tokens are known to the redactor while live
//       (redactor.removeKnown takes each out when it is dropped), and none is
//       served;
//   plus F9 S-9's credentialed classes forged six ways: 0/6 accepted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const { withServer, withTempHome, tmpRoot, waitUntil } = require('../test-support/helpers');
const client = require('../lib/client');
const { createServer } = require('../lib/server');
const { WRITER_HEADER, mintToken, writeWriterToken, readWriterToken } = require('../lib/core/writer-token');
const { projectPaths } = require('../lib/core/paths');
const { createRedactor, MASK } = require('../lib/core/redact');
const { createAudience } = require('../lib/server/audience');
const { createWriters } = require('../lib/server/domain/writers');
const { PROTOCOL_VERSION } = require('../lib/core/versions');
const { LISTEN_HOST } = require('../lib/core/cors');

const LEASE = '/api/writers/lease';
const withToken = (tok) => ({ headers: { [WRITER_HEADER]: tok } });
const reqOf = (headers = {}) => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  socket: { remoteAddress: '127.0.0.1' },
});

// A writers domain on a fresh root (with its .web-chat/ unless mkdir: false).
function domain(t, { mkdir = true, root = null, ...opts } = {}) {
  const r = root || (mkdir ? tmpRoot() : fs.mkdtempSync(path.join(os.tmpdir(), 'wc-nodir-')));
  if (!root) t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  const redactor = opts.redactor || createRedactor();
  const lines = [];
  const writers = createWriters({
    paths: projectPaths(r), state: { mounts: new Map() }, redactor,
    audience: createAudience({ root: r, configFile: null }), log: (m) => lines.push(m), ...opts,
  });
  t.after(() => writers.stop());
  return { root: r, writers, redactor, lines, file: projectPaths(r).writerToken };
}

// The boot token a domain holds, learned without an accessor: the one 64-hex
// value resolveWriter answers verified claude for, i.e. what publishToken
// wrote.
function publishedToken(d) {
  const tok = readWriterToken(d.root);
  assert.ok(tok, 'a token file');
  assert.deepEqual(d.writers.resolveWriter(reqOf({ [WRITER_HEADER]: tok }), {}), { class: 'claude', owner: 'claude', verified: true });
  return tok;
}

// ── (1) publishToken ────────────────────────────────────────────────────────

test('writeAtConstruction: false writes no file until publishToken(), which writes it 0600 and never answers the token', (t) => {
  const d = domain(t, { writeAtConstruction: false });
  assert.equal(fs.existsSync(d.file), false, 'nothing written at construction');
  const r = d.writers.publishToken();
  assert.deepEqual(r, { written: true, reason: 'absent' });
  assert.equal(fs.statSync(d.file).mode & 0o777, 0o600);
  const tok = publishedToken(d);
  assert.ok(!JSON.stringify(r).includes(tok), 'the answer never carries the token');
  // The redactor learned it at construction, written or not.
  assert.ok(d.redactor.text(`x ${tok} y`).includes(MASK('writer-token')));
});

test('the default still writes the file at construction', (t) => {
  const d = domain(t);
  publishedToken(d);
  assert.deepEqual(d.writers.publishToken(), { written: false, reason: 'current' });
});

test('publishToken re-writes a differing file (0600) and leaves an equal one untouched (same inode, same mtime)', (t) => {
  const d = domain(t);
  const tok = publishedToken(d);
  const before = fs.statSync(d.file);
  const r = d.writers.publishToken();
  assert.deepEqual(r, { written: false, reason: 'current' });
  const after = fs.statSync(d.file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);

  const stranger = mintToken();
  writeWriterToken(d.root, stranger);
  const w = d.writers.publishToken();
  assert.deepEqual(w, { written: true, reason: 'differs' });
  assert.equal(readWriterToken(d.root), tok);
  assert.equal(fs.statSync(d.file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(w).includes(tok));

  fs.writeFileSync(d.file, 'torn');
  assert.deepEqual(d.writers.publishToken(), { written: true, reason: 'absent' }, 'an unreadable file reads as absent');
  assert.equal(readWriterToken(d.root), tok);
});

test('publishToken after stop() writes nothing and answers {written: false}', (t) => {
  const d = domain(t);
  publishedToken(d);
  fs.rmSync(d.file);
  d.writers.stop();
  assert.deepEqual(d.writers.publishToken(), { written: false, reason: 'stopped' });
  assert.equal(fs.existsSync(d.file), false);
});

test('publishToken with no .web-chat/ answers {written: false}, makes no directory, and says so once', (t) => {
  const d = domain(t, { mkdir: false, writeAtConstruction: false });
  assert.deepEqual(d.writers.publishToken(), { written: false, reason: 'no-state-dir' });
  assert.deepEqual(d.writers.publishToken(), { written: false, reason: 'no-state-dir' });
  assert.equal(fs.existsSync(projectPaths(d.root).dir), false);
  assert.equal(d.lines.length, 1, d.lines.join('\n'));
  assert.match(d.lines[0], /writer token was not written \(ENOENT\)/);
});

test('double start: A then B constructed on one root (B\'s token in the file); A publishes after its claim → the file names A\'s', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = domain(t, { root, writeAtConstruction: false });
  const b = domain(t, { root });
  const bTok = readWriterToken(root);
  assert.deepEqual(b.writers.resolveWriter(reqOf({ [WRITER_HEADER]: bTok }), {}).verified, true);
  assert.deepEqual(a.writers.resolveWriter(reqOf({ [WRITER_HEADER]: bTok }), {}), { stale: true }, 'the file names a token A never minted');
  // A won the portfile race: it publishes after its claim.
  assert.deepEqual(a.writers.publishToken(), { written: true, reason: 'differs' });
  const aTok = readWriterToken(root);
  assert.notEqual(aTok, bTok);
  assert.deepEqual(a.writers.resolveWriter(reqOf({ [WRITER_HEADER]: aTok }), {}), { class: 'claude', owner: 'claude', verified: true });
});

// A stand-in capture hub on a port this file opened, so an in-process start()
// that claims its portfile never probes (or bounces) the machine's real hub.
async function fakeHub(t) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, role: 'hub', version: PROTOCOL_VERSION, pid: process.pid }));
  });
  await new Promise((r) => srv.listen(0, LISTEN_HOST, r));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  const prev = process.env.WEB_CHAT_HUB_PORT;
  process.env.WEB_CHAT_HUB_PORT = String(srv.address().port);
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_HUB_PORT; else process.env.WEB_CHAT_HUB_PORT = prev; });
  return seen;
}

test('createServer({tokenAtClaim: true}): no token file at construction; start() writes it with the portfile claim', async (t) => {
  withTempHome(t); // the registry entry start() writes lands in a sandbox
  const hubSeen = await fakeHub(t);
  let atConstruction = null;
  const ctx = await withServer(t, {
    mode: 'start',
    createServer: (o) => {
      const srv = createServer({ ...o, port: 0, tokenAtClaim: true });
      atConstruction = fs.existsSync(projectPaths(o.root).writerToken);
      const start = srv.start;
      // The foreground start's claim: the portfile written by start() itself.
      srv.start = () => start({ writePortfile: true });
      return srv;
    },
  });
  assert.equal(atConstruction, false, 'nothing written before the claim');
  const pf = JSON.parse(fs.readFileSync(projectPaths(ctx.root).serverJson, 'utf8'));
  assert.equal(pf.pid, process.pid);
  const tok = ctx.writerToken();
  assert.match(tok, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(projectPaths(ctx.root).writerToken).mode & 0o777, 0o600);
  const r = await ctx.api.post('/api/render', { id: 'live', html: '<p>live</p>', owner: 'user' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.owner, 'claude', 'the published token is the live daemon\'s: a verified claude write');
  await waitUntil(() => hubSeen.length > 0, { what: 'the boot\'s hub probe to settle', timeout: 3000 });
});

// ── (2) the MCP client: no tokenless send after a refused token ────────────

function mcpShim(t) {
  const prev = process.env.WEB_CHAT_MCP_SERVER;
  process.env.WEB_CHAT_MCP_SERVER = '1';
  const key = require.resolve('../lib/mcp/client');
  delete require.cache[key];
  const stderr = [];
  const realWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    if (String(chunk).includes('[web-chat]')) { stderr.push(String(chunk)); return true; }
    return realWrite.call(this, chunk, ...rest);
  };
  t.after(() => {
    process.stderr.write = realWrite;
    if (prev === undefined) delete process.env.WEB_CHAT_MCP_SERVER; else process.env.WEB_CHAT_MCP_SERVER = prev;
    delete require.cache[key];
  });
  return { shim: require('../lib/mcp/client'), stderr };
}

// A stand-in daemon that refuses every token as stale, recording what came in.
async function staleDaemon(t, onRequest = () => {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.headers[WRITER_HEADER.toLowerCase()] ?? null);
    onRequest(seen.length);
    req.resume();
    req.on('end', () => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, writer: 'stale', hint: 'the writer token is from an earlier boot of this surface — re-read .web-chat/writer-token and retry' }));
    });
  });
  await new Promise((r) => srv.listen(0, LISTEN_HOST, r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { port: srv.address().port, seen };
}

test('mcp client on the wire: a token still stale after a re-read that found another → two token-bearing requests, then the 401; never a tokenless one', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = mintToken();
  const second = mintToken();
  writeWriterToken(root, first);
  // The file changes after the first request lands: the re-read finds `second`.
  const d = await staleDaemon(t, (n) => { if (n === 1) writeWriterToken(root, second); });
  const { shim, stderr } = mcpShim(t);
  await assert.rejects(shim.post('/api/render', { id: 'x', html: 'x' }, { port: d.port, root, noSpawn: true }), (e) => {
    assert.equal(e.status, 401);
    assert.match(e.message, /401: .*\.web-chat\/writer-token/, 'the message lib/mcp/index.js hands Claude carries the hint');
    return true;
  });
  assert.deepEqual(d.seen, [first, second]);
  assert.deepEqual(stderr, []);
  // The cache was cleared: the next call reads the file again (still `second`).
  await assert.rejects(shim.post('/api/render', { id: 'y', html: 'y' }, { port: d.port, root, noSpawn: true }));
  assert.deepEqual(d.seen, [first, second, second]);
});

test('mcp client on the wire: the re-read finds the same token → exactly one request, then the 401', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tok = mintToken();
  writeWriterToken(root, tok);
  const d = await staleDaemon(t);
  const { shim, stderr } = mcpShim(t);
  await assert.rejects(shim.post('/api/render', { id: 'x', html: 'x' }, { port: d.port, root, noSpawn: true }), { status: 401 });
  assert.deepEqual(d.seen, [tok]);
  assert.deepEqual(stderr, []);
});

// ── S-9: the credentialed classes forged six ways ──────────────────────────

test('S-9: claude, service and driver forged six ways → 0/6 accepted, each a 401 or 403', async (t) => {
  const first = await withServer(t);
  const previous = first.writerToken();
  await first.stop();
  const ctx = await withServer(t, { root: first.root });
  const { port, srv } = ctx;
  const render = (id, body, headers) => client.request(port, 'POST', '/api/render', { id, html: `<p>${id}</p>`, ...body }, headers ? { headers } : {});

  const lease = await client.request(port, 'POST', LEASE, { owner: 'service:forged-lease', pid: process.pid });
  assert.equal(lease.status, 200, JSON.stringify(lease.body));
  const released = await client.request(port, 'DELETE', LEASE, null, withToken(lease.body.token));
  assert.equal(released.body.released, true);
  const child = srv.writers.mintService({ mountId: 'svc', name: 'forged-svc' });
  assert.equal(srv.writers.revoke(child), true);

  const forged = [
    ['claude with a stranger\'s token', await render('f1', {}, { [WRITER_HEADER]: mintToken() })],
    ['claude with the previous boot\'s token', await render('f2', {}, { [WRITER_HEADER]: previous })],
    ['a tokenless service:<n> body owner', await render('f3', { owner: 'service:git-dashboard' })],
    ['a service:<n> body owner under Claude\'s token', await render('f4', { owner: 'service:git-dashboard' }, { [WRITER_HEADER]: ctx.writerToken() })],
    ['a revoked lease\'s token', await render('f5', {}, { [WRITER_HEADER]: lease.body.token })],
    ['a service child\'s token after its revoke', await render('f6', {}, { [WRITER_HEADER]: child })],
  ];
  const accepted = forged.filter(([, r]) => r.status < 400);
  assert.deepEqual(accepted.map(([n]) => n), [], '0/6 accepted');
  for (const [name, r] of forged) assert.ok(r.status === 401 || r.status === 403, `${name}: ${r.status} ${JSON.stringify(r.body)}`);
  const mounts = (await ctx.api.get('/api/mounts')).json.mounts.map((m) => m.id);
  for (const id of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) assert.ok(!mounts.includes(id), `${id} never mounted`);
});

// ── (3) the redactor knows the live credentials ────────────────────────────

test('redactor.removeKnown drops a value and answers whether it held it; a source is untouched', () => {
  const r = createRedactor();
  const v = mintToken();
  const s = mintToken();
  assert.equal(r.removeKnown(v), false, 'never held');
  assert.equal(r.addKnown(v, 'lease-token'), true);
  r.addKnownSource(() => s, 'capture-token');
  assert.ok(r.text(`a ${v} b`).includes(MASK('lease-token')));
  assert.equal(r.removeKnown(v), true);
  assert.equal(r.removeKnown(v), false, 'idempotent');
  assert.ok(r.text(`a ${v} b`).includes(v), 'no longer a known value');
  assert.equal(r.removeKnown(s), false, 'a source\'s value is not a registered value');
  assert.ok(r.text(`a ${s} b`).includes(MASK('capture-token')));
  for (const bad of [null, undefined, 7, '']) assert.equal(r.removeKnown(bad), false);
});

test('a lease token and a service token are masked while held and leave the set on release, revoke, reap and stop', (t) => {
  let alive = true;
  const d = domain(t, { pidAlive: () => alive });
  const masked = (tok, label) => d.redactor.text(`see ${tok} here`).includes(MASK(label));

  // release
  const l1 = d.writers.lease({ owner: 'service:one', pid: 4242 });
  assert.ok(masked(l1.token, 'lease-token'));
  assert.equal(d.writers.release(l1.token), true);
  assert.ok(!masked(l1.token, 'lease-token'), 'released');

  // revoke (a service child's)
  const s1 = d.writers.mintService({ mountId: 'm', name: 'svc' });
  assert.ok(masked(s1, 'service-token'));
  assert.equal(d.writers.revoke(s1), true);
  assert.ok(!masked(s1, 'service-token'), 'revoked');

  // the lease a starting service revokes
  const l2 = d.writers.lease({ owner: 'service:two', pid: 4242 });
  assert.ok(masked(l2.token, 'lease-token'));
  const s2 = d.writers.mintService({ mountId: 'm2', name: 'two' });
  assert.ok(!masked(l2.token, 'lease-token'), 'revoked by the service start');
  assert.ok(masked(s2, 'service-token'));

  // the reap of a dead holder
  const l3 = d.writers.lease({ owner: 'service:three', pid: 4242 });
  assert.ok(masked(l3.token, 'lease-token'));
  alive = false;
  const l4 = d.writers.lease({ owner: 'service:three', pid: 4343 });
  assert.equal(l4.ok, true);
  assert.ok(!masked(l3.token, 'lease-token'), 'reaped');
  assert.ok(masked(l4.token, 'lease-token'));

  // stop: every credential leaves; Claude's boot token stays known.
  const boot = readWriterToken(d.root);
  d.writers.stop();
  assert.ok(!masked(s2, 'service-token'));
  assert.ok(!masked(l4.token, 'lease-token'));
  assert.ok(masked(boot, 'writer-token'), 'a stale boot token quoted later is still masked');
});

test('none is served: after a lease and a driver write, the event ring and the mirror hold no token text', async (t) => {
  const ctx = await withServer(t);
  const { port } = ctx;
  const lease = await client.request(port, 'POST', LEASE, { owner: 'service:leaky', pid: process.pid });
  assert.equal(lease.status, 200);
  const tok = lease.body.token;
  const w = await client.request(port, 'POST', '/api/render', { id: 'drv', html: '<p>drv</p>' }, withToken(tok));
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.owner, 'service:leaky');
  const st = await client.request(port, 'POST', '/api/store', { drv_key: 1 }, withToken(tok));
  assert.ok(st.status < 500);
  const child = ctx.srv.writers.mintService({ mountId: 'svc', name: 'leaky-svc' });
  t.after(() => ctx.srv.writers.revoke(child));

  const events = await ctx.api.get('/api/events');
  assert.equal(events.status, 200);
  const mirror = await ctx.api.get('/api/mirror');
  const mounts = await ctx.api.get('/api/mounts');
  for (const [name, r] of [['events', events], ['mirror', mirror], ['mounts', mounts]]) {
    for (const secret of [tok, child, ctx.writerToken()]) assert.ok(!r.text.includes(secret), `${name} carries no token text`);
  }
});

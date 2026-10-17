// Writer identity, Claude's class (PLAN 1B.4; DECISIONS A1; unit U214a):
// lib/core/writer-token (the token, its file, the one timing-safe compare),
// lib/server/domain/writers (resolveWriter), the gate in front of Claude's
// write routes (lib/server/routes/writers.js) and lib/mcp/client's token.
//
// The design report's finding (1) is why the token exists: Node's global fetch
// sends `sec-fetch-mode: cors`, so the test harness's makeApi reads as a
// BROWSER — the gate must refuse browsers, never tokenless local callers, and
// makeApi must carry the token.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { withServer, tmpRoot } = require('../test-support/helpers');
const {
  WRITER_HEADER, PANE_HEADER, mintToken, writeWriterToken, readWriterToken, safeEqual,
} = require('../lib/core/writer-token');
const { projectPaths } = require('../lib/core/paths');
const { REMOTE_HEADER, REMOTE_HEADER_VALUE } = require('../lib/core/cors');
const { createRedactor, MASK } = require('../lib/core/redact');
const { createAudience } = require('../lib/server/audience');
const { createWriters } = require('../lib/server/domain/writers');
const client = require('../lib/client');

const REMOTE = { [REMOTE_HEADER]: REMOTE_HEADER_VALUE };
const BROWSER = { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' };
const ROUTES = [
  ['/api/render', (id) => ({ id, html: `<p>${id}</p>` })],
  ['/api/markdown', (id) => ({ id, text: `# ${id}` })],
];

// ── lib/core/writer-token ───────────────────────────────────────────────────

test('writer-token: a minted token is 64 lowercase hex characters, fresh each time', () => {
  const a = mintToken();
  const b = mintToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(WRITER_HEADER, 'X-WC-Writer');
  assert.equal(PANE_HEADER, 'X-WC-Pane');
});

test('writer-token: write then read round-trips, the file is 0600, a missing file reads null', (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readWriterToken(root), null, 'no file → null');
  const tok = mintToken();
  const file = writeWriterToken(root, tok);
  assert.equal(file, projectPaths(root).writerToken);
  assert.equal(readWriterToken(root), tok);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), `${tok}\n`);
  // Rewriting keeps the mode and leaves no temp file behind.
  const tok2 = mintToken();
  writeWriterToken(root, tok2);
  assert.equal(readWriterToken(root), tok2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp')), []);
  // Junk in the file is not a token.
  fs.writeFileSync(file, 'not a token\n');
  assert.equal(readWriterToken(root), null);
});

test('writer-token: no .web-chat/ → the write throws (a daemon never creates its project dir)', (t) => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-nodir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => writeWriterToken(root, mintToken()), (e) => e.code === 'ENOENT');
  assert.equal(fs.existsSync(projectPaths(root).dir), false);
  assert.equal(readWriterToken(root), null);
});

test('writer-token: safeEqual is false across lengths and types, true for equal strings and Buffers', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual(Buffer.from('xyz'), Buffer.from('xyz')), true);
  assert.equal(safeEqual(Buffer.from('xyz'), Buffer.from('xy')), false);
  assert.equal(safeEqual('é', 'é'), false, 'compared as utf8 bytes');
  assert.equal(safeEqual(null, 'a'), false);
  assert.equal(safeEqual(undefined, undefined), false);
  assert.equal(safeEqual(1, 1), false);
});

// ── lib/server/domain/writers ───────────────────────────────────────────────

function domain(t, { mkdir = true } = {}) {
  const root = mkdir ? tmpRoot() : fs.mkdtempSync(path.join(require('os').tmpdir(), 'wc-nodir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const audience = createAudience({ root, configFile: null });
  const redactor = createRedactor();
  const lines = [];
  const writers = createWriters({ paths: projectPaths(root), state: { mounts: new Map() }, redactor, audience, log: (m) => lines.push(m) });
  return { root, writers, redactor, lines };
}
const reqOf = (headers = {}, addr = '127.0.0.1') => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  socket: { remoteAddress: addr },
});

test('writers: resolveWriter classifies remote, claude, stale, user and the tokenless local caller', (t) => {
  const { root, writers } = domain(t);
  const tok = readWriterToken(root);
  assert.ok(tok, 'the domain wrote the boot token');
  const r = (h, body, addr) => writers.resolveWriter(reqOf(h, addr), body);

  assert.deepEqual(r(REMOTE), { class: 'remote', owner: 'remote', verified: false });
  assert.deepEqual(r({ [WRITER_HEADER]: tok, ...REMOTE }), { class: 'remote', owner: 'remote', verified: false }, 'remote wins over a token');
  assert.equal(r({}, {}, '10.0.0.7').class, 'remote', 'a network peer is remote');
  assert.deepEqual(r({ [WRITER_HEADER]: tok }), { class: 'claude', owner: 'claude', verified: true });
  assert.deepEqual(r({ [WRITER_HEADER]: tok, ...BROWSER }), { class: 'claude', owner: 'claude', verified: true }, 'the token outranks fetch metadata');
  assert.deepEqual(r({ [WRITER_HEADER]: mintToken() }), { stale: true });
  assert.deepEqual(r({ [WRITER_HEADER]: 'nope' }), { stale: true });
  assert.deepEqual(r(BROWSER), { class: 'user', owner: 'user', verified: false });
  assert.deepEqual(r({ 'Sec-Fetch-Mode': 'cors' }), { class: 'user', owner: 'user', verified: false });
  assert.deepEqual(r({}, {}), { class: 'claude', owner: 'claude', verified: false });
  assert.deepEqual(r({}, { owner: 'claude' }), { class: 'claude', owner: 'claude', verified: false });
  assert.deepEqual(r({}, { owner: 'service:x' }), { class: 'service', owner: 'service:x', verified: false });
  assert.deepEqual(r({}, undefined), { class: 'claude', owner: 'claude', verified: false });

  writers.stop();
  assert.deepEqual(r({ [WRITER_HEADER]: tok }), { stale: true }, 'after stop every token claim is stale');
});

test('writers: the token is masked by the redactor it was given', (t) => {
  const { root, redactor } = domain(t);
  const tok = readWriterToken(root);
  const out = redactor.text(`the token is ${tok} ok`);
  assert.ok(!out.includes(tok));
  assert.ok(out.includes(MASK('writer-token')), out);
  assert.ok(!JSON.stringify(redactor.value({ deep: [tok] })).includes(tok));
});

test('writers: with no .web-chat/ the token stays in memory, one log line, no directory made', (t) => {
  const { root, writers, lines } = domain(t, { mkdir: false });
  assert.equal(fs.existsSync(projectPaths(root).dir), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /writer token was not written/);
  // The in-memory token still works; a stranger's is stale.
  assert.deepEqual(writers.resolveWriter(reqOf({ [WRITER_HEADER]: mintToken() }), {}), { stale: true });
});

test('writers: the domain hands out no token accessor', (t) => {
  const { root, writers } = domain(t);
  const tok = readWriterToken(root);
  assert.deepEqual(Object.keys(writers).sort(), ['resolveWriter', 'stop']);
  assert.ok(!JSON.stringify(writers).includes(tok));
});

// ── boot ────────────────────────────────────────────────────────────────────

test('boot: .web-chat/writer-token exists, 0600; a second boot in the same root writes a new one', async (t) => {
  const { root, writerToken, stop } = await withServer(t);
  const file = projectPaths(root).writerToken;
  const first = writerToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await stop();
  const second = await withServer(t, { root });
  assert.notEqual(second.writerToken(), first, 'the token rotates per boot');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('boot: no response, event or static path carries the token', async (t) => {
  const { api, anonApi, port, writerToken } = await withServer(t);
  const tok = writerToken();
  // A turn whose lock message quotes the token: graph text passes the redactor.
  const begun = await client.request(port, 'POST', '/api/turn-begin', { message: `quoting ${tok}` });
  assert.equal(begun.status, 200);
  await api.post('/api/render', { id: 'p1', html: `<p>${tok}</p>` });
  for (const p of ['/api/health', '/api/events', '/api/events?since=0', '/api/graph', '/api/queue/policy']) {
    const r = await api.get(p);
    assert.ok(!r.text.includes(tok), `${p} carries the token`);
  }
  const graph = (await api.get('/api/graph')).json;
  assert.ok(graph.lock && graph.lock.message.includes(MASK('writer-token')), `the lock message is masked: ${JSON.stringify(graph.lock)}`);
  for (const p of ['/.web-chat/writer-token', '/writer-token', '/.web-chat/', '/app/../.web-chat/writer-token', '/%2e%77eb-chat/writer-token', '/api/writer-token', '/api/writers/token']) {
    const r = await anonApi.get(p);
    assert.equal(r.status, 404, `${p} → ${r.status}`);
    assert.ok(!r.text.includes(tok), `${p} carries the token`);
  }
});

// ── the gate ────────────────────────────────────────────────────────────────

test('gate: render and markdown — token 200, browser 403, lib/client advisory 200, stale 401, remote 403', async (t) => {
  const { api, anonApi, port } = await withServer(t);
  for (const [route, body] of ROUTES) {
    const tag = route.slice(5);
    const ok = await api.post(route, body(`${tag}-tok`));
    assert.equal(ok.status, 200, `${route} with the token → ${ok.status} ${ok.text}`);
    assert.notEqual(ok.json.ok, false);

    const anon = await anonApi.post(route, body(`${tag}-anon`));
    assert.equal(anon.status, 403, `${route} from Node fetch with no token`);
    assert.equal(anon.json.writer, 'browser');
    assert.match(anon.json.hint, /MCP/);

    const browser = await client.request(port, 'POST', route, body(`${tag}-browser`), { headers: BROWSER });
    assert.equal(browser.status, 403, `${route} with Origin + Sec-Fetch-Site`);
    assert.equal(browser.body.writer, 'browser');

    const local = await client.post(route, body(`${tag}-local`), { port });
    assert.notEqual(local.ok, false, `${route} through lib/client (no token) is advisory claude`);

    const stale = await api.post(route, body(`${tag}-stale`), { [WRITER_HEADER]: mintToken() });
    assert.equal(stale.status, 401);
    assert.equal(stale.json.writer, 'stale');
    assert.match(stale.json.hint, /writer-token/);

    const remote = await client.request(port, 'POST', route, body(`${tag}-remote`), { headers: REMOTE });
    assert.equal(remote.status, 403, `${route} through the portal`);
    assert.equal(remote.body.writer, 'browser');
  }
  const { mounts, markdown } = (await api.get('/api/mounts')).json;
  assert.deepEqual(mounts.map((m) => [m.id, m.owner]).sort(), [['render-local', 'claude'], ['render-tok', 'claude']]);
  assert.deepEqual(markdown.map((m) => [m.id, m.owner]).sort(), [['markdown-local', 'claude'], ['markdown-tok', 'claude']]);
});

test('gate: under the token a declared service owner stays (until U214b); any other owner reads claude', async (t) => {
  const { api } = await withServer(t);
  assert.equal((await api.post('/api/render', { id: 's', html: '<p>s</p>', owner: 'service:x' })).json.owner, 'service:x');
  assert.equal((await api.post('/api/render', { id: 'c', html: '<p>c</p>', owner: 'claude' })).json.owner, 'claude');
  assert.equal((await api.post('/api/render', { id: 'u', html: '<p>u</p>', owner: 'user' })).json.owner, 'claude');
  const owners = Object.fromEntries((await api.get('/api/mounts')).json.mounts.map((m) => [m.id, m.owner]));
  assert.deepEqual(owners, { s: 'service:x', c: 'claude', u: 'claude' });
});

test('gate: a browser clear naming a service owner closes nothing it could not close before', async (t) => {
  const { api, anonApi, port } = await withServer(t);
  await client.post('/api/render', { id: 'svc', html: '<p>svc</p>', owner: 'service:x' }, { port });
  const r = await anonApi.post('/api/clear', { id: 'svc', owner: 'service:x' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false, 'the owner was dropped, so the clobber guard holds');
  assert.equal(r.json.owned, true);
  assert.ok((await api.get('/api/mounts')).json.mounts.some((m) => m.id === 'svc'));
  // The chrome's × (force, no owner) still closes it.
  const x = await anonApi.post('/api/clear', { id: 'svc', force: true });
  assert.equal(x.json.ok, true);
  assert.ok(!(await api.get('/api/mounts')).json.mounts.some((m) => m.id === 'svc'));
  // A stale token on a clear is a 401.
  const stale = await api.post('/api/clear', { id: 'nothing' }, { [WRITER_HEADER]: mintToken() });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.writer, 'stale');
});

test('gate: F9 S-9 pane attempts 2-5 from a page script (browser headers, no token) are refused', async (t) => {
  const { api, port } = await withServer(t);
  await api.post('/api/render', { id: 'claude-pane', html: '<p>Claude</p>' });
  await client.post('/api/render', { id: 'svc-pane', html: '<p>git</p>', owner: 'service:git-dashboard' }, { port });
  const before = (await api.get('/api/mounts')).json;
  const attempts = [
    { id: 'claude-pane', html: '<p>forged</p>', owner: 'service:x' },
    { id: 'claude-pane', html: '<p>forged</p>', owner: 'service:x', force: true },
    { id: 'claude-pane', html: '<p>forged</p>' },
    { id: 'svc-pane', html: '<p>forged</p>', owner: 'service:git-dashboard' },
  ];
  for (const body of attempts) {
    const r = await client.request(port, 'POST', '/api/render', body, { headers: BROWSER });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.body.writer, 'browser');
  }
  const after = (await api.get('/api/mounts')).json;
  assert.deepEqual(after, before, 'the panes are unchanged');
});

// ── lib/mcp/client ──────────────────────────────────────────────────────────

// Load a fresh copy of the shim with WEB_CHAT_MCP_SERVER set (or unset), and a
// spy on lib/client.post that records the headers each call went out with.
function mcpShim(t, { asMcpServer = true } = {}) {
  const prev = process.env.WEB_CHAT_MCP_SERVER;
  if (asMcpServer) process.env.WEB_CHAT_MCP_SERVER = '1';
  else delete process.env.WEB_CHAT_MCP_SERVER;
  const key = require.resolve('../lib/mcp/client');
  delete require.cache[key];
  const realPost = client.post;
  const sent = [];
  client.post = async (p, body, opts) => {
    const h = (opts && opts.headers) || {};
    sent.push({ path: p, writer: Object.prototype.hasOwnProperty.call(h, WRITER_HEADER) ? h[WRITER_HEADER] : null });
    return realPost(p, body, opts);
  };
  const stderr = [];
  const realWrite = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    if (String(chunk).includes('[web-chat]')) { stderr.push(String(chunk)); return true; }
    return realWrite.call(this, chunk, ...rest);
  };
  t.after(() => {
    client.post = realPost;
    process.stderr.write = realWrite;
    if (prev === undefined) delete process.env.WEB_CHAT_MCP_SERVER; else process.env.WEB_CHAT_MCP_SERVER = prev;
    delete require.cache[key];
  });
  return { shim: require('../lib/mcp/client'), sent, stderr };
}

test('mcp client: inside the MCP server a render carries the writer token and lands verified', async (t) => {
  const ctx = await withServer(t);
  const { shim, sent, stderr } = mcpShim(t);
  const r = await shim.post('/api/render', { id: 'm1', html: '<p>m</p>', owner: 'user' }, { port: ctx.port, root: ctx.root, noSpawn: true });
  assert.equal(r.owner, 'claude', 'a verified claude write drops a body owner');
  assert.deepEqual(sent, [{ path: '/api/render', writer: ctx.writerToken() }]);
  assert.deepEqual(stderr, []);
});

test('mcp client: the header reaches the wire', async (t) => {
  const root = tmpRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tok = mintToken();
  writeWriterToken(root, tok);
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const { shim } = mcpShim(t);
  await shim.post('/api/render', { id: 'x', html: 'x' }, { port: srv.address().port, root, noSpawn: true });
  assert.equal(seen[0][WRITER_HEADER.toLowerCase()], tok);
  assert.equal(seen[0]['x-wc-client'], 'mcp');
});

test('mcp client: after a restart in the same root, one stale 401, one re-read, one retry', async (t) => {
  const first = await withServer(t);
  const { shim, sent, stderr } = mcpShim(t);
  let second = null;
  const opts = () => ({ port: second ? second.port : first.port, root: first.root, noSpawn: true });
  await shim.post('/api/render', { id: 'a', html: '<p>a</p>' }, opts());
  const old = first.writerToken();
  await first.stop();
  second = await withServer(t, { root: first.root });
  sent.length = 0;
  const r = await shim.post('/api/render', { id: 'b', html: '<p>b</p>' }, opts());
  assert.equal(r.owner, 'claude');
  assert.deepEqual(sent.map((s) => s.writer), [old, second.writerToken()], 'the cached token, then the re-read one');
  assert.deepEqual(stderr, []);
  // The next call uses the new token straight away.
  sent.length = 0;
  await shim.post('/api/render', { id: 'c', html: '<p>c</p>' }, opts());
  assert.deepEqual(sent.map((s) => s.writer), [second.writerToken()]);
});

test('mcp client: no token file → the call goes out tokenless and lands as advisory claude', async (t) => {
  const ctx = await withServer(t);
  fs.rmSync(projectPaths(ctx.root).writerToken);
  const { shim, sent, stderr } = mcpShim(t);
  const r = await shim.post('/api/render', { id: 'n', html: '<p>n</p>' }, { port: ctx.port, root: ctx.root, noSpawn: true });
  assert.equal(r.owner, 'claude');
  assert.deepEqual(sent.map((s) => s.writer), [null]);
  assert.deepEqual(stderr, []);
});

test('mcp client: still stale after the re-read → one tokenless retry and one stderr line, never a loop', async (t) => {
  const ctx = await withServer(t);
  writeWriterToken(ctx.root, mintToken()); // a token the daemon never minted
  const { shim, sent, stderr } = mcpShim(t);
  const r = await shim.post('/api/render', { id: 'f', html: '<p>f</p>' }, { port: ctx.port, root: ctx.root, noSpawn: true });
  assert.equal(r.owner, 'claude', 'advisory claude');
  assert.equal(sent.length, 2, 'the bad token once (the re-read finds the same), then once without');
  assert.equal(sent[1].writer, null);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /stale/);
});

test('mcp client: outside the MCP server (CLI, hooks) no writer header is sent', async (t) => {
  const ctx = await withServer(t);
  const { shim, sent } = mcpShim(t, { asMcpServer: false });
  const r = await shim.post('/api/render', { id: 'h', html: '<p>h</p>' }, { port: ctx.port, root: ctx.root, noSpawn: true });
  assert.equal(r.owner, 'claude');
  assert.deepEqual(sent.map((s) => s.writer), [null]);
});

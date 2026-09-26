// The tunnel portal's HTTP path: Host routing, the remote route policy, CSRF,
// header hygiene and the streamed proxy to a REAL daemon (withServer), found
// through the REAL registry (registerInstance into the sandboxed HOME).
//
// Requests are raw (withPortal's `request`) because the portal routes on Host,
// which fetch refuses to set — the same reason test/trust-boundary.test.js
// uses its `raw()`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { withServer, withPortal, withTempHome, waitUntil } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { readMcpSeen } = require('../lib/core/mcp-seen');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { forwardHeaders, responseHeaders } = require('../lib/portal/proxy');
const { parseHost, sessionHost, normalizeConfig } = require('../lib/tunnel/config');

// One daemon + one portal, the daemon registered under its real instance id.
async function rig(t, { config } = {}) {
  const srv = await withServer(t);
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const id = instanceId(srv.root);
  const access = createFakeAccess();
  const p = await withPortal(t, { config: access.config(config), fetchJwks: access.fetchJwks });
  const host = sessionHost(p.config, id);
  const origin = `https://${host}`;
  const auth = { 'cf-access-jwt-assertion': access.mint() };
  // A request to the session, authenticated, from the session's own page.
  const req = (path, { method = 'GET', headers = {}, body, h = host } = {}) => p.request(path, {
    host: h,
    method,
    body,
    headers: {
      ...auth,
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  });
  return { srv, p, id, host, origin, auth, access, req };
}

test('portal proxy: a GET reaches the daemon and comes back with the security headers', async (t) => {
  const r = await rig(t);
  const g = await r.req('/api/graph');
  assert.equal(g.status, 200, g.text);
  assert.ok(Array.isArray(g.json.nodes), 'the daemon\'s graph came through');
  assert.equal(g.headers['cache-control'], 'no-store');
  assert.equal(g.headers['x-frame-options'], 'DENY');
  assert.equal(g.headers['referrer-policy'], 'no-referrer');
  assert.match(String(g.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(g.headers['set-cookie'], undefined);

  // The SPA itself, opened from a link on another site (a top-level navigation).
  const page = await r.req('/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.notEqual(page.headers['cache-control'], 'no-store', 'static assets are not /api');
});

test('portal proxy: a write from the session\'s own page goes through', async (t) => {
  const r = await rig(t);
  const w = await r.req('/api/store', { method: 'POST', body: { patch: { remote_key: 42 } }, headers: { origin: r.origin } });
  assert.equal(w.status, 200, w.text);
  const direct = await r.srv.api.get('/api/store');
  assert.equal(direct.json.remote_key, 42);
});

test('portal proxy: pack install is refused with the remote hint, and nothing reaches the audit log', async (t) => {
  const r = await rig(t);
  const res = await r.req('/api/packs/install', {
    method: 'POST', body: { source: 'https://github.com/x/y' }, headers: { origin: r.origin },
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.remote, true);
  assert.match(res.json.hint, /run on the host/);
  assert.equal(fs.existsSync(projectPaths(r.srv.root).packsAudit), false, 'project audit log untouched');
  assert.equal(fs.existsSync(userPaths().packsAudit), false, 'user audit log untouched');
});

test('portal proxy: shutdown, format=file export and captures are refused; the daemon lives', async (t) => {
  const r = await rig(t);
  const o = { origin: r.origin };
  assert.equal((await r.req('/api/shutdown', { method: 'POST', body: {}, headers: { ...o, 'x-wc-shutdown': '1' } })).status, 403);
  assert.equal((await r.req('/api/export/active?format=file')).status, 403);
  assert.equal((await r.req('/api/export/active?format%5B%5D=file')).status, 403, 'the qs array spelling too');
  assert.equal((await r.req('/api/captures')).status, 403);
  assert.equal((await r.req('/api/capture', { method: 'POST', body: {}, headers: o })).status, 403);
  assert.equal((await r.req('/api/events')).status, 403, 'the harness event log');
  assert.equal((await r.req('/api/%2e%2e/api/shutdown', { method: 'POST', body: {}, headers: o })).status, 403, 'malformed paths');
  const alive = await r.srv.api.get('/api/health');
  assert.equal(alive.status, 200, 'the daemon is still up');
  assert.equal(fs.existsSync(`${r.srv.webChatDir}/exports`), false, 'no export was written to the host disk');
});

test('portal proxy: CSRF — foreign or missing Origin on a write, and cross-site reads, are 403', async (t) => {
  const r = await rig(t);
  const body = { patch: { csrf: 1 } };
  const foreign = await r.req('/api/store', { method: 'POST', body, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const otherSession = await r.req('/api/store', { method: 'POST', body, headers: { origin: 'https://wc-00000000.example.test' } });
  assert.equal(otherSession.status, 403, 'another session is another origin');
  const missing = await r.req('/api/store', { method: 'POST', body });
  assert.equal(missing.status, 403, 'a write without an Origin');
  assert.equal((await r.srv.api.get('/api/store')).json.csrf, undefined, 'none of them landed');

  const xs = await r.req('/api/graph', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } });
  assert.equal(xs.status, 403, 'a cross-site read');
  const xsNav = await r.req('/api/graph', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.equal(xsNav.status, 403, 'a cross-site navigation anywhere but /');
  // same-site is ANOTHER session under the same apex (wc-<a> vs wc-<b>): the
  // isolation line between sessions, so it is refused like cross-site.
  const ss = await r.req('/api/graph', { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } });
  assert.equal(ss.status, 403, 'a same-site (other session) read');
  const foreignGet = await r.req('/api/graph', { headers: { origin: 'https://evil.example' } });
  assert.equal(foreignGet.status, 403, 'a foreign Origin on a read');
  const sameOrigin = await r.req('/api/graph', { headers: { 'sec-fetch-site': 'same-origin', origin: r.origin } });
  assert.equal(sameOrigin.status, 200, 'the page\'s own fetch');
});

test('portal proxy: trusted daemon headers never arrive (the MCP sighting stays null)', async (t) => {
  const r = await rig(t);
  const res = await r.req('/api/graph', {
    headers: {
      'x-wc-client': 'mcp',
      'x-wc-mcp-started': String(Date.now()),
      'x-wc-token': 'guess',
      cookie: 'a=b',
      authorization: 'Bearer x',
      'x-forwarded-for': '1.2.3.4',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(readMcpSeen(r.srv.root), null, 'the daemon saw no MCP client');
});

test('portal proxy: unknown session is a friendly 404; the apex is the picker; a wrong Host is 421', async (t) => {
  const r = await rig(t);

  const unknown = await r.req('/', { h: sessionHost(r.p.config, 'deadbeef') });
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /not running/);
  assert.match(unknown.text, /href="https:\/\/wc\.example\.test\/"/, 'links to the picker');
  const unknownApi = await r.req('/api/graph', { h: sessionHost(r.p.config, 'deadbeef') });
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.json.picker, 'https://wc.example.test/');

  const picker = await r.req('/', { h: 'wc.example.test' });
  assert.equal(picker.status, 200);
  assert.match(picker.headers['content-security-policy'], /default-src 'none'/);
  assert.match(picker.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(picker.text, /<script>[^<]/, 'no inline script');
  const list = await r.req('/api/sessions', { h: 'wc.example.test' });
  assert.equal(list.status, 200);
  const row = list.json.sessions.find((s) => s.id === r.id);
  assert.ok(row, 'the running instance is listed');
  assert.equal(row.url, `https://${r.host}/`);
  assert.equal(row.reachable, true);
  assert.equal(row.viewers, 0);
  assert.equal(row.root, undefined, 'full roots only when showRoots is on');

  for (const bad of ['evil.example.test', `wc-${r.id}.other.test`, `${r.id}.wc.example.test`, 'wc.example.test.evil.test']) {
    const res = await r.p.request('/api/graph', { host: bad, headers: r.auth });
    assert.equal(res.status, 421, `Host ${bad}`);
  }
  // Unauthenticated requests learn nothing about which sessions exist.
  const anon = await r.p.request('/', { host: sessionHost(r.p.config, 'deadbeef') });
  assert.equal(anon.status, 401);
});

test('portal proxy: showRoots lists the full path', async (t) => {
  const r = await rig(t, { config: { showRoots: true } });
  const list = await r.req('/api/sessions', { h: 'wc.example.test' });
  assert.equal(list.json.sessions.find((s) => s.id === r.id).root, r.srv.root);
});

test('portal: a loopback Host reaches only the health probe', async (t) => {
  const r = await rig(t);
  const h = await r.p.request('/api/health', { host: `127.0.0.1:${r.p.port}` });
  assert.equal(h.status, 200);
  assert.equal(h.json.role, 'portal');
  assert.equal(h.json.port, r.p.port);
  assert.equal(h.json.allowlist, 1);
  const other = await r.p.request('/api/graph', { host: `127.0.0.1:${r.p.port}`, headers: r.auth });
  assert.equal(other.status, 421);
});

test('forwardHeaders: an allowlist, with Origin rewritten only when asked', () => {
  const out = forwardHeaders({
    accept: 'a', 'content-type': 'b', 'sec-fetch-site': 'same-origin', range: 'bytes=0-1',
    cookie: 'x', authorization: 'y', 'cf-connecting-ip': 'z', 'x-wc-token': 't',
    'x-wc-shutdown': '1', 'x-forwarded-for': 'f', origin: 'https://wc-x.example.test', host: 'h',
    'x-wc-remote': '0',
  }, { port: 5999, origin: true });
  assert.deepEqual(out, {
    accept: 'a', 'content-type': 'b', 'sec-fetch-site': 'same-origin', range: 'bytes=0-1',
    origin: 'http://localhost:5999',
    'x-wc-remote': '1',
  }, 'the viewer\'s own x-wc-remote is dropped; the portal\'s label is always set');
  assert.equal(forwardHeaders({ origin: 'https://x' }, { port: 1 }).origin, undefined);
});

test('responseHeaders: preview documents may be framed by their own origin only', () => {
  const prev = responseHeaders({ 'content-security-policy': "default-src 'none'", 'set-cookie': 'a=b', connection: 'keep-alive' }, '/preview/node/abc');
  assert.deepEqual(prev['content-security-policy'], ["default-src 'none'", "frame-ancestors 'self'"]);
  assert.equal(prev['x-frame-options'], 'SAMEORIGIN');
  assert.equal(prev['set-cookie'], undefined);
  assert.equal(prev.connection, undefined);
  const api = responseHeaders({}, '/api/store');
  assert.equal(api['x-frame-options'], 'DENY');
  assert.equal(api['cache-control'], 'no-store');
});

test('parseHost: flat and nested hostnames', () => {
  const flat = normalizeConfig(createFakeAccess().config({ hostname: 'wc.example.com' }));
  assert.deepEqual(parseHost(flat, 'wc-0a1b2c3d.example.com'), { kind: 'session', id: '0a1b2c3d', host: 'wc-0a1b2c3d.example.com' });
  assert.deepEqual(parseHost(flat, 'WC.Example.com:443'), { kind: 'apex', host: 'wc.example.com' });
  assert.equal(parseHost(flat, 'wc-0A1B2C3D.example.com').id, '0a1b2c3d', 'hostnames are case-insensitive');
  assert.equal(parseHost(flat, 'wc-0a1b2c3.example.com'), null, 'seven hex is not an id');
  assert.equal(parseHost(flat, 'wc-0a1b2c3d.evil.com'), null);
  assert.equal(parseHost(flat, 'xwc-0a1b2c3d.example.com'), null);
  assert.deepEqual(parseHost(flat, 'localhost:5171'), { kind: 'local' });
  const nested = normalizeConfig(createFakeAccess().config({ hostname: 'wc.example.com', style: 'nested' }));
  assert.equal(sessionHost(nested, '0a1b2c3d'), '0a1b2c3d.wc.example.com');
  assert.equal(parseHost(nested, '0a1b2c3d.wc.example.com').id, '0a1b2c3d');
  assert.equal(parseHost(nested, 'wc-0a1b2c3d.example.com'), null);
});

test('portal lifecycle: start() binds loopback and registers role:portal; portal run needs a config', async (t) => {
  const { createPortal } = require('../lib/portal');
  const { readRoleEntry, deregisterRole } = require('../lib/util/registry');
  const { loadConfig } = require('../lib/tunnel/config');
  withTempHome(t);
  const access = createFakeAccess();
  const portal = createPortal({ port: 0, config: normalizeConfig(access.config()), fetchJwks: access.fetchJwks });
  t.after(async () => { await portal.stop(); deregisterRole('portal', { pid: process.pid }); });
  await portal.start();
  assert.equal(portal.server.address().address, '127.0.0.1');
  const entry = readRoleEntry('portal');
  assert.ok(entry, 'registered');
  assert.equal(entry.port, portal.server.address().port);
  assert.equal(entry.pid, process.pid);
  assert.ok(await waitUntil(() => access.state.calls === 1), 'the key set is warmed at start');

  assert.throws(() => loadConfig(), (e) => e.userFacing && /tunnel setup/.test(e.message), 'no config → points at setup');
  fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
  fs.writeFileSync(userPaths().tunnelConfig, JSON.stringify(access.config({ allow: { emails: [] } })));
  assert.throws(() => loadConfig(), (e) => e.userFacing && /allow\.emails is empty/.test(e.message), 'an empty allowlist never starts');
  fs.writeFileSync(userPaths().tunnelConfig, JSON.stringify(access.config()));
  assert.equal(loadConfig().hostname, 'wc.example.test');
});

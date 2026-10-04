// The tunnel portal's hardening layer (p6d): what an operator can keep OFF the
// tunnel, and what the portal records and rate-limits on the way through.
//
//   - a project's `.web-chat/no-remote` marker, and tunnel.json `expose.exclude`
//     (by instance id or by directory) — hidden from the picker AND refused on
//     the project's hostname, the same answer as a project that is not running;
//   - `remote.allowDestructive` — the one opt-in that lets a remote viewer wipe
//     a graph, proven end to end through a real daemon;
//   - the remote access log — one line per write / socket upgrade past the
//     sign-in, refused or not, size-capped;
//   - the failed-sign-in throttle — repeated 401s from one client are answered
//     429 before any check runs;
//   - `X-WC-Remote: 1` — added by the portal, echoed by the daemon's
//     /api/health as `remote:true` for the page's host-only affordances.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { withServer, withPortal, withTempHome, waitUntil } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { projectPaths, userPaths } = require('../lib/core/paths');
const { sessionHost, normalizeConfig, hiddenReason } = require('../lib/tunnel/config');
const { createAccessLog } = require('../lib/portal/access-log');
const { createThrottle, clientKey } = require('../lib/portal/throttle');

function tmpFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-portal-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

function readLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// One daemon + one portal. `before(srv)` runs before the portal first reads the
// registry (its memo would otherwise hold the pre-marker answer for a second).
async function rig(t, { config, before, throttle, log = true } = {}) {
  const srv = await withServer(t);
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const id = instanceId(srv.root);
  if (before) await before(srv, id);
  const access = createFakeAccess();
  const logFile = tmpFile(t, 'remote-access.log');
  const p = await withPortal(t, {
    config: access.config(typeof config === 'function' ? config(srv, id) : config),
    fetchJwks: access.fetchJwks,
    accessLog: log ? createAccessLog({ file: logFile }) : undefined,
    throttle,
  });
  const host = sessionHost(p.config, id);
  const origin = `https://${host}`;
  const auth = { 'cf-access-jwt-assertion': access.mint() };
  const req = (pathStr, { method = 'GET', headers = {}, body, h = host, token = true } = {}) => p.request(pathStr, {
    host: h,
    method,
    body,
    headers: {
      ...(token ? auth : {}),
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  });
  return { srv, p, id, host, origin, auth, access, req, logFile };
}

// ── hiding a project ────────────────────────────────────────────────────────

test('no-remote marker: the project is off the picker and its hostname answers like a stopped one', async (t) => {
  const r = await rig(t, {
    before: (srv) => fs.writeFileSync(projectPaths(srv.root).noRemote, ''),
  });
  const page = await r.req('/');
  assert.equal(page.status, 404, 'the surface is not served');
  assert.match(page.text, /not running/, 'the same page a stopped project gets — nothing says "hidden"');
  const api = await r.req('/api/store', { method: 'POST', body: { patch: { x: 1 } }, headers: { origin: r.origin } });
  assert.equal(api.status, 404);
  assert.equal((await r.srv.api.get('/api/store')).json.x, undefined, 'nothing reached the daemon');

  const list = await r.req('/api/sessions', { h: 'wc.example.test' });
  assert.equal(list.status, 200);
  assert.equal(list.json.sessions.some((s) => s.id === r.id), false, 'not listed');

  const health = await r.p.request('/api/health', { host: `127.0.0.1:${r.p.port}` });
  assert.equal(health.json.sessions, 0);
  assert.equal(health.json.hidden, 1, 'the portal still counts it, for status');
});

test('no-remote marker: the socket is refused too', async (t) => {
  const r = await rig(t, { before: (srv) => fs.writeFileSync(projectPaths(srv.root).noRemote, '') });
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${r.p.port}/ws`, {
      headers: { host: r.host, 'cf-access-jwt-assertion': r.access.mint() }, origin: r.origin,
    });
    t.after(() => { try { ws.terminate(); } catch {} });
    ws.on('unexpected-response', (_q, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('open', () => reject(new Error('the socket opened')));
    ws.on('error', () => {});
  });
  assert.equal(status, 404);
});

test('expose.exclude: an instance id hides that project; the others stay', async (t) => {
  const r = await rig(t, { config: (_srv, id) => ({ expose: { exclude: [id.toUpperCase()] } }) });
  assert.equal((await r.req('/api/graph')).status, 404);
  const list = await r.req('/api/sessions', { h: 'wc.example.test' });
  assert.deepEqual(list.json.sessions.map((s) => s.id), []);
});

test('hidden projects stay off the picker even when they are Claude-only (no surface to route)', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hidden-claude-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const marked = path.join(base, 'marked');
  const excluded = path.join(base, 'excluded');
  const shown = path.join(base, 'shown');
  for (const d of [marked, excluded, shown]) fs.mkdirSync(path.join(d, '.web-chat'), { recursive: true });
  fs.writeFileSync(projectPaths(marked).noRemote, '');
  const claude = { sessions: 1, channel: true, pids: [1], started_at: 1, last_tool_at: 2 };
  const access = createFakeAccess();
  const p = await withPortal(t, {
    config: access.config({ expose: { exclude: [excluded] } }),
    fetchJwks: access.fetchJwks,
    instances: () => [],
    sessions: () => [marked, excluded, shown].map((root) => ({ root, title: path.basename(root), surface: null, claude })),
  });
  const list = await p.request('/api/sessions', { headers: { 'cf-access-jwt-assertion': access.mint() } });
  assert.deepEqual(list.json.sessions.map((s) => s.title), ['shown']);
});

test('expose.exclude: a directory hides every project under it', async (t) => {
  const r = await rig(t, { config: (srv) => ({ expose: { exclude: [path.dirname(srv.root)] } }) });
  assert.equal((await r.req('/api/graph')).status, 404);
});

test('an unhidden project is served (the rig itself is not what hides it)', async (t) => {
  const r = await rig(t, { config: { expose: { exclude: ['/nowhere/near', 'deadbeef'] } } });
  assert.equal((await r.req('/api/graph')).status, 200);
});

test('hiddenReason + expose normalisation', (t) => {
  const base = createFakeAccess().config();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hidden-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = { id: instanceId(root), root };

  const none = normalizeConfig(base);
  assert.deepEqual(none.expose, { exclude: [] }, 'absent → nothing excluded');
  assert.equal(hiddenReason(none, entry), null);

  assert.equal(hiddenReason(normalizeConfig({ ...base, expose: { exclude: [entry.id] } }), entry), 'excluded');
  assert.equal(hiddenReason(normalizeConfig({ ...base, expose: { exclude: [root] } }), entry), 'excluded');
  assert.equal(hiddenReason(normalizeConfig({ ...base, expose: { exclude: [`${root}-sibling`] } }), entry), null,
    'a sibling directory sharing a prefix is not a parent');

  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  fs.writeFileSync(projectPaths(root).noRemote, '');
  assert.equal(hiddenReason(none, entry), 'no-remote');

  for (const bad of [{ exclude: ['relative/dir'] }, { exclude: 'deadbeef' }, [], { exclude: [42] }]) {
    assert.throws(() => normalizeConfig({ ...base, expose: bad }), (e) => e.userFacing && /expose/.test(e.message), JSON.stringify(bad));
  }
});

// ── allowDestructive ────────────────────────────────────────────────────────

test('allowDestructive: a remote wipe is refused by default and allowed only when opted in', async (t) => {
  const off = await rig(t);
  const refused = await off.req('/api/graph/wipe', { method: 'POST', body: {}, headers: { origin: off.origin } });
  assert.equal(refused.status, 403);
  assert.match(refused.json.hint, /allowDestructive/);

  const on = await rig(t, { config: { remote: { allowDestructive: true } } });
  const wiped = await on.req('/api/graph/wipe', { method: 'POST', body: {}, headers: { origin: on.origin } });
  assert.equal(wiped.status, 200, wiped.text);
  assert.equal(wiped.json.ok, true);
  // Still a write: the CSRF gate applies to it like any other.
  const forged = await on.req('/api/graph/wipe', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(forged.status, 403);
  // And nothing else rides on the opt-in.
  assert.equal((await on.req('/api/packs/install', { method: 'POST', body: {}, headers: { origin: on.origin } })).status, 403);
});

// ── the remote access log ───────────────────────────────────────────────────

test('access log: one line per write, allowed or refused, with who, where and the status; reads are not logged', async (t) => {
  const r = await rig(t);
  await r.req('/api/graph');
  await r.req('/api/store', { method: 'POST', body: { patch: { k: 1 } }, headers: { origin: r.origin } });
  await r.req('/api/packs/install?src=x', { method: 'POST', body: {}, headers: { origin: r.origin } });
  await r.req('/api/store', { method: 'POST', body: { patch: { k: 2 } }, headers: { origin: 'https://evil.example' } });
  await r.req('/api/store', { method: 'POST', body: { patch: { k: 3 } }, headers: { origin: r.origin }, token: false });

  const lines = await (async () => {
    let got = [];
    await waitUntil(() => (got = readLines(r.logFile)).length >= 3, { what: 'three access-log lines' });
    return got;
  })();
  assert.equal(lines.length, 3, 'the GET and the unauthenticated write are not logged');
  assert.deepEqual(lines.map((l) => [l.method, l.path, l.status]), [
    ['POST', '/api/store', 200],
    ['POST', '/api/packs/install', 403],
    ['POST', '/api/store', 403],
  ], 'query strings are dropped');
  for (const l of lines) {
    assert.equal(l.email, 'me@example.com');
    assert.equal(l.instance, r.id);
    assert.ok(!Number.isNaN(Date.parse(l.ts)));
  }
  assert.equal(fs.statSync(r.logFile).mode & 0o777, 0o600, 'it names who signed in — owner-only');
});

test('access log: a socket upgrade is logged as WS with 101', async (t) => {
  const r = await rig(t);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${r.p.port}/ws`, {
      headers: { host: r.host, 'cf-access-jwt-assertion': r.access.mint() }, origin: r.origin,
    });
    t.after(() => { try { ws.terminate(); } catch {} });
    ws.on('open', () => { ws.close(); resolve(); });
    ws.on('error', reject);
  });
  await waitUntil(() => readLines(r.logFile).length === 1, { what: 'the upgrade line' });
  const [l] = readLines(r.logFile);
  assert.deepEqual([l.method, l.path, l.status, l.instance], ['WS', '/ws', 101, r.id]);
});

test('access log: the default file is ~/.web-chat/tunnel/remote-access.log', async (t) => {
  withTempHome(t);
  const r = await rig(t, { log: false });
  await r.req('/api/store', { method: 'POST', body: { patch: { d: 1 } }, headers: { origin: r.origin } });
  await waitUntil(() => readLines(userPaths().remoteAccessLog).length === 1, { what: 'a line in the default log' });
});

test('access log: capped — past maxBytes the file rotates to .1 and a fresh one starts', (t) => {
  const file = tmpFile(t, 'a.log');
  const log = createAccessLog({ file, maxBytes: 400 });
  for (let i = 0; i < 12; i++) log.record({ email: 'me@example.com', instance: '0a1b2c3d', method: 'POST', path: `/api/store/${i}`, status: 200 });
  assert.ok(fs.statSync(file).size <= 400, 'the live file stays under the cap');
  assert.ok(fs.existsSync(`${file}.1`), 'the previous one was kept once');
  assert.ok(fs.statSync(`${file}.1`).size <= 400);
  const all = [...readLines(`${file}.1`), ...readLines(file)];
  assert.equal(all[all.length - 1].path, '/api/store/11', 'the newest line is in the live file');
  assert.ok(!fs.readdirSync(path.dirname(file)).includes('a.log.2'), 'one generation, never more');
});

test('access log: an unwritable file never throws, and says so once', (t) => {
  const dir = tmpFile(t, 'x');
  fs.mkdirSync(dir);
  const errors = [];
  const log = createAccessLog({ file: dir, onError: (e) => errors.push(e) }); // a directory: append fails
  log.record({ method: 'POST', path: '/a', status: 200 });
  log.record({ method: 'POST', path: '/b', status: 200 });
  assert.equal(errors.length, 1);
});

// ── the failed-sign-in throttle ─────────────────────────────────────────────

test('throttle: repeated 401s from one client are answered 429 before any check — valid token or not', async (t) => {
  let clock = 1_000_000;
  const throttle = createThrottle({ limit: 3, windowMs: 30_000, now: () => clock });
  const r = await rig(t, { throttle });
  const from = (ip, token) => r.p.request('/api/graph', { host: r.host, headers: { 'cf-connecting-ip': ip, ...(token ? { 'cf-access-jwt-assertion': token } : {}) } });

  for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.9', 'not.a.token')).status, 401, `failure ${i + 1}`);
  const callsBefore = r.access.state.calls;
  const blocked = await from('203.0.113.9', r.access.mint());
  assert.equal(blocked.status, 429, 'blocked, even with a good token');
  assert.equal(blocked.headers['retry-after'], '30');
  assert.equal(r.access.state.calls, callsBefore, 'no verification work was done for it');

  assert.equal((await from('198.51.100.7', r.access.mint())).status, 200, 'another client is unaffected');
  const health = await r.p.request('/api/health', { host: `127.0.0.1:${r.p.port}` });
  assert.equal(health.json.throttled, 1);

  clock += 30_000;
  assert.equal((await from('203.0.113.9', r.access.mint())).status, 200, 'the block lasts one window');
});

test('throttle: 403s (a signed-in account not on the allowlist) do not count', async (t) => {
  const throttle = createThrottle({ limit: 2, windowMs: 60_000 });
  const r = await rig(t, { throttle });
  const stranger = r.access.mint({ email: 'someone@else.test' });
  for (let i = 0; i < 4; i++) {
    assert.equal((await r.p.request('/api/graph', { host: r.host, headers: { 'cf-access-jwt-assertion': stranger } })).status, 403);
  }
});

test('createThrottle: windows, blocks and the memory bound', () => {
  let clock = 0;
  const th = createThrottle({ limit: 2, windowMs: 1000, maxKeys: 3, now: () => clock });
  assert.equal(th.fail('a'), false);
  clock = 1500; // the first failure's window is over
  assert.equal(th.fail('a'), false, 'failures spread wider than a window never add up');
  assert.equal(th.fail('a'), true, 'the limit inside one window starts a block, reported once');
  assert.equal(th.retryAfter('a'), 1);
  clock = 2600;
  assert.equal(th.retryAfter('a'), 0, 'and it ends');
  for (const k of ['b', 'c', 'd', 'e']) th.fail(k);
  assert.ok(th.size <= 3, 'never more than maxKeys remembered');
  assert.equal(clientKey({ headers: { 'cf-connecting-ip': ' 2001:DB8::1 ' }, socket: { remoteAddress: '127.0.0.1' } }), '2001:db8::1');
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
});

// ── X-WC-Remote ─────────────────────────────────────────────────────────────

test('X-WC-Remote: the daemon reports remote:true through the portal and false directly', async (t) => {
  const r = await rig(t);
  const via = await r.req('/api/health');
  assert.equal(via.status, 200);
  assert.equal(via.json.remote, true);
  const direct = await r.srv.api.get('/api/health');
  assert.equal(direct.json.remote, false);
});

test('X-WC-Remote: through the portal a pane cannot spawn raw html, whatever label the viewer sends; a component spawn goes through', async (t) => {
  const r = await rig(t);
  await r.srv.api.post('/api/render', { id: 'host-pane', html: '<p>host</p>' });
  for (const spoof of [{}, { 'x-wc-remote': '0' }, { 'X-WC-Remote': '' }]) {
    const res = await r.req('/api/pane/spawn', {
      method: 'POST', body: { parent: 'host-pane', id: 'evil', html: '<script>alert(1)</script>' },
      headers: { origin: r.origin, ...spoof },
    });
    assert.equal(res.status, 403, JSON.stringify(spoof));
    assert.equal(res.json.remote, true);
  }
  const mounts = (await r.srv.api.get('/api/mounts')).json.mounts;
  assert.equal(mounts.some((m) => m.id === 'evil'), false, 'nothing reached the surface');
  const comp = await r.req('/api/pane/spawn', {
    method: 'POST', body: { parent: 'host-pane', component: 'website', params: { url: 'https://example.com' } },
    headers: { origin: r.origin },
  });
  assert.equal(comp.status, 200, comp.text);
  assert.equal(comp.json.ok, true);
});

// ── theme library writes ────────────────────────────────────────────────────

test('themes: a remote viewer cannot save a theme — the picker still lists and applies', async (t) => {
  withTempHome(t);
  const r = await rig(t);
  const evil = { name: 'x', location: 'system', set_default: true, css: '@import url(https://attacker.example/x.css);' };
  const res = await r.req('/api/themes', { method: 'POST', body: evil, headers: { origin: r.origin } });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.remote, true);
  assert.match(res.json.hint, /save_theme/);
  assert.equal(fs.existsSync(userPaths().theme), false, 'nothing reached ~/.web-chat/theme.json');
  assert.equal(fs.existsSync(path.join(userPaths().themesDir, 'x.json')), false, 'nor the system library');
  const list = await r.req('/api/themes');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.themes));
});

test('themes: the daemon itself refuses a labelled remote save that reaches past the project', async (t) => {
  withTempHome(t);
  const { api } = await withServer(t);
  const remote = { 'x-wc-remote': '1' };
  for (const body of [
    { name: 'sys', location: 'system', tokens: { '--wc-bg': '#000' } },
    { name: 'def', location: 'local', set_default: true, tokens: { '--wc-bg': '#000' } },
  ]) {
    const res = await api.post('/api/themes', body, remote);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(res.json.remote, true);
  }
  assert.equal(fs.existsSync(userPaths().theme), false);
  assert.equal(fs.existsSync(path.join(userPaths().themesDir, 'sys.json')), false);
  assert.equal((await api.post('/api/themes', { name: 'mine', tokens: { '--wc-bg': '#000' } }, remote)).status, 200, 'a plain local save is not refused by the daemon');
  assert.equal((await api.post('/api/themes', { name: 'sys', location: 'system', set_default: true, tokens: {} })).status, 200, 'nor is the host\'s own call');
});

// ── the host's directory layout ─────────────────────────────────────────────

test('host paths: remote-allowed reads name no absolute root, home or binary path; the host still sees them', async (t) => {
  const r = await rig(t);
  const home = require('../lib/core/paths').homeDir();
  const leaks = (text) => text.includes(r.srv.root) || text.includes(fs.realpathSync(r.srv.root)) || text.includes(home);
  for (const p of ['/api/services/pending', '/api/services/pack/acme-ops', '/api/packs', '/api/packs/audit', '/api/replay/capabilities']) {
    const res = await r.req(p);
    assert.equal(res.status, 200, `${p}: ${res.text}`);
    assert.equal(leaks(res.text), false, `${p} leaked a host path: ${res.text}`);
  }
  assert.equal((await r.req('/api/services/pending')).json.root, '<project>');
  assert.equal((await r.req('/api/services/pack/acme-ops')).json.root, '<project>');
  assert.equal((await r.req('/api/packs')).json.root, '<project>');
  const caps = (await r.req('/api/replay/capabilities')).json;
  assert.equal(typeof caps.chrome, 'boolean', 'whether, not where');
  assert.equal(typeof caps.ffmpeg, 'boolean');
  // Locally nothing changes.
  assert.equal((await r.srv.api.get('/api/services/pending')).json.root, r.srv.root);
  assert.equal((await r.srv.api.get('/api/packs')).json.root, r.srv.root);
});

test('redactHostPaths: masks the root and home at any depth, root first; leaves everything else', () => {
  const { redactHostPaths } = require('../lib/core/paths');
  const home = '/Users/someone';
  const root = '/Users/someone/work/proj';
  const input = {
    root,
    n: 3,
    ok: true,
    list: [`${root}/.web-chat/packs/backup`, `${home}/.web-chat/tunnel`, '/opt/other'],
    deep: { error: `could not write ${root}/x.json` },
  };
  const out = redactHostPaths(input, { root, home });
  assert.deepEqual(out, {
    root: '<project>',
    n: 3,
    ok: true,
    list: ['<project>/.web-chat/packs/backup', '~/.web-chat/tunnel', '/opt/other'],
    deep: { error: 'could not write <project>/x.json' },
  });
  assert.equal(input.root, root, 'the input is not touched');
});

// The tunnel portal follows tunnel.json while it runs (lib/portal/index.js
// reloadConfig over lib/portal/config-watch.js): a valid edit applies at once,
// an invalid file fails closed, and what needs a new cloudflared is reported
// as "restart needed" instead of applied.
//
// Each test writes the file the portal watches, then edits it the way an
// operator (or `tunnel setup`, atomically) would, and waits for the portal to
// notice — the short poll keeps that quick even where fs.watch is silent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { withServer, withPortal, waitUntil } = require('../test-support/helpers');
const { createFakeAccess } = require('../test-support/fake-access');
const { registerInstance, instanceId } = require('../lib/util/registry');
const { sessionHost } = require('../lib/tunnel/config');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { CLOSE_HIDDEN, CLOSE_UNAVAILABLE } = require('../lib/portal/ws-relay');
const { watchConfigFile } = require('../lib/portal/config-watch');

const OTHER = 'friend@example.com';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-portal-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// One daemon + one portal watching `file`, which starts out allowing both the
// fake's own account and OTHER.
async function rig(t, { raw } = {}) {
  const srv = await withServer(t);
  registerInstance({ root: srv.root, port: srv.port, pid: process.pid });
  const id = instanceId(srv.root);
  const access = createFakeAccess();
  const file = path.join(tmpDir(t), 'tunnel.json');
  const first = raw || access.config({ allow: { emails: [access.email, OTHER], domains: [] } });
  writeJsonAtomic(file, first);
  const lines = [];
  const p = await withPortal(t, {
    config: first,
    fetchJwks: access.fetchJwks,
    configFile: file,
    configPollMs: 50,
    configDebounceMs: 10,
    log: (l) => lines.push(l),
  });
  const host = sessionHost(p.config, id);
  const origin = `https://${host}`;
  const req = (pathStr, { email = access.email, method = 'GET', h = host, headers = {}, body } = {}) => p.request(pathStr, {
    host: h, method, body,
    headers: {
      'cf-access-jwt-assertion': access.mint({ email }),
      ...(body != null ? { 'content-type': 'application/json', origin } : {}),
      ...headers,
    },
  });
  const health = async () => (await p.request('/api/health', { host: `127.0.0.1:${p.port}` })).json;
  const edit = (over) => writeJsonAtomic(file, { ...first, ...over });
  return { srv, p, id, host, origin, access, file, first, lines, req, health, edit };
}

function openWs(t, r, { email = r.access.email } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${r.p.port}/ws`, {
      headers: { host: r.host, 'cf-access-jwt-assertion': r.access.mint({ email }) }, origin: r.origin,
    });
    t.after(() => { try { ws.terminate(); } catch {} });
    ws.on('unexpected-response', (_q, res) => { res.resume(); const e = new Error(`HTTP ${res.statusCode}`); e.statusCode = res.statusCode; reject(e); });
    ws.on('error', reject);
    ws.on('message', (data) => {
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch {}
      if (msg && msg.type === 'hello') resolve(ws);
    });
  });
}

const closeCode = (ws, ms = 4000) => new Promise((resolve) => {
  ws.on('close', (c) => resolve(c));
  setTimeout(() => resolve('still open'), ms).unref();
});

test('revoking an email: its next request is refused and its open socket is cut; the other account stays', async (t) => {
  const r = await rig(t);
  assert.equal((await r.req('/api/graph', { email: OTHER })).status, 200, 'allowed to start with');
  const gone = await openWs(t, r, { email: OTHER });
  const kept = await openWs(t, r);
  let keptCode = null;
  kept.on('close', (c) => { keptCode = c; });
  const closed = closeCode(gone);

  r.edit({ allow: { emails: [r.access.email], domains: [] } });
  assert.equal(await closed, CLOSE_HIDDEN, 'the revoked account\'s live socket is closed with the policy code');
  const refused = await r.req('/api/graph', { email: OTHER });
  assert.equal(refused.status, 403);
  assert.equal((await r.req('/api/graph')).status, 200, 'the account still listed is untouched');
  await assert.rejects(openWs(t, r, { email: OTHER }), (e) => e.statusCode === 403, 'a reconnect is refused too');
  assert.equal(keptCode, null);
  assert.equal(kept.readyState, WebSocket.OPEN);

  const h = await r.health();
  assert.equal(h.allowlist, 1);
  assert.equal(h.config.state, 'ok');
  assert.ok(r.lines.some((l) => /allowlist/.test(l) && /closed 1 relay/.test(l)), r.lines.join('\n'));
});

test('an added email, expose.exclude and allowDestructive apply live, and config_fp follows the file', async (t) => {
  const access = createFakeAccess();
  const r = await rig(t, { raw: access.config() });
  const before = (await r.health()).config_fp;
  assert.equal((await r.req('/api/graph', { email: OTHER })).status, 403);
  assert.equal((await r.req('/api/graph/wipe', { method: 'POST', body: {} })).status, 403, 'a wipe is refused by default');

  r.edit({ allow: { emails: [access.email, OTHER], domains: [] }, remote: { allowDestructive: true } });
  assert.ok(await waitUntil(async () => (await r.req('/api/graph', { email: OTHER })).status === 200), 'the added account gets in');
  assert.notEqual((await r.req('/api/graph/wipe', { method: 'POST', body: {} })).status, 403, 'allowDestructive now in force');
  const { configFingerprint, normalizeConfig } = require('../lib/tunnel/config');
  assert.equal((await r.health()).config_fp, configFingerprint(normalizeConfig(JSON.parse(fs.readFileSync(r.file, 'utf8')))),
    'what the portal enforces is exactly the file — `tunnel up` will not restart it');
  assert.notEqual((await r.health()).config_fp, before);

  r.edit({ allow: { emails: [access.email, OTHER], domains: [] }, expose: { exclude: [r.id] } });
  assert.ok(await waitUntil(async () => (await r.req('/')).status === 404), 'the excluded project answers like a stopped one');
});

test('a corrupt tunnel.json fails closed (503 everywhere but the loopback health, sockets cut); fixing it recovers', async (t) => {
  const r = await rig(t);
  const ws = await openWs(t, r);
  const closed = closeCode(ws);

  fs.writeFileSync(r.file, '{ "hostname": "wc.example.test", "allow": ');
  assert.equal(await closed, CLOSE_UNAVAILABLE, 'the live socket is cut');
  const session = await r.req('/api/graph');
  assert.equal(session.status, 503);
  assert.match(session.json.error, /tunnel\.json/);
  assert.equal((await r.req('/', { h: 'wc.example.test' })).status, 503, 'the picker too');
  assert.equal((await r.req('/', { h: 'somewhere.else.test' })).status, 503, 'even a foreign host — nothing is judged on a config it cannot read');
  await assert.rejects(openWs(t, r), (e) => e.statusCode === 503, 'a reconnect');
  const h = await r.health();
  assert.equal(h.ok, true, 'the portal itself still answers its probe');
  assert.equal(h.config.state, 'invalid');
  assert.match(h.config.error, /unreadable/);
  assert.ok(r.lines.some((l) => /FAILING CLOSED/.test(l)), r.lines.join('\n'));

  // Valid JSON that is not a valid config is the same.
  r.edit({ allow: { emails: [], domains: [] } });
  assert.ok(await waitUntil(async () => /allow\.emails is empty/.test((await r.health()).config.error || '')));
  assert.equal((await r.req('/api/graph')).status, 503);

  // Deleted is the same.
  fs.rmSync(r.file);
  assert.ok(await waitUntil(async () => /none at/.test((await r.health()).config.error || '')));
  assert.equal((await r.req('/api/graph')).status, 503);

  r.edit({});
  assert.ok(await waitUntil(async () => (await r.health()).config.state === 'ok'));
  assert.equal((await r.req('/api/graph')).status, 200, 'serving again');
  await openWs(t, r);
  assert.ok(r.lines.some((l) => /valid again/.test(l)), r.lines.join('\n'));
});

test('a hostname change is not hot-applied: restart needed, the old hostname still served — the allowlist edit beside it is', async (t) => {
  const r = await rig(t);
  r.edit({ hostname: 'remote.example.test', allow: { emails: [r.access.email], domains: [] } });
  assert.ok(await waitUntil(async () => (await r.health()).config.state === 'restart-needed'));
  const h = await r.health();
  assert.deepEqual(h.config.restart, ['hostname']);
  assert.equal(h.hostname, 'wc.example.test', 'still the hostname cloudflared routes');
  assert.equal((await r.req('/api/graph')).status, 200, 'the session on the old hostname is still served');
  assert.equal((await r.req('/api/graph', { email: OTHER })).status, 403, 'the allowlist in the same edit is in force');
  const newHost = sessionHost({ hostname: 'remote.example.test', style: 'flat' }, r.id);
  assert.equal((await r.req('/api/graph', { h: newHost })).status, 421, 'the new hostname is not routed');
  assert.ok(r.lines.some((l) => /changed hostname — restart needed/.test(l) && /tunnel up/.test(l)), r.lines.join('\n'));

  const { configFingerprint, normalizeConfig } = require('../lib/tunnel/config');
  assert.notEqual(h.config_fp, configFingerprint(normalizeConfig(JSON.parse(fs.readFileSync(r.file, 'utf8')))),
    'so `tunnel up` sees a portal that is not enforcing the file, and restarts it');

  // Put back, the need goes away.
  r.edit({ allow: { emails: [r.access.email], domains: [] } });
  assert.ok(await waitUntil(async () => (await r.health()).config.state === 'ok'));
});

test('style and tunnel changes also need a restart; an Access AUD change applies live', async (t) => {
  const r = await rig(t);
  r.edit({ style: 'nested', tunnel: { kind: 'token' } });
  assert.ok(await waitUntil(async () => (await r.health()).config.state === 'restart-needed'));
  assert.deepEqual((await r.health()).config.restart, ['style', 'tunnel']);

  r.edit({ access: { team: r.access.team, aud: 'another-aud' } });
  assert.ok(await waitUntil(async () => (await r.req('/api/graph')).status === 401), 'a token for the old AUD no longer verifies');
  assert.equal((await r.health()).config.state, 'ok');

  // A new team is a new key set: the portal asks for that team's keys (the
  // fake Access serves only its own team, so the answer is the cold-key-set
  // 503 — not the old keys failing the issuer check, 401).
  r.edit({ access: { team: 'otherteam', aud: r.access.aud } });
  assert.ok(await waitUntil(async () => (await r.req('/api/graph')).status === 503), 'the new team\'s keys are what is asked for');
});

// The connector token is cloudflared's, handed over at its launch, so a new
// one is never applied — the portal notices it (the same watcher as
// tunnel.json) and says "restart needed" on its health, which `tunnel
// status|up` read (test/tunnel-cli.test.js).
test('a changed connector token is reported as restart-needed, never applied; putting it back clears it', async (t) => {
  const { tokenFingerprint } = require('../lib/tunnel/cloudflared');
  const access = createFakeAccess();
  const dir = tmpDir(t);
  const file = path.join(dir, 'tunnel.json');
  const tokenFile = path.join(dir, 'token');
  const raw = access.config({ tunnel: { kind: 'token' } });
  writeJsonAtomic(file, raw);
  fs.writeFileSync(tokenFile, 'first-token\n', { mode: 0o600 });
  const lines = [];
  const p = await withPortal(t, {
    config: raw, fetchJwks: access.fetchJwks, configFile: file, tokenFile,
    configPollMs: 50, configDebounceMs: 10, log: (l) => lines.push(l),
  });
  const health = async () => (await p.request('/api/health', { host: `127.0.0.1:${p.port}` })).json;

  let h = await health();
  assert.deepEqual({ state: h.token.state, fp: h.token.fp, live: h.token.live },
    { state: 'ok', fp: tokenFingerprint('first-token'), live: true });
  assert.ok(!JSON.stringify(h).includes('first-token'), 'the token itself is never on health');
  const fpBefore = h.config_fp;

  fs.writeFileSync(tokenFile, 'second-token\n');
  assert.ok(await waitUntil(async () => (await health()).token.state === 'restart-needed'));
  h = await health();
  assert.equal(h.token.fp, tokenFingerprint('first-token'), 'still the token cloudflared started with');
  assert.equal(h.config.state, 'ok', 'tunnel.json is untouched — only the token needs the restart');
  assert.equal(h.config_fp, fpBefore);
  assert.ok(lines.some((l) => /connector token changed — restart needed/.test(l) && /tunnel up/.test(l)), lines.join('\n'));

  fs.writeFileSync(tokenFile, 'first-token\n');
  assert.ok(await waitUntil(async () => (await health()).token.state === 'ok'), 'the same token back is no change');

  fs.rmSync(tokenFile);
  assert.ok(await waitUntil(async () => (await health()).token.state === 'restart-needed'), 'a removed token is a change too');
});

test('a local tunnel (or none) follows no connector token: health.token is null', async (t) => {
  const access = createFakeAccess();
  const dir = tmpDir(t);
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'x\n');
  for (const raw of [access.config({ tunnel: { kind: 'local', name: 'wc' } }), access.config()]) {
    const p = await withPortal(t, { config: raw, fetchJwks: access.fetchJwks, tokenFile, configPollMs: 50, configDebounceMs: 10 });
    const h = (await p.request('/api/health', { host: `127.0.0.1:${p.port}` })).json;
    assert.equal(h.token, null);
  }
});

test('watchConfigFile: one call per real change, atomic renames seen, a directory that appears later is polled', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'later', 'tunnel.json');
  let calls = 0;
  const w = watchConfigFile(file, () => { calls += 1; }, { pollMs: 40, debounceMs: 10 });
  t.after(() => w.stop());
  assert.equal(calls, 1, 'the first check always reports (absent is a state)');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(calls, 1, 'nothing changed, nothing reported');

  writeJsonAtomic(file, { a: 1 });
  assert.ok(await waitUntil(() => calls === 2), 'a file in a directory that did not exist is found by the poll');
  writeJsonAtomic(file, { a: 1 });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(calls, 2, 'the same bytes rewritten is not a change');
  writeJsonAtomic(file, { a: 2 });
  assert.ok(await waitUntil(() => calls === 3));
  w.stop();
  writeJsonAtomic(file, { a: 3 });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(calls, 3, 'stopped means stopped');
});

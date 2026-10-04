// The chat mirror's audience gate (lib/server/audience, spec §5.4): the level
// of a request — local, a remote viewer through the portal at the project's
// opt-in, or a network peer held to the heartbeat whatever it sends (ruling Q9,
// carve-strict) — the one host-only test, the opt-in followed live from
// tunnel.json, and the two facts lib/core/cors gives the gate
// (isLoopbackAddress, and warnIfExposed's sentence about the mirror). Then the
// two routes that report a viewer's level: GET /api/mirror/access and
// /api/health's `mirror` object.
//
// A remote viewer is simulated as the portal sends one, `X-WC-Remote: 1` from
// loopback, and a network peer with a stubbed `req.socket.remoteAddress`
// (spec §10.1): plain request objects for the gate itself; for the routes, a
// bare Express app whose first, test-only middleware stubs the address. The
// opt-in is a real tunnel.json in a scratch directory, read through the real
// lib/tunnel/config — never the developer's ~/.web-chat.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const asyncHooks = require('async_hooks');
const express = require('express');
const { waitUntil } = require('../test-support/helpers');
const { request } = require('../lib/client');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { isLoopbackAddress, warnIfExposed } = require('../lib/core/cors');
const { classify, MIRROR_HINT, MIRROR_FULL_HINT } = require('../lib/core/remote-policy');
const { instanceId } = require('../lib/util/registry');
const { createAudience, peerOf, HOST_ONLY, NETWORK_HINT, COMMANDS } = require('../lib/server/audience');
const { mountMirrorAccessRoutes } = require('../lib/server/routes/mirror-access');
const { mountHealthRoutes } = require('../lib/server/routes/health');

// Spec §5.3's words for a host-only refusal, which the daemon's own refusal
// repeats (§5.4: 403 { ok:false, hint: HOST_ONLY }).
const SPEC_HOST_ONLY = 'this is the Claude Code harness\'s endpoint — it is driven from the host, never from a browser';

// A valid tunnel.json (lib/tunnel/config normalizeConfig), with `mirror` as
// its remote.mirror when given.
const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
function writeTunnel(file, mirror) {
  writeJsonAtomic(file, mirror ? { ...TUNNEL, remote: { mirror } } : { ...TUNNEL });
}

// A scratch project root, and where its tunnel.json goes (absent until written).
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-audience-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  return { root, configFile: path.join(dir, 'tunnel', 'tunnel.json') };
}

// An audience over that file, with a short poll, stopped when the test ends.
function audienceOf(t, { root, configFile }) {
  const a = createAudience({ root, configFile, pollMs: 25 });
  t.after(() => a.stop());
  return a;
}

// A request as the gate reads it: its peer's address and its headers.
const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
const LOCAL = () => req('127.0.0.1');
const REMOTE = () => req('127.0.0.1', { 'x-wc-remote': '1' });
const NETWORK = (headers) => req('10.0.0.7', headers);

// Runs one Express middleware against a request: did it call next(), and what
// did it answer.
function run(mw, r) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  let passed = false;
  mw(r, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
}

// ── lib/core/cors ───────────────────────────────────────────────────────────

test('isLoopbackAddress: 127.0.0.0/8, ::1 and ::ffff:127.x.x.x are this machine; nothing else is', () => {
  for (const a of ['127.0.0.1', '127.255.0.1', '127.0.0.0', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:127.9.8.7', '::FFFF:127.0.0.1']) {
    assert.equal(isLoopbackAddress(a), true, a);
  }
  for (const a of ['10.0.0.1', '::ffff:10.0.0.1', undefined, null, '', 0, {}, '128.0.0.1', '126.255.255.255',
    '127.1', '127.0.0.01', '127.0.0.256', '127.0.0.1.5', ' 127.0.0.1', '127.0.0.1 ', '::', '::2', '0.0.0.0',
    '0:0:0:0:0:0:0:1', '::ffff:7f00:1', '::ffff:', 'localhost', '192.168.1.20', 'fe80::1', '2001:db8::5']) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
});

test('warnIfExposed: a network bind says, beside the exposure, that the chat mirror shows its peers only Claude\'s status', () => {
  const SENTENCE = 'The chat mirror shows network peers only Claude\'s status (states and timings), never the conversation, and answers none of their host-only requests.';
  for (const host of ['0.0.0.0', '::', '10.1.2.3']) {
    const lines = [];
    const msg = warnIfExposed((l) => lines.push(l), host);
    assert.ok(msg.startsWith(`WEB_CHAT_HOST=${host} — `), `${host}: the exposure itself comes first`);
    assert.ok(msg.endsWith(` ${SENTENCE}`), `${host}: then the mirror's sentence (${msg})`);
    assert.deepStrictEqual(lines, [`[web-chat] ${msg}`], 'said once, as it is returned');
  }
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const lines = [];
    assert.equal(warnIfExposed((l) => lines.push(l), host), null, host);
    assert.deepStrictEqual(lines, [], `${host}: a loopback bind exposes nothing, so nothing is said`);
  }
});

// ── the level of a request ──────────────────────────────────────────────────

test('levelOf: a loopback peer is local; with the portal\'s label it gets the project\'s opt-in, and none is basic', (t) => {
  const s = scratch(t);
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'basic', 'no tunnel.json: remote access is not set up');
  writeTunnel(s.configFile);
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'basic', 'set up, with no opt-in for this project');
  for (const optIn of ['read', 'full']) {
    writeTunnel(s.configFile, { [s.root]: optIn });
    const a = audienceOf(t, s);
    assert.equal(a.remoteLevel(), optIn);
    for (const addr of ['127.0.0.1', '127.3.4.5', '::1', '::ffff:127.0.0.1']) {
      assert.equal(a.levelOf(req(addr)), 'local', addr);
      assert.equal(a.levelOf(req(addr, { 'x-wc-remote': '1' })), optIn, `${addr} with the label, opted in at ${optIn}`);
    }
  }
});

test('levelOf: a network peer is basic whatever it sends — the portal\'s label, a full opt-in, WEB_CHAT_MIRROR_NETWORK=1', (t) => {
  const prev = process.env.WEB_CHAT_MIRROR_NETWORK;
  process.env.WEB_CHAT_MIRROR_NETWORK = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.WEB_CHAT_MIRROR_NETWORK;
    else process.env.WEB_CHAT_MIRROR_NETWORK = prev;
  });
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'full', [instanceId(s.root)]: 'full' });
  const a = audienceOf(t, s);
  assert.equal(a.levelOf(REMOTE()), 'full', 'the opt-in is full, for a viewer through the portal');
  for (const addr of ['10.0.0.7', '192.168.1.20', '::ffff:10.0.0.1', 'fe80::1', '2001:db8::5', '', undefined]) {
    for (const headers of [{}, { 'x-wc-remote': '1' }, { origin: 'http://localhost:5173' }, { 'x-wc-remote': '1', 'sec-fetch-mode': 'cors' }]) {
      assert.equal(a.levelOf(req(addr, headers)), 'basic', `${addr} ${JSON.stringify(headers)}`);
      assert.equal(a.accessView(req(addr, headers)).level, 'basic');
    }
  }
  assert.equal(a.levelOf({ headers: { 'x-wc-remote': '1' } }), 'basic', 'no socket at all');
  assert.equal(a.levelOf(undefined), 'basic');
  // There is no override to read (Q9): nothing in the gate reads the environment.
  const src = fs.readFileSync(require.resolve('../lib/server/audience'), 'utf8');
  assert.doesNotMatch(src, /process\.env/);
});

test('the opt-in names this project exactly — its root or its instance id — and a file that fails grants nothing', (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [instanceId(s.root)]: 'read' });
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'read', 'by instance id');
  writeTunnel(s.configFile, { [path.dirname(s.root)]: 'full' });
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'basic', 'a grant on the directory above does not spread to it');
  writeTunnel(s.configFile, { [s.root]: 'full', [instanceId(s.root)]: 'read' });
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'read', 'two grants for one project: the narrower');
  fs.writeFileSync(s.configFile, '{ "hostname": ');
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'basic', 'unreadable');
  writeJsonAtomic(s.configFile, { ...TUNNEL, remote: { mirror: { [s.root]: 'everything' } } });
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'basic', 'a value other than read or full fails the whole file');
  writeJsonAtomic(s.configFile, { remote: { mirror: { [s.root]: 'full' } } });
  assert.equal(audienceOf(t, s).levelOf(REMOTE()), 'basic', 'an opt-in in a tunnel.json the portal would refuse');
});

test('socketLevel: a socket keeps the peer of its upgrade; only a remote viewer\'s level follows the opt-in', (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'full' });
  const a = audienceOf(t, s);
  assert.deepStrictEqual([LOCAL(), REMOTE(), NETWORK(), NETWORK({ 'x-wc-remote': '1' })].map(a.peerOf),
    ['local', 'remote', 'network', 'network']);
  assert.equal(a.peerOf, peerOf, 'the module\'s one peer rule');
  const sock = (r) => ({ _wc: { peer: a.peerOf(r) } });
  assert.equal(a.socketLevel(sock(LOCAL())), 'local');
  assert.equal(a.socketLevel(sock(REMOTE())), 'full');
  assert.equal(a.socketLevel(sock(NETWORK({ 'x-wc-remote': '1' }))), 'basic');
  assert.equal(a.socketLevel({}), 'basic', 'a socket with no peer on record');
  assert.equal(a.socketLevel({ _wc: { peer: 'admin' } }), 'basic');
  assert.equal(a.socketLevel(null), 'basic');
});

// ── the host-only test ──────────────────────────────────────────────────────

test('isHost: a lib/client request from loopback is the host; a browser, a remote viewer and a network peer are not', (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'full' });
  const a = audienceOf(t, s);
  assert.equal(a.isHost(LOCAL()), true, 'no Origin and no Sec-Fetch-*: what lib/client sends');
  assert.equal(a.isHost(req('::1')), true);
  for (const h of [{ origin: 'http://localhost:5173' }, { origin: 'null' }, { 'sec-fetch-mode': 'cors' },
    { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-user': '?1' }]) {
    assert.equal(a.isHost(req('127.0.0.1', h)), false, `a browser: ${JSON.stringify(h)}`);
  }
  assert.equal(a.isHost(REMOTE()), false, 'a remote viewer, even one opted in at full');
  assert.equal(a.isHost(NETWORK()), false, 'a network peer that sends nothing a browser would');
  assert.equal(a.isHost(NETWORK({ 'x-wc-remote': '1' })), false);
  assert.equal(a.isHost(req(undefined)), false, 'a socket already gone');
});

test('requireHost: 403 with the host-only hint — the portal\'s own words for the same refusal — and next() for the host', (t) => {
  const a = audienceOf(t, scratch(t));
  assert.equal(HOST_ONLY, SPEC_HOST_ONLY);
  assert.equal(HOST_ONLY, classify('POST', '/api/hooks/event').hint, 'read from the portal\'s table, not copied');
  const gate = a.requireHost();
  assert.deepStrictEqual(run(gate, LOCAL()), { passed: true, status: 200, body: undefined });
  for (const r of [req('127.0.0.1', { origin: 'http://localhost:5173' }), req('127.0.0.1', { 'sec-fetch-mode': 'cors' }), REMOTE(), NETWORK()]) {
    assert.deepStrictEqual(run(gate, r), { passed: false, status: 403, body: { ok: false, hint: SPEC_HOST_ONLY } },
      JSON.stringify(r));
  }
});

// ── the level gate and the access view ──────────────────────────────────────

test('requireMirror: a level that meets the need passes; below it, 403 with the level, the label and what lets it in', (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'read' });
  const a = audienceOf(t, s);
  assert.equal(run(a.requireMirror('basic'), NETWORK()).passed, true, 'the heartbeat reaches everyone');
  assert.equal(run(a.requireMirror('read'), REMOTE()).passed, true);
  assert.equal(run(a.requireMirror('full'), LOCAL()).passed, true);
  assert.equal(run(a.requireMirror('local'), LOCAL()).passed, true);
  assert.deepStrictEqual(run(a.requireMirror('full'), REMOTE()),
    { passed: false, status: 403, body: { ok: false, mirror: 'read', remote: true, hint: MIRROR_FULL_HINT } });
  assert.deepStrictEqual(run(a.requireMirror('local'), REMOTE()),
    { passed: false, status: 403, body: { ok: false, mirror: 'read', remote: true, hint: SPEC_HOST_ONLY } });
  // A network peer is told where the conversation does go, never to opt in:
  // no `tunnel mirror on` reaches it.
  assert.deepStrictEqual(run(a.requireMirror('read'), NETWORK({ 'x-wc-remote': '1' })),
    { passed: false, status: 403, body: { ok: false, mirror: 'basic', remote: true, hint: NETWORK_HINT } });
  assert.match(NETWORK_HINT, /WEB_CHAT_HOST/);
  assert.match(NETWORK_HINT, /tunnel/);
  const none = audienceOf(t, scratch(t));
  assert.deepStrictEqual(run(none.requireMirror('read'), REMOTE()),
    { passed: false, status: 403, body: { ok: false, mirror: 'basic', remote: true, hint: MIRROR_HINT } });
  for (const bad of ['off', 'everything', undefined, 'LOCAL']) {
    assert.throws(() => a.requireMirror(bad), TypeError, String(bad));
  }
  // The order is remote-policy's, not a copy of it.
  assert.deepStrictEqual(['basic', 'read', 'full', 'local', 'off'].map(a.rank), [0, 1, 2, 3, -1]);
  assert.equal(a.atLeast('full', 'read'), true);
  assert.equal(a.atLeast('read', 'full'), false);
  assert.equal(a.atLeast('bogus', 'basic'), false);
});

test('accessView: the asker\'s level and label for everyone, the host commands, and the opt-in itself for the host only', (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'read' });
  const a = audienceOf(t, s);
  assert.deepStrictEqual(COMMANDS, {
    on: 'claude-web-chat tunnel mirror on',
    read_only: 'claude-web-chat tunnel mirror on --read-only',
    off: 'claude-web-chat tunnel mirror off',
  });
  assert.deepStrictEqual(a.accessView(LOCAL()),
    { ok: true, level: 'local', remote: false, project: { remote_level: 'read', tunnel_configured: true }, commands: { ...COMMANDS } });
  assert.deepStrictEqual(a.accessView(REMOTE()), { ok: true, level: 'read', remote: true, commands: { ...COMMANDS } });
  assert.deepStrictEqual(a.accessView(NETWORK()), { ok: true, level: 'basic', remote: false, commands: { ...COMMANDS } });
  assert.deepStrictEqual(audienceOf(t, scratch(t)).accessView(LOCAL()).project, { remote_level: 'off', tunnel_configured: false },
    'no tunnel.json: remote access is not set up');
});

test('an audience with no opt-in file watches nothing and holds every remote viewer to the heartbeat; root is required otherwise', async () => {
  assert.throws(() => createAudience({}), /root/, 'the default file needs the project to look up');
  assert.throws(() => createAudience({ configFile: path.join(os.tmpdir(), 'tunnel.json') }), /root/);
  const a = createAudience({ configFile: null });
  assert.equal(a.levelOf(LOCAL()), 'local');
  assert.equal(a.levelOf(REMOTE()), 'basic');
  assert.equal(a.levelOf(NETWORK()), 'basic');
  assert.equal(a.remoteLevel(), 'off');
  assert.deepStrictEqual(a.accessView(LOCAL()).project, { remote_level: 'off', tunnel_configured: false });
  await a.stop();
});

// ── following the opt-in ────────────────────────────────────────────────────

test('the opt-in is followed live: an edit moves a remote viewer\'s level and tells onChange(from, to)', async (t) => {
  const s = scratch(t);
  const a = audienceOf(t, s);
  const seen = [];
  a.onChange(() => { throw new Error('one listener failing stops no other'); });
  a.onChange((from, to) => seen.push([from, to]));
  const gone = [];
  const off = a.onChange((from, to) => gone.push([from, to]));
  off();
  assert.throws(() => a.onChange('not a function'), TypeError);
  const remoteIs = (level, what) => waitUntil(() => a.levelOf(REMOTE()) === level, { timeout: 10000, interval: 10, what });

  assert.equal(a.levelOf(REMOTE()), 'basic');
  writeTunnel(s.configFile, { [s.root]: 'read' });
  await remoteIs('read', 'the file appearing with an opt-in of read');
  writeTunnel(s.configFile, { [s.root]: 'full' });
  await remoteIs('full', 'the file replaced (a new inode) with an opt-in of full');
  writeTunnel(s.configFile, { [s.root]: 'full' });
  fs.writeFileSync(s.configFile, '{ not json');
  await remoteIs('basic', 'a broken file read as no opt-in');
  fs.rmSync(s.configFile);
  writeTunnel(s.configFile, { [instanceId(s.root)]: 'read' });
  await remoteIs('read', 'the opt-in by instance id');

  assert.deepStrictEqual(seen, [['off', 'read'], ['read', 'full'], ['full', 'off'], ['off', 'read']],
    'one call per change, and none for a rewrite that changed nothing');
  assert.deepStrictEqual(gone, [], 'an unsubscribed listener hears nothing');
  assert.equal(a.levelOf(LOCAL()), 'local', 'a local peer never moves');
  assert.equal(a.levelOf(NETWORK({ 'x-wc-remote': '1' })), 'basic', 'nor does a network peer');
});

test('stop() ends the watcher and leaves no handle behind', async (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'read' });
  // Every timer and file watch the audience opens — at its start, and from its
  // own callbacks after (anything triggered by what it opened) — tracked from
  // creation to destruction. Unref'd handles never show in
  // process.getActiveResourcesInfo(), so this is how one is seen at all.
  const TRACKED = new Set(['Timeout', 'Immediate', 'FSEVENTWRAP', 'STATWATCHER']);
  const owned = new Set();
  const live = new Map();
  let recording = false;
  const hook = asyncHooks.createHook({
    init(id, type, trigger) {
      if (!recording && !owned.has(trigger)) return;
      owned.add(id);
      if (TRACKED.has(type)) live.set(id, type);
    },
    destroy(id) { live.delete(id); },
  });
  hook.enable();
  t.after(() => hook.disable());
  recording = true;
  const a = createAudience({ root: s.root, configFile: s.configFile, pollMs: 20 });
  recording = false;
  const opened = new Set(live.values());
  assert.ok(opened.has('Timeout'), `the poll is tracked (opened: ${[...opened]})`);
  assert.ok(opened.has('FSEVENTWRAP'), `the file watch is tracked (opened: ${[...opened]})`);

  writeTunnel(s.configFile, { [s.root]: 'full' }); // a new inode: the watch re-arms
  await waitUntil(() => a.levelOf(REMOTE()) === 'full', { timeout: 10000, interval: 10, what: 'the edit' });
  const changes = [];
  a.onChange((from, to) => changes.push([from, to]));

  await a.stop();
  await waitUntil(() => live.size === 0, { timeout: 10000, interval: 10, what: 'every timer and watch the audience opened to close' });
  writeTunnel(s.configFile, { [s.root]: 'read' });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(changes, [], 'nothing is read, or called, after stop()');
  assert.equal(a.remoteLevel(), 'full', 'the last level read stays');
  await a.stop(); // idempotent
});

// ── the routes ──────────────────────────────────────────────────────────────

// A route host: a bare Express app with the routes under test mounted on a
// fake ctx. Its first middleware is the test's network peer: a request
// carrying x-test-peer has its socket report that address while the routes
// run (they answer synchronously), and the real socket is put back after.
async function routeHost(t, ctx) {
  const app = express();
  app.use((r, res, next) => {
    const addr = r.headers['x-test-peer'];
    if (!addr) return next();
    const real = r.socket;
    r.socket = { remoteAddress: addr };
    try { next(); } finally { r.socket = real; }
  });
  mountHealthRoutes(app, ctx);
  mountMirrorAccessRoutes(app, ctx);
  if (ctx.audience) app.post('/probe/host', ctx.audience.requireHost(), (r, res) => res.json({ ok: true, host: true }));
  const httpServer = http.createServer(app);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { httpServer.closeAllConnections(); httpServer.close(r); }));
  const port = httpServer.address().port;
  // lib/client's request: what a hook or the CLI sends (no Origin, no Sec-Fetch-*).
  const call = (method, p, headers) => request(port, method, p, method === 'POST' ? {} : null, { headers, timeout: 10000 });
  return { port, get: (p, headers) => call('GET', p, headers), post: (p, headers) => call('POST', p, headers) };
}

// The lock of a turn in progress (started now, so not stale), with the prompt
// and 0.8.5's session fields.
const graphWithLock = () => ({
  active: 'n1',
  nodes: new Map(),
  lock: {
    base: null, started_at: Date.now(), message: 'a typed prompt', author: 'user',
    session_id: 'sess-1', claude_pid: 4242, prompt_id: 'prm-1',
  },
});

test('requireHost over HTTP: lib/client from loopback passes; fetch (a browser), the portal\'s label and a network peer get 403', async (t) => {
  const h = await routeHost(t, { graph: graphWithLock(), bus: { bootId: 'b' }, audience: audienceOf(t, scratch(t)) });
  assert.deepStrictEqual(await h.post('/probe/host'), { status: 200, body: { ok: true, host: true } });
  // Node's fetch sends sec-fetch-mode, as a browser does.
  const r = await fetch(`http://127.0.0.1:${h.port}/probe/host`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  assert.deepStrictEqual(await r.json(), { ok: false, hint: SPEC_HOST_ONLY });
  assert.deepStrictEqual(await h.post('/probe/host', { 'X-WC-Remote': '1' }), { status: 403, body: { ok: false, hint: SPEC_HOST_ONLY } });
  assert.deepStrictEqual(await h.post('/probe/host', { 'x-test-peer': '10.0.0.7' }), { status: 403, body: { ok: false, hint: SPEC_HOST_ONLY } });
});

test('GET /api/mirror/access: the asker\'s level, its label and the host commands; the project\'s opt-in for the host alone', async (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'read' });
  const h = await routeHost(t, { graph: graphWithLock(), bus: { bootId: 'b' }, audience: audienceOf(t, s) });
  assert.deepStrictEqual(await h.get('/api/mirror/access'), { status: 200, body: {
    ok: true, level: 'local', remote: false, project: { remote_level: 'read', tunnel_configured: true }, commands: { ...COMMANDS },
  } });
  assert.deepStrictEqual(await h.get('/api/mirror/access', { 'X-WC-Remote': '1' }),
    { status: 200, body: { ok: true, level: 'read', remote: true, commands: { ...COMMANDS } } });
  assert.deepStrictEqual(await h.get('/api/mirror/access', { 'x-test-peer': '192.168.1.20', 'X-WC-Remote': '1' }),
    { status: 200, body: { ok: true, level: 'basic', remote: true, commands: { ...COMMANDS } } },
    'a network peer is basic whatever it sends; the label is only reported');

  // Mounted before the server has an audience to hand it: there is no level to
  // report, which is the "not wired yet" answer, never a guess.
  const bare = await routeHost(t, { graph: graphWithLock(), bus: { bootId: 'b' } });
  assert.deepStrictEqual(await bare.get('/api/mirror/access'), { status: 503, body: { ok: false, unavailable: true } });
});

test('/api/health: `mirror` is the mirror\'s content-free summary with this request\'s level; below read the lock carries no text', async (t) => {
  const s = scratch(t);
  writeTunnel(s.configFile, { [s.root]: 'read' });
  let summary = { enabled: true, state: 'working', conversations: 2, last_hook_at: 1700000000123 };
  const ctx = {
    graph: graphWithLock(),
    bus: { bootId: 'boot-1' },
    audience: audienceOf(t, s),
    mirror: { summary: () => summary },
  };
  const h = await routeHost(t, ctx);
  const get = async (headers) => (await h.get('/api/health', headers)).body;
  const LOCK = ctx.graph.lock;
  const STRIPPED = { base: null, started_at: LOCK.started_at, author: 'user' };

  const local = await get();
  assert.deepStrictEqual(local.mirror, { enabled: true, level: 'local', state: 'working', conversations: 2, last_hook_at: 1700000000123 });
  assert.deepStrictEqual(local.lock, LOCK, 'a local request gets the lock whole, as it always has');
  assert.equal(local.remote, false);

  const read = await get({ 'X-WC-Remote': '1' });
  assert.equal(read.mirror.level, 'read');
  assert.deepStrictEqual(read.lock, LOCK, 'at read, the conversation is the viewer\'s to see');
  assert.equal(read.remote, true);

  const network = await get({ 'x-test-peer': '10.0.0.7' });
  assert.equal(network.mirror.level, 'basic');
  assert.deepStrictEqual(network.lock, STRIPPED, 'a network peer: no prompt, no session fields');
  assert.deepStrictEqual(Object.keys(network).sort(), Object.keys(local).sort(), 'the rest of the body is the same shape');

  // A project that has not opted in: its remote viewers are basic.
  ctx.audience = audienceOf(t, scratch(t));
  const basic = await get({ 'X-WC-Remote': '1' });
  assert.equal(basic.mirror.level, 'basic');
  assert.deepStrictEqual(basic.lock, STRIPPED);
  assert.equal(basic.lock_stale, false, 'the lock\'s own state stays: a remote page can still tell a turn is running');

  // The summary is typed on the way out: a field of the wrong shape is dropped,
  // never sent, and an unknown one never rides along.
  summary = { enabled: 'yes', state: 'Edit · lib/x.js', conversations: 2.5, last_hook_at: 'now', title: 'a secret title' };
  assert.deepStrictEqual((await get()).mirror, { enabled: false, level: 'local', state: null, conversations: 0, last_hook_at: null });
  summary = { enabled: true, state: 'mcp__github__merge', conversations: 1, last_hook_at: null };
  assert.deepStrictEqual((await get()).mirror, { enabled: true, level: 'local', state: null, conversations: 1, last_hook_at: null });
  ctx.mirror.summary = () => { throw new Error('the mirror failed'); };
  assert.deepStrictEqual((await get()).mirror, { enabled: false, level: 'local', state: null, conversations: 0, last_hook_at: null });

  // No mirror and no audience yet (the server not wired): the mirror reads as
  // off, and a remote viewer is held to basic — narrower, never wider.
  delete ctx.mirror;
  delete ctx.audience;
  assert.deepStrictEqual((await get()).mirror, { enabled: false, level: 'local', state: null, conversations: 0, last_hook_at: null });
  const unwired = await get({ 'X-WC-Remote': '1' });
  assert.equal(unwired.mirror.level, 'basic');
  assert.deepStrictEqual(unwired.lock, STRIPPED);
});

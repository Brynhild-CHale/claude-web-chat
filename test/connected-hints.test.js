// The connected-mode hints (tranche 6 U745; 06 C-06.34a; 04 C-04.20): a
// refusal the daemon sends a viewer the hub relays (the peer kind 'relayed',
// lib/server/audience) is worded for the hub — the hub's sharing and the
// machine's ceiling, never a host command or a file path — through one
// chooser, lib/core/remote-policy hintFor(need, {connected, destructive}). A
// tunnel viewer, a network peer and the host keep today's words byte for byte,
// and classify, refusalBody and every row of RULES and ANSWER_RULES answer as
// they did before this unit (a digest over their outputs, pinned).
//
// The relay secret is a fresh random value per test process, carried only in
// request headers here: never printed. HOME is a sandbox (npm test's
// test-support/sandbox.js, and withServer's own), so the connector directory
// is a throwaway one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { withServer } = require('../test-support/helpers');
const { writeJsonAtomic } = require('../lib/core/fsjson');
const { userPaths } = require('../lib/core/paths');
const { stableStringify } = require('../lib/core/stable-json');
const { LEVEL_HEADER, REMOTE_HEADER } = require('../lib/core/cors');
const { RELAY_HEADER } = require('../lib/core/writer-token');
const policy = require('../lib/core/remote-policy');
const {
  hintFor, MIRROR_HINT, MIRROR_FULL_HINT, DESTRUCTIVE_HINT,
  CONNECTED_MIRROR_HINT, CONNECTED_MIRROR_FULL_HINT, CONNECTED_DESTRUCTIVE_HINT,
} = policy;
const { createAudience, HOST_ONLY, NETWORK_HINT } = require('../lib/server/audience');
const { createRelayCredential } = require('../lib/server/relay-credential');
const { mountToolbarRoutes } = require('../lib/server/routes/toolbar');
const { mountElementFileRoutes } = require('../lib/server/routes/element-files');
const { createServer } = require('../lib/server');

const SECRET = crypto.randomBytes(32).toString('hex');

// Today's tunnel words, as written before this unit: a tunnel viewer's
// refusal must carry exactly these.
const TUNNEL_MIRROR = 'the conversation is not shared with remote viewers of this project — on the host: claude-web-chat tunnel mirror on';
const TUNNEL_MIRROR_FULL = 'this needs full mirror access — on the host: claude-web-chat tunnel mirror on (without --read-only)';
const TUNNEL_DESTRUCTIVE = 'wiping the graph or starting a new one remotely is off — run it on the host, or set remote.allowDestructive in ~/.web-chat/tunnel/tunnel.json';

const TUNNEL = Object.freeze({
  hostname: 'wc.example.test',
  style: 'flat',
  access: { team: 'testteam', aud: 'test-aud-0123456789' },
  allow: { emails: ['me@example.com'], domains: [] },
});
const writeTunnel = (file, root, optIn) =>
  writeJsonAtomic(file, optIn ? { ...TUNNEL, remote: { mirror: { [path.resolve(root)]: optIn } } } : { ...TUNNEL });

// The connector record (ceiling full) in the sandboxed HOME's connector dir.
function connectorRecord(ceiling = 'full') {
  const dir = userPaths().connectorDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hub-test.json');
  writeJsonAtomic(file, { record_version: 1, hub: { id: 'hub-test' }, ceiling });
  return file;
}

// ── the chooser ─────────────────────────────────────────────────────────────

test('hintFor answers the tunnel strings without connected and the hub strings with it, for need read, full and destructive', () => {
  assert.equal(MIRROR_HINT, TUNNEL_MIRROR);
  assert.equal(MIRROR_FULL_HINT, TUNNEL_MIRROR_FULL);
  assert.equal(DESTRUCTIVE_HINT, TUNNEL_DESTRUCTIVE);
  for (const need of ['basic', 'read']) {
    assert.equal(hintFor(need), TUNNEL_MIRROR, need);
    assert.equal(hintFor(need, { connected: false }), TUNNEL_MIRROR, need);
    assert.equal(hintFor(need, { connected: true }), CONNECTED_MIRROR_HINT, need);
  }
  assert.equal(hintFor('full'), TUNNEL_MIRROR_FULL);
  assert.equal(hintFor('full', { connected: true }), CONNECTED_MIRROR_FULL_HINT);
  for (const need of [undefined, 'read', 'full']) {
    assert.equal(hintFor(need, { destructive: true }), TUNNEL_DESTRUCTIVE, String(need));
    assert.equal(hintFor(need, { destructive: true, connected: true }), CONNECTED_DESTRUCTIVE_HINT, String(need));
  }
  // The three hub strings are distinct from each other and from the tunnel's.
  const all = [TUNNEL_MIRROR, TUNNEL_MIRROR_FULL, TUNNEL_DESTRUCTIVE,
    CONNECTED_MIRROR_HINT, CONNECTED_MIRROR_FULL_HINT, CONNECTED_DESTRUCTIVE_HINT];
  assert.equal(new Set(all).size, all.length);
});

test('no connected string names a host command, the tunnel or a path', () => {
  for (const s of [CONNECTED_MIRROR_HINT, CONNECTED_MIRROR_FULL_HINT, CONNECTED_DESTRUCTIVE_HINT]) {
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0);
    assert.ok(!s.includes('claude-web-chat'), s);
    assert.ok(!/tunnel/i.test(s), s);
    assert.ok(!/[/\\~]/.test(s), `${s}: a path separator or home`);
    assert.ok(!/\.json\b|\.web-chat|--/.test(s), `${s}: a file or a flag`);
    assert.ok(!/\bon the host\b/.test(s), `${s}: a host instruction`);
    assert.ok(/\bhub\b/.test(s), `${s}: says the hub`);
  }
});

// ── classify, refusalBody and every row unchanged ───────────────────────────
// One probe per row and method (a `:name` segment as 'x'; a trailing `*` as
// both its bare prefix and two segments below), at every opt-in and with and
// without allowDestructive; the digest of every verdict and refusal body was
// taken at the base of this unit (ae/int 3364c67e). A later unit that changes
// a row on purpose re-takes it, and says so.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
function probes(rules) {
  const out = [];
  for (const r of rules) {
    const ms = r.methods === '*' ? METHODS : r.methods;
    const segs = r.path.split('/').map((s) => (s.startsWith(':') ? 'x' : s));
    const paths = segs[segs.length - 1] === '*'
      ? [segs.slice(0, -1).join('/') || '/', [...segs.slice(0, -1), 'x', 'y'].join('/')]
      : [segs.join('/')];
    for (const m of ms) for (const p of paths) out.push([m, p]);
  }
  return out;
}
function digest(classify, rules) {
  const rows = [];
  for (const [m, p] of probes(rules)) {
    for (const mirror of ['off', 'read', 'full']) {
      for (const allowDestructive of [false, true]) {
        const v = classify(m, p, { mirror, allowDestructive });
        rows.push([m, p, mirror, allowDestructive, v, v.allow ? null : policy.refusalBody(v)]);
      }
    }
  }
  return { n: rows.length, sha: crypto.createHash('sha256').update(stableStringify(rows)).digest('hex') };
}

test('classify(...) and refusalBody answer every RULES and ANSWER_RULES row as at the base', () => {
  assert.deepEqual(digest(policy.classify, policy.RULES),
    { n: 2538, sha: '471e347bfa1a7cf5531bfa01a85141c9723e4bb016566a783ddcdb7522f5fcbd' });
  assert.deepEqual(digest(policy.classifyAnswer, policy.ANSWER_RULES),
    { n: 114, sha: '5341ee0b989bc379f3daa3a660969454901000e69b40ed1001d460bcadbcb3e0' });
  // No row carries a hub string: the portal is the tunnel.
  const hub = new Set([CONNECTED_MIRROR_HINT, CONNECTED_MIRROR_FULL_HINT, CONNECTED_DESTRUCTIVE_HINT]);
  for (const r of [...policy.RULES, ...policy.ANSWER_RULES]) assert.ok(!hub.has(r.hint), r.path);
});

// ── requireMirror (lib/server/audience refusalHint) ─────────────────────────

function fakeReq(headers = [], addr = '127.0.0.1') {
  const rawHeaders = [];
  const h = {};
  for (const [k, v] of headers) {
    rawHeaders.push(k, v);
    h[k.toLowerCase()] = v;
  }
  return { socket: { remoteAddress: addr }, headers: h, rawHeaders };
}
const REMOTE_H = [REMOTE_HEADER, '1'];
const relayedH = (stamp) => [REMOTE_H, [RELAY_HEADER, SECRET], ...(stamp ? [[LEVEL_HEADER, stamp]] : [])];

function run(mw, req) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
}

function audienceOf(t, { optIn = null, relay = null, record = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hints-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const configFile = path.join(dir, 'tunnel', 'tunnel.json');
  writeTunnel(configFile, root, optIn);
  const a = createAudience({ root, configFile, pollMs: 25, relay, connectorRecord: record });
  t.after(() => a.stop());
  return a;
}

test('requireMirror: a relayed request below the need is told in the hub\'s words; a tunnel viewer, a network peer and the host need keep today\'s', (t) => {
  const a = audienceOf(t, { optIn: 'read', relay: createRelayCredential({ secret: SECRET }), record: connectorRecord('full') });
  const basic = fakeReq(relayedH('basic'));
  const read = fakeReq(relayedH('read'));
  assert.equal(a.peerOf(read), 'relayed');
  let out = run(a.requireMirror('read'), basic);
  assert.equal(out.status, 403);
  assert.deepEqual(out.body, { ok: false, mirror: 'basic', remote: true, hint: CONNECTED_MIRROR_HINT });
  out = run(a.requireMirror('full'), read);
  assert.deepEqual(out.body, { ok: false, mirror: 'read', remote: true, hint: CONNECTED_MIRROR_FULL_HINT });
  out = run(a.requireMirror('local'), read);
  assert.deepEqual(out.body, { ok: false, mirror: 'read', remote: true, hint: HOST_ONLY }, 'host-only unchanged');

  // A tunnel viewer of the same daemon (the label, no credential): opt-in read.
  const tunnel = fakeReq([REMOTE_H]);
  assert.equal(a.peerOf(tunnel), 'remote');
  out = run(a.requireMirror('full'), tunnel);
  assert.deepEqual(out.body, { ok: false, mirror: 'read', remote: true, hint: TUNNEL_MIRROR_FULL });
  out = run(a.requireMirror('local'), tunnel);
  assert.equal(out.body.hint, HOST_ONLY);

  // A daemon not in connected mode: the same headers are a tunnel viewer.
  const off = audienceOf(t, { optIn: null });
  out = run(off.requireMirror('read'), fakeReq(relayedH('full')));
  assert.deepEqual(out.body, { ok: false, mirror: 'basic', remote: true, hint: TUNNEL_MIRROR });

  // A network peer: its own words, connected or not.
  out = run(a.requireMirror('read'), fakeReq(relayedH('full'), '10.0.0.5'));
  assert.equal(out.body.hint, NETWORK_HINT);
});

// ── a live daemon: the queue's belowFull and the toolbar's write ────────────

async function boot(t, { secret = null, optIn = null, record = false } = {}) {
  let recordPath = null;
  return withServer(t, {
    seed: ({ root }) => {
      writeTunnel(userPaths().tunnelConfig, root, optIn);
      if (record) recordPath = connectorRecord('full');
    },
    createServer: (o) => createServer({
      ...o,
      relaySecret: secret,
      relaySecretVia: secret ? 'option' : null,
      connectorRecord: recordPath,
    }),
  });
}

function send(port, { method = 'GET', path: p = '/', headers = [], body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const h = {};
    for (const [k, v] of headers) h[k] = v;
    if (data != null) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

test('a relayed request below full: the queue\'s belowFull and the toolbar\'s write carry the hub\'s words; a tunnel viewer\'s carry today\'s', async (t) => {
  const d = await boot(t, { secret: SECRET, optIn: 'read', record: true });
  const relayed = relayedH('read');
  let r = await send(d.port, { method: 'POST', path: '/api/queue/push', headers: relayed, body: { ids: [] } });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.json, { ok: false, mirror: 'read', remote: true, hint: CONNECTED_MIRROR_FULL_HINT });
  r = await send(d.port, { method: 'PATCH', path: '/api/toolbar', headers: relayed, body: { pinned: ['comment'] } });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.json, { ok: false, mirror: 'read', remote: true, hint: CONNECTED_MIRROR_FULL_HINT });

  // The tunnel viewer of the same daemon (opt-in read): byte for byte today's.
  const tunnel = [REMOTE_H];
  r = await send(d.port, { method: 'POST', path: '/api/queue/push', headers: tunnel, body: { ids: [] } });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.text, JSON.stringify({ ok: false, mirror: 'read', remote: true, hint: TUNNEL_MIRROR_FULL }));
  r = await send(d.port, { method: 'PATCH', path: '/api/toolbar', headers: tunnel, body: { pinned: ['comment'] } });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.text, JSON.stringify({ ok: false, mirror: 'read', remote: true, hint: TUNNEL_MIRROR_FULL }));
});

test('a daemon not in connected mode words every refusal as today, whatever headers a request carries', async (t) => {
  const d = await boot(t, { secret: null, optIn: 'read' });
  for (const headers of [relayedH('full'), [REMOTE_H]]) {
    const r = await send(d.port, { method: 'POST', path: '/api/queue/push', headers, body: { ids: [] } });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.text, JSON.stringify({ ok: false, mirror: 'read', remote: true, hint: TUNNEL_MIRROR_FULL }));
  }
});

// ── the toolbar's own fallback and an element-files gate (a small app) ──────
// A stub audience answers the peer and the level from test headers, so each
// gate's own wording is reached without the rest of the daemon.

function stubAudience({ requireMirror = true } = {}) {
  const peerOf = (req) => req.headers['x-test-peer-kind'] || 'local';
  const levelOf = (req) => req.headers['x-test-level'] || 'local';
  const a = {
    peerOf,
    levelOf,
    atLeast: policy.atLeast,
  };
  if (requireMirror) {
    a.requireMirror = (need) => (req, res, next) => (policy.atLeast(levelOf(req), need) ? next()
      : res.status(403).json({ ok: false, mirror: levelOf(req), hint: 'the stub' }));
  }
  return a;
}

async function appOf(t, ctx, mount) {
  const app = express();
  app.use(express.json());
  mount(app, ctx);
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => server.close(res)));
  return server.address().port;
}
const as = (kind, level) => [['x-test-peer-kind', kind], ['x-test-level', level]];

test('the toolbar\'s write without a requireMirror audience: the hub\'s words for a relayed peer, today\'s for anyone else', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hints-tb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await appOf(t, { root: dir, audience: stubAudience({ requireMirror: false }) }, mountToolbarRoutes);
  let r = await send(port, { method: 'PATCH', path: '/api/toolbar', headers: as('relayed', 'read'), body: { pinned: [] } });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.json, { ok: false, hint: CONNECTED_MIRROR_FULL_HINT });
  r = await send(port, { method: 'PATCH', path: '/api/toolbar', headers: as('remote', 'read'), body: { pinned: [] } });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.text, JSON.stringify({ ok: false, hint: TUNNEL_MIRROR_FULL }));
});

test('an element-files gate: the hub\'s words for a relayed peer, today\'s for a tunnel viewer (a full gate and an unlisted gate)', async (t) => {
  const gates = { fully: { see: 'full' }, gone: null };
  const elementTypes = {
    descriptor: (type) => (type in gates ? { name: type, builtin: false } : null),
    gate: (type) => gates[type],
  };
  const port = await appOf(t, { audience: stubAudience(), elementTypes }, mountElementFileRoutes);
  const cases = [
    ['fully', 'relayed', CONNECTED_MIRROR_FULL_HINT],
    ['gone', 'relayed', CONNECTED_MIRROR_HINT],
    ['fully', 'remote', TUNNEL_MIRROR_FULL],
    ['gone', 'remote', TUNNEL_MIRROR],
  ];
  for (const [type, kind, hint] of cases) {
    const r = await send(port, { path: `/api/elements/types/${type}/draw.js`, headers: as(kind, 'read') });
    assert.equal(r.status, 403, `${type} ${kind}: ${r.text}`);
    assert.equal(r.json.hint, hint, `${type} ${kind}`);
    if (kind === 'remote') {
      assert.equal(r.text, JSON.stringify({ ok: false, error: `the element type '${type}' is not shown at this viewer's level`, hint }));
    }
  }
});

test('no hint string is spelled in the daemon\'s refusing files: they reach the words through hintFor', () => {
  const files = ['lib/server/audience.js', 'lib/server/routes/queue.js', 'lib/server/routes/toolbar.js', 'lib/server/routes/element-files.js'];
  const words = [TUNNEL_MIRROR, TUNNEL_MIRROR_FULL, TUNNEL_DESTRUCTIVE, CONNECTED_MIRROR_HINT, CONNECTED_MIRROR_FULL_HINT, CONNECTED_DESTRUCTIVE_HINT];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/\bMIRROR_(FULL_)?HINT\b|\bDESTRUCTIVE_HINT\b/.test(src), `${f} names a hint constant`);
    for (const w of words) assert.ok(!src.includes(w.slice(0, 40)), `${f} spells a hint`);
    assert.ok(src.includes('hintFor('), `${f} calls hintFor`);
  }
});

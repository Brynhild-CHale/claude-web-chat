// The tab icon's server half (design spec §9.7, unit U77a): web-chat's three
// default icons shipped in public/, served to every viewer (a remote one
// included), and the project's home-screen icon routes in
// lib/server/routes/project.js. The routes are mounted on a bare Express app
// with a fake ctx.bus, as a route unit's tests are (spec §10.1); the default
// icons go through a real daemon (withServer), since express.static there is
// what serves them.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const pi = require('../lib/core/project-identity');
const { projectPaths } = require('../lib/core/paths');
const { pngSize } = require('../lib/core/png');
const { classify } = require('../lib/core/remote-policy');
const { mountProjectRoutes } = require('../lib/server/routes/project');
const { withServer } = require('../test-support/helpers');
const { encodePng, solid } = require('../test-support/png-encode');

const REPO = path.resolve(__dirname, '..');
const IDENTITY_HINT = 'the project identity is set on the host: claude-web-chat identity';

// ── the defaults in public/ ──────────────────────────────────────────────────

// Copied byte for byte from design/assets (web-chat-favicon-32.png, its -dark
// variant, web-chat-apple-touch-icon.png): the blue W, the gold W and the W on
// its opaque home-screen tile.
const DEFAULTS = [
  ['public/favicon.png', 'bcb7d9806e4acec8b9484223f082bfc925deeca377a5a20662fe4f03f9d0e7cf', 32, 32],
  ['public/favicon-dark.png', 'c3697541a633ce1b195f7180122b73a72058c19176c3fc636b4f7171b4d921d4', 32, 32],
  ['public/apple-touch-icon.png', 'e64cd52d53b71fc57d9db5a025d63ca01c2e1c172eb0c8bf252247363c9f531c', 180, 180],
];

test('the default icons are the design assets, byte for byte, at their sizes', () => {
  for (const [rel, sha, w, h] of DEFAULTS) {
    const bytes = fs.readFileSync(path.join(REPO, rel));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha, rel);
    const size = pngSize(bytes);
    assert.ok(size, `${rel} is a PNG`);
    assert.deepStrictEqual([size.width, size.height], [w, h], rel);
  }
});

test('the daemon serves the default icons as image/png, to a remote viewer too', async (t) => {
  const { baseUrl } = await withServer(t);
  for (const [rel] of DEFAULTS) {
    const p = `/${path.basename(rel)}`;
    const want = fs.readFileSync(path.join(REPO, rel));
    for (const headers of [{}, { 'X-WC-Remote': '1' }]) {
      const r = await fetch(baseUrl + p, { headers });
      const body = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 200, `${p} ${JSON.stringify(headers)}`);
      assert.match(r.headers.get('content-type'), /^image\/png\b/, p);
      assert.ok(body.equals(want), `${p}: the shipped bytes`);
    }
  }
});

// ── the touch-icon routes ────────────────────────────────────────────────────

const png = (w, h, rgb = [20, 40, 200]) => encodePng(solid(w, h, rgb), w, h);
const SQUARE = png(18, 18);
const SQUARE_TWO = png(18, 18, [200, 40, 20]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>');

async function routeHost(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-touch-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'acme-web');
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  const emits = [];
  const bus = { emit(arg) { emits.push(arg); return null; }, subscribe() { return () => {}; } };
  const app = express();
  app.use(express.json());
  mountProjectRoutes(app, { root, bus });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, p, { body, type, headers = {} } = {}) {
    const h = { ...headers };
    if (type) h['Content-Type'] = type;
    const r = await fetch(base + p, { method, headers: h, body });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, buf,
      json: ct.startsWith('application/json') ? JSON.parse(buf.toString('utf8')) : null };
  }
  return { root, call, taken: () => emits.splice(0) };
}

test('PUT /api/project/touch-icon: a square PNG is stored and announced once as field touch', async (t) => {
  const h = await routeHost(t);
  const r = await h.call('PUT', '/api/project/touch-icon', { body: SQUARE, type: 'image/png' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.type, 'image/png');
  assert.deepStrictEqual(r.json.identity, pi.identity(h.root));
  assert.ok(r.json.identity.touch && r.json.identity.touch.version, 'the identity reports the touch icon');
  const got = h.taken();
  assert.equal(got.length, 1, 'one emit');
  assert.deepStrictEqual(got[0].event, { kind: 'project', op: 'set', field: 'touch' });
  assert.deepStrictEqual(got[0].ws, pi.frame(h.root));
});

test('PUT /api/project/touch-icon: 415 an SVG, 422 not square, 400 empty — nothing stored, nothing announced', async (t) => {
  const h = await routeHost(t);
  for (const [body, type, status] of [
    [svg, 'image/svg+xml', 415],
    [png(20, 10), 'image/png', 422],
    [Buffer.alloc(0), 'image/png', 400],
  ]) {
    const r = await h.call('PUT', '/api/project/touch-icon', { body, type });
    assert.equal(r.status, status, `${type} ${body.length} bytes: ${JSON.stringify(r.json)}`);
    assert.equal(typeof r.json.error, 'string');
  }
  assert.equal(pi.identity(h.root).touch, null);
  assert.deepStrictEqual(h.taken(), []);
});

test('GET /project/touch-icon: the bytes, locked down; 404 with none', async (t) => {
  const h = await routeHost(t);
  let r = await h.call('GET', '/project/touch-icon');
  assert.equal(r.status, 404);
  pi.writeImage(h.root, 'touch', SQUARE);
  r = await h.call('GET', '/project/touch-icon?v=1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.ok(r.buf.equals(SQUARE));
  // A remote viewer reads it too.
  r = await h.call('GET', '/project/touch-icon', { headers: { 'X-WC-Remote': '1' } });
  assert.equal(r.status, 200);
  assert.ok(r.buf.equals(SQUARE));
});

test('DELETE /api/project/touch-icon: removed and announced; again is no change', async (t) => {
  const h = await routeHost(t);
  pi.writeImage(h.root, 'touch', SQUARE);
  let r = await h.call('DELETE', '/api/project/touch-icon');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, removed: true, identity: pi.identity(h.root) });
  assert.equal(r.json.identity.touch, null);
  assert.deepStrictEqual(h.taken().map((e) => e.event), [{ kind: 'project', op: 'remove', field: 'touch' }]);
  r = await h.call('DELETE', '/api/project/touch-icon');
  assert.deepStrictEqual(r.json, { ok: true, removed: false, identity: pi.identity(h.root) });
  assert.deepStrictEqual(h.taken(), [], 'nothing to remove: no emit');
  assert.equal((await h.call('GET', '/project/touch-icon')).status, 404);
});

test('a remote write to the touch icon is refused with the identity hint; nothing changes', async (t) => {
  const h = await routeHost(t);
  pi.writeImage(h.root, 'touch', SQUARE);
  const before = pi.identity(h.root);
  const REMOTE = { 'X-WC-Remote': '1' };
  assert.equal(classify('PUT', '/api/project/touch-icon').hint, IDENTITY_HINT, 'the portal row says the same');
  for (const [method, req] of [['PUT', { body: SQUARE_TWO, type: 'image/png' }], ['DELETE', {}]]) {
    const r = await h.call(method, '/api/project/touch-icon', { ...req, headers: REMOTE });
    assert.equal(r.status, 403, method);
    assert.deepStrictEqual(r.json, { ok: false, remote: true, hint: IDENTITY_HINT }, method);
  }
  assert.deepStrictEqual(pi.identity(h.root), before);
  assert.ok((await h.call('GET', '/project/touch-icon')).buf.equals(SQUARE), 'the stored bytes are untouched');
  assert.deepStrictEqual(h.taken(), []);
});

// The project identity's routes: lib/server/routes/project.js (spec §9.3), thin
// over lib/core/project-identity. Mounted on a bare Express app with a fake
// ctx.bus, as a route unit's tests are (spec §10.1); the integration unit
// proves the wired daemon. Covered here: the GET body; each write with valid
// and invalid bodies (400, 413, 415, 422, 409); the logo and the mark at
// mode=light and mode=dark, the dark falling back to the light image, and a
// 404 with none; every write refused with the policy row's own body when the
// request came through the portal, and accepted from a pane locally; exactly
// one bus emit per real change, with its field, and none for a no-op; and the
// brand routes, which now share their body reader and their image response
// with these (routes/brand.js readImageBody and sendImage).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const pi = require('../lib/core/project-identity');
const { projectPaths } = require('../lib/core/paths');
const { MAX_BYTES } = require('../lib/core/brand-image');
const { BRAND_CSP } = require('../lib/server/brand');
const { isBrowserRequest } = require('../lib/core/cors');
const { classify } = require('../lib/core/remote-policy');
const { mountProjectRoutes } = require('../lib/server/routes/project');
const brandRoutes = require('../lib/server/routes/brand');
const { encodePng, solid } = require('../test-support/png-encode');

// The hint spec §9.3 gives the remote refusal, word for word.
const IDENTITY_HINT = 'the project identity is set on the host: claude-web-chat identity';

const png = (w, h, rgb = [20, 40, 200]) => encodePng(solid(w, h, rgb), w, h);
const svg = (viewBox, fill = '#041E42') => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect width="10" height="10" fill="${fill}"/></svg>`);

const WIDE = png(40, 10); // a wordmark: never the mark
const WIDE_DARK = png(40, 10, [230, 200, 40]);
const SQUARE = png(16, 16);
const SQUARE_DARK = png(16, 16, [230, 200, 40]);
const ACTIVE_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" onload="alert(1)"/>');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');

// A daemon-shaped host: a project folder (named, so its default name is
// known), a fake bus that records every emit, and the routes under test.
async function routeHost(t, { brand = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-proutes-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'acme-web');
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });

  const emits = [];
  const bus = {
    emit(arg) { emits.push(arg); return null; },
    subscribe() { return () => {}; }, // the brand routes follow theme events; none come here
  };
  const app = express();
  app.use(express.json()); // as lib/server/index.js mounts it, ahead of every route
  mountProjectRoutes(app, { root, bus });
  if (brand) brandRoutes.mountBrandRoutes(app, { root, bus });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // One request. `json` sends a JSON body; `body` + `type` a raw one.
  async function call(method, p, { json, body, type, headers = {} } = {}) {
    const h = { ...headers };
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    } else if (type) {
      h['Content-Type'] = type;
    }
    const r = await fetch(base + p, { method, headers: h, body: payload });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || '';
    return {
      status: r.status,
      headers: r.headers,
      buf,
      json: ct.startsWith('application/json') ? JSON.parse(buf.toString('utf8')) : null,
      text: buf.toString('utf8'),
    };
  }
  const putImage = (kind, bytes, type = 'image/png') => call('PUT', `/api/project/${kind}`, { body: bytes, type });
  // Every emit since the last call, taken off the list.
  const taken = () => emits.splice(0);
  return { root, base, emits, call, putImage, taken };
}

// The one emit a change makes: its event, and the frame carrying the identity
// as it now is.
function assertAnnounced(h, op, field) {
  const got = h.taken();
  assert.equal(got.length, 1, `one emit for ${op} ${field}, got ${JSON.stringify(got.map((e) => e.event))}`);
  assert.deepStrictEqual(Object.keys(got[0]).sort(), ['event', 'ws']);
  assert.deepStrictEqual(got[0].event, { kind: 'project', op, field });
  assert.deepStrictEqual(got[0].ws, pi.frame(h.root));
  assert.equal(got[0].ws.type, 'project');
}
function assertSilent(h, what) {
  const got = h.taken();
  assert.deepStrictEqual(got.map((e) => e.event), [], `${what}: no emit`);
}

// Everything under .web-chat/, each file with its bytes and mtime: to show a
// refusal wrote nothing.
function disk(root) {
  const dir = projectPaths(root).dir;
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
    const p = path.join(dir, f);
    const st = fs.lstatSync(p);
    return [f, st.isFile() ? { bytes: fs.readFileSync(p).toString('base64'), mtime: st.mtimeMs } : 'not a file'];
  }));
}

// ── GET /api/project ────────────────────────────────────────────────────────

test('GET /api/project: the identity, the name limit, the size limit and the two image types', async (t) => {
  const h = await routeHost(t);
  const r = await h.call('GET', '/api/project');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json, {
    name: 'acme-web', default_name: 'acme-web', custom: false, show_name: true,
    logo: null, logo_dark: null, favicon: null, favicon_dark: null, touch: null,
    mark: null, mark_dark: false,
    name_max: 64, max_bytes: 262144, types: ['image/png', 'image/svg+xml'],
  });
  assert.equal(MAX_BYTES, 262144);

  // …and whatever the engine says, as it says it.
  pi.setName(h.root, 'Acme Web');
  pi.writeImage(h.root, 'logo', SQUARE);
  const after = (await h.call('GET', '/api/project')).json;
  assert.deepStrictEqual(after, {
    ...pi.identity(h.root), name_max: pi.NAME_MAX, max_bytes: MAX_BYTES, types: ['image/png', 'image/svg+xml'],
  });
  assert.equal(after.mark, 'logo', 'a square logo is the mark');
  assert.deepStrictEqual(Object.keys(after.logo).sort(), ['bytes', 'height', 'type', 'version', 'width']);
  assertSilent(h, 'a read');
});

// ── the name and the show flag ─────────────────────────────────────────────

test('PUT /api/project/name: set and normalised, announced once; the same name again is no change', async (t) => {
  const h = await routeHost(t);
  let r = await h.call('PUT', '/api/project/name', { json: { name: '  Acme   Web ' } });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, identity: pi.identity(h.root) });
  assert.equal(r.json.identity.name, 'Acme Web');
  assert.equal(r.json.identity.custom, true);
  assert.equal(r.json.identity.default_name, 'acme-web');
  assertAnnounced(h, 'set', 'name');

  r = await h.call('PUT', '/api/project/name', { json: { name: 'Acme Web' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.identity.name, 'Acme Web');
  assertSilent(h, 'the same name');

  // The folder's own name, set on purpose, is a change: the name is now custom.
  r = await h.call('PUT', '/api/project/name', { json: { name: 'acme-web' } });
  assert.equal(r.json.identity.custom, true);
  assertAnnounced(h, 'set', 'name');
});

test('PUT /api/project/name: null or empty puts the folder\'s name back, announced as a removal; with none set it is no change', async (t) => {
  const h = await routeHost(t);
  for (const name of [null, '', '   ']) {
    pi.setName(h.root, 'Acme');
    const r = await h.call('PUT', '/api/project/name', { json: { name } });
    assert.equal(r.status, 200, JSON.stringify(name));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.identity.name, 'acme-web');
    assert.equal(r.json.identity.custom, false);
    assertAnnounced(h, 'remove', 'name');

    const again = await h.call('PUT', '/api/project/name', { json: { name } });
    assert.equal(again.status, 200);
    assertSilent(h, `${JSON.stringify(name)} with no name set`);
  }
  assert.equal(fs.existsSync(projectPaths(h.root).projectJson), false, 'nothing left in the record: no record');
});

test('PUT /api/project/name: a bad name or a malformed body is a 400 that writes and announces nothing', async (t) => {
  const h = await routeHost(t);
  pi.setName(h.root, 'Acme');
  const before = disk(h.root);
  const cases = [
    [{ json: { name: 'Acme\nWeb' } }, /control, bidirectional or invisible/],
    [{ json: { name: 'Acme\u202eWeb' } }, /control, bidirectional or invisible/],
    [{ json: { name: 'Acme\u200bWeb' } }, /control, bidirectional or invisible/],
    [{ json: { name: 'a'.repeat(65) } }, /65 characters; the limit is 64/],
    [{ json: { name: 42 } }, /must be a string/],
    [{ json: { name: ['Acme'] } }, /must be a string/],
    // No `name` at all is malformed, never a silent reset.
    [{ json: {} }, /send \{"name"/],
    [{ json: { nam: 'Acme' } }, /send \{"name"/],
    [{ json: ['Acme'] }, /send \{"name"/],
    [{ body: '{"name":"Acme"}', type: 'text/plain' }, /send \{"name"/],
    [{}, /send \{"name"/],
  ];
  for (const [req, message] of cases) {
    const r = await h.call('PUT', '/api/project/name', req);
    assert.equal(r.status, 400, JSON.stringify(req));
    assert.deepStrictEqual(Object.keys(r.json), ['error']);
    assert.match(r.json.error, message, JSON.stringify(req));
  }
  assert.deepStrictEqual(disk(h.root), before);
  assert.equal(pi.identity(h.root).name, 'Acme');
  assertSilent(h, 'a refused name');
  // 64 code points fit.
  const r = await h.call('PUT', '/api/project/name', { json: { name: '\u{1F600}'.repeat(64) } });
  assert.equal(r.status, 200);
  assertAnnounced(h, 'set', 'name');
});

test('DELETE /api/project/name: a set name is removed and announced once; again, there is nothing to remove', async (t) => {
  const h = await routeHost(t);
  pi.setName(h.root, 'Acme');
  let r = await h.call('DELETE', '/api/project/name');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, removed: true, identity: pi.identity(h.root) });
  assert.equal(r.json.identity.name, 'acme-web');
  assertAnnounced(h, 'remove', 'name');

  r = await h.call('DELETE', '/api/project/name');
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, false);
  assertSilent(h, 'a removal with no name set');
});

test('PUT /api/project/show-name: on and off, announced once each; the same value again, or anything but a boolean, is not', async (t) => {
  const h = await routeHost(t);
  let r = await h.call('PUT', '/api/project/show-name', { json: { show: false } });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, identity: pi.identity(h.root) });
  assert.equal(r.json.identity.show_name, false);
  assertAnnounced(h, 'set', 'show_name');

  r = await h.call('PUT', '/api/project/show-name', { json: { show: false } });
  assert.equal(r.json.identity.show_name, false);
  assertSilent(h, 'off again');

  const before = disk(h.root);
  for (const req of [{ json: { show: 'no' } }, { json: { show: 0 } }, { json: { show: null } }, { json: {} },
    { json: { show_name: false } }, { body: 'false', type: 'text/plain' }]) {
    r = await h.call('PUT', '/api/project/show-name', req);
    assert.equal(r.status, 400, JSON.stringify(req));
    assert.match(r.json.error, /send \{"show": true\} or \{"show": false\}/);
  }
  assert.deepStrictEqual(disk(h.root), before);
  assertSilent(h, 'a refused show flag');

  r = await h.call('PUT', '/api/project/show-name', { json: { show: true } });
  assert.equal(r.json.identity.show_name, true);
  assertAnnounced(h, 'set', 'show_name');
});

// ── the images ──────────────────────────────────────────────────────────────

test('PUT an image: each of the four is stored and announced with its own field, dark variants included', async (t) => {
  const h = await routeHost(t);
  const steps = [
    ['logo', WIDE, 'image/png', 'logo'],
    ['logo-dark', WIDE_DARK, 'image/png', 'logo_dark'],
    ['favicon', svg('0 0 16 16'), 'image/svg+xml', 'favicon'],
    ['favicon-dark', svg('0 0 16 16', '#C79A12'), 'image/svg+xml', 'favicon_dark'],
  ];
  for (const [kind, bytes, type, field] of steps) {
    const r = await h.putImage(kind, bytes, type);
    assert.equal(r.status, 200, `${kind}: ${r.text}`);
    assert.deepStrictEqual(r.json,
      { ok: true, type, bytes: bytes.length, dark_removed: false, identity: pi.identity(h.root) }, kind);
    assert.equal(r.json.identity[field].type, type);
    assertAnnounced(h, 'set', field);
  }
  const id = pi.identity(h.root);
  assert.equal(id.mark, 'favicon');
  assert.equal(id.mark_dark, true);
});

test('PUT an image: a light image\'s new bytes take its dark variant, and the reply says so; the same bytes keep it', async (t) => {
  const h = await routeHost(t);
  await h.putImage('logo', WIDE);
  await h.putImage('logo-dark', WIDE_DARK);
  h.taken();

  let r = await h.putImage('logo', WIDE);
  assert.equal(r.json.dark_removed, false);
  assert.ok(r.json.identity.logo_dark, 'the same light image keeps its variant');
  assertAnnounced(h, 'set', 'logo'); // a write is a write: the file is new

  r = await h.putImage('logo', png(40, 10, [1, 2, 3]));
  assert.equal(r.status, 200);
  assert.equal(r.json.dark_removed, true);
  assert.equal(r.json.identity.logo_dark, null);
  assertAnnounced(h, 'set', 'logo'); // one change, one emit: its frame carries both fields
});

test('PUT an image: 400 empty, 413 too big at either layer, 415 not PNG or SVG, 422 active or the wrong shape, 409 no light image — nothing written, nothing announced', async (t) => {
  const h = await routeHost(t);
  const before = disk(h.root);
  const cases = [
    ['logo', Buffer.alloc(0), 'image/png', 400, /empty image/],
    // body-parser's cap is a byte over the limit; past it, the reader refuses…
    ['logo', Buffer.concat([SQUARE, Buffer.alloc(MAX_BYTES + 10)]), 'image/png', 413, /^image exceeds 262144 bytes$/],
    // …and at it, the engine does: one status either way.
    ['favicon', Buffer.concat([SQUARE, Buffer.alloc(MAX_BYTES + 1 - SQUARE.length)]), 'image/png', 413, /the limit is 262144/],
    ['logo', GIF, 'image/gif', 415, /Content-Type image\/png or image\/svg\+xml/],
    ['logo', SQUARE, 'application/octet-stream', 415, /Content-Type image\/png or image\/svg\+xml/],
    ['logo', SQUARE, null, 415, /Content-Type image\/png or image\/svg\+xml/],
    ['logo-dark', GIF, 'image/png', 415, /not an SVG or PNG image/], // the bytes decide, not the header
    ['logo', ACTIVE_SVG, 'image/svg+xml', 422, /SVG refused/],
    ['favicon', WIDE, 'image/png', 422, /must be square/],
    ['favicon', svg('0 0 40 10'), 'image/svg+xml', 422, /must be square/],
    ['logo-dark', WIDE_DARK, 'image/png', 409, /no logo to be the dark variant of/],
    ['favicon-dark', SQUARE_DARK, 'image/png', 409, /no favicon to be the dark variant of/],
  ];
  for (const [kind, bytes, type, status, message] of cases) {
    const r = await h.putImage(kind, bytes, type);
    assert.equal(r.status, status, `${kind} ${type} ${bytes.length}: ${r.text}`);
    assert.deepStrictEqual(Object.keys(r.json), ['error']);
    assert.match(r.json.error, message, `${kind} ${type}`);
  }
  assert.deepStrictEqual(disk(h.root), before);

  // A dark variant must have its light image's shape (a favicon's: square).
  await h.putImage('logo', WIDE);
  await h.putImage('favicon', SQUARE);
  h.taken();
  const set = disk(h.root);
  const misshapen = [['logo-dark', png(16, 16), /the logo's shape/], ['favicon-dark', svg('0 0 16 8'), /must be square/]];
  for (const [kind, bytes, message] of misshapen) {
    const r = await h.putImage(kind, bytes, sniffType(bytes));
    assert.equal(r.status, 422, `${kind}: ${r.text}`);
    assert.match(r.json.error, message);
  }
  assert.deepStrictEqual(disk(h.root), set);
  assertSilent(h, 'a refused image');
});

// The type an image's bytes are, as the engine sniffs them.
function sniffType(bytes) {
  return bytes[0] === 0x89 ? 'image/png' : 'image/svg+xml';
}

test('DELETE an image: a light image takes its dark variant, a dark variant goes alone; nothing to remove is no change', async (t) => {
  const h = await routeHost(t);
  await h.putImage('logo', WIDE);
  await h.putImage('logo-dark', WIDE_DARK);
  await h.putImage('favicon', SQUARE);
  await h.putImage('favicon-dark', SQUARE_DARK);
  h.taken();

  let r = await h.call('DELETE', '/api/project/logo-dark');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, removed: true, identity: pi.identity(h.root) });
  assert.equal(r.json.identity.logo_dark, null);
  assert.ok(r.json.identity.logo, 'the light logo stays');
  assertAnnounced(h, 'remove', 'logo_dark');

  r = await h.call('DELETE', '/api/project/logo-dark');
  assert.deepStrictEqual(r.json, { ok: true, removed: false, identity: pi.identity(h.root) });
  assertSilent(h, 'a dark variant already gone');

  r = await h.call('DELETE', '/api/project/favicon');
  assert.equal(r.json.removed, true);
  assert.equal(r.json.identity.favicon, null);
  assert.equal(r.json.identity.favicon_dark, null, 'its dark variant went with it');
  assertAnnounced(h, 'remove', 'favicon'); // one change: its frame carries both

  r = await h.call('DELETE', '/api/project/favicon-dark');
  assert.equal(r.json.removed, false);
  assertSilent(h, 'a dark variant its light image took');

  r = await h.call('DELETE', '/api/project/logo');
  assert.equal(r.json.removed, true);
  assertAnnounced(h, 'remove', 'logo');
  assert.deepStrictEqual(fs.readdirSync(projectPaths(h.root).dir), []);
});

// ── serving the images ──────────────────────────────────────────────────────

// The headers every image is served with (routes/brand.js sendImage).
function assertLockedDown(r, type) {
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), type);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-security-policy'), BRAND_CSP);
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
}

test('GET /project/logo and /project/mark: 404 with no image, in either mode', async (t) => {
  const h = await routeHost(t);
  for (const p of ['/project/logo', '/project/mark']) {
    for (const q of ['', '?mode=light', '?mode=dark', '?mode=dark&v=1-2']) {
      const r = await h.call('GET', p + q);
      assert.equal(r.status, 404, p + q);
      assert.match(r.headers.get('content-type'), /^text\/plain/);
    }
  }
  // A wide logo is a logo but never the mark.
  await h.putImage('logo', WIDE);
  assertLockedDown(await h.call('GET', '/project/logo'), 'image/png');
  assert.equal((await h.call('GET', '/project/mark')).status, 404);
  assert.equal((await h.call('GET', '/project/mark?mode=dark')).status, 404);
});

test('GET /project/logo and /project/mark: the light image, the dark variant at mode=dark, the light one when there is no dark variant', async (t) => {
  const h = await routeHost(t);
  const bytesOf = async (p) => {
    const r = await h.call('GET', p);
    assertLockedDown(r, sniffType(r.buf));
    return r.buf;
  };

  // A square logo alone: it is the mark too, and dark mode falls back to it.
  await h.putImage('logo', SQUARE);
  for (const p of ['/project/logo', '/project/mark']) {
    for (const q of ['', '?mode=light', '?mode=dark', '?mode=sepia', '?mode=dark&v=anything']) {
      assert.deepStrictEqual(await bytesOf(p + q), SQUARE, p + q);
    }
  }

  await h.putImage('logo-dark', SQUARE_DARK);
  assert.deepStrictEqual(await bytesOf('/project/logo'), SQUARE);
  assert.deepStrictEqual(await bytesOf('/project/logo?mode=light'), SQUARE);
  assert.deepStrictEqual(await bytesOf('/project/logo?mode=dark'), SQUARE_DARK);
  assert.deepStrictEqual(await bytesOf('/project/mark?mode=dark'), SQUARE_DARK, 'the mark is the logo: its dark variant');

  // A favicon becomes the mark; with no dark variant of its own, dark mode
  // shows the favicon, never the logo's dark variant.
  const FAV = svg('0 0 16 16', '#123456');
  await h.putImage('favicon', FAV, 'image/svg+xml');
  assert.deepStrictEqual(await bytesOf('/project/mark'), FAV);
  assert.deepStrictEqual(await bytesOf('/project/mark?mode=dark'), FAV);
  assert.deepStrictEqual(await bytesOf('/project/logo?mode=dark'), SQUARE_DARK, 'the logo is still the logo');

  const FAV_DARK = svg('0 0 16 16', '#C79A12');
  await h.putImage('favicon-dark', FAV_DARK, 'image/svg+xml');
  assert.deepStrictEqual(await bytesOf('/project/mark?mode=dark'), FAV_DARK);
  assert.deepStrictEqual(await bytesOf('/project/mark?mode=light'), FAV);
  const svgServed = await h.call('GET', '/project/mark?mode=dark');
  assertLockedDown(svgServed, 'image/svg+xml'); // typed by sniffing, as stored

  // Back to the light image when the dark variant goes.
  await h.call('DELETE', '/api/project/favicon-dark');
  assert.deepStrictEqual(await bytesOf('/project/mark?mode=dark'), FAV);
});

test('the cache key is per mode: a dark variant\'s change moves only its own version', async (t) => {
  const h = await routeHost(t);
  await h.putImage('logo', WIDE);
  const light = (await h.call('GET', '/api/project')).json.logo;
  await h.putImage('logo-dark', WIDE_DARK);
  let id = (await h.call('GET', '/api/project')).json;
  assert.deepStrictEqual(id.logo, light, 'the light image, and so its url, did not move');
  const dark = id.logo_dark;
  assert.ok(dark.version);
  // A different size: a different version, whatever the clock says.
  const BIGGER = png(80, 20, [230, 200, 40]);
  await h.putImage('logo-dark', BIGGER);
  id = (await h.call('GET', '/api/project')).json;
  assert.deepStrictEqual(id.logo, light);
  assert.notEqual(id.logo_dark.version, dark.version);
  assert.equal(id.logo_dark.bytes, BIGGER.length);
});

// ── who may write ───────────────────────────────────────────────────────────

const WRITES = [
  ['PUT', '/api/project/name', { json: { name: 'From afar' } }],
  ['DELETE', '/api/project/name', {}],
  ['PUT', '/api/project/show-name', { json: { show: false } }],
  ...['logo', 'logo-dark', 'favicon', 'favicon-dark'].flatMap((kind) => [
    ['PUT', `/api/project/${kind}`, { body: kind.startsWith('logo') ? WIDE : SQUARE, type: 'image/png' }],
    ['DELETE', `/api/project/${kind}`, {}],
  ]),
];

test('a remote write is refused with the policy row\'s own body before anything is read or written; reads stay open', async (t) => {
  const h = await routeHost(t);
  pi.setName(h.root, 'Acme');
  pi.writeImage(h.root, 'logo', SQUARE);
  pi.writeImage(h.root, 'logo-dark', SQUARE_DARK);
  pi.writeImage(h.root, 'favicon', SQUARE);
  pi.writeImage(h.root, 'favicon-dark', SQUARE_DARK);
  const before = disk(h.root);
  const identity = pi.identity(h.root);
  const REMOTE = { 'X-WC-Remote': '1' };

  // The daemon's refusal is the portal's row, word for word.
  assert.equal(classify('PUT', '/api/project/logo').hint, IDENTITY_HINT);
  for (const [method, p, req] of [...WRITES,
    ['PUT', '/api/project/logo', { body: Buffer.alloc(MAX_BYTES + 10), type: 'image/png' }], // never read
    ['PATCH', '/api/project/name', { json: { name: 'x' } }], // no such route: still refused
    ['POST', '/api/project', { json: {} }]]) {
    const r = await h.call(method, p, { ...req, headers: REMOTE });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.deepStrictEqual(r.json, { ok: false, remote: true, hint: IDENTITY_HINT }, `${method} ${p}`);
  }
  assert.deepStrictEqual(disk(h.root), before, 'nothing written');
  assert.deepStrictEqual(pi.identity(h.root), identity);
  assertSilent(h, 'a refused remote write');

  // Reading is P0: every viewer is shown the identity.
  const get = await h.call('GET', '/api/project', { headers: REMOTE });
  assert.equal(get.status, 200);
  assert.equal(get.json.name, 'Acme');
  assertLockedDown(await h.call('GET', '/project/logo?mode=dark', { headers: REMOTE }), 'image/png');
  assertLockedDown(await h.call('GET', '/project/mark', { headers: REMOTE }), 'image/png');
  // Only the portal's label narrows: any other value is a local request.
  const local = await h.call('PUT', '/api/project/name', { json: { name: 'Acme Two' }, headers: { 'X-WC-Remote': '0' } });
  assert.equal(local.status, 200);
});

test('a pane\'s write is accepted locally: the identity is display-only (spec §5.7), like brand and theme writes', async (t) => {
  const h = await routeHost(t);
  const PANE = { Origin: h.base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  assert.equal(isBrowserRequest(Object.fromEntries(Object.entries(PANE).map(([k, v]) => [k.toLowerCase(), v]))), true,
    'premise: these are a browser\'s headers');
  for (const [method, p, req] of WRITES) {
    // A dark variant needs its light image first; the pane sets that too.
    if (p.endsWith('-dark') && method === 'PUT') {
      const light = await h.call('PUT', p.replace('-dark', ''), { ...req, headers: PANE });
      assert.equal(light.status, 200, light.text);
      h.taken();
    }
    const r = await h.call(method, p, { ...req, headers: PANE });
    assert.equal(r.status, 200, `${method} ${p}: ${r.text}`);
    assert.equal(r.json.ok, true);
    assert.equal(h.taken().length, 1, `${method} ${p} was a change, announced once`);
  }
});

// ── the bus ─────────────────────────────────────────────────────────────────

test('one bus emit per real change, with its field; none for a no-op or a refusal', async (t) => {
  const h = await routeHost(t);
  const png16 = { type: 'image/png' };
  const STEPS = [
    // [method, path, request, expected status, [op, field] or null]
    ['PUT', '/api/project/name', { json: { name: 'Acme Web' } }, 200, ['set', 'name']],
    ['PUT', '/api/project/name', { json: { name: ' Acme  Web ' } }, 200, null],
    ['PUT', '/api/project/show-name', { json: { show: false } }, 200, ['set', 'show_name']],
    ['PUT', '/api/project/show-name', { json: { show: false } }, 200, null],
    ['PUT', '/api/project/logo-dark', { body: WIDE_DARK, ...png16 }, 409, null],
    ['PUT', '/api/project/logo', { body: WIDE, ...png16 }, 200, ['set', 'logo']],
    ['PUT', '/api/project/logo-dark', { body: WIDE_DARK, ...png16 }, 200, ['set', 'logo_dark']],
    ['PUT', '/api/project/favicon', { body: WIDE, ...png16 }, 422, null],
    ['PUT', '/api/project/favicon', { body: SQUARE, ...png16 }, 200, ['set', 'favicon']],
    ['PUT', '/api/project/favicon-dark', { body: SQUARE_DARK, ...png16 }, 200, ['set', 'favicon_dark']],
    ['DELETE', '/api/project/favicon-dark', {}, 200, ['remove', 'favicon_dark']],
    ['DELETE', '/api/project/favicon-dark', {}, 200, null],
    ['DELETE', '/api/project/logo', {}, 200, ['remove', 'logo']], // and logo_dark with it: one change
    ['DELETE', '/api/project/logo', {}, 200, null],
    ['DELETE', '/api/project/logo-dark', {}, 200, null],
    ['DELETE', '/api/project/favicon', {}, 200, ['remove', 'favicon']],
    ['PUT', '/api/project/show-name', { json: { show: true } }, 200, ['set', 'show_name']],
    ['PUT', '/api/project/name', { json: { name: null } }, 200, ['remove', 'name']],
    ['DELETE', '/api/project/name', {}, 200, null],
    ['PUT', '/api/project/name', { json: { name: '' } }, 200, null],
    ['PUT', '/api/project/name', { json: { name: 'Acme\tWeb' } }, 400, null],
  ];
  for (const [method, p, req, status, change] of STEPS) {
    const r = await h.call(method, p, req);
    assert.equal(r.status, status, `${method} ${p} ${JSON.stringify(req.json || null)}: ${r.text}`);
    if (change) assertAnnounced(h, ...change);
    else assertSilent(h, `${method} ${p} ${JSON.stringify(req.json || null)}`);
  }
  assert.deepStrictEqual(fs.readdirSync(projectPaths(h.root).dir), [], 'and back to nothing');
});

// ── the brand routes, through the same reader and response ──────────────────

test('brand routes: readImageBody and sendImage are exported, and both route files read and serve through them', async (t) => {
  assert.equal(typeof brandRoutes.readImageBody, 'function');
  assert.equal(typeof brandRoutes.sendImage, 'function');
  assert.equal(typeof brandRoutes.mountBrandRoutes, 'function');
  assert.equal(typeof brandRoutes.changesGlobalTheme, 'function');

  const h = await routeHost(t, { brand: true });
  // An upload and its image, on each side.
  let r = await h.call('PUT', '/api/brand/logotype', { body: WIDE, type: 'image/png' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.type, 'image/png');
  const brandEvents = h.taken().map((e) => e.event);
  assert.equal(brandEvents.length, 1);
  assert.equal(brandEvents[0].kind, 'brand');
  assert.equal(brandEvents[0].op, 'set');
  assert.equal(brandEvents[0].slot, 'logotype');
  await h.putImage('logo', WIDE);
  h.taken();

  const fromBrand = await h.call('GET', '/brand/logotype?mode=dark');
  const fromProject = await h.call('GET', '/project/logo?mode=dark');
  assertLockedDown(fromBrand, 'image/png');
  assertLockedDown(fromProject, 'image/png');
  assert.deepStrictEqual(fromBrand.buf, WIDE);
  assert.deepStrictEqual(fromProject.buf, WIDE);
  assert.equal((await h.call('GET', '/brand/lockup')).status, 404);

  // One reader: the same refusal, word for word, from either route.
  const over = Buffer.concat([WIDE, Buffer.alloc(MAX_BYTES + 10)]);
  for (const [body, type, status] of [[over, 'image/png', 413], [GIF, 'image/gif', 415], [WIDE, null, 415]]) {
    const a = await h.call('PUT', '/api/brand/seal', { body, type });
    const b = await h.call('PUT', '/api/project/logo', { body, type });
    assert.equal(a.status, status);
    assert.equal(b.status, status);
    assert.deepStrictEqual(a.json, b.json, `${status}: one message`);
  }
  // The bytes decide on both, through the one engine check.
  for (const p of ['/api/brand/seal', '/api/project/logo']) {
    r = await h.call('PUT', p, { body: GIF, type: 'image/png' });
    assert.equal(r.status, 415, p);
    r = await h.call('PUT', p, { body: ACTIVE_SVG, type: 'image/svg+xml' });
    assert.equal(r.status, 422, p);
  }
  r = await h.call('DELETE', '/api/brand/logotype');
  assert.equal(r.json.removed, true);
  assert.equal((await h.call('GET', '/brand/logotype')).status, 404);
});

test('brand routes: an unknown slot is a 404 before its body is read, whatever it carries', async (t) => {
  const h = await routeHost(t, { brand: true });
  const over = Buffer.concat([WIDE, Buffer.alloc(MAX_BYTES + 10)]);
  for (const [body, type] of [[WIDE, 'image/png'], [GIF, 'image/gif'], [over, 'image/png'], [WIDE, null]]) {
    const r = await h.call('PUT', '/api/brand/favicon', { body, type });
    assert.equal(r.status, 404, `${type} ${body.length}`);
    assert.deepStrictEqual(r.json, { error: 'unknown brand slot \'favicon\'' });
  }
  const del = await h.call('DELETE', '/api/brand/favicon');
  assert.equal(del.status, 404);
  assert.deepStrictEqual(del.json, { error: 'unknown brand slot \'favicon\'' });
  assert.equal(fs.existsSync(projectPaths(h.root).brandDir), false, 'nothing written');
  assertSilent(h, 'an unknown slot');
});

// Until the conventions ratchet carries a row for them (U22b), this pins spec
// §9.3's "so neither is copied": the body reader and the image headers are
// spelled once, in routes/brand.js, and routes/project.js spells neither.
test('routes/project.js copies neither the body reader nor the image headers: one of each, in routes/brand.js', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'routes', f), 'utf8');
  const count = (src, s) => src.split(s).length - 1;
  const project = read('project.js');
  const brand = read('brand.js');
  for (const s of ['express.raw(', "'X-Content-Type-Options'", "'Content-Security-Policy'", "'Cross-Origin-Resource-Policy'"]) {
    assert.equal(count(project, s), 0, `routes/project.js spells ${s}`);
    assert.equal(count(brand, s), 1, `routes/brand.js spells ${s} once`);
  }
  assert.match(project, /const \{ readImageBody, sendImage \} = require\('\.\/brand'\);/);
});

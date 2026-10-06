// `claude-web-chat identity` (lib/cli/commands/identity.js, spec §9.6, D11):
// the project's name, logo and favicon (each with a dark variant) and the
// show-name toggle, set from the host.
//
// What must hold:
//   * every verb works with and without a running surface: through the daemon's
//     /api/project routes when one answers (each change one `project` bus event
//     and one frame to every viewer), else straight through the engine;
//   * the image bytes reach the daemon exactly as the pipeline made them (a
//     Buffer body), and the preview pane carries them byte for byte as data:
//     URLs (the D11 corruption guard);
//   * the user's file is never modified; a dark variant is written after its
//     light image, and a changed image without --dark loses its old one, said;
//   * the refusals: no two hues, an SVG never rasterised, a dark variant of
//     another shape (the engine's 422), a favicon that is not square, a JPEG;
//   * outside a project every verb refuses before it reads a file;
//   * the CLI is local: no request it makes carries the portal's remote label;
//   * the project-identity skill installs as a managed file.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const identity = require('../lib/cli/commands/identity');
const project = require('../lib/core/project-identity');
const icon = require('../lib/core/icon');
const client = require('../lib/client');
const { decodePng } = require('../lib/core/png');
const { projectPaths } = require('../lib/core/paths');
const { MANAGED_FILES, templatesDir } = require('../lib/update/managed-files');
const reg = require('../lib/setup/registration');
const { withServer, withTempHome, tmpRoot, waitUntil } = require('../test-support/helpers');
const { encodePng } = require('../test-support/png-encode');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(REPO, 'test', 'fixtures', 'icon');
const ICON = path.join(FIX, 'web-chat-dev-icon.png');
const ICON_DARK = path.join(FIX, 'web-chat-dev-icon-dark.png');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const samePixels = (a, b) => {
  const x = decodePng(a); const y = decodePng(b);
  return x.width === y.width && x.height === y.height && x.data.equals(y.data);
};

function capture() {
  const lines = [];
  return { log: (s) => lines.push(String(s)), lines, text: () => lines.join('\n') };
}

async function run(args, opts) {
  const c = capture();
  const r = await identity(args, { log: c.log, ...opts });
  return { r, text: c.text() };
}

// A refusal: a userFacing error whose message matches.
async function refused(args, opts, re) {
  const c = capture();
  await assert.rejects(identity(args, { log: c.log, ...opts }), (e) => {
    assert.equal(e.userFacing, true, `a userFacing refusal, got: ${e.stack}`);
    assert.match(e.message, re);
    return true;
  });
  return c.text();
}

// A canvas with a transparent ground and `paint(x, y)` → [r, g, b] | null.
function sprite(w, h, paint) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      if (c) data.set([...c, 255], (y * w + x) * 4);
    }
  }
  return encodePng(data, w, h);
}

const inside = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;

// Fixtures written once into a scratch directory outside any project.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-identity-fix-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });
const fixture = (name, bytes) => { const f = path.join(SCRATCH, name); fs.writeFileSync(f, bytes); return f; };

// One hue only (red, a darker red border): no automatic dark variant.
const RED = fixture('red.png', sprite(20, 20, (x, y) => (inside(x, y, 4, 4, 16, 16)
  ? (inside(x, y, 5, 5, 15, 15) ? [220, 30, 30] : [120, 10, 10]) : null)));
// 3:1 artwork in two colours: a fine logo, never a favicon.
const WIDE3 = fixture('wide3.png', sprite(48, 18, (x, y) => (inside(x, y, 3, 3, 45, 17) ? (x < 24 ? [30, 60, 220] : [230, 190, 30]) : null)));
// 2.25:1, for a dark variant of the wrong shape.
const WIDE2 = fixture('wide2.png', sprite(40, 20, (x, y) => (inside(x, y, 2, 2, 38, 18) ? [30, 60, 220] : null)));
// 1.2:1: padded to a square for a favicon.
const NEAR = fixture('near.png', sprite(28, 24, (x, y) => (inside(x, y, 2, 2, 26, 22) ? (y < 12 ? [30, 60, 220] : [230, 190, 30]) : null)));
const SVG = fixture('mark.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#3366ff"/></svg>\n');
const JPEG = fixture('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]));

// A tmp project (it has .web-chat/) with no daemon.
function directProject(t) {
  withTempHome(t);
  const root = tmpRoot('wc-identity-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Every client.api call this file's CLI makes, recorded (and passed through).
function spyApi(t) {
  const calls = [];
  const orig = client.api;
  client.api = (method, p, body, opts) => {
    calls.push({ method, path: p, body, headers: (opts && opts.headers) || {}, opts });
    return orig(method, p, body, opts);
  };
  t.after(() => { client.api = orig; });
  return calls;
}

async function projectEvents(h) {
  const { events } = (await h.api.get('/api/events?since=0')).json;
  return events.filter((e) => e.kind === 'project');
}

// Frames of one type, as every viewer receives them.
function viewer(h, type) {
  const sock = h.ws();
  const frames = [];
  sock.on('message', (data) => {
    let m = null;
    try { m = JSON.parse(data.toString()); } catch {}
    if (m && m.type === type) frames.push(m);
  });
  const open = new Promise((resolve) => sock.on('open', resolve));
  return { frames, open, close: () => sock.close() };
}

// ── direct mode ─────────────────────────────────────────────────────────────

test('direct: logo with --dark <file> writes both, pixel-equal, and leaves the inputs untouched', async (t) => {
  const root = directProject(t);
  const before = [sha(ICON), sha(ICON_DARK)];
  const { r, text } = await run(['logo', ICON, '--dark', ICON_DARK], { cwd: root });
  assert.equal(r.via, 'direct');
  assert.match(text, /written directly \(no surface running\)/);
  const pp = projectPaths(root);
  assert.ok(samePixels(fs.readFileSync(`${pp.projectLogo}.png`), fs.readFileSync(ICON)), 'project-logo.png is the fixture, pixel for pixel');
  assert.ok(samePixels(fs.readFileSync(`${pp.projectLogoDark}.png`), fs.readFileSync(ICON_DARK)), 'project-logo-dark.png is the dark fixture');
  const id = project.identity(root);
  assert.equal(id.mark, 'logo');
  assert.equal(id.mark_dark, true);
  assert.deepEqual(r.written.map((w) => w.kind), ['logo', 'logo-dark'], 'light, then dark');
  assert.deepEqual([sha(ICON), sha(ICON_DARK)], before, 'the user\'s files are never modified');
});

test('direct: a second logo run without --dark removes the earlier dark variant, and says so', async (t) => {
  const root = directProject(t);
  await run(['logo', ICON, '--dark', 'auto'], { cwd: root });
  assert.ok(project.identity(root).logo_dark);
  const { r, text } = await run(['logo', ICON, '--background', 'tile'], { cwd: root });
  assert.equal(r.dark_removed, true);
  assert.match(text, /earlier dark variant was removed/);
  assert.equal(project.identity(root).logo_dark, null);
  assert.equal(project.identity(root).mark_dark, false);
});

// ── daemon mode ─────────────────────────────────────────────────────────────

test('daemon: logo --dark auto is PUT logo then PUT logo-dark, as raw bytes, two project events and two frames', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    const calls = spyApi(t);
    const v = viewer(h, 'project');
    await v.open;
    const sum = sha(ICON);
    const { r, text } = await run(['logo', ICON, '--dark', 'auto'], { cwd: h.root });
    assert.equal(r.via, 'daemon');
    assert.match(text, /through the running surface/);

    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /api/project/logo', 'PUT /api/project/logo-dark']);
    for (const c of calls) {
      assert.ok(Buffer.isBuffer(c.body), 'the image goes as a Buffer body');
      assert.equal(c.headers['Content-Type'], 'image/png');
      assert.ok(!Object.keys(c.headers).some((k) => k.toLowerCase() === 'x-wc-remote'), 'the CLI is local: no remote label');
      assert.equal(c.opts.noSpawn, true, 'never spawns a daemon');
    }

    // The bytes the daemon stored are exactly the pipeline's.
    const prepared = icon.prepare(fs.readFileSync(ICON), { kind: 'logo', mode: 'auto', tile: null });
    const darkBytes = icon.encode(icon.darkVariant(prepared.variants.transparent.image, { cell: prepared.cell }).image);
    const pp = projectPaths(h.root);
    assert.ok(fs.readFileSync(`${pp.projectLogo}.png`).equals(prepared.variants.transparent.bytes));
    assert.ok(fs.readFileSync(`${pp.projectLogoDark}.png`).equals(darkBytes));
    assert.ok(calls[0].body.equals(prepared.variants.transparent.bytes) && calls[1].body.equals(darkBytes));
    assert.ok(samePixels(darkBytes, fs.readFileSync(ICON_DARK)), 'the generated dark variant is variant A');

    const id = project.identity(h.root);
    assert.ok(id.logo && id.logo_dark);
    assert.deepEqual((await projectEvents(h)).map((e) => e.field), ['logo', 'logo_dark'], 'exactly two project events');
    await waitUntil(() => v.frames.length >= 2, { what: 'two project frames' });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(v.frames.length, 2, 'one frame per change, to every viewer');
    assert.equal(v.frames[1].identity.mark_dark, true);
    v.close();
    assert.equal(sha(ICON), sum);
  });
});

test('daemon: a second logo run without --dark removes the dark variant (dark_removed), said', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    await run(['logo', ICON, '--dark', 'auto'], { cwd: h.root });
    const { r, text } = await run(['logo', ICON, '--background', 'tile:#203040'], { cwd: h.root });
    assert.equal(r.via, 'daemon');
    assert.equal(r.dark_removed, true);
    assert.match(text, /earlier dark variant was removed/);
    assert.equal(project.identity(h.root).logo_dark, null);
  });
});

test('daemon: an image refusal from the route prints the engine\'s message and its status', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    await refused(['logo', ICON, '--dark', WIDE2], { cwd: h.root }, /422.*must have the logo's shape/s);
    assert.ok(project.identity(h.root).logo, 'the light image was written first');
    assert.equal(project.identity(h.root).logo_dark, null);
  });
});

test('a daemon older than the routes (a non-JSON 404) falls back to the direct write and names the restart', async (t) => {
  const root = directProject(t);
  // A bare server stands in for a daemon from before /api/project existed.
  const http = require('http');
  const old = http.createServer((req, res) => { req.resume(); res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('Cannot PUT'); });
  await new Promise((res) => old.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => old.close(res)));
  const { r, text } = await run(['name', 'Acme Web'], { cwd: root, port: old.address().port });
  assert.equal(r.via, 'direct');
  assert.match(text, /predates this; claude-web-chat restart shows it/);
  assert.equal(project.identity(root).name, 'Acme Web');
});

test('a portfile whose daemon refuses the connection writes directly', async (t) => {
  const root = directProject(t);
  const { r, text } = await run(['show-name', 'off'], { cwd: root, port: 1 });
  assert.equal(r.via, 'direct');
  assert.match(text, /written directly \(no surface running\)/);
  assert.equal(project.identity(root).show_name, false);
});

// ── the refusals ────────────────────────────────────────────────────────────

test('--dark auto on a single-hue PNG says there are no two hues and writes no dark image', async (t) => {
  const root = directProject(t);
  const { r, text } = await run(['logo', RED, '--dark', 'auto'], { cwd: root });
  assert.ok(text.includes(identity.NO_TWO_HUES), text);
  assert.ok(project.identity(root).logo);
  assert.equal(project.identity(root).logo_dark, null);
  assert.deepEqual(r.written.map((w) => w.kind), ['logo']);
  assert.ok(!fs.readdirSync(projectPaths(root).dir).some((f) => f.startsWith('project-logo-dark')));
});

test('an SVG is never rasterised: --dark auto and --background tile are refused, and nothing is written', async (t) => {
  const root = directProject(t);
  await refused(['logo', SVG, '--dark', 'auto'], { cwd: root }, /never rasterised.*only --dark <file>/s);
  await refused(['logo', SVG, '--background', 'tile'], { cwd: root }, /never rasterised/);
  assert.equal(project.identity(root).logo, null);
  // As it is, it is stored byte for byte.
  await run(['logo', SVG], { cwd: root });
  assert.ok(fs.readFileSync(`${projectPaths(root).projectLogo}.svg`).equals(fs.readFileSync(SVG)));
});

test('--dark <file> of another aspect prints the engine\'s 422 message and exits 1', async (t) => {
  const root = directProject(t);
  await refused(['logo', ICON, '--dark', WIDE2], { cwd: root }, /422.*must have the logo's shape/s);
  assert.equal(project.identity(root).logo_dark, null);
});

test('favicon: 3:1 is refused with the not-square hint; 1.2:1 is padded to a square; a JPEG gets the sips hint', async (t) => {
  const root = directProject(t);
  await refused(['favicon', WIDE3], { cwd: root }, /a favicon must be square[\s\S]*crop the artwork to its mark/);
  assert.equal(project.identity(root).favicon, null);
  await run(['favicon', NEAR], { cwd: root });
  const f = project.identity(root).favicon;
  assert.ok(f && f.width === f.height, `square: ${f && `${f.width}×${f.height}`}`);
  assert.equal(project.identity(root).mark, 'favicon');
  await refused(['favicon', JPEG], { cwd: root }, /sips -s format png/);
});

// ── name, show-name, clear — through the daemon and directly ────────────────

for (const mode of ['direct', 'daemon']) {
  test(`${mode}: name, name --reset, show-name off|on, clear logo, clear all, and a bare clear`, async (t) => {
    const go = async (h) => {
      const root = h ? h.root : directProject(t);
      const opts = { cwd: root };
      const via = (r) => assert.equal(r.via, mode);

      let { r } = await run(['name', 'Acme Web'], opts);
      via(r);
      assert.equal(project.identity(root).name, 'Acme Web');
      assert.equal(project.identity(root).custom, true);

      ({ r } = await run(['name', '--reset'], opts));
      via(r);
      assert.equal(project.identity(root).custom, false);
      assert.equal(project.identity(root).name, project.identity(root).default_name);

      ({ r } = await run(['show-name', 'off'], opts));
      via(r);
      assert.equal(project.identity(root).show_name, false);
      ({ r } = await run(['show-name', 'on'], opts));
      assert.equal(project.identity(root).show_name, true);

      await run(['logo', ICON, '--dark', 'auto'], opts);
      ({ r } = await run(['clear', 'logo'], opts));
      via(r);
      assert.equal(project.identity(root).logo, null);
      assert.equal(project.identity(root).logo_dark, null, 'the light image takes its dark variant with it');

      await run(['logo', ICON, '--dark', 'auto'], opts);
      await run(['favicon', NEAR], opts);
      await run(['name', 'Acme Web'], opts);
      await run(['show-name', 'off'], opts);
      let text;
      ({ r, text } = await run(['clear', 'all'], opts));
      via(r);
      assert.match(text, /cleared/);
      const id = project.identity(root);
      for (const k of ['logo', 'logo_dark', 'favicon', 'favicon_dark']) assert.equal(id[k], null, k);
      assert.equal(id.custom, false);
      assert.equal(id.show_name, true);
      assert.equal(fs.existsSync(projectPaths(root).projectJson), false, 'nothing left in project.json');

      await refused(['clear'], opts, /logo, logo-dark, favicon, favicon-dark, name, all/);
      await refused(['show-name', 'maybe'], opts, /on or off/);
      if (h) {
        const fields = (await projectEvents(h)).map((e) => e.field);
        assert.ok(fields.length > 0 && fields.every((f) => ['name', 'show_name', 'logo', 'logo_dark', 'favicon', 'favicon_dark'].includes(f)));
      }
    };
    if (mode === 'daemon') await withServer(t, { writePortfile: true }, go);
    else await go(null);
  });
}

// ── show ────────────────────────────────────────────────────────────────────

test('show: the name and its source, each image\'s type, size and aspect, the mark, and the two modes', async (t) => {
  const root = directProject(t);
  let { text } = await run(['show'], { cwd: root });
  assert.match(text, new RegExp(`"${path.basename(root)}" — the folder's name`));
  assert.match(text, /logo +none/);
  assert.match(text, /mark +none — the phone's topbar shows no mark, and the tab shows web-chat's W/);

  await run(['name', 'Acme Web'], { cwd: root });
  await run(['logo', ICON, '--dark', 'auto'], { cwd: root });
  await run(['favicon', NEAR], { cwd: root });
  let r;
  ({ r, text } = await run(['show'], { cwd: root }));
  const id = project.identity(root);
  assert.deepEqual(r.identity, id);
  assert.match(text, /"Acme Web" — set \(the folder's name is/);
  assert.ok(text.includes(`logo          PNG ${id.logo.width}×${id.logo.height} (1:1), ${id.logo.bytes} bytes`), text);
  assert.ok(text.includes(`logo dark     PNG ${id.logo_dark.width}×${id.logo_dark.height} (1:1)`), text);
  assert.ok(text.includes(`favicon       PNG ${id.favicon.width}×${id.favicon.height} (1:1)`), text);
  assert.match(text, /favicon dark +none/);
  assert.match(text, /mark +the favicon, no dark variant/);
  assert.match(text, /show name +on/);
  assert.match(text, /the topbar follows web-chat's ◑ mode; the tab's favicon follows the browser's colour scheme/);

  fs.writeFileSync(projectPaths(root).projectJson, '{ not json');
  ({ r, text } = await run(['show'], { cwd: root }));
  assert.equal(r.identity.corrupt, true);
  assert.match(text, /corrupt/);
});

// ── outside a project ───────────────────────────────────────────────────────

test('outside a project every verb refuses before it reads or writes anything', async (t) => {
  withTempHome(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-identity-none-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'no-such-image.png');
  const out = path.join(dir, 'out');
  for (const args of [
    ['show'], ['name', 'Acme'], ['name', '--reset'], ['show-name', 'off'], ['clear', 'all'],
    ['logo', missing], ['favicon', missing], ['logo', ICON, '--dry-run', '--out', out], ['logo', ICON, '--preview'],
  ]) {
    await refused(args, { cwd: dir }, /no \.web-chat\/ in .*claude-web-chat init/);
  }
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was created');
});

// ── --dry-run and --preview ─────────────────────────────────────────────────

test('--dry-run --out writes the four candidates and nothing under .web-chat/', async (t) => {
  const root = directProject(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-identity-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const target = path.join(out, 'nested');
  const before = fs.readdirSync(projectPaths(root).dir).sort();
  const { r, text } = await run(['logo', ICON, '--dark', 'auto', '--dry-run', '--out', target], { cwd: root });
  assert.equal(r.applied, false);
  assert.deepEqual(fs.readdirSync(target).sort(), ['logo-dark.png', 'logo-tile-dark.png', 'logo-tile.png', 'logo.png']);
  for (const c of r.candidates) {
    assert.ok(fs.readFileSync(path.join(target, c.name)).equals(c.bytes), c.name);
    assert.ok(text.includes(path.join(target, c.name)), `prints ${c.name}`);
    assert.match(text, new RegExp(`${c.width}×${c.height}`));
  }
  assert.deepEqual(fs.readdirSync(projectPaths(root).dir).sort(), before, 'nothing written under .web-chat/');
  assert.equal(project.identity(root).logo, null);
});

test('--out inside .web-chat/ is refused, --out without --dry-run is refused, and a candidate never lands on an input', async (t) => {
  const root = directProject(t);
  await refused(['logo', ICON, '--dry-run', '--out', path.join(root, '.web-chat', 'x')], { cwd: root }, /inside \.web-chat/);
  await refused(['logo', ICON, '--dry-run', '--out', '.web-chat'], { cwd: root }, /inside \.web-chat/);
  await refused(['logo', ICON, '--out', path.join(root, 'cands')], { cwd: root }, /--out goes with --dry-run/);
  const mine = path.join(root, 'art');
  fs.mkdirSync(mine);
  const logo = path.join(mine, 'logo.png');
  fs.copyFileSync(RED, logo);
  const sum = sha(logo);
  await refused(['logo', logo, '--dry-run', '--out', mine], { cwd: root }, /over your file/);
  assert.equal(sha(logo), sum);
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'x')), false);
});

test('--out through a link that reaches .web-chat/ is refused, and nothing lands there', async (t) => {
  const root = directProject(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-identity-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const link = path.join(outside, 'state');
  fs.symlinkSync(path.join(root, '.web-chat'), link);
  const before = fs.readdirSync(projectPaths(root).dir).sort();
  await refused(['logo', ICON, '--dry-run', '--out', path.join(link, 'cands')], { cwd: root }, /inside \.web-chat/);
  await refused(['logo', ICON, '--dry-run', '--out', link], { cwd: root }, /inside \.web-chat/);
  assert.deepEqual(fs.readdirSync(projectPaths(root).dir).sort(), before, 'nothing written under .web-chat/');
});

test('--preview without a running surface refuses: run claude-web-chat open first', async (t) => {
  const root = directProject(t);
  await refused(['logo', ICON, '--preview'], { cwd: root }, /claude-web-chat open first/);
  await refused(['logo', ICON, '--dry-run', '--preview'], { cwd: root }, /claude-web-chat open first/);
  assert.equal(project.identity(root).logo, null);
});

test('--preview mounts identity-preview with the queue signal, and every data: URL is a candidate\'s exact bytes', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    await run(['name', '<b>Acme</b> & Co'], { cwd: h.root });
    const { r, text } = await run(['logo', ICON, '--dark', 'auto', '--dry-run', '--preview'], { cwd: h.root });
    assert.equal(r.applied, false);
    assert.equal(project.identity(h.root).logo, null, 'a preview applies nothing');
    assert.match(text, /identity_pick/);
    assert.match(text, /claude-web-chat identity logo .* --background/);

    const hello = await h.wsHello();
    const pane = hello.mounts.find((m) => m.id === identity.PREVIEW_ID);
    assert.ok(pane, 'the preview pane is on the surface');
    assert.deepEqual(pane.params.signals, [{ key: 'identity_pick', wake: 'queue' }]);

    const urls = [...pane.html.matchAll(/data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)/g)];
    assert.ok(urls.length >= r.candidates.length * 4, 'each candidate at every size');
    const want = new Map(r.candidates.map((c) => [c.bytes.toString('base64'), c]));
    for (const [, type, b64] of urls) {
      const c = want.get(b64);
      assert.ok(c, 'every data:image URL decodes to exactly one candidate\'s bytes');
      assert.equal(type, c.type);
      assert.ok(Buffer.from(b64, 'base64').equals(c.bytes));
    }
    for (const b64 of want.keys()) assert.ok(urls.some((u) => u[2] === b64), 'every candidate is shown');
    assert.equal(r.candidates.length, 4, 'transparent, tile and their dark variants');
    // The candidates are the pipeline's own bytes.
    const prepared = icon.prepare(fs.readFileSync(ICON), { kind: 'logo', mode: 'auto', tile: null });
    assert.ok(want.has(prepared.variants.transparent.bytes.toString('base64')));
    assert.ok(want.has(prepared.variants.tile.bytes.toString('base64')));

    assert.ok(!pane.html.includes('<b>Acme</b>'), 'the name is escaped');
    assert.ok(pane.html.includes('&lt;b&gt;Acme&lt;/b&gt; &amp; Co'));
    assert.ok(!/document\.(querySelector|getElementById)/.test(pane.html), 'the script queries only its root');
    assert.match(pane.html, /store\.set\(\{ identity_pick: \{ seq: seq, kind: p\.kind, background: p\.background, dark: p\.dark \} \}\)/);
  });
});

// ── the skill ───────────────────────────────────────────────────────────────

test('the project-identity skill is a managed file, and an install writes it', (t) => {
  withTempHome(t);
  const row = MANAGED_FILES.find((f) => f.tpl === 'skills/project-identity/SKILL.md');
  assert.ok(row, 'registered in MANAGED_FILES');
  assert.equal(row.dest, '.claude/skills/project-identity/SKILL.md');
  const tpl = fs.readFileSync(path.join(templatesDir(), row.tpl), 'utf8');
  assert.match(tpl, /^---\nname: project-identity\ndescription: /);
  const root = tmpRoot('wc-identity-install-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  reg.apply(root, { runClaude: () => ({ ok: true }) });
  assert.equal(fs.readFileSync(path.join(root, row.dest), 'utf8'), tpl);
});

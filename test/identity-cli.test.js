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

// The square logo is the mark here (no favicon), so its home-screen icon
// follows it, last (U77b, ruling U77b@touch-icon-source (b)).
test('daemon: logo --dark auto is PUT logo, PUT logo-dark, then PUT touch-icon, as raw bytes, three project events and three frames', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    const calls = spyApi(t);
    const v = viewer(h, 'project');
    await v.open;
    const sum = sha(ICON);
    const { r, text } = await run(['logo', ICON, '--dark', 'auto'], { cwd: h.root });
    assert.equal(r.via, 'daemon');
    assert.match(text, /through the running surface/);

    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /api/project/logo', 'PUT /api/project/logo-dark', 'PUT /api/project/touch-icon']);
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
    assert.ok(calls[2].body.equals(prepared.variants.touch.bytes), 'the touch icon is the pipeline\'s touch variant');
    assert.ok(samePixels(darkBytes, fs.readFileSync(ICON_DARK)), 'the generated dark variant is variant A');

    const id = project.identity(h.root);
    assert.ok(id.logo && id.logo_dark);
    assert.deepEqual((await projectEvents(h)).map((e) => e.field), ['logo', 'logo_dark', 'touch'], 'exactly three project events');
    await waitUntil(() => v.frames.length >= 3, { what: 'three project frames' });
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(v.frames.length, 3, 'one frame per change, to every viewer');
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
        // touch: the home-screen icon follows the mark (U77b).
        assert.ok(fields.length > 0 && fields.every((f) => ['name', 'show_name', 'logo', 'logo_dark', 'favicon', 'favicon_dark', 'touch'].includes(f)));
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

test('--preview of a 3:1 logo keeps its aspect at every size, and its mock tab says it is not the tab\'s icon', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    const { r, text } = await run(['logo', WIDE3, '--dry-run', '--preview'], { cwd: h.root });
    const hello = await h.wsHello();
    const pane = hello.mounts.find((m) => m.id === identity.PREVIEW_ID);
    assert.ok(pane, 'the preview pane is on the surface');
    const byB64 = new Map(r.candidates.map((c) => [c.bytes.toString('base64'), c]));
    const imgs = [...pane.html.matchAll(/<img[^>]*src="data:[^;]+;base64,([A-Za-z0-9+/=]+)"[^>]*width="(\d+)" height="(\d+)"/g)];
    assert.ok(imgs.length >= r.candidates.length * 2 * 4, 'every candidate at the four sizes on both grounds');
    for (const [, b64, w, h_] of imgs) {
      const c = byB64.get(b64);
      assert.ok(c, 'a candidate\'s bytes');
      assert.ok(c.width / c.height > icon.NEAR_SQUARE, `a wide candidate (${c.width}×${c.height}: the 3:1 artwork within its margins)`);
      assert.equal(Number(w), Math.round((Number(h_) * c.width) / c.height),
        `drawn ${w}×${h_}: its own aspect, never squashed into a square`);
    }
    assert.ok(!/width="16" height="16"/.test(pane.html), 'no 16×16 mock tab icon for a wordmark');
    assert.match(pane.html, /Not the tab&#39;s icon: a logo that is not square never shows in the tab/);
    assert.doesNotMatch(text, /mock tab/, 'the summary names no mock tab');
    assert.match(text, /beside the topbar lockup/);
  });
});

// ── --pad and --crop (ruling U50@skill:wide-logo-pad, D1 d: U49b) ───────────

// WIDE3's left 18×18: its blue half's 15×14 end, with transparent corners.
const CROP_BOX = '0,0,18,18';
const CROP = { x: 0, y: 0, w: 18, h: 18 };
const outDirFor = (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-identity-shape-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return out;
};
const sizeOf = (file) => { const im = decodePng(fs.readFileSync(file)); return [im.width, im.height]; };

test('favicon <wide.png> --pad --dry-run --out writes square candidates, with the padding note, and applies nothing', async (t) => {
  const root = directProject(t);
  const out = outDirFor(t);
  const { r, text } = await run(['favicon', WIDE3, '--pad', '--dry-run', '--out', out], { cwd: root });
  assert.equal(r.applied, false);
  assert.deepEqual(fs.readdirSync(out).sort(), ['favicon-tile.png', 'favicon-touch.png', 'favicon.png']);
  for (const f of fs.readdirSync(out)) {
    const [w, h] = sizeOf(path.join(out, f));
    assert.equal(w, h, `${f} is square: ${w}×${h}`);
  }
  const want = icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, pad: true });
  assert.ok(fs.readFileSync(path.join(out, 'favicon.png')).equals(want.variants.transparent.bytes), 'the engine\'s padded bytes');
  assert.ok(fs.readFileSync(path.join(out, 'favicon-touch.png')).equals(want.variants.touch.bytes));
  assert.match(text, /· padded to a square: the \d+×\d+ (px|cell) artwork \(3\.00:1\) is centred/);
  assert.match(text, /text in it will be unreadable at 16 px/);
  assert.equal(project.identity(root).favicon, null);
});

test('--pad and --crop shape a --dark <file> as they shape the light image', async (t) => {
  const root = directProject(t);
  const out = outDirFor(t);
  await run(['favicon', WIDE3, '--pad', '--dark', WIDE3, '--dry-run', '--out', out], { cwd: root });
  const want = icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, pad: true });
  assert.ok(fs.readFileSync(path.join(out, 'favicon-dark.png')).equals(want.variants.transparent.bytes), 'the dark file, padded');
  const cropOut = outDirFor(t);
  await run(['favicon', WIDE3, '--crop', CROP_BOX, '--dark', WIDE3, '--dry-run', '--out', cropOut], { cwd: root });
  const cropped = icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, crop: CROP });
  assert.ok(fs.readFileSync(path.join(cropOut, 'favicon-dark.png')).equals(cropped.variants.transparent.bytes), 'the dark file, cropped');
});

test('favicon <wide.png> --crop x,y,w,h --dry-run --out writes the cropped candidates', async (t) => {
  const root = directProject(t);
  const out = outDirFor(t);
  const { r, text } = await run(['favicon', WIDE3, '--crop', CROP_BOX, '--dry-run', '--out', out], { cwd: root });
  assert.equal(r.applied, false);
  const want = icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, crop: CROP });
  for (const [f, v] of [['favicon.png', 'transparent'], ['favicon-tile.png', 'tile'], ['favicon-touch.png', 'touch']]) {
    assert.ok(fs.readFileSync(path.join(out, f)).equals(want.variants[v].bytes), f);
    const [w, h] = sizeOf(path.join(out, f));
    assert.equal(w, h, `${f} is square`);
  }
  assert.match(text, /· cropped to 18×18 at 0,0 of the 48×18 image/);
  // --crop=… spells the same, and a logo takes it too.
  const again = await run(['logo', WIDE3, `--crop=${CROP_BOX}`, '--dry-run'], { cwd: root });
  assert.ok(again.r.candidates.every((c) => c.width === c.height), 'a square logo');
});

test('--pad and --crop apply: the favicon is the padded or cropped artwork, and the mark', async (t) => {
  const root = directProject(t);
  await run(['favicon', WIDE3, '--pad'], { cwd: root });
  let f = project.identity(root).favicon;
  assert.ok(f && f.width === f.height, `square: ${f && `${f.width}×${f.height}`}`);
  assert.ok(project.readImage(root, 'favicon').bytes.equals(
    icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, pad: true }).variants.transparent.bytes));
  await run(['favicon', WIDE3, '--crop', CROP_BOX, '--background', 'tile'], { cwd: root });
  f = project.identity(root).favicon;
  assert.ok(f && f.width === f.height);
  assert.ok(project.readImage(root, 'favicon').bytes.equals(
    icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, crop: CROP }).variants.tile.bytes));
  assert.equal(project.identity(root).mark, 'favicon');
});

test('--preview of a padded favicon mounts the square candidates, with the mock tab and the flag in the apply line', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    const { r, text } = await run(['favicon', WIDE3, '--pad', '--dry-run', '--preview'], { cwd: h.root });
    assert.equal(project.identity(h.root).favicon, null, 'a preview applies nothing');
    const pane = (await h.wsHello()).mounts.find((m) => m.id === identity.PREVIEW_ID);
    assert.ok(pane, 'the preview pane is on the surface');
    const shown = new Set([...pane.html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]));
    for (const c of r.candidates) {
      assert.equal(c.width, c.height, `${c.name} is square`);
      assert.ok(shown.has(c.bytes.toString('base64')), `${c.name} is on the pane`);
    }
    assert.match(pane.html, /class="idp-tab idp-light"><img src="data:image\/png;base64,[^"]+" width="16" height="16"/, 'a square candidate gets the mock tab');
    assert.match(text, /beside a mock tab/);
    assert.match(text, /Then apply the pick: claude-web-chat identity favicon \S+ --pad --background <background>/);
    await run(['favicon', WIDE3, '--crop', CROP_BOX, '--dry-run', '--preview'], { cwd: h.root });
    const cropped = (await h.wsHello()).mounts.find((m) => m.id === identity.PREVIEW_ID);
    const want = icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, crop: CROP });
    assert.ok(cropped.html.includes(want.variants.transparent.bytes.toString('base64')), 'the cropped candidate is mounted');
  });
});

test('an SVG with --pad or --crop is refused with a hint, and nothing is written', async (t) => {
  const root = directProject(t);
  const text = await refused(['favicon', SVG, '--pad'], { cwd: root }, /an SVG cannot be padded: it is stored as it is and never rasterised\n {2}bring a PNG/);
  assert.equal(text, '');
  await refused(['logo', SVG, '--crop', '0,0,16,16'], { cwd: root }, /an SVG cannot be cropped[\s\S]*\n {2}bring a PNG/);
  await refused(['favicon', SVG, '--crop', '0,0,16,16', '--dry-run'], { cwd: root }, /never rasterised/);
  assert.equal(project.identity(root).favicon, null);
  assert.equal(project.identity(root).logo, null);
});

test('a malformed --crop, a box outside the image and --pad on a logo are refused; a wide favicon hears of both flags', async (t) => {
  const root = directProject(t);
  for (const bad of ['1,2,3', 'a,b,c,d', '0,0,0,5', '-1,0,4,4', '1.5,0,4,4', '0,0,4,4,4', '']) {
    await refused(['favicon', WIDE3, '--crop', bad], { cwd: root }, /--crop .*use x,y,w,h — four whole numbers[\s\S]*--dry-run --preview/);
  }
  await refused(['favicon', WIDE3, '--crop', '40,0,14,14'], { cwd: root }, /the crop is not inside the image[\s\S]*the image is 48×18 px/);
  await refused(['logo', WIDE3, '--pad'], { cwd: root }, /--pad is for a favicon only: a logo keeps its aspect[\s\S]*identity favicon \S+wide3\.png --pad/);
  await refused(['logo', ICON, '--pad', '--dry-run'], { cwd: root }, /--pad is for a favicon only/);
  await refused(['favicon', WIDE3, '--pad=yes'], { cwd: root }, /--pad takes no value/);
  await refused(['favicon', WIDE3], { cwd: root }, /crop the artwork to its mark[\s\S]*--pad centres it on a square[\s\S]*--crop x,y,w,h/);
  // A crop still too wide is refused as not square, unless --pad is asked too.
  await refused(['favicon', WIDE3, '--crop', '0,0,48,18'], { cwd: root }, /a favicon must be square/);
  await run(['favicon', WIDE3, '--crop', '0,0,48,18', '--pad'], { cwd: root });
  assert.equal(project.identity(root).mark, 'favicon');
  assert.match(identity.USAGE, /--crop x,y,w,h/);
  assert.match(identity.USAGE, /--pad {2,}a favicon only/);
});

test('an SVG logo with no viewBox gets the not-the-tab note in the preview, never the 16 px mock tab', async (t) => {
  const noBox = fixture('nobox.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="10" fill="#3366ff"/></svg>\n');
  await withServer(t, { writePortfile: true }, async (h) => {
    const { r, text } = await run(['logo', noBox, '--dry-run', '--preview'], { cwd: h.root });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].width, null, 'its size is unknown');
    const pane = (await h.wsHello()).mounts.find((m) => m.id === identity.PREVIEW_ID);
    assert.ok(pane, 'the preview pane is on the surface');
    assert.ok(!pane.html.includes('class="idp-tab'), 'no mock tab');
    assert.match(pane.html, /Not the tab&#39;s icon: a logo that is not square never shows in the tab/);
    assert.ok(!/NaN/.test(pane.html), 'every size is a number');
    assert.doesNotMatch(text, /mock tab/);
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

// Ruling U50@skill:wide-logo-pad (D1 d, 2026-10-06, superseding the provisional
// (b) this test pinned before): for a logo wider than 1.25:1 the skill FIRST
// says so and asks for a different (square) image or web-chat's W, and only if
// the user wants this logo offers --pad or --crop; a wide SVG gets only those
// two. The offer of padding for a logo up to 1.25:1 is kept as it was.
test('the skill\'s step 3 asks for a different image or web-chat\'s W before it offers pad or crop; a wide SVG gets only those two; both copies identical', () => {
  const tpl = fs.readFileSync(path.join(templatesDir(), 'skills/project-identity/SKILL.md'), 'utf8');
  const dogfood = fs.readFileSync(path.join(REPO, '.claude/skills/project-identity/SKILL.md'), 'utf8');
  assert.equal(dogfood, tpl, 'the dogfood copy is the template, byte for byte');
  assert.equal(icon.NEAR_SQUARE, 1.25, 'the skill\'s 1.25:1 is the engine\'s threshold');
  const at = tpl.indexOf('3. **Wide, or a wordmark?**');
  assert.ok(at >= 0, 'step 3 is there');
  const step = tpl.slice(at, tpl.indexOf('\n4. **', at)).replace(/\s+/g, ' ');
  const part = (head, next) => {
    const i = step.indexOf(head);
    assert.ok(i >= 0, `step 3 has ${head}`);
    return step.slice(i, next ? step.indexOf(next, i) : undefined);
  };
  const upTo = part('**A logo up to 1.25:1**', '**A logo wider than 1.25:1**');
  const wide = part('**A logo wider than 1.25:1**', '**A wide SVG**');
  const svg = part('**A wide SVG**');
  // Up to 1.25:1: the three choices as before, padding among them.
  assert.match(upTo, /a separate square image/);
  assert.match(upTo, /keeping web-chat's W/);
  assert.match(upTo, /padding the whole logo to a square \(`identity favicon <file>`; warn that text is unreadable at 16 px\)/);
  // Wider: tell, then ask for a different image or the W, BEFORE pad or crop.
  const asked = wide.search(/ask whether they can provide a different \(square\) image, or want web-chat's favicon \(the W/);
  assert.ok(asked >= 0, wide);
  assert.ok(wide.search(/first tell the user it is wider than 1\.25:1/) < asked, 'the issue is surfaced first');
  const pad = wide.indexOf('--pad'); const crop = wide.indexOf('--crop');
  assert.ok(pad > asked && crop > asked, 'pad and crop are offered only after the question');
  assert.match(wide.slice(asked), /Only if they want to use this logo/);
  assert.match(wide, /`identity favicon <file> --pad`/);
  assert.match(wide, /unreadable at 16 px/);
  assert.match(wide, /`identity favicon <file> --crop x,y,w,h`/);
  assert.match(wide, /Show it first with `--dry-run --preview --crop x,y,w,h`/);
  // A wide SVG: only the different image or the W.
  assert.match(svg, /offer only a different image or web-chat's W/);
  assert.doesNotMatch(svg, /--pad|--crop/);
  assert.match(svg, /neither padded nor cropped/);
  // U77b's wording: the favicon is the home-screen icon's source only as the mark; clear lists touch.
  assert.doesNotMatch(tpl, /square, for the tab and the home-screen\s+icon/);
  assert.match(tpl.replace(/\s+/g, ' '), /The home-screen icon is made from the \*\*mark\*\* — the favicon, else a square logo/);
  assert.match(tpl, /identity clear logo\|logo-dark\|favicon\|favicon-dark\|name\|all\|touch`/);
  // Step 6: a mock tab only for a square candidate.
  assert.match(tpl.replace(/\s+/g, ' '), /beside a mock tab when the candidate is square \(one that is not shows a note that it is not the tab's icon instead\)/);
});

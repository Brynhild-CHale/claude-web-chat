// The identity CLI's home-screen icon (lib/cli/commands/identity.js, U77b;
// spec §9.6, §9.7, §9.2, D11; ruling U77b@touch-icon-source (b): the
// home-screen icon follows the mark).
//
// What must hold:
//   * `identity favicon <png>` gives the home screen an opaque 180×180 icon made
//     from the same artwork (lib/core/icon's touch variant) — on the
//     --background tile colour, else the flat ground, else black — written
//     AFTER the favicon and its dark variant, through the daemon when one
//     answers (PUT /api/project/touch-icon, one `project` event, field touch)
//     and straight through the engine when none does;
//   * it follows the mark: a square logo that is the mark makes it, a mark that
//     moves to another stored image re-derives it, and no mark or an SVG mark
//     removes it — so no stale home-screen icon survives a change to an SVG
//     favicon or a clear; while the mark stays the same image it stands;
//   * `show` names it; `clear favicon`, `clear all` and `clear touch` remove it,
//     `clear logo` (not the mark) does not;
//   * `--dry-run --out` writes favicon-touch.png and `--preview` shows the touch
//     candidate byte for byte at 60 px;
//   * in the chrome, #wc-touch-icon follows the identity the CLI wrote.

const test = require('node:test');
const { describe, before, after } = test;
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
const { withServer, withTempHome, tmpRoot } = require('../test-support/helpers');
const { encodePng } = require('../test-support/png-encode');

const REPO = path.resolve(__dirname, '..');
const FIX = path.join(REPO, 'test', 'fixtures', 'icon');
const ICON = path.join(FIX, 'web-chat-dev-icon.png');
const REFERENCE_TOUCH = path.join(REPO, 'public', 'apple-touch-icon.png');

const STAYS_W = 'the home-screen icon stays web-chat\'s W: an SVG favicon cannot be turned into the PNG a home screen needs';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const samePixels = (a, b) => {
  const x = decodePng(a); const y = decodePng(b);
  return x.width === y.width && x.height === y.height && x.data.equals(y.data);
};

async function run(args, opts) {
  const lines = [];
  const r = await identity(args, { log: (s) => lines.push(String(s)), ...opts });
  return { r, text: lines.join('\n') };
}

// A transparent canvas painted by `paint(x, y)` → [r, g, b] | null.
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

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-identity-touch-fix-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });
const fixture = (name, bytes) => { const f = path.join(SCRATCH, name); fs.writeFileSync(f, bytes); return f; };

// A square two-colour mark, unlike ICON.
const SQUARE = fixture('square.png', sprite(24, 24, (x, y) => (inside(x, y, 3, 3, 21, 21) ? (x < 12 ? [30, 60, 220] : [230, 190, 30]) : null)));
// A 3:1 wordmark: a logo, never the mark.
const WIDE3 = fixture('wide3.png', sprite(48, 18, (x, y) => (inside(x, y, 3, 3, 45, 17) ? (x < 24 ? [30, 60, 220] : [230, 190, 30]) : null)));
// 2.25:1, a dark variant of the wrong shape for a square logo.
const WIDE2 = fixture('wide2.png', sprite(40, 20, (x, y) => (inside(x, y, 2, 2, 38, 18) ? [30, 60, 220] : null)));
const SVG = fixture('mark.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#3366ff"/></svg>\n');

const prep = (file, tile = null, kind = 'favicon') => icon.prepare(fs.readFileSync(file), { kind, mode: 'auto', tile });

function directProject(t) {
  withTempHome(t);
  const root = tmpRoot('wc-identity-touch-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const touchFile = (root) => `${projectPaths(root).projectTouchIcon}.png`;
const touchBytes = (root) => (fs.existsSync(touchFile(root)) ? fs.readFileSync(touchFile(root)) : null);

// Every client.api call the CLI makes, recorded and passed through.
function spyApi(t) {
  const calls = [];
  const orig = client.api;
  client.api = (method, p, body, opts) => {
    calls.push({ method, path: p, body, headers: (opts && opts.headers) || {} });
    return orig(method, p, body, opts);
  };
  t.after(() => { client.api = orig; });
  return calls;
}

async function projectEvents(h) {
  const { events } = (await h.api.get('/api/events?since=0')).json;
  return events.filter((e) => e.kind === 'project');
}

// Either way a write can go: straight through the engine, or the daemon.
async function eachMode(t, go) {
  await t.test('direct', async (tt) => go({ root: directProject(tt), mode: 'direct', h: null }));
  await t.test('daemon', async (tt) => withServer(tt, { writePortfile: true }, (h) => go({ root: h.root, mode: 'daemon', h })));
}

// ── identity favicon writes the touch icon ──────────────────────────────────

test('direct: favicon <the reference icon> writes the reference touch icon (the master on a black tile), 180×180 and opaque', async (t) => {
  const root = directProject(t);
  const { r, text } = await run(['favicon', ICON], { cwd: root });
  assert.equal(r.via, 'direct');
  const bytes = touchBytes(root);
  assert.ok(bytes, '.web-chat/project-touch-icon.png is written');
  assert.ok(samePixels(bytes, fs.readFileSync(REFERENCE_TOUCH)), 'pixel-equal to public/apple-touch-icon.png');
  assert.ok(bytes.equals(prep(ICON).variants.touch.bytes), 'the pipeline\'s own touch variant, byte for byte');
  const img = decodePng(bytes);
  for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255, 'every pixel opaque');
  const id = project.identity(root);
  assert.deepEqual([id.touch.type, id.touch.width, id.touch.height], ['image/png', 180, 180]);
  assert.deepEqual(r.touch, { op: 'set', from: 'favicon', via: 'direct', bytes: bytes.length });
  assert.deepEqual(r.written.map((w) => w.kind), ['favicon'], 'written lists the images the user asked for');
  assert.match(text, /✓ the home-screen icon follows the favicon, on an opaque #000000 tile: PNG 180×180 \(1:1\), \d+ bytes — written directly \(no surface running\)/);
  // The favicon's line comes first, the home-screen icon's after it.
  assert.ok(text.indexOf('✓ favicon set') < text.indexOf('✓ the home-screen icon'), text);
});

test('daemon: favicon PUTs the favicon (and its dark variant) before the touch icon; GET serves it; one project event each', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    const calls = spyApi(t);
    let { r } = await run(['favicon', ICON], { cwd: h.root });
    assert.equal(r.via, 'daemon');
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /api/project/favicon', 'PUT /api/project/touch-icon']);
    const want = prep(ICON).variants.touch.bytes;
    assert.ok(Buffer.isBuffer(calls[1].body) && calls[1].body.equals(want), 'the touch variant goes as raw bytes');
    assert.equal(calls[1].headers['Content-Type'], 'image/png');
    assert.equal(r.touch.via, 'daemon');

    const res = await h.api.raw('/project/touch-icon');
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(want), 'GET /project/touch-icon serves the bytes');
    assert.deepEqual((await projectEvents(h)).map((e) => e.field), ['favicon', 'touch'], 'one project event with field touch');

    calls.length = 0;
    ({ r } = await run(['favicon', ICON, '--dark', 'auto'], { cwd: h.root }));
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`),
      ['PUT /api/project/favicon', 'PUT /api/project/favicon-dark', 'PUT /api/project/touch-icon'], 'light, dark, then touch');
    const fields = (await projectEvents(h)).map((e) => e.field);
    assert.deepEqual(fields.slice(2), ['favicon', 'favicon_dark', 'touch']);
    assert.equal(fields.filter((f) => f === 'touch').length, 2, 'one touch event per run');
    assert.equal(project.identity(h.root).touch.width, 180);
  });
});

test('favicon --background tile:#1e66f5 gives a touch icon on that tile: the corners are #1e66f5 and opaque', async (t) => {
  const root = directProject(t);
  const { text } = await run(['favicon', ICON, '--background', 'tile:#1e66f5'], { cwd: root });
  assert.match(text, /on an opaque #1e66f5 tile/);
  const img = decodePng(touchBytes(root));
  assert.deepEqual([img.width, img.height], [180, 180]);
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]]) {
    const i = (y * img.width + x) * 4;
    assert.deepEqual([...img.data.slice(i, i + 4)], [0x1e, 0x66, 0xf5, 255], `corner ${x},${y}`);
  }
  assert.ok(touchBytes(root).equals(prep(ICON, [0x1e, 0x66, 0xf5]).variants.touch.bytes));
});

test('a refused dark variant still leaves the new light image with its home-screen icon', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    const calls = spyApi(t);
    await assert.rejects(run(['logo', ICON, '--dark', WIDE2], { cwd: h.root }), (e) => e.userFacing && /422/.test(e.message));
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`),
      ['PUT /api/project/logo', 'PUT /api/project/logo-dark', 'PUT /api/project/touch-icon']);
    assert.ok(touchBytes(h.root).equals(prep(ICON, null, 'logo').variants.touch.bytes));
  });
});

// ── no stale home-screen icon ───────────────────────────────────────────────

test('an SVG favicon says the home screen keeps web-chat\'s W, and removes the touch icon a PNG favicon left', async (t) => {
  await eachMode(t, async ({ root, mode, h }) => {
    // With none before, it says so and removes nothing.
    let { r, text } = await run(['favicon', SVG], { cwd: root });
    assert.ok(text.includes(STAYS_W), text);
    assert.equal(r.touch.op, 'none');
    assert.equal(touchBytes(root), null);

    await run(['favicon', ICON], { cwd: root });
    assert.ok(touchBytes(root));
    ({ r, text } = await run(['favicon', SVG], { cwd: root }));
    assert.equal(r.via, mode);
    assert.ok(text.includes(STAYS_W), text);
    assert.match(text, /the earlier home-screen icon was removed/);
    assert.equal(r.touch.op, 'remove');
    assert.equal(touchBytes(root), null, 'no stale home-screen icon');
    assert.equal(project.identity(root).touch, null);
    if (h) {
      const fields = (await projectEvents(h)).map((e) => `${e.op} ${e.field}`);
      assert.equal(fields.at(-1), 'remove touch');
    }
  });
});

test('the touch icon follows the mark: a square logo makes it, a favicon takes over, clearing it falls back to the logo', async (t) => {
  await eachMode(t, async ({ root }) => {
    let { r, text } = await run(['logo', SQUARE], { cwd: root });
    assert.equal(project.identity(root).mark, 'logo');
    assert.equal(r.touch.op, 'set');
    assert.equal(r.touch.from, 'logo');
    assert.match(text, /the home-screen icon follows the logo/);
    assert.ok(touchBytes(root).equals(prep(SQUARE, null, 'logo').variants.touch.bytes));

    ({ r } = await run(['favicon', ICON], { cwd: root }));
    assert.equal(r.touch.from, 'favicon');
    assert.ok(touchBytes(root).equals(prep(ICON).variants.touch.bytes));

    // A logo write while the favicon is the mark leaves the touch icon alone.
    const before = project.identity(root).touch;
    ({ r } = await run(['logo', SQUARE], { cwd: root }));
    assert.equal(r.touch.op, 'none');
    assert.deepEqual(project.identity(root).touch, before);

    // The favicon cleared: the square logo is the mark again, and the touch icon
    // is re-derived from the logo as it is stored.
    ({ r, text } = await run(['clear', 'favicon'], { cwd: root }));
    assert.equal(project.identity(root).mark, 'logo');
    assert.equal(r.touch.op, 'set');
    assert.equal(r.touch.from, 'logo');
    assert.match(text, /the home-screen icon now follows the logo/);
    const logo = project.readImage(root, 'logo').bytes;
    assert.ok(touchBytes(root).equals(icon.prepare(logo, { kind: 'logo', mode: 'auto', tile: null }).variants.touch.bytes));

    // A wordmark logo is no mark: the touch icon goes.
    ({ r } = await run(['logo', WIDE3], { cwd: root }));
    assert.equal(project.identity(root).mark, null);
    assert.equal(r.touch.op, 'remove');
    assert.equal(touchBytes(root), null);
  });
});

test('a touch icon re-derived from a stored image keeps that image\'s tile colour', async (t) => {
  const root = directProject(t);
  await run(['logo', SQUARE, '--background', 'tile:#1e66f5'], { cwd: root });
  await run(['favicon', ICON], { cwd: root });
  const { r } = await run(['clear', 'favicon'], { cwd: root });
  assert.equal(r.touch.op, 'set');
  assert.equal(r.touch.from, 'logo');
  const img = decodePng(touchBytes(root));
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]]) {
    const i = (y * img.width + x) * 4;
    assert.deepEqual([...img.data.slice(i, i + 4)], [0x1e, 0x66, 0xf5, 255], `corner ${x},${y}: the stored logo's tile, not black`);
  }
});

// ── a padded or cropped mark (ruling U50@skill:wide-logo-pad, D1 d: U49b) ───

// The box of the pixels that are not the tile colour, in an opaque image.
function inkBox(img, tile) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(img.data[i + c] - tile[c]))) <= 8) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

test('a favicon written with --pad gets a touch icon derived with the pad: 180×180, opaque, the whole logo centred', async (t) => {
  await eachMode(t, async ({ root }) => {
    const { r, text } = await run(['favicon', WIDE3, '--pad'], { cwd: root });
    assert.equal(project.identity(root).mark, 'favicon');
    assert.equal(r.touch.op, 'set');
    assert.equal(r.touch.from, 'favicon');
    assert.equal(r.touch.pad, true);
    assert.match(text, /✓ the home-screen icon follows the padded favicon, on an opaque #000000 tile: PNG 180×180/);
    const bytes = touchBytes(root);
    const want = icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: null, pad: true });
    assert.ok(bytes.equals(want.variants.touch.bytes), 'the padded prepare\'s own touch variant, byte for byte');
    const img = decodePng(bytes);
    assert.deepEqual([img.width, img.height], [180, 180]);
    for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255, 'every pixel opaque');
    const box = inkBox(img, [0, 0, 0]);
    assert.ok(box.w / box.h > 2.5, `the whole 3:1 logo, not a crop of it: ${box.w}×${box.h}`);
    assert.ok(Math.abs(box.x0 - (179 - box.x1)) <= 1, `centred across: ${box.x0} | ${179 - box.x1}`);
    assert.ok(Math.abs(box.y0 - (179 - box.y1)) <= 1, `centred down: ${box.y0} | ${179 - box.y1}`);
  });
});

test('a favicon written with --crop gets a touch icon derived with the crop', async (t) => {
  const root = directProject(t);
  const crop = { x: 0, y: 0, w: 18, h: 18 };
  const { r, text } = await run(['favicon', WIDE3, '--crop', '0,0,18,18', '--background', 'tile:#ffffff'], { cwd: root });
  assert.deepEqual(r.touch.crop, crop);
  assert.match(text, /✓ the home-screen icon follows the cropped favicon, on an opaque #ffffff tile/);
  const want = icon.prepare(fs.readFileSync(WIDE3), { kind: 'favicon', mode: 'auto', tile: [255, 255, 255], crop });
  assert.ok(touchBytes(root).equals(want.variants.touch.bytes));
  const box = inkBox(decodePng(touchBytes(root)), [255, 255, 255]);
  assert.ok(box.w / box.h < 1.25, `the cropped square mark: ${box.w}×${box.h}`);
});

// ── show and clear ──────────────────────────────────────────────────────────

test('show lists the home-screen icon both ways', async (t) => {
  const root = directProject(t);
  let { text } = await run(['show'], { cwd: root });
  assert.match(text, /^ {2}home screen {3}web-chat's default$/m);
  await run(['favicon', ICON], { cwd: root });
  ({ text } = await run(['show'], { cwd: root }));
  assert.match(text, /^ {2}home screen {3}180×180 PNG \(from the favicon\)$/m);
  // It reports the touch icon itself, not the mark: cleared alone, the default
  // shows beside a favicon that is still set.
  await run(['clear', 'touch'], { cwd: root });
  ({ text } = await run(['show'], { cwd: root }));
  assert.match(text, /^ {2}home screen {3}web-chat's default$/m);
  // A square logo that is the mark (no favicon) makes it too, and show says so.
  await run(['clear', 'favicon'], { cwd: root });
  await run(['logo', SQUARE], { cwd: root });
  ({ text } = await run(['show'], { cwd: root }));
  assert.match(text, /^ {2}home screen {3}180×180 PNG \(from the logo\)$/m);
});

test('clear favicon, clear all and clear touch remove the touch icon; clear logo does not', async (t) => {
  await eachMode(t, async ({ root, mode }) => {
    const opts = { cwd: root };
    await run(['logo', SQUARE], opts);
    await run(['favicon', ICON], opts);
    const touch = project.identity(root).touch;
    let { r, text } = await run(['clear', 'logo'], opts);
    assert.deepEqual(project.identity(root).touch, touch, 'clear logo: the favicon is still the mark');
    assert.equal(r.touch.op, 'none');
    assert.ok(!/home-screen/.test(text), text);

    ({ r, text } = await run(['clear', 'favicon'], opts));
    assert.equal(r.via, mode);
    assert.deepEqual(r.cleared, ['favicon', 'touch']);
    assert.match(text, /✓ cleared the favicon, the home-screen icon — /);
    assert.equal(touchBytes(root), null);

    await run(['favicon', ICON], opts);
    ({ r, text } = await run(['clear', 'touch'], opts));
    assert.deepEqual(r.cleared, ['touch']);
    assert.match(text, /✓ cleared the home-screen icon — /);
    assert.equal(touchBytes(root), null);
    assert.ok(project.identity(root).favicon, 'clear touch removes it alone');
    ({ text } = await run(['clear', 'touch'], opts));
    assert.match(text, /nothing to clear: the home-screen icon was not set/);

    await run(['favicon', ICON], opts);
    ({ r } = await run(['clear', 'all'], opts));
    assert.ok(r.cleared.includes('touch'));
    assert.equal(touchBytes(root), null);
    assert.equal(project.identity(root).touch, null);
  });
});

// ── --dry-run and --preview ─────────────────────────────────────────────────

test('--dry-run --out writes favicon-touch.png beside the favicon\'s candidates, and nothing under .web-chat/', async (t) => {
  const root = directProject(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-identity-touch-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const { r } = await run(['favicon', ICON, '--dry-run', '--out', out], { cwd: root });
  assert.deepEqual(fs.readdirSync(out).sort(), ['favicon-tile.png', 'favicon-touch.png', 'favicon.png']);
  assert.ok(fs.readFileSync(path.join(out, 'favicon-touch.png')).equals(prep(ICON).variants.touch.bytes));
  assert.equal(r.candidates.filter((c) => c.touch).length, 1);
  assert.equal(touchBytes(root), null, 'a dry run applies nothing');
  // An SVG favicon has no touch candidate, and says why.
  const svgOut = path.join(out, 'svg');
  const { text } = await run(['favicon', SVG, '--dry-run', '--out', svgOut], { cwd: root });
  assert.deepEqual(fs.readdirSync(svgOut), ['favicon.svg']);
  assert.ok(text.includes(STAYS_W), text);
});

test('--preview\'s pane carries the touch candidate byte for byte, at 60 px', async (t) => {
  await withServer(t, { writePortfile: true }, async (h) => {
    const { r, text } = await run(['favicon', ICON, '--dry-run', '--preview'], { cwd: h.root });
    assert.match(text, /and the home-screen icon at 60 px on its tile/);
    const hello = await h.wsHello();
    const pane = hello.mounts.find((m) => m.id === identity.PREVIEW_ID);
    assert.ok(pane);
    const touch = r.candidates.find((c) => c.touch);
    assert.ok(touch.bytes.equals(prep(ICON).variants.touch.bytes));
    const b64 = touch.bytes.toString('base64');
    const imgs = [...pane.html.matchAll(/<img class="idp-home" src="data:image\/png;base64,([A-Za-z0-9+/=]+)" width="60" height="60"/g)];
    assert.equal(imgs.length, 2, 'on a light and a dark ground');
    for (const m of imgs) assert.equal(sha(Buffer.from(m[1], 'base64')), sha(touch.bytes));
    // It is no pick of its own: the "Use this" buttons are the other candidates',
    // and the script's one status line is still the first .idp-status.
    assert.equal((pane.html.match(/class="idp-status"/g) || []).length, 1);
    assert.equal((pane.html.match(/data-pick=/g) || []).length, r.candidates.length - 1);
    assert.equal(project.identity(h.root).touch, null, 'a preview applies nothing');
  });
});

// ── the chrome ──────────────────────────────────────────────────────────────
// Last in the file: bootShell replaces the globals (fetch among them) until
// its restore().

describe('#wc-touch-icon follows the identity the CLI wrote', () => {
  let shell;
  let root;

  before(async () => {
    const { bootShell, helloFrame } = require('../test-support/chrome-shell');
    root = tmpRoot('wc-identity-touch-chrome-');
    shell = await bootShell({
      init: async (s) => {
        const fav = await s.importApp('favicon.js');
        fav.initFavicon({ createCanvas: () => null, loadImage: async (src) => ({ src }) });
      },
    });
    await shell.frame(helloFrame());
    await shell.tick();
  });
  after(async () => {
    if (shell) await shell.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('set: a project frame points it at /project/touch-icon?v=…; clear: back to /apple-touch-icon.png', async () => {
    const link = () => shell.$('wc-touch-icon').getAttribute('href');
    assert.equal(link(), '/apple-touch-icon.png');
    await run(['favicon', ICON], { cwd: root });
    const { version } = project.identity(root).touch;
    await shell.frame(project.frame(root));
    assert.equal(link(), `/project/touch-icon?v=${encodeURIComponent(version)}`);
    await run(['clear', 'favicon'], { cwd: root });
    await shell.frame(project.frame(root));
    assert.equal(link(), '/apple-touch-icon.png');
  });
});

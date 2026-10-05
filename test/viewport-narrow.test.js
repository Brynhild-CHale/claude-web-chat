// The narrow posture and the browser's colour scheme (public/app/viewport.js):
// design spec §7.1 (one breakpoint, width only, CSS owns visibility; script
// learns the width from viewport.js alone), §7.2 (the chrome-bus events) and
// §9.7 (prefersDark() and 'scheme', for the favicon).
//
//   * isNarrow() and 'viewport:narrow' {narrow, phone} on every narrow flip;
//     'viewport' {phone, narrow} stays a phone-flip event, so its listeners
//     (mounts.js's layout lock, the graph's log, ws.js's client frame) never
//     see a width change that left the phone answer alone.
//   * prefersDark() and 'scheme' {dark} on a flip of the browser's scheme. It
//     marks nothing on <html>: web-chat's own light/dark is data-theme (§9.4).
//   * An unchanged answer never emits; with no matchMedia every answer is no.
//
// Through the real shell (test-support/chrome-shell.js), whose matchMedia
// evaluates the queries viewport.js asks against the viewport setViewport()
// sets. The no-window and odd-host cases run viewport.js in a plain node
// subprocess, so they get a fresh module with no shell around it.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { bootShell } = require('../test-support/chrome-shell');

const REPO = path.resolve(__dirname, '..');
const VIEWPORT_URL = pathToFileURL(path.join(REPO, 'public/app/viewport.js')).href;
const BUS_URL = pathToFileURL(path.join(REPO, 'public/app/bus.js')).href;
const DESKTOP = { width: 1280, height: 800, dark: false };

let shell, vp, bus;
before(async () => {
  shell = await bootShell();
  vp = await shell.importApp('viewport.js');
  ({ bus } = await shell.importApp('bus.js'));
});
after(() => shell && shell.restore());

// Every viewport event the bus carries while `fn` runs, in order.
function heard(fn) {
  const got = [];
  const offs = ['viewport', 'viewport:narrow', 'scheme'].map((type) => bus.on(type, (d) => got.push([type, d])));
  try { fn(); } finally { for (const off of offs) off(); }
  return got;
}
const htmlClasses = () => [...shell.document.documentElement.classList].sort();

test('the default 1280x800 desktop is wide, not a phone, and light', () => {
  assert.equal(vp.isNarrow(), false);
  assert.equal(vp.isPhone(), false);
  assert.equal(vp.prefersDark(), false);
  assert.equal(vp.deviceKind(), 'desktop');
  assert.equal(shell.document.documentElement.classList.contains('phone'), false);
});

test('the queries: narrow is the one breakpoint, width only; the scheme is the browser\'s', () => {
  assert.equal(vp.NARROW_QUERY, `(max-width: ${vp.PHONE_MAX_WIDTH}px)`);
  assert.equal(vp.NARROW_QUERY, '(max-width: 759px)', 'app.css\'s narrow block');
  assert.equal(vp.SCHEME_QUERY, '(prefers-color-scheme: dark)');
  assert.ok(vp.PHONE_QUERY.startsWith(vp.NARROW_QUERY), 'a phone is narrow AND portrait-tall');
});

test('crossing 760px announces the narrow flip once, and no phone event', (t) => {
  t.after(() => shell.setViewport(DESKTOP));
  const before0 = htmlClasses();
  assert.deepEqual(heard(() => shell.setViewport({ width: 759 })),
    [['viewport:narrow', { narrow: true, phone: false }]], '759px x 800 is narrow but not phone-shaped');
  assert.equal(vp.isNarrow(), true);
  assert.equal(vp.isPhone(), false);
  assert.deepEqual(htmlClasses(), before0, 'width is CSS\'s: no class for narrow');

  assert.deepEqual(heard(() => shell.setViewport({ width: 700 })), [], 'still narrow: nothing to say');
  assert.deepEqual(heard(() => shell.setViewport({ width: 760 })),
    [['viewport:narrow', { narrow: false, phone: false }]]);
  assert.equal(vp.isNarrow(), false);
  assert.deepEqual(heard(() => shell.setViewport({ width: 1100 })), [], 'still wide: nothing to say');
});

test('a phone is narrow too: one viewport:narrow and one viewport {phone, narrow}', (t) => {
  t.after(() => shell.setViewport(DESKTOP));
  const got = heard(() => shell.setViewport({ width: 390, height: 844 }));
  assert.deepEqual(got.map(([type]) => type).sort(), ['viewport', 'viewport:narrow']);
  assert.equal(got.find(([type]) => type === 'viewport:narrow')[1].narrow, true);
  assert.deepEqual(got.find(([type]) => type === 'viewport')[1], { phone: true, narrow: true });
  assert.equal(vp.isPhone(), true);
  assert.equal(vp.isNarrow(), true);
  assert.ok(shell.document.documentElement.classList.contains('phone'), 'the phone class, as before');

  assert.deepEqual(heard(() => shell.setViewport({ width: 400, height: 860 })), [],
    'a resize that keeps both answers emits nothing');

  assert.deepEqual(heard(() => shell.setViewport(DESKTOP)), [
    ['viewport:narrow', { narrow: false, phone: false }],
    ['viewport', { phone: false, narrow: false }],
  ], 'leaving: both, each saying the new answers');
  assert.equal(shell.document.documentElement.classList.contains('phone'), false);
});

test('inside the breakpoint, only the phone answer flips: viewport alone', (t) => {
  t.after(() => shell.setViewport(DESKTOP));
  shell.setViewport({ width: 700, height: 800 });     // narrow, not phone-shaped (a terminal's neighbour)
  assert.deepEqual([vp.isNarrow(), vp.isPhone()], [true, false]);
  assert.deepEqual(heard(() => shell.setViewport({ width: 390, height: 844 })),
    [['viewport', { phone: true, narrow: true }]], 'no viewport:narrow: narrow did not change');
  assert.deepEqual(heard(() => shell.setViewport({ width: 700, height: 800 })),
    [['viewport', { phone: false, narrow: true }]]);
});

test('the browser\'s scheme: one scheme event per flip, and nothing on <html>', (t) => {
  t.after(() => shell.setViewport(DESKTOP));
  const root = shell.document.documentElement;
  const before0 = { classes: htmlClasses(), theme: root.getAttribute('data-theme') };
  assert.deepEqual(heard(() => shell.setViewport({ dark: true })), [['scheme', { dark: true }]]);
  assert.equal(vp.prefersDark(), true);
  assert.deepEqual({ classes: htmlClasses(), theme: root.getAttribute('data-theme') }, before0,
    'web-chat\'s own light/dark is data-theme, the topbar\'s choice, never the browser\'s');
  assert.deepEqual(heard(() => shell.setViewport({ dark: true })), [], 'repeating it emits nothing');
  assert.deepEqual(heard(() => shell.setViewport({ width: 759 })).map(([type]) => type), ['viewport:narrow'],
    'a width flip says nothing about the scheme');
  assert.deepEqual(heard(() => shell.setViewport({ dark: false })), [['scheme', { dark: false }]]);
  assert.equal(vp.prefersDark(), false);
});

// ── outside the shell: a fresh module in plain node ──────────────────────────

function runPlain(setup) {
  const code = `
    ${setup}
    const vp = await import(${JSON.stringify(VIEWPORT_URL)});
    const { bus } = await import(${JSON.stringify(BUS_URL)});
    const events = [];
    for (const type of ['viewport', 'viewport:narrow', 'scheme']) bus.on(type, (d) => events.push([type, d]));
    const answers = () => ({ narrow: vp.isNarrow(), phone: vp.isPhone(), dark: vp.prefersDark(), device: vp.deviceKind() });
    const out = { imported: answers() };
    vp.initViewport();
    out.init = answers();
    out.initEvents = events.splice(0);
    if (typeof globalThis.flip === 'function') { globalThis.flip(); out.flipped = answers(); out.flipEvents = events.splice(0); }
    process.stdout.write(JSON.stringify(out));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
const ALL_NO = { narrow: false, phone: false, dark: false, device: 'desktop' };

test('in plain node with no window, every answer is no, and initViewport says nothing', () => {
  const out = runPlain('');
  assert.deepEqual(out.imported, ALL_NO);
  assert.deepEqual(out.init, ALL_NO, 'initViewport survives a missing window and document');
  assert.deepEqual(out.initEvents, []);
});

test('a window with no matchMedia (a very old engine) is a light desktop', () => {
  const out = runPlain('globalThis.window = {};');
  assert.deepEqual(out.init, ALL_NO);
  assert.deepEqual(out.initEvents, []);
});

test('an old engine\'s addListener spelling delivers the change; a feature the host cannot read answers no', () => {
  // A phone-sized host that only has the pre-2020 addListener, and whose
  // prefers-color-scheme list throws on read (as a hand-rolled test stub may).
  const out = runPlain(`
    let w = 1280, h = 800;
    const listeners = [];
    const evalQ = (q) => {
      if (q.includes('prefers-color-scheme')) throw new Error('unknown feature');
      const max = /max-width: (\\d+)px/.exec(q); const asp = /max-aspect-ratio: (\\d+)\\/(\\d+)/.exec(q);
      return (!max || w <= +max[1]) && (!asp || w / h <= asp[1] / asp[2]);
    };
    globalThis.window = { matchMedia: (q) => ({ media: q, get matches() { return evalQ(q); }, addListener: (fn) => listeners.push(fn) }) };
    globalThis.flip = () => { w = 390; h = 844; for (const fn of listeners) fn(); };
  `);
  assert.deepEqual(out.init, ALL_NO);
  assert.deepEqual(out.initEvents, []);
  assert.deepEqual(out.flipped, { narrow: true, phone: true, dark: false, device: 'mobile' });
  assert.deepEqual(out.flipEvents, [
    ['viewport:narrow', { narrow: true, phone: true }],
    ['viewport', { phone: true, narrow: true }],
  ], 'three lists heard the change; the answers were announced once');
});

test('a host that answers at boot announces it once, from the default', () => {
  // A dark phone at boot: each answer flips from its default (desktop, light)
  // exactly once, as the phone answer always has.
  const out = runPlain(`
    globalThis.window = { matchMedia: (q) => ({ media: q, matches: true, addEventListener() {} }) };
  `);
  assert.deepEqual(out.init, { narrow: true, phone: true, dark: true, device: 'mobile' });
  assert.deepEqual(out.initEvents, [
    ['viewport:narrow', { narrow: true, phone: true }],
    ['viewport', { phone: true, narrow: true }],
    ['scheme', { dark: true }],
  ]);
});

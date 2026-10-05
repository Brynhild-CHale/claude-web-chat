// The browser tab's favicon and its attention badge: public/app/favicon.js
// (design spec §9.7; rulings D11, N1 and U77a@badge-and-touch).
//
//   * Plain node, first: the pure decisions — iconFor (web-chat's W by the
//     browser's scheme, else the project's mark in cobrand.js's URL form, the
//     cache key the version of the file the mode serves), touchFor, badgeFor
//     (rust for waiting, gold for a question, nothing while the socket is not
//     live) and composeBadge on a fake canvas (the image, a 'destination-out'
//     ring, then the dot in its fixed ink; null and no throw without a 2d
//     context).
//   * Then the real chrome through test-support/chrome-shell.js: the three
//     <head> links, both icon links following the browser's scheme (never
//     web-chat's own mode), a project frame's mark and touch icon, and a
//     mirror:status frame's aggregate badging whichever image shows — with a
//     fake canvas installed, and the plain href when there is no 2d context —
//     and document.title never written by any of it.
//
// main.js does not call initFavicon yet (U40 wires it after initProject and
// initChatState), so the boot's init does, as main.js will, injecting the
// canvas and the image loader jsdom lacks.
const test = require('node:test');
const { describe, before, after, beforeEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const codeOf = (rel) => stripComments(read(rel)).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const appUrl = (rel) => pathToFileURL(path.join(REPO, 'public/app', rel)).href;

const RUST = '#cc592e';
const GOLD = '#c79a12';
const DATA = 'data:image/png;base64,RkFLRQ==';

// A canvas whose 2d context records what is drawn, in order. `context: false`
// answers getContext with null (jsdom, a locked-down browser); `throws` makes
// the named context call throw.
function fakeCanvas({ context = true, throws = null } = {}) {
  const log = [];
  let gco = 'source-over';
  let fill = '#000000';
  const call = (name) => (...args) => {
    if (throws === name) throw new Error(`${name} failed`);
    log.push([name, ...args]);
  };
  const ctx = {
    get globalCompositeOperation() { return gco; },
    set globalCompositeOperation(v) { gco = v; log.push(['composite', v]); },
    get fillStyle() { return fill; },
    set fillStyle(v) { fill = v; },
    clearRect: call('clearRect'),
    drawImage: call('drawImage'),
    beginPath: call('beginPath'),
    arc: call('arc'),
    fill: (...a) => { if (throws === 'fill') throw new Error('fill failed'); log.push(['fill', gco, fill, ...a]); },
  };
  const canvas = {
    width: 32,
    height: 32,
    log,
    contexts: 0,
    getContext(kind) {
      canvas.contexts += 1;
      if (throws === 'getContext') throw new Error('no context');
      return context && kind === '2d' ? ctx : null;
    },
    toDataURL(type) { return type === 'image/png' ? DATA : 'data:,'; },
  };
  return canvas;
}

// ── plain node ───────────────────────────────────────────────────────────────

let F;   // public/app/favicon.js
before(async () => { F = await import(appUrl('favicon.js')); });

const meta = (version, w = 16, h = 16) => ({ type: 'image/png', bytes: 100, version, width: w, height: h });
const NONE = { name: 'acme', mark: null, mark_dark: false, favicon: null, favicon_dark: null, logo: null, logo_dark: null, touch: null };

test('iconFor: web-chat\'s W by the browser\'s scheme while the project has no mark', () => {
  assert.equal(F.iconFor(NONE, false), '/favicon.png');
  assert.equal(F.iconFor(NONE, true), '/favicon-dark.png');
  for (const junk of [null, undefined, 'x', 42, []]) {
    assert.equal(F.iconFor(junk, false), '/favicon.png', JSON.stringify(junk));
    assert.equal(F.iconFor(junk, true), '/favicon-dark.png', JSON.stringify(junk));
  }
  // A logo that is not the mark (a wordmark) leaves the W.
  assert.equal(F.iconFor({ ...NONE, logo: meta('L1', 40, 10) }, false), '/favicon.png');
  // A mark whose image has no version cannot be cache-keyed: the W.
  assert.equal(F.iconFor({ ...NONE, mark: 'favicon', favicon: { type: 'image/png' } }, false), '/favicon.png');
});

test('iconFor: the project\'s mark, cache-keyed by the version of the file the mode serves (cobrand.js\'s form)', () => {
  const withDark = { ...NONE, mark: 'favicon', mark_dark: true, favicon: meta('F1'), favicon_dark: meta('F2') };
  assert.equal(F.iconFor(withDark, false), '/project/mark?v=F1');
  assert.equal(F.iconFor(withDark, true), '/project/mark?mode=dark&v=F2', 'the dark variant\'s version');

  const lightOnly = { ...NONE, mark: 'favicon', mark_dark: false, favicon: meta('F1') };
  assert.equal(F.iconFor(lightOnly, false), '/project/mark?v=F1');
  assert.equal(F.iconFor(lightOnly, true), '/project/mark?mode=dark&v=F1',
    'no dark variant: the route falls back to the light image, so its version is the key');

  const logoMark = { ...NONE, mark: 'logo', mark_dark: true, logo: meta('L1'), logo_dark: meta('L2') };
  assert.equal(F.iconFor(logoMark, false), '/project/mark?v=L1');
  assert.equal(F.iconFor(logoMark, true), '/project/mark?mode=dark&v=L2');

  // The version is a query value, encoded.
  assert.equal(F.iconFor({ ...NONE, mark: 'favicon', favicon: meta('1 2&3') }, false), '/project/mark?v=1%202%263');
});

test('touchFor: the project\'s home-screen icon while one is set, else web-chat\'s', () => {
  assert.equal(F.touchFor(NONE), '/apple-touch-icon.png');
  assert.equal(F.touchFor(null), '/apple-touch-icon.png');
  assert.equal(F.touchFor({ ...NONE, touch: meta('T1', 180, 180) }), '/project/touch-icon?v=T1');
});

test('badgeFor: rust while Claude needs the user, gold for a question, nothing otherwise or off the live socket', () => {
  const at = (state, conn = 'live') => F.badgeFor({ conn, aggregate: { state } });
  assert.equal(at('waiting'), 'rust');
  assert.equal(at('question'), 'gold');
  for (const s of ['working', 'compacting', 'idle', 'suspended', 'none', 'unknown', 'ended', undefined]) {
    assert.equal(at(s), null, String(s));
  }
  for (const conn of ['connecting', 'reconnecting', undefined, null]) {
    for (const state of ['waiting', 'question']) {
      assert.equal(F.badgeFor({ conn, aggregate: { state } }), null, `${state} on a ${conn} socket`);
    }
  }
  for (const junk of [null, undefined, {}, { conn: 'live' }, { conn: 'live', aggregate: null }]) {
    assert.equal(F.badgeFor(junk), null, JSON.stringify(junk));
  }
});

test('composeBadge: the image, a destination-out ring, then the dot in its ink; the data URL', () => {
  const image = { id: 'the-image' };
  for (const [colour, ink] of [['rust', RUST], ['gold', GOLD], [RUST, RUST]]) {
    const c = fakeCanvas();
    assert.equal(F.composeBadge(c, image, colour), DATA, colour);
    const steps = c.log.map((e) => e[0]);
    assert.deepStrictEqual(steps,
      ['clearRect', 'drawImage', 'composite', 'beginPath', 'arc', 'fill', 'composite', 'beginPath', 'arc', 'fill'], colour);
    assert.deepStrictEqual(c.log[1], ['drawImage', image, 0, 0, 32, 32], 'the whole image, at the canvas size');
    assert.deepStrictEqual(c.log[2], ['composite', 'destination-out']);
    assert.equal(c.log[5][1], 'destination-out', 'the ring is cut out');
    assert.deepStrictEqual(c.log[6], ['composite', 'source-over']);
    assert.deepStrictEqual(c.log[9].slice(0, 3), ['fill', 'source-over', ink], 'the dot in its fixed ink');
    const [, rx, ry, rr] = c.log[4];
    const [, dx, dy, dr] = c.log[8];
    assert.deepStrictEqual([rx, ry], [dx, dy], 'the ring is round the dot');
    assert.ok(rr > dr, 'the ring is wider than the dot');
    assert.ok(dx + dr <= 32 && dy - dr >= 0, 'the dot is on the icon');
  }
  // A 2x display's 64px canvas: the same drawing, scaled.
  const big = fakeCanvas();
  big.width = 64;
  big.height = 64;
  assert.equal(F.composeBadge(big, image, 'rust'), DATA);
  assert.deepStrictEqual(big.log[1], ['drawImage', image, 0, 0, 64, 64]);
});

test('composeBadge: no 2d context, or one that throws, is null — never a throw', () => {
  assert.equal(F.composeBadge(fakeCanvas({ context: false }), {}, 'rust'), null);
  for (const where of ['getContext', 'drawImage', 'fill']) {
    assert.equal(F.composeBadge(fakeCanvas({ throws: where }), {}, 'rust'), null, where);
  }
  assert.equal(F.composeBadge(null, {}, 'rust'), null);
  assert.equal(F.composeBadge({}, {}, 'rust'), null);
  const tainted = fakeCanvas();
  tainted.toDataURL = () => { throw new Error('SecurityError: tainted'); };
  assert.equal(F.composeBadge(tainted, {}, 'gold'), null);
});

test('favicon.js never touches document.title, asks no media query itself, and keeps its inks fixed', () => {
  const code = codeOf('public/app/favicon.js');
  assert.doesNotMatch(code, /document\s*\.\s*title|\btitle\s*=/, 'project.js is the title\'s one writer');
  assert.doesNotMatch(code, /matchMedia|data-theme|dataset\.theme/,
    'the browser\'s scheme comes from viewport.js, never web-chat\'s own mode');
  assert.match(code, /#cc592e/);
  assert.match(code, /#c79a12/);
});

test('index.html ships the three icon links in its <head>, each scheme\'s on its own media query', () => {
  const head = read('public/index.html').split('</head>')[0];
  assert.match(head, /<link rel="icon" id="wc-favicon" href="\/favicon\.png" media="\(prefers-color-scheme: light\)">/);
  assert.match(head, /<link rel="icon" id="wc-favicon-dark" href="\/favicon-dark\.png" media="\(prefers-color-scheme: dark\)">/);
  assert.match(head, /<link rel="apple-touch-icon" id="wc-touch-icon" href="\/apple-touch-icon\.png">/);
});

// ── the chrome ───────────────────────────────────────────────────────────────

describe('the tab icon in the chrome', () => {
  let shell, $, doc, project, S;
  let makeCanvas = () => fakeCanvas();
  const loads = [];
  let loadImage = async (src) => ({ src });
  let rev = 1000;
  const T = Date.now();
  const titleWrites = [];

  const snapshot = (state = 'idle') => ({
    v: 1, enabled: true, now: T, rev: ++rev, content: true, access: { level: 'local', remote: false },
    capabilities: {}, primary: 'c1', aggregate: { state }, tasks: [], asks: [],
    conversations: [{ id: 'c1', rev: 1, title: 'c1', headless: false,
      counts: { shells: 0, agents: 0, workflows: 0, monitors: 0 },
      live: { state, since: T - 60000, last_activity_at: T - 1000 } }],
  });
  const status = (state) => shell.frame({ type: 'mirror:status', rev: ++rev, now: T, aggregate: { state },
    conversations: [{ id: 'c1', state, since: T - 1000 }] });

  const icons = () => [$('wc-favicon').getAttribute('href'), $('wc-favicon-dark').getAttribute('href')];
  const both = (href) => [href, href];
  const BASE = { name: 'test', default_name: 'test', custom: false, show_name: true,
    logo: null, logo_dark: null, favicon: null, favicon_dark: null, touch: null, mark: null, mark_dark: false };
  const projectFrame = (over = {}) => shell.frame({ type: 'project', identity: { ...BASE, ...over } });

  before(async () => {
    shell = await bootShell({
      routes: { '/api/mirror': () => snapshot() },
      init: async (s) => {
        const fav = await s.importApp('favicon.js');
        fav.initFavicon({
          createCanvas: () => makeCanvas(),
          loadImage: (src) => { loads.push(src); return loadImage(src); },
        });
      },
    });
    ({ $ } = shell);
    doc = shell.document;
    project = await shell.importApp('project.js');
    S = await shell.importApp('chat-state.js');
    await shell.frame(helloFrame());
    await shell.tick();
    assert.equal(S.mirror.availability, 'ok', 'the mirror snapshot landed');
    assert.equal(S.mirror.conn, 'live');
    // Every write of document.title from here on.
    const desc = Object.getOwnPropertyDescriptor(shell.window.Document.prototype, 'title');
    Object.defineProperty(doc, 'title', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { titleWrites.push(v); desc.set.call(this, v); },
    });
  });
  after(() => shell.restore());

  // Light browser, web-chat's identity with no images, the store idle, a
  // working fake canvas — put back before each test, so a failure in one
  // cannot leak into the next.
  beforeEach(async () => {
    shell.setViewport({ dark: false });
    makeCanvas = () => fakeCanvas();
    loadImage = async (src) => ({ src });
    project.applyProject(BASE);
    await status('idle');
    loads.length = 0;
    titleWrites.length = 0;
  });

  test('the head\'s links, as the chrome loaded them', () => {
    const fav = $('wc-favicon');
    const dark = $('wc-favicon-dark');
    const touch = $('wc-touch-icon');
    assert.equal(fav.parentElement, doc.head);
    assert.equal(fav.getAttribute('rel'), 'icon');
    assert.equal(fav.getAttribute('media'), '(prefers-color-scheme: light)');
    assert.equal(dark.parentElement, doc.head);
    assert.equal(dark.getAttribute('rel'), 'icon');
    assert.equal(dark.getAttribute('media'), '(prefers-color-scheme: dark)');
    assert.equal(touch.parentElement, doc.head);
    assert.equal(touch.getAttribute('rel'), 'apple-touch-icon');
    assert.equal(touch.getAttribute('href'), '/apple-touch-icon.png');
  });

  test('both icon links follow the browser\'s scheme, whatever web-chat\'s own mode', async () => {
    assert.deepStrictEqual(icons(), both('/favicon.png'), 'a light browser: the blue W on both links');
    shell.setViewport({ dark: true });
    assert.deepStrictEqual(icons(), both('/favicon-dark.png'), 'a dark browser: the gold W on both links');
    // web-chat's own ◑ mode is <html data-theme>: it moves the topbar, not the tab.
    const html = doc.documentElement;
    const mode = html.getAttribute('data-theme');
    html.removeAttribute('data-theme');
    await shell.tick();
    assert.deepStrictEqual(icons(), both('/favicon-dark.png'));
    shell.setViewport({ dark: false });
    html.setAttribute('data-theme', 'dark');
    await shell.tick();
    assert.deepStrictEqual(icons(), both('/favicon.png'));
    if (mode === null) html.removeAttribute('data-theme'); else html.setAttribute('data-theme', mode);
    assert.deepStrictEqual(titleWrites, []);
  });

  test('a project frame\'s mark replaces the W in both schemes; removing it brings the W back', async () => {
    await projectFrame({ favicon: meta('F1'), favicon_dark: meta('F2'), mark: 'favicon', mark_dark: true });
    assert.deepStrictEqual(icons(), both('/project/mark?v=F1'));
    shell.setViewport({ dark: true });
    assert.deepStrictEqual(icons(), both('/project/mark?mode=dark&v=F2'));
    // The dark variant gone: dark asks the route for its fallback, keyed by the light image.
    await projectFrame({ favicon: meta('F1'), mark: 'favicon', mark_dark: false });
    assert.deepStrictEqual(icons(), both('/project/mark?mode=dark&v=F1'));
    await projectFrame();
    assert.deepStrictEqual(icons(), both('/favicon-dark.png'));
    shell.setViewport({ dark: false });
    assert.deepStrictEqual(icons(), both('/favicon.png'));
    assert.equal(doc.title, 'test', 'the title is the project\'s name (project.js)');
  });

  test('the identity\'s touch icon moves #wc-touch-icon; without one it is web-chat\'s', async () => {
    await projectFrame({ touch: meta('T1', 180, 180) });
    assert.equal($('wc-touch-icon').getAttribute('href'), '/project/touch-icon?v=T1');
    shell.setViewport({ dark: true });
    assert.equal($('wc-touch-icon').getAttribute('href'), '/project/touch-icon?v=T1', 'no dark variant');
    await projectFrame();
    assert.equal($('wc-touch-icon').getAttribute('href'), '/apple-touch-icon.png');
  });

  test('a waiting aggregate badges the showing image in rust, a question in gold; the wait ending restores it', async () => {
    const made = [];
    makeCanvas = () => { const c = fakeCanvas(); made.push(c); return c; };
    await status('waiting');
    await waitUntil(() => icons()[0].startsWith('data:'), { timeout: 2000 });
    assert.deepStrictEqual(icons(), both(DATA), 'both links wear the badged image');
    assert.deepStrictEqual(loads, ['/favicon.png'], 'drawn from the image that was showing, same-origin');
    const c = made.at(-1);
    assert.equal(c.width, 32);
    assert.equal(c.height, 32);
    assert.ok(c.log.some((e) => e[0] === 'fill' && e[1] === 'destination-out'), 'the ring');
    assert.deepStrictEqual(c.log.at(-1).slice(0, 3), ['fill', 'source-over', RUST]);

    // Another frame in the same state redraws nothing.
    await status('waiting');
    assert.equal(loads.length, 1);

    await status('question');
    await waitUntil(() => made.length === 2, { timeout: 2000 });
    await shell.tick();
    assert.deepStrictEqual(made[1].log.at(-1).slice(0, 3), ['fill', 'source-over', GOLD]);
    assert.deepStrictEqual(icons(), both(DATA));

    await status('working');
    assert.deepStrictEqual(icons(), both('/favicon.png'), 'the plain image returns when the wait ends');
    assert.deepStrictEqual(titleWrites, [], 'document.title is never written');
    assert.equal(doc.title, 'test');
  });

  test('the badge composites onto the project\'s mark, and onto the dark image in a dark browser', async () => {
    await projectFrame({ favicon: meta('F1'), favicon_dark: meta('F2'), mark: 'favicon', mark_dark: true });
    await status('waiting');
    await waitUntil(() => icons()[0].startsWith('data:'), { timeout: 2000 });
    assert.deepStrictEqual(loads, ['/project/mark?v=F1']);
    shell.setViewport({ dark: true });
    await waitUntil(() => loads.length === 2, { timeout: 2000 });
    assert.equal(loads[1], '/project/mark?mode=dark&v=F2');
    await shell.tick();
    assert.deepStrictEqual(icons(), both(DATA));
    await projectFrame();
    await waitUntil(() => loads.length === 3, { timeout: 2000 });
    assert.equal(loads[2], '/favicon-dark.png');
    await status('idle');
    assert.deepStrictEqual(icons(), both('/favicon-dark.png'));
  });

  test('no 2d context, or an image that fails to load, leaves the plain href and throws nothing', async () => {
    makeCanvas = () => fakeCanvas({ context: false });
    await status('waiting');
    await waitUntil(() => loads.length === 1, { timeout: 2000 });
    await shell.tick();
    assert.deepStrictEqual(icons(), both('/favicon.png'));

    await status('idle');
    makeCanvas = () => fakeCanvas();
    loadImage = async () => { throw new Error('404'); };
    await status('question');
    await waitUntil(() => loads.length === 2, { timeout: 2000 });
    await shell.tick();
    assert.deepStrictEqual(icons(), both('/favicon.png'));

    // No canvas at all.
    await status('idle');
    loadImage = async (src) => ({ src });
    makeCanvas = () => null;
    await status('waiting');
    await waitUntil(() => loads.length === 3, { timeout: 2000 });
    await shell.tick();
    assert.deepStrictEqual(icons(), both('/favicon.png'));
    assert.deepStrictEqual(titleWrites, []);
  });

  test('a composition that lands after the wait ended is dropped', async () => {
    let release;
    loadImage = (src) => new Promise((r) => { release = () => r({ src }); });
    await status('waiting');
    await waitUntil(() => loads.length === 1, { timeout: 2000 });
    await status('idle');
    assert.deepStrictEqual(icons(), both('/favicon.png'));
    release();
    await shell.tick();
    assert.deepStrictEqual(icons(), both('/favicon.png'), 'the late badge never lands');
  });

  // Last: it drops the socket, and the chrome reconnects a second later.
  test('the badge goes while the socket is down (the state is unknown then)', async () => {
    await status('waiting');
    await waitUntil(() => icons()[0].startsWith('data:'), { timeout: 2000 });
    const before = shell.sockets.length;
    shell.socket().drop();
    await shell.tick();
    assert.notEqual(S.mirror.conn, 'live');
    assert.deepStrictEqual(icons(), both('/favicon.png'));
    // Back on the reconnect's hello, the aggregate still waiting.
    await waitUntil(() => shell.sockets.length > before, { timeout: 5000 });
    await waitUntil(() => S.mirror.conn === 'live', { timeout: 5000 });
    await shell.frame(helloFrame());
    await status('waiting');
    await waitUntil(() => icons()[0].startsWith('data:'), { timeout: 2000 });
    assert.deepStrictEqual(titleWrites, []);
  });
});

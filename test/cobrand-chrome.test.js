// The topbar's co-brand lockup (public/app/cobrand.js) and the browser tab's
// title (public/app/project.js), through the real shell (test-support/
// chrome-shell.js): design spec §9.4, and the maintainer's N1 ruling.
//
//   * The lockup is the global theme's company image │ the project's logo and
//     name. Absent means absent: an image is in the DOM only while it has a
//     source, the divider only beside a company image, and an image that fails
//     to load hides itself and drops its class. Which images a width shows is
//     the stylesheet's (test/responsive-a11y.test.js pins the breakpoint); the
//     has-* classes, data-slot and data-shape this module sets are pinned here,
//     for every combination of company image and project logo and mark.
//   * Every image is an <img>, never inlined SVG markup nor an <object>, <embed>
//     or <iframe> of the file, so a logo runs nothing in the chrome's origin
//     (assertImgOnly, in each mode).
//   * Every image follows web-chat's OWN mode (<html data-theme>, the ◑ toggle):
//     the company image takes its reversed mark, and the project's images ask
//     for ?mode=dark, which the daemon answers with the dark variant or, with
//     none, the light image.
//   * The tab title is the project's name and nothing else: never " — web-chat",
//     never a step or a state. Before the identity is known it is the hello's
//     folder name; a reconnect's hello never puts the folder name back over a
//     renamed project; a `project` frame renames it.
//
// main.js does not start either module yet (the tranche's integration unit
// wires them), so the boot's init does, as main.js will.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const FOLDER = 'acme-web';
// One image's metadata, as GET /api/brand and GET /api/project report it.
const meta = (version, width = null, height = null) => ({ type: 'image/png', bytes: 120, version, width, height });
// The project's identity as the daemon sends it (lib/core/project-identity).
const identity = (over = {}) => ({
  name: 'Acme Web', default_name: FOLDER, custom: true, show_name: true,
  logo: null, logo_dark: null, favicon: null, favicon_dark: null, touch: null,
  mark: null, mark_dark: false, ...over,
});
const NO_SLOTS = { logotype: null, lockup: null, seal: null };

// What GET /api/project answers: the current identity, unless a test holds the
// answer back to look at the moment before it lands.
let serverIdentity = identity();
let projectRoute = () => serverIdentity;
function hold() {
  let release;
  const answer = new Promise((r) => { release = r; });
  projectRoute = () => answer;
  return (body) => { projectRoute = () => serverIdentity; release(body); };
}

let shell, bus, project;
let W, doc, $;
const cobrand = () => $('cobrand');
const classes = () => [...cobrand().classList].filter((c) => c !== 'cobrand').sort();
const srcOf = (id) => ($(id) ? $(id).getAttribute('src') : null);
// Every image of the lockup is an <img> pointed at a same-origin route, and the
// lockup holds nothing but <span> and <img> elements. An <img> runs nothing in
// the chrome's origin, even for an SVG; inlined <svg> markup, or an <object>,
// <embed> or <iframe> of the same file, would run its scripts here. It is the
// guard for the project's images above all: an SVG committed with a repository
// was never through the upload's active-SVG refusal, and is only re-sniffed
// when it is read (lib/core/image-file.js). A src checked through getAttribute
// cannot see the difference, so the tests that draw images call this too.
const IMAGE_IDS = ['cobrand-logo', 'cobrand-mark', 'cobrand-icon', 'cobrand-pmark'];
function assertImgOnly(at) {
  for (const id of IMAGE_IDS) {
    if ($(id)) assert.equal($(id).tagName, 'IMG', `${at}: #${id} is an <img>, never inlined svg markup`);
  }
  assert.equal(cobrand().querySelector('svg'), null, `${at}: no <svg> anywhere in the lockup`);
  const other = [...cobrand().querySelectorAll('*')].map((e) => e.tagName).filter((t) => t !== 'SPAN' && t !== 'IMG');
  assert.deepEqual(other, [], `${at}: the lockup is made of <span> and <img> elements only`);
}
const brandFrame = (slots, fill, theme) => shell.frame({ type: 'brand', slots: { ...NO_SLOTS, ...slots },
  ...(fill === undefined ? {} : { fill: { ...NO_SLOTS, ...fill } }), ...(theme === undefined ? {} : { theme }) });
const projectFrame = (id) => shell.frame({ type: 'project', identity: id });
const brandReads = () => shell.calls.filter((c) => c.url === '/api/brand').length;
const setMode = async (mode) => {
  if (mode === 'dark') delete doc.documentElement.dataset.theme;   // theme.js's dark
  else doc.documentElement.dataset.theme = 'light';
  await shell.tick();
};

before(async () => {
  shell = await bootShell({
    routes: { '/api/project': () => projectRoute() },
    init: async (sh) => {
      const ws = await sh.importApp('ws.js');
      const { initProject } = await sh.importApp('project.js');
      const { initCobrand } = await sh.importApp('cobrand.js');
      initProject({ onFrame: ws.onFrame, onHello: ws.onHello });
      initCobrand();
    },
  });
  ({ bus } = await shell.importApp('bus.js'));
  project = await shell.importApp('project.js');
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
});

after(() => shell.restore());

beforeEach(() => {
  shell.setRoutes();
  shell.calls.length = 0;
});

/* ── the tab title ─────────────────────────────────────────────────────────── */

test('before the daemon has said anything, the tab and the lockup read web-chat', () => {
  assert.equal(doc.title, 'web-chat');
  assert.equal($('cobrand-name').textContent, 'web-chat');
  assert.equal(cobrand().title, 'web-chat');
  assert.deepEqual(classes(), [], 'no image of either half: no has-* class');
  assert.equal(cobrand().querySelector('img'), null, 'and no <img> at all');
  assert.equal(project.getProject(), project.DEFAULT_IDENTITY);
});

test('the tab title is the hello\'s folder name until the identity lands, then the identity\'s name', async (t) => {
  const answer = hold();
  t.after(() => answer(serverIdentity));
  await shell.frame(helloFrame({ project: FOLDER }));
  assert.equal(doc.title, FOLDER, 'the folder name, bare: ws.js\'s "<folder> — web-chat" does not survive the hello');
  assert.equal($('cobrand-name').textContent, FOLDER, 'the lockup names the folder meanwhile');
  assert.ok(shell.calls.some((c) => c.url === '/api/project' && c.method === 'GET'), 'and the identity is read');

  answer(identity());
  await shell.tick();
  assert.equal(doc.title, 'Acme Web', 'the identity\'s name, and nothing else');
  assert.equal($('cobrand-name').textContent, 'Acme Web');
  assert.equal(cobrand().title, `Acme Web (${FOLDER})`, 'a custom name says which folder it stands for');
  const got = project.getProject();
  assert.equal(got.name, 'Acme Web');
  assert.ok(Object.isFrozen(got), 'one copy, read-only to its readers');
});

test('a reconnect\'s hello never puts the folder name back, and a dropped socket never touches the title', async (t) => {
  const answer = hold();
  t.after(() => answer(serverIdentity));
  const sockets = shell.sockets.length;
  shell.socket().drop();
  await shell.tick();
  assert.equal(doc.title, 'Acme Web', 'a dropped connection is the pill\'s to show, never the title\'s');
  assert.equal($('active-pill').textContent, 'reconnecting…', 'and the pill does show it');

  await waitUntil(() => shell.sockets.length > sockets && shell.socket().readyState === 1,
    { timeout: 5000, what: 'the chrome to reconnect' });
  await shell.frame(helloFrame({ project: FOLDER }));
  assert.equal(doc.title, 'Acme Web', 'the known name stands while the identity is re-read: no flicker to the folder');
  assert.equal($('cobrand-name').textContent, 'Acme Web');

  answer(identity());
  await shell.tick();
  assert.equal(doc.title, 'Acme Web');
});

test('a `project` frame renames the tab and the lockup', async () => {
  await projectFrame(identity({ name: 'Acme Two' }));
  assert.equal(doc.title, 'Acme Two');
  assert.equal($('cobrand-name').textContent, 'Acme Two');
  assert.equal(cobrand().title, `Acme Two (${FOLDER})`);

  await projectFrame(identity({ name: FOLDER, custom: false }));
  assert.equal(doc.title, FOLDER, 'reset to the folder name');
  assert.equal(cobrand().title, FOLDER, 'not custom: the tooltip is the name alone');

  await projectFrame(identity());
  assert.equal(doc.title, 'Acme Web');
});

test('the title never carries a step, a state or a node: mirror frames, locks and previews leave it alone', async () => {
  const seen = [];
  const off = bus.on('project', (d) => seen.push(d));
  const frames = [
    { type: 'mirror:status', status: { c1: { state: 'working', step: { tool: 'Edit', label: 'Edit · QueueRail.tsx' } } } },
    { type: 'mirror:status', status: { c1: { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash' } } } },
    { type: 'mirror:update', conversation: { id: 'c1', title: 'Fix the rail' }, what: ['stream'] },
    { type: 'mirror:ask', ask: { id: 'a1', kind: 'question', summary: 'Keep the 56px rail?' } },
    { type: 'lock', lock: { author: 'user', token: 't', prompt: 'make it blue' } },
    { type: 'lock', lock: { author: 'wake', token: 't2' } },
    { type: 'lock', lock: null },
    { type: 'node-added', active: 'n1', unlock: true },
  ];
  for (const f of frames) {
    await shell.frame(f);
    assert.equal(doc.title, 'Acme Web', `after ${f.type}`);
  }
  bus.emit('mirror', { what: 'all' });
  bus.emit('conn', { state: 'reconnecting' });
  bus.emit('conn', { state: 'live' });
  assert.equal(doc.title, 'Acme Web');
  off();
  assert.deepEqual(seen, [], 'and none of it is a change of identity');
});

test('garbage keeps the last good identity: a frame, and a GET answer, that is not one', async (t) => {
  const before = project.getProject();
  const seen = [];
  const off = bus.on('project', (d) => seen.push(d));
  t.after(off);
  for (const bad of [undefined, null, 'Acme', 42, [], {}, { name: '' }, { name: '   ' }, { name: 7 }, { show_name: false }]) {
    await shell.frame(bad === undefined ? { type: 'project' } : { type: 'project', identity: bad });
    assert.equal(doc.title, 'Acme Web', `kept after ${JSON.stringify(bad)}`);
  }
  assert.equal(project.getProject(), before, 'the same identity, untouched');
  assert.deepEqual(seen, [], 'and no `project` event for any of it');

  // A daemon older than the project routes answers 404; a confused one, junk.
  serverIdentity = { ok: true };
  await shell.frame(helloFrame({ project: FOLDER }));
  shell.setRoutes({ '/api/project': respond({ error: 'not found' }, { status: 404 }) });
  await shell.frame(helloFrame({ project: FOLDER }));
  assert.equal(doc.title, 'Acme Web');
  assert.equal(project.getProject(), before);
  serverIdentity = identity();
});

test('an identity read that something newer overtook is older news: it never undoes what landed after it', async (t) => {
  // The host renames the project while the hello's read is out: the frame is
  // newer than the answer the read is about to bring.
  const answer = hold();
  t.after(() => answer(serverIdentity));
  await shell.frame(helloFrame({ project: FOLDER }));
  await projectFrame(identity({ name: 'Renamed' }));
  assert.equal(doc.title, 'Renamed');
  answer(identity({ name: 'Acme Web' }));
  await shell.tick();
  assert.equal(doc.title, 'Renamed', 'the older answer is dropped');

  // Two reads out at once (two hellos in quick succession): the later read's
  // answer is the one that stays, whichever order the answers come back in.
  const readPair = async () => {
    const first = hold();
    await shell.frame(helloFrame({ project: FOLDER }));
    const second = hold();
    await shell.frame(helloFrame({ project: FOLDER }));
    return [first, second];
  };
  let [first, second] = await readPair();
  second(identity({ name: 'Second' }));
  await shell.tick();
  first(identity({ name: 'First' }));
  await shell.tick();
  assert.equal(doc.title, 'Second', 'the earlier read, answering last, is dropped');

  [first, second] = await readPair();
  first(identity({ name: 'First' }));
  await shell.tick();
  assert.equal(doc.title, 'First', 'the earlier read, answering first, is still newer than what was shown');
  second(identity({ name: 'Second' }));
  await shell.tick();
  assert.equal(doc.title, 'Second', 'and the later read\'s answer still lands after it');
  await projectFrame(identity());
});

test('the name is text: markup stays text in the tab and the lockup, and a long name is cut to 64 code points', async () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await projectFrame(identity({ name: evil }));
  assert.equal(doc.title, evil);
  assert.equal($('cobrand-name').textContent, evil);
  assert.equal($('cobrand-name').children.length, 0, 'no element was made of it');
  assert.equal(W.__pwned, undefined);

  const long = '🦊'.repeat(40) + 'x'.repeat(40);
  await projectFrame(identity({ name: long }));
  assert.equal([...doc.title].length, 64, 'cut by code points, so no emoji is split in half');
  assert.equal(doc.title, '🦊'.repeat(40) + 'x'.repeat(24));

  await projectFrame(identity({ name: '  Acme Web  ', name_max: 64, max_bytes: 262144 }));
  assert.equal(doc.title, 'Acme Web', 'trimmed');
  assert.equal('name_max' in project.getProject(), false, 'the GET\'s extra fields are not identity');
});

/* ── the lockup ────────────────────────────────────────────────────────────── */

// The company half: the global theme's brand image. The wide image is the
// logotype, else the seal; the narrow one the seal, else the logotype. `none`
// comes after the others, so it proves the images and the divider GO.
const COMPANY = {
  logotype: { slots: { logotype: meta('LT') }, logo: ['logotype', '/brand/logotype?v=LT'], mark: ['logotype', '/brand/logotype?v=LT'] },
  seal: { slots: { seal: meta('SE') }, logo: ['seal', '/brand/seal?v=SE'], mark: ['seal', '/brand/seal?v=SE'] },
  both: { slots: { logotype: meta('LT'), seal: meta('SE') }, logo: ['logotype', '/brand/logotype?v=LT'], mark: ['seal', '/brand/seal?v=SE'] },
  none: { slots: {}, logo: null, mark: null },
};
// The project half: the logo (wide), and the mark the phone draws (the
// favicon, else a square logo).
const PROJECT = {
  'no image': { id: {}, icon: null, pmark: null },
  'a wordmark logo': { id: { logo: meta('W1', 300, 60) }, icon: ['wide', '/project/logo?v=W1'], pmark: null },
  'a square logo': { id: { logo: meta('S1', 128, 128), mark: 'logo' }, icon: ['tile', '/project/logo?v=S1'], pmark: '/project/mark?v=S1' },
  'a favicon alone': { id: { favicon: meta('F1', 64, 64), mark: 'favicon' }, icon: null, pmark: '/project/mark?v=F1' },
  'a wordmark and a favicon': { id: { logo: meta('W1', 300, 60), favicon: meta('F1', 64, 64), mark: 'favicon' },
    icon: ['wide', '/project/logo?v=W1'], pmark: '/project/mark?v=F1' },
};

test('every combination of company image and project logo and mark: the has-* classes, the images, the order', async () => {
  for (const [cname, co] of Object.entries(COMPANY)) {
    for (const [pname, pr] of Object.entries(PROJECT)) {
      const at = `${cname} │ ${pname}`;
      await brandFrame(co.slots, {});
      await projectFrame(identity(pr.id));
      const want = [];
      if (co.logo) want.push('has-logo', 'has-mark');
      if (pr.icon) want.push('has-plogo');
      if (pr.pmark) want.push('has-pmark');
      assert.deepEqual(classes(), want.sort(), `${at}: classes`);

      // company
      assert.equal(!!$('cobrand-co'), !!co.logo, `${at}: #cobrand-co only with a company image`);
      assert.equal(cobrand().querySelectorAll('.cobrand-div').length, co.logo ? 1 : 0,
        `${at}: the divider only beside a company image`);
      if (co.logo) {
        assert.deepEqual([$('cobrand-logo').dataset.slot, srcOf('cobrand-logo')], co.logo, `${at}: the wide image`);
        assert.deepEqual([$('cobrand-mark').dataset.slot, srcOf('cobrand-mark')], co.mark, `${at}: the narrow image`);
        assert.deepEqual([...$('cobrand-co').children].map((e) => e.id), ['cobrand-logo', 'cobrand-mark']);
        assert.equal(cobrand().querySelector('.cobrand-div').getAttribute('aria-hidden'), 'true');
      } else {
        assert.equal($('cobrand-logo'), null);
        assert.equal($('cobrand-mark'), null);
      }

      // project
      assert.deepEqual($('cobrand-icon') ? [$('cobrand-icon').dataset.shape, srcOf('cobrand-icon')] : null, pr.icon,
        `${at}: the project logo`);
      assert.equal(srcOf('cobrand-pmark'), pr.pmark, `${at}: the project mark`);
      assert.equal($('cobrand-name').textContent, 'Acme Web', `${at}: the name, always`);

      // order: company │ project; logo, mark, name
      assert.deepEqual([...cobrand().children].map((e) => e.id || e.className),
        [...(co.logo ? ['cobrand-co', 'cobrand-div'] : []), 'cobrand-proj'], `${at}: the lockup's order`);
      assert.deepEqual([...$('cobrand-proj').children].map((e) => e.id),
        [...(pr.icon ? ['cobrand-icon'] : []), ...(pr.pmark ? ['cobrand-pmark'] : []), 'cobrand-name'], `${at}: the project's order`);
      const imgs = [...cobrand().querySelectorAll('img')];
      assert.equal(imgs.length, (co.logo ? 2 : 0) + (pr.icon ? 1 : 0) + (pr.pmark ? 1 : 0),
        `${at}: one <img> per image drawn, so the loop below has every one of them to check`);
      for (const img of imgs) {
        assert.equal(img.getAttribute('alt'), '', `${at}: #${img.id} is an <img> with an empty alt; the name says it`);
        assert.equal(img.hidden, false, `${at}: #${img.id} shows`);
      }
      assertImgOnly(at);
    }
  }
  await brandFrame({}, {});
  await projectFrame(identity());
});

test('data-shape: a square logo is a tile, within 2 %; anything else, or a logo of unknown size, a wordmark', async () => {
  const shape = async (w, h) => {
    await projectFrame(identity({ logo: meta(`${w}x${h}`, w, h) }));
    return $('cobrand-icon').dataset.shape;
  };
  assert.equal(await shape(128, 128), 'tile');
  assert.equal(await shape(100, 102), 'tile', '2 % off square is still a tile');
  assert.equal(await shape(100, 103), 'wide', 'more than 2 % is not');
  assert.equal(await shape(300, 60), 'wide');
  assert.equal(await shape(60, 300), 'wide', 'a tall logo is drawn whole too');
  assert.equal(await shape(null, null), 'wide', 'an SVG with no size: drawn at its own aspect ratio, never cropped');
  // The shape is the light logo's: a dark variant has the same shape by rule.
  await projectFrame(identity({ logo: meta('L', 128, 128), logo_dark: meta('D', 300, 60) }));
  await setMode('dark');
  assert.equal($('cobrand-icon').dataset.shape, 'tile');
  await setMode('light');
  await projectFrame(identity());
});

test('no-name hides the name from the eye only: the tooltip, the tab and the accessibility tree keep it', async () => {
  await projectFrame(identity({ show_name: false, logo: meta('W1', 300, 60) }));
  assert.ok(cobrand().classList.contains('no-name'), 'beside a wordmark that spells it');
  const name = $('cobrand-name');
  assert.equal(name.textContent, 'Acme Web', 'still in the DOM, as text');
  assert.equal(name.hidden, false, 'not hidden: the stylesheet clips it, a screen reader still reads it');
  assert.equal(name.getAttribute('aria-hidden'), null);
  assert.equal(cobrand().title, `Acme Web (${FOLDER})`, 'the tooltip');
  assert.equal(doc.title, 'Acme Web', 'the tab');

  // With no logo, the name is all the project half has: it stays drawn.
  await projectFrame(identity({ show_name: false }));
  assert.ok(!cobrand().classList.contains('no-name'), 'show_name off with no logo hides nothing');
  await projectFrame(identity());
  assert.ok(!cobrand().classList.contains('no-name'));
});

test('an image that fails to load hides itself and drops its class; a new one shows again', async () => {
  await brandFrame({ logotype: meta('LT'), seal: meta('SE') }, {});
  await projectFrame(identity({ show_name: false, logo: meta('W1', 300, 60), favicon: meta('F1', 64, 64), mark: 'favicon' }));
  assert.deepEqual(classes(), ['has-logo', 'has-mark', 'has-plogo', 'has-pmark', 'no-name']);
  const fail = async (id) => { $(id).dispatchEvent(new W.Event('error')); await shell.tick(); };

  await fail('cobrand-icon');
  assert.equal($('cobrand-icon').hidden, true, 'no broken-image glyph');
  assert.deepEqual(classes(), ['has-logo', 'has-mark', 'has-pmark'],
    'has-plogo goes, and no-name with it: with its logo gone, the name is drawn again');

  await fail('cobrand-logo');
  assert.equal($('cobrand-logo').hidden, true);
  assert.deepEqual(classes(), ['has-mark', 'has-pmark'], 'the wide company image is gone; the seal still loaded');
  await fail('cobrand-mark');
  await fail('cobrand-pmark');
  assert.deepEqual(classes(), [], 'every image failed: no class, so no divider is drawn beside nothing');

  // A redraw with the same images keeps them hidden (no flicker, no retry loop)…
  await projectFrame(identity({ show_name: false, logo: meta('W1', 300, 60), favicon: meta('F1', 64, 64), mark: 'favicon' }));
  assert.equal($('cobrand-icon').hidden, true);
  // …and a new version of one is a new image: it shows, and its class is back.
  await projectFrame(identity({ show_name: false, logo: meta('W2', 300, 60), favicon: meta('F1', 64, 64), mark: 'favicon' }));
  assert.equal($('cobrand-icon').hidden, false);
  assert.equal(srcOf('cobrand-icon'), '/project/logo?v=W2');
  assert.deepEqual(classes(), ['has-plogo', 'no-name']);
  await brandFrame({ logotype: meta('LT2'), seal: meta('SE2') }, {});
  assert.deepEqual(classes(), ['has-logo', 'has-mark', 'has-plogo', 'no-name']);

  await brandFrame({}, {});
  await projectFrame(identity());
});

/* ── which mode ────────────────────────────────────────────────────────────── */

test('in dark mode the project\'s images ask for ?mode=dark, and back in light for the light ones', async () => {
  await projectFrame(identity({ logo: meta('L1', 128, 128), logo_dark: meta('D1', 128, 128), mark: 'logo', mark_dark: true }));
  assert.equal(srcOf('cobrand-icon'), '/project/logo?v=L1');
  assert.equal(srcOf('cobrand-pmark'), '/project/mark?v=L1');
  assertImgOnly('light');

  await setMode('dark');
  assert.equal(srcOf('cobrand-icon'), '/project/logo?mode=dark&v=D1', 'the dark variant, keyed by its own version');
  assert.equal(srcOf('cobrand-pmark'), '/project/mark?mode=dark&v=D1');
  assertImgOnly('dark: the dark variants are <img> sources too');
  await setMode('light');
  assert.equal(srcOf('cobrand-icon'), '/project/logo?v=L1', 'and back');
  assert.equal(srcOf('cobrand-pmark'), '/project/mark?v=L1');
  assertImgOnly('back in light');

  // No dark variant: dark mode still asks for ?mode=dark (the daemon falls back
  // to the light image), keyed by the light file it will get.
  await projectFrame(identity({ logo: meta('L2', 300, 60), favicon: meta('F2', 64, 64), favicon_dark: meta('FD', 64, 64),
    mark: 'favicon', mark_dark: true }));
  await setMode('dark');
  assert.equal(srcOf('cobrand-icon'), '/project/logo?mode=dark&v=L2');
  assert.equal(srcOf('cobrand-pmark'), '/project/mark?mode=dark&v=FD', 'a favicon mark takes the favicon\'s dark variant');
  assertImgOnly('dark, a wordmark and a favicon');
  await setMode('light');
  await projectFrame(identity());
});

test('the ◑ toggle flips the lockup with the rest of the chrome: web-chat\'s mode, not the browser\'s', async () => {
  await projectFrame(identity({ logo: meta('L1', 128, 128), logo_dark: meta('D1', 128, 128) }));
  assert.equal(doc.documentElement.dataset.theme, 'light');
  shell.click($('btn-theme-toggle'));
  await shell.tick();
  assert.equal(doc.documentElement.dataset.theme, undefined, 'web-chat went dark');
  assert.equal(srcOf('cobrand-icon'), '/project/logo?mode=dark&v=D1');

  // The browser's own scheme is the favicon's to follow; the topbar ignores it.
  shell.setViewport({ dark: false });
  await shell.tick();
  assert.equal(srcOf('cobrand-icon'), '/project/logo?mode=dark&v=D1');
  shell.setViewport({ dark: true });

  shell.click($('btn-theme-toggle'));
  await shell.tick();
  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(srcOf('cobrand-icon'), '/project/logo?v=L1');
  shell.setViewport({ dark: false });
  await projectFrame(identity());
});

test('the company image follows the mode too: a pack\'s fill swaps to its reversed mark, and the theme\'s own wins', async () => {
  const fill = { logotype: { light: meta('FL'), dark: meta('FD') } };
  await brandFrame({}, fill);
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?mode=light&v=FL');
  assertImgOnly('the fill, light');
  await setMode('dark');
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?mode=dark&v=FD', 'the reversed mark');
  assert.equal(srcOf('cobrand-mark'), '/brand/logotype?mode=dark&v=FD', 'the narrow choice, the logotype too');
  assertImgOnly('the fill, dark: the reversed mark is an <img> source too');
  await setMode('light');
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?mode=light&v=FL');

  // Only a reversed mark: nothing on light, drawn on dark.
  await brandFrame({}, { logotype: { light: null, dark: meta('FD') } });
  assert.equal($('cobrand-co'), null);
  assert.ok(!cobrand().classList.contains('has-logo'));
  await setMode('dark');
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?mode=dark&v=FD');
  assert.ok(cobrand().classList.contains('has-logo'));
  assertImgOnly('only a reversed mark, dark');
  await setMode('light');
  assert.equal($('cobrand-co'), null, 'gone again in light');

  // The theme's own logotype wins over the fill, in either mode; a frame that
  // carries no fill keeps the one known.
  await brandFrame({ logotype: meta('OWN') }, fill);
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?v=OWN');
  await setMode('dark');
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?v=OWN');
  await setMode('light');
  await brandFrame({});
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?mode=light&v=FL', 'the fill is back');
  await brandFrame({}, {});
});

/* ── the wire ──────────────────────────────────────────────────────────────── */

test('a brand frame updates the lockup with no /api/brand fetch, and the theme frame after it adds none', async () => {
  const before = brandReads();
  await brandFrame({ logotype: meta('B1') }, {}, { key: 'paper', name: 'paper', title: 'Paper' });
  assert.equal(srcOf('cobrand-logo'), '/brand/logotype?v=B1');
  assert.ok(cobrand().classList.contains('has-logo'));
  assertImgOnly('a brand frame');

  // A global theme change: the daemon's brand frame for the new theme, then its theme frame.
  await brandFrame({}, {}, { key: 'earthy', name: 'earthy', title: 'Earthy' });
  await shell.frame({ type: 'theme', scope: 'global', theme: { name: 'earthy', tokens: {} } });
  assert.equal($('cobrand-co'), null, 'Earthy has no logos: the company half went with the theme');
  assert.equal(cobrand().querySelector('.cobrand-div'), null);
  assert.equal(brandReads(), before, 'the frames carried all of it');
});

test('an upload from Settings → Brand lands in the lockup from its reply', async () => {
  shell.setRoutes({ '/api/brand/logotype': (url, init) => (init && init.method === 'PUT'
    ? { ok: true, type: 'image/png', bytes: 10, slots: { ...NO_SLOTS, logotype: meta('UP') } } : { ok: true }) });
  const file = new W.File([Buffer.from('png')], 'logo.png', { type: 'image/png' });
  const drop = doc.querySelector('#brand-slots .brand-slot[data-slot="logotype"] .brand-drop');
  const ev = new W.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [file] };
  drop.dispatchEvent(ev);
  await waitUntil(() => srcOf('cobrand-logo') === '/brand/logotype?v=UP', { what: 'the reply in the lockup' });
  assertImgOnly('an upload\'s reply');
  const put = shell.calls.find((c) => c.method === 'PUT');
  assert.equal(put && put.url, '/api/brand/logotype');
  assert.equal(brandReads(), 0, 'the reply carried the slots: no re-read');
  await brandFrame({}, {});
});

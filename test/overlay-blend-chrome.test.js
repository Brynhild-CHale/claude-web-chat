// The highlighter's blend seam in the real chrome (annotation engine tranche
// 5, U624; plan.json tranches[4] 5A.6; HIGHLIGHTER@blend-seam; RULED
// U624-U626@composite-granularity H4 = b, the blend per marker part; HAND
// FOLD 1, DECISIONS.md K.2-271): test-support/chrome-shell booted once, two
// plug-in box types loaded through the one loader (public/app/element-types.js
// loadPluginTypes, its importModule seam) from listing rows whose toolbar
// carries element.json's fields — `blendy` with composite: 'multiply', `plain`
// without — and jsdom's missing layout stubbed per element
// (shell.scrollMetrics), as test/overlay-box-mode-chrome.test.js does.
//
// Pinned here:
//   - an opting type's group has group.container in #el-layer and a second
//     container, group.blend, in #el-layer-blend (before #el-layer in tree
//     order) at the same box; what its draw puts into group.blend sits in the
//     blend layer and what it puts into group.container stays in #el-layer;
//     the draw and move ctx carry it as ctx.blend; a non-opting type's group
//     has no group.blend and its marker stays in #el-layer;
//   - group.blend mirrors group.container on every pass: left/top/width/
//     height, clip-path and display after a place, a move and an inset clip;
//     hidden with it (clipped out of the well, and 'framed' under a displayed
//     frame); it carries data-el-ids and no data-place, and the layer is
//     hidden while it holds no group.blend;
//   - the layer's mix-blend-mode is multiply in the light mode and screen
//     after theme.js setMode('dark');
//   - at 390 px with the queue open (body:has(.rail.open)) the blend layer is
//     not displayed, as #el-layer is not;
//   - el-layer-blend is a reserved mount id, and the overlay's COMPOSITE_MODES
//     is lib/packs/elements.js's.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { createCascade } = require('../test-support/css-cascade');
const { createBus } = require('../lib/core/bus');
const { setMount, isReservedId } = require('../lib/server/domain/mounts');
const { COMPOSITE_MODES } = require('../lib/packs/elements');

const REPO = path.join(__dirname, '..');
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHA_B = 'b'.repeat(64);
const SHA_P = 'c'.repeat(64);
const rowOf = (type, sha, toolbar) => ({
  type, schema: `${type}@1`, reads: [`${type}@1`], anchors: ['element'], family: 'page',
  remote: { see: 'read', send: 'full' }, private: true, builtin: false, tier: 'local', pack: 'blend-fixture',
  toolbar: { label: type, input: 'strokes', place: 'box', ...toolbar }, draw: { sha256: sha },
});
const BLENDY_ROW = rowOf('blendy', SHA_B, { composite: 'multiply' });
const PLAIN_ROW = rowOf('plain', SHA_P, {});
const PANES = [
  { id: 'bl-pane', target: 'main', params: {}, html: '<svg class="sheet" viewBox="0 0 400 200" width="400" height="200"></svg>' },
  { id: 'pl-pane', target: 'main', params: {}, html: '<svg class="sheet" viewBox="0 0 400 200" width="400" height="200"></svg>' },
];

let shell, W, M, ov, ET, theme, anchors;
let listed = false;
const TOP = 48;
const geo = { dy: 0, overrun: 0 };
const wellRect = () => ({ left: 0, top: TOP, width: W.innerWidth, height: W.innerHeight - TOP });
const hostRect = (i) => () => ({ left: 16, top: TOP + 40 + i * 300 + geo.dy, width: 432, height: 260 });
const svgRect = (i) => () => {
  const h = hostRect(i)();
  return { left: h.left + 8, top: h.top + 8, width: 400 + (i === 0 ? geo.overrun : 0), height: 200 };
};
const live = {};
function place(el, key, fn) {
  live[key] = { rect: fn(), fn };
  shell.scrollMetrics(el, live[key]);
}
function relayout() {
  for (const k of Object.keys(live)) Object.assign(live[k].rect, live[k].fn());
}
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const svgOf = (id) => rootOf(id).querySelector('svg.sheet');
const byIds = (sel, id) => [...W.document.querySelectorAll(sel)].filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const markersFor = (id) => byIds('#el-layer .el-marker', id);
const blendsFor = (id) => byIds('#el-layer-blend .el-blend', id);
const blendLayer = () => W.document.getElementById('el-layer-blend');
const layerEl = () => W.document.getElementById('el-layer');
const MIRRORED = ['left', 'top', 'width', 'height', 'clipPath', 'display'];
const styleOf = (el) => Object.fromEntries(MIRRORED.map((k) => [k, el.style[k]]));

// What each draw saw: the group and the ctx its draw and move were handed.
const seen = { blendy: [], plain: [], moves: [] };
function blendyModule() {
  return {
    default(g, ctx) {
      seen.blendy.push({ g, ctx });
      const svgIn = (parent, cls) => {
        const s = W.document.createElementNS(SVG_NS, 'svg');
        s.setAttribute('viewBox', '0 0 1 1');
        s.setAttribute('preserveAspectRatio', 'none');
        const p = W.document.createElementNS(SVG_NS, 'path');
        p.setAttribute('class', cls);
        p.setAttribute('d', 'M0 0.5 L1 0.5');
        s.appendChild(p);
        parent.replaceChildren(s);
      };
      svgIn(ctx.blend, 'hl');          // the blending path: the blend part
      svgIn(g.container, 'pen');       // the rest: the marker
    },
    move(g, ctx) { seen.moves.push({ g, blend: ctx.blend }); },
  };
}
function plainModule() {
  return {
    default(g, ctx) {
      seen.plain.push({ g, ctx });
      const s = W.document.createElementNS(SVG_NS, 'svg');
      g.container.replaceChildren(s);
    },
  };
}

before(async () => {
  const base = DEFAULT_ROUTES['/api/elements/types'];
  shell = await bootShell({
    viewport: { width: 1280, height: 800 },
    routes: { '/api/elements/types': () => (listed ? { ...base, types: [...base.types, BLENDY_ROW, PLAIN_ROW] } : base) },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  theme = await shell.importApp('theme.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ET.initElementTypes({ importModule: async (url) => (url.includes(SHA_B) ? blendyModule() : plainModule()) });
  await shell.frame(helloFrame({ mounts: PANES }));
  await shell.tick();
  place(W.document.querySelector('.well-wrap'), 'wrap', wellRect);
  place(W.document.getElementById('main'), 'main', () => ({ ...wellRect(), height: 3000 }));
  PANES.forEach((p, i) => {
    const host = M.itemEl(W.document, p.id).el;
    host.style.overflow = 'auto';
    place(host, `host${i}`, hostRect(i));
    place(svgOf(p.id), `svg${i}`, svgRect(i));
  });
  // The rows listed only once the test's importer is in: a digest the
  // default importer failed is never imported again (the loader's rule).
  listed = true;
  await shell.frame({ type: 'components' });
  await waitUntil(() => ET.typeOf('blendy') && ET.typeOf('plain'), { timeout: 5000, what: 'the two rows' });
  await ET.loadPluginTypes();
  ov.setElements('live', [
    { id: 'p1', v: 1, type: 'blendy', schema: 'blendy@1', shared: true, replies: 0,
      anchor: anchors.record(rootOf('bl-pane'), svgOf('bl-pane'), { mount: 'bl-pane' }) },
    { id: 'p2', v: 1, type: 'plain', schema: 'plain@1', shared: true, replies: 0,
      anchor: anchors.record(rootOf('pl-pane'), svgOf('pl-pane'), { mount: 'pl-pane' }) },
  ]);
  await waitUntil(() => markersFor('p1').length === 1 && markersFor('p2').length === 1 && seen.blendy.length && seen.plain.length,
    { timeout: 5000, what: 'both box markers drawn' });
});

after(async () => {
  try { if (ov) ov.setElements('live', []); } catch {}
  if (shell) await shell.restore();
});

async function settle() {
  ov.requestDraw();
  for (let i = 0; i < 3; i++) await shell.tick();
}
async function expectMirrored(label) {
  await settle();
  const [m] = markersFor('p1');
  const [b] = blendsFor('p1');
  assert.ok(m && b, `${label}: the marker and its blend part`);
  assert.deepStrictEqual(styleOf(b), styleOf(m), `${label}: group.blend has group.container's placement, clip and display`);
  return { m, b };
}

test('an opting type\'s group: group.container in #el-layer, group.blend in #el-layer-blend at the same box; its paths where its draw put them; a non-opting type has no group.blend', async () => {
  const { m, b } = await expectMirrored('placed');
  assert.notEqual(m.style.display, 'none', 'drawn');
  const r = svgRect(0)();
  assert.deepStrictEqual([m.style.left, m.style.top, m.style.width, m.style.height].map(parseFloat), [r.left, r.top, r.width, r.height],
    'the box is the svg\'s rect');
  const { g, ctx } = seen.blendy.at(-1);
  assert.equal(g.container, m, 'group.container is the marker in #el-layer');
  assert.equal(g.blend, b, 'group.blend is the blend part in #el-layer-blend');
  assert.equal(ctx.blend, g.blend, 'the draw ctx carries it');
  assert.equal(m.parentNode, layerEl());
  assert.equal(b.parentNode, blendLayer());
  assert.equal(m.dataset.place, 'box');
  assert.equal(b.dataset.elIds, 'p1', 'it carries the group\'s data-el-ids');
  assert.equal(b.hasAttribute('data-place'), false, 'and no data-place');
  assert.equal(b.classList.contains('el-marker'), false, 'not a marker: no marker query takes it');
  const hl = W.document.querySelector('path.hl');
  const pen = W.document.querySelector('path.pen');
  assert.ok(blendLayer().contains(hl), 'the path drawn into group.blend sits in the blend layer');
  assert.ok(layerEl().contains(pen), 'the path drawn into group.container stays in #el-layer');
  assert.ok(!blendLayer().contains(pen) && !layerEl().contains(hl));
  // The non-opting type: no blend part, its marker where it always was.
  const plain = seen.plain.at(-1);
  assert.equal(plain.g.blend, undefined, 'no group.blend');
  assert.equal('blend' in plain.ctx, false, 'no ctx.blend');
  assert.equal(markersFor('p2')[0].parentNode, layerEl());
  assert.deepStrictEqual(blendsFor('p2'), []);
  // The layer: before #el-layer in tree order (the glyphs stay above), shown
  // while it holds a blend part, never a press.
  const L = blendLayer();
  assert.ok(L.compareDocumentPosition(layerEl()) & W.Node.DOCUMENT_POSITION_FOLLOWING, '#el-layer-blend precedes #el-layer');
  assert.equal(L.parentNode, W.document.body);
  assert.equal(L.hidden, false);
  const css = createCascade(fs.readFileSync(path.join(REPO, 'public', 'app.css'), 'utf8'), { win: () => W });
  assert.equal(css.value(L, 'position'), 'fixed');
  assert.equal(css.value(L, 'z-index'), 'var(--z-pins)', 'the pins\' rung, as #el-layer');
  assert.equal(css.value(L, 'pointer-events'), 'none');
  assert.equal(css.value(b, 'pointer-events'), 'none', 'the blend part takes no press');
  assert.equal(css.value(L, 'mix-blend-mode'), null, 'the blend is the overlay\'s inline write, one writer');
});

test('group.blend mirrors group.container on every pass: a move, an inset clip, hidden with it out of the well and under a displayed frame', async () => {
  geo.dy = 30;
  relayout();
  const moved = await expectMirrored('moved');
  assert.equal(parseFloat(moved.b.style.top), svgRect(0)().top, 'moved with the marker');
  const mv = seen.moves.at(-1);
  assert.ok(mv && mv.blend === mv.g.blend && mv.blend === moved.b, 'the move ctx carries group.blend');
  // Past the pane's content box on the right: the marker is inset there, and
  // so is its blend part (no blended path paints past its pane's clip).
  geo.overrun = 60;
  relayout();
  const over = await expectMirrored('overrun');
  assert.match(over.m.style.clipPath, /^inset\(/, 'the marker is inset');
  geo.overrun = 0;
  relayout();
  await expectMirrored('back');
  // Out of the well: unplaced (clipped) — hide(g) hides both.
  geo.dy = -2000;
  relayout();
  const out = await expectMirrored('out of the well');
  assert.equal(out.m.style.display, 'none');
  assert.equal(out.b.style.display, 'none', 'hidden with its marker');
  geo.dy = 0;
  relayout();
  const shown = await expectMirrored('back in the well');
  assert.notEqual(shown.b.style.display, 'none');
  // A displayed frame meeting its box: 'framed', neither container shown.
  const frame = W.document.createElement('iframe');
  W.document.body.appendChild(frame);
  const r = svgRect(0)();
  shell.scrollMetrics(frame, { rect: { left: r.left + 100, top: r.top + 20, width: 120, height: 80 } });
  try {
    await settle();
    await waitUntil(() => markersFor('p1')[0].style.display === 'none', { timeout: 5000, what: 'hidden under the frame' });
    const framed = await expectMirrored('framed');
    assert.equal(framed.b.style.display, 'none', 'the blend part is not shown over a displayed frame');
    assert.ok(ov.stats('page').frame_hidden >= 1, 'counted frame_hidden');
  } finally { frame.remove(); }
  const after = await expectMirrored('the frame gone');
  assert.notEqual(after.b.style.display, 'none');
});

test('the blend layer\'s mix-blend-mode is multiply in the light mode and screen after setMode(\'dark\')', async () => {
  assert.deepStrictEqual([...ov.COMPOSITE_MODES], COMPOSITE_MODES, 'the overlay\'s copy is lib/packs/elements.js\'s');
  assert.equal(theme.effectiveMode(), 'light');
  assert.equal(blendLayer().style.mixBlendMode, 'multiply');
  try {
    theme.setMode('dark');
    assert.equal(theme.effectiveMode(), 'dark');
    assert.equal(blendLayer().style.mixBlendMode, 'screen', 'the theme\'s dark mode, not the OS scheme');
  } finally { theme.setMode('light'); }
  assert.equal(blendLayer().style.mixBlendMode, 'multiply');
});

test('at 390 px with the queue open (body:has(.rail.open)) the blend layer is not displayed', async () => {
  const css = createCascade(fs.readFileSync(path.join(REPO, 'public', 'app.css'), 'utf8'), { win: () => W });
  const rail = W.document.getElementById('queue-rail');
  assert.ok(rail && rail.classList.contains('rail'));
  try {
    shell.setViewport({ width: 390, height: 844 });
    rail.classList.add('open');
    assert.equal(css.value(blendLayer(), 'display'), 'none', 'the open queue covers the page: its blend goes with its markers');
    assert.equal(css.value(layerEl(), 'display'), 'none');
    rail.classList.remove('open');
    assert.equal(css.value(blendLayer(), 'display'), null, 'shown with the queue closed');
    shell.setViewport({ width: 1280, height: 800 });
    rail.classList.add('open');
    assert.equal(css.value(blendLayer(), 'display'), null, 'the wide open rail covers nothing');
  } finally {
    rail.classList.remove('open');
    shell.setViewport({ width: 1280, height: 800 });
  }
});

test('the blend layer is hidden while no opting group is drawn; a glyph type may not declare composite; el-layer-blend is a reserved id', async () => {
  ov.setElements('live', [{ id: 'p2', v: 1, type: 'plain', schema: 'plain@1', shared: true, replies: 0,
    anchor: anchors.record(rootOf('pl-pane'), svgOf('pl-pane'), { mount: 'pl-pane' }) }]);
  await waitUntil(() => markersFor('p1').length === 0, { timeout: 5000, what: 'the blendy marker gone' });
  await settle();
  assert.equal(blendLayer().children.length, 0, 'no blend part left behind');
  assert.equal(blendLayer().hidden, true, 'hidden while it holds nothing');
  assert.throws(() => ov.registerType('glyphy', { draw() {}, composite: 'multiply' }), /composite/);
  assert.throws(() => ov.registerType('screeny', { draw() {}, place: 'box', composite: 'screen' }), /composite/);
  // A render with the layer's id is refused at the one write gate.
  assert.equal(isReservedId('el-layer-blend'), true);
  const state = { mounts: new Map(), store: {} };
  const r = setMount(state, createBus(), { id: 'el-layer-blend', html: '<p>x</p>' });
  assert.equal(r.ok, false);
  assert.equal(r.reserved, true);
  assert.equal(state.mounts.size, 0);
});

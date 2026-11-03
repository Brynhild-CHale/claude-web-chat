// The box placement mode and the create-ctx seam (annotation engine tranche 4,
// U516, plan 4A.2; AD2 (a), AD3 (b); BOX@mode / WET@engine / FRAME@shared).
//
// The real chrome (test-support/chrome-shell, booted once) with the overlay's
// box reads stubbed (initOverlay({rectOf})), as test/overlay-clip.test.js
// does: jsdom does no layout, so the test owns the geometry — a scrolling well
// (.well-wrap) holding #main, a pane whose .mount-host clips, an <svg> in it.
// The overlay's frames run on a fake scheduler the test flushes.
//
// Pinned here:
//   - a place:'box' type over an svg target: its marker's left, top, width and
//     height are the target's rect; its draw ran once, with ctx.box {w, h} the
//     rect at that measure, and drew in the normalised viewBox; after the
//     target resizes at three widths (1,280, 900 and 390 px) the marker
//     follows and ctx.box reads the new rect, with no second draw call;
//   - a target half outside the well: the marker keeps the target's rect and
//     is clipped by its inset, and a displayed frame over the clipped-away
//     part only hides nothing (the rule reads the painted box); wholly
//     outside: not drawn (clipped);
//   - a displayed iframe overlapping the target: not drawn (framed,
//     stats('page').frame_hidden 1) — never drawn over a frame;
//   - a glyph type's marker over the same fixture is byte-identical with and
//     without a box type beside it (its placement, clip and transform);
//   - a box type's range row is drawn as a glyph;
//   - registerType refuses place 'free'; PLACE_MODES is the manifest's;
//   - registerCreateCtx refuses a bad name, a base key ('anchors') and a
//     duplicate; a registered value appears on the create ctx and leaves on
//     unregister; CREATE_CTX_KEYS is the ctx's own keys exactly.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const elements = require('../lib/packs/elements');

let shell, W, M, ov, anchors, IM;

// ── the fake scheduler and clock the overlay draws on ──────────────────────
const queue = [];
let clock = 0;
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(clock); n++; }
  assert.ok(n < max, 'the overlay settles to no pending frame');
  return n;
}

// ── the geometry ────────────────────────────────────────────────────────────
// The well and the pane scale with the viewport's width; the svg keeps its
// 2:1 aspect inside the pane, as a fixed-aspect target does.
const WELL_TOP = 48;
const geo = { svg: null, frame: null };
const rectFns = new Map();
function rect(r) { return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }; }
function rectOf(x) {
  clock += 0.05;
  const f = rectFns.get(x);
  return rect(f ? f() : { left: 0, top: 0, width: 0, height: 0 });
}
const vw = () => W.innerWidth;
const wellBox = () => ({ left: 0, top: WELL_TOP, width: vw(), height: W.innerHeight - WELL_TOP });
const mainBox = () => ({ left: 16, top: WELL_TOP, width: vw() - 32, height: 3000 });
const hostBox = () => ({ left: 32, top: WELL_TOP + 100, width: vw() - 64, height: 600 });
const svgFit = () => {
  const w = Math.round((vw() - 64) * 0.5);
  return { left: 48, top: WELL_TOP + 120, width: w, height: w / 2 };
};
const svgBox = () => (geo.svg ? geo.svg() : svgFit());

const BOX_PANE = {
  id: 'box-pane', target: 'main', params: {},
  html: '<svg class="art" viewBox="0 0 200 100" width="200" height="100"><rect x="10" y="10" width="80" height="40"/></svg>'
    + '<p class="cap">a caption under the art</p>',
};

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const svgEl = () => rootOf('box-pane').querySelector('svg.art');
const layer = () => W.document.getElementById('el-layer');
const markersFor = (id) => [...layer().querySelectorAll('.el-marker')]
  .filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const shown = (m) => m.style.display !== 'none';
const px = (v) => parseFloat(v);
const styleOf = (m) => ({ left: m.style.left, top: m.style.top, width: m.style.width, height: m.style.height,
  transform: m.style.transform, clipPath: m.style.clipPath, display: m.style.display });

before(async () => {
  shell = await bootShell({});
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  anchors = (await shell.importApp('anchors.js')).default;
  IM = await shell.importApp('input-mode.js');
  await shell.frame(helloFrame({ mounts: [BOX_PANE] }));
  const wrap = W.document.querySelector('.well-wrap');
  wrap.style.overflow = 'auto';
  rectFns.set(wrap, wellBox);
  rectFns.set(W.document.getElementById('main'), mainBox);
  const host = M.itemEl(W.document, 'box-pane').el;
  host.style.overflow = 'auto';
  rectFns.set(host, hostBox);
  rectFns.set(svgEl(), svgBox);
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock });
  await shell.tick();
  flush();
});

after(async () => {
  if (ov) { ov.setArmed(null); ov.setElements('live', []); }
  if (shell) await shell.restore();
});

async function draw(rows) {
  ov.setElements('live', rows);
  await waitUntil(() => { flush(); return ov.stats().anchors >= rows.length; }, { timeout: 5000, what: `${rows.length} answers` });
  ov.requestDraw();
  flush();
}
const svgRow = (id, type) => ({ id, v: 1, type, anchor: anchors.record(rootOf('box-pane'), svgEl(), { mount: 'box-pane' }),
  shared: true, replies: 0 });

// A box type that counts its draws and draws in the target's normalised space.
function boxType(name, log) {
  return ov.registerType(name, {
    place: 'box',
    draw(g, ctx) {
      // A glyph group (a box type's non-element row) gets no ctx.box.
      log.push(ctx.box ? { w: ctx.box.w, h: ctx.box.h, live: ctx.box, place: g.place } : { box: null, place: g.place });
      const NS = 'http://www.w3.org/2000/svg';
      const s = W.document.createElementNS(NS, 'svg');
      s.setAttribute('viewBox', '0 0 1 1');
      s.setAttribute('preserveAspectRatio', 'none');
      s.setAttribute('width', '100%');
      s.setAttribute('height', '100%');
      const p = W.document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M0.1 0.1 L0.9 0.9');
      s.appendChild(p);
      g.container.appendChild(s);
    },
  });
}

test('a place:\'box\' marker is its svg target\'s rect, and follows a resize at 1,280, 900 and 390 px with no second draw', async () => {
  const log = [];
  const off = boxType('scribble', log);
  try {
    await draw([svgRow('b1', 'scribble')]);
    const [m] = markersFor('b1');
    assert.ok(m && shown(m), 'the box marker is drawn');
    assert.equal(m.dataset.place, 'box');
    assert.equal(m.style.transform, '', 'a box marker carries no glyph offset');
    assert.equal(m.style.pointerEvents, 'none', 'a box marker never takes a press from its target');
    const want0 = svgBox();
    assert.deepStrictEqual([px(m.style.left), px(m.style.top), px(m.style.width), px(m.style.height)],
      [want0.left, want0.top, want0.width, want0.height]);
    assert.equal(m.style.clipPath, '', 'wholly inside its clip: no inset');
    assert.equal(log.length, 1, 'drawn once');
    assert.deepStrictEqual([log[0].w, log[0].h], [want0.width, want0.height], 'ctx.box at the draw is the measured rect');
    assert.equal(log[0].place, 'box');
    const s = m.querySelector('svg');
    assert.ok(s && s.getAttribute('viewBox') === '0 0 1 1', 'drawn in the normalised viewBox');
    for (const width of [1280, 900, 390]) {
      shell.setViewport({ width });
      flush();
      ov.requestDraw();
      flush();
      const [mm] = markersFor('b1');
      assert.equal(mm, m, `${width}: the same marker, never rebuilt`);
      const want = svgBox();
      assert.deepStrictEqual([px(mm.style.left), px(mm.style.top), px(mm.style.width), px(mm.style.height)],
        [want.left, want.top, want.width, want.height], `${width}: the marker follows the target`);
      assert.ok(shown(mm), `${width}: drawn`);
      assert.deepStrictEqual([log[0].live.w, log[0].live.h], [want.width, want.height], `${width}: ctx.box reads the newest measure`);
      assert.equal(log.length, 1, `${width}: no second draw call`);
    }
    assert.equal(Reflect.set(log[0].live, 'w', 1), false, 'ctx.box is read-only');
    assert.ok(Object.isFrozen(log[0].live));
  } finally {
    shell.setViewport({ width: 1280 });
    off();
    ov.setElements('live', []);
    flush();
  }
});

test('a target half outside the well is clipped by its inset; wholly outside, it is not drawn', async () => {
  const log = [];
  const off = boxType('scribble', log);
  const edgeFrame = W.document.createElement('iframe');
  try {
    // Half above the well's top edge (the well clips at WELL_TOP; the host is
    // given room above it so the well is the clip that bites).
    rectFns.set(M.itemEl(W.document, 'box-pane').el, () => ({ left: 32, top: 0, width: vw() - 64, height: 900 }));
    geo.svg = () => ({ left: 48, top: WELL_TOP - 50, width: 200, height: 100 });
    await draw([svgRow('b2', 'scribble')]);
    const [m] = markersFor('b2');
    assert.ok(m && shown(m), 'half inside: drawn');
    assert.deepStrictEqual([px(m.style.left), px(m.style.top), px(m.style.width), px(m.style.height)], [48, WELL_TOP - 50, 200, 100],
      'the marker keeps the whole target rect');
    assert.equal(m.style.clipPath, 'inset(50px 0px 0px 0px)', 'the part above the well is inset away');
    // A displayed frame over the clipped-away part only (above the well) meets
    // the target's rect but not its painted box: the box is still drawn (the
    // never-draw rule reads the painted box, as the glyph's does).
    W.document.body.appendChild(edgeFrame);
    rectFns.set(edgeFrame, () => ({ left: 48, top: 0, width: 200, height: WELL_TOP - 10 }));
    ov.requestDraw();
    flush();
    assert.ok(shown(m), 'a frame over the clipped-away part only hides nothing');
    assert.equal(ov.stats('page').frame_hidden, 0, 'not counted frame_hidden');
    edgeFrame.remove();
    // Past the well's right edge by half: inset from the right.
    geo.svg = () => ({ left: vw() - 100, top: WELL_TOP + 300, width: 200, height: 100 });
    rectFns.set(M.itemEl(W.document, 'box-pane').el, () => ({ left: 32, top: 0, width: vw() + 400, height: 900 }));
    rectFns.set(W.document.getElementById('main'), () => ({ left: 16, top: WELL_TOP, width: vw() + 400, height: 3000 }));
    ov.requestDraw();
    flush();
    assert.ok(shown(m), 'still drawn');
    assert.equal(m.style.clipPath, 'inset(0px 100px 0px 0px)', 'the part past the viewport is inset away');
    // Wholly outside: below the well.
    geo.svg = () => ({ left: 48, top: W.innerHeight + 10, width: 200, height: 100 });
    ov.requestDraw();
    flush();
    assert.equal(shown(m), false, 'wholly outside: not drawn');
    assert.deepStrictEqual([ov.stats().clipped, ov.stats().drawn], [1, 0], 'counted clipped');
    assert.equal(log.length, 1, 'the draw ran once, at its first drawn placement');
  } finally {
    edgeFrame.remove();
    rectFns.delete(edgeFrame);
    geo.svg = null;
    rectFns.set(M.itemEl(W.document, 'box-pane').el, hostBox);
    rectFns.set(W.document.getElementById('main'), mainBox);
    off();
    ov.setElements('live', []);
    flush();
  }
});

test('a displayed iframe overlapping the target: the box is not drawn (framed, frame_hidden 1); a glyph type is unchanged beside it', async () => {
  // The glyph type alone first: its marker's measure is the baseline.
  const offPin = ov.registerType('pin2', { draw() {} });
  const log = [];
  let offBox = null;
  const frame = W.document.createElement('iframe');
  try {
    await draw([svgRow('g1', 'pin2')]);
    const [gm] = markersFor('g1');
    assert.ok(gm && shown(gm), 'the glyph is drawn');
    const base = styleOf(gm);
    const r = svgBox();
    assert.deepStrictEqual([px(base.left), px(base.top), base.width, base.height, base.transform],
      [r.left, r.top, '26px', '26px', 'translate(-13px, -26px)'], 'a glyph at the target\'s top-left');
    // The box type beside it, over the same svg: the glyph's measure is
    // byte-identical, and the box is drawn at the target's rect.
    offBox = boxType('scribble', log);
    await draw([svgRow('g1', 'pin2'), svgRow('b3', 'scribble')]);
    const [gm2] = markersFor('g1');
    assert.deepStrictEqual(styleOf(gm2), base, 'the glyph type\'s placement, clip and transform unchanged');
    const [bm] = markersFor('b3');
    assert.ok(bm && shown(bm), 'the box is drawn');
    assert.notEqual(bm, gm2, 'two markers, one per type');
    assert.equal(ov.stats('page').frame_hidden, 0);
    // A displayed iframe in the pane, overlapping the lower-right of the
    // target (clear of the glyph, which paints above the target's top-left).
    rootOf('box-pane').appendChild(frame);
    rectFns.set(frame, () => ({ left: r.left + r.width - 40, top: r.top + r.height - 30, width: 300, height: 200 }));
    ov.requestDraw();
    flush();
    assert.equal(shown(bm), false, 'never drawn over a displayed frame');
    assert.equal(ov.stats('page').frame_hidden, 1, 'counted frame_hidden');
    assert.deepStrictEqual(styleOf(markersFor('g1')[0]), base, 'the glyph clear of the frame is unchanged');
    // The frame hidden: drawn again.
    frame.hidden = true;
    ov.requestDraw();
    flush();
    assert.ok(shown(bm), 'a hidden frame hides nothing');
    assert.equal(ov.stats('page').frame_hidden, 0);
    assert.equal(log.length, 1, 'one draw throughout');
  } finally {
    frame.remove();
    if (offBox) offBox();
    offPin();
    ov.setElements('live', []);
    flush();
  }
});

test('a box type\'s range row is drawn as a glyph (box mode is for element rows)', async () => {
  const log = [];
  const off = boxType('scribble', log);
  const root = rootOf('box-pane');
  const cap = root.querySelector('p.cap');
  rectFns.set(cap, () => ({ left: 60, top: WELL_TOP + 400, width: 200, height: 18 }));
  try {
    const range = W.document.createRange();
    range.setStart(cap.firstChild, 2);
    range.setEnd(cap.firstChild, 9);
    const rec = anchors.recordRange(root, range, { mount: 'box-pane' });
    assert.ok(rec, 'a range record');
    await draw([{ id: 'r1', v: 1, type: 'scribble', anchor: rec, shared: true, replies: 0 }]);
    const [m] = markersFor('r1');
    assert.ok(m, 'a marker');
    assert.equal(m.dataset.place, undefined, 'not a box marker');
    assert.equal(m.style.width, '26px', 'the glyph\'s size');
    assert.equal(m.style.transform, 'translate(-13px, -26px)');
    assert.equal(log.length, 1, 'its draw ran at the rebuild');
    assert.deepStrictEqual(log[0], { box: null, place: undefined }, 'a glyph group has no place and no ctx.box');
  } finally {
    rectFns.delete(cap);
    off();
    ov.setElements('live', []);
    flush();
  }
});

test('registerType refuses place \'free\'; the overlay\'s PLACE_MODES is the manifest\'s', () => {
  assert.throws(() => ov.registerType('bad-place', { draw() {}, place: 'free' }), (e) => e instanceof TypeError && /place must be one of glyph, box/.test(e.message));
  assert.throws(() => ov.registerType('bad-place', { draw() {}, place: 1 }), TypeError);
  for (const place of [undefined, null, 'glyph', 'box']) {
    const off = ov.registerType('ok-place', { draw() {}, place });
    off();
  }
  assert.deepStrictEqual([...ov.PLACE_MODES], ['glyph', 'box']);
  assert.deepStrictEqual([...ov.PLACE_MODES], [...elements.PLACE_MODES], 'one placement grammar, two spellings held equal');
  assert.ok(Object.isFrozen(ov.HOST_NAMES), 'HOST_NAMES stays frozen');
  assert.deepStrictEqual([...ov.HOST_NAMES], ['page', 'chat', 'turns'], 'no host added');
});

test('registerCreateCtx: refusals; a registered value is on the create ctx and leaves on unregister', () => {
  IM.setFingerDraws('off');
  for (const bad of ['', 'Wet', '1wet', 'we-t', 'w'.repeat(33), null, 7]) {
    assert.throws(() => ov.registerCreateCtx(bad, {}), (e) => e instanceof TypeError && /not a member name/.test(e.message), JSON.stringify(bad));
  }
  for (const own of ['anchors', 'sourceMap', 'markdownText', 'scope', 'armed']) {
    assert.throws(() => ov.registerCreateCtx(own, {}), (e) => e instanceof TypeError && e.message.includes(`"${own}"`) && /own keys/.test(e.message));
  }
  assert.deepStrictEqual([...ov.CREATE_CTX_KEYS], ['anchors', 'sourceMap', 'markdownText', 'scope', 'armed']);
  assert.ok(ov.CREATE_CTX_NAME.test('w'.repeat(32)), '32 characters is the cap, inclusive');
  const seen = [];
  const offType = ov.registerType('ctx-probe', { draw() {}, input: 'strokes', create: (inp, ctx) => seen.push(ctx) });
  const value = { begin() {} };
  const offWet = ov.registerCreateCtx('wetProbe', value);
  try {
    assert.throws(() => ov.registerCreateCtx('wetProbe', {}), (e) => e instanceof TypeError && /"wetProbe" is already registered/.test(e.message));
    assert.throws(() => ov.registerCreateCtx('noValue', undefined), TypeError);
    ov.setArmed('ctx-probe');
    const target = rootOf('box-pane').querySelector('p.cap');
    const pe = (type, id) => target.dispatchEvent(new W.PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: id, isPrimary: true,
      clientX: 80, clientY: 80, buttons: type === 'pointerup' ? 0 : 1,
    }));
    pe('pointerdown', 31);
    pe('pointerup', 31);
    assert.equal(seen.length, 2, 'the strokes tool heard its gesture');
    assert.equal(seen[0].wetProbe, value, 'the registered value, as given');
    assert.equal(seen[0].scope, 'live');
    assert.equal(typeof seen[0].anchors.record, 'function', 'the ctx\'s own keys kept');
    assert.deepStrictEqual(Object.keys(seen[0]).filter((k) => !ov.CREATE_CTX_KEYS.includes(k)), ['wetProbe'], 'nothing else added');
    offWet();
    offWet();   // idempotent
    pe('pointerdown', 32);
    pe('pointerup', 32);
    assert.equal('wetProbe' in seen[2], false, 'gone after unregister');
    assert.deepStrictEqual(Object.keys(seen[2]).sort(), [...ov.CREATE_CTX_KEYS].sort(), 'the ctx is its own keys exactly');
    // The name is free again.
    const offAgain = ov.registerCreateCtx('wetProbe', 1);
    offAgain();
  } finally {
    offWet();
    ov.setArmed(null);
    offType();
  }
});

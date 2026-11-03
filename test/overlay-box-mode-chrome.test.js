// The box placement mode in the real chrome (annotation engine tranche 4,
// U516, plan 4A.2; AD2 (a), AD3 (b)): test-support/chrome-shell booted once,
// the overlay main.js initialised with its own box reads (getBoundingClientRect,
// given per element through shell.scrollMetrics, since jsdom does no layout)
// and the shell's own animation frames, the type registered through the one
// registry (public/app/element-types.js registerElementType, listed by GET
// /api/elements/types with toolbar {input: 'strokes', place: 'box'}).
//
// Pinned here, at 390 × 844 (a phone) and at 1,280 × 800:
//   - a box marker over a pane's svg is the svg's rect, inside its clip (the
//     pane's content box ∩ the well ∩ the viewport): a target that runs past
//     the pane's content box is inset there, never painting outside it;
//   - a displayed frame in the chrome's own document (an answer or preview
//     frame's place) over the target hides the marker (frame_hidden counted),
//     and the marker comes back when the frame goes;
//   - the type's draw ran once through the registry's reads gate, with
//     ctx.box the rect it was placed at.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

let shell, W, M, ov, ET, anchors;

const SCRIBBLE_ROW = {
  type: 'scribble', schema: 'scribble@1', reads: ['scribble@1'], anchors: ['element'], family: 'page',
  remote: { see: 'read', send: 'full' }, private: true, builtin: false, tier: 'project', pack: 'ink-fixture',
  toolbar: { label: 'Scribble', input: 'strokes', place: 'box' },
};
const PANE = {
  id: 'ink-pane', target: 'main', params: {},
  html: '<svg class="sheet" viewBox="0 0 400 200" width="400" height="200"><rect x="0" y="0" width="400" height="200" fill="none"/></svg>',
};

// The geometry, from the viewport: the well under a 48 px top bar, the pane's
// content box inside it, the svg at a 2:1 aspect inside that.
const TOP = 48;
const geo = { overrun: 0 };
const vw = () => W.innerWidth;
const vh = () => W.innerHeight;
const wellRect = () => ({ left: 0, top: TOP, width: vw(), height: vh() - TOP });
const hostRect = () => ({ left: 16, top: TOP + 40, width: vw() - 32, height: (vw() - 48) / 2 + 40 });
const svgRect = () => {
  const h = hostRect();
  const w = h.width - 16 + geo.overrun;
  return { left: h.left + 8, top: h.top + 8, width: w, height: w / 2 };
};
const live = {};   // each stubbed element's live rect object (scrollMetrics reads it on every call)
function place(el, key, fn) {
  live[key] = { rect: fn() };
  shell.scrollMetrics(el, live[key]);
  live[key].fn = fn;
}
function relayout() {
  for (const k of Object.keys(live)) Object.assign(live[k].rect, live[k].fn());
}

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const svgEl = () => rootOf('ink-pane').querySelector('svg.sheet');
const markersFor = (id) => [...W.document.getElementById('el-layer').querySelectorAll('.el-marker')]
  .filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const px = (v) => parseFloat(v);
const draws = [];

before(async () => {
  // The built-in listing the shell answers by default, plus the box type's row.
  const base = DEFAULT_ROUTES['/api/elements/types'];
  shell = await bootShell({
    viewport: { width: 390, height: 844, coarse: true },
    routes: { '/api/elements/types': () => ({ ...base, types: [...base.types, SCRIBBLE_ROW] }) },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  anchors = (await shell.importApp('anchors.js')).default;
  await shell.frame(helloFrame({ mounts: [PANE] }));
  await shell.tick();
  const wrap = W.document.querySelector('.well-wrap');
  place(wrap, 'wrap', wellRect);
  place(W.document.getElementById('main'), 'main', () => ({ ...wellRect(), height: 3000 }));
  const host = M.itemEl(W.document, 'ink-pane').el;
  host.style.overflow = 'auto';
  place(host, 'host', hostRect);
  place(svgEl(), 'svg', svgRect);
  ET.registerElementType('scribble', {
    place: 'box',
    draw(g, ctx) {
      draws.push({ w: ctx.box.w, h: ctx.box.h });
      const s = W.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 1 1');
      s.setAttribute('preserveAspectRatio', 'none');
      g.container.appendChild(s);
    },
  });
  ov.setElements('live', [{ id: 'p1', v: 1, type: 'scribble', schema: 'scribble@1', shared: true, replies: 0,
    anchor: anchors.record(rootOf('ink-pane'), svgEl(), { mount: 'ink-pane' }) }]);
  await waitUntil(() => ov.stats().anchors >= 1 && markersFor('p1').length === 1, { timeout: 5000, what: 'the box marker' });
});

after(async () => {
  if (ov) ov.setElements('live', []);
  if (shell) await shell.restore();
});

// A draw requested and its frames run (the shell's animation frames are
// tracked 0 ms timeouts; one marker fits one frame).
async function settle() {
  ov.requestDraw();
  for (let i = 0; i < 3; i++) await shell.tick();
}
async function expectBox(label) {
  await settle();
  const [m] = markersFor('p1');
  await waitUntil(() => m.style.display !== 'none', { timeout: 5000, what: `${label}: the marker shown` });
  const r = svgRect();
  assert.deepStrictEqual([px(m.style.left), px(m.style.top), px(m.style.width), px(m.style.height)],
    [r.left, r.top, r.width, r.height], `${label}: the marker is the svg's rect`);
  assert.equal(m.dataset.place, 'box');
  // The painted box (the rect less the clip-path's insets) is inside the clip.
  const ins = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px\)/.exec(m.style.clipPath || '') || [0, 0, 0, 0, 0];
  const [it, ir, ib, il] = ins.slice(1).map(Number);
  const painted = { left: r.left + il, top: r.top + it, right: r.left + r.width - ir, bottom: r.top + r.height - ib };
  const h = hostRect();
  const w = wellRect();
  const clip = { left: Math.max(h.left, w.left, 0), top: Math.max(h.top, w.top, 0),
    right: Math.min(h.left + h.width, w.left + w.width, vw()), bottom: Math.min(h.top + h.height, w.top + w.height, vh()) };
  const eps = 1e-9;
  assert.ok(painted.left >= clip.left - eps && painted.top >= clip.top - eps && painted.right <= clip.right + eps
    && painted.bottom <= clip.bottom + eps, `${label}: painted ${JSON.stringify(painted)} inside the clip ${JSON.stringify(clip)}`);
  return { m, painted, insets: [it, ir, ib, il] };
}

async function atViewport(width, height) {
  shell.setViewport({ width, height });
  relayout();
  const { m, insets } = await expectBox(`${width}×${height}`);
  assert.deepStrictEqual(insets, [0, 0, 0, 0], `${width}: wholly inside, no inset`);
  // Past the pane's content box on the right: inset there.
  geo.overrun = 60;
  relayout();
  const over = await expectBox(`${width}: overrun`);
  assert.ok(over.insets[1] > 0, `${width}: the overrun is inset on the right`);
  geo.overrun = 0;
  relayout();
  await expectBox(`${width}: back`);
  // A displayed frame of the chrome's own document over the target.
  const frame = W.document.createElement('iframe');
  W.document.body.appendChild(frame);
  const r = svgRect();
  shell.scrollMetrics(frame, { rect: { left: r.left + r.width / 2, top: r.top + 10, width: 120, height: 80 } });
  try {
    await settle();
    await waitUntil(() => m.style.display === 'none', { timeout: 5000, what: `${width}: hidden under the frame` });
    assert.equal(ov.stats('page').frame_hidden, 1, `${width}: counted frame_hidden`);
  } finally {
    frame.remove();
  }
  await expectBox(`${width}: the frame gone`);
  assert.equal(ov.stats('page').frame_hidden, 0);
}

test('at 390 × 844, a box marker over a pane\'s svg sits inside its clip, and hides under a displayed frame', async () => {
  await atViewport(390, 844);
  assert.equal(draws.length, 1, 'drawn once, through the registry');
  assert.ok(draws[0].w > 0 && draws[0].h > 0, 'ctx.box at the draw is a real rect');
});

test('at 1,280 × 800, the same marker follows the wider svg, inside its clip, and hides under a displayed frame', async () => {
  await atViewport(1280, 800);
  assert.equal(draws.length, 1, 'no second draw for a resize');
});

// The stroke frame and the engine's stroke commit, chrome side (annotation
// engine tranche 4, plan 4F.1, U561; public/app/target-frame.js), in the real
// chrome (test-support/chrome-shell, booted once): the overlay's create-ctx
// seam is U516's own (registerCreateCtx), which main.js's initTargetFrame()
// plugs frameAt and stroke into. jsdom does no layout, so each target's box is
// stubbed on the element (getBoundingClientRect), as the resolver's
// targetFrame reads it.
//
// Pinned here:
//   - frameAt on a <path> inside an <svg> answers the svg's element record,
//     with ctx.anchors.targetFrame called ONCE (a spy) on the innermost node
//     and left/top taken from its frame; an <img>, a <canvas> and a
//     [data-fixed-aspect] div are accepted (kind 'target');
//   - the pane frame (tranche 5, 5A.1, U611; FRAME@pane-element A9 (c)): a
//     <p> takes kind 'pane', the element record of the pane's OUTERMOST
//     element on the path and its box, its stroke's points in [0, 1] of that
//     box; a fixed-aspect target inside a prose pane still wins; a press in a
//     nested shadow root takes the pane's outermost element; a button, a
//     label, an input, a select, a textarea, an option, a contenteditable
//     (not false), a nested component's button, a node slotted into one, an
//     iframe, a press inside an
//     iframe's document and one in a data-wc-chrome subtree are refused with
//     FRAME_HINT (REQ@hint-reflow's words), and begin() on them posts
//     nothing; for a type that does not declare 'page', a press on the
//     .mount-host itself (the pane's padding) is refused as a page press
//     {ok: false, page: true, hint: PAGE_KIND_HINT}; the derive input's
//     frame carries its kind;
//   - the page frame and REFRAME@commit (tranche 5, 5A.1, U612; REQ@ink-
//     scope-v2 (2), REQ@margins (a), FRAME@pane-element (c), REQ@arrow-
//     endpoints (a)), for a type whose listing row declares 'page': a
//     pen-down in #main's padding and one in the well's gutter take kind
//     'page' over the page box (the well's client box × #main's border box)
//     and post a page record (lib/core/strokes pageRecord's) whose item is
//     the item whose vertical span holds the pen-down y, from.x outside
//     [0, 1]; markdown A → markdown B and pane A → pane B post 'between'
//     records, every point in [0, 1] of the page box; block A → sibling block
//     B of one pane, and a block → the same pane's padding, post the pane's
//     'inside' record (never clamped to the first block); a 4 px overshoot
//     past an svg stays on the svg, clamped (REFRAME_SLOP_PX), 40 px into
//     prose is the pane's 'inside' record; no point outside [0, 1] after the
//     commit's clamp over each frame kind; one #main read per animation frame
//     per handle on the sample path, the well's only at begin and after a
//     resize, and at commit each item's rect at most once; a type declaring
//     only 'element' is refused in the margins with PAGE_KIND_HINT and its
//     strokes keep 627c5f53's clamp; a pane header (its title too), the
//     resize handles, a run's stacks button and head, a min chip, the run's
//     fixed hint, the page meta and a data-wc-chrome subtree are refused with
//     FRAME_HINT; strokesOn's page arm (a drawn #el-layer box marker → a
//     frozen {...row, box}; under a pane frame only boxes meeting its rect);
//     the arrow's derive input carries both endpoints' items; MARGIN@nearest-
//     item's ties (in x among spans, in y) go to the earlier item; a
//     data-wc-chrome subtree inside a markdown block is refused; no allocation
//     per sample on a page frame; each posted payload passes the element
//     log's plug-in check (the daemon's admission, U613);
//   - the real create ctx a strokes type's create receives carries frameAt and
//     stroke, and a pen-down → moves → pen-up through the overlay's one
//     pointer dispatch posts ONE element;
//   - points normalised against the rect (the four corners map to 0/1; a
//     sample outside the box is clamped to [0, 1] at commit); the rect read at most
//     once per animation frame (U561b: a fake frame — three pushes in one
//     frame read it once, the next frame's first push reads again, a
//     re-render, resize or scroll reads at once, and with no rAF every push
//     reads), never per sample; a predicted sample is never stored;
//     input.samples absent → the event itself;
//   - commit without a boolean shared is refused with its hint and sends
//     nothing; commit with shared:false sends exactly ONE POST /api/elements
//     whose payload holds only STROKE_KEYS ∪ DESCRIBE_KEYS, shared false, width
//     divided by the frame's width; a refused POST shows its hint; a preview
//     refuses begin() with READONLY_HINT and sends nothing; a handle commits
//     once; a cancelled handle sends nothing;
//   - registerStrokeDerive merges only DESCRIBE_KEYS (an extra key dropped); a
//     throwing deriver is logged and the stroke still commits; duplicate names
//     are refused;
//   - pushing 10,000 samples allocates O(log n) buffers (a counting wrapper
//     over Float64Array construction), reads no rect inside begin's frame, and
//     the per-sample path builds no array or object (a source pin);
//   - a stored stroke record re-resolves after its pane re-renders with the
//     svg moved one sibling down (strokesOn finds it on the moved svg); with
//     the svg removed it answers orphaned and, with no guess, orphans() lists
//     it;
//   - target-frame.js names no tool, colour or pack, and never edits the
//     overlay (it plugs in through registerCreateCtx).
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.join(__dirname, '..');
const TYPE = 'tf-strokes';

const PANE = {
  id: 'tf1', target: 'main', params: {}, gen: 0,
  html: '<div class="wrap">'
    + '<svg class="art" viewBox="0 0 200 100"><g><path class="line" d="M0 0 L10 10"/></g></svg>'
    + '<img class="pic" alt="a picture" width="100" height="50">'
    + '<canvas class="cv" width="100" height="50"></canvas>'
    + '<div class="sheet" data-fixed-aspect><span class="inside">a sheet</span></div>'
    + '<p class="prose">Some prose to never ink over.</p>'
    + '<button class="btn">Go</button>'
    + '<iframe class="fr"></iframe>'
    + '</div>',
};
// A prose pane (U611): every block under one outermost <section>, an
// <aside> beside it, a fixed-aspect target among the prose, the controls, a
// chrome subtree and a host for a nested shadow root.
const PROSE = {
  id: 'tf3', target: 'main', params: {}, gen: 0,
  html: '<section class="doc"><div class="col">'
    + '<p class="para">Words <em class="w">under</em> the stroke.</p>'
    + '<svg class="fig" viewBox="0 0 10 10"><rect class="r" width="5" height="5"/></svg>'
    + '<img class="im" alt="a picture" width="10" height="10">'
    + '<canvas class="cv3" width="10" height="10"></canvas>'
    + '<div class="fa" data-fixed-aspect><span class="fin">a sheet</span></div>'
    + '<label class="lab">A label <span class="lin">inside</span></label>'
    + '<input class="in" type="text"><select class="sel"><option class="opt">one</option></select>'
    + '<textarea class="ta"></textarea><div class="ce" contenteditable>editable</div>'
    + '<div class="cef" contenteditable="false">not editable</div>'
    + '<div class="chr" data-wc-chrome><span class="cin">a chrome strip</span></div>'
    + '<div class="nest"></div><div class="nest2"><span class="slotted">slotted into a button</span></div>'
    + '</div></section><aside class="side">a note beside</aside>',
};
// The page frame's fixture (U612): a titled markdown item, a run of two panes
// (A with two top-level blocks, an svg in the second; B with one) and a second
// markdown item, laid out by stubPage().
const PANE_A = { id: 'tfa', target: 'main', params: {}, gen: 0,
  html: '<p class="a1">First block of pane A.</p>'
    + '<div class="a2"><svg class="ch" viewBox="0 0 10 10"><rect class="cr" width="5" height="5"/></svg></div>' };
const PANE_B = { id: 'tfb', target: 'main', params: {}, gen: 0, html: '<p class="b1">Pane B\'s prose.</p>' };
const MD = [
  { id: 'md-a', text: '# Page title\n\nA framing line.', owner: 'claude', headings: [{ level: 1, text: 'Page title', slug: 'page-title' }] },
  { id: 'md-b', text: '## Part B\n\nMore prose.', owner: 'claude', headings: [{ level: 2, text: 'Part B', slug: 'part-b' }] },
];
const PAGE_TYPE = 'tf-page';   // its listing row declares 'page'
const EL_TYPE = 'tf-el';       // its listing row declares only 'element'
const MOVE_A = { id: 'tf2', target: 'main', params: {}, gen: 0,
  html: '<div class="box"><svg class="chart" viewBox="0 0 10 10"><rect width="5" height="5"/></svg><p>a caption under the chart</p></div>' };
const MOVE_B = '<div class="box"><p class="new">a line added above</p><svg class="chart" viewBox="0 0 10 10"><rect width="5" height="5"/></svg><p>a caption under the chart</p></div>';
const MOVE_C = '<div class="box"><p class="new">a line added above</p><p>a caption under the chart</p></div>';

let shell, W, M, ov, TF, ST, anchors, topbar, state, oh, IMOD;
let nextId = 1;
let postAnswer = null;   // a function (body) → a route answer, or null for the default
const posts = () => shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements');
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const q = (sel, id = 'tf1') => rootOf(id).querySelector(sel);
const note = (t) => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); if (n) n.textContent = t; };
const reaimText = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };

const RECTS = { svg: { left: 100, top: 200, width: 200, height: 100 } };
function boxed(el, r) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
  return el;
}
function stubRects() {
  boxed(q('svg.art'), RECTS.svg);
  boxed(q('img.pic'), { left: 10, top: 20, width: 100, height: 50 });
  boxed(q('canvas.cv'), { left: 10, top: 80, width: 100, height: 50 });
  boxed(q('div.sheet'), { left: 10, top: 140, width: 300, height: 400 });
  boxed(q('p.prose'), { left: 10, top: 560, width: 300, height: 20 });
  boxed(q('button.btn'), { left: 10, top: 590, width: 60, height: 20 });
  boxed(q('iframe.fr'), { left: 10, top: 620, width: 300, height: 150 });
  boxed(q('div.wrap'), { left: 10, top: 10, width: 400, height: 800 });
}
const DOC_BOX = { left: 500, top: 100, width: 400, height: 200 };
function stubProse() {
  boxed(q('section.doc', 'tf3'), DOC_BOX);
  boxed(q('aside.side', 'tf3'), { left: 500, top: 320, width: 400, height: 40 });
  for (const sel of ['svg.fig', 'img.im', 'canvas.cv3', 'div.fa']) boxed(q(sel, 'tf3'), { left: 520, top: 120, width: 40, height: 40 });
}
// The page box (U612): the well 1,600 px wide with a 16 px scrollbar
// (clientWidth 1,584), #main the 1,180 px column 2,000 px tall — so the page
// box is {left 0, top 50, w 1584, h 2000}.
const WELL_BOX = { left: 0, top: 50, width: 1600, height: 900 };
const MAIN_BOX = { left: 210, top: 50, width: 1180, height: 2000 };
const PAGE_BOX = { left: 0, top: 50, w: 1584, h: 2000 };
const ITEM_BOXES = {
  'md-a': { left: 238, top: 76, width: 1124, height: 40 },
  tfa: { left: 238, top: 140, width: 550, height: 300 },
  tfb: { left: 812, top: 140, width: 550, height: 300 },
  'md-b': { left: 238, top: 470, width: 1124, height: 40 },
};
const mainEl = () => W.document.getElementById('main');
const wellEl = () => mainEl().closest('.well-wrap');
const itemOf = (id) => M.itemEl(W.document, id).el;
function stubPage() {
  boxed(wellEl(), WELL_BOX);
  Object.defineProperty(wellEl(), 'clientWidth', { configurable: true, get: () => 1584 });
  Object.defineProperty(wellEl(), 'clientLeft', { configurable: true, get: () => 0 });
  boxed(mainEl(), MAIN_BOX);
  for (const [id, r] of Object.entries(ITEM_BOXES)) boxed(itemOf(id), r);
  boxed(q('p.a1', 'tfa'), { left: 250, top: 150, width: 526, height: 60 });
  boxed(q('div.a2', 'tfa'), { left: 250, top: 230, width: 526, height: 200 });
  boxed(q('svg.ch', 'tfa'), { left: 300, top: 250, width: 200, height: 100 });
  boxed(q('p.b1', 'tfb'), { left: 824, top: 150, width: 526, height: 60 });
}
// An event-like press: its composedPath() as a capture listener sees it.
function press(el, x, y, extra = {}) {
  const pathOf = [];
  for (let n = el; n; n = n.parentNode || n.host || null) { pathOf.push(n); if (n === W.document) break; }
  return { type: 'pointerdown', pointerId: 1, pointerType: 'pen', clientX: x, clientY: y, timeStamp: 1000, pressure: 0.5,
    target: el, composedPath: () => pathOf, ...extra };
}
const inputOf = (e, extra = {}) => ({ event: e, phase: e.type, kind: 'strokes', clientX: e.clientX, clientY: e.clientY,
  pointerType: e.pointerType, samples: [e], predicted: [], ...extra });
const sample = (x, y, t, p = 0.5) => ({ clientX: x, clientY: y, timeStamp: 1000 + t, pressure: p });

function elementsRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method !== 'POST') return { elements: [], next_cursor: 0 };
  const body = init && init.body ? JSON.parse(init.body) : {};
  if (postAnswer) return postAnswer(body);
  return { ok: true, element: { id: `p${nextId++}`, v: 1, type: body.type, ...body.payload, anchor: body.anchor } };
}

const BASE_TYPES = DEFAULT_ROUTES['/api/elements/types'];
const typeRow = (type, anchorKinds) => ({ type, name: type, schema: `${type}@1`, reads: [`${type}@1`], anchors: anchorKinds,
  family: 'markup', remote: { see: 'basic', send: 'basic' }, private: false, builtin: false, tier: 'local', pack: 'tf-pack', toolbar: {} });

before(async () => {
  shell = await bootShell({ routes: {
    '/api/elements': elementsRoute,
    '/api/elements/types': () => ({ ...BASE_TYPES, types: [...BASE_TYPES.types, typeRow(PAGE_TYPE, ['element', 'page']), typeRow(EL_TYPE, ['element'])] }),
  } });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  TF = await shell.importApp('target-frame.js');
  ST = await shell.importApp('strokes.js');
  anchors = (await shell.importApp('anchors.js')).default;
  topbar = await shell.importApp('topbar.js');
  oh = await shell.importApp('overlay-hidden.js');
  ({ view: state } = await shell.importApp('state.js'));
  const IM = await shell.importApp('input-mode.js');
  IM.setFingerDraws('off');
  IMOD = await shell.importApp('element-types.js');
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE, MOVE_A, PROSE, PANE_A, PANE_B], markdown: MD,
    order: ['tf1', 'tf2', 'tf3', 'md-a', 'tfa', 'tfb', 'md-b'] }));
  await shell.tick();
  await waitUntil(() => IMOD.typeOf(PAGE_TYPE) && IMOD.typeOf(EL_TYPE), { timeout: 3000, what: 'the listing' });
  stubRects();
  stubProse();
  stubPage();
  const nest = q('div.nest', 'tf3').attachShadow({ mode: 'open' });
  nest.innerHTML = '<p class="deep">a nested component\'s prose</p><button class="dbtn">Nested</button>';
  q('div.nest2', 'tf3').attachShadow({ mode: 'open' }).innerHTML = '<button class="sb"><slot></slot></button>';
  ov.registerType(TYPE, { input: 'strokes', place: 'box', draw() {} });
  ov.registerType(PAGE_TYPE, { input: 'strokes', place: 'box', draw() {} });
  ov.registerType(EL_TYPE, { input: 'strokes', place: 'box', draw() {} });
});
after(async () => {
  if (ov) { ov.setArmed(null); ov.setElements('live', []); }
  if (shell) await shell.restore();
});
beforeEach(() => {
  ov.setArmed(TYPE);
  postAnswer = null;
  shell.calls.length = 0;
  state.previewing = false;
});

// ── frameAt ───────────────────────────────────────────────────────────────

test('frameAt on a <path> inside an <svg>: the svg\'s element record, targetFrame called once on the innermost node, left/top from its frame', () => {
  const calls = [];
  const spy = Object.create(anchors);
  spy.targetFrame = (...a) => { calls.push(a); return anchors.targetFrame(...a); };
  const ctx = { anchors: spy, frameAt: TF.frameAt };
  const line = q('path.line');
  const f = ctx.frameAt(press(line, 150, 225));
  assert.equal(calls.length, 1, 'one call');
  assert.strictEqual(calls[0][0], rootOf('tf1'), 'the pane\'s content root');
  assert.strictEqual(calls[0][1], line, 'the innermost node on the path');
  assert.equal(calls[0][2].mount, 'tf1');
  assert.equal(f.ok, true);
  assert.strictEqual(f.target, q('svg.art'));
  assert.deepStrictEqual(f.record, anchors.record(rootOf('tf1'), q('svg.art'), { mount: 'tf1' }));
  assert.equal(f.record.kind, 'element');
  assert.deepStrictEqual(f.rect, { left: 100, top: 200, w: 200, h: 100 });
  assert.deepStrictEqual([f.w, f.h, f.aspect], [200, 100, 2]);
  // The create's input reads the same; detached, the chrome's own resolver.
  assert.strictEqual(TF.frameAt(inputOf(press(line, 150, 225))).target, q('svg.art'));
});

test('an <img>, a <canvas> and a [data-fixed-aspect] div are accepted', () => {
  for (const [sel, inner] of [['img.pic', 'img.pic'], ['canvas.cv', 'canvas.cv'], ['div.sheet', 'span.inside']]) {
    const f = TF.frameAt(press(q(inner), 50, 50));
    assert.equal(f.ok, true, sel);
    assert.strictEqual(f.target, q(sel), sel);
  }
});

test('a <p> takes the pane frame: the element record of its outermost block; a <button>, an <iframe> and a press inside an iframe\'s document are refused with FRAME_HINT; begin posts nothing', async () => {
  // The <p> (U611, FRAME@pane-element): the pane's outermost element on the
  // path, div.wrap, its record and its box.
  const p = TF.frameAt(press(q('p.prose'), 20, 565));
  assert.equal(p.ok, true, 'a press on prose takes the pane frame');
  assert.equal(p.kind, 'pane');
  assert.strictEqual(p.target, q('div.wrap'), 'the outermost element under the press');
  assert.deepStrictEqual(p.record, anchors.record(rootOf('tf1'), q('div.wrap'), { mount: 'tf1' }));
  assert.deepStrictEqual(p.rect, { left: 10, top: 10, w: 400, h: 800 });
  assert.deepStrictEqual([p.w, p.h, p.aspect, p.mount], [400, 800, 0.5, 'tf1']);
  assert.strictEqual(p.root, rootOf('tf1'));
  const fr = q('iframe.fr');
  const doc = fr.contentDocument || W.document.implementation.createHTMLDocument('framed');
  const inFrame = doc.body.appendChild(doc.createElement('div'));
  boxed(inFrame, { left: 0, top: 0, width: 50, height: 50 });
  inFrame.setAttribute('data-fixed-aspect', '');
  const cases = [['button', press(q('button.btn'), 20, 595)],
    ['over an iframe', press(fr, 20, 630)], ['inside an iframe', press(inFrame, 5, 5)]];
  for (const [what, e] of cases) {
    const f = TF.frameAt(e);
    assert.deepStrictEqual({ ...f }, { ok: false, hint: TF.FRAME_HINT }, what);
    assert.equal(TF.stroke.begin(inputOf(e)), null, `${what}: begin refuses`);
    assert.equal(reaimText(), TF.FRAME_HINT, `${what}: the hint is shown`);
  }
  // A markdown item and the chrome are no pane's content (the page frame is U612's).
  assert.equal(TF.frameAt(press(W.document.getElementById('main'), 1, 1)).ok, false);
  await shell.tick();
  assert.equal(posts().length, 0, 'nothing is posted');
  assert.equal(TF.FRAME_HINT, 'Ink draws anywhere on the page but on a control or the chrome; over text it may drift when the text re-wraps');
});

// ── the pane frame (U611) ─────────────────────────────────────────────────

test('a pen-down on a <p> in a prose pane: kind \'pane\', the outermost block\'s record and box, targetFrame called once; the stroke\'s points in [0, 1] of that box', async () => {
  const calls = [];
  const spy = Object.create(anchors);
  spy.targetFrame = (...a) => { calls.push(a); return anchors.targetFrame(...a); };
  const ctx = { anchors: spy, frameAt: TF.frameAt };
  for (const sel of ['p.para', 'em.w', 'div.cef']) {
    calls.length = 0;
    const f = ctx.frameAt(press(q(sel, 'tf3'), 600, 150));
    assert.equal(calls.length, 1, `${sel}: one targetFrame call`);
    assert.strictEqual(calls[0][1], q(sel, 'tf3'), `${sel}: the innermost node`);
    assert.equal(f.ok, true, sel);
    assert.equal(f.kind, 'pane', sel);
    assert.strictEqual(f.target, q('section.doc', 'tf3'), `${sel}: the pane's outermost element on the path`);
    assert.deepStrictEqual(f.record, anchors.record(rootOf('tf3'), q('section.doc', 'tf3'), { mount: 'tf3' }), sel);
    assert.equal(f.record.kind, 'element', `${sel}: no new anchor kind`);
    assert.deepStrictEqual(f.rect, { left: 500, top: 100, w: 400, h: 200 }, sel);
    assert.deepStrictEqual([f.w, f.h, f.aspect, f.mount], [400, 200, 2, 'tf3'], sel);
  }
  // The other outermost element, beside it: its own record.
  const side = TF.frameAt(press(q('aside.side', 'tf3'), 600, 330));
  assert.equal(side.kind, 'pane');
  assert.strictEqual(side.target, q('aside.side', 'tf3'));
  assert.equal(side.aspect, 10);

  const h = TF.stroke.begin(inputOf(press(q('p.para', 'tf3'), 500, 100)));
  assert.ok(h, 'a handle');
  assert.equal(h.frame.kind, 'pane');
  h.push([sample(700, 200, 4), sample(900, 300, 8), sample(950, 50, 12)]);
  const r = await h.commit({ tool: 'line', width: 8, colour: 'accent', shared: false });
  assert.equal(r.ok, true);
  assert.equal(posts().length, 1);
  const { body } = posts()[0];
  assert.deepStrictEqual(body.anchor, anchors.record(rootOf('tf3'), q('section.doc', 'tf3'), { mount: 'tf3' }));
  const xy = body.payload.points.filter((_, i) => i % 4 < 2);
  assert.ok(xy.every((v) => v >= 0 && v <= 1), `points in [0, 1] of the box: ${JSON.stringify(xy)}`);
  assert.deepStrictEqual(xy, [0, 0, 0.5, 0.5, 1, 1, 1, 0], 'against the block\'s box (the last sample clamped)');
  assert.equal(body.payload.width, 8 / 400, 'width ÷ the block\'s width');
  assert.equal(body.payload.aspect, 2);
});

test('a fixed-aspect target inside a prose pane still wins: kind \'target\' with its own element record', () => {
  for (const [sel, inner] of [['svg.fig', 'rect.r'], ['img.im', 'img.im'], ['canvas.cv3', 'canvas.cv3'], ['div.fa', 'span.fin']]) {
    const f = TF.frameAt(press(q(inner, 'tf3'), 530, 130));
    assert.equal(f.ok, true, sel);
    assert.equal(f.kind, 'target', sel);
    assert.strictEqual(f.target, q(sel, 'tf3'), sel);
    assert.deepStrictEqual(f.record, anchors.record(rootOf('tf3'), q(sel, 'tf3'), { mount: 'tf3' }), sel);
    assert.deepStrictEqual(f.rect, { left: 520, top: 120, w: 40, h: 40 }, sel);
  }
});

test('a control, the chrome and a nested component\'s button are refused with FRAME_HINT and post nothing', async () => {
  const deepBtn = q('div.nest', 'tf3').shadowRoot.querySelector('button.dbtn');
  const cases = [['button', q('button.btn')], ['label', q('label.lab', 'tf3')], ['inside a label', q('span.lin', 'tf3')],
    ['input', q('input.in', 'tf3')], ['select', q('select.sel', 'tf3')], ['option', q('option.opt', 'tf3')],
    ['textarea', q('textarea.ta', 'tf3')], ['contenteditable', q('div.ce', 'tf3')],
    ['a data-wc-chrome subtree', q('span.cin', 'tf3')], ['a nested component\'s button', deepBtn]];
  for (const [what, el] of cases) {
    const e = press(el, 600, 150);
    assert.deepStrictEqual({ ...TF.frameAt(e) }, { ok: false, hint: TF.FRAME_HINT }, what);
    note('');
    assert.equal(TF.stroke.begin(inputOf(e)), null, `${what}: begin refuses`);
    assert.equal(reaimText(), TF.FRAME_HINT, `${what}: the hint is shown`);
  }
  // A light-DOM node slotted into a nested component's <button>: the button
  // is on the composed path (never on the node's own ancestors).
  const n2 = q('div.nest2', 'tf3');
  const slotted = q('span.slotted', 'tf3');
  const sr = n2.shadowRoot;
  const tail = press(n2, 600, 150).composedPath();
  const e = { ...press(slotted, 600, 150), composedPath: () => [slotted, sr.querySelector('slot'), sr.querySelector('button.sb'), sr, ...tail] };
  assert.deepStrictEqual({ ...TF.frameAt(e) }, { ok: false, hint: TF.FRAME_HINT }, 'slotted into a button');
  await shell.tick();
  assert.equal(posts().length, 0, 'nothing is posted');
});

test('for a type that does not declare \'page\', a press on the .mount-host itself (the pane\'s padding) is a page press refused with PAGE_KIND_HINT, nothing posted', async () => {
  // U612 re-stated U611's placeholder: a type declaring 'page' takes the page
  // frame there (below); this one (no listing row) keeps 627c5f53's frames.
  const host = M.itemEl(W.document, 'tf3').el;
  assert.ok(host.classList.contains('mount-host'));
  const e = press(host, 495, 95);
  assert.deepStrictEqual({ ...TF.frameAt(e) }, { ok: false, page: true, hint: TF.PAGE_KIND_HINT });
  note('');
  assert.equal(TF.stroke.begin(inputOf(e)), null, 'begin refuses');
  assert.equal(reaimText(), TF.PAGE_KIND_HINT, 'the hint is shown');
  // A zero box on the outermost element: the same page press.
  const aside = q('aside.side', 'tf3');
  const own = aside.getBoundingClientRect;
  boxed(aside, { left: 0, top: 0, width: 0, height: 0 });
  try {
    assert.deepStrictEqual({ ...TF.frameAt(press(aside, 1, 1)) }, { ok: false, page: true, hint: TF.PAGE_KIND_HINT });
  } finally { aside.getBoundingClientRect = own; }
  await shell.tick();
  assert.equal(posts().length, 0, 'nothing is posted');
});

test('a press inside a nested shadow root takes the pane frame on the pane\'s outermost element; targetFrame reads the nested root\'s host', () => {
  const nest = q('div.nest', 'tf3');
  const deep = nest.shadowRoot.querySelector('p.deep');
  const calls = [];
  const spy = Object.create(anchors);
  spy.targetFrame = (...a) => { calls.push(a); return anchors.targetFrame(...a); };
  const f = TF.frameAt.call({ anchors: spy }, press(deep, 600, 150));
  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0][0], rootOf('tf3'), 'the pane\'s root');
  assert.strictEqual(calls[0][1], nest, 'the press\'s element in the pane root\'s own tree: the nested root\'s host');
  assert.equal(f.ok, true);
  assert.equal(f.kind, 'pane');
  assert.strictEqual(f.target, q('section.doc', 'tf3'));
  assert.deepStrictEqual(f.record, anchors.record(rootOf('tf3'), q('section.doc', 'tf3'), { mount: 'tf3' }));
});

test('the pane frame\'s aspect is w ÷ h to 4 decimals, as targetFrame rounds it', () => {
  const aside = q('aside.side', 'tf3');
  const own = aside.getBoundingClientRect;
  boxed(aside, { left: 500, top: 320, width: 300, height: 70 });
  try {
    const f = TF.frameAt(press(aside, 600, 330));
    assert.equal(f.kind, 'pane');
    assert.equal(f.aspect, 4.2857, '300 ÷ 70 rounded to 4 decimals');
  } finally { aside.getBoundingClientRect = own; }
});

test('the derive input\'s frame carries its kind: \'pane\' for prose, \'target\' for an svg', async () => {
  const seen = [];
  const off = TF.registerStrokeDerive('kind-probe', (a) => { seen.push([a.frame.kind, a.target]); return {}; });
  try {
    for (const el of [q('p.para', 'tf3'), q('path.line')]) {
      const h = TF.stroke.begin(inputOf(press(el, 600, 150)));
      h.push([sample(610, 160, 4)]);
      assert.equal((await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: true })).ok, true);
    }
  } finally { off(); }
  assert.deepStrictEqual(seen, [['pane', q('section.doc', 'tf3')], ['target', q('svg.art')]]);
});

// ── the create ctx, through the overlay's own dispatch ─────────────────────

test('the create ctx carries frameAt and stroke; a pen-down → moves → pen-up through the overlay posts ONE element', async () => {
  const seen = [];
  let h = null;
  const off = ov.registerType('tf-live', {
    input: 'strokes', draw() {},
    create(input, ctx) {
      seen.push(input.phase);
      if (input.phase === 'pointerdown') {
        assert.equal(typeof ctx.frameAt, 'function');
        assert.strictEqual(ctx.stroke, TF.stroke);
        assert.strictEqual(ctx.frameAt(input.event).target, q('svg.art'));
        h = ctx.stroke.begin(input);
      } else if (input.phase === 'pointermove') h && h.push(input);
      else if (input.phase === 'pointerup') h && h.commit({ tool: 'line', width: 4, colour: 'accent', shared: false });
      else if (input.phase === 'pointercancel') h && h.cancel();
    },
  });
  try {
    ov.setArmed('tf-live');
    const line = q('path.line');
    const pe = (type, x, y) => line.dispatchEvent(new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true,
      pointerType: 'mouse', pointerId: 7, isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1 }));
    pe('pointerdown', 150, 225);
    pe('pointermove', 200, 250);
    pe('pointermove', 250, 275);
    pe('pointerup', 250, 275);
    await waitUntil(() => posts().length === 1, { timeout: 3000, what: 'the post' });
    assert.deepStrictEqual(seen.slice(0, 4), ['pointerdown', 'pointermove', 'pointermove', 'pointerup']);
    const { body } = posts()[0];
    assert.equal(body.type, 'tf-live', 'the armed type');
    assert.deepStrictEqual(body.anchor, anchors.record(rootOf('tf1'), q('svg.art'), { mount: 'tf1' }));
    assert.deepStrictEqual(body.payload.points.filter((_, i) => i % 4 < 2), [0.25, 0.25, 0.5, 0.5, 0.75, 0.75]);
    await shell.tick();
    assert.equal(posts().length, 1, 'one element per pen-down to pen-up');
  } finally { off(); ov.setArmed(TYPE); }
});

// ── the points ────────────────────────────────────────────────────────────

test('points: the four corners map to 0/1, a sample outside the box is clamped, pressure and t as recorded', async () => {
  const h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
  assert.ok(h, 'a handle');
  assert.strictEqual(h.frame.target, q('svg.art'));
  h.push([sample(300, 200, 4, 0.9), sample(300, 300, 8, 0), sample(100, 300, 12.6, 1.4)]);
  h.push({ samples: [sample(50, 400, 16)], predicted: [] });
  assert.equal(h.count, 5);
  const r = await h.commit({ tool: 'line', width: 6, colour: 'accent', shared: false });
  assert.equal(r.ok, true);
  assert.deepStrictEqual(posts()[0].body.payload.points, [
    0, 0, 0.5, 0,
    1, 0, 0.9, 4,
    1, 1, 0.5, 8,       // a pressure of 0 is none reported
    0, 1, 1, 13,        // pressure capped at 1; t an integer
    0, 1, 0.5, 16,      // (50, 400) outside the box: clamped
  ]);
});

test('a predicted sample is never stored; input.samples absent → the event itself; a list is taken as handed', async () => {
  const h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
  const real = sample(200, 250, 4);
  const guess = sample(300, 300, 6);
  h.push({ samples: [real, guess], predicted: [guess] });   // a type that passed the whole input
  h.push({ samples: [], predicted: [sample(290, 290, 7)] });
  h.push({ event: sample(150, 225, 8) });                  // no coalesced samples: the event
  h.push({ ...sample(120, 210, 9), predicted: true });     // flagged predicted: skipped
  assert.equal(h.count, 3);
  await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: true });
  assert.deepStrictEqual(posts()[0].body.payload.points.filter((_, i) => i % 4 < 2), [0, 0, 0.5, 0.5, 0.25, 0.25]);
});

// ── the commit ────────────────────────────────────────────────────────────

test('commit without a boolean shared is refused with its hint and sends nothing', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
  for (const shared of [undefined, null, 'false', 0, 1]) {
    const h = TF.stroke.begin(inputOf(press(q('path.line'), 150, 225)));
    h.push([sample(160, 230, 4)]);
    const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared });
    assert.deepStrictEqual(r, { ok: false, hint: TF.SHARED_HINT }, String(shared));
    assert.equal(reaimText(), TF.SHARED_HINT);
  }
  const h = TF.stroke.begin(inputOf(press(q('path.line'), 150, 225)));
  assert.equal((await h.commit({ tool: 'line', width: 2, colour: 'accent' })).hint, TF.SHARED_HINT, 'omitted');
  assert.equal((await h.commit({ tool: '', width: 2, colour: 'accent', shared: false })).hint, TF.STYLE_HINT, 'a bad tool');
  assert.equal((await h.commit({ tool: 'x'.repeat(41), width: 2, colour: 'accent', shared: false })).hint, TF.STYLE_HINT);
  assert.equal((await h.commit({ tool: 'line', width: 0, colour: 'accent', shared: false })).hint, TF.STYLE_HINT, 'no width');
  await shell.tick();
  assert.equal(posts().length, 0);
  assert.ok(logged.length >= 6 && logged.every((l) => /PRIVATE@create/.test(l)), 'each refusal is logged for the type\'s author');
});

test('commit with shared:false: exactly ONE POST /api/elements, payload keys within STROKE_KEYS ∪ DESCRIBE_KEYS, width ÷ the frame\'s width', async () => {
  const h = TF.stroke.begin(inputOf(press(q('path.line'), 150, 225)));
  h.push([sample(160, 230, 4), sample(170, 235, 8)]);
  const r = await h.commit({ tool: 'line', width: 6, colour: 'accent', shared: false });
  assert.equal(r.ok, true);
  assert.equal(r.element.id, `p${nextId - 1}`);
  assert.equal(posts().length, 1);
  const { body } = posts()[0];
  assert.deepStrictEqual(Object.keys(body).sort(), ['anchor', 'device', 'payload', 'type'], 'the device claim rides the body');
  assert.equal(body.type, TYPE);
  assert.equal(body.anchor.kind, 'element');
  const allowed = new Set([...ST.STROKE_KEYS, ...ST.DESCRIBE_KEYS]);
  for (const k of Object.keys(body.payload)) assert.ok(allowed.has(k), `payload key ${k}`);
  // U562's describe deriver (main.js initInkDescribe) adds the stroke's own bbox.
  assert.deepStrictEqual(Object.keys(body.payload).sort(), ['aspect', 'bbox', 'colour', 'points', 'shared', 'stride', 'tool', 'width']);
  assert.strictEqual(body.payload.shared, false, 'as the type passed it');
  assert.equal(body.payload.width, 6 / 200);
  assert.equal(body.payload.stride, 4);
  assert.equal(body.payload.aspect, 2);
  assert.ok(ST.isStrokePayload(body.payload));
  // A handle commits once.
  assert.deepStrictEqual(await h.commit({ tool: 'line', width: 6, colour: 'accent', shared: false }), { ok: false, hint: TF.SPENT_HINT });
  // A cancelled one never.
  const c = TF.stroke.begin(inputOf(press(q('path.line'), 150, 225)));
  c.push([sample(160, 230, 4)]);
  c.cancel();
  assert.equal((await c.commit({ tool: 'line', width: 6, colour: 'accent', shared: false })).ok, false);
  assert.equal(posts().length, 1);
});

test('a refused POST shows its hint', async () => {
  postAnswer = () => respond({ error: 'stray key', hint: 'The type\'s element.json payload does not name points.' }, { status: 400 });
  const h = TF.stroke.begin(inputOf(press(q('path.line'), 150, 225)));
  const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
  assert.deepStrictEqual(r, { ok: false, hint: 'The type\'s element.json payload does not name points.' });
  assert.equal(reaimText(), r.hint);
  assert.equal(posts().length, 1);
});

test('a preview refuses begin() with READONLY_HINT and sends nothing; one begun before a preview is refused at its commit', async () => {
  const before = TF.stroke.begin(inputOf(press(q('path.line'), 150, 225)));
  state.previewing = true;
  try {
    assert.equal(TF.stroke.begin(inputOf(press(q('path.line'), 150, 225))), null);
    assert.equal(reaimText(), topbar.READONLY_HINT);
    const r = await before.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
    assert.deepStrictEqual(r, { ok: false, hint: topbar.READONLY_HINT });
    await shell.tick();
    assert.equal(posts().length, 0);
  } finally { state.previewing = false; }
});

// ── derivers ──────────────────────────────────────────────────────────────

test('registerStrokeDerive merges only DESCRIBE_KEYS; a throwing deriver is logged and the stroke still commits; names are unique', async () => {
  const args = [];
  // 'describe' is U562's, registered at boot (main.js initInkDescribe): a
  // probe of its own name, run after it, so its keys win the merge.
  const off1 = TF.registerStrokeDerive('probe', (a) => { args.push(a); return { text_under: 'under', bbox: [0, 0, 1, 1], extra: 'dropped', tool: 'not yours' }; });
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  const off2 = TF.registerStrokeDerive('boom', () => { throw new Error('the deriver broke'); });
  try {
    assert.throws(() => TF.registerStrokeDerive('probe', () => ({})), /already registered/);
    assert.throws(() => TF.registerStrokeDerive('', () => ({})), TypeError);
    assert.throws(() => TF.registerStrokeDerive('x', 'nope'), TypeError);
    const h = TF.stroke.begin(inputOf(press(q('path.line'), 150, 225)));
    h.push([sample(250, 275, 4)]);
    const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: true });
    assert.equal(r.ok, true, 'the stroke commits');
    const { payload } = posts()[0].body;
    assert.equal(payload.text_under, 'under');
    assert.deepStrictEqual(payload.bbox, [0, 0, 1, 1]);
    assert.equal('extra' in payload, false, 'an extra key is dropped');
    assert.equal(payload.tool, 'line', 'a deriver never overrides a stroke key');
    assert.ok(errors.some((e) => /'boom' deriver failed/.test(e)), 'the throw is logged');
    assert.equal(args.length, 1);
    assert.strictEqual(args[0].target, q('svg.art'));
    assert.deepStrictEqual(args[0].bbox, [0.25, 0.25, 0.5, 0.5]);
    assert.deepStrictEqual(args[0].points, payload.points);
  } finally { console.error = realError; off1(); off2(); }
  // Unregistered, the name is free again.
  TF.registerStrokeDerive('probe', () => ({}))();
});

// ── no allocation per sample ──────────────────────────────────────────────

test('pushing 10,000 samples performs O(log n) buffer growths and reads no rect inside begin\'s frame', async () => {
  const Real = globalThis.Float64Array;
  let made = 0;
  const svg = q('svg.art');
  const ownRect = svg.getBoundingClientRect;
  let reads = 0;
  svg.getBoundingClientRect = function () { reads++; return ownRect.call(this); };
  const samples = [];
  for (let i = 0; i < 10000; i++) samples.push(sample(100 + (i % 200), 200 + (i % 100), i));
  globalThis.Float64Array = new Proxy(Real, { construct(t, a, nt) { made++; return Reflect.construct(t, a, nt); } });
  let h;
  try {
    h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
    reads = 0;
    for (let i = 0; i < samples.length; i += 4) h.push(samples.slice(i, i + 4));
  } finally { globalThis.Float64Array = Real; svg.getBoundingClientRect = ownRect; }
  assert.equal(h.count, 10001);
  const bound = Math.ceil(Math.log2((10001 * 4) / TF.BUFFER_START)) + 1;
  assert.ok(made <= bound, `${made} buffers ≤ ${bound} (the first and each doubling)`);
  // U561b: the 2,500 pushes all land in begin's frame (no frame boundary in a
  // synchronous loop), so none reads; before U561b each read (2,500).
  assert.equal(reads, 0, 'no rect read inside the frame begin read in');
  const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
  assert.equal(r.ok, true);
  assert.ok(posts()[0].body.payload.points.length / 4 <= ST.STROKE_POINTS_MAX, 'decimated to the bound');
  // No array per sample: the per-sample path (take, and push's sample loop)
  // builds no array, object or typed array — the counting wrapper above sees
  // only Float64Array, so the source holds the rest.
  const src = fs.readFileSync(path.join(REPO, 'public/app/target-frame.js'), 'utf8');
  const take = /\n  function take\(s\) \{\n([\s\S]*?)\n  \}\n/.exec(src);
  assert.ok(take, 'take(s) found');
  const loop = /\n    for \(let i = 0; i < list\.length; i\+\+\) \{\n([\s\S]*?)\n    \}\n/.exec(src);
  assert.ok(loop, 'push\'s sample loop found');
  for (const [what, body] of [['take', take[1].replace(/^.*grow\(\);$/m, '')], ['the sample loop', loop[1]]]) {
    assert.doesNotMatch(body, /\bnew\b|\[[^\]]*,|\{\s*\w+\s*[:,}]|\.\.\.|\b(slice|map|concat|filter|from|of)\(|\bArray\b/,
      `${what} allocates nothing per sample`);
  }
});

test('the handle holds ONE rect: two pushes with a re-render between them write the new box into the same object (GT-22, U561a)', async () => {
  const h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
  const held = h.rect;
  assert.deepStrictEqual({ ...held }, { left: 100, top: 200, w: 200, h: 100 }, 'seeded from the frame');
  assert.notStrictEqual(held, h.frame.rect, 'frame.rect stays the begin-time box');
  h.push([sample(200, 250, 4)]);
  assert.strictEqual(h.rect, held, 'the first push wrote in place');
  const target = h.frame.target;
  // Re-rendered between the pushes; the handle's target laid out anew.
  await shell.frame({ type: 'render', id: 'tf1', target: 'main', html: PANE.html, params: {}, gen: 1 });
  await shell.tick();
  stubRects();
  boxed(target, { left: 300, top: 400, width: 400, height: 200 });
  h.push([sample(700, 600, 8)]);
  assert.strictEqual(h.rect, held, 'the same object after a re-render');
  assert.deepStrictEqual({ ...held }, { left: 300, top: 400, w: 400, h: 200 }, 'its values are the new box\'s');
  // A zero-size box leaves the previous rect in place, as before. A frame
  // boundary first (U561b): inside the frame the last push read in, the push
  // would not read at all, and the guard would go untested.
  await shell.tick();
  boxed(target, { left: 0, top: 0, width: 0, height: 0 });
  h.push([sample(500, 500, 12)]);
  assert.strictEqual(h.rect, held);
  assert.deepStrictEqual({ ...held }, { left: 300, top: 400, w: 400, h: 200 }, 'a zero-size box keeps the last rect');
  assert.deepStrictEqual({ ...h.frame.rect }, { left: 100, top: 200, w: 200, h: 100 }, 'frame.rect untouched');
  const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
  assert.equal(r.ok, true);
  const pts = posts()[0].body.payload.points;
  assert.deepStrictEqual([pts[pts.length - 8], pts[pts.length - 7]], [1, 1], 'the second push against the new box');
  assert.deepStrictEqual([pts[pts.length - 4], pts[pts.length - 3]], [0.5, 0.5], 'the third against the kept one');
  // The source: readRect writes the held rect's fields and builds no object.
  const src = fs.readFileSync(path.join(REPO, 'public/app/target-frame.js'), 'utf8');
  const rr = /\n  function readRect\(\) \{\n([\s\S]*?)\n  \}\n/.exec(src);
  assert.ok(rr, 'readRect found');
  assert.doesNotMatch(rr[1], /rect\s*=\s*\{/, 'no rect object per push');
  assert.match(rr[1], /rect\.left = b\.left; rect\.top = b\.top; rect\.w = b\.width; rect\.h = b\.height;/);
});

// ── the rect at most once per frame (U561b) ───────────────────────────────

// A fake frame scheduler: callbacks held until flush() runs them, as one frame.
function fakeFrames() {
  const queue = [];
  const raf = (fn) => { queue.push(fn); return queue.length; };
  raf.calls = () => queue.length;
  const flush = () => { const run = queue.splice(0); for (const fn of run) fn(0); };
  return { raf, flush, queue };
}
// Count the svg's getBoundingClientRect calls over the box the test sets.
function countedSvg(box) {
  const svg = q('svg.art');
  const own = svg.getBoundingClientRect;
  const c = { reads: 0, box: { ...box } };
  svg.getBoundingClientRect = function () {
    c.reads++;
    const r = c.box;
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
  };
  c.restore = () => { svg.getBoundingClientRect = own; };
  return c;
}

test('three pushes inside one frame read the rect ONCE; the next frame\'s first push reads again; one frame callback per frame (U561b)', async () => {
  const F = fakeFrames();
  TF.initTargetFrame({ raf: F.raf });
  const c = countedSvg(RECTS.svg);
  try {
    const h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
    // The press: the resolver's targetFrame walk reads the box once, and
    // begin's own push (the pointerdown's samples) once.
    assert.equal(c.reads, 2, 'the walk and begin\'s own push');
    c.reads = 0;
    assert.equal(F.queue.length, 1, 'one frame asked for');
    F.flush();
    h.push([sample(150, 225, 4)]);
    h.push({ samples: [sample(200, 250, 8)], predicted: [] });
    h.push({ event: sample(250, 275, 12) });
    assert.equal(c.reads, 1, 'three pushes in one frame: one read');
    assert.equal(F.queue.length, 1, 'one held callback for the frame, never one per push');
    F.flush();
    h.push([sample(260, 280, 16)]);
    assert.equal(c.reads, 2, 'the next frame\'s first push reads again');
    h.push([sample(270, 285, 20)]);
    h.push([sample(280, 290, 24)]);
    assert.equal(c.reads, 2, 'and only the first');
    assert.equal(h.count, 7);
    h.cancel();
    F.flush();   // the pending callback after a cancel: harmless
    assert.equal(F.queue.length, 0, 'nothing re-asked after the cancel');
  } finally { c.restore(); TF.initTargetFrame({ raf: null }); }
});

test('a sample takes the rect the frame\'s read took: the begin-time box until the next frame\'s read (U561b)', async () => {
  const F = fakeFrames();
  TF.initTargetFrame({ raf: F.raf });
  const c = countedSvg(RECTS.svg);
  try {
    const h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
    // Laid out anew with no re-render, resize or scroll the chrome hears: the
    // frame's read stands until the frame ends.
    c.box = { left: 300, top: 400, width: 400, height: 200 };
    h.push([sample(300, 300, 4)]);
    assert.deepStrictEqual({ ...h.rect }, { left: 100, top: 200, w: 200, h: 100 }, 'the begin-time box inside its frame');
    F.flush();
    h.push([sample(700, 600, 8)]);
    assert.deepStrictEqual({ ...h.rect }, { left: 300, top: 400, w: 400, h: 200 }, 'the next frame\'s read');
    const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
    assert.equal(r.ok, true);
    const pts = posts()[0].body.payload.points;
    assert.deepStrictEqual(pts.filter((_, i) => i % 4 < 2), [0, 0, 1, 1, 1, 1],
      'begin\'s sample and the same-frame push against the begin-time box, the next frame\'s against the new one');
    assert.equal(F.queue.length, 1, 'the last push\'s frame, never one of the commit\'s');
    F.flush();   // after the commit: harmless
  } finally { c.restore(); TF.initTargetFrame({ raf: null }); }
});

test('the re-render follow reads at once, whatever the frame: a settle, a resize and a scroll (U561b)', async () => {
  const F = fakeFrames();
  TF.initTargetFrame({ raf: F.raf });
  const c = countedSvg(RECTS.svg);
  try {
    const h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
    c.reads = 0;   // the press's walk and begin's push
    c.box = { left: 300, top: 400, width: 400, height: 200 };
    W.__wcMount.settle(rootOf('tf1'), 'tf1', 'mount');   // the pane re-rendered
    h.push([sample(700, 600, 4)]);
    assert.equal(c.reads, 1, 'a settle: read at once, inside the same frame');
    assert.deepStrictEqual({ ...h.rect }, { left: 300, top: 400, w: 400, h: 200 });
    h.push([sample(700, 600, 6)]);
    assert.equal(c.reads, 1, 'then held again for the frame');
    W.dispatchEvent(new W.Event('resize'));
    h.push([sample(700, 600, 8)]);
    assert.equal(c.reads, 2, 'a resize: read at once');
    W.document.dispatchEvent(new W.Event('scroll'));
    h.push([sample(700, 600, 10)]);
    assert.equal(c.reads, 3, 'a scroll: read at once');
    h.push([sample(700, 600, 12)]);
    assert.equal(c.reads, 3);
    assert.equal(F.queue.length, 1, 'still one frame asked for');
    h.cancel();
    F.flush();
  } finally { c.restore(); TF.initTargetFrame({ raf: null }); }
});

test('with no frame scheduler (an export, a jsdom without rAF) every push reads the rect, as before (U561b)', async () => {
  TF.initTargetFrame({ raf: null });
  const ownRaf = W.requestAnimationFrame;
  W.requestAnimationFrame = undefined;
  const c = countedSvg(RECTS.svg);
  try {
    const h = TF.stroke.begin(inputOf(press(q('path.line'), 100, 200)));
    c.reads = 0;   // the press's walk and begin's push
    h.push([sample(150, 225, 4)]);
    h.push({ event: sample(200, 250, 8) });
    h.push([sample(160, 230, 10)]);
    assert.equal(c.reads, 3, 'three pushes, three reads');
    c.box = { left: 300, top: 400, width: 400, height: 200 };
    h.push([sample(700, 600, 12)]);
    assert.equal(c.reads, 4);
    assert.deepStrictEqual({ ...h.rect }, { left: 300, top: 400, w: 400, h: 200 }, 'the new box at the very next push');
    h.cancel();
  } finally { c.restore(); W.requestAnimationFrame = ownRaf; }
  assert.throws(() => TF.initTargetFrame({ raf: 'soon' }), /raf must be a function/);
});

// ── re-anchoring ──────────────────────────────────────────────────────────

test('a stored stroke re-resolves after its pane re-renders with the svg moved one sibling down; with the svg removed it is orphaned and listed', async () => {
  const geo = { left: 400, top: 100, width: 100, height: 100 };
  boxed(q('svg.chart', 'tf2'), geo);
  // The overlay's own reads: a stubbed box where the test gave one, else a
  // whole-page box (nothing reads as collapsed or hidden).
  const WHOLE = { left: 0, top: 0, width: 1000, height: 3000, x: 0, y: 0, right: 1000, bottom: 3000 };
  ov.initOverlay({ rectOf: (x) => (x && Object.prototype.hasOwnProperty.call(x, 'getBoundingClientRect') ? x.getBoundingClientRect() : WHOLE) });
  const h = TF.stroke.begin(inputOf(press(q('rect', 'tf2'), 425, 125)));
  h.push([sample(475, 175, 8)]);
  const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: true });
  assert.equal(r.ok, true);
  const rec = { id: r.element.id, v: 1, type: TYPE, anchor: r.element.anchor, shared: true, replies: 0 };
  ov.setElements('live', [rec]);
  const first = TF.frameAt(press(q('rect', 'tf2'), 425, 125));
  assert.deepStrictEqual(TF.stroke.strokesOn(first, { type: TYPE }).map((x) => x.id), [rec.id]);
  assert.deepStrictEqual(TF.stroke.strokesOn(first, { type: 'another' }), [], 'of that type only');

  // Re-rendered: a line added above, the svg one sibling down.
  await shell.frame({ type: 'render', id: 'tf2', target: 'main', html: MOVE_B, params: {}, gen: 1 });
  await shell.tick();
  const moved = boxed(q('svg.chart', 'tf2'), geo);
  const ans = anchors.resolve(rootOf('tf2'), rec.anchor);
  assert.ok(['exact', 're-resolved'].includes(ans.state), ans.state);
  assert.strictEqual(ans.el, moved);
  const again = TF.frameAt(press(q('rect', 'tf2'), 425, 125));
  assert.strictEqual(again.target, moved);
  assert.equal(ST.sameTarget(again.record, rec.anchor), false, 'the target moved in the tree');
  assert.deepStrictEqual(TF.stroke.strokesOn(again, { type: TYPE }).map((x) => x.id), [rec.id], 'strokesOn finds it there');
  assert.deepStrictEqual(TF.stroke.strokesOn(TF.frameAt(press(q('path.line'), 150, 225)), { type: TYPE }), [], 'never on another target');

  // Removed: orphaned, no guess, listed by orphans().
  await shell.frame({ type: 'render', id: 'tf2', target: 'main', html: MOVE_C, params: {}, gen: 2 });
  await shell.tick();
  assert.equal(anchors.resolve(rootOf('tf2'), rec.anchor).state, 'orphaned');
  await new Promise((res) => setTimeout(res, oh.MOUNT_GRACE_MS + 60));
  ov.requestDraw();
  await waitUntil(() => ov.orphans().some((o) => o.id === rec.id), { timeout: 4000, what: 'the stroke listed as an orphan' });
  const o = ov.orphans().find((x) => x.id === rec.id);
  assert.equal(o.guess, false);
  assert.equal(o.mount, 'tf2');
});

// ── the source ────────────────────────────────────────────────────────────

test('target-frame.js plugs in through registerCreateCtx, names no tool, colour or pack, and main.js wires it once', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/target-frame.js'), 'utf8');
  // The one exception is FRAME_HINT, the user-facing sentence the brief wrote.
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^export const FRAME_HINT = /.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(ink|pen|pencil|highlighter|eraser)\b/i);
  assert.match(code, /registerCreateCtx\('frameAt', frameAt\)/);
  assert.match(code, /registerCreateCtx\('stroke', stroke\)/);
  assert.doesNotMatch(code, /\bfetch\(/, 'every request through http.js');
  const strokes = fs.readFileSync(path.join(REPO, 'lib/core/strokes.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(strokes, /\b(ink|pen|pencil|highlighter|eraser)\b/i);
  const main = fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8');
  assert.match(main, /^import \{ initTargetFrame \} from '\.\/target-frame\.js';/m);
  assert.equal((main.match(/^initTargetFrame\(\);/gm) || []).length, 1);
  assert.ok(main.indexOf('initTargetFrame();') > main.indexOf('initBoxGrab();'), 'after the box grab');
  TF.initTargetFrame();   // idempotent: a second call registers nothing (a duplicate would throw)
});

// ── the page frame and REFRAME@commit (U612) ──────────────────────────────

const { registerSchema } = require('../lib/core/element-log');
let logRow = null;
// The daemon's admission of a plug-in row's version (U613's hunk of
// lib/core/element-log checkPluginPayload): it throws on a refused anchor.
function admitted(body) {
  if (!logRow) {
    logRow = registerSchema(`${PAGE_TYPE}@1`, { type: PAGE_TYPE,
      keys: ['anchor', 'shared', ...ST.STROKE_KEYS.filter((k) => k !== 'anchor' && k !== 'shared'), ...ST.DESCRIBE_KEYS] });
  }
  logRow.check({ ...body.payload, anchor: body.anchor });
  return true;
}
const xyOf = (pts) => pts.filter((_, i) => i % 4 < 2);
const inUnit = (pts) => xyOf(pts).every((v) => v >= 0 && v <= 1);
// One stroke through begin → push → commit, the armed type's: the posted body.
async function strokeOf(el, at, moves, { type = PAGE_TYPE, width = 4 } = {}) {
  ov.setArmed(type);
  shell.calls.length = 0;
  const h = TF.stroke.begin(inputOf(press(el, at[0], at[1])));
  assert.ok(h, 'a handle');
  h.push(moves.map(([x, y], i) => sample(x, y, 4 * (i + 1))));
  const r = await h.commit({ tool: 'line', width, colour: 'accent', shared: false });
  assert.equal(r.ok, true, r.hint);
  assert.equal(posts().length, 1, 'one POST');
  return { h, body: posts()[0].body };
}
const endOf = (item, x, y, r = ITEM_BOXES[item]) => ({ item, x: (x - r.left) / r.width, y: (y - r.top) / r.height });
function assertEnd(got, want, what) {
  assert.equal(got.item, want.item, `${what}: item`);
  assert.ok(Math.abs(got.x - want.x) < 2e-4 && Math.abs(got.y - want.y) < 2e-4, `${what}: ${JSON.stringify(got)} ≈ ${JSON.stringify(want)}`);
}

test('a pen-down in #main\'s padding and one in the well\'s gutter take the page frame and post a page record on the item whose vertical span holds the pen-down y, from.x outside [0, 1]', async () => {
  ov.setArmed(PAGE_TYPE);
  const f = TF.frameAt(press(wellEl(), 100, 300));
  assert.equal(f.ok, true, 'a gutter press is not refused (U611\'s pen-down refusal)');
  assert.equal(f.kind, 'page');
  assert.strictEqual(f.target, mainEl());
  assert.deepStrictEqual(f.rect, PAGE_BOX, 'x over the well\'s client box, y over #main\'s border box');
  assert.deepStrictEqual([f.w, f.h, f.aspect], [1584, 2000, 0.792]);
  assert.deepStrictEqual(f.down, { item: null, kind: null });
  const m = TF.frameAt(press(mainEl(), 220, 90));
  assert.equal(m.kind, 'page', '#main\'s padding');

  // #main's padding beside md-a (y 90 in md-a's span 76–116).
  const pad = await strokeOf(mainEl(), [220, 90], [[224, 100], [226, 104]]);
  const a = pad.body.anchor;
  assert.ok(ST.isPageRecord(a), JSON.stringify(a));
  assert.equal(a.item, 'md-a');
  assert.equal(ST.pageShape(a), 'beside');
  assertEnd(a.from, endOf('md-a', 220, 90), 'from');
  assert.ok(a.from.x < 0, `from.x outside [0, 1]: ${a.from.x}`);
  assert.deepStrictEqual([a.from.w, a.from.h], [1124, 40], 'the item\'s box in px');
  assert.deepStrictEqual(a.frame, { w: 1584, h: 2000 }, 'the page box at commit');
  assert.ok(inUnit(pad.body.payload.points));
  assert.equal(pad.body.payload.width, 4 / 1584, 'px ÷ the page box\'s w');
  assert.equal(pad.body.payload.aspect, 0.792, 'the page box\'s w ÷ h');
  assert.ok(admitted(pad.body));

  // The gutter beside the run (y 300: tfa's and tfb's span; tfa nearer in x).
  const gut = await strokeOf(wellEl(), [100, 300], [[120, 320], [130, 360]]);
  const g = gut.body.anchor;
  assert.equal(g.item, 'tfa');
  assertEnd(g.from, endOf('tfa', 100, 300), 'from');
  assert.ok(g.from.x < 0, `from.x outside [0, 1]: ${g.from.x}`);
  assert.equal(ST.pageShape(g), 'beside');
  assert.ok(admitted(gut.body));
});

test('a stroke from markdown item A ending over markdown item B posts a page record from A to B', async () => {
  const para = itemOf('md-a').querySelector('p');
  ov.setArmed(PAGE_TYPE);
  const f = TF.frameAt(press(para, 300, 100));
  assert.equal(f.kind, 'page');
  assert.deepStrictEqual(f.down, { item: 'md-a', kind: 'md' });
  const { body } = await strokeOf(para, [300, 100], [[310, 300], [320, 490]]);
  const a = body.anchor;
  assert.equal(ST.pageShape(a), 'between');
  assertEnd(a.from, endOf('md-a', 300, 100), 'from');
  assertEnd(a.to, endOf('md-b', 320, 490), 'to');
  assert.equal(ST.pageLabel(a), 'from md-a to md-b');
  assert.ok(inUnit(body.payload.points));
  assert.ok(admitted(body));
});

test('a stroke from pane A\'s paragraph ending over pane B is re-framed at commit: item = from.item = A, to.item = B, every point in [0, 1] of the page box', async () => {
  ov.setArmed(PAGE_TYPE);
  const f = TF.frameAt(press(q('p.a1', 'tfa'), 300, 170));
  assert.equal(f.kind, 'pane', 'the pen-down frame is the pane\'s block');
  const { h, body } = await strokeOf(q('p.a1', 'tfa'), [300, 170], [[600, 175], [900, 180]]);
  assert.equal(h.frame.kind, 'pane', 'the handle keeps its pen-down frame');
  const a = body.anchor;
  assert.equal(a.item, 'tfa');
  assert.equal(a.from.item, 'tfa');
  assert.equal(a.to.item, 'tfb');
  assertEnd(a.from, endOf('tfa', 300, 170), 'from');
  assertEnd(a.to, endOf('tfb', 900, 180), 'to');
  assert.ok(inUnit(body.payload.points), JSON.stringify(xyOf(body.payload.points)));
  // The points are page units: the first sample at (300, 170) in client px.
  const [x0, y0] = body.payload.points;
  assert.ok(Math.abs(x0 - 300 / 1584) < 1e-4 && Math.abs(y0 - 120 / 2000) < 1e-4, `${x0}, ${y0}`);
  assert.equal(body.payload.width, 4 / 1584);
  assert.ok(admitted(body));
});

test('a stroke from block A to sibling block B of one pane posts that pane\'s \'inside\' record, no sample clamped to block A\'s box; one ending in the pane\'s padding the same', async () => {
  for (const [what, end] of [['to block B', [300, 300]], ['to the pane\'s padding', [245, 435]]]) {
    const { body } = await strokeOf(q('p.a1', 'tfa'), [300, 170], [[300, 240], end]);
    const a = body.anchor;
    assert.equal(ST.pageShape(a), 'inside', what);
    assert.deepStrictEqual([a.item, a.from.item, a.to.item], ['tfa', 'tfa', 'tfa'], what);
    assertEnd(a.from, endOf('tfa', 300, 170), `${what}: from`);
    assertEnd(a.to, endOf('tfa', end[0], end[1]), `${what}: to`);
    // Block A's box ends at y 210: the last sample (y > 290) is never cut to it.
    const pts = body.payload.points;
    const lastY = 50 + pts[pts.length - 3] * 2000;
    assert.ok(Math.abs(lastY - end[1]) < 0.5, `${what}: the last sample kept at y ${lastY}`);
    assert.deepStrictEqual([a.from.w, a.from.h], [550, 300], `${what}: the pane's host box`);
    assert.ok(admitted(body));
  }
});

test('REFRAME_SLOP_PX: a stroke on an svg overshooting its edge by 4 px keeps the svg\'s element record, clamped; one leaving it by 40 px into prose is the pane\'s \'inside\' record', async () => {
  assert.equal(TF.REFRAME_SLOP_PX, 8);
  const svg = q('svg.ch', 'tfa');
  const over = await strokeOf(q('rect.cr', 'tfa'), [310, 260], [[400, 300], [504, 300]]);
  assert.deepStrictEqual(over.body.anchor, anchors.record(rootOf('tfa'), svg, { mount: 'tfa' }), 'the svg\'s element record');
  assert.deepStrictEqual(xyOf(over.body.payload.points), [0.05, 0.1, 0.5, 0.5, 1, 0.5], 'clamped to the svg');
  assert.equal(over.body.payload.width, 4 / 200, 'width ÷ the svg\'s width');
  const out = await strokeOf(q('rect.cr', 'tfa'), [310, 260], [[400, 300], [400, 390]]);
  assert.equal(ST.pageShape(out.body.anchor), 'inside');
  assert.equal(out.body.anchor.item, 'tfa');
  assertEnd(out.body.anchor.to, endOf('tfa', 400, 390), 'to');
});

test('no point outside [0, 1] after the commit\'s clamp, over each frame kind', async () => {
  const cases = [
    ['target (an svg)', q('rect.cr', 'tfa'), [310, 260], [[503, 352], [295, 246]], 'element'],
    ['pane (a block)', q('p.a1', 'tfa'), [300, 170], [[780, 214], [246, 147]], 'element'],
    ['page (the gutter)', wellEl(), [100, 300], [[-40, 20], [1700, 400]], 'page'],
    ['widened (pane A → pane B)', q('p.a1', 'tfa'), [300, 170], [[900, 180]], 'page'],
  ];
  for (const [what, el, at, moves, kind] of cases) {
    const { body } = await strokeOf(el, at, moves);
    assert.equal(body.anchor.kind, kind, what);
    assert.equal(xyOf(body.payload.points).filter((v) => v < 0 || v > 1).length, 0, `${what}: ${JSON.stringify(xyOf(body.payload.points))}`);
  }
  // An endpoint past PAGE_END_MAX item-units from its nearest item (the page
  // box's foot, 1,540 px under md-b's 40 px): pageRecord makes none, and the
  // stroke is refused, never posted with a clamped endpoint (U613's rule).
  ov.setArmed(PAGE_TYPE);
  shell.calls.length = 0;
  const h = TF.stroke.begin(inputOf(press(wellEl(), 100, 300)));
  h.push([sample(1500, 2040, 4)]);
  const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
  assert.deepStrictEqual(r, { ok: false, hint: TF.FAILED_HINT });
  assert.equal(reaimText(), TF.FAILED_HINT);
  await shell.tick();
  assert.equal(posts().length, 0, 'nothing is posted');
});

test('MARGIN@nearest-item\'s ties go to the earlier item in page order: in the run\'s gap equidistant from pane A and pane B, and between md-a and the run equidistant in y', async () => {
  // (792, 300): in tfa's and tfb's vertical span, 4 px from each in x (tfb
  // moved to start at 796 for this case; 792 = 0.5 of the 1,584 px page box,
  // so the rounded point keeps the tie exact).
  boxed(itemOf('tfb'), { ...ITEM_BOXES.tfb, left: 796 });
  let gap;
  try {
    gap = await strokeOf(itemOf('tfa').closest('.run-grid'), [792, 300], [[792, 302]]);
  } finally { boxed(itemOf('tfb'), ITEM_BOXES.tfb); }
  assert.equal(gap.body.anchor.from.item, 'tfa', 'the earlier of two spans equally near in x');
  // (300, 128): 12 px under md-a (76–116) and 12 px over the run (140–440).
  const between = await strokeOf(mainEl(), [300, 128], [[300, 129]]);
  assert.equal(between.body.anchor.from.item, 'md-a', 'the earlier of two items equally near in y');
  assert.ok(admitted(gap.body) && admitted(between.body));
});

test('a page frame reads #main once per animation frame per handle on the sample path, the well only at begin and after a resize; at commit each item at most once, none per sample', async () => {
  const F = fakeFrames();
  TF.initTargetFrame({ raf: F.raf });
  const counts = new Map();
  const restore = [];
  // target-frame.js's own reads: a registered deriver's (ink-describe.js
  // reads its target's rect) are its own, not the commit's.
  const count = (key, el) => {
    const own = el.getBoundingClientRect;
    counts.set(key, 0);
    el.getBoundingClientRect = function () {
      if (!/ink-describe/.test(String(new Error().stack))) counts.set(key, counts.get(key) + 1);
      return own.call(this);
    };
    restore.push(() => { el.getBoundingClientRect = own; });
  };
  count('main', mainEl());
  count('well', wellEl());
  const items = [...mainEl().querySelectorAll('.mount-host, [data-md-id]')];
  items.forEach((el, i) => count(`item${i}`, el));
  const itemReads = () => items.map((_, i) => counts.get(`item${i}`));
  const zero = () => { for (const k of counts.keys()) counts.set(k, 0); };
  try {
    ov.setArmed(PAGE_TYPE);
    const h = TF.stroke.begin(inputOf(press(wellEl(), 100, 300)));
    assert.equal(h.frame.kind, 'page');
    assert.deepStrictEqual([counts.get('main'), counts.get('well')], [2, 1], 'begin: the frame\'s box (both) and begin\'s own push (#main)');
    zero();
    F.flush();
    for (let i = 0; i < 3; i++) h.push([sample(110 + i, 310, 4 + i), sample(111 + i, 311, 5 + i)]);
    assert.deepStrictEqual([counts.get('main'), counts.get('well')], [1, 0], 'three pushes in one frame: one #main read, no well read');
    F.flush();
    h.push([sample(120, 330, 10)]);
    h.push([sample(121, 331, 11)]);
    assert.deepStrictEqual([counts.get('main'), counts.get('well')], [2, 0], 'the next frame: one more');
    W.dispatchEvent(new W.Event('resize'));
    h.push([sample(122, 332, 12)]);
    assert.deepStrictEqual([counts.get('main'), counts.get('well')], [3, 1], 'a resize: #main and the well read again, once');
    h.push([sample(123, 333, 13)]);
    assert.deepStrictEqual([counts.get('main'), counts.get('well')], [3, 1]);
    assert.ok(itemReads().every((n) => n === 0), 'no item read on the sample path');
    zero();
    for (let i = 0; i < 200; i++) h.push([sample(130 + (i % 50), 340 + (i % 30), 14 + i)]);
    const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
    assert.equal(r.ok, true);
    assert.ok(itemReads().every((n) => n <= 1), `at commit each item at most once: ${itemReads()}`);
    assert.ok(itemReads().some((n) => n === 1), 'the endpoint search read items');
    assert.equal(counts.get('main'), 1, 'commit: the page box once (and no push read in the frame)');
    assert.equal(counts.get('well'), 1);
    F.flush();
  } finally { for (const f of restore) f(); TF.initTargetFrame({ raf: null }); }
});

test('an armed type whose listing row declares only \'element\': a margin pen-down is refused with PAGE_KIND_HINT and posts nothing; its stroke leaving an svg is clamped to the svg', async () => {
  assert.equal(TF.PAGE_KIND_HINT, 'This tool draws on panes, images and canvases only; its pack does not draw in the margins yet.');
  ov.setArmed(EL_TYPE);
  for (const [what, el] of [['the gutter', wellEl()], ['#main\'s padding', mainEl()], ['a markdown item', itemOf('md-a').querySelector('p')],
    ['a pane\'s padding', itemOf('tfa')]]) {
    const e = press(el, 100, 300);
    assert.deepStrictEqual({ ...TF.frameAt(e) }, { ok: false, page: true, hint: TF.PAGE_KIND_HINT }, what);
    note('');
    assert.equal(TF.stroke.begin(inputOf(e)), null, `${what}: begin refuses`);
    assert.equal(reaimText(), TF.PAGE_KIND_HINT, `${what}: the hint is shown`);
  }
  await shell.tick();
  assert.equal(posts().length, 0, 'nothing is posted');
  // Its stroke leaving the svg by 100 px: clamped to the svg, as at 627c5f53.
  const { body } = await strokeOf(q('rect.cr', 'tfa'), [310, 260], [[400, 300], [600, 450]], { type: EL_TYPE });
  assert.deepStrictEqual(body.anchor, anchors.record(rootOf('tfa'), q('svg.ch', 'tfa'), { mount: 'tfa' }));
  assert.deepStrictEqual(xyOf(body.payload.points), [0.05, 0.1, 0.5, 0.5, 1, 1]);
});

test('the chrome in the well is refused with FRAME_HINT for a type declaring \'page\': a pane header (its title too), the resize handles, a run\'s head and stacks button, a min chip, the fixed hint, the page meta, a data-wc-chrome subtree', async () => {
  ov.setArmed(PAGE_TYPE);
  const wrap = itemOf('tfa').closest('.pane');
  const run = wrap.closest('.page-run');
  const chip = W.document.createElement('button');
  chip.className = 'min-chip';
  chip.innerHTML = '<span>tfa</span><span class="restore">↗</span>';
  run.querySelector('.run-min').appendChild(chip);
  const chromeStrip = mainEl().appendChild(W.document.createElement('div'));
  chromeStrip.setAttribute('data-wc-chrome', '');
  chromeStrip.innerHTML = '<span class="cs">a strip</span>';
  // A data-wc-chrome subtree inside a markdown item's block: the md arm of the
  // positive list must not admit it (the strip above is refused by the list
  // alone, so it cannot tell the data-wc-chrome check is there).
  const mdChrome = itemOf('md-a').appendChild(W.document.createElement('span'));
  mdChrome.setAttribute('data-wc-chrome', '');
  mdChrome.innerHTML = '<span class="mc">chrome in a block</span>';
  try {
    const stacks = run.querySelector('.run-stacks');
    assert.ok(stacks, 'the run of two panes draws its stacks button');
    const cases = [['.pane-header', wrap.querySelector('.pane-header')], ['the title text', wrap.querySelector('.pane-title')],
      ['.pane-resize-r', wrap.querySelector('.pane-resize-r')], ['.pane-resize-b', wrap.querySelector('.pane-resize-b')],
      ['.pane-resize-rb', wrap.querySelector('.pane-resize-rb')], ['.run-head', run.querySelector('.run-head')],
      ['the stacks button', stacks], ['.min-chip', chip], ['the chip\'s .restore', chip.querySelector('.restore')],
      ['.run-fixed-hint', run.querySelector('.run-fixed-hint')], ['.page-meta', mainEl().querySelector('.page-meta')],
      ['a data-wc-chrome subtree', chromeStrip.querySelector('.cs')],
      ['a data-wc-chrome subtree inside a markdown block', mdChrome.querySelector('.mc')]];
    for (const [what, el] of cases) {
      assert.ok(el, `${what} exists`);
      const e = press(el, 300, 130);
      assert.deepStrictEqual({ ...TF.frameAt(e) }, { ok: false, hint: TF.FRAME_HINT }, what);
      note('');
      assert.equal(TF.stroke.begin(inputOf(e)), null, `${what}: begin refuses`);
      assert.equal(reaimText(), TF.FRAME_HINT, `${what}: the hint is shown`);
    }
    // The page's own surfaces are admitted (PAGE_SURFACES).
    for (const [what, el] of [['.page-run', run], ['.run-grid', run.querySelector('.run-grid')], ['.pane (the wrapper\'s box)', wrap],
      ['a pane\'s padding', itemOf('tfa')], ['.md-block', itemOf('md-a')], ['#main', mainEl()], ['.well-wrap', wellEl()]]) {
      assert.equal(TF.frameAt(press(el, 300, 130)).kind, 'page', what);
    }
    assert.deepStrictEqual(TF.frameAt(press(wrap, 300, 130)).down, { item: 'tfa', kind: 'pane' }, 'the wrapper\'s pane');
    assert.deepStrictEqual(TF.frameAt(press(itemOf('tfa'), 300, 130)).down, { item: 'tfa', kind: 'pane' }, 'the pane\'s padding');
    assert.equal(TF.PAGE_SURFACES, '.md-block, .page-run, .run-grid, .page-tail, .pane, #main, .well-wrap');
    await shell.tick();
    assert.equal(posts().length, 0, 'nothing is posted');
  } finally { chip.remove(); chromeStrip.remove(); mdChrome.remove(); }
});

test('strokesOn\'s page arm: a page row\'s frozen view with its drawn marker\'s box under a page frame; under a pane frame only page rows whose box meets the frame\'s rect; element rows unchanged', async () => {
  const layer = W.document.getElementById('el-layer');
  assert.ok(layer, 'the overlay\'s page layer');
  const rec = ST.pageRecord({ from: { item: 'tfa', x: 0.1, y: 0.1, w: 550, h: 300 }, to: { item: 'tfa', x: 0.4, y: 0.2, w: 550, h: 300 }, frame: { w: 1584, h: 2000 } });
  const pageRow = { id: 'pg1', v: 1, type: PAGE_TYPE, anchor: rec, shared: false, replies: 0 };
  const hiddenRow = { id: 'pg2', v: 1, type: PAGE_TYPE, anchor: rec, shared: false, replies: 0 };
  const strayRow = { id: 'pg3', v: 1, type: PAGE_TYPE, anchor: rec, shared: false, replies: 0 };   // no marker drawn
  const elRow = { id: 'el1', v: 1, type: PAGE_TYPE, anchor: anchors.record(rootOf('tfa'), q('svg.ch', 'tfa'), { mount: 'tfa' }), shared: false, replies: 0 };
  const mk = (ids, box, shown, place = 'box') => {
    const m = W.document.createElement('div');
    m.setAttribute('data-el-ids', ids);
    m.dataset.place = place;
    m.style.display = shown ? 'block' : 'none';
    boxed(m, box);
    layer.appendChild(m);
    return m;
  };
  const BOX = { left: 238, top: 140, width: 300, height: 60 };
  const made = [mk('el0 pg1', BOX, true), mk('pg2', BOX, false), mk('pg3', BOX, true, 'glyph')];
  let reads = 0;
  const own = made[0].getBoundingClientRect;
  made[0].getBoundingClientRect = function () { reads++; return own.call(this); };
  ov.setElements('live', [pageRow, hiddenRow, strayRow, elRow]);
  try {
    ov.setArmed(PAGE_TYPE);
    const pf = TF.frameAt(press(wellEl(), 100, 300));
    const got = TF.stroke.strokesOn(pf, { type: PAGE_TYPE });
    assert.deepStrictEqual(got.map((r) => r.id), ['pg1'], 'the drawn page row only: no element row under a page frame, no hidden or glyph marker');
    assert.ok(Object.isFrozen(got[0]), 'a frozen view');
    assert.deepStrictEqual({ ...got[0].box }, { left: 238, top: 140, w: 300, h: 60 }, 'its marker\'s client rect');
    assert.deepStrictEqual(got[0].anchor, rec);
    assert.equal(got[0].shared, false);
    TF.stroke.strokesOn(pf, { type: PAGE_TYPE });
    assert.equal(reads, 1, 'the marker\'s rect cached under the layout count');
    assert.deepStrictEqual(TF.stroke.strokesOn(pf, { type: 'another' }), [], 'of that type only');
    // Under pane A's block (250, 150, 526 × 60): the box meets it.
    const pa = TF.frameAt(press(q('p.a1', 'tfa'), 300, 170));
    assert.deepStrictEqual(TF.stroke.strokesOn(pa, { type: PAGE_TYPE }).map((r) => r.id), ['pg1']);
    // Under pane B's block (824, 150): it does not.
    const pb = TF.frameAt(press(q('p.b1', 'tfb'), 900, 170));
    assert.deepStrictEqual(TF.stroke.strokesOn(pb, { type: PAGE_TYPE }), []);
    // Under the svg (300, 250, 200 × 100): the element row as it is; the page row's box ends at 200.
    const sv = TF.frameAt(press(q('rect.cr', 'tfa'), 310, 260));
    const on = TF.stroke.strokesOn(sv, { type: PAGE_TYPE });
    assert.deepStrictEqual(on.map((r) => r.id), ['el1']);
    assert.deepStrictEqual(on[0], ov.elementsOf('live').find((r) => r.id === 'el1'), 'an element row is returned as it is');
    assert.equal(Object.isFrozen(on[0]), false, 'never a view');
    assert.equal('box' in on[0], false, 'no box: the eraser keeps the target\'s rect');
  } finally { for (const m of made) m.remove(); ov.setElements('live', []); }
});

test('the derive input of an arrow carries frame.kind \'page\', target #main and both endpoints\' items with their roots', async () => {
  const seen = [];
  const off = TF.registerStrokeDerive('page-probe', (a) => { seen.push(a); return {}; });
  try {
    await strokeOf(q('p.a1', 'tfa'), [300, 170], [[900, 180]]);
    await strokeOf(q('p.a1', 'tfa'), [300, 170], [[300, 300]]);
    await strokeOf(itemOf('md-a').querySelector('p'), [300, 100], [[320, 490]]);
  } finally { off(); }
  const [arrow, inside, md] = seen;
  assert.equal(arrow.frame.kind, 'page');
  assert.deepStrictEqual({ ...arrow.frame.rect }, PAGE_BOX);
  assert.deepStrictEqual(arrow.frame.down, { item: 'tfa', kind: 'pane' });
  assert.strictEqual(arrow.target, mainEl());
  assert.deepStrictEqual(arrow.items.map((i) => [i.id, i.kind]), [['tfa', 'pane'], ['tfb', 'pane']]);
  assert.strictEqual(arrow.items[0].root, rootOf('tfa'), 'pane A\'s shadow root');
  assert.strictEqual(arrow.items[1].root, rootOf('tfb'), 'pane B\'s shadow root');
  assert.deepStrictEqual(arrow.items[1].rect, { left: 812, top: 140, w: 550, h: 300 });
  assert.deepStrictEqual(arrow.bbox, ST.bboxOf(arrow.points), 'bbox in page units');
  assert.deepStrictEqual(inside.items.map((i) => i.id), ['tfa'], 'one entry when from.item === to.item');
  assert.deepStrictEqual(md.items.map((i) => [i.id, i.kind]), [['md-a', 'md'], ['md-b', 'md']]);
  assert.strictEqual(md.items[0].root, itemOf('md-a'), 'the md block itself');
});

test('pushing 10,000 samples on a page frame performs O(log n) buffer growths and reads no rect inside begin\'s frame', async () => {
  const Real = globalThis.Float64Array;
  let made = 0;
  let reads = 0;
  const main = mainEl();
  const own = main.getBoundingClientRect;
  main.getBoundingClientRect = function () { reads++; return own.call(this); };
  const samples = [];
  for (let i = 0; i < 10000; i++) samples.push(sample(100 + (i % 200), 200 + (i % 100), i));
  ov.setArmed(PAGE_TYPE);
  globalThis.Float64Array = new Proxy(Real, { construct(t, a, nt) { made++; return Reflect.construct(t, a, nt); } });
  let h;
  try {
    h = TF.stroke.begin(inputOf(press(wellEl(), 100, 200)));
    reads = 0;
    for (let i = 0; i < samples.length; i += 4) h.push(samples.slice(i, i + 4));
  } finally { globalThis.Float64Array = Real; main.getBoundingClientRect = own; }
  assert.equal(h.frame.kind, 'page');
  assert.equal(h.count, 10001);
  const bound = Math.ceil(Math.log2((10001 * 4) / TF.BUFFER_START)) + 1;
  assert.ok(made <= bound, `${made} buffers ≤ ${bound}`);
  assert.equal(reads, 0, 'no rect read inside the frame begin read in');
  const r = await h.commit({ tool: 'line', width: 2, colour: 'accent', shared: false });
  assert.equal(r.ok, true);
  // The per-sample path: readPageRect writes the held rect's fields only.
  const src = fs.readFileSync(path.join(REPO, 'public/app/target-frame.js'), 'utf8');
  const rp = /\n  function readPageRect\(\) \{\n([\s\S]*?)\n  \}\n/.exec(src);
  assert.ok(rp, 'readPageRect found');
  assert.doesNotMatch(rp[1], /\bnew\b|\{\s*\w+\s*[:,}]|\.\.\.|\[/, 'readPageRect allocates nothing');
});

// ── the pageRecord-null line names both causes (HAND FOLD 3, DECISIONS.md
// K.2-275; U613b@spec:mount-id-grammar (a)) ─────────────────────────────────
// lib/core/strokes isPageRecord takes an item id only in PAGE_ITEM_RE's
// grammar ([A-Za-z0-9_-]); mount ids keep today's free grammar, so a stroke
// whose item is a pane rendered as `tf.dot` or `tf sp` makes no page record:
// nothing is posted, the stroke is refused with FAILED_HINT, and the console
// line says either cause.
test('a page stroke whose item id carries a dot or a space posts nothing and logs the line naming both causes', async () => {
  const LINE = '[web-chat] strokes: no page record for this stroke (an endpoint lies too far from its nearest item, or the item\'s id is not [A-Za-z0-9_-]; render and use_component refuse such a new id from 0.9.0-alpha.7, and a pane already live under one keeps it)';
  const BAD = [
    { id: 'tf.dot', box: { left: 238, top: 560, width: 550, height: 200 } },
    { id: 'tf sp', box: { left: 812, top: 560, width: 550, height: 200 } },
  ];
  for (const b of BAD) await shell.frame({ type: 'render', id: b.id, target: 'main', params: {}, gen: 0, html: '<p class="bad">a pane whose id is outside the grammar</p>' });
  await shell.tick();
  for (const b of BAD) {
    boxed(itemOf(b.id), b.box);
    boxed(q('p.bad', b.id), { left: b.box.left + 12, top: b.box.top + 10, width: b.box.width - 24, height: 60 });
  }
  assert.equal(ST.isPageRecord(ST.pageRecord({ frame: { w: 1584, h: 2000 },
    from: { item: 'tfa', x: 0.5, y: 0.5, w: 550, h: 300 }, to: { item: 'tfb', x: 0.5, y: 0.5, w: 550, h: 300 } })), true,
  'the same arrow between safe ids makes a record');
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    const cases = [
      ['an arrow from the dotted pane to the spaced one', q('p.bad', 'tf.dot'), [300, 600], [[600, 620], [900, 640]]],
      ['a margin stroke beside the dotted pane', mainEl(), [220, 650], [[224, 660], [226, 680]]],
    ];
    for (const [what, el, at, moves] of cases) {
      ov.setArmed(PAGE_TYPE);
      shell.calls.length = 0;
      errors.length = 0;
      const h = TF.stroke.begin(inputOf(press(el, at[0], at[1])));
      assert.ok(h, `${what}: a handle`);
      h.push(moves.map(([x, y], i) => sample(x, y, 4 * (i + 1))));
      const r = await h.commit({ tool: 'line', width: 4, colour: 'accent', shared: false });
      assert.deepStrictEqual({ ...r }, { ok: false, hint: TF.FAILED_HINT }, `${what}: refused with FAILED_HINT`);
      await shell.tick();
      assert.equal(posts().length, 0, `${what}: nothing posted`);
      assert.deepStrictEqual(errors, [LINE], `${what}: the one line, naming both causes`);
      assert.equal(reaimText(), TF.FAILED_HINT, `${what}: the hint is shown`);
    }
  } finally {
    console.error = realError;
    for (const b of BAD) await shell.frame({ type: 'clear', id: b.id });
  }
});

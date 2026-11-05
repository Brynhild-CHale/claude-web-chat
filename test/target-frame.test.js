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
//     nothing; a press on the .mount-host itself (the pane's padding) is the
//     page placeholder {ok: false, page: true, hint}; the derive input's
//     frame carries its kind;
//   - the real create ctx a strokes type's create receives carries frameAt and
//     stroke, and a pen-down → moves → pen-up through the overlay's one
//     pointer dispatch posts ONE element;
//   - points normalised against the rect (the four corners map to 0/1; a
//     sample outside the box is clamped to [0, 1]); the rect read at most
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
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
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
const MOVE_A = { id: 'tf2', target: 'main', params: {}, gen: 0,
  html: '<div class="box"><svg class="chart" viewBox="0 0 10 10"><rect width="5" height="5"/></svg><p>a caption under the chart</p></div>' };
const MOVE_B = '<div class="box"><p class="new">a line added above</p><svg class="chart" viewBox="0 0 10 10"><rect width="5" height="5"/></svg><p>a caption under the chart</p></div>';
const MOVE_C = '<div class="box"><p class="new">a line added above</p><p>a caption under the chart</p></div>';

let shell, W, M, ov, TF, ST, anchors, topbar, state, oh;
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

before(async () => {
  shell = await bootShell({ routes: { '/api/elements': elementsRoute } });
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
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE, MOVE_A, PROSE] }));
  await shell.tick();
  stubRects();
  stubProse();
  const nest = q('div.nest', 'tf3').attachShadow({ mode: 'open' });
  nest.innerHTML = '<p class="deep">a nested component\'s prose</p><button class="dbtn">Nested</button>';
  q('div.nest2', 'tf3').attachShadow({ mode: 'open' }).innerHTML = '<button class="sb"><slot></slot></button>';
  ov.registerType(TYPE, { input: 'strokes', place: 'box', draw() {} });
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

test('a press on the .mount-host itself (the pane\'s padding) is the page placeholder: {ok: false, page: true, hint}, nothing posted', async () => {
  const host = M.itemEl(W.document, 'tf3').el;
  assert.ok(host.classList.contains('mount-host'));
  const e = press(host, 495, 95);
  assert.deepStrictEqual({ ...TF.frameAt(e) }, { ok: false, page: true, hint: TF.FRAME_HINT });
  note('');
  assert.equal(TF.stroke.begin(inputOf(e)), null, 'begin refuses');
  assert.equal(reaimText(), TF.FRAME_HINT, 'the hint is shown');
  // A zero box on the outermost element: the same placeholder.
  const aside = q('aside.side', 'tf3');
  const own = aside.getBoundingClientRect;
  boxed(aside, { left: 0, top: 0, width: 0, height: 0 });
  try {
    assert.deepStrictEqual({ ...TF.frameAt(press(aside, 1, 1)) }, { ok: false, page: true, hint: TF.FRAME_HINT });
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

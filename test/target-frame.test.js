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
//     [data-fixed-aspect] div are accepted; a <p>, a <button>, a press over an
//     <iframe> and one inside an iframe's document are refused with
//     FRAME_HINT, and begin() on them posts nothing;
//   - the real create ctx a strokes type's create receives carries frameAt and
//     stroke, and a pen-down → moves → pen-up through the overlay's one
//     pointer dispatch posts ONE element;
//   - points normalised against the rect (the four corners map to 0/1; a
//     sample outside the box is clamped to [0, 1]); the rect read once per
//     push, never per sample; a predicted sample is never stored;
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
//     over Float64Array construction), reads the rect once per push, and
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
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE, MOVE_A] }));
  await shell.tick();
  stubRects();
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

test('a <p>, a <button>, a press over an <iframe> and one inside an iframe\'s document are refused with FRAME_HINT; begin posts nothing', async () => {
  const fr = q('iframe.fr');
  const doc = fr.contentDocument || W.document.implementation.createHTMLDocument('framed');
  const inFrame = doc.body.appendChild(doc.createElement('div'));
  boxed(inFrame, { left: 0, top: 0, width: 50, height: 50 });
  inFrame.setAttribute('data-fixed-aspect', '');
  const cases = [['p', press(q('p.prose'), 20, 565)], ['button', press(q('button.btn'), 20, 595)],
    ['over an iframe', press(fr, 20, 630)], ['inside an iframe', press(inFrame, 5, 5)]];
  for (const [what, e] of cases) {
    const f = TF.frameAt(e);
    assert.deepStrictEqual({ ...f }, { ok: false, hint: TF.FRAME_HINT }, what);
    assert.equal(TF.stroke.begin(inputOf(e)), null, `${what}: begin refuses`);
    assert.equal(reaimText(), TF.FRAME_HINT, `${what}: the hint is shown`);
  }
  // A markdown item and the chrome are no pane's content.
  assert.equal(TF.frameAt(press(W.document.getElementById('main'), 1, 1)).ok, false);
  await shell.tick();
  assert.equal(posts().length, 0, 'nothing is posted');
  assert.equal(TF.FRAME_HINT, 'Ink draws on an image, an svg, a canvas or a canvas sheet — never over text or a control');
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

test('pushing 10,000 samples performs O(log n) buffer growths and reads the rect once per push', async () => {
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
  assert.equal(reads, 2500, 'one rect read per push');
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

// The wet layer (annotation engine tranche 4, U517, plan 4A.2; AD3 (b), AD4
// (a), WET@engine; LATENCY@measure (a) — this file is a code-path pin, never
// a latency reading).
//
// The real chrome (test-support/chrome-shell, booted once; main.js has called
// initWetLayer()), with the wet layer's box read and frame scheduler stubbed
// (initWetLayer({rectOf, raf}), as the overlay tests stub initOverlay's):
// jsdom does no layout and has no canvas 2D context, so the test owns the
// geometry and stubs HTMLCanvasElement.prototype.getContext with a context
// that records its calls.
//
// Pinned here:
//   - initWetLayer registers ctx.wet on the create ctx (a strokes tool's
//     create sees the api), idempotently;
//   - begin over a pane's target lays ONE canvas in the chrome's body (never
//     the pane), fixed, pointer-events none, at --z-pins, over the target's
//     rect, its backing rect × devicePixelRatio (1, 2 and 3) and its context
//     scaled by it; begin refuses an iframe, an element in another document
//     and a disconnected one;
//   - 10,000 samples pushed in batches of 4: stats().allocs unchanged after
//     the first begin, the ring's buffer the same object, the view reading the
//     newest samples in order; a 5,000-sample stroke wraps and counts dropped;
//     push and the frame create nothing (a source check beside the counter);
//   - paint called many times in one frame schedules one frame; predicted
//     samples are drawn by the view and overwritten by the next push, never in
//     the ring;
//   - end() detaches after the next frame, cancel() at once; a second begin
//     reuses the same canvas; a scroll mid-stroke moves the canvas with the
//     target on the next frame.
const test = require('node:test');
const { before, after, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const REPO = path.resolve(__dirname, '..');
let shell, W, M, ov, IM, WL, wet;

// ── the fake scheduler the wet layer paints on ─────────────────────────────
const queue = [];
let rafCalls = 0;
const fakeRaf = (fn) => { rafCalls++; queue.push(fn); return queue.length; };
function flush(max = 100) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(0); n++; }
  assert.ok(n < max, 'the wet layer settles to no pending frame');
  return n;
}

// ── the geometry ────────────────────────────────────────────────────────────
const rects = new Map();
function rectOf(el) {
  const r = rects.get(el) || { left: 0, top: 0, width: 0, height: 0 };
  return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
}

// ── the recording 2D context ────────────────────────────────────────────────
const contexts = [];
function stubContext(canvasEl) {
  const calls = [];
  const c = {
    canvas: canvasEl,
    calls,
    setTransform: (...a) => calls.push(['setTransform', ...a]),
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    stroke: () => calls.push(['stroke']),
  };
  contexts.push(c);
  return c;
}

const PANE = {
  id: 'wet-pane', target: 'main', params: {},
  html: '<div class="sheet">a sheet to draw on</div><iframe class="fr"></iframe><p class="cap">caption</p>',
};
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const sheet = () => rootOf('wet-pane').querySelector('.sheet');
const wetCanvases = () => [...W.document.querySelectorAll('canvas.el-wet')];
const setDpr = (v) => Object.defineProperty(W, 'devicePixelRatio', { value: v, configurable: true, writable: true });
const sample = (x, y, t, pressure = 0.5) => ({ clientX: x, clientY: y, pressure, timeStamp: t });

before(async () => {
  shell = await bootShell({});
  W = shell.window;
  M = W.__wcMount;
  W.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
    return kind === '2d' ? stubContext(this) : null;
  };
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  WL = await shell.importApp('wet-layer.js');
  await shell.frame(helloFrame({ mounts: [PANE] }));
  rects.set(sheet(), { left: 40, top: 100, width: 300, height: 200 });
  wet = WL.initWetLayer({ raf: fakeRaf, rectOf });
});

afterEach(() => {
  if (wet) wet.cancel();
  flush();
  setDpr(1);
});

after(async () => {
  if (shell) await shell.restore();
});

test('initWetLayer registers ctx.wet on every create ctx, once', () => {
  assert.equal(WL.initWetLayer(), wet, 'idempotent: main.js\'s call and this one are the same api');
  assert.throws(() => ov.registerCreateCtx('wet', {}), /"wet" is already registered/, 'registered by main.js\'s initWetLayer()');
  assert.deepStrictEqual(Object.keys(wet).sort(), ['active', 'begin', 'cancel', 'end', 'paint', 'push', 'stats']);
  IM.setFingerDraws('off');
  const seen = [];
  const off = ov.registerType('wet-probe', { draw() {}, input: 'strokes', create: (inp, ctx) => seen.push(ctx) });
  try {
    ov.setArmed('wet-probe');
    const target = rootOf('wet-pane').querySelector('p.cap');
    const pe = (type) => target.dispatchEvent(new W.PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: 7, isPrimary: true,
      clientX: 80, clientY: 80, buttons: type === 'pointerup' ? 0 : 1,
    }));
    pe('pointerdown');
    pe('pointerup');
    assert.equal(seen.length, 2, 'the strokes tool heard its gesture');
    assert.equal(seen[0].wet, wet, 'ctx.wet is the wet layer\'s api');
  } finally {
    ov.setArmed(null);
    off();
  }
});

test('begin lays ONE canvas in the chrome\'s body over the target, backing rect × DPR (1, 2, 3), context scaled', () => {
  let first = null;
  for (const d of [1, 2, 3]) {
    setDpr(d);
    assert.equal(wet.begin(sheet(), { pointerId: 3 }), true, `DPR ${d}: begun`);
    assert.equal(wet.active(), true);
    const all = wetCanvases();
    assert.equal(all.length, 1, `DPR ${d}: one canvas`);
    const [c] = all;
    if (!first) first = c;
    assert.equal(c, first, 'the same element at every begin');
    assert.equal(c.parentNode, W.document.body, 'in the chrome\'s own body');
    assert.equal(rootOf('wet-pane').querySelector('canvas'), null, 'never inside the pane');
    assert.equal(c.style.position, 'fixed');
    assert.equal(c.style.pointerEvents, 'none');
    assert.equal(c.style.zIndex, 'var(--z-pins)', 'the overlay page layer\'s rung');
    assert.equal(c.id, '', 'no id (no reserved id)');
    assert.deepStrictEqual([c.style.left, c.style.top, c.style.width, c.style.height], ['40px', '100px', '300px', '200px']);
    assert.deepStrictEqual([c.width, c.height], [300 * d, 200 * d], `DPR ${d}: the backing is rect × DPR`);
    const ctx = contexts[contexts.length - 1];
    assert.equal(ctx.canvas, c);
    const scale = ctx.calls.filter((k) => k[0] === 'setTransform').pop();
    assert.deepStrictEqual(scale, ['setTransform', d, 0, 0, d, 0, 0], `DPR ${d}: the context scaled`);
    wet.cancel();
  }
  assert.equal(contexts.length, 1, 'one context, asked for once');
});

test('begin refuses an iframe, an element in another document and a disconnected one', () => {
  const frame = rootOf('wet-pane').querySelector('iframe.fr');
  assert.equal(wet.begin(frame, { pointerId: 1 }), false, 'a frame');
  const other = frame.contentDocument && frame.contentDocument.body;
  if (other) assert.equal(wet.begin(other, { pointerId: 1 }), false, 'another document');
  const loose = W.document.createElement('div');
  assert.equal(wet.begin(loose, { pointerId: 1 }), false, 'not connected');
  assert.equal(wet.begin(null), false);
  assert.equal(wet.active(), false);
  assert.equal(wetCanvases().length, 0, 'nothing laid');
  assert.equal(wet.push([sample(1, 1, 1)]), 0, 'push without a stroke keeps nothing');
  assert.equal(wet.paint(() => {}), false);
});

test('10,000 samples in batches of 4: no allocation after the first begin, one ring, the view reads the newest in order', () => {
  assert.ok(wet.begin(sheet(), { pointerId: 5 }));
  const s0 = wet.stats();
  let buffer = null;
  let checks = 0;
  const batch = [sample(0, 0, 0), sample(0, 0, 0), sample(0, 0, 0), sample(0, 0, 0)];
  for (let n = 0; n < 10000; n += 4) {
    for (let j = 0; j < 4; j++) {
      const i = n + j;
      batch[j].clientX = 40 + (i % 300);
      batch[j].clientY = 100 + (i % 200);
      batch[j].pressure = (i % 100) / 100;
      batch[j].timeStamp = i;
    }
    assert.equal(wet.push(batch), 4);
    if (n % 1000 === 0 || n === 9996) {
      wet.paint((ctx, view) => {
        if (!buffer) buffer = view.buffer;
        assert.equal(view.buffer, buffer, 'the ring\'s buffer is the same object');
        const total = n + 4;
        const count = Math.min(total, WL.WET_RING);
        assert.equal(view.count, count);
        assert.equal(view.total, total);
        for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 50))) {
          const k = total - count + i;
          assert.equal(view.t(i), k, 'oldest first');
          assert.equal(view.x(i), k % 300, 'x relative to the target\'s rect');
          assert.equal(view.y(i), k % 200);
          assert.equal(view.pressure(i), (k % 100) / 100);
        }
        assert.equal(view.t(count - 1), total - 1, 'the newest last');
        checks++;
      });
      flush();
    }
  }
  const s1 = wet.stats();
  assert.ok(checks >= 10);
  assert.ok(buffer instanceof W.Float64Array || buffer instanceof Float64Array);
  assert.equal(buffer.length, WL.WET_RING * WL.WET_FIELDS);
  assert.equal(s1.allocs, s0.allocs, 'no allocation per sample or per push');
  assert.equal(s1.samples - s0.samples, 10000);
  assert.equal(s1.dropped - s0.dropped, 10000 - WL.WET_RING);
  // A second stroke allocates nothing either.
  wet.cancel();
  assert.ok(wet.begin(sheet(), { pointerId: 6 }));
  wet.push(batch);
  wet.paint(() => {});
  flush();
  assert.equal(wet.stats().allocs, s0.allocs, 'nothing new at a later begin');
});

test('a 5,000-sample stroke wraps the ring and counts what it dropped', () => {
  assert.equal(WL.WET_RING, 4096);
  assert.ok(wet.begin(sheet(), { pointerId: 8 }));
  const d0 = wet.stats().dropped;
  const one = [sample(0, 0, 0)];
  for (let i = 0; i < 5000; i++) {
    one[0].clientX = 40 + i;
    one[0].timeStamp = i;
    wet.push(one);
  }
  let seen = null;
  wet.paint((ctx, view) => { seen = { count: view.count, dropped: view.dropped, first: view.t(0), last: view.t(view.count - 1), x0: view.x(0) }; });
  flush();
  assert.deepStrictEqual(seen, { count: 4096, dropped: 5000 - 4096, first: 5000 - 4096, last: 4999, x0: 5000 - 4096 });
  assert.equal(wet.stats().dropped - d0, 904);
});

test('push and the frame create nothing: no new, closure, literal or copy in their bodies', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/wet-layer.js'), 'utf8');
  const body = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at >= 0, name);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    throw new Error(name);
  };
  for (const name of ['push', 'onWetFrame', 'place', 'schedule']) {
    const b = body(name);
    for (const bad of [/\bnew\s/, /=>/, /\bfunction\b/, /\[\s*\]/, /\{\s*\}/, /\.\.\./, /\.(slice|subarray|map|filter|concat|from)\(/]) {
      assert.ok(!bad.test(b), `${name} has no ${bad}`);
    }
  }
});

test('paint many times in one frame schedules one frame; predicted samples are drawn, then overwritten, never kept', () => {
  assert.ok(wet.begin(sheet(), { pointerId: 9 }));
  flush();
  const before = rafCalls;
  const log = [];
  const fn = (ctx, view) => {
    const p = [];
    for (let i = 0; i < view.predictedCount; i++) p.push([view.predictedX(i), view.predictedY(i), view.predictedT(i)]);
    const kept = [];
    for (let i = 0; i < view.count; i++) kept.push([view.x(i), view.y(i), view.t(i)]);
    log.push({ kept, p, fresh: view.fresh });
  };
  wet.push([sample(50, 110, 1)], { predicted: [sample(60, 120, 2), sample(70, 130, 3)] });
  for (let i = 0; i < 20; i++) wet.paint(fn);
  assert.equal(rafCalls - before, 1, 'twenty paints, one frame asked for');
  assert.equal(flush(), 1);
  assert.equal(log.length, 1, 'painted once');
  assert.deepStrictEqual(log[0], { kept: [[10, 10, 1]], p: [[20, 20, 2], [30, 30, 3]], fresh: 1 });
  wet.push([sample(52, 112, 4)], { predicted: [sample(80, 140, 5)] });
  wet.paint(fn);
  flush();
  assert.deepStrictEqual(log[1], { kept: [[10, 10, 1], [12, 12, 4]], p: [[40, 40, 5]], fresh: 1 }, 'the next push overwrote the predicted slot; the ring kept only real samples');
  wet.push([sample(53, 113, 6)]);
  wet.paint(fn);
  flush();
  assert.deepStrictEqual(log[2], { kept: [[10, 10, 1], [12, 12, 4], [13, 13, 6]], p: [], fresh: 1 }, 'a push with no predicted clears them');
  const many = Array.from({ length: 40 }, (_, i) => sample(i, i, 100 + i));
  wet.push([sample(54, 114, 7)], { predicted: many });
  wet.paint(fn);
  flush();
  assert.equal(log[3].p.length, WL.WET_PREDICTED, 'the predicted slot is bounded');
});

test('end() keeps the canvas one frame, then clears and detaches it; cancel() at once; a second begin reuses it', () => {
  assert.ok(wet.begin(sheet(), { pointerId: 10 }));
  const c = wetCanvases()[0];
  const ctx = contexts[contexts.length - 1];
  wet.push([sample(50, 110, 1)]);
  wet.paint(() => {});
  flush();
  assert.equal(wet.end(), true);
  assert.equal(wet.active(), false, 'ended: no stroke in progress');
  assert.equal(c.parentNode, W.document.body, 'still laid until the next frame (the dry marker paints first)');
  assert.equal(wet.paint(() => {}), false, 'no paint after the end');
  const clears = ctx.calls.filter((k) => k[0] === 'clearRect').length;
  assert.equal(flush(), 1);
  assert.equal(c.parentNode, null, 'detached at the next frame');
  assert.ok(ctx.calls.filter((k) => k[0] === 'clearRect').length > clears, 'and cleared');
  // A second begin reuses the same element.
  assert.ok(wet.begin(sheet(), { pointerId: 11 }));
  assert.equal(wetCanvases()[0], c, 'the same canvas element');
  assert.equal(wet.cancel(), true);
  assert.equal(c.parentNode, null, 'cancel detaches at once');
  assert.equal(wet.active(), false);
  assert.equal(wet.cancel(), false, 'a second cancel has nothing to drop');
  // A begin while a stroke is ending keeps the canvas for the new stroke.
  assert.ok(wet.begin(sheet(), { pointerId: 12 }));
  wet.end();
  assert.ok(wet.begin(sheet(), { pointerId: 13 }));
  flush();
  assert.equal(c.parentNode, W.document.body, 'the ending stroke\'s frame does not take the new one\'s canvas');
  assert.equal(wet.active(), true);
  // A begin while active ends the previous stroke: its samples are gone.
  wet.push([sample(41, 101, 1), sample(42, 102, 2)]);
  assert.ok(wet.begin(sheet(), { pointerId: 14 }));
  let count = -1;
  wet.paint((x, view) => { count = view.count; });
  flush();
  assert.equal(count, 0, 'a fresh stroke');
});

test('a scroll mid-stroke moves the canvas with the target on the next frame; a resize clears and marks every sample fresh', () => {
  const r = { left: 40, top: 100, width: 300, height: 200 };
  rects.set(sheet(), r);
  assert.ok(wet.begin(sheet(), { pointerId: 15 }));
  const c = wetCanvases()[0];
  wet.push([sample(50, 110, 1), sample(60, 120, 2)]);
  wet.paint(() => {});
  flush();
  r.top = 40;
  W.dispatchEvent(new W.Event('scroll'));
  assert.equal(c.style.top, '100px', 'nothing moves before the frame');
  assert.equal(flush(), 1, 'a scroll asks for one frame');
  assert.equal(c.style.top, '40px', 'the canvas follows the target');
  assert.equal(c.style.left, '40px');
  r.width = 320;
  let fresh = -1;
  wet.paint((x, view) => { fresh = view.fresh; });
  flush();
  assert.equal(c.width, 320, 'a new size: the backing follows');
  assert.equal(fresh, 2, 'after a resize every kept sample is fresh (the canvas was cleared)');
  // The target leaving mid-stroke drops the stroke.
  const el = sheet();
  const parent = el.parentNode;
  el.remove();
  wet.paint(() => {});
  flush();
  assert.equal(wet.active(), false, 'a target gone mid-stroke cancels it');
  assert.equal(c.parentNode, null);
  parent.prepend(el);
});

test('a sample with no pressure reads the default; a begin re-lays the canvas last in the body (above #el-layer by tree order)', () => {
  assert.ok(wet.begin(sheet(), { pointerId: 16 }));
  const c = wetCanvases()[0];
  assert.equal(c.nextSibling, null, 'last in the body at the begin');
  wet.push([{ clientX: 50, clientY: 110, timeStamp: 1 }, { clientX: 51, clientY: 111, pressure: NaN, timeStamp: 2 }]);
  let seen = null;
  wet.paint((x, view) => { seen = [view.pressure(0), view.pressure(1)]; });
  flush();
  assert.deepStrictEqual(seen, [0.5, 0.5], 'no pressure and NaN read the Pointer Events default');
  // Something laid after the canvas mid-stroke: the next begin puts it last again.
  const late = W.document.createElement('div');
  W.document.body.appendChild(late);
  try {
    assert.equal(c.nextSibling, late);
    assert.ok(wet.begin(sheet(), { pointerId: 17 }));
    assert.equal(wetCanvases()[0], c, 'the same canvas');
    assert.equal(c.nextSibling, null, 'last in the body again');
  } finally {
    late.remove();
  }
});

test('main.js inits the wet layer once, after the overlay', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8');
  assert.equal((src.match(/initWetLayer\(\);/g) || []).length, 1);
  assert.ok(src.indexOf('initWetLayer();') > src.indexOf('initOverlay();'));
});

test('a scroll inside the pane\'s shadow root (no window event) moves the canvas at the next frame; the push after it reads the new rect (U517a)', () => {
  const root = rootOf('wet-pane');
  const r = { left: 40, top: 100, width: 300, height: 200 };
  rects.set(sheet(), r);
  // Count the stroke's listeners on the shadow root: one added at the begin, removed at the detach.
  const added = [];
  const removed = [];
  root.addEventListener = function add(type, fn, o) { added.push(type); return W.ShadowRoot.prototype.addEventListener.call(this, type, fn, o); };
  root.removeEventListener = function rm(type, fn, o) { removed.push(type); return W.ShadowRoot.prototype.removeEventListener.call(this, type, fn, o); };
  try {
    assert.ok(wet.begin(sheet(), { pointerId: 18 }));
    const c = wetCanvases()[0];
    wet.push([sample(50, 110, 1)]);
    wet.paint(() => {});
    flush();
    const before = rafCalls;
    assert.equal(flush(), 0, 'the pen still: no frame runs (never an idle loop)');
    r.top = 60;
    r.left = 30;
    let windowHeard = 0;
    const onWin = () => { windowHeard++; };
    W.addEventListener('scroll', onWin, true);
    try {
      root.querySelector('p.cap').dispatchEvent(new W.Event('scroll'));
    } finally {
      W.removeEventListener('scroll', onWin, true);
    }
    assert.equal(windowHeard, 0, 'a scroll inside a shadow root never reaches the window');
    assert.equal(c.style.top, '100px', 'nothing moves before the frame');
    assert.equal(rafCalls - before, 1, 'the shadow-root scroll asks for one frame');
    assert.equal(flush(), 1);
    assert.deepStrictEqual([c.style.left, c.style.top], ['30px', '60px'], 'the canvas follows the target\'s new rect');
    wet.push([sample(50, 110, 2)]);
    let seen = null;
    wet.paint((x, view) => { seen = [view.x(1), view.y(1)]; });
    flush();
    assert.deepStrictEqual(seen, [20, 50], 'the push after the frame stores x/y against the new rect');
    assert.equal(flush(), 0, 'and no frame runs after it');
    wet.end();
    flush();
    assert.deepStrictEqual(added.filter((t) => t === 'scroll').length, 1, 'one scroll listener for the stroke');
    assert.deepStrictEqual(removed.filter((t) => t === 'scroll').length, 1, 'removed at the detach');
    const idle = rafCalls;
    root.querySelector('p.cap').dispatchEvent(new W.Event('scroll'));
    assert.equal(rafCalls, idle, 'no frame while no stroke is active');
    // A cancel removes it too; a begin over a light-DOM target adds none.
    assert.ok(wet.begin(sheet(), { pointerId: 19 }));
    wet.cancel();
    assert.equal(removed.filter((t) => t === 'scroll').length, 2, 'a cancel removes it');
    const light = W.document.createElement('div');
    W.document.body.appendChild(light);
    try {
      assert.ok(wet.begin(light, { pointerId: 20 }));
      assert.equal(added.filter((t) => t === 'scroll').length, 2, 'a target in the document: no shadow-root listener');
      wet.cancel();
    } finally {
      light.remove();
    }
  } finally {
    delete root.addEventListener;
    delete root.removeEventListener;
    rects.set(sheet(), { left: 40, top: 100, width: 300, height: 200 });
  }
});

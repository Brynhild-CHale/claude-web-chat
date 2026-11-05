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
// Tranche 5, U615 (WET@clip-viewport, WET@trail; the timers stubbed through
// initWetLayer({setTimeout, clearTimeout}), the layout viewport through
// documentElement's clientWidth / clientHeight, the well through rectOf):
//   - begin answers a token (a positive integer); a page target (#main,
//     1,100 × 20,000 CSS px) at DPR 2 is clipped to the well's visible part,
//     never over the viewport × dpr; a gutter sample is kept;
//   - a scroll mid-stroke moves the clip, shifts the kept samples with the
//     target and the next push reads the new clip origin;
//   - a target in a nested shadow root hears a scroll on the OUTER root;
//   - a second begin before end(N) keeps N on the trail (one drawImage,
//     before the live canvas is cleared; no clearRect of the trail) until
//     end(N); cancel(N) clears it at once; WET_HOLD_MS releases a trail no
//     call names; end() bare still ends the active stroke;
//   - 10,000 samples with holds between them: stats().allocs unchanged after
//     the first begin, the trail canvas included.
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

// ── the fake timers the hold runs on (WET_HOLD_MS) ─────────────────────────
const timers = [];
const fakeSetTimeout = (fn, ms, arg) => { const h = { fn, ms, arg }; timers.push(h); return h; };
const fakeClearTimeout = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
function fireTimers() {
  let n = 0;
  while (timers.length) { const h = timers.shift(); h.fn(h.arg); n++; }
  return n;
}

// ── the geometry ────────────────────────────────────────────────────────────
const rects = new Map();
function rectOf(el) {
  const r = rects.get(el) || { left: 0, top: 0, width: 0, height: 0 };
  return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
}

// ── the recording 2D context ────────────────────────────────────────────────
// Every context's calls also go to `allCalls` (canvas class, call), so a test
// can read their order across the two canvases.
const contexts = [];
const allCalls = [];
function stubContext(canvasEl) {
  const calls = [];
  const rec = (k) => (...a) => { calls.push([k, ...a]); allCalls.push([canvasEl.className, k, ...a]); };
  const c = { canvas: canvasEl, calls };
  for (const k of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'drawImage']) c[k] = rec(k);
  contexts.push(c);
  return c;
}
const ctxOf = (el) => contexts.find((c) => c.canvas === el) || null;

const PANE = {
  id: 'wet-pane', target: 'main', params: {},
  html: '<div class="sheet">a sheet to draw on</div><iframe class="fr"></iframe><p class="cap">caption</p>',
};
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const sheet = () => rootOf('wet-pane').querySelector('.sheet');
const wetCanvases = () => [...W.document.querySelectorAll('canvas.el-wet')];
const trailCanvas = () => W.document.querySelector('canvas.el-wet-trail');
const WELL = { left: 0, top: 32, width: 1280, height: 768 };
const VIEW = { width: 1280, height: 800 };
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
  rects.set(W.document.querySelector('.well-wrap'), WELL);
  shell.scrollMetrics(W.document.documentElement, { clientWidth: VIEW.width, clientHeight: VIEW.height });
  wet = WL.initWetLayer({ raf: fakeRaf, rectOf, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout });
});

afterEach(() => {
  if (wet) wet.cancel();
  fireTimers();   // a stroke a test left on the trail is released
  flush();
  assert.equal(wet.stats().held, 0, 'nothing left on the trail');
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
  let prev = 0;
  for (const d of [1, 2, 3]) {
    setDpr(d);
    const tok = wet.begin(sheet(), { pointerId: 3 });
    assert.ok(Number.isInteger(tok) && tok > prev, `DPR ${d}: begun, a new positive token (${tok})`);
    prev = tok;
    if (!first) assert.equal(wet.stats().allocs, 7, 'the first begin: the canvas, the ring, the predicted slot, the trail canvas and the held table\'s three arrays');
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
  for (const name of ['push', 'onWetFrame', 'place', 'schedule', 'shiftKept', 'trailFrame', 'onViewportChange']) {
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
  // A begin while active holds the previous stroke on the trail (U615,
  // WET@trail): the live canvas carries a fresh stroke, its samples gone.
  wet.push([sample(41, 101, 1), sample(42, 102, 2)]);
  assert.ok(wet.begin(sheet(), { pointerId: 14 }));
  assert.equal(wet.stats().held, 1, 'the previous stroke is on the trail');
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
  // A removal counts only when it names the added handler with the same capture flag (an unmatched
  // remove leaves the listener in place), and each phase is read as a delta, so a listener a
  // detach left behind and the next begin swept up never passes for the detach's own removal.
  const added = [];
  const removed = [];
  const captureOf = (o) => (typeof o === 'object' && o !== null ? !!o.capture : !!o);
  root.addEventListener = function add(type, fn, o) {
    if (type === 'scroll') added.push({ fn, capture: captureOf(o) });
    return W.ShadowRoot.prototype.addEventListener.call(this, type, fn, o);
  };
  root.removeEventListener = function rm(type, fn, o) {
    if (type === 'scroll' && added.some((a) => a.fn === fn && a.capture === captureOf(o))) removed.push(fn);
    return W.ShadowRoot.prototype.removeEventListener.call(this, type, fn, o);
  };
  try {
    assert.ok(wet.begin(sheet(), { pointerId: 18 }));
    assert.equal(removed.length, 0, 'the begin found no listener left by an earlier stroke');
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
    let r0 = removed.length;
    wet.end();
    flush();
    assert.equal(added.length, 1, 'one scroll listener for the stroke');
    assert.equal(removed.length - r0, 1, 'removed at the detach');
    const idle = rafCalls;
    root.querySelector('p.cap').dispatchEvent(new W.Event('scroll'));
    assert.equal(rafCalls, idle, 'no frame while no stroke is active');
    // A cancel removes it too; a begin over a light-DOM target adds none; a begin over a held
    // stroke in the shadow root swaps the listener out, so that root's scroll asks for no frame.
    assert.ok(wet.begin(sheet(), { pointerId: 19 }));
    r0 = removed.length;
    wet.cancel();
    assert.equal(removed.length - r0, 1, 'a cancel removes it');
    const light = W.document.createElement('div');
    W.document.body.appendChild(light);
    rects.set(light, { left: 0, top: 0, width: 50, height: 50 });
    try {
      assert.ok(wet.begin(light, { pointerId: 20 }));
      assert.equal(added.length, 2, 'a target in the document: no shadow-root listener');
      wet.cancel();
      assert.ok(wet.begin(sheet(), { pointerId: 21 }));
      assert.equal(added.length, 3);
      r0 = removed.length;
      assert.ok(wet.begin(light, { pointerId: 22 }), 'a begin over the held stroke');
      assert.equal(removed.length - r0, 1, 'the held stroke\'s shadow-root listener is removed at the new begin');
      const held = rafCalls;
      root.querySelector('p.cap').dispatchEvent(new W.Event('scroll'));
      assert.equal(rafCalls, held, 'a scroll in the old target\'s shadow root asks for no frame');
      wet.cancel();
    } finally {
      rects.delete(light);
      light.remove();
    }
  } finally {
    delete root.addEventListener;
    delete root.removeEventListener;
    rects.set(sheet(), { left: 40, top: 100, width: 300, height: 200 });
  }
});

// ── tranche 5, U615 ─────────────────────────────────────────────────────────

test('a page target (#main, 1,100 × 20,000 CSS px) at DPR 2: the canvas is the well\'s visible part, never over the viewport × dpr; a gutter sample is kept (WET@clip-viewport, REQ@margins)', () => {
  const main = W.document.getElementById('main');
  rects.set(main, { left: 90, top: -5000, width: 1100, height: 20000 });
  setDpr(2);
  try {
    const tok = wet.begin(main, { pointerId: 30 });
    assert.ok(tok > 0, 'a page target begins');
    const [c] = wetCanvases();
    assert.ok(c.width <= VIEW.width * 2 && c.height <= VIEW.height * 2, `${c.width} × ${c.height}: within the viewport × dpr`);
    assert.ok(c.width * c.height <= VIEW.width * VIEW.height * 2 * 2, 'its area within the viewport × dpr²');
    assert.ok(c.width * c.height <= 16777216, 'under iOS Safari\'s canvas area cap');
    assert.deepStrictEqual([c.style.left, c.style.top, c.style.width, c.style.height],
      [`${WELL.left}px`, `${WELL.top}px`, `${WELL.width}px`, `${WELL.height}px`], 'the well\'s visible part, gutters included');
    assert.deepStrictEqual([c.width, c.height], [WELL.width * 2, WELL.height * 2]);
    // A sample in the gutter, left of the column (#main starts at 90), is kept against the clip's origin.
    wet.push([sample(30, 300, 1), sample(600, 400, 2)]);
    let seen = null;
    wet.paint((x, view) => { seen = [view.x(0), view.y(0), view.x(1), view.y(1)]; });
    flush();
    assert.deepStrictEqual(seen, [30, 300 - WELL.top, 600, 400 - WELL.top]);
    // The well scrolls under the page stroke: the clip stays, the kept samples move with #main.
    rects.set(main, { left: 90, top: -5200, width: 1100, height: 20000 });
    const live = ctxOf(c);
    const clears = live.calls.filter((k) => k[0] === 'clearRect').length;
    W.dispatchEvent(new W.Event('scroll'));
    let fresh = -1;
    wet.paint((x, view) => { seen = [view.x(0), view.y(0), view.x(1), view.y(1)]; fresh = view.fresh; });
    flush();
    assert.deepStrictEqual(seen, [30, 100 - WELL.top, 600, 200 - WELL.top], 'the kept samples followed the content');
    assert.equal(fresh, 2, 'every kept sample fresh');
    assert.ok(live.calls.filter((k) => k[0] === 'clearRect').length > clears, 'the canvas cleared for the redraw');
    assert.equal(c.style.top, `${WELL.top}px`, 'the clip did not move');
  } finally {
    rects.delete(main);
  }
});

test('a scroll mid-stroke moves the clip; the kept samples move with the target and a push reads the new clip origin', () => {
  // The sheet starts above the well's top edge (32): the clip is its visible part.
  const r = { left: 40, top: 20, width: 300, height: 200 };
  rects.set(sheet(), r);
  try {
    assert.ok(wet.begin(sheet(), { pointerId: 31 }));
    const [c] = wetCanvases();
    assert.deepStrictEqual([c.style.left, c.style.top, c.style.width, c.style.height], ['40px', '32px', '300px', '188px'], 'the sheet ∩ the well');
    wet.push([sample(50, 60, 1)]);
    let seen = null;
    wet.paint((x, view) => { seen = [view.x(0), view.y(0)]; });
    flush();
    assert.deepStrictEqual(seen, [10, 28], 'against the clip\'s origin (40, 32)');
    // The page scrolls back: the sheet's top at 60, all of it inside the well.
    r.top = 60;
    W.dispatchEvent(new W.Event('scroll'));
    flush();
    assert.deepStrictEqual([c.style.top, c.style.height], ['60px', '200px'], 'the clip moved');
    wet.push([sample(50, 110, 2)]);
    wet.paint((x, view) => { seen = [view.x(0), view.y(0), view.x(1), view.y(1)]; });
    flush();
    assert.deepStrictEqual(seen, [10, 40, 10, 50], 'the kept sample moved with the sheet; the push reads the new origin (40, 60)');
  } finally {
    rects.set(sheet(), { left: 40, top: 100, width: 300, height: 200 });
  }
});

test('a target in a nested shadow root follows a scroll dispatched on the OUTER root; both roots unheard after the detach', () => {
  const outer = rootOf('wet-pane');
  const host = W.document.createElement('div');
  host.className = 'nested-host';
  outer.appendChild(host);
  const inner = host.attachShadow({ mode: 'open' });
  const deep = W.document.createElement('div');
  inner.appendChild(deep);
  const r = { left: 60, top: 120, width: 100, height: 80 };
  rects.set(deep, r);
  try {
    assert.ok(wet.begin(deep, { pointerId: 32 }));
    const [c] = wetCanvases();
    flush();
    r.top = 140;
    const before = rafCalls;
    outer.querySelector('p.cap').dispatchEvent(new W.Event('scroll'));
    assert.equal(rafCalls - before, 1, 'a scroll on the outer shadow root asks for one frame');
    flush();
    assert.equal(c.style.top, '140px', 'the canvas follows the nested target');
    r.top = 150;
    deep.dispatchEvent(new W.Event('scroll'));
    flush();
    assert.equal(c.style.top, '150px', 'its own root still heard');
    wet.end();
    flush();
    const idle = rafCalls;
    outer.querySelector('p.cap').dispatchEvent(new W.Event('scroll'));
    deep.dispatchEvent(new W.Event('scroll'));
    assert.equal(rafCalls, idle, 'no listener left on either root');
  } finally {
    rects.delete(deep);
    host.remove();
  }
});

test('a second begin before end(N) keeps stroke N on the trail until end(N); cancel(N) clears it at once (WET@trail)', () => {
  const draw = (g, view) => {
    view.clear();
    g.beginPath();
    for (let i = 0; i < view.count; i++) g.lineTo(view.x(i), view.y(i));
    g.stroke();
  };
  const n = wet.begin(sheet(), { pointerId: 40 });
  const [c] = wetCanvases();
  wet.push([sample(50, 110, 1), sample(60, 120, 2)]);
  wet.paint(draw);
  flush();
  // Samples pushed and asked for, not yet painted, when the next pen comes down.
  wet.push([sample(70, 130, 3)]);
  wet.paint(draw);
  const at = allCalls.length;
  const m = wet.begin(sheet(), { pointerId: 41 });
  assert.ok(m > n, 'a new token');
  const t = trailCanvas();
  assert.ok(t && t.isConnected, 'the trail is laid');
  assert.equal(t.parentNode, W.document.body);
  assert.equal(t.nextSibling, c, 'just before the live canvas');
  assert.deepStrictEqual([t.style.position, t.style.pointerEvents, t.style.zIndex, t.getAttribute('aria-hidden')], ['fixed', 'none', 'var(--z-pins)', 'true']);
  assert.deepStrictEqual([t.style.left, t.style.top, t.style.width, t.style.height], ['0px', '0px', `${VIEW.width}px`, `${VIEW.height}px`], 'over the layout viewport');
  const tc = ctxOf(t);
  assert.ok(tc, 'the trail took its context at its first hold');
  const trailClears = () => tc.calls.filter((k) => k[0] === 'clearRect').length;
  const tc0 = trailClears();
  const since = allCalls.slice(at);
  const painted = since.findIndex((k) => k[0] === 'el-wet' && k[1] === 'lineTo' && k[2] === 30 && k[3] === 30);
  const copied = since.findIndex((k) => k[0] === 'el-wet-trail' && k[1] === 'drawImage');
  const cleared = since.findIndex((k, i) => i > copied && k[0] === 'el-wet' && k[1] === 'clearRect');
  assert.ok(painted >= 0 && painted < copied, 'the unpainted tail was painted before the copy');
  assert.ok(copied >= 0 && copied < cleared, 'copied onto the trail, then the live canvas cleared for the new stroke');
  assert.equal(since.filter((k) => k[0] === 'el-wet-trail' && k[1] === 'drawImage').length, 1, 'one drawImage');
  assert.deepStrictEqual(since[copied].slice(2), [c, 40, 100, 300, 200], 'at the two canvases\' placement offset');
  assert.equal(wet.stats().held, 1);
  // Stroke m draws and ends; frames run; stroke n stays wet on the trail.
  wet.push([sample(80, 140, 4)]);
  wet.paint(draw);
  flush();
  assert.equal(wet.end(), true, 'end() bare ends the active stroke');
  flush();
  assert.equal(c.parentNode, null, 'the live canvas detached');
  assert.ok(t.isConnected, 'stroke N still wet');
  assert.equal(trailClears() - tc0, 0, 'no clearRect of the trail');
  assert.equal(wet.end(m), false, 'm already ended');
  // end(N): the trail dries at the next frame, after N's dry marker paints.
  assert.equal(wet.end(n), true);
  assert.ok(t.isConnected, 'still laid until the frame');
  assert.equal(flush(), 1);
  assert.equal(t.parentNode, null, 'the trail detached');
  assert.equal(trailClears() - tc0, 1, 'and cleared');
  assert.equal(wet.stats().held, 0);
  assert.equal(wet.end(n), false, 'a released token ends nothing');
  // cancel(N) of a held stroke clears the trail at once; the active stroke goes on.
  const a = wet.begin(sheet(), { pointerId: 42 });
  wet.push([sample(50, 110, 5)]);
  wet.paint(draw);
  flush();
  const b = wet.begin(sheet(), { pointerId: 43 });
  assert.ok(t.isConnected && wet.stats().held === 1);
  assert.equal(wet.cancel(a), true);
  assert.equal(t.parentNode, null, 'cleared at once (a failed save)');
  assert.equal(wet.stats().held, 0);
  assert.equal(wet.active(), true, 'stroke b is untouched');
  assert.equal(wet.cancel(a), false);
  assert.equal(wet.end(a), false, 'a stale token never ends the active stroke');
  assert.equal(wet.active(), true);
  assert.equal(wet.cancel(b), true, 'cancel(token) of the active stroke drops it');
  assert.equal(wet.active(), false);
});

test('WET_HOLD_MS releases a trail no end names; an ended stroke a begin catches dries at the next frame; the trail follows a scroll', () => {
  assert.ok(WL.WET_HOLD_MS > 0 && WL.WET_HOLD_MS <= 1500, `WET_HOLD_MS ${WL.WET_HOLD_MS}`);
  const r = { left: 40, top: 100, width: 300, height: 200 };
  rects.set(sheet(), r);
  try {
    wet.begin(sheet(), { pointerId: 50 });
    wet.push([sample(50, 110, 1)]);
    wet.paint(() => {});
    flush();
    assert.equal(timers.length, 0, 'no timer while nothing is held');
    wet.begin(sheet(), { pointerId: 51 });   // the caller never names stroke 50 (the pack at 9e633b7, the fixture)
    const t = trailCanvas();
    assert.equal(wet.stats().held, 1);
    assert.equal(timers.length, 1, 'one hold timer');
    assert.equal(timers[0].ms, WL.WET_HOLD_MS);
    // The trail follows a scroll at the frame (one rect read: the same target's, already read).
    r.top = 70;
    W.dispatchEvent(new W.Event('scroll'));
    flush();
    assert.deepStrictEqual([t.style.left, t.style.top], ['0px', '-30px'], 'the trail moved with the sheet');
    assert.equal(flush(), 0, 'and no frame runs after it (no idle loop)');
    // The active stroke ends bare; the trail still waits for its timer.
    assert.equal(wet.end(), true);
    flush();
    assert.equal(wet.active(), false);
    assert.ok(t.isConnected, 'held past the active stroke\'s end');
    // With no stroke active the trail still follows a scroll, reading its target's rect.
    r.top = 60;
    W.dispatchEvent(new W.Event('scroll'));
    assert.equal(flush(), 1);
    assert.equal(t.style.top, '-40px');
    assert.equal(fireTimers(), 1);
    assert.equal(t.parentNode, null, 'WET_HOLD_MS released it');
    assert.equal(wet.stats().held, 0);
    const idle = rafCalls;
    W.dispatchEvent(new W.Event('scroll'));
    assert.equal(rafCalls, idle, 'nothing held, nothing active: a scroll asks for no frame');
    // A stroke already ended when the next pen comes down: held without a timer, dry at the next frame.
    wet.begin(sheet(), { pointerId: 52 });
    wet.push([sample(50, 110, 2)]);
    wet.paint(() => {});
    flush();
    wet.end();
    wet.begin(sheet(), { pointerId: 53 });
    assert.ok(t.isConnected && wet.stats().held === 1, 'the ended stroke is on the trail');
    assert.equal(timers.length, 0, 'its end came: no hold timer');
    assert.equal(flush(), 1);
    assert.equal(t.parentNode, null, 'dried at the next frame');
    assert.equal(wet.active(), true, 'the new stroke is untouched');
  } finally {
    rects.set(sheet(), { left: 40, top: 100, width: 300, height: 200 });
  }
});

test('10,000 samples with a hold every 1,000: stats().allocs unchanged after the first begin, the trail canvas included; nothing created', () => {
  assert.ok(wet.begin(sheet(), { pointerId: 60 }));
  const a0 = wet.stats().allocs;
  const t0 = trailCanvas();
  let created = 0;
  const realCreate = W.document.createElement;
  W.document.createElement = function createElement(...a) { created++; return realCreate.apply(this, a); };
  try {
    const batch = [sample(0, 0, 0), sample(0, 0, 0), sample(0, 0, 0), sample(0, 0, 0)];
    const opts = { predicted: [sample(0, 0, 0)] };
    let trail = null;
    for (let n = 0; n < 10000; n += 4) {
      for (let j = 0; j < 4; j++) {
        batch[j].clientX = 40 + ((n + j) % 300);
        batch[j].clientY = 100 + ((n + j) % 200);
        batch[j].timeStamp = n + j;
      }
      assert.equal(wet.push(batch, opts), 4);
      if (n % 1000 === 996) {
        wet.paint(() => {});
        flush();
        assert.ok(wet.begin(sheet(), { pointerId: 61 + n }));   // the next pen: the previous stroke held
        if (!trail) trail = trailCanvas();
        assert.equal(trailCanvas(), trail, 'one trail canvas');
        if (n % 3000 === 996) fireTimers();
      }
    }
    assert.ok(trail && (t0 === null || t0 === trail));
    assert.equal(wet.stats().allocs, a0, 'no allocation per sample, per push or per hold');
    assert.equal(created, 0, 'no element created');
  } finally {
    W.document.createElement = realCreate;
  }
});

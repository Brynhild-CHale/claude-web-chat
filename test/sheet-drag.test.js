// The phone pull's gesture machine (public/app/sheet-drag.js), in plain node:
// no DOM, a handle and a document that are bare EventTargets, pointer events
// that are plain Events carrying the fields the module reads, and a hand-run
// animation frame. What a gesture does to the sheet (the snap, the 40 px push,
// the arrow steps) is sheet-model.js's and pinned there; here, that the drag
// follows ONE pointer, writes at most once per frame, settles where the model
// says, never treats a drag, a sideways swipe or a cancel as a tap, hands a
// sideways drag of a closed sheet to the one dock handler, and leaves nothing
// on the document between gestures or on the handle after detach().
// test/chat-sheet.test.js drives the same module through the real shell.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const APP = path.resolve(__dirname, '..', 'public/app');
let D;   // sheet-drag.js
let M;   // sheet-model.js

// An EventTarget that counts its listeners, so a test can see what is left.
class Target extends EventTarget {
  constructor() { super(); this.live = new Map(); }
  addEventListener(type, fn, opts) {
    const k = `${type}|${typeof opts === 'object' ? !!opts.capture : !!opts}`;
    const set = this.live.get(k) || new Set();
    set.add(fn);
    this.live.set(k, set);
    super.addEventListener(type, fn, opts);
  }
  removeEventListener(type, fn, opts) {
    const k = `${type}|${typeof opts === 'object' ? !!opts.capture : !!opts}`;
    const set = this.live.get(k);
    if (set) set.delete(fn);
    super.removeEventListener(type, fn, opts);
  }
  count() { let n = 0; for (const s of this.live.values()) n += s.size; return n; }
}

function rig({ height = 0, closed = true, enabled = true } = {}) {
  const doc = new Target();
  doc.defaultView = { innerWidth: 390 };
  const handle = new Target();
  handle.ownerDocument = doc;
  handle.captured = [];
  handle.setPointerCapture = (id) => handle.captured.push(['set', id]);
  handle.releasePointerCapture = (id) => handle.captured.push(['release', id]);
  const state = { h: height, closed, enabled, moves: [], settles: [] };
  const detach = D.attachSheetDrag(handle, {
    stops: () => M.computeStops(644),
    height: () => state.h,
    enabled: () => state.enabled,
    closed: () => state.closed,
    onMove: (px) => state.moves.push(px),
    onSettle: (px, info) => { state.settles.push([px, info.from]); state.h = px; state.closed = px === 0; },
  });
  return { doc, handle, state, detach };
}

function ev(type, fields = {}) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { pointerType: 'touch', button: 0, clientX: 0, clientY: 0, ...fields });
  return e;
}
const down = (r, id, x, y) => r.handle.dispatchEvent(ev('pointerdown', { pointerId: id, clientX: x, clientY: y }));
const move = (r, id, x, y) => r.doc.dispatchEvent(ev('pointermove', { pointerId: id, clientX: x, clientY: y }));
const up = (r, id, x, y, type = 'pointerup') => (type === 'lostpointercapture' ? r.handle : r.doc)
  .dispatchEvent(ev(type, { pointerId: id, clientX: x, clientY: y }));
function click(r) {
  const e = new Event('click', { cancelable: true });
  let reached = false;
  const fn = () => { reached = true; };
  r.handle.addEventListener('click', fn);
  r.handle.dispatchEvent(e);
  r.handle.removeEventListener('click', fn);
  return { prevented: e.defaultPrevented, reached };
}

// A hand-run animation frame.
let frames = [];
const flush = () => { const f = frames; frames = []; for (const fn of f) fn(0); };

test.before(async () => {
  D = await import(pathToFileURL(path.join(APP, 'sheet-drag.js')).href);
  M = await import(pathToFileURL(path.join(APP, 'sheet-model.js')).href);
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  globalThis.cancelAnimationFrame = () => { frames = []; };
});
test.after(() => {
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});
test.beforeEach(() => { frames = []; });

test('a vertical drag: one onMove per frame with the latest height, then the snap; its click is swallowed', () => {
  const r = rig();
  down(r, 1, 300, 700);
  for (let y = 690; y >= 655; y -= 5) move(r, 1, 300, y);
  assert.deepEqual(r.state.moves, [], 'nothing before the frame');
  flush();
  assert.deepEqual(r.state.moves, [45], 'one frame, the latest height');
  up(r, 1, 300, 655);
  assert.deepEqual(r.state.settles, [[341, 0]], '45 px up from closed opens half');
  assert.deepEqual(r.handle.captured, [['set', 1], ['release', 1]]);
  const c = click(r);
  assert.equal(c.prevented, true);
  assert.equal(c.reached, false, 'the click after a drag reaches no one');
  assert.equal(click(r).reached, true, 'only that one click');
  r.detach();
});

test('the snap follows the model: 42 px down from full → half, 30 px from half stays', () => {
  const r = rig({ height: 622, closed: false });
  down(r, 1, 300, 100);
  move(r, 1, 300, 142);
  up(r, 1, 300, 142);
  assert.deepEqual(r.state.settles.pop(), [341, 622]);
  down(r, 2, 300, 100);
  move(r, 2, 300, 70);
  up(r, 2, 300, 70);
  assert.deepEqual(r.state.settles.pop(), [341, 341]);
  r.detach();
});

test('a tap is not handled here: no settle, and its click goes through', () => {
  const r = rig();
  down(r, 1, 300, 700);
  move(r, 1, 303, 696);
  up(r, 1, 303, 696);
  assert.deepEqual(r.state.settles, []);
  assert.deepEqual(click(r), { prevented: false, reached: true });
  r.detach();
});

test('a sideways swipe with no dock handler moves nothing and is no tap', () => {
  const r = rig();
  down(r, 1, 300, 700);
  move(r, 1, 280, 700);
  flush();
  up(r, 1, 280, 700);
  assert.deepEqual(r.state.moves, []);
  assert.deepEqual(r.state.settles, []);
  assert.equal(click(r).reached, false);
  r.detach();
});

test('pointercancel and lostpointercapture settle to the nearest stop, never a tap', () => {
  const r = rig();
  down(r, 1, 300, 700);
  move(r, 1, 300, 500);
  up(r, 1, 300, 500, 'pointercancel');
  assert.deepEqual(r.state.settles.pop(), [341, 0], '200 up: the nearest stop, no push');
  assert.equal(click(r).reached, false);
  down(r, 2, 300, 700);
  up(r, 2, 300, 700, 'lostpointercapture');
  assert.deepEqual(r.state.settles.pop(), [341, 341], 'a still pointer whose capture went: where it was');
  assert.equal(click(r).reached, false, 'and its click is not a tap');
  r.detach();
});

test('the first pointer is tracked; a second is ignored until it ends', () => {
  const r = rig();
  down(r, 1, 300, 700);
  down(r, 2, 100, 700);
  move(r, 2, 100, 400);
  move(r, 1, 300, 650);
  flush();
  assert.deepEqual(r.state.moves, [50]);
  up(r, 2, 100, 400);
  assert.deepEqual(r.state.settles, [], 'the second pointer\'s release ends nothing');
  up(r, 1, 300, 650);
  assert.deepEqual(r.state.settles, [[341, 0]]);
  r.detach();
});

test('a frame pending at release is cancelled: no onMove after the settle', () => {
  const r = rig();
  down(r, 1, 300, 700);
  move(r, 1, 300, 600);
  up(r, 1, 300, 600);
  flush();
  assert.deepEqual(r.state.moves, []);
  assert.equal(r.state.settles.length, 1);
  r.detach();
});

test('the dock handler: begin/move/end for a closed sheet\'s sideways drag; never while open; one at a time', () => {
  const calls = [];
  const off = D.setDockHandler({
    begin: (d) => calls.push(['begin', d.x, d.width]), move: (d) => calls.push(['move', d.dx]),
    end: (d) => calls.push(['end', d.dx, d.x, d.width, d.cancelled]),
  });
  const r = rig();
  down(r, 1, 300, 700);
  move(r, 1, 250, 702);
  move(r, 1, 120, 704);
  up(r, 1, 120, 704);
  assert.deepEqual(calls, [['begin', 300, 390], ['move', -50], ['move', -180], ['end', -180, 120, 390, false]]);
  assert.deepEqual(r.state.settles, [], 'the sheet did not move');
  assert.equal(click(r).reached, false);
  calls.length = 0;
  down(r, 2, 300, 700);
  move(r, 2, 250, 700);
  up(r, 2, 250, 700, 'pointercancel');
  assert.deepEqual(calls.at(-1), ['end', -50, 250, 390, true], 'a cancel says so');
  calls.length = 0;
  r.state.closed = false;
  r.state.h = 341;
  down(r, 3, 300, 700);
  move(r, 3, 120, 700);
  up(r, 3, 120, 700);
  assert.deepEqual(calls, [], 'an open sheet never docks');
  off();
  assert.equal(D.dockHandler(), null);
  const a = { begin() {}, move() {}, end() {} };
  const b = { begin() {}, move() {}, end() {} };
  const offA = D.setDockHandler(a);
  D.setDockHandler(b);
  offA();
  assert.equal(D.dockHandler(), b, 'a stale unregister does nothing');
  D.setDockHandler(a)();
  assert.equal(D.dockHandler(), null);
  r.detach();
});

test('ArrowUp/ArrowDown step the stops and preventDefault; nothing while disabled', () => {
  const r = rig();
  const key = (k) => { const e = new Event('keydown', { cancelable: true }); e.key = k; r.handle.dispatchEvent(e); return e; };
  assert.equal(key('ArrowUp').defaultPrevented, true);
  assert.equal(r.state.h, 341);
  key('ArrowUp');
  assert.equal(r.state.h, 622);
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(r.state.h, 0);
  assert.equal(key('Enter').defaultPrevented, false, 'other keys are not the drag\'s');
  r.state.enabled = false;
  key('ArrowUp');
  down(r, 1, 300, 700);
  move(r, 1, 300, 600);
  up(r, 1, 300, 600);
  assert.equal(r.state.h, 0, 'disabled (the keyboard\'s .kb): no step, no drag');
  r.detach();
});

test('nothing stays on the document between gestures; detach() takes the handle\'s three', () => {
  const r = rig();
  assert.equal(r.doc.count(), 0);
  assert.equal(r.handle.count(), 3, 'pointerdown, keydown and the click swallower');
  for (let i = 0; i < 30; i++) {
    down(r, i, 300, 700);
    move(r, i, 300, i % 2 ? 640 : 760);
    if (i % 3 === 0) up(r, i, 300, 640, 'pointercancel');
    else up(r, i, 300, 640);
    assert.equal(r.doc.count(), 0, `after gesture ${i}`);
    assert.equal(r.handle.count(), 3);
  }
  down(r, 99, 300, 700);
  assert.equal(r.doc.count(), 3, 'during a gesture: move, up, cancel');
  r.detach();
  assert.equal(r.doc.count(), 0, 'detach mid-gesture removes them too');
  assert.equal(r.handle.count(), 0);
});

test('bad arguments are refused', () => {
  assert.throws(() => D.attachSheetDrag(null, {}), TypeError);
  assert.throws(() => D.attachSheetDrag(new Target(), { stops() {} }), TypeError);
  assert.throws(() => D.setDockHandler({ begin() {}, move() {} }), TypeError);
});

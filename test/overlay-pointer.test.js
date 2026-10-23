// The overlay's pointer path after a press the well never heard end (annotation
// engine 2A.1; public/app/overlay.js onPointer and gestureOfClick; U302b,
// DECISIONS.md K.2-49). The real chrome (test-support/chrome-shell, booted
// once, main.js's input-mode policy installed); synthetic PointerEvents walk
// the real dispatch.
//
// Pinned here:
//   - a mouse pressed in a pane with a taps tool armed and released outside
//     #main leaves its gesture not up; a click that names no pointer and that
//     no pointer made (a MouseEvent, detail 0) takes no such gesture: the
//     pane's button acts and no pin drops;
//   - a pointermove reporting no button down (buttons 0) on that not-up entry
//     is a hover: it is not default-prevented, the pane hears it, and the stale
//     gesture is gone (a later hover is the pane's too); a pressed move of a
//     live stroke (buttons 1) is still the tool's;
//   - shell.press is a faithful press (pointerdown, pointerup, a click of
//     detail 1): its click takes its own gesture through the no-pointerId
//     fallback, so the armed taps tool gets it and the page does not.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

let shell, W, M, ov, IM;

const PANE = (id) => ({
  id, target: 'main', params: {},
  html: `<p class="lead">lead of ${id}</p><button class="go">Go</button><script>
    root.querySelector('.go').addEventListener('click', function () { window.__goClicks.push(mountId); });
  </script>`,
});

before(async () => {
  shell = await bootShell({});
  W = shell.window;
  M = W.__wcMount;
  W.__goClicks = [];
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE('p1')] }));
  await shell.tick();
});
after(async () => {
  if (ov) ov.setArmed(null);
  if (W) W.localStorage.removeItem('wc:finger-draws');
  if (shell) await shell.restore();
});

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const lead = (id) => rootOf(id).querySelector('p.lead');
const goBtn = (id) => rootOf(id).querySelector('button.go');

function pe(el, type, pointerType, pointerId, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true, clientX: 100, clientY: 100,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  el.dispatchEvent(ev);
  return ev;
}
// What the page heard inside a pane: the shadow root's own listeners, which an
// event the overlay swallows on the well never reaches.
function pageLog(id) {
  const log = [];
  const root = rootOf(id);
  const fns = ['pointerdown', 'pointermove', 'pointerup', 'click'].map((t) => {
    const fn = (e) => log.push(`${t}:${e.pointerType || ''}:${e.pointerId}`);
    root.addEventListener(t, fn);
    return [t, fn];
  });
  Object.defineProperty(log, 'off', { value: () => { for (const [t, fn] of fns) root.removeEventListener(t, fn); } });
  return log;
}
// A mouse pressed on the pane's text and released over the chrome, outside
// #main: the well never hears its pointerup, so its gesture stays not up.
function pressReleasedOutside(pointerId) {
  pe(lead('p1'), 'pointerdown', 'mouse', pointerId);
  pe(W.document.body, 'pointerup', 'mouse', pointerId);
}

test('after a mouse released outside #main, a click no pointer made (a MouseEvent, detail 0) on the pane\'s button acts and drops no pin', () => {
  IM.setFingerDraws('off');
  const created = [];
  const off = ov.registerType('opt', { draw() {}, input: 'taps', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}`) });
  try {
    ov.setArmed('opt');
    W.__goClicks = [];
    pressReleasedOutside(1);
    const c = new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 0 });
    goBtn('p1').dispatchEvent(c);
    assert.deepEqual(W.__goClicks, ['p1'], 'the button acted');
    assert.deepEqual(created, [], 'no pin on the button');
    assert.equal(c.defaultPrevented, false, 'the click kept its default');
  } finally {
    ov.setArmed(null);
    off();
  }
});

test('a hover move (buttons 0) on a not-up entry is the page\'s: not prevented, the pane hears it, and the stale gesture is gone', () => {
  IM.setFingerDraws('off');
  const created = [];
  const offTaps = ov.registerType('opt', { draw() {}, input: 'taps', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}`) });
  const offStrokes = ov.registerType('ops', { draw() {}, input: 'strokes', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}:${inp.event.pointerId}`) });
  const log = pageLog('p1');
  try {
    ov.setArmed('opt');
    pressReleasedOutside(1);
    log.length = 0;
    const mv = pe(goBtn('p1'), 'pointermove', 'mouse', 1, { buttons: 0 });
    assert.equal(mv.defaultPrevented, false, 'the hover is not swallowed');
    assert.deepEqual(log, ['pointermove:mouse:1'], 'the pane heard it');
    const mv2 = pe(lead('p1'), 'pointermove', 'mouse', 1, { buttons: 0, clientX: 120 });
    assert.equal(mv2.defaultPrevented, false, 'nor the next one');
    assert.deepEqual(log, ['pointermove:mouse:1', 'pointermove:mouse:1']);
    // The gesture is gone: a later click with no pointer behind it is the button's.
    W.__goClicks = [];
    goBtn('p1').dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 0 }));
    assert.deepEqual(W.__goClicks, ['p1']);
    assert.deepEqual(created, [], 'no pin');
    // A live stroke's pressed moves (buttons 1) stay the tool's.
    ov.setArmed('ops');
    log.length = 0;
    pe(lead('p1'), 'pointerdown', 'mouse', 2);
    const pressed = pe(lead('p1'), 'pointermove', 'mouse', 2, { clientX: 130 });
    pe(lead('p1'), 'pointerup', 'mouse', 2, { clientX: 130 });
    assert.equal(pressed.defaultPrevented, true, 'a pressed move of the stroke is the tool\'s');
    assert.deepEqual(created, ['pointerdown:mouse:2', 'pointermove:mouse:2', 'pointerup:mouse:2'], 'the stroke whole');
    assert.deepEqual(log, [], 'the page heard none of the stroke');
  } finally {
    log.off();
    ov.setArmed(null);
    offTaps();
    offStrokes();
  }
});

test('shell.press is a faithful press: pointerdown, pointerup, a click of detail 1, and the armed taps tool takes its click', () => {
  IM.setFingerDraws('off');
  const created = [];
  const seen = [];
  const off = ov.registerType('opt', { draw() {}, input: 'taps', create: (inp) => created.push(inp.phase) });
  const btn = goBtn('p1');
  const fns = ['pointerdown', 'pointerup', 'click'].map((t) => {
    const fn = (e) => seen.push(`${t}:${e.detail}`);
    W.document.addEventListener(t, fn, true);
    return [t, fn];
  });
  try {
    shell.press(btn);
    assert.deepEqual(seen, ['pointerdown:0', 'pointerup:0', 'click:1'], 'the events a browser sends, in order');
    seen.length = 0;
    ov.setArmed('opt');
    W.__goClicks = [];
    shell.press(btn);
    assert.deepEqual(created, ['click'], 'the tool took the press\'s click');
    assert.deepEqual(W.__goClicks, [], 'the page did not');
  } finally {
    for (const [t, fn] of fns) W.document.removeEventListener(t, fn, true);
    ov.setArmed(null);
    off();
  }
});

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
//     gesture is gone (a later hover, or a pressed move of that pointer, is
//     the pane's too); a pressed move of a live stroke (buttons 1) is still
//     the tool's;
//   - the kept fallback for a click that names no pointer: an up gesture
//     takes a click of detail 1 and never one of detail 0 (a script's click);
//   - shell.press is a faithful press (pointerdown, pointerup, a click of
//     detail 1): its click takes its own gesture through the no-pointerId
//     fallback, so the armed taps tool gets it and the page does not;
//   - (U516) a strokes tool's create gets input.samples (the browser's
//     coalesced list as given, else [the event]) and input.predicted (else
//     []), the raw event kept; a pointercancel's input, dispatched or through
//     cancelGesture, carries empty lists; a taps tool's input has neither.
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
    // The gesture is gone: a pressed move of that pointer (a press begun
    // outside the well, dragged in) is no gesture's either.
    const dragged = pe(lead('p1'), 'pointermove', 'mouse', 1, { buttons: 1, clientX: 125 });
    assert.equal(dragged.defaultPrevented, false, 'the stale gesture no longer takes its pointer');
    assert.deepEqual(log, ['pointermove:mouse:1', 'pointermove:mouse:1', 'pointermove:mouse:1']);
    // And a later click with no pointer behind it is the button's.
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

test('an up gesture whose own click never came: a click no pointer made (detail 0) is a lone click, one a pointer made (detail 1) is the gesture\'s', () => {
  IM.setFingerDraws('off');
  const created = [];
  const off = ov.registerType('opt', { draw() {}, input: 'taps', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}`) });
  try {
    ov.setArmed('opt');
    W.__goClicks = [];
    pe(lead('p1'), 'pointerdown', 'mouse', 3);
    pe(lead('p1'), 'pointerup', 'mouse', 3);
    goBtn('p1').dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 0 }));
    assert.deepEqual(W.__goClicks, ['p1'], 'detail 0 (a script\'s click) takes no gesture: the button acted');
    assert.deepEqual(created, [], 'and no pin dropped');
    pe(lead('p1'), 'pointerdown', 'mouse', 4);
    pe(lead('p1'), 'pointerup', 'mouse', 4);
    lead('p1').dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
    assert.deepEqual(created, ['click:mouse'], 'detail 1 takes the up gesture: the tool has it, as the mouse');
    assert.deepEqual(W.__goClicks, ['p1']);
  } finally {
    ov.setArmed(null);
    off();
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

// ── the samples (U516, plan 4A.2): coalesced and predicted, feature-detected ─
// A PointerEvent given (or stripped of) getCoalescedEvents / getPredictedEvents
// on the instance, as a browser that has (or lacks) them would hand it.
function sampled(el, type, pointerId, { coalesced, predicted, extra = {} } = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType: 'pen', pointerId, isPrimary: true, clientX: 100, clientY: 100,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  Object.defineProperty(ev, 'getCoalescedEvents', { configurable: true, value: coalesced === undefined ? undefined : () => coalesced });
  Object.defineProperty(ev, 'getPredictedEvents', { configurable: true, value: predicted === undefined ? undefined : () => predicted });
  el.dispatchEvent(ev);
  return ev;
}

test('a strokes tool\'s create gets input.samples (the coalesced list, else [event]) and input.predicted (else []), the raw event kept', () => {
  IM.setFingerDraws('off');
  const inputs = [];
  const off = ov.registerType('ops', { draw() {}, input: 'strokes', create: (inp) => inputs.push(inp) });
  try {
    ov.setArmed('ops');
    const c1 = { clientX: 101, clientY: 100 };
    const c2 = { clientX: 102, clientY: 101 };
    const coalesced = [c1, c2];
    const p1 = { clientX: 104, clientY: 102 };
    const predicted = [p1];
    const down = sampled(lead('p1'), 'pointerdown', 41, { coalesced: [], predicted: [] });
    const move = sampled(lead('p1'), 'pointermove', 41, { coalesced, predicted });
    const bare = sampled(lead('p1'), 'pointermove', 41, {});
    const up = sampled(lead('p1'), 'pointerup', 41, {});
    assert.deepStrictEqual(inputs.map((i) => i.phase), ['pointerdown', 'pointermove', 'pointermove', 'pointerup']);
    const [iDown, iMove, iBare, iUp] = inputs;
    assert.equal(iMove.event, move, 'the raw event kept');
    assert.equal(iMove.samples, coalesced, 'the browser\'s coalesced list, as given (never copied)');
    assert.equal(iMove.predicted, predicted, 'the browser\'s predicted list, as given');
    assert.ok(!iMove.samples.includes(p1), 'a predicted sample is flagged by being in input.predicted only');
    assert.equal(iDown.event, down);
    assert.deepStrictEqual(iDown.samples.length, 1, 'an empty coalesced list reads as [the event]');
    assert.equal(iDown.samples[0], down);
    assert.deepStrictEqual([...iDown.predicted], [], 'an empty predicted list stays empty');
    assert.equal(iBare.samples.length, 1, 'no getCoalescedEvents: [the event]');
    assert.equal(iBare.samples[0], bare);
    assert.deepStrictEqual([...iBare.predicted], [], 'no getPredictedEvents: []');
    assert.equal(iUp.samples[0], up);
    // The engine kept nothing: the arrays are the browser's own, unchanged.
    assert.deepStrictEqual(coalesced, [c1, c2]);
    assert.deepStrictEqual(predicted, [p1]);
  } finally {
    ov.setArmed(null);
    off();
  }
});

test('a pointercancel\'s input carries empty samples and predicted lists, dispatched or through cancelGesture; a taps tool gets neither field', () => {
  IM.setFingerDraws('off');
  const inputs = [];
  const off = ov.registerType('ops', { draw() {}, input: 'strokes', create: (inp) => inputs.push(inp) });
  const offTaps = ov.registerType('opt', { draw() {}, input: 'taps', create: (inp) => inputs.push(inp) });
  try {
    ov.setArmed('ops');
    sampled(lead('p1'), 'pointerdown', 42, {});
    sampled(lead('p1'), 'pointercancel', 42, { coalesced: [{ clientX: 1 }], predicted: [{ clientX: 2 }] });
    const cancelled = inputs.at(-1);
    assert.equal(cancelled.phase, 'pointercancel');
    assert.deepStrictEqual([[...cancelled.samples], [...cancelled.predicted]], [[], []], 'a dispatched cancel: nothing to draw');
    inputs.length = 0;
    sampled(lead('p1'), 'pointerdown', 43, {});
    assert.equal(ov.cancelGesture(43), true);
    const viaPan = inputs.at(-1);
    assert.equal(viaPan.phase, 'pointercancel');
    assert.deepStrictEqual([[...viaPan.samples], [...viaPan.predicted]], [[], []], 'cancelGesture\'s cancel: the same');
    inputs.length = 0;
    ov.setArmed('opt');
    shell.press(lead('p1'));
    assert.equal(inputs.length, 1, 'the taps tool took the click');
    assert.equal('samples' in inputs[0], false, 'a taps tool\'s input has no samples');
    assert.equal('predicted' in inputs[0], false);
  } finally {
    ov.setArmed(null);
    off();
    offTaps();
  }
});

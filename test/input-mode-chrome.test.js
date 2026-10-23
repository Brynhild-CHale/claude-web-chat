// The input-mode policy in the real chrome (annotation engine 2D.4;
// public/app/input-mode.js at overlay.js's one pointer dispatch). The real
// chrome (test-support/chrome-shell, booted once): main.js installs the policy
// right after the overlay; synthetic PointerEvents walk the real dispatch.
//
// Pinned here:
//   - installInputMode() is main.js's, once (a second call hands back the same
//     uninstall), and arming through overlay.js's setArmed is what the policy
//     reads (K.2-3: no second state);
//   - a pen over a pane is the armed tool's, on the pane's <button> too;
//   - a taps or selection type armed: a pen's or a mouse's pointerdown on the
//     pane's <button> has its default cancelled (no compatibility mousedown,
//     focus or selection starts in the pane, K.2-43); a finger's keeps its
//     default, on the button and on static content (D1);
//   - finger-draws off, a taps type armed: a finger tap on static content
//     reaches the tool; a finger tap on the pane's <button> fires the button
//     with the tool still armed (K.2-9, D1 (b)); a finger that travels past
//     TAP_SLOP never drops the tap; a click no pointer made (Enter or Space
//     on a focused control, a field's implicit submit: detail 0) is the
//     control's, the tool still armed;
//   - a strokes type armed: a finger drag goes to the page (drawing tools need
//     a pen or finger-draws), and with finger-draws on to the tool, the well
//     giving up its pan (html.finger-strokes);
//   - a second touch while a pen is down is ignored (neither tool nor page);
//   - the two older pointerType reads stay: a touch pointerenter on
//     #queue-rail does not open it (a mouse one does), and sheet-drag's mouse
//     button filter is the line it was;
//   - the stylesheet: the well's touch-action is manipulation (pinch-zoom under
//     html.finger-strokes), and every touch-action rule the chrome had before
//     is unchanged.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { createCascade } = require('../test-support/css-cascade');

const REPO = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');

let shell, W, M, ov, IM, TAP_SLOP;
const created = [];
let offTypes = [];

const PANE = {
  id: 'im1', target: 'main', params: {},
  html: `<p class="lead">static text</p><button class="go">Go</button><script>
    root.querySelector('.go').addEventListener('click', function () { window.__log.push('click:go'); });
    root.addEventListener('pointerdown', function (e) { window.__log.push('down:' + e.pointerType); });
    root.addEventListener('pointermove', function (e) { window.__log.push('move:' + e.pointerType); });
  </script>`,
};

before(async () => {
  shell = await bootShell({});
  W = shell.window;
  M = W.__wcMount;
  W.__log = [];
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  ({ TAP_SLOP } = await shell.importApp('sheet-model.js'));
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  await shell.tick();
  for (const input of ['taps', 'strokes', 'selection']) {
    offTypes.push(ov.registerType(`im-${input}`, { draw() {}, input, create: (inp) => created.push([`im-${input}`, inp.phase, inp.pointerType]) }));
  }
});
after(async () => {
  for (const off of offTypes) off();
  offTypes = [];
  if (ov) ov.setArmed(null);
  W.localStorage.removeItem('wc:finger-draws');
  W.localStorage.removeItem('wc:pen-seen');
  if (shell) await shell.restore();
});

const rootOf = () => M.itemEl(W.document, 'im1').el.shadowRoot;
const lead = () => rootOf().querySelector('p.lead');
const goBtn = () => rootOf().querySelector('button.go');
const reset = () => { created.length = 0; W.__log.length = 0; };

function pe(el, type, pointerType, extra = {}) {
  el.dispatchEvent(new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId: 1, isPrimary: true, clientX: 100, clientY: 100, ...extra,
  }));
}
// As Chrome sends it: the click is a PointerEvent carrying the pointer's type.
function click(el, pointerType) {
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType }));
}
// A whole tap (or, with a move, a drag): down, [move], up, click.
function gesture(el, pointerType, { pointerId = 1, move = 0 } = {}) {
  pe(el, 'pointerdown', pointerType, { pointerId });
  if (move) pe(el, 'pointermove', pointerType, { pointerId, clientX: 100 + move });
  pe(el, 'pointerup', pointerType, { pointerId, clientX: 100 + move });
  click(el, pointerType);
}

test('main.js installs the policy once; arming through overlay.js setArmed is what it reads', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/main.js'), 'utf8');
  assert.equal((src.match(/installInputMode\(\)/g) || []).length, 1, 'one call in main.js');
  assert.ok(src.indexOf('installInputMode();') > src.indexOf('initOverlay();'), 'after the overlay install');
  const a = IM.installInputMode();
  assert.equal(IM.installInputMode(), a, 'idempotent: the same uninstall');
  IM.setFingerDraws('off');
  // Nothing armed: the overlay does not listen, the finger is the page's.
  reset();
  gesture(lead(), 'touch');
  assert.deepEqual(created, []);
  // Armed through the overlay's one state, the policy sees it: a static tap
  // reaches the taps tool.
  ov.setArmed('im-taps');
  try {
    reset();
    gesture(lead(), 'touch');
    assert.deepEqual(created, [['im-taps', 'click', 'touch']]);
    ov.setArmed(null);
    reset();
    gesture(lead(), 'touch');
    assert.deepEqual(created, [], 'disarmed (the pointer tool): every pointer is the page\'s');
    assert.ok(W.__log.includes('down:touch'));
  } finally { ov.setArmed(null); }
});

test('a pen over a pane is the armed tool\'s, on the pane\'s button too', () => {
  IM.setFingerDraws('off');
  ov.setArmed('im-taps');
  try {
    reset();
    gesture(goBtn(), 'pen', { pointerId: 7 });
    assert.deepEqual(created, [['im-taps', 'click', 'pen']], 'the pen is always the tool (K.2-9)');
    assert.deepEqual(W.__log, [], 'the button never heard it');
    reset();
    gesture(goBtn(), 'mouse');
    assert.deepEqual(created, [['im-taps', 'click', 'mouse']], 'the mouse as the pen');
  } finally { ov.setArmed(null); }
});

test('a taps or selection tool armed: a pen\'s or a mouse\'s pointerdown on the pane\'s button is cancelled, a finger\'s is not', () => {
  IM.setFingerDraws('off');
  const down = (el, pointerType, pointerId) => {
    const ev = new W.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true, clientX: 100, clientY: 100,
    });
    el.dispatchEvent(ev);
    pe(el, 'pointerup', pointerType, { pointerId });
    return ev.defaultPrevented;
  };
  try {
    for (const type of ['im-taps', 'im-selection']) {
      ov.setArmed(type);
      reset();
      assert.equal(down(goBtn(), 'pen', 51), true, `${type}: a pen on the button is wholly the tool's (K.2-43)`);
      assert.equal(down(goBtn(), 'mouse', 52), true, `${type}: the mouse as the pen`);
      assert.equal(down(goBtn(), 'touch', 53), false, `${type}: a finger on the button keeps its default (D1)`);
      assert.equal(down(lead(), 'touch', 54), false, `${type}: a finger on static content keeps its default`);
      assert.deepEqual(W.__log.filter((l) => l !== 'down:touch'), [], 'the page heard only the finger on the button');
    }
  } finally { ov.setArmed(null); }
});

test('finger-draws off, a taps type armed: a static tap is the tool\'s, a tap on the button is the button\'s, the tool stays armed', () => {
  IM.setFingerDraws('off');
  ov.setArmed('im-taps');
  try {
    reset();
    gesture(lead(), 'touch');
    assert.deepEqual(created, [['im-taps', 'click', 'touch']], 'D1 (b): a finger tap on static content');
    reset();
    gesture(goBtn(), 'touch');
    assert.deepEqual(created, [], 'not the tool');
    assert.ok(W.__log.includes('click:go'), 'the control acted');
    assert.deepEqual(ov.armed(), { type: 'im-taps', profile: null }, 'and the tool stays armed');
    // the next tap on static content reaches the tool again
    reset();
    gesture(lead(), 'touch');
    assert.equal(created.length, 1);
    // a finger that travelled past TAP_SLOP is a pan: no tap for the tool
    reset();
    gesture(lead(), 'touch', { move: TAP_SLOP + 1 });
    assert.deepEqual(created, [], 'a pan drops no pin');
    reset();
    gesture(lead(), 'touch', { move: TAP_SLOP });
    assert.equal(created.length, 1, 'within the slop it is a tap');
  } finally { ov.setArmed(null); }
});

test('a click no pointer made (a keyboard\'s Enter or Space, a field\'s implicit submit) is the control\'s, the tool still armed', () => {
  IM.setFingerDraws('off');
  ov.setArmed('im-taps');
  try {
    reset();
    // As browsers send a keyboard activation: a lone click, pointerType '', detail 0.
    goBtn().dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, pointerType: '', detail: 0 }));
    assert.ok(W.__log.includes('click:go'), 'the button acted');
    assert.deepEqual(created, [], 'no pin on the button');
    assert.deepEqual(ov.armed(), { type: 'im-taps', profile: null }, 'and the tool stays armed');
    // the next finger tap on static content reaches the tool (K.2-9)
    reset();
    gesture(lead(), 'touch');
    assert.deepEqual(created, [['im-taps', 'click', 'touch']]);
  } finally { ov.setArmed(null); }
});

test('a strokes type armed: a finger drag is the page\'s unless finger-draws, when the well gives up its pan', () => {
  const html = W.document.documentElement;
  IM.setFingerDraws('off');
  ov.setArmed('im-strokes');
  try {
    assert.equal(html.classList.contains('finger-strokes'), false);
    reset();
    pe(lead(), 'pointerdown', 'touch');
    pe(lead(), 'pointermove', 'touch', { clientX: 140 });
    pe(lead(), 'pointerup', 'touch', { clientX: 140 });
    assert.deepEqual(created, [], 'drawing tools need a pen or finger-draws');
    assert.deepEqual(W.__log, ['down:touch', 'move:touch'], 'the page had the drag');
    reset();
    pe(lead(), 'pointerdown', 'pen', { pointerId: 3 });
    pe(lead(), 'pointermove', 'pen', { pointerId: 3, clientX: 140 });
    pe(lead(), 'pointerup', 'pen', { pointerId: 3, clientX: 140 });
    assert.deepEqual(created.map(([, phase]) => phase), ['pointerdown', 'pointermove', 'pointerup'], 'a pen stroke is the tool\'s');
    assert.deepEqual(W.__log, []);
    IM.setFingerDraws('on');
    assert.equal(html.classList.contains('finger-strokes'), true, 'finger-draws on with a strokes tool: the finger draws');
    reset();
    pe(lead(), 'pointerdown', 'touch');
    pe(lead(), 'pointermove', 'touch', { clientX: 140 });
    assert.deepEqual(created.map(([t, phase, p]) => `${phase}:${p}`), ['pointerdown:touch', 'pointermove:touch']);
    pe(lead(), 'pointerup', 'touch', { clientX: 140 });
    ov.setArmed('im-taps');
    assert.equal(html.classList.contains('finger-strokes'), false, 'only for a strokes tool');
  } finally {
    ov.setArmed(null);
    IM.setFingerDraws('off');
  }
  assert.equal(html.classList.contains('finger-strokes'), false);
});

test('a second touch while a pen is down is ignored: neither the tool nor the page hears it', () => {
  IM.setFingerDraws('on');   // even where a finger would draw
  ov.setArmed('im-strokes');
  try {
    reset();
    pe(lead(), 'pointerdown', 'pen', { pointerId: 11 });
    assert.deepEqual(created, [['im-strokes', 'pointerdown', 'pen']]);
    pe(lead(), 'pointerdown', 'touch', { pointerId: 12 });
    assert.deepEqual(created, [['im-strokes', 'pointerdown', 'pen']], 'not the tool');
    assert.deepEqual(W.__log, [], 'not the page');
    pe(lead(), 'pointerup', 'touch', { pointerId: 12 });
    pe(lead(), 'pointerup', 'pen', { pointerId: 11 });
    // the pen up: a finger is a finger again
    reset();
    pe(lead(), 'pointerdown', 'touch', { pointerId: 13 });
    assert.deepEqual(created, [['im-strokes', 'pointerdown', 'touch']]);
    pe(lead(), 'pointerup', 'touch', { pointerId: 13 });
  } finally {
    ov.setArmed(null);
    IM.setFingerDraws('off');
  }
});

test('the two older pointerType reads stay: the rail\'s hover ignores touch; the grip tab\'s mouse-button filter is unchanged', () => {
  const rail = shell.$('queue-rail');
  assert.ok(rail);
  rail.classList.remove('open');
  rail.dispatchEvent(new W.PointerEvent('pointerenter', { pointerType: 'touch' }));
  assert.equal(rail.classList.contains('open'), false, 'a finger does not open the rail by hover');
  rail.dispatchEvent(new W.PointerEvent('pointerenter', { pointerType: 'mouse' }));
  assert.equal(rail.classList.contains('open'), true, 'a mouse does');
  rail.dispatchEvent(new W.PointerEvent('pointerleave', { pointerType: 'mouse' }));
  assert.equal(rail.classList.contains('open'), false);
  const shellSrc = fs.readFileSync(path.join(REPO, 'public/app/shell.js'), 'utf8');
  assert.ok(shellSrc.includes("rail.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch' && !inSheet()) setRail(true); });"));
  assert.ok(shellSrc.includes("rail.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !inSheet() && !railPinned) setRail(false); });"));
  const dragSrc = fs.readFileSync(path.join(REPO, 'public/app/sheet-drag.js'), 'utf8');
  assert.ok(dragSrc.includes("if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;"));
  for (const f of ['shell.js', 'sheet-drag.js']) {
    const src = fs.readFileSync(path.join(REPO, 'public/app', f), 'utf8');
    assert.doesNotMatch(src, /input-mode/, `${f} does not reach the policy`);
  }
});

test('the stylesheet: the well keeps the finger\'s gestures (manipulation), and every older touch-action rule is unchanged', () => {
  const css = createCascade(CSS, { win: () => W });
  const main = shell.$('main');
  const html = W.document.documentElement;
  html.classList.remove('finger-strokes');
  assert.equal(css.value(main, 'touch-action'), 'manipulation');
  html.classList.add('finger-strokes');
  try {
    assert.equal(css.value(main, 'touch-action'), 'pinch-zoom');
  } finally { html.classList.remove('finger-strokes'); }
  // Every touch-action rule, by selector: the chrome's handles as they were
  // (graph canvas, pane grips, the dock's grips, the sheet's scrim and tab, the
  // phone header's auto) and the well's two.
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  for (const r of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const m = r[2].match(/touch-action\s*:\s*([^;]+)/);
    if (m) rules.push(`${r[1].trim().replace(/\s+/g, ' ')} => ${m[1].trim()}`);
  }
  assert.deepEqual(rules, [
    '.pane-header => none',
    '.pane-resize-r, .pane-resize-b, .pane-resize-rb => none',
    '.graph-canvas-wrap => none',
    '.phone .pane-header, .pane.locked .pane-header => auto',
    '.cd-grip => none',
    '.cd-h => none',
    '.chat-scrim.on => none',
    '.chat-tab => none',
    '#main => manipulation',
    'html.finger-strokes #main => pinch-zoom',
  ]);
});

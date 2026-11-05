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
//   - a taps type armed: a pen's or a mouse's pointerdown on the pane's
//     <button> has its default cancelled (no compatibility mousedown or focus
//     starts in the pane, K.2-43); a selection type armed: no pointer's is
//     (K.2-48: the browser forms the selection the tool takes), so a mouse
//     pointerdown on the pane's text keeps its default where a taps tool's is
//     cancelled; a finger's keeps its default, on the button and on static
//     content (D1);
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
//   - the stylesheet: with no strokes tool armed the well's touch-action is
//     manipulation; while one is armed (U616, 5A.3; the pen tool's stand-in
//     and the box grab alike) #main's and .well-wrap's winning touch-action is
//     none, finger-draws on or off (pinch-zoom off, K.4 I1 = b); every
//     touch-action rule the chrome had before is unchanged;
//   - the two-finger pan (U334a; DECISIONS.md K.4 H1 = a, I1 = b), with the
//     box grab armed (the drawing tool) and finger-draws on: one finger
//     draws a grab; two fingers moving together scroll the well (.well-wrap)
//     by the midpoint's travel and create nothing; a second finger landing
//     mid-stroke cancels the stroke (the band dropped, no POST) and scrolls;
//     the pan's fingers are never heard by the pane under them, their clicks
//     included; with finger-draws off (U616) two fingers pan the well all the
//     same, over prose in a pane and in a margin (.well-wrap), and a second
//     finger in the margin cancels a finger stroke under way; with no strokes
//     tool armed the two-finger case is the browser's (no scrollBy,
//     touch-action manipulation); a tap on a pane's button with a strokes tool
//     armed reaches the button; a pen stroke with resting fingers (a palm)
//     still draws;
//   - a pan under way (U334b; K.2-98, K.2-99): it moves nothing while a pen is
//     down (a palm down before the pen keeps its pan, scrolls nothing, and the
//     pen's grab is created), and the next move after the pen lifts scrolls by
//     its own delta only; a pan finger whose press a pane heard (it landed on
//     the pane's button before the pan) delivers its own pointerup or
//     pointercancel to the pane, its moves and its click stopped, nothing
//     created; a tool-routed finger's lift, and that of a finger landing on
//     the button during the pan, stay the pan's;
//   - the strokes input policy on a target (U515; annotation engine 4A.2; AD1,
//     AD4, AJ5): any strokes tool armed (the box grab too), finger-draws off,
//     sets html.strokes-armed, marks every .mount-host data-wc-strokes and
//     has its shadow root take the strokes sheet once (adoptedStyleSheets
//     stubbed: jsdom has none); a pane rendered while armed is marked; disarm
//     clears every mark; a taps tool arms none; the sheet's rules give every
//     element in a marked pane root touch-action none (a pane's own scroller
//     stops the intersection over ancestors) and an svg, an img, a canvas and
//     a [data-fixed-aspect] selection and the callout off, a paragraph not
//     those, and app.css a light-DOM [data-fixed-aspect] the same; with the
//     box grab armed and finger-draws off, two fingers from an svg or a
//     paragraph in a pane scroll the well, and one finger there is the
//     page's.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { createCascade } = require('../test-support/css-cascade');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.join(__dirname, '..');
// The box grab's type listing (the drawing tool the pan is pinned against).
const TYPES = {
  ok: true,
  types: [{ type: 'box-grab', schema: 'box-grab@1', reads: ['box-grab@1'], anchors: ['page'],
    toolbar: { input: 'strokes', settings: { small: { properties: { snap: { enum: ['block', 'free'], default: 'block' } } } } } }],
  reserved: ['comment', 'highlight', 'box-grab'],
};
let nextGrab = 1;
function elementsRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method === 'POST') return { ok: true, element: { id: `g${nextGrab++}`, v: 1, type: 'box-grab', shared: true } };
  return { elements: [], next_cursor: 0 };
}
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
  shell = await bootShell({
    routes: { '/api/elements/types': TYPES, '/api/elements': elementsRoute, '/api/elements/*': { ok: true } },
  });
  W = shell.window;
  M = W.__wcMount;
  W.__log = [];
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  ({ TAP_SLOP } = await shell.importApp('sheet-model.js'));
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  await shell.tick();
  await waitUntil(() => ov.inputKindOf('box-grab') === 'strokes', { what: 'the box grab registered' });
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

// A pressed pointer reports a button down (buttons 1) on its pointerdown and
// moves, as browsers send it: a move with buttons 0 is a hover (U302b).
function pe(el, type, pointerType, extra = {}) {
  el.dispatchEvent(new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId: 1, isPrimary: true, clientX: 100, clientY: 100,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
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

test('a taps tool armed: a pen\'s or a mouse\'s pointerdown on the pane\'s button is cancelled, a finger\'s is not; a selection tool cancels none', () => {
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
      // K.2-43's taps half; K.2-48: the selection row keeps every default.
      const drawing = type === 'im-taps';
      ov.setArmed(type);
      reset();
      assert.equal(down(goBtn(), 'pen', 51), drawing, `${type}: a pen on the button (K.2-43, K.2-48)`);
      assert.equal(down(goBtn(), 'mouse', 52), drawing, `${type}: the mouse as the pen`);
      assert.equal(down(goBtn(), 'touch', 53), false, `${type}: a finger on the button keeps its default (D1)`);
      assert.equal(down(lead(), 'touch', 54), false, `${type}: a finger on static content keeps its default`);
      assert.deepEqual(W.__log.filter((l) => l !== 'down:touch'), [], 'the page heard only the finger on the button');
    }
  } finally { ov.setArmed(null); }
});

test('a mouse pointerdown on the pane\'s text: a selection tool leaves its default (the browser forms the selection), a taps tool cancels it', () => {
  IM.setFingerDraws('off');
  const down = (pointerId) => {
    const ev = new W.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId, isPrimary: true, clientX: 100, clientY: 100, buttons: 1,
    });
    lead().dispatchEvent(ev);
    pe(lead(), 'pointerup', 'mouse', { pointerId });
    return ev.defaultPrevented;
  };
  try {
    ov.setArmed('im-selection');
    assert.equal(down(61), false, 'selection: not defaultPrevented, so the mousedown that starts a text selection runs (K.2-48, K.2-6)');
    ov.setArmed('im-taps');
    assert.equal(down(62), true, 'taps: defaultPrevented (K.2-43)');
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

test('the stylesheet (U616): with no strokes tool armed the well keeps the finger\'s gestures (manipulation); with the pen tool\'s stand-in or the box grab armed #main and .well-wrap take none, finger-draws on or off; every older touch-action rule is unchanged', () => {
  const css = createCascade(CSS, { win: () => W });
  const main = shell.$('main');
  const wrap = main.closest('.well-wrap');
  const html = W.document.documentElement;
  const both = () => [css.value(main, 'touch-action'), css.value(wrap, 'touch-action')];
  // A locked pane's header under #main: .pane.locked .pane-header's auto is
  // (0,3,0), which the well's armed rule (0,2,1) loses to, so the armed
  // #main rule (1,1,1) must beat it (FINGER@page-limit: no finger gesture is the
  // browser's anywhere in the well while a strokes tool is armed).
  const lockedPane = W.document.createElement('div');
  lockedPane.className = 'pane locked';
  const lockedHeader = W.document.createElement('div');
  lockedHeader.className = 'pane-header';
  lockedPane.appendChild(lockedHeader);
  main.appendChild(lockedPane);
  const locked = () => css.value(lockedHeader, 'touch-action');
  ov.setArmed(null);
  IM.setFingerDraws('off');
  try {
    assert.deepEqual(both(), ['manipulation', null], 'disarmed: the browser pans and pinches');
    assert.equal(locked(), 'auto', 'disarmed: a locked pane\'s header keeps auto');
    // The pen tool's stand-in (a strokes type: the ink pack's pen is a
    // plugin) and the box grab, finger-draws off and on.
    for (const t of ['im-strokes', 'box-grab']) {
      for (const fd of ['off', 'on']) {
        IM.setFingerDraws(fd);
        ov.setArmed(t);
        assert.equal(html.classList.contains('strokes-armed'), true, `${t} ${fd}`);
        assert.deepEqual(both(), ['none', 'none'], `${t}, finger-draws ${fd}: the well gives up every finger gesture (pinch-zoom off)`);
        assert.equal(locked(), 'none', `${t}, finger-draws ${fd}: a locked pane's header gives them up too`);
        ov.setArmed(null);
        assert.deepEqual(both(), ['manipulation', null], `${t} disarmed: back to the browser's`);
        assert.equal(locked(), 'auto', `${t} disarmed: a locked pane's header back to auto`);
      }
    }
    // No strokes tool armed (a taps tool, a selection tool): unchanged.
    for (const t of ['im-taps', 'im-selection']) {
      ov.setArmed(t);
      assert.deepEqual(both(), ['manipulation', null], t);
      ov.setArmed(null);
    }
    // html.finger-strokes alone still reads none (U334a).
    html.classList.add('finger-strokes');
    try { assert.equal(css.value(main, 'touch-action'), 'none'); } finally { html.classList.remove('finger-strokes'); }
  } finally {
    ov.setArmed(null);
    IM.setFingerDraws('off');
    lockedPane.remove();
  }
  // Every touch-action rule, by selector: the chrome's handles as they were
  // (graph canvas, pane grips, the dock's grips, the sheet's scrim and tab, the
  // phone header's auto) and the well's three.
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
    'html.finger-strokes #main => none',
    'html.strokes-armed #main, html.strokes-armed .well-wrap, html.strokes-armed .well-wrap * => none',
    'html.strokes-armed #main * => none',
  ]);
});

// ── the two-finger pan (U334a; K.4 H1 = a, I1 = b) ───────────────────────────
// The box grab armed, as the toolbar arms it; the pane laid out at the
// viewport's top-left (jsdom has no layout) so a drawn box lands in its
// content box; the well's scroller is .well-wrap, its scrollBy recorded.
const grabPosts = () => shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements');
const band = () => W.document.querySelector('#el-layer .bg-band');
const scroller = () => shell.$('main').closest('.well-wrap');
let scrollCalls = [];
function layOut() {
  const wrap = W.document.querySelector('.pane[data-pane-id="im1"]');
  shell.scrollMetrics(wrap, { rect: { left: 0, top: 0, width: 600, height: 400 } });
  shell.scrollMetrics(wrap.querySelector('.mount-host'), { rect: { left: 0, top: 0, width: 600, height: 400 } });
  const sc = scroller();
  shell.scrollMetrics(sc, { scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 800, scrollWidth: 600, clientWidth: 600 });
  scrollCalls = [];
  const own = W.Element.prototype.scrollBy;
  sc.scrollBy = function scrollBy(...a) { scrollCalls.push(a); return own.apply(this, a); };
}
function finger(el, type, pointerId, x, y, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId, isPrimary: false,
    clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  el.dispatchEvent(ev);
  return ev;
}
function tapClick(el, pointerId) {
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'touch', pointerId }));
}
async function grabArmed(fd) {
  ov.setArmed(null);
  IM.setFingerDraws(fd);
  ov.setArmed('box-grab');
  layOut();
  shell.calls.length = 0;
  reset();
  await shell.tick();
}
async function settle() {
  ov.setArmed(null);
  IM.setFingerDraws('off');
  scroller().scrollTop = 0;
  delete scroller().scrollBy;
  await shell.tick();
}

test('the pan: one finger draws a grab; two fingers moving together scroll the well by their travel and create nothing', async () => {
  await grabArmed('on');
  try {
    assert.equal(W.document.documentElement.classList.contains('finger-strokes'), true);
    // One finger from (10,10) to (80,60): the box grab's stroke, to its end.
    finger(lead(), 'pointerdown', 21, 10, 10, { isPrimary: true });
    finger(lead(), 'pointermove', 21, 45, 35);
    finger(lead(), 'pointermove', 21, 80, 60);
    assert.ok(band(), 'the rubber band is drawn');
    finger(lead(), 'pointerup', 21, 80, 60);
    tapClick(lead(), 21);
    await shell.tick();
    assert.equal(grabPosts().length, 1, 'a lone finger draws: the grab is created');
    assert.equal(grabPosts()[0].body.type, 'box-grab');
    assert.deepEqual(scrollCalls, [], 'and nothing scrolled');
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
    // Two fingers landing together, then moving up 40 px together.
    shell.calls.length = 0;
    reset();
    finger(lead(), 'pointerdown', 22, 100, 200, { isPrimary: true });
    finger(lead(), 'pointerdown', 23, 200, 200);
    assert.equal(band(), null, 'the first finger\'s band is dropped the moment the second lands');
    for (const y of [190, 180, 170, 160]) {
      finger(lead(), 'pointermove', 22, 100, y);
      finger(lead(), 'pointermove', 23, 200, y);
    }
    assert.equal(scroller().scrollTop, 40, 'the well scrolled by the fingers\' 40 px');
    assert.equal(scroller().scrollLeft, 0, 'no sideways travel, no sideways scroll');
    finger(lead(), 'pointerup', 22, 100, 160);
    finger(lead(), 'pointerup', 23, 200, 160);
    tapClick(goBtn(), 22);
    tapClick(goBtn(), 23);
    await shell.tick();
    assert.equal(grabPosts().length, 0, 'the pan created nothing');
    assert.equal(band(), null);
    assert.deepEqual(W.__log, [], 'the pane under the fingers heard nothing: no pointer event, no click');
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] }, 'no stale entry after the gesture');
    assert.deepEqual(ov.armed(), { type: 'box-grab', profile: null }, 'no disarm step: the tool stays armed (H1 = a)');
  } finally { await settle(); }
});

test('the pan: a second finger landing mid-stroke cancels the stroke (no element, no POST) and scrolls, both axes', async () => {
  await grabArmed('on');
  try {
    finger(lead(), 'pointerdown', 31, 10, 10, { isPrimary: true });
    finger(lead(), 'pointermove', 31, 80, 60);
    assert.ok(band(), 'the stroke is under way');
    const second = finger(lead(), 'pointerdown', 32, 120, 60);
    assert.equal(band(), null, 'cancelled toward the tool: the band is gone');
    assert.equal(second.defaultPrevented, true, 'the pan\'s finger: its default cancelled');
    // The midpoint (100,60) travels to (70,30): the well moves 30 down and 30 right.
    finger(lead(), 'pointermove', 31, 50, 30);
    finger(lead(), 'pointermove', 32, 90, 30);
    assert.equal(scroller().scrollTop, 30);
    assert.equal(scroller().scrollLeft, 30, 'horizontal too, where the well scrolls');
    // A third finger joins the pan: the pan's, never the tool's (no new band)
    // nor the pane's; its landing and lifting move nothing.
    const third = finger(lead(), 'pointerdown', 39, 300, 300);
    assert.equal(third.defaultPrevented, true, 'a joining finger is the pan\'s');
    assert.equal(band(), null, 'a joining finger draws no band');
    finger(lead(), 'pointerup', 39, 300, 300);
    assert.equal(scroller().scrollTop, 30);
    assert.equal(scroller().scrollLeft, 30);
    // One finger lifts: the other still pans, from where it is (no jump).
    finger(lead(), 'pointerup', 31, 50, 30);
    finger(lead(), 'pointermove', 32, 90, 10);
    assert.equal(scroller().scrollTop, 50, 'the remaining finger pans on');
    assert.equal(scroller().scrollLeft, 30, 'from where it is: the midpoint rebased at the lift, no sideways jump');
    finger(lead(), 'pointerup', 32, 90, 10);
    tapClick(lead(), 31);
    tapClick(lead(), 32);
    tapClick(lead(), 39);
    await shell.tick();
    assert.equal(grabPosts().length, 0, 'no element, no POST');
    assert.deepEqual(W.__log, []);
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
    // The next lone finger draws again.
    finger(lead(), 'pointerdown', 33, 10, 10, { isPrimary: true });
    finger(lead(), 'pointermove', 33, 80, 60);
    finger(lead(), 'pointerup', 33, 80, 60);
    await shell.tick();
    assert.equal(grabPosts().length, 1, 'one finger draws after the pan');
  } finally { await settle(); }
});

test('the pan: a second finger landing on the pane\'s button is the pan\'s; the button never acts', async () => {
  await grabArmed('on');
  try {
    finger(lead(), 'pointerdown', 34, 10, 10, { isPrimary: true });
    finger(goBtn(), 'pointerdown', 35, 50, 50);
    finger(goBtn(), 'pointermove', 35, 50, 20);
    finger(goBtn(), 'pointerup', 35, 50, 20);
    tapClick(goBtn(), 35);
    finger(lead(), 'pointerup', 34, 10, 10);
    tapClick(goBtn(), 34);
    await shell.tick();
    assert.deepEqual(W.__log, [], 'no pointerdown, no click:go');
    assert.equal(grabPosts().length, 0);
    assert.ok(scroller().scrollTop > 0, 'it scrolled');
  } finally { await settle(); }
});

test('no strokes tool armed: two fingers are the browser\'s (no scrollBy, touch-action manipulation) and create nothing', async () => {
  for (const t of [null, 'im-taps']) {
    for (const fd of ['off', 'on']) {
      ov.setArmed(null);
      IM.setFingerDraws(fd);
      ov.setArmed(t);
      layOut();
      reset();
      try {
        const css = createCascade(CSS, { win: () => W });
        assert.equal(W.document.documentElement.classList.contains('strokes-armed'), false);
        assert.equal(css.value(shell.$('main'), 'touch-action'), 'manipulation', 'the browser pans and pinches');
        const d1 = finger(lead(), 'pointerdown', 41, 100, 200, { isPrimary: true });
        const d2 = finger(lead(), 'pointerdown', 42, 200, 200);
        assert.equal(d1.defaultPrevented || d2.defaultPrevented, false, 'no default cancelled');
        for (const y of [180, 160]) {
          finger(lead(), 'pointermove', 41, 100, y);
          finger(lead(), 'pointermove', 42, 200, y);
        }
        finger(lead(), 'pointercancel', 41, 100, 160);
        finger(lead(), 'pointercancel', 42, 200, 160);
        await shell.tick();
        assert.deepEqual(scrollCalls, [], `${t || 'nothing'} ${fd}: no scrollBy: the scroll is the browser's`);
        assert.equal(scroller().scrollTop, 0);
        assert.deepEqual(created, []);
        if (!t) assert.ok(W.__log.includes('down:touch'), 'nothing armed: the page had the fingers');
        assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
      } finally { await settle(); }
    }
  }
});

test('the box grab armed, finger-draws off (U616): two fingers pan the well over prose in a pane and in a margin, and create nothing; one finger pans nothing', async () => {
  await grabArmed('off');
  try {
    const css = createCascade(CSS, { win: () => W });
    assert.equal(W.document.documentElement.classList.contains('finger-strokes'), false);
    assert.equal(css.value(shell.$('main'), 'touch-action'), 'none', 'the browser pans nothing in the well');
    const margin = scroller();
    // One finger on the prose: the page's, and no pan (FINGER@page-limit).
    finger(lead(), 'pointerdown', 40, 100, 200, { isPrimary: true });
    finger(lead(), 'pointermove', 40, 100, 150);
    finger(lead(), 'pointerup', 40, 100, 150);
    await shell.tick();
    assert.deepEqual(scrollCalls, [], 'one finger: no scrollBy');
    assert.equal(grabPosts().length, 0, 'and no grab');
    let top = 0;
    for (const [name, el] of [['prose in a pane', lead], ['the margin', () => margin]]) {
      reset();
      const d1 = finger(el(), 'pointerdown', 41, 100, 200, { isPrimary: true });
      const d2 = finger(el(), 'pointerdown', 42, 200, 200);
      assert.equal(d1.defaultPrevented, false, `${name}: the first finger's press went to the page`);
      assert.equal(d2.defaultPrevented, true, `${name}: the second finger is the pan's`);
      for (const y of [190, 180]) {
        finger(el(), 'pointermove', 41, 100, y);
        finger(el(), 'pointermove', 42, 200, y);
      }
      top += 20;
      assert.equal(scroller().scrollTop, top, `${name}: the well scrolled by the fingers' travel`);
      finger(el(), 'pointerup', 41, 100, 180);
      finger(el(), 'pointerup', 42, 200, 180);
      tapClick(el(), 41);
      tapClick(el(), 42);
      await shell.tick();
      assert.equal(grabPosts().length, 0, `${name}: the pan created nothing`);
      assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
    }
    assert.ok(scrollCalls.length > 0, 'scrollBy called');
  } finally { await settle(); }
});

test('the box grab armed, finger-draws on (U616): a second finger landing in the margin cancels the stroke under way (cancelGesture: the band dropped, no POST) and pans', async () => {
  await grabArmed('on');
  try {
    const margin = scroller();
    finger(lead(), 'pointerdown', 43, 10, 10, { isPrimary: true });
    finger(lead(), 'pointermove', 43, 80, 60);
    assert.ok(band(), 'the stroke is under way');
    finger(margin, 'pointerdown', 44, 120, 60);
    assert.equal(band(), null, 'cancelled toward the tool: the band is gone');
    finger(lead(), 'pointermove', 43, 80, 40);
    finger(margin, 'pointermove', 44, 120, 40);
    assert.equal(scroller().scrollTop, 20, 'the well scrolled');
    finger(lead(), 'pointerup', 43, 80, 40);
    finger(margin, 'pointerup', 44, 120, 40);
    tapClick(lead(), 43);
    tapClick(margin, 44);
    await shell.tick();
    assert.equal(grabPosts().length, 0, 'no element, no POST');
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
  } finally { await settle(); }
});

test('a strokes tool armed (U616): a finger tap on the pane\'s button reaches the button, finger-draws off and on; the tool stays armed', async () => {
  for (const t of ['box-grab', 'im-strokes']) {
    for (const fd of ['off', 'on']) {
      ov.setArmed(null);
      IM.setFingerDraws(fd);
      ov.setArmed(t);
      reset();
      shell.calls.length = 0;
      try {
        gesture(goBtn(), 'touch', { pointerId: 45 });
        await shell.tick();
        assert.ok(W.__log.includes('click:go'), `${t} ${fd}: the button acted`);
        assert.deepEqual(created, [], `${t} ${fd}: not the tool`);
        assert.equal(grabPosts().length, 0);
        assert.equal(ov.armed().type, t, 'the tool stays armed');
        assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
      } finally { ov.setArmed(null); IM.setFingerDraws('off'); }
    }
  }
});

test('a pen stroke with resting fingers (a palm) still draws; no pan starts while a pen is down', async () => {
  await grabArmed('on');
  try {
    W.localStorage.setItem('wc:finger-draws', 'on');   // a pen seen keeps 'on' bound
    const pen = (type, x, y) => lead().dispatchEvent(new W.PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerType: 'pen', pointerId: 51, isPrimary: true,
      clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
    }));
    pen('pointerdown', 10, 10);
    finger(lead(), 'pointerdown', 52, 300, 300, { isPrimary: true });
    finger(lead(), 'pointerdown', 53, 320, 310);
    finger(lead(), 'pointermove', 52, 300, 250);
    finger(lead(), 'pointermove', 53, 320, 260);
    pen('pointermove', 45, 35);
    pen('pointermove', 80, 60);
    assert.ok(band(), 'the pen\'s band stands');
    pen('pointerup', 80, 60);
    finger(lead(), 'pointerup', 52, 300, 250);
    finger(lead(), 'pointerup', 53, 320, 260);
    await shell.tick();
    assert.equal(grabPosts().length, 1, 'the pen drew its grab');
    assert.deepEqual(scrollCalls, [], 'the palm panned nothing');
    assert.deepEqual(W.__log, [], 'and the pane heard no palm (U334\'s ignore)');
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
  } finally { await settle(); }
});

// ── a pan under way: the pen rule and the heard-press rule (U334b; K.2-98, K.2-99) ──
const penAt = (el, type, pointerId, x, y) => el.dispatchEvent(new W.PointerEvent(type, {
  bubbles: true, cancelable: true, composed: true, pointerType: 'pen', pointerId, isPrimary: true,
  clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
}));
// What the pane hears, by listeners on its button and its shadow root: the
// pointer events (type and pointerId) and the clicks.
function paneEars() {
  const heard = [];
  const offs = [];
  const on = (el, type, tag) => {
    const fn = (e) => heard.push(`${tag}:${e.type}:${e.pointerId}`);
    el.addEventListener(type, fn);
    offs.push(() => el.removeEventListener(type, fn));
  };
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click']) on(goBtn(), t, 'btn');
  for (const t of ['pointerup', 'pointercancel']) on(rootOf(), t, 'root');
  return { heard, off: () => { for (const f of offs) f(); } };
}

test('the pan moves nothing while a pen is down; after the pen lifts the next move scrolls by its own delta only', async () => {
  await grabArmed('on');
  try {
    W.localStorage.setItem('wc:finger-draws', 'on');   // a pen seen keeps 'on' bound
    // Two resting contacts (a palm) start a pan before the pen comes down.
    finger(lead(), 'pointerdown', 61, 300, 300, { isPrimary: true });
    finger(lead(), 'pointerdown', 62, 340, 300);
    assert.deepEqual(IM.touchesForTests().pan, [61, 62], 'a pan under way');
    penAt(lead(), 'pointerdown', 63, 10, 10);
    assert.deepEqual(IM.touchesForTests().pan, [61, 62], 'the pen\'s pointerdown does not end the pan');
    // The palm moves 50 px while the pen draws.
    for (const y of [275, 250]) {
      finger(lead(), 'pointermove', 61, 300, y);
      finger(lead(), 'pointermove', 62, 340, y);
    }
    penAt(lead(), 'pointermove', 63, 45, 35);
    penAt(lead(), 'pointermove', 63, 80, 60);
    assert.ok(band(), 'the pen\'s band stands');
    assert.deepEqual(scrollCalls, [], 'nothing scrolled under the pen');
    penAt(lead(), 'pointerup', 63, 80, 60);
    await shell.tick();
    assert.equal(grabPosts().length, 1, 'the pen\'s grab is created');
    assert.deepEqual(scrollCalls, [], 'still nothing scrolled');
    assert.deepEqual(W.__log, [], 'the pane heard no palm');
    // The pen lifted: the next move scrolls by that move's 20 px, no jump.
    finger(lead(), 'pointermove', 61, 300, 230);
    finger(lead(), 'pointermove', 62, 340, 230);
    assert.equal(scrollCalls.length, 2, 'one scrollBy per finger\'s move');
    assert.equal(scroller().scrollTop, 20, 'the well scrolled by the 20 px moved after the lift, not the 50 before it');
    assert.equal(scroller().scrollLeft, 0);
    finger(lead(), 'pointerup', 61, 300, 230);
    finger(lead(), 'pointerup', 62, 340, 230);
    tapClick(lead(), 61);
    tapClick(lead(), 62);
    await shell.tick();
    assert.equal(grabPosts().length, 1, 'the pan created nothing');
    assert.deepEqual(W.__log, []);
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
  } finally {
    penAt(lead(), 'pointercancel', 63, 80, 60);   // a failed run leaves no pen down for the next case
    await settle();
  }
});

for (const lift of ['pointerup', 'pointercancel']) {
  test(`a pan finger whose press a pane heard delivers its own lift (${lift}); its moves and its click are the pan's`, async () => {
    await grabArmed('on');
    const ears = paneEars();
    try {
      // Finger 1 on the pane's button: the page's (K.2-9), the pane hears it.
      finger(goBtn(), 'pointerdown', 71, 50, 50, { isPrimary: true });
      assert.deepEqual(ears.heard, ['btn:pointerdown:71'], 'the pane heard the press, once');
      // Finger 2 in the well: the pan.
      finger(lead(), 'pointerdown', 72, 150, 50);
      assert.deepEqual(IM.touchesForTests().pan, [71, 72]);
      for (const y of [40, 30]) {
        finger(goBtn(), 'pointermove', 71, 50, y);
        finger(lead(), 'pointermove', 72, 150, y);
      }
      assert.equal(scroller().scrollTop, 20, 'the well scrolled');
      assert.ok(!ears.heard.some((h) => h.includes('pointermove')), 'the pane hears none of the pan\'s moves');
      const up = finger(goBtn(), lift, 71, 50, 30);
      assert.equal(up.defaultPrevented, false, 'the lift is sent on as it came');
      assert.deepEqual(ears.heard, ['btn:pointerdown:71', `btn:${lift}:71`, `root:${lift}:71`], 'the pane hears that finger\'s own lift, once');
      if (lift === 'pointerup') {
        assert.deepEqual(IM.touchesForTests().clicks, [71], 'its click is owed');
        tapClick(goBtn(), 71);
      }
      finger(lead(), 'pointerup', 72, 150, 30);
      tapClick(lead(), 72);
      await shell.tick();
      assert.ok(!ears.heard.some((h) => h.startsWith('btn:click')), 'no click reaches the pane');
      assert.ok(!W.__log.includes('click:go'), 'the button never acts');
      assert.ok(!ears.heard.some((h) => h.endsWith(':72')), 'the pan\'s own finger is never the pane\'s');
      assert.equal(grabPosts().length, 0, 'no element, no POST');
      assert.equal(shell.calls.filter((c) => c.method === 'POST').length, 0);
      assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
    } finally { ears.off(); await settle(); }
  });
}

test('the heard-press rule is the press\'s: a tool-routed finger\'s lift, and that of a finger landing on the button during the pan, stay the pan\'s', async () => {
  await grabArmed('on');
  const ears = paneEars();
  try {
    // Finger 1 on static content: the tool's (strokes armed, fingers draw).
    finger(lead(), 'pointerdown', 81, 10, 10, { isPrimary: true });
    finger(lead(), 'pointermove', 81, 40, 40);
    finger(lead(), 'pointerdown', 82, 120, 40);
    // Finger 3 lands on the button during the pan: its press is stopped.
    finger(goBtn(), 'pointerdown', 83, 60, 60);
    finger(lead(), 'pointermove', 81, 40, 20);
    finger(lead(), 'pointermove', 82, 120, 20);
    finger(goBtn(), 'pointermove', 83, 60, 40);
    const up1 = finger(lead(), 'pointerup', 81, 40, 20);
    const up3 = finger(goBtn(), 'pointerup', 83, 60, 40);
    const up2 = finger(lead(), 'pointerup', 82, 120, 20);
    assert.equal(up1.defaultPrevented && up2.defaultPrevented && up3.defaultPrevented, true, 'each lift is the pan\'s');
    tapClick(lead(), 81);
    tapClick(goBtn(), 83);
    tapClick(lead(), 82);
    await shell.tick();
    assert.deepEqual(ears.heard, [], 'the pane heard nothing: no press, no lift, no click');
    assert.deepEqual(W.__log, []);
    assert.equal(grabPosts().length, 0);
    assert.ok(scroller().scrollTop > 0, 'it scrolled');
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
  } finally { ears.off(); await settle(); }
});

// K.2-104 (U404; U334b's hand-off "Open issues"): a strokes tool armed BEFORE
// a preview stays armed in it, but the overlay gives the page every pointer
// while previewing (D2), so a finger on a pane's own listener is heard — and
// the pan's reading of it at its pointerdown says 'page' too, so that
// finger's lift reaches the pane (K.2-99) instead of being stopped as a tool
// finger's.
test('a preview with the box grab armed before it: a finger the pane heard on its canvas delivers its own lift when a second finger pans (K.2-104)', async () => {
  const { view } = await shell.importApp('state.js');
  await grabArmed('on');
  const ears = paneEars();
  view.previewing = true;
  try {
    assert.deepEqual(ov.armed(), { type: 'box-grab', profile: null }, 'armed before the preview, still armed');
    // Finger 1 on the pane's static content: the pane's own listener hears it.
    finger(lead(), 'pointerdown', 101, 20, 20, { isPrimary: true });
    assert.deepEqual(W.__log, ['down:touch'], 'the pane heard the press (the overlay creates nothing in a preview)');
    // Finger 2 pans.
    finger(lead(), 'pointerdown', 102, 140, 20);
    assert.deepEqual(IM.touchesForTests({ routes: true }).routes, { 101: 'page', 102: 'page' });
    assert.deepEqual(IM.touchesForTests({ routes: true }).heard, [101], 'finger 1\'s press was heard');
    for (const y of [14, 8]) {
      finger(lead(), 'pointermove', 101, 20, y);
      finger(lead(), 'pointermove', 102, 140, y);
    }
    assert.equal(scroller().scrollTop, 12, 'the pan scrolled the well');
    // Finger 1 lifts: the pane hears its pointerup, as sent.
    const up = finger(lead(), 'pointerup', 101, 20, 8);
    assert.equal(up.defaultPrevented, false, 'the lift is sent on as it came');
    assert.deepEqual(ears.heard, ['root:pointerup:101'], 'the pane hears that finger\'s own lift, once');
    tapClick(lead(), 101);
    finger(lead(), 'pointerup', 102, 140, 8);
    tapClick(lead(), 102);
    await shell.tick();
    assert.ok(!ears.heard.some((h) => h.endsWith(':102')), 'the pan\'s own finger is never the pane\'s');
    assert.ok(!W.__log.some((l) => l.startsWith('move:')), 'the pane hears none of the pan\'s moves');
    assert.equal(grabPosts().length, 0, 'a preview creates nothing');
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
  } finally { view.previewing = false; ears.off(); await settle(); }
});

test('the pan cancels a stroke through the overlay\'s cancelGesture and dispatches no synthetic event', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/input-mode.js'), 'utf8');
  assert.match(src, /import \{[^}]*\bcancelGesture\b[^}]*\} from '\.\/overlay\.js'/);
  assert.doesNotMatch(src, /dispatchEvent\(|new (Pointer|Mouse|Touch)?Event\(/, 'no synthetic event a pane could see');
});

// ── the strokes input policy on a target (U515; annotation engine 4A.2) ──────
// jsdom has no adoptedStyleSheets: a per-root stub, as highlight-chrome's.
let adopted = null;
function installAdopted() {
  adopted = new WeakMap();
  Object.defineProperty(W.ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true, get() { return adopted.get(this) || []; }, set(v) { adopted.set(this, [...v]); },
  });
}
function removeAdopted() {
  delete W.ShadowRoot.prototype.adoptedStyleSheets;
  adopted = null;
}
const strokesSheets = (root) => root.adoptedStyleSheets
  .filter((sh) => [...sh.cssRules].some((r) => r.cssText.includes('data-wc-strokes')));
const hosts = () => [...W.document.querySelectorAll('#main .mount-host')];
const marked = () => hosts().filter((h) => h.hasAttribute('data-wc-strokes')).map((h) => h.dataset.mountId);
const TARGETS_HTML = '<svg class="t-svg" viewBox="0 0 10 10"><rect class="t-rect" width="10" height="10"></rect></svg>'
  + '<img class="t-img" alt="x"><canvas class="t-canvas"></canvas><div class="t-sheet" data-fixed-aspect><span class="t-in">s</span></div>'
  + '<p class="t-p">prose</p>';
async function targetsPane() {
  if (!M.itemEl(W.document, 'imt1')) {
    await shell.frame({ type: 'render', id: 'imt1', target: 'main', html: TARGETS_HTML, params: {}, gen: 1 });
    await shell.tick();
  }
  return M.itemEl(W.document, 'imt1').el;
}

test('a strokes tool armed, finger-draws off: html.strokes-armed, every mount host marked and its root given the strokes sheet once; a pane rendered while armed is marked; disarm clears every mark; a taps tool arms none', async () => {
  const html = W.document.documentElement;
  installAdopted();
  try {
    ov.setArmed(null);
    IM.setFingerDraws('off');
    assert.equal(html.classList.contains('strokes-armed'), false);
    assert.deepEqual(marked(), [], 'nothing marked while nothing is armed');
    const paneDom = rootOf().innerHTML;
    ov.setArmed('box-grab');
    assert.equal(html.classList.contains('strokes-armed'), true, 'the box grab is a strokes tool (AJ5)');
    assert.equal(html.classList.contains('finger-strokes'), false, 'finger-draws off: the well keeps its pan');
    assert.equal(IM.strokesArmed(), true);
    assert.equal(IM.fingerStrokes(), false);
    assert.ok(hosts().length > 0);
    assert.deepEqual(marked(), hosts().map((h) => h.dataset.mountId), 'every mount host carries data-wc-strokes');
    for (const h of hosts()) assert.equal(strokesSheets(h.shadowRoot).length, 1, `${h.dataset.mountId}: the strokes sheet adopted once`);
    // Re-syncs (another strokes tool, finger-draws flips) adopt nothing twice.
    ov.setArmed('im-strokes');
    IM.setFingerDraws('on');
    IM.setFingerDraws('off');
    for (const h of hosts()) assert.equal(strokesSheets(h.shadowRoot).length, 1, 'still once');
    assert.equal(rootOf().innerHTML, paneDom, 'the pane\'s own DOM is untouched');
    // A pane rendered while armed: a new host, marked by the observer.
    await shell.frame({ type: 'render', id: 'imt1', target: 'main', html: TARGETS_HTML, params: {}, gen: 1 });
    await shell.tick();
    assert.ok(marked().includes('imt1'), 'the new host is marked');
    const r1 = M.itemEl(W.document, 'imt1').el.shadowRoot;
    assert.equal(strokesSheets(r1).length, 1);
    // A re-render makes a new host: it is marked too.
    const before = M.itemEl(W.document, 'imt1').el;
    await shell.frame({ type: 'render', id: 'imt1', target: 'main', html: TARGETS_HTML + '<p>again</p>', params: {}, gen: 2 });
    await shell.tick();
    const after = M.itemEl(W.document, 'imt1').el;
    assert.notEqual(after, before, 'a re-render makes a new host');
    assert.equal(after.hasAttribute('data-wc-strokes'), true);
    assert.equal(strokesSheets(after.shadowRoot).length, 1);
    // Disarm: the class and every mark go, and the observer with them.
    ov.setArmed(null);
    assert.equal(html.classList.contains('strokes-armed'), false);
    assert.deepEqual(marked(), [], 'every mark removed');
    await shell.frame({ type: 'render', id: 'imt2', target: 'main', html: '<svg></svg>', params: {}, gen: 1 });
    await shell.tick();
    assert.deepEqual(marked(), [], 'a pane rendered after the disarm is not marked');
    // A taps tool (and a selection tool) arms none of it.
    for (const t of ['im-taps', 'im-selection']) {
      ov.setArmed(t);
      assert.equal(html.classList.contains('strokes-armed'), false, t);
      assert.deepEqual(marked(), [], t);
    }
  } finally {
    ov.setArmed(null);
    IM.setFingerDraws('off');
    removeAdopted();
    await shell.frame({ type: 'clear', id: 'imt2' });
    await shell.tick();
  }
});

test('the strokes sheet (U616): every element in a marked pane root takes touch-action none; an svg, an img, a canvas and a [data-fixed-aspect] also selection and the callout off, a paragraph not those; app.css gives a light-DOM sheet the same', async () => {
  const css = createCascade(IM.STROKES_SHEET, { win: () => W });
  installAdopted();
  try {
    assert.equal(IM.STROKES_TARGETS, 'svg, img, canvas, [data-fixed-aspect]', 'the set C5 and targetFrame name');
    const host = await targetsPane();
    ov.setArmed('box-grab');
    const r = host.shadowRoot;
    const row = (sel) => ['touch-action', 'user-select', '-webkit-user-select', '-webkit-touch-callout'].map((p) => css.value(r.querySelector(sel), p));
    for (const sel of ['.t-svg', '.t-img', '.t-canvas', '.t-sheet']) assert.deepEqual(row(sel), ['none', 'none', 'none', 'none'], sel);
    assert.deepEqual(row('.t-p'), ['none', null, null, null], 'a paragraph: touch-action none (a pane\'s own scroller stops the intersection), selection kept');
    assert.deepEqual(row('.t-in'), ['none', null, null, null], 'inside a sheet: touch-action none');
    host.removeAttribute('data-wc-strokes');
    assert.deepEqual(row('.t-svg'), [null, null, null, null], 'keyed by the host\'s mark');
    assert.deepEqual(row('.t-p'), [null, null, null, null], 'keyed by the host\'s mark');
    host.toggleAttribute('data-wc-strokes', true);
    // The light-DOM rule: a [data-fixed-aspect] under #main, while armed.
    const app = createCascade(CSS, { win: () => W });
    const sheetEl = W.document.createElement('div');
    sheetEl.setAttribute('data-fixed-aspect', '');
    shell.$('main').appendChild(sheetEl);
    try {
      const lrow = () => ['touch-action', 'user-select', '-webkit-user-select', '-webkit-touch-callout'].map((p) => app.value(sheetEl, p));
      assert.deepEqual(lrow(), ['none', 'none', 'none', 'none']);
      ov.setArmed(null);
      assert.deepEqual(lrow(), [null, null, null, null], 'disarmed: the page\'s');
    } finally { sheetEl.remove(); }
  } finally {
    ov.setArmed(null);
    removeAdopted();
  }
});

test('the box grab armed, finger-draws off: two fingers from an svg or a paragraph in a pane scroll the well and create nothing; one finger there is the page\'s', async () => {
  installAdopted();
  try {
    const r = (await targetsPane()).shadowRoot;
    await grabArmed('off');
    const rect = r.querySelector('.t-rect');
    // One finger on the svg: the page's (the named limit: no native pan there).
    finger(rect, 'pointerdown', 121, 30, 300, { isPrimary: true });
    finger(rect, 'pointermove', 121, 30, 260);
    finger(rect, 'pointerup', 121, 30, 260);
    await shell.tick();
    assert.deepEqual(scrollCalls, [], 'one finger: no pan here');
    assert.equal(grabPosts().length, 0, 'and no grab (finger-draws off)');
    // Two fingers from the svg: the pan.
    finger(rect, 'pointerdown', 122, 100, 300, { isPrimary: true });
    finger(rect, 'pointerdown', 123, 200, 300);
    for (const y of [290, 280]) {
      finger(rect, 'pointermove', 122, 100, y);
      finger(rect, 'pointermove', 123, 200, y);
    }
    assert.equal(scroller().scrollTop, 20, 'the well scrolled by the fingers\' travel');
    finger(rect, 'pointerup', 122, 100, 280);
    finger(rect, 'pointerup', 123, 200, 280);
    tapClick(rect, 122);
    tapClick(rect, 123);
    await shell.tick();
    assert.equal(grabPosts().length, 0, 'the pan created nothing');
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
    // Two fingers from the pane's paragraph: the pan too (U616: anywhere in
    // the well, not only from a target).
    scrollCalls.length = 0;
    finger(r.querySelector('.t-p'), 'pointerdown', 124, 100, 300, { isPrimary: true });
    finger(r.querySelector('.t-p'), 'pointerdown', 125, 200, 300);
    finger(r.querySelector('.t-p'), 'pointermove', 124, 100, 280);
    finger(r.querySelector('.t-p'), 'pointermove', 125, 200, 280);
    finger(r.querySelector('.t-p'), 'pointercancel', 124, 100, 280);
    finger(r.querySelector('.t-p'), 'pointercancel', 125, 200, 280);
    assert.ok(scrollCalls.length > 0, 'off a target: scrollBy all the same');
    assert.equal(grabPosts().length, 0);
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] });
  } finally {
    removeAdopted();
    await settle();
    await shell.frame({ type: 'clear', id: 'imt1' });
    await shell.tick();
  }
});

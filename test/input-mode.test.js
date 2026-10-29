// The input-mode policy's table and its finger-draws switch (annotation engine
// 2D.4; public/app/input-mode.js; DECISIONS.md I.6 addendum 3, K.2 items 3, 6,
// 8, 9, 14, 15; rulings D1 (b), D2 (c)). The real chrome (test-support/
// chrome-shell, booted once) for the module graph and a document to classify;
// the dispatch end to end is test/input-mode-chrome.test.js's.
//
// Pinned here:
//   - route() over the whole table — {pen, mouse, touch, '', a keyboard's
//     click (detail 0)} × armed {nothing,
//     taps, strokes, selection} × finger-draws × a pen down × target {static,
//     six kinds of interactive content} × gesture {a tap within TAP_SLOP, a
//     pan} — against the literal EXPECTED table below;
//   - the tap slop is sheet-model's TAP_SLOP (its boundary, and no slop number
//     of the module's own);
//   - isInteractive: the HTML spec's interactive content, through a pane's
//     shadow boundary, stopping at the page well (#stage's tabindex never
//     counts);
//   - dispatchMode: strokes and taps cancel only a drawing pointer's default
//     (a pen's, a mouse's; never a finger's, K.2-43), selection no pointer's
//     (K.2-48); strokes captures, taps and selection capture nothing;
//   - no second state: the module exports no armed state of its own, and
//     POINTER (the pointer tool) is frozen and arms nothing;
//   - finger-draws: auto is on until a pen is seen (pointerover or
//     pointerdown), then the record's default; storage remembers the pen for a
//     fresh module; an explicit on or off binds; storage that throws reads auto;
//   - the two-finger pan (U334a; DECISIONS.md K.4 I1 = b): every finger down
//     in the well is tracked by its pointerId and released at its pointerup or
//     pointercancel (a lifted pan finger's click owed, then spent), a finger
//     outside the well and a pen are never tracked, a primary touch clears what
//     an earlier gesture left; a second finger makes a pan only with a strokes
//     tool armed and finger-draws on, and cancels the first finger's stroke
//     through the overlay's cancelGesture; each finger's policy reading at
//     its pointerdown is kept beside its point (U334b, K.2-99), heard only
//     for a press that went on to the page, and released with the finger;
//   - the well's touch-action per state: manipulation, and none only while a
//     strokes tool is armed with finger-draws on (pinch-zoom off).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell } = require('../test-support/chrome-shell');
const { createCascade } = require('../test-support/css-cascade');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'public/app/input-mode.js'), 'utf8');

let shell, W, IM, ov, TAP_SLOP;
let freshN = 0;
const fresh = () => import(`${pathToFileURL(path.join(REPO, 'public/app/input-mode.js')).href}?fresh=${++freshN}`);

before(async () => {
  shell = await bootShell({});
  W = shell.window;
  IM = await shell.importApp('input-mode.js');
  ov = await shell.importApp('overlay.js');
  ({ TAP_SLOP } = await shell.importApp('sheet-model.js'));
});
after(async () => {
  if (shell) await shell.restore();
});

// ── fixtures: static and interactive content inside the page well ────────────
let FX;
function fixtures() {
  if (FX) return FX;
  const d = W.document;
  const host = d.createElement('div');
  host.id = 'im-fixtures';
  host.innerHTML = `
    <p class="static">plain <em class="deep">text</em></p>
    <a class="bare">no href</a>
    <input class="hidden" type="hidden">
    <div contenteditable="true"><span class="ce-off" contenteditable="false"><b class="ce-off-in">x</b></span></div>
    <button class="btn"><span class="btn-in">Go</span></button>
    <a class="link" href="#x">link</a>
    <input class="field" type="text">
    <div class="role" role="button">role</div>
    <div class="tab" tabindex="-1">tab</div>
    <div class="ce" contenteditable=""><i class="ce-in">edit</i></div>`;
  d.getElementById('main').appendChild(host);
  const pane = d.createElement('div');
  host.appendChild(pane);
  const sr = pane.attachShadow({ mode: 'open' });
  sr.innerHTML = '<p class="s-static">in a pane</p><button class="s-btn"><span class="s-btn-in">B</span></button>';
  const q = (s) => host.querySelector(s);
  const qs = (s) => sr.querySelector(s);
  FX = {
    static: [q('.static'), q('.deep'), q('.bare'), q('.hidden'), q('.ce-off-in'), qs('.s-static')],
    interactive: {
      button: q('.btn-in'),
      'a[href]': q('.link'),
      input: q('.field'),
      '[role=button]': q('.role'),
      '[tabindex]': q('.tab'),
      contenteditable: q('.ce-in'),
      'button in a pane': qs('.s-btn-in'),
    },
  };
  return FX;
}
// The event route() reads: its pointerType and its composed target. 'kbd' is
// a click no pointer made — Enter or Space on a focused control, a field's
// implicit submit — as browsers send it: type click, pointerType '', detail 0.
const evAt = (pointerType, el) => (pointerType === 'kbd'
  ? { type: 'click', detail: 0, pointerType: '', target: el, composedPath: () => [el] }
  : { pointerType, target: el, composedPath: () => [el] });

// ── the literal table ────────────────────────────────────────────────────────
// Each string is 16 answers (T tool, P page, I ignore), grouped by finger-draws
// (off | on), then a pen down (no | yes), then the target (static, interactive),
// then the gesture (a tap within TAP_SLOP, a pan):
//   fd-off·pen-up  fd-off·pen-down  fd-on·pen-up  fd-on·pen-down
//   [st-tap st-pan in-tap in-pan] …
const EXPECTED = {
  'pen nothing': 'PPPP PPPP PPPP PPPP',
  'pen taps': 'TTTT TTTT TTTT TTTT',
  'pen strokes': 'TTTT TTTT TTTT TTTT',
  'pen selection': 'TTTT TTTT TTTT TTTT',
  'mouse nothing': 'PPPP PPPP PPPP PPPP',
  'mouse taps': 'TTTT TTTT TTTT TTTT',
  'mouse strokes': 'TTTT TTTT TTTT TTTT',
  'mouse selection': 'TTTT TTTT TTTT TTTT',
  "'' nothing": 'PPPP PPPP PPPP PPPP',
  "'' taps": 'TTTT TTTT TTTT TTTT',
  "'' strokes": 'TTTT TTTT TTTT TTTT',
  "'' selection": 'TTTT TTTT TTTT TTTT',
  'touch nothing': 'PPPP PPPP PPPP PPPP',
  'touch taps': 'TPPP IIII TPPP IIII',
  'touch strokes': 'PPPP IIII TTPP IIII',
  'touch selection': 'TPPP IIII TTPP IIII',
  'kbd nothing': 'PPPP PPPP PPPP PPPP',
  'kbd taps': 'PPPP PPPP PPPP PPPP',
  'kbd strokes': 'PPPP PPPP PPPP PPPP',
  'kbd selection': 'PPPP PPPP PPPP PPPP',
};
const LETTER = { tool: 'T', page: 'P', ignore: 'I' };

test('route(): the whole table matches the literal EXPECTED, for every static and interactive target', () => {
  const fx = fixtures();
  const tap = { dx: TAP_SLOP, dy: TAP_SLOP };
  const pan = { dx: TAP_SLOP + 10, dy: 2 };
  let cases = 0;
  for (const pointer of ['pen', 'mouse', 'touch', '', 'kbd']) {
    for (const kind of ['nothing', 'taps', 'strokes', 'selection']) {
      const key = `${pointer === '' ? "''" : pointer} ${kind}`;
      const want = EXPECTED[key].replace(/ /g, '');
      for (const [ti, targets] of [[0, fx.static], [1, Object.values(fx.interactive)]]) {
        for (const el of targets) {
          let got = '';
          for (const fd of [false, true]) {
            for (const pd of [false, true]) {
              for (const tgt of [0, 1]) {
                for (const g of [tap, pan]) {
                  if (tgt !== ti) { got += '.'; continue; }
                  const s = { armed: kind === 'nothing' ? null : { type: `t-${kind}`, profile: null },
                    input: kind === 'nothing' ? null : kind, fingerDraws: fd, penDown: pd, gesture: g };
                  got += LETTER[IM.route(evAt(pointer, el), s)];
                  cases++;
                }
              }
            }
          }
          const mask = [...want].map((c, i) => (got[i] === '.' ? '.' : c)).join('');
          assert.equal(got, mask, `${key} on ${ti ? 'interactive' : 'static'} <${el.localName}.${el.className}>`);
        }
      }
    }
  }
  assert.equal(cases, 5 * 4 * 2 * 2 * 2 * (fx.static.length + Object.keys(fx.interactive).length));
  // The pointer tool arms nothing: armed null is every pointer to the page.
  assert.equal(IM.route(evAt('pen', fx.static[0]), { armed: null, input: 'strokes' }), 'page');
  // An unknown pointerType reads as mouse; an unregistered input as taps.
  assert.equal(IM.pointerTypeOf({ pointerType: 'eye-gaze' }), 'mouse');
  assert.equal(IM.pointerTypeOf({}), 'mouse');
  // A real pointer's click (detail >= 1) with an empty pointerType is still the mouse's row.
  const st = fx.static[0];
  const armedTaps = { armed: { type: 't-taps' }, input: 'taps', fingerDraws: false, penDown: false };
  assert.equal(IM.route({ type: 'click', detail: 1, pointerType: '', target: st, composedPath: () => [st] }, armedTaps), 'tool', "'' with detail 1: the mouse");
  assert.equal(IM.route({ type: 'click', detail: 0, target: st, composedPath: () => [st] }, armedTaps), 'page', 'no pointerType at all, detail 0: a keyboard click');
  assert.equal(IM.route(evAt('touch', fx.static[0]), { armed: { type: 'x' }, input: null, gesture: pan }), 'page', 'no input kind: as taps, a pan is the page\'s');
  assert.equal(IM.route(evAt('touch', fx.static[0]), { armed: { type: 'x' }, input: null }), 'tool', 'no gesture yet: a tap so far');
});

test('the tap slop is sheet-model\'s TAP_SLOP: its boundary decides, and the module has no slop of its own', () => {
  const el = fixtures().static[0];
  const s = (dx, dy) => ({ armed: { type: 't' }, input: 'taps', fingerDraws: false, penDown: false, gesture: { dx, dy } });
  assert.equal(IM.route(evAt('touch', el), s(TAP_SLOP, 0)), 'tool');
  assert.equal(IM.route(evAt('touch', el), s(0, TAP_SLOP)), 'tool');
  assert.equal(IM.route(evAt('touch', el), s(TAP_SLOP + 1, 0)), 'page');
  assert.equal(IM.route(evAt('touch', el), s(0, TAP_SLOP + 1)), 'page');
  assert.match(SRC, /import \{[^}]*\bisTap\b[^}]*\} from '\.\/sheet-model\.js'/, 'the one tap rule, imported');
  assert.doesNotMatch(SRC, /SLOP\s*=/, 'no slop constant of its own');
  assert.doesNotMatch(SRC, /[<>]=?\s*\d+\s*[;)]/, 'no literal distance compared');
});

test('isInteractive: the spec\'s interactive content through a pane\'s shadow boundary, stopping at the well', () => {
  const fx = fixtures();
  for (const el of fx.static) assert.equal(IM.isInteractive(el), false, `<${el.localName}.${el.className}> is static`);
  for (const [name, el] of Object.entries(fx.interactive)) assert.equal(IM.isInteractive(el), true, `${name} is interactive`);
  // #stage (an ancestor of the well) carries tabindex="0"; it never counts.
  assert.ok(W.document.getElementById('stage').hasAttribute('tabindex'));
  assert.equal(IM.isInteractive(W.document.getElementById('main')), false);
  assert.equal(IM.isInteractive(null), false);
  for (const tag of ['select', 'textarea', 'label', 'summary']) {
    assert.equal(IM.isInteractive(W.document.createElement(tag)), true, tag);
  }
  assert.ok(Object.isFrozen(IM.INTERACTIVE_ROLES) && IM.INTERACTIVE_ROLES.includes('checkbox'));
});

test('dispatchMode: strokes and taps cancel a drawing pointer\'s default only, selection none; strokes captures, taps and selection capture nothing', () => {
  const ev = (t) => ({ pointerType: t });
  assert.deepEqual(IM.dispatchMode(ev('pen'), 'strokes'), { capture: true, cancelDefault: true });
  assert.deepEqual(IM.dispatchMode(ev('touch'), 'strokes'), { capture: true, cancelDefault: false });
  assert.deepEqual(IM.dispatchMode(ev('mouse'), 'strokes'), { capture: true, cancelDefault: true });
  // K.2-43: the pen, and the mouse as the pen, are wholly a taps tool's; a finger keeps its default (D1).
  // K.2-48: a selection tool keeps every pointer's default (the browser forms the selection).
  for (const t of ['pen', 'touch', 'mouse']) {
    assert.deepEqual(IM.dispatchMode(ev(t), 'taps'), { capture: false, cancelDefault: t !== 'touch' });
    assert.deepEqual(IM.dispatchMode(ev(t), 'selection'), { capture: false, cancelDefault: false });
  }
});

test('no second state: no armed-state export, POINTER frozen and arming nothing', () => {
  for (const name of ['setArmed', 'armed', 'onArmedChange', 'inputKindOf']) {
    assert.equal(name in IM, false, `input-mode.js exports no ${name}`);
  }
  assert.ok(Object.isFrozen(IM.POINTER));
  assert.equal(IM.POINTER.arms, null);
  assert.equal(IM.POINTER.chrome, true);
  assert.ok(Object.isFrozen(IM.POINTER_TABLE));
  assert.deepEqual(Object.keys(IM.POINTER_TABLE).sort(), ['mouse', 'pen', 'touch']);
  assert.match(SRC, /from '\.\/overlay\.js'/, 'the armed state is read from the overlay');
  assert.doesNotMatch(SRC, /let\s+armed/, 'and never held');
  assert.deepEqual(ov.armed(), null);
});

test('finger-draws: auto is on until a pen is seen, then the record default; storage keeps the pen for a fresh module', async () => {
  const LS = W.localStorage;
  LS.removeItem(IM.FINGER_DRAWS_KEY);
  LS.removeItem(IM.PEN_SEEN_KEY);
  const told = [];
  const off = IM.onFingerDrawsChange((v) => told.push(v));
  try {
    assert.deepEqual(IM.fingerDrawsMode(), { mode: 'auto', penSeen: false, recordDefault: false });
    assert.equal(IM.fingerDraws(), true, 'auto: on with no pen seen');
    // a mouse and a finger see no pen
    W.document.body.dispatchEvent(new W.PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
    W.document.body.dispatchEvent(new W.PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    assert.equal(IM.fingerDraws(), true);
    // a hovering pen (Safari reports the Pencil on hover) is a pen seen
    W.document.body.dispatchEvent(new W.PointerEvent('pointerover', { pointerType: 'pen', bubbles: true }));
    assert.equal(IM.fingerDraws(), false, 'a pen seen: the record default (false) shows through');
    assert.equal(LS.getItem(IM.PEN_SEEN_KEY), '1', 'remembered per device');
    assert.equal(told.length, 1);
    assert.equal(told[0].on, false);
    assert.equal(told[0].penSeen, true);
    // the record's default shows through on an auto device once a pen is seen
    IM.setFingerDrawsDefault(true);
    assert.equal(IM.fingerDraws(), true);
    IM.setFingerDrawsDefault(false);
    assert.equal(IM.fingerDraws(), false);
    // a fresh module over the same storage reads it off
    const F = await fresh();
    assert.deepEqual(F.fingerDrawsMode(), { mode: 'auto', penSeen: true, recordDefault: false });
    assert.equal(F.fingerDraws(), false);
    // an explicit on or off binds, whatever the pen and the record say
    IM.setFingerDraws('on');
    assert.equal(LS.getItem(IM.FINGER_DRAWS_KEY), 'on');
    assert.equal(IM.fingerDraws(), true);
    assert.equal(F.fingerDraws(), true, 'the device value is storage\'s, read by every instance');
    IM.setFingerDraws('off');
    IM.setFingerDrawsDefault(true);
    assert.equal(IM.fingerDraws(), false, 'off binds over the record');
    IM.setFingerDrawsDefault(false);
    IM.setFingerDraws('auto');
    assert.equal(IM.fingerDraws(), false);
    assert.throws(() => IM.setFingerDraws('sometimes'), TypeError);
  } finally {
    off();
    LS.removeItem(IM.FINGER_DRAWS_KEY);
    LS.removeItem(IM.PEN_SEEN_KEY);
  }
});

test('finger-draws: a pen pointerdown turns auto off; storage that throws reads auto, on until a pen is seen', async () => {
  const LS = W.localStorage;
  LS.removeItem(IM.FINGER_DRAWS_KEY);
  LS.removeItem(IM.PEN_SEEN_KEY);
  // A fresh module installed in place of the chrome's own: it has seen no pen.
  const mainOff = IM.installInputMode();
  mainOff();
  const F = await fresh();
  const fOff = F.installInputMode();
  try {
    assert.equal(F.fingerDraws(), true);
    W.document.body.dispatchEvent(new W.PointerEvent('pointerdown', { pointerType: 'pen', pointerId: 9, bubbles: true }));
    W.document.body.dispatchEvent(new W.PointerEvent('pointerup', { pointerType: 'pen', pointerId: 9, bubbles: true }));
    assert.equal(F.fingerDraws(), false, 'a pen contact turns auto off');
    assert.equal(LS.getItem(IM.PEN_SEEN_KEY), '1');
  } finally {
    fOff();
    IM.installInputMode();   // the chrome's own policy back
    LS.removeItem(IM.PEN_SEEN_KEY);
  }
  // Storage whose accessor throws (a private window): auto, on until a pen is seen.
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const G = await fresh();
    assert.deepEqual(G.fingerDrawsMode(), { mode: 'auto', penSeen: false, recordDefault: false });
    assert.equal(G.fingerDraws(), true);
    G.setFingerDraws('off');
    assert.equal(G.fingerDraws(), false, 'a choice the storage would not keep still holds this session');
    G.setFingerDraws('auto');
    G.notePen();
    assert.equal(G.fingerDraws(), false, 'and a pen seen this session still counts');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', desc);
  }
});

// ── the two-finger pan (U334a; K.4 I1 = b) ───────────────────────────────────
function touchAt(el, type, pointerId, extra = {}) {
  el.dispatchEvent(new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId, isPrimary: false,
    clientX: 100, clientY: 100, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  }));
}

test('the two-finger pan: each finger tracked by pointerId and released at pointerup or pointercancel; no stale entry after the gesture', () => {
  const el = fixtures().static[0];
  const created = [];
  const off = ov.registerType('imp-strokes', { draw() {}, input: 'strokes', create: (inp) => created.push([inp.phase, inp.event.pointerId]) });
  const empty = { touches: [], pan: null, clicks: [] };
  IM.installInputMode();
  IM.setFingerDraws('on');
  ov.setArmed('imp-strokes');
  try {
    assert.deepEqual(IM.touchesForTests(), empty);
    touchAt(el, 'pointerdown', 41, { isPrimary: true });
    assert.deepEqual(IM.touchesForTests(), { touches: [41], pan: null, clicks: [] }, 'one finger: tracked, no pan');
    assert.deepEqual(created, [['pointerdown', 41]], 'and it draws');
    touchAt(el, 'pointerdown', 42);
    assert.deepEqual(IM.touchesForTests(), { touches: [41, 42], pan: [41, 42], clicks: [] }, 'a second finger: a pan');
    assert.deepEqual(created, [['pointerdown', 41], ['pointercancel', 41]], 'the stroke cancelled toward the tool; the second finger never reached it');
    touchAt(el, 'pointerup', 41);
    assert.deepEqual(IM.touchesForTests(), { touches: [42], pan: [42], clicks: [41] }, 'released at its pointerup; its click is owed');
    touchAt(el, 'pointercancel', 42);
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [41] }, 'released at its pointercancel (no click follows one)');
    el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId: 41, detail: 1 }));
    assert.deepEqual(IM.touchesForTests(), empty, 'the click spent: nothing left of the gesture');
    assert.deepEqual(created, [['pointerdown', 41], ['pointercancel', 41]], 'the pan created nothing');
    // A finger outside the well and a pen are never tracked.
    touchAt(W.document.body, 'pointerdown', 43, { isPrimary: true });
    el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, composed: true, pointerType: 'pen', pointerId: 44, isPrimary: true, buttons: 1 }));
    assert.deepEqual(IM.touchesForTests(), empty);
    el.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, composed: true, pointerType: 'pen', pointerId: 44, isPrimary: true }));
    touchAt(W.document.body, 'pointerup', 43);
    // A primary touch is a new touch: what a lost gesture left is cleared.
    touchAt(el, 'pointerdown', 45, { isPrimary: true });
    touchAt(el, 'pointerdown', 46, { isPrimary: true });
    assert.deepEqual(IM.touchesForTests(), { touches: [46], pan: null, clicks: [] });
    touchAt(el, 'pointerup', 46);
    assert.deepEqual(IM.touchesForTests(), empty);
    // Finger-draws off: two fingers are tracked, and never a pan.
    IM.setFingerDraws('off');
    touchAt(el, 'pointerdown', 47, { isPrimary: true });
    touchAt(el, 'pointerdown', 48);
    assert.deepEqual(IM.touchesForTests(), { touches: [47, 48], pan: null, clicks: [] });
    touchAt(el, 'pointercancel', 47);
    touchAt(el, 'pointercancel', 48);
    assert.deepEqual(IM.touchesForTests(), empty);
  } finally {
    ov.setArmed(null);
    off();
    IM.setFingerDraws('auto');
    W.localStorage.removeItem(IM.FINGER_DRAWS_KEY);
  }
});

test('the per-finger route: each finger\'s policy reading at its pointerdown is kept beside its point, heard only for a press that went on to the page, and released with the finger', () => {
  const fx = fixtures();
  const el = fx.static[0];
  const btn = fx.interactive.button;
  const off = ov.registerType('imp-strokes-r', { draw() {}, input: 'strokes', create() {} });
  const empty = { touches: [], pan: null, clicks: [], routes: {}, heard: [] };
  IM.installInputMode();
  IM.setFingerDraws('on');
  ov.setArmed('imp-strokes-r');
  try {
    assert.deepEqual(IM.touchesForTests({ routes: true }), empty);
    touchAt(btn, 'pointerdown', 91, { isPrimary: true });
    assert.deepEqual(IM.touchesForTests({ routes: true }),
      { touches: [91], pan: null, clicks: [], routes: { 91: 'page' }, heard: [91] }, 'a control: the page\'s, its press heard');
    touchAt(el, 'pointerdown', 92);
    assert.deepEqual(IM.touchesForTests({ routes: true }),
      { touches: [91, 92], pan: [91, 92], clicks: [], routes: { 91: 'page', 92: 'tool' }, heard: [91] },
      'the finger that starts the pan: its press stopped, never heard');
    touchAt(btn, 'pointerdown', 93);
    assert.deepEqual(IM.touchesForTests({ routes: true }).heard, [91], 'a finger landing on a control during the pan: its press stopped, not heard');
    assert.equal(IM.touchesForTests({ routes: true }).routes[93], 'page');
    touchAt(btn, 'pointerup', 91);
    assert.deepEqual(IM.touchesForTests({ routes: true }),
      { touches: [92, 93], pan: [92, 93], clicks: [91], routes: { 92: 'tool', 93: 'page' }, heard: [] }, 'released with the finger');
    touchAt(el, 'pointercancel', 92);
    touchAt(btn, 'pointercancel', 93);
    btn.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', pointerId: 91, detail: 1 }));
    assert.deepEqual(IM.touchesForTests({ routes: true }), empty, 'nothing left of the gesture');
    // The finger that starts the pan on a control: its press is stopped, so
    // its lift is the pan's too.
    touchAt(el, 'pointerdown', 96, { isPrimary: true });
    touchAt(btn, 'pointerdown', 97);
    assert.deepEqual(IM.touchesForTests({ routes: true }),
      { touches: [96, 97], pan: [96, 97], clicks: [], routes: { 96: 'tool', 97: 'page' }, heard: [] },
      'the pan\'s second finger, on a control: never heard');
    touchAt(btn, 'pointercancel', 97);
    touchAt(el, 'pointercancel', 96);
    assert.deepEqual(IM.touchesForTests({ routes: true }), empty);
    // A finger while a pen is down reads 'ignore': no pane hears it.
    el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, composed: true, pointerType: 'pen', pointerId: 94, isPrimary: true, buttons: 1 }));
    touchAt(btn, 'pointerdown', 95, { isPrimary: true });
    assert.deepEqual(IM.touchesForTests({ routes: true }),
      { touches: [95], pan: null, clicks: [], routes: { 95: 'ignore' }, heard: [] });
    touchAt(btn, 'pointerup', 95);
    el.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, composed: true, pointerType: 'pen', pointerId: 94, isPrimary: true }));
    assert.deepEqual(IM.touchesForTests({ routes: true }), empty);
    assert.deepEqual(IM.touchesForTests(), { touches: [], pan: null, clicks: [] }, 'the plain snapshot keeps its shape');
  } finally {
    ov.setArmed(null);
    off();
    IM.setFingerDraws('auto');
    W.localStorage.removeItem(IM.FINGER_DRAWS_KEY);
    W.localStorage.removeItem(IM.PEN_SEEN_KEY);
  }
});

// K.2-104 (U404): the overlay gives the page every pointer while a previous
// node is previewed (overlay.js onPointer's `if (view.previewing) return`, D2),
// so the pan's reading of a finger at its pointerdown says the same: a strokes
// tool armed before the preview never makes a press the pane heard read 'tool'.
test('routeAtDown: the table\'s reading on the live page; \'page\' for every pointer type while a previous node is previewed (K.2-104)', async () => {
  const { view } = await shell.importApp('state.js');
  const fx = fixtures();
  const el = fx.static[0];
  const btn = fx.interactive.button;
  const inPane = fx.interactive['button in a pane'];
  const off = ov.registerType('imp-strokes-p', { draw() {}, input: 'strokes', create() {} });
  IM.setFingerDraws('on');
  ov.setArmed('imp-strokes-p');
  const types = ['pen', 'mouse', 'touch', '', 'kbd'];
  const read = () => Object.fromEntries(types.map((t) => [t || "''",
    [el, btn, inPane].map((x) => IM.routeAtDown(evAt(t, x))).join(' ')]));
  try {
    assert.equal(view.previewing, false);
    assert.deepEqual(read(), {
      pen: 'tool tool tool', mouse: 'tool tool tool', touch: 'tool page page', "''": 'tool tool tool', kbd: 'page page page',
    }, 'live: the table (a strokes tool armed, fingers drawing)');
    view.previewing = true;
    assert.deepEqual(read(), {
      pen: 'page page page', mouse: 'page page page', touch: 'page page page', "''": 'page page page', kbd: 'page page page',
    }, 'previewing: every pointer is the page\'s');
    ov.setArmed(null);
    assert.deepEqual(new Set(Object.values(read()).join(' ').split(' ')), new Set(['page']), 'and with nothing armed');
  } finally {
    view.previewing = false;
    ov.setArmed(null);
    off();
    IM.setFingerDraws('auto');
    W.localStorage.removeItem(IM.FINGER_DRAWS_KEY);
    W.localStorage.removeItem(IM.PEN_SEEN_KEY);
  }
});

// The last-tool key's reading of focus (tools.js, F.4): a focus sink is no
// control, a [tabindex="-1"] control stays one.
test('isFocusSink: #stage and a [tabindex="-1"] container are sinks; a control, a field or a [tabindex="-1"] control is not', () => {
  const d = W.document;
  const fx = fixtures();
  assert.equal(IM.isFocusSink(d.getElementById('stage')), true, '#stage, the page\'s focusable scroll container');
  assert.equal(IM.isFocusSink(d.getElementById('overlay')), true, 'the overlay dialog (tabindex="-1")');
  assert.equal(IM.isFocusSink(fx.interactive['[tabindex]']), true, 'a <div tabindex="-1">');
  const make = (html) => { const box = d.createElement('div'); box.innerHTML = html; return box.firstElementChild; };
  for (const [name, el] of [
    ['a <button tabindex="-1">', make('<button tabindex="-1">x</button>')],
    ['a role="option" row with tabindex="-1"', make('<li role="option" tabindex="-1">x</li>')],
    ['a contenteditable with tabindex="-1"', make('<div contenteditable="true" tabindex="-1">x</div>')],
    ['a <div tabindex="0">', make('<div tabindex="0">x</div>')],
    ['a button', fx.interactive.button],
    ['a field', fx.interactive.input],
    ['the body', d.body],
    ['static text', fx.static[0]],
  ]) assert.equal(IM.isFocusSink(el), false, name);
  assert.equal(IM.isFocusSink(null), false);
  const stray = d.createElement('div');
  stray.id = 'stage';
  assert.equal(IM.isFocusSink(stray), false, 'only the document\'s own #stage');
});

test('the well\'s touch-action per state: none only while a strokes tool is armed with finger-draws on (pinch-zoom off), else manipulation', () => {
  const css = createCascade(fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8'), { win: () => W });
  const main = W.document.getElementById('main');
  const offs = ['taps', 'strokes', 'selection'].map((input) => ov.registerType(`ita-${input}`, { draw() {}, input, create() {} }));
  IM.installInputMode();
  const rows = [];
  try {
    for (const fd of ['off', 'on']) {
      IM.setFingerDraws(fd);
      for (const type of [null, 'ita-taps', 'ita-strokes', 'ita-selection']) {
        ov.setArmed(type);
        rows.push(`${fd} ${type || 'nothing'} ${css.value(main, 'touch-action')} ${IM.fingerStrokes()}`);
      }
    }
  } finally {
    ov.setArmed(null);
    for (const off of offs) off();
    IM.setFingerDraws('auto');
    W.localStorage.removeItem(IM.FINGER_DRAWS_KEY);
  }
  assert.deepEqual(rows, [
    'off nothing manipulation false',
    'off ita-taps manipulation false',
    'off ita-strokes manipulation false',
    'off ita-selection manipulation false',
    'on nothing manipulation false',
    'on ita-taps manipulation false',
    'on ita-strokes none true',
    'on ita-selection manipulation false',
  ]);
  assert.equal(W.document.documentElement.classList.contains('finger-strokes'), false);
});

// U434a (K.2-181, corrective to U434 and U431): a [tabindex="-1"] focus sink
// inside a registered non-page host's root is that host's scroll box, never a
// control — the chat's #chat-stream (tabindex -1 for focus, role log) — so a
// finger's tap on the static text it holds is the armed tool's. A control in
// the stream stays one, and the page's own sinks read as they did.
test('isInteractive: a [tabindex="-1"] focus sink inside a host root is no control; a control there stays one; the page\'s sinks unchanged', () => {
  const d = W.document;
  const fx = fixtures();
  const views = d.getElementById('chat-views');
  const stream = d.getElementById('chat-stream');
  assert.ok(views && stream && ov.isHostRoot(views), 'the chat host is registered over #chat-views');
  assert.equal(stream.getAttribute('tabindex'), '-1', '#chat-stream carries tabindex -1');
  assert.equal(IM.isFocusSink(stream), true, '#chat-stream is a focus sink');
  const box = d.createElement('div');
  box.id = 'im-host-sink';
  box.innerHTML = `
    <p class="hs-static">reply <em class="hs-deep">text</em></p>
    <div class="hs-sink" tabindex="-1"><span class="hs-sink-in">inner sink</span></div>
    <button class="hs-btn" tabindex="-1"><span class="hs-btn-in">x</span></button>
    <li class="hs-opt" role="option" tabindex="-1">opt</li>
    <div class="hs-tab0" tabindex="0">focusable</div>
    <div class="hs-ce" contenteditable="true" tabindex="-1">edit</div>`;
  stream.appendChild(box);
  const q = (s) => box.querySelector(s);
  try {
    for (const [name, el] of [
      ['#chat-stream itself', stream],
      ['static reply text', q('.hs-static')],
      ['deep static text', q('.hs-deep')],
      ['a nested [tabindex="-1"] sink', q('.hs-sink')],
      ['text inside a nested sink', q('.hs-sink-in')],
    ]) assert.equal(IM.isInteractive(el), false, `${name} is static`);
    for (const [name, el] of [
      ['a [tabindex="-1"] button', q('.hs-btn-in')],
      ['a [tabindex="-1"] role="option" row', q('.hs-opt')],
      ['a [tabindex="0"] element', q('.hs-tab0')],
      ['a [tabindex="-1"] contenteditable', q('.hs-ce')],
    ]) assert.equal(IM.isInteractive(el), true, `${name} is a control`);
    // The table: a finger's tap on the stream's static text is the tool's.
    const off = ov.registerType('ita-host-taps', { draw() {}, input: 'taps', create() {} });
    try {
      assert.equal(IM.route(evAt('touch', q('.hs-static')), { armed: 'ita-host-taps', input: 'taps' }), 'tool');
      assert.equal(IM.route(evAt('touch', q('.hs-btn-in')), { armed: 'ita-host-taps', input: 'taps' }), 'page');
    } finally { off(); }
  } finally { box.remove(); }
  // The page's own sinks read as before: a [tabindex="-1"] div in the well
  // is a control's (the table's '[tabindex]' row), and #stage and the overlay
  // dialog, outside every host root, keep their tabindex reading.
  assert.equal(IM.isInteractive(fx.interactive['[tabindex]']), true, 'a <div tabindex="-1"> in the page well');
  assert.equal(IM.isInteractive(d.getElementById('stage')), true, '#stage (tabindex="0")');
  assert.equal(IM.isInteractive(d.getElementById('overlay')), true, 'the overlay dialog (tabindex="-1")');
  const pane = d.createElement('div');
  d.getElementById('im-fixtures').appendChild(pane);
  const sr = pane.attachShadow({ mode: 'open' });
  sr.innerHTML = '<div class="s-sink" tabindex="-1">in a pane</div>';
  try {
    assert.equal(IM.isInteractive(sr.querySelector('.s-sink')), true, 'a [tabindex="-1"] div in a pane');
  } finally { pane.remove(); }
});

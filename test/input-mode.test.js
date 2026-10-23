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
//     fresh module; an explicit on or off binds; storage that throws reads auto.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell } = require('../test-support/chrome-shell');

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

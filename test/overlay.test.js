// The page well's element overlay: its inputs, its passes and its seams
// (annotation engine 2A.1; public/app/overlay.js). The real chrome
// (test-support/chrome-shell, booted once); the overlay's frames run on a fake
// scheduler the test flushes, the resolver's on the shell's frames.
//
// Pinned here:
//   - the passes: two settles of a watched pane before one frame give one pass,
//     a re-render re-resolves once per settle, an unwatched mount's settle
//     costs no pass;
//   - onAnswers delivers once per pass with the probe applied (a probe marking
//     a mount hidden turns its orphans into 'hidden', never 'orphaned'), and the
//     draw frame is not the resolver's delivering frame (no box read inside the
//     delivery; the reads wait for the overlay's own frame);
//   - a settle of one pane that changed no DOM leaves another pane's marker
//     (and the range's own) the same DOM node: a range group is keyed by its
//     boundary points, never by the fresh Range a pass hands back (F11);
//   - hello and reset carrying `elements` and `surface` fill the live set and
//     onAnswers' surface; frames without them leave it empty without error;
//   - a preview draws the previewed node's `lean_elements` (its id@v refs held
//     pending, undrawn), leaving it draws the live set again, and no create or
//     pick runs while previewing;
//   - the pointer dispatch: an armed test type's create gets the click and the
//     page does not; with nothing armed and no pick the well has no capture
//     listener; a policy answering 'page' lets the click reach the pane with the
//     tool still armed (K.2-9); pick({kind:'element'}) resolves with record() of
//     the clicked element;
//   - each pointer's gesture is its own (U302a): a palm landing during a pen
//     stroke, in either order, never swallows or pollutes the stroke; a lone
//     click with no live gesture asks the policy again, so a keyboard click
//     after a touch pan (its click nobody's, or never sent) is the button's;
//     the input-mode policy's dispatchMode decides preventDefault and pointer
//     capture per pointer (a finger's default never cancelled; a pen's and a
//     mouse's cancelled for every kind, and captured for a strokes tool);
//     a click that names a pointer takes that pointer's gesture alone, so a
//     keyboard click (pointerId -1, detail 0) after a mouse released outside
//     the well, or while a pen is down, is the button's and drops no pin;
//   - the one armed state (K.2-3, K.2-14): each subscriber told once, an equal
//     value tells nobody, an unsubscribe stops it; the profile rides it;
//     inputKindOf answers the registered kind;
//   - DRAW_RULES and EDIT_TOLERANCE are frozen and exported; RESERVED_IDS holds
//     'el-layer'.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { convertAnchor } = require('../lib/core/element-log');
const { RESERVED_IDS } = require('../lib/server/domain/mounts');

let shell, W, M, ov, anchors, bus, topbar, IM, TAP_SLOP;

const queue = [];
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(0); n++; }
  return n;
}
let reads = 0;
const rectOf = () => { reads++; return { left: 200, top: 200, width: 40, height: 16, right: 240, bottom: 216, x: 200, y: 200 }; };

const PANE = (id, extra = '') => ({
  id, target: 'main', params: {},
  html: `<p class="lead">lead of ${id}</p><button class="go">Go</button>${extra}<script>
    root.querySelector('.go').addEventListener('click', function () { window.__goClicks.push(mountId); });
  </script>`,
});
const P1 = PANE('p1');
const P2 = PANE('p2');

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const layer = () => W.document.getElementById('el-layer');
const markersFor = (id) => [...layer().querySelectorAll('.el-marker')]
  .filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const lead = (id) => rootOf(id).querySelector('p.lead');
const goBtn = (id) => rootOf(id).querySelector('button.go');
const rowOn = (id, mount, el, extra = {}) => ({ id, v: 1, type: 'comment', anchor: anchors.record(rootOf(mount), el, { mount }), shared: true, replies: 0, ...extra });

// Every onAnswers message, kept for the tests to read.
const delivered = [];

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }, { id: 'n2', label: 'n2', parent_id: 'n1', created_at: 2 }], active: 'n1' },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  W.__goClicks = [];
  ov = await shell.importApp('overlay.js');
  anchors = (await shell.importApp('anchors.js')).default;
  bus = (await shell.importApp('bus.js')).bus;
  topbar = await shell.importApp('topbar.js');
  IM = await shell.importApp('input-mode.js');
  ({ TAP_SLOP } = await shell.importApp('sheet-model.js'));
  await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2] }));
  ov.initOverlay({ rectOf, raf: fakeRaf });
  ov.onAnswers((m) => delivered.push(m));
  await shell.tick();
  flush();
});

after(async () => { if (shell) await shell.restore(); });

const countFor = (mount) => delivered.filter((m) => m.mount === mount).length;
async function settleAll(ms = 120) {
  // the resolver's frames are the shell's tracked timeouts
  for (let i = 0; i < ms / 20; i++) await shell.tick(20);
}

test('passes: two settles before a frame give one pass; a re-render re-resolves once; an unwatched mount\'s settle costs none', async () => {
  ov.setElements('live', [rowOn('c1', 'p1', lead('p1'))]);
  await waitUntil(() => countFor('p1') >= 1, { what: 'the set change\'s pass' });
  await settleAll();
  const n0 = countFor('p1');
  const root = rootOf('p1');
  M.settle(root, 'p1', 'test');
  M.settle(root, 'p1', 'test');
  await waitUntil(() => countFor('p1') > n0, { what: 'the settle pass' });
  await settleAll();
  assert.equal(countFor('p1'), n0 + 1, 'two settles, one pass');
  // A re-render settles once and re-resolves once.
  const n1 = countFor('p1');
  await shell.frame({ type: 'render', ...P1, html: P1.html.replace('lead of p1', 'lead of p1') + '<i>x</i>' });
  await waitUntil(() => countFor('p1') > n1, { what: 'the re-render pass' });
  await settleAll();
  assert.equal(countFor('p1'), n1 + 1, 'one pass per settle');
  assert.equal(delivered[delivered.length - 1].items[0].state, 'exact');
  // Nothing watches p2.
  M.settle(rootOf('p2'), 'p2', 'test');
  await settleAll();
  assert.equal(countFor('p2'), 0, 'an unwatched mount\'s settle runs no pass');
  ov.setElements('live', []);
  flush();
});

test('onAnswers: once per pass, the probe applied — a hidden mount\'s orphans read hidden, never orphaned', async () => {
  const orphan = convertAnchor({ mount: 'p2', selector: 'p.nothing-here', ordinal: 0, text: 'x' });
  const offProbe = ov.setHiddenProbe(({ mount }) => (mount === 'p2' ? 'test-hidden' : null));
  try {
    const n0 = countFor('p2');
    ov.setElements('live', [rowOn('c2', 'p2', lead('p2')), { id: 'c3', v: 2, type: 'comment', anchor: orphan, shared: true, replies: 0 }]);
    await waitUntil(() => countFor('p2') > n0, { what: 'p2\'s pass' });
    await settleAll();
    assert.equal(countFor('p2'), n0 + 1, 'one delivery for the one pass');
    const msg = delivered.filter((m) => m.mount === 'p2').pop();
    assert.deepEqual(msg.items.map((i) => [i.id, i.state]), [['c2', 'hidden'], ['c3', 'hidden']]);
    assert.equal(msg.items[1].how, 'locator-none', 'the resolver\'s how rides along');
    assert.equal(msg.scope, 'live');
    assert.deepEqual(ov.orphans(), [], 'a hidden element is not an orphan');
    flush();
    assert.equal(markersFor('c2').length, 0, 'nor is it drawn');
  } finally { offProbe(); }
  // The probe gone, the orphan is one again.
  assert.deepEqual(ov.orphans().map((o) => o.id), ['c3']);
  ov.setElements('live', []);
  flush();
});

test('the draw frame is not the resolver\'s delivering frame: no box read inside the delivery', async () => {
  flush();
  let readsAtDelivery = null;
  let queuedAtDelivery = null;
  const off = ov.onAnswers((m) => { if (m.mount === 'p1') { readsAtDelivery = reads; queuedAtDelivery = queue.length; } });
  const r0 = reads;
  try {
    ov.setElements('live', [rowOn('c4', 'p1', lead('p1'))]);
    await waitUntil(() => readsAtDelivery !== null, { what: 'the delivery' });
  } finally { off(); }
  assert.equal(readsAtDelivery, r0, 'no box was read before or during the delivery');
  assert.ok(queuedAtDelivery > 0, 'a draw frame was asked for');
  flush();
  assert.ok(reads > r0, 'the boxes are read in the overlay\'s own frame');
  assert.equal(markersFor('c4').length, 1);
  ov.setElements('live', []);
  flush();
});

test('a settle that moved nothing keeps every marker: a range row\'s fresh Range is not a new group (F11)', async () => {
  // A range on p1 (the resolver builds a fresh Range on every pass) and an
  // element row on p2. A pass over p1 that changed no DOM must leave the
  // drawn set's signature alone, so p2's marker stays the same DOM node.
  const text = lead('p1').firstChild;
  const range = W.document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 'lead'.length);
  const hl = { id: 'h1', v: 1, type: 'highlight', anchor: anchors.recordRange(rootOf('p1'), range, { mount: 'p1' }), shared: true, replies: 0 };
  ov.setElements('live', [hl, rowOn('c10', 'p2', lead('p2'))]);
  await waitUntil(() => ov.stats().anchors === 2, { what: 'both answers' });
  await settleAll();
  flush();
  const [m1] = markersFor('h1');
  const [m2] = markersFor('c10');
  assert.ok(m1 && m2, 'both rows are drawn');
  const n0 = countFor('p1');
  M.settle(rootOf('p1'), 'p1', 'test');
  await waitUntil(() => countFor('p1') > n0, { what: 'p1\'s settle pass' });
  await settleAll();
  flush();
  assert.equal(delivered.filter((m) => m.mount === 'p1').pop().items[0].state, 'exact');
  assert.strictEqual(markersFor('c10')[0], m2, 'the other pane\'s marker is the same DOM node');
  assert.strictEqual(markersFor('h1')[0], m1, 'and so is the range\'s own');
  ov.setElements('live', []);
  flush();
});

test('hello and reset fill the live set and onAnswers\' surface; frames without the fields leave it empty', async () => {
  const errs = [];
  const ownErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const row = rowOn('c5', 'p1', lead('p1'));
    const n0 = countFor('p1');
    await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2], elements: [row], surface: 7 }));
    assert.deepEqual(ov.elementsOf('live').map((r) => r.id), ['c5']);
    assert.equal(ov.surfaceOf('live'), 7);
    await waitUntil(() => countFor('p1') > n0, { what: 'the hello\'s pass' });
    assert.equal(delivered.filter((m) => m.mount === 'p1').pop().surface, 7, 'onAnswers carries the surface');
    await shell.frame({ type: 'reset', active: 'n1', store: {}, lock: null, theme: null, activeTheme: null, mounts: [P1, P2],
      elements: [row, rowOn('c6', 'p2', lead('p2'))], surface: 8 });
    assert.deepEqual(ov.elementsOf('live').map((r) => r.id), ['c5', 'c6']);
    assert.equal(ov.surfaceOf('live'), 8);
    // Before U304: neither field.
    await shell.frame({ type: 'reset', active: 'n1', store: {}, lock: null, theme: null, activeTheme: null, mounts: [P1, P2] });
    assert.deepEqual(ov.elementsOf('live'), []);
    assert.equal(ov.surfaceOf('live'), null);
    await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2] }));
    assert.deepEqual(ov.elementsOf('live'), []);
    assert.equal(ov.surfaceOf('live'), null);
  } finally { console.error = ownErr; }
  assert.deepEqual(errs.filter((e) => /overlay|frame handler|hello hook/.test(e)), [], 'no error');
  flush();
});

test('a preview draws the node\'s lean rows (its refs pending), leaving it draws the live set; no create or pick while previewing', async () => {
  const live = rowOn('c7', 'p1', lead('p1'));
  ov.setElements('live', [live]);
  await waitUntil(() => ov.stats().anchors === 1, { what: 'the live answer' });
  flush();
  assert.equal(markersFor('c7').length, 1);
  // The node as GET /api/graph/node/n2 answers: U304's lean rows over its 0.8.5
  // copies (anchors already converted), and one id@v reference.
  const node = {
    id: 'n2', mounts: [P1, P2], store: {}, created_at: 2,
    lean_elements: [
      { id: 'c8', v: 2, type: 'comment', anchor: convertAnchor({ mount: 'p1', selector: 'p.lead', ordinal: 0, text: 'lead of p1' }), shared: true, replies: 1, answered: true },
      { id: 'c9', v: 1, type: 'comment', anchor: convertAnchor({ mount: 'p2', selector: 'p.lead', ordinal: 0, text: 'lead of p2' }), shared: false, replies: 0, answered: false },
    ],
    elements: ['h4@3'],
  };
  shell.setRoutes({ '/api/graph/node/n2': node });
  const seen = [];
  const off = bus.on('preview:node', (d) => seen.push(d));
  const created = [];
  const offType = ov.registerType('tt', { draw() {}, create: (input) => created.push(input), input: 'taps' });
  try {
    await topbar.previewNode('n2');
    await shell.tick();
    assert.equal(seen.length, 1, 'previewNode emits preview:node');
    assert.equal(seen[0].id, 'n2');
    assert.equal(ov.drawnScopeOf(), 'preview');
    assert.deepEqual(ov.elementsOf('preview').map((r) => [r.id, r.v, r.pending]),
      [['c8', 2, false], ['c9', 1, false], ['h4', 3, true]]);
    await waitUntil(() => ov.stats().anchors === 2, { what: 'the preview\'s answers' });
    flush();
    assert.equal(markersFor('c8').length, 1, 'a lean row is drawn');
    assert.equal(markersFor('c9').length, 1);
    assert.equal(markersFor('h4').length, 0, 'a pending ref draws nothing');
    assert.equal(markersFor('c7').length, 0, 'the live set is not drawn over a preview');
    // Read-only: an armed tool creates nothing, a pick resolves null.
    ov.setArmed('tt');
    shell.click(goBtn('p1'));
    assert.deepEqual(created, [], 'no create while previewing');
    const pk = ov.pick({ kind: 'element' });
    assert.equal(await pk.promise, null, 'no pick while previewing');
    ov.setArmed(null);
    topbar.returnToActive();
    await shell.tick();
    assert.equal(ov.drawnScopeOf(), 'live');
    assert.deepEqual(ov.elementsOf('preview'), [], 'the preview set goes with the preview');
    await waitUntil(() => ov.stats().anchors === 1, { what: 'the live answer again' });
    flush();
    assert.equal(markersFor('c7').length, 1, 'the live set is drawn again');
    assert.equal(markersFor('c8').length, 0);
  } finally { off(); offType(); ov.setArmed(null); }
  ov.setElements('live', []);
  flush();
});

test('pointer dispatch: no listener unarmed; the armed tool gets the click, not the page; a \'page\' policy lets it through armed; pick records', async () => {
  // The page host's capture listeners sit on the well that holds #main (U614,
  // REQ@margins (a): the .well-wrap, its gutters included).
  const main = W.document.getElementById('main').closest('.well-wrap');
  const added = [];
  const removed = [];
  const ownAdd = main.addEventListener;
  const ownRemove = main.removeEventListener;
  main.addEventListener = function (t, fn, o) { added.push([t, o]); return ownAdd.call(this, t, fn, o); };
  main.removeEventListener = function (t, fn, o) { removed.push([t, o]); return ownRemove.call(this, t, fn, o); };
  const created = [];
  const offType = ov.registerType('tt', { draw() {}, create: (input, ctx) => created.push({ input, ctx }), input: 'taps' });
  try {
    W.__goClicks = [];
    shell.click(goBtn('p1'));
    assert.deepEqual(W.__goClicks, ['p1'], 'unarmed, the page gets the click');
    assert.equal(added.filter(([, o]) => o === true).length, 0, 'no capture listener while nothing is armed');
    assert.equal(ov.stats().listening, false);
    ov.setArmed('tt', 'red-pen');
    assert.ok(added.some(([t, o]) => t === 'click' && o === true), 'arming listens on the well, capture phase');
    shell.press(goBtn('p1'));
    assert.deepEqual(W.__goClicks, ['p1'], 'the page did not get the armed click');
    assert.equal(created.length, 1, 'the armed type\'s create got it (a taps tool: the click)');
    const { input, ctx } = created[0];
    assert.equal(input.phase, 'click');
    assert.equal(input.mount, 'p1');
    assert.equal(input.target, goBtn('p1'), 'the composed target inside the pane');
    assert.equal(input.profile, 'red-pen');
    assert.equal(input.kind, 'taps');
    assert.deepEqual(ctx.armed, { type: 'tt', profile: 'red-pen' });
    // K.2-9: a policy answering 'page' lets the control act, the tool armed.
    const policyCalls = [];
    const offPolicy = ov.setPointerPolicy((e, { armed }) => { policyCalls.push([e.type, armed && armed.type]); return 'page'; });
    try {
      shell.press(goBtn('p1'));
    } finally { offPolicy(); }
    assert.deepEqual(W.__goClicks, ['p1', 'p1'], 'the click reached the pane\'s button');
    assert.equal(created.length, 1, 'and not the tool');
    assert.deepEqual(policyCalls, [['pointerdown', 'tt']], 'consulted once, at the gesture\'s pointerdown');
    assert.deepEqual(ov.armed(), { type: 'tt', profile: 'red-pen' }, 'the tool stays armed');
    ov.setArmed(null);
    assert.ok(removed.some(([t, o]) => t === 'click' && o === true), 'disarming stops listening');
    assert.equal(ov.stats().listening, false);
    // pick: the next press records the element through the resolver.
    const pk = ov.pick({ kind: 'element' });
    assert.equal(ov.stats().listening, true, 'a pending pick listens');
    shell.click(lead('p2'));
    const got = await pk.promise;
    assert.deepEqual(got, { kind: 'element', record: anchors.record(rootOf('p2'), lead('p2'), { mount: 'p2' }), mount: 'p2' });
    assert.equal(ov.stats().listening, false, 'and stops once it resolved');
    const pk2 = ov.pick({ kind: 'element' });
    pk2.cancel();
    assert.equal(await pk2.promise, null, 'cancel resolves null');
    assert.throws(() => ov.pick({ kind: 'nope' }), TypeError);
  } finally {
    offType();
    ov.setArmed(null);
    main.addEventListener = ownAdd;
    main.removeEventListener = ownRemove;
  }
});

// ── each pointer's gesture (U302a) ─────────────────────────────────────────
// The input-mode policy the chrome installs (main.js), put back at the
// overlay's one dispatch: the test above replaced it and took its own away.
function withInputMode() {
  const un = IM.installInputMode();
  un();
  return IM.installInputMode();
}
// A pressed pointer reports a button down (buttons 1) on its pointerdown and
// moves, as browsers send it: a move with buttons 0 is a hover (U302b).
function pe(el, type, pointerType, pointerId, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true, clientX: 100, clientY: 100, detail: type === 'click' ? 1 : 0,
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

test('a palm landing during a pen stroke never swallows the rest of the stroke: pen 11 down, palm 12 down (ignore), pen 11 moves reach create, palm 12 reaches nothing', () => {
  const offIM = withInputMode();
  IM.setFingerDraws('off');
  const created = [];
  const offType = ov.registerType('ts', { draw() {}, input: 'strokes', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}:${inp.event.pointerId}`) });
  const log = pageLog('p1');
  ov.setArmed('ts');
  try {
    pe(lead('p1'), 'pointerdown', 'pen', 11);
    pe(lead('p1'), 'pointerdown', 'touch', 12);
    pe(lead('p1'), 'pointermove', 'pen', 11, { clientX: 120 });
    pe(lead('p1'), 'pointermove', 'touch', 12, { clientX: 130 });
    pe(lead('p1'), 'pointermove', 'pen', 11, { clientX: 140 });
    pe(lead('p1'), 'pointerup', 'touch', 12);
    pe(lead('p1'), 'pointerup', 'pen', 11, { clientX: 140 });
    assert.deepEqual(created, ['pointerdown:pen:11', 'pointermove:pen:11', 'pointermove:pen:11', 'pointerup:pen:11'], 'the whole pen stroke, and nothing of the palm');
    assert.deepEqual(log, [], 'the page heard neither the stroke nor the palm');
  } finally {
    ov.setArmed(null);
    offType();
    log.off();
    offIM();
  }
});

test('a palm down first (the page\'s) then a pen (the tool\'s): the palm\'s moves never reach the stroke, the pen\'s do', () => {
  const offIM = withInputMode();
  IM.setFingerDraws('off');
  const created = [];
  const offType = ov.registerType('ts', { draw() {}, input: 'strokes', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}:${inp.event.pointerId}`) });
  const log = pageLog('p1');
  ov.setArmed('ts');
  try {
    pe(lead('p1'), 'pointerdown', 'touch', 12);   // finger-draws off: a finger on a strokes tool is the page's
    pe(lead('p1'), 'pointerdown', 'pen', 11);
    pe(lead('p1'), 'pointermove', 'touch', 12, { clientX: 130 });
    pe(lead('p1'), 'pointermove', 'pen', 11, { clientX: 120 });
    pe(lead('p1'), 'pointermove', 'touch', 12, { clientX: 150 });
    pe(lead('p1'), 'pointerup', 'pen', 11, { clientX: 120 });
    pe(lead('p1'), 'pointerup', 'touch', 12, { clientX: 150 });
    assert.deepEqual(created, ['pointerdown:pen:11', 'pointermove:pen:11', 'pointerup:pen:11'], 'the stroke holds the pen alone');
    // The palm's own gesture was decided the page's at its pointerdown, and stays so.
    assert.deepEqual(log, ['pointerdown:touch:12', 'pointermove:touch:12', 'pointermove:touch:12', 'pointerup:touch:12']);
  } finally {
    ov.setArmed(null);
    offType();
    log.off();
    offIM();
  }
});

test('a lone keyboard click after a touch pan is the button\'s: the pan\'s click is nobody\'s, and a pan whose click never came leaves nothing behind', () => {
  const offIM = withInputMode();
  IM.setFingerDraws('off');
  const created = [];
  const offType = ov.registerType('tt', { draw() {}, input: 'taps', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}`) });
  const log = pageLog('p1');
  ov.setArmed('tt');
  const keyClick = () => goBtn('p1').dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, pointerType: '', detail: 0 }));
  try {
    for (const sendsClick of [true, false]) {
      // A finger pan on static text: down (a tap so far: the tool's), past the slop, up.
      W.__goClicks = [];
      created.length = 0;
      log.length = 0;
      pe(lead('p1'), 'pointerdown', 'touch', 21);
      pe(lead('p1'), 'pointermove', 'touch', 21, { clientX: 100 + TAP_SLOP + 5 });
      pe(lead('p1'), 'pointerup', 'touch', 21, { clientX: 100 + TAP_SLOP + 5 });
      if (sendsClick) {
        const c = pe(lead('p1'), 'click', 'touch', 21, { clientX: 100 + TAP_SLOP + 5 });
        assert.equal(c.defaultPrevented, true, 'the pan\'s click is nobody\'s');
      }
      assert.deepEqual(created, [], `a pan drops no pin (click ${sendsClick ? 'sent' : 'never sent'})`);
      assert.deepEqual(log.filter((l) => l.startsWith('click')), [], 'and the page heard no click of it');
      // Then Enter on the pane's button: a lone click, pointerType '', detail 0.
      keyClick();
      assert.deepEqual(W.__goClicks, ['p1'], `the button acted (pan's click ${sendsClick ? 'sent' : 'never sent'})`);
      assert.deepEqual(created, [], 'no pin on the button');
    }
    assert.deepEqual(ov.armed(), { type: 'tt', profile: null }, 'the tool stays armed');
  } finally {
    ov.setArmed(null);
    offType();
    log.off();
    offIM();
  }
});

// The browser takes a finger that travels for its own pan and cancels the
// pointer (pointercancel, no pointerup, no click): the gesture is dropped there,
// so the next keyboard click is a lone one the policy gives the button.
test('a touch pan the browser cancels (pointercancel) leaves nothing behind: the next keyboard click is the button\'s', () => {
  const offIM = withInputMode();
  IM.setFingerDraws('off');
  const created = [];
  const offType = ov.registerType('tt', { draw() {}, input: 'taps', create: (inp) => created.push(inp.phase) });
  ov.setArmed('tt');
  try {
    W.__goClicks = [];
    pe(lead('p1'), 'pointerdown', 'touch', 41);
    pe(lead('p1'), 'pointermove', 'touch', 41, { clientX: 100 + TAP_SLOP + 5 });
    pe(lead('p1'), 'pointercancel', 'touch', 41, { clientX: 100 + TAP_SLOP + 5 });
    goBtn('p1').dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, pointerType: '', detail: 0 }));
    assert.deepEqual(W.__goClicks, ['p1'], 'the button acted');
    assert.deepEqual(created, [], 'no pin on the button');
  } finally {
    ov.setArmed(null);
    offType();
    offIM();
  }
});

// A mouse pressed in a pane with a taps tool armed (which captures nothing),
// dragged out of the well and released over the chrome: the well never hears
// its pointerup, so its gesture stays not up. A keyboard click names pointer -1
// and takes no other pointer's gesture.
test('a keyboard click never takes another pointer\'s gesture: after a mouse released outside the well, or while a pen is down, the button acts and no pin drops', () => {
  const offIM = withInputMode();
  IM.setFingerDraws('off');
  const created = [];
  const offTaps = ov.registerType('tt', { draw() {}, input: 'taps', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}`) });
  const offStrokes = ov.registerType('ts', { draw() {}, input: 'strokes', create: (inp) => created.push(`${inp.phase}:${inp.pointerType}:${inp.event.pointerId}`) });
  const keyClick = () => goBtn('p1').dispatchEvent(new W.PointerEvent('click', {
    bubbles: true, cancelable: true, composed: true, pointerType: '', pointerId: -1, detail: 0,
  }));
  try {
    ov.setArmed('tt');
    W.__goClicks = [];
    pe(lead('p1'), 'pointerdown', 'mouse', 1);
    pe(W.document.body, 'pointerup', 'mouse', 1);   // released outside #main: the well never hears it
    keyClick();
    assert.deepEqual(W.__goClicks, ['p1'], 'the button acted');
    assert.deepEqual(created, [], 'no pin on the button');
    // A pen still down on a strokes tool: the keyboard click leaves its stroke whole.
    ov.setArmed('ts');
    W.__goClicks = [];
    pe(lead('p1'), 'pointerdown', 'pen', 2);
    keyClick();
    assert.deepEqual(W.__goClicks, ['p1'], 'the button acted with the pen down');
    pe(lead('p1'), 'pointermove', 'pen', 2, { clientX: 130 });
    pe(lead('p1'), 'pointerup', 'pen', 2, { clientX: 130 });
    assert.deepEqual(created, ['pointerdown:pen:2', 'pointermove:pen:2', 'pointerup:pen:2'], 'the pen\'s stroke is the tool\'s, whole');
  } finally {
    ov.setArmed(null);
    offTaps();
    offStrokes();
    offIM();
  }
});

test('the policy\'s dispatchMode decides preventDefault and pointer capture, per pointer', () => {
  const offIM = withInputMode();
  const captured = [];
  const had = Object.getOwnPropertyDescriptor(W.Element.prototype, 'setPointerCapture');
  W.Element.prototype.setPointerCapture = function setPointerCapture(id) { captured.push([this, id]); };
  const created = [];
  const offTaps = ov.registerType('tt', { draw() {}, input: 'taps', create: (inp) => created.push(inp.phase) });
  const offStrokes = ov.registerType('ts', { draw() {}, input: 'strokes', create: (inp) => created.push(inp.phase) });
  const down = (pointerType, id) => {
    captured.length = 0;
    const ev = pe(lead('p1'), 'pointerdown', pointerType, id);
    pe(lead('p1'), 'pointerup', pointerType, id);
    return { prevented: ev.defaultPrevented, captured: captured.map(([el, pid]) => [el === lead('p1'), pid]) };
  };
  try {
    IM.setFingerDraws('off');
    ov.setArmed('tt');
    assert.deepEqual(down('touch', 31), { prevented: false, captured: [] }, 'a finger tap the taps tool takes: its default is the finger\'s (touch-action), never cancelled');
    assert.deepEqual(down('pen', 32), { prevented: true, captured: [] }, 'a taps tool acts on the click and captures nothing; the pen\'s default is cancelled (K.2-43)');
    const c = pe(lead('p1'), 'click', 'pen', 32);
    assert.equal(c.defaultPrevented, true, 'the click the tool took is the tool\'s');
    ov.setArmed('ts');
    assert.deepEqual(down('touch', 33), { prevented: false, captured: [] }, 'finger-draws off: a finger on a strokes tool is the page\'s');
    assert.deepEqual(down('pen', 34), { prevented: true, captured: [[true, 34]] }, 'a pen on a strokes tool: cancelled and captured on the element it went down on');
    assert.deepEqual(down('mouse', 35), { prevented: true, captured: [[true, 35]] }, 'the mouse as the pen');
    IM.setFingerDraws('on');
    assert.deepEqual(down('touch', 36), { prevented: false, captured: [[true, 36]] }, 'finger-draws on: the finger draws, captured, its default left to touch-action');
    const mv = pe(lead('p1'), 'pointermove', 'pen', 37, { buttons: 0 });
    assert.equal(mv.defaultPrevented, false, 'a pointer with no gesture of its own (a hover) is untouched');
  } finally {
    ov.setArmed(null);
    IM.setFingerDraws('off');
    offTaps();
    offStrokes();
    if (had) Object.defineProperty(W.Element.prototype, 'setPointerCapture', had);
    else delete W.Element.prototype.setPointerCapture;
    W.localStorage.removeItem('wc:finger-draws');
    offIM();
  }
});

test('the one armed state: each subscriber told once, an equal value tells nobody, an unsubscribe stops it', () => {
  const a = [];
  const b = [];
  const offA = ov.onArmedChange((v) => a.push(v));
  const offB = ov.onArmedChange((v) => b.push(v));
  try {
    ov.setArmed('highlight', 'gold');
    ov.setArmed('highlight', 'gold');
    assert.deepEqual(a, [{ type: 'highlight', profile: 'gold' }]);
    assert.deepEqual(b, [{ type: 'highlight', profile: 'gold' }]);
    ov.setArmed('highlight');
    assert.deepEqual(a[1], { type: 'highlight', profile: null }, 'a profile change is a change');
    offA();
    ov.setArmed(null);
    ov.setArmed(null);
    assert.equal(a.length, 2, 'unsubscribed');
    assert.deepEqual(b, [{ type: 'highlight', profile: 'gold' }, { type: 'highlight', profile: null }, null]);
    assert.equal(ov.armed(), null);
  } finally { offA(); offB(); ov.setArmed(null); }
  const off = ov.registerType('grab', { draw() {}, input: 'strokes' });
  try {
    assert.equal(ov.inputKindOf('grab'), 'strokes');
    assert.equal(ov.inputKindOf('nobody'), null);
    assert.throws(() => ov.registerType('bad', { draw() {}, input: 'swipes' }), TypeError);
  } finally { off(); }
  assert.equal(ov.inputKindOf('grab'), null, 'unregistered');
});

test('DRAW_RULES and EDIT_TOLERANCE are frozen and exported; the layer is reserved', () => {
  assert.ok(Object.isFrozen(ov.DRAW_RULES));
  for (const r of ov.DRAW_RULES) assert.ok(Object.isFrozen(r));
  const rule = (a) => ov.drawRuleOf(a).draw;
  assert.equal(rule({ state: 'exact' }), 'hit');
  assert.equal(rule({ state: 're-resolved', how: 'row-search' }), 'hit');
  assert.equal(rule({ state: 're-resolved', how: 'section' }), 'section');
  assert.equal(rule({ state: 'orphaned', how: 'locator-guess', guess: {} }), 'guess');
  assert.equal(rule({ state: 'orphaned', how: 'locator-none', guess: null }), 'none');
  assert.equal(rule({ state: 'hidden' }), 'none');
  assert.ok(Object.isFrozen(ov.EDIT_TOLERANCE));
  assert.equal(ov.EDIT_TOLERANCE.value, 0.7589);
  assert.equal(ov.EDIT_TOLERANCE.of, 589);
  assert.equal(ov.EDIT_TOLERANCE.refute_line, 0.75);
  assert.match(ov.EDIT_TOLERANCE.trigger, /G8/);
  assert.equal(ov.EDIT_TOLERANCE.live, true);
  assert.ok(RESERVED_IDS.has('el-layer'));
  const l = layer();
  assert.ok(l && l.parentNode === W.document.body, 'one body-level layer');
  assert.equal(W.document.querySelectorAll('#el-layer').length, 1);
});

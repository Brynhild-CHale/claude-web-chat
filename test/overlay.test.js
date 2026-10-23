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

let shell, W, M, ov, anchors, bus, topbar;

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
  const main = W.document.getElementById('main');
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

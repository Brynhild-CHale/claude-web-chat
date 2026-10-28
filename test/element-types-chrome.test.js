// The reads gate and the per-element draw state in the chrome (annotation
// engine tranche 2, U324; PLAN.md 2C.3; readiness R7 §3 row 10; F10 C-5;
// GT-17): public/app/element-types.js, in the real chrome
// (test-support/chrome-shell, booted once).
//
// Pinned here:
//   - the listing is read through http.js on hello and on every `components`
//     frame (GET /api/elements/types), and a refused read keeps the one held;
//   - F10 c5's grid, the chrome half, through a stub overlay: the same 45
//     draws give 30 drawn, 15 parked, 0 thrown, 0 blank, 0 misdrawn, and the
//     type's draw is called 0 times for a parked version;
//   - the no-gate control (the wrapper bypassed) shows the throws and the
//     misdraws the gate prevents;
//   - the liar control (element.json claims reads [1,2], draw reads only
//     schema 2) is caught as draw-failed, with the stand-in mark, never
//     thrown out of the overlay;
//   - a record of a type the registry does not list gets the generic mark
//     and the 'unknown-type' state — registered (the wrapper's stand-in) or
//     not (the overlay's own mark; the state from onAnswers);
//   - every state change is announced on the bus as 'overlay:draw-state';
//   - before the first listing nothing of a registered type is drawn;
//   - in the real overlay a throwing draw stays inside the wrapper: the
//     element is draw-failed here, its marker is the stand-in, and the
//     overlay's own failedDraws() stays empty.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const path = require('path');
const { pathToFileURL } = require('url');

let shell, W, ET, bus, realOv, anchors;
// Refused until the first test serves one: the highlight type (U328a) registers
// at boot, which starts this module and its reads, so the boot's own listing
// read must not land for "before the first listing" to be observable.
let listing = { ok: false, hint: 'no listing yet' };

const row = (type, schema, reads) => ({
  type, schema, reads, anchors: ['element'], family: 'page', remote: { see: 'read', send: 'full' },
  private: false, builtin: false, tier: 'local', pack: 'notes-pack', toolbar: {},
});

// The stub overlay: registerType keeps the spec the gate hands it.
const regs = new Map();
let answersFn = null;
const stub = {
  registerType(type, spec) { regs.set(type, spec); return () => { if (regs.get(type) === spec) regs.delete(type); }; },
  onAnswers(fn) { answersFn = fn; return () => { if (answersFn === fn) answersFn = null; }; },
};

const typeCalls = () => shell.calls.filter((c) => c.url === '/api/elements/types').length;
async function relist(next) {
  listing = next;
  const r = await ET.loadTypes();
  assert.equal(r.ok, true);
}

before(async () => {
  shell = await bootShell({
    routes: { '/api/elements/types': () => listing },
  });
  W = shell.window;
  // A fresh instance of the module: main.js's box grab (U328c, initBoxGrab)
  // registers its type at boot, which starts the boot instance and its first
  // listing, so "before the first listing" is read on an instance nothing has
  // started yet (it shares the boot's overlay, socket and HTTP reader).
  ET = await import(`${pathToFileURL(path.join(__dirname, '..', 'public/app/element-types.js')).href}?fresh=1`);
  bus = (await shell.importApp('bus.js')).bus;
  realOv = await shell.importApp('overlay.js');
  anchors = (await shell.importApp('anchors.js')).default;
});

after(async () => { if (shell) await shell.restore(); });

const states = [];
test('before the first listing a registered type draws nothing; the listing is read on init, on hello and on a components frame', async () => {
  bus.on('overlay:draw-state', (d) => states.push(d));
  let calls = 0;
  ET.registerElementType('early', { draw: () => { calls++; } }); // inits with the real overlay
  ET.initElementTypes({ overlay: stub });
  const g = { key: 'k', type: 'early', items: [{ id: 'e1', v: 1, type: 'early', row: { id: 'e1', v: 1, type: 'early' } }], container: W.document.createElement('div') };
  // A draw before any listing calls nothing.
  assert.equal(ET.typesLoaded(), false, 'the first read is still on its way');
  regs.get('early').draw(g, {});
  assert.equal(calls, 0);
  assert.deepStrictEqual(ET.drawStates(), []);
  listing = { ok: true, types: [], reserved: ['comment', 'highlight', 'box-grab'] };
  await shell.frame({ type: 'components' });
  await waitUntil(() => ET.typesLoaded(), { what: 'the first listing' });
  const n0 = typeCalls();
  assert.ok(n0 >= 1);
  await shell.frame({ type: 'components' });
  await waitUntil(() => typeCalls() > n0, { what: 'the components frame\'s read' });
  const n1 = typeCalls();
  await shell.frame(helloFrame({ active: 'n1', mounts: [] }));
  await waitUntil(() => typeCalls() > n1, { what: 'the hello\'s read' });
  // A refused read keeps the listing held.
  await relist({ ok: true, types: [row('sticky', 'sticky@1', ['sticky@1'])], reserved: [] });
  listing = { ok: false, hint: 'nope' };
  const r = await ET.loadTypes();
  assert.equal(r.ok, false);
  assert.deepStrictEqual(ET.listedTypes().map((t) => t.type), ['sticky']);
  assert.equal(ET.readable('sticky', 'sticky@1'), true);
  assert.equal(ET.readable('sticky', 1), true);
  assert.equal(ET.readable('sticky', 'sticky@2'), false);
  assert.equal(ET.readable('nope', 'nope@1'), false);
});

// ── F10 c5 ──────────────────────────────────────────────────────────────────
// The two payload shapes: schema 1 {text}, schema 2 {body: {text}}.
const textOf = (it) => {
  const p = it.row.payload;
  return it.row.schema === 'sticky@1' ? 'S1 ' + p.text : 'S2 ' + p.body.text;
};
const DRAW = {
  v1: (g) => { g.container.textContent = g.items.map((it) => 'S1 ' + it.row.payload.text).join(' '); },
  both: (g) => { g.container.textContent = g.items.map(textOf).join(' '); },
  only2: (g) => { g.container.textContent = g.items.map((it) => 'S2 ' + it.row.payload.body.text).join(' '); },
};
const PHASES = [
  { label: 'v1.0 schema1 reads[1]', schema: 'sticky@1', reads: ['sticky@1'], draw: DRAW.v1, write: 1 },
  { label: 'v2.0 schema2 reads[1,2]', schema: 'sticky@2', reads: ['sticky@1', 'sticky@2'], draw: DRAW.both, write: 2 },
  { label: 'v2.1 schema2 reads[2]', schema: 'sticky@2', reads: ['sticky@2'], draw: DRAW.only2 },
  { label: 'v2.2 schema2 reads omitted', schema: 'sticky@2', reads: ['sticky@2'], draw: DRAW.only2 },
  { label: 'v1.1 downgrade schema1 reads[1]', schema: 'sticky@1', reads: ['sticky@1'], draw: DRAW.v1 },
];
const LIAR = { label: 'liar schema2 claims reads[1,2]', schema: 'sticky@2', reads: ['sticky@1', 'sticky@2'], draw: DRAW.only2 };

const log = [];
function writeVersions(schema, n) {
  for (let i = 0; i < n; i++) {
    const v = log.length + 1;
    const text = `s${schema}-${v}`;
    log.push({ id: `el-${v}`, v, schema: `sticky@${schema}`, payload: schema === 1 ? { text } : { body: { text } }, expect: text });
  }
}

// Every version drawn through the overlay's handle for the type (the gate's
// wrapper, or the raw draw for the no-gate control), each its own group.
function drawAll(draw, { gated = true } = {}) {
  const tally = { drawn: 0, parked: 0, draw_failed: 0, thrown: 0, blank: 0, misdrawn: 0, standin: 0 };
  for (const ver of log) {
    const c = W.document.createElement('div');
    const it = { id: ver.id, v: ver.v, type: 'sticky', row: { id: ver.id, v: ver.v, type: 'sticky', schema: ver.schema, payload: ver.payload } };
    const g = { key: `sticky|hit|${ver.id}`, type: 'sticky', kind: 'hit', items: [it], container: c };
    let threw = false;
    try { draw(g, {}); } catch { threw = true; }
    if (threw) { tally.thrown++; continue; }
    const s = gated ? ET.drawStates().find((x) => x.id === ver.id) || null : null;
    if (c.classList.contains(ET.STANDIN_CLASS)) tally.standin++;
    if (s && s.state === 'parked') { tally.parked++; continue; }
    if (s && s.state === 'draw-failed') { tally.draw_failed++; if (!c.textContent) tally.blank++; continue; }
    tally.drawn++;
    if (!c.textContent) tally.blank++;
    else if (!c.textContent.includes(ver.expect)) tally.misdrawn++;
  }
  return tally;
}

test('c5: the same 45 draws give 30 drawn, 15 parked, 0 thrown, 0 blank, 0 misdrawn; draw runs 0 times for a parked version', async () => {
  const sum = { draws: 0, drawn: 0, parked: 0, thrown: 0, blank: 0, misdrawn: 0, draw_failed: 0, runs_for_parked: 0 };
  const perPhase = [];
  const ungated = [];
  for (const phase of PHASES) {
    await relist({ ok: true, types: [row('sticky', phase.schema, phase.reads)], reserved: [] });
    const ran = new Map();
    const counted = (g, ctx) => { for (const it of g.items) ran.set(it.id, (ran.get(it.id) || 0) + 1); return phase.draw(g, ctx); };
    ET.registerElementType('sticky', { draw: counted });
    if (phase.write) writeVersions(phase.write, 5);
    const t = drawAll(regs.get('sticky').draw);
    const parkedIds = ET.drawStates().filter((s) => s.state === 'parked').map((s) => s.id);
    for (const id of parkedIds) sum.runs_for_parked += ran.get(id) || 0;
    sum.draws += log.length;
    for (const k of ['drawn', 'parked', 'thrown', 'blank', 'misdrawn', 'draw_failed']) sum[k] += t[k];
    perPhase.push([t.drawn, t.parked]);
    assert.equal(t.standin, t.parked, `${phase.label}: each parked version gets the stand-in mark`);
    if (phase.label.startsWith('v2.1') || phase.label.startsWith('v1.1')) {
      // The no-gate control: the same draw, every version handed to it.
      ungated.push({ phase: phase.label, ...drawAll(phase.draw, { gated: false }) });
    }
  }
  assert.deepStrictEqual(perPhase, [[5, 0], [10, 0], [5, 5], [5, 5], [5, 5]]);
  assert.deepStrictEqual(sum, { draws: 45, drawn: 30, parked: 15, thrown: 0, blank: 0, misdrawn: 0, draw_failed: 0, runs_for_parked: 0 });
  // What the gate prevents: schema-1 versions thrown at a schema-2 draw, and
  // schema-2 versions misdrawn by a schema-1 draw.
  assert.equal(ungated[0].thrown, 5, 'v2.1 ungated: the five schema-1 versions throw');
  assert.equal(ungated[1].misdrawn, 5, 'v1.1 ungated: the five schema-2 versions are misdrawn');
});

test('the liar control: a draw that throws is draw-failed with the stand-in mark, never thrown out of the overlay', async () => {
  await relist({ ok: true, types: [row('sticky', LIAR.schema, LIAR.reads)], reserved: [] });
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a);
  let t;
  try {
    ET.registerElementType('sticky', { draw: LIAR.draw });
    t = drawAll(regs.get('sticky').draw);
  } finally { console.error = realError; }
  assert.equal(t.thrown, 0, 'nothing thrown out of the wrapper');
  assert.equal(t.draw_failed, 5, 'the five schema-1 versions');
  assert.equal(t.standin, 5);
  assert.equal(t.blank, 0, 'a failed draw leaves the stand-in, never a blank marker');
  assert.equal(t.drawn, 5);
  const failed = ET.drawStates().filter((s) => s.state === 'draw-failed');
  assert.deepStrictEqual(failed.map((s) => s.schema), Array(5).fill('sticky@1'));
  assert.ok(failed.every((s) => typeof s.error === 'string' && s.error.length));
  assert.ok(errors.length >= 5, 'each failure is logged');
  // Announced, and cleared once the version draws again.
  assert.ok(states.some((d) => d.state === 'draw-failed' && d.id === 'el-1' && d.type === 'sticky'));
  ET.registerElementType('sticky', { draw: DRAW.both });
  drawAll(regs.get('sticky').draw);
  assert.equal(ET.drawStates().filter((s) => s.state === 'draw-failed').length, 0);
  assert.ok(states.some((d) => d.state === null && d.prev === 'draw-failed' && d.id === 'el-1'));
});

test('a record of a type the registry does not list gets the generic mark and the unknown-type state', async () => {
  await relist({ ok: true, types: [row('sticky', 'sticky@1', ['sticky@1'])], reserved: ['comment'] });
  // Registered, but no longer listed (its pack removed — GT-17).
  let calls = 0;
  ET.registerElementType('gone', { draw: () => { calls++; } });
  const c = W.document.createElement('div');
  regs.get('gone').draw({ key: 'g', type: 'gone', items: [{ id: 'x1', v: 2, type: 'gone', row: { id: 'x1', v: 2, type: 'gone' } }], container: c }, {});
  assert.equal(calls, 0, 'an unlisted type\'s draw never runs');
  assert.ok(c.classList.contains('el-generic') && c.classList.contains(ET.STANDIN_CLASS));
  assert.equal(c.textContent, 'gone');
  assert.deepStrictEqual(ET.drawStates().find((s) => s.id === 'x1'), { id: 'x1', v: 2, type: 'gone', state: 'unknown-type', schema: null, error: null });
  assert.ok(states.some((d) => d.id === 'x1' && d.state === 'unknown-type'));
  // Never registered at all: the overlay draws its own generic mark; the
  // state comes from its answers.
  answersFn({ mount: 'p1', scope: 'live', items: [{ id: 'y1', v: 1, type: 'mystery', state: 'exact' }, { id: 'y2', v: 1, type: 'comment', state: 'exact' }] });
  assert.equal(ET.drawStates().find((s) => s.id === 'y1').state, 'unknown-type');
  assert.equal(ET.drawStates().find((s) => s.id === 'y2'), undefined, 'a reserved built-in name is not unknown');
  // Once the type is listed, its state clears.
  await relist({ ok: true, types: [row('sticky', 'sticky@1', ['sticky@1']), row('mystery', 'mystery@1', ['mystery@1'])], reserved: ['comment'] });
  assert.equal(ET.drawStates().find((s) => s.id === 'y1'), undefined);
  // An unlisted built-in (its boot install failed) keeps drawing, caught.
  let drew = 0;
  ET.registerElementType('comment', { draw: () => { drew++; } });
  regs.get('comment').draw({ key: 'c', type: 'comment', items: [{ id: 'c1', v: 1, type: 'comment', row: { id: 'c1', v: 1, type: 'comment' } }], container: W.document.createElement('div') }, {});
  assert.equal(drew, 1);
});

test('a mixed group: the readable items are drawn, the parked ones are never handed to draw', async () => {
  await relist({ ok: true, types: [row('sticky', 'sticky@2', ['sticky@2'])], reserved: [] });
  let seen = null;
  let moved = null;
  ET.registerElementType('sticky', { draw: (g) => { seen = g.items.map((it) => it.id); }, move: (g) => { moved = g.items.map((it) => it.id); } });
  const mk = (id, schema) => ({ id, v: 1, type: 'sticky', row: { id, v: 1, type: 'sticky', schema } });
  const g = { key: 'm', type: 'sticky', items: [mk('m1', 'sticky@1'), mk('m2', 'sticky@2'), mk('m3', 'sticky@2')], container: W.document.createElement('div') };
  regs.get('sticky').draw(g, {});
  assert.deepStrictEqual(seen, ['m2', 'm3']);
  regs.get('sticky').move(g, {});
  assert.deepStrictEqual(moved, ['m2', 'm3']);
  assert.equal(ET.drawStates().find((s) => s.id === 'm1').state, 'parked');
  // A row naming no schema reads as its type's own current one.
  seen = null;
  regs.get('sticky').draw({ key: 'n', type: 'sticky', items: [{ id: 'n1', v: 1, type: 'sticky', row: { id: 'n1', v: 1, type: 'sticky' } }], container: W.document.createElement('div') }, {});
  assert.deepStrictEqual(seen, ['n1']);
  assert.throws(() => ET.registerElementType('', { draw() {} }), TypeError);
  assert.throws(() => ET.registerElementType('x', {}), TypeError);
});

// ── the real overlay ────────────────────────────────────────────────────────
const queue = [];
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(0); n++; }
  return n;
}
const rectOf = () => ({ left: 200, top: 200, width: 40, height: 16, right: 240, bottom: 216, x: 200, y: 200 });

test('in the real overlay a throwing draw stays in the wrapper: draw-failed here, the stand-in marker, the overlay\'s failedDraws() empty', async () => {
  const M = W.__wcMount;
  await shell.frame(helloFrame({ active: 'n1', mounts: [{ id: 'p1', target: 'main', params: {}, html: '<p class="lead">lead of p1</p>' }] }));
  realOv.initOverlay({ rectOf, raf: fakeRaf });
  ET.initElementTypes({ overlay: realOv });
  await relist({ ok: true, types: [row('sticky', 'sticky@1', ['sticky@1'])], reserved: [] });
  const realError = console.error;
  console.error = () => {};
  try {
    ET.registerElementType('sticky', { draw: () => { throw new Error('a draw that throws'); } });
    const root = M.itemEl(W.document, 'p1').el.shadowRoot;
    const el = root.querySelector('p.lead');
    realOv.setElements('live', [
      { id: 'r1', v: 1, type: 'sticky', anchor: anchors.record(root, el, { mount: 'p1' }), shared: true, replies: 0 },
      { id: 'r2', v: 1, type: 'vanished', anchor: anchors.record(root, el, { mount: 'p1' }), shared: true, replies: 0 },
    ]);
    await waitUntil(() => { flush(); return W.document.querySelectorAll('#el-layer .el-marker').length >= 2; }, { what: 'both markers' });
    flush();
  } finally { console.error = realError; }
  assert.deepStrictEqual(realOv.failedDraws(), [], 'nothing thrown into the overlay');
  const marker = (id) => [...W.document.querySelectorAll('#el-layer .el-marker')].find((m) => m.dataset.elIds.split(' ').includes(id));
  assert.ok(marker('r1').classList.contains(ET.STANDIN_CLASS), 'the wrapper\'s stand-in');
  assert.ok(marker('r2').classList.contains('el-generic'), 'the overlay\'s own generic mark for an unregistered type');
  await waitUntil(() => ET.drawStates().some((s) => s.id === 'r2'), { what: 'the answers' });
  const byId = Object.fromEntries(ET.drawStates().map((s) => [s.id, s.state]));
  assert.equal(byId.r1, 'draw-failed');
  assert.equal(byId.r2, 'unknown-type');
  // drawStates lists only what is still in the drawn set.
  realOv.setElements('live', []);
  flush();
  assert.deepStrictEqual(ET.drawStates(), []);
});

// F.3: the comment keeps the default targets ('items'); a pack type that
// registers 'panes' is still narrowed as before (K.2-78), and a pack's taps
// type with 'items' takes a markdown block as the comment does.
test('targetsOf(\'comment\') is \'items\'; a pack type registering \'panes\' is still narrowed to the panes; a taps type with \'items\' takes a markdown block', async () => {
  const bootET = await shell.importApp('element-types.js');
  await waitUntil(() => bootET.targetsOf('comment') != null, { what: 'the comment registered at boot' });
  assert.equal(bootET.targetsOf('comment'), 'items');
  const made = [];
  const create = (type) => (input) => { if (input.phase === 'click') made.push({ type, mount: input.mount, md: input.md }); };
  const offPanes = ET.registerElementType('pack-panes', { draw() {}, create: create('pack-panes'), input: 'taps', targets: 'panes' });
  const offItems = ET.registerElementType('pack-items', { draw() {}, create: create('pack-items'), input: 'taps' });
  assert.equal(ET.targetsOf('pack-panes'), 'panes');
  assert.equal(ET.targetsOf('pack-items'), 'items');
  assert.throws(() => realOv.registerType('bad-glyph', { draw() {}, sourceGlyph: { dx: 'a', dy: 0 } }), /sourceGlyph is \{dx, dy\}/);
  await shell.frame({ type: 'markdown', id: 'md-t', text: 'See [the docs](https://example.com/docs).', owner: 'claude', gen: 1,
    order: ['p1', 'md-t'], claude_order: ['p1', 'md-t'] });
  const link = W.document.querySelector('[data-md-id="md-t"] a');
  const lead = W.__wcMount.itemEl(W.document, 'p1').el.shadowRoot.querySelector('p.lead');
  assert.ok(link && lead, 'precondition: the link and the pane');
  const heard = [];
  const onDoc = (e) => { if (e.target === link) { heard.push(e.type); if (e.type === 'click') e.preventDefault(); } };
  W.document.addEventListener('click', onDoc);
  const tap = (el, id) => {
    el.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: id, isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId: id, isPrimary: true }));
    el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: id }));
  };
  try {
    realOv.setArmed('pack-panes');
    tap(link, 61);
    assert.deepEqual(heard, ['click'], 'a \'panes\' type leaves the markdown link to the page');
    assert.deepEqual(made, [], 'and creates nothing there');
    tap(lead, 62);
    assert.deepEqual(made, [{ type: 'pack-panes', mount: 'p1', md: null }], 'a pane\'s content is the tool\'s');
    made.length = 0;
    heard.length = 0;
    realOv.setArmed('pack-items');
    tap(link, 63);
    assert.deepEqual(heard, [], 'a taps type with \'items\' takes the link');
    assert.deepEqual(made, [{ type: 'pack-items', mount: null, md: 'md-t' }]);
  } finally {
    realOv.setArmed(null);
    W.document.removeEventListener('click', onDoc);
    offPanes();
    offItems();
    await shell.frame({ type: 'markdown:remove', id: 'md-t', order: ['p1'], claude_order: ['p1'] });
  }
});

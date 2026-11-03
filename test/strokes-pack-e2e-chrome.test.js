// The fixture strokes pack in the real chrome (annotation engine tranche 4,
// plan 4F.4, U565; DECISIONS.md N.1 AD3 (b), AD5, AD6; rulings PRIVATE@create
// AF2 (a), U512-U522@draw-module-contract (a), U561@stroke-keys-and-window
// (a), AI13; the engineering contract on ctx.record): the checked-in pack's
// `scribble` type (test-support/element-packs/strokes-fixture) driven through
// the engine it was written for, booted once (test-support/chrome-shell).
//
// The twin's routes answer as the daemon does once the pack is approved
// (test/strokes-pack-e2e.test.js takes the daemon down that path): the
// listing row for `scribble` and its toolbar tool are BUILT from the
// fixture's element.json by the daemon's own code (lib/packs/elements
// validateElement, the registry's ROW_KEYS split, routes/toolbar toolEntry),
// and GET /api/elements/types/scribble/draw.js answers the fixture's bytes.
// jsdom runs no module fetched from a URL, so the loader's importer is
// injected (U512's seam): it fetches the route through the twin, writes the
// answer as an .mjs and imports it, so the module the chrome registers is the
// one the route served. jsdom does no layout: the svg's box is stubbed on the
// element, a canvas's 2D context is a recording stub.
//
// Pinned here:
//   - the approved listing (a `components` frame, as the approve sends) makes
//     U512's loader import exactly drawPath('scribble', sha) once, and register
//     its default draw with its named create; the toolbar arms it (tools.js
//     arm), and the overlay's dispatch hands its create the strokes input;
//   - a synthetic pen stroke (pointerType 'pen', pressure, a
//     getCoalescedEvents stub) on an <svg> in a pane begins ctx.wet on the
//     svg and paints it (the stub's lineTo calls), and the pen-up sends
//     exactly ONE POST /api/elements: type scribble, anchor.kind 'element' (the
//     svg's record), every x and y in 0..1, shared false (PRIVATE@create);
//     the wet canvas is dropped after it;
//   - the stroke, once the overlay holds its row, draws a box marker equal to
//     the svg's rect holding one svg and one path with data-el-id = its id,
//     the path's points read through ctx.record(id) — the record GET
//     /api/elements?type=scribble and the element:scribble frame carry —
//     never from the overlay's row, which carries no points (strokesOn's row);
//     a record edited by the frame redraws the path from the new points;
//   - the same press on a paragraph is refused with FRAME_HINT and posts
//     nothing; Mod+Z outside a field sends POST /api/elements/undo (U518's
//     action, whatever tool is armed); a node preview creates nothing.
//
//   - the element:scribble frame alone hands the overlay the stroke's live
//     row (U512b's relay, element-types.js relayRows): the dry marker is
//     drawn with no hello and no reset after the commit.
//
// THE RECORD'S ONE SHAPE (U565's gap (b), closed by U522b on finding
// U565@ctx-record-shape; its gap (a), the frame that never reached the
// overlay's live rows, U512b closed): ctx.record(id) answers the GET's
// record, FLAT (the payload's keys beside id, v, type…), in the live chrome
// and in a document alike; the fixture's draw reads `record.points` with no
// fallback, and a record never carries a nested `payload`.
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame, DEFAULT_ROUTES, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { readElementJson, validateElement, elementSrcDir } = require('../lib/packs/elements');
const { ROW_KEYS } = require('../lib/server/element-types');
const { toolEntry } = require('../lib/server/routes/toolbar');

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const DRAW_SRC = fs.readFileSync(path.join(elementSrcDir(PACK_DIR, TYPE), 'draw.js'), 'utf8');
const SHA = crypto.createHash('sha256').update(DRAW_SRC).digest('hex');
const DRAW_URL = `/api/elements/types/${TYPE}/draw.js?d=${SHA}`;

// The listing row and the toolbar tool, as the daemon builds them for an
// approved, installed pack type.
function scribbleRows() {
  const read = readElementJson(elementSrcDir(PACK_DIR, TYPE));
  assert.ok(read.ok, read.error);
  const checked = validateElement(read.raw, { stageDir: PACK_DIR, name: TYPE });
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  const row = { type: TYPE };
  const toolbar = {};
  for (const k of Object.keys(checked.descriptor)) {
    if (ROW_KEYS.includes(k)) { if (k !== 'type') row[k] = checked.descriptor[k]; } else toolbar[k] = checked.descriptor[k];
  }
  const listing = { ...row, builtin: false, tier: 'local', pack: PACK, toolbar, draw: { sha256: SHA } };
  const tool = toolEntry({ type: TYPE, pack: PACK, builtin: false, toolbar }, '1.0.0');
  return { listing, tool };
}
const ROWS = scribbleRows();
const BASE_TYPES = DEFAULT_ROUTES['/api/elements/types'];
const BASE_TOOLBAR = DEFAULT_ROUTES['/api/toolbar'];

const PANE = {
  id: 'sk1', target: 'main', params: {}, gen: 0,
  html: '<div class="wrap"><svg class="art" viewBox="0 0 200 100"><g><path class="line" d="M0 0 L10 10"/></g></svg>'
    + '<p class="prose">Some prose to never ink over.</p></div>',
};
const SVG_RECT = { left: 100, top: 200, width: 200, height: 100 };

let shell, W, M, ov, ET, TF, tools, wet, state;
let approved = false;
let records = [];
let nextSeq = 1;
const imported = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u565-chrome-'));
const contexts = [];

const posts = (url = '/api/elements') => shell.calls.filter((c) => c.method === 'POST' && c.url === url);
const rootOf = (id = 'sk1') => M.itemEl(W.document, id).el.shadowRoot;
const q = (sel) => rootOf().querySelector(sel);
const reaimText = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };
const wetCanvases = () => [...W.document.querySelectorAll('canvas.el-wet')];
const markers = () => [...W.document.querySelectorAll(`#el-layer .el-marker[data-type="${TYPE}"]`)];

function boxed(el, r) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
  return el;
}
// The page's geometry: the well and #main over the viewport, the pane's
// host around its content, the svg and the paragraph inside it (the overlay
// clips a marker to the well and every overflow box above its target).
function stubRects() {
  shell.scrollMetrics(W.document.querySelector('.well-wrap'), { rect: { left: 0, top: 48, width: 1280, height: 752 } });
  shell.scrollMetrics(W.document.getElementById('main'), { rect: { left: 0, top: 48, width: 1280, height: 3000 } });
  shell.scrollMetrics(M.itemEl(W.document, 'sk1').el, { rect: { left: 80, top: 180, width: 400, height: 200 } });
  boxed(q('svg.art'), SVG_RECT);
  boxed(q('p.prose'), { left: 100, top: 320, width: 300, height: 20 });
}

// The daemon's record for a POSTed stroke: GET /api/elements's shape (flat).
function recordOf(body) {
  const seq = nextSeq++;
  const { anchor, shared, ...rest } = body.payload;
  return { id: `p${seq}`, type: TYPE, v: 1, schema: `${TYPE}@1`, seq, created_at: new Date(1730000000000 + seq).toISOString(),
    shared: shared !== false, anchor: body.anchor, ...rest, writer: { class: 'user', owner: 'user', verified: false } };
}
function elementsRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method === 'POST') {
    const rec = recordOf(JSON.parse(init.body));
    records = records.concat([rec]);
    return { ok: true, element: rec };
  }
  return { elements: url.includes(`type=${TYPE}`) ? records : [], next_cursor: nextSeq };
}

// The loader's importer: the route's answer, through the twin, as a module.
async function importThroughRoute(url) {
  imported.push(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the route answered ${r.status}`);
  const file = path.join(tmp, `draw-${imported.length}.mjs`);
  fs.writeFileSync(file, await r.text());
  return import(pathToFileURL(file).href);
}

// A pen event on `el` with its coalesced samples (the browser's list).
function pen(el, type, x, y, { samples = null, pressure = 0.6, t = 0 } = {}) {
  const e = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'pen', pointerId: 3,
    isPrimary: true, clientX: x, clientY: y, pressure, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 });
  const list = samples || [{ clientX: x, clientY: y, pressure, timeStamp: 1000 + t }];
  e.getCoalescedEvents = () => list;
  e.getPredictedEvents = () => [];
  el.dispatchEvent(e);
  return e;
}
const sample = (x, y, t, p = 0.6) => ({ clientX: x, clientY: y, pressure: p, timeStamp: 1000 + t });
// A pen-down, two moves and the pen-up, a frame apart (the wet layer
// paints on the animation frame each move asks for).
async function strokeOn(el) {
  pen(el, 'pointerdown', 120, 290, { t: 0 });
  await shell.tick();
  pen(el, 'pointermove', 180, 260, { samples: [sample(150, 275, 8), sample(180, 260, 16)] });
  await shell.tick();
  pen(el, 'pointermove', 260, 220, { samples: [sample(220, 240, 24), sample(260, 220, 32)] });
  await shell.tick();
  pen(el, 'pointerup', 260, 220, { t: 40 });
}
// A path's d ("M x y L x y …") as the flat [x, y, x, y, …] it draws.
const coordsOf = (d) => d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number);
const xyOf = (points) => points.filter((_, i) => i % 4 < 2);

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => (approved
        ? { ...BASE_TYPES, types: [...BASE_TYPES.types, ROWS.listing] } : BASE_TYPES),
      '/api/toolbar': () => (approved
        ? { ...BASE_TOOLBAR, tools: [...BASE_TOOLBAR.tools, ROWS.tool], project: { ...BASE_TOOLBAR.project, pinned: [...BASE_TOOLBAR.project.pinned, TYPE] } }
        : BASE_TOOLBAR),
      [DRAW_URL]: () => respond(DRAW_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
      '/api/elements': elementsRoute,
      '/api/elements/undo': { ok: true, undone: { id: 'p1', type: TYPE, v: 1, item: 'sk1', how: 'removed' } },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  W.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
    if (kind !== '2d') return null;
    const calls = [];
    const c = { canvas: this, calls };
    for (const k of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke']) c[k] = (...a) => calls.push([k, ...a]);
    contexts.push(c);
    return c;
  };
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  TF = await shell.importApp('target-frame.js');
  tools = await shell.importApp('tools.js');
  wet = (await shell.importApp('wet-layer.js')).initWetLayer();   // main.js's instance (idempotent)
  ({ view: state } = await shell.importApp('state.js'));
  ET.initElementTypes({ importModule: importThroughRoute });
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  await shell.tick();
  stubRects();
});
after(async () => {
  try { if (ov) ov.setArmed(null); } catch {}
  if (shell) await shell.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => { state.previewing = false; });

test('approved: the loader imports exactly the route\'s draw.js once and registers its draw and create; the toolbar arms it', async () => {
  assert.deepStrictEqual(imported, [], 'nothing imported while the pack is unapproved');
  assert.equal(ET.typeOf(TYPE), null);
  approved = true;
  await shell.frame({ type: 'components' });   // the approve's frame: the listing is read again
  await waitUntil(() => ET.typeOf(TYPE), { timeout: 3000, what: 'the scribble listing row' });
  await ET.loadPluginTypes();
  assert.deepStrictEqual(imported, [DRAW_URL], 'one import, of exactly drawPath(type, sha)');
  assert.equal(ET.drawPath(TYPE, SHA), DRAW_URL);
  assert.ok(shell.calls.some((c) => c.method === 'GET' && c.url === DRAW_URL), 'the twin served the module');
  assert.equal(ET.typeOf(TYPE).toolbar.place, 'box');
  assert.deepStrictEqual(ET.drawStates().filter((s) => s.type === TYPE), [], 'loaded, not a stand-in');
  // The same frame re-read the toolbar: the tool's slot is there, and a
  // press on it arms the type in the overlay.
  const slot = await waitUntil(() => W.document.querySelector(`.tb-slot[data-type="${TYPE}"]`),
    { timeout: 3000, what: 'the scribble slot on the toolbar' });
  assert.ok(tools.listedTools().some((x) => x.type === TYPE && x.input === 'strokes'));
  shell.click(slot);
  assert.equal(ov.armed().type, TYPE);
});

test('a pen stroke on the svg paints ctx.wet and sends ONE POST: anchor.kind element, points in 0..1, shared false; the wet canvas is dropped', async () => {
  tools.arm(TYPE);
  const n0 = posts().length;
  const s0 = wet.stats();
  await strokeOn(q('path.line'));
  await waitUntil(() => posts().length === n0 + 1, { timeout: 3000, what: 'the stroke\'s POST' });
  await shell.tick(3);
  assert.equal(posts().length, n0 + 1, 'exactly one element per pen-down to pen-up');
  const { body } = posts()[n0];
  assert.equal(body.type, TYPE);
  assert.equal(body.anchor.kind, 'element');
  assert.equal(body.anchor.mount, 'sk1');
  assert.equal(body.payload.shared, false, 'PRIVATE@create: the type passes shared false');
  assert.equal(body.payload.tool, 'pen');
  assert.equal(body.payload.colour, 'accent');
  assert.equal(body.payload.width, 2 / SVG_RECT.width, 'width as a fraction of the frame');
  const xy = xyOf(body.payload.points);
  assert.ok(xy.length >= 4, JSON.stringify(body.payload.points));
  assert.ok(xy.every((v) => v >= 0 && v <= 1), `points in 0..1: ${JSON.stringify(xy)}`);
  assert.deepStrictEqual(xy.slice(0, 2), [0.1, 0.9], 'the pen-down sample first, in frame units');
  // The wet layer: begun on the svg, painted, then dropped.
  // The wet layer: begun on the svg (its canvas laid over the svg's rect),
  // fed the coalesced samples, painted in the svg's CSS px, then dropped.
  assert.equal(contexts.length, 1, 'the one wet canvas took a 2D context');
  const wetCtx = contexts[0];
  assert.deepStrictEqual([wetCtx.canvas.style.left, wetCtx.canvas.style.top, wetCtx.canvas.style.width, wetCtx.canvas.style.height],
    [`${SVG_RECT.left}px`, `${SVG_RECT.top}px`, `${SVG_RECT.width}px`, `${SVG_RECT.height}px`], 'over the svg');
  const s1 = wet.stats();
  assert.ok(s1.samples - s0.samples >= 4, `the moves' coalesced samples pushed: ${JSON.stringify(s1)}`);
  assert.ok(s1.frames > s0.frames, 'painted on an animation frame');
  const lines = wetCtx.calls.filter((x) => x[0] === 'lineTo').map((x) => [x[1], x[2]]);
  assert.ok(lines.some(([x, y]) => x === 50 && y === 75) && lines.some(([x, y]) => x === 160 && y === 20),
    `the stroke in progress painted at its samples: ${JSON.stringify(lines)}`);
  await waitUntil(() => wetCanvases().every((cv) => !cv.isConnected), { timeout: 3000, what: 'the wet canvas dropped' });
  assert.equal(wetCanvases().length, 0);
});

test('the dry stroke: a box marker equal to the svg\'s rect, one path with data-el-id, its points read through ctx.record, never the row', async () => {
  const rec = records[records.length - 1];
  assert.ok(rec, 'the stroke the previous case committed');
  // The daemon's frame for the add: the loader's records (ctx.record).
  await shell.frame({ type: `element:${TYPE}`, elements: records });
  assert.deepStrictEqual(ET.recordOf(TYPE, rec.id).points, rec.points);
  // The same frame hands the overlay the stroke's live row (U512b's relay):
  // no hello, no reset.
  assert.ok(ov.elementsOf('live').some((r) => r.id === rec.id && r.type === TYPE), 'the frame filled the live row');
  const marker = await waitUntil(() => markers().find((m) => m.querySelector(`path[data-el-id="${rec.id}"]`)),
    { timeout: 4000, what: 'the dry marker' });
  assert.equal(marker.dataset.place, 'box');
  assert.deepStrictEqual([marker.style.left, marker.style.top, marker.style.width, marker.style.height],
    [`${SVG_RECT.left}px`, `${SVG_RECT.top}px`, `${SVG_RECT.width}px`, `${SVG_RECT.height}px`], 'the svg\'s rect');
  const svgs = marker.querySelectorAll('svg');
  assert.equal(svgs.length, 1);
  assert.equal(svgs[0].getAttribute('viewBox'), '0 0 1 1');
  assert.equal(svgs[0].getAttribute('preserveAspectRatio'), 'none');
  const paths = marker.querySelectorAll('path');
  assert.equal(paths.length, 1, 'one path per stroke');
  const p = paths[0];
  assert.equal(p.getAttribute('data-el-id'), rec.id);
  assert.equal(p.getAttribute('vector-effect'), 'non-scaling-stroke');
  assert.equal(p.getAttribute('stroke'), 'currentColor');
  assert.equal(Number(p.getAttribute('stroke-width')), rec.width * SVG_RECT.width, 'width × the marker\'s width');
  assert.deepStrictEqual(coordsOf(p.getAttribute('d')), xyOf(rec.points), 'the committed points');

  // strokesOn's row carries no points: the draw read them through ctx.record.
  const frame = TF.frameAt({ type: 'pointerdown', target: q('path.line'), composedPath: () => [q('path.line'), q('svg.art')], clientX: 150, clientY: 250 });
  const rows = TF.stroke.strokesOn(frame, { type: TYPE });
  assert.deepStrictEqual(rows.map((r) => r.id), [rec.id]);
  assert.equal(rows[0].points, undefined, 'the overlay row carries no points');
  const read = ET.recordOf(TYPE, rows[0].id);
  assert.deepStrictEqual(read.points, rec.points, 'ctx.record answers the committed points, flat');
  assert.equal(read.payload, undefined, 'the GET\'s record nests no payload');

  // An edit through the frame alone (the row untouched): redrawn from the record.
  const edited = { ...rec, v: 2, points: [0, 0, 0.5, 0, 1, 1, 0.5, 8] };
  records = [edited];
  await shell.frame({ type: `element:${TYPE}`, elements: records });
  ov.requestDraw();
  await waitUntil(() => {
    const path2 = W.document.querySelector(`#el-layer path[data-el-id="${rec.id}"]`);
    return path2 && JSON.stringify(coordsOf(path2.getAttribute('d'))) === JSON.stringify([0, 0, 1, 1]);
  }, { timeout: 4000, what: 'the path redrawn from the edited record' });
});

test('the same press on a paragraph is refused with FRAME_HINT and posts nothing', async () => {
  tools.arm(TYPE);
  const n0 = posts().length;
  const s0 = wet.stats();
  await strokeOn(q('p.prose'));
  await shell.tick(3);
  assert.equal(posts().length, n0, 'nothing posted');
  assert.equal(wet.stats().samples, s0.samples, 'nothing reached the wet layer');
  assert.equal(reaimText(), TF.FRAME_HINT);
  assert.equal(wetCanvases().filter((cv) => cv.isConnected).length, 0, 'no wet ink');
});

test('Mod+Z outside a field sends POST /api/elements/undo (the engine\'s undo, the type ships none)', async () => {
  tools.arm(TYPE);
  const n0 = posts('/api/elements/undo').length;
  q('svg.art').dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, composed: true, pointerType: 'pen' }));
  const e = shell.key('z', { metaKey: true });
  await waitUntil(() => posts('/api/elements/undo').length === n0 + 1, { timeout: 3000, what: 'the undo POST' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(posts('/api/elements/undo')[n0].body.item, 'sk1', 'the item under the pointer');
  const src = DRAW_SRC.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(src, /undo/i, 'the pack ships no undo (AD6)');
});

test('a node preview creates nothing: no POST, no wet ink', async () => {
  tools.arm(TYPE);
  const n0 = posts().length;
  const s0 = wet.stats();
  state.previewing = true;
  try {
    await strokeOn(q('path.line'));
    await shell.tick(3);
  } finally { state.previewing = false; }
  assert.equal(posts().length, n0, 'nothing posted while previewing');
  assert.equal(wet.stats().samples, s0.samples, 'nothing reached the wet layer');
  assert.equal(wetCanvases().filter((cv) => cv.isConnected).length, 0);
});

test('draw() on its own: a stroke\'s colour is its --wc- token through currentColor, and a guess group is drawn faded', async () => {
  const file = path.join(tmp, 'draw-direct.mjs');
  fs.writeFileSync(file, DRAW_SRC);
  const mod = await import(pathToFileURL(file).href);
  const rec = { id: 'p9', type: TYPE, v: 1, points: [0.1, 0.2, 0.5, 0, 0.6, 0.7, 0.5, 8], stride: 4, width: 0.01, colour: 'accent' };
  const ctx = { box: { w: 200, h: 100 }, record: (id) => (id === rec.id ? rec : null) };
  const drawIn = (kind) => {
    const container = W.document.createElement('div');
    mod.default({ kind, container, items: [{ id: rec.id }] }, ctx);
    return container;
  };
  const live = drawIn('live');
  const path0 = live.querySelector(`path[data-el-id="${rec.id}"]`);
  assert.ok(path0, 'drawn from the flat record (the one shape, both realms)');
  assert.equal(path0.style.color, 'var(--wc-accent)', 'the colour token');
  assert.equal(live.querySelector('svg').getAttribute('opacity'), null, 'a live group is not faded');
  const guess = drawIn('guess');
  assert.equal(guess.querySelector('svg').getAttribute('opacity'), '0.4', 'a guess group is drawn faded');
  assert.ok(guess.querySelector(`path[data-el-id="${rec.id}"]`), 'still drawn at its guess');
});

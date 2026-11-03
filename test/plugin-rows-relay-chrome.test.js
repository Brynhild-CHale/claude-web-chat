// A plug-in type's element:<type> frame relays into the overlay's live rows
// (annotation engine tranche 4, U512b: the corrective to U512 and U516 for
// the U565 reviewer's finding U565@overlay-plugin-rows; plan 4A.2), in the
// real chrome (test-support/chrome-shell, booted once).
//
// Before U512b the frame refreshed only U512's loader records (ctx.record);
// the overlay's live rows came from a hello or a reset alone, so a stroke
// committed live was drawn dry only after the next reconnect. Pinned here,
// with the checked-in strokes fixture's `scribble` type (its real draw.js,
// imported through the loader's importer seam), after ONE boot hello and no
// other hello or reset:
//   - an element:scribble frame naming a new record gives the overlay its
//     live row, and the type's draw paints it dry (a box marker holding the
//     record's path, data-el-id = its id) with no requestDraw from the test;
//   - a second frame adds the second stroke beside the first;
//   - a frame without a record removes its row and its path;
//   - a row of another type in the live set (a comment from the hello) is
//     never touched by the type's frame;
//   - a reset still fills the live rows itself (the overlay's takeLive), and
//     the loader's re-read after it keeps them;
//   - the relay goes through the overlay's own row path: the rows it leaves
//     are exactly the overlay's elementsOf('live') rows (normRow's fields, no
//     points), never a second store.
const test = require('node:test');
const { before, after } = test;
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

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const DRAW_SRC = fs.readFileSync(path.join(elementSrcDir(PACK_DIR, TYPE), 'draw.js'), 'utf8');
const SHA = crypto.createHash('sha256').update(DRAW_SRC).digest('hex');
const DRAW_URL = `/api/elements/types/${TYPE}/draw.js?d=${SHA}`;

// The listing row the daemon builds for the approved, installed pack type.
function listingRow() {
  const read = readElementJson(elementSrcDir(PACK_DIR, TYPE));
  assert.ok(read.ok, read.error);
  const checked = validateElement(read.raw, { stageDir: PACK_DIR, name: TYPE });
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  const row = { type: TYPE };
  const toolbar = {};
  for (const k of Object.keys(checked.descriptor)) {
    if (ROW_KEYS.includes(k)) { if (k !== 'type') row[k] = checked.descriptor[k]; } else toolbar[k] = checked.descriptor[k];
  }
  return { ...row, builtin: false, tier: 'local', pack: PACK, toolbar, draw: { sha256: SHA } };
}
const BASE_TYPES = DEFAULT_ROUTES['/api/elements/types'];
const LISTING = listingRow();

const PANE = {
  id: 'rr1', target: 'main', params: {}, gen: 0,
  html: '<div class="wrap"><svg class="art" viewBox="0 0 200 100"><g><path class="line" d="M0 0 L10 10"/></g></svg></div>',
};
const SVG_RECT = { left: 100, top: 200, width: 200, height: 100 };
let SVG_RECORD = null;     // the svg's element record, as target-frame's frameAt takes it (the create's anchor)
// A comment pin the hello carries: another type's row in the live set.
const COMMENT_ROW = { id: 'c1', v: 1, type: 'comment', schema: 'comment@1', anchor: { kind: 'page' }, shared: true, replies: 0 };

let shell, W, M, ov, ET, TF;
let records = [];          // what GET /api/elements?type=scribble answers
let hellos = 0;
let approved = false;      // the listing carries the type once the test approves it
const imported = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u512b-chrome-'));

function boxed(el, r) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
  return el;
}
const rootOf = () => M.itemEl(W.document, 'rr1').el.shadowRoot;
function stubRects() {
  shell.scrollMetrics(W.document.querySelector('.well-wrap'), { rect: { left: 0, top: 48, width: 1280, height: 752 } });
  shell.scrollMetrics(W.document.getElementById('main'), { rect: { left: 0, top: 48, width: 1280, height: 3000 } });
  shell.scrollMetrics(M.itemEl(W.document, 'rr1').el, { rect: { left: 80, top: 180, width: 400, height: 200 } });
  boxed(rootOf().querySelector('svg.art'), SVG_RECT);
}
// The daemon's record of a committed stroke: GET /api/elements's shape (flat).
let seq = 0;
function stroke(points) {
  seq++;
  return { id: `p${seq}`, type: TYPE, v: 1, schema: `${TYPE}@1`, seq, created_at: new Date(1730000000000 + seq).toISOString(),
    shared: false, anchor: SVG_RECORD, points, stride: 4, width: 0.01, colour: 'accent', tool: 'pen',
    writer: { class: 'user', owner: 'user', verified: false } };
}
async function importThroughRoute(url) {
  imported.push(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the route answered ${r.status}`);
  const file = path.join(tmp, `draw-${imported.length}.mjs`);
  fs.writeFileSync(file, await r.text());
  return import(pathToFileURL(file).href);
}
const pathOf = (id) => W.document.querySelector(`#el-layer .el-marker[data-type="${TYPE}"] path[data-el-id="${id}"]`);
const liveOf = (type = TYPE) => ov.elementsOf('live').filter((r) => r.type === type);
const coordsOf = (d) => d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number);
const xyOf = (points) => points.filter((_, i) => i % 4 < 2);

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => (approved ? { ...BASE_TYPES, types: [...BASE_TYPES.types, LISTING] } : BASE_TYPES),
      [DRAW_URL]: () => respond(DRAW_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
      '/api/elements': (url) => ({ elements: url.includes(`type=${TYPE}`) ? records : [], next_cursor: seq }),
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  TF = await shell.importApp('target-frame.js');
  (await shell.importApp('ws.js')).onHello(() => { hellos++; });
  ET.initElementTypes({ importModule: importThroughRoute });
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE], elements: [COMMENT_ROW] }));
  await shell.tick();
  stubRects();
  const line = rootOf().querySelector('path.line');
  const frame = TF.frameAt({ type: 'pointerdown', target: line, composedPath: () => [line, rootOf().querySelector('svg.art')], clientX: 150, clientY: 250 });
  SVG_RECORD = frame && frame.record;
  assert.equal(SVG_RECORD && SVG_RECORD.kind, 'element', 'the svg\'s record');
  // The approve's frame: the listing read again, now with the type (U512's
  // loader imports its module through the injected importer).
  approved = true;
  await shell.frame({ type: 'components' });
  await waitUntil(() => ET.typeOf(TYPE), { timeout: 3000, what: 'the scribble listing row' });
  await ET.loadPluginTypes();
  assert.deepStrictEqual(imported, [DRAW_URL], 'the fixture\'s draw.js, imported once');
  assert.deepStrictEqual(ET.drawStates().filter((s) => s.type === TYPE), [], 'loaded, not a stand-in');
});
after(async () => {
  if (shell) await shell.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a stroke committed live is drawn dry from its element:scribble frame alone: no hello, no reset', async () => {
  const h0 = hellos;
  const a = stroke([0.1, 0.9, 0.5, 0, 0.6, 0.4, 0.5, 8, 0.9, 0.1, 0.5, 16]);
  records = [a];
  assert.equal(liveOf().length, 0, 'no live row before the frame');
  await shell.frame({ type: `element:${TYPE}`, elements: records });
  assert.deepStrictEqual(ET.recordOf(TYPE, a.id).points, a.points, 'the loader\'s record (ctx.record)');
  const rows = liveOf();
  assert.deepStrictEqual(rows.map((r) => [r.id, r.v, r.schema, r.shared]), [[a.id, 1, `${TYPE}@1`, false]], 'the frame filled the overlay\'s live row');
  assert.deepStrictEqual(rows[0].anchor, SVG_RECORD);
  assert.equal(rows[0].points, undefined, 'the overlay\'s own row (normRow), never the record: no second store');
  // The overlay drew on its own (changed → requestDraw): the test asks for no draw.
  const p = await waitUntil(() => pathOf(a.id), { timeout: 4000, what: 'the dry path' });
  const marker = p.closest('.el-marker');
  assert.equal(marker.dataset.place, 'box');
  assert.deepStrictEqual([marker.style.left, marker.style.top, marker.style.width, marker.style.height],
    [`${SVG_RECT.left}px`, `${SVG_RECT.top}px`, `${SVG_RECT.width}px`, `${SVG_RECT.height}px`], 'the svg\'s rect');
  assert.deepStrictEqual(coordsOf(p.getAttribute('d')), xyOf(a.points), 'the committed points, through the type\'s draw');
  assert.equal(hellos, h0, 'no hello reached the chrome');
});

test('a second stroke\'s frame adds its row beside the first; another type\'s row is never touched', async () => {
  const [a] = records;
  const b = stroke([0.2, 0.2, 0.5, 0, 0.8, 0.8, 0.5, 8]);
  records = [a, b];
  await shell.frame({ type: `element:${TYPE}`, elements: records });
  assert.deepStrictEqual(liveOf().map((r) => r.id).sort(), [a.id, b.id]);
  await waitUntil(() => pathOf(a.id) && pathOf(b.id), { timeout: 4000, what: 'both dry paths' });
  assert.deepStrictEqual(liveOf('comment').map((r) => r.id), [COMMENT_ROW.id], 'the hello\'s comment row is kept');
});

test('a frame without a record removes its row and its path', async () => {
  const [a, b] = records;
  records = [b];
  await shell.frame({ type: `element:${TYPE}`, elements: records });
  assert.deepStrictEqual(liveOf().map((r) => r.id), [b.id]);
  await waitUntil(() => !pathOf(a.id) && pathOf(b.id), { timeout: 4000, what: 'the removed stroke undrawn' });
  assert.deepStrictEqual(liveOf('comment').map((r) => r.id), [COMMENT_ROW.id]);
});

test('a reset still fills the live rows itself; the loader\'s re-read after it keeps them', async () => {
  const [b] = records;
  const n0 = shell.calls.filter((c) => c.url === `/api/elements?type=${TYPE}`).length;
  const leanB = { id: b.id, v: 1, type: TYPE, schema: `${TYPE}@1`, anchor: SVG_RECORD, shared: false, replies: 0 };
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: [PANE], elements: [COMMENT_ROW, leanB] }), type: 'reset' });
  await waitUntil(() => shell.calls.filter((c) => c.url === `/api/elements?type=${TYPE}`).length > n0, { timeout: 3000, what: 'the loader\'s re-read' });
  await shell.tick(3);
  stubRects();          // the reset re-mounted the pane: its new svg's box
  ov.requestDraw();
  assert.deepStrictEqual(liveOf().map((r) => r.id), [b.id]);
  assert.deepStrictEqual(liveOf('comment').map((r) => r.id), [COMMENT_ROW.id]);
  await waitUntil(() => pathOf(b.id), { timeout: 4000, what: 'the stroke drawn after the reset' });
});

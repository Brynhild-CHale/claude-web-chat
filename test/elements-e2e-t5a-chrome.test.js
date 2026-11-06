'use strict';
// Tranche 5, stream 5A, in the real chrome at the integration head (U627; the
// twin of test/elements-e2e-t5a.test.js): public/index.html and main.js booted
// ONCE (test-support/chrome-shell bootShell, in the before() hook); the daemon
// a set of routes answering as it does once the fixture strokes pack is
// approved — the listing row and the toolbar tool BUILT from the fixture's
// element.json by the daemon's own code (lib/packs/elements validateElement,
// lib/server/element-types ROW_KEYS, routes/toolbar toolEntry), its draw.js
// imported through the loader's importer seam, and each POST /api/elements
// stored and handed back as the add's frame. jsdom does no layout, so the test
// owns it: a layout model reads the page's own DOM (each run's panes in their
// CSS order, two to a row on a desktop, stacked below 760 px; a markdown item
// full width) and answers getBoundingClientRect for the well, #main, the items
// and the blocks inside the panes, so a re-order, an insert or a re-render
// moves the items as a browser would. A ResizeObserver stand-in is put on
// globalThis before the boot (jsdom has none), so the overlay's box-target
// observer is the test's to drive.
//
// The steps (the daemon file names the rest):
//   (1) in the chrome, through the overlay's one pointer dispatch and the
//       fixture's own create: a pen stroke over a paragraph posts the element
//       record of the pane's outermost block (U611); a pen-down in the gutter
//       beside pane B posts a page record 'beside' B (U612); a stroke from
//       pane A's paragraph ending over pane B posts a page record from A to B
//       (REFRAME@commit); a stroke on the svg posts the svg's record; a
//       pen-down on a button is refused with REQ@hint-reflow's words and posts
//       nothing (CONTROL@refused);
//   (4) the arrow follows a move (a markdown item inserted above), a resize
//       of A's host (the ResizeObserver), a run re-order and a re-render, each
//       end within 2 CSS px of its recorded item-relative position
//       (ARROW@tolerance); the margin stroke follows its item; at 390 px the
//       arrow is drawn vertical between the stacked items and the margin
//       stroke faded at its guess, listed in the orphans card, a box marker
//       and never a pin (REQ@page-stroke-phone a; the pin is U629's, H2 = b);
//       a control under the arrow still takes its click; a gutter press
//       reaches the armed strokes type (REQ@margins a); U611's pen-down
//       refusal never refuses a pen-down in the gutter (.well-wrap outside
//       #main), and with finger-draws on a finger landing there routes 'tool'
//       (U612's isWell, stopped at .well-wrap) and posts a page record;
//   (5) Mod+Z with the pointer over either of the arrow's items posts the
//       undo for THAT item (UNDO@either-end; the daemon file proves either
//       item undoes it);
//   (8) the wet canvas on a page target never over viewport × dpr (U615's
//       WET@clip-viewport) through the fixture's create, and a second fast
//       stroke keeps the first wet on the trail until the first's end
//       (WET@trail), over a recording 2D context; the input rule: #main and
//       the well touch-action none while a strokes tool is armed (U616);
//   (9) the blend per marker part (U624, H4 = b; HAND FOLD 1, K.2-271): a
//       variant of the fixture's type opting into composite 'multiply' draws a
//       highlighter stroke's path into group.blend in #el-layer-blend
//       (blended: the layer's mix-blend-mode) and a pen stroke's into
//       group.container in #el-layer (not blended); group.blend placed,
//       masked around a frame and hidden with group.container ('framed': no
//       blended ink shows).
// No script-error frame reached the daemon and no interval was left armed.
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
const { createCascade } = require('../test-support/css-cascade');
const { STROKES_FIXTURE_DIR, STROKES_FIXTURE_NAME, STROKES_FIXTURE_TYPE } = require('../test-support/element-packs');
const { readElementJson, validateElement, elementSrcDir, COMPOSITE_MODES } = require('../lib/packs/elements');
const { ROW_KEYS } = require('../lib/server/element-types');
const { toolEntry } = require('../lib/server/routes/toolbar');
const S = require('../lib/core/strokes');

const REPO = path.join(__dirname, '..');
const TYPE = STROKES_FIXTURE_TYPE;
const PACK = STROKES_FIXTURE_NAME;
const DRAW_SRC = fs.readFileSync(path.join(elementSrcDir(STROKES_FIXTURE_DIR, TYPE), 'draw.js'), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SHA = sha(DRAW_SRC);
const DRAW_URL = `/api/elements/types/${TYPE}/draw.js?d=${SHA}`;
const CSS = fs.readFileSync(path.join(REPO, 'public', 'app.css'), 'utf8');

// (9)'s type: the fixture's element.json as a 0.2.0 pack would declare it
// (composite 'multiply'), under its own name, and the fixture's draw.js with
// one change — a highlighter stroke's path goes into ctx.blend (group.blend),
// every other stroke's into group.container.
const BLEND_TYPE = 'scribble-hl';
const BLEND_SRC = DRAW_SRC
  .replace("const svg = at(d.createElementNS(NS, 'svg'), { viewBox: '0 0 1 1', preserveAspectRatio: 'none', width: '100%', height: '100%' });",
    "const mk = () => at(d.createElementNS(NS, 'svg'), { viewBox: '0 0 1 1', preserveAspectRatio: 'none', width: '100%', height: '100%' });\n  const svg = mk();\n  const hl = mk();")
  .replace('    svg.appendChild(path);', "    (p.tool === 'highlighter' && ctx.blend ? hl : svg).appendChild(path);")
  .replace('  c.replaceChildren(svg);', '  c.replaceChildren(svg);\n  if (ctx.blend) ctx.blend.replaceChildren(hl);');
assert.notEqual(BLEND_SRC, DRAW_SRC, 'the variant differs from the fixture');
assert.ok(BLEND_SRC.includes('ctx.blend.replaceChildren(hl)') && BLEND_SRC.includes("p.tool === 'highlighter'"), 'every replacement applied');
const BLEND_SHA = sha(BLEND_SRC);
const BLEND_URL = `/api/elements/types/${BLEND_TYPE}/draw.js?d=${BLEND_SHA}`;

function rowsOf(type, raw, digest, stageDir) {
  const checked = validateElement(raw, { stageDir, name: type });
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  const row = { type };
  const toolbar = {};
  for (const k of Object.keys(checked.descriptor)) {
    if (ROW_KEYS.includes(k)) { if (k !== 'type') row[k] = checked.descriptor[k]; } else toolbar[k] = checked.descriptor[k];
  }
  return {
    listing: { ...row, builtin: false, tier: 'local', pack: PACK, toolbar, draw: { sha256: digest } },
    tool: toolEntry({ type, pack: PACK, builtin: false, toolbar }, '1.0.0'),
  };
}
const READ = readElementJson(elementSrcDir(STROKES_FIXTURE_DIR, TYPE));
assert.ok(READ.ok, READ.error);
const ROWS = rowsOf(TYPE, READ.raw, SHA, STROKES_FIXTURE_DIR);
const BLEND_ROWS = rowsOf(BLEND_TYPE, { ...READ.raw, type: BLEND_TYPE, schema: `${BLEND_TYPE}@1`, reads: [`${BLEND_TYPE}@1`], composite: 'multiply' }, BLEND_SHA, null);
assert.equal(BLEND_ROWS.listing.toolbar.composite, 'multiply', 'the 0.2.0-style manifest validates here, composite on its row');
const BASE_TYPES = DEFAULT_ROUTES['/api/elements/types'];
const BASE_TOOLBAR = DEFAULT_ROUTES['/api/toolbar'];

// jsdom has no ResizeObserver: the overlay's are the test's.
const observers = [];
class FakeRO {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}

const PA = { id: 'pa', target: 'main', params: {}, gen: 0,
  html: '<div class="a"><svg class="art" viewBox="0 0 200 100"><g><path class="line" d="M0 0 L10 10"/></g></svg>'
    + '<p class="prose">Pane A\'s paragraph the pen circles.</p><button class="go" type="button">Go</button></div>' };
const PB = { id: 'pb', target: 'main', params: {}, gen: 0, html: '<div class="b"><p class="prose">Pane B, where the arrow lands.</p></div>' };
const PC = { id: 'pc', target: 'main', params: {}, gen: 0, html: '<div class="c"><p class="prose">Pane C</p></div>' };
const PD = { id: 'pd', target: 'main', params: {}, gen: 0, html: '<div class="d"><p class="prose">Pane D</p></div>' };
const MOUNTS = [PA, PB, PC, PD];
const ORDER = ['pa', 'pb', 'pc', 'pd'];

let shell, W, M, ov, ET, ORPH, TF, IM, anchors, wet;
let approved = false;
let records = [];
let nextSeq = 1;
const imported = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u627-chrome-'));
let intervalsAtBoot = 0;
const R = {};   // the strokes the steps hand on

// ── the layout model ────────────────────────────────────────────────────────
const TOP = 48;
const geo = { width: {}, height: {} };   // the test's own resizes
const extra = new Map();                 // element → () => rect, for a stub the model does not lay out
function columns() {
  const vw = W.innerWidth;
  const vh = W.innerHeight;
  const narrow = vw < 760;
  const colW = Math.min(vw, 1180);
  const mainLeft = (vw - colW) / 2;
  const pad = narrow ? 14 : 26;
  return { narrow, wrap: { left: 0, top: TOP, width: vw, height: vh - TOP },
    main: { left: mainLeft, top: TOP, width: colW, height: 3000 }, cl: mainLeft + pad, cw: colW - 2 * pad };
}
function layout() {
  const main = W.document.getElementById('main');
  const c = columns();
  const out = new Map();
  let y = TOP + 24;
  for (const child of main.children) {
    if (child.hasAttribute('data-md-id')) {
      out.set(child, { left: c.cl, top: y, width: c.cw, height: 40 });
      y += 56;
      continue;
    }
    if (!child.classList.contains('page-run')) continue;
    const grid = child.querySelector('.run-grid');
    const wrappers = [...grid.children].filter((w) => w.classList.contains('pane'))
      .sort((a, b) => Number(a.style.order || 0) - Number(b.style.order || 0));
    let col = 0;
    let rowH = 0;
    for (const w of wrappers) {
      const host = w.querySelector('.mount-host');
      if (!host || w.classList.contains('minimized')) continue;
      const id = host.dataset.mountId;
      const h = geo.height[id] || 200;
      const full = c.narrow ? c.cw : (c.cw - 16) / 2;
      const x = c.narrow ? c.cl : c.cl + col * (full + 16);
      const r = { left: x, top: y, width: full - (geo.width[id] || 0), height: h };
      out.set(host, r);
      out.set(w, r);
      if (c.narrow) { y += h + 16; continue; }
      rowH = Math.max(rowH, h);
      if (++col === 2) { col = 0; y += rowH + 16; rowH = 0; }
    }
    if (rowH) y += rowH + 16;
  }
  return out;
}
const hostOf = (id) => M.itemEl(W.document, id) && M.itemEl(W.document, id).el;
const rootOf = (id) => hostOf(id).shadowRoot;
const q = (id, sel) => rootOf(id).querySelector(sel);
// A pane's blocks, inside its host: the outermost div inset 8 px, the svg (and
// its path) at 20,20 200×100, the paragraph under it, the button right of it.
function inner(el, h) {
  if (el.matches('div.a, div.b, div.c, div.d')) return { left: h.left + 8, top: h.top + 8, width: h.width - 16, height: h.height - 16 };
  if (el.matches('svg.art, path.line, svg.art g')) return { left: h.left + 20, top: h.top + 20, width: 200, height: 100 };
  if (el.matches('p.prose')) return { left: h.left + 20, top: h.top + 130, width: h.width - 120, height: 20 };
  if (el.matches('button.go')) return { left: h.left + h.width - 90, top: h.top + 110, width: 40, height: 14 };
  return null;
}
function rectFor(el) {
  if (extra.has(el)) return extra.get(el)();
  const c = columns();
  if (el.classList && el.classList.contains('well-wrap')) return c.wrap;
  if (el.id === 'main') return c.main;
  const root = el.getRootNode && el.getRootNode();
  if (root && root.nodeType === 11 && root.host) {
    const h = layout().get(root.host);
    return h ? inner(el, h) : null;
  }
  return layout().get(el) || null;
}
const itemRect = (id) => layout().get(hostOf(id)) || layout().get(W.document.querySelector(`[data-md-id="${id}"]`));

// ── the daemon, as the routes answer it ─────────────────────────────────────
const posts = (url = '/api/elements') => shell.calls.filter((c) => c.method === 'POST' && c.url === url);
function elementsRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method === 'POST') {
    const body = JSON.parse(init.body);
    const seq = nextSeq++;
    const { shared, ...rest } = body.payload;
    const rec = { id: `p${seq}`, type: body.type, v: 1, schema: `${body.type}@1`, seq, created_at: new Date(1793000000000 + seq * 1000).toISOString(),
      shared: shared !== false, anchor: body.anchor, ...rest, writer: { class: 'user', owner: 'user', verified: false } };
    records = records.concat([rec]);
    return { ok: true, element: rec };
  }
  const m = /[?&]type=([^&]+)/.exec(url);
  return { elements: m ? records.filter((r) => r.type === decodeURIComponent(m[1])) : [], next_cursor: nextSeq };
}
const undone = [];
function undoRoute(url, init) {
  const body = JSON.parse(init.body);
  undone.push(body);
  return { ok: true, undone: { id: R.arrow ? R.arrow.id : 'p0', type: TYPE, v: 1, item: body.item, how: 'removed' } };
}
async function importThroughRoute(url) {
  imported.push(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the route answered ${r.status}`);
  // Named by the URL (its digest): two imports in flight never share a file.
  const file = path.join(tmp, `draw-${sha(url).slice(0, 16)}.mjs`);
  fs.writeFileSync(file, await r.text());
  return import(pathToFileURL(file).href);
}
// The add's frame: every stored stroke of a type back to the chrome.
const relay = (type = TYPE) => shell.frame({ type: `element:${type}`, elements: records.filter((r) => r.type === type) });

// ── input ───────────────────────────────────────────────────────────────────
let pid = 50;
function pointer(el, type, x, y, { pointerType = 'pen', pointerId, samples = null, pressure = 0.6, t = 0 } = {}) {
  const e = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType, pointerId,
    isPrimary: true, clientX: x, clientY: y, pressure, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 });
  const list = samples || [{ clientX: x, clientY: y, pressure, timeStamp: 1000 + t }];
  e.getCoalescedEvents = () => list;
  e.getPredictedEvents = () => [];
  el.dispatchEvent(e);
  return e;
}
// One stroke: pen-down at the first point on `el`, a move per later point,
// pen-up at the last — every event dispatched on `el`, as a captured pointer's
// are. Answers the POST it made (or null), after its frame.
async function strokeOn(el, pts, { pointerType = 'pen' } = {}) {
  const id = ++pid;
  const n0 = posts().length;
  pointer(el, 'pointerdown', pts[0][0], pts[0][1], { pointerType, pointerId: id, t: 0 });
  await shell.tick();
  for (let i = 1; i < pts.length; i++) {
    pointer(el, 'pointermove', pts[i][0], pts[i][1], { pointerType, pointerId: id, t: i * 8 });
    await shell.tick();
  }
  const last = pts[pts.length - 1];
  pointer(el, 'pointerup', last[0], last[1], { pointerType, pointerId: id, t: pts.length * 8 });
  await shell.tick(3);
  return posts().length > n0 ? posts()[posts().length - 1].body : null;
}
const reaimText = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };
function arc(a, b, lift, n = 6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - lift * Math.sin(Math.PI * u)]);
  }
  return out;
}

// ── reading the layer ───────────────────────────────────────────────────────
const px = (v) => parseFloat(v);
const markerOf = (id) => [...W.document.querySelectorAll('#el-layer .el-marker')]
  .find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const blendOf = (id) => [...W.document.querySelectorAll('#el-layer-blend .el-blend')]
  .find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const shown = (id) => { const m = markerOf(id); return !!m && m.style.display !== 'none'; };
const boxOfMarker = (m) => ({ left: px(m.style.left), top: px(m.style.top), w: px(m.style.width), h: px(m.style.height) });
const at = (e) => { const r = itemRect(e.item); return [r.left + e.x * r.width, r.top + e.y * r.height]; };
function drawnEnds(rec) {
  const m = markerOf(rec.id);
  const view = ET.recordOf(rec.type, rec.id);
  if (!m || !view) return null;
  const b = boxOfMarker(m);
  const n = view.points.length / 4;
  const p = (i) => [b.left + view.points[i * 4] * b.w, b.top + view.points[i * 4 + 1] * b.h];
  return { first: p(0), last: p(n - 1) };
}
// Each end's distance, in CSS px, from its recorded item-relative position now.
function endsOff(rec) {
  const d = drawnEnds(rec);
  if (!d) return Infinity;
  const a0 = at(rec.anchor.from);
  const aN = at(rec.anchor.to);
  return Math.max(Math.hypot(d.first[0] - a0[0], d.first[1] - a0[1]), Math.hypot(d.last[0] - aN[0], d.last[1] - aN[1]));
}
async function endsFollow(rec, label) {
  await waitUntil(() => shown(rec.id) && endsOff(rec) <= 2, { timeout: 5000, what: `${label}: ${rec.id}'s ends on its items` });
  assert.ok(endsOff(rec) <= 2, `${label}: within 2 CSS px (${endsOff(rec)})`);
}
const boxRO = () => observers.find((o) => o !== observers[0] && [...o.targets].length > 0) || null;
function resizeEntry(el) { const r = rectFor(el); return { target: el, contentRect: { width: r.width, height: r.height } }; }

// The recording 2D context the wet layer paints into (jsdom has none).
const contexts = [];
function stubContext(canvasEl) {
  const calls = [];
  const c = { canvas: canvasEl, calls };
  for (const k of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'drawImage']) c[k] = (...a) => calls.push([k, ...a]);
  contexts.push(c);
  return c;
}
const wetCanvases = () => [...W.document.querySelectorAll('canvas.el-wet')].filter((c) => c.isConnected);
const trailCanvas = () => W.document.querySelector('canvas.el-wet-trail');
const setDpr = (v) => Object.defineProperty(W, 'devicePixelRatio', { value: v, configurable: true, writable: true });

before(async () => {
  globalThis.ResizeObserver = FakeRO;
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => (approved ? { ...BASE_TYPES, types: [...BASE_TYPES.types, ROWS.listing, BLEND_ROWS.listing] } : BASE_TYPES),
      '/api/toolbar': () => (approved
        ? { ...BASE_TOOLBAR, tools: [...BASE_TOOLBAR.tools, ROWS.tool], project: { ...BASE_TOOLBAR.project, pinned: [...BASE_TOOLBAR.project.pinned, TYPE] } }
        : BASE_TOOLBAR),
      [DRAW_URL]: () => respond(DRAW_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
      [BLEND_URL]: () => respond(BLEND_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
      '/api/elements': elementsRoute,
      '/api/elements/undo': undoRoute,
    },
  });
  W = shell.window;
  M = W.__wcMount;
  const own = W.Element.prototype.getBoundingClientRect;
  W.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const r = rectFor(this);
    if (!r) return own.call(this);
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
  };
  W.HTMLCanvasElement.prototype.getContext = function getContext(kind) { return kind === '2d' ? stubContext(this) : null; };
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  ORPH = await shell.importApp('orphans.js');
  TF = await shell.importApp('target-frame.js');
  IM = await shell.importApp('input-mode.js');
  anchors = (await shell.importApp('anchors.js')).default;
  wet = (await shell.importApp('wet-layer.js')).initWetLayer();
  IM.setFingerDraws('off');
  ET.initElementTypes({ importModule: importThroughRoute });
  await shell.frame(helloFrame({ active: 'n1', mounts: MOUNTS, order: ORDER, claude_order: ORDER }));
  await shell.tick();
  approved = true;
  await shell.frame({ type: 'components' });
  await waitUntil(() => ET.typeOf(TYPE) && ET.typeOf(BLEND_TYPE), { timeout: 3000, what: 'the two listing rows' });
  await ET.loadPluginTypes();
  assert.deepStrictEqual([...imported].sort(), [DRAW_URL, BLEND_URL].sort(), 'each draw.js imported once, by its digest');
  intervalsAtBoot = shell.intervals().length;
});

after(async () => {
  try { if (ov) ov.setArmed(null); } catch {}
  if (shell) await shell.restore();
  delete globalThis.ResizeObserver;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('(1) in the chrome, through the fixture\'s own create: a paragraph posts the pane\'s outermost block\'s record; the gutter beside B a page record \'beside\' B; pane A → pane B an arrow from A to B; the svg its own record; a button refused with the hint, nothing posted', async () => {
  ov.setArmed(TYPE);
  try {
    // The pane frame: a pen stroke over A's paragraph, inside its block.
    const p = q('pa', 'p.prose');
    const pr = rectFor(p);
    const paneBody = await strokeOn(p, arc([pr.left + 10, pr.top + 10], [pr.left + 200, pr.top + 12], 6));
    assert.ok(paneBody, 'one POST');
    assert.deepStrictEqual(paneBody.anchor, anchors.record(rootOf('pa'), q('pa', 'div.a'), { mount: 'pa' }), 'the outermost block\'s element record (U611)');
    assert.equal(S.frameKindOf(paneBody.anchor), 'pane');
    assert.equal(paneBody.payload.shared, false, 'private by default (PRIVATE@create)');
    R.pane = records.at(-1);

    // The svg: the fixed-aspect frame wins.
    const svgR = rectFor(q('pa', 'svg.art'));
    const svgBody = await strokeOn(q('pa', 'path.line'), arc([svgR.left + 30, svgR.top + 70], [svgR.left + 170, svgR.top + 30], 10));
    assert.deepStrictEqual(svgBody.anchor, anchors.record(rootOf('pa'), q('pa', 'svg.art'), { mount: 'pa' }), 'the svg\'s own record');
    assert.equal(S.frameKindOf(svgBody.anchor), 'target');
    R.svg = records.at(-1);

    // The page frame: an arrow from A's paragraph ending over pane B,
    // re-framed at commit (REFRAME@commit), crossing A's button.
    const b = itemRect('pb');
    const btn = rectFor(q('pa', 'button.go'));
    const start = [pr.left + 30, pr.top + 10];
    const end = [b.left + 200, b.top + 100];
    const arrowPts = arc(start, end, (start[1] - btn.top) + 20);
    const arrowBody = await strokeOn(p, arrowPts);
    assert.ok(arrowBody, 'the arrow posts');
    assert.ok(S.isPageRecord(arrowBody.anchor), JSON.stringify(arrowBody.anchor));
    assert.equal(S.pageShape(arrowBody.anchor), 'between');
    assert.deepStrictEqual([arrowBody.anchor.from.item, arrowBody.anchor.to.item], ['pa', 'pb']);
    assert.equal(S.pageLabel(arrowBody.anchor), 'from pa to pb');
    R.arrow = records.at(-1);

    // The margin: a pen-down in the gutter right of #main, beside pane B.
    // U611's pen-down refusal never refuses it (.well-wrap outside #main).
    const wrap = W.document.querySelector('.well-wrap');
    const main = W.document.getElementById('main');
    const gx = columns().main.left + columns().main.width + 25;
    assert.ok(!main.contains(wrap) && gx > columns().main.left + columns().main.width, 'the press lies outside #main, in the well');
    assert.equal(TF.frameAt({ type: 'pointerdown', pointerType: 'pen', clientX: gx, clientY: b.top + 60, target: wrap,
      composedPath: () => [wrap, wrap.parentNode, W.document.body, W.document.documentElement, W.document] }).kind, 'page', 'the gutter takes the page frame');
    const marginBody = await strokeOn(wrap, [[gx, b.top + 60], [gx + 4, b.top + 90], [gx + 6, b.top + 130]]);
    assert.ok(marginBody, 'the gutter press reached the armed strokes type (REQ@margins a)');
    assert.equal(S.pageShape(marginBody.anchor), 'beside');
    assert.equal(marginBody.anchor.item, 'pb', 'beside its nearest item');
    R.margin = records.at(-1);

    // The column's padding: a pen-down in the run's gap under pane A.
    const a = itemRect('pa');
    const gap = W.document.querySelector('.run-grid');
    const underBody = await strokeOn(gap, [[a.left + 60, a.top + a.height + 6], [a.left + 180, a.top + a.height + 7], [a.left + 300, a.top + a.height + 8]]);
    assert.ok(underBody, 'a pen-down in the column\'s padding posts');
    assert.equal(S.pageShape(underBody.anchor), 'beside');
    assert.equal(underBody.anchor.item, 'pa', 'beside its nearest item');
    assert.ok(underBody.anchor.from.y > 1, 'below it');
    R.under = records.at(-1);

    // A pen-down on the button: refused with the hint, nothing posted.
    const n0 = posts().length;
    const refused = await strokeOn(q('pa', 'button.go'), [[btn.left + 5, btn.top + 5], [btn.left + 60, btn.top + 40], [btn.left + 120, btn.top + 60]]);
    assert.equal(refused, null, 'nothing posted (CONTROL@refused)');
    assert.equal(posts().length, n0);
    assert.equal(reaimText(), TF.FRAME_HINT, 'the hint is shown');
    assert.equal(TF.FRAME_HINT, 'Ink draws anywhere on the page but on a control or the chrome; over text it may drift when the text re-wraps', 'REQ@hint-reflow\'s words');
  } finally { ov.setArmed(null); }
  await relay();
  await waitUntil(() => [R.pane, R.svg, R.arrow, R.margin, R.under].every((r) => shown(r.id)), { timeout: 6000, what: 'every stroke drawn dry' });
});

test('(4) the arrow follows a move, a resize of A\'s host, a run re-order and a re-render, each end within 2 CSS px; the margin stroke follows its item', async () => {
  const m = markerOf(R.arrow.id);
  assert.equal(m.dataset.place, 'box');
  assert.equal(m.dataset.elFrame, 'page');
  await endsFollow(R.arrow, 'drawn');
  await endsFollow(R.margin, 'drawn');
  // A move: a markdown item inserted above the run.
  const top0 = itemRect('pa').top;
  const order = ['md-top', ...ORDER];
  await shell.frame({ type: 'markdown', id: 'md-top', text: '# Above the panes', owner: 'claude', gen: 1, order, claude_order: order });
  assert.ok(itemRect('pa').top > top0, 'A moved down');
  await endsFollow(R.arrow, 'moved');
  await endsFollow(R.margin, 'its item moved');
  await endsFollow(R.under, 'its item moved');
  await shell.frame({ type: 'markdown:remove', id: 'md-top' });
  await endsFollow(R.arrow, 'moved back');
  // A resize of A's host, nothing else: the box-target observer's to follow.
  const host = hostOf('pa');
  const ro = boxRO();
  assert.ok(ro && ro.targets.has(host) && ro.targets.has(hostOf('pb')), 'the box-target observer watches both endpoint items');
  ro.cb([resizeEntry(host)]);
  await shell.tick(2);
  geo.width.pa = 120;
  try {
    ro.cb([resizeEntry(host)]);
    await endsFollow(R.arrow, 'resized');
    assert.ok(Number(markerOf(R.arrow.id).getAttribute(ov.DRIFT_ATTR)) > 0, 'the drift reported beside (DRIFT@beside), never a state');
  } finally { geo.width.pa = 0; ro.cb([resizeEntry(host)]); }
  await endsFollow(R.arrow, 'resized back');
  // A run re-order: pane B first.
  const ax = itemRect('pa').left;
  await shell.frame({ type: 'page:order', order: ['pb', 'pa', 'pc', 'pd'], claude_order: ['pb', 'pa', 'pc', 'pd'] });
  assert.ok(itemRect('pa').left > ax, 'A moved right');
  await endsFollow(R.arrow, 're-ordered');
  await endsFollow(R.margin, 're-ordered');
  await shell.frame({ type: 'page:order', order: ORDER, claude_order: ORDER });
  await endsFollow(R.arrow, 're-ordered back');
  // A re-render, taller.
  geo.height.pa = 260;
  await shell.frame({ type: 'render', ...PA, html: PA.html.replace('the pen circles', 'the pen circles, re-rendered'), gen: 1 });
  await endsFollow(R.arrow, 're-rendered');
  delete geo.height.pa;
  await shell.frame({ type: 'render', ...PA, gen: 2 });
  await endsFollow(R.arrow, 'back');
});

test('(4) a control under the arrow still takes its click: the marker takes no press', async () => {
  await endsFollow(R.arrow, 'placed');
  const m = markerOf(R.arrow.id);
  const btn = q('pa', 'button.go');
  const b = rectFor(btn);
  const box = boxOfMarker(m);
  assert.ok(b.left >= box.left && b.left + b.width <= box.left + box.w && b.top >= box.top && b.top + b.height <= box.top + box.h,
    `the button ${JSON.stringify(b)} lies under the arrow's marker ${JSON.stringify(box)}`);
  assert.equal(m.style.pointerEvents, 'none');
  let clicks = 0;
  const on = () => { clicks++; };
  btn.addEventListener('click', on);
  try { shell.press(btn); } finally { btn.removeEventListener('click', on); }
  assert.equal(clicks, 1, 'the button got its click');
});

test('(4) at 390 px the arrow is drawn vertical between the stacked items; the margin stroke faded at its guess, listed in the orphans card, a box marker and never a pin', async () => {
  shell.setViewport({ width: 390, height: 844, coarse: true });
  try {
    await waitUntil(() => itemRect('pb').top > itemRect('pa').top + 100, { timeout: 3000, what: 'stacked' });
    await endsFollow(R.arrow, 'at 390 px');
    const d = drawnEnds(R.arrow);
    assert.ok(Math.abs(d.last[1] - d.first[1]) > Math.abs(d.last[0] - d.first[0]), 'turned vertical');
    for (const [r, item] of [[R.under, 'pa'], [R.margin, 'pb']]) {
      await waitUntil(() => ov.orphans().some((o) => o.id === r.id), { timeout: 4000, what: `${r.id} listed` });
      const o = ov.orphans().find((x) => x.id === r.id);
      assert.deepStrictEqual({ kind: o.kind, mount: o.mount, guess: o.guess, how: o.how }, { kind: 'page', mount: item, guess: true, how: 'page-narrow' });
    }
    // The column's margin stroke: drawn faded at its guess.
    await waitUntil(() => shown(R.under.id) && markerOf(R.under.id).classList.contains('el-guess'), { timeout: 4000, what: 'drawn faded at its guess' });
    const mm = markerOf(R.under.id);
    assert.equal(mm.dataset.place, 'box', 'the box marker, never a pin (U629\'s, after the alpha.5 tag)');
    assert.equal(mm.querySelector('svg').getAttribute('opacity'), '0.4', 'the type draws it faded');
    // The gutter's: its guess lies right of pane B, past a phone's well (a
    // phone has no gutter), so it is cut by the well's clip — listed, never
    // drawn at a stale place; faded wherever it is drawn.
    const mg = markerOf(R.margin.id);
    assert.ok(!mg || mg.classList.contains('el-guess'), 'the gutter stroke, faded where drawn');
    assert.ok(!ov.orphans().some((x) => x.id === R.arrow.id), 'the arrow is no orphan');
    const pop = ORPH.openOrphanList();
    try {
      for (const [r, item] of [[R.under, 'pa'], [R.margin, 'pb']]) {
        const row = pop.querySelector(`.wc-orphan-row[data-el-id="${r.id}"]`);
        assert.ok(row, `${r.id} listed in the orphans card`);
        assert.equal(row.querySelector('.wc-orphan-act'), null, 'no Re-anchor… for a page stroke');
        assert.match(row.querySelector('.wc-orphan-place').textContent, new RegExp(`beside ${item}`));
      }
    } finally { pop.remove(); }
  } finally {
    shell.setViewport({ width: 1280, height: 800, coarse: false });
  }
  await waitUntil(() => !ov.orphans().some((o) => o.id === R.margin.id || o.id === R.under.id), { timeout: 4000, what: 'unlisted on the desktop' });
  await endsFollow(R.margin, 'back on the desktop');
  await endsFollow(R.under, 'back on the desktop');
});

test('(4) with finger-draws on, a finger landing in the gutter routes \'tool\' (isWell stopped at .well-wrap) and posts a page record; with it off the same finger posts nothing', async () => {
  const wrap = W.document.querySelector('.well-wrap');
  const b = itemRect('pb');
  const gx = columns().main.left + columns().main.width + 20;
  ov.setArmed(TYPE);
  try {
    IM.setFingerDraws('off');
    const none = await strokeOn(wrap, [[gx, b.top + 40], [gx + 3, b.top + 80], [gx + 5, b.top + 120]], { pointerType: 'touch' });
    assert.equal(none, null, 'finger-draws off: a finger never draws');
    IM.setFingerDraws('on');
    const id = ++pid;
    pointer(wrap, 'pointerdown', gx, b.top + 40, { pointerType: 'touch', pointerId: id });
    assert.equal(IM.touchesForTests({ routes: true }).routes[id], 'tool', 'the finger is the tool\'s in the gutter');
    pointer(wrap, 'pointercancel', gx, b.top + 40, { pointerType: 'touch', pointerId: id });
    await shell.tick();
    const body = await strokeOn(wrap, [[gx, b.top + 40], [gx + 3, b.top + 80], [gx + 5, b.top + 120]], { pointerType: 'touch' });
    assert.ok(body, 'a finger margin stroke posts');
    assert.equal(S.pageShape(body.anchor), 'beside');
    assert.equal(body.anchor.item, 'pb');
  } finally { IM.setFingerDraws('off'); ov.setArmed(null); }
});

test('(5) Mod+Z with the pointer over either of the arrow\'s items posts the undo for that item (UNDO@either-end)', async () => {
  for (const item of ['pb', 'pa']) {
    const p = q(item, 'p.prose');
    const r = rectFor(p);
    const n0 = posts('/api/elements/undo').length;
    p.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, composed: true, pointerType: 'mouse', clientX: r.left + 5, clientY: r.top + 5 }));
    const e = shell.key('z', { metaKey: true });
    await waitUntil(() => posts('/api/elements/undo').length === n0 + 1, { timeout: 3000, what: `the undo from ${item}` });
    assert.equal(e.defaultPrevented, true);
    assert.equal(posts('/api/elements/undo')[n0].body.item, item, `the item under the pointer: ${item}`);
  }
});

test('(8) the wet canvas on a page target is the well\'s visible part, never over viewport × dpr, through the fixture\'s create; a second fast stroke keeps the first wet on the trail until its end; #main and the well touch-action none while armed', async () => {
  const css = createCascade(CSS, { win: () => W });
  const main = W.document.getElementById('main');
  const wrap = W.document.querySelector('.well-wrap');
  assert.equal(css.value(main, 'touch-action'), 'manipulation', 'disarmed: #main pans and zooms');
  ov.setArmed(TYPE);
  setDpr(2);
  try {
    assert.ok(W.document.documentElement.classList.contains('strokes-armed'));
    assert.equal(css.value(main, 'touch-action'), 'none', 'armed: #main none (U616)');
    assert.equal(css.value(wrap, 'touch-action'), 'none', 'armed: the well none');
    // A pen stroke in the gutter through the fixture's create: ctx.wet begins
    // over the frame's target, #main (3,000 px tall).
    const b = itemRect('pb');
    const gx = columns().main.left + columns().main.width + 25;
    const id = ++pid;
    pointer(wrap, 'pointerdown', gx, b.top + 40, { pointerId: id });
    pointer(wrap, 'pointermove', gx + 2, b.top + 70, { pointerId: id, t: 8 });
    await shell.tick();
    const [c] = wetCanvases();
    assert.ok(c, 'the wet canvas begun');
    const vw = W.innerWidth;
    const vh = W.innerHeight;
    assert.ok(c.width <= vw * 2 && c.height <= vh * 2, `${c.width} × ${c.height}: never over the viewport × dpr`);
    const well = columns().wrap;
    assert.deepStrictEqual([c.style.left, c.style.top, c.style.width, c.style.height], [`${well.left}px`, `${well.top}px`, `${well.width}px`, `${well.height}px`],
      'the well\'s visible part, gutters included (WET@clip-viewport)');
    pointer(wrap, 'pointerup', gx + 2, b.top + 70, { pointerId: id, t: 16 });
    await waitUntil(() => wetCanvases().length === 0, { timeout: 3000, what: 'the wet canvas dropped at pen-up' });
  } finally { setDpr(1); ov.setArmed(null); }
  assert.equal(css.value(main, 'touch-action'), 'manipulation', 'disarmed again');
  await relay();

  // Two fast strokes on the page target: the second's begin before the
  // first's end keeps the first on the trail until end(first).
  const draw = (g, view) => { view.clear(); g.beginPath(); for (let i = 0; i < view.count; i++) g.lineTo(view.x(i), view.y(i)); g.stroke(); };
  const s = (x, y, t) => ({ clientX: x, clientY: y, pressure: 0.5, timeStamp: t });
  const first = wet.begin(main, { pointerId: 81 });
  assert.ok(first > 0);
  wet.push([s(100, 200, 1), s(140, 230, 2)]);
  wet.paint(draw);
  await shell.tick(2);
  const second = wet.begin(main, { pointerId: 82 });
  assert.ok(second > first, 'a new token');
  const t = trailCanvas();
  assert.ok(t && t.isConnected, 'the first stroke laid on the trail');
  const tc = contexts.find((x) => x.canvas === t);
  assert.ok(tc && tc.calls.some((k) => k[0] === 'drawImage'), 'its pixels copied onto the trail');
  assert.equal(wet.stats().held, 1);
  wet.push([s(300, 300, 3)]);
  wet.paint(draw);
  await shell.tick(2);
  assert.equal(wet.end(second), true, 'the second ends');
  await shell.tick(3);
  assert.ok(t.isConnected, 'the first still wet after the second dried (no blink between fast strokes)');
  assert.equal(wet.end(first), true, 'the first\'s own end');
  await waitUntil(() => !t.isConnected && wet.stats().held === 0, { timeout: 3000, what: 'the trail dries at the first\'s end' });
});

test('(9) the blend per marker part: an opting type\'s highlighter path in group.blend in #el-layer-blend (blended), its pen path in group.container in #el-layer (not blended); group.blend placed, masked and hidden with its container', async () => {
  assert.deepStrictEqual([...ov.COMPOSITE_MODES], COMPOSITE_MODES);
  // Two page strokes of the opting type from pane C to pane D — one group: a
  // highlighter and a pen.
  const FRAME = { w: W.innerWidth, h: 3000 };
  const endOf = (id, x, y) => { const r = itemRect(id); return { item: id, x, y, w: r.width, h: r.height }; };
  const toPage = ([x, y]) => [x / FRAME.w, (y - TOP) / FRAME.h];
  const stroke = (tool, fy) => {
    const from = endOf('pc', 0.5, fy);
    const to = endOf('pd', 0.5, fy);
    const anchor = S.pageRecord({ from, to, frame: FRAME });
    assert.ok(anchor, 'a page record');
    const points = [];
    arc(at(from), at(to), 20).forEach((p, i) => points.push(...toPage(p), 0.5, i * 8));
    const seq = nextSeq++;
    return { id: `p${seq}`, type: BLEND_TYPE, v: 1, schema: `${BLEND_TYPE}@1`, seq, created_at: new Date(1793000000000 + seq * 1000).toISOString(),
      shared: false, anchor, points, stride: 4, width: (tool === 'highlighter' ? 12 : 2) / FRAME.w, colour: 'accent', tool, aspect: FRAME.w / FRAME.h,
      writer: { class: 'user', owner: 'user', verified: false } };
  };
  const hl = stroke('highlighter', 0.4);
  const pen = stroke('pen', 0.6);
  records = records.concat([hl, pen]);
  await relay(BLEND_TYPE);
  const m = await waitUntil(() => (shown(hl.id) ? markerOf(hl.id) : null), { timeout: 6000, what: 'the opting group drawn' });
  assert.equal(m, markerOf(pen.id), 'one group: same type, same items');
  const b = await waitUntil(() => blendOf(hl.id), { timeout: 4000, what: 'its blend part' });
  const hlPath = W.document.querySelector(`path[data-el-id="${hl.id}"]`);
  const penPath = W.document.querySelector(`path[data-el-id="${pen.id}"]`);
  const layer = W.document.getElementById('el-layer');
  const blendLayer = W.document.getElementById('el-layer-blend');
  assert.ok(blendLayer.contains(hlPath) && b.contains(hlPath), 'the highlighter\'s path is in group.blend, in #el-layer-blend');
  assert.ok(layer.contains(penPath) && m.contains(penPath), 'the pen\'s path is in group.container, in #el-layer');
  assert.equal(blendLayer.style.mixBlendMode, 'multiply', 'the blend layer blends (light mode)');
  assert.equal(blendLayer.hidden, false);
  const cssView = createCascade(CSS, { win: () => W });
  assert.ok(!layer.style.mixBlendMode && !cssView.value(layer, 'mix-blend-mode'), '#el-layer does not blend: the pen stroke is not blended');
  assert.ok(!m.style.mixBlendMode && !penPath.style.mixBlendMode, 'nor its marker or path');
  // Placed: group.blend has group.container's box, clip and display.
  const MIRRORED = ['left', 'top', 'width', 'height', 'clipPath', 'display'];
  const styleOf = (el) => Object.fromEntries(MIRRORED.map((k) => [k, el.style[k]]));
  assert.deepStrictEqual(styleOf(b), styleOf(m), 'placed with its container');
  // Masked around a displayed frame: the same path() mask on both.
  const box = boxOfMarker(m);
  const frame = W.document.createElement('iframe');
  W.document.body.appendChild(frame);
  extra.set(frame, () => ({ left: box.left + box.w / 2 - 20, top: box.top + 2, width: 40, height: box.h + 40 }));
  try {
    ov.requestDraw();
    await waitUntil(() => /path\(/.test(m.style.clipPath), { timeout: 4000, what: 'the mask' });
    await shell.tick(2);
    assert.notEqual(m.style.display, 'none', 'masked, never hidden whole (PAGE@mask-frames)');
    assert.deepStrictEqual(styleOf(b), styleOf(m), 'group.blend masked with it');
    // A frame over the whole box: 'framed' — neither part shows.
    extra.set(frame, () => ({ left: box.left - 10, top: box.top - 10, width: box.w + 20, height: box.h + 20 }));
    ov.requestDraw();
    await waitUntil(() => m.style.display === 'none', { timeout: 4000, what: 'framed' });
    await shell.tick(2);
    assert.equal(b.style.display, 'none', 'a framed opting group shows no blended ink');
  } finally { frame.remove(); extra.delete(frame); }
  ov.requestDraw();
  await waitUntil(() => m.style.display !== 'none' && b.style.display !== 'none', { timeout: 4000, what: 'shown again with the frame gone' });
  assert.deepStrictEqual(styleOf(b), styleOf(m));
  // Its items gone: the group undrawn, its blend part with it.
  await shell.frame({ type: 'clear', id: 'pc' });
  await shell.frame({ type: 'clear', id: 'pd' });
  await waitUntil(() => !markerOf(hl.id) || markerOf(hl.id).style.display === 'none', { timeout: 4000, what: 'undrawn' });
  await waitUntil(() => !blendOf(hl.id) || blendOf(hl.id).style.display === 'none', { timeout: 4000, what: 'its blend part with it' });
});

test('no script-error frame reached the daemon, and no interval was left armed', async () => {
  await shell.tick();
  const errors = shell.sockets.flatMap((s) => s.frames('script:error'));
  assert.deepEqual(errors, [], 'no pane script failed');
  assert.equal(shell.intervals().length, intervalsAtBoot, 'no interval armed since boot');
});

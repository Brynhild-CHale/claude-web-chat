// The overlay's page arm in the real chrome (annotation engine tranche 5,
// U614, plan 5A.2; REQ@ink-scope-v2 b+, REQ@arrow-endpoints a, REQ@margins a,
// REQ@page-stroke-phone a, PAGE@mask-frames, ARROW@tolerance, DRIFT@beside,
// MAP@engine, CONTROL@refused): test-support/chrome-shell booted once, the
// checked-in strokes fixture's `scribble` type (its real draw.js, through the
// loader's importer seam, as test/plugin-rows-relay-chrome.test.js loads it),
// its rows through the hello and reset frames and its records through GET
// /api/elements. jsdom does no layout, so the test owns it: a layout model
// reads the page's own DOM (each run's panes in their CSS order, two per row
// on a desktop, stacked below 760 px; a markdown item full width) and answers
// getBoundingClientRect for the well, #main, the items and a few elements
// inside the panes — so a re-order, an insert or a removal moves the items as
// a browser would, and a resize the test makes moves nothing else. A
// ResizeObserver stand-in is put on globalThis before the boot (jsdom has
// none), so the overlay's box-target observer is the test's to drive.
//
// Pinned here:
//   - an arrow between two panes is drawn between them, and after a run
//     re-order, a resize of its .mount-host with no window resize (the
//     ResizeObserver: stale until it fires), a second re-order and a
//     re-render, each end lies within 2 CSS px of its recorded item-relative
//     position (ARROW@tolerance), the drawn path being record(id)'s points;
//   - a margin ('beside') stroke follows its item after a markdown item is
//     inserted above it, and a gutter stroke beyond the column is drawn (the
//     clip starts at the well);
//   - record(id) of a page stroke answers the flat record with points mapped
//     into its marker's box, in [0, 1], equal to reboxPoints over its mapPage
//     points from its own box to the group's; a fresh object per call; an
//     element row's record is the stored one;
//   - a button under a page stroke's marker still receives its click;
//   - a page stroke under the chat dock stays displayed (z-order covers it);
//     one meeting a displayed iframe is masked around it, 0 px of the mask's
//     painted area inside the iframe, never hidden;
//   - a pane-framed stroke (a paragraph's element record) follows a resize of
//     its paragraph with no re-render, its marker carrying data-el-drift;
//   - with a strokes type armed a press on the .well-wrap beside the column
//     reaches its create; with the comment armed it is the page's; the box
//     grab's gutter drag is refused with its CHROME_HINT;
//   - a box grab's page row (and a page-kind anchor that is no page record)
//     stays undrawn and unlisted;
//   - at 390 px an arrow between stacked items is drawn between them, turned
//     vertical, and a margin stroke is faded and listed;
//   - an arrow with one item removed is drawn faded at its guess and listed
//     by orphans() with kind 'page'; with both removed it is not drawn and is
//     listed; the orphans card shows no Re-anchor… for either.
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
const { readElementJson, validateElement, elementSrcDir } = require('../lib/packs/elements');
const { ROW_KEYS } = require('../lib/server/element-types');
const S = require('../lib/core/strokes');

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const DRAW_SRC = fs.readFileSync(path.join(elementSrcDir(PACK_DIR, TYPE), 'draw.js'), 'utf8');
const SHA = crypto.createHash('sha256').update(DRAW_SRC).digest('hex');
const DRAW_URL = `/api/elements/types/${TYPE}/draw.js?d=${SHA}`;
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');

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

// jsdom has no ResizeObserver: the overlay's are the test's.
const observers = [];
class FakeRO {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}

const PA = { id: 'pa', target: 'main', params: {}, gen: 0, html: '<div class="a"><button class="go" type="button">Go</button><p>Pane A</p></div>' };
const PB = { id: 'pb', target: 'main', params: {}, gen: 0, html: '<p>Pane B</p>' };
const PC = { id: 'pc', target: 'main', params: {}, gen: 0, html: '<p class="para">A paragraph of prose a stroke circles.</p>' };
const MOUNTS = [PA, PB, PC];
const ORDER = ['pa', 'pb', 'pc'];

let shell, W, M, ov, ET, ORPH, anchors;
let records = [];
let approved = false;
const imported = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u614-chrome-'));

// ── the layout model ────────────────────────────────────────────────────────
const TOP = 48;
const geo = { width: {}, height: {}, paraShrink: 0 };   // the test's own resizes
const extra = new Map();   // element → () => rect, for a stub the model does not lay out
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
function rectFor(el) {
  if (extra.has(el)) return extra.get(el)();
  const c = columns();
  if (el.classList && el.classList.contains('well-wrap')) return c.wrap;
  if (el.id === 'main') return c.main;
  const root = el.getRootNode && el.getRootNode();
  if (root && root.nodeType === 11 && root.host) {
    const h = layout().get(root.host);
    if (!h) return null;
    if (el.matches('button.go')) return { left: h.left + 484, top: h.top + 83, width: 40, height: 14 };
    if (el.matches('p.para')) return { left: h.left + 10, top: h.top + 10, width: h.width - 20 - geo.paraShrink, height: 60 };
    return null;
  }
  return layout().get(el) || null;
}
const itemRect = (id) => layout().get(hostOf(id)) || layout().get(W.document.querySelector(`[data-md-id="${id}"]`));
const paraOf = () => rootOf('pc').querySelector('p.para');

// ── the records ─────────────────────────────────────────────────────────────
const FRAME = { w: 1280, h: 3000 };   // the page box at 1,280 px: the well's width, #main's height
let seq = 0;
const toPage = (x, y) => [x / FRAME.w, (y - TOP) / FRAME.h];
function pageStroke(id, from, to, client) {
  const anchor = S.pageRecord({ from, to, frame: FRAME });
  assert.ok(anchor, `${id}: a page record`);
  const points = [];
  client.forEach(([x, y], i) => points.push(...toPage(x, y), 0.5, i * 8));
  return { id, type: TYPE, v: 1, schema: `${TYPE}@1`, seq: ++seq, created_at: new Date(1730000000000 + seq * 10000).toISOString(),
    shared: false, anchor, points, stride: 4, width: 2 / FRAME.w, colour: 'accent', tool: 'pen', aspect: FRAME.w / FRAME.h,
    writer: { class: 'user', owner: 'user', verified: false } };
}
// An end of an item: the endpoint and the client point it is at now.
const endOf = (id, x, y) => { const r = itemRect(id); return { item: id, x, y, w: r.width, h: r.height }; };
const at = (e) => { const r = itemRect(e.item); return [r.left + e.x * r.width, r.top + e.y * r.height]; };
function arc(a, b, lift, n = 5) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - lift * Math.sin(Math.PI * t)]);
  }
  return out;
}
const lean = (r) => ({ id: r.id, v: r.v, type: r.type, schema: r.schema, anchor: r.anchor, shared: r.shared, replies: 0 });
let ARROW1, ARROW2, UNDER, GUTTER, PANEF, GRABLIKE;

// ── reading the layer ───────────────────────────────────────────────────────
const px = (v) => parseFloat(v);
const markerOf = (id) => [...W.document.querySelectorAll('#el-layer .el-marker')]
  .find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const shown = (id) => { const m = markerOf(id); return !!m && m.style.display !== 'none'; };
const boxOfMarker = (m) => ({ left: px(m.style.left), top: px(m.style.top), w: px(m.style.width), h: px(m.style.height) });
// The drawn first and last sample of a page stroke, in client px: its
// record(id) points (the draw's) through its marker's box.
function drawnEnds(id) {
  const m = markerOf(id);
  const rec = ET.recordOf(TYPE, id);
  if (!m || !rec) return null;
  const b = boxOfMarker(m);
  const n = rec.points.length / 4;
  const p = (i) => [b.left + rec.points[i * 4] * b.w, b.top + rec.points[i * 4 + 1] * b.h];
  return { first: p(0), last: p(n - 1) };
}
// Each end within `tol` CSS px of its recorded item-relative position now.
function endsOff(rec) {
  const d = drawnEnds(rec.id);
  if (!d) return Infinity;
  const a = rec.anchor;
  const want0 = at(a.from);
  const wantN = at(a.to);
  return Math.max(Math.hypot(d.first[0] - want0[0], d.first[1] - want0[1]), Math.hypot(d.last[0] - wantN[0], d.last[1] - wantN[1]));
}
// The path the type drew for a stroke is its record(id)'s points now (the
// draw ran again when the mapped shape changed).
function pathIsView(id) {
  const m = markerOf(id);
  const p = m && m.querySelector(`path[data-el-id="${id}"]`);
  const view = ET.recordOf(TYPE, id);
  if (!p || !view) return false;
  const coords = p.getAttribute('d').replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number);
  const want = view.points.filter((_, i) => i % 4 < 2);
  return coords.length === want.length && coords.every((v, i) => v === want[i]);
}
async function endsFollow(rec, label) {
  await waitUntil(() => shown(rec.id) && endsOff(rec) <= 2, { timeout: 5000, what: `${label}: ${rec.id}'s ends on its items` });
  assert.ok(endsOff(rec) <= 2, `${label}: within 2 CSS px (${endsOff(rec)})`);
  assert.ok(pathIsView(rec.id), `${label}: the drawn path is record(id)'s mapped points`);
}
const boxRO = () => observers.find((o) => o !== observers[0] && [...o.targets].length > 0) || null;
function resizeEntry(el) { const r = rectFor(el); return { target: el, contentRect: { width: r.width, height: r.height } }; }

before(async () => {
  globalThis.ResizeObserver = FakeRO;
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => (approved ? { ...BASE_TYPES, types: [...BASE_TYPES.types, LISTING] } : BASE_TYPES),
      [DRAW_URL]: () => respond(DRAW_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
      '/api/elements': (url, init) => {
        if (String((init && init.method) || 'GET').toUpperCase() !== 'GET') return { ok: false, hint: 'not in this test' };
        return { elements: url.includes(`type=${TYPE}`) ? records : [], next_cursor: seq };
      },
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
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  ORPH = await shell.importApp('orphans.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ET.initElementTypes({
    importModule: async (url) => {
      imported.push(url);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`the route answered ${r.status}`);
      const file = path.join(tmp, `draw-${imported.length}.mjs`);
      fs.writeFileSync(file, await r.text());
      return import(pathToFileURL(file).href);
    },
  });
  await shell.frame(helloFrame({ active: 'n1', mounts: MOUNTS, order: ORDER, claude_order: ORDER }));
  await shell.tick();
  approved = true;
  await shell.frame({ type: 'components' });
  await waitUntil(() => ET.typeOf(TYPE), { timeout: 3000, what: 'the scribble listing row' });
  await ET.loadPluginTypes();
  assert.deepStrictEqual(imported, [DRAW_URL], 'the fixture\'s draw.js, imported once');

  // Two arrows from pane A to pane B (one group: sameTarget's page arm), a
  // margin stroke under A, a gutter stroke beside B past the column, a
  // pane-framed stroke on C's paragraph, and a page-kind anchor that is no
  // page record (the box grab's shape).
  const a1f = endOf('pa', 0.6, 0.5);
  const a1t = endOf('pb', 0.4, 0.5);
  ARROW1 = pageStroke('s-arrow1', a1f, a1t, arc(at(a1f), at(a1t), 20));
  const a2f = endOf('pa', 0.9, 0.7);
  const a2t = endOf('pb', 0.1, 0.7);
  ARROW2 = pageStroke('s-arrow2', a2f, a2t, arc(at(a2f), at(a2t), -15));
  const uf = endOf('pa', 0.2, 1.04);
  const ut = endOf('pa', 0.6, 1.04);
  UNDER = pageStroke('s-under', uf, ut, arc(at(uf), at(ut), 3));
  const gB = itemRect('pb');
  const gf = endOf('pb', (1240 - gB.left) / gB.width, 0.3);
  const gt = endOf('pb', (1270 - gB.left) / gB.width, 0.6);
  GUTTER = pageStroke('s-gutter', gf, gt, arc(at(gf), at(gt), 4));
  const para = paraOf();
  const pr = rectFor(para);
  PANEF = { id: 's-panef', type: TYPE, v: 1, schema: `${TYPE}@1`, seq: ++seq, created_at: new Date(1730000900000).toISOString(),
    shared: false, anchor: anchors.record(rootOf('pc'), para, { mount: 'pc' }), points: [0.1, 0.2, 0.5, 0, 0.5, 0.8, 0.5, 8, 0.9, 0.3, 0.5, 16],
    stride: 4, width: 0.01, colour: 'accent', tool: 'pen', aspect: pr.width / pr.height, writer: { class: 'user', owner: 'user', verified: false } };
  assert.equal(S.frameKindOf(PANEF.anchor), 'pane', 'a paragraph\'s element record: a pane frame');
  GRABLIKE = { ...pageStroke('s-grablike', a1f, a1t, arc(at(a1f), at(a1t), 0)),
    anchor: { v: 1, kind: 'page', item: 'pa', mount: 'pa', rect: { x: 4, y: 6, w: 80, h: 40 }, box: { w: 556, h: 200 } } };
  assert.equal(S.isPageRecord(GRABLIKE.anchor), false);
  records = [ARROW1, ARROW2, UNDER, GUTTER, PANEF, GRABLIKE];
  const grabRow = { id: 'g-1', v: 1, type: 'box-grab', schema: 'box-grab@1', shared: true, replies: 0,
    anchor: { v: 1, kind: 'page', item: 'pa', mount: 'pa', rect: { x: 4, y: 6, w: 80, h: 40 }, box: { w: 556, h: 200 },
      scroll: { top: 0, left: 0 }, viewport: { w: 1280, h: 800 } } };
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: MOUNTS, order: ORDER, claude_order: ORDER,
    elements: [...records.map(lean), grabRow] }), type: 'reset' });
  await waitUntil(() => [ARROW1, UNDER, GUTTER, PANEF].every((r) => shown(r.id)), { timeout: 6000, what: 'every stroke drawn' });
});

after(async () => {
  if (ov) ov.setArmed(null);
  if (shell) await shell.restore();
  delete globalThis.ResizeObserver;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an arrow between two panes follows a run re-order, a resize of its host (the ResizeObserver), a re-order and a re-render, each end within 2 CSS px', async () => {
  const m = markerOf(ARROW1.id);
  assert.equal(m, markerOf(ARROW2.id), 'the two arrows between A and B are one group (sameTarget\'s page arm)');
  assert.equal(m.dataset.place, 'box');
  assert.equal(m.dataset.elFrame, 'page');
  assert.equal(m.style.pointerEvents, 'none');
  await endsFollow(ARROW1, 'drawn');
  await endsFollow(ARROW2, 'drawn');
  // The type's draw drew record(id)'s points: the path is the mapped view.
  const pathEl = m.querySelector(`path[data-el-id="${ARROW1.id}"]`);
  const coords = pathEl.getAttribute('d').replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number);
  assert.deepStrictEqual(coords, ET.recordOf(TYPE, ARROW1.id).points.filter((_, i) => i % 4 < 2));
  assert.equal(m.getAttribute(ov.DRIFT_ATTR), '0.000', 'no drift at the recorded layout');

  // Pane A moves: a run re-order (only the panes' CSS order changes).
  const ax0 = itemRect('pa').left;
  await shell.frame({ type: 'page:order', order: ['pb', 'pa', 'pc'], claude_order: ['pb', 'pa', 'pc'] });
  assert.ok(itemRect('pa').left > ax0, 'A moved right');
  await endsFollow(ARROW1, 're-ordered');
  await endsFollow(ARROW2, 're-ordered');

  // A's host resized, nothing else: stale until the box-target observer fires.
  const host = hostOf('pa');
  const ro = boxRO();
  assert.ok(ro && ro.targets.has(host) && ro.targets.has(hostOf('pb')), 'the box-target observer watches both endpoint items');
  assert.ok(!observers[0].targets.has(host), 'apart from the wells\' observer');
  ro.cb([resizeEntry(host)]);   // its first observation: nothing to draw
  await shell.tick(2);
  geo.width.pa = 120;
  await shell.tick(3);
  assert.ok(endsOff(ARROW1) > 2, 'no draw was asked for: the arrow is stale');
  ro.cb([resizeEntry(host)]);
  await endsFollow(ARROW1, 'resized');
  await endsFollow(ARROW2, 'resized');
  assert.ok(Number(m.getAttribute(ov.DRIFT_ATTR)) > 0, 'the drift is reported beside');
  geo.width.pa = 0;
  ro.cb([resizeEntry(host)]);
  await endsFollow(ARROW1, 'resized back');

  // Re-ordered back, then re-rendered taller.
  await shell.frame({ type: 'page:order', order: ORDER, claude_order: ORDER });
  await endsFollow(ARROW1, 're-ordered back');
  geo.height.pa = 260;
  await shell.frame({ type: 'render', ...PA, html: PA.html.replace('Pane A', 'Pane A, re-rendered'), gen: 1 });
  await endsFollow(ARROW1, 're-rendered');
  await endsFollow(ARROW2, 're-rendered');
  delete geo.height.pa;
  await shell.frame({ type: 'render', ...PA, gen: 2 });
  await endsFollow(ARROW1, 'back');
});

test('a margin stroke follows its item after a markdown item is inserted above it; a gutter stroke past the column is drawn', async () => {
  await endsFollow(UNDER, 'drawn');
  await endsFollow(GUTTER, 'drawn');
  const g = markerOf(GUTTER.id);
  assert.ok(boxOfMarker(g).left + boxOfMarker(g).w > columns().main.left + columns().main.width,
    'the gutter stroke lies beyond #main');
  assert.equal(g.style.clipPath, '', 'and is not clipped to the column: the clip starts at the well');
  const top0 = itemRect('pa').top;
  const order = ['md-top', ...ORDER];
  await shell.frame({ type: 'markdown', id: 'md-top', text: '# Above', owner: 'claude', gen: 1, order, claude_order: order });
  assert.ok(itemRect('pa').top > top0, 'A moved down');
  await endsFollow(UNDER, 'after the insert');
  await endsFollow(GUTTER, 'after the insert');
  await endsFollow(ARROW1, 'after the insert');
  await shell.frame({ type: 'markdown:remove', id: 'md-top' });
  await endsFollow(UNDER, 'after the removal');
});

test('record(id) of a page stroke is the flat record mapped into its marker\'s box (reboxPoints of its mapPage points); an element row\'s is the stored record', async () => {
  await endsFollow(ARROW1, 'placed');
  const m = markerOf(ARROW1.id);
  const box = boxOfMarker(m);
  const maps = [ARROW1, ARROW2].map((r) => S.mapPage(r.anchor, r, itemRect(r.anchor.from.item), itemRect(r.anchor.to.item)));
  const x0 = Math.min(...maps.map((p) => p.box.left));
  const y0 = Math.min(...maps.map((p) => p.box.top));
  const x1 = Math.max(...maps.map((p) => p.box.left + p.box.w));
  const y1 = Math.max(...maps.map((p) => p.box.top + p.box.h));
  const union = { left: x0, top: y0, w: x1 - x0, h: y1 - y0 };
  assert.deepStrictEqual(box, union, 'the marker is the union of its members\' mapped boxes');
  for (const [i, r] of [ARROW1, ARROW2].entries()) {
    const view = ET.recordOf(TYPE, r.id);
    assert.notStrictEqual(view, ET.recordOf(TYPE, r.id), 'a fresh object per call');
    assert.ok(Object.isFrozen(view));
    assert.deepStrictEqual(view.points, S.reboxPoints(maps[i].points, maps[i].box, union), `${r.id}: reboxPoints, member box → group box`);
    assert.ok(view.points.filter((_, k) => k % 4 < 2).every((v) => v >= -1e-9 && v <= 1 + 1e-9), `${r.id}: in [0, 1]`);
    assert.ok(Math.abs(view.width - (r.width * FRAME.w) / union.w) < 1e-12, 'the pen\'s px width over the box');
    assert.ok(Math.abs(view.aspect - union.w / union.h) < 1e-12);
    for (const k of ['id', 'v', 'type', 'schema', 'anchor', 'colour', 'tool', 'stride', 'shared']) assert.deepStrictEqual(view[k], r[k], k);
    assert.deepStrictEqual(ET.recordOf(TYPE, r.id, { raw: true }).points, r.points, 'the stored record keeps its page points');
  }
  const el = ET.recordOf(TYPE, PANEF.id);
  assert.strictEqual(el, ET.recordOf(TYPE, PANEF.id, { raw: true }), 'an element row\'s record is the stored record');
  assert.deepStrictEqual(el.points, PANEF.points);
});

test('a button under a page stroke\'s marker still receives its click: the marker takes no press', async () => {
  await endsFollow(ARROW1, 'placed');
  const m = markerOf(ARROW1.id);
  const btn = rootOf('pa').querySelector('button.go');
  const b = rectFor(btn);
  const box = boxOfMarker(m);
  assert.ok(b.left >= box.left && b.left + b.width <= box.left + box.w && b.top >= box.top && b.top + b.height <= box.top + box.h,
    `the button ${JSON.stringify(b)} lies under the marker ${JSON.stringify(box)}`);
  assert.equal(m.style.pointerEvents, 'none');
  let clicks = 0;
  const on = () => { clicks++; };
  btn.addEventListener('click', on);
  try { shell.press(btn); } finally { btn.removeEventListener('click', on); }
  assert.equal(clicks, 1, 'the button got its click');
});

test('a page stroke under the chat dock stays displayed (covered by z-order); one meeting a displayed iframe is masked around it, never hidden', async () => {
  await endsFollow(ARROW1, 'placed');
  const m = markerOf(ARROW1.id);
  const css = createCascade(CSS, { win: () => W });
  const root = W.document.documentElement;
  const dock = W.document.getElementById('chat-dock');
  assert.equal(css.value(W.document.getElementById('el-layer'), 'z-index'), 'var(--z-pins)');
  assert.equal(css.value(dock, 'z-index'), 'var(--z-chat)');
  assert.ok(Number(css.value(root, '--z-pins')) < Number(css.value(root, '--z-chat')), 'the pins rung is under the dock\'s');
  assert.ok(Number(css.value(root, '--z-pins')) < Number(css.value(root, '--z-panel')), 'and under every panel\'s');
  const box = boxOfMarker(m);
  extra.set(dock, () => ({ left: box.left + box.w / 2, top: TOP, width: 600, height: 700 }));
  dock.classList.remove('hidden');
  try {
    ov.requestDraw();
    await shell.tick(3);
    assert.ok(shown(ARROW1.id), 'displayed under the dock');
    assert.ok(!/path\(/.test(m.style.clipPath), 'no mask: the dock is chrome, not a frame');
  } finally { dock.classList.add('hidden'); extra.delete(dock); }

  const before = ov.stats('page').frame_hidden;
  const frame = W.document.createElement('iframe');
  W.document.body.appendChild(frame);
  const f = { left: box.left + box.w / 2 - 30, top: box.top + 2, width: 60, height: box.h + 40 };
  extra.set(frame, () => f);
  try {
    ov.requestDraw();
    await waitUntil(() => /path\(/.test(m.style.clipPath), { timeout: 4000, what: 'the mask' });
    assert.ok(shown(ARROW1.id), 'masked, not hidden');
    assert.equal(ov.stats('page').frame_hidden, before, 'not counted as kept off a frame');
    const local = [...m.style.clipPath.matchAll(/M([-\d.]+) ([-\d.]+)H([-\d.]+)V([-\d.]+)H([-\d.]+)Z/g)]
      .map((x) => ({ left: Number(x[1]), top: Number(x[2]), right: Number(x[3]), bottom: Number(x[4]) }));
    assert.ok(local.length >= 2, 'the painted box cut around the frame');
    const b2 = boxOfMarker(m);
    const fr = { left: f.left - b2.left, top: f.top - b2.top, right: f.left + f.width - b2.left, bottom: f.top + f.height - b2.top };
    const over = (r, q) => Math.max(0, Math.min(r.right, q.right) - Math.max(r.left, q.left)) * Math.max(0, Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top));
    assert.equal(local.reduce((n, r) => n + over(r, fr), 0), 0, '0 px of the mask\'s painted area inside the frame');
    const area = local.reduce((n, r) => n + (r.right - r.left) * (r.bottom - r.top), 0);
    const full = b2.w * b2.h;
    const cut = over({ left: 0, top: 0, right: b2.w, bottom: b2.h }, fr);
    assert.ok(Math.abs(area - (full - cut)) < 0.1, `the rest is painted (${area} vs ${full - cut})`);
  } finally { frame.remove(); extra.delete(frame); }
  ov.requestDraw();
  await waitUntil(() => !/path\(/.test(m.style.clipPath), { timeout: 4000, what: 'the mask gone with the frame' });
});

test('a pane-framed stroke follows a resize of its paragraph with no re-render, and its marker carries data-el-drift', async () => {
  const para = paraOf();
  const m = await waitUntil(() => (shown(PANEF.id) ? markerOf(PANEF.id) : null), { timeout: 4000, what: 'the pane-framed marker' });
  const r0 = rectFor(para);
  assert.deepStrictEqual(boxOfMarker(m), { left: r0.left, top: r0.top, w: r0.width, h: r0.height }, 'the paragraph\'s rect');
  assert.equal(m.getAttribute(ov.DRIFT_ATTR), '0.000');
  const ro = boxRO();
  assert.ok(ro.targets.has(para), 'the box-target observer watches the resolved target');
  ro.cb([resizeEntry(para)]);
  await shell.tick(2);
  geo.paraShrink = 100;
  try {
    await shell.tick(3);
    assert.equal(px(m.style.width), r0.width, 'stale until the observer fires');
    ro.cb([resizeEntry(para)]);
    await waitUntil(() => px(m.style.width) === r0.width - 100, { timeout: 4000, what: 'the marker follows the paragraph' });
    const want = Math.round(Math.abs((r0.width - 100) / r0.height / PANEF.aspect - 1) * 1e3) / 1e3;
    assert.equal(m.getAttribute(ov.DRIFT_ATTR), want.toFixed(3), 'its aspect\'s drift, beside');
    assert.ok(!m.className.includes('drift'), 'never a class');
  } finally { geo.paraShrink = 0; ro.cb([resizeEntry(para)]); }
  await waitUntil(() => px(m.style.width) === r0.width, { timeout: 4000, what: 'back' });
});

function pdown(el, type, pointerType, x, y) {
  const ev = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType, pointerId: 31, isPrimary: true,
    clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0 });
  el.dispatchEvent(ev);
  return ev;
}

test('the well listener: a strokes type\'s press beside the column reaches its create; the comment\'s is the page\'s; the box grab refuses a gutter drag with its hint', async () => {
  const wrap = W.document.querySelector('.well-wrap');
  const created = [];
  const offType = ov.registerType('gutter-probe', { draw() {}, input: 'strokes', create: (input) => created.push(input.phase) });
  const heard = [];
  const hear = (e) => heard.push(e.type);
  W.document.addEventListener('pointerdown', hear);
  try {
    ov.setArmed('gutter-probe');
    pdown(wrap, 'pointerdown', 'pen', 1250, 400);
    pdown(wrap, 'pointerup', 'pen', 1252, 402);
    assert.deepStrictEqual(created, ['pointerdown', 'pointerup'], 'the strokes type\'s create got the gutter press');
    assert.deepStrictEqual(heard, [], 'and the page did not');
    ov.setArmed('comment');
    pdown(wrap, 'pointerdown', 'mouse', 1250, 400);
    pdown(wrap, 'pointerup', 'mouse', 1250, 400);
    assert.deepStrictEqual(heard, ['pointerdown'], 'with the comment armed the gutter press is the page\'s');
    assert.equal(W.document.querySelectorAll('.wc-pin-composer, .pin-composer').length, 0, 'no pin composer');
    // The highlight (a selection tool, never narrowed inside #main) keeps
    // exactly #main's reach too.
    assert.equal(ov.inputKindOf('highlight'), 'selection');
    ov.setArmed('highlight');
    pdown(wrap, 'pointerdown', 'mouse', 1250, 400);
    pdown(wrap, 'pointerup', 'mouse', 1250, 400);
    assert.deepStrictEqual(heard, ['pointerdown', 'pointerdown'], 'with the highlight armed the gutter press is the page\'s');
    ov.setArmed('box-grab');
    const BG = await shell.importApp('box-grab.js');
    pdown(wrap, 'pointerdown', 'mouse', 1240, 300);
    pdown(wrap, 'pointermove', 'mouse', 1260, 340);
    pdown(wrap, 'pointermove', 'mouse', 1272, 380);
    pdown(wrap, 'pointerup', 'mouse', 1272, 380);
    await shell.tick();
    const note = W.document.getElementById('reaim-note');
    assert.ok(note && note.textContent.includes(BG.CHROME_HINT), 'the box grab\'s gutter drag: its CHROME_HINT');
    assert.equal(shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements').length, 0, 'nothing posted');
  } finally {
    ov.setArmed(null);
    offType();
    W.document.removeEventListener('pointerdown', hear);
  }
});

test('a box grab\'s page row, and a page-kind anchor that is no page record, stay undrawn and unlisted', async () => {
  await endsFollow(ARROW1, 'placed');
  assert.equal(markerOf('g-1'), null, 'the box grab\'s page row: no marker');
  assert.equal(markerOf(GRABLIKE.id), null, 'a page-kind anchor isPageRecord refuses: no marker');
  assert.ok(!ov.orphans().some((o) => o.id === 'g-1' || o.id === GRABLIKE.id), 'never listed');
  assert.ok(ov.elementsOf('live').some((r) => r.id === 'g-1'), 'the row is kept');
});

test('at 390 px an arrow between stacked items is drawn between them, turned vertical; a margin stroke is faded and listed', async () => {
  shell.setViewport({ width: 390, height: 844, coarse: true });
  try {
    await waitUntil(() => itemRect('pb').top > itemRect('pa').top + 100, { timeout: 3000, what: 'stacked' });
    await endsFollow(ARROW1, 'at 390 px');
    const d = drawnEnds(ARROW1.id);
    assert.ok(Math.abs(d.last[1] - d.first[1]) > Math.abs(d.last[0] - d.first[0]), 'turned vertical');
    await waitUntil(() => ov.orphans().some((o) => o.id === UNDER.id), { timeout: 4000, what: 'the margin stroke listed' });
    const o = ov.orphans().find((x) => x.id === UNDER.id);
    assert.deepStrictEqual({ kind: o.kind, mount: o.mount, guess: o.guess, how: o.how }, { kind: 'page', mount: 'pa', guess: true, how: 'page-narrow' });
    await waitUntil(() => shown(UNDER.id) && markerOf(UNDER.id).classList.contains('el-guess'), { timeout: 4000, what: 'drawn at its guess' });
    const mu = markerOf(UNDER.id);
    assert.equal(mu.querySelector('svg').getAttribute('opacity'), '0.4', 'the type draws it faded');
    assert.ok(ov.orphans().some((x) => x.id === GUTTER.id && x.how === 'page-narrow'), 'every margin stroke, listed');
    assert.ok(!ov.orphans().some((x) => x.id === ARROW1.id), 'the arrow is no orphan');
  } finally {
    shell.setViewport({ width: 1280, height: 800, coarse: false });
  }
  await waitUntil(() => !ov.orphans().some((o) => o.id === UNDER.id), { timeout: 4000, what: 'unlisted on the desktop' });
  await waitUntil(() => markerOf(UNDER.id) && markerOf(UNDER.id).classList.contains('el-hit'), { timeout: 4000, what: 'no longer faded' });
  await endsFollow(UNDER, 'back on the desktop');
});

test('an arrow with one item removed is drawn faded at its guess and listed with kind \'page\'; with both removed it is not drawn and is listed; no Re-anchor… for either', async () => {
  await endsFollow(ARROW1, 'placed');
  await shell.frame({ type: 'clear', id: 'pb' });
  await waitUntil(() => ov.orphans().some((o) => o.id === ARROW1.id), { timeout: 4000, what: 'the arrow listed' });
  const o = ov.orphans().find((x) => x.id === ARROW1.id);
  assert.deepStrictEqual({ kind: o.kind, mount: o.mount, guess: o.guess, how: o.how }, { kind: 'page', mount: 'pa', guess: true, how: 'page-guess' });
  await waitUntil(() => shown(ARROW1.id) && markerOf(ARROW1.id).classList.contains('el-guess'), { timeout: 4000, what: 'drawn at its guess' });
  const m = markerOf(ARROW1.id);
  assert.equal(m.querySelector('svg').getAttribute('opacity'), '0.4', 'faded');
  const d = drawnEnds(ARROW1.id);
  const want = at(ARROW1.anchor.from);
  assert.ok(Math.hypot(d.first[0] - want[0], d.first[1] - want[1]) <= 2, 'its guess follows the item that is left');
  const g = ov.orphans().find((x) => x.id === GUTTER.id);
  assert.deepStrictEqual({ kind: g.kind, guess: g.guess, how: g.how }, { kind: 'page', guess: false, how: 'page-gone' }, 'a margin stroke beside B: gone');
  assert.equal(markerOf(GUTTER.id), null, 'never drawn at a stale position');

  await shell.frame({ type: 'clear', id: 'pa' });
  await waitUntil(() => !markerOf(ARROW1.id), { timeout: 4000, what: 'the arrow undrawn' });
  const o2 = ov.orphans().find((x) => x.id === ARROW1.id);
  assert.deepStrictEqual({ kind: o2.kind, mount: o2.mount, guess: o2.guess, how: o2.how }, { kind: 'page', mount: 'pa', guess: false, how: 'page-gone' });
  assert.equal(ET.recordOf(TYPE, ARROW1.id), null, 'record(id) is null while unplaced');

  const pop = ORPH.openOrphanList();
  try {
    for (const r of [ARROW1, ARROW2, UNDER, GUTTER]) {
      const row = pop.querySelector(`.wc-orphan-row[data-el-id="${r.id}"]`);
      assert.ok(row, `${r.id} listed in the card`);
      assert.equal(row.querySelector('.wc-orphan-act'), null, `${r.id}: no Re-anchor…`);
    }
    assert.match(pop.querySelector(`.wc-orphan-row[data-el-id="${ARROW1.id}"] .wc-orphan-place`).textContent, /from pa to pb/);
  } finally { pop.remove(); }
});

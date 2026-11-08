// Tranche 5 end to end in the real chrome (U690; the twin of
// test/elements-e2e-t5.test.js): test-support/chrome-shell booted ONCE in a
// before() hook, the checked-in strokes fixture's `scribble` type loaded
// through the loader's importer seam (its real draw.js), its rows through the
// hello and reset frames, its records through GET /api/elements. jsdom does no
// layout, so the test owns it: the layout model of
// test/overlay-page-strokes-chrome.test.js (U614) — each run's panes in their
// CSS order, two per row on a desktop, stacked below 760 px — answers
// getBoundingClientRect, and a ResizeObserver stand-in is put on globalThis
// before the boot. U627's test/elements-e2e-t5a-chrome.test.js is 5A's own
// chrome end to end and stays as it is.
//
// The steps:
//   (1) U631 — a comment glyph dragged far off its pane stops at the pane's
//       edge (the clip it was last drawn in), one POST; a drop over a displayed
//       frame writes nothing and says overlay:glyph-refused on the bus; a page
//       stroke's marker has no detachable glyph (U614 gave box groups none;
//       U631's reading) and its marker clips to the well (AU8 provisional);
//   (2) U632 — a type's draw that writes an <image href>, an on* attribute and
//       an open shadow root holding an <img> has them removed and the draw
//       counted and named; the draw ctx carries no layer; the fixture strokes
//       type still draws into group.container (B1);
//   (3) U635 — a burst of stream-only mirror changes asks at most one chat-pin
//       GET per interval (initChatPins' rereadMinMs seam), a hello one plus at
//       most its hydrate's trailing re-read (K.2-187's 1..3);
//   (4) 5A's chrome spine after 5B's overlay edits — the arrow follows a run
//       re-order, a resize of its host and a re-render within 2 CSS px
//       (ARROW@tolerance), the margin stroke follows its item, at 390 px the
//       arrow turns vertical and the margin stroke is faded and listed
//       (REQ@page-stroke-phone a), a control under a page stroke still clicks
//       (CONTROL@refused), a page stroke is masked around a displayed frame
//       (PAGE@mask-frames), the wet canvas on a page target never over
//       viewport × dpr (WET@clip-viewport);
//   (5) U629 (H2 = b) — at 390 px a SHARED 'beside' group with a ready
//       picture is one pin and a tap opens the pair (GET …/picture and
//       ?which=without); a private group keeps the faded guess;
//   (6) no script-error reached the daemon, and no interval the shell tracks
//       was left armed (setTimeouts are tracked by the shell and cleared at
//       restore; the chat pins' trailing timer is cleared by stopChatPins).
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
const S = require('../lib/core/strokes');

const PACK_DIR = path.join(__dirname, '..', 'test-support', 'element-packs', 'strokes-fixture');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const DRAW_SRC = fs.readFileSync(path.join(elementSrcDir(PACK_DIR, TYPE), 'draw.js'), 'utf8');
const SHA = crypto.createHash('sha256').update(DRAW_SRC).digest('hex');
const DRAW_URL = `/api/elements/types/${TYPE}/draw.js?d=${SHA}`;

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

const observers = [];
class FakeRO {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
  observe(el) { this.targets.add(el); }
  unobserve(el) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
}

const PA = { id: 'pa', target: 'main', params: {}, gen: 0, html: '<div class="a"><button class="go" type="button">Go</button><p>Pane A</p></div>' };
const PB = { id: 'pb', target: 'main', params: {}, gen: 0, html: '<p>Pane B</p>' };
const PC = { id: 'pc', target: 'main', params: {}, gen: 0, html: '<p class="para">A paragraph of prose a comment pins.</p>' };
const MOUNTS = [PA, PB, PC];
const ORDER = ['pa', 'pb', 'pc'];

let shell, W, M, ov, ET, ORPH, anchors, bus, CP, wet;
let records = [];
let comments = [];
let chatPins = [];
let chatGets = 0;
const chatTimes = [];
let approved = false;
let intervalsAtBoot = 0;
const imported = [];
const moves = [];
const ready = new Set();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u690-chrome-'));

// ── the layout model (U614's, test/overlay-page-strokes-chrome.test.js) ────
const TOP = 48;
const geo = { width: {}, height: {} };
const extra = new Map();
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
    if (el.matches('p.para')) return { left: h.left + 10, top: h.top + 10, width: h.width - 20, height: 60 };
    return null;
  }
  return layout().get(el) || null;
}
const itemRect = (id) => layout().get(hostOf(id)) || layout().get(W.document.querySelector(`[data-md-id="${id}"]`));

// ── the records ─────────────────────────────────────────────────────────────
const FRAME = { w: 1280, h: 3000 };
let seq = 0;
const toPage = (x, y) => [x / FRAME.w, (y - TOP) / FRAME.h];
function pageStroke(id, from, to, client, shared = false) {
  const anchor = S.pageRecord({ from, to, frame: FRAME });
  assert.ok(anchor, `${id}: a page record`);
  const points = [];
  client.forEach(([x, y], i) => points.push(...toPage(x, y), 0.5, i * 8));
  return { id, type: TYPE, v: 1, schema: `${TYPE}@1`, seq: ++seq, created_at: new Date(1730000000000 + seq * 10000).toISOString(),
    shared, anchor, points, stride: 4, width: 2 / FRAME.w, colour: 'accent', tool: 'pen', aspect: FRAME.w / FRAME.h,
    writer: { class: 'user', owner: 'user', verified: false } };
}
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
let ARROW, UNDER, SHARE, PIN;

// ── reading the layer ───────────────────────────────────────────────────────
const px = (v) => parseFloat(v);
const markersFor = (id) => [...W.document.querySelectorAll('#el-layer .el-marker')].filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const markerOf = (id) => markersFor(id)[0] || null;
const shown = (id) => { const m = markerOf(id); return !!m && m.style.display !== 'none'; };
const boxOfMarker = (m) => ({ left: px(m.style.left), top: px(m.style.top), w: px(m.style.width), h: px(m.style.height) });
const pinOf = (id) => [...W.document.querySelectorAll('#el-layer .el-marker[data-el-pin]')]
  .find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
function drawnEnds(id) {
  const m = markerOf(id);
  const rec = ET.recordOf(TYPE, id);
  if (!m || !rec) return null;
  const b = boxOfMarker(m);
  const n = rec.points.length / 4;
  const p = (i) => [b.left + rec.points[i * 4] * b.w, b.top + rec.points[i * 4 + 1] * b.h];
  return { first: p(0), last: p(n - 1) };
}
function endsOff(rec) {
  const d = drawnEnds(rec.id);
  if (!d) return Infinity;
  const want0 = at(rec.anchor.from);
  const wantN = at(rec.anchor.to);
  return Math.max(Math.hypot(d.first[0] - want0[0], d.first[1] - want0[1]), Math.hypot(d.last[0] - wantN[0], d.last[1] - wantN[1]));
}
async function endsFollow(rec, label) {
  await waitUntil(() => shown(rec.id) && endsOff(rec) <= 2, { timeout: 5000, what: `${label}: ${rec.id}'s ends on its items` });
  assert.ok(endsOff(rec) <= 2, `${label}: within 2 CSS px (${endsOff(rec)})`);
}
const boxRO = () => observers.find((o) => o !== observers[0] && [...o.targets].length > 0) || null;
function resizeEntry(el) { const r = rectFor(el); return { target: el, contentRect: { width: r.width, height: r.height } }; }
async function atPhone(fn) {
  shell.setViewport({ width: 390, height: 844, coarse: true });
  try {
    await waitUntil(() => itemRect('pb').top > itemRect('pa').top + 100, { timeout: 3000, what: 'stacked' });
    await fn();
  } finally {
    shell.setViewport({ width: 1280, height: 800, coarse: false });
  }
}
function pe(el, type, pointerType, pointerId, x, y) {
  const ev = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true,
    clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0 });
  el.dispatchEvent(ev);
  return ev;
}
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await shell.tick(20); };

// The routes: the elements by type (the chat pins counted), a glyph POST
// recorded and answered, a picture answered as a PNG when ready.
const PNG = () => respond('\x89PNG\r\n\x1a\n', { headers: { 'content-type': 'image/png' } });
function elementsRoute(url, init) {
  if (String((init && init.method) || 'GET').toUpperCase() !== 'GET') return { ok: false, hint: 'not in this test' };
  const type = new URL(url, 'http://x').searchParams.get('type');
  if (type === 'chat-comment') {
    chatGets++;
    chatTimes.push(performance.now());
    return { elements: chatPins, next_cursor: seq };
  }
  if (type === 'comment') return { elements: comments, next_cursor: seq };
  return { elements: type === TYPE ? records : [], next_cursor: seq };
}
function elementRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const u = new URL(url, 'http://x');
  const parts = u.pathname.split('/');
  const last = parts[parts.length - 1];
  const id = decodeURIComponent(parts[parts.length - 2]);
  if (method === 'POST' && last === 'glyph') {
    const body = JSON.parse(init.body);
    moves.push({ id, body });
    const display = { glyph: { dx: body.dx, dy: body.dy, corner: body.corner } };
    return { ok: true, id, type: 'comment', v: 2, display };
  }
  if (method === 'GET' && last === 'picture') {
    return ready.has(id) ? PNG() : respond({ error: 'no picture', id, image: { state: 'none' } }, { status: 404 });
  }
  return { ok: true };
}

const MIRROR = {
  v: 1, enabled: true, now: 1730000000000, rev: 2, content: true, access: { level: 'local', remote: false },
  capabilities: {}, primary: 'cU', aggregate: { state: 'idle' },
  conversations: [{ id: 'cU', rev: 1, headless: false, counts: { shells: 0, agents: 0, workflows: 0, monitors: 0 },
    live: { state: 'idle', since: 1730000000000, last_activity_at: 1730000000000 } }],
  tasks: [], asks: [],
};
const contexts = [];
function stubContext(canvasEl) {
  const calls = [];
  const c = { canvas: canvasEl, calls };
  for (const k of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'drawImage']) c[k] = (...a) => calls.push([k, ...a]);
  contexts.push(c);
  return c;
}
const setDpr = (v) => Object.defineProperty(W, 'devicePixelRatio', { value: v, configurable: true, writable: true });

before(async () => {
  globalThis.ResizeObserver = FakeRO;
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => (approved ? { ...BASE_TYPES, types: [...BASE_TYPES.types, LISTING] } : BASE_TYPES),
      [DRAW_URL]: () => respond(DRAW_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
      '/api/elements': elementsRoute,
      '/api/elements/*': elementRoute,
      // The chat's mirror at the local level (test/overlay-element-reach-chrome's
      // shape): the chat pins read only at read and above.
      '/api/mirror': () => MIRROR,
      '/api/mirror/conversations/*': () => ({ conversation_id: 'cU', turns: [], next_before: null, total: 0, rev: 3 }),
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
  CP = await shell.importApp('chat-pins.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ({ bus } = await shell.importApp('bus.js'));
  wet = (await shell.importApp('wet-layer.js')).initWetLayer();
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

  // An arrow from pane A to pane B and a margin stroke under A (private), a
  // SHARED margin stroke under C with a ready picture, and a comment on C's
  // paragraph (its glyph detachable).
  const af = endOf('pa', 0.6, 0.5);
  const aT = endOf('pb', 0.4, 0.5);
  ARROW = pageStroke('s-arrow', af, aT, arc(at(af), at(aT), 20));
  const uf = endOf('pa', 0.2, 1.04);
  const ut = endOf('pa', 0.6, 1.04);
  UNDER = pageStroke('s-under', uf, ut, arc(at(uf), at(ut), 3));
  const sf = endOf('pc', 0.2, 1.05);
  const st = endOf('pc', 0.7, 1.05);
  SHARE = pageStroke('s-share', sf, st, arc(at(sf), at(st), 3), true);
  ready.add(SHARE.id);
  records = [ARROW, UNDER, SHARE];
  const para = rootOf('pc').querySelector('p.para');
  PIN = { id: 'c-u690', v: 1, seq: ++seq, type: 'comment', schema: 'comment@1', text: 'a pin on C', shared: true, replies: [],
    anchor: anchors.record(rootOf('pc'), para, { mount: 'pc' }), locator: { mount: 'pc', selector: 'p.para', text: para.textContent.trim(), ordinal: 0 } };
  comments = [PIN];
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: MOUNTS, order: ORDER, claude_order: ORDER,
    elements: [...records.map(lean), { ...lean(PIN), replies: 0 }] }), type: 'reset' });
  await waitUntil(() => [ARROW, UNDER, SHARE].every((r) => shown(r.id)) && markerOf(PIN.id), { timeout: 6000, what: 'every stroke and the pin drawn' });
  intervalsAtBoot = shell.intervals().length;
});

after(async () => {
  try { if (ov) ov.setArmed(null); } catch {}
  if (shell) await shell.restore();
  delete globalThis.ResizeObserver;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── (1) U631 ────────────────────────────────────────────────────────────────

test('(1) U631: a comment glyph dragged far off its pane stops at the pane\'s edge (one POST); a drop over a displayed frame writes nothing and says overlay:glyph-refused; a page stroke\'s marker has no detachable glyph and clips to the well', async () => {
  // A pane clips its content, as app.css's .mount-host does (overflow auto;
  // jsdom loads no stylesheet): the comment's clip is its pane.
  hostOf('pc').style.overflow = 'auto';
  ov.requestDraw();
  await settle();
  const m = await waitUntil(() => { const x = markerOf(PIN.id); return x && x.style.display !== 'none' ? x : null; }, { timeout: 4000, what: 'the pin drawn' });
  assert.equal(m.dataset.detach, '1', 'the comment\'s glyph is detachable');
  const pane = itemRect('pc');
  const painted = (mk) => {
    const t = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(mk.style.transform);
    const x = px(mk.style.left) + Number(t[1]);
    const y = px(mk.style.top) + Number(t[2]);
    return { left: x, top: y, right: x + 26, bottom: y + 26 };
  };
  const inPane = (p) => p.left >= pane.left - 0.5 && p.top >= pane.top - 0.5 && p.right <= pane.left + pane.width + 0.5 && p.bottom <= pane.top + pane.height + 0.5;
  const x0 = px(m.style.left);
  const y0 = px(m.style.top);
  moves.length = 0;
  pe(m, 'pointerdown', 'mouse', 41, x0, y0);
  pe(m, 'pointermove', 'mouse', 41, x0 + 2000, y0 + 2000);
  await settle();
  pe(m, 'pointermove', 'mouse', 41, x0 + 4000, y0 + 4000);
  await settle();
  pe(m, 'pointerup', 'mouse', 41, x0 + 4000, y0 + 4000);
  m.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 41 }));
  await settle(6);
  assert.equal(moves.length, 1, `one POST: ${JSON.stringify(moves)}`);
  assert.equal(moves[0].id, PIN.id);
  // Drawn at the clamped offset: the glyph inside its pane (the clip it was last drawn in).
  const dx = moves[0].body.dx;
  const dy = moves[0].body.dy;
  assert.ok(Math.abs(dx) < 4000 && Math.abs(dy) < 4000, 'the offset was clamped');
  comments = [{ ...PIN, v: 2, display: { glyph: { dx, dy, corner: moves[0].body.corner } } }];
  await shell.frame({ type: 'element:comment', elements: comments });
  await waitUntil(() => { const x = markerOf(PIN.id); return x && x.style.display !== 'none' && inPane(painted(x)); }, { timeout: 4000, what: 'drawn at the clamped drop, inside the pane' });

  // A drop over a displayed frame: refused, nothing written, said on the bus.
  const mk = markerOf(PIN.id);
  const p = painted(mk);
  const frame = W.document.createElement('iframe');
  W.document.body.appendChild(frame);
  extra.set(frame, () => ({ left: pane.left + 20, top: pane.top + 20, width: 120, height: 120 }));
  const heard = [];
  const off = bus.on('overlay:glyph-refused', (d) => heard.push(d));
  try {
    ov.requestDraw();
    await settle();
    moves.length = 0;
    const tx = pane.left + 80 - (p.left - px(mk.style.left));
    const ty = pane.top + 80 - (p.top - px(mk.style.top));
    const sx = px(mk.style.left);
    const sy = px(mk.style.top);
    pe(mk, 'pointerdown', 'mouse', 42, sx, sy);
    pe(mk, 'pointermove', 'mouse', 42, (sx + tx) / 2, (sy + ty) / 2);
    await settle();
    pe(mk, 'pointermove', 'mouse', 42, tx, ty);
    await settle();
    pe(mk, 'pointerup', 'mouse', 42, tx, ty);
    mk.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 42 }));
    await settle(6);
    assert.equal(moves.length, 0, 'nothing written');
    assert.deepStrictEqual(heard, [{ id: PIN.id, hint: ov.GLYPH_DROP_HINT }], 'overlay:glyph-refused, once');
  } finally {
    off();
    frame.remove();
    extra.delete(frame);
    ov.requestDraw();
    await settle();
  }
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // A page stroke's marker: no detachable glyph (U614 gives box groups none);
  // its clip is the well, never a pane.
  const a = markerOf(ARROW.id);
  assert.equal(a.dataset.place, 'box');
  assert.equal(a.dataset.detach, undefined, 'no glyph to drag');
  assert.equal(a.style.clipPath, '', 'wholly inside the well: no clip');
});

// ── (2) U632 ────────────────────────────────────────────────────────────────

test('(2) U632: a draw that writes an <image href>, an on* attribute and an open shadow root\'s <img> has them removed and the draw counted and named; the draw ctx has no layer; the fixture strokes type draws into group.container', async () => {
  const SVG = 'http://www.w3.org/2000/svg';
  const seenCtx = [];
  const warned = [];
  const realWarn = W.console.warn;
  const realNodeWarn = console.warn;
  const hear = (...a) => warned.push(a.map(String).join(' '));
  W.console.warn = hear;
  console.warn = hear;
  const offType = ov.registerType('u690-reach', {
    draw(g, ctx) {
      seenCtx.push(ctx);
      const doc = g.container.ownerDocument;
      const svg = doc.createElementNS(SVG, 'svg');
      const keep = doc.createElementNS(SVG, 'path');
      keep.setAttribute('class', 'keep');
      keep.setAttribute('d', 'M0 0 L26 26');
      keep.setAttribute('onclick', 'alert(1)');
      const img = doc.createElementNS(SVG, 'image');
      img.setAttribute('href', 'http://127.0.0.1:9/u690.png');
      svg.append(keep, img);
      const span = doc.createElement('span');
      const sr = span.attachShadow({ mode: 'open' });
      const leak = doc.createElement('img');
      leak.setAttribute('src', 'http://127.0.0.1:9/u690-shadow.png');
      sr.appendChild(leak);
      g.container.replaceChildren(svg, span);
    },
  });
  const n0 = ov.stats().dom_refused;
  const row = { id: 'r-u690', v: 1, type: 'u690-reach', schema: 'u690-reach@1', shared: true, anchor: PIN.anchor };
  try {
    ov.upsertElements('live', [row]);
    const m = await waitUntil(() => (seenCtx.length ? markerOf(row.id) : null), { timeout: 5000, what: 'the reach marker drawn' });
    await settle();
    assert.ok(m.querySelector('path.keep'), 'the kept path stays drawn');
    assert.equal(m.querySelector('path.keep').getAttribute('onclick'), null, 'its on* attribute removed');
    assert.equal(m.getElementsByTagName('image').length, 0, 'the <image href> removed');
    const span = m.querySelector('span');
    assert.ok(!span || !span.shadowRoot || !span.shadowRoot.querySelector('img'), 'the open shadow root\'s <img> removed');
    assert.ok(ov.stats().dom_refused - n0 >= 3, `counted (${ov.stats().dom_refused - n0})`);
    assert.ok(warned.some((w) => w.includes("'u690-reach'") && /marker allowlist/.test(w)), `the type named: ${JSON.stringify(warned)}`);
    assert.ok(seenCtx.every((c) => !('layer' in c)), 'ctx.layer withdrawn (CHROME@csp a)');
  } finally {
    W.console.warn = realWarn;
    console.warn = realNodeWarn;
    ov.removeElements('live', [row.id]);
    offType();
    await settle();
  }
  // B1: the fixture strokes type's draw still lands in group.container.
  const a = markerOf(ARROW.id);
  assert.ok(a.querySelector(`svg path[data-el-id="${ARROW.id}"]`), 'the arrow\'s path in its container');
  assert.equal(ov.allowlistWalk(a, a.getAttribute('style') || ''), 0, 'the fixture\'s marker passes the walk');
});

// ── (3) U635 ────────────────────────────────────────────────────────────────

test('(3) U635: a burst of stream-only mirror changes asks at most one chat-pin GET per interval; a hello one GET plus at most its hydrate\'s trailing re-read (1..3, K.2-187)', async () => {
  assert.equal(CP.REREAD_MIN_MS, 1000);
  const S2 = await shell.importApp('chat-state.js');
  await waitUntil(() => S2.mirror.availability === 'ok', { timeout: 5000, what: 'the mirror snapshot' });
  S2.followConversation('cU');
  chatPins = [{ id: 'k-u690', v: 1, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, replies: [], text: 'a chat pin',
    anchor: { v: 1, kind: 'turn', conversation_id: 'cU', session_id: 's1', turn_id: 't1', quote: { exact: 'q', prefix: '', suffix: '' } },
    state: 'unavailable' }];
  const MS = 120;
  CP.stopChatPins();
  const n0 = chatGets;
  CP.initChatPins({ rereadMinMs: MS });
  await waitUntil(() => chatGets > n0, { timeout: 4000, what: `the chat pins read at init (level ${S2.mirror.access && S2.mirror.access.level})` });
  await settle();
  const intervals = shell.intervals().length;
  await new Promise((r) => setTimeout(r, MS + 20));
  const from = chatTimes.length;
  const t0 = performance.now();
  let last = t0;
  for (let i = 0; i < 16; i++) {
    bus.emit('mirror', { what: ['stream'] });
    last = performance.now();
    await new Promise((r) => setTimeout(r, 15));
  }
  await waitUntil(() => chatTimes.length > from && chatTimes[chatTimes.length - 1] >= last, { timeout: 3000, what: 'the trailing read after the burst' });
  await new Promise((r) => setTimeout(r, MS * 2));
  const times = chatTimes.slice(from);
  assert.ok(times.length >= 1 && times.length <= Math.ceil((last - t0) / MS) + 2, `at most one GET per interval: ${times.length} over ${Math.round(last - t0)} ms`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= MS - 10, `GET ${i} ${Math.round(times[i] - times[i - 1])} ms after the one before`);
  assert.equal(shell.intervals().length, intervals, 'no interval added');
  // A hello: one GET at once, plus at most its hydrate's trailing re-read.
  const h0 = chatGets;
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: MOUNTS, order: ORDER, claude_order: ORDER, elements: [...records.map(lean), { ...lean(comments[0]), replies: 0 }] }) });
  await new Promise((r) => setTimeout(r, MS * 3));
  assert.ok(chatGets - h0 >= 1 && chatGets - h0 <= 3, `a hello: ${chatGets - h0} GET(s) (1..3)`);
  // Back to the shipped interval, the trailing timer cleared.
  CP.stopChatPins();
  chatPins = [];
  CP.initChatPins();
  await settle();
  await waitUntil(() => [ARROW, UNDER, SHARE].every((r) => shown(r.id)), { timeout: 5000, what: 'the strokes after the hello' });
});

// ── (4) 5A's chrome spine after 5B ──────────────────────────────────────────

test('(4) 5A\'s spine after 5B\'s overlay edits: the arrow follows a re-order, a host resize and a re-render within 2 CSS px; the margin stroke follows its item; at 390 px the arrow is vertical and the margin stroke faded and listed; a control under it clicks; masked around a frame; the wet canvas within viewport × dpr', async () => {
  await endsFollow(ARROW, 'drawn');
  await endsFollow(UNDER, 'drawn');
  // A run re-order.
  const ax0 = itemRect('pa').left;
  await shell.frame({ type: 'page:order', order: ['pb', 'pa', 'pc'], claude_order: ['pb', 'pa', 'pc'] });
  assert.ok(itemRect('pa').left > ax0, 'A moved right');
  await endsFollow(ARROW, 're-ordered');
  await endsFollow(UNDER, 're-ordered: the margin stroke follows its item');
  await shell.frame({ type: 'page:order', order: ORDER, claude_order: ORDER });
  await endsFollow(ARROW, 're-ordered back');
  // A's host resized: the box-target observer.
  const host = hostOf('pa');
  const ro = boxRO();
  assert.ok(ro && ro.targets.has(host), 'the box-target observer watches the endpoint item');
  ro.cb([resizeEntry(host)]);
  await shell.tick(2);
  geo.width.pa = 120;
  ro.cb([resizeEntry(host)]);
  await endsFollow(ARROW, 'resized');
  assert.ok(Number(markerOf(ARROW.id).getAttribute(ov.DRIFT_ATTR)) > 0, 'the drift reported beside');
  geo.width.pa = 0;
  ro.cb([resizeEntry(host)]);
  await endsFollow(ARROW, 'resized back');
  // A re-render taller.
  geo.height.pa = 260;
  await shell.frame({ type: 'render', ...PA, html: PA.html.replace('Pane A', 'Pane A again'), gen: 1 });
  await endsFollow(ARROW, 're-rendered');
  delete geo.height.pa;
  await shell.frame({ type: 'render', ...PA, gen: 2 });
  await endsFollow(ARROW, 'back');

  // CONTROL@refused: a button under the arrow's marker takes its click.
  const btn = rootOf('pa').querySelector('button.go');
  const b = rectFor(btn);
  const box = boxOfMarker(markerOf(ARROW.id));
  assert.ok(b.left >= box.left && b.left + b.width <= box.left + box.w && b.top >= box.top && b.top + b.height <= box.top + box.h, 'the button lies under the marker');
  let clicks = 0;
  const on = () => { clicks++; };
  btn.addEventListener('click', on);
  try { shell.press(btn); } finally { btn.removeEventListener('click', on); }
  assert.equal(clicks, 1, 'the button got its click');

  // PAGE@mask-frames: masked around a displayed iframe, never hidden.
  const m = markerOf(ARROW.id);
  const frame = W.document.createElement('iframe');
  W.document.body.appendChild(frame);
  extra.set(frame, () => ({ left: box.left + box.w / 2 - 30, top: box.top + 2, width: 60, height: box.h + 40 }));
  try {
    ov.requestDraw();
    await waitUntil(() => /path\(/.test(m.style.clipPath), { timeout: 4000, what: 'the mask' });
    assert.ok(shown(ARROW.id), 'masked, not hidden');
  } finally { frame.remove(); extra.delete(frame); }
  ov.requestDraw();
  await waitUntil(() => !/path\(/.test(m.style.clipPath), { timeout: 4000, what: 'the mask gone with the frame' });

  // REQ@page-stroke-phone a: at 390 px.
  await atPhone(async () => {
    await endsFollow(ARROW, 'at 390 px');
    const d = drawnEnds(ARROW.id);
    assert.ok(Math.abs(d.last[1] - d.first[1]) > Math.abs(d.last[0] - d.first[0]), 'turned vertical');
    await waitUntil(() => shown(UNDER.id) && markerOf(UNDER.id).classList.contains('el-guess'), { timeout: 4000, what: 'the margin stroke faded' });
    const o = ov.orphans().find((x) => x.id === UNDER.id);
    assert.deepStrictEqual(o && { kind: o.kind, guess: o.guess, how: o.how }, { kind: 'page', guess: true, how: 'page-narrow' }, 'listed');
  });
  await waitUntil(() => markerOf(UNDER.id) && markerOf(UNDER.id).classList.contains('el-hit'), { timeout: 4000, what: 'no longer faded on the desktop' });

  // WET@clip-viewport: the wet canvas on a page target (#main, 3,000 px tall).
  const main = W.document.getElementById('main');
  setDpr(2);
  try {
    const tok = wet.begin(main, { pointerId: 91 });
    assert.ok(Number.isInteger(tok) && tok > 0, 'a token');
    wet.push([{ clientX: 300, clientY: 300, pressure: 0.5, timeStamp: 1 }, { clientX: 340, clientY: 330, pressure: 0.5, timeStamp: 2 }]);
    wet.paint((g, v) => { v.clear(); g.beginPath(); for (let i = 0; i < v.count; i++) g.lineTo(v.x(i), v.y(i)); g.stroke(); });
    await shell.tick();
    const c = [...W.document.querySelectorAll('canvas.el-wet')].find((x) => x.isConnected);
    assert.ok(c, 'the wet canvas begun');
    assert.ok(c.width <= W.innerWidth * 2 && c.height <= W.innerHeight * 2, `${c.width} × ${c.height}: never over the viewport × dpr`);
    assert.equal(wet.end(tok), true);
    await waitUntil(() => ![...W.document.querySelectorAll('canvas.el-wet')].some((x) => x.isConnected) && wet.stats().held === 0, { timeout: 3000, what: 'dried' });
  } finally { setDpr(1); }
});

// ── (5) U629 ────────────────────────────────────────────────────────────────

test('(5) U629: at 390 px a shared \'beside\' group with a ready picture is one pin and a tap opens the pair (GET …/picture and ?which=without); a private group keeps the faded guess', async () => {
  const pic = (id, which) => `/api/elements/${id}/picture${which === 'without' ? '?which=without' : ''}`;
  await atPhone(async () => {
    await waitUntil(() => pinOf(SHARE.id) && shown(SHARE.id), { timeout: 5000, what: 'the pin' });
    const m = pinOf(SHARE.id);
    assert.ok(m.classList.contains('pin-marker'), 'the pin\'s look');
    assert.equal(m.dataset.place, undefined, 'no box marker');
    assert.equal(markersFor(SHARE.id).length, 1, 'one marker');
    const tapAt = shell.calls.length;
    shell.press(m);
    await waitUntil(() => W.document.querySelector(`.popover.bg-look[data-element="${SHARE.id}"]`), { timeout: 3000, what: 'the pair open' });
    const pop = W.document.querySelector(`.popover.bg-look[data-element="${SHARE.id}"]`);
    assert.deepStrictEqual([...pop.querySelectorAll('img.bg-look-img')].map((i) => i.getAttribute('src')), [pic(SHARE.id), pic(SHARE.id, 'without')], 'with, then without the ink');
    assert.deepStrictEqual(shell.calls.slice(tapAt).filter((c) => !(c.method === 'GET' && /\/picture(\?which=without)?$/.test(c.url))), [], 'the tap asks nothing but the pictures');
    shell.key('Escape');
    await waitUntil(() => !pop.isConnected, { timeout: 2000, what: 'closed' });
    // The private margin stroke: the faded guess, no pin, never asked.
    await waitUntil(() => shown(UNDER.id) && markerOf(UNDER.id).classList.contains('el-guess'), { timeout: 4000, what: 'faded' });
    assert.equal(pinOf(UNDER.id), null, 'no pin for a private group');
    assert.equal(shell.calls.filter((c) => c.url.startsWith(`/api/elements/${UNDER.id}/picture`)).length, 0, 'never asked for a picture');
  });
  await waitUntil(() => !W.document.querySelector('#el-layer .el-marker[data-el-pin]'), { timeout: 4000, what: 'no pin on the desktop' });
});

// ── (6) ─────────────────────────────────────────────────────────────────────

test('(6) no script-error reached the daemon, and no interval the shell tracks was left armed', async () => {
  await shell.tick();
  const errors = shell.sockets.flatMap((s) => s.frames('script:error'));
  assert.deepStrictEqual(errors, [], 'no pane script failed');
  assert.equal(shell.intervals().length, intervalsAtBoot, 'no interval armed since boot');
  assert.equal(wet.stats().held, 0, 'no wet stroke held (its hold timer drained)');
});

'use strict';
// Tranche 4 in the real chrome at the integration head (U590; the twin of
// test/elements-e2e-t4.test.js): public/index.html and main.js booted ONCE
// (test-support/chrome-shell bootShell, in the before() hook), the daemon a
// set of routes that answer as it does once the fixture strokes pack is
// approved (the listing row and the toolbar tool BUILT from the fixture's
// element.json by the daemon's own code, as test/strokes-pack-e2e-chrome.test.js
// builds them), jsdom's missing layout stubbed per element.
//   - the boot: the create ctx a strokes type's create gets is the overlay's
//     own keys and exactly the boot members test/overlay-box-mode.test.js
//     pins (wet, frameAt, stroke, tray; contract (c)); input-mode's
//     STROKES_TARGETS is the set lib/core/anchors targetFrame accepts (U515);
//   - a pane's event anchors are released with the pane (contract (d)):
//     the observer the engagement made is disconnected when a frame clears it;
//   - the loader imports the approved type's draw.js once and draws it (U512);
//   - a pen stroke on an svg: the wet layer begins over it and drops at
//     pen-up (U517); one POST, private (PRIVATE@create);
//   - the dry stroke's box marker: the svg's rect inside the clip at 1,280 px
//     and 390 px, clipped where the svg leaves the well, never drawn over a
//     displayed frame (U516);
//   - a pen tap on an svg with the comment tool pins a point (U532);
//   - a detached comment glyph dragged: one glyph POST, kept at its offset,
//     its leader inside the clip (U587);
//   - a chat-comment group turns answered on the rail (U585);
//   - Mod+Z in a field is the field's own undo; outside it, the engine's
//     (U518);
//   - no script-error frame reached the daemon and no interval was left armed.
// overlay.js's sameRow (contract (p)) is asserted on the dry stroke's row.
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
const { toolEntry } = require('../lib/server/routes/toolbar');

const REPO = path.join(__dirname, '..');
const PACK_DIR = path.join(REPO, 'test-support', 'element-packs', 'strokes-fixture');
const TYPE = 'scribble';
const PACK = 'strokes-fixture';
const DRAW_SRC = fs.readFileSync(path.join(elementSrcDir(PACK_DIR, TYPE), 'draw.js'), 'utf8');
const SHA = crypto.createHash('sha256').update(DRAW_SRC).digest('hex');
const DRAW_URL = `/api/elements/types/${TYPE}/draw.js?d=${SHA}`;

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
  return {
    listing: { ...row, builtin: false, tier: 'local', pack: PACK, toolbar, draw: { sha256: SHA } },
    tool: toolEntry({ type: TYPE, pack: PACK, builtin: false, toolbar }, '1.0.0'),
  };
}
const ROWS = scribbleRows();
const BASE_TYPES = DEFAULT_ROUTES['/api/elements/types'];
const BASE_TOOLBAR = DEFAULT_ROUTES['/api/toolbar'];
const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const MIRROR = { v: 1, enabled: true, now: T0, rev: 1, content: true, access: { level: 'local', remote: false },
  capabilities: {}, primary: null, aggregate: { state: 'idle' }, conversations: [], tasks: [], asks: [] };

const PANE = {
  id: 'e4c', target: 'main', params: {}, gen: 0,
  html: '<div class="wrap"><svg class="art" viewBox="0 0 200 100"><g><path class="line" d="M0 0 L10 10"/></g></svg>'
    + '<p class="prose">Some prose to pin a comment on.</p><input class="field" type="text"></div>',
};
const EA_PANE = { id: 'e4ea', target: 'main', params: {}, gen: 0, html: '<ul><li class="row"><button class="go">Run</button></li></ul>' };
const RECTS = {
  1280: { well: { left: 0, top: 48, width: 1280, height: 752 }, svg: { left: 100, top: 200, width: 200, height: 100 } },
  390: { well: { left: 0, top: 48, width: 390, height: 796 }, svg: { left: 240, top: 200, width: 200, height: 100 } },
};
const PROSE = { left: 100, top: 320, width: 300, height: 20 };
const FRAME_AWAY = { left: 900, top: 700, width: 200, height: 60 };

let shell, W, M, ov, ET, TF, tools, wet, state, comments, CP, anchors, IM;
let approved = false;
let strokes = [];
let pins = new Map();
let chat = [];
let nextSeq = 1;
const imported = [];
const createCtxKeys = [];
const glyphMoves = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u590-chrome-'));
let intervalsAtBoot = 0;
let frameEl = null;

const posts = (url = '/api/elements') => shell.calls.filter((c) => c.method === 'POST' && c.url === url);
const rootOf = (id = 'e4c') => M.itemEl(W.document, id).el.shadowRoot;
const q = (sel, id) => rootOf(id).querySelector(sel);
const wetCanvases = () => [...W.document.querySelectorAll('canvas.el-wet')];
const markers = (type = TYPE) => [...W.document.querySelectorAll(`#el-layer .el-marker[data-type="${type}"]`)];
const markerOf = (id) => [...W.document.querySelectorAll('#el-layer .el-marker')].find((m) => (m.dataset.elIds || '').split(' ').includes(id)) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boxed(el, r) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height });
  return el;
}
function layout(width) {
  const R = RECTS[width];
  shell.scrollMetrics(W.document.querySelector('.well-wrap'), { rect: R.well });
  shell.scrollMetrics(W.document.getElementById('main'), { rect: { ...R.well, height: 3000 } });
  shell.scrollMetrics(M.itemEl(W.document, 'e4c').el, { rect: { left: 0, top: 150, width: 1280, height: 300 } });
  boxed(q('svg.art'), R.svg);
  boxed(q('path.line'), R.svg);
  boxed(q('p.prose'), PROSE);
}

// The daemon, as the routes answer it.
function elementsRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method === 'POST') {
    const body = JSON.parse(init.body);
    const seq = nextSeq++;
    if (body.type === TYPE) {
      const { shared, ...rest } = body.payload;
      const rec = { id: `p${seq}`, type: TYPE, v: 1, schema: `${TYPE}@1`, seq, created_at: new Date(T0 + seq).toISOString(),
        shared: shared !== false, anchor: body.anchor, ...rest, writer: { class: 'user', owner: 'user', verified: false } };
      strokes = strokes.concat([rec]);
      return { ok: true, element: rec };
    }
    const pin = { id: `c${500 + seq}`, v: 1, seq, type: 'comment', schema: 'comment@2', text: body.payload.text, shared: body.payload.shared !== false,
      replies: [], anchor: body.anchor, locator: body.locator };
    pins.set(pin.id, pin);
    return { ok: true, element: pin, pin };
  }
  if (url.includes(`type=${TYPE}`)) return { elements: strokes, next_cursor: nextSeq };
  if (/type=chat-comment(&|$)/.test(url)) return { ok: true, elements: chat.map((p) => ({ ...p })), next_cursor: 0 };
  if (/type=comment(&|$)/.test(url) || !url.includes('type=')) return { elements: [...pins.values()], next_cursor: nextSeq };
  return { elements: [] };
}
function elementRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const parts = new URL(url, 'http://x').pathname.split('/');
  if (method === 'POST' && parts[parts.length - 1] === 'glyph') {
    const id = decodeURIComponent(parts[parts.length - 2]);
    const body = JSON.parse(init.body);
    glyphMoves.push({ id, body });
    const pin = pins.get(id);
    if (!pin) return respond({ ok: false, error: 'not found' }, { status: 404 });
    const display = { glyph: { dx: body.dx, dy: body.dy, corner: body.corner } };
    pins.set(id, { ...pin, v: pin.v + 1, display });
    return { ok: true, id, type: 'comment', v: pin.v + 1, display };
  }
  return { ok: true };
}
const QUEUE = {
  items: [{ id: 'q-chat', kind: 'element', type: 'chat-comment', label: 'chat-comment', element_id: 'k2', element_ids: ['k1', 'k2'], v: 1,
    count: 2, summary: '2 of chat-comment', why_wake: 'sent to Claude', source: 'browser', staged: true, respond: true }],
  count: 1,
};
const chatPin = (id, replied, v = 1) => ({ id, v, type: 'chat-comment', schema: 'chat-comment@1', seq: 1, shared: true, text: `chat ${id}`,
  anchor: { v: 1, kind: 'turn', conversation_id: 'cX', session_id: 's1', turn_id: 'tX' },
  replies: replied ? [{ author: 'claude', at: T0, text: 'answered' }] : [], state: 'exact', visible: 'exact', explain: 'exact' });

// The loader's importer: the route's answer, through the twin, as a module;
// its create wrapped so the test sees the create ctx the overlay hands it.
async function importThroughRoute(url) {
  imported.push(url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the route answered ${r.status}`);
  const file = path.join(tmp, `draw-${imported.length}.mjs`);
  fs.writeFileSync(file, await r.text());
  const mod = await import(pathToFileURL(file).href);
  return { default: mod.default, create(input, ctx) { if (!createCtxKeys.length) createCtxKeys.push(...Object.keys(ctx)); return mod.create(input, ctx); } };
}

function pen(el, type, x, y, { samples = null, pressure = 0.6, t = 0, pointerId = 3 } = {}) {
  const e = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'pen', pointerId,
    isPrimary: true, clientX: x, clientY: y, pressure, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1 });
  const list = samples || [{ clientX: x, clientY: y, pressure, timeStamp: 1000 + t }];
  e.getCoalescedEvents = () => list;
  e.getPredictedEvents = () => [];
  el.dispatchEvent(e);
  return e;
}
const sample = (x, y, t, p = 0.6) => ({ clientX: x, clientY: y, pressure: p, timeStamp: 1000 + t });
function mouse(el, type, x, y, pointerId = 9) {
  const ev = new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse', pointerId, isPrimary: true,
    clientX: x, clientY: y, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0 });
  el.dispatchEvent(ev);
  return ev;
}

// The MutationObservers the event-anchor engine makes (contract (d)): it is
// created lazily at a pane's first engagement, so the counting constructor is
// installed before any pane sees a pointer.
const observed = [];
before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => (approved ? { ...BASE_TYPES, types: [...BASE_TYPES.types, ROWS.listing] } : BASE_TYPES),
      '/api/toolbar': () => (approved
        ? { ...BASE_TOOLBAR, tools: [...BASE_TOOLBAR.tools, ROWS.tool], project: { ...BASE_TOOLBAR.project, pinned: [...BASE_TOOLBAR.project.pinned, TYPE] } }
        : BASE_TOOLBAR),
      [DRAW_URL]: () => respond(DRAW_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8' } }),
      '/api/elements': elementsRoute,
      '/api/elements/undo': { ok: true, undone: { id: 'p1', type: TYPE, v: 1, item: 'e4c', how: 'removed' } },
      '/api/elements/*': elementRoute,
      '/api/mirror': () => MIRROR,
      '/api/queue': () => JSON.parse(JSON.stringify(QUEUE)),
      '/api/queue/*': () => ({ ok: true }),
    },
  });
  W = shell.window;
  M = W.__wcMount;
  const RealMO = W.MutationObserver;
  W.MutationObserver = class CountingObserver extends RealMO {
    constructor(fn) { super(fn); this.rec = { targets: [], disconnects: 0 }; observed.push(this.rec); }
    observe(target, opts) { this.rec.targets.push(target); return super.observe(target, opts); }
    disconnect() { this.rec.disconnects++; return super.disconnect(); }
  };
  W.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
    if (kind !== '2d') return null;
    const calls = [];
    const c = { canvas: this, calls };
    for (const k of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke']) c[k] = (...a) => calls.push([k, ...a]);
    return c;
  };
  ov = await shell.importApp('overlay.js');
  ET = await shell.importApp('element-types.js');
  TF = await shell.importApp('target-frame.js');
  tools = await shell.importApp('tools.js');
  wet = (await shell.importApp('wet-layer.js')).initWetLayer();
  ({ view: state } = await shell.importApp('state.js'));
  comments = await shell.importApp('comments.js');
  CP = await shell.importApp('chat-pins.js');
  anchors = (await shell.importApp('anchors.js')).default;
  IM = await shell.importApp('input-mode.js');
  ET.initElementTypes({ importModule: importThroughRoute });
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE, EA_PANE] }));
  await shell.tick();
  layout(1280);
  frameEl = W.document.createElement('iframe');
  W.document.body.appendChild(frameEl);
  boxed(frameEl, FRAME_AWAY);
  intervalsAtBoot = shell.intervals().length;
});
after(async () => {
  try { if (ov) ov.setArmed(null); } catch {}
  if (shell) await shell.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a pane\'s event anchors are released with it: the observer its engagement made is disconnected when a frame clears the pane', async () => {
  const root = rootOf('e4ea');
  const btn = root.querySelector('button.go');
  btn.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, composed: true, pointerType: 'mouse', pointerId: 30 }));
  btn.dispatchEvent(new W.MouseEvent('click', { bubbles: true, composed: true }));
  await shell.tick();
  const mine = observed.filter((r) => r.targets.includes(root));
  assert.equal(mine.length, 1, 'one observer engaged on the pane\'s root');
  assert.equal(mine[0].disconnects, 0, 'engaged, not yet released');
  const ev = shell.socket().frames('event').filter((f) => f.payload && f.payload.mountId === 'e4ea');
  assert.ok(ev.length && ev.at(-1).payload.anchor && ev.at(-1).payload.anchor.kind === 'element', 'reportEvent carried the element anchor (U542)');
  await shell.frame({ type: 'clear', id: 'e4ea' });
  await shell.tick();
  assert.ok(mine[0].disconnects >= 1, 'releasePane disconnected it');
});

test('the loader imports the approved type\'s draw.js once and registers it; the create ctx is the overlay\'s own keys and exactly the boot members (contract (c)); STROKES_TARGETS is targetFrame\'s set', async () => {
  assert.deepStrictEqual(imported, [], 'nothing imported before the approve');
  approved = true;
  await shell.frame({ type: 'components' });
  await waitUntil(() => ET.typeOf(TYPE), { timeout: 3000, what: 'the scribble row' });
  await ET.loadPluginTypes();
  assert.deepStrictEqual(imported, [DRAW_URL], 'one import, of exactly drawPath(type, sha)');
  assert.deepStrictEqual(ET.drawStates().filter((s) => s.type === TYPE), [], 'loaded, not a stand-in');
  // The boot members: overlay-box-mode.test.js's BOOT_MEMBERS literal and
  // main.js's boot registrations on the create ctx.
  const pinned = /const BOOT_MEMBERS = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(REPO, 'test', 'overlay-box-mode.test.js'), 'utf8'));
  assert.ok(pinned, 'the BOOT_MEMBERS literal');
  const BOOT_MEMBERS = [...pinned[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...BOOT_MEMBERS].sort(), ['frameAt', 'stroke', 'tray', 'wet']);
  W.__u590BootMembers = BOOT_MEMBERS;
  // input-mode's strokes targets are the elements targetFrame accepts.
  const probe = W.document.createElement('div');
  probe.innerHTML = '<svg></svg><img><canvas></canvas><div data-fixed-aspect>s</div><p>no</p><button>no</button>';
  W.document.body.appendChild(probe);
  try {
    for (const el of probe.children) {
      boxed(el, { left: 1, top: 1, width: 10, height: 10 });
      const inSet = el.matches(IM.STROKES_TARGETS);
      const fr = anchors.targetFrame(probe, el);
      assert.equal(inSet, !fr.refused, `${el.localName}: STROKES_TARGETS ${inSet}, targetFrame ${fr.refused || 'accepts'}`);
    }
  } finally { probe.remove(); }
});

test('a pen stroke on the svg: the wet layer begins over it and drops at pen-up; one POST, private; the dry box marker is the svg\'s rect inside the clip at 1,280 px and 390 px, never over a displayed frame', async () => {
  tools.arm(TYPE);
  const n0 = posts().length;
  const el = q('path.line');
  pen(el, 'pointerdown', 120, 290, { t: 0 });
  await shell.tick();
  assert.equal(wetCanvases().filter((c) => c.isConnected).length, 1, 'the wet canvas begun');
  const c = wetCanvases()[0];
  assert.deepStrictEqual([c.style.left, c.style.top, c.style.width, c.style.height], ['100px', '200px', '200px', '100px'], 'laid over the svg');
  pen(el, 'pointermove', 180, 260, { samples: [sample(150, 275, 8), sample(180, 260, 16)] });
  await shell.tick();
  pen(el, 'pointermove', 260, 220, { samples: [sample(220, 240, 24), sample(260, 220, 32)] });
  await shell.tick();
  pen(el, 'pointerup', 260, 220, { t: 40 });
  await waitUntil(() => posts().length === n0 + 1, { timeout: 3000, what: 'the stroke\'s POST' });
  await waitUntil(() => wetCanvases().every((cv) => !cv.isConnected), { timeout: 3000, what: 'the wet canvas dropped' });
  tools.arm(null);
  const { body } = posts()[n0];
  assert.deepEqual([body.type, body.anchor.kind, body.payload.shared], [TYPE, 'element', false], 'private by default');
  // The create ctx (contract (c)).
  assert.deepStrictEqual([...createCtxKeys].sort(), [...ov.CREATE_CTX_KEYS, ...W.__u590BootMembers].sort(), 'the own keys and the boot members, exactly');
  // The dry marker, from the add's frame.
  await shell.frame({ type: `element:${TYPE}`, elements: strokes });
  const rec = strokes.at(-1);
  const marker = await waitUntil(() => markers().find((m) => m.querySelector(`path[data-el-id="${rec.id}"]`)), { timeout: 4000, what: 'the dry marker' });
  const rect = (m) => [m.style.left, m.style.top, m.style.width, m.style.height].map(parseFloat);
  assert.equal(marker.dataset.place, 'box');
  assert.deepStrictEqual(rect(marker), [100, 200, 200, 100], '1,280 px: the svg\'s rect');
  assert.ok(!marker.style.clipPath || /inset\(0(px)? 0(px)? 0(px)? 0(px)?\)/.test(marker.style.clipPath), `wholly inside the clip: ${marker.style.clipPath}`);
  assert.notEqual(marker.style.display, 'none');
  // overlay.js's one row-equality (contract (p)): the relayed row matches its record.
  const held = ov.elementsOf('live').find((r) => r.id === rec.id);
  assert.equal(ov.sameRow(held, { ...rec }), true, 'an unchanged record matches its held row');
  assert.equal(ov.sameRow(held, { ...rec, v: 2 }), false, 'a new version does not');
  // 390 px: the svg runs past the well's right edge → clipped to it.
  try {
    shell.setViewport({ width: 390, height: 844, coarse: true });
    layout(390);
    ov.requestDraw();
    await waitUntil(async () => { await shell.tick(); const m = markerOf(rec.id); return m && parseFloat(m.style.left) === 240 && m.style.display !== 'none'; },
      { timeout: 4000, what: 'the marker re-placed at 390 px' });
    const m = markerOf(rec.id);
    assert.deepStrictEqual(rect(m), [240, 200, 200, 100], '390 px: the svg\'s rect');
    assert.match(m.style.clipPath, /inset\(/, 'clipped where the svg leaves the well');
    assert.match(m.style.clipPath, /50px/, `the 50 px past the well's right edge cut: ${m.style.clipPath}`);
    // A displayed frame over the svg: the marker is never drawn over it.
    boxed(frameEl, { left: 250, top: 210, width: 60, height: 40 });
    ov.requestDraw();
    await waitUntil(async () => { await shell.tick(); const mm = markerOf(rec.id); return mm && mm.style.display === 'none'; },
      { timeout: 4000, what: 'hidden under the frame' });
  } finally {
    boxed(frameEl, FRAME_AWAY);
    shell.setViewport({ width: 1280, height: 800, coarse: false });
    layout(1280);
    ov.requestDraw();
  }
  await waitUntil(async () => { await shell.tick(); const m = markerOf(rec.id); return m && m.style.display !== 'none' && parseFloat(m.style.left) === 100; },
    { timeout: 4000, what: 'drawn again at 1,280 px' });
});

test('a pen tap on the svg with the comment tool pins a point (U532)', async () => {
  ov.setArmed('comment');
  const n0 = posts().length;
  const el = q('path.line');
  const x = 100 + 0.25 * 200;
  const y = 200 + 0.5 * 100;
  try {
    pen(el, 'pointerdown', x, y, { pointerId: 41 });
    pen(el, 'pointerup', x, y, { pointerId: 41 });
    el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'pen', pointerId: 41, clientX: x, clientY: y }));
    const pop = W.document.querySelector('.pin-pop');
    assert.ok(pop && pop.querySelector('.pin-text'), 'the pen opened the composer');
    pop.querySelector('.pin-text').value = 'on the chart';
    shell.click(pop.querySelector('.pin-save'));
    await waitUntil(() => posts().length === n0 + 1, { timeout: 3000, what: 'the POST' });
  } finally { ov.setArmed(null); }
  const { body } = posts()[n0];
  assert.equal(body.type, 'comment');
  assert.equal(body.anchor.kind, 'point');
  assert.deepEqual([body.anchor.x, body.anchor.y, body.anchor.aspect], [0.25, 0.5, 2]);
  assert.equal(body.anchor.mount, 'e4c');
});

test('a detached comment glyph: dragged off its anchor, one glyph POST, kept at its offset, its leader inside the clip (U587)', async () => {
  const anchor = anchors.record(rootOf(), q('p.prose'), { mount: 'e4c' });
  const pin = { id: 'c900', v: 1, seq: 900, type: 'comment', schema: 'comment@2', text: 'detach me', shared: true, replies: [], anchor,
    locator: { mount: 'e4c', selector: 'p.prose', text: 'Some prose', ordinal: 0 } };
  pins.set(pin.id, pin);
  await shell.frame({ type: 'element:comment', elements: [...pins.values()] });
  const m0 = await waitUntil(async () => { await shell.tick(); const m = markerOf('c900'); return m && m.style.display !== 'none' ? m : null; },
    { timeout: 4000, what: 'the pin drawn attached' });
  assert.equal(m0.dataset.detach, '1', 'the comment adopts the detachable glyph');
  const x0 = parseFloat(m0.style.left);
  const y0 = parseFloat(m0.style.top);
  glyphMoves.length = 0;
  mouse(m0, 'pointerdown', 100, 100);
  mouse(m0, 'pointermove', 200, 150);
  mouse(m0, 'pointermove', 300, 180);
  mouse(m0, 'pointerup', 300, 180);
  m0.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 9, clientX: 300, clientY: 180 }));
  await waitUntil(() => glyphMoves.length === 1, { timeout: 3000, what: 'the glyph POST' });
  assert.equal(glyphMoves[0].id, 'c900');
  assert.ok(['tl', 'tr', 'bl', 'br'].includes(glyphMoves[0].body.corner), JSON.stringify(glyphMoves[0].body));
  assert.equal(W.document.querySelector('.pin-pop'), null, 'the drag\'s click never opens the thread');
  await shell.frame({ type: 'element:comment', elements: [...pins.values()] });
  await waitUntil(async () => {
    await shell.tick();
    const m = markerOf('c900');
    return m && (parseFloat(m.style.left) !== x0 || parseFloat(m.style.top) !== y0);
  }, { timeout: 4000, what: 'kept at its offset' });
  const l = await waitUntil(async () => { await shell.tick(); const x = ov.leaders().find((r) => r.ids.includes('c900')); return x && x.drawn ? x : null; },
    { timeout: 4000, what: 'its leader drawn' });
  const well = RECTS[1280].well;
  assert.ok(l.box.left >= well.left && l.box.top >= well.top && l.box.left + l.box.width <= well.left + well.width
    && l.box.top + l.box.height <= well.top + well.height, `the leader inside the clip: ${JSON.stringify(l.box)}`);
  comments.closePinPop();
});

test('a chat-comment group turns answered on the rail once its last member is replied to (U585)', async () => {
  const dot = () => { const r = W.document.querySelector('#queue-rail .rail-item[data-id="q-chat"]'); return r ? r.querySelector('.qi-dot') : null; };
  await waitUntil(() => dot(), { timeout: 4000, what: 'the chat group on the rail' });
  chat = [chatPin('k1', true), chatPin('k2', false)];
  await shell.frame({ type: 'element:chat-comment', elements: chat.map((p) => ({ ...p })) });
  await waitUntil(() => CP.chatPinOf('k2'), { timeout: 4000, what: 'the chat layer\'s records' });
  await shell.tick(3);
  assert.equal(dot().classList.contains('answered'), false, 'one of two replied: not answered');
  chat = [chatPin('k1', true), chatPin('k2', true, 2)];
  await shell.frame({ type: 'element:chat-comment', elements: chat.map((p) => ({ ...p })) });
  await waitUntil(() => dot().classList.contains('answered'), { timeout: 4000, what: 'the dot turns answered with no queue frame' });
});

test('Mod+Z in a pane\'s field is the field\'s own undo; outside it, the engine\'s undo posts once (U518)', async () => {
  const n0 = posts('/api/elements/undo').length;
  const inp = q('input.field');
  inp.focus();
  const e1 = shell.key('z', { target: inp, metaKey: true });
  inp.blur();
  await shell.tick(3);
  assert.equal(posts('/api/elements/undo').length, n0, 'nothing posted from a field');
  assert.equal(e1.defaultPrevented, false, 'the field keeps the key');
  q('p.prose').dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, composed: true, pointerType: 'mouse', clientX: 120, clientY: 325 }));
  const e2 = shell.key('z', { metaKey: true });
  await waitUntil(() => posts('/api/elements/undo').length === n0 + 1, { timeout: 3000, what: 'the undo POST' });
  assert.equal(e2.defaultPrevented, true);
  assert.equal(posts('/api/elements/undo')[n0].body.item, 'e4c', 'the item under the pointer');
});

test('no script-error frame reached the daemon, and no interval was left armed', async () => {
  await sleep(0);
  const errors = shell.sockets.flatMap((s) => s.frames('script:error'));
  assert.deepEqual(errors, [], 'no pane script failed');
  assert.equal(shell.intervals().length, intervalsAtBoot, 'no interval armed since boot');
});

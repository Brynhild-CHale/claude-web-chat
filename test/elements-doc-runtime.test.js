'use strict';
// The documents' element overlay (annotation engine tranche 4, U522; PLAN.md
// 4B.1; DECISIONS.md B3, R1 stage B, K.2-141): lib/server/runtime/
// elements-doc-src.js — the payload contract v1 (validatePayload and its
// fixture, test-support/doc-elements-fixture.js), the runtime a document
// carries, and the one spelling of the splice.
//
// A document here is the node preview template's own pieces (lib/server/
// preview.js previewTemplate) around the fixture node, the resolver
// (anchors-src scriptElement) and scripts(payload) spliced right after it, run
// in jsdom with scripts on and resources off. jsdom does no layout, so the
// fixture's elements are given boxes (a stub of getBoundingClientRect and of a
// Range's getClientRects, scaled by a width factor for the resize case); it
// runs no module script, so the plug-in path calls define() itself, with the
// fixture module's own draw. fetch, XMLHttpRequest and WebSocket are stubbed
// to throw and counted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const E = require('../lib/server/runtime/elements-doc-src');
const anchorsSrc = require('../lib/server/runtime/anchors-src');
const { previewTemplate, previewThemeCss, previewNodeJson } = require('../lib/server/preview');
const { jsonForScript } = require('../lib/server/export');
const { PREVIEW_CSP } = require('../lib/core/cors');
const { convertAnchor } = require('../lib/core/element-log');
const { escapeHtml } = require('../lib/core/html');
const { MARKDOWN_MAX_CHARS } = require('../lib/server/domain/page');
const { fixture, fixturePayload, F_BOX_MODULE, MARK_URI } = require('../test-support/doc-elements-fixture');
const { waitUntil, e2eGate } = require('../test-support/helpers');

const ALL_KINDS = anchorsSrc.RESOLVER_KINDS;
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });

// ── a document ──────────────────────────────────────────────────────────────

// The preview document of `node` with the resolver and the elements spliced
// after it, exactly where the template's anchors hole puts them.
function documentOf(payload, node = fixture().node, edit = (x) => x) {
  const [a, b, c, d] = previewTemplate();
  return a + previewThemeCss({ tokens: {} }) + b + anchorsSrc.scriptElement({ kinds: ALL_KINDS })
    + edit(E.scripts(payload)) + c + previewNodeJson(node) + d;
}

// The fixture's boxes (viewport px), the x axis scaled by win.__scale.
const BOXES = {
  'fx-a': [0, 0, 800, 600],
  'fx-b': [0, 700, 800, 400],
  'p.lead': [20, 40, 300, 20],
  'p.body': [20, 80, 400, 20],
  'li.two': [40, 200, 100, 16],
  'svg.chart': [50, 750, 200, 100],
  'main.page': [0, 0, 800, 1200],
  'div.md-block': [0, 620, 800, 60],
};
const RANGE_BOX = [60, 80, 120, 18];   // 'quick brown fox' inside p.body
const MD_RANGE_BOX = [120, 650, 90, 18];   // 'three steps' inside md-notes
function rect(win, [l, t, w, h]) {
  const s = win.__scale || 1;
  const left = l * s;
  const width = w * s;
  return { left, top: t, width, height: h, right: left + width, bottom: t + h, x: left, y: t };
}
function keyOf(el) {
  if (el.classList && el.classList.contains('mount-host')) return el.id;
  const tag = el.localName;
  const cls = el.getAttribute && el.getAttribute('class');
  return cls ? `${tag}.${cls.split(' ')[0]}` : tag;
}

// Opens a document; returns its window and the network-call count.
function open(html) {
  const net = { calls: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      const refuse = (what) => function () { net.calls++; throw new Error(`no ${what} in a document`); };
      win.fetch = refuse('fetch');
      win.XMLHttpRequest = refuse('XMLHttpRequest');
      win.WebSocket = refuse('WebSocket');
      win.__scale = 1;
      win.Element.prototype.getBoundingClientRect = function () {
        const b = BOXES[keyOf(this)];
        return b ? rect(win, b) : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
      };
      win.Range.prototype.getClientRects = function () {
        const p = this.startContainer && this.startContainer.parentNode;
        if (p && p.closest && p.closest('.md-block')) return [rect(win, MD_RANGE_BOX)];
        return p && p.localName === 'p' && p.getAttribute('class') === 'body' ? [rect(win, RANGE_BOX)] : [];
      };
    },
  });
  WINDOWS.push(dom.window);
  return { win: dom.window, net };
}

// The fixture module's draw, made in the document's realm (jsdom runs no
// module script), wrapped to count its calls and keep its last ctx.
function fBoxDraw(win, { throws = false } = {}) {
  const src = F_BOX_MODULE.replace('export default function draw(', 'function __fBoxDraw(').replace(/^export const /gm, 'var ');
  const real = win.eval(`${src}\n;__fBoxDraw`);
  const spy = { calls: 0, ctx: null, groups: [] };
  spy.draw = function (group, ctx) {
    spy.calls++;
    spy.ctx = ctx;
    spy.groups.push(group);
    if (throws) throw new Error('this draw cannot read its record');
    return real(group, ctx);
  };
  return spy;
}

const markers = (win) => [...win.document.querySelectorAll('.wc-el-layer .el-marker')];
const markerOf = (win, id) => markers(win).find((m) => (m.getAttribute('data-el-ids') || '').split(' ').includes(id));
const loaded = (win) => waitUntil(() => win.document.readyState === 'complete', { timeout: 5000, what: 'the load event' });
const settled = async (win) => {
  await loaded(win);
  await new Promise((r) => win.setTimeout(r, 20));
};
const px = (v) => Number(String(v).replace('px', ''));
// A glyph marker's painted box: its anchor point (left, top) moved by its
// glyph's translate, and its size.
function painted(m) {
  const t = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\)$/.exec(m.style.transform);
  assert.ok(t, `a glyph's translate: ${m.style.transform}`);
  return [px(m.style.left) + Number(t[1]), px(m.style.top) + Number(t[2]), px(m.style.width), px(m.style.height)];
}
const classes = (m) => m.className.split(/\s+/).filter(Boolean);
const stats = (win) => win.__wcMount.elements.stats();

// ── the document draws ─────────────────────────────────────────────────────

test('a document draws the fixture: the comment pin at its target, the highlight over its range, the box on its svg, the removed type\'s generic mark, the markdown comment; no network', async (t) => {
  const p = fixturePayload();
  const { win, net } = open(documentOf(p));
  const box = fBoxDraw(win);
  win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
  await settled(win);

  const c1 = markerOf(win, 'c1');
  assert.ok(c1, 'the comment is drawn');
  assert.deepEqual(classes(c1).slice(0, 2), ['el-marker', 'el-hit'], 'a hit, by the draw rules');
  assert.ok(classes(c1).includes('replied'), 'answered: a reply is Claude\'s');
  assert.deepEqual([px(c1.style.left), px(c1.style.top)], [20, 40], 'at its target\'s top-left');
  assert.equal(c1.style.transform, 'translate(-13px, -26px)', 'the overlay\'s glyph');
  assert.equal(c1.title, 'Is this the right lead? (1 reply)', 'a native tooltip: the text and the reply count');
  assert.ok(c1.querySelector('svg'), 'the pin');

  const h1 = markerOf(win, 'h1');
  assert.ok(h1 && classes(h1).includes('hl-handle'), 'the highlight\'s handle');
  assert.equal(h1.getAttribute('data-color'), 'gold');
  const rects = [...h1.querySelectorAll('.hl-rect')];
  assert.equal(rects.length, 1, 'one rectangle per client rect of the range');
  const ox = px(h1.style.left) - 4;
  const oy = px(h1.style.top) - 4;
  assert.deepEqual([ox + px(rects[0].style.left), oy + px(rects[0].style.top), px(rects[0].style.width), px(rects[0].style.height)],
    RANGE_BOX, 'the rectangle lies over the range');

  const b1 = markerOf(win, 'b1');
  assert.ok(b1 && b1.getAttribute('data-place') === 'box', 'a box marker');
  assert.ok(!classes(b1).includes('el-generic'), 'drawn by its type');
  assert.deepEqual([b1.style.left, b1.style.top, b1.style.width, b1.style.height], ['50px', '750px', '200px', '100px'],
    'the container is its svg target\'s rect');
  assert.equal(box.calls, 1, 'the draw ran once for its group');
  assert.ok(b1.querySelector('svg[viewBox="0 0 1 1"]'), 'the type drew in the normalised viewBox');
  assert.deepEqual({ ...box.ctx.box }, { w: 200, h: 100 }, 'ctx.box: the target\'s rect');
  const bg = box.groups[0];
  assert.deepEqual({ place: bg.place, drawn: bg.drawn, boxW: bg.boxW, boxH: bg.boxH }, { place: 'box', drawn: true, boxW: box.ctx.box.w, boxH: box.ctx.box.h },
    'the group carries the live box group\'s fields (U516: place, drawn, boxW, boxH), equal to ctx.box');
  assert.equal(box.ctx.document, true);
  assert.equal(box.ctx.previewing, true);
  assert.equal(box.ctx.host, 'page');
  for (const k of ['create', 'input', 'tray']) assert.equal(box.ctx[k], undefined, `no ${k} in a document`);
  assert.equal(b1.getAttribute('data-f-box-label'), 'framed', 'the draw read its record\'s payload through ctx.record');

  win.__scale = 1.5;
  win.dispatchEvent(new win.Event('resize'));
  assert.deepEqual([b1.style.left, b1.style.width, b1.style.height], ['75px', '300px', '100px'], 'the second width: rescaled');
  assert.equal(box.calls, 1, 'with no redraw');
  assert.deepEqual({ ...box.ctx.box }, { w: 300, h: 100 }, 'ctx.box read live');
  assert.deepEqual([bg.boxW, bg.boxH], [300, 100], 'the group\'s boxW and boxH follow the resize');
  win.__scale = 1;
  win.dispatchEvent(new win.Event('resize'));

  const r1 = markerOf(win, 'r1');
  assert.ok(r1, 'the removed type is drawn');
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(classes(r1).includes(c), c);
  assert.equal(r1.querySelector('.el-generic-name').textContent, 'f-gone', 'the type named');

  // Every marker: its type and its group's ids, space-joined.
  const ids = { 'c1': 'comment', 'h1': 'highlight', 'b1': 'f-box', 'r1': 'f-gone', 's1': 'comment' };
  const ms = markers(win);
  assert.equal(ms.length, 5);
  for (const m of ms) {
    assert.ok(m.hasAttribute('data-type') && m.hasAttribute('data-el-ids'), 'data-type and data-el-ids on every marker');
    assert.equal(m.getAttribute('data-type'), ids[m.getAttribute('data-el-ids')]);
  }
  assert.deepEqual(stats(win), { drawn: 4, generic: 1, parked: 0, unplaced: 0, clipped: 0 });
  assert.equal(net.calls, 0, 'no network call');
  assert.equal(win.document.querySelectorAll('[id]').length, 1 + 2, 'no id added: #main and the two pane hosts only');
  t.diagnostic(`markers ${ms.length}; stats ${JSON.stringify(stats(win))}`);
});

test('a group\'s data-el-ids are its items\' ids, space-joined, in id order', async () => {
  const p = fixturePayload();
  p.items.splice(2, 0, { ...p.items[1], id: 'c2', payload: { text: 'And this?', replies: [] } });
  assert.equal(E.validatePayload(p), null);
  const { win } = open(documentOf(p));
  win.__wcMount.elements.define('f-box', fBoxDraw(win).draw, p.types[0].assets);
  await settled(win);
  const m = markerOf(win, 'c2');
  assert.equal(m.getAttribute('data-el-ids'), 'c1 c2');
  assert.equal(m.getAttribute('data-type'), 'comment');
  assert.equal(m.querySelector('.pin-count').textContent, '2');
  assert.equal(m.title, 'Is this the right lead? (1 reply)  •  And this? (0 replies)');
});

test('the document ctx\'s asset(rel): the inlined data: URI; null for a skipped rel and for a path outside the grammar', async () => {
  const p = fixturePayload();
  const { win } = open(documentOf(p));
  const box = fBoxDraw(win);
  win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
  await settled(win);
  const { asset } = box.ctx;
  assert.equal(asset('mark.svg'), MARK_URI);
  assert.equal(markerOf(win, 'b1').querySelector('image').getAttribute('href'), MARK_URI, 'the draw used it');
  for (const rel of ['big.png', '/mark.svg', 'assets/mark.svg', '../mark.svg', 'a/../mark.svg', '', null]) {
    assert.equal(asset(rel), null, JSON.stringify(rel));
  }
});

test('the document ctx\'s record(id): a plug-in group\'s, frozen, in the GET\'s shape (flat: no payload key); null for an unknown id or another type\'s item; no record on a built-in\'s ctx', async () => {
  const p = fixturePayload();
  // Observe the comment's ctx: the served runtime, its built-in draw made to
  // keep the ctx it is handed (a test-only edit of the document text).
  const head = 'BUILTIN.comment = { draw: function (g) {';
  const edit = (x) => {
    assert.ok(x.includes(head), 'the comment draw\'s head');
    return x.replace(head, 'BUILTIN.comment = { draw: function (g, ctx) { window.__commentCtx = ctx;');
  };
  const { win } = open(documentOf(p, fixture().node, edit));
  const box = fBoxDraw(win);
  win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
  await settled(win);
  const { record } = box.ctx;
  assert.equal(typeof record, 'function', 'a plug-in group\'s ctx carries record');
  const b1 = p.items.find((it) => it.id === 'b1');
  const rec = record('b1');
  // ONE SHAPE in both realms (U522b; finding U565@ctx-record-shape): the
  // GET's, FLAT — the payload's keys beside id, v, type, schema, anchor and
  // shared, never nested under `payload`.
  assert.deepEqual(JSON.parse(JSON.stringify(rec)), { id: b1.id, v: b1.v, type: b1.type, schema: b1.schema, anchor: b1.anchor,
    shared: b1.shared, ...b1.payload }, 'the GET\'s shape, flat, built from the data element\'s item');
  assert.deepEqual(Object.keys(rec), ['id', 'v', 'type', 'schema', 'anchor', 'shared', ...Object.keys(b1.payload)]);
  assert.equal(rec.label, 'framed', 'a payload key read off the record itself');
  assert.equal(rec.payload, undefined, 'no nested payload: a document never nests it');
  assert.ok(Object.isFrozen(rec) && Object.isFrozen(rec.anchor), 'frozen, all the way down');
  assert.equal(markerOf(win, 'b1').getAttribute('data-f-box-label'), 'framed', 'the fixture draw wrote its record\'s label');
  assert.equal(record('nope'), null, 'an id the data element does not hold');
  assert.equal(record('c1'), null, 'another type\'s item');
  assert.equal(record(null), null);
  const cctx = win.__commentCtx;
  assert.ok(cctx && cctx.document === true, 'the comment\'s ctx was seen');
  assert.equal(cctx.record, undefined, 'a built-in\'s ctx has no record, as live');
});

test('the document ctx\'s record(id): a payload key named like one of the six base fields never overwrites it (the server\'s record() rule)', async () => {
  // A pack may declare a key `v` or `id` (PLUGIN_KEY_RE admits them); the
  // GET keeps its own field (lib/server/domain/elements.js record(): `if
  // (!(k in out))`), and so does the document.
  const p = fixturePayload();
  const b1 = p.items.find((it) => it.id === 'b1');
  b1.payload = { ...b1.payload, id: 'not-b1', v: 99, type: 'other', schema: 'other@1' };
  const { win } = open(documentOf(p));
  const box = fBoxDraw(win);
  win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
  await settled(win);
  const rec = box.ctx.record('b1');
  assert.ok(rec, 'the record by its own id');
  assert.deepEqual([rec.id, rec.v, rec.type, rec.schema], [b1.id, b1.v, b1.type, b1.schema], 'the six base fields win');
  assert.equal(rec.label, 'framed', 'the other payload keys still ride flat');
});

// THE PLUG-IN SETTINGS (U512c): a document has no saved settings and no armed
// tool, so a plug-in group's ctx.settings() answers its row's element.json
// defaults — the live draw ctx's answer for a type that is not armed.
test('the document ctx\'s settings(): a plug-in group\'s element.json defaults, frozen, {small, large}; {} levels for a row with none; no settings on a built-in\'s ctx', async () => {
  const p = fixturePayload();
  const DEFAULTS = { small: { tool: 'pen' }, large: { width: 4, colour: '#1f2328', probe: false } };
  p.types[0].settings = JSON.parse(JSON.stringify(DEFAULTS));
  assert.equal(E.validatePayload(p), null, 'a row\'s settings defaults validate');
  assert.ok(E.dataElement(p).includes('"settings":'), 'the defaults ride the data element');
  const head = 'BUILTIN.comment = { draw: function (g) {';
  const edit = (x) => x.replace(head, 'BUILTIN.comment = { draw: function (g, ctx) { window.__commentCtx = ctx;');
  const { win } = open(documentOf(p, fixture().node, edit));
  const box = fBoxDraw(win);
  win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
  await settled(win);
  assert.equal(typeof box.ctx.settings, 'function', 'a plug-in group\'s ctx carries settings');
  const got = box.ctx.settings();
  assert.deepEqual(JSON.parse(JSON.stringify(got)), DEFAULTS, 'the element.json defaults, by level');
  assert.deepEqual(Object.keys(got), ['small', 'large']);
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.small) && Object.isFrozen(got.large), 'frozen: nothing writes through the seam');
  assert.equal(got.small.tool, 'pen');
  assert.deepEqual([got.large.width, got.large.colour, got.large.probe], [4, '#1f2328', false]);
  try { got.large.width = 99; } catch { /* strict code throws; the value stands either way */ }
  assert.equal(box.ctx.settings().large.width, 4, 'a write to an answer changes no later answer');
  assert.equal(win.__commentCtx && win.__commentCtx.settings, undefined, 'a built-in\'s ctx has no settings, as live');
  // A row with no settings (an older builder's payload) reads as none.
  const q = fixturePayload();
  const { win: w2 } = open(documentOf(q));
  const box2 = fBoxDraw(w2);
  w2.__wcMount.elements.define('f-box', box2.draw, q.types[0].assets);
  await settled(w2);
  assert.deepEqual(JSON.parse(JSON.stringify(box2.ctx.settings())), { small: {}, large: {} });
  // The row's settings grammar.
  const bad = [
    [{ medium: {} }, /settings: medium is not a settings level/],
    [[], /settings is not \{small\?, large\?\}/],
    [{ small: [] }, /settings\.small is not an object/],
    [{ large: { width: Number.NaN } }, /settings\.large\.width is not a string, a finite number or a boolean/],
    [{ small: { tool: { nested: 1 } } }, /settings\.small\.tool is not a string/],
    [{ small: { tool: null } }, /settings\.small\.tool is not a string/],
  ];
  for (const [settings, want] of bad) {
    const r = fixturePayload();
    r.types[0].settings = settings;
    assert.match(String(E.validatePayload(r)), want, JSON.stringify(settings));
  }
});

test('a comment on a markdown item draws from the payload\'s sources table; without the table it is unplaced', async () => {
  const p = fixturePayload();
  assert.deepEqual(p.sources['md-notes'], (() => {
    const it = require('../lib/server/preview').pageItems(fixture().node, { sourceMap: true }).find((x) => x.md === 'md-notes');
    return { src: it.src, map: it.map };
  })(), 'the entry as pageItems(node, {sourceMap: true}) gives it');
  // The markdown item 40px in from the page's left edge: a gutter for the
  // margin glyph (SOURCE_GLYPH's -27px).
  const saved = BOXES['div.md-block'];
  BOXES['div.md-block'] = [40, 620, 760, 60];
  let win;
  try {
    win = open(documentOf(p)).win;
    await settled(win);
  } finally { BOXES['div.md-block'] = saved; }
  const s1 = markerOf(win, 's1');
  assert.ok(s1, 'drawn');
  assert.deepEqual(classes(s1).slice(0, 2), ['el-marker', 'el-hit']);
  assert.equal(s1.getAttribute('data-type'), 'comment');
  assert.deepEqual([px(s1.style.left), px(s1.style.top)], [40, MD_RANGE_BOX[1]],
    'the margin glyph (overlay.js marginItemOf): at the markdown item\'s left edge, level with the range\'s first line');
  assert.deepEqual(painted(s1), [40 + E.SOURCE_GLYPH.dx, MD_RANGE_BOX[1] + E.SOURCE_GLYPH.dy, E.MARKER_GLYPH.w, E.MARKER_GLYPH.h],
    'painted at the item\'s left edge plus SOURCE_GLYPH, the comment\'s glyph size kept (overlay.js marginGlyph)');
  assert.equal(s1.style.clipPath, '', 'in the gutter whole');
  assert.equal(s1.title, 'Only three? (0 replies)');

  const q = fixturePayload();
  delete q.sources;
  assert.equal(E.validatePayload(q), null);
  const w2 = open(documentOf(q)).win;
  await settled(w2);
  assert.equal(markerOf(w2, 's1'), undefined, 'no table, no marker');
  assert.equal(stats(w2).unplaced, 1, 'counted unplaced');
});

test('a margin glyph the document gives no gutter for is inset inside the .page box: never clipped, never dropped', async () => {
  // The fixture's markdown item starts at the page's own left edge (0): the
  // glyph's -27px would leave the .page box.
  assert.equal(BOXES['div.md-block'][0], BOXES['main.page'][0], 'no gutter');
  const { win } = open(documentOf(fixturePayload()));
  await settled(win);
  const s1 = markerOf(win, 's1');
  assert.ok(s1, 'drawn');
  assert.notEqual(s1.style.display, 'none', 'shown');
  assert.equal(s1.style.clipPath, '', 'not clipped');
  assert.deepEqual(painted(s1), [BOXES['main.page'][0], MD_RANGE_BOX[1] + E.SOURCE_GLYPH.dy, E.MARKER_GLYPH.w, E.MARKER_GLYPH.h],
    'its box clamped to the page\'s left edge, level with the range as before');
  assert.equal(stats(win).clipped, 0);

  // A page narrower than the glyph's top: the box clamped down inside it too.
  const saved = { md: BOXES['div.md-block'], page: BOXES['main.page'] };
  BOXES['main.page'] = [0, 648, 800, 552];
  BOXES['div.md-block'] = [0, 648, 800, 40];
  try {
    const w2 = open(documentOf(fixturePayload())).win;
    await settled(w2);
    const m = markerOf(w2, 's1');
    assert.notEqual(m.style.display, 'none');
    assert.deepEqual(painted(m).slice(0, 2), [0, 648], 'inside the .page box on both axes');
  } finally { Object.assign(BOXES, { 'div.md-block': saved.md, 'main.page': saved.page }); }
});

// A glyph plug-in type (place 'glyph') whose module exports a glyph and a
// sourceGlyph of its own, and an element item and a markdown item of it.
const F_DOT_GLYPH = { dx: -6, dy: -9, w: 12, h: 14 };
const F_DOT_SOURCE = { dx: -20, dy: 2 };
const F_DOT_MODULE = [
  '// f-dot: a dot, at its own glyph size.',
  `export const glyph = ${JSON.stringify(F_DOT_GLYPH)};`,
  `export const sourceGlyph = ${JSON.stringify(F_DOT_SOURCE)};`,
  'export default function draw(group, ctx) {',
  '  group.container.setAttribute(\'data-f-dot\', String(group.items.length));',
  '}',
  '',
].join('\n');
function dotPayload(module = F_DOT_MODULE) {
  const p = fixturePayload();
  const s1 = p.items.find((it) => it.id === 's1');
  p.types.push({ type: 'f-dot', schema: 'f-dot@1', reads: ['f-dot@1'], place: 'glyph', module,
    sha256: require('crypto').createHash('sha256').update(module).digest('hex'), assets: {}, skipped: [] });
  p.items.push(
    { id: 'd1', v: 1, type: 'f-dot', schema: 'f-dot@1', seq: 6, shared: true, answer: { state: 'exact' }, payload: {},
      anchor: convertAnchor({ mount: 'fx-a', selector: 'li.two', text: 'second', ordinal: 0 }) },
    { id: 'd2', v: 1, type: 'f-dot', schema: 'f-dot@1', seq: 7, shared: true, answer: null, payload: {},
      anchor: JSON.parse(JSON.stringify(s1.anchor)) });
  p.items.sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.equal(E.validatePayload(p), null);
  return p;
}
// Runs a type element's own text (the module's bytes and the one define line)
// in the document's realm, as the browser runs the module: jsdom runs no
// module script, so its two export forms are read as declarations.
function runTypeElement(win, el) {
  const body = el.slice('<script type="module">'.length, el.length - '</script>\n'.length);
  win.eval(body.replace('export default function draw(', 'function draw(').replace(/^export const /gm, 'var '));
}

test('a plug-in type\'s marker is sized by its glyph export, and its margin glyph drawn from its sourceGlyph, through the define line', async () => {
  const p = dotPayload();
  const row = p.types.find((r) => r.type === 'f-dot');
  const saved = BOXES['div.md-block'];
  BOXES['div.md-block'] = [40, 620, 760, 60];
  let win;
  try {
    win = open(documentOf(p)).win;
    win.__wcMount.elements.define('f-box', fBoxDraw(win).draw, p.types[0].assets);
    runTypeElement(win, E.typeElement(row));
    await settled(win);
  } finally { BOXES['div.md-block'] = saved; }
  const d1 = markerOf(win, 'd1');
  assert.ok(d1 && d1.getAttribute('data-f-dot') === '1', 'drawn by its type');
  assert.deepEqual(painted(d1), [BOXES['li.two'][0] + F_DOT_GLYPH.dx, BOXES['li.two'][1] + F_DOT_GLYPH.dy, F_DOT_GLYPH.w, F_DOT_GLYPH.h],
    'sized and offset by its glyph export, never MARKER_GLYPH (overlay.js glyphOf)');
  const d2 = markerOf(win, 'd2');
  assert.ok(d2 && d2.getAttribute('data-f-dot') === '1');
  assert.deepEqual(painted(d2), [40 + F_DOT_SOURCE.dx, MD_RANGE_BOX[1] + F_DOT_SOURCE.dy, F_DOT_GLYPH.w, F_DOT_GLYPH.h],
    'its margin glyph: the item\'s left edge plus its sourceGlyph, its glyph\'s size (overlay.js marginGlyph)');
  assert.deepEqual(painted(markerOf(win, 'c1')).slice(2), [E.MARKER_GLYPH.w, E.MARKER_GLYPH.h], 'the comment keeps the overlay\'s glyph');

  // A module that declares neither binding: the define line passes null for
  // each (typeof on an undeclared name), and the overlay's glyph is used.
  const bare = F_DOT_MODULE.split('\n').filter((l) => !/^export const /.test(l)).join('\n');
  const q = dotPayload(bare);
  const w2 = open(documentOf(q)).win;
  w2.__wcMount.elements.define('f-box', fBoxDraw(w2).draw, q.types[0].assets);
  runTypeElement(w2, E.typeElement(q.types.find((r) => r.type === 'f-dot')));
  await settled(w2);
  assert.deepEqual(painted(markerOf(w2, 'd1')), [BOXES['li.two'][0] + E.MARKER_GLYPH.dx, BOXES['li.two'][1] + E.MARKER_GLYPH.dy,
    E.MARKER_GLYPH.w, E.MARKER_GLYPH.h], 'no glyph export: MARKER_GLYPH');
  assert.deepEqual(painted(markerOf(w2, 'd2')).slice(0, 2), [MD_RANGE_BOX[0] + E.MARKER_GLYPH.dx, MD_RANGE_BOX[1] + E.MARKER_GLYPH.dy],
    'no sourceGlyph export: at its range\'s top-left, as live');

  // A glyph export that is not one: the type stands in (live's failed
  // registration), reported; a DOM node the name reaches is no export.
  const w3 = open(documentOf(q)).win;
  const errors = [];
  w3.console.error = (...a) => errors.push(a.join(' '));
  w3.__wcMount.elements.define('f-box', fBoxDraw(w3).draw, q.types[0].assets);
  let ran = 0;
  w3.__wcMount.elements.define('f-dot', () => { ran++; }, {}, { glyph: { dx: 0, dy: 0, w: 0, h: 4 }, sourceGlyph: null });
  await settled(w3);
  assert.equal(ran, 0, 'its draw never ran');
  assert.ok(classes(markerOf(w3, 'd1')).includes('el-standin'), 'the generic mark');
  assert.ok(errors.some((e) => /f-dot glyph or sourceGlyph export is not one/.test(e)));
  const w4 = open(documentOf(q)).win;
  w4.__wcMount.elements.define('f-box', fBoxDraw(w4).draw, q.types[0].assets);
  w4.__wcMount.elements.define('f-dot', () => {}, {}, { glyph: w4.document.getElementById('fx-a'), sourceGlyph: null });
  await settled(w4);
  assert.deepEqual(painted(markerOf(w4, 'd1')).slice(2), [E.MARKER_GLYPH.w, E.MARKER_GLYPH.h], 'a mount host named glyph is no glyph export');
  assert.ok(!classes(markerOf(w4, 'd1')).includes('el-standin'));
});

test('a type row with no module (a draw.js left out by the builder) splices without throwing; its items draw the generic mark', async () => {
  const p = fixturePayload();
  Object.assign(p.types[0], { module: '', assets: {}, skipped: [{ rel: 'draw.js', reason: 'draw-contract' }] });
  assert.equal(E.validatePayload(p), null);
  let html;
  assert.doesNotThrow(() => { html = E.scripts(p); });
  assert.strictEqual(html, E.runtimeElement(E.keyOf(p)) + E.dataElement(p), 'the runtime and the data, no type element');
  assert.ok(!html.includes('<script type="module">'));
  const { win } = open(documentOf(p));
  await settled(win);
  const b1 = markerOf(win, 'b1');
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(classes(b1).includes(c), c);
  assert.equal(b1.querySelector('.el-generic-name').textContent, 'f-box');
  assert.ok(markerOf(win, 'c1') && markerOf(win, 'h1') && markerOf(win, 's1'), 'the other items drew');
  assert.deepEqual(stats(win), { drawn: 3, generic: 2, parked: 0, unplaced: 0, clipped: 0 });
});

test('a plug-in type that defines nothing by load draws the generic mark; the other items still draw', async () => {
  const { win } = open(documentOf(fixturePayload()));
  await settled(win);
  const b1 = markerOf(win, 'b1');
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(classes(b1).includes(c), c);
  assert.equal(b1.querySelector('.el-generic-name').textContent, 'f-box');
  assert.equal(b1.getAttribute('data-type'), 'f-box');
  assert.equal(b1.getAttribute('data-place'), null, 'a glyph, not a box');
  assert.ok(markerOf(win, 'c1') && markerOf(win, 'h1') && markerOf(win, 's1'), 'the built-ins drew');
  assert.deepEqual(stats(win), { drawn: 3, generic: 2, parked: 0, unplaced: 0, clipped: 0 });
});

test('a draw that throws: the generic mark, nothing thrown out of the runtime, the other items drawn', async () => {
  const p = fixturePayload();
  const { win } = open(documentOf(p));
  const errors = [];
  win.console.error = (...a) => errors.push(a.join(' '));
  const box = fBoxDraw(win, { throws: true });
  win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
  await settled(win);
  assert.equal(box.calls, 1, 'the draw ran');
  const b1 = markerOf(win, 'b1');
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(classes(b1).includes(c), c);
  assert.equal(b1.getAttribute('data-place'), null, 'placed as a glyph');
  assert.notEqual(b1.style.display, 'none', 'shown');
  assert.ok(markerOf(win, 'c1') && markerOf(win, 'h1') && markerOf(win, 'r1') && markerOf(win, 's1'));
  assert.deepEqual(stats(win), { drawn: 3, generic: 2, parked: 0, unplaced: 0, clipped: 0 });
  assert.ok(errors.some((e) => /f-box draw failed/.test(e)), 'reported to the console');
});

test('a parked item — a schema its type does not read, or parked by the builder — draws the generic mark and its draw is never called', async () => {
  for (const park of [(it) => { it.schema = 'f-box@2'; }, (it) => { it.parked = true; it.payload = null; }]) {
    const p = fixturePayload();
    park(p.items[0]);
    assert.equal(E.validatePayload(p), null);
    const { win } = open(documentOf(p));
    const box = fBoxDraw(win);
    win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
    await settled(win);
    assert.equal(box.calls, 0, 'the type\'s draw never ran');
    const b1 = markerOf(win, 'b1');
    assert.ok(classes(b1).includes('el-generic') && classes(b1).includes('el-standin'));
    assert.equal(stats(win).parked, 1);
  }
});

test('a row served masked draws el-masked at its element', async () => {
  const p = fixturePayload();
  Object.assign(p.items[1], { state: 'masked', visible: 'Read the …', explain: 'This pin\'s words hold a value learned since.' });
  assert.equal(E.validatePayload(p), null);
  const { win } = open(documentOf(p));
  await settled(win);
  const c1 = markerOf(win, 'c1');
  assert.deepEqual(classes(c1).slice(0, 2), ['el-marker', 'el-masked']);
  assert.deepEqual([px(c1.style.left), px(c1.style.top)], [20, 40]);
});

test('a recorded orphan with no guess draws nothing and is not counted; a recorded hit the document cannot place is counted unplaced', async () => {
  const missing = convertAnchor({ mount: 'fx-a', selector: 'p.gone', text: 'gone', ordinal: 0 });
  const p = fixturePayload();
  p.items.push({ id: 'z1', v: 1, type: 'comment', schema: 'comment@2', seq: 9, anchor: missing, shared: true,
    answer: { state: 'orphaned', how: 'locator-none' }, payload: { text: 'gone', replies: [] } });
  const { win } = open(documentOf(p));
  win.__wcMount.elements.define('f-box', fBoxDraw(win).draw, p.types[0].assets);
  await settled(win);
  assert.equal(markerOf(win, 'z1'), undefined, 'no marker');
  assert.equal(stats(win).unplaced, 0, 'unplaced unchanged');

  const q = fixturePayload();
  q.items.push({ id: 'z1', v: 1, type: 'comment', schema: 'comment@2', seq: 9, anchor: missing, shared: true,
    answer: { state: 'exact' }, payload: { text: 'here once', replies: [] } });
  const w2 = open(documentOf(q)).win;
  w2.__wcMount.elements.define('f-box', fBoxDraw(w2).draw, q.types[0].assets);
  await settled(w2);
  assert.equal(markerOf(w2, 'z1'), undefined, 'no marker');
  assert.deepEqual(stats(w2), { drawn: 4, generic: 1, parked: 0, unplaced: 1, clipped: 0 });
});

test('a recorded orphan the document finds is drawn as a guess (el-guess) at the element it found', async () => {
  const p = fixturePayload();
  p.items[1].answer = { state: 'orphaned', how: 'score-low' };
  const { win } = open(documentOf(p));
  await settled(win);
  const c1 = markerOf(win, 'c1');
  assert.ok(classes(c1).includes('el-guess'));
  assert.deepEqual([px(c1.style.left), px(c1.style.top)], [20, 40]);
});

test('a point record draws its glyph at pointAt over its target (U531\'s entry)', async () => {
  const first = open(documentOf(fixturePayload())).win;
  await settled(first);
  const A = first.__wcMount.anchor;
  const svg = first.document.getElementById('fx-b').shadowRoot.querySelector('svg.chart');
  const rec = JSON.parse(JSON.stringify(A.recordPoint(svg.getRootNode(), svg, 150, 775, { mount: 'fx-b' })));
  assert.equal(rec.kind, 'point');
  const p = fixturePayload();
  p.items.push({ id: 'p1', v: 1, type: 'comment', schema: 'comment@2', seq: 5, anchor: rec, shared: true, answer: null,
    payload: { text: 'here', replies: [] } });
  const { win } = open(documentOf(p));
  await settled(win);
  const m = markerOf(win, 'p1');
  assert.ok(m, 'drawn');
  assert.deepEqual([px(m.style.left), px(m.style.top)], [150, 775], 'at the point, not the target\'s corner');
});

test('a glyph whose anchor lies outside its pane\'s host is clipped, not drawn', async () => {
  const saved = BOXES['p.lead'];
  BOXES['p.lead'] = [900, 40, 300, 20];
  try {
    const { win } = open(documentOf(fixturePayload()));
    await settled(win);
    assert.equal(markerOf(win, 'c1').style.display, 'none');
    assert.equal(stats(win).clipped, 1);
  } finally { BOXES['p.lead'] = saved; }
});

test('a glyph whose painted box meets a displayed frame is not drawn (the overlay\'s never-draw rule)', async () => {
  BOXES['iframe.emb'] = [0, 0, 50, 50];
  try {
    const node = fixture().node;
    node.mounts[0].html = node.mounts[0].html.replace('</div>', '<iframe class="emb"></iframe></div>');
    const p = fixturePayload();
    const { win } = open(documentOf(p, node));
    win.__wcMount.elements.define('f-box', fBoxDraw(win).draw, p.types[0].assets);
    await settled(win);
    assert.equal(markerOf(win, 'c1').style.display, 'none', 'the pin over the frame is not drawn');
    assert.notEqual(markerOf(win, 'h1').style.display, 'none', 'a glyph clear of the frame still is');
    assert.equal(stats(win).clipped, 1);
  } finally { delete BOXES['iframe.emb']; }
});

test('a comment with no reply of Claude\'s is not drawn answered', async () => {
  const p = fixturePayload();
  p.items[1].payload.replies = [{ text: 'A note of my own.', claude: false }];
  const { win } = open(documentOf(p));
  await settled(win);
  const c1 = markerOf(win, 'c1');
  assert.ok(c1 && !classes(c1).includes('replied'), 'not answered: no reply is Claude\'s');
  assert.equal(c1.title, 'Is this the right lead? (1 reply)');
});

test('a box marker is clipped to its pane\'s host, and never drawn over a displayed frame', async () => {
  const saved = BOXES['svg.chart'];
  BOXES['svg.chart'] = [700, 750, 200, 100];
  try {
    const p = fixturePayload();
    const { win } = open(documentOf(p));
    win.__wcMount.elements.define('f-box', fBoxDraw(win).draw, p.types[0].assets);
    await settled(win);
    const b1 = markerOf(win, 'b1');
    assert.deepEqual([b1.style.left, b1.style.width], ['700px', '200px'], 'the container is still the target\'s rect');
    assert.equal(b1.style.clipPath, 'inset(0px 100px 0px 0px)', 'cut at the host\'s right edge (800px)');
    assert.notEqual(b1.style.display, 'none');
  } finally { BOXES['svg.chart'] = saved; }

  BOXES['iframe.emb'] = [60, 760, 50, 50];
  try {
    const p = fixturePayload();
    const node = fixture().node;
    node.mounts[1].html = node.mounts[1].html.replace('</figure>', '<iframe class="emb"></iframe></figure>');
    const { win } = open(documentOf(p, node));
    const box = fBoxDraw(win);
    win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
    await settled(win);
    const b1 = markerOf(win, 'b1');
    assert.equal(b1.style.display, 'none', 'not drawn over the frame');
    assert.equal(box.calls, 0, 'and its draw never ran');
    assert.equal(stats(win).clipped, 1);
  } finally { delete BOXES['iframe.emb']; }
});

// ── page strokes (U621; REQ@ink-scope-v2 b+, REQ@arrow-endpoints a) ────────
// A page stroke is an item whose anchor is a strokes type's page record
// (lib/core/strokes pageRecord): placed by its items through U613's mapPage,
// spliced into the page cut as the ordered DOC_SPLICE set (J1 a).

const strokes = require('../lib/core/strokes');
const PAGE_FRAME = { w: 800, h: 1200 };
// A box of BOXES as mapPage reads a rect, at the window's x scale.
const rectAt = (key, s = 1) => {
  const [l, tp, w, h] = BOXES[key];
  return { left: l * s, top: tp, width: w * s, height: h };
};
// A straight stroke from p0 to p1 (page px), n samples in the page frame's
// 0..1 units.
function lineOf(p0, p1, n = 5) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push((p0[0] + (p1[0] - p0[0]) * i / (n - 1)) / PAGE_FRAME.w, (p0[1] + (p1[1] - p0[1]) * i / (n - 1)) / PAGE_FRAME.h, 0.5, i * 10);
  }
  return out;
}
// An endpoint's record: the page point p in item `key`'s box units.
const endOf = (item, key, p) => {
  const [l, tp, w, h] = BOXES[key] || [0, 0, 100, 40];
  return { item, x: (p[0] - l) / w, y: (p[1] - tp) / h, w, h };
};
// An f-box item (place 'box') drawn as a page stroke from p0 in `from` to p1
// in `to` (each [item id, BOXES key]).
function pageItem(id, from, to, p0, p1) {
  const anchor = strokes.pageRecord({ from: endOf(from[0], from[1], p0), to: endOf(to[0], to[1], p1), frame: PAGE_FRAME });
  assert.ok(strokes.isPageRecord(anchor), `${id}: a page record`);
  return {
    id, v: 1, type: 'f-box', schema: 'f-box@1', seq: 9, anchor, shared: true, answer: null,
    payload: { label: id, tool: 'pen', colour: 'ink', width: 0.004, points: lineOf(p0, p1), stride: 4, aspect: PAGE_FRAME.w / PAGE_FRAME.h },
  };
}
function withItems(p, ...items) {
  p.items.push(...items);
  p.items.sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.equal(E.validatePayload(p), null, E.validatePayload(p) || '');
  return p;
}
const ARROW = (id, dx = 0) => pageItem(id, ['fx-a', 'fx-a'], ['fx-b', 'fx-b'], [400 + dx, 540], [400 + dx, 740]);
const boxOfMarker = (m) => [px(m.style.left), px(m.style.top), px(m.style.width), px(m.style.height)];
const near = (a, b, what, tol = 1) => {
  assert.equal(a.length, b.length, what);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= tol, `${what}: [${a}] vs [${b}]`));
};
// mapPage's union box over items, at the rects of `rects` ({id: rect}).
function unionOf(items, rects) {
  let u = null;
  for (const it of items) {
    const m = strokes.mapPage(it.anchor, it.payload, rects[it.anchor.from.item] || null, rects[it.anchor.to.item] || null);
    if (!m) continue;
    const b = m.box;
    u = u ? { l: Math.min(u.l, b.left), t: Math.min(u.t, b.top), r: Math.max(u.r, b.left + b.w), b: Math.max(u.b, b.top + b.h) }
      : { l: b.left, t: b.top, r: b.left + b.w, b: b.top + b.h };
  }
  return u ? { left: u.l, top: u.t, w: u.r - u.l, h: u.b - u.t } : null;
}
function openPage(p, node) {
  const { win, net } = open(documentOf(p, node));
  const errors = [];
  win.console.error = (...a) => errors.push(a.join(' '));
  const box = fBoxDraw(win);
  win.__wcMount.elements.define('f-box', box.draw, p.types[0].assets);
  return { win, net, errors, box };
}

test('a page stroke between two items is one box marker at mapPage\'s union box (data-el-ids, data-place box); re-mapped when an item moves; no ReferenceError, no network', async (t) => {
  const p = withItems(fixturePayload(), ARROW('p1'), ARROW('p2', 30));
  assert.equal(E.keyOf(p), 'comment+highlight+box+page', 'the page cut');
  const { win, net, errors, box } = openPage(p);
  await settled(win);
  const m = markerOf(win, 'p1');
  assert.ok(m, 'the page stroke is drawn');
  assert.equal(m.getAttribute('data-el-ids'), 'p1 p2', 'one group: (type, from.item, to.item)');
  assert.equal(m.getAttribute('data-place'), 'box');
  assert.equal(m.getAttribute('data-type'), 'f-box');
  assert.ok(classes(m).includes('el-hit') && !classes(m).includes('el-generic'), 'drawn by its type, as a hit');
  const rects = { 'fx-a': rectAt('fx-a'), 'fx-b': rectAt('fx-b') };
  const u = unionOf([p.items.find((x) => x.id === 'p1'), p.items.find((x) => x.id === 'p2')], rects);
  near(boxOfMarker(m), [u.left, u.top, u.w, u.h], 'the union box, within 1 px');
  assert.equal(m.getAttribute('data-f-box-label'), 'p1', 'the draw read its record');
  assert.notEqual(m.style.display, 'none');
  const calls = box.calls;
  assert.deepEqual(stats(win), { drawn: 6, generic: 1, parked: 0, unplaced: 0, clipped: 0 });

  // The document's column 1.5× as wide: each arrow re-mapped between its
  // items, so the two drift apart and the group's box widens: its draw re-run
  // (a re-mapped stroke is no rescale of the old box).
  win.__scale = 1.5;
  win.dispatchEvent(new win.Event('resize'));
  const u2 = unionOf(p.items.filter((x) => x.id[0] === 'p'), { 'fx-a': rectAt('fx-a', 1.5), 'fx-b': rectAt('fx-b', 1.5) });
  near(boxOfMarker(m), [u2.left, u2.top, u2.w, u2.h], 'at 1.5×: re-mapped between its items');
  assert.equal(box.calls, calls + 1, 'a new box size: the draw re-run');
  win.__scale = 1;
  win.dispatchEvent(new win.Event('resize'));
  assert.equal(box.calls, calls + 2, 'and back');
  // fx-b moved down: the arrow is stretched between its items, its draw re-run.
  const saved = BOXES['fx-b'];
  BOXES['fx-b'] = [0, 900, 800, 400];
  try {
    win.dispatchEvent(new win.Event('resize'));
    const u3 = unionOf(p.items.filter((x) => x.id[0] === 'p'), { 'fx-a': rectAt('fx-a'), 'fx-b': rectAt('fx-b') });
    near(boxOfMarker(m), [u3.left, u3.top, u3.w, u3.h], 'an item moved: re-mapped');
    assert.ok(u3.h > u.h + 150, 'the arrow follows both ends');
    assert.equal(box.calls, calls + 3, 'a new box size: the draw re-run');
    assert.equal(m.querySelectorAll('svg').length, 1, 'drawn again, once');
  } finally { BOXES['fx-b'] = saved; }
  assert.deepEqual(errors.filter((e) => /ReferenceError|failed|could not/.test(e)), [], 'no ReferenceError, no failed pass');
  assert.equal(net.calls, 0, 'no network call');
  t.diagnostic(`page marker ${JSON.stringify(boxOfMarker(m))}; stats ${JSON.stringify(stats(win))}`);
});

test('a margin (\'beside\') stroke is drawn beside its item and follows it when the item moves', async () => {
  const it = pageItem('p3', ['fx-a', 'fx-a'], ['fx-a', 'fx-a'], [80, 606], [320, 612]);
  assert.equal(strokes.pageShape(it.anchor), 'beside');
  const p = withItems(fixturePayload(), it);
  const { win, errors, box } = openPage(p);
  await settled(win);
  const m = markerOf(win, 'p3');
  const calls = box.calls;
  assert.ok(m && m.getAttribute('data-place') === 'box', 'a box marker');
  const at = (rects) => { const u = unionOf([it], rects); return [u.left, u.top, u.w, u.h]; };
  const before = at({ 'fx-a': rectAt('fx-a') });
  near(boxOfMarker(m), before, 'beside fx-a');
  assert.ok(before[1] > BOXES['fx-a'][1] + BOXES['fx-a'][3], 'below the item: in its margin');
  const saved = BOXES['fx-a'];
  BOXES['fx-a'] = [0, 50, 800, 600];
  try {
    win.dispatchEvent(new win.Event('resize'));
    near(boxOfMarker(m), [before[0], before[1] + 50, before[2], before[3]], 'moved 50 px down with its item');
    assert.equal(box.calls, calls, 'a translation: the same box, no redraw');
    win.__scale = 1.5;
    win.dispatchEvent(new win.Event('resize'));
    const wide = at({ 'fx-a': rectAt('fx-a', 1.5) });
    near(boxOfMarker(m), wide, 'a wider column: translated with its item');
    near([wide[2], wide[3]], [before[2], before[3]], 'never stretched (the drift is beside, not a state)', 0.01);
  } finally { BOXES['fx-a'] = saved; win.__scale = 1; }
  assert.deepEqual(errors, []);
});

test('a page stroke with one endpoint item missing is drawn as a guess; with both missing it is not drawn and counted unplaced', async () => {
  // Recorded over fx-a's and fx-b's boxes, under item ids the document lacks.
  const half = pageItem('p4', ['fx-a', 'fx-a'], ['gone-b', 'fx-b'], [400, 540], [400, 740]);
  const none = pageItem('p5', ['gone-a', 'fx-a'], ['gone-b', 'fx-b'], [400, 540], [400, 740]);
  const p = withItems(fixturePayload(), half, none);
  const { win, box } = openPage(p);
  await settled(win);
  const m = markerOf(win, 'p4');
  assert.ok(m, 'drawn');
  assert.ok(classes(m).includes('el-guess'), 'as a guess (el-guess)');
  const g = box.groups.find((x) => x.items.some((i) => i.id === 'p4'));
  assert.equal(g.kind, 'guess', 'the group\'s kind: its type\'s draw fades it');
  const u = unionOf([half], { 'fx-a': rectAt('fx-a') });
  near(boxOfMarker(m), [u.left, u.top, u.w, u.h], 'at mapPage\'s guess');
  assert.equal(markerOf(win, 'p5'), undefined, 'both items gone: not drawn');
  assert.equal(stats(win).unplaced, 1, 'and counted unplaced');
  assert.ok(!box.groups.some((x) => x.items.some((i) => i.id === 'p5')), 'its draw never saw it');
});

test('a page stroke of a type that defines nothing by load draws the generic mark at its from item', async () => {
  const p = withItems(fixturePayload(), ARROW('p1'));
  const { win } = open(documentOf(p));
  await settled(win);
  const m = markerOf(win, 'p1');
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(classes(m).includes(c), c);
  assert.equal(m.getAttribute('data-place'), null, 'a glyph, not a box');
  assert.deepEqual([px(m.style.left), px(m.style.top)], BOXES['fx-a'].slice(0, 2), 'at its from item\'s top-left');
  assert.deepEqual(stats(win), { drawn: 3, generic: 3, parked: 0, unplaced: 0, clipped: 0 });
});

test('record(id) of a page stroke: the flat record, its points in [0, 1] of its marker\'s box (the spliced reboxPoints over its mapPage points), width and aspect mapped', async () => {
  const p = withItems(fixturePayload(), ARROW('p1'), ARROW('p2', 30));
  const { win, box } = openPage(p);
  await settled(win);
  const rects = { 'fx-a': rectAt('fx-a'), 'fx-b': rectAt('fx-b') };
  const items = p.items.filter((x) => x.id[0] === 'p');
  const u = unionOf(items, rects);
  near(boxOfMarker(markerOf(win, 'p1')), [u.left, u.top, u.w, u.h], 'the marker\'s box');
  for (const it of items) {
    const rec = box.ctx.record(it.id);
    assert.ok(Object.isFrozen(rec) && Object.isFrozen(rec.points), 'frozen');
    assert.ok(!('payload' in rec), 'flat');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rec.anchor)), it.anchor, 'its page record');
    assert.equal(rec.label, it.id);
    const mp = strokes.mapPage(it.anchor, it.payload, rects['fx-a'], rects['fx-b']);
    const want = strokes.reboxPoints(mp.points, mp.box, u);
    assert.equal(rec.points.length, it.payload.points.length);
    rec.points.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `${it.id} points[${i}]: ${v} vs ${want[i]}`));
    for (let i = 0; i < rec.points.length; i += 4) {
      assert.ok(rec.points[i] >= 0 && rec.points[i] <= 1 && rec.points[i + 1] >= 0 && rec.points[i + 1] <= 1, `${it.id}: sample ${i / 4} in the box`);
    }
    assert.ok(Math.abs(rec.width - mp.width * mp.box.w / u.w) < 1e-9, 'width: the recorded px width over the box');
    assert.ok(Math.abs(rec.aspect - u.w / u.h) < 1e-9, 'aspect: the box\'s');
  }
  assert.equal(box.ctx.record('b1').points, undefined, 'a pane-framed item\'s record is unchanged');
});

test('the page cut carries every DOC_SPLICE function by name, in order, each its own source in lib/core/strokes.js; no other copy of the mapping; no page arm in a cut without a page stroke', () => {
  const src = E.runtimeSource('comment+highlight+box+page');
  let at = -1;
  for (const name of strokes.DOC_SPLICE) {
    const own = anchorsSrc.compact(strokes[name].toString());
    assert.ok(own.startsWith(`function ${name}(`), name);
    const i = src.indexOf(own);
    assert.ok(i > at, `${name}: present, after the one before it in DOC_SPLICE`);
    assert.equal(src.indexOf(own, i + 1), -1, `${name}: once`);
    at = i;
  }
  for (const name of strokes.DOC_SPLICE) assert.equal(src.split(`function ${name}(`).length - 1, 1, `one ${name}`);
  // The factory's own text holds no step of the mapping: only calls.
  const own = elementsRuntimeOwn();
  for (const step of ['qr * dx', 'fromBox.left +', 'Math.atan2', 'DEGENERATE_PX', 'STRIDE']) assert.ok(!own.includes(step), `no copy: ${step}`);
  for (const name of strokes.DOC_SPLICE) assert.ok(!own.includes(`function ${name}(`), `the factory declares no ${name}`);
  for (const key of ['', 'comment', 'comment+highlight', 'comment+highlight+box']) {
    const cut = E.runtimeSource(key);
    assert.ok(!cut.includes('function mapPage(') && !cut.includes('function pageAdd('), `${key || '(core)'}: no page arm`);
  }
  assert.equal(E.keyOf(fixturePayload()), 'comment+highlight+box', 'a pane-framed stroke\'s document: no page cut');
});

test('validatePayload admits a page stroke\'s record and refuses a box grab\'s page anchor', () => {
  assert.equal(E.validatePayload(withItems(fixturePayload(), ARROW('p1'))), null);
  const grab = { v: 1, kind: 'page', item: 'fx-a', mount: 'fx-a', rect: { x: 1, y: 2, w: 3, h: 4 }, box: { w: 800, h: 600 }, scroll: { x: 0, y: 0 }, viewport: { w: 1200, h: 800 } };
  const p = fixturePayload();
  p.items[1].anchor = grab;
  assert.match(String(E.validatePayload(p)), /items\[1\]: a page anchor that is no stroke's page record is never drawn/);
  const q = withItems(fixturePayload(), ARROW('p1'));
  q.items.find((x) => x.id === 'p1').anchor.extra = 1;
  assert.match(String(E.validatePayload(q)), /page anchor that is no stroke's page record/, 'the closed shape: one key more is refused');
});

// ── the splice ─────────────────────────────────────────────────────────────

test('typeElement(row): the module\'s exact bytes, a newline, the one define line', () => {
  const row = fixturePayload().types[0];
  assert.strictEqual(E.typeElement(row), '<script type="module">' + F_BOX_MODULE + '\n'
    + `window.__wcMount.elements.define("f-box", draw, ${jsonForScript(row.assets)}, `
    + '{glyph: typeof glyph === \'undefined\' ? null : glyph, sourceGlyph: typeof sourceGlyph === \'undefined\' ? null : sourceGlyph});'
    + '</script>\n');
});

test('typeElement refuses a module holding a script end tag or a comment opener, in either case', () => {
  const row = fixturePayload().types[0];
  for (const bad of ['</script>', '</SCRIPT >', '</ScRiPt', '<!--', '<!-- x -->']) {
    assert.throws(() => E.typeElement({ ...row, module: `${F_BOX_MODULE}\n// ${bad}\n` }), /unsafe-splice/, bad);
  }
  assert.throws(() => E.typeElement({ ...row, module: 'export default (g) => {};' }), /export default function draw\(/);
});

test('scripts(): \'\' for null or no items; else runtime + each type + data, in that order', () => {
  assert.strictEqual(E.scripts(null), '');
  assert.strictEqual(E.scripts(undefined), '');
  assert.strictEqual(E.scripts({ ...fixturePayload(), items: [] }), '');
  const p = fixturePayload();
  assert.strictEqual(E.keyOf(p), 'comment+highlight+box');
  assert.strictEqual(E.scripts(p), E.runtimeElement('comment+highlight+box') + E.typeElement(p.types[0]) + E.dataElement(p));
  assert.ok(E.runtimeElement('comment').startsWith('<script>') && E.runtimeElement('comment').endsWith('</script>\n'));
});

test('dataElement: the payload less each row\'s module and assets, escaped as jsonForScript escapes', () => {
  const p = fixturePayload();
  p.items[1].payload.text = 'a </script><!-- &     >';
  const el = E.dataElement(p);
  const { module: _m, assets: _a, ...row } = p.types[0];
  assert.strictEqual(el, `<script type="application/json" data-wc-elements>${jsonForScript({ ...p, types: [row] })}</script>\n`);
  const body = el.slice(el.indexOf('>') + 1, el.lastIndexOf('</script>'));
  for (const ch of ['<', '>', '&', ' ', ' ']) assert.ok(!body.includes(ch), `no raw ${JSON.stringify(ch)}`);
  assert.equal(JSON.parse(body).items[1].payload.text, p.items[1].payload.text, 'it parses back to the text');
});

// ── the contract ───────────────────────────────────────────────────────────

test('validatePayload accepts the fixture; the field lists are frozen', () => {
  assert.equal(E.validatePayload(fixturePayload()), null);
  assert.equal(E.validatePayload(fixture().payload), null);
  for (const k of ['BUILTIN_TYPES', 'PAYLOAD_KEYS', 'TYPE_KEYS', 'ITEM_KEYS', 'ANSWER_KEYS', 'SKIPPED_KEYS', 'STRIPPED_KEYS', 'FORBIDDEN', 'DRAW_RULES']) {
    assert.ok(Object.isFrozen(E[k]), k);
  }
  const p = fixturePayload();
  p.stripped = [{ kind: 'asset', type: 'f-box', rel: 'big.png', bytes: 300000, reason: 'over the cap' }];
  assert.equal(E.validatePayload(p), null, 'the export cap\'s stripped list');
  const q = fixturePayload();
  assert.ok(isObjectWith(q.sources, 'md-notes'), 'the fixture carries the sources table');
  q.sources['md-notes'].src = 'x'.repeat(MARKDOWN_MAX_CHARS);
  q.sources['md-notes'].map.runs = Array.from({ length: MARKDOWN_MAX_CHARS + 1 - q.sources['md-notes'].map.headings.length },
    (_, i) => [i, i + 1, 1, 'exact']);
  assert.equal(E.validatePayload(q), null, 'a row at its bound: src at MARKDOWN_MAX_CHARS, map at src.length + lines entries');
  assert.equal(E.SOURCE_MAP_PER_LINE, undefined, 'no per-line figure (RULED U522a@sources-bound-per-character a)');
});

// This repository's own markdown, split into blocks (blank lines outside a
// fence) and each cut to MARKDOWN_MAX_CHARS on line boundaries (the one cap
// on a markdown item): every block's sourceMap, as pageItems gives it, fits.
function markdownBlocks(text) {
  const out = [];
  let cur = [];
  let fence = false;
  const flush = () => {
    let chunk = [];
    for (const l of cur) {
      if (chunk.length && [...chunk, l].join('\n').length > MARKDOWN_MAX_CHARS) { out.push(chunk.join('\n')); chunk = []; }
      chunk.push(l);
    }
    if (chunk.length) out.push(chunk.join('\n'));
    cur = [];
  };
  for (const l of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && !l.trim()) flush(); else cur.push(l);
  }
  flush();
  return out;
}
test('the sources bound holds for real markdown: this repository\'s CLAUDE.md, README.md and rules file validate, block by block', (t) => {
  const { pageItems } = require('../lib/server/preview');
  const root = path.join(__dirname, '..');
  const one = 'Use `a`, `b`, `c`, `d` and `e`.';
  const counts = {};
  for (const f of ['CLAUDE.md', 'README.md', path.join('.claude', 'rules', 'web-chat.md')]) {
    const blocks = [one, ...markdownBlocks(fs.readFileSync(path.join(root, f), 'utf8'))];
    let refused = 0;
    for (const text of blocks) {
      const node = { ...fixture().node, markdown: [{ id: 'md-notes', text }] };
      const it = pageItems(node, { sourceMap: true }).find((x) => x.md === 'md-notes');
      const p = fixturePayload();
      p.sources['md-notes'] = { src: it.src, map: it.map };
      const why = E.validatePayload(p);
      if (why) { refused++; t.diagnostic(`${f}: ${why}`); }
    }
    counts[f] = `${blocks.length - 1} blocks, ${refused} refused`;
    assert.equal(refused, 0, `${f}: every block's map fits its src`);
  }
  t.diagnostic(JSON.stringify(counts));
  const m = require('../lib/core/markdown').sourceMap(one);
  assert.ok(m.runs.length > 4, `the inline-code line: ${m.runs.length} runs on one line, over the withdrawn 4 per line`);
});
const isObjectWith = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

test('validatePayload refuses each malformed variant', () => {
  const cases = [
    ['an extra key on the payload', (p) => { p.extra = 1; }, /unknown key extra/],
    ['an extra key on a type', (p) => { p.types[0].extra = 1; }, /types\[0\]: unknown key extra/],
    ['an extra key on an item', (p) => { p.items[1].extra = 1; }, /items\[1\]: unknown key extra/],
    ['a writer field', (p) => { p.items[1].writer = 'pane:x'; }, /unknown key writer/],
    ['a provenance field', (p) => { p.items[1].provenance = {}; }, /unknown key provenance/],
    ['a chain field', (p) => { p.items[1].chain = []; }, /unknown key chain/],
    ['a writer in a plug-in payload', (p) => { p.items[0].payload.writer = 'x'; }, /writer is never in a payload/],
    ['a chain in a plug-in payload', (p) => { p.items[0].payload.chain = []; }, /chain is never in a payload/],
    ['an author on a reply', (p) => { p.items[1].payload.replies[0].author = 'claude'; }, /unknown key author/],
    ['a module on a removed type', (p) => { p.types.push({ ...p.types[0], type: 'f-gone' }); }, /a module on a removed type/],
    ['an http: asset', (p) => { p.types[0].assets['mark.svg'] = 'http://example.com/mark.svg'; }, /not a data: URI/],
    ['an asset key with an assets/ prefix', (p) => { p.types[0].assets = { 'assets/mark.svg': MARK_URI }; }, /not a path below assets/],
    ['an asset of a refused kind', (p) => { p.types[0].assets = { 'x.js': 'data:text/javascript;base64,AA==' }; }, /not a path below assets/],
    ['an item of an undeclared type', (p) => { p.items[2].type = 'f-who'; }, /in none of builtins, types and removed/],
    ['a payload on a parked item', (p) => { p.items[0].parked = true; }, /a payload on a parked item/],
    ['a payload on a removed type\'s item', (p) => { p.items[3].payload = { x: 1 }; }, /a payload on an item of a removed type/],
    ['a page anchor', (p) => { p.items[1].anchor = { kind: 'page', item: 'fx-a' }; }, /page anchor/],
    ['a state other than masked', (p) => { p.items[1].state = 'exact'; }, /served masked/],
    ['a built-in no item uses', (p) => { p.items.splice(2, 1); }, /highlight is listed but no item uses it/],
    ['the box grab as a built-in', (p) => { p.builtins = ['box-grab', 'comment', 'highlight']; }, /box-grab is not a built-in/],
    ['unsorted items', (p) => { p.items.reverse(); }, /items is not sorted/],
    ['v 2', (p) => { p.v = 2; }, /v is not 1/],
    ['a place outside PLACE_MODES', (p) => { p.types[0].place = 'band'; }, /place is not one of/],
    ['sources not an object', (p) => { p.sources = []; }, /sources is not an object/],
    ['a sources entry with no src', (p) => { delete p.sources['md-notes'].src; }, /sources\["md-notes"\] needs \{src, map\}/],
    ['a sources entry with no map', (p) => { delete p.sources['md-notes'].map; }, /sources\["md-notes"\] needs \{src, map\}/],
    ['a sources entry with an extra key', (p) => { p.sources['md-notes'].html = '<p>'; }, /unknown key html/],
    ['a sources entry no item names', (p) => { p.sources['md-other'] = { ...p.sources['md-notes'] }; }, /no source-anchored item names the markdown item md-other/],
    ['a src past MARKDOWN_MAX_CHARS', (p) => { p.sources['md-notes'].src = 'x'.repeat(MARKDOWN_MAX_CHARS + 1); }, /src is over MARKDOWN_MAX_CHARS \(32768 characters\): the markdown item md-notes/],
    ['a map past src.length + lines entries', (p) => {
      const { src, map } = p.sources['md-notes'];
      map.runs = Array.from({ length: src.length + 3 + 1 - map.headings.length }, (_, i) => [i, i + 1, 1, 'exact']);
    }, new RegExp(`map is over src\\.length \\+ lines entries \\(${fixturePayload().sources['md-notes'].src.length + 3}\\): the markdown item md-notes`)],
  ];
  for (const [what, mutate, want] of cases) {
    const p = fixturePayload();
    mutate(p);
    const why = E.validatePayload(p);
    assert.match(String(why), want, `${what}: ${why}`);
  }
});

// ── the runtime's source ───────────────────────────────────────────────────

// The factory's own text: the whole runtime less the DOC_SPLICE functions
// spliced into its page cut (lib/core/strokes.js's own source, held to its
// own rules by test/strokes-core.test.js: no module binding, Math alone).
function elementsRuntimeOwn() {
  let raw = E.runtimeText(E.SECTIONS);
  for (const name of strokes.DOC_SPLICE) {
    const own = `${strokes[name].toString()}\n`;
    assert.ok(raw.includes(own), `${name} spliced by its own source`);
    raw = raw.replace(own, () => '');
  }
  return raw;
}

// Re-stated at U621: the rules hold for the factory's own text; the spliced
// DOC_SPLICE functions are strokes.js's source byte for byte (J1 a), so they
// are left out of this scan (they are not ES5: const, arrows, a trailing
// comment naming each inlined literal's CONSTANTS entry).
test('the runtime\'s authoring rules: ES5, whole-line comments only, no block comment', () => {
  const raw = elementsRuntimeOwn();
  for (const line of raw.split('\n')) {
    const code = line.trim();
    if (code.startsWith('//')) continue;
    assert.ok(!code.includes('//'), `a comment after code, or a // in a string: ${code}`);
    assert.ok(!/=>|`|\blet\b|\bconst\b|\bclass\b|\.\.\.|\/\*|\*\*|\basync\b/.test(code), `ES5 only: ${code}`);
  }
});

test('the compacted runtime: no script end tag, comment opener, network, eval, dynamic import, blob:, chat words or element id', () => {
  for (const key of ['', 'comment', 'comment+highlight', 'comment+highlight+box', 'box', 'comment+highlight+box+page', 'page']) {
    const src = E.runtimeSource(key);
    for (const line of src.split('\n')) {
      assert.notEqual(line, '', 'no blank line');
      assert.ok(!/^\s/.test(line), `no indentation: ${line}`);
      assert.ok(!line.startsWith('//'), `no whole-line comment: ${line}`);
    }
    for (const bad of [/<\/script/i, /<!--/, /\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /import\(/, /new Function/, /\beval\(/,
      /blob:/, /chat-comment/, /pin-marker/, /el-layer-chat/, /\.id\s*=/, /setAttribute\(\s*'id'/]) {
      assert.doesNotMatch(src, bad, `${key || '(core)'}: ${bad}`);
    }
    assert.doesNotThrow(() => new Function(src), 'it parses');
  }
});

test('the runtime is cut per key: a comment-only document carries no highlight draw and no box placer', () => {
  const comment = E.runtimeSource('comment');
  assert.ok(comment.includes('BUILTIN.comment'));
  assert.ok(!comment.includes('BUILTIN.highlight') && !comment.includes('data-place=box'));
  assert.ok(E.runtimeSource('comment+highlight').includes('BUILTIN.highlight'));
  assert.ok(E.runtimeSource('comment+highlight+box').includes('data-place=box'));
  assert.equal(E.keyOf({ builtins: ['comment'], types: [] }), 'comment');
  assert.equal(E.keyOf({ builtins: [], types: [{ place: 'glyph' }] }), '');
  assert.throws(() => E.runtimeSource('box-grab'), /no runtime section/);
});

test('the runtime is compacted by anchors-src\'s exported compact: elements-doc-src.js has no compact of its own', () => {
  const text = fs.readFileSync(require.resolve('../lib/server/runtime/elements-doc-src'), 'utf8');
  assert.doesNotMatch(text, /function compact\(|compact\s*=\s*(function|\()/, 'no second compaction rule');
  assert.equal(typeof anchorsSrc.compact, 'function');
  for (const key of ['', 'comment', 'comment+highlight', 'comment+highlight+box', 'comment+highlight+box+page']) {
    const sections = key ? key.split('+') : [];
    assert.strictEqual(E.runtimeSource(key), anchorsSrc.compact(E.runtimeText(sections)), key || '(core)');
  }
});

test('the runtime: no work at require time, then memoised per key', () => {
  const key = require.resolve('../lib/server/runtime/elements-doc-src');
  const saved = require.cache[key];
  try {
    delete require.cache[key];
    const fresh = require('../lib/server/runtime/elements-doc-src');
    const real = fresh.runtimeText;
    let calls = 0;
    fresh.runtimeText = function () { calls++; return real.apply(this, arguments); };
    const a = fresh.runtimeSource('comment');
    assert.equal(calls, 1, 'read on first use');
    assert.strictEqual(fresh.runtimeSource('comment'), a);
    assert.equal(calls, 1, 'one compute per key across two calls');
    fresh.runtimeSource('comment+highlight');
    assert.equal(calls, 2, 'another key, another compute');
    assert.strictEqual(a, E.runtimeSource('comment'));
  } finally {
    require.cache[key] = saved;
  }
});

// The byte tripwire (B3's 5 % line; RULED BUDGET@typical-export a): the whole
// runtime's compacted size, measured at U522, plus 128 B. A crossing stops and
// asks; it is never a silent raise (U403b's precedent). Re-measured at U522's
// relaunch (record(id), the sources install, anchors-src's one compact), on
// the main session's engineering contract of 2026-11-03: 18,785 → 19,486;
// and at U522a (the margin glyph and its inset, a plug-in's glyph and
// sourceGlyph through the define line), on the same contract: → 21,107;
// and at U512c (a plug-in ctx's settings(), the element.json defaults: the
// U566 builder's contract), on the main session's engineering contract of
// 2026-11-03 that asks for that member: 21,176 at ae/int cd348616 → 21,365;
// and at U621 (the page arm: DOC_SPLICE spliced — isPageRecord, pageShape,
// reboxPoints, mapPage —, in its own 'page' cut, so the whole runtime is
// every section's and counts every spliced function), on PLAN-T5's
// RUNTIME@restate, 2026-11-05: 21,365 at ae/int 3d86c497 → 29,175 (the four
// spliced functions 5,111 B of it, compacted; 'comment+highlight+box', the
// cut with no page stroke, 21,596).
const RUNTIME_WHOLE_BYTES = 29175;
// The documents' share beside (C-17-share; RULED B3@documents-share-line a:
// the 12 % line, read by the gate, never a status here): the gate's
// gate-t4-exit reading at 627c5f53 — resolver 27,038 B (the element cut) +
// runtime 18,354 B (the comment cut, its script element) over a 414,422 B
// median export — with this build's runtime cut swapped in.
const SHARE_T4 = { resolver: 27038, runtime: 18354, median: 414422 };
test('the byte tripwire: the whole runtime under its measured size + 128 B; each cut reported; the documents\' share beside', (t) => {
  const sizes = {};
  for (const key of ['', 'comment', 'comment+highlight', 'comment+highlight+box', E.SECTIONS.join('+')]) {
    sizes[key || '(core)'] = Buffer.byteLength(E.runtimeSource(key));
  }
  t.diagnostic(`compacted runtime bytes: ${JSON.stringify(sizes)}`);
  t.diagnostic(`fixture splice bytes: ${Buffer.byteLength(E.scripts(fixturePayload()))}`);
  const spliced = strokes.DOC_SPLICE.reduce((n, name) => n + Buffer.byteLength(`${anchorsSrc.compact(strokes[name].toString())}\n`), 0);
  t.diagnostic(`the DOC_SPLICE functions in the page cut: ${spliced} B`);
  const share = (key) => {
    const rt = Buffer.byteLength(E.runtimeElement(key));
    return `${(100 * (SHARE_T4.resolver + rt) / (SHARE_T4.median - SHARE_T4.runtime + rt)).toFixed(2)} %`;
  };
  t.diagnostic(`C-17-share beside (the gate reads it against 12 %): the typical export (the comment cut) ${share('comment')}; `
    + `one carrying a pane-framed stroke ('comment+highlight+box') ${share('comment+highlight+box')}; `
    + `one carrying a page stroke (every section) ${share(E.SECTIONS.join('+'))}`);
  const whole = sizes[E.SECTIONS.join('+')];
  assert.ok(whole <= RUNTIME_WHOLE_BYTES + 128, `the runtime is ${whole} B; the tripwire is ${RUNTIME_WHOLE_BYTES} + 128`);
});

// ── parity with the live overlay ───────────────────────────────────────────

test('the DRAW_RULES copy and the glyphs equal public/app/overlay.js\'s, highlight.js\'s and comments.js\'s', async () => {
  const { bootShell } = require('../test-support/chrome-shell');
  const shell = await bootShell({});
  try {
    const ov = await shell.importApp('overlay.js');
    const pick = (r) => ({ state: r.state, how: r.how, guess: r.guess, draw: r.draw, cls: r.cls });
    assert.deepStrictEqual(E.DRAW_RULES.map(pick), ov.DRAW_RULES.map(pick));
    assert.deepStrictEqual({ ...E.MARKER_GLYPH }, { ...ov.MARKER_GLYPH });
    const hl = await shell.importApp('highlight.js');
    assert.deepStrictEqual({ ...E.HANDLE_GLYPH }, { ...hl.HANDLE_GLYPH });
    const cm = await shell.importApp('comments.js');
    assert.deepStrictEqual({ ...E.SOURCE_GLYPH }, { ...cm.SOURCE_GLYPH }, 'the comment\'s margin offsets');
  } finally {
    await shell.restore();
  }
});

// ── opt-in: a real Chrome, under PREVIEW_CSP ───────────────────────────────

// The fixture document under PREVIEW_CSP (a meta tag: a file:// page and a
// srcdoc frame have no header), reporting its CSP violations, its markers and
// its stats once loaded — to its parent when framed.
function cspDocument() {
  const html = documentOf(fixturePayload());
  const head = `<head>\n<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">\n<script>window.__v = 0;`
    + ' document.addEventListener(\'securitypolicyviolation\', function () { window.__v++; });</script>';
  const report = '<script>window.addEventListener(\'load\', function () { setTimeout(function () {'
    + ' var ms = document.querySelectorAll(\'.wc-el-layer .el-marker\'); var types = [];'
    + ' for (var i = 0; i < ms.length; i++) types.push(ms[i].getAttribute(\'data-type\') + (ms[i].className.indexOf(\'el-generic\') >= 0 ? \':generic\' : \'\'));'
    + ' var r = { v: window.__v, types: types.sort(), stats: window.__wcMount.elements.stats() };'
    + ' window.__report = r; if (window.parent !== window) window.parent.postMessage(r, \'*\'); }, 300); });</script>\n</body>';
  return html.replace('<head>', head).replace('</body>', report);
}

const e2e = e2eGate(['chrome']);
test('a real Chrome: the fixture type\'s inline module defines it and draws its marker, as a file:// page and in a sandboxed srcdoc frame, with no CSP violation', { skip: e2e.skip }, async (t) => {
  const { launchChrome } = require('../lib/replay/chrome');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-doc-el-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const doc = cspDocument();
  fs.writeFileSync(path.join(dir, 'doc.html'), doc);
  const attr = escapeHtml(doc);
  fs.writeFileSync(path.join(dir, 'frame.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + '<script>window.addEventListener(\'message\', function (e) { window.__report = e.data; });</script>'
    + `<iframe sandbox="allow-scripts" style="width:1000px;height:1200px" srcdoc="${attr}"></iframe></body></html>`);
  const browser = launchChrome({ chromePath: e2e.chrome, tmpDir: dir });
  t.after(() => browser.close());
  const { cdp } = browser;
  for (const page of ['doc.html', 'frame.html']) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1300, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `file://${path.join(dir, page)}` }, sessionId);
    const report = await waitUntil(async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: 'window.__report || null', returnByValue: true }, sessionId);
      return r && r.result ? r.result.value : null;
    }, { timeout: 15000, interval: 100, what: `${page}'s report` });
    t.diagnostic(`${page}: ${JSON.stringify(report)}`);
    assert.equal(report.v, 0, `${page}: no CSP violation`);
    assert.ok(report.types.includes('f-box'), `${page}: the type defined itself and drew (not the generic mark)`);
    assert.ok(report.types.includes('comment') && report.types.includes('f-gone:generic'), `${page}: the others drew`);
  }
});

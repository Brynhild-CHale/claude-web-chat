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
const { fixture, fixturePayload, F_BOX_MODULE, MARK_URI } = require('../test-support/doc-elements-fixture');
const { waitUntil, e2eGate } = require('../test-support/helpers');

const ALL_KINDS = anchorsSrc.RESOLVER_KINDS;
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });

// ── a document ──────────────────────────────────────────────────────────────

// The preview document of `node` with the resolver and the elements spliced
// after it, exactly where the template's anchors hole puts them.
function documentOf(payload, node = fixture().node) {
  const [a, b, c, d] = previewTemplate();
  return a + previewThemeCss({ tokens: {} }) + b + anchorsSrc.scriptElement({ kinds: ALL_KINDS })
    + E.scripts(payload) + c + previewNodeJson(node) + d;
}

// The fixture's boxes (viewport px), the x axis scaled by win.__scale.
const BOXES = {
  'fx-a': [0, 0, 800, 600],
  'fx-b': [0, 700, 800, 400],
  'p.lead': [20, 40, 300, 20],
  'p.body': [20, 80, 400, 20],
  'li.two': [40, 200, 100, 16],
  'svg.chart': [50, 750, 200, 100],
};
const RANGE_BOX = [60, 80, 120, 18];   // 'quick brown fox' inside p.body
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
const classes = (m) => m.className.split(/\s+/).filter(Boolean);
const stats = (win) => win.__wcMount.elements.stats();

// ── the document draws ─────────────────────────────────────────────────────

test('a document draws the fixture: the comment pin at its target, the highlight over its range, the box on its svg, the removed type\'s generic mark; no network', async (t) => {
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
  assert.equal(box.ctx.document, true);
  assert.equal(box.ctx.previewing, true);
  assert.equal(box.ctx.host, 'page');
  for (const k of ['create', 'input', 'tray', 'record']) assert.equal(box.ctx[k], undefined, `no ${k} in a document`);

  win.__scale = 1.5;
  win.dispatchEvent(new win.Event('resize'));
  assert.deepEqual([b1.style.left, b1.style.width, b1.style.height], ['75px', '300px', '100px'], 'the second width: rescaled');
  assert.equal(box.calls, 1, 'with no redraw');
  assert.deepEqual({ ...box.ctx.box }, { w: 300, h: 100 }, 'ctx.box read live');
  win.__scale = 1;
  win.dispatchEvent(new win.Event('resize'));

  const r1 = markerOf(win, 'r1');
  assert.ok(r1, 'the removed type is drawn');
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(classes(r1).includes(c), c);
  assert.equal(r1.querySelector('.el-generic-name').textContent, 'f-gone', 'the type named');

  // Every marker: its type and its group's ids, space-joined.
  const ids = { 'c1': 'comment', 'h1': 'highlight', 'b1': 'f-box', 'r1': 'f-gone' };
  const ms = markers(win);
  assert.equal(ms.length, 4);
  for (const m of ms) {
    assert.ok(m.hasAttribute('data-type') && m.hasAttribute('data-el-ids'), 'data-type and data-el-ids on every marker');
    assert.equal(m.getAttribute('data-type'), ids[m.getAttribute('data-el-ids')]);
  }
  assert.deepEqual(stats(win), { drawn: 3, generic: 1, parked: 0, unplaced: 0, clipped: 0 });
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

test('a plug-in type that defines nothing by load draws the generic mark; the other items still draw', async () => {
  const { win } = open(documentOf(fixturePayload()));
  await settled(win);
  const b1 = markerOf(win, 'b1');
  for (const c of ['el-marker', 'el-generic', 'el-standin']) assert.ok(classes(b1).includes(c), c);
  assert.equal(b1.querySelector('.el-generic-name').textContent, 'f-box');
  assert.equal(b1.getAttribute('data-type'), 'f-box');
  assert.equal(b1.getAttribute('data-place'), null, 'a glyph, not a box');
  assert.ok(markerOf(win, 'c1') && markerOf(win, 'h1'), 'the built-ins drew');
  assert.deepEqual(stats(win), { drawn: 2, generic: 2, parked: 0, unplaced: 0, clipped: 0 });
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
  assert.ok(markerOf(win, 'c1') && markerOf(win, 'h1') && markerOf(win, 'r1'));
  assert.deepEqual(stats(win), { drawn: 2, generic: 2, parked: 0, unplaced: 0, clipped: 0 });
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
  assert.deepEqual(stats(w2), { drawn: 3, generic: 1, parked: 0, unplaced: 1, clipped: 0 });
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

// ── the splice ─────────────────────────────────────────────────────────────

test('typeElement(row): the module\'s exact bytes, a newline, the one define line', () => {
  const row = fixturePayload().types[0];
  assert.strictEqual(E.typeElement(row), '<script type="module">' + F_BOX_MODULE + '\n'
    + `window.__wcMount.elements.define("f-box", draw, ${jsonForScript(row.assets)});` + '</script>\n');
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
});

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
  ];
  for (const [what, mutate, want] of cases) {
    const p = fixturePayload();
    mutate(p);
    const why = E.validatePayload(p);
    assert.match(String(why), want, `${what}: ${why}`);
  }
});

// ── the runtime's source ───────────────────────────────────────────────────

test('the runtime\'s authoring rules: ES5, whole-line comments only, no block comment', () => {
  const raw = E.runtimeText(E.SECTIONS);
  for (const line of raw.split('\n')) {
    const code = line.trim();
    if (code.startsWith('//')) continue;
    assert.ok(!code.includes('//'), `a comment after code, or a // in a string: ${code}`);
    assert.ok(!/=>|`|\blet\b|\bconst\b|\bclass\b|\.\.\.|\/\*|\*\*|\basync\b/.test(code), `ES5 only: ${code}`);
  }
});

test('the compacted runtime: no script end tag, comment opener, network, eval, dynamic import, blob:, chat words or element id', () => {
  for (const key of ['', 'comment', 'comment+highlight', 'comment+highlight+box', 'box']) {
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
// asks; it is never a silent raise (U403b's precedent).
const RUNTIME_WHOLE_BYTES = 18773;
test('the byte tripwire: the whole runtime under its measured size + 128 B; each cut reported', (t) => {
  const sizes = {};
  for (const key of ['', 'comment', 'comment+highlight', 'comment+highlight+box']) {
    sizes[key || '(core)'] = Buffer.byteLength(E.runtimeSource(key));
  }
  t.diagnostic(`compacted runtime bytes: ${JSON.stringify(sizes)}`);
  t.diagnostic(`fixture splice bytes: ${Buffer.byteLength(E.scripts(fixturePayload()))}`);
  const whole = sizes['comment+highlight+box'];
  assert.ok(whole <= RUNTIME_WHOLE_BYTES + 128, `the runtime is ${whole} B; the tripwire is ${RUNTIME_WHOLE_BYTES} + 128`);
});

// ── parity with the live overlay ───────────────────────────────────────────

test('the DRAW_RULES copy and the glyphs equal public/app/overlay.js\'s and highlight.js\'s', async () => {
  const { bootShell } = require('../test-support/chrome-shell');
  const shell = await bootShell({});
  try {
    const ov = await shell.importApp('overlay.js');
    const pick = (r) => ({ state: r.state, how: r.how, guess: r.guess, draw: r.draw, cls: r.cls });
    assert.deepStrictEqual(E.DRAW_RULES.map(pick), ov.DRAW_RULES.map(pick));
    assert.deepStrictEqual({ ...E.MARKER_GLYPH }, { ...ov.MARKER_GLYPH });
    const hl = await shell.importApp('highlight.js');
    assert.deepStrictEqual({ ...E.HANDLE_GLYPH }, { ...hl.HANDLE_GLYPH });
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

// What lies under one stroke, chrome side (annotation engine tranche 4, plan
// 4F.2, U562; public/app/ink-describe.js), in the real chrome
// (test-support/chrome-shell, booted once). jsdom does no layout, so every box
// is stubbed: an element's getBoundingClientRect, and a text node's Range
// client rects through Range.prototype.getClientRects (which jsdom lacks).
//
// Pinned here:
//   - main.js registers the deriver once, as 'describe', on the engine's
//     stroke commit (target-frame.js registerStrokeDerive): a real pen-down →
//     pen-up over an svg <text> posts the stroke with text_under, text_box and
//     its own bbox beside the stroke keys;
//   - over an svg: the <text>/<tspan> the stroke's box meets is taken, one it
//     misses is not; an underline just below the words meets them (the pad
//     above); text_box is the met rects' union in frame units;
//   - an <img>'s alt (else its aria-label) and a <canvas>'s aria-label (else
//     its fallback content's text) are taken whole, wherever the stroke is,
//     with no text_box;
//   - a [data-fixed-aspect] sheet's text nodes by their Range rects; at most
//     TEXT_NODES_MAX text nodes are read per stroke;
//   - text_under is cut at TEXT_UNDER_MAX, lib/core/ink-shape's own; nothing
//     outside the target is read; no text → no text_under and no text_box.
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const shape = require('../lib/core/ink-shape');

const TYPE = 'id-strokes';
const MANY = 260;
const PANE = {
  id: 'id1', target: 'main', params: {}, gen: 0,
  html: '<div class="wrap">'
    + '<p class="outside">Words outside every target</p>'
    + '<svg class="art" viewBox="0 0 200 100"><text class="t1" x="10" y="20">Revenue fell</text>'
    + '<text class="t2" x="10" y="80"><tspan class="ts">Costs rose</tspan></text><title>a chart title</title></svg>'
    + '<img class="pic" alt="A bar chart of revenue" aria-label="ignored" width="100" height="50">'
    + '<img class="pic2" aria-label="Quarterly totals" width="100" height="50">'
    + '<canvas class="cv" aria-label="A heat map" width="100" height="50">fallback ignored</canvas>'
    + '<canvas class="cv2" width="100" height="50"><p>Sales by region</p></canvas>'
    + '<div class="sheet" data-fixed-aspect><span class="s1">First line</span> <span class="s2">Second line</span></div>'
    + `<div class="big" data-fixed-aspect>${Array.from({ length: MANY }, (_, i) => `<span>w${i}</span>`).join('')}</div>`
    + '</div>',
};

let shell, W, M, ov, TF, I;
let nextId = 1;
const rangeRects = new Map();   // text node → [rect]
let rangeReads = 0;
const posts = () => shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements');
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const q = (sel) => rootOf('id1').querySelector(sel);
const R = (left, top, width, height) => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height });
function boxed(el, r) { el.getBoundingClientRect = () => r; return el; }
const SVG = R(100, 200, 200, 100);

function stubRects() {
  boxed(q('svg.art'), SVG);
  boxed(q('text.t1'), R(110, 210, 80, 14));     // frame units: x 0.05..0.45, y 0.10..0.24
  boxed(q('text.t2'), R(110, 270, 70, 14));     // y 0.70..0.84
  boxed(q('tspan.ts'), R(110, 270, 70, 14));
  boxed(q('img.pic'), R(10, 20, 100, 50));
  boxed(q('img.pic2'), R(10, 80, 100, 50));
  boxed(q('canvas.cv'), R(10, 140, 100, 50));
  boxed(q('canvas.cv2'), R(10, 200, 100, 50));
  boxed(q('div.sheet'), R(0, 400, 400, 100));
  boxed(q('div.big'), R(0, 600, 400, 400));
  boxed(q('p.outside'), R(100, 200, 200, 100));   // laid over the svg: never read
  rangeRects.set(q('span.s1').firstChild, [R(10, 410, 100, 20)]);   // y 0.10..0.30
  rangeRects.set(q('span.s2').firstChild, [R(10, 460, 120, 20)]);   // y 0.60..0.80
  rangeRects.set(q('p.outside').firstChild, [R(100, 200, 200, 100)]);
  for (const s of q('div.big').querySelectorAll('span')) rangeRects.set(s.firstChild, [R(0, 600, 400, 400)]);
}

function elementsRoute(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  if (method !== 'POST') return { elements: [], next_cursor: 0 };
  const body = init && init.body ? JSON.parse(init.body) : {};
  return { ok: true, element: { id: `p${nextId++}`, v: 1, type: body.type, ...body.payload, anchor: body.anchor } };
}

// A frame-like argument for one target (the deriver reads frame.rect only as
// a fallback).
const argFor = (target, bbox) => ({ frame: { target, rect: null }, target, bbox, points: [] });

before(async () => {
  shell = await bootShell({ routes: { '/api/elements': elementsRoute } });
  W = shell.window;
  M = W.__wcMount;
  W.Range.prototype.getClientRects = function getClientRects() {
    rangeReads += 1;
    return rangeRects.get(this.startContainer) || [];
  };
  ov = await shell.importApp('overlay.js');
  TF = await shell.importApp('target-frame.js');
  I = await shell.importApp('ink-describe.js');
  const IM = await shell.importApp('input-mode.js');
  IM.setFingerDraws('off');
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  await shell.tick();
  stubRects();
  ov.registerType(TYPE, { input: 'strokes', place: 'box', draw() {} });
});
after(async () => {
  if (ov) { ov.setArmed(null); ov.setElements('live', []); }
  if (shell) await shell.restore();
});
beforeEach(() => {
  ov.setArmed(TYPE);
  shell.calls.length = 0;
  rangeReads = 0;
});

test('main.js registers the deriver once as \'describe\'; a real stroke over an svg <text> posts text_under, text_box and its bbox', async () => {
  assert.throws(() => TF.registerStrokeDerive('describe', () => ({})), /already registered/, 'held from boot');
  I.initInkDescribe();   // idempotent
  const at = (x, y, t) => ({ clientX: x, clientY: y, timeStamp: 1000 + t, pressure: 0.5 });
  const t1 = q('text.t1');
  const pathOf = [];
  for (let n = t1; n; n = n.parentNode || n.host || null) { pathOf.push(n); if (n === W.document) break; }
  const e = { type: 'pointerdown', pointerId: 1, pointerType: 'pen', clientX: 112, clientY: 226, timeStamp: 1000, pressure: 0.5, target: t1, composedPath: () => pathOf };
  const h = TF.stroke.begin({ event: e, phase: 'pointerdown', kind: 'strokes', clientX: 112, clientY: 226, samples: [e], predicted: [] });
  assert.ok(h, 'begun on the svg');
  h.push([at(150, 226, 8), at(188, 227, 16)]);
  const r = await h.commit({ tool: 'pen', width: 2, colour: 'accent', shared: true });
  assert.equal(r.ok, true);
  const { payload } = posts()[0].body;
  assert.equal(payload.text_under, 'Revenue fell', 'the underline just below the words meets them');
  assert.deepStrictEqual(payload.text_box, [0.05, 0.1, 0.4, 0.14]);
  assert.deepStrictEqual(payload.bbox, [0.06, 0.26, 0.38, 0.01]);
  assert.ok(!('meta' in payload), 'never under meta');
});

test('over an svg: the <text> the box meets is taken, the one it misses is not; a <tspan> by its own box', () => {
  const svg = q('svg.art');
  const hit = I.deriveDescribe(argFor(svg, [0.04, 0.12, 0.3, 0.1]));
  assert.equal(hit.text_under, 'Revenue fell');
  assert.deepStrictEqual(hit.text_box, [0.05, 0.1, 0.4, 0.14]);
  assert.deepStrictEqual(hit.bbox, [0.04, 0.12, 0.3, 0.1]);
  const low = I.deriveDescribe(argFor(svg, [0.05, 0.72, 0.3, 0.05]));
  assert.equal(low.text_under, 'Costs rose', 'the tspan');
  const miss = I.deriveDescribe(argFor(svg, [0.6, 0.4, 0.3, 0.1]));
  assert.deepStrictEqual(miss, { bbox: [0.6, 0.4, 0.3, 0.1] }, 'no text: no text_under, no text_box');
  const both = I.deriveDescribe(argFor(svg, [0, 0, 1, 1]));
  assert.equal(both.text_under, 'Revenue fell Costs rose', 'in document order; the <title> is not drawn text');
  assert.ok(!/outside/.test(JSON.stringify([hit, low, miss, both])), 'nothing outside the target is read');
});

test('an <img>\'s alt (else its aria-label) and a <canvas>\'s aria-label (else its fallback text), whole, with no text_box', () => {
  const corner = [0.9, 0.9, 0.05, 0.05];
  assert.deepStrictEqual(I.deriveDescribe(argFor(q('img.pic'), corner)), { bbox: corner, text_under: 'A bar chart of revenue' });
  assert.deepStrictEqual(I.deriveDescribe(argFor(q('img.pic2'), corner)), { bbox: corner, text_under: 'Quarterly totals' });
  assert.deepStrictEqual(I.deriveDescribe(argFor(q('canvas.cv'), corner)), { bbox: corner, text_under: 'A heat map' });
  assert.deepStrictEqual(I.deriveDescribe(argFor(q('canvas.cv2'), corner)), { bbox: corner, text_under: 'Sales by region' });
  const bare = W.document.createElement('img');
  assert.deepStrictEqual(I.deriveDescribe(argFor(bare, corner)), { bbox: corner }, 'no alt, no label: nothing');
});

test('a [data-fixed-aspect] sheet: its text nodes by their Range rects; at most TEXT_NODES_MAX read', () => {
  const sheet = q('div.sheet');
  const one = I.deriveDescribe(argFor(sheet, [0.02, 0.2, 0.3, 0.05]));
  assert.equal(one.text_under, 'First line');
  assert.deepStrictEqual(one.text_box, [0.025, 0.1, 0.25, 0.2]);
  const two = I.deriveDescribe(argFor(sheet, [0.02, 0.15, 0.3, 0.55]));
  assert.equal(two.text_under, 'First line Second line');
  assert.deepStrictEqual(two.text_box, [0.025, 0.1, 0.3, 0.7]);

  rangeReads = 0;
  const big = I.deriveDescribe(argFor(q('div.big'), [0, 0, 1, 1]));
  assert.equal(I.TEXT_NODES_MAX, 200);
  assert.ok(rangeReads <= I.TEXT_NODES_MAX, `${rangeReads} range reads`);
  assert.equal(rangeReads, I.TEXT_NODES_MAX, 'the bound, not the 260 nodes');
  assert.ok(big.text_under.length <= I.TEXT_UNDER_MAX);
  assert.ok(big.text_under.endsWith('…'), 'cut at TEXT_UNDER_MAX');
  assert.ok(!big.text_under.includes(`w${MANY - 1}`), 'a node past the bound is never read');
});

test('TEXT_UNDER_MAX is lib/core/ink-shape\'s; a long alt is cut there', () => {
  assert.equal(I.TEXT_UNDER_MAX, shape.TEXT_UNDER_MAX);
  const img = W.document.createElement('img');
  img.setAttribute('alt', 'a '.repeat(400));
  const d = I.deriveDescribe(argFor(img, [0, 0, 1, 1]));
  assert.equal(d.text_under.length, I.TEXT_UNDER_MAX);
  assert.ok(d.text_under.endsWith('…'));
  // A bbox from the points when none is handed; junk answers nothing.
  assert.deepStrictEqual(I.deriveDescribe({ target: null, points: [0.1, 0.2, 0.5, 0, 0.3, 0.6, 0.5, 8] }), { bbox: [0.1, 0.2, 0.2, 0.4] });
  assert.deepStrictEqual(I.deriveDescribe(null), {});
});

// ── pane and page strokes (tranche 5, 5A.5, U622) ───────────────────────────
// A page stroke (frame.kind 'page', target-frame.js's derive input: points
// and bbox in the page box's units, frame.rect that box, `items` the
// endpoints' items from-item first) is read from its items' roots only — a
// pane's shadowRoot (never a nested root nor an iframe) or a markdown block —
// under ONE TEXT_NODES_MAX over both, the joined text cut at TEXT_UNDER_MAX;
// a pane-frame stroke reads its element as before.
const PAGE_BOX = { left: 0, top: 0, w: 1000, h: 2000 };
const pageArg = (bbox, items) => ({ frame: { kind: 'page', target: W.document.getElementById('main'), rect: PAGE_BOX }, target: W.document.getElementById('main'), bbox, points: [], items });
// A pane-like host with an open shadow root holding `html`, connected.
function paneRoot(id, html) {
  const host = W.document.createElement('div');
  host.className = 'u622-host';
  host.dataset.id = id;
  W.document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = html;
  return root;
}
const itemOf = (id, root, kind = 'pane') => ({ id, kind, root, rect: { left: 0, top: 0, w: 100, h: 100 } });
const rectText = (root, sel, r) => { for (const n of root.querySelectorAll(sel)) rangeRects.set(n.firstChild, [r]); };

test('U622: an arrow\'s text_under joins the words under the stroke in pane A then pane B; text_box in the page box\'s units; a missed line is not taken', () => {
  const A = paneRoot('ua', '<p class="a1">Alpha words</p><p class="a2">Alpha missed</p>');
  const B = paneRoot('ub', '<p class="b1">Beta words</p>');
  rectText(A, 'p.a1', R(100, 200, 100, 20));   // page units x 0.1..0.2, y 0.1..0.11
  rectText(A, 'p.a2', R(100, 1200, 100, 20));  // far below the stroke
  rectText(B, 'p.b1', R(600, 200, 100, 20));   // x 0.6..0.7
  const bbox = [0.1, 0.1, 0.6, 0.01];
  const d = I.deriveDescribe(pageArg(bbox, [itemOf('ua', A), itemOf('ub', B)]));
  assert.equal(d.text_under, 'Alpha words Beta words', 'from-item first');
  assert.deepStrictEqual(d.text_box, [0.1, 0.1, 0.6, 0.01]);
  assert.deepStrictEqual(d.bbox, bbox);
  const back = I.deriveDescribe(pageArg(bbox, [itemOf('ub', B), itemOf('ua', A)]));
  assert.equal(back.text_under, 'Beta words Alpha words', 'the from item is read first, wherever it lies');
  assert.ok(!/missed|outside|Revenue/.test(JSON.stringify([d, back])), 'nothing outside the items under the stroke is read');
});

test('U622: one TEXT_NODES_MAX over both items, the joined text cut at TEXT_UNDER_MAX', () => {
  const span = (p, n) => Array.from({ length: n }, (_, i) => `<span>${p}${i}</span>`).join('');
  const A = paneRoot('uc', span('alpha', 150));
  const B = paneRoot('ud', span('beta', 150));
  rectText(A, 'span', R(0, 0, 1000, 200));
  rectText(B, 'span', R(0, 0, 1000, 200));
  rangeReads = 0;
  const d = I.deriveDescribe(pageArg([0, 0, 1, 0.1], [itemOf('uc', A), itemOf('ud', B)]));
  assert.equal(rangeReads, I.TEXT_NODES_MAX, 'the bound over both items: 150 of A, 50 of B');
  assert.ok(d.text_under.length <= I.TEXT_UNDER_MAX && d.text_under.endsWith('…'), 'cut at TEXT_UNDER_MAX');
  assert.ok(d.text_under.startsWith('alpha0 alpha1'), 'from A first');

  // A meeting nothing: B's first 50 nodes are read, the 51st never.
  rectText(A, 'span', R(0, 1500, 10, 10));
  const seen = [];
  const own = W.Range.prototype.getClientRects;
  W.Range.prototype.getClientRects = function probe() { seen.push(this.startContainer.nodeValue); return own.call(this); };
  try {
    const only = I.deriveDescribe(pageArg([0, 0, 1, 0.1], [itemOf('uc', A), itemOf('ud', B)]));
    assert.equal(seen.length, I.TEXT_NODES_MAX);
    assert.ok(seen.includes('beta49') && !seen.includes('beta50'), 'B read only to the shared bound');
    assert.ok(only.text_under.startsWith('beta0 beta1'));
  } finally { W.Range.prototype.getClientRects = own; }
});

test('U622: a pane item\'s walk enters no nested shadow root and no iframe; a markdown block item is read by its own tree', () => {
  const B = paneRoot('ue', '<p class="e1">Outer words</p><div class="nest"></div><iframe class="fr"></iframe>');
  rectText(B, 'p.e1', R(100, 200, 100, 20));
  const nested = B.querySelector('div.nest').attachShadow({ mode: 'open' });
  nested.innerHTML = '<span>Nested words</span>';
  rectText(nested, 'span', R(100, 200, 100, 20));
  const d = I.deriveDescribe(pageArg([0.1, 0.1, 0.2, 0.01], [itemOf('ue', B)]));
  assert.equal(d.text_under, 'Outer words', 'the nested root and the iframe are never read');

  const md = W.document.createElement('div');
  md.dataset.mdId = 'md-u622';
  md.innerHTML = '<p>Markdown words</p>';
  W.document.body.appendChild(md);
  rangeRects.set(md.querySelector('p').firstChild, [R(100, 200, 100, 20)]);
  const m = I.deriveDescribe(pageArg([0.1, 0.1, 0.2, 0.01], [itemOf('md-u622', md, 'md')]));
  assert.equal(m.text_under, 'Markdown words');
  md.remove();
});

test('U622: a margin (\'beside\') stroke reads its nearest item\'s text under the stroke\'s box, none when it lies in the gutter; no items or no root read nothing', () => {
  const A = paneRoot('uf', '<p class="f1">Near words</p>');
  rectText(A, 'p.f1', R(100, 200, 100, 20));
  const over = I.deriveDescribe(pageArg([0.05, 0.1, 0.1, 0.01], [itemOf('uf', A)]));
  assert.equal(over.text_under, 'Near words', 'a margin stroke reaching over its item\'s words');
  const gutter = I.deriveDescribe(pageArg([0.9, 0.1, 0.05, 0.01], [itemOf('uf', A)]));
  assert.deepStrictEqual(gutter, { bbox: [0.9, 0.1, 0.05, 0.01] }, 'in the gutter: no text_under, no text_box');
  // #main holds the panes and the markdown, and is never walked.
  assert.deepStrictEqual(I.deriveDescribe(pageArg([0, 0, 1, 1], undefined)), { bbox: [0, 0, 1, 1] }, 'no items: the bbox alone');
  assert.deepStrictEqual(I.deriveDescribe(pageArg([0, 0, 1, 1], [{ id: 'closed', kind: 'pane', root: null }])), { bbox: [0, 0, 1, 1] }, 'a closed root: nothing');
});

test('U622: a pane-frame stroke on a paragraph reads the paragraph\'s words (the unchanged Range path)', () => {
  const p = q('p.outside');
  const d = I.deriveDescribe({ frame: { kind: 'pane', target: p, rect: null }, target: p, bbox: [0, 0, 1, 1], points: [] });
  assert.equal(d.text_under, 'Words outside every target');
  assert.deepStrictEqual(d.text_box, [0, 0, 1, 1]);
});

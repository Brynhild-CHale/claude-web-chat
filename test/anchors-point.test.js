// lib/core/anchors.js's point section (annotation engine, PLAN.md 4C.1;
// DECISIONS.md C5; FRAME@shared; RULED U531-U532@point-record-kind (a) and
// U531@aspect-drift (a)): the target frame, the point record, its resolution
// by the element rule and the one mapping from a stored point to a box.
//
// jsdom does no layout, so every box here is stubbed with getBoundingClientRect
// on the target. Panes mount into a shadow root through public/mount-runtime.js
// attachAndExtract (scripts not run), as test/anchors.test.js mounts them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const anchorsSrc = require('../lib/server/runtime/anchors-src');

const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const WINDOWS = [];
test.after(() => { for (const w of WINDOWS) w.close(); });
function newWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(RUNTIME);
  WINDOWS.push(dom.window);
  return dom.window;
}
const W = newWindow();
function mount(html, win = W, id = 'm1') {
  const host = win.document.createElement('div');
  host.dataset.mountId = id;
  win.document.body.appendChild(host);
  return win.__wcMount.attachAndExtract(host, html).root;
}
const wire = (o) => JSON.parse(JSON.stringify(o));
// A stubbed layout box; `box(el, ...)` again moves or resizes it.
function box(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  return el;
}
const rectOf = (el) => el.getBoundingClientRect();
const HINT = /an image, an svg, a canvas or an element marked data-fixed-aspect/;
// The element rule's answer over the same record, for comparison.
const asElement = (rec) => ({ ...rec, kind: 'element' });
const withoutPoint = (a) => { const o = { ...a }; delete o.pt; delete o.aspect; return o; };

const PANE = [
  '<div class="fig"><h3>Revenue</h3>',
  '<svg class="chart" viewBox="0 0 640 360"><g class="bars"><rect class="bar" width="10" height="20"></rect>',
  '<svg class="inset"><circle class="dot" r="4"></circle></svg></g></svg></div>',
  '<figure class="photo"><img class="pic" alt="A harbour" src="data:,"><figcaption>The harbour</figcaption></figure>',
  '<canvas class="sketch" width="300" height="150">a sketch</canvas>',
  '<div class="sheet" data-fixed-aspect><p class="note">on the sheet</p><svg class="mini"><circle class="m"></circle></svg></div>',
  '<p class="text">Plain words in a paragraph.</p>',
  '<button class="go">Go</button><input class="field" value="x">',
  '<div class="row" style="display:flex"><span class="cell">a</span></div>',
  '<video class="clip"></video>',
  '<div data-wc-chrome><img class="chrome-img" src="data:,"></div>',
].join('');

test('targetFrame: the outermost svg for a shape, a g or a nested svg; the element itself for an img, a canvas or a data-fixed-aspect element', () => {
  const root = mount(PANE);
  const svg = box(root.querySelector('svg.chart'), 10, 20, 640, 360);
  for (const sel of ['circle.dot', 'svg.inset', 'g.bars', 'rect.bar', 'svg.chart']) {
    const f = anchors.targetFrame(root, root.querySelector(sel));
    assert.strictEqual(f.target, svg, `${sel}: the outermost svg`);
    assert.deepStrictEqual(f.record, anchors.record(root, svg), `${sel}: the target's element record`);
    assert.deepStrictEqual([f.left, f.top, f.w, f.h, f.aspect], [10, 20, 640, 360, 1.7778], sel);
  }
  for (const [sel, b] of [['img.pic', [0, 400, 1600, 900]], ['canvas.sketch', [5, 5, 300, 150]], ['div.sheet', [0, 0, 600, 800]]]) {
    const el = box(root.querySelector(sel), ...b);
    const f = anchors.targetFrame(root, el, { mount: 'other' });
    assert.strictEqual(f.target, el, sel);
    assert.deepStrictEqual(f.record, anchors.record(root, el, { mount: 'other' }), `${sel}: record(root, target, {mount})`);
    assert.equal(f.record.mount, 'other');
    assert.equal(f.aspect, Math.round((b[2] / b[3]) * 1e4) / 1e4, sel);
  }
  // Inside a data-fixed-aspect element: text reaches the element; an svg in it
  // is the innermost target.
  const sheet = root.querySelector('div.sheet');
  assert.strictEqual(anchors.targetFrame(root, root.querySelector('p.note').firstChild).target, sheet, 'text on a sheet: the sheet');
  const mini = box(root.querySelector('svg.mini'), 0, 0, 100, 50);
  assert.strictEqual(anchors.targetFrame(root, root.querySelector('circle.m')).target, mini, 'an svg on a sheet: the innermost target');
  // The index a caller already holds is used as record takes it.
  const ix = anchors.index(root);
  assert.deepStrictEqual(anchors.targetFrame(root, svg, { ix }).record, anchors.record(root, svg, { ix }));
});

test('targetFrame refuses text, controls, a flex box and a video (not-fixed-aspect), chrome, and a target with no box or no record', () => {
  const root = mount(PANE);
  for (const sel of ['p.text', 'button.go', 'input.field', 'div.row', 'span.cell', 'video.clip']) {
    const el = box(root.querySelector(sel), 0, 0, 200, 40);
    for (const at of [el, el.firstChild].filter(Boolean)) {
      const f = anchors.targetFrame(root, at);
      assert.equal(f.refused, 'not-fixed-aspect', sel);
      assert.match(f.hint, HINT);
      assert.equal('target' in f, false, `${sel}: no target found`);
    }
  }
  const chromed = box(root.querySelector('img.chrome-img'), 0, 0, 10, 10);
  assert.equal(anchors.targetFrame(root, chromed).refused, 'chrome');
  // An img not yet loaded (and every element in jsdom, which does no layout): 0x0.
  const img = root.querySelector('img.pic');
  const nb = anchors.targetFrame(root, img);
  assert.deepStrictEqual([nb.refused, nb.target], ['no-box', img]);
  assert.match(nb.hint, HINT);
  box(img, 0, 0, 100, 0);
  assert.equal(anchors.targetFrame(root, img).refused, 'no-box', 'a zero height');
  // A target record() cannot record (inside a skipped node): unrecordable, target carried.
  const ns = W.document.createElement('noscript');
  const hidden = box(W.document.createElement('img'), 0, 0, 50, 50);
  ns.appendChild(hidden);
  root.appendChild(ns);
  const un = anchors.targetFrame(root, hidden);
  assert.deepStrictEqual([un.refused, un.target], ['unrecordable', hidden]);
  // Never past the root: an img outside the pane is no target of it.
  const outside = box(W.document.createElement('img'), 0, 0, 50, 50);
  W.document.body.appendChild(outside);
  assert.equal(anchors.targetFrame(root, outside).refused, 'not-fixed-aspect');
  assert.equal(anchors.targetFrame(root, null).refused, 'not-fixed-aspect');
});

test('recordPoint: the target\'s element record with kind point, x and y to 5 decimals of its box, the aspect to 4', () => {
  const root = mount(PANE);
  const svg = box(root.querySelector('svg.chart'), 100, 50, 640, 360);
  const rec = anchors.recordPoint(root, root.querySelector('circle.dot'), 100 + 640 / 3, 50 + 360 * 0.123456789);
  assert.deepStrictEqual(rec, { ...anchors.record(root, svg), kind: 'point', x: 0.33333, y: 0.12346, aspect: 1.7778 });
  assert.deepStrictEqual(Object.keys(rec), ['v', 'kind', 'mount', 'at', 'fp', 'rows', 'x', 'y', 'aspect'], 'the element record\'s fields flat, then x, y, aspect');
  assert.equal(rec.v, 1);
  assert.equal(rec.mount, 'm1');
  assert.deepStrictEqual(wire(rec), rec, 'plain data');
  // The box's corners are inside; a press past an edge is refused, never clamped.
  assert.deepStrictEqual([anchors.recordPoint(root, svg, 100, 50).x, anchors.recordPoint(root, svg, 740, 410).y], [0, 1]);
  for (const [x, y] of [[99, 60], [741, 60], [200, 49], [200, 411], [NaN, 60]]) {
    const r = anchors.recordPoint(root, svg, x, y);
    assert.equal(r.refused, 'outside-box', `${x},${y}`);
    assert.strictEqual(r.target, svg);
    assert.match(r.hint, HINT);
  }
  const t = anchors.recordPoint(root, root.querySelector('p.text').firstChild, 5, 5);
  assert.equal(t.refused, 'not-fixed-aspect', 'a press on text');
});

test('resolve after a resize: exact, pt carried, and pointAt places the same normalised spot in the new box', () => {
  const root = mount(PANE);
  const svg = box(root.querySelector('svg.chart'), 0, 0, 1280, 720);
  const img = box(root.querySelector('img.pic'), 0, 800, 1600, 1066.6667);
  const recs = [wire(anchors.recordPoint(root, root.querySelector('rect.bar'), 960, 180)),
    wire(anchors.recordPoint(root, img, 1200, 800 + 1066.6667 * 0.4))];
  assert.deepStrictEqual([recs[0].x, recs[0].y, recs[1].x, recs[1].y], [0.75, 0.25, 0.75, 0.4]);
  box(svg, 16, 120, 358, 201.375);
  box(img, 16, 400, 360, 240);
  for (const [rec, el] of [[recs[0], svg], [recs[1], img]]) {
    const a = anchors.resolvePoint(root, rec);
    assert.equal(a.state, 'exact');
    assert.strictEqual(a.el, el);
    assert.deepStrictEqual(a.pt, { x: rec.x, y: rec.y });
    assert.equal(a.aspect, rec.aspect, 'the recorded aspect rides beside');
    assert.deepStrictEqual(withoutPoint(a), anchors.resolve(root, asElement(rec)), 'the element rule\'s answer');
    const r = rectOf(el);
    const p = anchors.pointAt(a, r);
    assert.ok(Math.abs(p.x - (r.left + rec.x * r.width)) < 1e-6 && Math.abs(p.y - (r.top + rec.y * r.height)) < 1e-6, 'within 1e-6 px');
    assert.equal(p.aspect, r.width / r.height, 'the box\'s aspect now, beside');
    assert.deepStrictEqual(anchors.pointAt(rec, r), p, 'a record maps as its answer does');
  }
  // The svg's box goes square: its aspect drifts from 1.7778 to 1, reported
  // beside by pointAt, and the state stays exact (RULED U531@aspect-drift (a)).
  box(svg, 0, 0, 400, 400);
  const drift = anchors.resolvePoint(root, recs[0]);
  assert.equal(drift.state, 'exact');
  assert.equal(anchors.pointAt(drift, rectOf(svg)).aspect, 1);
});

test('resolve after a reflow and on removal: the element rule\'s answer, pt carried', () => {
  const root = mount('<section class="s"><h2>Chart</h2><div class="fig"><svg class="chart"><circle class="c"></circle></svg></div><p>caption</p></section>');
  const svg = box(root.querySelector('svg.chart'), 0, 0, 800, 400);
  const rec = wire(anchors.recordPoint(root, root.querySelector('circle.c'), 200, 300));
  // A paragraph prepended before the target in its pane.
  const fig = root.querySelector('div.fig');
  const p = W.document.createElement('p');
  p.textContent = 'A new paragraph above the chart.';
  fig.parentNode.insertBefore(p, fig);
  box(svg, 0, 90, 800, 400);
  const a = anchors.resolvePoint(root, rec);
  // No row is recorded around this chart, so the element rule re-finds it by
  // its step-2 score; under a recorded row it is row-search (the list below).
  assert.deepStrictEqual([a.state, a.how], ['re-resolved', 'score']);
  assert.strictEqual(a.el, svg);
  assert.deepStrictEqual(withoutPoint(a), anchors.resolve(root, asElement(rec)));
  assert.deepStrictEqual(anchors.pointAt(a, rectOf(svg)), { x: 200, y: 90 + 300, aspect: 2 });
  // The target removed: orphaned with the element rule's how.
  svg.remove();
  const gone = anchors.resolvePoint(root, rec);
  assert.equal(gone.state, 'orphaned');
  assert.deepStrictEqual(withoutPoint(gone), anchors.resolve(root, asElement(rec)));
  assert.equal(typeof gone.how, 'string');
  assert.deepStrictEqual(gone.pt, { x: 0.25, y: 0.75 }, 'pt still carried');
});

test('resolve after a reflow inside a recorded row: re-resolved row-search, and pointAt lands on the target\'s new box', () => {
  const card = (k) => `<li class="card"><h4>Card ${k}</h4><svg class="spark"><path></path></svg><span class="n">${k}</span></li>`;
  const root = mount(`<ul class="cards">${[1, 2, 3, 4].map(card).join('')}</ul>`);
  const target = box(root.querySelectorAll('svg.spark')[2], 0, 300, 200, 50);
  const rec = wire(anchors.recordPoint(root, target, 50, 310));
  assert.ok(rec.rows.length > 0, 'a row is recorded');
  // A card prepended before the target's card: the target's path moves.
  const ul = root.querySelector('ul.cards');
  const extra = W.document.createElement('li');
  extra.className = 'card';
  extra.innerHTML = '<h4>Card 0</h4><svg class="spark"><path></path></svg><span class="n">0</span>';
  ul.insertBefore(extra, ul.firstChild);
  box(target, 0, 400, 200, 50);
  const a = anchors.resolvePoint(root, rec);
  assert.deepStrictEqual([a.state, a.how], ['re-resolved', 'row-search'], 'the card row re-finds it');
  assert.strictEqual(a.el, target);
  assert.deepStrictEqual(withoutPoint(a), anchors.resolve(root, asElement(rec)), 'the element rule\'s answer');
  assert.deepStrictEqual(anchors.pointAt(a, rectOf(target)), { x: 50, y: 410, aspect: 4 });
});

test('resolve() and resolveAll route a point through resolvePoint; the element and range records answer as before', async () => {
  const root = mount('<p class="t">alpha beta gamma</p><ul><li class="r">one</li></ul><svg class="chart"><rect></rect></svg>');
  const svg = box(root.querySelector('svg.chart'), 0, 0, 300, 150);
  const tn = root.querySelector('p.t').firstChild;
  const sel = W.document.createRange();
  sel.setStart(tn, 6);
  sel.setEnd(tn, 10);
  const element = wire(anchors.record(root, root.querySelector('li.r')));
  const range = wire(anchors.recordRange(root, sel));
  const point = wire(anchors.recordPoint(root, svg, 150, 75));
  assert.deepStrictEqual(anchors.resolve(root, point), anchors.resolvePoint(root, point), 'resolve() routes a point');
  assert.deepStrictEqual(anchors.resolve(root, point, { tiebreak: false }), anchors.resolvePoint(root, point, { tiebreak: false }));
  const run = (recs) => new Promise((resolve) => {
    anchors.resolveAll(root, recs, { schedule: (fn) => fn(), now: () => 0 }, (answers, report) => resolve({ answers: Array.from(answers), report }));
  });
  const all = await run([element, range, point]);
  const two = await run([element, range]);
  assert.deepStrictEqual(all.answers[0], two.answers[0], 'the element record as before');
  assert.deepStrictEqual(all.answers[0], anchors.resolve(root, element));
  const plain = (a) => ({ ...a, range: a.range ? a.range.toString() : null });
  assert.deepStrictEqual(plain(all.answers[1]), plain(two.answers[1]), 'the range record as before');
  assert.equal(all.answers[1].range.toString(), 'beta');
  assert.deepStrictEqual(all.answers[2], anchors.resolvePoint(root, point));
  assert.equal(all.answers[2].state, 'exact');
  assert.deepStrictEqual(all.answers[2].pt, { x: 0.5, y: 0.5 });
  assert.deepStrictEqual(Object.keys(all.report).sort(), Object.keys(two.report).sort(), 'the report keeps its shape: no points field');
  assert.equal(all.report.ranges, 1);
});

test('an invalid point record answers orphaned invalid-record; restamp of an exact point rewrites only at', () => {
  const root = mount('<div><svg class="chart"><rect></rect></svg></div>');
  const svg = box(root.querySelector('svg.chart'), 0, 0, 300, 150);
  const rec = wire(anchors.recordPoint(root, svg, 30, 30));
  const INVALID = { state: 'orphaned', el: null, i: -1, how: 'invalid-record' };
  const noFp = { ...rec };
  delete noFp.fp;
  const noAt = { ...rec };
  delete noAt.at;
  for (const [name, bad] of [['x 1.2', { ...rec, x: 1.2 }], ['y NaN', { ...rec, y: NaN }], ['y null (NaN on the wire)', wire({ ...rec, y: NaN })],
    ['x -0.1', { ...rec, x: -0.1 }], ['x a string', { ...rec, x: '0.5' }], ['aspect 0', { ...rec, aspect: 0 }],
    ['aspect Infinity', { ...rec, aspect: Infinity }], ['no aspect', { ...rec, aspect: undefined }], ['no fp', noFp], ['no at', noAt]]) {
    assert.deepStrictEqual(anchors.resolve(root, bad), INVALID, name);
    assert.deepStrictEqual(anchors.resolvePoint(root, bad), INVALID, name);
  }
  assert.deepStrictEqual(anchors.resolvePoint(root, null), INVALID);
  // restamp: an exact answer re-stamps `at` alone (the stale sib is corrected).
  const stale = { ...rec, at: { path: rec.at.path.slice(), sib: 7 } };
  const a = anchors.resolve(root, stale);
  assert.equal(a.state, 'exact');
  const out = anchors.restamp(stale, a);
  assert.deepStrictEqual(out, { ...stale, at: rec.at });
  assert.deepStrictEqual([out.kind, out.x, out.y, out.aspect], ['point', rec.x, rec.y, rec.aspect]);
  assert.notStrictEqual(out, stale);
});

test('pointAt: null without a rect, for a zero box, or without a finite x and y', () => {
  const r = { left: 10, top: 20, width: 200, height: 100 };
  assert.deepStrictEqual(anchors.pointAt({ x: 0.5, y: 0.25 }, r), { x: 110, y: 45, aspect: 2 });
  assert.deepStrictEqual(anchors.pointAt({ state: 'exact', pt: { x: 1, y: 0 } }, r), { x: 210, y: 20, aspect: 2 });
  for (const [name, p, rect] of [['no rect', { x: 0.5, y: 0.5 }, null], ['zero width', { x: 0.5, y: 0.5 }, { ...r, width: 0 }],
    ['zero height', { x: 0.5, y: 0.5 }, { ...r, height: 0 }], ['NaN x', { x: NaN, y: 0.5 }, r], ['Infinity y', { x: 0.5, y: Infinity }, r],
    ['no point', null, r], ['a string', { x: '0.5', y: 0.5 }, r], ['an invalid answer', { state: 'orphaned', how: 'invalid-record' }, r]]) {
    assert.equal(anchors.pointAt(p, rect), null, name);
  }
});

// ── the cuts ──────────────────────────────────────────────────────────────

// Every point case above, answered by one copy in its own window, as plain data.
function pointCases(w, A) {
  const out = [];
  const root = mount(PANE + '<section class="s"><div class="fig"><svg class="late"><circle class="c"></circle></svg></div></section>', w);
  const svg = box(root.querySelector('svg.chart'), 0, 0, 1280, 720);
  const img = box(root.querySelector('img.pic'), 0, 800, 1600, 900);
  const late = box(root.querySelector('svg.late'), 0, 2000, 800, 400);
  const tag = (f) => (f.target ? f.target.getAttribute('class') : null);
  for (const sel of ['circle.dot', 'svg.inset', 'img.pic', 'canvas.sketch', 'div.sheet', 'p.text', 'button.go', 'video.clip', 'img.chrome-img']) {
    const f = A.targetFrame(root, root.querySelector(sel));
    out.push([sel, f.refused || null, tag(f), f.record || null, f.aspect || null]);
  }
  const recs = [A.recordPoint(root, root.querySelector('rect.bar'), 960, 180), A.recordPoint(root, img, 1200, 1160),
    A.recordPoint(root, late, 200, 2300), A.recordPoint(root, svg, -5, 10)];
  out.push(recs.map((r) => (r.refused ? [r.refused, tag(r)] : r)));
  box(svg, 16, 120, 358, 201.375);
  box(img, 16, 400, 360, 202.5);
  const fig = root.querySelector('div.fig');
  fig.parentNode.insertBefore(w.document.createElement('p'), fig);
  const plain = (a) => ({ ...a, el: a.el ? a.el.getAttribute('class') : null });
  for (const rec of recs.slice(0, 3)) {
    const a = A.resolve(root, wire(rec));
    out.push([plain(a), plain(A.resolvePoint(root, wire(rec))), A.pointAt(a, a.el ? a.el.getBoundingClientRect() : null)]);
  }
  late.remove();
  out.push(plain(A.resolve(root, wire(recs[2]))));
  out.push(plain(A.resolve(root, { ...wire(recs[0]), x: 1.2 })));
  return out;
}
function copyIn(src) {
  const w = newWindow();
  w.eval(src);
  return { w, A: w.__wcMount.anchor };
}

test('the cuts: an element-only copy answers a point orphaned invalid-record; the element+point copy answers as the whole copy', () => {
  const el = anchorsSrc.source({ kinds: ['element'] });
  const pt = anchorsSrc.source({ kinds: ['element', 'point'] });
  assert.equal(el.includes('function resolvePoint('), false, 'no point section in the element kind\'s copy');
  assert.equal(pt.includes('function resolvePoint('), true);
  assert.equal(pt.includes('function rangeIn('), false, 'the point kind holds no range section');
  // The element-only copy: no point api, and a point record is invalid there.
  const cut = copyIn(el);
  for (const n of ['targetFrame', 'recordPoint', 'resolvePoint', 'pointAt']) assert.ok(n in cut.A && cut.A[n] === undefined, n);
  const root = mount('<div><svg class="chart"><rect></rect></svg></div>', cut.w);
  const svg = box(root.querySelector('svg.chart'), 0, 0, 300, 150);
  const rec = wire(anchors.recordPoint(root, svg, 30, 30));
  assert.deepStrictEqual(wire(cut.A.resolve(root, rec)), { state: 'orphaned', el: null, i: -1, how: 'invalid-record' });
  // The element+point copy (and the whole, compacted and uncompacted) answer
  // the required module's point cases.
  const want = pointCases(newWindow(), anchors);
  assert.deepStrictEqual(want[0].slice(0, 3), ['circle.dot', null, 'chart']);
  for (const [label, src] of [['element+point', pt], ['whole', anchorsSrc.source()], ['uncompacted', anchors.documentSource({ kinds: ['point'] })]]) {
    const { w, A } = copyIn(src);
    assert.deepStrictEqual(wire(pointCases(w, A)), wire(want), label);
  }
});

test('kindsOf: a point record adds point and nowhere else', () => {
  assert.deepStrictEqual(anchorsSrc.kindsOf({ comments: [{ id: 'c1', anchor: { v: 1, kind: 'point', mount: 'm1' } }] }), ['element', 'point']);
  assert.deepStrictEqual(anchorsSrc.kindsOf({ elements: ['p1@1'] }, { kindOf: () => 'point' }), ['element', 'point']);
  assert.deepStrictEqual(anchorsSrc.kindsOf({ comments: [{ id: 'c1', anchor: { v: 1, kind: 'range', mount: 'm1' } }] }), ['element', 'range']);
  assert.deepStrictEqual(anchorsSrc.kindsOf({ comments: [{ id: 'c1', anchor: { mount: 'm1', selector: 'li' } }] }), ['element']);
  assert.deepStrictEqual(anchorsSrc.kindsOf({ elements: ['g1@1'] }, { kindOf: () => 'page' }), [], 'a box grab\'s page anchor adds none');
  assert.deepStrictEqual(anchorsSrc.RESOLVER_KINDS, ['element', 'point', 'range', 'source']);
});

// The stroke record (annotation engine tranche 4, plan 4F.1, U561;
// lib/core/strokes.js): its shape, its bound, the read-time stroke group and
// the browser copy.
//
// Pinned here:
//   - decimate over a synthetic 5 s, 240 Hz stroke (1,200 samples) and a
//     10,000-sample one answers at most STROKE_POINTS_MAX samples, both
//     endpoints kept, every dropped sample within the reported (final)
//     tolerance of the kept polyline; a stroke within the bound comes back
//     unchanged; roundPoints' precision;
//   - a maximal stroke payload (STROKE_POINTS_MAX samples at the widest
//     digits, every DESCRIBE_KEYS field at its widest, a real anchor record)
//     passes the plug-in schema's generic bound and stays under element-log's
//     exported PLUGIN_PAYLOAD_MAX as stable JSON;
//   - strokeGroups: three strokes on one target, one tool, 1 s apart → one
//     group of three, oldest first; a tool change, a 4.1 s gap or another
//     target (a sibling svg) each start a new group; a chain of 3.9 s steps
//     stays one; an fp-text change alone does not split a group;
//   - bboxOf, sameTarget, isStrokePayload;
//   - lib/core/strokes.js has no require( and no import; browserModuleSource()
//     is memoised and exports every name, and the copy answers as the
//     CommonJS module; GET /app/strokes.js (withServer) serves it as
//     text/javascript under the existing /app/* row; the jsdom tests resolve
//     ./strokes.js through served-modules.
//   - (tranche 5, U613) the page record: pageRecord round-trips through JSON
//     and isPageRecord, which refuses every malformed shape and a box grab's
//     page anchor; mapPage's similarity (both ends exact, the body by the one
//     transform, a stack turning an arrow vertical), its translation (a
//     one-item record, a degenerate arrow), its guess and its null; the
//     mapped box, width, points and drift; pageShape, pageLabel and
//     frameKindOf; page strokes grouped by sameTarget's page arm; reboxPoints;
//     DOC_SPLICE's order and each listed function's self-containment, run in
//     a bare scope (Math and the earlier listed names only) with every inlined
//     literal equal to its CONSTANTS entry; the served copy's mapPage equal
//     to the CommonJS one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const vm = require('vm');
const S = require('../lib/core/strokes');
const log = require('../lib/core/element-log');
const { stableStringify } = require('../lib/core/stable-json');
const { classify } = require('../lib/core/remote-policy');
const { withServer } = require('../test-support/helpers');

const REPO = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(REPO, 'lib/core/strokes.js'), 'utf8');
const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));
const NAMES = ['DESCRIBE_KEYS', 'DOC_SPLICE', 'GROUP_WINDOW_MS', 'PAGE_DEGENERATE_PX', 'PAGE_END_MAX', 'PAGE_ITEM_MAX',
  'PAGE_KIND', 'STROKE_ID_ATTR', 'STROKE_KEYS', 'STROKE_NAME_MAX',
  'STROKE_POINTS_MAX', 'STROKE_STRIDE', 'bboxOf', 'decimate', 'frameKindOf', 'isPageRecord', 'isStrokePayload', 'mapPage',
  'pageLabel', 'pageRecord', 'pageShape', 'reboxPoints', 'roundPoints', 'sameTarget',
  'strokeGroups'];

// A seeded PRNG: the synthetic strokes are the same on every run.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
// A wandering, jittered stroke at 240 Hz: n samples, t strictly increasing.
function synthStroke(n, seed) {
  const r = prng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const x = 0.5 + 0.4 * Math.sin(u * 9.1) * Math.cos(u * 2.3) + (r() - 0.5) * 0.002;
    const y = 0.5 + 0.4 * Math.sin(u * 5.7 + 1) + (r() - 0.5) * 0.002;
    out.push(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), 0.2 + 0.6 * r(), Math.round(i * 1000 / 240) + i);
  }
  return out;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(px - ax - u * dx, py - ay - u * dy);
}
// The largest distance from a dropped sample to the kept segment spanning it
// (samples identified by their unique t).
function maxDeviation(orig, kept) {
  const St = S.STROKE_STRIDE;
  const idx = new Map();
  for (let i = 0; i < orig.length / St; i++) idx.set(orig[i * St + 3], i);
  const keptIdx = [];
  for (let j = 0; j < kept.length / St; j++) keptIdx.push(idx.get(kept[j * St + 3]));
  let worst = 0;
  for (let k = 0; k + 1 < keptIdx.length; k++) {
    const a = keptIdx[k]; const b = keptIdx[k + 1];
    assert.ok(b > a, 'kept samples stay in order');
    for (let i = a + 1; i < b; i++) {
      worst = Math.max(worst, segDist(orig[i * St], orig[i * St + 1], orig[a * St], orig[a * St + 1], orig[b * St], orig[b * St + 1]));
    }
  }
  return worst;
}

// ── decimate and roundPoints ──────────────────────────────────────────────

for (const n of [1200, 10000]) {
  test(`decimate: a ${n}-sample stroke answers ≤ STROKE_POINTS_MAX samples, both endpoints kept, every dropped one within the final tolerance`, () => {
    const pts = synthStroke(n, n);
    const report = {};
    const out = S.decimate(pts, { report });
    const St = S.STROKE_STRIDE;
    assert.equal(out.length % St, 0, 'whole samples');
    assert.ok(out.length / St <= S.STROKE_POINTS_MAX, `${out.length / St} samples`);
    assert.ok(out.length / St > S.STROKE_POINTS_MAX * 0.9, 'and not needlessly fewer');
    assert.equal(report.kept, out.length / St);
    assert.deepStrictEqual(out.slice(0, St), pts.slice(0, St), 'the first sample');
    assert.deepStrictEqual(out.slice(-St), pts.slice(-St), 'the last sample');
    assert.ok(report.tolerance > 0 && Number.isFinite(report.tolerance));
    const dev = maxDeviation(pts, out);
    // (1e-9 relative: this test's distance is computed with Math.hypot, the
    // module's with Math.sqrt; the sample AT the tolerance is a dropped one.)
    assert.ok(dev <= report.tolerance * (1 + 1e-9), `max deviation ${dev} ≤ tolerance ${report.tolerance}`);
    // A typed array (the chrome's buffer) gives the same answer.
    assert.deepStrictEqual(S.decimate(Float64Array.from(pts)), out);
  });
}

test('decimate: a stroke within the bound comes back unchanged (a copy); a trailing partial sample is dropped', () => {
  const pts = synthStroke(300, 7);
  const out = S.decimate(pts);
  assert.deepStrictEqual(out, pts);
  assert.notStrictEqual(out, pts);
  assert.deepStrictEqual(S.decimate([...pts, 0.5, 0.5]), pts);
  assert.deepStrictEqual(S.decimate([]), []);
  // A custom max still keeps both endpoints.
  const two = S.decimate(pts, { max: 2 });
  assert.deepStrictEqual(two, [...pts.slice(0, 4), ...pts.slice(-4)]);
});

test('roundPoints: x and y to 1e-4, p to 1e-3, t to an integer', () => {
  assert.deepStrictEqual(S.roundPoints([0.123456, 0.987654, 0.55555, 12.6, 1, 0, 0.0004, 13.4]),
    [0.1235, 0.9877, 0.556, 13, 1, 0, 0, 13]);
  assert.deepStrictEqual(S.roundPoints(Float64Array.from([0.33333333, 0.66666666, 0.12345, 0.49])), [0.3333, 0.6667, 0.123, 0]);
});

// ── the bound ─────────────────────────────────────────────────────────────

test('a maximal stroke payload passes the plug-in bound and stays under element-log\'s PLUGIN_PAYLOAD_MAX', () => {
  assert.equal(S.STROKE_POINTS_MAX * S.STROKE_STRIDE <= log.PLUGIN_ARRAY_MAX, true, 'points fit one generic array');
  const points = [];
  for (let i = 0; i < S.STROKE_POINTS_MAX; i++) points.push(0.1234 + (i % 7) * 1e-4, 0.8765, 0.123, 3599999 - i);
  const anchor = {
    v: 1, kind: 'element', mount: 'a-pane-with-a-long-mount-id-0123456789',
    at: { path: [0, 3, 1, 7, 2, 0, 4], sib: 2 },
    fp: { tag: 'svg', id: 'figure-the-wide-one', cls: ['art', 'chart', 'figure-wide'], head: 'x'.repeat(120),
      attrs: ['class', 'id', 'viewBox', 'width', 'height', 'role', 'aria-label'], parent: 'div.figure-holder' },
    rows: [{ depth: 3, shape: 'div>svg', sigs: { a: 1, b: 2 }, key: 'k'.repeat(40), head: 'h'.repeat(120) }],
  };
  const payload = {
    anchor, shared: false, tool: 't'.repeat(S.STROKE_NAME_MAX), width: 0.0123456789012345,
    colour: 'c'.repeat(S.STROKE_NAME_MAX), points, stride: S.STROKE_STRIDE, aspect: 1.7778,
    text_under: 'u'.repeat(log.PLUGIN_STRING_MAX), bbox: [0.1234, 0.8765, 0.0006, 0.0001], text_box: [0.1, 0.2, 0.3, 0.4],
  };
  assert.deepStrictEqual(Object.keys(payload).sort(), [...S.STROKE_KEYS, ...S.DESCRIBE_KEYS].sort());
  const bytes = Buffer.byteLength(stableStringify(payload));
  assert.ok(bytes < log.PLUGIN_PAYLOAD_MAX, `${bytes} B < ${log.PLUGIN_PAYLOAD_MAX} B`);
  // The generic bound itself, as a strokes type's schema row runs it.
  const row = log.registerSchema('strokes-fixture@1', { type: 'strokes-fixture', keys: [...S.STROKE_KEYS, ...S.DESCRIBE_KEYS] });
  assert.doesNotThrow(() => row.check(payload));
  assert.ok(S.isStrokePayload(payload));
});

// ── the stroke group ──────────────────────────────────────────────────────

const svgAnchor = (sib, head = 'a chart') => ({ v: 1, kind: 'element', mount: 'p1', at: { path: [0, 1 + sib], sib },
  fp: { tag: 'svg', id: '', cls: [], head, attrs: [], parent: 'div' }, rows: [] });
const T0 = Date.parse('2026-11-03T10:00:00Z');
const row = (id, s, tool, anchor) => ({ id, created_at: T0 + s * 1000, tool, anchor });

test('strokeGroups: three strokes on one target, one tool, 1 s apart → one group of three, oldest first', () => {
  const A = svgAnchor(0);
  const rows = [row('p3', 2, 'a', A), row('p1', 0, 'a', A), row('p2', 1, 'a', A)];
  assert.deepStrictEqual(S.strokeGroups(rows), [{ key: 'p1', tool: 'a', members: ['p1', 'p2', 'p3'] }]);
  // created_at as an ISO string reads the same.
  const iso = rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
  assert.deepStrictEqual(S.strokeGroups(iso), [{ key: 'p1', tool: 'a', members: ['p1', 'p2', 'p3'] }]);
});

test('strokeGroups: a tool change, a 4.1 s gap or another target (a sibling svg) each start a new group; a chain of 3.9 s steps stays one', () => {
  const A = svgAnchor(0);
  const B = svgAnchor(1);
  assert.equal(S.GROUP_WINDOW_MS, 4000);
  const tool = S.strokeGroups([row('p1', 0, 'a', A), row('p2', 1, 'b', A), row('p3', 2, 'a', A)]);
  assert.deepStrictEqual(tool.map((g) => g.members), [['p1', 'p3'], ['p2']]);
  const gap = S.strokeGroups([row('p1', 0, 'a', A), row('p2', 1, 'a', A), row('p3', 5.1, 'a', A)]);
  assert.deepStrictEqual(gap.map((g) => g.members), [['p1', 'p2'], ['p3']]);
  const target = S.strokeGroups([row('p1', 0, 'a', A), row('p2', 1, 'a', B), row('p3', 2, 'a', B)]);
  assert.deepStrictEqual(target.map((g) => g.members), [['p1'], ['p2', 'p3']]);
  const chain = S.strokeGroups([0, 3.9, 7.8, 11.7].map((s, i) => row(`p${i + 1}`, s, 'a', A)));
  assert.deepStrictEqual(chain.map((g) => g.members), [['p1', 'p2', 'p3', 'p4']], 'chained: each within the window of the last');
  const exact = S.strokeGroups([row('p1', 0, 'a', A), row('p2', 4, 'a', A)]);
  assert.equal(exact.length, 1, 'exactly the window joins');
  const narrow = S.strokeGroups([row('p1', 0, 'a', A), row('p2', 1, 'a', A)], { windowMs: 500 });
  assert.equal(narrow.length, 2, 'windowMs is the caller\'s to narrow');
});

test('strokeGroups: an fp-text change alone does not split a group; no anchor is a group of its own; nothing stored', () => {
  const rows = [row('p1', 0, 'a', svgAnchor(0, 'before the edit')), row('p2', 1, 'a', svgAnchor(0, 'after the edit'))];
  const before = JSON.stringify(rows);
  assert.deepStrictEqual(S.strokeGroups(rows).map((g) => g.members), [['p1', 'p2']]);
  assert.equal(JSON.stringify(rows), before, 'the rows are untouched (no parent, no field)');
  const lone = S.strokeGroups([row('p1', 0, 'a', null), row('p2', 1, 'a', null)]);
  assert.deepStrictEqual(lone.map((g) => g.members), [['p1'], ['p2']]);
  assert.deepStrictEqual(S.strokeGroups([]), []);
  assert.deepStrictEqual(S.strokeGroups(null), []);
});

test('sameTarget compares mount, at.path and at.sib — never fp text', () => {
  const a = svgAnchor(0, 'one');
  assert.equal(S.sameTarget(a, svgAnchor(0, 'two')), true);
  assert.equal(S.sameTarget(a, svgAnchor(1)), false);
  assert.equal(S.sameTarget(a, { ...a, mount: 'p2' }), false);
  assert.equal(S.sameTarget(a, { ...a, at: { path: [0, 1, 0], sib: 0 } }), false);
  assert.equal(S.sameTarget(a, null), false);
  assert.equal(S.sameTarget({ kind: 'page' }, { kind: 'page' }), false);
});

test('bboxOf over a known point set; isStrokePayload', () => {
  assert.deepStrictEqual(S.bboxOf([0.2, 0.5, 0.5, 0, 0.6, 0.1, 0.5, 4, 0.4, 0.9, 0.5, 8]), [0.2, 0.1, 0.39999999999999997, 0.8]);
  assert.deepStrictEqual(S.bboxOf([0.5, 0.5, 0.5, 0]), [0.5, 0.5, 0, 0]);
  assert.equal(S.bboxOf([]), null);
  assert.equal(S.isStrokePayload({ points: [0, 0, 0.5, 0], stride: 4 }), true);
  assert.equal(S.isStrokePayload({ points: [0, 0, 0.5], stride: 4 }), false);
  assert.equal(S.isStrokePayload({ points: [0, 0, 0.5, 0], stride: 3 }), false);
  assert.equal(S.isStrokePayload({ points: [0, 0, 'x', 0], stride: 4 }), false);
  assert.equal(S.isStrokePayload(null), false);
});

test('the constants: STROKE_KEYS, DESCRIBE_KEYS (top level, never meta), the stride, the bound, the window, the id attribute', () => {
  assert.deepStrictEqual([...S.STROKE_KEYS], ['anchor', 'shared', 'tool', 'width', 'colour', 'points', 'stride', 'aspect']);
  assert.deepStrictEqual([...S.DESCRIBE_KEYS], ['text_under', 'bbox', 'text_box']);
  assert.ok(Object.isFrozen(S.STROKE_KEYS) && Object.isFrozen(S.DESCRIBE_KEYS));
  assert.ok(![...S.STROKE_KEYS, ...S.DESCRIBE_KEYS].includes(log.PLUGIN_META_KEY), 'meta stays reserved');
  for (const k of [...S.STROKE_KEYS, ...S.DESCRIBE_KEYS]) assert.match(k, log.PLUGIN_KEY_RE, k);
  assert.equal(S.STROKE_STRIDE, 4);
  assert.equal(S.STROKE_POINTS_MAX, 1024);
  assert.equal(S.STROKE_ID_ATTR, 'data-el-id');
});

// ── the module and its browser copy ───────────────────────────────────────

test('the module depends on nothing: no require( and no import in lib/core/strokes.js', () => {
  assert.doesNotMatch(SOURCE, /\brequire\s*\(/);
  assert.doesNotMatch(SOURCE, /\bimport\b/);
});

test('browserModuleSource: memoised, imports nothing, exports every name; the copy answers as the CommonJS module', async () => {
  const src = S.browserModuleSource();
  assert.strictEqual(S.browserModuleSource(), src, 'the same string on a second call');
  assert.match(src, /^\/\/ Generated from lib\/core\/strokes\.js — do not edit/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\bimport\b/);
  const mod = await importSource(src);
  assert.deepStrictEqual(Object.keys(mod).sort(), NAMES);
  for (const n of NAMES) {
    if (typeof S[n] === 'function') assert.equal(typeof mod[n], 'function', n);
    else assert.deepStrictEqual(mod[n], S[n], n);
  }
  assert.ok(Object.isFrozen(mod.STROKE_KEYS));
  const pts = synthStroke(2000, 3);
  assert.deepStrictEqual(mod.decimate(pts), S.decimate(pts));
  assert.deepStrictEqual(mod.roundPoints(pts.slice(0, 40)), S.roundPoints(pts.slice(0, 40)));
  const A = svgAnchor(0);
  const rows = [row('p1', 0, 'a', A), row('p2', 1, 'a', A), row('p3', 9, 'a', A)];
  assert.deepStrictEqual(mod.strokeGroups(rows), S.strokeGroups(rows));
});

test('GET /app/strokes.js serves browserModuleSource() as JavaScript, under the existing /app/* row', async (t) => {
  const { port } = await withServer(t);
  const res = await fetch(`http://localhost:${port}/app/strokes.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript\b/);
  assert.strictEqual(await res.text(), S.browserModuleSource());
  assert.equal(classify('GET', '/app/strokes.js').allow, true);
});

test('the jsdom tests resolve ./strokes.js through served-modules (no file on disk)', async () => {
  const file = path.join(REPO, 'public/app/strokes.js');
  assert.equal(fs.existsSync(file), false, 'public/app/strokes.js is served, never written');
  const url = pathToFileURL(file).href;
  const served = require('../test-support/served-modules');
  const parentURL = pathToFileURL(path.join(REPO, 'public/app/target-frame.js')).href;
  const resolved = served.resolve('./strokes.js', { parentURL }, () => { throw new Error('fell through'); });
  assert.deepStrictEqual(resolved, { url, format: 'module', shortCircuit: true });
  const mod = await import(url);
  assert.equal(mod.STROKE_STRIDE, 4);
});

// ── the page record and its one mapping (tranche 5, U613) ─────────────────

// A page box of 1000 × 2000 CSS px at commit; items' recorded boxes in that
// box's px. A sample's x, y are page-box units (px ÷ frame).
const FRAME = { w: 1000, h: 2000 };
const RA = { left: 100, top: 100, w: 300, h: 200 };   // item A when drawn
const RB = { left: 600, top: 100, w: 300, h: 200 };   // item B when drawn
// A stroke through px positions [[x, y], …]: payload points in page units.
const pagePoints = (px) => px.flatMap(([x, y], i) => [x / FRAME.w, y / FRAME.h, 0.5, i * 10]);
const endOf = (item, r, [x, y]) => ({ item, x: (x - r.left) / r.w, y: (y - r.top) / r.h, w: r.w, h: r.h });
// An arrow from A's centre to B's centre, bowing upward through three samples.
const ARROW_PX = [[250, 200], [400, 150], [500, 140], [600, 160], [750, 200]];
const arrow = () => S.pageRecord({ frame: FRAME, from: endOf('A', RA, ARROW_PX[0]), to: endOf('B', RB, ARROW_PX[ARROW_PX.length - 1]) });
const arrowPayload = (width = 0.004) => ({ points: pagePoints(ARROW_PX), stride: 4, width });
// A margin stroke left of A (outside its box): a 'beside' record.
const MARGIN_PX = [[40, 150], [50, 200], [70, 250]];
const margin = () => S.pageRecord({ frame: FRAME, from: endOf('A', RA, MARGIN_PX[0]), to: endOf('A', RA, MARGIN_PX[2]) });
const marginPayload = () => ({ points: pagePoints(MARGIN_PX), stride: 4, width: 0.002 });
// The mapped samples in px.
const pxOf = (m) => {
  const out = [];
  for (let i = 0; i < m.points.length; i += 4) out.push([m.box.left + m.points[i] * m.box.w, m.box.top + m.points[i + 1] * m.box.h]);
  return out;
};
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const nearPt = (p, q, eps, what) => { near(p[0], q[0], eps, `${what} x`); near(p[1], q[1], eps, `${what} y`); };
const current = (r, e) => [r.left + e.x * r.w, r.top + e.y * r.h];

test('pageRecord round-trips through JSON and isPageRecord; rounds; refuses what cannot make one, an endpoint past PAGE_END_MAX among them', () => {
  const rec = arrow();
  assert.deepStrictEqual(rec, {
    v: 1, kind: 'page', item: 'A', frame: { w: 1000, h: 2000 },
    from: { item: 'A', x: 0.5, y: 0.5, w: 300, h: 200 }, to: { item: 'B', x: 0.5, y: 0.5, w: 300, h: 200 },
  });
  const back = JSON.parse(JSON.stringify(rec));
  assert.deepStrictEqual(back, rec);
  assert.equal(S.isPageRecord(back), true);
  // Rounded to 1e-4, sizes to integers (at least 1); an endpoint past
  // PAGE_END_MAX is refused (null), never clamped.
  assert.equal(S.pageRecord({ frame: { w: 999.6, h: 0.2 }, from: { item: 'A', x: 0.123456, y: -12, w: 300.4, h: 0.4 }, to: { item: 'A', x: 9, y: 1 / 3, w: 1, h: 1 } }), null, 'x: 9 / y: -12 → null');
  assert.equal(S.pageRecord({ frame: FRAME, from: { item: 'A', x: 0.5, y: S.PAGE_END_MAX + 0.001, w: 300, h: 20 }, to: { item: 'A', x: 0.5, y: 0.5, w: 300, h: 20 } }), null, 'a y just past PAGE_END_MAX → null');
  const r = S.pageRecord({ frame: { w: 999.6, h: 0.2 }, from: { item: 'A', x: 0.123456, y: -S.PAGE_END_MAX, w: 300.4, h: 0.4 }, to: { item: 'A', x: S.PAGE_END_MAX, y: 1 / 3, w: 1, h: 1 } });
  assert.deepStrictEqual(r.frame, { w: 1000, h: 1 });
  assert.deepStrictEqual(r.from, { item: 'A', x: 0.1235, y: -S.PAGE_END_MAX, w: 300, h: 1 });
  assert.deepStrictEqual(r.to, { item: 'A', x: S.PAGE_END_MAX, y: 0.3333, w: 1, h: 1 });
  assert.equal(S.pageRecord(null), null);
  assert.equal(S.pageRecord({ frame: FRAME, from: endOf('A', RA, [250, 200]) }), null, 'no to');
  assert.equal(S.pageRecord({ frame: FRAME, from: { ...endOf('A', RA, [250, 200]), x: NaN }, to: endOf('A', RA, [250, 200]) }), null, 'a NaN');
  assert.equal(S.pageRecord({ frame: { w: 0, h: 10 }, from: endOf('A', RA, [250, 200]), to: endOf('A', RA, [250, 200]) }), null, 'a zero frame');
  assert.equal(S.pageRecord({ frame: FRAME, from: { ...endOf('A', RA, [250, 200]), item: '' }, to: endOf('A', RA, [250, 200]) }), null, 'an empty item');
  assert.equal(S.pageRecord({ frame: FRAME, from: { ...endOf('A', RA, [250, 200]), w: 0 }, to: endOf('A', RA, [250, 200]) }), null, 'a 0 × 0 item box');
});

test('mapPage at the recorded rects is the identity for every record pageRecord returns (arrow, margin, inside, an endpoint at ±PAGE_END_MAX)', () => {
  // Each case: the items' recorded boxes and a stroke in px; pageRecord builds
  // the record from the stroke's first and last sample, and mapPage handed the
  // same boxes must put every sample back where it was drawn, within 1e-6 px.
  // A `far` case has an endpoint more than PAGE_END_MAX item-units from its
  // item: pageRecord makes no record of it (a clamped one would map elsewhere).
  const M = S.PAGE_END_MAX;
  const H = { left: 100, top: 400, w: 400, h: 25 };   // a heading-sized item
  const C = { left: 600, top: 700, w: 50, h: 25 };
  const B2 = { left: 600, top: 500, w: 40, h: 20 };
  const cases = [
    { what: 'an arrow', ra: RA, rb: RB, px: ARROW_PX },
    { what: 'a margin stroke', ra: RA, px: MARGIN_PX },
    { what: 'an inside stroke', ra: RA, px: [[160, 150], [250, 200], [340, 250]] },
    { what: 'an endpoint at exactly +PAGE_END_MAX', ra: H, px: [[300, 450], [310, 525], [300, 400 + M * 25]] },
    { what: 'an endpoint at exactly −PAGE_END_MAX', ra: C, px: [[600 - M * 50, 700 - M * 25], [610, 705], [620, 710]] },
    { what: 'an arrow to an end at −PAGE_END_MAX of its item', ra: RA, rb: B2, px: [[250, 200], [400, 300], [600 - M * 40, 500 - M * 20]] },
    { what: 'a margin stroke 10 units below a heading', ra: H, px: [[300, 400 + 10 * 25], [320, 400 + 11 * 25], [340, 400 + 12 * 25]], far: true },
    { what: 'an arrow whose end lies 12.5 units below a 24 px item', ra: RA, rb: { left: 100, top: 400, w: 400, h: 24 }, px: [[250, 200], [300, 700]], far: true },
  ];
  for (const { what, ra, rb, px, far } of cases) {
    const rec = S.pageRecord({ frame: FRAME, from: endOf('A', ra, px[0]), to: endOf(rb ? 'B' : 'A', rb || ra, px[px.length - 1]) });
    if (!far) assert.ok(rec, `${what}: a record`);
    if (rec) {
      const m = S.mapPage(rec, { points: pagePoints(px), stride: 4, width: 0.002 }, ra, rb || null);
      assert.ok(m, `${what}: mapped`);
      assert.equal(m.guess, false, `${what}: no guess`);
      pxOf(m).forEach((p, k) => nearPt(p, px[k], 1e-6, `${what}: sample ${k}`));
    }
    if (far) assert.equal(rec, null, `${what}: no record`);
  }
});

test('isPageRecord refuses an extra key, a missing endpoint, a non-finite x, |x| > PAGE_END_MAX, item ≠ from.item and a box grab\'s page anchor', () => {
  const ok = arrow();
  assert.equal(S.isPageRecord(ok), true);
  const bad = (f, what) => { const r = JSON.parse(JSON.stringify(ok)); f(r); assert.equal(S.isPageRecord(r), false, what); };
  bad((r) => { r.mount = 'A'; }, 'an extra top-level key');
  bad((r) => { r.frame.d = 1; }, 'an extra frame key');
  bad((r) => { r.from.text = 'x'; }, 'an extra endpoint key');
  bad((r) => { r.to.z = undefined; }, 'an extra key, even undefined');
  bad((r) => { delete r.to; }, 'a missing endpoint');
  bad((r) => { delete r.from.h; }, 'an endpoint missing h');
  bad((r) => { r.from.x = Infinity; }, 'a non-finite x');
  bad((r) => { r.to.y = NaN; }, 'a NaN y');
  bad((r) => { r.from.x = '0.5'; }, 'a string x');
  bad((r) => { r.to.x = S.PAGE_END_MAX + 0.001; }, '|x| > PAGE_END_MAX');
  bad((r) => { r.to.y = -S.PAGE_END_MAX - 0.001; }, '|y| > PAGE_END_MAX');
  bad((r) => { r.item = 'B'; }, 'item ≠ from.item');
  bad((r) => { r.v = 2; }, 'v 2');
  bad((r) => { r.kind = 'element'; }, 'another kind');
  bad((r) => { r.frame.w = 0; }, 'a zero frame');
  bad((r) => { r.to.w = -1; }, 'a negative box');
  bad((r) => { r.to.item = 'x'.repeat(S.PAGE_ITEM_MAX + 1); }, 'an item past PAGE_ITEM_MAX');
  bad((r) => { r.from = [r.from]; }, 'an endpoint list');
  const edge = JSON.parse(JSON.stringify(ok));
  edge.to.item = 'x'.repeat(S.PAGE_ITEM_MAX); edge.to.x = S.PAGE_END_MAX; edge.to.y = -S.PAGE_END_MAX;
  assert.equal(S.isPageRecord(edge), true, 'the bounds are inclusive');
  const grab = { v: 1, kind: 'page', item: 'm1', mount: 'm1', rect: { x: 4, y: 6, w: 32, h: 20 }, box: { w: 600, h: 80 }, scroll: { top: 0, left: 0 }, viewport: { w: 1024, h: 700 } };
  assert.equal(S.isPageRecord(grab), false, 'a box grab\'s page anchor is not a page stroke record');
  for (const v of [null, undefined, 'page', 1, [], {}]) assert.equal(S.isPageRecord(v), false, String(v));
});

test('mapPage of a \'between\' record: both ends land on the current endpoints within 1e-6 px, the body by the one similarity', () => {
  const rec = arrow();
  // A moved left and down, B moved right and up and widened: a scale, a turn.
  const A = { left: 50, top: 80, w: 300, h: 200 };
  const B = { left: 900, top: 300, w: 400, h: 100 };
  const m = S.mapPage(rec, arrowPayload(), A, B);
  assert.equal(m.guess, false);
  const got = pxOf(m);
  const C0 = current(A, rec.from);
  const CN = current(B, rec.to);
  nearPt(got[0], C0, 1e-6, 'first sample → C0');
  nearPt(got[got.length - 1], CN, 1e-6, 'last sample → CN');
  // One uniform scale: every distance scales by m.scale, so each sample keeps
  // its distance ratio to both ends.
  const P0 = ARROW_PX[0]; const PN = ARROW_PX[ARROW_PX.length - 1];
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  near(m.scale, dist(C0, CN) / dist(P0, PN), 1e-12, 'the scale');
  for (let i = 1; i < ARROW_PX.length - 1; i++) {
    near(dist(got[i], C0) / dist(got[i], CN), dist(ARROW_PX[i], P0) / dist(ARROW_PX[i], PN), 1e-9, `sample ${i}'s ratio`);
    near(dist(got[i], C0), m.scale * dist(ARROW_PX[i], P0), 1e-6, `sample ${i} scaled`);
  }
  // The rotation: the chord's angle now minus then.
  near(m.angle, Math.atan2(CN[1] - C0[1], CN[0] - C0[0]) - Math.atan2(PN[1] - P0[1], PN[0] - P0[0]), 1e-12, 'the angle');
  assert.equal(m.drift, Math.round(Math.abs(m.scale - 1) * 1e3) / 1e3, 'drift = |scale − 1|');
  // Unmoved items: the identity, drift 0.
  const id = S.mapPage(rec, arrowPayload(), RA, RB);
  pxOf(id).forEach((p, i) => nearPt(p, ARROW_PX[i], 1e-6, `identity sample ${i}`));
  assert.equal(id.drift, 0);
  near(id.scale, 1, 1e-12, 'scale 1');
  near(id.angle, 0, 1e-12, 'angle 0');
  // A DOMRect-like {left, top, width, height} reads the same.
  assert.deepStrictEqual(S.mapPage(rec, arrowPayload(), { left: 50, top: 80, width: 300, height: 200 }, { left: 900, top: 300, width: 400, height: 100 }), m);
});

test('mapPage: items re-stacked vertically (a phone) turn the arrow vertical', () => {
  const rec = arrow();
  const A = { left: 0, top: 0, w: 390, h: 200 };
  const B = { left: 0, top: 300, w: 390, h: 200 };
  const m = S.mapPage(rec, arrowPayload(), A, B);
  const got = pxOf(m);
  nearPt(got[0], [195, 100], 1e-6, 'C0');
  nearPt(got[got.length - 1], [195, 400], 1e-6, 'CN');
  near(m.angle, Math.PI / 2, 1e-12, 'a quarter turn');
  assert.ok(m.aspect < 1, `taller than wide now (${m.aspect})`);
  const before = S.mapPage(rec, arrowPayload(), RA, RB);
  assert.ok(before.aspect > 1, 'wider than tall as drawn');
});

test('mapPage: a one-item record translates by its item\'s movement; a degenerate arrow translates', () => {
  const rec = margin();
  assert.equal(S.pageShape(rec), 'beside');
  const A = { left: 300, top: 50, w: 360, h: 200 };   // moved, and 20% wider
  const m = S.mapPage(rec, marginPayload(), A, null);
  assert.equal(m.guess, false);
  near(m.scale, 1, 0, 'scale 1'); near(m.angle, 0, 0, 'angle 0');
  const C0 = current(A, rec.from);
  const d = [C0[0] - MARGIN_PX[0][0], C0[1] - MARGIN_PX[0][1]];
  pxOf(m).forEach((p, i) => nearPt(p, [MARGIN_PX[i][0] + d[0], MARGIN_PX[i][1] + d[1]], 1e-6, `sample ${i} translated`));
  assert.equal(m.drift, 0.2, 'the item\'s relative size change');
  // toRect alone (the one item handed as the other end) reads the same; none → null.
  assert.deepStrictEqual(S.mapPage(rec, marginPayload(), null, A), m);
  assert.equal(S.mapPage(rec, marginPayload(), null, null), null);
  assert.equal(S.mapPage(rec, marginPayload(), { left: 0, top: 0, w: 0, h: 0 }, null), null, 'a zero-size box is absent');
  // An 'inside' record translates the same way.
  const inside = S.pageRecord({ frame: FRAME, from: endOf('A', RA, [160, 150]), to: endOf('A', RA, [340, 250]) });
  assert.equal(S.pageShape(inside), 'inside');
  const mi = S.mapPage(inside, { points: pagePoints([[160, 150], [340, 250]]), stride: 4, width: 0 }, { left: 110, top: 100, w: 300, h: 200 }, null);
  pxOf(mi).forEach((p, i) => nearPt(p, [[170, 150], [350, 250]][i], 1e-6, `inside sample ${i}`));
  assert.equal(mi.drift, 0);
  // A degenerate arrow: ends closer than PAGE_DEGENERATE_PX translate with from's item.
  const DEG_PX = [[398, 200], [401, 202], [403, 203]];
  assert.ok(Math.hypot(5, 3) < S.PAGE_DEGENERATE_PX);
  const deg = S.pageRecord({ frame: FRAME, from: endOf('A', RA, DEG_PX[0]), to: endOf('B', { left: 400, top: 100, w: 300, h: 200 }, DEG_PX[2]) });
  assert.equal(S.pageShape(deg), 'between');
  const A2 = { left: 120, top: 90, w: 300, h: 200 };
  const md = S.mapPage(deg, { points: pagePoints(DEG_PX), stride: 4, width: 0.002 }, A2, { left: 900, top: 900, w: 300, h: 200 });
  const c = current(A2, deg.from);
  pxOf(md).forEach((p, i) => nearPt(p, [DEG_PX[i][0] + c[0] - DEG_PX[0][0], DEG_PX[i][1] + c[1] - DEG_PX[0][1]], 1e-6, `degenerate sample ${i}`));
  assert.equal(md.scale, 1);
  assert.equal(md.guess, false);
});

test('mapPage: one missing rect of a \'between\' record → guess by the present endpoint; every needed rect missing → null', () => {
  const rec = arrow();
  const A = { left: 50, top: 80, w: 300, h: 200 };
  const B = { left: 900, top: 300, w: 300, h: 200 };
  const fromOnly = S.mapPage(rec, arrowPayload(), A, null);
  assert.equal(fromOnly.guess, true);
  nearPt(pxOf(fromOnly)[0], current(A, rec.from), 1e-6, 'from\'s end lands');
  const toOnly = S.mapPage(rec, arrowPayload(), null, B);
  assert.equal(toOnly.guess, true);
  const got = pxOf(toOnly);
  nearPt(got[got.length - 1], current(B, rec.to), 1e-6, 'to\'s end lands');
  const d = [current(B, rec.to)[0] - ARROW_PX[4][0], current(B, rec.to)[1] - ARROW_PX[4][1]];
  got.forEach((p, i) => nearPt(p, [ARROW_PX[i][0] + d[0], ARROW_PX[i][1] + d[1]], 1e-6, `sample ${i} translated by to`));
  assert.equal(S.mapPage(rec, arrowPayload(), null, null), null);
  assert.equal(S.mapPage(rec, arrowPayload(), undefined, { left: NaN, top: 0, w: 1, h: 1 }), null, 'a non-finite rect is absent');
  // Not a page record, or no points → null.
  assert.equal(S.mapPage(svgAnchor(0), arrowPayload(), A, B), null);
  assert.equal(S.mapPage(rec, { points: [], stride: 4 }, A, B), null);
  assert.equal(S.mapPage(rec, { points: [0, NaN, 0.5, 0], stride: 4 }, A, B), null);
  assert.equal(S.mapPage(rec, null, A, B), null);
});

test('mapPage: the box holds every mapped point grown by half the stroke\'s px width; the width keeps its recorded px under a scale of 3; points in [0, 1]', () => {
  const rec = arrow();
  // B three times as far from A's end, along the same line: scale 3.
  const A = RA;
  const B = { left: 600 + 1000, top: 100, w: 300, h: 200 };
  const m = S.mapPage(rec, arrowPayload(0.004), A, B);
  near(m.scale, 3, 1e-12, 'scale 3');
  assert.equal(m.drift, 2);
  const widthPx = 0.004 * FRAME.w;
  near(m.width * m.box.w, widthPx, 1e-9, 'the recorded px width, never scaled');
  const pad = widthPx / 2;
  const got = pxOf(m);
  const xs = got.map((p) => p[0]); const ys = got.map((p) => p[1]);
  near(m.box.left, Math.min(...xs) - pad, 1e-9, 'left'); near(m.box.top, Math.min(...ys) - pad, 1e-9, 'top');
  near(m.box.left + m.box.w, Math.max(...xs) + pad, 1e-9, 'right'); near(m.box.top + m.box.h, Math.max(...ys) + pad, 1e-9, 'bottom');
  for (let i = 0; i < m.points.length; i += 4) {
    assert.ok(m.points[i] >= 0 && m.points[i] <= 1 && m.points[i + 1] >= 0 && m.points[i + 1] <= 1, `sample ${i / 4} in [0, 1]`);
    assert.equal(m.points[i + 2], 0.5, 'p kept');
    assert.equal(m.points[i + 3], (i / 4) * 10, 't kept');
  }
  near(m.aspect, m.box.w / m.box.h, 1e-12, 'aspect');
  assert.ok(Array.isArray(m.points) && m.points.length === ARROW_PX.length * 4, 'a plain flat array');
  // A zero width still grows the box by 1 px.
  const thin = S.mapPage(rec, arrowPayload(0), A, B);
  near(thin.box.left, Math.min(...pxOf(thin).map((p) => p[0])) - 1, 1e-9, 'at least 1 px');
  assert.equal(thin.width, 0);
  // A typed array (the chrome's buffer) answers the same.
  assert.deepStrictEqual(S.mapPage(rec, { ...arrowPayload(0.004), points: Float64Array.from(arrowPayload().points) }, A, B), m);
});

test('pageShape and pageLabel for the three shapes; frameKindOf for each frame', () => {
  const inside = S.pageRecord({ frame: FRAME, from: endOf('md-2', RA, [150, 150]), to: endOf('md-2', RA, [350, 250]) });
  const beside = S.pageRecord({ frame: FRAME, from: endOf('pane-a', RA, [40, 150]), to: endOf('pane-a', RA, [70, 250]) });
  const between = S.pageRecord({ frame: FRAME, from: endOf('pane-a', RA, [250, 200]), to: endOf('pane-b', RB, [750, 200]) });
  assert.equal(S.pageShape(between), 'between');
  assert.equal(S.pageShape(inside), 'inside');
  assert.equal(S.pageShape(beside), 'beside');
  assert.equal(S.pageLabel(between), 'from pane-a to pane-b');
  assert.equal(S.pageLabel(inside), 'inside md-2');
  assert.equal(S.pageLabel(beside), 'beside pane-a');
  // [0, 1]² is inclusive: an end on its item's edge is inside; just past it, beside.
  const RU = { left: 0, top: 0, w: 1000, h: 1000 };
  const edges = (a, b) => S.pageShape(S.pageRecord({ frame: FRAME, from: endOf('A', RU, a), to: endOf('A', RU, b) }));
  assert.equal(edges([0, 0], [1000, 1000]), 'inside', 'both ends on the corners');
  assert.equal(edges([0, 1000], [1000, 0]), 'inside', 'the other corners');
  assert.equal(edges([0, 0], [1000.1, 500]), 'beside', 'x just past 1');
  assert.equal(edges([-0.1, 500], [500, 500]), 'beside', 'x just under 0');
  assert.equal(edges([500, 500], [500, 1000.1]), 'beside', 'y just past 1');
  assert.equal(S.pageShape(svgAnchor(0)), null);
  assert.equal(S.pageLabel({ kind: 'page' }), null);
  const el = (tag, attrs = []) => ({ v: 1, kind: 'element', mount: 'p1', at: { path: [0], sib: 0 }, fp: { tag, id: '', cls: [], head: '', attrs, parent: 'div' }, rows: [] });
  assert.equal(S.frameKindOf(el('svg')), 'target');
  assert.equal(S.frameKindOf(el('img', ['src', 'alt'])), 'target');
  assert.equal(S.frameKindOf(el('canvas')), 'target');
  assert.equal(S.frameKindOf(el('div', ['class', 'data-fixed-aspect'])), 'target');
  assert.equal(S.frameKindOf(el('p', ['class'])), 'pane');
  assert.equal(S.frameKindOf(between), 'page');
  assert.equal(S.frameKindOf(beside), 'page');
  assert.equal(S.frameKindOf({ v: 1, kind: 'range', mount: 'm1' }), null);
  assert.equal(S.frameKindOf({ v: 1, kind: 'page', item: 'm1', mount: 'm1', rect: {}, viewport: {} }), null, 'a box grab\'s page anchor');
  assert.equal(S.frameKindOf(null), null);
});

test('strokeGroups: page strokes between the same items 3 s apart are one group, 5 s apart two; a margin pair on one item one group; sameTarget\'s page arm', () => {
  const ab = arrow();
  const ba = S.pageRecord({ frame: FRAME, from: endOf('B', RB, [750, 200]), to: endOf('A', RA, [250, 200]) });
  const m1 = margin();
  const m2 = S.pageRecord({ frame: FRAME, from: endOf('A', RA, [30, 100]), to: endOf('A', RA, [90, 120]) });
  assert.deepStrictEqual(S.strokeGroups([row('p1', 0, 'a', ab), row('p2', 3, 'a', ab)]).map((g) => g.members), [['p1', 'p2']]);
  assert.deepStrictEqual(S.strokeGroups([row('p1', 0, 'a', ab), row('p2', 5, 'a', ab)]).map((g) => g.members), [['p1'], ['p2']]);
  assert.deepStrictEqual(S.strokeGroups([row('p1', 0, 'a', m1), row('p2', 1, 'a', m2)]).map((g) => g.members), [['p1', 'p2']], 'a margin pair');
  // Other items, another direction, an element row: never the same target.
  assert.deepStrictEqual(S.strokeGroups([row('p1', 0, 'a', ab), row('p2', 1, 'a', ba), row('p3', 2, 'a', m1), row('p4', 3, 'a', svgAnchor(0))])
    .map((g) => g.members), [['p1'], ['p2'], ['p3'], ['p4']]);
  // A box grab's page anchor (not a page record, no `at`) is still a group of its own.
  const grab = { v: 1, kind: 'page', item: 'A', mount: 'A', rect: { x: 4, y: 6, w: 32, h: 20 }, viewport: { w: 1024, h: 700 } };
  assert.deepStrictEqual(S.strokeGroups([row('p1', 0, 'a', grab), row('p2', 1, 'a', grab)]).map((g) => g.members), [['p1'], ['p2']]);
  assert.equal(S.sameTarget(ab, JSON.parse(JSON.stringify(ab))), true);
  assert.equal(S.sameTarget(m1, m2), true, 'from.item and to.item, never the positions');
  assert.equal(S.sameTarget(ab, ba), false);
  assert.equal(S.sameTarget(ab, svgAnchor(0)), false);
  assert.equal(S.sameTarget(svgAnchor(0), ab), false);
});

test('reboxPoints re-expresses a member\'s points from its box into a union box (each sample on the same px), p and t kept; an equal box copies', () => {
  const member = { left: 120, top: 40, w: 80, h: 30 };
  const union = { left: 100, top: 10, w: 400, h: 200 };
  const pts = [0, 0, 0.3, 0, 0.25, 0.5, 0.4, 8, 1, 1, 0.9, 16];
  const out = S.reboxPoints(pts, member, union);
  assert.ok(Array.isArray(out) && out !== pts && out.length === pts.length);
  for (let i = 0; i < pts.length; i += 4) {
    near(union.left + out[i] * union.w, member.left + pts[i] * member.w, 1e-6, `x ${i / 4}`);
    near(union.top + out[i + 1] * union.h, member.top + pts[i + 1] * member.h, 1e-6, `y ${i / 4}`);
    assert.equal(out[i + 2], pts[i + 2]); assert.equal(out[i + 3], pts[i + 3]);
  }
  const same = S.reboxPoints(pts, member, { ...member });
  assert.deepStrictEqual(same, pts);
  assert.notStrictEqual(same, pts);
  assert.deepStrictEqual(S.reboxPoints([...pts, 0.5], member, member), pts, 'a trailing partial sample dropped');
  assert.equal(S.reboxPoints(pts, member, { left: 0, top: 0, w: 0, h: 10 }), null);
  assert.equal(S.reboxPoints(pts, null, union), null);
  assert.equal(S.reboxPoints(null, member, union), null);
});

// ── DOC_SPLICE: the document runtime's splice, self-contained ──────────────

// A scope holding only Math and the given functions' sources: every other
// global (Object, Array, Number, JSON, …) deleted, so a reference to a module
// binding or to anything but Math throws.
function bareScope(names) {
  const ctx = vm.createContext({});
  for (const n of names) vm.runInContext(S[n].toString(), ctx);
  vm.runInContext(`(() => {
    const keep = new Set(['Math', 'NaN', 'Infinity', 'undefined', ${names.map((n) => `'${n}'`).join(', ')}]);
    const g = globalThis;
    const own = Object.getOwnPropertyNames(g);
    for (const k of own) if (!keep.has(k)) { try { delete g[k]; } catch {} }
  })()`, ctx);
  return ctx;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('DOC_SPLICE: exported in order; each listed function runs in a bare scope (Math and the earlier names only) equal to the CommonJS one; every inlined literal equals its CONSTANTS entry', () => {
  assert.deepStrictEqual([...S.DOC_SPLICE], ['isPageRecord', 'pageShape', 'reboxPoints', 'mapPage']);
  assert.ok(Object.isFrozen(S.DOC_SPLICE));
  // The bare scope is bare: Object, Array, Number and JSON are gone.
  const probe = bareScope([]);
  for (const g of ['Object', 'Array', 'Number', 'JSON', 'String']) assert.equal(vm.runInContext(`typeof ${g}`, probe), 'undefined', g);
  assert.equal(vm.runInContext('typeof Math.round', probe), 'function');

  const recs = [arrow(), margin(), JSON.parse(JSON.stringify(arrow())), { ...arrow(), mount: 'x' }, { kind: 'page' }, null, svgAnchor(0),
    S.pageRecord({ frame: FRAME, from: endOf('A', RA, [150, 150]), to: endOf('A', RA, [350, 250]) })];
  const rects = [[RA, RB], [{ left: 50, top: 80, w: 300, h: 200 }, { left: 900, top: 300, w: 400, h: 100 }], [RA, null], [null, RB],
    [null, null], [{ left: 0, top: 0, width: 390, height: 200 }, { left: 0, top: 300, width: 390, height: 200 }]];
  const payloads = [arrowPayload(), marginPayload(), arrowPayload(0)];
  const calls = {
    isPageRecord: recs.map((r) => [r]),
    pageShape: recs.map((r) => [r]),
    reboxPoints: [[[0, 0, 0.3, 0, 0.25, 0.5, 0.4, 8], { left: 120, top: 40, w: 80, h: 30 }, { left: 100, top: 10, w: 400, h: 200 }],
      [[0.5, 0.5, 0.5, 0], { left: 1, top: 2, w: 3, h: 4 }, { left: 1, top: 2, w: 3, h: 4 }], [[0, 0, 0, 0], null, null]],
    mapPage: recs.flatMap((r) => payloads.flatMap((p) => rects.map(([a, b]) => [r, p, a, b]))),
  };
  for (let i = 0; i < S.DOC_SPLICE.length; i++) {
    const name = S.DOC_SPLICE[i];
    const ctx = bareScope(S.DOC_SPLICE.slice(0, i + 1));
    const fn = ctx[name];
    assert.equal(typeof fn, 'function', name);
    for (const args of calls[name]) {
      assert.deepStrictEqual(plain(fn(...args)), plain(S[name](...args)), `${name}(${JSON.stringify(args).slice(0, 80)}…)`);
    }
    // Every constant it reads is inlined, beside its CONSTANTS entry's name.
    const src = S[name].toString();
    const lits = [...src.matchAll(/const \w+ = ([^;]+); \/\/ ([A-Z][A-Z_]+)\b/g)];
    for (const [, lit, entry] of lits) {
      assert.ok(Object.prototype.hasOwnProperty.call(S, entry), `${name}: ${entry} is a CONSTANTS entry`);
      assert.deepStrictEqual(vm.runInNewContext(`(${lit})`), S[entry], `${name}: ${entry}`);
    }
    // And no CONSTANTS name is read bare outside its comment.
    const code = src.replace(/\/\/[^\n]*/g, '');
    for (const k of Object.keys(S)) {
      if (/^[A-Z][A-Z_]+$/.test(k)) assert.doesNotMatch(code, new RegExp(`\\b${k}\\b`), `${name} reads ${k} bare`);
    }
    assert.ok(lits.length >= (name === 'pageShape' ? 0 : 1), `${name} inlines its constants`);
  }
  // The literals each function inlines, named.
  const named = (n) => [...S[n].toString().matchAll(/\/\/ ([A-Z][A-Z_]+)\b/g)].map((m) => m[1]);
  assert.deepStrictEqual(named('isPageRecord'), ['PAGE_KIND', 'PAGE_ITEM_MAX', 'PAGE_END_MAX']);
  assert.deepStrictEqual(named('reboxPoints'), ['STROKE_STRIDE']);
  assert.deepStrictEqual(named('mapPage'), ['STROKE_STRIDE', 'PAGE_DEGENERATE_PX']);
});

test('the served copy answers mapPage, isPageRecord, pageLabel and strokeGroups as the CommonJS module', async () => {
  const mod = await importSource(S.browserModuleSource());
  const served = await import(pathToFileURL(path.join(REPO, 'public/app/strokes.js')).href);
  assert.deepStrictEqual([...mod.DOC_SPLICE], [...S.DOC_SPLICE]);
  for (const m of [mod, served]) {
    for (const [A, B] of [[RA, RB], [{ left: 50, top: 80, w: 300, h: 200 }, { left: 900, top: 300, w: 400, h: 100 }], [RA, null], [null, null]]) {
      assert.deepStrictEqual(m.mapPage(arrow(), arrowPayload(), A, B), S.mapPage(arrow(), arrowPayload(), A, B));
      assert.deepStrictEqual(m.mapPage(margin(), marginPayload(), A, B), S.mapPage(margin(), marginPayload(), A, B));
    }
    assert.equal(m.isPageRecord(arrow()), true);
    assert.equal(m.pageLabel(arrow()), 'from A to B');
    assert.deepStrictEqual(m.reboxPoints([0.5, 0.5, 0.5, 0], RA, RB), S.reboxPoints([0.5, 0.5, 0.5, 0], RA, RB));
    const rows = [row('p1', 0, 'a', arrow()), row('p2', 3, 'a', arrow()), row('p3', 9, 'a', margin())];
    assert.deepStrictEqual(m.strokeGroups(rows), S.strokeGroups(rows));
  }
});

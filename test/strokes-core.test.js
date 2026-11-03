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
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const S = require('../lib/core/strokes');
const log = require('../lib/core/element-log');
const { stableStringify } = require('../lib/core/stable-json');
const { classify } = require('../lib/core/remote-policy');
const { withServer } = require('../test-support/helpers');

const REPO = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(REPO, 'lib/core/strokes.js'), 'utf8');
const importSource = (src) => import('data:text/javascript,' + encodeURIComponent(src));
const NAMES = ['DESCRIBE_KEYS', 'GROUP_WINDOW_MS', 'STROKE_ID_ATTR', 'STROKE_KEYS', 'STROKE_NAME_MAX',
  'STROKE_POINTS_MAX', 'STROKE_STRIDE', 'bboxOf', 'decimate', 'isStrokePayload', 'roundPoints', 'sameTarget',
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

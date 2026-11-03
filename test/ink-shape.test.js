// The stroke group's description (annotation engine tranche 4, plan 4F.2,
// U562; lib/core/ink-shape.js): the pure shape classifier and describeOf.
//
// Pinned here:
//   - a seeded synthetic fixture set — 40 jittered point sets per class
//     (circle, underline, strike, arrow, check, cross), generated below with
//     random size, place, rotation, sample count and hand jitter — reads at
//     least 90 % right per class; a dense scribble answers 'other';
//   - underline vs strike is the text box's call (the same flat stroke reads
//     strike through the box's middle, underline in its lower band or below,
//     underline with no box at all);
//   - classify emits only words from SHAPES, for every fixture and for junk;
//   - describeOf: the count of stroke members, the union bbox, the members'
//     own text_under de-duplicated in member order, joined with ' … ' and cut
//     at TEXT_UNDER_MAX; a non-stroke member is not counted;
//   - lib/core/ink-shape.js requires and imports nothing; its stride is
//     lib/core/strokes' STROKE_STRIDE.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const K = require('../lib/core/ink-shape');
const { STROKE_STRIDE } = require('../lib/core/strokes');

const { SHAPES, classify, describeOf, TEXT_UNDER_MAX, CONFIDENCE_MIN } = K;

// ── the fixture generator (seeded) ───────────────────────────────────────────
function rngOf(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r, a, b) => a + (b - a) * r();
const gauss = (r) => {
  let u = 0; let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// A polyline through `vs` ([[x, y], …]) sampled every `step`, each sample
// jittered by `jit` (σ), as one flat stroke [x, y, p, t, …].
function stroke(r, vs, { step = 0.006, jit = 0.0025 } = {}) {
  const out = [];
  let t = 0;
  for (let i = 1; i < vs.length; i++) {
    const [ax, ay] = vs[i - 1];
    const [bx, by] = vs[i];
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const u = k / n;
      out.push(ax + (bx - ax) * u + gauss(r) * jit, ay + (by - ay) * u + gauss(r) * jit, 0.5, t);
      t += 8;
    }
  }
  return out;
}
const rot = (vs, cx, cy, a) => vs.map(([x, y]) => [
  cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
  cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
]);

// Each generator → {strokes, opts}.
const GEN = {
  circle(r) {
    const cx = between(r, 0.3, 0.7); const cy = between(r, 0.3, 0.7);
    const ry = between(r, 0.05, 0.2); const rx = ry * between(r, 1, 3);
    const a0 = between(r, 0, 2 * Math.PI);
    const sweep = 2 * Math.PI + between(r, -0.35, 0.4);
    const n = Math.round(between(r, 30, 80));
    const vs = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      // A hand wobble on the radius.
      const w = 1 + 0.05 * Math.sin(3 * a + a0);
      vs.push([cx + rx * w * Math.cos(a), cy + ry * w * Math.sin(a)]);
    }
    return { strokes: [stroke(r, vs, { step: 0.01, jit: ry * 0.02 })], opts: {} };
  },
  underline(r) {
    const x = between(r, 0.05, 0.4); const w = between(r, 0.2, 0.5);
    const top = between(r, 0.2, 0.6); const h = between(r, 0.04, 0.1);
    const y = top + h * between(r, 0.78, 1.25);
    const tilt = between(r, -0.04, 0.04);
    const bow = between(r, -0.006, 0.006);
    const vs = [[x, y], [x + w / 2, y + w * tilt / 2 + bow], [x + w, y + w * tilt]];
    return { strokes: [stroke(r, vs)], opts: { textBox: [x - 0.01, top, w + 0.02, h] } };
  },
  strike(r) {
    const x = between(r, 0.05, 0.4); const w = between(r, 0.2, 0.5);
    const top = between(r, 0.2, 0.6); const h = between(r, 0.04, 0.1);
    const y = top + h * between(r, 0.35, 0.62);
    const tilt = between(r, -0.03, 0.03);
    const vs = [[x, y], [x + w, y + w * tilt]];
    return { strokes: [stroke(r, vs, { jit: h * 0.03 })], opts: { textBox: [x - 0.01, top, w + 0.02, h] } };
  },
  arrow(r) {
    const ax = between(r, 0.15, 0.4); const ay = between(r, 0.2, 0.8);
    const len = between(r, 0.25, 0.5);
    const ang = between(r, -0.8, 0.8) + (r() < 0.3 ? Math.PI : 0);
    const bx = ax + len * Math.cos(ang); const by = ay + len * Math.sin(ang);
    const barb = len * between(r, 0.2, 0.32);
    const spread = between(r, 0.45, 0.7);
    const back = ang + Math.PI;
    const b1 = [bx + barb * Math.cos(back + spread), by + barb * Math.sin(back + spread)];
    const b2 = [bx + barb * Math.cos(back - spread), by + barb * Math.sin(back - spread)];
    const form = Math.floor(r() * 3);
    if (form === 0) return { strokes: [stroke(r, [[ax, ay], [bx, by]]), stroke(r, [b1, [bx, by], b2])], opts: {} };
    if (form === 1) return { strokes: [stroke(r, [[ax, ay], [bx, by], b1, [bx, by], b2])], opts: {} };
    return { strokes: [stroke(r, [[ax, ay], [bx, by], b1])], opts: {} };
  },
  check(r) {
    const x = between(r, 0.2, 0.6); const y = between(r, 0.2, 0.6);
    const s = between(r, 0.08, 0.25);
    const corner = [x + s * between(r, 0.25, 0.45), y + s * between(r, 0.45, 0.65)];
    const end = [x + s * between(r, 0.9, 1.2), y - s * between(r, 0.4, 0.8)];
    const vs = rot([[x, y], corner, end], corner[0], corner[1], between(r, -0.2, 0.2));
    return { strokes: [stroke(r, vs, { step: 0.004, jit: s * 0.012 })], opts: {} };
  },
  cross(r) {
    const cx = between(r, 0.3, 0.7); const cy = between(r, 0.3, 0.7);
    const s = between(r, 0.05, 0.2);
    const a = Math.PI / 4 + between(r, -0.3, 0.3);
    const b = (3 * Math.PI) / 4 + between(r, -0.3, 0.3);
    const off = () => between(r, -0.15, 0.15) * s;
    const line = (t) => [[cx - s * Math.cos(t) + off(), cy - s * Math.sin(t) + off()], [cx + s * Math.cos(t) + off(), cy + s * Math.sin(t) + off()]];
    return { strokes: [stroke(r, line(a), { jit: s * 0.02 }), stroke(r, line(b), { jit: s * 0.02 })], opts: {} };
  },
};
const PER_CLASS = 40;
const fixtures = (name, seed) => {
  const r = rngOf(seed);
  return Array.from({ length: PER_CLASS }, () => GEN[name](r));
};

test('the fixture set: at least 90 % right per class (40 jittered point sets each, seeded)', () => {
  const misses = {};
  Object.keys(GEN).forEach((name, k) => {
    const set = fixtures(name, 1000 + k * 7919);
    let right = 0;
    const wrong = {};
    for (const f of set) {
      const got = classify(f.strokes, f.opts);
      assert.ok(SHAPES.includes(got.shape), `${name}: ${got.shape} is a SHAPES word`);
      assert.ok(typeof got.confidence === 'number' && got.confidence >= 0 && got.confidence <= 1, `${name}: confidence ${got.confidence}`);
      if (got.shape === name) {
        right += 1;
        assert.ok(got.confidence >= CONFIDENCE_MIN, `${name}: a named shape is at least CONFIDENCE_MIN`);
      } else wrong[got.shape] = (wrong[got.shape] || 0) + 1;
    }
    misses[name] = { right, of: set.length, wrong };
    assert.ok(right / set.length >= 0.9, `${name}: ${right}/${set.length} right (${JSON.stringify(wrong)})`);
  });
  assert.deepStrictEqual(Object.keys(misses), ['circle', 'underline', 'strike', 'arrow', 'check', 'cross']);
});

test('an ambiguous scribble answers other', () => {
  const r = rngOf(42);
  for (let k = 0; k < 20; k++) {
    // A dense back-and-forth over a small region.
    const vs = [];
    const x = between(r, 0.2, 0.6); const y = between(r, 0.2, 0.6);
    const n = 10 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) vs.push([x + between(r, 0, 0.15), y + between(r, 0, 0.15)]);
    const got = classify([stroke(r, vs)]);
    assert.equal(got.shape, 'other', `scribble ${k}`);
  }
  // Three strokes of three different shapes agree on nothing.
  const mixed = [GEN.circle(r).strokes[0], GEN.check(r).strokes[0], GEN.underline(r).strokes[0]];
  assert.equal(classify(mixed).shape, 'other');
});

test('underline vs strike is the text box\'s call; no text box reads a flat stroke as underline', () => {
  const r = rngOf(7);
  const line = (y) => stroke(r, [[0.2, y], [0.6, y]], { jit: 0.0005 });
  const box = [0.18, 0.4, 0.45, 0.1];   // a line of text from 0.40 to 0.50
  assert.equal(classify([line(0.45)], { textBox: box }).shape, 'strike', 'through the middle');
  assert.equal(classify([line(0.49)], { textBox: box }).shape, 'underline', 'the lower 30 %');
  assert.equal(classify([line(0.52)], { textBox: box }).shape, 'underline', 'below the box');
  assert.equal(classify([line(0.45)]).shape, 'underline', 'no text box: flat and alone');
  assert.equal(classify([line(0.45)], { textBox: null }).shape, 'underline');
  // Several strokes read against their own boxes when given.
  const boxes = [[0.18, 0.1, 0.45, 0.1], [0.18, 0.3, 0.45, 0.1]];
  const union = [0.18, 0.1, 0.45, 0.3];
  assert.equal(classify([line(0.205), line(0.405)], { textBox: union, textBoxes: boxes }).shape, 'underline');
  assert.equal(classify([line(0.15), line(0.35)], { textBox: union, textBoxes: boxes }).shape, 'strike');
});

test('classify emits only words from SHAPES, whatever it is handed', () => {
  const junk = [undefined, null, [], [[]], [[1, 2]], [[NaN, NaN, 0, 0, NaN, 1, 0, 1]], [['a', 'b', 'c', 'd']], [[0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 8]], 'x', 7, {}];
  for (const j of junk) {
    const got = classify(j, { textBox: 'nope', textBoxes: 'nope', aspect: -1 });
    assert.deepStrictEqual(got, { shape: 'other', confidence: 0 }, JSON.stringify(j));
  }
  assert.deepStrictEqual(SHAPES, ['circle', 'underline', 'strike', 'arrow', 'check', 'cross', 'other']);
  assert.ok(Object.isFrozen(SHAPES));
  // The module's source holds no other word it could answer.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/core/ink-shape.js'), 'utf8');
  const shapes = [...src.matchAll(/shape: '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(shapes.length > 0);
  for (const s of shapes) assert.ok(SHAPES.includes(s), s);
});

test('the aspect: a stroke flat in pixels reads flat on a tall frame', () => {
  const r = rngOf(9);
  // On a frame 1 wide, 4 tall: a run 0.4 wide and 0.06 tall in units is 0.4
  // by 0.24 in height units — 31° — so it is flat only with the aspect.
  const s = stroke(r, [[0.2, 0.5], [0.6, 0.56]], { jit: 0 });
  assert.equal(classify([s], { aspect: 1 }).shape, 'underline', 'no aspect: about 8.5°');
  assert.equal(classify([s], { aspect: 0.25 }).shape, 'other', 'a tall frame: steep');
});

test('describeOf: the count, the union bbox, the text under de-duplicated in member order and cut at TEXT_UNDER_MAX', () => {
  const rec = (points, extra = {}) => ({ points, stride: STROKE_STRIDE, aspect: 1, ...extra });
  const a = rec([0.1, 0.5, 0.5, 0, 0.4, 0.5, 0.5, 8], { text_under: 'Revenue  fell', text_box: [0.1, 0.4, 0.3, 0.1] });
  const b = rec([0.2, 0.7, 0.5, 0, 0.6, 0.71, 0.5, 8], { text_under: 'by 4 %', text_box: [0.2, 0.6, 0.4, 0.1] });
  const c = rec([0.3, 0.2, 0.5, 0, 0.35, 0.25, 0.5, 8], { text_under: 'Revenue fell' });
  const d = describeOf([a, b, c, { points: [1, 2, 3], stride: 4 }, null, { text_under: 'no stroke' }]);
  assert.equal(d.count, 3, 'only the stroke members count');
  assert.deepStrictEqual(d.bbox, [0.1, 0.2, 0.5, 0.51]);
  assert.equal(d.text_under, 'Revenue fell … by 4 %', 'whitespace folded, the repeat dropped, member order');
  assert.ok(SHAPES.includes(d.shape));
  assert.equal(typeof d.confidence, 'number');
  assert.deepStrictEqual(Object.keys(d), ['shape', 'confidence', 'count', 'bbox', 'text_under']);

  const long = describeOf([rec(a.points, { text_under: 'x'.repeat(200) }), rec(b.points, { text_under: 'y'.repeat(200) })]);
  assert.equal(long.text_under.length, TEXT_UNDER_MAX);
  assert.ok(long.text_under.endsWith('…'));
  assert.ok(long.text_under.startsWith(`${'x'.repeat(200)} … y`));
  assert.equal(TEXT_UNDER_MAX, 300);

  assert.deepStrictEqual(describeOf([]), { shape: 'other', confidence: 0, count: 0, bbox: null, text_under: '' });
  assert.deepStrictEqual(describeOf(null), { shape: 'other', confidence: 0, count: 0, bbox: null, text_under: '' });
  const none = describeOf([rec(a.points)]);
  assert.equal(none.text_under, '', 'no member text');
  assert.equal(none.count, 1);
  // Three underlines under three lines, each with its own text box.
  const lines = [0.2, 0.4, 0.6].map((y) => rec([0.1, y + 0.095, 0.5, 0, 0.5, y + 0.096, 0.5, 8], { text_box: [0.1, y, 0.4, 0.1], text_under: `line ${y}` }));
  const three = describeOf(lines);
  assert.equal(three.shape, 'underline');
  assert.equal(three.count, 3);
  assert.equal(three.text_under, 'line 0.2 … line 0.4 … line 0.6');
});

test('lib/core/ink-shape.js requires and imports nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/core/ink-shape.js'), 'utf8');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require(');
  assert.ok(!/^\s*import\b/m.test(src) && !/\bimport\s*\(/.test(src), 'no import');
  assert.ok(!/Date\.now|performance\.|Math\.random/.test(src), 'no clock and no randomness: pure');
  assert.equal(STROKE_STRIDE, 4, 'the stride the module reads is lib/core/strokes\'');
  for (const [k, v] of Object.entries(K)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} is a finite constant`);
  }
});

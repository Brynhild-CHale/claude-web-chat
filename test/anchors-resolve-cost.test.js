// lib/core/anchors.js, U244 (PLAN.md 1C.4 and 1C.1; DECISIONS.md I.5 G1 (a)
// and G2 (a)): resolveAll serves range records through the one range rule
// (rangeIn, the path resolveRange takes) under the same per-frame budget as
// element records, against one text table per index generation; and the
// element resolver's cost work (the tie path's head read deferred to the tie,
// step 2's answer-preserving bound) leaves every answer as 46e6f24 gave it.
//
// The mechanics are proved with test/anchors-chunk.test.js's fake clock and
// scheduler: `now()` reads a counter that advances 1.5 ms per resolved record
// (an element record through a getter on `form`, which resolve() reads once;
// a range record through a getter on `quote` that charges its first read
// only), and `schedule(fn)` records the frame, which the test runs one at a
// time. Nothing here asserts a speed: the real timings are GT-05's, in Chrome.
//
// The answers are proved against test/fixtures/anchors/step2-answers.json,
// frozen from ae/int 46e6f24's own resolve() before any edit: a seeded
// synthetic page shaped like n165 (rows whose keys repeat, so ties occur),
// 481 element records, stale 25 % and 100 % (at.path under a child index no
// pane has, perf.js's staleify), at CONFIG, at {head_floor: false} and
// {ordinal: false}, and at two step-2 sensitivity configs ({margin: 0.01},
// {tol: 0.5, margin: 0.001}) whose decisions read s1 and s2 closely, field
// by field.
//
// The cases are split across two files by their cost, so each runs well under
// the 60 s test timeout on Node 22 under a parallel load (U302a): this file
// holds chunking, equality and no stale text; anchors-resolve-cost-2.test.js
// holds watch, one text table per pass, the answers frozen at 46e6f24 and
// step 2's bound. Each file is self-contained (its own helpers).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const { ANCHOR_STATES } = require('../lib/core/anchor-states');

const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const COST = 1.5;
const BUDGET = 10;
const RANGE_KEYS = ['state', 'start', 'end', 'how', 'occ', 'dice'];

const WINDOWS = [];
function newWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(RUNTIME);
  WINDOWS.push(dom.window);
  return dom.window;
}
test.after(() => { for (const w of WINDOWS) w.close(); });
const W = newWindow();

function mount(html, win = W, id = 'm') {
  const host = win.document.createElement('div');
  host.dataset.mountId = id;
  win.document.body.appendChild(host);
  return win.__wcMount.attachAndExtract(host, html).root;
}
const wire = (o) => JSON.parse(JSON.stringify(o));
const fresh = () => anchors.createAnchors(ANCHOR_STATES);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// test/anchors-chunk.test.js's pane: 6 sections of 12 rows of 3 sub-rows.
function bigPane() {
  let html = '';
  for (let s = 0; s < 6; s++) {
    let rows = '';
    for (let r = 0; r < 12; r++) {
      let sub = '';
      for (let k = 0; k < 3; k++) sub += `<li class="sub"><i>step ${s}.${r}.${k}</i><button class="go">Run</button></li>`;
      rows += `<li class="row"><b>Section ${s} row ${r}</b><span class="d">detail text for row ${r} of ${s}</span><ul class="subs">${sub}</ul></li>`;
    }
    html += `<section class="sec"><h3>Section ${s}</h3><ul class="rows">${rows}</ul></section>`;
  }
  return html;
}
function elementRecords(html, n, win = W) {
  const from = mount(html, win);
  const ix = anchors.index(from);
  const out = [];
  for (const e of ix.els) {
    const r = anchors.record(from, e.node, { ix });
    if (r) out.push(wire(r));
    if (out.length === n) break;
  }
  assert.equal(out.length, n, `the pane yields ${n} element records`);
  return out;
}
// n range records over seeded spans inside the pane's text nodes.
function rangeRecords(html, n, seed, win = W) {
  const from = mount(html, win);
  const nodes = [];
  const walk = (node) => { for (const ch of node.childNodes) { if (ch.nodeType === 3) { if (ch.data.length >= 3) nodes.push(ch); } else if (ch.nodeType === 1) walk(ch); } };
  walk(from);
  const r = rng(seed);
  const out = [];
  while (out.length < n) {
    const t = nodes[Math.floor(r() * nodes.length)];
    const a = Math.floor(r() * (t.data.length - 2));
    const b = a + 2 + Math.floor(r() * (t.data.length - a - 1));
    const range = win.document.createRange();
    range.setStart(t, a);
    range.setEnd(t, Math.min(b, t.data.length));
    const rec = anchors.recordRange(from, range);
    if (rec) out.push(wire(rec));
  }
  return out;
}
// 300 element and 200 range records interleaved (two ranges in every five).
function mixed(html, win = W) {
  const els = elementRecords(html, 300, win);
  const rgs = rangeRecords(html, 200, 244, win);
  const out = [];
  for (let k = 0; k < 500; k++) out.push(k % 5 === 1 || k % 5 === 3 ? rgs.shift() : els.shift());
  return out;
}
function changeDom(root) {
  root.querySelector('ul.rows > li').remove();
  root.querySelector('section.sec h3').textContent = 'Renamed';
  for (const b of [...root.querySelectorAll('li.row > b')].slice(3, 9)) b.textContent = b.textContent.replace('row', 'line');
}

// The fake clock and scheduler (test/anchors-chunk.test.js's).
function harness() {
  const h = {
    t: 0,
    frames: [],
    scheduled: 0,
    log: [],
    resolved: 0,
    now: () => h.t,
    schedule: (fn) => { h.scheduled++; h.frames.push(fn); },
    step() {
      const fn = h.frames.shift();
      assert.ok(fn, 'a frame is scheduled');
      const t0 = h.t;
      const r0 = h.resolved;
      fn();
      h.log.push({ ms: h.t - t0, records: h.resolved - r0 });
    },
    drain(max = 100000) {
      let n = 0;
      while (h.frames.length) {
        assert.ok(n++ < max, 'the pass ends');
        h.step();
      }
    },
    charge() { h.t += COST; h.resolved++; },
    // An element record costs COST on its one `form` read; a range record on
    // the first read of its `quote` (holding a range is read from `kind`).
    costly(rec) {
      const r = { ...rec };
      if (rec && rec.kind === 'range') {
        const quote = rec.quote;
        let paid = false;
        Object.defineProperty(r, 'quote', { get() { if (!paid) { paid = true; h.charge(); } return quote; }, enumerable: false });
        return r;
      }
      const form = rec.form;
      Object.defineProperty(r, 'form', { get() { h.charge(); return form; }, enumerable: false });
      return r;
    },
  };
  return h;
}

const expected = (root, recs) => recs.map((r) => (r && r.kind === 'range' ? anchors.resolveRange(root, r) : anchors.resolve(root, r)));
// A range answer equals another field by field, its DOM Range by its text and
// its boundary nodes; an element answer equals as a whole.
function sameAnswer(got, want, label) {
  if (want && 'start' in want) {
    assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${label}: the answer's keys`);
    for (const k of RANGE_KEYS) assert.deepStrictEqual(got[k], want[k], `${label}: ${k}`);
    if (!want.range) {
      assert.equal(got.range, null, `${label}: no range`);
      return;
    }
    assert.ok(got.range, `${label}: a range`);
    assert.equal(got.range.toString(), want.range.toString(), `${label}: the range's text`);
    assert.strictEqual(got.range.startContainer, want.range.startContainer, `${label}: start node`);
    assert.equal(got.range.startOffset, want.range.startOffset, `${label}: start offset`);
    assert.strictEqual(got.range.endContainer, want.range.endContainer, `${label}: end node`);
    assert.equal(got.range.endOffset, want.range.endOffset, `${label}: end offset`);
    return;
  }
  assert.deepStrictEqual(got, want, label);
}
function sameAnswers(got, want, label) {
  assert.equal(got.length, want.length, `${label}: one answer per record`);
  for (let k = 0; k < want.length; k++) sameAnswer(got[k], want[k], `${label} #${k}`);
}

// ── chunking ───────────────────────────────────────────────────────────────

test('chunking: 300 element and 200 range records interleaved share one budget; the index and its text table are the first chunk', () => {
  const A = fresh();
  const h = harness();
  const html = bigPane();
  const recs = mixed(html);
  const root = mount(html);
  let calls = 0;
  let done = null;
  A.resolveAll(root, recs.map(h.costly), { budget_ms: BUDGET, schedule: h.schedule, now: h.now }, (answers, report) => { calls++; done = { answers, report }; });
  assert.equal(h.resolved, 0, 'nothing runs synchronously');
  h.drain();
  assert.equal(calls, 1, 'onDone once');
  assert.equal(h.log[0].records, 0, 'the first chunk builds the index and the text table, and resolves nothing');
  for (const f of h.log) assert.ok(f.ms <= BUDGET + COST, `a chunk's work ${f.ms} ms is within the budget plus one record`);
  for (const f of h.log.slice(1)) assert.ok(f.records >= 1, 'every later chunk resolves');
  assert.equal(h.resolved, 500, 'each record served once, in the loop');
  const { answers, report } = done;
  assert.deepEqual(Object.keys(report), ['records', 'chunks', 'longest_ms', 'work_ms', 'index_ms', 'wall_ms', 'gen', 'restarts', 'ranges', 'range_ms']);
  assert.equal(report.records, 500);
  assert.equal(report.ranges, 200, 'ranges counts the range records served');
  assert.ok(report.range_ms >= 0 && report.range_ms <= report.work_ms, 'range_ms is part of work_ms');
  assert.equal(report.range_ms, 200 * COST, 'range_ms is the range records\' resolve time');
  assert.equal(report.work_ms, 500 * COST);
  assert.equal(report.chunks, h.log.length);
  assert.equal(report.chunks, 1 + Math.ceil(500 / 7), '7 records of either kind reach the budget');
  assert.equal(report.wall_ms, 500 * COST, 'the whole re-resolve, reported beside');
  sameAnswers(answers, expected(root, recs), 'record order');
  assert.ok(answers.some((a, k) => recs[k].kind === 'range' && a.state === 'exact'), 'range records are answered by the range rule');
});

// ── equality ───────────────────────────────────────────────────────────────

test('equality: resolveAll answers resolveRange for a range record and resolve() for the rest, chunked and unchunked', () => {
  const html = bigPane();
  const recs = mixed(html);
  for (const changed of [false, true]) {
    const root = mount(html);
    if (changed) changeDom(root);
    const want = expected(root, recs);
    if (changed) {
      const hows = new Set(want.filter((a) => 'start' in a).map((a) => a.how));
      assert.ok(hows.size >= 3, `the change gives several range answers (${[...hows]})`);
    }
    for (const budget of [BUDGET, 0, Infinity]) {
      const A = fresh();
      const h = harness();
      let got = null;
      A.resolveAll(root, recs.map(h.costly), { budget_ms: budget, schedule: h.schedule, now: h.now }, (answers) => { got = answers; });
      h.drain();
      sameAnswers(got, want, `${changed ? 'changed' : 'unchanged'} DOM, budget ${budget}`);
      if (budget === Infinity) assert.equal(h.log.length, 2, 'unchunked: the index chunk and one resolve chunk');
    }
  }
});

test('equality: a cfg reaches range records too, and a source record still answers orphaned invalid-record', () => {
  const html = bigPane();
  const root = mount(html);
  const ranges = rangeRecords(html, 30, 7);
  const recs = ranges.map((r) => ({ ...r, quote: { ...r.quote, exact: `${r.quote.exact}zq` }, pos: { start: 0, end: 1 } }));
  const src = { v: 1, kind: 'source', md: 'md-1', slug: null, quote: { exact: 'Section 0', prefix: '', suffix: '' }, pos: { start: 0, end: 9 } };
  recs.push(src);
  for (const cfg of [undefined, { fuzzy_tol: 0.2 }, { fuzzy_tol: 1.01 }]) {
    const A = fresh();
    const h = harness();
    let got = null;
    A.resolveAll(root, recs, { cfg, schedule: h.schedule, now: h.now }, (answers) => { got = answers; });
    h.drain();
    const want = recs.map((r) => (r.kind === 'range' ? anchors.resolveRange(root, r, cfg) : anchors.resolve(root, r, cfg)));
    sameAnswers(got, want, `cfg ${JSON.stringify(cfg)}`);
    assert.deepStrictEqual([got[recs.length - 1].state, got[recs.length - 1].how], ['orphaned', 'invalid-record'], 'the source record');
  }
});


test('no stale text: invalidate between chunks 2 and 3 with the text changed restarts the pass on a fresh table', () => {
  const A = fresh();
  const h = harness();
  const html = bigPane();
  const recs = mixed(html);
  const root = mount(html);
  const before = expected(root, recs);
  let calls = 0;
  let got = null;
  A.resolveAll(root, recs.map(h.costly), { schedule: h.schedule, now: h.now }, (answers, report) => { calls++; got = { answers, report }; });
  h.step();
  h.step();
  assert.ok(h.resolved > 0, 'chunk 2 answered records on the old text');
  root.querySelector('li.row > b').textContent = 'S0r0';
  A.invalidate(root);
  h.drain();
  assert.equal(calls, 1, 'onDone once');
  assert.equal(got.report.restarts, 1);
  assert.equal(got.report.ranges, 200, 'ranges counts the delivered pass');
  assert.equal(h.log[2].records, 0, 'the restart builds the fresh index and table in a chunk of their own');
  const want = expected(root, recs);
  assert.ok(want.some((a, k) => 'start' in a && a.start !== before[k].start), 'the change moves range answers');
  sameAnswers(got.answers, want, 'every answer is fresh on the changed DOM');
});

test('no stale text: a new settle generation mid-pass does the same', (t) => {
  const win = newWindow();
  const M = win.__wcMount;
  const A = fresh();
  const h = harness();
  A.install(M, { budget_ms: BUDGET, schedule: h.schedule, now: h.now });
  t.after(() => A.install({}));
  const html = bigPane();
  const recs = mixed(html, win);
  const root = mount(html, win, 'p1');
  const before = expected(root, recs);
  const seen = [];
  t.after(A.watch('p1', { records: () => recs.map(h.costly), onAnswers: (answers, report) => seen.push({ answers, report }) }));
  M.settle(root, 'p1', 'mount');
  h.step();
  h.step();
  assert.ok(h.resolved > 0 && h.resolved < 500, 'mid-pass');
  root.querySelector('li.row > b').textContent = 'S0r0';
  M.settle(root, 'p1', 'form');
  h.drain();
  assert.equal(seen.length, 1, 'onAnswers once');
  assert.equal(seen[0].report.restarts, 1);
  assert.equal(seen[0].report.gen, M.generation(root));
  const want = expected(root, recs);
  assert.ok(want.some((a, k) => 'start' in a && a.start !== before[k].start), 'the change moves range answers');
  sameAnswers(seen[0].answers, want, 'no answer from the old text');
});

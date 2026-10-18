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

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const { ANCHOR_STATES } = require('../lib/core/anchor-states');

const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'anchors', 'step2-answers.json'), 'utf8'));
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
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

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

test('watch: a pass whose records() returns both kinds answers as resolveAll does', (t) => {
  const win = newWindow();
  const M = win.__wcMount;
  const A = fresh();
  const h = harness();
  A.install(M, { budget_ms: BUDGET, schedule: h.schedule, now: h.now });
  t.after(() => A.install({}));
  const html = bigPane();
  const recs = mixed(html, win);
  const root = mount(html, win, 'p1');
  const seen = [];
  t.after(A.watch('p1', { records: () => recs.map(h.costly), onAnswers: (answers, report) => seen.push({ answers, report }) }));
  M.settle(root, 'p1', 'mount');
  h.drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].report.ranges, 200);
  assert.equal(seen[0].report.gen, M.generation(root));
  for (const f of h.log) assert.ok(f.ms <= BUDGET + COST, 'the shared loop holds the budget');
  sameAnswers(seen[0].answers, expected(root, recs), 'watched');
});

// ── no stale text ──────────────────────────────────────────────────────────

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

// ── one text table per index generation ────────────────────────────────────

test('one text table per pass: a cached index without a table builds one in a chunk of its own; a later pass reuses both', () => {
  const A = fresh();
  const h = harness();
  const html = bigPane();
  const recs = mixed(html);
  const root = mount(html);
  const run = (list) => {
    let out = null;
    const at = h.log.length;
    A.resolveAll(root, list.map(h.costly), { schedule: h.schedule, now: h.now }, (answers, report) => { out = { answers, report }; });
    h.drain();
    return { ...out, frames: h.log.slice(at) };
  };
  const els = run(recs.filter((r) => r.kind !== 'range'));
  assert.equal(els.frames[0].records, 0, 'element records only: the index chunk');
  const first = run(recs);
  assert.equal(first.frames[0].records, 0, 'the cached index has no table: a table chunk first');
  assert.ok(first.frames.slice(1).every((f) => f.records >= 1), 'then resolve chunks only');
  assert.equal(first.report.chunks, first.frames.length, 'report.chunks counts the table chunk');
  assert.equal(first.report.chunks, 1 + Math.ceil(500 / 7));
  const second = run(recs);
  assert.ok(second.frames.every((f) => f.records >= 1), 'a cached index with its table: no index or table chunk');
  assert.equal(second.report.chunks, Math.ceil(500 / 7));
  sameAnswers(second.answers, first.answers, 'two passes on an unchanged root answer identically');
  sameAnswers(first.answers, expected(root, recs), 'and as resolveRange / resolve do');
  A.invalidate(root);
  const third = run(recs);
  assert.equal(third.frames[0].records, 0, 'invalidated: the index and table chunk again');
});

// ── answers frozen at 46e6f24 ──────────────────────────────────────────────

// The frozen page: html(model), and its mutated copy html(apply(model, mutation)).
function pageHtml(secs) {
  let out = '';
  for (const sec of secs) {
    let rows = '';
    for (const row of sec.rows) {
      let sub = '';
      if (row.subs) sub = `<ul class="subs">${row.subs.map((x) => `<li class="sub"><i>${x.step}</i><b class="go">${x.act}</b></li>`).join('')}</ul>`;
      rows += `<div class="row" data-n="${row.n}"><span class="k">${row.key}</span><span class="v">${row.val}</span><span class="n">${row.n}</span><a class="go" href="#">open</a>${sub}</div>`;
    }
    out += `<section class="sec"><h3>${sec.title}</h3><div class="grid">${rows}</div></section>`;
  }
  return out;
}
function applyMutation(secs, ops) {
  const out = JSON.parse(JSON.stringify(secs));
  for (const [s, k] of ops.edited) out[s].rows[k].val += ' edited';
  for (const [s, k] of ops.replaced) out[s].rows[k].val = 'quite different words now';
  const gone = new Set(ops.removed.map(([s, k]) => `${s}.${k}`));
  out.forEach((sec, s) => { sec.rows = sec.rows.filter((_, k) => !gone.has(`${s}.${k}`)); });
  out[0].rows.unshift({ key: 'Inserted', val: 'a new row at the top', n: 1, subs: null });
  return out;
}
function frozenPage() {
  const html = pageHtml(FROZEN.model);
  const mutated = pageHtml(applyMutation(FROZEN.model, FROZEN.mutation));
  assert.equal(sha(html), FROZEN.html_sha256, 'the frozen page is rebuilt byte for byte');
  assert.equal(sha(mutated), FROZEN.mutated_sha256, 'and its mutated copy');
  const from = mount(html);
  const ix = anchors.index(from);
  const records = FROZEN.picks.map((i) => wire(anchors.record(from, ix.els[i].node, { ix })));
  assert.equal(sha(JSON.stringify(records)), FROZEN.records_sha256, 'record() writes the frozen records (row heads included)');
  return { roots: { same: mount(html), mutated: mount(mutated) }, records };
}
const staleOf = (rec) => ({ ...rec, at: { ...rec.at, path: [9999].concat(rec.at.path) } });
function variantRecords(records, name) {
  const st = new Set(FROZEN.stale25);
  return records.map((r, k) => (name === 'stale100' || st.has(k) ? staleOf(r) : r));
}
const CFG_NAMES = ['default', 'head_floor-off', 'ordinal-off', 'margin-0.01', 'tol-0.5-margin-0.001'];
const VARIANT_DOM = { stale25: 'same', stale100: 'same', 'mutated-stale25': 'mutated' };
function frozenRows(name, cfgName) {
  const base = FROZEN.answers[`${name}|default`];
  if (cfgName === 'default') return base;
  const { diff } = FROZEN.answers[`${name}|${cfgName}`];
  return base.map((row, k) => diff[k] || row);
}
function rowOf(a) {
  const keys = Object.keys(a).join(',');
  const tie = a.tie ? FROZEN.tie_keys.map((k) => a.tie[k]) : (a.tie === undefined ? 0 : null);
  return [FROZEN.shapes.indexOf(keys), a.state, a.i, a.how === undefined ? 0 : a.how, a.why === undefined ? 0 : a.why, a.via_head === undefined ? 0 : a.via_head, tie];
}

test('answers frozen: resolve() over the n165-shaped page equals 46e6f24 field by field (state, i, how, why, via_head, tie)', () => {
  const { roots, records } = frozenPage();
  let n = 0;
  let ties = 0;
  for (const name of Object.keys(VARIANT_DOM)) {
    const root = roots[VARIANT_DOM[name]];
    const recs = variantRecords(records, name);
    const nodes = anchors.index(root).els.map((e) => e.node);
    for (const cfgName of CFG_NAMES) {
      const cfg = FROZEN.cfgs[cfgName];
      const want = frozenRows(name, cfgName);
      // One index per variant and config, as a resolveAll pass holds one: its
      // memos (row heads, terms, groups) are shared by every record.
      const ix = anchors.index(root);
      recs.forEach((rec, k) => {
        const a = anchors.resolve(root, rec, cfg, ix);
        assert.deepStrictEqual(rowOf(a), want[k], `${name} ${cfgName} #${k}`);
        assert.strictEqual(a.el, a.i >= 0 ? nodes[a.i] : null, `${name} ${cfgName} #${k}: el is the i-th element`);
        if (a.tie) ties++;
        n++;
      });
    }
  }
  assert.equal(n, 481 * 3 * CFG_NAMES.length);
  assert.ok(ties > 300, `the page exercises the tie path (${ties} answers with a tie)`);
});

test('answers frozen: resolveAll over the frozen page answers as 46e6f24 did, chunked', () => {
  const { roots, records } = frozenPage();
  const recs = variantRecords(records, 'stale25');
  const want = frozenRows('stale25', 'default');
  const A = fresh();
  const h = harness();
  let got = null;
  A.resolveAll(roots.same, recs.map(h.costly), { budget_ms: BUDGET, schedule: h.schedule, now: h.now }, (answers) => { got = answers; });
  h.drain();
  assert.equal(got.length, want.length);
  got.forEach((a, k) => assert.deepStrictEqual(rowOf(a), want[k], `stale25 #${k}`));
});

// The bound, pinned to the bit: an unbounded oracle of step 2's scan (harness
// score + scoreBest as 46e6f24 wrote it, every candidate scored) gives each
// stale record's s1, s2 and b1; resolve() must answer re-resolved at b1 with
// {tol: 0, margin: s1 - s2} and orphaned 'score-margin' just above it, so its
// own s1 - s2 is the oracle's exactly and no pruned candidate moved s2.
function bigramsOf(s) {
  const set = new Set();
  s = s.toLowerCase();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function diceOf(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const x = bigramsOf(a);
  const y = bigramsOf(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
}
function jaccOf(a, b) {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
const attrsOf = (node) => [...node.attributes].map((a) => a.name).filter((n) => n !== 'class' && n !== 'id' && n !== 'style').sort();
function oracleScore(fp, at, e) {
  let s = 0;
  let w = 0;
  if (fp.id || e.id) { w += 0.15; s += fp.id === e.id ? 0.15 : 0; }
  w += 0.4; s += 0.4 * (fp.head === e.head ? 1 : diceOf(fp.head, e.head));
  w += 0.15; s += 0.15 * jaccOf(fp.cls || [], e.cls);
  w += 0.1; s += 0.1 * jaccOf(fp.attrs || [], attrsOf(e.node));
  w += 0.1; s += fp.parent === e.parentSig ? 0.1 : 0;
  w += 0.05; s += at.sib === e.sib ? 0.05 : 0;
  w += 0.05; s += (Array.isArray(at.path) ? at.path.join('.') : '') === e.path.join('.') ? 0.05 : 0;
  return s / w;
}
function oracleStep2(ix, rec) {
  let b1 = -1;
  let s1 = -1;
  let s2 = -1;
  for (const e of ix.els) {
    if (e.skip || e.tag !== rec.fp.tag) continue;
    const s = oracleScore(rec.fp, rec.at, e);
    if (s > s1) { s2 = s1; s1 = s; b1 = e.i; } else if (s > s2) s2 = s;
  }
  return { b1, s1, s2: s2 < 0 ? 0 : s2 };
}

// Rows whose values differ by one character: step 2 meets candidates whose
// head dice is in (0.9, 1), where a loose bound would move s2.
function nearDuplicatePane(seed) {
  const r = rng(seed);
  const base = 'the quick brown fox jumps over lazy dogs';
  let html = '';
  for (let s = 0; s < 4; s++) {
    let rows = '';
    for (let k = 0; k < 25; k++) {
      const p = Math.floor(r() * base.length);
      const v = base.slice(0, p) + String.fromCharCode(97 + Math.floor(r() * 26)) + base.slice(p + 1);
      rows += `<div class="row"><span class="k">${r() < 0.5 ? 'Same' : `K${k}`}</span><span class="v"${r() < 0.3 ? ' title="t"' : ''}>${v}</span><span class="v x">${v.slice(0, 20)}</span></div>`;
    }
    html += `<section><h3>S${s}</h3><div class="grid">${rows}</div></section>`;
  }
  return html;
}

test('step 2\'s bound is exact: resolve()\'s s1 - s2 and winner equal an unbounded scan\'s, record by record', () => {
  const { roots, records } = frozenPage();
  const cases = [['same', roots.same, records], ['mutated', roots.mutated, records]];
  for (const seed of [1, 2, 3]) {
    const html = nearDuplicatePane(seed);
    const from = mount(html);
    const ix = anchors.index(from);
    const recs = ix.els.filter((e) => !e.skip).map((e) => wire(anchors.record(from, e.node, { ix })));
    const to = mount(html.replace(/fox/g, (m, at) => (at % 3 ? m : 'fax')));
    cases.push([`near-duplicate ${seed}`, to, recs]);
  }
  let n = 0;
  for (const [label, root, recs] of cases) {
    const ix = anchors.index(root);
    let tied = 0;
    for (const rec of recs.map(staleOf)) {
      const o = oracleStep2(ix, rec);
      assert.ok(o.b1 >= 0, 'a candidate');
      const d = o.s1 - o.s2;
      const at = anchors.resolve(root, rec, { tol: 0, margin: d }, ix);
      assert.deepStrictEqual([at.state, at.how, at.i], ['re-resolved', 'score', o.b1], `${label}: at margin s1 - s2 the oracle's winner`);
      const above = anchors.resolve(root, rec, { tol: 0, margin: d + 1e-12 }, ix);
      assert.deepStrictEqual([above.state, above.how], ['orphaned', 'score-margin'], `${label}: just above s1 - s2 a margin miss`);
      if (d === 0) tied++;
      n++;
    }
    if (label === 'same') assert.ok(tied > 0, `${label}: exact score ties are exercised (${tied})`);
  }
  assert.ok(n > 481 * 2 + 600, `${n} stale records checked`);
});

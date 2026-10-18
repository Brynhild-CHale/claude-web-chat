// lib/core/anchors.js, the resolveAll section (annotation engine, PLAN.md 1C.4
// under DECISIONS.md F6 and G6): the chunked incremental re-resolve, the index
// cache, invalidate, watch and the settle link install(M) registers.
//
// The mechanics are proved with a fake clock and a fake scheduler: `now()`
// reads a counter that advances 1.5 ms per resolved record (a getter on the
// record's `form`, which resolve() reads exactly once per record), and
// `schedule(fn)` only records the frame, which the test then runs one at a
// time. The real timings (GT-05's cold and incremental clauses, obligation 9)
// are the 1C gate's, in Chrome against the built factory; nothing here asserts
// a speed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { PUBLIC_DIR } = require('../lib/core/paths');
const anchors = require('../lib/core/anchors');
const { ANCHOR_STATES } = require('../lib/core/anchor-states');

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'anchors', 'element-cases.json'), 'utf8'));
const RUNTIME = fs.readFileSync(path.join(PUBLIC_DIR, 'mount-runtime.js'), 'utf8');
const COST = 1.5;
const BUDGET = 10;

const WINDOWS = [];
function newWindow(opts = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', ...opts });
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
// A fresh factory per test: the index cache, the watchers and the settle
// listener are factory state.
const fresh = () => anchors.createAnchors(ANCHOR_STATES);

// test/anchors.test.js's timing pane: 6 sections of 12 rows of 3 sub-rows.
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
// n records of the big pane (wire copies), recorded in an unchanged copy.
function recordsOf(html, n, win = W) {
  const from = mount(html, win);
  const ix = anchors.index(from);
  const out = [];
  for (const e of ix.els) {
    const r = anchors.record(from, e.node, { ix });
    if (r) out.push(wire(r));
    if (out.length === n) break;
  }
  assert.equal(out.length, n, `the pane yields ${n} records`);
  return out;
}

// The fake clock and scheduler.
function harness() {
  const h = {
    t: 0,
    frames: [],
    scheduled: 0,
    maxPending: 0,
    log: [],
    now: () => h.t,
    schedule: (fn) => {
      h.scheduled++;
      h.frames.push(fn);
      h.maxPending = Math.max(h.maxPending, h.frames.length);
    },
    resolved: 0,
    // Runs the next frame, logging its work (clock delta) and its records.
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
    // A record whose resolve costs COST ms on the fake clock.
    costly(rec) {
      const r = { ...rec };
      const form = rec.form;
      Object.defineProperty(r, 'form', { get() { h.t += COST; h.resolved++; return form; }, enumerable: false });
      return r;
    },
  };
  return h;
}

// ── budget ─────────────────────────────────────────────────────────────────

test('budget: 481 records, every chunk within budget + one record, the index alone in the first chunk', () => {
  const A = fresh();
  const h = harness();
  const html = bigPane();
  const recs = recordsOf(html, 481).map(h.costly);
  const root = mount(html);
  let done = null;
  let calls = 0;
  A.resolveAll(root, recs, { budget_ms: BUDGET, schedule: h.schedule, now: h.now }, (answers, report) => { calls++; done = { answers, report }; });
  assert.equal(h.scheduled, 1, 'resolveAll schedules its first chunk');
  assert.equal(h.resolved, 0, 'and does no work synchronously');
  h.drain();
  assert.equal(calls, 1, 'onDone once');
  assert.equal(h.log[0].records, 0, 'the first chunk builds the index and resolves nothing');
  for (const f of h.log) assert.ok(f.ms <= BUDGET + COST, `a frame's work ${f.ms} ms is within the budget plus one record`);
  for (const f of h.log.slice(1)) assert.ok(f.records >= 1, 'every later frame resolves');
  assert.equal(h.resolved, 481, 'each record resolved once');
  assert.equal(h.maxPending, 1, 'one frame pending at a time');
  const { report } = done;
  assert.deepEqual(Object.keys(report), ['records', 'chunks', 'longest_ms', 'work_ms', 'index_ms', 'wall_ms', 'gen', 'restarts', 'ranges', 'range_ms']);
  assert.equal(report.records, 481);
  assert.equal(done.answers.length, 481);
  assert.ok(report.chunks >= 2);
  assert.equal(report.chunks, h.log.length, 'one chunk per frame');
  assert.ok(report.longest_ms <= BUDGET + COST);
  assert.equal(report.work_ms, 481 * COST, 'work_ms is the resolve work');
  assert.equal(report.index_ms, 0, 'the index build is timed apart (it costs nothing on this clock)');
  assert.equal(report.wall_ms, 481 * COST);
  assert.equal(report.gen, null, 'no runtime installed: no generation');
  assert.equal(report.restarts, 0);
  // 7 records reach 10.5 >= 10: ceil(481 / 7) resolve chunks after the index chunk.
  assert.equal(report.chunks, 1 + Math.ceil(481 / 7));
});

test('budget: 2,000 records complete with no cap', () => {
  const A = fresh();
  const h = harness();
  const html = bigPane();
  const base = recordsOf(html, 481);
  const recs = Array.from({ length: 2000 }, (_, k) => h.costly(base[k % base.length]));
  const root = mount(html);
  let report = null;
  A.resolveAll(root, recs, { schedule: h.schedule, now: h.now }, (answers, r) => { report = r; assert.equal(answers.length, 2000); });
  h.drain();
  assert.equal(report.records, 2000);
  assert.equal(h.resolved, 2000);
  for (const f of h.log) assert.ok(f.ms <= BUDGET + COST, 'the default budget is 10 ms');
});

// ── equality ───────────────────────────────────────────────────────────────

function equalityOn(root, recs, label) {
  const want = recs.map((r) => anchors.resolve(root, r));
  for (const budget of [BUDGET, 0, Infinity]) {
    const A = fresh();
    const h = harness();
    let got = null;
    A.resolveAll(root, recs.map(h.costly), { budget_ms: budget, schedule: h.schedule, now: h.now }, (answers) => { got = answers; });
    h.drain();
    assert.deepStrictEqual(got, want, `${label}, budget ${budget}: the chunked answers equal resolve's, in record order`);
    if (budget === Infinity && recs.length) assert.equal(h.log.length, 2, `${label}: unchunked is the index chunk and one resolve chunk`);
  }
}

test('equality: the element fixtures, chunked and unchunked, equal resolve() record by record', () => {
  let n = 0;
  for (const c of FIX.cases) {
    const from = mount(c.from);
    const to = mount(c.to);
    const ix = anchors.index(from);
    const recs = ix.els.map((e) => anchors.record(from, e.node, { ix })).filter(Boolean).map(wire);
    n += recs.length;
    equalityOn(to, recs, c.name);
  }
  for (const c of FIX.locator) equalityOn(mount(c.html), [c.rec, c.rec], `locator ${c.name}`);
  assert.ok(n > 100, `the fixtures gave ${n} records`);
});

test('equality: a synthetic 300-record pane with a removed row', () => {
  const html = bigPane();
  const recs = recordsOf(html, 300);
  const to = mount(html);
  to.querySelector('ul.rows > li').remove();
  const states = new Set(recs.map((r) => anchors.resolve(to, r).state));
  assert.ok(states.size >= 2, `the change gives more than one state (${[...states]})`);
  equalityOn(to, recs, 'synthetic 300');
});

test('resolveAll: no records answers [] without an index; cancel() delivers nothing; bad arguments throw', () => {
  const A = fresh();
  const h = harness();
  const root = mount('<p>x</p>');
  let got = null;
  A.resolveAll(root, [], { schedule: h.schedule, now: h.now }, (answers, report) => { got = { answers, report }; });
  h.drain();
  assert.deepEqual(got.answers, []);
  assert.equal(got.report.chunks, 0);
  let called = false;
  const job = A.resolveAll(root, recordsOf('<p>x</p><p>y</p>', 2), { schedule: h.schedule, now: h.now }, () => { called = true; });
  job.cancel();
  h.drain();
  assert.equal(called, false);
  assert.throws(() => A.resolveAll(null, [], {}, () => {}), /needs a root/);
  assert.throws(() => A.resolveAll(root, [], {}), /needs an onDone/);
});

// ── invalidate ─────────────────────────────────────────────────────────────

test('invalidate: between chunks 2 and 3, with the DOM changed, restarts the pass and delivers no stale answer', () => {
  const A = fresh();
  const h = harness();
  const html = bigPane();
  const recs = recordsOf(html, 481);
  const root = mount(html);
  let calls = 0;
  let got = null;
  A.resolveAll(root, recs.map(h.costly), { schedule: h.schedule, now: h.now }, (answers, report) => { calls++; got = { answers, report }; });
  h.step();
  h.step();
  assert.ok(h.resolved > 0, 'chunk 2 resolved records on the old DOM');
  root.querySelector('ul.rows > li').remove();
  root.querySelector('section.sec h3').textContent = 'Renamed';
  A.invalidate(root);
  h.drain();
  assert.equal(calls, 1, 'onDone once');
  assert.equal(got.report.restarts, 1);
  assert.equal(got.answers.length, 481);
  const want = recs.map((r) => anchors.resolve(root, r));
  assert.deepStrictEqual(got.answers, want, 'every answer is a fresh resolve on the changed DOM');
  assert.equal(h.log[2].records, 0, 'the restart builds the fresh index in a chunk of its own');
});

test('the index cache: a second pass on the same root reuses the index until invalidate', () => {
  const A = fresh();
  const h = harness();
  const root = mount(bigPane());
  const recs = recordsOf(bigPane(), 20);
  const run = () => {
    let rep = null;
    A.resolveAll(root, recs, { schedule: h.schedule, now: h.now }, (a, r) => { rep = r; });
    const before = h.log.length;
    h.drain();
    return { rep, frames: h.log.length - before };
  };
  assert.equal(run().frames, 2, 'cold: the index chunk, then the work');
  assert.equal(run().frames, 1, 'warm: the cached index, no index chunk');
  A.invalidate(root);
  assert.equal(run().frames, 2, 'invalidated: the index chunk again');
  assert.doesNotThrow(() => A.invalidate(null));
});

// ── the settle link (install, watch) ───────────────────────────────────────

// A runtime M and a factory installed on it with the fake clock and scheduler.
function installed(t, M = null) {
  const win = M ? W : newWindow();
  const runtime = M || win.__wcMount;
  const A = fresh();
  const h = harness();
  A.install(runtime, { budget_ms: BUDGET, schedule: h.schedule, now: h.now });
  t.after(() => A.install({}));
  return { A, h, M: runtime, win };
}

test('coalescing: with the runtime module installed, two settles before the frame give one pass and onAnswers once', (t) => {
  const M = require('../public/mount-runtime.js');
  const { A, h } = installed(t, M);
  assert.strictEqual(M.anchor, A);
  const html = bigPane();
  const recs = recordsOf(html, 100);
  const root = mount(html, W, 'p1');
  const seen = [];
  let reads = 0;
  const unwatch = A.watch('p1', { records: () => { reads++; return recs.map(h.costly); }, onAnswers: (answers, report) => seen.push({ answers, report }) });
  t.after(unwatch);
  M.settle(root, 'p1', 'mount');
  M.settle(root, 'p1', 'form');
  assert.equal(h.scheduled, 1, 'one frame asked for');
  assert.equal(h.resolved, 0, 'the listener only queues');
  assert.equal(reads, 0, 'not even the records are read inside settle');
  h.drain();
  assert.equal(seen.length, 1, 'onAnswers once');
  assert.equal(reads, 1, 'one pass');
  assert.equal(h.resolved, 100);
  assert.deepStrictEqual(seen[0].answers, recs.map((r) => anchors.resolve(root, r)));
  assert.equal(seen[0].report.gen, M.generation(root));
  assert.equal(seen[0].report.gen, 2);
  assert.equal(seen[0].report.restarts, 0);
  assert.equal(h.maxPending, 1);
});

test('coalescing: settles on two watched panes in one frame share one frame loop within the budget', (t) => {
  const { A, h, M, win } = installed(t);
  const html = bigPane();
  const r1 = mount(html, win, 'p1');
  const r2 = mount(html, win, 'p2');
  const recs = recordsOf(html, 40);
  const got = {};
  t.after(A.watch('p1', { records: () => recs.map(h.costly), onAnswers: (a, rep) => { got.p1 = (got.p1 || 0) + 1; got.r1 = rep; } }));
  t.after(A.watch('p2', { records: () => recs.map(h.costly), onAnswers: (a, rep) => { got.p2 = (got.p2 || 0) + 1; got.r2 = rep; } }));
  M.settle(r1, 'p1', 'mount');
  M.settle(r2, 'p2', 'mount');
  assert.equal(h.scheduled, 1, 'one frame for both panes');
  h.drain();
  assert.equal(got.p1, 1);
  assert.equal(got.p2, 1);
  assert.equal(h.resolved, 80);
  assert.equal(h.log[0].records, 0, 'the first frame builds indexes only');
  for (const f of h.log) assert.ok(f.ms <= BUDGET + COST, `per-frame work ${f.ms} ms within the budget plus one record`);
  // 80 records at 7 a frame: 12 work frames, not 6 + 6 rounded up per pane.
  assert.equal(h.log.length, 1 + Math.ceil(80 / 7), 'the panes share their boundary frame');
  assert.ok(h.log.some((f) => f.records === 7) && got.r1.chunks + got.r2.chunks > h.log.length, 'one frame served both');
  assert.equal(h.maxPending, 1, 'never more than one frame pending');
});

test('zero cost: settles on unwatched roots never schedule; a watched root detached before its frame is dropped unindexed', (t) => {
  const { A, h, M, win } = installed(t);
  const root = mount('<p>a</p><p>b</p>', win, 'p1');
  const other = mount('<p>c</p>', win, 'p2');
  M.settle(root, 'p1', 'mount');
  M.settle(other, 'p2', 'mount');
  M.settle(root, null, 'mount');
  assert.equal(h.scheduled, 0, 'nothing watched: no frame');
  let reads = 0;
  let answered = 0;
  t.after(A.watch('p1', { records: () => { reads++; return recordsOf('<p>a</p><p>b</p>', 2, win); }, onAnswers: () => { answered++; } }));
  M.settle(other, 'p2', 'mount');
  assert.equal(h.scheduled, 0, 'a settle on an unwatched mount id: no frame');
  let walks = 0;
  const desc = Object.getOwnPropertyDescriptor(win.Node.prototype, 'childNodes');
  Object.defineProperty(root, 'childNodes', { get() { walks++; return desc.get.call(this); }, configurable: true });
  M.settle(root, 'p1', 'mount');
  assert.equal(h.scheduled, 1);
  root.host.remove();
  h.drain();
  assert.equal(walks, 0, 'no index built');
  assert.equal(reads, 0, 'no records read');
  assert.equal(answered, 0);
  assert.equal(h.frames.length, 0, 'and no further frame');
});

test('generation: a settle between two chunks restarts the pass on a fresh index, as invalidate does', (t) => {
  const { A, h, M, win } = installed(t);
  const html = bigPane();
  const recs = recordsOf(html, 120, win);
  const root = mount(html, win, 'p1');
  const seen = [];
  t.after(A.watch('p1', { records: () => recs.map(h.costly), onAnswers: (answers, report) => seen.push({ answers, report }) }));
  M.settle(root, 'p1', 'mount');
  h.step();
  h.step();
  assert.ok(h.resolved > 0 && h.resolved < 120, 'mid-pass');
  root.querySelector('ul.rows > li').remove();
  M.settle(root, 'p1', 'form');
  assert.equal(h.frames.length, 1, 'the pass in flight is not queued twice');
  h.drain();
  assert.equal(seen.length, 1, 'onAnswers once');
  assert.equal(seen[0].report.restarts, 1);
  assert.equal(seen[0].report.gen, 2);
  assert.deepStrictEqual(seen[0].answers, recs.map((r) => anchors.resolve(root, r)), 'no answer from the old index');
});

test('watch: unwatch mid-pass delivers nothing; a second install moves the listener; bad arguments throw', (t) => {
  const { A, h, M, win } = installed(t);
  const html = bigPane();
  const root = mount(html, win, 'p1');
  const recs = recordsOf(html, 60, win);
  let answered = 0;
  const unwatch = A.watch('p1', { records: () => recs.map(h.costly), onAnswers: () => { answered++; } });
  M.settle(root, 'p1', 'mount');
  h.step();
  h.step();
  unwatch();
  h.drain();
  assert.equal(answered, 0);
  const M2 = newWindow().__wcMount;
  A.install(M2, { schedule: h.schedule, now: h.now });
  t.after(A.watch('p1', { records: () => [], onAnswers: () => { answered++; } }));
  const before = h.scheduled;
  M.settle(root, 'p1', 'mount');
  assert.equal(h.scheduled, before, 'the old runtime no longer reaches this factory');
  assert.throws(() => A.watch('', { records() {}, onAnswers() {} }), /mount id/);
  assert.throws(() => A.watch('p1', { records() {} }), /onAnswers/);
});

test('a throwing onAnswers is rethrown from the frame after the loop is left consistent', (t) => {
  const { A, h, M, win } = installed(t);
  const r1 = mount('<p>a</p>', win, 'p1');
  const r2 = mount('<p>b</p>', win, 'p2');
  let p2 = 0;
  t.after(A.watch('p1', { records: () => recordsOf('<p>a</p>', 1, win), onAnswers: () => { throw new Error('boom'); } }));
  t.after(A.watch('p2', { records: () => recordsOf('<p>b</p>', 1, win), onAnswers: () => { p2++; } }));
  M.settle(r1, 'p1', 'mount');
  M.settle(r2, 'p2', 'mount');
  h.step();
  assert.throws(() => h.step(), /boom/);
  h.drain();
  assert.equal(p2, 1, 'the other pane is still served');
});

// ── the default scheduler ──────────────────────────────────────────────────

function spyTimers(win) {
  const calls = { timeout: [], raf: 0 };
  win.setTimeout = (fn, ms) => { calls.timeout.push(ms); };
  if (win.requestAnimationFrame) win.requestAnimationFrame = () => { calls.raf++; };
  return calls;
}

test('default scheduler: setTimeout(16) with no requestAnimationFrame, rAF when visible, setTimeout(16) when hidden', () => {
  const plainWin = newWindow();
  assert.equal(typeof plainWin.requestAnimationFrame, 'undefined', 'jsdom without pretendToBeVisual has no rAF');
  const root = mount('<p>x</p>', plainWin);
  const c1 = spyTimers(plainWin);
  fresh().resolveAll(root, [], {}, () => {});
  assert.deepEqual(c1.timeout, [16]);

  const vis = newWindow({ pretendToBeVisual: true });
  assert.equal(typeof vis.requestAnimationFrame, 'function');
  assert.equal(vis.document.hidden, false);
  const vroot = mount('<p>x</p>', vis);
  const c2 = spyTimers(vis);
  fresh().resolveAll(vroot, [], {}, () => {});
  assert.equal(c2.raf, 1);
  assert.deepEqual(c2.timeout, []);
  Object.defineProperty(vis.document, 'hidden', { value: true, configurable: true });
  fresh().resolveAll(vroot, [], {}, () => {});
  assert.equal(c2.raf, 1, 'hidden: no rAF');
  assert.deepEqual(c2.timeout, [16]);
});

test('default scheduler and clock: a real pass completes on the setTimeout path and equals resolve()', async () => {
  const html = bigPane();
  const recs = recordsOf(html, 481);
  const root = mount(html);
  const { answers, report } = await new Promise((done) => {
    fresh().resolveAll(root, recs, undefined, (a, r) => done({ answers: a, report: r }));
  });
  assert.deepStrictEqual(answers, recs.map((r) => anchors.resolve(root, r)));
  assert.equal(report.records, 481);
  assert.ok(report.chunks >= 2, 'the index chunk and at least one resolve chunk');
  assert.ok(report.wall_ms >= report.work_ms + report.index_ms - 1e-6);
});

test('the browser copies carry the chunker: documentSource installs it on the runtime and a settle reaches a watcher', async () => {
  const win = newWindow({ pretendToBeVisual: true });
  win.eval(anchors.documentSource());
  const A = win.__wcMount.anchor;
  const root = mount('<ul><li>a</li><li>b</li></ul>', win, 'p1');
  const recs = [A.record(root, root.querySelector('li'))];
  const got = await new Promise((done) => {
    A.watch('p1', { records: () => recs, onAnswers: (answers) => done(answers) });
    win.__wcMount.settle(root, 'p1', 'mount');
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].state, 'exact');
  assert.strictEqual(got[0].el, root.querySelector('li'));
});

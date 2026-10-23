// The page well's element overlay draws only what the page shows (annotation
// engine 2A.1; readiness R2 §2–3, S-1; feeds GT-07 and GT-05's C-05-3).
//
// The real chrome (test-support/chrome-shell, booted once) with the overlay's
// box reads stubbed (initOverlay({rectOf})): jsdom does no layout, so the test
// owns the geometry — an S-1-shaped page: a scrolling well (.well-wrap) holding
// #main, a pane whose rows-capped scroll box (its .mount-host) clips its rows,
// a queue rail to the right of the well and a minbar under it, an anchor on
// every 10th row. The overlay's frames run on a fake scheduler and clock the
// test flushes, so each draw is observed at a known geometry; the resolver's own
// passes run on the shell's frames, as in the chrome.
//
// Pinned here:
//   - stepped through the well's and the pane's scroll ranges in 40 px steps,
//     0 anchor points drawn outside the truth box (pane box ∩ capped scroll box
//     ∩ well box ∩ viewport, computed here, independently) and 0 glyph boxes —
//     the marker's transform offset included — painting outside it, over the
//     rail or over the minbar; every anchor inside it IS drawn;
//   - at the capped scroll box's right side (the S-1 walk is vertical): a point
//     just inside is drawn with its glyph's right part inset away, a point
//     just past it is not drawn;
//   - a source record whose quote and bracket are gone answers re-resolved how
//     'section' and is drawn as a section guess, never with the hit class;
//   - a source hit on a markdown item whose block re-renders with the quote
//     kept is drawn over the NEW Range (connected, reading the quote), never
//     the old one its replaced text node collapsed;
//   - a converted pin whose text no longer matches under its selector is drawn
//     at its guess with the guess class, and a click on it emits
//     'overlay:guess'; a locator-none orphan is not drawn and orphans() lists it;
//     the guess's mark paints inside its border box (no outline, no shadow);
//   - an element of a type nobody registered draws the generic marker naming the
//     type; a type's draw that throws leaves the layer and the other markers;
//   - with 600 anchors no draw frame's box work exceeds the budget, the draw is
//     spread over several frames, and stats() reports them;
//   - one slow read (over the budget) throttles only its own frame: the next
//     redraw of the 600 anchors takes as many frames as an unperturbed one
//     (fewer than 10), none over the budget — the look-ahead is the frame's
//     own cost, never a lifetime max; and each frame reads every box of its
//     slice before any type's move (the write phase) runs.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { convertAnchor } = require('../lib/core/element-log');
const fs = require('node:fs');
const path = require('node:path');
const { createCascade } = require('../test-support/css-cascade');

let shell, W, M, ov, anchors, md;

// ── the fake scheduler and clock the overlay draws on ──────────────────────
const queue = [];
let clock = 0;
const READ_MS = 0.05;          // what one box read costs on the fake clock
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(clock); n++; }
  assert.ok(n < max, 'the overlay settles to no pending frame');
  return n;
}

// ── the geometry (S-1) ──────────────────────────────────────────────────────
const VIEW = { left: 0, top: 0, right: 1280, bottom: 800 };
const WELL = { left: 0, top: 48, width: 1000, height: 640 };      // .well-wrap, the scroller
const RAIL = { left: 1000, top: 48, width: 280, height: 640 };
const MINBAR = { left: 0, top: 688, width: 1000, height: 40 };
const MAIN_H = 3000;
const HOST = { x: 60, y: 400, width: 600, height: 360 };          // the rows-capped pane, in #main
const ROWS = 100;
const ROW_H = 30;
const geo = { well: 0, pane: 0 };
const rectFns = new Map();
let rangeRect = null;          // a test's geometry for a Range nobody registered
const DEFAULT_BOX = { left: 300, top: 300, width: 40, height: 16 };
function rect(r) { return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }; }
let slowNext = 0;               // a test's one slow read (ms), then back to READ_MS
const readLog = [];             // when set by a test: 'read' per box read
let logging = false;
function rectOf(x) {
  clock += READ_MS;
  if (slowNext) { clock += slowNext; slowNext = 0; }
  if (logging) readLog.push('read');
  const f = rectFns.get(x);
  if (!f && rangeRect && x && typeof x.cloneContents === 'function') return rect(rangeRect(x));
  return rect(f ? f() : DEFAULT_BOX);
}
const mainBox = () => ({ left: 40, top: WELL.top - geo.well, width: 920, height: MAIN_H });
const hostBox = () => ({ left: mainBox().left + HOST.x, top: mainBox().top + HOST.y, width: HOST.width, height: HOST.height });
const rowBox = (i) => ({ left: hostBox().left + 12, top: hostBox().top + 10 + i * ROW_H - geo.pane, width: 400, height: 24 });
const box = (r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height });
const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

const CLIP_PANE = {
  id: 'clip-pane', target: 'main', params: {},
  html: `<div class="list">${Array.from({ length: ROWS }, (_, i) => `<div class="row">row number ${i}</div>`).join('')}</div>`,
};
const GUESS_PANE = {
  id: 'guess-pane', target: 'main', params: {},
  html: '<p class="note">first note</p><p class="note">second note</p>',
};
const MANY = 600;
const MANY_PANE = {
  id: 'many-pane', target: 'main', params: {},
  html: Array.from({ length: MANY }, (_, i) => `<span class="cell">cell ${i}</span>`).join(''),
};

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const layer = () => W.document.getElementById('el-layer');
const markersFor = (id) => [...layer().querySelectorAll('.el-marker')]
  .filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const shown = (m) => m.style.display !== 'none';

before(async () => {
  shell = await bootShell({});
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  anchors = (await shell.importApp('anchors.js')).default;
  md = await shell.importApp('markdown.js');
  await shell.frame(helloFrame({ mounts: [CLIP_PANE, GUESS_PANE, MANY_PANE] }));
  // The S-1 page's clipping boxes: the well scrolls, the pane's host is capped.
  const wrap = W.document.querySelector('.well-wrap');
  wrap.style.overflow = 'auto';
  rectFns.set(wrap, () => WELL);
  rectFns.set(W.document.getElementById('main'), mainBox);
  const host = M.itemEl(W.document, 'clip-pane').el;
  host.style.overflow = 'auto';
  rectFns.set(host, hostBox);
  rootOf('clip-pane').querySelectorAll('.row').forEach((el, i) => rectFns.set(el, () => rowBox(i)));
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock });
  await shell.tick();
  flush();
});

after(async () => { if (shell) await shell.restore(); });

// Hand the drawn set to the overlay and wait for the resolver's answers.
async function draw(rows, wantAnswers) {
  ov.setElements('live', rows);
  // A source row resolves on the overlay's own (fake) frames: flushed while waiting.
  await waitUntil(() => { flush(); return ov.stats().anchors >= wantAnswers; }, { timeout: 5000, what: `${wantAnswers} answers` });
  flush();
}

test('S-1: through both scroll ranges in 40 px steps, nothing drawn or painted outside the clip, the glyph included', async () => {
  const root = rootOf('clip-pane');
  const rowEls = [...root.querySelectorAll('.row')];
  const rows = [];
  for (let i = 0; i < ROWS; i += 10) {
    rows.push({ id: `c${i}`, v: 1, type: 'comment', anchor: anchors.record(root, rowEls[i], { mount: 'clip-pane' }), shared: true, replies: 0 });
  }
  await draw(rows, rows.length);
  const answered = ov.orphans().length;
  assert.equal(answered, 0, 'every row anchor resolves');

  const wellRange = MAIN_H - WELL.height;
  const paneRange = 10 + ROWS * ROW_H - HOST.height;
  let steps = 0;
  let drawnTotal = 0;
  let outOfClip = 0;
  let paintedOutside = 0;
  let overChrome = 0;
  let missed = 0;
  for (geo.well = 0; geo.well <= wellRange; geo.well += 40) {
    for (geo.pane = 0; geo.pane <= paneRange; geo.pane += 40) {
      ov.requestDraw();
      flush();
      steps++;
      const truth = meet(meet(meet(VIEW, box(WELL)), box(mainBox())), box(hostBox()));
      for (let i = 0; i < ROWS; i += 10) {
        const p = rowBox(i);
        const inside = p.left >= truth.left && p.left < truth.right && p.top >= truth.top && p.top < truth.bottom;
        const [m] = markersFor(`c${i}`);
        assert.ok(m, `c${i} has a marker`);
        if (!shown(m)) { if (inside) missed++; continue; }
        drawnTotal++;
        const x = parseFloat(m.style.left);
        const y = parseFloat(m.style.top);
        if (!(x >= truth.left && x < truth.right && y >= truth.top && y < truth.bottom)) outOfClip++;
        // The painted glyph: its box (the anchor point plus the transform
        // offset, its size) less the clip-path's insets.
        const t = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(m.style.transform);
        assert.ok(t, 'the marker carries its glyph offset inline');
        const ins = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px\)/.exec(m.style.clipPath || '') || [0, 0, 0, 0, 0];
        const [it, ir, ib, il] = ins.slice(1).map(Number);
        const gx = x + Number(t[1]);
        const gy = y + Number(t[2]);
        const painted = { left: gx + il, top: gy + it, right: gx + parseFloat(m.style.width) - ir, bottom: gy + parseFloat(m.style.height) - ib };
        const eps = 1e-9;
        if (painted.left < truth.left - eps || painted.top < truth.top - eps
          || painted.right > truth.right + eps || painted.bottom > truth.bottom + eps) paintedOutside++;
        for (const c of [RAIL, MINBAR]) {
          const cb = box(c);
          if (painted.left < cb.right && painted.right > cb.left && painted.top < cb.bottom && painted.bottom > cb.top) overChrome++;
        }
      }
    }
  }
  assert.ok(steps > 1000, `stepped ${steps} scroll positions`);
  assert.ok(drawnTotal > 100, `markers were drawn (${drawnTotal}), so the zeros below mean something`);
  assert.equal(outOfClip, 0, 'anchor points drawn out of clip');
  assert.equal(paintedOutside, 0, 'glyph boxes painting outside the clip');
  assert.equal(overChrome, 0, 'glyphs painting over the rail or the minbar');
  assert.equal(missed, 0, 'every anchor inside the clip is drawn');
  assert.ok(ov.stats().clipped > 0 || drawnTotal < steps * ROWS / 10, 'some anchors were clipped along the way');
  geo.well = 0;
  geo.pane = 0;
});

test('S-1, the right edge: a glyph straddling the pane\'s right side is clipped there, never painting toward the rail', async () => {
  // The S-1 walk scrolls vertically, so its anchors never reach a clip's right
  // side; these two rows sit at it: one point just inside the capped scroll
  // box's right edge (drawn, its glyph's right part inset away), one just past
  // it (not drawn).
  const root = rootOf('clip-pane');
  const rowEls = [...root.querySelectorAll('.row')];
  const [inEl, outEl] = [rowEls[5], rowEls[6]];
  const savedIn = rectFns.get(inEl);
  const savedOut = rectFns.get(outEl);
  const right = () => hostBox().left + hostBox().width;
  rectFns.set(inEl, () => ({ left: right() - 5, top: hostBox().top + 100, width: 4, height: 24 }));
  rectFns.set(outEl, () => ({ left: right() + 2, top: hostBox().top + 140, width: 4, height: 24 }));
  try {
    await draw([
      { id: 'edge-in', v: 1, type: 'comment', anchor: anchors.record(root, inEl, { mount: 'clip-pane' }), shared: true, replies: 0 },
      { id: 'edge-out', v: 1, type: 'comment', anchor: anchors.record(root, outEl, { mount: 'clip-pane' }), shared: true, replies: 0 },
    ], 2);
    ov.requestDraw();
    flush();
    const [mIn] = markersFor('edge-in');
    const [mOut] = markersFor('edge-out');
    assert.ok(mIn && shown(mIn), 'the point inside the right edge is drawn');
    assert.ok(mOut && !shown(mOut), 'the point past the right edge is not drawn');
    const t = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(mIn.style.transform);
    const ins = /inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px\)/.exec(mIn.style.clipPath || '');
    assert.ok(t && ins, 'the marker carries its glyph offset and a clip-path inline');
    const gx = parseFloat(mIn.style.left) + Number(t[1]);
    const paintedRight = gx + parseFloat(mIn.style.width) - Number(ins[2]);
    assert.ok(Number(ins[2]) > 0, 'the glyph\'s right part is inset away');
    assert.ok(paintedRight <= right() + 1e-9, `the glyph paints to ${paintedRight}, the clip ends at ${right()}`);
  } finally {
    if (savedIn) rectFns.set(inEl, savedIn); else rectFns.delete(inEl);
    if (savedOut) rectFns.set(outEl, savedOut); else rectFns.delete(outEl);
    ov.setElements('live', []);
    flush();
  }
});

test('a source record whose quote and bracket are gone is drawn as a section guess, never as a hit', async () => {
  const before0 = '## Plan\n\nAlpha beta gamma delta epsilon zeta.\n\n## Other\n\nUnrelated words.\n';
  await shell.frame({ type: 'markdown', id: 'md-plan', text: before0, owner: 'claude' });
  const block = M.itemEl(W.document, 'md-plan').el;
  const p = block.querySelector('p');
  const tn = p.firstChild;
  const at = tn.data.indexOf('gamma delta');
  const range = W.document.createRange();
  range.setStart(tn, at);
  range.setEnd(tn, at + 'gamma delta'.length);
  const rec = anchors.recordSource(block, range, md.sourceMap(before0), before0);
  assert.ok(rec && rec.kind === 'source' && rec.slug === 'plan', 'a source record in the Plan section');
  await draw([{ id: 's1', v: 1, type: 'highlight', anchor: rec, shared: true, replies: 0 }], 1);
  let [m] = markersFor('s1');
  assert.ok(m && shown(m), 'drawn while its quote is there');
  assert.ok(m.classList.contains('el-hit') && !m.classList.contains('el-section'));

  const after0 = '## Plan\n\nEverything here was rewritten from scratch.\n\n## Other\n\nUnrelated words.\n';
  const answers = [];
  const off = ov.onAnswers((msg) => { if (msg.mount === 'md-plan') answers.push(...msg.items); });
  try {
    await shell.frame({ type: 'markdown', id: 'md-plan', text: after0, owner: 'claude' });
    flush();
  } finally { off(); }
  assert.equal(answers.length, 1);
  assert.equal(answers[0].state, 're-resolved');
  assert.equal(answers[0].how, 'section');
  [m] = markersFor('s1');
  assert.ok(m && shown(m), 'the section guess is drawn');
  assert.ok(m.classList.contains('el-section'), 'with the section-guess class');
  assert.ok(!m.classList.contains('el-hit'), 'never the hit class');
  assert.equal(ov.stats().sections, 1);
  await shell.frame({ type: 'markdown:remove', id: 'md-plan' });
  ov.setElements('live', []);
  flush();
});

test('a source hit whose block re-renders with the quote kept is drawn over the new Range, not the old one', async () => {
  const QUOTE = 'gamma delta';
  // A Range's box from its own position, as a browser's would be: a collapsed
  // (or detached) one has none.
  rangeRect = (r) => (r.collapsed || !r.startContainer.isConnected
    ? { left: 0, top: 0, width: 0, height: 0 }
    : { left: 100 + r.startOffset * 5, top: 120, width: 40, height: 16 });
  try {
    const before0 = '## Plan\n\nAlpha beta gamma delta epsilon zeta.\n';
    await shell.frame({ type: 'markdown', id: 'md-p', text: before0, owner: 'claude' });
    const block = M.itemEl(W.document, 'md-p').el;
    const tn = block.querySelector('p').firstChild;
    const at = tn.data.indexOf(QUOTE);
    const range = W.document.createRange();
    range.setStart(tn, at);
    range.setEnd(tn, at + QUOTE.length);
    const rec = anchors.recordSource(block, range, md.sourceMap(before0), before0);
    await draw([{ id: 'h1', v: 1, type: 'highlight', anchor: rec, shared: true, replies: 0 }], 1);
    let [m] = markersFor('h1');
    assert.ok(m && shown(m), 'drawn while its quote is there');
    const r1 = m._group.range;
    assert.equal(r1.toString(), QUOTE);

    const after0 = '## Plan\n\nPrefix words. Alpha beta gamma delta epsilon zeta.\n';
    const answers = [];
    const off = ov.onAnswers((msg) => { if (msg.mount === 'md-p') answers.push(...msg.items); });
    try {
      await shell.frame({ type: 'markdown', id: 'md-p', text: after0, owner: 'claude' });
      flush();
    } finally { off(); }
    assert.equal(answers.length, 1);
    assert.equal(answers[0].state, 'exact', 'the quote is still there, unique');
    [m] = markersFor('h1');
    assert.ok(m && shown(m), 'still drawn after the re-render');
    const r2 = m._group.range;
    assert.notEqual(r2, r1, 'the group holds the new pass\'s Range');
    assert.ok(r2.startContainer.isConnected, 'a connected Range');
    assert.equal(r2.toString(), QUOTE, 'reading the quote');
    assert.ok(m.classList.contains('el-hit'));
    const want = rangeRect(r2);
    assert.equal(parseFloat(m.style.left), want.left, 'drawn at the new Range\'s rect');
    assert.equal(parseFloat(m.style.top), want.top);
  } finally {
    rangeRect = null;
    await shell.frame({ type: 'markdown:remove', id: 'md-p' });
    ov.setElements('live', []);
    flush();
  }
});

test('a converted pin whose text is gone is drawn at its guess; a click on it emits overlay:guess; a locator-none orphan is only listed', async () => {
  const root = rootOf('guess-pane');
  const notes = root.querySelectorAll('p.note');
  const guessed = convertAnchor({ mount: 'guess-pane', selector: 'p.note', ordinal: 1, text: 'the second note as it was' });
  const none = convertAnchor({ mount: 'guess-pane', selector: 'p.gone', ordinal: 0, text: 'first note' });
  assert.equal(anchors.resolve(root, guessed).how, 'locator-guess', 'the fixture is C-10-shaped');
  const orphanEvents = [];
  const bus = (await shell.importApp('bus.js')).bus;
  const off1 = bus.on('overlay:orphans', (d) => orphanEvents.push(d));
  await draw([
    { id: 'c-guess', v: 3, type: 'comment', anchor: guessed, shared: true, replies: 1 },
    { id: 'c-none', v: 1, type: 'comment', anchor: none, shared: true, replies: 0 },
  ], 2);
  const [g] = markersFor('c-guess');
  assert.ok(g && shown(g), 'the carried guess is drawn');
  assert.ok(g.classList.contains('el-guess') && !g.classList.contains('el-hit'));
  assert.equal(g._group.el, notes[1], 'at the guess (the ordinal\'s candidate)');
  // The clip is computed from the glyph's border box, so the guess's mark is
  // drawn inside it: nothing of it paints past that box, clipped or not.
  const css = createCascade(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8'), { win: () => W });
  for (const prop of ['outline', 'outline-width', 'outline-style', 'outline-offset', 'box-shadow']) {
    const v = css.value(g, prop);
    assert.ok(v == null || /^(none|0(px)?)$/.test(String(v).trim()), `the guess marker's ${prop} paints nothing outside its box (${v})`);
  }
  assert.equal(markersFor('c-none').length, 0, 'a guess-less orphan is never drawn');
  assert.deepEqual(ov.orphans(), [
    { id: 'c-guess', v: 3, type: 'comment', mount: 'guess-pane', scope: 'live', how: 'locator-guess', guess: true },
    { id: 'c-none', v: 1, type: 'comment', mount: 'guess-pane', scope: 'live', how: 'locator-none', guess: false },
  ]);
  assert.ok(orphanEvents.some((d) => d.orphans.length === 2), 'overlay:orphans told of the change');
  const seen = [];
  const off2 = bus.on('overlay:guess', (d) => seen.push(d));
  try { shell.click(g); } finally { off2(); off1(); }
  assert.deepEqual(seen, [{ id: 'c-guess', v: 3, type: 'comment', mount: 'guess-pane', scope: 'live' }]);
  ov.setElements('live', []);
  flush();
});

test('an unregistered type draws the generic marker; a draw that throws leaves the layer and the others drawn', async () => {
  const root = rootOf('guess-pane');
  const notes = root.querySelectorAll('p.note');
  const recA = anchors.record(root, notes[0], { mount: 'guess-pane' });
  const recB = anchors.record(root, notes[1], { mount: 'guess-pane' });
  const offBoom = ov.registerType('boom', { draw() { throw new Error('kaboom'); } });
  const errs = [];
  const ownErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await draw([
      { id: 'u1', v: 1, type: 'mystery-tool', anchor: recA, shared: true, replies: 0 },
      { id: 'b1', v: 1, type: 'boom', anchor: recB, shared: true, replies: 0 },
    ], 2);
  } finally { console.error = ownErr; offBoom(); }
  assert.ok(layer(), 'the layer survives');
  const [u] = markersFor('u1');
  assert.ok(u && shown(u), 'the unregistered type is drawn');
  assert.ok(u.classList.contains('el-generic'));
  assert.equal(u.textContent, 'mystery-tool', 'the generic marker names the type');
  assert.equal(markersFor('b1').length, 0, 'the throwing draw left its element undrawn');
  assert.deepEqual(ov.failedDraws().map((f) => [f.id, f.type, f.error]), [['b1', 'boom', 'kaboom']], 'and recorded');
  assert.ok(errs.some((e) => /the 'boom' draw failed/.test(e)));
  ov.setElements('live', []);
  flush();
});

test('600 anchors: no draw frame\'s box work passes the budget, the rest carried; stats() reports the frames', async () => {
  const root = rootOf('many-pane');
  const cells = [...root.querySelectorAll('.cell')];
  const rows = cells.map((el, i) => ({ id: `m${i}`, v: 1, type: 'comment', anchor: anchors.record(root, el, { mount: 'many-pane' }), shared: true, replies: 0 }));
  const bus = (await shell.importApp('bus.js')).bus;
  // The resolver's pass first (its own frames); then the overlay's draw.
  ov.setElements('live', rows);
  await waitUntil(() => ov.stats().anchors >= MANY, { timeout: 10000, what: `${MANY} answers` });
  const frames = [];
  const off = bus.on('overlay:frame', (d) => frames.push(d));
  const s0 = ov.stats();
  try { flush(); } finally { off(); }
  const s = ov.stats();
  assert.equal(s.anchors, MANY, 'stats().anchors counts past 481');
  assert.equal(s.drawn, MANY);
  assert.ok(frames.length >= 3, `the draw is spread over ${frames.length} frames`);
  for (const f of frames) assert.ok(f.ms <= ov.DEFAULT_BUDGET_MS, `frame ${f.frame}: ${f.ms} ms of box work`);
  assert.ok(frames.slice(0, -1).every((f) => f.carried > 0 && !f.done), 'each frame but the last carries the rest');
  assert.ok(frames[frames.length - 1].done);
  assert.ok(s.frames - s0.frames >= frames.length);
  // longest_frame_ms is the file's whole run (the boot's frames ran on the real
  // clock, before the fake one was injected): it holds this draw's longest.
  const longest = Math.max(...frames.map((f) => f.ms));
  assert.ok(longest <= ov.DEFAULT_BUDGET_MS && s.longest_frame_ms >= longest, `longest frame ${longest} ms`);
  assert.ok(s.box_reads - s0.box_reads >= MANY, 'one read per anchor at least');
  for (const k of ['frames', 'longest_frame_ms', 'box_reads', 'box_ms', 'drawn', 'clipped', 'guesses', 'sections', 'orphans', 'anchors']) {
    assert.equal(typeof s[k], 'number', `stats().${k}`);
  }
  ov.setElements('live', []);
  flush();
});

test('one slow read throttles only its own frame: the next redraw of 600 anchors takes as few frames as before, none over the budget', async () => {
  const root = rootOf('many-pane');
  const cells = [...root.querySelectorAll('.cell')];
  const offType = ov.registerType('mv', { draw() {}, move: () => { if (logging) readLog.push('write'); } });
  const rows = cells.map((el, i) => ({ id: `s${i}`, v: 1, type: 'mv', anchor: anchors.record(root, el, { mount: 'many-pane' }), shared: true, replies: 0 }));
  const bus = (await shell.importApp('bus.js')).bus;
  const framesOf = (fn) => {
    const frames = [];
    const off = bus.on('overlay:frame', (d) => { frames.push(d); if (logging) readLog.push('frame'); });
    try { fn(); flush(); } finally { off(); }
    return frames;
  };
  try {
    ov.setElements('live', rows);
    await waitUntil(() => ov.stats().anchors >= MANY, { timeout: 10000, what: `${MANY} answers` });
    flush();
    assert.equal(ov.stats().drawn, MANY);
    // The unperturbed redraw.
    const base = framesOf(() => ov.requestDraw());
    assert.ok(base.length < 10 && base[base.length - 1].done, `an unperturbed redraw takes ${base.length} frames`);
    // A redraw with one read over the budget: its own frame runs long.
    const slow = framesOf(() => { slowNext = ov.DEFAULT_BUDGET_MS * 1.5; ov.requestDraw(); });
    assert.equal(slowNext, 0, 'the slow read happened');
    assert.ok(slow.some((f) => f.ms > ov.DEFAULT_BUDGET_MS), 'the slow read\'s frame ran over');
    // The next redraw is not throttled by it.
    logging = true;
    readLog.length = 0;
    const after = framesOf(() => ov.requestDraw());
    logging = false;
    assert.ok(after.length < 10, `the redraw after a slow read takes ${after.length} frames`);
    assert.ok(after.length <= base.length + 1, `about as many as unperturbed (${after.length} vs ${base.length})`);
    for (const f of after) assert.ok(f.ms <= ov.DEFAULT_BUDGET_MS, `frame ${f.frame}: ${f.ms} ms`);
    assert.ok(after[after.length - 1].done);
    // Reads before writes, per frame: no read follows a write before the frame ends.
    let wrote = false;
    let interleaved = 0;
    for (const e of readLog) {
      if (e === 'frame') wrote = false;
      else if (e === 'write') wrote = true;
      else if (wrote) interleaved++;
    }
    assert.ok(readLog.includes('write'), 'the type\'s move ran');
    assert.equal(interleaved, 0, 'every box of a frame\'s slice is read before any write');
  } finally { logging = false; offType(); }
  ov.setElements('live', []);
  flush();
});

'use strict';
// A page pin or highlight the daemon serves MASKED, drawn in the real chrome
// (annotation engine tranche 3, U415d; corrective to U415c; RULED 2026-10-29
// X3, Y3 = a: a learned value's fragment inside a pin's own words is masked in
// the read view and the pin reads masked).
//
// The daemon (U415c, lib/server/domain/elements.js withMaskedState) serves a
// page record whose quote.exact holds a mark with state / visible / explain
// 'masked'; the pane's raw DOM holds the value, never the mark, so the page
// resolver cannot find the served words there. Pinned here:
//   - a page range comment served masked is drawn with .el-masked (DRAW_RULES'
//     MASKED row) at what the resolver's own pass found (a range, for words
//     the pane itself shows masked), else at its pane's box (the resolver
//     answers a served mark it cannot find orphaned, no guess), is never
//     listed by orphans(), is delivered to the answer listeners as masked
//     (never the resolver's orphaned: overlay-report.js reports only the
//     resolver's three states), and its marker's title carries
//     the served explain line (anchor-states EXPLAIN.masked);
//   - a highlight served masked the same, with its handle drawn and the pane
//     never painted whole (no rectangle in the geometry fallback);
//   - a pin and a highlight served exact are drawn as before (.el-hit, no
//     .el-masked), and a pin whose served state goes back to exact is redrawn
//     .el-hit;
//   - overlay.servedAnswerOf reads only a served 'masked' state.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { MASK } = require('../lib/core/redact');
const { EXPLAIN, VISIBLE } = require('../lib/core/anchor-states');

const VALUE = 'hunter2-Quokka-91f3c7';
const PANE = (id) => ({
  id, target: 'main', params: {},
  html: `<p class="lead">Use ${VALUE} for access to the staging box</p><p class="more">nothing secret in ${id}</p>`,
});
const MOUNTS = [PANE('p1'), PANE('p2'),
  { id: 'p3', target: 'main', params: {}, html: `<p class="lead">Token ${MASK('secret')} was rotated today</p>` }];

let shell, W, M, ov, anchors;

const rafQueue = [];
const fakeRaf = (fn) => { rafQueue.push(fn); return rafQueue.length; };
function flush(max = 10000) { let n = 0; while (rafQueue.length && n < max) { rafQueue.shift()(0); n++; } return n; }
const VIEW = { left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768, x: 0, y: 0 };
const rectOf = (x) => {
  if (x && x.nodeType === undefined && typeof x.getClientRects === 'function') {
    const rs = x.getClientRects();
    if (rs && rs.length) return rs[0];
    return { left: 200, top: 200, width: 40, height: 16, right: 240, bottom: 216, x: 200, y: 200 };
  }
  return VIEW;
};

// The stub daemon: the live comments and highlights as it serves them.
const live = { comment: new Map(), highlight: new Map() };
function elementsRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const u = new URL(url, 'http://x');
  if (method === 'GET') {
    const t = u.searchParams.get('type');
    if (u.searchParams.get('node')) return { elements: [], next_cursor: 9 };
    return { elements: [...(live[t] || new Map()).values()], next_cursor: 9 };
  }
  return { ok: true };
}
before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': DEFAULT_ROUTES['/api/elements/types'],
      '/api/elements': elementsRoute,
      '/api/elements/*': () => ({ ok: true }),
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  await shell.importApp('comments.js');
  await shell.importApp('highlight.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ov.initOverlay({ rectOf, raf: fakeRaf, clips: () => false });
  ov.onAnswers((msg) => { for (const it of msg.items) delivered.push({ id: it.id, state: it.state }); });
  await shell.frame(helloFrame({ active: 'n1', mounts: MOUNTS }));
  await shell.tick();
  flush();
});
after(async () => { if (shell) await shell.restore(); });

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const lead = (id) => rootOf(id).querySelector('p.lead');
const layer = () => W.document.getElementById('el-layer');
const markersFor = (id) => [...layer().querySelectorAll('.el-marker')].filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
async function settle(ms = 100) { for (let i = 0; i < ms / 20; i++) await shell.tick(20); }
async function drawnUntil(pred, what) {
  await waitUntil(async () => { await settle(40); flush(); return pred(); }, { timeout: 4000, what });
}
const orphanIds = () => ov.orphans().map((o) => o.id);
// Every item the overlay delivered to its answer listeners (overlay-report.js
// reads these; it reports only the resolver's three states).
const delivered = [];
const deliveredOf = (id) => delivered.filter((it) => it.id === id).map((it) => it.state);

// A range anchor over "<VALUE> for access" in `mount`'s lead, as the chrome
// records it; served masked, its exact holds the mark where the value was.
function rangeAnchor(mount) {
  const t = lead(mount).firstChild;
  const at = t.data.indexOf(VALUE);
  const r = W.document.createRange();
  r.setStart(t, at);
  r.setEnd(t, at + VALUE.length + ' for access'.length);
  return anchors.recordRange(rootOf(mount), r, { mount });
}
function maskedServed(rec) {
  const a = JSON.parse(JSON.stringify(rec.anchor));
  a.quote.exact = a.quote.exact.replace(VALUE, MASK('secret'));
  return { ...rec, anchor: a, state: 'masked', visible: VISIBLE.masked, explain: EXPLAIN[VISIBLE.masked] };
}
function comment(id, mount, extra = {}) {
  return { id, v: 1, seq: 1, type: 'comment', schema: 'comment@1', text: `${id} text`, shared: true, replies: [], anchor: rangeAnchor(mount), ...extra };
}
function highlight(id, mount, extra = {}) {
  return { id, v: 1, seq: 1, type: 'highlight', schema: 'highlight@1', anchor: rangeAnchor(mount), shared: true, color: 'gold', note: '', ...extra };
}
async function serve(type, recs) {
  live[type] = new Map(recs.map((r) => [r.id, r]));
  await shell.frame({ type: `element:${type}`, elements: recs });
}

test('servedAnswerOf reads only a served masked state', () => {
  assert.deepEqual(ov.servedAnswerOf({ state: 'masked', visible: 'masked', explain: EXPLAIN.masked }),
    { state: 'masked', visible: 'masked', explain: EXPLAIN.masked });
  assert.equal(ov.servedAnswerOf({ state: 'exact' }), null);
  assert.equal(ov.servedAnswerOf({}), null);
  assert.equal(ov.servedAnswerOf(null), null);
});

test('precondition: the served masked words are not in the pane (the page resolver cannot find them)', () => {
  const served = maskedServed(comment('c0', 'p1'));
  assert.ok(served.anchor.quote.exact.startsWith(MASK('secret')), 'the served exact holds the mark');
  assert.ok(!rootOf('p1').textContent.includes(served.anchor.quote.exact), 'the raw DOM never holds the mark');
});

test('a page range comment served masked is drawn .el-masked, is no orphan, is delivered masked, and its title carries the served explain', async () => {
  const pin = maskedServed(comment('c1', 'p1'));
  await serve('comment', [pin]);
  await drawnUntil(() => markersFor('c1').length === 1 && markersFor('c1')[0].classList.contains('el-masked'), 'the masked comment drawn');
  const m = markersFor('c1')[0];
  assert.ok(m.classList.contains('pin-marker'), 'the comment type drew its pin');
  assert.ok(!m.classList.contains('el-guess') && !m.classList.contains('el-hit'), 'never a guess, never a plain hit');
  assert.ok(!orphanIds().includes('c1'), 'not listed as an orphan');
  assert.ok(m.title.includes(EXPLAIN.masked), 'the explain line is the served one (anchor-states EXPLAIN.masked)');
  // The resolver's own pass finds no place for the served words (it answers
  // orphaned with no guess): the pin is drawn at its pane's box.
  assert.equal(m._group.el, M.itemEl(W.document, 'p1').el, 'at the pane\'s box');
  assert.equal(m._group.range, null);
  const row = ov.elementsOf('live').find((r) => r.id === 'c1');
  assert.deepEqual(row.answer, { state: 'masked', visible: 'masked', explain: EXPLAIN.masked }, 'the row carries the served answer');
  // (The hidden probe's 'mounting' may come first: hidden beats masked.)
  assert.ok(deliveredOf('c1').includes('masked'), 'delivered masked');
  assert.ok(!deliveredOf('c1').includes('orphaned'), 'never the resolver\'s orphaned, so never reported orphaned');

  // The served state goes back to exact (the value is no longer learned):
  // redrawn as a plain hit at its words.
  const clear = comment('c1', 'p1', { v: 2 });
  await serve('comment', [clear]);
  await drawnUntil(() => markersFor('c1').length === 1 && markersFor('c1')[0].classList.contains('el-hit'), 'redrawn as a hit');
  assert.ok(!markersFor('c1')[0].classList.contains('el-masked'));
  await serve('comment', []);
  await drawnUntil(() => markersFor('c1').length === 0, 'the comment gone');
});

test('a comment and a highlight served masked over words the pane itself shows masked are drawn .el-masked at the range the resolver finds', async () => {
  // A pane that shows a mark (a page rendered from redacted text): the pinned
  // words hold it as written, the resolver finds them, the daemon serves the
  // record masked (any mark in the served exact, U415c).
  const t = lead('p3').firstChild;
  const at = t.data.indexOf(MASK('secret'));
  const r = W.document.createRange();
  r.setStart(t, at);
  r.setEnd(t, at + MASK('secret').length + ' was rotated'.length);
  const anchor = anchors.recordRange(rootOf('p3'), r, { mount: 'p3' });
  assert.ok(anchor.quote.exact.startsWith(MASK('secret')), 'precondition: the words hold the mark');
  const stamp = (rec) => ({ ...rec, state: 'masked', visible: VISIBLE.masked, explain: EXPLAIN[VISIBLE.masked] });
  await serve('comment', [stamp({ id: 'c4', v: 1, seq: 1, type: 'comment', schema: 'comment@1', text: 'c4 text', shared: true, replies: [], anchor })]);
  await serve('highlight', [stamp({ id: 'h4', v: 1, seq: 1, type: 'highlight', schema: 'highlight@1', anchor, shared: true, color: 'gold', note: '' })]);
  await drawnUntil(() => markersFor('c4').length === 1 && markersFor('h4').length === 1, 'both drawn');
  for (const id of ['c4', 'h4']) {
    const m = markersFor(id)[0];
    assert.ok(m.classList.contains('el-masked'), `${id} drawn masked`);
    assert.ok(m._group.range && m._group.range.toString() === anchor.quote.exact, `${id} at the range the resolver found`);
    assert.ok(!orphanIds().includes(id), `${id} never an orphan`);
  }
  await serve('comment', []);
  await serve('highlight', []);
  await drawnUntil(() => markersFor('c4').length === 0 && markersFor('h4').length === 0, 'both gone');
});

test('a reset\'s lean rows (no served state) are taken over by the read that serves them masked', async () => {
  const t = lead('p3').firstChild;
  const at = t.data.indexOf(MASK('secret'));
  const r = W.document.createRange();
  r.setStart(t, at);
  r.setEnd(t, at + MASK('secret').length + ' was rotated'.length);
  const anchor = anchors.recordRange(rootOf('p3'), r, { mount: 'p3' });
  const stamp = (rec) => ({ ...rec, state: 'masked', visible: VISIBLE.masked, explain: EXPLAIN[VISIBLE.masked] });
  const c6 = stamp({ id: 'c6', v: 1, seq: 1, type: 'comment', schema: 'comment@1', text: 'c6 text', shared: true, replies: [], anchor });
  const h6 = stamp({ id: 'h6', v: 1, seq: 1, type: 'highlight', schema: 'highlight@1', anchor, shared: true, color: 'gold', note: '' });
  live.comment = new Map([[c6.id, c6]]);
  live.highlight = new Map([[h6.id, h6]]);
  // The reset's lean rows: the same id, v and anchor, and no served state.
  const lean = (rec) => ({ id: rec.id, v: rec.v, type: rec.type, schema: rec.schema, anchor, shared: true, replies: 0, answered: false });
  await shell.frame({ type: 'reset', mounts: MOUNTS, store: {}, active: 'n1', lock: null, elements: [lean(c6), lean(h6)] });
  await drawnUntil(() => ['c6', 'h6'].every((id) => markersFor(id).length === 1 && markersFor(id)[0].classList.contains('el-masked')),
    'both drawn masked once the read serves them');
  await serve('comment', []);
  await serve('highlight', []);
  await drawnUntil(() => markersFor('c6').length === 0 && markersFor('h6').length === 0, 'both gone');
});

test('a highlight served masked is drawn .el-masked, is no orphan, and its pane is never painted whole', async () => {
  // The geometry fallback (jsdom has no CSS.highlights): every Range answers
  // a rectangle, so a painted pane would show one.
  const own = Object.getOwnPropertyDescriptor(W.Range.prototype, 'getClientRects');
  W.Range.prototype.getClientRects = function getClientRects() {
    return [{ left: 300, top: 120, width: 60, height: 16, right: 360, bottom: 136, x: 300, y: 120 }];
  };
  try {
    const h = maskedServed(highlight('h1', 'p1'));
    await serve('highlight', [h]);
    await drawnUntil(() => markersFor('h1').length === 1 && markersFor('h1')[0].classList.contains('el-masked'), 'the masked highlight drawn');
    const m = markersFor('h1')[0];
    assert.ok(m.classList.contains('hl-handle'), 'the highlight type drew its handle');
    assert.ok(!m.classList.contains('hl-none'), 'not the guess stand-in');
    assert.ok(!orphanIds().includes('h1'), 'not listed as an orphan');
    assert.ok(m.title.includes(EXPLAIN.masked), 'the explain line is the served one');
    assert.equal(m._group.el, M.itemEl(W.document, 'p1').el, 'at the pane\'s box');
    ov.requestDraw();
    await settle(100);
    flush();
    assert.equal(m.querySelectorAll('.hl-rect').length, 0, 'the pane is never painted: no rectangle');
    // A highlight whose range the resolver found is still painted.
    const plain = highlight('h2', 'p2');
    await serve('highlight', [h, plain]);
    await drawnUntil(() => markersFor('h2').length === 1 && markersFor('h2')[0].querySelectorAll('.hl-rect').length === 1, 'the plain one painted');
    assert.equal(markersFor('h1')[0].querySelectorAll('.hl-rect').length, 0, 'the masked one still unpainted');
  } finally {
    if (own) Object.defineProperty(W.Range.prototype, 'getClientRects', own);
    else delete W.Range.prototype.getClientRects;
  }
  await serve('highlight', []);
  await drawnUntil(() => markersFor('h1').length === 0, 'the highlight gone');
});

test('a comment and a highlight served exact are drawn as before: .el-hit, never .el-masked', async () => {
  await serve('comment', [comment('c3', 'p1')]);
  await serve('highlight', [highlight('h3', 'p2')]);
  await drawnUntil(() => markersFor('c3').length === 1 && markersFor('h3').length === 1, 'both drawn');
  for (const id of ['c3', 'h3']) {
    const m = markersFor(id)[0];
    assert.ok(m.classList.contains('el-hit'), `${id} drawn as a hit`);
    assert.ok(!m.classList.contains('el-masked'), `${id} not masked`);
    assert.ok(!m.title.includes(EXPLAIN.masked), `${id} carries no masked line`);
    assert.equal(ov.elementsOf('live').find((r) => r.id === id).answer, undefined, `${id}'s row carries no answer`);
  }
  assert.ok(!orphanIds().includes('c3') && !orphanIds().includes('h3'));
  await serve('comment', []);
  await serve('highlight', []);
});

// LAST in the file: the probe set here replaces the shell's own (overlay.js
// hiddenProbe is not exported, so it cannot be put back for a later case).
test('a comment served masked over a hidden pane stays hidden: never drawn, never an orphan, delivered hidden', async () => {
  const pin = maskedServed(comment('c7', 'p2'));
  ov.setHiddenProbe(({ row }) => (row && row.id === 'c7' ? 'test-hidden' : null));
  await serve('comment', [pin]);
  await waitUntil(async () => { await settle(40); flush(); return deliveredOf('c7').includes('hidden'); },
    { timeout: 4000, what: 'c7 delivered hidden' });
  await settle(100);
  flush();
  assert.equal(markersFor('c7').length, 0, 'a hidden pin is never drawn, masked or not');
  assert.ok(!orphanIds().includes('c7'), 'never an orphan');
  assert.ok(!deliveredOf('c7').includes('masked'), 'hidden beats the served masked state');
  await serve('comment', []);
});

// U415e (Z2 = a): the page layer's masked look, the chat layer's rule on
// #el-layer (public/app.css). Reads the stylesheet only (it never draws, so
// the hidden probe the case above left set does not reach it).
test('a page marker drawn .el-masked has the masked look: the dashed border the chat layer\'s masked marker has', () => {
  const fs = require('fs');
  const path = require('path');
  const { createCascade } = require('../test-support/css-cascade');
  const css = createCascade(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8'), { win: () => W });
  const host = W.document.createElement('div');
  host.id = 'el-layer';
  const masked = W.document.createElement('div');
  masked.className = 'el-marker pin-marker el-masked';
  const plain = W.document.createElement('div');
  plain.className = 'el-marker pin-marker el-hit';
  const chat = W.document.createElement('div');
  chat.id = 'el-layer-chat';
  const chatMasked = W.document.createElement('div');
  chatMasked.className = 'el-marker pin-marker el-masked';
  chat.append(chatMasked);
  host.append(masked, plain);
  const box = W.document.createElement('div');
  box.append(host, chat);
  try {
    assert.equal(css.value(masked, 'border'), '1.5px dashed currentColor', 'a masked page marker is dashed');
    assert.equal(css.value(masked, 'border'), css.value(chatMasked, 'border'), 'the chat layer\'s masked look');
    assert.equal(css.value(masked, 'border-radius'), 'var(--wc-radius-sm)');
    assert.notEqual(css.value(plain, 'border'), '1.5px dashed currentColor', 'a hit is not');
  } finally { box.remove(); }
});

// U415e (normRow): a previewed node's lean row the daemon served masked (its
// state / visible / explain on the row, its anchor's exact holding the mark;
// routes/graph lean_elements through the read view) is the row's answer, so
// the pin is delivered masked and drawn .el-masked. (The hidden probe the c7
// case left set hides c7 alone.)
test('a previewed node\'s lean row served masked is delivered masked and drawn .el-masked', async () => {
  const topbar = await shell.importApp('topbar.js');
  const rec = maskedServed(comment('c8', 'p1'));
  assert.ok(rec.anchor.quote.exact.startsWith(MASK('secret')), 'precondition: the served exact holds the mark');
  const lean = { id: 'c8', v: 1, type: 'comment', schema: 'comment@1', anchor: rec.anchor, shared: true, replies: 0, answered: false,
    state: rec.state, visible: rec.visible, explain: rec.explain };
  shell.setRoutes({ '/api/graph/node/n2': { id: 'n2', mounts: MOUNTS, store: {}, created_at: 2, lean_elements: [lean], elements: [] } });
  try {
    await topbar.previewNode('n2');
    await shell.tick();
    assert.equal(ov.drawnScopeOf(), 'preview');
    const row = ov.elementsOf('preview').find((r) => r.id === 'c8');
    assert.deepEqual(row.answer, { state: 'masked', visible: 'masked', explain: EXPLAIN.masked }, 'the served state is the row\'s answer');
    await drawnUntil(() => markersFor('c8').length === 1 && markersFor('c8')[0].classList.contains('el-masked'), 'the previewed pin drawn masked');
    assert.ok(!markersFor('c8')[0].classList.contains('el-hit'), 'never a plain hit');
    assert.ok(!orphanIds().includes('c8'), 'not listed as an orphan');
    assert.ok(deliveredOf('c8').includes('masked'), 'delivered masked');
    assert.ok(!deliveredOf('c8').includes('orphaned'), 'never the resolver\'s orphaned');
  } finally {
    topbar.returnToActive();
    await shell.tick();
    shell.setRoutes({});
  }
  assert.equal(ov.drawnScopeOf(), 'live');
});

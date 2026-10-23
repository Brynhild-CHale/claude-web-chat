'use strict';
// The highlight type in the real chrome (annotation engine 2C.4, U328a; F3
// highlight.js; GT-07's highlight clause). The real public/index.html and
// main.js (test-support/chrome-shell, booted once), the real overlay, resolver,
// reads gate, input-mode policy and queue rail; the daemon's answers stubbed.
//
// Pinned here:
//   - the Chromium path (a stub CSS.highlights / Highlight and adoptedStyleSheets
//     installed on the window): a mouse selection in a pane, with the highlight
//     armed, POSTs {type: 'highlight', anchor: <a range record>, payload:
//     {shared: true, color: 'gold', note: ''}} through http.js, snapped to whole
//     words; its range lands in CSS.highlights under wc-hl-gold, the pane's
//     shadow root adopts the ONE shared sheet (another pane the same object),
//     and removing the last highlight in a root takes the sheet out;
//   - the armed tool's settings give the colour and the snap (K.2-14; F2 (a)):
//     a token name always, gold with no record and for a colour not a token;
//   - the geometry fallback (no CSS.highlights): rectangles from the range's
//     getClientRects drawn inside its marker in #el-layer, re-measured after a
//     resize; never a <mark>, never a node added inside a pane's shadow root
//     (a MutationObserver over each pane counts);
//   - a re-resolved range paints as the guess stand-in (wc-hl-<token>-guess,
//     class hl-guess); an orphan is not painted and is listed by orphans();
//   - a previewed older node paints its highlights (GET ?node=) and refuses
//     create and edit; a reset repaints from one GET, no poll;
//   - a selection across two panes is refused with SPAN_HINT; a finger's
//     selection on static content creates one (K.2-6, D1 b), a selection in a
//     focused input does not (K.2-9); a pen's compatibility mousedown never
//     reaches a pane's control while the highlight is armed (K.2-48);
//   - the note popover's PATCH and DELETE; the rail's card for an element item
//     {type: 'highlight'} (K.2-11): swatch, note, Show on page;
//   - get_comments({type: 'highlight'}) (the real handler over a stubbed
//     client) requests the one read with shared_only=1, and get_comments()
//     sends exactly the comment request (the S-14 golden's).
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

// A test may spell the schema (the ratchet scans lib/ and public/).
const SCHEMA = 'highlight@1';
const listing = {
  ok: true,
  types: [{ type: 'highlight', schema: SCHEMA, reads: [SCHEMA], anchors: ['range', 'source'], family: 'page' }],
  reserved: ['comment', 'highlight', 'box-grab'],
};

let shell, W, M, ov, IM, HL, anchors, topbar, toolbar, queue;
const live = new Map();          // the stub daemon's live highlight records
let previewRecs = [];
let nextId = 1;

const PANE = (id, extra = '') => ({
  id, target: 'main', params: {},
  html: `<p class="lead">lead of ${id}</p><p class="more">second block here</p><button class="go">Go</button>${extra}<script>
    root.querySelector('.go').addEventListener('click', function () { window.__goClicks.push(mountId); });
    root.querySelector('.go').addEventListener('mousedown', function () { window.__goDowns.push(mountId); });
  </script>`,
});
const MOUNTS = [PANE('p1'), PANE('p2'), PANE('p3', '<input class="f" value="type here">')];

const queueRaf = [];
const fakeRaf = (fn) => { queueRaf.push(fn); return queueRaf.length; };
function flush(max = 10000) { let n = 0; while (queueRaf.length && n < max) { queueRaf.shift()(0); n++; } return n; }
// Ranges answer their stubbed rects (the fallback test); every element is the
// whole viewport, so nothing is clipped.
let RECTS = null;
const VIEW = { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800, x: 0, y: 0 };
const rectOf = (x) => {
  if (x && x.nodeType === undefined && typeof x.getClientRects === 'function') {
    const rs = x.getClientRects();
    if (rs && rs.length) return rs[0];
    return { left: 200, top: 200, width: 40, height: 16, right: 240, bottom: 216, x: 200, y: 200 };
  }
  return VIEW;
};

function elementsRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const u = new URL(url, 'http://x');
  if (method === 'GET') {
    if (u.searchParams.get('node')) return { elements: previewRecs, next_cursor: 9 };
    return { elements: [...live.values()], next_cursor: 9 };
  }
  if (method === 'POST') {
    const b = JSON.parse(init.body);
    const rec = { id: `h${nextId++}`, type: 'highlight', v: 1, schema: SCHEMA, seq: nextId, anchor: b.anchor, ...b.payload };
    live.set(rec.id, rec);
    return { ok: true, element: rec };
  }
  return { ok: true };
}
function elementRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const id = decodeURIComponent(new URL(url, 'http://x').pathname.split('/').pop());
  const rec = live.get(id);
  if (!rec) return { error: 'not found', id };
  if (method === 'PATCH') {
    const b = JSON.parse(init.body);
    const next = { ...rec, ...b.payload, v: rec.v + 1 };
    live.set(id, next);
    return { ok: true, element: next };
  }
  if (method === 'DELETE') { live.delete(id); return { ok: true, removed: id }; }
  return { ok: true };
}

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements/types': () => listing,
      '/api/elements': elementsRoute,
      '/api/elements/*': elementRoute,
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }, { id: 'n2', label: 'n2', parent_id: 'n1', created_at: 2 }], active: 'n1' },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  W.__goClicks = [];
  W.__goDowns = [];
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  HL = await shell.importApp('highlight.js');
  anchors = (await shell.importApp('anchors.js')).default;
  topbar = await shell.importApp('topbar.js');
  toolbar = await shell.importApp('toolbar-state.js');
  queue = await shell.importApp('queue.js');
  ov.initOverlay({ rectOf, raf: fakeRaf });
  await shell.frame(helloFrame({ active: 'n1', mounts: MOUNTS }));
  await shell.tick();
  flush();
});
after(async () => {
  if (ov) ov.setArmed(null);
  removeApi();
  if (W) W.localStorage.removeItem('wc:finger-draws');
  if (shell) await shell.restore();
});

const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const lead = (id) => rootOf(id).querySelector('p.lead');
const layer = () => W.document.getElementById('el-layer');
const markersFor = (id) => [...layer().querySelectorAll('.el-marker')].filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const posts = () => shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements');

// ── the Custom Highlight API, stubbed (jsdom has none of it) ────────────────
let sheets = null;
function installApi() {
  sheets = new WeakMap();
  W.CSS = { highlights: new Map() };
  W.Highlight = class Highlight { constructor(...ranges) { this.ranges = ranges; } };
  const desc = { configurable: true, get() { return sheets.get(this) || []; }, set(v) { sheets.set(this, [...v]); } };
  Object.defineProperty(W.ShadowRoot.prototype, 'adoptedStyleSheets', desc);
  Object.defineProperty(W.Document.prototype, 'adoptedStyleSheets', desc);
}
function removeApi() {
  if (!W) return;
  delete W.CSS;
  delete W.Highlight;
  delete W.ShadowRoot.prototype.adoptedStyleSheets;
  delete W.Document.prototype.adoptedStyleSheets;
}
const named = (name) => (W.CSS && W.CSS.highlights.get(name)) || null;
const rangeTexts = (name) => (named(name) ? named(name).ranges.map((r) => r.toString()) : []);

// ── helpers ────────────────────────────────────────────────────────────────
function pe(el, type, pointerType, pointerId, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true, clientX: 100, clientY: 100,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  el.dispatchEvent(ev);
  return ev;
}
// A selection the browser formed inside `root` (jsdom's document selection
// cannot hold a shadow range: the root's own getSelection, as Chrome has it).
function select(root, node, start, end, endNode = node) {
  const r = W.document.createRange();
  r.setStart(node, start);
  r.setEnd(endNode, end);
  let cleared = 0;
  root.getSelection = () => ({ rangeCount: 1, getRangeAt: () => r, removeAllRanges() { cleared++; } });
  return { range: r, cleared: () => cleared, off: () => { delete root.getSelection; } };
}
async function settle(ms = 120) { for (let i = 0; i < ms / 20; i++) await shell.tick(20); }
async function drawnUntil(pred, what) {
  await waitUntil(async () => { await settle(40); flush(); return pred(); }, { timeout: 4000, what });
}
// A mouse drag over `el` with the highlight armed: its pointerdown and pointerup.
async function dragOn(downEl, upEl = downEl, pointerType = 'mouse', id = 1) {
  pe(downEl, 'pointerdown', pointerType, id);
  pe(upEl, 'pointerup', pointerType, id, { buttons: 0 });
  await shell.tick(5);
}
function watchPanes() {
  const added = [];
  const obs = MOUNTS.map((m) => {
    const o = new W.MutationObserver((recs) => { for (const r of recs) added.push(...r.addedNodes); });
    o.observe(rootOf(m.id), { childList: true, subtree: true, attributes: true, characterData: true });
    return o;
  });
  return { added, attrs: () => added, stop: () => obs.forEach((o) => o.disconnect()) };
}
const marks = () => W.document.querySelectorAll('mark').length + MOUNTS.reduce((n, m) => n + rootOf(m.id).querySelectorAll('mark').length, 0);
async function clearLive() {
  live.clear();
  await shell.frame({ type: 'element:highlight', elements: [] });
  await drawnUntil(() => ov.elementsOf('live').filter((r) => r.type === 'highlight').length === 0, 'the live highlights gone');
}
async function pushLive(...recs) {
  for (const r of recs) live.set(r.id, r);
  await shell.frame({ type: 'element:highlight', elements: [...live.values()] });
}
function recOn(mount, node, start, end, extra = {}) {
  const r = W.document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  const anchor = anchors.recordRange(rootOf(mount), r, { mount });
  return { id: `h${nextId++}`, type: 'highlight', v: 1, schema: SCHEMA, anchor, shared: true, color: 'gold', note: '', ...extra };
}

// ── the Chromium path ──────────────────────────────────────────────────────
test('Chromium path: a selection in a pane POSTs a range anchor, paints through CSS.highlights, and the root adopts the one sheet until its last highlight goes', async () => {
  installApi();
  IM.setFingerDraws('off');
  await shell.tick(5);
  const watch = watchPanes();
  const sel = select(rootOf('p1'), lead('p1').firstChild, 1, 6);   // "ead o"
  const n0 = posts().length;
  try {
    ov.setArmed('highlight');
    await dragOn(lead('p1'));
    await waitUntil(() => posts().length > n0, { what: 'the POST' });
    const body = posts().at(-1).body;
    assert.equal(body.type, 'highlight');
    assert.deepEqual(body.payload, { shared: true, color: 'gold', note: '' }, 'gold by default, shared, no note (F2 (a))');
    assert.equal(body.anchor.kind, 'range');
    assert.equal(body.anchor.v, 1);
    assert.equal(body.anchor.mount, 'p1');
    assert.equal(body.anchor.quote.exact, 'lead of', 'snapped to whole words');
    assert.ok(sel.cleared() >= 1, 'the selection is cleared once the highlight is made');
    const [h1] = [...live.values()];
    await drawnUntil(() => rangeTexts(HL.highlightName('gold')).includes('lead of'), 'the painted range');
    assert.equal(HL.paintMode(), 'custom-highlight');
    const sheet = HL.highlightSheet();
    assert.ok(sheet, 'the one sheet was built');
    assert.ok(rootOf('p1').adoptedStyleSheets.includes(sheet), 'the pane\'s shadow root adopted it');
    assert.equal(W.document.adoptedStyleSheets.includes(sheet), false, 'the document did not (no markdown highlight)');
    assert.ok([...sheet.cssRules].some((r) => /::highlight\(wc-hl-gold\)/.test(r.cssText) && /var\(--wc-gold\)/.test(r.cssText)), 'its rule paints from the token');
    assert.equal(markersFor(h1.id).length, 1, 'one marker (the handle)');
    // A second pane's highlight: the SAME sheet object.
    await pushLive(recOn('p2', lead('p2').firstChild, 0, 4));
    await drawnUntil(() => rangeTexts(HL.highlightName('gold')).length === 2, 'both ranges');
    assert.ok(rootOf('p2').adoptedStyleSheets.includes(sheet), 'p2 adopted the same sheet');
    assert.equal(rootOf('p2').adoptedStyleSheets.filter((s) => s === sheet).length, 1);
    // p1's highlight deleted: its root drops the sheet, p2's keeps it.
    live.delete(h1.id);
    await shell.frame({ type: 'element:highlight', elements: [...live.values()] });
    await drawnUntil(() => !rootOf('p1').adoptedStyleSheets.includes(sheet), 'p1 dropping the sheet');
    assert.ok(rootOf('p2').adoptedStyleSheets.includes(sheet));
    assert.deepEqual(rangeTexts(HL.highlightName('gold')), ['lead']);
    // The last one: the registry entry and every sheet go.
    await clearLive();
    await drawnUntil(() => !named(HL.highlightName('gold')), 'the registry entry gone');
    assert.equal(rootOf('p2').adoptedStyleSheets.includes(sheet), false, 'the last root dropped it');
    assert.equal(marks(), 0, 'no <mark> anywhere');
    assert.deepEqual(watch.added, [], 'no node was added inside any pane');
  } finally {
    ov.setArmed(null);
    sel.off();
    watch.stop();
  }
});

test('the armed tool\'s settings: the colour is a token name (gold when none, or when not a token), blocks snap to the whole block', async () => {
  const sel = select(rootOf('p1'), lead('p1').firstChild, 1, 3);
  const frame = (settings) => toolbar.applyToolbarFrame({ type: 'toolbar', project: { settings: { highlight: settings } }, user: {}, merged: {} });
  try {
    ov.setArmed('highlight');
    frame({ color: 'green', snap: 'blocks' });
    let n0 = posts().length;
    await dragOn(lead('p1'));
    await waitUntil(() => posts().length > n0, { what: 'the POST' });
    assert.equal(posts().at(-1).body.payload.color, 'green');
    assert.equal(posts().at(-1).body.anchor.quote.exact, 'lead of p1', 'the block snap took the whole paragraph');
    frame({ color: 'red; background: url(x)' });
    n0 = posts().length;
    await dragOn(lead('p1'));
    await waitUntil(() => posts().length > n0, { what: 'the second POST' });
    assert.equal(posts().at(-1).body.payload.color, 'gold', 'a colour not a token is gold');
    assert.equal(posts().at(-1).body.anchor.quote.exact, 'lead', 'words is the default snap');
    for (const c of posts().map((p) => p.body.payload.color)) assert.ok(HL.COLORS.includes(c), `${c} is a token`);
  } finally {
    ov.setArmed(null);
    sel.off();
    frame({});
    await clearLive();
  }
});

// ── the geometry fallback ──────────────────────────────────────────────────
test('the fallback (no CSS.highlights): rectangles from getClientRects in the overlay layer, re-measured after a resize; no <mark>, nothing added in a pane', async () => {
  removeApi();
  assert.equal(HL.paintMode(), 'geometry');
  RECTS = [{ left: 300, top: 120, width: 60, height: 16 }, { left: 280, top: 138, width: 20, height: 16 }];
  W.Range.prototype.getClientRects = function getClientRects() {
    return (RECTS || []).map((r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }));
  };
  const watch = watchPanes();
  try {
    const rec = recOn('p1', lead('p1').firstChild, 0, 7, { color: 'rust' });
    await pushLive(rec);
    await drawnUntil(() => markersFor(rec.id).length === 1 && markersFor(rec.id)[0].querySelectorAll('.hl-rect').length === 2, 'two rectangles');
    const m = markersFor(rec.id)[0];
    assert.equal(m.parentElement, layer(), 'drawn in the overlay layer');
    assert.equal(m.dataset.color, 'rust');
    const g = HL.HANDLE_GLYPH;
    const ox = 300 + g.dx;
    const oy = 120 + g.dy;
    const rs = [...m.querySelectorAll('.hl-rect')];
    assert.deepEqual(rs.map((r) => [r.style.left, r.style.top, r.style.width, r.style.height]), [
      [`${300 - ox}px`, `${120 - oy}px`, '60px', '16px'],
      [`${280 - ox}px`, `${138 - oy}px`, '20px', '16px'],
    ]);
    assert.match(m.style.clipPath, /^polygon\(/, 'clipped to the overlay\'s clip');
    // A resize: re-measured.
    RECTS = [{ left: 300, top: 120, width: 60, height: 16 }, { left: 280, top: 138, width: 45, height: 16 }];
    W.dispatchEvent(new W.Event('resize'));
    await drawnUntil(() => markersFor(rec.id)[0] && markersFor(rec.id)[0].querySelectorAll('.hl-rect')[1].style.width === '45px', 'the re-measure');
    assert.equal(marks(), 0, 'no <mark> anywhere');
    assert.deepEqual(watch.added, [], 'no node added inside any pane');
    // The overlay's clip (here the 1280×800 viewport) cuts a rectangle that
    // reaches past it, and drops one wholly outside it.
    RECTS = [{ left: 300, top: 120, width: 60, height: 16 }, { left: 1260, top: 138, width: 45, height: 16 }, { left: 280, top: 900, width: 45, height: 16 }];
    W.dispatchEvent(new W.Event('resize'));
    await drawnUntil(() => markersFor(rec.id)[0] && markersFor(rec.id)[0].querySelectorAll('.hl-rect').length === 2
      && markersFor(rec.id)[0].querySelectorAll('.hl-rect')[1].style.width === '20px', 'the clipped rectangles');
  } finally {
    watch.stop();
    delete W.Range.prototype.getClientRects;
    RECTS = null;
    await clearLive();
  }
});

// K.2-74 (U302d): a range whose START scrolled above the clip keeps the
// rectangles still in view in the fallback — a range group with a move seam
// is placed when ANY of its rects meets the clip; the glyph (its handle) is
// then inset away. The Custom Highlight path paints the range as before.
test('the fallback: a range whose first rect is above the clip and whose second is inside draws exactly that one .hl-rect; the Custom Highlight path is unchanged', async () => {
  removeApi();
  assert.equal(HL.paintMode(), 'geometry');
  RECTS = [{ left: 300, top: -40, width: 60, height: 16 }, { left: 280, top: 138, width: 20, height: 16 }];
  W.Range.prototype.getClientRects = function getClientRects() {
    return (RECTS || []).map((r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }));
  };
  try {
    const rec = recOn('p1', lead('p1').firstChild, 0, 7, { color: 'green' });
    await pushLive(rec);
    await drawnUntil(() => markersFor(rec.id).length === 1 && markersFor(rec.id)[0].querySelectorAll('.hl-rect').length === 1, 'one rectangle');
    const m = markersFor(rec.id)[0];
    assert.notEqual(m.style.display, 'none', 'the marker is placed although its start is clipped');
    const g = HL.HANDLE_GLYPH;
    const ox = 300 + g.dx;
    const oy = -40 + g.dy;
    const [r] = [...m.querySelectorAll('.hl-rect')];
    assert.deepEqual([r.style.left, r.style.top, r.style.width, r.style.height],
      [`${280 - ox}px`, `${138 - oy}px`, '20px', '16px'], 'the second rectangle, the one inside the clip');
    // The clip (the viewport) cuts the handle, which sits above its top.
    const T = 0 - oy;
    assert.ok(T >= g.h, 'the handle lies wholly above the clip polygon');
    assert.match(m.style.clipPath, new RegExp(`^polygon\\(${-ox}px ${T}px`));
    // Every rect outside the clip: not placed at all.
    RECTS = [{ left: 300, top: -40, width: 60, height: 16 }, { left: 280, top: 900, width: 20, height: 16 }];
    W.dispatchEvent(new W.Event('resize'));
    await drawnUntil(() => markersFor(rec.id)[0] && markersFor(rec.id)[0].style.display === 'none', 'hidden with no rect in view');
    // The Custom Highlight path: painted through CSS.highlights as before, no rectangle.
    installApi();
    RECTS = [{ left: 300, top: -40, width: 60, height: 16 }, { left: 280, top: 138, width: 20, height: 16 }];
    await pushLive({ ...rec, v: 2 });
    await drawnUntil(() => rangeTexts('wc-hl-green').length === 1, 'painted by the Custom Highlight API');
    assert.equal(layer().querySelectorAll('.hl-rect').length, 0, 'no rectangle on the Custom Highlight path');
  } finally {
    delete W.Range.prototype.getClientRects;
    RECTS = null;
    await clearLive();
    removeApi();
  }
});

// ── re-resolution ──────────────────────────────────────────────────────────
test('a re-resolved range paints as the guess stand-in; an orphan is never painted and is listed by orphans()', async () => {
  installApi();
  try {
    const guess = recOn('p2', lead('p2').firstChild, 0, 4);
    guess.anchor = { ...guess.anchor, ordinal: { index: 0, of: 2 } };   // counted twice when made: unique today → re-resolved
    const orphan = recOn('p2', lead('p2').firstChild, 0, 4);
    orphan.anchor = { ...orphan.anchor, quote: { exact: 'words that are nowhere', prefix: '', suffix: '' }, pos: { start: 400, end: 422 } };
    await pushLive(guess, orphan);
    await drawnUntil(() => rangeTexts(HL.highlightName('gold', true)).includes('lead'), 'the guess painted');
    assert.deepEqual(rangeTexts(HL.highlightName('gold')), [], 'not painted as a hit');
    assert.ok(markersFor(guess.id)[0].classList.contains('hl-guess'), 'its marker is the guess stand-in');
    assert.ok([...HL.highlightSheet().cssRules].some((r) => /wc-hl-gold-guess/.test(r.cssText) && /dashed/.test(r.cssText)), 'the guess rule is a dashed underline');
    assert.deepEqual(markersFor(orphan.id), [], 'the orphan has no marker');
    assert.deepEqual(ov.orphans().map((o) => o.id), [orphan.id], 'and is listed for the re-anchor');
  } finally {
    await clearLive();
  }
});

test('a selection in a markdown item records a source anchor; the document adopts the sheet, and a section answer paints as the guess', async () => {
  installApi();
  const before0 = '## Plan\n\nAlpha beta gamma delta epsilon zeta.\n\n## Other\n\nUnrelated words.\n';
  await shell.frame({ type: 'markdown', id: 'md-hl', text: before0, owner: 'claude' });
  const block = M.itemEl(W.document, 'md-hl').el;
  const p = block.querySelector('p');
  const tn = p.firstChild;
  const at = tn.data.indexOf('gamma delta');
  const r = W.document.createRange();
  r.setStart(tn, at + 1);
  r.setEnd(tn, at + 'gamma del'.length);
  const sel = W.document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  try {
    ov.setArmed('highlight');
    const n0 = posts().length;
    await dragOn(p);
    await waitUntil(() => posts().length > n0, { what: 'the POST' });
    const { anchor } = posts().at(-1).body;
    assert.equal(anchor.kind, 'source');
    assert.equal(anchor.md, 'md-hl');
    assert.equal(anchor.slug, 'plan', 'it follows its section');
    assert.equal(anchor.quote.exact, 'gamma delta');
    ov.setArmed(null);
    await drawnUntil(() => rangeTexts(HL.highlightName('gold')).includes('gamma delta'), 'painted');
    assert.ok(W.document.adoptedStyleSheets.includes(HL.highlightSheet()), 'the document adopted the sheet');
    // The section rewritten: re-resolved, how 'section' — a guess.
    await shell.frame({ type: 'markdown', id: 'md-hl', text: '## Plan\n\nEverything here was rewritten.\n\n## Other\n\nUnrelated words.\n', owner: 'claude' });
    await drawnUntil(() => named(HL.highlightName('gold', true)) && !named(HL.highlightName('gold')), 'the section guess');
  } finally {
    ov.setArmed(null);
    sel.removeAllRanges();
    await shell.frame({ type: 'markdown:remove', id: 'md-hl' });
    await clearLive();
  }
  await drawnUntil(() => !W.document.adoptedStyleSheets.includes(HL.highlightSheet()), 'the document dropped the sheet');
});

// ── previews, resets ───────────────────────────────────────────────────────
test('a previewed older node paints its highlights and refuses create and edit; leaving it repaints the live page', async () => {
  const P1 = MOUNTS[0];
  const prev = recOn('p1', lead('p1').firstChild, 5, 7);
  prev.id = 'h500';
  previewRecs = [prev];
  shell.setRoutes({ '/api/graph/node/n2': { id: 'n2', mounts: [P1], store: {}, elements: ['h500@1'], lean_elements: [] } });
  const sel = { off() {} };
  try {
    await topbar.previewNode('n2');
    await waitUntil(() => shell.calls.some((c) => c.url === '/api/elements?type=highlight&node=n2'), { what: 'the node read' });
    await drawnUntil(() => rangeTexts(HL.highlightName('gold')).includes('of'), 'the preview painted');
    // create refused: a selection and a drag with the tool armed post nothing.
    Object.assign(sel, select(rootOf('p1'), lead('p1').firstChild, 0, 4));
    ov.setArmed('highlight');
    const n0 = posts().length;
    await dragOn(lead('p1'));
    await settle();
    assert.equal(posts().length, n0, 'no POST on a preview');
    ov.setArmed(null);
    // edit refused: the note opens read-only.
    const m = markersFor('h500')[0];
    m.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
    const pop = W.document.querySelector('.hl-pop');
    assert.ok(pop, 'the note opened');
    assert.equal(pop.querySelector('textarea'), null, 'nothing to edit');
    assert.equal(pop.querySelector('.hl-save, .hl-delete'), null, 'no save, no delete');
    assert.equal(pop.querySelector('.hl-pop-hint').textContent, topbar.READONLY_HINT);
    W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } finally {
    ov.setArmed(null);
    sel.off();
    shell.setRoutes({});
    topbar.leavePreview({ restoreSnapshot: true });
    previewRecs = [];
  }
  await drawnUntil(() => !rangeTexts(HL.highlightName('gold')).includes('of'), 'the live page again');
});

test('Set active and back: a reset repaints from the reset path with one GET and no poll', async () => {
  const rec = recOn('p3', lead('p3').firstChild, 0, 4);
  live.set(rec.id, rec);
  const gets = () => shell.calls.filter((c) => c.method === 'GET' && c.url === '/api/elements?type=highlight').length;
  const intervals = shell.intervals().length;
  const g0 = gets();
  const row = { id: rec.id, v: 1, type: 'highlight', schema: SCHEMA, anchor: rec.anchor, shared: true, replies: 0, answered: false };
  await shell.frame({ type: 'reset', mounts: MOUNTS, store: {}, elements: [row], surface: 3 });
  await drawnUntil(() => rangeTexts(HL.highlightName('gold')).includes('lead'), 'repainted');
  assert.equal(gets(), g0 + 1, 'one read per reset');
  await settle(200);
  flush();
  assert.equal(gets(), g0 + 1, 'and no poll after it');
  assert.equal(shell.intervals().length, intervals, 'no timer was set');
  await clearLive();
});

// ── what a selection may be ────────────────────────────────────────────────
test('a selection across two panes is refused with the hint, and posts nothing', async () => {
  const sel = select(rootOf('p1'), lead('p1').firstChild, 0, 4);
  try {
    ov.setArmed('highlight');
    const n0 = posts().length;
    await dragOn(lead('p1'), lead('p2'));
    await settle();
    assert.equal(posts().length, n0, 'nothing posted');
    assert.equal(W.document.querySelector('#reaim-note .reaim-note-text').textContent, HL.SPAN_HINT);
  } finally {
    ov.setArmed(null);
    sel.off();
  }
});

test('a finger\'s selection on static content makes a highlight (K.2-6, D1 b); a selection inside a focused input does not (K.2-9)', async () => {
  IM.setFingerDraws('off');
  const sel = select(rootOf('p1'), lead('p1').firstChild, 0, 4);
  const input = rootOf('p3').querySelector('input.f');
  const sel3 = select(rootOf('p3'), lead('p3').firstChild, 0, 4);
  try {
    ov.setArmed('highlight');
    let n0 = posts().length;
    await dragOn(lead('p1'), lead('p1'), 'touch', 11);
    await waitUntil(() => posts().length > n0, { what: 'the finger\'s POST' });
    assert.equal(posts().at(-1).body.anchor.mount, 'p1');
    n0 = posts().length;
    input.focus();
    await dragOn(input, input, 'touch', 12);
    await dragOn(input, input, 'mouse', 13);
    await settle();
    assert.equal(posts().length, n0, 'a focused field keeps its selection');
  } finally {
    ov.setArmed(null);
    sel.off();
    sel3.off();
    await clearLive();
  }
});

test('a pen press the tool took: its compatibility mousedown never reaches the pane\'s control, nor its click', async () => {
  const btn = rootOf('p2').querySelector('button.go');
  W.__goDowns = [];
  W.__goClicks = [];
  try {
    ov.setArmed('highlight');
    pe(btn, 'pointerdown', 'pen', 21);
    btn.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
    pe(btn, 'pointerup', 'pen', 21, { buttons: 0 });
    btn.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
    btn.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
    assert.deepEqual(W.__goDowns, [], 'the mousedown was the tool\'s');
    assert.deepEqual(W.__goClicks, [], 'and so was the click');
    ov.setArmed(null);
    btn.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, detail: 1 }));
    assert.deepEqual(W.__goDowns, ['p2'], 'disarmed, the page hears it again');
  } finally {
    ov.setArmed(null);
  }
});

// ── the note, the rail ─────────────────────────────────────────────────────
test('the note popover edits note and colour through PATCH, and Delete removes the highlight', async () => {
  installApi();
  const rec = recOn('p1', lead('p1').firstChild, 0, 4);
  await pushLive(rec);
  await drawnUntil(() => markersFor(rec.id).length === 1, 'the marker');
  markersFor(rec.id)[0].dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  let pop = W.document.querySelector('.hl-pop');
  assert.ok(pop && pop.querySelector('textarea.hl-note'), 'the note opened, editable');
  pop.querySelector('textarea.hl-note').value = 'check this';
  pop.querySelector('.hl-color[data-color="rust"]').click();
  pop.querySelector('.hl-save').click();
  await waitUntil(() => shell.calls.some((c) => c.method === 'PATCH' && c.url === `/api/elements/${rec.id}`), { what: 'the PATCH' });
  const patch = shell.calls.filter((c) => c.method === 'PATCH').at(-1).body;
  assert.deepEqual(patch, { payload: { note: 'check this', color: 'rust' }, base_v: 1 });
  await drawnUntil(() => rangeTexts(HL.highlightName('rust')).includes('lead'), 'repainted rust');
  assert.equal(W.document.querySelector('.hl-pop'), null, 'saved and closed');
  markersFor(rec.id)[0].dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  pop = W.document.querySelector('.hl-pop');
  pop.querySelector('.hl-delete').click();
  await waitUntil(() => shell.calls.some((c) => c.method === 'DELETE' && c.url === `/api/elements/${rec.id}`), { what: 'the DELETE' });
  await drawnUntil(() => markersFor(rec.id).length === 0 && !named(HL.highlightName('rust')), 'gone');
});

test('the rail draws an element item {type: \'highlight\'} through the highlight\'s card: its swatch, its note, Show on page', async () => {
  const rec = recOn('p1', lead('p1').firstChild, 0, 4, { color: 'green', note: 'check this' });
  await pushLive(rec);
  await drawnUntil(() => markersFor(rec.id).length === 1, 'the marker');
  shell.setRoutes({ '/api/queue': { items: [{ id: 'q-h1', kind: 'element', type: 'highlight', element_id: rec.id, v: 1,
    summary: `Highlight · ${rec.id}@1 · "check this"`, why_wake: 'Highlight sent to Claude', source: 'browser', staged: true, origin_mount: 'p1' }], count: 1 } });
  try {
    await queue.hydrateQueue();
    const row = () => W.document.querySelector('.rail-item[data-id="q-h1"]');
    await waitUntil(() => row() && row().querySelector('.qi-card[data-type="highlight"] .hl-card'), { what: 'the card' });
    const card = row().querySelector('.qi-card[data-type="highlight"]');
    assert.equal(card.querySelector('.hl-swatch').dataset.color, 'green');
    assert.equal(card.querySelector('.hl-card-note').textContent, 'check this');
    const n = shell.scrolls.length;
    card.querySelector('.hl-card-show').click();
    assert.equal(shell.scrolls.length, n + 1, 'Show on page scrolled');
    assert.equal(shell.scrolls.at(-1).el, lead('p1'), 'to the highlighted text');
  } finally {
    shell.setRoutes({});
    await queue.hydrateQueue();
    await clearLive();
  }
});

// ── get_comments' type parameter ───────────────────────────────────────────
test('get_comments({type: \'highlight\'}) reads the one element read with shared_only=1; get_comments() sends exactly the comment request', async (t) => {
  const mcpClientPath = require.resolve('../lib/mcp/client.js');
  const toolPath = require.resolve('../lib/mcp/tools/get_comments.js');
  const saved = require.cache[mcpClientPath];
  const gets = [];
  require.cache[mcpClientPath] = {
    id: mcpClientPath, filename: mcpClientPath, loaded: true,
    exports: { get: async (p) => { gets.push(p); return { elements: [{ id: 'h1', type: 'highlight' }], next_cursor: 4, respond_hint: 'x' }; } },
  };
  delete require.cache[toolPath];
  t.after(() => {
    if (saved) require.cache[mcpClientPath] = saved; else delete require.cache[mcpClientPath];
    delete require.cache[toolPath];
  });
  const tool = require(path.join('..', 'lib', 'mcp', 'tools', 'get_comments.js'));
  const hl = await tool.handler({ type: 'highlight' });
  assert.equal(gets[0], '/api/elements?type=highlight&shared_only=1');
  assert.deepEqual(hl, { type: 'highlight', elements: [{ id: 'h1', type: 'highlight' }], next_cursor: 4 });
  const c = await tool.handler({});
  assert.equal(gets[1], '/api/elements?type=comment&shared_only=1', 'the comment request, unchanged');
  assert.deepEqual(Object.keys(c), ['comments', 'next_cursor', 'respond_hint']);
  await tool.handler({ since: 3, mount: 'm1' });
  assert.equal(gets[2], '/api/elements?type=comment&shared_only=1&since=3&mount=m1');
  assert.ok(/highlight/.test(tool.description), 'its description names highlights');
  assert.equal(tool.inputSchema.properties.type.type, 'string');
});

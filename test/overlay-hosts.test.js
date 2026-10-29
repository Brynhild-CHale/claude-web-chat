// The overlay's host registry (annotation engine 3C.1, U431; readiness R2 §3,
// 'a host registry: one overlay layer per host at its rung'; feeds GT-07).
//
// The real chrome (test-support/chrome-shell, booted once) with the overlay's
// box reads, frames and clock stubbed through initOverlay({rectOf, raf, now}),
// as test/overlay-clip.test.js does: jsdom does no layout, so the test owns the
// geometry. A fixture host stands in for the chat (U432 registers the real
// one): a light-DOM root holding a scrolling well of items, rows of anchor
// kind 'item', placed by the host's own place().
//
// Pinned here:
//   - hosts() lists the page first (#el-layer at --z-pins, root #main); a host
//     gets one body-level #el-layer-<name> after #stage, class el-host-layer,
//     z-index var(<rung>); every layer id is reserved; a name outside
//     page/chat/turns and a second registration are refused;
//   - a host's row is placed by its place(), never by the page resolver (no
//     anchors.watch, never orphaned 'no-mount'), drawn in its own layer only;
//     a row two hosts list draws one marker in each; a null place draws none;
//   - the S-1 clip per host: stepped through the well's scroll range in 40 px
//     steps, 0 anchor points drawn and 0 glyph boxes painting outside
//     well ∩ viewport; a per-group well (fn) clips each group to its own box;
//   - the never-draw rule: an iframe root, a root in an iframe's document and a
//     well in a frame are refused; a glyph meeting an iframe in the host's
//     root, one at document level or one in a pane's shadow root is not drawn
//     (stats(host).frame_hidden counts it), one beside them is;
//   - a hello's and a reset's lean rows, and a preview, leave a host's marker
//     as it was; onAnswers and orphans() never see a host row; a host's
//     hidden() hides its marker; settle triggers re-place once per frame, a
//     scroll re-measures without placing;
//   - DRAW_RULES: L4's four states drawn as hits with their own classes,
//     never listed; no state literal outside stateOf;
//   - pointers: a press in a host reaches only the type registered for (that
//     host, the armed tool), with input.host; no creating type, no listener;
//     a finger tap on static text in a host root reaches the tool (the isWell
//     hunk) and one on a button runs it; nothing is created while previewing;
//     pick() is #main's alone; elementsAt with {host} reads that host's rows.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { isReservedId } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
let shell, W, M, ov, anchors, bus, topbar, IM;

// ── the fake scheduler and clock the overlay draws on ──────────────────────
const queue = [];
let clock = 0;
const fakeRaf = (fn) => { queue.push(fn); return queue.length; };
function flush(max = 10000) {
  let n = 0;
  while (queue.length && n < max) { queue.shift()(clock); n++; }
  assert.ok(n < max, 'the overlay settles to no pending frame');
  return n;
}

// ── the geometry ────────────────────────────────────────────────────────────
const VIEW = { left: 0, top: 0, right: 1024, bottom: 768 };   // jsdom's window.innerWidth × innerHeight
const MAIN = { left: 0, top: 48, width: 680, height: 700 };
const WELL = { left: 700, top: 100, width: 300, height: 400 };     // the fixture host's scrolling well
const ITEMS = 30;
const ITEM_H = 60;
const geo = { scroll: 0 };
const rectFns = new Map();
const FAR = { left: -5000, top: -5000, width: 10, height: 10 };
function rect(r) { return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }; }
let reads = 0;
function rectOf(x) {
  reads++;
  clock += 0.01;
  const f = rectFns.get(x);
  return rect(f ? f() : FAR);
}
const itemBox = (i) => ({ left: 720, top: WELL.top + 10 + i * ITEM_H - geo.scroll, width: 200, height: 40 });
const box = (r) => ({ left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height });
const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

const PANE = {
  id: 'hp1', target: 'main', params: {},
  html: '<iframe class="fx-if" title="fx"></iframe><p class="lead">lead of hp1</p><p class="side">side of hp1</p>'
    + '<button class="go">Go</button>',
};

// The fixture host's DOM: a root (tabindex -1, as #chat-stream) holding a
// scrolling well of items, an iframe, a button and static text.
let fx;
function buildFixture(id) {
  const d = W.document;
  const root = d.createElement('div');
  root.id = id;
  root.setAttribute('tabindex', '-1');
  const well = d.createElement('div');
  well.className = 'fx-well';
  well.style.overflow = 'auto';
  for (let i = 0; i < ITEMS; i++) {
    const it = d.createElement('div');
    it.className = 'fx-item';
    it.dataset.fxItem = `i${i}`;
    it.textContent = `item number ${i}`;
    well.appendChild(it);
  }
  const iframe = d.createElement('iframe');
  iframe.className = 'fx-if';
  const btn = d.createElement('button');
  btn.className = 'fx-btn';
  btn.textContent = 'Act';
  const text = d.createElement('span');
  text.className = 'fx-text';
  text.textContent = 'static words';
  root.append(well, iframe, btn, text);
  d.getElementById('stage').appendChild(root);
  return { root, well, iframe, btn, text, item: (i) => well.querySelector(`[data-fx-item="i${i}"]`) };
}

const placed = [];   // every place() call: [host, row id]
function placeIn(name, rootEl) {
  return (row) => {
    placed.push([name, row.id]);
    const a = row.anchor || {};
    const el = rootEl.querySelector(`[data-fx-item="${a.item}"]`);
    if (!el) return null;
    return { state: (row.answer && row.answer.state) || 'exact', how: 'id', el };
  };
}
function register(name, extra = {}) {
  const h = name === 'chat' ? fx : (extra.fixture || fx);
  return ov.registerHost(name, {
    root: h.root, well: h.well, rung: name === 'chat' ? '--z-chat-pins' : '--z-turns-pins',
    kinds: ['item'], place: placeIn(name, h.root), ...extra,
  });
}
const row = (id, item, extra = {}) => ({ id, v: 1, type: 'fx-chat', anchor: { kind: 'item', item: `i${item}` }, shared: true,
  replies: 0, answer: { state: 'exact', explain: 'Pinned here.' }, ...extra });
const layerOf = (name) => W.document.getElementById(name === 'page' ? 'el-layer' : `el-layer-${name}`);
const markersIn = (name, id) => [...layerOf(name).querySelectorAll('.el-marker')]
  .filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const shown = (m) => !!m && m.style.display !== 'none';
const paneRoot = () => M.itemEl(W.document, 'hp1').el.shadowRoot;

before(async () => {
  shell = await bootShell({});
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  // main.js registers the real 'chat' host (chat-pins.js, U432): this file's
  // fixture stands in for it, so the real one is taken down first.
  (await shell.importApp('chat-pins.js')).stopChatPins();
  // And the real 'turns' host (graph-turns.js, U433), for the same reason.
  (await shell.importApp('graph-turns.js')).stopGraphTurns();
  IM = await shell.importApp('input-mode.js');
  anchors = (await shell.importApp('anchors.js')).default;
  bus = (await shell.importApp('bus.js')).bus;
  topbar = await shell.importApp('topbar.js');
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  fx = buildFixture('fx-chat-root');
  for (let i = 0; i < ITEMS; i++) rectFns.set(fx.item(i), () => itemBox(i));
  rectFns.set(fx.well, () => WELL);
  rectFns.set(W.document.getElementById('main'), () => MAIN);
  ov.initOverlay({ rectOf, raf: fakeRaf, now: () => clock });
  ov.registerType('fx-chat', { draw() {}, host: 'chat' });
  await shell.tick();
  flush();
});

after(async () => {
  if (ov) ov.setArmed(null);
  if (shell) await shell.restore();
});

async function settle() {
  await shell.tick();
  flush();
  await shell.tick();
  flush();
}

// ── the registry ────────────────────────────────────────────────────────────
test('hosts(): the page first on #el-layer at --z-pins; a host gets one body-level layer after #stage at its rung; names refused', async () => {
  const [page] = ov.hosts();
  assert.deepEqual({ name: page.name, layer: page.layer, rung: page.rung }, { name: 'page', layer: 'el-layer', rung: '--z-pins' });
  assert.equal(page.root, W.document.getElementById('main'), 'the page host is rooted at #main');
  assert.deepEqual(page.kinds, ['element', 'range', 'source']);
  const off = register('chat');
  try {
    const hs = ov.hosts();
    assert.deepEqual(hs.map((h) => h.name), ['page', 'chat']);
    assert.equal(hs[1].root, fx.root);
    assert.equal(hs[1].rung, '--z-chat-pins');
    const L = W.document.getElementById('el-layer-chat');
    assert.ok(L, 'one #el-layer-chat');
    assert.equal(W.document.querySelectorAll('#el-layer-chat').length, 1);
    assert.equal(L.parentNode, W.document.body, 'body-level');
    assert.ok(L.classList.contains('el-host-layer'));
    assert.equal(L.style.zIndex, 'var(--z-chat-pins)', 'its rung written inline');
    const stage = W.document.getElementById('stage');
    assert.ok(stage.compareDocumentPosition(L) & W.Node.DOCUMENT_POSITION_FOLLOWING, 'after #stage');
    assert.equal(W.document.querySelectorAll('#el-layer').length, 1, '#el-layer still once');
    for (const h of ov.hosts()) assert.ok(isReservedId(h.layer), `${h.layer} is a reserved id`);
    assert.ok(isReservedId('el-layer-turns'));
    assert.throws(() => ov.registerHost('dock', { root: fx.root, well: fx.well, rung: '--z-chat-pins', kinds: ['item'], place() {} }),
      TypeError, 'a name outside page/chat/turns');
    assert.throws(() => register('chat'), TypeError, 'a second chat');
    assert.throws(() => ov.registerHost('page', { root: fx.root, well: fx.well, rung: '--z-pins', kinds: ['item'], place() {} }),
      TypeError, 'the page is initOverlay\'s');
    assert.throws(() => ov.registerHost('turns', { root: fx.root, well: fx.well, rung: '--z-turns-pins', kinds: ['element'], place() {} }),
      TypeError, 'a host never lists one of the page\'s kinds');
    assert.equal(ov.isHostRoot(fx.root), true);
    assert.equal(ov.isHostRoot(W.document.getElementById('main')), true);
    assert.equal(ov.isHostRoot(fx.well), false);
  } finally { off(); }
  assert.equal(W.document.getElementById('el-layer-chat'), null, 'unregister takes the layer');
  assert.deepEqual(ov.hosts().map((h) => h.name), ['page']);
  assert.equal(ov.isHostRoot(fx.root), false);
});

test('a host\'s row is placed by its place, never the page resolver; drawn in its layer only; two hosts draw one marker each', async () => {
  const watched = [];
  const ownWatch = anchors.watch;
  anchors.watch = function (mount, spec) { watched.push(mount); return ownWatch.call(this, mount, spec); };
  const answered = [];
  const offAns = ov.onAnswers((m) => answered.push(...m.items.map((it) => it.id)));
  const off = register('chat');
  const fx2 = buildFixture('fx-turns-root');
  for (let i = 0; i < ITEMS; i++) rectFns.set(fx2.item(i), () => ({ ...itemBox(i), left: 760 }));
  rectFns.set(fx2.well, () => WELL);
  const off2 = ov.registerHost('turns', { root: fx2.root, well: fx2.well, rung: '--z-turns-pins', kinds: ['item'],
    place: placeIn('turns', fx2.root) });
  placed.length = 0;
  try {
    ov.upsertElements('live', [row('k1', 2), row('k-none', 999)]);
    await settle();
    assert.deepEqual(watched, [], 'no anchors.watch for a host row');
    assert.ok(placed.some(([h, id]) => h === 'chat' && id === 'k1'), 'the chat host placed it');
    assert.ok(placed.some(([h, id]) => h === 'turns' && id === 'k1'), 'the turns host placed it');
    assert.equal(markersIn('chat', 'k1').length, 1);
    assert.ok(shown(markersIn('chat', 'k1')[0]), 'drawn in #el-layer-chat');
    assert.equal(markersIn('turns', 'k1').length, 1, 'one marker in each layer');
    assert.ok(shown(markersIn('turns', 'k1')[0]));
    assert.equal(markersIn('page', 'k1').length, 0, 'never in #el-layer');
    assert.equal(markersIn('chat', 'k-none').length, 0, 'a null place: not drawn');
    assert.ok(!ov.orphans().some((o) => o.id === 'k1' || o.id === 'k-none'), 'never orphaned, never listed');
    assert.ok(!answered.includes('k1') && !answered.includes('k-none'), 'onAnswers never hears a host row');
    assert.equal(ov.stats('chat').drawn, 1);
    assert.equal(ov.stats('turns').drawn, 1);
    assert.equal(ov.stats('chat').layer, 'el-layer-chat');
    assert.equal(ov.stats('nobody'), null);
  } finally {
    ov.removeElements('live', ['k1', 'k-none']);
    off2(); off(); offAns();
    anchors.watch = ownWatch;
    fx2.root.remove();
    await settle();
  }
});

test('a row of a host\'s kind that came before the host is unplaced, never the page\'s (K.2-161): no orphan, no answer, before or after', async () => {
  const answered = [];
  const offAns = ov.onAnswers((m) => answered.push(...m.items.map((it) => it.id)));
  try {
    ov.upsertElements('live', [row('early', 4)]);
    await settle();
    assert.ok(!ov.orphans().some((o) => o.id === 'early'), 'no host lists it yet: unplaced, never a page orphan');
    assert.deepEqual(answered, [], 'never delivered to onAnswers');
    const off = register('chat');
    await settle();
    assert.ok(!ov.orphans().some((o) => o.id === 'early'), 'the host took it');
    assert.ok(shown(markersIn('chat', 'early')[0]));
    off();
    await settle();
    assert.ok(!ov.orphans().some((o) => o.id === 'early'), 'unregistered: held, unplaced, never page-orphaned');
    assert.deepEqual(answered, [], 'no answer at any step');
  } finally {
    ov.removeElements('live', ['early']);
    offAns();
    await settle();
  }
});

// ── the clip (S-1, per host) ────────────────────────────────────────────────
test('S-1 per host: through the well\'s scroll range in 40 px steps, nothing drawn or painted outside well ∩ viewport', async () => {
  const off = register('chat');
  const rows = [];
  for (let i = 0; i < ITEMS; i += 2) rows.push(row(`s${i}`, i));
  try {
    ov.upsertElements('live', rows);
    await settle();
    const range = 10 + ITEMS * ITEM_H - WELL.height;
    let steps = 0;
    let drawnTotal = 0;
    let outOfClip = 0;
    let paintedOutside = 0;
    let missed = 0;
    const placesBefore = ov.stats('chat').places;
    for (geo.scroll = 0; geo.scroll <= range; geo.scroll += 40) {
      ov.requestDraw();
      flush();
      steps++;
      const truth = meet(VIEW, box(WELL));
      for (let i = 0; i < ITEMS; i += 2) {
        const p = itemBox(i);
        const inside = p.left >= truth.left && p.left < truth.right && p.top > truth.top && p.top < truth.bottom;
        const [m] = markersIn('chat', `s${i}`);
        assert.ok(m, `s${i} has a marker`);
        if (!shown(m)) { if (inside) missed++; continue; }
        drawnTotal++;
        const x = parseFloat(m.style.left);
        const y = parseFloat(m.style.top);
        if (!(x >= truth.left && x < truth.right && y >= truth.top && y < truth.bottom)) outOfClip++;
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
      }
    }
    assert.ok(steps > 30, `stepped ${steps} scroll positions`);
    assert.ok(drawnTotal > 100, `markers were drawn (${drawnTotal})`);
    assert.equal(outOfClip, 0, 'anchor points drawn out of clip');
    assert.equal(paintedOutside, 0, 'glyph boxes painting outside the clip');
    assert.equal(missed, 0, 'every anchor inside the clip is drawn');
    assert.ok(ov.stats('chat').clipped > 0, 'some were clipped on the way');
    assert.equal(ov.stats('chat').places, placesBefore, 'a re-measure never re-places');
  } finally {
    geo.scroll = 0;
    ov.removeElements('live', rows.map((r) => r.id));
    off();
    await settle();
  }
});

test('a per-group well (fn) clips each group to its own box', async () => {
  const d = W.document;
  const root = d.createElement('div');
  const stream = d.createElement('div');
  const diff = d.createElement('div');
  stream.className = 'fx-stream';
  diff.className = 'fx-diff';
  const a = d.createElement('div');
  a.dataset.fxItem = 'a';
  const b = d.createElement('div');
  b.dataset.fxItem = 'b';
  stream.appendChild(a);
  diff.appendChild(b);
  root.append(stream, diff);
  d.getElementById('stage').appendChild(root);
  rectFns.set(stream, () => ({ left: 700, top: 100, width: 300, height: 200 }));
  rectFns.set(diff, () => ({ left: 700, top: 320, width: 300, height: 200 }));
  // Both anchors at y 360: inside the diff's box, below the stream's.
  rectFns.set(a, () => ({ left: 760, top: 360, width: 100, height: 20 }));
  rectFns.set(b, () => ({ left: 760, top: 360, width: 100, height: 20 }));
  const wells = [];
  const off = ov.registerHost('turns', {
    root, rung: '--z-turns-pins', kinds: ['item'], place: placeIn('turns', root),
    well: (g) => { const w = g.el && g.el.closest('.fx-diff') ? diff : stream; wells.push(w); return w; },
  });
  try {
    ov.upsertElements('live', [
      { id: 'w-a', v: 1, type: 'fx-chat', anchor: { kind: 'item', item: 'a' } },
      { id: 'w-b', v: 1, type: 'fx-chat', anchor: { kind: 'item', item: 'b' } },
    ]);
    await settle();
    assert.ok(wells.includes(stream) && wells.includes(diff), 'the well is asked per group');
    assert.ok(!shown(markersIn('turns', 'w-a')[0]), 'the stream\'s group is clipped to the stream');
    assert.ok(shown(markersIn('turns', 'w-b')[0]), 'the diff\'s group is drawn inside the diff');
  } finally {
    ov.removeElements('live', ['w-a', 'w-b']);
    off();
    root.remove();
    await settle();
  }
});

// ── the never-draw rule ─────────────────────────────────────────────────────
test('never-draw: a frame is never a host — an iframe root, a root in an iframe\'s document, a well in a frame', () => {
  const d = W.document;
  const ifr = d.createElement('iframe');
  d.body.appendChild(ifr);
  try {
    const inner = ifr.contentDocument.createElement('div');
    ifr.contentDocument.body.appendChild(inner);
    const spec = (root, well) => ({ root, well, rung: '--z-chat-pins', kinds: ['item'], place() { return null; } });
    assert.throws(() => ov.registerHost('chat', spec(ifr, fx.well)), TypeError, 'an iframe root');
    assert.throws(() => ov.registerHost('chat', spec(inner, fx.well)), TypeError, 'a root in an iframe\'s document');
    assert.throws(() => ov.registerHost('chat', spec(fx.root, inner)), TypeError, 'a well in a frame\'s document');
    assert.throws(() => ov.registerHost('chat', spec(fx.root, ifr)), TypeError, 'an iframe well');
    assert.deepEqual(ov.hosts().map((h) => h.name), ['page'], 'nothing registered');
    assert.equal(d.getElementById('el-layer-chat'), null);
  } finally { ifr.remove(); }
});

test('never-draw: a glyph meeting an iframe (in the host root, at document level, in a pane\'s shadow root) is not drawn; one beside is', async () => {
  const d = W.document;
  const docFrame = d.createElement('iframe');
  docFrame.id = 'fx-ph-frame';
  d.body.appendChild(docFrame);
  // The host root's iframe over item 3's glyph; the document-level one over
  // item 6's; items 1 and 4 beside them.
  rectFns.set(fx.iframe, () => ({ left: 690, top: WELL.top + 10 + 3 * ITEM_H - 40, width: 100, height: 40 }));
  rectFns.set(docFrame, () => ({ left: 690, top: WELL.top + 10 + 6 * ITEM_H - 40, width: 100, height: 40 }));
  const off = register('chat');
  // The page: the pane's own iframe over the lead's glyph; the side beside it.
  const pr = paneRoot();
  const lead = pr.querySelector('p.lead');
  const side = pr.querySelector('p.side');
  const paneFrame = pr.querySelector('iframe.fx-if');
  rectFns.set(lead, () => ({ left: 100, top: 230, width: 200, height: 20 }));
  rectFns.set(side, () => ({ left: 400, top: 230, width: 200, height: 20 }));
  rectFns.set(paneFrame, () => ({ left: 80, top: 120, width: 200, height: 100 }));
  const pageRows = [
    { id: 'pf-lead', v: 1, type: 'comment', anchor: anchors.record(pr, lead, { mount: 'hp1' }), shared: true, replies: 0 },
    { id: 'pf-side', v: 1, type: 'comment', anchor: anchors.record(pr, side, { mount: 'hp1' }), shared: true, replies: 0 },
  ];
  try {
    ov.upsertElements('live', [row('f3', 3), row('f6', 6), row('f1', 1), row('f4', 4), ...pageRows]);
    await waitUntil(() => { flush(); return ov.stats().anchors >= 2; }, { what: 'the page answers', timeout: 5000 });
    await settle();
    assert.ok(!shown(markersIn('chat', 'f3')[0]), 'not drawn over the iframe in the host root');
    assert.ok(!shown(markersIn('chat', 'f6')[0]), 'not drawn over the document-level iframe');
    assert.ok(shown(markersIn('chat', 'f1')[0]), 'one beside is drawn');
    assert.ok(shown(markersIn('chat', 'f4')[0]), 'one beside is drawn');
    assert.equal(ov.stats('chat').frame_hidden, 2, 'stats(host).frame_hidden counts them');
    assert.ok(!shown(markersIn('page', 'pf-lead')[0]), 'not drawn over the pane\'s own iframe');
    assert.ok(shown(markersIn('page', 'pf-side')[0]), 'the page glyph beside it is drawn');
    assert.equal(ov.stats('page').frame_hidden, 1);
    // A hidden frame is no frame: the glyph returns.
    docFrame.setAttribute('hidden', '');
    ov.requestDraw();
    flush();
    assert.ok(shown(markersIn('chat', 'f6')[0]), 'a hidden iframe hides nothing');
    assert.equal(ov.stats('chat').frame_hidden, 1);
  } finally {
    ov.removeElements('live', ['f3', 'f6', 'f1', 'f4', 'pf-lead', 'pf-side']);
    off();
    docFrame.remove();
    rectFns.delete(fx.iframe);
    await settle();
  }
});

// ── resets, previews, answers ───────────────────────────────────────────────
test('a hello, a reset and a preview leave a host row drawn (its marker not rebuilt); leaving the preview leaves it as it was', async () => {
  const off = register('chat');
  try {
    ov.upsertElements('live', [row('r1', 2)]);
    await settle();
    const m0 = markersIn('chat', 'r1')[0];
    assert.ok(shown(m0));
    await shell.frame(helloFrame({ active: 'n1', mounts: [PANE], elements: [], surface: 3 }));
    await settle();
    assert.deepEqual(ov.elementsOf('live').map((r) => r.id), ['r1'], 'the hello kept the host row');
    assert.equal(markersIn('chat', 'r1')[0], m0, 'its marker is not rebuilt');
    assert.ok(shown(m0));
    await shell.frame({ type: 'reset', active: 'n1', store: {}, lock: null, theme: null, activeTheme: null, mounts: [PANE], elements: [] });
    await settle();
    assert.equal(markersIn('chat', 'r1')[0], m0, 'a reset (a Wipe, New graph) keeps it');
    assert.ok(shown(m0));
    shell.setRoutes({ '/api/graph/node/n2': { id: 'n2', mounts: [PANE], store: {}, created_at: 2, lean_elements: [], elements: [] } });
    await topbar.previewNode('n2');
    await settle();
    assert.equal(ov.drawnScopeOf(), 'preview', 'the page swapped to the preview');
    assert.equal(markersIn('chat', 'r1')[0], m0);
    assert.ok(shown(m0), 'drawn over a preview');
    topbar.returnToActive();
    await settle();
    assert.equal(ov.drawnScopeOf(), 'live');
    assert.equal(markersIn('chat', 'r1')[0], m0, 'leaving the preview leaves it');
    assert.ok(shown(m0));
  } finally {
    ov.removeElements('live', ['r1']);
    off();
    await settle();
  }
});

test('answers: onAnswers and orphans() never see a host row; a host\'s hidden() hides its marker; the daemon\'s answer is kept on the row', async () => {
  const answered = [];
  const offAns = ov.onAnswers((m) => answered.push(...m.items.map((it) => it.id)));
  let hideIt = true;
  const off = register('chat', { hidden: ({ row: r, host }) => (hideIt && r.id === 'a2' && host === 'chat' ? 'collapsed' : null) });
  try {
    ov.upsertElements('live', [row('a1', 1), row('a2', 2, { answer: { state: 'masked', explain: 'masked line', how: 'mask', start: 3, end: 9 } })]);
    await settle();
    const kept = ov.elementsOf('live').find((r) => r.id === 'a2');
    assert.deepEqual(kept.answer, { state: 'masked', explain: 'masked line', how: 'mask', start: 3, end: 9 }, 'copied as given');
    assert.ok(shown(markersIn('chat', 'a1')[0]));
    assert.equal(markersIn('chat', 'a2').length, 0, 'the hidden reason: not drawn');
    hideIt = false;
    fx.item(2).classList.add('fx-touched');   // a mutation under the root re-places
    await settle();
    const [m2] = markersIn('chat', 'a2');
    assert.ok(shown(m2), 'drawn once the host stops hiding it');
    assert.ok(m2.classList.contains('el-masked'), 'drawn with the masked class');
    assert.deepEqual(answered.filter((id) => id === 'a1' || id === 'a2'), [], 'onAnswers heard no host row');
    assert.ok(!ov.orphans().some((o) => o.id === 'a1' || o.id === 'a2'));
  } finally {
    fx.item(2).classList.remove('fx-touched');
    ov.removeElements('live', ['a1', 'a2']);
    off(); offAns();
    await settle();
  }
});

test('settle: many triggers re-place once per frame; a scroll re-measures without placing', async () => {
  let fire = null;
  const off = register('chat', { settle: (trigger) => { fire = trigger; return () => { fire = null; }; } });
  try {
    ov.upsertElements('live', [row('t1', 1)]);
    await settle();
    assert.equal(typeof fire, 'function', 'the host\'s settle was subscribed');
    const before = ov.stats('chat').places;
    placed.length = 0;
    for (let i = 0; i < 5; i++) fire({ why: i });
    flush();
    assert.equal(ov.stats('chat').places, before + 1, 'one re-place for five triggers');
    assert.deepEqual(placed, [['chat', 't1']]);
    placed.length = 0;
    const r0 = reads;
    geo.scroll = 40;
    W.dispatchEvent(new W.Event('scroll'));
    flush();
    assert.deepEqual(placed, [], 'a scroll never re-places');
    assert.ok(reads > r0, 'a scroll re-measures');
    assert.equal(parseFloat(markersIn('chat', 't1')[0].style.top), itemBox(1).top, 'the marker followed the scroll');
  } finally {
    geo.scroll = 0;
    ov.removeElements('live', ['t1']);
    off();
    await settle();
  }
  assert.equal(fire, null, 'unregister ends the settle subscription');
});

// ── the draw rules ──────────────────────────────────────────────────────────
test('DRAW_RULES: L4\'s four states drawn as hits with their own classes, never listed; the page\'s rows unchanged; no state literal', () => {
  assert.ok(Object.isFrozen(ov.DRAW_RULES));
  for (const r of ov.DRAW_RULES) assert.ok(Object.isFrozen(r));
  for (const [state, cls] of [['masked', 'el-masked'], ['superseded', 'el-superseded'], ['indexing', 'el-indexing'], ['unavailable', 'el-unavailable']]) {
    const r = ov.drawRuleOf({ state });
    assert.ok(r, `${state} has a row`);
    assert.equal(r.draw, 'hit');
    assert.equal(r.cls, cls);
    assert.equal(r.listed, false);
  }
  assert.deepEqual({ ...ov.drawRuleOf({ state: 'exact' }) }, { state: 'exact', how: null, guess: null, draw: 'hit', cls: 'el-hit', listed: false });
  assert.deepEqual({ ...ov.drawRuleOf({ state: 're-resolved', how: 'section' }) },
    { state: 're-resolved', how: 'section', guess: null, draw: 'section', cls: 'el-section', listed: false });
  assert.deepEqual({ ...ov.drawRuleOf({ state: 're-resolved', how: 'bracket' }) },
    { state: 're-resolved', how: null, guess: null, draw: 'hit', cls: 'el-hit', listed: false });
  assert.equal(ov.drawRuleOf({ state: 'provisional' }), null, 'refused is never stored: no row');
  // The source: every state name is spelled only inside stateOf('…').
  const src = fs.readFileSync(path.join(REPO, 'public/app/overlay.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const states = ['exact', 're-resolved', 'orphaned', 'masked', 'provisional', 'superseded', 'expired', 'draw-failed', 'indexing', 'unavailable'];
  const stray = [];
  for (const st of states) {
    for (const m of src.matchAll(new RegExp(`['"\`]${st}['"\`]`, 'g'))) {
      if (!/stateOf\($/.test(src.slice(Math.max(0, m.index - 8), m.index))) stray.push(st);
    }
  }
  assert.deepEqual(stray, [], 'state literals outside stateOf');
  assert.doesNotMatch(src, /\bEXPLAIN\b|Pinned here\./, 'no second EXPLAIN table in the chrome');
});

// ── pointers ────────────────────────────────────────────────────────────────
function pe(el, type, pointerType, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId: 7, isPrimary: true, clientX: 750, clientY: 200,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  el.dispatchEvent(ev);
  return ev;
}
function tap(el, pointerType) {
  pe(el, 'pointerdown', pointerType);
  pe(el, 'pointerup', pointerType);
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType, pointerId: 7 }));
}

test('pointers: a press in a host reaches only the type registered for (that host, the armed tool); #main keeps its own', async () => {
  IM.installInputMode();
  IM.setFingerDraws('off');
  const created = [];
  const offPage = ov.registerType('fx-tool', { draw() {}, input: 'taps', create: (inp) => created.push(['page', inp.host, inp.phase]) });
  const offHost = ov.registerType('fx-tool-chat', { draw() {}, input: 'taps', host: 'chat', tool: 'fx-tool',
    create: (inp) => created.push(['chat', inp.host, inp.phase]) });
  const off = register('chat');
  const btnClicks = [];
  const onBtn = () => btnClicks.push('act');
  fx.btn.addEventListener('click', onBtn);
  try {
    ov.setArmed('fx-tool');
    assert.equal(ov.stats('chat').listening, true, 'the host listens while its type\'s tool is armed');
    tap(fx.text, 'mouse');
    assert.deepEqual(created, [['chat', 'chat', 'click']], 'the host\'s type, input.host chat');
    created.length = 0;
    tap(paneRoot().querySelector('p.lead'), 'mouse');
    assert.deepEqual(created, [['page', 'page', 'click']], '#main\'s press reaches the page type');
    created.length = 0;
    // A finger: static text in the host root (the root carries tabindex -1,
    // as #chat-stream) reaches the tool; a button runs.
    tap(fx.text, 'touch');
    assert.deepEqual(created, [['chat', 'chat', 'click']], 'a finger tap on static text reaches the tool (isWell)');
    created.length = 0;
    tap(fx.btn, 'touch');
    assert.deepEqual(created, [], 'a finger tap on a button is not the tool\'s');
    assert.deepEqual(btnClicks, ['act'], 'the button ran');
    btnClicks.length = 0;
    // While previewing, nothing is created in any host.
    shell.setRoutes({ '/api/graph/node/n2': { id: 'n2', mounts: [PANE], store: {}, created_at: 2, lean_elements: [], elements: [] } });
    await topbar.previewNode('n2');
    await shell.tick();
    tap(fx.text, 'mouse');
    tap(paneRoot().querySelector('p.lead'), 'mouse');
    assert.deepEqual(created, [], 'nothing created while previewing');
    topbar.returnToActive();
    await shell.tick();
    // Armed with a tool the host has no type for: no listener on its root, the
    // host's own handler hears the click.
    ov.setArmed(null);
    const added = [];
    const ownAdd = fx.root.addEventListener;
    fx.root.addEventListener = function (t, fn, o) { added.push(t); return ownAdd.call(this, t, fn, o); };
    try {
      ov.setArmed('fx-other');
      assert.deepEqual(added, [], 'no capture listener on a host with no creating type');
      assert.equal(ov.stats('chat').listening, false);
      tap(fx.btn, 'mouse');
      assert.deepEqual(btnClicks, ['act'], 'the host\'s own handler heard the click');
      assert.deepEqual(created, []);
    } finally { fx.root.addEventListener = ownAdd; }
  } finally {
    ov.setArmed(null);
    fx.btn.removeEventListener('click', onBtn);
    off(); offHost(); offPage();
    W.localStorage.removeItem('wc:finger-draws');
    await settle();
  }
  assert.equal(ov.stats('chat'), null);
});

test('pick() resolves only from #main; elementsAt keeps its page answers and reads a host\'s with {host}', async () => {
  const off = register('chat');
  try {
    const pk = ov.pick({ kind: 'element' });
    let done = null;
    pk.promise.then((v) => { done = v; });
    tap(fx.text, 'mouse');
    await shell.tick();
    assert.equal(done, null, 'a press in a host is not the pick\'s');
    const lead = paneRoot().querySelector('p.lead');
    tap(lead, 'mouse');
    await shell.tick();
    assert.ok(done && done.kind === 'element' && done.mount === 'hp1', 'the press in #main records');
    // elementsAt: a page row and two nested host rows at one point.
    rectFns.set(lead, () => ({ left: 100, top: 300, width: 200, height: 20 }));
    const big = fx.item(5);
    const small = W.document.createElement('span');
    small.dataset.fxItem = 'small';
    big.appendChild(small);
    rectFns.set(small, () => ({ left: 730, top: itemBox(5).top + 5, width: 30, height: 10 }));
    const pageRow = { id: 'ea-page', v: 1, type: 'comment', anchor: anchors.record(paneRoot(), lead, { mount: 'hp1' }), shared: true, replies: 0 };
    ov.upsertElements('live', [pageRow, row('ea-big', 5), { ...row('ea-small', 0), anchor: { kind: 'item', item: 'small' } }]);
    await waitUntil(() => { flush(); return ov.elementsAt(150, 310).length > 0; }, { what: 'the page answer', timeout: 5000 });
    await settle();
    assert.deepEqual(ov.elementsAt(150, 310).map((h) => h.id), ['ea-page'], 'the page, unchanged');
    const y = itemBox(5).top + 8;
    assert.deepEqual(ov.elementsAt(740, y).map((h) => h.id), [], 'a host row is never the page\'s');
    assert.deepEqual(ov.elementsAt(740, y, { host: 'chat' }).map((h) => h.id), ['ea-small', 'ea-big'], 'the host\'s, smallest first');
    assert.deepEqual(ov.elementsAt(150, 310, { host: 'chat' }), [], 'a page row is never the host\'s');
    assert.deepEqual(ov.elementsAt(740, y, { host: 'turns' }), [], 'an unregistered host answers none');
    small.remove();
  } finally {
    ov.removeElements('live', ['ea-page', 'ea-big', 'ea-small']);
    off();
    await settle();
  }
});

// ── the settle sources (U432a; the 3C gate's C-3C-1) ────────────────────────
// A host may name the elements whose animations move its well (`animates`):
// a start is followed frame by frame, the last end re-places the host once. A
// host that names none — the page, or a fixture registered without it — gets
// no draw from an animation under its root (the counter: overlay:frame and
// the pending frames).
function animEvent(type, el, name, extra = {}) {
  const e = new W.Event(type, { bubbles: true });
  Object.defineProperty(e, type.startsWith('transition') ? 'propertyName' : 'animationName', { value: name });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, { value: v });
  el.dispatchEvent(e);
}

test('settle sources: a host\'s named animation end re-places it once; a host that names none draws no more than today', async () => {
  const fx2 = buildFixture('fx-turns-anim');
  for (let i = 0; i < ITEMS; i++) rectFns.set(fx2.item(i), () => ({ ...itemBox(i), left: 760 }));
  rectFns.set(fx2.well, () => WELL);
  const off = register('chat', { animates: () => [fx.root] });
  const off2 = register('turns', { fixture: fx2 });
  const frames = [];
  const offF = bus.on('overlay:frame', (d) => frames.push(d));
  try {
    ov.upsertElements('live', [row('an1', 2)]);
    await settle();
    assert.equal(queue.length, 0, 'settled');
    // The host with no animations named, and the page: nothing at all.
    frames.length = 0;
    const turns0 = ov.stats('turns');
    for (const el of [fx2.root, fx2.item(3), W.document.getElementById('main')]) {
      for (const t of ['animationstart', 'animationend', 'animationcancel']) animEvent(t, el, 'cd-pop');
      for (const t of ['transitionrun', 'transitionend']) animEvent(t, el, 'transform');
    }
    await shell.tick();
    assert.equal(queue.length, 0, 'no frame asked for');
    flush();
    assert.equal(frames.length, 0, 'no extra draw');
    assert.equal(ov.stats('turns').places, turns0.places, 'never re-placed');
    assert.equal(ov.stats('turns').animation_settles, 0);
    assert.equal(ov.stats('chat').animation_settles, 0, 'an animation off the chat\'s named elements is not its');
    // The named host: a descendant's end (bubbling) re-places it once.
    const p0 = ov.stats('chat').places;
    animEvent('animationend', fx.item(5), 'fade');
    assert.equal(queue.length, 1, 'one frame asked for');
    flush();
    assert.equal(frames.length, 1, 'one draw');
    assert.equal(ov.stats('chat').places, p0 + 1, 're-placed once');
    assert.equal(ov.stats('chat').animation_settles, 1);
    assert.equal(ov.stats('turns').places, turns0.places, 'the other host is not re-placed');
    // A burst of ends in one frame: one draw.
    frames.length = 0;
    for (let i = 0; i < 4; i++) animEvent('transitionend', fx.root, 'transform');
    flush();
    assert.equal(frames.length, 1, 'four ends, one frame');
    assert.equal(ov.stats('chat').places, p0 + 2, 'one re-place');
    // A transition that only paints is no settle source.
    const s1 = ov.stats('chat').animation_settles;
    animEvent('transitionrun', fx.root, 'background-color');
    animEvent('transitionend', fx.root, 'opacity');
    assert.equal(queue.length, 0, 'a paint-only transition asks for nothing');
    assert.equal(ov.stats('chat').animation_settles, s1);
  } finally {
    offF();
    ov.removeElements('live', ['an1']);
    off2(); off();
    fx2.root.remove();
    await settle();
  }
});

test('settle sources: a named animation is followed frame by frame while it runs, then settles; getAnimations tells the last', async () => {
  const off = register('chat', { animates: [fx.root] });
  try {
    ov.upsertElements('live', [row('an2', 3)]);
    await settle();
    animEvent('animationstart', fx.root, 'cd-pop');
    assert.equal(ov.stats('chat').animating, true);
    const p0 = ov.stats('chat').places;
    for (let i = 1; i <= 4; i++) {
      geo.scroll = i * 7;   // the well moves under the animation
      assert.equal(queue.length, 1, `frame ${i}: one frame pending`);
      queue.shift()(clock);
      assert.equal(parseFloat(markersIn('chat', 'an2')[0].style.top), itemBox(3).top, `frame ${i}: the marker followed the well`);
    }
    assert.equal(ov.stats('chat').places, p0, 'a followed frame re-measures, never re-places');
    animEvent('animationend', fx.root, 'cd-pop');
    assert.equal(ov.stats('chat').animating, false, 'the last end stops the follow');
    flush();
    assert.equal(queue.length, 0, 'no frame after the follow');
    assert.equal(ov.stats('chat').places, p0 + 1, 'the end re-placed the host once');
    // getAnimations, where the engine has it, says whether one still runs: a
    // finite one running keeps the host waiting; an infinite one never does.
    let list = [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: 260 }) } }];
    fx.root.getAnimations = () => list;
    const s0 = ov.stats('chat').animation_settles;
    animEvent('animationend', fx.root, 'cd-slide');
    assert.equal(ov.stats('chat').animation_settles, s0, 'another finite animation still runs: no settle yet');
    list = [{ playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) } },
      { playState: 'finished', effect: { getComputedTiming: () => ({ endTime: 260 }) } }];
    animEvent('animationend', fx.root, 'cd-pop');
    assert.equal(ov.stats('chat').animation_settles, s0 + 1, 'only an infinite one left: settled');
    flush();
    // An infinite animation's start is heard but never keeps the frames going.
    animEvent('animationstart', fx.root, 'spin');
    assert.equal(queue.length, 1);
    flush();
    assert.equal(ov.stats('chat').animating, false, 'getAnimations shows no finite one running: the follow ends');
    assert.equal(queue.length, 0);
    delete fx.root.getAnimations;
    // No getAnimations and no end event: the follow stops after ANIMATION_FOLLOW_MAX_MS and re-places once.
    animEvent('animationstart', fx.root, 'cd-pop');
    queue.shift()(clock);
    const p1 = ov.stats('chat').places;
    clock += ov.ANIMATION_FOLLOW_MAX_MS + 1;
    flush();
    assert.equal(ov.stats('chat').animating, false, 'a start with no end is followed at most ANIMATION_FOLLOW_MAX_MS');
    assert.equal(ov.stats('chat').places, p1 + 1, 'and settles with one re-place');
    // Unregistering while one runs ends the follow.
    animEvent('animationstart', fx.root, 'cd-pop');
    off();
    flush();
    assert.equal(queue.length, 0, 'an unregistered host is followed no further');
  } finally {
    delete fx.root.getAnimations;
    geo.scroll = 0;
    ov.removeElements('live', ['an2']);
    off();
    await settle();
  }
  const ifr = W.document.createElement('iframe');
  W.document.body.appendChild(ifr);
  try {
    assert.throws(() => register('chat', { animates: ifr }), TypeError, 'a frame is never a settle source');
    assert.throws(() => register('chat', { animates: [fx.root, 'x'] }), TypeError, 'an element, a list of them or fn()');
  } finally { ifr.remove(); }
});

// The detachable glyph in the chrome (annotation engine tranche 4, U587; spec
// H.7; DECISIONS L.1 M4 a, K.2-151, K.2-99; RULED U587@glyph-offset-store AI5
// a). The real chrome (test-support/chrome-shell, booted once): the overlay's
// draw frames run on a fake scheduler the test flushes, its box reads on
// stubbed rects; the daemon is a stub that records each glyph move.
//
// Pinned here:
//   - the comment pin adopts the engine's glyph through its manifest alone
//     (element.json glyph {detach: true, leader: 'dotted'}, carried by
//     element-types.js): its marker is detachable, and comments.js holds no
//     drag and no leader;
//   - a mouse and a pen drag the glyph to a new spot: ONE POST
//     /api/elements/:id/glyph {dx, dy, corner} measured from the anchor box's
//     nearest corner, the glyph drawn there, the drag's click never opening
//     the thread; kept across a reload (the hello's lean rows carry no
//     display; the read serves it back);
//   - a finger press that moves before the hold pans (nothing written, the
//     glyph unmoved, its default kept); after the hold it drags;
//   - a drag in a previewed node is refused with READONLY_HINT and writes
//     nothing;
//   - the anchor re-laid out (a pane re-render moving the target): the glyph
//     follows at the same offset;
//   - the leader: drawn in the type's style ('dotted' by default, the tool's
//     setting 'faint' when chosen), inside the clip at 390 px and 1,280 px
//     wide (0 out of clip), never over a displayed frame (0 over a frame); an
//     orphaned anchor keeps its glyph at its guess with the orphan leader; the
//     density rule (past LEADER_PANE_MAX on one pane) and a glyph within
//     LEADER_NEAR_PX of its anchor collapse it to hover, shown while hovered;
//   - the grammar's copies are held equal (leaders, corners, the bound), no
//     host name was added and the CSS block is tokens only.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { convertAnchor } = require('../lib/core/element-log');
const { GLYPH_LEADERS } = require('../lib/packs/elements');
const { GLYPH_CORNERS, GLYPH_OFFSET_MAX } = require('../lib/server/domain/elements');

const REPO = path.join(__dirname, '..');

let shell, W, M, ov, comments, anchors, topbar, st, TAP_SLOP;

// ── the overlay's frames and boxes ──────────────────────────────────────────
const rafQueue = [];
const fakeRaf = (fn) => { rafQueue.push(fn); return rafQueue.length; };
function flush(max = 10000) { let n = 0; while (rafQueue.length && n < max) { rafQueue.shift()(0); n++; } return n; }
const POS = {};
const box = (left, top, width = 60, height = 14) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
// The viewport (and #main, the well) is the shell's window; an element with a
// data-pin is laid out at its named box; anything else fills the viewport.
const view = () => box(0, 0, W.innerWidth, W.innerHeight);
function rectOf(x) {
  const key = x && x.dataset && x.dataset.pin;
  if (key && POS[key]) return POS[key];
  return view();
}

// ── the stub daemon ─────────────────────────────────────────────────────────
const live = new Map();          // id → the pin as the daemon serves it
let previewPins = [];
const moves = [];                // every glyph POST: {id, body}
let refuseMoves = false;
function elementsRoute(url) {
  const u = new URL(url, 'http://x');
  if (u.searchParams.get('node')) return { elements: previewPins, next_cursor: 9 };
  return { elements: [...live.values()], next_cursor: 9 };
}
function elementRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const parts = new URL(url, 'http://x').pathname.split('/');
  if (method === 'POST' && parts[parts.length - 1] === 'glyph') {
    const id = decodeURIComponent(parts[parts.length - 2]);
    const body = JSON.parse(init.body);
    moves.push({ id, body });
    const pin = live.get(id);
    if (!pin || refuseMoves) return { ok: false, error: 'not found', hint: 'refused' };
    const display = { glyph: { dx: body.dx, dy: body.dy, corner: body.corner } };
    const next = { ...pin, v: pin.v + 1, display };
    live.set(id, next);
    return { ok: true, id, type: 'comment', v: next.v, display };
  }
  return { ok: true };
}

const PANE = (id, extra = '') => ({
  id, target: 'main', params: {},
  html: `<p class="lead" data-pin="lead-${id}">lead of ${id}</p><p class="more">more of ${id}</p>${extra}`,
});
const P1 = PANE('p1');
const P2 = PANE('p2');

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements': elementsRoute,
      '/api/elements/types': DEFAULT_ROUTES['/api/elements/types'],
      '/api/elements/*': elementRoute,
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }, { id: 'n2', label: 'n2', parent_id: 'n1', created_at: 2 }], active: 'n1' },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  ov = await shell.importApp('overlay.js');
  comments = await shell.importApp('comments.js');
  anchors = (await shell.importApp('anchors.js')).default;
  topbar = await shell.importApp('topbar.js');
  st = await shell.importApp('state.js');
  ({ TAP_SLOP } = await shell.importApp('sheet-model.js'));
  ov.initOverlay({ rectOf, raf: fakeRaf, clips: () => false, hold_ms: 40 });
  await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2] }));
  await shell.tick();
  flush();
});
after(async () => {
  if (shell && !shell.restored && ov) ov.setArmed(null);
  if (shell) await shell.restore();
});

// ── helpers ────────────────────────────────────────────────────────────────
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const lead = (id) => rootOf(id).querySelector('p.lead');
const layer = () => W.document.getElementById('el-layer');
const markersFor = (id) => [...layer().querySelectorAll('.el-marker.pin-marker')].filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const leaderFor = (id) => ov.leaders().find((l) => l.ids.includes(id)) || null;
const pinPop = () => W.document.querySelector('.pin-pop');
const reaimText = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 60) { for (let i = 0; i < ms / 20; i++) await shell.tick(20); }
async function drawnUntil(pred, what) {
  await waitUntil(async () => { await settle(40); flush(); return pred(); }, { timeout: 4000, what });
}
const at = (m, x, y) => !!m && m.style.display === '' && m.style.left === `${x}px` && m.style.top === `${y}px`;
function pinOn(id, mount, el, extra = {}) {
  const anchor = anchors.record(rootOf(mount), el, { mount });
  return { id, v: 1, seq: 1, type: 'comment', text: `${id} text`, shared: true, replies: [], anchor,
    locator: { mount, selector: 'p.lead', text: el.textContent.trim(), ordinal: 0 }, ...extra };
}
async function setLive(pins) {
  live.clear();
  for (const p of pins) live.set(p.id, p);
  await shell.frame({ type: 'element:comment', elements: pins });
}
function pe(el, type, pointerType, pointerId, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true, clientX: 100, clientY: 100,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  el.dispatchEvent(ev);
  return ev;
}
// A drag of the glyph by (dx, dy) from (100, 100): down, [the hold], two
// moves, up, then the click a pointer made.
async function drag(el, pointerType, dx, dy, { pointerId = 1, hold = 0 } = {}) {
  pe(el, 'pointerdown', pointerType, pointerId);
  if (hold) await sleep(hold);
  const half = pe(el, 'pointermove', pointerType, pointerId, { clientX: 100 + dx / 2, clientY: 100 + dy / 2 });
  pe(el, 'pointermove', pointerType, pointerId, { clientX: 100 + dx, clientY: 100 + dy });
  pe(el, 'pointerup', pointerType, pointerId, { clientX: 100 + dx, clientY: 100 + dy });
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType, pointerId, clientX: 100 + dx, clientY: 100 + dy }));
  await settle();
  return { half };
}
function closePops() {
  comments.closePinPop();
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}
const inside = (l, clip) => l.box.left >= clip.left && l.box.top >= clip.top
  && l.box.left + l.box.width <= clip.right && l.box.top + l.box.height <= clip.bottom
  && [l.line.x1, l.line.x2].every((x) => x >= 0 && x <= l.box.width)
  && [l.line.y1, l.line.y2].every((y) => y >= 0 && y <= l.box.height);

// ── the grammar and the adoption ───────────────────────────────────────────
test('the grammar\'s copies are held equal; HOST_NAMES unchanged; comments.js holds no drag and no leader; the CSS block is tokens only', () => {
  assert.deepStrictEqual([...ov.GLYPH_LEADERS], [...GLYPH_LEADERS], 'the leaders: lib/packs/elements');
  assert.deepStrictEqual([...ov.GLYPH_CORNERS], [...GLYPH_CORNERS], 'the corners: domain/elements');
  assert.equal(ov.GLYPH_OFFSET_MAX, GLYPH_OFFSET_MAX, 'the bound: domain/elements');
  assert.deepStrictEqual([...ov.HOST_NAMES], ['page', 'chat', 'turns'], 'no host (and no layer) added');
  assert.equal(ov.glyphPath('c 1'), '/api/elements/c%201/glyph');
  const src = fs.readFileSync(path.join(REPO, 'public/app/comments.js'), 'utf8');
  assert.doesNotMatch(src, /pointermove|setPointerCapture|el-leader|glyphPath|\/glyph\b/, 'no drag, no leader, no glyph write in the type');
  const css = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
  const block = css.slice(css.indexOf('/* ===== the detachable glyph\'s leader (U587, H.7)'));
  assert.ok(block.length > 100, 'the appended block');
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no literal colour');
  assert.match(block, /var\(--wc-muted\)/);
  assert.match(block, /var\(--wc-border\)/);
});

test('a mouse drags the comment pin\'s glyph: one POST of the offset from the anchor box\'s nearest corner, drawn there, the drag\'s click never the thread\'s', async () => {
  POS['lead-p1'] = box(100, 120);
  const pin = pinOn('c1', 'p1', lead('p1'));
  await setLive([pin]);
  await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'the pin drawn attached');
  const marker = markersFor('c1')[0];
  assert.equal(marker.dataset.detach, '1', 'the comment adopts the detachable glyph');
  assert.equal(leaderFor('c1').drawn, false, 'an attached glyph draws no leader');
  moves.length = 0;
  // From (100, 120) by (+200, +50): the glyph point (300, 170), nearest the
  // anchor box's bottom-right corner (160, 134).
  await drag(marker, 'mouse', 200, 50, { pointerId: 2 });
  assert.deepStrictEqual(moves.map((m) => [m.id, m.body.dx, m.body.dy, m.body.corner]), [['c1', 140, 36, 'br']], 'one POST');
  assert.equal(typeof moves[0].body.device, 'string', 'with the device claim');
  assert.equal(pinPop(), null, 'the drag\'s click did not open the thread');
  await drawnUntil(() => at(markersFor('c1')[0], 300, 170), 'drawn at its offset');
  const l = leaderFor('c1');
  assert.ok(l.drawn && l.on, 'the leader drawn');
  assert.equal(l.mode, 'dotted', 'the manifest\'s style');
  // From the anchor box's nearest edge (160, 134) to the glyph's box (287..313 × 144..170).
  assert.deepStrictEqual([l.line.x1 + l.box.left, l.line.y1 + l.box.top, l.line.x2 + l.box.left, l.line.y2 + l.box.top], [160, 134, 287, 144]);
  // A plain click (no drag) still opens the thread.
  const m2 = markersFor('c1')[0];
  pe(m2, 'pointerdown', 'mouse', 3);
  pe(m2, 'pointerup', 'mouse', 3);
  m2.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 3 }));
  assert.ok(pinPop(), 'a click on the glyph opens its thread');
  closePops();
  assert.equal(moves.length, 1, 'a click writes nothing');
});

test('a pen drags it too; the placement is kept across a reload (the hello\'s lean rows carry none; the read serves it back)', async () => {
  POS['lead-p1'] = box(100, 120);
  await setLive([{ ...pinOn('c1', 'p1', lead('p1')), v: 2, display: { glyph: { dx: 140, dy: 36, corner: 'br' } } }]);
  await drawnUntil(() => at(markersFor('c1')[0], 300, 170), 'at its offset');
  moves.length = 0;
  await drag(markersFor('c1')[0], 'pen', -260, -90, { pointerId: 4 });
  // (300, 170) by (-260, -90): (40, 80), nearest the top-left corner (100, 120).
  assert.deepStrictEqual(moves.map((m) => [m.body.dx, m.body.dy, m.body.corner]), [[-60, -40, 'tl']]);
  await drawnUntil(() => at(markersFor('c1')[0], 40, 80), 'the pen\'s drop');
  // A reload: the hello's lean rows (no display), then the read.
  const lean = { id: 'c1', v: live.get('c1').v, type: 'comment', schema: 'comment@2', anchor: live.get('c1').anchor, shared: true, replies: 0, answered: false };
  await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2], elements: [lean] }));
  await drawnUntil(() => at(markersFor('c1')[0], 40, 80), 'the stored offset read back after the reload');
});

test('a finger press that moves before the hold pans: nothing written, the glyph unmoved, its default kept; after the hold it drags', async () => {
  POS['lead-p1'] = box(100, 120);
  await setLive([pinOn('c1', 'p1', lead('p1'))]);
  await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'attached');
  moves.length = 0;
  const { half } = await drag(markersFor('c1')[0], 'touch', 0, 160, { pointerId: 5 });
  assert.equal(moves.length, 0, 'nothing written');
  assert.equal(half.defaultPrevented, false, 'the pan\'s default kept (the browser scrolls)');
  flush();
  assert.ok(at(markersFor('c1')[0], 100, 120), 'the glyph did not move');
  assert.ok(!markersFor('c1')[0].classList.contains('el-dragging'));
  closePops();
  // The same finger held past GLYPH_HOLD_MS (40 ms here) drags.
  await drag(markersFor('c1')[0], 'touch', 0, 160, { pointerId: 6, hold: 80 });
  assert.deepStrictEqual(moves.map((m) => [m.body.dx, m.body.dy, m.body.corner]), [[0, 146, 'bl']], 'held, the finger drags');
  await drawnUntil(() => at(markersFor('c1')[0], 100, 280), 'dropped');
  closePops();
  assert.ok(TAP_SLOP > 0);
});

// The policy's palm row (input-mode.js: touch → 'ignore' while a pen pointer
// is down) holds for the glyph's press too: a palm resting on a glyph while
// the pen is down starts no drag, held or not, and a finger whose hold ends
// with a pen down (the pen landed after it) drops its drag.
test('a palm on a glyph while a pen is down starts no drag, held past the hold and moved: nothing written, the glyph unmoved', async () => {
  POS['lead-p1'] = box(100, 120);
  await setLive([pinOn('c1', 'p1', lead('p1'))]);
  await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'attached');
  moves.length = 0;
  const main = W.document.getElementById('main');
  ov.setArmed('comment');
  try {
    // The pen down first, then the palm on the glyph.
    pe(main, 'pointerdown', 'pen', 70);
    await drag(markersFor('c1')[0], 'touch', 0, 160, { pointerId: 71, hold: 80 });
    pe(main, 'pointerup', 'pen', 70);
    closePops();
    assert.equal(moves.length, 0, 'a palm under the pen writes nothing');
    flush();
    assert.ok(at(markersFor('c1')[0], 100, 120), 'the glyph did not move');
    assert.ok(!markersFor('c1')[0].classList.contains('el-dragging'));
    // The finger first, the pen landing within its hold: the hold re-asks the
    // policy, and the drag is dropped. (The Escape of closePops disarmed the
    // tool: armed again.)
    ov.setArmed('comment');
    const m = markersFor('c1')[0];
    pe(m, 'pointerdown', 'touch', 72);
    pe(main, 'pointerdown', 'pen', 73);
    await sleep(80);
    pe(m, 'pointermove', 'touch', 72, { clientX: 100, clientY: 180 });
    pe(m, 'pointermove', 'touch', 72, { clientX: 100, clientY: 260 });
    pe(m, 'pointerup', 'touch', 72, { clientX: 100, clientY: 260 });
    pe(main, 'pointerup', 'pen', 73);
    await settle();
    closePops();
    assert.equal(moves.length, 0, 'a pen landing within the hold leaves the finger no drag');
    flush();
    assert.ok(at(markersFor('c1')[0], 100, 120), 'the glyph did not move');
  } finally {
    ov.setArmed(null);
  }
});

test('a drag in a previewed node is refused with READONLY_HINT and writes nothing', async () => {
  POS['lead-p1'] = box(100, 120);
  await setLive([pinOn('c1', 'p1', lead('p1'))]);
  await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'attached');
  moves.length = 0;
  const n0 = shell.calls.length;
  st.view.previewing = true;
  try {
    await drag(markersFor('c1')[0], 'mouse', 200, 50, { pointerId: 7 });
    assert.equal(moves.length, 0, 'no move');
    assert.equal(shell.calls.slice(n0).filter((c) => /\/glyph$/.test(c.url)).length, 0, 'nothing sent');
    assert.equal(reaimText(), topbar.READONLY_HINT, 'the guard\'s one hint');
    flush();
    assert.ok(at(markersFor('c1')[0], 100, 120), 'the glyph where it was');
  } finally { st.view.previewing = false; }
  closePops();
});

test('the anchor re-laid out (a pane re-render moving the target): the glyph follows at the same offset', async () => {
  POS['lead-p1'] = box(100, 120);
  await setLive([{ ...pinOn('c1', 'p1', lead('p1')), v: 3, display: { glyph: { dx: 30, dy: -20, corner: 'tr' } } }]);
  await drawnUntil(() => at(markersFor('c1')[0], 190, 100), 'at (160 + 30, 120 - 20)');
  POS['lead-p1'] = box(400, 300);
  await shell.frame({ type: 'render', ...P1, html: P1.html.replace('more of p1', 'more of p1, re-rendered') });
  await drawnUntil(() => at(markersFor('c1')[0], 490, 280), 'followed to (460 + 30, 300 - 20)');
  const l = leaderFor('c1');
  assert.ok(l.drawn, 'its leader re-drawn');
  POS['lead-p1'] = box(100, 120);
  await shell.frame({ type: 'render', ...P1 });
});

test('the leader in the tool\'s chosen style; inside the clip at 1,280 px and 390 px (0 out of clip); never over a displayed frame (0 over a frame)', async () => {
  POS['lead-p1'] = box(100, 120);
  await setLive([{ ...pinOn('c1', 'p1', lead('p1')), v: 3, display: { glyph: { dx: 600, dy: 40, corner: 'br' } } }]);
  await drawnUntil(() => at(markersFor('c1')[0], 760, 174) && leaderFor('c1').drawn, 'far right, at 1,280 px');
  assert.ok(inside(leaderFor('c1'), view()), 'inside the clip at 1,280 px');
  // The tool's setting picks the style (the small settings' leader select).
  const base = await (await W.fetch('/api/toolbar')).json();
  await shell.frame({ ...base, type: 'toolbar', user: { ...base.user, settings: { comment: { leader: 'faint' } } } });
  await drawnUntil(() => leaderFor('c1').mode === 'faint', 'the leader faint');
  await shell.frame({ ...base, type: 'toolbar' });
  await drawnUntil(() => leaderFor('c1').mode === 'dotted', 'back to the manifest\'s dotted');

  // 390 px wide: the glyph at 760 is out of the viewport (not drawn); one at
  // (300, 174) is drawn, its leader's box and line within the clip.
  shell.setViewport({ width: 390, height: 800 });
  try {
    await drawnUntil(() => markersFor('c1')[0] && markersFor('c1')[0].style.display === 'none' && !leaderFor('c1').drawn, 'clipped at 390');
    await setLive([{ ...pinOn('c1', 'p1', lead('p1')), v: 4, display: { glyph: { dx: 140, dy: 40, corner: 'br' } } }]);
    await drawnUntil(() => at(markersFor('c1')[0], 300, 174) && leaderFor('c1').drawn, 'drawn at 390');
    const l = leaderFor('c1');
    assert.ok(inside(l, view()), `inside the 390 px clip: ${JSON.stringify(l)}`);
    assert.equal(l.box.width, 390);
  } finally { shell.setViewport({ width: 1280, height: 800 }); }

  // A displayed frame between the anchor and the glyph: the leader is not drawn.
  const frame = W.document.createElement('iframe');
  frame.dataset.pin = 'frame-1';
  POS['frame-1'] = box(200, 100, 40, 200);
  W.document.body.appendChild(frame);
  try {
    ov.requestDraw();
    await drawnUntil(() => leaderFor('c1').framed && !leaderFor('c1').drawn, 'kept off the frame');
    assert.ok(at(markersFor('c1')[0], 300, 174), 'the glyph itself, clear of the frame, still drawn');
    const over = ov.leaders().filter((x) => x.drawn && x.framed);
    assert.equal(over.length, 0, '0 over a frame');
  } finally { frame.remove(); }
  ov.requestDraw();
  await drawnUntil(() => leaderFor('c1').drawn, 'drawn again once the frame is gone');
});

test('an orphaned anchor keeps its glyph at its guess, its leader styled as an orphan', async () => {
  POS['lead-p2'] = box(500, 400);
  const guessed = convertAnchor({ mount: 'p2', selector: 'p.lead', text: 'a line that moved away', ordinal: 0 });
  await setLive([{ id: 'c9', v: 2, seq: 2, type: 'comment', text: 'orphan', shared: true, replies: [], anchor: guessed,
    record: guessed, display: { glyph: { dx: -40, dy: -30, corner: 'tl' } } }]);
  await drawnUntil(() => markersFor('c9').length === 1 && leaderFor('c9') && leaderFor('c9').drawn, 'the guess drawn');
  const m = markersFor('c9')[0];
  assert.ok(m.classList.contains('el-guess'), 'drawn as a carried guess');
  assert.ok(at(m, 460, 370), 'at its offset from the guess');
  assert.equal(leaderFor('c9').orphan, true, 'the orphan styling on the leader');
  assert.ok(ov.orphans().some((o) => o.id === 'c9' && o.guess));
  // A guess is the re-anchor seam's: a drag on it writes nothing.
  moves.length = 0;
  await drag(m, 'mouse', 100, 100, { pointerId: 8 });
  assert.equal(moves.length, 0);
  closePops();
});

test('the density rule and a glyph near its anchor collapse the leader to hover, shown while the glyph or its anchor is hovered', async () => {
  POS['lead-p1'] = box(100, 120);
  // Near: 4 px from the anchor's corner.
  await setLive([{ ...pinOn('c1', 'p1', lead('p1')), v: 5, display: { glyph: { dx: 16, dy: 30, corner: 'br' } } }]);
  await drawnUntil(() => leaderFor('c1') && leaderFor('c1').drawn, 'drawn');
  assert.equal(leaderFor('c1').mode, 'hover', 'a glyph within LEADER_NEAR_PX: hover');
  assert.equal(leaderFor('c1').on, false, 'hidden until hovered');
  W.document.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 120, clientY: 125 }));
  assert.equal(leaderFor('c1').on, true, 'its anchor hovered');
  W.document.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 900, clientY: 700 }));
  assert.equal(leaderFor('c1').on, false, 'hover gone');

  // Dense: LEADER_PANE_MAX + 1 detached glyphs on p2, each far from its anchor.
  POS['lead-p2'] = box(500, 400);
  const n = ov.LEADER_PANE_MAX + 1;
  const pins = [];
  for (let i = 0; i < n; i++) {
    pins.push({ ...pinOn(`d${i}`, 'p2', lead('p2')), v: 2, display: { glyph: { dx: -200 + i * 20, dy: -150, corner: 'tl' } } });
  }
  await setLive(pins);
  await drawnUntil(() => pins.every((p) => leaderFor(p.id) && leaderFor(p.id).drawn), 'every leader drawn');
  assert.ok(pins.every((p) => leaderFor(p.id).mode === 'hover' && leaderFor(p.id).dense), 'past the density budget: all hover');
  await setLive(pins.slice(0, ov.LEADER_PANE_MAX));
  await drawnUntil(() => pins.slice(0, ov.LEADER_PANE_MAX).every((p) => leaderFor(p.id) && leaderFor(p.id).mode === 'dotted'), 'within the budget: dotted');
  await setLive([]);
});

test('on touch, a tap on a glyph whose leader is hover shows the leader, and a second tap hides it (nothing written)', async () => {
  POS['lead-p1'] = box(100, 120);
  // Near its anchor (within LEADER_NEAR_PX): the leader collapses to hover.
  await setLive([{ ...pinOn('c1', 'p1', lead('p1')), v: 6, display: { glyph: { dx: 16, dy: 30, corner: 'br' } } }]);
  await drawnUntil(() => leaderFor('c1') && leaderFor('c1').drawn && leaderFor('c1').mode === 'hover', 'a hover leader');
  assert.equal(leaderFor('c1').on, false, 'hidden before the tap');
  moves.length = 0;
  await drag(markersFor('c1')[0], 'touch', 0, 0, { pointerId: 60 });
  flush();
  assert.equal(leaderFor('c1').on, true, 'a tap on the glyph shows its hover leader');
  closePops();
  await drag(markersFor('c1')[0], 'touch', 0, 0, { pointerId: 61 });
  flush();
  assert.equal(leaderFor('c1').on, false, 'a second tap hides it');
  closePops();
  assert.equal(moves.length, 0, 'a tap writes nothing');
  await setLive([]);
});

// ── the glyph clamp (tranche 5, U631; plan 5B.1, corrects U587; RULED
// U631@refusal-feedback I3 a) ────────────────────────────────────────────────
// A dragged glyph stays inside the clip it was last drawn in (its painted box
// and its anchor point); a drop whose LAST measure was framed or clipped
// writes nothing, the glyph drawn back at its stored offset and one bus
// 'overlay:glyph-refused' {id, hint: GLYPH_DROP_HINT} per element.
let bus;
const glyphOfMarker = (m) => {
  const t = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(m.style.transform);
  return { dx: Number(t[1]), dy: Number(t[2]), w: 26, h: 26 };
};
// The marker's painted box (its placement + the glyph's offsets), client px.
function painted(m) {
  const g = glyphOfMarker(m);
  const x = parseFloat(m.style.left) + g.dx;
  const y = parseFloat(m.style.top) + g.dy;
  return { left: x, top: y, right: x + g.w, bottom: y + g.h };
}
// How many of the marker's painted px edges lie outside `clip` (0: inside),
// and its clip-path empty (no inset: wholly inside).
function outOfClip(m, clip) {
  const p = painted(m);
  const out = [clip.left - p.left, clip.top - p.top, p.right - clip.right, p.bottom - clip.bottom].filter((d) => d > 0).length;
  return out + (m.style.display === '' && m.style.clipPath === '' ? 0 : 1);
}
const clipOf = (b) => ({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
// A drag through `points` (deltas from (100, 100)), a draw frame flushed after
// each move, so the overlay measures every step before the release.
async function dragSteps(el, pointerType, points, { pointerId = 1, hold = 0 } = {}) {
  pe(el, 'pointerdown', pointerType, pointerId);
  if (hold) await sleep(hold);
  for (const [dx, dy] of points) {
    pe(el, 'pointermove', pointerType, pointerId, { clientX: 100 + dx, clientY: 100 + dy });
    flush();
  }
  const [lx, ly] = points[points.length - 1];
  pe(el, 'pointerup', pointerType, pointerId, { clientX: 100 + lx, clientY: 100 + ly });
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType, pointerId, clientX: 100 + lx, clientY: 100 + ly }));
  await settle();
}
function hearRefusals() {
  const heard = [];
  const off = bus.on('overlay:glyph-refused', (d) => heard.push(d));
  return { heard, off };
}

test('the clamp: a mouse drag far past the pane\'s right and bottom edges stops inside the clip it was drawn in; the ONE POST carries the clamped offset', async () => {
  ({ bus } = await shell.importApp('bus.js'));
  assert.equal(typeof ov.GLYPH_DROP_HINT, 'string');
  assert.ok(ov.GLYPH_DROP_HINT.length > 20, 'a plain-words hint');
  const main = W.document.getElementById('main');
  // A well narrower than the viewport: the pane's clip is the well ∩ the viewport.
  main.dataset.pin = 'well';
  POS.well = box(40, 30, 1000, 700);
  const clip = clipOf(POS.well);
  try {
    POS['lead-p1'] = box(100, 120);
    await setLive([pinOn('c1', 'p1', lead('p1'))]);
    ov.requestDraw();
    await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'attached');
    moves.length = 0;
    await drag(markersFor('c1')[0], 'mouse', 4000, 4000, { pointerId: 20 });
    // The comment's glyph (-13, -26, 26 × 26): the point clamped to
    // (1040 - 13, 730 - 0.5) = (1027, 729.5), nearest the anchor box's
    // bottom-right corner (160, 134).
    assert.deepStrictEqual(moves.map((m) => [m.id, m.body.dx, m.body.dy, m.body.corner]), [['c1', 867, 595.5, 'br']], 'one POST, clamped');
    await drawnUntil(() => at(markersFor('c1')[0], 1027, 729.5), 'drawn at the clamped drop');
    const m = markersFor('c1')[0];
    assert.equal(outOfClip(m, clip), 0, `0 out of clip: ${JSON.stringify(painted(m))}`);
    assert.equal(ov.stats().clipped, 0, 'the next measure is drawn, not clipped');
    // Up and left past the well's top-left: stops at the well's corner.
    moves.length = 0;
    await drag(markersFor('c1')[0], 'mouse', -4000, -4000, { pointerId: 21 });
    // (40 + 13, 30 + 26) = (53, 56), nearest the top-left corner (100, 120).
    assert.deepStrictEqual(moves.map((x) => [x.body.dx, x.body.dy, x.body.corner]), [[-47, -64, 'tl']]);
    await drawnUntil(() => at(markersFor('c1')[0], 53, 56), 'at the well\'s top-left');
    assert.equal(outOfClip(markersFor('c1')[0], clip), 0, '0 out of clip at the top-left');
  } finally {
    delete main.dataset.pin;
    delete POS.well;
    ov.requestDraw();
    flush();
  }
});

test('a drag released over a displayed frame: 0 POST, the glyph drawn back at its stored offset, one overlay:glyph-refused {id, hint} per element', async () => {
  POS['lead-p1'] = box(100, 120);
  const off0 = { dx: 30, dy: -20, corner: 'tr' };
  // Two pins on one element at one offset: one marker, two elements.
  await setLive([
    { ...pinOn('c1', 'p1', lead('p1')), v: 7, display: { glyph: off0 } },
    { ...pinOn('c2', 'p1', lead('p1')), v: 2, display: { glyph: off0 } },
  ]);
  await drawnUntil(() => at(markersFor('c1')[0], 190, 100) && markersFor('c2')[0] === markersFor('c1')[0], 'one marker at (160 + 30, 120 - 20)');
  const frame = W.document.createElement('iframe');
  frame.dataset.pin = 'frame-2';
  POS['frame-2'] = box(400, 300, 100, 100);
  W.document.body.appendChild(frame);
  const { heard, off } = hearRefusals();
  try {
    ov.requestDraw();
    flush();
    moves.length = 0;
    const n0 = shell.calls.length;
    // (190, 100) by (+260, +250): (450, 350), its painted box over the frame.
    await dragSteps(markersFor('c1')[0], 'mouse', [[130, 125], [260, 250]], { pointerId: 22 });
    assert.equal(moves.length, 0, '0 glyph POSTs');
    assert.equal(shell.calls.slice(n0).filter((c) => /\/glyph$/.test(c.url)).length, 0, 'nothing sent');
    assert.deepStrictEqual(heard, [{ id: 'c1', hint: ov.GLYPH_DROP_HINT }, { id: 'c2', hint: ov.GLYPH_DROP_HINT }], 'one refusal per element');
    assert.equal(pinPop(), null, 'the drag\'s click did not open the thread');
    await drawnUntil(() => at(markersFor('c1')[0], 190, 100), 'drawn back at its stored offset');
    assert.deepStrictEqual(live.get('c1').display.glyph, off0, 'its row\'s display unchanged');
    assert.equal(markersFor('c1')[0].style.display, '');
  } finally {
    off();
    frame.remove();
    ov.requestDraw();
    flush();
  }
  closePops();
});

test('a drag that crosses the frame and leaves it before the release is written once, at the drop point (the last measure decides)', async () => {
  POS['lead-p1'] = box(100, 120);
  await setLive([pinOn('c1', 'p1', lead('p1'))]);
  await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'attached');
  const frame = W.document.createElement('iframe');
  frame.dataset.pin = 'frame-3';
  POS['frame-3'] = box(300, 200, 100, 100);
  W.document.body.appendChild(frame);
  const { heard, off } = hearRefusals();
  try {
    ov.requestDraw();
    flush();
    moves.length = 0;
    // Onto the frame at (350, 250), then clear of it at (600, 250).
    await dragSteps(markersFor('c1')[0], 'mouse', [[250, 130], [500, 130]], { pointerId: 23 });
    assert.deepStrictEqual(moves.map((m) => [m.body.dx, m.body.dy, m.body.corner]), [[440, 116, 'br']], 'written once at the drop');
    assert.deepStrictEqual(heard, [], 'no refusal');
    await drawnUntil(() => at(markersFor('c1')[0], 600, 250), 'drawn at the drop');
  } finally {
    off();
    frame.remove();
    ov.requestDraw();
    flush();
  }
  closePops();
});

test('at 390 px wide the clamp holds (0 out of clip) for a mouse, a touch after the hold and a pen', async () => {
  shell.setViewport({ width: 390, height: 800 });
  try {
    const clip = { left: 0, top: 0, right: 390, bottom: 800 };
    // The point clamped to (390 - 13, 800 - 0.5) = (377, 799.5), from the
    // anchor box's bottom-right corner (160, 134).
    for (const [kind, pointerId, hold] of [['mouse', 30, 0], ['touch', 31, 80], ['pen', 32, 0]]) {
      POS['lead-p1'] = box(100, 120);
      await setLive([pinOn('c1', 'p1', lead('p1'))]);
      await drawnUntil(() => at(markersFor('c1')[0], 100, 120), `${kind}: attached`);
      moves.length = 0;
      await drag(markersFor('c1')[0], kind, 4000, 4000, { pointerId, hold });
      assert.deepStrictEqual(moves.map((m) => [m.body.dx, m.body.dy, m.body.corner]), [[217, 665.5, 'br']], `${kind}: one POST, clamped`);
      await drawnUntil(() => at(markersFor('c1')[0], 377, 799.5), `${kind}: drawn at the clamped drop`);
      assert.equal(outOfClip(markersFor('c1')[0], clip), 0, `${kind}: 0 out of clip at 390 px`);
      closePops();
    }
  } finally { shell.setViewport({ width: 1280, height: 800 }); }
});

test('a glyph whose anchor is a markdown item (the page well\'s clip) dragged past the well\'s edge stops inside the well', async () => {
  const order = ['p1', 'p2', 'md-g'];
  const text = '## Margin heading\n\nBody text under it.';
  await shell.frame({ type: 'markdown', id: 'md-g', text, owner: 'claude', gen: 1, order, claude_order: order });
  const item = W.document.querySelector('[data-md-id="md-g"]');
  assert.ok(item, 'precondition: the markdown item is drawn');
  const main = W.document.getElementById('main');
  // A Range's box: that of the nearest element around its start naming one
  // (this case alone: the file's rectOf lays out elements only).
  const desc = Object.getOwnPropertyDescriptor(W.Range.prototype, 'dataset');
  Object.defineProperty(W.Range.prototype, 'dataset', {
    configurable: true,
    get() {
      const sc = this.startContainer;
      const el = sc && (sc.nodeType === 1 ? sc : sc.parentNode);
      const named = el && el.closest ? el.closest('[data-pin]') : null;
      return named ? { pin: named.dataset.pin } : undefined;
    },
  });
  try {
    const h2 = item.querySelector('h2');
    const range = W.document.createRange();
    range.selectNodeContents(h2);
    const { sourceMap } = await shell.importApp('markdown.js');
    const rec = anchors.recordSource(item, range, sourceMap(item._wcText), item._wcText, { md: 'md-g' });
    assert.ok(rec, 'precondition: a source record');
    item.dataset.pin = 'md-item';
    h2.dataset.pin = 'md-h';
    POS['md-item'] = box(60, 260);
    POS['md-h'] = box(100, 300);
    main.dataset.pin = 'well';
    POS.well = box(45, 0, 979, 768);
    const clip = clipOf(POS.well);
    await setLive([{ id: 'c90', v: 1, seq: 1, type: 'comment', text: 'md pin', shared: true, replies: [], anchor: rec,
      locator: { mount: 'md-g', selector: 'h2', text: 'Margin heading', ordinal: 0, section: 'Margin heading' } }]);
    ov.requestDraw();
    const m = () => markersFor('c90')[0];
    await drawnUntil(() => at(m(), 60, 300), 'the md pin drawn in the margin, at the item\'s left edge');
    assert.equal(m().dataset.detach, '1', 'its glyph detaches');
    const sg = comments.SOURCE_GLYPH;
    moves.length = 0;
    await drag(m(), 'mouse', -4000, 4000, { pointerId: 33 });
    // The margin glyph (sourceGlyph's offsets, 26 × 26): the point clamped to
    // (45 - dx, 768 - 0.5 or 768 - dy - 26), from the anchor box's bottom-left
    // corner (60, 314).
    const x = 45 - sg.dx;
    const y = Math.min(768 - sg.dy - 26, 767.5);
    assert.deepStrictEqual(moves.map((v) => [v.id, v.body.dx, v.body.dy, v.body.corner]), [['c90', x - 60, y - 314, 'bl']], 'one POST, clamped into the well');
    await drawnUntil(() => at(m(), x, y), 'drawn at the clamped drop');
    assert.equal(outOfClip(m(), clip), 0, `0 out of the well: ${JSON.stringify(painted(m()))}`);
  } finally {
    if (desc) Object.defineProperty(W.Range.prototype, 'dataset', desc); else delete W.Range.prototype.dataset;
    delete main.dataset.pin;
    delete POS.well;
    delete item.dataset.pin;
    await setLive([]);
    await shell.frame({ type: 'markdown:remove', id: 'md-g', order: ['p1', 'p2'], claude_order: ['p1', 'p2'] });
    ov.requestDraw();
    flush();
  }
});

test('a drop whose last measure was clipped (the well shrank under the drag): 0 POST, the glyph drawn back, one overlay:glyph-refused', async () => {
  const main = W.document.getElementById('main');
  main.dataset.pin = 'well';
  POS.well = box(40, 30, 1000, 700);
  const { heard, off } = hearRefusals();
  try {
    POS['lead-p1'] = box(100, 120);
    await setLive([pinOn('c1', 'p1', lead('p1'))]);
    ov.requestDraw();
    await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'attached');
    moves.length = 0;
    const el = markersFor('c1')[0];
    // (100, 120) by (+300, +300): (400, 420), inside the well it was drawn in.
    pe(el, 'pointerdown', 'mouse', 24);
    pe(el, 'pointermove', 'mouse', 24, { clientX: 400, clientY: 400 });
    flush();
    // The well shrinks under the drag: (400, 420) is outside it, so the last
    // measure before the release is clipped.
    POS.well = box(40, 30, 200, 200);
    ov.requestDraw();
    flush();
    assert.ok(ov.stats().clipped >= 1, 'precondition: the last measure is clipped');
    pe(el, 'pointerup', 'mouse', 24, { clientX: 400, clientY: 400 });
    el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 24, clientX: 400, clientY: 400 }));
    await settle();
    assert.equal(moves.length, 0, '0 glyph POSTs');
    assert.deepStrictEqual(heard, [{ id: 'c1', hint: ov.GLYPH_DROP_HINT }], 'one refusal');
    assert.equal(pinPop(), null, 'the drag\'s click did not open the thread');
    await drawnUntil(() => at(markersFor('c1')[0], 100, 120), 'drawn back at its stored place');
    assert.equal(live.get('c1').display, undefined, 'its row\'s display unchanged');
  } finally {
    off();
    delete main.dataset.pin;
    delete POS.well;
    ov.requestDraw();
    flush();
  }
  closePops();
});

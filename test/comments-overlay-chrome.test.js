// The comment type in the chrome, drawn by the page well's overlay (annotation
// engine tranche 2, PLAN.md 2C.4; U327b; public/app/comments.js). The real
// chrome (test-support/chrome-shell, booted once): the overlay's draw frames
// run on a fake scheduler the test flushes, its box reads on stubbed rects.
//
// Pinned here:
//   - comments.js holds no resolver, no pin layer, no fetch( and no timer; it
//     registers the comment type through element-types.js registerElementType,
//     never the overlay's registerType;
//   - a pin survives a pane drag, a resize, a run change (a markdown item
//     inserted between two panes) and a pane-history restore: the overlay
//     re-places its marker on its own redraw, and no interval is armed;
//   - a previewed older node draws its own pins read-only: no create with the
//     comment tool armed, and the thread offers no reply, share or delete — the
//     preview's read-only hint instead (D2);
//   - a migrated comment (a 0.8.5 locator of test-support/v3-graph.js,
//     converted to pin-locator@1) draws at its converted anchor; a K-10-shaped
//     carried guess draws at its guess and its click is the overlay's re-anchor
//     seam (bus 'overlay:guess'), not the thread;
//   - pin creation posts {type: 'comment', anchor: <the engine record>,
//     locator: <the 0.8.5 locator>, payload: {text, shared}, device} through
//     http.js; replayed against a real daemon, get_comments (the real handler,
//     a stubbed client) serves the golden's anchor_label, the 0.8.5 locator as
//     `anchor` in the golden's shape and the engine record as `record` (S-14,
//     K.2-78: routes/elements.js commentRecord);
//   - the input-mode policy at the overlay's dispatch (D1 b, K.2-9): a pen and
//     a mouse drop pins (a pen on a pane's button too, the button unheard); a
//     finger tap on static content drops one, a finger tap on a pane's button
//     runs the button with comment still armed; a finger drag drops none and
//     keeps its default (the page scrolls);
//   - the comment's targets are the default 'items' (F.3, RULED M3 (a); the
//     ruled inversion of K.2-78's 'panes'): a comment-armed click on a markdown
//     link pins (the link does not follow), while a click on a pane's header
//     button and on a gap in #main passes through with the tool armed
//     (K.2-78 (c)); highlight-armed, the link click is the tool's;
//   - a pin on markdown (F.3): a heading tap records a source anchor over the
//     heading with section = the heading; a prose tap under it records the
//     paragraph with that section; a paragraph over quote_max is clamped; a
//     block whose source span is over the cap (a long link target) falls back
//     to its first 240 characters; a tap on an item's gap pins nothing; the md
//     pin's marker sits in the item's left margin inside the well's clip, a
//     pane pin's as before; Show on page reaches the item with no marker;
//   - the toolbar's comment slot (✎ retired onto it, U338) and C arm and
//     disarm the comment tool in the overlay's one armed state:
//     body.pin-mode follows armed(), whoever armed it, and comments.js keeps no
//     second state;
//   - markers are fresh after Set active and Branch (a reset's lean rows), with
//     no poll;
//   - the comment's queue card (K.2-11): a shared pin's queue item {kind:
//     'comment'} is drawn through the card registered for 'comment' — where the
//     pin is, its reply count, Show on page — and its removal is the rail's own.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');
const { waitUntil, withServer } = require('../test-support/helpers');
const { v3Graph } = require('../test-support/v3-graph');
const { convertAnchor } = require('../lib/core/element-log');

const REPO = path.join(__dirname, '..');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 's14-today.json'), 'utf8'));

let shell, W, M, ov, IM, bus, topbar, comments, anchors, TAP_SLOP;

// ── the overlay's frames and boxes ──────────────────────────────────────────
const rafQueue = [];
const fakeRaf = (fn) => { rafQueue.push(fn); return rafQueue.length; };
function flush(max = 10000) { let n = 0; while (rafQueue.length && n < max) { rafQueue.shift()(0); n++; } return n; }
// Every element is the whole viewport (nothing clipped) unless it carries a
// data-pin naming a position here.
const VIEW = { left: 0, top: 0, width: 1024, height: 768, right: 1024, bottom: 768, x: 0, y: 0 };
const POS = {};
const box = (left, top) => ({ left, top, width: 60, height: 14, right: left + 60, bottom: top + 14, x: left, y: top });
function rectOf(x) {
  const key = x && x.dataset && x.dataset.pin;
  if (key && POS[key]) return POS[key];
  // A Range (a markdown pin's source answer): the box of the nearest element
  // around its start that names a position.
  const sc = x && x.startContainer;
  const at = sc ? (sc.nodeType === 1 ? sc : sc.parentNode) : null;
  const named = at && at.closest ? at.closest('[data-pin]') : null;
  if (named && POS[named.dataset.pin]) return POS[named.dataset.pin];
  return VIEW;
}

// ── the stub daemon: the element API's comment reads and writes ─────────────
const live = new Map();          // id → the pin as the daemon serves it
let previewPins = [];
let nextId = 1;
const posts = [];
function elementsRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const u = new URL(url, 'http://x');
  if (method === 'GET') {
    if (u.searchParams.get('node')) return { elements: previewPins, next_cursor: 9 };
    return { elements: [...live.values()], next_cursor: 9 };
  }
  if (method === 'POST') {
    const b = JSON.parse(init.body);
    posts.push(b);
    const pin = { id: `c${100 + nextId++}`, v: 1, seq: nextId, type: 'comment', text: b.payload.text, shared: b.payload.shared !== false,
      replies: [], anchor: b.anchor, locator: b.locator, record: b.anchor };
    live.set(pin.id, pin);
    return { ok: true, element: pin, pin };
  }
  return { ok: true };
}
function elementRoute(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const parts = new URL(url, 'http://x').pathname.split('/');
  const reply = parts[parts.length - 1] === 'reply';
  const id = decodeURIComponent(parts[reply ? parts.length - 2 : parts.length - 1]);
  const pin = live.get(id);
  if (!pin) return { error: 'not found', id };
  if (reply) {
    const b = JSON.parse(init.body);
    const next = { ...pin, v: pin.v + 1, replies: [...pin.replies, { author: 'user', text: b.text }] };
    live.set(id, next);
    return { ok: true, element: next, pin: next };
  }
  if (method === 'PATCH') {
    const b = JSON.parse(init.body);
    const next = { ...pin, v: pin.v + 1, shared: b.shared !== undefined ? b.shared : pin.shared };
    live.set(id, next);
    return { ok: true, element: next, pin: next };
  }
  if (method === 'DELETE') { live.delete(id); return { ok: true, removed: id }; }
  return { ok: true };
}

const PANE = (id, extra = '') => ({
  id, target: 'main', params: {},
  html: `<p class="lead" data-pin="lead-${id}">lead of ${id}</p><p class="more">more of ${id}</p><button class="go">Go</button>${extra}<script>
    root.querySelector('.go').addEventListener('click', function () { window.__goClicks.push(mountId); });
  </script>`,
});
const P1 = PANE('p1');
const P2 = PANE('p2');
// The S-14 golden's pane (test/fixtures/s14-today.json: f6-s14, '#t' Timeline).
const S14 = { id: 'f6-s14', target: 'main', params: {}, html: '<h3 id="t">Timeline</h3><p id="b">Body</p>' };

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/elements': elementsRoute,
      '/api/elements/types': DEFAULT_ROUTES['/api/elements/types'],   // before the `*` below claims it
      '/api/elements/*': elementRoute,
      '/api/graph': { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }, { id: 'n2', label: 'n2', parent_id: 'n1', created_at: 2 }], active: 'n1' },
    },
  });
  W = shell.window;
  M = W.__wcMount;
  W.__goClicks = [];
  ov = await shell.importApp('overlay.js');
  IM = await shell.importApp('input-mode.js');
  bus = (await shell.importApp('bus.js')).bus;
  topbar = await shell.importApp('topbar.js');
  comments = await shell.importApp('comments.js');
  anchors = (await shell.importApp('anchors.js')).default;
  ({ TAP_SLOP } = await shell.importApp('sheet-model.js'));
  ov.initOverlay({ rectOf, raf: fakeRaf, clips: () => false });
  await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2, S14] }));
  await shell.tick();
  flush();
});
after(async () => {
  if (shell && !shell.restored) {
    if (ov) ov.setArmed(null);
    W.localStorage.removeItem('wc:finger-draws');
    W.localStorage.removeItem('wc:pen-seen');
  }
  if (shell) await shell.restore();
});

// ── helpers ────────────────────────────────────────────────────────────────
const rootOf = (id) => M.itemEl(W.document, id).el.shadowRoot;
const lead = (id) => rootOf(id).querySelector('p.lead');
const goBtn = (id) => rootOf(id).querySelector('button.go');
const layer = () => W.document.getElementById('el-layer');
const markersFor = (id) => [...layer().querySelectorAll('.el-marker.pin-marker')].filter((m) => (m.dataset.elIds || '').split(' ').includes(id));
const pinPop = () => W.document.querySelector('.pin-pop');
const armedType = () => { const a = ov.armed(); return a ? a.type : null; };
async function settle(ms = 100) { for (let i = 0; i < ms / 20; i++) await shell.tick(20); }
async function drawnUntil(pred, what) {
  await waitUntil(async () => { await settle(40); flush(); return pred(); }, { timeout: 4000, what });
}
const placedAt = (m, p) => m && m.style.display === '' && m.style.left === `${p.left}px` && m.style.top === `${p.top}px`;
// A pin the daemon holds on an element of a pane: the engine's record as its
// anchor, as a pin dropped through this chrome is.
function pinOn(id, mount, el, extra = {}) {
  const anchor = anchors.record(rootOf(mount), el, { mount });
  return { id, v: 1, seq: 1, type: 'comment', text: `${id} text`, shared: true, replies: [], anchor,
    locator: { mount, selector: 'p.lead', text: el.textContent.trim(), ordinal: 0 }, ...extra };
}
async function setLive(pins) {
  live.clear();
  for (const p of pins) live.set(p.id, p);
  await shell.frame({ type: 'element:comment', elements: pins.map(({ record, ...p }) => p) });
}
function pe(el, type, pointerType, pointerId, extra = {}) {
  const ev = new W.PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, pointerType, pointerId, isPrimary: true, clientX: 100, clientY: 100,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, ...extra,
  });
  el.dispatchEvent(ev);
  return ev;
}
// A whole gesture: down, [a move of `move` px], up, then the click a pointer made.
function gesture(el, pointerType, { pointerId = 1, move = 0 } = {}) {
  const down = pe(el, 'pointerdown', pointerType, pointerId);
  const moved = move ? pe(el, 'pointermove', pointerType, pointerId, { clientX: 100 + move }) : null;
  pe(el, 'pointerup', pointerType, pointerId, { clientX: 100 + move });
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType, pointerId, clientX: 100 + move, clientY: 100 }));
  return { down, moved };
}
function closeComposer() {
  const pop = pinPop();
  if (pop && pop.querySelector('.pin-cancel')) shell.click(pop.querySelector('.pin-cancel'));
  comments.closePinPop();
}

// ── the source ─────────────────────────────────────────────────────────────
test('comments.js holds no resolver, no pin layer, no fetch( and no timer; the type registers through element-types.js', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/comments.js'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(/, 'every request goes through http.js');
  assert.doesNotMatch(src, /resolveAnchorEl/, 'the overlay resolves every anchor');
  assert.doesNotMatch(src, /pin-layer|getBoundingClientRect/, 'no layer and no box reads of its own');
  assert.doesNotMatch(src, /\bset(Interval|Timeout)\(|requestAnimationFrame/, 'no timer of any kind');
  assert.doesNotMatch(src, /\bregisterType\(/, 'never the overlay\'s registerType directly');
  assert.match(src, /registerElementType\(TYPE, \{ draw, create, input: 'taps', sourceGlyph: SOURCE_GLYPH \}\)/);
  assert.doesNotMatch(src, /targets: 'panes'/, 'the comment keeps the default targets (F.3)');
  assert.match(src, /registerQueueCard\(TYPE,/);
  assert.equal(W.document.getElementById('pin-layer'), null, 'no #pin-layer in the page');
  assert.equal(ov.inputKindOf('comment'), 'taps', 'the overlay holds the comment type, a taps tool');
});

// ── re-placement ───────────────────────────────────────────────────────────
test('a pin survives a pane drag, a resize, a run change and a pane-history restore — re-placed by the overlay, no interval armed', async () => {
  const intervals = shell.intervals().length;
  POS['lead-p1'] = box(100, 120);
  const pin = pinOn('c1', 'p1', lead('p1'));
  await setLive([pin]);
  await drawnUntil(() => placedAt(markersFor('c1')[0], POS['lead-p1']), 'the pin drawn at its anchor');
  const marker = markersFor('c1')[0];

  // A drag of the pane by its header (mounts.js attachDrag): it moves.
  POS['lead-p1'] = box(300, 140);
  const header = M.itemEl(W.document, 'p1').el.closest('.pane').querySelector('.pane-header');
  pe(header, 'pointerdown', 'mouse', 9);
  pe(header, 'pointermove', 'mouse', 9, { clientX: 140 });
  pe(header, 'pointerup', 'mouse', 9, { clientX: 140 });
  await drawnUntil(() => placedAt(markersFor('c1')[0], POS['lead-p1']), 'the marker re-placed after the drag');
  assert.equal(markersFor('c1')[0], marker, 'moved, not rebuilt');

  // A resize (the pane's colSpan and rows, as another viewer's pane:state).
  POS['lead-p1'] = box(320, 160);
  await shell.frame({ type: 'pane:state', id: 'p1', pane_state: { colSpan: 6, rows: 6 } });
  await drawnUntil(() => placedAt(markersFor('c1')[0], POS['lead-p1']), 'the marker re-placed after the resize');

  // A run change: a markdown item inserted between the two panes.
  POS['lead-p1'] = box(340, 220);
  await shell.frame({ type: 'markdown', id: 'md-cut', text: '## Between', owner: 'claude', gen: 1,
    order: ['p1', 'md-cut', 'p2', 'f6-s14'], claude_order: ['p1', 'md-cut', 'p2', 'f6-s14'] });
  assert.ok(W.document.querySelector('[data-md-id="md-cut"]'), 'precondition: the run was cut');
  await drawnUntil(() => placedAt(markersFor('c1')[0], POS['lead-p1']), 'the marker re-placed after the run change');

  // A pane-history restore: the pane re-rendered from an older version.
  POS['lead-p1'] = box(360, 260);
  await shell.frame({ type: 'render', ...P1, source: 'history', html: P1.html.replace('more of p1', 'older more of p1') });
  await drawnUntil(() => placedAt(markersFor('c1')[0], POS['lead-p1']), 'the marker drawn on the restored pane');

  assert.equal(shell.intervals().length, intervals, 'no interval armed along the way');
  await shell.frame({ type: 'markdown:remove', id: 'md-cut', order: ['p1', 'p2', 'f6-s14'], claude_order: ['p1', 'p2', 'f6-s14'] });
});

// ── the tool ───────────────────────────────────────────────────────────────
test('the comment slot and C arm and disarm the comment tool in the overlay\'s one armed state; body.pin-mode follows it, whoever arms it', async () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/comments.js'), 'utf8');
  assert.doesNotMatch(src, /let pinMode\b/, 'no second state');
  // ✎ (#btn-pin-mode) is retired onto the toolbar's comment slot (U338).
  assert.equal(W.document.getElementById('btn-pin-mode'), null, 'no ✎ button');
  const btn = W.document.querySelector('#tb-slots .tb-slot[data-type="comment"]');
  assert.ok(btn, 'the toolbar draws a comment slot');
  const on = () => W.document.body.classList.contains('pin-mode');
  ov.setArmed(null);
  btn.click();
  assert.equal(armedType(), 'comment', 'the slot arms comment');
  assert.ok(on() && btn.classList.contains('armed'));
  shell.key('c');
  assert.equal(armedType(), null, 'C puts it down (the armed slot pressed again opens its settings instead)');
  assert.ok(!on() && !btn.classList.contains('armed'));
  shell.key('c');
  assert.equal(armedType(), 'comment', 'C arms comment');
  assert.ok(on());
  shell.key('c');
  assert.equal(armedType(), null);
  // The one state, whoever writes it: the toolbar's arm, another tool.
  ov.setArmed('comment');
  assert.ok(on(), 'armed through the overlay: pin mode shows');
  ov.setArmed('highlight');
  assert.ok(!on(), 'another tool armed: pin mode is off');
  comments.setPinMode(false);
  assert.equal(armedType(), 'highlight', 'setPinMode(false) puts down only the comment tool');
  ov.setArmed(null);
  comments.setPinMode(true);
  assert.equal(armedType(), 'comment');
  shell.key('Escape');
  assert.equal(armedType(), null, 'Escape leaves pin mode, as before');
});

test('pen and mouse drop pins; a pen on a pane\'s button places one and the button never hears it', async () => {
  ov.setArmed('comment');
  try {
    W.__goClicks.length = 0;
    gesture(goBtn('p2'), 'pen', { pointerId: 4 });
    assert.ok(pinPop() && pinPop().querySelector('.pin-text'), 'the pen opened the composer');
    assert.deepEqual(W.__goClicks, [], 'the button did not run');
    assert.match(pinPop().querySelector('.pin-anchor').textContent, /^p2 › Go$/);
    closeComposer();
    gesture(lead('p2'), 'mouse', { pointerId: 5 });
    assert.ok(pinPop() && pinPop().querySelector('.pin-text'), 'the mouse opened the composer');
    assert.match(pinPop().querySelector('.pin-anchor').textContent, /^p2 › lead of p2$/);
    closeComposer();
  } finally { ov.setArmed(null); }
});

test('a finger tap on static content drops a pin; on a pane\'s button it runs the button with comment still armed; a drag drops none and keeps its default', async () => {
  IM.setFingerDraws('off');
  ov.setArmed('comment');
  try {
    gesture(lead('p2'), 'touch', { pointerId: 11 });
    assert.ok(pinPop() && pinPop().querySelector('.pin-text'), 'a static tap opened the composer');
    closeComposer();
    W.__goClicks.length = 0;
    gesture(goBtn('p2'), 'touch', { pointerId: 12 });
    assert.deepEqual(W.__goClicks, ['p2'], 'the button ran (K.2-9)');
    assert.equal(pinPop(), null, 'and no pin');
    assert.equal(armedType(), 'comment', 'the tool stays armed');
    const { down, moved } = gesture(lead('p2'), 'touch', { pointerId: 13, move: TAP_SLOP + 20 });
    assert.equal(pinPop(), null, 'a finger drag drops no pin');
    assert.equal(down.defaultPrevented, false, 'its pointerdown keeps the browser\'s default (the page pans)');
    assert.equal(moved.defaultPrevented, false, 'and so does its move');
  } finally { ov.setArmed(null); W.localStorage.removeItem('wc:finger-draws'); }
});

// F.3 (RULED M3 (a), the ruled inversion of K.2-78's 'panes'): the comment's
// targets are the default 'items' — a comment-armed click on a markdown link
// pins and the link does not follow (M3's trade-off); the chrome inside #main
// (a pane's header button, a gap in the well) still passes through with the
// tool armed (K.2-78 (c), the overlay's taps arm). Highlight-armed, the link
// click is the tool's, as before.
test('a comment-armed click on a markdown link pins (the link does not follow); a pane header button and a gap in #main pass through with the tool armed; with highlight armed the link click is the tool\'s', async () => {
  await shell.frame({ type: 'markdown', id: 'md-link', text: 'See [the docs](https://example.com/docs).', owner: 'claude', gen: 1,
    order: ['p1', 'p2', 'f6-s14', 'md-link'], claude_order: ['p1', 'p2', 'f6-s14', 'md-link'] });
  const link = W.document.querySelector('[data-md-id="md-link"] a');
  assert.ok(link, 'precondition: the markdown item drew its link');
  const ET = await shell.importApp('element-types.js');
  assert.deepEqual(['comment', 'highlight', 'box-grab'].map((x) => ET.targetsOf(x)), ['items', 'items', 'items'], 'the registrations\' targets');
  assert.throws(() => ET.registerElementType('t-bad', { draw() {}, targets: 'everything' }), /targets must be one of items, panes/);
  const header = M.itemEl(W.document, 'p1').el.closest('.pane').querySelector('.pane-header');
  const headerBtn = header.querySelector('button');
  assert.ok(headerBtn, 'precondition: the pane header has a button');
  const well = W.document.getElementById('main');
  const heard = [];
  // The page's own listeners: they hear what the overlay let through. The
  // document's (bubbling) keeps jsdom from navigating; the header's (capturing,
  // so after the overlay's capture on #main) keeps the pin button from acting.
  const nameOf = (t) => (t === link ? 'link' : t === well ? 'well' : 'header');
  const onDoc = (e) => {
    if (e.target !== link && e.target !== well) return;
    heard.push(`${e.type}:${nameOf(e.target)}`);
    if (e.type === 'click') e.preventDefault();
  };
  const onHeader = (e) => {
    if (e.target !== headerBtn) return;
    heard.push(`${e.type}:header`);
    e.stopPropagation();
  };
  W.document.addEventListener('click', onDoc);
  W.document.addEventListener('pointerdown', onDoc);
  header.addEventListener('click', onHeader, true);
  header.addEventListener('pointerdown', onHeader, true);
  try {
    ov.setArmed('comment');
    const { down } = gesture(link, 'mouse', { pointerId: 31 });
    assert.equal(down.defaultPrevented, true, 'the tool took the press');
    assert.ok(pinPop() && pinPop().querySelector('.pin-text'), 'the link click pinned: the composer opened');
    assert.match(pinPop().querySelector('.pin-anchor').textContent, /^md-link › See the docs\.$/);
    closeComposer();
    assert.equal(armedType(), 'comment', 'the tool stays armed');
    // The chrome inside #main passes through (K.2-78 (c)): the header button
    // and a gap in the well are the page's.
    heard.length = 0;
    const hb = gesture(headerBtn, 'mouse', { pointerId: 33 });
    assert.deepEqual(heard, ['pointerdown:header', 'click:header'], 'the page heard the header button');
    assert.equal(hb.down.defaultPrevented, false);
    assert.equal(pinPop(), null, 'no pin on the header button');
    heard.length = 0;
    const gap = gesture(well, 'mouse', { pointerId: 34 });
    assert.deepEqual(heard, ['pointerdown:well', 'click:well'], 'the page heard the gap in #main');
    assert.equal(gap.down.defaultPrevented, false);
    assert.equal(pinPop(), null, 'no pin on the gap');
    // A lone click (a mouse's, whose press the well never heard) takes the
    // same targets check: on the gap it is the page's, on the link the tool's.
    heard.length = 0;
    well.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 77, clientX: 100, clientY: 100 }));
    assert.deepEqual(heard, ['click:well'], 'the page heard the lone click on the gap');
    assert.equal(pinPop(), null, 'no pin dropped by the lone click');
    heard.length = 0;
    const lone = new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId: 78, clientX: 100, clientY: 100 });
    link.dispatchEvent(lone);
    assert.deepEqual(heard, [], 'the lone click on the link is the tool\'s');
    assert.equal(lone.defaultPrevented, true, 'the link does not follow');
    assert.ok(pinPop() && pinPop().querySelector('.pin-text'), 'the lone click pinned');
    closeComposer();
    assert.equal(armedType(), 'comment', 'still armed');
    heard.length = 0;
    ov.setArmed('highlight');
    gesture(link, 'mouse', { pointerId: 32 });
    assert.deepEqual(heard, [], 'the highlight\'s targets take the markdown item: the page heard nothing');
  } finally {
    ov.setArmed(null);
    comments.closePinPop();
    W.document.removeEventListener('click', onDoc);
    W.document.removeEventListener('pointerdown', onDoc);
    header.removeEventListener('click', onHeader, true);
    header.removeEventListener('pointerdown', onHeader, true);
    await shell.frame({ type: 'markdown:remove', id: 'md-link', order: ['p1', 'p2', 'f6-s14'], claude_order: ['p1', 'p2', 'f6-s14'] });
  }
});

test('pin creation posts {type, anchor: the engine record, locator, payload, device} through http.js', async () => {
  const deviceKind = (await shell.importApp('viewport.js')).deviceKind;
  ov.setArmed('comment');
  const n = posts.length;
  gesture(rootOf('f6-s14').querySelector('#t'), 'mouse', { pointerId: 21 });
  const pop = pinPop();
  assert.ok(pop, 'the composer opened');
  pop.querySelector('.pin-text').value = 'is this right?';
  shell.click(pop.querySelector('.pin-save'));
  await waitUntil(() => posts.length === n + 1, { what: 'the POST' });
  assert.equal(armedType(), null, 'Pin puts the tool down, as before');
  const body = posts.at(-1);
  assert.deepEqual(Object.keys(body).sort(), ['anchor', 'device', 'locator', 'payload', 'type']);
  assert.equal(body.type, 'comment');
  assert.equal(body.device, deviceKind(), 'the device claim (http.js)');
  assert.deepEqual(body.payload, { text: 'is this right?', shared: true });
  assert.equal(body.anchor.v, 1);
  assert.equal(body.anchor.kind, 'element', 'the engine\'s own record');
  assert.equal(body.anchor.mount, 'f6-s14');
  assert.deepEqual(body.anchor, anchors.record(rootOf('f6-s14'), rootOf('f6-s14').querySelector('#t'), { mount: 'f6-s14' }));
  assert.deepEqual(body.locator, { mount: 'f6-s14', selector: 'h3', text: 'Timeline', ordinal: 0 }, 'and the 0.8.5 locator beside it');
  const call = shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements').at(-1);
  assert.equal(call.headers['Content-Type'], 'application/json', 'sent as http.js sends a JSON body');
  // The answer is drawn at once.
  const id = [...live.values()].at(-1).id;
  await drawnUntil(() => markersFor(id).length === 1, 'the new pin drawn');
  captured.body = body;
});

// ── previews ───────────────────────────────────────────────────────────────
test('a previewed older node draws its pins read-only: no create with the tool armed; no reply, share or delete — the hint', async () => {
  const P1n2 = PANE('p1');
  const old = pinOn('c50', 'p1', lead('p1'), { text: 'an older note' });
  POS['lead-p1'] = box(140, 180);
  previewPins = [old];
  shell.setRoutes({ '/api/graph/node/n2': { id: 'n2', mounts: [P1n2], store: {}, elements: [],
    lean_elements: [{ id: 'c50', v: 1, type: 'comment', schema: 'comment@1', anchor: old.anchor, shared: true, replies: 0, answered: false }] } });
  try {
    await topbar.previewNode('n2');
    await waitUntil(() => shell.calls.some((c) => c.url === '/api/elements?type=comment&node=n2'), { what: 'the node read' });
    await drawnUntil(() => placedAt(markersFor('c50')[0], POS['lead-p1']), 'the preview\'s pin drawn');
    // create refused: armed or not, nothing is posted.
    comments.setPinMode(true);
    assert.equal(armedType(), null, 'the comment tool is not armed on a preview (tools.js refuses)');
    ov.setArmed('comment');
    const n = posts.length;
    gesture(lead('p1'), 'mouse', { pointerId: 31 });
    await settle();
    assert.equal(pinPop(), null, 'no composer on a preview');
    assert.equal(posts.length, n, 'no POST');
    ov.setArmed(null);
    // The thread opens read-only.
    markersFor('c50')[0].dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
    const thread = pinPop();
    assert.ok(thread && thread.classList.contains('pin-thread'), 'the thread opened');
    assert.ok(thread.classList.contains('pin-readonly'));
    assert.equal(thread.querySelector('.pin-body').textContent, 'an older note');
    assert.equal(thread.querySelector('.pin-reply-text, .pin-del, .pin-share-cb, .pin-reply-send'), null, 'no reply, share or delete');
    assert.equal(thread.querySelector('.pin-ro-hint').textContent, topbar.READONLY_HINT);
    comments.closePinPop();
  } finally {
    ov.setArmed(null);
    shell.setRoutes({});
    topbar.leavePreview({ restoreSnapshot: true });
    previewPins = [];
  }
  await drawnUntil(() => markersFor('c50').length === 0 && markersFor('c1').length === 1, 'the live pins again');
});

// ── comments on markdown (F.3, RULED M3 (a)) ───────────────────────────────
const MD_ORDER = ['p1', 'p2', 'f6-s14', 'md-sec'];
const mdItem = () => W.document.querySelector('[data-md-id="md-sec"]');
async function putMd(text) {
  await shell.frame({ type: 'markdown', id: 'md-sec', text, owner: 'claude', gen: 1, order: MD_ORDER, claude_order: MD_ORDER });
  assert.ok(mdItem(), 'precondition: the markdown item is drawn');
}
async function dropMd() {
  await shell.frame({ type: 'markdown:remove', id: 'md-sec', order: ['p1', 'p2', 'f6-s14'], claude_order: ['p1', 'p2', 'f6-s14'] });
}
// Tap `el` with the comment tool armed and Pin what the composer holds: the
// body the chrome posted, or null when no composer opened.
async function pinTap(el, pointerId) {
  ov.setArmed('comment');
  const n = posts.length;
  try {
    gesture(el, 'mouse', { pointerId });
    const pop = pinPop();
    if (!pop || !pop.querySelector('.pin-text')) return null;
    pop.querySelector('.pin-text').value = 'about this';
    shell.click(pop.querySelector('.pin-save'));
    await waitUntil(() => posts.length === n + 1, { what: 'the POST' });
    return posts.at(-1);
  } finally { ov.setArmed(null); comments.closePinPop(); }
}

test('a heading tap records a source anchor over the heading, section = the heading; a prose tap under it records the paragraph with that section', async () => {
  await putMd('Lead line above the section.\n\n## Release plan\n\nShip the build on Friday after the review.\n\n## Rollback\n\nRevert the tag if the smoke test fails.');
  try {
    const h2 = mdItem().querySelector('h2');
    const body = await pinTap(h2, 41);
    assert.ok(body, 'the heading tap opened the composer and posted');
    assert.equal(body.anchor.kind, 'source', 'a source anchor');
    assert.equal(body.anchor.md, 'md-sec');
    assert.equal(body.anchor.quote.exact, 'Release plan', 'over the heading\'s text');
    assert.equal(body.anchor.slug, 'release-plan');
    assert.deepEqual(body.locator, { mount: 'md-sec', selector: 'h2', text: 'Release plan', ordinal: 0, section: 'Release plan' });
    const p = mdItem().querySelectorAll('p')[1];
    const prose = await pinTap(p, 42);
    assert.ok(prose, 'the prose tap posted');
    assert.equal(prose.anchor.kind, 'source');
    assert.equal(prose.anchor.quote.exact, 'Ship the build on Friday after the review.');
    assert.deepEqual(prose.locator, { mount: 'md-sec', selector: 'p', text: 'Ship the build on Friday after the review.', ordinal: 1, section: 'Release plan' });
    // Above the item's first heading: the nearest heading of an earlier item,
    // here none (no earlier markdown item) — no section.
    const lead0 = await pinTap(mdItem().querySelector('p'), 43);
    assert.equal(lead0.anchor.quote.exact, 'Lead line above the section.');
    assert.equal(lead0.anchor.slug, null);
    assert.equal(Object.prototype.hasOwnProperty.call(lead0.locator, 'section'), false, 'no heading above it anywhere');
    // Prose under the item's second heading: that heading (the record's slug),
    // not the item's first one.
    const later = await pinTap(mdItem().querySelectorAll('p')[2], 47);
    assert.equal(later.anchor.slug, 'rollback');
    assert.equal(later.locator.section, 'Rollback', 'the heading the prose is under');
  } finally { await dropMd(); }
});

test('a paragraph longer than quote_max records a quote of at most quote_max; a block whose source span is over the cap falls back to its first 240 characters; a gap pins nothing', async () => {
  const max = anchors.CONFIG.quote_max;
  const long = 'word '.repeat(Math.ceil((max + 500) / 5)).trim();
  // Rendered under the cap, but its link target makes the source span over it.
  const plain = 'x'.repeat(250);
  const tail = 'y'.repeat(200);
  const target = 'https://example.com/' + 'a'.repeat(max);
  await putMd(`## Long\n\n${long}\n\n${plain} [link](${target}) ${tail}`);
  try {
    const ps = mdItem().querySelectorAll('p');
    const clamped = await pinTap(ps[0], 44);
    assert.ok(clamped, 'the long paragraph pinned');
    assert.ok(clamped.anchor.quote.exact.length <= max, `the quote is at most quote_max (${clamped.anchor.quote.exact.length})`);
    assert.ok(clamped.anchor.quote.exact.length > max - 10, 'clamped at the cap, not short of it');
    assert.equal(clamped.locator.section, 'Long');
    assert.ok(ps[1].textContent.length < max, 'precondition: the linked block is under the cap in rendered text');
    const fell = await pinTap(ps[1], 45);
    assert.ok(fell, 'the linked block pinned');
    assert.equal(fell.anchor.quote.exact, plain.slice(0, comments.SOURCE_RETRY_CHARS), 'its first 240 rendered characters');
    // A tap on the item's own gap (the .md-block between its blocks): nothing.
    const n = posts.length;
    assert.equal(await pinTap(mdItem(), 46), null, 'no composer on a gap');
    assert.equal(posts.length, n, 'nothing posted');
    // and the gap is the page's (K.2-78 (c)): the overlay lets the press and
    // the click through with the tool armed.
    const heard = [];
    const onDoc = (e) => { if (e.target === mdItem()) heard.push(e.type); };
    W.document.addEventListener('pointerdown', onDoc);
    W.document.addEventListener('click', onDoc);
    ov.setArmed('comment');
    try {
      const { down } = gesture(mdItem(), 'mouse', { pointerId: 48 });
      assert.deepEqual(heard, ['pointerdown', 'click'], 'the page heard the gap');
      assert.equal(down.defaultPrevented, false);
    } finally {
      ov.setArmed(null);
      W.document.removeEventListener('pointerdown', onDoc);
      W.document.removeEventListener('click', onDoc);
    }
  } finally { await dropMd(); }
});

test('the md pin\'s marker sits in the item\'s left margin inside the well\'s clip; a pane pin\'s marker is placed as before', async () => {
  await putMd('Intro text here.\n\n## Margin heading\n\nBody text under it.');
  const well = W.document.getElementById('main');
  try {
    const item = mdItem();
    const h2 = item.querySelector('h2');
    const text = item._wcText;
    const range = W.document.createRange();
    range.selectNodeContents(h2);
    const { sourceMap } = await shell.importApp('markdown.js');
    const rec = anchors.recordSource(item, range, sourceMap(text), text, { md: 'md-sec' });
    assert.ok(rec, 'precondition: a source record');
    item.dataset.pin = 'md-item';
    h2.dataset.pin = 'md-h';
    POS['md-item'] = box(60, 260);
    POS['md-h'] = box(100, 300);
    const pane = pinOn('c80', 'p1', lead('p1'));
    POS['lead-p1'] = box(400, 120);
    await setLive([
      { id: 'c81', v: 1, seq: 1, type: 'comment', text: 'md pin', shared: true, replies: [], anchor: rec,
        locator: { mount: 'md-sec', selector: 'h2', text: 'Margin heading', ordinal: 0, section: 'Margin heading' } },
      pane,
    ]);
    const m = () => markersFor('c81')[0];
    await drawnUntil(() => m() && m().style.display === '' && m().style.left === '60px', 'the md pin drawn in the margin');
    const glyph = comments.SOURCE_GLYPH;
    assert.equal(m().style.left, '60px', 'anchored at the item\'s left edge');
    assert.equal(m().style.top, '300px', 'level with the heading\'s line');
    assert.equal(m().style.transform, `translate(${glyph.dx}px, ${glyph.dy}px)`, 'the margin glyph\'s offsets');
    assert.ok(60 + glyph.dx + 26 <= 100, 'left of the item\'s text');
    assert.equal(m().style.clipPath, '', 'wholly inside the clip');
    assert.ok(m().classList.contains('el-hit'));
    // The pane pin: as today (the glyph's own offsets, at its element).
    const pm = markersFor('c80')[0];
    assert.ok(placedAt(pm, POS['lead-p1']), 'the pane pin at its element');
    assert.equal(pm.style.transform, 'translate(-13px, -26px)', 'with the type\'s glyph');
    // A narrower well: the glyph is inset at the clip, never drawn outside it.
    well.dataset.pin = 'well';
    POS.well = { left: 45, top: 0, width: 979, height: 768, right: 1024, bottom: 768, x: 45, y: 0 };
    ov.requestDraw();
    await drawnUntil(() => m().style.clipPath !== '', 'the glyph inset at the well');
    assert.equal(m().style.clipPath, `inset(0px 0px 0px ${45 - (60 + glyph.dx)}px)`, 'the part left of the well is clipped');
    assert.equal(m().style.display, '');
  } finally {
    delete well.dataset.pin;
    delete POS.well;
    await setLive([]);
    await dropMd();
    ov.requestDraw();
    flush();
  }
});

test('Show on page for an md pin with no drawn marker reaches its markdown item', async () => {
  await putMd('## Somewhere\n\nA line.');
  try {
    const scrolls = shell.scrolls.length;
    assert.equal(comments.showOnPage('c-none', 'md-sec'), true, 'found');
    assert.equal(shell.scrolls.length, scrolls + 1, 'scrolled');
    assert.equal(shell.scrolls.at(-1).el, mdItem(), 'to the item');
    assert.ok(mdItem().classList.contains('md-flash'), 'and flashed it');
  } finally { await dropMd(); }
});

// ── migrated anchors and carried guesses ───────────────────────────────────
test('a migrated comment draws at its converted pin-locator@1 anchor; a K-10 carried guess draws at its guess, and its click is the re-anchor seam', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-u327b-v3-'));
  let g;
  try { g = v3Graph(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const n6 = g.nodes.find((n) => n.id === 'n6');
  const c1 = n6.comments.find((c) => c.id === 'c1');
  const ma = n6.mounts.find((m) => m.id === 'm-a');
  assert.deepEqual(Object.keys(c1.anchor).sort(), ['mount', 'ordinal', 'selector', 'text'], 'a 0.8.5 locator');
  const converted = convertAnchor(c1.anchor);
  assert.equal(converted.form, 'pin-locator@1');
  // The guess: the same locator whose text no element carries now (K-10).
  const guessed = convertAnchor({ ...c1.anchor, text: 'a line that moved away' });
  // A reset carrying the lean rows, as the daemon projects a migrated node's
  // pins; its read serves each pin's 0.8.5 locator as `anchor` and the
  // converted one as `record`.
  live.clear();
  live.set('c1', { ...c1, v: 1, type: 'comment', record: converted });
  live.set('c9', { ...c1, id: 'c9', v: 1, type: 'comment', anchor: { ...c1.anchor, text: 'a line that moved away' }, record: guessed });
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: [P1, P2, S14, { ...ma, target: 'main', params: {} }] }), type: 'reset',
    elements: [
      { id: 'c1', v: 1, type: 'comment', schema: 'comment@1', anchor: converted, shared: true, replies: 0, answered: false },
      { id: 'c9', v: 1, type: 'comment', schema: 'comment@1', anchor: guessed, shared: true, replies: 0, answered: false },
    ] });
  const lp = rootOf('m-a').querySelector('p.lead');
  lp.dataset.pin = 'lead-m-a';
  POS['lead-m-a'] = box(410, 300);
  ov.requestDraw();
  await drawnUntil(() => placedAt(markersFor('c1')[0], POS['lead-m-a']) && markersFor('c9').length === 1, 'the migrated pin and the guess');
  assert.ok(markersFor('c1')[0].classList.contains('el-hit'), 'the converted anchor resolves to its element');
  const guess = markersFor('c9')[0];
  assert.ok(guess.classList.contains('el-guess') && guess.classList.contains('pin-marker'), 'the carried guess drawn as a guess');
  assert.ok(placedAt(guess, POS['lead-m-a']), 'at its guess');
  assert.ok(ov.orphans().some((o) => o.id === 'c9' && o.guess), 'and listed for re-anchoring');
  const seen = [];
  const off = bus.on('overlay:guess', (d) => seen.push(d));
  try {
    guess.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
    assert.deepEqual(seen.map((d) => d.id), ['c9'], 'the click is the overlay\'s re-anchor seam');
    assert.ok(!pinPop() || !pinPop().classList.contains('pin-thread'), 'not the thread');
  } finally { off(); }
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});

// ── Set active, Branch ─────────────────────────────────────────────────────
test('markers are fresh after Set active and Branch — the reset\'s lean rows — with no poll', async () => {
  const intervals = shell.intervals().length;
  // Set active: a reset onto a node whose pin sits on p2.
  const onP2 = pinOn('c70', 'p2', lead('p2'));
  live.clear();
  live.set('c70', { ...onP2, record: onP2.anchor });
  POS['lead-p2'] = box(220, 330);
  const gets = () => shell.calls.filter((c) => c.method === 'GET' && c.url === '/api/elements?type=comment').length;
  const g0 = gets();
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: [P1, P2, S14] }), type: 'reset',
    elements: [{ id: 'c70', v: 1, type: 'comment', anchor: onP2.anchor, shared: true, replies: 0, answered: false }] });
  await drawnUntil(() => placedAt(markersFor('c70')[0], POS['lead-p2']), 'the active node\'s pin');
  assert.equal(markersFor('c1').length, 0, 'the old surface\'s pin is gone');
  assert.equal(gets(), g0 + 1, 'one read for the threads, no more');
  // Branch: another reset, the pin's thread answered there.
  const answered = { ...onP2, v: 2, replies: [{ author: 'claude', text: 'yes' }] };
  live.set('c70', { ...answered, record: onP2.anchor });
  await shell.frame({ ...helloFrame({ active: 'n1', mounts: [P1, P2, S14] }), type: 'reset',
    elements: [{ id: 'c70', v: 2, type: 'comment', anchor: onP2.anchor, shared: true, replies: 1, answered: true }] });
  await drawnUntil(() => markersFor('c70')[0] && markersFor('c70')[0].classList.contains('replied'), 'the branch\'s answered pin');
  assert.equal(shell.intervals().length, intervals, 'no poll');
});

// ── the queue card ─────────────────────────────────────────────────────────
test('a shared pin\'s queue item is drawn through the card registered for \'comment\'; its removal is the rail\'s own', async () => {
  const railRow = (id) => W.document.querySelector(`.rail-item[data-id="${id}"]`);
  const n0 = shell.calls.length;
  await shell.frame({ type: 'queue', op: 'add', item: { id: 'q-c70', kind: 'comment', comment_id: 'c70', source: 'browser',
    why_wake: 'comment pinned for Claude', summary: 'p2 · "c70 text"', origin_mount: 'p2', staged: true } });
  await waitUntil(() => railRow('q-c70') && railRow('q-c70').querySelector('.qi-card'), { what: 'the card' });
  const slot = railRow('q-c70').querySelector('.qi-card');
  assert.equal(slot.dataset.type, 'comment');
  assert.equal(slot.querySelector('.cm-card-where').textContent, 'p2 › lead of p2', 'where the pin is');
  assert.equal(slot.querySelector('.cm-card-replies').textContent, '1 reply', 'its reply count');
  assert.equal(railRow('q-c70').querySelector('.qi-summary'), null, 'in place of the generic summary');
  assert.equal(shell.calls.slice(n0).filter((c) => c.method !== 'GET').length, 0, 'drawing the card wrote nothing');
  const scrolls = shell.scrolls.length;
  slot.querySelector('.cm-card-show').click();
  assert.equal(shell.scrolls.length, scrolls + 1, 'Show on page scrolled to the pin');
  // The engine owns the item: the rail's ⟲, nothing of the card's.
  const n1 = shell.calls.length;
  railRow('q-c70').querySelector('.qi-revert').click();
  await shell.tick();
  const writes = shell.calls.slice(n1).filter((c) => c.method !== 'GET');
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url}`), ['DELETE /api/queue/q-c70?revert=1'], 'the rail\'s own removal, alone');
  assert.equal(railRow('q-c70'), null);
});

// ── get_comments, replayed against a real daemon ───────────────────────────
// Last: the shell's globals go back first (a daemon's timers need Node's own).
const captured = { body: null };
async function replayed(t) {
  assert.ok(captured.body, 'precondition: the chrome posted a pin above');
  ov.setArmed(null);
  W.localStorage.removeItem('wc:finger-draws');
  W.localStorage.removeItem('wc:pen-seen');
  await shell.restore();
  const mcpClientPath = require.resolve('../lib/mcp/client.js');
  const toolPath = require.resolve('../lib/mcp/tools/get_comments.js');
  const saved = require.cache[mcpClientPath];
  let API = null;
  require.cache[mcpClientPath] = {
    id: mcpClientPath, filename: mcpClientPath, loaded: true,
    exports: { get: async (p) => { const r = await API.get(p); return r.json; }, post: async (p, b) => { const r = await API.post(p, b); return r.json; } },
  };
  delete require.cache[toolPath];
  t.after(() => {
    if (saved) require.cache[mcpClientPath] = saved; else delete require.cache[mcpClientPath];
    delete require.cache[toolPath];
  });
  const s = await withServer(t);
  API = s.api;
  await s.api.post('/api/render', { id: S14.id, html: S14.html });
  const r = await s.api.post('/api/elements', captured.body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const out = await require('../lib/mcp/tools/get_comments.js').handler({});
  return out.comments[0];
}
const goldenAdd = GOLDEN.find((x) => x.step === 'add').get_comments.comments[0];

test('get_comments (the real handler) on the chrome\'s pin: the golden\'s anchor_label, and the 0.8.5 locator in the golden anchor\'s shape', async (t) => {
  const c = await replayed(t);
  assert.equal(c.anchor_label, goldenAdd.anchor_label, 'anchor_label keeps its value');
  assert.equal(c.text, goldenAdd.text);
  assert.equal(c.shared, goldenAdd.shared);
  assert.deepEqual(Object.keys(c.anchor).sort(), Object.keys(goldenAdd.anchor).sort(), 'the anchor has the golden anchor\'s fields');
  assert.equal(c.anchor.mount, goldenAdd.anchor.mount);
  assert.equal(c.anchor.text, goldenAdd.anchor.text);
  captured.comment = c;
});

test('get_comments\' `anchor` is the 0.8.5 locator the chrome posted, `record` the engine record, and no `locator` key rides beside them', () => {
  const c = captured.comment;
  assert.ok(c, 'precondition: the replay above');
  assert.deepEqual(c.anchor, captured.body.locator, 'the served anchor is the posted locator (S-14)');
  assert.deepEqual(c.record, captured.body.anchor, 'the engine record is served as `record`');
  assert.equal(Object.prototype.hasOwnProperty.call(c, 'locator'), false, 'the locator is served once, as `anchor`');
  assert.equal(Object.prototype.hasOwnProperty.call(c.anchor, 'form'), false, 'not a converted record');
});

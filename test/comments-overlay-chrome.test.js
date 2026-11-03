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
// A Range's laid-out first line where a test lays text out (the word pins'
// layout below, U588); null elsewhere.
let rangeRectHook = null;
function rectOf(x) {
  const key = x && x.dataset && x.dataset.pin;
  if (key && POS[key]) return POS[key];
  // A Range (a markdown pin's source answer): the box of the nearest element
  // around its start that names a position.
  const sc = x && x.startContainer;
  const laid = sc && rangeRectHook ? rangeRectHook(x) : null;
  if (laid) return laid;
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
    assert.equal(thread.querySelector('.pin-send'), null, 'no Send to Claude in a preview (F.5, D2)');
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

// ── the chain (F.6, U406; RULED L7 (a), O5 (a) "chain") ─────────────────────
// No control: the comment's tap asks the overlay for the live elements under
// the press (overlay.js elementsAt), smallest first, and posts their ids as
// payload.chain; the composer's, the thread's and the marker title's anchor
// line name them; a member gone from the page reads "a removed …".
function tapAt(el, x, y, pointerId) {
  pe(el, 'pointerdown', 'mouse', pointerId, { clientX: x, clientY: y });
  pe(el, 'pointerup', 'mouse', pointerId, { clientX: x, clientY: y });
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType: 'mouse', pointerId, clientX: x, clientY: y }));
}

test('the chain: a tap inside a highlight inside a box grab\'s rect records [highlight, box grab] and the composer shows its label; a tap on bare content records none; the thread\'s anchor line and the marker title name the chain; a removed member reads removed', async () => {
  const { CHAIN_MAX } = require('../lib/core/element-log');
  assert.equal(comments.CHAIN_MAX, CHAIN_MAX, 'the chrome\'s cap is the log\'s');
  assert.equal(typeof ov.elementsAt, 'function');
  await setLive([]);
  // A highlight over p2's lead (a range anchor), and a box grab over the
  // top-left of p2's content box (a page record the overlay never resolves).
  POS['lead-p2'] = box(80, 90);
  const leadP2 = lead('p2');
  const range = W.document.createRange();
  range.selectNodeContents(leadP2);
  const hl = { id: 'h7', v: 1, type: 'highlight', anchor: anchors.recordRange(rootOf('p2'), range, { mount: 'p2' }), shared: true };
  const grab = { id: 'g3', v: 1, type: 'box-grab', shared: true,
    anchor: { v: 1, kind: 'page', item: 'p2', mount: 'p2', rect: { x: 50, y: 50, w: 200, h: 200 }, box: { w: 1024, h: 768 }, scroll: { top: 0, left: 0 }, viewport: { w: 1024, h: 768 } } };
  ov.upsertElements('live', [hl, grab]);
  await drawnUntil(() => ov.elementsAt(100, 100).some((h) => h.id === 'h7'), 'the highlight resolved under the point');
  try {
    assert.deepEqual(ov.elementsAt(100, 100).map((h) => [h.id, h.type]), [['h7', 'highlight'], ['g3', 'box-grab']], 'smallest first');
    assert.deepEqual(ov.elementsAt(600, 600).map((h) => h.id), [], 'nothing under a bare point');

    ov.setArmed('comment');
    tapAt(leadP2, 100, 100, 41);
    assert.ok(pinPop() && pinPop().querySelector('.pin-text'), 'the composer opened');
    assert.equal(pinPop().querySelector('.pin-chain').textContent, 'on highlight h7 › box grab g3');
    assert.match(pinPop().querySelector('.pin-anchor').textContent, /^p2 › lead of p2 · on highlight h7 › box grab g3$/);
    const n = posts.length;
    pinPop().querySelector('.pin-text').value = 'over both';
    shell.click(pinPop().querySelector('.pin-save'));
    await waitUntil(() => posts.length > n, { timeout: 4000, what: 'the post' });
    assert.deepEqual(posts[posts.length - 1].payload.chain, ['h7', 'g3'], 'posted as payload.chain, smallest first');

    // Bare content: no chain, and the anchor line is as before.
    ov.setArmed('comment');
    tapAt(rootOf('p2').querySelector('p.more'), 600, 600, 42);
    assert.ok(pinPop() && pinPop().querySelector('.pin-text'), 'the composer opened');
    assert.equal(pinPop().querySelector('.pin-chain'), null);
    assert.match(pinPop().querySelector('.pin-anchor').textContent, /^p2 › more of p2$/);
    const m = posts.length;
    shell.click(pinPop().querySelector('.pin-save'));
    await waitUntil(() => posts.length > m, { timeout: 4000, what: 'the bare post' });
    assert.equal('chain' in posts[posts.length - 1].payload, false, 'no chain key for a bare comment');
    ov.setArmed(null);

    // A chained pin's thread and marker title.
    const pin = pinOn('c80', 'p2', leadP2, { chain: ['h7', 'g3'] });
    await setLive([pin]);
    await drawnUntil(() => !!markersFor('c80')[0], 'the chained pin drawn');
    const marker = markersFor('c80')[0];
    assert.match(marker.title, /c80 text \(on highlight h7 › box grab g3\)$/);
    marker.click();
    assert.equal(pinPop().querySelector('.pin-thread .pin-chain, .pin-chain').textContent, 'on highlight h7 › box grab g3');
    comments.closePinPop();

    // The highlight removed: the label says so; the comment stays.
    ov.removeElements('live', ['h7']);
    await setLive([{ ...pin, v: 2 }]);
    await drawnUntil(() => !!markersFor('c80')[0], 'the pin still drawn');
    assert.match(markersFor('c80')[0].title, /\(on a removed highlight h7 › box grab g3\)$/);
    markersFor('c80')[0].click();
    assert.equal(pinPop().querySelector('.pin-chain').textContent, 'on a removed highlight h7 › box grab g3');
    comments.closePinPop();
  } finally {
    ov.setArmed(null);
    closeComposer();
    ov.removeElements('live', ['h7', 'g3']);
    await setLive([]);
  }
});

// U406a (ruling Q8 a): a viewer that does not see private records gets a
// private chain member as null (remote-policy dropPrivate); the chrome reads
// it as 'a private element', no type and no id, as the daemon's chain_label.
test('the chain: a null member (a private one, to a viewer that does not see it) reads \'a private element\' in the thread\'s .pin-chain and the marker title', async () => {
  await setLive([]);
  POS['lead-p2'] = box(80, 90);
  const leadP2 = lead('p2');
  const range = W.document.createRange();
  range.selectNodeContents(leadP2);
  const hl = { id: 'h7', v: 1, type: 'highlight', anchor: anchors.recordRange(rootOf('p2'), range, { mount: 'p2' }), shared: true };
  ov.upsertElements('live', [hl]);
  try {
    const pin = pinOn('c81', 'p2', leadP2, { chain: [null, 'h7'] });
    await setLive([pin]);
    await drawnUntil(() => !!markersFor('c81')[0], 'the chained pin drawn');
    assert.match(markersFor('c81')[0].title, /c81 text \(on a private element › highlight h7\)$/);
    markersFor('c81')[0].click();
    assert.equal(pinPop().querySelector('.pin-chain').textContent, 'on a private element › highlight h7');
    comments.closePinPop();
  } finally {
    closeComposer();
    ov.removeElements('live', ['h7']);
    await setLive([]);
  }
});

// ── Send to Claude and the tray action guard (F.5, U405; TRAY@guard) ───────
// The thread's .pin-actions carry Send to Claude beside Delete at canWrite
// only: one tap is one POST /api/elements/<id>/send with the device claim; a
// private pin's "Shared with Claude" box reads shared after the answer; an
// 'already' answer says so. Once a preview has started, the reply, the share,
// Delete and Send each reach the tray action guard: READONLY_HINT, no request.
const sendsOf = (id) => shell.calls.filter((c) => c.method === 'POST' && c.url === `/api/elements/${id}/send`);
const reaimText = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };
// The boot's surface again (the tests above leave other panes up).
async function bootSurface() {
  await shell.frame(helloFrame({ active: 'n1', mounts: [P1, P2, S14] }));
  await shell.tick();
  flush();
}
async function openThreadOf(id) {
  await drawnUntil(() => markersFor(id).length === 1, `the pin ${id} drawn`);
  markersFor(id)[0].dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
  const thread = pinPop();
  assert.ok(thread && thread.classList.contains('pin-thread'), 'the thread opened');
  return thread;
}

test('Send to Claude in the thread: beside Delete at canWrite; one tap is one POST; a private pin reads shared after the answer; "already" says so', async () => {
  const ET = await shell.importApp('element-types.js');
  const { deviceKind } = await shell.importApp('viewport.js');
  await bootSurface();
  const kept = [...live.values()];
  POS['lead-p2'] = box(220, 260);
  const pin = pinOn('c60', 'p2', lead('p2'), { text: 'my own note', shared: false });
  shell.setRoutes({ '/api/elements/c60/send': () => {
    const next = { ...live.get('c60'), shared: true, v: 2 };
    live.set('c60', next);
    return { ok: true, element: next, item: { id: 'q9' } };
  } });
  try {
    await setLive([...kept, pin]);
    const thread = await openThreadOf('c60');
    const btn = thread.querySelector('.pin-actions .pin-send');
    assert.ok(btn, 'drawn');
    assert.equal(btn.textContent, ET.SEND_LABEL);
    assert.equal(btn.previousElementSibling, thread.querySelector('.pin-del'), 'beside Delete');
    assert.equal(thread.querySelector('.pin-share-cb').checked, false, 'private before');
    shell.click(btn);
    await waitUntil(() => sendsOf('c60').length === 1 && reaimText() === ET.SENT_NOTE, { what: 'the send and its note' });
    await settle();
    assert.equal(sendsOf('c60').length, 1, 'exactly one request');
    assert.equal(sendsOf('c60')[0].body.device, deviceKind(), 'the device claim');
    assert.equal(thread.querySelector('.pin-share-cb').checked, true, '"Shared with Claude" reads shared');
    shell.setRoutes({ '/api/elements/c60/send': { ok: true, already: true, element: live.get('c60'), item: { id: 'q9' } } });
    shell.click(thread.querySelector('.pin-send'));
    await waitUntil(() => sendsOf('c60').length === 2 && reaimText() === ET.ALREADY_NOTE, { what: 'the already note' });
    comments.closePinPop();
  } finally {
    shell.setRoutes({});
    await setLive(kept);
  }
});

test('the thread\'s writes reach the tray action guard: once a preview has started, reply, share, Delete and Send to Claude each show READONLY_HINT and send nothing; Send is absent below full', async () => {
  const ET = await shell.importApp('element-types.js');
  const st = await shell.importApp('state.js');
  const toolbar = await shell.importApp('toolbar-state.js');
  await bootSurface();
  const kept = [...live.values()];
  POS['lead-p2'] = box(220, 260);
  const pin = pinOn('c61', 'p2', lead('p2'), { text: 'guarded' });
  try {
    await setLive([...kept, pin]);
    const thread = await openThreadOf('c61');
    assert.ok(thread.querySelector('.pin-send'));
    st.view.previewing = true;
    try {
      const n0 = shell.calls.length;
      thread.querySelector('.pin-reply-text').value = 'a reply';
      shell.click(thread.querySelector('.pin-reply-send'));
      const cb = thread.querySelector('.pin-share-cb');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new W.Event('change', { bubbles: true }));
      shell.click(thread.querySelector('.pin-send'));
      shell.click(thread.querySelector('.pin-del'));
      await settle();
      assert.equal(shell.calls.length, n0, 'nothing sent');
      assert.equal(cb.checked, true, 'the share box put back');
      assert.equal(reaimText(), topbar.READONLY_HINT, 'the guard\'s one hint');
      assert.equal(ET.trayReadOnly(), true);
    } finally { st.view.previewing = false; }
    comments.closePinPop();

    shell.setRoutes({ '/api/toolbar': { ...(await (await W.fetch('/api/toolbar')).json()), canWrite: false } });
    await toolbar.refreshToolbar();
    const ro = await openThreadOf('c61');
    assert.equal(ro.querySelector('.pin-send'), null, 'absent below full');
    assert.ok(ro.querySelector('.pin-del'), 'the rest of the thread as before');
    comments.closePinPop();
  } finally {
    shell.setRoutes({});
    await (await shell.importApp('toolbar-state.js')).refreshToolbar();
    await setLive(kept);
  }
});

// ── the page title takes a pin (U403a, K.2-162 PQ-F-3) ─────────────────────
test('the page title\'s heading and its first paragraph take a comment pin: the meta line sits outside the item the resolver aligns', async () => {
  const text = '# Page title\n\nThe first paragraph under it.';
  await putMd(text);
  try {
    assert.equal(W.document.getElementById('page-title').textContent, 'Page title', 'precondition: md-sec is the page title');
    assert.ok(W.document.querySelector('#main .page-meta'), 'precondition: its meta line is drawn');
    const { sourceMap } = await shell.importApp('markdown.js');
    const h1 = mdItem().querySelector('h1');
    const p = mdItem().querySelector('p');
    for (const el of [h1, p]) {
      const range = W.document.createRange();
      range.selectNodeContents(el);
      assert.ok(anchors.recordSource(mdItem(), range, sourceMap(text), text, { md: 'md-sec' }), `recordSource answers for the title item's ${el.tagName}`);
    }
    const head = await pinTap(h1, 51);
    assert.ok(head, 'the title heading tap opened the composer and posted');
    assert.equal(head.anchor.kind, 'source');
    assert.equal(head.anchor.quote.exact, 'Page title');
    assert.equal(head.locator.selector, 'h1');
    const prose = await pinTap(p, 52);
    assert.ok(prose, 'the first paragraph tap posted');
    assert.equal(prose.anchor.quote.exact, 'The first paragraph under it.');
    assert.equal(prose.locator.section, 'Page title');
  } finally { await dropMd(); }
});

// ── a point (4C.1, U532; DECISIONS.md C5; RULED U531-U532@point-record-kind a) ──
// A tap on a fixed-aspect target (an svg, an img, a canvas) pins a POINT: the
// target's element record with kind 'point' and x, y, aspect beside, and the
// TARGET's 0.8.5 locator; a tap on text or a control keeps the element anchor
// (the conversion at creation), never a raw point over prose. The overlay
// places a point row at its x/y (anchors.pointAt), one marker per point,
// clipped to the well and never over a displayed frame; a pick of kind
// 'point' records one only on a fixed-aspect target; elementsAt holds a point
// by its glyph's box. Boxes on stubbed rects: the target's own
// getBoundingClientRect (the one target-frame walk reads it) and the
// overlay's rectOf (POS) answer the same live object.
const PT_HTML = (id) => `<svg class="chart" data-pin="svg-${id}" width="200" height="100" viewBox="0 0 200 100"><circle class="dot" cx="50" cy="50" r="10"></circle></svg>`
  + `<img class="pic" data-pin="img-${id}" alt="a picture"><canvas class="cv" data-pin="cv-${id}"></canvas>`
  + `<p class="para">a paragraph of prose in ${id}</p><button class="btn">Push</button><script>
    root.querySelector('.btn').addEventListener('click', function () { window.__goClicks.push(mountId); });
  </script>`;
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
// The target's box, live: POS[key] for the overlay, and the element's own box
// for the target-frame walk (jsdom does no layout).
function frameBox(el, key, r) {
  POS[key] = r;
  el.getBoundingClientRect = () => POS[key];
}
async function pointPanes() {
  for (const id of ['pt1', 'pt2']) {
    if (M.itemEl(W.document, id)) continue;
    await shell.frame({ type: 'render', id, target: 'main', params: {}, html: PT_HTML(id) });
  }
  await shell.tick();
  for (const id of ['pt1', 'pt2']) {
    const r = rootOf(id);
    const off = id === 'pt1' ? 0 : 400;
    frameBox(r.querySelector('svg'), `svg-${id}`, rect(100 + off, 200, 200, 100));
    frameBox(r.querySelector('img'), `img-${id}`, rect(100 + off, 320, 80, 60));
    frameBox(r.querySelector('canvas'), `cv-${id}`, rect(200 + off, 320, 120, 60));
  }
}
const svgOf = (id) => rootOf(id).querySelector('svg');
function tapWith(el, pointerType, x, y, pointerId) {
  pe(el, 'pointerdown', pointerType, pointerId, { clientX: x, clientY: y });
  pe(el, 'pointerup', pointerType, pointerId, { clientX: x, clientY: y });
  el.dispatchEvent(new W.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, pointerType, pointerId, clientX: x, clientY: y }));
}
// Tap with the comment tool armed and Pin: the body posted, or null.
async function pinWith(el, pointerType, x, y, pointerId) {
  ov.setArmed('comment');
  const n = posts.length;
  try {
    tapWith(el, pointerType, x, y, pointerId);
    const pop = pinPop();
    if (!pop || !pop.querySelector('.pin-text')) return null;
    pop.querySelector('.pin-text').value = 'a point';
    shell.click(pop.querySelector('.pin-save'));
    await waitUntil(() => posts.length === n + 1, { what: 'the POST' });
    return posts.at(-1);
  } finally { ov.setArmed(null); comments.closePinPop(); }
}
function pointPin(id, mount, x, y, extra = {}) {
  const svg = svgOf(mount);
  const b = svg.getBoundingClientRect();
  const anchor = anchors.recordPoint(rootOf(mount), svg, b.left + x * b.width, b.top + y * b.height, { mount });
  assert.equal(anchor.kind, 'point', `precondition: ${id} is a point`);
  return { id, v: 1, seq: 1, type: 'comment', text: `${id} text`, shared: true, replies: [], anchor,
    locator: { mount, selector: 'svg.chart', text: '', ordinal: 0 }, ...extra };
}
// The anchor point a point marker must sit at: pointAt over the target's box now.
const expectAt = (pin, mount) => anchors.pointAt(pin.anchor, POS[`svg-${mount}`]);
const placedOn = (m, p) => !!m && !!p && m.style.display === '' && Math.abs(parseFloat(m.style.left) - p.x) <= 0.5
  && Math.abs(parseFloat(m.style.top) - p.y) <= 0.5;

test('a pen tap on a <circle> inside a pane\'s svg posts a point: the svg\'s element record with kind point, x, y and aspect, and the svg\'s 0.8.5 locator', async () => {
  await setLive([]);
  await pointPanes();
  const circle = rootOf('pt1').querySelector('circle');
  const body = await pinWith(circle, 'pen', 150, 250, 61);
  assert.ok(body, 'the pen opened the composer and posted');
  assert.equal(body.type, 'comment');
  const elRec = anchors.record(rootOf('pt1'), svgOf('pt1'), { mount: 'pt1' });
  const { kind, ...elFields } = elRec;
  assert.equal(kind, 'element');
  assert.deepEqual(body.anchor, { ...elFields, kind: 'point', x: 0.25, y: 0.5, aspect: 2 }, 'the svg\'s record, kind point, x/y/aspect beside');
  assert.deepEqual(body.anchor, anchors.recordPoint(rootOf('pt1'), circle, 150, 250, { mount: 'pt1' }));
  assert.deepEqual(body.locator, { mount: 'pt1', selector: 'svg.chart', text: '', ordinal: 0 }, 'the TARGET\'s locator, not the circle\'s');
});

test('a pen tap on an img and on a canvas pins a point; on a paragraph an element; a pen on a button an element, the button unheard', async () => {
  await pointPanes();
  const r = rootOf('pt1');
  const img = await pinWith(r.querySelector('img'), 'pen', 140, 350, 62);
  assert.equal(img.anchor.kind, 'point');
  assert.deepEqual([img.anchor.x, img.anchor.y, img.anchor.aspect], [0.5, 0.5, 1.3333]);
  assert.equal(img.locator.selector, 'img.pic');
  const cv = await pinWith(r.querySelector('canvas'), 'pen', 230, 335, 63);
  assert.equal(cv.anchor.kind, 'point');
  assert.deepEqual([cv.anchor.x, cv.anchor.y], [0.25, 0.25]);
  assert.equal(cv.locator.selector, 'canvas.cv');
  const para = r.querySelector('p.para');
  const p = await pinWith(para, 'pen', 120, 400, 64);
  assert.equal(p.anchor.kind, 'element', 'text keeps the element anchor (C5: never a raw point over prose)');
  assert.deepEqual(p.anchor, anchors.record(r, para, { mount: 'pt1' }));
  assert.equal(p.locator.selector, 'p.para');
  W.__goClicks.length = 0;
  const btn = await pinWith(r.querySelector('button.btn'), 'pen', 120, 420, 65);
  assert.equal(btn.anchor.kind, 'element', 'a control keeps the element anchor');
  assert.deepEqual(W.__goClicks, [], 'the button did not run');
});

test('a finger tap on the svg pins a point by the input policy; a tap 1 px outside the svg\'s box pins an element', async () => {
  await pointPanes();
  IM.setFingerDraws('off');
  try {
    const circle = rootOf('pt1').querySelector('circle');
    const finger = await pinWith(circle, 'touch', 200, 220, 66);
    assert.ok(finger, 'a finger tap on the svg opened the composer');
    assert.equal(finger.anchor.kind, 'point');
    assert.deepEqual([finger.anchor.x, finger.anchor.y], [0.5, 0.2]);
    const out = await pinWith(circle, 'mouse', 99, 250, 67);
    assert.equal(out.anchor.kind, 'element', 'outside the box: the element path, unchanged');
    assert.deepEqual(out.anchor, anchors.record(rootOf('pt1'), circle, { mount: 'pt1' }));
  } finally { W.localStorage.removeItem('wc:finger-draws'); }
});

test('two point pins on one svg draw two markers at pointAt; after a resize both follow on the overlay\'s redraw, no interval armed', async () => {
  await pointPanes();
  const intervals = shell.intervals().length;
  const a = pointPin('c201', 'pt1', 0.25, 0.5);
  const b = pointPin('c202', 'pt1', 0.75, 0.2);
  await setLive([a, b]);
  await drawnUntil(() => placedOn(markersFor('c201')[0], expectAt(a, 'pt1')) && placedOn(markersFor('c202')[0], expectAt(b, 'pt1')), 'two points drawn');
  assert.notEqual(markersFor('c201')[0], markersFor('c202')[0], 'two markers, not one group');
  assert.equal(markersFor('c201').length, 1);
  assert.equal(markersFor('c201')[0].style.left, '150px');
  assert.equal(markersFor('c201')[0].style.top, '250px');
  assert.equal(markersFor('c201')[0].style.transform, 'translate(-13px, -26px)', 'the glyph\'s anchor point (its bottom centre) at the point');
  // The svg resizes (the pane's colSpan and rows): both follow.
  POS['svg-pt1'] = rect(40, 260, 400, 200);
  await shell.frame({ type: 'pane:state', id: 'pt1', pane_state: { colSpan: 6, rows: 8 } });
  await drawnUntil(() => placedOn(markersFor('c201')[0], expectAt(a, 'pt1')) && placedOn(markersFor('c202')[0], expectAt(b, 'pt1')), 'both re-placed');
  assert.equal(markersFor('c202')[0].style.left, '340px');
  assert.equal(markersFor('c202')[0].style.top, '300px');
  assert.equal(shell.intervals().length, intervals, 'no interval armed');
  POS['svg-pt1'] = rect(100, 200, 200, 100);
  await setLive([]);
});

test('a point glyph whose box meets a displayed frame is not drawn; a point outside the well is clipped', async () => {
  await pointPanes();
  const a = pointPin('c203', 'pt1', 0.25, 0.5);
  const b = pointPin('c204', 'pt1', 0.75, 0.5);
  await setLive([a, b]);
  await drawnUntil(() => placedOn(markersFor('c203')[0], expectAt(a, 'pt1')) && placedOn(markersFor('c204')[0], expectAt(b, 'pt1')), 'both drawn');
  const frame = W.document.createElement('iframe');
  frame.dataset.pin = 'pt-frame';
  POS['pt-frame'] = rect(140, 230, 20, 20);   // over c203's glyph (137..163 × 224..250), clear of c204's
  W.document.body.appendChild(frame);
  const well = W.document.getElementById('main');
  try {
    ov.requestDraw();
    await drawnUntil(() => markersFor('c203')[0].style.display === 'none', 'the framed glyph hidden');
    assert.ok(placedOn(markersFor('c204')[0], expectAt(b, 'pt1')), 'the other point still drawn');
    frame.remove();
    ov.requestDraw();
    await drawnUntil(() => placedOn(markersFor('c203')[0], expectAt(a, 'pt1')), 'drawn again once the frame goes');
    // The well's right edge between the two points: c204's point leaves the clip.
    well.dataset.pin = 'well';
    POS.well = rect(0, 0, 200, 768);
    ov.requestDraw();
    await drawnUntil(() => markersFor('c204')[0].style.display === 'none', 'the point outside the well clipped');
    assert.ok(placedOn(markersFor('c203')[0], expectAt(a, 'pt1')), 'the point inside it drawn');
  } finally {
    frame.remove();
    delete well.dataset.pin;
    delete POS.well;
    await setLive([]);
    ov.requestDraw();
    flush();
  }
});

test('a pick of kind point: a click on another svg records a point; a click on a paragraph records nothing and the pick waits; cancel ends it; an orphaned point pin\'s Re-anchor does not throw', async () => {
  await pointPanes();
  const orph = await shell.importApp('orphans.js');
  const { PICK_KINDS } = ov;
  assert.ok(PICK_KINDS.includes('point'));
  const handle = ov.pick({ kind: 'point' });
  let got;
  handle.promise.then((v) => { got = v; });
  try {
    const para = rootOf('pt2').querySelector('p.para');
    tapWith(para, 'mouse', 520, 400, 71);
    await shell.tick();
    assert.equal(got, undefined, 'a paragraph records nothing: the pick still waits');
    tapWith(rootOf('pt2').querySelector('circle'), 'mouse', 600, 225, 72);
    await shell.tick();
    assert.ok(got && got.record, 'the svg click resolved the pick');
    assert.equal(got.kind, 'point');
    assert.equal(got.mount, 'pt2');
    assert.deepEqual(got.record, anchors.recordPoint(rootOf('pt2'), svgOf('pt2'), 600, 225, { mount: 'pt2' }));
  } finally { handle.cancel(); }
  // Cancel (the card's Escape) resolves null.
  const second = ov.pick({ kind: 'point' });
  second.cancel();
  assert.equal(await second.promise, null);
  // An orphaned point pin (its target gone: a record no element answers).
  const pin = pointPin('c205', 'pt1', 0.5, 0.5);
  const lost = { ...pin, anchor: { ...pin.anchor, at: { path: [9, 9, 9], sib: 0 }, fp: { ...pin.anchor.fp, tag: 'video', cls: ['gone'], attrs: [] }, rows: [] } };
  await setLive([lost]);
  await drawnUntil(() => ov.orphans().some((o) => o.id === 'c205'), 'listed as an orphan');
  const o = ov.orphans().find((x) => x.id === 'c205');
  assert.doesNotThrow(() => orph.startPick(o), 'the Re-anchor never throws');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await setLive([]);
});

test('a press on a point pin\'s glyph names it in a new comment\'s chain; a press elsewhere on the same svg does not', async () => {
  await pointPanes();
  const a = pointPin('c206', 'pt1', 0.25, 0.5);   // at (150, 250): its glyph 137..163 × 224..250
  await setLive([a]);
  await drawnUntil(() => placedOn(markersFor('c206')[0], expectAt(a, 'pt1')), 'the point drawn');
  assert.deepEqual(ov.elementsAt(150, 240).map((h) => h.id), ['c206'], 'held by its glyph');
  assert.deepEqual(ov.elementsAt(250, 280).map((h) => h.id), [], 'not by its whole target');
  const circle = rootOf('pt1').querySelector('circle');
  const on = await pinWith(circle, 'mouse', 150, 240, 73);
  assert.deepEqual(on.payload.chain, ['c206'], 'the press on its glyph names it');
  const off = await pinWith(circle, 'mouse', 250, 280, 74);
  assert.equal('chain' in off.payload, false, 'a press elsewhere on the svg names nothing');
  await setLive([]);
});

// ── a pin on a word (H.8, U588; DECISIONS.md K.2-169) ───────────────────────
// A comment tap that lands in text records a range anchor over the word
// (anchors.recordRange over highlight.js snapRange's word), the element anchor
// the fallback. jsdom has no layout and no caret API: the paragraph's text is
// laid out here (CH px a character, LH px a line, greedily wrapped at `cols`),
// and a test hands document.caretPositionFromPoint and Range#getClientRects
// that layout; the overlay's rectOf reads the same layout for a Range.
const WORDS = 'alpha beta gamma delta epsilon zeta eta theta';
const LONG = 'x'.repeat(2100);
const TW_HTML = `<p class="words" data-pin="words-tw">${WORDS}</p><p class="long" data-pin="long-tw">${LONG}</p>`
  + '<button class="btn">Push</button><a class="lnk" href="#nowhere">a link</a>';
const CH = 8;
const LH = 20;
const ORIGIN = { left: 40, top: 300 };
let cols = 50;
const wordsText = () => rootOf('tw').querySelector('p.words').firstChild;
// Each character's {line, col}: words greedily wrapped at `cols`.
function laidOut() {
  const pos = [];
  let line = 0;
  let col = 0;
  const words = [...WORDS.matchAll(/\S+/g)];
  words.forEach((m, k) => {
    const len = m[0].length;
    if (col > 0 && col + len > cols) { line++; col = 0; }
    for (let i = 0; i < len; i++) pos[m.index + i] = { line, col: col + i };
    col += len;
    if (k < words.length - 1) { pos[m.index + len] = { line, col }; col++; }
  });
  return pos;
}
// A Range's client rects over the paragraph's text node, one per line; none
// for any other Range.
function wordRects(range) {
  const t = M.itemEl(W.document, 'tw') ? wordsText() : null;
  if (!t || range.startContainer !== t || range.endContainer !== t) return [];
  const pos = laidOut();
  const lines = [];
  for (let i = range.startOffset; i < range.endOffset; i++) {
    const p = pos[i];
    const last = lines[lines.length - 1];
    if (last && last.line === p.line) { last.n++; continue; }
    lines.push({ line: p.line, col: p.col, n: 1 });
  }
  return lines.map((l) => rect(ORIGIN.left + l.col * CH, ORIGIN.top + l.line * LH, l.n * CH, LH));
}
// The caret a browser gives at (x, y): the boundary nearest the point on its
// line (a character's left half before it, its right half after it), the
// line's end past its last character.
function caretAt(x, y) {
  const pos = laidOut();
  const line = Math.floor((y - ORIGIN.top) / LH);
  const on = [];
  pos.forEach((p, i) => { if (p.line === line) on.push([p, i]); });
  if (!on.length) return null;
  let offset = null;
  for (const [p, i] of on) {
    const left = ORIGIN.left + p.col * CH;
    if (x >= left && x < left + CH) offset = x - left >= CH / 2 ? i + 1 : i;
  }
  if (offset == null) offset = x < ORIGIN.left + on[0][0].col * CH ? on[0][1] : on[on.length - 1][1] + 1;
  return { offsetNode: wordsText(), offset };
}
const wordAt = (word) => {
  const i = WORDS.indexOf(word);
  const r = W.document.createRange();
  r.setStart(wordsText(), i);
  r.setEnd(wordsText(), i + word.length);
  return r;
};
// A point inside a word, `at` of its way across, mid-line.
function spotOf(word, at = 0.5) {
  const p = laidOut()[WORDS.indexOf(word)];
  return { x: ORIGIN.left + (p.col + word.length * at) * CH, y: ORIGIN.top + p.line * LH + LH / 2 };
}
// Lay the text out for this test: a caret API (or none), Range rects (or
// none), caretRangeFromPoint (to count it); the returned function undoes it.
function layText({ caret = null, rects = true, caretRange = null } = {}) {
  const doc = W.document;
  const hadRects = Object.prototype.hasOwnProperty.call(W.Range.prototype, 'getClientRects');
  if (caret) doc.caretPositionFromPoint = caret;
  if (caretRange) doc.caretRangeFromPoint = caretRange;
  if (rects && !hadRects) W.Range.prototype.getClientRects = function () { return wordRects(this); };
  rangeRectHook = (r) => wordRects(r)[0] || null;
  return () => {
    delete doc.caretPositionFromPoint;
    delete doc.caretRangeFromPoint;
    if (!hadRects) delete W.Range.prototype.getClientRects;
    rangeRectHook = null;
  };
}
async function wordPane() {
  if (!M.itemEl(W.document, 'tw')) await shell.frame({ type: 'render', id: 'tw', target: 'main', params: {}, html: TW_HTML });
  await shell.tick();
  POS['words-tw'] = rect(ORIGIN.left, ORIGIN.top, cols * CH, LH);
}
// Tap with the comment tool armed and Pin, the composer awaited (a word's
// first snap loads highlight.js): the body posted.
async function pinText(el, x, y, pointerId, pointerType = 'mouse') {
  ov.setArmed('comment');
  const n = posts.length;
  try {
    tapWith(el, pointerType, x, y, pointerId);
    await waitUntil(() => { const p = pinPop(); return !!(p && p.querySelector('.pin-text')); }, { what: 'the composer' });
    const pop = pinPop();
    pop.querySelector('.pin-text').value = 'on a word';
    shell.click(pop.querySelector('.pin-save'));
    await waitUntil(() => posts.length === n + 1, { what: 'the POST' });
    return posts.at(-1);
  } finally { ov.setArmed(null); comments.closePinPop(); }
}

test('a comment tap on a word in a pane\'s paragraph records a range anchor whose quote.exact is that word, the caret found inside the pane\'s shadow root; after a reflow the pin draws at the word, not at the paragraph\'s top', async () => {
  assert.equal(typeof W.document.caretPositionFromPoint, 'undefined', 'precondition: jsdom has no caret API of its own');
  await setLive([]);
  cols = 50;
  await wordPane();
  const root = rootOf('tw');
  const para = root.querySelector('p.words');
  const handed = [];
  const undo = layText({
    caret: (x, y, opts) => {
      handed.push(opts);
      // Like a browser: without the shadow root handed in, the caret stops at the host.
      return opts && Array.isArray(opts.shadowRoots) && opts.shadowRoots.includes(root) ? caretAt(x, y) : { offsetNode: root.host, offset: 0 };
    },
  });
  try {
    const at = spotOf('zeta');
    const body = await pinText(para, at.x, at.y, 71);
    assert.ok(handed.length >= 1, 'the caret API was asked');
    assert.deepEqual(handed[0].shadowRoots, [root], 'and handed the pane\'s shadow root');
    assert.equal(body.anchor.kind, 'range', 'a tap in text records a range (H.8)');
    assert.equal(body.anchor.quote.exact, 'zeta', 'over the word under the tap');
    assert.equal(body.anchor.mount, 'tw');
    assert.deepEqual(body.anchor, anchors.recordRange(root, wordAt('zeta'), { mount: 'tw' }), 'anchors.recordRange\'s record');
    assert.deepEqual(body.locator, { mount: 'tw', selector: 'p.words', text: WORDS, ordinal: 0 }, 'the legacy locator stays the tapped element\'s');
    const pin = { id: 'c311', v: 1, seq: 1, type: 'comment', text: 'on a word', shared: true, replies: [], anchor: body.anchor, locator: body.locator };
    await setLive([pin]);
    const before = wordRects(wordAt('zeta'))[0];
    assert.equal(before.top, ORIGIN.top, 'precondition: zeta is on the first line');
    await drawnUntil(() => placedAt(markersFor('c311')[0], before), 'the pin drawn at the word');
    // The pane narrows: the paragraph reflows and zeta moves down two lines.
    cols = 15;
    POS['words-tw'] = rect(ORIGIN.left, ORIGIN.top, cols * CH, 4 * LH);
    await shell.frame({ type: 'pane:state', id: 'tw', pane_state: { colSpan: 3, rows: 6 } });
    const after = wordRects(wordAt('zeta'))[0];
    assert.equal(after.top, ORIGIN.top + 2 * LH, 'precondition: the reflow moved zeta to the third line');
    await drawnUntil(() => placedAt(markersFor('c311')[0], after), 'the pin follows the word');
    assert.equal(placedAt(markersFor('c311')[0], POS['words-tw']), false, 'not at the paragraph\'s top');
  } finally {
    undo();
    cols = 50;
    POS['words-tw'] = rect(ORIGIN.left, ORIGIN.top, cols * CH, LH);
    await setLive([]);
  }
});

test('with no caretPositionFromPoint, the geometry walk over the target\'s words finds the one under the tap; caretRangeFromPoint is never asked', async () => {
  cols = 50;
  await wordPane();
  const root = rootOf('tw');
  let ranged = 0;
  const undo = layText({ caretRange: () => { ranged++; return null; } });
  try {
    assert.equal(typeof W.document.caretPositionFromPoint, 'undefined', 'precondition: no caretPositionFromPoint');
    const at = spotOf('gamma', 0.2);
    const body = await pinText(root.querySelector('p.words'), at.x, at.y, 72);
    assert.equal(body.anchor.kind, 'range');
    assert.equal(body.anchor.quote.exact, 'gamma');
    assert.deepEqual(body.anchor, anchors.recordRange(root, wordAt('gamma'), { mount: 'tw' }));
    assert.equal(ranged, 0, 'caretRangeFromPoint stops at the shadow host: never asked');
  } finally { undo(); }
});

test('a tap on a button or a link records the element, on an img or an svg U532\'s point, whatever the caret API answers', async () => {
  cols = 50;
  await wordPane();
  await pointPanes();
  const r = rootOf('tw');
  const undo = layText({ caret: () => ({ offsetNode: wordsText(), offset: 2 }), rects: false });
  try {
    const btn = r.querySelector('button.btn');
    const b = await pinText(btn, 60, 60, 73, 'pen');
    assert.equal(b.anchor.kind, 'element', 'a control takes the element');
    assert.deepEqual(b.anchor, anchors.record(r, btn, { mount: 'tw' }));
    const lnk = r.querySelector('a.lnk');
    const l = await pinText(lnk, 60, 60, 74);
    assert.equal(l.anchor.kind, 'element', 'a link is a control');
    assert.deepEqual(l.anchor, anchors.record(r, lnk, { mount: 'tw' }));
    const pr = rootOf('pt1');
    const img = await pinText(pr.querySelector('img'), 140, 350, 75, 'pen');
    assert.equal(img.anchor.kind, 'point', 'an img: U532\'s point');
    const svg = await pinText(pr.querySelector('circle'), 150, 250, 76, 'pen');
    assert.equal(svg.anchor.kind, 'point', 'an svg: U532\'s point');
  } finally { undo(); }
});

test('a tap in text where no caret is found records the element: no caret, a caret outside the tapped element, a caret past the line\'s end with no word under the tap', async () => {
  cols = 50;
  await wordPane();
  const root = rootOf('tw');
  const para = root.querySelector('p.words');
  const elRec = anchors.record(root, para, { mount: 'tw' });
  const at = spotOf('beta');
  let undo = layText({ caret: () => null, rects: false });
  try {
    const a = await pinText(para, at.x, at.y, 77);
    assert.deepEqual(a.anchor, elRec, 'the caret API found none (and no rects to walk): the element');
  } finally { undo(); }
  undo = layText({ caret: () => ({ offsetNode: root.querySelector('p.long').firstChild, offset: 3 }), rects: false });
  try {
    const b = await pinText(para, at.x, at.y, 78);
    assert.deepEqual(b.anchor, elRec, 'a caret in another element: the element');
  } finally { undo(); }
  undo = layText({ caret: (x, y) => caretAt(x, y) });
  try {
    const c = await pinText(para, ORIGIN.left + 48 * CH, ORIGIN.top + LH / 2, 79);
    assert.deepEqual(c.anchor, elRec, 'a caret at the line\'s end, the tap in the margin past theta: the element');
  } finally { undo(); }
});

test('a word over quote_max falls back to the element (anchors.recordRange answers null)', async () => {
  cols = 50;
  await wordPane();
  const root = rootOf('tw');
  const long = root.querySelector('p.long');
  assert.ok(LONG.length > anchors.CONFIG.quote_max, 'precondition: the run is over quote_max');
  const undo = layText({ caret: () => ({ offsetNode: long.firstChild, offset: 7 }) });
  try {
    const body = await pinText(long, 100, 100, 80);
    assert.equal(body.anchor.kind, 'element');
    assert.deepEqual(body.anchor, anchors.record(root, long, { mount: 'tw' }));
  } finally { undo(); }
});

test('highlight.js is loaded lazily, through a relative import(\'./highlight.js\'), and its snapRange is the one word snap', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/comments.js'), 'utf8');
  assert.doesNotMatch(src, /^\s*(?:import|export)\b[^;]*?from\s*['"]\.\/highlight\.js['"]/m, 'no static import of highlight.js (queue.js imports comments.js)');
  assert.match(src, /\bimport\('\.\/highlight\.js'\)/, 'a relative dynamic import at first use');
  assert.match(src, /\.snapRange\(seed, 'words', root\)/, 'the word snap is highlight.js snapRange');
  assert.doesNotMatch(src, /\bcaretRangeFromPoint\(/, 'never caretRangeFromPoint');
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

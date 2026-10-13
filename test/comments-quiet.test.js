'use strict';
// The comments client goes quiet (U103; ruled U103@comments-poll, A-defaults).
//
// public/app/comments.js used to run two perpetual pollers whatever the page
// was doing: a GET /api/comments every 3 s (every pin and every reply) and a
// marker pass every 500 ms that resolved each pin's anchor inside the pane
// shadow roots and read its rect — a forced layout twice a second — both
// running in a hidden tab. The WS `comments` frame is the primary path, so:
//
//   * the fetch runs on init, on every hello (a reconnect may have missed a
//     frame) and on a 30 s fallback interval, and never while the tab is
//     hidden — a refresh asked for then is sent when the tab is visible again;
//   * the 500 ms pass returns at once on a hidden page, or with no pins and no
//     marker to take down; a visibilitychange to visible runs one pass;
//   * a `comments` frame still redraws the markers at once.
//
// Both pollers stay single setIntervals (spec §10.1): the shell stubs them, and
// a test runs one by calling its function.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

let shell, W;
let visibility = 'visible';

const PANE = { id: 'notes', html: '<ul><li>one</li><li>two</li></ul>', target: 'main', params: {} };
const PIN = { id: 'c1', text: 'this one', shared: true, replies: [],
  anchor: { mount: 'notes', selector: 'li', text: 'two', ordinal: 1 } };

const commentGets = () => shell.calls.filter((c) => c.url === '/api/comments' && c.method === 'GET').length;
const interval = (name, ms) => {
  const found = shell.intervals().filter((i) => i.fn && i.fn.name === name);
  assert.equal(found.length, 1, `one ${name} interval`);
  assert.equal(found[0].ms, ms, `${name} runs every ${ms} ms`);
  return found[0];
};
const run = async (iv) => { iv.fn(...iv.args); await shell.tick(); };
const setVisibility = (v, { fire = true } = {}) => {
  visibility = v;
  if (fire) W.document.dispatchEvent(new W.Event('visibilitychange'));
};
const host = () => [...W.document.querySelectorAll('.mount-host')].find((h) => (h.dataset.mountId || h.id) === 'notes');
const markers = () => [...W.document.getElementById('pin-layer').querySelectorAll('.pin-marker')];

// Count the anchor work a marker pass does: a query of the pane's shadow root,
// and a rect read of any element.
function spyLayout() {
  const root = host().shadowRoot;
  const counts = { queries: 0, rects: 0 };
  const ownQsa = root.querySelectorAll;
  root.querySelectorAll = function (...a) { counts.queries += 1; return ownQsa.apply(this, a); };
  const proto = W.Element.prototype;
  const ownRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (...a) { counts.rects += 1; return ownRect.apply(this, a); };
  counts.restore = () => { root.querySelectorAll = ownQsa; proto.getBoundingClientRect = ownRect; };
  return counts;
}

before(async () => {
  shell = await bootShell({
    init(s) {
      Object.defineProperty(s.document, 'visibilityState', { configurable: true, get: () => visibility });
    },
  });
  W = shell.window;
  await shell.frame(helloFrame({ mounts: [PANE] }));
  assert.ok(host() && host().shadowRoot, 'precondition: the pane mounted with a shadow root');
});
after(() => shell.restore());

test('the comments pollers are one 500 ms pass and one 30 s fetch — no 3 s poll', () => {
  interval('markerPass', 500);
  interval('refresh', 30000);
  assert.equal(shell.intervals().filter((i) => i.fn && i.fn.name === 'refresh' && i.ms === 3000).length, 0);
  assert.ok(commentGets() >= 1, 'init still reads the pins once');
});

test('the 30 s fallback fetches while visible and makes no request while hidden', async () => {
  const refresh = interval('refresh', 30000);
  let n = commentGets();
  await run(refresh);
  assert.equal(commentGets(), n + 1, 'visible: one GET /api/comments');

  setVisibility('hidden');
  n = commentGets();
  await run(refresh);
  await run(refresh);
  assert.equal(commentGets(), n, 'hidden: the fallback poll sends nothing');

  setVisibility('visible');
  await shell.tick();
  assert.equal(commentGets(), n + 1, 'the put-off refresh goes out once the tab is visible again');
  await run(refresh);
  assert.equal(commentGets(), n + 2);
});

test('a hello frame triggers one /api/comments refresh — and none while hidden', async () => {
  let n = commentGets();
  await shell.frame(helloFrame({ mounts: [PANE] }));
  assert.equal(commentGets(), n + 1, 'a (re)connect re-reads the pins once');

  setVisibility('hidden');
  n = commentGets();
  await shell.frame(helloFrame({ mounts: [PANE] }));
  assert.equal(commentGets(), n, 'a hidden tab makes no comments request');
  setVisibility('visible');
  await shell.tick();
  assert.equal(commentGets(), n + 1, 'it is sent on the return to visible');
});

test('with no pins the 500 ms pass does no layout work', async () => {
  const pass = interval('markerPass', 500);
  assert.equal(markers().length, 0, 'precondition: no pins, no markers');
  const spy = spyLayout();
  try {
    await run(pass);
    await run(pass);
    assert.equal(spy.queries, 0, 'no shadow-root query');
    assert.equal(spy.rects, 0, 'no getBoundingClientRect');
  } finally { spy.restore(); }
});

test('a comments frame draws its marker at once, and the pass repositions it as before', async () => {
  shell.setRoutes({ '/api/comments': { comments: [PIN] } });
  await shell.frame({ type: 'comments', comments: [PIN] });
  assert.equal(markers().length, 1, 'the frame redrew the markers with no interval run');

  const li = host().shadowRoot.querySelectorAll('li')[1];
  const m = shell.scrollMetrics(li, { rect: { left: 12, top: 34, width: 50, height: 10 } });
  const spy = spyLayout();
  try {
    await run(interval('markerPass', 500));
    assert.ok(spy.queries > 0, 'with a pin the pass resolves its anchor');
  } finally { spy.restore(); }
  const marker = markers()[0];
  assert.equal(marker.style.left, '12px');
  assert.equal(marker.style.top, '34px');
  assert.equal(marker.style.display, '');

  m.rect = { left: 70, top: 90, width: 50, height: 10 };
  await run(interval('markerPass', 500));
  assert.equal(marker.style.left, '70px', 'a reflow is followed on the next pass');
  assert.equal(markers()[0], marker, 'repositioned, not rebuilt');
});

test('on a hidden page the pass does nothing even with pins; visible again runs one pass', async () => {
  assert.equal(markers().length, 1, 'precondition: the pin from the last test');
  const li = host().shadowRoot.querySelectorAll('li')[1];
  shell.scrollMetrics(li, { rect: { left: 5, top: 6, width: 50, height: 10 } });
  setVisibility('hidden');
  const spy = spyLayout();
  try {
    await run(interval('markerPass', 500));
    assert.equal(spy.queries, 0, 'hidden: no shadow-root query');
    assert.equal(spy.rects, 0, 'hidden: no rect read');
  } finally { spy.restore(); }
  assert.equal(markers()[0].style.left, '70px', 'hidden: the marker stays where it was');

  setVisibility('visible');
  await shell.tick();
  assert.equal(markers()[0].style.left, '5px', 'the return to visible ran one pass');
});

test('the last pin going takes its marker down on the next pass', async () => {
  shell.setRoutes({ '/api/comments': { comments: [] } });
  await shell.frame({ type: 'comments', comments: [] });
  assert.equal(markers().length, 0, 'the frame took the marker down at once');
  const spy = spyLayout();
  try {
    await run(interval('markerPass', 500));
    assert.equal(spy.queries + spy.rects, 0, 'and the idle page is quiet again');
  } finally { spy.restore(); }
});

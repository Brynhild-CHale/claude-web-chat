'use strict';
// The comments client goes quiet (U103; ruled U103@comments-poll, A-defaults;
// U327b).
//
// public/app/comments.js used to run two perpetual pollers whatever the page
// was doing: a GET /api/comments every 3 s (every pin and every reply) and a
// marker pass every 500 ms that resolved each pin's anchor inside the pane
// shadow roots and read its rect — a forced layout twice a second — both
// running in a hidden tab. U304 removed the timed fetch; U327b retired the
// marker pass onto the page well's overlay (overlay.js), which places the pins
// from the resolver's answers on its own redraws. The WS `element:comment`
// frame (U327a; `comments` before) is the primary path, so:
//
//   * the fetch runs on init, on every hello (a reconnect may have missed a
//     frame) and on every reset (the surface moved; U304 removed the 30 s
//     fallback interval), and never while the tab is hidden — a refresh asked
//     for then is sent when the tab is visible again;
//   * comments.js arms no interval of any kind: no marker pass, no timed fetch;
//   * an `element:comment` frame draws the marker at once (the overlay's), a
//     reflow the overlay hears re-places it without rebuilding it, and the last
//     pin going takes it down.
//
// A perpetual chrome poller is one setInterval (spec §10.1): the shell stubs
// them and lists the live ones, so a test can see that none is comments.js's.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { convertAnchor } = require('../lib/core/element-log');

let shell, W;
let visibility = 'visible';

const PANE = { id: 'notes', html: '<ul><li>one</li><li>two</li></ul>', target: 'main', params: {} };
// The anchor in the resolver's form (a 0.8.5 locator converted, as the
// daemon's element log holds it): the chrome converts none itself (U327b).
const PIN = { id: 'c1', text: 'this one', shared: true, replies: [],
  anchor: convertAnchor({ mount: 'notes', selector: 'li', text: 'two', ordinal: 1 }) };

const commentGets = () => shell.calls.filter((c) => c.url === '/api/elements?type=comment' && c.method === 'GET').length;
// The names comments.js's pollers ran under (markerPass, refresh), and the
// cadences they ran at: none is armed any more.
const commentIntervals = () => shell.intervals().filter((i) => (i.fn && ['markerPass', 'refresh'].includes(i.fn.name))
  || i.ms === 500 || i.ms === 3000 || i.ms === 30000);
const setVisibility = (v, { fire = true } = {}) => {
  visibility = v;
  if (fire) W.document.dispatchEvent(new W.Event('visibilitychange'));
};
const host = () => [...W.document.querySelectorAll('.mount-host')].find((h) => (h.dataset.mountId || h.id) === 'notes');
const markers = () => [...W.document.getElementById('el-layer').querySelectorAll('.pin-marker')];

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
  // The well's box (jsdom lays nothing out): the overlay clips every marker to it.
  shell.scrollMetrics(W.document.getElementById('main'), { rect: { left: 0, top: 0, width: 1280, height: 800 } });
});
after(() => shell.restore());

test('comments.js arms no interval: no marker pass (U327b) and no timed fetch — no 30 s or 3 s poll (U304)', () => {
  assert.deepStrictEqual(commentIntervals(), [], 'no markerPass, no refresh, nothing at 500 ms, 3 s or 30 s');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app', 'comments.js'), 'utf8');
  assert.doesNotMatch(src, /\bset(Interval|Timeout)\(/, 'and no timer at all in the module');
  assert.ok(commentGets() >= 1, 'init still reads the pins once');
});

test('a reset frame sends one GET /api/elements?type=comment while visible, none while hidden, and one on the return to visible', async () => {
  const reset = () => shell.frame({ ...helloFrame({ mounts: [PANE] }), type: 'reset' });
  let n = commentGets();
  await reset();
  await shell.tick();
  assert.equal(commentGets(), n + 1, 'visible: a reset is one GET /api/elements?type=comment');

  setVisibility('hidden');
  n = commentGets();
  await reset();
  await reset();
  await shell.tick();
  assert.equal(commentGets(), n, 'hidden: a reset sends nothing');

  setVisibility('visible');
  await shell.tick();
  assert.equal(commentGets(), n + 1, 'the put-off refresh goes out once the tab is visible again');
  await reset();
  await shell.tick();
  assert.equal(commentGets(), n + 2);
});

test('a hello frame triggers one /api/elements?type=comment refresh — and none while hidden', async () => {
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

  // The put-off refresh is sent ONCE: a later hide/show with nothing asked for
  // in between makes no further request.
  setVisibility('hidden');
  setVisibility('visible');
  await shell.tick();
  assert.equal(commentGets(), n + 1, 'a hide/show with nothing put off sends nothing');
});

test('with no pins comments.js reads no layout: a reset and a resize leave the well unread for pins', async () => {
  assert.equal(markers().length, 0, 'precondition: no pins, no markers');
  const spy = spyLayout();
  try {
    await shell.frame({ ...helloFrame({ mounts: [PANE] }), type: 'reset' });
    W.dispatchEvent(new W.Event('resize'));
    await shell.tick();
    assert.equal(spy.queries, 0, 'no shadow-root query');
    assert.equal(markers().length, 0, 'and no marker');
  } finally { spy.restore(); }
  assert.deepStrictEqual(commentIntervals(), [], 'nothing to run on a timer either');
});

test('an element:comment frame draws its marker at once; a reflow the overlay hears re-places it without a rebuild', async () => {
  shell.setRoutes({ '/api/elements?type=comment': { elements: [PIN] } });
  const li = host().shadowRoot.querySelectorAll('li')[1];
  const m = shell.scrollMetrics(li, { rect: { left: 12, top: 34, width: 50, height: 10 } });
  await shell.frame({ type: 'element:comment', elements: [PIN] });
  await waitUntil(() => markers().length === 1 && markers()[0].style.display === '', { what: 'the marker drawn' });
  const marker = markers()[0];
  assert.equal(marker.style.left, '12px');
  assert.equal(marker.style.top, '34px');
  assert.deepStrictEqual(commentIntervals(), [], 'with no interval run');

  m.rect = { left: 70, top: 90, width: 50, height: 10 };
  W.dispatchEvent(new W.Event('resize'));
  await waitUntil(() => markers()[0] && markers()[0].style.left === '70px', { what: 'the reflow followed' });
  assert.equal(markers()[0], marker, 'repositioned, not rebuilt');
});

test('on a hidden page a frame that needs a read puts it off; visible again sends it once', async () => {
  assert.equal(markers().length, 1, 'precondition: the pin from the last test');
  // A pin whose anchor is a 0.8.5 locator the overlay holds no row for: the
  // chrome converts none, so it asks for the read that serves its `record`.
  const legacy = { id: 'c2', text: 'legacy', shared: true, replies: [], anchor: { mount: 'notes', selector: 'li', text: 'one', ordinal: 0 } };
  shell.setRoutes({ '/api/elements?type=comment': { elements: [PIN, { ...legacy, record: convertAnchor(legacy.anchor) }] } });
  setVisibility('hidden');
  const n = commentGets();
  await shell.frame({ type: 'element:comment', elements: [PIN, legacy] });
  await shell.tick();
  assert.equal(commentGets(), n, 'hidden: no read');
  setVisibility('visible');
  await waitUntil(() => commentGets() === n + 1, { what: 'the put-off read' });
  await waitUntil(() => markers().length === 2, { what: 'the legacy pin drawn at its served record' });
  shell.setRoutes({ '/api/elements?type=comment': { elements: [PIN] } });
  await shell.frame({ type: 'element:comment', elements: [PIN] });
  await waitUntil(() => markers().length === 1, { what: 'back to one pin' });
});

test('the last pin going takes its marker down', async () => {
  shell.setRoutes({ '/api/elements?type=comment': { elements: [] } });
  await shell.frame({ type: 'element:comment', elements: [] });
  await waitUntil(() => markers().length === 0, { what: 'the marker taken down' });
  assert.deepStrictEqual(commentIntervals(), [], 'and the idle page has nothing to run');
});

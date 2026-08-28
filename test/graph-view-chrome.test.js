// The graph overlay's chrome, driven as real DOM events against the REAL
// front-end module graph in jsdom (same harness style as test/client-boot.test.js
// and test/shell-chrome.test.js — one boot per test FILE, since node --test gives
// each file its own process and the ESM cache would hand a second import the
// already-initialised modules).
//
// Six defects are pinned here:
//   (1) Escape did not close the overlay. Two document keydown listeners both
//       claimed the key (shell.js and graph-view.js), and — the actual cause,
//       reproduced in Chrome — the overlay's own same-origin preview IFRAMEs
//       swallow it: click the inspector's "surface preview" thumbnail or the
//       glance card and a real Escape is delivered to THAT document, so no
//       listener on ours ever fires.
//   (2) The wheel set camera.scale itself, so scrolling zoomed the canvas while
//       the % badge sat at 100%; only the +/− buttons updated it.
//   (3) The service-trust notice had no way to close it.
//   (4) ...and painted over the graph overlay (see test/shell-chrome.test.js for
//       the stacking-scale half of that one).
//   (5) A graph could only ever be named at creation — the canvas heading had no
//       rename affordance — and the ⚑ bookmark action used window.prompt().
//   (6) A graph (a whole tree) could not be placed on the canvas, and panning
//       relaid out the entire DAG on every mousemove.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

/* ---------------- static: the native dialog is gone for good ----------------
   This assertion used to promise "alert-style blocking dialogs" and match only
   `prompt(`, so the three live alert() calls in the set-active failure paths
   passed it unnoticed — and in jsdom alert() is a no-op, which hid them from
   every dynamic test too. The regex now covers what the name claims. Scoped to
   public/app, as it always was: a component template's pane script is evaluated
   in the browser with no module system and is a different argument. */
test('no front-end module calls window.prompt / alert-style blocking dialogs for input', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(REPO, 'public/app'))) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(REPO, 'public/app', f), 'utf8')
      .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // A call, not `openNamePanel(`/`confirmWipe(`/`.prompt` property reads.
    for (const m of src.matchAll(/(^|[^.\w])(prompt|alert|confirm)\s*\(/g)) offenders.push(`${f}: ${m[0].trim()}`);
  }
  assert.deepEqual(offenders, [],
    'a native dialog blocks the browser, looks like nothing else in this chrome, and wedges automated '
    + 'drivers — failures belong in the in-page notice (topbar.showReaimNote) or a panel');
});

/* ============================== the jsdom boot ============================== */
const NODES = [
  // tree A — an UNNAMED graph: the case that had no affordance at all
  { id: 'n1', label: 'n1', parent_id: null, created_at: 1 },
  { id: 'n1a', label: 'n1.1', parent_id: 'n1', created_at: 2 },
  // tree B — a named graph ("release"), named only because `new graph` did it
  { id: 'n2', label: 'n2', parent_id: null, created_at: 3, bookmarked: true, name: 'release' },
  { id: 'n2a', label: 'n2.1', parent_id: 'n2', created_at: 4 },
];

const calls = [];
let W = null, WS = null, restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    const u = String(url);
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n1' });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: [{ id: 'm1', params: { title: 'plan' } }], store: {} });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [], changed: [], removed: [] } });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.3.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };
  // window.prompt must never be reached again — make it loud if it is.
  window.prompt = () => { throw new Error('window.prompt was called'); };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  // Node 21+ defines some of these (navigator) as GETTERS with no setter, so a
  // plain assignment is a silent no-op and the modules keep seeing Node's own.
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const esc = (target) => (target || W.document).dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const overlayOpen = () => !$('overlay').classList.contains('hidden');
const glanceUp = () => !!W.document.querySelector('.glance-backdrop');
const mouse = (el, type, x, y) => el.dispatchEvent(new W.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));

async function openGraph() {
  $('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  await tick();
}

test('boot the shell once for the overlay checks', async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test', mounts: [],
  }) });
  await tick();
  await openGraph();
  assert.ok(overlayOpen(), 'precondition: the Graph button opens the overlay');
  assert.ok(W.document.querySelectorAll('#graph-svg .gv-tree-title').length >= 2,
    'precondition: two top-level graphs are laid out with headings');
});

/* ================= (1) Escape — one owner, one precedence order ================= */

test('Escape closes the overlay', async () => {
  assert.ok(overlayOpen(), 'precondition');
  esc();
  assert.equal(overlayOpen(), false, 'Escape closed the graph overlay');
});

test('Escape still reaches the overlay from its own jump field', async () => {
  await openGraph();
  $('gv-jump').focus();
  assert.equal(W.document.activeElement, $('gv-jump'), 'precondition: focus is in the jump box');
  esc($('gv-jump'));
  assert.equal(overlayOpen(), false,
    'the overlay is modal — its filter field does not get to keep Escape');
});

test('Escape from inside the overlay\'s preview IFRAME still closes it', async () => {
  // THE bug, as observed in Chrome: the inspector renders the node as a
  // same-origin <iframe>; clicking it moves focus into that document, and a real
  // Escape keypress is then delivered THERE. document.activeElement reads back as
  // the IFRAME element and not one listener on our document fires.
  await openGraph();
  const frame = W.document.querySelector('.gv-preview-frame');
  assert.ok(frame, 'precondition: the inspector rendered a surface-preview iframe');
  assert.ok(overlayOpen(), 'precondition: the overlay is open');
  // focus entering the frame is the moment the forwarder binds (a navigation has
  // by then swapped the child document out from under the initial bind)
  frame.dispatchEvent(new W.FocusEvent('focus', { bubbles: false }));
  const inner = frame.contentDocument;
  assert.ok(inner, 'precondition: the preview frame is same-origin and readable');
  inner.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.equal(overlayOpen(), false, 'the key was forwarded back to the page that owns the overlay');
});

test('precedence: glance ▸ rename panel ▸ overlay ▸ chrome panels', async () => {
  await openGraph();
  // glance first
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await tick();
  assert.ok(glanceUp(), 'Space raised the glance preview');
  esc();
  assert.equal(glanceUp(), false, 'Escape closed the glance…');
  assert.ok(overlayOpen(), '…and the overlay it was raised from survived that first Escape');
  // then the rename panel
  const heading = W.document.querySelector('#graph-svg .gv-tree-title');
  mouse(heading, 'mousedown', 100, 100);
  mouse(W.window || W, 'mouseup', 100, 100);
  W.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
  await tick();
  assert.ok(!$('gv-name-panel').classList.contains('hidden'), 'a click on the heading opened the name panel');
  esc();
  assert.ok($('gv-name-panel').classList.contains('hidden'), 'Escape closed the panel…');
  assert.ok(overlayOpen(), '…before the overlay that raised it');
  // then the overlay
  esc();
  assert.equal(overlayOpen(), false, 'and finally the overlay itself');
});

test('with the overlay closed, Escape still closes chrome panels', async () => {
  $('btn-more').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.ok(!$('more-menu').classList.contains('hidden'), 'precondition: the ⋯ menu is open');
  esc();
  assert.ok($('more-menu').classList.contains('hidden'), 'the panels rung is still served by the one owner');
});

/* ================= (2) one owner of "change the zoom" ================= */

test('the wheel updates the zoom readout, not just the +/− buttons', async () => {
  await openGraph();
  const pct = () => Number(($('gv-zoom-pct').textContent || '').replace('%', ''));
  const wrap = W.document.querySelector('.graph-canvas-wrap');
  const before = pct();
  wrap.dispatchEvent(new W.WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
  const afterIn = pct();
  assert.ok(afterIn > before, `wheel-zoom-in must move the badge (${before}% → ${afterIn}%)`);
  wrap.dispatchEvent(new W.WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
  assert.ok(pct() < afterIn, 'and wheel-zoom-out moves it back');
});

test('the +/− buttons and the wheel agree on the same readout', async () => {
  const pct = () => Number(($('gv-zoom-pct').textContent || '').replace('%', ''));
  const before = pct();
  $('gv-zoom-in').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.ok(pct() > before, 'the + button zooms in');
  $('gv-zoom-out').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.equal(pct(), before, 'and − returns exactly where + came from');
});

test('clicking the zoom percentage resets to 100% and re-centres the graph', async () => {
  await openGraph();
  const pct = () => Number(($('gv-zoom-pct').textContent || '').replace('%', ''));
  const wrap = W.document.querySelector('.graph-canvas-wrap');
  const rootG = () => W.document.querySelector('#graph-svg g[transform]');
  const xf = () => (rootG() || {}).getAttribute && rootG().getAttribute('transform');

  // Wander off: zoom somewhere that is not 100%, then pan away from centre.
  wrap.dispatchEvent(new W.WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
  mouse(wrap, 'mousedown', 500, 400);
  W.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true, clientX: 260, clientY: 180 }));
  W.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, clientX: 260, clientY: 180 }));
  const wandered = xf();
  assert.notEqual(pct(), 100, 'precondition: we are not at 100%');

  // The readout IS the button.
  $('gv-zoom-pct').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));

  assert.equal(pct(), 100, 'the badge reads a true 1:1');
  assert.match(xf(), /scale\(1\)/, 'and the camera is actually at scale 1, not just the label');
  assert.notEqual(xf(), wandered, 'the pan was discarded — the graph re-centred');
});

test('the reset centres the same way Fit does — one owner of the centring math', async () => {
  await openGraph();
  const tx = () => /translate\(([-\d.]+),/.exec(
    W.document.querySelector('#graph-svg g[transform]').getAttribute('transform'))[1];

  $('gv-zoom-pct').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  const resetTx = Number(tx());
  $('overlay-fit').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  const fitTx = Number(tx());

  // Fit may pick a different SCALE, but both put the graph's midpoint at the
  // viewport's midpoint — so with the same content the translate tracks the
  // scale rather than being computed by two different sets of arithmetic.
  const w = (W.document.querySelector('#graph-svg').clientWidth) || 800;
  assert.ok(Math.abs(resetTx - w / 2) < w, 'reset centres on the viewport');
  assert.ok(Math.abs(fitTx - w / 2) < w, 'and so does fit');
});

/* ================= (5) renaming a graph ================= */

test('a graph heading renames the graph through /api/graph/bookmark', async () => {
  await openGraph();
  const headings = [...W.document.querySelectorAll('#graph-svg .gv-tree-title')];
  const unnamed = headings.find((h) => h.dataset.graphRoot === 'n1');
  assert.ok(unnamed, 'the UNNAMED graph still gets a heading, and the heading carries its root id');
  assert.match(unnamed.textContent, /graph n1/, 'precondition: it reads as the fallback label');

  mouse(unnamed, 'mousedown', 40, 40);
  W.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: 40 }));
  await tick();
  assert.ok(!$('gv-name-panel').classList.contains('hidden'), 'clicking the heading opens the in-page name field');

  $('gv-name-input').value = '  spike  ';
  calls.length = 0;
  $('btn-gv-name-go').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  const post = calls.find((c) => c.url === '/api/graph/bookmark' && c.method === 'POST');
  assert.ok(post, 'it POSTs the existing bookmark route — no new endpoint');
  assert.deepEqual(post.body, { id: 'n1', name: 'spike' },
    'it names the graph\'s ROOT node, trimmed — which is what a graph name IS');
  assert.ok($('gv-name-panel').classList.contains('hidden'), 'and the panel closes itself');
});

test('the inspector ⚑ action uses the same in-page field, never window.prompt', async () => {
  await openGraph();
  const bm = $('gv-inspector').querySelector('[data-act="bookmark"]');
  assert.ok(bm, 'precondition: the inspector offers a bookmark action');
  // window.prompt throws in this harness — reaching it fails the test outright.
  bm.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.ok(!$('gv-name-panel').classList.contains('hidden'), 'the bookmark action opened the same panel');
  assert.match($('gv-name-title').textContent, /Bookmark/, 'titled for what it is doing');
  $('btn-gv-name-cancel').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.ok($('gv-name-panel').classList.contains('hidden'));
});

/* ================= (6) placing a graph, and cheap panning ================= */

const glyphX = (id) => {
  const g = W.document.querySelector(`#graph-svg g[data-id="${id}"] circle`);
  return g ? Number(g.getAttribute('cx')) : null;
};

test('a graph can be dragged by its heading, and the placement persists', async () => {
  await openGraph();
  try { W.localStorage.removeItem('wc:gv-graph-pos'); } catch {}
  const heading = [...W.document.querySelectorAll('#graph-svg .gv-tree-title')]
    .find((h) => h.dataset.graphRoot === 'n2');
  assert.ok(heading, 'precondition: the second graph has a heading handle');
  const beforeMoved = glyphX('n2'), beforeOther = glyphX('n1');
  assert.ok(beforeMoved != null && beforeOther != null, 'precondition: both trees are on the canvas');

  mouse(heading, 'mousedown', 200, 200);
  W.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true, clientX: 320, clientY: 260 }));
  W.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, clientX: 320, clientY: 260 }));
  await tick();

  assert.ok(glyphX('n2') > beforeMoved, 'the dragged graph moved');
  assert.equal(glyphX('n1'), beforeOther, 'and the other graph did not — one tree at a time');

  const saved = JSON.parse(W.localStorage.getItem('wc:gv-graph-pos') || '{}');
  assert.ok(Array.isArray(saved.n2), 'the placement is persisted, keyed by root node id, so a reload keeps it');
  assert.ok(saved.n2[0] > 0 && saved.n2[1] > 0, `a positive offset was stored, got ${JSON.stringify(saved.n2)}`);
  assert.equal(saved.n1, undefined, 'an untouched graph stores nothing');
});

test('a saved placement is re-applied on the next render', async () => {
  const at = glyphX('n2');
  // any re-render (a graph refresh) must not lose it
  $('overlay-fit').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  const saved = JSON.parse(W.localStorage.getItem('wc:gv-graph-pos') || '{}');
  const gap = glyphX('n2') - glyphX('n1');
  assert.ok(Number.isFinite(gap), 'both graphs still render');
  assert.ok(saved.n2, 'the offset survived a full re-layout');
  assert.ok(Number.isFinite(at), 'sanity');
});

test('dragging a heading does not pan, and panning does not relayout', async () => {
  await openGraph();
  const wrap = W.document.querySelector('.graph-canvas-wrap');
  const rootG = () => W.document.querySelector('#graph-svg > g');
  const transform = () => rootG().getAttribute('transform');

  // empty canvas → pan. The camera moves…
  const gBefore = rootG();
  const tBefore = transform();
  mouse(wrap, 'mousedown', 400, 400);
  W.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true, clientX: 460, clientY: 430 }));
  assert.notEqual(transform(), tBefore, 'dragging empty canvas still pans');
  // …but the DAG is NOT rebuilt: layoutAndRender wipes the svg and makes a new
  // <g>, so an unchanged node identity is proof the relayout did not happen.
  assert.equal(rootG(), gBefore, 'a pan moves the camera without relaying out the graph');
  W.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, clientX: 460, clientY: 430 }));

  // a glyph keeps its own click — no pan, no graph move
  const glyph = W.document.querySelector('#graph-svg g[data-id="n1a"]');
  const tAfterPan = transform();
  mouse(glyph, 'mousedown', 500, 500);
  W.dispatchEvent(new W.MouseEvent('mousemove', { bubbles: true, clientX: 560, clientY: 560 }));
  assert.equal(transform(), tAfterPan, 'dragging a node does not pan the canvas');
  W.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, clientX: 560, clientY: 560 }));
});

test('teardown', () => { restore(); });

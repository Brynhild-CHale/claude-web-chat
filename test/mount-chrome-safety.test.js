// A mount id (or target) is agent-supplied text: /api/render accepts any string
// for either, and the MCP schema is a bare `type: 'string'`. The client used to
// resolve both against the WHOLE document — `document.getElementById(id)` for the
// stale-host sweep, `$(target)` for the slot — so 'main', 'topbar', 'status' and
// 'overlay' (all plausible ids for Claude to pick, and 'overlay' is one the
// service-trust prompt actually shipped with) removed or hijacked that chrome.
// The damage persisted: the mount lives in state.mounts and in every committed
// node, so `hello` replayed it on every reload and every later mount threw on a
// null slot — the surface stayed dead until the mount was cleared from outside
// the browser.
//
// Pinned here (same jsdom harness as test/shell-chrome.test.js — one boot per
// file, because the ESM cache hands a second import the same modules):
//   1. a mount whose id names chrome leaves that chrome standing;
//   2. a render whose target names chrome lands in the surface anyway;
//   3. a clear whose id names chrome removes nothing;
//   4. ...and the real behaviour this must not break: a re-render replaces in
//      place, and a stale bare mount host is still reaped;
//   5. one mount that throws does not abort the rest of the `hello` frame — and
//      leaves no half-built pane behind for the next render to stack onto;
//   6. a mount whose id names chrome does not HIJACK it either: the shell looks
//      its own chrome up live (`$` is document.getElementById), so a pane host
//      that took the id would win every later lookup — persistently, because the
//      mount replays on every hello. And the mirror image: a comment pin anchored
//      to such a pane still resolves, because anchors go through hostFor too;
//   7. a clear-all sweeps panes rendered with ANY target, and a targeted clear
//      sweeps only its own — the filter POST /api/clear applies server-side.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

let W = null, WS = null, restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, ''); // strip scripts; we load the modules ourselves
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url) => {
    if (url === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (url === '/api/components') return json({ components: [] });
    if (url === '/api/packs') return json({ ok: true, packs: [], quarantined: [] });
    if (url === '/api/services/pending') return json({ ok: true, pending: [] });
    if (url === '/api/themes') return json({ themes: [] });
    if (url === '/api/queue') return json({ items: [], count: 0 });
    if (url === '/api/queue/pending') return json({ pending: null });
    if (url === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (String(url).startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element'];
  // Node 21+ defines some of these (navigator) as GETTERS with no setter, so a
  // plain assignment is a silent no-op and the modules keep seeing Node's own.
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0; // no pollers keeping the process alive
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
const frame = (obj) => WS.onmessage({ data: JSON.stringify(obj) });

// Chrome elements captured BEFORE anything hostile arrives — the assertions ask
// whether *these* nodes are still in the document, which an id collision would
// otherwise hide (a fresh getElementById could find the pane host instead).
let mainEl = null, topbarEl = null, statusEl = null, overlayEl = null;

test('a mount whose id names chrome leaves the chrome standing', async () => {
  await boot();
  await tick();
  mainEl = $('main'); topbarEl = $('topbar'); statusEl = $('status'); overlayEl = $('overlay');
  assert.ok(mainEl && topbarEl && statusEl && overlayEl, 'precondition: the shell rendered its chrome');

  frame({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: [
      { id: 'main', html: '<p>hijack the surface slot</p>', target: 'main', params: {}, pane_state: {} },
      { id: 'topbar', html: '<p>hijack the header</p>', target: 'main', params: {}, pane_state: {} },
      { id: 'overlay', html: '<p>hijack the graph viewer</p>', target: 'main', params: {}, pane_state: {} },
      { id: 'ok1', html: '<p>an ordinary pane</p>', target: 'main', params: {}, pane_state: {} },
    ],
  });
  await tick();

  assert.ok(mainEl.isConnected, '#main survived a mount that named it');
  assert.ok(topbarEl.isConnected, '#topbar survived a mount that named it');
  assert.ok(overlayEl.isConnected, '#overlay survived a mount that named it');
  assert.equal(mainEl.querySelectorAll('.pane').length, 4, 'all four panes mounted into the surface');
  // ...and the rest of `hello` still ran, which a null slot used to abort.
  assert.ok($('active-pill').textContent.includes('n1'), 'hello finished: the active pill is set');
});

test('a render whose target names chrome lands in the surface, not in the chrome', async () => {
  frame({ type: 'render', id: 'p-target', html: '<b>two</b>', target: 'topbar', params: {}, pane_state: {} });
  await tick();
  assert.equal(topbarEl.querySelectorAll('.pane').length, 0, 'no pane was appended inside the header');
  const pane = mainEl.querySelector('[data-pane-id="p-target"]');
  assert.ok(pane, 'the pane mounted into the surface slot instead');
});

test('a clear whose id names chrome removes nothing', async () => {
  frame({ type: 'clear', id: 'status' });
  await tick();
  assert.ok(statusEl.isConnected, 'the connection pill survived a clear that named it');
  assert.equal(statusEl.parentElement, topbarEl, 'and is still in the topbar');
});

test('a legitimate re-render still replaces in place, and a stale bare host is still reaped', async () => {
  frame({ type: 'render', id: 'ok1', html: '<p id="fresh">re-rendered</p>', target: 'main', params: {}, pane_state: {} });
  await tick();
  assert.equal(mainEl.querySelectorAll('[data-pane-id="ok1"]').length, 1, 're-rendering an id replaces its pane in place');

  // The legacy shape the stale sweep exists for: a bare .mount-host with no pane
  // record (an older session's DOM). It must still be removed on re-render.
  const legacy = W.document.createElement('div');
  legacy.id = 'legacy-host';
  legacy.className = 'mount-host';
  mainEl.appendChild(legacy);
  frame({ type: 'render', id: 'legacy-host', html: '<p>new</p>', target: 'main', params: {}, pane_state: {} });
  await tick();
  assert.equal(legacy.isConnected, false, 'the stale bare mount host was removed');
  assert.ok(mainEl.querySelector('[data-pane-id="legacy-host"]'), 'and its id now belongs to a real pane');
});

test('one mount that throws does not abort the rest of a hello', async () => {
  const realAttach = W.__wcMount.attachAndExtract;
  const realError = console.error;
  console.error = () => {};
  W.__wcMount.attachAndExtract = (host, html) => {
    if (String(html).includes('BOOM')) throw new Error('mount blew up');
    return realAttach(host, html);
  };
  try {
    frame({
      type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'after-boom',
      mounts: [
        { id: 'bad', html: '<p>BOOM</p>', target: 'main', params: {}, pane_state: {} },
        { id: 'good', html: '<p>fine</p>', target: 'main', params: {}, pane_state: {} },
      ],
    });
    await tick();
    assert.ok(mainEl.querySelector('[data-pane-id="good"]'), 'the mount after the failing one still rendered');
    assert.equal(W.document.title, 'after-boom — web-chat', 'the rest of the hello frame still ran');
    // The wrapper is in the DOM before the shadow root is attached, so a failure
    // used to leave an empty .pane with no pane record behind it.
    assert.equal(mainEl.querySelectorAll('[data-pane-id="bad"]').length, 0, 'the failed mount left no half-built pane');
  } finally {
    W.__wcMount.attachAndExtract = realAttach;
    console.error = realError;
  }

  // ...and re-rendering that id now yields ONE pane, not a second wrapper beside
  // the orphan.
  frame({ type: 'render', id: 'bad', html: '<p>recovered</p>', target: 'main', params: {}, pane_state: {} });
  await tick();
  assert.equal(mainEl.querySelectorAll('[data-pane-id="bad"]').length, 1, 'the id re-renders into a single pane');
});

test('a mount whose id names chrome does not hijack the shell\'s live lookups', async () => {
  const minbarEl = $('minbar'), drawerEl = $('drawer'), railEl = $('queue-rail');
  assert.ok(minbarEl && drawerEl && railEl, 'precondition: the chrome after <main> exists');

  frame({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'hijack',
    mounts: [
      { id: 'minbar', html: '<p>shadow the minbar</p>', target: 'main', params: {}, pane_state: {} },
      { id: 'drawer', html: '<p>shadow the drawer</p>', target: 'main', params: {}, pane_state: {} },
      { id: 'queue-rail', html: '<p>shadow the rail</p>', target: 'main', params: {}, pane_state: {} },
    ],
  });
  await tick();

  // These ids all sit AFTER <main> in document order, so a host that took the id
  // would be the one getElementById returns — and $ in state.js is a live
  // getElementById, called on every renderMinbar / drawer open / rail update.
  for (const [id, el] of [['minbar', minbarEl], ['drawer', drawerEl], ['queue-rail', railEl]]) {
    assert.equal(W.document.getElementById(id), el, `#${id} still resolves to the chrome, not a pane host`);
    assert.ok(mainEl.querySelector(`[data-pane-id="${id}"]`), `the pane named ${id} mounted anyway`);
  }

  // The functional half: the chrome those lookups drive still works.
  frame({ type: 'render', id: 'chip', html: '<p>minimized</p>', target: 'main', params: {}, pane_state: { minimized: true } });
  await tick();
  assert.ok(minbarEl.querySelector('.min-chip'), 'the minbar still gets the minimized pane\'s chip');

  $('btn-add').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(drawerEl.classList.contains('hidden'), false, 'the ＋ button still opens the real drawer');
  $('btn-add').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(drawerEl.classList.contains('hidden'), true, 'and still closes it');

  // The mirror image: a comment pin stores the MOUNT id (captureAnchor writes
  // host.dataset.mountId), so resolving it back with document.getElementById
  // would hand comments.js the chrome element — no shadow root, no marker, the
  // pin silently dropped from the layer even though the server still holds it.
  frame({
    type: 'comments',
    comments: [{ id: 'c1', shared: true, text: 'x', anchor: { mount: 'drawer', selector: 'p', ordinal: 0, text: 'shadow the drawer' } }],
  });
  await tick();
  assert.equal($('pin-layer').querySelectorAll('.pin-marker').length, 1,
    'the pin on the chrome-named pane resolved to its host and drew a marker');
  frame({ type: 'comments', comments: [] });
  await tick();
});

test('a clear-all sweeps every target; a targeted clear sweeps only its own', async () => {
  frame({ type: 'render', id: 'side-pane', html: '<p>side</p>', target: 'side', params: {}, pane_state: {} });
  frame({ type: 'render', id: 'main-pane', html: '<p>main</p>', target: 'main', params: {}, pane_state: {} });
  await tick();
  // A non-slot target still lands in the surface (there is one slot), but the
  // pane REMEMBERS the target it was rendered with — that is what a clear filters on.
  assert.ok(mainEl.querySelector('[data-pane-id="side-pane"]'), 'the off-slot pane mounted into the surface');

  frame({ type: 'clear', target: 'main' });
  await tick();
  assert.equal(mainEl.querySelectorAll('[data-pane-id="main-pane"]').length, 0, "clear{target:'main'} swept the 'main' pane");
  assert.equal(mainEl.querySelectorAll('[data-pane-id="side-pane"]').length, 1, "...and spared the 'side' pane");

  // No target means EVERY pane — the server's filter is `!target || m.target ===
  // target`, so a client that read an absent target as 'main' would leave the
  // off-target panes standing after the server dropped them from state.mounts.
  frame({ type: 'clear' });
  await tick();
  assert.equal(mainEl.querySelectorAll('.pane').length, 0, 'clear-all swept every pane, whatever its target');
});

test.after(async () => { await new Promise((r) => setTimeout(r, 400)); restore(); });

// leavePreview() — the ONE owner of the exit-preview transition, driven as real
// DOM against the real front-end module graph in jsdom (same harness style as
// test/graph-view-chrome.test.js; one boot per test FILE).
//
// Three lines — `view.previewing = false`, drop `liveSnapshot`, un-gate #main —
// used to be hand-copied to EIGHT places: topbar.js x4 (completeBranchTransition,
// returnToActive, doWipe, and the since-removed setActiveHere), graph-view.js x2 (setActive, the glance
// "set as active"), ws.js's reset handler and shell.js's startNewGraph. They had
// drifted, and `previewing` is the flag state.js says GATES all writes — so a
// copy out of step is a preview mutating the live node.
//
// This file pins the behaviours that differ between the copies, which is
// exactly what the engine's options have to keep true:
//   1. restoreSnapshot — returnToActive re-renders the captured live surface
//   2. read-only       — the preview is READ-ONLY (plan §2b D2): an edit in a
//                        previewed pane is refused and never re-aims the graph
//                        (branch-on-edit and its flushForms option are gone)
//   3. body.pending    — a queued re-aim must NOT leave preview at all; the three
//                        callers that carry that branch keep it
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

// n1 (active, the live surface) ── n2 (an older-node preview target)
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];

// Panes each committed node carries, so a preview swap is visible in the DOM.
const NODE_MOUNTS = {
  n1: [{ id: 'm-live', html: '<p>live</p>', target: 'main', params: {}, pane_state: {} }],
  n2: [{ id: 'm-old', html: '<input id="f" value="typed">', target: 'main', params: {}, pane_state: {} }],
};

// Flipped per test: the server's answer to a re-aim while Claude holds the lock,
// and whether POST /api/graph/active refuses outright.
let PENDING = false;
let ACTIVE_FAILS = false;

const calls = [];
let W = null, WS = null, sent = [], restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send(d) { sent.push(JSON.parse(d)); }
    close() {}
  };
  // The chrome must never reach for a native dialog: it blocks the browser and
  // wedges an automated driver. Make both loud rather than the silent no-ops
  // jsdom ships, so the set-active failure path cannot hide here.
  window.alert = () => { throw new Error('window.alert was called'); };
  window.prompt = () => { throw new Error('window.prompt was called'); };
  window.confirm = () => { throw new Error('window.confirm was called'); };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n1' });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: (NODE_MOUNTS[id] || []).map((m) => ({ ...m })), store: {} });
    }
    if (u === '/api/graph/active' && ACTIVE_FAILS) {
      return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'the turn lock is held' }), text: async () => '' };
    }
    if (u === '/api/graph/wipe' || u === '/api/graph/new' || u === '/api/graph/active') {
      return json({ ok: true, pending: PENDING });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [], changed: [], removed: [] } });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.6.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  // The re-aim note removes itself after 6s. Nothing here tests that, and a timer
  // that outlives the window would fire against a torn-down document — so drop
  // the long ones instead of keeping the process alive to watch them.
  const savedSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => (ms >= 5000 ? 0 : savedSetTimeout(fn, ms, ...rest));
  global.requestAnimationFrame = (fn) => savedSetTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    global.setTimeout = savedSetTimeout;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const click = (id) => $(id).dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
const previewing = () => $('main').classList.contains('preview-readonly');
const paneIds = () => [...W.document.querySelectorAll('#main .mount-host')].map((h) => h.dataset.mountId || h.id);
const noteText = () => { const n = $('reaim-note'); return n ? n.textContent : ''; };

test('boot the shell once, live on n1', async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: NODE_MOUNTS.n1.map((m) => ({ ...m })),
  }) });
  await tick();
  assert.deepEqual(paneIds(), ['m-live'], 'precondition: the live surface is up');
  assert.equal(previewing(), false, 'precondition: not detached');
});

/* ---------- 0. restoreSnapshot with nothing captured ---------- */

// Every re-aim passes restoreSnapshot — a Wipe from the live page does too — but
// only a preview captured a live surface to go back to. With none, the live
// surface and its theme are already on screen, and re-applying the theme only
// ran a transition over a page that had not changed.
test('leavePreview({restoreSnapshot:true}) while not previewing starts no theme transition', async () => {
  const { leavePreview } = await import(pathToFileURL(path.join(REPO, 'public/app/topbar.js')).href);
  const theming = () => W.document.documentElement.classList.contains('wc-theming');
  assert.equal(previewing(), false, 'precondition: live, not previewing');
  assert.equal(theming(), false, 'precondition: no theme transition running');
  leavePreview({ restoreSnapshot: true });
  assert.equal(theming(), false, 'nothing changed on screen, so nothing animates');
  assert.deepEqual(paneIds(), ['m-live'], 'and the live surface is left as it was');
});

/* ---------- 1. restoreSnapshot ---------- */

test('previewing an older node detaches and swaps the surface', async () => {
  click('btn-down');            // n1 → its only child, n2
  await tick();
  assert.deepEqual(paneIds(), ['m-old'], 'the previewed node’s panes replaced the live ones');
  assert.equal(previewing(), true, 'and #main is gated read-only');
});

test('returnToActive restores the captured live surface', async () => {
  click('btn-return-active');
  await tick();
  assert.equal(previewing(), false, 'the detached gate is off');
  assert.deepEqual(paneIds(), ['m-live'],
    'restoreSnapshot re-rendered the live surface captured on the way in — the option ' +
    'returnToActive is the only caller of, and the copy that consumed liveSnapshot before nulling it');
  assert.ok($('active-pill').textContent.includes('n1.0'), 'and the chip is back on the active node');
});

/* ---------- 2. the preview is read-only ---------- */

test('an edit in a previewed pane is refused, says how to edit, and re-aims nothing', async () => {
  click('btn-down');            // detach onto n2 again
  await tick();
  assert.equal(previewing(), true, 'precondition: detached on n2');
  sent.length = 0;
  const before = calls.length;

  const host = W.document.querySelector('#main .mount-host');
  const input = host.shadowRoot.getElementById('f');
  const key = new W.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true, composed: true });
  input.dispatchEvent(key);
  await tick();

  assert.equal(key.defaultPrevented, true, 'the keystroke is refused');
  assert.match(noteText(), /set this node active in the graph to edit/i, 'and the user is told how to edit');
  assert.equal(previewing(), true, 'the preview stays up — editing no longer branches');
  assert.ok(!calls.slice(before).some((c) => c.method === 'POST'),
    'nothing was POSTed — no /api/graph/branch-here, no re-aim of any kind');
  assert.ok(!sent.some((f) => f.type === 'pane:form' || f.type === 'pane:state'), 'and nothing reached the live surface');
  assert.ok(host.hasAttribute('data-wc-readonly'), 'the pane is marked read-only for the faint-controls sheet');
});

/* ---------- 3. body.pending — a queued re-aim never leaves preview ---------- */

test('a wipe queued behind a locked turn keeps the preview up', async () => {
  assert.equal(previewing(), true, 'precondition: still detached on n2');

  PENDING = true;
  click('btn-wipe-go');
  await tick();
  assert.equal(previewing(), true, 'the server queued the wipe — leaving preview here would strand the client');
  assert.match(noteText(), /mid-turn/, 'and the user is told the click was honoured, just deferred');
});

// (The surface's own "set active here" is gone — set-active is a graph-screen
// action now — so its queued-re-aim case is the overlay's, pinned below.)

test('a new graph queued behind a locked turn keeps the preview up', async () => {
  assert.equal(previewing(), true, 'precondition: still detached');
  click('btn-new-graph-go');
  await tick();
  assert.equal(previewing(), true, 'the new graph starts when the turn ends — not now');
  assert.match(noteText(), /mid-turn/, 'and says so');
});

/* ---------- the graph overlay's own set-active, which lacked both branches ---------- */

test('the graph overlay honours a queued re-aim instead of dropping the preview', async () => {
  assert.equal(previewing(), true, 'precondition: still detached');
  click('btn-graph');
  await tick(); await tick();
  const glyph = W.document.querySelector('#graph-svg g[data-id="n2"], #gv-world .gv-srow[data-id="n2"]');
  glyph.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();

  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await tick();
  assert.match(noteText(), /Queued/, 'the overlay says what the topbar has always said');
  assert.equal(previewing(), true,
    'this path used to run the bare three-line transition with no pending branch, so a locked turn '
    + 'left the client detached-but-not-previewing: an old node on screen, treated as live');
  PENDING = false;
});

test('a refused Set active surfaces in the page, never in a blocking dialog', async () => {
  ACTIVE_FAILS = true;
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await tick();
  assert.match(noteText(), /Could not set active/, 'the failure is visible');
  assert.match(noteText(), /the turn lock is held/, 'and carries the server’s reason');
  assert.equal(previewing(), true, 'and nothing moved');
  ACTIVE_FAILS = false;
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
});

/* ---------- the server-driven copy ---------- */

test('a reset that lands active where this client is previewing re-attaches it', async () => {
  assert.equal(previewing(), true, 'precondition: detached on n2');
  WS.onmessage({ data: JSON.stringify({
    type: 'reset', active: 'n2', lock: null, theme: null, activeTheme: null, store: {},
    mounts: NODE_MOUNTS.n2.map((m) => ({ ...m })),
  }) });
  await tick();
  assert.equal(previewing(), false,
    'the queued re-aim applied at turn-end — attach rather than sit half-detached (previewing with viewedId === activeId)');
  assert.deepEqual(paneIds(), ['m-old'], 'and the authoritative frame is rendered verbatim');
  const host = W.document.querySelector('#main .mount-host');
  assert.equal(host.hasAttribute('data-wc-readonly'), false, 'the now-live pane is editable again');
  const key = new W.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true, composed: true });
  host.shadowRoot.getElementById('f').dispatchEvent(key);
  assert.equal(key.defaultPrevented, false, 'typing is no longer refused once the node is active');
  // Let the deferred 340ms theme-transition strip fire while the window is still
  // valid, so nothing runs against a torn-down document.
  await new Promise((r) => setTimeout(r, 400));
  restore();
});

// leavePreview() — the ONE owner of the exit-preview transition, driven as real
// DOM against the real front-end module graph in jsdom (same harness style as
// test/graph-view-chrome.test.js; one boot per test FILE).
//
// Three lines — `view.previewing = false`, drop `liveSnapshot`, un-gate #main —
// used to be hand-copied to EIGHT places: topbar.js x4 (completeBranchTransition,
// returnToActive, doWipe, setActiveHere), graph-view.js x2 (setActive, the glance
// "set as active"), ws.js's reset handler and shell.js's startNewGraph. They had
// drifted, and `previewing` is the flag state.js says GATES all writes — so a
// copy out of step is a preview mutating the live node.
//
// This file pins the three behaviours that differ between the copies, which is
// exactly what the engine's options have to keep true:
//   1. restoreSnapshot — returnToActive re-renders the captured live surface
//   2. flushForms      — branch-on-edit releases the gated form values, and does
//                        so AFTER previewing drops (the flush is a no-op while it
//                        is still set, so the ordering is the behaviour)
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

// Flipped per test: the server's answer to a re-aim while Claude holds the lock.
let PENDING = false;

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
    if (u === '/api/graph/branch-here' || u === '/api/graph/wipe' || u === '/api/graph/new' || u === '/api/graph/active') {
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

/* ---------- 2. flushForms (and its ordering) ---------- */

test('branch-on-edit leaves preview and flushes the gated form values', async () => {
  click('btn-down');            // detach onto n2 again
  await tick();
  assert.equal(previewing(), true, 'precondition: detached on n2');
  sent.length = 0;

  // What a pane's delegated input listener raises when the user edits a form
  // while detached (mounts.js → topbar.branchOnEdit).
  W.dispatchEvent(new W.CustomEvent('wc:edit-in-preview'));
  await tick();

  assert.ok(calls.some((c) => c.url === '/api/graph/branch-here' && c.body && c.body.id === 'n2'),
    'the re-aim was requested for the node being viewed');
  assert.equal(previewing(), false, 'the transition completed locally — no re-render, the DOM IS the new live state');
  assert.deepEqual(paneIds(), ['m-old'], 'and deliberately nothing was re-rendered over it');
  assert.ok($('active-pill').textContent.includes('n1.1'), 'active moved with it (the activeId option)');
  assert.ok(sent.some((f) => f.type === 'pane:form' && f.id === 'm-old'),
    'the gated form values were flushed — and only because the flush runs AFTER previewing drops; ' +
    'sendFormState is a no-op while it is still set');
});

/* ---------- 3. body.pending — a queued re-aim never leaves preview ---------- */

test('a wipe queued behind a locked turn keeps the preview up', async () => {
  click('btn-up');              // detach again: n2 is active now, so ↑ previews n1
  await tick();
  assert.equal(previewing(), true, 'precondition: detached on n1');

  PENDING = true;
  click('btn-wipe-go');
  await tick();
  assert.equal(previewing(), true, 'the server queued the wipe — leaving preview here would strand the client');
  assert.match(noteText(), /mid-turn/, 'and the user is told the click was honoured, just deferred');
});

test('a set-active-here queued behind a locked turn keeps the preview up', async () => {
  assert.equal(previewing(), true, 'precondition: still detached');
  click('btn-set-active-here');
  await tick();
  assert.equal(previewing(), true, 'stay detached; the turn-end apply broadcasts a reset that lands everywhere');
  assert.match(noteText(), /Queued/, 'the queued jump is announced');
});

test('a new graph queued behind a locked turn keeps the preview up', async () => {
  assert.equal(previewing(), true, 'precondition: still detached');
  click('btn-new-graph-go');
  await tick();
  assert.equal(previewing(), true, 'the new graph starts when the turn ends — not now');
  assert.match(noteText(), /mid-turn/, 'and says so');
  PENDING = false;
});

/* ---------- the server-driven copy ---------- */

test('a reset that lands active where this client is previewing re-attaches it', async () => {
  assert.equal(previewing(), true, 'precondition: detached on n1');
  WS.onmessage({ data: JSON.stringify({
    type: 'reset', active: 'n1', lock: null, theme: null, activeTheme: null, store: {},
    mounts: NODE_MOUNTS.n1.map((m) => ({ ...m })),
  }) });
  await tick();
  assert.equal(previewing(), false,
    'the queued re-aim applied at turn-end — attach rather than sit half-detached (previewing with viewedId === activeId)');
  assert.deepEqual(paneIds(), ['m-live'], 'and the authoritative frame is rendered verbatim');
  // Let the deferred 340ms theme-transition strip fire while the window is still
  // valid, so nothing runs against a torn-down document.
  await new Promise((r) => setTimeout(r, 400));
  restore();
});

// A re-aim made while previewing a DIFFERENT node — Set active (the graph
// screen's A / Set active / ⑃ Branch, all one postSetActive), ⋯ Wipe, and New
// graph — driven as real DOM against the real front-end module graph in jsdom
// (same harness style as test/leave-preview-chrome.test.js; one boot per test
// FILE, in a `before` hook).
//
// The daemon broadcasts the `reset` frame BEFORE it answers the POST
// (routes/graph.js execSetActive / execWipe / execNewGraph call broadcastReset()
// and only then return the body res.json sends), so the frame normally reaches
// the page first. While previewing, a reset for any node other than the one on
// screen is FOLDED into view.liveSnapshot (applySnapshot's preview fork). The
// three callers then left the preview with a bare leavePreview(), which threw
// that snapshot away without rendering it: the previewed node's panes stayed on
// screen as the live, editable surface — read-only gate off, viewedId still the
// old node, the pill still "viewing" it — until the next reset or reconnect.
// Typing into one of those panes sent pane:form for a live pane of the same id.
//
// Both arrival orders are pinned: the real one (reset first), and the answer
// arriving first, where the late reset re-renders authoritatively.
//
// Every node carries its pane under ONE id (`m-form`), as stable ids make the
// common case: that is what let the previewed node's pane pass for the live one,
// and what makes the pane:form check below able to fail — the user types, and
// the frame must carry the live value, not the previewed node's.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');

// n1 (active, the live surface) ── n2 (the previewed node) ── n3 (a Set active target)
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: 3 },
];
const NODE_MOUNTS = {
  n1: [{ id: 'm-form', html: '<input id="f" value="live">', target: 'main', params: {}, pane_state: { pinned: true } }],
  n2: [{ id: 'm-form', html: '<input id="f" value="old">', target: 'main', params: {}, pane_state: {} }],
  n3: [{ id: 'm-form', html: '<input id="f" value="three">', target: 'main', params: {}, pane_state: {} }],
};
const mountsOf = (id) => (NODE_MOUNTS[id] || []).map((m) => ({ ...m, pane_state: { ...m.pane_state } }));
const resetFrame = (active, mounts) => ({ type: 'reset', store: {}, theme: null, activeTheme: null, active, lock: null, mounts });

// The graph's active node as the daemon reports it (GET /api/graph).
let ACTIVE = 'n1';
// What a re-aim POST does on the daemon: move ACTIVE, broadcast `reset`, answer.
// `resetFirst` false holds the frame back so the test can deliver it after the
// answer instead.
let REAIM = null;   // { active, reset, answer, resetFirst }

const REAIM_POSTS = new Set(['/api/graph/active', '/api/graph/wipe', '/api/graph/new']);
const calls = [];
const sent = [];
let W = null, WS = null, view = null, savedGlobals = null, savedTimers = null;

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const click = (id) => $(id).dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
const key = (k) => W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const frame = (msg) => WS.onmessage({ data: JSON.stringify(msg) });
const readonlyGate = () => $('main').classList.contains('preview-readonly');
const overlayOpen = () => !$('overlay').classList.contains('hidden');
const hosts = () => [...W.document.querySelectorAll('#main .mount-host')];
const paneIds = () => hosts().map((h) => h.dataset.mountId || h.id);
const fieldValues = () => hosts().map((h) => h.shadowRoot.getElementById('f').value);
const selectInGraph = async (id) => {
  const g = W.document.querySelector(`#graph-svg g[data-id="${id}"], #gv-world .gv-srow[data-id="${id}"]`);
  g.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
};

before(async () => {
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
    const method = (opts && opts.method) || 'GET';
    calls.push({ url: u, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (method === 'POST' && REAIM_POSTS.has(u) && REAIM) {
      ACTIVE = REAIM.active;
      if (REAIM.resetFirst) {
        // broadcastReset() runs before res.json(): the frame is on the socket, and
        // its own graph refresh settles, before the POST's answer arrives.
        frame(REAIM.reset);
        await tick();
      }
      return json(REAIM.answer);
    }
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: ACTIVE });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: mountsOf(id), store: {} });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [], changed: [], removed: [] } });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.8.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
    return json({ ok: true });
  };

  savedGlobals = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  for (const k of keys) {
    try { savedGlobals[k] = global[k]; } catch {}
    try { Object.defineProperty(global, k, { value: window[k], configurable: true, writable: true }); }
    catch { try { global[k] = window[k]; } catch {} }
  }
  savedTimers = { setInterval: global.setInterval, setTimeout: global.setTimeout };
  global.setInterval = () => 0;
  // The re-aim note removes itself after 6s; nothing here tests that, so drop
  // the long timers rather than keep the process alive for them.
  global.setTimeout = (fn, ms, ...rest) => (ms >= 5000 ? 0 : savedTimers.setTimeout(fn, ms, ...rest));
  global.requestAnimationFrame = (fn) => savedTimers.setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
  ({ view } = await import(pathToFileURL(path.join(REPO, 'public/app/state.js')).href));
  W = window;
  WS = wsInstances[0];
  await tick();
  frame({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test', mounts: mountsOf('n1') });
  await tick();
});

// Every case starts attached and live on n1, with no panel open and n2 not yet
// previewed — put back here, BEFORE the test, so a failed assertion cannot leave
// the next case detached.
beforeEach(async () => {
  REAIM = null;
  if (overlayOpen()) { key('Escape'); key('Escape'); await tick(); }
  if (view.previewing) { click('btn-return-active'); await tick(); }
  ACTIVE = 'n1';
  frame(resetFrame('n1', mountsOf('n1')));
  await tick();
  assert.deepEqual(fieldValues(), ['live'], 'precondition: the live surface is up');
  assert.equal(view.previewing, false, 'precondition: attached');
  calls.length = 0;
  sent.length = 0;
});

after(async () => {
  const topbar = await import(pathToFileURL(path.join(REPO, 'public/app/topbar.js')).href);
  clearTimeout(topbar.showReaimNote._t);
  // Let the deferred 340ms theme-transition strip fire while the window is still
  // valid, so nothing runs against a torn-down document.
  await new Promise((r) => setTimeout(r, 400));
  for (const [k, v] of Object.entries(savedGlobals || {})) {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  }
  if (savedTimers) { global.setInterval = savedTimers.setInterval; global.setTimeout = savedTimers.setTimeout; }
  if (W) W.close();
});

async function previewN2() {
  click('btn-down');            // n1 → its only child, n2
  await tick();
  assert.equal(view.previewing, true, 'precondition: previewing n2');
  assert.equal(view.viewedId, 'n2');
  assert.deepEqual(paneIds(), ['m-form'], 'precondition: the previewed node is on screen');
  assert.deepEqual(fieldValues(), ['old'], 'precondition: its pane, under the live pane\'s id');
  assert.equal(readonlyGate(), true, 'precondition: and gated read-only');
}

// The page shows the node the re-aim landed on, as the live, editable surface.
async function assertLive({ active, values, what }) {
  assert.deepEqual(fieldValues(), values,
    `${what}: the live surface the reset carried is on screen — not the previewed node's panes`);
  assert.equal(view.previewing, false, `${what}: the preview is left`);
  assert.equal(view.activeId, active, `${what}: active is where the re-aim put it`);
  assert.equal(view.viewedId, view.activeId, `${what}: and the page views it — viewedId === activeId`);
  assert.equal(view.liveSnapshot, null, `${what}: no folded surface is left behind`);
  assert.equal(readonlyGate(), false, `${what}: the read-only gate is off`);
  for (const h of hosts()) assert.equal(h.hasAttribute('data-wc-readonly'), false, `${what}: ${h.dataset.mountId} is editable`);
  assert.doesNotMatch($('active-pill').textContent, /viewing/, `${what}: the pill no longer says it is viewing an older node`);
  const host = hosts()[0];
  if (!host) return;
  const f = host.shadowRoot.getElementById('f');
  const k = new W.KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true, composed: true });
  f.dispatchEvent(k);
  assert.equal(k.defaultPrevented, false, `${what}: typing into the live pane is not refused`);
  // …and what the user types lands on the LIVE pane: the frame carries the value
  // on screen. With the previewed node left up as if live, this sent
  // 'old, typed' as the live m-form's form_state.
  sent.length = 0;
  f.value += ', typed';   // appended to whatever is on screen
  f.dispatchEvent(new W.Event('input', { bubbles: true, composed: true }));
  const form = await waitUntil(() => sent.find((x) => x.type === 'pane:form' && x.id === 'm-form'),
    { timeout: 2000, what: `${what}: the typed value's pane:form` });
  assert.equal(form.form_state['#f:0'].value, `${values[0]}, typed`,
    `${what}: the typed value is the live pane's — nothing from the previewed node reached the live surface`);
}

const RE_AIMS = [
  {
    name: 'Set active on another node (the graph screen)',
    active: 'n3',
    reset: () => resetFrame('n3', mountsOf('n3')),
    answer: { ok: true, active: 'n3', preserved: null },
    values: ['three'],
    async run() {
      click('btn-graph');
      await tick(); await tick();
      await selectInGraph('n3');
      key('a');
    },
  },
  {
    name: 'Wipe',
    active: 'n1',
    // execWipe keeps pinned panes server-side and sends the survivors
    reset: () => resetFrame('n1', mountsOf('n1')),
    answer: { ok: true, active: 'n1', name: 'before cleanup', kept: ['m-form'] },
    values: ['live'],
    async run() { click('btn-wipe-go'); },
  },
  {
    name: 'New graph',
    active: null,
    reset: () => resetFrame(null, []),
    answer: { ok: true, active: null, name: '' },
    values: [],
    async run() { click('btn-new-graph-go'); },
  },
];

for (const r of RE_AIMS) {
  test(`${r.name} while previewing a different node — reset before the answer (the real order)`, async () => {
    await previewN2();
    REAIM = { active: r.active, reset: r.reset(), answer: r.answer, resetFirst: true };
    await r.run();
    await tick(); await tick(); await tick();
    const posted = calls.filter((c) => c.method === 'POST' && REAIM_POSTS.has(c.url));
    assert.equal(posted.length, 1, 'precondition: the re-aim was POSTed');
    await assertLive({ active: r.active, values: r.values, what: r.name });
  });

  test(`${r.name} while previewing a different node — answer before the reset`, async () => {
    await previewN2();
    REAIM = { active: r.active, reset: r.reset(), answer: r.answer, resetFirst: false };
    await r.run();
    await tick(); await tick();
    frame(REAIM.reset);           // the frame lands after the POST's answer
    await tick(); await tick();
    await assertLive({ active: r.active, values: r.values, what: r.name });
  });
}

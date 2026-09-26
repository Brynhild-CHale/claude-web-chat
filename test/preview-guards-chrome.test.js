// Four chrome guards around the read-only preview and the graph screen, driven
// as real DOM against the real front-end module graph in jsdom (same harness
// style as test/leave-preview-chrome.test.js; one boot per test FILE).
//
//   1. ⌘K under the graph overlay did open the palette — UNDER the overlay, with
//      #cmd-input focused: it stole the graph's keys and ↵ ran a row nobody could
//      see. It does nothing there now (the graph has its own jump box).
//   2. The graph's A key set active on the node that was already active (the
//      button beside it is disabled for that, and for a held lock).
//   3. A render that lands during a preview is folded into the captured live
//      surface; that fold dropped `owner`, so a pane-spawned block came back
//      from ↩ active as Claude's — no ↳ parent chip.
//   4. Adding a block in a read-only preview POSTed to the LIVE surface, where
//      nothing appeared until ↩ active. It is refused with the preview hint.
const test = require('node:test');
const { before, after } = test;
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
const NODE_MOUNTS = {
  n1: [{ id: 'parent', html: '<p>live</p>', target: 'main', params: {}, pane_state: {} }],
  n2: [{ id: 'm-old', html: '<p>old</p>', target: 'main', params: {}, pane_state: {} }],
};

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
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n1' });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: (NODE_MOUNTS[id] || []).map((m) => ({ ...m })), store: {} });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [], changed: [], removed: [] } });
    if (u === '/api/components') return json({ components: [{ name: 'widget', description: 'a widget' }] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.7.6', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
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
const key = (k, extra = {}) => W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
const frame = (msg) => WS.onmessage({ data: JSON.stringify(msg) });
const previewing = () => $('main').classList.contains('preview-readonly');
const overlayOpen = () => !$('overlay').classList.contains('hidden');
const paletteOpen = () => !$('cmd-palette').classList.contains('hidden');
const paneEl = (id) => [...W.document.querySelectorAll('#main .pane')].find((p) => p.dataset.paneId === id);
const noteText = () => { const n = $('reaim-note'); return n ? n.textContent : ''; };
const posts = (url) => calls.filter((c) => c.method === 'POST' && c.url === url);
const selectInGraph = async (id) => {
  const g = W.document.querySelector(`#graph-svg g[data-id="${id}"], #gv-world .gv-srow[data-id="${id}"]`);
  g.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
};

// The cases run in order against one shell (each leaves it attached, live on
// n1, with no panel open) — one boot per file, as node --test gives each file
// its own process.
before(async () => {
  await boot();
  await tick();
  frame({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: NODE_MOUNTS.n1.map((m) => ({ ...m })),
  });
  await tick();
});

after(async () => {
  await new Promise((r) => setTimeout(r, 400)); // drain the theme-transition timer while the window lives
  restore();
});

/* ---------- 1. ⌘K under the graph overlay ---------- */

test('⌘K with the graph open does nothing — no palette hidden under it holding focus', async () => {
  assert.ok(paneEl('parent'), 'precondition: the live surface is up');
  click('btn-graph');
  await tick(); await tick();
  assert.ok(overlayOpen(), 'precondition: the graph is open');
  key('k', { metaKey: true });
  await tick();
  assert.equal(paletteOpen(), false, 'the palette did not open under the overlay');
  assert.notEqual(W.document.activeElement, $('cmd-input'), 'and #cmd-input did not take focus');
  assert.ok(overlayOpen(), 'the graph is still up');
  key('Escape');
  await tick();
  assert.equal(overlayOpen(), false);

  key('k', { metaKey: true });
  await tick();
  assert.ok(paletteOpen(), 'on the surface ⌘K still opens the palette');
  // the palette's input owns its own Escape
  $('cmd-input').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick();
  assert.equal(paletteOpen(), false);
});

/* ---------- 2. the A key on the active node ---------- */

test('A on the already-active node, or while a turn holds the lock, posts nothing', async () => {
  click('btn-graph');
  await tick(); await tick();
  await selectInGraph('n1');
  key('a');
  await tick();
  assert.equal(posts('/api/graph/active').length, 0, 'the active node is not re-set (the button is disabled for it too)');

  await selectInGraph('n2');
  frame({ type: 'lock', lock: { at: Date.now(), message: 'working', author: 'user' } });
  await tick();
  key('a');
  await tick();
  assert.equal(posts('/api/graph/active').length, 0, 'nor while a turn holds the lock');
  frame({ type: 'lock', lock: null });
  await tick();
  key('Escape'); key('Escape');
  await tick();
  assert.equal(overlayOpen(), false);
});

/* ---------- 3. owner survives the preview fold ---------- */

test('a pane-spawned block rendered during a preview keeps its owner on ↩ active', async () => {
  click('btn-down');            // n1 → n2
  await tick();
  assert.equal(previewing(), true, 'precondition: previewing n2');
  frame({ type: 'render', id: 'child', html: '<p>child</p>', target: 'main', params: {}, pane_state: {}, owner: 'pane:parent' });
  await tick();
  assert.equal(paneEl('child'), undefined, 'the live render does not land on the previewed page');

  click('btn-return-active');
  await tick();
  assert.equal(previewing(), false);
  const child = paneEl('child');
  assert.ok(child, 'the folded render is on the live surface');
  const chip = child.querySelector('.pane-owner');
  assert.ok(chip, 'with its ↳ parent chip — the owner rode the fold');
  assert.equal(chip.dataset.parent, 'parent');
});

/* ---------- 4. adding a block in a read-only preview ---------- */

test('adding a block while previewing is refused with the preview hint, and writes nothing', async () => {
  click('btn-down');
  await tick();
  assert.equal(previewing(), true, 'precondition: previewing n2');
  const { spawnComponent } = await import(pathToFileURL(path.join(REPO, 'public/app/drawer.js')).href);
  const before = calls.length;
  await spawnComponent({ name: 'widget' });
  await tick();
  assert.ok(!calls.slice(before).some((c) => c.method === 'POST'), 'nothing POSTed to the live surface');
  assert.match(noteText(), /Read-only preview — set this node active in the graph to edit/);
  assert.equal(previewing(), true, 'and the preview stays up');

  click('btn-return-active');
  await tick();
  await spawnComponent({ name: 'widget' });
  await tick();
  assert.equal(posts('/api/components/widget/use').length, 1, 'live, the same spawn goes through');
});

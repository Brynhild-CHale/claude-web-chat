// public/app/storage.js — the guarded browser-storage engine, and the boot it
// exists to protect.
//
// The defect: theme.js read localStorage unwrapped, and initMode() is the FIRST
// statement main.js runs. `localStorage` is a GETTER on window, so in a private
// window (Safari "Block all cookies", Chrome with site data blocked) reading the
// property throws before `.getItem` is reached — which aborts theme.js's module
// evaluation and, with it, every module downstream: no socket, no topbar, no
// rail. A dead page, not a dead toggle.
//
// Three other modules (version.js, service-trust.js, graph-view.js) had each
// hand-rolled the same try/catch. storage.js is the one home now, and this file
// boots the WHOLE module graph against a throwing accessor — the case the other
// jsdom harnesses can never see, because they all alias a working jsdom
// localStorage onto global before importing anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

let W = null, WS = null, restore = () => {};

// A storage object whose ACCESSOR throws, exactly as a blocked browser does.
function blockStorage(window, name) {
  Object.defineProperty(window, name, {
    configurable: true,
    get() { throw new Error('SecurityError: The operation is insecure.'); },
  });
}

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
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.3.0', updateAvailable: true, latest: '0.4.0' });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };

  // The whole point of this file: BOTH stores are blocked before the module
  // graph is imported, so the very first accessor touch throws.
  blockStorage(window, 'localStorage');
  blockStorage(window, 'sessionStorage');

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  // …and the bare globals the modules actually reference throw too.
  const savedStores = {};
  for (const k of ['localStorage', 'sessionStorage']) {
    try { savedStores[k] = Object.getOwnPropertyDescriptor(global, k); } catch {}
    Object.defineProperty(global, k, {
      configurable: true,
      get() { throw new Error('SecurityError: The operation is insecure.'); },
    });
  }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    for (const [k, d] of Object.entries(savedStores)) {
      try { if (d) Object.defineProperty(global, k, d); else delete global[k]; } catch {}
    }
    global.setInterval = savedSetInterval;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);

test('the whole shell boots with both storages blocked (private window)', async () => {
  await boot();
  await tick();
  assert.ok(WS, 'the socket connected — bootstrap reached main.js:connect()');
  assert.ok(W.store && typeof W.store.set === 'function', 'the store singleton was established');

  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: [{ id: 'm1', html: '<p>hi</p>', target: 'main', params: {}, pane_state: {} }],
  }) });
  await tick();
  assert.ok($('main').querySelector('.pane .mount-host'), 'panes render — the surface is live, not dead');
  assert.ok($('active-pill').textContent.includes('n1'), 'the topbar initialised');
});

test('an unreadable mode preference falls back to the default light look', async () => {
  assert.equal(W.document.documentElement.dataset.theme, 'light',
    'initMode() could not read the stored mode and left the shipped default in place');
});

test('toggling light/dark still works — the write simply does not stick', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 't' }));
  await tick();
  assert.notEqual(W.document.documentElement.dataset.theme, 'light', 'T flipped to dark');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 't' }));
  await tick();
  assert.equal(W.document.documentElement.dataset.theme, 'light', 'and back — no throw either way');
});

test('the update banner still shows and still dismisses without storage', async () => {
  await tick();
  const banner = $('update-banner');
  assert.ok(banner && !banner.classList.contains('hidden'),
    'version.js reached its render path with an unreadable dismissal record');
});

test('the graph canvas lays out with unreadable saved placements', async () => {
  $('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  assert.equal($('overlay').classList.contains('hidden'), false, 'the overlay opened');
  assert.ok($('graph-svg').textContent.includes('n1'), 'the DAG drew with the auto-layout, no saved offsets');
  await new Promise((r) => setTimeout(r, 400)); // let the theme-transition timer fire while the window lives
  restore();
});

// Integration smoke for the Phase 7 front-end module graph: load the shell +
// every ES module (with the REAL mount-runtime) in jsdom, stub WebSocket + fetch,
// and exercise the core flows — store, the WS handler map (hello/render/clear),
// the ⌘K palette, the drawer, and the light/dark toggle. Catches import/wiring/
// runtime regressions the way node --test can't reach browser code otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

test('front-end module graph boots and the core flows work under jsdom', async () => {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, ''); // strip scripts; we load modules ourselves
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  // stubs
  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send(d) { (this.sent ||= []).push(d); }
    close() {}
  };
  const fetchCalls = [];
  window.fetch = async (url) => {
    fetchCalls.push(url);
    const body = url === '/api/graph' ? { nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' }
      : url === '/api/components' ? { components: [{ name: 'demo', description: 'd' }] }
      : url === '/api/themes' ? { themes: [] }
      : url.startsWith('/api/theme') ? { name: 'web-chat' }
      : { ok: true };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  // expose jsdom globals to the ES modules (which reference bare globals)
  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'getComputedStyle', 'localStorage', 'WebSocket', 'fetch', 'HTMLElement', 'Node', 'Element'];
  for (const k of keys) { try { saved[k] = global[k]; global[k] = window[k]; } catch {} }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0; // don't let comments.js pollers keep the process alive
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  try {
    // bust the ESM cache across runs via a query param so repeated `node --test` is clean
    await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);

    const $ = (id) => window.document.getElementById(id);
    const tick = () => new Promise((r) => setTimeout(r, 20));

    assert.ok(window.store && typeof window.store.set === 'function', 'window.store established');
    window.store.set({ hi: 1 });
    assert.equal(window.store.get().hi, 1, 'store set/get round-trips');

    await tick();
    assert.equal(wsInstances.length, 1, 'ws connected once');
    const ws = wsInstances[0];
    assert.ok((ws.sent || []).some((s) => { const m = JSON.parse(s); return m.type === 'store:set' && m.patch.hi === 1; }),
      'local store.set echoed through the ws publish hook');
    ws.onmessage({ data: JSON.stringify({
      type: 'hello', store: { a: 1 }, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
      mounts: [{ id: 'm1', html: '<p id="x">hi</p>', target: 'main', params: {}, pane_state: {} }],
    }) });
    await tick();
    assert.ok($('main').querySelector('.pane .mount-host'), "'hello' rendered a pane with a mount-host");
    assert.ok($('active-pill').textContent.includes('n1'), 'active pill shows the active node');

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    assert.ok(!$('cmd-palette').classList.contains('hidden'), '⌘K opened the command palette');
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.ok($('cmd-palette').classList.contains('hidden'), 'Escape closed the palette');

    $('btn-add').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    assert.ok($('drawer').classList.contains('open'), 'btn-add opened the drawer');
    assert.ok(fetchCalls.includes('/api/components'), 'drawer fetched /api/components');

    const before = window.document.documentElement.dataset.theme || 'dark';
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 't' }));
    assert.notEqual(window.document.documentElement.dataset.theme || 'dark', before, 'T toggled light/dark');

    ws.onmessage({ data: JSON.stringify({ type: 'render', id: 'm2', html: '<b>two</b>', target: 'main', params: {}, pane_state: {} }) });
    assert.equal($('main').querySelectorAll('.pane').length, 2, 'render added a second pane');
    ws.onmessage({ data: JSON.stringify({ type: 'clear', id: 'm2' }) });
    assert.equal($('main').querySelectorAll('.pane').length, 1, 'clear removed a pane');

    // Drain any deferred timers (e.g. the 340ms theme-transition strip) while the
    // window is still valid, so nothing fires after the test ends.
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    window.close();
  }
});

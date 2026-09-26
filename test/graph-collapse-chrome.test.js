// The viewer half of collapse: nodes the payload marks `collapsed` are not
// drawn, not listed, and not counted — and the turns they stood for are shown
// on the node that absorbed them instead (as faint ghost dots on its edge; as
// ghost rows inside a sleeve — see test/graph-canvas-chrome.test.js). Driven as real DOM against the REAL
// front-end module graph in jsdom (same harness style as
// test/graph-view-chrome.test.js; one boot per test FILE).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

// n1 ── n2 ── n3 ── n4      n2/n3 changed nothing; n4 stands for them.
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1, display_parent: null, children: ['n2'] },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2, collapsed: true, display_parent: 'n1', trigger_summary: 'asked about the audit', children: ['n3'] },
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: 3, collapsed: true, display_parent: 'n2', trigger_summary: 'talked through the fix', children: ['n4'] },
  {
    id: 'n4', label: 'n1.3', parent_id: 'n3', created_at: 4, display_parent: 'n1', children: [],
    absorbed_count: 2,
    absorbed: [
      { id: 'n2', label: 'n1.1', created_at: 2, author: 'claude', trigger_summary: 'asked about the audit' },
      { id: 'n3', label: 'n1.2', created_at: 3, author: 'claude', trigger_summary: 'talked through the fix' },
    ],
  },
];

let W = null, WS = null, restore = () => {};
const diffCalls = [];

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {} close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/graph/diff')) diffCalls.push(u);
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n4', collapsed_count: 2 });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      // Only n4 recorded Claude's reply (D7); n1 is an older node without one.
      const trigger = { message: 'the turn that changed something', ...(id === 'n4' ? { reply: 'Rendered the <b>plan</b>.' } : {}) };
      return json({ ...n, author: 'claude', trigger, mounts: [{ id: 'm1', params: { title: 'plan' } }], store: {} });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [1], changed: [], removed: [] } });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.6.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };
  window.prompt = () => { throw new Error('window.prompt was called'); };
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

test('boot the shell once for the collapse checks', async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n4', lock: null, project: 'test', mounts: [],
  }) });
  await tick();
  $('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  assert.equal($('overlay').classList.contains('hidden'), false, 'graph overlay is open');
});

test('collapsed turns are not counted', async () => {
  assert.match($('gv-head-meta').textContent, /active n1\.3 · 2 turns$/,
    'the graph chip counts what is drawn, not every commit');
});

test('collapsed turns are not drawn in the DAG', async () => {
  const ids = [...W.document.querySelectorAll('#graph-svg g[data-id]')].map((g) => g.dataset.id);
  assert.deepEqual(ids.sort(), ['n1', 'n4'], 'only the turns that changed something');
  const text = $('graph-svg').textContent;
  assert.ok(text.includes('n1.3'), 'the node that changed something is drawn');
  assert.ok(!text.includes('n1.1 '), 'a collapsed turn is not');
});

test('the node shows the turns it stands for, as ghosts on its edge', async () => {
  const n4 = W.document.querySelector('#graph-svg g[data-id="n4"]');
  assert.match(n4.querySelector('.gv-fold-n').textContent, /⋯2/, 'the count rides the node');
  assert.match(n4.querySelector('title').textContent, /2 folded turns/, 'and its tooltip says what it is');
  assert.equal(W.document.querySelectorAll('#graph-svg .gv-ghost-dot').length, 2,
    'one faint dashed dot per folded turn on the edge that leads into it');
});

test('the CHANGED row diffs against the parent the viewer actually draws', async () => {
  W.document.querySelector('#graph-svg g[data-id="n4"]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  assert.ok(diffCalls.some((u) => u === '/api/graph/diff?a=n1&b=n4'),
    `not n1.2 (n3), which is hidden — the edge on screen goes to n1.0; got ${diffCalls}`);
  assert.match($('gv-changed').textContent, /blocks: 1 added/);
});

test('the inspector shows Claude\'s reply summary as one line, and nothing for a node without one', async () => {
  const reply = $('gv-inspector').querySelector('.gv-reply');
  assert.ok(reply, 'n4 recorded a reply');
  assert.equal(reply.textContent, 'Rendered the <b>plan</b>.', 'shown as text, not markup');
  assert.equal(reply.getAttribute('title'), 'Rendered the <b>plan</b>.');

  W.document.querySelector('#graph-svg g[data-id="n1"]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  assert.match($('gv-inspector').querySelector('.gv-insp-label').textContent, /n1\.0/);
  assert.equal($('gv-inspector').querySelector('.gv-reply'), null, 'an older node has no reply line');
});

test('the ⌘K palette lists the turns the graph DRAWS, not every commit', async () => {
  $('cmd-trigger').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  const rows = [...$('cmd-list').children]
    .filter((r) => r.querySelector('.kind') && r.querySelector('.kind').textContent === 'node')
    // the label leads with the node's label ("n1.3 · <trigger>" — the rows are typed now)
    .map((r) => r.querySelector('.label').textContent.split(' · ')[0]);
  assert.deepEqual(rows, ['n1.0', 'n1.3'],
    'the palette built its rows from view.graphCache.nodes — the RAW commit list — so a collapsed '
    + 'turn kept a row, and selecting it previewed a node the DAG does not draw');
  $('cmd-input').dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.equal($('cmd-palette').classList.contains('hidden'), true);
});

test('teardown', () => { restore(); });

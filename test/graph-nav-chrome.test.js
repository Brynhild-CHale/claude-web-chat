// Keyboard navigation and fork classification over a COLLAPSED graph — the
// consumers displayNodes()'s comment claimed for itself and did not have.
//
// No test in this tree had ever pressed an arrow key. graph-view.js laid the DAG
// out from displayNodes() (collapsed turns dropped, each survivor's parent
// rewritten to the nearest survivor) while moveSelection, isFork, lineageOf and
// rootOf walked the RAW commit graph through labels.js. The server only collapses
// a node that has exactly one child and a parent, so a collapsed node always sits
// between two survivors on the trunk, and the two topologies disagreed exactly
// where a user notices:
//
//   * ArrowDown from the survivor above selected the HIDDEN node — centerOn finds
//     no glyph for it, so the camera did not move and nothing highlighted, and a
//     second press was needed to reach the child on screen.
//   * The surviving child's raw siblings included the collapsed node, so it was
//     labelled '⑃ FORK' in a list drawn from the display topology while the DAG
//     drew it on the trunk.
//   * The inspector breadcrumb listed nodes the history list had hidden.
//
// Plus the race the memoized index made visible: the inspector paints after an
// await while view.selectedNodeId — which the action footer reads — moves on the
// keydown. Held arrow keys could leave the panel describing one node while ↵/A/⚑
// operated on another.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

//        n1 ──(n2, collapsed)── n3      trunk, as DRAWN: n1 ── n3
//          └── n4                       a real branch
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1, display_parent: null },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2, collapsed: true, display_parent: 'n1', trigger_summary: 'changed nothing' },
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: 3, display_parent: 'n1' },
  { id: 'n4', label: 'n1.1.0', parent_id: 'n1', created_at: 4, display_parent: 'n1' },
];

// Per-node delay on GET /api/graph/node/:id, so the inspector race is reproducible.
const NODE_DELAY = {};

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
  const calls = [];
  window.__calls = calls;
  window.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n1', collapsed_count: 1 });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const ms = NODE_DELAY[id] || 0;
      if (ms) await new Promise((r) => setTimeout(r, ms));
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: [], store: {} });
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

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => W.document.getElementById(id);
const key = (k) => W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true }));
const selectedId = () => {
  const row = $('gv-history-list').querySelector('.gv-row.selected');
  return row ? row.dataset.id : null;
};
const drawnIds = () => [...$('gv-history-list').children].map((r) => r.dataset.id);
const inspectorLabel = () => {
  const el = $('gv-inspector').querySelector('.gv-insp-label');
  return el ? el.textContent : '';
};
const selectRow = async (id) => {
  [...$('gv-history-list').children].find((r) => r.dataset.id === id)
    .dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
};

test('boot the shell once, graph overlay open on a collapsed trunk', async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test', mounts: [],
  }) });
  await tick();
  $('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  assert.equal($('overlay').classList.contains('hidden'), false, 'the overlay is open');
  assert.deepEqual(drawnIds().sort(), ['n1', 'n3', 'n4'], 'precondition: n2 collapsed away');
});

/* ---------------- keyboard navigation over the display topology ---------------- */

test('ArrowDown steps to the node the DAG drew, not the collapsed one between', async () => {
  await selectRow('n1');
  assert.equal(selectedId(), 'n1', 'precondition: selection is on the trunk head');

  key('ArrowDown');
  await tick();
  assert.equal(selectedId(), 'n3',
    'one press reaches the next DRAWN turn; it used to land on n2, which has no glyph — ' +
    'centerOn found nothing, the camera did not move, and a second press was needed');
  assert.ok(drawnIds().includes(selectedId()), 'and the selection is a node the viewer lists');
});

test('ArrowUp comes back to the drawn parent, not through the hidden node', async () => {
  key('ArrowUp');
  await tick();
  assert.equal(selectedId(), 'n1', 'the display parent, symmetric with ArrowDown');
});

test('ArrowRight/ArrowLeft walk the drawn siblings', async () => {
  await selectRow('n3');
  key('ArrowRight');
  await tick();
  assert.equal(selectedId(), 'n4', 'n3 and n4 are siblings as drawn (both display-parented to n1)');
  key('ArrowLeft');
  await tick();
  assert.equal(selectedId(), 'n3', 'and back');
});

/* ---------------- fork classification ---------------- */

test('a surviving child of a collapsed node is not labelled a fork', async () => {
  const row = [...$('gv-history-list').children].find((r) => r.dataset.id === 'n3');
  assert.equal(row.querySelector('.glyph').textContent, '○',
    'n3 is the trunk child as drawn; reading raw siblings saw [n2, n4] and called it ⑃ FORK');
  const branch = [...$('gv-history-list').children].find((r) => r.dataset.id === 'n4');
  assert.equal(branch.querySelector('.glyph').textContent, '⑃', 'the real branch still is one');
  assert.match($('gv-status-counts').textContent, /1 fork/, 'and the count agrees — it read 2');
});

test('the forks filter lists the branch and only the branch', async () => {
  $('gv-filters').querySelector('[data-filter="forks"]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.deepEqual(drawnIds(), ['n4']);
  $('gv-filters').querySelector('[data-filter="forks"]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
});

/* ---------------- the breadcrumb ---------------- */

test('the inspector breadcrumb lists only the turns the viewer draws', async () => {
  await selectRow('n3');
  await tick();
  const crumbs = $('gv-inspector').querySelector('.gv-lineage').textContent;
  assert.match(crumbs, /n1\.0/, 'the drawn root');
  assert.match(crumbs, /n1\.2/, 'and the node itself');
  assert.ok(!crumbs.includes('n1.1 '), 'not the collapsed turn between them, which is hidden everywhere else');
});

/* ---------------- the topbar's ↓, the other "next turn" gesture ---------------- */

test('the topbar ↓ steps to the same node ArrowDown does', async () => {
  key('Escape');                       // leave the overlay; the topbar drives the surface
  await tick();
  W.__calls.length = 0;
  $('btn-down').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.ok(W.__calls.includes('/api/graph/node/n3'),
    'the ] hotkey and the ↓ button previewed the drawn child; they used to open n2, which the DAG will not draw');
  assert.ok(!W.__calls.includes('/api/graph/node/n2'), 'the collapsed node is never navigated to');
});

test('the topbar ↑ comes back the way ↓ went, instead of stranding the viewer on a hidden node', async () => {
  assert.equal($('node-label').textContent, 'n1.2', 'precondition: ↓ left the viewer on n3');
  W.__calls.length = 0;
  assert.equal($('btn-up').disabled, false, 'the ↑ gate is live');

  $('btn-up').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();

  assert.ok(!W.__calls.includes('/api/graph/node/n2'),
    '↑ previewed the DRAWN parent, not the collapsed turn between — it walked the raw parent_id ' +
    'while ↓ walked the display topology, so the pair was not symmetric');
  assert.equal($('node-label').textContent, 'n1.0',
    'it landed on the node ↓ came from (n1 is active, so the return needs no fetch at all)');
  assert.equal($('btn-down').disabled, false,
    '↓ still works from here — landing on n2 disabled it (n2 is absent from the display index, ' +
    'so displayChildrenOf(n2) is empty): a dead end ↑ itself created');
});

test('with the collapsed turns shown, ↑/↓ walk them — the pair follows whatever is drawn', async () => {
  $('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  $('gv-show-collapsed').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.ok(drawnIds().includes('n2'), 'precondition: n2 is drawn now');
  key('Escape');                       // back to the topbar
  await tick();

  W.__calls.length = 0;
  $('btn-down').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal($('node-label').textContent, 'n1.1', '↓ steps onto the no-change turn, which is on screen now');
  $('btn-up').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal($('node-label').textContent, 'n1.0', 'and ↑ is its exact inverse');

  $('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  $('gv-show-collapsed').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.ok(!drawnIds().includes('n2'), 'restored: collapsed again for the tests below');
  key('Escape');
  await tick();
});

/* ---------------- the inspector/footer race ---------------- */

test('rapid navigation never leaves the inspector describing a node the footer is not on', async () => {
  $('btn-graph').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(); await tick();
  await selectRow('n3');

  // n1's node fetch is slow, n3's is instant: press ArrowUp then ArrowDown fast
  // enough that the slow response for n1 lands AFTER the fast one for n3.
  NODE_DELAY.n1 = 60;
  try {
    key('ArrowUp');      // → n1 (slow)
    key('ArrowDown');    // → n3 (instant); this is the selection the footer acts on
    await tick(150);
    assert.equal(selectedId(), 'n3', 'the last key won the selection');
    assert.equal(inspectorLabel(), 'n1.2',
      'and the panel describes it — the stale response for n1 was dropped instead of painted over it, ' +
      'which would have left ↵/A/⚑/↧ acting on a node the inspector was not showing');
  } finally {
    delete NODE_DELAY.n1;
  }
  await new Promise((r) => setTimeout(r, 400)); // drain the theme-transition timer
  restore();
});

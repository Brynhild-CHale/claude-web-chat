// The canvas-first graph screen (plan §2b; design "Graph Canvas Prototype" +
// "Stack Expansion Options" 1a/2a), driven as real DOM events against the REAL
// front-end module graph in jsdom. One boot per FILE, in a `before` hook.
//
// Pinned here:
//   * The history column, Scope, the Log / ⇄ compare placeholders and the status
//     line are gone; the chrome floats over a full-stage canvas.
//   * The inspector exists only while a node is selected.
//   * ×N stacks list REAL nodes (ruling D1): a click expands the stack IN PLACE
//     into a sleeve of selectable rows, capped and scrolling inside itself, whose
//     header never says "no surface change"; selecting a node inside a collapsed
//     stack expands it; ⊟ Collapse all folds every sleeve.
//   * Turns that changed nothing are faint ghost rows under the node they folded
//     onto — from the node record (`folded`) and from legacy collapsed nodes
//     (`absorbed`).
//   * ⚑ Marked / ⑃ Forks and the jump search DIM, never hide; ↵ selects + centres.
//   * ⑃ Branch and Set active move `active` through the one POST; ⚑ Unmark clears
//     a bookmark without a prompt; a wipe's bookmark reads "⌫ wipe · …".
//   * ◇ New hands over to the new-graph panel.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

//  tree 1 ("anneal"):  n1 ─ n2 … n11 (a 10-turn plain run) ─ n12 (active)
//                                                              ├─ n13 (wipe bookmark)
//                                                              └─ n14 (a fork)
//  n3 had two chat-only turns fold onto it; n5 absorbed one legacy collapsed node (n5x).
//  tree 2 (unnamed):   n20 ─ n21 (a 2-turn run: a stack of its own)
const run = [];
for (let i = 2; i <= 11; i++) {
  run.push({ id: 'n' + i, label: 'n1.' + (i - 1), parent_id: i === 2 ? 'n1' : 'n' + (i - 1), created_at: i, trigger_summary: 'edit ' + (i - 1), children: ['n' + (i + 1)] });
}
const byId = Object.fromEntries(run.map((n) => [n.id, n]));
byId.n3.folded_count = 2;
byId.n5.parent_id = 'n5x';
byId.n5.display_parent = 'n4';
byId.n5.absorbed = [{ id: 'n5x', label: 'n1.4x', created_at: 4.5, author: 'claude', trigger_summary: 'legacy chat' }];
byId.n5.absorbed_count = 1;
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1, bookmarked: true, name: 'anneal', trigger_summary: 'start', children: ['n2'] },
  ...run,
  { id: 'n5x', label: 'n1.4x', parent_id: 'n4', created_at: 4.5, collapsed: true, display_parent: 'n4', trigger_summary: 'legacy chat' },
  { id: 'n12', label: 'n1.11', parent_id: 'n11', created_at: 12, trigger_summary: 'the active turn', children: ['n13', 'n14'] },
  { id: 'n13', label: 'n1.12', parent_id: 'n12', created_at: 13, bookmarked: true, wipe: true, name: 'before cleanup', trigger_summary: 'wiped' },
  { id: 'n14', label: 'n1.11.0', parent_id: 'n12', created_at: 14, trigger_summary: 'a fork' },
  { id: 'n20', label: 'n2.0', parent_id: null, created_at: 20, trigger_summary: 'scratch' },
  { id: 'n21', label: 'n2.1', parent_id: 'n20', created_at: 21, trigger_summary: 'more scratch' },
];
const FOLDED = { n3: [{ at: 3, author: 'claude', summary: 'asked a question' }, { at: 3.1, author: 'claude', summary: 'talked it through' }] };

const calls = [];
let W = null, WS = null, restore = () => {};

before(async () => {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  const wsInstances = [];
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1; wsInstances.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {} close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n12', collapsed_count: 1 });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: [], store: {}, ...(FOLDED[id] ? { folded: FOLDED[id] } : {}) });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [], changed: [1], removed: [] } });
    if (u === '/api/graph/active') return json({ ok: true, active: opts && JSON.parse(opts.body).id });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.7.5', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
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
  await tick();
  WS.onmessage({ data: JSON.stringify({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n12', lock: null, project: 'test', mounts: [] }) });
  await tick();
});

after(async () => {
  await new Promise((r) => setTimeout(r, 400)); // drain the theme-transition timer while the window lives
  restore();
});

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => W.document.getElementById(id);
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
const key = (k, target) => (target || W.document).dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true }));
const overlayOpen = () => !$('overlay').classList.contains('hidden');
const inspectorUp = () => !$('gv-inspector').classList.contains('hidden');
const glyph = (id) => W.document.querySelector(`#graph-svg g[data-id="${id}"]`);
const stack = () => W.document.querySelector('#graph-svg g.gv-stack[data-stack-head="n2"]');   // tree 1's 10-turn run
const sleeve = () => W.document.querySelector('#gv-world .gv-sleeve[data-stack-head="n2"]');
const srow = (id) => W.document.querySelector(`#gv-world .gv-srow[data-id="${id}"]`);
const selectedId = () => {
  const el = W.document.querySelector('#graph-svg g.gv-node.selected, #gv-world .gv-srow.selected');
  return el ? el.dataset.id : null;
};

// Every test starts from the same place: the graph open, nothing selected,
// every stack collapsed, no filter, empty search.
beforeEach(async () => {
  if (W.document.querySelector('.glance-backdrop')) key('Escape');
  if (!overlayOpen()) { click($('btn-graph')); await tick(); await tick(); }
  if (inspectorUp()) key('Escape');
  for (const c of $('gv-filters').querySelectorAll('.gv-chip.on')) click(c);
  const jump = $('gv-jump');
  if (jump.value) { jump.value = ''; jump.dispatchEvent(new W.Event('input', { bubbles: true })); }
  click($('gv-collapse-all'));
  await tick();
  calls.length = 0;
});

test('the chrome floats over a full-stage canvas — the history column and its extras are gone', () => {
  for (const id of ['gv-history-list', 'gv-scope', 'gv-mode', 'gv-compare', 'gv-status-counts', 'gv-show-collapsed', 'gv-diff']) {
    assert.equal($(id), null, `#${id} is gone`);
  }
  assert.match($('gv-head-meta').textContent, /^active n1\.11 · 16 turns$/,
    'top-left: the active node and the count of drawn turns (the collapsed n5x is not one)');
  for (const id of ['gv-jump', 'gv-filters', 'gv-collapse-all', 'gv-new', 'overlay-close', 'gv-zoom-pct', 'overlay-fit']) {
    assert.ok($(id), `#${id} is on the screen`);
  }
});

test('the inspector exists only while a node is selected', async () => {
  assert.equal(inspectorUp(), false, 'opening the graph selects nothing');
  click(glyph('n12'));
  await tick();
  assert.ok(inspectorUp(), 'a click raises it');
  assert.equal($('gv-inspector').querySelector('.gv-insp-label').textContent, 'n1.11');
  const badges = [...$('gv-inspector').querySelectorAll('.gv-badge')].map((b) => b.textContent);
  assert.deepEqual(badges, ['ACTIVE']);
  assert.match($('gv-inspector').textContent, /GRAPH\s*anneal/, 'the GRAPH row names the tree');
  assert.match($('gv-changed').textContent, /blocks: 1 changed/, 'CHANGED is one line');
  assert.equal($('gv-set-active').disabled, true, 'the active node cannot be set active again');
  click($('gv-inspector').querySelector('[data-act="close"]'));
  await tick();
  assert.equal(inspectorUp(), false, '✕ deselects');
  assert.equal(selectedId(), null);
});

test('tree titles read "◇ name" / "◇ graph nX" with their turn count', () => {
  const titles = [...W.document.querySelectorAll('#graph-svg .gv-tree-title .gv-tt')].map((t) => t.textContent);
  assert.ok(titles.some((t) => /^◇ anneal\s*14 turns/.test(t)), `got ${titles}`);
  assert.ok(titles.some((t) => /^◇ graph n2\s*2 turns/.test(t)), `got ${titles}`);
});

test('a run of plain turns is ONE ×N stack of real nodes, and its copy never says "no surface change"', () => {
  const s = stack();
  assert.ok(s, 'the 10-turn run draws as a stack');
  assert.match(s.textContent, /×10/);
  assert.match(s.textContent, /n1\.1…n1\.10/, 'with the range it spans');
  assert.doesNotMatch(s.querySelector('title').textContent, /no surface change|changed nothing/i,
    'every turn in it DID change the surface — a stack is a display collapse, not a no-op');
  assert.equal(sleeve(), null, 'collapsed: no sleeve yet');
});

test('clicking a stack expands it IN PLACE into a capped, scrolling sleeve of selectable rows', async () => {
  click(stack());
  await tick();
  const sl = sleeve();
  assert.ok(sl, 'a sleeve replaced the stack');
  assert.equal(stack(), null, 'and the stack glyph is gone while it is open');
  assert.equal(sl.querySelectorAll('.gv-srow').length, 10, 'one row per REAL node');
  const head = sl.querySelector('.gv-sleeve-head').textContent;
  assert.match(head, /10 turns · n1\.1 → n1\.10/);
  assert.doesNotMatch(head, /no surface change/);
  assert.match(sl.querySelector('.pos').textContent, /^1–\d of 10$/, 'the header reports the window');
  assert.match(sl.querySelector('.gv-sleeve-foot').textContent, /^\d+ more ↓$/, 'the footer, what is below');
  const body = sl.querySelector('.gv-sleeve-body');
  assert.ok(parseFloat(body.style.height) <= 8 * 30 + 16, `capped at eight rows' height, got ${body.style.height}`);

  click(srow('n6'));
  await tick();
  assert.equal(selectedId(), 'n6', 'a row is a node you can select');
  assert.ok([...$('gv-inspector').querySelectorAll('.gv-badge')].some((b) => b.textContent === 'IN STACK'));

  click(sleeve().querySelector('.gv-sleeve-head'));   // (a selection re-renders the sleeve)
  await tick();
  assert.equal(sleeve(), null, '⊟ in the header collapses it again');
  assert.ok(stack());
});

test('the wheel over a scrolling sleeve scrolls the run, not the canvas zoom', async () => {
  click(stack());
  await tick();
  const pct = $('gv-zoom-pct').textContent;
  sleeve().dispatchEvent(new W.WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
  assert.equal($('gv-zoom-pct').textContent, pct, 'the zoom did not move');
  W.document.querySelector('.graph-canvas-wrap').dispatchEvent(new W.WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
  assert.notEqual($('gv-zoom-pct').textContent, pct, 'off the sleeve, the wheel still zooms');
});

test('folded no-change turns are faint ghost rows under the node they folded onto', async () => {
  click(stack());
  await tick(); await tick();   // the folded list is fetched from the node record
  const ghosts = (id) => [...W.document.querySelectorAll(`#gv-world .gv-ghost[data-for="${id}"]`)].map((g) => g.textContent);
  assert.deepEqual(ghosts('n3'), ['foldedasked a question', 'foldedtalked it through'],
    'the two chat-only turns that committed no node, oldest first');
  assert.deepEqual(ghosts('n5'), ['foldedlegacy chat'], 'a legacy collapsed node rides the same way');
  assert.equal(ghosts('n4').length, 0);
  const afterN3 = srow('n3').nextElementSibling;
  assert.ok(afterN3.classList.contains('gv-ghost'), 'directly under their node');
  assert.equal(afterN3.tagName, 'DIV', 'a ghost is not a button — it is not a node and cannot be selected');
});

test('selecting a node inside a collapsed stack expands it', async () => {
  assert.equal(sleeve(), null, 'precondition: collapsed');
  const jump = $('gv-jump');
  jump.value = 'edit 4';
  jump.dispatchEvent(new W.Event('input', { bubbles: true }));
  key('Enter', jump);
  await tick();
  assert.ok(sleeve(), 'the search hit is inside the stack, so the stack opened');
  assert.equal(selectedId(), 'n5', 'and the hit is selected');
  assert.ok(srow('n5').classList.contains('selected'));
});

test('⊟ Collapse all folds every open sleeve', async () => {
  click(stack());
  await tick();
  assert.ok(sleeve());
  click($('gv-collapse-all'));
  await tick();
  assert.equal(sleeve(), null);
});

test('arrow keys walk into a stack (expanding it) and back out (collapsing it)', async () => {
  click(glyph('n1'));
  await tick();
  key('ArrowDown');
  await tick();
  assert.equal(selectedId(), 'n2', 'down from the root enters the run');
  assert.ok(sleeve(), 'entering expanded it');
  key('ArrowUp');
  await tick();
  assert.equal(selectedId(), 'n1');
  assert.equal(sleeve(), null, 'leaving collapsed it');
});

test('⚑ Marked and the jump search DIM what does not match — they never hide it', async () => {
  const marked = $('gv-filters').querySelector('[data-filter="marked"]');
  click(marked);
  await tick();
  assert.equal(marked.getAttribute('aria-pressed'), 'true');
  const lit = [...W.document.querySelectorAll('#graph-svg g.gv-node:not(.dim)')].map((g) => g.dataset.id).sort();
  assert.deepEqual(lit, ['n1', 'n13'], 'the bookmarks stay lit');
  assert.ok(glyph('n12').classList.contains('dim'), 'the rest is dimmed, still drawn');
  assert.ok(stack().classList.contains('dim'), 'a stack with no match dims too');
  click(marked);
  await tick();

  const jump = $('gv-jump');
  jump.value = 'scratch';
  jump.dispatchEvent(new W.Event('input', { bubbles: true }));
  await tick();
  const litQ = [...W.document.querySelectorAll('#graph-svg g.glyph:not(.dim)')].map((g) => g.dataset.id || g.dataset.stackHead);
  assert.deepEqual(litQ, ['n20'], 'only tree 2\'s stack (n20 + n21) has a match');
  key('Enter', jump);
  await tick();
  assert.equal(selectedId(), 'n20', '↵ selects the first match…');
  assert.ok(srow('n20'), '(opening the stack it is in)');
  key('Enter', jump);
  await tick();
  assert.equal(selectedId(), 'n21', '…and the next one on the next ↵');
});

test('a wipe\'s bookmark reads "⌫ wipe · <name>"; an ordinary one "⚑ <name>"', () => {
  assert.equal(glyph('n13').querySelector('.gv-bm').textContent, '⌫ wipe · before cleanup');
  assert.equal(glyph('n1').querySelector('.gv-bm'), null, 'a root\'s name is its tree title, not repeated');
});

test('⑃ Branch sets the node active through the one POST, and says the next commit forks', async () => {
  click(glyph('n12'));
  await tick();
  assert.equal($('gv-branch').disabled, true, 'the active node is already where the next commit lands');
  click(glyph('n1'));
  await tick();
  click($('gv-branch'));
  await tick(); await tick();
  const post = calls.find((c) => c.url === '/api/graph/active' && c.method === 'POST');
  assert.deepEqual(post && post.body, { id: 'n1' });
  assert.match($('gv-toast').textContent, /Next commit branches from n1\.0/, 'n1 has a child, so the next commit is a fork');
});

test('⚑ Unmark clears a bookmark with no prompt', async () => {
  click(glyph('n13'));
  await tick();
  const btn = $('gv-inspector').querySelector('[data-act="unmark"]');
  assert.ok(btn, 'a bookmarked node offers Unmark');
  assert.equal($('gv-inspector').querySelector('[data-act="bookmark"]'), null, 'instead of Bookmark');
  click(btn);
  await tick();
  const post = calls.find((c) => c.url === '/api/graph/bookmark');
  assert.deepEqual(post && post.body, { id: 'n13', name: '' });
  assert.ok($('gv-name-panel').classList.contains('hidden'), 'no name panel');
});

test('Glance: Space opens a read-only render with "Set active here"', async () => {
  click(glyph('n14'));
  await tick();
  key(' ');
  await tick();
  const card = W.document.querySelector('.glance-backdrop');
  assert.ok(card, 'the glance is up');
  assert.match(card.querySelector('.glance-title').textContent, /^n1\.11\.0 · glance$/);
  assert.equal(card.querySelector('.glance-frame').getAttribute('src'), '/preview/node/n14');
  click(card.querySelector('[data-act="active"]'));
  await tick(); await tick();
  const post = calls.find((c) => c.url === '/api/graph/active');
  assert.deepEqual(post && post.body, { id: 'n14' });
  assert.equal(W.document.querySelector('.glance-backdrop'), null, 'and it closed');
});

test('◇ New closes the graph and opens the new-graph panel', async () => {
  if (!overlayOpen()) { click($('btn-graph')); await tick(); await tick(); }
  click($('gv-new'));
  await tick();
  assert.equal(overlayOpen(), false);
  assert.ok(!$('new-graph-panel').classList.contains('hidden'));
  key('Escape', $('new-graph-name'));
  $('new-graph-panel').classList.add('hidden');
});

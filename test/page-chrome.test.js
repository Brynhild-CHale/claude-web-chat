// The live page renderer (UX upgrade p34c, unit c1) — public/app/page.js driven
// as real DOM against the real front-end module graph in jsdom (the harness of
// test/block-chrome.test.js; one boot per FILE, cases run in order over one
// shell). /app/markdown.js is the daemon-served renderer; the test harness
// resolves it to the same source (test-support/served-modules.js).
//
// Pinned here:
//   - #main is the page: markdown chunks rendered by the one renderer (escaped)
//     between grid RUNS, each its own 12-col grid, panes placed by col/span/rows;
//   - stable DOM: a markdown edit, a re-render or a reorder never remounts or
//     re-parents an unrelated pane;
//   - the page title (first # heading) in the topbar and as the H1 with its meta
//     line; the read-only badge while previewing;
//   - the Contents nav: #/## rows, numbered, pane counts, click scrolls;
//   - the run header: ↺ Claude's layout only when the run is off its baseline,
//     the stacks/fixed chip, both posting to the daemon's page routes;
//   - drag within a run: column snap, splice by hover, reading-order drop →
//     one user move + the new column; a locked pane does not drag;
//   - ⌘K section rows, and a block row's section number;
//   - a preview folds page frames aside and shows the previewed page.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

const T0 = new Date(2026, 8, 26, 14, 6).getTime();
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: T0 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: T0 + 60000 },
];
const NODE_PAGES = {
  n2: {
    // two panes in one run, off Claude's order: a live page would offer ↺ and
    // the stacks chip here
    mounts: [
      { id: 'old', html: '<p>old</p>', target: 'main', params: {}, pane_state: { colSpan: 6 } },
      { id: 'old2', html: '<p>old2</p>', target: 'main', params: {}, pane_state: { colSpan: 6 } },
    ],
    markdown: [{ id: 'md-old', text: '# Old page\n\nwas here' }],
    order: ['md-old', 'old', 'old2'],
    claude_order: ['md-old', 'old2', 'old'],
  },
};

const placed = (col, span, rows) => ({ col, colSpan: span, rows, heightPx: rows * 40, claude_place: { col, span, rows } });
const MARKDOWN = [
  { id: 'md-title', text: '# Experiment 12\n\nIntro with <script>window.__pwned = 1</script> and **bold**.', owner: 'claude' },
  { id: 'md-res', text: '## Results\n\nConductivity rises.\n\n### A detail\n\nnot a section', owner: 'claude' },
  { id: 'md-disc', text: '# Discussion', owner: 'claude' },
];
const MOUNTS = [
  { id: 'a', html: '<p>a</p>', target: 'main', params: { type: 'method' }, pane_state: placed(1, 6, 4) },
  { id: 'b', html: '<p>b</p>', target: 'main', params: {}, pane_state: placed(7, 6, 4) },
  { id: 'c', html: '<p>c</p>', target: 'main', params: { type: 'figure' }, pane_state: {} },
  { id: 'd', html: '<p>d</p>', target: 'main', params: {}, pane_state: {} },
];
const ORDER = ['md-title', 'a', 'b', 'md-res', 'c', 'md-disc', 'd'];

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
      const n = NODES.find((x) => x.id === id);
      return json({ ...n, author: 'claude', store: {}, ...(NODE_PAGES[id] || { mounts: [] }) });
    }
    if (u === '/api/components') return json({ components: [] });
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
    'HTMLElement', 'Node', 'Element', 'Event'];
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

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => W.document.getElementById(id);
const pane = (id) => [...W.document.querySelectorAll('#main .pane')].find((p) => p.dataset.paneId === id);
const host = (id) => pane(id).querySelector('.mount-host');
const run = (anchor) => [...W.document.querySelectorAll('#main .page-run')].find((r) => r.dataset.anchor === anchor);
const md = (id) => W.document.querySelector(`#main .md-block[data-md-id="${id}"]`);
const frame = (msg) => WS.onmessage({ data: JSON.stringify(msg) });
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
const posts = (url) => calls.filter((c) => c.method === 'POST' && c.url === url);
const pointer = (el, type, x, y) => {
  const e = new W.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pageY', { value: y });
  el.dispatchEvent(e);
};
const hello = (extra = {}) => frame({
  type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
  mounts: MOUNTS.map((m) => ({ ...m, pane_state: { ...m.pane_state } })),
  markdown: MARKDOWN.map((m) => ({ ...m })), order: ORDER.slice(), claude_order: ORDER.slice(),
  runs: { 'md-res': { stacks: false } }, ...extra,
});

before(async () => {
  await boot();
  await tick();
  hello();
  await tick(60);
});

after(async () => {
  await tick(400);
  restore();
});

test('#main is the page: prose between grid runs, panes placed by col / span / rows', () => {
  const kids = [...$('main').children].map((el) => (el.classList.contains('md-block') ? `md:${el.dataset.mdId}`
    : el.classList.contains('page-run') ? `run:${el.dataset.anchor}` : el.className));
  assert.deepEqual(kids, ['md:md-title', 'run:md-title', 'md:md-res', 'run:md-res', 'md:md-disc', 'run:md-disc', 'page-tail'],
    'each run of consecutive panes is its own grid, anchored by the markdown before it; the page ends in the tail');
  const inRun = (a) => [...run(a).querySelectorAll('.run-grid > .pane')].map((p) => p.dataset.paneId);
  assert.deepEqual(inRun('md-title'), ['a', 'b']);
  assert.deepEqual(inRun('md-res'), ['c']);
  const b = pane('b');
  assert.equal(b.style.getPropertyValue('--col'), '7');
  assert.equal(b.style.getPropertyValue('--span'), '6');
  assert.equal(b.style.getPropertyValue('--rows'), '4');
  assert.ok(b.classList.contains('has-rows'));
  assert.equal(pane('c').style.getPropertyValue('--col'), 'auto', 'a pane without a column flows');
  assert.equal(pane('c').classList.contains('has-rows'), false, 'and without rows takes its content height');
  assert.ok(run('md-res').classList.contains('fixed'), "a run flagged stacks:false is a fixed grid");
  assert.ok(run('md-title').classList.contains('stacks'), 'the default run stacks on narrow');
  assert.equal(run('md-res').querySelector('.run-fixed-hint').textContent, 'FIXED GRID · SCROLL →');
});

test('markdown goes through the one renderer: escaped, headings slugged', () => {
  const block = md('md-title');
  assert.equal(block.querySelector('script'), null, 'raw HTML in markdown is text, never markup');
  assert.match(block.textContent, /<script>window\.__pwned = 1<\/script>/);
  assert.equal(W.__pwned, undefined);
  assert.equal(block.querySelector('strong').textContent, 'bold');
  assert.equal(md('md-res').querySelector('h2').dataset.slug, 'results');
});

test('the page title: the first # heading, in the topbar and as the H1 with its meta line', async () => {
  assert.equal($('page-title').textContent, 'Experiment 12');
  const h1 = md('md-title').querySelector('h1');
  assert.ok(h1.classList.contains('page-h1'), 'the title heading is styled as the page H1');
  const meta = h1.nextElementSibling;
  assert.ok(meta && meta.classList.contains('page-meta'), 'its meta line follows it');
  assert.match(meta.textContent, /^n1\.0 · 4 panes · updated \d\d:\d\d/);
  assert.equal(meta.querySelector('.page-badge'), null, 'no read-only badge on the live page');
  assert.equal(W.document.querySelectorAll('.page-h1').length, 1, 'only the first # heading is the title');
});

test('the Contents nav: one numbered row per # / ## heading, with the panes under each', () => {
  const rows = [...$('contents-nav').querySelectorAll('.cn-row')];
  assert.deepEqual(rows.map((r) => r.querySelector('.cn-num').textContent), ['1', '1.1', '2']);
  assert.deepEqual(rows.map((r) => r.querySelector('.cn-name').textContent), ['Experiment 12', 'Results', 'Discussion']);
  assert.deepEqual(rows.map((r) => r.querySelector('.cn-count').textContent), ['2', '1', '1']);
  assert.deepEqual(rows.map((r) => r.classList.contains('sub')), [false, true, false], 'a ## row is indented');
  // (md-res also carries a ### heading: a sub-heading inside a section, not a row)
  let scrolled = null;
  md('md-res').querySelector('h2').scrollIntoView = (o) => { scrolled = o; };
  click(rows[1]);
  assert.deepEqual(scrolled, { behavior: 'smooth', block: 'start' }, 'a row smooth-scrolls to its heading');
  assert.ok($('contents-nav').querySelector('.cn-tip'), 'with the footer tip');
});

test('stable DOM: a markdown edit, a re-render and a reorder touch nothing else', async () => {
  const hosts = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, host(id)]));
  const grid = pane('a').parentElement;
  frame({ type: 'markdown', id: 'md-res', text: '## Results\n\nConductivity rises, then *rolls off*.', owner: 'claude',
    order: ORDER.slice(), claude_order: ORDER.slice() });
  await tick();
  assert.equal(md('md-res').querySelector('em').textContent, 'rolls off', 'the edit landed');
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(host(id), hosts[id], `pane ${id} was not remounted by a markdown edit`);

  frame({ type: 'render', id: 'b', html: '<p>b, again</p>', target: 'main', params: {}, pane_state: placed(7, 6, 4) });
  await tick();
  assert.notEqual(host('b'), hosts.b, 'the re-rendered pane is new');
  for (const id of ['a', 'c', 'd']) assert.equal(host(id), hosts[id], `pane ${id} was not remounted by b's re-render`);
  assert.equal(pane('b').parentElement, grid, 'and b went straight back into its run');

  frame({ type: 'page:order', order: ['md-title', 'b', 'a', 'md-res', 'c', 'md-disc', 'd'] });
  await tick();
  assert.equal(pane('a').parentElement, grid, 'a reorder within a run re-parents nothing');
  assert.equal(host('a'), hosts.a);
  assert.deepEqual([pane('b').style.order, pane('a').style.order], ['0', '1'], 'the run is re-ordered with CSS order');
});

test("↺ Claude's layout shows only on a run that is off its baseline, and asks the daemon", async () => {
  // The reorder above moved a/b off Claude's order: that run is dirty.
  const reset = run('md-title').querySelector('.run-reset');
  assert.ok(reset, "the run's header offers ↺");
  assert.equal(reset.textContent, "↺ Claude's layout");
  assert.equal(run('md-disc').querySelector('.run-reset'), null, 'an untouched run offers nothing');
  assert.equal(run('md-disc').querySelector('.run-head').hidden, true, 'and a one-pane stacked run has no header at all');
  click(reset);
  await tick();
  assert.deepEqual(posts('/api/page/reset-layout').pop().body, { run_anchor: 'md-title' });

  // The daemon answers with the order Claude proposed: clean again.
  frame({ type: 'page:order', order: ORDER.slice() });
  await tick();
  assert.equal(run('md-title').querySelector('.run-reset'), null, 'back on Claude\'s layout, ↺ goes away');

  // A resize is the other way off it: c was never placed, so its baseline is the
  // full row — six columns is a change.
  frame({ type: 'pane:state', id: 'c', pane_state: { colSpan: 6 } });
  await tick();
  assert.ok(run('md-res').querySelector('.run-reset'), 'a resized pane makes its run dirty');
  frame({ type: 'pane:state', id: 'c', pane_state: { colSpan: 12, col: null, rows: null, heightPx: null } });
  await tick();
  assert.equal(run('md-res').querySelector('.run-reset'), null);
  // …but a LOCKED pane keeps its size through a reset, so it never makes a run dirty.
  frame({ type: 'pane:state', id: 'c', pane_state: { colSpan: 6, locked: true } });
  await tick();
  assert.equal(run('md-res').querySelector('.run-reset'), null);
  frame({ type: 'pane:state', id: 'c', pane_state: { colSpan: 12, locked: false } });
  await tick();
});

test('the stacks / fixed-grid chip flips a run through the daemon, and follows its frame', async () => {
  const chip = run('md-res').querySelector('.run-stacks');
  assert.ok(chip, 'a fixed run keeps its chip even with one pane, so it can be turned back');
  assert.equal(chip.textContent, 'fixed grid');
  click(chip);
  await tick();
  assert.deepEqual(posts('/api/page/run').pop().body, { anchor: 'md-res', stacks: true });
  frame({ type: 'page:run', anchor: 'md-res', stacks: true });
  await tick();
  assert.ok(run('md-res').classList.contains('stacks'));
  assert.equal(run('md-res').querySelector('.run-stacks'), null, 'a one-pane stacked run has nothing to keep in a row');
  const two = run('md-title').querySelector('.run-stacks');
  assert.equal(two.textContent, 'stacks on narrow');
  click(two);
  await tick();
  assert.deepEqual(posts('/api/page/run').pop().body, { anchor: 'md-title', stacks: false });
});

test('minimized blocks are chips under their own run', async () => {
  frame({ type: 'pane:state', id: 'a', pane_state: { minimized: true } });
  await tick();
  const chips = [...W.document.querySelectorAll('#main .min-chip')];
  assert.equal(chips.length, 1);
  assert.equal(chips[0].closest('.page-run').dataset.anchor, 'md-title');
  frame({ type: 'pane:state', id: 'a', pane_state: { minimized: false } });
  await tick();
  assert.equal(W.document.querySelector('#main .min-chip'), null);
});

test('drag within a run: the column snaps, hovering takes a slot, the drop is one user move', async () => {
  // Lay the first run out by hand (jsdom lays nothing out): a 886px grid — 12
  // columns of 60px + 11 gaps of 14px — with each pane drawn at its CSS order's
  // slot, 444px apart, 202px tall.
  const grid = pane('a').parentElement;
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 886, bottom: 202, width: 886, height: 202 });
  for (const id of ['a', 'b']) {
    const w = pane(id);
    w.getBoundingClientRect = () => {
      const left = Number(w.style.order) * 444;
      return { left, top: 0, right: left + 430, bottom: 202, width: 430, height: 202 };
    };
  }
  sent.length = 0;
  const before = posts('/api/page/move').length;
  const handle = pane('b').querySelector('.pane-title');
  pointer(handle, 'pointerdown', 500, 10);        // grab b 56px in from its left edge
  assert.ok(W.document.querySelector('.pane-ghost'), 'the drag started');
  pointer(handle, 'pointermove', 60, 10);         // over a, at column 1
  assert.equal(pane('b').style.getPropertyValue('--col'), '1', 'the start column follows the pointer, snapped');
  assert.deepEqual([pane('b').style.order, pane('a').style.order], ['0', '1'], 'b took the hovered slot');
  pointer(handle, 'pointerup', 60, 10);
  await tick(120);
  assert.equal(W.document.querySelector('.pane-ghost'), null);
  const moves = posts('/api/page/move').slice(before);
  assert.deepEqual(moves.map((c) => c.body), [{ id: 'b', after: 'md-title' }],
    'reading order b, a — told to the daemon as the one move that makes it');
  const st = [...sent].reverse().find((f) => f.type === 'pane:state' && f.id === 'b');
  assert.equal(st && st.pane_state.col, 1, 'the new column persists through pane:state');
  assert.equal('claude_place' in st.pane_state, false, "Claude's baseline is never echoed back");
  assert.ok(run('md-title').querySelector('.run-reset'), 'and the run is now off Claude\'s layout');
});

test('a locked block does not drag', async () => {
  frame({ type: 'pane:state', id: 'd', pane_state: { locked: true } });
  await tick();
  pointer(pane('d').querySelector('.pane-title'), 'pointerdown', 10, 10);
  assert.equal(W.document.querySelector('.pane-ghost'), null);
  frame({ type: 'pane:state', id: 'd', pane_state: { locked: false } });
  await tick();
});

test('⌘K lists the sections, and a block row names its section', async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  await tick();
  const input = $('cmd-input');
  input.value = 'results';
  input.dispatchEvent(new W.Event('input', { bubbles: true }));
  await tick();
  const rows = [...$('cmd-list').querySelectorAll('.palette-item')];
  const section = rows.find((r) => r.dataset.kind === 'section');
  assert.ok(section, 'a section row');
  assert.equal(section.querySelector('.label').textContent, '1.1  Results');
  let scrolled = false;
  md('md-res').querySelector('h2').scrollIntoView = () => { scrolled = true; };
  section.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true }));
  await tick();
  assert.ok(scrolled, 'choosing it scrolls to the heading');

  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  await tick();
  input.value = 'figure';
  input.dispatchEvent(new W.Event('input', { bubbles: true }));
  await tick();
  const block = [...$('cmd-list').querySelectorAll('.palette-item')].find((r) => r.dataset.kind === 'block');
  assert.equal(block.querySelector('.hint').textContent, '§1.1 · figure');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
});

test('a preview shows the previewed page read-only, and folds live page frames aside', async () => {
  click($('btn-down'));
  await tick(60);
  assert.ok($('main').classList.contains('preview-readonly'), 'precondition: previewing n2');
  assert.equal($('page-title').textContent, 'Old page');
  const meta = md('md-old').querySelector('.page-meta');
  assert.match(meta.textContent, /^n1\.1 · 2 panes/);
  assert.equal(meta.querySelector('.page-badge').textContent, 'PREVIEW · READ-ONLY');
  assert.equal(W.document.querySelector('#main .page-tail'), null, "no 'Claude's next turn' tail on a read-only page");
  assert.equal(W.document.querySelector('#main .run-head button'), null, 'and no run controls');
  assert.equal($('contents-nav').querySelector('.cn-tip'), null, 'nor the Contents tip about adding to the page');

  frame({ type: 'markdown', id: 'md-new', text: '## Appendix', owner: 'claude',
    order: [...ORDER, 'md-new'], claude_order: [...ORDER, 'md-new'] });
  await tick();
  assert.equal(md('md-new'), null, 'a live markdown write does not land on the previewed page');

  click($('btn-return-active'));
  await tick(60);
  assert.equal($('main').classList.contains('preview-readonly'), false);
  assert.ok(md('md-new'), 'it was folded into the live page and is there on return');
  assert.equal($('page-title').textContent, 'Experiment 12');
  assert.deepEqual([...$('contents-nav').querySelectorAll('.cn-num')].map((n) => n.textContent), ['1', '1.1', '2', '2.1']);
});

test('markdown:remove merges the runs around it; a page with no headings has no title and no contents', async () => {
  frame({ type: 'markdown:remove', id: 'md-disc' });
  await tick();
  assert.equal(run('md-disc'), undefined);
  assert.deepEqual([...run('md-res').querySelectorAll('.run-grid > .pane')].map((p) => p.dataset.paneId).sort(), ['c', 'd'],
    'd joined the run before it');

  frame({ type: 'reset', store: {}, active: 'n1', lock: null, mounts: MOUNTS.map((m) => ({ ...m })), markdown: [], order: [], runs: {} });
  await tick();
  assert.equal($('page-title').textContent, '');
  assert.equal($('contents-nav').childElementCount, 0, 'the nav empties (and app.css hides it)');
  assert.deepEqual([...$('main').children].map((el) => el.className.split(' ')[0]), ['page-run', 'page-tail'],
    'a page without markdown is one grid run, as it always was');
});

// chrome-4: a page with no `#` — only `##` sections, a common shape for a page
// Claude writes — numbers them 1, 2 (top level, not indented), not 0.1, 0.2; a
// `#` that comes later is the next top-level number, and `##` nests under it.
test('a page with only ## sections numbers them from 1, in Contents, ⌘K and block hints', async () => {
  frame({ type: 'reset', store: {}, active: 'n1', lock: null, mounts: MOUNTS.map((m) => ({ ...m, pane_state: { ...m.pane_state } })),
    markdown: [
      { id: 'md-r', text: '## Results', owner: 'claude' },
      { id: 'md-n', text: '## Next steps', owner: 'claude' },
      { id: 'md-x', text: '# Appendix\n\n## Raw data', owner: 'claude' },
    ],
    order: ['md-r', 'a', 'md-n', 'c', 'md-x', 'd'], runs: {} });
  await tick(60);
  const rows = [...$('contents-nav').querySelectorAll('.cn-row')];
  assert.deepEqual(rows.map((r) => r.querySelector('.cn-num').textContent), ['1', '2', '3', '3.1']);
  assert.deepEqual(rows.map((r) => r.classList.contains('sub')), [false, false, false, true],
    'a ## with no # above it is a top-level row');

  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  await tick();
  const input = $('cmd-input');
  input.value = 'next';
  input.dispatchEvent(new W.Event('input', { bubbles: true }));
  await tick();
  const section = [...$('cmd-list').querySelectorAll('.palette-item')].find((r) => r.dataset.kind === 'section');
  assert.equal(section.querySelector('.label').textContent, '2  Next steps');
  input.value = 'figure';
  input.dispatchEvent(new W.Event('input', { bubbles: true }));
  await tick();
  const block = [...$('cmd-list').querySelectorAll('.palette-item')].find((r) => r.dataset.kind === 'block');
  assert.equal(block.querySelector('.hint').textContent, '§2 · figure');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
});

// ── the node preview draws the page the same way ────────────────────────────
// lib/server/preview.js (graph thumbnails, the glance, pane history, replay
// frames) inlines the SAME stylesheet (public/page.css) and cuts the sequence
// into the same runs, placing each pane with the same three properties — so a
// node looks the same in its preview as it did live. The export inlines the
// stylesheet too, for its prose.
test('the preview document lays the page out in the same runs, under the same stylesheet', () => {
  const { renderPreviewHtml } = require('../lib/server/preview');
  const { assembleExport } = require('../lib/server/export');
  const pageCss = fs.readFileSync(path.join(REPO, 'public/page.css'), 'utf8');
  const node = {
    id: 'n9',
    mounts: MOUNTS.map((m) => ({ ...m })),
    markdown: MARKDOWN.map((m) => ({ ...m })),
    order: ORDER.slice(),
    runs: { 'md-res': { stacks: false } },
  };
  const html = renderPreviewHtml(node, { tokens: {} });
  assert.ok(html.includes(pageCss.trim().split('\n').slice(-3).join('\n')), 'public/page.css is inlined verbatim');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const doc = dom.window.document;
  const kids = [...doc.getElementById('main').children].map((el) => (el.classList.contains('md-block') ? `md:${el.dataset.mdId}`
    : `run:${el.dataset.anchor}:${el.className}`));
  assert.deepEqual(kids, ['md:md-title', 'run:md-title:page-run stacks', 'md:md-res', 'run:md-res:page-run fixed',
    'md:md-disc', 'run:md-disc:page-run stacks']);
  const b = [...doc.querySelectorAll('.pane')].find((p) => p.querySelector('.mount-host').id === 'b');
  assert.deepEqual(['--col', '--span', '--rows'].map((k) => b.style.getPropertyValue(k)), ['7', '6', '4']);
  assert.ok(b.classList.contains('has-rows'));
  dom.window.close();

  const out = assembleExport({ mounts: [], markdown: [{ id: 'x', text: 'hi' }], order: ['x'] });
  assert.ok(out.includes('.md-block {'), 'the export carries the page stylesheet for its prose');
});

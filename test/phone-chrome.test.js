// Narrow + phone (plan §2 P2 "Responsive"; design "Layout Engine" narrow/phone +
// "Graph Prototype" phone), driven as real DOM events against the REAL front-end
// module graph in jsdom. One boot per FILE, as a PHONE (a stubbed matchMedia
// answers the phone query), flipped back to a desktop at the end.
//
// Pinned here:
//   * The fork gutter is COMPUTED from the drawn parents (log-lanes.js), not
//     hand-placed: lanes, pass-through lines and the merge curve of a fork.
//   * The narrow bottom bar drives the topbar's own ↑/↓, ↩ active and Graph and
//     mirrors their state; Queue [n] opens the rail as the queue screen, reads
//     "‹ Page" while it is open, and carries the queue count.
//   * A phone is a read-only viewer: form edits in a pane refuse with a note that
//     points at the queue, header writes refuse, and a minimized block's chip only
//     peeks at it locally — nothing reaches the live surface.
//   * The phone's graph screen is a newest-first log of one graph: cards with
//     ACTIVE / ⑃ / ⚑ / time / trigger, ⋯ N folded ghost rows, filters that hide,
//     a graph switcher, and an action bar (Set active, ⚑ with a name field,
//     Glance) over the same routes the desktop canvas uses.
//   * Leaving the phone posture gives the canvas and editing back, in place.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

//  tree 1 ("anneal"): n1 ─ n2 ─ n3 ┬ n4 ─ n5      (n4 is the trunk: the older child)
//                                  └ n6 (active; two chat-only turns folded onto it)
//  tree 2 (unnamed):  n20 ─ n21
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1, bookmarked: true, name: 'anneal', trigger_summary: 'start the write-up', children: ['n2'] },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2, trigger_summary: 'parameters beside the method', children: ['n3'] },
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: 3, trigger_summary: 'plot conductivity', children: ['n4', 'n6'] },
  { id: 'n4', label: 'n1.2.0', parent_id: 'n3', created_at: 4, trigger_summary: 'log scale', children: ['n5'] },
  { id: 'n5', label: 'n1.2.1', parent_id: 'n4', created_at: 5, trigger_summary: 'error bars', children: [] },
  { id: 'n6', label: 'n1.3', parent_id: 'n3', created_at: 6, trigger_summary: 'compare with Kim et al.', folded_count: 2, children: [] },
  { id: 'n20', label: 'n2.0', parent_id: null, created_at: 20, trigger_summary: 'protocol draft', children: ['n21'] },
  { id: 'n21', label: 'n2.1', parent_id: 'n20', created_at: 21, trigger_summary: 'safety steps', children: [] },
];
const FOLDED = { n6: [{ at: 6.1, summary: 'check the form' }, { at: 6.2, summary: 'looks good, thanks' }] };
const MOUNTS = [
  { id: 'form', html: '<input id="t"><button type="button" id="plain">p</button>'
    + '<script>root.getElementById("plain").addEventListener("click", () => { window.__plain = (window.__plain || 0) + 1; });</script>', params: { title: 'Next run', type: 'form' }, pane_state: { colSpan: 4 } },
  { id: 'tucked', html: '<p>hidden</p>', params: { title: 'Tucked' }, pane_state: { minimized: true } },
];
const PHONE_QUERY = '(max-width: 759px) and (pointer: coarse)';

const calls = [];
let W = null, WS = null, sent = [], restore = () => {};
let phone = true;
const mqListeners = [];
const setPhone = (v) => { phone = v; for (const fn of mqListeners) fn(); };

before(async () => {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = (q) => ({
    media: q, get matches() { return q === PHONE_QUERY ? phone : false; },
    addEventListener: (t, fn) => { if (q === PHONE_QUERY) mqListeners.push(fn); }, removeEventListener() {},
  });
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
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n6' });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: [], store: {}, ...(FOLDED[id] ? { folded: FOLDED[id] } : {}) });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [], changed: [], removed: [] } });
    if (u === '/api/graph/active') return json({ ok: true, active: JSON.parse(opts.body).id });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.7.5', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
    return json({ ok: true });
  };
  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element', 'Event', 'EventTarget'];  // EventTarget: bus.js pairs it with jsdom's CustomEvent
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
  await tick();
  frame({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n6', lock: null, project: 'test', mounts: MOUNTS });
  await tick(20);
});

after(async () => {
  await new Promise((r) => setTimeout(r, 400)); // drain the theme-transition timer while the window lives
  restore();
});

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
const $ = (id) => W.document.getElementById(id);
const frame = (msg) => WS.onmessage({ data: JSON.stringify(msg) });
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
const pane = (id) => [...W.document.querySelectorAll('#main .pane')].find((p) => p.dataset.paneId === id);
const noteText = () => { const n = $('reaim-note'); return n ? n.textContent : ''; };
const cards = () => [...W.document.querySelectorAll('#gv-log-list .gv-lcard')].map((c) => c.dataset.id);
const row = (id) => W.document.querySelector(`#gv-log-list .gv-lrow[data-id="${id}"]`);
const lines = (id) => [...row(id).querySelectorAll('line')].map((l) => [+l.getAttribute('x1'), +l.getAttribute('y1'), +l.getAttribute('y2')]);

/* ---------------- the gutter arithmetic, on its own ---------------- */

test('the fork gutter is computed from the drawn parents, newest first', async () => {
  const { computeLogLanes, laneX, gutterWidth } = await import(pathToFileURL(path.join(REPO, 'public/app/log-lanes.js')).href);
  // The design's own example: n1.2 forks into n1.2.0 ─ n1.2.1 and the trunk n1.3 ─ n1.4.
  const { rows, lanes } = computeLogLanes([
    { id: 'n1.4', parent: 'n1.3' }, { id: 'n1.3', parent: 'n1.2' },
    { id: 'n1.2.1', parent: 'n1.2.0' }, { id: 'n1.2.0', parent: 'n1.2' },
    { id: 'n1.2', parent: 'n1.1' }, { id: 'n1.1', parent: 'n1.0' }, { id: 'n1.0', parent: null },
  ]);
  const at = (id) => rows.find((r) => r.id === id);
  assert.equal(lanes, 2, 'one fork = two lanes');
  assert.deepEqual(at('n1.4').lines, [{ lane: 0, y1: 50, y2: 100 }], 'a tip: a line leaves its dot downward only');
  assert.deepEqual(at('n1.2.1').col, 1, 'a second tip takes the next free lane');
  assert.deepEqual(at('n1.2.1').lines, [{ lane: 0, y1: 0, y2: 100 }, { lane: 1, y1: 50, y2: 100 }],
    'the trunk lane runs straight through the branch rows');
  assert.deepEqual(at('n1.2').merges, [{ from: 1, to: 0 }], 'the branch lane closes into its fork point');
  assert.deepEqual(at('n1.2').below, [0], 'below the fork point only the trunk continues');
  assert.deepEqual(at('n1.0').lines, [{ lane: 0, y1: 0, y2: 50 }], 'the root: a line arrives, none leaves');
  assert.equal(laneX(1) - laneX(0), 16);
  assert.equal(gutterWidth(1), 40, 'never narrower than the design gutter');
  assert.ok(gutterWidth(4) > gutterWidth(2), 'more lanes, a wider gutter');
  // A parent outside the rows (the log of one graph never sees another's) is no parent.
  assert.deepEqual(computeLogLanes([{ id: 'a', parent: 'elsewhere' }]).rows[0].lines, []);
});

// The log card, the canvas sleeve row and the ⌘K node hint all print a node's
// time: one formatter (labels.js nodeTime), not a private copy per unit.
test('a node\'s clock time has one formatter, labels.js nodeTime', async () => {
  const { nodeTime } = await import(pathToFileURL(path.join(REPO, 'public/app/labels.js')).href);
  assert.match(nodeTime({ created_at: Date.UTC(2026, 0, 1, 9, 5) }), /\d{1,2}:05/);
  assert.equal(nodeTime({}), '', 'no timestamp, no time');
  const dir = path.join(REPO, 'public/app');
  const homes = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('toLocaleTimeString'));
  assert.deepEqual(homes, ['labels.js'], 'format a node\'s time with labels.js nodeTime, never a private copy');
});

/* ---------------- the phone: a read-only viewer ---------------- */

test('a phone is marked on <html> and its panes are read-only', async () => {
  assert.ok(W.document.documentElement.classList.contains('phone'), '<html class="phone">');
  const host = pane('form').querySelector('.mount-host');
  assert.ok(host.hasAttribute('data-wc-readonly'), 'the pane is marked read-only while not previewing');
  sent.length = 0;
  const key = new W.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, composed: true });
  host.shadowRoot.getElementById('t').dispatchEvent(key);
  assert.equal(key.defaultPrevented, true, 'typing in a pane is refused on a phone');
  assert.match(noteText(), /Read-only on a phone .* Queue/, 'the note points at the queue, not the graph');
  click(host.shadowRoot.getElementById('plain'));
  assert.equal(W.__plain, 1, 'a plain button still works — viewing is not editing');

  const p = pane('form');
  click(p.querySelector('.pane-btn-pin'));
  click(p.querySelector('.pane-btn-min'));
  await tick(120);
  assert.equal(p.classList.contains('pinned'), false, 'pin refuses');
  assert.equal(p.classList.contains('minimized'), false, 'minimize refuses');
  assert.deepEqual(sent.filter((f) => f.type === 'pane:state'), [], 'no block write reached the live surface');
});

test("a minimized block's chip only peeks at it on a phone", async () => {
  const chip = W.document.querySelector('#minbar .min-chip');
  assert.ok(chip, 'the minimized block keeps its chip');
  sent.length = 0;
  click(chip);
  await tick(120);
  assert.ok(pane('tucked').classList.contains('peek'), 'shown here…');
  assert.ok(pane('tucked').classList.contains('minimized'), '…but still minimized on the live surface');
  assert.deepEqual(sent.filter((f) => f.type === 'pane:state'), [], 'restoring it would have been a write');
  click(W.document.querySelector('#minbar .min-chip'));
  assert.equal(pane('tucked').classList.contains('peek'), false, 'a second tap tucks it away again');
});

/* ---------------- the bottom bar ---------------- */

test("the bottom bar drives the topbar's own ↑/↓ and ↩ active, and mirrors them", async () => {
  assert.equal($('bb-down').disabled, true, 'the active tip has nothing below it — same as the topbar ↓');
  assert.equal($('bb-up').disabled, $('btn-up').disabled);
  assert.equal($('bb-return').style.display, 'none', '↩ active only while viewing');
  click($('bb-up'));
  await tick(20);
  assert.equal($('node-label').textContent, 'n1.2', '↑ previewed the drawn parent');
  assert.equal($('bb-return').style.display, '', '↩ active is offered while viewing');
  assert.equal($('bb-down').disabled, false, 'mirrors the topbar ↓ again');
  click($('bb-return'));
  await tick(20);
  assert.equal($('node-label').textContent, 'n1.3', 'back on the active node');
  assert.equal($('bb-return').style.display, 'none');
});

test('Queue [n] opens the queue screen, reads "‹ Page" while open, and counts', async () => {
  const q = $('bb-queue');
  frame({ type: 'queue', op: 'add', item: { id: 'q1', kind: 'signal', summary: 'next_run', enqueued_at: 1 } });
  assert.equal($('bb-queue-count').textContent, '1', 'the bar carries the queue count');
  click(q);
  assert.ok($('queue-rail').classList.contains('open'), 'the rail is open — on a narrow screen that is the queue screen');
  assert.equal(q.querySelector('.bb-queue-label').textContent, '‹ Page');
  assert.equal(q.getAttribute('aria-expanded'), 'true');
  click(q);
  assert.equal($('queue-rail').classList.contains('open'), false, '‹ Page goes back');
  assert.equal(q.querySelector('.bb-queue-label').textContent, 'Queue');
  click(q);
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(q.querySelector('.bb-queue-label').textContent, 'Queue', 'Escape closing the rail resets the label too');
  frame({ type: 'queue', op: 'clear' });
  assert.equal($('bb-queue-count').textContent, '0');
});

/* ---------------- the phone graph: a log ---------------- */

test("the phone's graph screen is a newest-first log of one graph, behind a computed gutter", async () => {
  click($('bb-graph'));
  await tick(30);
  assert.ok(!$('overlay').classList.contains('hidden'), 'Graph opened the graph screen');
  assert.ok($('overlay').classList.contains('log-mode'), 'as a log, not a canvas');
  assert.deepEqual(cards(), ['n6', 'n5', 'n4', 'n3', 'n2', 'n1'], 'newest first; the other graph is not mixed in');
  assert.equal($('gv-log-graph').value, 'n1', "the switcher is on the active node's graph");
  assert.deepEqual([...$('gv-log-graph').options].map((o) => o.textContent), ['anneal', 'graph n2']);

  const n6 = row('n6').querySelector('.gv-lcard');
  assert.ok(n6.querySelector('.gv-badge.active'), 'ACTIVE');
  assert.ok(n6.querySelector('.gv-badge.fork'), '⑃ — n6 is the non-trunk child of the fork at n1.2');
  assert.match(n6.querySelector('.gv-lcard-folded').textContent, /2 folded/);
  assert.match(row('n1').querySelector('.gv-lcard .bm').textContent, /⚑ anneal/);
  assert.equal(row('n1').querySelector('.gv-lcard-trig').textContent, 'start the write-up');

  // n6 (newest) holds lane 0; the older branch n5 ─ n4 takes lane 1 and closes into n3.
  assert.deepEqual(lines('n5'), [[14, 0, 100], [30, 50, 100]], 'the lane-0 line passes the lane-1 tip');
  assert.equal(row('n5').querySelector('.gv-ldot').style.left, '25px', 'the dot sits on its lane');
  assert.equal(row('n3').querySelector('path.gv-merge').getAttribute('d'), 'M30 0 C30 34 14 22 14 50', 'the fork curve');

  assert.equal($('gv-log-sel').textContent, 'n1.3', 'the log starts on the active node');
  assert.equal($('gv-log-active').disabled, true, 'which is already active');
});

test('⋯ N folded shows the ghost rows; filters and search hide what does not match', async () => {
  const fchip = W.document.querySelector('#gv-log-filters [data-folded]');
  assert.equal(fchip.hidden, false);
  assert.equal(fchip.textContent, '⋯ 2 folded');
  click(fchip);
  await tick(20);   // the folded texts are fetched from the node record on demand
  const ghosts = [...W.document.querySelectorAll('#gv-log-list .gv-lrow.ghost')].map((g) => g.querySelector('.txt').textContent);
  assert.deepEqual(ghosts, ['check the form', 'looks good, thanks'], 'the turns that folded onto n6');
  assert.equal(row('n6').nextElementSibling.classList.contains('ghost'), true, 'directly under their card');
  click(fchip);
  assert.equal(W.document.querySelectorAll('#gv-log-list .gv-lrow.ghost').length, 0);

  click(W.document.querySelector('#gv-log-filters [data-filter="marked"]'));
  assert.deepEqual(cards(), ['n1'], '⚑ Marked hides the rest');
  assert.equal(W.document.querySelectorAll('#gv-log-list line').length, 0, 'no lines join rows that are not neighbours');
  click(W.document.querySelector('#gv-log-filters [data-filter="marked"]'));
  assert.equal(W.document.querySelector('#gv-filters [data-filter="marked"]').getAttribute('aria-pressed'), 'false',
    "the canvas's chip follows the one filter state");

  const q = $('gv-log-q');
  q.value = 'n1.2';
  q.dispatchEvent(new W.Event('input', { bubbles: true }));
  assert.deepEqual(cards(), ['n5', 'n4', 'n3']);
  q.value = '';
  q.dispatchEvent(new W.Event('input', { bubbles: true }));
  assert.equal(cards().length, 6);
});

test('the action bar acts on the selected card: set active, bookmark with a name, glance', async () => {
  click(row('n5').querySelector('.gv-lcard'));
  assert.equal($('gv-log-sel').textContent, 'n1.2.1');
  assert.ok(row('n5').querySelector('.gv-lcard').classList.contains('selected'));
  assert.equal($('gv-log-active').disabled, false);

  const before = calls.length;
  click(W.document.querySelector('#gv-log-acts [data-act="bookmark"]'));
  assert.equal($('gv-log-naming').classList.contains('hidden'), false, '⚑ opens a name field');
  $('gv-log-name').value = 'kim window';
  click($('gv-log-name-save'));
  await tick(20);
  const bm = calls.slice(before).find((c) => c.url === '/api/graph/bookmark');
  assert.deepEqual(bm && bm.body, { id: 'n5', name: 'kim window' }, 'the one bookmark route, with the name');

  click($('gv-log-active'));
  await tick(20);
  const act = calls.slice(before).find((c) => c.url === '/api/graph/active');
  assert.deepEqual(act && act.body, { id: 'n5' }, 'Set active is the one set-active POST');

  click(W.document.querySelector('#gv-log-acts [data-act="glance"]'));
  const sheet = W.document.querySelector('.glance-backdrop');
  assert.ok(sheet, 'Glance raises the preview (a bottom sheet on a phone)');
  assert.equal(sheet.querySelector('.glance-frame').getAttribute('src'), '/preview/node/n5');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(W.document.querySelector('.glance-backdrop'), null);
  assert.ok(!$('overlay').classList.contains('hidden'), 'Escape closed the sheet, not the log');
});

test('the graph switcher shows another graph', async () => {
  const sel = $('gv-log-graph');
  sel.value = 'n20';
  sel.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.deepEqual(cards(), ['n21', 'n20']);
  assert.equal($('gv-log-sel').textContent, 'n2.1', "it lands on that graph's newest turn");
});

/* ---------------- leaving the phone posture ---------------- */

test('leaving the phone gives the canvas and editing back, in place', async () => {
  setPhone(false);
  await tick(20);
  assert.equal(W.document.documentElement.classList.contains('phone'), false);
  assert.equal($('overlay').classList.contains('log-mode'), false, 'the open graph is a canvas again');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));   // deselect
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));   // close
  assert.ok($('overlay').classList.contains('hidden'));
  const host = pane('form').querySelector('.mount-host');
  assert.equal(host.hasAttribute('data-wc-readonly'), false, 'no longer read-only');
  const key = new W.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true, composed: true });
  host.shadowRoot.getElementById('t').dispatchEvent(key);
  assert.equal(key.defaultPrevented, false, 'typing works again');
  assert.equal(pane('tucked').classList.contains('peek'), false, 'a phone peek does not outlive the phone');
});

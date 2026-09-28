// A block's history popover and the pane-spawned parent chip (UX upgrade p34c,
// unit c2) — public/app/pane-history.js and the block header in
// public/app/mounts.js, driven as real DOM against the real front-end module
// graph in jsdom (the harness of test/page-chrome.test.js; one boot per FILE,
// cases run in order over one shell).
//
// Pinned here:
//   - ◷ on every block header (folded behind ⋯ on a narrow one) opens ONE
//     popover under it, reading GET /api/mounts/:id/history; a second press
//     closes it; the dismiss layer and Escape close it and unload the preview;
//   - rows: label, CURRENT, author/time, the trigger — all as text; hovering
//     previews a version in /preview/pane/:node/:mount, a click keeps it;
//   - view-only by default: Make current is disabled on the current row, on a
//     locked block, on a block or version someone else writes — with the reason
//     said — and otherwise posts ONE restore for the kept version, closing on
//     success and showing the daemon's hint on a refusal;
//   - a read-only view (a preview) does not open it;
//   - a block another block spawned names its parent (↳ parent), says
//     "· closed" once that parent has gone (children stay — the daemon's rule),
//     and a click on the chip shows the parent.
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
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: T0 + 120000 },
];
const HISTORY = {
  fig: [
    { node_id: 'n3', label: 'n1.2', created_at: T0 + 120000, author: 'claude', owner: 'claude', trigger_summary: 'log scale <img src=x onerror="window.__pwned=1">', spec_hash: 'c', current: true },
    { node_id: 'n2', label: 'n1.1', created_at: T0 + 60000, author: 'user', owner: 'claude', trigger_summary: 'error bars', spec_hash: 'b' },
    { node_id: 'n1', label: 'n1.0', created_at: T0, author: 'claude', owner: 'service:plotter', trigger_summary: 'first plot', spec_hash: 'a' },
  ],
  thin: [
    { node_id: 'live', label: 'live', created_at: null, author: 'claude', owner: 'claude', trigger_summary: 'the live surface (not yet committed)', spec_hash: 'z', current: true },
    { node_id: 'n2', label: 'n1.1', created_at: T0 + 60000, author: 'claude', owner: 'claude', trigger_summary: 'thin one', spec_hash: 'y' },
  ],
};
const MOUNTS = [
  { id: 'fig', html: '<p>fig</p>', target: 'main', params: { title: 'Figure' }, pane_state: { colSpan: 8 }, owner: 'claude' },
  { id: 'thin', html: '<p>thin</p>', target: 'main', params: {}, pane_state: { colSpan: 4 }, owner: 'claude' },
  { id: 'kid', html: '<p>kid</p>', target: 'main', params: {}, pane_state: { colSpan: 6 }, owner: 'pane:fig' },
];

const calls = [];
let W = null, WS = null, restore = () => {};
let restoreAnswer = { ok: true, id: 'fig', owner: 'claude', restored_from: 'n2' };
let stateMod = null;

before(async () => {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
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
    const h = /^\/api\/mounts\/([^/]+)\/history$/.exec(u);
    if (h) return json({ ok: true, id: decodeURIComponent(h[1]), from: 'n3', versions: HISTORY[decodeURIComponent(h[1])] || [] });
    if (/^\/api\/mounts\/[^/]+\/restore$/.test(u)) return json(restoreAnswer);
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n3' });
    if (u.startsWith('/api/graph/node/')) return json({ ...NODES[0], author: 'claude', store: {}, mounts: [] });
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
    'HTMLElement', 'Node', 'Element', 'Event', 'EventTarget'];
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
  stateMod = await import(pathToFileURL(path.join(REPO, 'public/app/state.js')).href);
  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    global.setTimeout = savedSetTimeout;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
  await tick();
  frame({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n3', lock: null, project: 'test',
    mounts: MOUNTS.map((m) => ({ ...m, pane_state: { ...m.pane_state } })) });
  await tick(40);
});

after(async () => {
  await tick(400);
  restore();
});

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }
const $ = (id) => W.document.getElementById(id);
const frame = (msg) => WS.onmessage({ data: JSON.stringify(msg) });
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
const pane = (id) => [...W.document.querySelectorAll('#main .pane')].find((p) => p.dataset.paneId === id);
const histBtn = (id) => pane(id).querySelector('.pane-btn-history');
const panel = () => $('pane-history');
const isOpen = () => !panel().classList.contains('hidden');
const rows = () => [...$('ph-list').querySelectorAll('.ph-row')];
const rowFor = (node) => rows().find((r) => r.dataset.node === node);
const historyCalls = (id) => calls.filter((c) => c.url === `/api/mounts/${id}/history`);
const restores = () => calls.filter((c) => c.method === 'POST' && /\/restore$/.test(c.url));
async function openFor(id) {
  click(histBtn(id));
  await tick(20);
}

test('every block header carries ◷, wired to the one history popover; narrow blocks fold it behind ⋯', () => {
  for (const id of ['fig', 'thin', 'kid']) {
    const b = histBtn(id);
    assert.ok(b, `${id} has ◷`);
    assert.equal(b.getAttribute('aria-controls'), 'pane-history', 'the dismiss layer\'s trigger contract');
    assert.match(b.title, /history/);
  }
  assert.ok(pane('thin').classList.contains('narrow'));
  const css = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
  assert.match(css, /\.pane\.narrow:not\(\.more-open\) \.pane-btn-history/, 'folded behind ⋯ under span 6');
  assert.match(pane('thin').querySelector('.pane-btn-more').title, /history/);
  assert.ok(isOpen() === false, 'closed until asked');
});

test('◷ opens the popover under it and lists the versions, as text, newest first', async () => {
  await openFor('fig');
  assert.ok(isOpen());
  assert.equal(historyCalls('fig').length, 1);
  assert.equal($('ph-title').textContent, 'Figure');
  assert.equal($('ph-count').textContent, '3 versions');
  assert.deepEqual(rows().map((r) => r.querySelector('.ph-label').textContent), ['n1.2', 'n1.1', 'n1.0']);
  assert.ok(rowFor('n3').querySelector('.ph-badge'), 'the current version is marked');
  assert.equal(rowFor('n2').querySelector('.ph-badge'), null);
  assert.match(rowFor('n2').querySelector('.ph-when').textContent, /^user · /, 'a non-Claude author is named');
  assert.equal(rowFor('n3').querySelector('.ph-trig').textContent, 'log scale <img src=x onerror="window.__pwned=1">');
  assert.equal(panel().querySelector('img'), null, 'a trigger is text, never markup');
  assert.equal(histBtn('fig').getAttribute('aria-expanded'), 'true');
});

test('it opens on the current version, previewed read-only, with nothing to restore', () => {
  assert.equal(rowFor('n3').classList.contains('chosen'), true);
  assert.equal($('ph-frame').hidden, false);
  assert.equal($('ph-frame').getAttribute('src'), '/preview/pane/n3/fig?mode=light');
  assert.equal($('ph-restore').disabled, true, 'view-only: the current version cannot be made current');
  assert.equal($('ph-restore').textContent, 'n1.2 is current');
  assert.match($('ph-note').textContent, /on the page now/);
});

test('hovering previews a version without choosing it; leaving the list goes back to the kept one', () => {
  rowFor('n2').dispatchEvent(new W.MouseEvent('mouseenter'));
  assert.equal($('ph-frame').getAttribute('src'), '/preview/pane/n2/fig?mode=light');
  assert.equal(rowFor('n2').classList.contains('shown'), true);
  assert.equal(rowFor('n3').classList.contains('chosen'), true, 'hover does not move the choice');
  assert.equal($('ph-restore').disabled, true);
  $('ph-list').dispatchEvent(new W.MouseEvent('mouseleave'));
  assert.equal($('ph-frame').getAttribute('src'), '/preview/pane/n3/fig?mode=light');
});

test('a light/dark flip redraws the version on show in the new mode (s2-3)', async () => {
  const { toggleMode } = await import(pathToFileURL(path.join(REPO, 'public/app/theme.js')).href);
  toggleMode();
  try {
    assert.equal($('ph-frame').getAttribute('src'), '/preview/pane/n3/fig?mode=dark', 'redrawn dark, same version');
    assert.ok(isOpen(), 'the popover stays open');
  } finally {
    toggleMode();
  }
  assert.equal($('ph-frame').getAttribute('src'), '/preview/pane/n3/fig?mode=light');
});

test('Make current is refused before the click where the daemon would refuse — with the reason', () => {
  click(rowFor('n1'));
  assert.equal($('ph-restore').disabled, true, 'a version a driver wrote');
  assert.match($('ph-note').textContent, /'service:plotter' wrote this version/);
  click(rowFor('n2'));
  assert.equal($('ph-restore').disabled, false, 'an earlier version Claude wrote: restorable');
  assert.equal($('ph-restore').textContent, 'Make n1.1 current');
  assert.equal($('ph-note').textContent, '');
  // a lock set from anywhere disables it at once, and says why
  frame({ type: 'pane:state', id: 'fig', pane_state: { locked: true } });
  click(rowFor('n2'));
  assert.equal($('ph-restore').disabled, true);
  assert.match($('ph-note').textContent, /locked/);
  frame({ type: 'pane:state', id: 'fig', pane_state: { locked: false } });
  click(rowFor('n2'));
  assert.equal($('ph-restore').disabled, false);
  assert.equal(restores().length, 0, 'nothing was written by looking');
});

test('Make current posts one restore for the kept version, and a refusal shows the daemon\'s hint', async () => {
  restoreAnswer = { ok: false, rejected: true, owned: true, owner: 'service:x', hint: 'pane \'fig\' is owned by \'service:x\'' };
  click($('ph-restore'));
  await tick(10);
  assert.equal(restores().length, 1);
  assert.equal(restores()[0].url, '/api/mounts/fig/restore');
  assert.deepEqual(restores()[0].body, { node_id: 'n2' });
  assert.ok(isOpen(), 'a refusal keeps the panel');
  assert.match($('ph-note').textContent, /owned by 'service:x'/);
  assert.ok($('ph-note').classList.contains('bad'));

  restoreAnswer = { ok: true, id: 'fig', owner: 'claude', restored_from: 'n2' };
  click($('ph-restore'));
  await tick(10);
  assert.equal(restores().length, 2);
  assert.equal(isOpen(), false, 'the render frame that follows shows the result; the panel is done');
  assert.equal($('ph-frame').getAttribute('src'), null, 'and its preview is unloaded');
});

test('the live row is not restorable; ◷ again closes; the dismiss layer and Escape close and unload', async () => {
  await openFor('thin');
  assert.ok(isOpen());
  assert.equal(rowFor('live').classList.contains('chosen'), true);
  assert.equal($('ph-frame').hidden, true, 'the uncommitted live block has no preview document');
  assert.match($('ph-empty').textContent, /not yet committed/);
  assert.equal($('ph-restore').disabled, true);
  click(histBtn('thin'));
  await tick();
  assert.equal(isOpen(), false, 'a second press on the same block closes it');

  await openFor('fig');
  assert.ok(isOpen());
  await openFor('thin');
  assert.ok(isOpen(), 'another block\'s ◷ re-aims the open panel');
  assert.equal($('ph-count').textContent, '2 versions');
  await openFor('fig');
  assert.equal($('ph-frame').getAttribute('src'), '/preview/pane/n3/fig?mode=light', 'precondition: a version is loaded');
  W.document.body.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(isOpen(), false, 'an outside press closes it');
  assert.equal($('ph-frame').getAttribute('src'), null, 'and unloads the preview');

  await openFor('fig');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.equal(isOpen(), false, 'Escape closes it');
});

// chrome-5: a click into the version preview moves focus into that same-origin
// document, where a real Escape is then delivered — the window-blur rule keeps
// the panel open for that move, so the key has to be forwarded back.
test('Escape from inside the version preview IFRAME still closes the panel', async () => {
  await openFor('fig');
  assert.ok(isOpen(), 'precondition: open');
  const frame = $('ph-frame');
  frame.dispatchEvent(new W.FocusEvent('focus', { bubbles: false }));
  const inner = frame.contentDocument;
  assert.ok(inner, 'precondition: the preview frame is same-origin and readable');
  inner.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.equal(isOpen(), false, 'the key was forwarded to the one Escape owner');
});

// security-preview-frames-escape-csp: the version preview re-runs OLD pane code,
// so it is framed sandboxed (opaque origin — no reaching the chrome through
// parent/top). A real browser then gives us no contentDocument, and the preview
// document posts {wc:'escape'} instead; the forwarder takes that path only for a
// frame it cannot read, so a same-origin frame is never forwarded twice.
test('the version preview is sandboxed, and Escape still comes back by message', async () => {
  const frame = $('ph-frame');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts', 'scripts, but no allow-same-origin');
  await openFor('fig');
  assert.ok(isOpen(), 'precondition: open');
  const post = () => W.dispatchEvent(new W.MessageEvent('message', { data: { wc: 'escape' }, source: frame.contentWindow }));
  // readable (jsdom ignores sandbox): the direct binding owns it, the message is ignored
  post();
  await tick();
  assert.ok(isOpen(), 'a frame we can read is not forwarded a second time');
  // opaque, as in a browser
  Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => null });
  try {
    W.dispatchEvent(new W.MessageEvent('message', { data: { wc: 'escape' } }));
    await tick();
    assert.ok(isOpen(), 'a message from no framed preview is ignored');
    post();
    await tick();
    assert.equal(isOpen(), false, 'the posted Escape reached the one Escape owner');
  } finally { delete frame.contentDocument; }
});

test('a read-only view does not open it — neither the button nor the module', async () => {
  const history = await import(pathToFileURL(path.join(REPO, 'public/app/pane-history.js')).href);
  stateMod.view.previewing = true;
  try {
    const before = historyCalls('fig').length;
    click(histBtn('fig'));
    await tick(10);
    assert.equal(isOpen(), false);
    assert.equal(history.openPaneHistory('fig', histBtn('fig')), false, 'the module refuses too');
    assert.equal(isOpen(), false);
    assert.equal(historyCalls('fig').length, before);
  } finally { stateMod.view.previewing = false; }
});

test('a spawned block names its parent, says so when the parent has gone, and the chip shows the parent', async () => {
  const chip = pane('kid').querySelector('.pane-owner');
  assert.ok(chip, 'owner pane:fig → a parent chip');
  assert.equal(chip.textContent, '↳ fig');
  assert.match(chip.title, /Spawned by block 'fig'/);
  assert.equal(pane('fig').querySelector('.pane-owner'), null, 'Claude\'s own block has none');
  click(chip);
  assert.ok(pane('fig').classList.contains('pane-flash'), 'the parent is shown');

  frame({ type: 'clear', id: 'fig' });
  await tick();
  assert.equal(chip.textContent, '↳ fig · closed', 'the child stays, and says its parent is gone');
  assert.ok(chip.classList.contains('orphan'));
  assert.match(chip.title, /has been closed/);

  frame({ type: 'render', id: 'fig', html: '<p>fig again</p>', target: 'main', params: { title: 'Figure' }, pane_state: {}, owner: 'claude' });
  await tick();
  assert.equal(pane('kid').querySelector('.pane-owner').textContent, '↳ fig', 'the parent coming back re-attaches it');

  // A render frame carrying a new owner re-mounts the chrome (sameSpec reads owner).
  frame({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n3', lock: null, project: 'test',
    mounts: [
      { id: 'fig', html: '<p>fig again</p>', target: 'main', params: { title: 'Figure' }, pane_state: {}, owner: 'claude' },
      { id: 'kid', html: '<p>kid</p>', target: 'main', params: {}, pane_state: { colSpan: 6 }, owner: 'claude' },
    ] });
  await tick();
  assert.equal(pane('kid').querySelector('.pane-owner'), null, 'taken over by Claude: no parent chip');
});

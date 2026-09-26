// The block chrome (UX upgrade p2b), driven as real DOM against the real
// front-end module graph in jsdom — same harness style as
// test/leave-preview-chrome.test.js; one boot per test FILE, in a `before` hook,
// because the ESM cache hands a second import the same already-initialised
// modules. The cases are a SEQUENCE over one shell (the preview cases leave it
// previewing, then attach it) and are meant to run in file order.
//
// What is pinned here is behaviour, not pixels:
//   - the header: an uppercase type chip from params.type, else the component
//     name, else none; the chip, pin and lock fold away under span 6 behind ⋯;
//   - the block header's reduced/expanded ⊞/⊟ switch is gone — a capture pane
//     carries its own toggle (lib/capture/pane.js wrapModes), and the chrome
//     still persists the mode it asks for;
//   - resize from the right edge, the bottom edge, and the new corner (both);
//   - a LOCKED block refuses drags and resizes, including a lock set remotely;
//   - a detached preview is READ-ONLY (plan §2b D2): toggles do not toggle,
//     submits do not submit, the header's write controls refuse — and a pane
//     kept across leaving the preview is editable again.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');
const { wrapModes } = require('../lib/capture/pane');

const REPO = path.resolve(__dirname, '..');

// n1 (active) ── n2 (previewed)
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];

const FORM_HTML = '<form><input id="t" value="a"><input type="checkbox" id="c">'
  + '<button id="go">go</button></form><button type="button" id="plain">tab</button>'
  + '<script>root.querySelector("form").addEventListener("submit", function (e) {'
  + ' e.preventDefault(); window.__submits = (window.__submits || 0) + 1; });'
  + 'root.getElementById("plain").addEventListener("click", function () {'
  + ' window.__plainClicks = (window.__plainClicks || 0) + 1; });</script>';

const LIVE = [
  { id: 'wide', html: '<p>fig</p>', target: 'main', params: { type: 'figure' }, pane_state: { colSpan: 8 } },
  { id: 'comp', html: '<p>git</p>', target: 'main', params: {}, component: 'git-dashboard', pane_state: { colSpan: 12 } },
  { id: 'plain', html: '<p>plain</p>', target: 'main', params: {}, pane_state: { colSpan: 6 } },
  { id: 'thin', html: '<p>42</p>', target: 'main', params: { type: 'stat' }, pane_state: { colSpan: 4 } },
  { id: 'cap', html: wrapModes('<p data-wc-when="reduced">MINI</p><p data-wc-when="expanded">FULL</p>', 'reduced'),
    target: 'main', params: { title: 'Capture', modes: true, mode: 'reduced' }, pane_state: { colSpan: 12, mode: 'reduced' } },
  { id: 'locked', html: '<p>fixed</p>', target: 'main', params: {}, pane_state: { colSpan: 6, locked: true } },
];
const NODE_MOUNTS = {
  n2: [{ id: 'form', html: FORM_HTML, target: 'main', params: { type: 'form' }, pane_state: { colSpan: 12 } }],
};

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
      return json({ id, author: 'claude', mounts: (NODE_MOUNTS[id] || []).map((m) => ({ ...m })), store: {} });
    }
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.6.0', updateAvailable: false });
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
const chip = (id) => { const c = pane(id).querySelector('.pane-type'); return c ? c.textContent : null; };
const frame = (msg) => WS.onmessage({ data: JSON.stringify(msg) });
const noteText = () => { const n = $('reaim-note'); return n ? n.textContent : ''; };
const lastState = (id) => [...sent].reverse().find((f) => f.type === 'pane:state' && f.id === id);
// jsdom has no PointerEvent; the handlers read clientX/pageY/button only.
const pointer = (el, type, x, y) => {
  const e = new W.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pageY', { value: y });
  el.dispatchEvent(e);
  return e;
};

before(async () => {
  await boot();
  await tick();
  frame({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: LIVE.map((m) => ({ ...m })) });
  await tick();
  assert.equal(W.document.querySelectorAll('#main .pane').length, LIVE.length, 'precondition: every block mounted');
  // A laid-out 12-column #main (jsdom lays nothing out): 1244px wide → 83.5px
  // columns + 18px gaps, so one column of drag is ~101.5px.
  Object.defineProperty($('main'), 'clientWidth', { value: 1244, configurable: true });
  // …and no hit-testing either; the drag's drop indicator asks for it.
  W.document.elementFromPoint = () => null;
});

after(async () => {
  // Let the deferred theme-transition strip fire while the window is still
  // valid, so nothing runs against a torn-down document.
  await tick(400);
  restore();
});

test('the type chip names params.type, else the component, else nothing', () => {
  assert.equal(chip('wide'), 'figure');
  assert.equal(chip('comp'), 'git-dashboard', 'a spawned component falls back to its name');
  assert.equal(chip('plain'), null, 'no declared type and no component: no chip at all');
});

test('under span 6 the chip, pin and lock fold behind ⋯', () => {
  assert.equal(pane('thin').classList.contains('narrow'), true, 'a 4-column block is narrow');
  assert.equal(pane('wide').classList.contains('narrow'), false, 'an 8-column block is not');
  assert.equal(pane('plain').classList.contains('narrow'), false, 'exactly 6 columns keeps the full header');
  const more = pane('thin').querySelector('.pane-btn-more');
  assert.ok(more, 'the narrow header carries ⋯');
  more.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.equal(pane('thin').classList.contains('more-open'), true, '⋯ reveals pin and lock');
  more.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.equal(pane('thin').classList.contains('more-open'), false, 'and folds them again');
});

test('no block header carries the reduced/expanded ⊞/⊟ switch any more', () => {
  for (const p of W.document.querySelectorAll('#main .pane')) {
    const glyphs = [...p.querySelectorAll('.pane-header button')].map((b) => b.textContent);
    assert.ok(!glyphs.some((g) => /[⊞⊟]/.test(g)), `header of ${p.dataset.paneId} has no mode switch: ${glyphs.join(' ')}`);
  }
  assert.equal(W.document.querySelector('.pane-btn-mode'), null);
});

test('a capture pane toggles in-pane, and the chrome persists the mode it asks for', async () => {
  const root = pane('cap').querySelector('.mount-host').shadowRoot;
  const box = root.querySelector('.wc-pane-modes');
  const toggle = root.querySelector('.wc-mode-toggle');
  assert.ok(toggle, 'the capture pane renders its own toggle');
  assert.equal(box.getAttribute('data-mode'), 'reduced');
  sent.length = 0;
  toggle.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  assert.equal(box.getAttribute('data-mode'), 'expanded', 'the view flips at once');
  assert.match(toggle.textContent, /reduce/, 'and the control now offers the way back');
  await tick(120);
  const f = lastState('cap');
  assert.ok(f, 'the mode rode a pane:state frame');
  assert.equal(f.pane_state.mode, 'expanded', 'pane_state.mode is what persists and reaches other viewers');

  // Another viewer reduces it: the pane follows (wc:mode), and the button too.
  frame({ type: 'pane:state', id: 'cap', pane_state: { mode: 'reduced' } });
  assert.equal(box.getAttribute('data-mode'), 'reduced');
  assert.match(toggle.textContent, /expand/);
});

test('the corner resizes width AND height; the right edge only width', async () => {
  const p = pane('plain');
  sent.length = 0;
  const rb = p.querySelector('.pane-resize-rb');
  assert.ok(rb, 'the corner handle exists');
  pointer(rb, 'pointerdown', 500, 300);
  pointer(rb, 'pointermove', 703, 450);   // +2 columns, +150px
  pointer(rb, 'pointerup', 703, 450);
  await tick(120);
  const f = lastState('plain');
  assert.ok(f, 'the resize was published');
  assert.equal(f.pane_state.colSpan, 8, 'two columns wider');
  // (jsdom lays nothing out, so the drag starts from a 0px-tall rect.)
  assert.equal(f.pane_state.heightPx, 150, '150px taller');

  sent.length = 0;
  const r = p.querySelector('.pane-resize-r');
  pointer(r, 'pointerdown', 500, 300);
  pointer(r, 'pointermove', 297, 600);    // -2 columns; the vertical travel is ignored
  pointer(r, 'pointerup', 297, 600);
  await tick(120);
  const g = lastState('plain');
  assert.equal(g.pane_state.colSpan, 6);
  assert.equal(g.pane_state.heightPx, 150, 'the right edge never touches the height');
});

test('a locked block refuses drag and resize', async () => {
  const p = pane('locked');
  sent.length = 0;
  pointer(p.querySelector('.pane-header'), 'pointerdown', 100, 100);
  assert.equal(W.document.querySelector('.pane-ghost'), null, 'no drag ghost: the move never started');
  const rb = p.querySelector('.pane-resize-rb');
  pointer(rb, 'pointerdown', 500, 300);
  pointer(rb, 'pointermove', 703, 450);
  pointer(rb, 'pointerup', 703, 450);
  await tick(120);
  assert.equal(lastState('locked'), undefined, 'nothing moved, so nothing was published');
  assert.equal(p.style.gridColumn, 'span 6');

  // An unlocked block does start a drag from its header (not from its buttons).
  const w = pane('wide');
  pointer(w.querySelector('.pane-btn-min'), 'pointerdown', 100, 100);
  assert.equal(W.document.querySelector('.pane-ghost'), null, 'a press on a header button is not a drag');
  pointer(w.querySelector('.pane-title'), 'pointerdown', 100, 100);
  assert.ok(W.document.querySelector('.pane-ghost'), 'the title is part of the drag handle');
  pointer(w.querySelector('.pane-title'), 'pointerup', 100, 100);
  assert.equal(W.document.querySelector('.pane-ghost'), null);
});

test('a lock set in another viewer stops this one dragging, and lights the button', async () => {
  frame({ type: 'pane:state', id: 'wide', pane_state: { locked: true } });
  const w = pane('wide');
  assert.equal(w.querySelector('.pane-btn-lock').classList.contains('lock-active'), true, 'the lock button shows it');
  pointer(w.querySelector('.pane-title'), 'pointerdown', 100, 100);
  assert.equal(W.document.querySelector('.pane-ghost'), null,
    'the header closures read the merged state — a remote lock used to land on a copy they never saw');
  frame({ type: 'pane:state', id: 'wide', pane_state: { locked: false } });
});

test('a previewed pane is read-only: toggles, submits and header writes refuse', async () => {
  $('btn-down').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));   // preview n2
  await tick();
  assert.ok($('main').classList.contains('preview-readonly'), 'precondition: detached on n2');
  const p = pane('form');
  const host = p.querySelector('.mount-host');
  const root = host.shadowRoot;
  assert.ok(host.hasAttribute('data-wc-readonly'));
  sent.length = 0;
  const before = calls.length;

  const box = root.getElementById('c');
  box.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(box.checked, false, 'a checkbox does not toggle');

  root.getElementById('go').dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
  const form = root.querySelector('form');
  form.dispatchEvent(new W.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(W.__submits, undefined, "the pane's submit handler never saw it");

  root.getElementById('plain').dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(W.__plainClicks, 1, 'a plain button still works — viewing is not editing');

  const typed = new W.Event('beforeinput', { bubbles: true, cancelable: true, composed: true });
  root.getElementById('t').dispatchEvent(typed);
  assert.equal(typed.defaultPrevented, true, 'a paste / drop / IME edit is refused');
  assert.match(noteText(), /set this node active in the graph to edit/i);

  p.querySelector('.pane-btn-close').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  p.querySelector('.pane-btn-pin').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick(120);
  assert.ok(!calls.slice(before).some((c) => c.method === 'POST'),
    'closing a previewed pane used to clear the LIVE pane of the same id');
  assert.equal(p.classList.contains('pinned'), false, 'pin refuses in a preview');
  assert.deepEqual(sent.filter((f) => f.type !== 'event'), [], 'nothing reached the live surface');
});

test('a pane kept across leaving the preview is editable again', async () => {
  // A hello that lands active on the previewed node attaches (leavePreview) and
  // RECONCILES: the pane's spec is unchanged, so its DOM is kept, not re-mounted.
  const hostBefore = pane('form').querySelector('.mount-host');
  frame({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n2', lock: null, project: 'test',
    mounts: NODE_MOUNTS.n2.map((m) => ({ ...m })) });
  await tick();
  assert.equal($('main').classList.contains('preview-readonly'), false, 'attached');
  const host = pane('form').querySelector('.mount-host');
  assert.equal(host, hostBefore, 'precondition: the same DOM was kept');
  assert.equal(host.hasAttribute('data-wc-readonly'), false, 'the read-only mark was lifted');
  const box = host.shadowRoot.getElementById('c');
  box.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(box.checked, true, 'and a checkbox toggles again');
});

// The page backend (P3/P4) put `markdown`, `order` and `runs` on the snapshot
// frames and `api` beside `store`/`root` in a pane script. Rendering markdown is
// a later phase; what the restyled client owes today is that none of it breaks a
// frame, that blocks keep the page order the frame lists them in, and that the
// pane runtime still hands a script its `api`.
test('snapshot frames carrying markdown / order / runs mount in page order, and scripts get api', async () => {
  const PAGE = [
    { id: 'pg-b', html: '<p>b</p><script>api.spawn({ component: "note" });</script>',
      target: 'main', params: {}, pane_state: { colSpan: 6 } },
    { id: 'pg-a', html: '<p>a</p>', target: 'main', params: {}, pane_state: { colSpan: 6 } },
  ];
  const md = [{ id: 'pg-h', text: '# Heading\n\nprose', owner: 'claude', headings: [{ level: 1, text: 'Heading', slug: 'heading' }] }];
  const order = (ids) => [...W.document.querySelectorAll('#main .pane')].map((p) => p.dataset.paneId).filter((id) => ids.includes(id));
  frame({ type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n2', lock: null, project: 'test',
    mounts: PAGE.map((m) => ({ ...m })), markdown: md, order: ['pg-b', 'pg-h', 'pg-a'], runs: { 'pg-h': { stack: true } } });
  await tick();
  assert.deepEqual(order(['pg-a', 'pg-b']), ['pg-b', 'pg-a'], 'the hello\'s page order');
  const spawn = calls.find((c) => c.url === '/api/pane/spawn');
  assert.deepEqual(spawn && spawn.body, { component: 'note', parent: 'pg-b' },
    'a pane script is handed the live api — its spawn reaches the daemon as the parent');
  frame({ type: 'reset', store: {}, active: 'n2', mounts: [PAGE[1], PAGE[0]].map((m) => ({ ...m })),
    markdown: md, order: ['pg-a', 'pg-h', 'pg-b'], runs: {} });
  await tick();
  assert.deepEqual(order(['pg-a', 'pg-b']), ['pg-a', 'pg-b'], 'a reset re-orders to its page order');
});

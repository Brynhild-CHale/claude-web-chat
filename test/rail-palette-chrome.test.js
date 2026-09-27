// The queue rail, the ⌘K palette, the blocks drawer and the comment thread in
// the restyled chrome (UX upgrade p2c), driven as real DOM against the real
// front-end module graph in jsdom — same harness style as test/shell-chrome.test.js;
// ONE boot per test FILE (in before()), because the ESM cache hands a second
// import the same already-initialised modules; beforeEach puts the surface, the
// queue and every panel back, so each case runs on its own.
//
// What is pinned is behaviour the restyle added or moved, not pixels:
//   - a signal row can show its key's CURRENT value, read from the store only
//     when the user opens it — never copied into the item (the summary that
//     reaches Claude stays name-only);
//   - the rail's ESC chip closes it, and a click on the collapsed rail opens
//     it (touch has no hover);
//   - the "⚙ wakes" line names the declared signal keys, ⚡ for immediate;
//   - palette rows are typed — node / block / command — with a right-side hint
//     (a node's time, a block's type, a command's key), and a block row takes
//     you to that block;
//   - the drawer is headed BLOCKS and ＋'s tooltip no longer ends in a bare count;
//   - the comment thread heads with the anchor path, says "Shared with Claude"
//     and sends with Send.
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

const calls = [];
const routes = {
  queue: { items: [], count: 0 },
  store: { form_submit: { seq: 3, payload: { temp: 475, note: '<b>hot</b>' } } },
  policy: {
    channel_connected: true,
    immediate_signals: [{ key: 'ask_now' }],
    queue_signals: [{ key: 'form_submit' }, { key: '<img src=x>' }],
    activation_hint: {}, parked_delivery: 'held',
  },
  comments: [],
};
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
    if (u === '/api/graph') {
      return json({ nodes: [
        { id: 'n1', label: 'n1.0', parent_id: null, created_at: Date.UTC(2026, 8, 26, 13, 58), trigger_summary: 'sketch the plan' },
      ], active: 'n1' });
    }
    if (u === '/api/components') return json({ components: [{ name: 'demo', description: 'd', location: 'local' }] });
    if (u === '/api/packs') return json({ ok: true, packs: [], quarantined: [] });
    if (u === '/api/services/pending') return json({ ok: true, pending: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json(routes.queue);
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json(routes.policy);
    if (u.startsWith('/api/store?keys=')) {
      const out = {};
      for (const k of decodeURIComponent(u.slice('/api/store?keys='.length)).split(',')) if (k in routes.store) out[k] = routes.store[k];
      return json(out);
    }
    if (u === '/api/comments') return json({ comments: routes.comments });
    if (/^\/api\/comments\/[^/]+\/reply$/.test(u)) {
      const pin = { ...routes.comments[0], replies: [{ author: 'user', text: JSON.parse(opts.body).text }] };
      return json({ ok: true, pin });
    }
    if (u.startsWith('/api/theme')) return json({ name: 'earthy' });
    return json({ ok: true });
  };

  const saved = {};
  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  for (const k of keys) { try { saved[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  const savedSetInterval = global.setInterval;
  global.setInterval = () => 0; // no pollers keeping the process alive
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
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
const rail = () => $('queue-rail');
const frame = (msg) => WS.onmessage({ data: JSON.stringify(msg) });

const HELLO = {
  type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
  mounts: [
    { id: 'fig', html: '<p>chart</p>', target: 'main', params: { title: 'Anneal sweep', type: 'figure' }, pane_state: {} },
    { id: 'notes', html: '<ul><li>item 1</li><li>item 2</li></ul>', target: 'main', params: {}, component: 'checklist', pane_state: { minimized: true } },
  ],
};

before(async () => {
  await boot();
  await tick();
});

after(async () => {
  await tick();
  restore();
});

beforeEach(async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' })); // every panel shut, rail unpinned
  frame({ type: 'queue', op: 'clear' });
  routes.comments = [];
  frame({ type: 'comments', comments: [] });
  frame(JSON.parse(JSON.stringify(HELLO)));  // the two panes, `notes` minimized
  await tick();
  assert.equal($('main').querySelectorAll('.pane').length, 2, 'precondition: two panes mounted');
  calls.length = 0;
});

/* ------------------------------- the rail ------------------------------- */

test('a signal row shows its key\'s value only when opened, read from the store', async () => {
  frame({ type: 'queue', op: 'add', item: {
    id: 'q1', kind: 'signal', source: 'fig', why_wake: 'declared signal', summary: 'form_submit written',
    signal_key: 'form_submit', staged: true, enqueued_at: 1,
  } });
  frame({ type: 'queue', op: 'add', item: {
    id: 'q2', kind: 'activity', source: 'notes', summary: 'notes · 1 click', staged: true, enqueued_at: 2,
  } });
  await tick();
  const row = rail().querySelector('.rail-item[data-id="q1"]');
  const peek = row.querySelector('.qi-peek');
  assert.ok(peek, 'a signal row offers its value');
  assert.equal(peek.getAttribute('aria-expanded'), 'false');
  assert.equal(rail().querySelector('.rail-item[data-id="q2"] .qi-peek'), null,
    'an activity row has no single key to show');
  assert.ok(!calls.some((c) => c.url.startsWith('/api/store')), 'nothing is read before the user asks');
  assert.doesNotMatch(row.textContent, /475/, 'and the value is not on the row');

  click(peek);
  await tick();
  assert.ok(calls.some((c) => c.url === '/api/store?keys=form_submit'), 'opening reads the key from the store');
  const box = rail().querySelector('.rail-item[data-id="q1"] .qi-value');
  assert.ok(box, 'the value is shown under the row');
  assert.match(box.textContent, /"temp": 475/);
  assert.equal(box.querySelector('b'), null, 'a stored string is shown as text, never parsed as markup');
  assert.match(box.textContent, /<b>hot<\/b>/);
  assert.equal(rail().querySelector('.rail-item[data-id="q1"] .qi-peek').getAttribute('aria-expanded'), 'true');

  // it survives a re-render of the rail (another item arriving)
  frame({ type: 'queue', op: 'add', item: { id: 'q3', kind: 'capture', summary: 'a page', staged: true, enqueued_at: 3 } });
  await tick();
  assert.ok(rail().querySelector('.rail-item[data-id="q1"] .qi-value'), 'an open value stays open across re-renders');

  click(rail().querySelector('.rail-item[data-id="q1"] .qi-peek'));
  await tick();
  assert.equal(rail().querySelector('.rail-item[data-id="q1"] .qi-value'), null, 'a second click closes it');
});

test('a key no longer in the store says so, rather than showing nothing', async () => {
  frame({ type: 'queue', op: 'add', item: {
    id: 'q4', kind: 'signal', summary: 'gone_key written', signal_key: 'gone_key', staged: true, enqueued_at: 4,
  } });
  await tick();
  click(rail().querySelector('.rail-item[data-id="q4"] .qi-peek'));
  await tick();
  const box = rail().querySelector('.rail-item[data-id="q4"] .qi-value');
  assert.ok(box && box.classList.contains('absent'));
  assert.match(box.textContent, /not set/);
});

test('the ESC chip closes the rail, and a click on the collapsed rail opens it', async () => {
  assert.ok(!rail().classList.contains('open'), 'precondition: collapsed');
  click(rail().querySelector('.rail-collapsed'));
  assert.ok(rail().classList.contains('open'), 'a click (a tap, on touch) opens and pins the rail');
  // pinned: the pointer leaving does not close it
  rail().dispatchEvent(new W.MouseEvent('pointerleave'));
  assert.ok(rail().classList.contains('open'), 'and it stays open when the pointer leaves');
  const esc = rail().querySelector('.rail-head .rail-close');
  assert.equal(esc.tagName, 'BUTTON', 'the ESC chip is a real control');
  click(esc);
  assert.ok(!rail().classList.contains('open'), 'which closes the rail');
});

test('the wakes line names the declared keys — ⚡ for immediate — as text', async () => {
  const slot = rail().querySelector('.wake-slot');
  const keysEl = slot.querySelector('.wake-keys');
  assert.ok(keysEl, 'the declared keys have their own slot in the line');
  assert.equal(keysEl.textContent, ' · ⚡ask_now · form_submit · <img src=x>');
  assert.equal(slot.querySelector('img'), null, 'a key is agent-supplied text, never markup');
  assert.match(slot.textContent, /^⚙wakes: Push/);
  assert.equal(slot.querySelector('.wake-dot').textContent, '● channel', 'the channel state is still on the line');
});

/* ------------------------------ the palette ------------------------------ */

const openPalette = async () => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  await tick();
};
const rows = () => [...$('cmd-list').querySelectorAll('.palette-item')];
const typeInto = async (text) => {
  $('cmd-input').value = text;
  $('cmd-input').dispatchEvent(new W.Event('input', { bubbles: true }));
  await tick();
};

test('palette rows are typed, with the hint on the right', async () => {
  await openPalette();
  const kinds = new Set(rows().map((r) => r.querySelector('.kind').textContent));
  assert.deepEqual([...kinds].sort(), ['block', 'command', 'node'], 'three kinds of row, named as the design names them');

  const graph = rows().find((r) => r.querySelector('.label').textContent === 'Open graph');
  const key = graph.querySelector('.hint');
  assert.equal(key.tagName, 'KBD', 'a command with a key shows it as a key');
  assert.equal(key.textContent, 'G');

  const node = rows().find((r) => r.dataset.kind === 'node');
  assert.equal(node.querySelector('.label').textContent, 'n1.0 · sketch the plan',
    'a node row says what the turn was, not only its label');
  assert.match(node.querySelector('.hint').textContent, /\d{1,2}:\d{2}/, 'and when');

  const blocks = rows().filter((r) => r.dataset.kind === 'block');
  assert.deepEqual(blocks.map((r) => r.querySelector('.label').textContent), ['fig · Anneal sweep', 'notes']);
  assert.deepEqual(blocks.map((r) => r.querySelector('.hint').textContent), ['figure', 'checklist'],
    'a block row\'s hint is its type — params.type, else the component');

  const add = rows().find((r) => r.querySelector('.label').textContent === 'Add block · demo');
  assert.ok(add && add.dataset.kind === 'command', 'a library component is a command that adds it');
});

test('typing a kind filters to it', async () => {
  await openPalette();
  await typeInto('block');
  assert.ok(rows().length >= 2);
  assert.ok(rows().every((r) => r.dataset.kind === 'block' || /block/i.test(r.textContent)),
    'the kind is searchable');
  await typeInto('figure');
  assert.deepEqual(rows().map((r) => r.querySelector('.label').textContent), ['fig · Anneal sweep'],
    'and so is a block\'s type');
});

test('choosing a block row takes you to that block, restoring it if minimized', async () => {
  await openPalette();
  await typeInto('notes');
  const row = rows().find((r) => r.dataset.kind === 'block');
  const pane = [...$('main').querySelectorAll('.pane')].find((p) => p.dataset.paneId === 'notes');
  assert.ok(pane.classList.contains('minimized') || $('main').querySelector('.min-chip'),
    'precondition: the block is minimized');
  let scrolled = false;
  pane.scrollIntoView = () => { scrolled = true; };
  row.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true }));
  await tick();
  assert.ok($('cmd-palette').classList.contains('hidden'), 'the palette closed');
  assert.equal($('main').querySelector('.min-chip'), null, 'the block was restored from its chip');
  assert.ok(scrolled, 'brought into view');
  assert.ok(pane.classList.contains('pane-flash'), 'and flashed so the eye lands on it');
});

test('⌘K "Set up remote access…" (local) opens the setup page in a new tab, with no opener', async () => {
  const opened = [];
  W.open = (...a) => { opened.push(a); return null; };
  await openPalette();
  await typeInto('remote');
  const row = rows().find((r) => r.querySelector('.label').textContent === 'Set up remote access…');
  assert.ok(row && row.dataset.kind === 'command', 'a command row, offered on a local page');
  assert.equal(row.querySelector('.hint'), null, 'it has no key');
  row.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true }));
  await tick();
  assert.deepEqual(opened, [['/tunnel/setup', '_blank', 'noopener']],
    'the daemon\'s launcher, which redirects to the page on its own origin — never a pane');
  assert.ok($('cmd-palette').classList.contains('hidden'));
});

test('⋯ → Set up remote access shows on a local page and opens the same tab', async () => {
  const opened = [];
  W.open = (...a) => { opened.push(a); return null; };
  const item = $('menu-remote-setup');
  assert.equal(item.hidden, false, 'unhidden once /api/health said local');
  click(item);
  await tick();
  assert.deepEqual(opened, [['/tunnel/setup', '_blank', 'noopener']]);
});

/* ------------------------------- the drawer ------------------------------- */

test('the drawer is headed BLOCKS, and ＋ names what its count counts', async () => {
  assert.equal($('drawer-title').textContent, 'BLOCKS');
  click($('btn-add'));
  await tick();
  const title = $('btn-add').title;
  assert.match(title, /^Blocks — /);
  assert.match(title, /1 in the library$/, 'the number is spelled out, not a bare "· 1" beside the N key');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
});

/* --------------------------- the comment thread --------------------------- */

test('a comment thread heads with the anchor path and sends with Send', async () => {
  routes.comments = [{
    id: 'c1', text: 'repeat 450 first?', shared: true, replies: [{ author: 'claude', text: 'added it' }],
    anchor: { mount: 'notes', selector: 'li', text: 'item 2', ordinal: 1 },
  }];
  frame({ type: 'comments', comments: routes.comments });
  await tick();
  const marker = $('pin-layer').querySelector('.pin-marker');
  assert.ok(marker, 'precondition: the pin has a marker');
  marker.dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
  await tick();
  const pop = W.document.querySelector('.pin-thread');
  assert.ok(pop, 'the thread opened');
  assert.equal(pop.querySelector('.pin-anchor').textContent, 'notes › item 2', 'block › element, as the design heads it');
  assert.deepEqual([...pop.querySelectorAll('.pin-msg')].map((m) => m.className), ['pin-msg user', 'pin-msg claude'],
    'you / claude bubbles');
  assert.match(pop.querySelector('.pin-share').textContent, /Shared with Claude/);
  assert.equal(pop.querySelector('.pin-reply-send').textContent, 'Send');
  assert.ok(pop.querySelector('.pin-del'), 'Delete is still there');

  pop.querySelector('.pin-reply-text').value = 'ok, go';
  click(pop.querySelector('.pin-reply-send'));
  await tick();
  const sent = calls.find((c) => c.url === '/api/comments/c1/reply');
  assert.ok(sent && sent.method === 'POST', 'Send posts the reply');
  assert.deepEqual(sent.body, { text: 'ok, go', author: 'user' });
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
});

test('an anchor with no text names its element instead', async () => {
  routes.comments = [{
    id: 'c2', text: 'x', shared: true, replies: [],
    anchor: { mount: 'fig', selector: 'p', text: '', ordinal: 0 },
  }];
  frame({ type: 'comments', comments: routes.comments });
  await tick();
  $('pin-layer').querySelector('.pin-marker').dispatchEvent(new W.MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
  await tick();
  assert.equal(W.document.querySelector('.pin-thread .pin-anchor').textContent, 'fig › p');
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
});

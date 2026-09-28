// applySnapshot() — the ONE applier of a full-surface snapshot frame, driven as
// real DOM against the real front-end module graph in jsdom (same harness style
// as test/leave-preview-chrome.test.js; one boot per test FILE).
//
// `hello` and `reset` carry the identical payload and were written as two
// separate appliers. Only `reset` grew the preview fork ws.js's own header states
// as an invariant, so a reconnect while detached on an older node — a laptop
// waking, a `claude-web-chat restart`, a self-update — re-mounted the live
// surface straight over the previewed one. And `hello` was purely additive: it
// re-mounted every mount the server sent, removed none, and blew away whatever
// the user had typed in the meantime.
//
// The two behaviours pinned here are exactly those:
//   1. a hello delivered while previewing must not touch the DOM — it folds into
//      view.liveSnapshot, the same place every other frame folds
//   2. a hello after a gap must RECONCILE: a pane the server cleared is gone, a
//      pane whose spec is unchanged keeps its live DOM (so the typed value
//      survives) and that value is re-sent, because the socket was down when the
//      user typed it
//   3. the CLIENT half of that catch-up: frames the chrome tried to send during
//      the gap were dropped on the closed socket and never mentioned again, so a
//      store write or a pane resize made while disconnected was destroyed at both
//      ends. They queue in ws.js's outbox and drain once the snapshot has landed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

// n1 (active, the live surface) ── n2 (an older-node preview target) ── n3
// (a node that carries a pane under the SAME id as the live surface's `m-shared`,
// as stable mount ids usually make it, with the node's own committed value)
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
  { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: 3 },
];
const SHARED = { id: 'm-shared', html: '<input id="f">', target: 'main', params: {}, pane_state: {} };
const NODE_MOUNTS = {
  n1: [
    { id: 'm-keep', html: '<input id="f"><script>store.subscribe("k", (v) => { window.__k = v; });</script>', target: 'main', params: {}, pane_state: {} },
    { id: 'm-gone', html: '<p>doomed</p>', target: 'main', params: {}, pane_state: {} },
  ],
  n2: [{ id: 'm-old', html: '<p>older node</p>', target: 'main', params: {}, pane_state: {} }],
  n3: [{ ...SHARED, form_state: { '#f:0': { value: 'committed' } } }],
};
const liveMounts = (ids = ['m-keep', 'm-gone']) =>
  NODE_MOUNTS.n1.filter((m) => ids.includes(m.id)).map((m) => ({ ...m }));

let W = null, WS = null, view = null, sent = [], restore = () => {};

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
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n1' });
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      return json({ ...(NODES.find((x) => x.id === id) || NODES[0]), author: 'claude', mounts: (NODE_MOUNTS[id] || []).map((m) => ({ ...m })), store: {} });
    }
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.7.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
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
  // Same module instance the shell is running on — the fold is view state, so
  // this is the only way to see it from outside the DOM.
  ({ view } = await import(pathToFileURL(path.join(REPO, 'public/app/state.js')).href));

  restore = () => {
    for (const k of keys) { try { global[k] = saved[k]; } catch {} }
    global.setInterval = savedSetInterval;
    global.setTimeout = savedSetTimeout;
    window.close();
  };
  W = window;
  WS = wsInstances[0];
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const previewing = () => $('main').classList.contains('preview-readonly');
const paneIds = () => [...W.document.querySelectorAll('#main .mount-host')].map((h) => h.dataset.mountId || h.id);
const hostFor = (id) => [...W.document.querySelectorAll('#main .mount-host')].find((h) => (h.dataset.mountId || h.id) === id);
const field = (id) => hostFor(id).shadowRoot.getElementById('f');
const hello = (frame) => WS.onmessage({ data: JSON.stringify({
  type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1', lock: null, project: 'test',
  mounts: liveMounts(), ...frame,
}) });

test('boot the shell live on n1, two panes up', async () => {
  await boot();
  await tick();
  hello({ store: { k: 'one' } });
  await tick();
  assert.deepEqual(paneIds(), ['m-keep', 'm-gone'], 'precondition: the live surface is up');
  assert.equal(previewing(), false, 'precondition: attached');
  // A live write, so the kept pane's subscriber has actually seen a value: the
  // snapshot's own store lands before the panes mount, which is fine for a pane
  // that reads the store on the way up but says nothing about publication.
  WS.onmessage({ data: JSON.stringify({ type: 'store:patch', patch: { k: 'one' } }) });
  await tick();
  assert.equal(W.__k, 'one', 'precondition: the pane script is subscribed and receiving');
});

// The boot hello mounted two panes nobody has typed in: `m-keep` (an untouched
// input) and `m-gone` (no fields at all). Its reconcile flush used to take their
// rendered defaults for user input and publish them — `{"#f:0":{value:""}}` and
// `{}` — so every reload made an unchanged surface read as changed server-side
// (a spurious preserve node on Set active; test/form-state.test.js).
test('the boot hello publishes no form_state for panes nobody typed in', async () => {
  assert.deepEqual(sent.filter((f) => f.type === 'pane:form'), [],
    'a page opening is not user input: the flush must send nothing for untouched panes');
  sent.length = 0;
  hello({ store: { k: 'one' } }); // a reconnect over the same surface
  await tick();
  assert.deepEqual(sent.filter((f) => f.type === 'pane:form'), [], 'nor does a reconnect');
});

// The mount baseline above is taken synchronously after the pane's scripts run.
// A value the pane's OWN script assigns later — from a store subscription (the
// file-editor filling its buffer when the service pushes the file) or after an
// awaited fetch (node-render filling its select) — fires no input event, so it
// never moved that baseline, and the reconcile flush published it as if the
// user had typed it: the surface read as changed, Set active added an empty
// 'user' preserve node and a chat-only turn committed instead of folding.
const SCRIPT_FILLED = [
  { id: 'm-sub', target: 'main', params: {}, pane_state: {},
    html: '<textarea id="ta"></textarea><script>store.subscribe("doc", (d) => { if (d) root.getElementById("ta").value = d.content; });</script>' },
  { id: 'm-fetch', target: 'main', params: {}, pane_state: {},
    html: '<select id="s"></select><script>(async () => {'
      + ' const g = await (await fetch("/api/graph")).json();'
      + ' const sel = root.getElementById("s");'
      + ' for (const n of g.nodes) { const o = document.createElement("option"); o.value = n.id; o.textContent = n.label; sel.appendChild(o); }'
      + ' sel.value = "n2"; })();</script>' },
];
const withFilled = () => [...liveMounts(), ...SCRIPT_FILLED.map((m) => ({ ...m }))];
const shadowOf = (id) => hostFor(id).shadowRoot;
const formFrames = () => sent.filter((f) => f.type === 'pane:form');

test('a reconnect publishes nothing for fields a pane script filled after mount', async () => {
  hello({ store: { k: 'one' }, mounts: withFilled() });
  await tick();
  // The service pushes the file — a server write, delivered after mount.
  WS.onmessage({ data: JSON.stringify({ type: 'store:patch', patch: { doc: { content: 'version A' } } }) });
  await tick();
  assert.equal(shadowOf('m-sub').getElementById('ta').value, 'version A', 'precondition: the subscriber filled the textarea');
  assert.equal(shadowOf('m-fetch').getElementById('s').value, 'n2', 'precondition: the awaited fetch filled the select');
  assert.deepEqual(formFrames(), [], 'precondition: a script fill sends nothing on its own');

  sent.length = 0;
  hello({ store: { k: 'one', doc: { content: 'version A' } }, mounts: withFilled() }); // the laptop wakes
  await tick();
  assert.deepEqual(formFrames(), [],
    'nobody typed, so the reconnect flush must publish nothing — it used to send the script-filled '
    + 'textarea and select as pane:form, and the unchanged surface read as dirty server-side');
});

test('what the user typed in a script-filled pane still reaches the server on reconnect', async () => {
  // The socket drops and the user edits the buffer the script filled.
  WS.readyState = 3;
  const ta = shadowOf('m-sub').getElementById('ta');
  ta.value = 'version A, edited offline';
  ta.dispatchEvent(new W.Event('input', { bubbles: true, composed: true }));
  await new Promise((r) => setTimeout(r, 450)); // past the 350ms debounce, while down
  sent.length = 0;

  WS.readyState = 1;
  hello({ store: { k: 'one', doc: { content: 'version A' } }, mounts: withFilled() });
  await tick();
  const frames = formFrames();
  assert.deepEqual(frames.map((f) => f.id), ['m-sub'],
    'only the pane the user edited is flushed — the select the fetch filled is still not published');
  assert.equal(frames[0].form_state['#ta:0'].value, 'version A, edited offline',
    'and it carries what the user typed during the gap');

  // Sent, so the pane is clean again: a later script fill (the service pushing
  // a newer file) followed by another reconnect publishes nothing.
  WS.onmessage({ data: JSON.stringify({ type: 'store:patch', patch: { doc: { content: 'version B' } } }) });
  await tick();
  assert.equal(ta.value, 'version B', 'precondition: the subscriber replaced the buffer');
  sent.length = 0;
  hello({ store: { k: 'one', doc: { content: 'version B' } }, mounts: withFilled() });
  await tick();
  assert.deepEqual(formFrames(), [], 'the flag cleared once the frame went out');

  // Back to the two-pane surface the rest of this file works on.
  hello({ store: { k: 'one' } });
  await tick();
  assert.deepEqual(paneIds(), ['m-keep', 'm-gone']);
});

/* ── 1. a hello delivered while previewing must not touch the previewed DOM ── */

test('a reconnect during a node preview folds instead of overwriting the surface', async () => {
  $('btn-down').dispatchEvent(new W.MouseEvent('click', { bubbles: true })); // n1 → n2
  await tick();
  assert.deepEqual(paneIds(), ['m-old'], 'precondition: detached, showing the older node');
  assert.equal(previewing(), true);

  // What the server sends on EVERY (re)connection: after a laptop sleep, a
  // restart, or a self-update. It describes the LIVE surface, which is not what
  // this client is looking at.
  hello({ store: { k: 'two' }, mounts: liveMounts(['m-keep']) });
  await tick();

  assert.deepEqual(paneIds(), ['m-old'],
    'the previewed node is still on screen — hello had no preview fork, so a reconnect '
    + 'used to re-mount the live panes over the node being previewed');
  assert.equal(previewing(), true, 'and the client is still detached');
  assert.deepEqual(view.liveSnapshot.mounts.map((m) => m.id), ['m-keep'],
    'the live surface folded into liveSnapshot instead, where every other frame folds');
  assert.deepEqual(view.liveSnapshot.store, { k: 'two' }, 'store included — the fold is the whole snapshot');
  assert.equal(W.__k, 'one', 'and nothing was published into the previewed panes');
});

test('returning to active renders the surface the fold captured', async () => {
  $('btn-return-active').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(previewing(), false, 'attached again');
  assert.deepEqual(paneIds(), ['m-keep'],
    'the live surface is what the hello folded aside — m-gone was cleared server-side during the preview');
});

/* ── 2. reconcile: absentees go, typed values survive and are re-sent ── */

test('a hello after a gap removes cleared panes and keeps what the user typed', async () => {
  // Back to both panes, with a value the server already knows about.
  hello({ store: { k: 'one' } });
  await tick();
  assert.deepEqual(paneIds(), ['m-keep', 'm-gone'], 'precondition: two panes');
  const keptHost = hostFor('m-keep');

  // The socket drops. Everything the user does now is gated out on the way to
  // the server (store.js / mounts.js both gate on isOpen).
  WS.readyState = 3;
  const input = field('m-keep');
  input.value = 'typed during the gap';
  input.dispatchEvent(new W.Event('input', { bubbles: true, composed: true }));
  // Let the 350ms form-state debounce fire WHILE the socket is down: that is the
  // path that used to mark the value as already-sent and lose it for good.
  await new Promise((r) => setTimeout(r, 450));
  sent.length = 0;

  // Reconnect. The server cleared m-gone during the gap and its form_state for
  // m-keep is the stale one from before the user typed.
  WS.readyState = 1;
  hello({
    store: { k: 'three' },
    mounts: [{ ...NODE_MOUNTS.n1[0], form_state: { '#f:0': { value: '' } } }],
  });
  await tick();

  assert.deepEqual(paneIds(), ['m-keep'],
    'the pane the server cleared during the gap is gone — hello was purely additive, so it survived '
    + 'locally until the next full reset');
  assert.equal(hostFor('m-keep'), keptHost,
    'the surviving pane was NOT re-mounted: its spec is unchanged, so its live DOM is kept');
  assert.equal(field('m-keep').value, 'typed during the gap',
    'and the value typed during the gap survived — the blind re-mount used to destroy it');
  assert.equal(W.__k, 'three',
    'the store diff was published to the kept pane: a reconcile does not re-mount, so the silent '
    + 'replace() would otherwise leave a live subscriber on stale values');
  assert.ok(sent.some((f) => f.type === 'pane:form' && f.id === 'm-keep' && f.form_state['#f:0'].value === 'typed during the gap'),
    'and it was re-sent to the server, which never received it while the socket was down');
});

/* ── 3. the outbound half: nothing the user did during the gap is dropped ── */

test('frames the chrome sent while the socket was down survive the reconnect', async () => {
  const { store } = await import(pathToFileURL(path.join(REPO, 'public/app/store.js')).href);
  const { unminimize } = await import(pathToFileURL(path.join(REPO, 'public/app/mounts.js')).href);
  hello({ store: { k: 'server-value' } });
  await tick();
  WS.onmessage({ data: JSON.stringify({ type: 'pane:state', id: 'm-keep', pane_state: { minimized: true } }) });
  await tick();

  // The socket drops. Everything below used to be gated out on `isOpen()` and
  // silently discarded — store.js's patch, mounts.js's pane:state — with no
  // record kept anywhere and no second chance to send it.
  WS.readyState = 3;
  sent.length = 0;
  store.set({ k: 'first' });
  store.set({ k: 'second', other: 1 });      // coalesces: one frame, patches merged
  unminimize('m-keep');                      // what clicking the minimized chip does
  await new Promise((r) => setTimeout(r, 120));   // past emitPaneState's 80ms debounce
  assert.equal(sent.length, 0, 'precondition: nothing reaches a closed socket');

  // Reconnect. The server's snapshot is what it believed BEFORE the gap — the
  // old value of k, and a pane it still thinks is minimized.
  WS.readyState = 1;
  hello({ store: { k: 'server-value' }, mounts: [{ ...NODE_MOUNTS.n1[0], pane_state: { minimized: true } }] });
  await tick();

  const paneFrames = sent.filter((f) => f.type === 'pane:state' && f.id === 'm-keep');
  assert.equal(paneFrames.length, 1, 'the restore the user did during the gap reaches the server');
  assert.equal(paneFrames[0].pane_state.minimized, false);

  const patches = sent.filter((f) => f.type === 'store:set');
  assert.equal(patches.length, 1, 'the gap collapses into ONE store frame, however long it lasted');
  assert.deepEqual(patches[0].patch, { k: 'second', other: 1 },
    'with the last write per key — the whole gap, not just its final call');
  assert.equal(store.get('k'), 'second',
    'and the LOCAL copy is the one we just re-sent: the reconcile had replaced it with the '
    + "server's pre-gap value, which would have left the two ends disagreeing");
});

/* ── 4. a hello that re-attaches renders the live surface, not the previewed node ── */

const app = (f) => import(pathToFileURL(path.join(REPO, 'public/app', f)).href);
const typedLive = () => ({ ...SHARED, form_state: { '#f:0': { value: 'LIVE-typed' } } });

// A re-aim that lands while the socket is down can put active exactly on the
// node this client is previewing; the reconnect's hello then attaches. The DOM
// on screen at that moment is the COMMITTED node's — and with stable mount ids
// its pane answers to the live pane's id. Reconciling kept every pane whose spec
// matched, with the node's form values (form_state is never applied over a kept
// pane), so the live value was not on screen and the next keystroke published
// the node's old one over it.
test('a hello that makes the previewed node active shows the live form values', async () => {
  const { previewNode } = await app('topbar.js');
  hello({ store: {}, mounts: [typedLive()] });
  await tick();
  assert.equal(field('m-shared').value, 'LIVE-typed', 'precondition: the live value is on screen');
  await previewNode('n3');
  await tick();
  assert.equal(previewing(), true, 'precondition: detached on n3');
  assert.equal(field('m-shared').value, 'committed', "precondition: the node's pane, under the live pane's id");

  hello({ active: 'n3', store: {}, mounts: [typedLive()] });
  await tick();
  assert.equal(previewing(), false, 'attached: active is the node on screen');
  assert.equal(field('m-shared').value, 'LIVE-typed',
    "the live form value is on screen — a reconcile kept the previewed pane and its 'committed'");
  assert.equal(hostFor('m-shared').hasAttribute('data-wc-readonly'), false, 'and the pane is editable');
});

/* ── 5. a pane theme is a live change: it never repaints the previewed node ── */

// While previewing, `panes` holds the previewed node's panes, and the one that
// shares the live pane's id answered a live pane theme: the committed node on
// screen was repainted, and the live pane got it only by the fold's luck.
test('a pane theme that lands during a preview themes the live pane, not the previewed one', async () => {
  const { previewNode } = await app('topbar.js');
  const { panes } = await app('mounts.js');
  hello({ store: {}, mounts: [typedLive()] });   // attached on n1
  await tick();
  await previewNode('n3');
  await tick();
  assert.equal(previewing(), true, 'precondition: detached on n3, whose pane shares the id');

  WS.onmessage({ data: JSON.stringify({ type: 'theme', scope: 'pane', target: 'm-shared', theme: { tokens: { '--wc-accent': '#ff0000' } } }) });
  await tick();
  assert.equal(panes.get('m-shared').wrapper.style.getPropertyValue('--wc-accent'), '',
    'the committed node on screen is not repainted');
  assert.deepEqual(view.liveSnapshot.mounts.find((m) => m.id === 'm-shared').theme, { tokens: { '--wc-accent': '#ff0000' } },
    'the theme folded into the captured live surface, like every other live frame');

  $('btn-return-active').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(previewing(), false, 'attached again');
  assert.equal(panes.get('m-shared').wrapper.style.getPropertyValue('--wc-accent'), '#ff0000',
    'and the live pane wears it after ↩ active');
});

test('the outbox does not grow without bound while the socket stays down', async () => {
  const { store } = await import(pathToFileURL(path.join(REPO, 'public/app/store.js')).href);
  WS.readyState = 3;
  sent.length = 0;
  for (let i = 0; i < 500; i++) store.set({ ['k' + (i % 3)]: i });
  WS.readyState = 1;
  hello({ store: {} });
  await tick();
  const patches = sent.filter((f) => f.type === 'store:set');
  assert.equal(patches.length, 1, '500 writes across a long gap are still one coalesced frame');
  assert.deepEqual(Object.keys(patches[0].patch).sort(), ['k0', 'k1', 'k2']);

  await new Promise((r) => setTimeout(r, 400));
  restore();
});

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
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

// n1 (active, the live surface) ── n2 (an older-node preview target)
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];
const NODE_MOUNTS = {
  n1: [
    { id: 'm-keep', html: '<input id="f"><script>store.subscribe("k", (v) => { window.__k = v; });</script>', target: 'main', params: {}, pane_state: {} },
    { id: 'm-gone', html: '<p>doomed</p>', target: 'main', params: {}, pane_state: {} },
  ],
  n2: [{ id: 'm-old', html: '<p>older node</p>', target: 'main', params: {}, pane_state: {} }],
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

  await new Promise((r) => setTimeout(r, 400));
  restore();
});

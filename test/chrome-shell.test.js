// The chrome under test (test-support/chrome-shell.js `bootShell`), and the
// registration seams it exists to exercise: public/app/ws.js's onFrame, onHello,
// setClientField and `conn` events, through the real index.html and module graph.
//
// Two contracts are pinned, because later chrome units build on both without
// editing either file:
//   * bootShell boots once per file, answers fetches from its routes and records
//     them, drives the socket from the test's side, and puts back every global
//     it replaced — clearing the chrome's pending timers, so nothing it left
//     scheduled fires against Node's own globals after the file's last test;
//   * ws.js lets a module take frames (an exact type, or a family by prefix),
//     work at the end of every hello, and fields on the `client` frame, with no
//     edit to ws.js: handlers run after the built-in one and in order, a module
//     that throws costs nobody else a frame, and the chat views' posture reaches
//     the socket as its `mirror` field, only when it moves.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

// What a dozen globals look like BEFORE the boot, to prove restore() puts each
// back exactly: an own property descriptor, or the lack of one.
const WATCHED = ['window', 'document', 'location', 'navigator', 'localStorage', 'fetch', 'WebSocket', 'Event',
  'HTMLElement', 'matchMedia', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame'];
const DESCRIPTOR_FIELDS = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
const globalsBefore = new Map(WATCHED.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));

let shell, ws, slots, bus, bootCalls, helloCalls;
const connLog = [];       // every chrome-bus `conn`, from a listener registered in init
const constructed = [];   // every socket the chrome made, as onSocket saw it

before(async () => {
  shell = await bootShell({
    routes: { '/api/probe': { answer: 42 } },
    onSocket: (s) => constructed.push(s),
    init: async (sh) => {
      ({ bus } = await sh.importApp('bus.js'));
      bus.on('conn', (d) => connLog.push(d.state));
    },
  });
  ws = await shell.importApp('ws.js');
  slots = await shell.importApp('chat-slots.js');
  bootCalls = shell.calls.map((c) => c.url);
  shell.calls.length = 0;
  await shell.frame(helloFrame());
  helloCalls = shell.calls.map((c) => c.url);
});

after(() => shell.restore());

beforeEach(() => {
  shell.setRoutes();
  shell.calls.length = 0;
});

// console.error, captured for one test: a failing handler is REPORTED, not silent.
function captureErrors(t) {
  const lines = [];
  const saved = console.error;
  console.error = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  t.after(() => { console.error = saved; });
  return lines;
}

const lastClient = () => shell.socket().frames('client').at(-1);

/* ── bootShell ──────────────────────────────────────────────────────────────── */

test('bootShell boots the real shell once per file, and every caller gets that one', async () => {
  assert.equal(await bootShell(), shell, 'a second call hands back the same shell');
  assert.throws(() => bootShell({ routes: {} }), /boots once/, 'options after the boot are refused, not ignored');
  assert.equal(constructed.length, 1, 'main.js ran once: one connect');
  assert.equal(shell.sockets[0], constructed[0]);
  for (const id of ['stage', 'topbar', 'main', 'queue-rail', 'bottombar', 'overlay']) assert.ok(shell.$(id), `the real index.html: #${id}`);
  assert.equal(shell.document.querySelectorAll('script').length, 0,
    'its script tags stripped: the module graph is imported once, not run a second time');
  // importApp hands back the chrome's OWN module instance: a handler registered
  // through it receives the frames the chrome's socket receives.
  const seen = [];
  const off = ws.onFrame('probe:ping', (m) => seen.push(m.n));
  await shell.frame({ type: 'probe:ping', n: 1 });
  off();
  assert.deepEqual(seen, [1]);
});

test('the first socket opens once init has run, so init\'s listeners see the connect', () => {
  assert.equal(connLog[0], 'live', 'a conn listener registered in init saw the socket go live');
  assert.equal(constructed[0].readyState, 1);
});

test('every request is answered from the routes, layered, and recorded', async () => {
  // The chrome's own reads, at boot and on the hello, went through the shim:
  // its bare `fetch` IS the indirection.
  assert.ok(bootCalls.length > 0 && helloCalls.length > 0, 'the boot and the hello were recorded');
  assert.ok([...bootCalls, ...helloCalls].every((u) => u.startsWith('/api/')), 'every one an /api read');
  assert.deepEqual(await (await fetch('/api/probe')).json(), { answer: 42 }, 'a boot route');
  const res = await fetch('/api/probe');
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(new TextDecoder().decode(await res.arrayBuffer()), '{"answer":42}', 'the body, as bytes too');
  const a = await (await fetch('/api/probe')).json();
  a.answer = 0;
  assert.equal((await (await fetch('/api/probe')).json()).answer, 42, 'an answer is a fresh copy: the chrome cannot edit a route');

  shell.setRoutes({
    '/api/probe': respond({ error: 'gone' }, { status: 404 }),
    '/api/items/*': (url) => ({ id: url.split('?')[0].split('/').pop() }),
    '/api/graph': { nodes: [], active: null },
  });
  const r = await fetch('/api/probe');
  assert.equal(r.status, 404);
  assert.equal(r.ok, false, 'respond() carries any status');
  assert.deepEqual(await (await fetch('/api/items/i7?full=1')).json(), { id: 'i7' }, 'a prefix route, answered by a function');
  assert.deepEqual(await (await fetch('/api/graph')).json(), { nodes: [], active: null }, 'an override beats a default');
  assert.deepEqual(await (await fetch('/api/nowhere')).json(), { ok: true }, 'an unrouted URL answers {ok:true}');
  await fetch('/api/thing', { method: 'POST', body: JSON.stringify({ k: 1 }), headers: { 'Content-Type': 'application/json' } });
  const post = shell.calls.find((c) => c.url === '/api/thing');
  assert.deepEqual([post.method, post.body], ['POST', { k: 1 }], 'a JSON body is recorded parsed');
  assert.deepEqual(shell.calls.map((c) => c.url).filter((u) => /^\/api\/(probe|items|graph|nowhere|thing)/.test(u)),
    ['/api/probe', '/api/probe', '/api/probe', '/api/probe', '/api/probe', '/api/items/i7?full=1', '/api/graph',
      '/api/nowhere', '/api/thing'],
    'every request, in order');

  shell.setRoutes();
  assert.deepEqual(await (await fetch('/api/probe')).json(), { answer: 42 }, 'setRoutes() alone puts the boot routes back');
});

test('jsdom\'s missing layout: scroll metrics, scroll calls and scrollIntoView', () => {
  const el = shell.$('main');
  const m = shell.scrollMetrics(el, { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600, rect: { top: 50, height: 400 } });
  assert.deepEqual([el.scrollHeight, el.clientHeight, el.scrollTop], [2000, 400, 1600]);
  m.scrollHeight = 2600;
  assert.equal(el.scrollHeight, 2600, 'the metrics are live: change the object, the element follows');
  assert.equal(el.getBoundingClientRect().bottom, 450);
  el.scrollTo({ top: 10 });
  el.scrollBy(0, 5);
  assert.equal(el.scrollTop, 15);
  shell.scrolls.length = 0;
  el.scrollIntoView({ block: 'end' });
  assert.equal(shell.scrolls.length, 1);
  assert.equal(shell.scrolls[0].el, el);
  assert.deepEqual(shell.scrolls[0].arg, { block: 'end' }, 'recorded, where jsdom would have thrown');
});

test('the viewport: media queries the chrome asks follow setViewport, and viewport.js sees the flip', async (t) => {
  const { isPhone } = await shell.importApp('viewport.js');
  const flips = [];
  t.after(bus.on('viewport', (d) => flips.push(d.phone)));
  t.after(() => shell.setViewport({ width: 1280, height: 800, dark: false, visualHeight: undefined }));
  assert.equal(isPhone(), false, 'the default viewport is a 1280×800 desktop');
  assert.equal(shell.window.innerWidth, 1280);

  shell.setViewport({ width: 390, height: 844 });
  assert.equal(isPhone(), true, 'narrow and portrait: the phone, through viewport.js\'s own matchMedia query');
  assert.ok(shell.document.documentElement.classList.contains('phone'));
  assert.equal(shell.window.innerWidth, 390);
  assert.equal(lastClient().device, 'mobile', 'and the socket heard it (ws.js re-sends its client frame)');
  shell.setViewport({ width: 1280, height: 800 });
  assert.equal(isPhone(), false);
  assert.deepEqual(flips, [true, false]);

  const dark = shell.window.matchMedia('(prefers-color-scheme: dark)');
  assert.equal(dark.matches, false);
  const seen = [];
  dark.addEventListener('change', (e) => seen.push(e.matches));
  shell.setViewport({ dark: true });
  assert.deepEqual([dark.matches, seen], [true, [true]]);
  assert.equal(shell.window.matchMedia('(min-width: 760px)').matches, true);
  assert.equal(shell.window.matchMedia('(max-width: 759px)').matches, false);

  let resized = 0;
  shell.window.visualViewport.addEventListener('resize', () => resized++);
  shell.setViewport({ visualHeight: 500 });
  assert.deepEqual([shell.window.visualViewport.height, resized], [500, 1], 'the visual viewport, for a keyboard');
  assert.throws(() => shell.setViewport({ widht: 1 }), /unknown key 'widht'/);
});

test('setInterval is recorded and never fires by itself; a test runs a ticker by hand', async () => {
  const live = shell.intervals();
  assert.ok(live.length > 0, 'the chrome\'s own pollers registered through the stub');
  let ran = 0;
  const id = setInterval(() => ran++, 1000);
  const mine = shell.intervals().find((i) => i.id === id);
  assert.equal(mine.ms, 1000);
  await shell.tick(40);
  assert.equal(ran, 0, 'a stubbed interval never fires on its own');
  mine.fn();
  assert.equal(ran, 1, 'its function, run by the test');
  clearInterval(id);
  assert.ok(!shell.intervals().some((i) => i.id === id), 'clearInterval removes it');
});

test('the scaffold in the real shell: .body-wrap holds .body, and each chat host sits where its surface must', async () => {
  const stage = shell.$('stage');
  const wrap = shell.document.querySelector('.body-wrap');
  assert.equal(wrap.parentElement, stage, 'the wrapper is a direct child of #stage');
  assert.equal(wrap.firstElementChild, shell.document.querySelector('.body'), 'and .body is its first child');

  const hosts = {};
  const walker = shell.document.createTreeWalker(shell.document.body, shell.window.NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const m = /^\s*(\/?)chat-host:(\w+)/.exec(n.data);
    if (m) (hosts[m[2]] = hosts[m[2]] || {})[m[1] ? 'end' : 'start'] = n;
  }
  assert.deepEqual(Object.keys(hosts).sort(), ['bar', 'dock', 'pull', 'tray'], 'one host per chat surface');
  for (const [name, h] of Object.entries(hosts)) {
    assert.ok(h.start && h.end && h.start.parentNode === h.end.parentNode, `${name}: a start and an end marker, together`);
  }
  // The dock beside .body, inside the wrapper; everything else a direct child of
  // #stage, which is what the modality layer walks (shell.js syncModality).
  assert.equal(hosts.dock.start.parentNode, wrap);
  for (const name of ['bar', 'pull', 'tray']) assert.equal(hosts[name].start.parentNode, stage, `${name} is a child of #stage`);
  const after = (a, b) => Boolean(a.compareDocumentPosition(b) & shell.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(after(shell.document.querySelector('.body'), hosts.dock.start), 'the dock: after .body');
  assert.ok(after(wrap, hosts.bar.start) && after(hosts.bar.end, shell.$('bottombar')), 'the bar: under the body, before the bottom bar');
  assert.ok(after(shell.$('bottombar'), hosts.pull.start) && after(hosts.pull.end, stage.querySelector('.glass-scanline')),
    'the pull: right after the bottom bar it rides');
  assert.ok(after(shell.$('replay-pop'), hosts.tray.start) && after(hosts.tray.end, shell.$('key-legend')),
    'the tray: among the popovers, before the legend');

  // Under a modal the wrapper goes inert, and .body with it.
  shell.key('k', { metaKey: true });
  await shell.tick();
  assert.ok(!shell.$('cmd-palette').classList.contains('hidden'), 'precondition: ⌘K opened the palette');
  assert.equal(shell.$('main').closest('[inert]'), wrap, 'the page behind the palette is inert through its wrapper');
  shell.key('Escape', { target: shell.$('cmd-input') });
  await shell.tick();
  assert.equal(shell.$('main').closest('[inert]'), null, 'and live again once it closes');
});

/* ── ws.js: the registration seams ────────────────────────────────────────── */

test('onFrame: exact types and prefixes run in registration order, after the built-in handler', async (t) => {
  const order = [];
  const offs = [
    ws.onFrame('mirror:', (m) => order.push(`family-a ${m.type}`)),
    ws.onFrame('mirror:status', (m) => order.push(`exact ${m.type}`)),
    ws.onFrame('mirror:', (m) => order.push(`family-b ${m.type}`)),
  ];
  t.after(() => offs.forEach((off) => off()));
  await shell.frame({ type: 'mirror:status' });
  await shell.frame({ type: 'mirror:update' });
  await shell.frame({ type: 'mirrors' });
  await shell.frame({ type: 'status' });
  assert.deepEqual(order, [
    'family-a mirror:status', 'exact mirror:status', 'family-b mirror:status',
    'family-a mirror:update', 'family-b mirror:update',
  ], 'a prefix names a family by its colon: mirrors and status are not in it');

  // After the built-in: by the time a hello handler runs, the snapshot is on screen.
  let panes = null;
  t.after(ws.onFrame('hello', () => { panes = shell.$('main').querySelectorAll('.pane').length; }));
  await shell.frame(helloFrame({ mounts: [{ id: 'seam-p', html: '<p>x</p>', target: 'main', params: {}, pane_state: {} }] }));
  assert.equal(panes, 1, 'the built-in hello had already mounted the snapshot');
  await shell.frame(helloFrame());

  // An unregistered handler hears nothing more.
  offs[1]();
  order.length = 0;
  await shell.frame({ type: 'mirror:status' });
  assert.deepEqual(order, ['family-a mirror:status', 'family-b mirror:status']);
  assert.throws(() => ws.onFrame('', () => {}), /onFrame: give a frame type/);
  assert.throws(() => ws.onFrame('mirror:', null), /handler must be a function/);
});

test('a handler that throws is reported, and costs no other handler its frame', async (t) => {
  const errors = captureErrors(t);
  const ran = [];
  const offs = [
    ws.onFrame('mirror:', () => { throw new Error('boom'); }),
    ws.onFrame('mirror:', (m) => ran.push(m.type)),
    ws.onHello(() => { throw new Error('hello boom'); }),
    ws.onHello(() => ran.push('hello hook')),
  ];
  t.after(() => offs.forEach((off) => off()));
  await shell.frame({ type: 'mirror:status' });
  await shell.frame({ type: 'mirror:reset' });
  await shell.frame(helloFrame());
  assert.deepEqual(ran, ['mirror:status', 'mirror:reset', 'hello hook'], 'the next handler ran every time');
  assert.equal(errors.filter((l) => /frame handler failed for mirror:/.test(l)).length, 2);
  assert.equal(errors.filter((l) => /hello hook failed for hello/.test(l)).length, 1);
  // and the core stream is untouched: a render after all that still mounts
  await shell.frame({ type: 'render', id: 'after-boom', html: '<p>ok</p>', target: 'main', params: {} });
  assert.ok(shell.$('main').querySelector('.pane[data-pane-id="after-boom"]'), 'a core frame still lands');
  await shell.frame(helloFrame());
});

test('onHello runs at the end of every hello: after the snapshot, the outbox drain and hydrateQueue()', async (t) => {
  const seen = [];
  const clientBefore = shell.socket().frames('client').length;
  const off = ws.onHello((msg) => seen.push({
    project: msg.project,
    panes: shell.$('main').querySelectorAll('.pane').length,
    clientSent: shell.socket().frames('client').length - clientBefore,
    queue: shell.calls.some((c) => c.url === '/api/queue'),
    version: shell.calls.some((c) => c.url.startsWith('/api/version')),
  }));
  t.after(off);
  await shell.frame(helloFrame({ project: 'p1', mounts: [{ id: 'h1', html: '<p>h</p>', target: 'main', params: {}, pane_state: {} }] }));
  await shell.frame({ type: 'reset', active: 'n1', lock: null, store: {}, theme: null, activeTheme: null, mounts: [] });
  assert.deepEqual(seen, [{ project: 'p1', panes: 1, clientSent: 1, queue: true, version: true }],
    'once, for the hello and not the reset, with the hello\'s own work already done');
  off();
  await shell.frame(helloFrame());
  assert.equal(seen.length, 1, 'unregistered: the next hello passes it by');
  assert.throws(() => ws.onHello('nope'), /onHello: the handler must be a function/);
});

test('setClientField merges into every client frame, and is re-sent at once while the socket is open', async (t) => {
  t.after(() => { ws.setClientField('probe', undefined); ws.setClientField('other', undefined); });
  // Only this test's own fields are compared: another module may add its own.
  const mine = (f) => ({ type: f.type, device: f.device, probe: f.probe, other: f.other });
  const s = shell.socket();
  const n = s.frames('client').length;
  ws.setClientField('probe', 'one');
  assert.equal(s.frames('client').length, n + 1, 'sent at once');
  assert.deepEqual(mine(lastClient()), { type: 'client', device: 'desktop', probe: 'one', other: undefined });
  ws.setClientField('probe', 'one');
  assert.equal(s.frames('client').length, n + 1, 'the same value again sends nothing');
  ws.setClientField('other', 2);
  assert.deepEqual(mine(lastClient()), { type: 'client', device: 'desktop', probe: 'one', other: 2 }, 'every field rides every frame');
  await shell.frame(helloFrame());
  assert.deepEqual(mine(lastClient()), { type: 'client', device: 'desktop', probe: 'one', other: 2 }, 'a hello re-sends the whole set');
  ws.setClientField('other', undefined);
  assert.ok(!('other' in lastClient()), 'undefined withdraws a field');
  assert.equal(lastClient().probe, 'one', 'and leaves the others');
  for (const key of ['type', 'device', '']) {
    assert.throws(() => ws.setClientField(key, 'x'), /not a field another module may set/, `'${key}' is refused`);
  }
});

test('the chat views\' posture reaches the socket as its mirror field, and only when it moves', (t) => {
  const s = shell.socket();
  const n = s.frames('client').length;
  const view = { id: 'probe-view', open: false, isOpen() { return view.open; }, escape() { return false; }, close() { view.open = false; } };
  const reg = slots.registerChatView(view);
  t.after(() => reg.unregister());
  assert.equal(s.frames('client').length, n, 'a closed view registering sends nothing');
  view.open = true;
  reg.changed();
  assert.equal(s.frames('client').length, n + 1);
  assert.equal(lastClient().mirror, 'full', 'a view opened: the socket wants the stream');
  reg.changed();
  assert.equal(s.frames('client').length, n + 1, 'nothing moved, nothing sent');
  view.open = false;
  reg.changed();
  assert.equal(lastClient().mirror, 'status', 'closed again: the heartbeat only');
  assert.equal(s.frames('client').length, n + 2);
});

test('conn on the chrome bus: one event per change — live, reconnecting, live — and fields set meanwhile ride the reconnect', async (t) => {
  t.after(() => ws.setClientField('probe', undefined));
  const start = connLog.length;
  const first = shell.socket();
  first.onopen({});
  assert.equal(connLog.length, start, 'the same state again says nothing');
  first.drop();
  assert.deepEqual(connLog.slice(start), ['reconnecting']);
  const sentBefore = first.sent.length;
  ws.setClientField('probe', 'while-down');
  assert.equal(first.sent.length, sentBefore, 'nothing is sent on a closed socket');
  // ws.js reconnects after its backoff (0.5 s for a first drop); the shell opens the new socket on the next tick
  await waitUntil(() => shell.sockets.length === 2 && shell.socket().readyState === 1, { timeout: 5000, what: 'the reconnect' });
  assert.deepEqual(connLog.slice(start), ['reconnecting', 'live']);
  assert.equal(constructed.length, 2, 'onSocket saw the second socket too');
  await shell.frame(helloFrame());
  assert.equal(lastClient().probe, 'while-down', 'the reconnect\'s hello carries the field to the new socket');
});

/* ── restore: last, because it ends the shell ─────────────────────────────── */

test('restore() puts every global back as it was, closes the window and clears the chrome\'s pending timers', async () => {
  shell.socket().drop();   // the chrome schedules its reconnect on its backoff, up to 5 s from now
  const count = shell.sockets.length;
  await shell.restore();
  assert.equal(shell.restored, true);
  for (const [k, desc] of globalsBefore) {
    const now = Object.getOwnPropertyDescriptor(globalThis, k);
    assert.equal(Boolean(now), Boolean(desc), `${k}: ${desc ? 'present' : 'absent'} again`);
    if (desc) for (const f of DESCRIPTOR_FIELDS) assert.equal(now[f], desc[f], `${k}.${f} is back as it was`);
  }
  assert.equal(typeof globalThis.document, 'undefined');
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(shell.sockets.length, count, 'the reconnect never fired: restore cleared it');
  assert.equal(await shell.restore(), undefined, 'a second restore is the same, finished one');
  assert.throws(() => bootShell(), /restored/, 'and the file cannot boot a second shell');
});

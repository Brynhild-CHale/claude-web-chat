// The restyled topbar and the chrome hung off it (UX upgrade p2a), driven as
// real DOM against the real front-end module graph in jsdom — same harness
// style as test/shell-chrome.test.js; one boot per test FILE, because the ESM
// cache hands a second import the same already-initialised modules.
//
// What is pinned here is behaviour the restyle changed, not pixels:
//   - the topbar's controls sit in the design's order, and the surface no longer
//     carries the ▾ branch picker or "set active here" (maintainer ruling: forks
//     and set-active live on the graph screen);
//   - ONE status pill carries every state the old two pills did — connecting…,
//     reconnecting…, active, locked, channel turn, viewing — in a fixed
//     precedence, and the brand dot still says whether the socket is live;
//   - Settings says the ◑ mode in words, and greys the missing mode of a
//     single-mode pack;
//   - the wipe label opens prefilled with "before cleanup", and that label rides
//     the wipe when the user just confirms;
//   - the zero state and the page-title slot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');
const { normalizeTheme } = require('../lib/server/theme');

const REPO = path.resolve(__dirname, '..');
const EARTHY = normalizeTheme({ name: 'earthy', builtin: true });
const PAPER = normalizeTheme({ name: 'paper', builtin: true });

// n1 (active) ── n2
const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];

const calls = [];
let W = null, WS = null, restore = () => {};

async function boot() {
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost:5173/', pretendToBeVisual: true });
  const { window } = dom;

  const wsInstances = [];
  // The socket does NOT open by itself: the first assertions are about the
  // state before it does.
  window.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; wsInstances.push(this); }
    send() {}
    close() {}
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u === '/api/graph') return json({ nodes: NODES, active: 'n1' });
    if (u.startsWith('/api/graph/node/')) return json({ id: u.split('/').pop(), mounts: [], store: {} });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/packs') return json({ ok: true, packs: [], quarantined: [] });
    if (u === '/api/services/pending') return json({ ok: true, pending: [] });
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
const press = (el) => { el.dispatchEvent(new W.MouseEvent('pointerdown', { bubbles: true })); click(el); };
const frame = async (msg) => { WS.onmessage({ data: JSON.stringify(msg) }); await tick(); };
const pill = () => $('active-pill');
const hasCls = (el, c) => el.classList.contains(c);

// Let two timers lapse before the window goes: the ◑ flip's 340ms transition
// class, and the 1s reconnect the socket-drop test schedules (it must land on
// the jsdom WebSocket stub, not on Node's own after restore()).
test.after(async () => { await new Promise((r) => setTimeout(r, 1100)); restore(); });

test('before the socket opens, the one pill says so and the dot is grey', async () => {
  await boot();
  await tick();
  assert.equal(pill().textContent, 'connecting…');
  assert.ok(hasCls(pill(), 'off'), 'the pill is in its not-live colour');
  assert.ok(hasCls($('status-dot'), 'off'), 'and the brand dot is grey');
  assert.equal($('status'), null, 'there is no second, connection-only pill any more');
});

test('live: the dot turns green and the pill names the active node', async () => {
  WS.readyState = 1;
  WS.onopen();
  await frame({ type: 'hello', store: {}, theme: EARTHY, activeTheme: null, active: 'n1', lock: null, project: 'test', mounts: [] });
  assert.ok(!hasCls($('status-dot'), 'off'), 'the brand dot is the live signal');
  assert.equal($('status-dot').getAttribute('aria-label'), 'live', 'and says so to a screen reader');
  assert.equal(pill().textContent, 'active n1.0');
  assert.equal(pill().className, 'active-pill', 'the plain green active state');
});

test('the topbar is laid out in the design\'s order', () => {
  const order = [...$('topbar').children].map((el) => el.id || el.className);
  const want = ['brand', 'node-label', 'page-title', 'cmd-trigger', 'dock', 'btn-return-active',
    'active-pill', 'btn-theme-toggle', 'btn-graph', 'btn-more'];
  const seen = order.filter((k) => want.includes(k));
  assert.deepEqual(seen, want, `topbar children in order: ${order.join(' · ')}`);
  const stepper = $('topbar').querySelector('.stepper');
  assert.ok(order.indexOf('dock') < [...$('topbar').children].indexOf(stepper)
    && [...$('topbar').children].indexOf(stepper) < order.indexOf('btn-return-active'),
    'the ↑/↓ stepper sits between the dock and ↩ active');
  assert.match($('cmd-trigger').textContent, /Search commands, nodes, blocks…/);
});

test('the surface carries no branch picker and no "set active here"', () => {
  assert.equal($('btn-branch'), null, 'the ▾ branch picker is gone (forks are chosen on the graph screen)');
  assert.equal($('btn-set-active-here'), null, 'set-active is a graph-screen action now');
});

test('the page-title slot is present and draws nothing while empty', () => {
  const t = $('page-title');
  assert.ok(t, 'the slot exists for the page model to fill');
  assert.equal(t.textContent, '');
  assert.equal(t.previousElementSibling.id, 'node-label', 'right after the node label');
});

test('a turn lock shows as "locked", a channel wake as "channel turn"', async () => {
  await frame({ type: 'lock', lock: { author: 'user', token: 't' } });
  assert.equal(pill().textContent, 'locked n1.0');
  assert.ok(hasCls(pill(), 'locked') && !hasCls(pill(), 'channel'));

  await frame({ type: 'lock', lock: { author: 'wake', token: 't2' } });
  assert.equal(pill().textContent, 'channel turn n1.0');
  assert.ok(hasCls(pill(), 'locked') && hasCls(pill(), 'channel'), 'a channel turn is a lock, drawn in its own colour');

  await frame({ type: 'lock', lock: null });
  assert.equal(pill().textContent, 'active n1.0', 'unlocking returns to active');
});

test('previewing an older node turns the pill gold "viewing", and ↩ active appears', async () => {
  click($('btn-down'));
  await tick();
  assert.equal(pill().textContent, 'viewing n1.1');
  assert.ok(hasCls(pill(), 'viewing'));
  assert.equal($('btn-return-active').style.display, '', '↩ active shows only while viewing');

  click($('btn-return-active'));
  await tick();
  assert.equal(pill().textContent, 'active n1.0');
  assert.equal($('btn-return-active').style.display, 'none');
});

test('a dropped socket outranks every node state, and the pill recovers on reconnect', async () => {
  await frame({ type: 'lock', lock: { author: 'user', token: 't' } });
  WS.onclose(); // schedules a reconnect: a fresh socket instance, which never opens here
  await tick();
  assert.equal(pill().textContent, 'reconnecting…', 'a stale "locked n1.0" under a dead socket is worse than none');
  assert.ok(hasCls(pill(), 'off'));
  assert.ok(hasCls($('status-dot'), 'off'));
  assert.equal($('status-dot').getAttribute('aria-label'), 'reconnecting…');

  WS.onopen();
  await tick();
  assert.equal(pill().textContent, 'locked n1.0', 'live again: back to the node state it was hiding');
  await frame({ type: 'lock', lock: null });
});

test('Settings says the ◑ mode in words, and switching it flips the mode', async () => {
  press($('btn-more'));
  click($('more-menu').querySelector('[data-act="settings"]'));
  await tick();
  const seg = $('settings-mode');
  const btn = (m) => seg.querySelector(`[data-mode="${m}"]`);
  assert.ok(hasCls(btn('light'), 'on'), 'Earthy opens in its default light mode');
  assert.equal(btn('light').getAttribute('aria-pressed'), 'true');
  assert.equal(btn('dark').disabled, false, 'a two-mode pack offers both');

  click(btn('dark'));
  await tick();
  assert.equal(W.document.documentElement.dataset.theme, undefined, 'the page went dark — the same lever as ◑ / T');
  assert.ok(hasCls(btn('dark'), 'on') && !hasCls(btn('light'), 'on'), 'and the segment follows');

  await new Promise((r) => setTimeout(r, 400)); // let the flip's transition class lapse
  click(btn('light'));
  await tick();
  assert.equal(W.document.documentElement.dataset.theme, 'light');
});

test('under a single-mode pack the missing mode is greyed, not hidden', async () => {
  await frame({ type: 'theme', scope: 'global', theme: PAPER });
  const seg = $('settings-mode');
  const dark = seg.querySelector('[data-mode="dark"]');
  assert.equal(dark.disabled, true, 'Paper has no dark mode to switch to');
  assert.match(dark.title, /only a light mode/, 'and the control says why');
  assert.equal(seg.querySelector('[data-mode="light"]').disabled, false, 'the mode that IS on stays live');
  await frame({ type: 'theme', scope: 'global', theme: EARTHY });
  assert.equal(dark.disabled, false, 'a two-mode pack re-enables it');
});

test('Wipe opens prefilled with "before cleanup", and an untouched label rides the wipe', async () => {
  calls.length = 0;
  press($('btn-more'));
  click($('more-menu').querySelector('[data-act="wipe"]'));
  await tick();
  assert.equal($('wipe-name').value, 'before cleanup');
  assert.match($('wipe-panel').textContent, /Pinned blocks stay/);
  click($('btn-wipe-go'));
  await tick();
  const wiped = calls.find((c) => c.url === '/api/graph/wipe');
  assert.deepEqual(wiped && wiped.body, { name: 'before cleanup' }, 'confirming without typing keeps the default label');
});

test('the ⋯ menu offers the design\'s six actions, in order, plus Replay… and Sessions', () => {
  const acts = [...$('more-menu').querySelectorAll('[data-act]')].map((b) => b.dataset.act);
  assert.deepEqual(acts, ['newgraph', 'wipe', 'export', 'replay', 'sessions', 'settings', 'shortcuts', 'checkupdate']);
});

test('the zero state: "Nothing on the page yet", a suggestion, and G / N / ?', () => {
  const zs = $('main').querySelector('.zero-state');
  assert.ok(zs, 'an empty surface shows the zero state');
  assert.equal(zs.querySelector('h2').textContent, 'Nothing on the page yet');
  assert.ok(zs.querySelector('.zs-quote').textContent.length > 10, 'with a suggestion to paste into the terminal');
  assert.deepEqual([...zs.querySelectorAll('.zs-keys kbd')].map((k) => k.textContent), ['G', 'N', '?']);
});

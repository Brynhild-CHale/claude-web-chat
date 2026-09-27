// Light/dark as a MODE INSIDE a theme pack (public/app/theme.js).
//
// The ◑ toggle used to flip only which set of stylesheet defaults :root read,
// so a saved theme's inline tokens sat on top unchanged — a pack could not have
// a dark variant at all. Now every layer is applied flattened at one effective
// mode: the viewer's stored preference when the global theme offers it, else
// the theme's only mode, and a single-mode pack disables the toggle.
//
// Boots the real module graph under jsdom (as storage-guard.test.js does) and
// drives it with the builtin packs exactly as the server ships them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');
const { normalizeTheme } = require('../lib/server/theme');

const REPO = path.resolve(__dirname, '..');
const EARTHY = normalizeTheme({ name: 'earthy', builtin: true });
// Every builtin pack is two-mode now (s2-2), so the single-mode case is a
// saved theme: Paper's light layer alone, under its own name.
const PAPER = normalizeTheme({ name: 'paper', builtin: true });
const SOLO = { name: 'solo', title: 'Solo', tokens: PAPER.tokens, modes: { light: PAPER.modes.light } };

let W = null, WS = null, restore = () => {};
// What /api/themes and /api/theme?scope=global answer (the Settings picker).
const THEME_ROWS = [
  { name: 'earthy', title: 'Earthy', location: 'builtin', modes: ['light', 'dark'] },
  { name: 'georgetown-blue', title: 'Georgetown Blue', location: 'builtin', modes: ['light', 'dark'] },
  { name: 'night', location: 'local', modes: ['dark'] },
  { name: 'mine', location: 'local' },
];
let GLOBAL_NAME = 'earthy';

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
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/graph') return json({ nodes: [{ id: 'n1', label: 'n1', parent_id: null, created_at: 1 }], active: 'n1' });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: THEME_ROWS });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.3.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: GLOBAL_NAME });
    return json({ ok: true });
  };
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
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const rootTok = (k) => W.document.documentElement.style.getPropertyValue(k);
const pressT = async () => { W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 't' })); await tick(); };
const frame = async (msg) => { WS.onmessage({ data: JSON.stringify(msg) }); await tick(); };
const paneWrapper = () => $('main').querySelector('.pane');

// the ◑ flip arms a 340ms transition class; let it lapse before the window goes
test.after(async () => { await new Promise((r) => setTimeout(r, 400)); restore(); });

test('a two-mode pack paints its light mode by default, and ◑ is live', async () => {
  await boot();
  await tick();
  await frame({
    type: 'hello', store: {}, theme: EARTHY, activeTheme: null, active: 'n1', lock: null, project: 'test',
    mounts: [{
      id: 'm1', html: '<p>hi</p>', target: 'main', params: {}, pane_state: {},
      theme: { modes: { light: { tokens: { '--wc-content-bg': '#aaaaaa' } }, dark: { tokens: { '--wc-content-bg': '#111111' } } } },
    }],
  });
  assert.equal(W.document.documentElement.dataset.theme, 'light');
  assert.equal(rootTok('--wc-bg'), EARTHY.modes.light.tokens['--wc-bg'], 'the light layer is on :root');
  assert.equal(rootTok('--wc-font'), EARTHY.tokens['--wc-font'], 'the mode-free layer is on :root too');
  assert.equal(paneWrapper().style.getPropertyValue('--wc-content-bg'), '#aaaaaa', 'a pane theme flattens at the same mode');
  const btn = $('btn-theme-toggle');
  assert.equal(btn.getAttribute('aria-disabled'), 'false');
  assert.equal(btn.classList.contains('is-disabled'), false);
});

test('◑ / T flips the mode INSIDE the pack — chrome and panes alike — and remembers it', async () => {
  await pressT();
  assert.equal(W.document.documentElement.dataset.theme, undefined, 'dark: the stylesheet fallbacks follow too');
  assert.equal(rootTok('--wc-bg'), EARTHY.modes.dark.tokens['--wc-bg'], "the pack's dark layer replaced its light one");
  assert.equal(paneWrapper().style.getPropertyValue('--wc-content-bg'), '#111111', 'the pane re-flattened at dark');
  assert.equal(W.localStorage.getItem('wc-mode'), 'dark', 'the preference persists as before');
});

test('a single-mode pack forces its own mode and disables ◑ with a tooltip saying why', async () => {
  await frame({ type: 'theme', scope: 'global', theme: SOLO });
  assert.equal(W.document.documentElement.dataset.theme, 'light', 'Solo is light-only, whatever the preference');
  assert.equal(rootTok('--wc-bg'), SOLO.modes.light.tokens['--wc-bg']);
  assert.equal(paneWrapper().style.getPropertyValue('--wc-content-bg'), '#aaaaaa',
    'the pane follows the effective mode, not the stored preference');
  const btn = $('btn-theme-toggle');
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.ok(btn.classList.contains('is-disabled'));
  assert.match(btn.title, /^Solo has only a light mode/, 'the tooltip names the theme by its display name');

  await new Promise((r) => setTimeout(r, 400)); // let the earlier flip's transition class lapse
  await pressT();
  assert.equal(W.document.documentElement.dataset.theme, 'light', 'T does nothing under a single-mode pack');
  assert.ok(!W.document.documentElement.classList.contains('wc-theming'), '…not even a swap animation');
  assert.equal(W.localStorage.getItem('wc-mode'), 'dark', '…and does not overwrite the stored preference');
});

test('switching back to a two-mode pack restores the remembered mode', async () => {
  await frame({ type: 'theme', scope: 'global', theme: EARTHY });
  assert.equal(W.document.documentElement.dataset.theme, undefined);
  assert.equal(rootTok('--wc-bg'), EARTHY.modes.dark.tokens['--wc-bg']);
  assert.equal($('btn-theme-toggle').getAttribute('aria-disabled'), 'false');
});

// s2-2: Paper and Georgetown Blue gained dark modes, so ◑ is live under both
// and the viewer's dark preference lands on each pack's own dark layer.
test('◑ works under Paper and Georgetown Blue: each pack has its own dark layer', async () => {
  for (const name of ['paper', 'georgetown-blue']) {
    const pack = normalizeTheme({ name, builtin: true });
    await frame({ type: 'theme', scope: 'global', theme: pack });
    assert.equal($('btn-theme-toggle').getAttribute('aria-disabled'), 'false', `${name}: ◑ is live`);
    assert.equal(W.document.documentElement.dataset.theme, undefined, `${name}: the stored dark preference holds`);
    assert.equal(rootTok('--wc-bg'), pack.modes.dark.tokens['--wc-bg'], `${name}: its dark --wc-bg is on :root`);
    await new Promise((r) => setTimeout(r, 400));
    await pressT();
    assert.equal(rootTok('--wc-bg'), pack.modes.light.tokens['--wc-bg'], `${name}: T flips to its light layer`);
    await new Promise((r) => setTimeout(r, 400));
    await pressT();
  }
  await frame({ type: 'theme', scope: 'global', theme: EARTHY });
});

test('a theme with no modes (every pre-pack theme) applies unchanged in either mode', async () => {
  await frame({ type: 'theme', scope: 'global', theme: { tokens: { '--wc-accent': '#123456' } } });
  assert.equal(rootTok('--wc-accent'), '#123456');
  assert.equal(rootTok('--wc-bg'), '', 'pack tokens are cleared; the stylesheet fallbacks show');
  assert.equal($('btn-theme-toggle').getAttribute('aria-disabled'), 'false', 'a mode-agnostic theme keeps ◑ live');
  await pressT();
  assert.equal(W.document.documentElement.dataset.theme, 'light');
  assert.equal(rootTok('--wc-accent'), '#123456', 'the same tokens in the other mode');
});

// s2-1: a builtin pack is shown by its display name; the option's value stays
// the id apply_theme resolves, and a saved theme (no title) shows its name.
test('Settings lists a builtin pack by its display name, keyed by its id', async () => {
  GLOBAL_NAME = 'georgetown-blue';
  const shell = await import(pathToFileURL(path.join(REPO, 'public/app/shell.js')).href);
  shell.openSettings();
  await tick();
  const opts = [...$('settings-theme').querySelectorAll('option')];
  assert.deepEqual(opts.map((o) => [o.value, o.textContent]), [
    ['earthy', 'Earthy'],
    ['georgetown-blue', 'Georgetown Blue'],
    ['night', 'night (dark only)'],
    ['mine', 'mine'],
  ]);
  assert.equal($('settings-theme').value, 'georgetown-blue', 'the current pack is selected by id');
});

// s3c-2: a theme a pack installed lists under "Installed" with the pack's name,
// whichever library tier it landed in; the value stays the name apply resolves.
test('Settings lists pack-installed themes under "Installed", naming the pack', async () => {
  GLOBAL_NAME = 'harbor';
  const added = [
    { name: 'harbor', location: 'local', pack: 'harbor-themes', modes: ['light', 'dark'] },
    { name: 'tide', location: 'system', pack: 'harbor-themes', modes: ['dark'] },
  ];
  THEME_ROWS.push(...added);
  try {
    const shell = await import(pathToFileURL(path.join(REPO, 'public/app/shell.js')).href);
    shell.openSettings();
    await tick();
    const groups = [...$('settings-theme').querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => [o.value, o.textContent])]);
    assert.deepEqual(groups, [
      ['built-in', [['earthy', 'Earthy'], ['georgetown-blue', 'Georgetown Blue']]],
      ['Installed', [['harbor', 'harbor — harbor-themes'], ['tide', 'tide (dark only) — harbor-themes']]],
      ['this project', [['night', 'night (dark only)'], ['mine', 'mine']]],
    ]);
    assert.equal($('settings-theme').value, 'harbor');
  } finally {
    THEME_ROWS.splice(THEME_ROWS.length - added.length, added.length);
  }
});

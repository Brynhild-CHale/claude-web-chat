// The replay player overlay (public/app/replay.js) and its three entry points,
// driven as real DOM events against the REAL front-end module graph in jsdom
// (same harness style as test/graph-view-chrome.test.js — one boot per file).
//
// What is pinned:
//   - the overlay never reaches the mount engine: replay.js does not import
//     mounts.js, directly or through anything it imports;
//   - the three entry points (⋯ menu, ⌘K palette, graph inspector ▶ / R) open
//     it on the right node, framing the /replay document with the chosen prefs;
//   - it is a chrome panel: the one Escape owner closes it FIRST (it sits above
//     the graph overlay it can be raised from), and focusing its own frame —
//     which blurs this window — does not dismiss it;
//   - its keys are its own while open (Space / ← / →), and the graph's are not
//     fired underneath it;
//   - prefs persist through storage.js; "Open this node" previews the step on
//     screen.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');

/* ------------- static: the overlay never touches the live surface ------------- */
function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)].map((m) => path.resolve(path.dirname(file), m[1]));
}

test('replay.js does not import mounts.js — not directly, not through anything it imports', () => {
  const start = path.join(REPO, 'public/app/replay.js');
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  const reached = [...seen].map((f) => path.basename(f)).sort();
  assert.ok(!reached.includes('mounts.js'), `replay.js reaches mounts.js via: ${reached.join(', ')}`);
  assert.ok(!reached.includes('topbar.js') && !reached.includes('graph-view.js'),
    'the hand-offs it needs (open a node, forward Escape) are injected by shell.js, not imported');
});

/* ============================== the jsdom boot ============================== */
const NODES = [
  { id: 'n1', label: 'n1', parent_id: null, created_at: 1 },
  { id: 'n1a', label: 'n1.1', parent_id: 'n1', created_at: 2, bookmarked: true, name: 'mark' },
  { id: 'n1b', label: 'n1.2', parent_id: 'n1a', created_at: 3 },
];
const lineage = (from, to) => {
  const ids = NODES.map((n) => n.id);
  return ids.slice(ids.indexOf(from), ids.indexOf(to) + 1).map((id) => ({ id, label: NODES.find((n) => n.id === id).label }));
};

const calls = [];
// What GET /api/replay/capabilities answers; a test may flip it.
let caps = { ok: true, chrome: '/x/chrome', ffmpeg: null, formats: { replay: true, gif: true, mp4: false, webm: false } };
let W = null, WS = null, view = null, savedGlobals = null, savedTimers = null;

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
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u === '/api/replay/capabilities') return json(caps);
    if (u === '/api/replay/render') {
      const b = (opts && opts.body && JSON.parse(opts.body)) || {};
      const format = b.format || 'gif';
      return json({ ok: true, format, path: `/p/.web-chat/exports/replay-n1-1_n1-2-20260101-000000.${format}`, label: 'n1.1 → n1.2', frames: 2, bytes: 4096, encoder: caps.ffmpeg ? 'ffmpeg' : 'builtin', include_prompts: !!b.include_prompts });
    }
    if (u === '/api/graph') return json({ nodes: NODES.map((n) => ({ ...n })), active: 'n1b' });
    if (u.startsWith('/api/replay/path')) {
      const q = new URLSearchParams(u.split('?')[1]);
      const to = q.get('to') || 'n1b';
      const from = q.get('from') || (to === 'n1' ? 'n1' : 'n1a'); // the bookmark default
      const steps = lineage(from, to);
      if (!steps.length) return json({ error: 'not an ancestor', code: 'not-ancestor' }, 400);
      return json({ ok: true, from: steps[0], to: steps[steps.length - 1], steps, truncated: false, total_steps: steps.length });
    }
    if (u.startsWith('/api/graph/node/')) {
      const id = decodeURIComponent(u.split('/').pop());
      const n = NODES.find((x) => x.id === id) || NODES[0];
      return json({ ...n, author: 'claude', mounts: [], store: {} });
    }
    if (u.startsWith('/api/graph/diff')) return json({ mounts: { added: [], changed: [], removed: [] } });
    if (u === '/api/components') return json({ components: [] });
    if (u === '/api/themes') return json({ themes: [] });
    if (u === '/api/queue') return json({ items: [], count: 0 });
    if (u === '/api/queue/pending') return json({ pending: null });
    if (u === '/api/queue/policy') return json({ channel_connected: false, immediate_signals: [], queue_signals: [], activation_hint: {}, parked_delivery: 'held' });
    if (u.startsWith('/api/version')) return json({ ok: true, current: '0.3.0', updateAvailable: false });
    if (u.startsWith('/api/theme')) return json({ name: 'web-chat' });
    return json({ ok: true });
  };

  const keys = ['window', 'document', 'location', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent',
    'WheelEvent', 'FocusEvent', 'navigator', 'getComputedStyle', 'localStorage', 'sessionStorage', 'WebSocket', 'fetch',
    'HTMLElement', 'Node', 'Element'];
  const aliasGlobal = (k, v) => {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  };
  savedGlobals = {};
  for (const k of keys) { try { savedGlobals[k] = global[k]; } catch {} aliasGlobal(k, window[k]); }
  savedTimers = { setInterval: global.setInterval, requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame };
  global.setInterval = () => 0;
  global.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  window.__wcMount = require(path.join(REPO, 'public/mount-runtime.js'));

  await import(pathToFileURL(path.join(REPO, 'public/app/main.js')).href);
  // The same module instance main.js loaded — the shared view state.
  ({ view } = await import(pathToFileURL(path.join(REPO, 'public/app/state.js')).href));
  W = window;
  WS = wsInstances[0];
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const $ = (id) => W.document.getElementById(id);
const key = (k, target) => (target || W.document).dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true }));
const click = (el) => el.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
const replayOpen = () => !$('replay-pop').classList.contains('hidden');
const overlayOpen = () => !$('overlay').classList.contains('hidden');
const frameQuery = () => new URLSearchParams(($('rpo-frame').getAttribute('src') || '').split('?')[1] || '');

// A stand-in for the /replay document's window.__wcReplay (jsdom loads no
// subresources, so the frame stays about:blank — the API is what the overlay
// talks to).
function stubPlayer() {
  const log = [];
  const api = {
    steps: [{ id: 'n1a', label: 'n1.1' }, { id: 'n1b', label: 'n1.2' }],
    idx: 1,
    state() { return { index: api.idx, t: 0, total: 5000, playing: false }; },
    toggle() { log.push('toggle'); },
    pause() { log.push('pause'); },
    stepBy(n) { log.push(`step${n}`); },
    setSpeed(x) { log.push(`speed${x}`); },
  };
  $('rpo-frame').contentWindow.__wcReplay = api;
  return log;
}

before(async () => {
  await boot();
  await tick();
  WS.onmessage({ data: JSON.stringify({
    type: 'hello', store: {}, theme: null, activeTheme: null, active: 'n1b', lock: null, project: 'test', mounts: [],
  }) });
  await tick();
});

after(async () => {
  const topbar = await import(pathToFileURL(path.join(REPO, 'public/app/topbar.js')).href);
  clearTimeout(topbar.showReaimNote._t);
  // Entering a preview arms theme.js's 340 ms transition timer, which touches
  // document when it fires: let it land before the globals go back.
  await new Promise((r) => setTimeout(r, 400));
  for (const [k, v] of Object.entries(savedGlobals || {})) {
    try { Object.defineProperty(global, k, { value: v, configurable: true, writable: true }); }
    catch { try { global[k] = v; } catch {} }
  }
  Object.assign(global, savedTimers || {});
  try { W.close(); } catch {}
});

// Every test starts from the same shell: nothing open, no saved prefs, viewing
// the active node, an empty call log. Reset BEFORE each test, so one that throws
// half-way still leaves the next a clean surface.
beforeEach(async () => {
  for (let i = 0; i < 4 && (replayOpen() || overlayOpen() || !$('cmd-palette').classList.contains('hidden')); i++) {
    key('Escape');
    await tick();
  }
  W.localStorage.removeItem('wc:replay-prefs');
  view.viewedId = null;
  calls.length = 0;
});

async function openFromMenu() {
  click($('btn-more'));
  click(W.document.querySelector('#more-menu [data-act="replay"]'));
  await tick();
}

test('⋯ → Replay… opens the player on the active node, from its bookmark, framing /replay', async () => {
  await openFromMenu();
  assert.ok(replayOpen(), 'the ⋯ menu item opens the player');
  const src = $('rpo-frame').getAttribute('src');
  assert.match(src, /^\/replay\?/, 'the frame is the replay document');
  const q = frameQuery();
  assert.equal(q.get('to'), 'n1b');
  assert.equal(q.get('from'), 'n1a', 'from defaults to the nearest bookmark (the server\'s answer)');
  assert.equal(q.get('chrome'), '1');
  assert.equal(q.get('autoplay'), '1');
  assert.equal(q.get('transition'), 'cut');
  assert.equal(q.get('captions'), 'on');
  assert.equal(q.get('include_prompts'), '0', 'prompts are off until the viewer turns them on');
  assert.equal($('rpo-prompts').checked, false);
  assert.match($('rpo-download').getAttribute('href'), /^\/api\/replay\/html\?.*from=n1a.*to=n1b.*include_prompts=0/);
  // the pickers offer the whole drawn lineage above `to`
  assert.deepEqual([...$('rpo-from').options].map((o) => o.value), ['n1', 'n1a', 'n1b']);
  assert.equal($('rpo-from').value, 'n1a');
  assert.match([...$('rpo-from').options][1].textContent, /n1\.1 · mark/);
});

test('its keys are its own while open; Escape closes it and unloads the player', async () => {
  await openFromMenu();
  const log = stubPlayer();
  key(' ');
  key('ArrowRight');
  key('ArrowLeft');
  assert.deepEqual(log, ['toggle', 'pause', 'step1', 'pause', 'step-1']);
  key('g');
  await tick();
  assert.equal(overlayOpen(), false, 'G does not open the graph underneath the player');
  key('Escape');
  assert.equal(replayOpen(), false, 'Escape closes the player');
  assert.equal($('rpo-frame').getAttribute('src'), 'about:blank', 'a closed player holds no live frames');
});

test('focusing the player frame blurs the window, and must not dismiss it', async () => {
  await openFromMenu();
  assert.ok(replayOpen());
  $('rpo-frame').focus();
  W.dispatchEvent(new W.FocusEvent('blur'));
  await tick();
  assert.ok(replayOpen(), 'clicking into the player is using the panel, not leaving it');
  $('rpo-close').focus();
  $('rpo-close').blur();
  W.dispatchEvent(new W.FocusEvent('blur'));
  await tick();
  assert.equal(replayOpen(), false, 'a real window blur still closes it, like every panel');
  assert.equal($('rpo-frame').getAttribute('src'), 'about:blank',
    'and the dismiss layer closes it through closeReplay — the player is unloaded, not just hidden');
});

test('prefs persist; speed is live, transition reloads on the same step', async () => {
  await openFromMenu();
  const log = stubPlayer();
  const sp = $('rpo-speed');
  sp.value = '2';
  sp.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.deepEqual(log, ['speed2'], 'speed changes the running player, no reload');
  assert.equal(frameQuery().get('speed'), '1', 'and does not reload the frame');
  const tr = $('rpo-transition');
  tr.value = 'fade';
  tr.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.equal(frameQuery().get('transition'), 'fade');
  assert.equal(frameQuery().get('at'), '1', 'the reload keeps the step on screen');
  assert.equal(frameQuery().get('autoplay'), '0');
  const saved = JSON.parse(W.localStorage.getItem('wc:replay-prefs'));
  assert.deepEqual(saved, { speed: '2', transition: 'fade', captions: 'on', prompts: false });
  key('Escape');
  // …and the next open starts from them.
  await openFromMenu();
  assert.equal(frameQuery().get('transition'), 'fade');
  assert.equal(frameQuery().get('speed'), '2');
  assert.equal($('rpo-speed').value, '2');
});

test('"Open this node" previews the step on screen and closes the player', async () => {
  // A step that is not the active node is fetched and previewed.
  await openFromMenu();
  stubPlayer();
  $('rpo-frame').contentWindow.__wcReplay.idx = 0;
  calls.length = 0;
  click($('rpo-open'));
  await tick();
  assert.equal(replayOpen(), false, 'the player closes');
  assert.ok(calls.some((c) => c.url === '/api/graph/node/n1a'), 'n1.1 is opened as a preview');
  assert.ok($('main').classList.contains('preview-readonly'), 'the surface is previewing it');
});

test('⌘K offers "Replay to <label>" for the node being viewed', async () => {
  view.viewedId = 'n1a';   // previewing n1.1
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  await tick();
  const rows = [...W.document.querySelectorAll('#cmd-list .palette-item')].map((r) => r.textContent);
  assert.ok(rows.some((t) => /Replay to n1\.1/.test(t)), `palette rows: ${rows.slice(0, 12).join(' | ')}`);
  const row = [...W.document.querySelectorAll('#cmd-list .palette-item')].find((r) => /Replay to/.test(r.textContent));
  row.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true }));
  await tick();
  assert.ok(replayOpen());
  assert.equal(frameQuery().get('to'), 'n1a', 'to the VIEWED node, not active');
});

test('R on the surface opens the player on the node being viewed — the key the legend lists', async () => {
  assert.ok(W.document.querySelector('#key-legend').textContent.includes('Replay to node'), 'precondition: the legend advertises R');
  key('r');
  await tick();
  assert.ok(replayOpen(), 'R opens the player');
  assert.equal(frameQuery().get('to'), 'n1b', 'to the node on screen (active here)');
});

test('graph inspector: ▶ Replay and R open it above the overlay; Escape closes the player first', async () => {
  click($('btn-graph'));
  await tick();
  await tick();
  assert.ok(overlayOpen(), 'precondition: graph open');
  // The inspector exists only while a node is selected (P2): select one on the canvas.
  const glyph = W.document.querySelector('#graph-svg g[data-id]');
  assert.ok(glyph, 'precondition: the canvas draws a node');
  glyph.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await tick();
  await tick();
  const btn = W.document.querySelector('#gv-inspector [data-act="replay"]');
  assert.ok(btn, 'the inspector carries ▶ Replay');
  click(btn);
  await tick();
  assert.ok(replayOpen(), '▶ Replay opens the player');
  key('Escape');
  assert.equal(replayOpen(), false, 'Escape closes the player…');
  assert.ok(overlayOpen(), '…and only the player — the graph it was raised from stays');

  key('r', $('overlay'));
  await tick();
  assert.ok(replayOpen(), 'R in the graph opens the player on the selected node');
  assert.equal(frameQuery().get('to'), glyph.dataset.id, 'to the SELECTED node');
});

test('↧ GIF: renders on the first click with prompts OFF by default, and the note links the file', async () => {
  await openFromMenu();
  await tick();
  assert.equal($('rpo-gif').disabled, false, 'Chrome found: the button is live');
  calls.length = 0;
  click($('rpo-gif'));
  await tick();
  await tick();
  const r = calls.filter((c) => c.url === '/api/replay/render');
  assert.equal(r.length, 1, 'one click renders — no second-click warning');
  assert.equal(r[0].method, 'POST');
  assert.deepEqual(r[0].body, { format: 'gif', transition: 'cut', captions: 'on', include_prompts: false, from: 'n1a', to: 'n1b' });
  const link = $('rpo-render-file');
  assert.ok(link, 'the note links the rendered file');
  assert.equal(link.getAttribute('href'), '/api/replay/file/replay-n1-1_n1-2-20260101-000000.gif');
  assert.match($('rpo-note').textContent, /2 frames, 4 KB\)$/);
  assert.doesNotMatch($('rpo-note').textContent, /prompts/, 'no reminder: the file has none');
});

test('"Include my prompts": remembered, reloads the player with them, and a file rendered with them says so in one line', async () => {
  await openFromMenu();
  const log = stubPlayer();
  const cb = $('rpo-prompts');
  cb.checked = true;
  cb.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.deepEqual(log, [], 'no player call: the document is rebuilt');
  assert.equal(frameQuery().get('include_prompts'), '1', 'the player now shows them');
  assert.equal(frameQuery().get('at'), '1', 'on the same step');
  assert.match($('rpo-download').getAttribute('href'), /include_prompts=1/, 'replay.html follows the toggle');
  assert.equal(JSON.parse(W.localStorage.getItem('wc:replay-prefs')).prompts, true, 'the choice is remembered');

  calls.length = 0;
  click($('rpo-gif'));
  await tick();
  await tick();
  const r = calls.filter((c) => c.url === '/api/replay/render');
  assert.equal(r.length, 1, 'still ONE click');
  assert.equal(r[0].body.include_prompts, true);
  assert.match($('rpo-note').textContent, /GIF ready .*— includes your prompts$/, 'a one-line reminder');

  $('rpo-download').addEventListener('click', (e) => e.preventDefault(), { once: true }); // jsdom cannot navigate
  click($('rpo-download'));
  assert.equal($('rpo-note').textContent, 'replay.html includes your prompts', 'the download says so too');
  key('Escape');

  // The next open starts from the remembered choice.
  await openFromMenu();
  assert.equal($('rpo-prompts').checked, true);
  assert.equal(frameQuery().get('include_prompts'), '1');

  // captions none: nothing to include, the toggle greys out and files carry none.
  const sel = $('rpo-captions');
  sel.value = 'none';
  sel.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.equal($('rpo-prompts').disabled, true);
  assert.equal(frameQuery().get('include_prompts'), '0');
});

test('an old stored captions:"prompt" (the old select\'s default) does not turn prompts on', async () => {
  W.localStorage.setItem('wc:replay-prefs', JSON.stringify({ speed: '1', transition: 'cut', captions: 'prompt' }));
  await openFromMenu();
  assert.equal($('rpo-captions').value, 'on');
  assert.equal($('rpo-prompts').checked, false);
  assert.equal(frameQuery().get('include_prompts'), '0');
});

test('↧ GIF: no Chrome disables the button', async () => {
  caps = { ...caps, chrome: null, formats: { ...caps.formats, gif: false } };
  try {
    await openFromMenu();
    await tick();
    assert.equal($('rpo-gif').disabled, true, 'no Chrome-family browser: nothing to draw a GIF with');
    assert.match($('rpo-gif').title, /WEB_CHAT_CHROME/);
  } finally {
    caps = { ...caps, chrome: '/x/chrome', formats: { ...caps.formats, gif: true } };
  }
});

test('↧ MP4 / ↧ WebM: disabled without ffmpeg (the title says what to install); with it they render video', async () => {
  // The default capabilities: Chrome found, no ffmpeg.
  await openFromMenu();
  await tick();
  for (const id of ['rpo-mp4', 'rpo-webm']) {
    assert.equal($(id).disabled, true, `${id}: no ffmpeg, no video`);
    assert.match($(id).title, /ffmpeg.*WEB_CHAT_FFMPEG/);
  }
  assert.equal($('rpo-gif').disabled, false, 'a GIF needs no ffmpeg');
  assert.doesNotMatch($('rpo-gif').title, /ffmpeg/, 'and is drawn by the built-in encoder');
  key('Escape');

  caps = { ...caps, ffmpeg: '/x/ffmpeg', formats: { ...caps.formats, mp4: true, webm: true } };
  try {
    W.localStorage.setItem('wc:replay-prefs', JSON.stringify({ captions: 'none' }));
    await openFromMenu();
    await tick();
    assert.equal($('rpo-mp4').disabled, false);
    assert.equal($('rpo-webm').disabled, false);
    assert.match($('rpo-gif').title, /encoded by ffmpeg/);
    calls.length = 0;
    click($('rpo-mp4'));
    await tick();
    await tick();
    const r = calls.filter((c) => c.url === '/api/replay/render');
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].body, { format: 'mp4', transition: 'cut', captions: 'none', include_prompts: false, from: 'n1a', to: 'n1b' });
    assert.equal($('rpo-render-file').getAttribute('href'), '/api/replay/file/replay-n1-1_n1-2-20260101-000000.mp4');
    assert.match($('rpo-note').textContent, /^MP4 ready \(ffmpeg\)/);
  } finally {
    caps = { ...caps, ffmpeg: null, formats: { ...caps.formats, mp4: false, webm: false } };
  }
});

// s2-3: the documents the chrome frames follow the viewer's light/dark. The
// daemon has no mode of its own, so the chrome names it (`?mode=`) and redraws
// on a ◑ flip — while a download stays light (the render bodies above carry no
// mode at all).
test('the player and the glance are drawn in the viewer\'s mode and redraw on ◑; the download stays light', async () => {
  // Called directly: a click on ◑ is outside the player, which closes it, and
  // the player keeps T for itself — so what reaches an open player is a mode
  // change from elsewhere (a pack swap arriving over the socket, say).
  const { toggleMode } = await import(pathToFileURL(path.join(REPO, 'public/app/theme.js')).href);
  const toggle = () => toggleMode();
  const mode = () => (W.document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  assert.equal(mode(), 'light', 'precondition: light');
  try {
    await openFromMenu();
    assert.equal(frameQuery().get('mode'), 'light', 'the player frame names the viewer\'s mode');
    assert.equal(new URLSearchParams($('rpo-download').getAttribute('href').split('?')[1]).get('mode'), null,
      'the replay.html download names none, so the file is light');
    stubPlayer();
    toggle();
    assert.equal(mode(), 'dark');
    assert.equal(frameQuery().get('mode'), 'dark', '◑ reloads the player in the new mode…');
    assert.equal(frameQuery().get('at'), '1', '…on the same step');
    assert.equal(new URLSearchParams($('rpo-download').getAttribute('href').split('?')[1]).get('mode'), null,
      'and the download is still light');
    key('Escape');
    await tick();

    click($('btn-graph'));
    await tick();
    await tick();
    W.document.querySelector('#graph-svg g[data-id]').dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
    await tick();
    key(' ', $('overlay'));
    await tick();
    const glance = () => W.document.querySelector('iframe.glance-frame');
    assert.ok(glance(), 'Space opens the glance');
    assert.match(glance().getAttribute('src'), /^\/preview\/node\/[^?]+\?mode=dark$/, 'drawn in the viewer\'s (dark) mode');
    toggle();
    assert.match(glance().getAttribute('src'), /\?mode=light$/, '◑ redraws it in the new mode');
  } finally {
    if (mode() !== 'light') toggle();
    for (let i = 0; i < 4; i++) { key('Escape'); await tick(); }
  }
});

test('Claude\'s replay: a replay:open frame opens the player on that script, and ↧ GIF renders the same script', async () => {
  const pinned = { from: 'n1', to: 'n1b', title: 'How it grew', steps: [{ node: 'n1', caption: 'start' }, { nodes: ['n1a', 'n1b'], hold_ms: 4000 }] };
  WS.onmessage({ data: JSON.stringify({
    type: 'replay:open', script_id: 'abc123', script: pinned, title: 'How it grew', steps: 2,
    from: { id: 'n1', label: 'n1' }, to: { id: 'n1b', label: 'n1.2' },
  }) });
  await tick();
  await tick();
  assert.ok(replayOpen(), 'the frame opens the player — no click');
  const q = frameQuery();
  assert.equal(q.get('script'), 'abc123', 'the document plays the script the daemon holds');
  assert.equal(q.get('from'), null, 'not a from/to range');
  assert.equal(q.get('to'), null);
  assert.equal(q.get('autoplay'), '1');
  assert.equal(q.get('include_prompts'), '0', 'the viewer\'s prompt choice still rides along');
  assert.match($('rpo-download').getAttribute('href'), /^\/api\/replay\/html\?script=abc123&/);
  assert.equal($('rpo-note').textContent, "Claude's replay: How it grew — 2 steps");
  assert.equal($('rpo-from').value, 'n1', 'the pickers show the script\'s ends');
  assert.equal($('rpo-to').value, 'n1b');

  calls.length = 0;
  click($('rpo-gif'));
  await tick();
  await tick();
  const r = calls.find((c) => c.url === '/api/replay/render');
  assert.deepEqual(r.body, { format: 'gif', transition: 'cut', captions: 'on', include_prompts: false, script: { ...pinned, include_prompts: false } },
    'the render is of the same script, not its from/to — carrying the viewer\'s prompt choice');

  // A new range is a plain replay of it.
  const from = $('rpo-from');
  from.value = 'n1a';
  from.dispatchEvent(new W.Event('change', { bubbles: true }));
  await tick();
  assert.equal(frameQuery().get('script'), null, 'picking a range leaves the script');
  assert.equal(frameQuery().get('from'), 'n1a');
  assert.equal($('rpo-note').textContent, '');
});

test('Claude\'s replay with include_prompts: the box starts ticked for it, and unticking it takes them out of every file', async () => {
  const pinned = { from: 'n1', to: 'n1b', include_prompts: true };
  WS.onmessage({ data: JSON.stringify({
    type: 'replay:open', script_id: 'withp', script: pinned, title: null, steps: 3,
    from: { id: 'n1', label: 'n1' }, to: { id: 'n1b', label: 'n1.2' },
  }) });
  await tick();
  await tick();
  assert.ok(replayOpen());
  assert.equal($('rpo-prompts').checked, true, 'the checkbox shows what the script chose');
  assert.equal(frameQuery().get('include_prompts'), '1', 'and the player follows it');
  assert.notEqual((JSON.parse(W.localStorage.getItem('wc:replay-prefs') || '{}')).prompts, true,
    'Claude\'s choice is not remembered as the viewer\'s');

  const cb = $('rpo-prompts');
  cb.checked = false;
  cb.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.equal(frameQuery().get('include_prompts'), '0', 'unticked: the player drops them…');
  assert.match($('rpo-download').getAttribute('href'), /include_prompts=0/, '…and so does replay.html');

  calls.length = 0;
  click($('rpo-gif'));
  await tick();
  await tick();
  const r = calls.find((c) => c.url === '/api/replay/render');
  assert.equal(r.body.include_prompts, false);
  assert.equal(r.body.script.include_prompts, false, '↧ GIF posts the script with the viewer\'s choice, not the script\'s');
  assert.doesNotMatch($('rpo-note').textContent, /prompts/);
});

test('a replay:open frame without a script id opens nothing', async () => {
  WS.onmessage({ data: JSON.stringify({ type: 'replay:open', from: { id: 'n1' }, to: { id: 'n1b' } }) });
  await tick();
  assert.equal(replayOpen(), false);
});

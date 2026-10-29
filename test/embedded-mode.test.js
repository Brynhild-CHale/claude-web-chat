// Embedded mode (U470; form 6 V1/V2/W2 = a; web-chat-contracts 06 C-06.33 to
// C-06.36): inside the hub's chat view the daemon's chrome is framed and shows
// the slim strip; the shell provides the project name, the node label and page
// title, Sessions, the theme toggle, the version banner and the ⋯ menu.
//
// Through the real shell (test-support/chrome-shell bootShell) with a health
// route each case answers. FRAMING: jsdom cannot frame a window (its top and
// parent are unforgeable), so the cases frame the page through the seam
// public/app/remote.js exposes for tests, resetEmbedForTests({framed, parent}),
// which swaps the frame probe, the parent window the bridge talks to (a fake
// that records its postMessage calls), and drops the cached health answer.
// A TRUSTED message event cannot be dispatched in a test either, so the
// bridge's guards are driven through its exported handleMessage with plain
// events, and one real (untrusted) MessageEvent shows the window listener
// drops it.
//
// The layout is read through test-support/css-cascade over public/app.css.
const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootShell, respond, helloFrame } = require('../test-support/chrome-shell');
const { createCascade } = require('../test-support/css-cascade');
const { waitUntil } = require('../test-support/helpers');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
const HUB = 'https://hub.example';
const HIDDEN = ['cobrand', 'node-label', 'page-title', 'cmd-trigger', 'active-pill', 'btn-theme-toggle', 'btn-more'];
const KEPT = ['btn-up', 'btn-down', 'btn-return-active', 'btn-add', 'btn-bookmark', 'toolbar', 'btn-graph'];
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

let shell, W, $, css, remote, bridge, theme, hotkeys, version, sheet, sessions, shellMod;
let health = () => ({ ok: true, remote: false });
let versionBody = { ok: true, current: '0.9.0-test.1', updateAvailable: false };
// The chat mirror's snapshot, for the composer's host note (null: no mirror).
let mirrorSnap = null;
let mirrorRev = 100;

// The parent window the bridge posts to.
function fakeParent() {
  return { posts: [], postMessage(msg, origin) { this.posts.push({ msg, origin }); } };
}
let parent = fakeParent();

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/health': () => health(),
      '/api/version': () => versionBody,
      '/api/version?force=1': () => versionBody,
      '/api/mirror': () => mirrorSnap || { status: 404, body: { error: 'none' } },
    },
  });
  W = shell.window;
  $ = shell.$;
  css = createCascade(CSS, { win: () => W });
  remote = await shell.importApp('remote.js');
  bridge = await shell.importApp('embed-bridge.js');
  theme = await shell.importApp('theme.js');
  hotkeys = await shell.importApp('hotkeys.js');
  version = await shell.importApp('version.js');
  sheet = await shell.importApp('chat-sheet.js');
  sessions = await shell.importApp('sessions.js');
  shellMod = await shell.importApp('shell.js');
});
after(async () => { if (shell) await shell.restore(); });

const root = () => W.document.documentElement;
const display = (id) => css.value($(id), 'display');
const shown = (id) => !!$(id) && !$(id).classList.contains('hidden');
// The full chrome draws every item. An empty #page-title takes no room by its
// own rule (a page with no # heading), so it is given a title to be read.
function assertFullChrome() {
  const pt = $('page-title');
  const was = pt.textContent;
  pt.textContent = 'A title';
  try {
    for (const id of [...HIDDEN, ...KEPT]) assert.notEqual(display(id), 'none', `#${id} is drawn`);
  } finally { pt.textContent = was; }
}

// Frame the page (or not), answer health with `answer`, and wait for the read.
async function frameWith({ framed, answer }) {
  health = answer;
  parent = fakeParent();
  await remote.resetEmbedForTests({ framed, parent });
  await shell.tick();
}
const HEADER_FORM = () => respond({ ok: true, remote: true, package_version: '0.9.0-test.1' },
  { headers: { 'X-WC-Embedded': '1', 'X-WC-Embed-Parent': HUB } });
const BODY_FORM = () => ({ ok: true, remote: true, package_version: '0.9.0-test.1', embedded: true, embed_parent: HUB });
const NEITHER = () => ({ ok: true, remote: true, package_version: '0.9.0-test.1' });

beforeEach(async () => {
  shellMod.handleEscape();
  if (W.innerWidth !== DESKTOP.width || W.innerHeight !== DESKTOP.height) { shell.setViewport(DESKTOP); await shell.tick(); }
});

/* ── the flag ─────────────────────────────────────────────────────────────── */

test('booted top-level: no html.framed, no html.embedded, the full chrome', () => {
  assert.equal(remote.isFramed(), false);
  assert.equal(remote.isEmbedded(), false);
  assert.equal(root().classList.contains('framed'), false);
  assert.equal(root().classList.contains('embedded'), false);
  assertFullChrome();
});

for (const [name, answer] of [['the header form', HEADER_FORM], ['the body form', BODY_FORM]]) {
  test(`framed, health in ${name}: embedded, embed_parent kept, the seven hidden and the strip's seven kept`, async () => {
    await frameWith({ framed: true, answer });
    assert.equal(remote.isEmbedded(), true);
    assert.equal(remote.embedParent(), HUB);
    assert.equal(root().classList.contains('embedded'), true, 'html.embedded set');
    for (const id of HIDDEN) assert.equal(display(id), 'none', `#${id} hidden`);
    for (const id of KEPT) assert.notEqual(display(id), 'none', `#${id} kept`);
    const firstDiv = $('cobrand').nextElementSibling;
    assert.ok(firstDiv.classList.contains('tb-div'));
    assert.equal(css.value(firstDiv, 'display'), 'none', 'the divider beside the co-brand goes with it');
    assert.equal(display('update-banner'), 'none', 'the version banner is hidden');
    assert.equal(display('sessions-panel'), 'none', 'the Sessions panel is hidden');
  });

  test(`top-level, health in ${name}: not embedded (the same origin opened top-level is the full chrome)`, async () => {
    await frameWith({ framed: false, answer });
    assert.equal(remote.isEmbedded(), false);
    assert.equal(remote.embedParent(), null);
    assert.equal(root().classList.contains('embedded'), false);
    assert.equal(root().classList.contains('framed'), false);
    assertFullChrome();
  });
}

test('framed, health says neither: not embedded; html.framed dropped; the full chrome', async () => {
  await frameWith({ framed: true, answer: HEADER_FORM });
  assert.equal(root().classList.contains('embedded'), true);
  await frameWith({ framed: true, answer: NEITHER });
  assert.equal(remote.isEmbedded(), false);
  assert.equal(root().classList.contains('embedded'), false, 'html.embedded removed');
  assert.equal(root().classList.contains('framed'), false, 'html.framed dropped once health answers');
  assertFullChrome();
});

test('framed, before health answers: html.framed pre-hides the same items (no flash of the full topbar)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  health = () => gate.then(HEADER_FORM);
  parent = fakeParent();
  const read = remote.resetEmbedForTests({ framed: true, parent });
  assert.equal(root().classList.contains('framed'), true, 'set at once');
  assert.equal(remote.shellHidden(), true, 'the openers already stand down');
  for (const id of HIDDEN) assert.equal(display(id), 'none', `#${id} pre-hidden`);
  for (const id of KEPT) assert.notEqual(display(id), 'none', `#${id} kept`);
  release();
  await read;
  assert.equal(remote.isEmbedded(), true);
});

test('embed_parent is kept only as an https origin', async () => {
  for (const bad of ['http://hub.example', 'javascript:alert(1)', 'not a url', 'https://u:p@hub.example']) {
    await frameWith({ framed: true, answer: () => respond({ ok: true }, { headers: { 'X-WC-Embedded': '1', 'X-WC-Embed-Parent': bad } }) });
    assert.equal(remote.isEmbedded(), true, `${bad}: still embedded`);
    assert.equal(remote.embedParent(), null, `${bad}: no parent`);
  }
  await frameWith({ framed: true, answer: () => ({ ok: true, embedded: true, embed_parent: `${HUB}/chat/x?y=1` }) });
  assert.equal(remote.embedParent(), HUB, 'the origin of a valid https URL');
  assert.deepEqual(remote.readEmbed({ embeddedHeader: '0', body: { embedded: 'yes', embed_parent: HUB } }),
    { embedded: false, parent: null }, 'only "1" and true count');
});

/* ── narrow ───────────────────────────────────────────────────────────────── */

test('below 760px embedded: the whole #topbar goes; the bottom bar shows as today', async () => {
  await frameWith({ framed: true, answer: HEADER_FORM });
  shell.setViewport(PHONE);
  await shell.tick();
  assert.equal(display('topbar'), 'none');
  assert.equal(css.value($('bottombar'), 'display'), 'flex', 'the bottom bar, as on any narrow screen');
  await frameWith({ framed: true, answer: NEITHER });
  assert.notEqual(display('topbar'), 'none', 'not embedded: the topbar stays');
  assert.equal(css.value($('bottombar'), 'display'), 'flex');
  shell.setViewport(DESKTOP);
  await shell.tick();
  assert.equal(css.value($('bottombar'), 'display'), 'none', 'wide: no bottom bar, embedded or not');
});

/* ── Sessions ─────────────────────────────────────────────────────────────── */

test('embedded, every Sessions opener stands down: the ⋯ row, S, the ⌘K row, and openSessions itself', async () => {
  await frameWith({ framed: true, answer: HEADER_FORM });
  const row = W.document.querySelector('#more-menu [data-act="sessions"]');
  assert.equal(css.value(row, 'display'), 'none', 'the ⋯ row');
  assert.equal(hotkeys.lookup('S', 'page'), null, 'S is not looked up');
  shell.key('s');
  assert.equal(shown('sessions-panel'), false, 'S opens nothing');
  sessions.openSessions();
  assert.equal(shown('sessions-panel'), false, 'nor a direct call');
  shellMod.openPalette();
  await waitUntil(() => W.document.querySelectorAll('#cmd-list .palette-item').length > 0, { timeout: 2000, what: 'palette rows' });
  const labels = [...W.document.querySelectorAll('#cmd-list .palette-item')].map((r) => r.textContent);
  assert.equal(labels.some((t) => t.includes('Sessions')), false, 'no ⌘K row');
  assert.ok(labels.some((t) => t.includes('Settings')), 'the palette is otherwise there');
  shellMod.handleEscape();

  await frameWith({ framed: false, answer: NEITHER });
  assert.ok(hotkeys.lookup('S', 'page'), 'top-level, S is bound');
  sessions.openSessions();
  assert.equal(shown('sessions-panel'), true, 'top-level, it opens');
  sessions.closeSessions();
});

/* ── theme ────────────────────────────────────────────────────────────────── */

test('setMode applies both modes, and keeps a mode already shown', () => {
  assert.equal(theme.setMode('dark'), false);
  assert.equal(theme.effectiveMode(), 'dark');
  assert.equal(root().dataset.theme, undefined, 'dark: no data-theme');
  assert.equal(theme.setMode('dark'), false, 'already dark: kept');
  assert.equal(theme.effectiveMode(), 'dark');
  assert.equal(theme.setMode('light'), true);
  assert.equal(theme.effectiveMode(), 'light');
  assert.equal(root().dataset.theme, 'light');
  assert.equal(theme.setMode('sepia'), null, 'not a mode');
  assert.equal(theme.effectiveMode(), 'light');
});

/* ── the bridge ───────────────────────────────────────────────────────────── */

const ev = (data, over = {}) => ({ isTrusted: true, source: parent, origin: HUB, data, ...over });
const cmd = (action, over) => ev({ wc_embed: 1, type: 'command', action }, over);

test('the bridge posts ready, then status, to embed_parent only', async () => {
  await frameWith({ framed: true, answer: HEADER_FORM });
  await waitUntil(() => parent.posts.some((p) => p.msg.type === 'status'), { timeout: 2000, what: 'a status' });
  assert.equal(parent.posts[0].msg.type, 'ready', 'ready first');
  const ready = parent.posts[0].msg;
  assert.equal(ready.wc_embed, 1);
  assert.equal(ready.package_version, '0.9.0-test.1');
  assert.ok(ready.actions.includes('chrome.escape') && ready.actions.includes('chrome.settings'));
  assert.equal(ready.actions.includes('chrome.sessions'), false);
  for (const a of ready.actions) assert.ok(bridge.COMMANDS.includes(a), `${a} is a schema id`);
  for (const p of parent.posts) assert.equal(p.origin, HUB, 'targetOrigin is embed_parent');
  const status = parent.posts.find((p) => p.msg.type === 'status').msg;
  for (const k of ['conn', 'pill', 'node_label', 'title', 'previewing', 'mode', 'mode_toggleable', 'queue_count']) {
    assert.ok(k in status, `status carries ${k}`);
  }
  assert.deepEqual(Object.keys(status.pill).sort(), ['cls', 'text']);
  // On change, a new status; the same state twice, none.
  const n = parent.posts.length;
  theme.setMode('dark');
  await waitUntil(() => parent.posts.length > n, { timeout: 2000, what: 'a status after the mode moved' });
  assert.equal(parent.posts[parent.posts.length - 1].msg.mode, 'dark');
  theme.setMode('light');
  await waitUntil(() => parent.posts[parent.posts.length - 1].msg.mode === 'light', { timeout: 2000, what: 'the status back to light' });
  await shell.tick(300);
  const settledCount = parent.posts.length;
  const { bus } = await shell.importApp('bus.js');
  bus.emit('mode', { mode: theme.effectiveMode() });
  await shell.tick(300);
  assert.equal(parent.posts.length, settledCount, 'an unchanged status is not posted again');
});

test('the bridge ignores the wrong origin, a non-parent source and an untrusted event', async () => {
  await frameWith({ framed: true, answer: HEADER_FORM });
  assert.equal(bridge.handleMessage(cmd('chrome.settings', { origin: 'https://evil.example' })), false);
  assert.equal(bridge.handleMessage(cmd('chrome.settings', { source: {} })), false);
  assert.equal(bridge.handleMessage(cmd('chrome.settings', { source: W })), false, 'the frame itself is not its parent');
  assert.equal(bridge.handleMessage(cmd('chrome.settings', { isTrusted: false })), false);
  assert.equal(bridge.handleMessage(ev({ wc_embed: 2, type: 'command', action: 'chrome.settings' })), false, 'another bridge version');
  // A real, dispatched (so untrusted) event through the window listener.
  W.dispatchEvent(new W.MessageEvent('message', { data: { wc_embed: 1, type: 'command', action: 'chrome.settings' }, origin: HUB }));
  await shell.tick();
  assert.equal(shown('settings-panel'), false, 'nothing ran');
});

test('the bridge runs chrome.escape and the ⋯ actions through runAction, and refuses an unknown id', async () => {
  await frameWith({ framed: true, answer: HEADER_FORM });
  for (const [action, panel] of [['chrome.settings', 'settings-panel'], ['chrome.wipe', 'wipe-panel'],
    ['chrome.new-graph', 'new-graph-panel'], ['chrome.palette', 'cmd-palette'], ['chrome.bookmark', 'bookmark-pop']]) {
    assert.equal(bridge.handleMessage(cmd(action)), true, `${action} ran`);
    await shell.tick();
    assert.equal(shown(panel), true, `${action} opened #${panel}`);
    assert.equal(bridge.handleMessage(cmd('chrome.escape')), true, 'chrome.escape ran');
    await shell.tick();
    assert.equal(shown(panel), false, `chrome.escape closed #${panel}`);
  }
  assert.equal(bridge.handleMessage(cmd('chrome.add')), true);
  await shell.tick();
  assert.equal(shown('drawer'), true, 'chrome.add opened the drawer');
  bridge.handleMessage(cmd('chrome.escape'));
  await shell.tick();
  const opens = [];
  const { bus } = await shell.importApp('bus.js');
  const off = bus.on('chat:open', (d) => opens.push(d));
  try { assert.equal(bridge.handleMessage(cmd('chrome.chat')), true); } finally { off(); }
  assert.equal(opens.length, 1, 'chrome.chat opened the chat');
  bridge.handleMessage(cmd('chrome.escape'));
  const clicks = [];
  const realClick = W.HTMLAnchorElement.prototype.click;
  W.HTMLAnchorElement.prototype.click = function click() { clicks.push(this.getAttribute('href')); };
  try { assert.equal(bridge.handleMessage(cmd('chrome.export')), true); } finally { W.HTMLAnchorElement.prototype.click = realClick; }
  assert.equal(clicks.length, 1, 'chrome.export downloads');
  assert.match(clicks[0], /^\/api\/export\//);
  for (const bad of ['chrome.sessions', 'chrome.nope', 'replay.play', '', null]) {
    assert.equal(bridge.handleMessage(cmd(bad)), false, `${bad} refused`);
  }
  await shell.tick();
  assert.equal(shown('sessions-panel'), false);
  // A mode message is setMode.
  assert.equal(bridge.handleMessage(ev({ wc_embed: 1, type: 'mode', mode: 'dark' })), true);
  assert.equal(theme.effectiveMode(), 'dark');
  assert.equal(bridge.handleMessage(ev({ wc_embed: 1, type: 'mode', mode: 'blue' })), false);
  theme.setMode('light');
});

test('not embedded, the bridge listens to nothing and posts nothing', async () => {
  await frameWith({ framed: true, answer: NEITHER });
  assert.equal(bridge.handleMessage(cmd('chrome.settings')), false);
  await shell.tick(300);
  assert.equal(parent.posts.length, 0);
  // Embedded but with no valid parent: the same.
  await frameWith({ framed: true, answer: () => respond({ ok: true }, { headers: { 'X-WC-Embedded': '1' } }) });
  assert.equal(remote.isEmbedded(), true);
  assert.equal(bridge.handleMessage(cmd('chrome.settings', { origin: 'null' })), false);
  await shell.tick(300);
  assert.equal(parent.posts.length, 0);
});

/* ── the phone sheet ──────────────────────────────────────────────────────── */

test('embedded on a phone, the chat sheet takes no history entry; top-level it still does', async () => {
  shell.setViewport(PHONE);
  await shell.tick();
  const pushes = [];
  const realPush = W.history.pushState;
  W.history.pushState = function pushState(st, ...rest) { pushes.push(st); return realPush.call(this, st, ...rest); };
  try {
    await frameWith({ framed: true, answer: HEADER_FORM });
    sheet.openSheet();
    assert.equal(sheet.sheetState().open, true);
    assert.equal(pushes.length, 0, 'no entry while embedded');
    sheet.closeSheet({ returnFocus: false });
    await shell.tick();
    await frameWith({ framed: false, answer: NEITHER });
    sheet.openSheet();
    assert.equal(pushes.length, 1, 'top-level: the wcSheet entry, as before');
    sheet.closeSheet({ returnFocus: false });
  } finally { delete W.history.pushState; }
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the sheet\'s entry to go' });
  shell.setViewport(DESKTOP);
  await shell.tick();
});

/* ── the version banner ───────────────────────────────────────────────────── */

test('embedded, the version banner is hidden and checkVersion\'s reload-on-new-build still reloads', async () => {
  await frameWith({ framed: true, answer: HEADER_FORM });
  versionBody = { ok: true, current: '0.9.0-test.1', latest: '0.9.1', updateAvailable: true };
  await version.checkVersion();
  assert.equal(shown('update-banner'), true, 'the bar is up as ever…');
  assert.equal(display('update-banner'), 'none', '…and hidden by the embedded block');
  const reloads = [];
  version.setPageReloader(() => reloads.push(1));
  versionBody = { ok: true, current: '0.9.0-test.2', updateAvailable: false };
  await version.checkVersion();
  await waitUntil(() => reloads.length === 1, { timeout: 2000, what: 'the reload' });
});

/* ── the composer's host note ─────────────────────────────────────────────── */

test('the composer\'s host note names the hub\'s grant when embedded, never a host command', async () => {
  const composer = await shell.importApp('chat-composer.js');
  const state = await shell.importApp('chat-state.js');
  assert.equal(composer.HOST_NOTE_EMBEDDED.includes('claude-web-chat'), false);
  assert.match(composer.HOST_NOTE_EMBEDDED, /hub/);
  // Below full, remotely: the composer draws the host note. Embedded, it is the
  // hub's wording with no <code> command; top-level again, the host command.
  const T0 = Date.now();
  mirrorSnap = { v: 1, enabled: true, now: T0, rev: ++mirrorRev, content: true, access: { level: 'read', remote: true },
    capabilities: { queue_message: true }, primary: 'c1', aggregate: { state: 'idle' },
    conversations: [{ id: 'c1', rev: 1, headless: false, counts: { shells: 0, agents: 0, workflows: 0, monitors: 0 },
      live: { state: 'idle', since: T0, last_activity_at: T0 } }], tasks: [], asks: [] };
  const slot = () => $('chat-composer-slot');
  try {
    await frameWith({ framed: true, answer: HEADER_FORM });
    await shell.frame(helloFrame());
    await waitUntil(() => state.mirror.rev >= mirrorRev, { timeout: 2000, what: 'the mirror snapshot' });
    await waitUntil(() => slot() && slot().textContent === composer.HOST_NOTE_EMBEDDED, { timeout: 2000, what: 'the embedded host note' });
    assert.equal(slot().querySelector('.cc-off code'), null, 'no host command');
    await frameWith({ framed: false, answer: NEITHER });
    await waitUntil(() => slot().textContent === composer.HOST_NOTE + composer.HOST_COMMAND, { timeout: 2000, what: 'the host note' });
    assert.equal(slot().querySelector('.cc-off code').textContent, composer.HOST_COMMAND);
  } finally {
    mirrorSnap = null;
  }
});

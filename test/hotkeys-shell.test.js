// The hotkey registry in the real chrome (annotation engine 2D.3, U333):
// THE KEY MATRIX ORACLE. Every page key the shell bound before the registry
// (the toolbar brief's Appendix A: q p g n t s r c m b [ ] ? Shift+/ ⌘K Ctrl+K,
// plus a bare / as a control) × {plain, Shift, Alt} × {no focus, a chrome input
// focused (#cmd-input), a pane's shadow-rooted <input> focused, a pane's
// button focused} × {nothing open, the graph overlay open, a float preview up,
// the replay player open}: what each press did, recorded as a literal table.
//
// The table (MATRIX below) was RECORDED at the branch base, before
// public/app/hotkeys.js existed — ae/int as U333 was launched, which already
// held U305, U308 and U334 (its sha is in U333's hand-off) — by running this
// file with WEB_CHAT_HOTKEYS_RECORD=<file>, which writes what it saw to <file>
// instead of asserting. It is frozen here, and the registry must reproduce it
// with 0 differences: moving every key onto one lookup changes no observed
// behaviour, Shift, Alt, fields, panes and the three modal layers included.
//
// What a press did is the difference between what the chrome showed just
// before it and just after it settled — the rail's class, the overlay, the
// drawer, the theme, the sessions panel, the replay player, pin mode, the chat
// dock, the bookmark popover, the node on screen, the legend, the palette, the
// focused element — plus whether the press's default was prevented and the
// requests it sent (P's POST /api/queue/push). A case that changed nothing is
// absent from the table. Between cases everything is put back, and the reset is
// checked, so no case leans on the one before it.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');

const NODES = [
  { id: 'n1', label: 'n1', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n2', parent_id: 'n1', created_at: 2 },
  { id: 'n3', label: 'n3', parent_id: 'n2', created_at: 3 },
];

let shell, W, $;
let gv, shellMod, topbar, theme, replay, drawer, sessions, dock;
let pane;

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/graph': () => ({ nodes: NODES.map((n) => ({ ...n })), active: 'n2' }),
      '/api/queue/push': { ok: true },
      // R opens the player; its path read answers an error, so it draws no frames.
      '/api/replay/path': { error: 'no replay in this test' },
    },
  });
  W = shell.window;
  $ = shell.$;
  gv = await shell.importApp('graph-view.js');
  shellMod = await shell.importApp('shell.js');
  topbar = await shell.importApp('topbar.js');
  theme = await shell.importApp('theme.js');
  replay = await shell.importApp('replay.js');
  drawer = await shell.importApp('drawer.js');
  sessions = await shell.importApp('sessions.js');
  dock = await shell.importApp('chat-dock.js');
  await shell.frame(helloFrame({ active: 'n2' }));
  await topbar.ensureGraph(true);
  topbar.updateChip();
  await shell.tick(50);
  // A pane's shadow root, built AFTER the hello (whose snapshot redraws #main).
  const host = W.document.createElement('div');
  host.className = 'pane';
  host.id = 'hk-pane';
  const root = host.attachShadow({ mode: 'open' });
  const button = W.document.createElement('button');
  button.textContent = 'inside the pane';
  const input = W.document.createElement('input');
  root.append(button, input);
  $('main').appendChild(host);
  pane = { host, button, input };
});
after(() => shell.restore());

// ── the matrix's axes ────────────────────────────────────────────────────────

const LETTERS = ['q', 'p', 'g', 'n', 't', 's', 'r', 'c', 'm', 'b'];
const KEYS = [
  ...LETTERS.map((k) => [k, { key: k }]),
  ['[', { key: '[' }],
  [']', { key: ']' }],
  ['?', { key: '?' }],
  ['Shift+/', { key: '/', shiftKey: true }],
  ['/', { key: '/' }],
  ['⌘K', { key: 'k', metaKey: true }],
  ['Ctrl+K', { key: 'k', ctrlKey: true }],
];
// Shift: a letter arrives uppercased, as a browser sends it; any other key
// keeps its key and gains shiftKey (the form the head's switch matched on).
const MODS = {
  plain: (init) => ({ ...init }),
  Shift: (init) => ({ ...init, key: /^[a-z]$/.test(init.key) ? init.key.toUpperCase() : init.key, shiftKey: true }),
  Alt: (init) => ({ ...init, altKey: true }),
};
const FOCUS = {
  none: () => { blur(); return null; },
  'chrome-input': () => { $('cmd-input').focus(); return $('cmd-input'); },
  'pane-input': () => { pane.input.focus(); return pane.input; },
  'pane-button': () => { pane.button.focus(); return pane.button; },
};
const LAYERS = {
  closed: async () => {},
  overlay: async () => { gv.openOverlay(); await shell.tick(5); },
  // A glance raised from the overlay, the overlay then hidden under it, so the
  // float-preview guards are the only ones left (test/chat-shell.test.js's way).
  float: async () => {
    gv.openOverlay();
    await shell.tick(5);
    const node = W.document.querySelector('#graph-svg g[data-id], #gv-world .gv-srow[data-id]');
    assert.ok(node, 'precondition: the graph drew a node');
    node.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
    await shell.tick(5);
    gv.toggleFloatPreview();
    assert.ok(gv.hasFloatPreview(), 'precondition: a float preview is up');
    $('overlay').classList.add('hidden');
    await shell.tick(5);
  },
  // The player's open state without loading a replay (chat-shell's way).
  replay: async () => { $('replay-pop').classList.remove('hidden'); await shell.tick(5); },
};

function blur() {
  const a = W.document.activeElement;
  if (a && a !== W.document.body && a.blur) a.blur();
  if (pane && pane.host.shadowRoot.activeElement) pane.host.shadowRoot.activeElement.blur();
}

const hidden = (id) => { const n = $(id); return n ? n.classList.contains('hidden') : null; };
function focusName() {
  const a = W.document.activeElement;
  if (!a || a === W.document.body) return 'body';
  let s = a.id ? `#${a.id}` : a.tagName.toLowerCase();
  if (a.shadowRoot && a.shadowRoot.activeElement) s += `>${a.shadowRoot.activeElement.tagName.toLowerCase()}`;
  return s;
}
function snap() {
  const add = W.document.querySelector('.rail-add');
  return {
    rail: $('queue-rail').className,
    overlay: hidden('overlay'),
    float: gv.hasFloatPreview(),
    drawer: hidden('drawer'),
    theme: theme.effectiveMode(),
    sessions: hidden('sessions-panel'),
    replay: hidden('replay-pop'),
    pinMode: W.document.body.classList.contains('pin-mode'),
    chat: hidden('chat-dock'),
    bookmark: hidden('bookmark-pop'),
    node: $('node-label').textContent,
    pill: $('active-pill').textContent,
    legend: hidden('key-legend'),
    palette: hidden('cmd-palette'),
    railAdd: add ? add.value : null,
    focus: focusName(),
  };
}

let baseline = null;
async function reset() {
  replay.closeReplay();
  $('replay-pop').classList.add('hidden');
  if (gv.hasFloatPreview()) gv.toggleFloatPreview();
  gv.closeOverlay();
  for (let i = 0; i < 3; i++) shellMod.handleEscape();
  dock.closeChat({ returnFocus: false });
  drawer.closeDrawer();
  sessions.closeSessions();
  if (baseline && $('node-label').textContent !== baseline.node) topbar.returnToActive();
  if (baseline && theme.effectiveMode() !== baseline.theme) theme.toggleMode();
  const add = W.document.querySelector('.rail-add');
  if (add) add.value = 'a note to push';
  await shell.tick(5);
  // A preview and its return redraw #main: put the test's pane back.
  if (!pane.host.isConnected) $('main').appendChild(pane.host);
  blur();
  for (let i = 0; i < 2; i++) shellMod.handleEscape();
  await shell.tick(5);
  blur();
}

function diff(a, b) {
  const out = [];
  for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push(`${k}=${b[k]}`);
  return out;
}

async function runCase(keyInit, mod, focus, layer) {
  await reset();
  const now = snap();
  const d = diff(baseline, now).filter((x) => !x.startsWith('focus='));
  assert.deepEqual(d, [], `the reset before a case put everything back (${d.join(' ')})`);
  assert.ok(pane.host.isConnected, 'the pane is still on the page');
  await LAYERS[layer]();
  const target = FOCUS[focus]();
  const pre = snap();
  const from = shell.calls.length;
  const e = shell.key(keyInit.key, { ...(target ? { target } : {}), ...MODS[mod](keyInit) });
  await shell.tick(15);
  const post = snap();
  const out = diff(pre, post);
  if (e.defaultPrevented) out.push('prevented');
  for (const c of shell.calls.slice(from)) if (c.method !== 'GET') out.push(`${c.method} ${c.url.split('?')[0]}`);
  return out.sort().join(' ');
}

async function record(layer) {
  const seen = {};
  for (const [name, init] of KEYS) {
    for (const mod of Object.keys(MODS)) {
      for (const focus of Object.keys(FOCUS)) {
        const got = await runCase(init, mod, focus, layer);
        if (got) seen[`${name}|${mod}|${focus}|${layer}`] = got;
      }
    }
  }
  await reset();
  return seen;
}

// ── the frozen table (recorded at the branch base; see the head comment) ────

// 816 cases; the 430 that did something, each as the sorted list of what changed.
// Recorded at ae/int f7d4b035fc5a582fb92734d4f42ab184de10caf3 (Node 26.9 and 22.23.3 alike).
const CASES = 816;
const MATRIX = Object.freeze({
  'q|plain|none|closed': 'prevented rail=rail open',
  'q|plain|pane-button|closed': 'prevented rail=rail open',
  'q|Shift|none|closed': 'prevented rail=rail open',
  'q|Shift|pane-button|closed': 'prevented rail=rail open',
  'q|Alt|none|closed': 'prevented rail=rail open',
  'q|Alt|pane-button|closed': 'prevented rail=rail open',
  'p|plain|none|closed': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|plain|pane-button|closed': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Shift|none|closed': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Shift|pane-button|closed': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Alt|none|closed': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Alt|pane-button|closed': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'g|plain|none|closed': 'focus=#overlay overlay=false prevented',
  'g|plain|pane-button|closed': 'focus=#overlay overlay=false prevented',
  'g|Shift|none|closed': 'focus=#overlay overlay=false prevented',
  'g|Shift|pane-button|closed': 'focus=#overlay overlay=false prevented',
  'g|Alt|none|closed': 'focus=#overlay overlay=false prevented',
  'g|Alt|pane-button|closed': 'focus=#overlay overlay=false prevented',
  'n|plain|none|closed': 'drawer=false focus=button prevented',
  'n|plain|pane-button|closed': 'drawer=false focus=button prevented',
  'n|Shift|none|closed': 'drawer=false focus=button prevented',
  'n|Shift|pane-button|closed': 'drawer=false focus=button prevented',
  'n|Alt|none|closed': 'drawer=false focus=button prevented',
  'n|Alt|pane-button|closed': 'drawer=false focus=button prevented',
  't|plain|none|closed': 'prevented theme=dark',
  't|plain|pane-button|closed': 'prevented theme=dark',
  't|Shift|none|closed': 'prevented theme=dark',
  't|Shift|pane-button|closed': 'prevented theme=dark',
  't|Alt|none|closed': 'prevented theme=dark',
  't|Alt|pane-button|closed': 'prevented theme=dark',
  's|plain|none|closed': 'prevented sessions=false',
  's|plain|pane-button|closed': 'prevented sessions=false',
  's|Shift|none|closed': 'prevented sessions=false',
  's|Shift|pane-button|closed': 'prevented sessions=false',
  's|Alt|none|closed': 'prevented sessions=false',
  's|Alt|pane-button|closed': 'prevented sessions=false',
  'r|plain|none|closed': 'prevented replay=false',
  'r|plain|pane-button|closed': 'prevented replay=false',
  'r|Shift|none|closed': 'prevented replay=false',
  'r|Shift|pane-button|closed': 'prevented replay=false',
  'r|Alt|none|closed': 'prevented replay=false',
  'r|Alt|pane-button|closed': 'prevented replay=false',
  'c|plain|none|closed': 'pinMode=true prevented',
  'c|plain|pane-button|closed': 'pinMode=true prevented',
  'c|Shift|none|closed': 'pinMode=true prevented',
  'c|Shift|pane-button|closed': 'pinMode=true prevented',
  'c|Alt|none|closed': 'pinMode=true prevented',
  'c|Alt|pane-button|closed': 'pinMode=true prevented',
  'm|plain|none|closed': 'chat=false focus=#chat-stream prevented',
  'm|plain|pane-button|closed': 'chat=false focus=#chat-stream prevented',
  'm|Shift|none|closed': 'chat=false focus=#chat-stream prevented',
  'm|Shift|pane-button|closed': 'chat=false focus=#chat-stream prevented',
  'm|Alt|none|closed': 'chat=false focus=#chat-stream prevented',
  'm|Alt|pane-button|closed': 'chat=false focus=#chat-stream prevented',
  'b|plain|none|closed': 'bookmark=false focus=#bookmark-name prevented',
  'b|plain|pane-button|closed': 'bookmark=false focus=#bookmark-name prevented',
  'b|Shift|none|closed': 'bookmark=false focus=#bookmark-name prevented',
  'b|Shift|pane-button|closed': 'bookmark=false focus=#bookmark-name prevented',
  'b|Alt|none|closed': 'bookmark=false focus=#bookmark-name prevented',
  'b|Alt|pane-button|closed': 'bookmark=false focus=#bookmark-name prevented',
  '[|plain|none|closed': 'node=n1 pill=viewing n1 prevented',
  '[|plain|pane-button|closed': 'focus=body node=n1 pill=viewing n1 prevented',
  '[|Shift|none|closed': 'node=n1 pill=viewing n1 prevented',
  '[|Shift|pane-button|closed': 'focus=body node=n1 pill=viewing n1 prevented',
  '[|Alt|none|closed': 'node=n1 pill=viewing n1 prevented',
  '[|Alt|pane-button|closed': 'focus=body node=n1 pill=viewing n1 prevented',
  ']|plain|none|closed': 'node=n3 pill=viewing n3 prevented',
  ']|plain|pane-button|closed': 'focus=body node=n3 pill=viewing n3 prevented',
  ']|Shift|none|closed': 'node=n3 pill=viewing n3 prevented',
  ']|Shift|pane-button|closed': 'focus=body node=n3 pill=viewing n3 prevented',
  ']|Alt|none|closed': 'node=n3 pill=viewing n3 prevented',
  ']|Alt|pane-button|closed': 'focus=body node=n3 pill=viewing n3 prevented',
  '?|plain|none|closed': 'legend=false prevented',
  '?|plain|pane-button|closed': 'legend=false prevented',
  '?|Shift|none|closed': 'legend=false prevented',
  '?|Shift|pane-button|closed': 'legend=false prevented',
  '?|Alt|none|closed': 'legend=false prevented',
  '?|Alt|pane-button|closed': 'legend=false prevented',
  'Shift+/|plain|none|closed': 'legend=false prevented',
  'Shift+/|plain|pane-button|closed': 'legend=false prevented',
  'Shift+/|Shift|none|closed': 'legend=false prevented',
  'Shift+/|Shift|pane-button|closed': 'legend=false prevented',
  'Shift+/|Alt|none|closed': 'legend=false prevented',
  'Shift+/|Alt|pane-button|closed': 'legend=false prevented',
  '/|Shift|none|closed': 'legend=false prevented',
  '/|Shift|pane-button|closed': 'legend=false prevented',
  '⌘K|plain|none|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|plain|chrome-input|closed': 'palette=false prevented',
  '⌘K|plain|pane-input|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|plain|pane-button|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|Shift|none|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|Shift|chrome-input|closed': 'palette=false prevented',
  '⌘K|Shift|pane-input|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|Shift|pane-button|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|Alt|none|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|Alt|chrome-input|closed': 'palette=false prevented',
  '⌘K|Alt|pane-input|closed': 'focus=#cmd-input palette=false prevented',
  '⌘K|Alt|pane-button|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|plain|none|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|plain|chrome-input|closed': 'palette=false prevented',
  'Ctrl+K|plain|pane-input|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|plain|pane-button|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Shift|none|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Shift|chrome-input|closed': 'palette=false prevented',
  'Ctrl+K|Shift|pane-input|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Shift|pane-button|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Alt|none|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Alt|chrome-input|closed': 'palette=false prevented',
  'Ctrl+K|Alt|pane-input|closed': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Alt|pane-button|closed': 'focus=#cmd-input palette=false prevented',
  'q|plain|chrome-input|overlay': 'prevented',
  'q|plain|pane-input|overlay': 'prevented',
  'q|Shift|chrome-input|overlay': 'prevented',
  'q|Shift|pane-input|overlay': 'prevented',
  'q|Alt|chrome-input|overlay': 'prevented',
  'q|Alt|pane-input|overlay': 'prevented',
  'p|plain|chrome-input|overlay': 'prevented',
  'p|plain|pane-input|overlay': 'prevented',
  'p|Shift|chrome-input|overlay': 'prevented',
  'p|Shift|pane-input|overlay': 'prevented',
  'p|Alt|chrome-input|overlay': 'prevented',
  'p|Alt|pane-input|overlay': 'prevented',
  'g|plain|chrome-input|overlay': 'prevented',
  'g|plain|pane-input|overlay': 'prevented',
  'g|Shift|chrome-input|overlay': 'prevented',
  'g|Shift|pane-input|overlay': 'prevented',
  'g|Alt|chrome-input|overlay': 'prevented',
  'g|Alt|pane-input|overlay': 'prevented',
  'n|plain|chrome-input|overlay': 'prevented',
  'n|plain|pane-input|overlay': 'prevented',
  'n|Shift|chrome-input|overlay': 'prevented',
  'n|Shift|pane-input|overlay': 'prevented',
  'n|Alt|chrome-input|overlay': 'prevented',
  'n|Alt|pane-input|overlay': 'prevented',
  't|plain|chrome-input|overlay': 'prevented',
  't|plain|pane-input|overlay': 'prevented',
  't|Shift|chrome-input|overlay': 'prevented',
  't|Shift|pane-input|overlay': 'prevented',
  't|Alt|chrome-input|overlay': 'prevented',
  't|Alt|pane-input|overlay': 'prevented',
  's|plain|chrome-input|overlay': 'prevented',
  's|plain|pane-input|overlay': 'prevented',
  's|Shift|chrome-input|overlay': 'prevented',
  's|Shift|pane-input|overlay': 'prevented',
  's|Alt|chrome-input|overlay': 'prevented',
  's|Alt|pane-input|overlay': 'prevented',
  'r|plain|none|overlay': 'prevented',
  'r|plain|chrome-input|overlay': 'prevented',
  'r|plain|pane-input|overlay': 'prevented',
  'r|plain|pane-button|overlay': 'prevented',
  'r|Shift|none|overlay': 'prevented',
  'r|Shift|chrome-input|overlay': 'prevented',
  'r|Shift|pane-input|overlay': 'prevented',
  'r|Shift|pane-button|overlay': 'prevented',
  'r|Alt|chrome-input|overlay': 'prevented',
  'r|Alt|pane-input|overlay': 'prevented',
  'c|plain|chrome-input|overlay': 'prevented',
  'c|plain|pane-input|overlay': 'prevented',
  'c|Shift|chrome-input|overlay': 'prevented',
  'c|Shift|pane-input|overlay': 'prevented',
  'c|Alt|chrome-input|overlay': 'prevented',
  'c|Alt|pane-input|overlay': 'prevented',
  'm|plain|chrome-input|overlay': 'prevented',
  'm|plain|pane-input|overlay': 'prevented',
  'm|Shift|chrome-input|overlay': 'prevented',
  'm|Shift|pane-input|overlay': 'prevented',
  'm|Alt|chrome-input|overlay': 'prevented',
  'm|Alt|pane-input|overlay': 'prevented',
  'b|plain|none|overlay': 'prevented',
  'b|plain|chrome-input|overlay': 'prevented',
  'b|plain|pane-input|overlay': 'prevented',
  'b|plain|pane-button|overlay': 'prevented',
  'b|Shift|none|overlay': 'prevented',
  'b|Shift|chrome-input|overlay': 'prevented',
  'b|Shift|pane-input|overlay': 'prevented',
  'b|Shift|pane-button|overlay': 'prevented',
  'b|Alt|chrome-input|overlay': 'prevented',
  'b|Alt|pane-input|overlay': 'prevented',
  '[|plain|chrome-input|overlay': 'prevented',
  '[|plain|pane-input|overlay': 'prevented',
  '[|Shift|chrome-input|overlay': 'prevented',
  '[|Shift|pane-input|overlay': 'prevented',
  '[|Alt|chrome-input|overlay': 'prevented',
  '[|Alt|pane-input|overlay': 'prevented',
  ']|plain|chrome-input|overlay': 'prevented',
  ']|plain|pane-input|overlay': 'prevented',
  ']|Shift|chrome-input|overlay': 'prevented',
  ']|Shift|pane-input|overlay': 'prevented',
  ']|Alt|chrome-input|overlay': 'prevented',
  ']|Alt|pane-input|overlay': 'prevented',
  '?|plain|none|overlay': 'legend=false prevented',
  '?|plain|chrome-input|overlay': 'prevented',
  '?|plain|pane-input|overlay': 'prevented',
  '?|plain|pane-button|overlay': 'legend=false prevented',
  '?|Shift|none|overlay': 'legend=false prevented',
  '?|Shift|chrome-input|overlay': 'prevented',
  '?|Shift|pane-input|overlay': 'prevented',
  '?|Shift|pane-button|overlay': 'legend=false prevented',
  '?|Alt|none|overlay': 'legend=false prevented',
  '?|Alt|chrome-input|overlay': 'prevented',
  '?|Alt|pane-input|overlay': 'prevented',
  '?|Alt|pane-button|overlay': 'legend=false prevented',
  'Shift+/|plain|none|overlay': 'legend=false prevented',
  'Shift+/|plain|chrome-input|overlay': 'prevented',
  'Shift+/|plain|pane-input|overlay': 'prevented',
  'Shift+/|plain|pane-button|overlay': 'legend=false prevented',
  'Shift+/|Shift|none|overlay': 'legend=false prevented',
  'Shift+/|Shift|chrome-input|overlay': 'prevented',
  'Shift+/|Shift|pane-input|overlay': 'prevented',
  'Shift+/|Shift|pane-button|overlay': 'legend=false prevented',
  'Shift+/|Alt|none|overlay': 'legend=false prevented',
  'Shift+/|Alt|chrome-input|overlay': 'prevented',
  'Shift+/|Alt|pane-input|overlay': 'prevented',
  'Shift+/|Alt|pane-button|overlay': 'legend=false prevented',
  '/|plain|chrome-input|overlay': 'prevented',
  '/|plain|pane-input|overlay': 'prevented',
  '/|Shift|none|overlay': 'legend=false prevented',
  '/|Shift|chrome-input|overlay': 'prevented',
  '/|Shift|pane-input|overlay': 'prevented',
  '/|Shift|pane-button|overlay': 'legend=false prevented',
  '/|Alt|chrome-input|overlay': 'prevented',
  '/|Alt|pane-input|overlay': 'prevented',
  '⌘K|plain|none|overlay': 'prevented',
  '⌘K|plain|chrome-input|overlay': 'prevented',
  '⌘K|plain|pane-input|overlay': 'prevented',
  '⌘K|plain|pane-button|overlay': 'prevented',
  '⌘K|Shift|none|overlay': 'prevented',
  '⌘K|Shift|chrome-input|overlay': 'prevented',
  '⌘K|Shift|pane-input|overlay': 'prevented',
  '⌘K|Shift|pane-button|overlay': 'prevented',
  '⌘K|Alt|none|overlay': 'prevented',
  '⌘K|Alt|chrome-input|overlay': 'prevented',
  '⌘K|Alt|pane-input|overlay': 'prevented',
  '⌘K|Alt|pane-button|overlay': 'prevented',
  'Ctrl+K|plain|none|overlay': 'prevented',
  'Ctrl+K|plain|chrome-input|overlay': 'prevented',
  'Ctrl+K|plain|pane-input|overlay': 'prevented',
  'Ctrl+K|plain|pane-button|overlay': 'prevented',
  'Ctrl+K|Shift|none|overlay': 'prevented',
  'Ctrl+K|Shift|chrome-input|overlay': 'prevented',
  'Ctrl+K|Shift|pane-input|overlay': 'prevented',
  'Ctrl+K|Shift|pane-button|overlay': 'prevented',
  'Ctrl+K|Alt|none|overlay': 'prevented',
  'Ctrl+K|Alt|chrome-input|overlay': 'prevented',
  'Ctrl+K|Alt|pane-input|overlay': 'prevented',
  'Ctrl+K|Alt|pane-button|overlay': 'prevented',
  'q|plain|none|float': 'prevented rail=rail open',
  'q|plain|pane-button|float': 'prevented rail=rail open',
  'q|Shift|none|float': 'prevented rail=rail open',
  'q|Shift|pane-button|float': 'prevented rail=rail open',
  'q|Alt|none|float': 'prevented rail=rail open',
  'q|Alt|pane-button|float': 'prevented rail=rail open',
  'p|plain|none|float': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|plain|pane-button|float': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Shift|none|float': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Shift|pane-button|float': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Alt|none|float': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Alt|pane-button|float': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'g|plain|none|float': 'focus=#overlay overlay=false prevented',
  'g|plain|pane-button|float': 'focus=#overlay overlay=false prevented',
  'g|Shift|none|float': 'focus=#overlay overlay=false prevented',
  'g|Shift|pane-button|float': 'focus=#overlay overlay=false prevented',
  'g|Alt|none|float': 'focus=#overlay overlay=false prevented',
  'g|Alt|pane-button|float': 'focus=#overlay overlay=false prevented',
  'n|plain|none|float': 'drawer=false focus=button prevented',
  'n|plain|pane-button|float': 'drawer=false focus=button prevented',
  'n|Shift|none|float': 'drawer=false focus=button prevented',
  'n|Shift|pane-button|float': 'drawer=false focus=button prevented',
  'n|Alt|none|float': 'drawer=false focus=button prevented',
  'n|Alt|pane-button|float': 'drawer=false focus=button prevented',
  't|plain|none|float': 'prevented theme=dark',
  't|plain|pane-button|float': 'prevented theme=dark',
  't|Shift|none|float': 'prevented theme=dark',
  't|Shift|pane-button|float': 'prevented theme=dark',
  't|Alt|none|float': 'prevented theme=dark',
  't|Alt|pane-button|float': 'prevented theme=dark',
  's|plain|none|float': 'prevented sessions=false',
  's|plain|pane-button|float': 'prevented sessions=false',
  's|Shift|none|float': 'prevented sessions=false',
  's|Shift|pane-button|float': 'prevented sessions=false',
  's|Alt|none|float': 'prevented sessions=false',
  's|Alt|pane-button|float': 'prevented sessions=false',
  'r|plain|none|float': 'prevented replay=false',
  'r|plain|pane-button|float': 'prevented replay=false',
  'r|Shift|none|float': 'prevented replay=false',
  'r|Shift|pane-button|float': 'prevented replay=false',
  'r|Alt|none|float': 'prevented replay=false',
  'r|Alt|pane-button|float': 'prevented replay=false',
  'c|plain|none|float': 'pinMode=true prevented',
  'c|plain|pane-button|float': 'pinMode=true prevented',
  'c|Shift|none|float': 'pinMode=true prevented',
  'c|Shift|pane-button|float': 'pinMode=true prevented',
  'c|Alt|none|float': 'pinMode=true prevented',
  'c|Alt|pane-button|float': 'pinMode=true prevented',
  'b|plain|none|float': 'bookmark=false focus=#bookmark-name prevented',
  'b|plain|pane-button|float': 'bookmark=false focus=#bookmark-name prevented',
  'b|Shift|none|float': 'bookmark=false focus=#bookmark-name prevented',
  'b|Shift|pane-button|float': 'bookmark=false focus=#bookmark-name prevented',
  'b|Alt|none|float': 'bookmark=false focus=#bookmark-name prevented',
  'b|Alt|pane-button|float': 'bookmark=false focus=#bookmark-name prevented',
  '[|plain|none|float': 'node=n1 pill=viewing n1 prevented',
  '[|plain|pane-button|float': 'focus=body node=n1 pill=viewing n1 prevented',
  '[|Shift|none|float': 'node=n1 pill=viewing n1 prevented',
  '[|Shift|pane-button|float': 'focus=body node=n1 pill=viewing n1 prevented',
  '[|Alt|none|float': 'node=n1 pill=viewing n1 prevented',
  '[|Alt|pane-button|float': 'focus=body node=n1 pill=viewing n1 prevented',
  ']|plain|none|float': 'node=n3 pill=viewing n3 prevented',
  ']|plain|pane-button|float': 'focus=body node=n3 pill=viewing n3 prevented',
  ']|Shift|none|float': 'node=n3 pill=viewing n3 prevented',
  ']|Shift|pane-button|float': 'focus=body node=n3 pill=viewing n3 prevented',
  ']|Alt|none|float': 'node=n3 pill=viewing n3 prevented',
  ']|Alt|pane-button|float': 'focus=body node=n3 pill=viewing n3 prevented',
  '?|plain|none|float': 'legend=false prevented',
  '?|plain|pane-button|float': 'legend=false prevented',
  '?|Shift|none|float': 'legend=false prevented',
  '?|Shift|pane-button|float': 'legend=false prevented',
  '?|Alt|none|float': 'legend=false prevented',
  '?|Alt|pane-button|float': 'legend=false prevented',
  'Shift+/|plain|none|float': 'legend=false prevented',
  'Shift+/|plain|pane-button|float': 'legend=false prevented',
  'Shift+/|Shift|none|float': 'legend=false prevented',
  'Shift+/|Shift|pane-button|float': 'legend=false prevented',
  'Shift+/|Alt|none|float': 'legend=false prevented',
  'Shift+/|Alt|pane-button|float': 'legend=false prevented',
  '/|Shift|none|float': 'legend=false prevented',
  '/|Shift|pane-button|float': 'legend=false prevented',
  '⌘K|plain|none|float': 'prevented',
  '⌘K|plain|chrome-input|float': 'prevented',
  '⌘K|plain|pane-input|float': 'prevented',
  '⌘K|plain|pane-button|float': 'prevented',
  '⌘K|Shift|none|float': 'prevented',
  '⌘K|Shift|chrome-input|float': 'prevented',
  '⌘K|Shift|pane-input|float': 'prevented',
  '⌘K|Shift|pane-button|float': 'prevented',
  '⌘K|Alt|none|float': 'prevented',
  '⌘K|Alt|chrome-input|float': 'prevented',
  '⌘K|Alt|pane-input|float': 'prevented',
  '⌘K|Alt|pane-button|float': 'prevented',
  'Ctrl+K|plain|none|float': 'prevented',
  'Ctrl+K|plain|chrome-input|float': 'prevented',
  'Ctrl+K|plain|pane-input|float': 'prevented',
  'Ctrl+K|plain|pane-button|float': 'prevented',
  'Ctrl+K|Shift|none|float': 'prevented',
  'Ctrl+K|Shift|chrome-input|float': 'prevented',
  'Ctrl+K|Shift|pane-input|float': 'prevented',
  'Ctrl+K|Shift|pane-button|float': 'prevented',
  'Ctrl+K|Alt|none|float': 'prevented',
  'Ctrl+K|Alt|chrome-input|float': 'prevented',
  'Ctrl+K|Alt|pane-input|float': 'prevented',
  'Ctrl+K|Alt|pane-button|float': 'prevented',
  'q|plain|pane-button|replay': 'prevented rail=rail open',
  'q|Shift|pane-button|replay': 'prevented rail=rail open',
  'q|Alt|none|replay': 'prevented rail=rail open',
  'q|Alt|pane-button|replay': 'prevented rail=rail open',
  'p|plain|pane-button|replay': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Shift|pane-button|replay': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Alt|none|replay': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'p|Alt|pane-button|replay': 'POST /api/queue/push prevented rail=rail open railAdd=',
  'g|plain|pane-button|replay': 'focus=#overlay overlay=false prevented',
  'g|Shift|pane-button|replay': 'focus=#overlay overlay=false prevented',
  'g|Alt|none|replay': 'focus=#overlay overlay=false prevented replay=true',
  'g|Alt|pane-button|replay': 'focus=#overlay overlay=false prevented',
  'n|plain|pane-button|replay': 'drawer=false focus=button prevented',
  'n|Shift|pane-button|replay': 'drawer=false focus=button prevented',
  'n|Alt|none|replay': 'drawer=false focus=button prevented replay=true',
  'n|Alt|pane-button|replay': 'drawer=false focus=button prevented',
  't|plain|pane-button|replay': 'prevented theme=dark',
  't|Shift|pane-button|replay': 'prevented theme=dark',
  't|Alt|none|replay': 'prevented theme=dark',
  't|Alt|pane-button|replay': 'prevented theme=dark',
  's|plain|pane-button|replay': 'prevented sessions=false',
  's|Shift|pane-button|replay': 'prevented sessions=false',
  's|Alt|none|replay': 'prevented replay=true sessions=false',
  's|Alt|pane-button|replay': 'prevented sessions=false',
  'r|plain|pane-button|replay': 'prevented replay=false',
  'r|Shift|pane-button|replay': 'prevented replay=false',
  'r|Alt|none|replay': 'prevented',
  'r|Alt|pane-button|replay': 'prevented replay=false',
  'c|plain|pane-button|replay': 'pinMode=true prevented',
  'c|Shift|pane-button|replay': 'pinMode=true prevented',
  'c|Alt|none|replay': 'pinMode=true prevented',
  'c|Alt|pane-button|replay': 'pinMode=true prevented',
  'm|plain|pane-button|replay': 'chat=false focus=#chat-stream prevented',
  'm|Shift|pane-button|replay': 'chat=false focus=#chat-stream prevented',
  'm|Alt|pane-button|replay': 'chat=false focus=#chat-stream prevented',
  'b|plain|pane-button|replay': 'bookmark=false focus=#bookmark-name prevented',
  'b|Shift|pane-button|replay': 'bookmark=false focus=#bookmark-name prevented',
  'b|Alt|none|replay': 'bookmark=false focus=#bookmark-name prevented replay=true',
  'b|Alt|pane-button|replay': 'bookmark=false focus=#bookmark-name prevented',
  '[|plain|pane-button|replay': 'focus=body node=n1 pill=viewing n1 prevented',
  '[|Shift|pane-button|replay': 'focus=body node=n1 pill=viewing n1 prevented',
  '[|Alt|none|replay': 'node=n1 pill=viewing n1 prevented',
  '[|Alt|pane-button|replay': 'focus=body node=n1 pill=viewing n1 prevented',
  ']|plain|pane-button|replay': 'focus=body node=n3 pill=viewing n3 prevented',
  ']|Shift|pane-button|replay': 'focus=body node=n3 pill=viewing n3 prevented',
  ']|Alt|none|replay': 'node=n3 pill=viewing n3 prevented',
  ']|Alt|pane-button|replay': 'focus=body node=n3 pill=viewing n3 prevented',
  '?|plain|pane-button|replay': 'legend=false prevented',
  '?|Shift|pane-button|replay': 'legend=false prevented',
  '?|Alt|none|replay': 'legend=false prevented replay=true',
  '?|Alt|pane-button|replay': 'legend=false prevented',
  'Shift+/|plain|pane-button|replay': 'legend=false prevented',
  'Shift+/|Shift|pane-button|replay': 'legend=false prevented',
  'Shift+/|Alt|none|replay': 'legend=false prevented replay=true',
  'Shift+/|Alt|pane-button|replay': 'legend=false prevented',
  '/|Shift|pane-button|replay': 'legend=false prevented',
  '⌘K|plain|none|replay': 'prevented',
  '⌘K|plain|chrome-input|replay': 'palette=false prevented',
  '⌘K|plain|pane-input|replay': 'focus=#cmd-input palette=false prevented',
  '⌘K|plain|pane-button|replay': 'focus=#cmd-input palette=false prevented',
  '⌘K|Shift|none|replay': 'prevented',
  '⌘K|Shift|chrome-input|replay': 'palette=false prevented',
  '⌘K|Shift|pane-input|replay': 'focus=#cmd-input palette=false prevented',
  '⌘K|Shift|pane-button|replay': 'focus=#cmd-input palette=false prevented',
  '⌘K|Alt|none|replay': 'prevented',
  '⌘K|Alt|chrome-input|replay': 'palette=false prevented',
  '⌘K|Alt|pane-input|replay': 'focus=#cmd-input palette=false prevented',
  '⌘K|Alt|pane-button|replay': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|plain|none|replay': 'prevented',
  'Ctrl+K|plain|chrome-input|replay': 'palette=false prevented',
  'Ctrl+K|plain|pane-input|replay': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|plain|pane-button|replay': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Shift|none|replay': 'prevented',
  'Ctrl+K|Shift|chrome-input|replay': 'palette=false prevented',
  'Ctrl+K|Shift|pane-input|replay': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Shift|pane-button|replay': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Alt|none|replay': 'prevented',
  'Ctrl+K|Alt|chrome-input|replay': 'palette=false prevented',
  'Ctrl+K|Alt|pane-input|replay': 'focus=#cmd-input palette=false prevented',
  'Ctrl+K|Alt|pane-button|replay': 'focus=#cmd-input palette=false prevented',
});

const RECORD = process.env.WEB_CHAT_HOTKEYS_RECORD;

test('the matrix covers every key × modifier × focus × layer it was recorded over', () => {
  assert.equal(KEYS.length * Object.keys(MODS).length * Object.keys(FOCUS).length * Object.keys(LAYERS).length, CASES);
});
const recorded = {};

for (const layer of Object.keys(LAYERS)) {
  test(`the key matrix, ${layer}: every press does what it did at the branch base`, { timeout: 120000 }, async () => {
    if (!baseline) { await reset(); baseline = snap(); }
    const seen = await record(layer);
    if (RECORD) { Object.assign(recorded, seen); return; }
    assert.ok(MATRIX, 'the frozen table is present');
    const want = Object.fromEntries(Object.entries(MATRIX).filter(([k]) => k.endsWith(`|${layer}`)));
    assert.deepEqual(seen, want);
  });
}

if (RECORD) {
  test('write the recorded matrix', () => {
    const cases = KEYS.length * Object.keys(MODS).length * Object.keys(FOCUS).length * Object.keys(LAYERS).length;
    fs.writeFileSync(RECORD, JSON.stringify({ cases, baseline, matrix: recorded }, null, 2) + '\n');
  });
}

// ── what is drawn from the table ─────────────────────────────────────────────

// The legend's rows exactly as index.html carried them by hand at the branch
// base (public/index.html :428-451 at f7d4b03): the oracle the generated legend
// equals byte for byte under the default bindings. One row added since, by a
// granted edit: U404's last-tool key (F.4, 'tools.last', Space), after the
// tools' rows.
const LEGEND_ROWS = [
  '<h3>Keyboard</h3>',
  '<div class="legend-row"><span>Command palette</span><span class="keys"><kbd>⌘K</kbd></span></div>',
  '<div class="legend-row"><span>Open graph</span><span class="keys"><kbd>G</kbd></span></div>',
  '<div class="legend-row"><span>Blocks · packs</span><span class="keys"><kbd>N</kbd></span></div>',
  '<div class="legend-row"><span>Bookmark node</span><span class="keys"><kbd>B</kbd></span></div>',
  '<div class="legend-row"><span>Replay to node</span><span class="keys"><kbd>R</kbd></span></div>',
  '<div class="legend-row"><span>Pin comment</span><span class="keys"><kbd>C</kbd></span></div>',
  '<div class="legend-row"><span>Put down / pick up the last tool</span><span class="keys"><kbd>Space</kbd></span></div>',
  '<div class="legend-row"><span>Previous / next node</span><span class="keys"><kbd>[</kbd><kbd>]</kbd></span></div>',
  '<div class="legend-row"><span>Toggle queue rail</span><span class="keys"><kbd>Q</kbd></span></div>',
  '<div class="legend-row"><span>Push queue → Claude</span><span class="keys"><kbd>P</kbd></span></div>',
  '<div class="legend-row"><span>Chat with Claude</span><span class="keys"><kbd>M</kbd></span></div>',
  '<div class="legend-row"><span>Sessions on this computer</span><span class="keys"><kbd>S</kbd></span></div>',
  '<div class="legend-row"><span>Light / dark</span><span class="keys"><kbd>T</kbd></span></div>',
  '<div class="legend-row"><span>Replay: play · step</span><span class="keys"><kbd>Space</kbd><kbd>←</kbd><kbd>→</kbd></span></div>',
  '<div class="legend-row"><span>Shortcuts · close</span><span class="keys"><kbd>?</kbd><kbd>Esc</kbd></span></div>',
  '<h3 class="legend-sub">In the graph</h3>',
  '<div class="legend-row"><span>Select node</span><span class="keys"><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd></span></div>',
  '<div class="legend-row"><span>Glance preview</span><span class="keys"><kbd>Space</kbd></span></div>',
  '<div class="legend-row"><span>Open node</span><span class="keys"><kbd>↵</kbd></span></div>',
  '<div class="legend-row"><span>Set active</span><span class="keys"><kbd>A</kbd></span></div>',
  '<div class="legend-row"><span>Export node</span><span class="keys"><kbd>E</kbd></span></div>',
  '<div class="legend-row"><span>Bookmark node</span><span class="keys"><kbd>B</kbd></span></div>',
  '<div class="legend-row"><span>Replay to node</span><span class="keys"><kbd>R</kbd></span></div>',
  '<div class="legend-row"><span>Deselect · close graph</span><span class="keys"><kbd>Esc</kbd></span></div>',
];
const LEGEND_HTML = '\n      <div class="legend-card" role="dialog" aria-label="Keyboard shortcuts">'
  + LEGEND_ROWS.map((r) => `\n        ${r}`).join('') + '\n      </div>\n    ';

// The palette's command rows and their key column at the branch base.
const PALETTE = [
  { label: 'Add a block…', key: 'N' },
  { label: 'Component packs…', key: '' },
  { label: 'Open graph', key: 'G' },
  { label: 'New graph', key: '' },
  { label: 'Wipe surface', key: '' },
  { label: 'Export node', key: '' },
  { label: 'Replay to n2', key: 'R' },
  { label: 'Toggle light / dark', key: 'T' },
  { label: 'Pin comment', key: 'C' },
  { label: 'Settings', key: '' },
  { label: 'Sessions…', key: 'S' },
  { label: 'Chat with Claude', key: 'M' },
  { label: 'Reset the chat window', key: '' },
  { label: 'Set up remote access…', key: '' },
];

// Every keyed title, aria-label, aria-keyshortcuts and <kbd> at the branch base,
// as the booted chrome shows them.
const TITLES = {
  'cmd-trigger': { title: 'Command palette (⌘K)', aria: 'Search commands, nodes, blocks (Cmd K)', kbd: '⌘K' },
  // drawer.js's copy of index.html's, with the library's count.
  'btn-add': { title: 'Blocks — add from the library, manage packs · N · 0 in the library',
    aria: 'Blocks — add from the library, manage packs (N), 0 in the library' },
  'btn-bookmark': { title: 'Bookmark node · B', aria: 'Bookmark node (B)' },
  // (#btn-pin-mode, ✎, retired onto the toolbar's comment slot in U338: the
  // slot's title and aria-label carry the bound key — test/toolbar-gui.test.js.)
  'btn-up': { title: 'Previous node · [', aria: 'Previous node ([)' },
  'btn-down': { title: 'Next node · ]', aria: 'Next node (])' },
  'btn-theme-toggle': { title: 'Light / dark · T', aria: 'Toggle light / dark (T)' },
  'btn-graph': { title: 'View graph · G', aria: null, kbd: 'G' },
  'cs-step': { ks: 'M' },
};
function titles() {
  const out = {};
  for (const id of Object.keys(TITLES)) {
    const el = $(id);
    if (id === 'cs-step') { out[id] = { ks: el.getAttribute('aria-keyshortcuts') }; continue; }
    const kbd = el.querySelector(':scope > kbd');
    out[id] = { title: el.getAttribute('title'), aria: el.getAttribute('aria-label'), ...(kbd ? { kbd: kbd.textContent } : {}) };
  }
  return out;
}

async function paletteRows() {
  shell.key('k', { metaKey: true });
  await shell.tick();
  const rows = [...$('cmd-list').querySelectorAll('.palette-item')].filter((r) => r.dataset.kind === 'command')
    .map((r) => { const k = r.querySelector('kbd.hint'); return { label: r.querySelector('.label').textContent, key: k ? k.textContent : '' }; });
  shellMod.handleEscape();
  await shell.tick();
  return rows;
}

async function toolbarFrame(user = {}, project = {}) {
  await shell.frame({ type: 'toolbar', v: 1, project: { v: 1, pinned: [], hidden: [], settings: {}, profiles: {}, ...project },
    user: { v: 1, bindings: {}, fingerDraws: false, settings: {}, ...user }, merged: { bindings: {}, settings: {} } });
}

test('the legend is drawn from the table: byte for byte the head\'s rows under the default bindings', async () => {
  await reset();
  assert.equal($('key-legend').innerHTML, LEGEND_HTML);
  assert.equal($('key-legend').querySelectorAll('[id]').length, 0, 'no ids');
});

test('the palette\'s key column comes from the table: the head\'s letters under the default bindings', async () => {
  await reset();
  assert.deepEqual(await paletteRows(), PALETTE);
});

test('the keyed titles, aria-labels and <kbd>s are the head\'s under the default bindings', async () => {
  // Opening the drawer once gives ＋ drawer.js's title (with the library's count).
  drawer.openDrawer();
  await shell.tick();
  await reset();
  assert.deepEqual(titles(), TITLES);
});

test('a single key never fires in a text field: C typed into a pane <textarea> is the textarea\'s', async (t) => {
  await reset();
  const ta = W.document.createElement('textarea');
  pane.host.shadowRoot.appendChild(ta);
  t.after(() => ta.remove());
  ta.focus();
  const e = shell.key('c', { target: ta });
  await shell.tick();
  assert.equal(e.defaultPrevented, false, 'the character goes into the field');
  assert.equal(W.document.body.classList.contains('pin-mode'), false, 'pin mode stays off');
});

// ── the last-tool key (U404; F.4, REQ@tool-toggle-key M1) ────────────────────
// Space puts the armed tool down and picks the last one up again — a chrome
// action ('tools.last') on the registry; Space is not on the matrix's axes,
// which stay as recorded. A focused control and a field keep Space's native
// meaning (the shell prevents nothing); the graph overlay keeps its glance.
async function lastToolCase(t) {
  await reset();
  const ov = await shell.importApp('overlay.js');
  const tools = await shell.importApp('tools.js');
  t.after(async () => { tools.disarm(); await reset(); });
  tools.disarm();
  shell.key('c');   // comment's arm key: the comment tool armed, then the last tool
  await shell.tick();
  assert.deepEqual(ov.armed(), { type: 'comment', profile: null }, 'precondition: the comment tool armed');
  return { ov, tools };
}
const pinMode = () => W.document.body.classList.contains('pin-mode');

test('Space with nothing focused puts the comment tool down and picks it up again, its default prevented', async (t) => {
  const { ov } = await lastToolCase(t);
  blur();
  let e = shell.key(' ');
  await shell.tick();
  assert.equal(e.defaultPrevented, true, 'the page does not scroll');
  assert.equal(ov.armed(), null, 'put down');
  assert.equal(pinMode(), false);
  e = shell.key(' ');
  await shell.tick();
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(ov.armed(), { type: 'comment', profile: null }, 'picked up again');
  assert.equal(pinMode(), true);
  // #stage (focused by a click on the page) is no control.
  $('stage').focus();
  e = shell.key(' ', { target: $('stage') });
  await shell.tick();
  assert.equal(e.defaultPrevented, true);
  assert.equal(ov.armed(), null, 'from #stage too');
});

test('Space on a focused pane button, a chrome button or a chrome checkbox is the control\'s: no toggle, nothing prevented', async (t) => {
  const { ov } = await lastToolCase(t);
  const btn = W.document.createElement('button');
  btn.textContent = 'a chrome button';
  const box = W.document.createElement('input');
  box.type = 'checkbox';
  $('topbar').append(btn, box);
  t.after(() => { btn.remove(); box.remove(); });
  for (const [name, el] of [['a pane button', pane.button], ['a chrome button', btn], ['a chrome checkbox', box]]) {
    blur();
    el.focus();
    const e = shell.key(' ', { target: el });
    await shell.tick();
    assert.equal(e.defaultPrevented, false, `${name}: Space keeps its native meaning`);
    assert.deepEqual(ov.armed(), { type: 'comment', profile: null }, `${name}: the tool stays armed`);
  }
});

test('Space typed into a pane <textarea> is the textarea\'s', async (t) => {
  const { ov } = await lastToolCase(t);
  const ta = W.document.createElement('textarea');
  pane.host.shadowRoot.appendChild(ta);
  t.after(() => ta.remove());
  ta.focus();
  const e = shell.key(' ', { target: ta });
  await shell.tick();
  assert.equal(e.defaultPrevented, false, 'the space goes into the field');
  assert.deepEqual(ov.armed(), { type: 'comment', profile: null });
});

test('Space with the graph overlay open toggles the glance, not the tool', async (t) => {
  const { ov } = await lastToolCase(t);
  gv.openOverlay();
  await shell.tick(5);
  const node = W.document.querySelector('#graph-svg g[data-id], #gv-world .gv-srow[data-id]');
  assert.ok(node, 'precondition: the graph drew a node');
  node.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await shell.tick(5);
  assert.equal(gv.hasFloatPreview(), false);
  blur();
  const e = shell.key(' ');
  await shell.tick(5);
  assert.equal(e.defaultPrevented, true);
  assert.equal(gv.hasFloatPreview(), true, 'the glance is up');
  assert.deepEqual(ov.armed(), { type: 'comment', profile: null }, 'the tool is as it was');
  gv.toggleFloatPreview();
});

test('⌘K from a chrome field still opens the palette', async (t) => {
  await reset();
  const inp = W.document.createElement('input');
  $('topbar').appendChild(inp);
  t.after(() => inp.remove());
  inp.focus();
  const e = shell.key('k', { target: inp, metaKey: true });
  await shell.tick();
  assert.ok(e.defaultPrevented);
  assert.ok(!$('cmd-palette').classList.contains('hidden'), 'the palette opened');
  await reset();
});

test('a user-tier rebinding: R → Shift+R, G → H and [ → Shift+[ move the keys, the legend, the palette and the titles', async () => {
  await reset();
  await toolbarFrame({ bindings: {
    R: null, 'Shift+R': { kind: 'chrome', action: 'chrome.replay' },
    G: null, H: { kind: 'chrome', action: 'chrome.graph' },
    '[': null, 'Shift+[': { kind: 'chrome', action: 'chrome.prev' },
    N: null, J: { kind: 'chrome', action: 'chrome.add' },
    M: null, 'Shift+M': { kind: 'chrome', action: 'chrome.chat' },
  } });
  const rowKeys = (section, label) => {
    let sec = null;
    for (const n of $('key-legend').querySelector('.legend-card').children) {
      if (n.tagName === 'H3') { sec = n.textContent; continue; }
      if (sec === section && n.querySelector('span').textContent === label) return [...n.querySelectorAll('kbd')].map((k) => k.textContent);
    }
    return null;
  };
  assert.deepEqual(rowKeys('Keyboard', 'Replay to node'), ['⇧R']);
  assert.deepEqual(rowKeys('Keyboard', 'Open graph'), ['H']);
  assert.deepEqual(rowKeys('Keyboard', 'Previous / next node'), ['⇧[', ']']);
  assert.deepEqual(rowKeys('In the graph', 'Replay to node'), ['R'], 'the overlay\'s own R is its own');
  const want = { ...TITLES,
    'btn-graph': { title: 'View graph · H', aria: null, kbd: 'H' },
    'btn-up': { title: 'Previous node · ⇧[', aria: 'Previous node (⇧[)' },
    'btn-add': { title: 'Blocks — add from the library, manage packs · J · 0 in the library',
      aria: 'Blocks — add from the library, manage packs (J), 0 in the library' },
    'cs-step': { ks: 'Shift+M' } };
  assert.deepEqual(titles(), want);
  // An owner that rewrites its title with the shipped key (drawer.js on a new
  // library count) is put back on the bound one.
  $('btn-add').title = 'Blocks — add from the library, manage packs · N · 4 in the library';
  await shell.tick();
  assert.equal($('btn-add').title, 'Blocks — add from the library, manage packs · J · 4 in the library');
  $('btn-add').title = want['btn-add'].title;
  await shell.tick();
  const pal = await paletteRows();
  assert.equal(pal.find((r) => r.label === 'Replay to n2').key, '⇧R');
  assert.equal(pal.find((r) => r.label === 'Open graph').key, 'H');

  // …and the keys themselves.
  let e = shell.key('r');
  await shell.tick();
  assert.equal(e.defaultPrevented, false, 'R is no longer bound');
  assert.ok($('replay-pop').classList.contains('hidden'));
  e = shell.key('R', { shiftKey: true });
  await shell.tick();
  assert.ok(e.defaultPrevented);
  assert.ok(!$('replay-pop').classList.contains('hidden'), 'Shift+R opens the replay');
  await reset();
  e = shell.key('g');
  await shell.tick();
  assert.ok($('overlay').classList.contains('hidden'), 'G is unbound');
  shell.key('h');
  await shell.tick();
  assert.ok(!$('overlay').classList.contains('hidden'), 'H opens the graph');
  await reset();

  // Back to the defaults: everything as the head drew it.
  await toolbarFrame();
  assert.equal($('key-legend').innerHTML, LEGEND_HTML);
  assert.deepEqual(titles(), TITLES);
  assert.deepEqual(await paletteRows(), PALETTE);
});

test('a project-tier unbind of G: no key opens the graph here, and nothing names one', async () => {
  await reset();
  await toolbarFrame({}, { bindings: { G: null, B: null } });
  shell.key('g');
  await shell.tick();
  assert.ok($('overlay').classList.contains('hidden'), 'G does nothing in this project');
  assert.equal($('btn-graph').getAttribute('title'), 'View graph');
  // An unbound key leaves the title and the aria-label with no key in them,
  // and no stray space where the ' · B' and the ' (B)' were.
  assert.equal($('btn-bookmark').getAttribute('title'), 'Bookmark node');
  assert.equal($('btn-bookmark').getAttribute('aria-label'), 'Bookmark node');
  assert.equal($('btn-graph').querySelector('kbd').hidden, true);
  assert.ok(![...$('key-legend').querySelectorAll('.legend-row span:first-child')].some((s) => s.textContent === 'Open graph'),
    'the legend has no row for a key that is not bound');
  await toolbarFrame();
  assert.deepEqual(titles(), TITLES);
  assert.equal($('btn-graph').querySelector('kbd').hidden, false);
  assert.equal($('key-legend').innerHTML, LEGEND_HTML);
});

test('the user record\'s finger-draws default reaches the input-mode policy (main.js)', async () => {
  const im = await shell.importApp('input-mode.js');
  await toolbarFrame({ fingerDraws: true });
  assert.equal(im.fingerDrawsMode().recordDefault, true);
  await toolbarFrame({ fingerDraws: false });
  assert.equal(im.fingerDrawsMode().recordDefault, false);
});

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

const MATRIX = null;

const RECORD = process.env.WEB_CHAT_HOTKEYS_RECORD;
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

// The chat dock inside the shell's ONE dismiss and keyboard engine
// (public/app/shell.js): design spec §7.8 and U34's brief.
//
//   * Docks. An open `[data-dismiss-zone]` element closes on the shell's
//     capture-phase pointerdown when the press lies inside a zone it names —
//     the page well or the contents nav, a pane's shadow root included — and in
//     no other case: the queue rail, the topbar, the status bar, the dock itself
//     and every popover leave it open; focus moving out, a window blur and
//     another panel opening never close it; a window-mode dock (no attribute)
//     never closes on an outside press.
//   * Escape, one layer per press: a popover (the bar's "Under development"
//     note), the pinned rail and pin mode each take a press of their own before
//     the chat's (chat-slots escapeChatViews: an addEscapeStep layer, then the
//     drawer, or a window that holds focus).
//   * M emits chat:open {view: 'chat', focus: 'composer'}, and is inert under the
//     graph overlay, a float preview, the replay player and in a field.
//   * ⌘K: 'Chat with Claude' (M), 'Reset the chat window', and 'Background
//     tasks' while #cs-chips holds a button; the legend's 'Chat with Claude' row.
//
// main.js does not call initChatDock yet (U40 wires it), so the boot's init
// does, as main.js will.
const test = require('node:test');
const { before, after, afterEach } = test;
const assert = require('node:assert');
const { bootShell } = require('../test-support/chrome-shell');

let shell, W, $, bus, dock, bar;

before(async () => {
  shell = await bootShell({
    init: async (s) => {
      const d = await s.importApp('chat-dock.js');
      d.initChatDock();
    },
  });
  W = shell.window;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  dock = await shell.importApp('chat-dock.js');
  bar = await shell.importApp('chat-bar.js');
});
after(() => shell.restore());

afterEach(async () => {
  shell.key('Escape');                     // any popover, pinned rail or pin mode…
  shell.key('Escape');
  dock.closeChat({ returnFocus: false }); // …and the dock, whatever is left
  dock.resetChatWindow();
  if (W.document.activeElement && W.document.activeElement.blur) W.document.activeElement.blur();
  await shell.tick();
});

const el = () => $('chat-dock');
const isOpen = () => !el().classList.contains('hidden');
const open = async () => { bus.emit('chat:open', { view: 'chat', focus: 'composer' }); await shell.tick(); };
const q = (sel) => W.document.querySelector(sel);
const pointerdown = (target) => target.dispatchEvent(new W.PointerEvent('pointerdown',
  { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1 }));
const note = () => { const n = $('cs-tray'); return n && !n.classList.contains('hidden') ? n : null; };
const firstChip = () => $('cs-chips').querySelector('button');
const railPinnedOpen = () => $('queue-rail').classList.contains('open');
function listen(t, type) {
  const seen = [];
  t.after(bus.on(type, (d) => seen.push(d)));
  return seen;
}
// A pane: a shadow-rooted host on the page, with a control inside it.
function addPane(t) {
  const host = W.document.createElement('div');
  host.className = 'pane';
  const root = host.attachShadow({ mode: 'open' });
  const inner = W.document.createElement('button');
  inner.textContent = 'inside the pane';
  const input = W.document.createElement('input');
  root.append(inner, input);
  $('main').appendChild(host);
  t.after(() => host.remove());
  return { host, inner, input };
}
const detach = () => shell.click($('cd-strip').querySelector('.cd-detach'));

/* ------------------------------ docks ------------------------------ */

test('the drawer carries its zones, and is no transient panel', () => {
  assert.equal(el().getAttribute('data-dismiss-zone'), '#contents-nav, .well-wrap');
  assert.ok(!el().matches('.popover, .palette, .legend, .drawer'), 'the dock is in no OPEN_PANELS class');
});

test('a pointerdown on the page well closes the drawer', async () => {
  await open();
  assert.ok(isOpen(), 'precondition: the drawer is open');
  shell.press(q('.well-wrap'));
  assert.ok(!isOpen(), 'a press in .well-wrap closed it');
});

test('a pointerdown in the contents nav closes the drawer', async () => {
  await open();
  shell.press($('contents-nav'));
  assert.ok(!isOpen());
});

test('a pointerdown inside a pane\'s shadow root counts as the surface', async (t) => {
  const { inner } = addPane(t);
  await open();
  assert.equal(inner.closest('.well-wrap'), null, 'precondition: plain closest stops at the shadow boundary');
  pointerdown(inner);
  assert.ok(!isOpen(), 'the press inside the pane closed the drawer');
});

test('an outside close does not pull focus back to where it was', async (t) => {
  const { inner } = addPane(t);
  const back = $('btn-up') || $('cmd-trigger');
  back.focus();
  await open();
  W.document.activeElement.blur();
  pointerdown(inner);
  assert.ok(!isOpen());
  assert.notEqual(W.document.activeElement, back, 'closeChat ran with returnFocus: false');
});

for (const [what, target] of [
  ['the queue rail', () => $('queue-rail')],
  ['the topbar', () => $('topbar')],
  ['the status bar', () => $('chat-statusbar')],
  ['the inside of the dock', () => $('cd-body')],
  ['the dock\'s strip', () => $('cd-strip')],
]) {
  test(`a pointerdown on ${what} leaves the drawer open`, async () => {
    await open();
    shell.press(target());
    assert.ok(isOpen(), `${what} is not a dismiss zone`);
  });
}

test('a pointerdown inside a popover (the bar\'s note) leaves the drawer open', async () => {
  await open();
  shell.press(firstChip());              // the bar is no zone either
  assert.ok(isOpen(), 'pressing a chip left the drawer open');
  const n = note();
  assert.ok(n && n.classList.contains('popover'), 'precondition: the chip opened the bar\'s note, a .popover');
  shell.press(n);
  assert.ok(isOpen(), 'a press inside the popover left the drawer open');
  assert.ok(note(), 'and the popover itself');
});

test('another panel opening never closes the drawer', async () => {
  await open();
  const { openSettings } = await shell.importApp('shell.js');
  openSettings();
  await shell.tick();
  assert.ok(!$('settings-panel').classList.contains('hidden'), 'precondition: Settings opened');
  assert.ok(isOpen(), 'the drawer survived it');
  shell.key('?');
  assert.ok(!$('key-legend').classList.contains('hidden'), 'precondition: the legend opened');
  assert.ok(isOpen(), 'and the legend too');
});

test('focus moving out and a window blur never close the drawer', async (t) => {
  const { inner } = addPane(t);
  await open();
  inner.dispatchEvent(new W.FocusEvent('focusin', { bubbles: true, composed: true }));
  $('topbar').dispatchEvent(new W.FocusEvent('focusin', { bubbles: true, composed: true }));
  assert.ok(isOpen(), 'focus leaving for the page or the topbar left it open');
  W.dispatchEvent(new W.Event('blur'));
  await shell.tick();
  assert.ok(isOpen(), 'a window blur left it open');
});

test('a window-mode dock never closes on an outside pointerdown', async (t) => {
  const { inner } = addPane(t);
  await open();
  detach();
  assert.equal(el().dataset.mode, 'window', 'precondition: detached');
  assert.equal(el().hasAttribute('data-dismiss-zone'), false, 'the window carries no zone');
  shell.press(q('.well-wrap'));
  shell.press($('contents-nav'));
  pointerdown(inner);
  assert.ok(isOpen(), 'no outside press closes a window');
});

test('only an open dock is closed: a hidden one is left as it is', async () => {
  assert.ok(!isOpen());
  const hadZone = el().getAttribute('data-dismiss-zone');
  shell.press(q('.well-wrap'));
  assert.ok(!isOpen());
  assert.equal(el().getAttribute('data-dismiss-zone'), hadZone);
});

test('any other zone element closes by .hidden, its controller told', async (t) => {
  const other = W.document.createElement('div');
  other.id = 'test-dock';
  other.setAttribute('data-dismiss-zone', '.well-wrap');
  const ctl = W.document.createElement('button');
  ctl.setAttribute('aria-controls', 'test-dock');
  ctl.setAttribute('aria-expanded', 'true');
  W.document.body.append(other, ctl);
  t.after(() => { other.remove(); ctl.remove(); });
  shell.press($('topbar'));
  assert.ok(!other.classList.contains('hidden'), 'outside its zone it stays');
  shell.press(q('.well-wrap'));
  assert.ok(other.classList.contains('hidden'), 'inside its zone it hides');
  assert.equal(ctl.getAttribute('aria-expanded'), 'false');
});

/* ------------------------------ Escape ------------------------------ */

test('Escape with the bar\'s note open closes the note and leaves the drawer; a second closes the drawer', async () => {
  await open();
  shell.click(firstChip());
  assert.ok(note(), 'precondition: the note is open');
  shell.key('Escape');
  assert.ok(!note(), 'the first Escape closed the note');
  assert.ok(isOpen(), '…and left the drawer');
  shell.key('Escape');
  assert.ok(!isOpen(), 'the second closed the drawer');
});

test('an addEscapeStep layer pops before the drawer closes', async (t) => {
  await open();
  let taken = 0;
  const off = dock.addEscapeStep(() => (taken++ === 0));
  t.after(off);
  shell.key('Escape');
  assert.equal(taken, 1, 'the step was asked');
  assert.ok(isOpen(), 'the step took the first Escape; the drawer stayed');
  shell.key('Escape');
  assert.ok(!isOpen(), 'the next Escape closed the drawer');
});

test('a popover goes before an Escape step: one layer per press', async (t) => {
  await open();
  let asked = 0;
  t.after(dock.addEscapeStep(() => { asked++; return true; }));
  shell.click(firstChip());
  shell.key('Escape');
  assert.ok(!note(), 'the note closed');
  assert.equal(asked, 0, 'and the chat was not asked on the same press');
  shell.key('Escape');
  assert.equal(asked, 1, 'the next press reached the chat');
});

test('Escape with the queue rail pinned unpins it and leaves the drawer', async () => {
  await open();
  shell.key('q');
  assert.ok(railPinnedOpen(), 'precondition: Q pinned the rail open');
  shell.key('Escape');
  assert.ok(!railPinnedOpen(), 'Escape unpinned the rail');
  assert.ok(isOpen(), '…and left the drawer');
  shell.key('Escape');
  assert.ok(!isOpen());
});

test('Escape in pin mode leaves pin mode and the drawer', async () => {
  await open();
  shell.key('c');
  assert.ok(W.document.body.classList.contains('pin-mode'), 'precondition: C armed pin mode');
  shell.key('Escape');
  assert.ok(!W.document.body.classList.contains('pin-mode'), 'Escape left pin mode');
  assert.ok(isOpen(), '…and left the drawer');
  shell.key('Escape');
  assert.ok(!isOpen());
});

test('a window-mode dock closes on Escape only while focus is inside it', async () => {
  await open();
  detach();
  if (W.document.activeElement && W.document.activeElement.blur) W.document.activeElement.blur();
  shell.key('Escape');
  assert.ok(isOpen(), 'with focus on the page, Escape leaves the window');
  el().focus();
  assert.ok(el().contains(W.document.activeElement), 'precondition: focus is in the window');
  shell.key('Escape');
  assert.ok(!isOpen(), 'with focus inside, Escape closes it');
});

test('an editable field keeps its own Escape', async (t) => {
  const { input } = addPane(t);
  await open();
  input.focus();
  shell.key('Escape', { target: input });
  assert.ok(isOpen(), 'Escape typed in a pane field did not reach the chat');
});

/* ------------------------------ M ------------------------------ */

test('M opens the chat on its composer, open or not', async (t) => {
  const seen = listen(t, 'chat:open');
  const e = shell.key('m');
  await shell.tick();
  assert.deepEqual(seen, [{ view: 'chat', focus: 'composer' }]);
  assert.ok(e.defaultPrevented, 'the key is taken');
  assert.ok(isOpen(), 'the dock answered it');
  shell.key('M');
  await shell.tick();
  assert.equal(seen.length, 2, 'M while open emits again (the dock re-applies focus)');
  assert.deepEqual(seen[1], { view: 'chat', focus: 'composer' });
  assert.ok(isOpen());
});

test('M is the key the bar\'s step advertises', () => {
  const step = $('cs-step');
  assert.equal(step.getAttribute('aria-keyshortcuts'), 'M', 'a chat view is registered, so the step says M');
});

test('M is ignored from an input', async (t) => {
  const seen = listen(t, 'chat:open');
  const { input } = addPane(t);
  input.focus();
  shell.key('m', { target: input });
  const light = W.document.createElement('input');
  W.document.body.appendChild(light);
  t.after(() => light.remove());
  light.focus();
  shell.key('m', { target: light });
  await shell.tick();
  assert.deepEqual(seen, []);
  assert.ok(!isOpen());
});

test('M is ignored with the graph overlay open, and with a float preview', async (t) => {
  const seen = listen(t, 'chat:open');
  const gv = await shell.importApp('graph-view.js');
  shell.key('g');
  await shell.tick();
  assert.ok(gv.isOverlayOpen(), 'precondition: G opened the graph');
  shell.key('m');
  await shell.tick();
  assert.deepEqual(seen, [], 'nothing under the overlay');

  // A glance is raised from inside the overlay; hide the overlay under it so
  // the float-preview guard is the only one left to hold M.
  const node = W.document.querySelector('#graph-svg g[data-id="n1"], #gv-world .gv-srow[data-id="n1"]');
  assert.ok(node, 'precondition: the graph drew n1');
  node.dispatchEvent(new W.MouseEvent('click', { bubbles: true }));
  await shell.tick();
  gv.toggleFloatPreview();
  assert.ok(gv.hasFloatPreview(), 'precondition: a float preview is up');
  $('overlay').classList.add('hidden');
  await shell.tick();
  shell.key('m');
  await shell.tick();
  assert.deepEqual(seen, [], 'nothing under a float preview either');
  $('overlay').classList.remove('hidden');
  gv.toggleFloatPreview();
  gv.closeOverlay();
  await shell.tick();
  assert.ok(!gv.hasFloatPreview() && !gv.isOverlayOpen(), 'cleaned up');
});

// The player's own capture-phase window listener (replay.js onKey) already
// holds every non-Escape key while it is open; the shell's isReplayOpen() guard
// on M is the backstop behind it, so this pins the behaviour, not that guard.
test('M is ignored with the replay player open', async (t) => {
  const seen = listen(t, 'chat:open');
  const { isReplayOpen } = await shell.importApp('replay.js');
  $('replay-pop').classList.remove('hidden');   // the player's open state, without loading a replay
  t.after(() => $('replay-pop').classList.add('hidden'));
  assert.ok(isReplayOpen(), 'precondition: the replay player reads as open');
  shell.key('m');
  await shell.tick();
  assert.deepEqual(seen, []);
});

/* ------------------------------ ⌘K ------------------------------ */

const openPalette = async () => { shell.key('k', { metaKey: true }); await shell.tick(); };
const rows = () => [...$('cmd-list').querySelectorAll('.palette-item')].map((r) => ({
  el: r,
  label: r.querySelector('.label').textContent,
  hint: r.querySelector('.hint') ? r.querySelector('.hint').textContent : '',
}));
const row = (label) => rows().find((r) => r.label === label);
const runRow = (r) => r.el.dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

test('⌘K lists "Chat with Claude" (M), which opens the chat', async (t) => {
  const seen = listen(t, 'chat:open');
  await openPalette();
  const r = row('Chat with Claude');
  assert.ok(r, 'the row is listed');
  assert.equal(r.hint, 'M', 'with its key');
  runRow(r);
  await shell.tick();
  assert.ok($('cmd-palette').classList.contains('hidden'), 'the palette closed');
  assert.deepEqual(seen, [{ view: 'chat', focus: 'composer' }]);
  assert.ok(isOpen());
});

test('⌘K lists "Reset the chat window", which puts the defaults back', async () => {
  await open();
  detach();
  assert.equal(el().dataset.mode, 'window', 'precondition: detached');
  await openPalette();
  const r = row('Reset the chat window');
  assert.ok(r, 'the row is listed');
  runRow(r);
  await shell.tick();
  assert.equal(el().dataset.mode, 'drawer', 'the window went back to the default drawer');
  assert.equal(JSON.parse(W.localStorage.getItem('wc:chat-window')).mode, 'drawer', 'and the defaults were saved');
});

test('⌘K "Background tasks" shows while #cs-chips holds a button, and clicks the first', async () => {
  assert.ok(firstChip(), 'precondition: the bar\'s stand-in chips are up');
  await openPalette();
  const r = row('Background tasks');
  assert.ok(r, 'listed while there is a chip');
  runRow(r);
  await shell.tick();
  assert.ok(note(), 'running it clicked the first chip: the note opened');
  shell.key('Escape');

  const release = bar.claimChips();      // the trays' claim: the stand-ins go
  try {
    assert.equal(firstChip(), null, 'precondition: no chip');
    await openPalette();
    assert.equal(row('Background tasks'), undefined, 'not listed with no chip');
    shell.key('Escape');
  } finally {
    release();
  }
});

/* ------------------------------ the legend ------------------------------ */

test('the legend has a "Chat with Claude" row with M', () => {
  const r = [...$('key-legend').querySelectorAll('.legend-row')]
    .find((x) => x.querySelector('span').textContent === 'Chat with Claude');
  assert.ok(r, 'the row is there');
  assert.deepEqual([...r.querySelectorAll('kbd')].map((k) => k.textContent), ['M']);
  assert.equal(r.id, '', 'no id: the existing .legend-row markup');
});

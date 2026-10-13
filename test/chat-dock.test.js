// The desktop chat dock (public/app/chat-dock.js) through the real shell
// (test-support/chrome-shell.js): design spec §7.7, §7.1's rail collision,
// §7.8's focus paragraph, and U33's brief.
//
//   * It registers ONE chat view, 'dock' (never 'sheet', the phone sheet's
//     own, which main.js also registers from tranche 5), and the posture goes out only through chat-slots' changed():
//     the socket's next `client` frame says mirror 'full' while it is open and
//     'status' once it closes.
//   * chat:open (wide only) shows it, closes every popover, announces chat:host
//     {host: #cd-body, variant: 'desktop'} and focuses the composer, else
//     #chat-stream, else the dock; closing returns focus. A second chat:open only
//     re-applies focus. Narrow, chat:open is ignored, and a flip to narrow
//     closes it.
//   * Detach / Attach switch data-mode without moving #cd-body's content, and
//     the window drops data-dismiss-zone; mode, opacity and Solid persist in
//     wc:chat-window; a gesture writes it once, on pointer up; a strip control
//     never starts one; the window is clamped for display only.
//   * Escape: an addEscapeStep layer first, then the drawer closes; a window
//     closes only with focus inside it.
//
// main.js inits the dock (U40), and the panel it hosts with the stream and the
// tool cards inside; the boot's init calls initChatDock again (idempotent) and
// stops the other three and takes the panel out of #cd-body, so the dock is
// tested alone, as a host: the panel has test/chat-panel.test.js. The geometry itself is plain-node tested in
// test/chat-dock-geometry.test.js; jsdom cannot lay out.
const test = require('node:test');
const { before, after, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DEFAULTS = { v: 1, mode: 'drawer', op: 1, hoverSolid: true, x: 760, y: 40, w: 420, h: 580 };
const ZONE = '#contents-nav, .well-wrap';

let shell, W, $, bus, slots, dock;
let wrapMetrics;

before(async () => {
  shell = await bootShell({
    init: async (s) => {
      const d = await s.importApp('chat-dock.js');
      d.initChatDock();
      (await s.importApp('chat-tools.js')).stopChatTools();
      (await s.importApp('chat-stream.js')).stopChatStream();
      (await s.importApp('chat-panel.js')).stopPanel();
      const panel = s.document.getElementById('chat-panel');
      if (panel) panel.remove();
    },
  });
  W = shell.window;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  slots = await shell.importApp('chat-slots.js');
  dock = await shell.importApp('chat-dock.js');
  // .body-wrap's box, which jsdom cannot lay out: the window's area is this
  // less the 64px rail.
  wrapMetrics = shell.scrollMetrics(W.document.querySelector('.body-wrap'), { clientWidth: 1400, clientHeight: 800 });
});
after(() => shell.restore());

afterEach(() => {
  dock.closeChat({ returnFocus: false });
  dock.resetChatWindow();
  wrapMetrics.clientWidth = 1400;
  wrapMetrics.clientHeight = 800;
  if (W.document.activeElement && W.document.activeElement.blur) W.document.activeElement.blur();
});

const el = () => $('chat-dock');
const strip = () => $('cd-strip');
const isShown = () => !el().classList.contains('hidden');
const saved = () => JSON.parse(W.localStorage.getItem('wc:chat-window'));
const open = async (detail = { view: 'chat', focus: 'composer' }) => { bus.emit('chat:open', detail); await shell.tick(); };
const lastClient = () => shell.socket().frames('client').at(-1);
const detach = () => shell.click(strip().querySelector('.cd-detach'));
const attach = () => shell.click(strip().querySelector('.cd-attach'));
const pointer = (target, type, init = {}) => target.dispatchEvent(new W.PointerEvent(type,
  { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 1, ...init }));

// Count the writes of wc:chat-window for the length of one test.
function countWrites(t) {
  const proto = W.Storage.prototype;
  const orig = proto.setItem;
  const writes = [];
  proto.setItem = function setItem(k, v) { if (k === 'wc:chat-window') writes.push(JSON.parse(v)); return orig.call(this, k, v); };
  t.after(() => { proto.setItem = orig; });
  return writes;
}
function listen(t, type) {
  const seen = [];
  t.after(bus.on(type, (d) => seen.push(d)));
  return seen;
}

/* ── registration and the posture ─────────────────────────────────────────── */

test('the dock registers one chat view, "dock", and never "sheet"', () => {
  const ids = slots.chatViews().map((v) => v.id);
  assert.deepEqual(ids.filter((id) => id === 'dock'), ['dock']);
  // 'sheet' is the phone sheet's own view (chat-sheet.js, which main.js inits
  // from tranche 5): one of it, never the dock's.
  assert.deepEqual(ids, ['dock', 'sheet'], 'the dock\'s view and the sheet\'s, one each');
  assert.equal(dock.dockEl, el(), 'dockEl is the section');
  assert.equal(dock.initChatDock(), el(), 'idempotent: a second init hands back the same dock');
  assert.deepEqual(slots.chatViews().map((v) => v.id), ['dock', 'sheet'], 'still one view each');
  assert.ok(!el().classList.contains('drawer') && !el().classList.contains('popover'),
    'not a panel: it must not close with them');
});

test('chat:open shows the dock, hands the panel its host, and the posture goes full; closeChat() puts it back', async (t) => {
  const hosts = listen(t, 'chat:host');
  assert.ok(!isShown(), 'closed at boot');
  await open();
  assert.ok(isShown(), 'shown');
  assert.equal(dock.isChatOpen(), true);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].host, $('cd-body'));
  assert.equal(hosts[0].variant, 'desktop');
  assert.equal(slots.posture(), 'full');
  assert.equal(lastClient().mirror, 'full', 'the socket\'s next client frame asks for the stream');
  await waitUntil(() => $('cs-step').getAttribute('aria-expanded') === 'true');
  assert.equal($('cs-step').getAttribute('aria-controls'), 'chat-dock', 'the bar\'s step is the chat\'s now');

  assert.equal(dock.closeChat(), true);
  assert.ok(!isShown(), 'hidden');
  assert.equal(slots.posture(), 'status');
  assert.equal(lastClient().mirror, 'status');
  await waitUntil(() => $('cs-step').getAttribute('aria-expanded') === 'false');
  assert.equal(dock.closeChat(), false, 'closing a closed dock does nothing');
});

test('the dock never sends the posture itself: it has no line to the socket', () => {
  const src = read('public/app/chat-dock.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /from '\.\/ws\.js'|setClientField|chat:posture/, 'chat-slots\' changed() is the one way');
  assert.match(src, /reg\.changed\(\)/);
});

test('a second chat:open while open only re-applies focus: one chat:host, one posture change', async (t) => {
  const hosts = listen(t, 'chat:host');
  const postures = listen(t, 'chat:posture');
  await open({ view: 'chat' });
  const frames = shell.socket().frames('client').length;
  $('btn-more').focus();
  await open({ view: 'awaiting', id: 'a1', focus: 'composer' });
  assert.equal(hosts.length, 1, 'one chat:host');
  assert.deepEqual(postures, [{ posture: 'full' }], 'one posture change');
  assert.equal(shell.socket().frames('client').length, frames, 'nothing more sent');
  assert.ok(el().contains(W.document.activeElement), 'but focus is back in the chat');
});

test('opening the chat closes every popover — the bar\'s note included', async (t) => {
  // main.js starts the trays (tranche 3), whose claimChips() takes the bar's
  // stand-in chips at boot: the trays come off for this case (stopTrays() calls
  // claimChips' release(), and the stand-ins are back) and go on again after it.
  const trays = await shell.importApp('chat-trays.js');
  trays.stopTrays();
  t.after(() => { trays.initChatTrays(); });
  await shell.tick();
  const chip = W.document.querySelector('#cs-chips .cs-devchip');
  assert.ok(chip, 'precondition: the bar\'s stand-in chips');
  shell.press(chip);
  await shell.tick();
  const note = $('cs-tray');
  assert.ok(note && !note.classList.contains('hidden'), 'precondition: the note is open');
  let closes = 0;
  const onClose = () => closes++;
  W.addEventListener('wc:close-popovers', onClose);
  try { await open(); } finally { W.removeEventListener('wc:close-popovers', onClose); }
  assert.equal(closes, 1, 'wc:close-popovers, once');
  assert.ok(note.classList.contains('hidden'), 'the note closed');
  assert.ok(isShown(), 'and the chat is open');
});

/* ── focus ────────────────────────────────────────────────────────────────── */

test('focus: the registered composer first, else #chat-stream, else the dock', async (t) => {
  let focused = 0;
  const off = slots.registerComposer({ mount() {}, focus() { focused++; }, escape() { return false; } });
  t.after(off);
  await open({ view: 'chat', focus: 'composer' });
  assert.equal(focused, 1, 'the composer took the focus');
  dock.closeChat({ returnFocus: false });
  off();

  const stream = W.document.createElement('div');
  stream.id = 'chat-stream';
  stream.tabIndex = -1;
  $('cd-body').append(stream);
  t.after(() => stream.remove());
  await open({ view: 'chat', focus: 'composer' });
  assert.equal(W.document.activeElement, stream, 'no composer: the stream');
  dock.closeChat({ returnFocus: false });
  stream.remove();

  await open({ view: 'chat', focus: 'composer' });
  assert.equal(W.document.activeElement, el(), 'neither: the dock itself');
});

test('closing returns focus to where it was, else to #cs-step; returnFocus: false leaves it alone', async () => {
  const before = $('btn-more');
  before.focus();
  await open();
  assert.notEqual(W.document.activeElement, before, 'precondition: focus moved into the chat');
  dock.closeChat();
  assert.equal(W.document.activeElement, before, 'back where it was');

  W.document.activeElement.blur();
  await open();
  dock.closeChat();
  assert.equal(W.document.activeElement, $('cs-step'), 'nothing focused before: the bar\'s step');

  await open();
  const inside = W.document.activeElement;
  dock.closeChat({ returnFocus: false });
  assert.equal(W.document.activeElement, inside, 'left alone');
});

/* ── the narrow breakpoint ────────────────────────────────────────────────── */

test('at 759px chat:open is ignored, and a flip to narrow while open closes the dock', async (t) => {
  t.after(() => shell.setViewport({ width: 1280, height: 800 }));
  shell.setViewport({ width: 759, height: 800 });
  await open();
  assert.ok(!isShown(), 'ignored while narrow: the phone sheet takes it (tranche 5)');
  // The open chat view is now the sheet (chat-sheet.js, main.js), so the
  // posture is the sheet's; it is closed before the flip.
  const sheet = await shell.importApp('chat-sheet.js');
  assert.equal(sheet.sheetState().open, true, 'the sheet opened on chat:open');
  assert.deepEqual(slots.chatViews(), [{ id: 'dock', open: false }, { id: 'sheet', open: true }]);
  assert.equal(slots.posture(), 'full', 'the sheet\'s posture');
  sheet.closeSheet({ returnFocus: false });
  assert.equal(slots.posture(), 'status');

  shell.setViewport({ width: 1280, height: 800 });
  await open();
  assert.ok(isShown(), 'precondition: open when wide');
  shell.setViewport({ width: 759, height: 800 });
  assert.ok(!isShown(), 'the flip closed it');
  assert.equal(slots.posture(), 'status');
});

/* ── the two modes ────────────────────────────────────────────────────────── */

test('the drawer strip: DOCKED and Detach; the section carries its dismiss zone', () => {
  assert.equal(el().dataset.mode, 'drawer');
  assert.equal(el().getAttribute('data-dismiss-zone'), ZONE);
  const kids = [...strip().children];
  assert.deepEqual(kids.map((k) => k.className), ['cd-label', 'cd-spacer', 'cd-btn cd-detach']);
  assert.equal(kids[0].textContent, 'DOCKED');
  assert.equal(kids[2].textContent, '⇱ Detach');
});

test('Detach builds the window strip and drops the dismiss zone; Attach puts both back', async () => {
  await open();
  detach();
  assert.equal(el().dataset.mode, 'window');
  assert.equal(el().hasAttribute('data-dismiss-zone'), false, 'a window never closes on an outside click');
  const kids = [...strip().children];
  assert.deepEqual(kids.map((k) => k.className),
    ['cd-btn cd-close', 'cd-grip', 'cd-op', 'cd-btn cd-solid', 'cd-spacer', 'cd-btn cd-attach']);
  assert.equal(kids[0].textContent, '✕');
  assert.equal(kids[0].getAttribute('aria-label'), 'Close the chat');
  const op = kids[2];
  assert.equal(op.querySelector('.cd-op-icon').textContent, '◐');
  const range = op.querySelector('input[type="range"]');
  assert.deepEqual([range.min, range.max, range.value], ['25', '100', '100']);
  assert.equal(op.querySelector('.cd-op-val').textContent, '100%');
  assert.equal(kids[3].textContent, 'Solid');
  assert.equal(kids[3].getAttribute('aria-pressed'), 'true');
  assert.equal(kids[5].textContent, '⇥ Attach');
  assert.ok(isShown(), 'still open');
  assert.equal(W.document.activeElement, strip().querySelector('.cd-attach'), 'focus follows to the counterpart');

  attach();
  assert.equal(el().dataset.mode, 'drawer');
  assert.equal(el().getAttribute('data-dismiss-zone'), ZONE);
  assert.ok(strip().querySelector('.cd-detach'), 'the drawer strip again');
  assert.ok(isShown());

  shell.click(strip().querySelector('.cd-detach'));
  shell.click(strip().querySelector('.cd-close'));
  assert.ok(!isShown(), '✕ closes the window');
});

test('a mode switch never moves the panel: the same node, the same parent, its draft intact', async () => {
  const panel = W.document.createElement('div');
  const draft = W.document.createElement('textarea');
  panel.append(draft);
  $('cd-body').append(panel);
  try {
    await open();
    draft.value = 'half a thought';
    const body = $('cd-body');
    let moved = 0;
    const mo = new W.MutationObserver((recs) => { for (const r of recs) if (r.target === body) moved++; });
    mo.observe(body, { childList: true });
    detach();
    attach();
    detach();
    await shell.tick();
    mo.disconnect();
    assert.equal(moved, 0, '#cd-body\'s children were never touched');
    assert.equal(panel.parentElement, body);
    assert.equal(body.parentElement, el());
    assert.equal(draft.value, 'half a thought');
  } finally { panel.remove(); }
});

test('the mode, the opacity and Solid persist in wc:chat-window', async (t) => {
  const writes = countWrites(t);
  await open();
  detach();
  assert.equal(saved().mode, 'window');
  const range = strip().querySelector('.cd-op-range');
  range.value = '60';
  range.dispatchEvent(new W.Event('input', { bubbles: true }));
  assert.equal(strip().querySelector('.cd-op-val').textContent, '60%');
  assert.equal(el().style.getPropertyValue('--cd-op'), '0.6');
  assert.equal(saved().op, 1, 'not written while the range moves');
  range.dispatchEvent(new W.Event('change', { bubbles: true }));
  assert.equal(saved().op, 0.6, 'written at the end');
  const solid = strip().querySelector('.cd-solid');
  shell.click(solid);
  assert.equal(solid.getAttribute('aria-pressed'), 'false');
  assert.equal(el().hasAttribute('data-solid'), false);
  assert.equal(saved().hoverSolid, false);
  assert.deepEqual(writes.map((w) => [w.mode, w.op, w.hoverSolid]),
    [['window', 1, true], ['window', 0.6, true], ['window', 0.6, false]], 'one write per change');
  assert.ok(writes.every((w) => w.v === 1));
  attach();
  assert.equal(saved().mode, 'drawer');
});

test('the saved prefs are read at init: a window comes back a window', async () => {
  // initChatDock is idempotent, so read through the same normalizer it uses.
  W.localStorage.setItem('wc:chat-window', JSON.stringify({ ...DEFAULTS, mode: 'window', op: 0.5 }));
  assert.deepEqual(dock.readWindowPrefs(), { ...DEFAULTS, mode: 'window', op: 0.5 });
  W.localStorage.setItem('wc:chat-window', '{"v":2}');
  assert.deepEqual(dock.readWindowPrefs(), DEFAULTS);
});

/* ── gestures ─────────────────────────────────────────────────────────────── */

test('a grip drag moves the window and writes wc:chat-window once, on pointer up', async (t) => {
  await open();
  detach();
  const writes = countWrites(t);
  const grip = strip().querySelector('.cd-grip');
  pointer(grip, 'pointerdown', { clientX: 100, clientY: 100 });
  assert.ok(el().classList.contains('cd-gesture'));
  pointer(grip, 'pointermove', { clientX: 110, clientY: 105 });
  pointer(grip, 'pointermove', { clientX: 120, clientY: 112 });
  pointer(grip, 'pointermove', { clientX: 130, clientY: 120 });
  assert.equal(writes.length, 0, 'never per move');
  assert.equal(el().style.getPropertyValue('--cd-x'), '790px', 'the window follows the pointer');
  assert.equal(el().style.getPropertyValue('--cd-y'), '60px');
  pointer(grip, 'pointerup', { clientX: 130, clientY: 120 });
  assert.equal(writes.length, 1, 'once, at the end');
  assert.deepEqual(writes[0], { ...DEFAULTS, mode: 'window', x: 790, y: 60 });
  assert.ok(!el().classList.contains('cd-gesture'));
  pointer(grip, 'pointermove', { clientX: 400, clientY: 400 });
  assert.equal(el().style.getPropertyValue('--cd-x'), '790px', 'the gesture is over');
});

test('an edge handle resizes, clamped to the area less the rail, and writes once', async (t) => {
  await open();
  detach();
  const writes = countWrites(t);
  const se = el().querySelector('.cd-h[data-edge="se"]');
  pointer(se, 'pointerdown', { clientX: 0, clientY: 0 });
  pointer(se, 'pointermove', { clientX: 50, clientY: 40 });
  pointer(se, 'pointerup', { clientX: 5000, clientY: 5000 });
  assert.equal(writes.length, 1);
  // Area: 1400 - 64 = 1336 wide, 800 high; the window starts at 760, 40.
  assert.deepEqual(writes[0], { ...DEFAULTS, mode: 'window', w: 1336 - 760, h: 800 - 40 });
  const all = [...el().querySelectorAll('.cd-h')].map((h) => h.dataset.edge);
  assert.deepEqual(all, ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
  assert.ok([...el().querySelectorAll('.cd-h')].every((h) => h.getAttribute('aria-hidden') === 'true'));
});

test('a cancelled gesture puts the saved geometry back, and closing mid-drag ends the drag unsaved', async (t) => {
  await open();
  detach();
  const writes = countWrites(t);
  const grip = strip().querySelector('.cd-grip');
  pointer(grip, 'pointerdown', { clientX: 100, clientY: 100 });
  pointer(grip, 'pointermove', { clientX: 150, clientY: 130 });
  assert.equal(el().style.getPropertyValue('--cd-x'), '810px', 'precondition: the window followed');
  pointer(grip, 'pointercancel', { clientX: 150, clientY: 130 });
  assert.equal(el().style.getPropertyValue('--cd-x'), '760px', 'cancelled: back at the saved place');
  assert.equal(el().style.getPropertyValue('--cd-y'), '40px');
  assert.ok(!el().classList.contains('cd-gesture'));

  pointer(grip, 'pointerdown', { clientX: 100, clientY: 100 });
  pointer(grip, 'pointermove', { clientX: 150, clientY: 130 });
  dock.closeChat({ returnFocus: false });
  assert.ok(!el().classList.contains('cd-gesture'), 'closing ended the drag');
  pointer(grip, 'pointerup', { clientX: 200, clientY: 200 });
  assert.equal(writes.length, 0, 'neither drag was saved');
  assert.equal(saved().x, 760);
});

test('a pointerdown on a strip control never starts a drag', async (t) => {
  await open();
  detach();
  const writes = countWrites(t);
  let reached = 0;
  const onDown = () => reached++;
  strip().addEventListener('pointerdown', onDown);
  try {
    for (const sel of ['.cd-solid', '.cd-op-range', '.cd-attach', '.cd-close']) {
      const c = strip().querySelector(sel);
      pointer(c, 'pointerdown', { clientX: 10, clientY: 10 });
      assert.ok(!el().classList.contains('cd-gesture'), `${sel}: no gesture`);
      pointer(c, 'pointermove', { clientX: 300, clientY: 300 });
      pointer(c, 'pointerup', { clientX: 300, clientY: 300 });
    }
  } finally { strip().removeEventListener('pointerdown', onDown); }
  assert.equal(reached, 0, 'the controls stop pointerdown');
  assert.equal(writes.length, 0, 'nothing written');
  assert.equal(el().style.getPropertyValue('--cd-x'), '760px', 'nothing moved');
});

test('the window is clamped for display only: a shrink then a grow restores the saved size', async () => {
  await open();
  detach();
  wrapMetrics.clientWidth = 900;     // area 836 wide
  wrapMetrics.clientHeight = 500;
  W.dispatchEvent(new W.Event('resize'));
  assert.equal(el().style.getPropertyValue('--cd-x'), `${836 - 420}px`);
  assert.equal(el().style.getPropertyValue('--cd-h'), '500px');
  assert.equal(saved().x, 760, 'the saved geometry is untouched');
  wrapMetrics.clientWidth = 1600;
  wrapMetrics.clientHeight = 900;
  W.dispatchEvent(new W.Event('resize'));
  assert.equal(el().style.getPropertyValue('--cd-x'), '760px', 'back where it was saved');
  assert.equal(el().style.getPropertyValue('--cd-h'), '580px');
});

test('resetChatWindow() writes the defaults back and applies them', async () => {
  await open();
  detach();
  const range = strip().querySelector('.cd-op-range');
  range.value = '40';
  range.dispatchEvent(new W.Event('change', { bubbles: true }));
  const grip = strip().querySelector('.cd-grip');
  pointer(grip, 'pointerdown', { clientX: 0, clientY: 0 });
  pointer(grip, 'pointerup', { clientX: -200, clientY: 30 });
  assert.notDeepEqual(saved(), DEFAULTS, 'precondition: moved and faded');
  dock.resetChatWindow();
  assert.deepEqual(saved(), DEFAULTS);
  assert.equal(el().dataset.mode, 'drawer');
  assert.equal(el().getAttribute('data-dismiss-zone'), ZONE);
  assert.equal(el().style.getPropertyValue('--cd-op'), '1');
  assert.equal(el().style.getPropertyValue('--cd-x'), '760px');
  assert.ok(strip().querySelector('.cd-detach'), 'the drawer strip');
  assert.ok(isShown(), 'the chat stays open');
});

/* ── Escape ───────────────────────────────────────────────────────────────── */

test('Escape: an inner step first, newest first; then the drawer closes', async (t) => {
  await open();
  const asked = [];
  let innerTakes = true;
  const offOld = dock.addEscapeStep(() => { asked.push('old'); return false; });
  const offNew = dock.addEscapeStep(() => { asked.push('new'); return innerTakes; });
  t.after(() => { offOld(); offNew(); });
  assert.equal(slots.escapeChatViews(), true);
  assert.deepEqual(asked, ['new'], 'the newest step took it');
  assert.ok(isShown(), 'and the dock stayed open');

  innerTakes = false;
  asked.length = 0;
  assert.equal(slots.escapeChatViews(), true);
  assert.deepEqual(asked, ['new', 'old'], 'each step asked, newest first');
  assert.ok(!isShown(), 'then the drawer closed');
  assert.equal(slots.posture(), 'status');
  assert.throws(() => dock.addEscapeStep('nope'), TypeError);
});

test('Escape: a window closes only while focus is inside it', async () => {
  await open();
  detach();
  $('btn-more').focus();
  assert.equal(slots.escapeChatViews(), false, 'focus on the page: the window stays');
  assert.ok(isShown());
  strip().querySelector('.cd-solid').focus();
  assert.equal(slots.escapeChatViews(), true);
  assert.ok(!isShown(), 'focus inside: it closes');
  assert.equal(W.document.activeElement, $('cs-step'), 'nothing was focused before the open: the bar\'s step');
});

/* ── ids, colours, storage ────────────────────────────────────────────────── */

test('the dock declares no id beyond chat-dock, cd-strip and cd-body, and builds none', async () => {
  await open();
  detach();
  const ids = [el(), ...el().querySelectorAll('[id]')].map((n) => n.id).filter(Boolean);
  assert.deepEqual(ids.sort(), ['cd-body', 'cd-strip', 'chat-dock']);
  const src = read('public/app/chat-dock.js');
  assert.deepEqual([...src.matchAll(/\.id\s*=\s*['"`]([\w-]+)/g)].map((m) => m[1]), [], 'no id assigned in script');
  assert.doesNotMatch(src, /\b(?:local|session)Storage\b/, 'storage only through storage.js');
});

test('the U33 CSS: tokens only, the chat rung, the rail\'s collision and no motion under reduce', () => {
  const css = read('public/app.css');
  const start = css.indexOf('/* ── U33 · the chat dock · chat-dock.js ── */');
  const end = css.indexOf('/* ── U35 ·', start);
  const section = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b/, 'no hex colour');
  assert.match(section, /\.chat-dock\s*\{[^}]*z-index:\s*var\(--z-chat\)/);
  assert.match(section, /\.body-wrap:has\(\.rail\.open\) \.chat-dock\[data-mode="drawer"\]\s*\{\s*right:\s*272px;?\s*\}/);
  assert.match(section, /\.chat-dock\[data-mode="drawer"\]\s*\{[^}]*right:\s*64px;[^}]*width:\s*min\(400px, calc\(100% - 64px\)\)/);
  assert.match(section, /\.chat-dock\[data-mode="drawer"\]\s*\{[^}]*transition:\s*right \.2s cubic-bezier\(\.2,\.8,\.2,1\)/,
    'the rail\'s own curve');
  assert.match(section, /\.chat-dock:not\(\.hidden\)\[data-mode="drawer"\]\s*\{\s*animation:\s*cd-slide \.26s cubic-bezier\(\.3,\.7,\.2,1\)/);
  assert.match(section, /\[data-solid\]:is\(:hover, :focus-within\)\s*\{\s*opacity:\s*1;?\s*\}/);
  assert.match(section, /\.chat-dock\[data-mode="drawer"\] \.cd-h\s*\{\s*display:\s*none;?\s*\}/, 'no handles on the drawer');
  assert.match(section, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none;\s*transition:\s*none;/);
  assert.doesNotMatch(section, /\.hidden\s*\{/, 'closing is instant: no rule animates .hidden');
});

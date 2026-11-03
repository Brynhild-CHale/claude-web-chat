// The engine's undo in the chrome (annotation engine 4A.3, U518; AD6, AI13):
// public/app/element-undo.js registers ONE chrome action, elements.undo, on the
// fixed Mod+Z default through the hotkey registry, and one ⌘K row — no toolbar
// control and no legend row. Mod+Z never fires in a text field (the chrome's
// or a pane's: the field keeps its own undo), on the page it posts once with
// the item under the pointer, below full it is the page's, and while a node is
// previewed it posts nothing and shows READONLY_HINT (element-types.js
// trayAction). The real chrome, booted once (test-support/chrome-shell).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const PANE = { id: 'p1', target: 'main', params: {}, gen: 0, html: '<p class="lead">Hello world</p><input id="f1" type="text">' };
const UNDONE = { ok: true, undone: { id: 'h7', type: 'highlight', v: 1, item: 'p1', how: 'removed' } };

let shell, W, $, hk, U, topbar, TS, state;
const posts = () => shell.calls.filter((c) => c.method === 'POST' && c.url === '/api/elements/undo');
const noteText = () => { const n = W.document.querySelector('#reaim-note .reaim-note-text'); return n ? n.textContent : ''; };
const host = () => W.document.querySelector('.mount-host[data-mount-id="p1"]');
const pointerOn = (el) => el.dispatchEvent(new W.PointerEvent('pointermove', { bubbles: true, composed: true }));

before(async () => {
  shell = await bootShell({ routes: { '/api/elements/undo': UNDONE } });
  W = shell.window;
  $ = (id) => W.document.getElementById(id);
  hk = await shell.importApp('hotkeys.js');
  U = await shell.importApp('element-undo.js');
  topbar = await shell.importApp('topbar.js');
  TS = await shell.importApp('toolbar-state.js');
  ({ view: state } = await shell.importApp('state.js'));
  await shell.frame(helloFrame({ active: 'n1', mounts: [PANE] }));
  await shell.tick(3);
  await waitUntil(() => host() && host().shadowRoot && host().shadowRoot.querySelector('input'), { timeout: 5000, what: 'the pane mounted' });
});
after(async () => { if (shell) await shell.restore(); });

test('elements.undo is registered on the fixed Mod+Z default, rebindable, page context, never in a field, no legend row', () => {
  const a = hk.actionOf('elements.undo');
  assert.ok(a, 'registered');
  assert.deepEqual([...a.chords], ['Mod+Z']);
  assert.equal(a.label, U.UNDO_LABEL);
  assert.deepEqual([...a.contexts], ['page']);
  assert.equal(a.whenField, false);
  assert.equal(a.rebindable, true);
  assert.equal(a.legend, null);
  assert.equal(hk.keyFor('elements.undo'), '⌘Z');
  const legend = $('key-legend');
  assert.ok(!legend.textContent.includes(U.UNDO_LABEL), 'no legend row names it');
  assert.ok(![...legend.querySelectorAll('kbd')].some((k) => k.textContent === '⌘Z'), 'no ⌘Z in the legend');
  assert.equal($('toolbar') ? $('toolbar').textContent.includes('Undo') : false, false, 'no toolbar control');
});

test('Mod+Z with focus in a chrome textarea, or in a pane\'s input, does not run it: the field keeps its undo', async (t) => {
  const n0 = posts().length;
  const ta = W.document.createElement('textarea');
  $('topbar').appendChild(ta);
  t.after(() => ta.remove());
  ta.focus();
  const e1 = shell.key('z', { target: ta, metaKey: true });
  ta.blur();
  const inp = host().shadowRoot.querySelector('input');
  inp.focus();
  const e2 = shell.key('z', { target: inp, metaKey: true });
  const e3 = shell.key('z', { target: inp, ctrlKey: true });
  inp.blur();
  await shell.tick(3);
  assert.equal(posts().length, n0, 'nothing posted');
  for (const e of [e1, e2, e3]) assert.equal(e.defaultPrevented, false, 'the browser keeps the key');
});

test('Mod+Z on the page posts once, with the item under the pointer and the device; the answer\'s note names the type and item', async () => {
  const n0 = posts().length;
  pointerOn(host().shadowRoot.querySelector('p'));
  const e = shell.key('z', { metaKey: true });
  await waitUntil(() => posts().length === n0 + 1, { timeout: 3000, what: 'the undo POST' });
  await shell.tick(3);
  assert.equal(e.defaultPrevented, true);
  assert.equal(posts().length, n0 + 1, 'one request');
  const body = posts()[n0].body;
  assert.equal(body.item, 'p1');
  assert.equal(typeof body.device, 'string', 'the chrome\'s device claim');
  assert.equal(noteText(), 'Undid highlight on p1');
});

test('the pointer off every item and no focus in one: no item is sent (the daemon takes the page-wide newest)', async () => {
  const n0 = posts().length;
  pointerOn($('topbar'));
  shell.key('z', { metaKey: true });
  await waitUntil(() => posts().length === n0 + 1, { timeout: 3000, what: 'the undo POST' });
  assert.equal(posts()[n0].body.item, undefined);
});

test('a 409 shows the daemon\'s hint', async () => {
  const hint = 'nothing you annotated here is live since the last commit';
  shell.setRoutes({ '/api/elements/undo': respond({ ok: false, error: 'nothing to undo', hint }, { status: 409 }) });
  try {
    const r = await U.undoLast();
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(noteText(), hint);
  } finally { shell.setRoutes({}); }
});

test('while a node is previewed Mod+Z posts nothing and shows READONLY_HINT', async () => {
  const n0 = posts().length;
  state.previewing = true;
  try {
    pointerOn(host().shadowRoot.querySelector('p'));
    shell.key('z', { metaKey: true });
    await shell.tick(3);
    assert.equal(posts().length, n0, 'nothing sent');
    assert.equal(noteText(), topbar.READONLY_HINT);
  } finally { state.previewing = false; }
});

test('below full (canWrite false) Mod+Z is the page\'s and the ⌘K row is absent', async () => {
  const n0 = posts().length;
  try {
    shell.setRoutes({ '/api/toolbar': { ...(await (await W.fetch('/api/toolbar')).json()), canWrite: false } });
    await TS.refreshToolbar();
    const e = shell.key('z', { metaKey: true });
    await shell.tick(3);
    assert.equal(e.defaultPrevented, false);
    assert.equal(posts().length, n0);
    const sh = await shell.importApp('shell.js');
    sh.openPalette();
    await waitUntil(() => $('cmd-list').querySelector('.palette-item'), { timeout: 3000, what: 'the palette rows' });
    assert.ok(![...$('cmd-list').querySelectorAll('.palette-item')].some((r) => r.textContent.includes(U.UNDO_LABEL)));
    sh.handleEscape();
  } finally {
    shell.setRoutes({});
    await TS.refreshToolbar();
  }
});

test('the ⌘K row, its key ⌘Z beside it, runs the undo', async () => {
  const sh = await shell.importApp('shell.js');
  const n0 = posts().length;
  sh.openPalette();
  await waitUntil(() => $('cmd-list').querySelector('.palette-item'), { timeout: 3000, what: 'the palette rows' });
  const rows = [...$('cmd-list').querySelectorAll('.palette-item')].filter((r) => r.textContent.includes(U.UNDO_LABEL));
  assert.equal(rows.length, 1, 'one row');
  assert.equal(rows[0].dataset.kind, 'command');
  const hint = rows[0].querySelector('.hint');
  assert.equal(hint && hint.textContent, '⌘Z', 'its key as the row\'s hint (a source row carries a hint, not a key column)');
  rows[0].dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await waitUntil(() => posts().length === n0 + 1, { timeout: 3000, what: 'the undo POST' });
  assert.equal($('cmd-palette').classList.contains('hidden'), true, 'the palette closed');
});

test('a user binding Shift+U → elements.undo adds a key; Mod+Z still answers', async () => {
  const n0 = posts().length;
  await shell.frame({ type: 'toolbar', v: 1, project: { v: 1, pinned: [], hidden: [], settings: {}, profiles: {} },
    user: { v: 1, bindings: { 'Shift+U': { kind: 'chrome', action: 'elements.undo' } }, fingerDraws: false, settings: {} },
    merged: { bindings: {}, settings: {} } });
  try {
    assert.deepEqual(hk.keysFor('elements.undo').sort(), ['⇧U', '⌘Z'].sort());
    shell.key('U', { shiftKey: true });
    await waitUntil(() => posts().length === n0 + 1, { timeout: 3000, what: 'the Shift+U POST' });
    shell.key('z', { metaKey: true });
    await waitUntil(() => posts().length === n0 + 2, { timeout: 3000, what: 'the Mod+Z POST' });
  } finally {
    await shell.frame({ type: 'toolbar', v: 1, project: { v: 1, pinned: [], hidden: [], settings: {}, profiles: {} },
      user: { v: 1, bindings: {}, fingerDraws: false, settings: {} }, merged: { bindings: {}, settings: {} } });
  }
});

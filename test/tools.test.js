// public/app/tools.js in the real chrome (annotation engine 2D.7, U337): slots
// and tool bindings resolved onto the overlay's ONE armed-tool state (K.2-3,
// K.2-14), the preview and level refusals, the slot-empty and not-installed
// notices (one chrome bus event, 'tools:notice'), and the hotkeys' 'slot' and
// 'tool' kinds and 'tools' default source (U333's seams).
//
// The toolbar read is test-support/chrome-shell.js's default /api/toolbar,
// GENERATED from the built-in element.json files: comment, highlight and box
// grab listed, pinned in that order by default. Fixture types ride a test's
// own answer.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { bootShell, helloFrame, DEFAULT_ROUTES } = require('../test-support/chrome-shell');

const NODES = [
  { id: 'n1', label: 'n1.0', parent_id: null, created_at: 1 },
  { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: 2 },
];
const BASE = DEFAULT_ROUTES['/api/toolbar'];
const PACK = { name: 'stickers', source: 'https://example.test/acme/stickers' };
const STICKER = {
  type: 'sticker', label: 'Sticker', pack: { name: 'fun', version: '1.0.0' }, builtin: false, icons: null,
  hotkeys: [{ action: 'arm', label: 'Sticker', default: 'C' }], settings: null, profiles: false, input: 'taps', installed: true,
};

let shell, W, tools, overlay, ts, hotkeys, topbar, bus, inputMode;
const notices = [];

// A toolbar answer: the generated default with these changes.
const answer = ({ project = {}, user = {}, ...rest } = {}) => ({
  ...BASE, ...rest, project: { ...BASE.project, ...project }, user: { ...BASE.user, ...user },
});
async function serve(body) {
  shell.setRoutes({ '/api/toolbar': body });
  await ts.refreshToolbar();
  await shell.tick();
}
const calls = (url, method) => shell.calls.filter((c) => c.url.split('?')[0] === url && (!method || c.method === method));
const armedType = () => { const a = overlay.armed(); return a ? a.type : null; };
const press = async (key, init = {}) => {
  W.document.dispatchEvent(new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  await shell.tick();
};

before(async () => {
  shell = await bootShell({
    routes: { '/api/graph': () => ({ nodes: NODES.map((n) => ({ ...n })), active: 'n2' }) },
  });
  W = shell.window;
  tools = await shell.importApp('tools.js');
  overlay = await shell.importApp('overlay.js');
  ts = await shell.importApp('toolbar-state.js');
  hotkeys = await shell.importApp('hotkeys.js');
  topbar = await shell.importApp('topbar.js');
  inputMode = await shell.importApp('input-mode.js');
  ({ bus } = await shell.importApp('bus.js'));
  bus.on(tools.NOTICE, (n) => notices.push(n));
  await shell.frame(helloFrame({ active: 'n2' }));
  await topbar.ensureGraph(true);
  await shell.tick(20);
});
after(() => shell.restore());

test('the chrome boots with the built-ins listed and pinned (the generated default answer); tools.js keeps no armed state of its own', async () => {
  assert.deepEqual(tools.listedTools().map((t) => t.type), ['comment', 'highlight', 'box-grab']);
  assert.deepEqual(ts.toolbarState().project.pinned, ['comment', 'highlight', 'box-grab']);
  for (const k of ['setArmed', 'armed', 'onArmedChange']) assert.equal(k in tools, false, `tools.js exports no ${k}`);
  assert.equal(armedType(), null);
});

test('armSlot(2) arms pinned[1]; armSlot(7) is the slot-empty notice; a slot resolves at press time to what the project pins now', async () => {
  notices.length = 0;
  assert.equal(tools.armSlot(2).ok, true);
  assert.equal(armedType(), 'highlight');
  const r = tools.armSlot(7);
  assert.equal(r.ok, false);
  assert.deepEqual(notices, [{ kind: 'slot-empty', text: 'Slot 7 is empty in this project' }]);
  assert.equal(armedType(), 'highlight', 'an empty slot leaves the armed tool alone');
  // The project re-pins (a toolbar frame): slot 1 now means box grab.
  await shell.frame({ type: 'toolbar', v: 1, project: { ...BASE.project, pinned: ['box-grab', 'comment'] }, user: BASE.user, merged: BASE.merged });
  tools.armSlot(1);
  assert.equal(armedType(), 'box-grab');
  tools.disarm();
  await serve(answer());
});

test('toggle on the armed tool puts it down; another profile of it switches instead; the pointer is setArmed(null)', async () => {
  tools.toggle({ kind: 'tool', type: 'highlight' });
  assert.deepEqual(overlay.armed(), { type: 'highlight', profile: null });
  tools.toggle({ kind: 'tool', type: 'highlight', profile: 'Wide' });
  assert.deepEqual(overlay.armed(), { type: 'highlight', profile: 'Wide' }, 'the profile is held in the overlay\'s one state (K.2-14)');
  tools.toggle({ kind: 'tool', type: 'highlight', profile: 'Wide' });
  assert.equal(overlay.armed(), null);
  tools.toggle({ kind: 'slot', n: 2 });
  assert.equal(armedType(), 'highlight');
  tools.toggle({ kind: 'slot', n: 2 });
  assert.equal(armedType(), null);
  tools.arm('comment');
  assert.equal(tools.arm(inputMode.POINTER).ok, true);
  assert.equal(overlay.armed(), null);
  tools.arm('comment');
  tools.toggle(inputMode.POINTER);
  assert.equal(overlay.armed(), null, 'the pointer is never "armed": toggling it leaves nothing armed');
});

test('a hidden tool is armed without pinning ("visiting"): no PATCH is sent', async () => {
  await serve(answer({ project: { pinned: ['comment', 'highlight'], hidden: ['box-grab'] } }));
  const before = calls('/api/toolbar', 'PATCH').length + calls('/api/toolbar/user', 'PATCH').length;
  assert.equal(tools.armTool('box-grab').ok, true);
  assert.equal(armedType(), 'box-grab');
  assert.equal(tools.visiting(), 'box-grab');
  tools.armTool('comment');
  assert.equal(tools.visiting(), null);
  await shell.tick(10);
  assert.equal(calls('/api/toolbar', 'PATCH').length + calls('/api/toolbar/user', 'PATCH').length, before, 'nothing is written');
  assert.deepEqual(ts.toolbarState().project.pinned, ['comment', 'highlight']);
  tools.disarm();
  await serve(answer());
});

test('a tool binding whose type is not listed is the not-installed notice: pack data only from the user record, and nothing reaches /api/packs', async () => {
  const userBinding = { kind: 'tool', type: 'sticker', label: 'Sticker', pack: PACK };
  await serve(answer({
    user: { bindings: { S: userBinding } },
    project: { bindings: { X: { kind: 'tool', type: 'nope' } } },
  }));
  const packsBefore = calls('/api/packs').length + shell.calls.filter((c) => c.url.startsWith('/api/packs/')).length;
  notices.length = 0;
  await press('s');
  await press('x');
  const own = ts.toolbarState().user.bindings.S;
  tools.arm(own);
  // The same data in an object that is not the user record's own: no pack.
  tools.arm({ ...own });
  assert.equal(armedType(), null, 'nothing is armed');
  assert.deepEqual(notices, [
    { kind: 'not-installed', text: 'Sticker is not installed in this project', type: 'sticker', label: 'Sticker', pack: PACK },
    { kind: 'not-installed', text: 'nope is not installed in this project', type: 'nope', label: 'nope' },
    { kind: 'not-installed', text: 'Sticker is not installed in this project', type: 'sticker', label: 'Sticker', pack: PACK },
    { kind: 'not-installed', text: 'Sticker is not installed in this project', type: 'sticker', label: 'Sticker' },
  ]);
  await shell.tick(10);
  assert.equal(calls('/api/packs').length + shell.calls.filter((c) => c.url.startsWith('/api/packs/')).length, packsBefore,
    'no request to /api/packs: a binding never installs');
  await serve(answer());
});

test('while previewing an older node a type tool is refused with the read-only notice; the pointer is still armable', async () => {
  tools.arm('comment');
  await topbar.previewNode('n1');
  await shell.tick(5);
  notices.length = 0;
  const r = tools.armTool('highlight');
  assert.equal(r.ok, false);
  assert.deepEqual(notices, [{ kind: 'read-only', text: 'Read-only while previewing n1.0', type: 'highlight' }]);
  assert.equal(tools.armSlot(1).ok, false, 'a slot too');
  assert.equal(tools.arm(inputMode.POINTER).ok, true);
  assert.equal(overlay.armed(), null);
  topbar.leavePreview({ activeId: 'n2', restoreSnapshot: true });
  await shell.tick(5);
  assert.equal(tools.armTool('highlight').ok, true, 'armable again on the live page');
  tools.disarm();
});

test('with canWrite false a type tool is refused with the view-only notice; the pointer is still armable', async () => {
  await serve(answer({ canWrite: false, canWriteUser: false }));
  notices.length = 0;
  assert.equal(tools.armTool('comment').ok, false);
  assert.deepEqual(notices, [{ kind: 'view-only', text: 'View only: tools need full access', type: 'comment' }]);
  assert.equal(tools.arm(null).ok, true);
  await serve(answer());
  assert.equal(tools.armTool('comment').ok, true);
  tools.disarm();
});

test('hotkeys: the digits arm the pinned slots in order; a user-tier tool binding arms its tool; pressing it again puts it down', async () => {
  await press('1');
  assert.equal(armedType(), 'comment');
  await press('3');
  assert.equal(armedType(), 'box-grab');
  await press('3');
  assert.equal(armedType(), null, 'the slot key again puts it down');
  notices.length = 0;
  await press('9');
  assert.deepEqual(notices, [{ kind: 'slot-empty', text: 'Slot 9 is empty in this project' }]);
  await serve(answer({ user: { bindings: { H: { kind: 'tool', type: 'highlight' } } } }));
  await press('h');
  assert.equal(armedType(), 'highlight');
  await press('h');
  assert.equal(armedType(), null);
  // A digit typed into a field arms nothing.
  const input = W.document.getElementById('cmd-input');
  input.focus();
  input.dispatchEvent(new W.KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
  await shell.tick();
  assert.equal(armedType(), null);
  input.blur();
  await serve(answer());
});

test('hotkeys: a manifest default the chrome already holds (C) is listed by conflicts() and left unbound; C still runs the chrome row', async () => {
  await serve(answer({ tools: [...BASE.tools, STICKER] }));
  const mine = hotkeys.conflicts().filter((c) => c.source === 'tools' && c.chord === 'C');
  assert.deepEqual(mine.map((c) => c.target.type).sort(), ['comment', 'sticker'],
    'comment\'s own C (until U338 moves the chrome row) and the fixture\'s');
  assert.ok(mine.every((c) => c.winner.source === 'chrome' && c.winner.target.action === 'chrome.comment'));
  const pin = () => W.document.body.classList.contains('pin-mode');
  const was = pin();
  await press('c');
  assert.equal(pin(), !was, 'C ran the chrome row');
  assert.equal(armedType(), null, 'and armed no tool');
  await press('c');
  assert.equal(pin(), was);
  // The slot defaults are the 'tools' source's, at the default tier.
  const view = hotkeys.bindingsView().filter((b) => /^[1-9]$/.test(b.chord));
  assert.deepEqual(view.map((b) => [b.chord, b.tier, b.target.kind, b.target.n]),
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), 'default', 'slot', n]));
  await serve(answer());
});

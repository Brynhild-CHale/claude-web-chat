// The chrome's one reader and writer of the toolbar records,
// public/app/toolbar-state.js (annotation engine 2D.2): a GET of /api/toolbar
// at init and after every hello, the daemon's `toolbar` frame, the two PATCHes
// through http.js (never a raw fetch), and settingsOf — a type's settings
// merged user default ⊕ project ⊕ named profile through tier-merge.
//
// Through the real shell (test-support/chrome-shell.js). main.js does not
// initialise the module yet (U333's line does), so `init` wires it with ws.js's
// own seams, as main.js will.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');

const REPO = path.resolve(__dirname, '..');

const PROJECT = {
  v: 1, pinned: ['comment', 'highlight'], hidden: ['box-grab'],
  settings: { highlight: { colour: 'rust' } },
  profiles: { highlight: [{ name: 'Wide', settings: { snap: 'blocks' } }] },
  bindings: { H: { kind: 'tool', type: 'highlight' } },
};
const USER = { v: 1, bindings: { P: { kind: 'chrome', action: 'chrome.push' } }, fingerDraws: false,
  settings: { highlight: { colour: 'gold', snap: 'words' } } };
const VIEW = { ok: true, v: 1, project: PROJECT, user: USER, merged: { bindings: {}, settings: {} }, canWrite: true, canWriteUser: true };

let shell, ts;
before(async () => {
  shell = await bootShell({
    routes: { '/api/toolbar': VIEW },
    init: async (s) => {
      const m = await s.importApp('toolbar-state.js');
      const ws = await s.importApp('ws.js');
      m.initToolbarState({ onFrame: ws.onFrame, onHello: ws.onHello });
      m.initToolbarState({ onFrame: ws.onFrame, onHello: ws.onHello }); // idempotent
    },
  });
  ts = await shell.importApp('toolbar-state.js');
});
after(() => shell && shell.restore());

const toolbarCalls = (method = 'GET') => shell.calls.filter((c) => c.url === '/api/toolbar' && c.method === method);
const settle = async () => { for (let i = 0; i < 4; i++) await shell.tick(); };

test('GET /api/toolbar once at init and once per hello', async () => {
  await settle();
  assert.equal(toolbarCalls().length, 1, 'once at init (the second init is a no-op)');
  assert.deepEqual(ts.toolbarState().project, PROJECT);
  await shell.frame(helloFrame());
  await settle();
  assert.equal(toolbarCalls().length, 2, 'once after the hello');
  await shell.frame(helloFrame());
  await settle();
  assert.equal(toolbarCalls().length, 3, 'and again after the next one');
});

test('a `toolbar` frame replaces the view and calls each subscriber once; canWrite stays the last GET\'s', async () => {
  shell.setRoutes({ '/api/toolbar': { ...VIEW, canWrite: false, canWriteUser: false } });
  await ts.refreshToolbar();
  assert.deepEqual([ts.toolbarState().canWrite, ts.toolbarState().canWriteUser], [false, false]);
  const seen = [];
  const off = ts.onToolbarChange((s) => seen.push(s));
  const next = { ...PROJECT, pinned: ['highlight'] };
  await shell.frame({ type: 'toolbar', v: 1, project: next, user: USER, merged: { bindings: {}, settings: {} } });
  off();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].project.pinned, ['highlight']);
  assert.equal(ts.toolbarState(), seen[0]);
  assert.deepEqual([seen[0].canWrite, seen[0].canWriteUser], [false, false], 'the frame carries no access of its own');
  await shell.frame({ type: 'toolbar', v: 1, project: PROJECT, user: USER, merged: {} });
  assert.equal(seen.length, 1, 'unsubscribed');
  shell.setRoutes({});
});

test('patchToolbar and patchUserToolbar go through http.js as PATCHes; a 403 comes back as {ok:false, refused, hint}, no throw', async () => {
  shell.setRoutes({ '/api/toolbar': (u, init) => (init && init.method === 'PATCH'
    ? { ...VIEW, project: { ...PROJECT, hidden: [] } } : VIEW) });
  const before = toolbarCalls('PATCH').length;
  const r = await ts.patchToolbar({ hidden: [] });
  assert.equal(r.ok, true);
  const sent = toolbarCalls('PATCH');
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1).body, { hidden: [] });
  assert.equal(sent.at(-1).headers['Content-Type'], 'application/json');
  assert.deepEqual(ts.toolbarState().project.hidden, [], 'an accepted write lands at once');

  const hint = 'hotkeys and settings for every project are set on the host';
  shell.setRoutes({ '/api/toolbar/user': respond({ ok: false, remote: true, hint }, { status: 403 }) });
  const u = await ts.patchUserToolbar({ fingerDraws: true });
  assert.deepEqual([u.ok, u.status, u.refused, u.hint], [false, 403, 'forbidden', hint]);
  assert.equal(shell.calls.filter((c) => c.url === '/api/toolbar/user' && c.method === 'PATCH').length, 1);
  shell.setRoutes({ '/api/toolbar': () => { throw new TypeError('Failed to fetch'); } });
  const gone = await ts.patchToolbar({ pinned: [] });
  assert.deepEqual([gone.ok, gone.refused], [false, 'network']);
  shell.setRoutes({});
});

test('settingsOf merges the user default under the project value, and a named profile over both', async () => {
  shell.setRoutes({ '/api/toolbar': VIEW });
  await ts.refreshToolbar();
  assert.deepEqual(ts.settingsOf('highlight'), { colour: 'rust', snap: 'words' });
  assert.deepEqual(ts.settingsOf('highlight', 'Wide'), { colour: 'rust', snap: 'blocks' });
  assert.deepEqual(ts.settingsOf('highlight', 'nope'), { colour: 'rust', snap: 'words' });
  assert.deepEqual(ts.settingsOf('box-grab'), {});
  shell.setRoutes({});
});

test('a bare {ok: true} answer reads as empty records and a writable tray', async () => {
  shell.setRoutes({ '/api/toolbar': { ok: true } });
  await ts.refreshToolbar();
  const s = ts.toolbarState();
  assert.deepEqual(s.project, { v: 1, pinned: [], hidden: [], settings: {}, profiles: {}, bindings: {} });
  assert.deepEqual(s.user, { v: 1, bindings: {}, fingerDraws: false, settings: {} });
  assert.deepEqual([s.canWrite, s.canWriteUser], [true, true]);
  shell.setRoutes({});
});

test('the module makes no raw fetch: every request goes through http.js', () => {
  const src = fs.readFileSync(path.join(REPO, 'public/app/toolbar-state.js'), 'utf8');
  assert.equal((src.match(/\bfetch\(/g) || []).length, 0);
  assert.match(src, /from '\.\/http\.js'/);
  assert.match(src, /from '\.\/tier-merge\.js'/);
});

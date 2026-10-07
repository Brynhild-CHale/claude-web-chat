// Turn actions: Restore files and Fork from here (public/app/turn-actions.js,
// spec §15.3 "The UI", §15.6, §15.5, §7.10), through the real shell
// (test-support/chrome-shell.js), with initAsks and initTurnActions passed in
// (main.js calls neither until U66a).
//
//   * the footers: 'Restore files' where the turn's code is ready and
//     capabilities.code_revert; 'Fork from here' where capabilities.fork, not
//     superseded, with a session id; neither below full, remotely with no
//     answer origin, or with the capability false (ruling B6 (a): not shown);
//   * Restore: #turn-action (a .popover, role dialog labelled by #ta-title)
//     reads GET /api/code/preview?turn=<id>&point=before and lists, as text,
//     what is rewritten, re-created, deleted and not covered (with reasons),
//     the HEAD-moved and "reverted too" lines, and ONE confirm frame named by
//     the row's own field (preview_id); blocked, 503, 404 and 429 answers
//     show their reasons and mount nothing; a previewed older node says it
//     changes files on disk now;
//   * done 'restored' closes the dialog and opens the toast's Undo frame
//     (restore_id=latest); 'failed' keeps the dialog and offers Undo; any
//     other outcome does nothing; Escape and wc:close-popovers dismiss both and
//     unmount their frames; the toast goes after 30 s (a stubbed timer) unless
//     hovered;
//   * Fork: a confirm frame for turn_id, the dialog kept open on 'forked';
//   * the inspector: 'Restore files' on a node with mirror turns, run reads
//     node=<id>; the U80 race (run(id, null)) requests nothing, opens nothing;
//   * stopTurnActions drops every button, frame, timer and popover;
//   * nothing here POSTs, writes the clipboard, or listens for Escape.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { isReservedId } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const T0 = Date.UTC(2026, 9, 7, 14, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const PORT = 4567;
const LOOP = `http://127.0.0.1:${PORT}`;
const XSS = '<img src=x onerror="window.__taPwned=1">.js';

let shell, W, doc, $, bus, S, A, TA, ws, gv, state;
let current = null;
let rev = 3000;
let convN = 0;
let cid = null;
const pages = new Map();
let previewAnswer = null;      // (url) => body | respond(...)
let taTimers;

class StubIO {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}

// Timers the test fires by hand (the toast's 30 s, asks.js's silence check).
function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimeout(fn, ms) { const id = ++n; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending: () => [...pending.values()].map((t) => t.ms),
    fire(ms) { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
  };
}

function snapshot(conversationId, { caps = { code_revert: true, fork: true }, access = { level: 'local', remote: false } } = {}) {
  return { v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: caps,
    primary: conversationId, aggregate: { state: 'idle' },
    conversations: [{ id: conversationId, rev: 1, headless: false, counts: ZERO,
      live: { state: 'idle', since: T0, last_activity_at: T0 } }], tasks: [], asks: [] };
}

function turn(id, seq, extra = {}) {
  return {
    id, rev: ++rev, conversation_id: cid, session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0 + seq * 60000, ended_at: T0 + seq * 60000 + 5000, duration_ms: 5000,
    counts: { items: 1, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: { id: `n${seq}`, label: `n1.${seq}`, role: 'commit' }, folded_into: null,
    code: { status: 'ready', files: 2, additions: 3, deletions: 1 },
    ...extra,
    items: [{ id: `p_${id}`, kind: 'prompt', text: `prompt ${id}`, origin: 'human', turn_id: id, seq: seq * 1000, ts: T0 + seq * 60000, rev }],
  };
}

// The fixture conversation: t1 ready; t2 code pending; t3 superseded (ready);
// t4 no session id (ready).
const TURNS = () => [
  turn('t1', 1),
  turn('t2', 2, { code: { status: 'pending' } }),
  turn('t3', 3, { superseded: true }),
  turn('t4', 4, { session_id: undefined }),
];

async function show({ caps, access, list = TURNS } = {}) {
  cid = `c${++convN}`;
  const built = list();
  pages.set(cid, { conversation_id: cid, turns: built, next_before: null, total: built.length, rev: ++rev });
  current = snapshot(cid, { caps, access });
  const want = current.rev;
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= want && S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
    && $('chat-stream').querySelectorAll('.ct-turn').length === built.length, { timeout: 3000, what: `the stream of ${cid}` });
  await shell.tick();
}

// The same conversation, a new snapshot: the drawn turns are unchanged, so only
// a re-registration redraws their footers.
async function resnap({ caps, access } = {}) {
  current = snapshot(cid, { caps, access });
  const want = current.rev;
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= want, { timeout: 3000, what: 'the snapshot' });
  await shell.tick();
}

const turnEl = (id) => $('chat-stream').querySelector(`.ct-turn[data-turn-id="${id}"]`);
const actionsOf = (id) => [...turnEl(id).querySelectorAll('.ct-foot .ct-action')].map((b) => b.textContent);
const action = (id, label) => [...turnEl(id).querySelectorAll('.ct-foot .ct-action')].find((b) => b.textContent === label);
const dialog = () => $('turn-action');
const isOpen = (e) => !!e && !e.classList.contains('hidden');
const framesIn = (e) => (e ? [...e.querySelectorAll('iframe.wc-answer-frame')] : []);
const allFrames = () => [...doc.querySelectorAll('iframe.wc-answer-frame')];
const toasts = () => [...doc.querySelectorAll('.ta-toast')];
const previewCalls = () => shell.calls.filter((c) => c.url.startsWith('/api/code/preview'));
const post = (frame, data) => W.dispatchEvent(new W.MessageEvent('message', { data, origin: LOOP, source: frame.contentWindow }));
const done = (frame, outcome, result) => post(frame, { type: 'wc-answer:done', outcome, ...(result ? { result } : {}) });
const frameUrl = (f) => new URL(f.src);

const PREVIEW = {
  ok: true, preview_id: 'pv_1',
  target: { turn_id: 't1', node_id: 'n1', label: 'n1.1', point: 'before', conversation_id: 'c1', at: T0 },
  written: [{ path: 'src/a.js', status: 'M' }, { path: XSS, status: 'T' }, { path: 'src/gone.js', status: 'A' }],
  deleted: ['src/new.js'],
  notCovered: [{ path: 'dist/out.js', reason: 'ignored' }, { path: 'big.bin', reason: 'over-cap' },
    { path: '../elsewhere/x', reason: 'outside' }, { path: 'vendor/sub/y', reason: 'nested-repo' }],
  headMoved: true,
  counts: { rewritten: 2, recreated: 1, deleted: 1, not_covered: 4 },
  blocked: null, notes: [],
};

// A fresh asks.js and turn-actions.js, as a page load would have them.
async function reset({ remote } = {}) {
  TA.stopTurnActions();
  A.stopAsks();
  A.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello, timers: fakeTimers(), ...(remote ? { remote } : {}) });
  await shell.tick();
  taTimers = fakeTimers();
  TA.initTurnActions({ timers: taTimers });
  await shell.tick();
}

async function openRestore(id = 't1') {
  const n = previewCalls().length;
  shell.press(action(id, 'Restore files'));
  await waitUntil(() => previewCalls().length > n, { timeout: 2000, what: 'the preview request' });
  await shell.tick();
}

async function closeEverything() {
  W.dispatchEvent(new W.CustomEvent('wc:close-popovers'));
  await shell.tick();
}

before(async () => {
  globalThis.IntersectionObserver = StubIO;
  previewAnswer = () => PREVIEW;
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        return pages.get(id) || { conversation_id: id, turns: [], next_before: null, total: 0, rev };
      },
      '/api/asks': () => ({ asks: [], answer: { port: PORT } }),
      '/api/code/preview': (url) => previewAnswer(url),
    },
    init: async (sh) => {
      ws = await sh.importApp('ws.js');
      A = await sh.importApp('asks.js');
      A.initAsks({ onFrame: ws.onFrame, onHello: ws.onHello, timers: fakeTimers() });
      (await sh.importApp('chat-dock.js')).initChatDock();
      (await sh.importApp('chat-panel.js')).initChatPanel();
      (await sh.importApp('chat-stream.js')).initChatStream();
      TA = await sh.importApp('turn-actions.js');
      taTimers = fakeTimers();
      TA.initTurnActions({ timers: taTimers });
      TA.initTurnActions({ timers: taTimers });   // idempotent
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  gv = await shell.importApp('graph-view.js');
  state = await shell.importApp('state.js');
  current = snapshot('c0');
  await shell.frame(helloFrame());
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
});

after(() => {
  if (TA) TA.stopTurnActions();
  delete globalThis.IntersectionObserver;
  return shell.restore();
});

/* ── the footers ─────────────────────────────────────────────────────────── */

test('the footers: Restore where the code is ready, Fork where not superseded and with a session id', async () => {
  await show();
  assert.deepEqual(actionsOf('t1'), ['Restore files', 'Fork from here']);
  assert.deepEqual(actionsOf('t2'), ['Fork from here'], 'code pending: no Restore');
  assert.deepEqual(actionsOf('t3'), ['Restore files'], 'superseded: no Fork');
  assert.deepEqual(actionsOf('t4'), ['Restore files'], 'no session id: no Fork');
  assert.equal(action('t1', 'Restore files').dataset.action, 'restore-files');
  assert.equal(action('t1', 'Fork from here').dataset.action, 'fork');
});

test('neither shows with the capability false, below full, or remotely with no answer origin; remote at full with one shows them', async () => {
  await show({ caps: { code_revert: false, fork: true } });
  assert.deepEqual(actionsOf('t1'), ['Fork from here'], 'code_revert false');
  await show({ caps: { code_revert: true, fork: false } });
  assert.deepEqual(actionsOf('t1'), ['Restore files'], 'fork false');
  await show({ caps: {} });
  assert.deepEqual(actionsOf('t1'), [], 'both false');
  await show({ access: { level: 'read', remote: true } });
  assert.deepEqual(actionsOf('t1'), [], 'remote below full');

  const remoteNoOrigin = { isRemote: async () => true, remoteNow: () => true, remoteKnown: () => true, answerOrigin: () => null };
  await reset({ remote: remoteNoOrigin });
  await show({ access: { level: 'full', remote: true } });
  assert.deepEqual(actionsOf('t1'), [], 'remote at full, no answer origin');

  await reset({ remote: { ...remoteNoOrigin, answerOrigin: () => 'https://wc-0123abcd-a.example.com' } });
  await show({ access: { level: 'full', remote: true } });
  assert.deepEqual(actionsOf('t1'), ['Restore files', 'Fork from here'], 'remote at full with the answer origin');

  await reset();
  await show();
  assert.deepEqual(actionsOf('t1'), ['Restore files', 'Fork from here'], 'local again');
});

test('a capability or access change redraws the drawn footers (the stream keys no redraw on them)', async () => {
  await show();
  const el = turnEl('t1');
  assert.deepEqual(actionsOf('t1'), ['Restore files', 'Fork from here']);
  await resnap({ caps: { code_revert: false, fork: false } });
  await waitUntil(() => actionsOf('t1').length === 0, { timeout: 2000, what: 'the buttons gone' });
  assert.equal(turnEl('t1'), el, 'the same turn, redrawn in place');
  await resnap();
  await waitUntil(() => actionsOf('t1').length === 2, { timeout: 2000, what: 'the buttons back' });
  await resnap({ access: { level: 'read', remote: true } });
  await waitUntil(() => actionsOf('t1').length === 0, { timeout: 2000, what: 'gone below full' });
  await resnap();
  await waitUntil(() => actionsOf('t1').length === 2, { timeout: 2000, what: 'back at local' });
  // A capabilities change that rebuilds no turn: only the re-registration
  // redraws the footers.
  const caps = S.mirror.capabilities;
  try {
    S.mirror.capabilities = Object.freeze({ ...caps, code_revert: false });
    bus.emit('mirror', { what: ['capabilities'] });
    await waitUntil(() => actionsOf('t1').length === 1, { timeout: 2000, what: 'Restore gone' });
    assert.equal(turnEl('t1'), el);
  } finally {
    S.mirror.capabilities = caps;
    bus.emit('mirror', { what: ['capabilities'] });
  }
  await waitUntil(() => actionsOf('t1').length === 2, { timeout: 2000, what: 'Restore back' });
});

/* ── Restore files ───────────────────────────────────────────────────────── */

test('Restore: #turn-action reads the preview for the turn at point=before and lists every path as text, with one confirm frame named preview_id', async () => {
  await reset();
  await show();
  previewAnswer = () => PREVIEW;
  await openRestore('t1');
  const d = dialog();
  assert.ok(isOpen(d), 'the dialog is open');
  assert.ok(d.classList.contains('popover'), 'a .popover: shell.js dismisses it');
  assert.equal(d.getAttribute('role'), 'dialog');
  assert.equal(d.getAttribute('aria-labelledby'), 'ta-title');
  assert.equal(d.parentNode, doc.body, 'outside #stage: live over the graph overlay');
  for (const id of ['turn-action', 'ta-title', 'ta-body', 'ta-confirm']) {
    assert.equal(doc.querySelectorAll(`#${id}`).length, 1, `one #${id}`);
    assert.ok(isReservedId(id), `#${id} is reserved`);
  }
  assert.equal($('ta-title').textContent, 'Restore files to before this turn');
  const last = previewCalls().at(-1);
  assert.equal(last.url, '/api/code/preview?turn=t1&point=before');
  assert.equal(last.method || 'GET', 'GET');

  const body = $('ta-body');
  const heads = [...body.querySelectorAll('.ta-list-head')].map((h) => h.textContent);
  assert.deepEqual(heads, ['Rewritten (2)', 'Re-created (1)', 'Deleted (1)', 'Not covered (4)']);
  const names = (i) => [...body.querySelectorAll('.ta-list')[i].querySelectorAll('.ta-path-name')].map((e) => e.textContent);
  assert.deepEqual(names(0), ['src/a.js', XSS]);
  assert.deepEqual(names(1), ['src/gone.js']);
  assert.deepEqual(names(2), ['src/new.js']);
  assert.equal(body.querySelector('img'), null, 'a path holding markup renders as text');
  assert.equal(W.__taPwned, undefined);
  const why = [...body.querySelectorAll('.ta-list')[3].querySelectorAll('.ta-path')].map((li) => li.textContent);
  assert.deepEqual(why, [
    'dist/out.jsignored by the project’s rules',
    'big.binover the size cap',
    '../elsewhere/xoutside the project',
    'vendor/sub/yinside a nested repository or worktree',
  ]);
  assert.match(body.textContent, /HEAD has moved since that turn/);
  assert.match(body.textContent, /Edits made since that turn, yours included, are reverted too\./);
  assert.doesNotMatch(body.textContent, /changes files on disk now/, 'not previewing: no on-disk line');
  assert.equal(body.querySelector('.ta-to-before, .ta-target').textContent, 'To before n1.1');

  const frames = framesIn($('ta-confirm'));
  assert.equal(frames.length, 1, 'one confirm frame');
  const u = frameUrl(frames[0]);
  assert.equal(u.origin, LOOP, 'on the answer origin');
  assert.equal(u.pathname, '/answer/control/restore');
  assert.equal(u.searchParams.get('preview_id'), 'pv_1', 'the row\'s own field name');
  assert.equal(u.searchParams.get('preview'), null);
  assert.equal(u.searchParams.get('layout'), 'confirm');
  assert.equal(frames[0].dataset.kind, 'control');
  await closeEverything();
  assert.ok(!isOpen(dialog()));
  assert.equal(allFrames().length, 0, 'closing unmounts its frame');
});

test('a blocked preview shows its reason and mounts no frame; Check again reads it afresh', async () => {
  previewAnswer = () => ({ ...PREVIEW, blocked: { reason: 'busy', hint: 'Claude is working: wait for the turn to end' } });
  await openRestore('t1');
  assert.ok(isOpen(dialog()));
  assert.equal(framesIn($('ta-confirm')).length, 0, 'no frame while blocked');
  assert.equal($('ta-confirm').querySelector('.ta-blocked').textContent, 'Not now: Claude is working: wait for the turn to end');
  assert.equal($('ta-body').querySelectorAll('.ta-list').length, 4, 'the lists still show');
  previewAnswer = () => PREVIEW;
  const n = previewCalls().length;
  shell.press($('ta-confirm').querySelector('.ta-again'));
  await waitUntil(() => previewCalls().length > n && framesIn($('ta-confirm')).length === 1, { timeout: 2000, what: 'the fresh preview' });
  await closeEverything();
});

test('503, 404 no-record, 429 and another refusal show their reasons and mount nothing', async () => {
  const cases = [
    [() => respond({ ok: false, unavailable: true, reason: 'git-too-old' }, { status: 503 }), 'Restoring files needs git 2.40 or newer.'],
    [() => respond({ ok: false, unavailable: true, reason: 'mystery' }, { status: 503 }), 'Restoring files is not available here (mystery).'],
    [() => respond({ ok: false, refused: 'no-record', hint: 'the turn changed no files, or its record is not ready' }, { status: 404 }), 'This turn changed no files.'],
    [() => respond({ ok: false, refused: 'rate_limited', hint: 'x' }, { status: 429 }), 'A preview is already being made: try again in a moment.'],
    [() => respond({ ok: false, refused: 'tree-missing', hint: 'the snapshot was pruned (trees are kept 7 days)' }, { status: 410 }), 'The snapshot was pruned (trees are kept 7 days)'],
  ];
  for (const [answer, text] of cases) {
    previewAnswer = answer;
    await openRestore('t1');
    assert.ok(isOpen(dialog()));
    assert.equal($('ta-body').textContent, text);
    assert.equal(allFrames().length, 0, `no frame: ${text}`);
    await closeEverything();
  }
  previewAnswer = () => PREVIEW;
});

test('a previewed older node adds "This changes files on disk now"', async () => {
  const v = state.view;
  const saved = { previewing: v.previewing, viewedId: v.viewedId, activeId: v.activeId };
  Object.assign(v, { previewing: true, viewedId: 'n0', activeId: 'n1' });
  try {
    await openRestore('t1');
    assert.equal($('ta-body').querySelector('.ta-on-disk').textContent, 'This changes files on disk now, not the node you are viewing.');
  } finally {
    Object.assign(v, saved);
    await closeEverything();
  }
});

/* ── done ─────────────────────────────────────────────────────────────────── */

test('done \'restored\' closes the dialog and opens the toast with an Undo frame for restore_id=latest; Escape dismisses it and unmounts it', async () => {
  await openRestore('t1');
  const [frame] = framesIn($('ta-confirm'));
  done(frame, 'restored', { rewritten: 2 });
  await shell.tick();
  assert.ok(!isOpen(dialog()), 'the dialog closed');
  assert.equal(framesIn(dialog()).length, 0, 'and its frame went');
  const [t] = toasts();
  assert.ok(t, 'the toast');
  assert.ok(t.classList.contains('popover'));
  assert.equal(t.id, '', 'no id');
  assert.equal(t.querySelector('.ta-toast-text').textContent, 'Files restored.');
  const [undo] = framesIn(t);
  const u = frameUrl(undo);
  assert.equal(u.pathname, '/answer/control/undo');
  assert.equal(u.searchParams.get('restore_id'), 'latest');
  assert.equal(u.searchParams.get('restore'), null);
  assert.equal(u.searchParams.get('size'), 'compact');
  assert.equal(u.searchParams.get('layout'), 'confirm');
  assert.deepEqual(taTimers.pending(), [TA.TOAST_MS]);
  assert.equal(TA.TOAST_MS, 30000);

  done(undo, 'undone');
  await shell.tick();
  assert.equal(toasts().length, 1, 'undone: the frame shows its own result');

  shell.key('Escape');
  await shell.tick();
  assert.equal(toasts().length, 0, 'Escape dismissed it');
  assert.equal(allFrames().length, 0, 'its frame unmounted');
  assert.deepEqual(taTimers.pending(), [], 'its timer cleared');
});

test('Escape and wc:close-popovers dismiss the dialog and unmount its frame', async () => {
  await openRestore('t1');
  assert.equal(allFrames().length, 1);
  shell.key('Escape');
  await shell.tick();
  assert.ok(!isOpen(dialog()), 'Escape closed it');
  assert.equal(allFrames().length, 0);
  await openRestore('t1');
  assert.ok(isOpen(dialog()));
  await closeEverything();
  assert.ok(!isOpen(dialog()), 'closeAllPopovers closed it');
  assert.equal(allFrames().length, 0);
  // Its own ✕ too.
  await openRestore('t1');
  shell.press(dialog().querySelector('.ta-close'));
  await shell.tick();
  assert.ok(!isOpen(dialog()));
  assert.equal(allFrames().length, 0);
});

test('the toast closes itself after 30 s, not while hovered; leaving starts the count again', async () => {
  await openRestore('t1');
  done(framesIn($('ta-confirm'))[0], 'restored');
  await shell.tick();
  const [t] = toasts();
  t.dispatchEvent(new W.MouseEvent('mouseenter'));
  assert.deepEqual(taTimers.pending(), [], 'hovered: no countdown');
  taTimers.fire(TA.TOAST_MS);
  assert.equal(toasts().length, 1);
  t.dispatchEvent(new W.MouseEvent('mouseleave'));
  assert.deepEqual(taTimers.pending(), [TA.TOAST_MS], 'left: counting again');
  taTimers.fire(TA.TOAST_MS);
  await shell.tick();
  assert.equal(toasts().length, 0, 'gone after 30 s');
  assert.equal(allFrames().length, 0);
});

test('done \'failed\' keeps the dialog on its result and offers Undo; an outcome outside U85\'s names, or \'refused\', does nothing', async () => {
  await openRestore('t1');
  const [frame] = framesIn($('ta-confirm'));
  for (const o of ['interrupted', 'bogus', 'forked', 'refused']) done(frame, o);
  await shell.tick();
  assert.ok(isOpen(dialog()), 'still open');
  assert.equal(framesIn($('ta-confirm'))[0], frame, 'the same frame');
  assert.equal(toasts().length, 0, 'no toast');

  done(frame, 'failed', { residual: 1 });
  await shell.tick();
  assert.ok(isOpen(dialog()), 'failed: the dialog stays');
  assert.equal(framesIn($('ta-confirm'))[0], frame);
  const [t] = toasts();
  assert.ok(t, 'with the toast');
  assert.equal(frameUrl(framesIn(t)[0]).searchParams.get('restore_id'), 'latest');
  await closeEverything();
  assert.equal(toasts().length, 0);
  assert.equal(allFrames().length, 0);
});

/* ── Fork from here ──────────────────────────────────────────────────────── */

test('Fork: the dialog explains, mounts a confirm frame for turn_id, and stays open on \'forked\'', async () => {
  const n = previewCalls().length;
  shell.press(action('t1', 'Fork from here'));
  await shell.tick();
  assert.ok(isOpen(dialog()));
  assert.equal($('ta-title').textContent, 'Fork from here');
  const text = $('ta-body').textContent;
  assert.match(text, /new conversation from before this turn n1\.1/);
  assert.match(text, /original conversation is kept, and no files change/);
  assert.match(text, /paste the command/);
  assert.equal(previewCalls().length, n, 'no preview for a fork');
  const frames = framesIn($('ta-confirm'));
  assert.equal(frames.length, 1);
  const u = frameUrl(frames[0]);
  assert.equal(u.pathname, '/answer/control/fork');
  assert.equal(u.searchParams.get('turn_id'), 't1', 'the row\'s own field name');
  assert.equal(u.searchParams.get('turn'), null);
  assert.equal(frames[0].getAttribute('allow'), 'clipboard-write', 'the frame\'s own Copy');
  done(frames[0], 'forked');
  await shell.tick();
  assert.ok(isOpen(dialog()), 'it stays on the command');
  assert.equal(framesIn($('ta-confirm'))[0], frames[0]);
  assert.equal(toasts().length, 0);
  await closeEverything();
  assert.equal(allFrames().length, 0);
});

/* ── the graph inspector ─────────────────────────────────────────────────── */

test('the inspector: Restore files on a node with mirror turns reads node=<id>; the U80 race (a null node) requests nothing and opens nothing', async () => {
  let gate = null;
  const nodes = [
    { id: 'n1', label: 'n1', parent_id: null, created_at: T0 },
    { id: 'n2', label: 'n1.1', parent_id: 'n1', created_at: T0 + 1000 },
    { id: 'n3', label: 'n1.2', parent_id: 'n2', created_at: T0 + 2000 },
  ];
  shell.setRoutes({
    '/api/graph': { nodes, active: 'n3' },
    '/api/graph/node/*': async (url) => {
      const id = decodeURIComponent(url.split('?')[0].split('/').pop());
      if (id === 'n3' && gate) await gate;
      const n = nodes.find((x) => x.id === id) || { id };
      return { ...n, mounts: [], store: {}, ...(id === 'n2' ? { mirror: { v: 1, turns: [{ turn_id: 't1', role: 'commit' }] } } : {}) };
    },
  });
  await shell.frame(helloFrame({ active: 'n3' }));
  await gv.openOverlay();
  try {
    const btn = () => $('gv-inspector').querySelector('[data-act="x:restore-files"]');
    await gv.selectNode('n1');
    await shell.tick();
    assert.equal(btn(), null, 'no mirror turns: no Restore');
    await gv.selectNode('n2');
    await shell.tick();
    const b = btn();
    assert.ok(b, 'a node with mirror turns shows it');
    assert.equal(b.textContent, 'Restore files');
    assert.equal(b.title, 'Restore files to before this node');

    const n = previewCalls().length;
    shell.press(b);
    await waitUntil(() => previewCalls().length > n, { timeout: 2000, what: 'the node preview' });
    await shell.tick();
    assert.equal(previewCalls().at(-1).url, '/api/code/preview?node=n2&point=before');
    assert.ok(isOpen(dialog()));
    assert.equal($('ta-title').textContent, 'Restore files to before this node');
    assert.equal(framesIn($('ta-confirm')).length, 1);
    await closeEverything();
    assert.equal(allFrames().length, 0);

    // The race: n3's node is still loading when the user clicks n2's button.
    await gv.selectNode('n2');
    await shell.tick();
    let release;
    gate = new Promise((r) => { release = r; });
    const pending = gv.selectNode('n3');
    await shell.tick();
    const stale = btn();
    assert.ok(stale, 'the old panel still shows its button');
    const before_ = previewCalls().length;
    shell.press(stale);
    await shell.tick();
    assert.equal(previewCalls().length, before_, 'no request');
    assert.ok(!isOpen(dialog()), 'no dialog');
    assert.equal(allFrames().length, 0);
    release();
    await pending;

    // stopTurnActions takes the painted inspector button away.
    await gv.selectNode('n2');
    await shell.tick();
    assert.ok(btn());
    TA.stopTurnActions();
    assert.equal(btn(), null, 'the inspector dropped its button');
    TA.initTurnActions({ timers: taTimers });
  } finally {
    await gv.closeOverlay?.();
    shell.setRoutes({});
    await shell.tick();
  }
});

/* ── stop, and what is never done ────────────────────────────────────────── */

test('stopTurnActions drops the footers\' and the inspector\'s buttons and leaves no frame, timer or popover', async () => {
  await reset();
  await show();
  await openRestore('t1');
  done(framesIn($('ta-confirm'))[0], 'failed');
  await shell.tick();
  assert.equal(allFrames().length, 2, 'the dialog\'s and the toast\'s');
  TA.stopTurnActions();
  await waitUntil(() => actionsOf('t1').length === 0, { timeout: 2000, what: 'the footer buttons gone' });
  assert.equal(dialog(), null, 'the dialog is gone');
  assert.equal(toasts().length, 0);
  assert.equal(allFrames().length, 0);
  assert.deepEqual(taTimers.pending(), []);
  assert.equal(doc.querySelectorAll('.popover.ta-dialog, .popover.ta-toast').length, 0);
  // Back, for any later test.
  TA.initTurnActions({ timers: taTimers });
  await shell.tick();
  await waitUntil(() => actionsOf('t1').length === 2, { timeout: 2000, what: 'the buttons back' });
});

test('the source: no POST, no clipboard write, no Escape or outside-click listener, no innerHTML', () => {
  const src = read('public/app/turn-actions.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.doesNotMatch(src, /method\s*:\s*['"]POST/i);
  assert.doesNotMatch(src, /clipboard/i);
  assert.doesNotMatch(src, /keydown|keyup|'Escape'|"Escape"/);
  assert.doesNotMatch(src, /addEventListener\(\s*['"](pointerdown|mousedown)/);
  assert.doesNotMatch(src, /document\.addEventListener|window\.addEventListener/);
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(src, /setInterval/);
  const posts = shell.calls.filter((c) => (c.method || 'GET').toUpperCase() !== 'GET' && /\/api\/(code|control)/.test(c.url));
  assert.deepEqual(posts, [], 'nothing posted to an acting route');
});

test('app.css: the U86 section styles the dialog, the lists and the toast from tokens only, on the scale\'s rungs', () => {
  const css = read('public/app.css');
  const at = css.indexOf('/* ── U86 ·');
  const end = css.indexOf('/* ── U', at + 10);
  assert.ok(at > 0 && end > at, 'the U86 section');
  const section = css.slice(at, end).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['.popover.ta-dialog', '.popover.ta-toast', '.ta-paths', '.ta-path-name']) {
    assert.ok(section.includes(sel), `styles ${sel}`);
  }
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b/, 'no hex colour');
  assert.doesNotMatch(section, /\b(rgb|rgba|hsl|hsla)\(/, 'no literal colour');
  for (const m of section.matchAll(/z-index\s*:\s*([^;]+)/g)) assert.match(m[1].trim(), /^var\(--z-[a-z]+\)$/, 'a rung of the scale');
  assert.doesNotMatch(section, /wc-answer-frame[^{]*\{[^}]*(opacity|filter|transform|clip|mask)/, 'nothing dims a control frame');
});

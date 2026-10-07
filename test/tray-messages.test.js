// A queued composer message in the queue tray (design spec §7.6; U62):
// chat-present.js builds Edit (and, on the first staged message, Send now)
// under capabilities.queue_message at level `full`, chat-rows.js draws them
// because chat-actions.js canRun()s them, and runAction performs them through
// queue.js — Edit as an inline editor in the row's body (Save → PATCH, Escape
// or Cancel → no request, a refusal's hint in the row's note, the editor kept),
// Send now as POST /api/queue/push {ids: [id]}. The stop path (registerStopper
// and the inline confirm, U46b) is unchanged beside them.
const test = require('node:test');
const { before, after, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const T = Date.now();
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, S, Q, A, trays, $;
let current = null;
let rev = 5000;
const daemon = { items: [], answers: {} };

const conversation = (id) => ({ id, rev: 1, title: `title of ${id}`, headless: false, counts: ZERO,
  live: { state: 'working', since: T - 60000, last_activity_at: T - 1000 } });
const SHELL = { id: 's1', kind: 'shell', conversation_id: 'c1', title: 'npm run dev', status: 'running',
  started_at: T - 600000, line: 'ready' };

function snapshot({ level = 'local', caps = { queue_message: true, task_stop: true }, tasks = [SHELL] } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: level !== 'basic', access: { level, remote: false },
    capabilities: caps, primary: 'c1', aggregate: { state: 'working' }, conversations: [conversation('c1')], tasks, asks: [] };
}

const MID = (n) => `m-${String(n).padStart(8, '0')}`;
const msg = (n, over = {}) => ({ id: `q${n}`, kind: 'message', msg_id: MID(n), conversation_id: 'c1',
  text: `words of message ${n}`, skill: null, files: [], chars: 18, autosend: true, staged: true, source: 'composer',
  why_wake: 'message from the user', summary: 'message · 18 chars', device: 'desktop', enqueued_at: T + n, ...over });
const signal = (n) => ({ id: `s${n}`, kind: 'signal', source: 'pane', summary: `form_submit #${n}`, staged: true, enqueued_at: T + n });

function route(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const p = url.split('?')[0];
  if (p === '/api/queue' && method === 'GET') return { items: daemon.items, count: daemon.items.length, receipts: [] };
  if (p === '/api/queue/pending') return { pending: null };
  const a = daemon.answers[`${method} ${p}`];
  if (typeof a === 'function') return a(url, init);
  if (a !== undefined) return a;
  return { ok: true };
}

const calls = (method, url) => shell.calls.filter((c) => c.method === method && c.url === url);
const rows = () => [...$('cs-tray-rows').children];
const trayRow = (id) => rows().find((r) => r.dataset.rowId === id);
const actions = (el) => [...el.querySelectorAll('.cs-row-actions button')].map((b) => b.textContent);
const act = (el, id) => el.querySelector(`.cs-row-actions [data-action="${id}"]`);
const note = (el) => el.querySelector('.cs-row-note');
const editor = (el) => el.querySelector('.cs-row-body .cs-edit');

async function show({ items, ...over } = {}) {
  current = snapshot(over);
  daemon.items = items || [msg(1), msg(2), signal(3)];
  Q.foldQueueFrame({ type: 'queue', op: 'clear' });
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= current.rev, { timeout: 2000 });
  await Q.hydrateQueue();
  await shell.tick();
  trays.openTray('queue');
  await shell.tick();
}

before(async () => {
  shell = await bootShell({
    routes: { '/api/mirror': () => current, '/api/queue*': route },
    init: async (sh) => {
      current = snapshot();
      const t = await sh.importApp('chat-trays.js');
      t.initChatTrays();
    },
  });
  S = await shell.importApp('chat-state.js');
  Q = await shell.importApp('queue.js');
  A = await shell.importApp('chat-actions.js');
  trays = await shell.importApp('chat-trays.js');
  $ = shell.$;
});

after(() => shell.restore());

afterEach(() => {
  daemon.answers = {};
  trays.closeTray({ returnFocus: false });
});

test('with capabilities.queue_message at full: Edit on every message, Send now on the first staged one', async () => {
  await show();
  assert.deepEqual(actions(trayRow('q1')), ['Edit', 'Send now', 'Remove']);
  assert.deepEqual(actions(trayRow('q2')), ['Edit', 'Remove']);
  assert.deepEqual(actions(trayRow('s3')), ['Hold', 'Remove'], 'a signal row is as it was');
  await show({ caps: { task_stop: true } });
  assert.deepEqual(actions(trayRow('q1')), ['Remove'], 'without the capability: no Edit, no Send now');
});

test('canRun(\'edit\' | \'send-now\') is false on a task row and on a signal row', () => {
  const task = { id: 's1', kind: 'shell', cat: 'shells', actions: [] };
  const sig = { id: 's3', kind: 'signal', cat: 'queue', actions: [] };
  for (const id of ['edit', 'send-now']) {
    assert.equal(A.canRun(id, task), false, `${id} on a task row`);
    assert.equal(A.canRun(id, sig), false, `${id} on a signal row`);
    assert.equal(A.canRun(id, { id: 'q1', kind: 'message', cat: 'queue', actions: [] }), true, `${id} on a message row`);
  }
});

test('Edit opens a textarea prefilled with the text; Save PATCHes once and closes it', async () => {
  await show();
  const el = trayRow('q1');
  shell.click(act(el, 'edit'));
  const box = editor(el);
  assert.ok(box, 'the editor, in the row\'s body');
  assert.equal(el.querySelector('.cs-row-body').hidden, false);
  const area = box.querySelector('.cs-edit-text');
  assert.equal(area.value, 'words of message 1');
  assert.deepEqual([...box.querySelectorAll('button')].map((b) => b.textContent), ['Save', 'Cancel']);
  area.value = 'better words';
  const n = calls('PATCH', '/api/queue/q1').length;
  shell.click(box.querySelector('.cs-edit-save'));
  await waitUntil(() => !editor(el), { timeout: 2000 });
  const sent = calls('PATCH', '/api/queue/q1');
  assert.equal(sent.length, n + 1, 'one PATCH');
  assert.deepEqual(sent.at(-1).body, { text: 'better words' });
  assert.equal(el.querySelector('.cs-row-body').hidden, true);
});

test('Enter saves; Shift+Enter does not; Escape reverts with no request', async () => {
  await show();
  const el = trayRow('q1');
  shell.click(act(el, 'edit'));
  const area = editor(el).querySelector('.cs-edit-text');
  const n = calls('PATCH', '/api/queue/q1').length;
  const shift = shell.key('Enter', { target: area, shiftKey: true });
  assert.equal(shift.defaultPrevented, false, 'Shift+Enter breaks the line');
  assert.equal(calls('PATCH', '/api/queue/q1').length, n);
  const esc = shell.key('Escape', { target: area });
  assert.ok(!editor(el), 'Escape reverts');
  assert.equal(esc.defaultPrevented, true);
  await shell.tick();
  assert.equal(calls('PATCH', '/api/queue/q1').length, n, 'no request');
  assert.ok($('cs-tray') && !$('cs-tray').classList.contains('hidden'), 'Escape left the editor, not the tray');

  shell.click(act(el, 'edit'));
  shell.click(editor(el).querySelector('.cs-edit-cancel'));
  assert.ok(!editor(el), 'Cancel reverts');
  await shell.tick();
  assert.equal(calls('PATCH', '/api/queue/q1').length, n, 'no request');

  shell.click(act(el, 'edit'));
  const a2 = editor(el).querySelector('.cs-edit-text');
  a2.value = 'sent by Enter';
  shell.key('Enter', { target: a2 });
  await waitUntil(() => calls('PATCH', '/api/queue/q1').length === n + 1, { timeout: 2000 });
  assert.deepEqual(calls('PATCH', '/api/queue/q1').at(-1).body, { text: 'sent by Enter' });
});

test('a not_editable refusal shows its hint in .cs-row-note and keeps the editor', async () => {
  await show();
  daemon.answers['PATCH /api/queue/q1'] = { ok: false, refused: 'not_editable', hint: 'This message has already gone.' };
  const el = trayRow('q1');
  shell.click(act(el, 'edit'));
  shell.click(editor(el).querySelector('.cs-edit-save'));
  await waitUntil(() => note(el).hidden === false, { timeout: 2000 });
  assert.equal(note(el).textContent, 'This message has already gone.');
  assert.ok(editor(el), 'the editor stays open');
  assert.equal(editor(el).querySelector('.cs-edit-save').disabled, false, 'and can be tried again');
  shell.key('Escape', { target: editor(el).querySelector('.cs-edit-text') });
  assert.equal(note(el).hidden, true, 'reverting clears the note');
});

test('Send now posts push {ids: [id]} and shows the waiting hint', async () => {
  await show();
  daemon.answers['POST /api/queue/push'] = { ok: true, pushed: 1, mode: 'queued', waiting: 'parked_message', waiting_ids: ['q1'] };
  const el = trayRow('q1');
  shell.click(act(el, 'send-now'));
  await waitUntil(() => note(el).hidden === false, { timeout: 2000 });
  assert.deepEqual(calls('POST', '/api/queue/push').at(-1).body, { ids: ['q1'], device: 'desktop' });
  assert.equal(note(el).textContent, 'Waits: a message is already parked for your next prompt');
  assert.equal(note(el).dataset.tone, 'info');

  daemon.answers['POST /api/queue/push'] = { ok: false, refused: 'forbidden', hint: 'Sending a message needs full access.' };
  shell.click(act(el, 'send-now'));
  await waitUntil(() => note(el).textContent === 'Sending a message needs full access.', { timeout: 2000 });
  assert.equal(note(el).dataset.tone, undefined, 'a refusal is in the refusal ink');
});

test('the stop path is unchanged: Kill with a registered stopper mounts it and posts nothing; with none the inline confirm posts', async () => {
  await show({ items: [msg(1)] });
  trays.openTray('shells');
  await shell.tick();
  const el = trayRow('s1');
  const mounts = [];
  const off = A.registerStopper({
    mount(slot, row, opts) { mounts.push({ slot, row, opts }); const b = shell.document.createElement('button'); b.className = 'tray-test-stopper'; slot.append(b); return true; },
    unmount() {},
  });
  const before0 = calls('POST', '/api/queue/task-stop').length;
  try {
    shell.click(act(el, 'kill'));
    assert.equal(mounts.length, 1, 'the stopper mounted');
    assert.equal(mounts[0].row.id, 's1');
    assert.deepEqual(mounts[0].opts, { density: 'compact' });
    assert.ok(el.querySelector('.cs-row-confirm .tray-test-stopper'));
    await shell.tick();
    assert.equal(calls('POST', '/api/queue/task-stop').length, before0, 'no task-stop POST');
    shell.key('Escape', { target: el.querySelector('.tray-test-stopper') });
  } finally { off(); }
  shell.click(act(el, 'kill'));
  const yes = el.querySelector('.cs-confirm-yes');
  assert.ok(yes, 'the inline confirm');
  shell.click(yes);
  await waitUntil(() => calls('POST', '/api/queue/task-stop').length === before0 + 1, { timeout: 2000 });
  assert.deepEqual(calls('POST', '/api/queue/task-stop').at(-1).body, { task_id: 's1' });
});

test('touch density: the editor\'s textarea is at least 44px and its buttons 40px (app.css, the U62 section)', () => {
  const css = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
  const start = css.indexOf('/* ── U62 ·');
  const end = css.indexOf('/* ── U65 ·');
  assert.ok(start > 0 && end > start, 'the U62 section');
  const sec = css.slice(start, end);
  const rule = (sel) => {
    const i = sec.indexOf(sel + ' {');
    assert.ok(i >= 0, `a rule for ${sel}`);
    return sec.slice(i, sec.indexOf('}', i));
  };
  const px = (decls, prop) => Number((new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+)px`).exec(decls) || [])[1]);
  assert.ok(px(rule('.cs-row[data-density="touch"] .cs-edit-text'), 'min-height') >= 44);
  assert.ok(px(rule('.cs-row[data-density="touch"] :is(.cs-edit-save, .cs-edit-cancel)'), 'height') >= 40);
  assert.doesNotMatch(sec.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b/, 'tokens, no hex');
  assert.match(sec, /prefers-reduced-motion/);
});

test('a touch-density row opens the same editor (rowEl at touch, runAction with density touch)', async () => {
  await show();
  const R = await shell.importApp('chat-rows.js');
  const P = await shell.importApp('chat-present.js');
  const entry = P.categories(S.mirror, Q.queueSnapshot()).find((c) => c.cat === 'queue');
  const model = entry.rows.find((r) => r.id === 'q1');
  const el = R.rowEl(model, { density: 'touch' });
  document.body.append(el);
  try {
    assert.equal(A.runAction(model, 'edit', { rowEl: el, density: 'touch' }), true);
    assert.equal(el.dataset.density, 'touch');
    assert.equal(editor(el).querySelector('.cs-edit-text').value, 'words of message 1');
  } finally { el.remove(); }
});

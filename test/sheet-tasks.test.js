// The phone sheet's Tasks view (public/app/chat-sheet-tasks.js, U69's section of
// app.css), through the real shell (test-support/chrome-shell.js) at 390×844:
// design spec §8.6, §8.4 (chat:tasks), §7.6 (the rows, the one confirm at the
// touch density), §7.12 (the detail views in the Tasks stack), §6.9,
// deviation 18, rulings E1 (a) (the stopper's touch slot) and B3 (a) (detail
// pages inside the Tasks stack; a detail's Cancel takes two taps there).
//
// main.js does not start the sheet or its Tasks view until U73 wires them, so
// the boot's init does. The store reads the Final's fixture
// (test-support/final-fixture.js, U67); #topbar and #bottombar get rectangles
// (shell.scrollMetrics) so the available height is 644 (full 622, half 341), as
// in test/chat-sheet.test.js.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { finalFixture } = require('../test-support/final-fixture');

const REPO = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'public/app/chat-sheet-tasks.js'), 'utf8');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const FOLLOW = 40;                                  // the detail views' followMs, set at boot
const settle = (ms = FOLLOW * 4) => new Promise((r) => setTimeout(r, ms));

let mirrorBody = null;
let queueBody = { items: [], count: 0 };
let outputText = 'ready in 412 ms\n';

let shell, W, $, bus, sheet, tasks, actions, model, detail, trays, S, Q;

const fixture = (o = {}) => finalFixture({ now: Date.now(), ...o });
const clone = (v) => JSON.parse(JSON.stringify(v));

// A (re)connect: the hello, then GET /api/mirror and GET /api/queue; then the frames.
// The queue's items go without enqueued_at: the rail's hydrate keeps a local
// item newer than the snapshot's newest, and an emptied queue must drop them.
async function show(body, queue) {
  mirrorBody = body;
  if (queue) {
    queueBody = { ...queue, items: (queue.items || []).map((it) => { const { enqueued_at: _, ...rest } = it; return rest; }) };
  }
  let read = false;
  const off = bus.on('mirror', (d) => { if (d && Array.isArray(d.what) && d.what.includes('all')) read = true; });
  try {
    await shell.frame(helloFrame());
    await waitUntil(() => read, { timeout: 5000, what: 'the store to read GET /api/mirror' });
    const want = Array.isArray(queueBody.items) ? queueBody.items.length : 0;
    await waitUntil(() => Q.queueSnapshot().count === want, { timeout: 5000, what: 'the queue to read GET /api/queue' });
  } finally { off(); }
  await shell.tick();
  await shell.tick();
}

async function showFinal(o) {
  const { mirrorBody: body, queueBody: q } = fixture(o);
  await show(body, q);
  return body;
}

// #topbar's bottom at 44, #bottombar's top at 44 + avail.
function layout(avail = 644) {
  shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: 390 } });
  shell.scrollMetrics($('bottombar'), { rect: { top: 44 + avail, height: 60, width: 390 } });
}

const root = () => $('sh-tasks').querySelector('.sh-root');
const lines = () => [...root().querySelectorAll('.sh-line')];
const line = (cat) => lines().find((l) => l.dataset.csCat === cat);
const txt = (el, sel) => { const e = el.querySelector(sel); return e && !e.hidden ? e.textContent : ''; };
const pages = () => [...$('sh-tasks').querySelectorAll('.sh-page')];
const topPage = () => pages().filter((p) => !p.hidden).pop() || null;
const rowsOf = (page) => [...page.querySelectorAll('.sh-rows > .cs-row')];
const rowOf = (page, id) => rowsOf(page).find((r) => r.dataset.rowId === id);
const act = (row, id) => row.querySelector(`.cs-row-actions [data-action="${id}"]`);
const calls = (part) => shell.calls.filter((c) => c.url.includes(part));
const stops = () => shell.calls.filter((c) => c.url === '/api/queue/task-stop' && c.method === 'POST');

async function openTasks() {
  sheet.openSheet({ view: 'tasks' });
  await shell.tick();
  assert.equal(sheet.sheetState().view, 'tasks');
  assert.ok(root(), 'the Tasks root is drawn');
}

async function tapLine(cat) {
  shell.click(line(cat));
  await shell.tick();
  return topPage();
}

before(async () => {
  shell = await bootShell({
    viewport: PHONE,
    routes: {
      '/api/mirror': () => mirrorBody,
      '/api/queue': () => queueBody,
      '/api/queue/task-stop': () => ({ ok: true }),
      '/api/mirror/tasks/*': (url) => {
        const id = decodeURIComponent(url.split('/api/mirror/tasks/')[1].split('/')[0]);
        return { task_id: id, text: outputText, from: 0, to: outputText.length, size: outputText.length, eof: true,
          ended: false, footer: '' };
      },
      '/api/mirror/agents/*': (url) => {
        const id = decodeURIComponent(url.split('/api/mirror/agents/')[1].split('?')[0]);
        const row = (mirrorBody.tasks || []).find((t) => t.id === id);
        return row ? { agent: row, items: [], next_before: null, rev: 1 } : { ok: false, error: 'not found' };
      },
    },
    init: async (s) => {
      const ws = await s.importApp('ws.js');
      const { initChatState } = await s.importApp('chat-state.js');
      initChatState({ onFrame: ws.onFrame, onHello: ws.onHello });
      const d = await s.importApp('chat-detail.js');
      d.initChatDetail({ followMs: FOLLOW });   // main.js started it; this paces its followers for the test
      const { initChatSheet } = await s.importApp('chat-sheet.js');
      initChatSheet();
      const { initSheetTasks } = await s.importApp('chat-sheet-tasks.js');
      initSheetTasks();
    },
  });
  W = shell.window;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  sheet = await shell.importApp('chat-sheet.js');
  tasks = await shell.importApp('chat-sheet-tasks.js');
  actions = await shell.importApp('chat-actions.js');
  model = await shell.importApp('sheet-model.js');
  detail = await shell.importApp('chat-detail.js');
  trays = await shell.importApp('chat-trays.js');
  S = await shell.importApp('chat-state.js');
  Q = await shell.importApp('queue.js');
  await showFinal();
});

after(() => shell.restore());

// Every case starts on a phone, the sheet closed on Chat, Tasks at its root, the Final's fixture.
beforeEach(async () => {
  if (W.innerWidth !== PHONE.width || W.innerHeight !== PHONE.height) { shell.setViewport(PHONE); await shell.tick(); }
  layout(644);
  sheet.closeSheet({ returnFocus: false });
  while (sheet.popPage('tasks'));
  if (sheet.sheetState().view !== 'chat') shell.click($('sh-tab-chat'));
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the sheet\'s entry to go' });
  outputText = 'ready in 412 ms\n';
  await showFinal();
});

/* ═══════════════════════════════════ the root ═══════════════════════════════ */

test('the root from the Final\'s fixture: shells, agents, workflows, monitors, queue; 60px buttons; the segment "6 running"', async () => {
  await openTasks();
  assert.deepEqual(lines().map((l) => l.dataset.csCat), ['shells', 'agents', 'workflows', 'monitors', 'queue']);
  for (const l of lines()) {
    assert.equal(l.tagName, 'BUTTON', `${l.dataset.csCat} is a button`);
    assert.equal(l.type, 'button');
  }
  const shells = line('shells');
  assert.equal(txt(shells, '.sh-ltitle'), 'Shells');
  assert.equal(txt(shells, '.sh-lmeta'), '2 running');
  assert.equal(txt(shells, '.sh-lline'), 'npm run dev · npm test -- --watch');
  assert.equal(txt(shells, '.sh-ltag'), '', 'no tag on a category of several');
  const wf = line('workflows');
  assert.equal(txt(wf, '.sh-ltitle'), 'release-check', 'one item: the item itself');
  assert.equal(txt(wf, '.sh-ltag'), 'WORKFLOW');
  assert.equal(txt(wf, '.sh-lmeta'), 'step 3 / 5');
  assert.equal(wf.querySelectorAll('.sh-lsteps > .sh-lstep').length, 5, 'five step bars');
  assert.deepEqual([...wf.querySelectorAll('.sh-lstep')].map((s) => s.dataset.stepState),
    ['done', 'done', 'running', 'pending', 'pending']);
  assert.equal(txt(line('monitors'), '.sh-ltitle'), 'Monitors');
  assert.equal(txt(line('queue'), '.sh-ltitle'), 'Queue');
  assert.equal(txt(line('queue'), '.sh-lline'), 'Also update the README screenshot', 'the next message');
  assert.equal($('sh-tab-tasks').querySelector('.sh-run').textContent, '6 running');
  assert.equal(root().querySelector('.sh-empty'), null, 'no empty note with tasks present');
  // Built by textContent only: the shell's title is in the mono face.
  const single = clone(mirrorBody);
  single.tasks = single.tasks.filter((t) => t.id !== 'b2');
  await show(single);
  assert.equal(txt(line('shells'), '.sh-ltitle'), 'npm run dev');
  assert.equal(txt(line('shells'), '.sh-ltag'), 'SHELL');
  assert.ok(line('shells').querySelector('.sh-ltitle').classList.contains('sh-mono'), 'a shell\'s command is mono');
});

test('pulse: a line\'s dot pulses while Claude works and stops when the conversation goes idle; the queue\'s never', async () => {
  await openTasks();
  const dot = (cat) => line(cat).querySelector('.sh-dot');
  assert.equal(dot('shells').dataset.pulse, 'true');
  assert.equal(dot('agents').dataset.pulse, 'true');
  assert.equal(dot('queue').dataset.pulse, undefined, 'the queue is the user\'s, not Claude at work');
  const idle = clone(mirrorBody);
  idle.conversations[0].live = { ...idle.conversations[0].live, state: 'idle', step: null };
  idle.aggregate = { state: 'idle' };
  await show(idle);
  for (const l of lines()) assert.equal(l.querySelector('.sh-dot').dataset.pulse, undefined, `${l.dataset.csCat} is still`);
  await showFinal();
  assert.equal(dot('shells').dataset.pulse, 'true', 'and moves again when Claude works');
});

test('below read (the fixture at level basic): counts only on every line, and only the Queue line is a button', async () => {
  await showFinal({ level: 'basic' });
  await openTasks();
  assert.deepEqual(lines().map((l) => l.dataset.csCat), ['shells', 'agents', 'workflows', 'monitors', 'queue']);
  for (const l of lines()) {
    const cat = l.dataset.csCat;
    assert.equal(l.dataset.countsOnly, 'true', `${cat} is counts only`);
    assert.equal(txt(l, '.sh-lline'), '', `${cat} names no work`);
    assert.equal(txt(l, '.sh-ltag'), '');
    assert.equal(l.querySelectorAll('.sh-lstep').length, 0);
    if (cat === 'queue') { assert.equal(l.tagName, 'BUTTON'); continue; }
    assert.equal(l.tagName, 'DIV', `${cat} is a plain row`);
    assert.equal(l.hasAttribute('tabindex'), false, 'out of the tab order');
  }
  assert.equal(txt(line('shells'), '.sh-ltitle'), 'Shells');
  assert.equal(txt(line('shells'), '.sh-lmeta'), '2 running');
  assert.equal(txt(line('monitors'), '.sh-lmeta'), '2 watching');
  assert.equal(txt(line('queue'), '.sh-lmeta'), '2 queued');
  shell.click(line('shells'));
  await shell.tick();
  assert.equal(sheet.sheetState().page, null, 'a counts-only row opens nothing');
  // Back at read, the rows are buttons again (the element changes with it).
  await showFinal();
  assert.equal(line('shells').tagName, 'BUTTON');
  assert.equal(line('shells').dataset.countsOnly, undefined);
});

test('deviation 18: no shells → no Shells line; no tasks → one muted line, and the Queue line ("Nothing queued") still a button', async () => {
  const noShells = clone(mirrorBody);
  noShells.tasks = noShells.tasks.filter((t) => t.kind !== 'shell');
  await show(noShells);
  await openTasks();
  assert.deepEqual(lines().map((l) => l.dataset.csCat), ['agents', 'workflows', 'monitors', 'queue']);
  const none = clone(mirrorBody);
  none.tasks = [];
  await show(none, { items: [], count: 0, receipts: [] });
  assert.deepEqual(lines().map((l) => l.dataset.csCat), ['queue']);
  const empty = root().querySelector('.sh-empty');
  assert.ok(empty, 'the one muted line');
  assert.equal(empty.textContent, model.EMPTY_TASKS_NOTE);
  assert.equal(root().children[0], empty, 'above the Queue line');
  assert.equal(line('queue').tagName, 'BUTTON');
  assert.equal(txt(line('queue'), '.sh-lline'), 'Nothing queued');
  // The Queue line shows U70's kept page (nothing until U70 lands it).
  const seen = [];
  sheet.ensurePage('tasks', { key: 'queue', title: 'Queue', back: '‹ Tasks', render: () => {} });
  try {
    shell.click(line('queue'));
    await shell.tick();
    seen.push(sheet.sheetState().page);
    assert.deepEqual(seen, ['queue'], 'showPage(\'tasks\', \'queue\')');
  } finally {
    while (sheet.popPage('tasks'));
  }
});

/* ═══════════════════════════ a category page ═══════════════════════════════ */

test('tap Shells → a ‹ Tasks page with two touch rows; Kill takes two taps and posts /api/queue/task-stop once', async () => {
  await openTasks();
  const page = await tapLine('shells');
  assert.equal(sheet.sheetState().page, 'shells');
  assert.equal(page.querySelector('.sh-back').textContent, '‹ Tasks');
  assert.equal(page.querySelector('.sh-ptitle').textContent, 'Shells');
  assert.equal(page.querySelector('.sh-psub').textContent, '2 running');
  const rows = rowsOf(page);
  assert.deepEqual(rows.map((r) => r.dataset.rowId), ['b1', 'b2']);
  for (const r of rows) assert.equal(r.dataset.density, 'touch');
  const b1 = rowOf(page, 'b1');
  const kill = act(b1, 'kill');
  const output = act(b1, 'output');
  assert.equal(kill.dataset.destructive, 'true');
  const n = stops().length;
  shell.click(kill);
  assert.equal(kill.textContent, 'Confirm kill');
  assert.equal(output.disabled, true, 'its siblings are off while it is armed');
  assert.equal(stops().length, n, 'nothing posted on the first tap');
  shell.click(kill);
  await shell.tick();
  assert.equal(stops().length, n + 1, 'the second tap posts once');
  assert.deepEqual(stops()[n].body, { task_id: 'b1' });
  assert.equal(output.disabled, false);
  assert.equal(b1.querySelector('.cs-row-meta').textContent, 'stopping…');
});

test('an armed Kill reverts after TOUCH_REVERT_MS, and at once on a tap elsewhere', async () => {
  await openTasks();
  const page = await tapLine('shells');
  const b2 = rowOf(page, 'b2');
  const kill = act(b2, 'kill');
  shell.click(kill);
  assert.equal(kill.textContent, 'Confirm kill');
  shell.press(page.querySelector('.sh-ptitle'));
  assert.equal(kill.textContent, 'Kill', 'a tap elsewhere reverts');
  assert.equal(act(b2, 'output').disabled, false);
  shell.click(kill);
  assert.equal(kill.textContent, 'Confirm kill');
  const n = stops().length;
  await settle(actions.TOUCH_REVERT_MS + 150);
  assert.equal(kill.textContent, 'Kill', 'reverted after TOUCH_REVERT_MS');
  assert.equal(kill.dataset.confirming, undefined);
  assert.equal(stops().length, n, 'nothing posted');
});

test('with a registered stopper Kill mounts a .cs-row-confirm-touch slot and posts nothing (ruling E1 a)', async () => {
  const mounted = [];
  const off = actions.registerStopper({
    mount(slot, row, opts) { mounted.push([row.id, opts.density]); slot.append(Object.assign(W.document.createElement('button'), { className: 'test-stop' })); return true; },
    unmount() {},
  });
  try {
    await openTasks();
    const page = await tapLine('shells');
    const b1 = rowOf(page, 'b1');
    const n = stops().length;
    shell.click(act(b1, 'kill'));
    await shell.tick();
    const slot = b1.querySelector('.cs-row-confirm.cs-row-confirm-touch');
    assert.ok(slot, 'the stopper\'s touch slot');
    assert.deepEqual(mounted, [['b1', 'touch']]);
    assert.equal(stops().length, n, 'nothing posted');
    shell.click(act(b1, 'kill'));   // another stop action steps back out of it
    assert.equal(b1.querySelector('.cs-row-confirm'), null);
  } finally { off(); }
});

test('a mirror redraw while Kill is armed keeps the armed button (updateRow, not a rebuild)', async () => {
  await openTasks();
  const page = await tapLine('shells');
  const b1 = rowOf(page, 'b1');
  const kill = act(b1, 'kill');
  shell.click(kill);
  const changed = clone(mirrorBody);
  changed.tasks.find((t) => t.id === 'b1').line = 'a new line of output';
  await show(changed);
  assert.equal(rowOf(page, 'b1'), b1, 'the same row element');
  assert.equal(act(b1, 'kill'), kill, 'the same button');
  assert.equal(kill.textContent, 'Confirm kill', 'still armed');
  assert.equal(b1.querySelector('.cs-row-line').textContent, 'a new line of output', 'and the row redrew');
  shell.press(page.querySelector('.sh-ptitle'));
});

/* ═════════════════════════════ detail pages (B3 a) ═════════════════════════ */

test('Output on b1 pushes a ‹ Shells page with the output; the Shells page hides under it; popping stops the follower', async () => {
  await openTasks();
  const shellsPage = await tapLine('shells');
  const before_ = calls('/api/mirror/tasks/b1/output').length;
  const views0 = detail.openViews();
  shell.click(act(rowOf(shellsPage, 'b1'), 'output'));
  await shell.tick();
  const page = topPage();
  assert.notEqual(page, shellsPage);
  assert.equal(sheet.sheetState().page, 'task:b1');
  assert.equal(page.querySelector('.sh-back').textContent, '‹ Shells');
  assert.equal(shellsPage.hidden, true, 'the Shells page is hidden while the detail shows');
  await waitUntil(() => {
    const out = page.querySelector('.dv-out');
    return out && out.textContent.includes('ready in 412 ms');
  }, { what: 'the output, through GET /api/mirror/tasks/b1/output' });
  assert.match(page.querySelector('.sh-ptitle').textContent, /^Shell · npm run dev$/, 'the view sets the page\'s title');
  await waitUntil(() => calls('/api/mirror/tasks/b1/output').length >= before_ + 2, { what: 'the follower to follow' });
  shell.click(page.querySelector('.sh-back'));
  await shell.tick();
  assert.equal(sheet.sheetState().page, 'shells');
  assert.equal(shellsPage.hidden, false);
  assert.equal(page.isConnected, false, 'the detail page is gone');
  assert.equal(detail.openViews(), views0, 'its view closed (the page\'s cleanup ran the view\'s)');
  const n = calls('/api/mirror/tasks/b1/output').length;
  await settle();
  assert.equal(calls('/api/mirror/tasks/b1/output').length, n, 'no fetch after the pop');
});

test('only the visible page renders: a mirror change under a detail page reaches the Shells page once it shows again', async () => {
  await openTasks();
  const shellsPage = await tapLine('shells');
  shell.click(act(rowOf(shellsPage, 'b2'), 'output'));
  await shell.tick();
  const line2 = rowOf(shellsPage, 'b2').querySelector('.cs-row-line');
  const was = line2.textContent;
  const changed = clone(mirrorBody);
  changed.tasks.find((t) => t.id === 'b2').line = 'Tests 43 passed (43)';
  await show(changed);
  assert.equal(line2.textContent, was, 'the covered page was not drawn');
  shell.click(topPage().querySelector('.sh-back'));
  await shell.tick();
  assert.equal(line2.textContent, 'Tests 43 passed (43)', 'drawn once it showed');
});

test('the item leaving the store while its detail page is open: "No longer running", the last content kept', async () => {
  await openTasks();
  const shellsPage = await tapLine('shells');
  shell.click(act(rowOf(shellsPage, 'b1'), 'output'));
  await shell.tick();
  const page = topPage();
  await waitUntil(() => (page.querySelector('.dv-out') || {}).textContent === 'ready in 412 ms\n', { what: 'the output' });
  const gone = clone(mirrorBody);
  gone.tasks = gone.tasks.filter((t) => t.id !== 'b1');
  await show(gone);
  await waitUntil(() => !!page.querySelector('.dv-gone'), { what: 'the banner' });
  assert.equal(page.querySelector('.dv-gone').textContent, detail.GONE);
  assert.equal(page.querySelector('.dv-out').textContent, 'ready in 412 ms\n', 'the last content stays');
  assert.equal(topPage(), page, 'the page stays up');
});

test('the category emptying while its page is open: the rows stay, without actions, under "No longer running"', async () => {
  await openTasks();
  const page = await tapLine('shells');
  assert.equal(page.querySelector('.sh-gone').hidden, true);
  const noShells = clone(mirrorBody);
  noShells.tasks = noShells.tasks.filter((t) => t.kind !== 'shell');
  await show(noShells);
  assert.equal(topPage(), page);
  assert.deepEqual(rowsOf(page).map((r) => r.dataset.rowId), ['b1', 'b2'], 'the last rows');
  assert.equal(page.querySelectorAll('.cs-row-act').length, 0, 'with nothing to act on');
  const g = page.querySelector('.sh-gone');
  assert.equal(g.hidden, false);
  assert.equal(g.textContent, 'No longer running');
  assert.equal(g.textContent, detail.GONE, 'chat-detail\'s wording');
  await showFinal();
  assert.equal(g.hidden, true, 'back in the store: the line goes');
  assert.ok(act(rowOf(page, 'b1'), 'kill'), 'and the actions come back');
});

test('B3 (a): Open on an agent pushes its view into the Tasks stack, and its Cancel takes two taps there', async () => {
  await openTasks();
  const agents = await tapLine('agents');
  assert.deepEqual(rowsOf(agents).map((r) => r.dataset.rowId), ['a1', 'a2']);
  shell.click(act(rowOf(agents, 'a1'), 'open'));
  await shell.tick();
  const page = topPage();
  assert.equal(page.querySelector('.sh-back').textContent, '‹ Agents');
  const cancel = await waitUntil(() => page.querySelector('.dv-cancel'), { what: 'the agent view\'s Cancel' });
  const n = stops().length;
  shell.click(cancel);
  assert.equal(cancel.textContent, 'Confirm cancel', 'touch density: the first tap arms');
  assert.equal(stops().length, n);
  shell.click(cancel);
  await shell.tick();
  assert.equal(stops().length, n + 1);
  assert.deepEqual(stops()[n].body, { task_id: 'a1' });
});

/* ═══════════════════════════════ chat:tasks ════════════════════════════════ */

test('chat:tasks {category: \'agents\'} at 390 opens the sheet at least half on the Agents page; no category, the root', async () => {
  bus.emit('chat:tasks', { category: 'agents' });
  await shell.tick();
  const st = sheet.sheetState();
  assert.equal(st.open, true);
  assert.equal(st.view, 'tasks');
  assert.equal(st.page, 'agents');
  assert.ok(st.h >= st.stops.half, 'at least half');
  assert.equal(topPage().querySelector('.sh-ptitle').textContent, 'Agents');
  sheet.setStop(st.stops.full);
  bus.emit('chat:tasks', {});
  await shell.tick();
  assert.equal(sheet.sheetState().page, null, 'the root');
  assert.equal(sheet.sheetState().h, st.stops.full, 'never lowered');
  bus.emit('chat:tasks', { category: 'nope' });
  await shell.tick();
  assert.equal(sheet.sheetState().page, null, 'a category with nothing in it: the root');
});

test('at 1280 wide the sheet ignores chat:tasks and the tray answers', async () => {
  shell.setViewport(DESKTOP);
  await shell.tick();
  try {
    bus.emit('chat:tasks', { category: 'agents' });
    await shell.tick();
    assert.equal(sheet.sheetState().open, false, 'the sheet stays shut');
    assert.equal(sheet.sheetState().page, null);
    const tray = $('cs-tray');
    assert.ok(tray && !tray.classList.contains('hidden'), 'the tray opened');
    assert.equal(tray.dataset.csCat, 'agents');
  } finally {
    trays.closeTray({ returnFocus: false });
    shell.setViewport(PHONE);
    await shell.tick();
  }
});

/* ═══════════════════════════════ rendering ═════════════════════════════════ */

test('a closed sheet renders nothing on a mirror event; open on Chat, neither', async () => {
  const seen = [];
  const watch = new W.MutationObserver((recs) => { for (const r of recs) seen.push(r); });
  watch.observe($('sh-tasks'), { subtree: true, childList: true, attributes: true, characterData: true });
  const changed = clone(mirrorBody);
  changed.tasks.find((t) => t.id === 'b1').line = 'closed-sheet change';
  await show(changed);
  sheet.openSheet({ view: 'chat' });
  await shell.tick();
  changed.tasks.find((t) => t.id === 'b1').line = 'open-on-chat change';
  await show(changed);
  watch.disconnect();
  assert.deepEqual(seen, [], 'nothing in #sh-tasks changed');
  shell.click($('sh-tab-tasks'));
  await shell.tick();
  assert.match(txt(line('shells'), '.sh-lline'), /^npm run dev/, 'drawn when Tasks shows');
});

test('initSheetTasks twice mounts once; the source keeps no timer and no direct POST; CSS tokens only', async () => {
  assert.equal(tasks.initSheetTasks(), true);
  await openTasks();
  assert.equal($('sh-tasks').querySelectorAll('.sh-root').length, 1);
  assert.doesNotMatch(SRC, /setInterval\(|setTimeout\(|fetch\(|localStorage|sessionStorage|matchMedia/);
  assert.match(SRC, /requestAnimationFrame/);
  const at = CSS.indexOf('/* ── U69 ·');
  const section = CSS.slice(at, CSS.indexOf('/* ── U70 ·'));
  assert.doesNotMatch(section.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b/, 'no literal colour');
  assert.match(section, /\.sh-line \{[^}]*min-height: 60px/);
  assert.match(section, /\.sh-dot\[data-pulse\] \{ animation: wc-chat-pulse/);
  assert.match(section, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sh-dot\[data-pulse\] \{ animation: none; \}/);
});

test('stopSheetTasks: the root and its pages go and a mirror event draws nothing; initSheetTasks brings it back', async () => {
  await openTasks();
  const page = await tapLine('shells');
  tasks.stopSheetTasks();
  assert.equal(root(), null, 'the root is gone');
  assert.equal(page.isConnected, false, 'its page popped');
  assert.equal(sheet.sheetState().page, null);
  await showFinal();
  assert.equal($('sh-tasks').querySelector('.sh-root'), null, 'no listener left behind');
  tasks.initSheetTasks();
  await shell.tick();
  assert.ok(root(), 'mounted again, and drawn: the sheet is open on Tasks');
  assert.equal(lines().length, 5);
});

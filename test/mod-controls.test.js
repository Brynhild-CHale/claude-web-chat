// Control on the mod in the chrome (public/app/mod-controls.js, U89; spec §15.7,
// §6.9 'Ruled (Q7, Q-H)', §7.6, §15.6 'In place'; rulings Q-C, Q-E, F6,
// C-defaults (a)), through the real shell (test-support/chrome-shell.js), with
// initModControls passed in (main.js calls it from U94a on):
//   * the stopper: Kill on a task row of a conversation with a mod attached
//     mounts ONE confirm frame {action: 'task-stop', params: {task_id}} in the
//     row's slot — no size at the compact density, size 'sheet' at touch (a
//     touch row, and a row on the phone sheet's Tasks page) — and posts
//     nothing; it answers true only with process.mod, capabilities.mod and a
//     viewer who may act; with no mod it answers false and the inline confirm
//     posts /api/queue/task-stop as before; unmount twice is harmless;
//   * the turn action 'fork-in-place': only with capabilities.rewind_in_place
//     and process.mod, never on a superseded turn or one with no session id;
//     its run opens a .popover.ta-dialog with NO id holding ONE 'resume'
//     confirm frame; shell.js's Escape hides it and the frame unmounts;
//   * stopModControls unregisters the stopper and the action;
//   * the source: no fetch, no Escape listener, queue.js never reaches it.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'public/app');
const T0 = Date.UTC(2026, 9, 13, 14, 0, 0);
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const PORT = 4567;
const LOOP = `http://127.0.0.1:${PORT}`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

let shell, W, doc, $, bus, S, CA, R, P, Q, MC, sheet;
let current = null;
let rev = 9000;
let convN = 0;
let cid = null;
const pages = new Map();

class StubIO {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}

const CAPS = { interrupt: true, task_stop: true, mod: true, rewind_in_place: true, fork: true };
const shellTask = (conversationId) => ({ id: 's1', kind: 'shell', conversation_id: conversationId, title: 'npm run dev',
  status: 'running', started_at: T0 - 60000 });

function snapshot(conversationId, { mod = true, caps = CAPS, access = { level: 'local', remote: false } } = {}) {
  return {
    v: 1, enabled: true, now: Date.now(), rev: ++rev, content: true, access, capabilities: caps,
    primary: conversationId, aggregate: { state: 'idle' },
    conversations: [{ id: conversationId, rev: 1, headless: false, counts: ZERO, process: { pid: 4242, mod },
      live: { state: 'idle', since: T0, last_activity_at: T0 } }],
    tasks: [shellTask(conversationId)], asks: [],
  };
}

function turn(id, seq, extra = {}) {
  return {
    id, rev: ++rev, conversation_id: cid, session_id: 's1', seq, kind: 'prompt', author: 'user', status: 'done',
    started_at: T0 + seq * 60000, ended_at: T0 + seq * 60000 + 5000, duration_ms: 5000,
    counts: { items: 1, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 },
    tool_names: [], groups: [], node: { id: `n${seq}`, label: `n1.${seq}`, role: 'commit' }, folded_into: null,
    ...extra,
    items: [{ id: `p_${id}`, kind: 'prompt', text: `prompt ${id}`, origin: 'human', turn_id: id, seq: seq * 1000, ts: T0 + seq * 60000, rev }],
  };
}
const TURNS = () => [turn('t1', 1), turn('t3', 3, { superseded: true }), turn('t4', 4, { session_id: undefined })];

// A new conversation (so the stream reloads), its snapshot and its turns.
async function show(opts = {}) {
  cid = `c${++convN}`;
  const built = TURNS();
  pages.set(cid, { conversation_id: cid, turns: built, next_before: null, total: built.length, rev: ++rev });
  current = snapshot(cid, opts);
  const want = current.rev;
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= want && S.mirror.stream.conversationId === cid && !S.mirror.stream.loading
    && $('chat-stream').querySelectorAll('.ct-turn').length === built.length, { timeout: 3000, what: `the stream of ${cid}` });
  await shell.tick();
}
// The same conversation, a new snapshot.
async function resnap(opts = {}) {
  current = snapshot(cid, opts);
  const want = current.rev;
  await shell.frame(helloFrame());
  await waitUntil(() => S.mirror.rev >= want, { timeout: 3000, what: 'the snapshot' });
  await shell.tick();
}

const model = () => P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() }).find((e) => e.cat === 'shells').rows.find((r) => r.id === 's1');
const stops = () => shell.calls.filter((c) => c.url === '/api/queue/task-stop' && c.method === 'POST');
const host = () => { const d = doc.createElement('div'); doc.body.append(d); return d; };
const turnEl = (id) => $('chat-stream').querySelector(`.ct-turn[data-turn-id="${id}"]`);
const actionsOf = (id) => [...turnEl(id).querySelectorAll('.ct-foot .ct-action')].map((b) => b.dataset.action);
const dialogs = () => [...doc.querySelectorAll('.popover.ta-dialog')].filter((d) => !d.id);

// A Kill on a fresh row element at a density: → {rowEl, slot, frame}.
function kill(density) {
  const list = host();
  const rowEl = R.rowEl(model(), { density });
  list.append(rowEl);
  const button = rowEl.querySelector('.cs-row-actions [data-action="kill"]');
  assert.ok(button, `${density}: a Kill`);
  CA.runAction(model(), 'kill', { rowEl, density, button });
  const slot = rowEl.querySelector('div.cs-row-confirm');
  const frame = slot ? slot.querySelector('iframe.wc-answer-frame') : null;
  return { list, rowEl, button, slot, frame };
}

before(async () => {
  globalThis.IntersectionObserver = StubIO;
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': (url) => {
        const id = decodeURIComponent(url.split('?')[0].split('/')[4]);
        return pages.get(id) || { conversation_id: id, turns: [], next_before: null, total: 0, rev };
      },
      '/api/asks': () => ({ asks: [], answer: { port: PORT } }),
      '/api/queue/task-stop': () => ({ ok: true }),
      '/api/queue': () => ({ items: [], count: 0 }),
    },
    init: async (sh) => {
      MC = await sh.importApp('mod-controls.js');
      MC.initModControls();
      MC.initModControls();   // idempotent
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  CA = await shell.importApp('chat-actions.js');
  R = await shell.importApp('chat-rows.js');
  P = await shell.importApp('chat-present.js');
  Q = await shell.importApp('queue.js');
  sheet = await shell.importApp('chat-sheet.js');
  current = snapshot('c0');
  await shell.frame(helloFrame());
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
});

after(() => {
  if (MC) MC.stopModControls();
  delete globalThis.IntersectionObserver;
  return shell.restore();
});

/* ── the stopper ─────────────────────────────────────────────────────────── */

test('the stopper: Kill on a mod conversation\'s row mounts ONE task-stop confirm frame — no size at compact, size sheet at touch — and posts nothing', async () => {
  await show();
  const n = stops().length;
  for (const density of ['compact', 'touch']) {
    const k = kill(density);
    assert.ok(k.slot, `${density}: the slot`);
    assert.ok(k.frame, `${density}: the frame`);
    assert.equal(k.slot.querySelectorAll('iframe').length, 1);
    const u = new URL(k.frame.src);
    assert.equal(u.origin, LOOP);
    assert.equal(u.pathname, '/answer/control/task-stop');
    assert.equal(u.searchParams.get('task_id'), 's1');
    assert.equal(u.searchParams.get('layout'), 'confirm');
    assert.equal(u.searchParams.get('size'), density === 'touch' ? 'sheet' : null, `${density}: the size`);
    assert.equal(k.frame.dataset.kind, 'control');
    assert.equal(stops().length, n, 'the stopper owns the stop: no queue POST');
    // Another stop action on the row reverts the slot: the frame goes.
    CA.runAction(model(), 'kill', { rowEl: k.rowEl, density, button: k.button });
    assert.equal(k.rowEl.querySelector('iframe'), null);
    k.list.remove();
  }
});

test('the stopper answers false without process.mod, without capabilities.mod, or below full — and the inline confirm posts the queue route as before', async () => {
  for (const opts of [{ mod: false }, { caps: { ...CAPS, mod: false } }, { access: { level: 'read', remote: true } }]) {
    await show(opts);
    const slot = host();
    assert.equal(MC.modStopper.mount(slot, model() || { id: 's1' }, { density: 'compact' }), false, JSON.stringify(opts));
    assert.equal(slot.querySelector('iframe'), null);
    slot.remove();
  }
  await show({ mod: false });
  const n = stops().length;
  const k = kill('compact');
  assert.equal(k.frame, null, 'no frame');
  const yes = k.rowEl.querySelector('.cs-confirm-yes');
  assert.ok(yes, 'the inline confirm, as today');
  shell.click(yes);
  await waitUntil(() => stops().length > n, { timeout: 2000, what: 'the queue POST' });
  assert.deepEqual(stops().at(-1).body, { task_id: 's1' });
  k.list.remove();
});

test('the stopper\'s unmount is synchronous and idempotent', async () => {
  await show();
  const slot = host();
  assert.equal(MC.modStopper.mount(slot, model(), { density: 'compact' }), true);
  assert.equal(slot.querySelectorAll('iframe').length, 1);
  MC.modStopper.unmount(slot);
  assert.equal(slot.querySelector('iframe'), null, 'gone at once');
  MC.modStopper.unmount(slot);
  MC.modStopper.unmount(host());
  slot.remove();
});

test('the phone sheet\'s Tasks page: a tapped Kill mounts the frame at size sheet, through the same stopper', async () => {
  await show();
  shell.setViewport(PHONE);
  await shell.tick();
  shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: 390 } });
  shell.scrollMetrics($('bottombar'), { rect: { top: 688, height: 60, width: 390 } });
  try {
    sheet.openSheet({ view: 'tasks' });
    await shell.tick();
    const line = [...$('sh-tasks').querySelectorAll('.sh-line')].find((l) => l.dataset.csCat === 'shells');
    assert.ok(line, 'the Shells line');
    shell.click(line);
    await shell.tick();
    const page = [...$('sh-tasks').querySelectorAll('.sh-page')].filter((p) => !p.hidden).pop();
    const row = [...page.querySelectorAll('.sh-rows > .cs-row')].find((r) => r.dataset.rowId === 's1');
    assert.equal(row.dataset.density, 'touch');
    const btn = row.querySelector('.cs-row-actions [data-action="kill"]');
    const n = stops().length;
    // A tap, as a finger gives one: sheet-drag eats a bare click after a drag.
    btn.dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch' }));
    btn.dispatchEvent(new W.PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerType: 'touch' }));
    shell.click(btn);
    await shell.tick();
    const slot = row.querySelector('.cs-row-confirm.cs-row-confirm-touch');
    assert.ok(slot, 'the touch slot');
    const f = slot.querySelector('iframe.wc-answer-frame');
    assert.ok(f, 'the frame');
    assert.equal(new URL(f.src).searchParams.get('size'), 'sheet');
    assert.equal(stops().length, n, 'nothing posted');
    shell.click(btn);   // another stop action steps back out of it
    assert.equal(row.querySelector('iframe'), null);
  } finally {
    sheet.closeSheet({ returnFocus: false });
    while (sheet.popPage('tasks'));
    shell.setViewport(DESKTOP);
    await shell.tick();
    bus.emit('chat:open', { view: 'chat' });   // the desktop panel again, for the stream
    await shell.tick();
  }
});

/* ── the turn action ─────────────────────────────────────────────────────── */

test('fork-in-place applies only with capabilities.rewind_in_place and process.mod, never superseded or without a session id', async () => {
  await show();
  assert.ok(actionsOf('t1').includes('fork-in-place'));
  assert.equal(turnEl('t1').querySelector('[data-action="fork-in-place"]').textContent, 'Fork here and switch the terminal');
  assert.ok(!actionsOf('t3').includes('fork-in-place'), 'superseded');
  assert.ok(!actionsOf('t4').includes('fork-in-place'), 'no session id');
  // A change of capability or process redraws the drawn footers.
  await resnap({ caps: { ...CAPS, rewind_in_place: false } });
  await waitUntil(() => !actionsOf('t1').includes('fork-in-place'), { timeout: 2000, what: 'the footer to redraw' });
  await resnap({ mod: false });
  assert.ok(!actionsOf('t1').includes('fork-in-place'), 'no mod');
  await resnap();
  await waitUntil(() => actionsOf('t1').includes('fork-in-place'), { timeout: 2000, what: 'the action back' });
  await resnap({ access: { level: 'read', remote: true } });
  await waitUntil(() => !actionsOf('t1').includes('fork-in-place'), { timeout: 2000, what: 'below full' });
});

test('its run opens a .popover.ta-dialog with no id holding ONE resume confirm frame; Escape hides it and the frame unmounts', async () => {
  await show();
  shell.press(turnEl('t1').querySelector('[data-action="fork-in-place"]'));
  await shell.tick();
  const [d, ...more] = dialogs();
  assert.equal(more.length, 0);
  assert.ok(d && !d.classList.contains('hidden'));
  assert.equal(d.getAttribute('role'), 'dialog');
  assert.equal(d.querySelector('.ta-title').textContent, MC.DIALOG_TITLE);
  assert.equal(d.querySelector('.ta-body').textContent, MC.DIALOG_TEXT);
  assert.equal(d.querySelectorAll('[id]').length, 0, 'no ids inside it either');
  const frames = [...d.querySelectorAll('.ta-confirm iframe.wc-answer-frame')];
  assert.equal(frames.length, 1);
  const u = new URL(frames[0].src);
  assert.deepEqual([u.pathname, u.searchParams.get('turn_id'), u.searchParams.get('layout')], ['/answer/control/resume', 't1', 'confirm']);
  assert.equal(!!$('turn-action') && !$('turn-action').classList.contains('hidden'), false, 'U86\'s dialog is not used');
  shell.key('Escape');
  await shell.tick();
  assert.equal(dialogs().length, 0, 'dismissed and removed');
  assert.equal(doc.querySelectorAll('iframe[src*="/answer/control/resume"]').length, 0, 'the frame unmounted');
  // Its ✕ closes it the same way; opening it again replaces, never stacks.
  shell.press(turnEl('t1').querySelector('[data-action="fork-in-place"]'));
  shell.press(turnEl('t1').querySelector('[data-action="fork-in-place"]'));
  await shell.tick();
  assert.equal(dialogs().length, 1);
  shell.click(dialogs()[0].querySelector('.ta-close'));
  await shell.tick();
  assert.equal(dialogs().length, 0);
});

test('stopModControls unregisters the stopper and the action; init brings them back', async () => {
  await show();
  shell.press(turnEl('t1').querySelector('[data-action="fork-in-place"]'));
  await shell.tick();
  assert.equal(dialogs().length, 1);
  MC.stopModControls();
  await shell.tick();
  assert.equal(dialogs().length, 0, 'the dialog goes with it');
  assert.ok(!actionsOf('t1').includes('fork-in-place'));
  const k = kill('compact');
  assert.equal(k.frame, null);
  assert.ok(k.rowEl.querySelector('.cs-confirm-yes'), 'the inline confirm again');
  k.list.remove();
  MC.initModControls();
  await shell.tick();
  assert.ok(actionsOf('t1').includes('fork-in-place'));
  const k2 = kill('compact');
  assert.ok(k2.frame, 'the stopper again');
  k2.list.remove();
});

/* ── the source ──────────────────────────────────────────────────────────── */

test('the source: no fetch, no Escape or outside-click listener, no innerHTML; queue.js never reaches it', () => {
  const src = fs.readFileSync(path.join(APP, 'mod-controls.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bfetch\(/);
  assert.doesNotMatch(code, /keydown|keyup|'Escape'|"Escape"|pointerdown|mousedown/);
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML/);
  const importsOf = (f) => [...fs.readFileSync(f, 'utf8').matchAll(/^\s*import\s[^;]*?from\s+'(\.\/[^']+)'/gm)].map((m) => path.join(APP, m[1]));
  const seen = new Set();
  const walk = (f) => { for (const g of importsOf(f)) if (!seen.has(g)) { seen.add(g); walk(g); } };
  walk(path.join(APP, 'queue.js'));
  assert.equal(seen.has(path.join(APP, 'mod-controls.js')), false);
  assert.equal(seen.has(path.join(APP, 'chat-actions.js')), false);
});

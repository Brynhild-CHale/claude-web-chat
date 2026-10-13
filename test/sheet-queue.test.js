// The queue in the phone sheet (public/app/chat-sheet-queue.js, shell.js's
// setQueueRoute, U70's section of app.css), through the real shell
// (test-support/chrome-shell.js) at 390×844: design spec §8.7, §8.4's Queue and
// push-feedback rows, §7.8 (Escape's one owner), deviation 17.
//
// main.js does not start the sheet, its Tasks view or this one until U73 wires
// them, so the boot's init does. #topbar and #bottombar get rectangles
// (shell.scrollMetrics) so the available height is 644 (full 622, half 341), as
// in test/chat-sheet.test.js.
const test = require('node:test');
const { before, beforeEach, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(REPO, 'public/app.css'), 'utf8');
const SHELL_SRC = fs.readFileSync(path.join(REPO, 'public/app/shell.js'), 'utf8');

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

let queueBody = { items: [], count: 0 };
let parked = null;
let pushAnswer = { ok: true, mode: 'parked', pending_id: 'pw1', delivers: 'Pushed — delivers with your next message.' };

let shell, W, $, bus, sheet, sq, shellMod, Q, model;
let RAIL = null;            // the one element, kept from the boot
let HOME = null;            // its place in .body: { parent, next }

const rail = () => $('queue-rail');
const bb = () => $('bb-queue');
const bbLabel = () => bb().querySelector('.bb-queue-label').textContent;
const queuePage = () => $('sh-tasks').querySelector('.sh-page[data-page="queue"]');
const queueBodyEl = () => queuePage().querySelector('.sh-pbody');
const st = () => sheet.sheetState();
const onQueuePage = () => { const s = st(); return s.open && s.view === 'tasks' && s.page === 'queue'; };
const posts = (url, method = 'POST') => shell.calls.filter((c) => c.url === url && c.method === method);
const item = (n, over = {}) => ({ id: `q${n}`, kind: 'signal', source: 'pane-x', summary: `next_run #${n}`,
  why_wake: 'a declared signal', staged: true, ...over });

function layout(avail = 644) {
  shell.scrollMetrics($('topbar'), { rect: { top: 0, height: 44, width: 390 } });
  shell.scrollMetrics($('bottombar'), { rect: { top: 44 + avail, height: 60, width: 390 } });
}

async function viewport(vp) {
  shell.setViewport(vp);
  await shell.tick();
}

// The queue as the daemon holds it: GET /api/queue answers it, a hydrate reads it.
async function setQueue(items) {
  Q.foldQueueFrame({ type: 'queue', op: 'clear' });
  queueBody = { items, count: items.length };
  await Q.hydrateQueue();
  await shell.tick();
}

before(async () => {
  shell = await bootShell({
    viewport: PHONE,
    routes: {
      '/api/mirror': () => ({}),
      '/api/queue': () => queueBody,
      '/api/queue/pending': () => ({ pending: parked }),
      '/api/queue/push': () => {
        if (pushAnswer.mode === 'parked') parked = { id: 'pw1', created_at: Date.now(), envelope: { meta: { count: 1 } }, items: [], note: '' };
        return pushAnswer;
      },
    },
    init: async (s) => {
      const ws = await s.importApp('ws.js');
      const { initChatState } = await s.importApp('chat-state.js');
      initChatState({ onFrame: ws.onFrame, onHello: ws.onHello });
      const { initChatSheet } = await s.importApp('chat-sheet.js');
      initChatSheet();
      const { initSheetTasks } = await s.importApp('chat-sheet-tasks.js');
      initSheetTasks();
      const { initSheetQueue } = await s.importApp('chat-sheet-queue.js');
      initSheetQueue();
    },
  });
  W = shell.window;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  sheet = await shell.importApp('chat-sheet.js');
  sq = await shell.importApp('chat-sheet-queue.js');
  shellMod = await shell.importApp('shell.js');
  Q = await shell.importApp('queue.js');
  model = await shell.importApp('sheet-model.js');
  await shell.frame(helloFrame());
  RAIL = rail();
});

after(() => shell.restore());

beforeEach(async () => {
  if (W.innerWidth !== PHONE.width || W.innerHeight !== PHONE.height) await viewport(PHONE);
  layout(644);
  sheet.closeSheet({ returnFocus: false });
  while (sheet.popPage('tasks'));
  if (st().view !== 'chat') shell.click($('sh-tab-chat'));
  await waitUntil(() => !(W.history.state && W.history.state.wcSheet), { timeout: 2000, what: 'the sheet\'s entry to go' });
  parked = null;
  pushAnswer = { ok: true, mode: 'parked', pending_id: 'pw1', delivers: 'Pushed — delivers with your next message.' };
  await setQueue([]);
  await Q.refreshPending();
  await shell.tick();
});

/* ── the move ──────────────────────────────────────────────────────────────── */

test('at init the rail sits in the kept Tasks → Queue page, in-sheet; the page reads Queue and the counts', async () => {
  assert.ok(queuePage(), 'the Queue page exists from the start (a kept page)');
  assert.equal(RAIL.parentNode, queueBodyEl(), 'the rail is the page body\'s child');
  assert.ok(RAIL.classList.contains('in-sheet'));
  assert.ok(queueBodyEl().classList.contains('sh-qbody'));
  assert.equal(document_count('#queue-rail'), 1, 'one rail in the document — never a copy');
  assert.equal(queuePage().querySelector('.sh-ptitle').textContent, 'Queue');
  assert.equal(queuePage().querySelector('.sh-back').textContent, '‹ Tasks');
  assert.equal(queuePage().querySelector('.sh-psub').textContent, model.EMPTY_QUEUE_LINE);
  await setQueue([item(1), item(2), item(3, { staged: false })]);
  assert.equal(queuePage().querySelector('.sh-psub').textContent, '2 queued · 1 held', 'the queue tray\'s own sub, on bus queue');
  parked = { id: 'w1', envelope: { meta: { count: 2 } }, items: [] };
  await setQueue([]);
  await Q.refreshPending();
  assert.equal(queuePage().querySelector('.sh-psub').textContent, '⇢ parked');
});

function document_count(sel) { return shell.document.querySelectorAll(sel).length; }

test('each breakpoint crossing moves the same element: home to .body at its place at 1280, back into the page at 390', async () => {
  await viewport(DESKTOP);
  const body = shell.document.querySelector('.body');
  assert.equal(rail(), RAIL, 'the same element, not a rebuilt one');
  assert.equal(RAIL.parentNode, body, 'back in .body');
  assert.equal(RAIL.previousElementSibling, body.querySelector('.well-wrap'), 'after the page well, where index.html has it');
  assert.equal(RAIL.classList.contains('in-sheet'), false);
  // index.html puts the rail last in .body, so an append would look like a
  // return to its place: an element after it tells the remembered next sibling
  // from the end of the parent.
  const after = shell.document.createElement('i');
  after.className = 'u70-sentinel';
  body.insertBefore(after, RAIL.nextSibling);
  HOME = { parent: RAIL.parentNode, next: RAIL.nextSibling };
  assert.equal(HOME.next, after);
  assert.equal(bb().getAttribute('aria-expanded'), 'false');
  try {
    await viewport(PHONE);
    assert.equal(rail(), RAIL);
    assert.equal(RAIL.parentNode, queueBodyEl(), 'moved in again');
    assert.ok(RAIL.classList.contains('in-sheet'));
    await viewport(DESKTOP);
    assert.equal(RAIL.parentNode, HOME.parent, 'the same parent');
    assert.equal(RAIL.nextSibling, HOME.next, 'and the same next sibling');
  } finally {
    after.remove();
  }
  await viewport(PHONE);
  assert.equal(rail(), RAIL);
  assert.equal(document_count('#queue-rail'), 1);
});

test('a flip to wide with the sheet open on the queue closes it and returns the rail at once', async () => {
  shell.click(bb());
  await shell.tick();
  assert.ok(onQueuePage());
  await viewport(DESKTOP);
  assert.equal(st().open, false);
  assert.equal(RAIL.parentNode, shell.document.querySelector('.body'));
  assert.equal(RAIL.classList.contains('in-sheet'), false);
  assert.equal(bb().getAttribute('aria-expanded'), 'false', 'shell.js\'s answer again: the rail is not open');
  assert.equal(bbLabel(), 'Queue');
});

test('a rail the wide layout left pinned open is put down by its own close before it moves', async () => {
  await viewport(DESKTOP);
  shell.key('q');
  assert.ok(RAIL.classList.contains('open'), 'precondition: Q pinned the wide rail open');
  await viewport(PHONE);
  assert.equal(RAIL.parentNode, queueBodyEl());
  assert.equal(RAIL.classList.contains('open'), false, 'no stale .open rides into the sheet');
  assert.equal(bbLabel(), 'Queue');
  shell.key('q');
  await shell.tick();
  assert.ok(onQueuePage(), 'one Q opens the queue page (the stale pin is gone)');
  shell.key('Escape');
  assert.equal(st().open, false, 'one Escape closes it');
});

/* ── the route ─────────────────────────────────────────────────────────────── */

test('the bottom bar\'s Queue opens the sheet on Tasks → Queue at least half, keeps "Queue", and Queue again closes', async () => {
  await setQueue([item(1)]);
  shell.click(bb());
  await shell.tick();
  assert.ok(onQueuePage(), 'Tasks → Queue');
  assert.ok(st().h >= st().stops.half, 'at least half');
  assert.ok(queuePage().contains(RAIL) && !queuePage().hidden, 'the page on screen holds the rail');
  assert.equal(bbLabel(), 'Queue', 'never "‹ Page" while the sheet holds the rail');
  assert.equal(bb().getAttribute('aria-label'), 'Queue to Claude');
  assert.equal(bb().getAttribute('aria-expanded'), 'true');
  assert.equal(RAIL.classList.contains('open'), false, 'the rail itself is never opened in the sheet');
  shell.click(bb());
  await shell.tick();
  assert.equal(st().open, false, 'Queue again closes');
  assert.equal(bb().getAttribute('aria-expanded'), 'false');
  assert.equal(bbLabel(), 'Queue');
});

test('Q does the same; from another page or the Chat view it goes to Tasks → Queue', async () => {
  shell.key('q');
  await shell.tick();
  assert.ok(onQueuePage());
  assert.equal(bb().getAttribute('aria-expanded'), 'true');
  shell.key('Q');
  await shell.tick();
  assert.equal(st().open, false);
  // Open on Chat: Q shows the queue rather than closing.
  sheet.openSheet({ view: 'chat' });
  await shell.tick();
  assert.equal(bb().getAttribute('aria-expanded'), 'false', 'the sheet is open, but not on the queue');
  shell.key('q');
  await shell.tick();
  assert.ok(onQueuePage());
  assert.equal(bb().getAttribute('aria-expanded'), 'true');
  // Back from the queue goes to the Tasks root.
  shell.click(queuePage().querySelector('.sh-back'));
  await shell.tick();
  assert.equal(st().page, null, 'the Tasks root');
  assert.equal(bb().getAttribute('aria-expanded'), 'false');
});

test('the Tasks root\'s Queue line shows the same page, holding the same rail', async () => {
  sheet.openSheet({ view: 'tasks' });
  await shell.tick();
  const line = $('sh-tasks').querySelector('.sh-line[data-cs-cat="queue"]');
  assert.ok(line, 'the Queue line');
  shell.click(line);
  await shell.tick();
  assert.ok(onQueuePage());
  assert.equal(queuePage().contains(rail()), true);
  assert.equal(bb().getAttribute('aria-expanded'), 'true');
});

test('Escape with the Queue page showing closes the sheet in one press; the label stays "Queue"', async () => {
  shell.click(bb());
  await shell.tick();
  assert.ok(onQueuePage());
  shell.key('Escape');
  assert.equal(st().open, false, 'one press: no pinned rail stood in front of the sheet');
  assert.equal(bbLabel(), 'Queue');
  assert.equal(bb().getAttribute('aria-expanded'), 'false');
});

test('while the route is in force shell.js leaves #bb-queue\'s aria-expanded to it, even from the rail\'s own close', async () => {
  shell.click(bb());
  await shell.tick();
  assert.equal(bb().getAttribute('aria-expanded'), 'true');
  shell.click(RAIL.querySelector('.rail-close'));   // hidden in the sheet; still the rail's control
  assert.equal(bb().getAttribute('aria-expanded'), 'true', 'the sheet still shows the queue');
  assert.ok(bb().classList.contains('on'));
  assert.equal(bbLabel(), 'Queue');
  assert.ok(onQueuePage());
});

test('the rail\'s hover does nothing while it is in the sheet', async () => {
  for (const type of ['pointerenter', 'pointerleave', 'pointerenter']) {
    RAIL.dispatchEvent(new W.PointerEvent(type, { pointerType: 'mouse' }));
    assert.equal(RAIL.classList.contains('open'), false, `${type} left the rail alone`);
    assert.equal(bbLabel(), 'Queue');
    assert.equal(bb().getAttribute('aria-expanded'), 'false');
  }
  assert.equal(st().open, false, 'and opened no sheet');
});

/* ── push and its feedback ─────────────────────────────────────────────────── */

test('Push from the page posts once and its feedback keeps the sheet on Tasks → Queue', async () => {
  await setQueue([item(1)]);
  shell.click(bb());
  await shell.tick();
  const push = RAIL.querySelector('.rail-push');
  assert.equal(push.disabled, false, 'a staged item enables Push');
  const before0 = posts('/api/queue/push').length;
  shell.click(push);
  await waitUntil(() => RAIL.querySelector('.rail-parked'), { timeout: 2000, what: 'the parked feedback' });
  assert.equal(posts('/api/queue/push').length, before0 + 1, 'one POST');
  assert.ok(onQueuePage(), 'the opener never closes the sheet');
  assert.ok(queuePage().contains(RAIL.querySelector('.rail-parked')), 'the feedback is on the page on screen');
});

test('P with the sheet closed opens it on Tasks → Queue, where the feedback shows', async () => {
  await setQueue([item(1)]);
  assert.equal(st().open, false);
  const before0 = posts('/api/queue/push').length;
  shell.key('p');
  await waitUntil(() => RAIL.querySelector('.rail-parked'), { timeout: 2000, what: 'the parked feedback' });
  assert.equal(posts('/api/queue/push').length, before0 + 1);
  assert.ok(onQueuePage(), 'opened there');
  assert.ok(st().h >= st().stops.half);
  // P with nothing to push says so — on the page.
  await setQueue([]);
  sheet.closeSheet({ returnFocus: false });
  shell.key('p');
  await shell.tick();
  assert.ok(onQueuePage());
  assert.ok(RAIL.querySelector('.rail-nothing'), '"Nothing to push yet" shows on the page');
});

/* ── the queue's capabilities, from the page ───────────────────────────────── */

test('from the page: stage and hold PATCH as before, ⟲ reverts, the count and the ⇢ mark stay current', async () => {
  await setQueue([item(1), item(2)]);
  assert.equal($('bb-queue-count').textContent, '2', '#bb-queue-count');
  shell.click(bb());
  await shell.tick();
  const row = (id) => RAIL.querySelector(`.rail-item[data-id="${id}"]`);
  const n0 = posts('/api/queue/q1', 'PATCH').length;
  shell.click(row('q1').querySelector('.qi-stage'));
  await shell.tick();
  assert.equal(posts('/api/queue/q1', 'PATCH').length, n0 + 1, 'hold posts');
  assert.deepEqual(posts('/api/queue/q1', 'PATCH').at(-1).body, { staged: false });
  assert.ok(row('q1').classList.contains('held'));
  assert.match(queuePage().querySelector('.sh-psub').textContent, /1 queued · 1 held/);
  shell.click(row('q1').querySelector('.qi-stage'));
  await shell.tick();
  assert.deepEqual(posts('/api/queue/q1', 'PATCH').at(-1).body, { staged: true }, 'stage posts');
  shell.click(row('q2').querySelector('.qi-revert'));
  await shell.tick();
  assert.equal(posts('/api/queue/q2?revert=1', 'DELETE').length, 1, '⟲ reverts');
  assert.equal($('bb-queue-count').textContent, '1');
  // The ⇢ parked mark on the bar.
  parked = { id: 'w1', envelope: { meta: { count: 2 } }, items: [] };
  await Q.refreshPending();
  assert.ok(bb().classList.contains('has-pending'));
  assert.ok(RAIL.classList.contains('has-pending'));
  assert.equal(RAIL.querySelector('.rail-pending').classList.contains('hidden'), false, 'the standing park shows on the page');
  const cancel = RAIL.querySelector('.rp-cancel');
  shell.click(cancel);
  await waitUntil(() => posts('/api/queue/pending/consume').length > 0, { timeout: 2000, what: 'Cancel delivery' });
});

test('from the page: a message row shows its text, and a park holding a message offers Take back', async () => {
  const msg = { id: 'q7', kind: 'message', msg_id: 'm-00000007', conversation_id: null, text: 'tighten the retry',
    skill: null, files: [], chars: 17, autosend: true, staged: true, source: 'composer', why_wake: 'message from the user',
    summary: 'message · 17 chars', origin: 'local', device: 'mobile' };
  await setQueue([msg]);
  shell.click(bb());
  await shell.tick();
  const row = RAIL.querySelector('.rail-item[data-id="q7"]');
  assert.ok(row && row.classList.contains('rail-msg'), 'the message row is in the rail on the page');
  assert.equal(row.querySelector('.qi-msg-text').textContent, 'tighten the retry');
  assert.ok(row.querySelector('.qi-stage') && row.querySelector('.qi-revert'), 'hold and remove on the row');
  parked = { id: 'w2', envelope: { meta: { count: 1 } }, items: [{ ...msg }] };
  await setQueue([]);
  await Q.refreshPending();
  const back = RAIL.querySelector('.rail-pending .rp-takeback');
  assert.ok(back && !back.hidden, 'Take back on the page');
  assert.equal(RAIL.querySelector('.rail-pending .rp-cancel').hidden, true, 'in place of Cancel');
});

test('the wake slot and the channel notice are the rail\'s own, on the page', async () => {
  assert.ok(queueBodyEl().querySelector('.wake-slot'), 'wake-panel.js fills it by id, wherever the rail is');
  assert.ok(queueBodyEl().querySelector('.rail-notice'));
  assert.ok(queueBodyEl().querySelector('#rail-add'), 'the note');
});

/* ── listeners and the seam ────────────────────────────────────────────────── */

test('after 20 breakpoint crossings a click on Push posts once: no listener doubled', async () => {
  for (let i = 0; i < 20; i += 1) {
    await viewport(i % 2 ? PHONE : DESKTOP);
  }
  await viewport(PHONE);
  layout(644);
  assert.equal(rail(), RAIL);
  assert.equal(RAIL.parentNode, queueBodyEl());
  await setQueue([item(1)]);
  shell.click(bb());
  await shell.tick();
  const before0 = posts('/api/queue/push').length;
  shell.click(RAIL.querySelector('.rail-push'));
  await waitUntil(() => RAIL.querySelector('.rail-parked'), { timeout: 2000, what: 'the push to land' });
  await shell.tick();
  assert.equal(posts('/api/queue/push').length, before0 + 1);
  // Q is still one toggle, not two.
  shell.key('q');
  await shell.tick();
  assert.equal(st().open, false);
});

test('with the route unregistered every path is today\'s: the full-screen rail, "‹ Page", Escape back to "Queue"', async () => {
  sq.stopSheetQueue();
  try {
    assert.equal(RAIL.parentNode, shell.document.querySelector('.body'), 'stopping returns the rail home');
    assert.equal(RAIL.classList.contains('in-sheet'), false);
    shell.click(bb());
    await shell.tick();
    assert.equal(st().open, false, 'no sheet');
    assert.ok(RAIL.classList.contains('open'), 'the rail is the queue screen');
    assert.equal(bbLabel(), '‹ Page');
    assert.equal(bb().getAttribute('aria-expanded'), 'true');
    shell.key('Escape');
    assert.equal(RAIL.classList.contains('open'), false);
    assert.equal(bbLabel(), 'Queue', 'Escape restores the label');
    assert.equal(bb().getAttribute('aria-expanded'), 'false');
    // Hover is the mouse's again.
    RAIL.dispatchEvent(new W.PointerEvent('pointerenter', { pointerType: 'mouse' }));
    assert.ok(RAIL.classList.contains('open'));
    RAIL.dispatchEvent(new W.PointerEvent('pointerleave', { pointerType: 'mouse' }));
    assert.equal(RAIL.classList.contains('open'), false);
  } finally {
    sq.initSheetQueue();
  }
  assert.equal(RAIL.parentNode, queueBodyEl(), 'initSheetQueue moves it in again');
  assert.equal(queuePage(), $('sh-tasks').querySelector('.sh-page[data-page="queue"]'), 'the one kept page, reused');
  assert.equal($('sh-tasks').querySelectorAll('.sh-page[data-page="queue"]').length, 1);
});

test('setQueueRoute: one at a time; a replaced route\'s unregister does nothing; a route answering false is today\'s path', async () => {
  const calls = [];
  const a = { active: () => true, toggle: () => calls.push('a.toggle'), open: () => calls.push('a.open') };
  const b = { active: () => false, toggle: () => calls.push('b.toggle'), open: () => calls.push('b.open') };
  assert.throws(() => shellMod.setQueueRoute({ active() {} }), TypeError);
  const offA = shellMod.setQueueRoute(a);   // replaces the sheet's
  try {
    shell.click(bb());
    assert.deepEqual(calls, ['a.toggle']);
    const offB = shellMod.setQueueRoute(b);
    offA();                                  // replaced: nothing
    shell.click(bb());
    assert.deepEqual(calls, ['a.toggle'], 'b answers false: today\'s path, b is not called');
    assert.ok(RAIL.classList.contains('open'), 'today\'s toggle pinned the rail');
    shell.key('Escape');
    assert.equal(RAIL.classList.contains('open'), false);
    offB();
  } finally {
    sq.stopSheetQueue();
    sq.initSheetQueue();
  }
  shell.click(bb());
  await shell.tick();
  assert.ok(onQueuePage(), 'the sheet\'s route again');
});

/* ── the source and the stylesheet ─────────────────────────────────────────── */

test('U70\'s section carries §8.7\'s rules; shell.js routes Queue, Q and the opener through one seam', () => {
  const start = CSS.indexOf('/* ── U70 · the queue in the sheet');
  const end = CSS.indexOf('/* ── U71 ·');
  assert.ok(start > 0 && end > start);
  const sec = CSS.slice(start, end);
  assert.match(sec, /\.chat-sheet \.rail\.in-sheet \{ position: static; display: flex; flex-direction: column; flex: 1; min-height: 0; width: auto;/);
  assert.match(sec, /\.chat-sheet \.rail\.in-sheet::before, \.chat-sheet \.rail\.in-sheet :is\(\.rail-collapsed, \.rail-head\) \{ display: none; \}/);
  assert.match(sec, /\.chat-sheet \.rail\.in-sheet \.rail-expanded \{ position: static;/);
  assert.match(sec, /\.chat-sheet \.rail\.in-sheet \.rail-items \{ overscroll-behavior: contain; \}/);
  assert.doesNotMatch(sec, /#[0-9a-f]{3,8}\b|rgb\(/i, 'tokens only');
  // The narrow 44px rules name the rail's parts, not its place, so they hold in the page.
  assert.match(CSS, /@media \(max-width: 759px\)[\s\S]*?\.qi-stage, \.qi-revert \{ width: 44px; height: 44px;/);
  assert.match(CSS, /\.rail-push \{ height: 48px;/);
  // Every route through the seam: the bar's Queue and Q via toggleRail, the opener via the route.
  assert.match(SHELL_SRC, /function toggleRail\(\) \{\s*if \(viaRoute\('toggle'\)\) return;/);
  assert.match(SHELL_SRC, /setRailOpener\(\(\) => \{ if \(viaRoute\('open'\)\) return;/);
  assert.match(SHELL_SRC, /on\('bb-queue', \(\) => toggleRail\(\)\)/);
  assert.match(SHELL_SRC, /case 'q': case 'Q': e\.preventDefault\(\); toggleRail\(\); break;/);
});

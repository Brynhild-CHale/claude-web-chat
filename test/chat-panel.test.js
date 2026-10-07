// The chat panel and its awaiting card (public/app/chat-panel.js,
// public/app/chat-awaiting.js) through the real shell (test-support/chrome-shell.js):
// design spec §7.9, §7.3's wording, §7.4's inks, §7.2's chat:host / chat:open,
// and U36's brief.
//
//   * ONE #chat-panel, built in JS, hosted in #cd-body and moved into whichever
//     host chat:host names last, keeping the stream's scroll offset.
//   * The header: #chat-title, an empty #cp-stop and #cp-ops (later tranches'),
//     and a close button that closes the chat.
//   * The strip says what chat-present's uiState says (LABEL · detail), its
//     ink from data-cs-state — a failed turn included; the meta line names the
//     session, the model, the mode and tokens or cost; two or more sessions make
//     the title a switcher.
//   * Notices: below read, disabled, offline over the kept stream.
//   * The awaiting card: an answer frame owns its body when one may answer,
//     else the read-only card; it hides when the ask resolves.
//   * The composer slot, detail views over the stream (Escape pops one, then
//     closes the dock), chat:open's view applied after the host shows.
//   * ONE setInterval ticker, only while the chat is open; stopPanel clears it.
//
// main.js inits the dock and the panel (U40), and the stream and the tool cards
// that draw inside #chat-stream; the boot's init calls the first two again (each
// is idempotent) and stops the other two, emptying #chat-stream as the panel
// built it, so the panel is tested alone: the stream has test/chat-stream.test.js.
//
// TIME. Every snapshot carries the daemon's clock as `now` = T, and each test
// holds Date.now still (beforeEach), so the panel and the test's own uiState
// read the same instant.
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { isReservedId, RESERVED_IDS } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const codeOf = (rel) => stripComments(read(rel)).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const realNow = Date.now;
const T = realNow();
const sec = (n) => n * 1000;
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, W, $, doc, bus, S, P, slots, dock, panel;
let current = null;          // what GET /api/mirror answers
let page = null;             // what the followed conversation's first turns page answers
let rev = 5000;

const live = (state, extra = {}) => ({ state, since: T - min(1), last_activity_at: T - sec(1), ...extra });
const conversation = (id, l, extra = {}) => ({ id, rev: 1, headless: false, counts: ZERO, live: l, ...extra });
function snapshot({ conversations = [conversation('c1', live('idle'))], primary = 'c1', asks = [], level = 'local',
  content = true } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content, access: { level, remote: level === 'basic' },
    capabilities: {}, primary, aggregate: { state: 'idle' }, conversations, tasks: [], asks };
}
const one = (l, extra = {}) => ({ conversations: [conversation('c1', l, extra)] });

// A (re)connect: the hello, the store's read of GET /api/mirror and the panel's frame.
async function hydrate(body) {
  current = body;
  await shell.frame(helloFrame());
  await shell.tick();
}
async function show(over) {
  const snap = snapshot(over);
  await hydrate(snap);
  assert.ok(S.mirror.availability === 'ok' && S.mirror.rev >= snap.rev, 'the mirror snapshot landed');
  return snap;
}

const strip = () => $('chat-strip');
const label = () => strip().querySelector('.cp-label').textContent;
const detail = () => strip().querySelector('.cp-text').textContent;
const card = () => $('chat-awaiting');
const isOpen = () => dock.isChatOpen();
async function openChat(detail = { view: 'chat', focus: 'composer' }) {
  bus.emit('chat:open', detail);
  await shell.tick();
}
const present = () => P.uiState(S.mirror, { now: S.serverNow(), approvalsReady: !!slots.approvals() });
const redraw = async () => { bus.emit('mirror', { what: ['all'] }); await shell.tick(); };

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => (current === null ? respond({ error: 'not found' }, { status: 404 }) : current),
      '/api/mirror/conversations/*': () => page || { conversation_id: 'c1', turns: [], next_before: null, total: 0, rev },
    },
    init: async (sh) => {
      (await sh.importApp('chat-dock.js')).initChatDock();
      (await sh.importApp('chat-panel.js')).initChatPanel();
      (await sh.importApp('chat-tools.js')).stopChatTools();
      (await sh.importApp('chat-stream.js')).stopChatStream();
      // The detail views main.js registers (tranche 3: 'task' and 'diff'), off:
      // this file registers its own through registerDetail.
      (await sh.importApp('chat-detail.js')).stopChatDetail();
      // #chat-stream as the panel builds it, empty: the stream's scaffolding out.
      const stream = sh.document.getElementById('chat-stream');
      if (stream) stream.replaceChildren();
    },
  });
  W = shell.window;
  doc = shell.document;
  $ = shell.$;
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  P = await shell.importApp('chat-present.js');
  slots = await shell.importApp('chat-slots.js');
  dock = await shell.importApp('chat-dock.js');
  panel = await shell.importApp('chat-panel.js');
  await show();
});

after(() => {
  Date.now = realNow;
  return shell.restore();
});

beforeEach(() => {
  const held = realNow();
  Date.now = () => held;
});
afterEach(() => {
  Date.now = realNow;
  while (panel.popDetail({ refocus: false }));
  dock.closeChat({ returnFocus: false });
});

/* ── the one panel and its hosts ───────────────────────────────────────────── */

test('one #chat-panel, in #cd-body; chat:open keeps it there; another chat:host moves the same element and keeps the stream\'s scrollTop', async () => {
  const el = $('chat-panel');
  assert.ok(el, 'built at init');
  assert.equal(doc.querySelectorAll('#chat-panel').length, 1);
  assert.equal(panel.panelEl(), el);
  assert.equal(panel.initChatPanel(), el, 'idempotent: a second init hands back the same panel');
  assert.equal(doc.querySelectorAll('#chat-panel').length, 1, 'still one');
  assert.equal(el.parentElement, $('cd-body'), 'hosted in the dock\'s body at init');
  assert.equal(el.dataset.variant, 'desktop');

  await openChat();
  assert.ok(isOpen());
  assert.equal(el.parentElement, $('cd-body'), 'chat:open: in #cd-body');

  const stream = $('chat-stream');
  for (let i = 0; i < 5; i++) stream.append(doc.createElement('p'));
  const metrics = shell.scrollMetrics(stream, { scrollHeight: 2000, clientHeight: 400, scrollTop: 700 });
  const other = doc.createElement('div');
  doc.body.append(other);
  // A browser drops an element's scroll offset when it leaves the document;
  // jsdom keeps it. Each host drops it on append, so only the panel's own
  // restore can keep it.
  const dropsScroll = (host) => {
    host.append = function append(...nodes) {
      W.Element.prototype.append.apply(this, nodes);
      stream.scrollTop = 0;
    };
    return () => { delete host.append; };
  };
  const undrop = [dropsScroll(other), dropsScroll($('cd-body'))];
  try {
    bus.emit('chat:host', { host: other, variant: 'sheet' });
    assert.equal($('chat-panel'), el, 'the same element');
    assert.equal(el.parentElement, other, 'moved into the new host');
    assert.equal(doc.querySelectorAll('#chat-panel').length, 1);
    assert.equal(stream.scrollTop, 700, 'the stream kept its scroll offset');
    assert.equal(stream.children.length, 5, 'and its content');
    assert.equal(el.dataset.variant, 'sheet');
    assert.equal(el.querySelector('.cp-close').textContent, 'Close', 'the sheet\'s close says Close');

    bus.emit('chat:host', { host: $('cd-body'), variant: 'desktop' });
    assert.equal(el.parentElement, $('cd-body'), 'and back');
    assert.equal(stream.scrollTop, 700);
    assert.equal(el.dataset.variant, 'desktop');
    assert.ok(el.querySelector('.cp-close kbd'), 'the desktop close wears <kbd>Esc</kbd>');

    // Stuck to the bottom (within 48px): it lands at the bottom of the new host.
    stream.scrollTop = 1580;
    metrics.scrollHeight = 2000;
    bus.emit('chat:host', { host: other, variant: 'sheet' });
    assert.equal(el.parentElement, other);
    assert.equal(stream.scrollTop, 2000, 'the stuck stream stays at its bottom');
    bus.emit('chat:host', { host: $('cd-body'), variant: 'desktop' });
    assert.equal(el.parentElement, $('cd-body'));
  } finally {
    for (const u of undrop) u();
    // A failed assertion above must not leave the panel in a host about to go.
    if (el.parentElement !== $('cd-body')) bus.emit('chat:host', { host: $('cd-body'), variant: 'desktop' });
    stream.replaceChildren();
    other.remove();
  }
});

test('the header: #chat-title, an empty #cp-stop and #cp-ops (no room while empty), and a close button that closes the dock', async () => {
  const head = $('chat-panel').querySelector('header.cp-head');
  assert.ok(head);
  assert.equal($('chat-title').textContent, 'CHAT ↔ CLAUDE');
  assert.ok(head.contains($('chat-title')) && head.contains($('cp-stop')) && head.contains($('cp-ops')));
  assert.equal($('cp-stop').childNodes.length, 0, '#cp-stop is the Stop control\'s (tranche 4)');
  assert.equal($('cp-ops').childNodes.length, 0, '#cp-ops is the session controls\' (tranche 6)');
  const css = stripComments(read('public/app.css'));
  assert.match(css, /\.cp-stop:empty,\s*\.cp-ops:empty\s*\{\s*display:\s*none;\s*\}/, 'display none while :empty');
  assert.equal($('chat-dock').getAttribute('aria-labelledby'), 'chat-title', 'the title names the dock');

  await openChat();
  const close = head.querySelector('button.cp-close');
  assert.equal(close.querySelector('kbd').textContent, 'Esc');
  shell.click(close);
  assert.equal(isOpen(), false, 'the close button closed the chat');
});

/* ── the strip ─────────────────────────────────────────────────────────────── */

test('the strip\'s LABEL and detail are uiState\'s, with data-cs-state, in every state', async () => {
  const cases = [
    ['working', live('working', { step: { kind: 'Edit', label: 'Edit · paths.js', started_at: T - sec(42) } })],
    ['question', live('question', { waiting: { kind: 'question', summary: 'Keep the 56px rail?', ask_id: 'aq' } })],
    ['waiting', live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm test)', ask_id: 'ap' } })],
    ['done', live('idle', { last_turn: { id: 't1', outcome: 'done', ended_at: T - min(4), code: { files: 3 } } })],
    ['stopped here', live('idle', { last_turn: { id: 't1', outcome: 'interrupted', ended_at: T - min(2), ended_by: 'web' } })],
    ['stopped in the terminal', live('idle', { last_turn: { id: 't1', outcome: 'interrupted', ended_at: T - min(2), ended_by: 'terminal' } })],
    ['suspended', live('suspended')],
  ];
  const seen = new Set();
  for (const [name, l] of cases) {
    await show(one(l));
    const s = present();
    assert.equal(strip().getAttribute('data-cs-state'), s.key, `${name}: data-cs-state`);
    assert.equal(strip().getAttribute('data-cs-pace'), s.pace, `${name}: data-cs-pace`);
    assert.equal(label(), s.label, `${name}: LABEL`);
    assert.equal(detail(), s.detail, `${name}: detail`);
    assert.equal(strip().title, s.text, `${name}: the whole line`);
    seen.add(s.detail);
  }
  assert.ok(seen.has('stopped from the web-chat page · 2m ago'), 'Stopped from this page');
  assert.ok(seen.has('interrupted · 2m ago'), 'Stopped in the terminal');
  assert.ok(seen.has('done · 3 files changed · 4m ago'), 'Done');

  // disabled: the server's hint
  await hydrate({ enabled: false, hint: 'claude-web-chat on turns it back on' });
  let s = present();
  assert.equal(label(), 'IDLE');
  assert.equal(detail(), s.detail);
  assert.equal(detail(), 'claude-web-chat on turns it back on');
  await show();
  s = present();
  assert.equal(detail(), s.detail);
});

test('a failed turn is worded from live.last_turn.error, as uiState words it', async () => {
  await show(one(live('idle', { last_turn: { id: 't9', outcome: 'error', error: 'API Error: 529 overloaded' } })));
  let s = present();
  assert.equal(strip().title, 'Stopped · API Error: 529 overloaded — see the terminal');
  assert.equal(strip().title, s.text);
  assert.equal(detail(), 'stopped: API Error: 529 overloaded');
  assert.equal(detail(), s.detail);
  assert.equal(label(), 'IDLE');

  await show(one(live('idle', { last_turn: { id: 't9', outcome: 'error' } })));
  s = present();
  assert.equal(strip().title, 'Stopped · the turn failed — see the terminal');
  assert.equal(strip().title, s.text);
  assert.equal(detail(), 'stopped: the turn failed');
});

/* ── the meta line ─────────────────────────────────────────────────────────── */

test('the meta line: Untitled session, the model, each mode word, tokens while live and $ once ended', async () => {
  const meta = () => $('chat-meta');
  const words = () => [...meta().children].filter((n) => !n.classList.contains('cp-sep') && n.id !== 'chat-session-list')
    .map((n) => n.textContent);

  await show(one(live('working'), { model: 'claude-opus-4-5', permission_mode: 'default',
    cost: { usd: null, tokens: { input: 1200, output: 300 } } }));
  assert.equal(meta().hidden, false);
  assert.equal($('chat-session').tagName, 'SPAN', 'one session: no switcher');
  assert.deepEqual(words(), ['Untitled session', 'claude-opus-4-5', 'default mode', '1.5k tokens']);

  const modes = { default: 'default mode', acceptEdits: 'accept edits', plan: 'plan mode', auto: 'auto mode',
    bypassPermissions: 'bypass permissions' };
  for (const [mode, word] of Object.entries(modes)) {
    await show(one(live('idle'), { title: 'Rail work', permission_mode: mode }));
    const el = meta().querySelector('.cp-mode');
    assert.equal(el.textContent, word, mode);
    assert.equal(el.classList.contains('cp-ink-comment'), mode === 'bypassPermissions', `${mode}: comment ink only for bypass`);
    assert.equal($('chat-session').textContent, 'Rail work');
  }

  await show(one(live('ended'), { title: 'Rail work', model: 'claude-opus-4-5', ended_at: T - min(3),
    cost: { usd: 0.4215, tokens: { input: 1200, output: 300 } } }));
  assert.deepEqual(words(), ['Rail work', 'claude-opus-4-5', '$0.42'], 'the dollar figure once ended');
  await show();
});

test('two live sessions make #chat-session a switcher: both with state dots, the headless one behind "Show headless (1)"; a choice follows it', async (t) => {
  t.after(() => S.followConversation(null));
  await show({ conversations: [
    conversation('c1', live('working'), { title: 'Rail work', last_activity_at: T - sec(5) }),
    conversation('c2', live('question', { waiting: { kind: 'question', summary: 'Which width?' } }), { title: 'Docs pass', last_activity_at: T - sec(9) }),
    conversation('c3', live('working'), { title: 'claude -p job', headless: true, last_activity_at: T - sec(1) }),
  ] });
  const btn = $('chat-session');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.getAttribute('aria-controls'), 'chat-session-list');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  const list = $('chat-session-list');
  assert.ok(list.classList.contains('popover') && list.classList.contains('hidden'), 'a closed .popover');
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.ok($('chat-panel').contains(list), 'inside the panel, so inside the dock');

  await openChat();
  shell.press(btn);
  await shell.tick();
  assert.ok(!list.classList.contains('hidden'), 'open');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  const opts = () => [...list.querySelectorAll('.cp-session-opt')];
  assert.deepEqual(opts().map((o) => o.dataset.conversation).sort(), ['c1', 'c2']);
  assert.deepEqual(opts().map((o) => o.querySelector('.cp-dot').getAttribute('data-cs-state')).sort(), ['question', 'working']);
  assert.equal(opts().find((o) => o.dataset.conversation === 'c1').getAttribute('aria-selected'), 'true');
  const more = list.querySelector('.cp-show-headless');
  assert.equal(more.textContent, 'Show headless (1)');
  shell.click(more);
  assert.deepEqual(opts().map((o) => o.dataset.conversation).sort(), ['c1', 'c2', 'c3'], 'the headless one shows on request');

  shell.click(opts().find((o) => o.dataset.conversation === 'c2'));
  await shell.tick();
  assert.equal(S.followed(), 'c2', 'followConversation');
  assert.ok(list.classList.contains('hidden'), 'the choice closes the list');
  assert.equal(strip().getAttribute('data-cs-state'), 'question', 'the strip follows');
  assert.equal(detail(), present().detail);
  assert.equal($('chat-session').textContent.replace('▾', ''), 'Docs pass');
});

/* ── notices ───────────────────────────────────────────────────────────────── */

test('notices: below read the remote line with its command; disabled the hint; a dropped socket the offline line over the kept stream', async () => {
  const notice = () => $('chat-notice');
  await show({ level: 'basic', content: false,
    conversations: [{ id: 'c1', state: 'working', since: T - min(1), last_activity_at: T - sec(1) }] });
  assert.equal(notice().hidden, false);
  assert.match(notice().textContent, /This surface is viewed remotely\. The conversation stays on the host unless this project allows it\./);
  assert.equal(notice().querySelector('code').textContent, 'claude-web-chat tunnel mirror on');

  await hydrate({ enabled: false, hint: 'run claude-web-chat on here' });
  assert.equal(notice().textContent, 'run claude-web-chat on here');
  await hydrate({ enabled: false });
  assert.equal(notice().textContent, 'the chat mirror is off');

  await show();
  assert.equal(notice().hidden, true, 'nothing to say at local, live');

  Date.now = realNow;   // the reconnect is the shell's own timer
  const stream = $('chat-stream');
  const kept = [doc.createElement('article'), doc.createElement('article')];
  stream.append(...kept);
  try {
    const sockets = shell.sockets.length;
    shell.socket().drop();
    await shell.tick();
    assert.equal(notice().hidden, false);
    assert.equal(notice().textContent, 'Offline — showing the last known state.');
    assert.equal(stream.children.length, 2, 'the stream is kept');
    assert.ok(kept.every((k) => k.parentElement === stream));
    assert.equal(strip().getAttribute('data-cs-state'), 'offline');
    assert.equal(label(), 'OFFLINE');
    await waitUntil(() => shell.sockets.length > sockets && shell.socket().readyState === 1,
      { timeout: 5000, what: 'the chrome to reconnect' });
    await show();
    assert.equal(notice().hidden, true);
  } finally {
    stream.replaceChildren();
  }
});

/* ── the awaiting card ─────────────────────────────────────────────────────── */

const permissionAsk = (extra = {}) => ({ id: 'ask-p', conversation_id: 'c1', kind: 'permission', tool_name: 'Bash',
  state: 'pending', answerable: true, created_at: T - sec(3), version: 1, masked: false, ...extra });
const permissionWait = live('waiting', { waiting: { kind: 'permission', tool: 'Bash',
  summary: 'Bash(rm -rf dist && npm run build)', ask_id: 'ask-p' } });

test('the read-only card: a permission in a code box, the masked line only when masked', async () => {
  await show({ ...one(permissionWait), asks: [permissionAsk()] });
  assert.equal(card().hidden, false);
  assert.equal(card().getAttribute('role'), 'group');
  assert.equal(card().querySelector('.cp-aw-title').textContent, 'AWAITING YOU · PERMISSION');
  assert.equal(card().querySelector('pre.cp-aw-code code').textContent, 'Bash(rm -rf dist && npm run build)');
  assert.equal(card().querySelector('.cp-aw-masked'), null, 'not masked: no masked line');
  assert.equal(card().querySelector('.cp-aw-hint').textContent, 'Answer in the terminal');

  await show({ ...one(permissionWait), asks: [permissionAsk({ masked: true })] });
  assert.equal(card().querySelector('.cp-aw-masked').textContent,
    'contains masked values — see the terminal for the full command');
});

test('the read-only card: a question shows its options from the matching AskUserQuestion item; a plan shows Show plan; the card hides when the ask resolves', async (t) => {
  t.after(() => { page = null; });
  page = { conversation_id: 'c1', rev: rev + 100, next_before: null, total: 1, turns: [{
    id: 't1', conversation_id: 'c1', seq: 1, status: 'open', started_at: T - min(1),
    items: [
      { id: 'tu-q', turn_id: 't1', kind: 'tool_call', seq: 1, tool: 'AskUserQuestion', tool_kind: 'Question', status: 'running',
        input: { questions: [{ question: 'Which rail width?', header: 'Rail',
          options: [{ label: '56px', description: 'the compact rail' }, { label: '64px' }] }] },
        awaiting: { ask_id: 'ask-q', kind: 'question', status: 'pending' } },
      { id: 'tu-p', turn_id: 't1', kind: 'tool_call', seq: 2, tool: 'ExitPlanMode', tool_kind: 'Plan', status: 'running',
        input: { planFilePath: 'plan.md' }, awaiting: { ask_id: 'ask-plan', kind: 'plan', status: 'pending' } },
    ],
  }] };
  await openChat();   // the stream is read while a chat view is open
  await show({ ...one(live('question', { waiting: { kind: 'question', summary: 'Which rail width?', ask_id: 'ask-q' } })),
    asks: [{ id: 'ask-q', conversation_id: 'c1', kind: 'question', state: 'pending', answerable: true, tool_use_id: 'tu-q' }] });
  await waitUntil(() => card().querySelector('.cp-aw-options'), { what: 'the options from the stream' });
  assert.equal(card().querySelector('.cp-aw-title').textContent, 'AWAITING YOU · QUESTION');
  assert.equal(card().querySelector('.cp-aw-text').textContent, 'Which rail width?');
  assert.deepEqual([...card().querySelectorAll('.cp-aw-options li')].map((li) => li.firstChild.textContent), ['56px', '64px']);
  assert.match(card().querySelector('.cp-aw-options li').textContent, /the compact rail/);
  assert.equal(card().getAttribute('data-cs-state'), 'question');

  await show({ ...one(live('waiting', { waiting: { kind: 'plan', tool: 'ExitPlanMode', ask_id: 'ask-plan' } })),
    asks: [{ id: 'ask-plan', conversation_id: 'c1', kind: 'plan', state: 'pending', tool_use_id: 'tu-p' }] });
  await waitUntil(() => S.mirror.stream.turns.length === 1, { what: 'the stream page' });
  await redraw();
  assert.equal(card().querySelector('.cp-aw-title').textContent, 'AWAITING YOU · PLAN');
  assert.equal(card().querySelector('.cp-aw-text').textContent, 'Claude wrote a plan and is waiting for approval');
  assert.equal(card().querySelector('.cp-aw-note').textContent, 'the plan is in the terminal');
  const showPlan = card().querySelector('button.cp-aw-showplan');
  assert.equal(showPlan.textContent, 'Show plan');
  // The stream (U37/U38) marks each tool card with data-item-id; Show plan opens
  // its group and scrolls to it.
  const group = doc.createElement('details');
  const toolCard = doc.createElement('div');
  toolCard.dataset.itemId = 'tu-p';
  group.append(toolCard);
  $('chat-stream').append(group);
  try {
    const scrolls = shell.scrolls.length;
    shell.click(showPlan);
    assert.equal(group.open, true, 'its turn group opened');
    assert.equal(shell.scrolls.length, scrolls + 1);
    assert.equal(shell.scrolls.at(-1).el, toolCard, 'scrolled to the plan\'s tool card');
    assert.equal(doc.activeElement, toolCard);
  } finally {
    group.remove();
  }

  // The terminal answers first (V9): the ask resolves, and the card goes.
  await show(one(live('working')));
  assert.equal(card().hidden, true, 'hidden once the ask resolved');
  assert.equal(card().childNodes.length, 0);
});

function fakeApprovals(t) {
  const calls = { mountCard: [], mountSheet: [], unmount: [] };
  const impl = {
    mountBar: () => false,
    mountCard(el, ask) {
      calls.mountCard.push(ask.id);
      const f = doc.createElement('div');
      f.className = 'test-answer-frame';
      f.textContent = 'Allow · Deny';
      el.append(f);
      return true;
    },
    mountSheet(el, ask) { calls.mountSheet.push(ask.id); return false; },
    unmount(el) { calls.unmount.push(el); },
  };
  const off = slots.registerApprovals(impl);
  t.after(off);
  return { calls, off };
}

test('a registered answer frame owns the card\'s body at level local, and only the title shows; at level read the read-only card shows', async (t) => {
  const { calls, off } = fakeApprovals(t);
  await show({ ...one(permissionWait), asks: [permissionAsk()] });
  assert.deepEqual(calls.mountCard, ['ask-p']);
  assert.equal(card().hidden, false);
  assert.equal(card().querySelector('.cp-aw-title').textContent, 'AWAITING YOU · PERMISSION');
  const body = card().querySelector('.cp-aw-body');
  assert.deepEqual([...body.children].map((c) => c.className), ['test-answer-frame'], 'the frame owns the body');
  assert.equal(card().querySelector('.cp-aw-hint'), null, 'no read-only lines beside it');
  assert.equal(card().querySelector('.cp-aw-code'), null);
  await redraw();
  assert.deepEqual(calls.mountCard, ['ask-p'], 'never remounted on a redraw');

  await show({ ...one(permissionWait), asks: [permissionAsk()], level: 'read' });
  assert.ok(calls.unmount.length >= 1, 'the frame was let go');
  assert.equal(card().querySelector('.test-answer-frame'), null);
  assert.equal(card().querySelector('pre.cp-aw-code code').textContent, 'Bash(rm -rf dist && npm run build)', 'read: the read-only card');
  assert.equal(card().querySelector('.cp-aw-hint').textContent, 'Answer in the terminal');

  off();
  await show({ ...one(permissionWait), asks: [permissionAsk()] });
  assert.equal(card().querySelector('.test-answer-frame'), null, 'no frame registered: read-only at local too');
  await show();
});

/* ── the composer slot ─────────────────────────────────────────────────────── */

test('the composer slot mounts a registered composer, else says where to reply', async (t) => {
  // main.js registers the real composer (U66a): it comes off for this case.
  const real = await shell.importApp('chat-composer.js');
  real.stopChatComposer();
  t.after(() => real.initChatComposer());
  await redraw();
  const slot = $('chat-composer-slot');
  assert.equal(slot.textContent, 'Reply in the terminal, or add a note in the queue rail (Q) and Push.');
  const mounts = [];
  const off = slots.registerComposer({
    mount(el, opts) { mounts.push(opts); const i = doc.createElement('textarea'); i.className = 'test-composer'; el.append(i); },
    focus() {},
    escape() { return false; },
  });
  t.after(off);
  await redraw();
  assert.deepEqual(mounts, [{ variant: 'desktop' }]);
  assert.ok(slot.querySelector('.test-composer'));
  assert.ok(!/Reply in the terminal/.test(slot.textContent));
  await redraw();
  assert.equal(mounts.length, 1, 'mounted once');
  off();
  await redraw();
  assert.equal(slot.querySelector('.test-composer'), null);
  assert.equal(slot.textContent, 'Reply in the terminal, or add a note in the queue rail (Q) and Push.');
});

/* ── details ───────────────────────────────────────────────────────────────── */

test('openDetail pushes a registered view with a ‹ Chat back button; Escape pops it and leaves the dock open; a second Escape closes the dock', async (t) => {
  let cleaned = 0;
  const seen = [];
  const off = panel.registerDetail('fake', (body, params, ctx) => {
    seen.push(params);
    body.textContent = `fake detail ${params.id}`;
    ctx.setTitle('Fake view');
    return () => { cleaned += 1; };
  });
  t.after(off);
  assert.equal(panel.hasDetail('fake'), true);
  assert.equal(panel.openDetail({ kind: 'nothing-registered' }), false);

  await openChat();
  assert.equal($('chat-detail').hidden, true);
  assert.equal(panel.openDetail({ kind: 'fake', title: 'Fake', params: { id: 'x1' } }), true);
  const host = $('chat-detail');
  assert.equal(host.hidden, false, 'pushed');
  assert.deepEqual(seen, [{ id: 'x1' }]);
  const back = host.querySelector('button.cp-back');
  assert.equal(back.textContent, '‹ Chat');
  assert.equal(host.querySelector('.cp-dtitle').textContent, 'Fake view');
  assert.match(host.querySelector('.cp-dbody').textContent, /fake detail x1/);
  assert.equal($('chat-stream').hasAttribute('inert'), true, 'the stream is out of reach under it');
  assert.equal($('chat-stream').isConnected, true, 'but still laid out (its scroll survives)');

  assert.equal(slots.escapeChatViews(), true);
  assert.equal(host.hidden, true, 'Escape popped it');
  assert.equal(cleaned, 1, 'its cleanup ran');
  assert.equal(isOpen(), true, 'and the dock stays open');
  assert.equal($('chat-stream').hasAttribute('inert'), false);
  assert.equal(slots.escapeChatViews(), true);
  assert.equal(isOpen(), false, 'a second Escape closes the dock');

  await openChat();
  panel.openDetail({ kind: 'fake', params: { id: 'x2' } });
  shell.click($('chat-detail').querySelector('.cp-back'));
  assert.equal($('chat-detail').hidden, true, '‹ Chat pops it too');
  assert.equal(cleaned, 2);
});

/* ── chat:open's view ──────────────────────────────────────────────────────── */

test('chat:open {view: "awaiting"} scrolls the card into view and focuses it; {view: "diff"} opens a registered diff, else stays on the chat', async (t) => {
  await show({ ...one(permissionWait), asks: [permissionAsk()] });
  const scrolls = shell.scrolls.length;
  await openChat({ view: 'awaiting', id: 'ask-p' });
  assert.ok(isOpen());
  assert.ok(shell.scrolls.slice(scrolls).some((s) => s.el === card()), 'scrolled into view');
  assert.equal(doc.activeElement, card(), 'focused');
  dock.closeChat({ returnFocus: false });

  await openChat({ view: 'diff', id: 'n1', node_id: 'n1' });
  assert.ok(isOpen());
  assert.equal($('chat-detail').hidden, true, 'no diff view registered: the chat stays on the stream');
  dock.closeChat({ returnFocus: false });

  const opened = [];
  t.after(panel.registerDetail('diff', (body, params) => { opened.push(params); }));
  await openChat({ view: 'diff', id: 'turn-4', node_id: 'n1.4' });
  assert.deepEqual(opened, [{ id: 'turn-4', node_id: 'n1.4' }]);
  assert.equal($('chat-detail').hidden, false);
  await openChat({ view: 'chat' });
  assert.equal($('chat-detail').hidden, true, 'view chat pops back to the stream');
  await show();
});

/* ── the ticker ────────────────────────────────────────────────────────────── */

test('the panel\'s ticker is ONE setInterval, present only while the chat is open; stopPanel() clears it', async () => {
  const before = new Set(shell.intervals().map((i) => i.id));
  const added = () => shell.intervals().filter((i) => !before.has(i.id));
  assert.equal(slots.posture(), 'status');
  assert.equal(added().length, 0, 'closed: no ticker');

  await openChat();
  assert.equal(added().length, 1, 'open: one ticker');
  const [tk] = added();
  assert.equal(tk.ms, 1000);
  // A tick redraws the running clock.
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · a.js', started_at: T - sec(10) } })));
  const held = Date.now;
  Date.now = () => held() + sec(5);
  try { tk.fn(); } finally { Date.now = held; }
  assert.equal(detail(), 'Edit · a.js · 0:15', 'the tick moved the clock');
  await openChat({ view: 'chat' });
  assert.equal(added().length, 1, 'a second chat:open adds none');

  dock.closeChat({ returnFocus: false });
  assert.equal(added().length, 0, 'closing clears it');

  await openChat();
  assert.equal(added().length, 1);
  panel.stopPanel();
  assert.equal(added().length, 0, 'stopPanel() clears it');
  dock.closeChat({ returnFocus: false });
  panel.initChatPanel();   // back to running for the rest of the file
  assert.equal(added().length, 0, 'restarted closed: still none');
  await show();
});

test('the source: no id outside RESERVED_IDS (with chat-session-list), no fetch, no write to #cp-stop or #cp-ops, no mask literal', () => {
  assert.ok(RESERVED_IDS.has('chat-session-list'), 'the one unplanned id is reserved');
  for (const rel of ['public/app/chat-panel.js', 'public/app/chat-awaiting.js']) {
    const src = read(rel);
    const ids = [
      ...[...src.matchAll(/\bid="([a-zA-Z][\w-]*)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/\.id\s*=\s*['"`]([a-zA-Z][\w-]*)['"`]/g)].map((m) => m[1]),
      ...[...src.matchAll(/getElementById\(\s*['"`]([a-zA-Z][\w-]*)['"`]/g)].map((m) => m[1]),
      ...[...src.matchAll(/'aria-controls',\s*'([a-zA-Z][\w-]*)'/g)].map((m) => m[1]),
    ];
    assert.ok(ids.length > 0 || rel.endsWith('awaiting.js'), `${rel}: found its ids`);
    assert.deepEqual(ids.filter((id) => !isReservedId(id)), [], `${rel}: every id is reserved`);
    const code = codeOf(rel);
    assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|\/api\/mirror/, `${rel}: never fetches mirror state`);
    assert.doesNotMatch(code, /from '\.\/ws\.js'/, `${rel}: no line to the socket`);
    assert.ok(!src.includes(`${'‹'}redacted`), `${rel}: the mask is redact.js's alone`);
    for (const m of code.matchAll(/from '\.\/([\w-]+)\.js'/g)) {
      assert.ok(['bus', 'chat-state', 'chat-present', 'chat-slots', 'chat-dock', 'chat-awaiting', 'markdown'].includes(m[1]),
        `${rel}: imports ${m[1]}.js`);
    }
  }
  const panelCode = codeOf('public/app/chat-panel.js');
  assert.deepEqual(panelCode.match(/\b(stop|ops)\.(append|replaceChildren|textContent|innerHTML|insertAdjacent)/g), null,
    '#cp-stop and #cp-ops are created empty and never written');
  assert.deepEqual(panelCode.match(/P\.(stop|ops)\b/g), null);
  assert.equal($('cp-stop').childNodes.length, 0);
  assert.equal($('cp-ops').childNodes.length, 0);
});

test('app.css: the U36 section uses tokens only and reuses U17\'s inks and pulse', () => {
  const css = read('public/app.css');
  const start = css.indexOf('/* ── U36 · the chat panel and the awaiting card');
  const end = css.indexOf('/* ── U37 ·');
  assert.ok(start > 0 && end > start, 'the U36 section, before U37\'s');
  const section = stripComments(css.slice(start, end));
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, 'no hex colour');
  assert.doesNotMatch(section, /rgba?\(|hsla?\(/, 'no literal colour');
  assert.doesNotMatch(section, /@keyframes/, 'wc-chat-pulse is reused, not redefined');
  assert.doesNotMatch(section, /\[data-cs-state="[a-z]+"\]\s*\{[^}]*--cs-st:/, 'the state inks are U17\'s');
  assert.match(section, /animation:\s*wc-chat-pulse var\(--cs-pulse\)/);
  assert.match(section, /prefers-reduced-motion: reduce/);
});

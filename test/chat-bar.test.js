// The chat mirror's desktop status bar (public/app/chat-bar.js), through the real
// shell (test-support/chrome-shell.js): design spec §7.5, §7.1's collisions and
// §7.4's inks, and the fallbacks left once the stand-ins of the maintainer's
// 2026-10-02 ruling went (U116, tranche 7).
//
//   * The bar says what chat-present's uiState says about the store, and only
//     that: the step's text and meta, its title the whole line, data-cs-state
//     and data-cs-pace on the bar, transitions spoken in #cs-live.
//   * ONE setInterval ticker, never a setTimeout chain (§10.1): it redraws a
//     running clock every second while the page is visible, a still line every
//     30th tick, and stopBar() stops it.
//   * The step opens the chat (chat:open) once a chat view is registered —
//     main.js registers the dock at boot, so it does from the first frame —
//     closing the graph overlay first; Answer › and Review › open the chat on
//     the wait; an answer frame mounts into #cs-act; another conversation
//     waiting gets a chip that follows it; #cs-stop stays empty.
//   * The fallbacks, with nothing registered, say only what is true: with no
//     chat view the step is a plain, disabled label that opens nothing; with
//     no answer frame a wait reads "Answer in the terminal" and no hint; and
//     the bar never writes #cs-chips, which is the trays' (claimChips).
//   * Collisions: the graph overlay is inset by --cs-bar-h, the service-trust
//     cards clear it, shell.js never makes the bar inert, and below 760px the
//     bar is hidden by app.css alone.
//
// main.js starts the store and the bar, and (tranche 2) registers the dock: the
// boot's init restarts the bar to own its ticker. The fallback cases are about
// the bar with NO chat view registered, so the first of them takes the dock's
// registration off (noChatView, below) after one case has proved the step
// against the real, registered dock.
//
// TIME. Every frame and snapshot carries the daemon's clock as `now` = T, and
// the store's serverNow() is that plus the time since the fold. Each test runs
// with Date.now held still (beforeEach), so the bar draws T exactly — a step
// started 42 s before T reads 0:42, whatever the machine's load — and a tick
// run by hand (tickAt) moves the clock on by just what the test says.
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { createCascade } = require('../test-support/css-cascade');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const codeOf = (rel) => stripComments(read(rel)).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const realNow = Date.now;
const T = realNow();
const sec = (n) => n * 1000;
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };


// ── public/app.css, read as the browser would cascade it ─────────────────────

const CSS = stripComments(read('public/app.css'));
// The rules whose selector list `pick` accepts, each with its selector list and
// the prelude of the @media block it sits in ('' at the top level).
function rulesWhere(pick) {
  const out = [];
  const walk = (src, media) => {
    let i = 0;
    for (;;) {
      const open = src.indexOf('{', i);
      if (open < 0) return;
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
      }
      const body = src.slice(open + 1, j - 1);
      const selectors = prelude.split(',').map((s) => s.trim());
      if (prelude.startsWith('@media')) walk(body, prelude);
      else if (!prelude.startsWith('@') && pick(selectors)) out.push({ media, selectors, body });
      i = j;
    }
  };
  walk(CSS, '');
  return out;
}
// The rules whose selector list names `sel` itself.
const rulesFor = (sel) => rulesWhere((selectors) => selectors.includes(sel));
const decl = (body, prop) => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
};

// ── the shell, the store and the bar ─────────────────────────────────────────

let shell, bus, S, P, slots, gv, bar;
let $, doc;
let barTicker = null;       // the one interval initChatBar registered
let current = null;         // what GET /api/mirror answers
let rev = 1000;

const live = (state, extra = {}) => ({ state, since: T - min(1), last_activity_at: T - sec(1), ...extra });
const conversation = (id, l, extra = {}) => ({ id, rev: 1, title: `title of ${id}`, headless: false, counts: ZERO,
  live: l, ...extra });
function snapshot({ conversations = [conversation('c1', live('idle'))], primary = 'c1', asks = [], level = 'local' } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: true, access: { level, remote: false }, capabilities: {},
    primary, aggregate: { state: 'idle' }, conversations, tasks: [], asks };
}
// The followed conversation, c1, in one live state.
const one = (l) => ({ conversations: [conversation('c1', l)] });

// A (re)connect: the hello, the store's read of GET /api/mirror (answered at
// once, so it has landed by the end of the frame's tick) and the bar's frame.
async function show(over) {
  const snap = snapshot(over);
  current = snap;
  await shell.frame(helloFrame());
  await shell.tick();
  assert.ok(S.mirror.availability === 'ok' && S.mirror.rev >= snap.rev, 'the mirror snapshot landed');
  return snap;
}
// One live state for c1, as the engine's next flush sends it.
const update = (l) => shell.frame({ type: 'mirror:update', rev: ++rev, now: T, conversation_id: 'c1', live: l });

// The bar's ticker, run by hand (the shell stubs setInterval), with the clock
// moved on by `ms` while it runs.
function tickAt(ms = 0, fn = barTicker.fn) {
  const held = Date.now;
  const at = held() + ms;
  Date.now = () => at;
  try { fn(); } finally { Date.now = held; }
}
// stopBar + initChatBar: a fresh ticker, counting its ticks from zero.
function restartBar() {
  bar.stopBar();
  const known = new Set(shell.intervals().map((i) => i.id));
  bar.initChatBar();
  const fresh = shell.intervals().filter((i) => !known.has(i.id));
  assert.equal(fresh.length, 1, 'one ticker');
  [barTicker] = fresh;
}
// Put c1 in a state with NO reason of its own to redraw on a tick: no running
// clock, nothing waiting to be said (it arrives from a suspend, which is never
// announced), and a ticker far from its 30th tick. A redraw on the next tick is
// then the work of whatever the test changes, and nothing else.
async function quietly(l) {
  await show(one(live('suspended')));
  restartBar();
  await show(one(l));
}

const step = () => $('cs-step');
const text = () => $('cs-step-text').textContent;
const meta = () => $('cs-step-meta').textContent;
const state = () => $('chat-statusbar').getAttribute('data-cs-state');
const pace = () => $('chat-statusbar').getAttribute('data-cs-pace');
// What the stand-ins were (U116 removed them): their chips and their note.
const devChips = () => [...$('cs-chips').querySelectorAll('.cs-devchip')];
const devNote = () => doc.querySelector('.cs-dev');
const act = () => $('cs-act');
// Every chat:open from here on, with whether the graph still covered the page.
function opens(t) {
  const seen = [];
  t.after(bus.on('chat:open', (d) => seen.push({ ...d, covered: gv.isOverlayOpen() })));
  return seen;
}
// A chat view as the dock will register one (chat-slots registerChatView).
function fakeView(t, id = 'test-dock') {
  const view = {
    id, open: false, closes: 0,
    isOpen() { return this.open; },
    escape() { if (!this.open) return false; this.open = false; return true; },
    close() { this.open = false; this.closes += 1; },
  };
  const reg = slots.registerChatView(view);
  t.after(() => reg.unregister());
  return { view, reg };
}
// The bar with no chat view, as it stood before the dock: main.js registers
// the dock at boot (public/app/chat-dock.js, view id 'dock') and, from
// tranche 5, the phone's sheet (public/app/chat-sheet.js, view id 'sheet'); a
// view registered under either id replaces that registration, and
// unregistering it leaves none. The dock is not put back — chat-slots keeps no
// way to, and the dock's init runs once — so every case after the first that
// calls this runs on the seam with views of its own (fakeView), as the whole
// file did before main.js registered one. A tick lets the bar see the seam move.
function noChatView() {
  for (const id of ['dock', 'sheet']) {
    if (!slots.chatViews().some((v) => v.id === id)) continue;
    slots.registerChatView({ id, isOpen: () => false, escape: () => false, close() {} }).unregister();
    tickAt();
  }
  assert.equal(slots.chatViews().length, 0, 'precondition: no chat view');
}
// An approvals provider as the answer frames will register one.
function fakeApprovals(t, { mount = true } = {}) {
  const calls = { mountBar: [], unmount: [] };
  const impl = {
    mountBar(el, ask) {
      calls.mountBar.push({ el, ask });
      if (!mount) return false;
      const frame = doc.createElement('span');
      frame.className = 'test-frame';
      frame.textContent = 'Allow · Deny';
      el.append(frame);
      return true;
    },
    mountCard: () => false,
    mountSheet: () => false,
    unmount(el) { calls.unmount.push(el); },
  };
  t.after(slots.registerApprovals(impl));
  return calls;
}

before(async () => {
  shell = await bootShell({
    routes: { '/api/mirror': () => current },
    init: async (sh) => {
      const ws = await sh.importApp('ws.js');
      const { view } = await sh.importApp('state.js');
      const store = await sh.importApp('chat-state.js');
      store.initChatState({ onFrame: ws.onFrame, onHello: ws.onHello, conn: view.conn });
      bar = await sh.importApp('chat-bar.js');
      // Once main.js starts the bar itself, it is running already: this file
      // wants a ticker of its own, counted from its start.
      bar.stopBar();
      // main.js also starts the trays (tranche 3), whose claimChips() takes
      // #cs-chips at boot and who build #cs-tray. This file is about the bar
      // and its fallbacks, so it takes the trays off: stopTrays() empties
      // #cs-chips, removes the tray and calls claimChips' release() (the trays'
      // own takeover: chat-trays.test.js, t3-e2e-chrome).
      (await sh.importApp('chat-trays.js')).stopTrays();
      const known = new Set(sh.intervals().map((i) => i.id));
      bar.initChatBar();
      const mine = sh.intervals().filter((i) => !known.has(i.id));
      assert.equal(mine.length, 1, 'initChatBar registers exactly one interval');
      [barTicker] = mine;
    },
  });
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  P = await shell.importApp('chat-present.js');
  slots = await shell.importApp('chat-slots.js');
  gv = await shell.importApp('graph-view.js');
  doc = shell.document;
  $ = shell.$;
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
afterEach(() => { Date.now = realNow; });

/* ── the markup and the module ─────────────────────────────────────────────── */

test('the bar host holds the step, the act area, the empty Stop slot, the divider, the chips and a live region, in that order', () => {
  const statusbar = $('chat-statusbar');
  assert.equal(statusbar.parentElement, $('stage'), 'a direct child of #stage, the row under the body');
  assert.equal(statusbar.getAttribute('role'), 'region');
  assert.equal(statusbar.getAttribute('aria-label'), 'Claude session');
  const kids = [...statusbar.children].map((el) => el.id || el.className);
  assert.deepEqual(kids, ['cs-step', 'cs-act', 'cs-stop', 'cs-div', 'cs-chips', 'cs-live']);
  assert.equal(step().tagName, 'BUTTON');
  assert.equal(step().getAttribute('type'), 'button');
  assert.deepEqual([...step().children].map((el) => el.className), ['cs-dot', 'cs-step-text', 'cs-step-meta']);
  assert.equal($('cs-chips').getAttribute('role'), 'group');
  assert.equal($('cs-live').getAttribute('aria-live'), 'polite');
  assert.equal($('cs-stop').childNodes.length, 0, '#cs-stop is the Stop control\'s, empty until it mounts');
});

test('one setInterval ticker, unref\'d where it can be, and never a setTimeout chain', () => {
  assert.equal(barTicker.ms, 1000, 'one tick a second');
  const code = codeOf('public/app/chat-bar.js');
  assert.equal((code.match(/\bsetInterval\s*\(/g) || []).length, 1, 'exactly one setInterval');
  assert.doesNotMatch(code, /\bsetTimeout\s*\(/, 'no setTimeout at all: a perpetual timer is a setInterval');
  assert.match(code, /\.unref\(\)/, 'the ticker is unref\'d where the runtime allows');
});

/* ── what the bar says ─────────────────────────────────────────────────────── */

test('mirror frames render the step\'s text and meta, and the step\'s title carries the whole line', async () => {
  await show(one(live('working', {
    step: { kind: 'Edit', tool: 'Edit', label: 'Edit · QueueRail.tsx', started_at: T - sec(42) }, last_activity_at: T - sec(2),
  })));
  assert.equal(text(), 'Edit · QueueRail.tsx');
  assert.equal(meta(), '0:42');
  assert.equal(step().title, 'Edit · QueueRail.tsx · 0:42', 'the whole line, which the row may cut short');
  assert.equal(state(), 'working');
  assert.equal(pace(), 'normal');

  // The next flush moves it on: the next step, with its own clock.
  await update(live('working', { step: { kind: 'Bash', tool: 'Bash', label: 'Bash · npm test', started_at: T - sec(7) } }));
  assert.equal(text(), 'Bash · npm test');
  assert.equal(meta(), '0:07');
  assert.equal(step().title, 'Bash · npm test · 0:07');
});

test('data-cs-state, data-cs-pace and the words follow uiState for every state the bar can be in', async () => {
  const cases = [
    ['working', live('working', { step: { kind: 'Read', label: 'Read · app.css', started_at: T - sec(3) } })],
    ['compacting', live('compacting', { since: T - sec(18) })],
    ['quiet', live('working', { quiet: { since: T - min(4), reason: 'no-activity' },
      step: { kind: 'Bash', label: 'Bash · npm test', started_at: T - min(5) } })],
    ['question', live('question', { waiting: { kind: 'question', summary: 'Keep the 56px rail?', ask_id: 'ask-q' } })],
    ['permission', live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist)', ask_id: 'ask-p' } })],
    ['plan', live('waiting', { waiting: { kind: 'plan', ask_id: 'ask-plan' } })],
    ['other wait', live('waiting', { waiting: { kind: 'other', summary: 'an MCP form' } })],
    ['suspended', live('suspended')],
    ['idle', live('idle', { last_turn: { id: 't1', outcome: 'done', ended_at: T - min(4), reply_preview: 'The rail now collapses.' } })],
    ['ended', live('ended')],
  ];
  const seen = new Set();
  for (const [name, l] of cases) {
    await show(one(l));
    const s = P.uiState(S.mirror, { now: S.serverNow(), approvalsReady: false });
    assert.equal(state(), s.key, `${name}: data-cs-state`);
    assert.equal(pace(), s.pace, `${name}: data-cs-pace`);
    assert.equal(text(), s.head, `${name}: the step's text`);
    assert.equal(meta(), s.meta, `${name}: the step's meta`);
    assert.equal(step().title, s.text, `${name}: the step's title`);
    seen.add(`${s.key}/${s.pace}`);
  }
  assert.deepEqual([...seen].sort(), ['idle/normal', 'question/normal', 'suspended/normal', 'waiting/normal',
    'working/normal', 'working/quiet'], 'every state and both paces were on the bar');
  assert.equal(text(), 'Session ended');
});

test('a dropped socket reads offline, and the next connection brings the state back', async () => {
  Date.now = realNow;   // the reconnect is the shell's own timer
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · paths.js', started_at: T - sec(12) } })));
  const sockets = shell.sockets.length;
  shell.socket().drop();
  await shell.tick();
  assert.equal(state(), 'offline');
  assert.equal(text(), 'Offline · reconnecting…');
  assert.match(meta(), /^\d+s$/, 'with how long it has been down');

  await waitUntil(() => shell.sockets.length > sockets && shell.socket().readyState === 1,
    { timeout: 5000, what: 'the chrome to reconnect' });
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · paths.js', started_at: T - sec(12) } })));
  assert.equal(state(), 'working');
  assert.equal(text(), 'Edit · paths.js');
});

test('transitions are spoken through #cs-live', async () => {
  await show(one(live('suspended')));   // nothing is ever held for a suspend
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(1) } })));
  await update(live('question', { waiting: { kind: 'question', summary: 'Which rail width?', ask_id: 'ask-live' } }));
  // Said at once, or — inside the 2 s since the last thing said — held, and said
  // by the ticker once the gap has passed.
  if ($('cs-live').textContent !== 'Claude has a question: Which rail width?') tickAt(min(30));
  assert.equal($('cs-live').textContent, 'Claude has a question: Which rail width?');
});

/* ── the ticker ────────────────────────────────────────────────────────────── */

test('the ticker redraws a running clock every second, and a still line or a hidden page every 30th tick', async (t) => {
  await show(one(live('suspended')));   // from a state nothing waits to be said in…
  restartBar();                         // …with a ticker counting from zero
  let n = 0;
  const run = (ms) => { n += 1; tickAt(ms); return meta(); };
  // Which of `count` more ticks (from the next) is a 30th one.
  const thirtieths = (count) => Array.from({ length: count }, (_, i) => (n + i + 1) % 30 === 0);

  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · QueueRail.tsx', started_at: T - sec(42) } })));
  assert.equal(meta(), '0:42');
  assert.equal(run(sec(5)), '0:47', 'one tick, five seconds on: the clock moves');
  assert.equal(step().title, 'Edit · QueueRail.tsx · 0:47');

  // A hidden page: the clock is redrawn on the 30th tick only, and on the first
  // tick back in sight.
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
  t.after(() => { delete doc.visibilityState; });
  let due = thirtieths(30);
  let drawn = false;
  const hidden = due.map((thirtieth) => { drawn = drawn || thirtieth; return [run(sec(10)), drawn ? '0:52' : '0:47']; });
  assert.deepEqual(hidden.map(([got]) => got), hidden.map(([, want]) => want), 'hidden: redrawn on the 30th tick alone');
  delete doc.visibilityState;
  assert.equal(run(sec(11)), '0:53', 'in sight again: every tick');

  // A still line, "4m ago", is redrawn on the 30th tick only.
  await show(one(live('suspended')));
  await show(one(live('idle', { last_turn: { id: 't2', outcome: 'done', ended_at: T - min(4), reply_preview: 'Done.' } })));
  assert.equal(meta(), '4m ago');
  due = thirtieths(30);
  drawn = false;
  const still = due.map((thirtieth) => { drawn = drawn || thirtieth; return [run(min(2)), drawn ? '6m ago' : '4m ago']; });
  assert.deepEqual(still.map(([got]) => got), still.map(([, want]) => want), 'still: redrawn on the 30th tick alone');
});

/* ── the dock main.js registers ─────────────────────────────────────────────── */

test('main.js registers the dock at boot: the step controls #chat-dock, offers M, and opens it (chat:open)', async (t) => {
  const dock = await shell.importApp('chat-dock.js');
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(2) } })));
  t.after(() => { if (dock.isChatOpen()) dock.closeChat({ returnFocus: false }); });
  assert.deepEqual(slots.chatViews(), [{ id: 'dock', open: false }, { id: 'sheet', open: false }],
    'the dock and the phone\'s sheet (tranche 5), and only they, registered at boot');
  tickAt();
  assert.equal(step().getAttribute('aria-controls'), 'chat-dock', 'the step controls the dock, not the note');
  assert.equal(step().getAttribute('aria-expanded'), 'false');
  assert.equal(step().getAttribute('aria-keyshortcuts'), 'M');
  assert.equal(step().hasAttribute('aria-disabled'), false);
  const seen = opens(t);

  shell.press(step());
  assert.deepEqual(seen, [{ view: 'chat', focus: 'composer', covered: false }], 'chat:open, to the composer');
  assert.equal(doc.getElementById('cs-tray'), null, 'and no #cs-tray');
  await shell.tick();
  assert.ok(dock.isChatOpen(), 'the dock heard it and opened');
  assert.equal(step().getAttribute('aria-expanded'), 'true', 'the step says the chat is open');
  shell.press(step());
  assert.ok(!dock.isChatOpen(), 'with the chat open, the step closes it');
  assert.equal(seen.length, 1, 'and opens nothing');
});

/* ── fallback (a): the step, with no chat view ─────────────────────────────── */

test('with no chat view the step is a plain label: disabled, it controls nothing, opens nothing and builds no #cs-tray', async (t) => {
  noChatView();
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(2) } })));
  assert.equal(slots.chatViews().length, 0, 'precondition: no chat view');
  assert.equal(text(), 'Edit · app.css', 'it still says what Claude is doing');
  assert.equal(step().title, 'Edit · app.css · 0:02');
  assert.equal(step().disabled, true, 'disabled: there is no chat to open');
  for (const a of ['aria-controls', 'aria-expanded', 'aria-keyshortcuts']) {
    assert.equal(step().hasAttribute(a), false, `no ${a}: it controls and promises nothing`);
  }
  const seen = opens(t);

  shell.press(step());
  shell.click(step());
  step().click();
  await shell.tick();
  assert.deepEqual(seen, [], 'no chat:open: there is no chat to open');
  assert.equal(doc.getElementById('cs-tray'), null, 'and no #cs-tray: the bar builds none');
  assert.equal(devNote(), null, 'and no note');
  tickAt(sec(1));
  assert.equal(step().disabled, true, 'a tick leaves it a label');
});

test('once a chat view registers, the label becomes the step that opens the chat', async (t) => {
  noChatView();
  await quietly(live('idle', { last_turn: { id: 't3', outcome: 'done', ended_at: T - min(3), reply_preview: 'Done.' } }));
  assert.equal(step().disabled, true, 'precondition: the step is a plain label');
  const seen = opens(t);

  const { view, reg } = fakeView(t);
  tickAt();   // no event says a view registered: the next tick sees the seam move, and redraws
  assert.equal(step().disabled, false, 'enabled by itself when the chat registers');
  assert.equal(step().getAttribute('aria-controls'), 'chat-dock');
  assert.equal(step().getAttribute('aria-expanded'), 'false');
  assert.equal(step().getAttribute('aria-keyshortcuts'), 'M');
  assert.equal(step().hasAttribute('aria-disabled'), false);

  shell.press(step());
  assert.deepEqual(seen, [{ view: 'chat', focus: 'composer', covered: false }], 'chat:open, to the composer');
  assert.equal(doc.getElementById('cs-tray'), null, 'and no #cs-tray');

  view.open = true;
  reg.changed();   // the registry announces the posture, and the bar hears it
  await shell.tick();
  assert.equal(step().getAttribute('aria-expanded'), 'true', 'the step says the chat is open');
  shell.press(step());
  assert.equal(view.closes, 1, 'with the chat open, the step closes it');
  assert.equal(seen.length, 1, 'and opens nothing');

  reg.unregister();
  tickAt();
  assert.equal(step().disabled, true, 'the view gone, the step is a label again');
  for (const a of ['aria-controls', 'aria-expanded', 'aria-keyshortcuts']) assert.equal(step().hasAttribute(a), false, a);
});

test('hovering tints only a step that opens the chat: the disabled label keeps its plain background (U123)', async (t) => {
  // jsdom has no pointer, so nothing ever matches :hover. Read the cascade of
  // app.css with every :hover written as a marker class (the same specificity:
  // a pseudo-class counts as a class), and put that class on the step.
  const HOVER = 'wc-test-hover';
  const { value } = createCascade(read('public/app.css').replace(/:hover\b/g, `.${HOVER}`), { win: () => shell.window });
  const background = (hovered) => {
    step().classList.toggle(HOVER, hovered);
    try { return value(step(), 'background'); } finally { step().classList.remove(HOVER); }
  };

  noChatView();
  await quietly(live('idle'));
  assert.equal(step().disabled, true, 'precondition: the step is the disabled fallback label');
  const plain = background(false);
  assert.equal(plain, 'transparent', 'precondition: the step draws no box of its own');
  assert.equal(background(true), plain, 'a disabled step is not tinted on hover: it opens nothing');

  fakeView(t);
  tickAt();
  assert.equal(step().disabled, false, 'precondition: a chat view makes it the step that opens the chat');
  assert.equal(step().getAttribute('aria-expanded'), 'false');
  assert.equal(background(false), plain, 'unhovered, still no box');
  const tint = background(true);
  assert.match(tint, /^color-mix\(/, 'an actionable step still tints on hover');

  // The open step's own tint is not undercut by the hover rule under the pointer.
  step().setAttribute('aria-expanded', 'true');
  try {
    const open = background(false);
    assert.notEqual(open, tint, 'precondition: an open step has a tint of its own');
    assert.equal(background(true), open, 'hovering an open step keeps its open tint');
  } finally { step().setAttribute('aria-expanded', 'false'); }
});

test('with a chat view, the step closes the graph overlay first; a chat it covered is shown, not shut', async (t) => {
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(2) } })));
  const { view } = fakeView(t);
  tickAt();
  const seen = opens(t);
  t.after(() => { if (gv.isOverlayOpen()) gv.closeOverlay(); });

  await gv.openOverlay();
  assert.ok(gv.isOverlayOpen(), 'precondition: the graph is open');
  shell.press(step());
  assert.ok(!gv.isOverlayOpen(), 'the graph closed');
  assert.deepEqual(seen, [{ view: 'chat', focus: 'composer', covered: false }], 'before chat:open went out');

  view.open = true;
  await gv.openOverlay();
  shell.press(step());
  assert.ok(!gv.isOverlayOpen());
  assert.equal(view.closes, 0, 'the chat the graph covered is not shut by the click that uncovers it');
  assert.equal(seen.length, 2, 'it is opened, which shows it');
});

test('with no chat view the step opens nothing over the graph either: the overlay stays', async (t) => {
  noChatView();
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(2) } })));
  assert.equal(slots.chatViews().length, 0, 'precondition: no chat view, so the step is a label');
  t.after(() => { if (gv.isOverlayOpen()) gv.closeOverlay(); });
  const seen = opens(t);
  await gv.openOverlay();
  assert.ok(gv.isOverlayOpen(), 'precondition: the graph is open');
  shell.click(step());
  assert.ok(gv.isOverlayOpen(), 'the label closes nothing: there is nothing it would open');
  assert.deepEqual(seen, []);
  assert.equal(devNote(), null);
});

test('with no chat view the step closes no panel already showing: it opens none to replace it', async (t) => {
  noChatView();
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(2) } })));
  assert.equal(slots.chatViews().length, 0, 'precondition: the step is a label');
  t.after(() => { shell.key('Escape'); });
  shell.press($('btn-more'));
  assert.ok(!$('more-menu').classList.contains('hidden'), 'precondition: the More menu is open');
  shell.click(step());   // a click with no pointerdown before it: the shell's dismiss layer never runs
  assert.ok(!$('more-menu').classList.contains('hidden'), 'the More menu stays open');
  assert.equal($('btn-more').getAttribute('aria-expanded'), 'true', 'and its trigger says so');
  assert.equal(doc.getElementById('cs-tray'), null, 'no #cs-tray');
});

/* ── fallback (b): #cs-chips is the trays' ──────────────────────────────────── */

test('the bar writes nothing into #cs-chips in any state: no .cs-devchip, and an empty row app.css hides', async (t) => {
  t.after(() => S.followConversation(null));
  const states = [
    ['working, with counts', { conversations: [conversation('c1', live('working', { step: { kind: 'Edit', label: 'Edit · app.css' } }),
      { counts: { shells: 2, agents: 1, workflows: 1, monitors: 2 } })] }],
    ['a question', one(live('question', { waiting: { kind: 'question', summary: 'Which width?', ask_id: 'ask-c1' } }))],
    ['a permission', one(live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(ls)', ask_id: 'ask-c2' } }))],
    ['idle', one(live('idle'))],
    ['suspended', one(live('suspended'))],
  ];
  for (const [what, over] of states) {
    await show(over);
    tickAt(sec(1));
    assert.deepEqual(devChips(), [], `${what}: no stand-in chip`);
    assert.equal($('cs-chips').childNodes.length, 0, `${what}: #cs-chips is empty, the trays' to fill`);
  }
  shell.press(step());
  assert.deepEqual(devChips(), [], 'a click on the step brings none');
  // Empty, the row and its divider take no room; no rule styles a stand-in chip.
  assert.ok(rulesWhere((sels) => sels.includes('.cs-chips:empty')).some((r) => decl(r.body, 'display') === 'none'));
  assert.deepEqual(rulesWhere((sels) => sels.some((x) => /\.cs-devchip/.test(x))), []);
});

test('claimChips(): the bar never writes #cs-chips, claimed or released, and a tray chip\'s state is the trays\' alone', async (t) => {
  await show(one(live('working')));
  const release = bar.claimChips();
  let released = false;
  t.after(() => { if (!released) release(); });

  // A tray chip as the trays render one (spec §7.6): its aria-expanded is the trays' alone.
  const trays = doc.createElement('button');
  trays.className = 'test-tray-chip';
  trays.setAttribute('aria-controls', 'cs-tray');
  trays.setAttribute('aria-expanded', 'true');
  trays.textContent = '2 shells';
  $('cs-chips').append(trays);
  await update(live('idle'));
  tickAt();
  assert.deepEqual([...$('cs-chips').children], [trays], '#cs-chips is the trays\' to fill');
  assert.equal(trays.getAttribute('aria-expanded'), 'true', 'a frame and a tick leave the tray chip\'s aria-expanded alone');
  shell.press(step());
  assert.equal(trays.getAttribute('aria-expanded'), 'true', 'and so does a click on the step');

  trays.remove();
  release();
  released = true;
  release();   // a second call does nothing
  await shell.tick();
  tickAt();
  assert.equal($('cs-chips').childNodes.length, 0, 'released, the bar puts nothing back: #cs-chips stays empty');
  assert.deepEqual(devChips(), []);
});

test('once the trays own #cs-tray and #cs-chips, the bar builds no second tray and never writes a tray chip\'s state', async (t) => {
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(2) } })));
  fakeView(t);
  // The trays' own tray, static in its host (spec §7.6).
  const tray = doc.createElement('div');
  tray.id = 'cs-tray';
  tray.className = 'popover cs-tray';   // open
  $('stage').append(tray);
  const release = bar.claimChips();
  const trayChip = doc.createElement('button');
  trayChip.type = 'button';
  trayChip.className = 'cs-chip';
  trayChip.dataset.csCat = 'shells';
  trayChip.setAttribute('aria-controls', 'cs-tray');
  trayChip.setAttribute('aria-expanded', 'true');
  trayChip.textContent = '2 shells';
  $('cs-chips').append(trayChip);
  t.after(() => {
    trayChip.remove();
    tray.remove();
    release();
  });

  await update(live('working', { step: { kind: 'Bash', label: 'Bash · npm test', started_at: T - sec(1) } }));
  assert.equal(text(), 'Bash · npm test', 'precondition: the frame redrew the bar');
  assert.equal(step().getAttribute('aria-controls'), 'chat-dock', 'precondition: the step is the chat\'s, no stand-in');
  assert.equal(trayChip.getAttribute('aria-expanded'), 'true', 'a frame leaves the tray chip saying its tray is open');
  tickAt(sec(1));
  assert.equal(meta(), '0:02', 'precondition: the tick redrew the running clock');
  assert.equal(trayChip.getAttribute('aria-expanded'), 'true', 'and so does every tick');
  assert.equal(doc.querySelectorAll('[id="cs-tray"]').length, 1, 'one #cs-tray, the trays\': the bar builds no second');
  assert.equal(devNote(), null, 'and no note');
});

/* ── fallback (c): the act area, with no answer frame ──────────────────────── */

test('with no answer frame, a waiting question, permission, plan or MCP form reads "Answer in the terminal" and no hint', async () => {
  const elicit = { id: 'ask-e1', conversation_id: 'c1', kind: 'elicitation', tool_name: 'github', tool_kind: 'elicitation',
    state: 'pending', answerable: true, created_at: T - sec(1), version: 1, source: 'ask' };
  const kinds = [
    ['question', one(live('question', { waiting: { kind: 'question', summary: 'Which width?', ask_id: 'ask-q1' } }))],
    ['permission', one(live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm run build)', ask_id: 'ask-p1' } }))],
    ['plan', one(live('waiting', { waiting: { kind: 'plan', ask_id: 'ask-plan1' } }))],
    ['an MCP form', { ...one(live('working')), asks: [elicit] }],
  ];
  assert.equal(slots.approvals(), null, 'precondition: no answer frames');
  assert.equal(slots.chatViews().length, 0, 'precondition: no chat view, so no Answer › or Review ›');
  for (const [kind, over] of kinds) {
    await show(over);
    assert.equal(act().querySelector('.cs-act-note').textContent, 'Answer in the terminal', `${kind}: the note`);
    assert.equal(act().textContent, 'Answer in the terminal', `${kind}: and nothing else, no hint`);
    assert.equal(act().querySelector('.cs-act-hint'), null, `${kind}: no hint element`);
    assert.equal(act().querySelector('button'), null, `${kind}: no button, with no chat to open`);
  }
  assert.equal(text(), 'MCP input · github', 'the step names the MCP form as the phone tab does');
  await show(one(live('working')));
  assert.equal(act().childNodes.length, 0, 'nothing waits: the act area is empty');
});

test('the act area\'s note shows at every width the bar is drawn at, and no rule styles a hint', () => {
  // jsdom lays nothing out, so this reads the cascade. The act area draws no
  // box, so what it holds are flex items of the bar's own row, never shrunk:
  assert.equal(decl(rulesFor('.cs-act').find((r) => !r.media).body, 'display'), 'contents');
  assert.equal(decl(rulesFor('.cs-act > *').find((r) => !r.media).body, 'flex'), 'none');
  // No rule, at any width, hides the note: only the bar's own display:none
  // below 760px does (the test below).
  const words = rulesWhere((sels) => sels.some((x) => /\.cs-act-note(?![\w-])/.test(x)));
  assert.ok(words.length >= 1, 'the note\'s rule was found');
  for (const r of words) {
    const where = `${r.selectors.join(', ')}${r.media ? ` in ${r.media}` : ''}`;
    assert.notEqual(decl(r.body, 'display'), 'none', `${where}: never display: none`);
    assert.equal(decl(r.body, 'visibility'), null, `${where}: never hidden`);
    assert.equal(decl(r.body, 'max-width'), null, `${where}: never capped`);
    assert.equal(decl(r.body, 'overflow'), null, `${where}: never clipped`);
  }
  assert.deepEqual(rulesWhere((sels) => sels.some((x) => /\.cs-act-hint/.test(x))), [], 'the hint is gone, and its rules');
});

test('once an answer frame registers, the terminal note goes and the frame mounts', async (t) => {
  await show(one(live('suspended')));
  restartBar();
  await show({
    conversations: [conversation('c1', live('waiting', {
      waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist)', ask_id: 'ask-ok' },
    }))],
    asks: [{ id: 'ask-ok', conversation_id: 'c1', kind: 'permission', tool_name: 'Bash', state: 'pending',
      answerable: true, created_at: T - sec(1) }],
  });
  assert.ok(act().querySelector('.cs-act-note'), 'precondition: the terminal note is up');
  assert.equal(text(), 'Permission · Bash(rm -rf dist)', 'and the step shows the whole request');

  const calls = fakeApprovals(t);
  tickAt();   // no event says a provider registered: the next tick sees the seam move
  assert.equal(act().querySelector('.cs-act-note'), null, 'the note went by itself');
  assert.equal(act().querySelector('.cs-act-hint'), null);
  assert.equal(calls.mountBar.length, 1, 'the frame mounted');
  assert.equal(calls.mountBar[0].el, act(), 'into #cs-act');
  assert.equal(calls.mountBar[0].ask.id, 'ask-ok');
  assert.ok(act().querySelector('.test-frame'), '#cs-act holds it');
  assert.equal(text(), 'Permission · Bash', 'beside a frame the step names the tool alone (§4.5)');
});

/* ── the act area ──────────────────────────────────────────────────────────── */

test('Answer › and Review › open the chat on the wait: chat:open {view: \'awaiting\', id}', async (t) => {
  fakeView(t);
  const seen = opens(t);
  await show(one(live('question', { waiting: { kind: 'question', summary: 'Which width?', ask_id: 'ask-a' } })));
  const answer = act().querySelector('button.cs-answer');
  assert.ok(answer, 'a question: Answer ›');
  assert.equal(answer.textContent, 'Answer ›');
  assert.ok(act().querySelector('.cs-act-note'), 'beside the terminal note, until answering lands');
  shell.press(answer);
  assert.deepEqual(seen, [{ view: 'awaiting', id: 'ask-a', covered: false }]);

  await show(one(live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(make)', ask_id: 'ask-b' } })));
  const review = act().querySelector('button.cs-review');
  assert.ok(review, 'a permission with no frame: Review ›');
  assert.equal(review.textContent, 'Review ›');
  review.focus();
  await shell.frame({ type: 'mirror:status', rev: ++rev, now: T, aggregate: { state: 'waiting' }, conversations: [] });
  tickAt(sec(1));
  assert.equal(doc.activeElement, review, 'a focused Review › survives a redraw: it is never rebuilt for nothing');
  assert.ok(review.isConnected);
  t.after(() => { if (gv.isOverlayOpen()) gv.closeOverlay(); });
  await gv.openOverlay();
  shell.press(review);
  assert.ok(!gv.isOverlayOpen(), 'the graph goes first');
  assert.deepEqual(seen[1], { view: 'awaiting', id: 'ask-b', covered: false });

  await show(one(live('waiting', { waiting: { kind: 'plan', ask_id: 'ask-c' } })));
  assert.ok(act().querySelector('button.cs-review'), 'a plan is reviewed in the chat, never answered in the bar');
});

test('approve: the answer frame mounts once per ask, and goes when the wait does', async (t) => {
  const calls = fakeApprovals(t);
  fakeView(t);
  const ask = (id, extra = {}) => ({ id, conversation_id: 'c1', kind: 'permission', tool_name: 'Edit', state: 'pending',
    answerable: true, created_at: T - sec(1), ...extra });
  const waiting = (id) => conversation('c1', live('waiting', { waiting: { kind: 'permission', tool: 'Edit',
    summary: 'Edit(app.css)', ask_id: id } }));
  await show({ conversations: [waiting('ask-m')], asks: [ask('ask-m')] });
  assert.equal(calls.mountBar.length, 1);
  assert.equal(text(), 'Permission · Edit');
  assert.equal(act().querySelector('button'), null, 'the frame is the act area: no Review › beside it');
  tickAt(sec(1));
  tickAt(sec(2));
  await shell.frame({ type: 'mirror:status', rev: ++rev, now: T, aggregate: { state: 'waiting' }, conversations: [] });
  assert.equal(calls.mountBar.length, 1, 'not mounted again by a tick or a frame');

  await show(one(live('working')));
  // The bar's own unmounts: since main.js inits the chat panel, its awaiting
  // card asks the provider too (mountCard, refused by this fake, then
  // unmount of the card's own body), which is not the bar's to count.
  assert.deepEqual(calls.unmount.filter((el) => el === act() || $('chat-statusbar').contains(el)), [act()],
    'unmounted from #cs-act when the wait ended');
  assert.equal(act().childNodes.length, 0);

  // A wait this viewer may not answer is no frame's: the wording for no frame.
  await show({ conversations: [waiting('ask-n')], asks: [ask('ask-n', { answerable: false })] });
  assert.equal(calls.mountBar.length, 1, 'an unanswerable ask is never offered to the frame');
  assert.equal(text(), 'Permission · Edit(app.css)');
  assert.ok(act().querySelector('button.cs-review'));
});

test('approve: a provider that refuses an ask leaves Review ›, and is not asked again on every tick', async (t) => {
  const calls = fakeApprovals(t, { mount: false });
  fakeView(t);
  await show({
    conversations: [conversation('c1', live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(ls)', ask_id: 'ask-r' } }))],
    asks: [{ id: 'ask-r', conversation_id: 'c1', kind: 'permission', tool_name: 'Bash', state: 'pending', answerable: true }],
  });
  assert.equal(calls.mountBar.length, 1, 'asked once');
  assert.equal(text(), 'Permission · Bash(ls)', 'no frame: the whole request on the step');
  assert.ok(act().querySelector('button.cs-review'), 'and Review ›');
  for (let i = 1; i <= 3; i++) {
    await shell.frame({ type: 'mirror:status', rev: ++rev, now: T, aggregate: { state: 'waiting' }, conversations: [] });
    tickAt(sec(i));
  }
  assert.equal(calls.mountBar.length, 1, 'and not asked again by every redraw');
  assert.equal(text(), 'Permission · Bash(ls)');

  // A changed ask (its version) is asked about again.
  await show({
    conversations: [conversation('c1', live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(ls)', ask_id: 'ask-r' } }))],
    asks: [{ id: 'ask-r', conversation_id: 'c1', kind: 'permission', tool_name: 'Bash', state: 'pending', answerable: true,
      version: 2 }],
  });
  assert.equal(calls.mountBar.length, 2, 'a new version of the ask is offered again');
});

/* ── another conversation ──────────────────────────────────────────────────── */

test('another conversation waiting gets a chip before the divider, and a click follows it', async (t) => {
  t.after(() => S.followConversation(null));
  await show({
    conversations: [
      conversation('c1', live('working', { step: { kind: 'Edit', label: 'Edit · app.css', started_at: T - sec(2) } })),
      conversation('c2', live('waiting', { waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm publish)' } }),
        { title: 'Release prep' }),
    ],
  });
  const other = $('chat-statusbar').querySelector('.cs-other');
  assert.ok(other, 'the chip is up');
  assert.equal(other.textContent, 'other session · needs you');
  assert.equal(other.nextElementSibling, $('chat-statusbar').querySelector('.cs-div'), 'right before the divider');
  assert.equal(other.getAttribute('data-cs-state'), 'waiting', 'in that conversation\'s own ink');
  assert.match(other.title, /Release prep/);
  assert.equal(text(), 'Edit · app.css', 'the step still follows c1');

  shell.press(other);
  await shell.tick();
  assert.equal(S.followed(), 'c2', 'the click follows the other conversation');
  assert.equal(text(), 'Permission · Bash(npm publish)', 'and the bar says what it waits for');
  assert.equal($('chat-statusbar').querySelector('.cs-other'), null, 'c1 does not wait on the user: no chip now');
});

/* ── collisions ────────────────────────────────────────────────────────────── */

test('#chat-statusbar is in shell.js LAYERS: no modal ever makes it inert', async (t) => {
  const layers = /const LAYERS = '([^']*)'/.exec(read('public/app/shell.js'));
  assert.ok(layers && layers[1].split(',').map((s) => s.trim()).includes('#chat-statusbar'), 'LAYERS names the bar');
  t.after(() => { if (gv.isOverlayOpen()) gv.closeOverlay(); });
  await gv.openOverlay();
  await shell.tick();
  assert.ok(doc.querySelector('.body-wrap').hasAttribute('inert'), 'precondition: the page behind the graph is inert');
  assert.equal($('chat-statusbar').hasAttribute('inert'), false, 'the bar beside the graph is not');
  gv.closeOverlay();
  await shell.tick();
  shell.key('k', { metaKey: true });
  await shell.tick();
  assert.ok(!$('cmd-palette').classList.contains('hidden'), 'precondition: ⌘K opened the palette');
  assert.equal($('chat-statusbar').hasAttribute('inert'), false, 'nor under the palette');
  shell.key('Escape', { target: $('cmd-input') });
  await shell.tick();
});

test('the graph overlay is inset by --cs-bar-h and the service-trust cards clear the bar', () => {
  const overlay = rulesFor('#overlay.overlay').filter((r) => !r.media);
  assert.equal(overlay.length, 1);
  assert.equal(decl(overlay[0].body, 'inset'), '0 0 var(--cs-bar-h) 0', 'the bar stays visible under the graph');
  const trust = rulesFor('.svc-trust-host').filter((r) => !r.media);
  assert.equal(decl(trust[0].body, 'bottom'), 'calc(18px + var(--cs-bar-h))', 'the cards sit above the bar');
  assert.match(decl(trust[0].body, 'max-height'), /var\(--cs-bar-h\)/, 'and are no taller than the room it leaves');
  assert.equal(decl(rulesFor('#chat-statusbar').find((r) => !r.media).body, 'height'), 'var(--cs-bar-h)',
    'the bar\'s own height is the same one property');
});

test('below 760px the bar is hidden by app.css alone', () => {
  const rules = rulesFor('#chat-statusbar');
  const wide = rules.filter((r) => !r.media);
  assert.ok(wide.length, 'styled at the top level');
  assert.equal(decl(wide[0].body, 'display'), 'flex');
  const hiding = rules.filter((r) => decl(r.body, 'display') === 'none');
  assert.deepEqual(hiding.map((r) => r.media), ['@media (max-width: 759px)'], 'hidden at the one narrow breakpoint, and only there');
  assert.deepEqual(rulesWhere((sels) => sels.some((x) => /\.cs-dev(?![\w])/.test(x))), [],
    'and no rule styles a note of the bar\'s: it has none');
  assert.doesNotMatch(codeOf('public/app/chat-bar.js'), /matchMedia|innerWidth|clientWidth|isPhone|isNarrow|viewport/,
    'chat-bar.js never asks the width');
});

/* ── stopping ──────────────────────────────────────────────────────────────── */

test('stopBar() stops the ticker and the listeners; initChatBar() starts them again, once', async () => {
  await show(one(live('working', { step: { kind: 'Edit', label: 'Edit · paths.js', started_at: T - sec(10) } })));
  assert.equal(meta(), '0:10');
  const stopped = barTicker;
  bar.stopBar();
  assert.ok(!shell.intervals().some((i) => i.id === stopped.id), 'the interval is cleared');
  tickAt(sec(30), stopped.fn);
  assert.equal(meta(), '0:10', 'a late tick draws nothing');
  await update(live('working', { step: { kind: 'Bash', label: 'Bash · make', started_at: T - sec(1) } }));
  assert.equal(text(), 'Edit · paths.js', 'and a frame no longer reaches the bar');

  const known = new Set(shell.intervals().map((i) => i.id));
  bar.initChatBar();
  bar.initChatBar();
  const fresh = shell.intervals().filter((i) => !known.has(i.id));
  assert.equal(fresh.length, 1, 'one new ticker, however often it is started');
  [barTicker] = fresh;
  assert.equal(text(), 'Bash · make', 'started again, it draws the store as it is now');
  assert.equal(meta(), '0:01');
});

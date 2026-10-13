// The phone chrome's pure model (public/app/sheet-model.js), in plain node:
// every rule of §8.2–§8.6 and §8.9 that carries a number, because jsdom cannot
// lay out (§10.1).
//
// What is pinned: the constants by name; the stops (the spec's own figures,
// 644 → 622/341, 442 → 420/234, 242 → one stop) and the drop of half exactly
// at a 96 px gap; the snap (the 40 px push, the nearer stop past a midpoint),
// the arrow steps, the tap and axis rules, docking by thirds; the tab's six
// states with §8.3's words, widths and labels, collapsed over every live,
// non-headless conversation (notes-A D2) through chat-present's uiState; what
// #chat-live says; the badge on the tab's inner side and merged at the centre
// (N2); the Tasks root from categories()'s phone lines over the Final's fixture
// (test-support/final-fixture.js), with the one running count (deviation 19);
// the keyboard's inset and frame; and that the module is DOM-free, timer-free
// and clock-free, importing only chat-present.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { finalFixture, storeOf, queueOf, NOW } = require('../test-support/final-fixture');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'public/app');
const appUrl = (rel) => pathToFileURL(path.join(APP, rel)).href;

let M;   // sheet-model.js
let P;   // chat-present.js
let S;   // chat-state.js (storeOf builds the store through its normalizers)
test.before(async () => {
  M = await import(appUrl('sheet-model.js'));
  P = await import(appUrl('chat-present.js'));
  S = await import(appUrl('chat-state.js'));
});

const sec = (n) => n * 1000;
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

// A GET /api/mirror body at `local` holding these conversations (c1 the primary).
function body(conversations, { tasks = [], primary = 'c1' } = {}) {
  return { v: 1, enabled: true, now: NOW, rev: 1, content: true, access: { level: 'local', remote: false },
    capabilities: { task_stop: true, queue_message: true, interrupt: true }, primary, aggregate: { state: 'working' },
    conversations, tasks, asks: [] };
}
const conv = (id, live, extra = {}) => ({ id, rev: 1, title: `title of ${id}`, headless: false, counts: ZERO,
  live: { rev: 1, since: NOW - min(1), last_activity_at: NOW - sec(2), ...live }, ...extra });
const storeWith = (lives, opts = {}) => storeOf(body(lives.map(([id, live, extra]) => conv(id, live, extra))), S, opts);
const look = (m) => M.tabLook(m, { now: NOW });

// ── the module ───────────────────────────────────────────────────────────────

test('the sheet model is DOM-free, timer-free and clock-free, and imports only chat-present.js', () => {
  const src = fs.readFileSync(path.join(APP, 'sheet-model.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./chat-present.js']);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code,
    /\bdocument\b|\bwindow\b|\blocalStorage\b|\bsessionStorage\b|\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b/);
  assert.doesNotMatch(code, /\bDate\.now\b|\bperformance\b|\bnew Date\b/, 'no clock: `now` is always passed in');
});

test('every number is an exported constant', () => {
  assert.equal(M.TAB_H, 23);
  assert.equal(M.TOP_GAP, 22);
  assert.equal(M.HALF_FRAC, 0.53);
  assert.equal(M.HALF_MIN, 220);
  assert.equal(M.HALF_MAX, 420);
  assert.equal(M.HALF_GAP_MIN, 96);
  assert.equal(M.TAP_SLOP, 6);
  assert.equal(M.SNAP_PUSH, 40);
  assert.equal(M.ASK_HALF_MIN, 320);
  assert.equal(M.TAB_W, 56);
  assert.equal(M.TAB_W_ALERT, 124);
  assert.equal(M.BADGE_GAP, 4);
  assert.equal(M.KB_MIN, 80);
  assert.equal(M.KB_INSET, 8);
  assert.equal(M.LABEL_MAX, 160);
  assert.deepEqual([...M.DOCKS], ['left', 'center', 'right'], "'center' is the stored and attribute spelling (notes-A D4)");
  assert.ok(Object.isFrozen(M.DOCKS));
  assert.equal(M.DOCK_DEFAULT, 'right');
});

// ── stops ────────────────────────────────────────────────────────────────────

test('computeStops: the spec\'s own figures', () => {
  assert.deepEqual({ ...M.computeStops(644) }, { avail: 644, full: 622, half: 341 }, 'the mockup\'s frame');
  assert.deepEqual({ ...M.computeStops(442) }, { avail: 442, full: 420, half: 234 }, 'an iPhone SE in Safari');
  assert.deepEqual({ ...M.computeStops(242) }, { avail: 242, full: 220, half: null }, 'a landscape phone: one stop');
  assert.deepEqual({ ...M.computeStops(0) }, { avail: 0, full: 0, half: null });
  assert.deepEqual({ ...M.computeStops(-50) }, { avail: 0, full: 0, half: null });
  assert.deepEqual({ ...M.computeStops(NaN) }, { avail: 0, full: 0, half: null });
  assert.equal(M.computeStops(2000).half, 420, 'half is held at 420');
  assert.equal(M.computeStops(1000).full, 978);
});

test('computeStops: half is dropped exactly when full − half < 96', () => {
  // avail 338: full 316, half clamp(179) = 220, a gap of exactly 96 — kept.
  assert.deepEqual({ ...M.computeStops(338) }, { avail: 338, full: 316, half: 220 });
  // avail 337: full 315, half 220, a gap of 95 — dropped.
  assert.equal(M.computeStops(337).half, null);
  for (let a = 200; a <= 1200; a += 1) {
    const s = M.computeStops(a);
    const raw = Math.min(420, Math.max(220, Math.round(a * 0.53)));
    assert.equal(s.half === null, s.full - raw < 96 || s.full < 220, `avail ${a}`);
  }
});

const S644 = () => M.computeStops(644);   // [0, 341, 622]
const S242 = () => M.computeStops(242);   // [0, 220]

test('stopList, stopName and nearest', () => {
  assert.deepEqual(M.stopList(S644()), [0, 341, 622]);
  assert.deepEqual(M.stopList(S242()), [0, 220]);
  assert.deepEqual(M.stopList(M.computeStops(0)), [0]);
  assert.equal(M.stopName(0, S644()), 'closed');
  assert.equal(M.stopName(341, S644()), 'half');
  assert.equal(M.stopName(622, S644()), 'full');
  assert.equal(M.stopName(200, S644()), 'between', 'off every stop');
  assert.equal(M.stopName(340, S644()), 'between');
  assert.equal(M.stopName(220, S242()), 'full');
  assert.equal(M.nearest(100, S644()), 0);
  assert.equal(M.nearest(200, S644()), 341);
  assert.equal(M.nearest(500, S644()), 622);
  assert.equal(M.nearest(-30, S644()), 0);
  assert.equal(M.nearest(900, S644()), 622);
  assert.equal(M.nearest(100, S242()), 0);
  assert.equal(M.nearest(120, S242()), 220);
});

test('snapTarget: the 40 px push, else the nearest stop', () => {
  assert.equal(M.snapTarget({ from: 0, h: 45, stops: S644() }), 341, '45 px up from closed opens half');
  assert.equal(M.snapTarget({ from: 0, h: 45, stops: S242() }), 220, 'with no half: full');
  assert.equal(M.snapTarget({ from: 622, h: 580, stops: S644() }), 341, '42 px down from full drops to half');
  assert.equal(M.snapTarget({ from: 341, h: 371, stops: S644() }), 341, '30 px up from half stays');
  assert.equal(M.snapTarget({ from: 341, h: 311, stops: S644() }), 341, '30 px down from half stays');
  assert.equal(M.snapTarget({ from: 0, h: 40, stops: S644() }), 0, 'exactly 40 px is not more than 40');
  assert.equal(M.snapTarget({ from: 341, h: 382, stops: S644() }), 622, '41 px up from half opens full');
  assert.equal(M.snapTarget({ from: 341, h: 290, stops: S644() }), 0, '51 px down from half closes');
  // Past the midpoint between two stops the nearer one wins, even far past the push.
  assert.equal(M.snapTarget({ from: 0, h: 560, stops: S644() }), 622, 'a long drag past half\'s midpoint to full');
  assert.equal(M.snapTarget({ from: 622, h: 120, stops: S644() }), 0, 'a long drag down past half\'s lower midpoint');
  assert.equal(M.snapTarget({ from: 0, h: 480, stops: S644() }), 341, 'short of the half/full midpoint (481.5): half');
  assert.equal(M.snapTarget({ from: 0, h: 482, stops: S644() }), 622);
  assert.equal(M.snapTarget({ h: 200, stops: S644() }), 341, 'no start: the nearest stop');
});

test('stepStop: up and down through [0, half, full], held at both ends', () => {
  const s = S644();
  assert.equal(M.stepStop(0, +1, s), 341);
  assert.equal(M.stepStop(341, +1, s), 622);
  assert.equal(M.stepStop(622, +1, s), 622, 'held at full');
  assert.equal(M.stepStop(622, -1, s), 341);
  assert.equal(M.stepStop(341, -1, s), 0);
  assert.equal(M.stepStop(0, -1, s), 0, 'held at closed');
  assert.equal(M.stepStop(200, +1, s), 341, 'from between: the next stop up');
  assert.equal(M.stepStop(200, -1, s), 0);
  const one = S242();
  assert.equal(M.stepStop(0, +1, one), 220, 'with no half: 0 ↔ full');
  assert.equal(M.stepStop(220, -1, one), 0);
  assert.equal(M.stepStop(220, +1, one), 220);
});

test('dragHeight: the start moved by the pointer, held to [0, full]', () => {
  const s = S644();
  assert.equal(M.dragHeight({ start: 0, dy: -100, stops: s }), 100, 'a drag up grows the sheet');
  assert.equal(M.dragHeight({ start: 341, dy: 41, stops: s }), 300);
  assert.equal(M.dragHeight({ start: 341, dy: -400, stops: s }), 622, 'held at full');
  assert.equal(M.dragHeight({ start: 100, dy: 300, stops: s }), 0, 'held at closed');
});

test('openStopFor and atLeastHalf', () => {
  assert.equal(M.openStopFor(S644()), 341, 'half normally');
  assert.equal(M.openStopFor(S242()), 220, 'the only stop when there is no half');
  assert.equal(M.openStopFor(S644(), { askPending: true }), 341, 'an ask with half ≥ 320 still opens half');
  assert.equal(M.openStopFor(M.computeStops(442), { askPending: true }), 420, 'half 234 is under 320: full');
  assert.equal(M.openStopFor(S242(), { askPending: true }), 220, 'no half: full');
  assert.equal(M.openStopFor(M.computeStops(604), { askPending: true }), 320, 'half exactly 320 holds the card');
  assert.equal(M.openStopFor(M.computeStops(602), { askPending: true }), 580, 'half 319: full');

  assert.equal(M.atLeastHalf(0, S644()), 341);
  assert.equal(M.atLeastHalf(200, S644()), 341);
  assert.equal(M.atLeastHalf(622, S644()), 622, 'never lowers an open stop');
  assert.equal(M.atLeastHalf(500, S644()), 500);
  assert.equal(M.atLeastHalf(0, S242()), 220, 'no half: full');
});

test('scrimFrac: h / full within [0, 1]', () => {
  assert.equal(M.scrimFrac(0, 622), 0);
  assert.equal(M.scrimFrac(311, 622), 0.5);
  assert.equal(M.scrimFrac(622, 622), 1);
  assert.equal(M.scrimFrac(700, 622), 1);
  assert.equal(M.scrimFrac(-10, 622), 0);
  assert.equal(M.scrimFrac(100, 0), 0, 'no room at all');
  assert.equal(M.scrimFrac(NaN, 622), 0);
});

// ── gestures and docking ─────────────────────────────────────────────────────

test('isTap: within 6 px on BOTH axes', () => {
  assert.equal(M.isTap(6, 6), true);
  assert.equal(M.isTap(-6, -6), true);
  assert.equal(M.isTap(0, 0), true);
  assert.equal(M.isTap(7, 0), false, 'a sideways swipe is not a tap (the mockup counted only dy)');
  assert.equal(M.isTap(0, 7), false);
  assert.equal(M.isTap(0, -7), false);
});

test('classify: the axis rule', () => {
  assert.equal(M.classify({ dx: 3, dy: 7 }), 'y');
  assert.equal(M.classify({ dx: 7, dy: -7 }), 'y', '|dy| ≥ |dx| decides for y');
  assert.equal(M.classify({ dx: 3, dy: 6 }), null, 'not past the slop yet');
  assert.equal(M.classify({ dx: 20, dy: 7 }), null, 'past the slop vertically, but more sideways: not y');
  assert.equal(M.classify({ dx: 20, dy: 7, dockable: true, closed: true }), 'x', 'and x when it may dock');
  assert.equal(M.classify({ dx: 13, dy: 6, dockable: true, closed: true }), 'x');
  assert.equal(M.classify({ dx: -13, dy: 6, dockable: true, closed: true }), 'x');
  assert.equal(M.classify({ dx: 13, dy: 6, closed: true }), null, 'no dock handler: never x');
  assert.equal(M.classify({ dx: 13, dy: 6, dockable: true, closed: false }), null, 'an open sheet: never x');
  assert.equal(M.classify({ dx: 40, dy: 0, dockable: true, closed: false }), null);
  assert.equal(M.classify({ dx: 10, dy: 6, dockable: true, closed: true }), null, 'not more than 2·|dy|');
  assert.equal(M.classify({ dx: 12, dy: 6, dockable: true, closed: true }), null, 'exactly 2·|dy| is not more');
});

test('normalizeDock and dockFor (by thirds)', () => {
  for (const v of ['diagonal', null, '', undefined, 'centre', 'Center', 7]) assert.equal(M.normalizeDock(v), 'right', String(v));
  for (const v of ['left', 'center', 'right']) assert.equal(M.normalizeDock(v), v);
  const w = 390;
  assert.equal(M.dockFor(0, w), 'left');
  assert.equal(M.dockFor(w / 3 - 1, w), 'left');
  assert.equal(M.dockFor(w / 3, w), 'center');
  assert.equal(M.dockFor((2 * w) / 3 - 1, w), 'center');
  assert.equal(M.dockFor((2 * w) / 3, w), 'right');
  assert.equal(M.dockFor(w, w), 'right');
  assert.equal(M.dockFor(10, 0), 'right', 'no width: the default');
  assert.equal(M.dockFor(NaN, w), 'right');
});

// ── the tab ──────────────────────────────────────────────────────────────────

const TAB_STATES = [
  ['working', () => storeOf(finalFixture().mirrorBody, S),
    { state: 'working', quiet: false, alert: false, word: '', width: 56, label: 'Claude is working — Edit · QueueRail.tsx' }],
  ['question', () => storeWith([['c1', { state: 'question', waiting: { kind: 'question', summary: 'Keep the 56px rail?' } }]]),
    { state: 'question', quiet: false, alert: true, word: 'QUESTION', width: 124, label: 'Claude has a question — open the chat' }],
  ['waiting: a permission', () => storeWith([['c1', { state: 'waiting',
    waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist && npm run build)' } }]]),
  { state: 'waiting', quiet: false, alert: true, word: 'NEEDS YOU', width: 124, label: 'Claude needs you: permission prompt' }],
  ['waiting: a plan', () => storeWith([['c1', { state: 'waiting', waiting: { kind: 'plan' } }]]),
    { state: 'waiting', alert: true, word: 'NEEDS YOU', width: 124, label: 'Claude needs you: plan approval' }],
  ['waiting: another wait', () => storeWith([['c1', { state: 'waiting', waiting: { kind: 'other', summary: 'pick a file' } }]]),
    { state: 'waiting', alert: true, word: 'NEEDS YOU', width: 124, label: 'Claude needs you — answer in the terminal' }],
  ['idle', () => storeWith([['c1', { state: 'idle' }]]),
    { state: 'idle', quiet: false, alert: false, word: '', width: 56, label: 'Chat with Claude — idle' }],
  ['offline', () => storeOf(finalFixture().mirrorBody, S, { conn: 'reconnecting' }),
    { state: 'offline', quiet: false, alert: false, word: '', width: 56, label: 'Chat with Claude — reconnecting' }],
  ['offline, before the first connection', () => storeOf(finalFixture().mirrorBody, S, { conn: 'connecting' }),
    { state: 'offline', width: 56, label: 'Chat with Claude — connecting' }],
  ['suspended', () => storeWith([['c1', { state: 'suspended' }]]),
    { state: 'suspended', quiet: false, alert: false, word: '', width: 56, label: 'Claude is suspended — resume it in the terminal' }],
];

for (const [name, make, want] of TAB_STATES) {
  test(`tabLook: ${name}`, () => {
    const got = look(make());
    assert.ok(Object.isFrozen(got));
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${name}: ${k}`);
  });
}

test('tabLook: suspended is never offline, and the followed conversation is named', () => {
  const t = look(storeWith([['c1', { state: 'suspended' }]]));
  assert.equal(t.state, 'suspended');
  assert.doesNotMatch(t.label, /offline|reconnect/i);
  assert.equal(t.conversationId, 'c1');
});

test('tabLook: quiet working is working, still', () => {
  const t = look(storeWith([['c1', { state: 'working', quiet: { since: NOW - min(4), reason: 'no-activity' },
    step: { kind: 'Bash', label: 'Bash · npm test', started_at: NOW - min(5) } }]]));
  assert.equal(t.state, 'working');
  assert.equal(t.quiet, true);
  assert.equal(t.width, 56);
  assert.equal(t.label, 'Claude is working, quiet — check the terminal', 'no clock in a label nothing redraws');
});

test('tabLook: the step in the label — no tool known, below read, and cut to 160 characters', () => {
  assert.equal(look(storeWith([['c1', { state: 'working', step: null, turn_started_at: NOW - sec(12) }]])).label,
    'Claude is working');
  const basic = storeOf({ ...body([]), content: false, access: { level: 'basic', remote: true },
    conversations: [{ id: 'c1', state: 'working', since: NOW - min(1), step_kind: 'Edit', counts: ZERO }] }, S);
  assert.equal(P.uiState(basic, { now: NOW }).head, 'Working · Edit', 'uiState\'s basic head …');
  assert.equal(look(basic).label, 'Claude is working — Edit', '… without its leading "Working · "');
  const long = 'x'.repeat(400);
  const t = look(storeWith([['c1', { state: 'working', step: { kind: 'Bash', label: long, started_at: NOW - sec(3) } }]]));
  const step = t.label.replace('Claude is working — ', '');
  assert.equal(Array.from(step).length, 160);
  assert.ok(step.endsWith('…'));
});

test('tabLook: the socket down makes every conversation offline, whatever they say', () => {
  const m = storeWith([['c1', { state: 'idle' }], ['c2', { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash' } }]],
    { conn: 'reconnecting' });
  const t = look(m);
  assert.equal(t.state, 'offline');
  assert.equal(t.label, 'Chat with Claude — reconnecting');
  assert.equal(t.conversationId, 'c1', 'the followed conversation keeps a tie');
});

test('tabLook: another session waiting outranks a followed idle one, "in another session"', () => {
  const t = look(storeWith([['c1', { state: 'idle' }],
    ['c2', { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(ls)' } }]]));
  assert.equal(t.state, 'waiting');
  assert.equal(t.word, 'NEEDS YOU');
  assert.equal(t.label, 'Claude needs you in another session: permission prompt');
  assert.equal(t.conversationId, 'c2');
  const q = look(storeWith([['c1', { state: 'working', step: { kind: 'Edit', label: 'Edit · a.js' } }],
    ['c2', { state: 'question', waiting: { kind: 'question', summary: 'which?' } }]]));
  assert.equal(q.label, 'Claude has a question in another session — open the chat');
  const other = look(storeWith([['c1', { state: 'idle' }], ['c2', { state: 'waiting', waiting: { kind: 'other' } }]]));
  assert.equal(other.label, 'Claude needs you in another session — answer in the terminal');
});

test('tabLook: another conversation working while the followed one is idle reads working (D2)', () => {
  const t = look(storeWith([['c1', { state: 'idle' }], ['c2', { state: 'working', step: { kind: 'Edit', label: 'Edit · b.js' } }]]));
  assert.equal(t.state, 'working');
  assert.equal(t.label, 'Claude is working — Edit · b.js');
  assert.equal(t.conversationId, 'c2');
});

test('tabLook: the followed conversation keeps the tab on a tie, and a headless one never takes it', () => {
  const tie = look(storeWith([['c1', { state: 'waiting', waiting: { kind: 'plan' } }],
    ['c2', { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash' } }]]));
  assert.equal(tie.conversationId, 'c1');
  assert.equal(tie.label, 'Claude needs you: plan approval');
  const headless = look(storeWith([['c1', { state: 'idle' }],
    ['c9', { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash' } }, { headless: true }]]));
  assert.equal(headless.state, 'idle', 'a `claude -p` job does not raise the tab');
});

test('tabLook: below read the status rows are the candidates', () => {
  const m = storeOf({ ...body([]), content: false, access: { level: 'basic', remote: true },
    conversations: [{ id: 'c1', state: 'idle', counts: ZERO }, { id: 'c2', state: 'question', waiting_kind: 'question', counts: ZERO }] },
  S);
  const t = look(m);
  assert.equal(t.state, 'question');
  assert.equal(t.label, 'Claude has a question in another session — open the chat');
  assert.equal(t.conversationId, 'c2');
});

test('tabLook: no conversation at all reads idle', () => {
  const t = look(storeOf(body([], { primary: null }), S));
  assert.equal(t.state, 'idle');
  assert.equal(t.label, 'Chat with Claude — idle');
  assert.equal(t.conversationId, null);
});

test('tabAnnounce: only a move INTO waiting, question or offline speaks', () => {
  const idle = look(storeWith([['c1', { state: 'idle' }]]));
  const waiting = look(storeWith([['c1', { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash' } }]]));
  const working = look(storeOf(finalFixture().mirrorBody, S));
  const question = look(storeWith([['c1', { state: 'question', waiting: { kind: 'question' } }]]));
  const offline = look(storeOf(finalFixture().mirrorBody, S, { conn: 'reconnecting' }));
  const suspended = look(storeWith([['c1', { state: 'suspended' }]]));
  assert.equal(M.tabAnnounce(idle, waiting), 'Claude needs you: permission prompt');
  assert.equal(M.tabAnnounce(working, question), 'Claude has a question — open the chat');
  assert.equal(M.tabAnnounce(working, offline), 'Chat with Claude — reconnecting');
  assert.equal(M.tabAnnounce(working, suspended), '', 'suspended is never announced');
  assert.equal(M.tabAnnounce(offline, suspended), '', 'nor as offline');
  assert.equal(M.tabAnnounce(offline, idle), '');
  assert.equal(M.tabAnnounce(waiting, waiting), '');
  assert.equal(M.tabAnnounce(question, working), '');
  assert.equal(M.tabAnnounce(null, waiting), '', 'a first look says nothing');
});

// ── the badge ────────────────────────────────────────────────────────────────

test('badgeLook: off at 0, dimmed unless working', () => {
  const off = M.badgeLook({ running: 0, working: true }, { dock: 'right' });
  assert.ok(Object.isFrozen(off));
  assert.equal(off.off, true);
  assert.equal(off.n, 0);
  assert.equal(off.text, '0');
  assert.equal(off.label, 'No running tasks');
  assert.equal(M.badgeLook({ running: 2, working: false }).opacity, 0.75);
  assert.equal(M.badgeLook({ running: 2, working: true }).opacity, 1);
  assert.equal(M.badgeLook({ running: 2 }).off, false);
  assert.equal(M.badgeLook({ running: NaN }).off, true);
});

test('badgeLook: the inner side, and merged into a centred tab (N2)', () => {
  const right = M.badgeLook({ running: 6 }, { dock: 'right' });
  assert.equal(right.inner, 'left');
  assert.equal(right.merged, false);
  assert.equal(right.tabCount, 0);
  assert.equal(right.tabSuffix, '');
  assert.equal(M.badgeLook({ running: 6 }, { dock: 'left' }).inner, 'right');
  assert.equal(M.badgeLook({ running: 6 }, {}).inner, 'left', 'docked right by default');
  assert.equal(M.badgeLook({ running: 6 }, { dock: 'diagonal' }).inner, 'left', 'an invalid dock reads as right');

  const m = storeOf(finalFixture().mirrorBody, S);
  const running = P.runningCount(m, { now: NOW });
  const centre = M.badgeLook({ running, working: true, level: 'local' }, { dock: 'center' });
  assert.equal(centre.inner, null);
  assert.equal(centre.merged, true);
  assert.equal(centre.tabCount, 6);
  assert.equal(centre.tabSuffix, ', 6 running');
  assert.equal(M.badgeLook({ running: 0 }, { dock: 'center' }).tabSuffix, '', 'nothing running: no suffix');
});

test('badgeLook: the three label forms', () => {
  assert.equal(M.badgeLook({ running: 0 }).label, 'No running tasks');
  assert.equal(M.badgeLook({ running: 1 }).label, '1 running task — open Tasks');
  assert.equal(M.badgeLook({ running: 6 }).label, '6 running tasks — open Tasks');
});

// ── the Tasks root ───────────────────────────────────────────────────────────

const finalCats = (opts = {}) => {
  const { mirrorBody, queueBody } = finalFixture(opts);
  const m = storeOf(mirrorBody, S);
  return { m, cats: P.categories(m, queueOf(queueBody), { now: NOW }) };
};

test('categoryLines: the Final\'s fixture — five lines in order, from categories()\'s phone lines', () => {
  const { m, cats } = finalCats();
  const { lines, emptyNote } = M.categoryLines(cats, { level: 'local', working: true });
  assert.ok(Object.isFrozen(lines));
  assert.equal(emptyNote, '');
  assert.deepEqual(lines.map((l) => l.cat), ['shells', 'agents', 'workflows', 'monitors', 'queue']);
  const [shells, agents, workflows, monitors, queue] = lines;
  assert.deepEqual([shells.title, shells.tag, shells.meta, shells.line], ['Shells', '', '2 running', 'npm run dev · npm test -- --watch']);
  assert.equal(agents.line, 'Explore rail tests · 1 done');
  assert.deepEqual([workflows.title, workflows.tag, workflows.meta], ['release-check', 'WORKFLOW', 'step 3 / 5'],
    'one item: the item itself');
  assert.deepEqual(workflows.steps.map((s) => s.state), ['done', 'done', 'running', 'pending', 'pending'], 'its step bars');
  assert.equal(monitors.meta, '2 watching');
  assert.equal(queue.line, 'Also update the README screenshot', 'the next message');
  for (const [i, l] of lines.entries()) {
    const p = cats[i].phone;
    for (const k of ['title', 'tag', 'meta', 'line', 'steps', 'tone', 'mono']) assert.deepEqual(l[k], p[k], `${l.cat}.${k} is chat-present's`);
    assert.equal(l.tappable, true);
    assert.equal(l.countsOnly, false);
  }
  // deviation 19: one definition of running, for the badge and the lines.
  assert.equal(P.runningCount(m, { now: NOW }), 6);
  assert.equal(lines.reduce((n, l) => n + l.running, 0), 6);
  assert.deepEqual(lines.map((l) => l.running), [2, 1, 1, 2, 0]);
});

test('categoryLines: a dot pulses only while Claude works', () => {
  const { cats } = finalCats();
  assert.deepEqual(M.categoryLines(cats, { level: 'local', working: true }).lines.map((l) => l.pulse),
    [true, true, true, true, false], 'the queue never pulses');
  assert.deepEqual(M.categoryLines(cats, { level: 'local', working: false }).lines.map((l) => l.pulse),
    [false, false, false, false, false]);
});

test('categoryLines: below read, counts only, and only the Queue is tappable', () => {
  const { m, cats } = finalCats({ level: 'basic' });
  assert.equal(P.runningCount(m, { now: NOW }), 6, 'the status rows\' counts');
  const { lines } = M.categoryLines(cats, { level: 'basic', working: true });
  assert.deepEqual(lines.map((l) => l.cat), ['shells', 'agents', 'workflows', 'monitors', 'queue']);
  assert.deepEqual(lines.map((l) => l.countsOnly), [true, true, true, true, true]);
  assert.deepEqual(lines.map((l) => l.tappable), [false, false, false, false, true]);
  assert.equal(lines.reduce((n, l) => n + l.running, 0), 6);
  assert.deepEqual(lines.slice(0, 4).map((l) => l.line), ['', '', '', ''], 'no content below read');
  assert.deepEqual(M.categoryLines(cats, { level: undefined }).lines.map((l) => l.tappable), [false, false, false, false, true],
    'an unknown level shows counts only');
});

test('categoryLines: the Queue line is always there', () => {
  const { mirrorBody } = finalFixture();
  const m = storeOf(mirrorBody, S);
  const cats = P.categories(m, queueOf({ items: [], count: 0 }), { now: NOW });
  assert.equal(cats.some((c) => c.cat === 'queue'), false, 'categories() omits an empty queue …');
  const { lines } = M.categoryLines(cats, { level: 'local', working: true });
  const q = lines.at(-1);
  assert.deepEqual([q.cat, q.title, q.line, q.tappable, q.pulse, q.running], ['queue', 'Queue', 'Nothing queued', true, false, 0],
    '… and the phone still has its line');
  assert.equal(M.categoryLines([], { level: 'basic' }).lines[0].tappable, true, 'tappable at every level');

  const parked = queueOf({ items: [], count: 0 }, { parked: { id: 'p1', count: 2 } });
  const pc = P.categories(m, parked, { now: NOW });
  assert.equal(M.categoryLines(pc, { level: 'local', parked: !!parked.parked }).lines.at(-1).line,
    '⇢ Parked — delivers with your next message', 'a parked push');
});

test('categoryLines: no task category gives the one muted note', () => {
  const m = storeOf(body([conv('c1', { state: 'idle' })]), S);
  const cats = P.categories(m, queueOf({ items: [], count: 0 }), { now: NOW });
  assert.deepEqual(cats, []);
  const { lines, emptyNote } = M.categoryLines(cats, { level: 'local' });
  assert.equal(emptyNote, 'No background tasks right now');
  assert.deepEqual(lines.map((l) => l.cat), ['queue']);
  const { queueBody } = finalFixture();
  const withQueue = M.categoryLines(P.categories(m, queueOf(queueBody), { now: NOW }), { level: 'local' });
  assert.equal(withQueue.emptyNote, 'No background tasks right now', 'the queue is not a background task');
  assert.equal(withQueue.lines.length, 1);
});

// ── the keyboard ─────────────────────────────────────────────────────────────

test('keyboardInset, keyboardUp and kbFrame', () => {
  assert.equal(M.keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 0 }), 336);
  assert.equal(M.keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 40 }), 296);
  assert.equal(M.keyboardInset({ innerHeight: 844, vvHeight: undefined, vvOffsetTop: 0 }), 0);
  assert.equal(M.keyboardInset({ innerHeight: NaN, vvHeight: 508, vvOffsetTop: 0 }), 0);
  assert.equal(M.keyboardInset({ innerHeight: 844, vvHeight: 508, vvOffsetTop: Infinity }), 0);
  assert.equal(M.keyboardInset(), 0);
  assert.equal(M.keyboardUp(81), true);
  assert.equal(M.keyboardUp(80), false, 'up only past 80 px');
  assert.equal(M.keyboardUp(NaN), false);
  assert.deepEqual({ ...M.kbFrame({ vvHeight: 508, vvOffsetTop: 40 }) }, { top: 48, height: 500 });
  assert.deepEqual({ ...M.kbFrame({ vvHeight: 4, vvOffsetTop: 0 }) }, { top: 8, height: 0 });
});

// ── the fixture ──────────────────────────────────────────────────────────────

test('the Final\'s fixture: wire bodies a jsdom test can serve, and a store built from them', () => {
  const { mirrorBody, queueBody, now } = finalFixture({ now: NOW + 5 });
  assert.equal(now, NOW + 5);
  assert.equal(mirrorBody.now, NOW + 5);
  assert.deepEqual(mirrorBody.access, { level: 'local', remote: false });
  assert.deepEqual(Object.keys(mirrorBody.capabilities).sort(), ['interrupt', 'queue_message', 'task_stop']);
  assert.equal(mirrorBody.tasks.length, 7);
  assert.equal(queueBody.count, 2);
  assert.ok(JSON.parse(JSON.stringify(mirrorBody)), 'plain JSON');
  const m = storeOf(mirrorBody, S);
  assert.equal(m.followed, 'c1');
  assert.equal(m.conn, 'live');
  assert.equal(m.availability, 'ok');
  assert.equal(m.capabilities.interrupt, true);
  assert.equal(m.tasks.size, 7);
  assert.equal(P.uiState(m, { now: NOW + 5 }).key, 'working');
  const basic = storeOf(finalFixture({ level: 'basic' }).mirrorBody, S);
  assert.equal(basic.access.level, 'basic');
  assert.equal(basic.tasks.size, 0, 'no task rows below read');
  assert.equal(storeOf({ enabled: false, hint: 'claude-web-chat on' }, S).availability, 'disabled');
});

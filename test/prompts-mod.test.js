// What the chat chrome says about an MCP form and a sandbox prompt (spec
// §15.7, tranche 6): public/app/prompts-mod.js's pure helpers, chat-present's
// branch for a pending answerable elicitation, and — in the real chrome
// (bootShell) — the bar and the awaiting card.
//
//   * pendingElicitation(m, cid): the pending, answerable elicitation of that
//     conversation, or null — always null on a remote page (ruled D3 (a): an
//     elicitation is local only), so the phone through the tunnel keeps
//     "Needs you — answer in the terminal";
//   * elicitationLine(ask): 'MCP input · <server>' (ruled F8 (a));
//   * uiState: the bar reads that line with act 'answer' while the session is
//     busy (the hook holds the terminal's dialog back);
//   * SANDBOX: a network prompt fires no hook and no mod event, so the
//     sessions file's `waiting` with no ask is live.js's waiting kind 'other',
//     which already reads "Needs you — answer in the terminal" and mounts no
//     answer frame. Nothing is built for it; this proves it.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');

const REPO = path.resolve(__dirname, '..');
const T = Date.now();
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let PM, CP;
before(async () => {
  PM = await import(pathToFileURL(path.join(REPO, 'public/app/prompts-mod.js')).href);
  CP = await import(pathToFileURL(path.join(REPO, 'public/app/chat-present.js')).href);
});

// ── plain node: the helpers and the line ────────────────────────────────────

const elicitAsk = (over = {}) => ({
  id: 'ask_00e1c1001234', conversation_id: 'c1', kind: 'elicitation', tool_name: 'scratch', tool_kind: 'elicitation',
  state: 'pending', answerable: true, created_at: T - 1000, version: 1, source: 'ask', ...over,
});

function store({ state = 'working', waiting, asks = [], level = 'local', remote = false } = {}) {
  const live = { state, since: T - 60000, last_activity_at: T - 1000, turn_started_at: T - 5000 };
  if (waiting) live.waiting = waiting;
  return {
    conn: 'live',
    availability: 'ok',
    access: { level, remote },
    followed: 'c1',
    skew: 0,
    conversations: new Map([['c1', { id: 'c1', headless: false, counts: ZERO, live }]]),
    status: new Map(),
    awaiting: new Map(asks.map((a) => [a.id, a])),
    tasks: new Map(),
  };
}

test('pendingElicitation: the newest pending, answerable elicitation of the conversation; null otherwise', () => {
  const a = elicitAsk();
  const newer = elicitAsk({ id: 'ask_00e1c1009999', created_at: T, tool_name: 'other' });
  assert.equal(PM.pendingElicitation(store({ asks: [a] }), 'c1'), a);
  assert.equal(PM.pendingElicitation(store({ asks: [a, newer] }), 'c1'), newer);
  for (const [what, m, cid] of [
    ['another conversation', store({ asks: [a] }), 'c2'],
    ['no conversation', store({ asks: [a] }), null],
    ['resolved', store({ asks: [elicitAsk({ state: 'resolved' })] }), 'c1'],
    ['decided', store({ asks: [elicitAsk({ state: 'decided' })] }), 'c1'],
    ['not answerable', store({ asks: [elicitAsk({ answerable: false })] }), 'c1'],
    ['a permission', store({ asks: [elicitAsk({ kind: 'permission' })] }), 'c1'],
    ['a remote page at full', store({ asks: [a], level: 'full', remote: true }), 'c1'],
    ['a remote page, whatever it claims', store({ asks: [a], level: 'local', remote: true }), 'c1'],
    ['below local', store({ asks: [a], level: 'read' }), 'c1'],
    ['no store', null, 'c1'],
  ]) assert.equal(PM.pendingElicitation(m, cid), null, what);
});

test('elicitationLine: MCP input · <server>', () => {
  assert.equal(PM.elicitationLine(elicitAsk()), 'MCP input · scratch');
  assert.equal(PM.elicitationLine({}), 'MCP input · an MCP server');
});

test('uiState: a pending answerable elicitation reads MCP input · <server> with act answer, before working', () => {
  const ask = elicitAsk();
  const s = CP.uiState(store({ asks: [ask] }), { now: T, approvalsReady: true });
  assert.deepEqual([s.key, s.label, s.head, s.act], ['waiting', 'NEEDS YOU', 'MCP input · scratch', 'answer']);
  assert.equal(s.ask, ask);
  const idle = CP.uiState(store({ state: 'idle', asks: [ask] }), { now: T });
  assert.equal(idle.head, 'MCP input · scratch', 'whatever the session last said');
  // Remote: never the line — the terminal answers.
  const remote = CP.uiState(store({ asks: [ask], level: 'full', remote: true }), { now: T });
  assert.notEqual(remote.head, 'MCP input · scratch');
  assert.equal(remote.act, null);
  // A question or a permission the session is waiting on keeps its own line.
  const q = CP.uiState(store({ state: 'question', waiting: { kind: 'question', summary: 'Which?' }, asks: [ask] }), { now: T });
  assert.equal(q.head, 'Question · Which?');
});

test('uiState, sandbox: waiting with no ask reads "Needs you — answer in the terminal" with no act', () => {
  const s = CP.uiState(store({ state: 'waiting', waiting: { kind: 'other' } }), { now: T, approvalsReady: true });
  assert.deepEqual([s.key, s.head, s.act], ['waiting', 'Needs you — answer in the terminal', null]);
  assert.equal(s.ask.answerable, false, 'the live stand-in: nothing to answer here');
});

// ── the chrome (bootShell) ──────────────────────────────────────────────────

let shell, S, P, slots, bus;
let current = null;
let rev = 7000;

const conversation = (l) => ({ id: 'c1', rev: 1, title: 'c1', headless: false, counts: ZERO, live: l });
function snapshot({ live, asks = [] }) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: true, access: { level: 'local', remote: false }, capabilities: {},
    primary: 'c1', aggregate: { state: 'idle' }, conversations: [conversation(live)], tasks: [], asks };
}
async function show(over) {
  const snap = snapshot(over);
  current = snap;
  await shell.frame(helloFrame());
  await shell.tick();
  assert.ok(S.mirror.availability === 'ok' && S.mirror.rev >= snap.rev, 'the mirror snapshot landed');
}
function fakeApprovals(t) {
  const calls = { mountCard: [], mountSheet: [], mountBar: [] };
  const off = slots.registerApprovals({
    mountBar(el, ask) { calls.mountBar.push(ask.id); return false; },
    mountCard(el, ask) {
      calls.mountCard.push(ask.id);
      const f = shell.document.createElement('div');
      f.className = 'test-answer-frame';
      el.append(f);
      return true;
    },
    mountSheet(el, ask) { calls.mountSheet.push(ask.id); return false; },
    unmount() {},
  });
  t.after(off);
  return calls;
}
const barText = () => shell.$('cs-step-text').textContent;
const card = () => shell.$('chat-awaiting');

before(async () => {
  shell = await bootShell({
    routes: { '/api/mirror': () => (current === null ? respond({ error: 'not found' }, { status: 404 }) : current) },
  });
  S = await shell.importApp('chat-state.js');
  P = await shell.importApp('chat-present.js');
  slots = await shell.importApp('chat-slots.js');
  ({ bus } = await shell.importApp('bus.js'));
});
after(() => shell.restore());

test('chrome, sandbox: a session waiting with no ask reads answer in the terminal on the bar, and no frame mounts', async (t) => {
  const calls = fakeApprovals(t);
  await show({ live: { state: 'waiting', since: T - 1000, last_activity_at: T - 1000, waiting: { kind: 'other' } } });
  bus.emit('chat:open', { view: 'chat' });
  await shell.tick();
  assert.equal(barText(), 'Needs you — answer in the terminal');
  assert.equal(P.uiState(S.mirror, { now: S.serverNow(), approvalsReady: true }).act, null);
  assert.deepEqual([calls.mountCard, calls.mountSheet, calls.mountBar], [[], [], []], 'no answer frame');
  assert.equal(card().querySelector('.test-answer-frame'), null);
  assert.equal(card().querySelector('.cp-aw-hint').textContent, 'Answer in the terminal', 'the read-only card says so');
});

// The chrome's store (public/app/chat-state.js ASK_KINDS) keeps only
// permission, question and plan asks, so an elicitation from the daemon never
// reaches m.awaiting: this waits on the one-line grant of chat-state.js named
// in U92's hand-off. The pure path above (uiState over a store that holds the
// ask) proves the bar's line and act.
test('chrome: a pending answerable elicitation reads MCP input · <server> on the bar, and the awaiting card mounts the frame', {
  todo: 'waits on chat-state.js ASK_KINDS gaining elicitation (U92 hand-off, open issue 1)',
}, async (t) => {
  const calls = fakeApprovals(t);
  await show({
    live: { state: 'working', since: T - 1000, last_activity_at: T - 1000, turn_started_at: T - 5000 },
    asks: [elicitAsk()],
  });
  bus.emit('chat:open', { view: 'awaiting' });
  await shell.tick();
  assert.equal(barText(), 'MCP input · scratch');
  assert.equal(P.uiState(S.mirror, { now: S.serverNow(), approvalsReady: true }).act, 'answer');
  assert.deepEqual(calls.mountCard, [elicitAsk().id]);
  assert.equal(card().querySelector('.cp-aw-title').textContent, 'AWAITING YOU · MCP INPUT');
});

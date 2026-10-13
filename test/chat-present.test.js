// The chat chrome's presentation model (public/app/chat-present.js), in plain
// node: pure functions of the store, DOM-free, shared with the phone.
//
// What is pinned (design spec §7.3): uiState says every row of the wording
// table — 'Stopped · from this page' for a turn the browser stopped and the
// basic level's content-free line among them — and gates `approve` on the
// answer frame, the ask and the level; categories() reads the Final's fixture as
// `2 monitors` and `6 running` (deviation 19: a live monitor is running), omits
// empty categories, and never pulses the queue chip; announce() speaks for four
// transitions only, at most once per 2 s, never for a suspend nor for a headless
// conversation followed by choice (§2.2). And queue.js:
// queueSnapshot() is what the chips read, announced on the bus at the end of
// every render().
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'public/app');
const appUrl = (rel) => pathToFileURL(path.join(APP, rel)).href;

let P;     // chat-present.js
let S;     // chat-state.js (its normalizers build the store's records)
let bus;
let labels;
test.before(async () => {
  P = await import(appUrl('chat-present.js'));
  S = await import(appUrl('chat-state.js'));
  ({ bus } = await import(appUrl('bus.js')));
  labels = await import(appUrl('labels.js'));
});

const NOW = 1_790_000_000_000;
const sec = (n) => n * 1000;
const min = (n) => n * 60000;

// A store as chat-state.js holds it, its records built by the store's own
// normalizers, so these tests read the shapes the chrome really gets.
function mirror({
  conn = 'live', connSince = NOW - sec(12), remote = false, level = 'local', availability = 'ok', hint = null,
  followed = 'c1', conversations = [], status = [], tasks = [], asks = [], capabilities = {}, seen = [], stream = [],
} = {}) {
  const convs = conversations.map((c) => S.normalizeConversation(c));
  const rows = status.length ? status.map((r) => S.normalizeStatusRow(r)) : convs.map((c) => S.statusFromConversation(c));
  return {
    v: 1, conn, connSince, availability, hint, skew: 0,
    access: { level, remote },
    capabilities: S.normalizeCapabilities(capabilities),
    conversations: new Map(convs.map((c) => [c.id, c])),
    followed, serverPrimary: followed,
    status: new Map(rows.map((r) => [r.id, r])),
    tasks: new Map(tasks.map((t) => S.normalizeTask(t)).map((t) => [t.id, t])),
    awaiting: new Map(asks.map((a) => [a.id, a])),
    stream: { conversationId: followed, turns: stream, hasOlder: false, loading: false },
    seen: new Set(seen),
  };
}
const conv = (live, extra = {}) => ({ id: 'c1', rev: 1, title: 'Queue rail redesign', live: { rev: 1, since: NOW - min(1), ...live },
  counts: { shells: 0, agents: 0, workflows: 0, monitors: 0 }, ...extra });
const one = (live, opts = {}, extra = {}) => mirror({ conversations: [conv(live, extra)], ...opts });

// ── the module ───────────────────────────────────────────────────────────────

test('the presentation model is DOM-free, runs no timer, and `ago` has moved to labels.js', () => {
  const src = fs.readFileSync(path.join(APP, 'chat-present.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  // prompts-mod.js: the elicitation's line (tranche 6, U92), pure as this is.
  assert.deepEqual(imports.sort(), ['./chat-state.js', './labels.js', './prompts-mod.js']);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bdocument\b|\bwindow\b|\bHTMLElement\b|\bset(?:Timeout|Interval)\b/);
  const pm = fs.readFileSync(path.join(APP, 'prompts-mod.js'), 'utf8');
  assert.deepEqual([...pm.matchAll(/^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]), ['./chat-state.js']);
  assert.doesNotMatch(pm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /\bdocument\b|\bwindow\b|\bHTMLElement\b|\bset(?:Timeout|Interval)\b/);
  assert.equal(P.ago, labels.ago, 'one `ago`, re-exported');
  const sessions = fs.readFileSync(path.join(APP, 'sessions.js'), 'utf8');
  assert.match(sessions, /^import \{ ago \} from '\.\/labels\.js';$/m);
  assert.match(sessions, /^export \{ ago \};$/m, 'the Sessions panel still exports it');
  assert.doesNotMatch(sessions, /function ago\(/, 'and no longer keeps a copy');
});

test('the time phrases: fmtClock, fmtShort, ago', () => {
  assert.equal(P.fmtClock(sec(42)), '0:42');
  assert.equal(P.fmtClock(sec(3753)), '1:02:33');
  assert.equal(P.fmtClock(-5), '0:00');
  assert.equal(P.fmtClock(NaN), '');
  assert.equal(P.fmtShort(sec(42)), '42s');
  assert.equal(P.fmtShort(min(14)), '14m');
  assert.equal(P.fmtShort(min(125)), '2h 5m');
  assert.equal(P.fmtShort(min(120)), '2h');
  assert.equal(P.fmtShort(min(60 * 76)), '3d 4h');
  assert.equal(P.ago(NOW - min(4), NOW), '4m ago');
  assert.equal(P.ago(NOW - sec(2), NOW), 'just now');
  assert.equal(P.ago(undefined, NOW), null);
});

// ── uiState: the wording table, row by row ───────────────────────────────────

const WORDING = [
  ['socket down', () => mirror({ conn: 'reconnecting' }),
    { key: 'offline', label: 'OFFLINE', head: 'Offline · reconnecting…', meta: '12s', text: 'Offline · reconnecting… · 12s',
      detail: 'surface offline, reconnecting (12s)' }],
  ['socket down, remote viewer', () => mirror({ conn: 'reconnecting', remote: true, level: 'basic' }),
    { key: 'offline', label: 'OFFLINE', text: "Offline · can't reach this computer · retrying", meta: '',
      detail: "can't reach the host, retrying" }],
  ['mirror unavailable', () => mirror({ availability: 'unavailable' }),
    { key: 'idle', label: 'IDLE', text: 'Live', detail: "Claude's status isn't available on this surface" }],
  ['mirror disabled', () => mirror({ availability: 'disabled', hint: 'claude-web-chat on' }),
    { key: 'idle', label: 'IDLE', text: 'Chat mirror off · claude-web-chat on', detail: 'claude-web-chat on' }],
  ['no conversation', () => mirror({ followed: null }),
    { key: 'idle', label: 'IDLE', text: 'No Claude session', detail: 'start claude in this project' }],
  ['working, a tool', () => one({ state: 'working', step: { kind: 'Edit', tool: 'Edit', label: 'Edit · QueueRail.tsx', started_at: NOW - sec(42) },
      last_activity_at: NOW - sec(38) }),
    { key: 'working', label: 'WORKING', head: 'Edit · QueueRail.tsx', meta: '0:42',
      detail: 'Edit · QueueRail.tsx · 0:42 · last activity 38s ago', pace: 'normal', act: null }],
  ['working, a tool, active just now', () => one({ state: 'working', step: { kind: 'Edit', label: 'Edit · QueueRail.tsx', started_at: NOW - sec(42) },
      last_activity_at: NOW - sec(3) }),
    { key: 'working', head: 'Edit · QueueRail.tsx', meta: '0:42', detail: 'Edit · QueueRail.tsx · 0:42' }],
  ['working, no tool known', () => one({ state: 'working', step: null, turn_started_at: NOW - sec(12), last_activity_at: NOW }),
    { key: 'working', label: 'WORKING', text: 'Working · 0:12', meta: '0:12', detail: '0:12' }],
  ['compacting', () => one({ state: 'compacting', since: NOW - sec(18) }),
    { key: 'working', label: 'WORKING', text: 'Compacting · 0:18', detail: 'compacting the conversation · 0:18' }],
  ['quiet', () => one({ state: 'working', quiet: { since: NOW - min(4), reason: 'no-activity' },
    step: { kind: 'Bash', label: 'Bash · npm test', started_at: NOW - min(9) } }),
    { key: 'working', label: 'WORKING', text: 'Quiet 4m · Bash · npm test — check the terminal', pace: 'quiet',
    detail: 'quiet for 4m (last: Bash · npm test); check the terminal' }],
  ['question', () => one({ state: 'question',
    waiting: { kind: 'question', tool: 'AskUserQuestion', summary: 'Keep the 56px rail, or match the 64px queue rail?' } }),
    { key: 'question', label: 'QUESTION', text: 'Question · Keep the 56px rail, or match the 64px queue rail?', act: 'answer',
    detail: 'Keep the 56px rail, or match the 64px queue rail?' }],
  ['permission, no frame mounted', () => one({ state: 'waiting',
    waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist && npm run build)' } }),
    { key: 'waiting', label: 'NEEDS YOU', text: 'Permission · Bash(rm -rf dist && npm run build)', act: 'review',
    detail: 'Permission · Bash(rm -rf dist && npm run build)' }],
  ['plan', () => one({ state: 'waiting', waiting: { kind: 'plan', tool: 'ExitPlanMode' } }),
    { key: 'waiting', label: 'NEEDS YOU', text: 'Plan ready · review it', act: 'review', detail: 'plan approval' }],
  ['other wait', () => one({ state: 'waiting', waiting: { kind: 'other', summary: 'input needed' } }),
    { key: 'waiting', label: 'NEEDS YOU', text: 'Needs you · input needed — answer in the terminal', act: null,
      detail: 'input needed' }],
  ['idle after a turn that changed files', () => one({ state: 'idle', last_turn: { id: 't9', outcome: 'done', ended_at: NOW - min(4), code: { files: 3, additions: 40, deletions: 12 } } }),
    { key: 'idle', label: 'IDLE', head: 'Done · 3 files changed', meta: '4m ago', text: 'Done · 3 files changed · 4m ago',
      detail: 'done · 3 files changed · 4m ago' }],
  ['idle after a reply only', () => one({ state: 'idle', last_turn: { id: 't9', outcome: 'done', ended_at: NOW - min(4), code: null,
      reply_preview: 'The rail now collapses to 56px and remembers its width, and the queue rail keeps 64px.' } }),
    { key: 'idle', label: 'IDLE', head: 'Done · “The rail now collapses to 56px and remembers its width, and…”',
      detail: 'replied 4m ago' }],
  ['idle after an Esc', () => one({ state: 'idle', last_turn: { id: 't9', outcome: 'interrupted', ended_at: NOW - min(2), ended_by: 'terminal' } }),
    { key: 'idle', label: 'IDLE', head: 'Stopped · interrupted in the terminal', meta: '2m ago', detail: 'interrupted · 2m ago' }],
  ['idle after a Stop from the browser (ended_by web)', () => one({ state: 'idle', last_turn: { id: 't9', outcome: 'interrupted', ended_at: NOW - min(2), ended_by: 'web' } }),
    { key: 'idle', label: 'IDLE', head: 'Stopped · from this page', meta: '2m ago', text: 'Stopped · from this page · 2m ago',
      detail: 'stopped from the web-chat page · 2m ago' }],
  ['idle after a Stop from the browser (ended_by hook: stop after this step)', () => one({ state: 'idle', last_turn: { id: 't9', outcome: 'interrupted', ended_at: NOW - min(2), ended_by: 'hook' } }),
    { key: 'idle', head: 'Stopped · from this page', detail: 'stopped from the web-chat page · 2m ago' }],
  ['idle after a failure', () => one({ state: 'idle', last_turn: { id: 't9', outcome: 'error', ended_at: NOW - min(2), error: 'API error' } }),
    { key: 'idle', label: 'IDLE', head: 'Stopped · API error — see the terminal', detail: 'stopped: API error' }],
  ['idle, stale status', () => one({ state: 'idle', stale_status: true, last_activity_at: NOW - min(60 * 24 * 18) }),
    { key: 'idle', label: 'IDLE', text: 'Idle — the session says busy, but nothing has happened for 18 days',
      detail: 'status looks stale' }],
  ['suspended', () => one({ state: 'suspended' }),
    { key: 'suspended', label: 'SUSPENDED', text: 'Suspended · resume it in the terminal (fg)', pace: 'normal',
      detail: 'stopped with Ctrl-Z; fg in the terminal resumes it' }],
  ['ended', () => one({ state: 'ended', since: NOW - min(2) }, {}, { ended_at: NOW - min(2) }),
    { key: 'idle', label: 'IDLE', head: 'Session ended', meta: '2m ago', text: 'Session ended · 2m ago',
      detail: 'session ended 2m ago' }],
  ['unknown', () => one({ state: 'unknown' }),
    { key: 'idle', label: 'IDLE', text: 'Status unknown — check the terminal',
      detail: 'no recent sign of this session; check the terminal' }],
  ['level basic, working', () => mirror({ level: 'basic', remote: true,
    status: [{ id: 'c1', state: 'working', since: NOW - sec(252), step_kind: 'Edit', counts: {} }] }),
    { key: 'working', label: 'WORKING', head: 'Working · Edit', meta: '4:12', text: 'Working · Edit · 4:12', detail: 'Edit · 4:12' }],
];

for (const [name, fixture, want] of WORDING) {
  test(`uiState: ${name}`, () => {
    const ui = P.uiState(fixture(), { now: NOW });
    for (const [k, v] of Object.entries(want)) assert.deepEqual(ui[k], v, `${name}: ${k}`);
    assert.ok(Object.isFrozen(ui));
  });
}

test('uiState: the answer frame — `approve` only with a slot, an answerable ask and the level full or local', () => {
  const live = { state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(rm -rf dist && npm run build)', ask_id: 'ask_1' } };
  const ask = (extra = {}) => ({ id: 'ask_1', conversation_id: 'c1', kind: 'permission', tool_name: 'Bash', state: 'pending',
    answerable: true, source: 'ask', ...extra });
  const mounted = P.uiState(one(live, { asks: [ask()] }), { now: NOW, approvalsReady: true });
  assert.equal(mounted.act, 'approve');
  assert.equal(mounted.text, 'Permission · Bash', 'beside the frame: the tool, never the subject');
  assert.equal(mounted.detail, 'Permission · Bash');
  assert.equal(mounted.ask.id, 'ask_1');
  assert.doesNotMatch(JSON.stringify([mounted.head, mounted.detail, mounted.text]), /rm -rf/);

  const cases = [
    ['no slot', one(live, { asks: [ask()] }), false],
    ['not answerable', one(live, { asks: [ask({ answerable: false })] }), true],
    ['already decided', one(live, { asks: [ask({ state: 'decided' })] }), true],
    ['level read', one(live, { asks: [ask()], level: 'read', remote: true }), true],
    ['no ask at all', one(live), true],
  ];
  for (const [why, m, slot] of cases) {
    const ui = P.uiState(m, { now: NOW, approvalsReady: slot });
    assert.equal(ui.act, 'review', why);
    assert.equal(ui.text, 'Permission · Bash(rm -rf dist && npm run build)', why);
  }
  const plan = P.uiState(one({ state: 'waiting', waiting: { kind: 'plan', ask_id: 'ask_2' } },
    { asks: [ask({ id: 'ask_2', kind: 'plan' })] }), { now: NOW, approvalsReady: true });
  assert.equal(plan.act, 'review', 'a plan approval always opens the card, never inline');
  assert.equal(plan.ask.id, 'ask_2');
});

test('uiState: below read every waiting state is worded from its kind alone', () => {
  const basic = (row) => mirror({ level: 'basic', remote: true, status: [{ id: 'c1', since: NOW - min(1), counts: {}, ...row }] });
  const q = P.uiState(basic({ state: 'question', waiting_kind: 'question' }), { now: NOW });
  assert.deepEqual([q.key, q.text, q.act], ['question', 'Needs you · question', 'answer']);
  const p = P.uiState(basic({ state: 'waiting', waiting_kind: 'permission' }), { now: NOW, approvalsReady: true });
  assert.deepEqual([p.key, p.label, p.text, p.act], ['waiting', 'NEEDS YOU', 'Needs you · permission', 'review']);
  const quiet = P.uiState(basic({ state: 'working', quiet: true, step_kind: 'Bash', last_activity_at: NOW - min(4) }), { now: NOW });
  assert.equal(quiet.text, 'Quiet 4m · Bash — check the terminal');
  const idle = P.uiState(basic({ state: 'idle', since: NOW - min(4), last_activity_at: NOW - min(4) }), { now: NOW });
  assert.equal(idle.text, 'Idle · 4m ago');
});

test('uiState: `others` lists every other live, non-headless conversation waiting on the user', () => {
  const m = mirror({ conversations: [
    conv({ state: 'working' }),
    { ...conv({ state: 'waiting', waiting: { kind: 'permission' } }), id: 'c2', title: 'Second session' },
    { ...conv({ state: 'question', waiting: { kind: 'question' } }), id: 'c3', headless: true },
    { ...conv({ state: 'idle' }), id: 'c4' },
    { ...conv({ state: 'ended' }), id: 'c5' },
  ] });
  const ui = P.uiState(m, { now: NOW });
  assert.deepEqual(ui.others.map((o) => ({ ...o })), [{ id: 'c2', state: 'waiting', waiting_kind: 'permission', title: 'Second session' }]);
  const basic = mirror({ level: 'basic', status: [
    { id: 'c1', state: 'idle', counts: {} }, { id: 'c2', state: 'question', waiting_kind: 'question', counts: {} },
  ] });
  assert.deepEqual(P.uiState(basic, { now: NOW }).others.map((o) => o.id), ['c2']);
});

// ── categories ───────────────────────────────────────────────────────────────

// The Final's chips and trays (Claude Design, ChatFinalDesktop): two shells, a
// running agent and a finished one, a workflow at step 3 of 5, two monitors —
// both live, which the Final counted as one (deviation 19) — and two messages.
function finalFixture() {
  const m = mirror({
    capabilities: { task_stop: true, queue_message: true },
    conversations: [conv({ state: 'working', step: { kind: 'Edit', label: 'Edit · QueueRail.tsx', started_at: NOW - sec(10) } })],
    tasks: [
      { id: 'b1', conversation_id: 'c1', kind: 'shell', title: 'npm run dev', status: 'running', started_at: NOW - min(14),
        meta: { port: 5173 }, line: '✓ ready in 412ms — hmr update /src/rail/QueueRail.tsx', can: { output: true, stop: true } },
      { id: 'b2', conversation_id: 'c1', kind: 'shell', title: 'npm test -- --watch', status: 'running', started_at: NOW - min(3),
        line: 'Tests 42 passed (42) · watching for changes' },
      { id: 'a1', conversation_id: 'c1', kind: 'agent', title: 'Explore rail tests', status: 'running', started_at: NOW - sec(72),
        meta: { tools: 6 }, line: 'Read · tests/rail.spec.ts' },
      { id: 'a2', conversation_id: 'c1', kind: 'agent', title: 'Audit CSS tokens', status: 'done', started_at: NOW - min(9),
        ended_at: NOW - min(4), line: '“Found 3 hard-coded colors in app.css.”' },
      { id: 'w1', conversation_id: 'c1', kind: 'workflow', title: 'release-check', status: 'running', started_at: NOW - min(6),
        meta: { step: { index: 3, total: 5 } }, line: 'eslint src --max-warnings 0 · 118 files',
        steps: [{ label: 'build', state: 'done' }, { label: 'types', state: 'done' }, { label: 'lint', state: 'running' },
          { label: 'e2e', state: 'pending' }, { label: 'tag', state: 'pending' }] },
      { id: 'm1', conversation_id: 'c1', kind: 'monitor', title: 'PR #212 CI', status: 'running', started_at: NOW - min(30),
        meta: { events: 4, last_event_at: NOW - sec(10) }, line: 'waiting on e2e (chromium), e2e (webkit), deploy-preview' },
      { id: 'm2', conversation_id: 'c1', kind: 'monitor', title: 'Build errors', status: 'running', started_at: NOW - min(20),
        meta: { events: 2, last_event_at: NOW - min(6) }, line: 'tail -f .logs/build.log | grep -i error' },
    ],
  });
  const queue = {
    items: [
      { id: 'q1', kind: 'message', staged: true, text: 'Also update the README screenshot', device: 'mobile', enqueued_at: NOW - min(2) },
      { id: 'q2', kind: 'message', staged: true, text: 'Then run the e2e suite and push', device: 'desktop', enqueued_at: NOW - min(1) },
    ],
    count: 2, staged: 2, held: 0, parked: null,
  };
  return { m, queue };
}

const labelsOf = (actions) => actions.map((a) => a.label);

test('categories: the Final\'s fixture reads `2 monitors` and `6 running`', () => {
  const { m, queue } = finalFixture();
  const cats = P.categories(m, queue, { now: NOW });
  assert.deepEqual(cats.map((c) => c.cat), ['shells', 'agents', 'workflows', 'monitors', 'queue']);
  assert.deepEqual(cats.map((c) => c.label), ['2 shells', '1 agent', '1 workflow', '2 monitors', 'queue 2']);
  assert.deepEqual(cats.map((c) => c.sub), ['2 running', '1 running · 1 done', '1 running', '2 watching', '2 queued']);
  assert.equal(P.runningCount(m, { now: NOW }), 6, 'the badge and the Tasks segment: every running row, monitors included');
  assert.equal(cats.reduce((n, c) => n + c.running, 0), 6, 'the chips count the same');

  const [shells, agents, workflows, monitors, queueCat] = cats;
  assert.deepEqual(shells.rows.map((r) => r.meta), ['14m · :5173', '3m']);
  assert.deepEqual(shells.rows.map((r) => r.mono), [true, true]);
  assert.deepEqual(labelsOf(shells.rows[0].actions), ['Output', 'Kill']);
  assert.deepEqual(agents.rows.map((r) => r.meta), ['1:12 · 6 tools', 'done 4m ago']);
  assert.deepEqual(agents.rows.map((r) => labelsOf(r.actions)), [['Open', 'Cancel'], ['Open']]);
  assert.deepEqual(agents.rows.map((r) => r.tone), ['live', 'muted']);
  assert.equal(agents.rows[1].line, '“Found 3 hard-coded colors in app.css.”');
  assert.deepEqual(workflows.rows[0].meta, 'step 3 / 5');
  assert.deepEqual(workflows.rows[0].steps.map((s) => s.state), ['done', 'done', 'running', 'pending', 'pending']);
  assert.deepEqual(labelsOf(workflows.rows[0].actions), ['Open', 'Cancel']);
  assert.deepEqual(monitors.rows.map((r) => r.meta), ['4 events', 'last fired 6m ago']);
  assert.deepEqual(monitors.rows.map((r) => labelsOf(r.actions)), [['Open', 'Remove'], ['Open', 'Remove']]);
  assert.deepEqual(queueCat.rows.map((r) => [r.title, r.meta, r.line]), [
    ['Also update the README screenshot', 'next', 'sent from phone · 2m ago'],
    ['Then run the e2e suite and push', '#2', 'sent from desktop · 1m ago'],
  ]);
  assert.deepEqual(queueCat.rows.map((r) => labelsOf(r.actions)), [['Edit', 'Send now', 'Remove'], ['Edit', 'Remove']]);

  const kill = shells.rows[0].actions[1];
  assert.equal(kill.destructive, true);
  assert.deepEqual({ ...kill.confirm }, { text: 'Kill npm run dev? Claude stops it with TaskStop at its next step.', yes: 'Kill',
    no: 'Keep', touch: 'Confirm kill' });
  assert.equal(queueCat.rows[0].actions.find((a) => a.id === 'remove').confirm, null, 'a queue Remove needs no confirm');

  // The phone's Tasks lines (§8.6): a category's one item, or its title, sub and summary.
  assert.deepEqual({ ...shells.phone }, { title: 'Shells', tag: '', meta: '2 running', line: 'npm run dev · npm test -- --watch',
    steps: null, tone: 'live', pulse: true, mono: false });
  assert.equal(agents.phone.line, 'Explore rail tests · 1 done');
  assert.deepEqual([workflows.phone.title, workflows.phone.tag, workflows.phone.meta], ['release-check', 'WORKFLOW', 'step 3 / 5']);
  assert.equal(workflows.phone.steps.length, 5);
  assert.equal(monitors.phone.meta, '2 watching');
  assert.equal(queueCat.phone.line, 'Also update the README screenshot');
});

test('categories: the queue chip never pulses; a task chip pulses only while Claude works on it', () => {
  const { m, queue } = finalFixture();
  const working = P.categories(m, queue, { now: NOW });
  assert.deepEqual(working.map((c) => c.pulse), [true, true, true, true, false]);
  assert.equal(working.at(-1).rows.some((r) => r.pulse), false);

  const idle = finalFixture();
  idle.m.conversations.set('c1', S.normalizeConversation(conv({ state: 'idle' })));
  const still = P.categories(idle.m, idle.queue, { now: NOW });
  assert.deepEqual(still.map((c) => c.pulse), [false, false, false, false, false], 'motion means Claude is at it');
  assert.equal(still[0].rows[0].actions[1].confirm.text, 'Kill npm run dev? Claude stops it with TaskStop.');
});

test('categories: empty ones are omitted; a finished one reads `agents · 1 done`, a failed one `shells · 1 failed`', () => {
  const none = P.categories(mirror(), { items: [], count: 0 }, { now: NOW });
  assert.deepEqual(none, [], 'nothing to show, no chip');
  assert.deepEqual(P.categories(mirror(), null, { now: NOW }), []);

  const m = mirror({ tasks: [
    { id: 'a2', conversation_id: 'c1', kind: 'agent', title: 'Audit CSS tokens', status: 'done', ended_at: NOW - min(4) },
    { id: 'b9', conversation_id: 'c1', kind: 'shell', title: 'npm run build', status: 'failed', exit_code: 2, ended_at: NOW - min(40) },
    { id: 'b8', conversation_id: 'c1', kind: 'shell', title: 'npm run lint', status: 'done', exit_code: 0, ended_at: NOW - min(16) },
    { id: 'k7', conversation_id: 'c1', kind: 'shell', title: 'tail log', status: 'killed', stopped_by: 'claude', ended_at: NOW - min(1) },
  ] });
  const cats = P.categories(m, null, { now: NOW });
  assert.deepEqual(cats.map((c) => c.cat), ['shells', 'agents']);
  const [shells, agents] = cats;
  assert.equal(agents.label, 'agents · 1 done');
  assert.equal(agents.tone, 'muted');
  assert.equal(shells.label, 'shells · 1 failed');
  assert.equal(shells.tone, 'failed');
  assert.deepEqual(shells.rows.map((r) => r.id), ['k7', 'b9'], 'a finished row goes 15 minutes after it ended; a failure stays');
  assert.deepEqual(shells.rows.map((r) => r.meta), ['killed by Claude · 1m ago', 'exit 2 · 40m ago']);
  assert.deepEqual(shells.rows.map((r) => labelsOf(r.actions)), [['Output'], ['Output']], 'nothing to stop on a finished row');
  assert.equal(P.runningCount(m, { now: NOW }), 0);

  m.seen.add('b9');
  assert.deepEqual(P.categories(m, null, { now: NOW })[0].rows.map((r) => r.id), ['k7'], 'seen, the old failure goes too');
});

test('categories: actions follow the capabilities and the level; below read, counts only', () => {
  const { m, queue } = finalFixture();
  m.capabilities = S.normalizeCapabilities({});
  let cats = P.categories(m, queue, { now: NOW });
  assert.deepEqual(labelsOf(cats[0].rows[0].actions), ['Output'], 'no task_stop yet (tranche 4): no Kill');
  assert.deepEqual(labelsOf(cats.at(-1).rows[0].actions), ['Remove'], 'no queue_message: no Edit or Send now');

  m.capabilities = S.normalizeCapabilities({ task_stop: true, queue_message: true });
  m.access = { level: 'read', remote: true };
  cats = P.categories(m, queue, { now: NOW });
  assert.deepEqual(labelsOf(cats[0].rows[0].actions), ['Output'], 'read: watch, never act');
  assert.deepEqual(labelsOf(cats[1].rows[0].actions), ['Open']);
  assert.deepEqual(labelsOf(cats.at(-1).rows[0].actions), []);

  const basic = mirror({ level: 'basic', remote: true, status: [
    { id: 'c1', state: 'working', counts: { shells: 2, agents: 1, workflows: 0, monitors: 2 } },
    { id: 'c2', state: 'idle', counts: { shells: 1 } },
  ] });
  cats = P.categories(basic, queue, { now: NOW });
  assert.deepEqual(cats.map((c) => c.label), ['3 shells', '1 agent', '2 monitors', 'queue 2']);
  assert.deepEqual(cats.map((c) => c.hidden), [true, true, true, false]);
  assert.ok(cats.slice(0, 3).every((c) => c.rows.length === 0 && c.phone.line === ''), 'no rows, no lines: counts only');
  assert.equal(P.runningCount(basic, { now: NOW }), 6);
});

// ── announce ─────────────────────────────────────────────────────────────────

test('announce: the four transitions only, at most once per 2 s, never for suspended', () => {
  const s = {
    working: P.uiState(one({ state: 'working', step: { kind: 'Edit', label: 'Edit · x.js', started_at: NOW } }), { now: NOW }),
    question: P.uiState(one({ state: 'question', waiting: { kind: 'question', summary: 'Keep the rail?' } }), { now: NOW }),
    permission: P.uiState(one({ state: 'waiting', waiting: { kind: 'permission', tool: 'Bash', summary: 'Bash(npm test)' } }), { now: NOW }),
    idle: P.uiState(one({ state: 'idle', last_turn: { id: 't', outcome: 'done', ended_at: NOW, code: { files: 1 } } }), { now: NOW }),
    suspended: P.uiState(one({ state: 'suspended' }), { now: NOW }),
    offline: P.uiState(mirror({ conn: 'reconnecting' }), { now: NOW }),
    connecting: P.uiState(mirror({ conn: 'connecting' }), { now: NOW }),
  };
  let at = NOW;
  const say = (prev, next) => P.announce(s[prev], s[next], { now: (at += 5000), gate: P.createAnnounceGate() });

  assert.equal(say('working', 'question'), 'Claude has a question: Keep the rail?');
  assert.equal(say('working', 'permission'), 'Claude needs you: Permission · Bash(npm test)');
  assert.equal(say('working', 'idle'), 'Claude finished — Done · 1 file changed');
  assert.equal(say('working', 'offline'), 'Offline — reconnecting.');
  assert.equal(say('offline', 'working'), 'Back online.');
  assert.equal(say('connecting', 'idle'), null, 'the first connection is not a return');
  for (const [prev, next] of [['idle', 'working'], ['question', 'working'], ['permission', 'working'], ['working', 'working'],
    ['idle', 'idle'], ['question', 'idle'], [null, 'question']]) {
    assert.equal(say(prev, next), null, `${prev} → ${next} is not announced`);
  }
  for (const [prev, next] of [['working', 'suspended'], ['suspended', 'working'], ['suspended', 'question'],
    ['suspended', 'offline'], ['question', 'suspended']]) {
    assert.equal(say(prev, next), null, `${prev} → ${next}: a suspend is never announced, and never as offline`);
  }

  // At most once per 2 s per gate: inside the gap a transition is held, and
  // said later while it is still true.
  const gate = P.createAnnounceGate();
  assert.equal(P.announce(s.working, s.question, { now: NOW, gate }), 'Claude has a question: Keep the rail?');
  assert.equal(P.announce(s.question, s.working, { now: NOW + 500, gate }), null);
  assert.equal(P.announce(s.working, s.permission, { now: NOW + 1000, gate }), null, 'inside the gap');
  assert.equal(P.announce(s.permission, s.permission, { now: NOW + 1500, gate }), null, 'still inside it');
  assert.equal(P.announce(s.permission, s.permission, { now: NOW + 2100, gate }), 'Claude needs you: Permission · Bash(npm test)',
    'held, then said once the gap is over, since it is still true');
  assert.equal(P.announce(s.permission, s.permission, { now: NOW + 5000, gate }), null, 'and only once');
  const gone = P.createAnnounceGate();
  P.announce(s.working, s.question, { now: NOW, gate: gone });
  assert.equal(P.announce(s.working, s.permission, { now: NOW + 1000, gate: gone }), null, 'held');
  assert.equal(P.announce(s.permission, s.working, { now: NOW + 3000, gate: gone }), null,
    'answered meanwhile: a held line no longer true is dropped');
  assert.equal(P.announce(s.working, s.working, { now: NOW + 4000, gate: gone }), null, 'and stays dropped');
  // Gates are per live region: the phone's does not throttle the bar's.
  const bar = P.createAnnounceGate();
  const sheet = P.createAnnounceGate();
  assert.ok(P.announce(s.working, s.question, { now: NOW, gate: bar }));
  assert.ok(P.announce(s.working, s.question, { now: NOW, gate: sheet }));
});

test('announce: a headless conversation, followed by the tab\'s choice, never speaks (§2.2); the socket still does', () => {
  const job = (live) => one(live, {}, { headless: true });
  const working = P.uiState(job({ state: 'working', step: { kind: 'Bash', label: 'Bash · npm run lint', started_at: NOW } }), { now: NOW });
  const done = P.uiState(job({ state: 'idle', last_turn: { id: 't', outcome: 'done', ended_at: NOW, code: { files: 2 } } }), { now: NOW });
  const ended = P.uiState(job({ state: 'ended' }), { now: NOW });
  assert.deepEqual([working.headless, done.headless, ended.headless], [true, true, true]);
  assert.equal(working.text, 'Bash · npm run lint · 0:00', 'worded like any session');
  const offline = P.uiState(mirror({ conn: 'reconnecting' }), { now: NOW });
  assert.equal(offline.headless, false);
  let at = NOW;
  const say = (prev, next) => P.announce(prev, next, { now: (at += 5000), gate: P.createAnnounceGate() });
  assert.equal(say(working, done), null, 'a CI job finishing is not "Claude finished"');
  assert.equal(say(working, ended), null);
  assert.equal(say(working, offline), 'Offline — reconnecting.', 'the surface going offline is still said');
  assert.equal(say(offline, working), 'Back online.');
  const interactive = P.uiState(one({ state: 'working', step: { kind: 'Bash', label: 'Bash · npm run lint', started_at: NOW } }), { now: NOW });
  assert.equal(interactive.headless, false);
  assert.equal(say(interactive, P.uiState(one({ state: 'idle' }), { now: NOW })), 'Claude finished — Idle');
  const basic = P.uiState(mirror({ level: 'basic', status: [{ id: 'c1', state: 'working', counts: {} }] }), { now: NOW });
  assert.equal(basic.headless, false, 'below read nothing says so: the store never follows such a row on its own');
});

// ── queue.js ─────────────────────────────────────────────────────────────────

test('queue.js: queueSnapshot() is what the chips read, announced on the bus at the end of every render()', async (t) => {
  // A rail to draw into that records what render() asked of it — no jsdom.
  const asked = [];
  const rail = { querySelector: (sel) => { asked.push(sel); return null; }, classList: { toggle() {} } };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true,
    value: { getElementById: (id) => (id === 'queue-rail' ? rail : null) } });
  const realFetch = globalThis.fetch;
  const calls = [];
  let answer = { ok: true, body: { items: [] } };
  globalThis.fetch = async (url, init = {}) => {
    calls.push([String(init.method || 'GET'), url, init.body ? JSON.parse(init.body) : null]);
    return { ok: answer.ok, status: answer.ok ? 200 : 403, json: async () => answer.body };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document;
  });

  const queue = await import(appUrl('queue.js'));
  const seen = [];
  t.after(bus.on('queue', (snap) => seen.push({ snap, drawn: asked.length })));

  queue.foldQueueFrame({ op: 'add', item: { id: 'q1', kind: 'signal', summary: 'form_submit', why_wake: 'Apply', enqueued_at: NOW } });
  queue.foldQueueFrame({ op: 'add', item: { id: 'q2', kind: 'capture', summary: 'a page', staged: false, enqueued_at: NOW + 1 } });
  assert.equal(seen.length, 2, 'one announcement per render');
  assert.ok(seen[0].drawn > 0, 'after the rail was drawn');
  const snap = seen.at(-1).snap;
  assert.deepEqual(snap, queue.queueSnapshot());
  assert.equal(snap.count, 2);
  assert.equal(snap.staged, 1);
  assert.equal(snap.held, 1);
  assert.equal(snap.parked, null);
  assert.deepEqual(snap.items.map((it) => [it.id, it.staged]), [['q1', true], ['q2', false]]);
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.items) && Object.isFrozen(snap.items[0]));

  // The chip counts every item, as the rail does, and never pulses.
  const { m } = finalFixture();
  const chip = P.categories(m, snap, { now: NOW }).at(-1);
  assert.deepEqual([chip.label, chip.sub, chip.pulse], ['queue 2', '1 queued · 1 held', false]);
  assert.deepEqual(chip.rows.map((r) => labelsOf(r.actions)), [['Hold', 'Remove'], ['Stage', 'Remove']]);

  // setStaged and removeItem, exported for the trays.
  await queue.setStaged('q2', true);
  assert.deepEqual(calls.at(-1), ['PATCH', '/api/queue/q2', { staged: true }]);
  assert.equal(seen.at(-1).snap.staged, 2);
  assert.equal(await queue.removeItem('q1'), true);
  assert.deepEqual(calls.at(-1), ['DELETE', '/api/queue/q1', null], 'a plain removal: no ?revert=1');
  assert.deepEqual(seen.at(-1).snap.items.map((it) => it.id), ['q2']);

  // A refused removal reads the queue again, so the item comes back.
  answer = { ok: false, body: { ok: false, hint: 'needs full mirror access' } };
  const removing = queue.removeItem('q2');
  answer = { ok: true, body: { items: [{ id: 'q2', kind: 'capture', summary: 'a page', enqueued_at: NOW + 1 }] } };
  assert.equal(await removing, false);
  assert.deepEqual(calls.slice(-2).map((c) => [c[0], c[1]]), [['DELETE', '/api/queue/q2'], ['GET', '/api/queue']]);
  assert.deepEqual(queue.queueSnapshot().items.map((it) => it.id), ['q2']);
});

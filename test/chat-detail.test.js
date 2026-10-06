// The chat's detail views (public/app/chat-detail.js) through the real shell
// (test-support/chrome-shell.js): design spec §7.12, with §7.9's details, §2.10's
// work and code routes, §2.7's diff record, §6.9's Cancel and §8.6's "No longer
// running", as U47's brief puts them.
//
//   * initChatDetail registers 'task' and 'diff' with the panel, never 'turn';
//     chat:open opens them for every id the stream and the tool cards emit.
//   * A shell's 64 KB tail follows live from the route's `to`, under the stuck
//     rule, and every follower stops when its view is popped or the chat closes.
//   * An agent's own transcript: tool cards and chat prose, 'Load earlier',
//     appended live; type and model from the route first, else the stream's
//     Agent call; Cancel only with task_stop at `full`, through the one confirm.
//   * A workflow's phase bar and agents table; a row pushes that agent's view;
//     the route is read again on the row's rev change, at most once per followMs.
//   * Code changes per node or per turn, with every state of the record.
//
// main.js does not start the detail views yet (U51 wires them): the boot's init
// does, with a short followMs so the followers can be watched.
const test = require('node:test');
const { before, after, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');
const { isReservedId } = require('../lib/server/domain/mounts');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const FOLLOW = 40;                          // the boot's followMs
const settle = (ms = FOLLOW * 4) => new Promise((r) => setTimeout(r, ms));
const T = Date.now();
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };

let shell, $, bus, S, panel, dock, detail;
let current = null;            // what GET /api/mirror answers
let rev = 7000;
let streamRev = 100;

// ── the data ────────────────────────────────────────────────────────────────

const conversation = { id: 'c1', rev: 1, title: 'the session', headless: false, counts: ZERO,
  live: { state: 'working', since: T - min(1), last_activity_at: T - 1000 } };
const task = (o) => ({ conversation_id: 'c1', rev: 1, status: 'running', started_at: T - min(2), meta: {}, can: {}, ...o });
const S1 = task({ id: 's1', kind: 'shell', title: 'npm run dev', meta: { port: 5173 }, tool_use_id: 'toolu_s1' });
const S2 = task({ id: 's2', kind: 'shell', title: 'npm test -- --watch' });
const A1 = task({ id: 'a1', kind: 'agent', title: 'Explore the queue rail', meta: { tools: 6 }, tool_use_id: 'toolu_a1' });
const A2 = task({ id: 'a2', kind: 'agent', title: 'Second agent', meta: { tools: 1 } });
const A3 = task({ id: 'a3', kind: 'agent', title: 'Third agent', status: 'done', ended_at: T - min(1) });
const W1 = task({ id: 'w1', kind: 'workflow', title: 'release-check',
  steps: [{ label: 'build', state: 'done' }, { label: 'test', state: 'running' }, { label: 'ship', state: 'pending' }] });
const M1 = task({ id: 'm1', kind: 'monitor', title: 'build errors', meta: { events: 2 } });
const TASKS = [S1, S2, A1, A2, A3, W1, M1];

function snapshot({ tasks = TASKS, level = 'local', caps = {} } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: level !== 'basic', access: { level, remote: false },
    capabilities: caps, primary: 'c1', aggregate: { state: 'working' }, conversations: [conversation], tasks, asks: [] };
}

// The followed stream: one turn holding the Agent call that started a1 and the
// Monitor call that started m1.
const AGENT_CALL = { id: 'toolu_a1', turn_id: 't1', kind: 'tool_call', seq: 2, tool: 'Agent', tool_kind: 'Agent',
  label: 'Agent · Explore the queue rail', status: 'running', links: { agent_id: 'a1' },
  input: { subagent_type: 'Explore', model: 'sonnet', description: 'Explore the queue rail' },
  result: { preview: '**Found** three call sites' } };
const MONITOR_CALL = { id: 'toolu_m1', turn_id: 't1', kind: 'tool_call', seq: 3, tool: 'Monitor', tool_kind: 'Monitor',
  label: 'Monitor · build errors', status: 'done', links: { task_id: 'm1' }, input: { command: 'tail -f build.log' } };
const PAGE = { conversation_id: 'c1', next_before: null, total: 1, rev: 50,
  turns: [{ id: 't1', conversation_id: 'c1', seq: 1, kind: 'prompt', author: 'user', status: 'open', started_at: T - min(3),
    prompt: { preview: 'look at the rail' }, items: [AGENT_CALL, MONITOR_CALL] }] };

// ── the routes ──────────────────────────────────────────────────────────────

const qs = (url) => new URLSearchParams(url.split('?')[1] || '');
const idIn = (url, seg) => decodeURIComponent(url.split('?')[0].split(`/${seg}/`)[1].split('/')[0]);
const NOT_FOUND = () => respond({ ok: false, error: 'not found' }, { status: 404 });

const outputs = {};            // task id → (query) → body
const agents = {};             // agent id → (query) → body
const workflows = {};          // run id → () → body
const diffs = {};              // 'node=…' | 'turn=…' → body

const item = (seq, kind, o = {}) => ({ id: `${o.agent || 'a1'}-i${seq}`, turn_id: 'ta', kind, seq, ...o });

function agentPage(row, items, next_before = null, meta = {}) {
  return { agent: { ...row, meta: { ...row.meta, ...meta } }, items, next_before, rev: 1 };
}

function outputRoute(url) {
  const fn = outputs[idIn(url, 'tasks')];
  return fn ? fn(qs(url)) : NOT_FOUND();
}
function agentRoute(url) {
  const fn = agents[idIn(url, 'agents')];
  return fn ? fn(qs(url)) : NOT_FOUND();
}
function workflowRoute(url) {
  const fn = workflows[idIn(url, 'workflows')];
  return fn ? fn() : NOT_FOUND();
}
function diffRoute(url) {
  const q = qs(url);
  const key = q.has('node') ? `node=${q.get('node')}` : `turn=${q.get('turn')}`;
  return diffs[key] || NOT_FOUND();
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function show(over = {}) {
  current = snapshot(over);
  await shell.frame(helloFrame());
  await shell.tick();
  await waitUntil(() => S.mirror.rev >= current.rev, { timeout: 2000, what: 'the snapshot' });
  await shell.tick();
}

async function open(d) {
  bus.emit('chat:open', d);
  await shell.tick();
  await shell.tick();
}
const views = () => [...$('chat-detail').querySelectorAll('.cp-dview')];
const top = () => views().filter((v) => !v.hidden).pop() || null;
const body = () => top() && top().querySelector('.cp-dbody');
const title = () => top() && top().querySelector('.cp-dtitle').textContent;
const q = (sel) => body() && body().querySelector(sel);
const qa = (sel) => (body() ? [...body().querySelectorAll(sel)] : []);
const calls = (part) => shell.calls.filter((c) => c.url.includes(part));
async function popAll() {
  await open({ view: 'chat' });
  assert.equal(views().length, 0, 'every view popped');
}
async function frame(msg) {
  await shell.frame(msg);
  await shell.tick();
}
const update = (tasks, extra = {}) => frame({ type: 'mirror:update', rev: ++rev, now: T, conversation_id: 'c1', tasks, ...extra });

before(async () => {
  shell = await bootShell({
    routes: {
      '/api/mirror': () => current,
      '/api/mirror/conversations/*': () => ({ ...PAGE, rev: ++streamRev }),
      '/api/mirror/tasks/*': outputRoute,
      '/api/mirror/agents/*': agentRoute,
      '/api/mirror/workflows/*': workflowRoute,
      '/api/mirror/diff': diffRoute,
      '/api/mirror/items/*': () => ({ id: 'x', field: 'result', text: '', from: 0, to: 0, total: 0, eof: true }),
      '/api/queue/task-stop': () => ({ ok: true }),
    },
    init: async (sh) => {
      detail = await sh.importApp('chat-detail.js');
      assert.equal(detail.initChatDetail({ followMs: FOLLOW }), true);
      assert.equal(detail.initChatDetail({ followMs: FOLLOW }), true, 'idempotent');
    },
  });
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  panel = await shell.importApp('chat-panel.js');
  dock = await shell.importApp('chat-dock.js');
  $ = shell.$;
  await show();
  // The chat open, and the followed stream read.
  await open({ view: 'chat' });
  await waitUntil(() => S.mirror.stream.turns.length > 0, { what: 'the followed stream' });
});

after(() => shell.restore());

afterEach(async () => {
  if (!dock.isChatOpen()) await open({ view: 'chat' });
  if (views().length) await popAll();
});

/* ── registration ─────────────────────────────────────────────────────────── */

test('initChatDetail registers \'task\' and \'diff\' with the panel, and not \'turn\'', () => {
  assert.equal(panel.hasDetail('task'), true);
  assert.equal(panel.hasDetail('diff'), true);
  assert.equal(panel.hasDetail('turn'), false, 'nothing emits a turn view in 0.8.5');
  assert.deepEqual([...detail.KINDS], ['task', 'diff']);
});

/* ── a shell ──────────────────────────────────────────────────────────────── */

test('a running shell opens with GET …/output?tail=65536, follows from the answer\'s `to`, shows the footer; ‹ Chat stops the follower', async () => {
  outputs.s1 = (p) => {
    if (p.get('tail') === '65536') return { task_id: 's1', text: 'line1\n', from: 0, to: 6, size: 6, eof: true, ended: false, footer: '' };
    if (p.get('from') === '6') return { task_id: 's1', text: 'line2\n', from: 6, to: 12, size: 12, eof: true, ended: false, footer: 'still running' };
    return { task_id: 's1', text: '', from: 12, to: 12, size: 12, eof: true, ended: false, footer: 'still running' };
  };
  const n = calls('/api/mirror/tasks/s1/output').length;
  await open({ view: 'task', id: 's1' });
  assert.equal(views().length, 1, 'the task view is pushed');
  assert.equal(top().dataset.kind, 'task');
  assert.equal(title(), 'Shell · npm run dev');
  assert.ok(q('.dv-title').classList.contains('dv-mono'), 'the shell\'s title is mono');
  assert.match(q('.dv-status').textContent, /^running 2:0\d$/, 'a running clock');
  assert.ok(qa('.dv-part').some((p) => p.textContent === ':5173'), 'and its port');
  const mine = () => calls('/api/mirror/tasks/s1/output').slice(n);
  await waitUntil(() => q('.dv-out').textContent === 'line1\nline2\n', { what: 'the tail, then what followed it' });
  assert.match(mine()[0].url, /\?tail=65536$/, 'the first read is the 64 KB tail');
  assert.match(mine()[1].url, /\?from=6$/, 'then from the answer\'s `to`');
  assert.equal(q('.dv-footer').textContent, 'still running');
  assert.equal(q('.dv-footer').hidden, false);

  shell.click(top().querySelector('.cp-back'));
  assert.equal(views().length, 0, '‹ Chat popped it');
  const after = mine().length;
  await settle();
  assert.equal(mine().length, after, 'no request after the pop');
  assert.equal(detail.openViews(), 0);
});

test('the stuck rule: within 48 px of the bottom new output scrolls into view; scrolled up it does not', async () => {
  let to = 0;
  outputs.s1 = (p) => {
    const from = p.has('from') ? Number(p.get('from')) : 0;
    to = from + 4;
    return { task_id: 's1', text: 'abc\n', from, to, size: to, eof: true, ended: false, footer: '' };
  };
  await open({ view: 'task', id: 's1' });
  await waitUntil(() => q('.dv-out').textContent.length >= 4, { what: 'the first answer' });
  const m = shell.scrollMetrics(body(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 790 });
  const seen = q('.dv-out').textContent.length;
  await waitUntil(() => q('.dv-out').textContent.length > seen, { what: 'more output' });
  assert.equal(body().scrollTop, 1000, 'stuck (10 px from the bottom): scrolled to the new end');
  m.scrollHeight = 2000;
  body().scrollTop = 100;
  const seen2 = q('.dv-out').textContent.length;
  await waitUntil(() => q('.dv-out').textContent.length > seen2, { what: 'more output' });
  assert.equal(body().scrollTop, 100, 'scrolled up: left where the user put it');
  void to;
});

test('the tail is trimmed to the last 64 KB', async () => {
  const big = `${'x'.repeat(detail.TAIL_BYTES)}\n`;
  outputs.s1 = (p) => (p.has('tail')
    ? { task_id: 's1', text: big, from: 0, to: big.length, size: big.length, eof: true, ended: false, footer: '' }
    : { task_id: 's1', text: 'tail end\n', from: big.length, to: big.length + 9, size: big.length + 9, eof: true, ended: true, footer: '[exit 0]' });
  await open({ view: 'task', id: 's1' });
  await waitUntil(() => q('.dv-out').textContent.endsWith('tail end\n'), { what: 'the appended end' });
  assert.equal(q('.dv-out').textContent.length, detail.TAIL_BYTES);
  assert.equal(q('.dv-footer').textContent, '[exit 0]');
});

test('the chat closing stops the follower; opening it again resumes from where it was', async () => {
  outputs.s1 = (p) => {
    const from = p.has('from') ? Number(p.get('from')) : 0;
    return { task_id: 's1', text: 'tick\n', from, to: from + 5, size: from + 5, eof: true, ended: false, footer: '' };
  };
  await open({ view: 'task', id: 's1' });
  const mine = () => calls('/api/mirror/tasks/s1/output');
  const n0 = mine().length;
  await waitUntil(() => mine().length >= n0 + 2, { what: 'the follower running' });
  dock.closeChat({ returnFocus: false });
  await shell.tick();
  await settle(FOLLOW * 2);
  const closedAt = mine().length;
  await settle();
  assert.equal(mine().length, closedAt, 'no request while the chat is closed');
  assert.equal(views().length, 1, 'the view itself is still on the stack');
  await open({});   // the chat shows again, on the view it left
  await waitUntil(() => mine().length > closedAt, { what: 'the follower resuming' });
  assert.match(mine()[closedAt].url, /\?from=\d+$/, 'from the last `to`, not a fresh tail');
});

/* ── resolving the id ─────────────────────────────────────────────────────── */

test('the task id resolves by a row\'s id and by its tool_use_id', async () => {
  outputs.s1 = () => ({ task_id: 's1', text: 'x\n', from: 0, to: 2, size: 2, eof: true, ended: true, footer: '' });
  await open({ view: 'task', id: 'toolu_s1' });
  assert.equal(title(), 'Shell · npm run dev', 'the row whose tool_use_id it is');
  await waitUntil(() => q('.dv-out').textContent === 'x\n', { what: 'its output' });
});

test('with no row the id is probed at /api/mirror/agents/:id, then /api/mirror/workflows/:id; none answering is "no longer tracked"', async () => {
  const before = shell.calls.length;
  await open({ view: 'task', id: 'gone1' });
  await waitUntil(() => q('.dv-untracked'), { what: 'the untracked line' });
  assert.equal(q('.dv-untracked').textContent, 'This task is no longer tracked.');
  const asked = shell.calls.slice(before).map((c) => c.url).filter((u) => u.includes('gone1'));
  assert.deepEqual(asked, ['/api/mirror/agents/gone1', '/api/mirror/workflows/gone1'], 'agents first, then workflows');
  await popAll();

  // A workflow's runId: no row has it, the agents route does not know it, the workflow route does.
  workflows['run-7'] = () => ({ workflow: { ...W1, id: 'w9', title: 'nightly' }, phases: [{ title: 'only', state: 'running' }],
    agents: [], rev: 1 });
  await open({ view: 'task', id: 'run-7' });
  await waitUntil(() => title() === 'Workflow · nightly', { what: 'the workflow view' });
  assert.ok(q('.dv-phases'));
  await popAll();

  // An agent no row holds: the probe's answer is its first page.
  agents.wa9 = () => agentPage(task({ id: 'wa9', kind: 'agent', title: 'probe agent', status: 'done', ended_at: T }),
    [item(1, 'reply', { agent: 'wa9', text: 'hello from the probe' })]);
  const n = calls('/api/mirror/agents/wa9').length;
  await open({ view: 'task', id: 'wa9' });
  await waitUntil(() => title() === 'Agent · probe agent', { what: 'the agent view' });
  assert.match(q('.dv-items').textContent, /hello from the probe/);
  assert.equal(calls('/api/mirror/agents/wa9').length, n + 1, 'the probe is the first page: no second read of a finished agent');
});

/* ── an agent ─────────────────────────────────────────────────────────────── */

function a1Routes() {
  let followed = 0;
  agents.a1 = (p) => {
    if (p.has('before')) {
      return { agent: A1, items: [item(0.5, 'reply', { text: 'an earlier word' })], next_before: null, rev: 1 };
    }
    if (p.has('after')) {
      followed += 1;
      return followed === 1
        ? { agent: A1, items: [item(5, 'reply', { text: 'a new **item**' })], next_before: null, rev: 1 }
        : { agent: A1, items: [], next_before: null, rev: 1 };
    }
    return agentPage(A1, [
      item(1, 'prompt', { text: 'Look at the rail' }),
      item(2, 'thinking', { text: 'hmm', duration_ms: 3000 }),
      item(3, 'tool_call', { tool: 'Read', tool_kind: 'Read', label: 'Read · app.css', status: 'done', result: { preview: 'abc', bytes: 3 } }),
      item(4, 'text', { text: 'Some **prose** here' }),
    ], 1);
  };
}

test('agent: the newest page renders tool cards and chat prose in a .md-chat with no .md-block ancestor; the prompt collapsed; thinking as a Thought row', async () => {
  a1Routes();
  await open({ view: 'task', id: 'a1' });
  assert.equal(title(), 'Agent · Explore the queue rail');
  await waitUntil(() => q('details.tc'), { what: 'the tool card' });
  const card = q('.dv-items details.tc');
  assert.ok(card, 'a tool card from chat-tools.js');
  assert.match(card.querySelector('.tc-label').textContent, /Read · app\.css/);
  const prose = qa('.dv-items .md-chat');
  assert.ok(prose.length >= 1, 'chat prose');
  assert.ok(prose.some((p) => p.querySelector('strong') && p.querySelector('strong').textContent === 'prose'), 'a text item read as chat markdown');
  for (const p of qa('.md-chat')) assert.equal(p.closest('.md-block'), null, 'never inside a page .md-block');
  const prompt = q('details.dv-prompt');
  assert.ok(prompt && !prompt.hidden && !prompt.open, 'the prompt, collapsed');
  assert.match(prompt.textContent, /Look at the rail/);
  assert.ok(!q('.dv-items').textContent.includes('Look at the rail'), 'and not again among the items');
  const think = q('details.dv-think');
  assert.ok(think && !think.open);
  assert.equal(think.querySelector('summary').textContent, 'Thought for 3 s');
  assert.match(q('.dv-status').textContent, /^running$/);
  assert.equal(q('.dv-tools').textContent, '6 tools');
  assert.match(q('.dv-elapsed').textContent, /^2:0\d$/);
});

test('agent: "Load earlier" asks before=next_before and prepends; while it runs followAgentItems appends a new item', async () => {
  a1Routes();
  const n = calls('/api/mirror/agents/a1').length;
  await open({ view: 'task', id: 'a1' });
  await waitUntil(() => /a new/.test(q('.dv-items').textContent), { what: 'the followed item' });
  const mine = calls('/api/mirror/agents/a1').slice(n).map((c) => c.url);
  assert.equal(mine[0], '/api/mirror/agents/a1', 'the newest page');
  assert.equal(mine[1], '/api/mirror/agents/a1?after=4', 'then after the highest seq shown');
  const items = [...q('.dv-items').children];
  assert.match(items[items.length - 1].textContent, /a new item/, 'appended at the end');
  const earlier = q('.dv-earlier');
  assert.equal(earlier.hidden, false);
  shell.click(earlier);
  await waitUntil(() => /an earlier word/.test(q('.dv-items').textContent), { what: 'the earlier page' });
  assert.ok(calls('/api/mirror/agents/a1?before=1').length >= 1, 'before=next_before');
  assert.match(q('.dv-items').firstElementChild.textContent, /an earlier word/, 'prepended');
  assert.equal(q('.dv-earlier').hidden, true, 'no more pages');
});

test('agent: type and model from the followed stream\'s Agent call, absent when neither source has them, the route\'s meta first', async () => {
  a1Routes();
  await open({ view: 'task', id: 'a1' });
  await waitUntil(() => q('.dv-type'), { what: 'the type' });
  assert.equal(q('.dv-type').textContent, 'Explore');
  assert.equal(q('.dv-model').textContent, 'sonnet');
  await popAll();

  agents.a2 = () => agentPage(A2, [item(1, 'reply', { agent: 'a2', text: 'two' })]);
  await open({ view: 'task', id: 'a2' });
  await waitUntil(() => /two/.test(q('.dv-items').textContent), { what: 'a2\'s page' });
  assert.equal(q('.dv-type'), null, 'no type: the stream holds no Agent call for a2 and the route says none');
  assert.equal(q('.dv-model'), null);
  await popAll();

  agents.a3 = () => agentPage(A3, [item(1, 'reply', { agent: 'a3', text: 'three' })], null,
    { agent_type: 'Plan', model: 'opus' });
  await open({ view: 'task', id: 'a3' });
  await waitUntil(() => q('.dv-type'), { what: 'the route\'s meta' });
  assert.equal(q('.dv-type').textContent, 'Plan', 'U42\'s meta keys on the route\'s answer');
  assert.equal(q('.dv-model').textContent, 'opus');
});

test('agent: once done, its result as chat markdown', async () => {
  a1Routes();
  await open({ view: 'task', id: 'a1' });
  await waitUntil(() => q('details.tc'), { what: 'the page' });
  assert.equal(q('.dv-result').hidden, true, 'running: no result yet');
  await update([{ ...A1, rev: 2, status: 'done', ended_at: T }]);
  await waitUntil(() => !q('.dv-result').hidden, { what: 'the result' });
  const md = q('.dv-result .md-chat');
  assert.ok(md && md.querySelector('strong').textContent === 'Found');
  assert.equal(md.closest('.md-block'), null);
  await update([{ ...A1, rev: 3, status: 'running', ended_at: undefined }]);
});

test('agent: Cancel shows only with capabilities.task_stop at `full`, and posts the task-stop route after its confirm', async () => {
  a1Routes();
  await show({ caps: {} });
  await open({ view: 'task', id: 'a1' });
  await waitUntil(() => q('details.tc'), { what: 'the page' });
  assert.equal(q('.dv-cancel'), null, 'no task_stop: no Cancel');
  await show({ caps: { task_stop: true }, level: 'read' });
  assert.equal(q('.dv-cancel'), null, 'task_stop at read: no Cancel');
  await show({ caps: { task_stop: true }, level: 'full' });
  await waitUntil(() => q('.dv-cancel'), { what: 'Cancel' });
  const cancel = q('.dv-cancel');
  assert.equal(cancel.textContent, 'Cancel');
  const posts = () => shell.calls.filter((c) => c.url === '/api/queue/task-stop' && c.method === 'POST');
  const n = posts().length;
  shell.click(cancel);
  const box = q('.cs-row-confirm');
  assert.ok(box, 'the one confirm, inline');
  assert.match(box.querySelector('.cs-confirm-text').textContent, /^Cancel Explore the queue rail\? Claude stops it with TaskStop/);
  assert.equal(posts().length, n, 'nothing posted before the confirm');
  shell.click(box.querySelector('.cs-confirm-yes'));
  await waitUntil(() => posts().length === n + 1, { what: 'the stop request' });
  assert.deepEqual(posts()[n].body, { task_id: 'a1' });
  assert.equal(q('.dv-cancel'), null, 'stopping: Cancel is gone');
  assert.equal(q('.dv-status').textContent, 'stopping…');
  await show();
});

/* ── a workflow ───────────────────────────────────────────────────────────── */

function w1Route() {
  workflows.w1 = () => ({ workflow: W1, phases: [{ title: 'build', state: 'done' }],
    agents: [
      { agent_id: 'wa1', key: 'k1', label: 'lint', phase: 'test', state: 'running', attempt: 1, tools: 3, last_tool: 'Bash',
        model: 'haiku', started_at: T - min(1) },
      { agent_id: 'wa2', key: 'k2', label: 'unit', phase: 'test', state: 'done', attempt: 1, tools: 9, last_tool: 'Read',
        model: 'haiku', started_at: T - min(2), ended_at: T - min(1) },
    ], rev: 1 });
}

test('workflow: the phase bar from the row\'s steps, then the agents table; a row pushes that agent\'s view on the stack', async () => {
  w1Route();
  agents.wa1 = () => agentPage(task({ id: 'wa1', kind: 'agent', title: 'lint' }), [item(1, 'reply', { agent: 'wa1', text: 'linting' })]);
  await open({ view: 'task', id: 'w1' });
  assert.equal(title(), 'Workflow · release-check');
  const segs = qa('.dv-phases .dv-phase');
  assert.deepEqual(segs.map((s) => s.dataset.state), ['done', 'running', 'pending'], 'the row\'s steps, not the route\'s phases');
  assert.equal(q('.dv-phase-line').textContent, 'test · running');
  await waitUntil(() => qa('.dv-agents tbody tr').length === 2, { what: 'the agents table' });
  assert.deepEqual([...q('.dv-agents thead tr').children].map((th) => th.textContent), ['Agent', 'Phase', 'State', 'Last tool', 'Elapsed']);
  const first = [...qa('.dv-agents tbody tr')[0].children].map((td) => td.textContent);
  assert.deepEqual(first.slice(0, 4), ['lint', 'test', 'running', 'Bash']);
  assert.match(first[4], /^1:0\d$/);
  assert.equal(qa('.dv-agents tbody tr')[1].children[4].textContent, '1:00', 'a finished agent: started to ended');

  shell.click(qa('.dv-agents tbody tr')[0].querySelector('.dv-agent-open'));
  await shell.tick();
  assert.equal(views().length, 2, 'pushed on the stack');
  assert.equal(views()[0].hidden, true, 'the workflow under it');
  await waitUntil(() => title() === 'Agent · lint', { what: 'the agent view' });
  shell.click(top().querySelector('.cp-back'));
  assert.equal(views().length, 1);
  assert.equal(title(), 'Workflow · release-check', 'back on the workflow');
});

test('workflow: a store row whose rev changes refetches the detail, at most once per followMs', async () => {
  const WINDOW = 300;   // a window wide enough that a burst lands inside it on any machine
  detail.initChatDetail({ followMs: WINDOW });
  const at = [];
  w1Route();
  const answer = workflows.w1;
  workflows.w1 = () => { at.push(Date.now()); return answer(); };
  try {
    await open({ view: 'task', id: 'w1' });
    await waitUntil(() => at.length === 1, { what: 'the first read' });
    // A burst of three changes inside the window: one read, at the window's end.
    await update([{ ...W1, rev: 2 }]);
    await update([{ ...W1, rev: 3 }]);
    await update([{ ...W1, rev: 4 }]);
    assert.equal(at.length, 1, 'nothing read inside the window');
    await waitUntil(() => at.length === 2, { timeout: 3000, what: 'the burst\'s one read' });
    assert.ok(at[1] - at[0] >= WINDOW - 10, `the second read waited for the window (${at[1] - at[0]} ms)`);
    await settle(WINDOW + 100);
    assert.equal(at.length, 2, 'one read for the whole burst');
    // The same rev again is no change.
    await update([{ ...W1, rev: 4, line: 'same rev' }]);
    await settle(WINDOW + 100);
    assert.equal(at.length, 2, 'an unchanged rev reads nothing');
    // Past the window, a change reads at once.
    await update([{ ...W1, rev: 5 }]);
    await waitUntil(() => at.length === 3, { what: 'the next change' });
  } finally {
    detail.initChatDetail({ followMs: FOLLOW });
  }
});

/* ── a monitor ────────────────────────────────────────────────────────────── */

test('monitor: its events tail through followTaskOutput; its command from the Monitor call in the stream', async () => {
  outputs.m1 = (p) => (p.has('tail')
    ? { task_id: 'm1', text: 'error: one\nerror: two\n', from: 0, to: 22, size: 22, eof: true, ended: false, footer: '' }
    : { task_id: 'm1', text: '', from: 22, to: 22, size: 22, eof: true, ended: false, footer: '' });
  const n = calls('/api/mirror/tasks/m1/output').length;
  await open({ view: 'task', id: 'm1' });
  assert.equal(title(), 'Monitor · build errors');
  await waitUntil(() => q('.dv-events').textContent === 'error: one\nerror: two\n', { what: 'the events' });
  assert.match(calls('/api/mirror/tasks/m1/output')[n].url, /\?tail=65536$/);
  assert.equal(q('.dv-cmd').textContent, '$ tail -f build.log');
  assert.equal(q('.dv-status').textContent, '2 events', 'its status, worded as the tray words it');
});

/* ── a row that leaves the store ──────────────────────────────────────────── */

test('a row removed from the store while its view is open keeps the content under "No longer running", and its follower stops', async () => {
  outputs.s2 = (p) => {
    const from = p.has('from') ? Number(p.get('from')) : 0;
    return { task_id: 's2', text: from ? '' : 'passing\n', from, to: 8, size: 8, eof: true, ended: false, footer: '' };
  };
  await open({ view: 'task', id: 's2' });
  await waitUntil(() => q('.dv-out').textContent === 'passing\n', { what: 'the output' });
  await update([], { removed_tasks: ['s2'] });
  await waitUntil(() => q('.dv-gone'), { what: 'the banner' });
  assert.equal(q('.dv-gone').textContent, 'No longer running');
  assert.equal(body().firstElementChild, q('.dv-gone'), 'above the content');
  assert.equal(q('.dv-out').textContent, 'passing\n', 'the last content is kept');
  assert.equal(q('.dv-title').textContent, 'npm test -- --watch');
  const at = calls('/api/mirror/tasks/s2/output').length;
  await settle();
  assert.equal(calls('/api/mirror/tasks/s2/output').length, at, 'no more reads');
  await show();
});

/* ── code changes ─────────────────────────────────────────────────────────── */

const PATCH = [
  'diff --git a/lib/core/paths.js b/lib/core/paths.js',
  'index 1111111..2222222 100644',
  '--- a/lib/core/paths.js',
  '+++ b/lib/core/paths.js',
  '@@ -1,2 +1,3 @@',
  ' a',
  '-b',
  '+c',
  '+d',
  'diff --git a/img.png b/img.png',
  'index 3333333..4444444 100644',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/big.js b/big.js',
  '--- a/big.js',
  '+++ b/big.js',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n');

const COMBINED = {
  before: { tree: 'a'.repeat(40) }, after: { tree: 'b'.repeat(40) },
  files: [
    { path: 'lib/core/paths.js', status: 'M', additions: 2, deletions: 1, binary: false },
    { path: 'img.png', status: 'M', additions: 0, deletions: 0, binary: true },
    { path: '.env', status: 'M', additions: 1, deletions: 1, binary: false, withheld: 'sensitive' },
    { path: 'big.js', status: 'M', additions: 1000, deletions: 204, binary: false, truncated: true },
    { path: 'cut.js', status: 'A', additions: 7, deletions: 0, binary: false },
  ],
  totals: { files: 5, additions: 1010, deletions: 206 },
  patch: PATCH,
  patch_truncated: true,
};

test('diff by node: one <details> per file with its +/- counts and renderDiff lines; the binary, withheld, truncated and patch_truncated states', async () => {
  diffs['node=n1'] = { node: { id: 'n1', label: 'n1.14' }, turns: [], combined: COMBINED };
  await open({ view: 'diff', node_id: 'n1' });
  await waitUntil(() => q('.dv-file'), { what: 'the files' });
  assert.equal(calls('/api/mirror/diff?node=n1').length >= 1, true);
  assert.equal(title(), 'Changes · n1.14 · 5 files +1,010 −206');
  const files = qa('details.dv-file');
  assert.equal(files.length, 5, 'one <details> per file');
  const head = (f) => [...f.querySelector('summary').children].map((s) => s.textContent);
  assert.deepEqual(head(files[0]), ['M', 'lib/core/paths.js', '+2', '−1']);
  const lines = files[0].querySelector('pre.md-diff');
  assert.ok(lines.querySelector('span.dl-add') && lines.querySelector('span.dl-del'), 'renderDiff spans');
  assert.deepEqual([...lines.querySelectorAll('span.dl-add')].map((s) => s.textContent), ['+c', '+d']);
  assert.ok(!lines.textContent.includes('img.png'), 'only that file\'s section');

  assert.equal(files[1].dataset.state, 'binary');
  assert.equal(files[1].querySelector('.dv-file-body').textContent, 'binary file');
  assert.equal(files[2].dataset.state, 'withheld');
  assert.equal(files[2].querySelector('.dv-file-body').textContent, 'contents hidden');
  assert.equal(files[2].querySelector('pre'), null, 'nothing of a withheld file is drawn');
  assert.equal(files[3].dataset.state, 'truncated');
  const tl = files[3].querySelector('.dv-state');
  assert.equal(tl.textContent, 'too large — 1,204 lines (show)');
  const sent = files[3].querySelector('pre.md-diff');
  assert.equal(sent.hidden, true, 'what was sent waits behind show');
  shell.click(tl.querySelector('.dv-show'));
  assert.equal(sent.hidden, false, 'show reveals it');
  assert.equal(files[4].dataset.state, 'missing');
  assert.equal(q('.dv-truncated').textContent, 'diff truncated — 1 more file');
  for (const f of files) assert.equal(f.open, false, 'collapsed');
});

test('a node whose combined diff is gone lists each turn\'s files with a link that opens {view: \'diff\', id}', async () => {
  diffs['node=n2'] = { node: { id: 'n2', label: 'n1.15' }, combined: null, turns: [
    { v: 1, turn_id: 't1', status: 'ready', files: [{ path: 'a.js', status: 'M', additions: 3, deletions: 1, binary: false }],
      totals: { files: 1, additions: 3, deletions: 1 }, patch_truncated: false },
    { v: 1, turn_id: 'tB', status: 'unavailable', reason: 'not-a-git-repo' },
  ] };
  diffs['turn=t1'] = { v: 1, turn_id: 't1', status: 'ready',
    files: [{ path: 'a.js', status: 'M', additions: 3, deletions: 1, binary: false }], totals: { files: 1, additions: 3, deletions: 1 },
    patch: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,3 @@\n-x\n+y\n+z\n+w\n', patch_truncated: false };
  const opened = [];
  const off = bus.on('chat:open', (d) => opened.push(d));
  try {
    await open({ view: 'diff', node_id: 'n2' });
    await waitUntil(() => q('.dv-nocombined'), { what: 'the turns list' });
    assert.equal(title(), 'Changes · n1.15');
    assert.equal(q('.dv-nocombined').textContent, 'the combined diff is no longer available');
    const turns = qa('.dv-turn');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].querySelector('.dv-turn-name').textContent, 'look at the rail', 'named by its prompt in the stream');
    assert.deepEqual([...turns[0].querySelector('.dv-turn-file').children].map((s) => s.textContent), ['M', 'a.js', '+3', '−1']);
    assert.match(turns[1].textContent, /not-a-git-repo/);
    shell.click(turns[0].querySelector('.dv-turn-open'));
    assert.deepEqual(opened.pop(), { view: 'diff', id: 't1' });
    await shell.tick();
    await shell.tick();
    assert.equal(views().length, 2, 'the turn\'s own diff pushed on the stack');
    await waitUntil(() => q('.dv-file'), { what: 'the turn diff' });
    assert.equal(title(), 'Changes · this turn');
    assert.ok(calls('/api/mirror/diff?turn=t1').length >= 1, 'from ?turn=');
    assert.equal(q('.dv-totals').textContent, '1 file +3 −1');
    assert.equal(qa('.dv-file pre.md-diff span.dl-add').length, 3);
  } finally {
    off();
  }
});

test('a turn\'s own diff from ?turn=, and a record with status \'unavailable\' shows its reason', async () => {
  diffs['turn=tX'] = { v: 1, turn_id: 'tX', status: 'unavailable', reason: 'slow-repo' };
  await open({ view: 'diff', id: 'tX' });
  await waitUntil(() => q('.dv-unavailable'), { what: 'the reason' });
  assert.ok(calls('/api/mirror/diff?turn=tX').length >= 1);
  assert.equal(title(), 'Changes · this turn');
  assert.equal(q('.dv-unavailable').textContent, 'No code diff: slow-repo');
});

/* ── every chat:open the stream and the cards emit opens a view ───────────── */

test('every chat:open the stream and the tool cards emit opens a view: task by its id, tool_use_id, agent id or run id; diff by node_id or id', async () => {
  outputs.s1 = () => ({ task_id: 's1', text: '', from: 0, to: 0, size: 0, eof: true, ended: true, footer: '' });
  a1Routes();
  workflows['run-7'] = () => ({ workflow: { ...W1, id: 'w9', title: 'nightly' }, phases: [], agents: [], rev: 1 });
  diffs['node=n1'] = { node: { id: 'n1', label: 'n1.14' }, turns: [], combined: COMBINED };
  diffs['turn=tX'] = { v: 1, turn_id: 'tX', status: 'unavailable', reason: 'slow-repo' };
  const cases = [
    [{ view: 'task', id: 's1' }, 'Shell · npm run dev'],          // links.task_id / a row's id
    [{ view: 'task', id: 'toolu_s1' }, 'Shell · npm run dev'],    // a row's tool_use_id
    [{ view: 'task', id: 'a1' }, 'Agent · Explore the queue rail'], // links.agent_id
    [{ view: 'task', id: 'run-7' }, 'Workflow · nightly'],        // links.run_id
    [{ view: 'diff', node_id: 'n1' }, /^Changes · n1\.14/],
    [{ view: 'diff', id: 'tX' }, 'Changes · this turn'],
  ];
  for (const [d, want] of cases) {
    await open(d);
    await waitUntil(() => (want instanceof RegExp ? want.test(title() || '') : title() === want), { what: JSON.stringify(d) });
    await popAll();
  }
});

/* ── below read ───────────────────────────────────────────────────────────── */

test('below read every view says the conversation is not shared and fetches nothing', async () => {
  await show({ level: 'basic' });
  try {
    const before = shell.calls.length;
    for (const d of [{ view: 'task', id: 's1' }, { view: 'task', id: 'nothing-held' }, { view: 'diff', node_id: 'n1' },
      { view: 'diff', id: 'tX' }]) {
      await open(d);
      assert.equal(q('.dv-unshared').textContent, 'The conversation is not shared with this viewer.', JSON.stringify(d));
      await popAll();
    }
    await settle();
    const fetched = shell.calls.slice(before).map((c) => c.url)
      .filter((u) => /^\/api\/mirror\/(tasks|agents|workflows|diff)/.test(u));
    assert.deepEqual(fetched, [], 'nothing asked of the work or code routes');
  } finally {
    await show();
  }
});

/* ── ids, CSS ─────────────────────────────────────────────────────────────── */

test('no id outside RESERVED_IDS', async () => {
  a1Routes();
  diffs['node=n1'] = { node: { id: 'n1', label: 'n1.14' }, turns: [], combined: COMBINED };
  await open({ view: 'task', id: 'a1' });
  await open({ view: 'diff', node_id: 'n1' });
  await waitUntil(() => q('.dv-file'), { what: 'the diff' });
  const ids = [...$('chat-detail').querySelectorAll('[id]')].map((e) => e.id)
    .filter((id) => !/^tc-/.test(id));   // nothing; the filter documents that a tool card adds none either
  for (const id of ids) assert.ok(isReservedId(id), `${id} is reserved`);
  assert.deepEqual(ids, [], 'the views add no id at all');
  const src = stripComments(read('public/app/chat-detail.js'));
  assert.doesNotMatch(src, /\.id\s*=[^=]|setAttribute\(\s*['"]id['"]/, 'chat-detail.js sets no id');
});

test('the U47 CSS sits under its own marker: tokens only, every class spelled in chat-detail.js', () => {
  const css = read('public/app.css');
  const start = css.indexOf('/* ── U47 · detail views · chat-detail.js ── */');
  const end = css.indexOf('/* ── U56 ·');
  assert.ok(start > 0 && end > start);
  const mine = css.slice(start, end);
  assert.match(mine, /\n\n$/, 'the blank line before the next marker is kept');
  assert.doesNotMatch(mine, /\n\n\n$/, 'and only one');
  const rules = stripComments(mine);
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b/, 'tokens only, no hex');
  assert.doesNotMatch(rules, /rgba?\(|hsla?\(/, 'no literal colour');
  assert.doesNotMatch(rules, /#[a-z]/i, 'no id selector');
  const js = read('public/app/chat-detail.js');
  const classes = new Set([...rules.matchAll(/\.(dv-[a-z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(classes.size > 10);
  for (const c of classes) assert.ok(js.includes(`'${c}'`) || js.includes(` ${c}'`) || js.includes(`'${c} `), `${c} is spelled in chat-detail.js`);
});

/* ── stopping ─────────────────────────────────────────────────────────────── */

test('stopChatDetail unregisters both kinds, stops every follower and leaves no timer', async () => {
  outputs.s1 = (p) => {
    const from = p.has('from') ? Number(p.get('from')) : 0;
    return { task_id: 's1', text: 'tick\n', from, to: from + 5, size: from + 5, eof: true, ended: false, footer: '' };
  };
  const known = new Set(shell.intervals().map((i) => i.id));
  await open({ view: 'task', id: 's1' });
  const mine = () => calls('/api/mirror/tasks/s1/output');
  const n0 = mine().length;
  await waitUntil(() => mine().length >= n0 + 2, { what: 'the follower running' });
  const added = () => shell.intervals().filter((i) => !known.has(i.id));
  assert.equal(added().length, 1, 'ONE interval: the running clock');
  assert.equal(added()[0].ms, detail.TICK_MS);
  assert.equal(detail.openViews(), 1);

  detail.stopChatDetail();
  assert.equal(panel.hasDetail('task'), false);
  assert.equal(panel.hasDetail('diff'), false);
  assert.equal(added().length, 0, 'the clock is gone');
  assert.equal(detail.openViews(), 0);
  const at = mine().length;
  await settle();
  assert.equal(mine().length, at, 'no read after the stop');
  detail.stopChatDetail();   // a second stop is harmless
  await popAll();
  await open({ view: 'task', id: 's1' });
  assert.equal(views().length, 0, 'unregistered: the chat stays on the stream');
});

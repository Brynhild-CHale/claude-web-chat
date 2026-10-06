// A row and what its buttons do (public/app/chat-rows.js, public/app/chat-actions.js),
// through the real shell: design spec §7.6, §6.9 and §8.6.
//
//   * rowEl builds a row from chat-present's RowModel by textContent only, at
//     the compact or the touch density, with the step bar from `steps`, and a
//     button only for what runAction can perform.
//   * The one follower: followTaskOutput (GET …/output?tail=, then from the
//     answer's `to`, ending once ended and eof, on alive() false, on stop(), or
//     after three failed reads) and followAgentItems (?after=<seq>, advancing,
//     ending once the agent is done and a read brings nothing new).
//   * The one confirm: inline at the compact density (Kill / Keep, Escape
//     reverts), two taps at the touch density (3 s or another tap reverts);
//     a yes posts POST /api/queue/task-stop {task_id} once and the row reads
//     "stopping…"; a refusal's hint shows in the row.
//   * Queue rows: Remove → DELETE /api/queue/:id, Hold / Stage → PATCH {staged}.
//   * Open and "Open full output" emit chat:open {view: 'task', id}.
//
// The rows are drawn into a list of the test's own (the trays' list is
// chat-trays.test.js's), and a click on a row's button reaches runAction as the
// tray's delegation does.
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bootShell, helloFrame, respond } = require('../test-support/chrome-shell');
const { waitUntil } = require('../test-support/helpers');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const codeOf = (rel) => stripComments(read(rel)).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const T = Date.now();
const min = (n) => n * 60000;
const ZERO = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let shell, bus, S, P, Q, A, R;
let doc;
let current = null;
let queueBody = { items: [], count: 0 };
let rev = 2000;
let list = null;   // the test's own list of rows

const shellTask = { id: 's1', kind: 'shell', conversation_id: 'c1', title: 'npm run dev', status: 'running',
  started_at: T - min(14), meta: { port: 5173 }, line: 'ready in 412 ms' };
const agentTask = { id: 'a1', kind: 'agent', conversation_id: 'c1', title: 'Explore the rail', status: 'running',
  started_at: T - min(2), meta: { tools: 6 } };
const workflowTask = { id: 'w1', kind: 'workflow', conversation_id: 'c1', title: 'Release checks', status: 'running',
  started_at: T - min(3), steps: [{ label: 'lint', state: 'done' }, { label: 'test', state: 'running' },
    { label: 'build', state: 'pending' }] };

function snapshot({ level = 'full', caps = { task_stop: true }, tasks = [shellTask, agentTask, workflowTask] } = {}) {
  return { v: 1, enabled: true, now: T, rev: ++rev, content: true, access: { level, remote: false }, capabilities: caps,
    primary: 'c1', aggregate: { state: 'idle' },
    conversations: [{ id: 'c1', rev: 1, title: 'c1', headless: false, counts: ZERO,
      live: { state: 'idle', since: T - min(1) } }],
    tasks, asks: [] };
}

async function show(over = {}, queue = { items: [], count: 0 }) {
  current = snapshot(over);
  queueBody = queue;
  await shell.frame(helloFrame());
  await shell.tick();
  await waitUntil(() => S.mirror.rev >= current.rev, { timeout: 2000 });
  await shell.tick();
}

const cats = () => P.categories(S.mirror, Q.queueSnapshot(), { now: S.serverNow() });
const modelOf = (cat, id) => cats().find((e) => e.cat === cat).rows.find((r) => r.id === id);
// The requests since this test began (shell.calls keeps the whole file's).
let mark = 0;
const calls = (re) => shell.calls.slice(mark).filter((c) => re.test(c.url));
const buttons = (el) => [...el.querySelectorAll('.cs-row-actions button')].map((b) => b.textContent);
const btn = (el, action) => el.querySelector(`.cs-row-actions [data-action="${action}"]`);

// A row of the test's list, its clicks routed as the tray routes them.
function mount(model, density = 'compact') {
  const el = R.rowEl(model, { density });
  list.append(el);
  return el;
}

before(async () => {
  shell = await bootShell({
    routes: { '/api/mirror': () => current, '/api/queue': () => queueBody },
  });
  ({ bus } = await shell.importApp('bus.js'));
  S = await shell.importApp('chat-state.js');
  P = await shell.importApp('chat-present.js');
  Q = await shell.importApp('queue.js');
  A = await shell.importApp('chat-actions.js');
  R = await shell.importApp('chat-rows.js');
  doc = shell.document;
  list = doc.createElement('div');
  list.setAttribute('role', 'list');
  doc.body.append(list);
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b || b.disabled) return;
    const el = b.closest('.cs-row');
    const cat = el.dataset.csCat;
    const model = cats().find((x) => x.cat === cat).rows.find((r) => r.id === el.dataset.rowId);
    A.runAction(model, b.dataset.action, { rowEl: el, density: el.dataset.density, button: b });
  });
  await show();
});

after(() => shell.restore());

beforeEach(() => { mark = shell.calls.length; });

afterEach(() => {
  A.stopFollowers();
  list.replaceChildren();
  shell.setRoutes({});
});

/* ── rowEl ────────────────────────────────────────────────────────────────── */

test('rowEl builds by textContent: a title holding markup renders as text, no element', () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const el = mount({ id: 'x1', kind: 'shell', cat: 'shells', tone: 'live', pulse: false, title: evil, mono: true,
    meta: '<b>1m</b>', steps: [{ label: '<i>step</i>', state: 'done' }], line: '<script>alert(1)</script>', actions: [] });
  assert.equal(el.querySelector('img, b, i, script'), null, 'no element came out of the text');
  assert.equal(el.querySelector('.cs-row-title').textContent, evil);
  assert.equal(el.querySelector('.cs-row-meta').textContent, '<b>1m</b>');
  assert.equal(el.querySelector('.cs-row-line').textContent, '<script>alert(1)</script>');
  assert.equal(shell.window.__pwned, undefined);
  for (const rel of ['public/app/chat-rows.js', 'public/app/chat-actions.js', 'public/app/chat-trays.js']) {
    assert.doesNotMatch(codeOf(rel), /innerHTML|outerHTML|insertAdjacentHTML/, `${rel} builds by textContent`);
  }
});

test('a row: role=listitem, its id and category, the dot\'s tone, the shell title in mono, the meta and line', () => {
  const m = modelOf('shells', 's1');
  const el = mount(m);
  assert.equal(el.getAttribute('role'), 'listitem');
  assert.equal(el.dataset.rowId, 's1');
  assert.equal(el.dataset.csCat, 'shells');
  assert.equal(el.dataset.csTone, 'live');
  assert.ok(el.querySelector('.cs-row-title').classList.contains('cs-mono'), 'a shell\'s title is mono');
  assert.equal(el.querySelector('.cs-row-meta').textContent, m.meta);
  assert.equal(el.querySelector('.cs-row-line').textContent, 'ready in 412 ms');
  assert.deepEqual(buttons(el), m.actions.map((a) => a.label), 'the actions in RowModel order');
  assert.deepEqual(buttons(el), ['Output', 'Kill']);
  assert.equal(btn(el, 'kill').dataset.destructive, 'true', 'Kill draws in the rust ink');
  assert.equal(btn(el, 'output').dataset.destructive, undefined);
  const agent = mount(modelOf('agents', 'a1'));
  assert.ok(!agent.querySelector('.cs-row-title').classList.contains('cs-mono'));
  assert.deepEqual(buttons(agent), ['Open', 'Cancel']);
});

test('compact and touch densities; the touch actions are 40px tall and at least 64px wide', () => {
  const compact = mount(modelOf('shells', 's1'));
  const touch = mount(modelOf('shells', 's1'), 'touch');
  assert.equal(compact.dataset.density, 'compact');
  assert.equal(touch.dataset.density, 'touch');
  const css = stripComments(read('public/app.css'));
  const rule = /\.cs-row\[data-density="touch"\] :is\([^)]*\.cs-row-act[^)]*\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'a touch rule for the actions');
  assert.match(rule[1], /height:\s*40px/);
  assert.match(rule[1], /min-width:\s*64px/);
  assert.match(css, /\.cs-row-act\[data-destructive\][^{]*\{[^}]*var\(--wc-rust\)/, 'the destructive ink is the rust token');
});

test('the step bar comes from steps', () => {
  const el = mount(modelOf('workflows', 'w1'));
  const segs = [...el.querySelectorAll('.cs-row-steps .cs-row-step')];
  assert.deepEqual(segs.map((s) => s.dataset.stepState), ['done', 'running', 'pending']);
  assert.deepEqual(segs.map((s) => s.title), ['lint', 'test', 'build']);
  assert.equal(el.querySelector('.cs-row-meta').textContent, 'step 2 / 3');
  R.updateRow(el, { ...modelOf('workflows', 'w1'), steps: null });
  assert.equal(el.querySelector('.cs-row-steps'), null, 'no steps, no bar');
});

test('\'edit\' and \'send-now\' render no button (U62\'s, tranche 4); Remove does', () => {
  const el = mount({ id: 'm1', kind: 'message', cat: 'queue', tone: 'live', pulse: false, title: 'hello', mono: false,
    meta: 'next', steps: null, line: '', actions: [
      { id: 'edit', label: 'Edit', destructive: false, confirm: null },
      { id: 'send-now', label: 'Send now', destructive: false, confirm: null },
      { id: 'remove', label: 'Remove', destructive: true, confirm: null },
    ] });
  assert.deepEqual(buttons(el), ['Remove']);
  assert.equal(A.canRun('edit', { cat: 'queue' }), false);
  assert.equal(A.canRun('send-now', { cat: 'queue' }), false);
});

test('updateRow refreshes in place: the same element, new text, the actions rebuilt only when they change', () => {
  const m = modelOf('shells', 's1');
  const el = mount(m);
  const kill = btn(el, 'kill');
  R.updateRow(el, { ...m, meta: '15m · :5173', line: 'compiled' });
  assert.equal(el.querySelector('.cs-row-meta').textContent, '15m · :5173');
  assert.equal(el.querySelector('.cs-row-line').textContent, 'compiled');
  assert.equal(btn(el, 'kill'), kill, 'the same buttons');
  R.updateRow(el, { ...m, actions: m.actions.filter((a) => a.id !== 'kill') });
  assert.deepEqual(buttons(el), ['Output']);
});

/* ── followTaskOutput ─────────────────────────────────────────────────────── */

test('followTaskOutput asks with tail, then from the answer\'s `to`, and ends once ended and eof', async () => {
  const answers = [
    { task_id: 's9', text: 'a\n', from: 0, to: 2, size: 2, eof: true, ended: false, footer: '' },
    { task_id: 's9', text: 'b\n', from: 2, to: 4, size: 4, eof: true, ended: false, footer: '' },
    { task_id: 's9', text: '', from: 4, to: 4, size: 4, eof: true, ended: true, footer: '[exited with code 3]', exit_code: 3 },
  ];
  shell.setRoutes({ '/api/mirror/tasks/s9/output*': () => answers.shift() || answers[answers.length - 1] });
  const seen = [];
  A.followTaskOutput('s9', { tail: 16384, intervalMs: 5 }, (o) => seen.push(o));
  await waitUntil(() => seen.length === 3, { timeout: 2000, what: 'three answers' });
  await pause(40);
  const urls = calls(/\/api\/mirror\/tasks\/s9\/output/).map((c) => c.url);
  assert.deepEqual(urls, ['/api/mirror/tasks/s9/output?tail=16384', '/api/mirror/tasks/s9/output?from=2',
    '/api/mirror/tasks/s9/output?from=4'], 'and no read after the end');
  assert.deepEqual(seen.map((o) => o.append), [false, true, true]);
  assert.equal(seen[2].footer, '[exited with code 3]');
  assert.equal(seen[2].exit_code, 3);
  assert.ok(seen[2].ended && seen[2].eof);
});

test('followTaskOutput ends when alive() answers false, and on stop()', async () => {
  shell.setRoutes({ '/api/mirror/tasks/s8/output*': { text: 'x', from: 0, to: 1, eof: true, ended: false } });
  let live = true;
  A.followTaskOutput('s8', { tail: 10, intervalMs: 5, alive: () => live }, () => {});
  await waitUntil(() => calls(/tasks\/s8\//).length >= 2, { timeout: 2000 });
  live = false;
  await pause(30);
  const n = calls(/tasks\/s8\//).length;
  await pause(30);
  assert.equal(calls(/tasks\/s8\//).length, n, 'no request after alive() went false');

  shell.setRoutes({ '/api/mirror/tasks/s7/output*': { text: 'x', from: 0, to: 1, eof: true, ended: false } });
  const stop = A.followTaskOutput('s7', { from: 0, intervalMs: 5 }, () => {});
  await waitUntil(() => calls(/tasks\/s7\//).length >= 2, { timeout: 2000 });
  stop();
  const m = calls(/tasks\/s7\//).length;
  await pause(40);
  assert.equal(calls(/tasks\/s7\//).length, m, 'no request after stop()');
  assert.equal(calls(/tasks\/s7\//)[0].url, '/api/mirror/tasks/s7/output?from=0', 'from, when no tail is asked');
});

test('three failed reads in a row stop the follower with onText({error: true})', async () => {
  shell.setRoutes({ '/api/mirror/tasks/s6/output*': respond({ error: 'gone' }, { status: 500 }) });
  const seen = [];
  A.followTaskOutput('s6', { tail: 10, intervalMs: 5 }, (o) => seen.push(o));
  await waitUntil(() => seen.length === 1, { timeout: 2000, what: 'the error' });
  await pause(40);
  assert.deepEqual(seen, [{ error: true }]);
  assert.equal(calls(/tasks\/s6\//).length, 3);
});

test('the follower is a bounded setTimeout chain: chat-actions.js holds no setInterval', () => {
  const code = codeOf('public/app/chat-actions.js');
  assert.doesNotMatch(code, /\bsetInterval\s*\(/);
  assert.equal(A.FOLLOW_MS, 1500);
});

/* ── followAgentItems ─────────────────────────────────────────────────────── */

test('followAgentItems asks ?after=<seq>, advances to the highest seq handed, and stops once done with nothing new', async () => {
  const running = { id: 'a9', kind: 'agent', status: 'running' };
  const done = { id: 'a9', kind: 'agent', status: 'done' };
  const answers = [
    { agent: running, items: [{ seq: 5, kind: 'tool_call' }, { seq: 6, kind: 'text' }], next_before: 5 },
    { agent: running, items: [], next_before: null },
    { agent: done, items: [{ seq: 7, kind: 'text' }], next_before: null },
    { agent: done, items: [], next_before: null },
  ];
  shell.setRoutes({ '/api/mirror/agents/a9*': () => answers.shift() || { agent: done, items: [] } });
  const seen = [];
  A.followAgentItems('a9', { after: 4, intervalMs: 5 }, (o) => seen.push(o));
  await waitUntil(() => seen.length === 4, { timeout: 2000, what: 'four reads' });
  await pause(40);
  assert.deepEqual(calls(/\/api\/mirror\/agents\/a9/).map((c) => c.url), [
    '/api/mirror/agents/a9?after=4', '/api/mirror/agents/a9?after=6', '/api/mirror/agents/a9?after=6',
    '/api/mirror/agents/a9?after=7'], 'and nothing after the done read that brought nothing');
  assert.deepEqual(seen.map((o) => o.items.map((it) => it.seq)), [[5, 6], [], [7], []]);
  assert.equal(seen[2].agent.status, 'done');
});

test('followAgentItems: three failed reads stop it with onItems({error: true})', async () => {
  shell.setRoutes({ '/api/mirror/agents/a8*': respond({}, { status: 404 }) });
  const seen = [];
  A.followAgentItems('a8', { after: 0, intervalMs: 5 }, (o) => seen.push(o));
  await waitUntil(() => seen.length === 1, { timeout: 2000 });
  await pause(30);
  assert.deepEqual(seen, [{ error: true }]);
  assert.equal(calls(/\/api\/mirror\/agents\/a8/).length, 3);
});

/* ── Output, Open ─────────────────────────────────────────────────────────── */

test('Output expands the row with the tail and the footer; the chain ends once ended and eof', async () => {
  shell.setRoutes({ '/api/mirror/tasks/s1/output*': { task_id: 's1', text: 'line 1\nline 2\n', from: 0, to: 14, size: 14,
    eof: true, ended: true, footer: '[exited with code 3]', exit_code: 3 } });
  const el = mount(modelOf('shells', 's1'));
  shell.click(btn(el, 'output'));
  const tail = () => el.querySelector('.cs-row-tail');
  await waitUntil(() => tail() && tail().textContent === 'line 1\nline 2\n', { timeout: 2000, what: 'the tail' });
  assert.equal(calls(/tasks\/s1\/output/)[0].url, '/api/mirror/tasks/s1/output?tail=16384');
  assert.equal(el.querySelector('.cs-row-footer').textContent, '[exited with code 3]');
  assert.ok(!el.querySelector('.cs-row-footer').hidden);
  assert.equal(btn(el, 'output').getAttribute('aria-expanded'), 'true');
  await pause(A.FOLLOW_MS + 200);
  assert.equal(calls(/tasks\/s1\/output/).length, 1, 'ended and eof: no second read');
});

test('collapsing the row stops its follower: no further request', async () => {
  shell.setRoutes({ '/api/mirror/tasks/s1/output*': { task_id: 's1', text: 'x\n', from: 0, to: 2, size: 2, eof: true,
    ended: false, footer: '' } });
  const el = mount(modelOf('shells', 's1'));
  shell.click(btn(el, 'output'));
  await waitUntil(() => calls(/tasks\/s1\/output/).length === 1, { timeout: 2000 });
  await shell.tick();
  shell.click(btn(el, 'output'));
  assert.ok(el.querySelector('.cs-row-body').hidden, 'collapsed');
  assert.equal(btn(el, 'output').getAttribute('aria-expanded'), 'false');
  await pause(A.FOLLOW_MS + 200);
  assert.equal(calls(/tasks\/s1\/output/).length, 1, 'no further request');
});

test('a row that leaves an open list (its tray closing) stops its follower', async () => {
  shell.setRoutes({ '/api/mirror/tasks/s1/output*': { task_id: 's1', text: 'x\n', from: 0, to: 2, size: 2, eof: true,
    ended: false, footer: '' } });
  const el = mount(modelOf('shells', 's1'));
  shell.click(btn(el, 'output'));
  await waitUntil(() => calls(/tasks\/s1\/output/).length === 1, { timeout: 2000 });
  list.classList.add('hidden');   // the tray (or the phone's page) hides
  try {
    await pause(A.FOLLOW_MS + 200);
    assert.equal(calls(/tasks\/s1\/output/).length, 1, 'alive() is false in a hidden tray');
  } finally {
    list.classList.remove('hidden');
  }
});

test('Open on an agent row and "Open full output" on a shell row each emit chat:open {view: \'task\', id}', async (t) => {
  const seen = [];
  t.after(bus.on('chat:open', (d) => seen.push(d)));
  const agent = mount(modelOf('agents', 'a1'));
  shell.click(btn(agent, 'open'));
  shell.setRoutes({ '/api/mirror/tasks/s1/output*': { text: '', from: 0, to: 0, eof: true, ended: true, footer: '' } });
  const sh = mount(modelOf('shells', 's1'));
  shell.click(btn(sh, 'output'));
  const full = sh.querySelector('.cs-row-full');
  assert.equal(full.textContent, 'Open full output');
  shell.click(full);
  assert.deepEqual(seen, [{ view: 'task', id: 'a1' }, { view: 'task', id: 's1' }]);
});

/* ── the confirm ──────────────────────────────────────────────────────────── */

test('compact: Kill shows RowModel.confirm.text; Kill posts task-stop once and the row reads "stopping…"', async () => {
  shell.setRoutes({ '/api/queue/task-stop': { ok: true } });
  const m = modelOf('shells', 's1');
  const el = mount(m);
  const kill = m.actions.find((a) => a.id === 'kill');
  shell.click(btn(el, 'kill'));
  const box = el.querySelector('.cs-row-confirm');
  assert.ok(box, 'the inline confirm');
  assert.equal(box.querySelector('.cs-confirm-text').textContent, kill.confirm.text);
  assert.equal(kill.confirm.text, 'Kill npm run dev? Claude stops it with TaskStop.');
  assert.equal(box.querySelector('.cs-confirm-yes').textContent, 'Kill');
  assert.equal(box.querySelector('.cs-confirm-no').textContent, 'Keep');
  assert.ok(el.querySelector('.cs-row-actions').hidden, 'the buttons step aside');
  assert.equal(calls(/task-stop/).length, 0, 'nothing posted yet');
  shell.click(box.querySelector('.cs-confirm-yes'));
  await shell.tick();
  const posts = calls(/\/api\/queue\/task-stop/);
  assert.equal(posts.length, 1, 'once');
  assert.equal(posts[0].method, 'POST');
  assert.deepEqual(posts[0].body, { task_id: 's1' });
  assert.equal(el.querySelector('.cs-row-meta').textContent, 'stopping…');
  assert.equal(btn(el, 'kill'), null, 'no second Kill while it stops');
  assert.equal(el.querySelector('.cs-row-confirm'), null);
  // The redraw before the store hears of it keeps "stopping…"; once the row
  // carries stop_requested_at, chat-present words it.
  R.updateRow(el, modelOf('shells', 's1'));
  assert.equal(el.querySelector('.cs-row-meta').textContent, 'stopping…');
  await show({ tasks: [{ ...shellTask, stop_requested_at: T }, agentTask, workflowTask] });
  R.updateRow(el, modelOf('shells', 's1'));
  assert.equal(el.dataset.stopping, undefined, 'the store has it now');
  assert.equal(el.querySelector('.cs-row-meta').textContent, 'stopping…');
  await show();
});

test('compact: Keep reverts with no request; so does Escape', async () => {
  const el = mount(modelOf('agents', 'a1'));
  shell.click(btn(el, 'cancel'));
  shell.click(el.querySelector('.cs-confirm-no'));
  assert.equal(el.querySelector('.cs-row-confirm'), null);
  assert.ok(!el.querySelector('.cs-row-actions').hidden);
  shell.click(btn(el, 'cancel'));
  const e = shell.key('Escape', { target: el.querySelector('.cs-confirm-no') });
  assert.ok(e.defaultPrevented);
  assert.equal(el.querySelector('.cs-row-confirm'), null, 'Escape reverted');
  await shell.tick();
  assert.equal(calls(/task-stop/).length, 0, 'no request');
});

test('a refused stop shows the hint inline and puts the row back', async () => {
  shell.setRoutes({ '/api/queue/task-stop': respond({ ok: false, hint: 'That task has already finished.' }, { status: 409 }) });
  const m = modelOf('shells', 's1');
  const el = mount(m);
  shell.click(btn(el, 'kill'));
  shell.click(el.querySelector('.cs-confirm-yes'));
  await waitUntil(() => !el.querySelector('.cs-row-note').hidden, { timeout: 2000, what: 'the hint' });
  assert.equal(el.querySelector('.cs-row-note').textContent, 'That task has already finished.');
  assert.equal(el.querySelector('.cs-row-meta').textContent, m.meta);
  assert.ok(btn(el, 'kill'), 'Kill is offered again');
});

test('touch: the first tap reads "Confirm kill" and disables the siblings; the second posts', async () => {
  shell.setRoutes({ '/api/queue/task-stop': { ok: true } });
  const el = mount(modelOf('shells', 's1'), 'touch');
  shell.press(btn(el, 'kill'));
  assert.equal(btn(el, 'kill').textContent, 'Confirm kill');
  assert.ok(btn(el, 'output').disabled, 'the sibling is disabled');
  assert.equal(el.querySelector('.cs-row-confirm'), null, 'no inline confirm at the touch density');
  assert.equal(calls(/task-stop/).length, 0);
  shell.press(btn(el, 'kill'));
  await shell.tick();
  assert.equal(calls(/task-stop/).length, 1);
  assert.deepEqual(calls(/task-stop/)[0].body, { task_id: 's1' });
  assert.equal(el.querySelector('.cs-row-meta').textContent, 'stopping…');
});

test('touch: another tap reverts, and so do 3 s', async () => {
  const el = mount(modelOf('shells', 's1'), 'touch');
  shell.press(btn(el, 'kill'));
  assert.equal(btn(el, 'kill').textContent, 'Confirm kill');
  shell.press(doc.body);
  assert.equal(btn(el, 'kill').textContent, 'Kill', 'another tap reverted it');
  assert.ok(!btn(el, 'output').disabled);
  assert.equal(A.TOUCH_REVERT_MS, 3000);
  // The revert timer itself, at a test's pace (confirmAction takes revertMs).
  const b = btn(el, 'kill');
  let ran = 0;
  A.confirmAction(b, { density: 'touch', confirm: { touch: 'Confirm kill' }, run: () => { ran += 1; }, revertMs: 20 });
  assert.equal(b.textContent, 'Confirm kill');
  await waitUntil(() => b.textContent === 'Kill', { timeout: 2000, what: 'the revert' });
  assert.ok(!btn(el, 'output').disabled);
  assert.equal(ran, 0);
  await shell.tick();
  assert.equal(calls(/task-stop/).length, 0, 'nothing posted');
});

test('without capabilities.task_stop, or below full, no stop button is drawn', async () => {
  await show({ caps: {} });
  try {
    assert.deepEqual(buttons(mount(modelOf('shells', 's1'))), ['Output']);
  } finally {
    await show();
  }
  await show({ level: 'read' });
  try {
    assert.deepEqual(buttons(mount(modelOf('agents', 'a1'))), ['Open']);
  } finally {
    await show();
  }
});

/* ── queue rows ───────────────────────────────────────────────────────────── */

test('queue rows: Remove calls removeItem (DELETE), Hold and Stage call setStaged (PATCH {staged})', async () => {
  const items = [
    { id: 'q1', kind: 'signal', summary: 'form_submit', staged: true },
    { id: 'q2', kind: 'capture', summary: 'a page', staged: false },
  ];
  await show({}, { items, count: 2 });
  try {
    const a = mount(modelOf('queue', 'q1'));
    const b = mount(modelOf('queue', 'q2'));
    assert.deepEqual(buttons(a), ['Hold', 'Remove']);
    assert.deepEqual(buttons(b), ['Stage', 'Remove']);
    shell.click(btn(a, 'hold'));
    shell.click(btn(b, 'stage'));
    await shell.tick();
    const patches = calls(/\/api\/queue\/q[12]$/).filter((c) => c.method === 'PATCH');
    assert.deepEqual(patches.map((c) => [c.url, c.body]), [['/api/queue/q1', { staged: false }], ['/api/queue/q2', { staged: true }]]);
    shell.click(btn(a, 'remove'));
    await shell.tick();
    const del = calls(/\/api\/queue\/q1/).filter((c) => c.method === 'DELETE');
    assert.equal(del.length, 1);
    assert.equal(del[0].url, '/api/queue/q1', 'a plain remove, not a revert');
    assert.equal(a.querySelector('.cs-row-confirm'), null, 'a queue Remove asks for no confirm');
  } finally {
    await show();
  }
});

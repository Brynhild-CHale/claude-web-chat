// The workflows source (lib/server/mirror/workflows.js, spec §2.5
// "Workflows", §2.10, §2.12, §5.6, §6.9; validation V4; a port of
// rebuild_wf.py), registered on a REAL createMirror beside the real
// transcripts source (a fake store) and the agents source
// (test-support/agent-fixtures agentMirror).
//
// Pinned:
//   * phaseTitles reads a script's phase titles by a balanced-bracket scan
//     (quotes, escapes and brackets inside titles), never evaluating it;
//   * a Workflow launch makes one 'workflow' row keyed by its taskId, titled by
//     its workflowName; journal lines move its steps and meta.step ({index: 2,
//     total: 3}); a retry under the same key is attempt 2; the agents table
//     carries label, phase, state, attempt, tools, last_tool and model;
//     mirror.workflow(runId) and mirror.workflow(taskId) answer the same;
//   * an old journal's agents take their label and phase from their meta files;
//     with no script, the phases come in the journal's order;
//   * the parent's notification ends it; a stopped run ends by a terminal
//     summary newer than the journal, under either name, and a summary older
//     than the journal is ignored;
//   * TaskStop-only: a Read, a grep and a TaskStop for another task end
//     nothing; the TaskStop naming the run's task kills it, by 'claude';
//   * restart: the running row comes back and its journal tail resumes;
//   * stop() closes every tail; no answer, row or frame names a path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { waitUntil } = require('../test-support/helpers');
const { agentMirror, fakeStore, S1 } = require('../test-support/agent-fixtures');
const workflows = require('../lib/server/mirror/workflows');

const { phaseTitles } = workflows;
const TASK = 'wtask0001';
const RUN = 'wfr_run0001';
const A1 = 'a1000000000000001';
const A2 = 'a2000000000000002';
const A3 = 'a3000000000000003';
const WAIT = { timeout: 8000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function started(t, opts) {
  const h = agentMirror(t, opts);
  await h.mirror.start();
  h.sessionStart();
  return h;
}

// The parent's turn: a prompt and the Workflow call with its async launch.
function launch(h, { task = TASK, run = RUN, name = 'release-check', script = true, phases } = {}) {
  if (script) h.fx.writeScript(run, { name, phases });
  const r = h.records();
  r.prompt('run the release check', { promptId: `p-${run}` });
  const useId = h.fx.workflowCall(r, { toolUseId: `toolu_01${run.replace(/_/g, '')}`, taskId: task, runId: run, workflowName: name });
  h.ch.writeTranscript(S1, r.records);
  return { r, useId };
}

// A workflow agent's file: its prompt and `n` tool calls.
function agentFile(h, agentId, run, { n = 1, tool = 'Bash' } = {}) {
  const a = h.fx.agentRecords({ agentId, seed: agentId.charCodeAt(1) });
  h.fx.workflowAgentPrompt(a, `Do ${agentId}.`);
  for (let i = 0; i < n; i++) {
    const id = `toolu_01W${agentId.slice(-3)}${i}`;
    a.assistant([{ type: 'tool_use', name: tool, input: { command: `make step${i}` }, id }], { model: 'claude-haiku-5' });
    a.toolResult(id, `step ${i} ok`);
  }
  h.fx.writeAgent(agentId, a.records, { runId: run });
  return a;
}

// ── phaseTitles ──────────────────────────────────────────────────────────────

test('phaseTitles: three titles with quotes and brackets inside, by a balanced scan, never evaluated', () => {
  const src = [
    "globalThis.__wcEvaluated = true;",
    "const other = { title: 'not a phase' };",
    'export const meta = {',
    "  name: 'release-check',",
    '  phases: [',
    "    { title: 'Build [the] \\'bundle\\'', steps: ['a', ']', \"[\"] },",
    '    { title: "Test \\"all\\" ]] the things", note: \'title: fake\' },',
    '    { title: `Ship ${\'v\'} [1]` },',
    '  ],',
    '  after: [{ title: "outside the phases" }],',
    '};',
  ].join('\n');
  assert.deepEqual(phaseTitles(src), ["Build [the] 'bundle'", 'Test "all" ]] the things', "Ship ${'v'} [1]"]);
  assert.equal(globalThis.__wcEvaluated, undefined, 'the script never ran');
  assert.deepEqual(phaseTitles('export const meta = { name: "x" };'), [], 'no phases');
  assert.deepEqual(phaseTitles('meta = { phases: [ { title: "open" '), [], 'an unbalanced array');
  assert.deepEqual(phaseTitles(null), []);
  assert.deepEqual(phaseTitles("x = { phases : [ { 'title': 'Quoted key' }, {title:'b'} ] }"), ['Quoted key', 'b']);
});

// ── a run ────────────────────────────────────────────────────────────────────

test('a Workflow launch: one row by its taskId; the journal moves its steps; a retry is attempt 2; detail by run or task id', async (t) => {
  const h = await started(t);
  const { useId } = launch(h, { phases: ['Build', 'Test', 'Ship'] });
  const row = await h.waitRow(TASK, (x) => x.status === 'running' && x.steps.length === 3, 'the workflow row and its phases');
  assert.equal(h.rows().length, 1, 'one row, and no agent rows');
  assert.equal(row.kind, 'workflow');
  assert.equal(row.title, 'release-check');
  assert.equal(row.tool_use_id, useId);
  assert.deepEqual(row.can, { output: false, open: true, stop: true });
  assert.deepEqual(row.steps.map((s) => [s.label, s.state]), [['Build', 'pending'], ['Test', 'pending'], ['Ship', 'pending']]);
  assert.deepEqual(h.mirror.tasks().counts.workflows, { running: 1, total: 1 });

  const j = h.fx.journal(RUN);
  j.launched();
  j.started({ key: 'build', agentId: A1, label: 'Build the bundle', phase: 'Build' });
  agentFile(h, A1, RUN, { n: 2 });
  const b = await h.waitRow(TASK, (x) => x.steps[0].state === 'running' && x.line, 'phase 1 running');
  assert.deepEqual(b.meta.step, { index: 1, total: 3 });
  assert.equal(b.line, 'Bash · make step1', 'the running agent\'s last tool');
  assert.ok(h.activity.some(([cid, , kind]) => cid === S1 && kind === 'workflow'), 'noteActivity(cid, at, \'workflow\')');

  j.result({ key: 'build', agentId: A1, result: { ok: true, files: 3 } });
  j.started({ key: 'test', agentId: A2, label: 'Run the tests', phase: 'Test' });
  agentFile(h, A2, RUN, { n: 1 });
  j.failed({ key: 'test', agentId: A2 });
  j.started({ key: 'test', agentId: A3, label: 'Run the tests', phase: 'Test' });
  agentFile(h, A3, RUN, { n: 3, tool: 'Bash' });
  const s2 = await h.waitRow(TASK, (x) => x.meta.step && x.meta.step.index === 2 && x.steps[1].state === 'running', 'phase 2');
  assert.deepEqual(s2.meta.step, { index: 2, total: 3 });
  assert.deepEqual(s2.steps.map((s) => s.state), ['done', 'running', 'pending']);

  const byRun = await h.workflow(RUN);
  const byTask = await h.workflow(TASK);
  assert.deepEqual(byRun, byTask, 'the run id and the task id answer the same');
  assert.equal(byRun.workflow.id, TASK);
  assert.deepEqual(byRun.phases, [{ title: 'Build', state: 'done' }, { title: 'Test', state: 'running' }, { title: 'Ship', state: 'pending' }]);
  assert.equal(byRun.agents.length, 2, 'agents keyed by the journal key');
  const [build, tests] = byRun.agents;
  assert.equal(build.agent_id, A1);
  assert.equal(build.key, 'build');
  assert.equal(build.label, 'Build the bundle');
  assert.equal(build.phase, 'Build');
  assert.equal(build.state, 'done');
  assert.equal(build.attempt, 1);
  assert.equal(build.tools, 2);
  assert.equal(build.last_tool, 'Bash · make step1');
  assert.equal(build.model, 'claude-haiku-5');
  assert.equal(build.result_preview, '{"ok":true,"files":3}');
  assert.ok(Number.isFinite(build.started_at) && Number.isFinite(build.ended_at));
  assert.equal(tests.agent_id, A3, 'the retry\'s agent');
  assert.equal(tests.attempt, 2);
  assert.equal(tests.state, 'running');
  await waitUntil(async () => (await h.workflow(TASK)).agents[1].tools === 3, { ...WAIT, what: 'the retry\'s tail' });
  assert.equal(await h.workflow('wnope'), null, 'an unknown id');

  // The parent's notification ends it.
  const r2 = h.records({ seed: 5 });
  r2.taskNotification({ taskId: TASK, status: 'completed', summary: 'Dynamic workflow "release-check" completed' });
  h.ch.appendTranscript(S1, r2.records);
  const done = await h.waitRow(TASK, (x) => x.status !== 'running', 'the notification');
  assert.equal(done.status, 'done');
  assert.equal(done.can.stop, false);
  assert.equal(done.line, '');
  await waitUntil(() => h.tailers.filter((x) => x.kind === 'workflows').every((x) => x.stopped), { ...WAIT, what: 'every tail stopped with the run' });
  const after = await h.workflow(RUN);
  assert.ok(after.agents.every((a) => a.state !== 'running'), 'no agent of an ended run shows running');
  await h.mirror.stop();
  assert.deepEqual(h.leaks(), []);
  assert.ok(h.tailers.every((x) => x.inCallbackCalls === 0), 'no tailer stopped or drained inside its callback');
});

test('an old journal: label and phase from each agent\'s meta file; no script: the phases in the journal\'s order', async (t) => {
  const h = await started(t);
  launch(h, { script: false });
  await h.waitRow(TASK, (x) => x.status === 'running');
  h.fx.writeAgentMeta(A1, { runId: RUN, description: 'Lint everything', workflowPhase: 'Check' });
  h.fx.writeAgentMeta(A2, { runId: RUN, description: 'Package it', workflowPhase: 'Release' });
  const j = h.fx.journal(RUN);
  j.launched();
  j.started({ key: 'lint', agentId: A1 });
  j.result({ key: 'lint', agentId: A1, result: 'clean' });
  j.started({ key: 'pkg', agentId: A2 });
  const row = await h.waitRow(TASK, (x) => x.steps.length === 2 && x.steps[1].state === 'running', 'the journal\'s phases');
  assert.deepEqual(row.steps, [{ label: 'Check', state: 'done' }, { label: 'Release', state: 'running' }]);
  assert.deepEqual(row.meta.step, { index: 2, total: 2 });
  const d = await h.workflow(TASK);
  assert.deepEqual(d.agents.map((a) => [a.label, a.phase, a.state]), [['Lint everything', 'Check', 'done'], ['Package it', 'Release', 'running']]);
  assert.equal(d.agents[0].result_preview, 'clean');
  await h.mirror.stop();
});

// ── a stopped run's summary ──────────────────────────────────────────────────

for (const name of ['plain', 'wf']) {
  test(`a stopped run ends by a terminal summary newer than the journal (${name === 'wf' ? 'wf_<runId>.json' : '<runId>.json'}); an older one is ignored`, async (t) => {
    const h = await started(t);
    launch(h);
    const j = h.fx.journal(RUN);
    j.launched();
    j.started({ key: 'build', agentId: A1, label: 'Build', phase: 'Build' });
    await h.waitRow(TASK, (x) => x.steps[0].state === 'running');
    // A resumed runId's stale summary: older than the journal.
    h.fx.writeSummary(RUN, { status: 'killed', name, mtime: Date.now() - 120000 });
    await sleep(workflows.JOURNAL_POLL_MS + 600);
    assert.equal(h.row(TASK).status, 'running', 'a summary older than the journal is ignored');
    const file = h.fx.writeSummary(RUN, { status: 'killed', name, mtime: Date.now() + 1000 });
    const ended = await h.waitRow(TASK, (x) => x.status !== 'running', 'the fresh summary');
    assert.equal(ended.status, 'killed');
    assert.equal(ended.ended_at, Math.round(fs.statSync(file).mtimeMs));
    await h.mirror.stop();
    assert.deepEqual(h.leaks(), []);
  });
}

// ── the TaskStop rule ────────────────────────────────────────────────────────

test('TaskStop-only for a workflow: a Read, a grep and a TaskStop for another task end nothing; the TaskStop naming it kills it', async (t) => {
  const h = await started(t);
  const { r } = launch(h);
  await h.waitRow(TASK, (x) => x.status === 'running');
  const quoted = `Successfully stopped task: ${TASK} (workflow)`;
  const n0 = r.records.length;
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: `${h.ch.cwd}/notes.txt` }, id: 'toolu_01Read' }]);
  r.toolResult('toolu_01Read', `1\t${quoted}`);
  r.assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'stopped task' }, id: 'toolu_01Grep' }]);
  r.toolResult('toolu_01Grep', `log.txt:3:${quoted}`);
  h.fx.taskStop(r, { taskId: TASK, toolUseId: 'toolu_01StopOther', named: 'b9other' });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  await waitUntil(() => h.probe.engine.model.item('toolu_01StopOther') && h.probe.engine.model.item('toolu_01StopOther').result, { ...WAIT, what: 'the three results read' });
  await sleep(100);
  assert.equal(h.row(TASK).status, 'running', 'none of the three ended it');
  const n1 = r.records.length;
  h.fx.taskStop(r, { taskId: TASK, toolUseId: 'toolu_01Stop' });
  h.ch.appendTranscript(S1, r.records.slice(n1));
  const killed = await h.waitRow(TASK, (x) => x.status !== 'running', 'the TaskStop');
  assert.equal(killed.status, 'killed');
  assert.equal(killed.stopped_by, 'claude');
  await h.mirror.stop();
});

// ── restart ──────────────────────────────────────────────────────────────────

test('restart: persistState → restoreState brings the running row back and its journal tail resumes', async (t) => {
  const store = fakeStore();
  const a = await started(t, { store });
  launch(a, { phases: ['Build', 'Test', 'Ship'] });
  const j = a.fx.journal(RUN);
  j.launched();
  j.started({ key: 'build', agentId: A1, label: 'Build it', phase: 'Build' });
  await a.waitRow(TASK, (x) => x.steps[0].state === 'running');
  await a.mirror.stop();
  const slice = a.store.saved.get(S1).state.sources.workflows;
  assert.equal(slice.v, workflows.STATE_VERSION);
  assert.equal(slice.rows.length, 1);
  assert.equal(slice.rows[0].id, TASK);
  assert.equal(slice.rows[0].run_id, RUN);
  assert.ok(slice.rows[0].journal && Number.isFinite(slice.rows[0].journal.offset), 'the journal offset');
  assert.ok(!JSON.stringify(slice).includes(a.ch.projectsDir), 'no path in the slice');

  const b = agentMirror(t, { store, root: a.root, ch: a.ch });
  await b.mirror.start();
  b.sessionStart('resume');
  const back = await b.waitRow(TASK, (x) => x.status === 'running', 'the restored row');
  assert.equal(back.title, 'release-check');
  assert.equal(back.steps[0].state, 'running');
  j.result({ key: 'build', agentId: A1, result: 'built' });
  j.started({ key: 'test', agentId: A2, label: 'Test it', phase: 'Test' });
  const moved = await b.waitRow(TASK, (x) => x.meta.step && x.meta.step.index === 2, 'the resumed journal');
  const journalTail = b.tailers.find((x) => x.file.endsWith('journal.jsonl'));
  assert.equal(journalTail.stats.resumed, 'offset', 'the tail resumed at the persisted offset');
  assert.deepEqual(moved.steps.map((s) => s.state), ['done', 'running', 'pending']);
  const d = await b.workflow(RUN);
  assert.deepEqual(d.agents.map((x) => [x.key, x.label, x.state]), [['build', 'Build it', 'done'], ['test', 'Test it', 'running']]);
  await b.mirror.stop();
  assert.ok(b.tailers.filter((x) => x.kind === 'workflows').every((x) => x.stopped), 'stop() closed every tail');
});

// ── a catch-up replay ────────────────────────────────────────────────────────

test('a catch-up replay of a finished run starts no tail', async (t) => {
  const h = agentMirror(t);
  h.fx.writeScript(RUN, { phases: ['Build'] });
  const j = h.fx.journal(RUN);
  j.launched();
  j.started({ key: 'build', agentId: A1, label: 'Build', phase: 'Build' });
  j.result({ key: 'build', agentId: A1, result: 'ok' });
  const r = h.records({ start: Date.now() - 10 * 60 * 1000 });
  r.prompt('run it', { promptId: 'p-old' });
  h.fx.workflowCall(r, { toolUseId: 'toolu_01OldWf', taskId: TASK, runId: RUN });
  r.assistant(['Launched.']);
  r.turnDuration({ durationMs: 10 });
  r.taskNotification({ taskId: TASK, status: 'completed', summary: 'Dynamic workflow "release-check" completed' });
  r.turnDuration({ durationMs: 10 });
  h.ch.writeTranscript(S1, r.records);
  await h.mirror.start();
  h.sessionStart('resume');
  const done = await h.waitRow(TASK, (x) => x.status === 'done', 'the replayed run, ended');
  assert.equal(done.title, 'release-check');
  await sleep(400);
  assert.equal(h.tailers.length, 0, 'no tail was started');
  const d = await h.workflow(TASK);
  assert.deepEqual(d.agents.map((x) => [x.agent_id, x.state, x.result_preview]), [[A1, 'done', 'ok']], 'the journal read once, on demand');
  assert.deepEqual(d.phases, [{ title: 'Build', state: 'done' }]);
  await h.mirror.stop();
  assert.deepEqual(h.leaks(), []);
});

// The agents source (lib/server/mirror/agents.js, spec §2.5 "Agents", §2.3,
// §2.4 rule 6, §2.9, §2.10, §2.12, §5.6, §6.9, §7.6), registered on a REAL
// createMirror beside the real transcripts source (a fake store) and the
// workflows source, the way U51 will register them (test-support/agent-fixtures
// agentMirror).
//
// Pinned:
//   * an async Agent call makes one running 'agent' row keyed by its agentId,
//     titled by its description; the agent file appearing later (stat-polled)
//     and growing moves meta.tools, line and meta.model, and is progress
//     evidence ('agent'); its notification (two carriers, then a duplicate)
//     ends it once, line = the quoted first 100 characters of the result;
//   * a foreground call is keyed by its tool_use id and re-keyed to the
//     agentId when a subagent hook's meta file names that tool_use (the old id
//     in removed_tasks, one row), and the old id stays an alias for the stream;
//   * TaskStop-only (ruling A-confirm (4)): a Read, a grep and a TaskStop for
//     another task quoting the stopped sentence end nothing; the TaskStop naming
//     the agent ends it killed by 'claude';
//   * SubagentStop with agent type '' changes nothing; a typed one ends it with
//     the last message as its line;
//   * mirror.agent pages the agent's own items through the facade (before,
//     after, next_before), at full caps, masked and WITHHELD by the private
//     model's context redaction, and the shared model never holds the agent;
//   * a workflow agent is streamed by its agentId once a Workflow result named
//     the run;
//   * restart: running rows come back and their tails resume, the alias too; a
//     removed row's old id answers null;
//   * at most AGENT_TAILS_MAX tails, a row past the cap tailed when one frees;
//   * a catch-up replay of a finished agent starts no tail; stop() closes every
//     tail and stream; no tailer is stopped or drained inside its callback; no
//     answer, row or frame names a path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { waitUntil } = require('../test-support/helpers');
const { fakeSecrets, findLeaks } = require('../test-support/fake-secrets');
const { agentMirror, fakeStore, fakeClock, S1 } = require('../test-support/agent-fixtures');
const { WITHHELD } = require('../lib/core/redact');
const { ITEM_CAPS } = require('../lib/server/mirror/model');
const { stoppedTaskId } = require('../lib/server/mirror/tasks');
const agents = require('../lib/server/mirror/agents');

const { foldAgentRecords, quoteLine } = agents;
const AGENT = 'a0123456789abcdef';
const AGENT2 = 'a00000000000000f2';
const WAIT = { timeout: 8000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The parent's transcript up to an async launch: a prompt, the Agent call and
// its async_launched result.
function launchTurn(h, r, { agentId = AGENT, useId = 'toolu_01Agent', description = 'Explore the queue rail', promptId = 'p-agent' } = {}) {
  r.prompt('look at the rail', { promptId });
  h.fx.agentCall(r, { toolUseId: useId, description, subagentType: 'Explore' });
  h.fx.asyncLaunched(r, useId, { agentId, description });
  return useId;
}

// An agent file's records: the prompt, then `n` Bash calls and their results,
// then a closing reply.
function agentBody(h, { agentId = AGENT, n = 2, seed = 9, extra = null } = {}) {
  const a = h.fx.agentRecords({ agentId, seed });
  a.prompt('Look at the rail.', { promptId: 'p-agent' });
  for (let i = 0; i < n; i++) {
    const id = `toolu_01Sub${agentId.slice(-4)}${i}`;
    a.assistant([{ type: 'tool_use', name: 'Bash', input: { command: `grep -n rail file${i}.js`, description: `Search ${i}` }, id }], { model: 'claude-haiku-5' });
    a.toolResult(id, `file${i}.js:1: rail ${i}`);
  }
  if (extra) extra(a);
  return a;
}

async function started(t, opts) {
  const h = agentMirror(t, opts);
  await h.mirror.start();
  h.sessionStart();
  return h;
}

// ── the exports ──────────────────────────────────────────────────────────────

test('the constants, the fold and the quote are exported; the source reaches no listing, eval or kill', () => {
  assert.equal(agents.AGENT_POLL_MS, 1000);
  assert.equal(agents.JOURNAL_POLL_MS, 2000);
  assert.equal(agents.AGENT_TAILS_MAX, 16);
  assert.equal(agents.STREAMS_MAX, 4);
  assert.equal(agents.STREAM_IDLE_MS, 60000);
  assert.equal(agents.STREAM_LIMIT_MAX, 100);
  assert.equal(agents.FINISHED_KEEP_MS, 30 * 60 * 1000);
  assert.equal(agents.LINE_MAX, 100);
  const recs = [
    { obj: { type: 'user', timestamp: '2026-10-06T10:00:00.000Z', message: { content: '[Workflow harness — user request]\nhi' } } },
    { obj: { type: 'user', timestamp: '2026-10-06T10:00:01.000Z', message: { content: 'x\nThe computed task text follows:\n  Do it.' } } },
    { obj: { type: 'assistant', timestamp: '2026-10-06T10:00:02.000Z', message: { model: 'claude-haiku-5', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/project/a.js' } }] } } },
    { obj: { type: 'assistant', timestamp: '2026-10-06T10:00:03.000Z', message: { model: '<synthetic>', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } } },
    { bad: true, obj: null },
  ];
  const s = foldAgentRecords(null, recs);
  assert.equal(s.tools, 2);
  assert.equal(s.last_tool, 'Bash · ls');
  assert.equal(s.model, 'claude-haiku-5', 'a synthetic model is not the model');
  assert.equal(s.first_ts, Date.parse('2026-10-06T10:00:00.000Z'));
  assert.equal(s.last_ts, Date.parse('2026-10-06T10:00:03.000Z'));
  assert.equal(s.prompt_preview, 'Do it.', 'the relay skipped, the frame unwrapped');
  assert.equal(foldAgentRecords(s, [recs[2]]).tools, 3, 'folds on from a state');
  assert.equal(s.tools, 2, 'never mutates the state it was given');
  assert.equal(quoteLine('  a\n b  '), '“a b”');
  assert.equal(quoteLine('x'.repeat(150)), `“${'x'.repeat(100)}…”`);
  for (const file of ['agents.js', 'workflows.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', 'mirror', file), 'utf8');
    for (const banned of ['readdir', 'process.kill(', 'eval(', 'new Function', 'fs.watch(', 'readFileSync(', 'createReadStream(', 'glob']) {
      assert.ok(!src.includes(banned), `${file} never reaches ${banned}`);
    }
  }
});

test('stoppedTaskId (tasks.js) is the one TaskStop predicate', () => {
  const ok = { preview: 'Successfully stopped task: a1b2 (agent)', is_error: false };
  assert.equal(stoppedTaskId({ tool: 'TaskStop', task_id: 'a1b2' }, ok), 'a1b2');
  assert.equal(stoppedTaskId({ tool: 'TaskStop' }, ok), 'a1b2', 'a call naming no task_id');
  assert.equal(stoppedTaskId({ tool: 'TaskStop', task_id: 'other' }, ok), null, 'another task named');
  assert.equal(stoppedTaskId({ tool: 'Read' }, ok), null, 'not a TaskStop');
  assert.equal(stoppedTaskId({ tool: 'Bash', task_id: 'a1b2' }, ok), null);
  assert.equal(stoppedTaskId({ tool: 'TaskStop', task_id: 'a1b2' }, { ...ok, is_error: true }), null, 'an error result');
  assert.equal(stoppedTaskId(null, ok), null, 'no known call');
  assert.equal(stoppedTaskId({ tool: 'TaskStop' }, { preview: 'nothing' }), null);
});

// ── an async agent ───────────────────────────────────────────────────────────

test('an async Agent: one running row by its agentId; its file appears later and grows; its notification ends it once', async (t) => {
  const h = await started(t);
  const r = h.records();
  const useId = launchTurn(h, r);
  h.ch.writeTranscript(S1, r.records);
  const row = await h.waitRow(AGENT, (x) => x.status === 'running' && x.turn_id, 'the running agent row');
  assert.equal(h.rows().length, 1, 'one row');
  assert.equal(row.kind, 'agent');
  assert.equal(row.title, 'Explore the queue rail');
  assert.equal(row.tool_use_id, useId);
  assert.equal(row.meta.agent_type, 'Explore');
  assert.equal(row.meta.foreground, false, 'the async launch says so');
  assert.deepEqual(row.can, { output: false, open: true, stop: true });
  assert.equal(row.turn_id, h.probe.engine.model.item(useId).turn_id);
  assert.deepEqual(h.mirror.tasks().counts.agents, { running: 1, done: 0 });

  // The file appears after the call: stat-polled until then.
  await sleep(150);
  const a = agentBody(h, { n: 1 });
  h.fx.writeAgent(AGENT, a.records);
  const grown = await h.waitRow(AGENT, (x) => x.meta.tools === 1, 'the first tool');
  assert.equal(grown.line, 'Bash · grep -n rail file0.js');
  assert.equal(grown.meta.model, 'claude-haiku-5');
  const n0 = a.records.length;
  a.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: `${h.ch.cwd}/public/app.css` }, id: 'toolu_01SubRead' }], { model: 'claude-haiku-5' });
  h.fx.appendAgent(AGENT, a.records.slice(n0));
  const more = await h.waitRow(AGENT, (x) => x.meta.tools === 2, 'the file grew');
  assert.equal(more.line, 'Read · app.css');
  assert.ok(h.activity.some(([cid, , kind]) => cid === S1 && kind === 'agent'), 'noteActivity(cid, at, \'agent\')');
  const last = Date.parse(a.records[a.records.length - 1].timestamp);
  await waitUntil(() => h.mirror.liveOf(S1).evidence.transcript_at >= Math.min(last, Date.now()), { ...WAIT, what: 'the conversation progressing' });

  // The notification through two carriers, then a duplicate notify.
  const result = `Found the rail in three places: ${'public/app/rail.js, '.repeat(8)}and more.`;
  const n1 = r.records.length;
  const text = h.fx.agentNotificationText({ agentId: AGENT, toolUseId: useId, result });
  r.queueOperation('enqueue', { content: text });
  h.fx.agentNotification(r, { agentId: AGENT, toolUseId: useId, result });
  r.assistant(['The agent is done.']);
  r.turnDuration({ durationMs: 10 });
  h.ch.appendTranscript(S1, r.records.slice(n1));
  const done = await h.waitRow(AGENT, (x) => x.status === 'done', 'the notification');
  assert.equal(done.line, quoteLine(result));
  assert.ok(done.line.startsWith('“Found the rail') && done.line.endsWith('…”'), 'the quoted first 100 characters');
  assert.equal(done.can.stop, false);
  assert.ok(Number.isFinite(done.ended_at));
  assert.deepEqual(h.mirror.tasks().counts.agents, { running: 0, done: 1 });
  const tail = h.tailers.find((x) => x.file.endsWith(`agent-${AGENT}.jsonl`));
  await waitUntil(() => tail.stopped, { ...WAIT, what: 'the tail stopped with the row' });

  const taskItems = async () => {
    const p = await h.mirror.turns(S1, { limit: 10, items: 'summary' });
    return p && Array.isArray(p.turns) ? p.turns.flatMap((x) => x.items || []).filter((x) => x.kind === 'task' && x.task_id === AGENT) : [];
  };
  assert.equal((await taskItems()).length, 1, 'the two carriers made one task item');
  const n2 = r.records.length;
  h.fx.agentNotification(r, { agentId: AGENT, toolUseId: useId, result: 'A second note, same status.' });
  r.turnDuration({ durationMs: 10 });
  h.ch.appendTranscript(S1, r.records.slice(n2));
  await waitUntil(async () => (await taskItems()).length === 2, { ...WAIT, what: 'the duplicate read' });
  const after = h.row(AGENT);
  assert.equal(after.ended_at, done.ended_at, 'ended once');
  assert.equal(after.line, done.line, 'the duplicate changes nothing');
  await h.mirror.stop();
  assert.deepEqual(h.leaks(), []);
  assert.ok(h.tailers.every((x) => x.inCallbackCalls === 0), 'nothing stops or drains a tailer inside its callback');
});

// ── a foreground agent, re-keyed ─────────────────────────────────────────────

test('a foreground agent: keyed by its tool_use id, re-keyed by a subagent hook\'s meta file; the old id stays an alias', async (t) => {
  const h = await started(t);
  const useId = 'toolu_01Fore';
  h.publish('PreToolUse', { tool: { name: 'Agent', use_id: useId, input: { description: 'Check the tests', subagent_type: 'general-purpose', prompt: 'x' } } });
  const prov = h.row(useId);
  assert.ok(prov, 'the parent\'s PreToolUse made the row at once');
  assert.equal(prov.status, 'running');
  assert.equal(prov.title, 'Check the tests');
  assert.equal(prov.meta.foreground, true);
  assert.equal(prov.can.stop, false, 'TaskStop cannot take a tool_use id');
  const early = await h.agent(useId, {});
  assert.equal(early.agent.id, useId);
  assert.deepEqual(early.items, []);

  const r = h.records();
  r.prompt('check the tests', { promptId: 'p-fore' });
  h.fx.agentCall(r, { toolUseId: useId, description: 'Check the tests' });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(useId, (x) => x.turn_id === (h.probe.engine.model.item(useId) || {}).turn_id, 'the row in its call\'s turn');
  assert.equal(h.rows().length, 1);

  h.fx.writeAgentMeta(AGENT2, { toolUseId: useId, description: 'Check the tests' });
  h.fx.writeAgent(AGENT2, agentBody(h, { agentId: AGENT2, n: 3 }).records);
  h.publish('PreToolUse', { agent: { id: AGENT2, type: 'general-purpose' }, tool: { name: 'Bash', use_id: 'toolu_01In', input: { command: 'npm test' } } });
  const row = await h.waitRow(AGENT2, (x) => x.status === 'running', 'the re-keyed row');
  assert.equal(h.row(useId), null);
  assert.equal(h.rows().length, 1, 'one row remains');
  assert.equal(row.tool_use_id, useId);
  assert.equal(row.title, 'Check the tests');
  assert.equal(row.can.stop, true);
  await waitUntil(() => h.frames.some((f) => f.type === 'mirror:update' && (f.removed_tasks || []).includes(useId)), { ...WAIT, what: 'removed_tasks carries the old id' });
  await h.waitRow(AGENT2, (x) => x.meta.tools === 3, 'the tail on the agentId');

  // The alias: the first id answers the re-keyed row and its items.
  const viaOld = await h.agent(useId, {});
  assert.equal(viaOld.agent.id, AGENT2);
  assert.ok(viaOld.items.length >= 4, 'the agent\'s items');
  const viaNew = await h.agent(AGENT2, {});
  assert.deepEqual(viaOld.items.map((x) => x.id), viaNew.items.map((x) => x.id));

  // The final tool_result ends a foreground call.
  const n0 = r.records.length;
  h.fx.agentFinished(r, useId, { agentId: AGENT2, text: 'All 40 tests pass.' });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  const done = await h.waitRow(AGENT2, (x) => x.status === 'done', 'the foreground result');
  assert.equal(done.line, '“All 40 tests pass.”');
  assert.equal(h.rows().length, 1);
  await h.mirror.stop();
  assert.deepEqual(h.leaks(), []);
});

// ── the TaskStop rule ────────────────────────────────────────────────────────

test('TaskStop-only: a Read, a grep and a TaskStop for another task end nothing; the TaskStop naming the agent kills it', async (t) => {
  const h = await started(t);
  const r = h.records();
  launchTurn(h, r);
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(AGENT, (x) => x.status === 'running');
  const quoted = `Successfully stopped task: ${AGENT} (agent)`;
  const n0 = r.records.length;
  r.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: `${h.ch.cwd}/notes.txt` }, id: 'toolu_01Read' }]);
  r.toolResult('toolu_01Read', `1\t${quoted}`);
  r.assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'stopped task' }, id: 'toolu_01Grep' }]);
  r.toolResult('toolu_01Grep', `log.txt:3:${quoted}`);
  h.fx.taskStop(r, { taskId: AGENT, toolUseId: 'toolu_01StopOther', named: 'b9other' });
  r.assistant(['checked']);
  h.ch.appendTranscript(S1, r.records.slice(n0));
  await waitUntil(() => h.probe.engine.model.item('toolu_01StopOther') && h.probe.engine.model.item('toolu_01StopOther').result, { ...WAIT, what: 'the three results read' });
  await sleep(100);
  assert.equal(h.row(AGENT).status, 'running', 'none of the three ended it');

  const n1 = r.records.length;
  h.fx.taskStop(r, { taskId: AGENT, toolUseId: 'toolu_01Stop' });
  h.ch.appendTranscript(S1, r.records.slice(n1));
  const killed = await h.waitRow(AGENT, (x) => x.status !== 'running', 'the TaskStop');
  assert.equal(killed.status, 'killed');
  assert.equal(killed.stopped_by, 'claude');
  await h.mirror.stop();
});

// ── SubagentStop ─────────────────────────────────────────────────────────────

test('SubagentStop: agent type \'\' changes nothing; a typed one ends the row with the last message', async (t) => {
  const h = await started(t);
  const r = h.records();
  launchTurn(h, r);
  h.ch.writeTranscript(S1, r.records);
  const before = await h.waitRow(AGENT, (x) => x.status === 'running');
  h.publish('SubagentStop', { agent: { id: AGENT, type: '' }, stop: { last_assistant_message: 'internal' } });
  await sleep(50);
  assert.deepEqual(h.row(AGENT), before, 'an internal agent\'s stop is ignored');
  h.publish('SubagentStop', { agent: { id: AGENT, type: 'Explore' }, stop: { last_assistant_message: 'Three call sites found.' } });
  const done = await h.waitRow(AGENT, (x) => x.status === 'done');
  assert.equal(done.line, '“Three call sites found.”');
  // A notification after it brings the result, which is the better line.
  const n0 = r.records.length;
  h.fx.agentNotification(r, { agentId: AGENT, toolUseId: 'toolu_01Agent', result: 'The result itself.' });
  h.ch.appendTranscript(S1, r.records.slice(n0));
  await h.waitRow(AGENT, (x) => x.line === '“The result itself.”', 'the result line');
  await h.mirror.stop();
});

// ── the stream ───────────────────────────────────────────────────────────────

test('mirror.agent pages the agent\'s own items: before, after (followed live), full caps, masked and withheld; the shared model never holds the agent', async (t) => {
  const h = await started(t);
  const r = h.records();
  launchTurn(h, r);
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow(AGENT, (x) => x.status === 'running');
  const fake = fakeSecrets().find((f) => f.id === 'sk-anthropic-api');
  const big = `${'line of output '.repeat(400)}end`;
  const a = agentBody(h, {
    n: 6,
    extra: (x) => {
      x.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'cat big.log' }, id: 'toolu_01Big' }]);
      x.toolResult('toolu_01Big', big);
      x.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'node call.js' }, id: 'toolu_01Key' }]);
      x.toolResult('toolu_01Key', `calling\n${fake.text}\n`);
      x.assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/Users/someone/.ssh/id_rsa' }, id: 'toolu_01Ssh' }]);
      x.toolResult('toolu_01Ssh', 'ssh-ed25519-private-material-AAAAC3Nza');
    },
  });
  h.fx.writeAgent(AGENT, a.records);
  const before = h.mirror.snapshot({}).conversations.map((c) => c.id);
  const statusBefore = JSON.stringify(h.mirror.status().conversations.map((c) => c.id));

  const first = await h.agent(AGENT, { limit: 5 });
  assert.equal(first.agent.id, AGENT);
  assert.equal(first.items.length, 5);
  const seqs = first.items.map((x) => x.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'in seq order');
  assert.equal(first.next_before, seqs[0], 'older items remain');
  const all = await h.agent(AGENT, { limit: 100 });
  assert.equal(all.next_before, null, 'the whole stream in one page');
  assert.ok(all.items[0].kind === 'prompt' && all.items[0].text === 'Look at the rail.');
  const older = await h.agent(AGENT, { before: first.next_before, limit: 100 });
  assert.deepEqual([...older.items, ...first.items].map((x) => x.id), all.items.map((x) => x.id), 'the page before it');
  assert.equal(older.next_before, null, 'at the start');

  const bigCard = all.items.find((x) => x.id === 'toolu_01Big');
  assert.equal(bigCard.kind, 'tool_call');
  assert.ok(bigCard.result.preview.length > ITEM_CAPS.tool_call['result.preview'][0], 'at full caps, past the summary cap');
  assert.ok(bigCard.result.preview.endsWith('end'));
  const keyCard = all.items.find((x) => x.id === 'toolu_01Key');
  assert.deepEqual(findLeaks(all, [fake]), [], 'the key is masked');
  assert.ok(keyCard.result.preview.startsWith('calling'));
  const ssh = all.items.find((x) => x.id === 'toolu_01Ssh');
  assert.equal(ssh.result.preview, WITHHELD('ssh'), 'the private model\'s context redaction');
  assert.ok(!JSON.stringify(all).includes('AAAAC3Nza'));

  // Followed live: after=<seq> answers only what is newer.
  const top = all.items[all.items.length - 1].seq;
  const none = await h.agent(AGENT, { after: top });
  assert.deepEqual(none.items, []);
  const n0 = a.records.length;
  a.assistant(['Done looking.']);
  h.fx.appendAgent(AGENT, a.records.slice(n0));
  const newer = await h.agent(AGENT, { after: top });
  assert.equal(newer.items.length, 1);
  assert.equal(newer.items[0].kind, 'reply');
  assert.equal(newer.items[0].text, 'Done looking.');
  assert.ok(newer.items[0].seq > top);

  for (let i = 0; i < 3; i++) await h.agent(AGENT, {});
  assert.deepEqual(h.mirror.snapshot({}).conversations.map((c) => c.id), before, 'no conversation for the agent');
  assert.equal(JSON.stringify(h.mirror.status().conversations.map((c) => c.id)), statusBefore);
  assert.equal(h.probe.engine.model.turnsOf(AGENT).length, 0, 'no turn of the agent in the shared model');
  assert.equal(h.probe.engine.model.item('toolu_01Big'), null, 'no item of the agent in the shared model');
  assert.equal(h.mirror.snapshot({}).diagnostics.agents.streams, 1);
  assert.equal(await h.agent('a99999999999999zz', {}), null, 'an unknown id');
  assert.equal(await h.agent('../../etc', {}), null);
  await h.mirror.stop();
  assert.deepEqual(h.leaks(), []);
});

test('a workflow agent is streamed by its agentId once a Workflow result named its run', async (t) => {
  const h = await started(t);
  const runId = 'wfr0001';
  const wfAgent = 'a1111111111111111';
  const a = h.fx.agentRecords({ agentId: wfAgent });
  h.fx.workflowAgentPrompt(a, 'Build the thing.');
  a.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' }, id: 'toolu_01Wb' }]);
  a.toolResult('toolu_01Wb', 'built');
  h.fx.writeAgent(wfAgent, a.records, { runId });
  assert.equal(await h.agent(wfAgent, {}), null, 'no run seen yet');
  const r = h.records();
  r.prompt('run the release check', { promptId: 'p-wf' });
  h.fx.workflowCall(r, { toolUseId: 'toolu_01Wf', taskId: 'wtask01', runId });
  h.ch.writeTranscript(S1, r.records);
  await h.waitRow('wtask01', (x) => x.status === 'running', 'the workflow row');
  const got = await waitUntil(() => h.agent(wfAgent, {}).then((v) => (v && v.items.length ? v : null)), { ...WAIT, what: 'the workflow agent\'s stream' });
  assert.equal(got.agent.id, wfAgent);
  assert.equal(got.agent.kind, 'agent');
  const prompt = got.items.find((x) => x.kind === 'prompt');
  assert.equal(prompt.text, 'Build the thing.', 'the relay skipped, the frame unwrapped (rule 6)');
  assert.ok(got.items.some((x) => x.id === 'toolu_01Wb'));
  assert.equal(h.rows().filter((x) => x.kind === 'agent').length, 0, 'a workflow agent has no row');
  await h.mirror.stop();
  assert.deepEqual(h.leaks(), []);
});

// ── restart ──────────────────────────────────────────────────────────────────

test('restart: persistState → restoreState brings the running row back, its tail resumes, and the alias holds', async (t) => {
  const store = fakeStore();
  const a = await started(t, { store });
  const useId = 'toolu_01Rest';
  const r = a.records();
  r.prompt('check', { promptId: 'p-rest' });
  a.fx.agentCall(r, { toolUseId: useId, description: 'Restart me' });
  a.ch.writeTranscript(S1, r.records);
  await a.waitRow(useId, (x) => x.status === 'running');
  a.fx.writeAgentMeta(AGENT, { toolUseId: useId });
  const body = agentBody(a, { n: 1 });
  a.fx.writeAgent(AGENT, body.records);
  a.publish('PreToolUse', { agent: { id: AGENT, type: 'general-purpose' }, tool: { name: 'Bash', use_id: 'toolu_01X', input: { command: 'ls' } } });
  await a.waitRow(AGENT, (x) => x.meta.tools === 1);
  await a.mirror.stop();
  const slice = a.store.saved.get(S1).state.sources.agents;
  assert.equal(slice.v, agents.STATE_VERSION);
  assert.equal(slice.rows.length, 1);
  assert.equal(slice.rows[0].id, AGENT);
  assert.equal(slice.rows[0].status, 'running');
  assert.deepEqual(slice.aliases, [[useId, AGENT]]);
  assert.ok(!JSON.stringify(slice).includes('Bash ·'), 'no line in the slice');
  assert.ok(!JSON.stringify(slice).includes(a.ch.projectsDir), 'no path in the slice');

  const b = agentMirror(t, { store, root: a.root, ch: a.ch });
  await b.mirror.start();
  b.sessionStart('resume');
  const back = await b.waitRow(AGENT, (x) => x.status === 'running', 'the restored row');
  assert.equal(back.title, 'Restart me');
  assert.equal(back.tool_use_id, useId);
  const n0 = body.records.length;
  body.assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'echo two', description: 'Second' }, id: 'toolu_01Two' }]);
  b.fx.appendAgent(AGENT, body.records.slice(n0));
  await b.waitRow(AGENT, (x) => x.meta.tools === 2 && x.line === 'Bash · echo two', 'the resumed tail');
  const viaOld = await b.agent(useId, {});
  assert.equal(viaOld.agent.id, AGENT, 'the alias survived the restart');
  await b.mirror.stop();
});

test('a finished row goes FINISHED_KEEP_MS after it ended, and its first id then answers null', async (t) => {
  const clock = fakeClock();
  const h = await started(t, { clock });
  const useId = 'toolu_01Keep';
  h.publish('PreToolUse', { tool: { name: 'Agent', use_id: useId, input: { description: 'Keep me' } }, ts: clock.now() });
  h.publish('PostToolUse', { tool: { name: 'Agent', use_id: useId, input: { description: 'Keep me' } }, result: { ok: true, fields: { agentId: AGENT, isAsync: true, status: 'async_launched' } }, ts: clock.now() });
  assert.equal(h.row(AGENT).status, 'running');
  assert.equal((await h.agent(useId, {})).agent.id, AGENT);
  h.publish('SubagentStop', { agent: { id: AGENT, type: 'general-purpose' }, stop: { last_assistant_message: 'bye' }, ts: clock.now() });
  await h.waitRow(AGENT, (x) => x.status === 'done');
  clock.advance(agents.FINISHED_KEEP_MS - 1000);
  assert.ok(h.row(AGENT), 'still kept');
  clock.advance(2000);
  assert.equal(h.row(AGENT), null, 'removed');
  assert.equal(await h.agent(useId, {}), null, 'the alias went with the row');
  await h.mirror.stop();
});

// ── catch-up, stop ───────────────────────────────────────────────────────────

test('a catch-up replay of a finished agent starts no tail', async (t) => {
  const h = agentMirror(t);
  const r = h.records({ start: Date.now() - 10 * 60 * 1000 }); // older than REPLAY_AGE_MS, kept (FINISHED_KEEP_MS)
  const useId = launchTurn(h, r);
  r.assistant(['Launched.']);
  r.turnDuration({ durationMs: 10 });
  h.fx.agentNotification(r, { agentId: AGENT, toolUseId: useId, result: 'Old result.' });
  r.assistant(['Noted.']);
  r.turnDuration({ durationMs: 10 });
  h.ch.writeTranscript(S1, r.records);
  h.fx.writeAgent(AGENT, agentBody(h, { n: 2 }).records);
  await h.mirror.start();
  h.sessionStart('resume');
  const done = await h.waitRow(AGENT, (x) => x.status === 'done', 'the replayed row, ended');
  assert.equal(done.line, '“Old result.”');
  await sleep(400);
  assert.equal(h.tailers.filter((x) => x.kind === 'agents').length, 0, 'no tail was started');
  assert.equal(h.mirror.snapshot({}).diagnostics.agents.tails, 0);
  await h.mirror.stop();
});

test('stop() closes every tail and stream, and no tailer is stopped inside its own callback', async (t) => {
  const h = await started(t);
  const r = h.records();
  launchTurn(h, r);
  launchTurn(h, r, { agentId: AGENT2, useId: 'toolu_01Agent2', promptId: 'p-two' });
  h.ch.writeTranscript(S1, r.records);
  h.fx.writeAgent(AGENT, agentBody(h, { n: 1 }).records);
  h.fx.writeAgent(AGENT2, agentBody(h, { agentId: AGENT2, n: 1 }).records);
  await h.waitRow(AGENT, (x) => x.meta.tools === 1);
  await h.waitRow(AGENT2, (x) => x.meta.tools === 1);
  await h.agent(AGENT, {});
  const d = h.mirror.snapshot({}).diagnostics.agents;
  assert.deepEqual(d, { running: 2, tails: 2, streams: 1 });
  await h.mirror.stop();
  const mine = h.tailers.filter((x) => x.kind === 'agents');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((x) => x.stopped), 'every tail stopped');
  assert.ok(h.tailers.every((x) => x.inCallbackCalls === 0));
});

// ── the tail cap ─────────────────────────────────────────────────────────────

test('at most AGENT_TAILS_MAX tails; a running row past the cap keeps its row and is tailed when a slot frees', async (t) => {
  const h = await started(t);
  const r = h.records();
  const n = agents.AGENT_TAILS_MAX + 2;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `a${String(i).padStart(16, '0')}`;
    ids.push(id);
    launchTurn(h, r, { agentId: id, useId: `toolu_01Cap${i}`, promptId: `p-cap${i}` });
  }
  h.ch.writeTranscript(S1, r.records);
  await waitUntil(() => h.rows().filter((x) => x.status === 'running').length === n, { ...WAIT, what: 'every row' });
  await waitUntil(() => h.tailers.length === agents.AGENT_TAILS_MAX, { ...WAIT, what: 'the cap reached' });
  await sleep(100);
  assert.equal(h.tailers.length, agents.AGENT_TAILS_MAX, 'no tail past the cap');
  assert.deepEqual(h.mirror.snapshot({}).diagnostics.agents, { running: n, tails: agents.AGENT_TAILS_MAX, streams: 0 });
  const tailed = new Set(h.tailers.map((x) => x.file));
  const first = ids.find((id) => [...tailed].some((f) => f.endsWith(`agent-${id}.jsonl`)));
  h.publish('SubagentStop', { agent: { id: first, type: 'general-purpose' }, stop: { last_assistant_message: 'done' } });
  await h.waitRow(first, (x) => x.status === 'done');
  await waitUntil(() => h.tailers.length === agents.AGENT_TAILS_MAX + 1, { ...WAIT, what: 'a waiting row takes the slot' });
  assert.equal(h.mirror.snapshot({}).diagnostics.agents.tails, agents.AGENT_TAILS_MAX);
  await h.mirror.stop();
});

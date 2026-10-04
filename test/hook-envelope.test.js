// Envelope v1 (lib/hooks/envelope.js) and the hook runtime that posts it: the
// dispatcher (lib/hooks/index.js) and the `mirror` and `ask` subcommands
// (spec §1.3, C38).
//
// Three parts:
//
//   1. THE ENVELOPE. One fixture payload per registered event, shaped like what
//      Claude Code 2.1.284–2.1.287 hands a hook (validation V3), so every event
//      the template registers is covered and a new one fails until it has a
//      fixture. Then the bounding: lengths only for the editing tools, the 8 KB
//      projection, the 32 KB body, the result.fields allowlist, every cap; and
//      the environment: CLAUDE_PID and CLAUDE_CODE_ENTRYPOINT are the only two
//      values read (a recording proxy proves it), so the messaging token never
//      leaves the hook.
//
//   2. THE SUBCOMMANDS IN PROCESS, against a recording client: a hook never
//      spawns a daemon (no portfile → no call at all; otherwise an explicit
//      port and noSpawn), SessionEnd's tighter deadline and socket timeout,
//      report mode's silence under an SDK host.
//
//   3. THE DISPATCHER AS A SUBPROCESS (it calls process.exit), against a stub
//      daemon on loopback: the mirror hook posts once and exits within its
//      deadline even when the daemon never finishes answering; unknown
//      subcommands and `halt` exit 0 without a word; ask posts and prints
//      nothing; the toggle gate; hook.log carries ids and outcomes only.
//      Wall-clock bounds run only under WEB_CHAT_PERF=1 (spec §10.1); the
//      default run asserts that the process ended itself and logs the times.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const {
  hookEnvelope, isSdkEntrypoint, promptOf, EVENTS, CAPS, ENVELOPE_MAX_BYTES, RESULT_FIELDS, VERSION,
} = require('../lib/hooks/envelope');
const mirror = require('../lib/hooks/mirror');
const ask = require('../lib/hooks/ask');
const client = require('../lib/client');
const { inputHash, projectToolInput, MIRROR_MAX_BYTES } = require('../lib/core/tool-input');
const { hookEvents, hookHandlers } = require('../lib/setup/registration');
const { writePortfileAt } = require('../lib/core/portfiles');
const { tmpRoot, waitUntil } = require('../test-support/helpers');

const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
const PERF = process.env.WEB_CHAT_PERF === '1';

// ── fixtures ────────────────────────────────────────────────────────────────

const SID = '2f8c6a2e-7a8b-4d0e-9a51-0c1d2e3f4a5b';
const CWD = '/Users/someone/Dev/proj';
const TRANSCRIPT = `/Users/someone/.claude/projects/-Users-someone-Dev-proj/${SID}.jsonl`;
const NOW = 1790000000123;

function payload(event, extra = {}) {
  return { session_id: SID, transcript_path: TRANSCRIPT, cwd: CWD, hook_event_name: event, prompt_id: 'c0ffee00-prompt', ...extra };
}

const BASH_INPUT = { command: 'npm test', description: 'Run the tests' };

// One per registered event: what each carries beyond the common fields (V3).
const FIXTURES = {
  SessionStart: payload('SessionStart', { source: 'startup', model: 'claude-model-x' }),
  SessionEnd: payload('SessionEnd', { reason: 'prompt_input_exit' }),
  UserPromptSubmit: payload('UserPromptSubmit', { prompt: 'fix the status bar', permission_mode: 'default' }),
  PreToolUse: payload('PreToolUse', {
    tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_01A', permission_mode: 'default',
  }),
  PostToolUse: payload('PostToolUse', {
    tool_name: 'Bash', tool_input: BASH_INPUT, tool_use_id: 'toolu_01A', duration_ms: 812,
    tool_response: { stdout: 'STDOUT-TEXT', stderr: 'STDERR-TEXT', interrupted: false, isImage: false, backgroundTaskId: 'b7' },
  }),
  PostToolUseFailure: payload('PostToolUseFailure', {
    tool_name: 'Read', tool_input: { file_path: '/Users/someone/Dev/proj/missing.js' }, tool_use_id: 'toolu_01B',
    error: 'File does not exist.', is_interrupt: false, duration_ms: 3,
  }),
  PermissionRequest: payload('PermissionRequest', {
    tool_name: 'Bash', tool_input: { command: 'rm -rf dist && npm run build' }, permission_mode: 'default',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'localSettings' }],
  }),
  SubagentStop: payload('SubagentStop', {
    agent_id: 'a1b2c3d4', agent_type: 'Explore', last_assistant_message: 'Found three files.',
    agent_transcript_path: `/Users/someone/.claude/projects/-Users-someone-Dev-proj/${SID}/subagents/agent-a1b2c3d4.jsonl`,
    background_tasks: [], session_crons: [],
  }),
  PreCompact: payload('PreCompact', { trigger: 'auto', custom_instructions: 'CUSTOM-INSTRUCTIONS' }),
  Stop: payload('Stop', {
    last_assistant_message: 'Done — the bar now shows the step.', stop_hook_active: false, session_crons: [],
    background_tasks: [{ id: 'b7', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' }],
  }),
  StopFailure: payload('StopFailure', { error: 'model_not_found', last_assistant_message: '', effort: 'high' }),
  PostToolBatch: payload('PostToolBatch', {
    tool_calls: [{ tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 'toolu_9', tool_response: {} }],
  }),
};

// Which sections each event fills; every other section is null.
const SECTIONS = {
  SessionStart: ['session'],
  SessionEnd: ['session'],
  UserPromptSubmit: ['prompt'],
  PreToolUse: ['tool'],
  PostToolUse: ['tool', 'result'],
  PostToolUseFailure: ['tool', 'result'],
  PermissionRequest: ['tool'],
  SubagentStop: ['agent', 'stop'],
  PreCompact: ['compact'],
  Stop: ['stop'],
  StopFailure: ['stop'],
};
const ALL_SECTIONS = ['agent', 'tool', 'result', 'session', 'compact', 'stop', 'prompt', 'ask'];

// Envelope v1's fields, in order — spec §1.3, verbatim.
const V1_KEYS = [
  'v', 'event', 'ts', 'session_id', 'transcript_path', 'cwd', 'prompt_id', 'claude_pid', 'entrypoint',
  'permission_mode', 'agent', 'tool', 'result', 'session', 'compact', 'stop', 'prompt', 'ask',
];

const ENV = { CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli' };

function build(event, extra, env = ENV) {
  return hookEnvelope({ ...FIXTURES[event], ...extra }, env, { now: NOW });
}

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const chars = (s) => Array.from(s).length;

// The registered handlers, by the subcommand they run.
function eventsOf(subs) {
  return [...new Set(hookHandlers().filter((h) => subs.includes(h.sub)).map((h) => h.event))].sort();
}

// ── 1. the envelope ─────────────────────────────────────────────────────────

test('envelope: every registered event has a fixture, and the ones that reach Node build an envelope v1', () => {
  const registered = hookEvents();
  assert.ok(registered.length >= 12, 'the template is the one that registers the mirror');
  for (const event of registered) {
    assert.ok(FIXTURES[event], `no fixture payload for the registered event ${event} — add one`);
    const nodeSubs = hookHandlers().filter((h) => h.event === event && h.sub !== 'halt');
    const env = hookEnvelope(FIXTURES[event], ENV, { now: NOW });
    if (!nodeSubs.length) {
      assert.equal(env, null, `${event} runs only the halt (sh), so no envelope describes it`);
      continue;
    }
    assert.ok(env, `${event} builds an envelope`);
    assert.deepEqual(Object.keys(env), V1_KEYS, `${event}: envelope v1's fields, in order`);
    assert.equal(env.v, VERSION);
    assert.equal(env.v, 1);
    assert.equal(env.event, event);
    assert.equal(env.ts, NOW, 'ts is when stdin ended, as handed in');
    assert.equal(env.session_id, SID);
    assert.equal(env.transcript_path, TRANSCRIPT);
    assert.equal(env.cwd, CWD);
    assert.equal(env.prompt_id, 'c0ffee00-prompt');
    assert.equal(env.claude_pid, 4242);
    assert.equal(env.entrypoint, 'cli');
    assert.equal(env.ask, null, 'only the asks domain associates an ask, in process');
    assert.equal(Object.hasOwn(env, 'synthetic'), false, 'a hook never builds a synthetic envelope');
    for (const s of ALL_SECTIONS) {
      if (SECTIONS[event].includes(s)) assert.ok(env[s] && typeof env[s] === 'object', `${event} fills ${s}`);
      else assert.equal(env[s], null, `${event} leaves ${s} null`);
    }
    assert.ok(bytes(env) <= ENVELOPE_MAX_BYTES);
  }
});

test('envelope: EVENTS is exactly the events the template sends to a Node subcommand', () => {
  assert.deepEqual([...EVENTS].sort(), eventsOf(['turn-begin', 'turn-end', 'mirror', 'ask']));
  assert.deepEqual(Object.keys(SECTIONS).sort(), [...EVENTS].sort());
});

test('envelope: what each section carries, from the fixtures', () => {
  assert.deepEqual(build('SessionStart').session,
    { source: 'startup', model: 'claude-model-x', title: null, reason: null, agent_type: null });
  assert.equal(build('SessionEnd').session.reason, 'prompt_input_exit');
  assert.deepEqual(build('UserPromptSubmit').prompt, { author: 'user', text: 'fix the status bar', task_summary: null });
  assert.equal(build('UserPromptSubmit').permission_mode, 'default');

  const pre = build('PreToolUse');
  assert.deepEqual(pre.tool, {
    name: 'Bash', use_id: 'toolu_01A', kind: 'Bash', label: 'Bash · npm test', call: 'Bash(npm test)',
    input: { command: 'npm test', description: 'Run the tests' }, input_hash: inputHash(BASH_INPUT),
  });
  assert.equal(pre.agent, null, 'the main agent\'s call names no agent');

  const post = build('PostToolUse');
  assert.deepEqual(post.result, { ok: true, duration_ms: 812, interrupted: false, error: null, fields: { backgroundTaskId: 'b7', interrupted: false } });
  assert.doesNotMatch(JSON.stringify(post), /STDOUT-TEXT|STDERR-TEXT/, 'never the output');

  const failed = build('PostToolUseFailure');
  assert.deepEqual(failed.result, { ok: false, duration_ms: 3, interrupted: false, error: 'File does not exist.', fields: {} });
  assert.deepEqual(failed.tool.input, { file_path: '/Users/someone/Dev/proj/missing.js' });

  const pr = build('PermissionRequest');
  assert.equal(pr.tool.use_id, null, 'PermissionRequest carries no tool_use_id (V3)');
  assert.equal(pr.tool.call, 'Bash(rm -rf dist && npm run build)');
  assert.equal(pr.tool.input_hash, inputHash({ command: 'rm -rf dist && npm run build' }));
  assert.doesNotMatch(JSON.stringify(pr), /localSettings/, 'permission_suggestions are not in v1');

  const sub = build('SubagentStop');
  assert.deepEqual(sub.agent, { id: 'a1b2c3d4', type: 'Explore' });
  assert.deepEqual(sub.stop, {
    last_assistant_message: 'Found three files.',
    agent_transcript_path: FIXTURES.SubagentStop.agent_transcript_path,
    background_tasks: [], error: null,
  });

  const compact = build('PreCompact');
  assert.deepEqual(compact.compact, { trigger: 'auto' });
  assert.doesNotMatch(JSON.stringify(compact), /CUSTOM-INSTRUCTIONS/, 'the user\'s compaction instructions stay in the hook');

  assert.deepEqual(build('Stop').stop, {
    last_assistant_message: 'Done — the bar now shows the step.', agent_transcript_path: null, error: null,
    background_tasks: [{ id: 'b7', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev', agent_type: null }],
  });
  assert.deepEqual(build('StopFailure').stop,
    { last_assistant_message: '', agent_transcript_path: null, background_tasks: null, error: 'model_not_found' });
});

test('envelope: a PermissionRequest hashes like the PreToolUse it waits on (deep-equal input, any key order)', () => {
  const input = { command: 'git push', description: 'Push', timeout: 60000 };
  const reordered = { timeout: 60000, description: 'Push', command: 'git push' };
  const pre = hookEnvelope(payload('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 't1' }), {}, { now: 1 });
  const req = hookEnvelope(payload('PermissionRequest', { tool_name: 'Bash', tool_input: reordered }), {}, { now: 2 });
  assert.equal(pre.tool.input_hash, req.tool.input_hash);
  assert.match(pre.tool.input_hash, /^[0-9a-f]{40}$/);
});

test('envelope: a subagent\'s tool call names its agent; an internal agent\'s SubagentStop is dropped', () => {
  const inAgent = build('PreToolUse', { agent_id: 'a1b2c3d4', agent_type: 'general-purpose' });
  assert.deepEqual(inAgent.agent, { id: 'a1b2c3d4', type: 'general-purpose' });
  // Prompt suggestion and compaction run as agents with agent_type '' and a
  // transcript path that never exists (V3): no agent the user started.
  assert.equal(build('SubagentStop', { agent_type: '' }), null);
  assert.deepEqual(build('SubagentStop', { agent_type: undefined }).agent, { id: 'a1b2c3d4', type: null });
  assert.equal(build('PreToolUse', { agent_id: '' }).agent, null);
  assert.equal(build('PreToolUse', { agent_id: 42 }).agent, null);
});

test('envelope: a task notification is the task\'s prompt, with its summary on one line', () => {
  const text = '<task-notification>\n<task-id>b7</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n'
    + '<status>completed</status>\n<summary>Background command "npm run dev"\n  completed (exit code 0)</summary>\n'
    + '</task-notification>';
  const env = build('UserPromptSubmit', { prompt: text });
  assert.equal(env.prompt.author, 'task');
  assert.equal(env.prompt.task_summary, 'Background command "npm run dev" completed (exit code 0)');
  assert.equal(env.prompt.text, text);
  const long = build('UserPromptSubmit', { prompt: `<task-notification><summary>${'s'.repeat(500)}</summary></task-notification>` });
  assert.equal(long.prompt.task_summary.length, CAPS.task_summary);
  assert.equal(build('UserPromptSubmit', { prompt: '<task-notification><status>killed</status></task-notification>' }).prompt.task_summary, null);
  // The words in a human prompt are the human's, wherever they appear.
  assert.equal(build('UserPromptSubmit', { prompt: 'explain <task-notification> please' }).prompt.author, 'user');
});

test('envelope: the prompt is read through the same chain turn-begin reads', () => {
  assert.equal(promptOf({ prompt: 'a', user_prompt: 'b' }), 'a');
  assert.equal(promptOf({ user_prompt: 'b' }), 'b');
  assert.equal(promptOf({ userPrompt: 'c' }), 'c');
  assert.equal(promptOf({ message: 'd' }), 'd');
  assert.equal(promptOf({ prompt: '', message: 'd' }), 'd');
  assert.equal(promptOf({}), '');
  assert.equal(promptOf(null), '');
  assert.equal(build('UserPromptSubmit', { prompt: undefined, user_prompt: 'legacy' }).prompt.text, 'legacy');
});

test('envelope: null for what is not a hook payload, or an event v1 does not describe', () => {
  for (const p of [null, undefined, 'PreToolUse', 42, [], [FIXTURES.PreToolUse]]) assert.equal(hookEnvelope(p, ENV), null);
  assert.equal(hookEnvelope({ ...FIXTURES.PreToolUse, hook_event_name: undefined }, ENV), null);
  for (const event of ['PostToolBatch', 'Notification', 'SubagentStart', 'MessageDisplay', 'PostCompact',
    'PermissionResolved', 'Elicitation', 'toString', '__proto__', 'constructor']) {
    assert.equal(hookEnvelope({ ...FIXTURES.PreToolUse, hook_event_name: event }, ENV), null, event);
  }
});

test('envelope: ts is the `now` handed in, else the clock', () => {
  assert.equal(hookEnvelope(FIXTURES.SessionStart, ENV, { now: 5 }).ts, 5);
  const before = Date.now();
  const ts = hookEnvelope(FIXTURES.SessionStart, ENV).ts;
  assert.ok(ts >= before && ts <= Date.now());
  assert.ok(Number.isFinite(hookEnvelope(FIXTURES.SessionStart, ENV, { now: NaN }).ts));
});

// ── bounding ──

test('bounding: Write, Edit, MultiEdit and NotebookEdit cross as a path and sizes, never their text', () => {
  const MARK = 'FILE-TEXT-MARKER';
  const text = `${MARK} é ${'x'.repeat(5000)}`;
  const cases = [
    ['Write', { file_path: '/p/a.js', content: text }, { file_path: '/p/a.js', content_bytes: Buffer.byteLength(text) }],
    ['Edit', { file_path: '/p/a.js', old_string: text, new_string: `${text}!`, replace_all: true },
      { file_path: '/p/a.js', old_string_bytes: Buffer.byteLength(text), new_string_bytes: Buffer.byteLength(text) + 1 }],
    ['MultiEdit', { file_path: '/p/a.js', edits: [{ old_string: text, new_string: 'y' }, { old_string: 'z', new_string: text }] },
      { file_path: '/p/a.js', edits_count: 2, old_string_bytes: Buffer.byteLength(text) + 1, new_string_bytes: Buffer.byteLength(text) + 1 }],
    ['NotebookEdit', { notebook_path: '/p/n.ipynb', cell_id: 'c1', new_source: text, edit_mode: 'replace' },
      { notebook_path: '/p/n.ipynb', cell_id: 'c1', new_source_bytes: Buffer.byteLength(text), edit_mode: 'replace' }],
  ];
  for (const [name, input, expected] of cases) {
    for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
      const env = build(event, { tool_name: name, tool_input: input });
      assert.deepEqual(env.tool.input, expected, `${event} ${name}`);
      assert.doesNotMatch(JSON.stringify(env), new RegExp(MARK), `${event} ${name}: the text never crosses`);
      assert.equal(env.tool.input_hash, inputHash(input), 'the hash still covers the whole input');
    }
  }
});

test('bounding: the hash covers the FULL input, which no projection keeps', () => {
  const a = build('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/p/a', content: 'aaaa' } });
  const b = build('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/p/a', content: 'bbbb' } });
  assert.deepEqual(a.tool.input, b.tool.input, 'the same projection');
  assert.notEqual(a.tool.input_hash, b.tool.input_hash, 'two different calls');
  assert.equal(build('PreToolUse', { tool_input: undefined }).tool.input_hash, null, 'no input, no hash');
});

test('bounding: tool.input is the mirror projection, at most 8 KB of JSON', () => {
  assert.equal(MIRROR_MAX_BYTES, 8 * 1024);
  const bash = build('PreToolUse', { tool_input: { command: `echo ${'c'.repeat(100000)}`, description: 'big' } });
  assert.equal(chars(bash.tool.input.command), 2000, 'a command is cut at 2,000');
  assert.ok(bytes(bash.tool.input) <= MIRROR_MAX_BYTES);
  const mcpInput = {};
  for (let i = 0; i < 100; i++) mcpInput[`k${i}`] = '\u0001'.repeat(10000);
  mcpInput.nested = { deep: 'NESTED-MARKER' };
  const mcp = build('PreToolUse', { tool_name: 'mcp__web-chat__render', tool_input: mcpInput });
  assert.ok(bytes(mcp.tool.input) <= MIRROR_MAX_BYTES);
  assert.ok(Object.keys(mcp.tool.input).length <= 16, 'an MCP tool: top-level scalars, at most 16');
  assert.doesNotMatch(JSON.stringify(mcp), /NESTED-MARKER/, 'never a nested value');
  assert.equal(mcp.tool.kind, 'MCP', 'a server name never reaches the kind');
});

test('bounding: over 32 KB, tool.input becomes {truncated: true}', () => {
  // Ten 512-character result fields of control characters (six bytes each in
  // JSON) beside a Bash call: just over the body's bound with the projected
  // input, and under it without — the rule of §1.3 is all it takes.
  const fields = {};
  for (const k of RESULT_FIELDS.filter((f) => !['isAsync', 'interrupted', 'noOutputExpected', 'backgroundedByUser'].includes(f)).slice(0, 10)) {
    fields[k] = '\u0002'.repeat(CAPS.result_field);
  }
  const input = { command: 'q'.repeat(2000), description: 'd'.repeat(300) };
  const env = build('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_response: fields });
  const projected = projectToolInput('Bash', input, { profile: 'mirror' }).input;
  assert.ok(bytes({ ...env, tool: { ...env.tool, input: projected } }) > ENVELOPE_MAX_BYTES, 'premise: over 32 KB with the input');
  assert.deepEqual(env.tool.input, { truncated: true });
  assert.ok(bytes(env) <= ENVELOPE_MAX_BYTES);
  assert.equal(Object.keys(env.result.fields).length, 10);
  for (const v of Object.values(env.result.fields)) assert.equal(v.length, CAPS.result_field, 'nothing else was cut');
  assert.match(env.tool.label, /^Bash · q+…$/, 'the label stays');
  assert.equal(env.tool.input_hash, inputHash(input), 'and so does the hash of the whole input');
  // Under the bound, the projection is left alone.
  assert.deepEqual(build('PostToolUse').tool.input, BASH_INPUT);
});

test('bounding: no payload, however long or strange its strings, makes a body over 32 KB', () => {
  const evil = (n) => '\u0001'.repeat(n); // six JSON bytes a character
  const wide = (n) => '漢'.repeat(n); // three UTF-8 bytes a character
  const tasks = Array.from({ length: 80 }, (_, i) => ({
    id: evil(300), type: evil(300), status: evil(300), description: evil(3000), command: evil(3000), agent_type: evil(300), n: i,
  }));
  const response = {};
  for (const k of RESULT_FIELDS) response[k] = evil(3000);
  const huge = {
    session_id: evil(5000), transcript_path: evil(5000), cwd: evil(5000), prompt_id: evil(5000), permission_mode: evil(5000),
    agent_id: evil(5000), agent_type: evil(5000), tool_name: evil(5000), tool_use_id: evil(5000),
    tool_input: { command: evil(100000), description: evil(100000) }, tool_response: response, error: evil(5000),
    source: evil(5000), model: evil(5000), title: evil(5000), reason: evil(5000), trigger: evil(5000),
    last_assistant_message: evil(50000), agent_transcript_path: evil(5000), background_tasks: tasks,
  };
  const env = { CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: evil(5000) };
  for (const event of EVENTS) {
    for (const prompt of [evil(40000), wide(40000)]) {
      const e = hookEnvelope({ ...huge, prompt, hook_event_name: event }, env, { now: NOW });
      assert.ok(e, event);
      assert.ok(bytes(e) <= ENVELOPE_MAX_BYTES, `${event}: ${bytes(e)} bytes`);
      assert.equal(chars(e.session_id), CAPS.session_id, `${event}: identity is never cut below its cap`);
      assert.equal(chars(e.cwd), CAPS.cwd);
      if (e.tool) assert.equal(chars(e.tool.name), CAPS.tool_name);
    }
  }
  // A long prompt of wide characters keeps as much as fits — still a prompt.
  const cjk = build('UserPromptSubmit', { prompt: wide(CAPS.prompt_text) });
  assert.ok(bytes(cjk) <= ENVELOPE_MAX_BYTES);
  assert.ok(chars(cjk.prompt.text) >= 4096, 'cut to fit, not dropped');
  assert.ok(cjk.prompt.text.startsWith('漢漢漢'));
});

test('bounding: result.fields carries only the allowlist\'s scalars, strings at most 512', () => {
  const response = {
    stdout: 'OUT', stderr: 'ERR', file: { content: 'FILE-CONTENT' }, structuredPatch: [{ lines: ['PATCH'] }],
    content: [{ type: 'text', text: 'RESULT-TEXT' }], originalFile: 'ORIGINAL',
    backgroundTaskId: 'b1', agentId: { id: 'not-a-scalar' }, isAsync: true, status: 'async_launched',
    outputFile: `/tmp/${'o'.repeat(2000)}`, runId: 'r1', transcriptDir: '/t', taskId: 't1', taskType: 'local_bash',
    workflowName: 'wf', persistedOutputPath: '/p', persistedOutputSize: 12345, totalDurationMs: 99.5,
    totalToolUseCount: 3, interrupted: false, noOutputExpected: true, timedOutAfterMs: Infinity, backgroundedByUser: false,
    unlisted: 'UNLISTED',
  };
  const { fields } = build('PostToolUse', { tool_response: response }).result;
  assert.deepEqual(Object.keys(fields).sort(), RESULT_FIELDS.filter((k) => !['agentId', 'timedOutAfterMs'].includes(k)).sort(),
    'every allowlisted scalar, nothing else (an object or a non-finite number is not a scalar)');
  assert.equal(chars(fields.outputFile), CAPS.result_field);
  assert.equal(fields.persistedOutputSize, 12345);
  assert.equal(fields.isAsync, true);
  assert.doesNotMatch(JSON.stringify(fields), /OUT|ERR|FILE-CONTENT|PATCH|RESULT-TEXT|ORIGINAL|UNLISTED|not-a-scalar/);
  assert.equal(RESULT_FIELDS.length, 18, 'the spec\'s list (§1.3)');
  assert.deepEqual(build('PostToolUse', { tool_response: 'a string response' }).result.fields, {});
  assert.deepEqual(build('PostToolUseFailure').result.fields, {});
});

test('bounding: every cap, counted in characters, never splitting one', () => {
  const e = build('Stop', {
    session_id: 's'.repeat(300), transcript_path: 't'.repeat(3000), cwd: 'c'.repeat(3000),
    prompt_id: 'p'.repeat(300), permission_mode: 'm'.repeat(300),
    last_assistant_message: 'r'.repeat(5000), error: 'e'.repeat(1000),
  }, { CLAUDE_PID: '77', CLAUDE_CODE_ENTRYPOINT: 'x'.repeat(100) });
  assert.equal(e.session_id.length, 100);
  assert.equal(e.transcript_path.length, 1024);
  assert.equal(e.cwd.length, 1024);
  assert.equal(e.prompt_id.length, CAPS.prompt_id);
  assert.equal(e.permission_mode.length, CAPS.permission_mode);
  assert.equal(e.entrypoint.length, 40);
  assert.equal(e.stop.last_assistant_message.length, 4000);
  assert.equal(e.stop.error.length, 500);

  // Fifty of seventy tasks, each field at its cap: a big Stop that still fits.
  const tasks = build('Stop', {
    last_assistant_message: 'short',
    background_tasks: Array.from({ length: 70 }, (_, i) => ({
      id: `b${i}`, type: 'shell', status: 'running', description: 'd'.repeat(500), command: 'k'.repeat(500), agent_type: 'a'.repeat(100),
    })),
  }).stop.background_tasks;
  assert.equal(tasks.length, 50);
  assert.equal(tasks[0].description.length, 200);
  assert.equal(tasks[0].command.length, 200);
  assert.equal(tasks[0].agent_type.length, 60);
  assert.equal(tasks[49].id, 'b49', 'the first fifty');

  const failed = build('PostToolUseFailure', { error: 'e'.repeat(1000) });
  assert.equal(failed.result.error.length, 500);

  const prompt = build('UserPromptSubmit', { prompt: 'p'.repeat(20000) });
  assert.equal(prompt.prompt.text.length, 16384, '16 KiB, read as characters (§1.3)');

  // A surrogate pair straddling a cap is kept whole or dropped whole.
  const emoji = '😀'.repeat(150);
  const sid = build('SessionStart', { session_id: emoji }).session_id;
  assert.equal(chars(sid), 100);
  assert.equal(sid, '😀'.repeat(100));
  assert.doesNotThrow(() => Buffer.from(sid, 'utf8').toString('utf8'));
  assert.equal(build('SessionStart', { session_id: 42 }).session_id, null, 'a non-string is no value');
});

test('bounding: a background task list keeps objects only, and no field it does not name', () => {
  const env = build('Stop', { background_tasks: ['b1', null, 7, { id: 'b2', type: 'subagent', status: 'done', agent_type: 'Explore', output: 'OUTPUT' }] });
  assert.deepEqual(env.stop.background_tasks,
    [{ id: 'b2', type: 'subagent', status: 'done', description: null, command: null, agent_type: 'Explore' }]);
  assert.equal(build('Stop', { background_tasks: 'not a list' }).stop.background_tasks, null);
});

// ── the environment ──

test('environment: CLAUDE_PID and CLAUDE_CODE_ENTRYPOINT are the only values read', () => {
  const reads = new Set();
  const values = {
    CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
    CLAUDE_CODE_MESSAGING_TOKEN: 'MESSAGING-TOKEN-VALUE', CLAUDE_CODE_SESSION_ID: 'SESSION-ENV-VALUE',
    ANTHROPIC_API_KEY: 'API-KEY-VALUE', HOME: '/HOME-VALUE', WEB_CHAT_PORT: '5999', CLAUDE_EFFORT: 'EFFORT-VALUE',
  };
  const env = new Proxy(values, {
    get(t, k) { reads.add(k); return t[k]; },
    has(t, k) { reads.add(k); return k in t; },
    ownKeys(t) { reads.add('(all keys)'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, k) { reads.add(k); return Reflect.getOwnPropertyDescriptor(t, k); },
  });
  for (const event of EVENTS) {
    const out = JSON.stringify(hookEnvelope(FIXTURES[event], env, { now: NOW }));
    for (const v of ['MESSAGING-TOKEN-VALUE', 'SESSION-ENV-VALUE', 'API-KEY-VALUE', 'HOME-VALUE', '5999', 'EFFORT-VALUE']) {
      assert.ok(!out.includes(v), `${event}: ${v} never leaves the hook`);
    }
  }
  assert.ok(isSdkEntrypoint(env));
  assert.deepEqual([...reads].sort(), ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID']);
  assert.doesNotMatch(fs.readFileSync(require.resolve('../lib/hooks/envelope'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    /process\.env/, 'the builder reads the environment it is handed, never process.env');
});

test('environment: claude_pid is an integer of at least 2, or null', () => {
  const pid = (v) => build('SessionStart', {}, { CLAUDE_PID: v }).claude_pid;
  assert.equal(pid('4242'), 4242);
  assert.equal(pid('2'), 2);
  assert.equal(pid(77), 77);
  for (const v of ['1', '0', '-5', '42x', ' 42', '4.2', '', '1e3', '99999999999999999', undefined, null, 1.5, {}]) {
    assert.equal(pid(v), null, `CLAUDE_PID=${JSON.stringify(v)}`);
  }
  assert.equal(hookEnvelope(FIXTURES.SessionStart, undefined, { now: NOW }).claude_pid, null, 'no environment at all');
  assert.equal(hookEnvelope(FIXTURES.SessionStart, null, { now: NOW }).entrypoint, null);
});

test('environment: the entrypoint, and which of them are an SDK host', () => {
  const entry = (v) => build('SessionStart', {}, { CLAUDE_CODE_ENTRYPOINT: v }).entrypoint;
  assert.equal(entry('cli'), 'cli');
  assert.equal(entry('sdk-ts'), 'sdk-ts');
  assert.equal(entry(''), null);
  assert.equal(entry(undefined), null);
  assert.equal(entry('e'.repeat(100)).length, 40);
  for (const v of ['sdk-cli', 'sdk-ts', 'sdk-py', 'sdk']) assert.equal(isSdkEntrypoint({ CLAUDE_CODE_ENTRYPOINT: v }), true, v);
  for (const v of ['cli', 'claude-vscode', 'SDK-cli', ' sdk-cli', '', undefined]) {
    assert.equal(isSdkEntrypoint({ CLAUDE_CODE_ENTRYPOINT: v }), false, String(v));
  }
  assert.equal(isSdkEntrypoint(undefined), false);
  assert.equal(isSdkEntrypoint(null), false);
});

// ── 2. the subcommands, in process ──────────────────────────────────────────

// Records what the hook hands lib/client. The handlers call client.post through
// the module object, so this sees every call.
function recordClient(t, reply = async () => ({ ok: true })) {
  const calls = [];
  const orig = client.post;
  client.post = async (p, body, opts) => { calls.push({ path: p, body, opts }); return reply(p, body, opts); };
  t.after(() => { client.post = orig; });
  return calls;
}

function projectWithPortfile(port) {
  const root = tmpRoot('wc-hookrt-');
  writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port });
  return root;
}

test('mirror (in process): one post to the intake, on an explicit port, never spawning', async (t) => {
  const calls = recordClient(t);
  const root = projectWithPortfile(45678);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const armed = [];
  const out = await mirror(FIXTURES.PreToolUse, { root, now: NOW, env: ENV, deadline: (ms) => armed.push(ms) });
  assert.equal(out, 'posted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/hooks/event');
  assert.deepEqual(calls[0].opts, { port: 45678, noSpawn: true, timeout: mirror.POST_TIMEOUT_MS });
  assert.deepEqual(calls[0].body, hookEnvelope(FIXTURES.PreToolUse, ENV, { now: NOW }));
  assert.deepEqual(armed, [], 'only SessionEnd tightens the deadline');
});

test('mirror (in process): SessionEnd arms 900 ms inside the handler and posts with a 400 ms socket timeout', async (t) => {
  const calls = recordClient(t);
  const root = projectWithPortfile(45678);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const armed = [];
  await mirror(FIXTURES.SessionEnd, { root, now: NOW, env: ENV, deadline: (ms) => armed.push(ms) });
  assert.deepEqual(armed, [900]);
  assert.equal(mirror.SESSION_END_DEADLINE_MS, 900);
  assert.equal(calls[0].opts.timeout, 400);
  assert.equal(calls[0].body.event, 'SessionEnd');
});

test('mirror (in process): no portfile, or a dead daemon, posts nothing and spawns nothing', async (t) => {
  const calls = recordClient(t);
  const bare = tmpRoot('wc-hookrt-');
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.equal(await mirror(FIXTURES.PreToolUse, { root: bare, now: NOW, env: ENV }), 'no-server');
  assert.equal(calls.length, 0, 'no portfile: the client is never called, so it cannot spawn');

  // A portfile whose pid is gone: readPortfile refuses it.
  const stale = tmpRoot('wc-hookrt-');
  t.after(() => fs.rmSync(stale, { recursive: true, force: true }));
  writePortfileAt(path.join(stale, '.web-chat'), { pid: 2 ** 22 + 12345, port: 45679 });
  assert.equal(await mirror(FIXTURES.PreToolUse, { root: stale, now: NOW, env: ENV }), 'no-server');
  assert.equal(calls.length, 0);
});

test('mirror (in process): a refused connection is "no server", through the real client', async (t) => {
  // A port nothing listens on: lib/client's noSpawn turns ECONNREFUSED into
  // NO_SERVER instead of resurrecting a daemon.
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const root = projectWithPortfile(port);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const orig = client.post;
  client.post = (p, b, o) => { seen.push(o); return orig(p, b, o); };
  t.after(() => { client.post = orig; });
  assert.equal(await mirror(FIXTURES.PostToolUse, { root, now: NOW, env: ENV }), 'no-server');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].noSpawn, true);
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'server.json')), true, 'the portfile is left as it was');
});

test('mirror (in process): a 404 is a daemon older than the intake; any other refusal is the dispatcher\'s to log', async (t) => {
  const root = projectWithPortfile(45678);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let status = 404;
  recordClient(t, async (p) => { throw new client.HttpError(status, { ok: false }, 'POST', p); });
  assert.equal(await mirror(FIXTURES.PreToolUse, { root, now: NOW, env: ENV }), 'no-intake');
  status = 400;
  await assert.rejects(() => mirror(FIXTURES.PreToolUse, { root, now: NOW, env: ENV }), (e) => e.status === 400);
});

test('mirror (in process): only the events it is registered for', async (t) => {
  const calls = recordClient(t);
  const root = projectWithPortfile(45678);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual([...mirror.MIRROR_EVENTS].sort(), eventsOf(['mirror']), 'the template\'s mirror events');
  for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure', 'PermissionRequest', 'PostToolBatch', 'Bogus']) {
    assert.equal(await mirror({ ...FIXTURES.PreToolUse, hook_event_name: event }, { root, now: NOW, env: ENV }), 'ignored', event);
  }
  assert.equal(await mirror({ ...FIXTURES.SubagentStop, agent_type: '' }, { root, now: NOW, env: ENV }), 'dropped');
  assert.equal(calls.length, 0);
});

test('ask (in process): report mode posts the request; an SDK host gets nothing at all', async (t) => {
  const calls = recordClient(t);
  const root = projectWithPortfile(45678);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(eventsOf(['ask']), ['PermissionRequest']);
  assert.equal(await ask(FIXTURES.PermissionRequest, { root, now: NOW, env: ENV }), 'posted');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { port: 45678, noSpawn: true, timeout: mirror.POST_TIMEOUT_MS });
  assert.equal(calls[0].body.event, 'PermissionRequest');
  assert.equal(calls[0].body.ask, null);
  for (const entry of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
    assert.equal(await ask(FIXTURES.PermissionRequest, { root, now: NOW, env: { ...ENV, CLAUDE_CODE_ENTRYPOINT: entry } }), 'sdk');
  }
  assert.equal(await ask(FIXTURES.PreToolUse, { root, now: NOW, env: ENV }), 'ignored');
  assert.equal(calls.length, 1, 'nothing more was posted');
});

// ── 3. the dispatcher, as a subprocess ──────────────────────────────────────

function mkHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hookrt-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// A daemon stand-in on loopback that records every request. `respond` takes
// over the answer (the default is 200 {ok:true}); `timers` it adds are cleared
// at teardown, and every socket is destroyed so a never-ending answer cannot
// hold the server open.
async function stubDaemon(t, respond) {
  const requests = [];
  const sockets = new Set();
  const timers = new Set();
  const server = http.createServer((req, res) => {
    const arrivedAt = Date.now();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const rec = { method: req.method, url: req.url, headers: req.headers, body, arrivedAt, closedAt: null };
      requests.push(rec);
      req.socket.on('close', () => { rec.closedAt = Date.now(); });
      res.on('error', () => {});
      if (respond) { respond(req, res, timers); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const x of timers) clearInterval(x);
    for (const s of sockets) s.destroy();
    return new Promise((r) => server.close(r));
  });
  return { port: server.address().port, requests };
}

// An answer that starts and never ends, a byte at a time: the client's socket
// timeout never fires, so only the hook's own deadline can end it.
function trickle(req, res, timers) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"ok":');
  const iv = setInterval(() => { res.write(' '); }, 100);
  timers.add(iv);
  req.socket.on('close', () => clearInterval(iv));
}

// Run the real bin as Claude Code does: the payload on stdin, the environment
// given. Resolves when it exits; SIGKILLed (and reported so) if it outlives
// killAfterMs.
function runHook(args, { cwd, env = {}, input, killAfterMs = 20000, nodeArgs = [] }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, HOOK_BIN, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.on('error', () => {}); // an unknown subcommand exits before reading
    const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      resolve({ status, signal, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

// A project the hook will find (payload.cwd), with a portfile naming the stub.
function hookProject(t, port) {
  const root = tmpRoot('wc-hookrt-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (port) writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port });
  return root;
}

const CHILD_ENV = (home, extra = {}) => ({
  HOME: home, USERPROFILE: home, CLAUDE_PID: '4242', CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_MESSAGING_TOKEN: 'MESSAGING-TOKEN-VALUE', CLAUDE_CODE_SESSION_ID: SID, ...extra,
});

test('dispatcher: an unknown subcommand, and every `halt`, exits 0 at once without a word', async (t) => {
  const stub = await stubDaemon(t);
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  for (const args of [['bogus'], ['halt', 'pre'], ['halt', 'post'], ['halt', 'batch'], [], ['constructor'], ['__proto__']]) {
    const r = await runHook(args, { cwd: root, env: CHILD_ENV(home), input: { ...FIXTURES.PreToolUse, cwd: root } });
    assert.equal(r.status, 0, `${args.join(' ')}: exit 0`);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, '', `${args.join(' ')}: no output`);
    assert.equal(r.stderr, '', `${args.join(' ')}: nothing on stderr`);
  }
  assert.equal(stub.requests.length, 0, 'halt is the sh script\'s; the Node dispatcher does nothing for it');
});

test('dispatcher: the mirror hook posts its envelope once, prints nothing and exits 0', async (t) => {
  const stub = await stubDaemon(t);
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  const before = Date.now();
  const r = await runHook(['mirror'], { cwd: os.tmpdir(), env: CHILD_ENV(home), input: { ...FIXTURES.PreToolUse, cwd: root } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(stub.requests.length, 1);
  const [req] = stub.requests;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/api/hooks/event');
  assert.equal(req.headers.origin, undefined, 'a hook is no browser: no Origin');
  assert.equal(req.headers['sec-fetch-mode'], undefined);
  const env = req.body;
  assert.deepEqual(Object.keys(env), V1_KEYS);
  assert.equal(env.event, 'PreToolUse');
  assert.ok(env.ts >= before && env.ts <= Date.now(), 'ts: when the hook read stdin');
  assert.equal(env.cwd, root);
  assert.equal(env.claude_pid, 4242);
  assert.equal(env.entrypoint, 'cli');
  assert.deepEqual(env.tool, hookEnvelope({ ...FIXTURES.PreToolUse, cwd: root }, ENV, { now: env.ts }).tool);
  const wire = JSON.stringify(req);
  assert.ok(!wire.includes('MESSAGING-TOKEN-VALUE'), 'the messaging token never leaves the hook');
});

test('dispatcher: the mirror hook ends itself when the daemon never finishes answering', async (t) => {
  const stub = await stubDaemon(t, trickle);
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  const r = await runHook(['mirror'], { cwd: root, env: CHILD_ENV(home), input: { ...FIXTURES.PostToolUse, cwd: root } });
  assert.equal(r.signal, null, 'it was not killed: it exited by itself');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(stub.requests.length, 1, 'posted once, and never retried');
  // The answer was still trickling and the socket never idled, so the client
  // could not have given up: the hard exit is what ended the process.
  await waitUntil(() => stub.requests[0].closedAt !== null, { what: 'the hook\'s socket to close', timeout: 5000 });
  const held = stub.requests[0].closedAt - stub.requests[0].arrivedAt;
  t.diagnostic(`process ${r.ms} ms; request held ${held} ms (hard exit 2500 ms)`);
  if (PERF) assert.ok(held < 2500 + 1000, `held ${held} ms`);
});

test('dispatcher: SessionEnd ends itself inside the 1.5 s budget Claude Code gives it', async (t) => {
  const stub = await stubDaemon(t, trickle);
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  const r = await runHook(['mirror'], { cwd: root, env: CHILD_ENV(home), input: { ...FIXTURES.SessionEnd, cwd: root } });
  assert.equal(r.signal, null);
  assert.equal(r.status, 0);
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].body.event, 'SessionEnd');
  await waitUntil(() => stub.requests[0].closedAt !== null, { what: 'the hook\'s socket to close', timeout: 5000 });
  const held = stub.requests[0].closedAt - stub.requests[0].arrivedAt;
  t.diagnostic(`process ${r.ms} ms; request held ${held} ms (SessionEnd deadline 900 ms)`);
  if (PERF) assert.ok(held < 900 + 500, `held ${held} ms`);
});

test('dispatcher: a handler that names its own hard exit replaces the table\'s (the ask bridge: none)', async (t) => {
  // Tranche 4's ask bridge waits for an answer on its own 590 s deadline and
  // sets deadlineMs = null in ask.js, a file it owns, never this dispatcher's
  // table. A preload stands in for that edit here.
  const stub = await stubDaemon(t, trickle);
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hookrt-preload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = (name, value) => {
    const file = path.join(dir, `${name}.js`);
    fs.writeFileSync(file, `require(${JSON.stringify(require.resolve('../lib/hooks/ask'))}).deadlineMs = ${value};\n`);
    return ['--require', file];
  };
  const input = { ...FIXTURES.PermissionRequest, cwd: root };

  const none = await runHook(['ask'], { cwd: root, env: CHILD_ENV(home), input, nodeArgs: preload('none', 'null'), killAfterMs: 4500 });
  assert.equal(none.signal, 'SIGKILL', 'no hard exit: it waited on the answer until it was stopped, past the table\'s 2.5 s');
  assert.equal(stub.requests.length, 1);

  const own = await runHook(['ask'], { cwd: root, env: CHILD_ENV(home), input, nodeArgs: preload('own', '300') });
  assert.equal(own.signal, null, 'its own hard exit ended it');
  assert.equal(own.status, 0);
  await waitUntil(() => stub.requests[1] && stub.requests[1].closedAt !== null, { what: 'the second hook\'s socket to close', timeout: 5000 });
  const held = stub.requests[1].closedAt - stub.requests[1].arrivedAt;
  t.diagnostic(`request held ${held} ms (the handler's own hard exit, 300 ms)`);
  if (PERF) assert.ok(held < 300 + 700, `held ${held} ms`);
});

test('dispatcher: with no daemon the mirror hook exits 0 and starts none', async (t) => {
  const home = mkHome(t);
  const root = hookProject(t, null);
  const r = await runHook(['mirror'], { cwd: root, env: CHILD_ENV(home), input: { ...FIXTURES.PreToolUse, cwd: root } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'server.json')), false, 'no daemon was spawned into the project');
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'hook.log')), false, 'no daemon is not an error');
});

test('dispatcher: the toggle gate stops the hook before it posts', async (t) => {
  const stub = await stubDaemon(t);
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  const run = (input, envExtra) => runHook(['mirror'], { cwd: root, env: CHILD_ENV(home, envExtra), input: { ...input, cwd: root } });

  // Not installed: no .web-chat above the payload's cwd.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hookrt-plain-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  assert.equal((await runHook(['mirror'], { cwd: elsewhere, env: CHILD_ENV(home), input: { ...FIXTURES.PreToolUse, cwd: elsewhere } })).status, 0);

  // Off for this session (`claude-web-chat off --session`).
  fs.mkdirSync(path.join(home, '.web-chat', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.web-chat', 'sessions', `${SID}.json`), '{"enabled":false}');
  assert.equal((await run(FIXTURES.PreToolUse)).status, 0);
  assert.equal(stub.requests.length, 0, 'not installed, or off for the session: nothing posted');

  // A session id that could name a path names no session file: the hook goes on.
  fs.writeFileSync(path.join(home, '.web-chat', 'x.json'), '{"enabled":false}');
  assert.equal((await run({ ...FIXTURES.PreToolUse, session_id: '../x' })).status, 0);
  assert.equal(stub.requests.length, 1, 'the path-shaped id read no file outside sessions/');
  assert.equal(stub.requests[0].body.session_id, '../x');

  // Off for the user.
  fs.writeFileSync(path.join(home, '.web-chat', 'disabled'), '');
  assert.equal((await run({ ...FIXTURES.PreToolUse, session_id: 'other-session' })).status, 0);
  assert.equal(stub.requests.length, 1, 'off for the user: nothing more posted');
});

test('dispatcher: a refused post goes to hook.log as ids and an outcome, never content', async (t) => {
  const stub = await stubDaemon(t, (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'RESPONSE-BODY-MARKER' }));
  });
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  const input = { ...FIXTURES.PreToolUse, cwd: root, tool_input: { command: 'echo TOOL-INPUT-MARKER' } };
  const r = await runHook(['mirror'], { cwd: root, env: CHILD_ENV(home), input });
  assert.equal(r.status, 0, 'a refusal never fails the hook');
  assert.equal(r.stdout, '');
  const log = fs.readFileSync(path.join(root, '.web-chat', 'hook.log'), 'utf8');
  const lines = log.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^\\[[0-9T:.Z-]+\\] mirror PreToolUse session=${SID} tool_use=toolu_01A error http 400$`));
  assert.doesNotMatch(log, /MARKER|MESSAGING-TOKEN/);
});

test('dispatcher: ask in report mode posts, then prints nothing; under an SDK host it posts nothing', async (t) => {
  const stub = await stubDaemon(t);
  const home = mkHome(t);
  const root = hookProject(t, stub.port);
  const input = { ...FIXTURES.PermissionRequest, cwd: root };
  const r = await runHook(['ask'], { cwd: root, env: CHILD_ENV(home), input });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'no decision: Claude Code\'s own terminal prompt stands');
  assert.equal(r.stderr, '');
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].url, '/api/hooks/event');
  assert.equal(stub.requests[0].body.event, 'PermissionRequest');
  assert.equal(stub.requests[0].body.tool.call, 'Bash(rm -rf dist && npm run build)');

  for (const entry of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
    const sdk = await runHook(['ask'], { cwd: root, env: CHILD_ENV(home, { CLAUDE_CODE_ENTRYPOINT: entry }), input });
    assert.equal(sdk.status, 0);
    assert.equal(sdk.stdout, '');
  }
  assert.equal(stub.requests.length, 1, 'an SDK host\'s PermissionRequest is never reported (C38)');
});

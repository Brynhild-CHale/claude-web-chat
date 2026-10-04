// lib/hooks/envelope.js — envelope v1: what one Claude Code hook fire tells the
// daemon (spec §1.3).
//
// Every web-chat hook that reports to the daemon (the `mirror` and `ask`
// subcommands, and the turn hooks' session fields) turns Claude Code's hook
// payload into this one shape, and BOUNDS it here, in the hook, so a 5 MB Write
// never crosses the socket:
//
//   hookEnvelope(payload, env, {now}) → envelope | null
//
//   {
//     v: 1, event, ts,                       ts: when stdin ended (`now`)
//     session_id, transcript_path, cwd,      strings, capped 100 / 1024 / 1024
//     prompt_id, claude_pid, entrypoint, permission_mode,
//     agent:   { id, type } | null           a subagent's fire
//     tool:    { name, use_id, kind, label, call, input, input_hash } | null
//     result:  { ok, duration_ms, interrupted, error, fields } | null
//     session: { source, model, title, reason, agent_type } | null
//     compact: { trigger } | null
//     stop:    { last_assistant_message, agent_transcript_path, background_tasks, error } | null
//     prompt:  { author: 'user'|'task', text, task_summary } | null
//     ask:     null                          the asks domain sets it, in process (tranche 4)
//   }
//
// null — nothing is posted — for a payload that is not an object, for an event
// envelope v1 does not know (EVENTS), and for an internal agent's SubagentStop
// (`agent_type: ''`: prompt suggestion, compaction; V3), which is no agent the
// user started.
//
// Bounding, field by field:
//
//   tool.input        lib/core/tool-input's 'mirror' projection: an allowlist per
//                     tool, never a file's text (Write, Edit, MultiEdit and
//                     NotebookEdit carry their strings' sizes as `<field>_bytes`),
//                     at most 8 KB of JSON. The projection's `truncated` list has
//                     no field in v1 and is dropped.
//   tool.input_hash   sha1 of stableStringify over the FULL input: a
//                     PermissionRequest is matched to its PreToolUse by an input
//                     deep-equal to it (V9), which no projection keeps.
//   tool.kind/label/call  toolKind, stepLabel, callLabel — the one table.
//   result.fields     scalars only, from RESULT_FIELDS (strings ≤ 512): ids,
//                     paths and counts that link a call to its task, agent or
//                     workflow. Never stdout, stderr, a file's content or a result.
//   every other string  its cap in CAPS, counted in characters (code points: an
//                     emoji is never cut in half). The spec's caps are the
//                     identity strings, prompt.text (16 KiB, read as 16,384
//                     characters: the mirror's turn machine treats a prompt the
//                     hook cut as one of at least 16,000), the reply (4,000,
//                     C28), the errors (500), the background tasks (50, with
//                     their description, command and agent type) and the task
//                     summary (200); the rest bound fields the spec leaves open
//                     at the size of what they hold: ids 100, words 40, paths
//                     1024, a model 100, a title 200, a tool name 200.
//   the whole body    at most ENVELOPE_MAX_BYTES of JSON. Over it, tool.input
//                     becomes {truncated: true}. Should that not be enough (a
//                     prompt of 16,384 CJK characters is 48 KB; fifty background
//                     tasks of control characters, which JSON spells six bytes
//                     each, are more), the longest content strings are cut to a
//                     shared limit that halves until the body fits, and then
//                     background tasks are dropped from the end. The identity
//                     fields are never cut, and their caps keep them under 18 KB
//                     whatever they hold, so the body always fits.
//
// The environment: CLAUDE_PID (`claude_pid`, an integer ≥ 2, undocumented and
// best effort, V14) and CLAUDE_CODE_ENTRYPOINT (`entrypoint`, ≤ 40) are the only
// two values read from `env`, and nothing else in it is read or sent.
// CLAUDE_CODE_MESSAGING_TOKEN is in every hook's environment (V3) and must stay
// there. `env` is a parameter, never process.env read in here, so a test can
// prove it with a recording proxy.
//
// Pure: no I/O. The `mirror` and `ask` subcommands post the envelope
// (lib/hooks/mirror.js); turn-begin and turn-end send its session fields.
//
// Dependency direction: lib/hooks → lib/core (tool-input, prompt-class).

const {
  projectToolInput, toolKind, stepLabel, callLabel, inputHash,
} = require('../core/tool-input');
const { classifyPrompt } = require('../core/prompt-class');

const VERSION = 1;

// Every event an envelope v1 describes: the twelve registered events but
// PostToolBatch, which carries only the halt (POSIX sh, never this module).
const EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'SubagentStop', 'PreCompact', 'Stop', 'StopFailure',
]);

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const RESULT_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
const SESSION_EVENTS = new Set(['SessionStart', 'SessionEnd']);
const STOP_EVENTS = new Set(['Stop', 'StopFailure', 'SubagentStop']);

// Characters (code points), except background_tasks, which counts entries.
const CAPS = Object.freeze({
  session_id: 100,
  transcript_path: 1024,
  cwd: 1024,
  prompt_id: 100,
  entrypoint: 40,
  permission_mode: 40,
  agent_id: 100,
  agent_type: 60,
  tool_name: 200,
  tool_use_id: 100,
  result_error: 500,
  result_field: 512,
  session_source: 40,
  session_model: 100,
  session_title: 200,
  session_reason: 40,
  compact_trigger: 40,
  last_assistant_message: 4000,
  agent_transcript_path: 1024,
  stop_error: 500,
  background_tasks: 50,
  task_id: 100,
  task_type: 40,
  task_status: 40,
  task_description: 200,
  task_command: 200,
  task_agent_type: 60,
  prompt_text: 16 * 1024,
  task_summary: 200,
});

const ENVELOPE_MAX_BYTES = 32 * 1024;

// What a tool's response may tell the mirror: ids, paths, counts and flags that
// link a call to the task, agent or workflow it started. Scalars only.
const RESULT_FIELDS = Object.freeze([
  'backgroundTaskId', 'agentId', 'isAsync', 'status', 'outputFile', 'runId',
  'transcriptDir', 'taskId', 'taskType', 'workflowName', 'persistedOutputPath',
  'persistedOutputSize', 'totalDurationMs', 'totalToolUseCount', 'interrupted',
  'noOutputExpected', 'timedOutAfterMs', 'backgroundedByUser',
]);

// The body's last resort cuts no content string below this many characters.
const MIN_CUT = 16;
// How much of a prompt the task summary is looked for in.
const SUMMARY_SCAN = 64 * 1024;

// ── small helpers ───────────────────────────────────────────────────────────

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// At most `max` characters of `s`; the string itself when it fits.
function clip(s, max) {
  if (s.length <= max) return s;
  const head = Array.from(s.slice(0, max * 2));
  if (head.length <= max && s.length <= max * 2) return s;
  return head.slice(0, max).join('');
}

// A string field: the payload's string cut to its cap, else null.
function str(v, max) {
  return typeof v === 'string' ? clip(v, max) : null;
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function bytesOf(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

// CLAUDE_PID, as an integer ≥ 2 (0 and 1 name no Claude Code process), else null.
function pidOf(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^[0-9]{1,15}$/.test(v)) n = Number(v);
  return Number.isSafeInteger(n) && n >= 2 ? n : null;
}

function entrypointOf(env) {
  const v = env.CLAUDE_CODE_ENTRYPOINT;
  return typeof v === 'string' && v ? v : null;
}

// Is this hook running under an SDK host (`sdk-cli`, `sdk-ts`, `sdk-py`, …)? A
// PermissionRequest fires in `-p` even for a call that is then auto-denied (V3),
// so the ask hook reports nothing there (C38). Reads CLAUDE_CODE_ENTRYPOINT only.
function isSdkEntrypoint(env) {
  const v = entrypointOf(isPlainEnv(env) ? env : {});
  return v !== null && /^sdk/.test(v);
}

function isPlainEnv(env) {
  return env !== null && typeof env === 'object';
}

// The prompt a UserPromptSubmit carries: `prompt`, or one of the names older
// payloads used, the same chain turn-begin reads.
function promptOf(payload) {
  if (!isPlain(payload)) return '';
  for (const k of ['prompt', 'user_prompt', 'userPrompt', 'message']) {
    const v = payload[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

// A task notification's `<summary>`, on one line, ≤ 200; null when it has none.
function taskSummary(text) {
  const head = text.slice(0, SUMMARY_SCAN);
  const open = '<summary>';
  const a = head.indexOf(open);
  if (a < 0) return null;
  const b = head.indexOf('</summary>', a + open.length);
  if (b < 0) return null;
  const s = head.slice(a + open.length, b).replace(/\s+/g, ' ').trim();
  return s ? clip(s, CAPS.task_summary) : null;
}

// ── sections ────────────────────────────────────────────────────────────────

function agentOf(payload) {
  const id = payload.agent_id;
  if (typeof id !== 'string' || !id) return null;
  return { id: clip(id, CAPS.agent_id), type: str(payload.agent_type, CAPS.agent_type) };
}

function toolOf(payload) {
  const name = payload.tool_name;
  const input = payload.tool_input;
  let projected;
  try {
    projected = projectToolInput(name, input, { profile: 'mirror' }).input;
  } catch {
    projected = { truncated: true };
  }
  let hash = null;
  if (input !== undefined) {
    try { hash = inputHash(input); } catch { hash = null; }
  }
  return {
    name: str(name, CAPS.tool_name),
    use_id: str(payload.tool_use_id, CAPS.tool_use_id),
    kind: toolKind(name),
    label: stepLabel(name, input),
    call: callLabel(name, input),
    input: projected,
    input_hash: hash,
  };
}

function fieldsOf(response) {
  const out = {};
  if (!isPlain(response)) return out;
  for (const k of RESULT_FIELDS) {
    if (!Object.hasOwn(response, k)) continue;
    const v = response[k];
    if (typeof v === 'string') out[k] = clip(v, CAPS.result_field);
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function resultOf(event, payload) {
  const failed = event === 'PostToolUseFailure';
  const response = isPlain(payload.tool_response) ? payload.tool_response : null;
  return {
    ok: !failed,
    duration_ms: finiteOrNull(payload.duration_ms),
    interrupted: payload.is_interrupt === true || (response !== null && response.interrupted === true),
    error: failed ? str(payload.error, CAPS.result_error) : null,
    fields: fieldsOf(response),
  };
}

function sessionOf(payload) {
  return {
    source: str(payload.source, CAPS.session_source),
    model: str(payload.model, CAPS.session_model),
    title: str(payload.title, CAPS.session_title),
    reason: str(payload.reason, CAPS.session_reason),
    agent_type: str(payload.agent_type, CAPS.agent_type),
  };
}

function taskOf(t) {
  return {
    id: str(t.id, CAPS.task_id),
    type: str(t.type, CAPS.task_type),
    status: str(t.status, CAPS.task_status),
    description: str(t.description, CAPS.task_description),
    command: str(t.command, CAPS.task_command),
    agent_type: str(t.agent_type, CAPS.task_agent_type),
  };
}

function backgroundTasksOf(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const t of list) {
    if (out.length >= CAPS.background_tasks) break;
    if (isPlain(t)) out.push(taskOf(t));
  }
  return out;
}

function stopOf(payload) {
  return {
    last_assistant_message: str(payload.last_assistant_message, CAPS.last_assistant_message),
    agent_transcript_path: str(payload.agent_transcript_path, CAPS.agent_transcript_path),
    background_tasks: backgroundTasksOf(payload.background_tasks),
    error: str(payload.error, CAPS.stop_error),
  };
}

function promptSection(payload) {
  const text = promptOf(payload);
  const task = classifyPrompt(text) === 'task-notification';
  return {
    author: task ? 'task' : 'user',
    text: clip(text, CAPS.prompt_text),
    task_summary: task ? taskSummary(text) : null,
  };
}

// ── the whole-body bound ────────────────────────────────────────────────────
// The identity fields — who, where, which call — are never cut; the content
// strings (labels, the projected input, errors, result fields, session words,
// the reply, the tasks, the prompt) are.

const CONTENT_SECTIONS = ['tool', 'result', 'session', 'compact', 'stop', 'prompt'];
const IDENTITY_IN_SECTION = { tool: new Set(['name', 'use_id', 'kind', 'input_hash']) };

// fn(holder, key, string) for every content string of the envelope.
function eachContentString(env, fn) {
  const walk = (holder, key) => {
    const v = holder[key];
    if (typeof v === 'string') fn(holder, key, v);
    else if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) walk(v, k);
  };
  for (const section of CONTENT_SECTIONS) {
    const s = env[section];
    if (!isPlain(s)) continue;
    const keep = IDENTITY_IN_SECTION[section];
    for (const k of Object.keys(s)) if (!keep || !keep.has(k)) walk(s, k);
  }
}

function fit(env) {
  let size = bytesOf(env);
  if (size <= ENVELOPE_MAX_BYTES) return env;
  if (env.tool) {
    env.tool.input = { truncated: true };
    size = bytesOf(env);
  }
  let limit = 0;
  eachContentString(env, (h, k, s) => { if (s.length > limit) limit = s.length; });
  while (size > ENVELOPE_MAX_BYTES && limit > MIN_CUT) {
    limit = Math.max(MIN_CUT, Math.floor(limit / 2));
    eachContentString(env, (h, k, s) => { if (s.length > limit) h[k] = clip(s, limit); });
    size = bytesOf(env);
  }
  const tasks = env.stop && env.stop.background_tasks;
  while (size > ENVELOPE_MAX_BYTES && Array.isArray(tasks) && tasks.length) {
    tasks.pop();
    size = bytesOf(env);
  }
  return env;
}

// ── the envelope ────────────────────────────────────────────────────────────

function hookEnvelope(payload, env, { now } = {}) {
  if (!isPlain(payload)) return null;
  const event = payload.hook_event_name;
  if (typeof event !== 'string' || !EVENTS.includes(event)) return null;
  if (event === 'SubagentStop' && payload.agent_type === '') return null;
  const e = isPlainEnv(env) ? env : {};
  const ts = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const entrypoint = entrypointOf(e);
  return fit({
    v: VERSION,
    event,
    ts,
    session_id: str(payload.session_id, CAPS.session_id),
    transcript_path: str(payload.transcript_path, CAPS.transcript_path),
    cwd: str(payload.cwd, CAPS.cwd),
    prompt_id: str(payload.prompt_id, CAPS.prompt_id),
    claude_pid: pidOf(e.CLAUDE_PID),
    entrypoint: entrypoint === null ? null : clip(entrypoint, CAPS.entrypoint),
    permission_mode: str(payload.permission_mode, CAPS.permission_mode),
    agent: agentOf(payload),
    tool: TOOL_EVENTS.has(event) ? toolOf(payload) : null,
    result: RESULT_EVENTS.has(event) ? resultOf(event, payload) : null,
    session: SESSION_EVENTS.has(event) ? sessionOf(payload) : null,
    compact: event === 'PreCompact' ? { trigger: str(payload.trigger, CAPS.compact_trigger) } : null,
    stop: STOP_EVENTS.has(event) ? stopOf(payload) : null,
    prompt: event === 'UserPromptSubmit' ? promptSection(payload) : null,
    ask: null,
  });
}

module.exports = {
  VERSION,
  EVENTS,
  CAPS,
  ENVELOPE_MAX_BYTES,
  RESULT_FIELDS,
  hookEnvelope,
  isSdkEntrypoint,
  promptOf,
};

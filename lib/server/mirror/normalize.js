// lib/server/mirror/normalize.js — transcript records → the turn machine's
// changes (spec §2.4 "Records, turns and items", §5.5, §15.4 case c).
//
// The tailer (tail.js) hands the transcripts source a batch of records; this
// turns them into exactly THE TRANSCRIPT CHANGE CONTRACT written at the head of
// turn-machine.js, in file order, plus one type of its own:
//
//   initialState()                           the state of a file read from 0
//   normalize(recs, state, {session_id})  →  {changes, state, diag}
//
//   recs     the tailer's records: [{line, obj, bad, oversize, start, end}]
//   state    a plain JSON value (initialState()'s shape). The transcripts source
//            keeps it between batches and persists it at turn boundaries (the
//            index's source slice, §2.11). It is never mutated: a new one is
//            returned. The per-message.id accumulators and the open tool calls
//            of the current turn are cleared at each opener (and at the turn's
//            turn_duration), so a boundary's state holds ids and counters only:
//            {v, version, leaf, seq, ts, turn, turn_seq, modes} and empty
//            accumulators.
//   session_id  the session the file belongs to. Accepted for the source
//            contract; nothing in the output depends on it.
//   diag     counts for this call only (the source sums them):
//            {unknown_kinds: {kind: n}, bad_lines, oversize_lines,
//             versions_seen: {version: n}}.
//
// ROUTING. Each record's kind (records.js kindOf) picks its TABLE row; the
// normalizer reads a row's `turn` route and nothing else. A row's meta, carrier
// and known consumers are meta.js's and carriers.js's (U27), run beside this one
// by the transcripts source (U28a). A kind with no row is counted in
// diag.unknown_kinds and dropped, never thrown.
//
// EVERY CHANGE carries `ts` (ms: the record's timestamp, else the last one the
// file showed), `seq`, `offset: {start, end}`, and for a chain record `uuid` and
// `parent_uuid`. THE SEQ RULE (ruling U27@seq, one rule in U26, U27 and U28a):
// `seq` is the record's file ordinal — 1 for the file's first record, counted
// over every record the tailer delivers, bad and oversize ones included — so a
// re-read from 0, a resume and an LRU refill number every change alike, and
// every change of one record carries that record's seq. An item's own `seq` is
// the ordinal of the record that FIRST made it (a reply merged over three
// records keeps its place; a tool call's result does not move the call).
//
// THE RECORD FORWARD. A chain record (one with a uuid) that yields no other
// change — a dropped kind, a meta-only or carrier-only row, an unknown kind, a
// route with nothing to say — is still forwarded as
//   {type: 'record', uuid, parent_uuid, kind, ts, seq, offset}
// so the chain's leaf is exact and the rewinds source (U78) sees every kind it
// reads as evidence (§15.4 case b: the first turn's attachments). A uuid-less
// record a carrier reads (queue-operation) is forwarded too, without a uuid, so
// a carrier change for it has a normalizer change to take its seq from. So is a
// uuid-less `cost-state` (the exit tail Claude Code writes when a process leaves
// a session, V37): {type: 'record', kind: 'cost-state', ts, seq, offset}, which
// the rewinds source reads as a session boundary (U78b). meta.js reads its cost
// from the record itself, as before.
//
// THE CHANGES, per route (records.js ROUTES):
//   assistant      one block per record (V15): text → the reply `r_<message.id>`
//                  (text joined across the message's records), thinking → the
//                  thinking `th_<message.id>` {chars, text, duration_ms only when
//                  the record carries thinkingDurationMs (ruling, 2026-10-04:
//                  unobserved in the corpus; never invented)} — never the
//                  thinking block's signature; tool_use → a `tool_call` item
//                  (id = the tool_use id; tool, server for an mcp__ name,
//                  tool_kind = toolKind, label = stepLabel, call = callLabel,
//                  input = the 'mirror' projection, status running,
//                  started_at); isApiErrorMessage → a notice `api-error`. Each
//                  change carries the record's `stop_reason` (agent files, rule 6).
//   tool-result    the call's result: status done | error | denied (is_error
//                  and "doesn't want to proceed") | interrupted (the interrupt marker as the
//                  result), ended_at, duration_ms, result {preview, bytes,
//                  is_error, attachments (image blocks: metadata only, never
//                  base64), full}, a persisted output's path as `result._persisted`
//                  (an `_` field never serializes; the transcripts source's
//                  itemField opens it through sessionDirFile), edit {path, patch}
//                  from structuredPatch, links {task_id, agent_id, run_id}. The
//                  change carries `context: {file, command}` (file = tool-input
//                  fileOf of the call, command = a Bash call's command): the
//                  model's upsert redacts the output with it (§5.5).
//   opener         {type: 'opener', prompt_id, kind, text, origin, author?,
//                  command?, attachments?}; author 'web' when the text carries
//                  a composer marker (prompt-class messageMarkers). Bash mode
//                  also opens a local item `rl_<turnId>` {local: 'bash', input}.
//   local-output   the local item `rl_<turnId>` {local, output, is_error}.
//   interrupt      {type: 'interrupt', text}.
//   compact-summary  {type: 'compact-summary', parent_uuid, text}.
//   turn-duration  {type: 'turn-duration', duration_ms, message_count}: the
//                  message count is the rewinds source's case-b evidence; the
//                  machine ignores it.
//   compact        {type: 'compact', trigger, tokens: preTokens, duration_ms,
//                  tail_uuid}, then an item change on `c_<uuid>` adding
//                  pre_tokens and post_tokens (the names chat-state.js reads).
//   away           the away item `n_<uuid>`.
//   local-command  /clear → a session notice 'Session cleared'; any other
//                  command names the next local output.
//   notice         an informational or API-error notice; a file changed, a
//                  skill invoked, a compacted file's reference (names and paths
//                  only).
//   mode-notice    a model or mode notice, only when the value changes.
//   prompt-attachment  a file, directory or PDF added to the turn's prompt item
//                  (names and paths only).
//   artifact       an artifact item `af_<seq>` {title, url}.
//   permission-decision  {type: 'permission-decision', tool_use_id, decision}.
//   rewind-anchor  last-prompt → {type: 'rewind-evidence', rewound, leaf_uuid,
//                  ts, offset} when it carries `rewound: true`, a null leafUuid,
//                  or a leafUuid other than the chain's leaf; otherwise
//                  nothing. Whether that leaf is EARLIER is the rewinds
//                  source's call (U78, through the turn machine's turnOfUuid);
//                  the turn machine counts this type in its unknown_changes
//                  diagnostic (notes Q6).
//
// WITHHELD INPUTS (§5.5, ruling U26@withheld-inputs). The model never withholds
// an input (its context fields are output only), so a tool call whose file
// sensitivePath() puts in WITHHOLD_CATEGORIES leaves here with every content
// field of its projected input replaced by WITHHELD(category): a field the
// mirror projection carries only as its `<field>_bytes` size, and any structured
// field it left out. No tool is named: the projection's own shape says which
// fields are content. The path and the label stay.
//
// DUPLICATES (V16, lib/core/redact NEVER_EMIT.fields): never read here —
// wireToolInputs, toolUseResult.stdout / stderr / originalFile / file.content,
// attachment.rendered, queue-operation.content, thinking.signature.
//
// NOT here: model writes, redaction (the model's upsert does it), I/O, clocks,
// timers, the meta, carrier and known-value folds (U27) and their merge (U28a).
//
// Dependency direction: lib/core, and records.js / model.js beside it.

const { kindOf, rowOf, versionOf } = require('./records');
const { ITEM_CAPS } = require('./model');
const { projectToolInput, toolKind, stepLabel, callLabel, fileOf } = require('../../core/tool-input');
const { WITHHELD, WITHHOLD_CATEGORIES, sensitivePath } = require('../../core/redact');
const { messageMarkers } = require('../../core/prompt-class');

const STATE_VERSION = 1;

// The accumulators are bounded: a turn with more messages or open calls than
// this drops its oldest (a later block of a dropped message starts it again).
const MAX_MESSAGES = 512;
const MAX_TOOLS = 512;
const MAX_ATTACHMENTS = 32;
const MAX_COMMAND = 8192;
// The diag count maps: at most this many distinct keys, each at most KEY_MAX.
const MAX_DIAG_KEYS = 64;
const KEY_MAX = 100;
// An accumulated text is kept to just past the model's FULL cap, so the model
// still sees it over the cap and marks the item `truncated` (two UTF-16 units
// per code point at most, plus one).
const keep = (cap) => cap * 2 + 2;
const REPLY_KEEP = keep(ITEM_CAPS.reply.text[1]);
const THINKING_KEEP = keep(ITEM_CAPS.thinking.text[1]);

const DENIED_TEXT = "doesn't want to proceed";
const INTERRUPTED_TEXT = '[Request interrupted by user';

// A record kind → the opener's kind and its prompt's origin (§2.4).
const OPENERS = Object.freeze({
  'user/prompt': ['prompt', 'human'],
  'user/prompt+image': ['prompt', 'human'],
  'user/task-notification': ['task-notification', 'task-notification'],
  'user/channel': ['channel', 'channel'],
  'user/slash-command': ['command', 'command'],
  'user/bash-mode': ['shell', 'shell'],
});

// The mode attachments: which mode each sets, and to what.
const MODES = Object.freeze({
  'attachment/plan_mode': ['plan', 'on', 'Plan mode'],
  'attachment/plan_mode_reentry': ['plan', 'on', 'Plan mode'],
  'attachment/plan_mode_exit': ['plan', 'off', 'Plan mode off'],
  'attachment/auto_mode': ['auto', 'on', 'Auto mode'],
  'attachment/auto_mode_exit': ['auto', 'off', 'Auto mode off'],
  'attachment/ultra_effort_enter': ['ultra', 'on', 'Ultra effort'],
  'attachment/ultra_effort_exit': ['ultra', 'off', 'Ultra effort off'],
});

const PROMPT_ATTACHMENT_KIND = Object.freeze({
  'attachment/file': 'file',
  'attachment/directory': 'directory',
  'attachment/pdf_reference': 'document',
});

// ── small helpers ──────────────────────────────────────────────────────────

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function tsOf(obj) {
  const t = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : num(obj.timestamp);
  return Number.isFinite(t) ? t : null;
}

// The inner text of the first <tag>…</tag> in `text`, or null.
function tagText(text, tag) {
  if (typeof text !== 'string') return null;
  const open = `<${tag}>`;
  const at = text.indexOf(open);
  if (at < 0) return null;
  const from = at + open.length;
  const end = text.indexOf(`</${tag}>`, from);
  return end < 0 ? text.slice(from) : text.slice(from, end);
}

function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) if (isPlain(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n');
}

// An image or document block's metadata: never its data. The size is read off
// the base64 text's length, which is never decoded.
function blockAttachment(b, n) {
  if (!isPlain(b) || (b.type !== 'image' && b.type !== 'document')) return null;
  const a = { n, kind: b.type };
  const src = isPlain(b.source) ? b.source : {};
  if (str(src.media_type)) a.media_type = src.media_type;
  if (typeof src.data === 'string') {
    const len = src.data.length;
    const pad = src.data.endsWith('==') ? 2 : src.data.endsWith('=') ? 1 : 0;
    a.bytes = Math.max(0, Math.floor((len * 3) / 4) - pad);
  }
  if (b.type === 'document' && str(b.title)) a.name = b.title;
  return a;
}

function attachmentsOf(c) {
  if (!Array.isArray(c)) return [];
  const out = [];
  for (const b of c) {
    const a = blockAttachment(b, out.length + 1);
    if (a) out.push(a);
  }
  return out;
}

function appendText(prev, add, max) {
  const s = prev ? `${prev}\n\n${add}` : add;
  return s.length > max ? s.slice(0, max) : s;
}

// A Map-free count map that holds any key safely (an own data property even for
// '__proto__'), bounded.
function bump(map, key) {
  const k = String(key).slice(0, KEY_MAX);
  if (!Object.hasOwn(map, k)) {
    if (Object.keys(map).length >= MAX_DIAG_KEYS) return;
    Object.defineProperty(map, k, { value: 0, enumerable: true, writable: true, configurable: true });
  }
  map[k] += 1;
}

// Keep at most `max` entries of an object map, the oldest out.
function trimMap(map, max) {
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length - max; i++) delete map[keys[i]];
}

// ── state ──────────────────────────────────────────────────────────────────

function initialState() {
  return {
    v: STATE_VERSION,
    version: null,   // the last Claude Code version the file showed (V15)
    leaf: null,      // the last chain record's uuid
    seq: 0,          // the ordinal of the last record read
    ts: null,        // the last record timestamp (ms)
    turn: null,      // the current opener's prompt id (the turn machine's id)
    turn_seq: null,  // the current opener's ordinal (its prompt item's seq)
    cmd: null,       // the last local command's name, for its output
    modes: {},       // mode → its last value (a mode notice only on a change)
    msgs: {},        // 'm:<message.id>' → the message's reply / thinking so far
    tools: {},       // 'u:<tool_use.id>' → {name, file, command, at, seq} until its result
    attach: [],      // the current prompt's attachments (metadata only)
  };
}

// A copy of the caller's state, repaired to the shape: never mutated in place.
function copyState(state) {
  const base = initialState();
  if (!isPlain(state)) return base;
  const out = { ...base };
  if (typeof state.version === 'string') out.version = state.version;
  if (typeof state.leaf === 'string') out.leaf = state.leaf;
  if (Number.isSafeInteger(state.seq) && state.seq >= 0) out.seq = state.seq;
  if (num(state.ts) !== null) out.ts = state.ts;
  if (typeof state.turn === 'string') out.turn = state.turn;
  if (Number.isSafeInteger(state.turn_seq)) out.turn_seq = state.turn_seq;
  if (typeof state.cmd === 'string') out.cmd = state.cmd;
  if (isPlain(state.modes)) for (const k of Object.keys(state.modes)) if (typeof state.modes[k] === 'string') out.modes[k] = state.modes[k];
  for (const field of ['msgs', 'tools']) {
    if (!isPlain(state[field])) continue;
    for (const k of Object.keys(state[field])) {
      const e = state[field][k];
      if (isPlain(e)) out[field][k] = { ...e };
    }
  }
  if (Array.isArray(state.attach)) out.attach = state.attach.filter(isPlain).slice(0, MAX_ATTACHMENTS).map((a) => ({ ...a }));
  return out;
}

// A new turn: nothing of the last one is kept but ids and counters. A task
// notification may be absorbed by the open turn (rule 1), so it keeps the open
// tool calls, whose results may still follow it.
function startTurn(st, promptId, seq, { keepTools = false } = {}) {
  st.msgs = {};
  if (!keepTools) st.tools = {};
  st.attach = [];
  st.cmd = null;
  st.turn = promptId;
  st.turn_seq = seq;
}

function endTurn(st) {
  st.msgs = {};
  st.tools = {};
  st.attach = [];
  st.cmd = null;
}

// ── tool calls ─────────────────────────────────────────────────────────────

// The 'mirror' projection, with a sensitive file's content fields WITHHELD
// (§5.5): each `<field>_bytes` size becomes `<field>` = WITHHELD, and any
// structured field the projection left out (a MultiEdit's `edits`) is WITHHELD
// too. Scalars the projection dropped carry no file content.
function projectInput(name, input) {
  const projected = projectToolInput(name, input, { profile: 'mirror' }).input;
  const file = fileOf(name, input);
  const category = file ? sensitivePath(file) : null;
  if (!category || !WITHHOLD_CATEGORIES.includes(category)) return projected;
  const mark = WITHHELD(category);
  const out = {};
  for (const k of Object.keys(projected)) {
    if (k.endsWith('_bytes') && k.length > 6) out[k.slice(0, -6)] = mark;
    else if (k === 'edits_count') continue;
    else out[k] = projected[k];
  }
  if (isPlain(input)) {
    for (const k of Object.keys(input)) {
      const v = input[k];
      if (!Object.hasOwn(out, k) && v !== null && typeof v === 'object') out[k] = mark;
    }
  }
  return out;
}

function serverOf(name) {
  const m = /^mcp__(.+?)__/.exec(name);
  return m ? m[1] : null;
}

function patchText(hunks) {
  const out = [];
  for (const h of hunks) {
    if (!isPlain(h) || !Array.isArray(h.lines)) continue;
    const n = (v) => (Number.isSafeInteger(v) ? v : 0);
    out.push(`@@ -${n(h.oldStart)},${n(h.oldLines)} +${n(h.newStart)},${n(h.newLines)} @@`);
    for (const l of h.lines) if (typeof l === 'string') out.push(l);
  }
  return out.join('\n');
}

function linksOf(tur) {
  const links = {};
  const task = str(tur.backgroundTaskId) || str(tur.taskId);
  if (task) links.task_id = task;
  if (str(tur.agentId)) links.agent_id = tur.agentId;
  if (str(tur.runId)) links.run_id = tur.runId;
  return Object.keys(links).length ? links : null;
}

// ── the normalizer ─────────────────────────────────────────────────────────

// normalize(recs, state, {session_id}): the third argument is the source
// contract's, and nothing here reads it (see the header).
function normalize(recs, state) {
  const st = copyState(state);
  const changes = [];
  const diag = { unknown_kinds: {}, bad_lines: 0, oversize_lines: 0, versions_seen: {} };
  if (!Array.isArray(recs)) return { changes, state: st, diag };
  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue;
    st.seq += 1;
    if (rec.oversize) { diag.oversize_lines += 1; continue; }
    if (rec.bad || !isPlain(rec.obj)) { diag.bad_lines += 1; continue; }
    const out = [];
    try {
      record(st, rec, out, diag);
    } catch {
      // A record of a shape no branch expected: counted, never thrown. What it
      // had already produced is dropped with it.
      diag.bad_lines += 1;
      continue;
    }
    for (const c of out) changes.push(c);
  }
  return { changes, state: st, diag };
}

function record(st, rec, out, diag) {
  const obj = rec.obj;
  const seq = st.seq;
  const version = versionOf(obj, st.version);
  if (version) { st.version = version; bump(diag.versions_seen, version); }
  const own = tsOf(obj);
  if (own !== null) st.ts = own;
  const ts = own !== null ? own : st.ts;
  const uuid = str(obj.uuid);
  const kind = kindOf(obj);
  const row = rowOf(kind);

  // The fields every change of this record carries.
  const base = {};
  if (uuid) base.uuid = uuid;
  if (uuid && (obj.parentUuid === null || typeof obj.parentUuid === 'string')) base.parent_uuid = obj.parentUuid;
  if (ts !== null) base.ts = ts;
  base.seq = seq;
  if (Number.isFinite(rec.start) && Number.isFinite(rec.end)) base.offset = { start: rec.start, end: rec.end };
  const emit = (change) => out.push({ ...change, ...base });
  // A new item takes this record's ts and seq; an update of an item an earlier
  // record made (`{update: true}`) names its own or none, so it never moves.
  const item = (it, extra, { update = false } = {}) => emit({ type: 'item', item: update ? it : { ts, seq, ...it }, ...extra });

  if (!row) bump(diag.unknown_kinds, kind);
  else if (row.turn) route(row.turn, { st, obj, kind, uuid, seq, ts, emit, item });

  if (uuid) st.leaf = uuid;
  if (!out.length && (uuid || (row && row.carrier) || kind === 'cost-state')) emit({ type: 'record', kind });
}

function route(name, ctx) {
  switch (name) {
    case 'assistant': return assistant(ctx);
    case 'tool-result': return toolResult(ctx);
    case 'opener': return opener(ctx);
    case 'local-output': return localOutput(ctx);
    case 'interrupt': return interrupt(ctx);
    case 'compact-summary': return compactSummary(ctx);
    case 'turn-duration': return turnDuration(ctx);
    case 'compact': return compact(ctx);
    case 'away': return away(ctx);
    case 'local-command': return localCommand(ctx);
    case 'notice': return notice(ctx);
    case 'mode-notice': return modeNotice(ctx);
    case 'prompt-attachment': return promptAttachment(ctx);
    case 'artifact': return artifact(ctx);
    case 'permission-decision': return permissionDecision(ctx);
    case 'rewind-anchor': return rewindAnchor(ctx);
    default: return undefined;
  }
}

const noticeId = (uuid, seq) => (uuid ? `n_${uuid}` : `n_s${seq}`);

function assistant({ st, obj, uuid, seq, ts, item }) {
  const msg = isPlain(obj.message) ? obj.message : {};
  const extra = typeof msg.stop_reason === 'string' ? { stop_reason: msg.stop_reason } : undefined;
  if (obj.isApiErrorMessage === true) {
    item({ id: noticeId(uuid, seq), kind: 'notice', notice: 'api-error', text: textOfContent(msg.content) || 'API error' }, extra);
    return;
  }
  const mid = str(msg.id) || (uuid ? `u_${uuid}` : `s${seq}`);
  const key = `m:${mid}`;
  const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
  for (const b of blocks) {
    if (!isPlain(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      const acc = message(st, key);
      if (acc.r_seq == null) { acc.r_seq = seq; acc.r_ts = ts; }
      acc.reply = appendText(acc.reply, b.text, REPLY_KEEP);
      const it = { id: `r_${mid}`, kind: 'reply', text: acc.reply, message_id: mid, seq: acc.r_seq, ts: acc.r_ts };
      if (str(msg.model)) it.model = msg.model;
      item(it, extra);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      const acc = message(st, key);
      if (acc.t_seq == null) { acc.t_seq = seq; acc.t_ts = ts; acc.chars = 0; }
      acc.chars += b.thinking.length;
      acc.thinking = appendText(acc.thinking, b.thinking, THINKING_KEEP);
      const dur = num(obj.thinkingDurationMs);
      if (dur !== null) acc.duration_ms = (acc.duration_ms || 0) + dur;
      const it = { id: `th_${mid}`, kind: 'thinking', chars: acc.chars, text: acc.thinking, seq: acc.t_seq, ts: acc.t_ts };
      if (acc.duration_ms !== undefined) it.duration_ms = acc.duration_ms;
      item(it, extra);
    } else if (b.type === 'tool_use' && str(b.id) && typeof b.name === 'string') {
      const input = isPlain(b.input) ? b.input : {};
      const it = {
        id: b.id, kind: 'tool_call', tool: b.name, tool_kind: toolKind(b.name),
        label: stepLabel(b.name, input), call: callLabel(b.name, input), input: projectInput(b.name, input),
        status: 'running', started_at: ts,
      };
      const server = serverOf(b.name);
      if (server) it.server = server;
      const tool = { name: b.name, seq };
      const file = fileOf(b.name, input);
      if (file) tool.file = file;
      if (b.name === 'Bash' && typeof input.command === 'string') tool.command = input.command.slice(0, MAX_COMMAND);
      if (ts !== null) tool.at = ts;
      st.tools[`u:${b.id}`] = tool;
      trimMap(st.tools, MAX_TOOLS);
      item(it, extra);
    }
  }
}

function message(st, key) {
  if (!isPlain(st.msgs[key])) {
    st.msgs[key] = {};
    trimMap(st.msgs, MAX_MESSAGES);
  }
  return st.msgs[key];
}

function toolResult({ st, obj, ts, item }) {
  const content = isPlain(obj.message) && Array.isArray(obj.message.content) ? obj.message.content : [];
  const results = content.filter((b) => isPlain(b) && b.type === 'tool_result' && str(b.tool_use_id));
  // toolUseResult describes the record's one result; a record with several is
  // read for their blocks alone.
  const tur = results.length === 1 && isPlain(obj.toolUseResult) ? obj.toolUseResult : null;
  for (const b of results) {
    const id = b.tool_use_id;
    const tool = isPlain(st.tools[`u:${id}`]) ? st.tools[`u:${id}`] : null;
    delete st.tools[`u:${id}`];
    const text = textOfContent(b.content);
    const isError = b.is_error === true;
    let status = 'done';
    if (isError && text.includes(DENIED_TEXT)) status = 'denied';
    else if (isError && text.trimStart().startsWith(INTERRUPTED_TEXT)) status = 'interrupted';
    else if (isError) status = 'error';
    const persisted = tur ? str(tur.persistedOutputPath) : null;
    const result = { preview: text, bytes: Buffer.byteLength(text, 'utf8'), is_error: isError, full: !persisted };
    if (persisted) {
      result._persisted = persisted;
      if (Number.isSafeInteger(tur.persistedOutputSize) && tur.persistedOutputSize >= 0) result.bytes = tur.persistedOutputSize;
    }
    const atts = attachmentsOf(b.content);
    if (atts.length) result.attachments = atts;
    const it = { id, kind: 'tool_call', status, result };
    if (tool && Number.isSafeInteger(tool.seq)) it.seq = tool.seq;
    if (tool && num(tool.at) !== null) it.ts = tool.at;
    if (ts !== null) {
      it.ended_at = ts;
      if (tool && num(tool.at) !== null && ts >= tool.at) it.duration_ms = ts - tool.at;
    }
    const file = (tool && str(tool.file)) || (tur && str(tur.filePath)) || null;
    if (tur && Array.isArray(tur.structuredPatch)) {
      it.edit = { path: str(tur.filePath) || file || '', patch: patchText(tur.structuredPatch) };
    }
    if (tur) {
      const links = linksOf(tur);
      if (links) it.links = links;
    }
    const context = {};
    if (file) context.file = file;
    if (tool && str(tool.command)) context.command = tool.command;
    item(it, Object.keys(context).length ? { context } : undefined, { update: true });
  }
}

function opener({ st, obj, kind, uuid, seq, item, emit }) {
  const content = isPlain(obj.message) ? obj.message.content : undefined;
  const raw = textOfContent(content);
  const [turnKind, origin] = OPENERS[kind];
  // Bash mode's output arrives as a bash-mode record too: it is the local item's
  // output, not a turn.
  const bashIn = turnKind === 'shell' ? tagText(raw, 'bash-input') : null;
  if (turnKind === 'shell' && bashIn === null) return bashOutput({ st, raw, uuid, seq, item });
  const promptId = str(obj.promptId) || (uuid ? `u_${uuid}` : null);
  startTurn(st, promptId, seq, { keepTools: turnKind === 'task-notification' });
  const ch = { type: 'opener', prompt_id: promptId, kind: turnKind, origin };
  let text = raw;
  if (turnKind === 'command') {
    const message = (tagText(raw, 'command-message') || '').trim();
    const name = (tagText(raw, 'command-name') || '').trim() || (message ? `/${message}` : '/command');
    const args = (tagText(raw, 'command-args') || '').trim();
    ch.command = name;
    text = args ? `${name} ${args}` : name;
    st.cmd = name;
  } else if (turnKind === 'shell') {
    text = bashIn;
  }
  ch.text = text;
  if (messageMarkers(raw).length) ch.author = 'web';
  const atts = attachmentsOf(content);
  if (atts.length) { ch.attachments = atts; st.attach = atts.map((a) => ({ ...a })); }
  if (!promptId) delete ch.prompt_id;
  emit(ch);
  const pushed = ch.author === 'web' && promptId && /^Pushed from:(?: origin=\S+)? device=(desktop|mobile)$/m.exec(raw); if (pushed) item({ id: `p_${promptId}`, device: pushed[1] }, undefined, { update: true }); // the push batch's device onto the prompt item (ruling D2 (a))
  if (turnKind === 'shell' && promptId) item({ id: `rl_${promptId}`, kind: 'local', local: 'bash', input: bashIn });
}

function localId(st, uuid, seq) {
  if (st.turn) return `rl_${st.turn}`;
  return uuid ? `lo_${uuid}` : `lo_s${seq}`;
}

function bashOutput({ st, raw, uuid, seq, item }) {
  const out = tagText(raw, 'bash-stdout') || '';
  const err = tagText(raw, 'bash-stderr') || '';
  const output = out && err ? `${out}\n${err}` : out || err;
  item({ id: localId(st, uuid, seq), kind: 'local', local: 'bash', output, is_error: Boolean(err) });
}

function localOutput({ st, obj, uuid, seq, item }) {
  const raw = textOfContent(isPlain(obj.message) ? obj.message.content : undefined);
  const out = tagText(raw, 'local-command-stdout');
  const err = tagText(raw, 'local-command-stderr');
  item({
    id: localId(st, uuid, seq), kind: 'local', local: st.cmd || 'command',
    output: err !== null ? err : out !== null ? out : raw, is_error: err !== null,
  });
}

function interrupt({ obj, emit }) {
  const text = textOfContent(isPlain(obj.message) ? obj.message.content : undefined);
  emit(text ? { type: 'interrupt', text } : { type: 'interrupt' });
}

function compactSummary({ obj, emit }) {
  const text = textOfContent(isPlain(obj.message) ? obj.message.content : undefined);
  emit({ type: 'compact-summary', text });
}

function turnDuration({ st, obj, emit }) {
  const ch = { type: 'turn-duration' };
  if (num(obj.durationMs) !== null) ch.duration_ms = obj.durationMs;
  if (Number.isSafeInteger(obj.messageCount)) ch.message_count = obj.messageCount;
  emit(ch);
  endTurn(st);
}

function compact({ obj, uuid, item, emit }) {
  const meta = isPlain(obj.compactMetadata) ? obj.compactMetadata : {};
  const ch = { type: 'compact' };
  if (str(meta.trigger)) ch.trigger = meta.trigger;
  if (num(meta.preTokens) !== null) ch.tokens = meta.preTokens;
  if (num(meta.durationMs) !== null) ch.duration_ms = meta.durationMs;
  const seg = isPlain(meta.preservedSegment) ? meta.preservedSegment : {};
  if (str(seg.tailUuid)) ch.tail_uuid = seg.tailUuid;
  emit(ch);
  if (!uuid) return;
  const it = { id: `c_${uuid}`, kind: 'compact' };
  if (num(meta.preTokens) !== null) it.pre_tokens = meta.preTokens;
  if (num(meta.postTokens) !== null) it.post_tokens = meta.postTokens;
  item(it);
}

function away({ obj, uuid, seq, item }) {
  item({ id: noticeId(uuid, seq), kind: 'away', text: typeof obj.content === 'string' ? obj.content : '' });
}

function localCommand({ st, obj, uuid, seq, item }) {
  const run = isPlain(obj.commandRun) ? obj.commandRun : {};
  const name = (str(run.command) || (tagText(obj.content, 'command-name') || '').trim()).replace(/^\//, '');
  if (!name) return;
  if (name === 'clear') {
    item({ id: noticeId(uuid, seq), kind: 'notice', notice: 'session', text: 'Session cleared' });
    return;
  }
  st.cmd = `/${name}`;
}

function attachmentPath(a) {
  return str(a.filename) || str(a.path) || str(a.file_path) || str(a.filePath) || null;
}

function notice({ obj, kind, uuid, seq, item }) {
  const id = noticeId(uuid, seq);
  if (kind === 'system/informational') {
    item({ id, kind: 'notice', notice: 'info', text: typeof obj.content === 'string' ? obj.content : '' });
    return;
  }
  if (kind === 'system/api_error') {
    const err = isPlain(obj.error) ? obj.error : {};
    const text = (typeof obj.content === 'string' && obj.content) || str(err.message) || 'API error';
    item({ id, kind: 'notice', notice: 'api-error', text });
    return;
  }
  const a = isPlain(obj.attachment) ? obj.attachment : {};
  if (kind === 'attachment/invoked_skills') {
    const names = (Array.isArray(a.skills) ? a.skills : [])
      .map((s) => (isPlain(s) ? str(s.name) : str(s))).filter(Boolean);
    if (names.length) item({ id, kind: 'notice', notice: 'skill', text: `Skill: ${names.join(', ')}` });
    return;
  }
  const p = attachmentPath(a);
  if (!p) return;
  if (kind === 'attachment/edited_text_file') item({ id, kind: 'notice', notice: 'file-changed', text: `Changed: ${p}` });
  else item({ id, kind: 'notice', notice: 'info', text: `Compacted file: ${p}` });
}

function modeNotice({ st, obj, kind, uuid, seq, item }) {
  if (kind === 'attachment/model') {
    const a = isPlain(obj.attachment) ? obj.attachment : {};
    const model = str(a.model) || str(a.name);
    if (!model || st.modes.model === model) return;
    st.modes.model = model;
    item({ id: noticeId(uuid, seq), kind: 'notice', notice: 'model', text: `Model: ${model}` });
    return;
  }
  const m = MODES[kind];
  if (!m) return;
  const [mode, value, text] = m;
  if (st.modes[mode] === value) return;
  // A mode's first "off" with no "on" before it in the file says nothing.
  const first = st.modes[mode] === undefined;
  st.modes[mode] = value;
  if (first && value === 'off') return;
  item({ id: noticeId(uuid, seq), kind: 'notice', notice: 'mode', text });
}

function promptAttachment({ st, obj, kind, uuid, seq, item }) {
  const a = isPlain(obj.attachment) ? obj.attachment : {};
  const p = attachmentPath(a);
  if (!p) return;
  if (!st.turn || st.attach.length >= MAX_ATTACHMENTS) {
    item({ id: noticeId(uuid, seq), kind: 'notice', notice: 'info', text: `Attached: ${p}` });
    return;
  }
  st.attach.push({ n: st.attach.length + 1, kind: PROMPT_ATTACHMENT_KIND[kind], name: p });
  const it = { id: `p_${st.turn}`, kind: 'prompt', attachments: st.attach.map((x) => ({ ...x })) };
  if (Number.isSafeInteger(st.turn_seq)) it.seq = st.turn_seq;
  item(it, undefined, { update: true });
}

function artifact({ obj, seq, item }) {
  const it = { id: `af_${seq}`, kind: 'artifact', title: str(obj.title) || 'Artifact' };
  if (str(obj.frameUrl)) it.url = obj.frameUrl;
  item(it);
}

function permissionDecision({ obj, emit }) {
  const a = isPlain(obj.attachment) ? obj.attachment : {};
  if (!str(a.toolUseID)) return;
  emit({ type: 'permission-decision', tool_use_id: a.toolUseID, decision: typeof a.decision === 'string' ? a.decision : null });
}

function rewindAnchor({ st, obj, emit }) {
  const rewound = obj.rewound === true;
  const has = Object.hasOwn(obj, 'leafUuid');
  const leaf = has ? obj.leafUuid : undefined;
  const nullLeaf = has && leaf === null;
  const other = typeof leaf === 'string' && leaf !== st.leaf;
  if (!rewound && !nullLeaf && !other) return;
  emit({ type: 'rewind-evidence', rewound, leaf_uuid: typeof leaf === 'string' ? leaf : null });
}

module.exports = {
  initialState,
  normalize,
  STATE_VERSION,
};

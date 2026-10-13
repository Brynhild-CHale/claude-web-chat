// The chat mirror's ONE client store (design spec §7.3).
//
// The status bar, the trays, the chat panel and its stream, the detail views and
// the phone sheet all read THIS: nothing else in the chrome fetches mirror state
// or keeps a copy of it. It folds the daemon's `mirror:*` frames and the
// GET /api/mirror snapshot into `mirror` (below) and announces every change on
// the chrome bus as `mirror` {what}, where `what` ⊆ conn, conversations, status,
// tasks, awaiting, stream, all. It words nothing: chat-present.js turns the
// store into what the chrome says.
//
// DOM-FREE. It imports bus.js and storage.js (labels.js is the one other module
// it may import) and never ws.js, which imports the whole chrome graph, so plain
// `node --test` loads it. Its wiring is injected:
//
//   initChatState({ onFrame, onHello, fetch, conn })
//
// registers onFrame('mirror:', foldMirrorFrame) and an onHello that re-hydrates
// (ws.js's seams, §7.2), and listens to the bus's `conn` and `chat:posture`.
// main.js and bootShell's `init` call it; a test calls foldMirrorFrame and
// hydrateMirror directly.
//
// THE WIRE IS READ IN ONE PLACE: the normalize* functions. Unknown fields are
// ignored, a malformed record is dropped (never thrown), and every string is cut
// to its cap again, so neither a daemon bug nor a newer daemon can put an
// unbounded or unexpected value in front of the chrome. Every record handed out
// is frozen: the store is the one writer of what it holds.
//
// ORDER. Each flush of the engine has a `rev` (§2.9), and each object the store
// holds keeps the rev of its last change: a frame's object is applied only when
// it is newer than the one held. Frames that arrive before the snapshot (between
// `hello` and the GET's answer, or before any hello) are buffered and replayed
// after it, those at or below the snapshot's rev dropped. The followed
// conversation's stream is paged in the same way.
//
// BELOW `read` the store keeps states, counts and timings and nothing else: the
// normalizers project every record onto its content-free fields whatever a frame
// carries. That is defence in depth behind the daemon's own projection
// (lib/core/remote-policy), never the gate itself.
//
// FOLLOWING. The followed conversation is this tab's choice while it is live,
// else the server's primary (§7.3). A headless one (a `claude -p` job, §2.2) is
// followed only by choice: no fallback ever reaches it. A StatusRow does not say
// which sessions are headless, so below `read` the store picks none from the
// rows; when the aggregate shows a live interactive session that nothing
// followed covers, it reads the snapshot again for the server's primary.
//
// NO TIMER. The bounds — 300 turns; a finished task dropped 15 minutes after it
// ended, a failure kept until it has been seen (markSeen) — are pruned on each
// fold. A hydrate that failed is retried from the next frame, at most every 5 s.
import { bus } from './bus.js';
import { getSession, setSession, removeSession } from './storage.js';

export const MAX_TURNS = 300;
export const STREAM_PAGE = 30;
export const TASK_KEEP_MS = 15 * 60 * 1000;
const MAX_ITEMS_PER_TURN = 2000;
const MAX_BUFFER = 500;
const RETRY_MS = 5000;
const FOLLOW_KEY = 'wc:chat-follow';

// ── vocabulary ───────────────────────────────────────────────────────────────

// A viewer's mirror level, least first (§5.2). `off` is a refusal, not a level
// the daemon grants: a store that hears it keeps nothing but the connection.
export const LEVELS = Object.freeze(['off', 'basic', 'read', 'full', 'local']);
export const levelRank = (level) => LEVELS.indexOf(level);
export const atLeast = (level, need) => levelRank(need) >= 0 && levelRank(level) >= levelRank(need);

export const CAPABILITIES = Object.freeze(['answer', 'task_stop', 'queue_message', 'turn_diff', 'node_diff',
  'attachments', 'agent_items', 'interrupt', 'code_revert', 'fork', 'mod', 'rewind_in_place']);
const CONN_STATES = new Set(['connecting', 'live', 'reconnecting']);
const STATES = new Set(['ended', 'suspended', 'question', 'waiting', 'compacting', 'working', 'idle', 'unknown']);
const WAIT_KINDS = ['permission', 'question', 'plan', 'other'];
const ASK_KINDS = ['permission', 'question', 'plan', 'elicitation'];
const TASK_KINDS = ['shell', 'monitor', 'agent', 'workflow'];
const TASK_STATUS = new Set(['running', 'done', 'failed', 'killed', 'stopped', 'expired', 'unknown']);
const TURN_STATUS = ['open', 'done', 'interrupted', 'error', 'abandoned'];
const ENDED_BY = ['terminal', 'web', 'hook'];
const ITEM_KINDS = ['prompt', 'reply', 'thinking', 'tool_call', 'task', 'notice', 'compact', 'away', 'queued',
  'local', 'artifact'];
const FINISHED = new Set(['done', 'failed', 'killed', 'stopped', 'expired', 'unknown']);

// ── the reading kit ──────────────────────────────────────────────────────────

// The engine's id grammar (lib/server/mirror/model.js), and the basic
// projection's `word` (lib/core/remote-policy FRAME_RULES: no `__`, so an MCP
// tool's full name can never pass for a step kind).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const WORD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Cut to `max` characters without leaving half a surrogate pair behind.
function cut(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

// Field readers: each answers the clean value, or undefined for "absent".
const F = {
  id: (v) => (typeof v === 'string' && ID_RE.test(v) ? v : undefined),
  word: (v) => (typeof v === 'string' && WORD_RE.test(v) && !v.includes('__') ? v : undefined),
  text: (max) => (v) => (typeof v === 'string' ? cut(v, max) : undefined),
  num: (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
  int: (v) => (Number.isSafeInteger(v) ? v : undefined),
  count: (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined),
  bool: (v) => (typeof v === 'boolean' ? v : undefined),
  oneOf: (...vals) => { const set = new Set(vals); return (v) => (set.has(v) ? v : undefined); },
  obj: (schema) => (v) => (isPlain(v) ? pick(v, schema) : undefined),
  list: (read, max) => (v) => (Array.isArray(v) ? v.slice(0, max).map(read).filter((x) => x !== undefined) : undefined),
  orNull: (read) => (v) => (v === null ? null : read(v)),
};

// Only the schema's own keys are read, so an unknown field (or `__proto__`) never
// reaches the copy.
function pick(raw, schema) {
  const out = {};
  for (const k of Object.keys(schema)) {
    if (!has(raw, k)) continue;
    const v = schema[k](raw[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function freeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) freeze(v[k]);
  }
  return v;
}

// An unrecognised state is honest as `unknown` ("no recent sign of this
// session"), never dropped: a newer engine may have more states than this file.
const stateOf = (v) => (typeof v === 'string' ? (STATES.has(v) ? v : 'unknown') : undefined);
// The aggregate is one more word: `none` while no interactive conversation exists.
const aggregateOf = (v) => {
  const state = isPlain(v) ? v.state : undefined;
  return { state: state === 'none' ? 'none' : stateOf(state) || 'unknown' };
};
const taskStatusOf = (v) => (typeof v === 'string' ? (TASK_STATUS.has(v) ? v : 'unknown') : undefined);
// A running count: an integer, or the snapshot's `{running, …}` form.
const runningOf = (v) => {
  if (Number.isSafeInteger(v) && v >= 0) return Math.min(v, 9999);
  return isPlain(v) ? runningOf(v.running) : undefined;
};
const countsOf = (v) => {
  const out = { shells: 0, agents: 0, workflows: 0, monitors: 0 };
  if (isPlain(v)) for (const k of Object.keys(out)) out[k] = has(v, k) ? runningOf(v[k]) || 0 : 0;
  return out;
};
// A content-free map of kind → count (diagnostics), bounded.
const countMapOf = (v) => {
  if (Number.isSafeInteger(v) && v >= 0) return v;
  if (!isPlain(v)) return undefined;
  const out = {};
  for (const k of Object.keys(v).slice(0, 50)) {
    if (k === '__proto__' || k.length > 64) continue;
    const n = F.count(v[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
};

// ── the records ──────────────────────────────────────────────────────────────

// StatusRow (§2.9): content-free by construction, and the only conversation
// record kept below `read`.
const STATUS_SCHEMA = {
  id: F.id,
  state: stateOf,
  since: F.num,
  quiet: (v) => (typeof v === 'boolean' ? v : v === null ? false : isPlain(v) ? true : undefined),
  step_kind: F.word,
  waiting_kind: F.oneOf(...WAIT_KINDS),
  last_activity_at: F.num,
  ended_reason: F.word,
  counts: countsOf,
};

export function normalizeStatusRow(raw) {
  if (!isPlain(raw)) return null;
  const row = pick(raw, STATUS_SCHEMA);
  if (!row.id) return null;
  if (!row.state) row.state = 'unknown';
  row.quiet = row.quiet === true;
  if (!row.counts) row.counts = countsOf(null);
  return freeze(row);
}

// Live (§2.6). The starred fields there are content: step.label, waiting.summary,
// last_turn.reply_preview. `last_turn.ended_by` (who stopped an interrupted
// turn), `last_turn.error` (a failed turn's message) and `ended_reason` (why an
// ended conversation ended, as its StatusRow says) are read when the engine
// sends them.
const LIVE_SCHEMA = {
  rev: F.num,
  state: stateOf,
  since: F.num,
  quiet: F.orNull(F.obj({ since: F.num, reason: F.word })),
  stale_status: F.bool,
  step: F.orNull(F.obj({ kind: F.text(64), tool: F.text(200), label: F.text(200), started_at: F.num })),
  waiting: F.orNull(F.obj({ kind: F.oneOf(...WAIT_KINDS), tool: F.text(200), summary: F.text(2048), ask_id: F.id,
    tool_use_id: F.id, pending: F.bool })),
  last_activity_at: F.num,
  turn_started_at: F.num,
  last_turn: F.orNull(F.obj({
    id: F.id, outcome: F.oneOf(...TURN_STATUS), ended_at: F.num,
    code: F.orNull(F.obj({ files: F.count, additions: F.count, deletions: F.count })),
    reply_preview: F.text(280), ended_by: F.oneOf(...ENDED_BY), error: F.text(500),
  })),
  ended_reason: F.word,
  process: F.orNull(F.obj({ pid: F.count, alive: F.orNull(F.bool), cpu_pct: F.num })),
  evidence: F.obj({ hook_at: F.num, transcript_at: F.num, task_output_at: F.num, sessions_file_at: F.num,
    proc: F.oneOf('alive', 'gone', 'stopped', 'unknown') }),
};

export function normalizeLive(raw) {
  if (!isPlain(raw)) return null;
  const live = pick(raw, LIVE_SCHEMA);
  if (!live.state) live.state = 'unknown';
  return freeze(live);
}

// The process a conversation runs in: `interrupt` is 'tty' when that session's
// MCP server can inject an Esc (§15.2), else null; `mod` is a tier-2 mod
// attached to it (§15.1).
function processOf(v) {
  if (!isPlain(v)) return undefined;
  const p = pick(v, {
    pid: F.count, kind: F.word, entrypoint: F.text(40), cc_version: F.text(40),
    linked_by: F.oneOf('hook', 'sessions-file', 'mcp'),
  });
  p.interrupt = v.interrupt === 'tty' ? 'tty' : null;
  p.mod = v.mod === true;
  return p;
}

const CONVERSATION_SCHEMA = {
  id: F.id,
  rev: F.num,
  title: F.text(300),
  name: F.text(300),
  current_session_id: F.id,
  headless: F.bool,
  sessions: F.list(F.obj({ session_id: F.id, reason: F.word, started_at: F.num, ended_at: F.num }), 100),
  process: F.orNull(processOf),
  model: F.text(200),
  permission_mode: F.text(64),
  mode: F.text(64),
  effort: F.text(64),
  cost: F.orNull(F.obj({
    usd: F.orNull(F.num), source: F.orNull(F.oneOf('cost-state')),
    tokens: F.obj({ input: F.count, output: F.count, cache_read: F.count, cache_creation: F.count }),
  })),
  started_at: F.num,
  last_activity_at: F.num,
  ended_at: F.num,
  forked_from: F.id,
  away: F.orNull(F.obj({ text: F.text(2048), at: F.num })),
  turn_count: F.count,
  open_turn_id: F.id,
  counts: countsOf,
  diagnostics: F.obj({ unknown_kinds: countMapOf, bad_lines: F.count, oversize_lines: F.count,
    transcript: F.oneOf('ok', 'waiting', 'absent') }),
};

// Conversation (§2.10), with its Live under `live`. Below `read` there is no
// Conversation at all: statusFromConversation keeps the content-free part.
export function normalizeConversation(raw) {
  if (!isPlain(raw)) return null;
  const c = pick(raw, CONVERSATION_SCHEMA);
  if (!c.id) return null;
  c.headless = c.headless === true;
  if (!c.counts) c.counts = countsOf(null);
  c.live = has(raw, 'live') ? normalizeLive(raw.live) : null;
  return freeze(c);
}

// The StatusRow a conversation's live state implies (what a `mirror:status` row
// carries), stamped with the rev it came from.
export function statusFromConversation(c) {
  if (!c) return null;
  const live = c.live || {};
  const row = {
    id: c.id,
    state: live.state || 'unknown',
    quiet: !!live.quiet,
    counts: c.counts || countsOf(null),
  };
  if (Number.isFinite(live.since)) row.since = live.since;
  const kind = live.step && F.word(live.step.kind);
  if (kind) row.step_kind = kind;
  if (live.waiting && live.waiting.kind) row.waiting_kind = live.waiting.kind;
  if (Number.isFinite(live.last_activity_at)) row.last_activity_at = live.last_activity_at;
  if (live.state === 'ended' && live.ended_reason) row.ended_reason = live.ended_reason;
  const rev = Number.isFinite(live.rev) ? live.rev : c.rev;
  if (Number.isFinite(rev)) row.rev = rev;
  return freeze(row);
}

// TaskRow (§2.10). A row with no id or an unknown kind is dropped.
const TASK_SCHEMA = {
  id: F.id,
  rev: F.num,
  conversation_id: F.id,
  kind: F.oneOf(...TASK_KINDS),
  title: F.text(300),
  status: taskStatusOf,
  stopped_by: F.oneOf('claude', 'user', 'memory', 'session-end', 'timeout'),
  stop_requested_at: F.num,
  started_at: F.num,
  ended_at: F.num,
  exit_code: F.int,
  line: F.text(300),
  meta: F.obj({
    port: F.count, tools: F.count, events: F.count, last_event_at: F.num, no_output_yet: F.bool,
    step: F.obj({ index: F.count, total: F.count }), foreground: F.bool,
  }),
  steps: F.list(F.obj({ label: F.text(200), state: F.oneOf('done', 'running', 'pending', 'error') }), 32),
  owner: F.orNull(F.obj({ agent_id: F.id, title: F.text(300) })),
  turn_id: F.id,
  tool_use_id: F.id,
  can: F.obj({ output: F.bool, open: F.bool, stop: F.bool }),
};

export function normalizeTask(raw) {
  if (!isPlain(raw)) return null;
  const t = pick(raw, TASK_SCHEMA);
  if (!t.id || !t.kind) return null;
  if (!t.status) t.status = 'unknown';
  if (!t.meta) t.meta = {};
  if (!t.can) t.can = {};
  return freeze(t);
}

// AskPublic (§4.3): readable by panes, so it carries no subject, input,
// questions or plan; below `read` its basic projection only.
const ASK_SCHEMA = {
  id: F.id,
  conversation_id: F.id,
  kind: F.oneOf(...ASK_KINDS),
  tool_name: F.text(200),
  tool_kind: F.text(64),
  agent: F.orNull(F.obj({ type: F.text(100) })),
  created_at: F.num,
  state: F.oneOf('pending', 'decided', 'resolved'),
  answerable: F.bool,
  outcome: F.word,
  via: F.word,
  tool_use_id: F.id,
  version: F.count,
  masked: F.bool,
};
const ASK_BASIC_SCHEMA = { id: F.id, conversation_id: F.id, kind: F.oneOf(...ASK_KINDS), tool_kind: F.word,
  state: F.oneOf('pending', 'decided', 'resolved') };

export function normalizeAsk(raw, { level = 'local' } = {}) {
  if (!isPlain(raw)) return null;
  const a = pick(raw, atLeast(level, 'read') ? ASK_SCHEMA : ASK_BASIC_SCHEMA);
  if (!a.id || !a.kind) return null;
  if (!a.state) a.state = 'pending';
  a.source = 'ask';
  return freeze(a);
}

// Turn header (§2.4).
const TURN_SCHEMA = {
  id: F.id,
  rev: F.num,
  conversation_id: F.id,
  session_id: F.id,
  seq: F.num,
  kind: F.oneOf('prompt', 'task-notification', 'channel', 'command', 'shell', 'other'),
  author: F.oneOf('user', 'web', 'channel', 'parked', 'task-notification', 'system'),
  status: F.oneOf(...TURN_STATUS),
  provisional: F.bool,
  replaces: F.id,
  superseded: F.bool,
  started_at: F.num,
  ended_at: F.num,
  duration_ms: F.num,
  ended_by: F.oneOf(...ENDED_BY),
  prompt: F.orNull(F.obj({ preview: F.text(280), origin: F.word })),
  reply_preview: F.text(280),
  counts: F.obj({ items: F.count, tools: F.count, tool_errors: F.count, agents: F.count, tasks: F.count,
    edits: F.count }),
  tool_names: F.list(F.text(200), 8),
  groups: F.list(F.obj({ id: F.text(128), count: F.count, names: F.list(F.text(200), 8) }), 500),
  node: F.orNull(F.obj({ id: F.id, label: F.text(200), role: F.oneOf('commit', 'folded') })),
  folded_into: F.orNull(F.obj({ id: F.id, label: F.text(200) })),
  code: F.orNull(F.obj({ status: F.oneOf('pending', 'ready', 'unavailable'), files: F.count, additions: F.count,
    deletions: F.count, reason: F.text(200) })),
};

export function normalizeTurn(raw) {
  if (!isPlain(raw)) return null;
  const t = pick(raw, TURN_SCHEMA);
  if (!t.id) return null;
  return freeze(t);
}

// Item caps, characters (§2.4): what a frame and an `items=summary` read carry,
// and what a full read may (a tool card's own fetch).
const ITEM_CAPS = Object.freeze({
  summary: { prompt: 16384, reply: 32768, thinking: 4096, queued: 16384, text: 2048, label: 200, call: 2048,
    preview: 2048, patch: 16384, output: 2048, input: 512, inputTotal: 2048 },
  full: { prompt: 262144, reply: 1048576, thinking: 65536, queued: 262144, text: 65536, label: 200, call: 8192,
    preview: 262144, patch: 262144, output: 65536, input: 65536, inputTotal: 65536 },
});

const ATTACHMENT = F.obj({ n: F.count, kind: F.word, name: F.text(300), media_type: F.text(100), bytes: F.count });

// One schema for every item kind (their fields are optional and disjoint
// enough); `text` and `input` are read per kind below.
function itemSchema(c) {
  return {
    id: F.id, rev: F.num, conversation_id: F.id, turn_id: F.id, kind: F.oneOf(...ITEM_KINDS), seq: F.num, ts: F.num,
    source: F.oneOf('transcript', 'hook'), provisional: F.bool, truncated: F.bool, group: F.text(128),
    // prompt, reply, thinking
    origin: F.word, command: F.text(2048), attachments: F.list(ATTACHMENT, 32), model: F.text(200),
    message_id: F.text(128), chars: F.count, duration_ms: F.num,
    device: F.oneOf('desktop', 'mobile'), // a web prompt's push batch (ruling D2 (a))
    // tool_call
    tool: F.text(200), server: F.text(200), tool_kind: F.text(64), label: F.text(c.label), call: F.text(c.call),
    status: F.word, started_at: F.num, ended_at: F.num,
    result: F.obj({ preview: F.text(c.preview), bytes: F.count, is_error: F.bool, attachments: F.list(ATTACHMENT, 32),
      full: F.bool }),
    edit: F.obj({ path: F.text(1024), patch: F.text(c.patch) }),
    links: F.obj({ task_id: F.id, agent_id: F.id, run_id: F.id }),
    awaiting: F.obj({ ask_id: F.id, kind: F.word, status: F.word, by: F.word, outcome: F.word, decision: F.word }),
    // task
    task_id: F.id, task_kind: F.word, summary: F.text(c.text), exit_code: F.int, event: F.text(c.text),
    result_preview: F.text(c.text),
    // notice (a rewind's notice carries where it went back to, §15.4)
    notice: F.word, reason: F.word, at: F.num, returned_to: F.id, through_turn_id: F.id,
    // compact
    trigger: F.word, tokens: F.count, pre_tokens: F.count, post_tokens: F.count,
    // local, artifact
    local: F.text(200), output: F.text(c.output), is_error: F.bool, title: F.text(300), url: F.text(2048),
  };
}
const ITEM_SCHEMAS = { summary: itemSchema(ITEM_CAPS.summary), full: itemSchema(ITEM_CAPS.full) };

// A tool call's structured input: strings cut, at most 64 keys or entries a
// level, six levels deep. Past its total (the engine already holds it under) it
// is dropped whole and the item says `truncated`.
function inputOf(v, max, depth = 0) {
  if (typeof v === 'string') return cut(v, max);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean' || v === null) return v;
  if (depth >= 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => inputOf(x, max, depth + 1)).filter((x) => x !== undefined);
  if (!isPlain(v)) return undefined;
  const out = {};
  for (const k of Object.keys(v).slice(0, 64)) {
    if (k === '__proto__' || k.length > 128) continue;
    const x = inputOf(v[k], max, depth + 1);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

export function normalizeItem(raw, { caps = 'summary', turn_id } = {}) {
  if (!isPlain(raw)) return null;
  const c = ITEM_CAPS[caps] || ITEM_CAPS.summary;
  const it = pick(raw, ITEM_SCHEMAS[caps] || ITEM_SCHEMAS.summary);
  if (!it.turn_id && turn_id) it.turn_id = turn_id;
  if (!it.id || !it.kind || !it.turn_id) return null;
  if (typeof raw.text === 'string') it.text = cut(raw.text, c[it.kind] || c.text);
  if (has(raw, 'input')) {
    if (it.kind === 'local') {
      if (typeof raw.input === 'string') it.input = cut(raw.input, c.output);
    } else {
      const input = inputOf(raw.input, c.input);
      let size = Infinity;
      try { size = JSON.stringify(input).length; } catch { /* left out below */ }
      if (input !== undefined && size <= c.inputTotal) it.input = input;
      else it.truncated = true;
    }
  }
  return freeze(it);
}

// GET /api/mirror/conversations/:cid/turns → a page: turns with their items,
// ascending, plus the cursor and the rev the page was read at.
export function normalizeTurnPage(body) {
  if (!isPlain(body)) return null;
  const turns = [];
  for (const raw of Array.isArray(body.turns) ? body.turns.slice(0, MAX_TURNS) : []) {
    const t = normalizeTurn(raw);
    if (!t) continue;
    const items = [];
    for (const r of Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS_PER_TURN) : []) {
      const it = normalizeItem(r, { turn_id: t.id });
      if (it && it.turn_id === t.id) items.push(it);
    }
    turns.push({ turn: t, items });
  }
  return {
    conversation_id: F.id(body.conversation_id) || null,
    turns,
    next_before: F.num(body.next_before) ?? null,
    total: F.count(body.total) ?? null,
    rev: F.num(body.rev) ?? -1,
  };
}

// GET /api/mirror/turns/:turnId → one turn with its items at the FULL caps.
export function normalizeTurnDetail(body) {
  if (!isPlain(body)) return null;
  const turn = normalizeTurn(body.turn);
  if (!turn) return null;
  const items = [];
  for (const r of Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS_PER_TURN) : []) {
    const it = normalizeItem(r, { caps: 'full', turn_id: turn.id });
    if (it) items.push(it);
  }
  return { turn, items: freeze(items), rev: F.num(body.rev) ?? -1 };
}

export function normalizeAccess(raw) {
  if (!isPlain(raw) || !LEVELS.includes(raw.level)) return null;
  return freeze({ level: raw.level, remote: raw.remote === true });
}

// Every capability is false unless the daemon says `true` (§15.1: "what the
// chrome can offer is reported, never assumed").
export function normalizeCapabilities(raw) {
  const out = {};
  for (const k of CAPABILITIES) out[k] = isPlain(raw) && raw[k] === true;
  return freeze(out);
}

// GET /api/mirror (and GET /api/mirror/status, which has the same rows). Below
// `read` the body's conversations ARE StatusRows; at `read` and above they are
// Conversations, and the status rows are derived from them. A disabled mirror
// answers `{enabled: false}` (or `{ok: false, disabled: true}`) with its hint.
export function normalizeSnapshot(body) {
  if (!isPlain(body)) return null;
  const hint = F.text(500)(body.hint) || null;
  if (body.enabled === false || body.disabled === true) {
    return freeze({ disabled: true, hint, scope: F.word(body.scope) || null });
  }
  const access = normalizeAccess(body.access) || { level: 'basic', remote: false };
  const content = body.content !== false && atLeast(access.level, 'read');
  const level = content ? access.level : (atLeast(access.level, 'basic') ? 'basic' : access.level);
  const snap = {
    disabled: false,
    hint,
    now: F.num(body.now) ?? null,
    rev: F.num(body.rev) ?? -1,
    content,
    access: { level, remote: access.remote },
    capabilities: normalizeCapabilities(content ? body.capabilities : null),
    primary: F.id(body.primary) || null,
    aggregate: aggregateOf(body.aggregate),
    conversations: [],
    status: [],
    tasks: [],
    asks: [],
  };
  const rows = Array.isArray(body.conversations) ? body.conversations.slice(0, 500) : [];
  for (const raw of rows) {
    if (content) {
      const c = normalizeConversation(raw);
      if (c) { snap.conversations.push(c); snap.status.push(statusFromConversation(c)); }
    } else {
      const r = normalizeStatusRow(raw);
      if (r) snap.status.push(r);
    }
  }
  if (content) {
    for (const raw of Array.isArray(body.tasks) ? body.tasks.slice(0, 500) : []) {
      const t = normalizeTask(raw);
      if (t) snap.tasks.push(t);
    }
  }
  for (const raw of Array.isArray(body.asks) ? body.asks.slice(0, 100) : []) {
    const a = normalizeAsk(raw, { level });
    if (a) snap.asks.push(a);
  }
  return freeze(snap);
}

// One `mirror:*` frame (§2.9, §4.3, §5.4), as this store reads it, or null. A
// frame that needs `read` is refused whole below it; one with a rev must have one.
export function normalizeFrame(msg, { level = 'local' } = {}) {
  if (!isPlain(msg) || typeof msg.type !== 'string') return null;
  const content = atLeast(level, 'read');
  const rev = F.num(msg.rev);
  const now = F.num(msg.now);
  switch (msg.type) {
    case 'mirror:status': {
      if (rev === undefined) return null;
      const conversations = [];
      for (const raw of Array.isArray(msg.conversations) ? msg.conversations.slice(0, 500) : []) {
        const r = normalizeStatusRow(raw);
        if (r) conversations.push(r);
      }
      return { type: msg.type, rev, now, aggregate: aggregateOf(msg.aggregate), conversations };
    }
    case 'mirror:update': {
      const cid = F.id(msg.conversation_id);
      if (rev === undefined || !cid || !content) return null;
      const f = { type: msg.type, rev, now, conversation_id: cid };
      if (has(msg, 'conversation')) {
        const c = normalizeConversation(msg.conversation);
        if (c && c.id === cid) f.conversation = c;
      }
      if (has(msg, 'live')) { const l = normalizeLive(msg.live); if (l) f.live = l; }
      if (Array.isArray(msg.tasks)) {
        f.tasks = msg.tasks.slice(0, 500).map(normalizeTask).filter(Boolean);
      }
      if (Array.isArray(msg.removed_tasks)) f.removed_tasks = msg.removed_tasks.slice(0, 500).map(F.id).filter(Boolean);
      if (msg.removed === true) f.removed = true;
      const into = F.id(msg.merged_into);
      if (into) f.merged_into = into;
      return f;
    }
    case 'mirror:stream': {
      const cid = F.id(msg.conversation_id);
      if (rev === undefined || !cid || !content) return null;
      const f = { type: msg.type, rev, now, conversation_id: cid };
      if (Array.isArray(msg.turns)) f.turns = msg.turns.slice(0, MAX_TURNS).map(normalizeTurn).filter(Boolean);
      if (Array.isArray(msg.items)) f.items = msg.items.slice(0, MAX_ITEMS_PER_TURN).map((r) => normalizeItem(r)).filter(Boolean);
      if (Array.isArray(msg.removed_items)) f.removed_items = msg.removed_items.slice(0, MAX_ITEMS_PER_TURN).map(F.id).filter(Boolean);
      return f;
    }
    case 'mirror:reset':
      return { type: msg.type, reason: F.word(msg.reason) || 'unknown', conversation_id: F.id(msg.conversation_id) || null };
    case 'mirror:access': {
      const access = normalizeAccess(msg);
      return access ? { type: msg.type, ...access } : null;
    }
    case 'mirror:ask': {
      const op = F.oneOf('open', 'update', 'close')(msg.op);
      const ask = normalizeAsk(msg.ask, { level });
      return op && ask ? { type: msg.type, op, ask } : null;
    }
    default:
      return null;
  }
}

// ── the store ────────────────────────────────────────────────────────────────

const blankStream = () => ({ conversationId: null, turns: Object.freeze([]), hasOlder: false, loading: false });

// Read it; never write it. Beside §7.3's fields: `aggregate` (the daemon's
// aggregate state), `rev` (the newest rev applied) and `seen` (the finished
// tasks the user has been shown, which a failure waits for before it may go).
export const mirror = {
  v: 1,
  conn: 'connecting',
  connSince: Date.now(),
  availability: 'unknown',
  hint: null,
  access: Object.freeze({ level: 'basic', remote: false }),
  capabilities: normalizeCapabilities(null),
  skew: 0,
  conversations: new Map(),
  followed: null,
  serverPrimary: null,
  status: new Map(),
  tasks: new Map(),
  awaiting: new Map(),
  stream: blankStream(),
  aggregate: Object.freeze({ state: 'unknown' }),
  rev: -1,
  seen: new Set(),
};

let fetchFn = (url, init) => globalThis.fetch(url, init);
let inited = null;
let chosen = null;            // the user's followed conversation, this tab (wc:chat-follow)
let posture = 'status';       // 'full' while a chat view is open (chat-slots.js)
const asks = new Map();       // AskPublic from the snapshot and mirror:ask frames
const finishedAt = new Map(); // task id → when a finished row with no ended_at was first held

// Hydration.
let hydrated = false;
let hydrating = null;
let hydrateAgain = false;
let lastAttempt = 0;
let buffer = [];
let overflowed = false;
let statusRev = -1;

// The followed conversation's stream: per turn its header and items, and the
// frozen view consumers read, rebuilt only for a turn that changed.
const sTurns = new Map();     // turn id → { h: header, items: Map<item id, item> }
const sViews = new Map();     // turn id → frozen Turn with its `items`
const sItemTurn = new Map();  // item id → the turn id holding it
let streamToken = 0;
let streamFresh = false;      // the stream was read while frames for it were flowing
let streamPaging = false;     // a first page is in flight: stream frames wait
let streamBuffer = [];
let olderInFlight = null;

const level = () => mirror.access.level;
const contentOk = () => atLeast(level(), 'read');
export const serverNow = () => Date.now() + mirror.skew;

function notify(what) {
  bus.emit('mirror', { what: [...new Set(what)] });
}

function noteSkew(now) {
  if (Number.isFinite(now)) mirror.skew = now - Date.now();
}

function noteRev(rev) {
  if (Number.isFinite(rev) && rev > mirror.rev) mirror.rev = rev;
}

function setConn(state) {
  if (!CONN_STATES.has(state) || state === mirror.conn) return;
  mirror.conn = state;
  mirror.connSince = Date.now();
  notify(['conn']);
}

// ── following ────────────────────────────────────────────────────────────────

const RANK = { waiting: 6, question: 5, working: 4, compacting: 4, suspended: 3, idle: 2, unknown: 1, ended: 0 };

function stateOfConversation(id) {
  const c = mirror.conversations.get(id);
  if (c && c.live) return c.live.state;
  const r = mirror.status.get(id);
  return r ? r.state : null;
}
const known = (id) => !!id && (mirror.conversations.has(id) || mirror.status.has(id));
const isLive = (id) => known(id) && stateOfConversation(id) !== 'ended';
const lastActive = (id) => {
  const c = mirror.conversations.get(id);
  const r = mirror.status.get(id);
  return (c && (c.last_activity_at || (c.live && c.live.last_activity_at))) || (r && r.last_activity_at) || 0;
};

// Whether the store may follow a conversation on its own: one KNOWN not to be
// headless. A `claude -p` job never becomes primary (§2.2), and is followed only
// when this tab chose it (the session switcher's "Show headless"). At `read` and
// above a conversation's record says which it is; a StatusRow does not, so below
// `read` (and for a row whose record has not arrived) only the server's primary
// is known to be interactive.
function isInteractive(id) {
  if (!known(id)) return false;
  const c = mirror.conversations.get(id);
  if (c && typeof c.headless === 'boolean') return !c.headless;
  return id === mirror.serverPrimary;
}

// The tab's own choice while it is live (any conversation, a headless one
// included), else the server's primary while it is live. Between snapshots the
// server's rule is applied here, at `read` and above only: the most urgent, then
// the most recently active, live interactive conversation. Failing those, what
// was followed, then the server's primary, then the most recently active
// interactive conversation, so an ended session can still say it ended. No
// fallback ever reaches a headless conversation: with no other, nothing is
// followed and the bar says "No Claude session". Below `read` nothing is picked
// from the rows at all; askAgain() asks the server instead.
function resolveFollowed() {
  if (chosen && isLive(chosen)) return chosen;
  const primary = mirror.serverPrimary;
  if (isLive(primary) && isInteractive(primary)) return primary;
  let best = null;
  for (const id of mirror.conversations.keys()) {
    if (!isLive(id) || !isInteractive(id)) continue;
    const rank = RANK[stateOfConversation(id)] || 0;
    const top = best ? RANK[stateOfConversation(best)] || 0 : -1;
    if (rank > top || (rank === top && lastActive(id) > lastActive(best))) best = id;
  }
  if (best) return best;
  if (isInteractive(mirror.followed)) return mirror.followed;
  if (isInteractive(primary)) return primary;
  let recent = null;
  for (const id of mirror.conversations.keys()) {
    if (isInteractive(id) && (!recent || lastActive(id) > lastActive(recent))) recent = id;
  }
  return recent;
}

// Below `read` a StatusRow cannot say whether its session is interactive, so the
// store never picks one itself (above) and the server's primary stands until the
// next snapshot. The aggregate speaks for the interactive conversations only
// (`none` while there are none, lib/server/mirror/emit.js), so when it names a
// live state while nothing live is followed, the primary has moved on since that
// snapshot: the snapshot is read again. Once for each set of live conversations,
// so a server that names no primary is never asked twice about the same ones.
const LIVE_AGGREGATE = new Set([...STATES].filter((s) => s !== 'ended'));
let askedLive = null;         // the live conversations the server was last asked about
const liveRows = () => [...mirror.status.values()].filter((r) => r.state !== 'ended').map((r) => r.id).sort().join(' ');

function primaryStale() {
  if (contentOk() || mirror.availability !== 'ok' || isLive(mirror.followed)) return false;
  if (!LIVE_AGGREGATE.has(mirror.aggregate.state)) return false;
  const live = liveRows();
  return live !== '' && live !== askedLive;
}

// True when the snapshot should be read again (primaryStale), noting the live
// conversations it is read for; the caller reads it.
function askAgain() {
  if (!primaryStale()) return false;
  askedLive = liveRows();
  return true;
}

function refollow() {
  const next = resolveFollowed();
  if (next === mirror.followed) return false;
  mirror.followed = next;
  resetStream(next);
  if (streamWanted() && !hydrating) fireStream();   // a hydrate reads the page itself when it ends
  return true;
}

export function followed() { return mirror.followed; }

// Follow a conversation in this tab (null: back to the server's primary).
export function followConversation(id) {
  chosen = F.id(id) || null;
  if (chosen) setSession(FOLLOW_KEY, chosen);
  else removeSession(FOLLOW_KEY);
  if (refollow()) notify(['conversations', 'stream']);
  return mirror.followed;
}

// ── tasks: bounds and what has been seen ─────────────────────────────────────

function isUnseenFailure(t) {
  return !!t && t.status === 'failed' && !mirror.seen.has(t.id);
}

function dropTask(id) {
  mirror.tasks.delete(id);
  mirror.seen.delete(id);
  finishedAt.delete(id);
}

// A finished row goes 15 minutes after it ended — unless it failed and nobody
// has seen it yet.
function pruneTasks(now = serverNow()) {
  let changed = false;
  for (const t of [...mirror.tasks.values()]) {
    if (!FINISHED.has(t.status)) continue;
    let end = t.ended_at;
    if (!Number.isFinite(end)) {
      if (!finishedAt.has(t.id)) finishedAt.set(t.id, now);
      end = finishedAt.get(t.id);
    }
    if (now - end < TASK_KEEP_MS || isUnseenFailure(t)) continue;
    dropTask(t.id);
    changed = true;
  }
  return changed;
}

// The user has been shown these finished rows (a tray opened on them, the
// phone's category page): a failure among them may now go like any other.
export function markSeen(ids) {
  let any = false;
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    if (!mirror.tasks.has(id) || mirror.seen.has(id)) continue;
    mirror.seen.add(id);
    any = true;
  }
  if (any && pruneTasks()) notify(['tasks']);
  return any;
}

function putTask(t, frameRev) {
  const held = mirror.tasks.get(t.id);
  const rev = Number.isFinite(t.rev) ? t.rev : frameRev;
  if (held && Number.isFinite(held.rev) && Number.isFinite(rev) && rev <= held.rev) return false;
  mirror.tasks.set(t.id, Number.isFinite(rev) && t.rev !== rev ? freeze({ ...t, rev }) : t);
  if (!FINISHED.has(t.status)) finishedAt.delete(t.id);
  return true;
}

function removeTaskAt(id, frameRev) {
  const held = mirror.tasks.get(id);
  if (!held) return false;
  if (Number.isFinite(held.rev) && Number.isFinite(frameRev) && frameRev <= held.rev) return false;
  if (isUnseenFailure(held)) return false;
  dropTask(id);
  return true;
}

// ── awaiting ─────────────────────────────────────────────────────────────────

// The asks the daemon sent, plus each conversation's live wait — the read-only
// card's subject (`summary`) folded into its ask when they are the same wait,
// or an entry of its own (`source: 'live'`) when no ask stands for it.
function rebuildAwaiting() {
  const next = new Map(asks);
  const addWait = (cid, kind, w) => {
    const askId = w && w.ask_id;
    let into = askId && next.has(askId) ? next.get(askId) : null;
    if (!into) {
      for (const a of next.values()) {
        if (a.source === 'ask' && a.conversation_id === cid && a.state === 'pending' && a.kind === kind) { into = a; break; }
      }
    }
    if (into) {
      if (w && w.summary !== undefined) next.set(into.id, freeze({ ...into, summary: w.summary }));
      return;
    }
    const id = askId || `live:${cid}`;
    const entry = { id, conversation_id: cid, kind, state: 'pending', answerable: false, source: 'live' };
    if (w && w.tool !== undefined) entry.tool_name = w.tool;
    if (w && w.summary !== undefined) entry.summary = w.summary;
    if (w && w.tool_use_id) entry.tool_use_id = w.tool_use_id;
    next.set(id, freeze(entry));
  };
  if (contentOk()) {
    for (const c of mirror.conversations.values()) {
      const w = c.live && c.live.waiting;
      if (w && w.kind) addWait(c.id, w.kind, w);
    }
  } else {
    for (const r of mirror.status.values()) if (r.waiting_kind) addWait(r.id, r.waiting_kind, null);
  }
  mirror.awaiting = next;
}

// ── the stream ───────────────────────────────────────────────────────────────

const bySeq = (a, b) => {
  const sa = Number.isFinite(a.seq) ? a.seq : Infinity;
  const sb = Number.isFinite(b.seq) ? b.seq : Infinity;
  if (sa !== sb) return sa < sb ? -1 : 1;
  return (a.ts || a.started_at || 0) - (b.ts || b.started_at || 0);
};

function setTurn(id, h, items) {
  sTurns.set(id, { h, items });
  for (const iid of items.keys()) sItemTurn.set(iid, id);
  sViews.delete(id);
}

function dropTurn(id) {
  const e = sTurns.get(id);
  if (!e) return;
  for (const iid of e.items.keys()) if (sItemTurn.get(iid) === id) sItemTurn.delete(iid);
  sTurns.delete(id);
  sViews.delete(id);
}

function turnView(id) {
  let v = sViews.get(id);
  if (!v) {
    const e = sTurns.get(id);
    const items = [...e.items.values()].sort(bySeq);
    v = Object.freeze({ ...e.h, items: Object.freeze(items) });
    sViews.set(id, v);
  }
  return v;
}

function oldestSeq() {
  let min = Infinity;
  for (const e of sTurns.values()) if (Number.isFinite(e.h.seq) && e.h.seq < min) min = e.h.seq;
  return min;
}

// Rebuild the turn list consumers read; past the bound the oldest turns go.
function publishStream() {
  const heads = [...sTurns.values()].map((e) => e.h).sort(bySeq);
  while (heads.length > MAX_TURNS) {
    const drop = heads.shift();
    dropTurn(drop.id);
    mirror.stream.hasOlder = true;
  }
  mirror.stream.turns = Object.freeze(heads.map((h) => turnView(h.id)));
}

function resetStream(cid) {
  streamToken++;
  sTurns.clear();
  sViews.clear();
  sItemTurn.clear();
  streamFresh = false;
  streamPaging = false;
  streamBuffer = [];
  mirror.stream = blankStream();
  mirror.stream.conversationId = cid || null;
}

const streamWanted = () => posture === 'full' && contentOk() && !!mirror.followed && mirror.availability === 'ok';

// A turn header: newer replaces the held one (its items kept); an unknown turn
// joins only inside the window (or after it), so a frame about an old turn
// never opens a gap at the top.
function upsertTurn(h, frameRev) {
  const rev = Number.isFinite(h.rev) ? h.rev : frameRev;
  const header = Number.isFinite(rev) && h.rev !== rev ? freeze({ ...h, rev }) : h;
  if (header.replaces && header.replaces !== header.id && sTurns.has(header.replaces)) {
    // An alias: the provisional turn took the transcript's id. Its items move
    // with it; the ones the engine re-keyed arrive in this frame, and their old
    // ids leave as removed.
    const old = sTurns.get(header.replaces);
    dropTurn(header.replaces);
    const into = sTurns.get(header.id);
    const items = into ? into.items : new Map();
    for (const [iid, it] of old.items) if (!items.has(iid)) items.set(iid, it);
    setTurn(header.id, into && Number.isFinite(into.h.rev) && rev <= into.h.rev ? into.h : header, items);
    return true;
  }
  const held = sTurns.get(header.id);
  if (held) {
    if (Number.isFinite(held.h.rev) && Number.isFinite(rev) && rev <= held.h.rev) return false;
    held.h = header;
    sViews.delete(header.id);
    return true;
  }
  const min = oldestSeq();
  const inWindow = sTurns.size === 0 ? !mirror.stream.hasOlder : !Number.isFinite(header.seq) || header.seq >= min;
  if (!inWindow) return false;
  setTurn(header.id, header, new Map());
  return true;
}

function upsertItem(it, frameRev) {
  const e = sTurns.get(it.turn_id);
  if (!e) return false;
  const rev = Number.isFinite(it.rev) ? it.rev : frameRev;
  const held = e.items.get(it.id);
  if (held && Number.isFinite(held.rev) && Number.isFinite(rev) && rev <= held.rev) return false;
  // An item that moved turns leaves the one it was in.
  const was = sItemTurn.get(it.id);
  if (was && was !== it.turn_id && sTurns.has(was)) {
    sTurns.get(was).items.delete(it.id);
    sViews.delete(was);
  }
  e.items.set(it.id, Number.isFinite(rev) && it.rev !== rev ? freeze({ ...it, rev }) : it);
  sItemTurn.set(it.id, it.turn_id);
  if (e.items.size > MAX_ITEMS_PER_TURN) {
    const oldest = [...e.items.values()].sort(bySeq)[0];
    e.items.delete(oldest.id);
    sItemTurn.delete(oldest.id);
  }
  sViews.delete(it.turn_id);
  return true;
}

function removeStreamItem(id, frameRev) {
  const tid = sItemTurn.get(id);
  const e = tid && sTurns.get(tid);
  const held = e && e.items.get(id);
  if (!held) return false;
  if (Number.isFinite(held.rev) && Number.isFinite(frameRev) && frameRev <= held.rev) return false;
  e.items.delete(id);
  sItemTurn.delete(id);
  sViews.delete(tid);
  return true;
}

function applyStreamFrame(f) {
  if (f.conversation_id !== mirror.stream.conversationId) return false;
  if (streamPaging) {
    streamBuffer.push(f);
    if (streamBuffer.length > MAX_BUFFER) streamBuffer.shift();
    return false;
  }
  let changed = false;
  for (const t of f.turns || []) changed = upsertTurn(t, f.rev) || changed;
  for (const it of f.items || []) changed = upsertItem(it, f.rev) || changed;
  for (const id of f.removed_items || []) changed = removeStreamItem(id, f.rev) || changed;
  if (changed) publishStream();
  return changed;
}

async function getJson(url) {
  let res;
  try { res = await fetchFn(url); } catch { return { ok: false, status: 0, body: null }; }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: !!(res && res.ok), status: (res && res.status) || 0, body };
}

const turnsUrl = (cid, before) => `/api/mirror/conversations/${encodeURIComponent(cid)}/turns?`
  + `${before !== undefined ? `before=${encodeURIComponent(before)}&` : ''}limit=${STREAM_PAGE}&items=summary`;

// The newest page of the followed conversation. Its stream frames wait while
// it is read and are replayed after it, those at or below the page's rev
// dropped. A refresh of the same conversation keeps what is shown until the
// page lands; a new conversation starts empty.
async function loadStream() {
  const cid = mirror.followed;
  if (!cid || !contentOk()) return false;
  if (mirror.stream.conversationId !== cid) resetStream(cid);
  const token = ++streamToken;
  streamPaging = true;
  streamBuffer = [];
  mirror.stream.loading = true;
  notify(['stream']);
  const r = await getJson(turnsUrl(cid));
  if (token !== streamToken) return false;
  streamPaging = false;
  mirror.stream.loading = false;
  const page = r.ok ? normalizeTurnPage(r.body) : null;
  if (page && (!page.conversation_id || page.conversation_id === cid)) {
    sTurns.clear();
    sViews.clear();
    sItemTurn.clear();
    for (const { turn, items } of page.turns) setTurn(turn.id, turn, new Map(items.map((it) => [it.id, it])));
    mirror.stream.hasOlder = page.next_before !== null || (page.total !== null && page.total > page.turns.length);
    streamFresh = true;
    const waiting = streamBuffer;
    streamBuffer = [];
    for (const f of waiting) if (f.rev > page.rev) applyStreamFrame(f);
  } else {
    streamBuffer = [];
  }
  publishStream();
  notify(['stream']);
  return !!page;
}

// Fire and forget: a page read never rejects, and a failure leaves the stream as
// it was.
function fireStream() {
  loadStream().catch((e) => console.error('[web-chat] chat stream read failed', e));
}

// One older page, one request at a time. False when there is none to read, a
// read is under way elsewhere, or the store already holds its 300 turns.
export function loadOlder() {
  if (olderInFlight) return olderInFlight;
  const s = mirror.stream;
  const cid = s.conversationId;
  const before = oldestSeq();
  if (!cid || !contentOk() || !s.hasOlder || s.loading || streamPaging || sTurns.size >= MAX_TURNS
    || !Number.isFinite(before)) return Promise.resolve(false);
  const token = streamToken;
  s.loading = true;
  notify(['stream']);
  const read = (async () => {
    const r = await getJson(turnsUrl(cid, before));
    if (token !== streamToken) return false;
    s.loading = false;
    const page = r.ok ? normalizeTurnPage(r.body) : null;
    let added = 0;
    if (page) {
      for (const { turn, items } of page.turns) {
        if (sTurns.has(turn.id) || !(Number.isFinite(turn.seq) && turn.seq < before)) continue;
        if (sTurns.size >= MAX_TURNS) break;
        setTurn(turn.id, turn, new Map(items.map((it) => [it.id, it])));
        added++;
      }
      s.hasOlder = page.next_before !== null;
      publishStream();
    }
    notify(['stream']);
    return added > 0;
  })();
  olderInFlight = read.finally(() => { olderInFlight = null; });
  return olderInFlight;
}

// ── folding ──────────────────────────────────────────────────────────────────

function putConversation(c, frameRev) {
  const held = mirror.conversations.get(c.id);
  const rev = Number.isFinite(c.rev) ? c.rev : frameRev;
  if (held && Number.isFinite(held.rev) && Number.isFinite(rev) && rev <= held.rev) return false;
  // The frame's embedded live wins only when it is the newer one.
  let live = c.live;
  if (held && held.live && (!live || (Number.isFinite(held.live.rev) && !(live.rev > held.live.rev)))) live = held.live;
  mirror.conversations.set(c.id, freeze({ ...c, rev, live }));
  return true;
}

function putLive(cid, live, frameRev) {
  const held = mirror.conversations.get(cid);
  const rev = Number.isFinite(live.rev) ? live.rev : frameRev;
  if (held && held.live && Number.isFinite(held.live.rev) && Number.isFinite(rev) && rev <= held.live.rev) return false;
  const next = Number.isFinite(rev) && live.rev !== rev ? freeze({ ...live, rev }) : live;
  // A live state ahead of its conversation's record: whether it is headless is
  // not known until the record arrives (`null`), so nothing follows it on its own.
  mirror.conversations.set(cid, freeze({ ...(held || { id: cid, headless: null, counts: countsOf(null) }), live: next }));
  return true;
}

function removeConversation(cid, frameRev, mergedInto) {
  const held = mirror.conversations.get(cid);
  if (held && Number.isFinite(held.rev) && Number.isFinite(frameRev) && frameRev <= held.rev) return false;
  mirror.conversations.delete(cid);
  mirror.status.delete(cid);
  for (const t of [...mirror.tasks.values()]) if (t.conversation_id === cid && !isUnseenFailure(t)) dropTask(t.id);
  if (mergedInto && chosen === cid) {
    chosen = mergedInto;
    setSession(FOLLOW_KEY, chosen);
  }
  return true;
}

// The status row a newer live state implies, so statusOf() and the basic
// wording never lag the richer record.
function syncStatus(cid) {
  const c = mirror.conversations.get(cid);
  if (!c || !c.live) return;
  const row = statusFromConversation(c);
  const held = mirror.status.get(cid);
  if (!held || !Number.isFinite(held.rev) || !Number.isFinite(row.rev) || row.rev >= held.rev) {
    mirror.status.set(cid, held && held.ended_reason && !row.ended_reason ? freeze({ ...row, ended_reason: held.ended_reason }) : row);
  }
}

function applyFrame(f) {
  const what = new Set();
  noteSkew(f.now);
  switch (f.type) {
    case 'mirror:status': {
      if (f.rev <= statusRev) break;
      statusRev = f.rev;
      noteRev(f.rev);
      mirror.status = new Map(f.conversations.map((r) => [r.id, freeze({ ...r, rev: f.rev })]));
      mirror.aggregate = freeze(f.aggregate);
      // The rows are every conversation's. At `read` and above a conversation
      // still held (its removal comes as a mirror:update) keeps the row its own
      // live state implies.
      for (const c of mirror.conversations.values()) if (!mirror.status.has(c.id) && c.live) syncStatus(c.id);
      what.add('status');
      if (!contentOk()) { rebuildAwaiting(); what.add('awaiting'); }
      break;
    }
    case 'mirror:update': {
      noteRev(f.rev);
      const cid = f.conversation_id;
      if (f.removed || f.merged_into) {
        if (removeConversation(cid, f.rev, f.merged_into)) what.add('conversations').add('status').add('tasks');
      } else {
        if (f.conversation && putConversation(f.conversation, f.rev)) what.add('conversations');
        if (f.live && putLive(cid, f.live, f.rev)) what.add('conversations').add('status');
        if (what.has('conversations')) syncStatus(cid);
      }
      for (const t of f.tasks || []) {
        if (putTask(t.conversation_id ? t : freeze({ ...t, conversation_id: cid }), f.rev)) what.add('tasks');
      }
      for (const id of f.removed_tasks || []) if (removeTaskAt(id, f.rev)) what.add('tasks');
      if (what.has('conversations')) { rebuildAwaiting(); what.add('awaiting'); }
      break;
    }
    case 'mirror:stream':
      noteRev(f.rev);
      if (applyStreamFrame(f)) what.add('stream');
      break;
    case 'mirror:ask': {
      const held = asks.get(f.ask.id);
      if (f.op === 'close') {
        if (!asks.delete(f.ask.id)) break;
      } else if (held && Number.isFinite(held.version) && Number.isFinite(f.ask.version) && f.ask.version < held.version) {
        break;
      } else {
        asks.set(f.ask.id, f.ask);
      }
      rebuildAwaiting();
      what.add('awaiting');
      break;
    }
    case 'mirror:access': {
      const before = level();
      mirror.access = freeze({ level: f.level, remote: f.remote });
      if (levelRank(f.level) < levelRank(before) && !atLeast(f.level, 'read')) purgeContent();
      if (f.level !== before) hydrateMirror();
      what.add('all');
      break;
    }
    case 'mirror:reset':
      // A reset says what no delta can, whatever its scope or reason: a
      // conversation removed and added back between two flushes (`rebuilt`,
      // whose old task rows no frame drops), frames that failed to go out
      // (`error`), a catch-up whose frames were held back, the mirror switched
      // off. And a reason is no promise of what was lost (a reset already due
      // keeps its own), so every one reads the snapshot again, and the followed
      // stream after it while a chat view is open.
      hydrateMirror();
      break;
    default:
      break;
  }
  return what;
}

// Below `read` nothing but states, counts and timings stays.
function purgeContent() {
  for (const c of mirror.conversations.values()) {
    if (!mirror.status.has(c.id)) mirror.status.set(c.id, statusFromConversation(c));
  }
  mirror.conversations.clear();
  mirror.tasks.clear();
  mirror.seen.clear();
  finishedAt.clear();
  for (const [id, a] of [...asks]) {
    const basic = normalizeAsk(a, { level: 'basic' });
    if (basic) asks.set(id, basic); else asks.delete(id);
  }
  mirror.capabilities = normalizeCapabilities(null);
  resetStream(mirror.followed);
  rebuildAwaiting();
}

function bufferFrame(msg) {
  buffer.push(msg);
  if (buffer.length > MAX_BUFFER) {
    buffer.shift();
    overflowed = true;   // a frame newer than the coming snapshot may be gone: read again after it
  }
}

// One `mirror:*` frame from the socket. Before the first snapshot it waits;
// after, it is applied if it is newer than what the store holds.
export function foldMirrorFrame(msg) {
  if (!hydrated || hydrating) {
    if (isPlain(msg) && typeof msg.type === 'string' && msg.type.startsWith('mirror:')) bufferFrame(msg);
    if (!hydrated && !hydrating && inited && lastAttempt && Date.now() - lastAttempt >= RETRY_MS) hydrateMirror();
    return;
  }
  const f = normalizeFrame(msg, { level: level() });
  if (!f) return;
  const what = applyFrame(f);
  const followMoved = refollow();
  if (followMoved) what.add('conversations').add('stream');
  if (pruneTasks()) what.add('tasks');
  if (what.size) notify([...what]);
  if (!hydrating && askAgain()) hydrateMirror();
}

function applySnapshot(snap) {
  mirror.availability = 'ok';
  mirror.hint = snap.hint;
  mirror.access = freeze({ ...snap.access });
  mirror.capabilities = snap.capabilities;
  noteSkew(snap.now);
  mirror.serverPrimary = snap.primary;
  mirror.aggregate = freeze({ ...snap.aggregate });
  mirror.conversations = new Map(snap.conversations.map((c) => [c.id, c]));
  mirror.status = new Map(snap.status.map((r) => [r.id, Number.isFinite(r.rev) ? r : freeze({ ...r, rev: snap.rev })]));
  const tasks = new Map(snap.tasks.map((t) => [t.id, t]));
  // A failure nobody has seen outlives a snapshot that no longer lists it.
  for (const t of mirror.tasks.values()) if (!tasks.has(t.id) && isUnseenFailure(t) && snap.content) tasks.set(t.id, t);
  mirror.tasks = tasks;
  for (const id of [...mirror.seen]) if (!tasks.has(id)) mirror.seen.delete(id);
  for (const id of [...finishedAt.keys()]) if (!tasks.has(id)) finishedAt.delete(id);
  asks.clear();
  for (const a of snap.asks) asks.set(a.id, a);
  statusRev = snap.rev;
  mirror.rev = Math.max(mirror.rev, snap.rev);
  if (!snap.content) resetStream(mirror.followed);
  rebuildAwaiting();
}

function clearForUnavailable(availability, hint) {
  mirror.availability = availability;
  mirror.hint = hint || null;
  mirror.conversations.clear();
  mirror.status.clear();
  mirror.tasks.clear();
  mirror.seen.clear();
  finishedAt.clear();
  asks.clear();
  mirror.serverPrimary = null;
  askedLive = null;
  mirror.capabilities = normalizeCapabilities(null);
  mirror.aggregate = freeze({ state: 'unknown' });
  resetStream(null);
  rebuildAwaiting();
}

async function hydrateOnce() {
  const r = await getJson('/api/mirror');
  const waiting = buffer;
  const lost = overflowed;
  buffer = [];
  overflowed = false;
  let snapRev = null;
  if (r.ok && isPlain(r.body)) {
    const snap = normalizeSnapshot(r.body);
    if (snap && snap.disabled) clearForUnavailable('disabled', snap.hint);
    else if (snap) {
      applySnapshot(snap);
      snapRev = snap.rev;
      askedLive = liveRows();   // the live conversations this primary was named among
    } else clearForUnavailable('unavailable', null);
    hydrated = true;
  } else if (r.status === 404) {
    // An older daemon: there is no mirror to read.
    clearForUnavailable('unavailable', null);
    hydrated = true;
  } else if (r.status === 403) {
    clearForUnavailable('unavailable', isPlain(r.body) ? F.text(500)(r.body.hint) : null);
    mirror.access = freeze({ level: 'off', remote: !!(isPlain(r.body) && r.body.remote === true) });
    hydrated = true;
  } else if (!hydrated) {
    // Nothing read, and nothing ever was: the frames wait for the next try.
    buffer = waiting.concat(buffer);
    return false;
  }
  let again = lost;
  if (mirror.availability === 'ok') {
    for (const msg of waiting) {
      const f = normalizeFrame(msg, { level: level() });
      if (!f) continue;
      if (f.type === 'mirror:reset' || f.type === 'mirror:access') { again = true; continue; }
      if (snapRev !== null && Number.isFinite(f.rev) && f.rev <= snapRev) continue;
      applyFrame(f);
    }
  }
  refollow();
  pruneTasks();
  // Frames newer than the snapshot may hold a live session it did not know of.
  if (askAgain()) again = true;
  if (again) hydrateAgain = true;
  return true;
}

// Read GET /api/mirror and replace what the store holds with it: on every
// `hello`, after every `mirror:reset`, when the level changes, and below `read`
// when the server's primary has gone stale (askAgain). Calls while one is under
// way fold into one more read after it.
export function hydrateMirror() {
  if (hydrating) {
    hydrateAgain = true;
    return hydrating;
  }
  lastAttempt = Date.now();
  hydrating = (async () => {
    try {
      await hydrateOnce();
    } catch (e) {
      // Never rejects: the hello hook does not wait for it.
      console.error('[web-chat] chat mirror hydrate failed', e);
    } finally {
      hydrating = null;
    }
    notify(['all']);
    if (hydrateAgain) {
      hydrateAgain = false;
      await hydrateMirror();
    } else if (streamWanted()) {
      await loadStream().catch((e) => console.error('[web-chat] chat stream read failed', e));
    }
    return mirror;
  })();
  return hydrating;
}

function setPosture(next) {
  if (next !== 'full' && next !== 'status') return;
  if (next === posture) return;
  posture = next;
  if (posture === 'full') {
    // The stream's frames reach this socket only while a chat view is open, so
    // whatever was held is re-read.
    if (streamWanted() && !hydrating && (!streamFresh || mirror.stream.conversationId !== mirror.followed)) fireStream();
  } else {
    streamFresh = false;
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

// A conversation's StatusRow (the followed one's by default).
export function statusOf(id = mirror.followed) {
  if (!id) return null;
  return mirror.status.get(id) || statusFromConversation(mirror.conversations.get(id)) || null;
}

// Task rows, oldest first: one conversation's, or every one's.
export function tasksOf(conversationId) {
  const out = [];
  for (const t of mirror.tasks.values()) if (!conversationId || t.conversation_id === conversationId) out.push(t);
  return out.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
}

// What blocks a conversation (the followed one's by default): pending first,
// then the newest.
export function awaitingOf(conversationId = mirror.followed) {
  const out = [];
  for (const a of mirror.awaiting.values()) if (!conversationId || a.conversation_id === conversationId) out.push(a);
  return out.sort((a, b) => (a.state === 'pending' ? 0 : 1) - (b.state === 'pending' ? 0 : 1)
    || (b.created_at || 0) - (a.created_at || 0));
}

// ── wiring ───────────────────────────────────────────────────────────────────

// `onFrame` and `onHello` are ws.js's seams; `fetch` defaults to the page's;
// `conn` is the socket's state when the store starts later than the socket.
// A second call only swaps the fetch.
export function initChatState({ onFrame, onHello, fetch, conn } = {}) {
  if (typeof fetch === 'function') fetchFn = fetch;
  if (inited) return inited;
  const offs = [];
  if (typeof onFrame === 'function') offs.push(onFrame('mirror:', foldMirrorFrame));
  if (typeof onHello === 'function') {
    offs.push(onHello(() => {
      setConn('live');   // a hello only ever arrives on an open socket
      hydrateMirror();
    }));
  }
  offs.push(bus.on('conn', (d) => setConn(d && d.state)));
  offs.push(bus.on('chat:posture', (d) => setPosture(d && d.posture)));
  if (conn) setConn(conn);
  if (!chosen) chosen = F.id(getSession(FOLLOW_KEY)) || null;
  inited = {
    stop() {
      for (const off of offs) if (typeof off === 'function') off();
      inited = null;
    },
  };
  return inited;
}

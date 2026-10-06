// lib/server/mirror/agents.js — the agents source: Agent (and legacy Task)
// subagents as TaskRows, a light tail of each running agent's own file, and the
// agent's whole transcript normalized on demand for the agent view (spec §2.5
// "Agents", §2.3, §2.4 rule 6, §2.9, §2.10, §2.12, §5.6, §6.9, §7.6, §7.12).
//
//   createAgentsSource({createTailer = require('./tail').createTailer,
//                       settleMs = REPLAY_SETTLE_MS} = {}) → {attach(engine)}
//   attach(engine) → {start, stop, onIngest, onChanges, onConversation,
//                     persistState, restoreState, diagnostics, api: {stream}}
//   foldAgentRecords(state, recs) → state     the light fold (below), pure
//
// A source per the contract at the head of lib/server/mirror/index.js. U51 adds
// `{name: 'agents', attach: createAgentsSource().attach}` to SOURCES, after
// `tasks`; the facade's DISPATCH routes agent → api.stream (async).
//
// ROWS. kind 'agent', written only through engine.model.upsertTask and
// removeTask (the model redacts the title and the line, and never makes a
// finished row running again):
//   {id, conversation_id, kind: 'agent', title, status, stopped_by?, started_at,
//    ended_at?, line, meta: {tools, model?, agent_type?, foreground}, turn_id,
//    tool_use_id, can: {output: false, open: true, stop}}
// meta.model and meta.agent_type are additive keys for the agent view (U47
// reads them from the route; chat-state.js's TASK_SCHEMA drops them from the
// store). A row is made by an Agent (or Task) tool_call in onChanges, or by the
// parent's PreToolUse for it (env.tool.name 'Agent', env.agent null): title =
// input.description, meta.agent_type = input.subagent_type, meta.foreground =
// input.run_in_background !== true until an async launch says otherwise.
//
// ITS ID is the agentId: the agent's task id, the one TaskStop takes and its
// notification names (ruling A1 (a), §6.9, Q-H). Until the agentId is known the
// row is keyed by its tool_use id (chat-tools.js taskFor finds a row by
// tool_use_id or id) and can.stop is false (TaskStop cannot take that id). It
// is re-keyed — removeTask(old), then upsertTask with every field — the moment
// the id appears: the tool_result's links.agent_id (an async launch, or a
// foreground call's final result), result.fields.agentId on the PostToolUse, or
// a subagent's own hook (env.agent.id) whose <sessionDir>/subagents/
// agent-<id>.meta.json `toolUseId` names the row's tool_use (V7). THE ALIAS
// (ruling A-confirm (5)): the old id is kept as an alias of the agentId (bounded,
// persisted, dropped when the row is removed), so api.stream(<old id>) answers
// the re-keyed row and its items, and a view opened under the first id keeps
// following it.
//
// THE LIGHT TAIL. While a row runs and its agentId is known, a tailer
// (tail.js; AGENT_POLL_MS; engine.watchFile; fence = sessionDirFile) follows
// <sessionDir>/subagents/agent-<agentId>.jsonl, stat-polling it until it
// appears. Each batch is folded by foldAgentRecords into meta.tools, line (the
// last tool's stepLabel) and meta.model, and is progress evidence
// (engine.live.noteActivity(cid, last_ts, 'agent')). At most AGENT_TAILS_MAX
// tails run across this source and the workflows source (one budget per mirror,
// `sharedFor`); a row beyond the cap keeps its row and gets a tail when one
// frees. The tail stops when the row ends. A tailer's stop() or drain() is never
// awaited inside its own callbacks (U24's hand-off).
//
// ENDS, the first wins: a task item ({kind: 'task'}, carriers.js) whose task_id
// is the agentId — counted once per task id and status, since one task may
// notify twice (V7) — gives its status, and line = the quoted first LINE_MAX
// characters of its result (result_preview, else the <result> an idle
// delivery's opener carried, else the summary); a foreground call ends on its
// own tool_result (done, or failed when is_error), line = its quoted result; a
// TaskStop call's own result naming the agent (tasks.js stoppedTaskId, the one
// predicate: ruling A-confirm (4)) → killed, stopped_by 'claude'; SubagentStop
// → done unless already ended, line from stop.last_assistant_message when no
// result has landed (an envelope whose agent type is '' is ignored); the
// registry's 'ended' → stopped, 'session-end'. A notification after a
// SubagentStop may still correct its status and line. Finished rows are removed
// FINISHED_KEEP_MS after they end.
//
// A CATCH-UP REPLAY of an old Agent call (a change older than REPLAY_AGE_MS)
// starts no tail at once: the row waits until the conversation's batches have
// been quiet for `settleMs`, by when the same replay's notification has been
// read; a row still running then is tailed (or, in an ended conversation,
// stopped).
//
// THE STREAM, api.stream(id, {before, after, limit = 30}), async. `id` is an
// agentId or a provisional row's tool_use id (or an alias). The agent file is
// the main session's subagents/agent-<id>.jsonl, else a workflow agent's
// subagents/workflows/<runId>/agent-<id>.jsonl for a runId this source saw in a
// Workflow tool_result of that session (each candidate stat'd through
// sessionDirFile; no directory is ever listed). It is read with
// engine.files.readWindow pages from the cached offset, each window cut at its
// last newline (`next`), parsed by transcripts.js parseLines, normalized by
// normalize.js with its state carried between reads, and applied to a PRIVATE
// model and turn machine (createModel({redactor: engine.redactor}),
// createTurnMachine, configure(cid, {mode: 'agent'}): rule 6, the workflow relay
// skipped), so every item is merged and redacted — each tool output with its
// {file, command} context — by the engines the conversation itself uses. The
// private model is never the shared one: an agent there would be a conversation
// in every snapshot, status row and count. At most STREAMS_MAX streams are
// cached, keyed by agentId, read on incrementally while followed and dropped
// after STREAM_IDLE_MS unread. The answer:
//   {agent: TaskRow, items: [Item at full caps], next_before}
// items in seq order; after=<seq> → only seq > after (followAgentItems, §7.6);
// before=<seq> → the page before it; limit 1..STREAM_LIMIT_MAX; next_before =
// the oldest returned seq when older items remain, else null. A workflow agent,
// which has no row, gets {id, kind: 'agent', title: its label, status,
// started_at, ended_at?, meta: {tools, model}}. Unknown id → null. Never a path.
//
// PERSISTENCE (§2.11, this source's slice): rows' ids, agent ids, tool_use ids,
// kinds, statuses, times, titles, agent types, models and tool counts; the
// aliases; the runIds seen per session. Never a line, a path or a prompt.
// restoreState re-upserts the rows and resumes the tails of running ones.
//
// LIFECYCLE. Hooks may arrive before start(): rows are kept and tailed once
// started. stop() stops every tail and timer and drops every stream, and keeps
// the rows (the transcripts source, which stops after this one, asks for the
// persisted slice at its own stop); start() re-arms them. A conversation
// 'removed' forgets its rows.
//
// Dependency direction: lib/server/mirror; imports its siblings tail, model,
// turn-machine, normalize, transcripts (parseLines), tasks (stoppedTaskId),
// carriers (parseNotifications), and lib/core paths and tool-input.

const path = require('path');
const { createTailer: defaultCreateTailer } = require('./tail');
const { createModel } = require('./model');
const { createTurnMachine, unframe, isRelay } = require('./turn-machine');
const { normalize, initialState } = require('./normalize');
const { parseLines } = require('./transcripts');
const { stoppedTaskId } = require('./tasks');
const { parseNotifications } = require('./carriers');
const { stepLabel } = require('../../core/tool-input');
const { isSafeId } = require('../../core/paths');

// ── constants ────────────────────────────────────────────────────────────────

const AGENT_POLL_MS = 1000;
const JOURNAL_POLL_MS = 2000;
const AGENT_TAILS_MAX = 16;
const STREAMS_MAX = 4;
const STREAM_IDLE_MS = 60000;
const STREAM_LIMIT_MAX = 100;
const STREAM_LIMIT_DEFAULT = 30;
const FINISHED_KEEP_MS = 30 * 60 * 1000;
const LINE_MAX = 100;
// A change this much older than the clock is a catch-up's replay, and a
// replayed row is tailed only once the replay has gone quiet for settleMs.
const REPLAY_AGE_MS = 60000;
const REPLAY_SETTLE_MS = 1000;
const STATE_VERSION = 1;

const TITLE_MAX = 300;
const PERSIST_ROWS_MAX = 64;
const CALLS_MAX = 512;
const ALIASES_MAX = 256;
const RESULTS_MAX = 128;
const META_TRIES = 3;
const META_MAX_BYTES = 64 * 1024;
const RUNS_MAX = 64;
const SESSIONS_MAX = 64;
// readWindow pages: a window grows to the largest readWindow serves for a line
// longer than one page; a line longer than that ends what a read can take.
const PAGE_BYTES = 1024 * 1024;
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
// The most one stream read takes before answering (the rest on the next read).
const READ_BUDGET_BYTES = 64 * 1024 * 1024;

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const TERMINAL = new Set(['done', 'failed', 'killed', 'stopped', 'expired']);
const NOTIFY_STATUS = new Set(['done', 'failed', 'killed', 'stopped']);
// "Async agent launched successfully. … agentId: <id> …" (V7).
const ASYNC_RE = /^\s*Async agent launched/;
// Which line wins when two signals bring one: a result over the agent's last
// message over a notification's summary over the last tool.
const LINE_RANK = Object.freeze({ tool: 0, summary: 1, stop: 2, result: 3 });

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const safeId = (v) => (typeof v === 'string' && isSafeId(v) ? v : null);

// The first LINE_MAX characters of a text, on one line, in quotes.
function quoteLine(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const chars = Array.from(flat);
  return `“${chars.slice(0, LINE_MAX).join('')}${chars.length > LINE_MAX ? '…' : ''}”`;
}

function cut(s, max) {
  if (typeof s !== 'string') return null;
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

// ── the light fold ───────────────────────────────────────────────────────────

function initialFold() {
  return { tools: 0, last_tool: null, model: null, first_ts: null, last_ts: null, prompt_preview: null };
}

// An agent file's records (the tailer's {obj, …}, or the records themselves)
// folded into {tools, last_tool, model, first_ts, last_ts, prompt_preview}:
// the tool_use blocks counted and the newest one labelled by tool-input's
// stepLabel, the latest assistant model, the first and last record times, and
// the prompt's first 80 characters (the workflow relay skipped and the harness
// frame unwrapped, as rebuild_wf.py reads it). Pure: a new state is returned.
function foldAgentRecords(state, recs) {
  const s = isPlain(state) ? { ...initialFold(), ...state } : initialFold();
  for (const r of Array.isArray(recs) ? recs : []) {
    const obj = isPlain(r) && isPlain(r.obj) ? r.obj : (isPlain(r) && typeof r.type === 'string' ? r : null);
    if (!obj) continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (s.first_ts === null || ts < s.first_ts) s.first_ts = ts;
      if (s.last_ts === null || ts > s.last_ts) s.last_ts = ts;
    }
    const m = isPlain(obj.message) ? obj.message : null;
    if (!m) continue;
    if (obj.type === 'user' && s.prompt_preview === null && typeof m.content === 'string' && !isRelay(m.content)) {
      s.prompt_preview = cut(unframe(m.content), 80);
    } else if (obj.type === 'assistant') {
      if (str(m.model) && m.model !== '<synthetic>') s.model = cut(m.model, 100);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!isPlain(b) || b.type !== 'tool_use') continue;
        s.tools += 1;
        s.last_tool = stepLabel(b.name, b.input);
      }
    }
  }
  return s;
}

// ── what the two sources share, per mirror ───────────────────────────────────
//
// The tail budget (AGENT_TAILS_MAX across both sources) and the workflows
// source's lookup of a workflow agent (its label, state and run), keyed by the
// engine's model, which the facade hands every source of one mirror.

const SHARED = new WeakMap();

function createShared() {
  let used = 0;
  const waiters = new Set();
  let lookup = null;
  return {
    acquire() {
      if (used >= AGENT_TAILS_MAX) return false;
      used += 1;
      return true;
    },
    release() {
      if (used > 0) used -= 1;
      for (const fn of [...waiters]) {
        if (used >= AGENT_TAILS_MAX) break;
        try { fn(); } catch { /* a waiter never breaks another */ }
      }
    },
    onFree(fn) {
      waiters.add(fn);
      return () => waiters.delete(fn);
    },
    get used() { return used; },
    setWorkflowAgents(fn) { lookup = typeof fn === 'function' ? fn : null; },
    workflowAgent(id) {
      if (!lookup) return null;
      try { return lookup(id) || null; } catch { return null; }
    },
  };
}

function sharedFor(engine) {
  const key = engine && engine.model;
  if (!key || (typeof key !== 'object' && typeof key !== 'function')) return createShared();
  let s = SHARED.get(key);
  if (!s) {
    s = createShared();
    SHARED.set(key, s);
  }
  return s;
}

// ── small reads, through the fences ──────────────────────────────────────────

function sessionDirOf(engine, sid) {
  try { return sid ? engine.conversations.sessionDir(sid) || null : null; } catch { return null; }
}

// A small JSON file in a session's side directory (a meta file, a summary), or
// null: fenced by sessionDirFile, one bounded readWindow, the whole file or
// nothing.
function readSmallJson(engine, sessionDir, p, maxBytes = META_MAX_BYTES) {
  if (!sessionDir || !p) return null;
  let f = null;
  try { f = engine.files.sessionDirFile(sessionDir, p); } catch { f = null; }
  if (!f) return null;
  const w = engine.files.readWindow(f, { maxBytes });
  if (!w || !w.complete) return null;
  try {
    const v = JSON.parse(w.text);
    return isPlain(v) ? v : null;
  } catch { return null; }
}

// The whole lines of a fenced file from byte `from`, in readWindow pages:
// {recs, next, stuck}. `next` is the byte after the last whole line read; a
// partial last line waits for its newline. A line longer than PAGE_MAX_BYTES
// stops the read there (`stuck`).
function readLines(engine, file, from, budget = READ_BUDGET_BYTES) {
  const recs = [];
  let pos = from;
  let max = PAGE_BYTES;
  let taken = 0;
  for (;;) {
    const w = engine.files.readWindow(file, { from: pos, maxBytes: max });
    if (!w) break;
    const whole = w.next - w.from;
    if (whole <= 0) {
      if (w.complete) break;
      if (max < PAGE_MAX_BYTES) { max = Math.min(max * 2, PAGE_MAX_BYTES); continue; }
      return { recs, next: pos, stuck: true };
    }
    const text = w.text.slice(0, w.text.lastIndexOf('\n') + 1);
    for (const r of parseLines(text, pos)) recs.push(r);
    pos = w.next;
    taken += whole;
    max = PAGE_BYTES;
    if (w.complete || taken >= budget) break;
  }
  return { recs, next: pos, stuck: false };
}

// ── the source ───────────────────────────────────────────────────────────────

function createAgentsSource({ createTailer = defaultCreateTailer, settleMs = REPLAY_SETTLE_MS } = {}) {
  const settle = Number.isSafeInteger(settleMs) && settleMs >= 0 ? settleMs : REPLAY_SETTLE_MS;

  function attach(engine) {
    const shared = sharedFor(engine);
    const recs = new Map(); // row id → rec
    const byToolUse = new Map(); // tool_use id → rec
    const aliases = new Map(); // a re-keyed row's first id → its agentId
    const calls = new Map(); // tool_use id → {tool, task_id}: what a result follows
    const results = new Map(); // task id → the <result> an idle delivery carried
    const metaTries = new Map(); // agentId → meta-file reads tried
    const runs = new Map(); // session id → Set(runId) from Workflow results
    const settles = new Map(); // conversation id → the replay's settle timer
    const streams = new Map(); // agentId → a private stream
    const waiting = new Set(); // rec ids waiting for a tail slot
    let started = false;
    let tails = 0;
    let offFree = null;

    const now = () => { try { return engine.now(); } catch { return Date.now(); } };
    function fail(stage, e) {
      const word = [e && e.code, e && e.name].find((w) => typeof w === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(w)) || 'Error';
      try { engine.log(`mirror agents: ${stage} failed (${word})`); } catch { /* never breaks */ }
    }
    function later(fn) {
      Promise.resolve().then(fn).catch((e) => fail('scheduled', e));
    }
    function remember(map, key, value, max) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    }

    // ── a record and its row ──
    function newRec({ id, agentId = null, toolUseId = null, cid, sid, at }) {
      const rec = {
        id, agentId, toolUseId, cid, sid: sid || null, title: null, agentType: null, foreground: true,
        status: 'running', stoppedBy: null, startedAt: finite(at) ? at : now(), endedAt: null,
        line: '', lineRank: -1, endedBy: null, fold: null, model: null, tools: 0, turnId: null,
        tail: null, deferred: false, keep: null, gone: false, ends: new Set(),
      };
      recs.set(id, rec);
      if (toolUseId) byToolUse.set(toolUseId, rec);
      return rec;
    }

    function rowOf(rec) {
      const running = rec.status === 'running';
      const meta = { tools: rec.tools, foreground: rec.foreground };
      if (rec.model) meta.model = rec.model;
      if (rec.agentType) meta.agent_type = rec.agentType;
      const row = {
        id: rec.id,
        conversation_id: rec.cid,
        kind: 'agent',
        title: rec.title || rec.agentType || 'Agent',
        status: rec.status,
        started_at: rec.startedAt,
        line: rec.line || '',
        meta,
        turn_id: rec.turnId,
        tool_use_id: rec.toolUseId,
        can: { output: false, open: true, stop: running && Boolean(rec.agentId) },
      };
      if (rec.stoppedBy) row.stopped_by = rec.stoppedBy;
      if (finite(rec.endedAt)) row.ended_at = rec.endedAt;
      return row;
    }

    function publish(rec) {
      if (rec.gone || recs.get(rec.id) !== rec) return;
      try { engine.model.upsertTask(rowOf(rec)); } catch (e) { fail('upsert', e); }
    }

    function dropAliasesOf(id) {
      for (const [k, v] of [...aliases]) if (v === id || k === id) aliases.delete(k);
    }

    function forget(rec) {
      rec.gone = true;
      endTail(rec);
      clearKeep(rec);
      waiting.delete(rec.id);
      if (recs.get(rec.id) === rec) recs.delete(rec.id);
      if (rec.toolUseId && byToolUse.get(rec.toolUseId) === rec) byToolUse.delete(rec.toolUseId);
      dropAliasesOf(rec.id);
    }

    function removeRow(rec) {
      const id = rec.id;
      forget(rec);
      try { engine.model.removeTask(id); } catch (e) { fail('remove', e); }
    }

    function clearKeep(rec) {
      if (rec.keep === null) return;
      try { engine.timers.clearTimeout(rec.keep); } catch { /* gone */ }
      rec.keep = null;
    }

    function armKeep(rec) {
      clearKeep(rec);
      if (!started || rec.status === 'running' || !finite(rec.endedAt)) return;
      const delay = rec.endedAt + FINISHED_KEEP_MS - now();
      if (delay <= 0) { removeRow(rec); return; }
      rec.keep = engine.timers.setTimeout(() => { rec.keep = null; if (!rec.gone) removeRow(rec); }, delay);
    }

    function conversationEnded(cid) {
      try {
        const v = engine.conversations.get(cid);
        return Boolean(v && finite(v.ended_at));
      } catch { return false; }
    }

    function itemTurnOf(toolUseId) {
      try {
        const it = toolUseId ? engine.model.item(toolUseId) : null;
        return it && typeof it.turn_id === 'string' ? it.turn_id : null;
      } catch { return null; }
    }
    function openTurnOf(cid) {
      try {
        const open = engine.model.openTurnOf(cid);
        return typeof open === 'string' ? open : null;
      } catch { return null; }
    }

    function recOf(id) {
      if (typeof id !== 'string' || !id) return null;
      const target = aliases.get(id) || id;
      return recs.get(target) || byToolUse.get(target) || null;
    }

    function noteSession(sid) {
      if (!sid || runs.has(sid)) return;
      remember(runs, sid, new Set(), SESSIONS_MAX);
    }

    // ── re-keying (ruling A1 (a), A-confirm (5)) ──
    function rekey(rec, agentId) {
      const id = safeId(agentId);
      if (!id || rec.gone || rec.agentId === id) return rec;
      if (rec.agentId) return rec; // one agent, one id
      const old = rec.id;
      const other = recs.get(id);
      if (other && other !== rec) {
        // A row already keyed by the agentId absorbs the provisional one.
        if (!other.toolUseId && rec.toolUseId) { other.toolUseId = rec.toolUseId; byToolUse.set(rec.toolUseId, other); }
        if (!other.title && rec.title) other.title = rec.title;
        if (!other.agentType && rec.agentType) other.agentType = rec.agentType;
        if (!other.turnId && rec.turnId) other.turnId = rec.turnId;
        if (rec.startedAt < other.startedAt) other.startedAt = rec.startedAt;
        forget(rec);
        try { engine.model.removeTask(old); } catch (e) { fail('remove', e); }
        remember(aliases, old, id, ALIASES_MAX);
        publish(other);
        return other;
      }
      recs.delete(old);
      rec.id = id;
      rec.agentId = id;
      recs.set(id, rec);
      if (waiting.delete(old)) waiting.add(id);
      for (const [k, v] of aliases) if (v === old) aliases.set(k, id);
      remember(aliases, old, id, ALIASES_MAX);
      try { engine.model.removeTask(old); } catch (e) { fail('remove', e); }
      publish(rec);
      beginTail(rec);
      return rec;
    }

    // ── a call, from either stream ──
    function noteCall({ cid, sid, toolUseId, agentId, input, at, replay }) {
      const useId = str(toolUseId);
      let rec = (agentId && recs.get(agentId)) || (useId && byToolUse.get(useId)) || null;
      if (!rec) {
        const aid = safeId(agentId);
        if (!useId && !aid) return null;
        rec = newRec({ id: aid || useId, agentId: aid, toolUseId: useId, cid, sid, at });
        if (replay) rec.deferred = true;
      } else if (useId && !rec.toolUseId) {
        rec.toolUseId = useId;
        byToolUse.set(useId, rec);
      }
      if (!rec.sid && sid) rec.sid = sid;
      noteSession(rec.sid);
      if (isPlain(input)) {
        const d = str(input.description);
        if (d && !rec.title) rec.title = cut(d, TITLE_MAX);
        const type = str(input.subagent_type);
        if (type && !rec.agentType) rec.agentType = cut(type, 100);
        if (input.run_in_background === true) rec.foreground = false;
      }
      if (finite(at) && at < rec.startedAt) rec.startedAt = at;
      const own = itemTurnOf(rec.toolUseId);
      if (own) rec.turnId = own;
      else if (!rec.turnId) rec.turnId = openTurnOf(rec.cid);
      if (agentId && !rec.agentId) rec = rekey(rec, agentId);
      publish(rec);
      beginTail(rec);
      return rec;
    }

    // ── the light tail ──
    function wantTail(rec) {
      return started && !rec.gone && rec.status === 'running' && Boolean(rec.agentId) && !rec.deferred && !rec.tail;
    }

    function beginTail(rec) {
      if (!wantTail(rec)) return;
      const dir = sessionDirOf(engine, rec.sid);
      if (!dir) return;
      if (!shared.acquire()) { waiting.add(rec.id); return; }
      waiting.delete(rec.id);
      const file = path.join(dir, 'subagents', `agent-${rec.agentId}.jsonl`);
      let t = null;
      try {
        t = createTailer({
          file,
          pollMs: AGENT_POLL_MS,
          watchFile: engine.watchFile,
          fence: (p) => engine.files.sessionDirFile(dir, p),
          onRecords: (rs) => { if (rec.tail === t) onAgentRecords(rec, rs); },
          onReset: () => { if (rec.tail === t) { rec.fold = null; rec.tools = 0; } },
          onError: (e) => { if (!(e && e.code === 'WC_TAIL_REFUSED')) fail('tail', e); },
          log: () => {},
        });
      } catch (e) {
        fail('tailer', e);
        shared.release();
        return;
      }
      rec.tail = t;
      tails += 1;
      Promise.resolve().then(() => t.start()).catch((e) => fail('tail start', e));
    }

    // Never awaited: the tail may be inside the very call that ended its row.
    function endTail(rec) {
      const t = rec.tail;
      if (!t) return;
      rec.tail = null;
      tails -= 1;
      Promise.resolve().then(() => t.stop()).catch(() => {});
      shared.release();
    }

    function onAgentRecords(rec, rs) {
      if (rec.gone) return;
      rec.fold = foldAgentRecords(rec.fold, rs);
      rec.tools = rec.fold.tools;
      if (rec.fold.model) rec.model = rec.fold.model;
      if (rec.status === 'running' && rec.fold.last_tool && rec.lineRank <= LINE_RANK.tool) {
        rec.line = rec.fold.last_tool;
        rec.lineRank = LINE_RANK.tool;
      }
      publish(rec);
      try { engine.live.noteActivity(rec.cid, finite(rec.fold.last_ts) ? rec.fold.last_ts : now(), 'agent'); } catch (e) { fail('activity', e); }
    }

    function pumpWaiting() {
      for (const id of [...waiting]) {
        const rec = recs.get(id);
        if (!rec || !wantTail(rec)) { waiting.delete(id); continue; }
        if (shared.used >= AGENT_TAILS_MAX) break;
        beginTail(rec);
      }
    }

    // ── ends ──
    function setLine(rec, text, rank) {
      if (!text || rank < rec.lineRank) return;
      rec.line = text;
      rec.lineRank = rank;
    }

    function end(rec, status, { at, stoppedBy, line, rank, by } = {}) {
      if (!TERMINAL.has(status) || rec.gone) return false;
      if (rec.status !== 'running') {
        // A notification may correct what a SubagentStop presumed.
        if (by === 'notification' && rec.endedBy === 'subagent-stop') {
          rec.status = status;
          rec.endedBy = by;
          if (line) setLine(rec, line, rank);
          publish(rec);
        } else if (line && rank > rec.lineRank) {
          setLine(rec, line, rank);
          publish(rec);
        }
        return false;
      }
      rec.status = status;
      rec.endedAt = finite(at) ? Math.max(at, rec.startedAt) : now();
      rec.endedBy = by || null;
      if (stoppedBy) rec.stoppedBy = stoppedBy;
      if (line) setLine(rec, line, rank);
      rec.deferred = false;
      endTail(rec);
      waiting.delete(rec.id);
      publish(rec);
      armKeep(rec);
      return true;
    }

    // ── the transcript's batch ──
    function onChanges(sessionId, changes, { conversation_id: cid } = {}) {
      if (!Array.isArray(changes) || typeof cid !== 'string') return;
      let replayed = false;
      for (const ch of changes) {
        if (!isPlain(ch)) continue;
        try {
          if (ch.type === 'item' && isPlain(ch.item)) {
            if (itemChange(sessionId, cid, ch)) replayed = true;
          } else if (ch.type === 'opener' && ch.kind === 'task-notification') openerChange(ch);
        } catch (e) { fail('change', e); }
      }
      if (replayed || hasDeferred(cid)) armSettle(cid);
    }

    function isReplay(ch) {
      return finite(ch.ts) && ch.ts < now() - REPLAY_AGE_MS;
    }

    // Answers whether it made a replayed row.
    function itemChange(sid, cid, ch) {
      const it = ch.item;
      if (it.kind === 'task') { taskItem(ch, it); return false; }
      if (it.kind !== 'tool_call' || typeof it.id !== 'string') return false;
      let merged = null;
      try { merged = engine.model.item(it.id); } catch { merged = null; }
      const known = calls.get(it.id);
      const tool = str(it.tool) || (merged && str(merged.tool)) || (known && known.tool) || null;
      const input = isPlain(it.input) ? it.input : (merged && isPlain(merged.input) ? merged.input : null);
      if (tool) {
        const inp = input || {};
        remember(calls, it.id, { tool, task_id: str(inp.task_id) || str(inp.shell_id) }, CALLS_MAX);
      }
      if (!tool) return false;
      const result = isPlain(it.result) ? it.result : null;
      const links = isPlain(it.links) ? it.links : (merged && isPlain(merged.links) ? merged.links : {});
      if (tool === 'TaskStop') {
        if (!result) return false;
        const stopped = stoppedTaskId(calls.get(it.id) || { tool }, result);
        const rec = stopped ? recOf(stopped) : null;
        if (rec && rec.agentId === stopped) end(rec, 'killed', { at: finite(ch.ts) ? ch.ts : now(), stoppedBy: 'claude', by: 'taskstop' });
        return false;
      }
      if (tool === 'Workflow') {
        const run = safeId(links.run_id);
        if (run && sid) {
          noteSession(sid);
          const set = runs.get(sid);
          if (set && !set.has(run)) {
            set.add(run);
            while (set.size > RUNS_MAX) set.delete(set.values().next().value);
          }
        }
        return false;
      }
      if (!AGENT_TOOLS.has(tool)) return false;
      const replay = isReplay(ch);
      const at = merged && finite(merged.started_at) ? merged.started_at : (finite(ch.ts) ? ch.ts : null);
      const rec = noteCall({ cid, sid, toolUseId: it.id, agentId: safeId(links.agent_id), input, at, replay });
      if (!rec || !result) return Boolean(rec && rec.deferred);
      const preview = typeof result.preview === 'string' ? result.preview : '';
      if (result.is_error === true) {
        end(rec, 'failed', { at: finite(ch.ts) ? ch.ts : now(), line: quoteLine(preview), rank: LINE_RANK.result, by: 'result' });
      } else if (ASYNC_RE.test(preview)) {
        if (rec.foreground) { rec.foreground = false; publish(rec); }
      } else if (rec.agentId || it.status === 'done') {
        end(rec, 'done', { at: finite(ch.ts) ? ch.ts : now(), line: quoteLine(preview), rank: LINE_RANK.result, by: 'result' });
      }
      return rec.deferred;
    }

    // A notification's task item, counted once per task id and status.
    function taskItem(ch, it) {
      const id = str(it.task_id);
      const rec = id ? recOf(id) : null;
      if (!rec || rec.agentId !== id) return;
      const status = typeof it.status === 'string' ? it.status : 'unknown';
      if (!NOTIFY_STATUS.has(status)) return;
      const key = `${id}:${status}`;
      if (rec.ends.has(key)) return;
      rec.ends.add(key);
      const res = str(it.result_preview) || results.get(id) || null;
      const line = res ? quoteLine(res) : quoteLine(str(it.summary) || '');
      end(rec, status, {
        at: finite(ch.ts) ? ch.ts : now(), line, rank: res ? LINE_RANK.result : LINE_RANK.summary, by: 'notification',
      });
    }

    // An idle delivery's opener carries the notification's <result>.
    function openerChange(ch) {
      for (const n of parseNotifications(ch.text)) {
        const id = n.tags['task-id'];
        const res = n.tags.result;
        if (!safeId(id) || typeof res !== 'string' || !res) continue;
        remember(results, id, res, RESULTS_MAX);
        const rec = recOf(id);
        if (rec && rec.status !== 'running' && rec.lineRank < LINE_RANK.result) {
          setLine(rec, quoteLine(res), LINE_RANK.result);
          publish(rec);
        }
      }
    }

    // ── the replay's settle ──
    function hasDeferred(cid) {
      for (const rec of recs.values()) if (rec.cid === cid && rec.deferred) return true;
      return false;
    }
    function armSettle(cid) {
      if (!started) return;
      const prev = settles.get(cid);
      if (prev !== undefined) { try { engine.timers.clearTimeout(prev); } catch { /* gone */ } }
      settles.set(cid, engine.timers.setTimeout(() => { settles.delete(cid); settled(cid); }, settle));
    }
    function settled(cid) {
      for (const rec of [...recs.values()]) {
        if (rec.cid !== cid || !rec.deferred) continue;
        rec.deferred = false;
        if (rec.status !== 'running') continue;
        if (conversationEnded(cid)) endedIn(rec);
        else beginTail(rec);
      }
    }
    function endedIn(rec) {
      let at = null;
      try { const v = engine.conversations.get(rec.cid); at = v && finite(v.ended_at) ? v.ended_at : null; } catch { at = null; }
      end(rec, 'stopped', { at: at === null ? now() : at, stoppedBy: 'session-end', by: 'session-end' });
    }

    // ── hooks ──
    function onIngest(env, { conversation_id: cid, session_id: sid } = {}) {
      if (!isPlain(env) || typeof cid !== 'string') return;
      try {
        const agent = isPlain(env.agent) ? env.agent : null;
        const tool = isPlain(env.tool) ? env.tool : null;
        const at = finite(env.ts) ? env.ts : now();
        if (!agent && tool && AGENT_TOOLS.has(tool.name)) parentHook(env, tool, cid, sid, at);
        else if (agent && safeId(agent.id)) agentHook(env, agent, cid, sid, at);
      } catch (e) { fail('ingest', e); }
    }

    function parentHook(env, tool, cid, sid, at) {
      const input = isPlain(tool.input) ? tool.input : null;
      const useId = str(tool.use_id);
      if (env.event === 'PreToolUse') {
        noteCall({ cid, sid, toolUseId: useId, input, at });
        return;
      }
      if (env.event !== 'PostToolUse' && env.event !== 'PostToolUseFailure') return;
      const fields = isPlain(env.result) && isPlain(env.result.fields) ? env.result.fields : {};
      const rec = noteCall({ cid, sid, toolUseId: useId, agentId: safeId(fields.agentId), input, at });
      if (!rec) return;
      if (env.event === 'PostToolUseFailure') { end(rec, 'failed', { at, by: 'result' }); return; }
      if (fields.status === 'async_launched' || fields.isAsync === true) {
        if (rec.foreground) { rec.foreground = false; publish(rec); }
      } else if (fields.status === 'completed' && rec.agentId) {
        end(rec, 'done', { at, by: 'result' });
      }
    }

    function agentHook(env, agent, cid, sid, at) {
      if (env.event === 'SubagentStop' && !str(agent.type)) return; // an internal agent (§2.5)
      const id = agent.id;
      let rec = recOf(id);
      if (rec && rec.agentId !== id) rec = null;
      if (!rec) {
        later(() => {
          const linked = linkByMeta(id, cid, sid, agent);
          if (linked) afterAgentHook(env, linked, at);
        });
        return;
      }
      afterAgentHook(env, rec, at);
    }

    function afterAgentHook(env, rec, at) {
      if (rec.gone) return;
      if (env.event === 'SubagentStop') {
        const stop = isPlain(env.stop) ? env.stop : {};
        const last = str(stop.last_assistant_message);
        end(rec, 'done', { at, line: last ? quoteLine(last) : null, rank: LINE_RANK.stop, by: 'subagent-stop' });
        return;
      }
      if (rec.status === 'running') {
        try { engine.live.noteActivity(rec.cid, at, 'agent'); } catch (e) { fail('activity', e); }
      }
    }

    // A subagent's own hook for an agentId no row has: its meta file names the
    // tool_use of a provisional row (V7: 90 of 90).
    function linkByMeta(agentId, cid, sid, agent) {
      const known = recs.get(agentId);
      if (known) return known;
      let provisional = false;
      for (const rec of recs.values()) if (rec.cid === cid && !rec.agentId && !rec.gone) { provisional = true; break; }
      if (!provisional) return null;
      const tries = metaTries.get(agentId) || 0;
      if (tries >= META_TRIES) return null;
      remember(metaTries, agentId, tries + 1, ALIASES_MAX);
      const dir = sessionDirOf(engine, sid);
      const meta = readSmallJson(engine, dir, dir ? path.join(dir, 'subagents', `agent-${agentId}.meta.json`) : null);
      if (!meta) return null;
      const rec = byToolUse.get(str(meta.toolUseId) || '');
      if (!rec || rec.agentId || rec.gone) return null;
      if (!rec.agentType) rec.agentType = cut(str(meta.agentType) || str(agent.type) || '', 100) || null;
      if (!rec.title && str(meta.description)) rec.title = cut(meta.description, TITLE_MAX);
      return rekey(rec, agentId);
    }

    function onConversation(ev) {
      if (!isPlain(ev) || !isPlain(ev.conversation) || typeof ev.conversation.id !== 'string') return;
      const cid = ev.conversation.id;
      try {
        if (ev.change === 'ended') {
          const at = finite(ev.at) ? ev.at : (finite(ev.conversation.ended_at) ? ev.conversation.ended_at : now());
          for (const rec of [...recs.values()]) {
            if (rec.cid === cid && rec.status === 'running') end(rec, 'stopped', { at, stoppedBy: 'session-end', by: 'session-end' });
          }
        } else if (ev.change === 'merged' && typeof ev.merged_into === 'string') {
          for (const rec of [...recs.values()]) {
            if (rec.cid !== cid) continue;
            rec.cid = ev.merged_into;
            publish(rec);
          }
        } else if (ev.change === 'removed') {
          for (const rec of [...recs.values()]) if (rec.cid === cid) forget(rec);
        }
      } catch (e) { fail('conversation', e); }
    }

    // ── the stream ──
    function dropStream(id) {
      const s = streams.get(id);
      if (!s) return;
      streams.delete(id);
      if (s.timer !== null) { try { engine.timers.clearTimeout(s.timer); } catch { /* gone */ } }
    }

    function touchStream(s) {
      s.lastRead = now();
      if (s.timer !== null) { try { engine.timers.clearTimeout(s.timer); } catch { /* gone */ } }
      s.timer = started ? engine.timers.setTimeout(() => { s.timer = null; dropStream(s.id); }, STREAM_IDLE_MS) : null;
    }

    function openStream(agentId, sessionDir, file) {
      const have = streams.get(agentId);
      if (have && have.file === file) return have;
      if (have) dropStream(agentId);
      while (streams.size >= STREAMS_MAX) {
        let oldest = null;
        for (const s of streams.values()) if (!oldest || s.lastRead < oldest.lastRead) oldest = s;
        dropStream(oldest.id);
      }
      const model = createModel({ redactor: engine.redactor });
      const tm = createTurnMachine({ model, now: () => now() });
      tm.configure(agentId, { mode: 'agent' });
      const s = {
        id: agentId, sessionDir, file, offset: 0, norm: initialState(), model, tm, cid: agentId,
        lastRead: now(), timer: null, chain: Promise.resolve(), stuck: false,
      };
      streams.set(agentId, s);
      return s;
    }

    function readOn(s) {
      if (s.stuck) return;
      const f = engine.files.sessionDirFile(s.sessionDir, s.file);
      if (!f) return;
      const got = readLines(engine, f, s.offset);
      if (got.stuck) s.stuck = true;
      if (!got.recs.length) { s.offset = got.next; return; }
      const n = normalize(got.recs, s.norm, { session_id: s.cid });
      s.norm = n.state;
      s.offset = got.next;
      s.tm.applyChanges(s.cid, s.cid, n.changes, { mode: 'agent' });
    }

    function itemsOf(s) {
      const all = [];
      for (const t of s.model.turnsOf(s.cid)) {
        const list = s.model.itemsOf(t.id);
        if (list) for (const it of list) all.push(it);
      }
      all.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return all;
    }

    function pageOf(s, { before, after, limit }) {
      const all = itemsOf(s);
      let sel;
      if (after !== null) sel = all.filter((it) => it.seq > after).slice(0, limit);
      else {
        const pool = before !== null ? all.filter((it) => it.seq < before) : all;
        sel = pool.slice(-limit);
      }
      const oldest = sel.length ? sel[0].seq : null;
      const nextBefore = oldest !== null && all.some((it) => it.seq < oldest) ? oldest : null;
      return { items: sel.map((it) => s.model.serializeItem(it, { level: 'full' })).filter(Boolean), next_before: nextBefore };
    }

    function queryOf(q) {
      const o = isPlain(q) ? q : {};
      const num = (v) => (finite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null));
      const lim = num(o.limit);
      return {
        before: num(o.before),
        after: num(o.after),
        limit: lim === null ? STREAM_LIMIT_DEFAULT : Math.max(1, Math.min(STREAM_LIMIT_MAX, Math.floor(lim))),
      };
    }

    // The agent file of an agentId with no row: the main session's, else a
    // workflow agent's under a run seen in that session.
    function findFile(agentId, prefer) {
      const sids = [];
      if (prefer) sids.push(prefer);
      for (const sid of runs.keys()) if (!sids.includes(sid)) sids.push(sid);
      for (const rec of recs.values()) if (rec.sid && !sids.includes(rec.sid)) sids.push(rec.sid);
      for (const sid of sids) {
        const dir = sessionDirOf(engine, sid);
        if (!dir) continue;
        const main = path.join(dir, 'subagents', `agent-${agentId}.jsonl`);
        if (engine.files.sessionDirFile(dir, main)) return { dir, file: main, sid, runId: null };
        for (const runId of runs.get(sid) || []) {
          const wf = path.join(dir, 'subagents', 'workflows', runId, `agent-${agentId}.jsonl`);
          if (engine.files.sessionDirFile(dir, wf)) return { dir, file: wf, sid, runId };
        }
      }
      return null;
    }

    function rowlessAgent(agentId, found, s) {
      const wf = shared.workflowAgent(agentId);
      if (wf) {
        const out = { id: agentId, kind: 'agent', title: wf.title || 'Agent', status: wf.status || 'running', started_at: wf.started_at };
        if (finite(wf.ended_at)) out.ended_at = wf.ended_at;
        out.meta = { tools: finite(wf.tools) ? wf.tools : 0 };
        if (wf.model) out.meta.model = wf.model;
        return out;
      }
      const dir = found.dir;
      const metaFile = path.join(path.dirname(found.file), `agent-${agentId}.meta.json`);
      const meta = readSmallJson(engine, dir, metaFile) || {};
      const turns = s.model.turnsOf(s.cid);
      const t = turns.length ? turns[turns.length - 1] : null;
      const first = turns.length ? turns[0] : null;
      const status = t && t.status === 'open' ? 'running' : 'done';
      const out = {
        id: agentId, kind: 'agent', title: cut(str(meta.description) || str(meta.agentType) || 'Agent', TITLE_MAX),
        status, started_at: first && finite(first.started_at) ? first.started_at : null,
      };
      if (status !== 'running' && t && finite(t.ended_at)) out.ended_at = t.ended_at;
      let tools = 0;
      let model = null;
      for (const it of itemsOf(s)) {
        if (it.kind === 'tool_call') tools += 1;
        else if (it.kind === 'reply' && str(it.model)) model = it.model;
      }
      out.meta = { tools };
      if (model) out.meta.model = model;
      return out;
    }

    async function stream(id, q) {
      if (typeof id !== 'string' || !id) return null;
      const query = queryOf(q);
      const rec = recOf(id);
      let agentId = rec ? rec.agentId : safeId(aliases.get(id) || id);
      if (!agentId) {
        // A provisional row: no agent file is known yet.
        if (!rec) return null;
        const row = engine.model.serializeTask(rec.id);
        return row ? { agent: row, items: [], next_before: null } : null;
      }
      let found = null;
      if (rec) {
        const dir = sessionDirOf(engine, rec.sid);
        const file = dir ? path.join(dir, 'subagents', `agent-${agentId}.jsonl`) : null;
        found = dir ? { dir, file, sid: rec.sid, runId: null } : null;
      } else {
        const wf = shared.workflowAgent(agentId);
        if (wf && wf.sid && wf.runId) {
          const dir = sessionDirOf(engine, wf.sid);
          if (dir) found = { dir, file: path.join(dir, 'subagents', 'workflows', wf.runId, `agent-${agentId}.jsonl`), sid: wf.sid, runId: wf.runId };
          if (found && !engine.files.sessionDirFile(found.dir, found.file)) found = null;
        }
        if (!found) found = findFile(agentId, wf && wf.sid);
        if (!found) return null;
      }
      let s = null;
      if (found && engine.files.sessionDirFile(found.dir, found.file)) {
        s = openStream(agentId, found.dir, found.file);
        const p = s.chain.then(() => readOn(s));
        s.chain = p.catch((e) => fail('stream read', e));
        await s.chain;
        touchStream(s);
      }
      if (rec) {
        const row = engine.model.serializeTask(rec.id);
        if (!row) return null;
        if (!s) return { agent: row, items: [], next_before: null };
        const pg = pageOf(s, query);
        return { agent: row, items: pg.items, next_before: pg.next_before };
      }
      if (!s) return null;
      const pg = pageOf(s, query);
      return { agent: rowlessAgent(agentId, found, s), items: pg.items, next_before: pg.next_before };
    }

    // ── persistence (§2.11, this source's slice) ──
    function persistState(sessionId) {
      const rows = [];
      for (const rec of recs.values()) {
        if (rec.sid !== sessionId || rec.gone) continue;
        const r = {
          id: rec.id, kind: 'agent', cid: rec.cid, title: rec.title, status: rec.status, started_at: rec.startedAt,
          tool_use_id: rec.toolUseId, turn_id: rec.turnId, foreground: rec.foreground, tools: rec.tools,
        };
        if (rec.agentId) r.agent_id = rec.agentId;
        if (rec.agentType) r.agent_type = rec.agentType;
        if (rec.model) r.model = rec.model;
        if (finite(rec.endedAt)) r.ended_at = rec.endedAt;
        if (rec.stoppedBy) r.stopped_by = rec.stoppedBy;
        if (rec.ends.size) r.ends = [...rec.ends].slice(-8);
        rows.push(r);
      }
      rows.sort((a, b) => ((a.status === 'running') === (b.status === 'running')
        ? (b.ended_at || b.started_at || 0) - (a.ended_at || a.started_at || 0)
        : (a.status === 'running' ? -1 : 1)));
      const kept = rows.slice(0, PERSIST_ROWS_MAX);
      const ids = new Set(kept.map((r) => r.id));
      const al = [];
      for (const [k, v] of aliases) if (ids.has(v)) al.push([k, v]);
      return { v: STATE_VERSION, rows: kept, aliases: al, runs: [...(runs.get(sessionId) || [])] };
    }

    function restoreState(sessionId, value) {
      if (!isPlain(value) || value.v !== STATE_VERSION) return;
      if (Array.isArray(value.runs)) {
        noteSession(sessionId);
        const set = runs.get(sessionId);
        for (const r of value.runs) if (safeId(r) && set && set.size < RUNS_MAX) set.add(r);
      }
      for (const r of Array.isArray(value.rows) ? value.rows : []) {
        try { restoreRow(sessionId, r); } catch (e) { fail('restore', e); }
      }
      for (const pair of Array.isArray(value.aliases) ? value.aliases : []) {
        if (!Array.isArray(pair) || !str(pair[0]) || !safeId(pair[1])) continue;
        if (recs.has(pair[1])) remember(aliases, pair[0], pair[1], ALIASES_MAX);
      }
    }

    function restoreRow(sessionId, r) {
      if (!isPlain(r)) return;
      const id = str(r.id);
      const cid = str(r.cid);
      if (!id || !cid || recs.has(id)) return;
      const status = TERMINAL.has(r.status) || r.status === 'running' ? r.status : 'running';
      const rec = newRec({ id, agentId: safeId(r.agent_id), toolUseId: str(r.tool_use_id), cid, sid: sessionId, at: finite(r.started_at) ? r.started_at : null });
      rec.title = str(r.title) ? cut(r.title, TITLE_MAX) : null;
      rec.status = status;
      rec.endedAt = finite(r.ended_at) ? r.ended_at : null;
      rec.stoppedBy = r.stopped_by === 'claude' || r.stopped_by === 'session-end' ? r.stopped_by : null;
      rec.turnId = str(r.turn_id);
      rec.foreground = r.foreground !== false;
      rec.tools = Number.isSafeInteger(r.tools) && r.tools >= 0 ? r.tools : 0;
      rec.agentType = str(r.agent_type);
      rec.model = str(r.model);
      if (Array.isArray(r.ends)) for (const k of r.ends) if (typeof k === 'string') rec.ends.add(k);
      if (status !== 'running') rec.endedBy = 'restored';
      noteSession(sessionId);
      publish(rec);
      if (!started) return;
      if (status === 'running') {
        if (conversationEnded(cid)) endedIn(rec);
        else beginTail(rec);
      } else armKeep(rec);
    }

    // ── lifecycle ──
    async function start() {
      if (started) return;
      started = true;
      offFree = shared.onFree(pumpWaiting);
      for (const rec of [...recs.values()]) {
        if (rec.gone) continue;
        if (rec.status === 'running') {
          if (rec.deferred) armSettle(rec.cid);
          else beginTail(rec);
        } else armKeep(rec);
      }
    }

    async function stop() {
      if (!started) return;
      started = false;
      if (offFree) { offFree(); offFree = null; }
      waiting.clear();
      const stops = [];
      for (const rec of recs.values()) {
        if (rec.tail) {
          stops.push(rec.tail);
          rec.tail = null;
          tails -= 1;
          shared.release();
        }
        clearKeep(rec);
      }
      for (const h of settles.values()) { try { engine.timers.clearTimeout(h); } catch { /* gone */ } }
      settles.clear();
      for (const id of [...streams.keys()]) dropStream(id);
      await Promise.all(stops.map((t) => Promise.resolve().then(() => t.stop()).catch(() => {})));
    }

    function diagnostics() {
      let running = 0;
      for (const rec of recs.values()) if (rec.status === 'running') running += 1;
      return { agents: { running, tails, streams: streams.size } };
    }

    return {
      start,
      stop,
      onIngest,
      onChanges,
      onConversation,
      persistState,
      restoreState,
      diagnostics,
      api: { stream },
    };
  }

  return { attach };
}

module.exports = {
  createAgentsSource,
  foldAgentRecords,
  quoteLine,
  sharedFor,
  readSmallJson,
  readLines,
  AGENT_POLL_MS,
  JOURNAL_POLL_MS,
  AGENT_TAILS_MAX,
  STREAMS_MAX,
  STREAM_IDLE_MS,
  STREAM_LIMIT_MAX,
  STREAM_LIMIT_DEFAULT,
  FINISHED_KEEP_MS,
  LINE_MAX,
  REPLAY_AGE_MS,
  REPLAY_SETTLE_MS,
  STATE_VERSION,
};

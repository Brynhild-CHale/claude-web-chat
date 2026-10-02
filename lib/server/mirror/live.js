// lib/server/mirror/live.js — each conversation's live state, and the heartbeat
// (spec §2.6; how the chrome words it is §7.3).
//
// The goal (D9): nobody has to guess whether a quiet Claude Code session is
// working, waiting on them, stuck or gone. This file turns four kinds of evidence
// into one Live object per conversation, the most specific true statement, and
// puts the transitions the turn guard, the asks domain and the release scheduler
// act on onto the mirror bus.
//
//   hooks             what Claude is doing, within ~200 ms (envelope v1, §1.3)
//   the sessions file Claude Code's own `status` and `waitingFor`
//                     (~/.claude/sessions/<pid>.json, read by claude-state.js and
//                     handed in); it changes only on a status change, so it is
//                     never a heartbeat and its `busy` is never trusted by age
//   process facts     alive, still the same process, stopped (Ctrl-Z), CPU time:
//                     one `sampleProcs` for every linked pid (lib/core/portfiles)
//   progress          the newest hook fire, transcript append, agent or workflow
//                     file append, task output growth, sessions-file write
//
// THE STATE MACHINE, per conversation; the first matching row wins:
//
//   1 ended       the linked process is GONE: two CONSECUTIVE verdict-bearing
//                 samples omit it and kill 0 (isPidAlive) says ESRCH each time,
//                 or a sample shows another start time (the pid was reused); or,
//                 with no pid known, a SessionEnd whose reason is not clear or
//                 resume and that no later hook contradicts
//   2 suspended   the linked process is stopped (its run state starts with T),
//                 and nothing has progressed since the sample that saw it
//   3 question,   a pending ask that is confirmed, or the sessions file says
//     waiting     `waiting`: `question` for AskUserQuestion or `input needed`,
//                 else `waiting` with kind `permission`, `plan` or `other`
//   4 compacting  a PreCompact newer than every sign that compaction ended
//                 (SessionStart(compact), the transcript's compact_boundary, or
//                 any later main-agent tool event or Stop)
//   5 working     an open turn, or the sessions file says busy with progress
//                 within STALE_BUSY_MS or the CPU ticking (and maybe `quiet`)
//   6 idle        the process alive, or a sessions file present, or a hook within
//                 HOOK_SILENCE_UNKNOWN_MS; `stale_status` when the file says busy
//                 but row 5 failed (F7's 18-day "busy")
//   7 unknown
//
// ONLY A GONE PROCESS IS EVER ENDED. A failed sample is no verdict: `sampleProcs`
// answers {alive: null} for a timeout, a spawn error, a signal or stderr text,
// and null never moves anything here — not the state, not the count of
// consecutive misses. A quiet live process is `working` with `quiet` set ("quiet,
// check the terminal"), or `idle`, or `unknown`; never `ended`.
//
// PENDING ASKS. A PermissionRequest makes an ask pending only from an interactive
// entrypoint (an `sdk*` one never: in -p the request fires even for a call that
// is then auto-denied, V3). It is CONFIRMED, and row 3 applies, while the linked
// sessions file says `waiting`, or when no sessions file was ever linked (one that
// disappeared — the process exiting — confirms nothing). It clears on the first
// of: the asks domain's PermissionResolved; the sessions file leaving `waiting`
// after it was seen there (busy: answered in the terminal; idle: Esc); a
// PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure or
// UserPromptSubmit of the same session and agent with a NEWER ts — except the
// PreToolUse of the ask's own call (equal input_hash), which async delivery can
// bring in after it — and, for a subagent's ask, that agent's own SubagentStop (a
// subagent fires no Stop: SubagentStop is its end, so its prompt is over); the
// turn closing, which clears EVERY ask of its session made before the close, the
// main agent's and its subagents' alike. A background agent's prompt still on
// screen after the turn closed keeps the conversation waiting through the
// sessions file's `waiting`, without the detail. Each clear emits
// `waiting-cleared`.
//
// ARRIVAL ORDER NEVER CHANGES THE OUTCOME. Async hooks race (§1.1), and the
// sessions file is polled, so every rule is written over timestamps, not over the
// order things arrive in:
//   - a tool_use_id that ended (PostToolUse or PostToolUseFailure) is remembered
//     for TOMBSTONE_MS; a PreToolUse for it, or one older than its session's last
//     Stop, StopFailure or turn close, is data (the turn machine keeps its label
//     and input) and never a running step;
//   - `step` is the running main-agent tool with the newest PreToolUse ts;
//   - the clearing events of the last TOMBSTONE_MS are remembered, so an ask that
//     arrives after the event that answered it is cleared on arrival;
//   - compaction, the no-pid SessionEnd and the stop of a suspended process are
//     decided by comparing timestamps.
//
// QUIET (§2.6). With no tool running: nothing progressed for QUIET_MODEL_MS and
// the CPU stayed under CPU_TICK_PCT for QUIET_CPU_MS (a long think keeps the TUI's
// spinner ticking, F7). With a tool running: QUIET_TOOL_MS without progress and
// an idle CPU (a five-minute `npm test` reads `Bash · 5:12`, not quiet). With no
// CPU data (no pid, failed samples, a rate older than CPU_STALE_MS): the time
// conditions alone, doubled.
//
// A TURN ENDED WITHOUT A STOP. This file ALONE decides it (the turn machine and
// the turn guard consume the decision and never re-derive it): the sessions file
// flipping busy → idle or waiting → idle while a turn is open arms a grace of
// STOP_GRACE_MS (an Esc fires no Stop, V3; a hook spawn takes ~80 ms). If that
// turn is still open when it runs out, no Stop or StopFailure of its session
// arrived for it, and the file is not busy or waiting again, the turn ended:
// `turn-closed {by: 'status'}` goes out exactly once. With `statusClosed` wired
// (the turn machine's), the decision is handed there and the turn machine emits
// the one turn-closed transition, with `ended_by`, as it does for every close;
// without it this file emits the transition itself. Either way exactly one.
//
// SAMPLING. One sample of every linked pid at a time, never two in flight:
// every PROC_SAMPLE_ACTIVE_MS while any conversation is working, compacting,
// asking or waiting; every PROC_SAMPLE_IDLE_MS otherwise; never with no linked
// pid; a pid linked since the last sample is sampled at once. The CPU rate is
// taken over CPU_WINDOW_MS. A second timer wakes the machine when time alone can
// change a state (the grace running out, quiet setting in, a stale busy or a
// silent session expiring).
//
// THE LIVE OBJECT (written to the model through `onLive`, the model's upsertLive,
// which redacts and caps it; starred fields are content):
//
//   { state, since, quiet: null | {since, reason: 'no-activity'}, stale_status,
//     step: {kind, tool, label*, started_at} | null,   kind: 'Edit', 'Bash', …,
//                                                      'MCP', 'Reply', 'Compacting'
//     waiting: {kind, tool, summary*, ask_id?, tool_use_id?, pending} | null,
//     last_activity_at, turn_started_at,
//     last_turn: {id, outcome, ended_at, code: {files, additions, deletions} | null,
//                 reply_preview*} | null,
//     process: {pid, alive, cpu_pct} | null,
//     evidence: {hook_at, transcript_at, task_output_at, sessions_file_at,
//                proc: 'alive'|'gone'|'stopped'|'unknown'},
//     ended_reason: 'process-gone'|'start-mismatch'|'session-end' | null }
//
// Every top-level key is always present (null or false when it does not apply):
// the model's upsertLive merges at the top level, so a key left out would keep
// its old value. `waiting.pending` is true when a pending ask backs the wait (the
// tool and its question or command are known), false when only the sessions
// file says `waiting`. `ended_reason` is not in §2.6's sketch of the object: it is
// what StatusRow's `ended_reason` (§2.9) is read from.
//
// TRANSITIONS (content-free, onto the mirror bus through `transition`):
//   {kind:'mirror', op:'state', conversation_id, session_id, pid, state, prev, waiting_kind?, ask_id?}
//   {kind:'mirror', op:'waiting-cleared', conversation_id, session_id, ask_id?, by}
//        by: 'terminal'|'web'|'esc'|'tool-ran'|'turn-closed'
//   {kind:'mirror', op:'process-gone', conversation_id, session_ids, pid}
//   {kind:'mirror', op:'turn-closed', conversation_id, session_id, turn_id, outcome:'interrupted', by:'status'}
//        (only when `statusClosed` is not wired, above)
//
// HOW THE FACADE WIRES IT (index.js; this file keeps no engine of its own):
//
//   createLive({
//     now, timers,                        the engine's clock and timers
//     sampleProcs, isPidAlive,            lib/core/portfiles (the defaults)
//     redact: (s) => model.scrubText(s),  the inbound scrub: no raw label, call,
//                                         question or waitingFor is kept here
//     openTurnOf: (cid) => { const id = turnMachine.openTurnOf(cid);
//                            return id ? model.turn(id) : null; },     REQUIRED
//     turnOf: (id) => model.turn(turnMachine.resolve(id)),
//     transition,                         the mirror bus
//     statusClosed: (d) => turnMachine.statusClosed(d),
//     processGone: (cid, {at}) => turnMachine.processGone(cid, {at}),
//     onLive: (cid, live) => model.upsertLive(cid, live),
//   })
//
//   ingest(cid, env)            every hook envelope the engine accepted
//   onConversation({change, conversation})   the registry's added | linked |
//                               merged | ended | removed; reads conversation.id,
//                               sessions[].session_id, current_session_id,
//                               process.{pid, proc_start|procStart, entrypoint}
//                               and ended_at
//   noteSessionState(cid, rec)  the linked sessions file: {status, waitingFor,
//                               entrypoint, procStart, pid?, updatedAt?,
//                               statusUpdatedAt?}, or null when it is gone
//   noteActivity(cid, at, kind) progress: 'transcript' | 'agent' | 'workflow' |
//                               'task_output' | 'sessions_file' | 'hook' | other
//   onChanges(sessionId, changes)   the transcript's normalized changes
//                               (`compact` ends compaction; a `reply` item mid-turn
//                               is the 'Reply' step)
//   onTurnOpened(turn), onTurnClosed(turn)   the turn machine's callbacks
//   liveOf(cid | sessionId), start(), stop() → Promise, sampleNow() → Promise
//
// The live state is in memory only: a daemon restart loses hook-only facts
// (running tools, pending asks), and the next hooks and samples rebuild it.
//
// It never signals a process (that is the control domain's, §15) and never
// touches the graph's lock (that is the turn guard's, from these transitions).
//
// Dependency direction: server; it imports lib/core only.

const portfiles = require('../../core/portfiles');
const { stableKey } = require('../../core/stable-json');
const { toolKind, toolSubject, stepLabel, callLabel } = require('../../core/tool-input');

// ── the constants (§2.6's table), each exported by name: a calibration is a
//    one-line change ──────────────────────────────────────────────────────────

const PROC_SAMPLE_ACTIVE_MS = 5000;
const PROC_SAMPLE_IDLE_MS = 15000;
const CPU_WINDOW_MS = 20000;
// Provisional: F7's single sample (a busy TUI 4.75 %, idle ones 0.55–0.95 %);
// gate V18 calibrates it.
const CPU_TICK_PCT = 2.5;
const QUIET_MODEL_MS = 90000;
const QUIET_TOOL_MS = 600000;
const QUIET_CPU_MS = 45000;
const STALE_BUSY_MS = 600000;
// busy → idle with an open turn and no Stop (a hook spawn takes about 80 ms, V3).
const STOP_GRACE_MS = 2000;
const HOOK_SILENCE_UNKNOWN_MS = 600000;
// The registry's discovery tick (conversations.js). It is in §2.6's table, so its
// one home is here with the rest; this file does not use it.
const DISCOVERY_MS = 10000;

// ── the rules' other numbers ─────────────────────────────────────────────────

// "Two consecutive samples": verdict-bearing ones, each with kill 0 saying ESRCH.
const GONE_SAMPLES = 2;
// How long an event is remembered so that one which should have come before it,
// arriving late, is still judged by it: an ended tool_use_id (§2.6's 60 s), the
// events that clear an ask, an ask the asks domain resolved.
const TOMBSTONE_MS = 60000;
// "With no CPU data, the time conditions alone, doubled."
const NO_CPU_FACTOR = 2;
// A CPU rate older than two idle-cadence samples is no CPU data.
const CPU_STALE_MS = 2 * PROC_SAMPLE_IDLE_MS;
// A rate over a shorter span than this is noise, not a rate.
const CPU_MIN_SPAN_MS = 1000;

// ── bounds ───────────────────────────────────────────────────────────────────

const MAX_RUNNING = 256; // running main-agent tools per conversation
const MAX_TOMBSTONES = 4096; // ended tool ids per conversation
const MAX_ASKS = 32; // pending asks per conversation
const MAX_RECENT = 64; // remembered PreToolUse events per session and agent
const MAX_SEEN = 4096; // envelopes remembered for idempotency
const MAX_RESOLVED = 256; // ask ids the asks domain resolved, per conversation
const MAX_CPU = 32; // CPU samples kept per conversation

// ── vocabularies ─────────────────────────────────────────────────────────────

const STATES = Object.freeze(['ended', 'suspended', 'question', 'waiting', 'compacting', 'working', 'idle', 'unknown']);
// The states that sample at the active cadence.
const ACTIVE_STATES = Object.freeze(['working', 'compacting', 'question', 'waiting']);
const WAITING_KINDS = Object.freeze(['permission', 'question', 'plan', 'other']);
const CLEARED_BY = Object.freeze(['terminal', 'web', 'esc', 'tool-ran', 'turn-closed']);
const ENDED_REASONS = Object.freeze(['process-gone', 'start-mismatch', 'session-end']);
const EVIDENCE_PROC = Object.freeze(['alive', 'gone', 'stopped', 'unknown']);

const FILE_STATUSES = new Set(['busy', 'waiting', 'idle']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const ASK_KIND_OF_TOOL = Object.freeze({ AskUserQuestion: 'question', ExitPlanMode: 'plan' });
const OUTCOMES = new Set(['done', 'interrupted', 'error', 'abandoned']);
const SDK_RE = /^sdk/;
// Ids are URL-safe (the model's grammar); a tool name is an id too (an MCP one
// is `mcp__<server>__<tool>`).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KIND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
// A sessions file's `waitingFor` → the wait's kind (V10: "permission prompt" for
// Bash, Write and ExitPlanMode, "input needed" for AskUserQuestion; the docs also
// name sandbox and worker requests and an open dialog, which are `other`).
const FILE_WAITING_KIND = Object.freeze({ 'permission prompt': 'permission', 'input needed': 'question' });

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// The later of two times, either of which may be absent.
const later = (a, b) => (finite(a) ? (finite(b) && b > a ? b : a) : finite(b) ? b : null);
const isSdk = (v) => typeof v === 'string' && SDK_RE.test(v);
const isStopped = (runState) => typeof runState === 'string' && runState.charAt(0) === 'T';
const validPid = (v) => Number.isSafeInteger(v) && v > 1;

// A start time: epoch ms, or the sessions file's `procStart` text.
function startOf(v) {
  if (finite(v)) return v;
  return typeof v === 'string' ? portfiles.parseProcStart(v) : null;
}

// Bounded insertion into an insertion-ordered Map: the oldest goes first.
function remember(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// The default timers are unref'd: a background sampler never holds a process
// open. The engine passes its own (all cleared by mirror.stop()).
const DEFAULT_TIMERS = Object.freeze({
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    if (h && typeof h.unref === 'function') h.unref();
    return h;
  },
  clearTimeout(h) { clearTimeout(h); },
});

function createLive({
  now = Date.now,
  sampleProcs = portfiles.sampleProcs,
  isPidAlive = (pid) => portfiles.isPidAlive(pid),
  timers = DEFAULT_TIMERS,
  redact = null,
  openTurnOf,
  turnOf = null,
  transition = null,
  statusClosed = null,
  processGone = null,
  onLive = null,
  log = () => {},
} = {}) {
  if (typeof openTurnOf !== 'function') {
    throw new Error('live: openTurnOf(cid) is required — the turn machine\'s open turn of a conversation, {id, session_id, started_at} or null');
  }
  const setT = (fn, ms) => timers.setTimeout(fn, ms);
  const clearT = (h) => (typeof timers.clearTimeout === 'function' ? timers.clearTimeout(h) : timers.clear(h));

  const convs = new Map(); // conversation id → its record (newConv)
  const sessionConv = new Map(); // session id → conversation id
  const seen = new Map(); // envelope keys already ingested (idempotency)

  let started = false;
  let stopped = false;
  let sampling = null; // the in-flight sample's promise
  let sampleTimer = null;
  let sampleDue = null;
  let lastSampleAt = null;
  let lastSampled = new Set(); // the pids the last sample asked about
  let deadlineTimer = null;
  let deadlineDue = null;

  function say(...args) { try { log(...args); } catch { /* a logger never breaks the machine */ } }

  // ── content and ids: the inbound scrub ──
  // Content passes the injected redactor before it is kept; without one it is not
  // kept at all (fail closed). An id must be well-formed and one the redactor
  // leaves as it is, as the model's cleanId requires.
  function text(s) {
    if (typeof s !== 'string' || !s || typeof redact !== 'function') return null;
    let out;
    try { out = redact(s); } catch { out = undefined; }
    return typeof out === 'string' && out ? out : null;
  }
  function cleanId(v) {
    if (typeof v !== 'string' || !ID_RE.test(v)) return null;
    if (typeof redact === 'function') {
      let out;
      try { out = redact(v); } catch { return null; }
      if (out !== v) return null;
    }
    return v;
  }

  function emit(t) {
    if (typeof transition !== 'function') return;
    try { transition(t); } catch (e) { say('live: a transition subscriber threw:', e && e.message); }
  }

  // ── conversations ──
  function freshProc() {
    return { alive: null, runState: null, stateAt: null, misses: 0, gone: null, cpu: [], rate: null, rateAt: null, lowSince: null };
  }
  // mode: 'none' (never linked: an ask confirms itself), 'linked', 'gone' (it
  // disappeared — the process exiting — and confirms nothing). `waitingKind` is
  // read from the raw `waitingFor`; `waitingFor` is its scrubbed text, for show.
  function freshFile() {
    return { mode: 'none', status: null, waitingKind: null, waitingFor: null, entrypoint: null, at: null, statusAt: null,
      lastWaitEnd: null };
  }
  function newConv(id, t) {
    return {
      id,
      sessions: new Set(),
      current: null, // the session of the newest envelope
      currentTs: -Infinity,
      registryCurrent: null, // the registry's current_session_id, which wins
      pid: null,
      expectStart: null, // the linked process's start: a record's procStart, or pinned from the first sample
      startPinned: false,
      linkGen: 0,
      entrypoint: null,
      proc: freshProc(),
      sf: freshFile(),
      hookAt: null, // progress evidence (clamped to the clock)
      transcriptAt: null,
      taskAt: null,
      otherAt: null,
      liveTs: null, // the newest envelope ts other than a SessionEnd's
      sessionEnd: null, // {at, sid}: the newest SessionEnd that is not clear/resume
      mainTs: null, // the newest main-agent tool event or Stop
      compactAt: null,
      compactEndAt: null,
      replyAt: null,
      stopTs: new Map(), // session → the newest Stop/StopFailure ts
      closeTs: new Map(), // session → the newest Stop/StopFailure ts or turn close
      toolEndTs: new Map(), // session → the newest main-agent PostToolUse(Failure) ts
      running: new Map(), // tool_use_id → {useId, sid, ts, name, kind, label}
      ended: new Map(), // tool_use_id → when its end arrived
      asks: [], // pending asks, oldest first
      recent: new Map(), // `${sid}|${agent}` → the clearing events remembered for late asks
      resolved: new Map(), // ask id → {at, by}
      flip: null, // {at, turnId, sid, turnStart}: a busy → idle flip waiting out the grace
      closedByStatus: new Map(), // turn id → when this file decided it ended
      lastTurn: null, // {id, ended_at, header}
      state: null,
      since: t,
      instant: null, // {at, since: Map(state → since)}: the states left at the instant `at`
      live: null,
      liveKey: null,
      computing: false,
      again: false,
    };
  }

  function ensure(cid, t) {
    let c = convs.get(cid);
    if (!c) { c = newConv(cid, t); convs.set(cid, c); }
    return c;
  }
  function convOf(id) {
    if (typeof id !== 'string') return null;
    return convs.get(id) || convs.get(sessionConv.get(id)) || null;
  }

  function noteSession(c, sid, ts) {
    c.sessions.add(sid);
    sessionConv.set(sid, c.id);
    if (finite(ts) && ts >= c.currentTs) { c.current = sid; c.currentTs = ts; }
  }
  const currentOf = (c) => c.registryCurrent || c.current || null;

  function drop(cid) {
    const c = convs.get(cid);
    if (!c) return;
    convs.delete(cid);
    for (const [sid, owner] of sessionConv) if (owner === cid) sessionConv.delete(sid);
    scheduleSample();
    scheduleDeadline();
  }

  // A new process for the conversation: every process fact starts again.
  function relink(c, pid, start) {
    c.pid = pid;
    c.expectStart = start;
    c.startPinned = false;
    c.linkGen += 1;
    c.proc = freshProc();
    c.sf = freshFile();
    c.flip = null;
  }

  // ── the open turn ──
  function openTurn(c) {
    let t = null;
    try { t = openTurnOf(c.id); } catch { t = null; }
    if (!isPlain(t) || typeof t.id !== 'string') return null;
    if (c.closedByStatus.has(t.id)) return null; // decided here; the turn machine may not be wired
    return t;
  }
  const closeTsOf = (c, sid) => (c.closeTs.has(sid) ? c.closeTs.get(sid) : -Infinity);

  // ── asks ──
  const recentKey = (sid, agent) => `${sid}|${agent === null ? '' : agent}`;
  function recentOf(c, sid, agent) {
    const k = recentKey(sid, agent);
    let r = c.recent.get(k);
    if (!r) { r = { turnTs: null, toolTs: null, pres: [] }; remember(c.recent, k, r, 256); }
    return r;
  }
  function ownCall(a, hash, name) {
    if (!a.hash || !hash || a.hash !== hash) return false;
    return !a.tool || !name || a.tool === name;
  }
  function clearAsk(c, a, by) {
    const i = c.asks.indexOf(a);
    if (i >= 0) c.asks.splice(i, 1);
    const t = { kind: 'mirror', op: 'waiting-cleared', conversation_id: c.id, session_id: a.sid };
    if (a.askId) t.ask_id = a.askId;
    t.by = by;
    emit(t);
  }

  // Was this ask answered before it arrived? (Arrival order: the event that
  // cleared it can come first.)
  function clearedAlready(c, a) {
    if (a.askId && c.resolved.has(a.askId)) return c.resolved.get(a.askId).by;
    const r = c.recent.get(recentKey(a.sid, a.agent));
    if (r) {
      if (finite(r.turnTs) && r.turnTs > a.ts) return 'turn-closed';
      if (finite(r.toolTs) && r.toolTs > a.ts) return 'tool-ran';
      if (r.pres.some((p) => p.ts > a.ts && !ownCall(a, p.hash, p.tool))) return 'tool-ran';
    }
    // The session's turn closed after it was made (noteClose's rule, seen from the
    // other side): whichever agent asked.
    if (closeTsOf(c, a.sid) > a.ts) return 'turn-closed';
    // The sessions file left `waiting` at or after the ask was made (leftWaiting's
    // rule, seen from the other side).
    const w = c.sf.lastWaitEnd;
    if (w && w.at >= a.ts) return w.to === 'idle' ? 'esc' : 'terminal';
    return null;
  }

  // A hook event that can clear the pending asks of its session and agent.
  function clearingEvent(c, sid, agent, event, ts, hash, name, t) {
    const r = recentOf(c, sid, agent);
    if (event === 'PreToolUse') {
      r.pres.push({ ts, hash, tool: name, at: t });
      if (r.pres.length > MAX_RECENT) r.pres.shift();
    } else if (TOOL_EVENTS.has(event)) {
      r.toolTs = later(r.toolTs, ts);
    } else {
      r.turnTs = later(r.turnTs, ts);
    }
    for (const a of [...c.asks]) {
      if (a.sid !== sid || a.agent !== agent || !(ts > a.ts)) continue;
      if (event === 'PreToolUse' && ownCall(a, hash, name)) continue;
      clearAsk(c, a, TOOL_EVENTS.has(event) ? 'tool-ran' : 'turn-closed');
    }
  }

  function askSummary(kind, name, tool) {
    if (kind === 'question') return name ? text(toolSubject(name, tool.input)) : null;
    if (kind === 'plan') return null;
    if (typeof tool.call === 'string' && tool.call) return text(tool.call);
    return name ? text(callLabel(name, tool.input)) : null;
  }

  function permissionRequest(c, sid, agent, env, ts, tool, useId) {
    if (isSdk(env.entrypoint) || isSdk(c.entrypoint) || isSdk(c.sf.entrypoint)) return; // never pending (C38)
    const tl = tool || {};
    const name = cleanId(tl.name);
    const askEnv = isPlain(env.ask) ? env.ask : {};
    const kind = askEnv.kind === 'permission' || askEnv.kind === 'question' || askEnv.kind === 'plan'
      ? askEnv.kind : ASK_KIND_OF_TOOL[name] || 'permission';
    const a = {
      sid, agent, ts,
      hash: typeof tl.input_hash === 'string' && tl.input_hash ? tl.input_hash : null,
      tool: name,
      kind,
      summary: askSummary(kind, name, tl),
      askId: cleanId(askEnv.id),
      useId,
      seenWaiting: c.sf.mode === 'linked' && c.sf.status === 'waiting',
    };
    if (c.asks.some((x) => x.sid === a.sid && x.agent === a.agent && x.ts === a.ts && x.hash === a.hash)) return;
    const by = clearedAlready(c, a);
    if (by) { clearAsk(c, a, by); return; }
    c.asks.push(a);
    if (c.asks.length > MAX_ASKS) c.asks.shift();
  }

  function permissionResolved(c, sid, agent, env, ts, useId, t) {
    const ask = isPlain(env.ask) ? env.ask : {};
    const askId = cleanId(ask.id);
    const by = CLEARED_BY.includes(ask.by) ? ask.by : 'web';
    if (askId) remember(c.resolved, askId, { at: t, by }, MAX_RESOLVED);
    for (const a of [...c.asks]) {
      const match = askId ? a.askId === askId
        : useId ? a.useId === useId
          : a.sid === sid && a.agent === agent && a.ts <= ts;
      if (match) clearAsk(c, a, by);
    }
  }

  // ── tools ──
  function toolEvent(c, sid, agent, event, ts, tool, useId, t) {
    const hash = tool && typeof tool.input_hash === 'string' && tool.input_hash ? tool.input_hash : null;
    const name = tool ? cleanId(tool.name) : null;
    clearingEvent(c, sid, agent, event, ts, hash, name, t);
    if (agent !== null) return; // a subagent's tool is progress, never the conversation's step
    c.mainTs = later(c.mainTs, ts);
    if (!useId) return;
    if (event === 'PreToolUse') {
      if (c.ended.has(useId)) return; // its end came first: data only
      const kind = tool && typeof tool.kind === 'string' && KIND_RE.test(tool.kind) ? tool.kind : toolKind(name || '');
      const label = text(tool && tool.label) || (name ? text(stepLabel(name, tool && tool.input)) : null);
      remember(c.running, useId, { useId, sid, ts, name, kind, label }, MAX_RUNNING);
    } else {
      c.running.delete(useId);
      remember(c.ended, useId, t, MAX_TOMBSTONES);
      c.toolEndTs.set(sid, later(c.toolEndTs.get(sid), ts));
    }
  }

  // ── hook envelopes ──
  // An envelope's identity, for idempotency. Two distinct envelopes can share a
  // session, an event and a millisecond: the main agent's and a subagent's, two
  // calls of one message (a PermissionRequest carries no tool_use_id, V3), two asks
  // the asks domain resolved together. So the key names the agent, the call's
  // input_hash and the ask as well as the tool_use_id.
  function envelopeKey(id, sid, event, ts, useId, agent, tool, ask) {
    const hash = tool && typeof tool.input_hash === 'string' ? tool.input_hash.slice(0, 128) : '';
    const askId = isPlain(ask) ? cleanId(ask.id) || '' : '';
    return [id, sid, event, ts, useId || '', agent === null ? '' : agent, hash, askId].join('|');
  }

  function ingest(cid, env) {
    if (stopped || !isPlain(env)) return;
    const id = cleanId(cid);
    const sid = cleanId(env.session_id);
    if (!id || !sid) return;
    const event = typeof env.event === 'string' ? env.event : '';
    const t = now();
    const ts = finite(env.ts) ? env.ts : t;
    const tool = isPlain(env.tool) ? env.tool : null;
    const useId = tool ? cleanId(tool.use_id) : null;
    const agent = isPlain(env.agent) ? cleanId(env.agent.id) || '?' : null;
    const key = envelopeKey(id, sid, event, ts, useId, agent, tool, env.ask);
    if (seen.has(key)) return; // idempotent: an envelope seen before changes nothing
    remember(seen, key, true, MAX_SEEN);
    const c = ensure(id, t);
    noteSession(c, sid, ts);
    c.hookAt = later(c.hookAt, Math.min(ts, t));
    if (event !== 'SessionEnd') c.liveTs = later(c.liveTs, ts);
    switch (event) {
      case 'SessionStart':
        if (isPlain(env.session) && env.session.source === 'compact') c.compactEndAt = later(c.compactEndAt, ts);
        break;
      case 'SessionEnd': {
        const reason = isPlain(env.session) ? env.session.reason : null;
        if (reason !== 'clear' && reason !== 'resume' && (!c.sessionEnd || ts >= c.sessionEnd.at)) c.sessionEnd = { at: ts, sid };
        break;
      }
      case 'PreCompact':
        c.compactAt = later(c.compactAt, ts);
        break;
      case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure':
        toolEvent(c, sid, agent, event, ts, tool, useId, t);
        break;
      case 'Stop': case 'StopFailure':
        // A Stop is the main agent's (a subagent's end is SubagentStop): one that
        // names an agent is read as that agent's end, never as the turn's.
        if (agent !== null) { clearingEvent(c, sid, agent, event, ts, null, null, t); break; }
        c.stopTs.set(sid, later(c.stopTs.get(sid), ts));
        c.mainTs = later(c.mainTs, ts);
        // A Stop of the flipped turn inside the grace: it ended normally.
        if (c.flip && c.flip.sid === sid && ts >= c.flip.turnStart) c.flip = null;
        clearingEvent(c, sid, null, event, ts, null, null, t);
        noteClose(c, sid, ts); // the turn closing: every ask of the session made before it
        break;
      case 'SubagentStop':
        // The agent's own end: every ask it made before it is over (answered, or
        // abandoned with the agent). Remembered, so an ask arriving after it is
        // cleared on arrival. One that names no agent is no subagent's: progress only.
        if (agent !== null) clearingEvent(c, sid, agent, event, ts, null, null, t);
        break;
      case 'UserPromptSubmit':
        clearingEvent(c, sid, agent, event, ts, null, null, t);
        break;
      case 'PermissionRequest':
        permissionRequest(c, sid, agent, env, ts, tool, useId);
        break;
      case 'PermissionResolved':
        permissionResolved(c, sid, agent, env, ts, useId, t);
        break;
      default:
        break; // the rest: progress only
    }
    recompute(c);
  }

  // ── the registry's conversations ──
  function onConversation(ev) {
    if (stopped || !isPlain(ev) || !isPlain(ev.conversation)) return;
    const conv = ev.conversation;
    const cid = cleanId(conv.id);
    if (!cid) return;
    if (ev.change === 'removed' || (ev.change === 'merged' && cleanId(conv.merged_into))) { drop(cid); return; }
    const t = now();
    const c = ensure(cid, t);
    if (Array.isArray(conv.sessions)) {
      for (const s of conv.sessions) {
        const sid = isPlain(s) ? cleanId(s.session_id) : null;
        if (sid) { c.sessions.add(sid); sessionConv.set(sid, cid); }
      }
    }
    const cur = cleanId(conv.current_session_id);
    if (cur) { c.registryCurrent = cur; c.sessions.add(cur); sessionConv.set(cur, cid); }
    const p = isPlain(conv.process) ? conv.process : null;
    if (p) {
      if (typeof p.entrypoint === 'string') c.entrypoint = p.entrypoint;
      const pid = validPid(p.pid) ? p.pid : null;
      const start = startOf(p.proc_start !== undefined ? p.proc_start : p.procStart);
      // Another process — a new pid, or the same pid with another start (a resume
      // whose process drew the old one's pid) — starts every process fact again.
      const known = c.expectStart !== null && !c.startPinned;
      const another = pid !== c.pid
        || (start !== null && known && Math.abs(start - c.expectStart) > portfiles.PROC_START_TOLERANCE_MS);
      if (pid !== null && another) relink(c, pid, start);
      else if (pid !== null && start !== null && !known) {
        // A record's start replaces one pinned from a sample; the next sample judges it.
        c.expectStart = start;
        c.startPinned = false;
      }
    }
    // A conversation the registry kept as ended, with no process to sample, ended
    // by a SessionEnd before this daemon saw it (a later hook revives it).
    if (finite(conv.ended_at) && c.pid === null && (!c.sessionEnd || conv.ended_at > c.sessionEnd.at)) {
      c.sessionEnd = { at: conv.ended_at, sid: currentOf(c) };
    }
    recompute(c);
  }

  // ── the sessions file ──
  function noteSessionState(cid, rec) {
    if (stopped) return;
    const c = convOf(cid);
    if (!c) return;
    const t = now();
    const prevMode = c.sf.mode;
    const prev = prevMode === 'linked' ? c.sf.status : null;
    if (!isPlain(rec)) {
      if (prevMode === 'linked') {
        c.sf.mode = 'gone'; // the process is exiting: it confirms nothing any more
        c.sf.status = null;
        c.sf.waitingKind = null;
        c.sf.waitingFor = null;
        if (prev === 'waiting') leftWaiting(c, 'gone', t);
      }
      recompute(c);
      return;
    }
    if (validPid(rec.pid) && c.pid !== null && rec.pid !== c.pid) return; // another process's file
    const status = FILE_STATUSES.has(rec.status) ? rec.status : null;
    const waitingKind = status !== 'waiting' ? null
      : FILE_WAITING_KIND[typeof rec.waitingFor === 'string' ? rec.waitingFor.trim() : ''] || 'other';
    const changeAt = finite(rec.statusUpdatedAt) ? Math.min(rec.statusUpdatedAt, t) : t;
    const newerWrite = finite(rec.statusUpdatedAt) && (c.sf.statusAt === null || rec.statusUpdatedAt > c.sf.statusAt);
    // Progress evidence: the file's own write time when it has one; else only a
    // change seen between two reads. A first read proves nothing about when the
    // file was written (F7's "busy" was 18 days old).
    let wroteAt = null;
    if (finite(rec.updatedAt)) wroteAt = Math.min(rec.updatedAt, t);
    else if (finite(rec.statusUpdatedAt)) wroteAt = Math.min(rec.statusUpdatedAt, t);
    else if (prevMode === 'linked' && (status !== prev || waitingKind !== c.sf.waitingKind)) wroteAt = t;
    c.sf.mode = 'linked';
    c.sf.status = status;
    c.sf.waitingKind = waitingKind;
    c.sf.waitingFor = status === 'waiting' ? text(rec.waitingFor) : null;
    if (typeof rec.entrypoint === 'string') c.sf.entrypoint = rec.entrypoint;
    if (finite(rec.statusUpdatedAt)) c.sf.statusAt = Math.max(c.sf.statusAt || 0, rec.statusUpdatedAt);
    c.sf.at = later(c.sf.at, wroteAt);
    if (c.pid !== null && (c.expectStart === null || c.startPinned)) {
      const s = startOf(rec.procStart);
      if (s !== null) { c.expectStart = s; c.startPinned = false; }
    }
    if (status === 'waiting') for (const a of c.asks) a.seenWaiting = true;
    if (prev === 'waiting' && status !== 'waiting') leftWaiting(c, status, changeAt);
    // busy → idle or waiting → idle; or an idle written after the open turn began,
    // its busy missed between two reads (a newer status write than the last seen).
    if (status === 'idle' && (prev === 'busy' || prev === 'waiting' || newerWrite)) armFlip(c, changeAt);
    recompute(c);
  }

  // The file left `waiting` at `at`: every ask it was seen waiting for, made by
  // then, was answered (busy: in the terminal, 52 ms after a Yes; idle: Esc or No,
  // 123 ms after, V10). An ask made after it is the next prompt's, waiting for the
  // file's next `waiting` (exact when the file carries statusUpdatedAt).
  function leftWaiting(c, to, at) {
    c.sf.lastWaitEnd = { at, to };
    const by = to === 'idle' ? 'esc' : 'terminal';
    for (const a of [...c.asks]) if (a.seenWaiting && a.ts <= at) clearAsk(c, a, by);
  }

  function armFlip(c, at) {
    const turn = openTurn(c);
    if (!turn) return;
    if (finite(turn.started_at) && at < turn.started_at) return; // the idle predates this turn
    if (c.flip && c.flip.turnId === turn.id) return;
    c.flip = { at, turnId: turn.id, sid: cleanId(turn.session_id) || currentOf(c), turnStart: finite(turn.started_at) ? turn.started_at : -Infinity };
  }

  // The grace ran out: did the turn end without a Stop?
  function settleFlip(c, t) {
    const f = c.flip;
    if (!f || t < f.at + STOP_GRACE_MS) return;
    c.flip = null;
    const turn = openTurn(c);
    if (!turn || turn.id !== f.turnId) return; // closed or replaced meanwhile
    const sid = cleanId(turn.session_id) || f.sid;
    if (sid && finite(c.stopTs.get(sid)) && c.stopTs.get(sid) >= f.turnStart) return; // its Stop came
    if (c.sf.mode === 'linked' && (c.sf.status === 'busy' || c.sf.status === 'waiting')) return; // busy again
    remember(c.closedByStatus, turn.id, t, 256);
    const decision = { kind: 'mirror', op: 'turn-closed', conversation_id: c.id, session_id: sid || null, turn_id: turn.id,
      outcome: 'interrupted', by: 'status' };
    noteClose(c, sid, f.at);
    if (typeof statusClosed === 'function') {
      // The turn machine applies it and emits the one turn-closed (with ended_by),
      // and its onTurnClosed brings the closed header back here.
      try { statusClosed({ ...decision, at: f.at }); } catch (e) { say('live: statusClosed threw:', e && e.message); }
    } else {
      c.lastTurn = { id: turn.id, ended_at: f.at, header: { ...turn, status: 'interrupted', ended_at: f.at } };
      emit(decision);
    }
  }

  // ── progress from the other sources ──
  function noteActivity(cid, at, kind) {
    if (stopped) return;
    const c = convOf(cid);
    if (!c) return;
    const t = now();
    const a = finite(at) ? Math.min(at, t) : t;
    switch (kind) {
      case 'transcript': case 'agent': case 'workflow': c.transcriptAt = later(c.transcriptAt, a); break;
      case 'task_output': case 'task': c.taskAt = later(c.taskAt, a); break;
      case 'sessions_file': c.sf.at = later(c.sf.at, a); break;
      case 'hook': c.hookAt = later(c.hookAt, a); break;
      default: c.otherAt = later(c.otherAt, a); break;
    }
    recompute(c);
  }

  // The transcript's normalized changes (the turn machine's contract): a
  // compact_boundary ends compaction; a reply item is the 'Reply' step while its
  // turn is open; every batch is a transcript append.
  function onChanges(sessionId, changes) {
    if (stopped || !Array.isArray(changes)) return;
    const c = convOf(sessionId);
    if (!c) return;
    const t = now();
    let newest = null;
    for (const ch of changes) {
      if (!isPlain(ch)) continue;
      const ts = finite(ch.ts) ? ch.ts : null;
      newest = later(newest, ts);
      if (ch.type === 'compact') c.compactEndAt = later(c.compactEndAt, ts === null ? t : ts);
      else if (ch.type === 'item' && isPlain(ch.item) && ch.item.kind === 'reply') c.replyAt = later(c.replyAt, ts === null ? t : ts);
    }
    c.transcriptAt = later(c.transcriptAt, Math.min(newest === null ? t : newest, t));
    recompute(c);
  }

  // ── the turn machine's callbacks ──
  // A turn of the session closed at `at` (§2.6: "the turn closing"): every ask of
  // that session made before it is over, the main agent's and its subagents'
  // alike (strictly before, as every "newer" here is strict, so the order two
  // events arrive in never decides a tie). An ask made after the close — a
  // background agent's, say — is not this turn's and stays.
  function noteClose(c, sid, at) {
    if (sid) c.closeTs.set(sid, later(c.closeTs.get(sid), at));
    for (const a of [...c.asks]) if ((!sid || a.sid === sid) && a.ts < at) clearAsk(c, a, 'turn-closed');
  }

  function onTurnOpened(turn) {
    if (stopped || !isPlain(turn)) return;
    const c = convOf(cleanId(turn.conversation_id));
    if (!c) return;
    const sid = cleanId(turn.session_id);
    if (sid) { c.sessions.add(sid); sessionConv.set(sid, c.id); }
    recompute(c);
  }

  function onTurnClosed(turn) {
    if (stopped || !isPlain(turn)) return;
    const c = convOf(cleanId(turn.conversation_id));
    const tid = cleanId(turn.id);
    if (!c || !tid) return;
    const at = finite(turn.ended_at) ? turn.ended_at : now();
    noteClose(c, cleanId(turn.session_id), at);
    if (c.flip && c.flip.turnId === tid) c.flip = null;
    if (!c.lastTurn || !(c.lastTurn.ended_at > at)) c.lastTurn = { id: tid, ended_at: at, header: turn };
    recompute(c);
  }

  // ── process sampling ──
  function linkedPids() {
    const out = new Set();
    for (const c of convs.values()) if (c.pid !== null && !c.proc.gone) out.add(c.pid);
    return [...out];
  }
  const anyActive = () => [...convs.values()].some((c) => c.pid !== null && !c.proc.gone && ACTIVE_STATES.includes(c.state));

  function scheduleSample() {
    if (!started || stopped || sampling) return; // an in-flight sample reschedules when it settles
    const pids = linkedPids();
    if (!pids.length) { clearSampleTimer(); return; }
    const t = now();
    const fresh = pids.some((p) => !lastSampled.has(p));
    const interval = anyActive() ? PROC_SAMPLE_ACTIVE_MS : PROC_SAMPLE_IDLE_MS;
    const due = lastSampleAt === null || fresh ? t : Math.max(t, lastSampleAt + interval);
    if (sampleTimer !== null && sampleDue <= due) return;
    clearSampleTimer();
    sampleDue = due;
    sampleTimer = setT(() => { sampleTimer = null; sampleDue = null; runSample(); }, due - t);
  }
  function clearSampleTimer() {
    if (sampleTimer !== null) clearT(sampleTimer);
    sampleTimer = null;
    sampleDue = null;
  }

  function runSample() {
    if (stopped) return Promise.resolve();
    if (sampling) return sampling;
    const pids = linkedPids();
    if (!pids.length) return Promise.resolve();
    clearSampleTimer();
    const at = now();
    lastSampleAt = at;
    lastSampled = new Set(pids);
    const gens = new Map();
    for (const c of convs.values()) if (c.pid !== null) gens.set(c.id, c.linkGen);
    let p;
    try { p = Promise.resolve(sampleProcs(pids)); } catch { p = Promise.resolve(null); }
    sampling = p.then(
      (map) => { if (!stopped) applySample(map instanceof Map ? map : null, at, gens); },
      () => { /* a sampler that rejects gave no verdict */ },
    ).finally(() => { sampling = null; scheduleSample(); });
    return sampling;
  }

  function applySample(map, at, gens) {
    for (const c of [...convs.values()]) {
      if (c.pid === null || c.proc.gone || gens.get(c.id) !== c.linkGen) continue; // relinked meanwhile
      applyEntry(c, map ? map.get(c.pid) : null, at);
      recompute(c);
    }
  }

  function applyEntry(c, e, at) {
    if (!isPlain(e) || typeof e.alive !== 'boolean') return; // no verdict: nothing moves
    if (e.alive === false) {
      let alive;
      try { alive = isPidAlive(c.pid); } catch { alive = null; }
      if (alive === false) {
        c.proc.misses += 1;
        c.proc.alive = false;
        if (c.proc.misses >= GONE_SAMPLES) markGone(c, 'process-gone', at);
      } else {
        c.proc.misses = 0; // kill 0 still finds it: this sample is no verdict, and the run of misses is broken
      }
      return;
    }
    c.proc.misses = 0;
    if (finite(e.startedAt)) {
      if (c.expectStart !== null && Math.abs(e.startedAt - c.expectStart) > portfiles.PROC_START_TOLERANCE_MS) {
        markGone(c, 'start-mismatch', at);
        return;
      }
      if (c.expectStart === null) { c.expectStart = e.startedAt; c.startPinned = true; }
    }
    c.proc.alive = true;
    c.proc.runState = typeof e.state === 'string' ? e.state : null;
    c.proc.stateAt = at;
    if (finite(e.cpuMs)) noteCpu(c, at, e.cpuMs);
  }

  // The CPU rate (percent of one core) over CPU_WINDOW_MS: from the oldest
  // sample inside the window to this one. `lowSince` is where the current run of
  // rates under CPU_TICK_PCT began.
  function noteCpu(c, at, cpuMs) {
    const list = c.proc.cpu;
    list.push({ at, cpuMs });
    while (list.length > MAX_CPU || (list.length > 1 && list[0].at < at - CPU_WINDOW_MS)) list.shift();
    const base = list.find((s) => at - s.at >= CPU_MIN_SPAN_MS) || null;
    if (!base || cpuMs < base.cpuMs) return; // no span to read a rate over (or a counter that went back)
    const rate = ((cpuMs - base.cpuMs) / (at - base.at)) * 100;
    c.proc.rate = rate;
    c.proc.rateAt = at;
    if (rate >= CPU_TICK_PCT) c.proc.lowSince = null;
    else if (c.proc.lowSince === null) c.proc.lowSince = base.at;
  }

  function markGone(c, reason, at) {
    c.proc.gone = { at, reason };
    c.proc.alive = false;
    c.flip = null;
    emit({ kind: 'mirror', op: 'process-gone', conversation_id: c.id, session_ids: [...c.sessions], pid: c.pid });
    if (typeof processGone === 'function') {
      try { processGone(c.id, { at, pid: c.pid }); } catch (e) { say('live: processGone threw:', e && e.message); }
    }
    for (const a of [...c.asks]) clearAsk(c, a, 'turn-closed');
  }

  // ── computing the live object ──
  const lastProgressOf = (c) => [c.hookAt, c.transcriptAt, c.taskAt, c.otherAt, c.sf.at].reduce(later, null);
  const cpuFresh = (c, t) => !c.proc.gone && finite(c.proc.rate) && finite(c.proc.rateAt) && t - c.proc.rateAt <= CPU_STALE_MS;

  function prune(c, t) {
    for (const [id, at] of c.ended) { if (t - at <= TOMBSTONE_MS) break; c.ended.delete(id); }
    for (const [id, r] of c.running) if (!(r.ts > closeTsOf(c, r.sid))) c.running.delete(id);
    for (const r of c.recent.values()) {
      while (r.pres.length && t - r.pres[0].at > TOMBSTONE_MS) r.pres.shift();
    }
    for (const [id, x] of c.resolved) { if (t - x.at <= TOMBSTONE_MS) break; c.resolved.delete(id); }
  }

  function waitingOf(c) {
    const fileWaiting = c.sf.mode === 'linked' && c.sf.status === 'waiting';
    const confirmed = c.sf.mode === 'none' || fileWaiting;
    let ask = null;
    if (confirmed) for (const a of c.asks) if (!ask || a.ts > ask.ts || (a.ts === ask.ts && a.sid + a.agent > ask.sid + ask.agent)) ask = a;
    if (!ask && !fileWaiting) return null;
    const fileKind = fileWaiting ? c.sf.waitingKind || 'other' : null;
    let kind;
    if ((ask && ask.kind === 'question') || fileKind === 'question') kind = 'question';
    else kind = ask ? ask.kind : fileKind;
    const w = {
      kind,
      tool: ask ? ask.tool : null,
      summary: ask ? ask.summary : kind === 'other' ? c.sf.waitingFor : null,
      pending: Boolean(ask),
    };
    if (ask && ask.askId) w.ask_id = ask.askId;
    if (ask && ask.useId) w.tool_use_id = ask.useId;
    return w;
  }

  function stepOf(c, state, turn) {
    if (state === 'compacting') return { kind: 'Compacting', tool: null, label: 'Compacting', started_at: c.compactAt };
    if (state !== 'working' && state !== 'question' && state !== 'waiting' && state !== 'suspended') return null;
    let best = null;
    for (const r of c.running.values()) {
      if (!(r.ts > closeTsOf(c, r.sid)) || c.ended.has(r.useId)) continue;
      if (!best || r.ts > best.ts || (r.ts === best.ts && r.useId > best.useId)) best = r;
    }
    if (turn && finite(c.replyAt) && (!finite(turn.started_at) || c.replyAt >= turn.started_at)
      && (!best || c.replyAt > best.ts)) {
      const sid = cleanId(turn.session_id);
      const ended = sid ? c.toolEndTs.get(sid) : null;
      if (!(finite(ended) && ended >= c.replyAt)) return { kind: 'Reply', tool: null, label: 'Reply', started_at: c.replyAt };
    }
    return best ? { kind: best.kind, tool: best.name, label: best.label, started_at: best.ts } : null;
  }

  function quietOf(c, t, step, lastProgress, turn) {
    const base = finite(lastProgress) ? lastProgress : turn && finite(turn.started_at) ? turn.started_at : c.since;
    const tool = step !== null && step.kind !== 'Reply' && step.kind !== 'Compacting';
    const cpu = cpuFresh(c, t);
    const limit = (tool ? QUIET_TOOL_MS : QUIET_MODEL_MS) * (cpu ? 1 : NO_CPU_FACTOR);
    if (!finite(base) || t - base < limit) return null;
    if (cpu && (c.proc.lowSince === null || t - c.proc.lowSince < QUIET_CPU_MS)) return null;
    return { since: cpu ? Math.max(base, c.proc.lowSince) : base, reason: 'no-activity' };
  }

  function lastTurnOf(c) {
    if (!c.lastTurn) return null;
    let h = c.lastTurn.header;
    if (typeof turnOf === 'function') {
      try {
        const fresh = turnOf(c.lastTurn.id);
        if (isPlain(fresh) && fresh.status !== 'open') h = fresh;
      } catch { /* the stored header stands */ }
    }
    const code = isPlain(h.code) && h.code.status === 'ready'
      ? { files: finite(h.code.files) ? h.code.files : 0, additions: finite(h.code.additions) ? h.code.additions : 0,
        deletions: finite(h.code.deletions) ? h.code.deletions : 0 }
      : null;
    return {
      id: cleanId(h.id) || c.lastTurn.id,
      outcome: OUTCOMES.has(h.status) ? h.status : null,
      ended_at: finite(h.ended_at) ? h.ended_at : c.lastTurn.ended_at,
      code,
      reply_preview: text(h.reply_preview),
    };
  }

  function build(c, t) {
    const turn = openTurn(c);
    const linked = c.sf.mode === 'linked';
    const lastProgress = lastProgressOf(c);
    const cpu = cpuFresh(c, t);
    const ticking = cpu && c.proc.rate >= CPU_TICK_PCT;
    // Stopped, unless the process itself has done something since the sample that
    // saw it stopped (a hook, a transcript write, its sessions file): a background
    // shell it started may run on, so task output proves nothing here.
    const ranSince = [c.hookAt, c.transcriptAt, c.sf.at].reduce(later, null);
    const suspended = c.proc.alive === true && isStopped(c.proc.runState)
      && !(finite(ranSince) && finite(c.proc.stateAt) && ranSince > c.proc.stateAt);
    const endedBySession = c.pid === null && c.sessionEnd !== null && !(finite(c.liveTs) && c.liveTs > c.sessionEnd.at);
    const compactEnd = later(c.compactEndAt, c.mainTs);
    const compacting = finite(c.compactAt) && !(finite(compactEnd) && compactEnd >= c.compactAt);
    let state;
    let ended = null;
    let waiting = null;
    if (c.proc.gone) { state = 'ended'; ended = c.proc.gone; }
    else if (endedBySession) { state = 'ended'; ended = { at: c.sessionEnd.at, reason: 'session-end' }; }
    else if (suspended) state = 'suspended';
    else if ((waiting = waitingOf(c))) state = waiting.kind === 'question' ? 'question' : 'waiting';
    else if (compacting) state = 'compacting';
    else if (turn || (linked && c.sf.status === 'busy' && ((finite(lastProgress) && t - lastProgress <= STALE_BUSY_MS) || ticking))) state = 'working';
    else if (c.proc.alive === true || linked || (finite(c.hookAt) && t - c.hookAt <= HOOK_SILENCE_UNKNOWN_MS)) state = 'idle';
    else state = 'unknown';

    const step = stepOf(c, state, turn);
    let proc = 'unknown';
    if (c.proc.gone) proc = 'gone';
    else if (c.pid !== null && c.proc.alive === true) proc = suspended ? 'stopped' : 'alive';
    const live = {
      state,
      since: null,
      quiet: state === 'working' ? quietOf(c, t, step, lastProgress, turn) : null,
      stale_status: state === 'idle' && linked && c.sf.status === 'busy',
      step,
      waiting: state === 'question' || state === 'waiting' ? waiting : null,
      last_activity_at: lastProgress,
      turn_started_at: state !== 'ended' && turn && finite(turn.started_at) ? turn.started_at : null,
      last_turn: lastTurnOf(c),
      process: c.pid === null ? null
        : { pid: c.pid, alive: c.proc.gone ? false : c.proc.alive, cpu_pct: cpu ? Math.round(c.proc.rate * 10) / 10 : null },
      evidence: { hook_at: c.hookAt, transcript_at: c.transcriptAt, task_output_at: c.taskAt, sessions_file_at: c.sf.at, proc },
      ended_reason: ended ? ended.reason : null,
    };
    return { live, state, endedAt: ended ? ended.at : null };
  }

  function recompute(c) {
    if (stopped || convs.get(c.id) !== c) return;
    if (c.computing) { c.again = true; return; }
    c.computing = true;
    try {
      let rounds = 0;
      do {
        c.again = false;
        const t = now();
        prune(c, t);
        const { live, state, endedAt } = build(c, t);
        if (state !== c.state) {
          const prev = c.state;
          // A state left and come back to within one instant (events of one moment,
          // arriving in some order) keeps its old `since`: the order they arrived in
          // is not part of the outcome.
          if (!c.instant || c.instant.at !== t) c.instant = { at: t, since: new Map() };
          if (!c.instant.since.has(prev)) c.instant.since.set(prev, c.since);
          let since = state === 'ended' && finite(endedAt) ? Math.min(endedAt, t) : t;
          if (c.instant.since.has(state)) since = c.instant.since.get(state);
          c.state = state;
          c.since = since;
          live.since = c.since;
          const tr = { kind: 'mirror', op: 'state', conversation_id: c.id, session_id: currentOf(c), pid: c.pid, state, prev };
          if (live.waiting) {
            tr.waiting_kind = live.waiting.kind;
            if (live.waiting.ask_id) tr.ask_id = live.waiting.ask_id;
          }
          emit(tr);
        } else {
          live.since = c.since;
        }
        const key = stableKey(live);
        if (key !== c.liveKey) {
          c.liveKey = key;
          c.live = live;
          if (typeof onLive === 'function') {
            try { onLive(c.id, live); } catch (e) { say('live: onLive threw:', e && e.message); }
          }
        }
        rounds += 1;
      } while (c.again && rounds < 8);
    } finally {
      c.computing = false;
    }
    scheduleSample();
    scheduleDeadline();
  }

  // ── the clock: when time alone can change a state ──
  // Each deadline is the first instant its rule reads differently: quiet sets in
  // AT its threshold (`t - base >= limit`); "within" STALE_BUSY_MS,
  // HOOK_SILENCE_UNKNOWN_MS and CPU_STALE_MS is inclusive, so those run out one
  // millisecond AFTER theirs.
  function nextDeadline(c, t) {
    let next = Infinity;
    const add = (x) => { if (finite(x) && x > t && x < next) next = x; };
    if (c.state === 'ended') return next; // nothing but new evidence moves it
    if (c.flip) next = Math.min(next, Math.max(t, c.flip.at + STOP_GRACE_MS));
    const lp = lastProgressOf(c);
    if (c.state === 'working') {
      const base = finite(lp) ? lp : c.since;
      for (const f of [1, NO_CPU_FACTOR]) { add(base + QUIET_MODEL_MS * f); add(base + QUIET_TOOL_MS * f); }
      if (c.proc.lowSince !== null) add(c.proc.lowSince + QUIET_CPU_MS);
      if (finite(c.proc.rateAt)) add(c.proc.rateAt + CPU_STALE_MS + 1);
    }
    if (c.sf.mode === 'linked' && c.sf.status === 'busy' && finite(lp)) add(lp + STALE_BUSY_MS + 1);
    if (finite(c.hookAt)) add(c.hookAt + HOOK_SILENCE_UNKNOWN_MS + 1);
    return next;
  }

  function scheduleDeadline() {
    if (!started || stopped) return;
    const t = now();
    let next = Infinity;
    for (const c of convs.values()) next = Math.min(next, nextDeadline(c, t));
    if (next === Infinity) { clearDeadline(); return; }
    if (deadlineTimer !== null && deadlineDue <= next) return;
    clearDeadline();
    deadlineDue = next;
    deadlineTimer = setT(onDeadline, Math.max(0, next - t));
  }
  function clearDeadline() {
    if (deadlineTimer !== null) clearT(deadlineTimer);
    deadlineTimer = null;
    deadlineDue = null;
  }
  function onDeadline() {
    deadlineTimer = null;
    deadlineDue = null;
    if (stopped) return;
    const t = now();
    for (const c of [...convs.values()]) settleFlip(c, t);
    for (const c of [...convs.values()]) recompute(c);
    scheduleDeadline();
  }

  // ── lifecycle and reads ──
  function start() {
    stopped = false;
    started = true;
    for (const c of [...convs.values()]) recompute(c);
    scheduleSample();
    scheduleDeadline();
    return Promise.resolve();
  }

  // Idempotent. Resolves once a sample in flight has settled (its answer is then
  // ignored), so nothing this file started is still running.
  function stop() {
    stopped = true;
    started = false;
    clearSampleTimer();
    clearDeadline();
    return sampling ? sampling.then(() => {}, () => {}) : Promise.resolve();
  }

  function sampleNow() { return runSample(); }

  function liveOf(id) {
    const c = convOf(id);
    return c && c.live ? JSON.parse(JSON.stringify(c.live)) : null;
  }

  function stateOf(id) {
    const c = convOf(id);
    return c ? c.state : null;
  }

  return {
    ingest, onConversation, noteSessionState, noteActivity, onChanges, onTurnOpened, onTurnClosed,
    start, stop, sampleNow, liveOf, stateOf,
    conversations: () => [...convs.keys()],
  };
}

module.exports = {
  createLive,
  // §2.6's table
  PROC_SAMPLE_ACTIVE_MS,
  PROC_SAMPLE_IDLE_MS,
  CPU_WINDOW_MS,
  CPU_TICK_PCT,
  QUIET_MODEL_MS,
  QUIET_TOOL_MS,
  QUIET_CPU_MS,
  STALE_BUSY_MS,
  STOP_GRACE_MS,
  HOOK_SILENCE_UNKNOWN_MS,
  DISCOVERY_MS,
  // the rules' other numbers
  GONE_SAMPLES,
  TOMBSTONE_MS,
  NO_CPU_FACTOR,
  CPU_STALE_MS,
  CPU_MIN_SPAN_MS,
  // bounds
  MAX_RUNNING,
  MAX_TOMBSTONES,
  MAX_ASKS,
  MAX_RECENT,
  MAX_SEEN,
  MAX_RESOLVED,
  MAX_CPU,
  // vocabularies
  STATES,
  ACTIVE_STATES,
  WAITING_KINDS,
  CLEARED_BY,
  ENDED_REASONS,
  EVIDENCE_PROC,
};

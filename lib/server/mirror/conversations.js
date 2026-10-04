// lib/server/mirror/conversations.js — the conversation registry: which Claude
// Code conversations belong to this project, the sessions each one chains, and
// the process that writes it (spec §2.2; §2.6 "The sessions file"; the
// Conversation shape of §2.10; process.interrupt, §15.2).
//
// A SESSION is one Claude Code session_id and its transcript file. A
// CONVERSATION is the chain of sessions one Claude Code process writes: a /clear
// starts a new session (a new id, a new file, no pointer in either, V14) and is
// not a new conversation to the user. Its id is the chain's first session id.
//
// DISCOVERY, in order of authority:
//
//   1. hooks. Every envelope carries session_id, transcript_path and cwd (V3).
//      `ingest(env)` accepts one only when its cwd belongs to this project —
//      findProjectRoot(cwd) is this root, compared by realpath (a nested
//      project's sessions belong to the nested daemon) — and when
//      lib/core/claude-files transcriptFile accepts its transcript_path, a
//      <session_id>.jsonl directly in a project directory under Claude Code's
//      projectsDir. Anything else is ignored, as `foreign-root` or `bad-path`.
//      The file need not exist yet (it does not at SessionStart, V3). The
//      envelope's claude_pid (CLAUDE_PID, best effort, V14) links the process.
//   2. the sessions file, read through lib/core/claude-sessions (which never
//      opens the `.key` beside each): a record is a candidate when its cwd
//      belongs to this project and its pid is alive with a matching procStart
//      (lib/core/portfiles isPidAlive(pid, {startedAt, sample}), one sample for
//      every pid not already linked; `false` is another process, `null` no
//      verdict). Its transcript is projectDir(cwd)/<sessionId>.jsonl.
//   3. MCP presence rows (lib/util/registry mcpSessionsFor(root)): each row's
//      ppid is a Claude Code process attached to this root. Joined to (2) by
//      pid, a row vouches for a record whose procStart cannot be checked (none,
//      or no verdict) or whose cwd lies elsewhere. Each row's `interrupt`
//      ('tty' when that session's MCP server can inject an Esc, §15.2) is the
//      conversation's process.interrupt; null without one.
//   4. the newest-file fallback, only when 1–3 found nothing live and no hook
//      came in the last FALLBACK_WINDOW_MS: when exactly one transcript in this
//      project's directory changed in that window, it is a provisional
//      conversation (`provisional: true`, never persisted), dropped as soon as a
//      hook or a sessions file names another session ("newest" named the wrong
//      session 59–64 % of the time with two sessions, V13) and kept, no longer
//      provisional, when one names its own.
//
// Discovery runs at start, every DISCOVERY_MS (10 s; the timer is unref'd), and
// at once after a SessionStart or SessionEnd; one run at a time.
//
// LINKS.
//   * /clear: SessionEnd(clear) then SessionStart(clear) with a new session id,
//     71 ms apart (V14). Linked by the envelope's claude_pid: the new session
//     joins the conversation that pid was writing, with reason 'clear', and the
//     old session is marked ended. Or by the sessions file switching sessionId
//     under the same pid and procStart: while hooks are flowing for that
//     conversation, the registry waits CLEAR_GRACE_MS for the SessionStart that
//     says what the switch was (a /clear, an in-place /resume or /fork) before
//     taking it for a /clear; with no hooks (none installed, or a switch made
//     while the daemon was down) it links at once. When the grace runs out the
//     file is read again, and a switch it no longer shows is left to the read
//     that shows the newer one. A switch to a session older than one the
//     process had before is a /resume, never a /clear: a /clear always makes a
//     new session.
//   * the old file is drained first: the 'linked' event names the session it
//     follows (`previous_session_id`), and a source that tails transcripts reads
//     that file to its end before it follows the new one (it gets tail metadata
//     about 112 ms before the new one appears, V14). The old session stays in the
//     conversation, and transcriptPath() still answers for it.
//   * resume: a SessionStart(resume) for a known session moves that conversation
//     to the process that sent it (and revives it if it had ended). A conversation
//     the process leaves keeps it as its last process and ends with it, marked
//     as left by a resume (process.left_by, persisted). The sessions file moving
//     a process into a conversation it could not have made by a /clear (another
//     process's, one it left, or an older session than its last) is the same.
//   * fork: a SessionStart(fork) is a new conversation; when the process that
//     sent it was writing another one (an in-place /fork), that one is
//     `forked_from`, and is marked as left by a fork. A fork from a new process
//     (`--fork-session`) names no source; the transcripts source finds it (the
//     fork's first turn ids already belong to another conversation, V14) and
//     calls markFork, and it skips the copied turns.
//   * formerNames: a sessions file (2.1.287) lists the sessions its process had
//     before. §2.2 makes it a hint for a /clear missed while the daemon was
//     down, never proof of one chain: a process also leaves a session by
//     /resume and /fork, and its hooks say which. So a former session's
//     conversation joins the current session's only when nothing the registry
//     knows says a step between them was no /clear (formerJoins): a
//     SessionStart for the current session that said resume, fork or startup,
//     or came from another process; a current session older than one the
//     process had before it; a conversation another process writes (or, for
//     the current session's, wrote), one this process left by a fork or a
//     resume, or a fork and its source. While hooks flow, a join waits
//     CLEAR_GRACE_MS for that SessionStart, as a switch does; with none
//     flowing (a /clear made while the daemon was down) it joins at once.
//   * without a link each session is its own conversation; a link found later
//     merges the younger into the older (the 'merged' event carries merged_into).
//
// ENDING. A conversation ends only when its process is gone: `processGone(cid,
// {at, pid})`, the live machine's two-sample verdict (live.js, §2.6), which the
// facade hands in. SessionEnd marks a SESSION ended and nothing else — it is
// missed 1 time in 6 (V14) and nothing depends on it — and SessionEnd(clear |
// resume) is not even that much of an ending. A verdict on a process the
// conversation has since left (a resume moved it) changes nothing.
//
// PERSISTENCE: `.web-chat/mirror/conversations.json`, `{v: 1, conversations:
// […]}` (§2.2), written through lib/core/fsjson writeJsonAtomic soon after
// every add, link, merge, end and removal (and at most every ACTIVITY_SAVE_MS
// for activity alone), and at stop. Read with readJson: `corrupt` or `invalid`
// is set aside (renameAside) and the registry rebuilt by discovery. Bounded to
// CONVERSATIONS_MAX by last activity — conversations no process is writing go
// first — and a pruned one's turn index files and per-turn diff files are
// deleted. Every field read back is checked again: the file sits in a project
// directory. No text is written that the injected `redact` has not passed
// (`title`, `name`); without one, none is written. Beside §2.2's fields each
// record keeps what a restart must not forget: `entrypoint` (the headless flag,
// whether or not a pid was ever known) and its process's `linked_by`,
// `linked_at` and `left_by` ('fork' | 'resume' | null: the process left this
// conversation that way, so formerNames never joins it back).
//
// AT BOOT the file is loaded and every restored conversation announced
// ('added', `restored: true`); the first discovery relinks live processes: a
// live pid and procStart matching a stored process whose sessionId is unknown
// is a /clear missed while down, and is linked.
//
// THE TOGGLE. resolveToggle({cwd: root, scopes: ['user', 'project']}) at start
// and every DISCOVERY_MS. Disabled: every watch and timer but the toggle's own
// stops, pending writes are flushed, the in-memory registry is dropped (the file
// stays), `onToggle({enabled: false, scope})` tells the facade (which resets the
// stream), and ingests answer `{ok: false, ignored: 'disabled'}`. Re-enabled:
// the file is loaded again and discovery runs. The session scope is checked per
// session (cached for DISCOVERY_MS): a disabled session is never linked; and
// one switched off after it was linked is never handed out (transcriptPath and
// sessionDir answer null for it, so nothing tails it), and while it is its
// conversation's current session that process's sessions file is not watched.
// Every discovery checks it again; a change is an 'updated' event, and switched
// back on, both come back.
//
// HEADLESS sessions (entrypoint `sdk-cli`, a `claude -p`) are conversations
// too, flagged `headless: true` from the first envelope or sessions file that
// says so, with or without a pid; what that means for the live state and the
// chrome is theirs (§2.2, §2.6).
//
// THE SESSIONS FILE of each process a conversation is linked to is followed by
// claude-state.js (a watch per process, a 1 s poll while the conversation is
// not idle and 5 s while it is): what it reads goes to `onSessionState(cid,
// record | null)` (the live machine's noteSessionState) and back here, where a
// switched sessionId is a link. Only the conversation a process is writing now
// (its newest claim) hears that process's file; one it left hears null.
//
// EVENTS, after each change, in order:
//   onConversation({change, conversation, ...})
//     'added'    {restored?}                  a new conversation, or one loaded
//     'linked'   {session_id, previous_session_id, reason}   a session joined
//                                             or became current, or a process was
//                                             linked: reason 'clear', 'resume',
//                                             'process' (one linked where none was)
//                                             or 'merge'
//     'merged'   {merged_into}                the younger, absorbed (its view
//                                             carries merged_into)
//     'ended'    {at}                         its process is gone
//     'removed'  {reason: 'pruned'|'fallback'}  pruned, or the fallback dropped
//     'updated'  {}                           anything else in the view changed
//                                             (a session ended, the process's
//                                             fields, interrupt, name, provisional)
//   transition({kind: 'mirror', op: 'conversation', conversation_id, change,
//               merged_into?}) for the first five, on the mirror bus (§2.6).
//   `conversation` is view(): the §2.10 fields this registry owns —
//     {id, title?, name, current_session_id, headless,
//      sessions: [{session_id, reason, started_at, ended_at?}],
//      process: {pid, proc_start, kind, entrypoint, cc_version, linked_by,
//                interrupt, mod} | null   (null once ended),
//      started_at, last_activity_at, ended_at, forked_from, provisional?, merged_into?}
//   `proc_start` is what the live machine checks a sample's start against.
//
// HOW THE FACADE WIRES IT (index.js; U12b):
//
//   conversations = createConversations({
//     root, paths, now, timers, log,
//     redact: (s) => model.scrubText(s),
//     transition,                                  the mirror bus
//     stateOf: (cid) => (live.liveOf(cid) || {}).state,
//     onSessionState: (cid, rec) => live.noteSessionState(cid, rec),
//     onConversation: (ev) => {
//       if (ev.change === 'merged' || ev.change === 'removed')
//         turnMachine.removeConversation(ev.conversation.id, { merged_into: ev.merged_into });
//       else model.upsertConversation(ev.conversation.id, ev.conversation);
//       live.onConversation(ev);  and every source's onConversation(ev)
//     },
//     onToggle: ({ enabled, scope }) => …,       stop tailers, reset, rediscover
//   })
//   live's processGone: (cid, o) => { turnMachine.processGone(cid, o); conversations.processGone(cid, o); }
//   mirror.ingest(env): const r = conversations.ingest(env); if (r.ok) route env to r.conversation_id
//   mirror.conversationOfPid = conversations.conversationOfPid
//   engine.conversations = conversations     get, bySession, list, sessionDir,
//                                            transcriptPath, processOf
//   a live state change → conversations.retune(cid) (the watch's cadence)
//
// It never signals a process, never opens a transcript (transcriptPath only
// fences one), and never reads a sessions `.key` file.
//
// Dependency direction: server; imports lib/core, lib/util/registry,
// lib/toggle/policy, and its siblings claude-state.js and live.js (for
// DISCOVERY_MS, whose one home is §2.6's table there).

const fs = require('fs');
const path = require('path');
const { projectPaths, userClaudePaths, findProjectRoot, realpath, claudeProjectSlug } = require('../../core/paths');
const fsjson = require('../../core/fsjson');
const portfiles = require('../../core/portfiles');
const claudeFiles = require('../../core/claude-files');
const claudeSessions = require('../../core/claude-sessions');
const registry = require('../../util/registry');
const togglePolicy = require('../../toggle/policy');
const { createClaudeState } = require('./claude-state');
const { DISCOVERY_MS } = require('./live');

// ── constants (§2.2), each exported by name ─────────────────────────────────

const FILE_VERSION = 1;
const CONVERSATIONS_MAX = 200;
// Sessions kept per conversation (a /clear adds one); the oldest go first.
const SESSIONS_MAX = 100;
// "exactly one .jsonl changed in the last two minutes"; also how recent a hook
// must be for discovery to have "found something".
const FALLBACK_WINDOW_MS = 2 * 60 * 1000;
// A project directory with more transcripts than this is not scanned for the
// fallback: it could not tell one recent file cheaply, and hooks are the answer.
const FALLBACK_SCAN_MAX = 10000;
// How long a sessionId switch seen in a sessions file waits for the SessionStart
// that names it, while hooks flow for that conversation (a hook spawn takes
// about 80 ms, V3; STOP_GRACE_MS is the same allowance).
const CLEAR_GRACE_MS = 2000;
// Activity alone (last_activity_at) is written at most this often.
const ACTIVITY_SAVE_MS = 30000;
// The per-envelope checks (cwd → root, transcript fence, session toggle) are
// cached this long, and at most this many of each.
const CACHE_TTL_MS = DISCOVERY_MS;
const CACHE_MAX = 256;
// Ids of merged conversations kept, so a late caller still finds the survivor.
const ALIASES_MAX = 1000;
// How a process last arrived at a session (its SessionStart, or a resume the
// sessions file saw), kept for this many sessions, the newest.
const ARRIVALS_MAX = 1000;
// The longest title or name kept (the Conversation's caps, §2.10).
const TEXT_MAX = 300;

// ── vocabularies ─────────────────────────────────────────────────────────────

const REASONS = Object.freeze(['start', 'clear', 'resume', 'fork']);
const REASON_SET = new Set(REASONS);
// How a process was linked, the most authoritative first (§2.2's order).
const LINKED_BY = Object.freeze(['hook', 'sessions-file', 'mcp']);
const LINKED_RANK = new Map(LINKED_BY.map((v, i) => [v, i]));
// SessionStart's `source` → the session's reason; `compact` starts nothing.
const SOURCE_REASON = Object.freeze({ startup: 'start', clear: 'clear', resume: 'resume', fork: 'fork' });
// The changes that are also transitions on the mirror bus (§2.6).
const CHANGES = Object.freeze(['added', 'linked', 'merged', 'ended', 'removed']);
const TRANSITION_CHANGES = new Set(CHANGES);
const IGNORED = Object.freeze(['stopped', 'disabled', 'bad-envelope', 'foreign-root', 'bad-path', 'session-disabled', 'error']);

const SDK_RE = /^sdk/;
// A project directory's name under projectsDir, as claudeProjectSlug makes one.
const SLUG_RE = /^[A-Za-z0-9-]{1,255}$/;
// How a process left a conversation that formerNames must never join back.
const LEFT_BY = new Set(['fork', 'resume']);
// The sessions file's field grammars, written once in lib/core/claude-sessions:
// conversations.json holds the same fields and reads them back by the same rules.
const { entrypointOf, wordOf, versionOf, procStartOf } = claudeSessions;

// The default timers are unref'd: the discovery tick never holds a process open.
// The engine passes its own (all cleared by mirror.stop()).
const DEFAULT_TIMERS = Object.freeze({
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    if (h && typeof h.unref === 'function') h.unref();
    return h;
  },
  clearTimeout(h) { clearTimeout(h); },
});

// ── small helpers ────────────────────────────────────────────────────────────

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const maxOf = (a, b) => (finite(a) ? (finite(b) && b > a ? b : a) : finite(b) ? b : null);

// A Claude Code session id (a UUID): lib/core/paths' one id grammar, starting
// with a letter or a digit (the mirror model's id grammar wants that too), as
// the sessions-file reader checks it.
function validSessionId(v) {
  return claudeSessions.sessionIdOf(v) !== null;
}
// A Claude Code pid: an integer of at least 2 (envelope v1's claude_pid rule).
function validPid(v) {
  return Number.isSafeInteger(v) && v >= 2;
}
const interruptOf = (row) => (isPlain(row) && row.interrupt === 'tty' ? 'tty' : null);

// Two procStart texts name the same start: within the tolerance once parsed,
// else (one unparseable) only when identical.
function sameStart(a, b) {
  const x = portfiles.parseProcStart(a);
  const y = portfiles.parseProcStart(b);
  if (x !== null && y !== null) return Math.abs(x - y) <= portfiles.PROC_START_TOLERANCE_MS;
  return a === b;
}

// Bounded insertion into an insertion-ordered Map: the oldest goes first.
function remember(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function createConversations({
  root,
  paths = null,
  now = Date.now,
  timers = DEFAULT_TIMERS,
  log = () => {},
  redact = null,
  transition = null,
  onConversation = null,
  onSessionState = null,
  onToggle = null,
  stateOf = null,
  discoveryMs = DISCOVERY_MS,
  clearGraceMs = CLEAR_GRACE_MS,
  activitySaveMs = ACTIVITY_SAVE_MS,
  maxConversations = CONVERSATIONS_MAX,
  // seams: the engines this file reads through, replaceable in tests
  sampleProcs = portfiles.sampleProcs,
  isPidAlive = portfiles.isPidAlive,
  mcpSessionsFor = registry.mcpSessionsFor,
  readSessionState = claudeSessions.readSessionState,
  listSessionPids = claudeSessions.listSessionPids,
  resolveToggle = togglePolicy.resolve,
  transcriptFile = claudeFiles.transcriptFile,
  watchFile = undefined,
  claudeState: claudeStateOptions = {},
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('conversations: root is the project directory the daemon serves');
  const p = paths || projectPaths(root);
  const rootAbs = path.resolve(root);
  const rootReal = realpath(rootAbs) || rootAbs;
  const setT = (fn, ms) => timers.setTimeout(fn, ms);
  const clearT = (h) => (typeof timers.clearTimeout === 'function' ? timers.clearTimeout(h) : timers.clear(h));

  // ── state ──
  const convs = new Map(); // conversation id → record (below)
  const sessionOf = new Map(); // session id → conversation id
  const aliases = new Map(); // a merged conversation's id → the survivor's
  // session id → { start_ts, source, pid, at }: `start_ts` the newest
  // SessionStart's ts (a SessionEnd older than it is stale); `source` how a
  // process last arrived at the session ('start' | 'clear' | 'resume' | 'fork',
  // by its SessionStart, or 'resume' seen happen in a sessions file), from which
  // `pid` (null when the envelope gave none), at `at`. Bounded to ARRIVALS_MAX,
  // and a removed conversation's sessions leave it.
  const arrivals = new Map();
  const pendingClear = new Map(); // session id → { timer, pid }: a switch waiting on its SessionStart
  const cwdCache = new Map();
  const pathCache = new Map();
  const sessionToggle = new Map();
  // `${pid}\0${procStart}` of the sessions files a verdict found gone, or held by
  // another process: neither comes back, so neither is sampled again (a crashed
  // session's file can sit there for good). Bounded to CACHE_MAX.
  const deadProcs = new Map();
  let lastMcp = new Map(); // Claude Code pid → its presence row (the last discovery's)
  let fallbackId = null; // the provisional conversation's id
  let lastHookAt = null; // the newest accepted envelope, by this clock
  let enabledState = { enabled: true };
  let toggleChecked = false;
  let loaded = false;
  let stopped = false;
  let gen = 0; // bumped by stop and by a disable: an async step that began before it is void
  let tickTimer = null;
  let discoverTimer = null;
  let saveTimer = null;
  let saveDue = null;
  let dirtyUrgent = false;
  let dirtyActivity = false;
  let watchDirty = false;
  let pendingDeletes = []; // session ids whose index and diff files go at the next write
  let events = []; // queued until the mutation that made them has finished
  let depth = 0;
  let running = null; // the discovery in flight
  let followUp = null; // { promise, resolve } for callers waiting on the next run
  let startPromise = null;
  const counters = { discoveries: 0, ingested: 0, ignored: Object.fromEntries(IGNORED.map((k) => [k, 0])) };

  // A record:
  //   { id, created_at, last_activity_at, ended_at, title, name, forked_from,
  //     current_session_id, current_at, entrypoint, provisional,
  //     sessions: [{ session_id, slug, reason, started_at, ended_at }],
  //     process: null | { pid, proc_start, kind, entrypoint, cc_version, linked_by, linked_at, left_by },
  //     hookAt, interrupt, off }        (hookAt, interrupt, off, current_at: memory only)
  //   `off`: its current session was switched off by the session scope when
  //   discovery last looked (the change is announced once).

  function say(...args) { try { log(...args); } catch { /* a logger never breaks the registry */ } }

  const claudeState = createClaudeState({
    onRecord: onStateRecord,
    stateOf: (cid) => {
      if (typeof stateOf !== 'function') return null;
      try { return stateOf(cid); } catch { return null; }
    },
    readSessionState,
    watchFile,
    log: say,
    ...claudeStateOptions,
  });
  const releasing = new Set(); // claude-state unlink promises, awaited by stop()
  function track(promise) {
    const p2 = Promise.resolve(promise).catch(() => {});
    releasing.add(p2);
    p2.then(() => releasing.delete(p2));
    return p2;
  }

  // ── text: nothing is kept that the redactor has not passed ──
  function cleanText(s) {
    if (typeof s !== 'string' || !s || typeof redact !== 'function') return null;
    let out;
    try { out = redact(s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) : s); } catch { out = null; }
    return typeof out === 'string' && out ? out.slice(0, TEXT_MAX) : null;
  }

  // ── lookups ──
  function recordOf(id) {
    if (typeof id !== 'string') return null;
    return convs.get(id) || convs.get(aliases.get(id)) || convs.get(sessionOf.get(id)) || null;
  }
  function recordOfSession(sid) {
    const cid = sessionOf.get(sid);
    return cid ? convs.get(cid) || null : null;
  }
  const sessionEntry = (rec, sid) => rec.sessions.find((s) => s.session_id === sid) || null;
  const isEnded = (rec) => finite(rec.ended_at);
  function firstStart(rec) {
    let t = null;
    for (const s of rec.sessions) if (finite(s.started_at) && (t === null || s.started_at < t)) t = s.started_at;
    return t === null ? rec.created_at : t;
  }
  function isHeadless(rec) {
    const ep = (rec.process && rec.process.entrypoint) || rec.entrypoint;
    return typeof ep === 'string' && SDK_RE.test(ep);
  }
  // Nobody is writing it: ended, or no process and every session ended.
  function isInactive(rec) {
    if (isEnded(rec)) return true;
    return !rec.process && rec.sessions.every((s) => finite(s.ended_at));
  }
  // Is `procStart` a start the conversation's process can have? The same start
  // when both are known; else a process that started after it was linked is a
  // newer one holding a reused pid.
  function compatible(rec, procStart) {
    if (procStart == null || !rec.process) return true;
    if (rec.process.proc_start) return sameStart(rec.process.proc_start, procStart);
    const started = portfiles.parseProcStart(procStart);
    if (started === null || !finite(rec.process.linked_at)) return true;
    return started <= rec.process.linked_at + portfiles.PROC_START_TOLERANCE_MS;
  }
  // The conversation `pid` is writing now: of the live ones it is linked to, the
  // newest claim.
  function ownerOf(pid, { except = null, procStart = null } = {}) {
    let best = null;
    for (const rec of convs.values()) {
      if (rec === except || rec.provisional || isEnded(rec) || !rec.process || rec.process.pid !== pid) continue;
      if (!compatible(rec, procStart)) continue;
      if (!best || claimAt(rec) > claimAt(best) || (claimAt(rec) === claimAt(best) && rec.created_at > best.created_at)) best = rec;
    }
    return best;
  }
  const claimAt = (rec) => (rec.process && finite(rec.process.linked_at) ? rec.process.linked_at : -Infinity);
  function owners() {
    const out = new Map(); // pid → record
    for (const rec of convs.values()) {
      if (rec.provisional || isEnded(rec) || !rec.process) continue;
      const cur = out.get(rec.process.pid);
      if (!cur || claimAt(rec) > claimAt(cur) || (claimAt(rec) === claimAt(cur) && rec.created_at > cur.created_at)) out.set(rec.process.pid, rec);
    }
    return out;
  }
  // The pid is linked, live, to a conversation whose process `procStart` fits.
  function linkedAs(pid, procStart) {
    for (const rec of convs.values()) {
      if (rec.provisional || isEnded(rec) || !rec.process || rec.process.pid !== pid) continue;
      if (procStart == null || rec.process.proc_start == null || sameStart(rec.process.proc_start, procStart)) return true;
    }
    return false;
  }
  // Is the conversation's process this one (the pid, with a start it can have)?
  const isProcess = (rec, pid, procStart) => !!rec.process && rec.process.pid === pid && compatible(rec, procStart);
  // One conversation was forked from the other: never one chain.
  function forkLinked(a, b) {
    return (!!a.forked_from && recordOf(a.forked_from) === b) || (!!b.forked_from && recordOf(b.forked_from) === a);
  }

  // ── the per-envelope checks, cached ──
  function cached(map, key, compute) {
    const t = now();
    const hit = map.get(key);
    if (hit && t >= hit.at && t - hit.at < CACHE_TTL_MS) return hit.value;
    const value = compute();
    remember(map, key, { value, at: t }, CACHE_MAX);
    return value;
  }
  // Does `cwd` belong to this project: is the nearest ancestor with a .web-chat/
  // this root (by realpath: Claude Code records physical paths, the daemon may
  // have been handed a link)? A nested project's sessions belong to its own
  // daemon.
  function ownsCwd(cwd) {
    if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)) return false;
    return cached(cwdCache, cwd, () => {
      try {
        const found = findProjectRoot(cwd);
        return !!found && (realpath(found) || path.resolve(found)) === rootReal;
      } catch {
        return false;
      }
    });
  }
  // The slug of an envelope's transcript_path, when lib/core/claude-files
  // accepts it as this session's own transcript; else null (`bad-path`).
  function transcriptSlug(tp, sid) {
    if (typeof tp !== 'string' || !tp || tp.length > 4096) return null;
    return cached(pathCache, `${sid}\0${tp}`, () => {
      let fenced = null;
      try { fenced = transcriptFile(tp); } catch { fenced = null; }
      if (!fenced || path.basename(fenced) !== `${sid}.jsonl`) return null;
      const slug = path.basename(path.dirname(fenced));
      return SLUG_RE.test(slug) ? slug : null;
    });
  }
  function sessionEnabled(sid) {
    return cached(sessionToggle, sid, () => {
      try {
        const d = resolveToggle({ sessionId: sid, scopes: ['session'] });
        return !(d && d.enabled === false);
      } catch {
        return true;
      }
    });
  }
  function slugOfCwd(cwd) {
    const slug = typeof cwd === 'string' ? claudeProjectSlug(cwd) : null;
    return slug && SLUG_RE.test(slug) ? slug : null;
  }
  // When a session's transcript was made, from the file, or null.
  function fileStart(slug, sid) {
    if (!slug || !validSessionId(sid)) return null;
    try {
      const st = fs.lstatSync(path.join(userClaudePaths().projectsDir, slug, `${sid}.jsonl`));
      if (!st.isFile()) return null;
      return finite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    } catch {
      return null;
    }
  }

  // ── the mutation frame: events go out once the state is whole ──
  function mutate(fn) {
    depth += 1;
    let out;
    try {
      out = fn();
    } finally {
      depth -= 1;
      if (depth === 0) settle();
    }
    return out;
  }
  function settle() {
    try { pruneIfNeeded(); } catch (e) { say('conversations: prune failed:', e && e.message); }
    try { syncWatches(); } catch (e) { say('conversations: watch sync failed:', e && e.message); }
    scheduleSave();
    while (events.length) {
      const list = events;
      events = [];
      for (const ev of list) dispatch(ev);
    }
  }
  function queue(change, rec, extra = {}) {
    events.push({ kind: 'conversation', ev: { change, conversation: viewOf(rec), ...extra } });
  }
  function queueState(cid, record) {
    events.push({ kind: 'state', cid, record });
  }
  function dispatch(item) {
    if (item.kind === 'state') {
      if (typeof onSessionState !== 'function') return;
      try { onSessionState(item.cid, item.record); } catch (e) { say('conversations: onSessionState threw:', e && e.message); }
      return;
    }
    const { ev } = item;
    if (typeof transition === 'function' && TRANSITION_CHANGES.has(ev.change)) {
      const t = { kind: 'mirror', op: 'conversation', conversation_id: ev.conversation.id, change: ev.change };
      if (ev.change === 'merged' && ev.merged_into) t.merged_into = ev.merged_into;
      try { transition(t); } catch (e) { say('conversations: a transition subscriber threw:', e && e.message); }
    }
    if (typeof onConversation === 'function') {
      try { onConversation(ev); } catch (e) { say('conversations: onConversation threw:', e && e.message); }
    }
  }

  // ── the view (§2.10's fields this registry owns) ──
  function viewOf(rec) {
    const ended = isEnded(rec);
    const pr = rec.process;
    const out = {
      id: rec.id,
      name: rec.name,
      current_session_id: rec.current_session_id,
      headless: isHeadless(rec),
      sessions: rec.sessions.map((s) => {
        const o = { session_id: s.session_id, reason: s.reason, started_at: s.started_at };
        if (finite(s.ended_at)) o.ended_at = s.ended_at;
        return Object.freeze(o);
      }),
      process: !ended && pr ? Object.freeze({
        pid: pr.pid, proc_start: pr.proc_start, kind: pr.kind, entrypoint: pr.entrypoint, cc_version: pr.cc_version,
        linked_by: pr.linked_by, interrupt: rec.interrupt, mod: false,
      }) : null,
      started_at: firstStart(rec),
      last_activity_at: rec.last_activity_at,
      ended_at: ended ? rec.ended_at : null,
      forked_from: rec.forked_from,
    };
    Object.freeze(out.sessions);
    if (rec.title) out.title = rec.title;
    if (rec.provisional) out.provisional = true;
    if (rec.merged_into) out.merged_into = rec.merged_into;
    return Object.freeze(out);
  }

  // ── writes to a record ──
  function touchActivity(rec, at) {
    const t = now();
    const a = finite(at) ? Math.min(at, t) : t;
    if (!finite(rec.last_activity_at) || a > rec.last_activity_at) {
      rec.last_activity_at = a;
      dirtyActivity = true;
    }
  }
  function endSession(rec, sid, at) {
    const s = sid ? sessionEntry(rec, sid) : null;
    if (!s || finite(s.ended_at)) return false;
    s.ended_at = finite(at) ? at : now();
    return true;
  }
  function reopenSession(rec, sid, at) {
    const s = sessionEntry(rec, sid);
    if (!s || !finite(s.ended_at) || (finite(at) && at < s.ended_at)) return false;
    s.ended_at = null;
    return true;
  }
  function capSessions(rec) {
    while (rec.sessions.length > SESSIONS_MAX) {
      const i = rec.sessions.findIndex((s) => s.session_id !== rec.current_session_id);
      const [gone] = rec.sessions.splice(i < 0 ? 0 : i, 1);
      if (sessionOf.get(gone.session_id) === rec.id) sessionOf.delete(gone.session_id);
    }
  }

  // Link `pid` to the conversation. Answers 'moved' (another process, or none
  // before), 'updated' (the same process, a field filled in or a claim renewed),
  // or false. A record ended before `at` is revived; evidence older than its end
  // (a late envelope from the dead process) is not.
  function claimProcess(rec, { pid, procStart = null, via = 'hook', at, entrypoint = null, kind = null, ccVersion = null }) {
    if (!validPid(pid)) return false;
    const t = finite(at) ? at : now();
    if (isEnded(rec) && !(t > rec.ended_at)) return false;
    const cur = rec.process;
    const same = cur && cur.pid === pid && (procStart == null || cur.proc_start == null || sameStart(cur.proc_start, procStart));
    let result = false;
    if (same) {
      if (procStart && !cur.proc_start) { cur.proc_start = procStart; result = 'updated'; }
      if (entrypoint && cur.entrypoint !== entrypoint) { cur.entrypoint = entrypoint; result = 'updated'; }
      if (kind && cur.kind !== kind) { cur.kind = kind; result = 'updated'; }
      if (ccVersion && cur.cc_version !== ccVersion) { cur.cc_version = ccVersion; result = 'updated'; }
      if ((LINKED_RANK.get(via) ?? 9) < (LINKED_RANK.get(cur.linked_by) ?? 9)) { cur.linked_by = via; result = 'updated'; }
      // Writing it again after another claim on the pid (an in-place /resume
      // back): the claim is renewed, so it is the process's conversation again,
      // and no longer one it left. (A late hook from before the move renews
      // nothing that matters: its claim is still older than the move's.)
      const owner = ownerOf(pid);
      if (owner !== rec && (!finite(cur.linked_at) || t >= cur.linked_at)) {
        cur.linked_at = t;
        result = 'updated';
        if (cur.left_by && ownerOf(pid) === rec) cur.left_by = null;
      }
      if (isEnded(rec)) { rec.ended_at = null; result = 'updated'; }
    } else {
      rec.process = { pid, proc_start: procStart || null, kind, entrypoint, cc_version: ccVersion, linked_by: via, linked_at: t, left_by: null };
      rec.ended_at = null;
      rec.interrupt = interruptOf(lastMcp.get(pid));
      result = 'moved';
    }
    if (entrypoint) rec.entrypoint = entrypoint;
    if (result) { watchDirty = true; dirtyUrgent = true; }
    return result;
  }

  function newConversation(sid, slug, reason, startedAt, { provisional = false, claim = null, forkedFrom = null, entrypoint = null } = {}) {
    const existing = recordOfSession(sid);
    if (existing) return existing;
    const t = now();
    const started = finite(startedAt) ? startedAt : t;
    const rec = {
      id: sid,
      created_at: t,
      last_activity_at: Math.min(started, t),
      ended_at: null,
      title: null,
      name: null,
      forked_from: forkedFrom && forkedFrom !== sid ? forkedFrom : null,
      current_session_id: sid,
      current_at: started,
      entrypoint: entrypointOf(entrypoint),
      provisional,
      sessions: [{ session_id: sid, slug: slug || null, reason: REASON_SET.has(reason) ? reason : 'start', started_at: started, ended_at: null }],
      process: null,
      hookAt: null,
      interrupt: null,
      off: false,
    };
    convs.set(sid, rec);
    sessionOf.set(sid, sid);
    aliases.delete(sid);
    if (claim) claimProcess(rec, claim);
    queue('added', rec);
    dirtyUrgent = true;
    watchDirty = true;
    return rec;
  }

  // Add a session to a conversation and make it current; the session it follows
  // is marked ended. A session that belongs to another conversation merges the
  // two instead.
  function linkSession(rec, sid, slug, reason, at) {
    const other = recordOfSession(sid);
    if (other === rec) {
      setCurrent(rec, sid, at, reason);
      return rec;
    }
    if (other) return merge(rec, other, { sessionId: sid, reason, at });
    const t = finite(at) ? at : now();
    const prev = rec.current_session_id;
    endSession(rec, prev, t);
    rec.sessions.push({ session_id: sid, slug: slug || null, reason: REASON_SET.has(reason) ? reason : 'clear', started_at: t, ended_at: null });
    sessionOf.set(sid, rec.id);
    rec.current_session_id = sid;
    rec.current_at = t;
    capSessions(rec);
    touchActivity(rec, t);
    queue('linked', rec, { session_id: sid, previous_session_id: prev || null, reason });
    dirtyUrgent = true;
    watchDirty = true; // the session scope gates the watch by the current session
    return rec;
  }

  // The session the process writes now, within one conversation. Evidence older
  // than the last switch is stale (a sessions file read before a hook moved on).
  function setCurrent(rec, sid, at, reason = 'resume') {
    const t = finite(at) ? at : now();
    if (rec.current_session_id === sid) {
      if (reopenSession(rec, sid, t)) { queue('updated', rec); dirtyUrgent = true; }
      return false;
    }
    if (finite(rec.current_at) && t < rec.current_at) return false;
    const prev = rec.current_session_id;
    endSession(rec, prev, t);
    reopenSession(rec, sid, t);
    rec.current_session_id = sid;
    rec.current_at = t;
    queue('linked', rec, { session_id: sid, previous_session_id: prev || null, reason });
    dirtyUrgent = true;
    watchDirty = true;
    return true;
  }

  // A process left this conversation for another session: the session it was
  // writing here is over. The conversation keeps the process as its last one,
  // and `how` it left, when that is known to be a /fork or a /resume
  // (process.left_by): formerNames never joins such a conversation back.
  function leave(rec, at, how = null) {
    if (!rec) return;
    if (endSession(rec, rec.current_session_id, at)) { queue('updated', rec); dirtyUrgent = true; }
    if (LEFT_BY.has(how) && rec.process && rec.process.left_by !== how) {
      rec.process.left_by = how;
      dirtyUrgent = true;
    }
  }

  function olderFirst(a, b) {
    const fa = firstStart(a);
    const fb = firstStart(b);
    if (fa !== fb) return fa < fb ? [a, b] : [b, a];
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? [a, b] : [b, a];
    return a.id < b.id ? [a, b] : [b, a];
  }

  // Two conversations are one chain: the younger merges into the older, which
  // keeps its id (the chain's first session). `sessionId` is the session the
  // evidence says the process is writing now.
  function merge(a, b, { sessionId = null, reason = 'clear', at } = {}) {
    if (a === b) return a;
    const [older, younger] = olderFirst(a, b);
    const prev = older.current_session_id;
    for (const s of younger.sessions) {
      if (sessionEntry(older, s.session_id)) continue;
      older.sessions.push({ ...s, reason: s.session_id === sessionId && REASON_SET.has(reason) ? reason : s.reason });
    }
    older.sessions.sort((x, y) => (x.started_at || 0) - (y.started_at || 0));
    for (const s of older.sessions) sessionOf.set(s.session_id, older.id);
    if (younger.process && (!older.process || claimAt(younger) >= claimAt(older))) {
      older.process = younger.process;
      older.interrupt = younger.interrupt;
    }
    older.ended_at = isEnded(older) && isEnded(younger) ? Math.max(older.ended_at, younger.ended_at) : null;
    older.created_at = Math.min(older.created_at, younger.created_at);
    older.last_activity_at = maxOf(older.last_activity_at, younger.last_activity_at);
    older.hookAt = maxOf(older.hookAt, younger.hookAt);
    if (!older.title) older.title = younger.title;
    if (!older.name) older.name = younger.name;
    if (!older.entrypoint) older.entrypoint = younger.entrypoint;
    if (!older.forked_from && younger.forked_from && younger.forked_from !== older.id) older.forked_from = younger.forked_from;
    older.provisional = older.provisional && younger.provisional;
    const current = sessionId && sessionEntry(older, sessionId) ? sessionId
      : claimAt(younger) >= claimAt(older) ? younger.current_session_id : older.current_session_id;
    if (current !== older.current_session_id) endSession(older, older.current_session_id, at);
    older.current_session_id = current;
    older.current_at = maxOf(older.current_at, finite(at) ? at : younger.current_at);
    reopenSession(older, current, at);
    capSessions(older);
    convs.delete(younger.id);
    remember(aliases, younger.id, older.id, ALIASES_MAX);
    for (const [k, v] of aliases) if (v === younger.id) aliases.set(k, older.id);
    if (fallbackId === younger.id) fallbackId = older.provisional ? older.id : null;
    younger.merged_into = older.id;
    queue('merged', younger, { merged_into: older.id });
    queue('linked', older, { session_id: current, previous_session_id: prev || null, reason: sessionId ? reason : 'merge' });
    dirtyUrgent = true;
    watchDirty = true;
    return older;
  }

  function removeRecord(rec, reason) {
    convs.delete(rec.id);
    for (const s of rec.sessions) {
      if (sessionOf.get(s.session_id) !== rec.id) continue;
      sessionOf.delete(s.session_id);
      arrivals.delete(s.session_id);
    }
    for (const [k, v] of aliases) if (v === rec.id) aliases.delete(k);
    if (fallbackId === rec.id) fallbackId = null;
    if (reason === 'pruned') pendingDeletes.push(...rec.sessions.map((s) => s.session_id));
    queue('removed', rec, { reason });
    if (!rec.provisional) dirtyUrgent = true;
    watchDirty = true;
  }

  // A hook or a sessions file named `sid`: the fallback's guess is confirmed (the
  // same session) or dropped (any other).
  function named(sid) {
    if (!fallbackId) return;
    const rec = convs.get(fallbackId);
    if (!rec) { fallbackId = null; return; }
    fallbackId = null;
    if (sessionEntry(rec, sid)) {
      rec.provisional = false;
      queue('updated', rec);
      dirtyUrgent = true;
      watchDirty = true;
      return;
    }
    removeRecord(rec, 'fallback');
  }

  function noteName(rec, name) {
    if (name == null) return;
    const clean = cleanText(name);
    if (clean && clean !== rec.name) { rec.name = clean; queue('updated', rec); dirtyUrgent = true; }
  }

  // ── hooks ──
  function refuse(why) {
    counters.ignored[why] = (counters.ignored[why] || 0) + 1;
    return { ok: false, ignored: why };
  }

  function ingest(env) {
    try {
      return ingestEnvelope(env);
    } catch (e) {
      say('conversations: ingest failed:', e && e.message);
      return refuse('error');
    }
  }

  function ingestEnvelope(env) {
    if (stopped) return refuse('stopped');
    if (!toggleChecked) applyToggle(checkToggle()); // an envelope before start()
    if (!enabledState.enabled) return refuse('disabled');
    ensureLoaded();
    if (!isPlain(env) || !validSessionId(env.session_id)) return refuse('bad-envelope');
    const sid = env.session_id;
    if (!ownsCwd(env.cwd)) return refuse('foreign-root');
    const slug = transcriptSlug(env.transcript_path, sid);
    if (!slug) return refuse('bad-path');
    if (!sessionEnabled(sid)) return refuse('session-disabled');
    const t = now();
    const ts = finite(env.ts) ? env.ts : t;
    const event = typeof env.event === 'string' ? env.event : '';
    const pid = validPid(env.claude_pid) ? env.claude_pid : null;
    const entrypoint = entrypointOf(env.entrypoint);
    const source = isPlain(env.session) && typeof env.session.source === 'string' ? env.session.source : null;
    counters.ingested += 1;
    lastHookAt = maxOf(lastHookAt, t);
    mutate(() => {
      let rec = event === 'SessionStart' ? sessionStart(sid, slug, ts, pid, entrypoint, source) : recordOfSession(sid);
      if (!rec) rec = newConversation(sid, slug, 'start', ts, { claim: pid ? { pid, via: 'hook', at: ts, entrypoint } : null, entrypoint });
      if (event === 'SessionEnd') sessionEnd(rec, sid, ts);
      touchFromHook(recordOfSession(sid) || rec, sid, slug, ts, pid, entrypoint);
      named(sid);
    });
    if (event === 'SessionStart' || event === 'SessionEnd') requestDiscovery();
    const cid = sessionOf.get(sid);
    return cid ? { ok: true, conversation_id: cid, session_id: sid } : refuse('error');
  }

  // How a process arrived at a session, newest first: a SessionStart's source
  // (`hook`, which also dates the session's newest start for SessionEnd), or a
  // resume the sessions file saw happen. Older evidence never overwrites newer
  // (async hooks arrive out of order).
  function noteArrival(sid, source, pid, at, { hook = false } = {}) {
    const prev = arrivals.get(sid);
    const next = prev ? { ...prev } : { start_ts: null, source: null, pid: null, at: null };
    if (hook && finite(at)) next.start_ts = maxOf(next.start_ts, at);
    if (source && (!finite(next.at) || !finite(at) || at >= next.at)) {
      next.source = source;
      next.pid = validPid(pid) ? pid : null;
      next.at = finite(at) ? at : now();
    }
    remember(arrivals, sid, next, ARRIVALS_MAX);
  }

  // Claim the process for a conversation and say so: 'linked' when it moved
  // there (reason 'resume' when another process wrote it before, 'process' where
  // none had: then no session precedes it, so `previous_session_id` is null),
  // 'updated' when only a field of it changed.
  function claimFor(rec, sid, claim, previous) {
    const had = rec.process !== null;
    const moved = claimProcess(rec, claim);
    if (moved === 'moved') {
      queue('linked', rec, had
        ? { session_id: sid, previous_session_id: previous || null, reason: 'resume' }
        : { session_id: sid, previous_session_id: null, reason: 'process' });
    } else if (moved === 'updated') {
      queue('updated', rec);
    }
    return moved;
  }

  function sessionStart(sid, slug, ts, pid, entrypoint, source) {
    // `compact` starts nothing: it only dates the session's newest start.
    const reason = source === 'compact' ? null : SOURCE_REASON[source] || 'start';
    noteArrival(sid, reason, pid, ts, { hook: true });
    clearPending(sid); // the SessionStart a sessions-file switch was waiting on
    const claim = pid ? { pid, via: 'hook', at: ts, entrypoint } : null;
    let rec = recordOfSession(sid);
    if (reason === null) return rec || newConversation(sid, slug, 'start', ts, { claim, entrypoint });
    // The conversation this process was writing before this start, if any.
    const before = pid ? ownerOf(pid, { except: rec }) : null;
    if (rec) {
      if (reason === 'clear' && before && before !== rec) return linkSession(before, sid, slug, 'clear', ts);
      if (reason === 'fork' && before && before !== rec && !rec.forked_from) {
        rec.forked_from = before.id;
        leave(before, ts, 'fork');
        queue('updated', rec);
      } else if ((reason === 'resume' || reason === 'fork') && before && before !== rec) {
        leave(before, ts, reason);
      }
      if (claim) claimFor(rec, sid, claim, rec.current_session_id);
      setCurrent(rec, sid, ts, 'resume');
      return rec;
    }
    switch (reason) {
      case 'clear':
        if (before) return linkSession(before, sid, slug, 'clear', ts);
        return newConversation(sid, slug, 'clear', ts, { claim, entrypoint });
      case 'fork':
        // An in-place /fork: the process was writing `before`.
        rec = newConversation(sid, slug, 'fork', ts, { claim, entrypoint, forkedFrom: before ? before.id : null });
        if (before) leave(before, ts, 'fork');
        return rec;
      case 'resume':
        rec = newConversation(sid, slug, 'resume', ts, { claim, entrypoint });
        if (before) leave(before, ts, 'resume');
        return rec;
      default:
        return newConversation(sid, slug, 'start', ts, { claim, entrypoint });
    }
  }

  // SessionEnd marks the SESSION ended, never the conversation (§2.2). One older
  // than the session's newest SessionStart is stale (it ended before a resume).
  function sessionEnd(rec, sid, ts) {
    const started = (arrivals.get(sid) || {}).start_ts;
    if (finite(started) && ts < started) return;
    if (endSession(rec, sid, ts)) { queue('updated', rec); dirtyUrgent = true; }
  }

  // The envelope's entrypoint, with or without a pid (CLAUDE_PID is best
  // effort, V14): a `claude -p` is headless whichever of them carries it.
  function noteEntrypoint(rec, entrypoint) {
    if (!entrypoint || rec.entrypoint === entrypoint) return;
    const was = isHeadless(rec);
    rec.entrypoint = entrypoint;
    dirtyUrgent = true;
    if (isHeadless(rec) !== was) queue('updated', rec);
  }

  function touchFromHook(rec, sid, slug, ts, pid, entrypoint) {
    rec.hookAt = maxOf(rec.hookAt, now());
    touchActivity(rec, ts);
    const s = sessionEntry(rec, sid);
    if (s && s.slug !== slug) { s.slug = slug; dirtyUrgent = true; }
    noteEntrypoint(rec, entrypoint);
    if (!pid) return;
    // A process is linked from a hook only where none is (or the one there has
    // ended: a resume whose SessionStart was missed). A second process on a live
    // conversation moves it only through a SessionStart.
    if (!rec.process || isEnded(rec) || rec.process.pid === pid) {
      const moved = claimProcess(rec, { pid, via: 'hook', at: ts, entrypoint });
      if (moved === 'moved') queue('linked', rec, { session_id: rec.current_session_id, previous_session_id: null, reason: 'process' });
      else if (moved === 'updated') queue('updated', rec);
    }
  }

  // ── the sessions file: a live process says which session it is writing ──
  //
  // A record is dated by its own updatedAt (Claude Code rewrites the file, and
  // that field, when the process switches session), and one older than the
  // hook that last moved the process or the conversation's current session is
  // stale: the file has not caught up. A record with no date is trusted to move
  // anything only when `fresh`: read because the file just changed under
  // claude-state's watch, so the change itself dates it. One read on a
  // discovery tick, or at the watch's start, never moves a conversation back.
  function noteRecord(pid, st, { via, fresh = false, settled = false }) {
    const sid = st.sessionId;
    const slug = slugOfCwd(st.cwd);
    const t = now();
    const dated = finite(st.updatedAt);
    const at = dated ? Math.min(st.updatedAt, t) : t;
    const claim = { pid, procStart: st.procStart, via, at, entrypoint: st.entrypoint, kind: st.kind, ccVersion: st.version };
    const ownerNow = () => ownerOf(pid, { procStart: st.procStart });
    named(sid);
    // A switch to this session already waits on its SessionStart: nothing it
    // would join is decided before that comes, or the grace runs out.
    const waiting = !settled && pendingClear.has(sid);
    let rec = recordOfSession(sid);
    if (rec) {
      // A /clear session met before its process was known (its SessionStart
      // said clear and gave no pid): it continues the conversation the process
      // was writing.
      const owner = ownerNow();
      if (owner && owner !== rec && !rec.process && rec.sessions[0] && rec.sessions[0].reason === 'clear') {
        rec = merge(rec, owner, { sessionId: sid, reason: 'clear', at });
      }
      const former = formerJoins(pid, st, rec, ownerNow(), settled);
      if (waiting || former.wait) deferSwitch(sid, pid, st, via);
      else for (const r of former.joins) rec = merge(rec, r, { sessionId: sid, reason: 'clear', at });
      // The process is writing another conversation than the one it was: an
      // in-place /resume (or a switch whose SessionStart is due). Unless the
      // record is older than that conversation's claim (a hook already moved
      // the process on, and the file has not caught up), which moves nothing.
      const cur = ownerNow();
      const moving = !!cur && cur !== rec;
      const timely = dated ? !moving || at >= claimAt(cur) : fresh;
      if (moving && !timely) return rec;
      if (moving) {
        leave(cur, at, former.resumed ? 'resume' : null);
        if (former.resumed) noteArrival(sid, 'resume', pid, at);
      }
      claimFor(rec, sid, claim, rec.current_session_id);
      if (timely) setCurrent(rec, sid, at, 'resume');
      if (ownerOf(pid) === rec) noteName(rec, st.name);
      if (dated) touchActivity(rec, st.updatedAt);
      return rec;
    }
    if (!sessionEnabled(sid)) return null;
    const owner = ownerNow();
    const former = formerJoins(pid, st, null, owner, settled);
    if (former.resumed) {
      // A session older than one the process had before: a /resume of one this
      // registry never knew, never a /clear. A conversation of its own, which
      // the process moves to; unless the record is older than the process's
      // claim (the file has not caught up with the hook that moved it), which
      // moves nothing.
      if (owner && !(dated ? at >= claimAt(owner) : fresh)) return owner;
      if (owner) leave(owner, at, 'resume');
      noteArrival(sid, 'resume', pid, at);
      rec = newConversation(sid, slug, 'resume', fileStart(slug, sid) || at, { claim, entrypoint: st.entrypoint });
      noteName(rec, st.name);
      return rec;
    }
    let wait = waiting || former.wait;
    let target = null;
    if (!wait) for (const r of former.joins) target = target ? merge(target, r, { at }) : r;
    if (!wait && !target && owner) {
      // The process switched to a session no hook has named. While hooks flow
      // for its conversation, the SessionStart that says what the switch was is
      // on its way: wait for it, and take the switch for a /clear only without
      // one.
      if (!settled && owner.hookAt !== null && clearGraceMs > 0) wait = true;
      else target = owner;
    }
    if (wait) {
      deferSwitch(sid, pid, st, via);
      return owner;
    }
    if (target) {
      linkFormer(target, st, slug);
      rec = linkSession(target, sid, slug, 'clear', fileStart(slug, sid) || at);
      claimFor(rec, sid, claim, null);
      noteName(rec, st.name);
      return rec;
    }
    // Nothing links it: a conversation of its own. The process's first session
    // started with the process.
    const first = !(st.formerNames && st.formerNames.length);
    const started = fileStart(slug, sid) || (first && finite(st.startedAt) ? st.startedAt : at);
    rec = newConversation(sid, slug, 'start', started, { claim, entrypoint: st.entrypoint });
    noteName(rec, st.name);
    return rec;
  }

  // ── formerNames: a hint, never proof ──
  //
  // Which conversations a sessions file's formerNames joins to the current
  // session's chain. §2.2 makes it a hint for a /clear missed while the daemon
  // was down: a process also leaves a session by /resume and /fork, and its
  // hooks say which, so a former session's conversation joins only when nothing
  // the registry knows says a step between them was no /clear:
  //   * how the process came to the current session (`arrivals`: its newest
  //     SessionStart, or a resume a sessions file saw happen). From this
  //     process, or from an envelope that gave no pid, anything but a /clear
  //     joins nothing; from another process, this one can only have resumed
  //     it. The session's own entry says the same when it began as a fork or as
  //     a resumed session;
  //   * the conversation holding the current session has a process and is not
  //     the one this process writes now (another's, or one it left): it came
  //     back to it by a resume;
  //   * the current session is older than one the process had before it: a
  //     /clear always makes a new session, so this one was resumed;
  //   * a former session's conversation is passed over when another live
  //     process writes it, when this process left it by a /fork or a /resume
  //     (process.left_by), or when it was forked from the chain or the chain
  //     from it (forked_from).
  // → { joins, resumed, wait }. `resumed`: the evidence says the process
  // resumed the current session (a move into it is a resume, and is remembered
  // as one). `wait`: hooks flow and no SessionStart for the session has been
  // seen, so the one on its way, which outranks the file, decides first.
  function formerJoins(pid, st, rec, owner, settled) {
    const sid = st.sessionId;
    const out = { joins: [], resumed: false, wait: false };
    const arrival = arrivals.get(sid);
    const arrived = !!(arrival && arrival.source);
    if (arrived) {
      if (arrival.pid !== null && arrival.pid !== pid) { out.resumed = true; return out; }
      if (arrival.source !== 'clear') { out.resumed = arrival.source === 'resume'; return out; }
    }
    const entry = rec ? sessionEntry(rec, sid) : null;
    if (entry && entry.reason === 'fork') return out;
    if (entry && entry.reason === 'resume') { out.resumed = true; return out; }
    if (rec && rec.process && (owner !== rec || !isProcess(rec, pid, st.procStart))) { out.resumed = true; return out; }
    // The sessions the process had before this one, where the registry has them.
    const before = [];
    for (const f of st.formerNames || []) {
      const r = recordOfSession(f.sessionId);
      const e = r ? sessionEntry(r, f.sessionId) : null;
      if (e) before.push(e);
    }
    if (owner && owner !== rec) {
      const e = sessionEntry(owner, owner.current_session_id);
      if (e) before.push(e);
    }
    const born = entry ? entry.started_at : fileStart(slugOfCwd(st.cwd), sid);
    if (finite(born) && before.some((e) => finite(e.started_at) && e.started_at > born)) {
      out.resumed = true;
      return out;
    }
    const base = rec || owner;
    for (const f of st.formerNames || []) {
      const r = recordOfSession(f.sessionId);
      if (!r || r === rec || out.joins.includes(r)) continue;
      if (r.process && !isProcess(r, pid, st.procStart)) {
        if (!isEnded(r)) continue; // another live process writes it
      } else if (r.process && r.process.left_by) {
        continue; // this process left it by a /fork or a /resume
      }
      if ((base && base !== r && forkLinked(r, base)) || out.joins.some((j) => forkLinked(r, j))) continue;
      out.joins.push(r);
    }
    out.wait = out.joins.length > 0 && !settled && clearGraceMs > 0 && !arrived
      && [owner, rec, ...out.joins].some((r) => r && r.hookAt !== null);
    return out;
  }

  // The former sessions the daemon never saw that follow the chain's known ones
  // (formerNames, oldest first): linked too, when their transcript exists.
  function linkFormer(target, st, slug) {
    let after = false;
    for (const f of st.formerNames || []) {
      if (f.sessionId === st.sessionId) continue;
      const r = recordOfSession(f.sessionId);
      if (r) { after = r === target; continue; }
      if (!after) continue;
      const started = fileStart(slug, f.sessionId);
      if (started === null || !sessionEnabled(f.sessionId)) continue;
      linkSession(target, f.sessionId, slug, 'clear', started);
    }
  }

  // A switch the sessions file shows, waiting for the SessionStart that says
  // what it was (a /clear, an in-place /fork or /resume): one for `sid` within
  // clearGraceMs cancels the wait and decides (sessionStart → clearPending).
  // Without one, the process's file is read again: still naming `sid` under the
  // same start, the record is noted as settled, so its link is made as a /clear
  // whose SessionStart was missed; naming another session, the read that showed
  // that one decides instead.
  function deferSwitch(sid, pid, st, via) {
    if (pendingClear.has(sid) || stopped) return;
    const myGen = gen;
    const procStart = st.procStart;
    const timer = setT(() => {
      const pending = pendingClear.get(sid);
      if (!pending || pending.timer !== timer) return;
      pendingClear.delete(sid);
      if (stopped || myGen !== gen || !enabledState.enabled) return;
      const again = safeRead(pid);
      if (!again || again.sessionId !== sid || again.procStart !== procStart) return;
      mutate(() => { noteRecord(pid, again, { via, settled: true }); });
    }, clearGraceMs);
    pendingClear.set(sid, { timer, pid });
  }
  function clearPending(sid) {
    const pending = pendingClear.get(sid);
    if (!pending) return;
    clearT(pending.timer);
    pendingClear.delete(sid);
  }

  // What claude-state read from a linked process's file. A first read reports
  // what the file held when the watch began, which may predate the hook that
  // linked the process here: no change seen happening, so not fresh.
  function onStateRecord(cid, pid, st, info) {
    if (stopped || !enabledState.enabled) return;
    const fresh = !(info && info.first);
    mutate(() => {
      const rec = convs.get(cid);
      if (!rec || isEnded(rec) || !rec.process || rec.process.pid !== pid) return;
      // A file another process wrote (the pid was reused): not this conversation's.
      if (st && rec.process.proc_start && st.procStart && !sameStart(rec.process.proc_start, st.procStart)) return;
      // The process is linked already, by whatever linked it: the watch on its
      // file says what it writes, not how it belongs to this project.
      if (st && validSessionId(st.sessionId)) noteRecord(pid, st, { via: rec.process.linked_by, fresh });
      const still = convs.get(cid);
      if (still && ownerOf(pid) === still) queueState(cid, st);
    });
  }

  // ── the watches: only the conversation a process writes now hears its file ──
  // (and not while that conversation's current session is switched off: what
  // the process does in a session the user switched off is not mirrored).
  function syncWatches() {
    if (!watchDirty) return;
    watchDirty = false;
    const want = new Map(); // conversation id → pid
    if (enabledState.enabled && !stopped) {
      for (const [pid, rec] of owners()) if (sessionEnabled(rec.current_session_id)) want.set(rec.id, pid);
    }
    const have = new Map(claudeState.linked().map((e) => [e.cid, e.pid]));
    for (const [cid, pid] of have) {
      if (want.get(cid) === pid) continue;
      const described = claudeState.recordOf(cid) !== null;
      track(claudeState.unlink(cid));
      if (described && convs.has(cid)) queueState(cid, null); // the file no longer describes this conversation
    }
    for (const [cid, pid] of want) {
      if (have.get(cid) !== pid) track(claudeState.link(cid, pid));
    }
  }

  // ── discovery ──
  function requestDiscovery() {
    if (stopped || !enabledState.enabled || discoverTimer !== null) return;
    discoverTimer = setT(() => {
      discoverTimer = null;
      discover().catch(() => {});
    }, 0);
  }

  // Resolves after a discovery that began after the call has finished.
  function discover() {
    if (stopped || !enabledState.enabled) return Promise.resolve();
    if (running) {
      if (!followUp) {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        followUp = { promise, resolve };
      }
      return followUp.promise;
    }
    return startDiscovery();
  }
  function startDiscovery() {
    running = runDiscovery()
      .catch((e) => say('conversations: discovery failed:', e && e.message))
      .then(() => {
        running = null;
        const waiting = followUp;
        followUp = null;
        if (!waiting) return;
        if (stopped || !enabledState.enabled) { waiting.resolve(); return; }
        startDiscovery().then(waiting.resolve, waiting.resolve);
      });
    return running;
  }

  function safeRead(pid) {
    try { return readSessionState({ pid }); } catch { return null; }
  }
  const deadKey = (pid, procStart) => `${pid}\0${procStart}`;

  async function runDiscovery() {
    const myGen = gen;
    ensureLoaded();
    counters.discoveries += 1;
    // (3) the presence rows: Claude Code processes attached to this root
    let rows = [];
    try { rows = mcpSessionsFor(rootAbs) || []; } catch { rows = []; }
    const mcp = new Map();
    for (const row of Array.isArray(rows) ? rows : []) if (isPlain(row) && validPid(row.ppid)) mcp.set(row.ppid, row);
    // (2) the sessions files whose cwd is here, or whose process a row vouches for
    let pids = [];
    try { pids = listSessionPids() || []; } catch { pids = []; }
    const found = [];
    for (const pid of pids) {
      if (!validPid(pid)) continue;
      const st = safeRead(pid);
      if (!st || !validSessionId(st.sessionId)) continue;
      if (st.procStart && deadProcs.has(deadKey(pid, st.procStart))) continue; // a verdict said: not this process
      const mine = ownsCwd(st.cwd);
      if (!mine && !mcp.has(pid)) continue;
      found.push({ pid, procStart: st.procStart, mine });
    }
    // One sample for every pid whose process is not already linked as it is.
    const need = found.filter((f) => f.procStart && !linkedAs(f.pid, f.procStart)).map((f) => f.pid);
    let sample = new Map();
    if (need.length) {
      try { sample = await sampleProcs(need); } catch { sample = null; }
      if (!(sample instanceof Map)) sample = new Map();
    }
    if (stopped || myGen !== gen || !enabledState.enabled) return;
    const t = now();
    mutate(() => {
      lastMcp = mcp;
      let live = 0;
      for (const f of found) {
        // Read again: a hook may have moved the process on while ps ran.
        const st = safeRead(f.pid);
        if (!st || !validSessionId(st.sessionId) || st.procStart !== f.procStart) continue;
        let verdict = null;
        if (linkedAs(f.pid, st.procStart)) verdict = true;
        else if (st.procStart) {
          try { verdict = isPidAlive(f.pid, { startedAt: st.procStart, sample }); } catch { verdict = null; }
        }
        if (verdict === false) {
          // Gone, or another process holds the pid: for good, so this file is
          // not sampled again (a new process on the pid writes another start).
          if (st.procStart) remember(deadProcs, deadKey(f.pid, st.procStart), true, CACHE_MAX);
          continue;
        }
        if (verdict !== true && !mcp.has(f.pid)) continue; // no verdict, and no row vouches
        if (!sessionEnabled(st.sessionId)) continue;
        live += 1;
        noteRecord(f.pid, st, { via: verdict === true && f.mine ? 'sessions-file' : 'mcp' });
      }
      refreshInterrupts(mcp);
      refreshSessionScope();
      if (live === 0 && !(finite(lastHookAt) && t - lastHookAt <= FALLBACK_WINDOW_MS)) fallback(t);
    });
    claudeState.retune();
  }

  function refreshInterrupts(mcp) {
    for (const rec of convs.values()) {
      if (isEnded(rec) || !rec.process) continue;
      const v = interruptOf(mcp.get(rec.process.pid));
      if (v !== rec.interrupt) { rec.interrupt = v; queue('updated', rec); }
    }
  }

  // The session scope, again for every conversation (§2.2: a disabled session
  // is never tailed). A session switched off after it was linked is no longer
  // handed out (transcriptPath, sessionDir), and while it is a conversation's
  // current session its process's file is not watched (syncWatches); switched
  // back on, both come back. Either change is an 'updated' event, so a source
  // asks again.
  function refreshSessionScope() {
    for (const rec of convs.values()) {
      if (rec.provisional) continue;
      const off = !sessionEnabled(rec.current_session_id);
      if (off === rec.off) continue;
      rec.off = off;
      watchDirty = true;
      queue('updated', rec);
    }
  }

  // (4) Exactly one transcript in this project's directory changed recently.
  function fallback(t) {
    if (fallbackId && convs.has(fallbackId)) return;
    let dir = null;
    try { dir = userClaudePaths().projectDir(rootReal); } catch { dir = null; }
    if (!dir) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    if (names.length > FALLBACK_SCAN_MAX) return;
    let pick = null;
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sid = name.slice(0, -'.jsonl'.length);
      if (!validSessionId(sid)) continue;
      let st;
      try { st = fs.lstatSync(path.join(dir, name)); } catch { continue; }
      if (!st.isFile() || t - st.mtimeMs > FALLBACK_WINDOW_MS) continue;
      if (pick) return; // more than one: no guess
      pick = { sid, started: finite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs };
    }
    if (!pick || recordOfSession(pick.sid) || !sessionEnabled(pick.sid)) return;
    const slug = path.basename(dir);
    const rec = newConversation(pick.sid, SLUG_RE.test(slug) ? slug : null, 'start', pick.started, { provisional: true });
    fallbackId = rec.id;
  }

  // ── the verdicts and the evidence other sources hand in ──
  function processGone(cid, { at, pid } = {}) {
    if (stopped || !enabledState.enabled) return false;
    return mutate(() => {
      const rec = recordOf(cid);
      if (!rec || isEnded(rec) || !rec.process) return false;
      if (validPid(pid) && rec.process.pid !== pid) return false; // a process it has left
      const t = finite(at) ? at : now();
      rec.ended_at = t;
      for (const s of rec.sessions) if (!finite(s.ended_at)) s.ended_at = t;
      // A switch of the gone process's that waits on its SessionStart waits on nothing.
      for (const [sid, pending] of [...pendingClear]) if (pending.pid === rec.process.pid) clearPending(sid);
      queue('ended', rec, { at: t });
      dirtyUrgent = true;
      watchDirty = true;
      return true;
    });
  }

  // The transcripts source's evidence of a fork: the session's first turns
  // already belong to `forked_from` (V14).
  function markFork(cid, { forked_from: from } = {}) {
    if (stopped || !enabledState.enabled) return false;
    return mutate(() => {
      const rec = recordOf(cid);
      const src = recordOf(from);
      if (!rec || !src || src === rec || rec.forked_from) return false;
      rec.forked_from = src.id;
      if (rec.sessions[0] && rec.sessions[0].reason === 'start') rec.sessions[0].reason = 'fork';
      queue('updated', rec);
      dirtyUrgent = true;
      return true;
    });
  }

  // The conversation's title as the meta source computed it, kept for the
  // switcher across a restart. No event: the model already has it.
  function noteTitle(cid, title) {
    const rec = recordOf(cid);
    if (!rec) return false;
    const clean = cleanText(title);
    if (!clean || clean === rec.title) return false;
    rec.title = clean;
    dirtyActivity = true;
    scheduleSave();
    return true;
  }

  // Progress from another source (a transcript append): the prune order.
  function noteActivity(cid, at) {
    const rec = recordOf(cid);
    if (!rec) return;
    touchActivity(rec, at);
    scheduleSave();
  }

  // ── persistence ──
  function serializeRecord(rec) {
    return {
      id: rec.id,
      created_at: rec.created_at,
      last_activity_at: rec.last_activity_at,
      ended_at: isEnded(rec) ? rec.ended_at : null,
      title: rec.title,
      name: rec.name,
      forked_from: rec.forked_from,
      current_session_id: rec.current_session_id,
      entrypoint: rec.entrypoint,
      sessions: rec.sessions.map((s) => ({
        session_id: s.session_id, slug: s.slug, reason: s.reason, started_at: s.started_at,
        ended_at: finite(s.ended_at) ? s.ended_at : null,
      })),
      process: rec.process ? {
        pid: rec.process.pid, proc_start: rec.process.proc_start, kind: rec.process.kind,
        entrypoint: rec.process.entrypoint, cc_version: rec.process.cc_version,
        linked_by: rec.process.linked_by, linked_at: rec.process.linked_at,
        left_by: rec.process.left_by || null,
      } : null,
    };
  }

  function save() {
    if (saveTimer !== null) { clearT(saveTimer); saveTimer = null; saveDue = null; }
    if (!loaded) return false;
    const list = [];
    for (const rec of convs.values()) if (!rec.provisional) list.push(serializeRecord(rec));
    let ok = true;
    try {
      fsjson.writeJsonAtomic(p.mirrorConversations, { v: FILE_VERSION, conversations: list }, { pretty: 0, newline: true });
      dirtyUrgent = false;
      dirtyActivity = false;
    } catch (e) {
      ok = false;
      say('conversations: cannot write conversations.json:', e && e.message);
    }
    deletePruned();
    return ok;
  }

  function scheduleSave() {
    if (stopped || !loaded || (!dirtyUrgent && !dirtyActivity && !pendingDeletes.length)) return;
    const due = now() + (dirtyUrgent || pendingDeletes.length ? 0 : activitySaveMs);
    if (saveTimer !== null && saveDue !== null && saveDue <= due) return;
    if (saveTimer !== null) clearT(saveTimer);
    saveDue = due;
    saveTimer = setT(() => { saveTimer = null; saveDue = null; save(); }, Math.max(0, due - now()));
  }

  function flush() {
    if (loaded && (dirtyUrgent || dirtyActivity || pendingDeletes.length || saveTimer !== null)) save();
    return Promise.resolve();
  }

  // A pruned conversation's per-session turn index and the per-turn diffs it
  // names (§2.11): derivable state nobody will read again.
  function deletePruned() {
    const list = pendingDeletes;
    pendingDeletes = [];
    for (const sid of list) {
      if (sessionOf.has(sid)) continue; // it came back meanwhile
      const index = p.mirrorIndex(sid);
      if (!index) continue;
      const got = fsjson.readJson(index);
      if (got.ok && isPlain(got.value) && Array.isArray(got.value.turns)) {
        for (const turn of got.value.turns) {
          const diff = isPlain(turn) && typeof turn.id === 'string' ? p.mirrorDiff(turn.id) : null;
          if (diff) { try { fs.unlinkSync(diff); } catch { /* already gone */ } }
        }
      }
      try { fs.unlinkSync(index); } catch { /* already gone */ }
    }
  }

  function pruneIfNeeded() {
    if (convs.size <= maxConversations) return;
    const all = [];
    for (const rec of convs.values()) if (!rec.provisional) all.push(rec);
    if (all.length <= maxConversations) return;
    all.sort((a, b) => (isInactive(b) - isInactive(a)) || (a.last_activity_at - b.last_activity_at) || (a.id < b.id ? -1 : 1));
    for (const rec of all.slice(0, all.length - maxConversations)) removeRecord(rec, 'pruned');
  }

  // One persisted conversation, checked field by field (the file lives in the
  // project, where anything can be written into it), or null.
  function parseRecord(raw) {
    if (!isPlain(raw) || !validSessionId(raw.id)) return null;
    const t = now();
    const sessions = [];
    const seen = new Set();
    for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
      if (sessions.length >= SESSIONS_MAX) break;
      if (!isPlain(s) || !validSessionId(s.session_id) || seen.has(s.session_id)) continue;
      seen.add(s.session_id);
      sessions.push({
        session_id: s.session_id,
        slug: typeof s.slug === 'string' && SLUG_RE.test(s.slug) ? s.slug : null,
        reason: REASON_SET.has(s.reason) ? s.reason : 'start',
        started_at: finite(s.started_at) ? s.started_at : null,
        ended_at: finite(s.ended_at) ? s.ended_at : null,
      });
    }
    if (!sessions.length) return null;
    const created = finite(raw.created_at) ? raw.created_at : t;
    for (const s of sessions) if (s.started_at === null) s.started_at = created;
    const pr = isPlain(raw.process) && validPid(raw.process.pid) ? {
      pid: raw.process.pid,
      proc_start: procStartOf(raw.process.proc_start),
      kind: wordOf(raw.process.kind),
      entrypoint: entrypointOf(raw.process.entrypoint),
      cc_version: versionOf(raw.process.cc_version),
      linked_by: LINKED_RANK.has(raw.process.linked_by) ? raw.process.linked_by : 'hook',
      linked_at: finite(raw.process.linked_at) ? raw.process.linked_at : created,
      left_by: LEFT_BY.has(raw.process.left_by) ? raw.process.left_by : null,
    } : null;
    const current = sessions.some((s) => s.session_id === raw.current_session_id) ? raw.current_session_id
      : sessions[sessions.length - 1].session_id;
    const text = (v) => (typeof v === 'string' && v.length > 0 && v.length <= TEXT_MAX ? v : null);
    return {
      id: raw.id,
      created_at: created,
      last_activity_at: finite(raw.last_activity_at) ? raw.last_activity_at : created,
      ended_at: finite(raw.ended_at) ? raw.ended_at : null,
      title: text(raw.title),
      name: text(raw.name),
      forked_from: validSessionId(raw.forked_from) && raw.forked_from !== raw.id ? raw.forked_from : null,
      current_session_id: current,
      current_at: (sessions.find((s) => s.session_id === current) || {}).started_at || created,
      entrypoint: entrypointOf(raw.entrypoint) || (pr ? pr.entrypoint : null),
      provisional: false,
      sessions,
      process: pr,
      hookAt: null,
      interrupt: null,
      off: false,
    };
  }

  function ensureLoaded() {
    if (loaded || stopped || !enabledState.enabled) return;
    loaded = true;
    mutate(() => {
      const file = p.mirrorConversations;
      const got = fsjson.readJson(file, { validate: (d) => isPlain(d) && d.v === FILE_VERSION && Array.isArray(d.conversations) });
      if (got.corrupt || got.invalid) {
        try {
          fsjson.renameAside(file, { tag: got.corrupt ? 'corrupt' : 'invalid', keep: 3 });
        } catch (e) {
          say('conversations: cannot set conversations.json aside:', e && e.message);
        }
        say(`conversations: conversations.json was ${got.corrupt ? 'unreadable' : 'not a conversation list'}; set aside, rebuilding by discovery`);
        dirtyUrgent = true;
        return;
      }
      if (!got.ok) return;
      const kept = [];
      const claimed = new Set();
      for (const raw of got.value.conversations) {
        const rec = parseRecord(raw);
        if (!rec || kept.some((k) => k.id === rec.id)) continue;
        // A session another record already holds stays there.
        rec.sessions = rec.sessions.filter((s) => !claimed.has(s.session_id));
        if (!rec.sessions.length) continue;
        if (!sessionEntry(rec, rec.current_session_id)) rec.current_session_id = rec.sessions[rec.sessions.length - 1].session_id;
        for (const s of rec.sessions) claimed.add(s.session_id);
        kept.push(rec);
      }
      // Over the bound (a file from a build with a larger one, or edited): the
      // conversations nobody writes, oldest activity first, go before they are
      // ever announced, with their index and diff files.
      if (kept.length > maxConversations) {
        kept.sort((a, b) => (isInactive(b) - isInactive(a)) || (a.last_activity_at - b.last_activity_at) || (a.id < b.id ? -1 : 1));
        for (const rec of kept.splice(0, kept.length - maxConversations)) pendingDeletes.push(...rec.sessions.map((s) => s.session_id));
        dirtyUrgent = true;
      }
      for (const rec of kept) {
        convs.set(rec.id, rec);
        for (const s of rec.sessions) sessionOf.set(s.session_id, rec.id);
        queue('added', rec, { restored: true });
      }
      watchDirty = true;
    });
  }

  // ── the toggle ──
  function checkToggle() {
    let d = null;
    try { d = resolveToggle({ cwd: rootAbs, scopes: ['user', 'project'] }); } catch { d = null; }
    return d && d.enabled === false ? { enabled: false, scope: d.by || null } : { enabled: true };
  }
  function notifyToggle(state) {
    if (typeof onToggle !== 'function') return;
    try { onToggle({ ...state }); } catch (e) { say('conversations: onToggle threw:', e && e.message); }
  }
  function applyToggle(d) {
    toggleChecked = true;
    if (d.enabled === enabledState.enabled) {
      enabledState = d;
      return;
    }
    if (!d.enabled) {
      if (loaded) save(); // keep the files; drop what is in memory
      gen += 1;
      enabledState = d;
      if (discoverTimer !== null) { clearT(discoverTimer); discoverTimer = null; }
      if (saveTimer !== null) { clearT(saveTimer); saveTimer = null; saveDue = null; }
      for (const sid of [...pendingClear.keys()]) clearPending(sid);
      for (const { cid } of claudeState.linked()) track(claudeState.unlink(cid));
      convs.clear();
      sessionOf.clear();
      aliases.clear();
      arrivals.clear();
      cwdCache.clear();
      pathCache.clear();
      sessionToggle.clear();
      deadProcs.clear();
      lastMcp = new Map();
      fallbackId = null;
      lastHookAt = null;
      events = [];
      pendingDeletes = [];
      dirtyUrgent = false;
      dirtyActivity = false;
      watchDirty = false;
      loaded = false;
      notifyToggle(d);
      return;
    }
    enabledState = d;
    notifyToggle(d);
    ensureLoaded();
  }

  async function tick() {
    if (stopped) return;
    applyToggle(checkToggle());
    if (!enabledState.enabled) return;
    await discover();
  }

  function armTick() {
    if (stopped || tickTimer !== null) return;
    tickTimer = setT(() => {
      tickTimer = null;
      tick().catch((e) => say('conversations: tick failed:', e && e.message)).finally(() => armTick());
    }, discoveryMs);
  }

  // ── lifecycle ──
  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (stopped) return;
      applyToggle(checkToggle());
      if (enabledState.enabled) {
        ensureLoaded();
        await discover();
      }
      armTick();
    })().catch((e) => say('conversations: start failed:', e && e.message));
    return startPromise;
  }

  async function stop() {
    if (!stopped) {
      stopped = true;
      gen += 1;
      if (tickTimer !== null) { clearT(tickTimer); tickTimer = null; }
      if (discoverTimer !== null) { clearT(discoverTimer); discoverTimer = null; }
      for (const sid of [...pendingClear.keys()]) clearPending(sid);
      if (loaded && (dirtyUrgent || dirtyActivity || pendingDeletes.length || saveTimer !== null)) save();
      if (saveTimer !== null) { clearT(saveTimer); saveTimer = null; }
    }
    await claudeState.stop();
    await Promise.all([...releasing]);
    if (running) await running;
    if (followUp) { followUp.resolve(); followUp = null; }
  }

  // ── reads ──
  // By conversation id, or the id of one merged into another (its survivor).
  function get(cid) {
    if (typeof cid !== 'string') return null;
    const rec = convs.get(cid) || convs.get(aliases.get(cid));
    return rec ? viewOf(rec) : null;
  }
  function bySession(sid) {
    const rec = recordOfSession(sid);
    return rec ? viewOf(rec) : null;
  }
  function list() {
    return [...convs.values()]
      .sort((a, b) => (b.last_activity_at - a.last_activity_at) || (a.id < b.id ? -1 : 1))
      .map(viewOf);
  }
  // Neither is handed out for a session the session scope switched off.
  function sessionDir(sid) {
    const rec = recordOfSession(sid);
    const s = rec ? sessionEntry(rec, sid) : null;
    if (!s || !s.slug || !sessionEnabled(sid)) return null;
    try { return path.join(userClaudePaths().projectsDir, s.slug, sid); } catch { return null; }
  }
  // Fenced at every call (lib/core/claude-files transcriptFile): a path that was
  // acceptable before the file existed vouched only for its directory.
  function transcriptPath(sid) {
    const rec = recordOfSession(sid);
    const s = rec ? sessionEntry(rec, sid) : null;
    if (!s || !s.slug || !sessionEnabled(sid)) return null;
    try { return transcriptFile(path.join(userClaudePaths().projectsDir, s.slug, `${sid}.jsonl`)); } catch { return null; }
  }
  function processOf(cid) {
    const v = get(cid);
    return v ? v.process : null;
  }
  function conversationOfPid(pid) {
    if (!validPid(pid)) return null;
    const rec = ownerOf(pid);
    return rec ? rec.id : null;
  }
  function stats() {
    let sessions = 0;
    let off = 0;
    for (const rec of convs.values()) {
      sessions += rec.sessions.length;
      if (rec.off) off += 1;
    }
    return {
      enabled: enabledState.enabled,
      scope: enabledState.scope || null,
      conversations: convs.size,
      sessions,
      provisional: fallbackId,
      watching: claudeState.linked().length,
      pending_clears: pendingClear.size,
      arrivals: arrivals.size, // sessions whose last arrival is remembered (≤ ARRIVALS_MAX)
      sessions_off: off, // conversations whose current session the session scope switched off
      dead_files: deadProcs.size, // sessions files a verdict ruled out, not sampled again
      discoveries: counters.discoveries,
      ingested: counters.ingested,
      ignored: { ...counters.ignored },
    };
  }

  return {
    // lifecycle
    start, stop,
    get ready() { return startPromise || Promise.resolve(); },
    enabled: () => ({ ...enabledState }),
    tick, discover, flush,
    retune: (cid) => claudeState.retune(cid),
    // evidence in
    ingest, processGone, markFork, noteTitle, noteActivity,
    // the engine's `conversations` (§2.12)
    get, bySession, list, sessionDir, transcriptPath, processOf,
    conversationOfPid,
    view: get,
    stats,
  };
}

module.exports = {
  createConversations,
  FILE_VERSION,
  CONVERSATIONS_MAX,
  SESSIONS_MAX,
  FALLBACK_WINDOW_MS,
  FALLBACK_SCAN_MAX,
  CLEAR_GRACE_MS,
  ACTIVITY_SAVE_MS,
  ARRIVALS_MAX,
  DISCOVERY_MS,
  REASONS,
  LINKED_BY,
  CHANGES,
  IGNORED,
};

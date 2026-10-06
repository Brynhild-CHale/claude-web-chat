// lib/server/mirror/index.js — the chat mirror's facade (spec §2.1, §2.12).
//
// The mirror engine follows every Claude Code conversation that belongs to this
// project and keeps one model of it (lib/server/mirror/*). This file is its one
// face: the lifecycle, the toggle, ingestion from the hook tap, the source
// contract and its dispatch table, the read boundary's redaction, and the whole
// in-process API the routes, the turn guard, the asks domain, the queue's
// release and the graph's commit code against. Routes never reach past it
// (lib/server/routes/mirror*.js read `ctx.mirror` alone).
//
// THE API (built in tranche 1 with its whole surface; a method whose source is
// not registered yet answers `{unavailable: true}`, so later tranches add
// sources without editing this file — C32):
//
//   createMirror({ root, paths, graph, mainBus, mirrorBus, hooks, redactor,
//                  audience, now = Date.now, log }) → mirror
//   mirror.start() → Promise         mirror.stop() → Promise (flushes, closes every handle)
//   mirror.ready                     a promise: start() has finished (routes wait ≤ 2 s)
//   mirror.enabled() → {enabled, scope?}
//   mirror.ingest(envelope)          the tap subscriber: sync, idempotent, never throws
//   mirror.attachToNode(nodeId, {commit}) → node.mirror | null        sync (commitNode)
//   mirror.liveOf(conversationOrSessionId) → Live | null
//   mirror.conversationOfPid(pid) → id | null
//   mirror.subscribe(fn) → unsubscribe                the §2.6 transitions (the mirror ring)
//   mirror.snapshot({level, since}) / status() / tasks() / nodeTurns(ref) / nodeSummaries()
//   mirror.turns(cid, q) / turn(id) / itemField(id, q) / attachment(id, n) /
//         taskOutput(id, q) / agent(id, q) / workflow(runId) / diff(q)      Promises
//   mirror.markStopRequested(taskId) → TaskRow | null
//   mirror.forkAnchor(turnId) → Promise<{session_id, parent_uuid} | {refused}>
//   mirror.skillFold(conversationId) → {names, descriptions, orgUuid}  never over HTTP
//   mirror.summary() → {enabled, state, conversations, last_hook_at}   content-free (/api/health)
//   mirror.register(name, source) → the api it read      a source per the contract below
//   mirror.stats()                   content-free counters, for diagnostics and tests
//
// WIRING. One model (model.js) is the inbound redaction point; the emitter
// (emit.js) drains it into frames on the MIRROR bus, and every writer is handed
// the emitter's tracked model, so a write arms the flush. The turn machine
// (turn-machine.js) owns the turns' lifecycle and claims the model's turn
// writer. The conversation registry (conversations.js, with claude-state.js) is
// the facade's own: it decides which envelopes belong here (§2.2), links
// sessions into conversations, and tells the facade each change, which the
// facade writes into the model and hands every source. Tranche 1's one source
// is `live` (live.js, the live-state machine and the heartbeat, §2.6), wired
// through the same contract as every later source.
//
// THE SOURCE CONTRACT. `mirror.register(name, source)`, where `source` is
// `attach(engine)` or `{attach(engine)}`, at construction (SOURCES, below) or
// later; a source registered after start() starts at once. What attach receives
// (one frozen object per source):
//
//   engine = {
//     name, root, paths, now, log,
//     model,      the model as writers are handed it (every write arms the flush):
//                 upserts — the INBOUND REDACTION POINT — and lookups, patchTurn,
//                 upsertTask/removeTask, upsertConversation (meta), upsertLive
//                 (live's); plus the turn machine's operations: openTurn,
//                 closeTurn (whose `ended_by` is the facade's: a caller's is
//                 dropped, see WHO INTERRUPTED), supersede (§2.4 rule 4, the
//                 one way a turn is superseded), openTurnOf, resolveTurn,
//                 sessionTurn, turnOfUuid, segmentOf; the graph link's
//                 pendingTurns, attachTurn, orphanPending, linkState; the
//                 index's exportTurns, restoreTurns; refill (an evicted turn's
//                 items, from a re-read of its byte range, in the change shapes
//                 applyChanges takes); configure (an agent stream's {mode:
//                 'agent'}). Not here: the turn writer (the turn machine's) and
//                 removeConversation (the registry's)
//     applyChanges(sessionId, changes, {conversation_id?, mode?}) → {ok, applied}
//                 how a source hands over a batch of normalized changes (the
//                 change contract in turn-machine.js's header): the turn machine
//                 applies them through the model (redacting), then every OTHER
//                 source's onChanges hears them
//     redactor,   ctx.redactor: text, value, window, addKnown (§5.5)
//     files,      lib/core/claude-files: transcriptFile, sessionDirFile,
//                 taskOutputFile, planFile, readWindow (§5.6) — every path read
//                 out of Claude Code text goes through one of them
//     watchFile,  lib/core/watch watchFile (§2.3); every watcher made through it
//                 is also stopped by mirror.stop()
//     conversations: get(cid), bySession(sid), list(), sessionDir(sid),
//                 transcriptPath(sid), processOf(cid), markFork(cid, {forked_from}),
//                 noteTitle(cid, title)
//     live:       liveOf(cid | sid) → Live | null, noteActivity(cid | sid, at, kind)
//                 — progress evidence (§2.6), which the registry's last-activity
//                 clock (the prune order) hears too
//     transition(t)  put a §2.6 transition on the mirror bus
//     beginIndex({conversation_id?, reason?}) → end()   index mode for a catch-up
//                 (boot, a reset, a long transcript found late): no stream frame
//                 goes out for the scope until end(), and then one mirror:reset
//                 (emit.js, §2.9)
//     reset({reason, conversation_id?})   one mirror:reset at the next flush: every
//                 chrome reads the snapshot again (a transcript rewritten under its
//                 tailer, say)
//     timers,     setTimeout, clearTimeout, setInterval, clearInterval, clear:
//                 owned by the engine; every handle is cleared by mirror.stop()
//     sourceStates(sessionId) → {[source name]: persistState value}, each passed
//                 through the redactor: what the index store writes (§2.11)
//     restoreSourceStates(sessionId, states)   each source its slice back
//     statusClosed(decision), processGone(cid, {at, pid})
//                 the live-state machine's two decisions (§2.6): a busy → idle
//                 flip with no Stop ended the turn; the process is gone. Only the
//                 `live` source makes them, and a decision never names who
//                 stopped the turn (its `ended_by` is dropped)
//     procs:      {sampleProcs, isPidAlive} — lib/core/portfiles, replaceable in tests
//     graph:      the surface's graph (read it, never write it)
//     mainBus:    {subscribe, read} — the surface's change bus, to listen only
//   }
//
// What attach returns, every member optional except start and stop:
//
//   { start() → Promise, stop() → Promise,
//     onIngest(env, {conversation_id, session_id}),  every envelope the engine
//                 accepted, after its own ingest (the registry, the turn machine)
//     onConversation({change, conversation, ...}),   added | linked | merged |
//                 ended | removed | updated (the registry's events, as it emits them)
//     onChanges(sessionId, changes, {conversation_id}),  each batch another source applied
//     onTurnOpened(turn), onTurnClosed(turn),        the turn machine's (headers, frozen)
//     persistState(sessionId) → JSON, restoreState(sessionId, value),
//     diagnostics() → a content-free object merged into the snapshot's diagnostics,
//     api: {[name]: fn} }  what the dispatch table routes to; read once, at registration
//
// The hooks are synchronous and must not throw (the facade wraps each call and
// logs a throw); a source that needs I/O schedules it. A hook can arrive before
// start() has resolved, and before start() at all for the conversations a
// restart restores: a source records them and acts once started. start() and
// stop() each run again, alternately, when web-chat is switched off and on.
// Treat everything handed in as read-only.
//
// Beyond §2.12's lists, and added here so no later source has to edit this file:
// the engine's name, beginIndex, reset, statusClosed, processGone, procs, graph
// and mainBus; the turn machine's operations on `model`; markFork and noteTitle
// on `conversations`; the second and third arguments of onIngest and onChanges;
// and the optional diagnostics(). The registry's own noteActivity is reached
// through `live.noteActivity`, which feeds both.
//
// A source's api answers pass the read boundary (below), whose json-key rule
// masks a value under a key named like a credential whole: a field called
// `next_token` or `token` would come back masked. Name such fields otherwise.
//
// THE DISPATCH TABLE is fixed here (DISPATCH, below): a facade method names a
// source and its api method. An unregistered source, or one whose api lacks the
// method, answers `{unavailable: true}` (resolved, for the Promise methods), as
// does every method once the mirror has stopped.
//
// REDACTION AT THE READ BOUNDARY (§2.9). Every dispatched result passes
// redactOut(v) = redactHostPaths(redactor.value(v), {root}) before it leaves
// lib/server/mirror, whether or not it came through the model: secrets masked,
// then the project root shown as `<project>` and the home directory as `~`. The
// two exemptions are skillFold (the organisation id the `/` catalog needs, in
// process only) and attachToNode (references only). An attachment's bytes pass
// untouched — no text rule reads an image — while its metadata is redacted. The
// facade's own reads (snapshot, tasks, liveOf) pass redactOut too, and so do the
// content frames (mirror:update, mirror:stream) on their way to the mirror bus:
// the model redacts what it stores, but only this boundary masks the host's paths
// and a value the redactor learned (addKnown) after the text was stored.
// Redaction is idempotent, so the second pass costs a scan and nothing else.
// mirror:status and mirror:reset are content-free by construction.
//
// INGEST (§2.12). The tap subscriber: synchronous, idempotent — an envelope seen
// before, by session_id, event, ts, tool.use_id (and the agent, input_hash and
// ask that tell two such envelopes apart, as live.js keys them), changes nothing
// — and it never throws back into a hook. The registry applies §2.2's acceptance
// (a foreign root, a transcript path the fence refuses and a disabled session are
// ignored); a synthetic envelope (PermissionResolved, the asks domain's, in
// process only) is routed by its session instead. Then the turn machine's hook
// rules (§2.4), then every source's onIngest, `live` first: its §2.6 rules are
// written over timestamps, so they give the same outcome whichever order the
// envelopes, or the turn machine's callbacks, reach it in.
//
// WHO INTERRUPTED has its one home here (§2.6, §15.2). The facade follows the
// main bus's `control` events with op 'interrupt' and remembers each against its
// session and the turn open then, until that turn closes: at most
// INTERRUPT_HOLD_MS for an Esc or an abort (via 'tty' or 'mod'), and until the
// halt flag's expiry (at most HALT_HOLD_MAX_MS) for via 'hook', which waits for
// the running tool to end. A remembered request about the turn closing
// `interrupted` gives ended_by 'web' ('hook' for a halt); none, with an observed
// interruption (the transcript's interrupt marker, the status machine's
// decision), gives 'terminal'; an inferred one (the next prompt came with no
// Stop: by 'next-turn') names nobody. Nobody else answers it. The turn machine
// asks interruptedBy(cid, sid) at each such close and names no turn, so the
// conversation's open turn stands for the one closing: exact, but for an older
// turn a catch-up closes while a request waits for the open one. interruptedBy
// takes the closing turn's id as a third argument, and is exact for whoever
// passes it. A source never says: the closeTurn it is handed drops a caller's
// ended_by and asks about the very turn it closes, by the rules above, and
// statusClosed drops a decision's. The turn machine stamps the answer on the
// header and on the turn-closed transition, which the turn guard copies into the
// node. Until tranche 4 nothing emits a control event, so ended_by is
// 'terminal' or absent.
//
// A FAILED TURN'S MESSAGE. A StopFailure's stop.error (≤ 500) is stamped, through
// the model, on the turn it closed (`error`) and carried into the live state's
// last_turn while that turn is the last one, so the bar can say why it stopped
// without loading the stream.
//
// THE DISABLED STATE (§2.2). The registry checks the toggle (user and project
// scopes) at start and every DISCOVERY_MS, and the session scope per session.
// Switched off: every source stops (their tailers, watchers and timers), the
// model's content is dropped (each conversation removed, which every source
// hears), the files stay, one mirror:reset {reason: 'disabled'} goes out,
// ingests are ignored and enabled() answers {enabled: false, scope}, which the
// routes answer with. Switched on: the sources start again, the registry reloads
// and rediscovers, and a mirror:reset {reason: 'enabled'} sends every chrome back
// for the snapshot.
//
// CAPABILITIES (§2.10, §15.1) are reported, never assumed: each key is decided by
// CAPABILITIES below — the source-backed ones by whether that source's api method
// is registered, the control layer's (interrupt, code_revert, fork, mod,
// rewind_in_place) false in tranche 1, and the asks and composer ones false until
// tranche 4 wires them (U66a).
//
// LIFECYCLE. Construction is inert: nothing is armed, read or subscribed until
// start(), which subscribes to the hook tap and the main bus, starts the registry
// (the toggle, conversations.json, the first discovery) and then, when enabled,
// every source. stop() is idempotent: it unsubscribes, stops every source and the
// registry (which flushes conversations.json), stops any watcher made through the
// engine, flushes the emitter once more, stops it, and clears every timer the
// engine owns. The engine's timers are ref'd: on Node 22 a test awaiting work
// held only by unref'd handles is cancelled (V17), and the daemon is held open by
// its server anyway — mirror.stop() is what ends them, on both of the server's
// teardown paths.
//
// The engine never controls a process and never writes the working tree (§2.1):
// control actions are the control domain's (§15).
//
// Dependency direction: lib/server; imports lib/core and its siblings in
// lib/server/mirror.

const { createBus } = require('../../core/bus');
const { projectPaths, redactHostPaths } = require('../../core/paths');
const claudeFiles = require('../../core/claude-files');
const { watchFile: coreWatchFile } = require('../../core/watch');
const portfiles = require('../../core/portfiles');
const { atLeast } = require('../../core/remote-policy');
const { createModel, cutString } = require('./model');
const { createEmitter, AGGREGATE_ORDER } = require('./emit');
const { createTurnMachine } = require('./turn-machine');
const { createConversations } = require('./conversations');
const { createLive } = require('./live');
const { createTranscriptsSource } = require('./transcripts');
const { createIndexStore } = require('./index-store');
const { createRewindsSource } = require('./rewinds');
const { createTasksSource } = require('./tasks');
const { createAgentsSource } = require('./agents');
const { createWorkflowsSource } = require('./workflows');
const { createCodediffSource } = require('./codediff');
const { createGraphLinkSource } = require('./graph-link');

// ── constants ────────────────────────────────────────────────────────────────

// The mirror bus's own ring (§2.9): createServer builds one; the facade makes
// one of this size when it is handed none.
const MIRROR_RING = 2000;
// The snapshot's default window when a caller names no `since` (the state route
// always does, with the same default).
const SINCE_DEFAULT_MS = 24 * 60 * 60 * 1000;
// Envelopes remembered for idempotency.
const SEEN_MAX = 4096;
// Who interrupted (§2.6): an Esc or an abort is remembered at most this long; a
// halt until its flag's expiry, which is at most this far ahead (§15.2).
const INTERRUPT_HOLD_MS = 10000;
const HALT_HOLD_MAX_MS = 30 * 60 * 1000;
const INTERRUPTS_MAX = 256;
// A control event's `expires_at` below this is epoch seconds (the halt flag's
// unit), above it epoch milliseconds (the Esc request's `now + 2000`).
const EPOCH_SECONDS_BELOW = 1e11;
// A StopFailure's message, as envelope v1 caps it (§1.3).
const FAILURE_MAX = 500;
// The hook events counted for diagnostics, by name.
const EVENT_NAMES_MAX = 32;
const EVENT_RE = /^[A-Za-z]{1,40}$/;
// A source's name: one lowercase word, hyphens allowed ('graph-link').
const SOURCE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
// What a log line may say about a failure: a class or a code, one word.
const LOG_WORD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

// Who a control interrupt's path says stopped the turn (§2.6): an Esc injected
// or a mod's abort is the page's, a halt is the halt hook's.
const ENDED_BY_OF_VIA = Object.freeze({ tty: 'web', mod: 'web', hook: 'hook' });

// The frames that carry content, and pass the read boundary on their way out.
const CONTENT_FRAMES = new Set(['mirror:update', 'mirror:stream']);

// The model's members a source is not handed: the turn writer is the turn
// machine's (claimed once), a conversation is removed by the registry alone, and
// an evicted turn is refilled through the turn machine's `refill`, which keeps
// its rewound notice.
const MODEL_HIDDEN = new Set(['claimTurnWriter', 'removeConversation', 'refillTurn']);

// ── the dispatch table (§2.12) ───────────────────────────────────────────────
//
// facade method → the source and its api method. `async`: the facade answers a
// Promise (resolved {unavailable: true} when the source is missing); `exempt`:
// the result is returned as the source gave it (§2.9's two exemptions); `binary`:
// typed-array and ArrayBuffer values pass untouched (an attachment's bytes);
// `safe`: a throw answers null, logged — a commit never fails for the mirror.

const DISPATCH = Object.freeze({
  turns: Object.freeze({ source: 'transcripts', method: 'turns', async: true }),
  turn: Object.freeze({ source: 'transcripts', method: 'turn', async: true }),
  itemField: Object.freeze({ source: 'transcripts', method: 'itemField', async: true }),
  attachment: Object.freeze({ source: 'transcripts', method: 'attachment', async: true, binary: true }),
  skillFold: Object.freeze({ source: 'transcripts', method: 'skillFold', exempt: true }),
  forkAnchor: Object.freeze({ source: 'transcripts', method: 'forkAnchor', async: true }),
  taskOutput: Object.freeze({ source: 'tasks', method: 'output', async: true }),
  markStopRequested: Object.freeze({ source: 'tasks', method: 'markStopRequested' }),
  agent: Object.freeze({ source: 'agents', method: 'stream', async: true }),
  workflow: Object.freeze({ source: 'workflows', method: 'detail', async: true }),
  diff: Object.freeze({ source: 'codediff', method: 'diff', async: true }),
  nodeTurns: Object.freeze({ source: 'graph-link', method: 'nodeTurns' }),
  nodeSummaries: Object.freeze({ source: 'graph-link', method: 'summaries' }),
  attachToNode: Object.freeze({ source: 'graph-link', method: 'attachToNode', exempt: true, safe: true }),
});

// ── capabilities (§2.10, §15.1) ──────────────────────────────────────────────
//
// key → rule(can), where can(source, method) says whether that source is
// registered with that api method. Every key of §2.10's list is always present.

const CAPABILITIES = Object.freeze({
  answer: () => false, // the asks domain and the answer origin (tranche 4, U66a)
  task_stop: () => false, // POST /api/queue/task-stop (tranche 4)
  queue_message: () => false, // the composer (tranche 4)
  turn_diff: (can) => can('codediff', 'diff'),
  node_diff: (can) => can('codediff', 'diff') && can('graph-link', 'nodeTurns'),
  attachments: (can) => can('transcripts', 'attachment'),
  agent_items: (can) => can('agents', 'stream'),
  // The control layer (§15): false until the tranche that wires each.
  interrupt: () => false,
  code_revert: () => false,
  fork: () => false,
  mod: () => false,
  rewind_in_place: () => false,
});

// ── small helpers ────────────────────────────────────────────────────────────

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
const isBinary = (v) => ArrayBuffer.isView(v) || v instanceof ArrayBuffer;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Bounded insertion into an insertion-ordered Map: the oldest goes first.
function remember(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// An envelope's identity (see INGEST): only strings and finite numbers enter it.
function envelopeKey(env) {
  const str = (v) => (typeof v === 'string' ? v.slice(0, 256) : '');
  const tool = isPlain(env.tool) ? env.tool : null;
  const agent = isPlain(env.agent) ? env.agent : null;
  const ask = isPlain(env.ask) ? env.ask : null;
  return [
    str(env.session_id), str(env.event), finite(env.ts) ? String(env.ts) : '',
    str(tool && tool.use_id), str(agent && agent.id), str(tool && tool.input_hash), str(ask && ask.id),
    env.synthetic === true ? 'synthetic' : '',
  ].join('|');
}

// The timers the engine owns. Every handle set through them is tracked, so
// clearAll() — mirror.stop() — ends each one still pending; after it nothing is
// armed. `base` is Node's timers (ref'd) or a test's; a base without
// setInterval gets one built from setTimeout.
const NODE_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
});

function trackTimers(base) {
  const timeouts = new Set();
  const intervals = new Map(); // handle → the base handle (or a chain's current one)
  let closed = false;

  function setT(fn, ms, ...args) {
    if (closed) return null;
    const h = base.setTimeout(() => { timeouts.delete(h); fn(...args); }, ms);
    timeouts.add(h);
    return h;
  }
  function clearT(h) {
    if (h === null || h === undefined) return;
    timeouts.delete(h);
    try { base.clearTimeout(h); } catch { /* already gone */ }
  }
  function setI(fn, ms, ...args) {
    if (closed) return null;
    if (typeof base.setInterval === 'function') {
      const h = base.setInterval(() => fn(...args), ms);
      intervals.set(h, { base: h, chained: false });
      return h;
    }
    // A chain of timeouts, re-armed before each call so a call that clears it
    // clears the next one too. The caller's handle is an opaque key.
    const handle = Object.freeze({});
    const entry = { base: null, chained: true };
    const arm = () => {
      entry.base = base.setTimeout(() => {
        if (!intervals.has(handle)) return;
        arm();
        fn(...args);
      }, ms);
    };
    intervals.set(handle, entry);
    arm();
    return handle;
  }
  function clearI(h) {
    const entry = intervals.get(h);
    if (!entry) {
      if (h !== null && h !== undefined && typeof base.clearInterval === 'function') {
        try { base.clearInterval(h); } catch { /* not ours */ }
      }
      return;
    }
    intervals.delete(h);
    try {
      if (entry.chained) base.clearTimeout(entry.base);
      else base.clearInterval(entry.base);
    } catch { /* already gone */ }
  }
  function clear(h) {
    if (intervals.has(h)) clearI(h);
    else clearT(h);
  }
  function clearAll() {
    closed = true;
    for (const h of [...timeouts]) clearT(h);
    for (const h of [...intervals.keys()]) clearI(h);
  }
  return {
    view: Object.freeze({ setTimeout: setT, clearTimeout: clearT, setInterval: setI, clearInterval: clearI, clear }),
    size: () => timeouts.size + intervals.size,
    clearAll,
  };
}

// ── the tranche-1 source: live state and the heartbeat (live.js, §2.6) ────────

// A failed turn's message rides into the live state's last_turn (see A FAILED
// TURN'S MESSAGE): read from the turn header the facade stamped it on.
function withFailure(engine, live) {
  const last = isPlain(live) ? live.last_turn : null;
  if (!isPlain(last) || last.outcome !== 'error' || typeof last.id !== 'string') return live;
  const header = engine.model.turn(last.id);
  if (!header || typeof header.error !== 'string' || !header.error) return live;
  return { ...live, last_turn: { ...last, error: header.error } };
}

function attachLive(engine) {
  const live = createLive({
    now: engine.now,
    timers: engine.timers,
    sampleProcs: (pids) => engine.procs.sampleProcs(pids),
    isPidAlive: (pid) => engine.procs.isPidAlive(pid),
    // The inbound scrub: live.js keeps no label, call, question or waitingFor
    // the redactor has not passed.
    redact: (s) => engine.model.scrubText(s),
    openTurnOf: (cid) => {
      const id = engine.model.openTurnOf(cid);
      return id ? engine.model.turn(id) : null;
    },
    turnOf: (id) => engine.model.turn(engine.model.resolveTurn(id)),
    transition: engine.transition,
    // live.js decides; the turn machine applies the decision and emits the one
    // turn-closed (with ended_by), and the facade ends the conversation.
    statusClosed: (decision) => engine.statusClosed(decision),
    processGone: (cid, o) => engine.processGone(cid, o),
    onLive: (cid, value) => engine.model.upsertLive(cid, withFailure(engine, value)),
    log: engine.log,
  });
  return {
    start: () => live.start(),
    stop: () => live.stop(),
    onIngest: (env, { conversation_id: cid } = {}) => live.ingest(cid, env),
    onConversation: (ev) => live.onConversation(ev),
    onChanges: (sessionId, changes) => live.onChanges(sessionId, changes),
    onTurnOpened: (turn) => live.onTurnOpened(turn),
    onTurnClosed: (turn) => live.onTurnClosed(turn),
    api: {
      liveOf: (id) => live.liveOf(id),
      stateOf: (id) => live.stateOf(id),
      noteActivity: (id, at, kind) => live.noteActivity(id, at, kind),
      noteSessionState: (cid, rec) => live.noteSessionState(cid, rec),
      sampleNow: () => live.sampleNow(),
    },
  };
}

// ── SOURCES ──────────────────────────────────────────────────────────────────
//
// The sources each tranche registers (§2.12), in order: name → attach(engine).
// The one list later tranches edit — each tranche's integration unit adds that
// tranche's sources here (2: transcripts, rewinds; 3: tasks, agents,
// workflows, codediff, graph-link; 6: mod-live), and nothing else in this file
// changes for a source. `live` stays first: the other sources' hooks then see the
// live state each event has already moved.

const SOURCES = Object.freeze([
  Object.freeze({ name: 'live', attach: attachLive }),
  // Tranche 2. The transcripts source tails each session's transcript into the
  // model, with its turn index (index-store.js) as the store it resumes from;
  // rewinds hears only the batches transcripts applied, so it comes after it.
  Object.freeze({ name: 'transcripts', attach: createTranscriptsSource({ createStore: createIndexStore }).attach }),
  Object.freeze({ name: 'rewinds', attach: createRewindsSource().attach }),
  // Tranche 3. Background work — shells and monitors (tasks), agents and
  // workflows — then the per-turn code diffs (codediff: its shadow store is
  // made at the first fresh turn, never here; WEB_CHAT_MIRROR_DIFFS=0 is read
  // at attach) and the graph link, which attaches each closed turn to the next
  // committed node (graph.mirror, lib/server/index.js).
  Object.freeze({ name: 'tasks', attach: createTasksSource().attach }),
  Object.freeze({ name: 'agents', attach: createAgentsSource().attach }),
  Object.freeze({ name: 'workflows', attach: createWorkflowsSource().attach }),
  Object.freeze({ name: 'codediff', attach: createCodediffSource().attach }),
  Object.freeze({ name: 'graph-link', attach: createGraphLinkSource().attach }),
]);

// ── the facade ───────────────────────────────────────────────────────────────

function createMirror({
  root,
  paths = null,
  graph = null,
  mainBus = null,
  mirrorBus = null,
  hooks = null,
  redactor,
  // The audience gate (ctx.audience). Nothing here reads it in tranche 1: a
  // caller passes its level to snapshot(). Held for the asks provider tranche 4
  // wires in (U66a).
  audience = null,
  now = Date.now,
  log = () => {},
  // Seams for the integration and the tests: the base timers the engine's own
  // wrap, the process facts, the registry's own options (its engines and
  // cadences), and the sources registered at construction.
  timers: baseTimers = NODE_TIMERS,
  sampleProcs = portfiles.sampleProcs,
  isPidAlive = portfiles.isPidAlive,
  conversationsOptions = {},
  sources: initialSources = SOURCES,
} = {}) {
  if (typeof root !== 'string' || !root) {
    throw new TypeError('createMirror: root (the project directory the daemon serves) is required');
  }
  if (!redactor || typeof redactor.text !== 'function' || typeof redactor.value !== 'function') {
    throw new TypeError('createMirror: a redactor with text() and value() is required (ctx.redactor, lib/core/redact createRedactor) — nothing leaves the mirror unredacted');
  }
  if (typeof now !== 'function') throw new TypeError('createMirror: now must be a clock function');
  if (!baseTimers || typeof baseTimers.setTimeout !== 'function' || typeof baseTimers.clearTimeout !== 'function') {
    throw new TypeError('createMirror: timers must provide setTimeout and clearTimeout');
  }
  // projectPaths' shape (lib/core/paths): the mirror's keys live there. A caller
  // handing createServer's UPPERCASE adapter gets the core shape instead.
  const p = paths && typeof paths.mirrorDir === 'string' ? paths : projectPaths(root);
  const bus = mirrorBus && typeof mirrorBus.emit === 'function' && typeof mirrorBus.subscribe === 'function'
    ? mirrorBus : createBus({ maxEvents: MIRROR_RING });
  void audience;

  // ── state ──
  const sources = new Map(); // name → { name, inst, api, starting }
  const seen = new Map(); // envelope keys already ingested
  const interrupts = []; // remembered control interrupts, newest last
  const watchers = new Set(); // watchers made through engine.watchFile
  const busSubs = new Set(); // main-bus subscriptions made through engine.mainBus
  const mirrorSubs = new Set(); // mirror.subscribe's
  const eventsSeen = new Map(); // hook event name → count
  const counters = { accepted: 0, duplicates: 0, ignored: {}, errors: 0 };
  let lastHookAt = null;
  let running = false; // start() was called (and stop() was not)
  let stopped = false;
  let disabled = null; // {scope} while web-chat is switched off
  let startPromise = null;
  let stopPromise = null;
  let toggleChain = Promise.resolve();
  let offTap = null;
  let offMain = null;
  let conversations = null; // assigned below; referenced by callbacks only once it is

  function say(...args) { try { log(...args); } catch { /* a logger never breaks the engine */ } }
  // Names the stage and the error's class or code only: an error's message can
  // quote what the engine was handling.
  function fail(stage, e) {
    counters.errors += 1;
    const word = [e && e.code, e && e.name].find((w) => typeof w === 'string' && LOG_WORD_RE.test(w)) || 'Error';
    say(`mirror: ${stage} failed (${word})`);
  }
  function ignore(reason) {
    const r = typeof reason === 'string' && LOG_WORD_RE.test(reason) ? reason : 'refused';
    counters.ignored[r] = (counters.ignored[r] || 0) + 1;
  }

  const timers = trackTimers(baseTimers);

  // ── the read boundary (§2.9) ──
  // Secrets masked, then the host's paths. With `binary`, typed arrays and
  // ArrayBuffers are lifted out first and put back after, untouched; one whose
  // place the redaction moved (a key that was itself masked) is dropped.
  function redactOut(v, { binary = false } = {}) {
    if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'number') return v;
    if (!binary) return redactHostPaths(redactor.value(v), { root });
    const bins = [];
    const bare = detachBinary(v, [], bins, new WeakSet());
    return reattachBinary(redactHostPaths(redactor.value(bare), { root }), bins);
  }
  function detachBinary(v, at, bins, onPath) {
    if (isBinary(v)) { bins.push([at, v]); return null; }
    if (!v || typeof v !== 'object') return v;
    if (onPath.has(v)) return null;
    onPath.add(v);
    let out = v;
    if (Array.isArray(v)) out = v.map((x, i) => detachBinary(x, [...at, i], bins, onPath));
    else if (isPlain(v)) {
      out = {};
      for (const k of Object.keys(v)) out[k] = detachBinary(v[k], [...at, k], bins, onPath);
    }
    onPath.delete(v);
    return out;
  }
  function reattachBinary(out, bins) {
    let top = out;
    for (const [at, bin] of bins) {
      if (!at.length) { top = bin; continue; }
      let cur = top;
      for (let i = 0; i < at.length - 1 && cur && typeof cur === 'object'; i++) cur = own(cur, at[i]) ? cur[at[i]] : null;
      const last = at[at.length - 1];
      if (cur && typeof cur === 'object' && own(cur, last) && cur[last] === null) cur[last] = bin;
    }
    return top;
  }

  // The mirror bus as the emitter is handed it: content frames pass the read
  // boundary on their way out; ring events (content-free) and the status and
  // reset frames pass as they are.
  function outFrame(f) {
    return isPlain(f) && CONTENT_FRAMES.has(f.type) ? redactOut(f) : f;
  }
  const frameBus = Object.freeze({
    emit(payload) {
      if (!isPlain(payload) || payload.ws === null || payload.ws === undefined) return bus.emit(payload);
      const ws = Array.isArray(payload.ws) ? payload.ws.map(outFrame) : outFrame(payload.ws);
      return bus.emit({ ...payload, ws });
    },
  });

  // ── the model, the emitter, the turn machine ──
  // The emitter drains the model it is given; every writer gets its tracked view.
  const emitter = createEmitter({ model: createModel({ redactor }), bus: frameBus, now, timers: timers.view, log: (m) => say(m) });
  const model = emitter.model;

  // A §2.6 transition onto the mirror ring. A live state change also re-reads
  // the sessions-file watch's cadence (claude-state polls faster off idle).
  function transition(t) {
    const built = emitter.transition(t);
    if (conversations && isPlain(t) && t.op === 'state' && typeof t.conversation_id === 'string') {
      try { conversations.retune(t.conversation_id); } catch (e) { fail('retune', e); }
    }
    return built;
  }

  const tm = createTurnMachine({
    model,
    now,
    interruptedBy: (cid, sid, turnId) => interruptedBy(cid, sid, turnId),
    transition,
    onTurnOpened: (turn) => each('onTurnOpened', deepFreeze(turn)),
    onTurnClosed: (turn) => {
      forgetInterrupts(turn);
      each('onTurnClosed', deepFreeze(turn));
    },
  });

  // ── the sources' hooks ──
  function callHook(s, hook, args) {
    const fn = s.inst[hook];
    if (typeof fn !== 'function') return;
    try { fn.apply(s.inst, args); } catch (e) { fail(`${s.name}.${hook}`, e); }
  }
  function each(hook, ...args) {
    for (const s of [...sources.values()]) callHook(s, hook, args);
  }
  function apiFn(name, method) {
    const s = sources.get(name);
    return s && own(s.api, method) && typeof s.api[method] === 'function' ? s.api[method] : null;
  }
  // The `live` source's api (tranche 1's): undefined while it is not registered.
  function callLive(method, ...args) {
    const fn = apiFn('live', method);
    if (!fn) return undefined;
    try { return fn(...args); } catch (e) { fail(`live.${method}`, e); return undefined; }
  }

  // ── the registry (§2.2), the facade's own ──
  // Its view is the model's conversation, less the process's start time (the live
  // machine reads that from the event itself; §2.10's Conversation has none). A
  // field the view drops is cleared, never kept stale: `provisional` once a
  // fallback conversation is confirmed.
  function conversationPatch(cid, view) {
    const out = {};
    for (const k of Object.keys(view)) if (k !== 'id' && k !== 'merged_into') out[k] = view[k];
    if (isPlain(view.process)) {
      const proc = {};
      for (const k of Object.keys(view.process)) if (k !== 'proc_start') proc[k] = view.process[k];
      out.process = proc;
    }
    if (view.provisional !== true) {
      const cur = model.conversation(cid);
      if (cur && cur.provisional === true) out.provisional = false;
    }
    return out;
  }

  function onRegistryEvent(ev) {
    if (stopped || !isPlain(ev) || !isPlain(ev.conversation)) return;
    const cid = model.cleanId(ev.conversation.id);
    if (!cid) return;
    try {
      if (ev.change === 'merged' || ev.change === 'removed') tm.removeConversation(cid, { merged_into: ev.merged_into });
      else model.upsertConversation(cid, conversationPatch(cid, ev.conversation));
    } catch (e) {
      fail('conversation', e);
    }
    each('onConversation', ev);
  }

  conversations = createConversations({
    root,
    paths: p,
    now,
    timers: timers.view,
    log: say,
    redact: (s) => model.scrubText(s),
    transition,
    stateOf: (cid) => callLive('stateOf', cid),
    onSessionState: (cid, rec) => callLive('noteSessionState', cid, rec),
    onConversation: onRegistryEvent,
    onToggle,
    sampleProcs,
    isPidAlive,
    ...conversationsOptions,
  });

  // A conversation id from a conversation's or a session's.
  function conversationIdOf(id) {
    if (typeof id !== 'string' || !id) return null;
    if (model.conversation(id)) return id;
    const v = conversations.bySession(id) || conversations.get(id);
    return v && model.conversation(v.id) ? v.id : null;
  }

  // ── the engine handed to sources (the contract above) ──
  // A source closes a turn through the turn machine, but never says who stopped
  // it (WHO INTERRUPTED): a caller's `ended_by` is dropped, and an `interrupted`
  // close carries the facade's answer about that very turn.
  function closeTurnFor(cid, turnId, opts) {
    const o = {};
    if (isPlain(opts)) for (const k of Object.keys(opts)) if (k !== 'ended_by') o[k] = opts[k];
    if (o.outcome === 'interrupted') {
      const id = typeof turnId === 'string' ? tm.resolve(turnId) : null;
      const turn = typeof id === 'string' ? model.turn(id) : null;
      const who = turn ? interruptedBy(cid, turn.session_id, id) : null;
      const endedBy = who || (o.by === 'next-turn' ? null : 'terminal');
      if (endedBy) o.ended_by = endedBy;
    }
    return tm.closeTurn(cid, turnId, o);
  }

  const sourceModel = (() => {
    const out = {};
    for (const k of Object.keys(model)) if (!MODEL_HIDDEN.has(k)) out[k] = model[k];
    Object.assign(out, {
      openTurn: tm.openTurn,
      closeTurn: closeTurnFor,
      supersede: tm.supersede,
      openTurnOf: tm.openTurnOf,
      resolveTurn: tm.resolve,
      sessionTurn: tm.sessionTurn,
      turnOfUuid: tm.turnOfUuid,
      segmentOf: tm.segmentOf,
      pendingTurns: tm.pendingTurns,
      attachTurn: tm.attach,
      orphanPending: tm.orphanPending,
      linkState: tm.linkState,
      exportTurns: tm.exportTurns,
      restoreTurns: tm.restoreTurns,
      refill: tm.refill,
      configure: tm.configure,
    });
    return Object.freeze(out);
  })();

  const conversationsView = Object.freeze({
    get: (cid) => conversations.get(cid),
    bySession: (sid) => conversations.bySession(sid),
    list: () => conversations.list(),
    sessionDir: (sid) => conversations.sessionDir(sid),
    transcriptPath: (sid) => conversations.transcriptPath(sid),
    processOf: (cid) => conversations.processOf(cid),
    markFork: (cid, o) => conversations.markFork(cid, o),
    noteTitle: (cid, title) => conversations.noteTitle(cid, title),
  });

  const liveView = Object.freeze({
    liveOf: (id) => {
      const cid = conversationIdOf(id);
      return cid ? model.serializeLive(cid) : null;
    },
    noteActivity: (id, at, kind) => {
      callLive('noteActivity', id, at, kind);
      try { conversations.noteActivity(id, at); } catch (e) { fail('activity', e); }
    },
  });

  const files = Object.freeze({
    transcriptFile: claudeFiles.transcriptFile,
    sessionDirFile: claudeFiles.sessionDirFile,
    taskOutputFile: claudeFiles.taskOutputFile,
    planFile: claudeFiles.planFile,
    readWindow: claudeFiles.readWindow,
  });

  const INERT_WATCH = Object.freeze({
    trigger: () => Promise.resolve(), retarget: () => Promise.resolve(), stop: () => Promise.resolve(), stats: Object.freeze({}),
  });
  function watchFile(file, onTrigger, opts) {
    if (stopped) return INERT_WATCH;
    const w = coreWatchFile(file, onTrigger, opts);
    watchers.add(w);
    return Object.freeze({
      trigger: (src) => w.trigger(src),
      retarget: (next) => w.retarget(next),
      stop: () => { watchers.delete(w); return w.stop(); },
      get stats() { return w.stats; },
    });
  }

  const procs = Object.freeze({ sampleProcs, isPidAlive });

  const mainBusView = mainBus && typeof mainBus.subscribe === 'function' ? Object.freeze({
    subscribe(fn) {
      const off = mainBus.subscribe(fn);
      busSubs.add(off);
      return () => { busSubs.delete(off); off(); };
    },
    read: (q) => (typeof mainBus.read === 'function' ? mainBus.read(q) : { events: [] }),
  }) : null;

  // Every source's persisted slice, for the index store (§2.11): a JSON value,
  // through the redactor, so no index file holds a secret or a known value.
  function sourceStates(sessionId) {
    const out = {};
    for (const s of sources.values()) {
      if (typeof s.inst.persistState !== 'function') continue;
      let v;
      try { v = s.inst.persistState(sessionId); } catch (e) { fail(`${s.name}.persistState`, e); continue; }
      if (v === undefined) continue;
      try { out[s.name] = redactor.value(JSON.parse(JSON.stringify(v))); } catch (e) { fail(`${s.name}.persistState`, e); }
    }
    return out;
  }
  function restoreSourceStates(sessionId, states) {
    if (!isPlain(states)) return;
    for (const name of Object.keys(states)) {
      const s = sources.get(name);
      if (!s || typeof s.inst.restoreState !== 'function') continue;
      try { s.inst.restoreState(sessionId, states[name]); } catch (e) { fail(`${name}.restoreState`, e); }
    }
  }

  // live.js's two decisions (§2.6). A decision says that the turn ended, never
  // who stopped it: its `ended_by` is dropped, and the turn machine asks
  // interruptedBy.
  function statusClosed(decision) {
    try {
      if (!isPlain(decision)) return null;
      const d = {};
      for (const k of Object.keys(decision)) if (k !== 'ended_by') d[k] = decision[k];
      return tm.statusClosed(d);
    } catch (e) {
      fail('statusClosed', e);
      return null;
    }
  }
  function processGone(cid, o) {
    try { tm.processGone(cid, o); } catch (e) { fail('processGone', e); }
    try { conversations.processGone(cid, o); } catch (e) { fail('processGone', e); }
  }

  // A batch of normalized changes from `origin`: the turn machine applies them
  // (the model redacts), then every other source hears them.
  function applyChanges(origin, sessionId, changes, opts) {
    if (stopped) return { ok: false, reason: 'stopped', applied: 0 };
    if (disabled) return { ok: false, reason: 'disabled', applied: 0 };
    const sid = model.cleanId(sessionId);
    if (!sid || !Array.isArray(changes)) return { ok: false, reason: 'bad-batch', applied: 0 };
    const o = isPlain(opts) ? opts : {};
    let cid = o.conversation_id ? model.cleanId(o.conversation_id) : null;
    if (!cid) {
      const v = conversations.bySession(sid);
      cid = v ? v.id : null;
    }
    if (!cid) return { ok: false, reason: 'unknown-session', applied: 0 };
    let r;
    try { r = tm.applyChanges(cid, sid, changes, { mode: o.mode }); } catch (e) { fail('applyChanges', e); return { ok: false, reason: 'error', applied: 0 }; }
    for (const s of [...sources.values()]) if (s.name !== origin) callHook(s, 'onChanges', [sid, changes, { conversation_id: cid }]);
    return r;
  }

  function engineFor(name) {
    return Object.freeze({
      name,
      root,
      paths: p,
      now,
      log: say,
      model: sourceModel,
      applyChanges: (sessionId, changes, opts) => applyChanges(name, sessionId, changes, opts),
      redactor,
      files,
      watchFile,
      conversations: conversationsView,
      live: liveView,
      transition,
      beginIndex: (opts) => emitter.beginIndex(opts),
      reset: (opts) => emitter.reset(opts),
      timers: timers.view,
      sourceStates,
      restoreSourceStates,
      statusClosed,
      processGone,
      procs,
      graph,
      mainBus: mainBusView,
    });
  }

  // ── registration ──
  function register(name, source) {
    if (stopped) throw new Error('mirror.register: the mirror has stopped');
    if (typeof name !== 'string' || !SOURCE_NAME_RE.test(name)) {
      throw new TypeError(`mirror.register: a source's name is one lowercase word (got ${JSON.stringify(name)})`);
    }
    if (sources.has(name)) throw new Error(`mirror.register: a source named ${name} is already registered`);
    let inst;
    if (typeof source === 'function') inst = source(engineFor(name));
    else if (source && typeof source.attach === 'function') inst = source.attach(engineFor(name));
    else throw new TypeError(`mirror.register: ${name} is attach(engine) or {attach(engine)}`);
    if (!inst || typeof inst !== 'object' || typeof inst.start !== 'function' || typeof inst.stop !== 'function') {
      throw new TypeError(`mirror.register: ${name}'s attach must return {start, stop, …}`);
    }
    const api = {};
    if (inst.api && typeof inst.api === 'object') {
      for (const k of Object.keys(inst.api)) if (typeof inst.api[k] === 'function') api[k] = inst.api[k];
    }
    const rec = { name, inst, api: Object.freeze(api), starting: null };
    sources.set(name, rec);
    // Registered after start(): it starts now, unless web-chat is switched off.
    if (running && !disabled) startSource(rec);
    return rec.api;
  }

  function startSource(rec) {
    if (rec.starting) return rec.starting;
    rec.starting = Promise.resolve()
      .then(() => rec.inst.start())
      .then(() => {}, (e) => fail(`${rec.name}.start`, e));
    return rec.starting;
  }
  // A source that never started has nothing to stop.
  function stopSource(rec) {
    if (!rec.starting) return Promise.resolve();
    rec.starting = null;
    return Promise.resolve()
      .then(() => rec.inst.stop())
      .then(() => {}, (e) => fail(`${rec.name}.stop`, e));
  }
  function startSources() {
    return Promise.all([...sources.values()].map(startSource)).then(() => {});
  }
  function stopSources() {
    return Promise.all([...sources.values()].reverse().map(stopSource)).then(() => {});
  }

  // ── the disabled state (§2.2) ──
  function dropContent() {
    for (const c of model.conversations()) {
      const view = model.serializeConversation(c.id);
      try { tm.removeConversation(c.id); } catch (e) { fail('disable', e); }
      each('onConversation', { change: 'removed', conversation: view, reason: 'disabled' });
    }
    interrupts.length = 0;
    seen.clear();
  }

  function onToggle(state) {
    if (stopped || !isPlain(state)) return;
    if (state.enabled === false) {
      const scope = typeof state.scope === 'string' ? state.scope : null;
      if (disabled) { disabled = { scope }; return; }
      disabled = { scope };
      dropContent();
      toggleChain = toggleChain.then(() => stopSources());
      emitter.reset({ reason: 'disabled' });
      return;
    }
    if (!disabled) return;
    disabled = null;
    if (running) toggleChain = toggleChain.then(() => (stopped || disabled ? undefined : startSources()));
    emitter.reset({ reason: 'enabled' });
  }

  // ── who interrupted (§2.6, §15.2) ──
  function onMainEvent(e) {
    if (!isPlain(e) || e.kind !== 'control' || e.op !== 'interrupt') return;
    try { noteInterrupt(e); } catch (err) { fail('control', err); }
  }

  function haltUntil(expires, t) {
    let at = t + HALT_HOLD_MAX_MS;
    if (finite(expires) && expires > 0) at = expires < EPOCH_SECONDS_BELOW ? expires * 1000 : expires;
    return Math.min(at, t + HALT_HOLD_MAX_MS);
  }

  function sameTarget(m, cid, sid) {
    if (m.sid && sid) return m.sid === sid;
    return Boolean(m.cid && cid && m.cid === cid);
  }

  function noteInterrupt(e) {
    const endedBy = typeof e.via === 'string' && own(ENDED_BY_OF_VIA, e.via) ? ENDED_BY_OF_VIA[e.via] : null;
    if (!endedBy) return;
    const sid = typeof e.session_id === 'string' ? model.cleanId(e.session_id) : null;
    let cid = typeof e.conversation_id === 'string' ? model.cleanId(e.conversation_id) : null;
    if (!cid && sid) {
      const v = conversations.bySession(sid);
      cid = v ? v.id : null;
    }
    if (!cid && !sid) return;
    const t = now();
    const until = e.via === 'hook' ? haltUntil(e.expires_at, t) : t + INTERRUPT_HOLD_MS;
    if (!(until > t)) return;
    // The turn this request was about: the one open now.
    const turnId = cid ? tm.openTurnOf(cid) : null;
    for (let i = interrupts.length - 1; i >= 0; i--) if (sameTarget(interrupts[i], cid, sid)) interrupts.splice(i, 1);
    interrupts.push({ sid, cid, endedBy, until, turnId });
    while (interrupts.length > INTERRUPTS_MAX) interrupts.shift();
  }

  // The question at an interrupted close: who stopped the turn? `turnId` is the
  // closing turn when the asker names it (a source's close, through
  // closeTurnFor); the turn machine names none, and the conversation's open turn
  // stands for it (see WHO INTERRUPTED).
  function interruptedBy(cid, sid, turnId) {
    const t = now();
    let closing = null;
    if (typeof turnId === 'string' && turnId) closing = tm.resolve(turnId);
    else if (cid) closing = tm.openTurnOf(cid);
    for (let i = interrupts.length - 1; i >= 0; i--) {
      const m = interrupts[i];
      if (!(m.until > t)) { interrupts.splice(i, 1); continue; }
      if (!sameTarget(m, cid, sid)) continue;
      if (m.turnId && closing && tm.resolve(m.turnId) !== closing) continue; // a request about another turn
      return m.endedBy;
    }
    return null;
  }

  // A turn closed: the requests about it are spent, whatever its outcome.
  function forgetInterrupts(turn) {
    if (!isPlain(turn) || typeof turn.id !== 'string') return;
    for (let i = interrupts.length - 1; i >= 0; i--) {
      const m = interrupts[i];
      const about = m.turnId ? tm.resolve(m.turnId) === turn.id : sameTarget(m, turn.conversation_id, turn.session_id);
      if (about) interrupts.splice(i, 1);
    }
  }

  // ── ingest (§2.12) ──
  function noteEvent(name) {
    if (typeof name !== 'string' || !EVENT_RE.test(name)) return;
    if (!eventsSeen.has(name) && eventsSeen.size >= EVENT_NAMES_MAX) return;
    eventsSeen.set(name, (eventsSeen.get(name) || 0) + 1);
  }

  // A StopFailure's message onto the turn it closed, and into the live state's
  // last_turn when that is this turn (see A FAILED TURN'S MESSAGE).
  function noteFailure(cid, env, out) {
    const stop = isPlain(env.stop) ? env.stop : null;
    const msg = stop && typeof stop.error === 'string' ? stop.error.trim() : '';
    const turnId = isPlain(out) && out.ok === true && typeof out.turn_id === 'string' ? out.turn_id : null;
    if (!msg || !turnId) return;
    const header = model.patchTurn(turnId, { error: cutString(msg, FAILURE_MAX) });
    if (!header || typeof header.error !== 'string') return;
    const cur = model.live(cid);
    if (cur && isPlain(cur.last_turn) && cur.last_turn.id === turnId && cur.last_turn.outcome === 'error') {
      model.upsertLive(cid, { last_turn: { ...cur.last_turn, error: header.error } });
    }
  }

  function ingestEnvelope(env) {
    if (!running || stopped) { ignore('not-running'); return; }
    if (!isPlain(env)) { ignore('bad-envelope'); return; }
    const key = envelopeKey(env);
    if (seen.has(key)) { counters.duplicates += 1; return; }
    remember(seen, key, true, SEEN_MAX);
    let cid = null;
    let sid = null;
    if (env.synthetic === true) {
      // In process only (the tap's intake refuses one over HTTP): about a
      // session the registry already holds.
      sid = typeof env.session_id === 'string' ? model.cleanId(env.session_id) : null;
      const v = sid && !disabled ? conversations.bySession(sid) : null;
      if (!v) { ignore(disabled ? 'disabled' : 'unknown-session'); return; }
      cid = v.id;
    } else {
      const r = conversations.ingest(env);
      if (!isPlain(r) || r.ok !== true) { ignore(isPlain(r) ? r.ignored : null); return; }
      cid = r.conversation_id;
      sid = r.session_id;
    }
    counters.accepted += 1;
    lastHookAt = now();
    noteEvent(env.event);
    let out = null;
    try { out = tm.ingest(cid, env); } catch (e) { fail('turns', e); }
    if (env.event === 'StopFailure') {
      try { noteFailure(cid, env, out); } catch (e) { fail('failure', e); }
    }
    each('onIngest', env, { conversation_id: cid, session_id: sid });
  }

  function ingest(env) {
    try { ingestEnvelope(env); } catch (e) { fail('ingest', e); }
  }

  // ── the facade's own reads, over the model ──
  function capabilities() {
    const can = (name, method) => apiFn(name, method) !== null;
    const out = {};
    for (const key of Object.keys(CAPABILITIES)) {
      let on = false;
      try { on = CAPABILITIES[key](can) === true; } catch { on = false; }
      out[key] = on;
    }
    return out;
  }

  // The conversations a snapshot lists: every one still live, and the ended ones
  // active since `since`. Live before ended, then the most recently active.
  function listed(since) {
    const out = [];
    for (const c of model.conversations()) {
      const live = model.live(c.id);
      const state = live && typeof live.state === 'string' ? live.state : 'unknown';
      const last = Math.max(finite(c.last_activity_at) ? c.last_activity_at : -Infinity,
        live && finite(live.last_activity_at) ? live.last_activity_at : -Infinity);
      const ended = state === 'ended' || finite(c.ended_at);
      if (ended && !(Math.max(last, finite(c.ended_at) ? c.ended_at : -Infinity) >= since)) continue;
      out.push({ id: c.id, headless: c.headless === true, state, ended, last });
    }
    return out.sort((a, b) => (a.ended - b.ended) || (b.last - a.last) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // The primary (§2.10): the most urgent interactive conversation, then the most
  // recently active. A headless one never is (§2.2).
  function primaryOf(entries) {
    let best = null;
    for (const e of entries) {
      if (e.headless) continue;
      const rank = AGGREGATE_ORDER.indexOf(e.state) < 0 ? AGGREGATE_ORDER.length : AGGREGATE_ORDER.indexOf(e.state);
      if (!best || rank < best.rank || (rank === best.rank && e.last > best.last)) best = { id: e.id, rank, last: e.last };
    }
    return best ? best.id : null;
  }

  function versionsSeen() {
    const out = new Set();
    for (const c of model.conversations()) {
      const v = isPlain(c.process) ? c.process.cc_version : null;
      if (typeof v === 'string' && v) out.add(v);
    }
    return [...out];
  }

  function diagnostics() {
    const out = {
      versions_seen: versionsSeen(),
      tested: null,
      skew: null,
      unknown_kinds: {},
      bad_lines: 0,
      hooks: { last_at: lastHookAt, events_seen: Object.fromEntries(eventsSeen), ignored: { ...counters.ignored } },
      sources: { registered: [...sources.keys()] },
    };
    for (const s of sources.values()) {
      if (typeof s.inst.diagnostics !== 'function') continue;
      let d;
      try { d = s.inst.diagnostics(); } catch (e) { fail(`${s.name}.diagnostics`, e); continue; }
      if (!isPlain(d)) continue;
      for (const k of Object.keys(d)) {
        if (k === 'sources' && isPlain(d.sources)) Object.assign(out.sources, d.sources, { registered: out.sources.registered });
        else if (k !== 'hooks' && k !== 'sources') out[k] = d[k];
      }
    }
    return out;
  }

  // GET /api/mirror's body, less the envelope the route adds (v, enabled,
  // content, access). Below `read` only what the route reads there: the primary,
  // the aggregate, the status rows and the asks.
  function snapshot({ level, since } = {}) {
    const lv = level === undefined ? 'local' : level;
    const t = now();
    const status = emitter.status();
    const entries = listed(finite(since) ? since : t - SINCE_DEFAULT_MS);
    const aggregate = { state: status.aggregate.state, conversations: entries.filter((e) => !e.headless && !e.ended).length };
    const head = { now: t, rev: emitter.rev(), primary: primaryOf(entries), aggregate };
    // The asks domain's public views join here in tranche 4 (U66a).
    if (!atLeast(lv, 'read')) return { ...head, conversations: status.conversations, asks: [] };
    return redactOut({
      ...head,
      capabilities: capabilities(),
      conversations: entries.map((e) => emitter.serializeConversation(e.id)).filter(Boolean),
      tasks: model.tasks().map((row) => model.serializeTask(row)).filter(Boolean),
      counts: model.taskCounts(),
      asks: [],
      diagnostics: diagnostics(),
    });
  }

  // {rev, now, aggregate, conversations: [StatusRow]}: content-free by construction.
  function status() {
    return emitter.status();
  }

  function tasks() {
    return redactOut({
      tasks: model.tasks().map((row) => model.serializeTask(row)).filter(Boolean),
      counts: model.taskCounts(),
      rev: emitter.rev(),
    });
  }

  function liveOf(id) {
    const cid = conversationIdOf(id);
    const value = cid ? model.serializeLive(cid) : null;
    return value ? redactOut(value) : null;
  }

  function conversationOfPid(pid) {
    try { return conversations.conversationOfPid(pid); } catch (e) { fail('conversationOfPid', e); return null; }
  }

  function enabled() {
    const s = conversations.enabled();
    return isPlain(s) && s.enabled === false ? { enabled: false, scope: s.scope || null } : { enabled: true };
  }

  function summary() {
    let state = 'none';
    try { state = emitter.status().aggregate.state; } catch (e) { fail('summary', e); }
    return { enabled: !disabled && !stopped, state, conversations: model.conversations().length, last_hook_at: lastHookAt };
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('mirror.subscribe: fn must be a function');
    const off = bus.subscribe((e) => { if (isPlain(e) && e.kind === 'mirror') fn(e); });
    mirrorSubs.add(off);
    return () => { mirrorSubs.delete(off); off(); };
  }

  // ── the dispatch table's methods ──
  function unavailableAnswer(row) {
    return row.async ? Promise.resolve({ unavailable: true }) : { unavailable: true };
  }
  function outOf(row, v) {
    return row.exempt ? v : redactOut(v, { binary: row.binary === true });
  }
  function dispatcher(row) {
    return function dispatch(...args) {
      const fn = stopped ? null : apiFn(row.source, row.method);
      if (!fn) return unavailableAnswer(row);
      const api = sources.get(row.source).api;
      if (row.async) return new Promise((resolve) => { resolve(fn.apply(api, args)); }).then((v) => outOf(row, v));
      let v;
      try {
        v = fn.apply(api, args);
      } catch (e) {
        if (!row.safe) throw e;
        fail(`${row.source}.${row.method}`, e);
        return null;
      }
      return isThenable(v) ? Promise.resolve(v).then((x) => outOf(row, x)) : outOf(row, v);
    };
  }
  const dispatched = {};
  for (const method of Object.keys(DISPATCH)) dispatched[method] = dispatcher(DISPATCH[method]);

  // ── lifecycle ──
  function start() {
    if (startPromise) return startPromise;
    if (stopped) return Promise.resolve();
    running = true;
    if (hooks && typeof hooks.subscribe === 'function') offTap = hooks.subscribe((env) => ingest(env));
    if (mainBus && typeof mainBus.subscribe === 'function') offMain = mainBus.subscribe((e) => onMainEvent(e));
    startPromise = (async () => {
      await conversations.start();
      if (stopped || disabled) return;
      await startSources();
    })().catch((e) => fail('start', e));
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    running = false;
    for (const off of [offTap, offMain, ...mirrorSubs, ...busSubs]) {
      if (typeof off === 'function') { try { off(); } catch { /* already gone */ } }
    }
    offTap = null;
    offMain = null;
    mirrorSubs.clear();
    busSubs.clear();
    stopPromise = (async () => {
      await toggleChain.catch(() => {});
      await stopSources();
      try { await conversations.stop(); } catch (e) { fail('stop', e); }
      if (startPromise) await startPromise;
      await Promise.all([...watchers].map((w) => Promise.resolve().then(() => w.stop()).catch(() => {})));
      watchers.clear();
      try { emitter.flush(); } catch (e) { fail('flush', e); }
      emitter.stop();
      timers.clearAll();
    })();
    return stopPromise;
  }

  function stats() {
    return {
      running,
      stopped,
      enabled: !disabled,
      sources: [...sources.values()].map((s) => ({ name: s.name, started: Boolean(s.starting) })),
      ingest: { accepted: counters.accepted, duplicates: counters.duplicates, ignored: { ...counters.ignored } },
      errors: counters.errors,
      last_hook_at: lastHookAt,
      timers: timers.size(),
      watchers: watchers.size,
      interrupts: interrupts.length,
      emitter: emitter.stats(),
      conversations: conversations.stats(),
      model: model.stats(),
      turns: tm.diagnostics(),
    };
  }

  for (const entry of initialSources) register(entry.name, entry.attach);

  return Object.freeze({
    start,
    stop,
    get ready() { return startPromise || Promise.resolve(); },
    enabled,
    ingest,
    liveOf,
    conversationOfPid,
    subscribe,
    snapshot,
    status,
    tasks,
    summary,
    register,
    stats,
    ...dispatched,
  });
}

module.exports = {
  createMirror,
  SOURCES,
  DISPATCH,
  CAPABILITIES,
  MIRROR_RING,
  SINCE_DEFAULT_MS,
  SEEN_MAX,
  INTERRUPT_HOLD_MS,
  HALT_HOLD_MAX_MS,
  FAILURE_MAX,
};

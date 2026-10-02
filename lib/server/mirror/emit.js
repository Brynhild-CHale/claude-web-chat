// lib/server/mirror/emit.js — the mirror's emission: change collection, the
// 100 ms flush, `rev`, the four frames and the compact ring events (spec §2.9).
//
// THE MIRROR BUS. Everything this file sends goes out on the bus it is handed:
// the MIRROR bus, a second lib/core/bus instance with its own 2,000-entry ring,
// which createServer builds and points at the same WebSocket broadcaster as the
// main bus (lib/server/ws.js projects every `mirror:*` frame per socket, §5.4).
// It is never handed the main bus, and must not be: a turn makes hundreds of
// changes, and in the shared 1,000-event ring they would evict the surface
// events `get_events` and the channel bridge catch up on, and put the
// conversation into Claude's own event log.
//
// CHANGE COLLECTION. The model (model.js) marks every write per conversation, and
// nothing else keeps a change list. `emitter.model` is the model as every writer
// is handed it (the turn machine, live.js, the sources): the same API, except that
// a write also arms the flush, and `takeChanges`, the drain, is this file's alone.
// A write arms ONE timer, FLUSH_MS out, when none is pending; changes that land
// meanwhile coalesce into it. So flushes are at least FLUSH_MS apart, an idle
// mirror holds no timer at all, and a 300-call turn produces at most ten stream
// frames a second.
//
// ONE FLUSH drains the model (`takeChanges({rev})`, which stamps the new rev on
// every changed object) and sends, in this order:
//
//   mirror:status   {type, rev, now, aggregate: {state}, conversations: [StatusRow]}
//                   one, and only when the rows or the aggregate differ from the
//                   last ones sent;
//   then, for each conversation that changed, in one bus.emit:
//     ring event    {kind: 'mirror', op: 'update', conversation_id, rev, items, turns, tasks}
//                   compact and content-free: how many changed, never what;
//     mirror:update {type, rev, now, conversation_id, conversation?, live?, tasks?,
//                    removed_tasks?, removed?, merged_into?}
//     mirror:stream {type, rev, now, conversation_id, turns?, items?, removed_items?}
//   then each mirror:reset that fell due (below), {type, reason, conversation_id?},
//   with its ring event {kind: 'mirror', op: 'reset', reason, conversation_id?},
//   after the changes it covers.
//
// A frame says only what changed: a conversation whose meta and derived counts
// are what was last sent is not sent again, nor is a live state that came back
// the same. A conversation goes out without its `live`, which has a field of its
// own in the frame.
//
// `rev` is one counter per engine, bumped by every flush that drained a change,
// and every object in a frame carries the rev of its last change. The chrome
// applies an object only when its rev is newer than the one it holds, and buffers
// frames that arrive before its snapshot, applying those with a newer rev. A
// conversation can change without a write to it (its turn count, its open turn,
// its running counts are derived), so the rev its frame gave it is kept here, and
// `serializeConversation` hands the snapshot that rev.
//
// STATUSROW is content-free BY CONSTRUCTION: each field is built from a closed
// vocabulary or a number, never copied from a string the model holds:
//
//   {id, state, since, quiet, step_kind, waiting_kind, last_activity_at,
//    ended_reason, counts: {shells, agents, workflows, monitors}}
//
// `state` is one of STATES (else `unknown`); `step_kind` is toolKind()'s head word
// (lib/core/tool-input, the one per-tool table), which collapses every MCP tool to
// `MCP` (a server's name says which services the user connects) and turns
// anything that is not a plain word into `Tool`; `waiting_kind` is one of
// WAITING_KINDS, set only while the state is a wait; `ended_reason` is one
// lowercase word, set only once the state is `ended`; the counts are running
// tasks, integers 0–9,999. A field with no value is left out, not sent as null, so
// a row passes the typed `basic` projection (lib/core/remote-policy `projectValue`,
// §5.3) unchanged: the projection is the second lock, never the first. No label,
// path, command or text can reach a row. A remote viewer who has not opted in
// sees `Working · Edit · 4:12`, and the file's name stays on the host.
//
// The status frame carries every conversation's row (at most STATUS_ROWS_MAX,
// the live interactive ones first), and `aggregate.state` is the most urgent state
// among the interactive ones (AGGREGATE_ORDER; a headless `claude -p` never speaks
// for the project), or `none` when there are none.
//
// INDEX MODE. A catch-up (boot, a reset, a long transcript found late) builds turn
// headers by the hundred, which nobody should receive one frame at a time.
// `beginIndex({conversation_id})` (no id: every conversation) holds back the
// scope's stream frames: no turn or item frame goes out, while its changes are
// still drained and stamped. Status and update frames carry on, so the bar stays
// live. When the outermost `end()` runs, one `mirror:reset` falls due for the
// scope. It goes out at the next flush, after that flush has drained the last of
// the catch-up, and the chrome refetches. `reset({reason, conversation_id})` is
// the same reset for any other cause (the mirror switched off, say), and a
// conversation removed and added back between two flushes gets one too
// (`rebuilt`), since no delta says that. So does a send that failed (`error`): the
// drain has spent those changes and their rev, and no later delta brings them
// back until each object changes again. A conversation whose frames failed, or
// failed to be built, gets one for itself; a status frame that failed gets one for
// every conversation, since it covers them all. Such a reset is due in the same
// flush and goes out at its end. A reset that fails to go out itself stays due
// for the next flush. Nothing re-arms the timer for it, so a broadcaster that
// keeps throwing costs a log line per flush, never a loop.
//
// TRANSITIONS (§2.6) go on the same ring at once, with no frame: `transition(t)`
// is the `transition` hook the turn machine, live.js and the facade are given.
// It keeps `kind: 'mirror'`, an `op`, and fields whose values are numbers,
// booleans, nulls or id-like tokens (the model's `cleanId`: no spaces, slashes or
// text), or short arrays of those. Anything else is dropped and counted, and
// `seq` is the ring's own. So the ring stays compact and content-free whichever
// source writes to it.
//
// The clock and the timers are injected (`now`, `timers.setTimeout` and
// `timers.clearTimeout`). There is one flush timer, armed only while work is
// pending and never for more than FLUSH_MS. It stays ref'd, so a test awaiting a
// frame is never held by an unref'd handle alone (V17), and `stop()` clears it.
// No I/O.
//
// Dependency direction: lib/server; imports lib/core/stable-json and
// lib/core/tool-input only.

const { stableKey } = require('../../core/stable-json');
const { toolKind } = require('../../core/tool-input');

// How long changes coalesce before they go out (spec §2.9).
const FLUSH_MS = 100;

// The live states of the §2.6 machine, in its table's order.
const STATES = Object.freeze(['ended', 'suspended', 'question', 'waiting', 'compacting', 'working', 'idle', 'unknown']);
const STATE_SET = new Set(STATES);
// What a `waiting` state waits on (§2.6 row 3); `question` is its own state.
const WAITING_KINDS = Object.freeze(['permission', 'question', 'plan', 'other']);
const WAITING_SET = new Set(WAITING_KINDS);
// The most urgent first: the one word the aggregate says for every conversation
// (the phone tab's order, §8.3: waiting, then a question, then work).
const AGGREGATE_ORDER = Object.freeze(['waiting', 'question', 'working', 'compacting', 'suspended', 'idle', 'unknown', 'ended']);
const AGGREGATE_NONE = 'none';
// The running counts a row carries, and their range (the `counts` type, §5.3).
const COUNT_KEYS = Object.freeze(['shells', 'agents', 'workflows', 'monitors']);
const COUNT_MAX = 9999;
// The `rows` type holds at most 32 objects (§5.3).
const STATUS_ROWS_MAX = 32;
// A transition's array field (`session_ids`) is short by nature.
const ARRAY_MAX = 64;
// A reset's or an ended row's reason: one lowercase word.
const REASON_RE = /^[a-z][a-z0-9-]{0,23}$/;
// The scope of a catch-up or a reset of every conversation. Never an id: an id
// starts with a letter or a digit.
const ALL = '*';

// The model's methods that only read. Every other method is a write and arms the
// flush: a reader added to the model later costs an empty flush, never a lost
// frame. `takeChanges` is not on the tracked model at all.
const READERS = new Set([
  'scrubText', 'scrubValue', 'cleanId',
  'conversation', 'conversations', 'live',
  'turn', 'turnsOf', 'turnPage',
  'item', 'itemsOf', 'isEvicted',
  'task', 'tasks', 'taskCounts',
  'serializeItem', 'serializeTurn', 'serializeTask', 'serializeConversation', 'serializeLive',
  'stats',
]);

const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function reasonOf(v, fallback) {
  return typeof v === 'string' && REASON_RE.test(v) ? v : fallback;
}

// ---- the status row ------------------------------------------------------------

// A count from the model's taskCounts (`{running, …}`) or a bare number.
function countOf(v) {
  const n = isPlain(v) ? v.running : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.min(COUNT_MAX, Math.max(0, Math.floor(n)));
}

// The tool's head word, never its label: toolKind collapses `mcp__*` to `MCP` and
// anything that is not a plain word to `Tool`. A step with no tool (a reply that
// landed mid-turn, a compaction) names itself the same way.
function stepKindOf(step) {
  if (!isPlain(step)) return null;
  if (typeof step.tool === 'string' && step.tool) return toolKind(step.tool);
  if (typeof step.kind === 'string' && step.kind) return toolKind(step.kind);
  return null;
}

function waitingKindOf(state, waiting) {
  if (state === 'question') return 'question';
  if (state !== 'waiting') return null;
  const kind = isPlain(waiting) ? waiting.kind : null;
  return WAITING_SET.has(kind) ? kind : 'other';
}

// Why an ended conversation ended: live.js's own word when it gives one, else read
// off the process evidence of §2.6 row 1 (a gone process; with no pid known, a
// SessionEnd).
function endedReasonOf(live) {
  if (typeof live.ended_reason === 'string' && REASON_RE.test(live.ended_reason)) return live.ended_reason;
  const proc = isPlain(live.evidence) ? live.evidence.proc : null;
  if (proc === 'gone') return 'process-gone';
  if (proc === 'unknown') return 'session-end';
  return 'unknown';
}

// One conversation's StatusRow from its live object and its task counts. Pure.
function statusRowOf(id, live, counts) {
  const L = isPlain(live) ? live : {};
  const state = STATE_SET.has(L.state) ? L.state : 'unknown';
  const row = { id, state };
  if (Number.isFinite(L.since)) row.since = L.since;
  row.quiet = L.quiet === true || isPlain(L.quiet);
  const step = stepKindOf(L.step);
  if (step) row.step_kind = step;
  const waiting = waitingKindOf(state, L.waiting);
  if (waiting) row.waiting_kind = waiting;
  if (Number.isFinite(L.last_activity_at)) row.last_activity_at = L.last_activity_at;
  if (state === 'ended') row.ended_reason = endedReasonOf(L);
  const c = isPlain(counts) ? counts : {};
  row.counts = {};
  for (const k of COUNT_KEYS) row.counts[k] = countOf(c[k]);
  return row;
}

// The most urgent state among `entries` ({row, headless}) that are not headless,
// or `none`.
function aggregateOf(entries) {
  let best = AGGREGATE_ORDER.length;
  for (const e of entries) {
    if (!e || !e.row || e.headless) continue;
    const r = AGGREGATE_ORDER.indexOf(e.row.state);
    if (r >= 0 && r < best) best = r;
  }
  return best < AGGREGATE_ORDER.length ? AGGREGATE_ORDER[best] : AGGREGATE_NONE;
}

// Live before ended, interactive before headless, the most recently active first:
// the order the rows are sent in, and which ones the cap keeps.
function entryOrder(a, b) {
  const ae = a.row.state === 'ended' ? 1 : 0;
  const be = b.row.state === 'ended' ? 1 : 0;
  if (ae !== be) return ae - be;
  const ah = a.headless ? 1 : 0;
  const bh = b.headless ? 1 : 0;
  if (ah !== bh) return ah - bh;
  const at = Number.isFinite(a.row.last_activity_at) ? a.row.last_activity_at : -Infinity;
  const bt = Number.isFinite(b.row.last_activity_at) ? b.row.last_activity_at : -Infinity;
  if (at !== bt) return at < bt ? 1 : -1;
  return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
}

function statusBodyOf(entries) {
  const list = [...entries].sort(entryOrder);
  return { aggregate: { state: aggregateOf(list) }, conversations: list.slice(0, STATUS_ROWS_MAX).map((e) => e.row) };
}

function bySeq(a, b) {
  return (a.seq - b.seq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ---- the emitter -----------------------------------------------------------------

function createEmitter({ model, bus, now = Date.now, timers = DEFAULT_TIMERS, log = null } = {}) {
  if (!model || typeof model.takeChanges !== 'function' || typeof model.cleanId !== 'function') {
    throw new Error('mirror emit: the mirror model is required (model.js): it holds the changes this file drains');
  }
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('mirror emit: the mirror bus is required (a lib/core/bus instance of its own, never the main bus)');
  }
  if (typeof now !== 'function') throw new Error('mirror emit: `now` must be a clock function');
  if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new Error('mirror emit: `timers` must provide setTimeout and clearTimeout');
  }

  let rev = 0;
  let timer = null;
  let lastFlushAt = -Infinity; // the clock at the last flush that drained a change or sent a reset
  let flushing = false;
  let stopped = false;
  const rows = new Map(); // conversation id → {row, headless}, as of the last flush
  const sentConversation = new Map(); // id → stableKey of the conversation body last sent
  const sentLive = new Map(); // id → stableKey of the live object last sent
  const conversationRevs = new Map(); // id → the rev the frames last gave the conversation
  const indexDepth = new Map(); // scope (an id, or ALL) → open beginIndex calls
  const resetsDue = new Map(); // scope → the reason of the reset it owes
  let lastStatus = null; // stableKey of the status body last sent (set below, before any flush)
  const counters = {
    flushes: 0,
    frames: { status: 0, update: 0, stream: 0, reset: 0 },
    events: { update: 0, reset: 0, transition: 0 },
    dropped: 0,
    errors: 0,
  };

  function note(msg) {
    if (typeof log !== 'function') return;
    try { log(msg); } catch { /* a logger never breaks the emitter */ }
  }
  // Names the stage and the error's kind only: an error's message could quote
  // what it was handling.
  function fail(stage, e) {
    counters.errors += 1;
    note(`mirror emit: ${stage} failed (${(e && (e.code || e.name)) || 'error'})`);
  }

  // ---- timing ----------------------------------------------------------------------
  function schedule() {
    if (stopped || timer !== null) return;
    timer = timers.setTimeout(onTimer, FLUSH_MS);
  }
  // Flushes stay FLUSH_MS apart by the engine's own clock, not by the timer's
  // promise: Node arms a timer against the event loop's cached time, so under
  // load one can fire short of its delay. A timer that fires early waits out the
  // rest, which is less than FLUSH_MS. Only a clock that has moved on since the
  // last flush can measure that rest. One stepped back (an NTP step, a clock set
  // by hand) reads an elapsed time below zero, which says nothing about the
  // spacing, so the timer's own delay stands and the flush goes out now. Waiting
  // for that clock to catch up would hold every frame back for as long as the
  // step, with the bar frozen on whatever it last said.
  function onTimer() {
    timer = null;
    const elapsed = now() - lastFlushAt;
    if (!stopped && elapsed >= 0 && elapsed < FLUSH_MS) {
      timer = timers.setTimeout(onTimer, Math.ceil(FLUSH_MS - elapsed));
      return;
    }
    flush();
  }
  function cancelTimer() {
    if (timer === null) return;
    try { timers.clearTimeout(timer); } catch { /* already gone */ }
    timer = null;
  }

  // ---- sending ---------------------------------------------------------------------
  // True when the bus took the payload. A throw (the broadcaster's) is counted and
  // logged here, and the caller makes a reset due for what the payload carried.
  function send(payload) {
    try {
      bus.emit(payload);
    } catch (e) {
      fail('send', e);
      return false;
    }
    const frames = payload.ws == null ? [] : Array.isArray(payload.ws) ? payload.ws : [payload.ws];
    for (const f of frames) {
      if (f.type === 'mirror:status') counters.frames.status += 1;
      else if (f.type === 'mirror:update') counters.frames.update += 1;
      else if (f.type === 'mirror:stream') counters.frames.stream += 1;
      else if (f.type === 'mirror:reset') counters.frames.reset += 1;
    }
    if (payload.event) {
      if (payload.event.op === 'update') counters.events.update += 1;
      else if (payload.event.op === 'reset') counters.events.reset += 1;
    }
    return true;
  }

  // ---- status rows -------------------------------------------------------------------
  function entryFor(cid) {
    const c = model.conversation(cid);
    if (!c) return null;
    return { row: statusRowOf(cid, model.live(cid), model.taskCounts(cid)), headless: c.headless === true };
  }

  // Rebuild the rows of the conversations that changed, add any the model gained,
  // drop any it lost.
  function syncRows(changes) {
    const touched = new Set();
    for (const ch of changes) touched.add(ch.conversation_id);
    const present = new Set();
    for (const c of model.conversations()) {
      present.add(c.id);
      if (touched.has(c.id) || !rows.has(c.id)) {
        const e = entryFor(c.id);
        if (e) rows.set(c.id, e);
      }
    }
    for (const id of [...rows.keys()]) if (!present.has(id)) rows.delete(id);
  }

  // True when a status frame went out. One that failed makes a reset due for
  // every conversation: the rows it carried cover them all.
  function sendStatus(at) {
    const body = statusBodyOf(rows.values());
    const key = stableKey(body);
    if (key === lastStatus) return false;
    lastStatus = key;
    if (send({ ws: { type: 'mirror:status', rev, now: at, aggregate: body.aggregate, conversations: body.conversations } })) return true;
    owe(ALL, 'error');
    return false;
  }

  // ---- one conversation's frames ---------------------------------------------------------
  function indexing(cid) {
    return indexDepth.has(ALL) || indexDepth.has(cid) || resetsDue.has(ALL) || resetsDue.has(cid);
  }

  function forget(cid) {
    sentConversation.delete(cid);
    sentLive.delete(cid);
    conversationRevs.delete(cid);
  }

  // The conversation as a frame carries it: without `live` (its own field) and
  // without the model's rev (the frame's is its last change).
  function conversationBody(cid) {
    const c = model.serializeConversation(cid);
    if (!c) return null;
    delete c.rev;
    delete c.live;
    return c;
  }

  // One conversation's ring event and frames. False when the bus refused them
  // (the flush then makes a reset due for the conversation).
  function sendConversation(ch, at) {
    const cid = ch.conversation_id;
    const counts = {
      items: ch.items.length + ch.removed_items.length,
      turns: ch.turns.length,
      tasks: ch.tasks.length + ch.removed_tasks.length,
    };
    const event = { kind: 'mirror', op: 'update', conversation_id: cid, rev, ...counts };
    const present = model.conversation(cid) != null;
    if (ch.removed) forget(cid);
    if (ch.removed && !present) {
      const frame = { type: 'mirror:update', rev, now: at, conversation_id: cid, removed: true };
      if (ch.merged_into) frame.merged_into = ch.merged_into;
      return send({ event, ws: frame });
    }
    // Removed and back between two flushes: no delta says that, so the chrome
    // refetches it, and its stream waits for that.
    if (ch.removed) resetsDue.set(cid, 'rebuilt');

    const update = { type: 'mirror:update', rev, now: at, conversation_id: cid };
    let updated = false;
    if (ch.conversation || ch.removed || ch.turns.length || ch.tasks.length || ch.removed_tasks.length) {
      const body = conversationBody(cid);
      if (body) {
        const key = stableKey(body);
        if (key !== sentConversation.get(cid)) {
          sentConversation.set(cid, key);
          conversationRevs.set(cid, rev);
          const { id, ...rest } = body;
          update.conversation = { id, rev, ...rest };
          updated = true;
        }
      }
    }
    if (ch.live) {
      const live = model.serializeLive(cid);
      if (live) {
        const body = { ...live };
        delete body.rev;
        const key = stableKey(body);
        if (key !== sentLive.get(cid)) {
          sentLive.set(cid, key);
          update.live = live;
          updated = true;
        }
      }
    }
    const tasks = ch.tasks.map((id) => model.serializeTask(id)).filter(Boolean);
    if (tasks.length) { update.tasks = tasks; updated = true; }
    if (ch.removed_tasks.length) { update.removed_tasks = [...ch.removed_tasks]; updated = true; }

    let stream = null;
    if (!indexing(cid)) {
      const turns = ch.turns.map((id) => model.serializeTurn(id)).filter(Boolean).sort(bySeq);
      const items = ch.items.map((id) => model.serializeItem(id, { level: 'summary' })).filter(Boolean).sort(bySeq);
      if (turns.length || items.length || ch.removed_items.length) {
        stream = { type: 'mirror:stream', rev, now: at, conversation_id: cid };
        if (turns.length) stream.turns = turns;
        if (items.length) stream.items = items;
        if (ch.removed_items.length) stream.removed_items = [...ch.removed_items];
      }
    }

    const ws = [];
    if (updated) ws.push(update);
    if (stream) ws.push(stream);
    // A write that changed nothing anyone holds (the same live state again) sends nothing.
    if (!ws.length && counts.items + counts.turns + counts.tasks === 0) return true;
    return send({ event, ws: ws.length ? ws : null });
  }

  // ---- resets ----------------------------------------------------------------------
  // Make a reset due for a scope whose frames were lost (see INDEX MODE above). A
  // reset already due for it, or for every conversation, covers it and keeps its
  // own reason.
  function owe(scope, reason) {
    if (resetsDue.has(ALL) || resetsDue.has(scope)) return;
    resetsDue.set(scope, reason);
  }

  function sendReset(reason, cid) {
    const frame = { type: 'mirror:reset', reason };
    const event = { kind: 'mirror', op: 'reset', reason };
    if (cid) {
      frame.conversation_id = cid;
      event.conversation_id = cid;
    }
    return send({ event, ws: frame });
  }

  // A reset that fails to go out stays due, and the next flush sends it.
  function sendDueResets() {
    if (!resetsDue.size) return 0;
    if (indexDepth.has(ALL)) {
      // A catch-up of every conversation is still running: the reset its end
      // brings covers every scope.
      for (const scope of [...resetsDue.keys()]) if (scope !== ALL) resetsDue.delete(scope);
      return 0;
    }
    if (resetsDue.has(ALL)) {
      const reason = resetsDue.get(ALL);
      resetsDue.clear();
      if (sendReset(reason, null)) return 1;
      owe(ALL, reason);
      return 0;
    }
    let n = 0;
    for (const [scope, reason] of [...resetsDue]) {
      if (indexDepth.has(scope)) continue; // indexing again: one reset, when that ends
      resetsDue.delete(scope);
      if (sendReset(reason, scope)) n += 1;
      else owe(scope, reason);
    }
    return n;
  }

  // ---- the flush ---------------------------------------------------------------------
  // Drain, frame and send now. The timer calls it, spaced as above; a caller that
  // calls it directly (the facade before it stops, a test) chooses the moment.
  // Returns what went out ({rev, status, conversations, resets}), or null.
  function flush() {
    if (stopped) return null;
    if (flushing) { schedule(); return null; } // a subscriber wrote during the flush: the next one takes it
    flushing = true;
    cancelTimer();
    let out = null;
    try {
      let changes = [];
      try { changes = model.takeChanges({ rev: rev + 1 }) || []; } catch (e) { fail('drain', e); }
      if (changes.length) {
        rev += 1;
        counters.flushes += 1;
        const at = now();
        lastFlushAt = at;
        out = { rev, status: false, conversations: changes.length, resets: 0 };
        syncRows(changes);
        out.status = sendStatus(at);
        for (const ch of changes) {
          let sent = false;
          try { sent = sendConversation(ch, at); } catch (e) { fail('frame', e); }
          if (!sent) owe(ch.conversation_id, 'error');
        }
      }
      const resets = sendDueResets();
      if (resets) {
        if (!out) {
          out = { rev, status: false, conversations: 0, resets: 0 };
          lastFlushAt = now();
        }
        out.resets = resets;
      }
    } finally {
      flushing = false;
    }
    return out;
  }

  // ---- index mode and resets ------------------------------------------------------------
  function scopeOf(cid) {
    if (cid === undefined || cid === null) return ALL;
    return typeof cid === 'string' ? model.cleanId(cid) : null;
  }

  // Hold back the scope's stream frames until the returned `end()`; the outermost
  // end makes one mirror:reset due. Nested calls nest; `end()` is idempotent.
  function beginIndex({ conversation_id: cid = null, reason = 'catch-up' } = {}) {
    const scope = scopeOf(cid);
    if (!scope) {
      note('mirror emit: beginIndex ignored a malformed conversation id');
      return () => {};
    }
    const why = reasonOf(reason, 'catch-up');
    indexDepth.set(scope, (indexDepth.get(scope) || 0) + 1);
    let ended = false;
    return function endIndex() {
      if (ended) return;
      ended = true;
      const depth = (indexDepth.get(scope) || 1) - 1;
      if (depth > 0) { indexDepth.set(scope, depth); return; }
      indexDepth.delete(scope);
      if (stopped) return;
      resetsDue.set(scope, why);
      schedule();
    };
  }

  // One mirror:reset for the scope at the next flush, after the changes it covers
  // (whose stream frames it replaces). The latest reason wins.
  function reset({ reason, conversation_id: cid = null } = {}) {
    if (stopped) return false;
    const scope = scopeOf(cid);
    if (!scope) return false;
    resetsDue.set(scope, reasonOf(reason, 'reset'));
    schedule();
    return true;
  }

  // ---- transitions ------------------------------------------------------------------
  function compactScalar(v) {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string') {
      const s = model.cleanId(v);
      return s === null ? undefined : s;
    }
    return undefined;
  }
  function compactValue(v) {
    if (!Array.isArray(v)) return compactScalar(v);
    const out = [];
    for (const x of v.slice(0, ARRAY_MAX)) {
      const y = compactScalar(x);
      if (y !== undefined) out.push(y);
    }
    return out;
  }

  // A §2.6 transition onto the mirror ring, now, with no frame. Returns the ring
  // entry, or null when nothing was sent.
  function transition(t) {
    if (stopped || !isPlain(t)) return null;
    const op = typeof t.op === 'string' ? model.cleanId(t.op) : null;
    if (!op) { counters.dropped += 1; return null; }
    const event = { kind: 'mirror', op };
    for (const k of Object.keys(t)) {
      if (k === 'kind' || k === 'op') continue;
      if (k === 'seq' || model.cleanId(k) !== k) { counters.dropped += 1; continue; }
      const v = compactValue(t[k]);
      if (v === undefined) { counters.dropped += 1; continue; }
      event[k] = v;
    }
    let built = null;
    try {
      built = bus.emit({ event });
    } catch (e) {
      fail('transition', e);
      return null;
    }
    counters.events.transition += 1;
    return built;
  }

  // ---- the model, as writers are handed it ----------------------------------------------
  function arming(fn, self) {
    return function write(...args) {
      try { return fn.apply(self, args); } finally { schedule(); }
    };
  }
  function trackWriter(writer) {
    const out = {};
    for (const name of Object.keys(writer)) {
      const member = writer[name];
      out[name] = typeof member === 'function' ? arming(member, writer) : member;
    }
    return Object.freeze(out);
  }
  function trackModel() {
    const view = {};
    for (const name of Object.keys(model)) {
      const member = model[name];
      if (name === 'takeChanges') continue;
      if (typeof member !== 'function' || READERS.has(name)) view[name] = member;
      else if (name === 'claimTurnWriter') view[name] = (...args) => trackWriter(member.apply(model, args));
      else view[name] = arming(member, model);
    }
    return Object.freeze(view);
  }
  const tracked = trackModel();

  // ---- reads for the facade ------------------------------------------------------------
  // The status as the route serves it, built from the model now.
  function status() {
    const entries = [];
    for (const c of model.conversations()) {
      const e = entryFor(c.id);
      if (e) entries.push(e);
    }
    const body = statusBodyOf(entries);
    return { rev, now: now(), aggregate: body.aggregate, conversations: body.conversations };
  }

  function statusRow(cid) {
    const e = typeof cid === 'string' ? entryFor(cid) : null;
    return e ? e.row : null;
  }

  // The snapshot's Conversation, with the rev the frames last gave it when that is
  // newer than the model's (a derived field changed with no write to it).
  function serializeConversation(cid) {
    const c = model.serializeConversation(cid);
    if (!c) return null;
    const sent = conversationRevs.get(c.id);
    if (Number.isFinite(sent) && sent > c.rev) c.rev = sent;
    return c;
  }

  function stop() {
    stopped = true;
    cancelTimer();
    indexDepth.clear();
    resetsDue.clear();
  }

  function stats() {
    return {
      rev,
      pending: timer !== null,
      flushes: counters.flushes,
      frames: { ...counters.frames },
      events: { ...counters.events },
      dropped: counters.dropped,
      errors: counters.errors,
      indexing: indexDepth.size,
      resets_due: resetsDue.size,
    };
  }

  // What the chrome already holds when the emitter starts: whatever the model
  // held (an index restored before it). The first status frame goes out when that
  // changes.
  syncRows([]);
  lastStatus = stableKey(statusBodyOf(rows.values()));

  return Object.freeze({
    model: tracked,
    schedule,
    flush,
    transition,
    reset,
    beginIndex,
    rev: () => rev,
    status,
    statusRow,
    serializeConversation,
    stop,
    stats,
  });
}

module.exports = {
  createEmitter,
  statusRowOf,
  aggregateOf,
  FLUSH_MS,
  STATES,
  WAITING_KINDS,
  AGGREGATE_ORDER,
  AGGREGATE_NONE,
  COUNT_KEYS,
  COUNT_MAX,
  STATUS_ROWS_MAX,
};

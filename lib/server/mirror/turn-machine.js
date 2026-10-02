// lib/server/mirror/turn-machine.js — the mirror's turns: open, bind, alias,
// close, supersede, and the graph-link state of each closed turn (spec §2.4
// "Turns" rules 1–6, §2.6 "Who interrupted", §15.4).
//
// A turn is a prompt and everything up to its end. Two streams describe it and
// neither is enough alone: HOOKS (`ingest`) are live but carry no content, and the
// TRANSCRIPT (`applyChanges`, normalized records) is durable but lags by about a
// record (V1, V3). The rules, in the order the spec numbers them:
//
//   1. Hook open. A UserPromptSubmit opens a PROVISIONAL turn (id = the hook's
//      prompt_id, else `h_<ts>`) with a provisional prompt item — unless it is a
//      task notification while a turn is open, which is absorbed (V3). An open
//      turn without a Stop closes `interrupted` by `next-turn`.
//   2. Opener binding. A transcript opener binds the unbound provisional turn:
//      under the same id when promptId equals prompt_id, else by order — the
//      oldest holding the opener's prompt, else the oldest — with ONE alias (the
//      turn takes the transcript's id; its header says `replaces`, its
//      provisional items are re-keyed). An opener with no provisional turn opens
//      a transcript turn. A hook that arrives after the transcript opened its
//      turn joins it (same id, or the same prompt).
//   3. Close, the first of: Stop (`done`; its last_assistant_message becomes a
//      provisional reply, removed when the transcript's lands); turn_duration;
//      StopFailure (`error`); live.js's `turn-closed {by:'status'}`, CONSUMED
//      here through `statusClosed` and never derived here (live.js alone decides
//      that an idle flip with no Stop ended the turn); an interrupt marker then
//      turn_duration (`interrupted`); the next opener; the process gone
//      (`abandoned`). Every close emits exactly one `turn-closed` transition.
//   4. Rewinds. `supersede` is the ONE operation that marks turns `superseded`
//      and adds the `rewound` notice; it is idempotent. A branch (an opener whose
//      parent is not the chain's leaf) is detected here; the rewinds source (U78)
//      calls the same `supersede` for a reset or an anchor. A compaction is never
//      a rewind.
//   5. Compaction adds a compaction item; its boundary and preserved tail keep
//      the chain continuous.
//   6. Agent files (`mode: 'agent'`) are one turn per file; per-block records
//      with stop_reason null close nothing; a workflow agent's first user record
//      may be the `[Workflow harness — user request]` relay, and then the real
//      prompt is the next record, unframed.
//
// WHO INTERRUPTED (§2.6). `closeTurn` takes `ended_by` ('terminal'|'web'|'hook')
// and the header carries it — for an `interrupted` outcome only, and absent
// otherwise. The facade remembers the main bus's `control` interrupt events and
// hands them in as `interruptedBy(conversation_id, session_id)`; an interrupt seen
// by the status machine or the transcript's marker with no such event is
// 'terminal'. An inferred interruption (the next prompt arrived with no Stop)
// carries it only when a control event names one.
//
// THE TRANSCRIPT CHANGE CONTRACT (what the normalizer, U26, hands `applyChanges`
// in file order). Every change may carry `uuid` and `parent_uuid` (the record's),
// `ts` (ms), `seq` (an ordinal) and `offset: {start, end}` (byte offsets in the
// session's file). A record whose kind is otherwise dropped should still be
// forwarded as `{type: 'record', uuid}` so the chain's leaf is exact.
//   {type: 'opener', prompt_id, kind, text, origin?, author?, command?, attachments?}
//       kind: 'prompt'|'task-notification'|'channel'|'command'|'shell'|'other'
//   {type: 'item', item: {id, kind, …}, context?: {file, command}, stop_reason?}
//   {type: 'turn-duration', duration_ms}
//   {type: 'interrupt', text?}                        user/interrupt-marker
//   {type: 'compact', trigger?, tokens?, duration_ms?, summary?, tail_uuid?}
//   {type: 'compact-summary', parent_uuid, text}     user/compact-summary
//   {type: 'permission-decision', tool_use_id, decision}
//   {type: 'record'}
// Items are placed by position: in the session's current transcript turn.
//
// Pure and in memory: no I/O and no timers. Side effects leave through the
// injected `transition`, `onTurnOpened` and `onTurnClosed`, called after each
// public call has finished updating state.

const { ORIGIN_OF_KIND } = require('./model');

const ENDED_BY = new Set(['terminal', 'web', 'hook']);
const OUTCOMES = new Set(['done', 'interrupted', 'error', 'abandoned']);
const CLOSE_BY = new Set(['stop', 'transcript', 'status', 'next-turn', 'process-gone']);
const TURN_KINDS = new Set(['prompt', 'task-notification', 'channel', 'command', 'shell', 'other']);
const AUTHORS = new Set(['user', 'web', 'channel', 'parked', 'task-notification', 'system']);
const ORIGINS = new Set(['human', 'channel', 'task-notification', 'command', 'shell', 'queued', 'other']);
const REWIND_REASONS = new Set(['branch', 'reset', 'anchor']);
const LINKS = new Set(['open', 'pending', 'attached', 'orphaned']);
const STOP_REASONS_THAT_CONTINUE = new Set(['tool_use', 'pause_turn']);
// `author` is derived (§2.4): `web` and `parked` come from the opener (the
// normalizer reads the markers); otherwise it follows the turn's kind.
const AUTHOR_OF_KIND = Object.freeze({ prompt: 'user', 'task-notification': 'task-notification', channel: 'channel',
  command: 'system', shell: 'user', other: 'user' });
const REWIND_TEXT = Object.freeze({ branch: 'Rewound in the terminal', reset: 'Conversation reset', anchor: 'Rewound' });
const ASK_KIND_OF_TOOL = Object.freeze({ AskUserQuestion: 'question', ExitPlanMode: 'plan' });

// The workflow relay (rule 6), as rebuild_wf.py reads it.
const USER_REQUEST_FRAME = '[Workflow harness — user request]';
const FRAME_MARK = 'The computed task text follows:';

// A late hook event (a Stop the status machine beat, an async PostToolUse) is
// matched to the session's latest turn only this close to its end — the turn
// guard's late-Stop window (§3.3).
const LATE_EVENT_MS = 60000;
const UUID_MAP_MAX = 50000;
const TAILS_MAX = 64;

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isRelay(text) { return typeof text === 'string' && text.startsWith(USER_REQUEST_FRAME); }

// A workflow agent's prompt arrives wrapped in a harness frame; the script's
// prompt follows FRAME_MARK, indented two spaces. Unframed text is returned as is.
function unframe(text) {
  if (typeof text !== 'string') return text;
  const at = text.indexOf(FRAME_MARK);
  if (at < 0) return text;
  const body = text.slice(at + FRAME_MARK.length).replace(/^\n+/, '');
  return body.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n').trim();
}

function createTurnMachine({
  model,
  now = Date.now,
  interruptedBy = () => null,
  transition = null,
  onTurnOpened = null,
  onTurnClosed = null,
} = {}) {
  if (!model || typeof model.claimTurnWriter !== 'function') throw new Error('turn machine: a mirror model is required');
  const w = model.claimTurnWriter();

  const tstate = new Map(); // turn id → per-turn state (below)
  const sessions = new Map(); // session id → { cid, tx, leaf, lastCloseTs, tails }
  const convs = new Map(); // conversation id → { mode, nextSeq, open }
  const aliases = new Map(); // a retired turn id (an alias, a reverse binding) → the turn it names
  // A hook event's prompt_id that named no turn and was routed to the open turn:
  // a guess, followed by hook routing only. A transcript opener never resolves
  // through it (the transcript knows its own turns), and replaces it.
  const softAliases = new Map();
  const uuidTurn = new Map(); // record uuid → turn id (bounded, oldest out)
  const diagnostics = { unknown_changes: 0, items_without_turn: 0, foreign_turns: 0, ignored_envelopes: 0 };
  const queue = [];
  let depth = 0;

  // Side effects run after the outermost public call has finished, so a callback
  // that reads the model (or calls back in) always sees a consistent state.
  function run(fn) {
    depth += 1;
    let out;
    try { out = fn(); } finally { depth -= 1; }
    if (depth === 0) flush();
    return out;
  }
  function flush() {
    while (queue.length) {
      const [fn, arg] = queue.shift();
      if (typeof fn === 'function') { try { fn(arg); } catch { /* a listener never breaks the machine */ } }
    }
  }

  const cleanId = (v) => model.cleanId(v);
  const tsOf = (x) => (x && Number.isFinite(x.ts) ? x.ts : now());

  function conv(cid) {
    let c = convs.get(cid);
    if (!c) {
      c = { mode: 'main', nextSeq: 1, open: null };
      for (const t of model.turnsOf(cid)) {
        if (t.seq >= c.nextSeq) c.nextSeq = Math.floor(t.seq) + 1;
        if (t.status === 'open') c.open = t.id;
      }
      convs.set(cid, c);
    }
    return c;
  }

  function session(sid, cid) {
    let s = sessions.get(sid);
    if (!s) { s = { cid, tx: null, leaf: null, lastCloseTs: 0, tails: new Set() }; sessions.set(sid, s); }
    else s.cid = cid;
    return s;
  }

  function initState(id, cid, sid) {
    const st = { cid, sid, bound: false, hook: false, closedBy: null, interrupt: false, opener: null, parent: undefined,
      last: null, segment: null, link: 'open', rewind: null, relay: false, realPrompt: false, firstSeq: null };
    tstate.set(id, st);
    return st;
  }
  function stateOf(id) {
    let st = tstate.get(id);
    if (!st) { const t = model.turn(id); if (!t) return null; st = initState(id, t.conversation_id, t.session_id); if (t.status !== 'open') st.link = 'pending'; }
    return st;
  }

  function resolveId(id) {
    let cur = id;
    for (let hops = 0; cur != null && aliases.has(cur) && hops < 8; hops++) cur = aliases.get(cur);
    return cur;
  }
  // Hook routing also follows a soft alias (see `softAliases`).
  function resolveHook(id) {
    const hard = resolveId(id);
    if (hard == null || model.turn(hard) || !softAliases.has(hard)) return hard;
    return resolveId(softAliases.get(hard));
  }

  function freshId(base) {
    let id = base;
    for (let n = 2; model.turn(id) || aliases.has(id); n++) id = `${base}_${n}`;
    return id;
  }

  function interrupter(cid, sid) {
    let v = null;
    try { v = interruptedBy(cid, sid); } catch { v = null; }
    return ENDED_BY.has(v) ? v : undefined;
  }

  function latestTurnOf(cid, sid) {
    const list = model.turnsOf(cid, { session_id: sid });
    return list.length ? list[list.length - 1].id : null;
  }

  function noteUuid(uuid, tid) {
    if (uuidTurn.has(uuid)) uuidTurn.delete(uuid);
    uuidTurn.set(uuid, tid);
    if (uuidTurn.size > UUID_MAP_MAX) uuidTurn.delete(uuidTurn.keys().next().value);
  }

  // Every change moves the chain's leaf and grows its turn's byte segment.
  function noteRecord(s, ch, tid) {
    const uuid = cleanId(ch.uuid);
    if (uuid) {
      s.leaf = uuid;
      if (tid) { noteUuid(uuid, tid); const st = tstate.get(tid); if (st) st.last = uuid; }
    }
    const o = ch.offset;
    if (tid && isPlain(o) && Number.isFinite(o.start) && Number.isFinite(o.end)) {
      const st = tstate.get(tid);
      if (st) st.segment = st.segment ? { from: Math.min(st.segment.from, o.start), to: Math.max(st.segment.to, o.end) }
        : { from: o.start, to: o.end };
    }
  }

  function addTail(s, uuid) {
    s.tails.add(uuid);
    if (s.tails.size > TAILS_MAX) s.tails.delete(s.tails.values().next().value);
  }

  // ---- the two primitives ------------------------------------------------------
  // Open a turn. A conversation has one open turn: another one still open is
  // closed `interrupted` by `next-turn` first (rule 1).
  function openTurn(cid, spec = {}) {
    return run(() => {
      const conversationId = cleanId(cid);
      const id = cleanId(spec.id);
      if (!conversationId || !id || model.turn(id) || aliases.has(id)) return null;
      const c = conv(conversationId);
      const started = Number.isFinite(spec.started_at) ? spec.started_at : now();
      if (c.open && c.open !== id) {
        const prev = model.turn(c.open);
        closeTurn(conversationId, c.open, { outcome: 'interrupted', by: 'next-turn', at: started,
          ended_by: interrupter(conversationId, prev ? prev.session_id : null) });
      }
      const kind = TURN_KINDS.has(spec.kind) ? spec.kind : 'prompt';
      const sid = cleanId(spec.session_id);
      const header = w.putTurn({
        id, conversation_id: conversationId, session_id: sid, seq: c.nextSeq, kind,
        author: AUTHORS.has(spec.author) ? spec.author : AUTHOR_OF_KIND[kind],
        status: 'open', started_at: started, provisional: spec.provisional ? true : null,
      });
      if (!header) return null;
      c.nextSeq += 1;
      initState(id, conversationId, sid);
      c.open = id;
      queue.push([transition, { kind: 'mirror', op: 'turn-open', conversation_id: conversationId, session_id: sid, turn_id: id }]);
      queue.push([onTurnOpened, model.serializeTurn(id)]);
      return header;
    });
  }

  // Close a turn: the first close wins. `ended_by` is set on an interrupted
  // turn's header when given, and absent otherwise.
  function closeTurn(cid, turnId, { outcome = 'done', by = 'transcript', at, ended_by, duration_ms } = {}) {
    return run(() => {
      const id = resolveId(turnId);
      const t = id ? model.turn(id) : null;
      if (!t || t.conversation_id !== cid || t.status !== 'open') return null;
      const o = OUTCOMES.has(outcome) ? outcome : 'done';
      const b = CLOSE_BY.has(by) ? by : 'transcript';
      const patch = { id, status: o, ended_at: Number.isFinite(at) ? at : now() };
      if (Number.isFinite(duration_ms)) patch.duration_ms = duration_ms;
      if (o === 'interrupted' && ENDED_BY.has(ended_by)) patch.ended_by = ended_by;
      const header = w.putTurn(patch);
      const st = stateOf(id);
      st.closedBy = b;
      if (st.link === 'open') st.link = 'pending';
      const c = conv(cid);
      if (c.open === id) c.open = null;
      const tr = { kind: 'mirror', op: 'turn-closed', conversation_id: cid, session_id: t.session_id, turn_id: id, outcome: o, by: b };
      if (header.ended_by) tr.ended_by = header.ended_by;
      queue.push([transition, tr]);
      queue.push([onTurnClosed, model.serializeTurn(id)]);
      return header;
    });
  }

  // ---- rule 4: the one supersede ---------------------------------------------------
  // Mark the turns from `fromTurnId` on — within its session, up to `until`
  // (exclusive) or `through` (inclusive), else to the newest — `superseded`, and
  // put one `rewound` notice at the top of the first. The rewind is recorded on
  // that turn: a second call for it changes nothing, and neither does a call whose
  // turns are all superseded already.
  function supersede(cid, fromTurnId, { reason = 'branch', at, until, through } = {}) {
    return run(() => {
      const conversationId = cleanId(cid);
      const from = resolveId(fromTurnId);
      const ft = from ? model.turn(from) : null;
      if (!ft || ft.conversation_id !== conversationId) return { ok: false, reason: 'unknown-turn', superseded: [] };
      const st = stateOf(from);
      if (st.rewind) return { ok: true, superseded: [] };
      const why = REWIND_REASONS.has(reason) ? reason : 'branch';
      const when = Number.isFinite(at) ? at : now();
      const stopAt = until ? resolveId(until) : null;
      const endAt = through ? resolveId(through) : null;
      const list = model.turnsOf(conversationId).filter((t) => t.session_id === ft.session_id);
      const range = [];
      let started = false;
      let back = null;
      for (const t of list) {
        if (t.id === from) started = true;
        if (!started) { if (!t.superseded) back = t.id; continue; }
        if (stopAt && t.id === stopAt) break;
        range.push(t.id);
        if (endAt && t.id === endAt) break;
      }
      const fresh = range.filter((id) => !model.turn(id).superseded);
      if (!fresh.length) return { ok: true, superseded: [] };
      const changed = w.markSuperseded(fresh);
      st.rewind = { reason: why, at: when, through: range[range.length - 1] };
      model.upsertItem(rewoundItem(from, st));
      return { ok: true, superseded: changed, notice: `rw_${from}`, returned_to: back };
    });
  }

  function rewoundItem(from, st) {
    const list = model.turnsOf(st.cid).filter((t) => t.session_id === st.sid);
    let back = null;
    for (const t of list) { if (t.id === from) break; if (!t.superseded) back = t.id; }
    let first = st.firstSeq;
    for (const it of model.itemsOf(from) || []) {
      if (it.id === `rw_${from}`) continue;
      first = first == null ? it.seq : Math.min(first, it.seq);
      break;
    }
    return {
      id: `rw_${from}`, turn_id: from, kind: 'notice', notice: 'rewound', text: REWIND_TEXT[st.rewind.reason],
      reason: st.rewind.reason, at: st.rewind.at, returned_to: back, through_turn_id: st.rewind.through,
      source: 'transcript', ts: st.rewind.at, seq: (Number.isFinite(first) ? first : 0) - 0.5,
    };
  }

  // Rule 4 (a): is this opener a branch? Two readings, the first that answers:
  // the opener re-asks turn K in place (its parent is K's opener's parent: a
  // rewind to K's prompt), or its parent is a record of an earlier turn with live
  // turns after it. An unknown parent, the leaf itself, or a compaction's boundary
  // or preserved tail is never a rewind.
  function branchPoint(cid, s, sid, ch, target) {
    if (!('parent_uuid' in ch)) return null;
    const p = ch.parent_uuid === null ? null : cleanId(ch.parent_uuid);
    if (ch.parent_uuid !== null && !p) return null;
    if (p !== null && (p === s.leaf || s.tails.has(p))) return null;
    const list = model.turnsOf(cid, { session_id: sid })
      .filter((t) => t.id !== target && tstate.get(t.id) && tstate.get(t.id).bound);
    const sib = list.findIndex((t) => !t.superseded && tstate.get(t.id).parent === p);
    if (sib >= 0) return { from: list[sib].id };
    if (p === null) return null;
    let tp = uuidTurn.has(p) ? resolveId(uuidTurn.get(p)) : null;
    if (!tp) for (const t of list) { const st = tstate.get(t.id); if (st.last === p || st.opener === p) tp = t.id; }
    if (!tp) return null;
    const at = list.findIndex((t) => t.id === tp);
    if (at < 0) return null;
    const after = list.slice(at + 1).filter((t) => !t.superseded);
    return after.length ? { from: after[0].id } : null;
  }

  // ---- rule 2: openers ----------------------------------------------------------
  function retire(oldId, newId) {
    aliases.set(oldId, newId);
    for (const [k, v] of aliases) if (v === oldId) aliases.set(k, newId);
    for (const [k, v] of softAliases) if (v === oldId) softAliases.set(k, newId);
    const st = tstate.get(oldId);
    tstate.delete(oldId);
    if (st) tstate.set(newId, st);
    for (const c of convs.values()) if (c.open === oldId) c.open = newId;
    for (const s of sessions.values()) if (s.tx === oldId) s.tx = newId;
  }

  // The unbound provisional turn an opener binds when its id names none (§2.4
  // rule 2, "by order"): the oldest whose prompt is the opener's, else the oldest.
  // The text match keeps one provisional turn whose transcript record never came
  // from capturing the next prompt's.
  function unboundFor(cid, sid, text) {
    let first = null;
    for (const t of model.turnsOf(cid)) {
      if (!t.provisional || t.superseded) continue;
      if (t.session_id && t.session_id !== sid) continue;
      const st = tstate.get(t.id);
      if (st && st.bound) continue;
      if (samePrompt(t.id, text, { either: true })) return t.id;
      if (!first) first = t.id;
    }
    return first;
  }

  function promptItemFor(id, ch, kind, text) {
    const it = { id: `p_${id}`, turn_id: id, kind: 'prompt', text: typeof text === 'string' ? text : '',
      origin: ORIGINS.has(ch.origin) ? ch.origin : ORIGIN_OF_KIND[kind], source: 'transcript', ts: tsOf(ch) };
    if (typeof ch.command === 'string') it.command = ch.command;
    if (Array.isArray(ch.attachments)) it.attachments = ch.attachments;
    if (Number.isFinite(ch.seq)) it.seq = ch.seq;
    return it;
  }

  function bind(cid, s, sid, id, ch, kind) {
    const st = stateOf(id);
    const t = model.turn(id);
    const ts = tsOf(ch);
    const patch = { id, provisional: null, kind, author: AUTHORS.has(ch.author) ? ch.author : AUTHOR_OF_KIND[kind] };
    if (!Number.isFinite(t.started_at) || ts < t.started_at) patch.started_at = ts;
    if (!t.session_id) patch.session_id = sid;
    w.putTurn(patch);
    st.bound = true;
    st.opener = cleanId(ch.uuid);
    if ('parent_uuid' in ch) st.parent = ch.parent_uuid === null ? null : cleanId(ch.parent_uuid);
    s.tx = id;
    const it = model.upsertItem(promptItemFor(id, ch, kind, ch.text));
    if (it && st.firstSeq == null) st.firstSeq = it.seq;
    noteRecord(s, ch, id);
  }

  function opener(cid, s, sid, ch) {
    const c = conv(cid);
    if (c.mode === 'agent') return agentOpener(cid, s, sid, ch);
    const kind = TURN_KINDS.has(ch.kind) ? ch.kind : 'prompt';
    const uuid = cleanId(ch.uuid);
    const pid = cleanId(ch.prompt_id) || (uuid ? `u_${uuid}` : null);
    if (!pid) { noteRecord(s, ch, s.tx); return; }
    softAliases.delete(pid); // the transcript names its own turn: a hook's guess about this id is void
    const known = resolveId(pid);
    const kt = known ? model.turn(known) : null;
    if (kt && kt.conversation_id !== cid) { diagnostics.foreign_turns += 1; noteRecord(s, ch, null); return; }
    if (kt && stateOf(known).bound) { s.tx = known; noteRecord(s, ch, known); return; } // a re-read
    // A task notification while the turn is open is absorbed (rule 1, read from the transcript).
    if (!kt && kind === 'task-notification') {
      const cur = s.tx ? model.turn(s.tx) : null;
      if (cur && cur.status === 'open') { noteRecord(s, ch, s.tx); return; }
    }
    const target = kt ? known : unboundFor(cid, sid, ch.text);
    const ts = tsOf(ch);
    const branch = branchPoint(cid, s, sid, ch, target);
    if (branch) supersede(cid, branch.from, { reason: 'branch', at: ts, until: target || undefined });
    let id = target;
    if (id) {
      if (id !== pid && !model.turn(pid) && !aliases.has(pid) && w.renameTurn(id, pid)) { retire(id, pid); id = pid; }
    } else {
      if (c.open) closeByNextOpener(cid, c.open, ts);
      const header = openTurn(cid, { id: pid, session_id: sid, kind, author: ch.author, started_at: ts });
      if (!header) { noteRecord(s, ch, s.tx); return; }
      id = header.id;
    }
    bind(cid, s, sid, id, ch, kind);
  }

  function closeByNextOpener(cid, id, ts) {
    const st = stateOf(id);
    if (st && st.interrupt) {
      closeTurn(cid, id, { outcome: 'interrupted', by: 'next-turn', at: ts, ended_by: interrupter(cid, st.sid) || 'terminal' });
    } else {
      closeTurn(cid, id, { outcome: 'done', by: 'next-turn', at: ts });
    }
  }

  // Rule 6: an agent's file is ONE turn. Its first opener opens it; a workflow
  // relay defers the prompt to the next record; later user records are items.
  function agentOpener(cid, s, sid, ch) {
    const existing = latestTurnOf(cid, sid);
    const uuid = cleanId(ch.uuid);
    if (!existing) {
      const id = cleanId(ch.prompt_id) || (uuid ? `a_${uuid}` : `a_${sid}`);
      const header = openTurn(cid, { id, session_id: sid, kind: 'prompt', author: 'system', started_at: tsOf(ch) });
      if (!header) { noteRecord(s, ch, null); return; }
      const st = stateOf(header.id);
      st.bound = true;
      st.opener = uuid;
      if ('parent_uuid' in ch) st.parent = ch.parent_uuid === null ? null : cleanId(ch.parent_uuid);
      s.tx = header.id;
      if (isRelay(ch.text)) st.relay = true;
      else {
        st.realPrompt = true;
        const it = model.upsertItem(promptItemFor(header.id, ch, 'prompt', unframe(ch.text)));
        if (it) st.firstSeq = it.seq;
      }
      noteRecord(s, ch, header.id);
      return;
    }
    const st = stateOf(existing);
    s.tx = existing;
    if (st.relay && !st.realPrompt) {
      st.realPrompt = true;
      const it = model.upsertItem(promptItemFor(existing, ch, 'prompt', unframe(ch.text)));
      if (it && st.firstSeq == null) st.firstSeq = it.seq;
    } else if (uuid) {
      model.upsertItem({ ...promptItemFor(existing, ch, 'prompt', ch.text), id: `p_${uuid}` });
    }
    noteRecord(s, ch, existing);
  }

  // ---- the other transcript changes ----------------------------------------------
  function currentTurn(cid, s, sid) { return s.tx && model.turn(s.tx) ? s.tx : latestTurnOf(cid, sid); }

  function hasTranscriptReply(id, except) {
    const list = model.itemsOf(id) || [];
    return list.some((it) => it.kind === 'reply' && it.source === 'transcript' && it.id !== except);
  }

  function applyItem(cid, s, sid, ch) {
    const id = currentTurn(cid, s, sid);
    if (!id || !isPlain(ch.item)) { diagnostics.items_without_turn += 1; noteRecord(s, ch, null); return; }
    const raw = { ...ch.item, turn_id: id, source: 'transcript' };
    if (raw.seq === undefined && Number.isFinite(ch.seq)) raw.seq = ch.seq;
    const it = model.upsertItem(raw, { context: isPlain(ch.context) ? ch.context : null });
    // The transcript's reply replaces the Stop's provisional one (rule 3).
    if (it && it.kind === 'reply' && it.id !== `rl_${id}` && model.item(`rl_${id}`)) model.removeItem(`rl_${id}`);
    noteRecord(s, ch, id);
    if (conv(cid).mode === 'agent' && typeof ch.stop_reason === 'string' && !STOP_REASONS_THAT_CONTINUE.has(ch.stop_reason)) {
      const t = model.turn(id);
      if (t && t.status === 'open') closeTurn(cid, id, { outcome: 'done', by: 'transcript', at: tsOf(ch) });
    }
  }

  function turnDuration(cid, s, sid, ch) {
    const id = currentTurn(cid, s, sid);
    if (!id) { noteRecord(s, ch, null); return; }
    const t = model.turn(id);
    const st = stateOf(id);
    const dur = Number.isFinite(ch.duration_ms) ? ch.duration_ms : undefined;
    if (t.status === 'open') {
      if (st.interrupt) {
        closeTurn(cid, id, { outcome: 'interrupted', by: 'transcript', at: tsOf(ch), duration_ms: dur,
          ended_by: interrupter(cid, sid) || 'terminal' });
      } else {
        closeTurn(cid, id, { outcome: 'done', by: 'transcript', at: tsOf(ch), duration_ms: dur });
      }
    } else if (dur !== undefined && t.duration_ms !== dur) {
      w.putTurn({ id, duration_ms: dur });
    }
    // The final reply was on disk before the Stop's provisional one was made.
    if (model.item(`rl_${id}`) && hasTranscriptReply(id, `rl_${id}`)) model.removeItem(`rl_${id}`);
    noteRecord(s, ch, id);
  }

  function interruptItemFor(id, ch) {
    const uuid = cleanId(ch.uuid);
    const it = { id: uuid ? `n_${uuid}` : `n_int_${id}`, turn_id: id, kind: 'notice', notice: 'interrupted',
      text: typeof ch.text === 'string' && ch.text ? ch.text : 'Interrupted by the user', source: 'transcript', ts: tsOf(ch) };
    if (Number.isFinite(ch.seq)) it.seq = ch.seq;
    return it;
  }

  function interrupt(cid, s, sid, ch) {
    const id = currentTurn(cid, s, sid);
    if (!id) { noteRecord(s, ch, null); return; }
    stateOf(id).interrupt = true;
    model.upsertItem(interruptItemFor(id, ch));
    noteRecord(s, ch, id);
  }

  function compactItemFor(id, ch) {
    const uuid = cleanId(ch.uuid);
    if (!uuid) return null;
    const it = { id: `c_${uuid}`, turn_id: id, kind: 'compact', source: 'transcript', ts: tsOf(ch) };
    if (typeof ch.trigger === 'string') it.trigger = ch.trigger;
    if (isPlain(ch.tokens) || Number.isFinite(ch.tokens)) it.tokens = ch.tokens;
    if (Number.isFinite(ch.duration_ms)) it.duration_ms = ch.duration_ms;
    if (typeof ch.summary === 'string') it.summary = ch.summary;
    if (Number.isFinite(ch.seq)) it.seq = ch.seq;
    return it;
  }

  // Rule 5. A compaction is never a rewind (rule 4): its boundary (whose own
  // parent is null) and its preserved tail stay on the chain.
  function compact(cid, s, sid, ch) {
    const id = currentTurn(cid, s, sid);
    const it = id ? compactItemFor(id, ch) : null;
    if (it) model.upsertItem(it);
    for (const u of [cleanId(ch.uuid), cleanId(ch.tail_uuid)]) if (u) addTail(s, u);
    noteRecord(s, ch, id);
  }

  function compactSummary(cid, s, sid, ch) {
    const parent = cleanId(ch.parent_uuid);
    const boundary = parent ? model.item(`c_${parent}`) : null;
    const id = boundary ? boundary.turn_id : currentTurn(cid, s, sid);
    if (id && parent && typeof ch.text === 'string') {
      model.upsertItem({ id: `c_${parent}`, turn_id: id, kind: 'compact', summary: ch.text, source: 'transcript' });
    }
    noteRecord(s, ch, id);
  }

  // attachment/hook_permission_decision (§2.4's record table): the awaiting state
  // of the tool call, and the `permission-decision` transition the asks domain reads.
  function permissionDecision(cid, s, sid, ch) {
    const useId = cleanId(ch.tool_use_id);
    const it = useId ? model.item(useId) : null;
    const decision = typeof ch.decision === 'string' ? ch.decision : null;
    if (it) model.upsertItem({ id: useId, turn_id: it.turn_id, kind: 'tool_call', awaiting: { status: 'decided', decision, by: 'hook' } });
    if (useId) {
      queue.push([transition, { kind: 'mirror', op: 'permission-decision', conversation_id: cid, session_id: sid,
        tool_use_id: useId, decision }]);
    }
    noteRecord(s, ch, it ? it.turn_id : currentTurn(cid, s, sid));
  }

  function applyChanges(cid, sid, changes, { mode } = {}) {
    return run(() => {
      const conversationId = cleanId(cid);
      const sessionId = cleanId(sid);
      if (!conversationId || !sessionId || !Array.isArray(changes)) return { ok: false, applied: 0 };
      const c = conv(conversationId);
      if (mode === 'agent' || mode === 'main') c.mode = mode;
      const s = session(sessionId, conversationId);
      let applied = 0;
      for (const ch of changes) {
        if (!isPlain(ch)) { diagnostics.unknown_changes += 1; continue; }
        switch (ch.type) {
          case 'opener': opener(conversationId, s, sessionId, ch); break;
          case 'item': applyItem(conversationId, s, sessionId, ch); break;
          case 'turn-duration': turnDuration(conversationId, s, sessionId, ch); break;
          case 'interrupt': interrupt(conversationId, s, sessionId, ch); break;
          case 'compact': compact(conversationId, s, sessionId, ch); break;
          case 'compact-summary': compactSummary(conversationId, s, sessionId, ch); break;
          case 'permission-decision': permissionDecision(conversationId, s, sessionId, ch); break;
          case 'record': noteRecord(s, ch, currentTurn(conversationId, s, sessionId)); break;
          default: diagnostics.unknown_changes += 1; continue;
        }
        applied += 1;
      }
      return { ok: true, applied };
    });
  }

  // ---- hook envelopes (envelope v1, §1.3) ------------------------------------------
  // Which turn a hook event belongs to: its prompt_id (through any alias), else the
  // open turn (and the prompt_id becomes an alias of it), else — for a PreToolUse
  // newer than the session's last Stop — a provisional turn of its own, else the
  // session's latest turn when the event is that turn's late one.
  function routeHook(cid, sid, env, mayOpen) {
    const c = conv(cid);
    const s = session(sid, cid);
    const ts = tsOf(env);
    const pid = cleanId(env.prompt_id);
    if (pid) {
      const r = resolveHook(pid);
      const t = r ? model.turn(r) : null;
      if (t && t.conversation_id === cid) return r;
    }
    if (c.open) {
      if (pid && !model.turn(pid) && !aliases.has(pid)) softAliases.set(pid, c.open);
      return c.open;
    }
    if (mayOpen && ts > s.lastCloseTs) {
      const header = openTurn(cid, { id: pid || freshId(`h_${ts}`), session_id: sid, kind: 'prompt', started_at: ts, provisional: true });
      if (!header) return null;
      stateOf(header.id).hook = true;
      return header.id;
    }
    const last = latestTurnOf(cid, sid);
    const lt = last ? model.turn(last) : null;
    if (lt && Number.isFinite(lt.ended_at) && Math.abs(ts - lt.ended_at) <= LATE_EVENT_MS) return last;
    return null;
  }

  // Is `text` the prompt turn `tid` holds? It is redacted the same way before it
  // is compared, and never kept. The hook caps a prompt at 16 KiB (§1.3), so a
  // long one may be a prefix of the other side's.
  function samePrompt(tid, text, { either = false } = {}) {
    if (typeof text !== 'string' || !text) return false;
    const it = model.item(`p_${tid}`);
    if (!it || typeof it.text !== 'string' || !it.text) return false;
    const mine = model.scrubText(text);
    if (mine === undefined) return false;
    if (mine === it.text) return true;
    if (mine.length >= 16000 && it.text.startsWith(mine)) return true;
    return either && it.text.length >= 16000 && mine.startsWith(it.text);
  }

  // Rule 1.
  function promptSubmit(cid, sid, env) {
    const c = conv(cid);
    session(sid, cid);
    if (c.mode === 'agent') return { ok: true, ignored: true };
    const ts = tsOf(env);
    const prompt = isPlain(env.prompt) ? env.prompt : {};
    const pid = cleanId(env.prompt_id);
    const isTask = prompt.author === 'task';
    if (pid) {
      const known = resolveHook(pid);
      const kt = known ? model.turn(known) : null;
      if (kt && kt.conversation_id === cid) { stateOf(known).hook = true; return { ok: true, turn_id: known, known: true }; }
    }
    if (isTask && c.open) return { ok: true, absorbed: true, turn_id: c.open };
    // The transcript opened this very turn before the envelope arrived (rule 2,
    // seen from the other side): the hook's prompt_id becomes its alias.
    if (c.open && pid) {
      const st = stateOf(c.open);
      if (st && st.bound && !st.hook && samePrompt(c.open, prompt.text)) {
        aliases.set(pid, c.open);
        st.hook = true;
        return { ok: true, turn_id: c.open, bound: true };
      }
    }
    if (c.open) {
      const prev = model.turn(c.open);
      closeTurn(cid, c.open, { outcome: 'interrupted', by: 'next-turn', at: ts, ended_by: interrupter(cid, prev.session_id) });
    }
    const kind = isTask ? 'task-notification' : 'prompt';
    const header = openTurn(cid, { id: pid || freshId(`h_${ts}`), session_id: sid, kind, started_at: ts, provisional: true });
    if (!header) return { ok: false, reason: 'open-failed' };
    const st = stateOf(header.id);
    st.hook = true;
    if (typeof prompt.text === 'string' && prompt.text) {
      const it = model.upsertItem({ id: `p_${header.id}`, turn_id: header.id, kind: 'prompt', text: prompt.text,
        origin: ORIGIN_OF_KIND[kind], source: 'hook', ts });
      if (it) st.firstSeq = it.seq;
    }
    return { ok: true, turn_id: header.id, opened: true };
  }

  // The Stop's last_assistant_message, until the transcript's reply lands — unless
  // the transcript's final reply is already the turn's last word.
  function provisionalReply(id, msg, ts) {
    const list = model.itemsOf(id);
    if (list) {
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i];
        if (it.kind === 'notice' || it.kind === 'task' || it.kind === 'compact') continue;
        if (it.kind === 'reply' && it.source === 'transcript') return;
        break;
      }
    }
    model.upsertItem({ id: `rl_${id}`, turn_id: id, kind: 'reply', text: msg, source: 'hook', ts });
  }

  // Rule 3: Stop (`done`) and StopFailure (`error`).
  function stop(cid, sid, env, failed) {
    const ts = tsOf(env);
    const s = session(sid, cid);
    s.lastCloseTs = Math.max(s.lastCloseTs, ts);
    const id = routeHook(cid, sid, env, false);
    if (!id) return { ok: false, reason: 'no-turn' };
    const t = model.turn(id);
    const st = stateOf(id);
    if (t.status === 'open') {
      closeTurn(cid, id, { outcome: failed ? 'error' : 'done', by: 'stop', at: ts });
    } else if (!failed && t.status === 'interrupted' && (st.closedBy === 'status' || st.closedBy === 'next-turn')) {
      // A late Stop: the turn did finish. The status machine's interruption was a
      // presumption, and the turn guard corrects the node the same way (§3.3).
      w.putTurn({ id, status: 'done', ended_by: null });
      st.closedBy = 'stop';
    }
    const msg = isPlain(env.stop) && typeof env.stop.last_assistant_message === 'string' ? env.stop.last_assistant_message : '';
    if (msg) provisionalReply(id, msg, ts);
    return { ok: true, turn_id: id };
  }

  function linksOf(fields) {
    if (!isPlain(fields)) return null;
    const links = {};
    const taskId = fields.backgroundTaskId || fields.taskId;
    if (typeof taskId === 'string' && taskId) links.task_id = taskId;
    if (typeof fields.agentId === 'string' && fields.agentId) links.agent_id = fields.agentId;
    if (typeof fields.runId === 'string' && fields.runId) links.run_id = fields.runId;
    return Object.keys(links).length ? links : null;
  }

  function toolInfo(it, tool) {
    if (typeof tool.name === 'string' && tool.name) {
      it.tool = tool.name;
      const m = /^mcp__(.+?)__/.exec(tool.name);
      if (m) it.server = m[1];
    }
    if (typeof tool.kind === 'string') it.tool_kind = tool.kind;
    if (typeof tool.label === 'string') it.label = tool.label;
    if (typeof tool.call === 'string') it.call = tool.call;
    if (tool.input !== undefined && tool.input !== null) it.input = tool.input;
    return it;
  }

  // PreToolUse, PostToolUse, PostToolUseFailure: a provisional tool call, whose
  // outcome never depends on which of its two hooks arrived first (§2.6).
  function toolEvent(cid, sid, env) {
    if (env.agent) return { ok: true, ignored: 'agent' }; // a subagent's tool: its own stream (rule 6)
    const tool = isPlain(env.tool) ? env.tool : null;
    const useId = tool ? cleanId(tool.use_id) : null;
    if (!useId) return { ok: false, reason: 'no-tool' };
    const ts = tsOf(env);
    const id = routeHook(cid, sid, env, env.event === 'PreToolUse');
    if (!id) return { ok: false, reason: 'no-turn' };
    const existing = model.item(useId);
    const it = toolInfo({ id: useId, turn_id: id, kind: 'tool_call', source: 'hook', ts }, tool);
    if (env.event === 'PreToolUse') {
      it.status = 'running';
      it.started_at = ts;
    } else {
      const r = isPlain(env.result) ? env.result : {};
      const failed = env.event === 'PostToolUseFailure' || r.ok === false;
      it.status = r.interrupted ? 'interrupted' : failed ? 'error' : 'done';
      it.ended_at = ts;
      if (Number.isFinite(r.duration_ms)) {
        it.duration_ms = r.duration_ms;
        if (!existing || !Number.isFinite(existing.started_at)) it.started_at = ts - r.duration_ms;
      }
      if (failed && typeof r.error === 'string' && r.error) it.result = { preview: r.error, is_error: true };
      const links = linksOf(r.fields);
      if (links) it.links = links;
    }
    model.upsertItem(it);
    return { ok: true, turn_id: id, item_id: useId };
  }

  // PermissionRequest: the tool call awaits the user. Without a tool_use_id (V3:
  // the payload has none; the asks domain correlates, C3) only live state shows it.
  function permissionRequest(cid, sid, env) {
    const tool = isPlain(env.tool) ? env.tool : null;
    const useId = tool ? cleanId(tool.use_id) : null;
    if (!useId || env.agent) return { ok: true, ignored: true };
    const id = routeHook(cid, sid, env, false);
    if (!id) return { ok: false, reason: 'no-turn' };
    const ask = isPlain(env.ask) ? env.ask : {};
    const awaiting = { kind: typeof ask.kind === 'string' ? ask.kind : ASK_KIND_OF_TOOL[tool.name] || 'permission', status: 'pending' };
    if (typeof ask.id === 'string') awaiting.ask_id = ask.id;
    const existing = model.item(useId);
    const it = existing
      ? { id: useId, turn_id: existing.turn_id, kind: 'tool_call', awaiting }
      : toolInfo({ id: useId, turn_id: id, kind: 'tool_call', source: 'hook', status: 'running', started_at: tsOf(env), ts: tsOf(env), awaiting }, tool);
    model.upsertItem(it);
    return { ok: true, turn_id: it.turn_id, item_id: useId };
  }

  // The asks domain's synthetic PermissionResolved (§4.3): the wait is over.
  function permissionResolved(cid, sid, env) {
    const tool = isPlain(env.tool) ? env.tool : {};
    const ask = isPlain(env.ask) ? env.ask : {};
    let target = cleanId(tool.use_id) ? model.item(tool.use_id) : null;
    if (!target && typeof ask.id === 'string') {
      const c = conv(cid);
      for (const tid of [c.open, latestTurnOf(cid, sid)]) {
        for (const it of (tid && model.itemsOf(tid)) || []) if (it.awaiting && it.awaiting.ask_id === ask.id) target = it;
      }
    }
    if (!target) return { ok: true, ignored: true };
    const awaiting = { status: 'resolved' };
    for (const k of ['outcome', 'by', 'decision']) if (typeof ask[k] === 'string') awaiting[k] = ask[k];
    model.upsertItem({ id: target.id, turn_id: target.turn_id, kind: 'tool_call', awaiting });
    return { ok: true, turn_id: target.turn_id, item_id: target.id };
  }

  // The tap subscriber's entry (§2.12 "Ingest"): the hook rules of §2.4. Other
  // events are the conversation registry's and live.js's, not this machine's.
  function ingest(cid, env) {
    return run(() => {
      if (!isPlain(env)) return { ok: false, reason: 'bad-envelope' };
      const conversationId = cleanId(cid);
      const sid = cleanId(env.session_id);
      if (!conversationId || !sid) { diagnostics.ignored_envelopes += 1; return { ok: false, reason: 'no-session' }; }
      switch (env.event) {
        case 'UserPromptSubmit': return promptSubmit(conversationId, sid, env);
        case 'Stop': return stop(conversationId, sid, env, false);
        case 'StopFailure': return stop(conversationId, sid, env, true);
        case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure': return toolEvent(conversationId, sid, env);
        case 'PermissionRequest': return permissionRequest(conversationId, sid, env);
        case 'PermissionResolved': return permissionResolved(conversationId, sid, env);
        default: return { ok: true, ignored: true };
      }
    });
  }

  // live.js's decision that a busy → idle flip with no Stop ended the turn
  // (§2.6): consumed, never re-derived here.
  function statusClosed(t = {}) {
    return run(() => {
      const cid = cleanId(t.conversation_id);
      if (!cid) return null;
      const c = conv(cid);
      const id = (t.turn_id && resolveId(t.turn_id)) || c.open;
      const turn = id ? model.turn(id) : null;
      if (!turn || turn.conversation_id !== cid || turn.status !== 'open') return null;
      const sid = turn.session_id || cleanId(t.session_id);
      const endedBy = ENDED_BY.has(t.ended_by) ? t.ended_by : interrupter(cid, sid) || 'terminal';
      return closeTurn(cid, id, { outcome: 'interrupted', by: 'status', at: t.at, ended_by: endedBy });
    });
  }

  // The conversation's process is gone (the two-sample verdict, §2.6).
  function processGone(cid, { at } = {}) {
    return run(() => {
      const conversationId = cleanId(cid);
      if (!conversationId) return null;
      const c = conv(conversationId);
      return c.open ? closeTurn(conversationId, c.open, { outcome: 'abandoned', by: 'process-gone', at }) : null;
    });
  }

  // ---- the graph link's states (§2.8) ------------------------------------------------
  // open → pending (closed, unattached) → attached | orphaned.
  function pendingTurns() {
    const out = [];
    for (const [id, st] of tstate) if (st.link === 'pending') { const t = model.turn(id); if (t) out.push(t); }
    return out.sort((a, b) => (a.ended_at ?? 0) - (b.ended_at ?? 0) || a.seq - b.seq);
  }

  function attach(turnId, node) {
    return run(() => {
      const id = resolveId(turnId);
      const t = id ? model.turn(id) : null;
      if (!t || t.status === 'open' || !isPlain(node)) return null;
      const nid = cleanId(node.id);
      if (!nid) return null;
      const role = node.role === 'folded' ? 'folded' : 'commit';
      const label = typeof node.label === 'string' && node.label ? node.label : nid;
      const header = w.putTurn({ id, node: { id: nid, label, role }, folded_into: role === 'folded' ? { id: nid, label } : null });
      stateOf(id).link = 'attached';
      return header;
    });
  }

  // Re-aims that move the commit point without a preserve turn pending turns into
  // orphans: still in the stream, never attached. `before` limits it to turns that
  // ended before then (the boot rebuild's rule).
  function orphanPending({ before } = {}) {
    const out = [];
    for (const [id, st] of tstate) {
      if (st.link !== 'pending') continue;
      const t = model.turn(id);
      if (!t) continue;
      if (Number.isFinite(before) && !(Number.isFinite(t.ended_at) && t.ended_at < before)) continue;
      st.link = 'orphaned';
      out.push(id);
    }
    return out;
  }

  function linkState(turnId) {
    const id = resolveId(turnId);
    const st = id ? stateOf(id) : null;
    return st ? st.link : null;
  }

  // ---- the turn index (§2.11): export and restore -------------------------------------
  function exportTurns(sessionId) {
    const sid = cleanId(sessionId);
    const s = sid ? sessions.get(sid) : null;
    const cids = s ? [s.cid] : [...convs.keys()];
    const out = [];
    for (const cid of cids) {
      for (const t of model.turnsOf(cid, { session_id: sid })) {
        const st = stateOf(t.id);
        out.push({
          header: model.serializeTurn(t.id),
          internal: {
            bound: st.bound, hook: st.hook, closed_by: st.closedBy, interrupt: st.interrupt, link: st.link,
            opener_uuid: st.opener, parent_known: st.parent !== undefined, parent_uuid: st.parent === undefined ? null : st.parent,
            last_uuid: st.last, segment: st.segment, first_seq: st.firstSeq, relay: st.relay, real_prompt: st.realPrompt,
            rewind: st.rewind,
          },
        });
      }
    }
    return out;
  }

  function restoreTurns(cid, records) {
    return run(() => {
      const conversationId = cleanId(cid);
      if (!conversationId || !Array.isArray(records)) return { ok: false, restored: 0 };
      const c = conv(conversationId);
      const restored = [];
      for (const r of records) {
        if (!isPlain(r) || !isPlain(r.header)) continue;
        const h = w.restoreTurn({ ...r.header, conversation_id: conversationId });
        if (!h) continue;
        const i = isPlain(r.internal) ? r.internal : {};
        const st = initState(h.id, conversationId, h.session_id);
        st.bound = i.bound !== false;
        st.hook = i.hook === true;
        st.closedBy = CLOSE_BY.has(i.closed_by) ? i.closed_by : null;
        st.interrupt = i.interrupt === true;
        st.link = LINKS.has(i.link) ? i.link : h.status === 'open' ? 'open' : 'pending';
        st.opener = cleanId(i.opener_uuid);
        st.parent = i.parent_known ? (i.parent_uuid === null ? null : cleanId(i.parent_uuid)) : undefined;
        st.last = cleanId(i.last_uuid);
        if (isPlain(i.segment) && Number.isFinite(i.segment.from) && Number.isFinite(i.segment.to)) {
          st.segment = { from: i.segment.from, to: i.segment.to };
        }
        st.firstSeq = Number.isFinite(i.first_seq) ? i.first_seq : null;
        st.relay = i.relay === true;
        st.realPrompt = i.real_prompt === true;
        if (h.seq >= c.nextSeq) c.nextSeq = Math.floor(h.seq) + 1;
        if (h.status === 'open') c.open = h.id;
        if (h.session_id) {
          const s = session(h.session_id, conversationId);
          s.tx = h.id;
          if (st.last) s.leaf = st.last;
        }
        restored.push({ id: h.id, rewind: i.rewind });
      }
      // A rewind is replayed through supersede, the one way a turn is superseded.
      for (const r of restored) {
        if (isPlain(r.rewind)) supersede(conversationId, r.id, { reason: r.rewind.reason, at: r.rewind.at, through: r.rewind.through });
      }
      return { ok: true, restored: restored.length };
    });
  }

  // Refill an evicted turn's items from a re-read of its byte range (the same
  // change shapes `applyChanges` takes; no lifecycle effect).
  function refill(turnId, changes) {
    return run(() => {
      const id = resolveId(turnId);
      const t = id ? model.turn(id) : null;
      if (!t || !Array.isArray(changes)) return false;
      const st = stateOf(id);
      const agent = conv(t.conversation_id).mode === 'agent';
      const entries = [];
      let openers = 0;
      let realPrompt = false;
      for (const ch of changes) {
        if (!isPlain(ch)) continue;
        if (ch.type === 'opener') {
          openers += 1;
          const kind = TURN_KINDS.has(ch.kind) ? ch.kind : 'prompt';
          if (!agent) { if (openers === 1) entries.push({ item: promptItemFor(id, ch, kind, ch.text) }); continue; }
          if (!realPrompt && (openers > 1 || !isRelay(ch.text))) {
            realPrompt = true;
            entries.push({ item: promptItemFor(id, ch, 'prompt', unframe(ch.text)) });
          } else if (realPrompt && cleanId(ch.uuid)) {
            entries.push({ item: { ...promptItemFor(id, ch, 'prompt', ch.text), id: `p_${ch.uuid}` } });
          }
        } else if (ch.type === 'item' && isPlain(ch.item)) {
          const raw = { ...ch.item, source: 'transcript' };
          if (raw.seq === undefined && Number.isFinite(ch.seq)) raw.seq = ch.seq;
          entries.push({ item: raw, context: isPlain(ch.context) ? ch.context : null });
        } else if (ch.type === 'interrupt') {
          entries.push({ item: interruptItemFor(id, ch) });
        } else if (ch.type === 'compact') {
          const it = compactItemFor(id, ch);
          if (it) entries.push({ item: it });
        } else if (ch.type === 'compact-summary' && cleanId(ch.parent_uuid) && typeof ch.text === 'string') {
          entries.push({ item: { id: `c_${ch.parent_uuid}`, kind: 'compact', summary: ch.text, source: 'transcript' } });
        }
      }
      const ok = model.refillTurn(id, entries);
      if (ok && st.rewind) model.upsertItem(rewoundItem(id, st), { silent: true });
      return ok;
    });
  }

  // ---- housekeeping and reads ----------------------------------------------------------
  function configure(cid, { mode } = {}) {
    const conversationId = cleanId(cid);
    if (!conversationId) return null;
    const c = conv(conversationId);
    if (mode === 'agent' || mode === 'main') c.mode = mode;
    return { mode: c.mode };
  }

  function removeConversation(cid, opts) {
    return run(() => {
      const conversationId = cleanId(cid);
      if (!conversationId) return false;
      const gone = new Set(model.turnsOf(conversationId).map((t) => t.id));
      for (const id of gone) tstate.delete(id);
      for (const [k, v] of aliases) if (gone.has(resolveId(v)) || gone.has(v)) aliases.delete(k);
      for (const [k, v] of softAliases) if (gone.has(resolveId(v)) || gone.has(v)) softAliases.delete(k);
      for (const [sid, s] of sessions) if (s.cid === conversationId) sessions.delete(sid);
      for (const [u, tid] of uuidTurn) if (gone.has(tid)) uuidTurn.delete(u);
      convs.delete(conversationId);
      return model.removeConversation(conversationId, opts);
    });
  }

  function openTurnOf(cid) { const c = convs.get(cid); return c ? c.open : null; }
  function sessionTurn(sid) { const s = sessions.get(sid); return s ? s.tx : null; }
  function turnOfUuid(uuid) { return uuidTurn.has(uuid) ? resolveId(uuidTurn.get(uuid)) : null; }
  function segmentOf(turnId) { const id = resolveId(turnId); const st = id ? tstate.get(id) : null; return st && st.segment ? { ...st.segment } : null; }

  return {
    // the primitives and rule 4
    openTurn, closeTurn, supersede,
    // the two streams
    ingest, applyChanges, statusClosed, processGone,
    // the graph link
    pendingTurns, attach, orphanPending, linkState,
    // the turn index and the LRU's refill
    exportTurns, restoreTurns, refill,
    // housekeeping and reads
    configure, removeConversation, resolve: resolveId, openTurnOf, sessionTurn, turnOfUuid, segmentOf,
    diagnostics: () => ({ ...diagnostics }),
  };
}

module.exports = {
  createTurnMachine,
  unframe,
  isRelay,
  ENDED_BY,
  OUTCOMES,
  CLOSE_BY,
  REWIND_REASONS,
  USER_REQUEST_FRAME,
  FRAME_MARK,
  LATE_EVENT_MS,
};

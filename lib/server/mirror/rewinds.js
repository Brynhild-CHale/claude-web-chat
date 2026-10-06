// lib/server/mirror/rewinds.js — the rewinds source: rewinds the transcript
// shows only after the fact (spec §15.4 cases b and c, §2.4 rule 4, C43).
//
//   createRewindsSource() → { attach(engine) }
//
// Registered on the facade as `rewinds`, AFTER `transcripts` (lib/server/mirror/
// index.js SOURCES; U40 adds the row). It codes against THE SOURCE CONTRACT in
// index.js's header and nothing else. What attach returns: {start, stop,
// onIngest, onChanges, onConversation, persistState, restoreState,
// diagnostics}. No `api`: the facade's dispatch table names no rewinds method.
//
// WHAT IT DOES, AND WHAT IT NEVER DOES. No hook fires on a rewind and a rewind
// in the terminal writes nothing until the next prompt (§15.4), so a rewind is
// read out of the change batches the transcripts source applies (onChanges,
// after the turn machine has applied the whole batch). Four cases:
//   (a) a branch: the turn machine's own (rule 4) — nothing here;
//   (b) a first-prompt reset — here (below);
//   (c) a headless anchor — here (below);
//   (d) a code-only rewind: codediff's (U43).
// Every rewind goes through engine.model.supersede(cid, fromTurnId, {reason, at,
// until}) — the turn machine's ONE operation, which adds the `rewound` notice and
// marks the turns `superseded`, idempotently. This file never marks a turn, never
// adds a notice and writes no file of its own (C43: committed nodes are never
// rewritten, no graph file is written); its detector state rides in the index
// through persistState. It never names the open turn as `fromTurnId` (supersede
// would take it), and it bounds the run with `until` whenever the turn the
// rewind's prompt opened exists (U09's hand-off 3), else with `at`.
//
// CASE (b), THE FIRST-PROMPT RESET. Claude Code 2.1.287 does not persist a rewind
// to the first prompt: the chain continues while messageCount collapses (86 → 16)
// and the first turn's attachments reappear with no SessionStart. The maintainer
// chose not to report it upstream (Q-G), so this case stays. Per session, a
// turn-duration is a reset when, against the PREVIOUS turn-duration of the session:
//   * its message_count is lower by at least RESET_MIN_COUNT_DROP;
//   * no compaction (a `compact` change) came between them — a compaction is
//     never a reset;
//   * at least RESET_MIN_FIRST_TURN_RECORDS records of a FIRST_TURN_KINDS kind
//     came between them (a `record` change of that kind; attachment/model also
//     counts when it surfaced as the model notice the normalizer makes of it);
//   * no SessionStart envelope for the session has a ts between the two
//     turn-durations' record times (a --resume or /resume is never a reset);
//   * no EXIT TAIL came between them: a uuid-less `cost-state` record (the
//     normalizer forwards it as a `record` change of that kind, U78b), which
//     Claude Code writes when a process leaves a session, so a resume into the
//     same file appends after it. It counts exactly like a SessionStart between
//     the two — a session boundary — and is what keeps a resume the daemon did
//     not hear (it was down) from reading as a reset;
//   * the count after the drop is at most RESET_MAX_AFTER_COUNT: a reset goes
//     back to the FIRST prompt, so it lands low.
// Then supersede(cid, the session's first live turn since its last reset,
// {reason: 'reset', at: the new turn's started_at, until: the turn that
// turn-duration closed}), and that turn becomes the first since the last reset.
//
// V37 (the maintainer's transcripts, Claude Code 2.1.251–2.1.289): of 55
// resumes, 5 lowered messageCount (2473 → 1204, 3477 → 474, 50 → 32,
// 2922 → 824, 1586 → 1396), and 4 of them would have read as a reset with no
// SessionStart heard. The exit tail is in 250 of 260 transcripts and lies
// between the two turn-durations of every same-file resume drop and of no
// in-process reset; RESET_MAX_AFTER_COUNT (64) is under every one of those five
// resumed counts but 32, which only the exit tail stops.
//
// A COPIED CHAIN. A resume into a NEW file (the earlier file ends with
// `continued-in`) opens with copies of the earlier file's chain: the same uuids
// and timestamps under the new session id, a copied turn-duration just before
// the new process's first. When the new session is another conversation the
// transcripts source's fork filter drops the copies before the turn machine
// (this source never hears them); when the registry linked it into the same
// conversation, they reach this source. A record whose uuid the conversation
// holds under ANOTHER session's turn is a copy: a copied turn-duration never
// seeds the comparison and a copied opener is never this session's turn.
//
// CASE (c), A HEADLESS ANCHOR. A `rewind-evidence` change {rewound, leaf_uuid}
// (the normalizer's reading of a last-prompt record, U26). The point returned to:
//   * leaf_uuid null → the session's first live turn since its last reset;
//   * else the turn whose opener's parent is leaf_uuid (kept here, so a restart
//     still knows it), else the turn after engine.model.turnOfUuid(leaf_uuid).
// That turn is `from` only when it is not superseded already (an earlier rewind
// covers that point), is not the open turn, is not the turn the next opener
// opened, and began before the evidence in the file. `until` is the turn of the
// next opener after the evidence in the same batch, when there is one; `at` is
// always the evidence's ts (which bounds the run when there is no `until`). A
// last-prompt naming the newest turn's records (c′) finds no turn after it and
// supersedes nothing. An anchor that is also a branch (the next prompt's parent
// is the anchor) is superseded once: the second supersede of the same `from` is
// a no-op and the first reason stands.
//
// IDEMPOTENCE AND RESTART. Each session keeps a watermark, the highest record
// ordinal (`seq`, THE SEQ RULE) it has judged: a change at or below it is a
// re-read (a resume before an open turn's opener, a whole-file read, a restored
// index read from 0) and is skipped, so a re-read neither repeats a rewind nor
// mistakes the file's first turn-duration for a collapse. The watermark is reset
// when the file's first chain record is no longer the one it was (a transcript
// rewritten under its tailer). The state is content-free — ordinals, record
// times, counts, record kind names, turn ids and record uuids — and goes into the
// index through persistState (the facade passes it through the redactor); a
// restart restores it, so it neither misses nor repeats a rewind. A catch-up
// (index mode) runs the same rules on record timestamps, never on the clock.

const SOURCE_NAME = 'rewinds';
const STATE_VERSION = 1;

// The first-turn append (validation V1/V14): the records Claude Code writes with
// a session's first prompt, which reappear after an unpersisted rewind to it.
const FIRST_TURN_KINDS = Object.freeze([
  'attachment/environment',
  'attachment/model',
  'attachment/deferred_tools_delta',
  'attachment/agent_listing_delta',
  'attachment/mcp_instructions_delta',
  'attachment/skill_listing',
]);
const FIRST_TURN_SET = new Set(FIRST_TURN_KINDS);
// How far a turn-duration's message_count must fall below the previous one's.
const RESET_MIN_COUNT_DROP = 1;
// How many first-turn records must come between the two turn-durations.
const RESET_MIN_FIRST_TURN_RECORDS = 1;
// The highest message_count a reset may land on. A rewind to the first prompt
// leaves the conversation at its first turn: the corpus's in-process resets all
// land at 16 (46 → 16, 73 → 16, 73 → 16; the spec's 86 → 16), while a 2.1.287
// drop of 3031 → 2922 with five first-turn records between (no resume, no exit
// tail) is not a return to the first prompt. 64 is four times the observed
// landing and far under every resumed count V37 saw but one (50 → 32, which the
// exit tail catches).
const RESET_MAX_AFTER_COUNT = 64;
// The record kind of the exit tail (V37): a session boundary, like SessionStart.
const EXIT_TAIL_KIND = 'cost-state';

const STARTS_MAX = 16;        // SessionStart times kept per session
const ANCHORS_MAX = 5000;     // opener parents kept per session (the index's turn bound)
const SESSIONS_MAX = 2000;    // sessions with a detector state

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => Number.isFinite(v);
const idOf = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);

function freshState(cid) {
  return {
    cid: cid || null,
    seq: null,            // the watermark: the highest record ordinal judged
    head: null,           // {seq, uuid}: the file's first chain record seen
    count: null,          // the previous turn-duration's message_count
    td_ts: null,          // the previous turn-duration's record time
    compact: false,       // a compaction since it
    exit: false,          // an exit tail (cost-state) since it: a session boundary
    first_turn_records: 0,
    first_turn_kinds: [],
    starts: [],           // SessionStart envelope times
    first: null,          // the session's first turn since its last reset
    cur: null,            // the turn of the last opener, in file order
    anchors: new Map(),   // an opener's parent uuid → the turn that opener opened (first wins)
  };
}

function createRewindsSource() {
  function attach(engine) {
    const model = engine.model;
    const sessions = new Map(); // session id → state
    const counts = { resets: 0, anchors: 0, skipped: 0, refused: 0, copies: 0 };
    const stateIds = () => sessions.size;

    function stateOf(sid, cid) {
      let S = sessions.get(sid);
      if (!S) {
        S = freshState(cid);
        sessions.set(sid, S);
        if (sessions.size > SESSIONS_MAX) sessions.delete(sessions.keys().next().value);
      } else if (cid) {
        S.cid = cid;
      }
      return S;
    }

    const resolve = (id) => (id ? model.resolveTurn(id) : null);
    const turnOf = (id) => { const r = resolve(id); return r ? model.turn(r) : null; };

    // The turn an opener change opened (the turn machine has applied it).
    function openerTurn(ch) {
      const uuid = idOf(ch.uuid);
      const byUuid = uuid ? model.turnOfUuid(uuid) : null;
      if (byUuid && model.turn(byUuid)) return byUuid;
      const pid = idOf(ch.prompt_id) || (uuid ? `u_${uuid}` : null);
      const t = pid ? turnOf(pid) : null;
      return t ? t.id : null;
    }

    function sessionTurns(cid, sid) { return model.turnsOf(cid, { session_id: sid }); }

    // A record the conversation holds under ANOTHER session's turn: a copy (a
    // new-file continuation's copied chain; see A COPIED CHAIN).
    function copied(sid, uuid) {
      const tid = uuid ? model.turnOfUuid(uuid) : null;
      const t = tid ? model.turn(tid) : null;
      return !!(t && t.session_id && t.session_id !== sid);
    }

    // The session's first live turn since its last reset, before `beforeId`.
    function firstLive(cid, sid, S, beforeId) {
      const list = sessionTurns(cid, sid);
      const first = resolve(S.first);
      let i = first ? list.findIndex((t) => t.id === first) : -1;
      if (i < 0) i = 0;
      const open = model.openTurnOf(cid);
      for (; i < list.length; i++) {
        const t = list[i];
        if (beforeId && t.id === beforeId) return null;
        if (!t.superseded && t.id !== open) return t.id;
      }
      return null;
    }

    function startBetween(S, from, to) {
      if (!finite(to)) return false;
      return S.starts.some((ts) => (from === null || ts > from) && ts <= to);
    }

    function supersede(cid, from, opts) {
      let r = null;
      try { r = model.supersede(cid, from, opts); } catch { r = null; }
      if (r && r.ok && Array.isArray(r.superseded) && r.superseded.length) counts[opts.reason === 'reset' ? 'resets' : 'anchors'] += 1;
      else counts.refused += 1;
      return r;
    }

    // ── case (b) ──
    function turnDuration(cid, sid, S, ch) {
      const count = Number.isSafeInteger(ch.message_count) ? ch.message_count : null;
      const ts = finite(ch.ts) ? ch.ts : null;
      const uuid = idOf(ch.uuid);
      // A copied turn-duration is another session's count: it never seeds the
      // comparison (and leaves what came since it in place).
      if (copied(sid, uuid)) { counts.copies += 1; return; }
      const tdTurn = (uuid && model.turnOfUuid(uuid)) || resolve(S.cur);
      const reset = S.count !== null && count !== null
        && S.count - count >= RESET_MIN_COUNT_DROP
        && count <= RESET_MAX_AFTER_COUNT
        && !S.compact
        && !S.exit
        && S.first_turn_records >= RESET_MIN_FIRST_TURN_RECORDS
        && !startBetween(S, S.td_ts, ts);
      if (reset && tdTurn && model.turn(tdTurn)) {
        const from = firstLive(cid, sid, S, tdTurn);
        const t = model.turn(tdTurn);
        if (from && from !== tdTurn) {
          supersede(cid, from, { reason: 'reset', at: finite(t.started_at) ? t.started_at : ts, until: tdTurn });
        }
        S.first = tdTurn;
      }
      S.count = count;
      S.td_ts = ts;
      S.compact = false;
      S.exit = false;
      S.first_turn_records = 0;
      S.first_turn_kinds = [];
    }

    function firstTurnRecord(S, kind) {
      S.first_turn_records += 1;
      if (!S.first_turn_kinds.includes(kind)) S.first_turn_kinds.push(kind);
    }

    // ── case (c) ──
    function evidence(cid, sid, S, ch, rest) {
      // The turn of the next opener after the evidence (the rewind's prompt), when
      // the batch already holds it.
      let untilId = null;
      for (const nx of rest) {
        if (isPlain(nx) && nx.type === 'opener') { untilId = openerTurn(nx); if (untilId) break; }
      }
      const at = finite(ch.ts) ? ch.ts : engine.now();
      const leaf = ch.leaf_uuid === null ? null : idOf(ch.leaf_uuid);
      if (ch.leaf_uuid !== null && !leaf) return;
      let from = null;
      if (leaf === null) {
        from = firstLive(cid, sid, S, untilId);
      } else if (S.anchors.has(leaf)) {
        from = resolve(S.anchors.get(leaf));
      } else {
        const t = resolve(model.turnOfUuid(leaf));
        if (!t) return;
        const list = sessionTurns(cid, sid);
        const i = list.findIndex((x) => x.id === t);
        from = i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
      }
      const ft = from ? model.turn(from) : null;
      if (!ft || ft.session_id !== sid || ft.superseded) return;
      if (from === untilId || from === model.openTurnOf(cid)) return;
      // It began before the evidence: its opener lies earlier in the file.
      const seg = model.segmentOf(from);
      const off = isPlain(ch.offset) && finite(ch.offset.start) ? ch.offset.start : null;
      const before = seg && off !== null ? seg.from < off : (finite(ft.started_at) && ft.started_at < at);
      if (!before) return;
      const opts = { reason: 'anchor', at };
      if (untilId) opts.until = untilId;
      supersede(cid, from, opts);
    }

    // ── the batch ──
    function onChanges(sessionId, changes, { conversation_id: cid } = {}) {
      const sid = idOf(sessionId);
      if (!sid || !cid || !Array.isArray(changes)) return;
      const S = stateOf(sid, cid);
      // A rewritten file: its first chain record is not the one it was.
      for (const ch of changes) {
        if (!isPlain(ch) || !finite(ch.seq) || !idOf(ch.uuid)) continue;
        if (S.head && ch.seq === S.head.seq && ch.uuid !== S.head.uuid) {
          const keep = { starts: S.starts };
          Object.assign(S, freshState(cid), keep);
        }
        break;
      }
      const mark = S.seq;
      for (let i = 0; i < changes.length; i++) {
        const ch = changes[i];
        if (!isPlain(ch)) continue;
        if (finite(ch.seq)) {
          if (mark !== null && ch.seq <= mark) { counts.skipped += 1; continue; }
          if (S.seq === null || ch.seq > S.seq) S.seq = ch.seq;
          if (!S.head && idOf(ch.uuid)) S.head = { seq: ch.seq, uuid: ch.uuid };
        }
        switch (ch.type) {
          case 'opener': {
            const tid = openerTurn(ch);
            if (!tid) break;
            // A copied opener opened another session's turn, not this one's.
            const ot = model.turn(tid);
            if (ot && ot.session_id && ot.session_id !== sid) break;
            S.cur = tid;
            if (!S.first) S.first = tid;
            const parent = idOf(ch.parent_uuid);
            if (parent && !S.anchors.has(parent)) {
              S.anchors.set(parent, tid);
              if (S.anchors.size > ANCHORS_MAX) S.anchors.delete(S.anchors.keys().next().value);
            }
            break;
          }
          case 'turn-duration': turnDuration(cid, sid, S, ch); break;
          case 'compact': S.compact = true; break;
          case 'record':
            if (ch.kind === EXIT_TAIL_KIND) S.exit = true;
            else if (FIRST_TURN_SET.has(ch.kind)) firstTurnRecord(S, ch.kind);
            break;
          case 'item':
            // attachment/model surfaces as the model notice when the model changed.
            if (isPlain(ch.item) && ch.item.kind === 'notice' && ch.item.notice === 'model') firstTurnRecord(S, 'attachment/model');
            break;
          case 'rewind-evidence': evidence(cid, sid, S, ch, changes.slice(i + 1)); break;
          default: break;
        }
      }
    }

    function onIngest(env, { conversation_id: cid, session_id: sid } = {}) {
      if (!isPlain(env) || env.event !== 'SessionStart') return;
      const id = idOf(sid) || idOf(env.session_id);
      if (!id || !finite(env.ts)) return;
      const S = stateOf(id, cid || null);
      if (!S.starts.includes(env.ts)) {
        S.starts.push(env.ts);
        S.starts.sort((a, b) => a - b);
        if (S.starts.length > STARTS_MAX) S.starts.shift();
      }
    }

    function onConversation({ change, conversation } = {}) {
      if (change !== 'removed' && change !== 'merged') return;
      const cid = isPlain(conversation) ? conversation.id : null;
      if (!cid) return;
      for (const [sid, S] of sessions) if (S.cid === cid) sessions.delete(sid);
    }

    // ── the index slice (§2.11) ──
    function persistState(sessionId) {
      const S = sessions.get(sessionId);
      if (!S) return undefined;
      return {
        v: STATE_VERSION, seq: S.seq, head: S.head, count: S.count, td_ts: S.td_ts, compact: S.compact, exit: S.exit,
        first_turn_records: S.first_turn_records, first_turn_kinds: [...S.first_turn_kinds], starts: [...S.starts],
        first: S.first, cur: S.cur, anchors: [...S.anchors],
      };
    }

    function restoreState(sessionId, value) {
      const sid = idOf(sessionId);
      if (!sid || !isPlain(value) || value.v !== STATE_VERSION) return;
      const prev = sessions.get(sid);
      const S = freshState(prev ? prev.cid : null);
      S.seq = finite(value.seq) ? value.seq : null;
      if (isPlain(value.head) && finite(value.head.seq) && idOf(value.head.uuid)) S.head = { seq: value.head.seq, uuid: value.head.uuid };
      S.count = Number.isSafeInteger(value.count) ? value.count : null;
      S.td_ts = finite(value.td_ts) ? value.td_ts : null;
      S.compact = value.compact === true;
      S.exit = value.exit === true;
      S.first_turn_records = Number.isSafeInteger(value.first_turn_records) && value.first_turn_records > 0 ? value.first_turn_records : 0;
      S.first_turn_kinds = Array.isArray(value.first_turn_kinds) ? value.first_turn_kinds.filter((k) => FIRST_TURN_SET.has(k)) : [];
      const starts = Array.isArray(value.starts) ? value.starts.filter(finite) : [];
      // SessionStarts this process heard before the index was read are kept too.
      for (const ts of prev ? prev.starts : []) if (!starts.includes(ts)) starts.push(ts);
      S.starts = starts.sort((a, b) => a - b).slice(-STARTS_MAX);
      S.first = idOf(value.first);
      S.cur = idOf(value.cur);
      if (Array.isArray(value.anchors)) {
        for (const pair of value.anchors.slice(-ANCHORS_MAX)) {
          if (Array.isArray(pair) && idOf(pair[0]) && idOf(pair[1]) && !S.anchors.has(pair[0])) S.anchors.set(pair[0], pair[1]);
        }
      }
      sessions.set(sid, S);
    }

    return {
      start: async () => {},
      stop: async () => {},
      onIngest,
      onChanges,
      onConversation,
      persistState,
      restoreState,
      diagnostics: () => ({ sources: { rewinds: { sessions: stateIds(), ...counts } } }),
    };
  }
  return { attach };
}

module.exports = {
  createRewindsSource,
  SOURCE_NAME,
  STATE_VERSION,
  FIRST_TURN_KINDS,
  RESET_MIN_COUNT_DROP,
  RESET_MIN_FIRST_TURN_RECORDS,
  RESET_MAX_AFTER_COUNT,
};

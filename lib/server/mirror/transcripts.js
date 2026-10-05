// lib/server/mirror/transcripts.js — the transcripts source: the mirror's
// durable content (spec §2.2–§2.5, §2.9, §2.11, §2.12, §15.6).
//
//   createTranscriptsSource({ createStore, createTailer = require('./tail').createTailer,
//                             pollMs = 500 }) → { attach(engine) }
//
// Registered on the facade as `transcripts` (lib/server/mirror/index.js SOURCES,
// with lib/server/mirror/index-store.js createIndexStore as `createStore`), it
// codes against THE SOURCE CONTRACT in index.js's header and nothing else. What
// attach returns: {start, stop, onIngest, onConversation, onTurnClosed,
// persistState, restoreState, diagnostics, api: {turns, turn, itemField,
// attachment, skillFold, forkAnchor}} — the api the facade's dispatch table
// routes to, whose answers pass the facade's read boundary (redactOut) after
// they leave here (skillFold excepted: in process only, never over HTTP).
//
// THE PIPELINE, per session. A tailer (tail.js) on the session's transcript,
// engine.conversations.transcriptPath(sid) — fenced by the registry, and null for
// a session the session scope switched off, which is then never tailed — with
// engine.watchFile (so mirror.stop() stops the watch too) and
// engine.files.transcriptFile as its fence. Each batch it hands over is split at
// the turn openers (records.js: a row whose `turn` route is 'opener'), and each
// piece goes, in file order, through
//   normalize (normalize.js)        → the turn machine's changes, each with its seq
//   foldMeta (meta.js)              → the conversation's meta patch, its title, and
//                                     the batch's known values
//   foldCarriers (carriers.js)      → task and queued items, and delivery markers
// Then, for the whole batch, in this order:
//   1. every known value (the account email, the organisation id) is registered
//      with engine.redactor.addKnown FIRST, so nothing of that batch is stored
//      unmasked; the newest organisation id is kept in process, for skillFold
//      alone (never persisted, never in an answer);
//   2. the normalizer's and the carriers' changes are merged by byte offset into
//      one list in file order. THE SEQ RULE (ruled U27@seq, one rule in U26, U27
//      and this file): every change handed to applyChanges carries an integer
//      `seq`, its record's file ordinal — the normalizer stamps its own; a
//      carrier change takes the seq of the normalizer's change for the same
//      record (matched by offset.start), or, should there be none, that record's
//      ordinal counted the way the normalizer counts (every record the tailer
//      hands over, bad and oversize ones included) — so a whole-file re-read
//      (catch-up, resume, refill) numbers every change as the live batches did;
//   3. a fork's copied turns are dropped (below), and each delivery marker
//      becomes a `{kind:'mirror', op:'delivered', conversation_id, via, marker}`
//      transition;
//   4. engine.applyChanges(sid, changes, {conversation_id});
//   5. engine.model.upsertConversation(cid, metaPatch), and when the title changed,
//      engine.conversations.noteTitle(cid, title) (so it survives a restart);
//   6. engine.live.noteActivity(cid, at, 'transcript'), the newest record time;
//   7. the conversation's content-free diagnostics: model.upsertConversation(cid,
//      {diagnostics: {unknown_kinds, bad_lines, oversize_lines, transcript:
//      'ok'|'waiting'|'absent'}}), when they changed.
// A hook envelope's meta (SessionStart's model, permission_mode) is folded
// through meta.js foldEnvelope in onIngest.
//
// WHICH SESSIONS. Every session of every conversation the registry holds
// (engine.conversations.list() at start, then each onConversation): the current
// session of a live conversation is FOLLOWED; any other (an earlier session of a
// /clear chain, or the current one of an ended conversation) is read ONCE — from
// its index, or caught up — and its tailer stopped. On 'linked' (a /clear, a
// resume, a merge) the file of `previous_session_id` is drained to EOF before
// the new session is followed (U10's hand-off 2), so both sessions' turns land
// in one conversation in order. SessionEnd drains its session in the background
// and stops that tailer unless it is still its conversation's current session;
// 'ended' does the same for the conversation. 'merged' and 'removed' stop and
// forget the conversation's sessions (store.drop; deleting index files is the
// registry's, never this file's). A session that moved to another conversation
// (a merge found later) is read again into its new one. All of this runs on ONE
// job chain, in order, so one catch-up runs at a time; no hook ever awaits it.
// Hooks can arrive before start() (ignored: start() reads the registry), and
// start() and stop() repeat when web-chat is switched off and on.
//
// FORKS (§2.2, V14). A `--fork-session` file begins with copies of another
// conversation's turns. While a file's first opener is still to come, an opener
// whose turn id (its promptId, or `u_<uuid>`), or whose record uuid, already
// belongs to ANOTHER conversation marks the session a copy:
// engine.conversations.markFork(cid, {forked_from}) once, and every change up
// to the first opener that is not a copy is dropped (its delivery markers too).
// So a conversation the registry already marks `forked_from` is reconciled only
// after its source: the job chain then reads (or restores) the source first, and
// a boot with no index never hands the fork the source's turns.
//
// CATCH-UP (§2.9). A session with no valid index is read from 0 inside
// engine.beginIndex({conversation_id}) … end(): no stream frame goes out for the
// conversation until the read reaches EOF, then one mirror:reset. The tailer
// awaits each batch, and a catch-up batch yields a turn of the event loop, so a
// long transcript never holds the loop. Historical turns fire onTurnOpened /
// onTurnClosed like live ones (the turn machine's; nothing here snapshots).
//
// RESUME (§2.3, §2.11). On each onTurnClosed, at the end of each catch-up and at
// stop, store.schedule(sid, () => snapshot) (the store debounces and writes).
// The snapshot resumes at a TURN BOUNDARY: when the session's transcript turn is
// open, just before its opener (the states held at that record), else after the
// last record read. A session with a valid index is restored —
// engine.model.restoreTurns(cid, index.turns), the meta fold, every source's
// slice (engine.restoreSourceStates, which hands this source its normalizer and
// carriers state back) — and its tailer starts at index.resume. The tailer
// re-checks the resume itself; a rejected one re-reads from 0 (content-derived
// ids make that idempotent) with the states reset.
//
// KNOWN VALUES ACROSS A RESTART (ruled U28b@known-ranges). The index never holds
// a known value (the account email, the organisation id), so a restart must
// register them again before anything after the resume point is stored. This
// source's slice keeps, instead of the values, the byte range [start, end) of
// the first line that registered each distinct one (`known`: at most
// KNOWN_RANGES_MAX a session, the newest kept). On a resume each recorded range
// below index.resume is re-read through store.readRange, its records folded with
// foldMeta and their values registered (learnKnown) before the tailer hands over
// a batch: no other byte of the prefix is read. Only a slice with no ranges — an
// index written before SLICE_VERSION 2 — falls back to the walk of the whole
// prefix (only lines naming credential_org or session_context are parsed), and
// that walk records the ranges, so it runs once. A range that cannot be re-read
// falls back to the walk too.
//
// THE LRU (model.js). A turn engine.model.isEvicted(id) is refilled before a
// read: store.readRange(file, engine.model.segmentOf(id)) → normalize, from the
// normalizer state held at the turn's opener (kept per session, see `starts`),
// AND foldCarriers with a fresh state on the same records (ruled
// U28a@refill-carriers) → merged by offset, seq stamped by the seq rule →
// engine.model.refill(id, changes). An evicted turn comes back with its task and
// queued items under the seq they had.
//
// THE STORE CONTRACT. U28b implements it (lib/server/mirror/index-store.js);
// the tests implement a fake. Everything is per session id:
//
//   createStore({ paths, timers, now, log, files, redactor }) → store
//     paths, timers, now, log, files, redactor   the engine's (engine.paths …):
//                 timers are the engine's, which mirror.stop() clears; files is
//                 lib/core/claude-files (readWindow); redactor is ctx.redactor
//   store.load(sessionId, { file }) → Promise<{ ok: true, index } | { ok: false, reason }>
//                 `file` is the session's fenced transcript path. The index is
//                 the object a snapshot gave (below), read back and checked; the
//                 store also verifies it against `file` (its dev, ino, head hash
//                 and a size of at least resume.offset) and answers
//                 {ok: false, reason: 'stale'} when the file is not the one
//                 indexed, 'absent' when there is none, 'corrupt' / 'invalid'
//                 otherwise. It never checks conversation_id: a session merged
//                 into another conversation is restored into its new one.
//   store.schedule(sessionId, snapshotFn)      debounced (2 s per session); the
//                 store calls snapshotFn() when it writes, and writes nothing
//                 when it returns null
//   store.flush(sessionId?) → Promise           write what is pending now (one
//                 session, or all)
//   store.drop(sessionId)                       forget what is pending; no write,
//                 no file deleted
//   store.readRange(file, { from, to }) → Promise<string | null>
//                 the whole lines of bytes [from, to) of `file` (a fenced
//                 transcript path), as text; null when the range cannot be read
//                 whole (a line longer than readWindow's 8 MiB, a file gone)
//   store.stop() → Promise                      flush, then cancel every timer;
//                 a store is not used after stop() (start() makes a new one)
//
//   snapshot = {
//     v: 1, session_id, conversation_id,
//     slug,          the transcript's directory under Claude Code's projectsDir
//     file:          { dev, ino, size, head_len, head_hash } | null, from the
//                    tailer's resume (size: the bytes read so far)
//     resume:        the tailer's resumeAt(record) | null (null: read from 0)
//     turns:         [{ id, header, internal }] — engine.model.exportTurns(sid)'s
//                    entries with the header's id on top (conversations.js
//                    deletePruned reads turns[].id); headers are redacted already
//     state: {
//       meta,        the meta fold's state (meta.js) WITHOUT its skills — raw
//                    transcript text (title, first_prompt, away.text, …): the
//                    store redacts it before it persists it (ruled
//                    U27@meta.js:18-raw-text-in-persisted-state); handed over
//                    unredacted, with no second pass here
//       skills:      { names, descriptions }, the skills fold
//       sources:     engine.sourceStates(sid) (each through the redactor), this
//                    source's own slice included: {v: SLICE_VERSION, norm,
//                    carriers, fork, fork_from, starts, known} — `known` the
//                    byte ranges [[start, end]] of the lines that carried known
//                    values (see KNOWN VALUES ACROSS A RESTART), never a value
//     } }
//   It never holds the organisation id or the account email: neither fold keeps
//   them, and they live in process only.
//
// THE READ API. Answers are built from model.serialize* and turnPage, which drop
// every `_` field, so no transcript, tool-results or task-output path is ever in
// one, and no field is named like a credential (the read boundary's json-key rule
// would mask it whole: `next_before`, never `next_token`).
//   turns(cid, {before, limit, items}) → {conversation_id, turns, next_before, total} | null
//       items 'none' (default) | 'summary' | 'full': each turn carries `items` at
//       that level (refilled first), or `items_unavailable: true`
//   turn(id) → {turn, items (full caps)} | null
//   itemField(id, {field: 'text'|'input'|'result', from, max ≤ 262144})
//       → {id, field, text, from, to, total, eof} | null
//       From the model's full-cap item; a result with a persisted output is read
//       from its tool-results file instead, opened only through
//       engine.files.sessionDirFile(engine.conversations.sessionDir(sid), path),
//       one readWindow({from, maxBytes: max}) cleaned by engine.redactor.window
//       with the call's {file, command} context; `to` is the window's `next`, so
//       a pager passing it back as `from` loses no line (U21's hand-off 1).
//       Offsets are characters for the model's text, bytes for a file.
//   attachment(id, n) → {media_type, bytes, name?} | null: the block's base64,
//       re-read through store.readRange and decoded; only image/png, image/jpeg,
//       image/gif, image/webp and application/pdf whose leading bytes match the
//       claimed type, at most ATTACHMENT_MAX_BYTES (6,242,304 bytes = 6 MiB − 48
//       KiB; ruled U28b@attachment-limit). Why that number: the attachment sits
//       in ONE transcript line as base64, and store.readRange reads a line whole
//       only up to readWindow's 8 MiB (lib/core/claude-files WINDOW_MAX_BYTES);
//       6,242,304 bytes are 8,323,072 base64 characters, which leaves 64 KiB of
//       that line for the record around them. A larger attachment could not be
//       re-read anyway, and the chat shows its file location and size instead of
//       asking (U37). One over the limit answers null before its base64 is
//       decoded; a record whose attachments together pass 8 MiB answers null for
//       every one of them (readRange's line rule). The content route
//       (lib/server/routes/mirror-content.js) serves up to this same constant.
//   skillFold(cid) → {names, descriptions, orgUuid}: in process only
//   forkAnchor(turnId) → {session_id, parent_uuid} (the turn opener's
//       parentUuid) | {refused: 'unknown'|'superseded'|'first'}
//   diagnostics() → {versions_seen, tested, skew, unknown_kinds, bad_lines},
//       content-free (kind names and counts)
//
// STOP. Every tailer is stopped (nothing is handed over once that is called),
// each session's snapshot scheduled and the store flushed and stopped, all within
// STOP_BUDGET_MS, under the graceful shutdown's 2 s ceiling on a source's stop
// (lib/server/index.js MIRROR_STOP_TIMEOUT_MS). The tailer's stop() and drain()
// are never awaited inside its own callbacks (U24's hand-off: that deadlocks).
//
// Dependency direction: lib/server; imports lib/core and its siblings in
// lib/server/mirror (tail, records, normalize, meta, carriers).

'use strict';

const path = require('path');
const { createTailer: defaultCreateTailer } = require('./tail');
const { kindOf, rowOf, TESTED } = require('./records');
const { normalize, initialState } = require('./normalize');
const { initialMeta, foldMeta, foldEnvelope } = require('./meta');
const { initialCarriers, foldCarriers } = require('./carriers');
const { fileOf } = require('../../core/tool-input');
const { compareVersions } = require('../../core/versions');

// ── constants ────────────────────────────────────────────────────────────────

const STATE_VERSION = 1;
// This source's own slice of the index (state.sources.transcripts). 2: it carries
// `known`, the known-value line ranges; a slice of 1 has none (the walk runs).
const SLICE_VERSION = 2;
// Known-value line ranges kept per session, newest kept (ruled U28b@known-ranges).
const KNOWN_RANGES_MAX = 32;
// A main transcript's poll (§2.3: the watch alone caught 6–12 of 9–16 appends, V1).
const POLL_MS = 500;
// itemField's largest page (§2.4's full-read cap per read).
const FIELD_MAX = 256 * 1024;
// The largest attachment answered, and the content route's cap (it requires this
// constant): 6 MiB − 48 KiB, the largest decoded attachment whose base64 still
// fits readWindow's 8 MiB line with up to 64 KiB of record around it (ruled
// U28b@attachment-limit; see attachment() in the header).
const ATTACHMENT_MAX_BYTES = 6242304;
// A turns() page: the default and the most one call may ask.
const TURNS_LIMIT = 20;
const TURNS_LIMIT_MAX = 200;
// Normalizer states kept per session at its openers (for the LRU's refill),
// newest kept; the index's 5,000-turn bound (§2.11).
const STARTS_MAX = 5000;
// Item id → its turn, for an item whose turn the LRU emptied (bounded, oldest out).
const ITEM_TURNS_MAX = 100000;
// The source's whole stop, under the graceful shutdown's 2 s per source.
const STOP_BUDGET_MS = 1500;
// The known-value scan before a resume offset reads this much at a time.
const KNOWN_PAGE_BYTES = 1024 * 1024;
const KNOWN_MARKS = ['"credential_org"', '"session_context"'];
// Diagnostics: at most this many distinct kinds counted.
const KINDS_MAX = 64;
// The item ids derived from a turn's id (§2.4).
const TURN_ITEM_PREFIXES = ['p_', 'rl_', 'rw_'];

// The opener kinds at which the normalizer clears its per-turn accumulators
// (normalize.js startTurn): its state just before one, so trimmed, is exact and
// small. A task notification keeps its open tool calls (it may be absorbed);
// a bash-mode record may be bash output, which opens nothing, and is not trimmed.
const TRIM_AT = Object.freeze({
  'user/prompt': 'all',
  'user/prompt+image': 'all',
  'user/channel': 'all',
  'user/slash-command': 'all',
  'user/task-notification': 'keep-tools',
});

// An attachment's media types, and the bytes each must start with. GIF's
// signature is spelled as bytes: its text belongs to lib/core/gif.js (the
// conventions ratchet), and this only reads one.
const MAGIC = Object.freeze({
  'image/png': (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
    && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  'image/webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'application/pdf': (b) => b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-',
});

// ── small helpers ────────────────────────────────────────────────────────────

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' && v ? v : null);
const yieldTurn = () => new Promise((resolve) => { setImmediate(resolve); });
const startOf = (ch) => (isPlain(ch) && isPlain(ch.offset) && finite(ch.offset.start) ? ch.offset.start : null);

function kindOfRec(rec) {
  return rec && isPlain(rec.obj) ? kindOf(rec.obj) : null;
}
// A record whose kind carries a known value (records.js: its row's `known`).
function isKnownRec(rec) {
  const kind = kindOfRec(rec);
  const row = kind ? rowOf(kind) : null;
  return Boolean(row && row.known);
}
// The known values one record carries, through the meta fold (it alone reads them).
function knownOfRec(rec) {
  if (!isKnownRec(rec)) return [];
  const { known } = foldMeta(initialMeta(), [rec], {});
  return Array.isArray(known) ? known : [];
}
// How many bytes `b64` decodes to, without decoding it (padding counted out).
function decodedLength(b64) {
  let n = b64.length;
  let pad = 0;
  while (pad < 2 && n > 0 && b64.charCodeAt(n - 1) === 0x3d) { n -= 1; pad += 1; }
  return Math.floor((n * 3) / 4);
}
function isOpenerRec(rec) {
  const kind = kindOfRec(rec);
  const row = kind ? rowOf(kind) : null;
  return Boolean(row && row.turn === 'opener');
}

// A count map that holds any key safely, bounded.
function bump(map, key, n = 1) {
  const k = String(key).slice(0, 100);
  if (!Object.hasOwn(map, k)) {
    if (Object.keys(map).length >= KINDS_MAX) return;
    Object.defineProperty(map, k, { value: 0, enumerable: true, writable: true, configurable: true });
  }
  map[k] += n;
}

// The normalizer's state just before `rec`, with what the normalizer clears at
// that record dropped (see TRIM_AT).
function trimmedNorm(norm, rec) {
  const how = TRIM_AT[kindOfRec(rec)];
  if (!how) return norm;
  const out = { ...norm, msgs: {}, attach: [], cmd: null };
  if (how === 'all') out.tools = {};
  return out;
}

// The meta fold's state as model.upsertConversation's patch (meta.js patchOf's
// shape): what a restored conversation shows before its next change.
function metaPatchOf(s) {
  if (!isPlain(s)) return null;
  const p = {};
  for (const k of ['title', 'model', 'permission_mode', 'mode', 'effort']) if (str(s[k])) p[k] = s[k];
  const cost = isPlain(s.cost) ? s.cost : {};
  p.cost = { usd: finite(cost.usd) ? cost.usd : null, source: str(cost.source), tokens: isPlain(s.tokens) ? { ...s.tokens } : {} };
  if (isPlain(s.away)) p.away = { ...s.away };
  return p;
}

// The whole lines of `text`, read from byte `from`, as the tailer hands records
// over: [{line, obj, bad, oversize, start, end}], empty lines skipped (and not
// counted), byte offsets exact.
function parseLines(text, from) {
  const out = [];
  if (typeof text !== 'string') return out;
  const lines = text.split('\n');
  const last = lines.length - 1; // the text after the last newline (whole lines only: '')
  let pos = from;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === last && line === '') break;
    const end = pos + Buffer.byteLength(line, 'utf8') + (i < last ? 1 : 0);
    if (line !== '') {
      let obj = null;
      try { const v = JSON.parse(line); obj = isPlain(v) ? v : null; } catch { obj = null; }
      out.push({ line, obj, bad: obj === null, oversize: false, start: pos, end });
    }
    pos = end;
  }
  return out;
}

// The normalizer's and the carriers' changes of the same records, merged by
// offset into one list in file order (the normalizer's first at one offset), each
// carrier change stamped by THE SEQ RULE (see the header). `recs` are the records
// both read and `seqBefore` the ordinal before the first of them.
function mergeChanges(nch, cch, recs, seqBefore) {
  const seqAt = new Map();
  for (const ch of nch) {
    const s = startOf(ch);
    if (s !== null && Number.isSafeInteger(ch.seq) && !seqAt.has(s)) seqAt.set(s, ch.seq);
  }
  let ordinals = null;
  const ordinalOf = (s) => {
    if (!ordinals) {
      ordinals = new Map();
      let k = seqBefore;
      for (const r of recs) {
        if (!r || typeof r !== 'object') continue;
        k += 1;
        if (finite(r.start)) ordinals.set(r.start, k);
      }
    }
    return ordinals.get(s);
  };
  const stamped = cch.map((ch) => {
    const s = startOf(ch);
    const seq = s === null ? undefined : seqAt.has(s) ? seqAt.get(s) : ordinalOf(s);
    return Number.isSafeInteger(seq) ? { ...ch, seq } : { ...ch };
  });
  const out = [];
  let a = 0;
  let b = 0;
  while (a < nch.length || b < stamped.length) {
    if (b >= stamped.length) { out.push(nch[a++]); continue; }
    if (a >= nch.length) { out.push(stamped[b++]); continue; }
    const sa = startOf(nch[a]);
    const sb = startOf(stamped[b]);
    if (sa === null || sb === null || sa <= sb) out.push(nch[a++]);
    else out.push(stamped[b++]);
  }
  return out;
}

// ── the source ───────────────────────────────────────────────────────────────

function createTranscriptsSource({ createStore, createTailer = defaultCreateTailer, pollMs = POLL_MS } = {}) {
  if (typeof createStore !== 'function') {
    throw new TypeError('createTranscriptsSource: createStore (the turn index store, index-store.js createIndexStore) is required');
  }
  if (typeof createTailer !== 'function') throw new TypeError('createTranscriptsSource: createTailer must be a function');
  return Object.freeze({ attach: (engine) => attachTranscripts(engine, { createStore, createTailer, pollMs }) });
}

function attachTranscripts(engine, { createStore, createTailer, pollMs }) {
  const sessions = new Map(); // session id → S (see newSession)
  const convs = new Map(); // conversation id → { meta, orgUuid, metaFrom, diagKey }
  const itemTurns = new Map(); // item id → turn id
  const refills = new Map(); // turn id → the refill in flight
  const versionsSeen = new Map(); // version → count
  const diagTotals = { unknown_kinds: {}, bad_lines: 0 };
  let store = null;
  let running = false;
  let gen = 0;
  let chain = Promise.resolve();
  const pendingStops = new Set();

  function say(msg) { try { engine.log(msg); } catch { /* a logger never breaks the source */ } }
  function fail(stage, e) {
    const word = [e && e.code, e && e.name].find((w) => typeof w === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(w)) || 'Error';
    say(`mirror transcripts: ${stage} failed (${word})`);
  }

  // ── the store ──
  function ensureStore() {
    if (!store) {
      store = createStore({
        paths: engine.paths, timers: engine.timers, now: engine.now, log: engine.log, files: engine.files, redactor: engine.redactor,
      });
    }
    return store;
  }
  async function callStore(method, ...args) {
    try {
      const s = ensureStore();
      if (!s || typeof s[method] !== 'function') return null;
      return await s[method](...args);
    } catch (e) {
      fail(`store.${method}`, e);
      return null;
    }
  }
  function scheduleSave(S) {
    if (!S || !S.file || S.closed) return;
    try {
      ensureStore().schedule(S.sid, () => (S.closed ? null : snapshot(S)));
    } catch (e) { fail('store.schedule', e); }
  }

  // ── the job chain: one lifecycle step at a time, in order ──
  function enqueue(fn) {
    const g = gen;
    const job = chain.then(() => (running && g === gen ? fn() : undefined)).catch((e) => fail('job', e));
    chain = job;
    return job;
  }

  // ── per-conversation and per-session state ──
  function conv(cid) {
    let C = convs.get(cid);
    if (!C) {
      C = { meta: initialMeta(), orgUuid: null, metaFrom: null, diagKey: null };
      convs.set(cid, C);
    }
    return C;
  }

  function newSession(sid, cid, mode) {
    return {
      sid, cid, mode, // 'follow' (the current session of a live conversation) | 'once'
      file: null, slug: null,
      tailer: null,
      loaded: false, // the index was asked for (once per session per start)
      done: false, // a 'once' session read to its end
      closed: false,
      catchingUp: false,
      refused: false,
      norm: initialState(),
      carriers: initialCarriers(),
      starts: [], // [[opener offset, normalizer state before it]], ascending
      fork: 'unknown', // 'unknown' until the file's first opener, then 'copy' or 'own'
      forkFrom: null,
      lastResume: null, // resumeAt of the last record read (the after-the-last-record point)
      boundary: null, // the states just before the latest opener (the open turn's point)
      known: [], // [[start, end]] of the first line that registered each known value, oldest first
      knownSeen: new Set(), // the values those lines registered (in process only, never persisted)
      knownWhole: true, // `known` covers everything read so far (false: restored from a slice without ranges)
      diag: { unknown_kinds: {}, bad_lines: 0, oversize_lines: 0 },
    };
  }

  function convIdOf(id) {
    if (typeof id !== 'string' || !id) return null;
    if (engine.model.conversation(id)) return id;
    const v = engine.conversations.get(id) || engine.conversations.bySession(id);
    return v && engine.model.conversation(v.id) ? v.id : null;
  }

  function isCurrent(S) {
    const v = engine.conversations.get(S.cid);
    return Boolean(v && v.current_session_id === S.sid && !finite(v.ended_at));
  }

  // ── which sessions (see WHICH SESSIONS) ──
  function reconcile(cid, visiting = new Set()) {
    if (!running || visiting.has(cid)) return;
    visiting.add(cid);
    const v = engine.conversations.get(cid);
    if (!v || v.id !== cid) return;
    // A fork's source first (see FORKS): its turns must be in the model before
    // the fork's catch-up asks whom its copied openers belong to.
    const from = typeof v.forked_from === 'string' && v.forked_from ? engine.conversations.get(v.forked_from) : null;
    if (from && from.id !== cid) reconcile(from.id, visiting);
    const ended = finite(v.ended_at);
    for (const s of v.sessions || []) {
      const sid = s && s.session_id;
      if (typeof sid !== 'string' || !sid) continue;
      const want = sid === v.current_session_id && !ended ? 'follow' : 'once';
      let S = sessions.get(sid);
      if (S && S.cid !== cid) { forgetSession(S); S = null; } // moved: read again into its new conversation
      if (!S) {
        S = newSession(sid, cid, want);
        sessions.set(sid, S);
        conv(cid);
        const it = S;
        enqueue(() => openSession(it));
        continue;
      }
      if (S.mode === want) {
        // A session switched off after it was linked is never handed out: stop it.
        if (S.tailer && !engine.conversations.transcriptPath(sid)) { stopTailer(S); S.refused = true; noteDiag(S); }
        else if (!S.tailer && want === 'follow' && S.loaded && engine.conversations.transcriptPath(sid)) {
          const it = S;
          enqueue(() => openSession(it));
        }
        continue;
      }
      S.mode = want;
      const it = S;
      if (want === 'once') enqueue(() => finishOnce(it));
      else { it.done = false; enqueue(() => openSession(it)); }
    }
  }

  // Read a 'once' session to EOF and stop its tailer (outside every callback).
  async function finishOnce(S) {
    if (S.mode !== 'once' || S.closed) return;
    const t = S.tailer;
    if (t) {
      await t.drain();
      if (S.mode !== 'once' || S.tailer !== t) return;
      S.tailer = null;
      await t.stop();
    }
    S.done = true;
    scheduleSave(S);
  }

  function stopTailer(S) {
    const t = S.tailer;
    S.tailer = null;
    if (!t) return;
    const p = Promise.resolve().then(() => t.stop()).catch((e) => fail('tailer.stop', e));
    pendingStops.add(p);
    p.finally(() => pendingStops.delete(p));
  }

  function forgetSession(S) {
    S.closed = true;
    stopTailer(S);
    sessions.delete(S.sid);
    if (store) { try { store.drop(S.sid); } catch (e) { fail('store.drop', e); } }
  }

  function forgetConversation(cid) {
    for (const S of [...sessions.values()]) if (S.cid === cid) forgetSession(S);
    convs.delete(cid);
  }

  // ── opening a session: load the index or catch up, then tail ──
  async function openSession(S) {
    if (S.closed || S.tailer || (S.mode === 'once' && S.done)) return;
    const file = engine.conversations.transcriptPath(S.sid);
    if (!file) { S.refused = true; noteDiag(S); return; }
    S.refused = false;
    S.file = file;
    S.slug = path.basename(path.dirname(file));
    const end = engine.beginIndex({ conversation_id: S.cid, reason: 'catch-up' });
    let tailer = null;
    S.catchingUp = true;
    try {
      let resume = S.lastResume;
      if (!S.loaded) {
        S.loaded = true;
        const r = await callStore('load', S.sid, { file });
        if (!running || S.closed) return;
        resume = r && r.ok === true && isPlain(r.index) ? restoreIndex(S, r.index) : null;
        if (resume) await recoverKnown(S, resume.offset);
        if (!running || S.closed) return;
      }
      tailer = makeTailer(S, resume);
      S.tailer = tailer;
      await tailer.start();
    } finally {
      S.catchingUp = false;
      end();
    }
    noteDiag(S);
    scheduleSave(S);
    if (S.mode === 'once' && S.tailer === tailer && !S.closed) {
      S.tailer = null;
      S.done = true;
      await tailer.stop();
    }
  }

  function makeTailer(S, resume) {
    let t = null;
    t = createTailer({
      file: S.file,
      resume,
      pollMs,
      watchFile: engine.watchFile,
      fence: engine.files.transcriptFile,
      onRecords: (recs) => onRecords(S, t, recs),
      onReset: (info) => onReset(S, info),
      onError: (e) => onTailError(S, e),
      log: (m) => say(typeof m === 'string' ? m : 'mirror transcripts: tailer'),
    });
    return t;
  }

  // An index from the store: the turns, the folds and every source's slice back.
  // Answers the resume, or null when the index cannot be used.
  function restoreIndex(S, ix) {
    if (ix.session_id !== S.sid || ix.v !== STATE_VERSION) return null;
    const resume = isPlain(ix.resume) && finite(ix.resume.offset) ? ix.resume : null;
    const state = isPlain(ix.state) ? ix.state : {};
    if (Array.isArray(ix.turns)) {
      try { engine.model.restoreTurns(S.cid, ix.turns); } catch (e) { fail('restoreTurns', e); }
    }
    const C = conv(S.cid);
    // Until this source's slice says otherwise, nothing is known about the ranges.
    S.known = [];
    S.knownSeen = new Set();
    S.knownWhole = false;
    if (isPlain(state.meta) && (C.metaFrom === null || isCurrent(S))) {
      const skills = isPlain(state.skills) ? state.skills : { names: [], descriptions: {} };
      const folded = foldMeta({ ...state.meta, skills }, [], { sessionName: nameOf(S.cid) });
      C.meta = folded.state;
      C.metaFrom = S.sid;
      const patch = metaPatchOf(C.meta);
      if (patch) { try { engine.model.upsertConversation(S.cid, patch); } catch (e) { fail('meta', e); } }
    }
    try { engine.restoreSourceStates(S.sid, isPlain(state.sources) ? state.sources : {}); } catch (e) { fail('restoreSourceStates', e); }
    if (!resume) {
      // Read from 0: whatever a slice said, the states start over.
      S.norm = initialState();
      S.carriers = initialCarriers();
      S.starts = [];
      S.fork = 'unknown';
      resetKnown(S);
    }
    S.lastResume = resume;
    S.boundary = null;
    return resume;
  }

  // ── known values across a restart (see KNOWN VALUES ACROSS A RESTART) ──
  function resetKnown(S) {
    S.known = [];
    S.knownSeen = new Set();
    S.knownWhole = true;
  }

  // Record the line that first registered each value `rec` carries.
  function noteKnownRec(S, rec) {
    for (const k of knownOfRec(rec)) {
      if (!isPlain(k) || typeof k.value !== 'string' || !k.value) continue;
      const key = `${k.label}\u0000${k.value}`;
      if (S.knownSeen.has(key)) continue;
      S.knownSeen.add(key);
      if (!Number.isSafeInteger(rec.start) || !Number.isSafeInteger(rec.end) || rec.end <= rec.start) continue;
      if (S.known.some(([s]) => s === rec.start)) continue;
      S.known.push([rec.start, rec.end]);
      if (S.known.length > KNOWN_RANGES_MAX) S.known.splice(0, S.known.length - KNOWN_RANGES_MAX);
    }
  }

  // Learn what a record carries and note where it came from.
  function learnFrom(S, recs) {
    const known = [];
    for (const r of recs) {
      if (!isKnownRec(r)) continue;
      for (const k of knownOfRec(r)) known.push(k);
      noteKnownRec(S, r);
    }
    if (known.length) learnKnown(conv(S.cid), known);
  }

  // The known values a resumed session's index never holds, registered again
  // before its tailer starts: from the recorded line ranges below `upto`, or,
  // when the slice has none to trust (or one cannot be re-read), from the walk.
  async function recoverKnown(S, upto) {
    if (!finite(upto) || upto <= 0) return;
    if (S.knownWhole) {
      let whole = true;
      for (const [start, end] of [...S.known]) {
        if (end > upto) continue; // the tailer reads it again
        const text = await callStore('readRange', S.file, { from: start, to: end });
        if (!running || S.closed) return;
        if (typeof text !== 'string') { whole = false; break; }
        learnFrom(S, parseLines(text, start));
      }
      if (whole) return;
    }
    await scanKnown(S, upto);
  }

  // The walk of the whole prefix before the resume offset: only lines naming the
  // two record kinds that carry a known value are parsed, and their ranges are
  // recorded. One page at a time, a turn of the loop between pages.
  async function scanKnown(S, upto) {
    resetKnown(S);
    let from = 0;
    while (from < upto && running && !S.closed) {
      let w = null;
      try { w = engine.files.readWindow(S.file, { from, maxBytes: Math.max(1, Math.min(KNOWN_PAGE_BYTES, upto - from)) }); } catch { w = null; }
      if (!w || !(w.to > w.from)) break;
      const lines = w.text.split('\n');
      if (!w.complete || w.next < w.to) lines.pop(); // the cut line starts the next page
      const recs = [];
      let pos = w.from;
      for (const line of lines) {
        const start = pos;
        pos += Buffer.byteLength(line, 'utf8') + 1;
        if (!KNOWN_MARKS.some((m) => line.includes(m))) continue;
        try { const v = JSON.parse(line); if (isPlain(v)) recs.push({ obj: v, start, end: pos }); } catch { /* not a record */ }
      }
      if (recs.length) learnFrom(S, recs);
      const next = w.next > from ? w.next : w.to;
      if (next <= from) break;
      from = next;
      await yieldTurn();
    }
    // A walk cut short records ranges that may miss a value: the next restart walks again.
    if (from < upto) S.knownWhole = false;
  }

  function learnKnown(C, known) {
    for (const k of Array.isArray(known) ? known : []) {
      if (!isPlain(k) || typeof k.value !== 'string' || !k.value) continue;
      try { if (typeof engine.redactor.addKnown === 'function') engine.redactor.addKnown(k.value, k.label); } catch (e) { fail('addKnown', e); }
      if (k.label === 'org-id') C.orgUuid = k.value;
    }
  }

  function nameOf(cid) {
    const v = engine.conversations.get(cid);
    return v && typeof v.name === 'string' ? v.name : undefined;
  }

  // ── the tailer's callbacks ──
  function onRecords(S, t, recs) {
    if (!running || S.closed || !Array.isArray(recs) || !recs.length) return undefined;
    try { ingestRecords(S, t, recs); } catch (e) { fail('batch', e); }
    return S.catchingUp ? yieldTurn() : undefined;
  }

  function onReset(S, info) {
    if (!running || S.closed || !isPlain(info)) return;
    if (info.anchored !== false) return;
    // Re-read from 0: the folds start over (the ids they make are the same).
    S.norm = initialState();
    S.carriers = initialCarriers();
    S.starts = [];
    S.boundary = null;
    S.lastResume = null;
    S.fork = 'unknown';
    S.forkFrom = null;
    resetKnown(S);
    if (!S.catchingUp) {
      try { engine.reset({ reason: typeof info.reason === 'string' ? info.reason : 'catch-up', conversation_id: S.cid }); } catch (e) { fail('reset', e); }
    }
  }

  function onTailError(S, e) {
    if (e && e.code === 'WC_TAIL_REFUSED') { S.refused = true; noteDiag(S); return; }
    fail('tail', e);
  }

  // One batch, through the pipeline (see THE PIPELINE).
  function ingestRecords(S, t, recs) {
    const cid = S.cid;
    const C = conv(cid);
    const sessionName = nameOf(cid);
    const changes = [];
    const delivered = [];
    const known = [];
    let metaPatch = null;
    let title = null;
    let newest = null;
    let prevResume = S.lastResume;
    for (let i = 0; i < recs.length;) {
      let j = i + 1;
      while (j < recs.length && !isOpenerRec(recs[j])) j++;
      const piece = recs.slice(i, j);
      if (isOpenerRec(piece[0])) {
        if (i > 0) prevResume = t.resumeAt(recs[i - 1]);
        noteBoundary(S, C, piece[0], prevResume);
      }
      const seqBefore = S.norm.seq;
      const n = normalize(piece, S.norm, { session_id: S.sid });
      S.norm = n.state;
      noteNormDiag(S, n.diag);
      const m = foldMeta(C.meta, piece, { sessionName });
      C.meta = m.state;
      if (m.patch) metaPatch = { ...(metaPatch || {}), ...m.patch };
      if (m.title) title = m.title;
      for (const k of m.known || []) known.push(k);
      const c = foldCarriers(S.carriers, piece);
      S.carriers = c.state;
      for (const d of c.delivered || []) delivered.push(d);
      for (const ch of mergeChanges(n.changes, c.changes, piece, seqBefore)) changes.push(ch);
      for (const r of piece) {
        const ts = r && isPlain(r.obj) && typeof r.obj.timestamp === 'string' ? Date.parse(r.obj.timestamp) : NaN;
        if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
      }
      i = j;
    }
    S.lastResume = t.resumeAt(recs[recs.length - 1]) || S.lastResume;

    // 1. Known values first: nothing of this batch is stored unmasked. The line
    //    that first carried each is noted for the next restart.
    learnKnown(C, known);
    for (const r of recs) if (isKnownRec(r)) noteKnownRec(S, r);
    // 3. A fork's copies are dropped, and the delivery markers announced.
    const { kept, dropped } = forkFilter(S, changes);
    for (const d of delivered) {
      if (!isPlain(d) || (dropped && isPlain(d.offset) && dropped.has(d.offset.start))) continue;
      try { engine.transition({ kind: 'mirror', op: 'delivered', conversation_id: cid, via: d.via, marker: d.marker }); } catch (e) { fail('delivered', e); }
    }
    // 4. The turn machine.
    if (kept.length) {
      engine.applyChanges(S.sid, kept, { conversation_id: cid });
      noteItemTurns(kept);
    }
    // 5. The meta.
    if (metaPatch) { try { engine.model.upsertConversation(cid, metaPatch); } catch (e) { fail('meta', e); } }
    if (title) { try { engine.conversations.noteTitle(cid, title); } catch (e) { fail('noteTitle', e); } }
    // 6. Progress.
    try { engine.live.noteActivity(cid, newest === null ? engine.now() : newest, 'transcript'); } catch (e) { fail('activity', e); }
    // 7. Diagnostics.
    noteDiag(S);
  }

  // The states just before an opener: the open turn's resume point, and the
  // normalizer state an LRU refill of that turn starts from.
  function noteBoundary(S, C, rec, resume) {
    const norm = trimmedNorm(S.norm, rec);
    S.boundary = { offset: rec.start, resume, norm, carriers: S.carriers, meta: C.meta, fork: S.fork, fork_from: S.forkFrom };
    if (!finite(rec.start)) return;
    // A re-read from an earlier offset replaces what lay beyond it.
    while (S.starts.length && S.starts[S.starts.length - 1][0] >= rec.start) S.starts.pop();
    S.starts.push([rec.start, norm]);
    if (S.starts.length > STARTS_MAX) S.starts.splice(0, S.starts.length - STARTS_MAX);
  }

  // A fork's copied turns (see FORKS).
  function copiedFrom(cid, ch) {
    const ids = [str(ch.prompt_id), str(ch.uuid) ? `u_${ch.uuid}` : null];
    for (const id of ids) {
      if (!id) continue;
      const r = engine.model.resolveTurn(id);
      const t = r ? engine.model.turn(r) : null;
      if (t && t.conversation_id !== cid) return t.conversation_id;
    }
    const byUuid = str(ch.uuid) ? engine.model.turnOfUuid(ch.uuid) : null;
    const t = byUuid ? engine.model.turn(byUuid) : null;
    return t && t.conversation_id !== cid ? t.conversation_id : null;
  }

  function forkFilter(S, changes) {
    if (S.fork === 'own') return { kept: changes, dropped: null };
    const kept = [];
    const dropped = new Set();
    for (const ch of changes) {
      if (S.fork !== 'own' && isPlain(ch) && ch.type === 'opener') {
        const other = copiedFrom(S.cid, ch);
        if (other) {
          if (S.fork !== 'copy') {
            S.fork = 'copy';
            S.forkFrom = other;
            try { engine.conversations.markFork(S.cid, { forked_from: other }); } catch (e) { fail('markFork', e); }
          }
        } else S.fork = 'own';
      }
      if (S.fork === 'copy') {
        const s = startOf(ch);
        if (s !== null) dropped.add(s);
        continue;
      }
      kept.push(ch);
    }
    return { kept, dropped };
  }

  function noteItemTurns(changes) {
    for (const ch of changes) {
      if (!isPlain(ch) || ch.type !== 'item' || !isPlain(ch.item) || typeof ch.item.id !== 'string') continue;
      const it = engine.model.item(ch.item.id);
      if (!it) continue;
      itemTurns.delete(it.id);
      itemTurns.set(it.id, it.turn_id);
      if (itemTurns.size > ITEM_TURNS_MAX) itemTurns.delete(itemTurns.keys().next().value);
    }
  }

  // ── diagnostics ──
  function noteNormDiag(S, d) {
    if (!isPlain(d)) return;
    if (isPlain(d.unknown_kinds)) {
      for (const k of Object.keys(d.unknown_kinds)) {
        const n = d.unknown_kinds[k];
        if (!finite(n)) continue;
        bump(S.diag.unknown_kinds, k, n);
        bump(diagTotals.unknown_kinds, k, n);
      }
    }
    if (finite(d.bad_lines)) { S.diag.bad_lines += d.bad_lines; diagTotals.bad_lines += d.bad_lines; }
    if (finite(d.oversize_lines)) S.diag.oversize_lines += d.oversize_lines;
    if (isPlain(d.versions_seen)) {
      for (const v of Object.keys(d.versions_seen)) {
        if (!versionsSeen.has(v) && versionsSeen.size >= KINDS_MAX) continue;
        versionsSeen.set(v, (versionsSeen.get(v) || 0) + (finite(d.versions_seen[v]) ? d.versions_seen[v] : 1));
      }
    }
  }

  function transcriptStatus(S) {
    if (!S) return 'absent';
    if (S.refused || (!S.file && S.loaded)) return 'absent';
    if (S.tailer && S.tailer.stats && S.tailer.stats.waiting) return 'waiting';
    return S.file ? 'ok' : 'waiting';
  }

  function noteDiag(S) {
    if (!running || !S || S.closed) return;
    const cid = S.cid;
    const C = conv(cid);
    const out = { unknown_kinds: {}, bad_lines: 0, oversize_lines: 0, transcript: 'absent' };
    let current = null;
    for (const x of sessions.values()) {
      if (x.cid !== cid) continue;
      for (const k of Object.keys(x.diag.unknown_kinds)) bump(out.unknown_kinds, k, x.diag.unknown_kinds[k]);
      out.bad_lines += x.diag.bad_lines;
      out.oversize_lines += x.diag.oversize_lines;
      if (isCurrent(x)) current = x;
    }
    out.transcript = transcriptStatus(current || S);
    const key = JSON.stringify(out);
    if (key === C.diagKey) return;
    C.diagKey = key;
    try { engine.model.upsertConversation(cid, { diagnostics: out }); } catch (e) { fail('diagnostics', e); }
  }

  function diagnostics() {
    const versions = [...versionsSeen.keys()];
    let skew = null;
    if (versions.length) {
      skew = versions.some((v) => {
        try { return compareVersions(v, TESTED.min) < 0 || compareVersions(v, TESTED.max) > 0; } catch { return false; }
      });
    }
    return {
      versions_seen: versions,
      tested: { min: TESTED.min, max: TESTED.max },
      skew,
      unknown_kinds: { ...diagTotals.unknown_kinds },
      bad_lines: diagTotals.bad_lines,
    };
  }

  // ── resume points and the snapshot (see RESUME, THE STORE CONTRACT) ──
  function resumePoint(S) {
    const C = conv(S.cid);
    let open = false;
    try {
      const tid = engine.model.sessionTurn(S.sid);
      const t = tid ? engine.model.turn(tid) : null;
      open = Boolean(t && t.status === 'open');
    } catch { open = false; }
    if (open && S.boundary) {
      const b = S.boundary;
      return { resume: b.resume, norm: b.norm, carriers: b.carriers, meta: b.meta, fork: b.fork, fork_from: b.fork_from, offset: b.offset };
    }
    return { resume: S.lastResume, norm: S.norm, carriers: S.carriers, meta: C.meta, fork: S.fork, fork_from: S.forkFrom, offset: null };
  }

  function persistState(sessionId) {
    const S = sessions.get(sessionId);
    if (!S || S.closed) return undefined;
    const p = resumePoint(S);
    const starts = p.offset === null ? S.starts : S.starts.filter(([o]) => o < p.offset);
    const out = { v: SLICE_VERSION, norm: p.norm, carriers: p.carriers, fork: p.fork, fork_from: p.fork_from, starts };
    // Ranges that may miss a value are not handed on: without `known` the next
    // restart walks the prefix instead.
    if (S.knownWhole) out.known = S.known.map(([s, e]) => [s, e]);
    return out;
  }

  // A slice of SLICE_VERSION, or of 1 (before the known ranges: its states are
  // kept, and recoverKnown walks the prefix once).
  function restoreState(sessionId, value) {
    const S = sessions.get(sessionId);
    if (!S || !isPlain(value) || (value.v !== SLICE_VERSION && value.v !== 1)) return;
    if (isPlain(value.norm)) S.norm = value.norm;
    if (isPlain(value.carriers)) S.carriers = value.carriers;
    if (value.fork === 'copy' || value.fork === 'own' || value.fork === 'unknown') S.fork = value.fork;
    S.forkFrom = str(value.fork_from);
    if (Array.isArray(value.starts)) {
      const out = [];
      for (const e of value.starts) {
        if (!Array.isArray(e) || !Number.isSafeInteger(e[0]) || e[0] < 0 || !isPlain(e[1])) continue;
        if (out.length && out[out.length - 1][0] >= e[0]) continue;
        out.push([e[0], e[1]]);
      }
      S.starts = out.slice(-STARTS_MAX);
    }
    if (value.v === SLICE_VERSION && Array.isArray(value.known)) {
      const out = [];
      for (const e of value.known) {
        if (!Array.isArray(e) || !Number.isSafeInteger(e[0]) || !Number.isSafeInteger(e[1]) || e[0] < 0 || e[1] <= e[0]) continue;
        if (out.some(([s]) => s === e[0])) continue;
        out.push([e[0], e[1]]);
      }
      S.known = out.slice(-KNOWN_RANGES_MAX);
      S.knownSeen = new Set();
      S.knownWhole = true;
    }
  }

  function snapshot(S) {
    const p = resumePoint(S);
    const meta = isPlain(p.meta) ? p.meta : initialMeta();
    const { skills, ...rest } = meta;
    const r = isPlain(p.resume) ? p.resume : null;
    let turns = [];
    try {
      turns = engine.model.exportTurns(S.sid)
        .filter((e) => isPlain(e) && isPlain(e.header) && typeof e.header.id === 'string')
        .map((e) => ({ id: e.header.id, header: e.header, internal: e.internal }));
    } catch (e) { fail('exportTurns', e); }
    let sources = {};
    try { sources = engine.sourceStates(S.sid); } catch (e) { fail('sourceStates', e); }
    let size = r ? r.offset : 0;
    if (r && S.tailer && S.tailer.stats && finite(S.tailer.stats.offset) && S.tailer.stats.offset >= r.offset) size = S.tailer.stats.offset;
    return {
      v: STATE_VERSION,
      session_id: S.sid,
      conversation_id: S.cid,
      slug: S.slug,
      file: r ? { dev: r.dev, ino: r.ino, size, head_len: r.headLen, head_hash: r.headHash } : null,
      resume: r,
      turns,
      state: {
        meta: rest,
        skills: isPlain(skills) ? { names: [...(skills.names || [])], descriptions: { ...(skills.descriptions || {}) } } : { names: [], descriptions: {} },
        sources,
      },
    };
  }

  // ── the LRU's refill (see THE LRU) ──
  function startBefore(S, from) {
    if (S) {
      for (let i = S.starts.length - 1; i >= 0; i--) {
        if (S.starts[i][0] <= from) return { offset: S.starts[i][0], norm: S.starts[i][1] };
      }
    }
    return { offset: 0, norm: initialState() };
  }

  function fileOfSession(sid) {
    const S = sessions.get(sid);
    if (S && S.file) return S.file;
    return engine.conversations.transcriptPath(sid);
  }

  async function refillTurn(tid) {
    const t = engine.model.turn(tid);
    const seg = engine.model.segmentOf(tid);
    if (!t || !isPlain(seg) || !finite(seg.from) || !finite(seg.to) || seg.to <= seg.from) return false;
    const file = fileOfSession(t.session_id);
    if (!file) return false;
    const base = startBefore(sessions.get(t.session_id), seg.from);
    const text = await callStore('readRange', file, { from: base.offset, to: seg.to });
    if (typeof text !== 'string') return false;
    const recs = parseLines(text, base.offset);
    const n = normalize(recs, base.norm, { session_id: t.session_id });
    const inSegment = recs.filter((r) => r.start >= seg.from);
    const c = foldCarriers(initialCarriers(), inSegment); // its `delivered` is ignored: a refill announces nothing
    const nch = n.changes.filter((ch) => { const s = startOf(ch); return s === null || s >= seg.from; });
    const changes = mergeChanges(nch, c.changes, recs, finite(base.norm.seq) ? base.norm.seq : 0);
    if (!engine.model.isEvicted(tid)) return true;
    const ok = engine.model.refill(tid, changes);
    if (ok) noteItemTurns(changes.map((ch) => (ch.type === 'item' ? ch : null)).filter(Boolean));
    return Boolean(ok);
  }

  function ensureItems(turnId) {
    const tid = engine.model.resolveTurn(turnId);
    if (!tid || !engine.model.turn(tid) || !engine.model.isEvicted(tid)) return Promise.resolve(true);
    if (refills.has(tid)) return refills.get(tid);
    const p = refillTurn(tid).catch((e) => { fail('refill', e); return false; }).finally(() => refills.delete(tid));
    refills.set(tid, p);
    return p;
  }

  async function findItem(id) {
    if (typeof id !== 'string' || !id) return null;
    const it = engine.model.item(id);
    if (it) return it;
    let tid = itemTurns.get(id) || null;
    if (!tid) {
      const prefix = TURN_ITEM_PREFIXES.find((p) => id.startsWith(p));
      if (prefix) tid = id.slice(prefix.length);
    }
    if (!tid) return null;
    await ensureItems(tid);
    return engine.model.item(id);
  }

  // ── the read API ──
  async function turns(cid, q = {}) {
    const id = convIdOf(cid);
    if (!id) return null;
    const o = isPlain(q) ? q : {};
    const level = o.items === 'summary' || o.items === 'full' ? o.items : 'none';
    const lim = Number.isSafeInteger(o.limit) ? Math.max(1, Math.min(TURNS_LIMIT_MAX, o.limit)) : TURNS_LIMIT;
    const page = engine.model.turnPage(id, { before: finite(o.before) ? o.before : undefined, limit: lim });
    const list = page.turns.map((t) => ({ ...t }));
    if (level !== 'none') {
      for (const t of list) {
        await ensureItems(t.id);
        const items = engine.model.itemsOf(t.id);
        if (items) t.items = items.map((it) => engine.model.serializeItem(it, { level })).filter(Boolean);
        else t.items_unavailable = true;
      }
    }
    return { conversation_id: id, turns: list, next_before: page.next_before, total: page.total };
  }

  async function turn(id) {
    const tid = typeof id === 'string' ? engine.model.resolveTurn(id) : null;
    if (!tid || !engine.model.turn(tid)) return null;
    await ensureItems(tid);
    const header = engine.model.serializeTurn(tid);
    if (!header) return null;
    const items = engine.model.itemsOf(tid);
    const out = { turn: header, items: items ? items.map((it) => engine.model.serializeItem(it, { level: 'full' })).filter(Boolean) : [] };
    if (!items) out.items_unavailable = true;
    return out;
  }

  function contextOf(it) {
    const ctx = {};
    let file = null;
    try { file = fileOf(it.tool, it.input); } catch { file = null; }
    if (file) ctx.file = file;
    if (isPlain(it.input) && typeof it.input.command === 'string') ctx.command = it.input.command;
    return Object.keys(ctx).length ? ctx : undefined;
  }

  function fieldText(it, field) {
    if (field === 'text') {
      for (const k of ['text', 'summary', 'output']) if (typeof it[k] === 'string') return it[k];
      return null;
    }
    if (field === 'input') {
      if (typeof it.input === 'string') return it.input;
      if (it.input !== undefined && it.input !== null) { try { return JSON.stringify(it.input, null, 2); } catch { return null; } }
      return null;
    }
    if (isPlain(it.result) && typeof it.result.preview === 'string') return it.result.preview;
    if (typeof it.result_preview === 'string') return it.result_preview;
    if (typeof it.output === 'string') return it.output;
    return null;
  }

  async function itemField(id, q = {}) {
    const o = isPlain(q) ? q : {};
    const field = o.field;
    if (field !== 'text' && field !== 'input' && field !== 'result') return null;
    const from = Number.isSafeInteger(o.from) && o.from > 0 ? o.from : 0;
    const max = Number.isSafeInteger(o.max) && o.max > 0 ? Math.min(FIELD_MAX, o.max) : FIELD_MAX;
    const it = await findItem(id);
    if (!it) return null;
    if (field === 'result' && isPlain(it.result) && typeof it.result._persisted === 'string') {
      const t = engine.model.turn(it.turn_id);
      const dir = t ? engine.conversations.sessionDir(t.session_id) : null;
      const file = dir ? engine.files.sessionDirFile(dir, it.result._persisted) : null;
      let w = null;
      if (file) { try { w = engine.files.readWindow(file, { from, maxBytes: max }); } catch { w = null; } }
      if (w) {
        const text = engine.redactor.window(w.text, { startsMidFile: w.startsMidFile, complete: w.complete, context: contextOf(it) });
        return { id: it.id, field, text: typeof text === 'string' ? text : '', from: w.from, to: w.next, total: w.size, eof: w.complete };
      }
    }
    const text = fieldText(it, field);
    if (text === null) return null;
    const at = Math.min(from, text.length);
    const slice = text.slice(at, at + max);
    const to = at + slice.length;
    return { id: it.id, field, text: slice, from: at, to, total: text.length, eof: to >= text.length };
  }

  // The image and document blocks of the record that holds item `it`'s
  // attachments, in the order the normalizer numbered them.
  function blocksFor(it, recs) {
    const blocks = (c) => (Array.isArray(c) ? c.filter((b) => isPlain(b) && (b.type === 'image' || b.type === 'document')) : []);
    for (const r of recs) {
      const obj = r.obj;
      if (!obj || !isPlain(obj.message) || !Array.isArray(obj.message.content)) continue;
      if (it.kind === 'prompt') {
        const kind = kindOf(obj);
        if (kind === 'user/prompt' || kind === 'user/prompt+image') return blocks(obj.message.content);
        continue;
      }
      for (const b of obj.message.content) {
        if (isPlain(b) && b.type === 'tool_result' && b.tool_use_id === it.id) return blocks(b.content);
      }
    }
    return [];
  }

  async function attachment(id, n) {
    const num = Number(n);
    if (!Number.isSafeInteger(num) || num < 1) return null;
    const it = await findItem(id);
    if (!it) return null;
    const list = it.kind === 'prompt' ? it.attachments : isPlain(it.result) ? it.result.attachments : null;
    const meta = Array.isArray(list) ? list.find((a) => isPlain(a) && a.n === num) : null;
    if (!meta) return null;
    const t = engine.model.turn(it.turn_id);
    const seg = t ? engine.model.segmentOf(t.id) : null;
    const file = t ? fileOfSession(t.session_id) : null;
    if (!isPlain(seg) || !file) return null;
    const text = await callStore('readRange', file, { from: seg.from, to: seg.to });
    if (typeof text !== 'string') return null;
    const block = blocksFor(it, parseLines(text, seg.from))[num - 1];
    const src = block && isPlain(block.source) ? block.source : null;
    if (!src || typeof src.data !== 'string') return null;
    const media = src.media_type;
    if (typeof media !== 'string' || !Object.hasOwn(MAGIC, media)) return null;
    if (typeof meta.media_type === 'string' && meta.media_type !== media) return null;
    // Over the limit: refused before a byte of it is decoded.
    if (decodedLength(src.data) > ATTACHMENT_MAX_BYTES) return null;
    const bytes = Buffer.from(src.data, 'base64');
    if (!bytes.length || bytes.length > ATTACHMENT_MAX_BYTES || !MAGIC[media](bytes)) return null;
    const out = { media_type: media, bytes };
    if (typeof meta.name === 'string' && meta.name) out.name = meta.name;
    return out;
  }

  function skillFold(cid) {
    const id = convIdOf(cid) || (typeof cid === 'string' ? cid : null);
    const C = id ? convs.get(id) : null;
    const skills = C && isPlain(C.meta) && isPlain(C.meta.skills) ? C.meta.skills : { names: [], descriptions: {} };
    return {
      names: Array.isArray(skills.names) ? [...skills.names] : [],
      descriptions: isPlain(skills.descriptions) ? { ...skills.descriptions } : {},
      orgUuid: C ? C.orgUuid : null,
    };
  }

  async function forkAnchor(turnId) {
    const tid = typeof turnId === 'string' ? engine.model.resolveTurn(turnId) : null;
    const t = tid ? engine.model.turn(tid) : null;
    if (!t || !t.session_id) return { refused: 'unknown' };
    if (t.superseded) return { refused: 'superseded' };
    const first = engine.model.turnsOf(t.conversation_id, { session_id: t.session_id }).find((x) => !x.superseded);
    if (first && first.id === tid) return { refused: 'first' };
    let entry = null;
    try { entry = engine.model.exportTurns(t.session_id).find((e) => isPlain(e) && isPlain(e.header) && e.header.id === tid) || null; } catch { entry = null; }
    const internal = entry && isPlain(entry.internal) ? entry.internal : null;
    if (!internal || !internal.opener_uuid || !internal.parent_known) return { refused: 'unknown' };
    if (!internal.parent_uuid) return { refused: 'first' };
    return { session_id: t.session_id, parent_uuid: internal.parent_uuid };
  }

  // ── the hooks ──
  function onIngest(env, info = {}) {
    if (!running || !isPlain(env)) return;
    const cid = isPlain(info) && typeof info.conversation_id === 'string' ? info.conversation_id : null;
    const sid = isPlain(info) && typeof info.session_id === 'string' ? info.session_id : env.session_id;
    if (cid) {
      const C = conv(cid);
      const f = foldEnvelope(C.meta, env);
      C.meta = f.state;
      if (f.patch) { try { engine.model.upsertConversation(cid, f.patch); } catch (e) { fail('meta', e); } }
    }
    if (env.event === 'SessionStart' && cid) reconcile(cid);
    else if (env.event === 'SessionEnd' && typeof sid === 'string') {
      const S = sessions.get(sid);
      if (!S) return;
      enqueue(async () => {
        const tl = S.tailer;
        if (!tl || S.closed) return;
        await tl.drain();
        if (S.tailer === tl && !isCurrent(S)) {
          S.mode = 'once';
          S.tailer = null;
          S.done = true;
          await tl.stop();
          scheduleSave(S);
        }
      });
    }
  }

  function onConversation(ev) {
    if (!isPlain(ev) || !isPlain(ev.conversation) || typeof ev.conversation.id !== 'string') return;
    const cid = ev.conversation.id;
    switch (ev.change) {
      case 'merged':
      case 'removed':
        forgetConversation(cid);
        return;
      case 'linked': {
        if (!running) return;
        const prev = typeof ev.previous_session_id === 'string' ? sessions.get(ev.previous_session_id) : null;
        // The old file to its end before the new one is followed (U10's hand-off 2).
        if (prev && prev.tailer) {
          enqueue(async () => {
            const tl = prev.tailer;
            if (tl && !prev.closed) await tl.drain();
          });
        }
        reconcile(cid);
        return;
      }
      default:
        reconcile(cid);
    }
  }

  function onTurnClosed(t) {
    if (!running || !isPlain(t) || typeof t.session_id !== 'string') return;
    scheduleSave(sessions.get(t.session_id));
  }

  // ── lifecycle ──
  async function start() {
    if (running) return;
    running = true;
    gen += 1;
    chain = Promise.resolve();
    ensureStore();
    for (const v of engine.conversations.list()) reconcile(v.id);
  }

  async function stop() {
    if (!running) return;
    running = false;
    gen += 1;
    const all = [...sessions.values()];
    const work = (async () => {
      for (const S of all) stopTailer(S);
      if (store) {
        for (const S of all) if (S.file && !S.closed) { try { store.schedule(S.sid, () => snapshot(S)); } catch (e) { fail('store.schedule', e); } }
        try { await store.flush(); } catch (e) { fail('store.flush', e); }
      }
      await Promise.all([...pendingStops]);
      await chain.catch(() => {});
      if (store) { try { await store.stop(); } catch (e) { fail('store.stop', e); } }
    })();
    let timer = null;
    const budget = new Promise((resolve) => { timer = engine.timers.setTimeout(resolve, STOP_BUDGET_MS); });
    await Promise.race([work, budget]);
    if (timer !== null) engine.timers.clearTimeout(timer);
    for (const S of all) S.closed = true;
    sessions.clear();
    convs.clear();
    itemTurns.clear();
    store = null;
  }

  return {
    start,
    stop,
    onIngest,
    onConversation,
    onTurnClosed,
    persistState,
    restoreState,
    diagnostics,
    api: { turns, turn, itemField, attachment, skillFold, forkAnchor },
  };
}

module.exports = {
  createTranscriptsSource,
  parseLines,
  mergeChanges,
  STATE_VERSION,
  SLICE_VERSION,
  KNOWN_RANGES_MAX,
  POLL_MS,
  FIELD_MAX,
  ATTACHMENT_MAX_BYTES,
  STARTS_MAX,
  STOP_BUDGET_MS,
};

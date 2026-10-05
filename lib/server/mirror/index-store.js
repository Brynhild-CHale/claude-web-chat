// lib/server/mirror/index-store.js — the per-session turn index (spec §2.11,
// §2.3 Resume): what lets a restart resume a transcript instead of re-reading it.
//
//   createIndexStore({ paths, timers, now, log, files, redactor }) → store
//
// It implements THE STORE CONTRACT in lib/server/mirror/transcripts.js's header
// exactly (that header is the contract; this file only says how). The facade's
// integration (U40) hands it to createTranscriptsSource as `createStore`, and the
// source calls it with the engine's own pieces: `paths` is projectPaths(root)
// (lib/core/paths), `timers` the engine's (mirror.stop() clears them), `files`
// lib/core/claude-files, `redactor` ctx.redactor.
//
// THE FILE. paths.mirrorIndex(sessionId): `.web-chat/mirror/index/<sid>.json`,
// null for an id that is not safe as a file name — such a session is then never
// written, and loads as 'absent'. Its shape (§2.11):
//
//   { v: 1, session_id, conversation_id, slug,
//     file:   { dev, ino, size, head_len, head_hash } | null,
//     resume: the tailer's resume point | null        (both null: read from 0),
//     turns:  [{ id, header, internal }]              (at most TURNS_MAX, newest kept),
//     state:  { meta, skills: { names, descriptions }, sources },
//     saved_at }
//
// Every turns[] entry keeps a top-level `id`: lib/server/mirror/conversations.js
// deletePruned reads turns[].id to delete a pruned conversation's diff files.
// Deleting index files is the registry's, never this file's.
//
// NEVER A KNOWN VALUE (§2.11, §5.5). The record passes redactor.value whole
// before it is written, so a known value (the organisation id, the account
// email, anything registered with addKnown) and every secret rule's match are
// masked in every field — the meta fold's free text above all (title, ai_title,
// agent_name, first_prompt, away.text), which the source hands over RAW (ruled
// U27@meta.js:18-raw-text-in-persisted-state): the store masks it, the fold stays
// pure. The snapshot is copied first, so the caller's in-memory state is never
// touched. Headers and source slices are redacted already; redaction is
// idempotent.
//
// WRITE. schedule(sid, snapshotFn) arms one DEBOUNCE_MS timer per session on the
// injected timers; schedules inside it only replace the snapshotFn, so a burst of
// turn closes costs one write per DEBOUNCE_MS. The write calls snapshotFn() (null:
// nothing is written), bounds the turns, stamps saved_at, redacts, and writes
// through lib/core/fsjson writeJsonAtomic (same-directory temp file + rename: a
// crash never leaves a torn index). flush(sid?) writes what is pending now; drop
// forgets it; stop() flushes everything inside STOP_BUDGET_MS (under the graceful
// shutdown's 2 s ceiling on a mirror source, lib/server/index.js
// MIRROR_STOP_TIMEOUT_MS) and then cancels every timer. A stopped store writes
// nothing more.
//
// READ. load(sid, {file}) reads with fsjson readJson. A file that does not parse
// ('corrupt') or does not have the shape above ('invalid') is renamed aside
// (fsjson renameAside) and answered {ok: false, reason}: the caller re-reads the
// transcript from 0. Every field is checked again — the file sits in a project
// directory anyone can edit. Then the boot verification against `file` (the
// session's fenced transcript): the same dev and ino, a size of at least
// resume.offset, and its first head_len bytes hashing to head_hash, else
// {ok: false, reason: 'stale'} (the tailer re-checks the resume itself at open).
// conversation_id is never checked: a merged session is restored into its new
// conversation.
//
// readRange(file, {from, to}) answers the whole lines of bytes [from, to) as text
// by paging lib/core/claude-files readWindow({from, maxBytes}) and following its
// `next` — never a second raw reader. A line longer than WINDOW_MAX_BYTES (8 MiB)
// cannot be read whole and answers null (the caller leaves that turn's items, or
// that attachment, unavailable); so does a file gone or shorter than the range.
// That rule is why an attachment is served only up to
// transcripts.js ATTACHMENT_MAX_BYTES (6 MiB − 48 KiB, ruled U28b@attachment-limit).
//
// No migration (§2.11: everything here is derivable from the transcripts).
//
// Dependency direction: lib/server; imports lib/core only.

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const fsjson = require('../../core/fsjson');
const claudeFiles = require('../../core/claude-files');

// ── constants ────────────────────────────────────────────────────────────────

const INDEX_VERSION = 1;
// Writes per session are at most one per this (§2.11: "debounced 2 s").
const DEBOUNCE_MS = 2000;
// The index keeps the newest this many turns of a session (§2.11; ruled
// U28b@turn-bound: the resume point is unaffected).
const TURNS_MAX = 5000;
// stop()'s own budget, under the graceful shutdown's 2 s per mirror source.
const STOP_BUDGET_MS = 1000;
// The tailer hashes at most this much of a transcript's head (tail.js HEAD_BYTES).
const HEAD_MAX = 256;
const HASH_RE = /^[0-9a-f]{64}$/;

// ── shape checks ─────────────────────────────────────────────────────────────

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const text = (v) => typeof v === 'string' && v.length > 0;
const orNull = (v, check) => v === null || check(v);

function fileOk(f) {
  return isPlain(f)
    && count(f.dev) && count(f.ino) && count(f.size)
    && count(f.head_len) && f.head_len <= HEAD_MAX
    && (f.head_len === 0 ? orNull(f.head_hash ?? null, (h) => HASH_RE.test(h)) : typeof f.head_hash === 'string' && HASH_RE.test(f.head_hash));
}

// The tailer's resume point (tail.js resumeAt): it re-checks every field at
// open, so here only what the boot verification reads must hold.
function resumeOk(r) {
  return isPlain(r) && count(r.offset);
}

function turnOk(e) {
  return isPlain(e) && text(e.id) && isPlain(e.header) && e.header.id === e.id
    && (e.internal === undefined || e.internal === null || isPlain(e.internal));
}

function stateOk(s) {
  if (!isPlain(s) || !isPlain(s.meta) || !isPlain(s.sources)) return false;
  const k = s.skills;
  return isPlain(k) && Array.isArray(k.names) && k.names.every((n) => typeof n === 'string') && isPlain(k.descriptions);
}

// The whole record, as §2.11 shapes it, for session `sid`.
function indexOk(v, sid) {
  return isPlain(v)
    && v.v === INDEX_VERSION
    && v.session_id === sid
    && text(v.conversation_id)
    && orNull(v.slug, (s) => typeof s === 'string')
    && orNull(v.file, fileOk)
    && orNull(v.resume, resumeOk)
    && (v.file === null) === (v.resume === null)
    && Array.isArray(v.turns) && v.turns.length <= TURNS_MAX && v.turns.every(turnOk)
    && stateOk(v.state)
    && Number.isFinite(v.saved_at);
}

// ── the store ────────────────────────────────────────────────────────────────

function createIndexStore({ paths, timers, now = Date.now, log = () => {}, files = claudeFiles, redactor } = {}) {
  if (!paths || typeof paths.mirrorIndex !== 'function') {
    throw new TypeError('createIndexStore: paths is projectPaths(root) (lib/core/paths), with mirrorIndex(sessionId)');
  }
  if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new TypeError('createIndexStore: timers must provide setTimeout and clearTimeout (the engine\'s)');
  }
  if (!redactor || typeof redactor.value !== 'function') {
    throw new TypeError('createIndexStore: a redactor with value() is required (ctx.redactor) — no index file holds a known value');
  }
  if (!files || typeof files.readWindow !== 'function') {
    throw new TypeError('createIndexStore: files is lib/core/claude-files (readWindow)');
  }
  const windowMax = Number.isSafeInteger(files.WINDOW_MAX_BYTES) ? files.WINDOW_MAX_BYTES : claudeFiles.WINDOW_MAX_BYTES;

  const pending = new Map(); // session id → { fn, timer }
  let stopped = false;

  function say(msg) { try { log(msg); } catch { /* a logger never breaks the store */ } }
  function fail(stage, e) {
    const word = [e && e.code, e && e.name].find((w) => typeof w === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(w)) || 'Error';
    say(`mirror index: ${stage} failed (${word})`);
  }

  // ── writing ──
  function record(sid, snap) {
    if (!isPlain(snap) || snap.session_id !== sid) return null;
    // A copy: nothing below may touch the caller's state (the meta fold's above all).
    const copy = JSON.parse(JSON.stringify(snap));
    if (Array.isArray(copy.turns) && copy.turns.length > TURNS_MAX) copy.turns = copy.turns.slice(-TURNS_MAX);
    copy.v = INDEX_VERSION;
    copy.saved_at = now();
    // The whole record through the redactor: no known value, no secret, in any field.
    const out = redactor.value(copy);
    return isPlain(out) ? out : null;
  }

  function write(sid, fn) {
    const file = paths.mirrorIndex(sid);
    if (!file) return; // an unsafe id is never written
    let snap = null;
    try { snap = fn(); } catch (e) { fail('snapshot', e); return; }
    if (snap === null || snap === undefined) return;
    let rec = null;
    try { rec = record(sid, snap); } catch (e) { fail('redact', e); return; }
    if (!rec) { say('mirror index: a snapshot not for its session was not written'); return; }
    try { fsjson.writeJsonAtomic(file, rec, { pretty: 0 }); } catch (e) { fail('write', e); }
  }

  function take(sid) {
    const p = pending.get(sid);
    if (!p) return null;
    pending.delete(sid);
    if (p.timer !== null) { try { timers.clearTimeout(p.timer); } catch { /* gone with the engine's */ } }
    return p.fn;
  }

  function schedule(sessionId, snapshotFn) {
    if (stopped || typeof sessionId !== 'string' || !sessionId || typeof snapshotFn !== 'function') return;
    const p = pending.get(sessionId);
    if (p) { p.fn = snapshotFn; return; }
    const entry = { fn: snapshotFn, timer: null };
    pending.set(sessionId, entry);
    entry.timer = timers.setTimeout(() => {
      if (pending.get(sessionId) !== entry) return;
      entry.timer = null;
      const fn = take(sessionId);
      if (fn && !stopped) write(sessionId, fn);
    }, DEBOUNCE_MS);
  }

  async function flush(sessionId) {
    if (stopped) return;
    const ids = typeof sessionId === 'string' ? [sessionId] : [...pending.keys()];
    for (const sid of ids) {
      const fn = take(sid);
      if (fn) write(sid, fn);
    }
  }

  function drop(sessionId) { take(sessionId); }

  async function stop() {
    if (stopped) return;
    const t0 = process.hrtime.bigint();
    const elapsed = () => Number((process.hrtime.bigint() - t0) / 1000000n);
    for (const sid of [...pending.keys()]) {
      const fn = take(sid);
      if (!fn) continue;
      if (elapsed() > STOP_BUDGET_MS) { say('mirror index: stop budget spent, a snapshot was left unwritten'); continue; }
      write(sid, fn);
    }
    stopped = true;
    for (const sid of [...pending.keys()]) take(sid);
  }

  // ── reading ──
  // The transcript's first `len` bytes, through readWindow (its text is UTF-8;
  // reading a little past `len` keeps a character cut at `len` whole, so the
  // bytes before it re-encode exactly — a head that is not UTF-8 then simply
  // hashes differently, and the index is stale).
  function headHash(file, len) {
    let w = null;
    try { w = files.readWindow(file, { from: 0, maxBytes: len + 4 }); } catch { w = null; }
    if (!w || w.from !== 0 || w.to < len) return null;
    const bytes = Buffer.from(w.text, 'utf8').subarray(0, len);
    if (bytes.length !== len) return null;
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  function verify(ix, file) {
    if (ix.file === null) return true; // read from 0: nothing to check
    let st = null;
    try { st = fs.lstatSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    if (st.dev !== ix.file.dev || st.ino !== ix.file.ino) return false;
    if (st.size < ix.resume.offset) return false;
    if (ix.file.head_len > 0 && headHash(file, ix.file.head_len) !== ix.file.head_hash) return false;
    return true;
  }

  async function load(sessionId, { file } = {}) {
    const p = typeof sessionId === 'string' && sessionId ? paths.mirrorIndex(sessionId) : null;
    if (!p) return { ok: false, reason: 'absent' };
    const got = fsjson.readJson(p, { validate: (v) => indexOk(v, sessionId) });
    if (got.absent) return { ok: false, reason: 'absent' };
    if (!got.ok) {
      const reason = got.invalid ? 'invalid' : 'corrupt';
      try { fsjson.renameAside(p, { tag: reason, keep: 1, now }); } catch (e) { fail('renameAside', e); }
      return { ok: false, reason };
    }
    if (typeof file !== 'string' || !file || !verify(got.value, file)) return { ok: false, reason: 'stale' };
    return { ok: true, index: got.value };
  }

  async function readRange(file, { from, to } = {}) {
    if (typeof file !== 'string' || !file || !count(from) || !count(to) || to < from) return null;
    const parts = [];
    let pos = from;
    while (pos < to) {
      let w = null;
      try { w = files.readWindow(file, { from: pos, maxBytes: Math.min(windowMax, to - pos) }); } catch { w = null; }
      if (!w || w.from !== pos || !(w.to > pos)) return null; // gone, or shorter than the range
      if (w.to === to) { parts.push(w.text); break; }
      if (w.complete) return null; // the file ends before the range does
      // A full window short of `to`: its whole lines, and on from its `next`.
      const cut = w.text.lastIndexOf('\n');
      if (cut < 0 || !(w.next > pos)) return null; // one line longer than a window: never read whole
      parts.push(w.text.slice(0, cut + 1));
      pos = w.next;
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    return parts.join('');
  }

  return Object.freeze({ load, schedule, flush, drop, readRange, stop });
}

module.exports = {
  createIndexStore,
  indexOk,
  INDEX_VERSION,
  DEBOUNCE_MS,
  TURNS_MAX,
  STOP_BUDGET_MS,
};

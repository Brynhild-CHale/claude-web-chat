// lib/server/mirror/tail.js — the JSONL tailer: follow one append-only file
// (a Claude Code transcript, an agent's transcript, a journal, a task output)
// and hand over each complete line once, in order, with its byte range (spec
// §2.3). Adopted from the validation prototype (design/chat-mirror-validation/
// tailer.js, V1, V15, V17); what changed is listed under "Not the prototype".
//
//   createTailer({ file, resume = null, pollMs = 500, chunkBytes = 256 * 1024,
//                  maxLineBytes = 64 * 1024 * 1024, watchFile, fence = (p) => p,
//                  onRecords(recs, meta), onReset(info), onError(e), log })
//     → { start(), stop(), drain(), resumeAt(rec), stats }
//
//   recs: [{ line, obj, bad, oversize, start, end, anchor: { uuid, after } }]
//     line      the line's text without its newline (null for an oversize line)
//     obj       the parsed JSON object, or null (not JSON, not an object, oversize)
//     bad       true when obj is null
//     oversize  true for a line longer than maxLineBytes: skipped to its newline
//               and handed over as this one record, never held whole
//     start/end the byte range [start, end) the line occupies, its newline
//               included; consecutive records are contiguous unless an empty
//               line (never handed over) lies between them
//     anchor    the last uuid at or before this record (null when none yet) and
//               how many uuid-less lines follow it up to and including this one:
//               how the tailer finds its place again in a rewritten file
//   meta: { src, gen }  the trigger's source (diagnostics only) and the reset
//               generation (bumped by every onReset)
//
// Nothing here knows a record kind, a turn or where the position is kept: that
// is records.js, the turn machine and the transcripts source's index.
//
// THE MODEL. `offset` (stats.offset) is the byte just past the last complete
// line handed over, always a line boundary. Bytes read past it with no newline
// yet sit in a carry buffer and are never handed over before their newline
// arrives. Lines are split on 0x0a bytes. Never a line reader: U+2028 and
// U+2029 split differently there on Node 24 and 26 than on 22 (V15), and a
// transcript holds both inside JSON strings. A line longer than maxLineBytes is
// skipped to its newline (lines reach 3.83 MB at rest, V2; 64 MiB is the cap).
//
// TRIGGERS. Every look at the file is one call from the injected watchFile
// (lib/core/watch's signature: a file watch re-armed per inode plus a mandatory
// poll every pollMs, funnelled into one single-flight call). No directory watch,
// ever (V17). Polls are the caller's to choose: 500 ms for a main transcript
// (the watch alone caught 6–12 of 9–16 appends, V1), 1 s for subagent and
// workflow-agent files, 2 s for journals and task outputs. The transcripts
// source passes engine.watchFile, so mirror.stop() stops the watch too.
//
// EACH CALL (a "pump") looks at the path with lstat and, with the file open:
//   - the open file is shorter than what was read        → 'truncated'
//   - its first bytes (up to 256) no longer hash the same → 'rewritten'
//   - otherwise read to EOF
//   - then, if the path now names another (dev, ino), or nothing: what the old
//     file still held was just read; it is closed, and the reset is
//     'replaced' (opened at once) or 'deleted' (opened when a file appears)
// Each reset is followed by the anchor search: the new content is scanned for
// the last uuid handed over and the `after` uuid-less lines after it (the last
// one checked by its hash). Found, reading resumes just past it, so a
// rewrite-by-copy hands nothing over twice; not found, it re-reads from 0 and
// forgets the anchor. Then onReset({reason, anchoredAt, anchored, gen}) and
// the records from there. A 'deleted' reset fires when the file comes back
// (the search needs content); until then stats.waiting is set. Not seen (as in
// the prototype): a partial last line rolled back and overwritten to at least
// its old length between two pumps, behind an unchanged head. Claude Code only
// appends, and a partial is a write in progress.
//
// OPENING. A file that does not exist yet (a transcript does not at
// SessionStart, §2.2) is stat-polled until it appears, and one that never does
// is tolerated: stats.waiting stays set and stop() still resolves. Each time a
// file is about to be opened (it appeared, or replaced the old one) `fence(file)`
// runs again (the transcripts source passes lib/core/claude-files transcriptFile:
// a path vouched for before the file existed vouches only for its directory,
// U21), and the path it returns is opened O_NOFOLLOW | O_NONBLOCK | O_NOCTTY,
// then fstat'd for a regular file. A refusal (the fence answers null, the path
// is a symlink, a FIFO, a directory) reads nothing and is one onError per
// refused file (err.code 'WC_TAIL_REFUSED', err.reason 'fence' | 'symlink' |
// 'not-a-file'); the next pump looks again.
//
// RESUME. The consumer keeps the position, never this file: a state file of
// its own lagged by a chunk in 3 of 16 SIGKILLs (V17). `resume` is
// { dev, ino, offset, lastUuid, afterUuid, lastLineHash, headLen, headHash },
// as resumeAt(rec) builds it from any record this tailer handed over. At the
// first open it is honoured only when the inode matches, the size is at least
// the offset, the first headLen bytes hash to headHash and the byte before the
// offset is a newline; reading then starts at the offset (nothing before it is
// read again) and the anchor carries on from it. Otherwise
// onReset({reason: 'resume-mismatch', anchoredAt: 0}) and the file is re-read
// from 0 (record ids derive from content, so the consumer's re-read reproduces
// them). resumeAt(rec) returns null for a record this tailer did not hand over.
// The line hash is sha256 over the line's text as UTF-8 (rec.line), the same
// on both sides.
//
// LIFECYCLE. start() makes the watch and resolves after the first pump
// (`await watch.trigger('start')`). drain() resolves once a pump that began
// after it has read to EOF and every onRecords it made has settled (the /clear
// and SessionEnd cases); never await it from inside a callback, which that pump
// is waiting on. onRecords and onReset may return a promise: it is awaited
// before the next read, so a slow consumer slows the tailer instead of
// queueing. A callback's throw is passed to onError and the tailer carries on.
// stop() is idempotent: nothing is handed over once it is called, it awaits the
// watch's stop() (which waits out a pump in flight), then closes the file, and
// leaves no handle. The watch is persistent (U03 #5): on Node 22 a test
// awaiting work that only unref'd handles hold is cancelled (V17).
//
// `stats` is live, content-free counters: pumps, reads, bytes, records,
// badLines, oversize, emptyLines, partialTails (pumps that ended inside a
// line), opens, refused, errors, resets {truncated, rewritten, replaced,
// deleted, resume-mismatch}, gen, offset, waiting (the file is absent), and
// resumed (null until the first open, then 'offset', 'mismatch' or 'fresh').
//
// Not the prototype: no EventEmitter (callbacks), no state file and no
// temp-file write, no directory watch and no watcher of its own, the
// resume is the consumer's, the anchor works before the first uuid too
// (a file opening with uuid-less records), an empty line is never counted
// (it was skipped when read but counted by the search), the line cap also
// holds for a line that arrives whole inside one chunk, and an oversize line
// counts toward the anchor.
//
// Dependency rule: Node built-ins and lib/core/watch only.

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { watchFile: coreWatchFile } = require('../../core/watch');

const HEAD_BYTES = 256;
const NL = 0x0a;
const C = fs.constants;
const OPEN_FLAGS = C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0) | (C.O_NOCTTY || 0);
const RESET_REASONS = Object.freeze(['truncated', 'rewritten', 'replaced', 'deleted', 'resume-mismatch']);
const REFUSED = 'WC_TAIL_REFUSED';

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
// A line's hash, over its text as UTF-8: what resumeAt can rebuild from rec.line.
const lineHash = (text) => sha(text);
const noop = () => {};

// ── splitting ────────────────────────────────────────────────────────────────
//
// One line splitter, for the reader and the anchor search alike. `at` is the
// committed boundary (the start of the carry); push(chunk) takes the bytes that
// start at `readPos` and returns the lines it completed, each
// { buf, start, end }: buf is null for an oversize line, and otherwise may be a
// view of `chunk` (use it before the next read). The carry is copied.
function lineSplitter(maxLine, at = 0) {
  let pos = at;
  let carry = [];
  let carryLen = 0;
  let skipping = false;
  return {
    get at() { return pos; },
    get readPos() { return pos + carryLen; },
    get carryLen() { return carryLen; },
    reset(to) { pos = to; carry = []; carryLen = 0; skipping = false; },
    push(chunk) {
      const out = [];
      const base = pos + carryLen; // the file offset of chunk[0]
      let s = 0;
      for (;;) {
        const nl = chunk.indexOf(NL, s);
        if (nl < 0) break;
        const end = base + nl + 1;
        if (skipping || carryLen + (nl - s) > maxLine) {
          out.push({ buf: null, start: pos, end });
        } else {
          const piece = chunk.subarray(s, nl);
          out.push({ buf: carryLen ? Buffer.concat([...carry, piece]) : piece, start: pos, end });
        }
        pos = end;
        carry = [];
        carryLen = 0;
        skipping = false;
        s = nl + 1;
      }
      const rest = chunk.length - s;
      if (rest > 0) {
        if (!skipping && carryLen + rest > maxLine) { skipping = true; carry = []; }
        if (!skipping) carry.push(Buffer.from(chunk.subarray(s)));
        carryLen += rest; // skipped bytes count too, so readPos moves past them
      }
      return out;
    },
  };
}

function uuidOf(obj) {
  return obj && typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : null;
}

function parseLine(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

// A resume as the consumer stored it, checked for shape. A malformed one is
// kept as `invalid` so its first open still reports 'resume-mismatch'.
function normalizeResume(r) {
  if (r == null) return null;
  if (typeof r !== 'object') return { invalid: true };
  const ok = Number.isFinite(r.dev) && Number.isFinite(r.ino)
    && isCount(r.offset)
    && Number.isInteger(r.headLen) && r.headLen >= 0 && r.headLen <= HEAD_BYTES
    && (r.headLen === 0 ? (r.headHash == null || isHash(r.headHash)) : isHash(r.headHash))
    && (r.lastUuid == null || (typeof r.lastUuid === 'string' && r.lastUuid !== ''))
    && isCount(r.afterUuid ?? 0)
    && (r.lastLineHash == null || isHash(r.lastLineHash));
  if (!ok) return { invalid: true };
  return {
    dev: r.dev, ino: r.ino, offset: r.offset,
    headLen: r.headLen, headHash: r.headLen ? r.headHash : null,
    lastUuid: r.lastUuid ?? null, afterUuid: r.afterUuid ?? 0, lastLineHash: r.lastLineHash ?? null,
  };
}

function positiveInt(name, v) {
  if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`createTailer: ${name} must be a positive integer`);
}

function createTailer({
  file,
  resume = null,
  pollMs = 500,
  chunkBytes = 256 * 1024,
  maxLineBytes = 64 * 1024 * 1024,
  watchFile = coreWatchFile,
  fence = (p) => p,
  onRecords = noop,
  onReset = noop,
  onError = noop,
  log,
} = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('createTailer: file must be a non-empty path');
  positiveInt('chunkBytes', chunkBytes);
  positiveInt('maxLineBytes', maxLineBytes);
  for (const [name, fn] of [['watchFile', watchFile], ['fence', fence], ['onRecords', onRecords], ['onReset', onReset], ['onError', onError]]) {
    if (typeof fn !== 'function') throw new TypeError(`createTailer: ${name} must be a function`);
  }
  const target = path.resolve(file);
  const note = (msg) => {
    if (typeof log !== 'function') return;
    try { log(msg); } catch {}
  };

  const resets = Object.create(null);
  for (const r of RESET_REASONS) resets[r] = 0;
  const stats = {
    pumps: 0, reads: 0, bytes: 0, records: 0, badLines: 0, oversize: 0, emptyLines: 0,
    partialTails: 0, opens: 0, refused: 0, errors: 0, resets,
    gen: 0, offset: 0, waiting: false, resumed: null,
  };

  // Where the open file stands, and the anchor: the last uuid handed over and
  // the uuid-less lines after it, the last one's hash.
  const st = { dev: null, ino: null, headLen: 0, headHash: null, lastUuid: null, afterUuid: 0, lastLineHash: null };
  const split = lineSplitter(maxLineBytes);
  const emitted = new WeakMap(); // rec → what resumeAt needs that the rec may lose
  let readBuf = null;
  let fh = null;
  let pendingReason = null; // 'replaced' | 'deleted': fired at the next open
  let resumeHint = normalizeResume(resume);
  let refusedKey = null;    // the file last refused, so a poll does not repeat it
  let failKey = null;       // the last pump failure, likewise
  let watch = null;
  let startP = null;
  let stopP = null;
  let stopped = false;

  function fail(e, where) {
    stats.errors += 1;
    note(`tail ${target}: ${where}: ${(e && e.message) || e}`);
    try { onError(e); } catch (e2) { note(`tail ${target}: onError threw: ${(e2 && e2.message) || e2}`); }
  }

  function refuse(reason, pst) {
    const key = `${reason}:${pst ? `${pst.dev}:${pst.ino}` : '-'}`;
    if (key === refusedKey) return;
    refusedKey = key;
    stats.refused += 1;
    const e = new Error(`tail: refused to read ${target} (${reason})`);
    e.code = REFUSED;
    e.reason = reason;
    fail(e, 'refused');
  }

  async function pread(pos, len) {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  }

  async function headOk(size, headLen = st.headLen, headHash = st.headHash) {
    if (!headLen) return true;
    if (size < headLen) return false;
    return sha(await pread(0, headLen)) === headHash;
  }

  // The head hash grows over committed bytes only, up to HEAD_BYTES.
  async function growHead() {
    if (st.headLen >= HEAD_BYTES || split.at <= st.headLen) return;
    const len = Math.min(HEAD_BYTES, split.at);
    const bytes = await pread(0, len);
    if (bytes.length !== len) return;
    st.headLen = len;
    st.headHash = sha(bytes);
  }

  function forgetAnchor() {
    st.lastUuid = null;
    st.afterUuid = 0;
    st.lastLineHash = null;
  }

  // Scan [0, size) for the anchor; the offset just past it, or -1.
  async function findAnchor(size) {
    const { lastUuid, afterUuid, lastLineHash } = st;
    if (lastUuid === null && afterUuid === 0) return 0; // nothing handed over yet
    const needle = lastUuid === null ? null : Buffer.from(JSON.stringify(lastUuid));
    let best = needle ? -1 : 0;
    let counted = 0;
    let pos = best;
    let hash = null;
    const sp = lineSplitter(maxLineBytes);
    const buf = Buffer.alloc(Math.max(1, Math.min(chunkBytes, size)));
    let at = 0;
    while (at < size) {
      if (stopped) return -1;
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - at), at);
      if (!bytesRead) break;
      at += bytesRead;
      for (const ln of sp.push(buf.subarray(0, bytesRead))) {
        if (ln.buf && ln.buf.length === 0) continue;
        if (needle && ln.buf && ln.buf.indexOf(needle) >= 0 && uuidOf(parseLine(ln.buf.toString('utf8'))) === lastUuid) {
          best = ln.end; counted = 0; pos = ln.end; hash = null;
          continue;
        }
        if (best >= 0 && counted < afterUuid) {
          counted += 1;
          pos = ln.end;
          hash = ln.buf ? lineHash(ln.buf.toString('utf8')) : null;
        }
      }
      if (!needle && counted === afterUuid) break;
    }
    if (best < 0 || counted < afterUuid) return -1;
    if (afterUuid > 0 && lastLineHash !== null && hash !== lastLineHash) return -1;
    return pos;
  }

  async function fireReset(reason, at) {
    const anchored = at >= 0;
    const anchoredAt = anchored ? at : 0;
    if (!anchored) forgetAnchor();
    split.reset(anchoredAt);
    stats.offset = anchoredAt;
    stats.gen += 1;
    resets[reason] += 1;
    try {
      await onReset({ reason, anchoredAt, anchored, gen: stats.gen });
    } catch (e) { fail(e, 'onReset'); }
  }

  // Lines → records, carrying the anchor forward.
  function toRecords(lines) {
    const recs = [];
    let lastText;
    for (const ln of lines) {
      if (ln.buf === null) {
        stats.oversize += 1;
        stats.badLines += 1;
        st.afterUuid += 1;
        lastText = null;
        recs.push({ line: null, obj: null, bad: true, oversize: true, start: ln.start, end: ln.end,
          anchor: { uuid: st.lastUuid, after: st.afterUuid } });
        continue;
      }
      if (ln.buf.length === 0) { stats.emptyLines += 1; continue; }
      const line = ln.buf.toString('utf8');
      const obj = parseLine(line);
      if (!obj) stats.badLines += 1;
      const uuid = uuidOf(obj);
      if (uuid) { st.lastUuid = uuid; st.afterUuid = 0; } else st.afterUuid += 1;
      lastText = line;
      recs.push({ line, obj, bad: !obj, oversize: false, start: ln.start, end: ln.end,
        anchor: { uuid: st.lastUuid, after: st.afterUuid } });
    }
    if (lastText !== undefined) st.lastLineHash = lastText === null ? null : lineHash(lastText);
    return recs;
  }

  async function deliver(recs, src) {
    if (stopped || !recs.length) return;
    const id = { dev: st.dev, ino: st.ino, headLen: st.headLen, headHash: st.headHash };
    for (const r of recs) emitted.set(r, { ...id, end: r.end, uuid: r.anchor.uuid, after: r.anchor.after });
    stats.records += recs.length;
    try {
      await onRecords(recs, { src, gen: stats.gen });
    } catch (e) { fail(e, 'onRecords'); }
  }

  async function readToEof(src) {
    if (!readBuf) readBuf = Buffer.alloc(chunkBytes);
    for (;;) {
      if (stopped) return;
      const { bytesRead } = await fh.read(readBuf, 0, readBuf.length, split.readPos);
      stats.reads += 1;
      if (bytesRead === 0) break;
      stats.bytes += bytesRead;
      const recs = toRecords(split.push(readBuf.subarray(0, bytesRead)));
      stats.offset = split.at;
      if (recs.length) {
        await growHead();
        await deliver(recs, src);
      }
      if (bytesRead < readBuf.length) break;
    }
    if (split.carryLen > 0) stats.partialTails += 1;
  }

  async function discontinuity(reason, src) {
    const { size } = await fh.stat();
    st.headLen = 0;
    st.headHash = null;
    const at = await findAnchor(size);
    if (stopped) return;
    await fireReset(reason, at);
    await readToEof(src);
  }

  async function closeFh() {
    const h = fh;
    fh = null;
    if (h) await h.close().catch(() => {});
  }

  async function resumeOk(r, fst) {
    if (r.invalid) return false;
    if (fst.dev !== r.dev || fst.ino !== r.ino || fst.size < r.offset) return false;
    if (!(await headOk(fst.size, r.headLen, r.headHash))) return false;
    if (r.offset === 0) return true;
    const b = await pread(r.offset - 1, 1);
    return b.length === 1 && b[0] === NL;
  }

  // Fence, open and place the reader. False: nothing to read this pump.
  async function openFile(pst) {
    let p = null;
    try { p = fence(target); } catch (e) { note(`tail ${target}: the fence threw: ${(e && e.message) || e}`); }
    if (typeof p !== 'string' || !p) { refuse('fence', pst); return false; }
    let h;
    try {
      h = await fsp.open(p, OPEN_FLAGS);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) { stats.waiting = true; return false; }
      if (e && (e.code === 'ELOOP' || e.code === 'EMLINK')) { refuse('symlink', pst); return false; }
      throw e;
    }
    let fst;
    try { fst = await h.stat(); } catch (e) { await h.close().catch(() => {}); throw e; }
    if (stopped) { await h.close().catch(() => {}); return false; }
    if (!fst.isFile()) { await h.close().catch(() => {}); refuse('not-a-file', fst); return false; }
    fh = h;
    refusedKey = null;
    stats.opens += 1;
    st.dev = fst.dev;
    st.ino = fst.ino;

    if (resumeHint) {
      const r = resumeHint;
      resumeHint = null;
      pendingReason = null;
      if (await resumeOk(r, fst)) {
        st.headLen = r.headLen;
        st.headHash = r.headHash;
        st.lastUuid = r.lastUuid;
        st.afterUuid = r.afterUuid;
        st.lastLineHash = r.lastLineHash;
        split.reset(r.offset);
        stats.offset = r.offset;
        stats.resumed = 'offset';
        return true;
      }
      st.headLen = 0;
      st.headHash = null;
      stats.resumed = 'mismatch';
      await fireReset('resume-mismatch', -1);
      return true;
    }
    st.headLen = 0;
    st.headHash = null;
    if (pendingReason) {
      const reason = pendingReason;
      pendingReason = null;
      const at = await findAnchor(fst.size);
      if (stopped) return false;
      await fireReset(reason, at);
      return true;
    }
    if (stats.resumed === null) stats.resumed = 'fresh';
    split.reset(0);
    stats.offset = 0;
    return true;
  }

  async function lstatOrNull() {
    try {
      return await fsp.lstat(target);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
      throw e;
    }
  }

  async function pumpOnce(src) {
    const pst = await lstatOrNull();
    if (fh) {
      const fst = await fh.stat();
      const replaced = !pst || pst.dev !== st.dev || pst.ino !== st.ino;
      if (fst.size < split.readPos) await discontinuity('truncated', src);
      else if (!(await headOk(fst.size))) await discontinuity('rewritten', src);
      else await readToEof(src); // what the old file held before a swap, too
      if (stopped) return;
      if (replaced) {
        await closeFh();
        split.reset(0);
        st.dev = null; st.ino = null; st.headLen = 0; st.headHash = null;
        // The anchor stays: the new file may be a rewrite holding our lines.
        pendingReason = pst ? 'replaced' : 'deleted';
      }
    }
    if (fh || stopped) return;
    if (!pst) { stats.waiting = true; return; }
    stats.waiting = false;
    if (await openFile(pst)) await readToEof(src);
  }

  // The one onTrigger: the watch never runs two at once.
  async function pump(src) {
    if (stopped) return;
    stats.pumps += 1;
    try {
      await pumpOnce(src);
      failKey = null;
    } catch (e) {
      const key = (e && (e.code || e.message)) || String(e);
      if (key !== failKey) { failKey = key; fail(e, 'pump'); }
    }
  }

  function start() {
    if (!startP) {
      startP = (async () => {
        if (stopped) return;
        watch = watchFile(target, pump, { pollMs, dirWatch: false, persistent: true, log });
        await watch.trigger('start');
      })();
    }
    return startP;
  }

  async function drain() {
    if (!startP || stopped) return;
    try { await startP; } catch { return; }
    if (stopped || !watch) return;
    await watch.trigger('drain');
  }

  function stop() {
    if (!stopP) {
      stopped = true;
      stopP = (async () => {
        if (watch) await watch.stop();
        await closeFh();
      })();
    }
    return stopP;
  }

  // A resume object for the position just past `rec`.
  function resumeAt(rec) {
    const id = rec && typeof rec === 'object' ? emitted.get(rec) : undefined;
    if (!id) return null;
    return {
      dev: id.dev,
      ino: id.ino,
      offset: id.end,
      lastUuid: id.uuid,
      afterUuid: id.after,
      lastLineHash: typeof rec.line === 'string' ? lineHash(rec.line) : null,
      headLen: id.headLen,
      headHash: id.headHash,
    };
  }

  return { start, stop, drain, resumeAt, stats };
}

module.exports = { createTailer, HEAD_BYTES, RESET_REASONS, lineSplitter };

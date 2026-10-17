'use strict';
// The append-only log engine — one home for "append a record to a file that is
// never rewritten, and read it back honestly after a crash".
//
// A log is JSONL: one record per line, each record a plain object with a string
// `t` (its type). The engine knows nothing else about a record. It holds no
// schema, builds no index, mints no id or version and redacts nothing: those are
// the caller's (lib/core/element-log, the element record layer, is the first and
// in tranche 1 the only caller; it builds its indexes in load's `onRecord`).
//
// WHAT IT GUARANTEES
//
//   One writer. Within a process, a second openLog of a path that is already
//     open throws ELOGOPEN until the first is closed (a dry run holds no fd and
//     writes nothing, so it never takes the path). Across processes there is no
//     lockfile, by construction rather than by locking: the daemon is the only
//     writer of a project's logs, and there is one daemon per project
//     (lib/util/registry daemonFor, kept honest by lib/server/instance-guard); the
//     `migrate` CLI only ever opens a log as a dry run.
//
//   One write per record. append() serialises `JSON.stringify(rec) + '\n'` (JSON
//     escapes every newline inside a string, so a record is exactly one line) and
//     hands it to ONE fs.writeSync on ONE descriptor opened in append mode
//     (O_APPEND, mode 0o600 because a log holds comment text). A write lands
//     whole at the end of the file or, on a crash, as a prefix of itself: never
//     interleaved with another record. A short write throws ESHORTWRITE, and so
//     does every later append of that open (a record written after a partial
//     line would be glued onto it): reopen, and the load sets the tail aside.
//
//   Append-only. Nothing here rewrites, reorders or deletes a complete line. The
//     one truncation is the torn tail's, below, and it removes only bytes that
//     were never a complete record.
//
//   A torn tail is set aside, never destroyed. A final segment with no newline is
//     what a crash mid-write leaves. load() copies its exact bytes to
//     `<file>.torn-<ms>` (a same-millisecond suffix `-<n>`, as fsjson renameAside
//     names its asides; written through fsjson writeFileAtomic) and only then
//     truncates the file to its last newline, so the next append starts a clean
//     line. A crash between the two leaves the tail in both places, never in
//     neither.
//
//   A bad line is skipped, never "the whole log is corrupt". A complete line
//     that does not parse as a record (JSON, a plain object, a string `t`) is
//     counted in stats().bad with its byte offset (the first 20 kept) and the
//     records around it are handed out as usual. A blank line is skipped and not
//     counted bad (the engine never writes one).
//
//   The lazy epoch. Before the FIRST append of each open the engine appends
//     `{t: 'epoch', boot, at, pid}` with its own write. Lazy on purpose: an open
//     that appends nothing adds 0 bytes, so a migration's second run appends 0
//     bytes (GT-09), and a boot reconcile can tell which boots wrote records
//     (G-10's epoch marker) — a boot without an epoch wrote nothing.
//
//   No fsync by default. The settled default leaves the bytes in the page cache:
//     a process crash (the measured failure, C-2) loses nothing that a write(2)
//     returned for, because the kernel already holds it; only a machine crash can
//     lose a tail, and the torn-tail rule above recovers from that. `fsync: true`
//     calls fs.fsyncSync once after each write for a caller that wants the power
//     cut covered too, at its measured cost.
//
//   A dry run touches no file. `dryRun: true` reads the file (and reports a torn
//     tail) but moves nothing, makes no directory and opens no descriptor;
//     append() validates and serialises exactly as a real run would and counts
//     the bytes in stats().pending_bytes, the epoch included, so a dry run with the
//     same bootId and clock predicts a real run's bytes exactly.
//
// Dependency rule: a lib/core leaf — Node builtins and lib/core/fsjson only.

const nodeFs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsjson');

// Real paths of the logs open for writing in this process (the one-writer rule).
const OPEN = new Set();
const BAD_OFFSETS_KEPT = 20;

function codeError(code, message, Ctor = Error) {
  const e = new Ctor(message);
  e.code = code;
  return e;
}

// The path's identity: its realpath, or — while the file (or its directory) does
// not exist yet — the realpath of the nearest existing ancestor joined to the rest,
// so a symlinked spelling of a directory names the same log.
function realKey(file) {
  const abs = path.resolve(file);
  const rest = [];
  let cur = abs;
  for (;;) {
    try { return path.join(nodeFs.realpathSync(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

function isRecord(rec) {
  return rec !== null && typeof rec === 'object' && !Array.isArray(rec) && typeof rec.t === 'string';
}

function openLog(file, opts = {}) {
  const {
    fsync = false,
    dryRun = false,
    epoch = true,
    now = Date.now,
    fs = nodeFs,
  } = opts;
  if (typeof file !== 'string' || !file) throw new TypeError('openLog: file must be a non-empty path');
  const bootId = opts.bootId != null ? String(opts.bootId) : `${process.pid}:${now()}`;

  const key = dryRun ? null : realKey(file);
  if (key) {
    if (OPEN.has(key)) throw codeError('ELOGOPEN', `applog: ${file} is already open for writing in this process; close it first`);
    OPEN.add(key);
  }

  let fd = null;
  let loaded = false;
  let closed = false;
  let torn = false; // a short write left a partial line: this open may not append again
  let size = 0; // the file's length as this open knows it: the next append's offset
  const st = {
    lines: 0, complete: 0, bad: 0, bad_offsets: [], torn: null, bytes_at_load: 0,
    appended_records: 0, appended_bytes: 0, pending_records: 0, pending_bytes: 0, epoch_written: false,
  };

  function load({ onRecord } = {}) {
    if (closed) throw codeError('ECLOSED', `applog: ${file} is closed`);
    if (loaded) throw codeError('ELOADED', `applog: ${file} was already loaded by this open`);
    Object.assign(st, { lines: 0, complete: 0, bad: 0, bad_offsets: [], torn: null, bytes_at_load: 0 });
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) throw e;
      buf = Buffer.alloc(0);
    }
    st.bytes_at_load = buf.length;
    const bodyLen = buf.lastIndexOf(0x0a) + 1;
    if (bodyLen < buf.length) {
      const tail = buf.subarray(bodyLen);
      st.torn = { bytes: tail.length, aside: null };
      if (!dryRun) {
        // The bytes first, the truncation second: a crash in between keeps the
        // tail twice (the next load sets it aside again), never zero times.
        let aside = `${file}.torn-${now()}`;
        for (let i = 1; fs.existsSync(aside) && i < 1000; i++) aside = `${file}.torn-${now()}-${i}`;
        writeFileAtomic(aside, tail, { mkdir: false });
        try { nodeFs.chmodSync(aside, 0o600); } catch {}
        fs.truncateSync(file, bodyLen);
        st.torn.aside = path.basename(aside);
      }
    }
    size = bodyLen;
    let start = 0;
    let index = 0;
    while (start < bodyLen) {
      const nl = buf.indexOf(0x0a, start);
      const offset = start;
      start = nl + 1;
      st.lines++;
      if (nl === offset) continue; // a blank line: never written by the engine
      let rec;
      try { rec = JSON.parse(buf.toString('utf8', offset, nl)); } catch { rec = undefined; }
      if (!isRecord(rec)) {
        st.bad++;
        if (st.bad_offsets.length < BAD_OFFSETS_KEPT) st.bad_offsets.push(offset);
        continue;
      }
      st.complete++;
      if (onRecord) onRecord(rec, { offset, index });
      index++;
    }
    loaded = true;
    return stats();
  }

  function writeLine(buf) {
    const offset = size;
    if (dryRun) {
      st.pending_records++;
      st.pending_bytes += buf.length;
      size += buf.length;
      return { offset, bytes: buf.length };
    }
    if (fd == null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(file, 'a', 0o600);
    }
    const n = fs.writeSync(fd, buf, 0, buf.length);
    size += n;
    if (n !== buf.length) {
      torn = true;
      throw codeError('ESHORTWRITE', `applog: short write to ${file} (${n} of ${buf.length} bytes); the tail is torn and the next load sets it aside`);
    }
    if (fsync) fs.fsyncSync(fd);
    st.appended_records++;
    st.appended_bytes += buf.length;
    return { offset, bytes: buf.length };
  }

  function append(rec) {
    if (closed) throw codeError('ECLOSED', `applog: ${file} is closed`);
    if (torn) throw codeError('ESHORTWRITE', `applog: an earlier short write tore ${file}; reopen and load it before appending again`);
    if (!loaded) throw codeError('ENOTLOADED', `applog: load() ${file} before appending (an unread torn tail would swallow the record)`);
    if (!isRecord(rec)) throw new TypeError('applog: a record is a plain object with a string `t`');
    // Serialise before the epoch, so a record that cannot be serialised (a cycle,
    // a BigInt) throws with nothing written.
    const buf = Buffer.from(`${JSON.stringify(rec)}\n`, 'utf8');
    if (epoch && !st.epoch_written) {
      writeLine(Buffer.from(`${JSON.stringify({ t: 'epoch', boot: bootId, at: now(), pid: process.pid })}\n`, 'utf8'));
      st.epoch_written = true;
    }
    return writeLine(buf);
  }

  function stats() {
    return {
      ...st,
      bad_offsets: st.bad_offsets.slice(),
      torn: st.torn ? { ...st.torn } : null,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      if (fd != null) fs.closeSync(fd);
    } finally {
      fd = null;
      if (key) OPEN.delete(key);
    }
  }

  return { load, append, close, stats, file, bootId, dryRun };
}

module.exports = { openLog };

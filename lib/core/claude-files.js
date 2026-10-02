// Fences for the paths the chat mirror reads out of Claude Code's own text.
//
// The mirror opens files whose paths it did not choose. Every hook envelope
// carries a `transcript_path` (validation V3); a background task's tool result
// and its notification name its output file (V5); a tool result too large for
// the transcript names the file it was kept in, `persistedOutputPath` (V1); an
// ExitPlanMode call names its plan, `planFilePath` (V9). All of that is text a
// model wrote or echoed, and a model's text can be steered: a page Claude
// fetched or a file it read can print any path at all, ~/.ssh/id_rsa included.
// So nothing read out of that text reaches `fs` except through one of the four
// fences below. Each answers an absolute path or null, and refuses on any
// doubt: a path that is not a clean absolute one, that has the wrong shape or
// name, that is (or resolves through) a link out of its tree, that names
// something other than a regular file, or that the filesystem would not answer
// about. A fence never throws. `readWindow` then reads a fenced file in one
// bounded window: task outputs have no size cap (one reached 3 GB, V5).
//
// In lib/core, importing nothing but fs, path and ./paths, because two layers
// read these files: the daemon's mirror engine (lib/server/mirror) and the ask
// hook (lib/hooks/ask.js), which reads a plan before it posts the ask and may
// not import lib/server. Containment is asked of lib/core/paths `fence` (the
// lexical shape, then the realpath of the nearest entry that exists), never
// hand-rolled.
//
// A fence takes a path in either spelling of its root: the one this process
// uses, and the root's realpath. Claude Code and the daemon can reach one
// directory by two names (macOS's /var is /private/var; a ~/.claude kept
// elsewhere and linked into the home directory), and both name the same
// directory. Any other spelling is refused. The path is returned as given.

const fs = require('fs');
const path = require('path');
const { userClaudePaths, fence, realpath, isSafeId } = require('./paths');

// The longest string taken as a path. Claude Code writes far shorter ones; the
// bound only keeps the string work below it small.
const PATH_MAX = 4096;
// NUL and the other control characters: Claude Code never writes them into a
// path, and a newline in one is how text smuggles a second line into a log.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// The three directories Claude Code writes beside a session's transcript.
const SESSION_SUBDIRS = new Set(['tool-results', 'subagents', 'workflows']);

// <tmp>/claude-<uid>/<slug>/<session at process start>/tasks/<task id>.output
// (V5; the task id grammar is test-support/claude-home's too). The tmp base is
// Claude Code's to choose, so it is any prefix.
const TASK_OUTPUT_RE = /^(.+)\/claude-(\d+)\/[^/]+\/[^/]+\/tasks\/[A-Za-z0-9_-]{1,64}\.output$/;

// readWindow's default window, and the most it ever reads at once, whatever a
// caller asks for. The routes page at 256 KiB, and the ask hook reads a plan up
// to 256 KB.
const WINDOW_BYTES = 256 * 1024;
const WINDOW_MAX_BYTES = 8 * 1024 * 1024;

// How readWindow opens a file: never through a link at the last component
// (O_NOFOLLOW fails with ELOOP), never waiting on a FIFO with no writer
// (O_NONBLOCK), and never adopting a terminal as the process's controlling one
// (O_NOCTTY). The descriptor is then checked to be a regular file.
const OPEN_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_NONBLOCK || 0)
  | (fs.constants.O_NOCTTY || 0);

// ── helpers ──────────────────────────────────────────────────────────────────

// A path as Claude Code writes one: a string, absolute, already normalised (no
// `.` or `..` segment, no doubled or trailing separator) and free of control
// characters. Anything else is not a path Claude Code wrote, and is refused
// before the filesystem is asked about it.
function clean(p) {
  if (typeof p !== 'string' || !p || p.length > PATH_MAX || CONTROL_RE.test(p)) return null;
  if (!path.isAbsolute(p) || path.normalize(p) !== p) return null;
  if (p !== path.sep && p.endsWith(path.sep)) return null;
  return p;
}

// lstat that tells "nothing there" (null) from "could not ask" (undefined): a
// fence may take the first as an answer, never the second.
function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : undefined;
  }
}

// The segments of `p` below `dir`, under either spelling of `dir`, or null when
// `p` is not below it: lib/core/paths `fence` decides containment (the lexical
// shape, and the realpath of the nearest entry along `p` that exists), and only
// then are the segments read off.
function segmentsBelow(dir, p) {
  const real = realpath(dir);
  for (const base of real && real !== dir ? [dir, real] : [dir]) {
    if (fence(base, p) === null) continue;
    const rel = path.relative(base, p);
    return rel ? rel.split(path.sep) : null;
  }
  return null;
}

// A fence answers a path or null, never an exception: an error it did not
// foresee is doubt like any other (a home directory the OS cannot name, say).
function failClosed(check) {
  const guarded = (...args) => {
    try {
      return check(...args);
    } catch {
      return null;
    }
  };
  Object.defineProperty(guarded, 'name', { value: check.name });
  return guarded;
}

// ── the fences ───────────────────────────────────────────────────────────────

// transcriptFile(p): a session's transcript, as a hook's `transcript_path` names
// it: <projectsDir>/<project slug>/<session id>.jsonl under
// userClaudePaths().projectsDir, the file a direct child of a directory directly
// under it, the session id in the one id grammar (lib/core/paths isSafeId).
//
// Claude Code creates the file only after SessionStart has fired (V3), and the
// mirror accepts that envelope and waits for the file (spec §2.2), so a path
// whose file does not exist yet is accepted when the nearest entry along it
// that does exist resolves inside projectsDir. That vouches for the directory,
// not for what appears there later: check again (here, or with an open that
// refuses links) once the file exists. A file that does exist must be a regular
// file of its own; a link (even to another transcript), a directory or a FIFO
// is refused.
function transcriptFile(p) {
  const abs = clean(p);
  if (!abs) return null;
  const segs = segmentsBelow(userClaudePaths().projectsDir, abs);
  if (!segs || segs.length !== 2) return null;
  const name = segs[1];
  if (!name.endsWith('.jsonl') || !isSafeId(name.slice(0, -'.jsonl'.length))) return null;
  const st = lstat(abs);
  if (st === undefined || (st !== null && !st.isFile())) return null;
  return abs;
}

// sessionDirFile(sessionDir, p): a file in a session's side directory,
// <projectsDir>/<slug>/<session id>/, inside one of the three directories Claude
// Code writes there: tool-results/ (a result too large for the transcript,
// V1), subagents/ (an Agent's transcript and meta file, and a workflow's agents
// under subagents/workflows/<runId>/, V4 and V7) and workflows/ (a workflow's
// script and its summary, V4). A workflow agent's records carry its parent's
// session id, and its oversized results land in the parent's tool-results/
// (V4), so for one the caller passes the parent session's directory.
//
// `sessionDir` must itself be a session directory under projectsDir. `p` must
// be inside it (lib/core/paths fence), inside one of the three both as spelled
// and once every link is resolved, and a regular file that is not a link.
function sessionDirFile(sessionDir, p) {
  const dir = clean(sessionDir);
  const abs = clean(p);
  if (!dir || !abs) return null;
  const at = segmentsBelow(userClaudePaths().projectsDir, dir);
  if (!at || at.length !== 2 || !isSafeId(at[1])) return null;
  const segs = segmentsBelow(dir, abs);
  if (!segs || segs.length < 2 || !SESSION_SUBDIRS.has(segs[0])) return null;
  const st = lstat(abs);
  if (!st || !st.isFile()) return null;
  // The same question after the links: a subdirectory that is itself a link
  // (tool-results -> .) would otherwise reach the rest of the session.
  const realDir = realpath(dir);
  const realFile = realpath(abs);
  if (!realDir || !realFile) return null;
  const real = segmentsBelow(realDir, realFile);
  if (!real || real.length < 2 || !SESSION_SUBDIRS.has(real[0])) return null;
  return abs;
}

// taskOutputFile(p): a background task's output file, as its tool result and
// its notification name it (V5): <tmp>/claude-<uid>/<slug>/<session at process
// start>/tasks/<task id>.output. The path is only ever read from the text, never
// derived (after /clear a task still lands under the first session's directory,
// and the tmp base is Claude Code's to choose), so the fence rests on what the
// filesystem says rather than on where the file ought to be:
//   * that shape, with <uid> exactly this process's uid: a path into another
//     user's tree is refused before anything is asked about it;
//   * claude-<uid> a directory and not a link, owned by this uid and writable
//     by no one else (Claude Code makes it 0700), so nobody but this user can
//     have put anything under it;
//   * the file regular and not a link. An Agent's `outputFile` sits in tasks/
//     as a link to the agent's transcript (V7), and is refused here: agents are
//     read from the session's subagents/ (sessionDirFile);
//   * its realpath inside claude-<uid> (lib/core/paths fence).
// Never list tasks/: it also holds foreground calls' transient files and other
// sessions' old ones (V5).
function taskOutputFile(p) {
  const abs = clean(p);
  if (!abs) return null;
  const m = TASK_OUTPUT_RE.exec(abs);
  if (!m || typeof process.getuid !== 'function') return null;
  const uid = process.getuid();
  if (m[2] !== String(uid)) return null;
  const top = `${m[1]}/claude-${m[2]}`;
  const dirSt = lstat(top);
  if (!dirSt || !dirSt.isDirectory() || dirSt.uid !== uid || (dirSt.mode & 0o022) !== 0) return null;
  const st = lstat(abs);
  if (!st || !st.isFile()) return null;
  return fence(top, abs) === null ? null : abs;
}

// planFile(p): an ExitPlanMode call's `planFilePath` (V9). The ask hook reads
// the plan from this file because the `plan` in the tool input was the previous
// plan in 4 of 5 calls. Whether a model can choose the path itself was never
// established, and a prompt-injected call could name ~/.ssh/id_rsa, so: a clean
// absolute path inside userClaudePaths().plansDir (as spelled, and by realpath),
// named *.md, and a regular file that is not a link. Anything else is refused,
// and the hook falls back to the tool input's plan; nothing read from a refused
// path is ever posted.
function planFile(p) {
  const abs = clean(p);
  if (!abs) return null;
  const segs = segmentsBelow(userClaudePaths().plansDir, abs);
  if (!segs) return null;
  const name = segs[segs.length - 1];
  if (name.length <= '.md'.length || !name.endsWith('.md')) return null;
  const st = lstat(abs);
  if (!st || !st.isFile()) return null;
  return abs;
}

// ── the bounded read ─────────────────────────────────────────────────────────

// readWindow(file, { maxBytes, fromEnd, from })
//   → { text, startsMidFile, complete, from, to, size } | null
//
// One bounded read of a fenced file, in the shape lib/core/redact
// `redactWindow` takes. At most `maxBytes` bytes (default WINDOW_BYTES, and
// never more than WINDOW_MAX_BYTES whatever is asked), starting at byte `from`
// (default 0) or, with `fromEnd: true`, the last `maxBytes` bytes. Nothing
// outside the window is read, however large the file.
//
//   text           the window, decoded as UTF-8. Its edges are cut at bytes, so
//                  a character or a line may be cut in two there.
//   startsMidFile  the window starts after the file's first byte, so its first
//                  line may be the end of a longer one (redactWindow drops it).
//   complete       the window runs to the end of the file as it was read: no
//                  line goes on past it (when false, redactWindow drops the last
//                  line, which may be cut).
//   from, to       where the window starts and ends, in bytes (`to` exclusive).
//                  To page through a file, pass `to` back as the next `from`.
//   size           the file's size when it was read.
//
// The open refuses a link and never waits on a FIFO, and the descriptor must be
// a regular file, so a path swapped after its fence answered is still read only
// if it is a plain file. Answers null when the file cannot be read that way
// (absent, a link, a directory, a FIFO, unreadable, not a clean absolute path),
// and throws a TypeError for an option that is not a count of bytes.
function readWindow(file, opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes === undefined ? WINDOW_BYTES : o.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError(`readWindow: maxBytes is a whole number of bytes above 0, not ${String(maxBytes)}`);
  }
  if (o.from !== undefined && (!Number.isSafeInteger(o.from) || o.from < 0)) {
    throw new TypeError(`readWindow: from is a byte offset (a whole number, 0 or more), not ${String(o.from)}`);
  }
  if (o.fromEnd && o.from !== undefined) {
    throw new TypeError('readWindow: a window is read from `from` or from the end of the file, not both');
  }
  const abs = clean(file);
  if (!abs) return null;
  const want = Math.min(maxBytes, WINDOW_MAX_BYTES);

  let fd;
  try {
    fd = fs.openSync(abs, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const size = st.size;
    const start = o.fromEnd ? Math.max(0, size - want) : Math.min(o.from || 0, size);
    const len = Math.min(want, size - start);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    const to = start + got;
    // The file ended before the window did: it shrank after it was measured,
    // and its end is where the read stopped.
    const short = got < len;
    return {
      text: buf.toString('utf8', 0, got),
      startsMidFile: start > 0,
      complete: short || to >= size,
      from: start,
      to,
      size: short ? to : size,
    };
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

module.exports = {
  transcriptFile: failClosed(transcriptFile),
  sessionDirFile: failClosed(sessionDirFile),
  taskOutputFile: failClosed(taskOutputFile),
  planFile: failClosed(planFile),
  readWindow,
  WINDOW_BYTES,
  WINDOW_MAX_BYTES,
};

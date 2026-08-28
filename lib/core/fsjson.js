// The durable-JSON-record engine — one home for "write a small JSON record so a
// crash can never leave a torn one" and for "read it back honestly".
//
// Two concepts, deliberately paired here because they are two halves of the same
// guarantee:
//
//   writeJsonAtomic — serialize, write a per-pid temp file IN THE SAME DIRECTORY,
//     then renameSync onto the destination. rename(2) within a filesystem is
//     atomic, so a reader (or a crash) sees either the whole old record or the
//     whole new one, never a prefix. This idiom existed twice with two spellings
//     (`${p}.${pid}.tmp` in lib/util/registry.js, `${file}.tmp-${pid}` in
//     lib/packs/store.js) while the three records that most need it — graph node
//     files, graph/_meta.json and draft.json — had no atomicity at all.
//
//   readJson — a TRI-STATE (well, quad-state) read: absent / corrupt / invalid /
//     ok. Every private reader in the tree collapsed at least two of those into
//     one value, and each collapse cost something real: a torn graph/_meta.json
//     read as "the user deliberately wiped the surface", which then made a valid
//     draft.json look stale and got it deleted; a torn _version.json read as "a
//     fresh project", which stamped the current schema and skipped every pending
//     migration.
//
// WHY THE PER-PID TEMP NAME: the graph's _meta.json has a second, out-of-process
// writer — `claude-web-chat doctor` clears an orphaned lock (lib/cli/commands/
// doctor.js) while a daemon may still be live. A fixed `.tmp` suffix would let
// two processes share one temp file and interleave. (Note that a per-pid temp
// name makes each WRITE whole; it does not make doctor's read-modify-write safe.
// That race is called out where it lives.)
//
// OUT OF SCOPE: cross-filesystem moves. The temp file is always a sibling of the
// destination precisely so renameSync cannot fail with EXDEV; callers that need
// to land a file from another filesystem (the release downloader, install.sh)
// are doing a different job and must not route through here.
//
// Dependency rule: this is a lib/core leaf — it imports nothing else from lib/.
// It also holds NO type-specific knowledge. Shape predicates (is this a graph
// node? is this a version stamp?) are passed in as `validate` and live next to
// the code that owns the type, matching the boundary lib/core/resources.js draws.

const fs = require('fs');
const path = require('path');

// Serialize + write + rename. Returns the destination path.
//
// Throws on failure — swallowing is the CALLER's choice, and the callers
// genuinely disagree: graph.writeNode lets an ENOSPC 500 the route, writeDraft
// turns it into `return false`, and recordMcpSeen ignores it entirely because it
// runs inside a per-request middleware. An engine that swallowed would erase
// that distinction.
//
// `newline` defaults to FALSE so adopting the engine never rewrites the bytes of
// a record that had no trailing newline before (about a third of the records in
// the tree append one and about two thirds do not; each caller keeps whichever
// it already wrote, so an upgrade does not churn every file under .web-chat/).
function writeJsonAtomic(file, value, { pretty = 2, newline = false, mkdir = true, fsync = false } = {}) {
  const dir = path.dirname(file);
  if (mkdir) fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(value, null, pretty) + (newline ? '\n' : '');
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (fsync) {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.writeFileSync(tmp, body);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    // Never leave the temp file behind for a failure the caller may retry.
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return file;
}

// The honest read. Exactly one of the four keys is set:
//
//   { ok: true, value }          parsed, and passed `validate` if one was given
//   { absent: true }             the file is not there (ENOENT / ENOTDIR)
//   { corrupt: true, error }     unreadable or unparsable — a torn write, a
//                                permissions problem, a directory in the way
//   { invalid: true, error, value }  parsed fine, but the wrong shape
//
// `invalid` is a RETURNED STATE, never a throw and never a silent skip, because
// the callers want three different things from it: graph.load skips the node,
// components-registry surfaces a placeholder record to the user, and
// builtins.seedBuiltins repairs the directory from the shipped copy.
//
// Deliberately NOT existsSync-then-read: that is a TOCTOU (the file can vanish
// between the two calls, and the read then throws where the caller expected
// "absent"). The ENOENT branch is the check.
function readJson(file, { validate } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { absent: true };
    return { corrupt: true, error: e };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { corrupt: true, error: e };
  }
  if (validate) {
    try {
      if (!validate(value)) return { invalid: true, error: new Error('failed shape validation'), value };
    } catch (e) {
      return { invalid: true, error: e, value };
    }
  }
  return { ok: true, value };
}

// Sugar for the eleven readers that want one fallback for everything that is not
// `ok`. Keeping it in the engine is what makes those call sites a one-liner
// instead of a four-branch switch they would each get subtly different.
//
// Note the fallback covers `corrupt` too, which is exactly right for the
// fail-CLOSED readers (a torn trust store must read as "nothing is trusted") and
// for the documented fail-soft ones (a torn baselines file falls back to the
// non-destructive bootstrap path). Where absent and corrupt must be told apart,
// call readJson directly.
function readJsonOr(file, fallback, { validate } = {}) {
  const r = readJson(file, { validate });
  return r.ok ? r.value : fallback;
}

// Move a record out of the way instead of deleting it. Returns the new path, or
// null if there was nothing to rename.
//
// The point is that "I could not read this" is not a licence to destroy it —
// loadDraft used to unlinkSync a draft it failed to parse, so the one file that
// exists to protect uncommitted work was the first casualty of a torn read.
//
// `keep` caps how many aside-files accumulate: after renaming, siblings sharing
// the `${basename}.${tag}-` prefix are reaped newest-first down to `keep`.
// Without it nothing in the tree would ever clean these up. The tag is a
// separate option (rather than a free-form suffix) precisely so the reap prefix
// is derivable from it.
function renameAside(file, { tag = 'corrupt', keep = 0, now = Date.now } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = `${base}.${tag}-`;
  let dest = path.join(dir, `${prefix}${now()}`);
  // Two failures inside the same millisecond must not silently overwrite each
  // other's evidence.
  for (let i = 1; fs.existsSync(dest) && i < 1000; i++) dest = path.join(dir, `${prefix}${now()}-${i}`);
  try {
    fs.renameSync(file, dest);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  if (keep > 0) {
    try {
      const siblings = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
      // Names sort chronologically because the timestamp is fixed-width for the
      // next ~250 years; drop everything but the newest `keep`.
      for (const stale of siblings.slice(0, Math.max(0, siblings.length - keep))) {
        try { fs.unlinkSync(path.join(dir, stale)); } catch {}
      }
    } catch {}
  }
  return dest;
}

module.exports = { writeJsonAtomic, readJson, readJsonOr, renameAside };

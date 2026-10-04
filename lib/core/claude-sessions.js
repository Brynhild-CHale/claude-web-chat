// The one reader of Claude Code's per-process state files: <sessions>/<pid>.json
// under Claude Code's user tier (lib/core/paths userClaudePaths().sessionsDir,
// which CLAUDE_CONFIG_DIR moves).
//
// Claude Code keeps one such file per running process, and removes it at exit
// (validation V14). It says what that process is doing right now — `status`
// (busy | waiting | idle) and, while waiting, `waitingFor` ("permission prompt",
// "input needed", V10) — and which session it is writing: `sessionId` switches
// on /clear while the pid stays (V14), and 2.1.287 also lists the sessions the
// process had before in `formerNames[].sessionId`. Its `procStart` is the
// process's start time exactly as `ps -o lstart` prints it in UTC (F7), so a pid
// plus `procStart` names one process and survives pid reuse
// (lib/core/portfiles isPidAlive(pid, {startedAt})). It is internal to Claude
// Code (`claude agents --json` is the documented reader), so everything that
// reads it degrades to hooks and process facts without it.
//
// BESIDE EACH <pid>.json SITS A <pid>.key, WHICH HOLDS A PEER TOKEN (V16). This
// module never opens one, and is built so that it cannot:
//   * a file name is only ever BUILT from a number: readSessionState takes an
//     integer pid and asks userClaudePaths().claudeSessionStateFile(pid), which
//     answers `<sessionsDir>/<pid>.json` or null; no caller-supplied string is
//     ever joined onto the directory;
//   * listSessionPids reads the directory's NAMES only (no file is opened) and
//     keeps those that are exactly `<pid>.json`, a positive integer with no
//     leading zero, so the name it hands back rebuilds to itself;
//   * the open refuses a link at the last component (O_NOFOLLOW), so a
//     `<pid>.json` that is a symbolic link to its `.key` fails to open; the
//     descriptor must be a regular file (a FIFO or a directory is refused,
//     and O_NONBLOCK keeps a FIFO from blocking the open), not hard-linked
//     elsewhere (a `<pid>.json` sharing its inode with a `.key` is refused by
//     its link count), and at most MAX_BYTES long.
//
// What it returns is a frozen copy of the fields the chat mirror reads, each
// checked for its type and bounded, never the parsed object: an unknown or
// malformed field is left out (null), so nothing the file holds that the mirror
// did not ask for leaves this module. `name`, `waitingFor` and the former
// names are text Claude Code or the user wrote; they are bounded here and
// redacted by whoever stores them (the mirror model's upsert).
//
//   readSessionState({ pid, sessionId? }) → SessionState | null
//   listSessionPids() → [pid]                 the digits-only <pid>.json names
//   readAllSessionStates() → [SessionState]   every readable one
//
//   SessionState = { pid, sessionId, cwd, procStart, startedAt, version, kind,
//                    entrypoint, status, waitingFor, updatedAt, statusUpdatedAt,
//                    name, formerNames: [{ sessionId, name }] }
//
// `sessionId`, when passed to readSessionState, is a filter: a file that names
// another session answers null. Every other field is null when the file lacks
// it or holds something of the wrong shape (`formerNames` is then []).
//
// A lib/core leaf: it imports fs, path and ./paths, nothing else.

const fs = require('fs');
const path = require('path');
const { userClaudePaths, isSafeId } = require('./paths');

// A sessions file is a few hundred bytes; anything far past that is not one.
const MAX_BYTES = 64 * 1024;

// `<pid>.json`: a positive integer with no leading zero, so a name parsed into a
// number builds back to exactly itself (claudeSessionStateFile is built from the
// number). 16 digits keeps it a safe integer.
const NAME_RE = /^[1-9][0-9]{0,15}\.json$/;

// How the file is opened: never through a link at the last component (ELOOP),
// never waiting on a FIFO with no writer, never adopting a terminal.
const OPEN_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_NONBLOCK || 0)
  | (fs.constants.O_NOCTTY || 0);

// The bounds on what is passed through. Claude Code writes far shorter values.
const PATH_MAX = 4096;
const TEXT_MAX = 300; // name, and each former name
const WAITING_MAX = 200; // waitingFor ("permission prompt", "input needed", …)
const FORMER_MAX = 100; // formerNames entries kept

// A word-shaped value: status (busy|waiting|idle), kind (interactive|bg).
const WORD_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// cli, sdk-cli, sdk-ts, claude-vscode, …
const ENTRYPOINT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
// A version (2.1.287) or a procStart ("Fri Oct  2 04:22:15 2026"): printable
// ASCII only; procStart is parsed by its consumer (lib/core/portfiles).
const VERSION_RE = /^[\x21-\x7e]{1,40}$/;
const PROC_START_RE = /^[\x20-\x7e]{1,64}$/;

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

// A session id as Claude Code writes one (a UUID): the one id grammar of
// lib/core/paths, starting with a letter or a digit.
function sessionIdOf(v) {
  return isSafeId(v) && /^[A-Za-z0-9]/.test(v) ? v : null;
}

const wordOf = (v) => (typeof v === 'string' && WORD_RE.test(v) ? v : null);
const textOf = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0') ? v : null);
const timeOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// An absolute, normalised path with no NUL: what Claude Code records as a cwd.
function cwdOf(v) {
  if (typeof v !== 'string' || !v || v.length > PATH_MAX || v.includes('\0')) return null;
  if (!path.isAbsolute(v) || path.normalize(v) !== v) return null;
  if (v !== path.sep && v.endsWith(path.sep)) return null;
  return v;
}

function formerNamesOf(v) {
  if (!Array.isArray(v)) return Object.freeze([]);
  const out = [];
  const seen = new Set();
  for (const entry of v) {
    if (out.length >= FORMER_MAX) break;
    if (!isPlain(entry)) continue;
    const sessionId = sessionIdOf(entry.sessionId);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push(Object.freeze({ sessionId, name: textOf(entry.name, TEXT_MAX) }));
  }
  return Object.freeze(out);
}

// The fields the mirror reads, from one parsed file, or null when the file is
// not this pid's (a `pid` field naming another process).
function normalize(raw, pid) {
  if (!isPlain(raw)) return null;
  if (raw.pid !== undefined && raw.pid !== pid) return null;
  return Object.freeze({
    pid,
    sessionId: sessionIdOf(raw.sessionId),
    cwd: cwdOf(raw.cwd),
    procStart: typeof raw.procStart === 'string' && PROC_START_RE.test(raw.procStart) ? raw.procStart : null,
    startedAt: timeOf(raw.startedAt),
    version: typeof raw.version === 'string' && VERSION_RE.test(raw.version) ? raw.version : null,
    kind: wordOf(raw.kind),
    entrypoint: typeof raw.entrypoint === 'string' && ENTRYPOINT_RE.test(raw.entrypoint) ? raw.entrypoint : null,
    status: wordOf(raw.status),
    waitingFor: textOf(raw.waitingFor, WAITING_MAX),
    updatedAt: timeOf(raw.updatedAt),
    statusUpdatedAt: timeOf(raw.statusUpdatedAt),
    name: textOf(raw.name, TEXT_MAX),
    formerNames: formerNamesOf(raw.formerNames),
  });
}

// The file's bytes as text, or null: absent, a link, not a regular file,
// hard-linked, too long, or unreadable.
function readFileText(file) {
  let fd;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n <= 0) break;
      got += n;
    }
    return buf.toString('utf8', 0, got);
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// One process's sessions file → SessionState, or null. Never throws.
function readSessionState({ pid, sessionId } = {}) {
  if (!isPid(pid)) return null;
  let file;
  try { file = userClaudePaths().claudeSessionStateFile(pid); } catch { return null; }
  if (!file) return null;
  const text = readFileText(file);
  if (text === null) return null;
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  const state = normalize(raw, pid);
  if (!state) return null;
  if (sessionId !== undefined && sessionId !== null && state.sessionId !== sessionId) return null;
  return state;
}

// The pid of a `<pid>.json` name, or null for any other name.
function pidOfName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const pid = Number(name.slice(0, -'.json'.length));
  return isPid(pid) ? pid : null;
}

// Every `<pid>.json` in the sessions directory, by name alone (nothing is
// opened), ascending. [] when the directory is missing or unreadable.
function listSessionPids() {
  let names;
  try { names = fs.readdirSync(userClaudePaths().sessionsDir); } catch { return []; }
  const pids = [];
  for (const name of names) {
    const pid = pidOfName(name);
    if (pid !== null) pids.push(pid);
  }
  return pids.sort((a, b) => a - b);
}

// Every sessions file that reads as one, ascending by pid.
function readAllSessionStates() {
  const out = [];
  for (const pid of listSessionPids()) {
    const state = readSessionState({ pid });
    if (state) out.push(state);
  }
  return out;
}

module.exports = {
  readSessionState,
  listSessionPids,
  readAllSessionStates,
  pidOfName,
  MAX_BYTES,
};

// lib/server/git-run.js — the one way the daemon runs git (spec §2.7).
//
// Every git process the daemon starts against the user's repository goes
// through here: the per-turn snapshots and diffs of the chat mirror
// (lib/server/mirror/codediff.js), the restore engine built on them
// (lib/server/control/restore.js, U79) and the composer's `@` file index (U57).
// lib/setup/registration.js keeps its own private git helper (a CLI-side read,
// not the daemon's; ruling U95@git-facts).
//
//   runGit(args, {cwd, env, input, encoding = 'utf8' | 'buffer', attrSource,
//                 timeoutMs = 30000, maxBuffer = 32 MiB, signal})
//     → Promise<{stdout, stderr, code}> for ANY exit status (a non-zero code is
//       the caller's to read, never a throw), or rejects with a GitRunError
//       whose .code is one of:
//         'git-missing'  no git binary (ENOENT)
//         'timeout'      killed after timeoutMs
//         'max-buffer'   stdout or stderr outgrew maxBuffer (the child is killed)
//         'aborted'      `signal` aborted, before or during the run
//         'spawn'        anything else that kept the process from running
//   runGit.exclusive(async (git) => …) → what the callback returns
//     holds the queue for a multi-step sequence: `git(args, opts)` runs inside
//     the held slot, and nothing else runs until the callback settles. A
//     snapshot's exclude write, index copy, add and write-tree must never
//     interleave with another snapshot's, here or in U79's restore. Calling the
//     OUTER runGit from inside the callback waits for the slot it holds — a
//     deadlock; use the `git` it hands you.
//   runGit.features() → Promise<{version, attrSource, missing}>
//     from one memoised `git --version`: `version` the dotted number or null,
//     `attrSource` whether this git takes --attr-source (2.40 and newer),
//     `missing` true when there is no git at all.
//   createGitRunner({bin = 'git'}) → a runner with its own queue and the same
//     API (tests: a bin on no PATH proves git-missing; a fake script records
//     its argv and environment).
//
// THE COMMAND LINE. execFile(bin, [...GIT_FLAGS, ('--attr-source=' +
// attrSource)?, ...args]) — never a shell. GIT_FLAGS switch off what a
// repository's own config (or the user's) can make an ordinary command run:
// an fsmonitor hook command, and the LFS filter process. --attr-source sits
// before the subcommand, as git requires.
//
// THE ENVIRONMENT. process.env MINUS every inherited GIT_* variable — a daemon
// started from inside a git hook would otherwise carry GIT_DIR, GIT_INDEX_FILE
// or GIT_WORK_TREE into every call and aim it at the wrong repository — plus
// GIT_OPTIONAL_LOCKS=0 (a read never takes the index lock or refreshes it)
// and GIT_TERMINAL_PROMPT=0 (git never waits on a terminal), plus the
// caller's `env`, which may set GIT_* variables of its own.
//
// ONE AT A TIME. Every call of a runner waits its turn on one FIFO queue: a
// snapshot and the `@` index never race each other for the disk. `input` is
// written to the child's stdin (for -z --stdin lists); stdin is closed either
// way. `signal` aborts through execFile's own option: nothing here signals a
// process by pid. A call whose signal aborts while it is still queued rejects
// at once and never starts.
//
// Dependency direction: lib/server; imports Node only.

const { execFile } = require('child_process');
const fs = require('fs');

const GIT_FLAGS = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.required=false',
]);

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
// --attr-source arrived in git 2.40.
const ATTR_SOURCE_SINCE = Object.freeze([2, 40]);

const GIT_ERROR_CODES = Object.freeze(['git-missing', 'timeout', 'max-buffer', 'aborted', 'spawn']);

class GitRunError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitRunError';
    this.code = code;
  }
}

// The child's environment: inherited GIT_* dropped, the two fixed variables
// set, the caller's last.
function gitEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^GIT_/i.test(k)) continue;
    env[k] = process.env[k];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v === undefined || v === null) delete env[k];
      else env[k] = String(v);
    }
  }
  return env;
}

// '2.50.1 (Apple Git-155)' → {version: '2.50.1', attrSource: true}.
function parseVersion(out) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(out || ''));
  if (!m) return { version: null, attrSource: false };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const attrSource = major > ATTR_SOURCE_SINCE[0] || (major === ATTR_SOURCE_SINCE[0] && minor >= ATTR_SOURCE_SINCE[1]);
  return { version: m[3] === undefined ? `${m[1]}.${m[2]}` : `${m[1]}.${m[2]}.${m[3]}`, attrSource };
}

function abortError() {
  return new GitRunError('aborted', 'git: aborted');
}

// One process, run now. Resolves {stdout, stderr, code}; rejects GitRunError.
function spawnGit(bin, args, opts = {}) {
  const {
    cwd, env, input, encoding = 'utf8', attrSource,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, signal,
  } = opts;
  return new Promise((resolve, reject) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      reject(new GitRunError('spawn', 'git: args must be an array of strings'));
      return;
    }
    if (signal && signal.aborted) { reject(abortError()); return; }
    const full = [...GIT_FLAGS, ...(attrSource ? [`--attr-source=${attrSource}`] : []), ...args];
    const buffer = encoding === 'buffer';
    let child = null;
    // A failure is reported once the child has exited: an abort or a timeout
    // never leaves a git process behind the promise.
    const fail = (e) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) { reject(e); return; }
      child.once('exit', () => reject(e));
    };
    try {
      child = execFile(bin, full, {
        cwd,
        env: gitEnv(env),
        encoding: buffer ? 'buffer' : 'utf8',
        timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
        maxBuffer: Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : DEFAULT_MAX_BUFFER,
        killSignal: 'SIGKILL',
        windowsHide: true,
        ...(signal ? { signal } : {}),
      }, (err, stdout, stderr) => {
        if (!err) { resolve({ stdout, stderr, code: 0 }); return; }
        if (typeof err.code === 'number') { resolve({ stdout, stderr, code: err.code }); return; }
        if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || (signal && signal.aborted)) {
          fail(new GitRunError('aborted', 'git: aborted', { cause: err }));
          return;
        }
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          fail(new GitRunError('max-buffer', 'git: output exceeded maxBuffer', { cause: err }));
          return;
        }
        if (err.code === 'ENOENT') {
          // A missing cwd is reported as ENOENT too: only a missing binary is git-missing.
          let cwdOk = true;
          if (cwd) { try { cwdOk = fs.statSync(cwd).isDirectory(); } catch { cwdOk = false; } }
          reject(cwdOk
            ? new GitRunError('git-missing', `git: no git binary (${bin})`, { cause: err })
            : new GitRunError('spawn', 'git: the working directory does not exist', { cause: err }));
          return;
        }
        if (err.killed) {
          fail(new GitRunError('timeout', `git: timed out after ${timeoutMs} ms`, { cause: err }));
          return;
        }
        fail(new GitRunError('spawn', `git: ${err.code || err.message || 'failed to run'}`, { cause: err }));
      });
    } catch (e) {
      reject(e && e.name === 'AbortError' ? abortError() : new GitRunError('spawn', 'git: failed to start', { cause: e }));
      return;
    }
    if (child.stdin) {
      // A child that exits without reading its stdin must not take the daemon
      // down with an EPIPE.
      child.stdin.on('error', () => {});
      if (input !== undefined && input !== null) child.stdin.end(input);
      else child.stdin.end();
    }
  });
}

function createGitRunner({ bin = 'git' } = {}) {
  let tail = Promise.resolve();
  let featuresPromise = null;

  // Queue a task: it runs when every earlier one has settled. A call whose
  // signal aborts while it waits rejects at once and is skipped.
  function enqueue(task, signal) {
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        reject(abortError());
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const slot = tail.then(async () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (done) return;
        try {
          const v = await task();
          done = true;
          resolve(v);
        } catch (e) {
          done = true;
          reject(e);
        }
      });
      tail = slot.catch(() => {});
    });
  }

  function runGit(args, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    return enqueue(() => spawnGit(bin, args, o), o.signal);
  }

  // The held slot: `git` runs straight away, the queue waits for fn to settle.
  function exclusive(fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('runGit.exclusive: fn must be a function'));
    return enqueue(() => {
      const git = (args, opts = {}) => spawnGit(bin, args, opts && typeof opts === 'object' ? opts : {});
      git.features = () => probe(git);
      return fn(git);
    });
  }

  // One `git --version`, memoised. A missing git is an answer too; any other
  // failure (a timeout under load) is tried again next time.
  function probe(run) {
    if (featuresPromise) return featuresPromise;
    const p = run(['--version'], { timeoutMs: 10000 })
      .then((r) => {
        if (r.code !== 0) return { version: null, attrSource: false, missing: false };
        return { ...parseVersion(r.stdout), missing: false };
      }, (e) => {
        if (e && e.code === 'git-missing') return { version: null, attrSource: false, missing: true };
        featuresPromise = null;
        return { version: null, attrSource: false, missing: false };
      });
    featuresPromise = p;
    return p;
  }

  function features() {
    return probe(runGit);
  }

  runGit.exclusive = exclusive;
  runGit.features = features;
  runGit.bin = bin;
  return runGit;
}

// The daemon's runner: one queue for the whole process.
const runGit = createGitRunner();

module.exports = {
  runGit,
  createGitRunner,
  GitRunError,
  GIT_FLAGS,
  GIT_ERROR_CODES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  parseVersion,
  gitEnv,
};

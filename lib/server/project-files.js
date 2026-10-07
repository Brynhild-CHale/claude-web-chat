// lib/server/project-files.js — the composer's `@` file index (spec §6.2, U57).
//
// What the `@` popover offers and what a message's `files` may name: the
// project's paths, never their content (ruling Q5 — a path is attached, the
// content is Claude's to Read). Nothing here opens a file, follows a link,
// watches the disk, arms a timer or writes a cache: the index lives in memory
// and is rebuilt lazily.
//
//   createProjectFiles({root, ttlMs = TTL_MS, runGit, now = Date.now, limits})
//     → {search(q, {limit}), check(rel), refresh(), stop()}
//
//   search(q, {limit = LIMIT_DEFAULT})
//     → Promise<{files: [{path, bytes}], truncated, source: 'git'|'walk', indexed_at}>
//     Ranked (below), at most `limit` (1..LIMIT_MAX) paths. An index older than
//     ttlMs is rebuilt first; concurrent callers share one build.
//   check(rel)
//     → Promise<{ok: true, path, bytes} | {ok: false, why, category?}>
//     the contract the composer's validation (lib/server/composer.js) and the
//     queue's message route call for each `files` entry. In this order:
//       outside     not a string, empty, absolute, a `..` segment, a backslash,
//                   NUL or any control, bidi or invisible character
//                   (lib/core/text hasForbidden), or lib/core/paths fence null
//       sensitive   lib/core/redact sensitivePath(rel), with its `category`
//                   (every category, `web-chat` and `git` included)
//       missing     nothing there (ENOENT, or after stop())
//       symlink     the path, or a directory on the way to it, is a link
//       not-a-file  a directory, a socket, a fifo, a device
//       ignored     the listing does not hold the path, after at most one
//                   rebuild for that path's miss within ttlMs (so a file made
//                   since the last build is found, and a path that keeps
//                   missing does not make git run again and again)
//   refresh() → Promise   rebuild now (shares a build in flight)
//   stop()                abort a build in flight through runGit's `signal` (the
//                         git runner kills its own child; nothing here signals a
//                         pid) and end a walk; after it a search answers no files
//                         and a check `{ok: false, why: 'missing'}`
//
// THE INDEX. `git -C <root> ls-files -z --cached --others --exclude-standard`
// through lib/server/git-run (the one git runner: it queues behind a snapshot
// of the diff engine and adds the fsmonitor and LFS overrides). Over its
// buffer: the same call with --cached only, `truncated: true`. Not a
// repository (a non-zero exit) or no git: a bounded walk (fs.promises.opendir;
// depth ≤ WALK_MAX_DEPTH path segments, ≤ WALK_MAX_ENTRIES entries read,
// ≤ WALK_MAX_MS; a symlink is never followed and never listed; the WALK_SKIP
// directories are not entered). A git that timed out or failed to start is not
// a reason to walk — a walk knows no ignore rules and would offer what the
// repository ignores — so that build keeps the previous listing (or none),
// truncated. Then every path sensitivePath() names is dropped, as is any path
// check() would refuse as `outside` by its spelling, and at most MAX_PATHS are
// kept.
//
// THE TYPE FILTER (§6.2: not a regular file, or a symlink, is never offered)
// runs at search time, not at build time, so a rebuild costs no lstat per
// path: search lstat()s only the ranked candidates it is about to return
// (bytes come from that lstat), skips any that is not a regular file or is
// reached through a link, and back-fills from the next candidates, with at
// most 4 × limit extra lstats a search (notes-D, decision 2: only the moment
// of filtering moves, never what is offered).
//
// RANKING. Case-insensitive; q split on whitespace and every token must
// match; each token scores its best class (SCORE below), and a path's score is
// the sum less path.length / 100; ties by path. An empty q answers the
// shallowest paths (fewest '/', then path order).
//
// Dependency direction: lib/server; imports lib/core and ./git-run.

const fs = require('fs');
const path = require('path');
const { runGit: moduleRunGit } = require('./git-run');
const { fence, realpath } = require('../core/paths');
const { sensitivePath } = require('../core/redact');
const { hasForbidden } = require('../core/text');

const TTL_MS = 15000;
const MAX_PATHS = 100000;
const WALK_MAX_DEPTH = 12;
const WALK_MAX_ENTRIES = 20000;
const WALK_MAX_MS = 1500;
const Q_MAX = 200;
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;
// How many extra lstats a search may spend back-filling, per path asked for.
const BACKFILL_FACTOR = 4;

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

// The ranking classes, best first (§6.2).
const SCORE = Object.freeze({
  EXACT_BASENAME: 100,
  BASENAME_PREFIX: 80,
  BASENAME_SUBSTRING: 60,
  SEGMENT_PREFIX: 40,
  PATH_SUBSTRING: 30,
  SUBSEQUENCE: 10,
});
// A path's score loses path.length / LENGTH_DIVISOR: the shorter path wins.
const LENGTH_DIVISOR = 100;

// Directories the walk never enters (it has no ignore rules to read).
const WALK_SKIP = Object.freeze([
  '.git', 'node_modules', '.web-chat', 'dist', 'build', 'out', '.next', '.nuxt', 'target',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo', '.parcel-cache',
]);
const WALK_SKIP_SET = new Set(WALK_SKIP);

const LIMITS = Object.freeze({ MAX_PATHS, WALK_MAX_DEPTH, WALK_MAX_ENTRIES, WALK_MAX_MS });

const LS_FILES = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
const LS_FILES_CACHED = ['ls-files', '-z', '--cached'];

// A relative POSIX path's spelling, before the filesystem is asked anything:
// the `outside` half of check() that needs no disk.
function badSpelling(rel) {
  if (typeof rel !== 'string' || rel === '') return true;
  if (rel.startsWith('/') || rel.includes('\\') || hasForbidden(rel)) return true;
  if (path.isAbsolute(rel)) return true;
  return rel.split('/').includes('..');
}

// One listed path, with what ranking reads precomputed.
function entryOf(p) {
  const lower = p.toLowerCase();
  const slash = lower.lastIndexOf('/');
  const base = slash === -1 ? lower : lower.slice(slash + 1);
  let depth = 0;
  for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === 47) depth++;
  return { path: p, lower, base, depth };
}

function isSubsequence(tok, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < tok.length; j++) if (s[j] === tok[i]) i++;
  return i === tok.length;
}

// The best class one token reaches in one entry, or 0 for no match.
function tokenScore(tok, e) {
  if (e.base === tok) return SCORE.EXACT_BASENAME;
  if (e.base.startsWith(tok)) return SCORE.BASENAME_PREFIX;
  if (e.base.includes(tok)) return SCORE.BASENAME_SUBSTRING;
  if (e.lower.startsWith(tok) || e.lower.includes(`/${tok}`)) return SCORE.SEGMENT_PREFIX;
  if (e.lower.includes(tok)) return SCORE.PATH_SUBSTRING;
  if (isSubsequence(tok, e.lower)) return SCORE.SUBSEQUENCE;
  return 0;
}

// The entry's score for every token, or null when a token does not match.
function scoreOf(tokens, e) {
  let sum = 0;
  for (const tok of tokens) {
    const s = tokenScore(tok, e);
    if (!s) return null;
    sum += s;
  }
  return sum - e.path.length / LENGTH_DIVISOR;
}

function tokensOf(q) {
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// Better first: higher score, then path order.
function better(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  return a.path < b.path;
}

// The best `k` entries for `tokens`, in rank order, without sorting every match.
function topK(entries, tokens, k) {
  const top = [];
  for (const e of entries) {
    const score = scoreOf(tokens, e);
    if (score === null) continue;
    const c = { path: e.path, score };
    if (top.length === k && !better(c, top[k - 1])) continue;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (better(c, top[mid])) hi = mid; else lo = mid + 1;
    }
    top.splice(lo, 0, c);
    if (top.length > k) top.pop();
  }
  return top.map((c) => c.path);
}

function shallowFirst(a, b) {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function createProjectFiles({ root, ttlMs = TTL_MS, runGit = moduleRunGit, now = Date.now, limits } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('createProjectFiles: root must be a path');
  if (typeof runGit !== 'function') throw new TypeError('createProjectFiles: runGit must be a function');
  const ROOT = path.resolve(root);
  const lim = { ...LIMITS, ...(limits && typeof limits === 'object' ? limits : {}) };
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : TTL_MS;

  // The current index: {entries, set, byDepth, truncated, source, indexed_at}.
  let index = null;
  let building = null;
  let stopped = false;
  const controller = new AbortController();
  // Paths whose check missed the listing, and when: a second miss within the
  // TTL answers `ignored` without another rebuild.
  const missed = new Map();
  const MISSED_MAX = 1000;

  // The listing git gives, or null when the walk should run instead.
  async function fromGit() {
    const opts = { timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, signal: controller.signal };
    let r;
    let truncated = false;
    try {
      r = await runGit(['-C', ROOT, ...LS_FILES], opts);
    } catch (e) {
      if (e && e.code === 'git-missing') return null;
      if (!(e && e.code === 'max-buffer')) throw e;
      truncated = true;
      r = await runGit(['-C', ROOT, ...LS_FILES_CACHED], opts);
    }
    if (!r || r.code !== 0) return truncated ? { paths: [], truncated } : null;
    const out = typeof r.stdout === 'string' ? r.stdout : String(r.stdout || '');
    return { paths: out.split('\0').filter(Boolean), truncated };
  }

  // The bounded walk: regular files only, no link followed or listed.
  async function walk() {
    const paths = [];
    const started = now();
    let entries = 0;
    let truncated = false;
    const over = () => {
      if (stopped) return true;
      if (entries >= lim.WALK_MAX_ENTRIES || now() - started > lim.WALK_MAX_MS) { truncated = true; return true; }
      return false;
    };
    // Depth-first over a stack of [absolute dir, relative prefix, depth of its entries].
    const stack = [[ROOT, '', 1]];
    while (stack.length && !over()) {
      const [dir, prefix, depth] = stack.pop();
      let handle;
      try { handle = await fs.promises.opendir(dir); } catch { continue; }
      try {
        for await (const ent of handle) {
          if (over()) break;
          entries++;
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          if (ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (WALK_SKIP_SET.has(ent.name)) continue;
            if (depth >= lim.WALK_MAX_DEPTH) { truncated = true; continue; }
            stack.push([path.join(dir, ent.name), rel, depth + 1]);
          } else if (ent.isFile()) {
            paths.push(rel);
          }
        }
      } catch {
        // A directory that vanished mid-read: what was read stands.
      }
      // `for await` closes the handle when the loop ends or breaks.
    }
    return { paths, truncated };
  }

  async function build() {
    let listing = null;
    let source = 'git';
    try {
      listing = await fromGit();
    } catch (e) {
      // Aborted (stop), timed out, failed to start: keep what is known.
      if (stopped || !index) return { entries: [], set: new Set(), byDepth: [], truncated: true, source, indexed_at: now() };
      return { ...index, truncated: true, indexed_at: now() };
    }
    if (!listing) {
      source = 'walk';
      listing = await walk();
    }
    const seen = new Set();
    const entries = [];
    let truncated = listing.truncated;
    for (const p of listing.paths) {
      if (seen.has(p)) continue; // an unmerged path is listed once per stage
      seen.add(p);
      if (badSpelling(p) || sensitivePath(p) !== null) continue;
      if (entries.length >= lim.MAX_PATHS) { truncated = true; break; }
      entries.push(entryOf(p));
    }
    return {
      entries,
      set: new Set(entries.map((e) => e.path)),
      byDepth: null, // sorted on the first empty query
      truncated,
      source,
      indexed_at: now(),
    };
  }

  function rebuild() {
    if (stopped) return Promise.resolve(null);
    if (building) return building;
    const p = build().then((next) => {
      if (!stopped) index = next;
      return stopped ? null : index;
    }, () => (stopped ? null : index)).finally(() => {
      if (building === p) building = null;
    });
    building = p;
    return p;
  }

  function fresh() {
    if (stopped) return Promise.resolve(null);
    if (index && now() - index.indexed_at <= ttl) return Promise.resolve(index);
    return rebuild();
  }

  // lstat one path (its spelling already checked): its size when it is a
  // regular file reached through no link, else why not. A directory on the way
  // that is a link counts as a link: the path's realpath must be the root's
  // realpath joined to the path as spelled.
  async function typeOf(rel, realRoot) {
    const a = path.join(ROOT, ...rel.split('/'));
    let st;
    try {
      st = await fs.promises.lstat(a);
    } catch {
      return { why: 'missing' };
    }
    if (st.isSymbolicLink()) return { why: 'symlink' };
    if (!st.isFile()) return { why: 'not-a-file' };
    const real = realpath(a);
    if (!realRoot || !real || real !== path.join(realRoot, ...rel.split('/'))) return { why: 'symlink' };
    return { bytes: st.size };
  }

  function emptyAnswer() {
    return { files: [], truncated: false, source: index ? index.source : 'git', indexed_at: index ? index.indexed_at : null };
  }

  async function search(q, { limit = LIMIT_DEFAULT } = {}) {
    const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), LIMIT_MAX) : LIMIT_DEFAULT;
    const idx = await fresh();
    if (!idx || stopped) return emptyAnswer();
    const budget = n + BACKFILL_FACTOR * n;
    const tokens = tokensOf(typeof q === 'string' ? q.slice(0, Q_MAX) : '');
    let candidates;
    if (!tokens.length) {
      if (!idx.byDepth) idx.byDepth = idx.entries.slice().sort(shallowFirst);
      candidates = idx.byDepth.slice(0, budget).map((e) => e.path);
    } else {
      candidates = topK(idx.entries, tokens, budget);
    }
    const files = [];
    const realRoot = realpath(ROOT);
    for (const p of candidates) {
      if (files.length >= n || stopped) break;
      const t = await typeOf(p, realRoot);
      if (t.bytes !== undefined) files.push({ path: p, bytes: t.bytes });
    }
    if (stopped) return emptyAnswer();
    return { files, truncated: idx.truncated, source: idx.source, indexed_at: idx.indexed_at };
  }

  async function check(rel) {
    if (stopped) return { ok: false, why: 'missing' };
    if (badSpelling(rel) || !fence(ROOT, rel)) return { ok: false, why: 'outside' };
    const category = sensitivePath(rel);
    if (category !== null) return { ok: false, why: 'sensitive', category };
    const t = await typeOf(rel, realpath(ROOT));
    if (stopped) return { ok: false, why: 'missing' };
    if (t.bytes === undefined) return { ok: false, why: t.why };
    const before = index;
    let idx = await fresh();
    if (stopped || !idx) return { ok: false, why: 'missing' };
    if (!idx.set.has(rel)) {
      const at = missed.get(rel);
      if (at !== undefined && now() - at <= ttl) return { ok: false, why: 'ignored' };
      if (missed.size >= MISSED_MAX) missed.clear();
      missed.set(rel, now());
      // The listing just read is the rebuild this miss may have.
      if (idx !== before) return { ok: false, why: 'ignored' };
      idx = await rebuild();
      if (stopped || !idx) return { ok: false, why: 'missing' };
      if (!idx.set.has(rel)) return { ok: false, why: 'ignored' };
    }
    missed.delete(rel);
    return { ok: true, path: rel, bytes: t.bytes };
  }

  async function refresh() {
    await rebuild();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    index = null;
    missed.clear();
    controller.abort();
  }

  return { search, check, refresh, stop };
}

module.exports = {
  createProjectFiles,
  WALK_SKIP,
  TTL_MS,
  MAX_PATHS,
  WALK_MAX_DEPTH,
  WALK_MAX_ENTRIES,
  WALK_MAX_MS,
  Q_MAX,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  BACKFILL_FACTOR,
  GIT_TIMEOUT_MS,
  GIT_MAX_BUFFER,
  SCORE,
  LENGTH_DIVISOR,
};

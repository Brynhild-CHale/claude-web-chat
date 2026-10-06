// lib/server/mirror/codediff.js — per-turn code diffs (spec §2.7, Q-D), and the
// snapshot engine the code revert stands on (§15.3, C44).
//
// Two layers.
//
// (1) THE SHADOW STORE — createShadowStore({root, paths, runGit, now, log,
//     limits}). A bare repository at paths.mirrorGit (.web-chat/mirror/git/)
//     whose objects/info/alternates names the project's own object store, so a
//     snapshot of the working tree writes only the blobs the project does not
//     have yet. It never writes the project's .git (objects, index, HEAD, refs,
//     config), and nothing here runs gc, repack, checkout, reset, stash or
//     commit. Every git call goes through lib/server/git-run.js. U79's
//     lib/server/control/restore.js builds on this layer; its answers:
//
//     init(run = runGit) → Promise<{ok: true, ...info()} | {ok: false, reason}>
//         memoised (one probe per store). LAZY: nothing calls it before the
//         first fresh turn, so a daemon whose turns never open spawns no git.
//         reason: 'git-missing' | 'not-a-git-repo' | 'init-failed'. Inside a
//         slot you hold, pass its `git` (snapshot({git}) does).
//     info() → null before a successful init, else (frozen)
//         { toplevel, commonDir, indexFile, prefix, shadow, objectFormat:
//           'sha1'|'sha256', emptyTree, attrSource: bool, version }
//         `prefix` is the root relative to the toplevel, '' or 'sub/dir/'.
//     env(indexFile) → { GIT_DIR: shadow, GIT_WORK_TREE: toplevel,
//           GIT_INDEX_FILE: indexFile, GIT_LITERAL_PATHSPECS: '1' }
//         (without GIT_WORK_TREE/GIT_INDEX_FILE when indexFile is null). A
//         pathspec is relative to the cwd: every call that sets GIT_WORK_TREE
//         runs with cwd = info().toplevel, never the root.
//     gitArgs(...args) → ['-c', 'core.autocrlf=false', '-c',
//           'core.attributesFile=/dev/null', ...args]: the config every
//         snapshot, diff and restore call carries (ruling U43-U79@core-autocrlf),
//         with attrSource: info().emptyTree on the call when info().attrSource.
//     pathspec() → ['--', prefix || '.'] (literal: GIT_LITERAL_PATHSPECS)
//     snapshot({git, signal} = {}) → Promise<
//           {ok: true, tree, at, duration_ms, attr_exact,
//            excluded: {large: [path], sensitive: [{path, size, mtime}]}}
//         | {ok: false, reason}>
//         Runs inside runGit.exclusive, or inside the caller's held slot when
//         handed its `git`. reason: an init reason, 'index-too-large',
//         'too-many-untracked', 'snapshot-failed' (any git failure inside: an
//         untracked embedded repository with no commit makes `add -A` fail
//         until U79 excludes them), 'aborted'. Never throws.
//     diff(a, b, {context = 3, withPatch = true, signal} = {}) → Promise<
//           {ok: true, files: [{path, status: 'A'|'M'|'D'|'T', additions,
//            deletions, binary, patch?}], patch_complete}
//         | {ok: false, reason}>
//         `patch` is that file's UNREDACTED `git diff` section, in process only:
//         the codediff source redacts every hunk before anything is written.
//     treeExists(tree) → Promise<bool>     `cat-file -e <tree>^{tree}`; trees are
//                                          pruned after 7 days
//     emptyTree() → the empty tree's id, or null before init
//     housekeep() → Promise<{ok, full}>    tmp emptied, `git prune
//                                          --expire=7.days.ago` in the shadow, old
//                                          records deleted, the size measured
//     limits                               the store's limits, frozen
//
//     THE QUEUE. snapshot() holds runGit.exclusive for its whole sequence, or
//     runs inside the caller's held slot when handed `git`. diff, treeExists and
//     housekeep queue on runGit one call at a time: never call them from inside
//     a slot you hold (the queue waits for that slot — a deadlock).
//
//     Every path the store answers (files[].path, excluded) is relative to the
//     ROOT; info().prefix rejoins it to the toplevel.
//
//     A SNAPSHOT, the Q-D sequence: (a) a project index over MAX_INDEX_BYTES →
//     'index-too-large'; (b) the index copied to paths.mirrorTmp/index-<pid>-<n>
//     with the project index's atime and mtime (Q-D fix 1: git trusts a cached
//     stat unless the entry is racy against the index file's own mtime, and a
//     fresh mtime hid same-second same-size edits); (c) the shadow's
//     info/exclude written as the project's own plus `/<prefix>.web-chat/`,
//     .web-chat/ dropped from the copy, then the untracked files listed: over
//     MAX_UNTRACKED → 'too-many-untracked'; a file over LARGE_UNTRACKED_BYTES and
//     one sensitivePath() withholds are excluded (a sensitive one never enters
//     the shadow store); (d) info/exclude rewritten with every excluded path,
//     anchored and glob-escaped; (e) `add -A` and `write-tree` with
//     --attr-source=<empty tree> and core.autocrlf=false (Q-D fix 2: a blob is
//     the bytes on disk); (f) the copy removed. A git without --attr-source
//     (older than 2.40) still snapshots, and says attr_exact: false.
//
// (2) THE SOURCE — createCodediffSource({shadow, runGit, enabled, limits}) →
//     {attach(engine)}: the mirror source (lib/server/mirror/index.js, the
//     source contract) that snapshots each live turn before and after, writes
//     one redacted record per turn (paths.mirrorDiff(turnId)), moves the turn
//     header's `code` pending → ready, and answers the facade's diff(q).
//     `shadow` is a store, or (engine) → store; `enabled` defaults to
//     WEB_CHAT_MIRROR_DIFFS !== '0', read when the source attaches. Disabled,
//     attach answers {start, stop} with NO api, so the facade's capabilities
//     read turn_diff and node_diff false, and nothing is patched.
//
//     BEFORE: onTurnOpened for a FRESH turn (started_at within FRESH_MS of now;
//     a catch-up replays history through the same hook, and those turns keep
//     code null): a snapshot in flight that started under REUSE_MS earlier is
//     reused, else one is taken (before.source 'turn-open'); if it fails, the
//     conversation's previous after-tree stands in ('previous-turn-close').
//     AFTER: onTurnClosed, fresh, with a before, having run a tool: code
//     pending, a snapshot, the record, code ready {files, additions,
//     deletions} (or unavailable {reason}), then live.noteActivity(cid,
//     ended_at, 'code') so the bar's last turn reads the totals at once. A turn
//     that ran no tool gets nothing; its before stands as its after.
//     The record is §2.7's shape (no `head` key: ruling U43-U79@head-on-record
//     is held). Off for the daemon's life on 'not-a-git-repo', 'git-missing',
//     'shadow-store-full' and 'slow-repo' (the SLOW_SNAPSHOTS-th snapshot over
//     SLOW_SNAPSHOT_MS): every fresh closed turn that ran a tool then reads
//     code {status: 'unavailable', reason} and has no record.
//
// Dependency direction: lib/server; imports lib/core, ../git-run and
// ../domain/refs.

const fs = require('fs');
const path = require('path');
const { runGit: defaultRunGit } = require('../git-run');
const { writeJsonAtomic, readJson } = require('../../core/fsjson');
const { realpath, redactHostPaths } = require('../../core/paths');
const { sensitivePath, WITHHOLD_CATEGORIES } = require('../../core/redact');
const { resolveNodeRef } = require('../domain/refs');

const KiB = 1024;
const MiB = 1024 * KiB;

// Every limit, overridable through `limits` (tests need no 5 s or 8 MiB).
const LIMITS = Object.freeze({
  LARGE_UNTRACKED_BYTES: 8 * MiB,
  MAX_UNTRACKED: 5000,
  MAX_INDEX_BYTES: 20 * MiB,
  SLOW_SNAPSHOT_MS: 5000,
  SLOW_SNAPSHOTS: 2,
  PATCH_MAX: 512 * KiB,
  PATCH_FILE_MAX: 128 * KiB,
  RECORD_MAX_DAYS: 30,
  PRUNE_EXPIRE: '7.days.ago',
  SHADOW_MAX_BYTES: 1024 * MiB,
  REUSE_MS: 1000,
  FRESH_MS: 5000,
  RETURN_MAX: 200,
  // TEST-ONLY. false skips the snapshot's utimesSync (Q-D fix 1), which only
  // the regression half of that fix's test sets; nothing in lib/ ever does.
  keepIndexTimes: true,
});

// A graceful shutdown cuts a source's stop at this (U22a's hand-off).
const MIRROR_STOP_TIMEOUT_MS = 2000;

// The toolKind heads (lib/core/tool-input.js) of the tools that never write:
// Read, Grep, Glob, WebFetch, WebSearch, TodoWrite, TaskStop, AskUserQuestion
// and ExitPlanMode. Compared with the envelope's tool.kind, never a tool name.
const READ_ONLY_KINDS = Object.freeze(['Read', 'Grep', 'Glob', 'Web', 'Search', 'Todo', 'Stop', 'Question', 'Plan']);
const READ_ONLY = new Set(READ_ONLY_KINDS);

const WITHHOLD = new Set(WITHHOLD_CATEGORIES);
const OFF_REASONS = new Set(['not-a-git-repo', 'git-missing', 'shadow-store-full', 'slow-repo']);
const TREE_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEFAULT_CONTEXT = 3;
const CONTEXT_MAX = 100;
const TURNS_MAX = 1000;

// The config every snapshot, diff and restore call carries: no line-ending
// conversion from the user's core.autocrlf, and no attributes from a global
// attributes file (the worktree's are replaced by --attr-source).
const SNAPSHOT_CONFIG = Object.freeze(['-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null']);

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isSensitive = (p) => WITHHOLD.has(sensitivePath(p));

// A path as a gitignore line matches it and nothing else: anchored at the
// toplevel, its glob characters escaped. null when no line can say it.
function excludeLine(p) {
  if (typeof p !== 'string' || !p || /[\r\n]/.test(p)) return null;
  let s = p.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
  s = s.replace(/ +$/, (m) => m.replace(/ /g, '\\ '));
  return `/${s}`;
}

// `git diff` section header → the path (no renames: a/<p> b/<p>).
function headerPath(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    return m ? unquoteC(m[1]).replace(/^a\//, '') : null;
  }
  const len = (rest.length - 5) / 2;
  if (!Number.isInteger(len) || len < 1) return null;
  const a = rest.slice(2, 2 + len);
  return rest.startsWith('a/') && rest.slice(2 + len) === ` b/${a}` ? a : null;
}

// git's C-style quoting, undone (octal escapes are UTF-8 bytes).
function unquoteC(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { bytes.push(...Buffer.from(c, 'utf8')); continue; }
    const n = s[++i];
    const map = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 };
    if (n in map) bytes.push(map[n]);
    else if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(...Buffer.from(n || '', 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

// A string cut to at most `max` bytes, at a line end when there is one.
function cutBytes(s, max) {
  if (Buffer.byteLength(s) <= max) return { text: s, cut: false };
  let t = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
  if (t.endsWith('�')) t = t.slice(0, -1);
  const nl = t.lastIndexOf('\n');
  if (nl > 0) t = t.slice(0, nl + 1);
  return { text: t, cut: true };
}

// ── (1) the shadow store ─────────────────────────────────────────────────────

function createShadowStore({ root, paths, runGit = defaultRunGit, now = Date.now, log = () => {}, limits = {} } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('createShadowStore: root is required');
  if (!paths || typeof paths.mirrorGit !== 'string') throw new TypeError('createShadowStore: paths (lib/core/paths projectPaths) is required');
  if (typeof runGit !== 'function' || typeof runGit.exclusive !== 'function') throw new TypeError('createShadowStore: runGit (lib/server/git-run) is required');
  const L = { ...LIMITS, ...(isPlain(limits) ? limits : {}) };
  const shadow = paths.mirrorGit;
  let initPromise = null;
  let info = null;
  let copies = 0;

  const say = (m) => { try { log(m); } catch { /* a logger never breaks the store */ } };

  function env(indexFile) {
    if (!info) return null;
    const e = { GIT_DIR: shadow, GIT_LITERAL_PATHSPECS: '1' };
    if (indexFile) { e.GIT_WORK_TREE = info.toplevel; e.GIT_INDEX_FILE = indexFile; }
    return e;
  }
  const gitArgs = (...args) => [...SNAPSHOT_CONFIG, ...args];
  const pathspec = () => ['--', info && info.prefix ? info.prefix : '.'];
  const attr = () => (info && info.attrSource ? info.emptyTree : undefined);

  // `run` is the runner init's calls go through: the store's runGit, or the
  // `git` of a slot the caller holds (snapshot({git})), which the queue would
  // otherwise make init wait for — a deadlock.
  function init(run = runGit) {
    if (!initPromise) initPromise = doInit(run).catch((e) => {
      say(`codediff: init failed (${(e && e.code) || 'error'})`);
      return { ok: false, reason: e && e.code === 'git-missing' ? 'git-missing' : 'init-failed' };
    });
    return initPromise;
  }

  async function doInit(run) {
    const feats = typeof run.features === 'function' ? await run.features() : { version: null, attrSource: false, missing: false };
    if (feats.missing) return { ok: false, reason: 'git-missing' };
    // Where the project's repository is. --path-format arrived in 2.31; an older
    // git answers relative paths, made absolute against the root.
    let r = await run(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel', '--git-path', 'index'], { cwd: root });
    let lines = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
    if (!lines || lines.length < 3) {
      r = await run(['rev-parse', '--git-common-dir', '--show-toplevel', '--git-path', 'index'], { cwd: root });
      lines = r.code === 0 ? r.stdout.split('\n').filter(Boolean).map((l) => path.resolve(root, l)) : null;
    }
    if (!lines || lines.length < 3) return { ok: false, reason: 'not-a-git-repo' };
    const [commonDir, toplevelRaw, indexFile] = lines;
    const toplevel = realpath(toplevelRaw) || toplevelRaw;
    const rootReal = realpath(root) || root;
    const rel = path.relative(toplevel, rootReal);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'not-a-git-repo' };
    const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
    // The hash: an option from git 2.29; a failure, or any other answer, is sha1.
    let objectFormat = 'sha1';
    try {
      const f = await run(['rev-parse', '--show-object-format'], { cwd: root });
      if (f.code === 0 && f.stdout.trim() === 'sha256') objectFormat = 'sha256';
    } catch (e) {
      if (e && e.code === 'git-missing') throw e;
    }
    // The shadow, once. No templates: nothing of the user's init.templateDir
    // (hooks included) is copied in.
    if (!fs.existsSync(path.join(shadow, 'HEAD'))) {
      fs.mkdirSync(path.dirname(shadow), { recursive: true });
      const args = ['init', '--bare', '-q', '--template='];
      if (objectFormat === 'sha256') args.push('--object-format=sha256');
      args.push(shadow);
      const i = await run(args, { cwd: path.dirname(shadow) });
      if (i.code !== 0) return { ok: false, reason: 'init-failed' };
    }
    fs.mkdirSync(path.join(shadow, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(shadow, 'info'), { recursive: true });
    // Alternates: a path RELATIVE to the shadow's objects/ (never the home
    // directory written into .web-chat/, §11.10).
    const from = realpath(path.join(shadow, 'objects')) || path.join(shadow, 'objects');
    const to = realpath(path.join(commonDir, 'objects')) || path.join(commonDir, 'objects');
    fs.writeFileSync(path.join(shadow, 'objects', 'info', 'alternates'), `${path.relative(from, to).split(path.sep).join('/')}\n`);
    const e = await run(['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd: path.dirname(shadow), env: { GIT_DIR: shadow }, input: '' });
    const emptyTree = e.code === 0 ? e.stdout.trim() : '';
    if (!TREE_RE.test(emptyTree)) return { ok: false, reason: 'init-failed' };
    info = Object.freeze({
      toplevel, commonDir, indexFile, prefix, shadow, objectFormat, emptyTree,
      attrSource: feats.attrSource === true, version: feats.version,
    });
    return { ok: true, ...info };
  }

  function projectExclude() {
    try { return fs.readFileSync(path.join(info.commonDir, 'info', 'exclude'), 'utf8'); } catch { return ''; }
  }
  function writeExclude(text) {
    fs.writeFileSync(path.join(shadow, 'info', 'exclude'), text);
  }

  async function snapshot({ git = null, signal = null } = {}) {
    const t0 = now();
    let inf;
    try { inf = await init(git || runGit); } catch { inf = { ok: false, reason: 'init-failed' }; }
    if (!inf.ok) return { ok: false, reason: inf.reason };
    if (signal && signal.aborted) return { ok: false, reason: 'aborted' };
    const steps = (g) => takeSnapshot(g, t0, signal);
    try {
      return git ? await steps(git) : await runGit.exclusive(steps);
    } catch (e) {
      if (e && e.code === 'aborted') return { ok: false, reason: 'aborted' };
      say(`codediff: snapshot failed (${(e && e.code) || 'error'})`);
      return { ok: false, reason: 'snapshot-failed' };
    }
  }

  async function takeSnapshot(git, t0, signal) {
    const o = (extra) => ({ cwd: info.toplevel, signal: signal || undefined, ...extra });
    // (a) the index's size.
    let st = null;
    try { st = fs.statSync(info.indexFile); } catch { st = null; }
    if (st && st.size > L.MAX_INDEX_BYTES) return { ok: false, reason: 'index-too-large' };
    // (b) the copy, with the index's own times.
    fs.mkdirSync(paths.mirrorTmp, { recursive: true });
    copies += 1;
    const copy = path.join(paths.mirrorTmp, `index-${process.pid}-${copies}`);
    try {
      if (st) {
        fs.copyFileSync(info.indexFile, copy);
        if (L.keepIndexTimes !== false) fs.utimesSync(copy, st.atimeMs / 1000, st.mtimeMs / 1000);
      }
      const e = env(copy);
      // (c) the base exclude, .web-chat/ out of the copy, the untracked files.
      const base = `${projectExclude().replace(/\n?$/, '\n')}${excludeLine(`${info.prefix}.web-chat`)}/\n`;
      writeExclude(base);
      if (st) {
        // -f: the shadow has no HEAD, so unforced rm counts every entry as
        // staged and refuses one whose worktree bytes differ (a committed
        // .web-chat/theme.json the daemon rewrote). It touches only the copy.
        const rm = await git(gitArgs('rm', '--cached', '-f', '-r', '-q', '--ignore-unmatch', '--', `${info.prefix}.web-chat`), o({ env: e }));
        if (rm.code !== 0) return { ok: false, reason: 'snapshot-failed' };
      }
      const ls = await git(gitArgs('ls-files', '--others', '--exclude-standard', '-z', ...pathspec()), o({ env: e }));
      if (ls.code !== 0) return { ok: false, reason: 'snapshot-failed' };
      const untracked = ls.stdout.split('\0').filter(Boolean);
      if (untracked.length > L.MAX_UNTRACKED) return { ok: false, reason: 'too-many-untracked' };
      const large = [];
      const sensitive = [];
      const lines = [];
      for (const top of untracked) {
        const rel = info.prefix && top.startsWith(info.prefix) ? top.slice(info.prefix.length) : top;
        const sens = isSensitive(top) || isSensitive(rel);
        let s = null;
        try { s = fs.lstatSync(path.join(info.toplevel, top)); } catch { s = null; }
        if (!sens && !(s && s.size > L.LARGE_UNTRACKED_BYTES)) continue;
        const line = excludeLine(top);
        if (!line) return { ok: false, reason: 'snapshot-failed' };
        lines.push(line);
        if (sens) sensitive.push({ path: rel, size: s ? s.size : null, mtime: s ? s.mtimeMs : null });
        else large.push(rel);
      }
      // (d) every excluded path into the shadow's exclude.
      if (lines.length) writeExclude(`${base}${lines.join('\n')}\n`);
      // (e) add and write-tree, byte for byte.
      const add = await git(gitArgs('add', '-A', ...pathspec()), o({ env: e, attrSource: attr() }));
      if (add.code !== 0) return { ok: false, reason: 'snapshot-failed' };
      const wt = await git(gitArgs('write-tree'), o({ env: e, attrSource: attr() }));
      const tree = wt.code === 0 ? wt.stdout.trim() : '';
      if (!TREE_RE.test(tree)) return { ok: false, reason: 'snapshot-failed' };
      return {
        ok: true, tree, at: t0, duration_ms: Math.max(0, now() - t0), attr_exact: info.attrSource,
        excluded: { large, sensitive },
      };
    } finally {
      // (f) the copy goes, whatever happened.
      try { fs.rmSync(copy, { force: true }); } catch { /* best effort; housekeeping empties tmp */ }
    }
  }

  // Strip the prefix from a toplevel-relative path.
  const rootRel = (p) => (info && info.prefix && p.startsWith(info.prefix) ? p.slice(info.prefix.length) : p);

  async function diff(a, b, { context = DEFAULT_CONTEXT, withPatch = true, signal = null } = {}) {
    const inf = await init();
    if (!inf.ok) return { ok: false, reason: inf.reason };
    if (!TREE_RE.test(a) || !TREE_RE.test(b)) return { ok: false, reason: 'bad-tree' };
    const ctx = Number.isInteger(context) && context >= 0 && context <= CONTEXT_MAX ? context : DEFAULT_CONTEXT;
    const o = (extra) => ({ cwd: info.toplevel, env: env(null), attrSource: attr(), signal: signal || undefined, ...extra });
    let raw;
    try {
      raw = await runGit(gitArgs('diff-tree', '-r', '--no-renames', '-z', '--raw', '--numstat', a, b, ...pathspec()), o());
    } catch (e) {
      return { ok: false, reason: e && e.code === 'aborted' ? 'aborted' : 'diff-failed' };
    }
    if (raw.code !== 0) return { ok: false, reason: 'diff-failed' };
    const byPath = new Map();
    const order = [];
    const tokens = raw.stdout.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      if (tok.startsWith(':')) {
        const p = tokens[++i];
        if (p === undefined) break;
        const status = tok.trim().split(/\s+/).pop().charAt(0);
        if (!byPath.has(p)) { byPath.set(p, { path: rootRel(p), status, additions: 0, deletions: 0, binary: false }); order.push(p); }
        continue;
      }
      const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tok);
      if (!m) continue;
      const f = byPath.get(m[3]);
      if (!f) continue;
      if (m[1] === '-' || m[2] === '-') f.binary = true;
      else { f.additions += Number(m[1]); f.deletions += Number(m[2]); }
    }
    let patchComplete = true;
    if (withPatch && order.length) {
      let r = null;
      try {
        r = await runGit(gitArgs('-c', 'core.quotePath=false', 'diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv',
          '--src-prefix=a/', '--dst-prefix=b/', `-U${ctx}`, a, b, ...pathspec()), o());
      } catch (e) {
        if (e && e.code === 'aborted') return { ok: false, reason: 'aborted' };
        r = null;
      }
      if (r && r.code === 0) {
        let cur = null;
        for (const line of r.stdout.split(/(?<=\n)/)) {
          if (line.startsWith('diff --git ')) {
            const p = headerPath(line.replace(/\n$/, ''));
            cur = p !== null && byPath.has(p) ? byPath.get(p) : null;
            if (cur) cur.patch = (cur.patch || '') + line;
            else patchComplete = false;
            continue;
          }
          if (cur) cur.patch += line;
        }
      } else {
        patchComplete = false;
      }
    }
    return { ok: true, files: order.map((p) => byPath.get(p)), patch_complete: patchComplete };
  }

  async function treeExists(tree) {
    if (typeof tree !== 'string' || !TREE_RE.test(tree)) return false;
    const inf = await init();
    if (!inf.ok) return false;
    try {
      const r = await runGit(['cat-file', '-e', `${tree}^{tree}`], { cwd: path.dirname(shadow), env: env(null) });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  function dirBytes(dir) {
    let total = 0;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) total += dirBytes(p);
      else if (ent.isFile()) { try { total += fs.statSync(p).size; } catch { /* gone */ } }
    }
    return total;
  }

  // After a successful init (the source schedules it on its engine's timers).
  async function housekeep() {
    const inf = await init();
    if (!inf.ok) return { ok: false, full: false };
    // tmp: every copy but this process's own (a snapshot may be running).
    try {
      for (const name of fs.readdirSync(paths.mirrorTmp)) {
        if (name.startsWith(`index-${process.pid}-`)) continue;
        try { fs.rmSync(path.join(paths.mirrorTmp, name), { recursive: true, force: true }); } catch { /* gone */ }
      }
    } catch { /* no tmp yet */ }
    try {
      await runGit(['prune', `--expire=${L.PRUNE_EXPIRE}`], { cwd: path.dirname(shadow), env: env(null) });
    } catch (e) {
      say(`codediff: prune failed (${(e && e.code) || 'error'})`);
    }
    // Records older than RECORD_MAX_DAYS, by mtime.
    const cutoff = now() - L.RECORD_MAX_DAYS * 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(paths.mirrorDiffsDir)) {
        if (!name.endsWith('.json')) continue;
        const p = path.join(paths.mirrorDiffsDir, name);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* gone */ }
      }
    } catch { /* no records yet */ }
    const full = dirBytes(path.join(shadow, 'objects')) > L.SHADOW_MAX_BYTES;
    return { ok: true, full };
  }

  return Object.freeze({
    init,
    info: () => info,
    env,
    gitArgs,
    pathspec,
    snapshot,
    emptyTree: () => (info ? info.emptyTree : null),
    diff,
    treeExists,
    housekeep,
    limits: Object.freeze({ ...L }),
  });
}

// ── (2) the source ───────────────────────────────────────────────────────────

function createCodediffSource({ shadow = null, runGit = null, enabled, limits = {} } = {}) {
  const L = { ...LIMITS, ...(isPlain(limits) ? limits : {}) };
  return {
    attach(engine) {
      const on = enabled === undefined ? process.env.WEB_CHAT_MIRROR_DIFFS !== '0' : enabled !== false;
      if (!on) return { start: async () => {}, stop: async () => {} };
      return attachSource(engine, { shadow, runGit, L });
    },
  };
}

function attachSource(engine, { shadow, runGit, L }) {
  const store = typeof shadow === 'function' ? shadow(engine)
    : shadow || createShadowStore({ root: engine.root, paths: engine.paths, runGit: runGit || defaultRunGit, now: engine.now, log: engine.log, limits: L });
  const now = () => engine.now();
  const say = (m) => { try { engine.log(m); } catch { /* never */ } };

  let stopped = false;
  let off = null; // a reason in OFF_REASONS: for the daemon's life
  let housekept = false;
  let inflight = null; // {promise, startedAt}
  const running = new Set(); // every snapshot promise not settled
  const controllers = new Set();
  const work = new Set(); // every turn's close work not settled
  const turns = new Map(); // turn id (at open) → T
  const chains = new Map(); // conversation id → {after, trees, tail}
  const stats = { snapshots: 0, slow: 0 };

  const fresh = (ts) => finite(ts) && Math.abs(now() - ts) <= L.FRESH_MS;

  function chainOf(cid) {
    let c = chains.get(cid);
    if (!c) { c = { after: null, trees: [], tail: Promise.resolve() }; chains.set(cid, c); }
    return c;
  }
  function pushTree(c, tree, turnId, kind) {
    if (!tree) return;
    c.trees.push([tree, turnId, kind]);
    while (c.trees.length > L.RETURN_MAX) c.trees.shift();
  }

  // The turn's current id: a transcript alias may have renamed it.
  function currentId(id) {
    try { const r = engine.model.resolveTurn(id); return typeof r === 'string' && r ? r : id; } catch { return id; }
  }
  function header(id) {
    try { return engine.model.turn(currentId(id)) || null; } catch { return null; }
  }
  function findTurn(turn) {
    if (turns.has(turn.id)) return turns.get(turn.id);
    if (typeof turn.replaces === 'string' && turns.has(turn.replaces)) return turns.get(turn.replaces);
    for (const [k, T] of turns) if (currentId(k) === turn.id) return T;
    return null;
  }
  function otherOpen(cid) {
    let list = [];
    try { list = engine.conversations.list() || []; } catch { list = []; }
    for (const c of list) {
      if (!c || c.id === cid) continue;
      try { if (engine.model.openTurnOf(c.id)) return true; } catch { /* none */ }
    }
    return false;
  }
  function markOthers(cid) {
    for (const T of turns.values()) if (!T.closed && T.cid !== cid) T.concurrent = true;
  }

  function patchCode(id, code) {
    const cur = currentId(id);
    try { engine.model.patchTurn(cur, { code }); } catch (e) { say(`codediff: patch failed (${(e && e.code) || 'error'})`); }
    return cur;
  }
  function noteCode(cid, endedAt) {
    try { engine.live.noteActivity(cid, endedAt, 'code'); } catch { /* the bar re-reads on its next sample */ }
  }

  function turnOff(reason) {
    if (!off && OFF_REASONS.has(reason)) {
      off = reason;
      say(`codediff: off (${reason})`);
    }
  }

  function scheduleHousekeeping() {
    if (housekept || !store.info()) return;
    housekept = true;
    engine.timers.setTimeout(() => {
      if (stopped) return;
      const p = Promise.resolve().then(() => store.housekeep()).then((r) => {
        if (r && r.full) turnOff('shadow-store-full');
      }, (e) => say(`codediff: housekeeping failed (${(e && e.code) || 'error'})`));
      work.add(p);
      p.finally(() => work.delete(p));
    }, 0);
  }

  // One snapshot, counted and timed for the slow guard.
  function takeSnapshot() {
    const controller = new AbortController();
    controllers.add(controller);
    const startedAt = now();
    const p = Promise.resolve()
      .then(() => store.snapshot({ signal: controller.signal }))
      .then((r) => {
        if (!isPlain(r)) return { ok: false, reason: 'snapshot-failed' };
        if (r.ok) {
          stats.snapshots += 1;
          const ms = finite(r.duration_ms) ? r.duration_ms : now() - startedAt;
          if (ms > L.SLOW_SNAPSHOT_MS) {
            stats.slow += 1;
            if (stats.slow >= L.SLOW_SNAPSHOTS) turnOff('slow-repo');
          }
          scheduleHousekeeping();
        } else if (r.reason === 'not-a-git-repo' || r.reason === 'git-missing') {
          turnOff(r.reason);
        }
        return r;
      }, () => ({ ok: false, reason: 'snapshot-failed' }))
      .finally(() => {
        controllers.delete(controller);
        running.delete(p);
        if (inflight && inflight.promise === p) inflight = null;
      });
    running.add(p);
    inflight = { promise: p, startedAt };
    return p;
  }

  // ── before ──
  function onTurnOpened(turn) {
    if (stopped || !isPlain(turn) || typeof turn.id !== 'string') return;
    if (!fresh(turn.started_at)) return;
    markOthers(turn.conversation_id);
    if (turns.has(turn.id)) return;
    const cid = turn.conversation_id;
    const T = {
      id: turn.id, cid, sid: turn.session_id || null, closed: false, tool: false, racy: false,
      concurrent: otherOpen(cid), beforeInFlight: false, beforeFail: null, before: null,
    };
    turns.set(turn.id, T);
    while (turns.size > TURNS_MAX) turns.delete(turns.keys().next().value);
    if (off) { T.beforeFail = off; T.before = Promise.resolve(null); return; }
    const reuse = inflight && now() - inflight.startedAt < L.REUSE_MS ? inflight.promise : null;
    const snap = reuse || takeSnapshot();
    T.beforeInFlight = true;
    T.before = snap.then((r) => {
      T.beforeInFlight = false;
      if (r && r.ok) return { tree: r.tree, at: r.at, source: 'turn-open', excluded: r.excluded, attr_exact: r.attr_exact };
      T.beforeFail = (r && r.reason) || 'snapshot-failed';
      const prev = chainOf(cid).after;
      if (prev && prev.tree) return { tree: prev.tree, at: prev.at, source: 'previous-turn-close', excluded: prev.excluded || null, attr_exact: prev.attr_exact };
      return null;
    });
  }

  // A mutating tool call while the before-snapshot runs: the before may hold it.
  function onIngest(env, info) {
    if (stopped || !isPlain(env) || env.event !== 'PreToolUse') return;
    const cid = isPlain(info) ? info.conversation_id : null;
    let id = null;
    try { id = cid ? engine.model.openTurnOf(cid) : null; } catch { id = null; }
    let T = id ? turns.get(id) : null;
    if (!T && id) for (const [k, x] of turns) if (!x.closed && currentId(k) === id) { T = x; break; }
    if (!T || T.closed) return;
    T.tool = true;
    const kind = isPlain(env.tool) ? env.tool.kind : null;
    if (T.beforeInFlight && !READ_ONLY.has(kind)) T.racy = true;
  }

  // ── after ──
  function onTurnClosed(turn) {
    if (stopped || !isPlain(turn) || typeof turn.id !== 'string') return;
    if (fresh(turn.ended_at)) markOthers(turn.conversation_id);
    const T = findTurn(turn);
    if (!T || T.closed) return;
    T.closed = true;
    if (!fresh(turn.ended_at)) { turns.delete(T.id); return; }
    const counts = isPlain(turn.counts) ? turn.counts : {};
    const ranTool = (finite(counts.tools) && counts.tools > 0) || T.tool;
    const c = chainOf(T.cid);
    if (!ranTool || off) turns.delete(T.id);
    if (!ranTool) {
      // Its before stands as its after for the chain.
      c.tail = c.tail.then(() => T.before).then((b) => {
        if (b && b.source === 'turn-open') {
          pushTree(c, b.tree, turn.id, 'before');
          c.after = { tree: b.tree, at: b.at, turn_id: turn.id, excluded: b.excluded, attr_exact: b.attr_exact };
        }
      }, () => {});
      return;
    }
    if (off) {
      patchCode(turn.id, { status: 'unavailable', reason: off });
      noteCode(T.cid, turn.ended_at);
      return;
    }
    patchCode(turn.id, { status: 'pending' });
    const p = c.tail.then(() => closeWork(T, turn, c)).catch((e) => {
      say(`codediff: turn failed (${(e && e.code) || 'error'})`);
      patchCode(turn.id, { status: 'unavailable', reason: 'snapshot-failed' });
    });
    c.tail = p;
    work.add(p);
    p.finally(() => { work.delete(p); turns.delete(T.id); });
  }

  function unavailable(T, turn, reason) {
    patchCode(turn.id, { status: 'unavailable', reason });
    noteCode(T.cid, turn.ended_at);
  }

  async function closeWork(T, turn, c) {
    const before = await T.before;
    if (stopped) return unavailable(T, turn, 'daemon-restarted');
    if (!before) return unavailable(T, turn, off || T.beforeFail || 'snapshot-failed');
    if (off) return unavailable(T, turn, off);
    const after = await takeSnapshot();
    if (!after.ok) {
      c.after = null;
      return unavailable(T, turn, stopped || after.reason === 'aborted' ? 'daemon-restarted' : off || after.reason);
    }
    const d = await store.diff(before.tree, after.tree, { context: DEFAULT_CONTEXT, withPatch: true });
    if (!d.ok) {
      c.after = null;
      return unavailable(T, turn, 'diff-failed');
    }
    const body = buildBody(d, before.excluded, after.excluded);
    // outside: edits between this conversation's previous turn and this one.
    let outside = null;
    const prev = c.after;
    if (prev && prev.tree && prev.tree !== before.tree) {
      const o = await store.diff(prev.tree, before.tree, { withPatch: false });
      if (o.ok) {
        outside = {
          files: o.files.length,
          additions: o.files.reduce((n, f) => n + f.additions, 0),
          deletions: o.files.reduce((n, f) => n + f.deletions, 0),
        };
        for (let i = c.trees.length - 1; i >= 0; i--) {
          if (c.trees[i][0] === before.tree) { outside.returned_to = c.trees[i][1]; break; }
        }
      }
    }
    const id = currentId(turn.id);
    pushTree(c, before.tree, id, 'before');
    pushTree(c, after.tree, id, 'after');
    c.after = { tree: after.tree, at: after.at, turn_id: id, excluded: after.excluded, attr_exact: after.attr_exact };
    const record = {
      v: 1,
      turn_id: id,
      conversation_id: T.cid,
      status: 'ready',
      before: { tree: before.tree, at: before.at, source: before.source },
      after: { tree: after.tree, at: after.at },
      files: body.files,
      totals: body.totals,
      patch: body.patch,
      patch_truncated: body.patch_truncated,
      flags: {
        concurrent_sessions: T.concurrent || otherOpen(T.cid),
        before_racy: T.racy,
        skipped_large_untracked: (after.excluded && after.excluded.large) || [],
      },
      outside,
      attr_exact: before.attr_exact !== false && after.attr_exact !== false,
      created_at: now(),
    };
    const file = engine.paths.mirrorDiff(id);
    if (!file) return unavailable(T, turn, 'bad-id');
    try {
      writeJsonAtomic(file, record);
    } catch (e) {
      say(`codediff: record write failed (${(e && e.code) || 'error'})`);
      return unavailable(T, turn, 'write-failed');
    }
    patchCode(id, { status: 'ready', files: body.totals.files, additions: body.totals.additions, deletions: body.totals.deletions });
    noteCode(T.cid, turn.ended_at);
    return undefined;
  }

  // The record's body from a store diff: every hunk redacted (with its file as
  // context) and the host's paths masked BEFORE anything is written (§2.9
  // rule 3); a sensitive file keeps its path and counts but no hunk; untracked
  // sensitive and large files the snapshots excluded appear as withheld.
  function buildBody(d, exBefore, exAfter) {
    const files = [];
    const parts = [];
    let used = 0;
    let truncated = !d.patch_complete;
    for (const f of d.files) {
      const entry = { path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary };
      if (isSensitive(f.path)) entry.withheld = 'sensitive';
      else if (typeof f.patch === 'string' && f.patch) {
        let text = redactHostPaths(engine.redactor.text(f.patch, { context: { file: f.path } }), { root: engine.root });
        const cut = cutBytes(text, L.PATCH_FILE_MAX);
        text = cut.text;
        if (cut.cut) entry.truncated = true;
        const size = Buffer.byteLength(text);
        if (used + size > L.PATCH_MAX) truncated = true;
        else { parts.push(text); used += size; }
      }
      files.push(entry);
    }
    const seen = new Set(files.map((f) => f.path));
    if (exBefore && exAfter) {
      const was = new Map((exBefore.sensitive || []).map((s) => [s.path, s]));
      const is = new Map((exAfter.sensitive || []).map((s) => [s.path, s]));
      for (const [p, s] of is) {
        const w = was.get(p);
        if (!w) files.push({ path: p, status: 'A', withheld: 'sensitive' });
        else if (w.size !== s.size || w.mtime !== s.mtime) files.push({ path: p, status: 'M', withheld: 'sensitive' });
      }
      for (const p of was.keys()) if (!is.has(p) && !seen.has(p)) files.push({ path: p, status: 'D', withheld: 'sensitive' });
      const wasL = new Set(exBefore.large || []);
      const isL = new Set(exAfter.large || []);
      for (const p of isL) if (!wasL.has(p) && !seen.has(p)) files.push({ path: p, status: 'A', withheld: 'large' });
      for (const p of wasL) if (!isL.has(p) && !seen.has(p)) files.push({ path: p, status: 'D', withheld: 'large' });
    }
    const totals = {
      files: files.length,
      additions: files.reduce((n, f) => n + (finite(f.additions) ? f.additions : 0), 0),
      deletions: files.reduce((n, f) => n + (finite(f.deletions) ? f.deletions : 0), 0),
    };
    return { files, totals, patch: parts.join(''), patch_truncated: truncated };
  }

  // ── the api ──
  function readRecord(id) {
    const file = typeof id === 'string' ? engine.paths.mirrorDiff(id) : null;
    if (!file) return null;
    const r = readJson(file, { validate: (v) => isPlain(v) && v.v === 1 });
    return r.ok ? r.value : null;
  }

  function turnDiff(id) {
    if (typeof id !== 'string' || !id) return null;
    const h = header(id);
    const ids = [id, currentId(id)];
    if (h) { ids.push(h.id); if (typeof h.replaces === 'string') ids.push(h.replaces); }
    for (const x of new Set(ids)) {
      const rec = readRecord(x);
      if (rec) return rec;
    }
    if (h && isPlain(h.code)) {
      if (h.code.status === 'unavailable') return { v: 1, turn_id: h.id, status: 'unavailable', reason: h.code.reason || null };
      if (h.code.status === 'pending') return { v: 1, turn_id: h.id, status: 'pending' };
    }
    return null;
  }

  function nodeTurnIds(nodeId, node) {
    const m = isPlain(node) && isPlain(node.mirror) && Array.isArray(node.mirror.turns) ? node.mirror.turns : null;
    if (m) return m.map((t) => (typeof t === 'string' ? t : isPlain(t) ? t.turn_id || t.id : null)).filter((x) => typeof x === 'string');
    const found = [];
    let list = [];
    try { list = engine.conversations.list() || []; } catch { list = []; }
    for (const c of list) {
      let ts = [];
      try { ts = engine.model.turnsOf(c.id) || []; } catch { ts = []; }
      for (const t of ts) if (isPlain(t.node) && t.node.id === nodeId) found.push(t);
    }
    found.sort((a, b) => (a.ended_at || 0) - (b.ended_at || 0) || (a.seq || 0) - (b.seq || 0));
    return found.map((t) => t.id);
  }

  async function nodeDiff(ref, context) {
    const graph = engine.graph;
    if (!graph || !graph.nodes) return null;
    let r;
    try { r = resolveNodeRef(graph, ref, { allowLive: false }); } catch { return null; }
    if (!r || !r.ok) return null;
    const ctx = context === undefined || context === null ? DEFAULT_CONTEXT : Number(context);
    const useCtx = Number.isInteger(ctx) && ctx >= 0 && ctx <= CONTEXT_MAX ? ctx : DEFAULT_CONTEXT;
    const cacheFile = useCtx === DEFAULT_CONTEXT ? engine.paths.mirrorNodeDiff(r.id) : null;
    if (cacheFile) {
      const cached = readJson(cacheFile, { validate: (v) => isPlain(v) && isPlain(v.node) });
      if (cached.ok) return { ...cached.value, node: { id: r.id, label: r.label } };
    }
    const ids = nodeTurnIds(r.id, r.node);
    const recs = ids.map((id) => turnDiff(id));
    const turnsOut = recs.filter(Boolean).map((rec) => {
      const { patch, ...rest } = rec;
      void patch;
      return rest;
    });
    const ready = recs.filter((rec) => rec && rec.status === 'ready' && isPlain(rec.before) && isPlain(rec.after));
    let combined = null;
    if (ready.length) {
      const a = ready[0].before.tree;
      const b = ready[ready.length - 1].after.tree;
      if (await store.treeExists(a) && await store.treeExists(b)) {
        const d = await store.diff(a, b, { context: useCtx, withPatch: true });
        if (d.ok) {
          const body = buildBody(d, null, null);
          combined = { before: { tree: a }, after: { tree: b }, files: body.files, totals: body.totals, patch: body.patch, patch_truncated: body.patch_truncated };
        }
      }
    }
    const out = { node: { id: r.id, label: r.label }, turns: turnsOut, combined };
    const settled = recs.every((rec) => rec && (rec.status === 'ready' || rec.status === 'unavailable'));
    if (cacheFile && settled && (combined || !ready.length)) {
      try { writeJsonAtomic(cacheFile, out); } catch (e) { say(`codediff: node cache failed (${(e && e.code) || 'error'})`); }
    }
    return out;
  }

  async function diff(q) {
    if (!isPlain(q)) return null;
    if (typeof q.turn === 'string') return turnDiff(q.turn);
    if (q.node !== undefined && q.node !== null) return nodeDiff(q.node, q.context);
    return null;
  }

  // ── persistence (§2.11): the chain, repo-relative only ──
  function persistState(sessionId) {
    let v = null;
    try { v = engine.conversations.bySession(sessionId); } catch { v = null; }
    const c = v ? chains.get(v.id) : null;
    if (!c) return { v: 1, chain: null };
    return {
      v: 1,
      chain: {
        after: c.after ? { tree: c.after.tree, at: c.after.at, turn_id: c.after.turn_id } : null,
        trees: c.trees.map((t) => [...t]),
      },
    };
  }

  function restoreState(sessionId, value) {
    let conv = null;
    try { conv = engine.conversations.bySession(sessionId); } catch { conv = null; }
    const cid = conv ? conv.id : null;
    if (cid && isPlain(value) && isPlain(value.chain) && !chains.has(cid)) {
      const ch = value.chain;
      const c = chainOf(cid);
      if (isPlain(ch.after) && typeof ch.after.tree === 'string' && TREE_RE.test(ch.after.tree)) {
        c.after = { tree: ch.after.tree, at: finite(ch.after.at) ? ch.after.at : null, turn_id: typeof ch.after.turn_id === 'string' ? ch.after.turn_id : null, excluded: null };
      }
      if (Array.isArray(ch.trees)) {
        for (const t of ch.trees.slice(-L.RETURN_MAX)) {
          if (Array.isArray(t) && TREE_RE.test(t[0]) && typeof t[1] === 'string' && (t[2] === 'before' || t[2] === 'after')) c.trees.push([t[0], t[1], t[2]]);
        }
      }
    }
    // A turn still pending from before the restart: its record, else unavailable.
    if (!cid) return;
    engine.timers.setTimeout(() => {
      let ts = [];
      try { ts = engine.model.turnsOf(cid, { session_id: sessionId }) || []; } catch { ts = []; }
      for (const t of ts) {
        if (!isPlain(t.code) || t.code.status !== 'pending' || turns.has(t.id)) continue;
        let rec = readRecord(t.id);
        if (!rec && typeof t.replaces === 'string') rec = readRecord(t.replaces);
        if (rec && rec.status === 'ready' && isPlain(rec.totals)) {
          patchCode(t.id, { status: 'ready', files: rec.totals.files, additions: rec.totals.additions, deletions: rec.totals.deletions });
        } else {
          patchCode(t.id, { status: 'unavailable', reason: 'daemon-restarted' });
        }
      }
    }, 0);
  }

  function onConversation(ev) {
    if (!isPlain(ev) || !isPlain(ev.conversation)) return;
    if (ev.change === 'removed' || ev.change === 'merged') {
      const cid = ev.conversation.id;
      chains.delete(cid);
      for (const [k, T] of turns) if (T.cid === cid && T.closed) turns.delete(k);
    }
  }

  function diagnostics() {
    const inf = store.info();
    return {
      git: {
        state: off || (inf ? 'ready' : 'idle'),
        attr_exact: inf ? inf.attrSource : null,
        snapshots: stats.snapshots,
        slow: stats.slow,
      },
    };
  }

  async function start() {
    stopped = false;
  }

  // Abort the snapshots in flight (their index copies go in the store's
  // finally) and wait for them, cut at MIRROR_STOP_TIMEOUT_MS.
  async function stop() {
    stopped = true;
    for (const c of controllers) { try { c.abort(); } catch { /* aborted */ } }
    const pending = [...running, ...work];
    if (!pending.length) return;
    let timer = null;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => { timer = setTimeout(resolve, MIRROR_STOP_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
  }

  return {
    start,
    stop,
    onIngest,
    onConversation,
    onTurnOpened,
    onTurnClosed,
    persistState,
    restoreState,
    diagnostics,
    api: { diff },
  };
}

module.exports = {
  createShadowStore,
  createCodediffSource,
  LIMITS,
  READ_ONLY_KINDS,
  SNAPSHOT_CONFIG,
  MIRROR_STOP_TIMEOUT_MS,
  ...LIMITS,
};

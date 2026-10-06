// test-support/treesnap-fixture.js — the ONE scratch-repository builder for the
// tree-snapshot tests (ruling U43-U79@fixture-builder, B2 b): the per-turn diff
// engine's (test/mirror-codediff.test.js, U43), its holes'
// (test/mirror-codediff-holes.test.js) and the restore engine's
// (test/restore-engine.test.js, U79), and the ones U51's end-to-end check and
// U83's revert tests write next. Never copy it into a test file.
//
// Every repository lives under the sandbox HOME (test-support/sandbox), is
// built with a fixed identity (-c user.name / user.email, commit.gpgsign=false,
// init.defaultBranch=main) and an environment with every GIT_* variable
// removed, so nothing of the developer's git config or of a git hook the suite
// runs under reaches it. Synchronous on purpose: a builder is set-up, never
// the code under test (which runs git through lib/server/git-run.js).
//
// THE API
//
//   treesnapRepo(t, {files = {'a.txt': 'alpha\n'}, sub = '', objectFormat = null,
//                    webChat = true}) → repo
//     A fresh repository with `files` ({toplevel-relative path: string | Buffer})
//     committed as 'init'. `sub` makes the project ROOT a subdirectory of the
//     toplevel (created, possibly empty); `objectFormat` 'sha256' makes a
//     sha256 repository; `webChat` creates <root>/.web-chat/. Removed after
//     the test (t.after). The repo:
//       top, root            the toplevel and the root, both realpaths
//       prefix               the root relative to the toplevel: '' or 'sub/'
//       git(args, opts)      execFileSync git at the toplevel → Buffer
//       write(rel, data)     write a toplevel-relative file (directories made)
//       read(rel)            its bytes
//       abs(rel)             its absolute path
//       head()               the project's HEAD sha, or null on an unborn branch
//       commit(msg)          `add -A` + commit; → the new HEAD
//       shadow               projectPaths(root).mirrorGit (the shadow store)
//       bytesAt(tree, rel)   bytesAt(repo, tree, rel), below
//       entryAt(tree, rel)   entryAt(repo, tree, rel), below
//     and the C-REV-1 matrix builders, each one change on disk (paths are
//     toplevel-relative, like write's):
//       chmod(rel, mode)                  the exec bit (0o755 / 0o644)
//       symlink(rel, target)              a symlink (replacing what is there)
//       remove(rel)                       a file, a link or a whole directory
//       ignore(pattern)                   a line in the project's .git/info/exclude
//       assumeUnchanged(rel)              the bit, in the PROJECT's index
//       skipWorktree(rel, {present})      the bit, in the project's index; with
//                                         present: false the file is then removed
//                                         (a sparse checkout's out-of-cone file)
//       nestedRepo(rel, {commit = true})  an embedded repository (with or without
//                                         a commit) at rel
//       worktree(name)                    `git worktree add` at
//                                         .claude/worktrees/<name> (detached)
//       overCap(rel, bytes)               an untracked file of `bytes` bytes, for
//                                         a cap the test injects through limits
//       sameSecondEdit(rel, a, b)         async: within one second, write a,
//                                         stage it in the project index, write b
//                                         (same size): the Q-D fix 1 case
//       bits(rel)                         the `ls-files -v` tag of rel in the
//                                         project's index ('H', 'h', 'S', 's'…)
//
//   gitIn(cwd, args, opts)   the builder's git: GIT_* scrubbed, identity pinned
//   GIT_ID                   that identity, as -c arguments
//   digestTree(dir)          {relative path: sha256} of every file under dir
//   gitDirDigest(repo)       digestTree(<toplevel>/.git) — "the project's .git
//                            untouched" (index, HEAD, refs, objects, config)
//   bytesAt(repo, tree, rel) the bytes `tree` holds at the ROOT-relative path
//                            rel, read from the shadow store (whose alternates
//                            reach the project's objects): cat-file blob as a
//                            Buffer (for a symlink, its target), null when the
//                            tree has no such path
//   entryAt(repo, tree, rel) {mode, type, oid} of that path, or null
//   nextSecond(after)        await the wall clock just past a second boundary
//   MATRIX                   C-REV-1's restore cases: [{name, earlier(repo),
//                            later(repo), paths}] — `earlier` builds the state
//                            a restore goes back to, `later` the edits made
//                            after it, `paths` the root-relative paths whose
//                            bytes a restore must put back. Each case keeps to
//                            its own directory, so all of them fit in one repo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { home: SANDBOX } = require('./sandbox');
const { projectPaths } = require('../lib/core/paths');

const GIT_ID = ['-c', 'user.name=wc-test', '-c', 'user.email=wc-test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

function gitIn(cwd, args, opts = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return execFileSync('git', [...GIT_ID, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

// sha256 of every file under dir, by relative path.
function digestTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const gitDirDigest = (repo) => digestTree(path.join(repo.top, '.git'));

function shadowGit(repo, args, opts = {}) {
  return gitIn(repo.top, args, { ...opts, env: { ...scrubbed(), GIT_DIR: repo.shadow } });
}
function scrubbed() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

function entryAt(repo, tree, rel) {
  const out = shadowGit(repo, ['ls-tree', '-z', '--full-tree', tree, '--', `${repo.prefix}${rel}`]).toString();
  const line = out.split('\0').find(Boolean);
  if (!line) return null;
  const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(line);
  return m ? { mode: m[1], type: m[2], oid: m[3] } : null;
}

function bytesAt(repo, tree, rel) {
  try {
    return shadowGit(repo, ['cat-file', 'blob', `${tree}:${repo.prefix}${rel}`]);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function nextSecond(after = 15) {
  await sleep(1000 - (Date.now() % 1000) + after);
}

function treesnapRepo(t, { files = { 'a.txt': 'alpha\n' }, sub = '', objectFormat = null, webChat = true } = {}) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(SANDBOX, 'wc-codediff-')));
  t.after(() => {
    // A read-only directory a test left behind must not fail the cleanup.
    const open = (d) => {
      try { fs.chmodSync(d, 0o755); } catch { /* gone */ }
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) if (e.isDirectory()) open(path.join(d, e.name));
    };
    open(top);
    fs.rmSync(top, { recursive: true, force: true });
  });
  gitIn(top, ['init', '-q', ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]);
  const abs = (rel) => path.join(top, rel);
  const write = (rel, data) => {
    const p = abs(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* absent */ }
    fs.writeFileSync(p, data);
  };
  for (const [rel, data] of Object.entries(files)) write(rel, data);
  gitIn(top, ['add', '-A']);
  gitIn(top, ['commit', '-q', '-m', 'init']);
  const root = sub ? path.join(top, sub) : top;
  fs.mkdirSync(root, { recursive: true });
  if (webChat) fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  const git = (args, opts) => gitIn(top, args, opts);
  const repo = {
    top,
    root,
    prefix: sub ? `${sub.split(path.sep).join('/').replace(/\/+$/, '')}/` : '',
    shadow: projectPaths(root).mirrorGit,
    git,
    write,
    read: (rel) => fs.readFileSync(abs(rel)),
    abs,
    head() {
      try { return git(['rev-parse', '--verify', '-q', 'HEAD']).toString().trim() || null; } catch { return null; }
    },
    commit(msg = 'next') {
      git(['add', '-A']);
      git(['commit', '-q', '--allow-empty', '-m', msg]);
      return repo.head();
    },
    chmod: (rel, mode) => fs.chmodSync(abs(rel), mode),
    symlink(rel, target) {
      const p = abs(rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.rmSync(p, { recursive: true, force: true });
      fs.symlinkSync(target, p);
    },
    remove: (rel) => fs.rmSync(abs(rel), { recursive: true, force: true }),
    ignore(pattern) {
      const f = path.join(top, '.git', 'info', 'exclude');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `${pattern}\n`);
    },
    assumeUnchanged: (rel) => git(['update-index', '--assume-unchanged', '--', rel]),
    skipWorktree(rel, { present = true } = {}) {
      git(['update-index', '--skip-worktree', '--', rel]);
      if (!present) fs.rmSync(abs(rel), { force: true });
    },
    bits(rel) {
      const out = git(['ls-files', '-v', '-z', '--', rel]).toString();
      const e = out.split('\0').find(Boolean);
      return e ? e.charAt(0) : null;
    },
    nestedRepo(rel, { commit = true, files: nestedFiles = { 'inner.txt': 'inner\n' } } = {}) {
      const dir = abs(rel);
      fs.mkdirSync(dir, { recursive: true });
      gitIn(dir, ['init', '-q']);
      for (const [f, data] of Object.entries(nestedFiles)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), data);
      }
      if (commit) {
        gitIn(dir, ['add', '-A']);
        gitIn(dir, ['commit', '-q', '-m', 'nested']);
      }
      return dir;
    },
    worktree(name) {
      const rel = path.join('.claude', 'worktrees', name);
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      git(['worktree', 'add', '-q', '--detach', rel]);
      return abs(rel);
    },
    overCap: (rel, bytes) => write(rel, Buffer.alloc(bytes, 0x5a)),
    async sameSecondEdit(rel, a, b) {
      if (Buffer.byteLength(a) !== Buffer.byteLength(b)) throw new Error('sameSecondEdit: a and b must be the same size');
      await nextSecond();
      write(rel, a);
      git(['add', '--', rel]);
      write(rel, b);
      await nextSecond(60);
    },
  };
  repo.bytesAt = (tree, rel) => bytesAt(repo, tree, rel);
  repo.entryAt = (tree, rel) => entryAt(repo, tree, rel);
  return repo;
}

// C-REV-1's matrix. Paths are relative to the ROOT; each case writes through
// repo.prefix, so the matrix runs with `sub` too.
const BIN_A = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 10, 0]);
const BIN_B = Buffer.from([9, 0, 8, 0, 7, 0, 255, 0, 13, 13]);
const MATRIX = Object.freeze([
  {
    name: 'modified text',
    paths: ['text/m.txt'],
    earlier: (r) => r.write(`${r.prefix}text/m.txt`, 'one\ntwo\n'),
    later: (r) => r.write(`${r.prefix}text/m.txt`, 'one\nTWO\nthree\n'),
  },
  {
    name: 'binary',
    paths: ['bin/data.bin'],
    earlier: (r) => r.write(`${r.prefix}bin/data.bin`, BIN_A),
    later: (r) => r.write(`${r.prefix}bin/data.bin`, BIN_B),
  },
  {
    name: 'exec bit',
    paths: ['exec/run.sh'],
    earlier: (r) => { r.write(`${r.prefix}exec/run.sh`, '#!/bin/sh\necho hi\n'); r.chmod(`${r.prefix}exec/run.sh`, 0o755); },
    later: (r) => r.chmod(`${r.prefix}exec/run.sh`, 0o644),
  },
  {
    name: 'symlink',
    paths: ['link/to-file', 'link/was-file'],
    earlier: (r) => {
      r.write(`${r.prefix}link/target-a.txt`, 'a\n');
      r.write(`${r.prefix}link/target-b.txt`, 'b\n');
      r.symlink(`${r.prefix}link/to-file`, 'target-a.txt');
      r.write(`${r.prefix}link/was-file`, 'a plain file\n');
    },
    later: (r) => {
      r.symlink(`${r.prefix}link/to-file`, 'target-b.txt');
      r.symlink(`${r.prefix}link/was-file`, 'target-a.txt');
    },
  },
  {
    name: 'delete',
    paths: ['del/gone.txt'],
    earlier: (r) => { r.write(`${r.prefix}del/gone.txt`, 'restore me\n'); r.write(`${r.prefix}del/stays.txt`, 'stays\n'); },
    later: (r) => r.remove(`${r.prefix}del/gone.txt`),
  },
  {
    name: 'new directory pruned',
    paths: ['newdir/deep/x.txt', 'newdir/y.txt'],
    earlier: () => {},
    later: (r) => { r.write(`${r.prefix}newdir/deep/x.txt`, 'x\n'); r.write(`${r.prefix}newdir/y.txt`, 'y\n'); },
  },
  {
    name: 'same-second same-size edit',
    paths: ['race/r.txt'],
    earlier: (r) => r.write(`${r.prefix}race/r.txt`, 'aaaa\n'),
    later: (r) => r.sameSecondEdit(`${r.prefix}race/r.txt`, 'cccc\n', 'dddd\n'),
  },
  {
    name: 'text eol=crlf',
    paths: ['eol/e.crlf'],
    earlier: (r) => {
      r.write(`${r.prefix}eol/.gitattributes`, '*.crlf text eol=crlf\n');
      r.write(`${r.prefix}eol/e.crlf`, Buffer.from('first\r\nsecond\nthird\r\n'));
    },
    later: (r) => r.write(`${r.prefix}eol/e.crlf`, Buffer.from('first\nsecond\r\nfourth\n')),
  },
]);

module.exports = {
  treesnapRepo,
  gitIn,
  GIT_ID,
  digestTree,
  gitDirDigest,
  bytesAt,
  entryAt,
  nextSecond,
  MATRIX,
};

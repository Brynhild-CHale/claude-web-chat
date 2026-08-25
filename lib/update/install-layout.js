// The install layout, and the one question it exists to answer: WHICH TREE is
// the `claude-web-chat` on your PATH actually running?
//
// That question used to be unanswerable, and it cost a working day. A global npm
// prefix is a shared mutable directory, so an unrelated `npm i -g` quietly
// replaced a maintainer's `npm link` with a real copy of a 16-day-old build. The
// checkout's tests were green, the CLI on PATH was ancient, and nothing anywhere
// said so. Releases now unpack into ~/.web-chat/versions/<v>/ — a directory this
// program alone writes — and every layout decision is made here, so:
//
//   * `update` can REFUSE to run when it is not a managed install (a dev
//     checkout, or a leftover npm global), instead of rewriting something it
//     does not own;
//   * `version` / `init --report` can print the running tree and the tree on
//     PATH side by side, so a mismatch is loud rather than invisible.
//
// Everything here is fs-only: no network (see release.js), no npm, no sudo.

const fs = require('fs');
const path = require('path');
const { installPaths, PACKAGE_ROOT, KEEP_VERSIONS } = require('../core/paths');

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Is `child` inside `parent`? Both sides go through realpath when they exist,
// because one may reach the same directory through a symlink and the other not
// — on macOS $TMPDIR is /var/folders/… which is really /private/var/folders/…,
// and a purely lexical compare then says a tree is NOT where it plainly is.
// Separator guard so ".../versions" does not match ".../versions-backup".
function isInside(parent, child) {
  if (!parent || !child) return false;
  const a = realpath(parent) || path.resolve(parent);
  const b = realpath(child) || path.resolve(child);
  return b === a || b.startsWith(a + path.sep);
}

// Walk up from `dir` looking for a .git entry (dir OR file — a worktree's .git
// is a file). Returns the directory holding it, or null.
function findGitRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function readVersion(pkgRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// What kind of tree is this code running from?
//
//   managed   — under ~/.web-chat/versions/<v>/ : `update` may rewrite it.
//   dev       — a git working copy               : `update` must refuse.
//   unmanaged — anything else (a leftover npm global install, a hand-copied
//               directory)                       : `update` must refuse.
//
// `packageRoot` is injectable so tests can classify a fabricated tree; it
// defaults to the real package root, resolved through symlinks (the bin on PATH
// is a symlink, and Node has already realpath'd __dirname for us).
function describeInstall({ packageRoot = PACKAGE_ROOT, paths = installPaths() } = {}) {
  const root = realpath(packageRoot) || path.resolve(packageRoot);
  const version = readVersion(root);

  let kind = 'unmanaged';
  let versionDir = null;
  if (isInside(paths.versions, root)) {
    kind = 'managed';
    // ~/.web-chat/versions/<v> — the first segment under versions/.
    const rel = path.relative(realpath(paths.versions) || paths.versions, root).split(path.sep);
    versionDir = path.join(realpath(paths.versions) || paths.versions, rel[0]);
  } else if (findGitRoot(root)) {
    kind = 'dev';
  }

  // Where the PATH symlink points, and whether it agrees with what is running.
  const linkPath = paths.binLink('claude-web-chat');
  const linkTarget = realpath(linkPath);
  const linkPackageRoot = linkTarget ? path.dirname(path.dirname(linkTarget)) : null;
  const linkVersion = linkPackageRoot ? readVersion(linkPackageRoot) : null;

  return {
    kind,
    packageRoot: root,
    version,
    versionDir,
    gitRoot: kind === 'dev' ? findGitRoot(root) : null,
    current: realpath(paths.current),
    currentVersion: readVersion(paths.current),
    linkPath,
    linkTarget,
    linkPackageRoot,
    linkVersion,
    // The tripwire for the exact failure that motivated all of this: something
    // on PATH claiming to be this program, resolving somewhere else.
    linkMismatch: Boolean(linkPackageRoot && linkPackageRoot !== root),
  };
}

// Every version currently unpacked under ~/.web-chat/versions, newest first by
// semantic order (falling back to name order for anything non-numeric).
function listVersions(paths = installPaths()) {
  let names;
  try {
    names = fs.readdirSync(paths.versions, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names.sort(compareVersionNames).reverse();
}

function compareVersionNames(a, b) {
  const pa = String(a).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10));
  const pb = String(b).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10));
  const numeric = pa.every((n) => Number.isFinite(n)) && pb.every((n) => Number.isFinite(n));
  if (!numeric) return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Replace a symlink atomically: write it under a temp name in the SAME directory
// and rename over the old one. rename(2) is atomic, so a reader either sees the
// old target or the new one — never a missing `current`. A plain `ln -sfn` (or
// unlink-then-symlink) leaves a window where the command does not exist.
function symlinkAtomic(target, linkPath) {
  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  // A previous crash could have left a temp name behind.
  try { fs.unlinkSync(tmp); } catch {}
  fs.symlinkSync(target, tmp);
  // rename() refuses to replace a non-empty DIRECTORY, and `current` is only
  // ever a symlink for us — but a hand-made directory there would wedge every
  // future update, so clear that one case explicitly.
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isDirectory()) fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {}
  fs.renameSync(tmp, linkPath);
}

// Point ~/.web-chat/current at versions/<version>. The target is RELATIVE, so
// the whole ~/.web-chat tree stays movable.
function activate(version, paths = installPaths()) {
  const dir = paths.versionDir(version);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`version ${version} is not unpacked at ${dir}`);
  }
  symlinkAtomic(path.join('versions', String(version)), paths.current);
  return dir;
}

// Symlink the three bins into ~/.local/bin, pointing at ~/.web-chat/current/bin/
// (never at a version directory — that is what makes rollback a single swap).
// Returns one row per bin describing what happened.
function linkBins(paths = installPaths()) {
  fs.mkdirSync(paths.binDir, { recursive: true });
  const rows = [];
  for (const name of paths.BIN_NAMES) {
    const link = paths.binLink(name);
    const target = paths.currentBin(name);
    let before = null;
    try { before = fs.readlinkSync(link); } catch {}
    if (before === target) {
      rows.push({ name, link, target, action: 'ok' });
      continue;
    }
    let existed = false;
    try { existed = Boolean(fs.lstatSync(link)); } catch {}
    symlinkAtomic(target, link);
    rows.push({ name, link, target, action: existed ? 'relinked' : 'linked' });
  }
  return rows;
}

// Is `dir` on PATH? Used to decide whether to print the export line.
function onPath(dir, pathEnv = process.env.PATH || '') {
  const want = path.resolve(dir);
  return pathEnv.split(path.delimiter).filter(Boolean).some((p) => {
    try { return path.resolve(p) === want; } catch { return false; }
  });
}

// Keep the newest `keep` versions plus whatever `current` points at; delete the
// rest. Rollback stays a symlink swap for recent builds without the store
// growing without bound.
function pruneVersions({ keep = KEEP_VERSIONS, paths = installPaths() } = {}) {
  const versions = listVersions(paths);
  const currentTarget = realpath(paths.current);
  const removed = [];
  for (const v of versions.slice(keep)) {
    const dir = paths.versionDir(v);
    if (realpath(dir) && currentTarget && realpath(dir) === currentTarget) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(v);
    } catch { /* a version we cannot remove is not worth failing an update over */ }
  }
  return removed;
}

// Remove the installed PROGRAM: the ~/.local/bin symlinks that point into this
// install, the version store, and the `current` symlink. Never touches project
// data, and never touches a bin symlink that resolves somewhere else (a dev
// checkout's `npm link`, another tool with the same name).
function removeInstall({ paths = installPaths(), dryRun = false } = {}) {
  const bins = [];
  for (const name of paths.BIN_NAMES) {
    const link = paths.binLink(name);
    let target = null;
    try { target = fs.readlinkSync(link); } catch {}
    if (target == null) { bins.push({ name, link, action: 'not present' }); continue; }
    const resolved = path.resolve(path.dirname(link), target);
    if (!isInside(paths.root, resolved)) {
      bins.push({ name, link, action: `left alone (points outside ${paths.root})`, target: resolved });
      continue;
    }
    if (!dryRun) { try { fs.unlinkSync(link); } catch {} }
    bins.push({ name, link, action: 'removed', target: resolved });
  }

  const versions = listVersions(paths);
  if (!dryRun) {
    try { fs.rmSync(paths.versions, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(paths.current); } catch {}
  }
  return { bins, versions };
}

module.exports = {
  describeInstall,
  listVersions,
  compareVersionNames,
  activate,
  linkBins,
  symlinkAtomic,
  onPath,
  pruneVersions,
  removeInstall,
  isInside,
  findGitRoot,
};

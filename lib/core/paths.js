// The one path authority. Every path under a project's .web-chat/ and under
// ~/.web-chat/ is minted here, so the '.web-chat' literal and the home-directory
// lookup each live in exactly one place (enforced by test/conventions.test.js).
//
// projectPaths()/userPaths() are PURE (no fs) so CLI reads never mkdir as a side
// effect; the mkdir that resolvePaths did on every boot is now the explicit
// ensureProjectDirs(). Absorbs lib/util/root.js (findProjectRoot) and the
// path-building half of lib/server/paths.js (resolvePaths).

const path = require('path');
const os = require('os');
const fs = require('fs');

// The ONLY occurrence of this literal in lib/.
const WEB_CHAT_DIRNAME = '.web-chat';
const PACKAGE_ROOT = path.join(__dirname, '..', '..'); // lib/core -> package root
// Package-static asset dirs (root-independent) — the served browser assets and
// the bundled extensions live inside the installed package, not a project.
const PUBLIC_DIR = path.join(PACKAGE_ROOT, 'public');

// Walk up from startDir to the nearest ancestor containing a .web-chat/ dir (the
// way git finds .git). Returns that dir, or null. Claude Code spawns hooks with a
// cd-tracking cwd and users run the CLI from subdirs, so process.cwd() alone is
// not a stable anchor.
function findProjectRoot(startDir = process.cwd()) {
  let dir;
  try { dir = path.resolve(startDir); } catch { return null; }
  while (true) {
    if (fs.existsSync(path.join(dir, WEB_CHAT_DIRNAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The .web-chat dir for a starting point, falling back to startDir/.web-chat when
// no installed root is found up-tree (for commands that may create a fresh install
// at the current location).
function resolveWebChatDir(startDir = process.cwd()) {
  const root = findProjectRoot(startDir) || path.resolve(startDir);
  return path.join(root, WEB_CHAT_DIRNAME);
}

// Project-local state under <root>/.web-chat/. Pure — no fs.
function projectPaths(root) {
  const dir = path.join(root, WEB_CHAT_DIRNAME);
  return {
    root,
    dir,
    serverJson: path.join(dir, 'server.json'),
    draft: path.join(dir, 'draft.json'),
    graphDir: path.join(dir, 'graph'),
    meta: path.join(dir, 'graph', '_meta.json'),
    captures: path.join(dir, 'captures'),
    components: path.join(dir, 'components'),
    services: path.join(dir, 'services'),
    // NB: the service TRUST store is deliberately NOT here — it lives in the
    // user tier (see userPaths().trustedServices). It used to sit at
    // .web-chat/services/trusted.json, inside the project, which meant a
    // repository could ship its own pre-approval: clone a hostile repo, open it,
    // and its service.js ran host code with no prompt. A consent record must
    // never be writable by the thing asking for consent.
    themesDir: path.join(dir, 'themes'),
    theme: path.join(dir, 'theme.json'),
    profiles: path.join(dir, 'profiles'),
    exports: path.join(dir, 'exports'),
    version: path.join(dir, '_version.json'),
    managed: path.join(dir, 'managed.json'),
    disabled: path.join(dir, 'disabled'),
    captureToken: path.join(dir, 'capture-token'),
    serverLog: path.join(dir, 'server.log'),
    hookLog: path.join(dir, 'hook.log'),
    PUBLIC_DIR,
    EXTENSIONS_DIR: path.join(PACKAGE_ROOT, 'extensions'),
  };
}

// The ONE home lookup in lib/ (enforced by test/conventions.test.js). Everything
// that needs $HOME — the user state tier AND the install tier below — comes
// through here.
function homeDir() {
  return os.homedir();
}

// User-global state under ~/.web-chat/. Pure — no fs.
function userPaths() {
  const root = path.join(homeDir(), WEB_CHAT_DIRNAME);
  return {
    root,
    disabled: path.join(root, 'disabled'),
    sessionsDir: path.join(root, 'sessions'),
    sessionFile: (id) => path.join(root, 'sessions', `${id}.json`),
    themesDir: path.join(root, 'themes'),
    theme: path.join(root, 'theme.json'),
    profiles: path.join(root, 'profiles'),
    components: path.join(root, 'components'), // user-tier components (Phase 5)
    // Service consent records, keyed by the sha256 of service.js. User-tier so a
    // project cannot forge its own approval — see the note in projectPaths.
    servicesDir: path.join(root, 'services'),
    trustedServices: path.join(root, 'services', 'trusted.json'),
    hubLog: path.join(root, 'hub.log'),
    instances: path.join(root, 'instances.json'),
    updateCheck: path.join(root, 'update-check.json'),
    // Which projects have been through `claude-web-chat init` (and seen the
    // surface tour). User-tier, so the SECOND project you install into is quiet
    // instead of re-teaching you the surface.
    onboarded: path.join(root, 'onboarded.json'),
  };
}

// ─────────────────────────────────────────────────────────────── install tier ──
// Where a RELEASE of this package lives once installed. Distribution is GitHub
// Releases: `install.sh` and `claude-web-chat update` unpack a self-contained
// tarball into ~/.web-chat/versions/<version>/, point the ~/.web-chat/current
// symlink at it, and symlink the three bins into ~/.local/bin.
//
//   ~/.web-chat/versions/0.5.0/   the unpacked release (code + node_modules)
//   ~/.web-chat/current      ->   versions/0.5.0        (rollback = symlink swap)
//   ~/.local/bin/claude-web-chat -> ~/.web-chat/current/bin/claude-web-chat.js
//
// npm is not involved at any point. A global npm prefix is a shared mutable
// directory: any later `npm i -g` silently rewrites whatever else lives there
// (this is not hypothetical — it replaced a maintainer's `npm link` with a
// 16-day-old copy). A per-version directory owned by one program cannot be
// clobbered that way, and `describeInstall` in lib/update/install-layout.js can
// always answer "which tree is the `claude-web-chat` on your PATH actually
// running?" — the question that failure made unanswerable.
//
// No sudo, ever: both the version store and the bin dir are under $HOME.
const BIN_NAMES = ['claude-web-chat', 'claude-web-chat-mcp', 'claude-web-chat-hook'];
// How many unpacked versions to keep after an update. Enough that rollback is a
// symlink swap for the last few builds; bounded so the store cannot grow forever.
const KEEP_VERSIONS = 3;

// Install-tier paths. Pure — no fs.
function installPaths() {
  const home = homeDir();
  const root = path.join(home, WEB_CHAT_DIRNAME);
  const versions = path.join(root, 'versions');
  const binDir = path.join(home, '.local', 'bin');
  return {
    home,
    root,
    versions,
    versionDir: (v) => path.join(versions, String(v)),
    current: path.join(root, 'current'),
    // The bin file inside a release that each PATH symlink points at.
    currentBin: (name) => path.join(root, 'current', 'bin', `${name}.js`),
    binDir,
    binLink: (name) => path.join(binDir, name),
    BIN_NAMES,
    KEEP_VERSIONS,
  };
}

// The mkdir side-effect resolvePaths() ran on every boot, made explicit. Creates
// the project dirs that must exist before use; never touches ~/.web-chat (system
// theme/profile dirs are created lazily on first save).
function ensureProjectDirs(p) {
  fs.mkdirSync(p.components, { recursive: true });
  fs.mkdirSync(p.services, { recursive: true });
  fs.mkdirSync(p.graphDir, { recursive: true });
  fs.mkdirSync(p.captures, { recursive: true });
  fs.mkdirSync(p.themesDir, { recursive: true });
  fs.mkdirSync(p.profiles, { recursive: true });
}

module.exports = {
  WEB_CHAT_DIRNAME,
  PUBLIC_DIR,
  PACKAGE_ROOT,
  BIN_NAMES,
  KEEP_VERSIONS,
  homeDir,
  findProjectRoot,
  resolveWebChatDir,
  projectPaths,
  userPaths,
  installPaths,
  ensureProjectDirs,
};

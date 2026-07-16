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
    trustedServices: path.join(dir, 'services', 'trusted.json'),
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

// User-global state under ~/.web-chat/. Pure — no fs. Holds the ONE home lookup.
function userPaths() {
  const root = path.join(os.homedir(), WEB_CHAT_DIRNAME);
  return {
    root,
    disabled: path.join(root, 'disabled'),
    sessionsDir: path.join(root, 'sessions'),
    sessionFile: (id) => path.join(root, 'sessions', `${id}.json`),
    themesDir: path.join(root, 'themes'),
    theme: path.join(root, 'theme.json'),
    profiles: path.join(root, 'profiles'),
    components: path.join(root, 'components'), // user-tier components (Phase 5)
    hubLog: path.join(root, 'hub.log'),
    instances: path.join(root, 'instances.json'),
    updateCheck: path.join(root, 'update-check.json'),
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

module.exports = { WEB_CHAT_DIRNAME, PUBLIC_DIR, findProjectRoot, resolveWebChatDir, projectPaths, userPaths, ensureProjectDirs };

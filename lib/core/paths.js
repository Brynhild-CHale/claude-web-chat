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
// Likewise for Claude Code's own per-project directory. web-chat writes four
// managed files into it (rules, slash command, two skills), reads its
// settings.json to register hooks, and — since component packs — installs a
// pack's SKILL.md under skills/<pack>/. That was six hand-built
// `path.join(root, '.claude')` sites before packs would have made it seven.
const CLAUDE_DIRNAME = '.claude';
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
  // $HOME/.web-chat is the USER tier — the same directory name, a completely
  // different thing. install.sh creates it on every machine (it holds
  // versions/, current, the instance registry, service trust), so without this
  // guard the upward walk terminates at $HOME for EVERY uninitialised directory
  // beneath it. `claude-web-chat init` in a fresh ~/code/my-app then resolved
  // its root to $HOME, took the existing-install branch, skipped the first-run
  // consent entirely, and configured the whole machine: hooks in
  // ~/.claude/settings.json that fire in every project, a ~/.mcp.json, and a
  // daemon rooted at the home directory.
  //
  // A deliberate install there is refused as well: since 0.8 no daemon can be
  // rooted at $HOME, so `init` and `install` ask isHomeDir before writing and
  // stop. (`uninstall` typed in ~ still removes a 0.7.x home install — it
  // goes by the wiring it finds, not by this walk.)
  while (true) {
    if (!isHomeDir(dir) && fs.existsSync(path.join(dir, WEB_CHAT_DIRNAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Is `dir` the home directory — literally or by real path? Its .web-chat/ is
// the USER tier, so it is never a project: findProjectRoot never walks to it and
// the known-projects list never records it. By real path as well, because
// process.cwd() comes back resolved: on a machine whose $HOME is reached through
// a symlink (macOS's /var → /private/var temp dirs, a relocated home) the
// literal comparison never matched, and a daemon started IN $HOME was rooted
// there after all.
//
// The NATIVE realpath, on both sides: it also returns the on-disk case, which
// the JS one does not. On a case-insensitive volume (APFS's default) a HOME
// spelled /Users/Me for /Users/me names the same directory, and the JS realpath
// hands each spelling back as given — so the guard failed open, a fresh
// ~/code/new resolved its root to $HOME, and `open` there booted a daemon the
// portal could later start. isInside's realpath below is left alone: a fence
// asks about containment, and its callers pass paths off the same walk.
function isHomeDir(dir) {
  let home;
  try { home = path.resolve(homeDir()); } catch { return false; }
  const abs = path.resolve(dir);
  if (abs === home) return true;
  const real = realpathNative(abs);
  return real !== null && real === realpathNative(home);
}

function realpathNative(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

// The .web-chat dir for a starting point, falling back to startDir/.web-chat when
// no installed root is found up-tree (for commands that may create a fresh install
// at the current location).
function resolveWebChatDir(startDir = process.cwd()) {
  const root = findProjectRoot(startDir) || path.resolve(startDir);
  return path.join(root, WEB_CHAT_DIRNAME);
}

// ─────────────────────────────────────────────────────────── containment ──
// "Is this path inside that directory?" is the question every fence in this
// program asks — the pack staging walk, the pack-record unlink, the updater's
// managed-file reconcile, the file-editor service's project fence. It had one
// correct implementation, and it lived in lib/update/install-layout.js, so the
// pack pipeline's SECURITY walk imported the updater to ask it. A helper two
// layers need belongs in the lower one; this is the lower one.
//
// Fails CLOSED, and that has a sharp edge worth knowing: a child that does not
// exist yet cannot be realpath'd, so under a parent that IS reached through a
// symlink (macOS $TMPDIR, /home on some distros) the two sides resolve
// differently and the answer is `false`. This asks about the filesystem, not
// about strings. To fence a path you are about to CREATE, check the shape of
// the relative part lexically instead (lib/packs does both: shape first, then
// this for anything already on disk).

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// Is `child` inside `parent`? Both sides go through realpath when they exist,
// because one may reach the same directory through a symlink and the other not
// — on macOS $TMPDIR is /var/folders/… which is really /private/var/folders/…,
// and a purely lexical compare then says a tree is NOT where it plainly is.
// The corollary is the security-relevant half: a symlink that POINTS OUT of
// `parent` resolves out and is refused, which a lexical compare would allow.
// Separator guard so ".../versions" does not match ".../versions-backup".
function isInside(parent, child) {
  if (!parent || !child) return false;
  const a = realpath(parent) || path.resolve(parent);
  const b = realpath(child) || path.resolve(child);
  return b === a || b.startsWith(a + path.sep);
}

// The nearest ancestor of `p` that EXISTS — what a fence can realpath when the
// path itself is about to be created. Walks up to the filesystem root at worst.
//
// `follow` decides WHICH question "exists" is, and the two answers differ on
// exactly one entry: a DANGLING SYMLINK. `existsSync` follows links, so it
// reports one as absent and the walk steps straight past it (`follow:true`, the
// default — right for a copier asking "where will this land, is that inside my
// tree"). `lstat` reports it as present, which is what a FENCE has to ask: the
// link is a real entry, and a write through it lands at its target, which is
// wherever the link points. See `fence`.
function nearestExisting(p, { follow = true } = {}) {
  const present = follow
    ? (q) => fs.existsSync(q)
    : (q) => { try { fs.lstatSync(q); return true; } catch { return false; } };
  let cur = path.resolve(p);
  for (;;) {
    if (present(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

// Fence a path the program was HANDED — a store value, a form field, a record
// on disk — against the directory it must stay inside. `isInside` on its own
// cannot do this job, for the reason stated above it: it asks the filesystem,
// and the file you are about to create is not on the filesystem yet. So ask
// both questions, which is exactly what the sharp-edge note tells callers to do:
//
//   1. the SHAPE of the relative part, lexically — refuses `../../etc/passwd`
//      whether or not anything along it exists; and
//   2. `isInside` anchored at the nearest entry that DOES exist — refuses a
//      symlink pointing out of the fence, the half a lexical check cannot see,
//      because readFile/writeFile follow links.
//
// The anchor is found BY LSTAT (`follow:false`), and that is the whole of the
// dangling-symlink case: `root/notes.txt -> /outside/notes.txt` with nothing at
// the target reads as "not created yet" to `existsSync`, so a walk that follows
// links steps over the link, anchors at `root`, and answers "inside" — and then
// the caller's `writeFileSync` CREATES the file at the target, outside the
// fence. An anchor that exists to lstat but has no realpath is a link we cannot
// resolve; nothing legitimate reads or writes through one, so it is refused.
//
// Returns the resolved absolute path, NOT its realpath: callers display it
// relative to `parent`, and a realpath would read as a different tree whenever
// `parent` is itself reached through a link (macOS $TMPDIR, a symlinked /home).
// Returns null when `child` escapes — fail closed, and leave the caller to
// phrase the refusal.
function fence(parent, child) {
  if (!parent) return null;
  const base = path.resolve(parent);
  const abs = path.resolve(base, child == null ? '' : String(child));
  const rel = path.relative(base, abs);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  const anchor = nearestExisting(abs, { follow: false });
  if (!realpath(anchor)) return null; // exists to lstat, resolves nowhere: a dangling link
  return isInside(base, anchor) ? abs : null;
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
    // An installed theme pack's logos, beside its <name>.json in the project
    // theme library (whose loader skips directories). lib/packs writes them;
    // lib/server/brand.js reads them to fill the project's empty brand slots.
    themeLogosDir: (name) => path.join(dir, 'themes', name, 'logos'),
    theme: path.join(dir, 'theme.json'),
    // The pack a project falls back to when neither theme.json names one — the
    // LAST step of lib/server/theme resolveDefault. Written once, by the
    // migration runner, for a project born on this build (Georgetown Blue); a
    // project that pre-dates it has none and keeps today's look (Earthy).
    themeDefault: path.join(dir, 'theme-default.json'),
    profiles: path.join(dir, 'profiles'),
    exports: path.join(dir, 'exports'),
    // Per-project brand images (logotype / lockup / seal), one file per slot —
    // lib/server/brand.js is the only reader and writer.
    brandDir: path.join(dir, 'brand'),
    // Scratch space for a process the daemon drives — today the throwaway
    // browser profile of a headless replay render (lib/replay/chrome.js). Each
    // user makes its own subdirectory and removes it when done.
    tmp: path.join(dir, 'tmp'),
    version: path.join(dir, '_version.json'),
    // Component packs. `packs` is the provenance RECORD (one per tier: every
    // installed pack, its source, and the sha256 of every file it wrote, so a
    // remove is exact and drift is detectable). `packsDir` holds everything
    // else: the quarantine staging area, the undo journal's snapshots, the
    // in-flight install marker, and the append-only audit log.
    //
    // Nothing reads packsDir as a component/skill/theme source — that is what
    // makes quarantine inert BY LOCATION rather than by a flag someone has to
    // remember to check.
    packs: path.join(dir, 'packs.json'),
    packsDir: path.join(dir, 'packs'),
    quarantine: path.join(dir, 'packs', 'quarantine'),
    // Where the install transaction copies a file it is about to overwrite, so
    // a failed apply restores the previous bytes instead of unlinking them.
    packsBackup: path.join(dir, 'packs', 'backup'),
    // An install that started and did not finish. Deliberately its OWN file and
    // not a key in packs.json: `ownerOf`, `verifyPack`, `pack list` and
    // GET /api/packs all read the record store, and a half-install parked there
    // would read as INSTALLED — refusing the retry as a collision, and chipping
    // "locally edited" in the drawer for files that were never written.
    packsPending: path.join(dir, 'packs', 'pending.json'),
    packsAudit: path.join(dir, 'packs', 'audit.log'),
    managed: path.join(dir, 'managed.json'),
    disabled: path.join(dir, 'disabled'),
    // The per-project remote-access opt-out: while it exists, the tunnel portal
    // hides this project from its picker and refuses its hostname. Project-tier
    // on purpose — it can only NARROW what the user-tier tunnel.json exposes, so
    // a repository that ships one costs nothing, and none can ship the opposite.
    noRemote: path.join(dir, 'no-remote'),
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

// A JSON-shaped value with every mention of this host's layout masked: the
// project root becomes `<project>` and the home directory `~`, in every string
// at any depth (a record field, a path inside an error message). For the few
// read routes a REMOTE viewer may reach that would otherwise say where the
// project and the user live — the portal's picker withholds roots unless the
// operator opts in, and these must not hand them out behind its back. Both
// spellings of each directory are masked (as given, and through realpath —
// macOS's /var vs /private/var). Returns a copy; the input is not touched.
function redactHostPaths(value, { root = null, home = homeDir() } = {}) {
  const swaps = [];
  for (const [dir, mask] of [[root, '<project>'], [home, '~']]) {
    if (!dir || dir === path.sep) continue;
    for (const d of new Set([dir, realpath(dir)])) if (d && d !== path.sep) swaps.push([d, mask]);
  }
  // Longest first, so a root inside home is masked as the project, not ~/…
  swaps.sort((a, b) => b[0].length - a[0].length);
  const walk = (v) => {
    if (typeof v === 'string') return swaps.reduce((s, [d, mask]) => s.split(d).join(mask), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
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
    // A theme's per-user logos, beside the system theme library (whose loader
    // skips directories): a builtin pack's quiet folder, or a theme pack
    // installed with --global (lib/packs writes those). lib/server/brand.js
    // reads them to fill a project's empty brand slots.
    themeLogosDir: (pack) => path.join(root, 'themes', pack, 'logos'),
    profiles: path.join(root, 'profiles'),
    components: path.join(root, 'components'), // user-tier components (Phase 5)
    // Service consent records, keyed by the sha256 of service.js. User-tier so a
    // project cannot forge its own approval — see the note in projectPaths.
    servicesDir: path.join(root, 'services'),
    trustedServices: path.join(root, 'services', 'trusted.json'),
    hubLog: path.join(root, 'hub.log'),
    instances: path.join(root, 'instances.json'),
    // Every project whose daemon has booted on this machine (lib/util/registry
    // rememberProject / sessions()): what lets `ls --all`, the Sessions panel
    // and the portal picker list a project whose surface is stopped, and the
    // portal start one it already knows — never an arbitrary path.
    projects: path.join(root, 'projects.json'),
    updateCheck: path.join(root, 'update-check.json'),
    // Which projects have been through `claude-web-chat init` (and seen the
    // surface tour). User-tier, so the SECOND project you install into is quiet
    // instead of re-teaching you the surface.
    onboarded: path.join(root, 'onboarded.json'),
    // The user tier of the pack record. It holds two different things:
    //   * packs installed with --global (components in ~/.web-chat/components,
    //     skill in ~/.claude/skills), and
    //   * the integrity record for EVERY quarantined pack, whichever tier it is
    //     destined for.
    // The second is here for the reason already codified above for service
    // trust: a repository can commit a plausible-looking
    // .web-chat/packs/quarantine/ tree, so `approve` re-hashes the staged files
    // and refuses unless a record THIS MACHINE wrote matches. A consent record
    // must never be writable by the thing asking for consent.
    packs: path.join(root, 'packs.json'),
    packsDir: path.join(root, 'packs'),
    quarantine: path.join(root, 'packs', 'quarantine'),
    packsBackup: path.join(root, 'packs', 'backup'),
    packsPending: path.join(root, 'packs', 'pending.json'),
    packsAudit: path.join(root, 'packs', 'audit.log'),
    // Remote access (the Cloudflare tunnel + the lib/portal process in front of
    // it). User-tier and one per machine, like the hub: the portal serves every
    // project's surface under one hostname, and its config is an access-control
    // list (who may reach this machine's surfaces) that no repository may ship.
    // `tunnelToken` is the cloudflared connector token — a secret, kept in its
    // own 0600 file rather than inside tunnel.json so the config can be shown,
    // diffed and logged without it.
    tunnelDir: path.join(root, 'tunnel'),
    tunnelConfig: path.join(root, 'tunnel', 'tunnel.json'),
    tunnelToken: path.join(root, 'tunnel', 'token'),
    cloudflaredConfig: path.join(root, 'tunnel', 'cloudflared.yml'),
    cloudflaredLog: path.join(root, 'tunnel', 'cloudflared.log'),
    // The connector the portal is running: { pid, portal_pid, metrics,
    // started_at }. What lets the NEXT portal recognise, and stop, one left
    // behind by a portal that was killed outright (lib/tunnel/cloudflared).
    cloudflaredPid: path.join(root, 'tunnel', 'cloudflared.pid.json'),
    portalLog: path.join(root, 'tunnel', 'portal.log'),
    remoteAccessLog: path.join(root, 'tunnel', 'remote-access.log'),
  };
}

// ──────────────────────────────────────────────────────────── .claude tier ──
// Claude Code's project directory. Pure — no fs. `rel()` returns the
// repo-relative POSIX form (`.claude/skills/foo/SKILL.md`), which is what the
// managed-file reconcile stores as a dest and prints in its status output.
function claudePaths(root) {
  const dir = path.join(root, CLAUDE_DIRNAME);
  return {
    root,
    dir,
    settings: path.join(dir, 'settings.json'),
    rulesDir: path.join(dir, 'rules'),
    commandsDir: path.join(dir, 'commands'),
    skillsDir: path.join(dir, 'skills'),
    skillDir: (name) => path.join(dir, 'skills', name),
    skill: (name) => path.join(dir, 'skills', name, 'SKILL.md'),
    rel: (...parts) => [CLAUDE_DIRNAME, ...parts].join('/'),
  };
}

// The user tier of the same, for a `--global` pack: a skill installed at
// ~/.claude/skills/<pack>/ is visible to Claude Code in every project, matching
// where --global puts the components it describes. Goes through the ONE homeDir().
function userClaudePaths() {
  return claudePaths(homeDir());
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
    // Where a version came from, when it did not come from GitHub: `update
    // --from <tarball>` writes { source:'local', tarball, sha256, installed_at }
    // here, and `version` / `update --list` read it back. Inside the version's
    // own directory so it is pruned and removed with the version.
    installRecord: (v) => path.join(versions, String(v), '.install-source.json'),
    // Where a download is unpacked before it is renamed into versions/<v>. A
    // SIBLING of the version store, not a directory inside it: staging used to
    // happen under versions/ (so the final move stays a same-filesystem rename),
    // and an interrupted download therefore left a `wc-release-XXXXXX/` that
    // listVersions ranked as a version — printed by `update --list`, and ordered
    // ABOVE every real release by the comparator's non-numeric fallback.
    staging: path.join(root, 'staging'),
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
  CLAUDE_DIRNAME,
  PUBLIC_DIR,
  PACKAGE_ROOT,
  BIN_NAMES,
  KEEP_VERSIONS,
  homeDir,
  redactHostPaths,
  realpath,
  isHomeDir,
  isInside,
  nearestExisting,
  fence,
  findProjectRoot,
  resolveWebChatDir,
  projectPaths,
  userPaths,
  claudePaths,
  userClaudePaths,
  installPaths,
  ensureProjectDirs,
};

// `claude-web-chat update` — take the latest GitHub Release, or roll back to a
// version still on disk.
//
// There is NO npm here, deliberately. A global npm prefix is a shared mutable
// directory: an unrelated `npm i -g` replaced a maintainer's `npm link` with a
// copied build from 16 days earlier, so the command on their PATH was ancient
// while every test in their checkout passed. Nothing said so, for two weeks.
// Updates now rewrite ~/.web-chat/versions/, a directory this program alone
// owns, and this command REFUSES to run at all unless the code it is running
// from lives there — see the guard below, which is the whole point of the
// change. Rollback is a symlink swap (`--to <version>`), because the previous
// versions are still unpacked.
//
// Order matters: download → verify checksum → unpack to staging → move into
// versions/<v> → flip `current` atomically → relink bins. Nothing before the
// flip can leave you with a broken install.

const fs = require('fs');
const path = require('path');
const { clearCache, compareVersions } = require('../../update/check');
const { fetchLatestRelease, fetchAndUnpack } = require('../../update/release');
const { describeInstall, listVersions, activate, linkBins, pruneVersions, onPath } = require('../../update/install-layout');
const { INSTALL_SH_URL, releaseTagUrl } = require('../../core/versions');
const { installPaths } = require('../../core/paths');
const { printResults } = require('../../update/managed-files');
const { resolveRoot } = require('../../setup/registration');

function parseArgs(args = []) {
  const out = { to: null, list: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--to' || a === '--to-version') out.to = args[++i] || null;
    else if (a.startsWith('--to=')) out.to = a.slice(5);
    else if (a === '--list' || a === '--versions') out.list = true;
    else if (a === '--force' || a === '-f') out.force = true;
  }
  if (out.to) out.to = String(out.to).replace(/^v/, '');
  return out;
}

// The guard. Loud on purpose: a silent no-op here is exactly how the failure
// this whole layout exists to prevent went unnoticed for two weeks.
function refuse(info, log) {
  const bar = '─'.repeat(72);
  log('');
  log(bar);
  log('  REFUSING TO UPDATE — this is not a managed install.');
  log(bar);
  log('');
  log(`  Running from: ${info.packageRoot}`);
  log(`  Version:      v${info.version || '?'}`);
  log('');
  if (info.kind === 'dev') {
    log('  That is a GIT CHECKOUT, not a release unpacked under ~/.web-chat/versions/.');
    log(`  Its working copy is ${info.gitRoot}.`);
    log('');
    log('  Update a checkout with git, not with this command:');
    log('');
    log(`    cd ${info.gitRoot} && git pull && npm install`);
    log('');
    log('  (Overwriting a checkout with a release tarball would throw away your work,');
    log('   and updating ~/.web-chat/versions/ instead would change nothing you run.)');
  } else {
    log('  It is neither a release under ~/.web-chat/versions/ nor a git checkout —');
    log('  most likely a leftover global npm install, which this program no longer');
    log('  uses or maintains. npm\'s global prefix is shared and gets clobbered by');
    log('  unrelated installs; that is why distribution moved off it.');
    log('');
    log('  Install the managed version, then use that one:');
    log('');
    log('    npm rm -g claude-web-chat        # if npm still has one');
    log(`    curl -fsSL ${INSTALL_SH_URL} | sh`);
  }
  log('');
  if (info.linkTarget) {
    log(`  For reference, the \`claude-web-chat\` on your PATH is:`);
    log(`    ${info.linkPath} -> ${info.linkTarget}  (v${info.linkVersion || '?'})`);
    log('');
  }
  log(bar);
  log('');
}

// The other half of the same failure: something on PATH claims to be this
// program and resolves somewhere else. Worth a shout even when we CAN proceed.
function warnMismatch(info, log) {
  if (!info.linkMismatch) return;
  log('');
  log('  ⚠ The `claude-web-chat` on your PATH is NOT the tree this command is running from:');
  log(`      on PATH:  ${info.linkPath} -> ${info.linkTarget}  (v${info.linkVersion || '?'})`);
  log(`      running:  ${info.packageRoot}  (v${info.version || '?'})`);
  log('    Whatever this update does, your next `claude-web-chat` may not be it.');
  log('');
}

async function update(args = [], deps = {}) {
  const log = deps.log || ((m = '') => console.log(m));
  const errlog = deps.errlog || ((m = '') => console.error(m));
  const exit = deps.exit || ((c) => process.exit(c));
  const paths = deps.paths || installPaths();
  const info = (deps.describeInstall || describeInstall)({ paths });
  const flags = parseArgs(args);

  // `--list` works from anywhere — it is a read-only "what do I have?".
  if (flags.list) {
    const versions = listVersions(paths);
    log(`claude-web-chat versions under ${paths.versions}:`);
    if (!versions.length) log('  (none — this is not a managed install)');
    for (const v of versions) {
      const marker = info.currentVersion === v ? '  ← current' : '';
      log(`  v${v}${marker}`);
    }
    log('');
    log('Roll back with: claude-web-chat update --to <version>');
    return { listed: versions };
  }

  if (info.kind !== 'managed') {
    refuse(info, errlog);
    exit(1);
    return { refused: true, kind: info.kind };
  }
  warnMismatch(info, log);

  const before = info.version;
  let target;

  // ── rollback: any version still unpacked on disk, no network involved.
  if (flags.to) {
    const versions = listVersions(paths);
    if (!versions.includes(flags.to)) {
      errlog(`v${flags.to} is not unpacked under ${paths.versions}.`);
      errlog(`Available: ${versions.length ? versions.map((v) => `v${v}`).join(', ') : '(none)'}`);
      errlog('Only versions still on disk can be rolled back to — an older one has to be reinstalled.');
      exit(1);
      return { refused: true, reason: 'unknown-version' };
    }
    target = flags.to;
    log(`Rolling back to v${target} (already on disk — no download needed).`);
  } else {
    // ── the normal path: ask GitHub what the latest release is.
    log(`Current version: v${before}`);
    log('Checking GitHub Releases...');
    const release = await (deps.fetchLatestRelease || fetchLatestRelease)();
    if (!release) {
      errlog('No published release found (or GitHub is unreachable). Nothing to do.');
      exit(1);
      return { refused: true, reason: 'no-release' };
    }
    const cmp = compareVersions(release.version, before);
    if (cmp <= 0 && !flags.force) {
      log(cmp === 0
        ? `Already on the latest release (v${before}).`
        : `Your build (v${before}) is newer than the latest release (v${release.version}); not downgrading.`);
      log('Use --force to install it anyway, or --to <version> to roll back to a version on disk.');
      clearCache();
      return { unchanged: true, latest: release.version };
    }
    log(`Latest release: v${release.version}`);
    // Stage inside the version store so the final move into place is a rename on
    // the same filesystem rather than a cross-device copy.
    fs.mkdirSync(paths.versions, { recursive: true });
    try {
      await (deps.fetchAndUnpack || fetchAndUnpack)({
        release,
        versionDir: paths.versionDir(release.version),
        tmpDir: paths.versions,
        log,
      });
    } catch (e) {
      // A failed or tampered download is an ordinary outcome, not a crash. Say
      // what happened in one readable block and stop — `current` has not moved,
      // so the install the user has is exactly the one they had a moment ago.
      errlog('');
      errlog(`Update failed: ${e.message}`);
      errlog('');
      errlog(`Nothing was changed — you are still on v${before} (${paths.current} -> versions/${info.currentVersion || before}).`);
      errlog('Try again later, or download the release by hand from');
      errlog(`  ${releaseTagUrl(release.tag)}`);
      exit(1);
      return { failed: true, error: e.message };
    }
    target = release.version;
  }

  // ── flip. Atomic: `current` never briefly points at nothing.
  (deps.activate || activate)(target, paths);
  const rows = (deps.linkBins || linkBins)(paths);
  log(`Activated v${target}  (${paths.current} -> versions/${target})`);
  for (const r of rows) {
    if (r.action !== 'ok') log(`  ${r.action} ${r.link}`);
  }
  if (!onPath(paths.binDir)) {
    log('');
    log(`  ⚠ ${paths.binDir} is not on your PATH. Add to your shell profile:`);
    log(`      export PATH="${paths.binDir}:$PATH"`);
    log('');
  }

  const removed = (deps.pruneVersions || pruneVersions)({ paths });
  if (removed.length) log(`Pruned old versions: ${removed.map((v) => `v${v}`).join(', ')}`);

  log(before === target ? `Reinstalled v${target}.` : `Updated: v${before} → v${target}.`);
  clearCache();

  // Auto-propagate safe template changes to the existing install. Edit-
  // preserving: safe updates apply, local edits are kept, conflicts surface as
  // .new sidecars (see lib/update/managed-files.js).
  // The root walk is this build's (it is just findProjectRoot); the SYNC is the
  // new build's, loaded out of versions/<target> the way loadRestart loads
  // restart. This process started from the version being replaced, and
  // templatesDir() is __dirname-relative — so the sync used to compare the
  // project against the OLD templates and report every file 'up-to-date'. The
  // new rules, skills and hook template only landed on some later `install`.
  const root = resolveRoot(process.cwd(), { mode: 'optional' }).root;
  if (root) {
    log('');
    log('Syncing managed files...');
    // The sync stays inside the PROJECT. apply() completes a `.mcp.json` entry
    // that cannot resolve here by shelling out to `claude mcp add … --scope
    // local` — that is `install`'s and `doctor`'s job, and it writes Claude
    // Code's own config, outside this project. Doing it silently in the middle
    // of an upgrade is not something `update` has ever done, so the engine gets
    // a runClaude that RECORDS the command instead of running it and we print
    // it for the user to run deliberately.
    let localScope = null;
    const recordClaude = (argv) => { localScope = argv; return { ok: false, stderr: 'not attempted by update' }; };
    try {
      const applied = (deps.registration || loadRegistration(paths, target, errlog))
        .apply(root, { force: false, runClaude: recordClaude });
      const results = (applied && applied.managed) || [];
      printResults(results);
      const conflicts = results.filter((x) => x.action === 'conflict');
      if (conflicts.length) {
        log(`  ⚠ ${conflicts.length} conflict(s): shipped updates written as .new sidecars — review and merge.`);
      }
      if (localScope) {
        log(`  ⚠ this project's .mcp.json entry cannot resolve here (a plugin stub outside a plugin install).`);
        log(`    To let Claude Code spawn web-chat anyway, run: claude ${localScope.join(' ')}`);
      }
    } catch (e) {
      errlog(`  managed-file sync skipped: ${e.message}`);
    }
  }

  log('');
  log('Restarting bg server...');
  await (deps.restart || loadRestart(paths, target))(args);
  return { before, after: target };
}

// Restart the daemon using the NEWLY INSTALLED build's own `restart`.
//
// This process started from the OLD version, and `restart` spawns the daemon
// from a path derived from its own module location — so calling the copy already
// loaded into this process would start the daemon on the code we just replaced,
// and the update would look like it worked while changing nothing that runs.
// Requiring the new version's module instead gets the new daemon, while still
// being the same exported `restart(args)` the CLI itself calls: no
// reimplementation, no shelling out.
//
// Resolve through versions/<target>, NOT through ~/.web-chat/current — even
// though we just pointed `current` at the same place. Node's module loader keeps
// a realpath cache, and this process resolved `current` at startup (the bin on
// PATH points through it), back when it meant the OLD version. Requiring
// `current/...` therefore hands back the old file from cache, silently. That is
// the same class of bug as the stale global install this whole layout exists to
// prevent, so it is worth the extra argument to sidestep.
function loadRestart(paths, version) {
  const fresh = path.join(paths.versionDir(version), 'lib', 'cli', 'commands', 'restart.js');
  try {
    if (fs.existsSync(fresh)) {
      const fn = require(fresh);
      if (typeof fn === 'function') return fn;
    }
  } catch (e) {
    console.error(`  (could not load v${version}'s restart: ${e.message} — using this build's)`);
  }
  return require('./restart');
}

// Sync managed files with the NEWLY INSTALLED build's registration engine, for
// the same reason loadRestart loads the new build's restart: this process was
// started from the version being replaced, and every template path in it is
// __dirname-relative. Requiring versions/<target> (never ~/.web-chat/current —
// Node's realpath cache resolved that to the OLD version at startup) is what
// makes "sync managed files" propagate anything at all.
//
// The fallback is deliberately LOUD. The call site is inside a try/catch that
// degrades to "managed-file sync skipped", so a silent fallback would look
// exactly like a successful no-op sync — the failure mode this fix exists to
// remove. The engine's export surface is small and additive for the same
// reason: an old `update` loading a new engine must still find apply().
function loadRegistration(paths, version, errlog = (m) => console.error(m)) {
  const fresh = path.join(paths.versionDir(version), 'lib', 'setup', 'registration.js');
  try {
    if (!fs.existsSync(fresh)) {
      errlog(`  (v${version} ships no registration engine — syncing with THIS build's templates, which may be older)`);
    } else {
      const mod = require(fresh);
      if (mod && typeof mod.apply === 'function') return mod;
      errlog(`  (v${version}'s registration engine has no apply() — syncing with THIS build's templates, which may be older)`);
    }
  } catch (e) {
    errlog(`  (could not load v${version}'s registration engine: ${e.message} — syncing with THIS build's templates, which may be older)`);
  }
  return require('../../setup/registration');
}

module.exports = update;
module.exports.parseArgs = parseArgs;
module.exports.loadRestart = loadRestart;
module.exports.loadRegistration = loadRegistration;

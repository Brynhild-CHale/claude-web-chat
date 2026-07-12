const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clearCache } = require('../../update/check');
const { findProjectRoot } = require('../../util/root');
const {
  reconcileManagedFiles,
  ensureMcpRegistration,
  ensureHooks,
  printResults,
} = require('../../update/managed-files');

// Distribution is the public git repo, not the npm
// registry. A branch-less `git+https` URL installs the repo's default branch, so
// `update` just re-runs the global git install to pull the latest build. The
// registry is never involved.
const GIT_INSTALL_URL = 'git+https://github.com/Brynhild-CHale/claude-web-chat.git';

// Version of the globally-installed claude-web-chat. Read AFTER the install this
// reflects the freshly-pulled build (not the registry). Returns null if it can't
// be resolved (npm missing, unusual layout) — reporting is best-effort.
function installedGlobalVersion() {
  try {
    const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return null;
    const pkgPath = path.join(r.stdout.trim(), 'claude-web-chat', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
  } catch {
    return null;
  }
}

function update(args) {
  // "before" is whatever version is currently running (this process's package).
  const before = require('../../../package.json').version;
  console.log(`Current version: v${before}`);
  console.log(`Running: npm i -g ${GIT_INSTALL_URL}`);
  const r = spawnSync('npm', ['i', '-g', GIT_INSTALL_URL], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('npm install failed');
    process.exit(1);
  }

  // "after" comes from the freshly-installed package on disk, not the registry.
  const after = installedGlobalVersion();
  if (after) {
    console.log(after === before
      ? `Already on the latest build (v${after}).`
      : `Updated: v${before} → v${after}.`);
  }

  clearCache();
  console.log('Cleared throttle cache.');

  // Auto-propagate safe template changes to the existing install. Edit-
  // preserving: safe updates apply, local edits are kept, conflicts surface as
  // .new sidecars (see lib/update/managed-files.js).
  const root = findProjectRoot(process.cwd());
  if (root) {
    console.log();
    console.log('Syncing managed files...');
    try {
      const results = reconcileManagedFiles(root, { force: false });
      printResults(results);
      ensureHooks(root);
      ensureMcpRegistration(root);
      const conflicts = results.filter(x => x.action === 'conflict');
      if (conflicts.length) {
        console.log(`  ⚠ ${conflicts.length} conflict(s): shipped updates written as .new sidecars — review and merge.`);
      }
    } catch (e) {
      console.error(`  managed-file sync skipped: ${e.message}`);
    }
  }

  console.log();
  console.log('Restarting bg server...');
  require('./restart')(args);
}

module.exports = update;

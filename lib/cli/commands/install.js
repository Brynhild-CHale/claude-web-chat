const {
  ensureHooks,
  ensureMcpRegistration,
  reconcileManagedFiles,
  printResults,
} = require('../../update/managed-files');
const { projectPaths, ensureProjectDirs } = require('../../core/paths');
const { run: runMigrations } = require('../../update/migrations');
const { spawnDaemonProcess } = require('../../util/daemon');
const { LAUNCH_COMMAND } = require('../../core/channels');

function install(args = []) {
  const force = args.includes('--force');
  const root = process.cwd();

  // 1. .web-chat/ + _version.json. Create the state dirs first, THEN stamp the
  // version through the migration runner — the same single writer the server boot
  // uses. (dir-first: the runner early-returns on a missing stateDir.) This kills
  // the old two-writer divergence where ensureVersionFile hardcoded {version:1}.
  const paths = projectPaths(root);
  ensureProjectDirs(paths);
  runMigrations(paths.dir);

  // 2. Merge hooks into .claude/settings.json
  let addedHooks;
  try {
    addedHooks = ensureHooks(root);
  } catch (e) {
    if (e.userFacing) { console.error(e.message); process.exit(1); }
    throw e;
  }

  // 3. Reconcile the managed template files (edit-preserving 3-way sync).
  const results = reconcileManagedFiles(root, { force });

  // 4. Register the MCP server in .mcp.json
  let mcpStatus;
  try {
    mcpStatus = ensureMcpRegistration(root);
  } catch (e) {
    if (e.userFacing) { console.error(e.message); process.exit(1); }
    throw e;
  }

  console.log(`web-chat installed for ${root}`);
  console.log(`  .web-chat/                          ready`);
  console.log(`  .claude/settings.json               ${addedHooks > 0 ? `${addedHooks} hook(s) added` : 'already up to date'}`);
  printResults(results);
  console.log(`  .mcp.json                           ${mcpStatus}`);

  const conflicts = results.filter(r => r.action === 'conflict');
  const differs = results.filter(r => r.action === 'differs');
  if (conflicts.length) {
    console.log();
    console.log(`  ⚠ ${conflicts.length} conflict(s): shipped updates written as .new sidecars next to your edited files.`);
    console.log(`    Review and merge, then re-run install (or \`--force\` to take the shipped version).`);
  }
  if (differs.length && !force) {
    console.log();
    console.log(`  ⚠ ${differs.length} file(s) differ from the shipped template with no recorded baseline.`);
    console.log(`    Left untouched. Run \`claude-web-chat install --force\` to adopt the shipped version.`);
  }
  // Pre-warm the daemon so `open` is instant and the surface is ready the
  // moment the user restarts Claude Code. Spawn it detached exactly like `open`
  // does, but WITHOUT launching a browser (install shouldn't steal focus). A
  // spawn failure is non-fatal — install already succeeded; `open` retries.
  let warmed = false;
  try {
    spawnDaemonProcess(root);
    warmed = true;
  } catch { /* non-fatal — daemon starts on first `open` */ }

  // The remaining human steps as a numbered checklist. The channels launch
  // incantation is the one string from lib/core/channels — never forked.
  console.log();
  console.log(warmed ? `Server pre-warmed in the background.` : `Server will start on your first \`claude-web-chat open\`.`);
  console.log();
  console.log(`Next steps:`);
  console.log(`  1. Restart Claude Code with Channels enabled so Push can wake it:`);
  console.log(`       ${LAUNCH_COMMAND}`);
  console.log(`  2. Approve the .mcp.json trust prompt Claude Code shows on first launch.`);
  console.log(`  3. Run \`claude-web-chat open\` to open the surface next to your chat.`);
}

module.exports = install;

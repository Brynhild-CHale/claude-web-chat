const {
  ensureHooks,
  ensureMcpRegistration,
  ensureGitignore,
  reconcileManagedFiles,
  printResults,
} = require('../../update/managed-files');
const { projectPaths, ensureProjectDirs } = require('../../core/paths');
const { run: runMigrations } = require('../../update/migrations');
const { spawnDaemon } = require('../../util/daemon');
const { LAUNCH_COMMAND } = require('../../core/channels');

async function install(args = [], opts = {}) {
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

  // 3b. Keep .web-chat/ out of the repo. Several docs already assert it is
  // gitignored; nothing wrote the line, so a `git add -A` committed the graph.
  const ignoreStatus = ensureGitignore(root);

  // 4. Register the MCP server in .mcp.json
  let mcpStatus;
  try {
    mcpStatus = ensureMcpRegistration(root);
  } catch (e) {
    if (e.userFacing) { console.error(e.message); process.exit(1); }
    throw e;
  }

  console.log(`web-chat installed for ${root}`);
  if (ignoreStatus === 'added') console.log(`  .gitignore${' '.repeat(36)}.web-chat/ added`);
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
  // spawnDaemon (not spawnDaemonProcess) probes the portfile first and returns
  // the running instance instead of starting a second one. This was the only
  // unguarded spawn site in the tree, so re-running `install` — which the README
  // promises is always safe — started a second daemon on the same project root
  // and overwrote the portfile, orphaning the first: it kept running and kept
  // writing the same graph directory, invisible to stop/status/doctor.
  let warmed = false;
  try {
    warmed = Boolean(await spawnDaemon(root));
  } catch { /* non-fatal — daemon starts on first `open` */ }

  // The remaining human steps as a numbered checklist. Ordinary use comes first:
  // Channels is an optional research preview, and its launch incantation is the
  // one string from lib/core/channels — never forked.
  //
  console.log();
  console.log(warmed ? `Server pre-warmed in the background.` : `Server will start on your first \`claude-web-chat open\`.`);

  // `claude-web-chat init` calls install in-process and prints a fuller version
  // of this checklist itself (it knows whether the browser opened and whether a
  // tour is waiting), so it suppresses this block with { nextSteps: false }.
  // Everything above — the result table, the conflict/differs warnings and the
  // pre-warm line — still prints verbatim, and every other caller (the bare
  // `install` command included) is unaffected.
  if (opts.nextSteps === false) return;
  console.log();
  console.log(`Next steps:`);
  console.log(`  1. Restart Claude Code in this project — it reads .mcp.json only at startup,`);
  console.log(`     so the web-chat tools do not exist until you do.`);
  console.log(`  2. Approve the .mcp.json trust prompt Claude Code shows on first launch.`);
  console.log(`  3. Run \`claude-web-chat open\` to open the surface next to your chat.`);
  console.log(`  4. Type \`/web-chat\` in Claude Code. With no arguments it is a guided start:`);
  console.log(`     Claude checks the surface is up and renders a first pane about this project,`);
  console.log(`     so you can see what it does. \`/web-chat status\` (etc.) still runs the CLI.`);
  console.log();
  console.log(`Optional — Channels (research preview) lets Push wake Claude live instead of`);
  console.log(`delivering with your next message. Launch with:`);
  console.log(`     ${LAUNCH_COMMAND}`);
}

module.exports = install;

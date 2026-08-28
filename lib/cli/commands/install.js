const { printResults, conflictAdvice } = require('../../update/managed-files');
const { resolveRoot, apply } = require('../../setup/registration');
const { projectPaths, ensureProjectDirs } = require('../../core/paths');
const { run: runMigrations } = require('../../update/migrations');
const { spawnDaemon } = require('../../util/daemon');
const { LAUNCH_COMMAND } = require('../../core/channels');

async function install(args = [], opts = {}) {
  const force = args.includes('--force');
  // The enclosing project root, not blindly process.cwd(). Typed in a
  // subdirectory, install used to create a SECOND nested .web-chat/ plus a
  // nested .claude/settings.json and .mcp.json that Claude Code (which reads the
  // project root) never loads — and from then on every command below that
  // directory resolved the nested install instead.
  const { root, from, movedUp } = resolveRoot(opts.cwd || process.cwd(), { mode: 'install' });
  if (movedUp) console.log(`(typed in ${from} — installing into the enclosing project root)`);

  // 1. .web-chat/ + _version.json. Create the state dirs first, THEN stamp the
  // version through the migration runner — the same single writer the server boot
  // uses. (dir-first: the runner early-returns on a missing stateDir.) This kills
  // the old two-writer divergence where ensureVersionFile hardcoded {version:1}.
  //
  // These two steps, and the daemon pre-warm below, are deliberately NOT part of
  // the registration engine's apply(): doctor repairs registration too, and it
  // must never create state directories or fork a background server.
  const paths = projectPaths(root);
  ensureProjectDirs(paths);
  runMigrations(paths.dir);

  // 2-4. Hooks, managed files, .gitignore and the MCP registration — one model,
  // one stub policy. A malformed .claude/settings.json or .mcp.json throws
  // userFacing and is reported once by the CLI dispatcher; install used to
  // process.exit(1) here, which killed `init` mid-sequence before its closing
  // lines and before prompt.close().
  const applied = apply(root, { force, runClaude: opts.runClaude });
  const addedHooks = applied.hooks.added;
  const results = applied.managed;
  const ignoreStatus = applied.gitignore;

  console.log(`web-chat installed for ${root}`);
  if (ignoreStatus === 'added') console.log(`  .gitignore${' '.repeat(36)}.web-chat/ added`);
  console.log(`  .web-chat/                          ready`);
  console.log(`  .claude/settings.json               ${addedHooks > 0 ? `${addedHooks} hook(s) added` : 'already up to date'}`);
  printResults(results);
  console.log(`  .mcp.json                           ${applied.mcp.status}`);
  if (applied.mcp.localScope) {
    const argv = `claude ${applied.mcp.localScope.argv.join(' ')}`;
    if (applied.mcp.localScope.status === 'registered' || applied.mcp.localScope.status === 'already registered') {
      console.log(`  Claude Code (local scope)           ${applied.mcp.localScope.status} — the .mcp.json stub cannot resolve here`);
    } else {
      console.log(`  Claude Code (local scope)           NOT registered — run: ${argv}`);
    }
  }

  // The conflict wording lives in one place — see conflictAdvice's header for
  // the state machine it describes. A `pending` row (an unmerged `.new` from an
  // offer made on an earlier run) is reported here too, by the same helper:
  // install is where the user most likely is when they come back to finish the
  // merge, and staying silent would make the reminder depend on them thinking
  // to run `status`. It is deliberately NOT rolled into the `differs` block
  // below — that one offers `--force`, and this one is finished by hand.
  const advice = conflictAdvice(results);
  const differs = results.filter(r => r.action === 'differs');
  if (advice.length) {
    console.log();
    for (const line of advice) console.log(line);
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

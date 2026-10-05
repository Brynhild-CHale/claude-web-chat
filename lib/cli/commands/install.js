const fs = require('fs');
const { printResults, conflictAdvice } = require('../../update/managed-files');
const { resolveRoot, apply, mcpQuestions, mcpConsent, mcpResultLines } = require('../../setup/registration');
const { projectPaths, ensureProjectDirs, isHomeDir } = require('../../core/paths');
const { createPrompt } = require('../prompt');
const { run: runMigrations } = require('../../update/migrations');
const { spawnDaemon } = require('../../util/daemon');
const { LAUNCH_COMMAND } = require('../../core/channels');
const { seedThemeLogos } = require('../../setup/theme-logos');
const { restartIfStale } = require('../stale-daemon');

// What the hook merge did to .claude/settings.json: the handlers it added, and
// the web-chat handlers already there that it rewrote (a stale field, a bare
// command, a command pointed at this tree). A run that only rewrote handlers
// used to print "already up to date".
function hooksLine({ added = 0, updated = 0 } = {}) {
  const parts = [];
  if (added) parts.push(`${added} hook(s) added`);
  if (updated) parts.push(`${updated} hook(s) updated`);
  return parts.length ? parts.join(', ') : 'already up to date';
}

// The one row the result table prints for web-chat's MCP registration.
function mcpRow(m) {
  switch (m.status) {
    case 'registered': return 'web-chat\'s MCP server registered for this folder';
    case 'repointed': return 'web-chat\'s MCP server re-registered (it pointed at another copy of web-chat)';
    case 'kept': return 'already registered';
    case 'disabled': return 'disabled in Claude Code for this project (/mcp) — left as it is; re-enable it there';
    case 'rejected': return 'NOT registered — web-chat was rejected in Claude Code here (above)';
    case 'no-claude': return 'NOT registered — `claude` was not found';
    case 'failed': return 'NOT registered — `claude mcp add` failed';
    case 'unverified': return 'NOT verified — see below';
    default: return String(m.status);
  }
}

async function install(args = [], opts = {}) {
  const force = args.includes('--force');
  const registerMcp = args.includes('--register-mcp') || opts.registerMcp === true;
  // The enclosing project root, not blindly process.cwd(). Typed in a
  // subdirectory, install used to create a SECOND nested .web-chat/ plus a
  // nested .claude/settings.json and .mcp.json that Claude Code (which reads the
  // project root) never loads — and from then on every command below that
  // directory resolved the nested install instead.
  const { root, from, movedUp } = resolveRoot(opts.cwd || process.cwd(), { mode: 'install' });
  // Never $HOME, and refused BEFORE anything is written. Its .web-chat/ is the
  // USER tier, so since 0.8 no daemon can be rooted there (`start` refuses it):
  // an install went on to write hooks into ~/.claude/settings.json — which fire
  // in every project — and a ~/.mcp.json, first-touched the user tier, and
  // promised a server that would never start. init refuses it the same way.
  if (isHomeDir(root)) {
    const err = new Error([
      `${root} is your home directory — web-chat does not install here.`,
      '~/.web-chat/ is its per-user directory, so no surface can be rooted at $HOME, and the hooks',
      'an install writes into ~/.claude/settings.json would fire in every project for a server that',
      'never starts. Run `claude-web-chat init` in a project directory instead. A web-chat installed',
      'here by an earlier version is removed by `claude-web-chat uninstall` in this directory.',
    ].join('\n'));
    err.userFacing = true;
    throw err;
  }
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
  // Creating .web-chat/ in this run is the user's own first "set web-chat up
  // here" — the one install that may register over a No recorded in Claude
  // Code (disabledMcpjsonServers) without asking separately.
  const creating = !fs.existsSync(paths.dir);
  ensureProjectDirs(paths);
  runMigrations(paths.dir);
  // The per-user folders a builtin theme pack reads its marks from — made here
  // (and at `update`), whatever theme this project is on. Idempotent, and
  // silent on purpose: see lib/setup/theme-logos.js.
  seedThemeLogos();

  // 2-4. Hooks, managed files, .gitignore and the MCP registration — one model,
  // one stub policy. A malformed .claude/settings.json or .mcp.json throws
  // userFacing and is reported once by the CLI dispatcher; install used to
  // process.exit(1) here, which killed `init` mid-sequence before its closing
  // lines and before prompt.close().
  //
  // The MCP server is registered at Claude Code's LOCAL scope (see
  // lib/setup/registration applyMcpLocal): no approval dialog, ever, and no
  // per-user path in a file the project may share. The two questions it may
  // need — over a No recorded in Claude Code, and before editing a .mcp.json
  // git tracks — are asked here, before it runs, each defaulting to No.
  const prompt = opts.prompt || createPrompt({ noInput: args.includes('--no-input'), yes: args.includes('--yes') });
  let consent = {};
  try {
    const q = mcpQuestions(root, { creating, git: opts.git, configFile: opts.configFile });
    consent = await mcpConsent(q, { prompt, registerMcp, decisions: opts.mcpDecisions || {}, log: (m) => console.log(m) });
  } finally {
    if (!opts.prompt) prompt.close();
  }
  const applied = apply(root, {
    force, runClaude: opts.runClaude, mcp: 'local', creating, consent, git: opts.git, configFile: opts.configFile,
  });
  const results = applied.managed;
  const ignoreStatus = applied.gitignore;
  const m = applied.mcp;

  console.log(`web-chat installed for ${root}`);
  if (ignoreStatus === 'added') console.log(`  .gitignore${' '.repeat(36)}.web-chat/ added`);
  console.log(`  .web-chat/                          ready`);
  console.log(`  .claude/settings.json               ${hooksLine(applied.hooks)}`);
  printResults(results);
  console.log(`  Claude Code (local scope)           ${mcpRow(m)}`);
  if (m.legacy) console.log(`  .mcp.json                           ${m.legacy}`);
  else if (m.mcpJson && m.mcpJson.action !== 'none') {
    console.log(`  .mcp.json                           web-chat entry ${m.mcpJson.action === 'kept' ? 'kept' : m.mcpJson.action}`);
  }
  for (const line of mcpResultLines(m)) console.log(`    ${line}`);
  if (m.status === 'rejected') {
    console.log('    `claude-web-chat install --register-mcp` registers it anyway; `claude-web-chat off` switches web-chat off here.');
  }

  // The conflict wording lives in one place — see conflictAdvice's header for
  // the state machine it describes. A `pending` row (an unmerged `.new` from an
  // offer made on an earlier run) is reported here too, by the same helper:
  // install is where the user most likely is when they come back to finish the
  // merge, and staying silent would make the reminder depend on them thinking
  // to run `status`. It is deliberately NOT rolled into the `differs` block
  // below — that one offers `--force`, and this one is finished by hand.
  const advice = conflictAdvice(results);
  // `!r.pending`: a `differs` row can carry an unmerged `.new` (the baseline was
  // lost while a conflict was outstanding — the file still diverges from
  // shipped, and the reconcile deliberately keeps the sidecar). conflictAdvice
  // already reports that row, by name, with the step that ends it. Counting it
  // here as well printed two paragraphs about one file with two different next
  // steps. The sidecar reminder wins: it names merge-then-delete, which
  // terminates, and `--force` is still offered in the conflict wording.
  const differs = results.filter(r => r.action === 'differs' && !r.pending);
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
  //
  // A daemon that IS running, but on an older build, is restarted onto this one
  // first (one line; lib/cli/stale-daemon.js). `install` is the step the
  // upgrade notes send the user to in every other project, and the daemon an
  // update left behind there would otherwise go on serving the old chrome — and
  // 404ing the new build's tools — for as long as a tab stays attached to it.
  let warmed = false;
  try {
    await (opts.restartIfStale || restartIfStale)(root, { log: (m) => console.log(m) });
  } catch { /* non-fatal — `open` checks again */ }
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
  console.log(`  1. Restart Claude Code in this project — it loads MCP servers only at startup,`);
  console.log(`     so the web-chat tools do not exist until you do.`);
  console.log(`  2. Run \`claude-web-chat open\` to open the surface next to your chat.`);
  console.log(`  3. Type \`/web-chat\` in Claude Code. With no arguments it is a guided start:`);
  console.log(`     Claude checks the surface is up and renders a first pane about this project,`);
  console.log(`     so you can see what it does. \`/web-chat status\` (etc.) still runs the CLI.`);
  console.log();
  console.log(`Optional — Channels (research preview) lets Push wake Claude live instead of`);
  console.log(`delivering with your next message. Launch with:`);
  console.log(`     ${LAUNCH_COMMAND}`);
}

module.exports = install;

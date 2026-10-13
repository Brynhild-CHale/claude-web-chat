// `claude-web-chat init [folder]` — one entry point, two auto-detected modes.
//
//   fresh     no .web-chat/ in the folder → first-time setup + the surface tour
//   existing  the folder has one          → orient, repair, tidy
//
// The folder is the one it is typed in, or the one named (setupRoot in
// lib/setup/registration, shared with `install`), and init sets it up even
// inside another install. `--nearest-parent` is 0.8.0's detection instead:
// existing on the nearest installed folder at or above it, else fresh there —
// which is what `/web-chat init` runs, because a Claude Code session started
// in a child folder uses the nearest install above it.
//
// Nothing here reimplements a check, a repair or an inventory: init SEQUENCES the
// engines that already do those jobs (`install`, `doctor`, `ls`, the managed-file
// reconciler, the release check) and puts the human decisions in the one place a
// human is standing — the terminal.
//
// Two hard boundaries, both load-bearing:
//
//   * The terminal owns every consequential decision. The daemon is headless and
//     detached (its stdout goes to .web-chat/server.log), so an interactive step
//     that happened there would be invisible; and service consent in particular
//     can NEVER move to the surface, because a pane script shares the surface's
//     realm with no CSP and could forge its own approval. init prints
//     `claude-web-chat trust <name>` and stops.
//   * The surface owns exactly one thing before the restart: a tour pane the CLI
//     mounts over HTTP. On a fresh install NONE of the 24 MCP tools exist until
//     Claude Code is restarted, so the tour cannot be Claude's job yet. The rest
//     of the teaching is `/web-chat init`, after the restart.
//
// Nothing destructive happens without an interactive yes — `--yes` means "take
// the printed defaults", and the default for reaping other projects' daemons,
// running `update`, `install --force`, granting a trust, or deleting anything
// under .web-chat/ is No.

const fs = require('fs');
const path = require('path');
const { projectPaths, userPaths, isHomeDir, userClaudePaths, redactHostPaths } = require('../../core/paths');
const { LAUNCH_COMMAND } = require('../../core/channels');
const { resolveLatest, peekLatest } = require('../../update/check');
const portfiles = require('../../core/portfiles');
const { createPrompt } = require('../prompt');
const { gatherState } = require('../init/state');
const { describeInstall } = require('../../update/install-layout');
const { managedSkillNames } = require('../../update/managed-files');
const {
  hookHandlers, hookEvents, mcpState, describeMcp, setupRoot, gitignorePlan, isInstalled,
} = require('../../setup/registration');
const { findClaude } = require('../../core/claude-cli');
const { checkNodeFloor, INSTALL_SH_URL } = require('../../core/versions');

const PACKAGE_ROOT = path.join(__dirname, '..', '..', '..');
const TOUR_COMPONENT = 'web-chat-tour';
const TOUR_MOUNT = 'web-chat-tour';
const TOUR_MIRROR_MOUNT = 'web-chat-tour-mirror';
const STATE_FENCE = '--- WEB-CHAT-STATE ---';
const USAGE = 'claude-web-chat init [folder] [--nearest-parent] [--report|--json] [--yes] [--no-input] [--no-open] [--tour|--no-tour] [--register-mcp]';

// Every write a fresh install performs, announced before any of them happen.
// The counts come from the engines that make those writes: the hook template
// (registration's hookHandlers / hookEvents) and the managed files. Written out
// by hand, this list went on saying "2 hooks merged in" once the install wrote
// fourteen handlers on twelve events, and any later template change would have
// left it wrong again with nothing to notice.
function writeList({ claude = true, gitignore = true } = {}) {
  const hooks = hookHandlers().length;
  const events = hookEvents().length;
  const skills = managedSkillNames();
  // The MCP server goes into Claude Code's own config at local scope — no
  // approval dialog — unless there is no `claude` to put it there, when it
  // falls back to the project's .mcp.json (lib/setup/registration).
  const mcp = claude
    ? [claudeConfigLabel(), 'web-chat\'s MCP server for this folder (local scope)']
    : ['.mcp.json', 'the web-chat MCP server entry (no `claude` found to register it at local scope)'];
  return [
    ['.web-chat/', 'the graph, components, exports and portfile (gitignored)'],
    ['.claude/settings.json', `${hooks} ${plural(hooks, 'hook')} on ${events} ${plural(events, 'event')} merged in (existing hooks are preserved)`],
    ['.claude/rules/web-chat.md', 'how Claude should use the surface'],
    ['.claude/commands/web-chat.md', 'the /web-chat slash command'],
    ['.claude/skills/…', `${skills.length} ${plural(skills.length, 'skill')} (${skills.join(', ')})`],
    mcp,
    ...(gitignore ? [['.gitignore', 'one line: .web-chat/']] : []),
  ].map(([dest, what]) => (dest.length > 31 ? `${dest}: ${what}` : `${dest.padEnd(31)}${what}`));
}

// How the write list names Claude Code's config file: ~/.claude.json, or the
// one CLAUDE_CONFIG_DIR moves it to.
function claudeConfigLabel() {
  return `Claude Code's own config (${redactHostPaths(userClaudePaths().claudeJson)})`;
}

function parseFlags(args = []) {
  const has = (f) => args.includes(f);
  const json = has('--json');
  return {
    json,
    report: json || has('--report'),
    yes: has('--yes'),
    registerMcp: has('--register-mcp'),
    noInput: has('--no-input'),
    noOpen: has('--no-open'),
    tour: has('--tour') ? true : (has('--no-tour') ? false : null),
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Has this project already been through init? User-tier, so the SECOND project
// you install into skips the tour offer instead of re-teaching you the surface.
function onboardedFor(root) {
  const data = readJson(userPaths().onboarded);
  const projects = data && data.projects;
  return Boolean(projects && projects[path.resolve(root)]);
}

function stampOnboarded(root, { version, tour }) {
  const f = userPaths().onboarded;
  const data = readJson(f) || {};
  if (!data.first_init_at) data.first_init_at = Date.now();
  data.version = version;
  data.projects = data.projects && typeof data.projects === 'object' ? data.projects : {};
  data.projects[path.resolve(root)] = { at: Date.now(), tour: Boolean(tour) };
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
  } catch { /* the stamp is a convenience; failing to write it costs a repeat offer */ }
}

// Which tree is this code running from — a release under ~/.web-chat/versions/,
// a git checkout, or something else? `update` only ever rewrites the first, so
// the offer below is only made there. One implementation answers this for
// `update`, `version`, and here (lib/update/install-layout.js), because the
// question is exactly "would an update change the thing you actually run?" —
// and getting it wrong is how a stale binary hides on someone's PATH.
function installKind() {
  try { return describeInstall().kind; } catch { return 'unmanaged'; }
}

function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

// ---------------------------------------------------------------- the report --

function printReport(state, log, { again = nearestParentCommand() } = {}) {
  const installed = state.mode === 'existing';
  log(`claude-web-chat v${state.version} — ${state.root}`);
  // WHERE this build lives, printed before anything else it might be wrong
  // about. A stale binary on PATH is silent until something you just built is
  // missing; the report is where a user already looks when things feel off.
  const where = (() => { try { return describeInstall(); } catch { return null; } })();
  if (where) {
    const kindLabel = where.kind === 'managed' ? 'release' : where.kind === 'dev' ? 'git checkout' : 'unmanaged copy';
    log(`  install     ${kindLabel}  ${where.packageRoot}`);
    if (where.linkMismatch) {
      log(`              ⚠ but \`claude-web-chat\` on your PATH is ${where.linkPath} -> ${where.linkTarget} (v${where.linkVersion || '?'})`);
    }
  }
  log(`  mode        ${state.mode}${installed ? `  (schema v${state.schema == null ? '?' : state.schema} · ${state.nodes} ${plural(state.nodes, 'node')})` : '  (no .web-chat/ here)'}`);
  if (state.enclosing) {
    log(`  enclosing   ${state.enclosing} has its own web-chat — \`${again}\` checks that one`);
  }
  const eff = state.toggle.effective;
  const effLine = eff === 'enabled' ? 'enabled'
    : eff === 'not-installed' ? 'not installed here yet'
      : `DISABLED by the ${eff.split(':')[1]} scope`;
  log(`  web-chat    ${effLine}  (user ${state.toggle.user} · project ${state.toggle.project})`);
  log(`  daemon      ${state.daemon.running ? `running at ${state.daemon.url}${state.viewers == null ? '' : ` · ${state.viewers} ${plural(state.viewers, 'viewer')} watching`}` : 'not running'}`);
  log(`  channels    ${state.channel_connected ? 'connected — a Push wakes Claude now' : 'not connected — a Push delivers with your next message'}`);
  if (state.mcp) {
    log(`  mcp         ${state.mcp.state}: ${state.mcp.line}`);
    for (const n of state.mcp.notes || []) log(`                ${n}`);
  }
  log(`  restart     ${state.restart.state}: ${state.restart.line}`);
  if (state.drift.length) {
    log(`  managed     ${state.drift.length} ${plural(state.drift.length, 'file')} drifted:`);
    for (const d of state.drift) {
      // A pending row's action is the settled `kept-edited`; printing that beside
      // its sidecar reads as a contradiction. It is listed because of the offer,
      // so it is named after the offer.
      const label = d.pending && d.action !== 'conflict' ? 'unmerged' : d.action;
      log(`                ${label.padEnd(10)} ${d.dest}${d.sidecar ? `  → ${d.sidecar}` : ''}`);
    }
  } else if (installed) {
    log(`  managed     up to date`);
  }
  if (state.surfaces.length) {
    log(`  surfaces    ${state.surfaces.length} on this machine:`);
    for (const s of state.surfaces) {
      const flag = s.mine ? '  ←' : '';
      const health = s.reachable ? '' : (s.pid_alive ? '  (not answering)' : '  (dead — registry entry is stale)');
      log(`                ${s.url}  ${s.root || ''}${health}${flag}`);
    }
  } else {
    log(`  surfaces    none running on this machine`);
  }
  if (state.pending_services.length) {
    log(`  services    ${state.pending_services.length} waiting for approval:`);
    for (const s of state.pending_services) log(`                ${s.name}   → claude-web-chat trust ${s.name}`);
  }
  if (state.latest) {
    log(`  release     ${state.latest.newer ? `v${state.latest.version} available (you are on v${state.version})` : `v${state.latest.version} is the latest; you are on v${state.version}`}`);
  }
  if (installed) {
    // In a --report run doctor repaired nothing — say so, rather than printing a
    // "repaired" count for work that deliberately did not happen.
    const dry = state.doctor.checks.some((c) => c.dry);
    log(`  doctor      ${state.doctor.ok} ok · ${state.doctor.repaired} ${dry ? 'would be repaired' : 'repaired'} · ${state.doctor.problems} ${plural(state.doctor.problems, 'problem')}`);
    for (const c of state.doctor.checks) {
      if (c.status === 'problem') log(`                ✗ ${c.m}`);
    }
  }
}

// ------------------------------------------------------------------ the tour --

// Mount the pre-restart tour over the COMPONENT /use route, never through
// lib/driver. /use stamps owner 'claude' — not a `service:` prefix — so
// `deriveRouting` still gives it 'auto' (the activity layer the tour is teaching
// stays on) and Claude can clear it later with no force:true (the clear guard
// passes a same-owner clear). A driver render would stamp `service:init`, which
// flips routing to 'none' and clobber-guards Claude out of tidying its own tour.
async function mountTour({ root, channelConnected, http, log }) {
  const guide = {
    id: TOUR_MOUNT,
    params: {
      role: 'guide',
      // `step` and `url` used to ride here and in the component's params_schema;
      // component.html reads neither (it drives its own steps off observed
      // evidence, and never renders the URL), so they were a declaration of
      // something that does not exist.
      root,
      channel_connected: Boolean(channelConnected),
      routing: 'auto',
      signals: [{ key: 'web_chat_init', wake: 'queue', why: 'first-run tour handoff' }],
    },
  };
  const mirror = { id: TOUR_MIRROR_MOUNT, params: { role: 'mirror', routing: 'none' } };
  try {
    await http.post(`/api/components/${TOUR_COMPONENT}/use`, guide, { root, noSpawn: true });
    await http.post(`/api/components/${TOUR_COMPONENT}/use`, mirror, { root, noSpawn: true });
    return true;
  } catch (e) {
    log(`  (could not mount the tour: ${e.message})`);
    return false;
  }
}

// Poll for a connected browser, bounded. On timeout we continue anyway: mounts
// are server-side state, and a browser that connects later receives them on
// hello — nothing is lost by not waiting.
async function waitForViewer({ root, http, capMs = 15000, intervalMs = 400, sleep }) {
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + capMs;
  for (;;) {
    try {
      const health = await http.get('/api/health', { root, noSpawn: true });
      if (health && typeof health.viewers === 'number' && health.viewers > 0) return true;
    } catch { /* daemon not up yet — keep waiting until the cap */ }
    if (Date.now() >= deadline) return false;
    await nap(intervalMs);
  }
}

// ------------------------------------------------------------------- fresh ----

async function freshMode(ctx) {
  const { log, flags, prompt, deps, root, latestPromise, target } = ctx;

  log(`claude-web-chat init — ${root}`);

  // 1. The one hard gate: $HOME is never a project. Its .web-chat/ is the USER
  // tier (installed versions, the registry of running surfaces, service
  // trust), so since 0.8 no daemon can be rooted there — `start` refuses it —
  // and an install would only write hooks into ~/.claude/settings.json, which
  // fire in EVERY project, plus a ~/.mcp.json, for a server that never starts.
  // (It also made the project-scope disable marker the user-scope one.) 0.7.x
  // asked and went ahead on a yes; there is no yes left to give. isHomeDir is
  // the one answer to "is this $HOME" — by real path, in the on-disk case.
  if (isHomeDir(root)) {
    log('');
    log(`  ✗ This is your home directory, and web-chat does not install here.`);
    log(`    ~/.web-chat/ is web-chat's per-user directory, so no surface can be rooted`);
    log(`    at $HOME: an install would add hooks to ~/.claude/settings.json that fire in`);
    log(`    every project, for a server that never starts.`);
    log(`    A web-chat installed here by an earlier version is removed by running`);
    log(`    \`claude-web-chat uninstall\` in this directory.`);
    log('');
    log('Nothing written. Run this from a project directory instead.');
    process.exitCode = 1;
    return { installed: false, refused: 'home' };
  }

  log(`No .web-chat/ here, so this is a first-time setup.`);
  // Inside another install, a second, separate one — said before the write
  // list, with the way to the one above instead.
  if (target.enclosing) {
    log(`(${target.enclosing} has its own web-chat; this sets up a separate one for ${root}. \`${nearestParentCommand(target)}\` checks or repairs that one instead.)`);
  }
  log('');

  // 2. Preconditions. Node is a hard requirement; the rest is orientation.
  // The floor comes from lib/core/versions, the same number package.json's
  // engines range and install.sh use. It used to be a literal 18 here, which
  // waved Node 18-21 through with a green tick, installed everything, and then
  // failed at `open` with "server failed to start".
  const nodeCheck = nodeFloorMessage();
  if (nodeCheck) {
    log(`  ✗ ${nodeCheck}`);
    process.exitCode = 1;
    return { installed: false };
  }
  log(`  ✓ Node ${process.versions.node}`);
  log(`  ${deps.hasClaude() ? '✓' : '•'} \`claude\` ${deps.hasClaude() ? 'is on your PATH' : 'is not on your PATH — install Claude Code before the restart step below'}`);
  // The .gitignore line, judged the way the install will judge it — by git, so
  // a subfolder of a repository is reported by the repository's rules
  // (registration's gitignorePlan, in dry mode: nothing is written).
  const ignore = gitignoreOutlook(root, deps);
  log(`  ${ignore.line}`);
  log('');

  // 3. Announce every write, then ask.
  log(`This will create or edit:`);
  for (const line of writeList({ claude: deps.hasClaude(), gitignore: ignore.action === 'added' })) log(`  ${line}`);
  log('');
  log(`Your CLAUDE.md is not touched, and re-running this is safe.`);
  log('');

  // Without a TTY the default is NOT auto-taken: an install writes seven paths
  // into someone's project, and a piped/CI invocation never consented to that.
  // `--yes` is the explicit consent. (This is what makes `/web-chat init` safe
  // by construction — the slash command runs `--report`, but even a bare `init`
  // from a non-terminal writes nothing.)
  if (!prompt.interactive && !flags.yes) {
    log(`Not a terminal — nothing written. Re-run with --yes, or run \`claude-web-chat install\`.`);
    return { installed: false };
  }
  const go = await prompt.confirm('Continue?', { def: true });
  if (!go) {
    log('');
    log('Nothing written.');
    return { installed: false };
  }
  log('');

  // 4. The real install, in-process. Its table, warnings and pre-warm line print
  // verbatim; only its trailing next-steps block is suppressed, because init
  // prints a fuller version below. Pointed at the root, and run from it.
  await deps.inRoot(root, () => deps.install([], {
    cwd: root, nextSteps: false, prompt, registerMcp: flags.registerMcp, mcpDecisions: ctx.mcpDecisions,
  }));

  // 5. Open the surface.
  let url = null;
  let opened = false;
  if (!flags.noOpen) {
    const wantOpen = await prompt.confirm('Open the surface in your browser now?', { def: true });
    if (wantOpen) {
      // `open` calls process.exit(1) when the daemon does not come up in 8s.
      // That would kill init here — before the onboarding stamp and before the
      // restart instructions, which are the two things the user actually needs.
      // Swap its exit for a flag and carry on.
      let failed = false;
      await deps.inRoot(root, () => deps.open([], { exit: () => { failed = true; } }));
      opened = !failed;
    }
  }
  const info = portfiles.readPortfile('server', { root });
  if (info) url = info.url;
  if (!opened) {
    log('');
    log(url ? `The surface is at ${url} — open it whenever you like (\`claude-web-chat open\`).`
      : `Start the surface with \`claude-web-chat open\`.`);
  }

  // 6/7. Wait for an eyeball, then mount the tour.
  let toured = false;
  const wantTour = flags.tour !== false && !flags.report && prompt.interactive;
  if (wantTour && url) {
    log('');
    const sawViewer = await waitForViewer({ root, http: deps.client, sleep: deps.sleep, capMs: deps.viewerWaitMs });
    if (!sawViewer) log(`  (no browser attached yet — the tour is waiting at ${url} whenever you open it)`);
    const policy = await deps.client.get('/api/queue/policy', { root, noSpawn: true }).catch(() => null);
    toured = await mountTour({
      root,
      channelConnected: Boolean(policy && policy.channel_connected),
      http: deps.client,
      log,
    });
  }

  // 8. Stamp, so the second project's init is quiet.
  stampOnboarded(root, { version: ctx.version, tour: toured });

  // 9. A few lines, then stop. Never block.
  //
  // Restarting Claude Code is the only step left: install registered the MCP
  // server at Claude Code's local scope, which needs no approval (when there
  // was no `claude` to do that, install said so, and that `doctor` finishes it).
  const latest = await latestPromise;
  log('');
  if (toured) log(`Your tour is on the surface at ${url} — it needs nothing from Claude.`);
  log(`When you're done: /exit and reopen Claude Code here. It loads MCP servers only at`);
  log(`  startup, so the web-chat tools do not exist until you do.`);
  log(`Then type /web-chat init — Claude picks the tour up where the page leaves off.`);
  log(`Optional research preview — Channels makes Push wake Claude live instead of`);
  log(`  delivering with your next message:  ${LAUNCH_COMMAND}`);
  if (latest && latest.updateAvailable) {
    log('');
    log(`(v${latest.latest} has since been released — ${latest.releaseUrl})`);
  }
  return { installed: true, toured };
}

// ---------------------------------------------------------------- existing ----

async function existingMode(ctx) {
  const { log, flags, prompt, deps, root, latestPromise, version } = ctx;

  const p = projectPaths(root);
  const schema = readJson(p.version);
  let nodes = 0;
  try { nodes = fs.readdirSync(p.graphDir).filter((f) => f.endsWith('.json') && f !== '_meta.json').length; } catch {}

  const latest = await latestPromise;
  log(`claude-web-chat v${version} — ${root}   (installed · schema v${schema && schema.version != null ? schema.version : '?'} · ${nodes} ${plural(nodes, 'node')})`);
  if (latest && latest.updateAvailable) log(`v${latest.latest} has been released — ${latest.releaseUrl}`);
  log('');

  // `--tour` is the one existing-mode path that touches no configuration: mount
  // the tour against the running daemon and stop.
  if (flags.tour === true) {
    const info = portfiles.readPortfile('server', { root });
    if (!info) {
      log('The surface is not running — start it with `claude-web-chat open`, then re-run `claude-web-chat init --tour`.');
      return { doctorSummary: null };
    }
    await waitForViewer({ root, http: deps.client, sleep: deps.sleep, capMs: deps.viewerWaitMs });
    const policy = await deps.client.get('/api/queue/policy', { root, noSpawn: true }).catch(() => null);
    const ok = await mountTour({
      root, channelConnected: Boolean(policy && policy.channel_connected), http: deps.client, log,
    });
    if (ok) {
      stampOnboarded(root, { version, tour: true });
      log(`Tour mounted at ${info.url}. Nothing else was changed.`);
    }
    return { doctorSummary: null };
  }

  // 1. Doctor, ANNOUNCED before it runs. Naming the shell-out is not optional —
  // it is a side effect nobody obviously asked for by typing `init`.
  log('Running `claude-web-chat doctor` — it repairs stale portfiles, orphaned graph');
  log('locks, bare PATH-dependent hook commands and a stale WEB_CHAT_CHANNEL in .mcp.json,');
  log('and registers web-chat\'s MCP server with Claude Code at local scope where it is');
  log('missing (by running `claude mcp add … --scope local`, which writes Claude Code\'s own config).');
  log('');
  const doctorSummary = await deps.doctor(flags.registerMcp ? ['--register-mcp'] : [], {
    cwd: root, log, dryRun: flags.report, prompt, mcpDecisions: ctx.mcpDecisions,
  });
  log('');

  if (flags.report) return { doctorSummary };

  // 2. Managed-file drift — the one health fact doctor does not cover.
  // `pending` (an unmerged `.new` beside a settled file) is drift for the same
  // reason it is in lib/cli/init/state.js: init exists to surface unfinished
  // business, and this is some.
  const drift = deps.reconcile(root, { dryRun: true })
    .filter((r) => ['created', 'updated', 'differs', 'conflict'].includes(r.action) || r.pending);
  // One wording for a managed-file conflict — and for the reminder an unmerged
  // sidecar leaves behind — shared with install, update and status. See
  // conflictAdvice's header in lib/update/managed-files.
  const advice = require('../../update/managed-files').conflictAdvice(drift);
  if (advice.length) {
    log('Managed files:');
    for (const line of advice) log(line);
    log('    (init will not run --force for you.)');
    log('');
  }

  // 3. Machine inventory — the explicit half of the ask.
  const rows = await deps.collectRows();
  log(`Surfaces on this machine:`);
  if (!rows.length) {
    log(`  none running. \`claude-web-chat open\` starts this project's.`);
  } else {
    const pad = Math.max(...rows.map((r) => String(r.title || path.basename(r.root || '')).length), 7);
    let anyMine = false;
    for (const r of rows) {
      const name = String(r.title || path.basename(r.root || '?')).padEnd(pad);
      const isMine = path.resolve(r.root || '') === path.resolve(root);
      if (isMine) anyMine = true;
      const health = r.reachable ? '' : (r.pid_alive ? '  (not answering)' : '  (dead — registry entry is stale)');
      log(`  ${name}  ${r.url || ''}${health}${isMine ? ' ←' : ''}`);
      log(`  ${' '.repeat(pad)}  ${r.root || ''}`);
    }
    // Only when something actually carries the marker. Printing the legend
    // unconditionally made the inventory contradict the remediation two
    // paragraphs later ("← is this project" over a row that the next block
    // correctly called a surface for ANOTHER project).
    if (anyMine) log(`  ← is this project.`);
    else log(`  none of these is this project — it has no surface running.`);
  }
  log('');

  // 4. Remediation — confirm-first, one question per item, every command printed
  // so the user learns the CLI rather than depending on init.
  //
  // The one subtlety: a prompt with a Yes default resolves to Yes when there is
  // no terminal, and "no terminal" must NOT mean "quietly refresh this person's
  // managed files and flip their toggles". So a remediation only RUNS when a
  // human is there to answer (or said --yes explicitly); otherwise init prints
  // the command and moves on, which is the documented non-interactive contract.
  const canAct = prompt.interactive || flags.yes;
  const offer = async (question, def, command, run) => {
    if (!canAct) {
      log(`  not a terminal — run \`${command}\` yourself (or re-run with --yes).`);
      return false;
    }
    if (!(await prompt.confirm(question, { def }))) return false;
    await run();
    return true;
  };

  // What `claude-web-chat install` would actually fix. A conflict is excluded
  // because install re-offers it rather than resolving it; a `pending` row is
  // excluded for a stronger reason — install will not touch the file at all, so
  // offering "Refresh?" over it would run a command that does nothing and let
  // the user believe the sidecar had been dealt with. Both are reported above,
  // in the advice, with the by-hand step named.
  const refreshable = drift.filter((r) => r.action !== 'conflict' && !r.pending);
  if (refreshable.length) {
    log(`${refreshable.length} managed ${plural(refreshable.length, 'file')} ${plural(refreshable.length, 'is', 'are')} behind the package (\`claude-web-chat install\` refreshes ${plural(refreshable.length, 'it', 'them')}):`);
    for (const r of refreshable) log(`  ${r.action.padEnd(10)} ${r.dest}`);
    await offer(
      `Refresh ${refreshable.length} managed ${plural(refreshable.length, 'file')}?`, true,
      'claude-web-chat install',
      () => deps.inRoot(root, () => deps.install([], {
        cwd: root, nextSteps: false, prompt, registerMcp: flags.registerMcp, mcpDecisions: ctx.mcpDecisions,
      })),
    );
    log('');
  }

  const toggle = deps.resolveToggle({ cwd: root, sessionId: process.env.CLAUDE_SESSION_ID });
  if (!toggle.enabled) {
    const flag = toggle.by === 'user' ? ' --global' : (toggle.by === 'session' ? ' --session' : '');
    log(`web-chat is DISABLED by the ${toggle.by} scope — hooks no-op and every MCP tool returns {disabled}.`);
    log(`  \`claude-web-chat on${flag}\` re-enables it.`);
    await offer(
      `Re-enable web-chat for ${toggle.by}?`, true,
      `claude-web-chat on${flag}`,
      () => deps.inRoot(root, () => deps.on(flag ? [flag.trim()] : [])),
    );
    log('');
  }

  const stale = rows.filter((r) => !r.pid_alive);
  if (stale.length) {
    log(`${stale.length} stale registry ${plural(stale.length, 'entry', 'entries')} (the process each described is gone).`);
    log(`  \`claude-web-chat ls --reap\` clears them.`);
    await offer(
      `Clear ${stale.length} stale registry ${plural(stale.length, 'entry', 'entries')}?`, true,
      'claude-web-chat ls --reap',
      async () => {
        // Through the shared reaper, so this clears the registry entries the
        // question actually named. It used to unlink the OTHER project's
        // portfile and say "cleared", leaving ~/.web-chat untouched.
        const { cleared } = await deps.reap(stale, { log });
        log(`  cleared ${cleared} ${plural(cleared, 'entry', 'entries')}.`);
      },
    );
    log('');
  }

  const others = rows.filter((r) => r.reachable && path.resolve(r.root || '') !== path.resolve(root));
  if (others.length) {
    log(`${others.length} live ${plural(others.length, 'surface')} for OTHER projects:`);
    for (const r of others) log(`  ${r.url}  ${r.root}`);
    log(`  Each restarts on the next \`claude-web-chat open\` in its project — graph state is`);
    log(`  on disk, not in the process. \`claude-web-chat ls --reap\` stops them.`);
    // Default No, and never taken by --yes: these are other projects' daemons.
    if (canAct && await prompt.confirm(`Stop ${others.length} ${plural(others.length, 'surface')} for other projects?`, { def: false })) {
      await deps.inRoot(root, () => deps.ls(['--reap']));
    }
    log('');
  }

  if (latest && latest.updateAvailable) {
    const kind = (deps.installKind || installKind)();
    if (kind === 'dev') {
      log(`v${latest.latest} is out, but you are running a git checkout, not an installed release.`);
      log(`  \`claude-web-chat update\` refuses on a checkout (it would change nothing you run).`);
      log(`  Update with \`git pull\` in ${PACKAGE_ROOT} instead.`);
    } else if (kind !== 'managed') {
      log(`v${latest.latest} is available (you are on v${version}), but this copy is not a`);
      log(`  managed install — \`update\` will refuse. Reinstall to take releases in place:`);
      log(`  curl -fsSL ${INSTALL_SH_URL} | sh`);
    } else {
      log(`v${latest.latest} is available (you are on v${version}).`);
      log(`  \`claude-web-chat update\` downloads the release from GitHub, verifies its`);
      log(`  checksum, unpacks it into ~/.web-chat/versions/${latest.latest}/ and swaps the`);
      log(`  ~/.web-chat/current symlink. No npm, no sudo; roll back with --to <version>.`);
      // Default No, and never taken by --yes: this rewrites the install.
      if (canAct && await prompt.confirm('Run `claude-web-chat update`?', { def: false })) {
        await deps.inRoot(root, () => deps.update([]));
      }
    }
    log('');
  }

  // 5. Print-only. Never offered, never automated.
  const info = portfiles.readPortfile('server', { root });
  if (info) {
    const pend = await deps.client.get('/api/services/pending', { root, port: info.port, noSpawn: true }).catch(() => null);
    const pending = (pend && pend.pending) || [];
    if (pending.length) {
      log(`${pending.length} service ${plural(pending.length, 'approval')} waiting:`);
      for (const s of pending) log(`  claude-web-chat trust ${s.name}`);
      log(`  Only a terminal can grant this. A component's own pane script runs in the surface's`);
      log(`  realm with no CSP, so nothing rendered in the page can gate the host code asking`);
      log(`  for the grant — only a real shell can.`);
      log('');
    }
  }
  const sizes = [];
  for (const [label, dir] of [['exports', p.exports], ['captures', p.captures]]) {
    const bytes = deps.dirSize(dir);
    if (bytes > 1024 * 1024) sizes.push(`${label} ${(bytes / (1024 * 1024)).toFixed(1)} MB (${dir})`);
  }
  if (sizes.length) {
    log(`On disk: ${sizes.join(' · ')}`);
    log(`  init never deletes anything under .web-chat/ — remove what you don't want by hand.`);
    log('');
  }

  // 6. Tour offer — last, default No, and only for a project that has never seen it.
  if (flags.tour !== false && !onboardedFor(root) && info && canAct) {
    if (await prompt.confirm('Never seen the surface tour?', { def: false })) {
      await waitForViewer({ root, http: deps.client, sleep: deps.sleep, capMs: deps.viewerWaitMs });
      const policy = await deps.client.get('/api/queue/policy', { root, noSpawn: true }).catch(() => null);
      const ok = await mountTour({
        root, channelConnected: Boolean(policy && policy.channel_connected), http: deps.client, log,
      });
      if (ok) log(`  Tour mounted at ${info.url}.`);
      stampOnboarded(root, { version, tour: ok });
      log('');
    }
  }

  // 7. Doctor's own roll-up, and exactly ONE next action chosen from it.
  const s = doctorSummary || { ok: 0, repaired: 0, problems: 0, checks: [] };
  log(`${s.ok} ok · ${s.repaired} repaired · ${s.problems} ${plural(s.problems, 'problem')}`);
  const health = info ? await deps.client.get('/api/health', { root, port: info.port, noSpawn: true }).catch(() => null) : null;
  const restart = deps.describeRestart({ seen: (health && health.mcp_seen) || deps.readMcpSeen(root), mcpWrittenAt: deps.mcpWrittenAt(root) });
  if (restart.state === 'stale') log(`Next: /exit and reopen Claude Code — its tool list predates the last .mcp.json write.`);
  else if (!health || health.viewers === 0) log(`Next: \`claude-web-chat open\` — nothing is watching the surface.`);
  else log(`Next: /web-chat — Claude renders a first pane about this project.`);

  return { doctorSummary };
}

// ------------------------------------------------------------------- entry ----

async function init(args = [], opts = {}) {
  const flags = parseFlags(args);
  const log = opts.log || ((s) => console.log(s));
  const cwd = opts.cwd || process.cwd();

  const deps = {
    client: opts.client || require('../../client'),
    install: opts.install || require('./install'),
    doctor: opts.doctor || require('./doctor'),
    open: opts.open || require('./open'),
    ls: opts.ls || require('./ls'),
    on: opts.on || require('./on'),
    update: opts.update || require('./update'),
    collectRows: opts.collectRows || require('../../util/registry').rows,
    reap: opts.reap || require('../reap').reap,
    reconcile: opts.reconcile || require('../../update/managed-files').reconcileManagedFiles,
    resolveToggle: opts.resolveToggle || require('../../toggle/policy').resolve,
    describeRestart: opts.describeRestart || require('../../core/mcp-seen').describeRestart,
    readMcpSeen: opts.readMcpSeen || require('../../core/mcp-seen').readMcpSeen,
    mcpWrittenAt: opts.mcpWrittenAt || require('../../core/mcp-seen').mcpWrittenAt,
    hasClaude: opts.hasClaude || defaultHasClaude,
    // registration's injectable git runner (gitFacts), for the .gitignore line.
    git: opts.git,
    dirSize: opts.dirSize || defaultDirSize,
    sleep: opts.sleep,
    // How long to wait for a browser to attach before mounting the tour anyway.
    // Mounts are server-side state and are re-delivered on hello, so the wait is
    // a courtesy, never a requirement — and tests set it to 0.
    viewerWaitMs: opts.viewerWaitMs != null ? opts.viewerWaitMs : 15000,
    // init's root need not be the cwd: a folder can be named, and with
    // --nearest-parent the root is the install above the folder. open, on, ls
    // and update resolve their project from process.cwd() (install is also
    // handed cwd: root), so every step runs from the root and the cwd is put
    // back — a named folder, or a subdir with --nearest-parent, is set up or
    // repaired, never the directory init was typed in.
    inRoot: opts.inRoot || (async (root, fn) => {
      const prev = process.cwd();
      let moved = false;
      try { if (path.resolve(prev) !== path.resolve(root)) { process.chdir(root); moved = true; } } catch {}
      try { return await fn(); } finally { if (moved) { try { process.chdir(prev); } catch {} } }
    }),
  };

  // Which folder, by the one reader `install` shares (setupRoot). A missing
  // folder, a file, or two folders is refused here, before anything happens.
  let target;
  try {
    target = setupRoot(args, { cwd, command: 'claude-web-chat init', usage: USAGE });
  } catch (e) {
    if (e && e.userFacing) {
      console.error(e.message);
      process.exitCode = 1;
      return null;
    }
    throw e;
  }
  const { root } = target;
  // Existing iff an install is at the root: with --nearest-parent, one was
  // found at or above the folder; by default, the folder's own .web-chat/ —
  // never $HOME's, which is the user tier (freshMode refuses $HOME).
  const mode = target.source === 'detected' || (target.source === 'here' && !isHomeDir(root) && isInstalled(root))
    ? 'existing' : 'fresh';
  const version = require('../../../package.json').version;

  // The release check is a 2.5s HTTPS call. Kick it off now so it overlaps the
  // local surveys instead of serializing in front of them. In --report mode it
  // must not FETCH (a fetch rewrites the throttle cache), so it only peeks.
  const latestPromise = opts.latest !== undefined
    ? Promise.resolve(opts.latest)
    : (flags.report
      ? Promise.resolve(peekLatest({ currentVersion: version })).catch(() => null)
      : resolveLatest({ currentVersion: version }).catch(() => null));

  const prompt = opts.prompt || createPrompt({
    log,
    noInput: flags.noInput || flags.report,
    yes: flags.yes,
  });

  // One run's answers to the MCP questions (lib/setup/registration
  // mcpConsent), shared by the doctor and the install it may run, so nothing
  // is asked twice.
  const ctx = { log, flags, prompt, deps, root, mode, version, latestPromise, mcpDecisions: {}, target };

  let doctorSummary = null;
  try {
    if (flags.report) {
      // READ-ONLY. doctor runs with dryRun, nothing is installed, no prompt is
      // asked, no browser opens, no tour is mounted.
      if (mode === 'existing') {
        const quietLog = flags.json ? () => {} : log;
        doctorSummary = await deps.doctor([], { cwd: root, log: quietLog, dryRun: true });
        if (!flags.json) log('');
      }
      const state = await gatherState({ root, mode, doctorSummary, latest: await latestPromise, deps });
      state.mcp = mcpReport(root, deps);
      // Which rule picked the root ('here': the folder itself; 'nearest-parent':
      // the install at or above it), and the install above a 'here' root.
      state.root_rule = target.rule;
      state.enclosing = target.enclosing;
      if (!flags.json) {
        printReport(state, log, { again: nearestParentCommand(target) });
        log('');
        log(STATE_FENCE);
      }
      log(JSON.stringify(state, null, 2));
      if (state.doctor.problems > 0) process.exitCode = 1;
      return state;
    }

    if (mode === 'fresh') await freshMode(ctx);
    else ({ doctorSummary } = await existingMode(ctx));
  } catch (e) {
    if (e && e.userFacing) {
      console.error(e.message);
      process.exitCode = 1;
      return null;
    }
    throw e;
  } finally {
    // A piped run must never be left alive by an open readline.
    prompt.close();
  }
  return null;
}

// The command that checks the install above instead. It names the folder when
// one was named: typed elsewhere, a bare `init --nearest-parent` would walk up
// from the cwd, not from the folder.
function nearestParentCommand(target = {}) {
  return `claude-web-chat init --nearest-parent${target.named ? ` ${target.root}` : ''}`;
}

// What the install will do about .gitignore, as init's precheck line says it.
function gitignoreOutlook(root, deps = {}) {
  let plan;
  try { plan = gitignorePlan(root, { dryRun: true, git: deps.git }); } catch { plan = { action: 'no-gitignore', inWorkTree: false }; }
  const repo = plan.inWorkTree || fs.existsSync(path.join(root, '.git'));
  let line;
  if (plan.action === 'added') {
    line = repo ? '✓ git repo — .web-chat/ gets a .gitignore line' : '✓ .web-chat/ gets a line in the .gitignore already here';
  } else if (plan.action === 'already-present') {
    line = repo ? '✓ git repo — .web-chat/ is already ignored here, so .gitignore is left alone' : '✓ .gitignore already ignores .web-chat/';
  } else {
    line = '• not a git repo — the .gitignore line is skipped';
  }
  return { action: plan.action, line };
}

// Is there a `claude` to register the MCP server with? The same search the
// registration runs (lib/core/claude-cli findClaude: PATH, ~/.local/bin,
// ~/.claude/local).
function defaultHasClaude() {
  return findClaude() !== null;
}

// The MCP registration, for `init --report`'s JSON: the same state and words
// status and doctor print, without anything read out of Claude Code's config
// beyond the entry's shape (lib/setup/registration mcpState). A pure read.
function mcpReport(root, deps = {}) {
  try {
    const st = (deps.mcpState || mcpState)(root);
    const said = describeMcp(st, { installed: fs.existsSync(projectPaths(root).dir) });
    return {
      state: st.kind,
      line: said.line,
      notes: said.notes,
      config_file: st.local.configFile,
      key: st.local.key,
      covers_repository: st.coversRepo,
      bin: st.bin,
      bin_differs: st.binDiffers,
      mcp_json: { present: st.mcp.present, kind: st.mcp.kind, resolvable: st.mcp.resolvable },
      rejected_in: st.approvals.rejections.map((r) => r.file),
      disabled: st.local.disabled,
      approval_dialog: st.dialog,
      nested: st.nested,
    };
  } catch (e) {
    return { state: 'unknown', line: `could not read the MCP registration: ${e.message}` };
  }
}

function defaultDirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += defaultDirSize(f);
      else total += fs.statSync(f).size;
    } catch {}
  }
  return total;
}

// The Node precondition, as a pure function of a version string so it can be
// tested without a Node 20 to run it on. Returns null when the version is fine,
// or the line `init` prints before refusing — which names the floor AND why it
// is where it is, because "upgrade Node" without a reason reads as a whim.
function nodeFloorMessage(version = process.versions.node) {
  const { ok, floor } = checkNodeFloor(version);
  if (ok) return null;
  return `Node ${version} — web-chat needs Node ${floor} or newer: one of its dependencies is ESM-only and require(esm) landed in ${floor}, so the daemon cannot start on anything older. Upgrade, then run this again.`;
}

module.exports = init;
module.exports.nodeFloorMessage = nodeFloorMessage;
module.exports.STATE_FENCE = STATE_FENCE;
module.exports.TOUR_MOUNT = TOUR_MOUNT;
module.exports.TOUR_MIRROR_MOUNT = TOUR_MIRROR_MOUNT;
module.exports.TOUR_COMPONENT = TOUR_COMPONENT;
module.exports.writeList = writeList;
module.exports.mcpReport = mcpReport;

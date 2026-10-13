// `claude-web-chat mod on|off|status` — the per-project switch for the web-chat
// mod (spec §15.7, tier 2): a Claude Code plugin of function hooks that runs
// inside the session and speaks the daemon's bridge.
//
// The mod is on by default — `install` (and `init`, through it) switches it on
// wherever Claude Code can run it (ruling C1 (b)) — so this command is the
// switch a user reaches for to change that:
//
//   mod on      removes the project's recorded opt-out, then runs the probe
//               (`claude --version` ≥ MOD_MIN_CLAUDE, hooks not turned off,
//               `claude plugin validate` of the staged copy) and installs the
//               plugin from the project's own marketplace at LOCAL scope
//               through Claude Code's own commands (lib/setup/registration
//               applyMod). Below the floor or with hooks off it says "mod
//               unavailable" and installs nothing: web-chat works without it.
//   mod off     uninstalls it and removes the project's marketplace (Claude
//               Code's own commands again), removes what `mod on` staged under
//               .web-chat/mod/, and RECORDS THE OPT-OUT
//               (.web-chat/mod/opted-out.json), which a later `install`
//               respects and `mod on` removes.
//   mod status  the state ('on', 'off (opted out)', 'tier 1: <reason>'), the
//               staged version against this web-chat's, whether the project's
//               settings.local.json lists the plugin, and — asked of this
//               project's own daemon, found with lib/util/registry daemonFor —
//               each session the mod has attached.
//
// web-chat never edits a Claude Code settings file here; only `claude`'s own
// commands do. Every `claude` run goes through lib/core/claude-cli runClaude
// from the project root (injectable as opts.runClaude).

const {
  resolveRoot, applyMod, removeMod, inspectMod, modArgv, modPaths, recordModOptOut, clearModOptOut, defaultRunClaude,
} = require('../../setup/registration');
const { MOD_MIN_CLAUDE } = require('../../core/mod-protocol');
const { packageVersion } = require('../../core/versions');
const fs = require('fs');

const USAGE = 'usage: claude-web-chat mod on|off|status';
const NO_SESSION_LINE = 'no session has attached — start or restart Claude Code here; with mods turned off (safe mode, --bare, a policy, the account\'s rollout) web-chat carries on without it';
const NETWORK_LINE = 'if a network policy refuses the mod\'s call to this daemon: network refused: tier 1';
const RESTART_LINE = (root) => `mod on for ${root}: restart Claude Code here to load it (a running session does not pick it up)`;

function cmdLine(argv) {
  return `claude ${argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, '\'\\\'\'')}'`)).join(' ')}`;
}

function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

async function modOn(root, { runClaude, log }) {
  if (clearModOptOut(root)) log('(the project\'s mod opt-out is removed)');
  const r = applyMod(root, { runClaude, respectOptOut: false });
  if (r.kind === 'no-claude') {
    const mp = modPaths(root);
    log('mod unavailable: Claude Code\'s `claude` command was not found (not on PATH, in ~/.local/bin or in ~/.claude/local).');
    log(`Install Claude Code ${MOD_MIN_CLAUDE} or newer and run \`claude-web-chat mod on\` again — it stages the mod and runs, in ${root}:`);
    log(`  ${cmdLine(modArgv('marketplace-add', mp.pkg))}`);
    log(`  ${cmdLine(modArgv('install', r.marketplace))}`);
    log('web-chat works without the mod.');
    return { ok: false, state: r.state, exitCode: 1 };
  }
  if (r.kind === 'old' || r.kind === 'version') {
    log(`mod unavailable: ${r.kind === 'old' ? `Claude Code ${r.cc_version} is older than ${MOD_MIN_CLAUDE}` : r.reason} — web-chat works without it`);
    return { ok: false, state: r.state, exitCode: 1 };
  }
  if (r.kind === 'hooks') {
    log(`mod unavailable: ${r.reason} — web-chat works without it`);
    return { ok: false, state: r.state, exitCode: 1 };
  }
  if (r.kind === 'validate') {
    log(`mod unavailable: ${r.reason}`);
    return { ok: false, state: r.state, exitCode: 1 };
  }
  if (r.advisory) log(r.advisory);
  if (r.kind === 'failed') {
    log(`mod not switched on: ${r.reason}`);
    return { ok: false, state: r.state, exitCode: 1 };
  }
  if (r.changed === 'none') {
    log(`mod already on for ${root} (v${r.version}): nothing to do`);
    return { ok: true, state: 'on', changed: 'none' };
  }
  if (r.changed === 'updated') log(`mod updated to v${r.version}`);
  log(RESTART_LINE(root));
  return { ok: true, state: 'on', changed: r.changed };
}

function modOff(root, { runClaude, log }) {
  const before = inspectMod(root);
  const mp = modPaths(root);
  let r = null;
  if (before.installed || fs.existsSync(mp.pkg)) r = removeMod(root, { runClaude });
  recordModOptOut(root, 'mod off');
  if (r && r.status === 'claude not on PATH') {
    log('Claude Code\'s `claude` command was not found — to take the mod off, run in ' + root + ':');
    for (const argv of r.commands) log(`  ${cmdLine(argv)}`);
    log('The opt-out is recorded: `claude-web-chat install` will not switch the mod on here again.');
    return { ok: false, state: 'off (opted out)', exitCode: 1 };
  }
  if (r && r.status === 'could not remove') {
    log(`mod off: Claude Code could not remove it (${r.error}) — run in ${root}:`);
    for (const argv of r.commands) log(`  ${cmdLine(argv)}`);
    log('The opt-out is recorded: `claude-web-chat install` will not switch the mod on here again.');
    return { ok: false, state: 'off (opted out)', exitCode: 1 };
  }
  log(r ? `mod off for ${root}: uninstalled at local scope; restart Claude Code here to unload it` : `mod off for ${root}: it was not installed`);
  log('The opt-out is recorded: `claude-web-chat install` will not switch it on here again (`claude-web-chat mod on` does).');
  return { ok: true, state: 'off (opted out)' };
}

async function modStatus(root, { log, daemonFor, get }) {
  const m = inspectMod(root);
  const version = packageVersion();
  log(`web-chat mod: ${m.state}`);
  if (m.installed) {
    const staged = m.staged_version ? `staged v${m.staged_version}` : 'not staged';
    const behind = m.version !== version ? ` — this web-chat is v${version}: run \`claude-web-chat mod on\` again` : '';
    log(`  installed: v${m.version} (${m.plugin_id}, ${staged})${behind}`);
  } else {
    log(`  installed: no${m.opted_out ? ' — `claude-web-chat mod on` switches it on' : ' — `claude-web-chat mod on` installs it'}`);
  }
  log(`  .claude/settings.local.json: ${m.listed ? 'lists' : 'does not list'} ${m.plugin_id} in enabledPlugins`);

  let d = null;
  try { d = await daemonFor(root); } catch { d = null; }
  if (!d) {
    log('  sessions: the web-chat server is not running here (`claude-web-chat open` starts it); a session attaches once it runs');
    log(`  ${NETWORK_LINE}`);
    return { ok: true, state: m.state, mod: m, daemon: false, sessions: null };
  }
  let status = null;
  try { status = await get('/api/bridge/status', { port: d.port, noSpawn: true }); } catch { status = null; }
  const sessions = status && Array.isArray(status.sessions) ? status.sessions : null;
  if (!sessions) {
    log(`  sessions: the web-chat server (pid ${d.pid}) has no mod bridge to ask — \`claude-web-chat restart\` brings this build's`);
  } else if (!sessions.length) {
    log(`  ${NO_SESSION_LINE}`);
  } else {
    const now = Date.now();
    for (const s of sessions) {
      const driver = s.shapes && Array.isArray(s.shapes.driver) && s.shapes.driver[0] ? ` · driver ${s.shapes.driver[0]}` : '';
      log(`  session ${String(s.session_id || '').slice(0, 8)} · Claude Code ${s.cc_version || '?'} · mod v${s.mod_version || '?'} · attached ${ago(now - s.attached_at)} · last poll ${ago(now - s.last_poll_at)} ago${driver}`);
    }
  }
  log(`  ${NETWORK_LINE}`);
  return { ok: true, state: m.state, mod: m, daemon: true, sessions };
}

async function mod(args = [], opts = {}) {
  const log = opts.log || ((s = '') => console.log(s));
  const sub = args[0];
  if (!['on', 'off', 'status'].includes(sub)) {
    log(USAGE);
    process.exitCode = 1;
    return { ok: false, exitCode: 1 };
  }
  const { root } = resolveRoot(opts.cwd || process.cwd(), { mode: 'existing' });
  const runClaude = opts.runClaude || defaultRunClaude;
  let out;
  if (sub === 'on') out = await modOn(root, { runClaude, log });
  else if (sub === 'off') out = modOff(root, { runClaude, log });
  else {
    out = await modStatus(root, {
      log,
      daemonFor: opts.daemonFor || require('../../util/registry').daemonFor,
      get: opts.get || require('../../client').get,
    });
  }
  if (out.exitCode) process.exitCode = out.exitCode;
  return { ...out, root };
}

module.exports = mod;
module.exports.USAGE = USAGE;
module.exports.NO_SESSION_LINE = NO_SESSION_LINE;
module.exports.NETWORK_LINE = NETWORK_LINE;

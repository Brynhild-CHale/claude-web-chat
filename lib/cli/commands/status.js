const fs = require('fs');
const { resolve: resolveToggle } = require('../../toggle/policy');
const portfiles = require('../../core/portfiles');
const { projectPaths, userPaths } = require('../../core/paths');
const { resolveRoot, inspect } = require('../../setup/registration');
const { conflictSummary } = require('../../update/managed-files');
const { readMcpSeen, mcpWrittenAt, describeRestart } = require('../../core/mcp-seen');
const client = require('../../client');

// A layman-facing one-liner for the channels wake wiring. `envWired`
// is whether the .mcp.json web-chat entry carries WEB_CHAT_CHANNEL=1; `policy` is
// the GET /api/queue/policy body (null when the daemon is down/unreachable, so we
// can't observe a live connection — but the env wiring is still reported).
// Channels is a property of the SESSION, not the project — it exists only when
// Claude Code was launched with the capability flag. So the live policy is the
// only real signal; a WEB_CHAT_CHANNEL pinned into .mcp.json is now a defect to
// report (it makes the bridge fake a channel in sessions that have none), not
// the desired state it used to be.
function describeChannels({ staleEnv, policy }) {
  if (staleEnv) {
    return { state: 'stale-env', line: 'stale WEB_CHAT_CHANNEL in .mcp.json — run `claude-web-chat doctor`' };
  }
  if (policy && policy.channel_connected) {
    return { state: 'connected', line: 'connected' };
  }
  return { state: 'parked', line: 'not connected — a Push delivers with your next message' };
}

// `opts.cwd` exists so the command can be handed a directory instead of being
// driven through process.chdir — status takes no arguments otherwise, which is
// why its tests had to mutate global process state to point it anywhere.
async function status(args = [], opts = {}) {
  const user = userPaths();
  const root = resolveRoot(opts.cwd || process.cwd(), { mode: 'install' }).root;
  const p = projectPaths(root);
  // One read of the registration model — the same one doctor reports on, so the
  // two can no longer disagree about what is registered here.
  const reg = inspect(root);
  const pkg = require('../../../package.json');

  console.log(`claude-web-chat v${pkg.version}`);
  console.log();

  // Per-scope state
  const userDisabled = fs.existsSync(user.disabled);
  console.log(`User:     ${userDisabled ? 'DISABLED' : 'enabled'}`);

  if (!fs.existsSync(p.dir)) {
    console.log(`Project:  not installed (no .web-chat/) — run \`claude-web-chat init\``);
  } else {
    const disabled = fs.existsSync(p.disabled);
    console.log(`Project:  ${disabled ? 'DISABLED' : 'enabled'}  (${root})`);
    if (fs.existsSync(p.version)) {
      try {
        const v = JSON.parse(fs.readFileSync(p.version, 'utf8')).version;
        console.log(`          schema v${v}`);
      } catch {}
    }
    if (fs.existsSync(p.meta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
        const nodeFiles = fs.readdirSync(p.graphDir).filter(f => f.endsWith('.json') && f !== '_meta.json');
        console.log(`          graph: ${nodeFiles.length} node(s), active=${meta.active}`);
      } catch {}
    }
  }

  // Session scope
  let disabledSessions = [];
  if (fs.existsSync(user.sessionsDir)) {
    disabledSessions = fs.readdirSync(user.sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  }
  if (disabledSessions.length === 0) {
    console.log(`Session:  no disabled sessions`);
  } else {
    console.log(`Session:  ${disabledSessions.length} disabled: ${disabledSessions.slice(0, 5).join(', ')}${disabledSessions.length > 5 ? '…' : ''}`);
  }

  // Effective resolution
  const sessionId = process.env.CLAUDE_SESSION_ID;
  const decision = resolveToggle({ cwd: root, sessionId });
  if (!decision.enabled) {
    console.log(`Effective: DISABLED by ${decision.by} scope`);
  } else {
    console.log(`Effective: enabled`);
  }
  console.log();

  // Daemon. When it's up, fetch the queue policy so the Channels line below can
  // report the live connection state (never spawn — status must be read-only).
  const info = portfiles.readPortfile('server', { root });
  let policy = null;
  if (info) {
    console.log(`Server:   running at ${info.url} (pid ${info.pid})`);
    try {
      policy = await client.get('/api/queue/policy', { port: info.port, root, noSpawn: true });
    } catch { /* daemon flapped between portfile read and fetch — treat as no policy */ }
  } else if (portfiles.readPortfile('server', { root, checkLiveness: false })) {
    console.log(`Server:   portfile present but stale (process not running)`);
  } else {
    console.log(`Server:   not running (use \`claude-web-chat open\` to start)`);
  }

  // MCP registration. Presence is not the question doctor answers — a bare or
  // ${CLAUDE_PLUGIN_ROOT}-stub entry is "registered" and still cannot spawn — so
  // status reports resolvability from the same classifier doctor uses.
  if (reg.mcp.file === 'unparseable') {
    console.log(`MCP:      error reading .mcp.json`);
  } else if (reg.mcp.file === 'absent') {
    console.log(`MCP:      not registered (no .mcp.json) — run \`claude-web-chat init\``);
  } else if (!reg.mcp.present) {
    console.log(`MCP:      .mcp.json present but no web-chat entry`);
  } else {
    console.log(`MCP:      registered in .mcp.json${reg.mcp.resolvable ? '' : ` — NOT resolvable: ${reg.mcp.reason} (run \`claude-web-chat doctor\`)`}`);
    // Registered ≠ loaded. Claude Code reads .mcp.json only at startup, so
    // an `install` since the session began means the 23 tools are not there.
    // The verdict is honest tri-state — see lib/core/mcp-seen.js.
    const restart = describeRestart({ seen: readMcpSeen(root), mcpWrittenAt: mcpWrittenAt(root) });
    const tag = restart.state === 'stale' ? 'RESTART' : restart.state === 'fresh' ? 'loaded' : 'unknown';
    console.log(`          ${tag}: ${restart.line}`);
  }

  // Channels wake wiring. Reports whether WEB_CHAT_CHANNEL=1 is
  // wired into the .mcp.json entry, and — when the daemon is up — whether a
  // channel-enabled Claude Code session is actually connected.
  const ch = describeChannels({ staleEnv: reg.mcp.channelEnv, policy });
  console.log(`Channels: ${ch.line}`);

  // Hooks, per EVENT. This line used to count handler GROUPS while doctor
  // counted individual handlers — two numbers for the same file, neither of
  // which noticed a missing event.
  if (reg.hooksFile === 'unparseable') {
    console.log(`Hooks:    error reading .claude/settings.json`);
  } else if (reg.hooksFile === 'absent') {
    console.log(`Hooks:    no .claude/settings.json`);
  } else {
    const events = Object.keys(reg.hooks);
    const missing = events.filter((e) => reg.hooks[e] === 'missing');
    const bare = events.filter((e) => reg.hooks[e] === 'bare');
    const registered = events.length - missing.length;
    let line = registered === 0
      ? 'not registered'
      : `${registered}/${events.length} registered in .claude/settings.json`;
    if (missing.length && registered) line += ` — missing: ${missing.join(', ')} (run \`claude-web-chat install\`)`;
    if (bare.length) line += ` — bare command: ${bare.join(', ')} (run \`claude-web-chat doctor\`)`;
    console.log(`Hooks:    ${line}`);
  }

  // Managed files (edit-preserving template sync)
  if (fs.existsSync(p.dir)) {
    if (reg.managedError) {
      console.log(`Managed:  error checking (${reg.managedError})`);
    } else {
      const results = reg.managed;
      const conflicts = results.filter(r => r.action === 'conflict');
      const differs = results.filter(r => r.action === 'differs');
      const stale = results.filter(r => r.action === 'updated' || r.action === 'created');
      if (conflicts.length) {
        // Same words for the resolution step as install/update/init, from the
        // same helper — status just says it on one line.
        console.log(`Managed:  ${conflictSummary(results)}`);
      } else if (stale.length || differs.length) {
        const n = stale.length + differs.length;
        console.log(`Managed:  ${n} need refresh (run \`claude-web-chat install\`)`);
      } else {
        console.log(`Managed:  up to date`);
      }
    }
  }
}

module.exports = status;
module.exports.describeChannels = describeChannels;

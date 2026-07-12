const fs = require('fs');
const path = require('path');
const { resolve: resolveToggle } = require('../../toggle/policy');
const portfiles = require('../../core/portfiles');
const { projectPaths, userPaths } = require('../../core/paths');
const { findProjectRoot } = require('../../util/root');
const { reconcileManagedFiles, mcpEntryHasChannelEnv } = require('../../update/managed-files');
const client = require('../../client');

// A layman-facing one-liner for the channels wake wiring. `envWired`
// is whether the .mcp.json web-chat entry carries WEB_CHAT_CHANNEL=1; `policy` is
// the GET /api/queue/policy body (null when the daemon is down/unreachable, so we
// can't observe a live connection — but the env wiring is still reported).
function describeChannels({ envWired, policy }) {
  if (!envWired) {
    return { state: 'unwired', line: 'not wired — run `claude-web-chat install`' };
  }
  if (policy && policy.channel_connected) {
    return { state: 'connected', line: 'connected' };
  }
  return { state: 'wired', line: 'wired, waiting for a channel-enabled Claude Code session' };
}

async function status() {
  const user = userPaths();
  const root = findProjectRoot(process.cwd()) || process.cwd();
  const p = projectPaths(root);
  const pkg = require('../../../package.json');

  console.log(`claude-web-chat v${pkg.version}`);
  console.log();

  // Per-scope state
  const userDisabled = fs.existsSync(user.disabled);
  console.log(`User:     ${userDisabled ? 'DISABLED' : 'enabled'}`);

  if (!fs.existsSync(p.dir)) {
    console.log(`Project:  not installed (no .web-chat/) — run \`claude-web-chat install\``);
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

  // MCP registration
  const mcpPath = path.join(root, '.mcp.json');
  let mcpEntry = null;
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      mcpEntry = mcp.mcpServers && mcp.mcpServers['web-chat'];
      if (mcpEntry) {
        console.log(`MCP:      registered in .mcp.json`);
      } else {
        console.log(`MCP:      .mcp.json present but no web-chat entry`);
      }
    } catch {
      console.log(`MCP:      error reading .mcp.json`);
    }
  } else {
    console.log(`MCP:      not registered (no .mcp.json) — run \`claude-web-chat install\``);
  }

  // Channels wake wiring. Reports whether WEB_CHAT_CHANNEL=1 is
  // wired into the .mcp.json entry, and — when the daemon is up — whether a
  // channel-enabled Claude Code session is actually connected.
  const ch = describeChannels({ envWired: mcpEntryHasChannelEnv(mcpEntry), policy });
  console.log(`Channels: ${ch.line}`);

  // Hooks
  const settingsPath = path.join(root, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      let ours = 0;
      for (const event of Object.keys(settings.hooks || {})) {
        for (const h of settings.hooks[event]) {
          if (h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-web-chat-hook'))) {
            ours++;
          }
        }
      }
      console.log(`Hooks:    ${ours > 0 ? `${ours} registered in .claude/settings.json` : 'not registered'}`);
    } catch {
      console.log(`Hooks:    error reading .claude/settings.json`);
    }
  } else {
    console.log(`Hooks:    no .claude/settings.json`);
  }

  // Managed files (edit-preserving template sync)
  if (fs.existsSync(p.dir)) {
    try {
      const results = reconcileManagedFiles(root, { dryRun: true });
      const conflicts = results.filter(r => r.action === 'conflict');
      const differs = results.filter(r => r.action === 'differs');
      const stale = results.filter(r => r.action === 'updated' || r.action === 'created');
      if (conflicts.length) {
        console.log(`Managed:  conflicts: ${conflicts.map(r => r.dest).join(', ')} — see .new sidecars`);
      } else if (stale.length || differs.length) {
        const n = stale.length + differs.length;
        console.log(`Managed:  ${n} need refresh (run \`claude-web-chat install\`)`);
      } else {
        console.log(`Managed:  up to date`);
      }
    } catch (e) {
      console.log(`Managed:  error checking (${e.message})`);
    }
  }
}

module.exports = status;
module.exports.describeChannels = describeChannels;

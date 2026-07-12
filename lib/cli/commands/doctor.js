const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const portfiles = require('../../core/portfiles');
const { projectPaths } = require('../../core/paths');
const { findProjectRoot } = require('../../util/root');
const { lockIsStale } = require('../../server/domain/turns');
const { channelEnv, mcpEntryHasChannelEnv } = require('../../update/managed-files');
const client = require('../../mcp/client');

// Default shell-out to the Claude Code CLI for the MCP repair. Injectable so the
// repair path is testable without a real `claude` on PATH.
function defaultRunClaude(argv) {
  try {
    const stdout = execFileSync('claude', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: stdout || '' };
  } catch (e) {
    return { ok: false, stderr: (e.stderr || e.message || '').toString() };
  }
}

// Is the .mcp.json web-chat entry something Claude Code can actually spawn from
// this checkout? Bare PATH-dependent commands and unexpanded ${CLAUDE_PLUGIN_ROOT}
// (a plugin stub running outside a plugin install — the dogfooding case) are not.
function classifyMcpEntry(entry) {
  if (!entry) return { resolvable: false, reason: 'no web-chat entry' };
  const blob = JSON.stringify(entry);
  if (blob.includes('${CLAUDE_PLUGIN_ROOT}')) {
    // Plugin stub. The plugin host expands the placeholder at spawn time, so it
    // resolves iff CLAUDE_PLUGIN_ROOT is set; otherwise it's the dogfooding case
    // doctor is here to repair. (Checked before the path tests below, which can't
    // see through an unexpanded `${...}`.)
    return process.env.CLAUDE_PLUGIN_ROOT
      ? { resolvable: true }
      : { resolvable: false, reason: 'uses ${CLAUDE_PLUGIN_ROOT} but it is not set (plugin stub outside a plugin install)' };
  }
  const cmd = entry.command;
  const args = Array.isArray(entry.args) ? entry.args : [];
  // `node <abs path>` or a direct absolute path to an existing file is resolvable.
  if (cmd === 'node' && args[0] && path.isAbsolute(args[0]) && fs.existsSync(args[0])) {
    return { resolvable: true };
  }
  if (cmd && path.isAbsolute(cmd) && fs.existsSync(cmd)) {
    return { resolvable: true };
  }
  // A bare command (e.g. `claude-web-chat-mcp`) only resolves if it happens to be
  // on PATH at spawn time — fragile, and the failure that motivated `doctor`.
  return { resolvable: false, reason: `bare/PATH-dependent command '${cmd}'` };
}

async function doctor(args = [], opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runClaude = opts.runClaude || defaultRunClaude;
  const log = opts.log || ((s) => console.log(s));

  const root = findProjectRoot(cwd) || cwd;
  const webChatDir = projectPaths(root).dir;
  const summary = { problems: 0, repaired: 0, ok: 0, checks: [] };
  const ok = (m) => { summary.ok++; summary.checks.push({ status: 'ok', m }); log(`  ✓ ${m}`); };
  const fixed = (m) => { summary.repaired++; summary.checks.push({ status: 'repaired', m }); log(`  ✓ ${m}  [repaired]`); };
  const warn = (m) => { summary.problems++; summary.checks.push({ status: 'problem', m }); log(`  ✗ ${m}`); };
  const note = (m) => { summary.checks.push({ status: 'note', m }); log(`  • ${m}`); };

  log(`claude-web-chat doctor — ${root}`);

  if (!fs.existsSync(webChatDir)) {
    warn('not installed (no .web-chat/) — run `claude-web-chat install`');
    return summary;
  }

  // 1. Daemon liveness + stale portfile.
  const portfilePath = projectPaths(root).serverJson;
  const info = portfiles.readPortfile('server', { root }); // null if pid is dead / file malformed
  let running = false;
  if (info) {
    const reachable = await portfiles.probeReachable(info.port, 500);
    if (reachable) {
      running = true;
      ok(`daemon running at ${info.url} (pid ${info.pid})`);
    } else {
      warn(`daemon pid ${info.pid} is alive but not answering on port ${info.port} — try \`claude-web-chat restart\``);
    }
  } else if (fs.existsSync(portfilePath)) {
    portfiles.deletePortfile('server', { root });
    fixed('removed stale portfile (the process it pointed at is gone)');
  } else {
    note('daemon not running (start it with `claude-web-chat open`)');
  }

  // 2. Graph lock. A running daemon's lock might be a genuine in-progress turn,
  // so only steal it if it's past the TTL (matching turn-begin). With no daemon
  // running, any persisted lock is orphaned (its holder is gone) → clear it.
  if (running) {
    try {
      const health = await client.get('/api/health', { port: info.port, noSpawn: true });
      if (health && health.lock) {
        if (lockIsStale(health.lock)) {
          await client.post('/api/unlock', {}, { port: info.port, noSpawn: true });
          fixed('cleared a stale graph lock (orphaned by an interrupted turn)');
        } else {
          note('graph is locked by an in-progress turn (not stale — leaving it)');
        }
      } else {
        ok('graph lock clear');
      }
    } catch (e) {
      warn(`could not read /api/health: ${e.message}`);
    }
  } else {
    const metaPath = path.join(webChatDir, 'graph', '_meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.lock) {
          // Daemon is down, so this lock has no live holder regardless of age
          // (boot would clear it too — repair now so it never survives a start).
          meta.lock = null;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          fixed('cleared an orphaned graph lock persisted in graph/_meta.json (daemon not running)');
        } else {
          ok('graph lock clear');
        }
      } catch {
        warn('could not read graph/_meta.json');
      }
    }
  }

  // 3. MCP registration resolvability.
  const mcpPath = path.join(root, '.mcp.json');
  let mcpEntry = null;
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      mcpEntry = mcp.mcpServers && mcp.mcpServers['web-chat'];
    } catch {
      warn('could not parse .mcp.json');
    }
  }
  const cls = classifyMcpEntry(mcpEntry);
  if (cls.resolvable) {
    ok('MCP registration in .mcp.json is resolvable');
  } else {
    warn(`MCP registration not resolvable: ${cls.reason}`);
    const mcpBin = path.join(__dirname, '..', '..', '..', 'bin', 'claude-web-chat-mcp.js');
    const argv = ['mcp', 'add', 'web-chat', '--scope', 'local', '--', 'node', mcpBin];
    // Repair at *local* scope with an absolute path so the committed .mcp.json
    // (correct as a plugin stub) is left untouched but Claude Code still spawns.
    const r = runClaude(argv);
    if (r.ok) {
      fixed(`registered web-chat at local scope: claude ${argv.join(' ')}`);
    } else if (/already exists/i.test(r.stderr || '')) {
      fixed('web-chat already registered at local scope (overrides the unresolvable .mcp.json entry)');
    } else {
      note(`run this to repair manually: claude ${argv.join(' ')}`);
    }
  }

  // 3b. Channels env wiring on the .mcp.json entry. An earlier
  // install (or a hand-added entry) carries no WEB_CHAT_CHANNEL=1, so Push never
  // wakes Claude even with a channels-enabled session. Repair by merging the env
  // in-place — but NEVER edit a ${CLAUDE_PLUGIN_ROOT} plugin stub: the committed
  // stub must stay a pure plugin registration, and the plugin/local
  // registration is where env belongs there.
  if (mcpEntry) {
    if (mcpEntryHasChannelEnv(mcpEntry)) {
      ok('channels env (WEB_CHAT_CHANNEL=1) wired on the .mcp.json web-chat entry');
    } else if (JSON.stringify(mcpEntry).includes('${CLAUDE_PLUGIN_ROOT}')) {
      note('channels env not on the .mcp.json plugin stub — the plugin/local registration carries it; leaving the committed stub untouched');
    } else {
      warn('channels env not wired — Push will not wake Claude even with a Channels session');
      try {
        const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        mcp.mcpServers['web-chat'].env = channelEnv(mcp.mcpServers['web-chat'].env);
        fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
        fixed('wired WEB_CHAT_CHANNEL=1 into the .mcp.json web-chat entry');
      } catch (e) {
        note(`could not write channels env into .mcp.json: ${e.message}`);
      }
    }
  }

  // 4. Hook registration.
  const settingsPath = path.join(root, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      let ours = 0;
      for (const event of Object.keys(settings.hooks || {})) {
        for (const h of settings.hooks[event]) {
          if (h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('claude-web-chat-hook'))) ours++;
        }
      }
      if (ours > 0) ok(`${ours} web-chat hook(s) registered`);
      else warn('no web-chat hooks registered — run `claude-web-chat install`');
    } catch {
      warn('could not parse .claude/settings.json');
    }
  } else {
    warn('no .claude/settings.json — run `claude-web-chat install`');
  }

  log('');
  log(`${summary.ok} ok · ${summary.repaired} repaired · ${summary.problems} problem(s)`);
  if (summary.problems > 0) log('Some issues need attention — see ✗ lines above.');
  return summary;
}

module.exports = doctor;

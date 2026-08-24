const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const portfiles = require('../../core/portfiles');
const { projectPaths, userPaths } = require('../../core/paths');
const { findProjectRoot } = require('../../util/root');
const { lockIsStale } = require('../../server/domain/turns');
const { stripChannelEnv, mcpEntryHasChannelEnv, ensureHooks } = require('../../update/managed-files');
const { LAUNCH_COMMAND } = require('../../core/channels');
const { resolve: resolveToggle } = require('../../toggle/policy');
const { readMcpSeen, mcpWrittenAt, describeRestart } = require('../../core/mcp-seen');
const { hubPort, probeHubHealth } = require('../../util/hub');
const { isProtocolCurrent } = require('../../core/versions');
const { readInstances } = require('../../util/registry');
const client = require('../../mcp/client');

// Does this project's DISABLE MARKER collide with the user-scope one? It does
// exactly when the project root is the home directory: projectPaths($HOME).disabled
// and userPaths().disabled are then the same file. `claude-web-chat off` typed in
// $HOME therefore writes the USER marker while printing "disabled for project
// $HOME" — silently switching web-chat off for every project on the machine.
// Compared by path, via lib/core/paths — which owns the one home-directory lookup.
function homeMarkerCollision(root) {
  return path.resolve(projectPaths(root).disabled) === path.resolve(userPaths().disabled);
}

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

// classifyMcpEntry's rule, applied to a hook's shell command string: it must
// invoke an existing absolute path to the hook bin. A bare `claude-web-chat-hook`
// runs only if the package happens to be on PATH at hook time.
function hookCommandResolvable(cmd) {
  const m = String(cmd).match(/["']?((?:\/|\$\{)[^"'\s]*claude-web-chat-hook\.js)["']?/);
  if (!m) return false;
  if (m[1].startsWith('${CLAUDE_PLUGIN_ROOT}')) return Boolean(process.env.CLAUDE_PLUGIN_ROOT);
  return path.isAbsolute(m[1]) && fs.existsSync(m[1]);
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

  // 0. The switch. Everything below is moot if web-chat is turned OFF — hooks
  // no-op and every MCP tool returns {disabled}. Reported FIRST so nobody is
  // sent to debug a system that is simply switched off.
  const sessionId = opts.sessionId || process.env.CLAUDE_SESSION_ID;
  const toggle = resolveToggle({ cwd: root, sessionId });
  if (!toggle.enabled) {
    const flag = toggle.by === 'project' ? '' : ` --${toggle.by === 'user' ? 'global' : toggle.by}`;
    warn(`web-chat is DISABLED by the ${toggle.by} scope — hooks no-op and every MCP tool returns {disabled}. Re-enable with \`claude-web-chat on${flag}\`; nothing below takes effect until you do`);
  } else {
    ok('web-chat is enabled (user + project + session scopes all clear)');
  }

  // 0b. The $HOME disable-marker collision. When the project root IS the home
  // directory, the project-scope marker file and the user-scope marker file are
  // literally the same path — so `off` here disables EVERY project while
  // reporting a project-scoped change. Latent whenever they collide; active (and
  // the true cause of the DISABLED line above) once the marker exists.
  if (homeMarkerCollision(root)) {
    const marker = projectPaths(root).disabled;
    if (fs.existsSync(marker)) {
      warn(`this project root is your home directory, so its project-scope disable marker IS the user-scope marker (${marker}) — web-chat is switched off for EVERY project on this machine, not just this one. \`claude-web-chat on --global\` (or delete that file) re-enables it everywhere`);
    } else {
      note(`this project root is your home directory, so its project-scope disable marker and the user-scope one are the same file (${marker}) — running \`claude-web-chat off\` here would disable web-chat for every project, while printing "disabled for project ${root}"`);
    }
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
  let health = null;
  if (running) {
    try {
      health = await client.get('/api/health', { port: info.port, noSpawn: true });
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

  // 2b. Is anyone LOOKING? A daemon with zero connected browsers is healthy by
  // every other measure — a render 200s, commits, and is seen by nobody. That is
  // the state where Claude says "take a look" and there is nothing to look at.
  if (running) {
    const viewers = health && typeof health.viewers === 'number' ? health.viewers : null;
    if (viewers == null) {
      note('daemon does not report a viewer count (older build?) — could not check whether a browser is watching');
    } else if (viewers > 0) {
      ok(`${viewers} browser(s) watching the surface`);
    } else {
      warn(`no browser is watching — the daemon is up, but a render lands where nobody sees it (and service-backed panes stay stopped). Open the surface with \`claude-web-chat open\``);
    }
  }

  // 2c. The capture path: browser extension → hub (fixed port) → this instance.
  // Three separate things can be broken here, and none of them show up anywhere
  // else: the hub is down, this project is not in the registry the hub resolves
  // against, or ingest is token-gated and the extension does not have the token.
  const hp = hubPort();
  const hubHealth = await probeHubHealth(hp);
  if (!hubHealth || hubHealth.role !== 'hub') {
    if (running) warn(`capture hub not answering on port ${hp} — page captures from the browser extension have nowhere to land. It is spawned by the daemon, so \`claude-web-chat restart\` should bring it back`);
    else note(`capture hub not running on port ${hp} (it starts with the daemon)`);
  } else if (!isProtocolCurrent(hubHealth)) {
    warn(`capture hub on port ${hp} is running an older protocol (v${hubHealth.version}) than this build — restart the daemon to bounce it (\`claude-web-chat restart\`)`);
  } else {
    ok(`capture hub answering on port ${hp}`);
    const resolved = path.resolve(root);
    const mine = readInstances().find((e) => e.root && path.resolve(e.root) === resolved);
    if (mine) ok(`this project is registered with the hub (instance ${mine.id} on port ${mine.port})`);
    else if (running) warn('this project is NOT in the instance registry — the hub cannot route a capture here. `claude-web-chat restart` re-registers it');
    else note('this project is not in the instance registry (the daemon registers on start)');
  }
  if (process.env.WEB_CHAT_CAPTURE_TOKEN) {
    note('capture ingest is token-gated by WEB_CHAT_CAPTURE_TOKEN — the extension must send the same value as X-WC-Token');
  } else if (fs.existsSync(projectPaths(root).captureToken)) {
    note('capture ingest is token-gated by .web-chat/capture-token — the extension must send that value as X-WC-Token or every capture is rejected');
  } else {
    ok('capture ingest is open (no capture token configured)');
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
    if (!mcpEntryHasChannelEnv(mcpEntry)) {
      ok('no stale channels env on the .mcp.json web-chat entry');
    } else {
      warn('stale WEB_CHAT_CHANNEL=1 on the .mcp.json entry — this makes the MCP server start a channel bridge in sessions that have no channel, so a Push reports "Delivered ✓" and is dropped instead of parked');
      try {
        const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        const env = stripChannelEnv(mcp.mcpServers['web-chat'].env);
        if (env) mcp.mcpServers['web-chat'].env = env;
        else delete mcp.mcpServers['web-chat'].env;
        fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
        fixed('removed WEB_CHAT_CHANNEL from .mcp.json — supply it on the launch line instead');
        note(`for a live channel, launch with: ${LAUNCH_COMMAND}`);
      } catch (e) {
        note(`could not clean channels env from .mcp.json: ${e.message}`);
      }
    }
  }

  // 3c. Did Claude Code actually pick the registration up? This is the most
  // likely first-run failure of all: `install` writes .mcp.json, Claude Code
  // reads that file only at process start, so until the user restarts NONE of
  // the 23 tools exist — and every other check here is green. Read mtime AFTER
  // the repairs above, so a .mcp.json this run just rewrote correctly counts as
  // "changed since the running session started".
  //
  // Deliberately tri-state (see lib/core/mcp-seen.js): a session that simply
  // never called a web-chat tool is indistinguishable from one that never
  // restarted, so that case says "can't tell" and names the cheap thing to try.
  const restart = describeRestart({
    seen: (health && health.mcp_seen) || readMcpSeen(root),
    mcpWrittenAt: mcpWrittenAt(root),
  });
  if (restart.state === 'stale') warn(restart.line);
  else if (restart.state === 'fresh') ok(restart.line);
  else if (restart.state === 'unknown') note(restart.line);

  // 4. Hook registration.
  const settingsPath = path.join(root, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      let ours = 0;
      let bare = 0;
      for (const event of Object.keys(settings.hooks || {})) {
        for (const h of settings.hooks[event]) {
          for (const hh of (h && h.hooks) || []) {
            if (!hh.command || !hh.command.includes('claude-web-chat-hook')) continue;
            ours++;
            if (!hookCommandResolvable(hh.command)) bare++;
          }
        }
      }
      if (ours === 0) {
        warn('no web-chat hooks registered — run `claude-web-chat install`');
      } else if (bare === 0) {
        ok(`${ours} web-chat hook(s) registered and resolvable`);
      } else {
        warn(`${bare} web-chat hook(s) use a bare PATH-dependent command — it only runs where the package is on PATH, so turns never begin or commit`);
        try {
          ensureHooks(root);
          fixed('rewrote the web-chat hook command(s) to an absolute `node <bin>` path');
        } catch (e) {
          note(`could not repair .claude/settings.json: ${e.message}`);
        }
      }
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

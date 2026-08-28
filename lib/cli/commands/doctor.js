const fs = require('fs');
const path = require('path');
const portfiles = require('../../core/portfiles');
const { projectPaths, userPaths } = require('../../core/paths');
const { writeJsonAtomic, readJson } = require('../../core/fsjson');
const { lockIsStale } = require('../../server/domain/turns');
const { stripChannelEnv } = require('../../update/managed-files');
const {
  resolveRoot,
  inspect,
  applyHooks,
  mcpArgv,
  defaultRunClaude,
} = require('../../setup/registration');
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

async function doctor(args = [], opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const runClaude = opts.runClaude || defaultRunClaude;
  const log = opts.log || ((s) => console.log(s));

  // dryRun: run every check, return the SAME summary shape and counts, but make
  // no write. `claude-web-chat init --report` (and `/web-chat init`) promise the
  // caller they change nothing on disk, and doctor is otherwise a repairer: it
  // deletes portfiles, clears locks, rewrites hook commands, strips a stale env
  // out of .mcp.json, and shells out to `claude mcp add`. Every one of those five
  // sites is guarded below; the line they would have printed becomes
  // "• would repair: …" and the check is tagged { dry: true }.
  const dryRun = opts.dryRun === true;

  const root = resolveRoot(cwd, { mode: 'install' }).root;
  const webChatDir = projectPaths(root).dir;
  const summary = { problems: 0, repaired: 0, ok: 0, checks: [] };
  const ok = (m) => { summary.ok++; summary.checks.push({ status: 'ok', m }); log(`  ✓ ${m}`); };
  const fixed = (m) => {
    summary.repaired++;
    if (dryRun) { summary.checks.push({ status: 'repaired', dry: true, m }); log(`  • would repair: ${m}`); return; }
    summary.checks.push({ status: 'repaired', m });
    log(`  ✓ ${m}  [repaired]`);
  };
  const warn = (m) => { summary.problems++; summary.checks.push({ status: 'problem', m }); log(`  ✗ ${m}`); };
  const note = (m) => { summary.checks.push({ status: 'note', m }); log(`  • ${m}`); };

  log(`claude-web-chat doctor — ${root}`);

  if (!fs.existsSync(webChatDir)) {
    warn('not installed (no .web-chat/) — run `claude-web-chat init`');
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
    // pid:null — doctor owns no daemon; reap the file only while it still
    // names a dead process (one may have started since the read above).
    if (!dryRun) portfiles.deletePortfile('server', { root, pid: null });
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
          if (!dryRun) await client.post('/api/unlock', {}, { port: info.port, noSpawn: true });
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
    // The SECOND writer of graph/_meta.json — out of process, and reachable
    // exactly when the graph is in a bad state. writeJsonAtomic makes each write
    // WHOLE (and its per-pid temp name keeps this process and a daemon from
    // sharing one temp file); it does NOT make this read-modify-write safe. If a
    // daemon comes up between the read and the write, this can still clobber a
    // lock it legitimately took. The branch is gated on the daemon being down,
    // which is the mitigation — not the atomic rename.
    const metaPath = path.join(webChatDir, 'graph', '_meta.json');
    const r = readJson(metaPath, { validate: (m) => m && typeof m === 'object' && !Array.isArray(m) });
    if (r.ok) {
      const meta = r.value;
      if (meta.lock) {
        // Daemon is down, so this lock has no live holder regardless of age
        // (boot would clear it too — repair now so it never survives a start).
        meta.lock = null;
        if (!dryRun) writeJsonAtomic(metaPath, meta);
        fixed('cleared an orphaned graph lock persisted in graph/_meta.json (daemon not running)');
      } else {
        ok('graph lock clear');
      }
    } else if (!r.absent) {
      // A torn one is not a missing one: the daemon repairs it on next boot by
      // recovering the active node from the latest commit (see graph.load).
      warn('could not read graph/_meta.json (it will be rebuilt on the next daemon start)');
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

  // 3. MCP registration resolvability. The whole registration state of the
  // project comes from ONE read (lib/setup/registration.inspect) — the same one
  // status and the MCP dispatcher use — so doctor cannot disagree with them
  // about what is registered here.
  const state = inspect(root);
  const mcpPath = path.join(root, '.mcp.json');
  const mcpEntry = state.mcp.entry;
  if (state.mcp.file === 'unparseable') warn('could not parse .mcp.json');
  if (state.mcp.resolvable) {
    ok('MCP registration in .mcp.json is resolvable');
  } else {
    warn(`MCP registration not resolvable: ${state.mcp.reason}`);
    // Repair at *local* scope with an absolute path so the committed .mcp.json
    // (correct as a plugin stub) is left untouched but Claude Code still spawns.
    // The argv comes from the engine, which builds it off stableBin: a managed
    // install must register ~/.web-chat/current/bin/…, never the version
    // directory this process happens to run from (pruneVersions deletes that
    // three updates later, and a local-scope entry never self-heals).
    const argv = mcpArgv();
    if (dryRun) {
      // The shell-out is the one repair with a side effect OUTSIDE this project
      // (a local-scope registration in Claude Code's own config), so a read-only
      // run must not attempt it and must not guess whether it would have worked.
      fixed(`register web-chat at local scope: claude ${argv.join(' ')}`);
    } else {
      const r = runClaude(argv);
      if (r.ok) {
        fixed(`registered web-chat at local scope: claude ${argv.join(' ')}`);
      } else if (/already exists/i.test(r.stderr || '')) {
        fixed('web-chat already registered at local scope (overrides the unresolvable .mcp.json entry)');
      } else {
        note(`run this to repair manually: claude ${argv.join(' ')}`);
      }
    }
  }

  // 3b. Channels env wiring on the .mcp.json entry. An earlier
  // install (or a hand-added entry) carries no WEB_CHAT_CHANNEL=1, so Push never
  // wakes Claude even with a channels-enabled session. Repair by merging the env
  // in-place — but NEVER edit a ${CLAUDE_PLUGIN_ROOT} plugin stub: the committed
  // stub must stay a pure plugin registration, and the plugin/local
  // registration is where env belongs there.
  if (mcpEntry) {
    if (!state.mcp.channelEnv) {
      ok('no stale channels env on the .mcp.json web-chat entry');
    } else {
      warn('stale WEB_CHAT_CHANNEL=1 on the .mcp.json entry — this makes the MCP server start a channel bridge in sessions that have no channel, so a Push reports "Delivered ✓" and is dropped instead of parked');
      try {
        const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        const env = stripChannelEnv(mcp.mcpServers['web-chat'].env);
        if (env) mcp.mcpServers['web-chat'].env = env;
        else delete mcp.mcpServers['web-chat'].env;
        if (!dryRun) fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
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

  // 4. Hook registration — per EVENT, against the template that defines them.
  // Counting handlers said "1 hook(s) registered and resolvable" for a project
  // whose Stop hook was gone, which means no turn ever commits: turn-begin takes
  // the lock, turn-end writes the node. A missing event is now a missing key.
  if (state.hooksFile === 'unparseable') {
    warn('could not parse .claude/settings.json');
  } else if (state.hooksFile === 'absent') {
    warn('no .claude/settings.json — run `claude-web-chat install`');
  } else {
    const events = Object.keys(state.hooks);
    const missing = events.filter((e) => state.hooks[e] === 'missing');
    const bare = events.filter((e) => state.hooks[e] === 'bare');
    if (missing.length === events.length) {
      warn('no web-chat hooks registered — run `claude-web-chat install`');
    } else if (!missing.length && !bare.length) {
      ok(`${events.length} web-chat hook(s) registered and resolvable (${events.join(', ')})`);
    } else {
      const repairs = [];
      if (bare.length) {
        warn(`${bare.length} web-chat hook(s) use a bare PATH-dependent command (${bare.join(', ')}) — it only runs where the package is on PATH, so turns never begin or commit`);
        repairs.push('rewrote the web-chat hook command(s) to an absolute `node <bin>` path');
      }
      if (missing.length) {
        warn(`web-chat hook(s) missing for ${missing.join(', ')} — the turn lifecycle needs every event in templates/settings.hooks.json (UserPromptSubmit takes the turn lock, Stop commits the node)`);
        repairs.push(`registered the missing hook(s): ${missing.join(', ')}`);
      }
      try {
        if (!dryRun) applyHooks(root);
        fixed(repairs.join('; '));
      } catch (e) {
        note(`could not repair .claude/settings.json: ${e.message}`);
      }
    }
  }

  log('');
  // The counts are identical either way (callers get one summary shape), but a
  // dry run must not tell a human that four things were repaired when the whole
  // point of the run was that nothing was touched.
  log(`${summary.ok} ok · ${summary.repaired} ${dryRun ? 'would be repaired' : 'repaired'} · ${summary.problems} problem(s)`);
  if (summary.problems > 0) log('Some issues need attention — see ✗ lines above.');
  return summary;
}

module.exports = doctor;

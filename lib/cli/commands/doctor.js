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
  applyMcp,
  defaultRunClaude,
  hookProblems,
  HOOK_ROLES,
  HOOK_RESTART_NOTE,
  mcpState,
  describeMcp,
  mcpQuestions,
  mcpConsent,
  mcpResultLines,
  sessionsWithoutTools,
  WITHOUT_TOOLS_LINE,
} = require('../../setup/registration');
const { createPrompt } = require('../prompt');
const { LAUNCH_COMMAND } = require('../../core/channels');
const { resolve: resolveToggle } = require('../../toggle/policy');
const { readMcpSeen, mcpWrittenAt, describeRestart } = require('../../core/mcp-seen');
const { hubPort, probeHubHealth } = require('../../util/hub');
const { isProtocolCurrent } = require('../../core/versions');
const { readInstances } = require('../../util/registry');
const client = require('../../mcp/client');
const { isLoopbackBind } = require('../../core/cors');
const { loadConfig: loadTunnelConfig, portalPort } = require('../../tunnel/config');
const { checkBinary, readToken, probeReady } = require('../../tunnel/cloudflared');
const { findChrome, findFfmpeg } = require('../../replay/find');

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
  // The record as the file holds it, another project's copy included: every
  // other reader ignores a copy (lib/core/portfiles), so doctor is where it is
  // named and removed.
  const raw = portfiles.readPortfile('server', { root, checkLiveness: false, includeForeign: true });
  const info = raw && !raw.foreign ? portfiles.readPortfile('server', { root }) : null; // null if pid is dead / file malformed
  let running = false;
  if (raw && raw.foreign) {
    // pid:null — a copy is nobody's here (the daemon it names has its own
    // portfile at its own root), so the guarded delete removes it.
    if (!dryRun) portfiles.deletePortfile('server', { root, pid: null });
    fixed(`removed .web-chat/server.json: it was copied from ${raw.foreign} and named that project's server`);
  } else if (info) {
    const reachable = await portfiles.probeReachable(info.port, 500);
    if (reachable) {
      running = true;
      ok(`daemon running at ${info.url} (pid ${info.pid})`);
    } else if (info.proc_start != null && portfiles.isPidAlive(info.pid, { startedAt: info.proc_start }) === false) {
      // The pid is alive but started at another time than the daemon that
      // wrote the record: a reused pid, someone else's process now.
      if (!dryRun) portfiles.deletePortfile('server', { root, pid: null });
      fixed(`removed .web-chat/server.json: its pid ${info.pid} is another process now, not this project's server`);
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

  // 3. The MCP registration. web-chat registers its MCP server at Claude
  // Code's LOCAL scope (lib/setup/registration applyMcpLocal): an entry in
  // Claude Code's own config, which needs no approval — a .mcp.json server
  // does, and in a non-git folder inside a trusted one Claude Code cannot keep
  // that approval, asks on every launch, and turns the first reflexive No into
  // a permanent rejection that hides every tool. One read of the state
  // (mcpState, the same one status and open word); then the repair, unless
  // the No was given on purpose:
  //   * /mcp → Disable is reported and never undone;
  //   * a rejection recorded in disabledMcpjsonServers is registered over only
  //     on a separate yes (default No) or --register-mcp;
  //   * a .mcp.json git tracks is edited only on a yes of its own.
  // The shell-out writes Claude Code's config, outside this project, so a
  // read-only run (--dryRun, init --report) only says what it would do.
  const state0 = inspect(root);
  if (state0.mcp.file === 'unparseable') warn('could not parse .mcp.json');
  const regOpts = { git: opts.git, configFile: opts.configFile };
  const ms = mcpState(root, regOpts);
  const said = describeMcp(ms, { inDoctor: true });
  const healthy = ms.kind === 'local' && ms.acceptable && ms.local.envMatches !== false;
  // The repair (and, beside a healthy local entry, the .mcp.json migration
  // that may still be owed: web-chat's own entry left in .mcp.json keeps the
  // approval dialog coming at every launch in a folder that cannot keep it).
  const repairMcp = async () => {
    const q = mcpQuestions(root, regOpts);
    let consent = {};
    if (!dryRun && (q.rejection || q.tracked)) {
      const prompt = opts.prompt || createPrompt({ log, yes: args.includes('--yes'), noInput: args.includes('--no-input') });
      try {
        consent = await mcpConsent(q, {
          prompt, registerMcp: args.includes('--register-mcp') || opts.registerMcp === true, decisions: opts.mcpDecisions || {}, log,
        });
      } finally {
        if (!opts.prompt) prompt.close();
      }
    }
    const m = applyMcp(root, { mcp: 'local', dryRun, runClaude, consent, creating: false, fallback: 'none', ...regOpts });
    const cmd = m.argv ? `claude ${m.argv.join(' ')}` : '';
    if (m.status === 'registered' || m.status === 'repointed') {
      // `--scope local` registers the directory `claude` runs in: the engine
      // runs it from the root doctor resolved, never from a subdirectory.
      fixed(`registered web-chat's MCP server at local scope: ${cmd} — restart Claude Code here to load it (confirm with \`claude mcp get web-chat\`, which starts the server once)`);
    } else if (m.status === 'would register' || m.status === 'would repoint') {
      fixed(`register web-chat at local scope: ${cmd}`);
      if (q.rejection) note('a real run asks first (default No): web-chat was rejected in Claude Code here');
    } else if (m.status === 'rejected') {
      note('left as it is — `claude-web-chat doctor --register-mcp` registers it anyway; `claude-web-chat off` (or `uninstall`) is web-chat\'s own off switch, and stops the hooks too');
    } else if (m.status === 'no-claude') {
      for (const l of m.warnings) note(l);
    } else if (m.status === 'failed' || m.status === 'unverified') {
      for (const l of m.warnings) warn(l);
    }
    const j = m.mcpJson || {};
    if (j.action === 'removed' || j.action === 'removed (file empty)') {
      fixed(j.commit ? 'removed web-chat\'s entry from .mcp.json (tracked by git) — commit this change' : 'removed web-chat\'s entry from .mcp.json — the local-scope registration replaces it');
    } else if (j.action === 'would remove') {
      fixed('remove web-chat\'s entry from .mcp.json — the local-scope registration replaces it');
    }
    for (const l of mcpResultLines({ ...m, warnings: [], mcpJson: j.action === 'kept' ? j : {} })) note(l);
  };
  if (ms.kind === 'disabled') {
    warn(`web-chat's MCP server is ${said.line}`);
  } else if (healthy) {
    ok(`web-chat's MCP server is ${said.line}`);
    if (ms.mcp.present && ms.mcp.kind !== 'stub') await repairMcp();
  } else {
    if (ms.kind === 'local') {
      warn(`web-chat's MCP server is registered at local scope, but runs ${ms.bin}${ms.local.envMatches === false ? ' with an env that differs from .mcp.json\'s entry' : ''} — not this install's ${ms.stableBin}`);
    } else {
      warn(`web-chat's MCP server is ${said.line}`);
    }
    await repairMcp();
  }
  // What rides beside the state, read again after any repair.
  const after = dryRun ? ms : mcpState(root, regOpts);
  for (const n of describeMcp(after).notes) note(n);
  if (after.kind === 'local' && after.approvals.rejected) {
    note(`web-chat is still in disabledMcpjsonServers (${after.approvals.rejections.map((r) => r.file).join(', ')}) — inert beside the local registration. Optional tidy: \`claude mcp reset-project-choices\` here (it forgets every .mcp.json approval and rejection in this folder)`);
  }
  const without = await sessionsWithoutTools(root, opts.sessions || {});
  if (without.length) {
    warn(`${WITHOUT_TOOLS_LINE} (pid ${without.map((x) => x.pid).join(', ')}) — /exit and reopen it once the registration above is in place`);
  }
  const state = dryRun ? state0 : inspect(root);
  const mcpPath = path.join(root, '.mcp.json');
  const mcpEntry = state.mcp.entry;

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
  // the 24 tools exist — and every other check here is green. Read mtime AFTER
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

  // 4. Hook registration — per HANDLER, against the template that defines them,
  // and worded by what each handler is for (HOOK_ROLES). Counting handlers once
  // said "1 hook(s) registered and resolvable" for a project whose Stop hook was
  // gone, which means no turn ever commits; and since an event can carry two of
  // ours (PreToolUse has the mirror's and the halt's), "the event has one" says
  // nothing about the other. So each problem names its role, its events and
  // what the user loses, and the repair is the engine's (applyHooks), which
  // fixes every state inspect() reports.
  if (state.hooksFile === 'unparseable') {
    warn('could not parse .claude/settings.json');
  } else if (state.hooksFile === 'absent') {
    warn('no .claude/settings.json — run `claude-web-chat install`');
  } else {
    const events = Object.keys(state.hooks);
    const problems = hookProblems(state);
    if (events.every((e) => state.hooks[e] === 'missing')) {
      warn('no web-chat hooks registered — run `claude-web-chat install`');
    } else if (!problems.length) {
      ok(`${state.handlers.length} web-chat hook handlers on ${events.length} events registered and resolvable (${Object.keys(HOOK_ROLES).join(', ')})`);
    } else {
      const missing = [];
      const outdated = [];
      let bare = false;
      for (const p of problems) {
        const on = p.events.join(', ');
        if (p.state === 'missing') {
          warn(`${p.role} hook(s) missing for ${on} — ${p.effect}`);
          missing.push(...p.events);
        } else if (p.state === 'bare') {
          warn(`${p.role} hook(s) use a bare PATH-dependent command (${on}) — it only runs where the package is on PATH, so ${p.effect}`);
          bare = true;
        } else {
          // A different command shape (`node … halt pre`) is a handler that does
          // not do its job; different managed fields alone are only out of date.
          const broken = p.differs.includes('command') ? ` — as registered, ${p.effect}` : '';
          warn(`${p.role} hook(s) on ${on} differ from this build's template (${p.differs.join(', ')})${broken}`);
          outdated.push(...p.events);
        }
      }
      const inOrder = (list) => events.filter((e) => list.includes(e));
      const repairs = [];
      if (bare) repairs.push('rewrote the web-chat hook command(s) to absolute paths');
      if (missing.length) repairs.push(`registered the missing hook(s): ${inOrder(missing).join(', ')}`);
      if (outdated.length) repairs.push(`updated the outdated hook(s) on ${inOrder(outdated).join(', ')}`);
      try {
        if (!dryRun) applyHooks(root);
        fixed(`${repairs.join('; ')} — ${HOOK_RESTART_NOTE}`);
      } catch (e) {
        note(`could not repair .claude/settings.json: ${e.message}`);
      }
    }
  }

  // 4b. The web-chat mod (tier 2, §15.7): one row from the registration
  // model's reads — never a probe or a repair here (install switches it on;
  // `mod on|off` is the user's switch).
  if (state.mod) {
    const m = state.mod;
    note(m.state === 'on' ? `web-chat mod: on${m.version ? ` (v${m.version})` : ''}`
      : m.state === 'off (opted out)' ? 'web-chat mod: off (opted out) — `claude-web-chat mod on` switches it on'
        : `web-chat mod: ${m.state} — \`claude-web-chat mod on\` switches it on where Claude Code 2.1.287+ runs it`);
  }

  // 5. Remote access (the Cloudflare tunnel). Silent unless `tunnel setup` has
  // run: most installs never expose anything, and a section of notes about a
  // feature nobody turned on is noise. Diagnoses only — nothing here repairs,
  // because every fix is a decision about who can reach this machine.
  const tunnelFile = userPaths().tunnelConfig;
  if (fs.existsSync(tunnelFile)) {
    const env = opts.env || process.env;
    let tcfg = null;
    try { tcfg = loadTunnelConfig(tunnelFile); ok(`tunnel config is valid (${tcfg.hostname}, ${tcfg.allow.emails.length} allowlisted email(s))`); }
    catch (e) { warn(`${e.message} — the portal refuses to start on it; rerun \`claude-web-chat tunnel setup\``); }
    if (env.WEB_CHAT_HOST && !isLoopbackBind(env.WEB_CHAT_HOST)) {
      warn(`WEB_CHAT_HOST=${env.WEB_CHAT_HOST} — daemons listen on the network unauthenticated, and \`tunnel up\` refuses to run in front of them`);
    }
    if (tcfg && tcfg.tunnel) {
      const bin = (opts.checkBinary || checkBinary)({ env });
      if (bin.ok) ok(`cloudflared ${bin.version} at ${bin.bin}`);
      else warn(`${bin.error} — ${bin.hint}`);
      if (tcfg.tunnel.kind === 'token') {
        if (readToken()) ok(`connector token present (${userPaths().tunnelToken}, 0600)`);
        else warn(`no connector token in ${userPaths().tunnelToken} — \`tunnel up\` refuses without it`);
      }
    } else if (tcfg) {
      note('tunnel.json names no tunnel — the portal runs alone and you run cloudflared yourself');
    }
    const ph = await portfiles.probeHealth(portalPort(env), 500);
    if (!ph || ph.role !== 'portal') {
      note('the tunnel is down (`claude-web-chat tunnel up` starts it)');
    } else {
      ok(`tunnel portal running (pid ${ph.pid})`);
      if (ph.jwks && ph.jwks.error) warn(`the portal cannot refresh Cloudflare Access's signing keys: ${ph.jwks.error}`);
      if (tcfg && tcfg.tunnel) {
        const r = await probeReady(tcfg.tunnel.metricsPort);
        if (r.ready) ok('cloudflared connector is ready');
        else warn(`cloudflared is not ready (${ph.cloudflared ? ph.cloudflared.state : 'not supervised'}${ph.cloudflared && ph.cloudflared.error ? `: ${ph.cloudflared.error}` : ''}) — \`claude-web-chat tunnel logs\``);
      }
    }
  }
  // 6. Replay renderers. Optional — nothing else depends on them — so these are
  // notes, never problems: a machine with no Chrome still does everything but
  // draw a replay GIF or video, and one with no ffmpeg everything but video. Same finder the render route and /api/replay/capabilities
  // use (lib/replay/find), so doctor cannot disagree with them.
  const chrome = (opts.findChrome || findChrome)();
  const ffmpeg = (opts.findFfmpeg || findFfmpeg)();
  note(chrome
    ? `replay GIFs: Chrome found at ${chrome}`
    : 'replay GIFs: no Chrome-family browser found (install Chrome, Chromium, Edge or Brave, or set WEB_CHAT_CHROME) — replays still export as .html');
  note(ffmpeg
    ? `replay video: ffmpeg found at ${ffmpeg} — MP4/WebM available, and GIFs are encoded with it`
    : 'replay video: ffmpeg not found (optional — needed for MP4/WebM; GIFs use the built-in encoder; WEB_CHAT_FFMPEG overrides)');

  log('');
  // The counts are identical either way (callers get one summary shape), but a
  // dry run must not tell a human that four things were repaired when the whole
  // point of the run was that nothing was touched.
  log(`${summary.ok} ok · ${summary.repaired} ${dryRun ? 'would be repaired' : 'repaired'} · ${summary.problems} problem(s)`);
  if (summary.problems > 0) log('Some issues need attention — see ✗ lines above.');
  return summary;
}

module.exports = doctor;

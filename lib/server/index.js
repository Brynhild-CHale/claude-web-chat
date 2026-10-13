const express = require('express');
const http = require('http');
const path = require('path');
const { resolvePaths } = require('./paths');
const { projectPaths } = require('../core/paths');
const { createState } = require('./state');
const { createBus } = require('../core/bus');
const { createRedactor } = require('../core/redact');
const { packageVersion } = require('../core/versions');
const { createGraph } = require('./graph');
const { loadDraft, writeDraft, lockIsStale, clearLockOnBoot, installLockKeepalive, stopGraph } = require('./domain/turns');
const { attachWebSocket } = require('./ws');
const { createServiceSupervisor } = require('./services');
const { createHookTap } = require('./hook-tap');
const { createAudience } = require('./audience');
const { createMirror, MIRROR_RING, SOURCES } = require('./mirror');
const { createShadowStore, createCodediffSource } = require('./mirror/codediff');
const { createTurnGuard } = require('./turn-guard');
const { runGit } = require('./git-run');
const { createAsks, modPermissionWait } = require('./domain/asks');
const { createBridge } = require('./domain/bridge');
const { createAnswerSurface } = require('./answer-surface');
const { createControl } = require('./control');
const { createRestore } = require('./control/restore');
const { installRevert } = require('./control/revert');
const { installFork } = require('./control/fork');
const { installModControl } = require('./control/mod');
const { installSessionOps, createContextReadings } = require('./control/session-ops');
const { createModTransport, withModCommands } = require('./mod-transport');
const { createProjectFiles } = require('./project-files');
const { createSkillCatalog } = require('./skills');
const { createQueueRelease } = require('./queue-release');
const { mountRenderRoutes } = require('./routes/render');
const { mountPageRoutes } = require('./routes/page');
const { mountHistoryRoutes } = require('./routes/history');
const { mountPaneSpawnRoutes } = require('./routes/spawn');
const { mountComponentRoutes } = require('./routes/components');
const { mountPackRoutes } = require('./routes/packs');
const { mountStoreRoutes } = require('./routes/store');
const { mountEventRoutes } = require('./routes/events');
const { mountQueueRoutes } = require('./routes/queue');
const { mountGraphRoutes } = require('./routes/graph');
const { mountHealthRoutes } = require('./routes/health');
const { mountCommentRoutes } = require('./routes/comments');
const { mountThemeRoutes } = require('./routes/theme');
const { mountEmbedRoutes } = require('./routes/embed');
const { mountEmbedHelperRoutes } = require('./routes/embed-helper');
const { mountExportRoutes } = require('./routes/export');
const { mountBrandRoutes } = require('./routes/brand');
const { mountReplayRoutes } = require('./routes/replay');
const { mountCaptureRoutes, configuredToken } = require('./routes/capture');
const { mountProfileRoutes } = require('./routes/profiles');
const { mountVersionRoutes } = require('./routes/version');
const { mountMachineRoutes } = require('./routes/machine');
const { mountTunnelRoutes } = require('./routes/tunnel');
const { mountHookRoutes } = require('./routes/hooks');
const { mountMirrorRoutes } = require('./routes/mirror');
const { mountMirrorContentRoutes } = require('./routes/mirror-content');
const { mountMirrorTasksRoutes } = require('./routes/mirror-tasks');
const { mountMirrorCodeRoutes } = require('./routes/mirror-code');
const { mountMirrorAccessRoutes } = require('./routes/mirror-access');
const { mountProjectRoutes } = require('./routes/project');
const { mountAskRoutes } = require('./routes/asks');
const { mountFilesRoutes } = require('./routes/files');
const { mountSkillsRoutes } = require('./routes/skills');
const { mountControlRoutes } = require('./routes/control');
const { mountCodeRoutes } = require('./routes/code');
const { mountBridgeRoutes } = require('./routes/bridge');
const { mountAttachmentRoutes, withAttachments } = require('./routes/attachments');
const { mountMirrorContextRoutes } = require('./routes/mirror-context');
const { classify } = require('../channel/policy');
const queueDomain = require('./domain/queue');
const signals = require('./domain/signals');
const { run: runMigrations } = require('../update/migrations');
const { seedBuiltins } = require('./builtins');
const { seedThemeLogos } = require('../setup/theme-logos');
const { loadUserProfiles } = require('../capture/profiles');
const { writePortfile, probeReachable, isPidAlive } = require('../core/portfiles');
const { LISTEN_HOST, warnIfExposed, requireLocalHost } = require('../core/cors');
const { registerInstance, release } = require('../util/registry');
const { mcpIdentityFromHeaders, recordMcpSeen, readMcpSeen } = require('../core/mcp-seen');
const { ensureHub } = require('../util/hub');

const LOCK_DRAIN_TIMEOUT_MS = 30_000;
const INFLIGHT_DRAIN_TIMEOUT_MS = 5_000;
// How long the final server.close() may wait on connections that are neither
// idle nor in flight before they are hung up on. See closeServer below: this is
// what makes the daemon's whole shutdown fit inside a budget a caller can size.
const CLOSE_DRAIN_TIMEOUT_MS = 1_000;
// How long a graceful shutdown waits on the chat mirror's stop — its sources',
// the conversation registry's flush, the engine's watchers — before it goes on
// without it (stopMirrorBounded below). The engine's own work is quick, but a
// source's stop() is any later tranche's code (a tailer mid-read, a code-diff
// git run), and a step with no ceiling would make the whole drain unbounded.
const MIRROR_STOP_TIMEOUT_MS = 2_000;
// The capture routes that hold a request to the capture token
// (routes/capture configuredToken): POST /api/capture and GET /api/profile-match.
const CAPTURE_TOKEN_ROUTES = Object.freeze(['/api/capture', '/api/profile-match']);

// `tunnelSetup` is for tests only: createTunnelSetup's injections (a fake
// Cloudflare env, fetchJwks, a stand-in tunnel control) — lib/server/tunnel-setup.
// `queueRelease` is for tests only too: createQueueRelease's timer seams
// (setTimer, clearTimer) — lib/server/queue-release.
// `modPermissionWait` is for tests only as well: the mod's permission wait in ms
// (bridge.setPermissionWait), in place of the shipped one — 0, or V41's knob
// in the environment (domain/asks modPermissionWait) — so a test can drive a
// permission prompt through the mod while the transport ships switched off.
function createServer({
  root = process.cwd(), port = 'auto', tunnelSetup: tunnelSetupOpts, queueRelease: queueReleaseOpts,
  modPermissionWait: modPermissionWaitOpt,
} = {}) {
  const paths = resolvePaths(root);
  const draftFile = projectPaths(root).draft;
  runMigrations(paths.WEB_CHAT_DIR);
  seedBuiltins(paths);
  // The per-user folders `install` and `update` seed (lib/setup/theme-logos) —
  // here too, because the update that brings a machine onto this build is the
  // OLD build's, which has never heard of them. Idempotent and quiet: a folder
  // that exists is left alone, and a failure is swallowed inside.
  seedThemeLogos();
  // Load user-defined capture profiles (project then global dirs) so pickProfile/
  // resolve see them. Resilient — a bad bundle is logged and skipped, never wedges boot.
  loadUserProfiles(paths);

  const state = createState();
  // The change bus owns the event ring + SSE subscribers + WS broadcaster (Phase
  // 2). Built before attachWebSocket so ws.js can register its broadcaster on it.
  // A token unique to THIS daemon process. It rides on every bus event so the
  // channel bridge (which survives daemon restarts in the MCP process) can tell a
  // restart's reset seq space from a same-daemon replay. pid+boot-time is unique
  // per boot (a restart always gets a new pid and a later timestamp). The chat
  // mirror's bus, below, carries the same token.
  const bootId = `${process.pid}:${Date.now()}`;
  const bus = createBus({ bootId });
  const graph = createGraph({ paths, state, draftPath: draftFile });

  graph.load();
  // A lock persisted in _meta.json (see graph.saveMeta) was written by a prior
  // process that, by definition, no longer holds it — load only runs at boot, so
  // whoever set this lock is gone. It therefore has no live holder regardless of
  // age; clearLockOnBoot clears it unconditionally so a crashed mid-turn session
  // can't wedge the new one (a restored *fresh* lock would otherwise block
  // turn-begin for the full TTL). The TTL only governs an orphaned lock within a
  // single live process.
  clearLockOnBoot(graph);
  // A turn lock's TTL is a wedge-breaker, not a turn-length budget: Claude's own
  // writes re-stamp it, so a long turn (agentic ones routinely outlive the wake
  // lock's short TTL) stays the holder of its lock until it Stops. One subscriber,
  // wired once — see installLockKeepalive for why a driver's writes are excluded.
  installLockKeepalive(graph, bus);
  if (graph.active) graph.restoreLiveToNode(graph.active, bus);
  else graph.clearLiveMounts();
  loadDraft(draftFile, graph.active, state);

  const app = express();

  // FIRST, above every other middleware: the Host gate (lib/core/cors). It sits
  // above express.json so a request that dialled us under a rebound DNS name is
  // refused before its body is parsed at the 200mb limit, and above the inflight
  // counter so a refused request never holds up a graceful drain.
  app.use(requireLocalHost);

  // In-flight HTTP request counter for graceful shutdown.
  let inflight = 0;
  let inflightWaiters = [];
  app.use((req, res, next) => {
    inflight++;
    res.on('close', () => {
      inflight--;
      if (inflight === 0 && inflightWaiters.length) {
        const ws = inflightWaiters; inflightWaiters = [];
        for (const w of ws) w();
      }
    });
    next();
  });
  // Observe MCP-server traffic. Claude Code reads .mcp.json only at startup, so
  // an `install` that rewrites it changes nothing until the user restarts — and
  // the ONLY evidence a restart happened is the start time of the MCP server
  // process Claude Code spawned, which lib/mcp/client stamps on every request it
  // makes. Record the last such sighting (persisted, so `doctor`/`status` can
  // read it with the daemon down and across daemon restarts).
  let mcpSeen = readMcpSeen(root);
  app.use((req, res, next) => {
    const id = mcpIdentityFromHeaders(req.headers);
    if (id) mcpSeen = recordMcpSeen(root, { startedAt: id.startedAt });
    next();
  });

  function waitForInflight(maxMs = INFLIGHT_DRAIN_TIMEOUT_MS) {
    if (inflight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { resolve(); }, maxMs);
      inflightWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  // Tab-stream captures POST the full serialized DOM as JSON; heavy web apps
  // (Gmail, etc.) easily exceed a few MB, so allow a generous default and let it
  // be tuned via env. Below the limit the request is rejected as PayloadTooLarge
  // before the capture route ever runs.
  app.use(express.json({ limit: process.env.WEB_CHAT_BODY_LIMIT || '200mb' }));
  // The chrome's static files. A release tarball pins every file's mtime (so a
  // rebuild is byte-reproducible), which makes express.static's default
  // validators — Last-Modified, and a weak ETag of size+mtime — identical across
  // versions: a browser that cached 0.8.0's topbar.js was told "304 Not
  // Modified" by 0.8.1 and kept running the old chrome. The validator therefore
  // names the build too, and Last-Modified (always 2000-01-01) is not sent.
  const BUILD = packageVersion();
  app.use(express.static(paths.PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders(res, _file, stat) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', `W/"${BUILD}-${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`);
    },
  }));

  const server = http.createServer(app);

  // Open SSE responses (GET /api/events/stream). They never end on their own, so
  // server.close() would wait forever (and each holds the inflight counter up) —
  // shutdown must end them explicitly. The events route adds/removes its res.
  const sseClients = new Set();
  function closeStreams() {
    for (const res of [...sseClients]) { try { res.end(); } catch {} }
  }

  // server.close() resolves only once EVERY remaining connection is gone, and it
  // has no timeout. Two populations can hold one open indefinitely, and neither
  // is reachable by closeIdleConnections():
  //
  //   * an HTTP socket that began a request and never finished sending it — not
  //     idle, so closeIdle skips it; never dispatched, so the inflight drain
  //     never sees it either;
  //   * a WebSocket whose client never answers the polite close frame
  //     wsApi.shutdown() sends (a wedged tab, a suspended laptop). Note that
  //     closeAllConnections() does NOT reach this one: Node drops a socket from
  //     the HTTP server's connection list at upgrade, while net.Server still
  //     counts it against close(). Only the ws handle can hang up on it, which
  //     is what wsApi.terminate() is for.
  //
  // An unbounded close is not merely slow, it breaks a contract: `stop` sizes
  // its wait on the daemon's worst case, so a close that may never finish means
  // no budget the CLI picks is ever correct — and the escalation it then fires
  // used to truncate the shutdown before release() ran, leaving a stale portfile
  // behind and reporting a clean shutdown as a failure. Give the polite closes a
  // short grace, then force the stragglers down; the outer deadline is the last
  // word, because the only thing after this is release() and process.exit.
  function closeServer() {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        clearTimeout(hard);
        resolve();
      };
      const force = setTimeout(() => {
        try { server.closeAllConnections(); } catch {}
        if (wsApi && typeof wsApi.terminate === 'function') { try { wsApi.terminate(); } catch {} }
      }, CLOSE_DRAIN_TIMEOUT_MS);
      const hard = setTimeout(done, CLOSE_DRAIN_TIMEOUT_MS * 2);
      server.close(done);
    });
  }

  // ONE in-flight shutdown, shared. Callers used to be turned away by a boolean
  // (`if (shuttingDown) return`), which made a second entry resolve INSTANTLY —
  // and every caller follows its await with process.exit(). So a SIGTERM landing
  // while the first shutdown was still draining exited the process mid-drain and
  // the release() at the end of this function never ran: a daemon that had shut
  // down correctly left a stale portfile and a stale registry entry behind, and
  // `stop` read that as "survived both a shutdown request and SIGTERM" and
  // advised `kill -9` on a pid that no longer existed. Handing back the same
  // promise makes a second trigger AWAIT the first rather than truncate it.
  //
  // Patience here is only safe because every step below is bounded — the lock
  // drain, the inflight drain, the chat mirror's stop and closeServer all have
  // ceilings (30 + 5 + 2 + 2 s: inside `stop`'s 40 s wait after an ack,
  // lib/cli/commands/stop.js ACK_WAIT_MS) — so this promise always settles and a
  // signal is never swallowed for good. (The
  // service runner one level down takes the OPPOSITE line, exiting outright on a
  // second signal, because its stop() is arbitrary component code with no
  // ceiling and nothing above it escalates to SIGKILL. Here the operator is the
  // escalation.)
  let shutdownPromise = null;
  function gracefulShutdown() {
    if (!shutdownPromise) shutdownPromise = runShutdown();
    return shutdownPromise;
  }

  async function runShutdown() {

    // Stop service child processes early — before we persist the draft — so no
    // service keeps writing the store while we snapshot it.
    if (supervisor) { try { supervisor.stopAll(); } catch {} }
    // An in-flight replay render: tear its browser down now, so the request
    // settles inside the inflight drain rather than pinning it (and a Chrome).
    if (replayRoutes) replayRoutes.abortRender();
    // The remote-access setup page's own listener (lib/server/tunnel-setup).
    if (tunnelRoutes) tunnelRoutes.close();

    // End any open event streams first: they'd otherwise pin the inflight drain
    // for its full timeout and then block server.close() indefinitely.
    closeStreams();

    // Wait for a genuinely in-flight turn to finish, but don't block on a lock
    // that's already orphaned (stale) — that would just stall shutdown.
    // (An ask stays answerable meanwhile: answering it may be what lets the
    // turn finish.)
    const lockDeadline = Date.now() + LOCK_DRAIN_TIMEOUT_MS;
    while (graph.lock && !lockIsStale(graph.lock) && Date.now() < lockDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Then the asks, the answer surface and the control layer, BEFORE the
    // inflight drain: an ask hook's long-poll and a frame's view poll would
    // otherwise pin it. stopMirror awaits what this starts. And the mod layer
    // (tranche 6) beside them, for the same reason: the mod's op long-poll.
    stopTurnControls();
    stopModLayer();

    await waitForInflight();

    try {
      const snap = graph.snapshotLive();
      writeDraft(draftFile, graph.active, snap);
    } catch {}

    // The chat mirror, once no request is left to feed it (a turn-end that
    // drained above has put its Stop on the hook tap by now), for at most
    // MIRROR_STOP_TIMEOUT_MS. See stopMirrorBounded. (The asks, the answer
    // surface and the control layer were stopped before the drain, and are
    // awaited inside the same ceiling.)
    await stopMirrorBounded();

    if (wsApi && typeof wsApi.shutdown === 'function') wsApi.shutdown();

    // Before Node 19, server.close() waited for every existing connection
    // INCLUDING idle keep-alive sockets — and lib/client's http.globalAgent
    // keeps sockets pooled. One idle pooled socket was enough to stall close()
    // past the caller's wait, so the portfile never got deleted and a clean
    // shutdown read as a failure. Node 19 made close() hang up on idle
    // connections itself, and the engines floor is 22 (lib/core/versions
    // NODE_FLOOR) — this comment used to call 18 "the engines floor", which had
    // not been true for some time. Kept as belt-and-braces: it costs nothing and
    // says the intent out loud.
    if (typeof server.closeIdleConnections === 'function') {
      try { server.closeIdleConnections(); } catch {}
    }

    await closeServer();
    // Both records, one rule: only if each still names THIS process. A second
    // daemon that came up on the same root owns them now, and its note must stay
    // on the door — for the portfile AND for its ~/.web-chat registry entry,
    // which is what the hub routes captures through.
    release({ root: paths.root, pid: process.pid });
  }

  // The one "stop this daemon" entry point: drain + snapshot, then exit. Shared
  // by the WS idle-shutdown timer and by POST /api/shutdown so there is exactly
  // one shutdown path, not two that can drift. (The SIGTERM/SIGINT handlers run
  // the same body — see installSignalHandlers — because a signal must keep
  // working for `kill` and for the OS regardless of what the route does.)
  const triggerShutdown = () => {
    gracefulShutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  };

  const projectName = path.basename(paths.root);
  // Forward reference: the supervisor needs wsApi.clients.size, and attachWebSocket
  // needs the viewer callback — so declare it here and construct it just below.
  let supervisor = null;
  // The replay routes' handle (abortRender), set where they are mounted below.
  let replayRoutes = null;
  let tunnelRoutes = null;
  // The chat mirror's engine and its audience gate, built just below. Both
  // teardown paths stop them through stopMirror.
  let audience = null;
  let mirror = null;
  // The turn guard (lib/server/turn-guard), built after the mirror: it ends a
  // held turn on evidence when Claude Code fires no Stop. Both teardown paths
  // stop it beside the mirror.
  let turnGuard = null;
  // The mod bridge (tranche 6), built after the tranche-4 engines below. The
  // asks domain's mod transport reaches it through sendToMod, so it is
  // declared here; until it is built a decision for the mod is refused.
  let bridge = null;
  function sendToMod({ session_id, request_id, decision } = {}) {
    if (!bridge) return Promise.resolve({ ok: false, refused: 'not-attached', delivered: false });
    return bridge.enqueue(session_id, { op: 'permissionDecision', args: { request_id, decision } });
  }

  // What the chat mirror's failures (and the audience's opt-in changes) say in
  // the daemon's log. Each line names a stage and an error class or code, never
  // what the engine was reading (lib/server/mirror/index.js).
  const mirrorLog = (...a) => console.error('[web-chat]', ...a);

  // The chat mirror's three in-process inputs, made before the socket so its
  // first connection is already judged by the real audience:
  //   * the hook tap (spec §1.4): every hook envelope the daemon accepts, in
  //     arrival order — the hook intake's and the turn routes'. An instance of
  //     the change bus with its own ring and no broadcaster, so it holds no
  //     handle of its own; the engine's stop() unsubscribes from it.
  //   * the redactor (§5.5): what the engine stores or answers passes it. It
  //     knows web-chat's own capture token (learnCaptureToken, below), so text
  //     that quotes it is masked like any secret.
  //   * the audience (§5.4): who is asking, and how much of the mirror they may
  //     see. It follows the mirror opt-in in ~/.web-chat/tunnel/tunnel.json
  //     through the one watch engine, and stops with the server.
  const hooks = createHookTap();
  const redactor = createRedactor();
  // The capture token the redactor knows is the one the capture routes honour.
  // They read it afresh on every request (routes/capture configuredToken: the
  // env var, else .web-chat/capture-token), so a token made or changed while
  // the daemon runs gates the very next capture. The redactor follows it as a
  // known-value SOURCE (redact.js addKnownSource): it re-reads the token itself,
  // at most every 2 s, whenever it redacts, so a token written while the daemon
  // runs is masked even if no capture route has seen it yet. It also learns the
  // token in front of each route that checks it (mounted with the capture
  // routes, below), so the token a request is held to is masked at once. Every
  // token it ever read is also added with addKnown, which is additive: a token
  // replaced since stays masked, and a failed read (configuredToken answers
  // null) never unmasks one.
  let knownCaptureToken = null;
  function learnCaptureToken() {
    const token = configuredToken(paths);
    if (token && token !== knownCaptureToken) {
      redactor.addKnown(token, 'capture-token');
      knownCaptureToken = token;
    }
    return token;
  }
  learnCaptureToken();
  redactor.addKnownSource(learnCaptureToken, 'capture-token');
  // Text written into the graph — the lock's message, a node's trigger, each
  // folded entry — passes the redactor before it is kept (spec §3.2,
  // domain/turns redactGraphText), set here the way graph.draftPath is.
  graph.redactText = (s) => redactor.text(s);
  audience = createAudience({ root: paths.root, log: mirrorLog });

  const wsApi = attachWebSocket(server, {
    state,
    graph,
    paths,
    bus,
    projectName,
    triggerShutdown,
    onViewersChanged: (n) => { if (supervisor) supervisor.setViewers(n); },
    audience,
  });

  // The chat mirror (spec §2.12). Its own change bus, so the conversation's
  // volume never evicts the surface's events from the main ring (§2.9), with
  // the same broadcaster as the main bus: ws.js projects every mirror:* frame
  // per socket by its level and posture. The engine listens to the hook tap and
  // to the main bus (control events), and is started once the routes that read
  // it are mounted, below.
  const mirrorBus = createBus({ maxEvents: MIRROR_RING, bootId });
  mirrorBus.setBroadcaster(wsApi.broadcast);
  // The per-turn diff engine's shadow store: ONE instance, which the codediff
  // source snapshots through (its SOURCES entry is rebuilt over it, below;
  // SOURCES itself is unchanged) and code revert restores through (tranche 4),
  // over the daemon's one runGit, whose exclusive slot keeps a restore and a
  // snapshot apart. Lazy: no git runs until the first fresh turn or a restore,
  // and it holds no handle of its own.
  const shadow = createShadowStore({ root: paths.root, paths: projectPaths(paths.root), runGit, log: mirrorLog });
  mirror = createMirror({
    root: paths.root,
    paths: projectPaths(paths.root),
    graph,
    mainBus: bus,
    mirrorBus,
    hooks,
    redactor,
    audience,
    log: mirrorLog,
    // SOURCES as listed, the codediff source rebuilt over the one shadow store
    // code revert restores through (tranche 4, below).
    sources: SOURCES.map((s) => (s.name === 'codediff'
      ? Object.freeze({ name: 'codediff', attach: createCodediffSource({ shadow }).attach })
      : s)),
  });
  // The graph link (spec §2.8): commitNode attaches each closed turn to the
  // node it commits through the facade's attachToNode (the graph-link source),
  // set here the way graph.draftPath is. Unset, a node carries no mirror key.
  graph.mirror = mirror;

  // ── Tranche 4: answering, the composer and control (spec §11.7) ──────────
  //
  // The asks domain (§4.3): the permission prompts, questions and plans a hook
  // hands the daemon, published on the MIRROR bus (ruling A4: Claude's
  // get_events and SSE drivers never see ask outcomes). It reaches the answer
  // surface through a getter, since the surface is built over it.
  const asks = createAsks({
    bus: mirrorBus,
    hooks,
    mirror,
    getViewers: wsApi.getViewerSummary,
    audience,
    answerSurface: () => answerSurface,
    redactor,
    root: paths.root,
    // The mod's permission prompts (tranche 6, §15.7): the domain hears the
    // mod's ModEvents on the tap itself, and a web decision goes back as ONE
    // permissionDecision op on that session's queue.
    send: sendToMod,
  });
  // The answer surface (§4.4): the loopback listener on an origin of its own
  // (lib/server/isolated-origin binds loopback even under WEB_CHAT_HOST), the
  // only routes through which a click answers an ask or acts. Lazy: nothing
  // listens until the first ensure(). The chrome's port, for its
  // frame-ancestors, is known only after listen, so it is a getter; `root`
  // lets the frame palette follow the global theme and the packs audit (A6).
  const answerSurface = createAnswerSurface({
    asks,
    mainPort: () => (server.address() ? server.address().port : null),
    audience,
    root: paths.root,
    log: mirrorLog,
  });
  // The control domain (§15.2, §15.5): the action table every acting control
  // is a row of, registered on the answer surface as kind 'control' at start.
  // The interrupt row is its own; the revert rows (restore, undo) and the fork
  // row join through control.action — never by editing the table.
  const control = createControl({
    root: paths.root,
    paths: projectPaths(paths.root),
    bus,
    mirror,
    graph,
    audience,
    answerSurface,
    getViewers: wsApi.getViewerSummary,
    log: mirrorLog,
  });
  // Code revert stands on the per-turn diff engine's shadow store (`shadow`,
  // made before the mirror, whose codediff source snapshots through it).
  const restore = createRestore({ root: paths.root, paths: projectPaths(paths.root), shadow, runGit, log: mirrorLog });
  const revert = installRevert(control, {
    restore, mirror, graph, root: paths.root, paths: projectPaths(paths.root), bus, redactor, log: mirrorLog,
  });
  const fork = installFork(control, { mirror, graph, root: paths.root, bus, log: mirrorLog });
  // The composer's `@` index and `/` catalog, built once: the files and skills
  // routes read them, and so does the queue's message validation (ctx).
  const projectFiles = createProjectFiles({ root: paths.root });
  const skills = createSkillCatalog({ root: paths.root, mirror, redactor });
  // The queue's release scheduler (§6.4): Send's autosend at Claude's next
  // boundary, Send now, targeting and the receipts' timers. Started once the
  // routes are mounted, below.
  const queueRelease = createQueueRelease({
    state, bus, graph, mirror, asks, log: mirrorLog, ...(queueReleaseOpts || {}),
  });

  // What the mirror answers from these (mirror.provide, lib/server/mirror):
  // the asks' public views in its snapshot, and the six capabilities from what
  // is wired here. interrupt, code_revert and fork are the control domain's
  // own features() answers, never re-derived here (ruling B6 a: booleans; the
  // reasons are the guide's, and the preview route's 503).
  let queueRoutesMounted = false;
  const controlFeature = (key) => {
    const f = control.features()[key];
    return Boolean(f && f.ok === true);
  };
  mirror.provide('asks', { publicViews: ({ level }) => asks.list({ level }) });
  mirror.provide('capabilities', {
    answer: () => true, // the asks domain and the answer surface are wired (ruling E2: no off switch)
    task_stop: () => queueRoutesMounted, // and the tasks source can mark a stop (the facade's rule)
    queue_message: () => queueRoutesMounted && Boolean(projectFiles && skills),
    interrupt: () => controlFeature('interrupt'),
    code_revert: () => controlFeature('code_revert'),
    fork: () => controlFeature('fork'),
    // Tranche 6's two (below): a mod attached to any session, and the
    // experimental in-place resume (the mod's resume row's own answer).
    mod: () => Boolean(bridge && bridge.any() === true),
    rewind_in_place: () => Boolean(modControl && modControl.features().resume.ok === true),
  });

  // ── Tranche 6: the mod (spec §11.9, §15.7) ─────────────────────────────────
  //
  // The bridge (§15.7): the registry of mod-attached sessions, their op
  // queues and the mod's events, each published once on the hook tap. Its
  // permission wait goes out with each hello, so it is set before the first:
  // 0 as shipped (the mod hands every prompt on) until V41 says otherwise.
  bridge = createBridge({ root: paths.root, paths: projectPaths(paths.root), hooks, mirror, log: mirrorLog });
  bridge.setPermissionWait(modPermissionWaitOpt !== undefined ? modPermissionWaitOpt : modPermissionWait(process.env));
  // Control on the mod (§15.2 path 1, §6.9, §15.6), as rows of the control
  // domain — the interrupt's mod path (tried before tty and hook), the
  // trays' task-stop and the experimental in-place resume over fork's
  // forkTurn — and the session controls (context, compact, plan, rename,
  // clear, resume) beside them: all through control.action, never the table.
  const modControl = installModControl(control, { bridge, mirror, forkTurn: fork.forkTurn, bus, log: mirrorLog });
  const offSessionOps = installSessionOps(control, { bridge, mirror, log: mirrorLog });
  // The context meter's readings (the mod's session.measure, kept per
  // session from the tap), which GET /api/mirror/context reads.
  const contextReadings = createContextReadings({ hooks, mirror });
  // Each conversation's process.mod: the bridge's answer for its session.
  mirror.provide('mod', { attached: (sid) => bridge.attached(sid), onChange: (fn) => bridge.onChange(fn) });
  // The composer on the mod (§15.7, §6.1): the queue offers each message to
  // the transport seam first — a mod-attached conversation's goes as one
  // submit (or a safe command) op — and the composer's validation reads the
  // `/` catalog and the `@` index through the adapters (the mod's safe
  // commands; an attachment's own path), per request.
  state.messageTransport = createModTransport({ bridge, mirror, state, bus, log: mirrorLog, graph });
  const composerSkills = withModCommands(skills, { bridge, mirror });
  const composerFiles = withAttachments(projectFiles, { root: paths.root });

  // Every handle tranche 6 holds, stopped in BOTH teardown paths (runShutdown,
  // before the inflight drain, which the mod's op long-poll would pin; and
  // stop(), through stopMirror): the message transport (off first, so no
  // delivery is offered to a stopping bridge), the mod's and the session
  // controls' rows and their fill waits, the readings' tap subscription, and
  // the bridge — its long-polls, waiters, pending ops and sweep timer, all
  // synchronously. Idempotent.
  let modLayerStopped = false;
  function stopModLayer() {
    if (modLayerStopped) return;
    modLayerStopped = true;
    if (state.messageTransport) state.messageTransport = null;
    try { offSessionOps(); } catch {}
    try { modControl.unregister(); } catch {}
    try { contextReadings.stop(); } catch {}
    try { bridge.stop(); } catch {}
  }

  // Every handle the tranche-4 block above holds, stopped in BOTH teardown
  // paths (runShutdown and stop(), each through stopMirror): the scheduler's
  // timers and subscriptions, the revert's and the control domain's timers and
  // their kind on the answer surface (before the surface closes, so nothing
  // re-opens it), the answer surface's listener, its nonces, its idle timer and
  // the frames' long-polls, the asks' TTL timers and the hook long-polls they
  // end, and an index build in flight. The answer surface closes BEFORE the
  // asks stop: its close() forgets every nonce at once, so no decision can
  // land after asks.stop() has passed each undecided mod ask back (and the
  // domain refuses one anyway). Each stop's synchronous part runs here, in
  // that order; the promise settles once each has. Idempotent: the first
  // call's promise is every later call's.
  let turnControlsStopped = null;
  const settled = (fn) => { try { return Promise.resolve(fn()).catch(() => {}); } catch { return Promise.resolve(); } };
  function stopTurnControls() {
    if (turnControlsStopped) return turnControlsStopped;
    try { queueRelease.stop(); } catch {}
    const stops = [settled(() => revert.stop()), settled(() => control.stop()), settled(() => answerSurface.close())];
    try { asks.stop(); } catch {}
    try { projectFiles.stop(); } catch {}
    turnControlsStopped = Promise.all(stops).then(() => {});
    return turnControlsStopped;
  }

  // The one place both teardown paths stop the chat mirror's handles, so
  // neither can forget one: the turn guard (its timers and its subscriptions to
  // the main bus, the hook tap and the mirror), the engine (it flushes its
  // index and clears every timer, watcher and tailer it holds) and the
  // audience's tunnel.json watcher.
  // Each stop() is idempotent, and neither ever rejects here.
  function stopMirror() {
    // The turn guard first: its stop() is synchronous and idempotent, and once
    // it is stopped no timer of its can call endTurn into a stopping engine.
    if (turnGuard) { try { turnGuard.stop(); } catch {} }
    // The graph's own handles: a held lock's stale timer (domain/turns stopGraph).
    try { stopGraph(graph); } catch {}
    // Tranche 4's (stopTurnControls, above): the asks, the scheduler, the
    // control layer, the index and the answer surface; then tranche 6's
    // (stopModLayer, above): the transport, the mod's rows, the readings and
    // the bridge.
    const stops = [stopTurnControls()];
    stopModLayer();
    if (mirror) stops.push(Promise.resolve().then(() => mirror.stop()).catch(() => {}));
    if (audience) stops.push(Promise.resolve().then(() => audience.stop()).catch(() => {}));
    return Promise.all(stops).then(() => {});
  }
  // The same, with the graceful shutdown's ceiling on it (MIRROR_STOP_TIMEOUT_MS):
  // a stop that has not settled by then is left to finish on its own — or to the
  // process exit that follows the shutdown — so the drain, and the release()
  // after it, always run. The timer is cleared the moment the stop settles.
  // (stop(), the tests' path, waits on the stop itself: a test must see every
  // handle end.)
  function stopMirrorBounded() {
    return new Promise((resolve) => {
      const ceiling = setTimeout(() => {
        mirrorLog(`mirror: stop timed out after ${MIRROR_STOP_TIMEOUT_MS} ms`);
        resolve();
      }, MIRROR_STOP_TIMEOUT_MS);
      stopMirror().then(() => { clearTimeout(ceiling); resolve(); });
    });
  }

  // The wake-policy subscriber. Classify every bus
  // event once: wake-worthy ones fold into the queue (the default deliberate-
  // handoff path) or emit a `wake` immediately (a pane's declared
  // `wake:'immediate'` signal). Registered AFTER attachWebSocket so the WS
  // broadcaster is bound (enqueue emits a `queue` frame for the rail). This runs
  // in the daemon with the direct bus, distinct from the channel bridge, which
  // runs in the MCP process and taps the same feed over SSE. classify returns
  // null for `queue`/`wake` (and every other) kind, so nested emits don't loop.
  // (The nested `queue`/`wake` emit fans out to later SSE subscribers before the
  // outer event does — the ring order + `?since` catch-up stay correct, and the
  // bridge filters kinds:['wake'], so this only affects an all-kinds *live* SSE
  // consumer relying on strict id ordering, which none do.)
  bus.subscribe((event, meta) => {
    // Only a browser store write or a delegated dom event needs the (mount-
    // derived) signal/routing context, so derive it lazily — captures classify
    // without it, and every other kind returns null before it's touched.
    const needsCtx = event && (
      (event.kind === 'store' && event.source === 'browser') || event.kind === 'dom'
    );
    const c = classify(event, needsCtx ? { signals: signals.derive(state), routing: signals.deriveRouting(state) } : undefined);
    if (!c) return;
    // `meta.provenance` is the writing socket's origin/device (ws.js → patchStore).
    if (c.action === 'wake') {
      queueDomain.emitWake(bus, [c.item], {
        reason: 'immediate', source: c.item.source, graph, ...queueDomain.provFields(meta && meta.provenance),
      });
    }
    else if (c.action === 'dequeue') queueDomain.removeByComment(state, bus, c.comment_id);
    // F9: a shared pin's text was edited — refresh its queued item's summary in
    // place (no-op if it was never queued; refresh never enqueues).
    else if (c.action === 'refresh') queueDomain.refreshComment(state, bus, c.comment_id, c.item);
    // The opt-out activity layer: fold into the mount's rolling activity item.
    else if (c.action === 'coalesce') queueDomain.coalesce(state, bus, c.item);
    // `meta.prior` (a store write's pre-write values — domain/store) lets a
    // signal item remember what its Revert should put back.
    else queueDomain.enqueue(state, bus, c.item, { prior: meta && meta.prior });
  });

  // The service supervisor — spawns/stops host-side service.js children for
  // service-backed components, bound to the active node + viewer presence. Built
  // after attachWebSocket so getViewers can read the live client set; getPort is a
  // lazy closure (null until server.listen, but spawn is viewer-gated so a viewer,
  // hence a bound port, always exists first). See lib/server/services.js.
  supervisor = createServiceSupervisor({
    state, graph, paths, bus,
    getPort: () => (server.address() ? server.address().port : null),
    getViewers: () => wsApi.clients.size,
    log: (...a) => console.log('[services]', ...a),
  });
  supervisor.attach();

  const ctx = {
    state,
    bus,
    graph,
    paths,
    // The project root — the version route spawns a detached `update` here so the
    // restart bounces THIS instance (and finds its portfile/draft).
    root,
    // Every producer emits through the one change bus (ctx.bus.emit). The
    // full-state WS snapshot (reset/hello) is the one thing that stays outside
    // the ring — graph routes trigger it via broadcastReset.
    broadcastReset: wsApi.broadcastReset,
    retain: wsApi.retain,
    release: wsApi.release,
    sseClients,
    // Read-only view of pending service-trust requests, plus a re-read trigger.
    // Neither grants anything: the decision is a filesystem write made by the
    // CLI, and refresh only makes the supervisor re-read that file from disk.
    services: () => supervisor,
    // How many browsers are actually watching. Already tracked for the service
    // supervisor (a service runs only while someone is looking); it was never
    // exposed, so Claude could render into a surface nobody had open, say "take
    // a look", and be told it worked — as could `doctor` and `status`.
    getViewers: () => wsApi.clients.size,
    // Last sighting of an MCP server process, { seen_at, started_at } or null.
    // Health exposes it so a live `doctor` reports the same verdict as the
    // on-disk read, without a second source of truth.
    getMcpSeen: () => mcpSeen,
    // The single shutdown entry point, also handed to ws.js for its idle timer.
    // POST /api/shutdown calls THIS — it does not re-implement the drain.
    triggerShutdown,
    // The hook tap (lib/server/hook-tap.js): the hook intake and the turn routes
    // publish every hook envelope the daemon accepts on it, host requests only.
    hooks,
    // The redactor (lib/core/redact.js createRedactor): every text the chat
    // mirror stores or answers passes it, with the capture token among its
    // known values.
    redactor,
    // The audience gate (lib/server/audience.js): a request's or a socket's
    // mirror level, the one host-only test (isHost), and requireMirror.
    audience,
    // The chat mirror (lib/server/mirror): the routes read it and nothing else of
    // the engine's.
    mirror,
    // The turn guard (lib/server/turn-guard): the turn routes ask it whether a
    // held turn has ended (ended, closedRecently) and hand it a late Stop
    // (reconcileLateStop) and an interrupted end (noteEnded). Set just below,
    // once the graph routes hand back endTurn.
    turnGuard: null,
    // The asks domain (lib/server/domain/asks): the ask hook's create, poll and
    // withdraw, the chrome's GET /api/asks, and the mirror snapshot's asks.
    asks,
    // The answer surface (lib/server/answer-surface): the loopback listener the
    // answer and control frames are served from; /api/health reports its port.
    answerSurface,
    // The control domain (lib/server/control): the action table (interrupt,
    // restore, undo, fork), the notices Claude is owed, the halt flags.
    control,
    // The composer's `@` index (lib/server/project-files) and `/` catalog
    // (lib/server/skills), built once: the files, skills and queue routes read
    // them — through tranche 6's adapters (lib/server/routes/attachments
    // withAttachments: a saved image's own path; lib/server/mod-transport
    // withModCommands: the mod's safe commands), which keep every answer the
    // index and the catalog give.
    projectFiles: composerFiles,
    skills: composerSkills,
    // The queue's release scheduler (lib/server/queue-release): the queue
    // routes hand it a message's Send and Send now.
    queueRelease,
    // The mod bridge (lib/server/domain/bridge): the bridge routes' four mod
    // calls and status; the control rows enqueue its ops in process.
    bridge,
    // The context meter's readings (lib/server/control/session-ops
    // createContextReadings): GET /api/mirror/context reads them per request.
    contextReadings,
  };
  mountHealthRoutes(app, ctx);
  mountRenderRoutes(app, ctx);
  mountPageRoutes(app, ctx);
  mountHistoryRoutes(app, ctx);
  mountPaneSpawnRoutes(app, ctx);
  mountComponentRoutes(app, ctx);
  mountPackRoutes(app, ctx);
  mountStoreRoutes(app, ctx);
  mountEventRoutes(app, ctx);
  mountQueueRoutes(app, ctx);
  queueRoutesMounted = true;
  const graphRoutes = mountGraphRoutes(app, ctx);
  // The turn guard (spec §3.3), after the mirror and the graph routes: it reads
  // the main bus (the lock's changes), the hook tap (Stop, StopFailure,
  // SessionEnd) and the mirror's transitions, and ends a Stop-less turn through
  // the routes' own endTurn. It subscribes at construction; stopMirror stops it.
  turnGuard = createTurnGuard({ graph, bus, hooks, mirror, isPidAlive: (pid) => isPidAlive(pid) });
  turnGuard.bindEndTurn(graphRoutes.endTurn);
  ctx.turnGuard = turnGuard;
  mountCommentRoutes(app, ctx);
  mountThemeRoutes(app, ctx);
  mountEmbedRoutes(app, ctx);
  mountEmbedHelperRoutes(app, ctx);
  mountExportRoutes(app, ctx);
  mountBrandRoutes(app, ctx);
  replayRoutes = mountReplayRoutes(app, ctx);
  // Ahead of the two capture routes that check the token: the redactor learns
  // the token a request is about to be held to (learnCaptureToken, above).
  app.use(CAPTURE_TOKEN_ROUTES, (req, res, next) => { learnCaptureToken(); next(); });
  mountCaptureRoutes(app, ctx);
  mountProfileRoutes(app, ctx);
  mountVersionRoutes(app, ctx);
  mountMachineRoutes(app, ctx);
  tunnelRoutes = mountTunnelRoutes(app, ctx, tunnelSetupOpts);
  // The chat mirror's routes: the hook intake (host only), the mirror's state,
  // its content (a conversation's turns, an item's fields, an attachment: read
  // and above), its work (tasks, a task's output, an agent, a workflow) and its
  // code (a turn's or a node's diff, a node's turns, the nodes' summaries; both
  // read and above), what a viewer may see of it, and the project's identity.
  mountHookRoutes(app, ctx);
  mountMirrorRoutes(app, ctx);
  mountMirrorContentRoutes(app, ctx);
  mountMirrorTasksRoutes(app, ctx);
  mountMirrorCodeRoutes(app, ctx);
  mountMirrorAccessRoutes(app, ctx);
  mountProjectRoutes(app, ctx);
  // Tranche 4's: the ask hook's and the chrome's asks (host only, and read for
  // the chrome), the composer's `@` files and `/` skills, the hook's notices
  // claim, and code revert's preview. (The queue's message routes are
  // mountQueueRoutes', above; every acting control is on the answer origin.)
  mountAskRoutes(app, ctx);
  mountFilesRoutes(app, ctx);
  mountSkillsRoutes(app, ctx);
  mountControlRoutes(app, ctx);
  mountCodeRoutes(app, ctx);
  // Tranche 6's: the mod's bridge (host only, token-checked), the composer's
  // image attachments, and the context meter's reading.
  mountBridgeRoutes(app, ctx);
  mountAttachmentRoutes(app, ctx);
  mountMirrorContextRoutes(app, ctx);

  // Start the engine last, once everything that reads it is in place. start()
  // never rejects (a failure is logged and the routes answer what it holds),
  // and its timers are ref'd: both teardown paths end them (stopMirror).
  mirror.start();
  // The bridge after it: it subscribes to the hook tap and the mirror (a
  // session's process gone detaches its mod) and arms its sweep.
  bridge.start();
  // Then the control layer — its start sweeps the halt flags a previous
  // daemon left behind and registers kind 'control' on the answer surface
  // (never ensure()d at boot) — and the revert after it; and the release
  // scheduler, once the mirror and the asks it reads are running. None
  // rejects; both teardown paths stop each (stopTurnControls).
  const controlStarted = Promise.resolve()
    .then(() => control.start())
    .then(() => revert.start())
    .catch((e) => mirrorLog(`control: start failed (${(e && e.code) || 'error'})`));
  queueRelease.start();

  // Is anything already serving this port, on ANY address?
  //
  // A bind to 127.0.0.1:P does NOT collide with a process holding the wildcard
  // *:P — the OS treats them as different addresses — so once the daemon moved
  // to loopback, the port walk started handing out ports that already had a
  // server on them. Two daemons on one port then split traffic by address
  // family, and since web-chat's own clients resolve `localhost` (which can be
  // ::1 or 127.0.0.1), requests land on whichever one that resolution picks.
  // Probing first makes the walk mean "free" again.
  async function portIsTaken(p) {
    try { return await probeReachable(p, 200); } catch { return false; }
  }

  function tryListen(p) {
    return new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('error', onError);
        if (e && e.code === 'EADDRINUSE') resolve(false);
        else reject(e);
      };
      server.once('error', onError);
      try {
        server.listen(p, LISTEN_HOST, () => {
          server.off('error', onError);
          resolve(true);
        });
      } catch (e) {
        server.off('error', onError);
        if (e && e.code === 'EADDRINUSE') resolve(false);
        else reject(e);
      }
    });
  }

  // Only a real daemon process installs these — which is also the one place that
  // may claim `process.on('exit')`, so the last-resort release lives here rather
  // than in createServer (a test process stands up dozens of servers and must not
  // accumulate exit hooks or release records it never claimed).
  function installSignalHandlers() {
    // A signal is now PATIENT: it joins the in-flight shutdown instead of
    // truncating it, so release() always gets to run. See gracefulShutdown.
    const handler = () => {
      gracefulShutdown().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
    // Belt and braces for every OTHER way out — an uncaught exception, an
    // explicit exit, a shutdown that threw. Leaving a stale portfile behind is
    // the failure the ownership rule exists to contain, and release is pid-
    // guarded, so running it a second time after a clean shutdown is a no-op.
    // Must stay synchronous: nothing async runs during 'exit'.
    process.on('exit', () => {
      try { release({ root: paths.root, pid: process.pid }); } catch {}
    });
  }

  async function start({ writePortfile: doWritePortfile = true } = {}) {
    let bound;
    if (port === 'auto') {
      let candidate = 5173;
      const maxTries = 100;
      for (let i = 0; i < maxTries; i++) {
        if (await portIsTaken(candidate)) { candidate++; continue; }
        const ok = await tryListen(candidate);
        if (ok) { bound = candidate; break; }
        candidate++;
      }
      if (bound == null) throw new Error('no free port found in range 5173..' + (5173 + maxTries - 1));
    } else {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off('error', onError); reject(e); };
        server.once('error', onError);
        server.listen(port, LISTEN_HOST, () => { server.off('error', onError); resolve(); });
      });
      bound = server.address().port;
    }

    if (doWritePortfile) {
      writePortfile('server', { root, pid: process.pid, port: bound });
      // Make sure a CURRENT-protocol capture hub is up *before* we register. The
      // hub self-closes once the registry empties, so an instance coming up into an
      // empty world must bring it back first; the hub's startup grace covers the
      // brief gap until this registration lands. ensureHub also self-heals a stale
      // hub (one predating a HUB_PROTOCOL_VERSION bump — e.g. before /api/profile-match
      // existed) by bouncing it, so a plain instance restart upgrades the hub. Both
      // are best-effort — a failure here must not stop the surface from serving.
      // The return value was discarded, so a hub that could not be brought up
      // (another user's, on the machine-wide hub port) was silent everywhere but
      // `doctor`. Captures from the extension then had nowhere to land.
      ensureHub()
        .then((h) => { if (!h) console.error('web-chat: no capture hub is available — page captures from the browser extension cannot be routed here. `claude-web-chat doctor` explains.'); })
        .catch(() => {});
      try {
        registerInstance({ root: paths.root, port: bound, pid: process.pid, url: `http://localhost:${bound}`, title: projectName });
      } catch {}
    }

    console.log(`web-chat server listening on http://localhost:${bound}  (active=${graph.active}, nodes=${graph.nodes.size})`);
    warnIfExposed();
    return { port: bound };
  }

  return {
    app,
    server,
    start,
    installSignalHandlers,
    stop: () => {
      if (supervisor) { try { supervisor.stopAll(); } catch {} }
      if (replayRoutes) replayRoutes.abortRender();
      const setupClosed = tunnelRoutes ? tunnelRoutes.close() : Promise.resolve();
      // The turn guard, the chat mirror and its audience, as runShutdown stops them.
      const mirrorStopped = stopMirror();
      if (wsApi && typeof wsApi.shutdown === 'function') wsApi.shutdown();
      closeStreams(); // else an open SSE response keeps server.close() pending forever
      return Promise.all([
        setupClosed, mirrorStopped, new Promise((resolve) => server.close(() => resolve())),
      ]).then(() => {});
    },
    gracefulShutdown,
    waitForInflight,
    get services() { return supervisor; },
    // The chat mirror's engine, as ctx.mirror hands it to the routes: a test
    // registers a source on it (mirror.register) or reads its stats().
    get mirror() { return mirror; },
    // The turn guard, as ctx.turnGuard hands it to the turn routes.
    get turnGuard() { return turnGuard; },
    // Tranche 4's engines, as ctx hands them to the routes (tests drive the
    // control rows through control.invoke). `controlStarted` settles once the
    // control domain and the revert have started.
    get asks() { return asks; },
    get answerSurface() { return answerSurface; },
    get control() { return control; },
    get queueRelease() { return queueRelease; },
    controlStarted,
    // Tranche 6's: the bridge, as ctx.bridge hands it to the routes, and the
    // queue's message transport as it stands (tests: null after either
    // teardown path).
    get bridge() { return bridge; },
    get messageTransport() { return state.messageTransport || null; },
    get port() { return server.address() ? server.address().port : null; },
  };
}

module.exports = { createServer, MIRROR_STOP_TIMEOUT_MS };

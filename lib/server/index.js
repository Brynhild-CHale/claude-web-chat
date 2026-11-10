const express = require('express');
const http = require('http');
const path = require('path');
const { resolvePaths } = require('./paths');
const { projectPaths } = require('../core/paths');
const { createState } = require('./state');
const crypto = require('crypto');
const { createBus, MAX_EVENTS } = require('../core/bus');
const { createRedactor } = require('../core/redact');
const { createRelayCredential, takeRelaySecret } = require('./relay-credential');
const { packageVersion } = require('../core/versions');
const { createGraph } = require('./graph');
const { createElementStore } = require('./domain/elements');
const { reconcileElements } = require('./domain/elements-reconcile');
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
const { createReports } = require('./domain/reports');
const { createFormShifts } = require('./domain/form-shifts');
const { createMarks } = require('./domain/marks');
const { createSideTable } = require('./domain/side-table');
const { createElementTypes } = require('./element-types');
const { createControl } = require('./control');
const { createRestore } = require('./control/restore');
const { installRevert } = require('./control/revert');
const { installFork } = require('./control/fork');
const { installPackApprove } = require('./control/pack-approve');
const { installModControl } = require('./control/mod');
const { installSessionOps, createContextReadings } = require('./control/session-ops');
const { createModTransport, withModCommands } = require('./mod-transport');
const { createProjectFiles } = require('./project-files');
const { createSkillCatalog } = require('./skills');
const { createQueueRelease } = require('./queue-release');
const { mountRenderRoutes } = require('./routes/render');
const { mountWriterRoutes } = require('./routes/writers');
const { createWriters } = require('./domain/writers');
const { mountPageRoutes } = require('./routes/page');
const { mountHistoryRoutes } = require('./routes/history');
const { mountPaneSpawnRoutes } = require('./routes/spawn');
const { mountComponentRoutes } = require('./routes/components');
const { mountPackRoutes } = require('./routes/packs');
const { mountStoreRoutes } = require('./routes/store');
const { mountEventRoutes } = require('./routes/events');
const { mountFormRoutes } = require('./routes/forms');
const { mountQueueRoutes } = require('./routes/queue');
const { mountGraphRoutes } = require('./routes/graph');
const { mountHealthRoutes } = require('./routes/health');
const { mountCommentsGone } = require('./routes/comments');
const { mountElementTypeRoutes } = require('./routes/element-types');
const { mountElementFileRoutes } = require('./routes/element-files');
const { mountElementRoutes } = require('./routes/elements');
const { mountElementPictureRoutes } = require('./routes/element-picture');
const { mountElementUndoRoutes } = require('./routes/element-undo');
const { mountElementSearchRoutes } = require('./routes/element-search');
const { mountElementGlyphRoutes } = require('./routes/element-glyph');
const { mountMarksRoutes } = require('./routes/marks');
const { mountThemeRoutes } = require('./routes/theme');
const { mountToolbarRoutes } = require('./routes/toolbar');
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
const { classify, commentWords, chainSummary } = require('../channel/policy');
const { wakeOf } = require('../packs/elements');
const { excerptText } = require('../channel/envelope');
const { excerptsOn } = require('../core/excerpts');
const queueDomain = require('./domain/queue');
const signals = require('./domain/signals');
const { run: runMigrations } = require('../update/migrations');
const { seedBuiltins } = require('./builtins');
const { seedThemeLogos } = require('../setup/theme-logos');
const { loadUserProfiles } = require('../capture/profiles');
const { writePortfile, probeReachable, isPidAlive } = require('../core/portfiles');
const { LISTEN_HOST, warnIfExposed, requireLocalHost, SURFACE_CSP_REPORT_ONLY, BOOT_HEADER } = require('../core/cors');
const { registerInstance, release } = require('../util/registry');
const { mcpIdentityFromHeaders, recordMcpSeen, readMcpSeen } = require('../core/mcp-seen');
const { ensureHub } = require('../util/hub');

// ── The boot (07 C-07.9, C-07.10a, C-07.15; PLAN-T6 U749) ──
// The main ring's size: WEB_CHAT_EVENT_RING (or createServer's `eventRing`),
// read once at construction, for a busy chat on a slow link — the ring matters
// only for catch-up after a link drop. An integer, capped at EVENT_RING_MAX;
// today's MAX_EVENTS is both the floor and the default, so a smaller or
// malformed value leaves the ring as it was.
const EVENT_RING_MAX = 10_000;
function eventRingSize(value) {
  if (value == null || value === '') return MAX_EVENTS;
  const n = typeof value === 'number' ? value : (/^\s*\d+\s*$/.test(String(value)) ? Number(value) : NaN);
  if (!Number.isInteger(n) || n < MAX_EVENTS) return MAX_EVENTS;
  return Math.min(n, EVENT_RING_MAX);
}
// The walk seam (SPAWN@port-seam): WEB_CHAT_FIRST_PORT (or createServer's
// `firstPort`), read once at construction, moves start()'s 'auto' walk off 5173
// for tests, F12 and the soak. Set only by them — never by the connector in
// production, and nothing in lib/ sets it. Unset, the walk is today's. Set, the
// walk never lands on a reserved port: the capture hub (5170), the portal
// (5171) or the production walk's band (5173–5272).
const DEFAULT_FIRST_PORT = 5173;
const WALK_TRIES = 100;
const isReservedWalkPort = (p) => p === 5170 || p === 5171 || (p >= 5173 && p <= 5272);
function firstPortOf(value, log) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : (/^\s*\d+\s*$/.test(String(value)) ? Number(value) : NaN);
  if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n;
  log('WEB_CHAT_FIRST_PORT is not a port in 1024..65535; ignored, the walk starts at ' + DEFAULT_FIRST_PORT);
  return null;
}

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
// `tokenAtClaim` — the writer token file is written by start(), right after
// this daemon claims its portfile, instead of at construction (the foreground
// start passes it: lib/cli/commands/start.js; DECISIONS I.3 D2). Left false,
// the file is written at construction, as withServer and the CLI's in-process
// callers expect.
// `bootId`, `eventRing`, `firstPort` and `portIsTaken` are for tests only (U749):
// the boot id in place of a random one (07 C-07.15's "injectable"); the main
// ring's size in place of WEB_CHAT_EVENT_RING; the walk's first port in place of
// WEB_CHAT_FIRST_PORT; and the walk's "is this port answering?" probe, so a
// test can watch the candidates without binding any.
// `relaySecret` — the relay secret this daemon was handed at spawn (03 C-03.22),
// which the foreground start takes before anything else (takeRelaySecret, below,
// re-exported for lib/cli/commands/start.js) and passes in; `relaySecretVia`
// ('fd' or 'env') names the channel for the boot line. Null (the default, and
// every caller but a connector-spawned start) is a daemon handed no secret: no
// request ever carries a valid relay credential (C-03.21).
// `connectorRecord` (tests only) — the connector record's path in place of
// WEB_CHAT_CONNECTOR_RECORD, which is read once here (04 C-04.11, U742): the
// audience reads and follows it only in connected mode, and only inside the
// user tier's connector directory.
function createServer({
  root = process.cwd(), port = 'auto', tunnelSetup: tunnelSetupOpts, queueRelease: queueReleaseOpts,
  modPermissionWait: modPermissionWaitOpt, tokenAtClaim = false,
  bootId: bootIdOpt, eventRing: eventRingOpt, firstPort: firstPortOpt, portIsTaken: portIsTakenOpt,
  relaySecret = null, relaySecretVia = null,
  connectorRecord: connectorRecordOpt,
} = {}) {
  const paths = resolvePaths(root);
  const draftFile = projectPaths(root).draft;
  // The runner's answer (U204): `{refused: {from, report}}` from the v3→v4
  // step leaves comments read-only this boot (the element store reads it).
  const migration = runMigrations(paths.WEB_CHAT_DIR, { context: 'daemon' });
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
  // A token unique to THIS boot. It rides on wake events so the channel bridge
  // (which survives daemon restarts in the MCP process) can tell a restart's
  // reset seq space from a same-daemon replay, and on every response as
  // X-WC-Boot (07 C-07.9, below). Random per createServer and carrying no pid
  // (07 C-07.15, Q-07.8): `${pid}:${ms}` repeated for two servers built in one
  // millisecond in one process. Opaque — every reader compares it for equality
  // only. The chat mirror's bus, the element store and health carry the same
  // token.
  const bootId = typeof bootIdOpt === 'string' && bootIdOpt ? bootIdOpt : crypto.randomBytes(16).toString('hex');
  // The main ring's size, read once (07 C-07.10a; eventRingSize above).
  const bus = createBus({
    bootId,
    maxEvents: eventRingSize(eventRingOpt !== undefined ? eventRingOpt : process.env.WEB_CHAT_EVENT_RING),
  });
  // The walk seam, read once (firstPortOf above): null keeps today's walk.
  const firstPort = firstPortOf(
    firstPortOpt !== undefined ? firstPortOpt : process.env.WEB_CHAT_FIRST_PORT,
    (msg) => console.error('[web-chat]', msg),
  );
  // The redactor, BEFORE the graph loads (PLAN-T1 §2.3 finding (3)): the
  // element store below writes through it, and the boot reconcile reads with
  // it. The same object the chat mirror is handed later (see `hooks`, below).
  const redactor = createRedactor();
  // The relay credential (lib/server/relay-credential; 03 C-03.21, C-03.22),
  // right after the redactor, so the secret is one of its known values
  // ('relay-secret', 11 C-11.7) before any route, frame or log line exists. On
  // the route ctx and the WebSocket attach as `relay`, and handed to the answer
  // surface and the control domain beside the audience (C-03.21a). Never
  // served: the object answers connected / valid(req) / actorOf(req) only.
  const relay = createRelayCredential({ secret: relaySecret, redactor });
  if (relay.connected) {
    // One line, the channel only — never the value (GT-12's boot line).
    const via = relaySecretVia === 'fd' || relaySecretVia === 'env' ? relaySecretVia : 'option';
    console.error(`[web-chat] connected mode: a relay secret was handed (${via})`);
  }
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
  const graph = createGraph({ paths, state, draftPath: draftFile });
  // Text written into the graph — the lock's message, a node's trigger, each
  // folded entry — passes the redactor before it is kept (spec §3.2,
  // domain/turns redactGraphText), set here the way graph.draftPath is.
  graph.redactText = (s) => redactor.text(s);
  // The element store (domain/elements): the comment log, bound to the live
  // state and the graph. It hangs on the graph, as graph.mirror and
  // graph.redactText do, so commitNode and restoreLiveToNode reach it there
  // and the routes' ctx keeps its keys. Built before graph.load.
  graph.elements = createElementStore({
    paths: projectPaths(paths.root), state, graph, redactor, bus, bootId, migration,
  });

  graph.load();
  // A lock persisted in _meta.json (see graph.saveMeta) was written by a prior
  // process that, by definition, no longer holds it — load only runs at boot, so
  // whoever set this lock is gone. It therefore has no live holder regardless of
  // age; clearLockOnBoot clears it unconditionally so a crashed mid-turn session
  // can't wedge the new one (a restored *fresh* lock would otherwise block
  // turn-begin for the full TTL). The TTL only governs an orphaned lock within a
  // single live process.
  clearLockOnBoot(graph);
  // The element log against the graph, before anything is restored (U209's
  // states; a stub until then): its report goes to the store.
  reconcileElements({ graph, store: graph.elements, bus, paths, migration });
  // A turn lock's TTL is a wedge-breaker, not a turn-length budget: Claude's own
  // writes re-stamp it, so a long turn (agentic ones routinely outlive the wake
  // lock's short TTL) stays the holder of its lock until it Stops. One subscriber,
  // wired once — see installLockKeepalive for why a driver's writes are excluded.
  installLockKeepalive(graph, bus);
  if (graph.active) graph.restoreLiveToNode(graph.active, bus);
  else graph.clearLiveMounts();
  loadDraft(draftFile, graph.active, state);
  // The draft's pins get the log version each pins, hash-checked, as the
  // restored node's did inside restoreLiveToNode.
  graph.elements.attachLive(state.comments, { draft: true });
  // The report path's holder (lib/server/domain/reports, PLAN 2B.1): the
  // per-surface counter (state.surface, seeded here from the clock, after the
  // boot's own restore and draft, so no report made against an earlier daemon
  // can match) and the live answers a local viewer's resolver reports. The
  // audience and the answer surface are built later; U312's remote half reads
  // them through these getters.
  const reports = createReports({
    state, graph, bus,
    audience: () => audience,
    answerSurface: () => answerSurface,
    now: Date.now,
    log: (...a) => console.error('[web-chat]', ...a),
  });
  // The C4 counter (lib/server/domain/form-shifts, PLAN 4D.1): the chrome's
  // tally of how a stored form_state met a live mount, per release, in
  // .web-chat/form-shifts.json. Fed by ws.js's pane:form; read by routes/forms.
  const formShifts = createFormShifts({
    file: projectPaths(paths.root).formShifts,
    version: packageVersion(),
    now: Date.now,
    log: (...a) => console.error('[web-chat]', ...a),
  });
  // The side table (lib/server/domain/side-table, PLAN 2B.2; F-SIDE a): at
  // each commit, the changed answers the reports hold for the committed node,
  // one record set through the element log's one writer. It subscribes here,
  // after the boot's own restore, and stops in stopTurnControls.
  const sideTable = createSideTable({
    graph, bus, reports,
    log: (...a) => console.error('[web-chat]', ...a),
  });
  // The transient marks (lib/server/domain/marks, 2B.2; C6): off the store,
  // on a ws-only frame, carried in hello and reset and cleared by every reset.
  const marks = createMarks({ bus, now: Date.now, redactor });

  const app = express();

  // FIRST of all: the boot on every response (07 C-07.9) — above the Host gate,
  // so a 421 and a 404 name their boot too. Set before any handler runs, so a
  // route's own headers merge with it (the event stream names it again).
  app.use((req, res, next) => { res.setHeader(BOOT_HEADER, bootId); next(); });

  // Then, above every other middleware: the Host gate (lib/core/cors). It sits
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
    setHeaders(res, file, stat) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', `W/"${BUILD}-${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`);
      // The surface page alone: a policy that measures and blocks nothing (U632).
      if (path.basename(file) === 'index.html') res.setHeader('Content-Security-Policy-Report-Only', SURFACE_CSP_REPORT_ONLY);
    },
  }));

  const server = http.createServer(app);
  server.once('listening', () => { const h = setImmediate(() => graph.flushIndex()); if (h && h.unref) h.unref(); });

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
      const draftWritten = writeDraft(draftFile, graph.active, snap);
      // The element log's close record, after the draft (U352): what this
      // graceful stop held, so the next boot counts what it dropped as discarded.
      graph.elements.noteGracefulClose({ live: snap, draftWritten });
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
  //     knows web-chat's own capture token (learnCaptureToken, built at boot
  //     before the graph loads), so text that quotes it is masked like any
  //     secret.
  //   * the audience (§5.4): who is asking, and how much of the mirror they may
  //     see. It follows the mirror opt-in in ~/.web-chat/tunnel/tunnel.json
  //     through the one watch engine, and stops with the server. Handed the
  //     relay credential, it judges a relayed request at the lesser of its
  //     X-WC-Level stamp and the machine's ceiling (04 C-04.10, C-04.11), the
  //     ceiling read and followed from the connector record only in connected
  //     mode (U742).
  const hooks = createHookTap();
  audience = createAudience({
    root: paths.root,
    log: mirrorLog,
    relay,
    connectorRecord: connectorRecordOpt !== undefined ? connectorRecordOpt : process.env.WEB_CHAT_CONNECTOR_RECORD,
  });
  // Who is writing (lib/server/domain/writers, PLAN 1B.4): this boot's writer
  // token, minted here and taught to the redactor, so it is masked like the
  // capture token is; written to .web-chat/writer-token (0600) here, or — with
  // `tokenAtClaim` — by start() right after the portfile claim, so the file
  // follows the daemon that won the portfile (D2). The gate in front of
  // Claude's write routes (routes/writers.js) reads it through resolveWriter;
  // no route is handed the token itself.
  const writers = createWriters({
    paths: projectPaths(paths.root), state, redactor, audience, log: mirrorLog, writeAtConstruction: !tokenAtClaim,
  });

  const wsApi = attachWebSocket(server, {
    state,
    graph,
    paths,
    bus,
    projectName,
    triggerShutdown,
    onViewersChanged: (n) => { if (supervisor) supervisor.setViewers(n); },
    audience,
    relay,
    reports,
    marks,
    redactor,
    formShifts,
    log: mirrorLog,
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
    relay,
    root: paths.root,
    log: mirrorLog,
  });
  // The report path's start seam (U312 registers its answer kind here).
  reports.start();
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
    relay,
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
  // An element pack's approve, by a person, in its card's confirm frame (K.4).
  installPackApprove(control, { root: paths.root, paths, bus, log: mirrorLog });
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
  // delivery is offered to a stopping bridge, and its confirm nets cleared here
  // too, since the bridge's 'stopped' notice reaches it only while a session is
  // attached), the mod's and the session controls' rows and their fill waits,
  // the readings' tap subscription, and the bridge — its long-polls, waiters,
  // pending ops and sweep timer, all synchronously. Idempotent.
  let modLayerStopped = false;
  function stopModLayer() {
    if (modLayerStopped) return;
    modLayerStopped = true;
    const transport = state.messageTransport;
    if (transport) {
      state.messageTransport = null;
      if (typeof transport.stop === 'function') { try { transport.stop(); } catch {} }
    }
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
    try { reports.stop(); } catch {}
    try { sideTable.stop(); } catch {}
    const stops = [settled(() => revert.stop()), settled(() => control.stop()), settled(() => answerSurface.close())];
    try { asks.stop(); } catch {}
    try { projectFiles.stop(); } catch {}
    turnControlsStopped = Promise.all(stops).then(() => {});
    return turnControlsStopped;
  }

  // The mirror's after-listen start (U571): the immediate's handle while it is
  // pending, and whether a teardown has begun (stopMirror sets it).
  let mirrorStartTimer = null;
  let mirrorStopping = false;

  // The one place both teardown paths stop the chat mirror's handles, so
  // neither can forget one: the turn guard (its timers and its subscriptions to
  // the main bus, the hook tap and the mirror), the engine (it flushes its
  // index and clears every timer, watcher and tailer it holds) and the
  // audience's tunnel.json watcher.
  // Each stop() is idempotent, and neither ever rejects here.
  function stopMirror() {
    // The after-listen start (U571), never fired once a teardown has begun.
    mirrorStopping = true;
    if (mirrorStartTimer !== null) { clearImmediate(mirrorStartTimer); mirrorStartTimer = null; }
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
    // An element event — and a comment's, adapted to one (U423) — classifies
    // against its type's wake declaration (K.2-10) through raiseFor below. A
    // send is raised by the queue's sendElement itself, through the same
    // word-reader (state.elementWords), so the subscriber leaves it there and
    // one send raises once.
    const isElement = event && (event.kind === 'element' || event.kind === 'comment');
    if (isElement && event.op === 'send') return;
    const c = isElement
      ? raiseFor(event)
      : classify(event, needsCtx ? { signals: signals.derive(state), routing: signals.deriveRouting(state) } : undefined);
    if (!c) return;
    // `meta.provenance` is the writing socket's origin/device (ws.js → patchStore).
    if (c.action === 'wake') {
      queueDomain.emitWake(bus, [c.item], {
        reason: 'immediate', source: c.item.source, graph, ...queueDomain.provFields(meta && meta.provenance),
      });
    }
    // Every element type, the comment included: dequeue and refresh by
    // element id, inside the item's group (queue domain).
    else if (c.action === 'dequeue' && c.element_id) queueDomain.removeByElement(state, bus, c.element_id);
    // F9: a shared element's words changed — refresh its queued member in
    // place (no-op if it was never queued; refresh never enqueues).
    else if (c.action === 'refresh' && c.element_id) queueDomain.refreshElement(state, bus, c.element_id, c.item);
    // The opt-out activity layer: fold into the mount's rolling activity item.
    else if (c.action === 'coalesce') queueDomain.coalesce(state, bus, c.item);
    // `meta.prior` (a store write's pre-write values — domain/store) lets a
    // signal item remember what its Revert should put back.
    else if (c.item && c.item.kind === 'element') queueDomain.enqueueElement(state, bus, c.item);
    else if (c.item) queueDomain.enqueue(state, bus, c.item, { prior: meta && meta.prior });
  });
  // THE ONE WORD-READER for an element's raise (D-9): an element or comment
  // event → classify's answer under the type's declaration (elementWake), with
  // the item's excerpt set — THE ONE GATE for an item's words (U422, seams §3B
  // (4)): an element item carries the passage its anchor quotes only when
  // elementWake read one, which it does only while the project's excerpt
  // switch is on (lib/core/excerpts). Off, the field is never set. The queue
  // domain's sendElement raises a Send to Claude through the same function
  // (state.elementWords), so a send raises exactly what a share would.
  function raiseFor(event) {
    const type = event.kind === 'comment' ? 'comment' : event.type;
    const decl = elementWake(event, type);
    const c = classify(event, { elementTypes: { [type]: decl } });
    if (c && decl && c.item && c.item.kind === 'element') {
      // The declaration's label rides the item for the queue's group
      // summary (`<label> ×N` once the newest member leaves).
      if (typeof decl.label === 'string' && decl.label.trim()) c.item.label = decl.label.trim();
      if (typeof decl.excerpt === 'string' && decl.excerpt) c.item.excerpt = decl.excerpt;
    }
    return c;
  }
  state.elementWords = (event) => (event && (event.kind === 'element' || event.kind === 'comment') ? raiseFor(event) : null);
  // The excerpt switch, as the delivery-time gate reads it (U423): read from
  // the project's record at each call, never cached, so a host-side
  // `claude-web-chat excerpts on|off` applies with no restart.
  state.excerptsOn = () => excerptsOn(paths.root);
  // The element event's type, as the wake policy reads it (U423):
  // {wake, label, text, replies?, where?, excerpt?}, or null for a type the
  // registry does not list. `wake` is the declaration's one reader's answer
  // (lib/packs/elements wakeOf: null | {coalesce, respond}). The words:
  //   * a COMMENT event (its pin rides the event): where, text and replies
  //     from the pin (policy commentWords: the item, the chain — a member in
  //     the event's ids-only chain_private reads 'a private element', Q8 —
  //     and the section), the excerpt from pin.anchor.quote.exact;
  //   * any other element: the payload field the manifest's summary_key
  //     names (K.2-16), read back through the log's masking view, its
  //     replies when the type responds, and, for a CHAT-family type, `where`
  //     = `on <the record's anchor.label>` (U414's field, masked at read) plus
  //     its chain words under the same Q8 rule (RULED U423@chat-where S4).
  // `excerpt` is the passage the element's anchor quotes (a range anchor, a
  // markdown source record, a chat anchor's bounded quote), masked
  // (redactor.value) and bounded (envelope excerptText) here, at the producer
  // — present only while the excerpt switch is on, the type wakes and the op
  // is not a delete; an anchor with no quote (a page or element anchor, a box
  // grab) gives none.
  function elementWake(event, type = event.type) {
    // Read at call time (ctx is declared below; an element event before the
    // routes exist has no type to read).
    let row = null;
    try {
      const reg = ctx.elementTypes;
      row = reg && typeof reg.descriptor === 'function' ? reg.descriptor(type) : null;
    } catch { row = null; }
    const tb = row && row.toolbar && typeof row.toolbar === 'object' ? row.toolbar : null;
    if (!tb) return null;
    const wake = wakeOf(row);
    const label = typeof tb.label === 'string' ? tb.label : type;
    if (!wake || event.op === 'delete') return { wake, label, text: '' };
    const hidden = Array.isArray(event.chain_private) ? event.chain_private : [];
    const mask = (v) => { try { return typeof v === 'string' ? redactor.value(v) : ''; } catch { return ''; } };
    const on = excerptsOn(paths.root);
    const quoteOf = (anchor) => {
      if (!on) return '';
      try {
        const q = anchor && typeof anchor === 'object' ? anchor.quote : null;
        const exact = q && typeof q === 'object' ? q.exact : null;
        return typeof exact === 'string' ? excerptText(redactor.value(exact)) : '';
      } catch { return ''; }
    };
    if (event.kind === 'comment') {
      const pin = event.pin && typeof event.pin === 'object' ? event.pin : null;
      if (!pin) return { wake, label, text: '' };
      const words = commentWords(pin, hidden);
      const excerpt = quoteOf(pin.anchor) || rootQuoteOf(pin.chain, hidden, quoteOf);
      return { wake, label, ...words, ...(excerpt ? { excerpt } : {}) };
    }
    let rec = null;
    try { rec = graph.elements ? graph.elements.record(event.id, event.v) : null; } catch { rec = null; }
    const out = { wake, label, text: '' };
    if (rec && typeof tb.summary_key === 'string') out.text = mask(rec[tb.summary_key]);
    if (rec && wake.respond && Array.isArray(rec.replies)) {
      out.replies = rec.replies.filter((r) => r && typeof r === 'object').map((r) => ({ author: r.author, text: mask(r.text) }));
    }
    let family = 'page';
    try { family = graph.elements && typeof graph.elements.familyOf === 'function' ? graph.elements.familyOf(type) : 'page'; } catch { family = 'page'; }
    if (family === 'chat') {
      const anchorLabel = rec && rec.anchor && typeof rec.anchor.label === 'string' ? mask(rec.anchor.label).trim() : '';
      const chain = rec ? chainSummary(rec, hidden) : '';
      out.where = [anchorLabel ? `on ${anchorLabel}` : '', chain].filter(Boolean).join(' · ');
    }
    let excerpt = rec ? quoteOf(rec.anchor) : '';
    // A SHARED stroke (U562; lib/core/strokes, lib/core/ink-shape): the
    // group's description — shape, confidence, count and bbox, numbers and
    // a SHAPES word only — composed here from the type's SHARED live members
    // of its stroke group alone, so a private sibling's extent never reaches
    // the item (K.5 J2); a private stroke gets nothing (declarative raises
    // nothing for it). Its excerpt, when its anchor quotes nothing (an
    // element anchor never does), is the text under THIS stroke (its own
    // text_under, stored by the chrome's deriver), through quoteOf's gate:
    // only while the switch is on, masked, cut by excerptText. Each member
    // of a queued group keeps its own excerpt entry (setExcerpts), so the
    // group's block reads the members' passages in order, and an unshared
    // member's passage leaves with its entry. Required here, not at the
    // head, to keep to this branch.
    // The FRAME (tranche 5, 5A.5, U622; DRIFT@beside, RULED U622-U614@drift-
    // field (a)): every group's describe names its frame — lib/core/strokes
    // frameKindOf of the group's newest member's anchor, 'target' | 'pane' |
    // 'page' — so Claude learns when a stroke lies over reflowing content
    // (the measured drift is the overlay's marker's, data-el-drift: the
    // daemon holds no layout). A page group (an arrow, an 'inside' or a
    // 'beside' stroke; grouped by sameTarget's page arm) also names its
    // items, [from.item, to.item] deduped — ids only (DESCRIBE@arrow-ids,
    // U562a's rule) — and hands the item its pageLabel ('from A to B',
    // 'inside A', 'beside A') as `page_label`, which elementItem puts after
    // the type's label. A private stroke still gets nothing (K.5 J2).
    const { isStrokePayload, strokeGroups, frameKindOf, isPageRecord, pageLabel } = require('../core/strokes');
    if (rec && rec.shared === true && event.shared !== false && isStrokePayload(rec)) {
      const { describeOf } = require('../core/ink-shape');
      let shared = [];
      try {
        const live = graph.elements && typeof graph.elements.liveRecords === 'function' ? graph.elements.liveRecords(type) : [];
        shared = live.filter((r) => r && r.shared === true && isStrokePayload(r));
      } catch { shared = []; }
      if (!shared.some((r) => r.id === rec.id)) shared.push(rec);
      const group = strokeGroups(shared).find((g) => g.members.includes(String(rec.id)));
      const members = group ? group.members.map((id) => shared.find((r) => String(r.id) === id)).filter(Boolean) : [rec];
      const d = describeOf(members);
      // The group's shared member ids name the group the describe is of, so a
      // folded item keeps one guess per group (U562a): ids only, no text.
      if (d.count > 0) {
        const newest = members.length ? members[members.length - 1] : rec;
        const anchor = newest && newest.anchor;
        const frame = frameKindOf(anchor);
        const items = isPageRecord(anchor) ? [...new Set([anchor.from.item, anchor.to.item])] : null;
        out.describe = {
          shape: d.shape, confidence: d.confidence, count: d.count, bbox: d.bbox, element_ids: members.map((r) => String(r.id)),
          ...(frame ? { frame } : {}), ...(items ? { items } : {}),
        };
        const at = pageLabel(anchor);
        if (at) out.page_label = at;
      }
      if (!excerpt && on && typeof rec.text_under === 'string' && rec.text_under) {
        try { excerpt = excerptText(redactor.value(describeOf([rec]).text_under)); } catch { excerpt = ''; }
      }
    }
    if (excerpt) out.excerpt = excerpt;
    return out;
  }

  // A chained comment whose own anchor quotes nothing (a pane element, a box
  // grab) takes its chain root's quote (K.2-180 g6, form 7 X4 = a): the
  // chain's first member (U406's comment@2 chain, nearest first), when it is a
  // quote-bearing element (a highlight's range anchor) that is shared — a
  // private root (chain_private, or its record's shared flag) gives none,
  // since Claude's tools are below seesPrivate (U406a). Through the same
  // quoteOf: masked, cut by excerptText, only while the switch is on.
  function rootQuoteOf(chain, hidden, quoteOf) {
    const id = Array.isArray(chain) && typeof chain[0] === 'string' && chain[0] ? chain[0] : null;
    if (!id || hidden.includes(id)) return '';
    let rec = null;
    try {
      const el = graph.elements;
      const newest = el && typeof el.latest === 'function' ? el.latest(id) : null;
      rec = newest && typeof el.record === 'function' ? el.record(id, newest.v) : null;
    } catch { rec = null; }
    if (!rec || rec.shared === false) return '';
    return quoteOf(rec.anchor);
  }

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
    // The writers domain, for the per-service writer credential (U214b).
    writers,
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
    // The same watchers split by peer: ws.js's summary ({local, remote,
    // last_*_at}; a tunnel or relayed socket counts as remote). GET /api/health
    // sends its two counts as viewer_peers to a local request only (06 C-06.24).
    getViewerSummary: wsApi.getViewerSummary,
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
    // The relay credential (lib/server/relay-credential): `connected` (a
    // secret was handed), `valid(req)` and `actorOf(req)`. The actor is
    // attribution only (C-15-3): nothing may key a gate on it.
    relay,
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
    // The writers domain (lib/server/domain/writers): resolveWriter(req, body)
    // says who a write is from.
    writers,
    // The report path (lib/server/domain/reports, 2B.1).
    reports,
    // The transient marks and the side table (2B.2, U313).
    marks,
    sideTable,
    // The element-type registry (lib/server/element-types, PLAN 2C.3): a type
    // lists only from an approved, intact, ledgered record; recomputed on the
    // bus's next `packs` event. Built after seedBuiltins installed the
    // built-in pack.
    elementTypes: createElementTypes({ root, paths, bus }),
    // The local chromes' event-anchor counts (lib/server/ws.js anchorStats,
    // 6C.1 U761): GET /api/elements/anchor-stats answers them to the host.
    anchorStats: wsApi.anchorStats,
  };
  mountHealthRoutes(app, ctx);
  // The writer gate, registered BEFORE the routes it guards (/api/render,
  // /api/markdown, /api/clear): Express runs a path's handlers in order.
  mountWriterRoutes(app, ctx);
  mountRenderRoutes(app, ctx);
  mountPageRoutes(app, ctx);
  mountHistoryRoutes(app, ctx);
  mountPaneSpawnRoutes(app, ctx);
  mountComponentRoutes(app, ctx);
  mountPackRoutes(app, ctx);
  mountStoreRoutes(app, ctx);
  mountEventRoutes(app, ctx);
  mountFormRoutes(app, ctx, { formShifts });
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
  // GET /api/elements/types BEFORE the element routes (U325): their
  // /api/elements/:id would otherwise take `types` for an element id.
  mountElementTypeRoutes(app, ctx);
  // A listed plug-in type's draw.js and assets/ (U511), beside the types
  // route and before the element routes for the same reason.
  mountElementFileRoutes(app, ctx);
  mountElementSearchRoutes(app, ctx);
  // /api/comments answers only its 410 refusal (U327a, COMMENTS@alias b):
  // the comment's routes are the element API's below.
  mountCommentsGone(app);
  // The engine's undo (U518): POST /api/elements/undo, before the element
  // routes so `undo` is never read as an element id.
  mountElementUndoRoutes(app, ctx);
  // The element API (U325): every element type's routes, the comment's included.
  mountElementRoutes(app, ctx);
  mountElementPictureRoutes(app, ctx);
  // A detached glyph's move (U587): POST /api/elements/:id/glyph, its own file.
  mountElementGlyphRoutes(app, ctx);
  // The transient marks' host-only write and read (U313).
  mountMarksRoutes(app, ctx);
  mountThemeRoutes(app, ctx);
  // The toolbar's two records (annotation engine 2D.2): GET /api/toolbar, and
  // PATCH of the project record and of the user record.
  mountToolbarRoutes(app, ctx);
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

  // Arm the engine last, once everything that reads it is in place: the hook tap
  // and the main bus are subscribed now, so an envelope published before the
  // registry has loaded is ingested (ingest loads the registry itself for one),
  // never dropped. The registry load and the sources' start run after the
  // listen (U571, MIRROR@lazy-registry: the boot's figure is the listen alone),
  // from the 'listening' immediate below; until then `mirror.ready` is pending
  // and a chat pin reads `indexing`. start() never rejects (a failure is logged
  // and the routes answer what it holds), and its timers are ref'd: both
  // teardown paths end them (stopMirror).
  mirror.arm();
  // ONE immediate after a successful bind — withServer's direct listen,
  // start()'s fixed port and its 'auto' walk alike (a failed bind never fires
  // 'listening'). A setImmediate, never a call in the handler: 'listening'
  // listeners run before start()'s own listen callback, so a synchronous start
  // would put the registry load back inside the listen. Both teardown paths
  // clear the handle (stopMirror): a server stopped first never starts it.
  server.once('listening', () => {
    if (mirrorStopping) return;
    mirrorStartTimer = setImmediate(() => {
      mirrorStartTimer = null;
      if (!mirrorStopping) mirror.start();
    });
  });
  // The bridge, the control layer and the release scheduler start now, before
  // the listen, and tolerate a mirror that has not loaded: each start only
  // subscribes (the bridge: the hook tap and the mirror, a session's process
  // gone detaching its mod, and its stale sweep; control: the halt-flag sweep,
  // the halt directory only, and kind 'control' on the answer surface, never
  // ensure()d at boot; the scheduler: the bus and the mirror) and none reads the
  // mirror at start. The one decision taken later against an unloaded mirror is
  // queueRelease's for a message sent in that window (about 0.3–0.6 s after a
  // restart): it reads no live session and follows a daemon without a mirror —
  // `unknown`, free, released now (RULED U571@queue-release-gap (a): accepted
  // and named, no hold). None rejects; both teardown paths stop each
  // (stopTurnControls).
  bridge.start();
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
    if (typeof portIsTakenOpt === 'function') return portIsTakenOpt(p);
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
    if (port === 'auto' && firstPort != null) {
      // The walk seam: from firstPort, skipping every reserved port, at most
      // WALK_TRIES candidates and never past 65535.
      let candidate = firstPort;
      let tried = 0;
      while (bound == null && tried < WALK_TRIES && candidate <= 65535) {
        if (isReservedWalkPort(candidate)) { candidate++; continue; }
        tried++;
        if (!(await portIsTaken(candidate)) && await tryListen(candidate)) { bound = candidate; break; }
        candidate++;
      }
      if (bound == null) throw new Error(`no free port found from ${firstPort} (WEB_CHAT_FIRST_PORT; ${tried} tried)`);
    } else if (port === 'auto') {
      let candidate = DEFAULT_FIRST_PORT;
      const maxTries = WALK_TRIES;
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
      // The writer token follows the portfile claim (D2): written now when
      // `tokenAtClaim` held it back, else a no-op over the file construction
      // wrote (re-written only if it names another token).
      writers.publishToken();
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
    // Tranche 6's: the bridge, as ctx.bridge hands it to the routes, the
    // queue's message transport as it stands (tests: null after either
    // teardown path), and the context meter's readings, as ctx.contextReadings
    // hands them to the route (tests: size() 0 after either teardown path).
    get bridge() { return bridge; },
    get messageTransport() { return state.messageTransport || null; },
    get contextReadings() { return contextReadings; },
    // PLAN 1B.6: the daemon's own engines, as getters (never a copy), so a
    // harness reads what the routes read.
    // The audience, as ctx.audience: a test asks it levelOf(req) / remoteLevel().
    get audience() { return audience; },
    // The relay credential, as ctx.relay: connected / valid(req) / actorOf(req)
    // only — it never hands out the secret it holds.
    get relay() { return relay; },
    // The hook tap, as ctx.hooks: a test publishes an envelope in process
    // (U571: one published before the registry has loaded is still ingested).
    get hooks() { return hooks; },
    // The live state the routes write: a test reads state.mounts after a render.
    get state() { return state; },
    // The change bus: a test reads the ring (bus.read) a route emitted on.
    get bus() { return bus; },
    // The turn graph: a test reads graph.active beside GET /api/graph.
    get graph() { return graph; },
    // The writers domain, as ctx.writers: a test asks it resolveWriter(req).
    get writers() { return ctx.writers; },
    // The element store (domain/elements), as graph.elements holds it.
    get elements() { return graph.elements; },
    // The redactor, as ctx.redactor: a test registers a known source on it (U634).
    get redactor() { return redactor; },
    // The report path, as ctx.reports: a test reads its stats() and answers().
    get reports() { return reports; },
    // The transient marks, as ctx.marks: a test reads its sets() and stats().
    get marks() { return marks; },
    // The side table, as ctx.sideTable: a test reads answersFor and stats().
    get sideTable() { return sideTable; },
    // The element-type registry, as ctx.elementTypes.
    get elementTypes() { return ctx.elementTypes; },
    get port() { return server.address() ? server.address().port : null; },
  };
}

// takeRelaySecret rides here so lib/cli/commands/start.js keeps its one
// baselined edge into lib/server (test/dependency-direction.test.js).
module.exports = { createServer, MIRROR_STOP_TIMEOUT_MS, takeRelaySecret };

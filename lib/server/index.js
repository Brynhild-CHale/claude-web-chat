const express = require('express');
const http = require('http');
const path = require('path');
const { resolvePaths } = require('./paths');
const { projectPaths } = require('../core/paths');
const { createState } = require('./state');
const { createBus } = require('../core/bus');
const { createGraph } = require('./graph');
const { loadDraft, writeDraft, lockIsStale, clearLockOnBoot, installLockKeepalive } = require('./domain/turns');
const { attachWebSocket } = require('./ws');
const { createServiceSupervisor } = require('./services');
const { mountRenderRoutes } = require('./routes/render');
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
const { mountCaptureRoutes } = require('./routes/capture');
const { mountProfileRoutes } = require('./routes/profiles');
const { mountVersionRoutes } = require('./routes/version');
const { classify } = require('../channel/policy');
const queueDomain = require('./domain/queue');
const signals = require('./domain/signals');
const { run: runMigrations } = require('../update/migrations');
const { seedBuiltins } = require('./builtins');
const { loadUserProfiles } = require('../capture/profiles');
const { writePortfile, probeReachable } = require('../core/portfiles');
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

function createServer({ root = process.cwd(), port = 'auto' } = {}) {
  const paths = resolvePaths(root);
  const draftFile = projectPaths(root).draft;
  runMigrations(paths.WEB_CHAT_DIR);
  seedBuiltins(paths);
  // Load user-defined capture profiles (project then global dirs) so pickProfile/
  // resolve see them. Resilient — a bad bundle is logged and skipped, never wedges boot.
  loadUserProfiles(paths);

  const state = createState();
  // The change bus owns the event ring + SSE subscribers + WS broadcaster (Phase
  // 2). Built before attachWebSocket so ws.js can register its broadcaster on it.
  // A token unique to THIS daemon process. It rides on every bus event so the
  // channel bridge (which survives daemon restarts in the MCP process) can tell a
  // restart's reset seq space from a same-daemon replay. pid+boot-time is unique
  // per boot (a restart always gets a new pid and a later timestamp).
  const bus = createBus({ bootId: `${process.pid}:${Date.now()}` });
  const graph = createGraph({ paths, state });

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
  app.use(express.static(paths.PUBLIC_DIR));

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
  // drain, the inflight drain and closeServer all have ceilings — so this
  // promise always settles and a signal is never swallowed for good. (The
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

    // End any open event streams first: they'd otherwise pin the inflight drain
    // for its full timeout and then block server.close() indefinitely.
    closeStreams();

    // Wait for a genuinely in-flight turn to finish, but don't block on a lock
    // that's already orphaned (stale) — that would just stall shutdown.
    const lockDeadline = Date.now() + LOCK_DRAIN_TIMEOUT_MS;
    while (graph.lock && !lockIsStale(graph.lock) && Date.now() < lockDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    await waitForInflight();

    try {
      const snap = graph.snapshotLive();
      writeDraft(draftFile, graph.active, snap);
    } catch {}

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
  const wsApi = attachWebSocket(server, {
    state,
    graph,
    paths,
    bus,
    projectName,
    triggerShutdown,
    onViewersChanged: (n) => { if (supervisor) supervisor.setViewers(n); },
  });

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
  bus.subscribe((event) => {
    // Only a browser store write or a delegated dom event needs the (mount-
    // derived) signal/routing context, so derive it lazily — captures classify
    // without it, and every other kind returns null before it's touched.
    const needsCtx = event && (
      (event.kind === 'store' && event.source === 'browser') || event.kind === 'dom'
    );
    const c = classify(event, needsCtx ? { signals: signals.derive(state), routing: signals.deriveRouting(state) } : undefined);
    if (!c) return;
    if (c.action === 'wake') queueDomain.emitWake(bus, [c.item], { reason: 'immediate', source: c.item.source, graph });
    else if (c.action === 'dequeue') queueDomain.removeByComment(state, bus, c.comment_id);
    // F9: a shared pin's text was edited — refresh its queued item's summary in
    // place (no-op if it was never queued; refresh never enqueues).
    else if (c.action === 'refresh') queueDomain.refreshComment(state, bus, c.comment_id, c.item);
    // The opt-out activity layer: fold into the mount's rolling activity item.
    else if (c.action === 'coalesce') queueDomain.coalesce(state, bus, c.item);
    else queueDomain.enqueue(state, bus, c.item);
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
  };
  mountHealthRoutes(app, ctx);
  mountRenderRoutes(app, ctx);
  mountComponentRoutes(app, ctx);
  mountPackRoutes(app, ctx);
  mountStoreRoutes(app, ctx);
  mountEventRoutes(app, ctx);
  mountQueueRoutes(app, ctx);
  mountGraphRoutes(app, ctx);
  mountCommentRoutes(app, ctx);
  mountThemeRoutes(app, ctx);
  mountEmbedRoutes(app, ctx);
  mountEmbedHelperRoutes(app, ctx);
  mountExportRoutes(app, ctx);
  mountCaptureRoutes(app, ctx);
  mountProfileRoutes(app, ctx);
  mountVersionRoutes(app, ctx);

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
      if (wsApi && typeof wsApi.shutdown === 'function') wsApi.shutdown();
      closeStreams(); // else an open SSE response keeps server.close() pending forever
      return new Promise((resolve) => server.close(() => resolve()));
    },
    gracefulShutdown,
    waitForInflight,
    get services() { return supervisor; },
    get port() { return server.address() ? server.address().port : null; },
  };
}

module.exports = { createServer };

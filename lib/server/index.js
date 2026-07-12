const express = require('express');
const http = require('http');
const path = require('path');
const { resolvePaths } = require('./paths');
const { projectPaths } = require('../core/paths');
const { createState } = require('./state');
const { createBus } = require('../core/bus');
const { createGraph } = require('./graph');
const { loadDraft, writeDraft, lockIsStale, clearLockOnBoot } = require('./domain/turns');
const { attachWebSocket } = require('./ws');
const { mountRenderRoutes } = require('./routes/render');
const { mountComponentRoutes } = require('./routes/components');
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
const { classify } = require('../channel/policy');
const queueDomain = require('./domain/queue');
const signals = require('./domain/signals');
const { run: runMigrations } = require('../update/migrations');
const { seedBuiltins } = require('./builtins');
const { loadUserProfiles } = require('../capture/profiles');
const { writePortfile, deletePortfile } = require('../core/portfiles');
const { registerInstance, deregisterInstance } = require('../util/registry');
const { ensureHub } = require('../util/hub');

const LOCK_DRAIN_TIMEOUT_MS = 30_000;
const INFLIGHT_DRAIN_TIMEOUT_MS = 5_000;

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
  if (graph.active) graph.restoreLiveToNode(graph.active, bus);
  else graph.clearLiveMounts();
  loadDraft(draftFile, graph.active, state);

  const app = express();

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

  let shuttingDown = false;
  async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

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

    await new Promise((resolve) => server.close(() => resolve()));
    deletePortfile('server', { root });
    try { deregisterInstance(paths.root); } catch {}
  }

  const projectName = path.basename(paths.root);
  const wsApi = attachWebSocket(server, {
    state,
    graph,
    paths,
    bus,
    projectName,
    triggerShutdown: () => { gracefulShutdown().then(() => process.exit(0)).catch(() => process.exit(1)); },
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
    // Only a browser store write can be a declared signal, so derive the (mount-
    // derived) signal registry lazily — captures classify without it, and every
    // other kind returns null before it's touched.
    const needsSignals = event && event.kind === 'store' && event.source === 'browser';
    const c = classify(event, needsSignals ? { signals: signals.derive(state) } : undefined);
    if (!c) return;
    if (c.action === 'wake') queueDomain.emitWake(bus, [c.item], { reason: 'immediate', source: c.item.source });
    else if (c.action === 'dequeue') queueDomain.removeByComment(state, bus, c.comment_id);
    // F9: a shared pin's text was edited — refresh its queued item's summary in
    // place (no-op if it was never queued; refresh never enqueues).
    else if (c.action === 'refresh') queueDomain.refreshComment(state, bus, c.comment_id, c.item);
    else queueDomain.enqueue(state, bus, c.item);
  });

  const ctx = {
    state,
    bus,
    graph,
    paths,
    // Every producer emits through the one change bus (ctx.bus.emit). The
    // full-state WS snapshot (reset/hello) is the one thing that stays outside
    // the ring — graph routes trigger it via broadcastReset.
    broadcastReset: wsApi.broadcastReset,
    retain: wsApi.retain,
    release: wsApi.release,
    sseClients,
  };
  mountHealthRoutes(app, ctx);
  mountRenderRoutes(app, ctx);
  mountComponentRoutes(app, ctx);
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

  function tryListen(p) {
    return new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('error', onError);
        if (e && e.code === 'EADDRINUSE') resolve(false);
        else reject(e);
      };
      server.once('error', onError);
      try {
        server.listen(p, () => {
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

  function installSignalHandlers() {
    const handler = () => {
      gracefulShutdown().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  }

  async function start({ writePortfile: doWritePortfile = true } = {}) {
    let bound;
    if (port === 'auto') {
      let candidate = 5173;
      const maxTries = 100;
      for (let i = 0; i < maxTries; i++) {
        const ok = await tryListen(candidate);
        if (ok) { bound = candidate; break; }
        candidate++;
      }
      if (bound == null) throw new Error('no free port found in range 5173..' + (5173 + maxTries - 1));
    } else {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off('error', onError); reject(e); };
        server.once('error', onError);
        server.listen(port, () => { server.off('error', onError); resolve(); });
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
      ensureHub().catch(() => {});
      try {
        registerInstance({ root: paths.root, port: bound, pid: process.pid, url: `http://localhost:${bound}`, title: projectName });
      } catch {}
    }

    console.log(`web-chat server listening on http://localhost:${bound}  (active=${graph.active}, nodes=${graph.nodes.size})`);
    return { port: bound };
  }

  return {
    app,
    server,
    start,
    installSignalHandlers,
    stop: () => {
      if (wsApi && typeof wsApi.shutdown === 'function') wsApi.shutdown();
      closeStreams(); // else an open SSE response keeps server.close() pending forever
      return new Promise((resolve) => server.close(() => resolve()));
    },
    gracefulShutdown,
    waitForInflight,
    get port() { return server.address() ? server.address().port : null; },
  };
}

module.exports = { createServer };

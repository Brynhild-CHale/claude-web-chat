const { WebSocketServer } = require('ws');
const { resolveDefault, normalizeTheme } = require('./theme');

const SHUTDOWN_GRACE_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

function attachWebSocket(httpServer, { state, graph, paths, bus, triggerShutdown, projectName }) {
  // The inbound store:set / event / pane:state handlers below emit through the
  // change bus (bus.emit). The WS broadcaster is registered on the bus right
  // after `broadcast` is defined (see bus.setBroadcaster below).
  // Resolved global default theme + the active node's own theme, sent on
  // hello/reset so a (re)connecting client paints the right tokens immediately.
  const globalTheme = () => (paths ? resolveDefault(paths) : { tokens: {} });
  const activeTheme = () => {
    const n = graph.active && graph.nodes.get(graph.active);
    return (n && n.theme) ? normalizeTheme(n.theme) : null;
  };
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  // ws library forwards http server 'error' events to wss; swallow them so port-walk
  // EADDRINUSE doesn't become an uncaught error during retries.
  wss.on('error', () => {});
  const clients = new Set();
  // Non-WS keep-alive holds (e.g. an open SSE event stream). The server stays up
  // while either a browser is connected OR something has retained it.
  let retained = 0;
  let graceTimer = null;
  let heartbeatTimer = null;
  let shuttingDown = false;

  function broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const c of clients) {
      if (c === except) continue;
      if (c.readyState === 1) c.send(s);
    }
  }
  // Late-bind the broadcaster onto the bus so every emit({ws}) reaches the
  // sockets. reset/hello stay full-state-snapshot frames sent directly (they need
  // live mounts/store/active/lock/theme), never through the ring.
  bus.setBroadcaster(broadcast);

  function broadcastReset() {
    broadcast({
      type: 'reset',
      mounts: [...state.mounts.entries()].map(([id, m]) => ({ id, ...m })),
      store: state.store,
      active: graph.active,
      lock: graph.lock,
      theme: globalTheme(),
      activeTheme: activeTheme(),
    });
  }

  function clearGraceTimer() {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function maybeStartGraceTimer() {
    if (shuttingDown) return;
    if (clients.size > 0 || retained > 0) return;
    clearGraceTimer();
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (clients.size === 0 && retained === 0 && !shuttingDown && typeof triggerShutdown === 'function') {
        shuttingDown = true;
        try { triggerShutdown(); } catch {}
      }
    }, SHUTDOWN_GRACE_MS);
  }

  function removeClient(ws) {
    if (!clients.has(ws)) return;
    clients.delete(ws);
    if (clients.size === 0) maybeStartGraceTimer();
  }

  // Keep-alive holds for non-WS consumers (SSE). retain() cancels any pending
  // grace shutdown; release() restarts it only once nothing keeps the server up.
  function retain() { retained++; clearGraceTimer(); }
  function release() {
    retained = Math.max(0, retained - 1);
    if (clients.size === 0 && retained === 0) maybeStartGraceTimer();
  }

  heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== 1) { removeClient(ws); continue; }
      if (ws._isAlive === false) {
        try { ws.terminate(); } catch {}
        removeClient(ws);
        continue;
      }
      ws._isAlive = false;
      try { ws.ping(); } catch {}
      // backup timeout in case pong never arrives — clean up after HEARTBEAT_TIMEOUT_MS
      setTimeout(() => {
        if (ws._isAlive === false && ws.readyState === 1) {
          try { ws.terminate(); } catch {}
          removeClient(ws);
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  wss.on('connection', (ws) => {
    clearGraceTimer();
    clients.add(ws);
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });

    const mounts = [...state.mounts.entries()].map(([id, m]) => ({ id, ...m }));
    ws.send(JSON.stringify({
      type: 'hello',
      store: state.store,
      mounts,
      active: graph.active,
      lock: graph.lock,
      project: projectName,
      theme: globalTheme(),
      activeTheme: activeTheme(),
    }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'store:set') {
        Object.assign(state.store, msg.patch || {});
        bus.emit({
          event: { kind: 'store', patch: msg.patch, source: 'browser' },
          ws: { type: 'store:patch', patch: msg.patch },
          except: ws,
        });
      } else if (msg.type === 'event') {
        bus.emit({ event: { kind: 'dom', ...msg.payload } });
      } else if (msg.type === 'pane:state') {
        const mount = state.mounts.get(msg.id);
        if (!mount) return;
        mount.pane_state = { ...(mount.pane_state || {}), ...(msg.pane_state || {}) };
        bus.emit({
          event: { kind: 'pane', id: msg.id, pane_state: mount.pane_state },
          ws: { type: 'pane:state', id: msg.id, pane_state: mount.pane_state },
          except: ws,
        });
      }
    });
    ws.on('close', () => removeClient(ws));
    ws.on('error', () => removeClient(ws));
  });

  function shutdown() {
    shuttingDown = true;
    clearGraceTimer();
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    for (const ws of clients) {
      try { ws.close(); } catch {}
    }
    clients.clear();
    try { wss.close(); } catch {}
  }

  return { broadcast, broadcastReset, retain, release, wss, clients, shutdown, _maybeStartGraceTimer: maybeStartGraceTimer, _clearGraceTimer: clearGraceTimer };
}

module.exports = { attachWebSocket, SHUTDOWN_GRACE_MS };

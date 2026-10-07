const { WebSocketServer } = require('ws');
const { resolveDefault, normalizeTheme } = require('./theme');
const { verifyUpgrade, isRemoteRequest } = require('../core/cors');
const { projectFrame, stripText, atLeast, FRAME_RULES, TEXT_RULES } = require('../core/remote-policy');
const { createAudience } = require('./audience');
const { patchStore } = require('./domain/store');
const { noteFormBaseline, provenance } = require('./domain/queue');
const { lockView } = require('./domain/turns');
const page = require('./domain/page');

// The page half of a full-surface frame: panes in page order, plus the markdown
// items and the order itself (lib/server/domain/page). A chrome that predates
// markdown ignores the two extra keys and still mounts the panes in page order.
function pageFrameFields(state) {
  return {
    mounts: page.orderedMounts(state).map(([id, m]) => ({ id, ...m })),
    markdown: page.orderedMarkdown(state).map(([id, m]) => ({ id, text: m.text, owner: m.owner })),
    order: state.order.slice(),
    // Claude's baseline order — the chrome's ↺ shows only on a run that is off it.
    claude_order: state.claudeOrder.slice(),
    // Per-run flags ({anchor: {stacks:false}}; empty at the default).
    runs: { ...state.runs },
  };
}

// A browser `event` frame is ONE thing: the shell's delegated pane listener
// reporting a click/change/submit (public/app/mounts.js reportEvent). It is
// rebuilt here from an allowlist, never spread — the frame reaches the change bus,
// and a bus entry's `kind` decides who acts on it: a forged `kind:'wake'` would be
// delivered to Claude as a Push nobody made (with chosen provenance), and a forged
// `seq` would poison the channel bridge's cursor and the ring's gap math. Any pane
// script can open its own socket, and a remote viewer's frames arrive verbatim
// through the portal's relay, so the frame is untrusted input. A frame that is not
// a dom click/change/submit — or that names any other kind — is dropped whole.
const DOM_EVENT_TYPES = new Set(['click', 'change', 'submit']);
const DOM_VALUE_MAX = 4096;
const DOM_DATASET_MAX = 32;
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
function domEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.kind !== undefined && payload.kind !== 'dom') return null;
  if (!DOM_EVENT_TYPES.has(payload.type)) return null;
  let dataset = null;
  if (payload.dataset && typeof payload.dataset === 'object' && !Array.isArray(payload.dataset)) {
    dataset = {};
    for (const [k, v] of Object.entries(payload.dataset).slice(0, DOM_DATASET_MAX)) {
      if (typeof v === 'string') dataset[k.slice(0, 64)] = v.slice(0, 200);
    }
  }
  return {
    type: payload.type,
    mountId: str(payload.mountId),
    tag: str(payload.tag, 32),
    id: str(payload.id),
    name: str(payload.name),
    value: str(payload.value, DOM_VALUE_MAX),
    dataset,
    // written last, so nothing in the payload can set them
    kind: 'dom',
    source: 'browser',
  };
}

const SHUTDOWN_GRACE_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

// ── what each socket may see (the chat mirror's audience, spec §5.4) ────────
// Every socket carries `ws._wc`, set at its connection:
//   remote   the portal's label on its upgrade request (also its pushes'
//            provenance, below)
//   peer     'local' | 'remote' | 'network' — lib/server/audience peerOf
//   level    the mirror level it was last given (its hello, then each
//            mirror:access); audience.socketLevel(ws) is the level now
//   posture  'status', or 'full' while a chat view is open on it: the chrome's
//            `client` frame carries it as `mirror` (public/app/chat-slots.js)
//   starved  mirror:stream frames held back for backpressure; a reset is owed
//
// A frame reaches the sockets one of three ways:
//   * the surface's own frames (render, store, theme, queue, …): today's path,
//     one serialization for every socket, byte for byte as before;
//   * a `mirror:*` frame: per socket, through lib/core/remote-policy
//     projectFrame(frame, level, posture) — the whole frame, its typed `basic`
//     projection, or nothing (null is not sent);
//   * a frame that carries the graph's conversation text (TEXT_RULES.frames:
//     hello, reset, lock, node-added): to a socket below `read`, without that
//     text (stripText).
// A local socket is never projected, which keeps its frames byte-identical
// (test/bus-golden.test.js), and one broadcast serializes each distinct result
// once, however many sockets it goes to.
const FRAME_ROW = new Map(FRAME_RULES.map((r) => [r.type, r]));
const TEXT_FRAMES = new Set(Object.keys(TEXT_RULES.frames));
const isMirrorType = (type) => typeof type === 'string' && type.startsWith('mirror:');
const typeOf = (msg) => (msg && typeof msg === 'object' ? msg.type : undefined);

// One frame's serialization per socket, for one send or one broadcast: call the
// returned function with a socket's level and posture for the string it gets,
// or null. Results are cached first by what decides them — the level, and the
// posture only where the frame's FRAME_RULES row gates on it — and then by the
// result itself, so every level that gets the frame whole shares one string.
function projector(msg) {
  const type = typeOf(msg);
  const mirror = isMirrorType(type);
  const text = !mirror && TEXT_FRAMES.has(type);
  const row = mirror ? FRAME_ROW.get(type) : null;
  const byPosture = !!(row && row.posture);
  const byKey = new Map();
  const byValue = new Map();
  return function frameFor(level, posture) {
    let key = 'whole';
    if (mirror) key = byPosture ? `${level}|${posture}` : level;
    else if (text && !atLeast(level, 'read')) key = 'stripped';
    if (byKey.has(key)) return byKey.get(key);
    let value = msg;
    if (mirror) value = projectFrame(msg, level, posture);
    else if (key === 'stripped') value = stripText('frames', type, msg);
    let s = null;
    if (value != null) {
      s = byValue.get(value);
      if (s === undefined) {
        s = JSON.stringify(value);
        byValue.set(value, s);
      }
    }
    byKey.set(key, s);
    return s;
  };
}

// Backpressure. A socket that cannot keep up — a phone over the tunnel — would
// queue the conversation in this process without bound. Once more than
// STREAM_HOLD_BYTES wait to be written to it, it gets no mirror:stream frames
// (the one high-volume type; the status the bar reads keeps flowing); once what
// waits has drained under STREAM_RESUME_BYTES, it gets one mirror:reset
// {reason:'backpressure'}, after which the chrome reads afresh what it missed,
// and stream frames flow again.
const STREAM_HOLD_BYTES = 4 * 1024 * 1024;
const STREAM_RESUME_BYTES = 256 * 1024;

// `audience` is the server's ctx.audience (lib/server/audience createAudience:
// levelOf, peerOf, socketLevel, onChange). Without one — the server not wired
// yet, a test of something else — every socket is judged with no opt-in: a
// remote viewer gets the heartbeat (narrower, never wider).
function attachWebSocket(httpServer, { state, graph, paths, bus, triggerShutdown, projectName, onViewersChanged, audience: givenAudience }) {
  const audience = givenAudience || createAudience({ configFile: null });
  // Notify a listener (the service supervisor) whenever the connected-browser
  // count changes. Deliberately NOT a bus event: WS reconnect/heartbeat churn
  // must not pollute the event ring or `?since` catch-up. Best-effort.
  const notifyViewers = () => {
    if (typeof onViewersChanged !== 'function') return;
    try { onViewersChanged(clients.size); } catch {}
  };
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
  // Gate the upgrade on Origin. Browsers apply NO same-origin policy to
  // WebSocket connects, and `hello` below is an unconditional full-state
  // disclosure (the whole store — which holds whatever a file-editor pane has
  // open — plus every pane's HTML) sent before the client says anything. Without
  // this, any page the user happens to visit could open ws://localhost:<port>/ws,
  // read all of it, and then write arbitrary store keys back. Ports 5173+ are
  // trivially scannable, so "they'd have to guess the port" is not a defence.
  //
  // An ABSENT Origin means a non-browser client (a local driver process, the
  // CLI, a test) — allowed, since those already have filesystem-level access to
  // everything here. Only a browser asserting a foreign origin is refused.
  //
  // Origin alone is not enough, which is why the gate is verifyUpgrade rather
  // than isLocalOrigin: a page whose DNS is rebound to 127.0.0.1 reaches us
  // SAME-ORIGIN and so sends no Origin at all. verifyUpgrade folds in the Host
  // check the express apps get from requireLocalHost — the upgrade never passes
  // through app.use, so without it this handshake would be the one way around it.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    verifyClient: verifyUpgrade,
  });
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
    const type = typeOf(msg);
    if (!isMirrorType(type) && !TEXT_FRAMES.has(type)) {
      const s = JSON.stringify(msg);
      for (const c of clients) {
        if (c === except) continue;
        if (c.readyState === 1) c.send(s);
      }
      return;
    }
    const frameFor = projector(msg);
    for (const c of clients) {
      if (c === except || c.readyState !== 1) continue;
      deliver(c, type, frameFor);
    }
  }

  // One socket's copy of a projected frame: its level now, its posture, and —
  // for the stream — whether it is keeping up. False when nothing was sent.
  function deliver(c, type, frameFor) {
    const wc = c._wc;
    const s = frameFor(audience.socketLevel(c), (wc && wc.posture) || 'status');
    if (s === null) return false;
    if (type === 'mirror:stream' && holdStream(c)) return false;
    c.send(s);
    return true;
  }

  // One frame to one socket, projected for it exactly as broadcast would.
  function sendTo(ws, frame) {
    if (!ws || ws.readyState !== 1 || !clients.has(ws)) return false;
    return deliver(ws, typeOf(frame), projector(frame));
  }

  // Is this socket's stream held back? It starts being when its backlog passes
  // STREAM_HOLD_BYTES, and stays so until the reset that ends it: a stream frame
  // after a gap would be applied as if nothing were missing.
  function holdStream(c) {
    const wc = c._wc;
    if (!wc) return false;
    if (wc.starved) return true;
    if (c.bufferedAmount <= STREAM_HOLD_BYTES) return false;
    wc.starved = true;
    awaitDrain(c);
    return true;
  }

  // Waits for a held-back socket to drain, with no timer: a ping is queued
  // behind everything already waiting to be written, and its callback runs once
  // it is written — so once what was ahead of it has gone. Still over
  // STREAM_RESUME_BYTES then (more was queued since): wait behind that too. A
  // socket that closes first ends the wait (the callback gets an error).
  function awaitDrain(c) {
    try {
      c.ping(undefined, undefined, (err) => {
        const wc = c._wc;
        if (err || c.readyState !== 1 || !clients.has(c) || !wc || !wc.starved) return;
        if (c.bufferedAmount >= STREAM_RESUME_BYTES) { awaitDrain(c); return; }
        wc.starved = false;
        sendTo(c, { type: 'mirror:reset', reason: 'backpressure' });
      });
    } catch {}
  }

  // A level moved under open sockets: the audience re-read the project's
  // opt-in (its watcher, never a sweep here). Each socket whose level is now
  // different is told — mirror:access, its new level — and the listeners run,
  // so the chrome refetches on an upgrade and purges on a downgrade. A local or
  // network peer's level never moves; only a remote viewer's can.
  const levelListeners = new Set();
  const connectListeners = new Set();
  const lastSeen = { local: null, remote: null, fullRemote: null };
  function relevel() {
    for (const c of clients) {
      const wc = c._wc;
      if (!wc) continue;
      const to = audience.socketLevel(c);
      if (to === wc.level) continue;
      const from = wc.level;
      if (from === 'full' && wc.peer === 'remote') lastSeen.fullRemote = Date.now();
      wc.level = to;
      sendTo(c, { type: 'mirror:access', level: to, remote: wc.remote });
      for (const fn of [...levelListeners]) {
        try { fn(c, from, to); } catch {}
      }
    }
  }
  const offAudience = audience.onChange(relevel);
  // fn(ws, from, to) after a socket's level moved; fn(ws) once a new socket has
  // had its hello. Each returns its unsubscribe. A connect listener pushes no
  // mirror content: the chrome reads what it needs after its hello (C14).
  function onLevelChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onLevelChange: fn must be a function');
    levelListeners.add(fn);
    return () => levelListeners.delete(fn);
  }
  function onConnect(fn) {
    if (typeof fn !== 'function') throw new TypeError('onConnect: fn must be a function');
    connectListeners.add(fn);
    return () => connectListeners.delete(fn);
  }
  // Late-bind the broadcaster onto the bus so every emit({ws}) reaches the
  // sockets. reset/hello stay full-state-snapshot frames sent directly (they need
  // live mounts/store/active/lock/theme), never through the ring.
  bus.setBroadcaster(broadcast);

  function broadcastReset() {
    const pg = pageFrameFields(state);
    broadcast({
      type: 'reset',
      mounts: pg.mounts,
      markdown: pg.markdown,
      order: pg.order,
      claude_order: pg.claude_order,
      runs: pg.runs,
      store: state.store,
      active: graph.active,
      // With `stale` (turns.lockView), like every lock frame: the chrome gates
      // its re-aim buttons on a fresh lock only.
      lock: lockView(graph.lock),
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

  // Who is watching (spec §4.3, the asks domain's `answerable`): the open
  // sockets of each kind of peer, and when each kind was last connected — now
  // while one is open, the close time after. A network peer is neither local
  // nor remote (Q9). `last_full_remote_at` is a remote viewer's at level full.
  // (lastSeen is declared above relevel, which also stamps it.)
  function noteGone(ws) {
    const wc = ws && ws._wc;
    if (!wc) return;
    const t = Date.now();
    if (wc.peer === 'local') lastSeen.local = t;
    else if (wc.peer === 'remote') {
      lastSeen.remote = t;
      if (audience.socketLevel(ws) === 'full' || wc.level === 'full') lastSeen.fullRemote = t;
    }
  }
  function getViewerSummary() {
    const t = Date.now();
    let local = 0;
    let remote = 0;
    let fullRemote = false;
    for (const c of clients) {
      const peer = c._wc && c._wc.peer;
      if (peer === 'local') local += 1;
      else if (peer === 'remote') {
        remote += 1;
        if (audience.socketLevel(c) === 'full') fullRemote = true;
      }
    }
    return {
      local,
      remote,
      last_local_at: local > 0 ? t : lastSeen.local,
      last_remote_at: remote > 0 ? t : lastSeen.remote,
      last_full_remote_at: fullRemote ? t : lastSeen.fullRemote,
    };
  }

  function removeClient(ws) {
    if (!clients.has(ws)) return;
    noteGone(ws);
    clients.delete(ws);
    notifyViewers();
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

  wss.on('connection', (ws, req) => {
    // Push provenance for what this socket writes (a declared `wake:'immediate'`
    // signal wakes Claude straight from a store:set): remote when the portal's
    // relay opened it, the device from the chrome's `client` frame (its phone
    // view), else the User-Agent. See domain/queue provenance.
    const remote = isRemoteRequest(req);
    const userAgent = req && req.headers ? req.headers['user-agent'] : undefined;
    let device = null;
    // What this socket may see of the mirror (above): its level from its
    // upgrade request, and the status posture until its chrome opens a chat.
    ws._wc = { remote, peer: audience.peerOf(req), level: audience.levelOf(req), posture: 'status', starved: false };
    clearGraceTimer();
    clients.add(ws);
    notifyViewers();
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });

    // The full-state snapshot. It carries no mirror content (the chrome reads
    // that after it, C14) — only the lock's text, which TEXT_RULES takes off
    // for a socket below `read`.
    const pg = pageFrameFields(state);
    const hello = {
      type: 'hello',
      store: state.store,
      mounts: pg.mounts,
      markdown: pg.markdown,
      order: pg.order,
      claude_order: pg.claude_order,
      runs: pg.runs,
      active: graph.active,
      lock: lockView(graph.lock),
      project: projectName,
      theme: globalTheme(),
      activeTheme: activeTheme(),
    };
    ws.send(projector(hello)(ws._wc.level, ws._wc.posture));
    for (const fn of [...connectListeners]) {
      try { fn(ws); } catch {}
    }
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'store:set') {
        // `mount` is the writing pane's id and `gesture` marks a user-driven
        // write (the client's per-pane store facade stamps both) — the wake
        // policy uses them for opt-out activity routing and to attribute a
        // declared signal to the pane that actually wrote it.
        patchStore(state, bus, msg.patch, {
          source: 'browser', mount: msg.mount, gesture: msg.gesture, except: ws,
          provenance: provenance({ remote, device, userAgent }),
        });
      } else if (msg.type === 'client') {
        // The chrome's own posture, re-sent on every (re)connect, whenever its
        // phone view flips and whenever a chat view opens or closes
        // (public/app/ws.js): its device, and `mirror` — 'full' while a chat
        // view is open, so the mirror's stream frames are wanted. Absent or
        // anything else is the status posture.
        device = msg.device === 'mobile' || msg.device === 'desktop' ? msg.device : null;
        ws._wc.posture = msg.mirror === 'full' ? 'full' : 'status';
      } else if (msg.type === 'event') {
        const event = domEvent(msg.payload);
        if (event) bus.emit({ event });
      } else if (msg.type === 'script:error') {
        // A pane's inline script threw at mount (runScripts caught it). Ring
        // entry only — no WS rebroadcast (browsers already have their console;
        // this exists so get_events shows the failure to Claude, ending the
        // "declared signal that silently never fires" class of archaeology).
        // Fields are length-capped: the ring is a shared budget.
        bus.emit({
          event: {
            kind: 'script-error',
            id: String(msg.id || ''),
            script_index: Number.isInteger(msg.script_index) ? msg.script_index : null,
            message: String(msg.message || 'unknown error').slice(0, 500),
            ...(msg.stack ? { stack: String(msg.stack).slice(0, 500) } : {}),
            source: 'browser',
          },
        });
      } else if (msg.type === 'pane:form') {
        // Debounced form-value snapshot from a pane (the delegated capture in
        // the shell). REPLACE, not merge — each frame is a full snapshot of the
        // pane's form elements, so a cleared field must not resurrect. The ring
        // event carries key names only (values live on the mount / in get_store
        // territory — fetched, never broadcast into the log wholesale).
        const mount = state.mounts.get(msg.id);
        if (!mount) return;
        // Before the first change of a run, remember what the pane held — the
        // baseline a queue Revert restores (see queue.noteFormBaseline).
        noteFormBaseline(state, mount);
        mount.form_state = { ...(msg.form_state || {}) };
        bus.emit({
          event: { kind: 'pane', op: 'form', id: msg.id, keys: Object.keys(mount.form_state) },
          ws: { type: 'pane:form', id: msg.id, form_state: mount.form_state },
          except: ws,
        });
      } else if (msg.type === 'pane:state') {
        const mount = state.mounts.get(msg.id);
        if (!mount) return;
        // One merge rule (domain/page patchPaneState): a LOCKED pane refuses a
        // move or resize, and rows/heightPx stay in step. A refused patch goes
        // back to the sender too — its local drag already moved the pane, and
        // the authoritative state is what snaps it back.
        const { pane_state, refused } = page.patchPaneState(mount.pane_state, msg.pane_state);
        mount.pane_state = pane_state;
        bus.emit({
          event: { kind: 'pane', id: msg.id, pane_state, ...(refused.length ? { refused } : {}) },
          ws: { type: 'pane:state', id: msg.id, pane_state },
          ...(refused.length ? {} : { except: ws }),
        });
      }
    });
    ws.on('close', () => removeClient(ws));
    ws.on('error', () => removeClient(ws));
  });

  // Sockets we have asked to close POLITELY and are still waiting on. `ws.close()`
  // is a handshake: we send a close frame and the client answers with one. A tab
  // that is wedged, suspended or already gone answers nothing, and its socket
  // stays open — which keeps the daemon's final server.close() pending, because
  // an upgraded socket is out of reach of BOTH closeIdleConnections() (it is not
  // idle) and closeAllConnections() (Node drops a socket from the HTTP server's
  // connection list the moment it is upgraded). So keep the handles: terminate()
  // is the second, decisive phase the bounded shutdown needs.
  let closing = new Set();

  function shutdown() {
    shuttingDown = true;
    clearGraceTimer();
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    // The audience is the server's, and stops with it; the fallback this
    // module made for itself watches nothing, but is stopped here all the same.
    if (typeof offAudience === 'function') offAudience();
    if (!givenAudience) audience.stop();
    closing = new Set(clients);
    for (const ws of clients) noteGone(ws);
    for (const ws of clients) {
      try { ws.close(); } catch {}
    }
    clients.clear();
    try { wss.close(); } catch {}
  }

  // Hang up on whoever did not answer the close frame. Called only once
  // shutdown()'s grace has elapsed — the polite close is what a live browser
  // gets, this is what an unresponsive one gets.
  function terminate() {
    for (const ws of closing) {
      try { ws.terminate(); } catch {}
    }
    closing.clear();
  }

  return {
    broadcast, broadcastReset, sendTo, getViewerSummary, onConnect, onLevelChange,
    retain, release, wss, clients, shutdown, terminate,
    _maybeStartGraceTimer: maybeStartGraceTimer, _clearGraceTimer: clearGraceTimer,
  };
}

module.exports = { attachWebSocket, SHUTDOWN_GRACE_MS, STREAM_HOLD_BYTES, STREAM_RESUME_BYTES, domEvent };

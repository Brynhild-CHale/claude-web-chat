// The channel bridge — the wake-primitive CONSUMER, and the quarantine for the
// experimental Claude Code channel wire contract.
//
// It runs in the MCP subprocess (the only long-lived logic there): it holds a
// live SSE subscription to the daemon's bus filtered to `kinds:['wake']`, and
// for each `wake` event fires EXACTLY ONE `notifications/claude/channel` with the
// sanitized envelope. Nothing else in the bridge pushes — so "what wakes Claude"
// is decided entirely by "who emits `wake`" on the server (queue flush + declared
// immediate signals, via lib/server/domain/queue.emitWake).
//
// `notify` is INJECTED so the one experimental method call lives behind a single
// seam: prod passes `server.notification.bind(server)` (the MCP SDK), tests pass
// a fake sink. If the wire contract churns, only this file and envelope.js move.
//
// Discipline:
//   * Lazy connect + capped-backoff reconnect. NEVER force-spawns the daemon —
//     subscribeSSE discovers the port from the portfile; if the daemon isn't up
//     yet (MCP started before any tool call spawned it), we just back off and
//     retry until it appears.
//   * Cursor + dedupe. `wake` events carry monotonic ring seqs (no capture-style
//     override), so a seq cursor is a sound dedupe: on reconnect we resume with
//     `?since=lastSeq` and skip anything already delivered — BUT the seq space is
//     per-boot, so the cursor is chosen against the daemon's live boot token
//     (fetched from /api/health at connect), full-replaying instead of resuming
//     when the daemon restarted while we were away.
//   * A dropped wake must never wedge anything (R1): the bridge is stateless
//     beyond its cursor; a missed wake is just a missed notification.
//   * The ack follows the SEND, not the call. `notify` is async (the SDK's
//     Protocol.notification is), so its failures arrive as rejections; the ack
//     POST waits for it to settle and is skipped when it rejects.

const { wakeEnvelope } = require('./envelope');

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
// Liveness heartbeat cadence. The daemon treats a wake-consumer as gone once its
// heartbeat is staler than CONSUMER_TTL_MS (25s) — so ~10s gives 2.5 beats of
// slack before a live channel is declared dead.
const HEARTBEAT_MS = 10_000;

function startChannelBridge({ notify, client, root, log = () => {} } = {}) {
  if (typeof notify !== 'function') throw new Error('startChannelBridge requires a notify function');
  const sse = (client && client.subscribeSSE) || require('../client').subscribeSSE;
  const get = (client && client.get) || require('../client').get;
  const post = (client && client.post) || require('../client').post;

  let stopped = false;
  let handle = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let backoff = BACKOFF_MIN_MS;
  // Highest wake seq delivered. Doubles as the reconnect cursor. Starts at 0 so
  // the FIRST connect is live-only (no replay of pre-session wakes); after that a
  // reconnect resumes from where we left off.
  let lastSeq = 0;
  // The daemon boot the cursor belongs to. The bridge outlives daemon restarts
  // (it lives in the MCP process), but each restart resets the daemon's seq space
  // to 1 — so a cursor from the previous boot would drop every new wake as a
  // phantom replay. We drop the stale cursor when the token changes: at connect
  // (fetchBoot, before choosing `since`) and defensively in deliver() (should a
  // token ever change within a live stream).
  let lastBoot = null;
  // Serializer for the post-send acks (see deliver): each one waits for its own
  // notify to settle, and for the previous ack, so the delivery trail the rail
  // reads stays in wake order.
  let acks = Promise.resolve();

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  // Liveness heartbeat — POSTed only while a wake stream is actually open (started
  // in onOpen, stopped in onClose), so the daemon's last-seen goes stale the
  // moment the stream drops or the process dies. Best-effort: a failed POST just
  // means the next flush parks (the safe outcome), so failures are swallowed.
  function sendHeartbeat() {
    Promise.resolve(post('/api/channel/heartbeat', {}, { root })).catch(() => {});
  }
  function startHeartbeat() {
    if (heartbeatTimer) return;
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function deliver(event) {
    if (!event || event.kind !== 'wake') return; // defensive; server already filters
    // Daemon-restart detection: a new boot token means the seq space reset, so the
    // old cursor is meaningless — drop it before the dedupe below, or every wake
    // from the fresh daemon (seq restarting at 1) would look like a replay.
    if (event.boot != null && event.boot !== lastBoot) { lastBoot = event.boot; lastSeq = 0; }
    // Cursor dedupe: skip anything at or below the last delivered seq (a replay
    // after reconnect, or a stray double-delivery).
    if (typeof event.seq === 'number') {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
    }
    let payload;
    try {
      payload = wakeEnvelope(event.batch, { reason: event.reason, source: event.source, seq: event.seq, note: event.note });
    } catch (e) {
      log(`channel: envelope build failed: ${(e && e.message) || e}`);
      return;
    }
    // The send is INVOKED synchronously (the SDK's transport writes in call
    // order, so invocation order is wire order and two wakes cannot cross), but
    // it COMPLETES asynchronously: Protocol.notification is `async`, so a closed
    // transport or a failed stdout write is a rejected promise, never a throw.
    // Acking on the synchronous return therefore confirmed delivery of a send
    // that had not happened yet — and the daemon's ackWake clears the retained
    // batch on an ack, which is the one thing the retain/park machinery exists to
    // prevent. So the ack waits for the send to settle and is SKIPPED on
    // rejection, leaving the rail to time out and offer retry.
    let sent;
    try {
      sent = notify('notifications/claude/channel', payload);
    } catch (e) {
      log(`channel: notify failed: ${(e && e.message) || e}`);
      return;
    }
    // Acks queue behind one another so ack(n) can never overtake ack(n-1).
    const seq = event.seq;
    const boot = event.boot;
    acks = acks
      .then(() => sent)
      .then(() => {
        // Best-effort POST (correlated by the wake's seq + boot); a failed ack
        // just costs the user a retry, never worse.
        if (typeof seq === 'number') {
          return Promise.resolve(post('/api/channel/ack', { seq, boot }, { root })).catch(() => {});
        }
        return undefined;
      })
      .catch((e) => { log(`channel: notify failed: ${(e && e.message) || e}`); });
  }

  // Learn the daemon's CURRENT boot token before opening the stream. Resolves to
  // the token, or null if the daemon answers but predates the field; rejects if
  // the daemon is unreachable (→ back off, same as a failed connect). NEVER
  // force-spawns — get() discovers the port from the portfile only.
  function fetchBoot() {
    return get('/api/health', { root }).then((h) => (h && h.boot != null ? h.boot : null));
  }

  function open(since) {
    handle = sse({
      root,
      kinds: ['wake'],
      since,
      onOpen: () => { backoff = BACKOFF_MIN_MS; startHeartbeat(); log('channel: wake stream connected'); },
      onEvent: deliver,
      onGap: (g) => { log(`channel: wake stream gap (dropped ${g && g.dropped})`); },
      onError: (err) => { log(`channel: wake stream error: ${(err && err.message) || err}`); },
      onClose: () => { stopHeartbeat(); if (!stopped) scheduleReconnect(); },
    });
  }

  // The reconnect cursor MUST be chosen against the daemon's live boot token:
  // if the daemon restarted during the backoff window its seq
  // space reset to 1, so resuming from the previous boot's `lastSeq` makes the
  // fresh daemon filter every new wake (`seq > lastSeq` is false) and a wake
  // emitted during the reconnect is silently lost — deliver()'s boot reset only
  // runs once an event arrives, i.e. after it was already filtered out. So we
  // fetch the boot FIRST, then pick `since`.
  function connect() {
    if (stopped) return;
    fetchBoot().then((boot) => {
      if (stopped) return;
      let since;
      if (boot != null && lastBoot != null && boot !== lastBoot) {
        // Restarted daemon: the old cursor points into a dead numbering. Full
        // replay from the fresh ring (since:0) + drop the cursor, so a wake
        // emitted during the backoff is redelivered.
        lastBoot = boot;
        lastSeq = 0;
        since = 0;
      } else {
        // First connect (lastSeq 0 → undefined: live-only, no pre-session replay),
        // same-boot reconnect (since:lastSeq dedupes the replay), or a boot-less
        // daemon (degrade to the plain cursor — deliver() still guards seqs).
        if (boot != null) lastBoot = boot;
        since = lastSeq || undefined;
      }
      open(since);
    }).catch((e) => {
      log(`channel: boot probe failed: ${(e && e.message) || e}`);
      if (!stopped) scheduleReconnect();
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      stopHeartbeat();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (handle && handle.close) { try { handle.close(); } catch {} }
    },
  };
}

module.exports = { startChannelBridge, BACKOFF_MIN_MS, BACKOFF_MAX_MS };

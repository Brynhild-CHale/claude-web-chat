const queue = require('../domain/queue');

const SSE_HEARTBEAT_MS = 15_000;

function mountEventRoutes(app, { state, bus, graph, retain, release, sseClients }) {
  // Server-Sent Events stream of the live event log — a latency upgrade over
  // polling GET /api/events. Push tap = bus.subscribe (fed by bus.emit).
  //
  // Query: ?since=<seq> replays buffered events after that seq before going live;
  // ?kinds=a,b filters to those event kinds. Reconnecting EventSource clients
  // send Last-Event-ID automatically → used as the catch-up cursor when ?since
  // is absent. A `gap` event is emitted (mirroring GET /api/events) when the
  // cursor predates the oldest retained event, so the consumer knows to resync.
  app.get('/api/events/stream', (req, res) => {
    const sinceQ = parseInt(req.query.since, 10);
    const lastId = parseInt(req.headers['last-event-id'], 10);
    const since = Number.isFinite(sinceQ) ? sinceQ : (Number.isFinite(lastId) ? lastId : null);
    const kinds = req.query.kinds ? String(req.query.kinds).split(',').filter(Boolean) : null;
    const pass = (e) => !kinds || kinds.includes(e.kind);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeat proxy buffering so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    // An SSE consumer (a driver, or Claude watching) should keep the server
    // alive even with no browser tab open — otherwise the grace timer would
    // shut it down out from under the stream.
    if (typeof retain === 'function') retain();
    if (sseClients) sseClients.add(res);
    // A stream that EXPLICITLY filters for `wake` is the channel bridge (it
    // subscribes with kinds:['wake']). We require the explicit filter — an
    // all-kinds driver stream is not a channel and must not make the "what wakes
    // Claude" panel claim a live channel.
    const isWakeConsumer = Array.isArray(kinds) && kinds.includes('wake');
    // Stamp liveness at connect so channelLive is true immediately (before the
    // bridge's first heartbeat POST arrives); the heartbeat then keeps it fresh.
    if (isWakeConsumer) { state.wakeConsumers++; state.wakeConsumerSeenAt = Date.now(); }
    let closed = false;

    const send = (e) => {
      if (closed) return;
      res.write(`id: ${e.seq}\nevent: ${e.kind || 'message'}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    // Catch-up + gap detection. This handler runs synchronously to completion
    // (no awaits), so no event can be pushed between the replay and the
    // subscribe below — no dup, no miss. bus.read is the one gap/catch-up impl
    // (shared with GET /api/events); it filters by kind and computes gap off the
    // full ring's oldest, matching the pre-bus behavior.
    if (since != null) {
      const { events, gap, dropped, oldest } = bus.read({ since, kinds });
      if (gap) res.write(`event: gap\ndata: ${JSON.stringify({ gap: true, dropped, oldest, since })}\n\n`);
      for (const e of events) send(e);
    }

    const unsub = bus.subscribe((e) => { if (pass(e)) send(e); });

    // Path B: a wake pushed while no channel was connected is PARKED.
    // The first wake-consumer (the channel bridge) to connect drains it into a real
    // wake event, delivered to THIS stream via the live fan-out just registered — so
    // it lands regardless of the catch-up cursor. drainPending clears the park before
    // emitting, and this handler has no awaits, so a simultaneous turn-begin hook
    // consume (path A) finds nothing (its id check no-ops). Only the FIRST connecting
    // consumer sees a non-null park; a second connect finds it already drained.
    if (isWakeConsumer && state.pendingWake) queue.drainPending(state, bus, graph);

    const hb = setInterval(() => { if (!closed) res.write(`: ping ${Date.now()}\n\n`); }, SSE_HEARTBEAT_MS);
    if (hb.unref) hb.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      unsub();
      if (sseClients) sseClients.delete(res);
      if (isWakeConsumer) state.wakeConsumers = Math.max(0, state.wakeConsumers - 1);
      if (typeof release === 'function') release();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.get('/api/events', (req, res) => {
    const since = parseInt(req.query.since || '0', 10);
    // The event log is a ring buffer (bus MAX_EVENTS). If the caller's cursor
    // predates the oldest still-retained event, the events in between were
    // silently evicted; bus.read flags that (gap/dropped) so a watcher knows to
    // resync from a full get_store/get_graph snapshot instead of trusting an
    // incomplete catch-up.
    res.json(bus.read({ since }));
  });

  app.post('/api/wait', async (req, res) => {
    const { predicate = {}, timeout_ms = 30000 } = req.body || {};
    const start = Date.now();
    const matchPred = () => {
      if (predicate.store_key) {
        const v = state.store[predicate.store_key];
        if ('equals' in predicate) return v === predicate.equals ? { matched: 'store', key: predicate.store_key, value: v } : null;
        if ('exists' in predicate) return ((v !== undefined) === predicate.exists) ? { matched: 'store', key: predicate.store_key, value: v } : null;
      }
      if (predicate.event_kind) {
        const startSeq = predicate.since_seq ?? 0;
        for (const e of bus.events) {
          if (e.seq <= startSeq) continue;
          if (e.kind !== predicate.event_kind) continue;
          const m = predicate.match || {};
          if (Object.entries(m).every(([k, v]) => e[k] === v)) return { matched: 'event', event: e };
        }
      }
      return null;
    };
    while (Date.now() - start < timeout_ms) {
      const m = matchPred();
      if (m) return res.json({ ok: true, ...m });
      await new Promise(r => setTimeout(r, 100));
    }
    res.json({ ok: false, timeout: true });
  });
}

module.exports = { mountEventRoutes };

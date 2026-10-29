const queue = require('../domain/queue');
const { atLeast, stripText, stripItemText, stripWakeText } = require('../../core/remote-policy');
const { createAudience } = require('../audience');

const SSE_HEARTBEAT_MS = 15_000;
const RING_ROUTE = 'GET /api/events';

function mountEventRoutes(app, ctx) {
  const { state, bus, graph, retain, release, sseClients } = ctx;
  // ── The ring below `read` (K.2-117) ──
  // RULES keeps these routes host-only for a remote viewer, but a peer on a
  // WEB_CHAT_HOST bind reaches the daemon itself at `basic` (Q9), and a comment
  // entry carries its whole pin: the anchor's excerpt and fingerprint, the
  // note and its replies. Below `read` every entry the ring hands out — GET
  // /api/events, the stream's catch-up and live events, /api/wait's matched
  // event — goes through TEXT_RULES.routes['GET /api/events'], the graph
  // routes' shape (graph.js textFor). A queue item an entry carries (a `queue`
  // entry's `item`, a `wake` entry's `batch`) goes through stripItemText at the
  // request's level too, as GET /api/queue reads it (K.2-126): a comment's or
  // a highlight's quoted note becomes its text-free label, and a wake batch's
  // message is its publicItem with `text_hidden`. A `wake` entry's own note —
  // the Push note, the user's text (J1, K1) — goes through stripWakeText
  // (TEXT_RULES.entries): below `read` it is gone and the entry says
  // `note_hidden`. A local request (and one at
  // `read` or `full`) is never projected. ctx.audience is read per request;
  // until the server hands one over a request is judged with no opt-in
  // (narrower, never wider), and a level that cannot be read is basic.
  const noOptIn = createAudience({ configFile: null });
  const levelFor = (req) => {
    try { return (ctx.audience || noOptIn).levelOf(req); } catch { return 'basic'; }
  };
  const readsText = (level) => atLeast(level, 'read');
  const isHost = (req) => {
    try { return (ctx.audience || noOptIn).isHost(req) === true; } catch { return false; }
  };
  // A `queue` entry's item is already the domain's publicItem (a message's
  // words never ride the ring); a `wake` entry's batch holds the whole items
  // (queue.list's projection, item by item).
  const batchItemFor = (level, it) => (queue.isMessage(it)
    ? { ...queue.publicItem(it), text_hidden: true }
    : stripItemText(it, level));
  const queueTextFor = (level, e) => {
    if (!e || typeof e !== 'object') return e;
    if (e.kind === 'queue' && e.item && typeof e.item === 'object') {
      const item = stripItemText(e.item, level);
      return item === e.item ? e : { ...e, item };
    }
    if (e.kind === 'wake') {
      const w = stripWakeText(e, level);
      return Array.isArray(w.batch) ? { ...w, batch: w.batch.map((it) => batchItemFor(level, it)) } : w;
    }
    return e;
  };
  // ── A ring entry's pin through the read view (U415c; D4, C-13) ──
  // A `comment` (or `element`) entry carries the pin as it was at the write,
  // so a value the redactor learned since would ride get_events back to
  // Claude. Every entry the ring hands any reader, local ones included, takes
  // its `pin` through the element store's read view (graph.elements.maskPins:
  // the text, the replies and the anchor through the redactor now, the pinned
  // words and their context through the context mask) at serve; the ring's
  // stored entry is unchanged. A mask that throws or answers out of shape
  // fails closed: the pin keeps only its id and shared flag (what the
  // dequeue path reads).
  const pinView = (e) => {
    if (!e || typeof e !== 'object' || (e.kind !== 'comment' && e.kind !== 'element')) return e;
    const pin = e.pin;
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return e;
    const store = graph && graph.elements;
    if (!store || typeof store.maskPins !== 'function') return e;
    let out = null;
    try { out = store.maskPins([pin]); } catch { out = null; }
    const masked = Array.isArray(out) && out.length === 1 && out[0] && typeof out[0] === 'object' ? out[0] : { id: pin.id, shared: pin.shared };
    return { ...e, pin: masked };
  };
  // A `queue` entry's item and a `wake` entry's batch quote a pin's words as
  // they were queued: through the redactor now, at every level (K.2-182 g10;
  // the domain's servedItem); the ring's stored entry is unchanged.
  const queueView = (e) => {
    if (!e || typeof e !== 'object') return e;
    if (e.kind === 'queue' && e.item && typeof e.item === 'object') return { ...e, item: queue.servedItem(e.item, ctx.redactor) };
    if (e.kind === 'wake' && Array.isArray(e.batch)) return { ...e, batch: e.batch.map((it) => queue.servedItem(it, ctx.redactor)) };
    return e;
  };
  const ringFor = (level, raw) => {
    const body = raw && Array.isArray(raw.events) ? { ...raw, events: raw.events.map((e) => queueView(pinView(e))) } : raw;
    if (readsText(level)) return body;
    const out = stripText('routes', RING_ROUTE, body);
    if (!out || !Array.isArray(out.events)) return out;
    return { ...out, events: out.events.map((e) => queueTextFor(level, e)) };
  };
  const entryFor = (level, e) => ringFor(level, { events: [e] }).events[0];
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
    const level = levelFor(req);

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
    //
    // Except a stream that asks ONLY for `control` events (spec §15.2, ruling
    // B3 (a)): the Esc injector of every tty-capable session holds one for the
    // session's whole life (lib/mcp/interrupt.js), and a Stop needs a browser
    // on the page anyway, which keeps the daemon up itself. It never counted as
    // a wake consumer either. It stays in sseClients, so shutdown still closes it.
    const holdsDaemon = !(Array.isArray(kinds) && kinds.length > 0 && kinds.every((k) => k === 'control'));
    if (holdsDaemon && typeof retain === 'function') retain();
    if (sseClients) sseClients.add(res);
    // A stream that EXPLICITLY filters for `wake` is the channel bridge (it
    // subscribes with kinds:['wake']). We require the explicit filter — an
    // all-kinds driver stream is not a channel and must not make the "what wakes
    // Claude" panel claim a live channel. It must also be the host's own request
    // (audience isHost, judged per request as readsText is; K.2-128): any other
    // kinds=wake stream still receives the wake events as the text rules leave
    // them, but never counts, never stamps liveness and never drains the park.
    const isWakeConsumer = Array.isArray(kinds) && kinds.includes('wake') && isHost(req);
    // Stamp liveness at connect so channelLive is true immediately (before the
    // bridge's first heartbeat POST arrives); the heartbeat then keeps it fresh.
    if (isWakeConsumer) { state.wakeConsumers++; state.wakeConsumerSeenAt = Date.now(); }
    let closed = false;

    const send = (e) => {
      if (closed) return;
      res.write(`id: ${e.seq}\nevent: ${e.kind || 'message'}\ndata: ${JSON.stringify(entryFor(level, e))}\n\n`);
    };

    // Catch-up + gap detection. This handler runs synchronously to completion
    // (no awaits), so no event can be pushed between the replay and the
    // subscribe below — no dup, no miss. bus.read is the one gap/catch-up impl
    // (shared with GET /api/events); it filters by kind and computes gap off the
    // full ring's oldest, matching the pre-bus behavior.
    if (since != null) {
      const { events, gap, dropped, oldest, reset } = bus.read({ since, kinds });
      // `reset` distinguishes the two discontinuities: the ring evicted events the
      // cursor needed (dropped counts them), or the daemon restarted and the seq
      // space began again below the cursor (dropped is unknowable). A reconnecting
      // EventSource sends Last-Event-ID from the PREVIOUS boot, so this is the
      // common case after `claude-web-chat restart`.
      if (gap) res.write(`event: gap\ndata: ${JSON.stringify({ gap: true, dropped, oldest, since, ...(reset ? { reset: true } : {}) })}\n\n`);
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
    //
    // Unconditional (drainPending no-ops with nothing parked): its FIRST act is to
    // fold a still-retained in-flight wake into the park, which is the whole reason
    // it runs on reconnect. Guarding the call on state.pendingWake skipped that fold
    // in precisely the scenario it was written for — a live push retained awaiting
    // an ack, the bridge's stream dies, nothing parked behind it — leaving the wake
    // to sit until the 20s backstop aged it out onto the user's next prompt.
    if (isWakeConsumer) queue.drainPending(state, bus, graph);

    const hb = setInterval(() => { if (!closed) res.write(`: ping ${Date.now()}\n\n`); }, SSE_HEARTBEAT_MS);
    if (hb.unref) hb.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      unsub();
      if (sseClients) sseClients.delete(res);
      if (isWakeConsumer) state.wakeConsumers = Math.max(0, state.wakeConsumers - 1);
      if (holdsDaemon && typeof release === 'function') release();
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
    res.json(ringFor(levelFor(req), bus.read({ since })));
  });

  app.post('/api/wait', async (req, res) => {
    const { predicate = {}, timeout_ms = 30000 } = req.body || {};
    const start = Date.now();
    const level = levelFor(req);
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
          if (Object.entries(m).every(([k, v]) => e[k] === v)) return { matched: 'event', event: entryFor(level, e) };
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

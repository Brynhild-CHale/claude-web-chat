// HTTP surface for the wake queue. The rail reads
// GET /api/queue and folds the `queue` WS frames; the P affordance POSTs
// /api/queue/push; per-item remove DELETEs. All state lives on `state.queue`;
// the domain (lib/server/domain/queue) owns the mutations + bus emits.

const queue = require('../domain/queue');
const signals = require('../domain/signals');
const { LAUNCH_COMMAND } = require('../../core/channels');

// Parked-delivery copy — server-sent so the rail
// notice and the push confirmation read one source of truth. PARKED_CONFIRM is the
// moment-of-push confirmation (says WHEN, not just "pushed" — wording
// load-bearing); PARKED_NOTICE is the standing "no channel connected" explanation.
const PARKED_CONFIRM = 'Pushed — delivers with your next message.';
const PARKED_NOTICE = 'A Push here is held and delivered with your next message.';

function mountQueueRoutes(app, { state, bus, graph }) {
  app.get('/api/queue', (req, res) => {
    res.json({ items: queue.list(state), count: state.queue.length });
  });

  // The "what wakes Claude" contract, made visible.
  // The panel in the shell reads this: whether a channel is actually connected,
  // what auto-enqueues, and the live declared signals split by wake mode.
  app.get('/api/queue/policy', (req, res) => {
    const reg = signals.derive(state);
    const split = { immediate: [], queue: [] };
    for (const [key, s] of Object.entries(reg)) {
      split[s.wake === 'immediate' ? 'immediate' : 'queue'].push({ key, mount: s.mount, why: s.why });
    }
    res.json({
      channel_connected: state.wakeConsumers > 0,
      queue_count: state.queue.length,
      // Captures always fold into the queue; wake is user-triggered (Push).
      captures_enqueue: true,
      wake_trigger: 'push',
      immediate_signals: split.immediate,
      queue_signals: split.queue,
      // The opt-OUT activity layer: undeclared pane interactions (dom events +
      // undeclared browser store writes) coalesce into one rolling item per
      // mount by default; these panes opted out (params.routing / service-owned).
      activity_default: 'coalesce',
      activity_opted_out: Object.entries(signals.deriveRouting(state))
        .filter(([, v]) => v === 'none').map(([id]) => id),
      // B8: the activation guidance rides the policy response so the rail notice
      // renders server-sent text instead of a hardcoded incantation in index.html.
      activation_hint: {
        title: 'Channels not enabled',
        body: "Push won't wake Claude — this session isn't running the Channels capability. Items still collect here; restart Claude Code with:",
        // The one launch incantation lives in lib/core/channels;
        // install's checklist reuses it so the string is never forked.
        command: LAUNCH_COMMAND,
      },
      // The parked-delivery mode line — with channels off, a Push is held and
      // delivered on the user's next message (not woken). The rail renders this.
      parked_delivery: PARKED_NOTICE,
    });
  });

  // Push → Claude: flush the STAGED items into ONE wake (held items stay). The
  // wake's seq lets a caller (smoke script, test) correlate. `reason`/`source` are
  // optional overrides; `note` is the free-text comment/batch context.
  app.post('/api/queue/push', (req, res) => {
    const { reason, source, note } = req.body || {};
    // `graph` rides along so a live-delivered wake locks the turn it starts
    // (turn-begin-on-push); a parked flush stays lock-less — its delivery is the
    // user's next prompt, whose turn-begin hook locks normally.
    const { batch, wake, parked } = queue.flush(state, bus, { reason, source, note, graph });
    // With no channel connected the flush PARKS instead of waking. Stay
    // 2xx/ok:true either way so the client clears its staged rows + note on success
    // (the success-clears-staging contract); `mode` tells the rail which happened.
    if (parked) {
      return res.json({ ok: true, pushed: batch.length, mode: 'parked', pending_id: parked.id, delivers: PARKED_CONFIRM });
    }
    res.json({ ok: true, pushed: batch.length, mode: 'wake', seq: wake ? wake.seq : null });
  });

  // Path A: the turn-begin hook reads the parked wake and injects its summary
  // as context on the user's next prompt. Returns the SUMMARY envelope only — bodies
  // stay fetched by tool call (get_captures/get_store) per the envelope contract.
  app.get('/api/queue/pending', (req, res) => {
    const p = state.pendingWake;
    res.json({ pending: p ? { id: p.id, created_at: p.created_at, envelope: p.envelope, note: p.note } : null });
  });

  // Consume the park after the hook delivered it. Id-checked (a stale id — e.g. a
  // re-push merged into a fresh park, or path B drained first — no-ops) so path A/B
  // can't double-deliver.
  app.post('/api/queue/pending/consume', (req, res) => {
    const { id } = req.body || {};
    const consumed = queue.consumePending(state, id);
    res.json({ ok: true, consumed });
  });

  // Stage / unstage an item. `{staged:false}` holds it back; `true`
  // re-stages. Held items persist in the queue but aren't sent on Push.
  app.patch('/api/queue/:id', (req, res) => {
    const { staged } = req.body || {};
    // setStaged applies the staged-default coercion once (C5) — pass the raw value.
    const it = queue.setStaged(state, bus, req.params.id, staged);
    if (!it) return res.status(404).json({ ok: false, error: 'queue item not found' });
    res.json({ ok: true, id: it.id, staged: it.staged });
  });

  // Remove one item. `?revert=1` also removes its web-chat artifact (a comment's
  // pin, or a capture/signal's origin pane).
  app.delete('/api/queue/:id', (req, res) => {
    const revert = req.query.revert === '1' || req.query.revert === 'true';
    const result = queue.remove(state, bus, req.params.id, { revert });
    if (!result) return res.status(404).json({ ok: false, error: 'queue item not found' });
    // B1: report the DOMAIN-computed `reverted`, not the request flag — a Revert on
    // an item whose artifact is already gone reverts nothing.
    res.json({ ok: true, removed: result.removed.id, reverted: result.reverted, count: state.queue.length });
  });
}

module.exports = { mountQueueRoutes };

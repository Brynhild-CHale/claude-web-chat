// HTTP surface for the wake queue. The rail reads
// GET /api/queue and folds the `queue` WS frames; the P affordance POSTs
// /api/queue/push; per-item remove DELETEs. All state lives on `state.queue`;
// the domain (lib/server/domain/queue) owns the mutations + bus emits.
//
// The composer (spec §6.3) adds POST /api/queue/message and POST
// /api/queue/task-stop, and message items to PATCH, DELETE and push. They are
// P3 surface actions (§5.7): a page's script can call them, so every write here
// is JSON-only (a cross-origin JSON POST preflights, and nothing answers the
// preflight), refuses a foreign Origin, and is rate limited; remotely, anything
// that sends, edits or removes a message needs mirror level `full`, checked
// HERE — the daemon's own lock behind the portal's table, which a protocol-8
// portal's `* /api/queue/*` row would otherwise let through. Refusals are HTTP
// 200 with `ok: false`, a `refused` word and a hint (the packs routes'
// convention); 403 and 415 are for access and transport only.

const queue = require('../domain/queue');
const signals = require('../domain/signals');
const composer = require('../composer');
const { createAudience } = require('../audience');
const { LAUNCH_COMMAND } = require('../../core/channels');
const { isRemoteRequest, isLocalOrigin } = require('../../core/cors');
const { atLeast, MIRROR_FULL_HINT } = require('../../core/remote-policy');

// Who pushed: through the portal or on the host, and from the chrome's phone view
// or not (the body's `device`, else the User-Agent). See queue.provenance.
const pushProvenance = (req) => queue.provenance({
  remote: isRemoteRequest(req),
  device: req.body && req.body.device,
  userAgent: req.headers['user-agent'],
});

// Parked-delivery copy — server-sent so the rail
// notice and the push confirmation read one source of truth. PARKED_CONFIRM is the
// moment-of-push confirmation (says WHEN, not just "pushed" — wording
// load-bearing); PARKED_NOTICE is the standing "no channel connected" explanation.
const PARKED_CONFIRM = 'Pushed — delivers with your next message.';
const PARKED_NOTICE = 'A Push here is held and delivered with your next message.';

const FOREIGN_ORIGIN_HINT = 'this request came from a page that is not the web-chat surface — send it from the surface itself';
const JSON_ONLY = 'send the request as JSON (Content-Type: application/json)';
const NOT_READY_HINT = 'this agent has no task id yet — try again in a moment, or stop it in the terminal';
const NOT_RUNNING_HINT = 'that task is not running any more (or was never seen) — nothing to stop';
// The id TaskStop takes (lib/channel/envelope STOP_TASK_ID_RE's grammar): a
// request's task id is checked against it before any lookup.
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// A push names at most this many items.
const PUSH_IDS_MAX = 50;

// The write guard (§6.3, §5.7 P3). An Origin header that is not one of this
// machine's own surfaces → 403 (no Origin — lib/client, a driver, a test —
// passes; the portal rewrites a remote viewer's to the daemon's own). A body
// that is not JSON → 415. `requireJson`: the request must carry a JSON body
// (the composer's routes); otherwise only a body that is present must be JSON,
// so a body-less POST /api/queue/push keeps working.
function writeGuard({ requireJson = false } = {}) {
  return function queueWriteGuard(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !isLocalOrigin(origin)) return res.status(403).json({ ok: false, hint: FOREIGN_ORIGIN_HINT });
    // A body is there when it has a length or is chunked; a POST with an
    // empty body (Content-Length: 0, as fetch and lib/client send one) has none.
    const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
    const json = req.is('application/json');
    if (requireJson ? !json : (hasBody && !json)) {
      return res.status(415).json({ ok: false, error: JSON_ONLY, code: 'json-only' });
    }
    next();
  };
}

// A refusal: HTTP 200, ok:false, the word, and the composer's hint for it.
const refusal = (refused, extra = {}) => ({ ok: false, refused, hint: composer.HINTS[refused] || '', ...extra });

// What a send answers, from a release (queue.release / flush): the wake's seq
// and boot to await the bridge's ack, or the park's id and the "delivers with
// your next message" line, or the transport that took it (tranche 6).
function releaseAnswer(item, r) {
  if (r && r.transported && r.transported.some((t) => t.id === item.id)) {
    return { mode: 'transported', via: r.transported.find((t) => t.id === item.id).via };
  }
  if (r && r.parked) return { mode: 'parked', pending_id: r.parked.id, delivers: PARKED_CONFIRM };
  if (r && r.wake) return { mode: 'wake', seq: r.wake.seq, boot: r.wake.boot };
  return { mode: 'queued' };
}

// The answer fields a release scheduler (ctx.queueRelease, U63) may give back:
// either a release result (mapped as above) or its own {mode, position,
// waiting, …}.
const SCHEDULER_FIELDS = ['mode', 'position', 'waiting', 'seq', 'boot', 'pending_id', 'delivers', 'via'];
function schedulerAnswer(item, r) {
  if (r && (r.wake || r.parked || Array.isArray(r.transported))) return releaseAnswer(item, r);
  const out = {};
  if (r && typeof r === 'object') for (const k of SCHEDULER_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  if (typeof out.mode !== 'string') out.mode = 'queued';
  return out;
}

const EDIT_FIELDS = ['text', 'skill', 'files'];
const hasEdit = (body) => !!body && typeof body === 'object' && EDIT_FIELDS.some((k) => body[k] !== undefined);

function mountQueueRoutes(app, ctx, { now = Date.now } = {}) {
  const { state, bus, graph } = ctx;
  // ctx.audience is read per request (the routes/health.js precedent): until the
  // server hands one over — or in a test that mounts this file alone — a
  // request is judged with no mirror opt-in, so a remote viewer is basic:
  // narrower, never wider.
  const noOptIn = createAudience({ configFile: null });
  const audience = () => ctx.audience || noOptIn;
  const levelOf = (req) => audience().levelOf(req);
  const isFull = (req) => atLeast(levelOf(req), 'full');
  const requireFull = (req, res, next) => audience().requireMirror('full')(req, res, next);
  const belowFull = (req, res) => res.status(403).json({
    ok: false, mirror: levelOf(req), remote: isRemoteRequest(req), hint: MIRROR_FULL_HINT,
  });
  // Accepted sends, edits and stop requests, per daemon (§6.3: 30 a minute).
  const rate = composer.createRateLimit({ now });
  const guard = writeGuard();
  const jsonOnly = writeGuard({ requireJson: true });
  // The adapters U66a wires; read at request time.
  const deps = () => ({ skills: ctx.skills, projectFiles: ctx.projectFiles });

  // Release one queued message now through the one delivery path, with this
  // request's provenance.
  const releaseNow = (item, prov) => releaseAnswer(item, queue.release(state, bus, [item.id], { graph, ...prov }));

  // Hand one queued message to the release scheduler (ctx.queueRelease, U63:
  // `send(item, {mode, prov})`, which times or targets it and answers the
  // mode), or, without one, release it now.
  async function sendItem(item, mode, prov) {
    const rel = ctx.queueRelease;
    if (rel && typeof rel.send === 'function') {
      try {
        return schedulerAnswer(item, await rel.send(item, { mode, prov }));
      } catch {
        // The scheduler failed: fall through to an immediate release (§6.4's
        // 'unknown' row), if the item is still waiting.
      }
    }
    if (!state.queue.some((it) => it.id === item.id)) return { mode: 'queued' };
    return releaseNow(item, prov);
  }

  app.get('/api/queue', (req, res) => {
    res.json({ items: queue.list(state, { level: levelOf(req) }), count: state.queue.length });
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
      // channelLive, not the raw wakeConsumers count: the domain says plainly
      // why (a half-open SSE socket keeps the count > 0 while nothing reads the
      // stream). This response is what the rail panel, `claude-web-chat status`
      // and `init` read to tell the user whether a Push wakes Claude — so with
      // the raw count they announced "connected" for a channel the very next
      // flush would PARK. One concept, one predicate. The raw count rides along
      // as a diagnostic.
      channel_connected: queue.channelLive(state),
      wake_consumers: state.wakeConsumers || 0,
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
  // `ids` (at most PUSH_IDS_MAX strings) names message items to send now (Send
  // now), staged or held; staged non-message items ride along. Sending a
  // message needs level `full` remotely: below it a push naming ids is refused,
  // and a plain Push sends the staged non-message items and leaves every
  // message queued (`held_messages`).
  app.post('/api/queue/push', guard, (req, res) => {
    const { reason, source, note, ids } = req.body || {};
    if (ids !== undefined && !(Array.isArray(ids) && ids.length <= PUSH_IDS_MAX && ids.every((x) => typeof x === 'string'))) {
      return res.status(400).json({ ok: false, error: `ids must be an array of at most ${PUSH_IDS_MAX} item ids` });
    }
    const full = isFull(req);
    if (ids !== undefined && !full) return belowFull(req, res);
    // `graph` rides along so a live-delivered wake locks the turn it starts
    // (turn-begin-on-push); a parked flush stays lock-less — its delivery is the
    // user's next prompt, whose turn-begin hook locks normally.
    const prov = pushProvenance(req);
    const opts = { reason, source, note, graph, ...prov };
    if (ids !== undefined) opts.ids = ids;
    if (!full) opts.messages = false;
    const { batch, wake, parked, heldMessages } = queue.flush(state, bus, opts);
    const held = full ? {} : { held_messages: heldMessages || 0 };
    // With no channel connected the flush PARKS instead of waking. Stay
    // 2xx/ok:true either way so the client clears its staged rows + note on success
    // (the success-clears-staging contract); `mode` tells the rail which happened.
    if (parked) {
      return res.json({ ok: true, pushed: batch.length, mode: 'parked', pending_id: parked.id, delivers: PARKED_CONFIRM, ...prov, ...held });
    }
    // `seq`/`boot` correlate the live wake with the bridge's ack: the rail waits
    // for a matching `wake-ack` frame and rejects the push if none arrives.
    res.json({ ok: true, pushed: batch.length, mode: 'wake', seq: wake ? wake.seq : null, boot: wake ? wake.boot : null, ...prov, ...held });
  });

  // A composer message (§6.3): validate, enqueue, then hold, send now, or send
  // when Claude is free (`auto`, the release scheduler's call — without one,
  // now: §6.4's 'unknown' row).
  app.post('/api/queue/message', requireFull, jsonOnly, async (req, res) => {
    const m = ctx.mirror;
    if (m && typeof m.enabled === 'function') {
      let on = null;
      try { on = m.enabled(); } catch { on = null; }
      if (on && on.enabled === false) return res.json(refusal('disabled', { by: on.scope || null }));
    }
    const v = await composer.validateMessage(req.body, deps());
    if (!v.ok) return res.json(v);
    if (queue.queuedMessageCount(state) >= composer.QUEUED_MESSAGES_MAX) {
      return res.json(refusal('too_many', { max: composer.QUEUED_MESSAGES_MAX }));
    }
    const taken = rate.take();
    if (!taken.ok) return res.json(refusal('rate_limited', { retry_after: taken.retry_after }));
    const prov = pushProvenance(req);
    const send = v.message.send;
    const item = queue.enqueueMessage(state, bus, v.message, {
      conversation_id: v.message.conversation_id,
      staged: send !== 'hold',
      autosend: send === 'auto',
      ...prov,
    });
    if (item.refused) return res.json(refusal(item.refused, { max: composer.QUEUED_MESSAGES_MAX }));
    const base = { ok: true, id: item.id, msg_id: item.msg_id };
    if (send === 'hold') return res.json({ ...base, mode: 'held' });
    if (send === 'now') return res.json({ ...base, ...releaseNow(item, prov) });
    res.json({ ...base, ...(await sendItem(item, 'auto', prov)) });
  });

  // Kill, Cancel and Remove (§6.9): ask Claude to stop a background task with
  // TaskStop, by the id TaskStop takes — never the task's title, which Claude
  // wrote and a prompt injection can shape. The stop request is a message item
  // with no text, sent now.
  app.post('/api/queue/task-stop', requireFull, jsonOnly, async (req, res) => {
    const taskId = req.body && req.body.task_id;
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return res.json(refusal('not_running', { hint: NOT_RUNNING_HINT }));
    const m = ctx.mirror;
    if (!m || typeof m.tasks !== 'function') return res.status(503).json({ ok: false, unavailable: true });
    let rows = [];
    try {
      const t = m.tasks();
      rows = t && Array.isArray(t.tasks) ? t.tasks : [];
    } catch { rows = []; }
    // By the id TaskStop takes, for every kind; else an agent row asked for by
    // the tool_use id it had before its agentId was known (U42 re-keys it).
    const row = rows.find((r) => r && r.id === taskId)
      || rows.find((r) => r && r.kind === 'agent' && r.tool_use_id === taskId);
    if (!row || row.status !== 'running') return res.json(refusal('not_running', { hint: NOT_RUNNING_HINT }));
    // A provisional agent row is still keyed by its tool_use id: there is no
    // agentId yet, so nothing TaskStop can take.
    if (row.kind === 'agent' && row.id === row.tool_use_id) return res.json(refusal('not_ready', { hint: NOT_READY_HINT }));
    if (typeof row.id !== 'string' || !TASK_ID_RE.test(row.id)) return res.json(refusal('not_running', { hint: NOT_RUNNING_HINT }));
    if (queue.queuedMessageCount(state) >= composer.QUEUED_MESSAGES_MAX) {
      return res.json(refusal('too_many', { max: composer.QUEUED_MESSAGES_MAX }));
    }
    const taken = rate.take();
    if (!taken.ok) return res.json(refusal('rate_limited', { retry_after: taken.retry_after }));
    const prov = pushProvenance(req);
    const conversation_id = typeof row.conversation_id === 'string' ? row.conversation_id : null;
    const item = queue.enqueueMessage(state, bus, { text: '', skill: null, files: [], chars: 0, conversation_id }, {
      source: 'task-stop', task_id: row.id, conversation_id, staged: true, autosend: false, ...prov,
    });
    if (item.refused) return res.json(refusal(item.refused, { max: composer.QUEUED_MESSAGES_MAX }));
    const sent = await sendItem(item, 'now', prov);
    let marked = null;
    try { marked = typeof m.markStopRequested === 'function' ? m.markStopRequested(row.id) || null : null; } catch { marked = null; }
    res.json({ ok: true, id: item.id, msg_id: item.msg_id, ...sent, task_id: row.id, row: marked });
  });

  // Channel liveness heartbeat — the bridge POSTs this every ~10s while its wake
  // stream is open. Stamps last-seen so flush can tell a live channel from a
  // zombie SSE socket (domain/queue.channelLive). Cheap, idempotent, bridge-only.
  app.post('/api/channel/heartbeat', (req, res) => {
    state.wakeConsumerSeenAt = Date.now();
    res.json({ ok: true, connected: queue.channelLive(state) });
  });

  // Delivery confirmation — the bridge POSTs this AFTER its notify() lands, so a
  // wake that reached Claude clears its retained batch and the rail confirms it.
  // A wake that never delivered is never acked, and the rail rejects it.
  app.post('/api/channel/ack', (req, res) => {
    const { seq, boot } = req.body || {};
    const acked = queue.ackWake(state, bus, seq, boot);
    res.json({ ok: true, acked });
  });

  // Recovery — the rail asks to re-deliver an un-acked in-flight batch after its
  // ack timed out: Retry (`{seq}`) re-emits a live wake, Hold (`{seq, park:true}`)
  // converts it to a parked wake delivered on the next message.
  app.post('/api/queue/repush', guard, (req, res) => {
    const { seq, park } = req.body || {};
    // Re-sending a retained batch that holds a message sends the message.
    const pa = state.pendingAck;
    if (pa && Array.isArray(pa.batch) && pa.batch.some(queue.isMessage) && !isFull(req)) return belowFull(req, res);
    const result = queue.repush(state, bus, seq, { park: !!park, graph, ...pushProvenance(req) });
    if (!result) return res.status(404).json({ ok: false, error: 'no in-flight push to repush' });
    if (result.mode === 'parked') {
      return res.json({ ok: true, mode: 'parked', pending_id: result.parked.id, delivers: PARKED_CONFIRM });
    }
    res.json({ ok: true, mode: 'wake', seq: result.wake.seq, boot: result.wake.boot });
  });

  // Path A: the turn-begin hook reads the parked wake and injects its summary
  // as context on the user's next prompt. Returns the SUMMARY envelope only — bodies
  // stay fetched by tool call (get_captures/get_store) per the envelope contract.
  app.get('/api/queue/pending', (req, res) => {
    // Backstop: an in-flight wake the rail never got an ack for (tab closed
    // mid-push) folds into the park once stale, so the user's next message still
    // delivers it. A wake still within the rail's live ack window is left alone.
    queue.foldStaleAck(state);
    const p = state.pendingWake;
    // `items` is the parked batch, SUMMARY-ONLY — the same five fields a queued
    // item shows in the rail, and nothing the envelope contract keeps out. The
    // rail used to reconstruct these by regex-parsing `envelope.content`, which
    // is prose written for Claude: an implicit contract across three modules
    // that any rewording of a bullet broke silently.
    // envelope.content holds a parked message's words: only at `read` or above
    // (§5.4); below, the envelope's meta alone (all the rail reads).
    const envelope = p && p.envelope && !atLeast(levelOf(req), 'read') ? { meta: p.envelope.meta } : (p && p.envelope);
    res.json({
      pending: p ? {
        id: p.id, created_at: p.created_at, envelope, note: p.note,
        // The last push's provenance (absent on a park from an older draft).
        ...queue.provFields(p),
        // A message's row carries its text-free summary at every level.
        items: (p.batch || []).map((it) => ({
          id: it.id, kind: it.kind,
          summary: queue.isMessage(it) ? queue.messageSummary(it) : it.summary,
          source: it.source, why_wake: it.why_wake,
        })),
      } : null,
    });
  });

  // Consume the park after the hook delivered it. Id-checked (a stale id — e.g. a
  // re-push merged into a fresh park, or path B drained first — no-ops) so path A/B
  // can't double-deliver.
  app.post('/api/queue/pending/consume', guard, (req, res) => {
    const { id } = req.body || {};
    const consumed = queue.consumePending(state, id);
    res.json({ ok: true, consumed });
  });

  // Stage / unstage an item. `{staged:false}` holds it back; `true`
  // re-stages. Held items persist in the queue but aren't sent on Push.
  // A queued or held composer message also takes `{text?, skill?, files?}`,
  // re-validated as a send is (composer.validateEdit, with the body as sent: no
  // `skill` field re-parses the leading skill from the merged text). Any PATCH
  // of a message needs level `full` remotely.
  app.patch('/api/queue/:id', guard, async (req, res) => {
    const body = req.body || {};
    const id = req.params.id;
    let it = state.queue.find((q) => q.id === id);
    if (queue.isMessage(it) && !isFull(req)) return belowFull(req, res);
    if (hasEdit(body)) {
      if (!it) return res.json(refusal('not_editable'));
      if (!queue.isMessage(it) || it.source === 'task-stop') return res.json(refusal('not_editable'));
      const v = await composer.validateEdit(it, body, deps());
      if (!v.ok) return res.json(v);
      // The validation awaited: the message may have gone meanwhile.
      it = state.queue.find((q) => q.id === id);
      if (!queue.isMessage(it)) return res.json(refusal('not_editable'));
      const taken = rate.take();
      if (!taken.ok) return res.json(refusal('rate_limited', { retry_after: taken.retry_after }));
      queue.editMessage(state, bus, id, v.message);
      if (body.staged !== undefined) queue.setStaged(state, bus, id, body.staged);
      return res.json({ ok: true, id: it.id, staged: it.staged, chars: it.chars, summary: it.summary });
    }
    const { staged } = body;
    // setStaged applies the staged-default coercion once (C5) — pass the raw value.
    it = queue.setStaged(state, bus, id, staged);
    if (!it) return res.status(404).json({ ok: false, error: 'queue item not found' });
    res.json({ ok: true, id: it.id, staged: it.staged });
  });

  // Remove one item. `?revert=1` also removes its web-chat artifact (a comment's
  // pin, or a capture/signal's origin pane).
  // Removing a message needs level `full` remotely.
  app.delete('/api/queue/:id', guard, (req, res) => {
    const target = state.queue.find((q) => q.id === req.params.id);
    if (queue.isMessage(target) && !isFull(req)) return belowFull(req, res);
    const revert = req.query.revert === '1' || req.query.revert === 'true';
    const result = queue.remove(state, bus, req.params.id, { revert });
    if (!result) return res.status(404).json({ ok: false, error: 'queue item not found' });
    // B1: report the DOMAIN-computed `reverted`, not the request flag — a Revert on
    // an item whose artifact is already gone reverts nothing.
    res.json({ ok: true, removed: result.removed.id, reverted: result.reverted, count: state.queue.length });
  });
}

module.exports = { mountQueueRoutes, PARKED_CONFIRM };

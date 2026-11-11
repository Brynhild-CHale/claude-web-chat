'use strict';

// The connector's derived signals, chat status and heartbeat rows (contract 05
// §3.9, C-05.37 to C-05.43; 06 C-06.24 as A-06.1 changes it; 07 C-07.7,
// C-07.33 to C-07.37; 11 C-11.1 (d), (f), (g); tranche 6, U729).
//
//   createSignals({ lifecycle, ring, supervisor, link, log,
//                   deps: { client, registry, now, portOf, setTimeout, clearTimeout } })
//     → { install(ctx), statusOf(chatId), heartbeatRows(), heartbeatBody(base),
//         track(chat), forget(chatId), pollNow(chatId) }
//
//   * TURN SIGNALS (C-05.38, C-05.39) come from the lifecycle's one hold per
//     chat — the same fan-out 07's ring reads; this module opens no stream and
//     no /ws socket. A `graph` entry maps by C-05.39's table: turn-begin →
//     turn.begun (author, absent meaning user; session_id); one with
//     upgraded_wake_lock → nothing; one with stole_stale_lock → turn.ended
//     superseded, then turn.begun, both with the entry's seq; turn-end →
//     turn.ended committed (node, ended, ended_by); turn-skipped no-change →
//     skipped_no_change; turn-skipped other-session → nothing; unlock had →
//     unlocked; unlock not had → nothing. An entry already derived in the same
//     boot (a reopened hold replays from the hub's cursor) derives nothing
//     again. Every graph entry also runs the status poll at once.
//   * THE STATUS POLL (C-05.38, C-06.24). On the lifecycle's tick and at once
//     on a graph entry: GET /api/health through lifecycle.healthOf (the tick's
//     ONE memoised read, shared with the idle check; fresh only for an entry),
//     then GET /api/mirror/status (with its headers: X-WC-Boot orders the
//     record, C-07.7), GET /api/asks and GET /api/queue/policy — host reads
//     through lib/client with the explicit port and noSpawn, no Origin, no
//     Sec-Fetch-*, never X-WC-Remote. The port comes from the deps.portOf seam,
//     else from the registry (daemonFor, then answersFor with strictInstance),
//     whose answer is kept on the chat's state, as the ring keeps its port, so a
//     steady tick reads health once; it is dropped when a host read on it
//     fails, when the hold opens again and when the boot changes. Asks are
//     diffed by id, version and state against the previous poll (ask.opened,
//     ask.updated, ask.closed); `conversations` goes when (boot, rev) moves. When health shows no lock
//     while a derived turn is open, and a second read 250 ms later agrees
//     with no turn signal derived between, turn.ended superseded goes with
//     daemon_seq null (a guardReaim steal writes no turn entry).
//   * COALESCING (C-05.24, C-05.37). While the link's signal window is full
//     (signalRoom() 0) a chat's signals are dropped and counted, and one
//     resync is owed; it goes when the link says `signals.open`. A link that is
//     not up drops quietly: its hello.ack brings a resync of every chat.
//   * RESYNC (C-05.43): the conversations record, whether a turn holds the
//     lock and every open ask, from ONE status poll, after every hello.ack
//     (reason reconnect), after coalescing (backpressure, with the count), on a
//     boot change (reset) and when the hold or the poll answers again after
//     failing (poll_recovered; a chat's first poll counts: nothing has
//     answered before it). A resync replaces the incremental signals of the
//     poll it comes from.
//   * CHAT STATUS (06-chat-status.json, A-06.1) on the control channel as
//     chat.status: from host reads and the registry only (health with
//     viewer_peers and mirror.enabled, the lock fields, registry
//     mcpSessionsFor, queue policy's channel_connected, mod_attached and
//     queue_count, the asks count), plus the lifecycle's held and over_cap,
//     the supervisor's started_by and the chats module's state, rev, reason
//     and detail (ctx.chats.statusOf). `boot` is THIS connector process's boot
//     token and `seq` counts every status this boot sends, across chats, as
//     the locked schema says. Sent on change at most once a second per chat,
//     in full after every hello.ack. session.launched_by is 'user' and
//     session.attach null: connector mode is not built (U733's probe fills it).
//   * HEARTBEAT ROWS (07-heartbeat.json's chat item, C-07.35): per chat the
//     daemon state, boot, viewers, the highest ring position read in that
//     boot (ring.stats(chatId).pos when the ring exposes it, else the highest
//     seq the hold delivered in the hold's boot) and channel_connected. The
//     link's heartbeat timer, connector_now and echo_at are the link's
//     (heartbeatBody(base) fills its seam).
//
// NEVER on the wire (C-11.1 (d), (g); C-07.36): the lock's message, a prompt,
// a trigger's summary or reply, an error text, an ask's tool name, subject,
// input, questions or plan, a path, a port or a pid. Every string a frame
// carries is an id, a word, an enum, a boot token, a version or a label cut
// to the schema's pattern; anything else is dropped. Log lines carry a chat
// id (when safe) and a code or a count.

const crypto = require('crypto');
const client = require('../client');
const registry = require('../util/registry');
const { stableKey } = require('../core/stable-json');
const { isSafeId } = require('../core/paths');
const { toolKind, TOOL_KINDS } = require('../core/tool-input');
const { headerBoot } = require('./ring');
const { minimalHeartbeat } = require('./link');

const READ_TIMEOUT_MS = 3_000;
const STATUS_MIN_MS = 1_000;          // C-06.24: at most once a second per chat
const LOCK_GONE_CONFIRM_MS = 250;     // the second read before a poll-derived superseded
const LIST_MAX = 64;                  // 05-event.json: conversations, open_asks maxItems
const HEARTBEAT_CHATS_MAX = 256;      // 07-heartbeat.json: chats maxItems
const PACKAGE_VERSIONS_MAX = 8;       // 06-chat-status.json: package_versions maxItems
const DETAIL_MAX = 280;

const CHAT_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORD_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const INSTANCE_RE = /^[0-9a-f]{8}$/;
const VERSION_RE = /^[\x21-\x7e]{1,64}$/;
const CONV_STATES = new Set(['ended', 'suspended', 'question', 'waiting', 'compacting', 'working', 'idle', 'unknown']);
const ENDED = new Set(['stop', 'failed', 'interrupted', 'session-ended']);
const ENDED_BY = new Set(['terminal', 'web', 'hook']);
const LOCK_AUTHORS = new Set(['user', 'wake', 'task']);
const STATUS_STATES = new Set(['preparing', 'starting', 'running', 'stopping', 'stopped', 'refused', 'failed']);
const STATUS_REASONS = new Set([
  'unknown-folder', 'folder-withdrawn', 'root-in-use', 'init-needed', 'init-failed', 'clone-failed',
  'daemon-timeout', 'identity-mismatch', 'cap', 'paused', 'not-accepting', 'home-launch-off', 'no-tmux',
  'needs-trust', 'no-claude', 'revoked', 'other',
]);
// The resync a chat owes, most telling first when several are owed at once.
const RESYNC_ORDER = Object.freeze(['reset', 'reconnect', 'backpressure', 'poll_recovered']);

const isSeq = (n) => Number.isInteger(n) && n >= 0;
const isPort = (p) => Number.isInteger(p) && p > 0 && p <= 65535;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isBoot = (b, max = 128) => typeof b === 'string' && b.length >= 1 && b.length <= max;
const logId = (id) => (isSafeId(id) ? id : '?');
const idOrNull = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const wordOrNull = (v) => (typeof v === 'string' && WORD_RE.test(v) ? v : null);
const timeOrNull = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

// An ask row as GET /api/asks serves it to a local caller, cut to
// 05-event.json's ask fields; null when a required one is missing. tool_kind
// is the daemon's class word (Bash, Edit, MCP) lower-cased to the schema's
// word grammar, or null; never the tool's name. The daemon's toolKind passes
// an unknown tool's own name through (a Claude Code tool newer than the
// table), so the machine's edge reduces anything outside lib/core/tool-input's
// TOOL_KINDS to the word 'tool' (05-event.json: "the class of tool, never its
// full name"; U729@signals.js:128-tool-kind-name).
const KIND_WORDS = new Set(TOOL_KINDS.map((k) => k.toLowerCase()));
function classWord(v) {
  if (typeof v !== 'string') return null;
  const word = toolKind(v).toLowerCase();
  return KIND_WORDS.has(word) ? word : 'tool';
}

function cutAsk(row) {
  if (!isPlain(row)) return null;
  const id = idOrNull(row.id);
  const kind = wordOrNull(row.kind);
  const state = wordOrNull(row.state);
  if (!id || !kind || !state || typeof row.answerable !== 'boolean' || !isSeq(row.version) || !isSeq(row.created_at)) return null;
  return {
    id,
    conversation_id: idOrNull(row.conversation_id),
    kind,
    tool_kind: classWord(row.tool_kind),
    state,
    answerable: row.answerable,
    version: row.version,
    created_at: row.created_at,
  };
}

// One conversation row without counts (C-05.41).
function cutRow(row) {
  if (!isPlain(row)) return null;
  const id = idOrNull(row.id);
  if (!id) return null;
  const out = { id, state: CONV_STATES.has(row.state) ? row.state : 'unknown' };
  if (isSeq(row.since)) out.since = row.since;
  if (typeof row.quiet === 'boolean') out.quiet = row.quiet;
  if ('step_kind' in row) out.step_kind = wordOrNull(row.step_kind);
  if ('waiting_kind' in row) out.waiting_kind = wordOrNull(row.waiting_kind);
  if ('last_activity_at' in row) out.last_activity_at = timeOrNull(row.last_activity_at);
  if ('ended_reason' in row) out.ended_reason = wordOrNull(row.ended_reason);
  return out;
}

// GET /api/mirror/status's body as C-05.41's record: rev, aggregate.state,
// the rows without counts. A disabled mirror is an empty record at rev 0.
function cutRecord(body) {
  if (!isPlain(body) || (body.ok === false && body.disabled === true)) {
    return { rev: 0, aggregate: 'unknown', conversations: [] };
  }
  const agg = isPlain(body.aggregate) ? body.aggregate.state : null;
  const rows = Array.isArray(body.conversations) ? body.conversations : [];
  return {
    rev: isSeq(body.rev) ? body.rev : 0,
    aggregate: CONV_STATES.has(agg) ? agg : 'unknown',
    conversations: rows.map(cutRow).filter(Boolean).slice(0, LIST_MAX),
  };
}

const disabledBody = (b) => isPlain(b) && b.ok === false && b.disabled === true;

function createSignals({ lifecycle = null, ring = null, supervisor = null, link = null, log = () => {}, deps = {} } = {}) {
  const d = {
    client,
    registry,
    now: Date.now,
    portOf: null,
    setTimeout,
    clearTimeout,
    ...deps,
  };
  const say = (line) => { try { log(line); } catch {} };
  const unref = (t) => { try { if (t && typeof t.unref === 'function') t.unref(); } catch {} return t; };
  const now = () => Math.max(0, Math.floor(d.now()));

  let lc = lifecycle;
  let ln = link;
  let rg = ring;
  let sup = supervisor;
  let ctxRef = null;
  const chats = new Map();

  // This connector process's boot token (06-chat-status.json `boot`): opaque,
  // random per createSignals, no pid; `seq` counts statuses within it.
  const connectorBoot = `${crypto.randomBytes(8).toString('hex')}:${now()}`;
  let statusSeq = 0;

  function stateOf(chatId) {
    let st = chats.get(chatId);
    if (!st) {
      st = {
        id: chatId,
        root: null,
        port: null,            // the registry's verified port, kept until a read on it fails
        boot: null,            // the daemon's boot as the last read named it
        entryBoot: null,       // the hold's boot (its open's X-WC-Boot)
        derivedBoot: null,     // the (boot, seq) of the last entry derived
        derivedSeq: 0,
        ringSeq: null,         // the highest seq the hold delivered in entryBoot
        turnOpen: false,       // a turn.begun with no turn.ended after it
        turnGen: 0,            // bumped by every derived turn signal
        lockGoneGen: null,     // a poll saw no lock at this turnGen
        confirmTimer: null,
        prevAsks: null,        // id → cut ask, as the hub last heard
        conv: null,            // {boot, rev} the hub last heard
        owed: new Set(),       // resync reasons owed
        dropped: 0,
        coalescing: false,
        pollFailed: true,      // nothing has answered yet: the first poll resyncs
        holdFailed: false,
        upEver: false,
        polling: null,
        again: null,
        last: { health: null, policy: null, asks: null, at: null },
        statusKey: null,
        statusAt: null,
        statusTimer: null,
        warned: false,
      };
      chats.set(chatId, st);
    }
    return st;
  }
  const alive = (st) => chats.get(st.id) === st;

  function labelled(st) {
    if (CHAT_RE.test(st.id)) return true;
    if (!st.warned) { st.warned = true; say(`signals chat ${logId(st.id)} is not a chat label; nothing sent`); }
    return false;
  }

  // ── the link ──────────────────────────────────────────────────────────────

  const linkUp = () => !!ln && typeof ln.send === 'function' && (ln.state === undefined || ln.state === 'up');
  function room() {
    if (!ln || typeof ln.signalRoom !== 'function') return Infinity;
    try { return ln.signalRoom(); } catch { return 0; }
  }
  function linkSend(ch, kind, body) {
    try {
      return ln.send(ch, kind, body) != null;
    } catch (e) {
      say(`signals ${kind} not sent: ${(e && e.code) || 'error'}`);
      return false;
    }
  }

  // A derived signal: dropped quietly while the link is down (its hello.ack
  // resyncs), dropped and counted while the window is full (one resync owed).
  function sendSignal(st, kind, fields, { boot, daemonSeq = null, daemonAt = null } = {}) {
    if (!labelled(st) || !linkUp()) return false;
    const b = boot || st.boot;
    if (!isBoot(b)) { st.owed.add('poll_recovered'); return false; }
    if (st.coalescing || room() <= 0) {
      if (!st.coalescing) say(`signals chat ${logId(st.id)} coalescing`);
      st.coalescing = true;
      st.dropped++;
      st.owed.add('backpressure');
      return false;
    }
    return linkSend('events', kind, {
      chat: st.id,
      boot: b,
      daemon_seq: isSeq(daemonSeq) && daemonSeq >= 1 ? daemonSeq : null,
      daemon_at: isSeq(daemonAt) ? daemonAt : now(),
      ...fields,
    });
  }

  // ── turn signals from the hold's graph entries (C-05.39) ──────────────────

  function turnEnded(st, outcome, { node = null, ended = null, endedBy = null } = {}, at) {
    st.turnOpen = false;
    st.turnGen++;
    st.lockGoneGen = null;
    sendSignal(st, 'turn.ended', {
      outcome,
      node,
      ended: ENDED.has(ended) ? ended : null,
      ended_by: ENDED_BY.has(endedBy) ? endedBy : null,
    }, at);
  }

  function deriveEntry(st, e) {
    const boot = st.entryBoot || st.boot;
    if (st.derivedBoot === boot && e.seq <= st.derivedSeq) return; // a replay
    st.derivedBoot = boot;
    st.derivedSeq = e.seq;
    const at = { boot, daemonSeq: e.seq, daemonAt: isSeq(e.ts) ? e.ts : null };
    switch (e.op) {
      case 'turn-begin': {
        if (e.upgraded_wake_lock === true) return;
        if (e.stole_stale_lock === true) turnEnded(st, 'superseded', {}, at);
        st.turnOpen = true;
        st.turnGen++;
        st.lockGoneGen = null;
        const author = e.author === undefined ? 'user' : wordOrNull(e.author) || 'other';
        sendSignal(st, 'turn.begun', { author, session_id: idOrNull(e.session_id) }, at);
        return;
      }
      case 'turn-end':
        turnEnded(st, 'committed', { node: idOrNull(e.id), ended: e.ended, endedBy: e.ended_by }, at);
        return;
      case 'turn-skipped':
        if (e.reason === 'no-change') turnEnded(st, 'skipped_no_change', { ended: e.ended, endedBy: e.ended_by }, at);
        return;
      case 'unlock':
        if (e.had === true) turnEnded(st, 'unlocked', {}, at);
        return;
      default:
    }
  }

  // ── the hold's fan-out ────────────────────────────────────────────────────

  function onOpen(st, msg) {
    st.port = null;
    const boot = headerBoot(msg.response && msg.response.headers);
    if (boot) {
      noteBoot(st, boot);
      if (st.entryBoot !== boot) { st.entryBoot = boot; st.ringSeq = null; }
    }
    if (st.holdFailed) { st.holdFailed = false; st.owed.add('poll_recovered'); }
    poll(st).catch(() => {});
  }

  function onEntry(st, msg) {
    const e = msg.entry;
    if (!isPlain(e) || !isSeq(e.seq)) return;
    if (st.ringSeq === null || e.seq > st.ringSeq) st.ringSeq = e.seq;
    if (e.kind !== 'graph') return;
    deriveEntry(st, e);
    poll(st, { fresh: true }).catch(() => {});
  }

  function onLifecycle(msg) {
    if (!msg || typeof msg.chatId !== 'string') return;
    const st = stateOf(msg.chatId);
    switch (msg.type) {
      case 'open': onOpen(st, msg); return;
      case 'entry': onEntry(st, msg); return;
      case 'gap':
        // Entries the hold never delivered: what they derived is unknown.
        st.owed.add(msg.gap && msg.gap.reset ? 'reset' : 'poll_recovered');
        poll(st, { fresh: true }).catch(() => {});
        return;
      case 'close':
        st.holdFailed = true;
        maybeStatus(st);
        return;
      default:
    }
  }

  function onTick({ chatId, chat } = {}) {
    if (typeof chatId !== 'string') return undefined;
    const st = stateOf(chatId);
    if (chat && typeof chat.root === 'string') st.root = chat.root;
    return poll(st);
  }

  // ── the boot ──────────────────────────────────────────────────────────────

  // A new boot of the chat's daemon: what the hub derived is void (C-05.43).
  function noteBoot(st, boot) {
    if (!isBoot(boot)) return;
    if (st.boot && st.boot !== boot) {
      say(`signals chat ${logId(st.id)} boot changed`);
      st.owed.add('reset');
      st.port = null;
      st.prevAsks = null;
      st.conv = null;
      st.turnOpen = false;
      st.turnGen++;
      st.lockGoneGen = null;
    }
    st.boot = boot;
  }

  // ── the status poll (C-05.38, C-06.24) ────────────────────────────────────

  async function portOf(st) {
    if (isPort(st.port)) return st.port;
    for (const fn of [d.portOf, lc && lc.portOf]) {
      if (typeof fn !== 'function') continue;
      try { const p = await fn(st.id); if (isPort(p)) return p; } catch {}
    }
    if (!st.root) return null;
    try {
      const rec = await d.registry.daemonFor(st.root);
      if (!rec || !isPort(rec.port)) return null;
      const ok = await d.registry.answersFor(rec, d.registry.instanceId(st.root), { strictInstance: true });
      if (!ok) return null;
      st.port = rec.port;
      return rec.port;
    } catch {
      return null;
    }
  }

  async function hostGet(st, port, pathStr, opts = {}) {
    try {
      return await d.client.get(pathStr, { port, noSpawn: true, timeout: READ_TIMEOUT_MS, ...opts });
    } catch (e) {
      if (st.port === port) st.port = null;
      say(`signals chat ${logId(st.id)} read failed: ${(e && (e.code || e.status)) || 'error'}`);
      return null;
    }
  }

  async function healthOf(st, fresh) {
    if (!lc || typeof lc.healthOf !== 'function') return null;
    try {
      const h = await lc.healthOf(st.id, fresh ? { fresh: true } : undefined);
      return isPlain(h) ? h : null;
    } catch {
      return null;
    }
  }

  // One poll at a time per chat; a request during one runs once after it.
  function poll(st, { fresh = false } = {}) {
    if (st.polling) {
      st.again = { fresh: Boolean((st.again && st.again.fresh) || fresh) };
      return st.polling;
    }
    const p = (async () => {
      try {
        await pollOnce(st, fresh);
      } catch {
        say(`signals chat ${logId(st.id)} poll failed: error`);
      }
    })();
    st.polling = p;
    return p.then(() => {
      st.polling = null;
      if (st.again && alive(st)) {
        const a = st.again;
        st.again = null;
        return poll(st, a);
      }
      return undefined;
    });
  }

  async function pollOnce(st, fresh) {
    const gen = st.turnGen;
    const health = await healthOf(st, fresh);
    if (!alive(st)) return;
    const port = health ? await portOf(st) : null;
    let mirror = null;
    let asks = null;
    let policy = null;
    if (port) {
      const [m, a, q] = await Promise.all([
        hostGet(st, port, '/api/mirror/status', { withHeaders: true }),
        hostGet(st, port, '/api/asks'),
        hostGet(st, port, '/api/queue/policy'),
      ]);
      mirror = isPlain(m) && isPlain(m.body) ? m : null;
      asks = isPlain(a) ? (disabledBody(a) ? [] : Array.isArray(a.asks) ? a.asks : null) : null;
      policy = isPlain(q) && !disabledBody(q) ? q : null;
    }
    if (!alive(st)) return;
    const boot = (mirror && headerBoot(mirror.headers)) || (health && isBoot(health.boot) ? health.boot : null);
    const ok = Boolean(health && mirror && asks && boot);
    const rows = asks ? asks.map(cutAsk).filter(Boolean) : null;
    st.last = { health, policy, asks: rows, at: now() };
    if (health) st.upEver = true;
    if (!ok) {
      if (!st.pollFailed) say(`signals chat ${logId(st.id)} poll failed`);
      st.pollFailed = true;
      maybeStatus(st);
      return;
    }
    noteBoot(st, boot);
    if (st.pollFailed) { st.pollFailed = false; st.owed.add('poll_recovered'); }

    const record = cutRecord(mirror.body);
    const daemonAt = isSeq(mirror.body.now) ? mirror.body.now : (Number.isFinite(mirror.body.now) ? Math.floor(mirror.body.now) : now());
    const inFlight = Boolean(health.lock) && health.lock_stale !== true;

    if (st.owed.size) {
      resyncFrom(st, { boot, record, rows, inFlight, daemonAt });
    } else {
      if (!st.conv || st.conv.boot !== boot || record.rev > st.conv.rev) {
        sendSignal(st, 'conversations', { record }, { boot, daemonAt });
        st.conv = { boot, rev: record.rev };
      }
      diffAsks(st, rows, boot);
      lockGone(st, health, gen, boot);
    }
    maybeStatus(st);
  }

  function diffAsks(st, rows, boot) {
    const prev = st.prevAsks || new Map();
    const next = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      const was = prev.get(r.id);
      if (!was) sendSignal(st, 'ask.opened', { ask: r }, { boot });
      else if (was.version !== r.version || was.state !== r.state) sendSignal(st, 'ask.updated', { ask: r }, { boot });
    }
    for (const [id, was] of prev) if (!next.has(id)) sendSignal(st, 'ask.closed', { ask: was }, { boot });
    st.prevAsks = next;
  }

  // C-05.39: no lock while a derived turn is open. Two reads apart agree, and
  // no turn signal was derived between, before turn.ended superseded goes.
  function lockGone(st, health, gen, boot) {
    if (!st.turnOpen || health.lock != null || gen !== st.turnGen) { st.lockGoneGen = null; return; }
    if (st.lockGoneGen === gen) {
      turnEnded(st, 'superseded', {}, { boot });
      return;
    }
    st.lockGoneGen = gen;
    if (st.confirmTimer) return;
    st.confirmTimer = unref(d.setTimeout(() => {
      st.confirmTimer = null;
      if (alive(st)) poll(st, { fresh: true }).catch(() => {});
    }, LOCK_GONE_CONFIRM_MS));
  }

  // ── resync (C-05.43) ──────────────────────────────────────────────────────

  function resyncFrom(st, { boot, record, rows, inFlight, daemonAt }) {
    const reason = RESYNC_ORDER.find((r) => st.owed.has(r)) || 'poll_recovered';
    // What the hub will hold once this goes; a resync that cannot go now is
    // built again from a later poll.
    st.prevAsks = new Map(rows.map((r) => [r.id, r]));
    st.conv = { boot, rev: record.rev };
    st.turnOpen = inFlight;
    st.turnGen++;
    st.lockGoneGen = null;
    if (!labelled(st) || !linkUp()) { st.owed.clear(); return; }
    if (room() <= 0) { st.coalescing = true; st.owed.add('backpressure'); return; }
    const sent = linkSend('events', 'resync', {
      chat: st.id,
      boot,
      daemon_seq: null,
      daemon_at: daemonAt,
      reason,
      dropped: st.dropped,
      record,
      turn_in_flight: inFlight,
      open_asks: rows.slice(0, LIST_MAX),
    });
    if (sent) say(`signals chat ${logId(st.id)} resync ${reason} dropped ${st.dropped}`);
    st.owed.clear();
    st.dropped = 0;
    st.coalescing = false;
  }

  function onReady() {
    for (const st of chats.values()) {
      st.owed.add('reconnect');
      st.coalescing = false;
      maybeStatus(st, { force: true });
      poll(st, { fresh: true }).catch(() => {});
    }
  }

  function onSignalsOpen() {
    for (const st of chats.values()) {
      if (st.coalescing || st.owed.size) poll(st, { fresh: true }).catch(() => {});
    }
  }

  // ── chat status (06-chat-status.json, A-06.1) ─────────────────────────────

  function chatsStatus(chatId) {
    const m = ctxRef && ctxRef.chats;
    if (!m || typeof m.statusOf !== 'function') return null;
    try { const s = m.statusOf(chatId); return isPlain(s) ? s : null; } catch { return null; }
  }

  function heldBy(chatId) {
    try { return Boolean(lc && typeof lc.heldBy === 'function' && lc.heldBy(chatId)); } catch { return false; }
  }

  function daemonUp(st, h) {
    if (!h) return false;
    if (!st.root) return true;
    try { return h.instance === d.registry.instanceId(st.root); } catch { return false; }
  }

  function daemonBody(st) {
    const h = st.last.health;
    if (!h) return null;
    const out = { up: daemonUp(st, h) };
    if (typeof h.instance === 'string' && INSTANCE_RE.test(h.instance)) out.instance = h.instance;
    if (typeof h.package_version === 'string' && VERSION_RE.test(h.package_version)) out.package_version = h.package_version;
    if (isBoot(h.boot, 64)) out.boot = h.boot;
    out.viewers = isSeq(h.viewers) ? h.viewers : null;
    const vp = h.viewer_peers;
    out.viewer_peers = isPlain(vp) && isSeq(vp.local) && isSeq(vp.remote) ? { local: vp.local, remote: vp.remote } : null;
    let by = null;
    try { by = sup && typeof sup.startedBy === 'function' ? sup.startedBy(st.id) : null; } catch { by = null; }
    if (by === 'connector' || by === 'other') out.started_by = by;
    out.held = heldBy(st.id);
    out.mirror_enabled = isPlain(h.mirror) && h.mirror.enabled === true;
    return out;
  }

  function sessionBody(st) {
    let rows = [];
    try { rows = st.root ? d.registry.mcpSessionsFor(st.root) || [] : []; } catch { rows = []; }
    if (!Array.isArray(rows) || !rows.length) return null;
    const q = st.last.policy;
    const versions = [];
    let last = null;
    for (const r of rows) {
      const v = r && r.package_version;
      if (typeof v === 'string' && VERSION_RE.test(v) && !versions.includes(v)) versions.push(v);
      if (r && Number.isFinite(r.last_tool_at) && (last === null || r.last_tool_at > last)) last = r.last_tool_at;
    }
    return {
      attached: true,
      count: rows.length,
      ...(q && typeof q.channel_connected === 'boolean' ? { channel: q.channel_connected } : {}),
      mod: q && typeof q.mod_attached === 'boolean' ? q.mod_attached : null,
      launched_by: 'user',
      attach: null,
      package_versions: versions.slice(0, PACKAGE_VERSIONS_MAX),
      last_tool_at: last,
    };
  }

  function turnBody(h) {
    const lock = isPlain(h.lock) ? h.lock : null;
    const inFlight = Boolean(lock) && h.lock_stale !== true;
    return {
      in_flight: inFlight,
      ...(inFlight && LOCK_AUTHORS.has(lock.author) ? { author: lock.author } : {}),
      ...(inFlight && Number.isFinite(lock.started_at) ? { started_at: lock.started_at } : {}),
      active_label: typeof h.active_label === 'string' && h.active_label.length <= 64 ? h.active_label : null,
      last_commit_at: Number.isFinite(h.last_commit_at) ? h.last_commit_at : null,
    };
  }

  // The status minus v, chat_id, boot, seq and at: what "a change" compares.
  function composeBody(st) {
    const cs = chatsStatus(st.id);
    const h = st.last.health;
    const daemon = daemonBody(st);
    const live = daemon && daemon.up && daemon.held ? 'running' : 'starting';
    const state = cs && STATUS_STATES.has(cs.state) ? (cs.state === 'running' ? live : cs.state) : live;
    const q = st.last.policy;
    let overCap = null;
    try { overCap = lc && typeof lc.overCap === 'function' ? lc.overCap() === true : null; } catch { overCap = null; }
    return {
      rev: cs && isSeq(cs.rev) ? cs.rev : 0,
      state,
      ...(cs && STATUS_REASONS.has(cs.reason) ? { reason: cs.reason } : {}),
      ...(cs && typeof cs.detail === 'string' && cs.detail && cs.detail.length <= DETAIL_MAX ? { detail: cs.detail } : {}),
      daemon,
      session: sessionBody(st),
      ...(h ? { turn: turnBody(h) } : {}),
      ...(st.last.asks ? { needs_you: { asks: st.last.asks.length } } : {}),
      ...(q && isSeq(q.queue_count) ? { queue: { count: q.queue_count } } : {}),
      ...(overCap === null ? {} : { over_cap: overCap }),
    };
  }

  function fullStatus(st, body, seq) {
    return { v: 1, chat_id: st.id, rev: body.rev, boot: connectorBoot, seq, at: now(), ...body };
  }

  // Sent on change, at most once a second per chat; `force` (a hello.ack)
  // sends in full now.
  function maybeStatus(st, { force = false } = {}) {
    if (!alive(st) || !labelled(st)) return;
    const body = composeBody(st);
    const key = stableKey(body);
    if (!force && key === st.statusKey) return;
    const t = now();
    if (!force && st.statusAt !== null && t - st.statusAt < STATUS_MIN_MS) {
      if (!st.statusTimer) {
        st.statusTimer = unref(d.setTimeout(() => {
          st.statusTimer = null;
          maybeStatus(st);
        }, STATUS_MIN_MS - (t - st.statusAt)));
      }
      return;
    }
    if (!linkUp()) return;
    const status = fullStatus(st, body, statusSeq + 1);
    if (linkSend('control', 'chat.status', { status })) {
      statusSeq++;
      st.statusKey = key;
      st.statusAt = t;
    }
  }

  // ── heartbeat rows (07-heartbeat.json, C-07.35) ───────────────────────────

  function ringPosition(st) {
    let s = null;
    try { s = rg && typeof rg.stats === 'function' ? rg.stats(st.id) : null; } catch { s = null; }
    if (isPlain(s) && isSeq(s.pos) && isBoot(s.boot)) return { boot: s.boot, seq: s.pos };
    return { boot: st.entryBoot, seq: st.ringSeq };
  }

  function daemonState(st) {
    const cs = chatsStatus(st.id);
    if (cs) {
      if (cs.state === 'preparing' || cs.state === 'starting') return 'starting';
      if (cs.state === 'stopping' || cs.state === 'stopped' || cs.state === 'refused') return 'stopped';
      if (cs.state === 'failed') return 'crashed';
    }
    if (st.last.health && daemonUp(st, st.last.health)) return 'running';
    return st.upEver ? 'crashed' : 'starting';
  }

  function heartbeatRows() {
    const out = [];
    for (const st of chats.values()) {
      if (!CHAT_RE.test(st.id)) continue;
      if (out.length >= HEARTBEAT_CHATS_MAX) break;
      const daemon = daemonState(st);
      const running = daemon === 'running';
      const h = st.last.health;
      const q = st.last.policy;
      const pos = ringPosition(st);
      out.push({
        chat_id: st.id,
        daemon,
        boot: running && isBoot(st.boot) ? st.boot : null,
        viewers: running && h && isSeq(h.viewers) ? h.viewers : null,
        ring_seq: running && isSeq(pos.seq) && (!st.boot || pos.boot === st.boot) ? pos.seq : null,
        channel_connected: running && q && typeof q.channel_connected === 'boolean' ? q.channel_connected : null,
      });
    }
    return out;
  }

  // The link's heartbeatBody seam: its base (machine_id, beat, interval_ms,
  // connector_now, echo_at) and these rows.
  function heartbeatBody(base) {
    return { ...minimalHeartbeat(base), chats: heartbeatRows() };
  }

  // ── what other modules call ──────────────────────────────────────────────

  function statusOf(chatId) {
    const st = chats.get(chatId);
    if (!st || !CHAT_RE.test(chatId)) return null;
    return fullStatus(st, composeBody(st), Math.max(1, statusSeq));
  }

  function track(chat) {
    const id = chat && (chat.id != null ? chat.id : chat.chat_id);
    if (typeof id !== 'string' || !id) return;
    const st = stateOf(id);
    if (typeof chat.root === 'string') st.root = chat.root;
  }

  function forget(chatId) {
    const st = chats.get(chatId);
    if (!st) return;
    if (st.statusTimer) { try { d.clearTimeout(st.statusTimer); } catch {} }
    if (st.confirmTimer) { try { d.clearTimeout(st.confirmTimer); } catch {} }
    chats.delete(chatId);
  }

  function pollNow(chatId, { fresh = true } = {}) {
    const st = chats.get(chatId);
    return st ? poll(st, { fresh }) : Promise.resolve();
  }

  const api = { statusOf, heartbeatRows, heartbeatBody, track, forget, pollNow };

  // CONNECTOR@install-seam: the run context's one lifecycle (its fan-out and
  // its tick), its link ('ready' is the hello.ack, 'signals.open' the window),
  // its ring, supervisor and chats.
  function install(ctx) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
    if (ctx.signals && ctx.signals !== api) throw new Error('install: signals are already installed');
    lc = lc || ctx.lifecycle;
    ln = ln || ctx.link || null;
    rg = rg || ctx.ring || null;
    sup = sup || ctx.supervisor || null;
    if (!lc || typeof lc.subscribe !== 'function' || typeof lc.onTick !== 'function' || typeof lc.healthOf !== 'function') {
      throw new TypeError('install: a lifecycle (subscribe, onTick, healthOf) is required');
    }
    ctxRef = ctx;
    const undo = [];
    undo.push(lc.subscribe(onLifecycle));
    undo.push(lc.onTick(onTick));
    if (ln && typeof ln.on === 'function') {
      ln.on('ready', onReady);
      ln.on('signals.open', onSignalsOpen);
      undo.push(() => { ln.off('ready', onReady); ln.off('signals.open', onSignalsOpen); });
    }
    ctx.signals = api;
    return () => {
      for (const fn of undo.reverse()) { try { if (typeof fn === 'function') fn(); } catch {} }
      for (const id of [...chats.keys()]) forget(id);
      if (ctx.signals === api) delete ctx.signals;
      ctxRef = null;
    };
  }
  api.install = install;

  return api;
}

module.exports = {
  createSignals,
  cutAsk,
  cutRecord,
  READ_TIMEOUT_MS,
  STATUS_MIN_MS,
  LOCK_GONE_CONFIRM_MS,
  RESYNC_ORDER,
};

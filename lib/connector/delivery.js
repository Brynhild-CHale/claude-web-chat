'use strict';

// Queue delivery and the ledger (contract 07 §3.5, C-07.24 to C-07.29; 05
// §3.10, C-05.44 to C-05.46, and C-05.27's pause; tranche 6, U728).
//
//   createDelivery({ relay, ring, lifecycle, hubId, log, link, deps })
//     → { deliver(frame, link?), install(ctx), ledgerOf(hubMsgId) }
//
// The hub sends each hub-queued message as a `queue.deliver` frame (05's frame:
// 07's delivery body, the frame's `actor`, and a decision or a decision_ref).
// deliver() places it in the chat's daemon queue as ONE relayed
// POST /api/queue/message and answers the hub with 07's `queue.ack` only after
// the daemon answered.
//
// PER CHAT, ONE AT A TIME (C-07.26). The hub keeps one delivery unacknowledged
// per chat; a frame arriving for a chat whose delivery is still being answered
// waits behind it, so the daemon sees a chat's messages in arrival order and
// the second POST only after the first answered.
//
// THE STEPS, for each frame:
//   (1) PAUSED (05 C-05.27, ruling W3) — lifecycle.isPaused() → retry with the
//       word `paused` and retry_after_ms 0 (the hub redelivers after the
//       resume), no POST. Pause withholds deliveries only: the relay, a Stop
//       through it and every other relayed request are untouched here.
//   (2) THE LEDGER (C-07.29) — an entry for this hub_msg_id whose first answer
//       did not echo client_msg_id answers `duplicate` with the first msg_id
//       and `dedupe: 'connector'`, no POST. An entry whose daemon DID echo the
//       key is the daemon's to deduplicate: the POST goes again and the daemon
//       answers `duplicate: true` (dedupe 'daemon').
//   (3) EXPIRY (C-07.27, C-07.31) — deliver_within_ms elapsed since the frame
//       arrived, on the monotonic clock, before the POST → `expired`, no POST.
//       A message the ledger holds is never reported expired: it was accepted.
//   (4) THE POST through U717's one-shot relayed request, called by that name
//       (relay.request; U717-U728@one-shot-relayed-request (a)): the frame's
//       chat label and its decision (or decision_ref), the session origin,
//       POST /api/queue/message, the frame's message fields (text, skill,
//       files, send, conversation_id, device) plus client_msg_id = hub_msg_id,
//       and the frame's `actor` verbatim (C-05.44: never read from `from`). The
//       relay's gate refuses a chat not running here (404 → retry), a decision
//       or level that does not hold, or the machine's ceiling (403 → refused
//       with the gate's reason), before anything reaches a daemon; the relay
//       alone builds every upstream header and the remote marker, so the
//       delivery is never a host request (C-03.18, C-05.45).
//   (5) THE ANSWER, by C-07.27's table (outcomeOf below): ok with msg_id →
//       accepted; ok with duplicate → duplicate; refused rate_limited → retry
//       after retry_after seconds; too_many → retry after at least 5 s;
//       file_refused with why `unavailable` → retry after 10 s; no answer, a
//       5xx, a daemon that does not answer → retry after 10 s; any other
//       refused word → refused with the word.
//   (6) ON OK the ledger entry {hub_msg_id, msg_id, item_id, boot, dedupe} is
//       written BEFORE the ack (C-07.29): the boot from the answer's boot
//       header, else the ring's cursor boot, else a health read. dedupe is
//       'daemon' only when the answer echoed client_msg_id, else 'connector'.
//   (7) THE ACK (07-ack.json queueAck) through the link only now, as a reply
//       to the frame (`re`), and only on the connection the frame came in on:
//       a link that closed meanwhile gets no ack (the hub replays, C-07.28,
//       and the ledger or the daemon answers that replay `duplicate`). A POST
//       the daemon does not answer within 30 s (ANSWER_WAIT_MS) is not acked
//       at all: the message stays `delivering` at the hub. Its answer, if one
//       comes later, still writes the ledger, and a replay of the same
//       hub_msg_id waits for it before it consults the ledger.
//
// THE LEDGER (C-07.29): userPaths().connectorLedger(hubId), one JSON record
// through lib/core/fsjson (written whole, mode 0600, fsync), the last
// LEDGER_MAX entries in acceptance order. It holds ids and the boot token
// only: never message text, an actor, a decision or a header. A ledger that
// cannot be read is set aside (renameAside) and started empty; a write that
// fails is logged by code and the entry kept in memory for this process.
//
// NEVER here: a Push (C-05.46: a Push reaches a daemon only as a relayed
// request through the relay, never a queue frame, and nothing here sends one); a
// redelivery the connector starts (replay is the hub's, C-07.28); an ack
// before the daemon answered; a read of the frame's `from`; an upstream header
// spelled or built (the relay's one builder); message text in a log line, the
// ledger or an ack (C-11.20: ids, words and counts only).

const { performance } = require('perf_hooks');
const fsjson = require('../core/fsjson');
const { userPaths } = require('../core/paths');
const { ensureConnectorDir } = require('../setup/connector');
const { headerBoot } = require('./ring');

const ANSWER_WAIT_MS = 30 * 1000;        // C-07.27: no ack within 30 s leaves it delivering
const LEDGER_MAX = 1000;                 // C-07.29: a replay can only repeat recent ids
const LEDGER_VERSION = 1;
const LEDGER_MODE = 0o600;
const LEDGER_ASIDE_KEEP = 3;
const RETRY_UNREACHABLE_MS = 10 * 1000;  // C-07.27: after 06 starts the daemon or after 10 s
const RETRY_UNAVAILABLE_MS = 10 * 1000;  // file_refused with why `unavailable`
const RETRY_TOO_MANY_MS = 5 * 1000;      // too_many: at least 5 s
const RETRY_RATE_DEFAULT_MS = 10 * 1000; // rate_limited that named no retry_after
const PAUSED_RETRY_MS = 0;               // 07-ack.json: the hub redelivers after the resume
const MESSAGE_PATH = '/api/queue/message';
// The body fields POST /api/queue/message takes (07-queue-deliver.json
// `message`, a closed object); nothing else is copied.
const MESSAGE_FIELDS = Object.freeze(['text', 'skill', 'files', 'send', 'conversation_id', 'device']);

const HUB_MSG_ID_RE = /^hm_[0-9A-HJKMNP-TV-Z]{26}$/;
const CHAT_LABEL_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const MSG_ID_RE = /^m-[0-9a-f]{8}$/;
const WORD_RE = /^[a-z_]{1,32}$/;
const MODES = new Set(['held', 'queued', 'wake', 'parked', 'transported']);
const DEDUPES = new Set(['daemon', 'connector']);
const BOOT_MAX = 128;
const ITEM_ID_MAX = 64;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isBoot = (b) => typeof b === 'string' && b.length >= 1 && b.length <= BOOT_MAX;
const isItemId = (s) => typeof s === 'string' && s.length >= 1 && s.length <= ITEM_ID_MAX;

// A refusal word as 07-ack.json's `refused` admits it: the relay's gate speaks
// 04's reasons (`no-decision`, `host-only`), which travel with '_' for '-'.
function wordOf(w, fallback = 'bad_answer') {
  if (typeof w !== 'string') return fallback;
  const s = w.replace(/-/g, '_');
  return WORD_RE.test(s) ? s : fallback;
}

function parseBody(buf) {
  if (buf == null) return null;
  try {
    const v = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

// C-07.27's table over one relay.request answer ({status, headers, body,
// aborted?}, or null for none at all) and the hub_msg_id sent as
// client_msg_id. → one of
//   {outcome: 'accepted'|'duplicate', msg_id, item_id, mode?, echoed, boot}
//   {outcome: 'retry', retry_after_ms, refused?}
//   {outcome: 'refused', refused}
function outcomeOf(answer, clientMsgId) {
  const unreachable = { outcome: 'retry', retry_after_ms: RETRY_UNREACHABLE_MS };
  if (!answer || answer.aborted) return unreachable;
  const status = answer.status;
  const body = parseBody(answer.body);
  if (!Number.isInteger(status) || status >= 500) return unreachable;
  // The relay's gate step (1): the chat is not running here.
  if (status === 404 && body && body.connector === true) return unreachable;
  // The relay's gate (2)–(5), or the daemon's own refusal of the relayed level.
  if (status === 403) {
    const reason = body && isPlainObject(body.authority) ? body.authority.reason : null;
    return { outcome: 'refused', refused: wordOf(reason, 'forbidden') };
  }
  if (status !== 200 || !body) return { outcome: 'refused', refused: 'bad_answer' };
  if (body.ok === true) {
    if (typeof body.msg_id !== 'string' || !MSG_ID_RE.test(body.msg_id) || !isItemId(body.id)) {
      return { outcome: 'refused', refused: 'bad_answer' };
    }
    return {
      outcome: body.duplicate === true ? 'duplicate' : 'accepted',
      msg_id: body.msg_id,
      item_id: body.id,
      ...(MODES.has(body.mode) ? { mode: body.mode } : {}),
      echoed: typeof clientMsgId === 'string' && body.client_msg_id === clientMsgId,
      boot: headerBoot(answer.headers),
    };
  }
  if (body.ok === false && typeof body.refused === 'string') {
    const word = wordOf(body.refused);
    if (word === 'rate_limited') {
      const s = body.retry_after;
      const ms = Number.isInteger(s) && s >= 0 ? s * 1000 : RETRY_RATE_DEFAULT_MS;
      return { outcome: 'retry', retry_after_ms: ms, refused: word };
    }
    if (word === 'too_many') {
      const s = body.retry_after;
      const ms = Math.max(RETRY_TOO_MANY_MS, Number.isInteger(s) && s >= 0 ? s * 1000 : 0);
      return { outcome: 'retry', retry_after_ms: ms, refused: word };
    }
    if (word === 'file_refused' && body.why === 'unavailable') {
      return { outcome: 'retry', retry_after_ms: RETRY_UNAVAILABLE_MS, refused: word };
    }
    return { outcome: 'refused', refused: word };
  }
  return { outcome: 'refused', refused: 'bad_answer' };
}

// The ledger record's shape: {v: 1, entries: [{hub_msg_id, msg_id, item_id,
// boot, dedupe}]}. An entry that fails is dropped on read.
function entryOk(e) {
  return isPlainObject(e) && typeof e.hub_msg_id === 'string' && HUB_MSG_ID_RE.test(e.hub_msg_id)
    && typeof e.msg_id === 'string' && MSG_ID_RE.test(e.msg_id) && isItemId(e.item_id)
    && isBoot(e.boot) && DEDUPES.has(e.dedupe);
}

function createDelivery({
  relay, ring = null, lifecycle, hubId, log = () => {}, link = null, deps = {},
} = {}) {
  if (!relay || typeof relay.request !== 'function') throw new TypeError('createDelivery: relay (U717, with request) is required');
  if (!lifecycle || typeof lifecycle.isPaused !== 'function') throw new TypeError('createDelivery: lifecycle (with isPaused) is required');
  const d = {
    now: () => performance.now(),
    readJson: fsjson.readJson,
    writeJsonAtomic: fsjson.writeJsonAtomic,
    renameAside: fsjson.renameAside,
    ensureDir: ensureConnectorDir,
    setTimeout,
    clearTimeout,
    ...deps,
  };
  const ledgerFile = typeof hubId === 'string' ? userPaths().connectorLedger(hubId) : null;
  if (!ledgerFile) throw new TypeError('createDelivery: a hub id that names a ledger is required');
  const say = (line) => { try { log(line); } catch { /* the caller's */ } };

  // ── the ledger (C-07.29) ────────────────────────────────────────────────
  let ledger = null; // hub_msg_id → entry, in acceptance order
  function loadLedger() {
    if (ledger) return ledger;
    ledger = new Map();
    let r;
    try { r = d.readJson(ledgerFile); } catch { r = { corrupt: true }; }
    if (r && r.ok && isPlainObject(r.value) && r.value.v === LEDGER_VERSION && Array.isArray(r.value.entries)) {
      for (const e of r.value.entries) if (entryOk(e)) ledger.set(e.hub_msg_id, { ...e });
    } else if (r && !r.absent) {
      say('delivery ledger unreadable; set aside');
      try { d.renameAside(ledgerFile, { tag: 'corrupt', keep: LEDGER_ASIDE_KEEP }); } catch (e) {
        say(`delivery ledger not set aside code=${(e && e.code) || 'error'}`);
      }
    }
    return ledger;
  }
  function ledgerOf(hubMsgId) {
    const e = loadLedger().get(hubMsgId);
    return e ? { ...e } : null;
  }
  // Throws nothing: a failed write is logged and the entry stays in memory.
  function remember(entry) {
    const m = loadLedger();
    m.delete(entry.hub_msg_id);
    m.set(entry.hub_msg_id, entry);
    while (m.size > LEDGER_MAX) m.delete(m.keys().next().value);
    try {
      d.ensureDir();
      d.writeJsonAtomic(ledgerFile, { v: LEDGER_VERSION, entries: [...m.values()] }, { mode: LEDGER_MODE, fsync: true });
      return true;
    } catch (e) {
      say(`delivery ledger not written code=${(e && e.code) || 'error'}`);
      return false;
    }
  }

  // ── the link's connections ──────────────────────────────────────────────
  // A frame's ack goes only on the connection the frame came in on: each
  // 'closed' the link emits ends a connection.
  const gens = new WeakMap();
  function bind(lk) {
    if (!lk || typeof lk !== 'object') return null;
    let s = gens.get(lk);
    if (!s) {
      s = { gen: 0 };
      gens.set(lk, s);
      if (typeof lk.on === 'function') lk.on('closed', () => { s.gen += 1; });
    }
    return s;
  }

  // ── the boot an answer came from ────────────────────────────────────────
  async function bootFor(chat, answered) {
    if (isBoot(answered)) return answered;
    try {
      const c = ring && typeof ring.cursorOf === 'function' ? ring.cursorOf(chat) : null;
      if (c && isBoot(c.boot)) return c.boot;
    } catch { /* the ring's */ }
    try {
      const h = typeof lifecycle.healthOf === 'function' ? await lifecycle.healthOf(chat) : null;
      if (h && isBoot(h.boot)) return h.boot;
    } catch { /* the lifecycle's */ }
    return 'unknown';
  }

  // ── one POST ────────────────────────────────────────────────────────────
  const inflight = new Map(); // hub_msg_id → the settling of its POST
  function postOnce(frame, del) {
    const message = isPlainObject(del.message) ? del.message : {};
    const out = {};
    for (const k of MESSAGE_FIELDS) if (Object.prototype.hasOwnProperty.call(message, k)) out[k] = message[k];
    out.client_msg_id = del.hub_msg_id;
    const bytes = Buffer.from(JSON.stringify(out));
    const req = {
      chat: del.chat_id,
      surface: 'session',
      method: 'POST',
      path: MESSAGE_PATH,
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) },
      body: bytes,
      actor: frame.actor,
    };
    if (frame.decision != null) req.decision = frame.decision;
    else if (frame.decision_ref != null) req.decision_ref = frame.decision_ref;
    // The settling: the outcome, with the ledger written on ok — whether or
    // not anyone is still waiting to ack it.
    const p = Promise.resolve()
      .then(() => relay.request(req))
      .then((answer) => answer, () => null)
      .then(async (answer) => {
        const o = outcomeOf(answer, del.hub_msg_id);
        if (o.outcome === 'accepted' || o.outcome === 'duplicate') {
          o.boot = await bootFor(del.chat_id, o.boot);
          o.dedupe = o.echoed ? 'daemon' : 'connector';
          o.ledgerWritten = remember({
            hub_msg_id: del.hub_msg_id, msg_id: o.msg_id, item_id: o.item_id, boot: o.boot, dedupe: o.dedupe,
          });
        }
        return o;
      });
    inflight.set(del.hub_msg_id, p);
    p.then(() => { if (inflight.get(del.hub_msg_id) === p) inflight.delete(del.hub_msg_id); });
    return p;
  }

  // The settling, or null when ANSWER_WAIT_MS passes first.
  function withinWait(p) {
    let timer;
    const late = new Promise((resolve) => {
      timer = d.setTimeout(() => resolve(null), ANSWER_WAIT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([p, late]).finally(() => d.clearTimeout(timer));
  }

  function ackOf(del, outcome, extra = {}) {
    return { type: 'queue.ack', hub_msg_id: del.hub_msg_id, chat_id: del.chat_id, attempt: del.attempt, outcome, ...extra };
  }
  function daemonOf(e) {
    return { boot: e.boot, msg_id: e.msg_id, item_id: e.item_id, ...(e.mode ? { mode: e.mode } : {}) };
  }

  // ── one frame ───────────────────────────────────────────────────────────
  async function handle(frame, del, receivedAt) {
    // (1) paused
    let isPaused = false;
    try { isPaused = lifecycle.isPaused() === true; } catch { isPaused = false; }
    if (isPaused) return ackOf(del, 'retry', { refused: 'paused', retry_after_ms: PAUSED_RETRY_MS });
    // A replay of a POST still being answered waits for that answer first.
    const pending = inflight.get(del.hub_msg_id);
    if (pending) await pending.then(null, () => null);
    // (2) the ledger
    const prior = ledgerOf(del.hub_msg_id);
    if (prior && prior.dedupe === 'connector') {
      return ackOf(del, 'duplicate', { daemon: daemonOf(prior), dedupe: 'connector' });
    }
    // (3) expiry, on the monotonic clock from receipt (never for a message the ledger holds)
    if (!prior && Number.isInteger(del.deliver_within_ms) && d.now() - receivedAt >= del.deliver_within_ms) {
      return ackOf(del, 'expired');
    }
    // (4)–(6) the POST, its answer and the ledger
    const o = await withinWait(postOnce(frame, del));
    if (!o) return null;
    if (o.outcome === 'accepted' || o.outcome === 'duplicate') {
      return ackOf(del, o.outcome, { daemon: daemonOf(o), dedupe: o.dedupe });
    }
    if (o.outcome === 'retry') {
      return ackOf(del, 'retry', { retry_after_ms: o.retry_after_ms, ...(o.refused ? { refused: o.refused } : {}) });
    }
    return ackOf(del, 'refused', { refused: o.refused });
  }

  // (7) the ack, on the connection the frame came in on, and only now.
  function sendAck(lk, conn, frame, ack, chat) {
    if (!ack) {
      say(`delivery ${chat} unanswered; no ack`);
      return null;
    }
    const tag = `delivery ${ack.hub_msg_id} ${ack.outcome}${ack.refused ? ` ${ack.refused}` : ''}`;
    if (!lk || typeof lk.send !== 'function' || (conn && conn.at !== conn.state.gen)) {
      say(`${tag}; link changed, no ack`);
      return null;
    }
    try {
      const id = lk.send('queue', 'queue.ack', { ack }, { re: frame.id });
      if (!id) { say(`${tag}; ack not sent`); return null; }
    } catch (e) {
      say(`${tag}; ack not sent code=${(e && e.code) || 'error'}`);
      return null;
    }
    say(tag);
    return ack;
  }

  // ── per chat, one at a time ─────────────────────────────────────────────
  const tails = new Map(); // chat label → the last frame's settling
  function deliver(frame, viaLink) {
    const receivedAt = d.now();
    const lk = viaLink || link;
    const s = bind(lk);
    const conn = s ? { state: s, at: s.gen } : null;
    const del = isPlainObject(frame) ? frame.delivery : null;
    // An ack must name what 07-ack.json requires; a body without them is
    // dropped (05's frame table checks the top level only).
    if (!isPlainObject(del) || typeof del.hub_msg_id !== 'string' || !HUB_MSG_ID_RE.test(del.hub_msg_id)
      || typeof del.chat_id !== 'string' || !CHAT_LABEL_RE.test(del.chat_id)
      || !Number.isInteger(del.attempt) || del.attempt < 1 || typeof frame.id !== 'string') {
      say('delivery dropped code=malformed');
      return Promise.resolve(null);
    }
    const chat = del.chat_id;
    const prev = tails.get(chat) || Promise.resolve();
    const run = prev.then(() => handle(frame, del, receivedAt)).then(
      (ack) => sendAck(lk, conn, frame, ack, chat),
      () => { say(`delivery ${del.hub_msg_id} failed; no ack`); return null; },
    );
    tails.set(chat, run);
    run.then(() => { if (tails.get(chat) === run) tails.delete(chat); });
    return run;
  }

  const api = { deliver, ledgerOf };

  // CONNECTOR@install-seam: U790 hands the run context; with a link in it the
  // delivery hears the hub's queue.deliver frames here (the one registration).
  function install(ctx) {
    if (!ctx || typeof ctx !== 'object') throw new TypeError('install: a context object is required');
    if (ctx.delivery && ctx.delivery !== api) throw new Error('install: a delivery is already installed');
    ctx.delivery = api;
    const lk = ctx.link || link;
    let off = null;
    if (lk) {
      if (!link) link = lk;
      bind(lk);
      off = lk.channel('queue', { kinds: ['queue.deliver'], handle: (f) => deliver(f, lk) });
    }
    return () => {
      if (typeof off === 'function') off();
      if (ctx.delivery === api) delete ctx.delivery;
    };
  }
  api.install = install;
  return api;
}

module.exports = {
  createDelivery,
  outcomeOf,
  ANSWER_WAIT_MS,
  LEDGER_MAX,
  LEDGER_MODE,
  RETRY_UNREACHABLE_MS,
  RETRY_UNAVAILABLE_MS,
  RETRY_TOO_MANY_MS,
  MESSAGE_PATH,
  MESSAGE_FIELDS,
};

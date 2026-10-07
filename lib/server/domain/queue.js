// lib/server/domain/queue.js — the wake queue domain.
//
// Stateless like turns.js: every fn receives the live `state` (which owns the
// `queue` array + `queueSeq` counter) and the change `bus`. No module-level
// state, no bus construction.
//
// The queue is the DEFAULT wake path. Wake-worthy bus events — captures and
// browser-sourced declared-signal writes — are classified (lib/channel/policy)
// and folded into server-side queue items. Nothing wakes Claude on its own: the
// user hitting "Push → Claude" flushes the whole queue into ONE `wake` event,
// which the channel bridge (MCP process) turns into a single
// notifications/claude/channel. The deliberate-handoff ritual is preserved.
//
// `emitWake` is the SINGLE place a `wake` event is emitted — both the queue
// flush and the immediate-wake path (a pane's `wake:'immediate'` signal) go
// through it, so "what wakes Claude" is exactly "who calls emitWake". A `wake`
// event is emit-only: it never carries a WS frame (browsers don't consume it;
// it's the bridge's channel, fetched over SSE with kinds:['wake']).

const crypto = require('crypto');
const { deleteComment } = require('./comments');
const { wakeEnvelope } = require('../../channel/envelope');
const { messageMarker } = require('../../core/prompt-class');
const { atLeast } = require('../../core/remote-policy');
const { QUEUED_MESSAGES_MAX } = require('../composer');
const { mergeActivity } = require('../../channel/policy');
const { acquireWakeLock } = require('./turns');
const { removeMount, emitMount } = require('./mounts');
const { patchStore } = require('./store');

// Memory backstop: a pathological producer (a chatty signal, a capture flood)
// must not grow the queue — and therefore draft.json — without bound. Kept
// generous so real triage/refine flows never hit it; over the cap we drop the
// oldest STAGED item (never a HELD one until forced).
const MAX_QUEUE = 500;

// Channel-liveness window: a wake-consumer (the bridge) whose heartbeat is
// staler than this counts as gone, so flush parks rather than firing into a
// zombie stream. 2.5× the bridge's ~10s heartbeat interval, so a single missed
// beat doesn't flap the channel dead.
const CONSUMER_TTL_MS = 25_000;
// An un-acked in-flight wake older than this is presumed lost and folds into a
// parked wake (delivered on the user's next message) — the closed-tab backstop.
// Comfortably longer than the rail's client-side ack timeout (~6s), so a wake
// the user is still actively watching in the rail is never folded out from
// under them.
const ACK_STALE_MS = 20_000;
// The live consumers a release can be aimed at (§6.4 Targeting): at most this
// many process ids are remembered, the least recently seen dropped first.
const CHANNEL_PIDS_MAX = 32;

// The ONE staged predicate: items are staged by default; held is the
// explicit opt-out. The client keeps its own copy (public/app/queue.js) — this is
// the domain-side home so the four open-coded `staged !== false`/`=== false` reads
// can't drift apart.
const isStaged = (it) => it.staged !== false;

// ── Message items (spec §6.1) ─────────────────────────────────────────────
// A composer message, or a stop request (§6.9), is an item of THIS queue,
// `kind: 'message'`: one id space, one add frame, one Push, one park, one
// draft. What sets it apart:
//   * its text is the user's own words, so it never rides a ring copy, a
//     WebSocket frame or a lock (C34): publicItem is the one copy function for
//     every event and frame, and list() hides the text below `read`;
//   * MAX_QUEUE never evicts one (QUEUED_MESSAGES_MAX caps them instead);
//   * a Revert of one is a plain remove (revertArtifact answers false).
// The one place the text travels is the `wake` event's batch: ring and SSE
// only, never a WebSocket frame, because the bridge builds the envelope from
// it (lib/channel/envelope, the message block).
const isMessage = (it) => !!it && it.kind === 'message';

// The fields of a message item a frame, the ring and a viewer below `read`
// may see. A whitelist, not a blacklist: a field a later unit adds stays off
// the wire until it is named here.
const PUBLIC_MESSAGE_KEYS = [
  'staged', 'kind', 'msg_id', 'conversation_id', 'chars', 'source', 'task_id', 'autosend',
  'why_wake', 'summary', 'origin', 'device', 'id', 'enqueued_at', 'waiting',
];

// The ONE copy of a queue item that leaves the domain on the bus: every other
// kind is copied whole (F7 — no live reference in the ring, key order kept, so
// test/bus-golden.test.js is byte-identical); a message item keeps its counts,
// labels and state and loses `text`, the skill's args and the file paths.
function publicItem(item) {
  if (!isMessage(item)) return { ...item };
  const out = {};
  for (const k of PUBLIC_MESSAGE_KEYS) if (Object.hasOwn(item, k)) out[k] = item[k];
  out.skill = item.skill && typeof item.skill.name === 'string' ? { name: item.skill.name } : null;
  out.files_count = Array.isArray(item.files) ? item.files.length : 0;
  return out;
}

// A copy for a viewer at `read` or above: the whole item, nested values copied.
function fullItem(item) {
  const out = { ...item };
  if (isMessage(item)) {
    if (item.skill && typeof item.skill === 'object') out.skill = { ...item.skill };
    if (Array.isArray(item.files)) out.files = item.files.map((f) => ({ ...f }));
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The text-free label a message item shows everywhere (the rail, the parked
// items, a basic viewer): its length, the skill's name and the file count —
// never a word of the text, the args or a path. A stop request names its task
// id only, never the task's (model-written) title (§6.9).
function messageSummary(item) {
  if (item.source === 'task-stop') return `stop request · ${item.task_id}`;
  let s = `message · ${plural(item.chars, 'char')}`;
  if (item.skill && typeof item.skill.name === 'string') s += ` · /${item.skill.name}`;
  const n = Array.isArray(item.files) ? item.files.length : 0;
  if (n) s += ` · ${plural(n, 'file')}`;
  return s;
}

// A message the user typed, as against a stop request (§6.9). The one-message
// park rule and Take back count these; a stop request is exempt from both
// (ruling C1 (a)): it parks beside a message and stays parked on a Take back.
const isTypedMessage = (it) => isMessage(it) && it.source !== 'task-stop';

function isMessageId(id) {
  try { messageMarker(id); return true; } catch { return false; }
}

// Every msg_id the queue, the park or the retained in-flight batch holds, and
// every one a receipt still remembers.
function messageIdsInUse(state) {
  const ids = new Set();
  const add = (list) => { for (const it of list || []) if (isMessage(it)) ids.add(it.msg_id); };
  add(state.queue);
  add(state.pendingWake && state.pendingWake.batch);
  add(state.pendingAck && state.pendingAck.batch);
  if (state.messageReceipts instanceof Map) for (const id of state.messageReceipts.keys()) ids.add(id);
  return ids;
}

// 'm-' and 8 random hex: the transcript marker (§6.5). Random, so a marker
// from an earlier boot never matches; re-minted on a collision with any id
// still queued, parked, awaiting its ack or remembered by a receipt (a final
// receipt never moves, so a reused id would leave the new message without one).
function mintMessageId(state) {
  const used = messageIdsInUse(state);
  for (;;) {
    const id = `m-${crypto.randomBytes(4).toString('hex')}`;
    if (!used.has(id)) return id;
  }
}

function queuedMessageCount(state) {
  return state.queue.filter(isMessage).length;
}

// ── Receipts (spec §6.6) ──────────────────────────────────────────────────
// Each message's delivery, told honestly: `state.messageReceipts`, a Map
// msg_id → {msg_id, state, at, seq?, boot?, park_id?, conversation_id?},
// created lazily, in creation order, at most RECEIPTS_MAX (the oldest
// dropped). Like channelPids it describes this boot only: it never rides
// draft.json (graph.snapshotLive picks its fields by name and names none of
// this), so after a restart a message the draft brought back has no receipt
// until a queue path next moves it.
//
// One setter, noteReceipt, and only the queue's own paths call it: enqueue →
// queued; a wake → sending; the bridge's ack → sent (transmission only, never
// "delivered": V11); a park, or a retained wake folded into one → parked; the
// turn-begin hook's consume → handed_over; a discard of the park (the rail's
// Cancel) → failed; a Take back → queued; the transport seam taking it → sent.
// 'confirmed' comes only from the transcript (confirmDelivered, which U63
// calls on the mirror's `delivered` transition) and 'unconfirmed' only from
// U63's timer (markUnconfirmed): nothing in this module emits it by itself.
// Receipts carry no word of the message, so every step's frame and ring event
// go out as they are, at every level.
const RECEIPTS_MAX = 50;
const RECEIPT_STATES = ['queued', 'sending', 'sent', 'parked', 'handed_over', 'confirmed', 'unconfirmed', 'failed'];
// The forward graph: a step not listed here is ignored. sending → parked is a
// fold (the wake's ack never came); parked → queued is a Take back; parked →
// sending is a drain; confirmed and failed are final.
const RECEIPT_NEXT = {
  queued: ['sending', 'parked', 'failed'],
  sending: ['sent', 'parked', 'confirmed'],
  sent: ['confirmed', 'unconfirmed'],
  parked: ['handed_over', 'queued', 'sending', 'failed', 'confirmed'],
  handed_over: ['confirmed', 'unconfirmed'],
  unconfirmed: ['confirmed'],
  confirmed: [],
  failed: [],
};
// What a step may stamp on the record besides its state. seq and boot are the
// wake's (the ack correlates them); park_id the park's; none is content.
const RECEIPT_EXTRA_KEYS = ['seq', 'boot', 'park_id', 'conversation_id'];

function receiptMap(state) {
  if (!(state.messageReceipts instanceof Map)) state.messageReceipts = new Map();
  return state.messageReceipts;
}

function applyReceiptExtra(rec, next, extra) {
  // A record keeps only what its state still means: a wake's seq and boot
  // while sending or later, a park's id while parked or later.
  if (next === 'queued') { delete rec.seq; delete rec.boot; delete rec.park_id; }
  if (next === 'sending') delete rec.park_id;
  if (!extra || typeof extra !== 'object') return;
  for (const k of RECEIPT_EXTRA_KEYS) {
    const v = extra[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' || Number.isFinite(v)) rec[k] = v;
  }
}

// THE setter. Moves msg_id's receipt to `next` when the forward graph allows
// it, stamps `extra`'s fields, and emits one content-free pair: the frame
// {type: 'queue', op: 'receipt', msg_id, state, at} and the ring event
// {kind: 'queue', op: 'receipt', msg_id, state}. An illegal step is ignored. A
// step to the state the receipt is already in emits nothing but refreshes
// `extra` (a re-merged park's new id, a retried wake's new seq). A receipt
// that does not exist yet is created at `next` — by enqueue, or by a later
// queue path for a message the draft brought back or the bound dropped —
// except at 'confirmed' or 'unconfirmed': those name a message this boot is
// tracking, never a new one. Answers whether the state moved.
function noteReceipt(state, bus, msg_id, next, extra = {}) {
  if (!isMessageId(msg_id) || !RECEIPT_STATES.includes(next)) return false;
  const map = receiptMap(state);
  let rec = map.get(msg_id);
  if (!rec) {
    if (next === 'confirmed' || next === 'unconfirmed') return false;
    rec = { msg_id, state: next, at: Date.now() };
    applyReceiptExtra(rec, next, extra);
    map.set(msg_id, rec);
    while (map.size > RECEIPTS_MAX) map.delete(map.keys().next().value);
  } else if (rec.state === next) {
    applyReceiptExtra(rec, next, extra);
    return false;
  } else {
    if (!RECEIPT_NEXT[rec.state].includes(next)) return false;
    rec.state = next;
    rec.at = Date.now();
    applyReceiptExtra(rec, next, extra);
  }
  if (bus) {
    bus.emit({
      event: { kind: 'queue', op: 'receipt', msg_id, state: next },
      ws: { type: 'queue', op: 'receipt', msg_id, state: next, at: rec.at },
    });
  }
  return true;
}

// noteReceipt for every message item of a batch (a wake's, a park's, an ack's).
function noteBatchReceipts(state, bus, batch, next, extra) {
  if (!bus || !Array.isArray(batch)) return;
  for (const it of batch) if (isMessage(it)) noteReceipt(state, bus, it.msg_id, next, extra);
}

// Every message the park holds is parked, under the park's CURRENT id: a merge
// re-stamps it, so the ones already parked only have park_id refreshed.
// `offered` is what went into the park — the previous park's batch and the
// batch merged into it (parkAndNote passes it): a message among them that the
// park no longer holds was evicted by parkWake's MAX_QUEUE cap, so its receipt
// says 'failed', never 'parked' for a message that is gone. One the cap took
// before it was ever parked (a folded wake's, still sending) steps through
// parked, the only way the receipt graph reaches failed from there.
function noteParked(state, bus, park, offered) {
  if (!park) return;
  if (bus && Array.isArray(offered)) {
    const kept = new Set(park.batch.filter(isMessage).map((it) => it.msg_id));
    for (const it of offered) {
      if (!isMessage(it) || kept.has(it.msg_id)) continue;
      if (noteReceipt(state, bus, it.msg_id, 'failed')) continue;
      if (noteReceipt(state, bus, it.msg_id, 'parked')) noteReceipt(state, bus, it.msg_id, 'failed');
    }
  }
  noteBatchReceipts(state, bus, park.batch, 'parked', { park_id: park.id });
}

// The mirror saw the message's marker in the transcript (§2.5, §6.6): the one
// way a receipt says 'confirmed'. `marker` is the msg_id a mirror `delivered`
// transition carries (lib/server/mirror/transcripts.js). Moves a receipt from
// any state but queued and failed (the graph's own rule); an unknown marker —
// an earlier boot's, or a message the bound dropped — is ignored. U63 calls it.
function confirmDelivered(state, bus, marker) {
  return noteReceipt(state, bus, marker, 'confirmed');
}

// U63's timer found no marker in time (§6.6's three minutes, only while the
// mirror tails the conversation and, for a live send, only once
// CONFIRM_VERIFIED): sent or handed_over → unconfirmed, nothing else.
function markUnconfirmed(state, bus, msg_id) {
  const rec = state.messageReceipts instanceof Map ? state.messageReceipts.get(msg_id) : null;
  if (!rec || (rec.state !== 'sent' && rec.state !== 'handed_over')) return false;
  return noteReceipt(state, bus, msg_id, 'unconfirmed');
}

// The receipts as GET /api/queue serves them, at every level: content-free.
function receiptsList(state) {
  if (!(state.messageReceipts instanceof Map)) return [];
  return [...state.messageReceipts.values()].map((r) => ({ msg_id: r.msg_id, state: r.state, at: r.at }));
}

// ── Push provenance ───────────────────────────────────────────────────────
// Where a push came from, so Claude can adapt its answer: `origin` is 'remote'
// when the request arrived through the tunnel portal (lib/core/cors
// isRemoteRequest — the user is likely nowhere near the Claude Code terminal)
// and 'local' otherwise; `device` is 'mobile' when the chrome was in its phone
// view (public/app/viewport.js, sent with the push) and 'desktop' otherwise,
// falling back to the User-Agent's `Mobile` token when the chrome said nothing
// (a script, an older chrome). Every wake producer — flush, repush, the
// immediate-signal path, a park and its drain — carries the pair through to the
// wake event, the park and the envelope (lib/channel/envelope). A label only:
// nothing is granted or refused on it.
const ORIGINS = ['local', 'remote'];
const DEVICES = ['desktop', 'mobile'];
const MOBILE_UA = /\bMobile\b/;

function provenance({ remote = false, device, userAgent } = {}) {
  const claimed = DEVICES.includes(device) ? device : null;
  return {
    origin: remote ? 'remote' : 'local',
    device: claimed || (MOBILE_UA.test(String(userAgent || '')) ? 'mobile' : 'desktop'),
  };
}

// The provenance fields of `o`, only the valid ones — so a caller with none
// (a driver's flush, a park restored from an older draft) leaves every shape
// byte-identical to before.
function provFields(o) {
  const out = {};
  if (o && ORIGINS.includes(o.origin)) out.origin = o.origin;
  if (o && DEVICES.includes(o.device)) out.device = o.device;
  return out;
}

// The ONE queue-remove frame. Every removal — overflow eviction, a
// user Revert, an un-share dequeue, and the batched flush — emits this single
// shape on BOTH the bus event and the WS frame, with a `reason` naming the cause
// ('dropped' | 'evicted-held' | 'reverted' | 'removed' | 'flushed'). Previously
// three divergent shapes (dropped:true / reverted:bool / flushed:true), two absent
// from the WS frame; the client rebuilt the rail per frame. `ids` is authoritative;
// a single-id removal also carries `id` as a back-compat alias for single-id
// consumers (the F5 navigation test, any residual `msg.id` reader).
function emitRemove(state, bus, ids, reason, prov) {
  // A flush's remove also names who pushed (provFields — absent otherwise), so
  // the event log records a PARKED push too, which emits no wake event.
  const event = { kind: 'queue', op: 'remove', ids, reason, ...provFields(prov) };
  const ws = { type: 'queue', op: 'remove', ids, reason, count: state.queue.length };
  if (ids.length === 1) { event.id = ids[0]; ws.id = ids[0]; }
  bus.emit({ event, ws });
}

// ── The pre-run form baseline ─────────────────────────────────────────────
// A Revert of an activity/signal item restores the pane's form values to what
// they were BEFORE the user's current run of interaction. Stamping that at
// enqueue is too late: the shell's debounced `pane:form` snapshot usually lands
// before the click/change that opens the item, so the "baseline" already held
// the typed values and Revert restored exactly what it was meant to undo.
//
// So the baseline is taken when the FIRST `pane:form` of a run arrives (ws.js
// calls noteFormBaseline before replacing form_state) and held until the run is
// handed off — every non-inert Push starts a fresh run for every pane, because
// what the user had typed by then was Claude-visible (list_mounts) and must
// survive a later Revert. Keyed by the mount RECORD in a WeakMap, not by id: a
// re-render or a node restore builds a new record, so a baseline can never
// outlive the content it describes, and nothing here rides draft.json or a node.
function formBaselines(state) {
  if (!state.formBaselines) state.formBaselines = new WeakMap();
  return state.formBaselines;
}

function noteFormBaseline(state, mount) {
  if (!mount) return;
  const b = formBaselines(state);
  if (!b.has(mount)) b.set(mount, mount.form_state ? { ...mount.form_state } : null);
}

// The form values a Revert should put back: the run's baseline when one was
// noted, else the pane's values right now (no pane:form yet this run, so they
// are still the pre-run values).
function preRunFormState(state, mount) {
  const b = formBaselines(state);
  const v = b.has(mount) ? b.get(mount) : mount.form_state;
  return v ? { ...v } : null;
}

// Enqueue an item produced by policy.classify (which carries no id — the queue
// owns identity). Emits a `queue` add event + a WS frame the rail folds. Returns
// the stored item. `prior` is the store write's pre-write values (the bus hands
// them to the classify subscriber as meta — see domain/store.patchStore); a
// signal item keeps its key's entry so a Revert can restore it.
function enqueue(state, bus, item, { prior } = {}) {
  const id = `q${++state.queueSeq}`;
  // `staged: true` — new items go on the next Push by default; the user can hold
  // one back (staged:false) so it stays in the queue but isn't sent.
  const stored = { staged: true, ...item, id, enqueued_at: Date.now() };
  // B6: stamp the origin pane's current generation so a later Revert can tell a
  // still-current pane from a same-id re-render (see revertCapturePane). Only when the
  // mount actually carries a gen — a gen-less mount leaves origin_gen unset so the
  // pre-B6 revert (delete-if-present) still applies.
  const originMount = stored.origin_mount && state.mounts.get(stored.origin_mount);
  if (originMount && originMount.gen != null) stored.origin_gen = originMount.gen;
  // An ACTIVITY or SIGNAL item stands for what the USER did in a pane, so its
  // Revert has to undo the interaction — which means remembering the pane's form
  // values from BEFORE this run (preRunFormState). Stamped once, on the item that
  // starts a rolling activity run (coalesce merges into it afterwards).
  if (isInteraction(stored) && originMount) {
    stored.origin_form_state = preRunFormState(state, originMount);
  }
  // A signal item also remembers its key's pre-write value (`{had, value}`), so a
  // Revert takes the signal back out of the store, not just the typed values.
  const key = stored.kind === 'signal' ? stored.signal_key : null;
  if (key && prior && Object.hasOwn(prior, key)) stored.origin_store = { [key]: prior[key] };
  state.queue.push(stored);
  // F7: the event/WS carry a COPY — setStaged mutates the live item in place, and
  // a shared reference would retroactively rewrite the served ADD event in the ring.
  // publicItem: a message's text, args and paths never ride the ring or a frame.
  const copy = publicItem(stored);
  bus.emit({
    event: { kind: 'queue', op: 'add', id, item: copy },
    ws: { type: 'queue', op: 'add', item: copy, count: state.queue.length },
  });
  while (state.queue.length > MAX_QUEUE) {
    // B3: evict the OLDEST STAGED item first — a HELD item is the user's
    // deliberately-deferred handoff, so skip held items until only held remain. A
    // forced held eviction (nothing staged left) carries a distinct reason so it
    // isn't a silent loss of the user's deferred work. Neither pass ever takes a
    // MESSAGE: the user's words are capped by QUEUED_MESSAGES_MAX instead.
    let idx = state.queue.findIndex((it) => isStaged(it) && !isMessage(it));
    const forcedHeld = idx < 0;
    if (forcedHeld) idx = state.queue.findIndex((it) => !isMessage(it));
    if (idx < 0) break;
    const [dropped] = state.queue.splice(idx, 1);
    emitRemove(state, bus, [dropped.id], forcedHeld ? 'evicted-held' : 'dropped');
  }
  return stored;
}

// Enqueue a composer message (or a stop request) as a `kind: 'message'` item —
// through enqueue, so it shares the id space, the add frame and draft.json.
// `message` is what the composer's validation answered ({text, skill, files,
// chars, conversation_id}; lib/server/composer validateMessage): the skill is
// stored exactly as validated, {name, args} | {name, args_in_text: true} |
// null. Answers the stored item, or {refused: 'too_many'} when
// QUEUED_MESSAGES_MAX message items are already queued.
function enqueueMessage(state, bus, message, {
  source = 'composer', task_id, conversation_id = null, autosend, staged, origin, device,
} = {}) {
  if (queuedMessageCount(state) >= QUEUED_MESSAGES_MAX) return { refused: 'too_many' };
  const m = message || {};
  const text = typeof m.text === 'string' ? m.text : '';
  const files = Array.isArray(m.files) ? m.files.map((f) => ({ path: f.path, bytes: f.bytes })) : [];
  const item = {
    kind: 'message',
    msg_id: mintMessageId(state),
    conversation_id: conversation_id != null ? conversation_id : (m.conversation_id ?? null),
    text,
    skill: m.skill && typeof m.skill === 'object' ? { ...m.skill } : null,
    files,
    autosend: autosend === true,
    staged: staged !== false,
    chars: Number.isFinite(m.chars) ? m.chars : text.length,
    source,
  };
  if (task_id != null) item.task_id = String(task_id);
  item.why_wake = 'message from the user';
  Object.assign(item, provFields({ origin, device }));
  item.summary = messageSummary(item);
  const stored = enqueue(state, bus, item);
  const extra = stored.conversation_id != null ? { conversation_id: stored.conversation_id } : {};
  noteReceipt(state, bus, stored.msg_id, 'queued', extra);
  return stored;
}

// Replace a queued (or held) message's text, skill and files with an edit the
// composer's validation accepted (validateEdit's message), refreshing chars and
// the summary. One `queue` update frame, through publicItem. Answers the item,
// or null when the id is no longer a queued composer message.
function editMessage(state, bus, id, message) {
  const it = state.queue.find((q) => q.id === id);
  if (!isMessage(it) || it.source === 'task-stop' || !message) return null;
  it.text = typeof message.text === 'string' ? message.text : '';
  it.skill = message.skill && typeof message.skill === 'object' ? { ...message.skill } : null;
  it.files = Array.isArray(message.files) ? message.files.map((f) => ({ path: f.path, bytes: f.bytes })) : [];
  it.chars = Number.isFinite(message.chars) ? message.chars : it.text.length;
  it.summary = messageSummary(it);
  const copy = publicItem(it);
  bus.emit({
    event: { kind: 'queue', op: 'update', id, item: copy },
    ws: { type: 'queue', op: 'update', id, item: copy, staged: it.staged, count: state.queue.length },
  });
  return it;
}

// Fold an ACTIVITY item into the queue: ONE rolling item per origin mount. A
// match merges counts/keys and re-summarizes in place (op:'update' — the rail
// row ticks up instead of stacking a row per click); no match enqueues a fresh
// item. A HELD match still merges — holding defers delivery, it doesn't fork a
// second item for the same pane.
function coalesce(state, bus, item) {
  const match = state.queue.find(
    (it) => it.kind === 'activity' && (it.origin_mount || null) === (item.origin_mount || null)
  );
  if (!match) return enqueue(state, bus, item);
  mergeActivity(match, item);
  match.last_at = Date.now();
  const copy = { ...match }; // F7: no live reference in the ring
  bus.emit({
    event: { kind: 'queue', op: 'update', id: match.id, item: copy },
    ws: { type: 'queue', op: 'update', id: match.id, item: copy, staged: match.staged, count: state.queue.length },
  });
  return match;
}

// Snapshot of the current queue (defensive copies) for a viewer at `level`
// (lib/core/remote-policy MIRROR_LEVELS): at `read` or above ('local'
// included) every item whole; below, a message item is its publicItem with
// `text_hidden: true` (C34). No level is the narrowest: fail closed.
function list(state, { level } = {}) {
  const full = atLeast(level, 'read');
  return state.queue.map((it) => {
    if (!isMessage(it)) return { ...it };
    return full ? fullItem(it) : { ...publicItem(it), text_hidden: true };
  });
}

// The kinds whose artifact is the USER'S INTERACTION with a pane that someone
// else (Claude, a driver) rendered — their Revert undoes the interaction and
// never removes the pane (revertInteraction).
function isInteraction(item) {
  return item.kind === 'activity' || item.kind === 'signal';
}

// Drop the pane a CAPTURE item rendered — the one kind whose artifact IS a pane
// (a page capture mounted into the surface). Only fires when the item remembers
// an origin mount that still exists. Emits a clear frame so browsers drop it too.
// Never reached for any other kind: every other pane was rendered by Claude or a
// driver, and deleting it threw their work away.
function revertCapturePane(state, bus, mountId, originGen) {
  const mount = mountId && state.mounts.get(mountId);
  if (!mount) return false;
  // B6: a stable-id re-render replaces a pane's content but keeps the id and
  // bumps its gen, so removeMount's `originGen` guard fires the Revert only
  // while the CURRENT pane is still the one the item stamped.
  return removeMount(state, bus, { id: mountId, source: 'queue-revert', originGen });
}

// Revert an ACTIVITY or SIGNAL item's artifact: the artifact is the USER'S
// INTERACTION, not the pane. The pane was rendered by Claude (or a driver),
// usually turns earlier, and it is still the surface the user is looking at — so
// deleting it threw away someone else's work and, for a service-backed pane,
// stopped its service. Instead:
//   * the pane's form values go back to the pre-run baseline, and the pane is
//     re-emitted so every browser remounts it with them (the pane stays);
//   * a signal item's key goes back to its pre-write value (or is removed, if it
//     was absent) as a `queue-revert` store write — server-sourced, so it can
//     never enqueue or wake. Skipped when a later write of the same signal has
//     superseded this one (its `seq` moved on): that write is not ours to undo.
// (Undeclared store writes an activity item also counted are NOT restored —
// their pre-write values were never captured; the item's `keys` still name them.)
// Returns whether anything was restored.
function revertInteraction(state, bus, item) {
  const storeReverted = revertSignalKey(state, bus, item);
  const mountId = item.origin_mount;
  const mount = mountId && state.mounts.get(mountId);
  if (!mount) return storeReverted;
  // Same generation check as revertCapturePane: a same-id re-render replaced the
  // content this item's baseline belonged to.
  if (item.origin_gen != null && mount.gen != null && item.origin_gen !== mount.gen) return storeReverted;
  // An item stamped before signal items carried a baseline has none to restore —
  // leave the typed values alone rather than wipe them.
  if (Object.hasOwn(item, 'origin_form_state')) {
    const baseline = item.origin_form_state;
    if (baseline) mount.form_state = { ...baseline };
    else delete mount.form_state;
    // The pane is back at its pre-run values: the next change starts a new run.
    formBaselines(state).delete(mount);
  }
  return emitMount(state, bus, mountId, { source: 'queue-revert' }) || storeReverted;
}

function revertSignalKey(state, bus, item) {
  const key = item.kind === 'signal' ? item.signal_key : null;
  const prev = key && item.origin_store && item.origin_store[key];
  if (!prev) return false;
  if (item.payload_seq != null) {
    const cur = state.store[key];
    if (!cur || typeof cur !== 'object' || cur.seq !== item.payload_seq) return false;
  }
  if (prev.had) patchStore(state, bus, { [key]: prev.value }, { source: 'queue-revert' });
  else patchStore(state, bus, {}, { source: 'queue-revert', unset: [key] });
  return true;
}

// Revert the web-chat artifact a queue item stands for (the "Revert" action): a
// COMMENT item deletes its pin so the marker disappears; an ACTIVITY or SIGNAL
// item undoes the interaction and KEEPS the pane (revertInteraction); a CAPTURE
// item drops the pane it rendered (revertCapturePane). Nothing else removes a
// pane. Emits the matching frame so browsers follow.
function revertArtifact(state, bus, item) {
  if (!item) return false;
  // Dispatch on the item's kind (C1) — not a duck-typed comment_id.
  if (isInteraction(item)) return revertInteraction(state, bus, item);
  // F5: a comment's pin may already be gone (node navigation stranded the item).
  // Delete it if present; a stranded one reverts NOTHING — the pane it was
  // pinned to is Claude's, not the comment's.
  if (item.kind === 'comment') return deleteComment(state, bus, item.comment_id);
  if (item.kind === 'capture') return revertCapturePane(state, bus, item.origin_mount, item.origin_gen);
  return false;
}

// Remove one queued item by id. With `revert`, also removes its web-chat artifact
// (see revertArtifact). Emits a `queue` remove event + WS frame. Returns
// { removed, reverted } (null if the id wasn't queued) — B1: the route reports THIS
// domain-computed `reverted`, not the request flag (a Revert on an item whose
// artifact is already gone reverts nothing).
function remove(state, bus, id, { revert = false } = {}) {
  const i = state.queue.findIndex((it) => it.id === id);
  if (i < 0) return null;
  const [removed] = state.queue.splice(i, 1);
  const reverted = revert ? revertArtifact(state, bus, removed) : false;
  // A dismiss (× without Revert) KEEPS what the user typed during that run, so
  // the run ends here: drop the pane's baseline, and the next run starts from the
  // kept values. Left in place, the next item inherited the stale pre-run
  // baseline and its Revert wiped the values the user chose to keep.
  if (!revert && isInteraction(removed) && removed.origin_mount) {
    const mount = state.mounts.get(removed.origin_mount);
    if (mount) formBaselines(state).delete(mount);
  }
  // A queued message removed is gone, not failed: its receipt is dropped
  // without a frame of its own (the remove frame says it).
  if (isMessage(removed) && state.messageReceipts instanceof Map) state.messageReceipts.delete(removed.msg_id);
  emitRemove(state, bus, [id], reverted ? 'reverted' : 'removed');
  return { removed, reverted };
}

// Drop every queued item that stands for a given comment pin — the reverse of the
// enqueue on a shared add/toggle: when a pin is UN-shared or deleted it should
// leave the wake rail too. Reuses `remove` (one removal path) so each drop emits
// the standard `queue` remove frame. Idempotent — 0 if the pin was never queued.
function removeByComment(state, bus, commentId) {
  if (!commentId) return 0;
  const ids = state.queue.filter((it) => it.comment_id === commentId).map((it) => it.id);
  for (const id of ids) remove(state, bus, id);
  return ids.length;
}

// Refresh the summary of every queued item standing for a comment pin (F9): a
// plain text edit of an ALREADY-queued shared pin must not leave the wake line
// quoting the pre-edit (possibly retracted) text. Rebuilds summary/why_wake from
// the freshly-classified item and emits a `queue` update frame carrying a COPY
// (F7 — no live reference in the ring; carries the current `staged` so the client's
// update fold can't clobber a held item). No-op (0) if the pin isn't queued —
// refresh never enqueues.
function refreshComment(state, bus, commentId, item) {
  if (!commentId || !item) return 0;
  const targets = state.queue.filter((it) => it.comment_id === commentId);
  for (const it of targets) {
    it.summary = item.summary;
    it.why_wake = item.why_wake;
    const copy = { ...it };
    bus.emit({
      event: { kind: 'queue', op: 'update', id: it.id, item: copy },
      ws: { type: 'queue', op: 'update', id: it.id, item: copy, staged: it.staged, count: state.queue.length },
    });
  }
  return targets.length;
}

// Stage / unstage a queued item. Held (staged:false) items stay in
// the queue but aren't sent on Push. Persists on state.queue (rides draft.json),
// so a held item stays held across reconnect/restart. Emits a `queue` update
// frame the rail folds. Returns the item (null if the id wasn't queued). The frame
// carries only primitives (id/staged) — no live reference — so it can't rewrite a
// served ADD event (F7 fixes that at the source, in enqueue's copy).
function setStaged(state, bus, id, staged) {
  const it = state.queue.find((q) => q.id === id);
  if (!it) return null;
  it.staged = staged !== false;
  bus.emit({
    event: { kind: 'queue', op: 'update', id, staged: it.staged },
    ws: { type: 'queue', op: 'update', id, staged: it.staged, count: state.queue.length },
  });
  return it;
}

// The ONE wake emitter. Emits `{kind:'wake', batch, reason, source[, note]}` on
// the bus (ring + SSE subscribers only — NO WS frame). The channel bridge builds
// the envelope from this event and pushes the notification. Returns the event.
//
// turn-begin-on-push: when the caller passes `graph`, the wake acquires a turn
// lock BEFORE it goes out (acquireWakeLock — folds into a running user turn,
// extends a running wake turn, else locks with the short wake TTL), so the
// channel-woken turn commits its own node at Stop instead of riding the next
// typed turn's commit. Living here keeps the invariant one-line-auditable:
// every wake producer goes through emitWake, so every wake-started turn locks.
function emitWake(bus, batch, { reason = 'push', source = 'queue', note, graph, origin, device, target_pid } = {}) {
  if (graph) {
    acquireWakeLock(graph, bus, {
      message: wakeLockMessage(batch, reason),
      // A stale lock this wake steals has its abandoned work committed first
      // (turns.stealStale), and a commit supersedes the draft.
      draftPath: graph.draftPath,
    });
  }
  const event = { kind: 'wake', batch, reason, source, ...provFields({ origin, device }) };
  if (note != null && note !== '') event.note = String(note);
  if (isTargetPid(target_pid)) event.target_pid = target_pid;
  // Ride the daemon's boot token so the bridge can distinguish a fresh daemon's
  // reset seq space from a same-daemon replay (see lib/channel/bridge deliver()).
  if (bus.bootId != null) event.boot = bus.bootId;
  return bus.emit({ event });
}

// The wake lock's message (§6.4). The lock record goes whole to every socket
// and into the committed node's trigger, so it stays content-free: a batch
// holding a message names the first message's id (', +N' for N more), never a
// word of it; any other batch keeps 'channel wake: N signals'.
function wakeLockMessage(batch, reason) {
  const list = Array.isArray(batch) ? batch : [];
  const messages = list.filter(isMessage);
  if (messages.length) {
    const first = messages.find((it) => isMessageId(it.msg_id));
    const more = messages.length - 1;
    return `web message${first ? ` ${first.msg_id}` : ''}${more ? `, +${more}` : ''}`;
  }
  const n = list.length;
  return `channel wake: ${n} signal${n === 1 ? '' : 's'}${reason && reason !== 'push' ? ` (${reason})` : ''}`;
}

// A process id a release may be aimed at (§6.4 Targeting): a positive safe
// integer, else nothing is passed on.
const isTargetPid = (pid) => Number.isSafeInteger(pid) && pid > 0;

// ── Targeting (§6.4, C33) ─────────────────────────────────────────────────
// Every bridge delivers every wake, so two sessions with live channels would
// both run a message. A release therefore names the process that should take
// it (`target_pid`, the Claude Code process), and the queue keeps its live
// consumers per pid: each bridge's heartbeat carries {pid}, stamped into
// `state.channelPids` (pid → last seen). Like wakeConsumers it describes this
// boot's sockets, so it lives in memory only and never rides draft.json.

// Stamp a channel heartbeat: the channel's last-seen (channelLive), and, with a
// valid pid, that pid's too — pruning entries older than CONSUMER_TTL_MS and
// keeping at most CHANNEL_PIDS_MAX, the least recently seen dropped first.
// Answers whether the pid just turned live (no fresh stamp before this one),
// so the heartbeat route can hand it a park that waits for it.
function stampChannel(state, pid, now = Date.now()) {
  state.wakeConsumerSeenAt = now;
  if (!isTargetPid(pid)) return { pid: null, turnedLive: false };
  if (!(state.channelPids instanceof Map)) state.channelPids = new Map();
  const pids = state.channelPids;
  const prev = pids.get(pid);
  for (const [p, at] of pids) if (now - at >= CONSUMER_TTL_MS) pids.delete(p);
  // Re-inserted last: the Map's order is least recently seen first.
  pids.delete(pid);
  pids.set(pid, now);
  while (pids.size > CHANNEL_PIDS_MAX) pids.delete(pids.keys().next().value);
  // A drain owed to a pid that is no longer tracked is moot: its next stamp
  // turns live again.
  if (state.channelDrainOwed instanceof Set) {
    for (const p of state.channelDrainOwed) if (!pids.has(p)) state.channelDrainOwed.delete(p);
  }
  return { pid, turnedLive: prev == null || now - prev >= CONSUMER_TTL_MS };
}

function freshPids(state, now) {
  const out = [];
  if (state.channelPids instanceof Map) {
    for (const [p, at] of state.channelPids) if (now - at < CONSUMER_TTL_MS) out.push(p);
  }
  return out;
}

// Is the channel live FOR process `pid`? No pid: channelLive. With one:
// channelLive and a fresh heartbeat from that pid. While no live consumer has
// reported a pid at all — every bridge still running is older than per-pid
// heartbeats, and each one delivers every wake whatever its target — the
// answer is channelLive: targeting is best effort (§6.4), and parking a
// release that no live consumer could ever be matched against would only
// delay it. As soon as any live bridge reports a pid, the strict rule holds.
// (Decided 2026-10-07, chat-mirror-rulings.md 'Between waves 3 and 4'.)
function channelLiveFor(state, pid, now = Date.now()) {
  if (!channelLive(state, now)) return false;
  if (!isTargetPid(pid)) return true;
  const fresh = freshPids(state, now);
  return fresh.length === 0 || fresh.includes(pid);
}

// The target a merged park carries (§6.4; notes-C Q12): a release's target
// sets it, a release with none leaves it, and two different targets make the
// park untargeted for good (`mixed_targets`) — any session may then claim it,
// so a message is never lost, though it may reach the other session.
function mergedTarget(prev, target_pid) {
  const next = isTargetPid(target_pid) ? target_pid : null;
  if (!prev) return { target: next, mixed: false };
  if (prev.mixed_targets) return { target: null, mixed: true };
  const had = isTargetPid(prev.target_pid) ? prev.target_pid : null;
  if (had == null) return { target: next, mixed: false };
  if (next == null || next === had) return { target: had, mixed: false };
  return { target: null, mixed: true };
}

// Store `batch` as THE park under a fresh id, its summary envelope rendered
// now. The one place a park is stamped: parkWake and a Take back (recallPending)
// both come through here.
function stampPark(state, { created_at, batch, note, reason, source, prov, target, mixed }) {
  const id = `pw${++state.pendingWakeSeq}`;
  const envelope = wakeEnvelope(batch, { reason, source, seq: state.pendingWakeSeq, note, ...prov });
  state.pendingWake = { id, created_at, batch, note, reason, source, ...prov, envelope };
  if (target != null) state.pendingWake.target_pid = target;
  if (mixed) state.pendingWake.mixed_targets = true;
  return state.pendingWake;
}

// PARK a wake that can't be delivered live because no channel is connected.
// Builds the SUMMARY envelope now — the same
// contract a live wake carries (wakeEnvelope: summary only, bodies fetched by tool
// call) — and stores it as the SINGLE pending wake. A re-push while parked MERGES
// its batch into the existing park and rebuilds the envelope (never two
// parks); the park id is RE-STAMPED on every park/merge so an in-flight
// hook-consume of the pre-merge envelope no-ops on its id check (drops nothing).
// The latest non-blank note re-stamps; a note-less re-push keeps the parked note.
// A park emits nothing on the bus — delivery is deferred to the turn-begin hook
// (path A) or the first wake-consumer to connect (path B, drainPending). Returns
// the stored park. Provenance follows the note's rule: the latest push that
// carries one re-stamps it (it is where the user was when they last pushed).
// The park's `target_pid` follows mergedTarget.
// parkWake, then noteParked over what went in: the receipt half of a park or a
// merge, for every caller that holds a bus.
function parkAndNote(state, bus, args) {
  const prev = state.pendingWake;
  const offered = prev && Array.isArray(prev.batch) ? [...prev.batch, ...args.batch] : args.batch;
  const park = parkWake(state, args);
  noteParked(state, bus, park, offered);
  return park;
}

function parkWake(state, { batch, reason, source, note, origin, device, target_pid }) {
  const prev = state.pendingWake;
  // Memory backstop, mirroring enqueue's MAX_QUEUE loop. A park MERGES every
  // re-push while disconnected (the default/fallback case), so without a cap N
  // pushes accumulate up to N×MAX_QUEUE items — regrowing draft.json (the park
  // rides it, graph.js/turns.js) and the injected envelope without bound, exactly
  // the unbounded growth MAX_QUEUE exists to prevent. Cap the merged batch at
  // MAX_QUEUE, evicting the OLDEST overflow (the newest signals are the most
  // relevant to the next prompt; the batch is oldest-first). The park is a delivery
  // buffer, not a record — dropped ids already left their queue-remove trail.
  const merged = prev ? [...prev.batch, ...batch] : batch.slice();
  const mergedBatch = merged.length > MAX_QUEUE ? merged.slice(-MAX_QUEUE) : merged;
  const newNote = note != null && String(note).trim() !== '' ? String(note) : null;
  const mergedNote = newNote != null ? newNote : (prev ? prev.note : note);
  const fresh = provFields({ origin, device });
  const prov = { ...provFields(prev), ...fresh };
  const { target, mixed } = mergedTarget(prev, target_pid);
  return stampPark(state, {
    created_at: prev ? prev.created_at : Date.now(),
    batch: mergedBatch, note: mergedNote, reason, source, prov, target, mixed,
  });
}

// The park a turn-begin hook running in process `pid` may claim (§6.4): an
// untargeted park, or one targeted at that pid. No pid (a hook without
// CLAUDE_PID) claims any park, as before targeting.
function pendingFor(state, pid) {
  const park = state.pendingWake;
  if (!park) return null;
  if (!isTargetPid(pid) || !isTargetPid(park.target_pid)) return park;
  return park.target_pid === pid ? park : null;
}

// Deliver a parked wake NOW as a real `wake` event — path B: the first
// wake-consumer (the channel bridge) to connect drains the park (called from the
// wakeConsumers++ site in routes/events). Clears the park BEFORE emitting so a
// concurrent turn-begin hook consume (path A) finds nothing to double-deliver.
// Returns the emitted wake event (or null if nothing was drained).
//
// Called on EVERY wake-consumer connect, including one that finds no park — the
// fold below is the other half of the job and has to run either way (the route
// used to guard the call on state.pendingWake, which skipped it in exactly the
// case the fold exists for: an in-flight wake whose stream died with nothing
// parked behind it).
//
// Targeting: an untargeted park drains whatever `pid` is; a targeted one only
// when called with its pid — the heartbeat route does that, through
// drainForChannel, when the pid's channel turns live, passing `fold: false`: a heartbeat is not a reconnect, so it must not fold
// an in-flight wake (perhaps another process's, perhaps the one this
// consumer's own connect just drained) back into the park. Without the fold
// it also must not overwrite that wake's retain, so while one is in flight it
// drains nothing (the next heartbeat after its ack does).
function drainPending(state, bus, graph, { pid, fold = true } = {}) {
  // A reconnecting bridge means the prior stream died — any in-flight wake on it
  // almost certainly never landed, so fold it into the park before draining so it
  // redelivers to the fresh channel too.
  if (fold) foldPendingAck(state, bus);
  else if (state.pendingAck) return null;
  const park = state.pendingWake;
  if (!park) return null;
  const target = isTargetPid(park.target_pid) ? park.target_pid : null;
  if (target != null && target !== pid) return null;
  state.pendingWake = null;
  const ctx = { reason: park.reason, source: park.source, note: park.note, ...provFields(park) };
  if (target != null) ctx.target_pid = target;
  const wake = emitWake(bus, park.batch, { ...ctx, graph });
  // A drained wake is a live wake like any other: retain its batch until the
  // bridge acks, exactly as flush and repush do. Without this a wake delivered
  // on reconnect was the one delivery with no recovery behind it — dropped a
  // second time, it was simply gone.
  retainAck(state, wake, ctx);
  noteBatchReceipts(state, bus, park.batch, 'sending', { seq: wake.seq, boot: wake.boot });
  return wake;
}

// A heartbeat hands pid's channel the park that waits for it (§6.4): only when
// the pid's channel turns live (`turnedLive`, from stampChannel), or later, when
// that turn-live found a park it may claim but an in-flight wake blocked the
// drain (drainPending with `fold: false` will not overwrite the retain) — the
// drain is then owed to the pid (`state.channelDrainOwed`, a Set of pids, in
// memory only like channelPids) and made by its first heartbeat after the
// in-flight wake clears. A heartbeat from a pid that is already live with no
// drain owed drains nothing: a park made while its channel was live (Hold —
// repush {park: true} — or the foldStaleAck backstop) waits for the user's
// next message, never for the channel that just failed to ack it. Returns the
// emitted wake, or null.
function drainForChannel(state, bus, graph, pid, { turnedLive = false } = {}) {
  if (!isTargetPid(pid)) return null;
  const owed = state.channelDrainOwed instanceof Set ? state.channelDrainOwed : null;
  if (!turnedLive && !(owed && owed.has(pid))) return null;
  if (!channelLiveFor(state, pid) || !pendingFor(state, pid)) {
    if (owed) owed.delete(pid);
    return null;
  }
  if (state.pendingAck) {
    if (!owed) state.channelDrainOwed = new Set();
    state.channelDrainOwed.add(pid);
    return null;
  }
  if (owed) owed.delete(pid);
  return drainPending(state, bus, graph, { pid, fold: false });
}

// Consume (clear) the parked wake IF `id` matches the current park — path A: the
// turn-begin hook calls this after injecting the summary as prompt context. The id
// check makes a race with drainPending (path B) or a re-push merge harmless: once
// either clears or re-stamps the park, a stale id no-ops. Returns whether it cleared.
//
// The rail's Cancel clears the park through the same route, so the receipts of
// the park's messages follow who asked (with `bus`): a host request (`host`,
// the hook through lib/client: audience.isHost) handed them over to the prompt
// being submitted → handed_over; any other discarded them → failed. Without
// `bus` no receipt moves.
function consumePending(state, id, { bus, host = false } = {}) {
  const park = state.pendingWake;
  if (!park || park.id !== id) return false;
  state.pendingWake = null;
  noteBatchReceipts(state, bus, park.batch, host === true ? 'handed_over' : 'failed');
  return true;
}

// Take back (§6.3's recall row, ruling C1 (a)): the park's typed messages go
// back into the queue — in their order, with their own ids (queueSeq only
// grows, so none can collide), staged, autosend off and `waiting` cleared, one
// add frame each through publicItem. Its stop requests and signals stay
// parked: a Kill the user pressed is never silently undone. What is left is
// stamped again as parkWake stamps a merge (a new id, its envelope rendered
// from what is left), so a hook that read the old envelope no-ops on its
// consume instead of dropping the rest; the park clears only when nothing
// (no item, no note) is left in it. A message coming back may take the queue
// past QUEUED_MESSAGES_MAX for a while: the user's words are never dropped.
// Id-checked like consumePending. Answers null for a stale id; {ids: [], park}
// for a park with no typed message (left as it is: the rail offers Cancel
// there); else {ids, park} — the queue ids put back and what is left parked
// (null when the park cleared).
function recallPending(state, bus, id) {
  const park = state.pendingWake;
  if (!park || park.id !== id) return null;
  const batch = Array.isArray(park.batch) ? park.batch : [];
  const back = batch.filter(isTypedMessage);
  if (!back.length) return { ids: [], park };
  for (const it of back) {
    const item = { ...it, staged: true, autosend: false };
    delete item.waiting;
    state.queue.push(item);
    const copy = publicItem(item);
    bus.emit({
      event: { kind: 'queue', op: 'add', id: item.id, item: copy },
      ws: { type: 'queue', op: 'add', item: copy, count: state.queue.length },
    });
    noteReceipt(state, bus, item.msg_id, 'queued');
  }
  const ids = back.map((it) => it.id);
  const rest = batch.filter((it) => !isTypedMessage(it));
  const hasNote = park.note != null && String(park.note).trim() !== '';
  if (!rest.length && !hasNote) {
    state.pendingWake = null;
    return { ids, park: null };
  }
  const left = stampPark(state, {
    created_at: park.created_at, batch: rest, note: park.note, reason: park.reason, source: park.source,
    prov: provFields(park), target: isTargetPid(park.target_pid) ? park.target_pid : null, mixed: !!park.mixed_targets,
  });
  noteParked(state, bus, left);
  return { ids, park: left };
}

// The channel is deliverably LIVE when a wake-consumer (the bridge) is
// subscribed AND its heartbeat is fresh (see state.wakeConsumerSeenAt). The raw
// wakeConsumers count is not enough: a half-open SSE socket keeps it > 0 while
// nothing reads the stream. Requiring a fresh heartbeat lets flush distinguish a
// real channel from that zombie and PARK instead of firing a wake into the void.
function channelLive(state, now = Date.now()) {
  return (state.wakeConsumers || 0) > 0 && now - (state.wakeConsumerSeenAt || 0) < CONSUMER_TTL_MS;
}

// Retain a just-emitted live wake so its batch survives a silent-drop: the batch
// is held under the wake's ring seq until the bridge acks it (ackWake) or a
// recovery/backstop folds it into a park. `boot` scopes the ack so a cross-boot
// ack can't clear a fresh retain. A targeted wake's `target_pid` is kept, so a
// fold or a retry stays aimed at the same process.
function retainAck(state, wake, { reason, source, note, origin, device, target_pid }) {
  state.pendingAck = {
    seq: wake.seq, boot: wake.boot, batch: wake.batch, reason, source, note,
    ...provFields({ origin, device }), ...(isTargetPid(target_pid) ? { target_pid } : {}), created_at: Date.now(),
  };
  return state.pendingAck;
}

// The bridge confirms it TRANSMITTED wake `seq` (POST /api/channel/ack, fired
// after its notify() lands). Clears the retained in-flight batch IF it matches
// (seq + boot, so a stale cross-boot ack no-ops) and emits a `wake-ack` frame the
// rail folds into a "delivered" confirmation. Returns whether it matched.
//
// The ack proves the bytes left the bridge — NOT that anything received them.
// The bridge writes to stdout; if no channel consumer is subscribed, that write
// succeeds and vanishes. Clearing the retain on transmission alone therefore
// destroyed the batch and told the user "Delivered to Claude ✓" — the one
// outcome the whole retain/park machinery exists to prevent. So gate the clear
// on the same liveness check `repush` and `flush` already use: with no live
// consumer we keep the retain, and the ACK_STALE_MS backstop (foldStaleAck)
// parks it for delivery on the user's next message.
function ackWake(state, bus, seq, boot) {
  const pa = state.pendingAck;
  if (!pa || pa.seq !== seq || (boot != null && pa.boot != null && boot !== pa.boot)) return false;
  if (!channelLive(state)) {
    // Transmitted into the void. Leave the batch retained and say nothing —
    // the rail's own ack timeout surfaces the recovery affordances, and the
    // backstop converts it to a park.
    pa.transmitted_at = Date.now();
    return false;
  }
  state.pendingAck = null;
  bus.emit({ event: { kind: 'wake-ack', seq }, ws: { type: 'wake-ack', seq } });
  // Transmitted to a live channel: 'sent', never 'delivered' — only the
  // transcript says a message arrived (confirmDelivered).
  noteBatchReceipts(state, bus, pa.batch, 'sent');
  return true;
}

// Fold the retained in-flight wake (if any) into a parked wake so its batch is
// never lost — delivered on the user's next message (path A) or next bridge
// connect (path B). Called when a new push supersedes it, on bridge reconnect,
// and (via foldStaleAck) once it ages out. Idempotent; no-op when nothing is
// retained. NOTE: a fold of a wake that actually DID deliver but whose ack hadn't
// arrived yet costs a duplicate delivery — deliberately preferred over silent
// loss, and the ack-clears-first ordering makes the window sub-second in practice.
// The retained wake's target rides into the park (mergedTarget). With `bus`, its
// messages' receipts go sending → parked.
function foldPendingAck(state, bus) {
  const pa = state.pendingAck;
  if (!pa) return false;
  state.pendingAck = null;
  parkAndNote(state, bus, {
    batch: pa.batch, reason: pa.reason, source: pa.source, note: pa.note, ...provFields(pa), target_pid: pa.target_pid,
  });
  return true;
}

// The closed-tab backstop: fold the in-flight wake into a park ONLY once it's
// aged past ACK_STALE_MS (so a wake the rail is still actively awaiting isn't
// folded out from under it). Called from the pending-read path (turn-begin) and
// before a flush. Returns whether it folded. `bus`: as foldPendingAck's.
function foldStaleAck(state, now = Date.now(), bus = null) {
  const pa = state.pendingAck;
  if (!pa || now - (pa.created_at || 0) < ACK_STALE_MS) return false;
  return foldPendingAck(state, bus);
}

// Recovery: re-deliver the retained in-flight batch after the rail timed out
// waiting for an ack. `park:true` (the "hold for next message" affordance) — or a
// channel that's since gone dead for the wake's target — converts it to a parked
// wake; otherwise it re-emits a fresh live wake (a new seq for the rail to await)
// and re-retains. Either way the retained target rides along.
// Returns {mode:'wake', wake} | {mode:'parked', parked}, or null if nothing is
// retained under `seq`. The provenance is the RETRY's (`origin`/`device`) when it
// carries one — whoever pressed Retry is where the answer will be read — else the
// original push's.
function repush(state, bus, seq, { park = false, graph, origin, device } = {}) {
  const pa = state.pendingAck;
  if (!pa || (seq != null && pa.seq !== seq)) return null;
  state.pendingAck = null;
  const ctx = { reason: pa.reason, source: pa.source, note: pa.note, ...provFields(pa), ...provFields({ origin, device }) };
  if (isTargetPid(pa.target_pid)) ctx.target_pid = pa.target_pid;
  if (park || !channelLiveFor(state, pa.target_pid)) {
    const parked = parkAndNote(state, bus, { batch: pa.batch, ...ctx });
    return { mode: 'parked', parked };
  }
  const wake = emitWake(bus, pa.batch, { ...ctx, graph });
  retainAck(state, wake, ctx);
  // Still sending: the receipts take the retry's seq and boot.
  noteBatchReceipts(state, bus, pa.batch, 'sending', { seq: wake.seq, boot: wake.boot });
  return { mode: 'wake', wake };
}

// One message per park (§6.4). When this release would park — no channel live
// for its target — the park holds at most one typed message: with one parked
// already, every typed message of the batch stays queued; with none, the first
// goes and the rest stay. A stop request is exempt (ruling C1 (a)): a block of
// about 170 characters, so a Kill never waits behind a typed prompt. Decided
// BEFORE anything leaves the queue, so a kept message never leaves and
// re-enters it. (A fold — foldPendingAck, foldStaleAck, a repush that parks —
// may still join a second message: an envelope holds at most two message
// blocks.) The decision ignores the transport seam: a tranche-6 transport that
// would have taken the message is offered it on its next release. Answers the
// items to keep.
function parkHoldBack(state, sent, target_pid, force = false) {
  if (!force && channelLiveFor(state, target_pid)) return [];
  const park = state.pendingWake;
  let room = park && Array.isArray(park.batch) && park.batch.some(isTypedMessage) ? 0 : 1;
  const keep = [];
  for (const it of sent) {
    if (!isTypedMessage(it)) continue;
    if (room > 0) { room -= 1; continue; }
    keep.push(it);
  }
  return keep;
}

// A message kept back by parkHoldBack waits in the queue for the park to be
// consumed: `waiting: 'parked_message'`, and `autosend: true`, so the release
// scheduler (U63) sends it at the next idle. One update frame each.
function markWaitingForPark(state, bus, items) {
  for (const it of items) {
    it.waiting = 'parked_message';
    it.autosend = true;
    const copy = publicItem(it);
    bus.emit({
      event: { kind: 'queue', op: 'update', id: it.id, item: copy },
      ws: { type: 'queue', op: 'update', id: it.id, item: copy, staged: it.staged, count: state.queue.length },
    });
  }
}

// Flush the STAGED items into one wake, clearing only them; HELD (staged:false)
// items stay in the queue for a later push (this supersedes the old
// `exclude`/"not this push, cleared" rule: holding an item now DEFERS it). A
// note-only push (no staged item + a non-blank comment) is still a deliberate
// wake. Emits ONE batched `queue` remove (not ~N per-item frames, which could
// evict half the event ring and made the client rebuild the rail per frame) then
// hands the batch to deliver — which wakes, or, when no channel is connected,
// PARKS it. Either way the sent items clear (they're IN the park).
//
// Which MESSAGE items go (§6.1):
//   * `ids` names message items to send, staged or held (Send, Send now): the
//     named ones go, every other message stays queued — staged non-message
//     items always ride along;
//   * no `ids`: every staged item, messages included (a plain Push);
//   * `messages: false`: no message goes (a remote Push below level `full`),
//     and the result's `heldMessages` counts the staged ones it left behind.
// A typed message the park has no room for stays queued (parkHoldBack) and is
// listed in `heldBack` (queue ids).
// Returns {batch, wake, parked, transported[, heldMessages][, heldBack]} — on a
// non-inert flush exactly one of wake/parked is non-null unless the transport
// took every item.
function flush(state, bus, { ids, messages = true, reason = 'push', source = 'queue', note, graph, origin, device, target_pid, park = false } = {}) {
  // A new push supersedes any still-retained in-flight wake — fold it into the
  // park so its batch isn't lost when we overwrite pendingAck below.
  foldPendingAck(state, bus);
  const named = Array.isArray(ids) ? new Set(ids) : null;
  const goes = (it) => {
    if (!isMessage(it)) return isStaged(it);
    if (messages === false) return false;
    return named ? named.has(it.id) : isStaged(it);
  };
  const chosen = state.queue.filter(goes);
  const heldBackItems = parkHoldBack(state, chosen, target_pid, park);
  const keepBack = new Set(heldBackItems);
  const sent = keepBack.size ? chosen.filter((it) => !keepBack.has(it)) : chosen;
  const going = new Set(sent);
  const kept = state.queue.filter((it) => !going.has(it));
  const extra = messages === false ? { heldMessages: kept.filter((it) => isMessage(it) && isStaged(it)).length } : {};
  if (heldBackItems.length) {
    markWaitingForPark(state, bus, heldBackItems);
    extra.heldBack = heldBackItems.map((it) => it.id);
  }
  const hasNote = note != null && String(note).trim() !== '';
  if (!sent.length && !hasNote) return { batch: [], wake: null, parked: null, transported: [], ...extra };
  const batch = sent.map((it) => {
    const copy = { ...it };
    delete copy.waiting;
    return copy;
  });
  state.queue = kept;
  // A Push is the handoff boundary: whatever the panes hold now was Claude-
  // visible, so every pane's next change starts a fresh Revert baseline.
  state.formBaselines = new WeakMap();
  const prov = provFields({ origin, device });
  if (sent.length) emitRemove(state, bus, sent.map((it) => it.id), 'flushed', prov);
  const out = deliver(state, bus, batch, { reason, source, note, graph, ...prov, target_pid, park });
  return { batch, ...out, ...extra };
}

// Send chosen message items now (Send, Send now, the release scheduler): a
// flush naming them, so Push, Send and Send now share one delivery path, one
// turn-lock rule and one park. `opts.origin`/`opts.device` are the provenance
// of THIS release — a route passes its request's, the scheduler (U63) the
// released item's own stored pair — so every message's envelope opens with its
// 'Pushed from: …' line; `opts.target_pid` aims it (§6.4). Returns flush's result.
function release(state, bus, ids, opts = {}) {
  return flush(state, bus, { ...opts, ids: Array.isArray(ids) ? ids : [], messages: true });
}

// The ONE delivery path: a batch that has already left the queue is offered to
// the transport seam, then woken or parked. Push, Send and Send now all reach
// it through flush.
//
// THE TRANSPORT SEAM: when `state.messageTransport` is a function, each MESSAGE
// item is offered to it first (synchronously); it answers {via} when it took
// the item (tranche 6: the mod's submit, U91, which submits the same quoted,
// marked block) or null to decline — a throw, or any other answer, declines.
// Taken items leave the batch and are listed in `transported`; nothing sets
// the seam before tranche 6.
//
// What is left wakes — when a channel is LIVE for the target (a fresh
// heartbeat; a zombie SSE stream parks too; a targeted release, a fresh
// heartbeat from that pid: channelLiveFor) — and is retained until the bridge
// acks it, or PARKS at once for the user's next message / the next bridge
// connect. `target_pid`, when a positive safe integer, rides the wake event,
// the retain and the park. `park: true` parks whatever the channel's state (a
// release for an ended conversation, or one whose process is gone: §6.4's
// table parks it for the next prompt typed in the project, never a live wake
// another session's bridge would run — U63b).
// Returns {wake, parked, transported: [{id, via}]}.
function deliver(state, bus, batch, { reason = 'push', source = 'queue', note, graph, origin, device, target_pid, park = false } = {}) {
  // A delivery overwrites pendingAck below: fold a still-retained in-flight
  // wake into the park first (a no-op when flush already did).
  foldPendingAck(state, bus);
  const transported = [];
  let rest = Array.isArray(batch) ? batch : [];
  if (typeof state.messageTransport === 'function') {
    rest = [];
    for (const it of batch) {
      if (isMessage(it)) {
        let answer = null;
        try { answer = state.messageTransport(it); } catch { answer = null; }
        if (answer && typeof answer === 'object' && typeof answer.via === 'string' && answer.via) {
          transported.push({ id: it.id, via: answer.via });
          // Taken and submitted: sending, then sent at once (the graph has no
          // queued → sent step). Confirmed only from the transcript, as ever.
          noteReceipt(state, bus, it.msg_id, 'sending');
          noteReceipt(state, bus, it.msg_id, 'sent');
          continue;
        }
      }
      rest.push(it);
    }
  }
  const hasNote = note != null && String(note).trim() !== '';
  if (!rest.length && !hasNote) return { wake: null, parked: null, transported };
  const prov = provFields({ origin, device });
  const target = isTargetPid(target_pid) ? { target_pid } : {};
  // With no channel LIVE the wake would be consumerless (previously the batch was
  // destroyed here). Park it for next-prompt / next-connect delivery instead. The
  // check is liveness, not the raw consumer count — a zombie SSE stream parks too
  // — and, for a targeted release, the target's own liveness.
  if (park === true || !channelLiveFor(state, target_pid)) {
    const parked = parkAndNote(state, bus, { batch: rest, reason, source, note, ...prov, ...target });
    return { wake: null, parked, transported };
  }
  const wake = emitWake(bus, rest, { reason, source, note, graph, ...prov, ...target });
  // Retain the batch until the bridge confirms delivery — the rail waits for the
  // ack and rejects the push if it never comes (see routes/queue + public/queue).
  retainAck(state, wake, { reason, source, note, ...prov, ...target });
  noteBatchReceipts(state, bus, rest, 'sending', { seq: wake.seq, boot: wake.boot });
  return { wake, parked: null, transported };
}

module.exports = {
  provenance, provFields, ORIGINS, DEVICES, enqueue, enqueueMessage, editMessage, publicItem, isMessage, isTypedMessage,
  messageSummary, queuedMessageCount, coalesce, list, remove, removeByComment, refreshComment, setStaged, flush, release,
  deliver, emitWake, parkWake, drainPending, drainForChannel, consumePending, recallPending, pendingFor, channelLive, channelLiveFor,
  stampChannel, isTargetPid, ackWake, repush, foldPendingAck, foldStaleAck, noteFormBaseline, revertCapturePane,
  revertInteraction, revertArtifact, isStaged, MAX_QUEUE, CONSUMER_TTL_MS, ACK_STALE_MS, CHANNEL_PIDS_MAX,
  noteReceipt, confirmDelivered, markUnconfirmed, receiptsList, RECEIPTS_MAX, RECEIPT_STATES,
};

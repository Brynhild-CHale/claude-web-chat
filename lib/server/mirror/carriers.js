// lib/server/mirror/carriers.js — the carriers fold: background-task
// notifications, messages typed while Claude works, and web-chat's delivery
// markers, read from the records that carry them (spec §2.5 "Carriers", §2.6's
// `delivered` transition, §6.6).
//
//   initialCarriers()          → state
//   foldCarriers(state, recs)  → {state, changes, delivered: [{via, marker, offset}]}
//
// `recs` are the tailer's records (`{obj, start, end, …}`, lib/server/mirror/
// tail.js). A record is read only when U25's record table (records.js) gives its
// kind a row with `carrier: true`: `queue-operation`, `attachment/queued_command`,
// `attachment/hook_additional_context`, `user/task-notification`, `user/channel`.
// The user openers and `system/turn_duration` are also looked at, only to keep
// the idle/busy flag (THE IDLE RULE, below).
//
// NOTIFICATIONS. One task notification reaches the transcript through up to
// three carriers, in no causal order (V5): a `queue-operation` enqueue (its
// dequeue or `remove: absorbed_mid_turn` is bookkeeping), a user record with
// `origin.kind: 'task-notification'` (delivered idle: it opens a turn), and an
// `attachment/queued_command` with `commandMode: 'task-notification'`
// (absorbed mid-turn; a subagent's file has only this one). They are paired as
// design/chat-mirror-validation/task_lifecycle.py pairs them, by a multiset keyed
// by the task id and the block's normalized text, generalized to any order: an
// occurrence joins the oldest open group of its key that has not yet seen its
// carrier, and whose delivery id, when both sides have one (`deliveryId` /
// `delivery_id`, 2.1.286+), is the same; otherwise it opens a new group. A
// delivery prefers a group still waiting for its delivery over one already
// delivered (V5: each notification is delivered once), so a monitor's identical
// second event is a second notification, not a third carrier of the first. So
// each notification yields ONE `task` item change, whichever carriers carried
// it and in whatever order they arrived.
//
// The change is made at the notification's first DELIVERY carrier (the user
// record or the queued_command), never at the enqueue: a delivery carrier is a
// chain record with a uuid in the turn that received the notification, so the
// item lands in that turn and the seq rule (below) finds a normalizer change at
// its offset. An enqueue only opens a group for pairing; one never followed by a
// delivery in this file (a subagent's task, whose enqueue the parent's file
// also gets) makes no item. A notification enqueue's `queue-operation.content`
// is NEVER_EMIT (§5.5): it is read only to compute the pairing key — a digest,
// which is all the state keeps — and never into a change.
//
// The item: {id, kind: 'task', task_id, task_kind, status, summary, exit_code?,
// event?}. `id` is `t_<taskId>_<n>` where n is the delivery record's uuid (its
// byte offset, `o<start>`, should it have none), plus `_<i>` for the i-th
// notification block of one record (i ≥ 1). A counter would need cross-batch
// state, and a fresh-state re-read of one turn (below) must name the item as the
// whole-file fold did. `task_kind` is 'monitor' for an <event> tag or a summary
// that STARTS with Monitor ('Monitor event', 'Monitor "m" script failed (exit
// 2)'; a shell's summary quotes its description, which may say monitor), else from the id's shape ('agent' a + 16 hex, 'workflow' w…, 'shell' b…),
// else 'unknown'; `status` maps the block's <status> onto the TaskRow
// vocabulary (completed → done, failed, killed, stopped; an <event> with no
// status → running, a `[Monitor expired` one → expired; else unknown).
//
// TYPED-WHILE-BUSY. A message typed while Claude works is enqueued: a
// `queue-operation` enqueue whose content holds no <task-notification> block
// makes a `queued` item {id: `q_o<start>`, kind: 'queued', text, status} at the
// enqueue (enqueues have no uuid, so the id is the record's byte offset, and the
// change carries ts and offset but no uuid). The status words are this fold's
// own, since no spec line pins them:
//   'queued'   the enqueue: waiting for Claude
//   'sent'     a later dequeue popped it: it opens the next turn as a prompt
//              (the normalizer's opener)
//   'absorbed' Claude took it mid-turn: a `remove` with reason
//              `absorbed_mid_turn` and/or the matching non-notification
//              `attachment/queued_command`, in either order — both update the
//              SAME item, never a second one
//   'removed'  any other remove
// The pending enqueues (typed and notification alike, so a dequeue or remove
// that names no content pops the right one: the queue's head) are kept in a
// bounded FIFO in the state, each as its item id (null for a notification) and
// a digest of its normalized content — never the text. A dequeue or remove that
// carries content is matched to the oldest pending enqueue with the same
// digest; one without content takes the head. A queued_command is matched to a
// pending typed enqueue by the digest of its prompt. A non-notification
// queued_command with no prior enqueue in the state (a subagent's file, which
// has only the attachment) keeps its own item {id: `q_<uuid>`, kind: 'queued',
// text, status: 'absorbed'}. `queue-operation.content` is NEVER_EMIT (§5.5)
// except for a queued message: a notification's is read only for its digest.
// THE IDLE RULE (ruled U27@carriers.js:344-idle-enqueue-queued-item): Claude
// Code puts idle prompts and channel wakes through the queue too (enqueue, a
// dequeue within a second, then the turn's opener), and the opener already
// shows that message, so an enqueue made while Claude is IDLE makes no queued
// change, and neither does its dequeue or remove (it is still kept in the FIFO,
// with no item id, so the head stays right). The state keeps a `busy` flag: a
// user opener (`user/prompt`, `user/prompt+image`, `user/channel`,
// `user/task-notification`) sets it and `system/turn_duration` clears it, so
// "idle" is: no opener yet in the records read, or a turn_duration since the
// last opener. A range that starts at a turn's opener therefore reads as busy,
// and U28a's fresh-state refill names the same items. A busy enqueue keeps the
// behaviour above whether it is absorbed or later dequeued.
//
// THE CHANGE CONTRACT is the turn machine's (turn-machine.js header): each change
// is `{type: 'item', item, ts, offset: {start, end}, uuid}` with NO seq (no uuid
// on a change made at an enqueue, a uuid-less record). THE SEQ
// RULE (ruled U27@seq, one rule in U26, U27 and U28a): the transcripts source
// (U28a) stamps each carrier change, in its merge, with the seq of the
// normalizer's change for the same record, matched by offset.
//
// DELIVERY MARKERS (§2.6, §6.6). web-chat's composer marks each message it sends
// (`[web-chat message m-…]`, lib/core/prompt-class messageMarker). Finding a
// marker again in the transcript confirms the delivery, and only the transcript
// confirms it — never the bridge's wake-ack (V11), and never a tool result, which
// can echo a marker (no tool_result block is ever scanned). Scanned, with
// prompt-class `messageMarkers` (never MESSAGE_MARKER_RE's own .test/.exec,
// which are stateful):
//   a `user/channel` record's text                       → via 'channel'
//   an `attachment/queued_command` carrying a channel    → via 'channel'
//     notification (commandMode 'channel', origin.kind 'channel', or a prompt
//     that classifies as one)
//   an `attachment/hook_additional_context` that carries → via 'parked'
//     web-chat's parked frame (PARKED_HEAD)
// Which carrier holds a live channel's marker, idle and mid-turn, is gate V30
// (§10.3, the maintainer's, after U63): both are scanned, and nothing here
// depends on a confirmation. The parked prefix lives in lib/core/prompt-class
// (PARKED_PREFIX, which begins with PARKED_HEAD; U63 moved it there from
// lib/hooks/turn-begin.js), and a hook context is scanned only when it holds
// PARKED_HEAD: a marker in any other hook's context confirms nothing (ruled
// U27@parked-prefix (a)). Each marker is delivered once
// per session: the state remembers the last MARKERS_MAX. `delivered` is
// returned, never emitted: the transcripts source turns each into
// `{kind:'mirror', op:'delivered', conversation_id, via, marker}`.
//
// RE-READS. foldCarriers is callable on a byte-range re-read with a FRESH state
// (initialCarriers()): the items need no cross-batch state, because a task item
// is made at, and named after, its own delivery record, and a queued item after
// its enqueue, whose dequeue, remove and queued_command follow it in the same
// turn's range (a dequeue precedes the opener it lets in). U28a's LRU refill
// calls it that way (U28a@refill-carriers) and gets the same task and queued
// items back for the turn; it must ignore the refill's `delivered` (a fresh state has forgotten
// which markers were already delivered). Two cases a fresh state reads
// differently: a notification delivered by BOTH a user record and a
// queued_command in two different turns (V5 saw each notification delivered
// once) — re-read alone, the later turn would make its own item; and a turn
// OPENED by a notification (its enqueue sits before the opener, outside the
// range) that later absorbs a second notification with the same task id and
// text and no delivery id (a monitor's repeated event): re-read alone, the
// second enqueue joins the opener's group as its missing enqueue, so the
// second queued_command makes no item (the whole-file fold makes two). Both
// are the price of the any-order pairing the six-orders rule asks for.
//
// The state is plain JSON (the source may persist it): pairing groups and
// pending enqueues hold a digest, never the text. Pure: no I/O, no clock, no timers.
// Dependency direction: lib/core and the mirror's own records.js.

const { kindOf, rowOf } = require('./records');
const { messageMarkers, classifyPrompt } = require('../../core/prompt-class');
const { stableHash } = require('../../core/stable-json');

const STATE_VERSION = 1;
const GROUPS_MAX = 1024;
const MARKERS_MAX = 1024;
const QUEUE_MAX = 256;
const CARRIER = Object.freeze({ enqueue: 'e', user: 'u', queued: 'q' });
// The user openers that start Claude working (THE IDLE RULE), and the record
// that says it stopped.
const BUSY_ON = new Set(['user/prompt', 'user/prompt+image', 'user/channel', 'user/task-notification']);
const BUSY_OFF = 'system/turn_duration';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

function initialCarriers() {
  return { v: STATE_VERSION, groups: [], markers: [], queue: [], absorbed: [], busy: false };
}

function adopt(state) {
  if (!isPlain(state) || state.v !== STATE_VERSION) return initialCarriers();
  const groups = Array.isArray(state.groups)
    ? state.groups.filter((g) => isPlain(g) && typeof g.k === 'string' && Array.isArray(g.c))
      .map((g) => ({ k: g.k, c: g.c.filter((x) => typeof x === 'string'), d: typeof g.d === 'string' ? g.d : null, m: g.m === true }))
    : [];
  const markers = Array.isArray(state.markers) ? state.markers.filter((m) => typeof m === 'string') : [];
  const entry = (e) => isPlain(e) && typeof e.h === 'string' && (e.id === null || typeof e.id === 'string');
  const queue = Array.isArray(state.queue)
    ? state.queue.filter(entry).map((e) => ({ h: e.h, id: e.id, q: e.q === true }))
    : [];
  const absorbed = Array.isArray(state.absorbed)
    ? state.absorbed.filter((e) => entry(e) && typeof e.id === 'string').map((e) => ({ h: e.h, id: e.id }))
    : [];
  return { v: STATE_VERSION, groups, markers, queue, absorbed, busy: state.busy === true };
}

// ── a notification block ────────────────────────────────────────────────────

const BLOCK_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TAG_RE = /<([a-z-]+)>([\s\S]*?)<\/\1>/g;
const EXIT_RE = /exit code (\d+)|\(exit (\d+)\)/;
const STATUS = Object.freeze({ completed: 'done', failed: 'failed', killed: 'killed', stopped: 'stopped' });

// Every <task-notification> block in a text: {body, tags}. Exported for the
// sources that read the same block (tasks.js, U41).
function parseNotifications(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return out;
  for (const m of text.matchAll(BLOCK_RE)) {
    const tags = {};
    for (const t of m[1].matchAll(TAG_RE)) if (!Object.hasOwn(tags, t[1])) tags[t[1]] = t[2].trim();
    out.push({ body: m[1], tags });
  }
  return out;
}

function taskKindOf(id, tags) {
  if (tags.event !== undefined || /^Monitor\b/.test(tags.summary || '')) return 'monitor';
  if (/^a[0-9a-f]{16}$/.test(id)) return 'agent';
  if (/^w[0-9a-z]+$/i.test(id)) return 'workflow';
  if (/^b[0-9a-z]+$/i.test(id)) return 'shell';
  return 'unknown';
}

function statusOf(tags) {
  if (tags.status !== undefined) return STATUS[tags.status] || 'unknown';
  if (tags.event !== undefined) return /^\[Monitor expired/.test(tags.event) ? 'expired' : 'running';
  return 'unknown';
}

// A segment of an item id: the model's id grammar is [A-Za-z0-9][A-Za-z0-9_.:-]*.
function seg(v, max) {
  const s = typeof v === 'string' ? v.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max) : '';
  return s;
}

function taskItem(n, block, rec, r) {
  const { tags } = block;
  const ref = seg(tags['task-id'] || tags['tool-use-id'], 48);
  const anchor = seg(rec.uuid, 40) || (Number.isFinite(r.start) ? `o${r.start}` : 'x');
  const item = {
    id: `t_${ref}_${anchor}${n ? `_${n}` : ''}`,
    kind: 'task',
    task_id: tags['task-id'] || null,
    task_kind: taskKindOf(tags['task-id'] || '', tags),
    status: statusOf(tags),
    summary: tags.summary || '',
  };
  const m = EXIT_RE.exec(tags.summary || '');
  if (m) item.exit_code = Number(m[1] || m[2]);
  if (tags.event !== undefined) item.event = tags.event;
  return item;
}

// ── records ─────────────────────────────────────────────────────────────────

function tsOf(rec) {
  const t = Date.parse(rec && rec.timestamp);
  return Number.isFinite(t) ? t : null;
}

function offsetOf(r) {
  return Number.isFinite(r.start) && Number.isFinite(r.end) ? { start: r.start, end: r.end } : null;
}

// A user record's text: its string content, or its text blocks — never a
// tool_result block, which can echo anything.
function userText(rec) {
  const c = isPlain(rec.message) ? rec.message.content : undefined;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => isPlain(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function deliveryIdOf(rec, a) {
  return str(rec.deliveryId) || str(rec.delivery_id) || str(a && a.delivery_id) || str(a && a.deliveryId) || null;
}

function isChannelCommand(a) {
  return a.commandMode === 'channel'
    || (isPlain(a.origin) && a.origin.kind === 'channel')
    || classifyPrompt(a.prompt) === 'channel';
}

function hookText(a) {
  const c = a.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((x) => typeof x === 'string').join('\n') : '';
}

// A pending enqueue's digest: its normalized content, never kept as text.
function digestOf(text) {
  return stableHash(['q', String(text).replace(/\s+/g, ' ').trim()]).slice(0, 20);
}

// Drop the oldest pending entries past QUEUE_MAX, in place.
function bounded(xs) {
  if (xs.length > QUEUE_MAX) xs.splice(0, xs.length - QUEUE_MAX);
}

// ── the fold ────────────────────────────────────────────────────────────────

function foldCarriers(state, recs) {
  const s = adopt(state);
  const changes = [];
  const delivered = [];
  const markers = new Set(s.markers);

  // Pair one occurrence, and say whether it is the notification's first
  // delivery (the one that makes its item). A group's `m` is set once its item
  // has been made.
  function pair(key, carrier, deliveryId) {
    const fits = (x) => x.k === key && !x.c.includes(carrier)
      && (x.d === null || deliveryId === null || x.d === deliveryId);
    // A delivery joins a group still waiting for one before a delivered group
    // (V5: each notification is delivered once), so a repeat of the same text
    // — a monitor's identical event — is never folded into the earlier one.
    let g = (carrier !== CARRIER.enqueue && s.groups.find((x) => !x.m && fits(x))) || s.groups.find(fits);
    if (g) {
      g.c.push(carrier);
      if (g.d === null && deliveryId !== null) g.d = deliveryId;
    } else {
      g = { k: key, c: [carrier], d: deliveryId, m: false };
      s.groups.push(g);
    }
    const first = carrier !== CARRIER.enqueue && !g.m;
    if (first) g.m = true;
    // A group that has seen every carrier can take no more.
    if (g.c.length === 3) s.groups.splice(s.groups.indexOf(g), 1);
    if (s.groups.length > GROUPS_MAX) s.groups.splice(0, s.groups.length - GROUPS_MAX);
    return first;
  }

  function notifications(text, carrier, deliveryId, rec, r) {
    let n = 0;
    for (const block of parseNotifications(text)) {
      const tags = block.tags;
      const ref = tags['task-id'] || tags['tool-use-id'];
      if (!ref) continue;
      const key = stableHash([ref, block.body.replace(/\s+/g, ' ').trim()]).slice(0, 20);
      if (!pair(key, carrier, deliveryId)) continue;
      changes.push(change(taskItem(n, block, rec, r), rec, r));
      n += 1;
    }
  }

  function change(item, rec, r) {
    const ch = { type: 'item', item };
    const ts = tsOf(rec);
    if (ts !== null) ch.ts = ts;
    const off = offsetOf(r);
    if (off) ch.offset = off;
    if (typeof rec.uuid === 'string' && rec.uuid) ch.uuid = rec.uuid;
    return ch;
  }

  function scan(text, via, r) {
    for (const marker of messageMarkers(text)) {
      if (markers.has(marker)) continue;
      markers.add(marker);
      delivered.push({ via, marker, offset: offsetOf(r) });
    }
  }

  function queuedChange(id, fields, rec, r) {
    changes.push(change({ id, kind: 'queued', ...fields }, rec, r));
  }

  // The pending enqueue a dequeue or remove names: by its content's digest when
  // it carries content, else the queue's head.
  function takePending(content) {
    const i = content === null ? (s.queue.length ? 0 : -1) : s.queue.findIndex((e) => e.h === digestOf(content));
    return i < 0 ? null : s.queue.splice(i, 1)[0];
  }

  function queueOperation(rec, r) {
    const content = str(rec.content);
    if (rec.operation === 'enqueue') {
      if (content === null) return;
      // A notification's content is read for its pairing key and digest alone.
      const isNote = parseNotifications(content).length > 0;
      if (isNote) notifications(content, CARRIER.enqueue, deliveryIdOf(rec, null), rec, r);
      // THE IDLE RULE: an idle enqueue is the next opener's own message.
      const id = !isNote && s.busy && content.trim() && Number.isFinite(r.start) ? `q_o${r.start}` : null;
      if (id) queuedChange(id, { text: content, status: 'queued' }, rec, r);
      s.queue.push({ h: digestOf(content), id, q: false });
      bounded(s.queue);
      return;
    }
    if (rec.operation === 'dequeue') {
      const e = takePending(content);
      if (e && e.id && !e.q) queuedChange(e.id, { status: 'sent' }, rec, r);
      return;
    }
    if (rec.operation === 'remove') {
      const e = takePending(content);
      if (!e || !e.id) return;
      if (rec.reason !== 'absorbed_mid_turn') { queuedChange(e.id, { status: 'removed' }, rec, r); return; }
      if (e.q) return; // its queued_command already marked it absorbed
      queuedChange(e.id, { status: 'absorbed' }, rec, r);
      s.absorbed.push({ h: e.h, id: e.id });
      bounded(s.absorbed);
    }
  }

  // A non-notification queued_command: the message Claude absorbed mid-turn. It
  // updates its enqueue's item when one is pending (before or after that
  // enqueue's remove), else makes its own.
  function queuedCommand(prompt, rec, r) {
    const h = digestOf(prompt);
    const ai = s.absorbed.findIndex((e) => e.h === h);
    if (ai >= 0) {
      const [e] = s.absorbed.splice(ai, 1);
      queuedChange(e.id, { text: prompt, status: 'absorbed' }, rec, r);
      return;
    }
    const e = s.queue.find((x) => x.id && !x.q && x.h === h);
    if (e) {
      e.q = true;
      queuedChange(e.id, { text: prompt, status: 'absorbed' }, rec, r);
      return;
    }
    const id = seg(rec.uuid, 40) || (Number.isFinite(r.start) ? `o${r.start}` : null);
    if (id) queuedChange(`q_${id}`, { text: prompt, status: 'absorbed' }, rec, r);
  }

  for (const r of Array.isArray(recs) ? recs : []) {
    const rec = r && isPlain(r.obj) ? r.obj : null;
    if (!rec) continue;
    const kind = kindOf(rec);
    if (BUSY_ON.has(kind)) s.busy = true;
    else if (kind === BUSY_OFF) s.busy = false;
    const row = rowOf(kind);
    if (!row || !row.carrier) continue;
    const a = isPlain(rec.attachment) ? rec.attachment : {};

    switch (kind) {
      case 'queue-operation':
        queueOperation(rec, r);
        break;
      case 'user/task-notification':
        notifications(userText(rec), CARRIER.user, deliveryIdOf(rec, null), rec, r);
        break;
      case 'user/channel':
        scan(userText(rec), 'channel', r);
        break;
      case 'attachment/queued_command': {
        const prompt = str(a.prompt) || '';
        if (a.commandMode === 'task-notification') {
          notifications(prompt, CARRIER.queued, deliveryIdOf(rec, a), rec, r);
          break;
        }
        if (isChannelCommand(a)) scan(prompt, 'channel', r);
        if (prompt.trim()) queuedCommand(prompt, rec, r);
        break;
      }
      case 'attachment/hook_additional_context': {
        // Only web-chat's own parked frame (lib/core/prompt-class PARKED_HEAD).
        const text = hookText(a);
        if (text.includes(require('../../core/prompt-class').PARKED_HEAD)) scan(text, 'parked', r);
        break;
      }
      default: break;
    }
  }

  const kept = [...markers];
  s.markers = kept.length > MARKERS_MAX ? kept.slice(kept.length - MARKERS_MAX) : kept;
  return { state: s, changes, delivered };
}

module.exports = {
  initialCarriers,
  foldCarriers,
  parseNotifications,
  STATE_VERSION,
  GROUPS_MAX,
  MARKERS_MAX,
  QUEUE_MAX,
};

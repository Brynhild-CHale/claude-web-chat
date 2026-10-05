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
// also gets) makes no item. `queue-operation.content` is NEVER_EMIT (§5.5): it
// is read only to compute the pairing key — a digest, which is all the state
// keeps — and never into a change.
//
// The item: {id, kind: 'task', task_id, task_kind, status, summary, exit_code?,
// event?}. `id` is `t_<taskId>_<n>` where n is the delivery record's uuid (its
// byte offset, `o<start>`, should it have none), plus `_<i>` for the i-th
// notification block of one record (i ≥ 1). A counter would need cross-batch
// state, and a fresh-state re-read of one turn (below) must name the item as the
// whole-file fold did. `task_kind` is 'monitor' for a Monitor event or summary,
// else from the id's shape ('agent' a + 16 hex, 'workflow' w…, 'shell' b…),
// else 'unknown'; `status` maps the block's <status> onto the TaskRow
// vocabulary (completed → done, failed, killed, stopped; an <event> with no
// status → running, a `[Monitor expired` one → expired; else unknown).
//
// TYPED-WHILE-BUSY. An `attachment/queued_command` whose commandMode is not a
// task notification is a message Claude absorbed mid-turn: a `queued` item
// {id: `q_<uuid>`, kind: 'queued', text, status: 'absorbed'}. A message that
// waited for the turn to end is dequeued and opens the next turn as a prompt —
// the normalizer's opener — so its enqueue makes no item here, and no
// queue-operation's content is read for one.
//
// THE CHANGE CONTRACT is the turn machine's (turn-machine.js header): each change
// is `{type: 'item', item, ts, offset: {start, end}, uuid}` with NO seq. THE SEQ
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
//   EVERY `attachment/hook_additional_context`           → via 'parked'
// Which carrier holds a live channel's marker, idle and mid-turn, is gate V30
// (§10.3, the maintainer's, after U63): both are scanned, and nothing here
// depends on a confirmation. The parked prefix lives in lib/hooks/turn-begin.js
// (PARKED_PREFIX), which lib/server may not import, so every hook context is
// scanned and a marker there counts as 'parked' (ruled U27@parked-prefix (a);
// the prefix moves properly with U63, tranche 4). Each marker is delivered once
// per session: the state remembers the last MARKERS_MAX. `delivered` is
// returned, never emitted: the transcripts source turns each into
// `{kind:'mirror', op:'delivered', conversation_id, via, marker}`.
//
// RE-READS. foldCarriers is callable on a byte-range re-read with a FRESH state
// (initialCarriers()): the items need no cross-batch state, because each is
// made at, and named after, its own delivery record. U28a's LRU refill calls it
// that way (U28a@refill-carriers) and gets the same task items back for the
// turn; it must ignore the refill's `delivered` (a fresh state has forgotten
// which markers were already delivered). The one case a fresh state reads
// differently: a notification delivered by BOTH a user record and a
// queued_command in two different turns (V5 saw each notification delivered
// once) — re-read alone, the later turn would make its own item.
//
// The state is plain JSON (the source may persist it): pairing groups hold a
// digest of their key, never the text. Pure: no I/O, no clock, no timers.
// Dependency direction: lib/core and the mirror's own records.js.

const { kindOf, rowOf } = require('./records');
const { messageMarkers, classifyPrompt } = require('../../core/prompt-class');
const { stableHash } = require('../../core/stable-json');

const STATE_VERSION = 1;
const GROUPS_MAX = 1024;
const MARKERS_MAX = 1024;
const CARRIER = Object.freeze({ enqueue: 'e', user: 'u', queued: 'q' });

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

function initialCarriers() {
  return { v: STATE_VERSION, groups: [], markers: [] };
}

function adopt(state) {
  if (!isPlain(state) || state.v !== STATE_VERSION) return initialCarriers();
  const groups = Array.isArray(state.groups)
    ? state.groups.filter((g) => isPlain(g) && typeof g.k === 'string' && Array.isArray(g.c))
      .map((g) => ({ k: g.k, c: g.c.filter((x) => typeof x === 'string'), d: typeof g.d === 'string' ? g.d : null, m: g.m === true }))
    : [];
  const markers = Array.isArray(state.markers) ? state.markers.filter((m) => typeof m === 'string') : [];
  return { v: STATE_VERSION, groups, markers };
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
  if (tags.event !== undefined || /\bmonitor\b/i.test(tags.summary || '')) return 'monitor';
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

  for (const r of Array.isArray(recs) ? recs : []) {
    const rec = r && isPlain(r.obj) ? r.obj : null;
    if (!rec) continue;
    const kind = kindOf(rec);
    const row = rowOf(kind);
    if (!row || !row.carrier) continue;
    const a = isPlain(rec.attachment) ? rec.attachment : {};

    switch (kind) {
      case 'queue-operation':
        // Only an enqueue opens a pairing group; its content is read for the key
        // alone, and only when it holds a notification block.
        if (rec.operation === 'enqueue') notifications(str(rec.content), CARRIER.enqueue, deliveryIdOf(rec, null), rec, r);
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
        if (prompt.trim()) {
          const id = seg(rec.uuid, 40) || (Number.isFinite(r.start) ? `o${r.start}` : null);
          if (id) changes.push(change({ id: `q_${id}`, kind: 'queued', text: prompt, status: 'absorbed' }, rec, r));
        }
        break;
      }
      case 'attachment/hook_additional_context':
        scan(hookText(a), 'parked', r);
        break;
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
};

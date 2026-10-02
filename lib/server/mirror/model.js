// lib/server/mirror/model.js — the chat mirror's in-memory model.
//
// One store for everything the mirror shows (spec §2.4, §2.9, §2.12): each
// conversation's meta and live state, its turns (the header the stream draws per
// prompt), each turn's items (a prompt, a reply, a tool call, a notice, …) and the
// background task rows. Every source of the engine writes here, and every frame
// and every read is built from here.
//
// THE INBOUND REDACTION POINT. Every value that enters goes through `scrub`
// before anything is stored: every string — text fields, and ids, labels and
// enum values too — passes the injected redactor (`ctx.redactor`, lib/core/redact;
// a fake in the tests), and a tool call's structured `input` goes through
// `redactor.value`, so a key named like a secret masks its value whole. A string
// the redactor fails on is dropped, never kept as it came in. Stored objects are
// frozen, so nothing can write a string into them afterwards: the model never
// holds an unredacted string (spec §2.9 rule 1). The read boundary's second pass
// (`redactOut`) is the facade's, not this file's.
//
// THE CAPS (spec §2.4). Content is stored at the FULL-read caps; a frame and an
// `items=summary` read are cut again at the smaller SUMMARY caps on the way out
// (`serializeItem`). A field a cap shortened sets `truncated: true` on the item.
// Fields whose name starts with `_` are in-process only (a persisted output's
// path, say): `serialize` never emits them, at any depth.
//
// THE ITEM LRU. The transcript is the store (D3, V14): a turn's header stays in
// memory for the life of the conversation, but its items are copies, held in a
// bounded LRU of turns. When the budget is exceeded the least recently used
// closed turn loses its items (`isEvicted`), and the transcripts source refills
// it from the turn's byte range on the next read (`refillTurn`). Open turns and
// each conversation's newest turns are never evicted.
//
// TURNS have two writers, kept apart on purpose. The turn machine
// (turn-machine.js) owns the lifecycle — open, bind, close, alias, supersede,
// attach — through a writer it claims ONCE (`claimTurnWriter`); `superseded` is
// set by that writer's `markSuperseded` alone, which turn-machine.js calls from
// its one `supersede` (the acceptance's "only code path"). The model itself owns
// the fields derived from a turn's items (`prompt`, `reply_preview`, `counts`,
// `tool_names`, `groups`) and the `group` stamped on each tool call. Any other
// source patches only the remaining header fields (`code`, …) via `patchTurn`.
//
// CHANGES. Every write marks what changed per conversation; the emitter
// (emit.js, §2.9) drains them with `takeChanges({rev})`, which also stamps the
// flush's `rev` on each changed object.
//
// Pure and in memory: no I/O, no timers, no clock reads of its own.

const K = 1024;

// [in frames and items=summary reads, in full reads], characters (spec §2.4).
const ITEM_CAPS = Object.freeze({
  prompt: { text: [16 * K, 256 * K], 'attachments.name': [300, 300] },
  queued: { text: [16 * K, 256 * K] },
  reply: { text: [32 * K, 1024 * K] },
  thinking: { text: [4 * K, 64 * K] },
  tool_call: {
    label: [200, 200],
    call: [2 * K, 8 * K],
    'result.preview': [2 * K, 256 * K],
    'edit.patch': [16 * K, 256 * K],
  },
  notice: { text: [2 * K, 64 * K] },
  local: { input: [2 * K, 64 * K], output: [2 * K, 64 * K] },
  task: { summary: [2 * K, 64 * K], result_preview: [2 * K, 64 * K] },
  compact: { summary: [2 * K, 64 * K] },
  away: { text: [2 * K, 64 * K] },
  artifact: { title: [300, 300], url: [2 * K, 2 * K] },
});
// A tool call's structured input: every string cut at `string`, the whole at
// `total` characters of JSON.
const INPUT_CAPS = Object.freeze({
  summary: { total: 2 * K, string: 512 },
  full: { total: 64 * K, string: 64 * K },
});
// Any other string in an item ("notice/local output/summary" is the spec's
// smallest content class; nothing an item carries is allowed to be unbounded).
const DEFAULT_ITEM_CAP = Object.freeze([2 * K, 64 * K]);

// Single-level caps for the objects that have no full read of their own.
const PREVIEW_CHARS = 280;
const TURN_CAPS = Object.freeze({
  'prompt.preview': PREVIEW_CHARS,
  reply_preview: PREVIEW_CHARS,
  tool_names: 200,
  'groups.names': 200,
  'node.label': 200,
  'folded_into.label': 200,
  'code.reason': 200,
});
const TASK_CAPS = Object.freeze({ title: 300, line: 300, 'steps.label': 200, 'owner.title': 300 });
const CONVERSATION_CAPS = Object.freeze({ title: 300, name: 300, 'away.text': 2 * K });
const LIVE_CAPS = Object.freeze({ 'step.label': 200, 'waiting.summary': 2 * K, 'last_turn.reply_preview': PREVIEW_CHARS });
const DEFAULT_CAP = 2 * K;

// The item LRU's budget. Exported so the facade can tune it; the tests shrink it.
const LRU_MAX_CHARS = 16 * 1024 * 1024;
const LRU_MAX_ITEMS = 40000;
const LRU_KEEP_RECENT = 3; // each conversation's newest turns are never evicted

const ITEM_KINDS = new Set(['prompt', 'reply', 'thinking', 'tool_call', 'task', 'notice', 'compact', 'away', 'queued', 'local', 'artifact']);
// Only these three break a run of tool calls into two groups (the density ruling).
const GROUP_SEPARATORS = new Set(['reply', 'thinking', 'prompt']);
const TERMINAL_TOOL = new Set(['done', 'error', 'denied', 'interrupted']);
const TERMINAL_TASK = new Set(['done', 'failed', 'killed', 'stopped', 'expired']);
// Nested item content merged key by key, the transcript's keys winning over a
// hook's (`result`, `edit`); and nested LIVE facts merged key by key with the
// latest write winning whichever source wrote it (`awaiting` moves pending →
// decided → resolved through hooks, the transcript and the asks domain alike;
// `links` only ever gains ids).
const NESTED_CONTENT = ['result', 'edit'];
const NESTED_LIVE = ['links', 'awaiting'];
// The subtrees of an item whose text is tool OUTPUT: only these are redacted with
// the tool's `{file, command}` context (spec §5.5). A label, a call or an input is
// never withheld — the user must see what runs.
const CONTEXT_FIELDS = new Set(['result', 'edit', 'output', 'result_preview']);
// Header fields by owner (see the header comment).
const LIFECYCLE_FIELDS = new Set(['id', 'conversation_id', 'session_id', 'seq', 'kind', 'author', 'status', 'provisional',
  'replaces', 'started_at', 'ended_at', 'duration_ms', 'ended_by', 'node', 'folded_into']);
const DERIVED_FIELDS = new Set(['prompt', 'reply_preview', 'counts', 'tool_names', 'groups']);
// Optional header fields: a lifecycle patch's `null` removes them.
const OPTIONAL_FIELDS = new Set(['provisional', 'replaces', 'ended_at', 'duration_ms', 'ended_by']);
// Computed at serialization, never stored from a patch.
const COMPUTED_CONVERSATION_FIELDS = new Set(['id', 'rev', 'live', 'turn_count', 'open_turn_id', 'counts']);
const TASK_COUNT_KEY = { shell: 'shells', agent: 'agents', workflow: 'workflows', monitor: 'monitors' };
// A turn's kind → its prompt's origin (spec §2.4's two vocabularies), for a prompt
// item that does not name one and for a header whose turn has no prompt item.
const ORIGIN_OF_KIND = Object.freeze({ prompt: 'human', 'task-notification': 'task-notification', channel: 'channel',
  command: 'command', shell: 'shell', other: 'other' });
// Item ids derived from their turn's id (spec §2.4: `p_<turnId>`, `rl_<turnId>`;
// `rw_<turnId>` is a rewound notice, turn-machine.js): re-keyed with it on an alias.
const TURN_ITEM_PREFIXES = ['p_', 'rl_', 'rw_'];
const MAX_NAMES = 8;

// Ids are URL-safe (spec §2.4: `/api/mirror/items/:itemId`).
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// A key shaped like a field name is the model's vocabulary; any other key (a map
// keyed by content) is itself content and must pass the redactor unchanged.
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 16;

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function validId(v) { return typeof v === 'string' && ID_RE.test(v); }

// Cut to `max` characters without leaving half a surrogate pair behind.
function cutString(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// A deep copy without `_`-prefixed fields: what leaves the model.
function serialize(v) {
  if (Array.isArray(v)) return v.map(serialize);
  if (isPlain(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (k.charCodeAt(0) === 95) continue; // '_'
      out[k] = serialize(v[k]);
    }
    return out;
  }
  return v;
}

// Walk `v`, cutting every string to `capOf(path)`; `cut` collects the paths cut.
// Array indexes do not enter the path (`attachments.name`).
function capTree(v, path, capOf, cut) {
  if (typeof v === 'string') {
    const max = capOf(path);
    if (v.length > max) { cut.add(path); return cutString(v, max); }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => capTree(x, path, capOf, cut));
  if (isPlain(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = capTree(v[k], path ? `${path}.${k}` : k, capOf, cut);
    return out;
  }
  return v;
}

// A structured tool input: strings cut at the per-string cap, halved until the
// whole fits the total; past the smallest string cap, trailing keys go.
function capInput(input, { total, string }, cut) {
  if (typeof input === 'string') {
    if (input.length > total) { cut.add('input'); return cutString(input, total); }
    return input;
  }
  if (!isPlain(input) && !Array.isArray(input)) return input;
  let per = string;
  for (;;) {
    const local = new Set();
    const out = capTree(input, '', () => per, local);
    if (JSON.stringify(out).length <= total) {
      if (local.size) cut.add('input');
      return out;
    }
    if (per <= 32) break;
    per = Math.floor(per / 2);
  }
  cut.add('input');
  const small = capTree(input, '', () => 32, new Set());
  if (Array.isArray(small)) {
    const out = [];
    for (const x of small) { out.push(x); if (JSON.stringify(out).length > total) { out.pop(); break; } }
    return out;
  }
  const out = {};
  for (const k of Object.keys(small)) {
    out[k] = small[k];
    if (JSON.stringify(out).length > total) { delete out[k]; break; }
  }
  return out;
}

// Cap an item's fields at one level ('summary' | 'full'), collecting cut paths.
function capItem(item, level, cut) {
  const col = level === 'full' ? 1 : 0;
  const table = ITEM_CAPS[item.kind] || {};
  const out = {};
  for (const k of Object.keys(item)) {
    if (k === 'input' && item.kind === 'tool_call') { out.input = capInput(item.input, INPUT_CAPS[level], cut); continue; }
    out[k] = capTree(item[k], k, (p) => (table[p] || DEFAULT_ITEM_CAP)[col], cut);
  }
  return out;
}

// The leaf paths a patch writes (for keeping an item's cut set honest on a merge).
function leafPaths(v, path, out) {
  if (isPlain(v) && path !== 'input') {
    for (const k of Object.keys(v)) leafPaths(v[k], path ? `${path}.${k}` : k, out);
  } else if (path) out.add(path);
  return out;
}

function charsOf(v) {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) { let n = 0; for (const x of v) n += charsOf(x); return n; }
  if (isPlain(v)) { let n = 0; for (const k of Object.keys(v)) n += k.length + charsOf(v[k]); return n; }
  return 8;
}

// `kinds` extends the item vocabulary (spec §2.4's eleven) at construction, so a
// later source can add one without editing this file.
function createModel({
  redactor,
  lru: { maxChars = LRU_MAX_CHARS, maxItems = LRU_MAX_ITEMS, keepRecent = LRU_KEEP_RECENT } = {},
  kinds = [],
} = {}) {
  if (!redactor || typeof redactor.text !== 'function') {
    throw new Error('mirror model: a redactor with text() is required (ctx.redactor) — the model never stores an unredacted string');
  }
  const itemKinds = new Set([...ITEM_KINDS, ...kinds.filter((k) => typeof k === 'string' && /^[a-z][a-z_]{1,23}$/.test(k))]);

  // ---- state ---------------------------------------------------------------
  const conversations = new Map(); // id → frozen meta (no computed fields)
  const lives = new Map(); // conversation id → frozen Live
  const turns = new Map(); // id → frozen header
  const turnLists = new Map(); // conversation id → [turn id] in seq order
  const items = new Map(); // turn id → Map(item id → frozen item)
  const itemTurn = new Map(); // item id → turn id
  const itemCut = new Map(); // item id → Set(paths the FULL cap cut)
  const tasks = new Map(); // id → frozen TaskRow
  const revs = new Map(); // 'c:'|'l:'|'t:'|'i:'|'k:' + id → rev of its last change
  const lru = new Map(); // turn id → chars held (insertion order = recency)
  const itemSize = new Map(); // item id → the chars counted for it in its turn's total
  const evicted = new Set(); // turn ids whose items were dropped (refill on read)
  const seqs = new Map(); // conversation id → { ordinal, prov }
  const dirty = new Map(); // conversation id → change sets
  let totalChars = 0;
  let totalItems = 0;
  let writerClaimed = false;
  let failures = 0; // strings the redactor failed on (dropped)

  // ---- redaction: the one inbound point --------------------------------------
  function text(s, context) {
    let out;
    try { out = context ? redactor.text(s, { context }) : redactor.text(s); } catch { out = undefined; }
    if (typeof out !== 'string') { failures++; return undefined; }
    return out;
  }

  function value(v) {
    if (typeof redactor.value !== 'function') return v;
    try { return redactor.value(v); } catch { failures++; return undefined; }
  }

  // Every string passes the redactor; anything that is not plain data is dropped.
  function walk(v, context, depth) {
    if (typeof v === 'string') return text(v, context);
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean' || v === null) return v;
    if (depth >= MAX_DEPTH) return undefined;
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) { const y = walk(x, context, depth + 1); if (y !== undefined) out.push(y); }
      return out;
    }
    if (isPlain(v)) {
      const out = {};
      for (const k of Object.keys(v)) {
        if (FORBIDDEN_KEYS.has(k) || k.length > 128) continue;
        if (!FIELD_RE.test(k) && text(k) !== k) continue; // a content key the redactor would change
        const y = walk(v[k], context, depth + 1);
        if (y !== undefined) out[k] = y;
      }
      return out;
    }
    return undefined;
  }

  // A record's top level: field names only; `input` is structured content.
  function scrubRecord(raw, context) {
    const out = {};
    for (const k of Object.keys(raw)) {
      if (FORBIDDEN_KEYS.has(k) || !FIELD_RE.test(k)) continue;
      let v = raw[k];
      if (k === 'input' && (isPlain(v) || Array.isArray(v))) v = value(v);
      const y = walk(v, context && CONTEXT_FIELDS.has(k) ? context : null, 1);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }

  // Public: the scrub every write uses, for a caller that must compare its own
  // input with what the model stored (the turn machine's prompt match) or hold an
  // id only once the redactor has seen it.
  function scrubText(s, context) { return typeof s === 'string' ? text(s, context) : undefined; }
  function scrubValue(v) { return walk(v, null, 0); }
  function cleanId(v) {
    if (!validId(v)) return null;
    return text(v) === v ? v : null;
  }

  // ---- changes ----------------------------------------------------------------
  function sets(cid) {
    let d = dirty.get(cid);
    if (!d) {
      d = { conversation: false, live: false, turns: new Set(), items: new Set(), removed_items: new Set(),
        tasks: new Set(), removed_tasks: new Set(), removed: false, merged_into: null };
      dirty.set(cid, d);
    }
    return d;
  }
  const markConversation = (cid) => { sets(cid).conversation = true; };
  const markLive = (cid) => { sets(cid).live = true; };
  const markTurn = (cid, id) => { sets(cid).turns.add(id); };
  function markItem(cid, id) { const d = sets(cid); d.items.add(id); d.removed_items.delete(id); }
  function markRemovedItem(cid, id) { const d = sets(cid); d.items.delete(id); d.removed_items.add(id); }
  function markTask(cid, id) { const d = sets(cid); d.tasks.add(id); d.removed_tasks.delete(id); }
  function markRemovedTask(cid, id) { const d = sets(cid); d.tasks.delete(id); d.removed_tasks.add(id); }

  // Drain every change since the last call. With `rev`, stamp it on each changed
  // object first (the emitter's per-flush counter, §2.9).
  function takeChanges({ rev } = {}) {
    const out = [];
    for (const [cid, d] of dirty) {
      if (Number.isFinite(rev)) {
        if (d.conversation) revs.set(`c:${cid}`, rev);
        if (d.live) revs.set(`l:${cid}`, rev);
        for (const id of d.turns) revs.set(`t:${id}`, rev);
        for (const id of d.items) revs.set(`i:${id}`, rev);
        for (const id of d.tasks) revs.set(`k:${id}`, rev);
      }
      const entry = { conversation_id: cid, conversation: d.conversation, live: d.live, turns: [...d.turns], items: [...d.items],
        removed_items: [...d.removed_items], tasks: [...d.tasks], removed_tasks: [...d.removed_tasks] };
      if (d.removed) { entry.removed = true; if (d.merged_into) entry.merged_into = d.merged_into; }
      out.push(entry);
    }
    dirty.clear();
    return out;
  }

  function revOf(prefix, id) { return revs.get(`${prefix}:${id}`) || 0; }

  // ---- conversations and live ---------------------------------------------------
  function ensureConversation(cid) {
    if (!conversations.has(cid)) {
      conversations.set(cid, deepFreeze({ id: cid }));
      turnLists.set(cid, []);
      markConversation(cid);
    }
  }

  // Shallow merge: a top-level key replaces, `undefined` keeps, `null` sets null.
  function upsertConversation(id, patch = {}) {
    const cid = cleanId(id);
    if (!cid || !isPlain(patch)) return null;
    ensureConversation(cid);
    const clean = scrubRecord(patch, null);
    for (const k of COMPUTED_CONVERSATION_FIELDS) delete clean[k];
    const capped = capTree(clean, '', (p) => CONVERSATION_CAPS[p] || DEFAULT_CAP, new Set());
    if (!Object.keys(capped).length) return conversations.get(cid);
    const next = deepFreeze({ ...conversations.get(cid), ...capped, id: cid });
    conversations.set(cid, next);
    markConversation(cid);
    return next;
  }

  function upsertLive(id, live = {}) {
    const cid = cleanId(id);
    if (!cid || !isPlain(live)) return null;
    ensureConversation(cid);
    const clean = scrubRecord(live, null);
    delete clean.rev;
    const capped = capTree(clean, '', (p) => LIVE_CAPS[p] || DEFAULT_CAP, new Set());
    const next = deepFreeze({ ...(lives.get(cid) || {}), ...capped });
    lives.set(cid, next);
    markLive(cid);
    return next;
  }

  const conversation = (id) => conversations.get(id) || null;
  const liveOf = (id) => lives.get(id) || null;
  const listConversations = () => [...conversations.values()];

  // Drop a conversation and everything of it. `merged_into` names the one that
  // absorbed it (spec §2.2: a link found later merges the younger); its content is
  // re-read into the survivor from the transcripts, which are the store.
  function removeConversation(id, { merged_into } = {}) {
    const cid = conversations.has(id) ? id : null;
    if (!cid) return false;
    for (const tid of [...(turnLists.get(cid) || [])]) dropTurn(tid);
    for (const [kid, row] of [...tasks]) if (row.conversation_id === cid) { tasks.delete(kid); revs.delete(`k:${kid}`); }
    conversations.delete(cid);
    lives.delete(cid);
    turnLists.delete(cid);
    seqs.delete(cid);
    revs.delete(`c:${cid}`);
    revs.delete(`l:${cid}`);
    dirty.delete(cid);
    const d = sets(cid);
    d.removed = true;
    const into = cleanId(merged_into);
    if (into) d.merged_into = into;
    return true;
  }

  // ---- turns: reads ---------------------------------------------------------------
  const turn = (id) => turns.get(id) || null;
  function turnsOf(cid, { session_id } = {}) {
    const ids = turnLists.get(cid) || [];
    const out = [];
    for (const id of ids) { const t = turns.get(id); if (t && (!session_id || t.session_id === session_id)) out.push(t); }
    return out;
  }
  // The newest page, ascending within it (the content route's paging, §2.10).
  function turnPage(cid, { before, limit = 20 } = {}) {
    const all = turnsOf(cid);
    const upto = Number.isFinite(before) ? all.filter((t) => t.seq < before) : all;
    const page = upto.slice(Math.max(0, upto.length - Math.max(1, limit)));
    return { turns: page, next_before: upto.length > page.length && page.length ? page[0].seq : null, total: all.length };
  }

  function insertOrdered(cid, id, seq) {
    const list = turnLists.get(cid);
    let i = list.length;
    while (i > 0 && (turns.get(list[i - 1])?.seq ?? -Infinity) > seq) i--;
    list.splice(i, 0, id);
  }

  function storeTurn(next) {
    deepFreeze(next);
    turns.set(next.id, next);
    markTurn(next.conversation_id, next.id);
    return next;
  }

  const ZERO_COUNTS = Object.freeze({ items: 0, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 });
  function headerDefaults(kind) {
    return {
      session_id: null, kind: 'prompt', author: 'user', status: 'open', started_at: null,
      prompt: { preview: '', origin: ORIGIN_OF_KIND[kind] || 'other' }, reply_preview: '', counts: { ...ZERO_COUNTS },
      tool_names: [], groups: [], node: null, folded_into: null, code: null,
    };
  }

  // The turn machine's lifecycle write. Creates the header when absent (id,
  // conversation_id and seq required); a derived field or `superseded` in the
  // patch is ignored; an optional field set to null is removed.
  function putTurn(patch) {
    if (!isPlain(patch)) return null;
    const clean = scrubRecord(patch, null);
    const id = cleanId(clean.id);
    if (!id) return null;
    const prev = turns.get(id);
    const nullable = new Set();
    for (const k of OPTIONAL_FIELDS) if (patch[k] === null) nullable.add(k);
    const lifecycle = {};
    for (const k of Object.keys(clean)) if (LIFECYCLE_FIELDS.has(k)) lifecycle[k] = clean[k];
    const capped = capTree(lifecycle, '', (p) => TURN_CAPS[p] || DEFAULT_CAP, new Set());
    if (!prev) {
      const cid = cleanId(capped.conversation_id);
      if (!cid || !Number.isFinite(capped.seq)) return null;
      ensureConversation(cid);
      // The defaults pass the redactor too: no stored string skips it, the model's own included.
      const next = {
        ...scrubRecord(headerDefaults(capped.kind), null),
        id, conversation_id: cid, seq: capped.seq,
        ...capped,
      };
      for (const k of nullable) delete next[k];
      if (!items.has(id)) items.set(id, new Map());
      storeTurn(next);
      insertOrdered(cid, id, next.seq);
      touch(id, 0);
      return turns.get(id);
    }
    const next = { ...prev };
    for (const k of Object.keys(capped)) {
      if (k === 'id' || k === 'conversation_id' || k === 'seq') continue; // identity is fixed (renameTurn moves it)
      next[k] = capped[k];
    }
    for (const k of nullable) delete next[k];
    return storeTurn(next);
  }

  // A source's write: any header field the turn machine and the derivation do not own.
  function patchTurn(id, patch) {
    const prev = turns.get(id);
    if (!prev || !isPlain(patch)) return null;
    const clean = scrubRecord(patch, null);
    const own = {};
    for (const k of Object.keys(clean)) {
      if (LIFECYCLE_FIELDS.has(k) || DERIVED_FIELDS.has(k) || k === 'superseded' || k === 'rev') continue;
      own[k] = clean[k];
    }
    if (!Object.keys(own).length) return prev;
    const capped = capTree(own, '', (p) => TURN_CAPS[p] || DEFAULT_CAP, new Set());
    return storeTurn({ ...prev, ...capped });
  }

  // The one place `superseded` is written; reached only through the claimed
  // writer, which turn-machine.js calls from `supersede` alone. Returns the ids
  // that changed.
  function markSuperseded(ids) {
    const changed = [];
    for (const id of ids || []) {
      const prev = turns.get(id);
      if (!prev || prev.superseded === true) continue;
      storeTurn({ ...prev, superseded: true });
      changed.push(id);
    }
    return changed;
  }

  // An index restore (§2.11): the header as it was persisted, its derived fields
  // included (its items are not in memory: the turn starts evicted and is refilled
  // from its byte range when read). `superseded` is never taken from a record —
  // the turn machine replays its rewinds through `supersede`.
  function restoreTurn(header) {
    if (!isPlain(header)) return null;
    const clean = scrubRecord(header, null);
    const id = cleanId(clean.id);
    const cid = cleanId(clean.conversation_id);
    if (!id || !cid || turns.has(id) || !Number.isFinite(clean.seq)) return null;
    delete clean.superseded;
    delete clean.rev;
    ensureConversation(cid);
    const capped = capTree(clean, '', (p) => TURN_CAPS[p] || DEFAULT_CAP, new Set());
    const next = { ...scrubRecord(headerDefaults(capped.kind), null), ...capped, id, conversation_id: cid };
    items.set(id, new Map());
    evicted.add(id);
    storeTurn(next);
    insertOrdered(cid, id, next.seq);
    return turns.get(id);
  }

  // An alias (§2.4 rule 2): the provisional turn takes the transcript's id. The
  // header carries `replaces`, the items derived from the turn id are re-keyed and
  // every item's `turn_id` follows; the old item ids leave as removed.
  function renameTurn(oldId, newIdRaw) {
    const prev = turns.get(oldId);
    const newId = cleanId(newIdRaw);
    if (!prev || !newId || turns.has(newId)) return null;
    const cid = prev.conversation_id;
    const header = { ...prev, id: newId, replaces: oldId };
    turns.delete(oldId);
    const d = dirty.get(cid);
    if (d) d.turns.delete(oldId);
    revs.delete(`t:${oldId}`);
    storeTurn(header);
    const list = turnLists.get(cid);
    const at = list.indexOf(oldId);
    if (at >= 0) list[at] = newId;
    const old = items.get(oldId) || new Map();
    const moved = new Map();
    for (const [iid, it] of old) {
      let nid = iid;
      for (const pre of TURN_ITEM_PREFIXES) {
        if (iid !== pre + oldId) continue;
        const composed = text(pre + newId); // a composed id passes the redactor like any other string
        if (composed === pre + newId) nid = composed;
      }
      const next = deepFreeze({ ...it, id: nid, turn_id: newId });
      moved.set(nid, next);
      itemTurn.delete(iid);
      itemTurn.set(nid, newId);
      itemSize.delete(iid);
      itemSize.set(nid, charsOf(next));
      if (nid !== iid) {
        const cut = itemCut.get(iid);
        itemCut.delete(iid);
        if (cut) itemCut.set(nid, cut);
        revs.delete(`i:${iid}`);
        markRemovedItem(cid, iid);
      }
      markItem(cid, nid);
    }
    items.delete(oldId);
    items.set(newId, moved);
    if (evicted.delete(oldId)) evicted.add(newId);
    let sum = 0;
    for (const nid of moved.keys()) sum += itemSize.get(nid) || 0;
    totalChars += sum - (lru.get(oldId) || 0);
    lru.delete(oldId);
    lru.set(newId, sum);
    recompute(newId);
    return turns.get(newId);
  }

  function dropTurn(id) {
    const t = turns.get(id);
    if (!t) return;
    const held = items.get(id);
    if (held) {
      for (const iid of held.keys()) { itemTurn.delete(iid); itemCut.delete(iid); itemSize.delete(iid); revs.delete(`i:${iid}`); }
      totalItems -= held.size;
    }
    totalChars -= lru.get(id) || 0;
    lru.delete(id);
    items.delete(id);
    evicted.delete(id);
    turns.delete(id);
    revs.delete(`t:${id}`);
    const list = turnLists.get(t.conversation_id);
    if (list) { const at = list.indexOf(id); if (at >= 0) list.splice(at, 1); }
  }

  function claimTurnWriter() {
    if (writerClaimed) {
      throw new Error('mirror model: the turn writer is already claimed — turn lifecycle belongs to the turn machine alone');
    }
    writerClaimed = true;
    return Object.freeze({ putTurn, renameTurn, markSuperseded, restoreTurn });
  }

  // ---- items ------------------------------------------------------------------------
  function seqState(cid) {
    let s = seqs.get(cid);
    if (!s) { s = { ordinal: 0, prov: 0 }; seqs.set(cid, s); }
    return s;
  }
  function noteOrdinal(cid, n) {
    const s = seqState(cid);
    if (n > s.ordinal) { s.ordinal = Math.floor(n); s.prov = 0; }
    return n;
  }
  function nextOrdinal(cid) {
    const s = seqState(cid);
    s.ordinal = Math.floor(s.ordinal) + 1;
    s.prov = 0;
    return s.ordinal;
  }
  // "provisional ones fractional values after the last known" (§2.9): 1/2, 2/3,
  // 3/4, … past the last ordinal, increasing and always short of the next one.
  function nextProvisional(cid) {
    const s = seqState(cid);
    s.prov += 1;
    return s.ordinal + 1 - 1 / (s.prov + 1);
  }

  function seqFor(cid, prev, next, explicit) {
    const tx = next.source === 'transcript';
    if (tx && Number.isFinite(explicit)) return noteOrdinal(cid, explicit);
    if (prev && (prev.source === 'transcript' || !tx)) return prev.seq;
    return tx ? nextOrdinal(cid) : nextProvisional(cid);
  }

  function mergeItem(prev, next) {
    if (!prev) return next;
    const prevTx = prev.source === 'transcript';
    const nextTx = next.source === 'transcript';
    let out;
    if (prevTx && !nextTx) {
      // A hook never overrides what the transcript said; it only fills gaps.
      out = { ...next, ...prev };
      for (const k of NESTED_CONTENT) if (isPlain(prev[k]) || isPlain(next[k])) out[k] = { ...(next[k] || {}), ...(prev[k] || {}) };
    } else {
      out = { ...prev, ...next };
      for (const k of NESTED_CONTENT) if (isPlain(prev[k]) && isPlain(next[k])) out[k] = { ...prev[k], ...next[k] };
    }
    for (const k of NESTED_LIVE) {
      if (isPlain(prev[k]) || isPlain(next[k])) out[k] = { ...(isPlain(prev[k]) ? prev[k] : {}), ...(isPlain(next[k]) ? next[k] : {}) };
    }
    // A finished tool call is never made running again: async hooks race, so a
    // PreToolUse can land after its PostToolUse, and the transcript's tool_use
    // after either (§1.1, §2.6 "Arrival order").
    if (TERMINAL_TOOL.has(prev.status) && out.status === 'running') {
      out.status = prev.status;
      for (const k of ['ended_at', 'duration_ms']) if (prev[k] !== undefined) out[k] = prev[k];
    }
    return out;
  }

  // Create or merge one item (§2.4 "Items"). `context` ({file, command}) is the
  // redaction context for the item's tool output; `silent` writes without
  // marking a change (a refill re-reads what the chrome already has).
  function upsertItem(raw, { context = null, silent = false, derive = true } = {}) {
    if (!isPlain(raw)) return null;
    const clean = scrubRecord(raw, context);
    const id = cleanId(clean.id);
    let tid = cleanId(clean.turn_id);
    if (!id || !tid || !turns.has(tid)) return null;
    const prevTid = itemTurn.get(id);
    const prev = prevTid && items.get(prevTid) ? items.get(prevTid).get(id) || null : null;
    const kind = clean.kind || (prev && prev.kind);
    if (!itemKinds.has(kind)) return null;
    clean.kind = kind;
    if (clean.source !== 'transcript' && clean.source !== 'hook') clean.source = prev ? prev.source : text('transcript');
    // The transcript places an item: only a transcript write moves one to another turn.
    if (prev && prevTid !== tid && clean.source !== 'transcript') tid = prevTid;
    const t = turns.get(tid);
    const cid = t.conversation_id;
    const explicit = clean.seq;
    delete clean.seq;
    delete clean.rev;
    delete clean.truncated;
    delete clean.group; // stamped by the derivation, never taken from a write
    clean.id = id;
    clean.turn_id = tid;
    clean.conversation_id = cid;
    const cut = new Set();
    const capped = capItem(clean, 'full', cut);
    let merged = mergeItem(prev, capped);
    merged.seq = seqFor(cid, prev, capped, explicit);
    if (merged.source === 'transcript') delete merged.provisional;
    else merged.provisional = true;
    // The cut set follows the leaves this write replaced.
    const prevCut = itemCut.get(id);
    const written = leafPaths(capped, '', new Set());
    const nextCut = new Set();
    if (prevCut) for (const p of prevCut) if (!written.has(p) && ![...written].some((w) => p.startsWith(`${w}.`))) nextCut.add(p);
    for (const p of cut) nextCut.add(p);
    if (nextCut.size) itemCut.set(id, nextCut); else itemCut.delete(id);
    merged = deepFreeze(merged);
    if (prev && prevTid !== tid) removeFromTurn(prevTid, id);
    putItem(tid, merged);
    if (!silent) markItem(cid, id);
    if (derive) {
      if (prev && prevTid !== tid) recompute(prevTid, { silent });
      recompute(tid, { silent });
    }
    return items.get(tid).get(id);
  }

  // Every item a turn holds is counted once, at its current size, in the turn's
  // LRU total and in `totalChars`.
  function putItem(tid, item) {
    let held = items.get(tid);
    if (!held) { held = new Map(); items.set(tid, held); }
    const before = held.has(item.id) ? itemSize.get(item.id) || 0 : 0;
    if (!held.has(item.id)) totalItems += 1;
    held.set(item.id, item);
    itemTurn.set(item.id, tid);
    const n = charsOf(item);
    itemSize.set(item.id, n);
    touch(tid, n - before);
  }

  // Re-store an item in place (a re-stamped group), keeping the count honest and
  // the turn's recency as it was.
  function replaceHeld(tid, item) {
    const held = items.get(tid);
    held.set(item.id, item);
    const n = charsOf(item);
    const d = n - (itemSize.get(item.id) || 0);
    itemSize.set(item.id, n);
    totalChars += d;
    if (lru.has(tid)) lru.set(tid, Math.max(0, lru.get(tid) + d));
  }

  function removeFromTurn(tid, id) {
    const held = items.get(tid);
    if (!held || !held.has(id)) return;
    held.delete(id);
    totalItems -= 1;
    const n = itemSize.get(id) || 0;
    itemSize.delete(id);
    totalChars -= n;
    if (lru.has(tid)) lru.set(tid, Math.max(0, lru.get(tid) - n));
  }

  function removeItem(id, { silent = false } = {}) {
    const tid = itemTurn.get(id);
    if (!tid) return false;
    const held = items.get(tid);
    const prev = held && held.get(id);
    if (!prev) { itemTurn.delete(id); return false; }
    removeFromTurn(tid, id);
    itemTurn.delete(id);
    itemCut.delete(id);
    revs.delete(`i:${id}`);
    const t = turns.get(tid);
    if (t && !silent) markRemovedItem(t.conversation_id, id);
    recompute(tid, { silent });
    return true;
  }

  // ---- the LRU ------------------------------------------------------------------
  function touch(tid, delta) {
    const held = lru.has(tid) ? lru.get(tid) : 0;
    lru.delete(tid);
    lru.set(tid, Math.max(0, held + delta));
    totalChars += delta;
    if (delta > 0 || totalItems > maxItems) evictIfNeeded(tid);
  }

  function pinned(tid, current) {
    if (tid === current) return true;
    const t = turns.get(tid);
    if (!t) return false;
    if (t.status === 'open') return true;
    const list = turnLists.get(t.conversation_id) || [];
    for (let i = Math.max(0, list.length - keepRecent); i < list.length; i++) if (list[i] === tid) return true;
    return false;
  }

  function evictIfNeeded(current) {
    if (totalChars <= maxChars && totalItems <= maxItems) return;
    for (const tid of [...lru.keys()]) {
      if (totalChars <= maxChars && totalItems <= maxItems) break;
      if (pinned(tid, current)) continue;
      evict(tid);
    }
  }

  function evict(tid) {
    const held = items.get(tid);
    if (held) {
      for (const iid of held.keys()) { itemTurn.delete(iid); itemCut.delete(iid); itemSize.delete(iid); revs.delete(`i:${iid}`); }
      totalItems -= held.size;
    }
    totalChars -= lru.get(tid) || 0;
    lru.delete(tid);
    items.set(tid, new Map());
    evicted.add(tid);
  }

  const isEvicted = (tid) => evicted.has(tid);

  function item(id) {
    const tid = itemTurn.get(id);
    if (!tid) return null;
    const it = items.get(tid) && items.get(tid).get(id);
    if (!it) return null;
    touch(tid, 0);
    return it;
  }

  // A turn's items in seq order, or null when the LRU dropped them (refill first).
  function itemsOf(tid) {
    if (!turns.has(tid) || evicted.has(tid)) return null;
    touch(tid, 0);
    return sortedItems(tid);
  }

  function sortedItems(tid) {
    const held = items.get(tid);
    if (!held) return [];
    return [...held.values()].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Put an evicted turn's items back from a re-read of its byte range. Entries are
  // items or `{item, context}`. The refill is silent (the chrome has them) and
  // ends with the derivation run once.
  function refillTurn(tid, entries) {
    if (!turns.has(tid)) return false;
    evicted.delete(tid);
    for (const e of entries || []) {
      const it = isPlain(e) && isPlain(e.item) ? e.item : e;
      const context = isPlain(e) && isPlain(e.item) ? e.context : null;
      upsertItem({ ...it, turn_id: tid }, { context, silent: true, derive: false });
    }
    recompute(tid, { silent: true });
    return true;
  }

  // ---- the derivation: groups, counts, previews --------------------------------------
  // Consecutive tool calls not separated by a reply, thinking or prompt item share a
  // group; the header carries the groups and the turn's tool names (unique, in
  // order, at most 8): the Final's `▸ 3 tool calls · Read, Edit, Bash` (§2.4).
  function summarize(tid, list) {
    const counts = { items: 0, tools: 0, tool_errors: 0, agents: 0, tasks: 0, edits: 0 };
    const toolNames = [];
    const groups = [];
    const stamps = new Map();
    let cur = null;
    let promptItem = null;
    let firstPrompt = null;
    let lastReply = null;
    for (const it of list) {
      counts.items += 1;
      if (it.kind === 'tool_call') {
        counts.tools += 1;
        if (it.status === 'error') counts.tool_errors += 1;
        if (it.tool === 'Agent' || it.tool === 'Task' || (it.links && it.links.agent_id)) counts.agents += 1;
        if (it.links && it.links.task_id) counts.tasks += 1;
        if (it.edit || it.tool_kind === 'Edit' || it.tool_kind === 'Write') counts.edits += 1;
        if (!cur) { cur = { id: `g_${it.id}`, count: 0, names: [] }; groups.push(cur); }
        cur.count += 1;
        const name = typeof it.tool === 'string' && it.tool ? it.tool : null;
        if (name && cur.names.length < MAX_NAMES && !cur.names.includes(name)) cur.names.push(name);
        if (name && toolNames.length < MAX_NAMES && !toolNames.includes(name)) toolNames.push(name);
        stamps.set(it.id, cur.id);
      } else if (GROUP_SEPARATORS.has(it.kind)) {
        cur = null;
      }
      if (it.kind === 'prompt') {
        if (it.id === `p_${tid}`) promptItem = it;
        if (!firstPrompt) firstPrompt = it;
      }
      if (it.kind === 'reply') lastReply = it;
    }
    const p = promptItem || firstPrompt;
    return {
      counts,
      tool_names: toolNames,
      groups,
      prompt: p ? { preview: cutString(String(p.text || ''), PREVIEW_CHARS), origin: p.origin || 'other' } : null,
      reply_preview: lastReply ? cutString(String(lastReply.text || ''), PREVIEW_CHARS) : '',
      stamps,
    };
  }

  function recompute(tid, { silent = false } = {}) {
    const t = turns.get(tid);
    if (!t || evicted.has(tid)) return; // an evicted turn keeps the summary it had
    const list = sortedItems(tid);
    const s = summarize(tid, list);
    for (const it of list) {
      const want = s.stamps.get(it.id);
      if (it.group === want) continue;
      const next = { ...it };
      if (want === undefined) delete next.group;
      else {
        const g = text(want);
        if (g === undefined) delete next.group; else next.group = g;
      }
      replaceHeld(tid, deepFreeze(next));
      if (!silent) markItem(t.conversation_id, it.id);
    }
    const derived = scrubRecord({
      counts: s.counts,
      tool_names: s.tool_names,
      groups: s.groups,
      prompt: s.prompt || { preview: '', origin: ORIGIN_OF_KIND[t.kind] || 'other' },
      reply_preview: s.reply_preview,
    }, null);
    if (JSON.stringify(derived) === JSON.stringify({
      counts: t.counts, tool_names: t.tool_names, groups: t.groups, prompt: t.prompt, reply_preview: t.reply_preview,
    })) return;
    deepFreeze(derived);
    const next = deepFreeze({ ...t, ...derived });
    turns.set(tid, next);
    if (!silent) markTurn(t.conversation_id, tid);
  }

  // ---- tasks ---------------------------------------------------------------------
  // Shallow merge; `meta` merges key by key; a finished task is never made running
  // again by a late or out-of-order source.
  function upsertTask(row) {
    if (!isPlain(row)) return null;
    const clean = scrubRecord(row, null);
    const id = cleanId(clean.id);
    const cid = cleanId(clean.conversation_id) || (tasks.get(id) && tasks.get(id).conversation_id);
    if (!id || !cid) return null;
    ensureConversation(cid);
    delete clean.rev;
    const capped = capTree(clean, '', (p) => TASK_CAPS[p] || DEFAULT_CAP, new Set());
    const prev = tasks.get(id);
    const next = { ...(prev || {}), ...capped, id, conversation_id: cid };
    if (prev && isPlain(prev.meta) && isPlain(capped.meta)) next.meta = { ...prev.meta, ...capped.meta };
    if (prev && TERMINAL_TASK.has(prev.status) && next.status === 'running') {
      next.status = prev.status;
      if (prev.ended_at !== undefined) next.ended_at = prev.ended_at;
    }
    tasks.set(id, deepFreeze(next));
    markTask(cid, id);
    return tasks.get(id);
  }

  function removeTask(id) {
    const row = tasks.get(id);
    if (!row) return false;
    tasks.delete(id);
    revs.delete(`k:${id}`);
    markRemovedTask(row.conversation_id, id);
    return true;
  }

  const task = (id) => tasks.get(id) || null;
  function tasksOf(cid) {
    const out = [];
    for (const row of tasks.values()) if (!cid || row.conversation_id === cid) out.push(row);
    return out;
  }

  // The §2.10 `counts` (a live monitor counts as running everywhere: deviation 19).
  function taskCounts(cid) {
    const out = { shells: { running: 0, total: 0 }, agents: { running: 0, done: 0 }, workflows: { running: 0, total: 0 },
      monitors: { running: 0, total: 0 } };
    for (const row of tasksOf(cid)) {
      const key = TASK_COUNT_KEY[row.kind];
      if (!key) continue;
      if (row.status === 'running') out[key].running += 1;
      if (key === 'agents') { if (row.status === 'done') out[key].done += 1; } else out[key].total += 1;
    }
    return out;
  }

  // ---- serialization -------------------------------------------------------------------
  function serializeItem(x, { level = 'summary' } = {}) {
    const it = typeof x === 'string' ? item(x) : x;
    if (!it) return null;
    const cut = new Set(itemCut.get(it.id) || []);
    let out = serialize(it);
    if (level !== 'full') out = capItem(out, 'summary', cut);
    if (cut.size) out.truncated = true;
    out.rev = revOf('i', it.id);
    return out;
  }

  function serializeTurn(x) {
    const t = typeof x === 'string' ? turns.get(x) : x;
    if (!t) return null;
    const out = serialize(t);
    out.rev = revOf('t', t.id);
    return out;
  }

  function serializeTask(x) {
    const row = typeof x === 'string' ? tasks.get(x) : x;
    if (!row) return null;
    const out = serialize(row);
    out.rev = revOf('k', row.id);
    return out;
  }

  function serializeLive(cid) {
    const live = lives.get(cid);
    if (!live) return null;
    const out = serialize(live);
    out.rev = revOf('l', cid);
    return out;
  }

  function serializeConversation(x) {
    const c = typeof x === 'string' ? conversations.get(x) : x;
    if (!c) return null;
    const out = serialize(c);
    const list = turnsOf(c.id);
    let open = null;
    for (const t of list) if (t.status === 'open') open = t.id;
    const counts = taskCounts(c.id);
    out.rev = revOf('c', c.id);
    out.live = serializeLive(c.id);
    out.turn_count = list.length;
    out.open_turn_id = open;
    out.counts = { shells: counts.shells.running, agents: counts.agents.running, workflows: counts.workflows.running,
      monitors: counts.monitors.running };
    return out;
  }

  function stats() {
    return { conversations: conversations.size, turns: turns.size, items: totalItems, chars: totalChars,
      evicted: evicted.size, tasks: tasks.size, redaction_failures: failures };
  }

  return {
    // redaction
    scrubText, scrubValue, cleanId,
    // conversations and live
    upsertConversation, conversation, conversations: listConversations, removeConversation, upsertLive, live: liveOf,
    // turns
    turn, turnsOf, turnPage, patchTurn, claimTurnWriter,
    // items
    upsertItem, removeItem, item, itemsOf, isEvicted, refillTurn,
    // tasks
    upsertTask, removeTask, task, tasks: tasksOf, taskCounts,
    // out
    serializeItem, serializeTurn, serializeTask, serializeConversation, serializeLive, takeChanges,
    stats,
  };
}

module.exports = {
  createModel,
  serialize,
  cutString,
  charsOf,
  ITEM_CAPS,
  INPUT_CAPS,
  DEFAULT_ITEM_CAP,
  TURN_CAPS,
  TASK_CAPS,
  CONVERSATION_CAPS,
  LIVE_CAPS,
  PREVIEW_CHARS,
  LRU_MAX_CHARS,
  LRU_MAX_ITEMS,
  LRU_KEEP_RECENT,
  ITEM_KINDS,
  ORIGIN_OF_KIND,
};

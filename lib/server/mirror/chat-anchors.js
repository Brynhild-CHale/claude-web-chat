// lib/server/mirror/chat-anchors.js — the chat-anchor resolver behind the
// mirror's facade (PLAN.md 3A.1; DECISIONS.md D3, D4, D5, L1, L4, L5).
//
// The mirror owns a chat anchor's identity and state; the chrome owns its
// placement (D5's split). This source makes a chat anchor from what a reader
// is served (`record`) and answers where one is now (`resolve`), and nothing
// else: it draws nothing, adds no route, writes no file and keeps no text. The
// element log stores what `record` made (U415's chat-comment@1); the routes
// and tools reach both through the facade's two DISPATCH rows, recordAnchor
// and resolveAnchors (lib/server/mirror/index.js), whose answers pass the read
// boundary's redactOut like every row's.
//
//   createChatAnchorsSource({kinds = []} = {}) → {attach(engine)}
//   api: {resolve(batch), record(input), registerKind(kind, impl)}
//
// THE KINDS (THE ENGINES RULE). A kind is `impl = {record(input, k), resolve(anchor, k)}`
// registered by name through registerKind; turn, item and item-range are this
// module's own, and any other (U417's diff-line, lib/server/mirror/
// chat-anchors-diff.js) plugs in through the `kinds` option — each entry
// `{kind, record, resolve}` — so no later unit edits this file for a kind.
//   record(input, k) → {anchor} | {refused, hint} | {unavailable, rule?} | {invalid, hint}
//   resolve(anchor, k) → an answer made with k.answer(state, {how, at, turn_id, rule, note})
// `k` is the helper bag: k.read (the engine's read: the facade's own served
// turn, itemField and diff, after redactOut), k.model, k.indexing, k.answer,
// k.quote (anchors.js CONFIG, quoteOf, quoteText; redact.js marksIn,
// matchMasked; fingerprint, ordinalOf), k.turnOf, k.itemOf, k.page,
// k.turnNumber, k.refused / k.invalid / k.unavailable (the record answers),
// EXPLAIN and VISIBLE; and, on resolve, k.turn_id (the anchor's turn, resolved)
// and k.memo {get(stamp), set(stamp, answer)} (LAST@memory, below).
//
// THE ANCHOR RECORD (U415's row of the one per-kind table, S1-confirm): the
// common head {v: 1, kind, conversation_id, session_id, turn_id, quote, marks,
// label} plus, for these three kinds, item_id?, field?, pos?, ordinal? and fp
// {h, len}; in the order
//   {v, kind, conversation_id, session_id, turn_id, item_id?, field?, quote,
//    pos?, ordinal?, fp, marks, label}
// taken ONLY from served text read through engine.read (D4: never an
// unredacted span). quote {exact, prefix, suffix} is anchors.js quoteOf's
// (CONFIG.quote_max 2000, ctx_n 32), as the page's; fp is the first FP_HEX hex
// of stableHash over the served field's first page (itemField from 0,
// FIELD_MAX) with the field's total length; marks is marksIn's count over
// quote.exact at create; conversation_id and session_id are the model's
// header's, never the caller's (session_id is the lazy locator, R7).
//   turn        the prompt item p_<turn>'s text head; label "turn N"
//   item        field 'text' (a prompt, reply or thinking item) or 'input' (a
//               tool card), its head; label "turn N's prompt" | "turn N's
//               reply" | "thinking in turn N" | "tool card <Tool>"
//   item-range  field 'text', pos {start, end} from the caller in the field's
//               source offsets, the quote over the served text there and the
//               ordinal {index, of} as anchors.js recordRange makes one (the
//               quote occurs more than once, under 400); label as the item's
// N is the turn's 1-based place among its conversation's turns at create, in
// the model's seq order: recorded, never renumbered.
// REFUSED (D3; nothing is written): an item whose id isProvisional (rh_, rm_)
// or whose model item's source is not 'transcript' (a hook or mod-live card
// before its record lands), and a turn whose header is provisional (no
// transcript opener bound yet) → {refused: 'provisional', hint: EXPLAIN.refused}.
// An unknown turn or item → {unavailable: true, rule: 'gone'}; an empty range,
// one over quote_max or a malformed request → {invalid: true, hint}.
//
// RESOLVE. resolve([{id, v, anchor}]) → answers in batch order, each
// {id, state, visible, explain, how?, at?, turn_id?, rule?, note?}: state from
// ANCHOR_STATES, visible VISIBLE[state] (one of L4's six), explain
// EXPLAIN[visible]; `note` a kind's own line, shown instead of explain (Q7);
// `at` the placement data ({item_id, field, start, end} for a passage,
// {item_id} for an item, {file, side, line} for a diff line); turn_id the
// turn's current id after a re-key. Per anchor, in order:
//   (i)   engine.indexing(conversation_id) → indexing, with NO read and nothing
//         parsed (REQ@list-never-waits), whatever memory holds;
//   (ii)  model.resolveTurn(turn_id) (the alias map: re-keys and replaces) —
//         none → unavailable, rule 'gone'. A chat anchor is never orphaned;
//   (iii) the kind (none registered → unavailable, rule 'kind') resolves; a
//         superseded header (a rewind) then answers superseded, with the
//         kind's placement data, so the chat draws it on that turn;
//   (iv)  turn → placed (exact); item → placed (exact) while the item is in
//         the model, else unavailable; item-range → the fast path (the served
//         field's fingerprint equal: exact at pos), else, when the served page
//         holds a mark, redact.js matchMasked → masked with its span when it
//         aligns through a mask, else anchors.js quoteText → placed (exact or
//         re-resolved, its how) unless the span holds more marks than the
//         record's `marks` (a value learned after create: masked, never
//         exact), and a quote no longer found → unavailable (how 'not-found').
// A kind's answer is copied through an allowlist (the fields above, `at`'s
// keys, strings and integers): answers carry offsets, ids and the EXPLAIN
// line, never served text.
//
// LAST@memory (settled default; D-9). The last answer per element id is kept
// in a bounded Map (MEMORY_MAX entries, least recently used out), keyed with
// the element's version and a stamp the kind gives (the served field's
// fingerprint for a passage), and dropped for a conversation on any batch,
// re-key or removal of it (onChanges, onConversation). A hit answers without
// re-matching. Memory only: never written to the log, the index, a snapshot
// or a frame, and re-derived after a restart.
//
// Dependency direction: lib/server; imports lib/core and its siblings in
// lib/server/mirror (turn-machine's isProvisional, transcripts' FIELD_MAX).

'use strict';

const anchorsLib = require('../../core/anchors');
const { VISIBLE, EXPLAIN } = require('../../core/anchor-states');
const { marksIn, matchMasked } = require('../../core/redact');
const { stableHash } = require('../../core/stable-json');
const { toolKind } = require('../../core/tool-input');
const { isProvisional } = require('./turn-machine');
const { FIELD_MAX } = require('./transcripts');

// ── constants ────────────────────────────────────────────────────────────────

// The resolver's memory: answers kept, least recently used out.
const MEMORY_MAX = 5000;
// A fingerprint's hash: this many leading hex digits of stableHash.
const FP_HEX = 16;
// The anchor record's version.
const RECORD_V = 1;
// A kind's name: one lowercase word, hyphens allowed ('item-range').
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
// The prompt item of a turn is p_<turn id> (spec §2.4): it re-keys with its turn.
const PROMPT_PREFIX = 'p_';
// recordRange's ordinal cap (anchors.js): occurrences counted up to it.
const OCC_CAP = 400;
// The model item kinds an anchor may name, and the field each is pinned by.
const FIELD_OF_KIND = Object.freeze({ prompt: 'text', reply: 'text', thinking: 'text', tool_call: 'input' });
// What a kind's answer may carry, by field; `at`'s keys with their types.
const AT_KEYS = Object.freeze({ item_id: 'string', field: 'string', start: 'int', end: 'int', file: 'string', side: 'string', line: 'int' });
// The record answers' hints (the refused one is EXPLAIN's own line).
const HINTS = Object.freeze({
  request: 'A chat pin names a kind, and a turn, an item or a passage.',
  kind: 'There is no such kind of chat pin.',
  empty: 'An empty passage cannot be pinned; select some words.',
  long: `A passage of at most ${anchorsLib.CONFIG.quote_max} characters can be pinned.`,
  range: 'The passage is not inside this item.',
  field: 'Only a prompt, a reply, thinking or a tool card can be pinned.',
  text: 'There are no words here to pin.',
});

// ── helpers ──────────────────────────────────────────────────────────────────

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => typeof v === 'string' && v.length > 0;

// An answer in L4's vocabulary: the visible state and its line, then the
// fields given (how, at, turn_id, rule, note), in that order.
function answer(state, fields = {}) {
  const st = own(VISIBLE, state) ? state : 'unavailable';
  const visible = VISIBLE[st];
  const out = { state: st, visible, explain: EXPLAIN[visible] };
  const f = isPlain(fields) ? fields : {};
  if (typeof f.how === 'string' && f.how) out.how = f.how;
  const at = cleanAt(f.at);
  if (at) out.at = at;
  if (isId(f.turn_id)) out.turn_id = f.turn_id;
  if (typeof f.rule === 'string' && f.rule) out.rule = f.rule;
  if (typeof f.note === 'string' && f.note) out.note = f.note;
  return out;
}

function cleanAt(at) {
  if (!isPlain(at)) return null;
  const out = {};
  for (const k of Object.keys(AT_KEYS)) {
    if (!own(at, k)) continue;
    const v = at[k];
    if (AT_KEYS[k] === 'int' ? isInt(v) : typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

const refused = () => ({ refused: 'provisional', hint: EXPLAIN.refused });
const invalid = (hint) => ({ invalid: true, hint });
const unavailable = (rule = 'gone') => ({ unavailable: true, rule });

// {h, len}: the served field page's fingerprint, its total length.
function fingerprint(text, total) {
  return { h: stableHash(typeof text === 'string' ? text : '').slice(0, FP_HEX), len: isInt(total) ? total : 0 };
}

// recordRange's ordinal over a plain text: {index, of} when `exact` occurs more
// than once (under the cap) and one occurrence starts at `start`, else null.
function ordinalOf(text, exact, start) {
  const occ = [];
  for (let i = exact ? text.indexOf(exact) : -1; i >= 0 && occ.length < OCC_CAP; i = text.indexOf(exact, i + 1)) occ.push(i);
  const index = occ.indexOf(start);
  return occ.length > 1 && occ.length < OCC_CAP && index >= 0 ? { index, of: occ.length } : null;
}

// The first served page of a field longer than one page that holds `start`.
function windowFrom(start, total) {
  if (!(total > FIELD_MAX)) return 0;
  return Math.max(0, Math.min(start - Math.floor(FIELD_MAX / 2), total - FIELD_MAX));
}

// A kind's record answer, copied through its shape: never anything else.
function cleanRecord(r) {
  if (!isPlain(r)) return unavailable('error');
  if (isPlain(r.anchor)) return { anchor: r.anchor };
  if (r.refused) return { refused: typeof r.refused === 'string' ? r.refused : 'provisional', hint: typeof r.hint === 'string' ? r.hint : EXPLAIN.refused };
  if (r.invalid) return invalid(typeof r.hint === 'string' ? r.hint : HINTS.request);
  if (r.unavailable) return unavailable(typeof r.rule === 'string' && r.rule ? r.rule : 'gone');
  return unavailable('error');
}

// ── the built-in kinds ───────────────────────────────────────────────────────

// The common head of a record over turn `t` (the model's header).
function head(kind, t) {
  return { v: RECORD_V, kind, conversation_id: t.conversation_id, session_id: t.session_id || null, turn_id: t.id };
}

function itemLabel(it, n) {
  if (it.kind === 'prompt') return `turn ${n}'s prompt`;
  if (it.kind === 'reply') return `turn ${n}'s reply`;
  if (it.kind === 'thinking') return `thinking in turn ${n}`;
  return `tool card ${toolKind(it.tool)}`;
}

// The item a record or a resolve names, checked: {it, turn, field} or a record answer.
async function pinnable(itemId, k, { textOnly = false } = {}) {
  if (!isId(itemId)) return invalid(HINTS.request);
  if (isProvisional(itemId)) return refused();
  const it = await k.itemOf(itemId);
  if (!it) return unavailable('gone');
  if (it.source !== 'transcript') return refused();
  const field = own(FIELD_OF_KIND, it.kind) ? FIELD_OF_KIND[it.kind] : null;
  if (!field || (textOnly && field !== 'text')) return invalid(HINTS.field);
  const turn = k.turnOf(it.turn_id);
  if (!turn) return unavailable('gone');
  if (turn.provisional === true) return refused();
  return { it, turn, field };
}

// The record of a field's head: its first page's fingerprint, its quote.
async function headRecord(rec, k, itemId, field) {
  const page = await k.page(itemId, field, 0);
  const text = page ? page.text : '';
  if (!text) return invalid(HINTS.text);
  const q = k.quote.quoteOf({}, text, 0, Math.min(text.length, k.quote.CONFIG.quote_max));
  if (!q) return invalid(HINTS.text);
  rec.quote = q.quote;
  rec.fp = fingerprint(text, page.total);
  rec.marks = marksIn(q.quote.exact).length;
  return rec;
}

const turnKind = Object.freeze({
  async record(input, k) {
    if (!isId(input.turn_id)) return invalid(HINTS.request);
    const t = k.turnOf(input.turn_id);
    if (!t) return unavailable('gone');
    if (t.provisional === true) return refused();
    const rec = head('turn', t);
    const made = await headRecord(rec, k, `${PROMPT_PREFIX}${t.id}`, 'text');
    if (made !== rec) return made;
    rec.label = `turn ${k.turnNumber(t)}`;
    return { anchor: rec };
  },
  async resolve(anchor, k) {
    const hit = k.memo.get(k.turn_id);
    if (hit) return hit;
    return k.memo.set(k.turn_id, k.answer('exact', { how: 'id', turn_id: k.turn_id }));
  },
});

const itemKind = Object.freeze({
  async record(input, k) {
    const p = await pinnable(input.item_id, k);
    if (!p.it) return p;
    const rec = head('item', p.turn);
    rec.item_id = p.it.id;
    rec.field = p.field;
    const made = await headRecord(rec, k, p.it.id, p.field);
    if (made !== rec) return made;
    rec.label = itemLabel(p.it, k.turnNumber(p.turn));
    return { anchor: rec };
  },
  async resolve(anchor, k) {
    const it = await k.itemOf(k.itemIdOf(anchor.item_id));
    if (!it) return k.answer('unavailable', { rule: 'gone', turn_id: k.turn_id });
    const hit = k.memo.get(`${it.id}|${it.turn_id}`);
    if (hit) return hit;
    return k.memo.set(`${it.id}|${it.turn_id}`, k.answer('exact', { how: 'id', at: { item_id: it.id }, turn_id: it.turn_id }));
  },
});

const itemRangeKind = Object.freeze({
  async record(input, k) {
    const p = await pinnable(input.item_id, k, { textOnly: true });
    if (!p.it) return p;
    if (input.field !== undefined && input.field !== 'text') return invalid(HINTS.field);
    const pos = input.pos;
    if (!isPlain(pos) || !isInt(pos.start) || !isInt(pos.end)) return invalid(HINTS.request);
    if (!(pos.end > pos.start)) return invalid(HINTS.empty);
    if (pos.end - pos.start > k.quote.CONFIG.quote_max) return invalid(HINTS.long);
    const first = await k.page(p.it.id, 'text', 0);
    if (!first || !first.text) return invalid(HINTS.text);
    if (pos.end > first.total) return invalid(HINTS.range);
    const from = windowFrom(pos.start, first.total);
    const page = from === 0 ? first : await k.page(p.it.id, 'text', from);
    if (!page || pos.end > page.from + page.text.length) return invalid(HINTS.range);
    const q = k.quote.quoteOf({}, page.text, pos.start - page.from, pos.end - page.from);
    if (!q) return invalid(HINTS.empty);
    const rec = head('item-range', p.turn);
    rec.item_id = p.it.id;
    rec.field = 'text';
    rec.quote = q.quote;
    rec.pos = { start: pos.start, end: pos.end };
    const ord = ordinalOf(page.text, q.quote.exact, q.pos.start);
    if (ord) rec.ordinal = ord;
    rec.fp = fingerprint(first.text, first.total);
    rec.marks = marksIn(q.quote.exact).length;
    rec.label = itemLabel(p.it, k.turnNumber(p.turn));
    return { anchor: rec };
  },
  async resolve(anchor, k) {
    const q = anchor.quote;
    const pos = anchor.pos;
    if (!isPlain(q) || typeof q.exact !== 'string' || !q.exact || !isPlain(pos) || !isInt(pos.start) || !isInt(pos.end)) {
      return k.answer('unavailable', { rule: 'invalid', turn_id: k.turn_id });
    }
    const it = await k.itemOf(k.itemIdOf(anchor.item_id));
    const first = it ? await k.page(it.id, 'text', 0) : null;
    if (!it || !first) return k.answer('unavailable', { rule: 'gone', turn_id: k.turn_id });
    const fp = fingerprint(first.text, first.total);
    const stamp = `${it.id}|${it.turn_id}|${fp.h}|${fp.len}`;
    const hit = k.memo.get(stamp);
    if (hit) return hit;
    const keep = (state, fields) => k.memo.set(stamp, k.answer(state, { ...fields, turn_id: it.turn_id }));
    const at = (start, end) => ({ item_id: it.id, field: 'text', start, end });
    const was = isPlain(anchor.fp) ? anchor.fp : {};
    if (was.h === fp.h && was.len === fp.len) return keep('exact', { how: 'fingerprint', at: at(pos.start, pos.end) });
    const from = windowFrom(pos.start, first.total);
    const page = from === 0 ? first : await k.page(it.id, 'text', from);
    if (!page) return keep('unavailable', { how: 'not-found' });
    const s = page.text;
    const local = { start: pos.start - page.from, end: pos.end - page.from };
    if (marksIn(s).length) {
      const m = matchMasked(s, { exact: q.exact, prefix: q.prefix || '', suffix: q.suffix || '' }, { pos: local });
      if (m && m.masked) return keep('masked', { how: m.how, at: at(page.from + m.start, page.from + m.end) });
    }
    const rec = { quote: { exact: q.exact, prefix: String(q.prefix || ''), suffix: String(q.suffix || '') }, pos: local };
    if (isPlain(anchor.ordinal)) rec.ordinal = anchor.ordinal;
    const r = k.quote.quoteText(s, rec, k.quote.CONFIG);
    if (!r || (r.state !== 'exact' && r.state !== 're-resolved') || !(r.end > r.start)) return keep('unavailable', { how: 'not-found' });
    const marks = isInt(anchor.marks) ? anchor.marks : 0;
    const state = marksIn(s.slice(r.start, r.end)).length > marks ? 'masked' : r.state;
    return keep(state, { how: r.how, at: at(page.from + r.start, page.from + r.end) });
  },
});

const BUILTIN_KINDS = Object.freeze({ turn: turnKind, item: itemKind, 'item-range': itemRangeKind });

// ── the source ───────────────────────────────────────────────────────────────

function createChatAnchorsSource({ kinds = [] } = {}) {
  const extra = Array.isArray(kinds) ? kinds.slice() : [];

  function attach(engine) {
    const model = engine.model;
    const read = engine.read && typeof engine.read === 'object' ? engine.read : {};
    const indexing = typeof engine.indexing === 'function' ? engine.indexing : () => false;
    const registry = new Map(); // kind → impl
    const memory = new Map(); // element id → {v, cid, stamp, answer}; insertion order = recency
    const byCid = new Map(); // conversation id → Set of element ids in memory
    const counters = { resolves: 0, records: 0, memory_hits: 0, states: {} };

    function say(m) { try { engine.log(m); } catch { /* a logger never breaks the source */ } }

    function registerKind(kind, impl) {
      if (typeof kind !== 'string' || !KIND_RE.test(kind)) throw new TypeError(`chat-anchors: a kind's name is one lowercase word (got ${JSON.stringify(kind)})`);
      if (!impl || typeof impl.record !== 'function' || typeof impl.resolve !== 'function') {
        throw new TypeError(`chat-anchors: kind ${kind} is {record(input, k), resolve(anchor, k)}`);
      }
      if (registry.has(kind)) throw new Error(`chat-anchors: a kind named ${kind} is already registered`);
      registry.set(kind, impl);
    }

    // ── the served reads (engine.read: after redactOut) ──
    const served = (x) => (isPlain(x) && x.unavailable !== true ? x : null);
    async function page(itemId, field, from, cache) {
      const key = `${itemId}\u0000${field}\u0000${from}`;
      if (cache && cache.has(key)) return cache.get(key);
      const p = (async () => {
        if (typeof read.itemField !== 'function') return null;
        const x = served(await read.itemField(itemId, { field, from }));
        if (!x || typeof x.text !== 'string' || !isInt(x.from) || !isInt(x.total)) return null;
        return { text: x.text, from: x.from, total: x.total };
      })();
      if (cache) cache.set(key, p);
      return p;
    }
    function turnOf(id) {
      const tid = isId(id) ? model.resolveTurn(id) : null;
      const t = tid ? model.turn(tid) : null;
      return t || null;
    }
    // A prompt item's id follows its turn's re-key; any other item keeps its id.
    function itemIdOf(id) {
      if (!isId(id) || !id.startsWith(PROMPT_PREFIX) || model.item(id)) return id;
      const t = turnOf(id.slice(PROMPT_PREFIX.length));
      return t ? `${PROMPT_PREFIX}${t.id}` : id;
    }
    // The model's item, its turn refilled first when the LRU emptied it (the
    // served read refills it; the model is read again after).
    async function itemOf(id) {
      if (!isId(id)) return null;
      const it = model.item(id);
      if (it) return it;
      if (typeof read.itemField === 'function') {
        try { await read.itemField(id, { field: 'input', max: 1 }); } catch { return null; }
      }
      return model.item(id) || null;
    }
    function turnNumber(t) {
      const list = model.turnsOf(t.conversation_id);
      const i = list.findIndex((x) => x.id === t.id);
      return i >= 0 ? i + 1 : list.length + 1;
    }

    const quote = Object.freeze({
      CONFIG: anchorsLib.CONFIG, quoteOf: anchorsLib.quoteOf, quoteText: anchorsLib.quoteText,
      marksIn, matchMasked, fingerprint, ordinalOf,
    });
    const base = {
      read, model, indexing, answer, quote, EXPLAIN, VISIBLE,
      turnOf, itemOf, itemIdOf, turnNumber,
      refused, invalid, unavailable,
    };

    // ── LAST@memory ──
    function forget(id) {
      const m = memory.get(id);
      if (!m) return;
      memory.delete(id);
      const set = byCid.get(m.cid);
      if (set) { set.delete(id); if (!set.size) byCid.delete(m.cid); }
    }
    function dropConversation(cid) {
      const set = isId(cid) ? byCid.get(cid) : null;
      if (!set) return;
      for (const id of [...set]) forget(id);
    }
    function memoFor(id, v, cid) {
      return Object.freeze({
        get(stamp) {
          const m = id ? memory.get(id) : null;
          if (!m || m.v !== v || m.cid !== cid || m.stamp !== stamp) return null;
          memory.delete(id);
          memory.set(id, m);
          counters.memory_hits += 1;
          return { ...m.answer, ...(m.answer.at ? { at: { ...m.answer.at } } : {}) };
        },
        set(stamp, a) {
          if (!id || !isId(cid)) return a;
          forget(id);
          memory.set(id, { v, cid, stamp: String(stamp), answer: a });
          if (!byCid.has(cid)) byCid.set(cid, new Set());
          byCid.get(cid).add(id);
          while (memory.size > MEMORY_MAX) forget(memory.keys().next().value);
          return a;
        },
      });
    }
    const NO_MEMO = memoFor(null, null, null);

    // ── resolve ──
    function count(a) { counters.states[a.state] = (counters.states[a.state] || 0) + 1; }
    function done(id, a) {
      const out = { id, ...a };
      count(out);
      return out;
    }

    async function resolveOne(entry, cache) {
      counters.resolves += 1;
      const e = isPlain(entry) ? entry : {};
      const id = isId(e.id) ? e.id : null;
      const a = e.anchor;
      if (!isPlain(a) || typeof a.kind !== 'string') return done(id, answer('unavailable', { rule: 'invalid' }));
      const cid = isId(a.conversation_id) ? a.conversation_id : null;
      // (i) a conversation not parsed yet: indexing, with no read at all.
      let busy = false;
      try { busy = cid ? indexing(cid) === true : false; } catch { busy = false; }
      if (busy) return done(id, answer('indexing'));
      // (ii) the anchor's turn, through the alias map; none: gone.
      const turn = turnOf(a.turn_id);
      if (!turn) return done(id, answer('unavailable', { rule: 'gone' }));
      // (iii) the kind's answer, then a rewind's.
      const impl = registry.get(a.kind);
      if (!impl) return done(id, answer('unavailable', { rule: 'kind', turn_id: turn.id }));
      const v = Number.isSafeInteger(e.v) ? e.v : null;
      const k = Object.freeze({
        ...base,
        page: (itemId, field, from) => page(itemId, field, from, cache),
        turn_id: turn.id,
        memo: id ? memoFor(id, v, turn.conversation_id) : NO_MEMO,
      });
      let r;
      try {
        r = await impl.resolve(a, k);
      } catch (err) {
        say(`chat-anchors: ${a.kind} resolve failed (${err && err.name === 'TypeError' ? 'TypeError' : 'Error'})`);
        r = answer('unavailable', { rule: 'error' });
      }
      let out = isPlain(r) && own(VISIBLE, r.state) ? answer(r.state, r) : answer('unavailable', { rule: 'error' });
      if (!out.turn_id) out.turn_id = turn.id;
      if (turn.superseded === true) out = answer('superseded', { how: out.how, at: out.at, turn_id: out.turn_id, note: out.note });
      return done(id, out);
    }

    async function resolve(batch) {
      if (!Array.isArray(batch)) return [];
      const cache = new Map(); // one served page per item, field and offset, for this batch
      const out = [];
      for (const entry of batch) out.push(await resolveOne(entry, cache));
      return out;
    }

    // ── record ──
    async function record(input) {
      counters.records += 1;
      if (!isPlain(input) || typeof input.kind !== 'string') return invalid(HINTS.request);
      const impl = registry.get(input.kind);
      if (!impl) return invalid(HINTS.kind);
      const cache = new Map();
      const k = Object.freeze({ ...base, page: (itemId, field, from) => page(itemId, field, from, cache), turn_id: null, memo: NO_MEMO });
      try {
        return cleanRecord(await impl.record(input, k));
      } catch (err) {
        say(`chat-anchors: ${input.kind} record failed (${err && err.name === 'TypeError' ? 'TypeError' : 'Error'})`);
        return unavailable('error');
      }
    }

    for (const [kind, impl] of Object.entries(BUILTIN_KINDS)) registerKind(kind, impl);
    for (const entry of extra) registerKind(entry && entry.kind, entry);

    return {
      start: async () => {},
      stop: async () => { memory.clear(); byCid.clear(); },
      // Any batch about a conversation — a re-key of it included — may move
      // what an anchor there answers: its memory goes.
      onChanges(sid, changes, opts) {
        if (isPlain(opts)) dropConversation(opts.conversation_id);
        if (Array.isArray(changes)) {
          for (const ch of changes) if (isPlain(ch) && ch.type === 'rekey') dropConversation(ch.conversation_id);
        }
      },
      onConversation(ev) {
        if (!isPlain(ev) || !isPlain(ev.conversation)) return;
        if (ev.change === 'removed' || ev.change === 'merged') dropConversation(ev.conversation.id);
        if (ev.change === 'merged') dropConversation(ev.merged_into);
      },
      diagnostics() {
        return {
          chat_anchors: {
            resolves: counters.resolves,
            records: counters.records,
            memory_hits: counters.memory_hits,
            memory: memory.size,
            kinds: [...registry.keys()],
            states: { ...counters.states },
          },
        };
      },
      api: { resolve, record, registerKind },
    };
  }

  return { attach };
}

module.exports = {
  createChatAnchorsSource,
  MEMORY_MAX,
  FP_HEX,
  BUILTIN_KINDS: Object.freeze(Object.keys(BUILTIN_KINDS)),
};

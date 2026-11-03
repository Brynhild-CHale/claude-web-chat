'use strict';
// The element record layer — one home for "what an element (a comment pin, in
// tranche 1) is, every version of its text, and which graph node pinned which
// version", kept in ONE append-only log on lib/core/applog's engine.
//
// It lives in lib/core, not lib/server, because the v3→v4 migration
// (lib/update) may import only lib/core (test/dependency-direction.test.js).
// The daemon's store (lib/server/domain/elements) is a thin binding over it.
//
// THE FILE: .web-chat/elements/log.jsonl (projectPaths().elementsLog), one
// record per line, each a plain object whose `t` names its type:
//
//   epoch      {boot, at, pid}  the engine's own, written lazily before the
//              first append of each open (lib/core/applog)
//   el         {id, kind, created_at}  an element's identity, once per id
//   ver        {id, v, parent_v, seq, schema, payload, payload_hash, src_hash,
//              original, writer, provenance, owner, display, author, at}
//              one version
//   commit     {node, parent, created_at, pins: ['c3@2', …], digest, at}  a
//              committed node and the id@v of every pin it carries
//   migration  {from, to, at, seq_floor, …counts}  the v3→v4 migration's mark
//   close      {boot, at, held: ['c3@2', …], complete}  a graceful shutdown's
//              mark, written after the draft (U352; DECISIONS F-DEL c): the
//              id@v of every live copy the shutdown held. `complete` is false
//              when the draft was not written or a live copy carried no v, and
//              such a close covers nothing. Ids only, never text.
//   ack        {boot, at, keys: ['uncommitted-lost c3@2', …]}  the boot
//              reconcile's acknowledgement of persistent states it reported
//              ('<state> <key>'), so a later boot counts them as acknowledged.
//              Keys only, never text.
//   drop       {id, at, writer?, provenance?}  a CHAT element's own Delete
//              (tranche 3, U415; RULED R5-confirm = a): ids and stamps only,
//              never text. A chat element (family chat: the built-in
//              chat-comment) lives in this log alone — never on the surface,
//              in a node or in a commit record — so its removal is recorded
//              here; `dropped(id)` answers it. A page element's removal
//              appends nothing (C2). A malformed drop is counted `skipped`; a
//              reader older than tranche 3 counts it `unknown` and loads the
//              rest (AG-1, named for U461's rollback note).
//   answers    {node, at, items: [{id, v, mount, state, how?, why?, tie?, gen,
//              surface, qual: {spec, store}, source: {peer, device},
//              record?}]}  the side table (2B.2, U313; F-SIDE a): at a
//              commit, the live viewers' resolver answers for the id@v the
//              committed node carries, the changed ones only, one record set
//              per node (lib/server/domain/side-table). `record` is the
//              converted anchor's full record minted at the first live
//              resolve — pane text (64 characters of head, 128 per row
//              ancestor) — so it passes the injected redactor before the bytes
//              land, as a version's payload does; it is kept once per id@v
//              (the first set in log order that carries it) and is never a
//              new version. Nothing else in an item is text: how/why are
//              resolver codes (isAnswerCode), the rest numbers, hashes and
//              words.
//
// A malformed close, ack or answers record is counted `skipped`, never fatal;
// a reader older than close and ack (0.9.0-alpha.1) counts all three
// `unknown` and ignores them, so a rollback still boots (AG-1).
//
// `v` counts per element (1, 2, …); `seq` is ONE counter across every version
// of every element: it mints ids (a type's letter + the first seq), it is the
// API's pin.seq, and it is the comment cursor. `parent_v` lives only in the
// version record.
//
// THE ONE WRITER OF ELEMENT TEXT (PLAN 1A.5; C-13). appendVersion is the only
// code in lib/, bin/ or scripts/ that spells a version record
// (test/conventions.test.js holds it). It passes the payload through the
// INJECTED redactor (a lib/core/redact createRedactor() instance; this file
// never builds one) BEFORE the bytes land, and so the four sibling fields
// and the author. Every anchor record stored later carries pane text (64
// characters of the element's head, plus 128 per row-like ancestor: 1C's
// record, lib/core/anchors.js): whoever persists one — tranche 2's side table
// and its element writes — goes through this writer too, never a write of
// its own.
//
// THE TWO HASHES. payload_hash is stableHash of the stored (redacted) payload;
// src_hash is stableHash of the payload as the caller held it (raw, always:
// DECISIONS C3), so a node copy written raw by 0.8.5 still finds its version
// without running the redactor at boot. Both cover exactly the keys of the
// version's schema (SCHEMAS): a comment's {text, shared, replies, anchor}
// (payloadOf; plus `chain` for a chained comment, comment@2), a highlight's
// {anchor, shared, color, note}, a box grab's {anchor, shared, rect, meta,
// grab}, a chat comment's {text, shared, replies, anchor, chain}, a plug-in
// type's declared keys (registerSchema, schemaRow; 4A.2). The schemas
// are additive, so a chainless comment's hashes are 0.8.5's byte for byte. The sibling fields — `original` (the locator as
// the copy stored it, F3), `writer` ({class, owner, verified}), `provenance`
// (queue.provenance's object) and `owner` (the advisory owner, null in tranche
// 1) and `display` (how the chrome draws the element, never what it says: a
// detached glyph's {glyph: {dx, dy, corner}}, U587, RULED U587@glyph-offset-
// store AI5 a — a glyph move is a version whose payload equals its parent's
// beside a new display) — sit OUTSIDE both: changing any of them changes
// neither hash (F3). A write's writer and provenance ride the version that
// write appended (an add, an edit or a reply), never the payload (ruling A2).
//
// READING. load() builds every index in applog's onRecord callback and redacts
// NOTHING (GT-12: a boot is not a redaction pass). Text is masked lazily, at
// read time: version(), latest() and versionsOf() hand out views whose payload
// and sibling fields pass the redactor when they are read, and maskView(rec)
// is the eager form, so a value the redactor learns after the write (addKnown)
// is masked on every read while the bytes on disk are never rewritten. The raw
// indexed record never leaves this closure.
//
// THE CHAT FAMILY (DECISIONS C1, D5; tranche 3, U415). A chat element (the
// built-in chat-comment, schema chat-comment@… in SCHEMAS) is one line of
// versions in this log and nothing else: no commit record pins it, no node
// holds a copy of it, and its Delete is a drop record. Its anchor is a chat
// anchor record (CHAT_ANCHOR_TABLE: a common head plus its kind's own fields)
// built from SERVED, masked text by the mirror (U414, U417), so its quote holds
// no value the redactor knew at create; a value learned later is masked at
// every read, as a comment's is (READING, below).
//
// MINTING (PLAN 1A.2, G-9). nextSeq() = 1 + the max of every version's seq,
// every reserveSeq(n), the migration record's seq_floor and every `"seq":<n>`
// in the log's own `<file>.torn-*` asides (a torn tail may hold the newest
// seq a crash never finished writing), and every id or seq the boot reconcile
// reads in an unreadable node file's aside (its reserveSeq; GT-10, K1). One
// tolerant scanner reads all such bytes: maxElementSeqIn. nextV(id) = 1 + the max of every v seen
// for the id and every reserve(id, v). Both are peeks; a version or a
// reservation consumes. mintId(type) reserves a fresh seq and returns the
// type's letter (ID_PREFIX; 'c' for a comment, the default; 'p' for every
// plug-in type, PLUGIN_ID_LETTER) + it, and that
// id's first version takes the same seq, so an id is always its letter + the
// seq of its first version. Neither ever decreases across a reopen.
//
// THE HOME NODE (DECISIONS C1). homeOf(id, v) is the node of the FIRST commit
// record, in log order, whose pins name id@v.
//
// THE COMMIT DIGEST (notes-A D4). nodeDigest covers a node's identity and its
// pins' id@v, never the file's bytes: a node file is rewritten in place by a
// bookmark (routes/graph.js), a node theme (routes/theme.js) and the late-Stop
// patch (turn-guard.js), none of which changes it. A copy with no `v` (a node
// written before the upgrade, or by 0.8.5 during a rollback) contributes
// `id@`, so the migration and the daemon's boot compute one digest from one
// file.
//
// lib/core: requires only lib/core modules and Node builtins.

const fs = require('fs');
const path = require('path');
const { openLog } = require('./applog');
const { stableHash, stableStringify } = require('./stable-json');
const { ANCHOR_STATES } = require('./anchor-states');
const { CHAT_ANCHOR_KINDS } = require('./element-policy');
const { isReservedElementType } = require('./names');

const CONVERTED = 'pin-locator@1';
// The sibling fields of a version: redacted on write and on read, outside both
// hashes. `display` (U587) is the newest: a reader older than tranche 4 keeps
// it as an unknown field of the record and draws nothing from it.
const SIBLINGS = ['original', 'writer', 'provenance', 'owner', 'display'];

const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const pinKey = (id, v) => `${id}@${v}`;
// The id@v a close record holds: an id@v parsePin reads whose id passes the
// no-text id check (a letter, then letters, digits, '_' or '-', at most 64).
// Ids only, so a close never carries text; heldCopies
// (lib/server/domain/elements) keeps only what passes.
const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const isPinKey = (s) => { const p = parsePin(s); return p !== null && ELEMENT_ID_RE.test(p.id); };
// An ack key: '<state> <key>', the state a lowercase name and the key ids,
// file names, digests or offsets (letters, digits and @ : . _ + -) — never text.
const ACK_KEY_RE = /^[a-z][a-z-]{0,63} [A-Za-z0-9@:._+-]{1,200}$/;
const isAckKey = (s) => typeof s === 'string' && ACK_KEY_RE.test(s);
// An answers item (the side table, U313). Its state is one of the resolver's
// three answers (the vocabulary's first three: exact, re-resolved, orphaned);
// how and why are resolver codes ('path', 'score-low', 'row-search'), never
// text; qual's two halves are hashes; source is a peer and a device word.
// Only `record` carries text, and it passes the redactor (appendAnswers).
const ANSWER_STATES = Object.freeze(ANCHOR_STATES.slice(0, 3));
const ANSWER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,31}$/;
const isAnswerCode = (s) => typeof s === 'string' && ANSWER_CODE_RE.test(s);
const ANSWER_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ANSWER_PEERS = Object.freeze(['local', 'remote']);
const ANSWER_DEVICES = Object.freeze(['desktop', 'mobile']);
// A record's bytes as JSON, at most (reports.js MAX_RECORD is 4 KB; the log
// takes twice that, so a redaction mask that grows a value never refuses one).
const ANSWER_RECORD_MAX = 8 * 1024;
const ANSWER_ITEMS_MAX = 5000;
const ANSWER_KEYS = Object.freeze(['id', 'v', 'mount', 'state', 'how', 'why', 'tie', 'gen', 'surface', 'qual', 'source', 'record']);
const isPlainObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
// Why an answers item is malformed (a word), or null when it is well formed.
// Shape only: whether the log holds its id@v is appendAnswers' question.
function answerItemProblem(it) {
  if (!isPlainObj(it)) return 'not-an-object';
  for (const k of Object.keys(it)) if (!ANSWER_KEYS.includes(k)) return `key:${k}`;
  if (typeof it.id !== 'string' || !ELEMENT_ID_RE.test(it.id) || !isPosInt(it.v)) return 'id';
  if (typeof it.mount !== 'string' || !it.mount || it.mount.length > 200) return 'mount';
  if (!ANSWER_STATES.includes(it.state)) return 'state';
  for (const k of ['how', 'why']) if (it[k] !== undefined && !isAnswerCode(it[k])) return k;
  if (it.tie !== undefined && !(typeof it.tie === 'number' && Number.isFinite(it.tie))) return 'tie';
  if (!Number.isSafeInteger(it.gen) || it.gen < 0) return 'gen';
  if (!Number.isSafeInteger(it.surface)) return 'surface';
  const q = it.qual;
  if (!isPlainObj(q) || Object.keys(q).length !== 2 || !ANSWER_HASH_RE.test(q.spec) || !ANSWER_HASH_RE.test(q.store)) return 'qual';
  const src = it.source;
  if (!isPlainObj(src) || Object.keys(src).some((k) => k !== 'peer' && k !== 'device')
    || !ANSWER_PEERS.includes(src.peer) || !(src.device == null || ANSWER_DEVICES.includes(src.device))) return 'source';
  if (it.record !== undefined) {
    let bytes = Infinity;
    try { bytes = Buffer.byteLength(JSON.stringify(it.record)); } catch {}
    if (!isPlainObj(it.record) || bytes > ANSWER_RECORD_MAX) return 'record';
  }
  return null;
}
// A value exactly as the log's bytes carry it (an undefined property dropped,
// as JSON.stringify drops it), so a stored record rehashes to its own hashes
// whether it was just appended or read back from disk.
const jsonClean = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

// ── pure helpers ────────────────────────────────────────────────────────────

// The legacy pin locator ({mount, selector, text, ordinal}) as an element
// anchor record, form pin-locator@1 (ruling A1, notes-A D6). Pure. On a legacy
// locator it reads only the four locator fields (C-10); a record that already
// has the full converted shape (isConverted) is returned as it is, so the
// converter is idempotent on its own output. Anything else is a legacy
// locator, however it names its form: the anchor is client data, stored as the
// pane sent it. The record has no row head: the migration has no DOM. A
// locator with no string mount cannot be placed anywhere and throws
// {reason: 'anchor-without-mount'}.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function isConverted(a) {
  if (!own(a, 'form') || a.form !== CONVERTED) return false;
  const { v, kind, mount, path: p, fingerprint: f, ordinal } = a;
  return v === 1 && kind === 'element' && typeof mount === 'string' && mount !== ''
    && !!p && typeof p === 'object' && typeof p.selector === 'string'
    && !!f && typeof f === 'object' && typeof f.tag === 'string' && typeof f.text === 'string'
    && Array.isArray(f.classes) && f.classes.every((c) => typeof c === 'string')
    && (ordinal === null || Number.isInteger(ordinal));
}
function convertAnchor(a) {
  if (a == null) return null;
  if (isConverted(a)) return a;
  const mount = a.mount;
  if (typeof mount !== 'string' || !mount) {
    throw Object.assign(new Error('anchor without a mount'), { reason: 'anchor-without-mount' });
  }
  const selector = a.selector;
  const text = a.text;
  const ordinal = a.ordinal;
  const sel = typeof selector === 'string' ? selector : '';
  const tag = (sel.match(/^[a-z][a-z0-9-]*/i) || ['*'])[0].toLowerCase();
  const classes = sel.split('.').slice(1).filter(Boolean);
  return {
    v: 1, kind: 'element', form: CONVERTED, mount,
    path: { selector: sel },
    fingerprint: { tag, classes, text: typeof text === 'string' ? text : '' },
    ordinal: Number.isInteger(ordinal) ? ordinal : null,
  };
}

// A reply as the payload carries it: {author, at, text}; every other key
// (a reply's writer and provenance among them: they ride the version that
// appended the reply, ruling A2) is dropped, and so is an undefined field.
function replyOf(r) {
  const out = {};
  if (r && r.author !== undefined) out.author = r.author;
  if (r && r.at !== undefined) out.at = r.at;
  if (r && r.text !== undefined) out.text = r.text;
  return out;
}

// An anchor record of the engine's own (lib/core/anchors.js record /
// recordRange / recordSource / recordPoint): v 1, a kind it records, and
// neither a `form` (a converted locator carries one) nor a top-level
// `selector` (a legacy locator's). comment@1 stores one as given (U326), so
// the chrome can keep the engine's anchor while every legacy copy still
// converts. A point (4C.1, U532; RULED U531-U532@point-record-kind a) is the
// element record with kind 'point' and x, y, aspect flat beside it: kept as
// given, so the log, the node copy and get_comments' record keep its target
// and its point (alpha.3 had no 'point' here and converted one). The chat
// kinds (element-policy CHAT_ANCHOR_KINDS) are the engine's too: a chat
// anchor is kept as given (CHAT_ANCHOR_TABLE checks it).
const ENGINE_KINDS = new Set(['element', 'range', 'source', 'point', ...CHAT_ANCHOR_KINDS]);
function isEngineRecord(a) {
  return !!a && typeof a === 'object' && !Array.isArray(a)
    && a.v === 1 && ENGINE_KINDS.has(a.kind) && !own(a, 'form') && !own(a, 'selector');
}

// The payload a version stores for a node copy, and every hash of it hashes:
// {text, shared, replies, anchor} and nothing else (PLAN 1A.4). The declared
// normalisation: an absent `replies` equals []; an absent `text` reads as '';
// the anchor is converted (convertAnchor), unless it is an engine record
// (isEngineRecord) of a PAGE kind, which is kept as given. A chat-kind record
// (CHAT_ANCHOR_KINDS) is no page comment's: it goes to convertAnchor like any
// other non-page anchor, which refuses a mountless one ('anchor-without-mount',
// a 400 at the route) — a page comment never stores a chat anchor (the type's
// anchors are chat kinds iff its family is chat), and chat-comment@1 has no
// normalise, so the chat path never reads this. An undefined `shared` is left
// out (as the bytes would leave it).
//
// A comment's CHAIN (F.6; RULED U406@pick O5 (a), "chain"): the live elements
// that were under the press when the comment was made, an ordered list of
// their ids, smallest first. payloadOf adds `chain` (a copy) only when the
// copy carries a non-empty array of strings, so a chainless comment's payload
// — and both its hashes — are comment@1's exactly, and every copy written
// before the chain still matches its version (copyMatches). The ids are
// checked by the comment@2 row (checkChain), not here: payloadOf only
// normalises.
const chainOfCopy = (c) => (Array.isArray(c.chain) && c.chain.length && c.chain.every((x) => typeof x === 'string') ? c.chain.slice() : null);
function payloadOf(copy) {
  const c = copy || {};
  const out = { text: c.text ?? '' };
  if (c.shared !== undefined) out.shared = c.shared;
  out.replies = (Array.isArray(c.replies) ? c.replies : []).map(replyOf);
  const a = c.anchor ?? null;
  out.anchor = isEngineRecord(a) && !CHAT_ANCHOR_KINDS.includes(a.kind) ? a : convertAnchor(a);
  const chain = chainOfCopy(c);
  if (chain) out.chain = chain;
  return out;
}

// THE SCHEMA TABLE (PLAN 2C.4; U326). Every version names its schema, and
// the schema names the only keys its payload may own: appendVersion refuses
// any other key, and both hashes cover those keys and nothing else (PLAN
// 1A.4; F3). The schemas are additive (a new type adds a row, never a key to
// another row), so comment@1's hashes stay 0.8.5's. A comment is copied into
// node files, and its payload is what a copy is matched against (payloadOf,
// the declared normalisation); a highlight and a box grab live in the log
// alone and reach a node as id@v references (E-STORE a), so their payloads
// are stored as given (jsonClean'd), anchor and all. A box grab's `rect` is
// {x, y, w, h, item, viewport}, its `meta` the DOM metadata (an object, U328b), and its
// `grab` the capture that holds its picture, {capture: 'cap<n>'}, or null:
// never the image's bytes (F-GRAB a). The schema names live here and in the
// element type manifests (test/conventions.test.js holds the literals).
//
// comment@2 (F.6, U406) is comment@1's keys plus `chain`, the ids of the live
// elements under the press, smallest first (checkChain). It is appended AFTER
// the three tranche-2 rows, so SCHEMA and PAYLOAD_KEYS stay comment@1's, and
// a comment is written under it only when it carries a chain
// (commentSchemaOf): a chainless comment stays comment@1 and hashes as 0.8.5's.
//
// chat-comment@1 (tranche 3, U415; RULED CHAT@type a, L.4 O5) is comment@2's
// keys — chain included, a list that is empty for a bare comment — stored as
// given (a chat element is never copied into a node file, so there is no copy
// to normalise against) and checked by checkChatPayload: its anchor is a chat
// anchor record (CHAT_ANCHOR_TABLE). Appended last: every other row's hashes
// stay as they are.
const SCHEMAS = Object.freeze({
  'comment@1': Object.freeze({ type: 'comment', keys: Object.freeze(['text', 'shared', 'replies', 'anchor']), normalise: payloadOf }),
  'highlight@1': Object.freeze({ type: 'highlight', keys: Object.freeze(['anchor', 'shared', 'color', 'note']) }),
  'box-grab@1': Object.freeze({ type: 'box-grab', keys: Object.freeze(['anchor', 'shared', 'rect', 'meta', 'grab']), check: checkGrab }),
  'comment@2': Object.freeze({ type: 'comment', keys: Object.freeze(['text', 'shared', 'replies', 'anchor', 'chain']), normalise: payloadOf, check: checkChain }),
  'chat-comment@1': Object.freeze({ type: 'chat-comment', keys: Object.freeze(['text', 'shared', 'replies', 'anchor', 'chain']), check: checkChatPayload }),
});
// comment@1, the tranche-1 schema: its name and its keys, as every caller has them.
const SCHEMA = Object.keys(SCHEMAS)[0];
const PAYLOAD_KEYS = new Set(SCHEMAS[SCHEMA].keys);
// The chained comment's schema, read from the table (the comment row whose
// keys hold `chain`; never a second spelling of its name), and the schema a
// comment payload is written under: CHAIN_SCHEMA when it carries a chain,
// else SCHEMA. Every comment append (an add, an edit, a reply, a re-anchor, a
// node copy's mint, a repair) passes commentSchemaOf(payload).
const CHAIN_SCHEMA = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === SCHEMAS[SCHEMA].type && SCHEMAS[s].keys.includes('chain'));
const commentSchemaOf = (payload) => (payload && Object.prototype.hasOwnProperty.call(payload, 'chain') ? CHAIN_SCHEMA : SCHEMA);

// A box grab's `grab`: null, or {capture: 'cap<n>'}, a reference to the
// capture record that holds the picture, never the picture.
const CAPTURE_REF_RE = /^cap\d+$/;
function checkGrab(payload) {
  const g = payload.grab;
  if (g === undefined || g === null) return;
  if (typeof g !== 'object' || Array.isArray(g)
    || Object.keys(g).some((k) => k !== 'capture') || typeof g.capture !== 'string' || !CAPTURE_REF_RE.test(g.capture)) {
    throw new TypeError("appendVersion: a box-grab@1 payload's grab is null or {capture: 'cap<n>'} (a capture reference, never the image)");
  }
}

// A chained comment's `chain` (comment@2): 1..CHAIN_MAX distinct ids, each a
// typed id (isTypedId: a letter of ID_PREFIX — c, h, g, k — or the plug-in
// letter p, then digits; RULED U513@id-letter a: a chain may name a plug-in
// element). Ids only,
// never text. A comment@2 payload with no chain is refused: a chainless
// comment is comment@1 (commentSchemaOf).
const CHAIN_MAX = 8;
function checkChain(payload) {
  const ch = payload.chain;
  const why = !Array.isArray(ch) || !ch.length ? 'is a non-empty list of element ids'
    : ch.length > CHAIN_MAX ? `holds at most ${CHAIN_MAX} ids`
      : ch.some((x) => !isTypedId(x)) ? 'holds typed element ids only (a type\'s letter + digits)'
        : new Set(ch).size !== ch.length ? 'holds each id once'
          : null;
  if (why) throw new TypeError(`appendVersion: a ${CHAIN_SCHEMA} payload's chain ${why}`);
}

// ── the chat anchor record (tranche 3, U415; RULED S1-confirm = a) ──
//
// ONE record table, one row per chat anchor kind. Every chat anchor carries
// the common head {v: 1, kind, conversation_id, session_id, turn_id, quote,
// marks, label} plus its kind's own fields: a row's `required` must be there,
// its `optional` may be, and any other field — another kind's (fp on a diff
// line, line_fp on a passage) or one no kind owns — is refused. U414 produces
// the turn, item and item-range rows, U417 the diff-line row. Shape only:
// whether the anchor still places is the mirror's (resolveAnchors).
//   quote   {exact: 1..CHAT_QUOTE_MAX characters, prefix and suffix at most
//           CHAT_CONTEXT_MAX} (anchors.js quoteOf's CONFIG: quote_max, ctx_n)
//   marks   the masks inside quote.exact at create, a non-negative integer
//   label   what the pin is on, 1..CHAT_LABEL_MAX characters (a diff line's
//           path included)
//   fp      {h: 16 hex, len: a non-negative integer} — the served field's
//           fingerprint; line_fp {h: 16 hex} — a diff row's
const CHAT_QUOTE_MAX = 2000;
const CHAT_CONTEXT_MAX = 32;
const CHAT_LABEL_MAX = 300;
const CHAT_ID_MAX = 200;
const FP_HEX_RE = /^[0-9a-f]{16}$/;
const isNonNegInt = (n) => Number.isSafeInteger(n) && n >= 0;
const isStr = (s, max = CHAT_ID_MAX) => typeof s === 'string' && s !== '' && s.length <= max;
const CHAT_HEAD_FIELDS = Object.freeze(['v', 'kind', 'conversation_id', 'session_id', 'turn_id', 'quote', 'marks', 'label']);
// What each field holds: a predicate per field name, the head's and every
// kind's.
const CHAT_FIELD_CHECKS = Object.freeze({
  v: (x) => x === 1,
  kind: (x) => CHAT_ANCHOR_KINDS.includes(x),
  conversation_id: (x) => isStr(x),
  session_id: (x) => isStr(x),
  turn_id: (x) => isStr(x),
  quote: (q) => isPlainObj(q) && Object.keys(q).every((k) => k === 'exact' || k === 'prefix' || k === 'suffix')
    && isStr(q.exact, CHAT_QUOTE_MAX)
    && ['prefix', 'suffix'].every((k) => q[k] === undefined || (typeof q[k] === 'string' && q[k].length <= CHAT_CONTEXT_MAX)),
  marks: isNonNegInt,
  label: (x) => isStr(x, CHAT_LABEL_MAX),
  fp: (f) => isPlainObj(f) && Object.keys(f).length === 2 && FP_HEX_RE.test(f.h) && isNonNegInt(f.len),
  item_id: (x) => isStr(x),
  field: (x) => isStr(x, 40),
  pos: (p) => isPlainObj(p) && Object.keys(p).length === 2 && isNonNegInt(p.start) && isNonNegInt(p.end) && p.end > p.start,
  ordinal: (o) => isPlainObj(o) && Object.keys(o).length === 2 && isNonNegInt(o.index) && isPosInt(o.of) && o.index < o.of,
  file: (x) => isStr(x, CHAT_LABEL_MAX),
  side: (x) => x === 'new' || x === 'old',
  line: isPosInt,
  line_fp: (f) => isPlainObj(f) && Object.keys(f).length === 1 && FP_HEX_RE.test(f.h),
  node_id: (x) => isStr(x),
});
const quoteRow = Object.freeze({ required: Object.freeze(['fp']), optional: Object.freeze(['item_id', 'field', 'pos', 'ordinal']) });
const CHAT_ANCHOR_TABLE = Object.freeze({
  turn: quoteRow,
  item: quoteRow,
  'item-range': quoteRow,
  'diff-line': Object.freeze({ required: Object.freeze(['file', 'side', 'line', 'line_fp']), optional: Object.freeze(['node_id']) }),
});
// Why a chat anchor record is refused (a phrase), or null when it fits its
// kind's row.
function chatAnchorProblem(a) {
  if (!isPlainObj(a)) return 'is a chat anchor record (an object)';
  if (!CHAT_ANCHOR_KINDS.includes(a.kind)) return `has a chat kind (${CHAT_ANCHOR_KINDS.join(', ')}), not ${JSON.stringify(a.kind === undefined ? null : a.kind)}`;
  const row = CHAT_ANCHOR_TABLE[a.kind];
  for (const k of [...CHAT_HEAD_FIELDS, ...row.required]) {
    if (!own(a, k)) return `lacks ${k} (a ${a.kind} anchor carries ${[...CHAT_HEAD_FIELDS, ...row.required].join(', ')})`;
  }
  const mine = new Set([...CHAT_HEAD_FIELDS, ...row.required, ...row.optional]);
  for (const k of Object.keys(a)) {
    if (!mine.has(k)) {
      const owner = Object.keys(CHAT_ANCHOR_TABLE).find((kind) => [...CHAT_ANCHOR_TABLE[kind].required, ...CHAT_ANCHOR_TABLE[kind].optional].includes(k));
      return owner ? `holds ${k}, a ${owner} anchor's field, not a ${a.kind} anchor's` : `holds ${k}, which no chat anchor carries`;
    }
    if (a[k] === undefined) continue;
    if (!CHAT_FIELD_CHECKS[k](a[k])) return `has a malformed ${k}`;
  }
  return null;
}

// A chat comment's payload (chat-comment@1): text a string, shared a boolean
// when present, replies a list of {author: 'user' | 'claude', at, text} when
// present, the anchor a chat anchor record (chatAnchorProblem), and chain a
// list of at most CHAIN_MAX distinct typed element ids — empty for a bare
// comment (shape only: whether they are live is the route's).
function checkChatPayload(payload) {
  const name = Object.keys(SCHEMAS).find((s) => SCHEMAS[s].check === checkChatPayload);
  const bad = (why) => { throw Object.assign(new TypeError(`appendVersion: a ${name} payload's ${why}`), { reason: 'payload' }); };
  if (typeof payload.text !== 'string') bad('text is a string');
  if (payload.shared !== undefined && typeof payload.shared !== 'boolean') bad('shared is true or false');
  if (payload.replies !== undefined) {
    if (!Array.isArray(payload.replies)) bad('replies are a list');
    for (const r of payload.replies) {
      if (!isPlainObj(r) || Object.keys(r).some((k) => k !== 'author' && k !== 'at' && k !== 'text')
        || !CHAT_REPLY_AUTHORS.includes(r.author) || typeof r.text !== 'string' || !(typeof r.at === 'number' && Number.isFinite(r.at))) {
        bad(`replies are {author: ${CHAT_REPLY_AUTHORS.join(' | ')}, at, text}`);
      }
    }
  }
  const why = chatAnchorProblem(payload.anchor);
  if (why) bad(`anchor ${why}`);
  const ch = payload.chain;
  if (!Array.isArray(ch)) bad('chain is a list of element ids (empty for a bare comment)');
  if (ch.length > CHAIN_MAX) bad(`chain holds at most ${CHAIN_MAX} ids`);
  if (ch.some((x) => !isTypedId(x))) bad('chain holds typed element ids only (a type\'s letter + digits)');
  if (new Set(ch).size !== ch.length) bad('chain holds each id once');
}
// A reply's authors (the comment's: the user, or Claude through its verified
// credential — the route's check, C-15-2).
const CHAT_REPLY_AUTHORS = Object.freeze(['user', 'claude']);

// TYPED IDS (ruling U326@id-prefix a). One letter per type, from this fixed
// table, over the ONE seq counter: no two elements ever share an id, and an
// id is always its letter + the seq of its first version. The tolerant
// scanner (ELEMENT_SEQ_RE) reads every letter here. A disk format.
// chat-comment's letter is 'k' (tranche 3, RULED R5-confirm = a: a disk format).
const ID_PREFIX = Object.freeze({ comment: 'c', highlight: 'h', 'box-grab': 'g', 'chat-comment': 'k' });
// The type a typed id's letter names (ID_PREFIX read backwards): 'h7' → the
// highlight's. null for an id that is not a letter of the table + digits (an
// id written by hand, or by an older mint).
const TYPE_OF_LETTER = new Map(Object.entries(ID_PREFIX).map(([type, letter]) => [letter, type]));
function typeOfId(id) {
  const m = typeof id === 'string' ? /^([a-z])\d+$/.exec(id) : null;
  return m ? TYPE_OF_LETTER.get(m[1]) ?? null : null;
}

// THE PLUG-IN LETTER (RULED U513@id-letter a, 2026-11-02; a disk format). One
// letter for every plug-in type, over the same one seq counter: a plug-in
// element's id is 'p' + the seq of its first version, and its type lives in
// its `el` record's kind (ensureElement({kind: type})), never in the letter —
// so typeOfId('p7') is null and the schema-matches-the-id check reads the
// kind. ID_PREFIX is unchanged (its four letters are the built-ins').
const PLUGIN_ID_LETTER = 'p';
// A typed id: a letter of ID_PREFIX or the plug-in letter, then digits. What
// a chain may name (checkChain, checkChatPayload).
const TYPED_ID_RE = /^([a-z])\d+$/;
function isTypedId(id) {
  const m = typeof id === 'string' ? TYPED_ID_RE.exec(id) : null;
  return !!m && (TYPE_OF_LETTER.has(m[1]) || m[1] === PLUGIN_ID_LETTER);
}

// ── PLUG-IN SCHEMAS (annotation engine tranche 4, 4A.2; U513) ──
//
// SCHEMAS above is the built-ins' frozen literal and stays byte-equal (the
// schema-literal ratchet; every built-in hash unchanged). An approved pack's
// type (B1: listed by the record-gated registry, lib/server/element-types)
// gets its row here, registered from its element.json's `payload`
// declaration at list time (registerSchema; SCHEMA@pack-row). The table is
// process-wide and additive: a registration is never undone (a removed type's
// versions stay loaded and readable, written by nobody), the same name
// registers again only with the same keys (new keys take a new @n), and the
// log's load never validates a version's schema.
//
// THE DECLARATION (RULED U513-U565@payload-decl a): element.json
// `payload: {keys: [...], max_bytes?}` — 1..PLUGIN_KEYS_MAX unique names
// (PLUGIN_KEY_RE), `anchor` and `shared` among them, never `meta` (the
// engine's reserved key, added to every plug-in row); max_bytes an integer
// 1..PLUGIN_PAYLOAD_MAX (default PLUGIN_PAYLOAD_MAX). payloadDeclProblem is
// its one check (the registry's, and U514's at review). The engine's derived
// fields are top-level declared keys (U513-U561@derived-fields-home a): `meta`
// is reserved and no unit writes it.
//
// THE GENERIC BOUND (one value grammar for every plug-in payload): each value
// is null, a boolean, a finite number, a string of at most PLUGIN_STRING_MAX
// characters, an array of at most PLUGIN_ARRAY_MAX finite numbers, or an
// array of at most PLUGIN_ARRAY_MAX arrays of at most PLUGIN_TUPLE_MAX finite
// numbers (a stroke's [[x, y, pressure, t], …]); `anchor` an engine record
// (isEngineRecord) of a page kind, or null — never a chat anchor; `shared` a
// boolean; `meta`, when present, a flat object of at most PLUGIN_META_MAX
// keys of the scalar kinds; and the payload's stable JSON at most the row's
// maxBytes. The log's redaction runs over every string as for every version
// (appendVersion, the one writer).
const PLUGIN_STRING_MAX = 2000;
const PLUGIN_ARRAY_MAX = 4096;
const PLUGIN_TUPLE_MAX = 8;
const PLUGIN_PAYLOAD_MAX = 65536;
const PLUGIN_META_MAX = 32;
const PLUGIN_KEYS_MAX = 24;
const PLUGIN_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PLUGIN_META_KEY = 'meta';
const PLUGIN_REQUIRED_KEYS = Object.freeze(['anchor', 'shared']);

const pluginRows = new Map();   // schema name → its frozen row
const pluginTypes = new Set();  // every type a plug-in row names

const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isScalar = (x) => x === null || typeof x === 'boolean' || isFiniteNum(x)
  || (typeof x === 'string' && x.length <= PLUGIN_STRING_MAX);
// Why one plug-in payload value is refused (a phrase), or null.
function pluginValueProblem(x) {
  if (isScalar(x)) return null;
  if (typeof x === 'string') return `is a string of at most ${PLUGIN_STRING_MAX} characters`;
  if (!Array.isArray(x)) return `is null, a boolean, a finite number, a string, a list of numbers or a list of number tuples (got ${x === undefined ? 'undefined' : typeof x})`;
  if (x.length > PLUGIN_ARRAY_MAX) return `holds at most ${PLUGIN_ARRAY_MAX} entries`;
  if (x.every(isFiniteNum)) return null;
  for (const t of x) {
    if (!Array.isArray(t) || !t.every(isFiniteNum)) return 'is a list of finite numbers, or a list of tuples of finite numbers (never a mix, never an object)';
    if (t.length > PLUGIN_TUPLE_MAX) return `holds tuples of at most ${PLUGIN_TUPLE_MAX} numbers`;
  }
  return null;
}

// Why a `payload` declaration (element.json) is refused (a phrase), or null.
// Pure. `type` is the declaring type: a built-in's schema is the log's own.
function payloadDeclProblem(decl, type) {
  if (typeof type === 'string' && isReservedElementType(type)) return 'is not declared by a built-in type (its schema is the log\'s own)';
  if (!isPlainObj(decl)) return 'is an object {keys: [...], max_bytes?}';
  for (const k of Object.keys(decl)) if (k !== 'keys' && k !== 'max_bytes') return `holds ${JSON.stringify(k)}; it holds only keys and max_bytes`;
  const keys = decl.keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > PLUGIN_KEYS_MAX) return `keys is a list of 1 to ${PLUGIN_KEYS_MAX} names`;
  for (const k of keys) {
    if (typeof k !== 'string' || !PLUGIN_KEY_RE.test(k)) return `keys holds names matching ${PLUGIN_KEY_RE} only (got ${JSON.stringify(k)})`;
  }
  if (new Set(keys).size !== keys.length) return 'keys holds each name once';
  if (keys.includes(PLUGIN_META_KEY)) return `keys never names ${PLUGIN_META_KEY} (the engine's reserved key)`;
  for (const k of PLUGIN_REQUIRED_KEYS) if (!keys.includes(k)) return `keys names ${PLUGIN_REQUIRED_KEYS.join(' and ')} (missing ${k})`;
  if (decl.max_bytes !== undefined && !(Number.isSafeInteger(decl.max_bytes) && decl.max_bytes >= 1 && decl.max_bytes <= PLUGIN_PAYLOAD_MAX)) {
    return `max_bytes is an integer from 1 to ${PLUGIN_PAYLOAD_MAX}`;
  }
  return null;
}

// The generic bound over one plug-in payload (a row's check). Throws a
// TypeError with reason 'payload' (the routes' 400) naming the schema.
function checkPluginPayload(name, row, payload) {
  const bad = (why) => { throw Object.assign(new TypeError(`appendVersion: a ${name} payload's ${why}`), { reason: 'payload' }); };
  for (const k of PLUGIN_REQUIRED_KEYS) if (!own(payload, k)) bad(`${k} is required`);
  const a = payload.anchor;
  if (a !== null && !(isEngineRecord(a) && !CHAT_ANCHOR_KINDS.includes(a.kind))) bad('anchor is an engine anchor record of a page kind, or null');
  if (typeof payload.shared !== 'boolean') bad('shared is true or false');
  for (const k of Object.keys(payload)) {
    if (k === 'anchor' || k === 'shared') continue;
    const x = payload[k];
    if (k === PLUGIN_META_KEY) {
      if (x === undefined || x === null) continue;
      if (!isPlainObj(x)) bad(`${k} is a flat object of scalars`);
      const mk = Object.keys(x);
      if (mk.length > PLUGIN_META_MAX) bad(`${k} holds at most ${PLUGIN_META_MAX} keys`);
      for (const m of mk) if (!isScalar(x[m])) bad(`${k}.${m} is null, a boolean, a finite number or a string of at most ${PLUGIN_STRING_MAX} characters`);
      continue;
    }
    const why = pluginValueProblem(x);
    if (why) bad(`${k} ${why}`);
  }
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(stableStringify(payload)); } catch {}
  if (bytes > row.maxBytes) bad(`size is at most ${row.maxBytes} bytes as stable JSON (got ${bytes === Infinity ? 'an unserialisable payload' : bytes})`);
}

const sameKeys = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
// Register a plug-in type's schema row: {type, keys (the declared keys, then
// the reserved `meta`), maxBytes, check (the generic bound), plugin: true},
// frozen. Idempotent for an equal registration; a TypeError otherwise (see
// the head of this section).
function registerSchema(name, { type, keys, maxBytes } = {}) {
  if (typeof name !== 'string' || !name) throw new TypeError('registerSchema: a schema name');
  if (own(SCHEMAS, name)) throw new TypeError(`registerSchema: ${name} is a built-in schema`);
  if (typeof type !== 'string' || !type) throw new TypeError('registerSchema: a type');
  if (isReservedElementType(type) || Object.values(SCHEMAS).some((r) => r.type === type) || own(ID_PREFIX, type)) {
    throw new TypeError(`registerSchema: ${type} is a built-in type (its schemas are the log's own)`);
  }
  const p = parsePin(name);
  if (!p || p.id !== type) throw new TypeError(`registerSchema: a schema name is "${type}@<n>", not ${JSON.stringify(name)}`);
  const decl = { keys };
  if (maxBytes !== undefined) decl.max_bytes = maxBytes;
  const why = payloadDeclProblem(decl, type);
  if (why) throw new TypeError(`registerSchema: ${name}'s payload ${why}`);
  const max = maxBytes === undefined ? PLUGIN_PAYLOAD_MAX : maxBytes;
  const had = pluginRows.get(name);
  if (had) {
    if (had.type === type && sameKeys(had.keys.filter((k) => k !== PLUGIN_META_KEY), keys) && had.maxBytes === max) return had;
    throw new TypeError(`registerSchema: ${name} is registered with other keys or another bound (schemas are additive: new keys take a new @n)`);
  }
  const row = {
    type,
    keys: Object.freeze([...keys, PLUGIN_META_KEY]),
    maxBytes: max,
    check: (payload) => checkPluginPayload(name, row, payload),
    plugin: true,
  };
  Object.freeze(row);
  pluginRows.set(name, row);
  pluginTypes.add(type);
  return row;
}

// A schema's row: SCHEMAS' own (own-property reads only, so 'toString' and
// '__proto__' are null), else a registered plug-in row, else null. The one
// reader of a version's schema row outside this file.
function schemaRow(name) {
  if (typeof name !== 'string') return null;
  if (own(SCHEMAS, name)) return SCHEMAS[name];
  return pluginRows.get(name) || null;
}
// Every schema name with a row: the built-ins in table order, then the
// plug-in rows in registration order.
const schemaNames = () => [...Object.keys(SCHEMAS), ...pluginRows.keys()];
// Whether a registered plug-in row names `type`.
const isPluginType = (type) => typeof type === 'string' && pluginTypes.has(type);

// Does a node copy hold version `rec`'s payload? The raw copy matches
// src_hash, a redacted one payload_hash. No redaction at check time. A copy
// whose anchor cannot be converted matches nothing.
function copyMatches(copy, rec) {
  if (!rec) return false;
  let h;
  try { h = stableHash(payloadOf(copy)); } catch { return false; }
  return h === rec.payload_hash || h === rec.src_hash;
}

// THE id@v PARSER (U353; plan 2E.3): the one reader of a pin string. Split at
// the LAST '@' (an id may itself hold one), so every typed id (c3, h7, g9)
// parses alike. {id, v}, or null for a non-string, no '@', an '@' at index 0,
// or a v that is not a positive safe integer written as its own decimal
// ('c3@02', 'c3@1e3', 'c3@ 3' are not). Every writer's `${id}@${v}` parses
// back to {id, v}.
const PIN_V_RE = /^[1-9][0-9]*$/;
function parsePin(s) {
  if (typeof s !== 'string') return null;
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const tail = s.slice(at + 1);
  if (!PIN_V_RE.test(tail)) return null;
  const v = Number(tail);
  return isPosInt(v) ? { id: s.slice(0, at), v } : null;
}

// A list of id@v strings → Map(id → v), in list order: a later entry of an id
// overwrites; a non-string or unparseable entry is skipped; a non-array is an
// empty Map.
function pinMapOf(pins) {
  const m = new Map();
  if (!Array.isArray(pins)) return m;
  for (const s of pins) {
    const p = parsePin(s);
    if (p) m.set(p.id, p.v);
  }
  return m;
}

// A committed node's digest (notes-A D4): its identity and its pins' id@v.
function nodeDigest(node) {
  const n = node || {};
  return stableHash({
    id: n.id,
    parent_id: n.parent_id,
    created_at: n.created_at,
    pins: (n.comments || []).map((c) => c.id + '@' + (c.v ?? '')).sort(),
  });
}

// ── park rule b2 (DECISIONS C3), ported unchanged from the measured prototype
// (design/annotation-engine-redesign/tests/F5/lib/park.js) ──
//
//   (b)  a copy is kept on its node when its anchor mount is present, or when it is the
//        FIRST ghost of an absent run (its nearest carrying ancestor had the pane, or no
//        ancestor carries the pin);
//   (b2) (b), plus a ghost copy whose payload changed against its nearest carrier (a reply
//        landed while the pane was gone) is kept.
//
// A kept ghost is an ORPHAN on its node (it shows in the tray); a ghost b2 does not keep is
// PARKED: its id@v stays in the node's derived list (node copies stay whole, nothing is
// rewritten) and in the log, but the node does not draw or tray it.
// parkB2 memoises parkHash per copy and reads the nearest carrier once (U248): a cost change, not a rule change.

// The reply identity parkMetrics counts by.
const replyKey = (r) => stableStringify([r.author, r.at, r.text]);
// What "the payload changed" means for parking: text, shared and replies.
const parkHash = (c) => stableHash({ text: c.text ?? '', shared: c.shared, replies: (c.replies || []).map((r) => [r.author, r.text, r.at]) });

// copies: {node, id, anchor_mount_present, text, shared, replies}; topo: {parentOf(id)}
function parkB2(copies, topo) {
  const byPin = new Map();
  for (const c of copies) { if (!byPin.has(c.id)) byPin.set(c.id, new Map()); byPin.get(c.id).set(c.node, c); }
  const nearestCarrier = (id, nid) => { const nm = byPin.get(id); let a = topo.parentOf(nid); while (a && !nm.has(a)) a = topo.parentOf(a); return a ? nm.get(a) : null; };
  // One parkHash per copy object for this parkB2 call (the copies are not mutated while it is read).
  const hashes = new Map();
  const hashOf = (c) => { let h = hashes.get(c); if (h === undefined) { h = parkHash(c); hashes.set(c, h); } return h; };
  // (b) then (b2), with the nearest carrier read once: present, or no carrier, or a carrier
  // whose mount is present → kept; else kept only when the payload changed against it.
  const keepB2 = (c) => { if (c.anchor_mount_present) return true; const p = nearestCarrier(c.id, c.node); if (!p || p.anchor_mount_present) return true; return hashOf(p) !== hashOf(c); };
  const stateOf = (c) => (c.anchor_mount_present ? 'present' : keepB2(c) ? 'orphan' : 'parked');
  return { stateOf, keepB2, nearestCarrier, byPin };
}

// The S-5 metrics for one rule over the copies: orphans per pin-carrying node, homeless pin
// ids (no kept copy anywhere), replies lost (a reply no kept copy carries).
function parkMetrics(copies, nodes, stateOf) {
  const perNode = new Map(nodes.map((n) => [n.id, 0]));
  const homes = new Map(); const byPin = new Map(); let kept = 0; let parked = 0;
  for (const c of copies) {
    if (!byPin.has(c.id)) byPin.set(c.id, []); byPin.get(c.id).push(c);
    const s = stateOf(c);
    if (s === 'parked') { parked++; continue; }
    kept++;
    if (s === 'orphan') perNode.set(c.node, perNode.get(c.node) + 1);
    if (!homes.has(c.id)) homes.set(c.id, []); homes.get(c.id).push(c);
  }
  let homeless = 0; let repliesLost = 0; const homelessIds = [];
  for (const [id, list] of byPin) {
    const all = new Set(); for (const c of list) for (const r of c.replies || []) all.add(replyKey(r));
    const h = homes.get(id) || [];
    if (!h.length) { homeless++; homelessIds.push(id); repliesLost += all.size; continue; }
    const have = new Set(); for (const c of h) for (const r of c.replies || []) have.add(replyKey(r));
    for (const k of all) if (!have.has(k)) repliesLost++;
  }
  const carrying = new Set(copies.map((c) => c.node));
  const s = nodes.filter((n) => carrying.has(n.id)).map((n) => perNode.get(n.id)).sort((a, b) => a - b);
  const median = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  return { kept_copies: kept, parked_copies: parked, orphans_total: s.reduce((a, b) => a + b, 0), median_orphans_per_node: median, max_orphans_per_node: s.length ? s[s.length - 1] : null, pin_carrying_nodes: s.length, homeless_pin_ids: homeless, homeless_ids: homelessIds, replies_lost: repliesLost };
}

// Ancestor-or-self over a node set ({id, parent_id}[]) as an INDEX, not a walk:
// an Euler tour (tin/tout per node, one iterative DFS from every root), so the
// question is two integer comparisons — what the migration asks once per copy
// (a parent-chain walk per copy would be O(depth) each). Ported from the
// prototype's ancestryOf. lib/server/domain/lineage `ancestry` stays the
// daemon's one parent-chain walk. A node outside the set, or on a parent
// cycle no root reaches, is nobody's ancestor.
function ancestryIndex(nodes) {
  const ids = new Set();
  for (const n of nodes) if (n && n.id != null) ids.add(n.id);
  const children = new Map([...ids].map((id) => [id, []]));
  const roots = [];
  const seenRoot = new Set();
  for (const n of nodes) {
    if (!n || n.id == null) continue;
    if (n.parent_id != null && n.parent_id !== n.id && ids.has(n.parent_id)) children.get(n.parent_id).push(n.id);
    else if (!seenRoot.has(n.id)) { seenRoot.add(n.id); roots.push(n.id); }
  }
  const tin = new Map(); const tout = new Map(); let clock = 0;
  for (const root of roots) {
    const stack = [[root, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1]; const [id, k] = top;
      if (k === 0) tin.set(id, clock++);
      const kids = children.get(id) || [];
      if (k < kids.length) { top[1] = k + 1; stack.push([kids[k], 0]); } else { tout.set(id, clock++); stack.pop(); }
    }
  }
  const isAncestorOrSelf = (a, n) => { const ta = tin.get(a); const tn = tin.get(n); return ta !== undefined && tn !== undefined && ta <= tn && tout.get(n) <= tout.get(a); };
  return { tin, tout, isAncestorOrSelf };
}

// Copied verbatim from lib/server/graph.js (its comment and its function), so
// the daemon's graph loader and the migration share one predicate; graph.js
// requires this copy once the daemon binds the log.
// The graph-node shape predicate, used by graph.load below as readJson's
// `validate`. It lives here and not in lib/core/fsjson because core holds no
// type-specific knowledge (the boundary lib/core/resources.js draws).
//
// Both fields are load-bearing at load time and nowhere else is either checked:
// `created_at` drives the chronological sort, and `id` is parsed back into an
// integer to seed nextSeq. Every node ever written is `n${nextSeq}` with a
// numeric created_at (domain/turns commitNode), so this rejects nothing real —
// only the shapes a torn or placeholder file produces.
function isGraphNode(n) {
  return !!n && typeof n === 'object' && /^n\d+$/.test(n.id) && Number.isFinite(n.created_at);
}

// ── the log ─────────────────────────────────────────────────────────────────

// THE TOLERANT SCANNER (GT-10, ruling K1): the highest n over every
// `"seq": <n>` and every `"id": "<p><n>"`, <p> any letter of ID_PREFIX (c, h,
// g, k) or the plug-in letter (PLUGIN_ID_LETTER, p), in some bytes, whitespace allowed after the colon, safe integers only, 0
// when there is none. It never parses: the bytes it is for (a torn log tail, a
// node file or draft that does not read) are malformed by definition. Reading
// ids as well as seqs only ever raises a floor, since an element id is its
// letter + the seq of its first version. Any `seq`
// counts, a pane store's too (the signal-key convention writes Date.now()), so
// such bytes make ids jump, never collide. The one reader of such bytes: the
// log's torn asides (tornSeqOf), the migration's maxSeqIn and the boot
// reconcile's floor (lib/server/domain/elements-reconcile floorFromAsides).
// The letter class is ID_PREFIX's letters plus PLUGIN_ID_LETTER
// (test/element-schemas.test.js holds the two equal); a literal, so this stays the one "seq" regex
// (test/elements-mint-floor.test.js).
const ELEMENT_SEQ_RE = /"seq":\s*(\d+)|"id":\s*"[chgkp](\d+)"/g;
function maxElementSeqIn(text) {
  if (typeof text !== 'string' || !text) return 0;
  let max = 0;
  for (const m of text.matchAll(ELEMENT_SEQ_RE)) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

// THE NARROWED FLOOR (U354; tranche-1 U247's open issue): the same scanner,
// applied only inside the `"comments"` arrays of a node file's or a draft's
// bytes, so a pane store's seq (the signal-key convention writes Date.now())
// no longer makes ids jump. Each `"comments": [` is followed forward over the
// bytes — strings and their escapes honoured, [ ] and { } depth counted — to
// the array's end or to EOF (a tear inside the array), and ELEMENT_SEQ_RE
// (maxElementSeqIn) reads each span. → {max, found}; `found` is false when no
// `"comments": [` appears (the tear fell before it), and the caller then keeps
// the wide scan: `found ? max : maxElementSeqIn(text)` (GT-10's K1 floor, for
// every pin-shaped seq). The log's own torn asides keep the wide scan: their
// bytes are element records, not node files.
const COMMENTS_KEY_RE = /"comments"\s*:\s*\[/;
// The index just past the array whose `[` ends at `start` (its matching `]`),
// or text.length when the bytes end first.
function arrayEnd(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i++];
    if (ch === '"') {
      while (i < text.length) {
        const c = text[i++];
        if (c === '\\') i++;
        else if (c === '"') break;
      }
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      if (--depth === 0) return i;
    }
  }
  return text.length;
}
function maxPinSeqIn(text) {
  if (typeof text !== 'string' || !text) return { max: 0, found: false };
  let max = 0;
  let found = false;
  const re = new RegExp(COMMENTS_KEY_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    found = true;
    const start = m.index + m[0].length;
    const end = arrayEnd(text, start);
    const n = maxElementSeqIn(text.slice(start, end));
    if (n > max) max = n;
    re.lastIndex = end;
  }
  return { max, found };
}

// The highest seq or element id in the log's own torn asides (`<file>.torn-*`).
// In a dry run the tail is still in the file (nothing was set aside), so its
// bytes are read from there.
function tornSeqOf(file, { dryRun, tornBytes }) {
  let max = 0;
  const scan = (text) => { const n = maxElementSeqIn(text); if (n > max) max = n; };
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.torn-`;
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try { scan(fs.readFileSync(path.join(dir, name), 'utf8')); } catch {}
  }
  if (dryRun && tornBytes > 0) {
    try {
      const buf = fs.readFileSync(file);
      scan(buf.subarray(Math.max(0, buf.length - tornBytes)).toString('utf8'));
    } catch {}
  }
  return max;
}

function createElementLog({ file, redactor, dryRun = false, bootId, now = Date.now, fsync = false } = {}) {
  if (!redactor || typeof redactor.value !== 'function') {
    throw new TypeError('createElementLog: inject a redactor (lib/core/redact createRedactor())');
  }
  let lastNow = null;
  const clock = () => { lastNow = now(); return lastNow; };
  const log = openLog(file, { dryRun, bootId, now: clock, fsync });

  const elements = new Map();     // id → el record
  const versions = new Map();     // id → Map(v → ver record), first record of an id@v wins
  const latestV = new Map();      // id → max v in the log
  const reservedV = new Map();    // id → max v reserved
  const payloadIdx = new Map();   // id → Map(payload_hash → [v])
  const srcIdx = new Map();       // id → Map(src_hash → [v])
  const seqIdx = new Map();       // id → Map(seq → newest v carrying it)
  const firstSeq = new Map();     // id minted by mintId → the seq its first version takes
  const commitList = [];          // every commit record, in log order
  const commitByNode = new Map(); // node → its last commit record
  const home = new Map();         // 'id@v' → the node of the first commit pinning it
  const epochList = [];           // {boot, at, pid, index}
  const verIndex = new Map();     // 'id@v' → the record index of its (first) version record
  const closeList = [];           // {index, boot, at, held: Set('id@v'), complete}, in log order
  const ackedKeys = new Set();    // every '<state> <key>' an ack names
  let ackCount = 0;
  const answersByNode = new Map(); // node → Map('id@v' → its item), a later record set's item winning
  const firstRecord = new Map();  // 'id@v' → the first `record` seen in log order (raw; masked on read)
  const drops = new Map();        // id → its (first) drop record: a chat element's Delete
  let answersCount = 0;
  let migrationRec = null;
  let seqFloor = 0;
  let maxSeqSeen = 0;
  let reservedSeq = 0;
  let tornSeq = 0;
  let nextIndex = 0;
  const counts = { dupes: 0, skipped: 0, unknown: 0 };

  const push = (map, id, key, v) => {
    let m = map.get(id);
    if (!m) { m = new Map(); map.set(id, m); }
    const list = m.get(key);
    if (list) { if (!list.includes(v)) list.push(v); } else m.set(key, [v]);
  };

  // Index one record. Never redacts, never throws.
  function index(rec, i) {
    switch (rec.t) {
      case 'epoch':
        epochList.push({ boot: rec.boot, at: rec.at, pid: rec.pid, index: i });
        return;
      case 'el':
        if (typeof rec.id !== 'string' || !rec.id) { counts.skipped++; return; }
        if (elements.has(rec.id)) { counts.dupes++; return; }
        elements.set(rec.id, rec);
        return;
      case 'ver': {
        // Every version record's seq is spent, an unusable one's too.
        if (isPosInt(rec.seq) && rec.seq > maxSeqSeen) maxSeqSeen = rec.seq;
        if (typeof rec.id !== 'string' || !rec.id || !isPosInt(rec.v) || !isPosInt(rec.seq)) { counts.skipped++; return; }
        let m = versions.get(rec.id);
        if (!m) { m = new Map(); versions.set(rec.id, m); }
        if (m.has(rec.v)) { counts.dupes++; return; }
        m.set(rec.v, rec);
        verIndex.set(pinKey(rec.id, rec.v), i);
        if (!(latestV.get(rec.id) >= rec.v)) latestV.set(rec.id, rec.v);
        if (typeof rec.payload_hash === 'string') push(payloadIdx, rec.id, rec.payload_hash, rec.v);
        if (typeof rec.src_hash === 'string') push(srcIdx, rec.id, rec.src_hash, rec.v);
        let s = seqIdx.get(rec.id);
        if (!s) { s = new Map(); seqIdx.set(rec.id, s); }
        if (!(s.get(rec.seq) >= rec.v)) s.set(rec.seq, rec.v);
        return;
      }
      case 'commit':
        if (typeof rec.node !== 'string' || !rec.node || !Array.isArray(rec.pins)) { counts.skipped++; return; }
        commitList.push(rec);
        commitByNode.set(rec.node, rec);
        for (const p of rec.pins) {
          if (!parsePin(p)) continue;
          if (!home.has(p)) home.set(p, rec.node);
        }
        return;
      case 'migration':
        migrationRec = rec;
        if (Number.isSafeInteger(rec.seq_floor) && rec.seq_floor > seqFloor) seqFloor = rec.seq_floor;
        return;
      case 'close':
        if (!Array.isArray(rec.held) || !rec.held.every(isPinKey) || typeof rec.complete !== 'boolean') { counts.skipped++; return; }
        closeList.push({ index: i, boot: rec.boot ?? null, at: rec.at ?? null, held: new Set(rec.held), complete: rec.complete });
        return;
      case 'ack':
        if (!Array.isArray(rec.keys) || !rec.keys.every(isAckKey)) { counts.skipped++; return; }
        for (const k of rec.keys) ackedKeys.add(k);
        ackCount++;
        return;
      case 'drop':
        if (typeof rec.id !== 'string' || !ELEMENT_ID_RE.test(rec.id)) { counts.skipped++; return; }
        if (!drops.has(rec.id)) drops.set(rec.id, rec);
        return;
      case 'answers': {
        if (typeof rec.node !== 'string' || !rec.node || !Array.isArray(rec.items) || !rec.items.length
          || rec.items.some((it) => answerItemProblem(it) !== null)) { counts.skipped++; return; }
        let m = answersByNode.get(rec.node);
        if (!m) { m = new Map(); answersByNode.set(rec.node, m); }
        for (const it of rec.items) {
          const k = pinKey(it.id, it.v);
          m.set(k, it);
          if (it.record !== undefined && !firstRecord.has(k)) firstRecord.set(k, it.record);
        }
        answersCount++;
        return;
      }
      default:
        counts.unknown++;
    }
  }

  function load() {
    const st = log.load({ onRecord: (rec, { index: i }) => index(rec, i) });
    nextIndex = st.complete;
    tornSeq = tornSeqOf(file, { dryRun, tornBytes: st.torn ? st.torn.bytes : 0 });
    return stats();
  }

  // Append one record (already as its bytes carry it) and index it. The
  // engine's lazy epoch, when this append wrote it, is indexed first.
  function write(rec) {
    const before = log.stats().epoch_written;
    try {
      log.append(rec);
    } finally {
      if (!before && log.stats().epoch_written) {
        epochList.push({ boot: log.bootId, at: lastNow, pid: process.pid, index: nextIndex++ });
      }
    }
    index(rec, nextIndex++);
    return rec;
  }

  // ── minting ──
  const maxSeq = () => Math.max(maxSeqSeen, reservedSeq, seqFloor, tornSeq);
  const nextSeq = () => maxSeq() + 1;
  function reserveSeq(n) {
    if (!isPosInt(n)) throw new TypeError('reserveSeq: a positive integer');
    if (n > reservedSeq) reservedSeq = n;
    return nextSeq();
  }
  const nextV = (id) => Math.max(latestV.get(id) || 0, reservedV.get(id) || 0) + 1;
  function reserve(id, v) {
    if (typeof id !== 'string' || !id || !isPosInt(v)) throw new TypeError('reserve: an id and a positive integer v');
    if (!(reservedV.get(id) >= v)) reservedV.set(id, v);
    return nextV(id);
  }
  // A fresh element id, the type's letter (ID_PREFIX; PLUGIN_ID_LETTER for a
  // type a registered plug-in row names) + a seq reserved for its first
  // version. One counter for every type: c1, h2, g3, p4, c5.
  function mintId(type = 'comment') {
    const builtin = typeof type === 'string' && own(ID_PREFIX, type);
    if (!builtin && !isPluginType(type)) {
      throw new TypeError(`mintId: a type with an id letter (${Object.keys(ID_PREFIX).join(', ')}) or a registered plug-in type, not ${type}`);
    }
    const p = builtin ? ID_PREFIX[type] : PLUGIN_ID_LETTER;
    let seq = nextSeq();
    while (elements.has(`${p}${seq}`) || versions.has(`${p}${seq}`) || firstSeq.has(`${p}${seq}`)) { reserveSeq(seq); seq = nextSeq(); }
    reserveSeq(seq);
    firstSeq.set(`${p}${seq}`, seq);
    return `${p}${seq}`;
  }

  function ensureElement({ id, kind = 'comment', created_at = null } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('ensureElement: an id');
    if (elements.has(id)) return { ...elements.get(id) };
    return { ...write(jsonClean({ t: 'el', id, kind, created_at })) };
  }

  // THE ONE WRITER OF ELEMENT TEXT. The payload (exactly its schema's keys,
  // schemaRow: a comment's {text, shared, replies, anchor} as payloadOf gives
  // it; a plug-in type's declared keys under the generic bound) and every sibling field pass the redactor before the bytes land; v is
  // minted here, seq is the caller's (a migrated copy keeps its own) or
  // minted. Returns the stored (redacted) record.
  function appendVersion({
    id, payload, parent_v = null, seq, author = null, at, schema = SCHEMA,
    original = null, writer = null, provenance = null, owner = null, display = null,
  } = {}) {
    if (typeof id !== 'string' || !id) throw new TypeError('appendVersion: an id');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('appendVersion: a payload object');
    const row = schemaRow(schema);
    if (!row) {
      throw new TypeError(`appendVersion: an unknown schema ${JSON.stringify(schema)} (the schemas: ${schemaNames().join(', ')})`);
    }
    const stray = Object.keys(payload).filter((k) => !row.keys.includes(k));
    if (stray.length) throw new TypeError(`appendVersion: a ${schema} payload holds only ${row.keys.join(', ')}, not ${stray.join(', ')}`);
    if (row.check) row.check(payload);
    // THE SCHEMA MATCHES THE ID (K.2-28): a version's schema is its element's
    // type's — the type its id's letter names (typeOfId) and the kind its `el`
    // record holds — so a highlight@1 version never lands on a comment's id
    // (whose projection would read a payload with no text). A plug-in id's
    // letter names no type (PLUGIN_ID_LETTER): its type is its `el` record's
    // kind, so a plug-in row's version needs that record (ensureElement first),
    // and a p id takes a plug-in row only.
    const letterType = typeOfId(id);
    const el = elements.get(id);
    const kind = el && typeof el.kind === 'string' ? el.kind : null;
    const pluginId = isTypedId(id) && id[0] === PLUGIN_ID_LETTER;
    if ((letterType !== null && letterType !== row.type) || (kind !== null && kind !== row.type)) {
      throw Object.assign(
        new TypeError(`appendVersion: ${id} is a ${letterType !== null && letterType !== row.type ? letterType : kind}, and ${schema} is a ${row.type}'s schema`),
        { reason: 'schema-type-mismatch' },
      );
    }
    if ((pluginId && !row.plugin) || (row.plugin && kind === null)) {
      throw Object.assign(
        new TypeError(row.plugin
          ? `appendVersion: ${id} has no element record naming its type, and ${schema} is a plug-in type's schema (ensureElement({kind: '${row.type}'}) first)`
          : `appendVersion: ${id} is a plug-in element's id, and ${schema} is a built-in type's schema`),
        { reason: 'schema-type-mismatch' },
      );
    }
    const v = nextV(id);
    if (parent_v !== null && !(isPosInt(parent_v) && parent_v < v)) throw new TypeError('appendVersion: parent_v is null or an earlier v');
    let s = seq;
    if (s === undefined || s === null) s = !versions.has(id) && firstSeq.has(id) ? firstSeq.get(id) : nextSeq();
    if (!isPosInt(s)) throw new TypeError('appendVersion: seq is a positive integer');
    const raw = jsonClean(payload);
    const redacted = jsonClean(redactor.value(raw));
    const sib = {};
    for (const k of SIBLINGS) {
      const val = { original, writer, provenance, owner, display }[k];
      sib[k] = val == null ? null : jsonClean(redactor.value(jsonClean(val)));
    }
    const rec = {
      t: 'ver', id, v, parent_v, seq: s, schema,
      payload: redacted,
      payload_hash: stableHash(redacted),
      src_hash: stableHash(raw),
      ...sib,
      author: author == null ? null : jsonClean(redactor.value(author)),
      at: at ?? now(),
    };
    write(rec);
    firstSeq.delete(id);
    return jsonClean(rec);
  }

  // A committed node and the id@v of every pin it carries (node first, log after).
  function appendCommit({ node, pins } = {}) {
    if (!node || typeof node.id !== 'string' || !node.id) throw new TypeError('appendCommit: a node with an id');
    if (!Array.isArray(pins) || pins.some((p) => typeof p !== 'string')) throw new TypeError('appendCommit: pins are id@v strings');
    const rec = jsonClean({
      t: 'commit', node: node.id, parent: node.parent_id ?? null, created_at: node.created_at ?? null,
      pins: pins.slice(), digest: nodeDigest(node), at: now(),
    });
    write(rec);
    return { ...rec, pins: rec.pins.slice() };
  }

  // A graceful shutdown's mark (U352): the id@v of every live copy it held, and
  // whether it covers them all. Ids only: anything that is not an id@v string
  // is refused with a TypeError, so no text can ride it.
  function appendClose({ held, complete } = {}) {
    if (!Array.isArray(held) || !held.every(isPinKey)) throw new TypeError('appendClose: held is a list of id@v strings');
    if (typeof complete !== 'boolean') throw new TypeError('appendClose: complete is a boolean');
    const rec = jsonClean({ t: 'close', boot: log.bootId, at: now(), held: [...new Set(held)], complete });
    write(rec);
    return { ...rec, held: rec.held.slice() };
  }

  // The boot reconcile's acknowledgement (U352): '<state> <key>' strings only,
  // anything else refused with a TypeError.
  function appendAck({ keys } = {}) {
    if (!Array.isArray(keys) || !keys.length || !keys.every(isAckKey)) throw new TypeError("appendAck: keys is a non-empty list of '<state> <key>' strings");
    const rec = jsonClean({ t: 'ack', boot: log.bootId, at: now(), keys: [...new Set(keys)] });
    write(rec);
    return { ...rec, keys: rec.keys.slice() };
  }

  // The side table's record set for one committed node (2B.2, U313): its
  // changed answers, one set per commit. Each item is checked
  // (answerItemProblem: the resolver's three states, codes, hashes, words) and
  // must name a version this log holds; a malformed one refuses the whole set
  // with a TypeError, so nothing half-lands. `record` — the only text an item
  // carries — passes the injected redactor BEFORE the bytes land, as a
  // version's payload does; the first set in log order that carries a
  // record for an id@v is the one recordOf reads (never a new version).
  function appendAnswers({ node, items } = {}) {
    if (typeof node !== 'string' || !node) throw new TypeError('appendAnswers: a node id');
    if (!Array.isArray(items) || !items.length || items.length > ANSWER_ITEMS_MAX) {
      throw new TypeError(`appendAnswers: items is a non-empty list of at most ${ANSWER_ITEMS_MAX} answers`);
    }
    const seen = new Set();
    const out = items.map((raw, i) => {
      const it = jsonClean(raw);
      const why = answerItemProblem(it);
      if (why) throw Object.assign(new TypeError(`appendAnswers: item ${i} is malformed (${why})`), { reason: 'malformed-answer' });
      const k = pinKey(it.id, it.v);
      if (!stored(it.id, it.v)) throw Object.assign(new TypeError(`appendAnswers: the log holds no version ${k}`), { reason: 'unknown-version' });
      if (seen.has(k)) throw Object.assign(new TypeError(`appendAnswers: ${k} twice in one set`), { reason: 'duplicate-answer' });
      seen.add(k);
      if (it.record !== undefined) it.record = jsonClean(redactor.value(it.record));
      return it;
    });
    const rec = { t: 'answers', node, at: now(), items: out };
    write(rec);
    return jsonClean(rec);
  }

  // A chat element's own Delete (U415; RULED R5-confirm = a): {t: 'drop', id,
  // at, writer?, provenance?} through the one writer — ids and stamps only,
  // never text (writer and provenance pass the redactor as a version's
  // siblings do). The id must be one the log holds; a second drop of an id
  // appends nothing and answers the first. Which family may be dropped is the
  // store's question (domain/elements dropElement), not the log's.
  function appendDrop({ id, at, writer = null, provenance = null } = {}) {
    if (typeof id !== 'string' || !ELEMENT_ID_RE.test(id)) throw new TypeError('appendDrop: an element id');
    if (!elements.has(id) && !versions.has(id)) throw Object.assign(new TypeError(`appendDrop: the log holds no element ${id}`), { reason: 'unknown-element' });
    if (drops.has(id)) return jsonClean(drops.get(id));
    const rec = { t: 'drop', id, at: at ?? now() };
    if (writer != null) rec.writer = jsonClean(redactor.value(jsonClean(writer)));
    if (provenance != null) rec.provenance = jsonClean(redactor.value(jsonClean(provenance)));
    write(jsonClean(rec));
    return jsonClean(rec);
  }

  // The v3→v4 migration's mark: its seq_floor keeps every seq a copy held
  // below the next one minted.
  function appendMigration({ from = 3, to = 4, seq_floor = 0, ...counts_ } = {}) {
    if (!Number.isSafeInteger(seq_floor) || seq_floor < 0) throw new TypeError('appendMigration: seq_floor is a non-negative integer');
    const rec = jsonClean({ ...counts_, t: 'migration', from, to, at: now(), seq_floor });
    write(rec);
    return { ...rec };
  }

  // ── reading ──
  const rv = (x) => (x == null ? x : redactor.value(x));
  // The record with its text (payload, sibling fields, author) through the
  // redactor NOW: a value learned after the write is masked; the bytes are not
  // rewritten.
  const rawOf = new WeakMap(); // view → raw record
  function maskView(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const r = rawOf.get(rec) || rec;
    if (r.t !== 'ver') return jsonClean(r);
    const out = { ...r, payload: rv(r.payload), author: rv(r.author) };
    for (const k of SIBLINGS) out[k] = rv(r[k]);
    return out;
  }
  // A lazy masking view of a stored version: its plain fields as stored, its
  // text through the redactor at each read (so a caller after v, seq or a hash
  // pays nothing for the text). One view per record, kept.
  const views = new WeakMap();
  function view(r) {
    if (!r) return null;
    let o = views.get(r);
    if (!o) {
      o = {};
      for (const k of Object.keys(r)) {
        if (k === 'payload' || k === 'author' || SIBLINGS.includes(k)) {
          Object.defineProperty(o, k, { get: () => rv(r[k]), enumerable: true });
        } else {
          o[k] = r[k];
        }
      }
      Object.freeze(o);
      views.set(r, o);
      rawOf.set(o, r);
    }
    return o;
  }
  const stored = (id, v) => (versions.get(id) || new Map()).get(v) || null;
  const version = (id, v) => view(stored(id, v));
  const versionsOf = (id) => [...(versions.get(id) || new Map()).values()].sort((a, b) => a.v - b.v).map(view);
  const latest = (id) => (latestV.has(id) ? view(stored(id, latestV.get(id))) : null);
  function byHash(id, h) {
    const out = new Set([...(((payloadIdx.get(id) || new Map()).get(h)) || []), ...(((srcIdx.get(id) || new Map()).get(h)) || [])]);
    return [...out].sort((a, b) => a - b);
  }
  // The newest v of `id` carrying `seq` (a migrated element's copies may share
  // one seq; a reader still checks the hash before trusting it), or null.
  const bySeq = (id, seq) => ((seqIdx.get(id) || new Map()).get(seq) ?? null);
  const homeOf = (id, v) => home.get(pinKey(id, v)) ?? null;
  const copyCommit = (c) => (c ? { ...c, pins: c.pins.slice() } : null);
  const commitOf = (nodeId) => copyCommit(commitByNode.get(nodeId));
  const pinsOf = (nodeId) => (commitByNode.has(nodeId) ? commitByNode.get(nodeId).pins.slice() : null);
  const commits = () => commitList.map(copyCommit);
  const epochs = () => epochList.map((e) => ({ ...e }));
  const migration = () => (migrationRec ? jsonClean(migrationRec) : null);
  const element = (id) => (elements.has(id) ? { ...elements.get(id) } : null);
  const ids = () => [...new Set([...elements.keys(), ...versions.keys()])];
  // The record index of id@v's version record (log order across reopens), or null.
  const indexOf = (id, v) => verIndex.get(pinKey(id, v)) ?? null;
  // Every close, in log order: {index, boot, at, held: a Set of id@v (a copy), complete}.
  const closes = () => closeList.map((c) => ({ ...c, held: new Set(c.held) }));
  // Every '<state> <key>' an ack names (a copy).
  const acked = () => new Set(ackedKeys);
  // The side table's reads (U313). answersOf(node) → the items the node's
  // record set(s) hold, in the order they were first written, each a copy
  // whose `record` passes the redactor NOW (as version() masks a payload: a
  // value learned after the write is masked, the bytes never rewritten);
  // recordOf(id, v) → the first record kept for id@v, masked the same way, or
  // null.
  function answersOf(nodeId) {
    const m = answersByNode.get(nodeId);
    if (!m) return [];
    return [...m.values()].map((it) => {
      const c = jsonClean(it);
      if (it.record !== undefined) c.record = rv(c.record);
      return c;
    });
  }
  // Has the element been dropped (a chat element's Delete)? → its drop record
  // (a copy: ids and stamps), or null.
  const dropped = (id) => (drops.has(id) ? jsonClean(drops.get(id)) : null);
  const recordOf = (id, v) => {
    const k = pinKey(id, v);
    return firstRecord.has(k) ? rv(jsonClean(firstRecord.get(k))) : null;
  };

  function stats() {
    let nVersions = 0;
    for (const m of versions.values()) nVersions += m.size;
    return {
      ...log.stats(),
      elements: elements.size,
      versions: nVersions,
      commits: commitList.length,
      epochs: epochList.length,
      migration: !!migrationRec,
      closes: closeList.length,
      acks: ackCount,
      answers: answersCount,
      drops: drops.size,
      max_seq: maxSeq(),
      next_seq: nextSeq(),
      torn_seq: tornSeq,
      dupes: counts.dupes,
      skipped: counts.skipped,
      unknown: counts.unknown,
    };
  }

  return {
    file, dryRun, bootId: log.bootId,
    load, close: () => log.close(), stats,
    ensureElement, appendVersion, appendCommit, appendClose, appendAck, appendMigration, appendAnswers, appendDrop,
    nextSeq, reserveSeq, nextV, reserve, mintId,
    version, versionsOf, latest, byHash, bySeq, homeOf, commitOf, pinsOf, commits, epochs, migration,
    maxSeq, element, ids, maskView, indexOf, closes, acked, answersOf, recordOf, dropped,
  };
}

module.exports = {
  createElementLog,
  SCHEMA,
  SCHEMAS,
  PAYLOAD_KEYS,
  CHAIN_SCHEMA,
  CHAIN_MAX,
  commentSchemaOf,
  CHAT_ANCHOR_TABLE,
  CHAT_QUOTE_MAX,
  CHAT_CONTEXT_MAX,
  CHAT_LABEL_MAX,
  CHAT_REPLY_AUTHORS,
  chatAnchorProblem,
  checkChatPayload,
  ID_PREFIX,
  typeOfId,
  PLUGIN_ID_LETTER,
  isTypedId,
  registerSchema,
  schemaRow,
  schemaNames,
  isPluginType,
  payloadDeclProblem,
  PLUGIN_STRING_MAX,
  PLUGIN_ARRAY_MAX,
  PLUGIN_TUPLE_MAX,
  PLUGIN_PAYLOAD_MAX,
  PLUGIN_META_MAX,
  PLUGIN_KEYS_MAX,
  PLUGIN_KEY_RE,
  PLUGIN_META_KEY,
  PLUGIN_REQUIRED_KEYS,
  isEngineRecord,
  CONVERTED,
  SIBLINGS,
  convertAnchor,
  payloadOf,
  copyMatches,
  nodeDigest,
  parsePin,
  pinMapOf,
  parkB2,
  parkMetrics,
  parkHash,
  replyKey,
  ancestryIndex,
  isGraphNode,
  maxElementSeqIn,
  maxPinSeqIn,
  isPinKey,
  isAckKey,
  isAnswerCode,
  answerItemProblem,
  ANSWER_STATES,
};

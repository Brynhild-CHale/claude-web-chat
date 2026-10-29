'use strict';
// The daemon's element store — a thin binding of lib/core/element-log (the
// record layer: the log, its indexes, the one redacted version writer, the
// hashes, minting) to the daemon's live state and graph (PLAN 1A.2, 1A.3, 1A.5).
//
// createServer builds ONE store per boot, hangs it on the graph
// (`graph.elements`, as graph.mirror and graph.redactText hang there, so the
// route ctx keeps its keys) BEFORE graph.load, and every commit, restore and
// boot reaches it through that object, never a captured reference.
//
// WHAT IT DOES
//
//   add / edit / reply   append a version through the log's one writer and
//                        answer the PIN PROJECTION (below) built from the
//                        redacted payload: a secret typed into a comment shows
//                        masked to its own author (the settled default).
//   appendCommit(node)   NODE FIRST, LOG AFTER: called by domain/turns
//                        commitNode once graph.writeNode has written the node.
//                        Every copy the node carries is mapped to a version
//                        (its own hash-checked `v`; else the version the live
//                        pin names, its seq's, a hash match; else a version
//                        appended FROM THE COPY, carrying the copy's own seq,
//                        D18), then ONE commit record names them all, and the
//                        live pins that match are stamped with their `v`. The
//                        node file is never touched: its copies stay as they
//                        were written, and the record's digest is the file's.
//   adopt(node)          the same, for a node with no commit record (U209's
//                        boot reconcile); no live pin is stamped.
//   attachLive(pins, …)  ONLY ADDS `v` to live pins (D16): after a restore and
//                        after the draft is loaded. A pin's own `v` is trusted
//                        only when the hash checks; else the node's commit
//                        record, the pin's seq, a hash match, or an uncommitted
//                        version minted from the pin (reused by hash later, so
//                        repeated restores append nothing). A pin's text is
//                        never rewritten: node history is immutable. A mint
//                        that cannot be written leaves the pin without v
//                        (counted as attach_failures; a filesystem refusal
//                        makes the store read-only for the rest of the boot),
//                        so boot and Set active never fail on the log.
//   reanchor(pin, …)     a comment's new anchor version (U325: PATCH
//                        /api/elements/:id {anchor}), its `original` null.
//   addElement / editElement / record / liveRecords / typeOf   the other
//                        types (U325; E-STORE a): a highlight's or a box
//                        grab's version under its own schema (a typed mint,
//                        `el` kind = the type), and THE RECORD (below
//                        project) the element API serves; the surface holds
//                        only the id@v reference (domain/element-refs).
//   THE FAMILY SWITCH (DECISIONS C1, D5; tranche 3, U415). familyOf(type) —
//                        the element-type registry's descriptor when one is
//                        bound, else lib/core/element-policy's row, else
//                        'page'. A CHAT element (the built-in chat-comment)
//                        is one line of versions in the log and nothing
//                        else: addElement writes the log only (as for every
//                        type) and its caller never puts a reference on the
//                        surface, so it is in no commit record, node, draft,
//                        preview, export or replay; a page Wipe, a bulk clear
//                        and New graph (which read state.elements alone) never
//                        remove one. chatRecords(type?) → every live chat
//                        element at its newest version (masked at read);
//                        liveRecords answers it for a chat type, so the
//                        `element:<type>` frame carries them. An edit or a
//                        reply must stand on the newest version (else
//                        {code: 'STALE'}), so every version's parent_v is the
//                        newest before it; replyElement appends a thread
//                        reply; dropElement is its own Delete (the log's drop
//                        record; a dropped element is in no read).
//   noteGracefulClose({live, draftWritten})   a graceful shutdown's close
//                        record (U352; DECISIONS F-DEL c), called once by
//                        runShutdown after the draft: the id@v of every live
//                        copy (heldCopies), complete when the draft was written
//                        (or there was nothing to hold) and every live copy
//                        carried a v. Appended only when this boot appended
//                        anything or restored a draft holding a version, so an
//                        idle boot appends nothing at its stop.
//   acknowledge(keys)    the boot reconcile's ack record ('<state> <key>'), so a
//                        persistent state is reported once, then acknowledged.
//   Both carry ids and keys only, never text; both answer null and write
//   nothing when the store is read-only, and a filesystem refusal counts, logs
//   once and leaves the store read-only, as any append does. Neither ever
//   throws: a shutdown and a boot never fail on them.
//
// THE PIN PROJECTION (ruling A2) of version v of element id, over v's
// parent_v chain (the versions this pin descends from, v1 at its root):
//   {id, seq, created_at, shared, text, anchor, replies?, v, writer?,
//    provenance?, edited?}
//   seq          v's seq (the API's pin.seq and the comment cursor)
//   anchor       the engine record when the version's payload holds one (a
//                pin the chrome dropped, or one re-anchored), the 0.8.5
//                locator (the version's `original` sibling) riding beside it
//                as `locator`; else the original locator. public/app/
//                comments.js draws from the record
//   writer, provenance   v1's pair
//   edited       {writer, provenance, at} of the newest version in the chain
//                whose text or shared differs from its own parent's (the
//                newest edit, never a reply carrying it); absent when none
//                does
//   replies[i]   {author, at, text} plus writer/provenance of the version that
//                appended reply i (the first in the chain to carry it)
// The stamps are sibling fields of the versions, outside both hashes (F3).
//
// READ-ONLY. A refused v3→v4 migration (`migration.refused`, U204) leaves the
// log untrustworthy: add/edit/reply throw {code: 'READ_ONLY'} (the routes
// answer 503, D15) and the store writes nothing at all. So does a store whose
// log could not be opened for writing (another open in this process: the
// one-writer rule of lib/core/applog), and so does one whose append the
// filesystem refused (reason 'log-unwritable'); both are reported in stats().

const {
  createElementLog, payloadOf, isPinKey, pinMapOf, parsePin, isEngineRecord, SCHEMAS, SCHEMA, commentSchemaOf,
  CHAT_CONTEXT_MAX,
} = require('../../core/element-log');
const { marksIn, markAt } = require('../../core/redact');
const { stableHash, stableKey } = require('../../core/stable-json');
const { BUILTIN_ELEMENT_TYPES } = require('../../core/element-policy');
const { readJson } = require('../../core/fsjson');
const { refsOf, refOf } = require('./element-refs');

// The comment type's name, read off the schema table (no literal).
const COMMENT_TYPE = SCHEMAS[SCHEMA].type;
// The chat family's name (element-policy ELEMENT_FAMILIES) and the families
// of the built-in types (element-policy's rows: the fallback when no registry
// is bound, or it does not list the type).
const CHAT_FAMILY = 'chat';
const BUILTIN_FAMILY = new Map(BUILTIN_ELEMENT_TYPES.map((d) => [d.type, d.family]));
// A reply's authors (the comment's rule).
const REPLY_AUTHORS = Object.freeze(['user', 'claude']);

// A type's schema in the log's table (U326's SCHEMAS: comment@1, highlight@1,
// box-grab@1), or null for a type the log has no row for.
function schemaForType(type) {
  return Object.keys(SCHEMAS).find((s) => SCHEMAS[s].type === type) || null;
}

const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const has = (o, k) => o != null && o[k] != null;

// THE ONE READER of what a live snapshot (graph.snapshotLive) or a draft holds
// (U352; DECISIONS K.2 item 4): the id@v of every comment copy that carries a
// positive-integer v, then every entry of `elements` (the E-STORE field, A2 = a:
// state.elements' id@v strings) that passes the log's id@v check (isPinKey), a
// malformed one skipped; each once, in that order. The close record's `held`
// and the boot reconcile's draft-held set both read through it, so the two never
// disagree, and no later unit edits it (the highlight and box-grab writers fill
// `elements`; this already reads it).
function heldCopies(value) {
  const out = [];
  const seen = new Set();
  const keep = (k) => { if (isPinKey(k) && !seen.has(k)) { seen.add(k); out.push(k); } };
  const v = value && typeof value === 'object' ? value : {};
  for (const c of (Array.isArray(v.comments) ? v.comments : [])) {
    if (c && typeof c === 'object' && typeof c.id === 'string' && c.id !== '' && isPosInt(c.v)) keep(`${c.id}@${c.v}`);
  }
  for (const e of (Array.isArray(v.elements) ? v.elements : [])) keep(e);
  return out;
}

// THE CHAIN'S PRIVATE RULE (F.6; ruling Q8 a, U406a): the ids of a comment's
// `chain` members that are private NOW — the ONE answer to "is this chain
// member private", read by the element route (an event's ids-only
// `chain_private`, a write's answered pin) and by domain/comments
// emitComments (the ids the element:comment frame carries under remote-policy
// CHAIN_PRIVATE, so a viewer that does not see private records gets each such
// member null, whatever its type and whether it still exists). A member on the
// live surface answers by its own flag: a pin of state.comments by its
// `shared`, a reference by its version's record (one the log cannot read is
// private: fail closed); a member no longer on the surface is private when
// its newest version is. `store` is the element store (its `record` and
// `latest`); omitted, the store createElementStore bound to `state` answers,
// and with none a reference is private and a gone member is not.
const CHAIN_STORES = new WeakMap();
function chainPrivate(state, pin, store = isObjLike(state) ? CHAIN_STORES.get(state) || null : null) {
  const out = [];
  const pins = isObjLike(state) && Array.isArray(state.comments) ? state.comments : [];
  for (const id of Array.isArray(pin && pin.chain) ? pin.chain : []) {
    const live = pins.find((c) => c && c.id === id);
    let hidden;
    if (live) hidden = live.shared === false;
    else {
      const held = isObjLike(state) ? refOf(state, id) : null;
      if (held) {
        let rec = null;
        try { rec = store ? store.record(held.id, held.v) : null; } catch { rec = null; }
        hidden = !rec || rec.shared === false;
      } else {
        let rec = null;
        try { rec = store ? store.latest(id) : null; } catch { rec = null; }
        hidden = !!(rec && rec.payload && rec.payload.shared === false);
      }
    }
    if (hidden) out.push(id);
  }
  return out;
}
function isObjLike(o) { return !!o && typeof o === 'object'; }

// ── the context mask (U415a; DECISIONS K.2-164, D4, GT-13) ──
// A quote's prefix and suffix are cut out of a longer text (anchors.js
// quoteOf: CONFIG.ctx_n characters each side, element-log's
// CHAT_CONTEXT_MAX), so a value the redactor learns after the write can sit
// across one of their edges, where a pass over the field alone sees only a
// fragment of it and masks nothing. The read view masks those fragments too
// — the stored bytes are never rewritten, the quote keeps its shape and the
// redactor's rules are its own:
//   1. each field through the redactor (a log view has done this already; a
//      live pin's anchor has it here);
//   2. the window prefix + exact + suffix through the redactor whole: a mask
//      it adds that reaches into the prefix cuts the prefix at its first new
//      mask, one that reaches into the suffix cuts the suffix through its
//      last, and that mask is spelled where the cut is;
//   3. an edge no pass can see across — a cut prefix's outer edge (the value
//      began before the window), and the suffix's inner edge when the token it
//      continues already holds a mark (the value's head masked in the field
//      before it) — drops its leading run of CONTEXT_RUN_MIN or more
//      characters (up to a space or a mark), as redactWindow drops a window's
//      cut edge. The redactor keeps its values in its closure, so the view
//      cannot ask whether that run is a learned value's tail: it drops any run
//      long enough to hold a fragment the redactor would mask.
// A prefix counts as cut when it is CONTEXT_N characters long or holds a mark
// (a mask changes its length). A quote with neither context is returned as it
// came, past step 1.
const CONTEXT_N = CHAT_CONTEXT_MAX;
// The redactor's KNOWN_MIN: no shorter value is registered, and its tail check
// masks no shorter head.
const CONTEXT_RUN_MIN = 8;

// The length of `t`'s leading run: up to its first space or mark.
function leadingRun(t) {
  const sp = t.search(/\s/);
  let end = sp < 0 ? t.length : sp;
  const first = marksIn(t)[0];
  if (first && first.start < end) end = first.start;
  return end;
}

// Whether a mark of `t` touches its trailing run (ends inside it or right
// before it).
function markTouchesEnd(t) {
  const runStart = t.search(/\S*$/);
  return marksIn(t).some((m) => m.end >= runStart);
}

// maskQuoteContext(quote, redact, {masked}) → the quote {exact, prefix,
// suffix, …} as the read view serves it (steps 1–3 above); `redact` is a
// string → string redaction (the daemon's redactor.text); `masked` says the
// fields already passed it (a log view's), so step 1 is skipped. Every other
// key rides unchanged.
function maskQuoteContext(quote, redact, { masked = false } = {}) {
  if (!isObjLike(quote) || Array.isArray(quote)) return quote;
  const out = { ...quote };
  if (!masked) for (const k of ['exact', 'prefix', 'suffix']) if (typeof quote[k] === 'string') out[k] = redact(quote[k]);
  const hasP = typeof out.prefix === 'string' && out.prefix.length > 0;
  const hasS = typeof out.suffix === 'string' && out.suffix.length > 0;
  if (!hasP && !hasS) return out;
  const p = hasP ? out.prefix : '';
  const e = typeof out.exact === 'string' ? out.exact : '';
  const s = hasS ? out.suffix : '';
  let prefix = p;
  let suffix = s;
  const whole = p + e + s;
  const seen = redact(whole);
  if (seen !== whole) {
    let i = 0;
    while (i < p.length && whole[i] === seen[i]) i++;
    if (i < p.length) {
      const n = markAt(seen, i);
      prefix = p.slice(0, i) + (n ? seen.slice(i, i + n) : '');
    }
    let c = 0;
    while (c < s.length && whole[whole.length - 1 - c] === seen[seen.length - 1 - c]) c++;
    if (c < s.length) {
      const end = seen.length - c;
      const m = marksIn(seen).find((x) => x.end === end);
      suffix = (m ? seen.slice(m.start, m.end) : '') + s.slice(s.length - c);
    }
  }
  if (prefix && (p.length >= CONTEXT_N || marksIn(p).length)) {
    const n = leadingRun(prefix);
    if (n >= CONTEXT_RUN_MIN) prefix = prefix.slice(n);
  }
  if (suffix && markTouchesEnd(p + e)) {
    const n = leadingRun(suffix);
    if (n >= CONTEXT_RUN_MIN) suffix = suffix.slice(n);
  }
  if (hasP) out.prefix = prefix;
  if (hasS) out.suffix = suffix;
  return out;
}

// An anchor as the read view serves it: its quote through maskQuoteContext.
function maskAnchorContext(anchor, redact, opts) {
  if (!isObjLike(anchor) || Array.isArray(anchor) || !isObjLike(anchor.quote)) return anchor;
  return { ...anchor, quote: maskQuoteContext(anchor.quote, redact, opts) };
}

function readOnlyError(reason) {
  return Object.assign(new Error(`the comment log is read-only (${reason})`), { code: 'READ_ONLY', reason });
}

// `bus` is taken for U209's integrity event (the reconcile announces on it);
// nothing here emits. `now` is a test seam (the log's clock).
// `elementTypes` (optional): the element-type registry (lib/server/
// element-types) whose descriptor's family familyOf reads; absent, graph.
// elementTypes is read when set, else element-policy's rows answer.
function createElementStore({
  paths, state, graph, redactor, bus = null, bootId, migration = null, now = Date.now, elementTypes = null,
} = {}) {
  void bus;
  if (!paths || !paths.elementsLog) throw new TypeError('createElementStore: paths (lib/core/paths projectPaths) with elementsLog');
  let unavailable = null;
  let log;
  // How long the boot's log load took (stats().load_ms, the boot report's
  // timings.log_load_ms: U209).
  const loadStarted = Date.now();
  try {
    log = createElementLog({ file: paths.elementsLog, redactor, bootId, now });
    log.load();
  } catch (e) {
    if (log) { try { log.close(); } catch {} }
    // The log cannot be written by this store (another writer holds it in this
    // process, or it cannot be read): read it as a dry run, so the reads still
    // answer, and write nothing.
    unavailable = (e && e.code) || (e && e.message) || 'unopenable';
    console.error(`[web-chat] the element log is not writable (${unavailable}); comments are read-only this boot`);
    log = createElementLog({ file: paths.elementsLog, redactor, bootId, now, dryRun: true });
    log.load();
  }
  const loadMs = Date.now() - loadStarted;

  const refused = !!(migration && migration.refused);
  let readOnly = refused || unavailable != null;
  let readOnlyReason = refused ? 'migration-refused' : unavailable != null ? 'log-unavailable' : null;
  // A comment write (attachLive's mint, add, edit, reply) the log refused at
  // the filesystem (an fs error code: EACCES on a folder nothing may write
  // into, ENOSPC, EROFS, a torn tail) leaves the rest of this boot read-only,
  // as an unopenable log does: comments are served as the node holds them and
  // nothing else is attempted. A TypeError or an UNMAPPED pin (no errno-like
  // code) does not. A failed commit-record append only counts (noteAppendFailure): the
  // commit path keeps trying, and the next boot adopts what it missed.
  function noteUnwritable(e) {
    if (readOnly || !e || typeof e.code !== 'string' || !/^E[A-Z0-9]+$/.test(e.code)) return;
    readOnly = true;
    readOnlyReason = 'log-unwritable';
    unavailable = e.code;
  }

  const counts = {
    append_failures: 0,
    adopted_versions: 0,
    attached: 0,
    minted_on_attach: 0,
    unmapped_copies: 0,
    commits_skipped_read_only: 0,
    attach_failures: 0,
    close_failures: 0,
    ack_failures: 0,
    element_refs_skipped: 0,
    chat_refs_skipped: 0,
  };
  let attachFailureLogged = false;
  // How many pins attachLive({draft: true}) left holding a version when a draft
  // restored: one that held a version makes this boot's graceful stop append a
  // close (U352).
  let draftVersions = 0;
  const appendFailureLogged = { close: false, ack: false };
  // copy-v-mismatch (U209's state): a copy whose `v` (or the v its node's
  // commit record names) does not hold its payload. One entry per
  // (node, id@v), so a repeated restore does not count it again.
  const mismatches = new Set();
  let integrityReport = null;

  function guardWrite() {
    if (readOnly) throw readOnlyError(readOnlyReason);
  }
  // add / edit / reply: a filesystem refusal answers READ_ONLY (and stays so).
  function writing(fn) {
    guardWrite();
    try {
      return fn();
    } catch (e) {
      noteUnwritable(e);
      if (readOnly) throw readOnlyError(readOnlyReason);
      throw e;
    }
  }

  // ── matching a copy to a version ──
  function hashOf(copy) {
    try { return stableHash(payloadOf(copy)); } catch { return null; }
  }
  function holds(id, v, h) {
    if (!isPosInt(v) || h == null) return false;
    const rec = log.version(id, v);
    return !!rec && (h === rec.payload_hash || h === rec.src_hash);
  }
  const nodePins = (nodeId) => pinMapOf(nodeId ? log.pinsOf(nodeId) : null);
  const validCopy = (c) => !!c && typeof c === 'object' && typeof c.id === 'string' && c.id !== '';

  // The version a copy holds, or one appended from it. `own` trusts the copy's
  // own v (hash-checked); `prefer` are further candidates in order; `parentV`
  // is the version the parent's (or base's) commit record pins, preferred
  // among hash matches and the parent of a minted version. `where` names the
  // node for the mismatch count. Answers {v, minted} or null (an unmappable
  // copy, or a read-only store with nothing to match).
  function resolveCopy(copy, { prefer = [], parentV = null, where = null } = {}) {
    if (!validCopy(copy)) { counts.unmapped_copies++; return null; }
    const id = copy.id;
    const h = hashOf(copy);
    if (h == null) { counts.unmapped_copies++; return null; }
    if (copy.v != null) {
      if (holds(id, copy.v, h)) return { v: copy.v, minted: false };
      mismatches.add(`${where || '-'}:${id}@${copy.v}`);
    }
    for (const v of prefer) if (holds(id, v, h)) return { v, minted: false };
    const s = isPosInt(copy.seq) ? log.bySeq(id, copy.seq) : null;
    if (holds(id, s, h)) return { v: s, minted: false };
    const hits = log.byHash(id, h);
    if (hits.length) return { v: hits.includes(parentV) ? parentV : hits[hits.length - 1], minted: false };
    if (readOnly) return null;
    log.ensureElement({ id, kind: 'comment', created_at: Number.isFinite(copy.created_at) ? copy.created_at : null });
    const pv = isPosInt(parentV) && parentV < log.nextV(id) && log.version(id, parentV) ? parentV : null;
    // A copy that holds a chain mints under the chained schema (F.6).
    const payload = payloadOf(copy);
    const rec = log.appendVersion({
      id,
      schema: commentSchemaOf(payload),
      payload,
      parent_v: pv,
      seq: isPosInt(copy.seq) ? copy.seq : undefined,
      original: copy.locator ?? copy.anchor ?? null,
      writer: copy.writer ?? null,
      provenance: copy.provenance ?? null,
    });
    return { v: rec.v, minted: true };
  }

  // ── the pin projection ──
  // v's chain, oldest first: v1 (the chain's root) … v.
  function chainOf(id, v) {
    const out = [];
    const seen = new Set();
    let cur = log.version(id, v);
    while (cur && !seen.has(cur.v)) {
      seen.add(cur.v);
      out.unshift(cur);
      cur = isPosInt(cur.parent_v) ? log.version(id, cur.parent_v) : null;
    }
    return out;
  }
  const stamp = (rec, o) => {
    const w = rec.writer; const p = rec.provenance;
    if (w != null) o.writer = w;
    if (p != null) o.provenance = p;
    return o;
  };
  function project(id, v) {
    const chain = chainOf(id, v);
    if (!chain.length) return null;
    const rec = chain[chain.length - 1];
    const root = chain[0];
    const payload = rec.payload || {};
    const el = log.element(id);
    // The pin's anchor is what its copies hash as (payloadOf): the engine
    // record when the payload holds one (U325: a comment written through the
    // element API, or re-anchored), else the original locator. A legacy
    // locator the chrome sent beside an engine record rides as `locator`,
    // outside the hashes like every key payloadOf does not read.
    const pa = payload.anchor ?? null;
    const engine = isEngineRecord(pa);
    const pin = {
      id,
      seq: rec.seq,
      created_at: el && el.created_at != null ? el.created_at : root.at,
      shared: payload.shared,
      text: payload.text,
      anchor: engine ? pa : (rec.original != null ? rec.original : pa),
    };
    if (engine && rec.original != null && stableKey(rec.original) !== stableKey(pa)) pin.locator = rec.original;
    // The comment's chain (F.6, comment@2): the ids of the elements under the
    // press when it was made, smallest first — a copy, and only when the
    // version holds one, so a chainless pin's projection is unchanged.
    if (Array.isArray(payload.chain) && payload.chain.length) pin.chain = payload.chain.slice();
    const thread = threadFields(chain, payload);
    if (thread.replies.length) pin.replies = thread.replies;
    pin.v = rec.v;
    stamp(root, pin);
    if (thread.edited) pin.edited = thread.edited;
    return pin;
  }

  // THE THREAD'S RULES (the comment's; project() and record() for a threaded
  // schema, the chat comment's, both read them here): `replies` — each reply
  // of the payload with the stamps of the version that appended it (the first
  // in the chain to carry it); `edited` — {writer, provenance, at} of the
  // newest version whose text or shared differs from its own parent's, i.e.
  // the newest EDIT (ruling U203@edited-reading): a reply appended after an
  // edit carries the edited text forward but did not write it, so it never
  // becomes the editor (U214c's live pins record `edited` on an edit only);
  // null when none does. `chain` is the version's parent chain, oldest first.
  function threadFields(chain, payload) {
    const list = Array.isArray(payload && payload.replies) ? payload.replies : [];
    const sizes = chain.map((c) => (Array.isArray((c.payload || {}).replies) ? c.payload.replies.length : 0));
    const replies = list.map((r, i) => {
      const k = sizes.findIndex((n) => n > i);
      return k >= 0 ? stamp(chain[k], { ...r }) : { ...r };
    });
    let edited = null;
    for (let k = chain.length - 1; k > 0; k--) {
      const a = chain[k].payload || {}; const b = chain[k - 1].payload || {};
      if (a.text !== b.text || a.shared !== b.shared) {
        edited = { writer: chain[k].writer ?? null, provenance: chain[k].provenance ?? null, at: chain[k].at };
        break;
      }
    }
    return { replies, edited };
  }

  // ── writes ──
  function add(args = {}) { return writing(() => addNow(args)); }
  // `locator` (U325): the legacy locator the chrome sends beside an engine
  // record, kept as the version's `original` sibling (the engine record is
  // the payload's anchor). Beside any other anchor it is ignored: the
  // original is the anchor itself, as before.
  // `chain` (F.6): the ids of the live elements under the press, smallest
  // first; a non-empty one makes the comment a comment@2 version, anything
  // else a comment@1 one as before (which bounds a rollback's exposure to the
  // chained comments). The ids are checked by the schema row before an id is
  // minted, so a refused chain spends nothing.
  function addNow({ text = '', shared = true, anchor = null, locator = null, chain = null, author = null, writer = null, provenance = null } = {}) {
    const at = now();
    const anc = anchor && typeof anchor === 'object' ? anchor : null;
    const loc = locator && typeof locator === 'object' && !Array.isArray(locator) ? locator : null;
    const payload = payloadOf({ text: String(text), shared: shared !== false, replies: [], anchor: anc, chain });
    const schema = commentSchemaOf(payload);
    if (SCHEMAS[schema].check) SCHEMAS[schema].check(payload);
    const id = log.mintId(COMMENT_TYPE);
    log.ensureElement({ id, kind: COMMENT_TYPE, created_at: at });
    const original = isEngineRecord(anc) && loc ? loc : anc;
    const rec = log.appendVersion({ id, schema, payload, author, writer, provenance, original, at });
    return project(id, rec.v);
  }

  // The version a live pin stands on: its own (hash-checked), else matched or
  // minted as attachLive would.
  function baseOf(pin) {
    const r = resolveCopy(pin, { parentV: nodePins(graph && graph.active).get(pin.id) ?? null, where: 'live' });
    if (!r) throw Object.assign(new Error('the pin cannot be mapped to a version'), { code: 'UNMAPPED' });
    return r.v;
  }

  // The context mask's redaction (maskQuoteContext): a string through the
  // redactor now (its text form; value's for a redactor that has no other).
  const contextRedact = (t) => (typeof redactor.text === 'function' ? redactor.text(t) : redactor.value(t));
  // A version as the store hands it out (version(id, v)): the log's masking
  // view, its payload's anchor quote through the context mask, every other
  // field the view's own (v, seq and the hashes read as stored). Lazy, as the
  // log's view is, and one per view, kept.
  const servedViews = new WeakMap();
  function servedVersion(rec) {
    if (!isObjLike(rec)) return rec;
    let o = servedViews.get(rec);
    if (!o) {
      o = {};
      for (const k of Object.keys(rec)) {
        const get = k === 'payload'
          ? () => {
            const pl = rec.payload;
            return isObjLike(pl) && !Array.isArray(pl) && isObjLike(pl.anchor)
              ? { ...pl, anchor: maskAnchorContext(pl.anchor, contextRedact, { masked: true }) }
              : pl;
          }
          : () => rec[k];
        Object.defineProperty(o, k, { get, enumerable: true });
      }
      Object.freeze(o);
      servedViews.set(rec, o);
    }
    return o;
  }
  function redactedHash(payload) {
    return stableHash(JSON.parse(JSON.stringify(redactor.value(JSON.parse(JSON.stringify(payload))))));
  }

  function edit(pin, args = {}) { return writing(() => editNow(pin, args)); }
  function editNow(pin, { text, shared, writer = null, provenance = null } = {}) {
    const v = baseOf(pin);
    const next = {
      ...pin,
      text: text !== undefined ? String(text) : pin.text,
      shared: shared !== undefined ? !!shared : pin.shared,
    };
    const payload = payloadOf(next);
    if (redactedHash(payload) === log.version(pin.id, v).payload_hash) {
      return { pin: pin.v === v ? pin : { ...pin, v }, unchanged: true };
    }
    // The chain is the relation recorded at creation: an edit keeps it.
    const rec = log.appendVersion({ id: pin.id, schema: commentSchemaOf(payload), payload, parent_v: v, writer, provenance, original: pin.locator ?? pin.anchor ?? null, at: now() });
    return { pin: project(pin.id, rec.v), unchanged: false };
  }

  // A comment's new anchor (U325's PATCH {anchor}; the re-anchor U306
  // writes): a version whose payload holds the new anchor (an engine record
  // as given, a legacy locator converted) and whose `original` is null, so
  // the pin's anchor is the record's. Never a node rewrite. An anchor equal to
  // the version's appends nothing.
  function reanchor(pin, args = {}) { return writing(() => reanchorNow(pin, args)); }
  function reanchorNow(pin, { anchor = null, writer = null, provenance = null } = {}) {
    const v = baseOf(pin);
    const anc = anchor && typeof anchor === 'object' ? anchor : null;
    const payload = payloadOf({ ...pin, anchor: anc });
    if (redactedHash(payload) === log.version(pin.id, v).payload_hash) {
      return { pin: pin.v === v ? pin : { ...pin, v }, unchanged: true };
    }
    // A re-anchor moves the pin; its chain (the relation at creation) stays.
    const rec = log.appendVersion({ id: pin.id, schema: commentSchemaOf(payload), payload, parent_v: v, writer, provenance, original: null, at: now() });
    return { pin: project(pin.id, rec.v), unchanged: false };
  }

  function reply(pin, args = {}) { return writing(() => replyNow(pin, args)); }
  function replyNow(pin, { text = '', author = 'user', writer = null, provenance = null } = {}) {
    const v = baseOf(pin);
    const at = now();
    const replies = (Array.isArray(pin.replies) ? pin.replies : []).concat([{ author, at, text: String(text) }]);
    const payload = payloadOf({ ...pin, replies });
    const rec = log.appendVersion({ id: pin.id, schema: commentSchemaOf(payload), payload, parent_v: v, author, writer, provenance, original: pin.locator ?? pin.anchor ?? null, at });
    return project(pin.id, rec.v);
  }

  // ── the other types (U325; E-STORE a) ──
  // A highlight, a box grab: one version per write through the log's one
  // writer, under the type's schema; the surface holds only its id@v
  // reference (element-refs), never a copy.

  // The element's type: its `el` record's kind (the log's), else the type its
  // newest version's schema names, else null.
  function typeOf(id) {
    const el = log.element(id);
    if (el && typeof el.kind === 'string' && el.kind) return el.kind;
    const rec = log.latest(id);
    return rec && SCHEMAS[rec.schema] ? SCHEMAS[rec.schema].type : null;
  }

  // THE RECORD of version v of a non-comment element, its text masked at
  // read (the log's views; its anchor's quote context through the context
  // mask, U415a):
  //   {id, type, v, schema, seq, created_at, shared, anchor, …the schema's
  //    other payload keys, writer?, provenance?, edited?}
  // writer and provenance are v1's (the creator's); `edited` is the newest
  // later version's {writer, provenance, at}. null when the log holds no v.
  function record(id, v) {
    const chain = chainOf(id, v);
    if (!chain.length) return null;
    const rec = chain[chain.length - 1];
    const root = chain[0];
    const payload = rec.payload || {};
    const el = log.element(id);
    const row = SCHEMAS[rec.schema];
    const out = {
      id,
      type: el && el.kind ? el.kind : row ? row.type : null,
      v: rec.v,
      schema: rec.schema,
      seq: rec.seq,
      created_at: el && el.created_at != null ? el.created_at : root.at,
      shared: payload.shared !== false,
      anchor: maskAnchorContext(payload.anchor ?? null, contextRedact, { masked: true }),
    };
    for (const k of row ? row.keys : []) if (!(k in out)) out[k] = payload[k] ?? null;
    stamp(root, out);
    if (row && row.keys.includes('replies')) {
      // A threaded type (chat-comment): the comment's rules (threadFields) —
      // a reply is never an edit.
      const thread = threadFields(chain, payload);
      out.replies = thread.replies;
      if (thread.edited) out.edited = thread.edited;
    } else if (chain.length > 1) out.edited = { writer: rec.writer ?? null, provenance: rec.provenance ?? null, at: rec.at };
    return out;
  }

  // ── the family switch (C1; U415) ──
  // A type's family: the bound registry's descriptor, else element-policy's
  // row, else 'page' (a type nobody declares is a page type: every plug-in
  // type is, in this build — lib/packs/elements refuses a pack's chat type).
  function familyOf(type) {
    if (typeof type !== 'string' || !type) return 'page';
    const reg = elementTypes || (graph && graph.elementTypes) || null;
    let d = null;
    try { d = reg && typeof reg.descriptor === 'function' ? reg.descriptor(type) : null; } catch { d = null; }
    if (d && typeof d.family === 'string') return d.family;
    return BUILTIN_FAMILY.get(type) || 'page';
  }
  const isChatType = (type) => familyOf(type) === CHAT_FAMILY;
  const isChatId = (id) => isChatType(typeOf(id));

  // Every live chat element (of `type`, or of every chat type), each at its
  // newest version, in log order; a dropped one is left out. The record's
  // text is masked at read (the log's views).
  function chatRecords(type = null) {
    const out = [];
    for (const id of log.ids()) {
      const t = typeOf(id);
      if (!isChatType(t) || (type != null && t !== type) || log.dropped(id)) continue;
      const rec = log.latest(id);
      const r = rec ? record(id, rec.v) : null;
      if (r) out.push(r);
    }
    return out;
  }

  // One line of versions: a chat element's write stands on its newest
  // version, and a dropped one takes none.
  function onTheLine(id, v) {
    if (log.dropped(id)) throw Object.assign(new Error('the element was deleted'), { code: 'GONE', id });
    const newest = log.latest(id);
    if (newest && newest.v !== v) {
      throw Object.assign(new Error('stale version'), { code: 'STALE', id, v: newest.v });
    }
  }

  function addElement(args = {}) { return writing(() => addElementNow(args)); }
  function addElementNow({ type, schema, payload, author = 'user', writer = null, provenance = null } = {}) {
    const row = SCHEMAS[schema];
    if (!row || row.type !== type || type === COMMENT_TYPE) {
      throw Object.assign(new TypeError(`addElement: ${JSON.stringify(schema)} is not a ${JSON.stringify(type)} schema the log writes here`), { reason: 'schema' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('addElement: a payload object');
    // Refuse a stray key, or a payload its schema's check refuses, before an
    // id is minted, so a refused write spends nothing.
    const stray = Object.keys(payload).filter((k) => !row.keys.includes(k));
    if (stray.length) throw Object.assign(new TypeError(`a ${schema} payload holds only ${row.keys.join(', ')}, not ${stray.join(', ')}`), { reason: 'payload' });
    if (row.check) row.check(payload);
    const at = now();
    const id = log.mintId(type);
    log.ensureElement({ id, kind: type, created_at: at });
    const rec = log.appendVersion({ id, schema, payload, author, writer, provenance, original: null, at });
    return record(id, rec.v);
  }

  // A change to version v's payload: `patch` holds some of the schema's keys.
  // Nothing appended (unchanged) when every key already holds that value.
  function editElement(id, v, args = {}) { return writing(() => editElementNow(id, v, args)); }
  function editElementNow(id, v, { patch = {}, writer = null, provenance = null } = {}) {
    const base = log.version(id, v);
    if (!base) throw Object.assign(new Error('the element has no such version'), { code: 'UNMAPPED' });
    const row = SCHEMAS[base.schema];
    if (isChatId(id)) onTheLine(id, v);
    const keys = Object.keys(patch || {});
    const stray = keys.filter((k) => !row || !row.keys.includes(k));
    if (stray.length) throw Object.assign(new TypeError(`a ${base.schema} payload holds only ${row ? row.keys.join(', ') : 'nothing'}, not ${stray.join(', ')}`), { reason: 'payload' });
    const prev = base.payload || {};
    if (!keys.some((k) => stableKey(patch[k] ?? null) !== stableKey(prev[k] ?? null))) {
      return { element: record(id, v), unchanged: true };
    }
    const payload = { ...prev, ...patch };
    const rec = log.appendVersion({ id, schema: base.schema, payload, parent_v: v, writer, provenance, original: null, at: now() });
    return { element: record(id, rec.v), unchanged: false };
  }

  // A thread reply (U415): a version appending {author, at, text} to the
  // payload's `replies`, for a log-only schema whose keys hold them (the chat
  // comment's; a page comment's reply is reply(), over its live pin). The
  // comment's rules: author 'user' | 'claude' (proving 'claude' is the
  // route's: C-15-2), the text a non-empty string once trimmed. A chat
  // element's reply stands on its newest version.
  function replyElement(id, v, args = {}) { return writing(() => replyElementNow(id, v, args)); }
  function replyElementNow(id, v, { text = '', author = 'user', writer = null, provenance = null } = {}) {
    const base = log.version(id, v);
    if (!base) throw Object.assign(new Error('the element has no such version'), { code: 'UNMAPPED' });
    const row = SCHEMAS[base.schema];
    if (!row || row.normalise || !row.keys.includes('replies')) {
      throw Object.assign(new TypeError(`replyElement: a ${base.schema} element takes no thread`), { reason: 'thread' });
    }
    if (!REPLY_AUTHORS.includes(author)) throw Object.assign(new TypeError(`replyElement: the author is ${REPLY_AUTHORS.join(' or ')}`), { reason: 'author' });
    const body = String(text ?? '').trim();
    if (!body) throw Object.assign(new TypeError('replyElement: an empty reply'), { reason: 'payload' });
    if (isChatId(id)) onTheLine(id, v);
    const at = now();
    const prev = base.payload || {};
    const payload = { ...prev, replies: (Array.isArray(prev.replies) ? prev.replies : []).concat([{ author, at, text: body }]) };
    const rec = log.appendVersion({ id, schema: base.schema, payload, parent_v: v, author, writer, provenance, original: null, at });
    return record(id, rec.v);
  }

  // A chat element's own Delete (U415; RULED R5-confirm = a): the log's drop
  // record, ids and stamps only. A page type's removal is element-refs
  // dropRef (C2: nothing appended), so a page element is refused here.
  // → {id, dropped: true} (dropped: false when it was already dropped).
  function dropElement(id, args = {}) { return writing(() => dropElementNow(id, args)); }
  function dropElementNow(id, { writer = null, provenance = null } = {}) {
    const type = typeOf(id);
    if (!type) throw Object.assign(new Error('no such element'), { code: 'UNMAPPED' });
    if (!isChatType(type)) {
      throw Object.assign(new TypeError(`dropElement: ${id} is a ${type}, a page element (its removal is the surface's: dropRef)`), { reason: 'family' });
    }
    if (log.dropped(id)) return { id, dropped: false };
    log.appendDrop({ id, writer, provenance });
    return { id, dropped: true };
  }

  // The records of every live reference of `type` (state.elements), in list
  // order; a reference whose version the log does not hold is left out. A
  // chat type's are its live chat elements (chatRecords): the surface never
  // holds a chat reference.
  function liveRecords(type) {
    if (isChatType(type)) return chatRecords(type);
    const out = [];
    for (const ref of refsOf(state)) {
      const p = parsePin(ref);
      if (!p || typeOf(p.id) !== type || type === COMMENT_TYPE) continue;
      const r = record(p.id, p.v);
      if (r) out.push(r);
    }
    return out;
  }

  // ── commits ──
  function commitPins(node, { live = null } = {}) {
    const liveById = new Map((live || []).filter(validCopy).map((p) => [p.id, p]));
    const parentPins = nodePins(node.parent_id);
    const pins = [];
    const resolved = new Map();
    for (const c of (Array.isArray(node.comments) ? node.comments : [])) {
      const lp = validCopy(c) ? liveById.get(c.id) : null;
      const r = resolveCopy(c, {
        prefer: lp && lp.v != null ? [lp.v] : [],
        parentV: validCopy(c) ? parentPins.get(c.id) ?? null : null,
        where: node.id,
      });
      if (!r) continue;
      if (r.minted) counts.adopted_versions++;
      pins.push(`${c.id}@${r.v}`);
      resolved.set(c.id, r.v);
    }
    // The node's element references (E-STORE a; U326e's node.elements),
    // pinned verbatim beside the comment copies: each id@v the log holds,
    // once; one it does not hold (or a malformed one) is skipped and counted.
    // nodeDigest still covers the comment copies only (AG-1).
    const seen = new Set(pins);
    for (const ref of (Array.isArray(node.elements) ? node.elements : [])) {
      const p = parsePin(ref);
      if (!p || !log.version(p.id, p.v)) { counts.element_refs_skipped++; continue; }
      // A chat element is never pinned by a node (C1, D5): defensive, as the
      // surface never holds one.
      if (isChatId(p.id)) { counts.chat_refs_skipped++; continue; }
      if (seen.has(ref)) continue;
      seen.add(ref);
      pins.push(ref);
    }
    return { pins, resolved, rec: log.appendCommit({ node, pins }) };
  }

  function appendCommit(node) {
    if (readOnly) { counts.commits_skipped_read_only++; return null; }
    const { resolved, rec } = commitPins(node, { live: state && state.comments });
    // Stamp the live pins that hold the version their copy was mapped to. A
    // new object per stamped pin, never a write into one: the bus ring and a
    // queued item may hold the old object.
    if (state && Array.isArray(state.comments) && resolved.size) {
      let changed = false;
      const next = state.comments.map((p) => {
        if (!validCopy(p)) return p;
        const v = resolved.get(p.id);
        if (!v || p.v === v) return p;
        const h = hashOf(p);
        if (!holds(p.id, v, h)) return p;
        changed = true;
        return { ...p, v };
      });
      if (changed) state.comments = next;
    }
    return rec;
  }

  function adopt(node) {
    if (readOnly) { counts.commits_skipped_read_only++; return null; }
    return commitPins(node).rec;
  }

  // ── the repair (U354; tranche-1 U209's reviewer record) ──
  // A pinned version the log lost (the reconcile's node-pins-missing-version),
  // re-appended from the node's copy at exactly v, through writing(): a
  // read-only store throws READ_ONLY; a filesystem refusal leaves the store
  // read-only ('log-unwritable', noteUnwritable) and throws READ_ONLY, so the
  // store learns its log became unwritable; a TypeError leaves it writable.
  // The element keeps its kind: the log's `el` record's, else a comment, and
  // the version takes that kind's schema (a comment's payload is payloadOf,
  // another type's its schema's keys of the copy). The versions below v are
  // reserved; the parent is the parent node's pin of the id, else the newest
  // version below v the log still holds (the lost record's own parent_v is
  // gone; an edit or a reply is built on the version before it). The stamps
  // are the copy's own pair, null for a 0.8.5 copy (an adopted version is
  // unattributed, U203). Nothing is appended when a later version of the id
  // already exists. → {repaired: the appended version is v}.
  function repair(args = {}) { return writing(() => repairNow(args)); }
  function repairNow({ node = null, id, v, copy } = {}) {
    if (typeof id !== 'string' || !id || !isPosInt(v) || !copy || typeof copy !== 'object') {
      throw new TypeError('repair: an id, a positive-integer v and the node\'s copy');
    }
    if (log.nextV(id) > v) return { repaired: false };
    const el = log.element(id);
    const kind = el && typeof el.kind === 'string' && el.kind ? el.kind : COMMENT_TYPE;
    const typeSchema = schemaForType(kind);
    if (!typeSchema) throw new TypeError(`repair: ${id} is a ${kind}, a type the log has no schema for`);
    const row = SCHEMAS[typeSchema];
    const payload = row.normalise
      ? row.normalise(copy)
      : Object.fromEntries(row.keys.filter((k) => copy[k] !== undefined).map((k) => [k, copy[k]]));
    // A comment copy that holds a chain is re-appended under the chained schema (F.6).
    const schema = kind === COMMENT_TYPE ? commentSchemaOf(payload) : typeSchema;
    log.ensureElement({ id, kind, created_at: Number.isFinite(copy.created_at) ? copy.created_at : null });
    if (log.nextV(id) < v) log.reserve(id, v - 1);
    const parentPin = node && node.parent_id ? pinMapOf(log.pinsOf(node.parent_id)).get(id) : null;
    let parentV = isPosInt(parentPin) && parentPin < v && log.version(id, parentPin) ? parentPin : null;
    for (let k = v - 1; parentV == null && k > 0; k--) if (log.version(id, k)) parentV = k;
    const rec = log.appendVersion({
      id,
      schema,
      payload,
      parent_v: parentV,
      seq: isPosInt(copy.seq) ? copy.seq : undefined,
      original: kind === COMMENT_TYPE ? copy.anchor ?? null : null,
      writer: copy.writer ?? null,
      provenance: copy.provenance ?? null,
    });
    return { repaired: rec.v === v };
  }

  // ── the close and the ack (U352) ──
  // One append that never throws: read-only answers null; a refusal counts,
  // logs once per kind and, for a filesystem error, leaves the store read-only
  // (noteUnwritable, writing()'s rule).
  function appending(kind, fn) {
    if (readOnly) return null;
    try {
      return fn();
    } catch (e) {
      counts[`${kind}_failures`]++;
      noteUnwritable(e);
      if (!appendFailureLogged[kind]) {
        appendFailureLogged[kind] = true;
        console.error(`[web-chat] could not append the element log's ${kind} record (${(e && (e.code || e.message)) || 'error'})${readOnly ? '; the log is read-only for the rest of this boot' : ''}`);
      }
      return null;
    }
  }

  function noteGracefulClose({ live = null, draftWritten = false } = {}) {
    if (readOnly) return null;
    if (!log.stats().epoch_written && !(draftVersions > 0)) return null;
    const held = heldCopies(live);
    const copies = (live && Array.isArray(live.comments) ? live.comments : []).filter(validCopy);
    // A live copy the close cannot name (no v: an attach mint that failed)
    // makes it cover nothing.
    const unheld = copies.some((c) => !isPosInt(c.v) || !isPinKey(`${c.id}@${c.v}`));
    const complete = (draftWritten === true || held.length === 0) && !unheld;
    return appending('close', () => log.appendClose({ held, complete }));
  }

  function acknowledge(keys) {
    if (readOnly || !Array.isArray(keys) || !keys.length) return null;
    return appending('ack', () => log.appendAck({ keys }));
  }

  // `kind` names the record that failed (K.2-66): the side table's answers
  // record passes 'answers record'; only a commit record is adopted next boot.
  function noteAppendFailure(err, kind = 'commit record') {
    counts.append_failures++;
    const tail = kind === 'commit record' ? '; the node is committed and the next boot adopts it' : '; the node is committed';
    console.error(`[web-chat] could not append the ${kind} (${(err && (err.code || err.message)) || 'error'})${tail}`);
  }

  // ── live pins ──
  // Did loadDraft restore a draft? It restores one only when draft.json reads
  // and its base_active is the active node (the census's draftHeld applies the
  // same test). Without one, the live pins are the active node's committed
  // copies, which no draft held (U352@close-ack-scope (a)).
  function draftRestored() {
    if (!graph || !graph.draftPath) return false;
    const r = readJson(graph.draftPath);
    return !!(r.ok && r.value && typeof r.value === 'object' && r.value.base_active === (graph.active ?? null));
  }

  function attachLive(pins, { node = null, draft = false } = {}) {
    if (!Array.isArray(pins)) return pins;
    const nodeId = node || (draft && graph ? graph.active : null);
    // DRAFT-SEQ RESERVATION (U354; tranche-1 U208's reviewer record): a pin
    // whose payload matches a logged version answers that version and appends
    // nothing, so a seq only the pin carries (a 0.8.5 rollback: an edit
    // toggled back to an earlier version's text, with a newer seq) would never
    // reach the mint, and an id could be minted again. Every valid pin's
    // positive-integer seq raises the log's reservation: in memory, never
    // persisted (a draft is re-attached at every boot that restores it, and a
    // committed copy's seq is seeded by graph.load). A read-only store
    // reserves too: a reservation writes nothing.
    let pinSeq = 0;
    for (const p of pins) if (validCopy(p) && isPosInt(p.seq) && p.seq > pinSeq) pinSeq = p.seq;
    if (pinSeq > 0) log.reserveSeq(pinSeq);
    // Only the pins a restored draft carried count toward its close.
    const countDraft = draft && draftRestored();
    const recPins = nodePins(nodeId);
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i];
      if (!validCopy(p)) continue;
      const h = hashOf(p);
      if (p.v != null && holds(p.id, p.v, h)) { if (countDraft) draftVersions++; continue; }
      const named = recPins.get(p.id);
      if (named != null && !holds(p.id, named, h)) mismatches.add(`${nodeId}:${p.id}@${named}`);
      // A mint that cannot be written (the elements folder not writable, a
      // full disk) leaves this pin as it is, without v, and goes on: the node
      // is the truth (D17), and a boot or a Set active never fails on the log.
      let r;
      try {
        r = resolveCopy(p, { prefer: named != null ? [named] : [], parentV: named ?? null, where: nodeId || (draft ? 'draft' : null) });
      } catch (e) {
        counts.attach_failures++;
        noteUnwritable(e);
        if (!attachFailureLogged) {
          attachFailureLogged = true;
          console.error(`[web-chat] could not record a comment's version (${(e && (e.code || e.message)) || 'error'}); it is served without one${readOnly ? ', and comments are read-only this boot' : ''}`);
        }
        continue;
      }
      if (!r) continue;
      if (r.minted) counts.minted_on_attach++;
      counts.attached++;
      if (countDraft) draftVersions++;
      pins[i] = { ...p, v: r.v };
    }
    return pins;
  }

  // ── reads ──
  // Each pin's text and reply texts through the redactor NOW: a value it
  // learned after the write is masked (C-13's learned-later clause), and its
  // anchor's quote through the context mask (U415a), the stored bytes and the
  // live pins unchanged.
  function maskPins(pins) {
    return (Array.isArray(pins) ? pins : []).map((p) => {
      if (!p || typeof p !== 'object') return p;
      const out = { ...p };
      if (typeof p.text === 'string') out.text = redactor.value(p.text);
      if (isObjLike(p.anchor)) out.anchor = maskAnchorContext(p.anchor, contextRedact);
      if (Array.isArray(p.replies)) {
        out.replies = p.replies.map((r) => (r && typeof r.text === 'string' ? { ...r, text: redactor.value(r.text) } : r));
      }
      return out;
    });
  }

  function stats() {
    return {
      ...log.stats(),
      ...counts,
      copy_v_mismatch: mismatches.size,
      load_ms: loadMs,
      read_only: readOnly,
      read_only_reason: readOnlyReason,
      ...(unavailable != null ? { unavailable } : {}),
    };
  }

  if (isObjLike(state)) CHAIN_STORES.set(state, { record, latest: (id) => log.latest(id) });
  return {
    get readOnly() { return readOnly; },
    get readOnlyReason() { return readOnlyReason; },
    // The record layer itself, for U209's reconcile (commits, epochs, digests).
    log,
    add, edit, reply, reanchor, project,
    addElement, editElement, record, typeOf, liveRecords,
    familyOf, chatRecords, replyElement, dropElement,
    dropped: (id) => log.dropped(id),
    appendCommit, adopt, repair, noteAppendFailure, attachLive, maskPins,
    noteGracefulClose, acknowledge,
    maxSeq: () => log.maxSeq(),
    nextSeq: () => log.nextSeq(),
    reserveSeq: (n) => log.reserveSeq(n),
    version: (id, v) => servedVersion(log.version(id, v)),
    versionsOf: (id) => log.versionsOf(id),
    latest: (id) => log.latest(id),
    bySeq: (id, seq) => log.bySeq(id, seq),
    byHash: (id, h) => log.byHash(id, h),
    homeOf: (id, v) => log.homeOf(id, v),
    commitOf: (nodeId) => log.commitOf(nodeId),
    pinsOf: (nodeId) => log.pinsOf(nodeId),
    integrity: () => integrityReport,
    setIntegrity: (report) => { integrityReport = report == null ? null : report; return integrityReport; },
    stats,
    close: () => log.close(),
  };
}

module.exports = { createElementStore, heldCopies, schemaForType, chainPrivate, maskQuoteContext, CONTEXT_RUN_MIN };

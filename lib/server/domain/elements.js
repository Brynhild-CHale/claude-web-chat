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
//
// THE PIN PROJECTION (ruling A2) of version v of element id, over v's
// parent_v chain (the versions this pin descends from, v1 at its root):
//   {id, seq, created_at, shared, text, anchor, replies?, v, writer?,
//    provenance?, edited?}
//   seq          v's seq (the API's pin.seq and the comment cursor)
//   anchor       the ORIGINAL locator (the version's `original` sibling), so
//                public/app/comments.js resolves exactly as today; the
//                converted anchor stays in the log
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

const { createElementLog, payloadOf } = require('../../core/element-log');
const { stableHash } = require('../../core/stable-json');

const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const has = (o, k) => o != null && o[k] != null;

function readOnlyError(reason) {
  return Object.assign(new Error(`the comment log is read-only (${reason})`), { code: 'READ_ONLY', reason });
}

// `bus` is taken for U209's integrity event (the reconcile announces on it);
// nothing here emits. `now` is a test seam (the log's clock).
function createElementStore({
  paths, state, graph, redactor, bus = null, bootId, migration = null, now = Date.now,
} = {}) {
  void bus;
  if (!paths || !paths.elementsLog) throw new TypeError('createElementStore: paths (lib/core/paths projectPaths) with elementsLog');
  let unavailable = null;
  let log;
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
  };
  let attachFailureLogged = false;
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
  function pinMapOf(nodeId) {
    const m = new Map();
    const pins = nodeId ? log.pinsOf(nodeId) : null;
    for (const p of pins || []) {
      const at = p.lastIndexOf('@');
      if (at > 0) m.set(p.slice(0, at), Number(p.slice(at + 1)));
    }
    return m;
  }
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
    const rec = log.appendVersion({
      id,
      payload: payloadOf(copy),
      parent_v: pv,
      seq: isPosInt(copy.seq) ? copy.seq : undefined,
      original: copy.anchor ?? null,
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
    const pin = {
      id,
      seq: rec.seq,
      created_at: el && el.created_at != null ? el.created_at : root.at,
      shared: payload.shared,
      text: payload.text,
      anchor: rec.original != null ? rec.original : (payload.anchor ?? null),
    };
    const replies = Array.isArray(payload.replies) ? payload.replies : [];
    if (replies.length) {
      const sizes = chain.map((c) => (Array.isArray((c.payload || {}).replies) ? c.payload.replies.length : 0));
      pin.replies = replies.map((r, i) => {
        const k = sizes.findIndex((n) => n > i);
        return k >= 0 ? stamp(chain[k], { ...r }) : { ...r };
      });
    }
    pin.v = rec.v;
    stamp(root, pin);
    // `edited` (ruling U203@edited-reading): the newest version whose text or
    // shared differs from its own parent's, i.e. the newest EDIT. A reply
    // appended after an edit carries the edited text forward but did not
    // write it, so it never becomes the editor (U214c's live pins record
    // `edited` on an edit only).
    const differs = (x, y) => x.text !== y.text || x.shared !== y.shared;
    for (let k = chain.length - 1; k > 0; k--) {
      if (differs(chain[k].payload || {}, chain[k - 1].payload || {})) {
        pin.edited = { writer: chain[k].writer ?? null, provenance: chain[k].provenance ?? null, at: chain[k].at };
        break;
      }
    }
    return pin;
  }

  // ── writes ──
  function add(args = {}) { return writing(() => addNow(args)); }
  function addNow({ text = '', shared = true, anchor = null, author = null, writer = null, provenance = null } = {}) {
    const at = now();
    const id = log.mintId();
    const anc = anchor && typeof anchor === 'object' ? anchor : null;
    const payload = payloadOf({ text: String(text), shared: shared !== false, replies: [], anchor: anc });
    log.ensureElement({ id, kind: 'comment', created_at: at });
    const rec = log.appendVersion({ id, payload, author, writer, provenance, original: anc, at });
    return project(id, rec.v);
  }

  // The version a live pin stands on: its own (hash-checked), else matched or
  // minted as attachLive would.
  function baseOf(pin) {
    const r = resolveCopy(pin, { parentV: pinMapOf(graph && graph.active).get(pin.id) ?? null, where: 'live' });
    if (!r) throw Object.assign(new Error('the pin cannot be mapped to a version'), { code: 'UNMAPPED' });
    return r.v;
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
    const rec = log.appendVersion({ id: pin.id, payload, parent_v: v, writer, provenance, original: pin.anchor ?? null, at: now() });
    return { pin: project(pin.id, rec.v), unchanged: false };
  }

  function reply(pin, args = {}) { return writing(() => replyNow(pin, args)); }
  function replyNow(pin, { text = '', author = 'user', writer = null, provenance = null } = {}) {
    const v = baseOf(pin);
    const at = now();
    const replies = (Array.isArray(pin.replies) ? pin.replies : []).concat([{ author, at, text: String(text) }]);
    const payload = payloadOf({ ...pin, replies });
    const rec = log.appendVersion({ id: pin.id, payload, parent_v: v, author, writer, provenance, original: pin.anchor ?? null, at });
    return project(pin.id, rec.v);
  }

  // ── commits ──
  function commitPins(node, { live = null } = {}) {
    const liveById = new Map((live || []).filter(validCopy).map((p) => [p.id, p]));
    const parentPins = pinMapOf(node.parent_id);
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

  function noteAppendFailure(err) {
    counts.append_failures++;
    console.error(`[web-chat] could not append the commit record (${(err && (err.code || err.message)) || 'error'}); the node is committed and the next boot adopts it`);
  }

  // ── live pins ──
  function attachLive(pins, { node = null, draft = false } = {}) {
    if (!Array.isArray(pins)) return pins;
    const nodeId = node || (draft && graph ? graph.active : null);
    const recPins = pinMapOf(nodeId);
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i];
      if (!validCopy(p)) continue;
      const h = hashOf(p);
      if (p.v != null && holds(p.id, p.v, h)) continue;
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
      pins[i] = { ...p, v: r.v };
    }
    return pins;
  }

  // ── reads ──
  // Each pin's text and reply texts through the redactor NOW: a value it
  // learned after the write is masked (C-13's learned-later clause), the
  // stored bytes and the live pins unchanged.
  function maskPins(pins) {
    return (Array.isArray(pins) ? pins : []).map((p) => {
      if (!p || typeof p !== 'object') return p;
      const out = { ...p };
      if (typeof p.text === 'string') out.text = redactor.value(p.text);
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
      read_only: readOnly,
      read_only_reason: readOnlyReason,
      ...(unavailable != null ? { unavailable } : {}),
    };
  }

  return {
    get readOnly() { return readOnly; },
    get readOnlyReason() { return readOnlyReason; },
    // The record layer itself, for U209's reconcile (commits, epochs, digests).
    log,
    add, edit, reply, project,
    appendCommit, adopt, noteAppendFailure, attachLive, maskPins,
    maxSeq: () => log.maxSeq(),
    nextSeq: () => log.nextSeq(),
    reserveSeq: (n) => log.reserveSeq(n),
    version: (id, v) => log.version(id, v),
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

module.exports = { createElementStore };

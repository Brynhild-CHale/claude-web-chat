'use strict';
// The element API (PLAN 2C.4; U325): every element type's routes, the comment
// included — the comment's semantics MOVED here from routes/comments.js (which
// U327a replaces outright, COMMENTS@alias b: no alias).
//
//   GET    /api/elements?type=&node=&since=&mount=&shared_only=   the one read
//   POST   /api/elements {type, anchor, locator?, payload, device}  a new element
//   PATCH  /api/elements/:id   a comment's {text, shared}; another type's
//                              payload keys; any type's {anchor} (a new anchor
//                              version: the re-anchor U306 writes)
//   POST   /api/elements/:id/reply {text, author}   a comment's thread
//   DELETE /api/elements/:id   the one removal (domain/comments removeElement)
//
// THE STORAGE (E-STORE a). A comment keeps its 0.8.5 copy: the pin in
// state.comments (node.comments on a commit), its versions in the log. A
// highlight or a box grab lives in the log alone: the surface holds its id@v
// reference in state.elements (domain/element-refs), and a commit carries the
// reference (node.elements) and pins it in its commit record. Every write is
// one version through the log's one writer (graph.elements: add / edit / reply
// / reanchor for a comment, addElement / editElement for the rest), its id the
// type's letter + the one seq (F1 a: c, h, g).
//
// THE TYPES. A type is a built-in (lib/core/element-policy's
// BUILTIN_ELEMENT_TYPES: accepted whatever the built-in pack's record says, so
// a failed boot install never breaks comments) or one the element-type
// registry lists (ctx.elementTypes, U324, when present). Anything else answers
// 400 with a hint. A type's gate {see, send} is the registry's when it has one,
// else element-policy's; every route first holds the FLOOR (read to see, full
// to send) — the portal's FLOOR_RULES checked again here, the only lock for a
// network peer (WEB_CHAT_HOST) — and a type's gate may only tighten it. A type
// the log has no schema row for is listed but not writable (400).
//
// THE RECORD (GET's `elements`, a write's `element`):
//   comment   today's pin projection (id, seq, created_at, shared, text,
//             anchor, replies?, v, writer, provenance, edited?, locator?) plus
//             type, schema, anchor_label (describeAnchor) and record (the
//             version's engine anchor, masked)
//   others    {id, type, v, schema, seq, created_at, shared, anchor, …the
//             schema's other payload keys, writer, provenance, edited?}
//             (domain/elements record)
// A node-scoped read adds node_v (the version the node's own commit record
// pins, or null) and newer_elsewhere (element-scope's display rows).
//
// THE CURSOR. next_cursor is the log's max seq (comments' 1A.8 rule, now every
// type's): it never decreases; `since=N` answers the records whose seq is above N.
//
// PRIVATE (decision A2). Only a local browser (audience.seesPrivate) sees a
// record with shared === false. Anyone else gets GET's body less those
// (PRIVATE_RULES.routes 'GET /api/elements', remote-policy dropPrivate), and a
// write naming a private element answers 404 {error: 'not found', id} — the
// GET's answer, so an enumerable id cannot be probed (C-16-2). The ring's
// events carry no private text (domain/comments: redactPin, elementEvent).
//
// LEARNED LATER (C-13, A3). Every text this read serves passes the redactor
// at read: the pins through maskPins, the log's records through its masking
// views, so a value the redactor learned after the write is masked while the
// log's bytes are not rewritten. Frames and node copies stay redacted at write.
//
// THE NODE SCOPE. ?node=<stored id> answers that node's elements through
// element-scope elementsForNode (the newest version homed in its ancestry),
// keyed by the stored id, never a label: a label answers 400 with a hint
// naming the id form (U205). node omitted, or 'live', is the live surface.
//
// THE WRITE STAMP (PLAN 1B.4 / 1B.5 / 1D.3, U214c; ruling A2). Every add,
// edit, re-anchor and reply records who wrote it and where from, as two plain
// objects: writer — {class, owner, verified}, lib/server/domain/writers
// resolveWriter's answer for the request (pane class included); provenance —
// queue.provenance of the request: origin 'remote' through the portal, else
// 'local'; device from the chrome's own claim (`device` in the body), else the
// User-Agent. A new element carries both; each reply carries the pair of the
// write that appended it; an edit records `edited` and never rewrites the
// creator's `writer`. A delete stamps nothing (no tombstone, C2).
//
// The rules on them (C-15-1..3: attribution, never a security boundary but the
// verified credential):
//   * a reply as author 'claude' needs writer.class claude AND
//     writer.verified (Claude's writer token; after U355 a tokenless caller is
//     never Claude, C-15-2), else 403 {ok: false, writer: 'unverified'}; a
//     claude reply into a private thread answers 404. The self-wake gate
//     (lib/channel/policy) reads that author.
//   * a pane-stamped writer may edit or delete only an element whose stored
//     writer.owner is its own `pane:<id>`, else 403 {ok: false, writer: 'pane'}
//     (ruling B4) — a narrowing of what a bare local browser request may do:
//     a pane script that fetches unstamped reads as the user (GT-15's
//     in-realm residual).
//
// READ-ONLY: while the log is read-only (a refused migration, an unwritable
// log), POST, PATCH and reply answer 503 with READ_ONLY_HINT; GET and DELETE
// still work.

const { RESPOND_HINT } = require('../../channel/envelope');
const { dropPrivate, ELEMENT_POLICY, atLeast } = require('../../core/remote-policy');
const { FLOOR } = require('../../core/element-policy');
const { SCHEMAS, SCHEMA, isEngineRecord, parsePin } = require('../../core/element-log');
const { isRemoteRequest } = require('../../core/cors');
const { provenance } = require('../domain/queue');
const { emitComments, emitElements, elementEvent, removeElement } = require('../domain/comments');
const { refsOf, refOf, putRef, anchorItem } = require('../domain/element-refs');
const { elementsForNode } = require('../domain/element-scope');
const { resolveNodeRef } = require('../domain/refs');
const { schemaForType } = require('../domain/elements');
const { STALE_HINT } = require('./writers');

const COMMENT = SCHEMAS[SCHEMA].type;
const BUILTIN_TYPES = Object.freeze(Object.keys(ELEMENT_POLICY.typeGates));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;

const PANE_EDIT_HINT = 'a pane edits and deletes only the elements it added';
const CLAUDE_REPLY_HINT = 'only Claude replies as author claude (the reply_comment tool, with its writer token)';
const READ_ONLY_ERROR = 'elements are read-only until the comment migration runs';
const READ_ONLY_HINT = 'run claude-web-chat migrate for the report';
const MOUNTLESS_HINT = 'an anchor names the item it is on (an engine record, or {mount, selector, text, ordinal}), or is null for a page note';
const UNMAPPED_HINT = 'this element cannot be recorded in the element log; run claude-web-chat migrate for the report';
const TYPE_HINT = `an element type is a built-in (${BUILTIN_TYPES.join(', ')}) or one an approved element pack lists (GET /api/elements/types)`;
const NOT_WRITABLE_HINT = 'this element type has no schema the element log records in this version of web-chat';
const LABEL_HINT = 'name a node by its stored id (get_graph lists each node\'s id beside its label), or live';
const REPLY_HINT = 'only comments take replies';
const REANCHOR_HINT = 'send {anchor} alone to re-anchor, then edit the text or the sharing';
const STALE_VERSION_HINT = 'the element changed since you read it: read it again and retry';

// Human-readable anchor for Claude — never raw DOM internals alone. A legacy
// locator ({mount, selector, text}) as before; an engine record (lib/core/
// anchors.js) by its item (mount, or a markdown source's md) and its head
// text: an element record's fp.head, a range or source record's quote.exact.
function describeAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const item = a.mount || (isEngineRecord(a) ? a.md : null);
  if (!item) return null;
  const head = a.text
    || (isEngineRecord(a) && a.fp && typeof a.fp.head === 'string' ? a.fp.head : '')
    || (isEngineRecord(a) && a.quote && typeof a.quote.exact === 'string' ? a.quote.exact : '');
  const t = head && String(head).trim();
  if (t) return `${item}: "${t.length > 60 ? t.slice(0, 60) + '…' : t}"`;
  if (a.selector) return `${item} @ ${a.selector}`;
  return `${item} (whole pane)`;
}

function stampOf(w) {
  return { class: w.class, owner: w.owner, verified: w.verified === true };
}

function provenanceOf(req) {
  return provenance({
    remote: isRemoteRequest(req),
    device: req.body && typeof req.body === 'object' ? req.body.device : undefined,
    userAgent: req.headers['user-agent'],
  });
}

function mountElementRoutes(app, ctx) {
  const { state, bus, audience, writers, graph } = ctx;
  if (!writers || typeof writers.resolveWriter !== 'function') throw new TypeError('mountElementRoutes: ctx.writers is required');
  if (!graph || !graph.elements) throw new TypeError('mountElementRoutes: ctx.graph.elements (the element store) is required');
  // Reached through the graph and the ctx on every call, never captured: the
  // store hangs on the graph, and the type registry (U324) on the ctx.
  const elements = () => graph.elements;
  const registry = () => (ctx.elementTypes && typeof ctx.elementTypes === 'object' ? ctx.elementTypes : null);

  // One middleware per level, made once.
  const gates = new Map();
  const gateOf = (need) => {
    if (!gates.has(need)) gates.set(need, audience.requireMirror(need));
    return gates.get(need);
  };
  // Does the request meet `need`? When not, the 403 has been sent.
  function passes(need, req, res) {
    let ok = false;
    gateOf(need)(req, res, () => { ok = true; });
    return ok;
  }
  const meets = (need, req) => atLeast(audience.levelOf(req), need);

  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const isLevel = (l) => typeof l === 'string' && audience.rank(l) !== -1;

  // A type's {type, gate, schema}, or null for a type neither built in nor listed.
  function typeInfo(type) {
    if (typeof type !== 'string' || !type) return null;
    const reg = registry();
    const builtin = hasOwn(ELEMENT_POLICY.typeGates, type);
    const listed = !!(reg && typeof reg.listed === 'function' && safe(() => reg.listed(type)));
    if (!builtin && !listed) return null;
    let gate = listed && typeof reg.gate === 'function' ? safe(() => reg.gate(type)) : null;
    if (!gate || !isLevel(gate.see) || !isLevel(gate.send)) gate = builtin ? ELEMENT_POLICY.typeGates[type] : FLOOR;
    let schema = null;
    if (listed && typeof reg.descriptor === 'function') {
      const d = safe(() => reg.descriptor(type));
      if (d && typeof d.schema === 'string') schema = d.schema;
    }
    if (!schema) schema = schemaForType(type);
    return { type, gate, schema };
  }
  // A stored element's type info: a type the registry no longer lists still
  // answers under the floor (its records stay reachable to remove).
  const infoOf = (type) => typeInfo(type) || { type, gate: FLOOR, schema: null };

  // Every type a read without ?type= serves: the built-ins, then the listed.
  function allTypes() {
    const out = [...BUILTIN_TYPES];
    const reg = registry();
    const listed = reg && typeof reg.list === 'function' ? safe(() => reg.list()) : null;
    for (const x of Array.isArray(listed) ? listed : []) {
      const t = typeof x === 'string' ? x : x && x.type;
      if (typeof t === 'string' && t && !out.includes(t) && typeInfo(t)) out.push(t);
    }
    return out;
  }

  // Who is writing, or a 401 for a stale writer token. Null when it sent the response.
  function writerOf(req, res) {
    const w = writers.resolveWriter(req, req.body, { pane: true });
    if (w.stale) { res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT }); return null; }
    return stampOf(w);
  }
  // A private element answers 404 to anyone who does not see private ones
  // (audience.seesPrivate: a local browser): GET's answer (C-16-2).
  function hiddenPrivate(req, res, shared) {
    if (shared !== false || audience.seesPrivate(req)) return false;
    res.status(404).json({ error: 'not found', id: req.params.id });
    return true;
  }
  // Ruling B4: a pane edits or deletes only the elements it added.
  function refusedPane(res, w, owner) {
    if (w.class !== 'pane') return false;
    if (owner && owner.owner === w.owner) return false;
    res.status(403).json({ ok: false, writer: 'pane', hint: PANE_EDIT_HINT });
    return true;
  }
  function readOnly(res) {
    if (!elements().readOnly) return false;
    res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
    return true;
  }
  // A write the store refused, answered (true), or a real fault (false).
  function refusedWrite(res, e) {
    if (e && e.code === 'READ_ONLY') { res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT }); return true; }
    if (e && e.reason === 'anchor-without-mount') { res.status(400).json({ error: 'anchor without a mount', hint: MOUNTLESS_HINT }); return true; }
    if (e && e.code === 'UNMAPPED') { res.status(409).json({ error: 'unmapped element', hint: UNMAPPED_HINT }); return true; }
    if (e instanceof TypeError && (e.reason || /^appendVersion:/.test(e.message))) {
      res.status(400).json({ error: 'the payload does not fit the type\'s schema', detail: e.message });
      return true;
    }
    return false;
  }

  // A pin as the API serves it (already masked by the caller).
  function commentRecord(pin) {
    const ver = isPosInt(pin.v) ? elements().version(pin.id, pin.v) : null;
    const payload = ver ? ver.payload : null;
    return {
      ...pin,
      type: COMMENT,
      schema: ver ? ver.schema : SCHEMA,
      anchor_label: describeAnchor(pin.anchor),
      record: payload && payload.anchor != null ? payload.anchor : null,
    };
  }

  // The element `id` names on the live surface: a comment pin, or a reference.
  function find(id) {
    const idx = state.comments.findIndex((c) => c.id === id);
    if (idx >= 0) {
      const pin = state.comments[idx];
      return { type: COMMENT, idx, pin, shared: pin.shared, writer: pin.writer || null, v: pin.v };
    }
    const held = refOf(state, id);
    if (!held) return null;
    const rec = elements().record(held.id, held.v);
    // A reference the log cannot read fails closed: private.
    if (!rec) return { type: elements().typeOf(id), held, rec: null, shared: false, writer: null, v: held.v };
    return { type: rec.type, held, rec, shared: rec.shared, writer: rec.writer || null, v: held.v };
  }

  // ── READ ──────────────────────────────────────────────────────────────────
  // The one read every element shares (K.2-10): get_comments reads it with
  // type=comment (U327a), a `type` parameter beside (U328a).
  app.get('/api/elements', gateOf(FLOOR.see), (req, res) => {
    const q = req.query || {};
    let types;
    if (q.type != null && q.type !== '') {
      const info = typeInfo(String(q.type));
      if (!info) return res.status(400).json({ error: 'unknown element type', type: String(q.type), hint: TYPE_HINT });
      if (!passes(info.gate.see, req, res)) return undefined;
      types = [info.type];
    } else {
      types = allTypes().filter((t) => meets(infoOf(t).gate.see, req));
    }
    const sharedOnly = q.shared_only === '1' || q.shared_only === 'true';
    const since = parseInt(q.since || '0', 10) || 0;
    const mount = q.mount ? String(q.mount) : null;
    const node = q.node == null || q.node === '' ? 'live' : String(q.node);

    let list = [];
    if (node === 'live') {
      if (types.includes(COMMENT)) list = elements().maskPins(state.comments).map(commentRecord);
      // The other types' records in the references' own order.
      const at = new Map(refsOf(state).map((r, i) => [(parsePin(r) || {}).id, i]));
      const rest = [];
      for (const t of types) if (t !== COMMENT) rest.push(...elements().liveRecords(t));
      list = list.concat(rest.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0)));
    } else {
      if (!graph.nodes.has(node)) {
        const r = resolveNodeRef(graph, node, { allowLive: false });
        if (r.ok) return res.status(400).json({ error: 'a node is named by its stored id here, never a label', node, hint: LABEL_HINT });
        return res.status(404).json({ error: 'node not found', node });
      }
      for (const row of elementsForNode(graph, elements(), node)) {
        const t = elements().typeOf(row.id);
        if (!types.includes(t)) continue;
        const v = row.newest_visible_v;
        let rec;
        if (t === COMMENT) {
          const pin = elements().project(row.id, v);
          rec = pin ? commentRecord(elements().maskPins([pin])[0]) : null;
        } else {
          rec = elements().record(row.id, v);
        }
        if (rec) list.push({ ...rec, node_v: row.v, newer_elsewhere: row.newer_elsewhere });
      }
    }
    if (sharedOnly) list = list.filter((e) => e.shared !== false);
    if (since) list = list.filter((e) => (e.seq || 0) > since);
    if (mount) list = list.filter((e) => anchorItem(e) === mount);

    const body = {
      elements: list,
      next_cursor: elements().maxSeq(),
      // `respond_hint` routes Claude to the reply skill: once, top-level,
      // whenever the comment type is in the read.
      ...(types.includes(COMMENT) ? { respond_hint: RESPOND_HINT } : {}),
    };
    res.json(audience.seesPrivate(req) ? body : dropPrivate('routes', 'GET /api/elements', body));
  });

  // ── ADD ───────────────────────────────────────────────────────────────────
  app.post('/api/elements', gateOf(FLOOR.send), (req, res) => {
    const b = isObj(req.body) ? req.body : {};
    const info = typeInfo(b.type);
    if (!info) return res.status(400).json({ error: 'unknown element type', type: b.type ?? null, hint: TYPE_HINT });
    if (!passes(info.gate.send, req, res)) return undefined;
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    if (readOnly(res)) return undefined;
    const payload = isObj(b.payload) ? b.payload : {};
    const anchor = b.anchor !== undefined ? b.anchor : payload.anchor;

    if (info.type === COMMENT) {
      let pin;
      try {
        pin = elements().add({
          text: String(payload.text ?? ''),
          shared: payload.shared !== false,
          anchor: isObj(anchor) ? anchor : null,
          locator: isObj(b.locator) ? b.locator : null,
          author: 'user',
          writer,
          provenance: provenanceOf(req),
        });
      } catch (e) {
        if (refusedWrite(res, e)) return undefined;
        throw e;
      }
      state.comments = state.comments.concat([pin]);
      // The pin rides the add event so the wake policy can fold a shared pin
      // into the queue (lib/channel/policy commentItem); emitComments redacts
      // a private one. No top-level id/mount (C7).
      emitComments(state, bus, { kind: 'comment', op: 'add', pin });
      return res.json({ ok: true, element: commentRecord(pin), pin });
    }

    if (!info.schema || !hasOwn(SCHEMAS, info.schema)) {
      return res.status(400).json({ error: 'element type not writable', type: info.type, hint: NOT_WRITABLE_HINT });
    }
    let rec;
    try {
      rec = elements().addElement({
        type: info.type,
        schema: info.schema,
        payload: { ...payload, anchor: anchor ?? null, shared: payload.shared !== false },
        author: 'user',
        writer,
        provenance: provenanceOf(req),
      });
    } catch (e) {
      if (refusedWrite(res, e)) return undefined;
      throw e;
    }
    putRef(state, rec.id, rec.v);
    emitElements(state, bus, elements(), info.type, elementEvent(state, 'add', rec));
    return res.json({ ok: true, element: rec });
  });

  // ── EDIT / TOGGLE SHARED / RE-ANCHOR ──────────────────────────────────────
  // A new seq ONLY when something actually changed, so a private→shared
  // toggle (or a text edit) re-surfaces to Claude on the next read, while a
  // no-op PATCH does not bump the cursor. `base_v` (optional): the version
  // the writer read; another live version answers 409.
  app.patch('/api/elements/:id', gateOf(FLOOR.send), (req, res) => {
    const found = find(req.params.id);
    if (!found) return res.status(404).json({ error: 'not found', id: req.params.id });
    if (hiddenPrivate(req, res, found.shared)) return undefined;
    if (!passes(infoOf(found.type).gate.send, req, res)) return undefined;
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    if (refusedPane(res, writer, found.writer)) return undefined;
    const b = isObj(req.body) ? req.body : {};
    if (b.base_v != null && b.base_v !== found.v) {
      return res.status(409).json({ error: 'stale version', id: req.params.id, v: found.v ?? null, hint: STALE_VERSION_HINT });
    }

    if (found.type === COMMENT) {
      const prev = found.pin;
      const { text, shared } = b;
      if (hasOwn(b, 'anchor')) {
        if (text !== undefined || shared !== undefined) return res.status(400).json({ error: 'a re-anchor changes the anchor only', hint: REANCHOR_HINT });
        if (readOnly(res)) return undefined;
        let r;
        try {
          r = elements().reanchor(prev, { anchor: isObj(b.anchor) ? b.anchor : null, writer, provenance: provenanceOf(req) });
        } catch (e) {
          if (refusedWrite(res, e)) return undefined;
          throw e;
        }
        if (r.unchanged) return res.json({ ok: true, pin: prev, element: commentRecord(prev), unchanged: true });
        const next = state.comments.slice();
        next[found.idx] = r.pin;
        state.comments = next;
        // A re-anchor moves the pin, not its words: an op the wake policy
        // neither enqueues nor refreshes.
        emitComments(state, bus, { kind: 'comment', op: 'anchor', pin: r.pin });
        return res.json({ ok: true, pin: r.pin, element: commentRecord(r.pin) });
      }
      let changed = false;
      if (text !== undefined && String(text) !== prev.text) changed = true;
      if (shared !== undefined && !!shared !== prev.shared) changed = true;
      if (!changed) return res.json({ ok: true, pin: prev, element: commentRecord(prev), unchanged: true });
      if (readOnly(res)) return undefined;
      // The store appends the edit's version (a fresh seq) carrying this
      // write's writer and provenance; its projection keeps the creator's
      // `writer` and answers the edit's own stamp as `edited` (ruling A2). An
      // edit whose stored (redacted) payload equals the pin's version appends
      // nothing.
      let r;
      try {
        r = elements().edit(prev, {
          text: text !== undefined ? String(text) : undefined,
          shared: shared !== undefined ? !!shared : undefined,
          writer,
          provenance: provenanceOf(req),
        });
      } catch (e) {
        if (refusedWrite(res, e)) return undefined;
        throw e;
      }
      if (r.unchanged) return res.json({ ok: true, pin: prev, element: commentRecord(prev), unchanged: true });
      const pin = r.pin;
      // The store's pin where the live one was (a new array: the bus ring and
      // a queued item may hold the old one).
      const next = state.comments.slice();
      next[found.idx] = pin;
      state.comments = next;
      // became_shared gates the wake policy's enqueue of a private→shared
      // toggle; became_private is the writer-side symmetry (B7). No top-level
      // id/mount (C7).
      const becameShared = !prev.shared && pin.shared;
      const becamePrivate = prev.shared && !pin.shared;
      emitComments(state, bus, { kind: 'comment', op: 'edit', pin, became_shared: becameShared, became_private: becamePrivate });
      return res.json({ ok: true, pin, element: commentRecord(pin) });
    }

    if (!found.rec) return res.status(409).json({ error: 'unmapped element', hint: UNMAPPED_HINT });
    // Another type's payload keys: from `payload`, or named at the top level
    // (as a comment's {text, shared} are); {anchor} among them.
    const row = SCHEMAS[found.rec.schema];
    const patch = {};
    const from = isObj(b.payload) ? b.payload : {};
    for (const k of Object.keys(from)) patch[k] = from[k];
    for (const k of row ? row.keys : []) if (hasOwn(b, k)) patch[k] = b[k];
    if (hasOwn(patch, 'shared')) patch.shared = patch.shared !== false;
    if (!Object.keys(patch).length) return res.json({ ok: true, element: found.rec, unchanged: true });
    if (readOnly(res)) return undefined;
    let r;
    try {
      r = elements().editElement(found.held.id, found.held.v, { patch, writer, provenance: provenanceOf(req) });
    } catch (e) {
      if (refusedWrite(res, e)) return undefined;
      throw e;
    }
    if (r.unchanged) return res.json({ ok: true, element: r.element, unchanged: true });
    putRef(state, r.element.id, r.element.v);
    emitElements(state, bus, elements(), found.type, elementEvent(state, 'edit', r.element));
    return res.json({ ok: true, element: r.element });
  });

  // ── REPLY ─────────────────────────────────────────────────────────────────
  // Append a message to a comment's thread. `author` is 'claude' (the
  // reply_comment tool) or 'user' (the browser reply box; the default). Bumps
  // seq so the thread re-surfaces on the next read(since). The reply event
  // carries the pin + author so the wake policy enqueues a USER reply but
  // never Claude's own (self-wake gate).
  app.post('/api/elements/:id/reply', gateOf(FLOOR.send), (req, res) => {
    const found = find(req.params.id);
    if (!found) return res.status(404).json({ error: 'not found', id: req.params.id });
    if (hiddenPrivate(req, res, found.shared)) return undefined;
    if (found.type !== COMMENT) return res.status(400).json({ error: 'no thread', id: req.params.id, type: found.type, hint: REPLY_HINT });
    if (!passes(infoOf(found.type).gate.send, req, res)) return undefined;
    const { text = '', author } = isObj(req.body) ? req.body : {};
    const who = author === 'claude' ? 'claude' : 'user';
    const prev = found.pin;
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    // Claude may not reply into a PRIVATE thread — 404, not 403, so an
    // enumerable id cannot be probed. A user's browser reply on a private pin
    // stays allowed.
    if (who === 'claude' && !prev.shared) return res.status(404).json({ error: 'not found', id: req.params.id });
    // Author 'claude' is a claim the verified claude credential proves (C-15-2).
    if (who === 'claude' && !(writer.class === 'claude' && writer.verified === true)) {
      return res.status(403).json({ ok: false, writer: 'unverified', hint: CLAUDE_REPLY_HINT });
    }
    const body = String(text).trim();
    if (!body) return res.status(400).json({ error: 'empty reply' });
    if (readOnly(res)) return undefined;
    let pin;
    try {
      pin = elements().reply(prev, { text: body, author: who, writer, provenance: provenanceOf(req) });
    } catch (e) {
      if (refusedWrite(res, e)) return undefined;
      throw e;
    }
    const next = state.comments.slice();
    next[found.idx] = pin;
    state.comments = next;
    emitComments(state, bus, { kind: 'comment', op: 'reply', pin, author: who }); // no top-level id (C7)
    return res.json({ ok: true, pin, element: commentRecord(pin) });
  });

  // ── DELETE ────────────────────────────────────────────────────────────────
  // The one removal (C2): the live copy or reference goes; nothing is
  // appended to the log, and every committed node keeps its own.
  app.delete('/api/elements/:id', gateOf(FLOOR.send), (req, res) => {
    const found = find(req.params.id);
    if (!found) return res.status(404).json({ error: 'not found', id: req.params.id });
    if (hiddenPrivate(req, res, found.shared)) return undefined;
    if (!passes(infoOf(found.type).gate.send, req, res)) return undefined;
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    if (refusedPane(res, writer, found.writer)) return undefined;
    if (!removeElement(state, bus, req.params.id, { elements: elements() })) return res.status(404).json({ error: 'not found', id: req.params.id });
    return res.json({ ok: true, removed: req.params.id });
  });
}

module.exports = { mountElementRoutes, describeAnchor };

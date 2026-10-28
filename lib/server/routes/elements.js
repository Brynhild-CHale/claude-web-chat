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
//   POST   /api/elements/:id/send {device}   Send to Claude: share a private
//                              element (the PATCH's edit), or raise a shared
//                              one's queue item again (F.5, M2 (a))
//   DELETE /api/elements/:id   the one removal (domain/comments removeElement)
//   GET    /api/elements/:id/grab   a box grab's picture (lib/server/box-grab;
//                              ?as=json: its state and the bytes base64)
//
// THE BOX GRAB (U328b) is handed to lib/server/box-grab: its POST payload is
// shaped there (a page anchor, the meta completed, always shared, the capture
// id reserved first) and appended here as one version; its capture and its
// picture follow off the request. A PATCH that makes one private or edits it
// answers 400 with a hint (F5 (a)).
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
// THE CHAIN (F.6, U406; RULED REQ@comment-on-element L7 (a), U406@pick O5
// (a), U406@private-chain-member Q8 (a)). A comment made over live elements
// (a highlight, a box grab, another comment) records their ids, smallest
// first, as its `chain` (a comment@2 version; POST's payload.chain, each id a
// live element found here, at most CHAIN_MAX, each once). A chained comment's
// record adds `chain` and `chain_label`, derived at read time: each member
// "<type> <id>" ("a removed <type> <id>" when it is no longer on the surface
// read), then the anchor's pane and its section (the nearest #/## heading at
// or before the anchor's item in the page order) — e.g. 'on highlight h7 ›
// box grab g3 › pane m1 › section "Options"'. The structural levels are never
// stored. A member private now reads 'a private element' (no type, no id; its
// id is null in `chain`) for any request that does not see private records
// (audience.seesPrivate: lib/client, Claude's tools, never does). Every
// comment event for a chained pin carries `chain_private`, the ids of its
// members private now, so the queue summary (lib/channel/policy commentItem)
// names them the same way. A chainless comment's record and events are
// unchanged (the S-14 golden).
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
// log), POST, PATCH, reply and send answer 503 with READ_ONLY_HINT; GET and
// DELETE still work.

const { RESPOND_HINT } = require('../../channel/envelope');
const { dropPrivate, ELEMENT_POLICY, atLeast } = require('../../core/remote-policy');
const { FLOOR } = require('../../core/element-policy');
const { SCHEMAS, SCHEMA, CONVERTED, CHAIN_MAX, isEngineRecord, parsePin, typeOfId } = require('../../core/element-log');
const { pageOrder } = require('../domain/page');
const { headings } = require('../../core/markdown');
const { isRemoteRequest } = require('../../core/cors');
const { provenance, sendElement, queuedElementItem } = require('../domain/queue');
const { emitComments, emitElements, elementEvent, removeElement } = require('../domain/comments');
const { refsOf, refOf, putRef, anchorItem } = require('../domain/element-refs');
const { elementsForNode } = require('../domain/element-scope');
const { resolveNodeRef } = require('../domain/refs');
const { schemaForType } = require('../domain/elements');
const { STALE_HINT } = require('./writers');
const { boxGrabFor, imageBlock, TYPE: BOX_GRAB } = require('../box-grab');

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
const NO_WAKE_HINT = 'this element type sends nothing to Claude: its manifest does not declare wake';
const CHAIN_HINT = `a comment's chain is a list of at most ${CHAIN_MAX} distinct ids, each an element live on the page (a comment, a highlight, a box grab), smallest first`;

// Human-readable anchor for Claude — never raw DOM internals alone. A legacy
// locator ({mount, selector, text}) as before; a converted one (form
// pin-locator@1, element-log convertAnchor) by its fingerprint.text and
// path.selector, the same two fields (K.2-59); an engine record (lib/core/
// anchors.js) by its item (mount, or a markdown source's md) and its head
// text: an element record's fp.head, a range or source record's quote.exact.
// A pin on a markdown item (F.3, M3) says which section it is about: its
// locator's `section` (the chrome's comments.js) reads `on section "<heading>"`
// — the whole label for a heading pin, after the quoted text for a prose pin —
// and a bare source record with no locator reads its slug (`on section
// #<slug>`). Every other anchor's label is unchanged (the S-14 golden).
const HEADING_SELECTOR = /^h[1-6]$/;
const clip60 = (t) => (t.length > 60 ? t.slice(0, 60) + '…' : t);
function describeAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const item = a.mount || (isEngineRecord(a) ? a.md : null);
  if (!item) return null;
  const section = typeof a.section === 'string' ? a.section.trim() : '';
  const tag = typeof a.selector === 'string' ? a.selector.split('.')[0].toLowerCase() : '';
  if (section && HEADING_SELECTOR.test(tag)) return `${item}: on section "${clip60(section)}"`;
  const label = baseLabel(a, item);
  if (section) return `${label} — on section "${clip60(section)}"`;
  if (isEngineRecord(a) && a.kind === 'source' && typeof a.slug === 'string' && a.slug) return `${label} — on section #${a.slug}`;
  return label;
}
function baseLabel(a, item) {
  const conv = a.form === CONVERTED ? a : null;
  const head = a.text
    || (conv && conv.fingerprint && typeof conv.fingerprint.text === 'string' ? conv.fingerprint.text : '')
    || (isEngineRecord(a) && a.fp && typeof a.fp.head === 'string' ? a.fp.head : '')
    || (isEngineRecord(a) && a.quote && typeof a.quote.exact === 'string' ? a.quote.exact : '');
  const t = head && String(head).trim();
  if (t) return `${item}: "${clip60(t)}"`;
  const selector = a.selector || (conv && conv.path && typeof conv.path.selector === 'string' ? conv.path.selector : '');
  if (selector) return `${item} @ ${selector}`;
  return `${item} (whole pane)`;
}

// THE CHAIN LABEL (F.6): the member labels, smallest first (each "<type>
// <id>", "a removed <type> <id>" or "a private element"), then the derived
// structural levels — the anchor's pane, then its section. Pure: the caller
// reads the surface. Null for no member.
const typeWords = (type) => String(type).replace(/-/g, ' ');
function memberLabel({ id, type, present, hidden }) {
  if (hidden) return 'a private element';
  const t = type ? typeWords(type) : 'element';
  return present ? `${t} ${id}` : `a removed ${t} ${id}`;
}
function describeChain(members, { pane = null, section = null } = {}) {
  if (!Array.isArray(members) || !members.length) return null;
  const parts = members.map(memberLabel);
  if (pane) parts.push(`pane ${pane}`);
  if (section) parts.push(`section "${clip60(section)}"`);
  return `on ${parts.join(' › ')}`;
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
  // The box grab's engine, made now (after the boot's draft restore) so its
  // sweep fails a picture left pending by the last daemon (K.2-63).
  boxGrabFor(ctx);
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

  // A pin as the API serves it (already masked by the caller). Its `anchor`
  // keeps 0.8.5's shape for get_comments (the S-14 golden): a pin the chrome
  // dropped carries its engine record as the pin's anchor and the 0.8.5
  // locator beside it (`locator`, domain/elements project), so the locator is
  // served as `anchor` and the engine record as `record` — the version's own
  // anchor, which the chrome draws from (public/app/comments.js).
  // `view` says who reads and which surface (F.6's chain): {req} — the request,
  // for audience.seesPrivate — and {node} — a node read's node, whose own
  // copies, references and page order the chain label reads (the live
  // surface's when absent). A chainless pin's record is unchanged.
  function commentRecord(pin, view = {}) {
    const ver = isPosInt(pin.v) ? elements().version(pin.id, pin.v) : null;
    const payload = ver ? ver.payload : null;
    const { locator, chain, ...rest } = pin;
    const anchor = isObj(locator) ? locator : pin.anchor;
    const out = {
      ...rest,
      anchor,
      type: COMMENT,
      schema: ver ? ver.schema : SCHEMA,
      anchor_label: describeAnchor(anchor),
      record: payload && payload.anchor != null ? payload.anchor : null,
    };
    if (Array.isArray(chain) && chain.length) Object.assign(out, chainFields(chain, anchor, out.record, view));
    return out;
  }

  // ── the chain (F.6) ──
  // What a surface holds of element `id`: {type, shared} or null. The live
  // surface answers through find; a node through its own copies and references.
  function memberOn(id, node) {
    if (!node) {
      const f = find(id);
      return f ? { type: f.type || typeOfId(id), shared: f.shared } : null;
    }
    const c = (Array.isArray(node.comments) ? node.comments : []).find((x) => x && x.id === id);
    if (c) return { type: COMMENT, shared: c.shared };
    const held = refOf(node, id);
    if (!held) return null;
    const rec = elements().record(held.id, held.v);
    return { type: (rec && rec.type) || elements().typeOf(id) || typeOfId(id), shared: rec ? rec.shared : false };
  }
  // A member no longer on the surface is private when its newest version is.
  function wasPrivate(id) {
    const rec = safe(() => elements().latest(id));
    return !!(rec && rec.payload && rec.payload.shared === false);
  }
  // The members' ids that are private now: an event's `chain_private`.
  function chainPrivate(pin) {
    const out = [];
    for (const id of Array.isArray(pin && pin.chain) ? pin.chain : []) {
      const m = memberOn(id, null);
      if (m ? m.shared === false : wasPrivate(id)) out.push(id);
    }
    return out;
  }
  // A comment event: `chain_private` beside it for a chained pin only.
  function commentEvent(ev) {
    const pin = ev.pin;
    return pin && Array.isArray(pin.chain) && pin.chain.length ? { ...ev, chain_private: chainPrivate(pin) } : ev;
  }
  // The anchor's item, and the nearest #/## heading at or before it in the
  // surface's page order: the anchor's own section when it names one (a
  // markdown pin's locator, or its source record's slug), else the last such
  // heading of an earlier markdown item.
  function structureOf(anchor, record, node) {
    const a = isObj(anchor) ? anchor : {};
    const r = isObj(record) ? record : {};
    const item = a.mount != null ? String(a.mount) : r.mount != null ? String(r.mount) : r.md != null ? String(r.md) : null;
    if (item == null) return { pane: null, section: null };
    let order;
    let mdText;
    let isPane;
    if (node) {
      order = pageOrder(node);
      const md = new Map((Array.isArray(node.markdown) ? node.markdown : []).filter((m) => m && m.id != null).map((m) => [String(m.id), m]));
      mdText = (id) => (md.has(id) ? String(md.get(id).text || '') : null);
      const mounts = new Set((Array.isArray(node.mounts) ? node.mounts : []).filter((m) => m && m.id != null).map((m) => String(m.id)));
      isPane = (id) => mounts.has(id);
    } else {
      const mounts = state.mounts instanceof Map ? state.mounts : new Map();
      const md = state.markdown instanceof Map ? state.markdown : new Map();
      order = pageOrder({ mounts: [...mounts.keys()].map((id) => ({ id })), markdown: [...md.keys()].map((id) => ({ id })), order: state.order });
      mdText = (id) => (md.has(id) ? String((md.get(id) || {}).text || '') : null);
      isPane = (id) => mounts.has(id);
    }
    const tops = (id) => {
      const text = mdText(id);
      return text == null ? [] : headings(text).filter((h) => h.level <= 2);
    };
    let section = null;
    if (mdText(item) != null) {
      if (typeof a.section === 'string' && a.section.trim()) section = a.section.trim();
      else if (typeof r.slug === 'string' && r.slug) {
        const h = headings(mdText(item)).find((x) => x.slug === r.slug);
        if (h) section = h.text;
      }
    }
    const at = order.indexOf(item);
    for (let i = at - 1; section == null && i >= 0; i--) {
      const hs = tops(order[i]);
      if (hs.length) section = hs[hs.length - 1].text;
    }
    return { pane: isPane(item) ? item : null, section };
  }
  function chainFields(chain, anchor, record, { req = null, node = null } = {}) {
    const sees = !!(req && audience.seesPrivate(req));
    const members = chain.map((id) => {
      const m = memberOn(id, node);
      const hidden = !sees && (m ? m.shared === false : wasPrivate(id));
      return { id, type: m ? m.type : typeOfId(id), present: !!m, hidden };
    });
    return {
      chain: members.map((m) => (m.hidden ? null : m.id)),
      chain_label: describeChain(members, structureOf(anchor, record, node)),
    };
  }
  // A write's answered `pin` (today's shape): a chained pin's private members'
  // ids are null in its chain for a request that does not see private records,
  // as in the record's `chain`.
  function pinFor(pin, req) {
    if (!pin || !Array.isArray(pin.chain) || !pin.chain.length || audience.seesPrivate(req)) return pin;
    const hidden = new Set(chainPrivate(pin));
    return { ...pin, chain: pin.chain.map((id) => (hidden.has(id) ? null : id)) };
  }
  // POST's payload.chain: null (no chain), a list of ids, or a refusal.
  function chainOf(raw, req) {
    if (raw === undefined || raw === null) return { chain: null };
    if (!Array.isArray(raw) || raw.length > CHAIN_MAX) return { bad: true };
    if (!raw.length) return { chain: null };
    const sees = audience.seesPrivate(req);
    const seen = new Set();
    for (const id of raw) {
      if (typeof id !== 'string' || !id || seen.has(id)) return { bad: true };
      seen.add(id);
      const f = find(id);
      // A private element is not found by a request that does not see it (C-16-2).
      if (!f || (f.shared === false && !sees)) return { bad: true };
    }
    return { chain: raw.slice() };
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
      if (types.includes(COMMENT)) list = elements().maskPins(state.comments).map((p) => commentRecord(p, { req }));
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
      const nodeObj = graph.nodes.get(node);
      for (const row of elementsForNode(graph, elements(), node)) {
        const t = elements().typeOf(row.id);
        if (!types.includes(t)) continue;
        const v = row.newest_visible_v;
        let rec;
        if (t === COMMENT) {
          const pin = elements().project(row.id, v);
          rec = pin ? commentRecord(elements().maskPins([pin])[0], { req, node: nodeObj }) : null;
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
      // F.6: the live elements under the press, smallest first.
      const ch = chainOf(payload.chain, req);
      if (ch.bad) return res.status(400).json({ error: 'bad chain', hint: CHAIN_HINT });
      let pin;
      try {
        pin = elements().add({
          text: String(payload.text ?? ''),
          shared: payload.shared !== false,
          anchor: isObj(anchor) ? anchor : null,
          locator: isObj(b.locator) ? b.locator : null,
          chain: ch.chain,
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
      emitComments(state, bus, commentEvent({ kind: 'comment', op: 'add', pin }));
      return res.json({ ok: true, element: commentRecord(pin, { req }), pin: pinFor(pin, req) });
    }

    if (!info.schema || !hasOwn(SCHEMAS, info.schema)) {
      return res.status(400).json({ error: 'element type not writable', type: info.type, hint: NOT_WRITABLE_HINT });
    }
    // A box grab's payload is shaped by lib/server/box-grab (U328b).
    const grab = info.type === BOX_GRAB ? boxGrabFor(ctx).admit({ payload, anchor }, req) : null;
    if (grab && !grab.ok) return res.status(grab.status).json(grab.body);
    let rec;
    try {
      rec = elements().addElement({
        type: info.type,
        schema: info.schema,
        payload: grab ? grab.payload : { ...payload, anchor: anchor ?? null, shared: payload.shared !== false },
        author: 'user',
        writer,
        provenance: provenanceOf(req),
      });
    } catch (e) {
      if (grab) grab.ticket.release();
      if (refusedWrite(res, e)) return undefined;
      throw e;
    }
    putRef(state, rec.id, rec.v);
    // A box grab's add waits for its picture (`pending`): its queue item is
    // raised by the grab's settle (box-grab.js), never by the add.
    const added = elementEvent(state, 'add', rec);
    emitElements(state, bus, elements(), info.type, grab ? { ...added, pending: 'image' } : added);
    if (grab) boxGrabFor(ctx).created(rec, grab.ticket);
    return res.json({ ok: true, element: rec });
  });

  // ── THE EDIT ──────────────────────────────────────────────────────────────
  // A found element's edit, the one copy PATCH and Send to Claude both call
  // (F.5: a send shares a private element through it, so its event —
  // became_shared for a comment, was_shared: false for another type — raises
  // the item as a PATCH's does): a comment's {text, shared}; another type's
  // payload keys, from `payload` or named at the top level (as a comment's
  // {text, shared} are). The caller has applied the gates and the pane rule.
  // → {answered: true} when the answer was sent (read-only, a refused write),
  // else {status?, body, changed?}: the answer for the caller to send.
  const ANSWERED = Object.freeze({ answered: true });
  function editOf(req, res, found, b, writer) {
    if (found.type === COMMENT) {
      const prev = found.pin;
      const { text, shared } = b;
      let changed = false;
      if (text !== undefined && String(text) !== prev.text) changed = true;
      if (shared !== undefined && !!shared !== prev.shared) changed = true;
      if (!changed) return { body: { ok: true, pin: pinFor(prev, req), element: commentRecord(prev, { req }), unchanged: true } };
      if (readOnly(res)) return ANSWERED;
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
        if (refusedWrite(res, e)) return ANSWERED;
        throw e;
      }
      if (r.unchanged) return { body: { ok: true, pin: pinFor(prev, req), element: commentRecord(prev, { req }), unchanged: true } };
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
      emitComments(state, bus, commentEvent({ kind: 'comment', op: 'edit', pin, became_shared: becameShared, became_private: becamePrivate }));
      return { body: { ok: true, pin: pinFor(pin, req), element: commentRecord(pin, { req }) }, changed: true };
    }

    if (!found.rec) return { status: 409, body: { error: 'unmapped element', hint: UNMAPPED_HINT } };
    const row = SCHEMAS[found.rec.schema];
    const patch = {};
    const from = isObj(b.payload) ? b.payload : {};
    for (const k of Object.keys(from)) patch[k] = from[k];
    for (const k of row ? row.keys : []) if (hasOwn(b, k)) patch[k] = b[k];
    if (hasOwn(patch, 'shared')) patch.shared = patch.shared !== false;
    // A box grab is always shared and never edited (F5 (a); box-grab.js).
    const fixed = found.type === BOX_GRAB ? boxGrabFor(ctx).refusePatch(patch) : null;
    if (fixed) return { status: fixed.status, body: fixed.body };
    if (!Object.keys(patch).length) return { body: { ok: true, element: found.rec, unchanged: true } };
    if (readOnly(res)) return ANSWERED;
    let r;
    try {
      r = elements().editElement(found.held.id, found.held.v, { patch, writer, provenance: provenanceOf(req) });
    } catch (e) {
      if (refusedWrite(res, e)) return ANSWERED;
      throw e;
    }
    if (r.unchanged) return { body: { ok: true, element: r.element, unchanged: true } };
    putRef(state, r.element.id, r.element.v);
    // was_shared: the element's sharing before this edit, so the wake policy
    // raises an item for a private→shared toggle (K.2-63, as comments do).
    emitElements(state, bus, elements(), found.type, { ...elementEvent(state, 'edit', r.element), was_shared: found.rec.shared !== false });
    return { body: { ok: true, element: r.element }, changed: true };
  }

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

    if (found.type === COMMENT && hasOwn(b, 'anchor')) {
      const prev = found.pin;
      const { text, shared } = b;
      if (text !== undefined || shared !== undefined) return res.status(400).json({ error: 'a re-anchor changes the anchor only', hint: REANCHOR_HINT });
      if (readOnly(res)) return undefined;
      let r;
      try {
        r = elements().reanchor(prev, { anchor: isObj(b.anchor) ? b.anchor : null, writer, provenance: provenanceOf(req) });
      } catch (e) {
        if (refusedWrite(res, e)) return undefined;
        throw e;
      }
      if (r.unchanged) return res.json({ ok: true, pin: pinFor(prev, req), element: commentRecord(prev, { req }), unchanged: true });
      const next = state.comments.slice();
      next[found.idx] = r.pin;
      state.comments = next;
      // A re-anchor moves the pin, not its words: an op the wake policy
      // neither enqueues nor refreshes.
      emitComments(state, bus, commentEvent({ kind: 'comment', op: 'anchor', pin: r.pin }));
      return res.json({ ok: true, pin: pinFor(r.pin, req), element: commentRecord(r.pin, { req }) });
    }
    const r = editOf(req, res, found, b, writer);
    if (r.answered) return undefined;
    return res.status(r.status || 200).json(r.body);
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
    emitComments(state, bus, commentEvent({ kind: 'comment', op: 'reply', pin, author: who })); // no top-level id (C7)
    return res.json({ ok: true, pin: pinFor(pin, req), element: commentRecord(pin, { req }) });
  });

  // ── SEND TO CLAUDE ────────────────────────────────────────────────────────
  // F.5 (RULED REQ@highlight-send-to-claude M2 (a); J2 (a); U405@route): the
  // one tap on every element's tray. A PRIVATE element is shared first,
  // through the PATCH's own edit (editOf) under the PATCH's pane rule (B4:
  // attribution, never a boundary, C-15-1), and its event raises the item as
  // a PATCH's does — private stays self-annotation that never alerts Claude
  // until this tap. A SHARED one goes to the queue's sendElement: an item
  // already queued answers already: true; else its ring event with op 'send'
  // raises a fresh item through the wake policy (delivered, removed from the
  // rail, or never raised alike). Push still decides when. A type whose
  // manifest does not declare `wake: true` sends nothing to Claude (400);
  // the comment always does (the wake policy's comment arm). Gated as every
  // write: the floor's full (FLOOR_RULES' POST /api/elements/* row; no RULES
  // row of its own), a private element 404 to a reader who does not see it,
  // the type's own send gate, the store's read-only 503.
  // → {ok: true, element, item: {id}, already?: true}
  function wakes(type) {
    if (type === COMMENT) return true;
    const reg = registry();
    const d = reg && typeof reg.descriptor === 'function' ? safe(() => reg.descriptor(type)) : null;
    return !!(d && isObj(d.toolbar) && d.toolbar.wake === true);
  }
  // A box grab's send carries its picture's block, as its settle did
  // (lib/server/box-grab imageBlock over the live capture's image); a picture
  // still being drawn raises nothing yet (`pending`). A capture no longer live
  // leaves the event bare: sendElement takes the picture its last raise carried.
  function grabEvent(event, rec) {
    const cap = isObj(rec.grab) && typeof rec.grab.capture === 'string' ? rec.grab.capture : null;
    const live = cap && Array.isArray(state.captures) ? state.captures.find((c) => c && c.id === cap) : null;
    if (!live || !isObj(live.image)) return event;
    return live.image.state === 'pending' ? { ...event, pending: 'image' } : { ...event, image: imageBlock(cap, live.image) };
  }
  app.post('/api/elements/:id/send', gateOf(FLOOR.send), (req, res) => {
    const id = req.params.id;
    const found = find(id);
    if (!found) return res.status(404).json({ error: 'not found', id });
    if (hiddenPrivate(req, res, found.shared)) return undefined;
    if (!passes(infoOf(found.type).gate.send, req, res)) return undefined;
    if (!wakes(found.type)) return res.status(400).json({ error: 'not a type that wakes Claude', id, type: found.type, hint: NO_WAKE_HINT });
    const writer = writerOf(req, res);
    if (!writer) return undefined;
    if (readOnly(res)) return undefined;
    const isComment = found.type === COMMENT;
    if (!isComment && !found.rec) return res.status(409).json({ error: 'unmapped element', hint: UNMAPPED_HINT });

    if (found.shared === false) {
      if (refusedPane(res, writer, found.writer)) return undefined;
      const r = editOf(req, res, found, { shared: true }, writer);
      if (r.answered) return undefined;
      if (r.status && r.status !== 200) return res.status(r.status).json(r.body);
      const element = r.body.element;
      const item = queuedElementItem(state, id);
      if (!item) return res.status(409).json({ ok: false, error: 'not raised', element, hint: NO_WAKE_HINT });
      return res.json({ ok: true, element, item: { id: item.id } });
    }

    const event = isComment
      ? commentEvent({ kind: 'comment', op: 'send', pin: found.pin })
      : grabEvent(elementEvent(state, 'send', found.rec), found.rec);
    const sent = sendElement(state, bus, id, event);
    if (!sent.ok) return res.status(sent.status).json({ ok: false, error: sent.error, hint: sent.hint });
    const element = isComment ? commentRecord(found.pin, { req }) : found.rec;
    return res.json({ ok: true, element, item: { id: sent.item.id }, ...(sent.already ? { already: true } : {}) });
  });

  // ── A BOX GRAB'S PICTURE ──────────────────────────────────────────────────
  // The one PNG the grab's capture holds (U328b, F4 (a)): the bytes the user
  // sees on the card are the bytes Claude reads. Gated as the element's own
  // read (F5 (a): the type's see level, read, under FLOOR_RULES' GET
  // /api/elements/* row; no RULES row of its own); a private element answers
  // 404 to anyone who does not see private ones. The element is found in the
  // log, not only on the live surface, so a committed or wiped grab's
  // picture stays reachable.
  app.get('/api/elements/:id/grab', gateOf(FLOOR.see), (req, res) => {
    const id = req.params.id;
    const latest = elements().typeOf(id) === BOX_GRAB ? elements().latest(id) : null;
    const rec = latest ? elements().record(id, latest.v) : null;
    if (!rec) return res.status(404).json({ error: 'not found', id });
    if (hiddenPrivate(req, res, rec.shared)) return undefined;
    if (!passes(infoOf(BOX_GRAB).gate.see, req, res)) return undefined;
    return boxGrabFor(ctx).serve(req, res, rec);
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

module.exports = { mountElementRoutes, describeAnchor, describeChain };

'use strict';
// A detached glyph's move (annotation engine tranche 4, U587; spec H.7;
// DECISIONS L.1 M4 a, K.2-151; RULED U587@glyph-offset-store AI5 a):
//
//   POST /api/elements/:id/glyph {dx, dy, corner, base_v?, device?}
//
// Moves the glyph of a type whose manifest declares `glyph: {detach: true}`
// (lib/packs/elements.js; the element-type registry's listing row) to an
// offset {dx, dy} in CSS px from the corner of its anchor's box it is
// measured from (`corner`: tl, tr, bl, br — domain/elements GLYPH_CORNERS),
// so the glyph follows its anchor through a re-layout. The move is ONE
// version through the element store's moveGlyph: its payload is its parent's
// (payload_hash and src_hash unchanged, the anchor untouched) beside a new
// `display` sibling {glyph: {dx, dy, corner}}, stamped with the caller's
// writer — so a node commits when a glyph moves (the live surface is dirty),
// a preview, an export and a replay that pin id@v draw the placement as it
// was, and the engine's undo (POST /api/elements/undo, U518) retracts a move
// by the same rule as any version (AF9, AF10). A comment moves through its
// live 0.8.5 copy (state.comments), whose v advances as an edit's does.
//
// 200 {ok: true, id, type, v, display} (`unchanged: true` when the glyph is
// already there: nothing appended). 400 a bad offset (the hint names the
// grammar), a type that does not detach, a chat element; 404 an id the live
// surface does not hold — and a PRIVATE element for any reader that does not
// see private records (audience.seesPrivate: AD5/J2, C-16-2), the GET's
// answer, so a move answers nothing about it; 401 a stale writer token; 403 a
// pane moving an element it did not add (B4's rule, as the PATCH holds it); 409
// a base_v the live version is not, or a version the log cannot write again
// this boot; 503 read-only.
//
// WHO. The element floor's send level (FLOOR.send, full) and the type's own
// send gate (the element routes' ctx.elementGates, read per request) —
// remotely the portal's existing `POST /api/elements/*` floor row decides it,
// so this route adds no RULES row and no protocol bump (PROTO@none). The
// writer stamp ATTRIBUTES (C-15-1..3): it grants nothing.
//
// Its ring event: a comment's emitComments {kind: 'comment', op: 'move', pin}
// (through commentEventFor, the chain_private rule's one home); any other
// type's emitElements with elementEvent 'move' and was_shared. 'move' is an op
// the wake policy neither enqueues nor refreshes (lib/channel/policy
// declarative): a placement says nothing new to Claude.
//
// Its own file (every new route is; routes/elements.js is U513's), mounted
// after the element routes (lib/server/index.js): '/api/elements/:id/glyph'
// is longer than every element route's path, so no order between them
// matters.

const { FLOOR } = require('../../core/element-policy');
const { refOf, putRef } = require('../domain/element-refs');
const { emitComments, emitElements, elementEvent } = require('../domain/comments');
const { glyphProblem, GLYPH_CORNERS, GLYPH_OFFSET_MAX } = require('../domain/elements');
const { stampOf, provenanceOf, commentEventFor, READ_ONLY_ERROR, READ_ONLY_HINT } = require('./elements');
const { STALE_HINT } = require('./writers');

const COMMENT = 'comment';
const GLYPH_HINT = `a glyph move is {dx, dy, corner}: dx and dy numbers of CSS px (at most ${GLYPH_OFFSET_MAX}) from the anchor box's corner, corner one of ${GLYPH_CORNERS.join(', ')}`;
const NOT_DETACHED_HINT = 'this element type\'s glyph stays at its anchor: its element.json does not declare "glyph": {"detach": true}';
const CHAT_HINT = 'a chat pin stays where the chat layer draws it: it is never detached';
const PANE_MOVE_HINT = 'a pane moves only the glyphs of the elements it added';
const STALE_VERSION_HINT = 'the element changed since you read it: read it again and retry';
const NOT_MOVABLE_HINT = 'that version cannot be written again in the element log this boot (its type\'s schema is not registered)';
const UNMAPPED_HINT = 'this element cannot be recorded in the element log; run claude-web-chat migrate for the report';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const safe = (fn) => { try { return fn(); } catch { return null; } };

function mountElementGlyphRoutes(app, ctx) {
  const { state, bus, audience, writers, graph } = ctx;
  if (!writers || typeof writers.resolveWriter !== 'function') throw new TypeError('mountElementGlyphRoutes: ctx.writers is required');
  if (!graph) throw new TypeError('mountElementGlyphRoutes: ctx.graph (its element store) is required');
  // Reached through the graph and the ctx on every call, never captured.
  const elements = () => graph.elements;
  const commentEvent = commentEventFor(state, elements);

  // Whether a type's manifest detaches its glyph: the registry's listing row
  // (its toolbar bag carries element.json's `glyph` as written).
  function detaches(type) {
    const reg = ctx.elementTypes && typeof ctx.elementTypes === 'object' ? ctx.elementTypes : null;
    const row = reg && typeof reg.descriptor === 'function' ? safe(() => reg.descriptor(type)) : null;
    const g = row && isObj(row.toolbar) ? row.toolbar.glyph : null;
    return isObj(g) && g.detach === true;
  }

  // The element `id` names on the live surface: a comment's copy, or a reference.
  function find(store, id) {
    const comments = Array.isArray(state.comments) ? state.comments : [];
    const idx = comments.findIndex((c) => c && c.id === id);
    if (idx >= 0) {
      const pin = comments[idx];
      return { type: COMMENT, idx, pin, shared: pin.shared !== false, writer: pin.writer || null, v: pin.v };
    }
    const held = refOf(state, id);
    if (!held) return null;
    const rec = store.record(held.id, held.v);
    // A reference the log cannot read fails closed: private.
    if (!rec) return { type: store.typeOf(id), held, rec: null, shared: false, writer: null, v: held.v };
    return { type: rec.type, held, rec, shared: rec.shared !== false, writer: rec.writer || null, v: held.v };
  }

  app.post('/api/elements/:id/glyph', audience.requireMirror(FLOOR.send), (req, res) => {
    const store = elements();
    if (!store) return res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
    const id = String(req.params.id);
    const found = find(store, id);
    if (!found) return res.status(404).json({ error: 'not found', id });
    if (!found.shared && !audience.seesPrivate(req)) return res.status(404).json({ error: 'not found', id });
    const gates = ctx.elementGates;
    if (gates && typeof gates.infoOf === 'function' && typeof gates.passes === 'function') {
      if (!gates.passes(gates.infoOf(found.type).gate.send, req, res)) return undefined;
    }
    if (typeof store.familyOf === 'function' && store.familyOf(found.type) === 'chat') {
      return res.status(400).json({ error: 'not detachable', id, hint: CHAT_HINT });
    }
    if (!detaches(found.type)) return res.status(400).json({ error: 'not detachable', id, type: found.type, hint: NOT_DETACHED_HINT });
    const b = isObj(req.body) ? req.body : {};
    const glyph = { dx: b.dx, dy: b.dy, corner: b.corner };
    if (glyphProblem(glyph)) return res.status(400).json({ error: 'bad glyph', hint: GLYPH_HINT });
    if (b.base_v != null && b.base_v !== found.v) {
      return res.status(409).json({ error: 'stale version', id, v: found.v ?? null, hint: STALE_VERSION_HINT });
    }
    const w = writers.resolveWriter(req, req.body, { pane: true });
    if (w.stale) return res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT });
    const writer = stampOf(w);
    // Ruling B4: a pane moves only the elements it added.
    if (writer.class === 'pane' && !(found.writer && found.writer.owner === writer.owner)) {
      return res.status(403).json({ ok: false, writer: 'pane', hint: PANE_MOVE_HINT });
    }
    if (store.readOnly) return res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
    if (found.type !== COMMENT && !found.rec) return res.status(409).json({ error: 'unmapped element', hint: UNMAPPED_HINT });
    let r;
    try {
      r = store.moveGlyph(id, {
        glyph,
        ...(found.type === COMMENT ? { pin: found.pin } : { v: found.held.v }),
        writer,
        provenance: provenanceOf(req),
      });
    } catch (e) {
      if (e && e.code === 'READ_ONLY') return res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
      if (e && e.code === 'UNMAPPED') return res.status(409).json({ error: 'unmapped element', hint: UNMAPPED_HINT });
      if (e instanceof TypeError && e.reason === 'family') return res.status(400).json({ error: 'not detachable', id, hint: CHAT_HINT });
      if (e instanceof TypeError && e.reason === 'glyph') return res.status(400).json({ error: 'bad glyph', hint: GLYPH_HINT });
      if (e instanceof TypeError && (e.reason || /^appendVersion:/.test(e.message))) {
        return res.status(409).json({ ok: false, error: 'not movable', hint: NOT_MOVABLE_HINT });
      }
      throw e;
    }
    const now = found.type === COMMENT ? r.pin : r.element;
    const body = { ok: true, id, type: found.type, v: now.v, display: now.display || null };
    if (r.unchanged) return res.json({ ...body, unchanged: true });
    if (found.type === COMMENT) {
      // The store's pin where the live one was (a new array: the bus ring and a
      // queued item may hold the old one).
      const next = state.comments.slice();
      const idx = next.findIndex((c) => c && c.id === id);
      if (idx >= 0) next[idx] = r.pin;
      state.comments = next;
      emitComments(state, bus, commentEvent({ kind: 'comment', op: 'move', pin: r.pin }));
    } else {
      putRef(state, now.id, now.v);
      emitElements(state, bus, store, found.type, { ...elementEvent(state, 'move', now), was_shared: found.shared });
    }
    return res.json(body);
  });
}

module.exports = { mountElementGlyphRoutes, GLYPH_HINT };

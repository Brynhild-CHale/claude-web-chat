'use strict';
// The engine's undo (annotation engine 4A.3, U518; DECISIONS N.1 AD6, AF9,
// AF10, AI13):
//
//   POST /api/elements/undo {item?, device?}
//
// Retracts the newest live version the caller's own writer stamp wrote on
// `item` (a pane or markdown item id), or, with no item, anywhere on the page
// (the answer names the item undone): lib/server/domain/element-undo
// undoOnItem, for every page type and pack. 200 {ok: true, undone, newer?,
// hint?}; 409 {ok: false, error: 'nothing to undo', hint, newer?}.
//
// WHO. The element floor's send level (FLOOR.send, full: the Send to Claude
// and the PATCH's own level) — remotely the portal's existing
// `POST /api/elements/*` floor row decides it, so this route adds no RULES
// row and no protocol bump (PROTO@none). The writer is the request's
// (writers.resolveWriter through routes/elements stampOf: a local browser
// 'user', a stamped pane 'pane:<id>', a remote viewer 'remote', Claude's token
// 'claude'); a stale writer token answers 401 as the element writes do. The
// stamp ATTRIBUTES — it picks which version is the caller's and grants
// nothing (C-15-1..3). A reader that does not see private records
// (audience.seesPrivate) neither undoes nor is told of a private one.
//
// READ-ONLY: while the element store is read-only, 503 with the element
// routes' own hint, and nothing is touched.
//
// Mounted before the element routes (lib/server/index.js), so `undo` is never
// read as an element id.

const { FLOOR } = require('../../core/element-policy');
const { undoOnItem } = require('../domain/element-undo');
const { stampOf, provenanceOf, commentEventFor, READ_ONLY_ERROR, READ_ONLY_HINT } = require('./elements');
const { STALE_HINT } = require('./writers');

// An item id as the page names one (a pane or a markdown item: one id space).
const ITEM_MAX = 256;
const ITEM_HINT = `item is a pane or markdown item id (a string of at most ${ITEM_MAX} characters), or absent for the whole page`;
const REVERT_HINT = 'that version cannot be reverted in the element log this boot (its type\'s schema is not registered); remove the annotation or edit it instead';

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function mountElementUndoRoutes(app, ctx) {
  const { state, bus, audience, writers, graph } = ctx;
  if (!writers || typeof writers.resolveWriter !== 'function') throw new TypeError('mountElementUndoRoutes: ctx.writers is required');
  if (!graph) throw new TypeError('mountElementUndoRoutes: ctx.graph (its element store) is required');
  // Reached through the graph on every call, never captured (the element
  // routes' rule: the store hangs on the graph).
  const elements = () => graph.elements;
  const commentEvent = commentEventFor(state, elements);

  app.post('/api/elements/undo', audience.requireMirror(FLOOR.send), (req, res) => {
    const store = elements();
    if (!store) return res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
    const b = isObj(req.body) ? req.body : {};
    let item = null;
    if (b.item !== undefined && b.item !== null) {
      if (typeof b.item !== 'string' || !b.item || b.item.length > ITEM_MAX) {
        return res.status(400).json({ error: 'bad item', hint: ITEM_HINT });
      }
      item = b.item;
    }
    const w = writers.resolveWriter(req, req.body, { pane: true });
    if (w.stale) return res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT });
    if (store.readOnly) return res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
    let r;
    try {
      r = undoOnItem({ state, bus, elements: store, commentEvent }, {
        item,
        writer: stampOf(w),
        provenance: provenanceOf(req),
        seesPrivate: audience.seesPrivate(req),
      });
    } catch (e) {
      if (e && e.code === 'READ_ONLY') return res.status(503).json({ error: READ_ONLY_ERROR, hint: READ_ONLY_HINT });
      if (e && e.code === 'UNMAPPED') return res.status(409).json({ ok: false, error: 'not revertible', hint: REVERT_HINT });
      if (e instanceof TypeError && (e.reason || /^appendVersion:/.test(e.message))) {
        return res.status(409).json({ ok: false, error: 'not revertible', hint: REVERT_HINT });
      }
      throw e;
    }
    if (!r.ok) {
      const { status, ...body } = r;
      return res.status(status).json(body);
    }
    return res.json(r);
  });
}

module.exports = { mountElementUndoRoutes };

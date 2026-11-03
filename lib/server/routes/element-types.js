'use strict';
// GET /api/elements/types — the element types this daemon lists (annotation
// engine tranche 2, PLAN.md 2C.3): ctx.elementTypes' rows, for the chrome's
// reads gate (public/app/element-types.js) and the toolbar.
//
//   → {ok: true, types: [{type, schema, reads, anchors, family, remote,
//      private, builtin, tier, pack, toolbar, draw?}], reserved: [<built-in names>]}
//
// `draw` (U511): on a plug-in type's row only, {sha256} — the digest the
// pack's records hold for its draw.js (lib/server/element-files drawDigest,
// over the same recordedDigests the file route checks, so the listing and the
// route's ETag never disagree; null when the records do not agree). The chrome
// puts it in its import URL as a cache key (`?d=<sha256>`, which the route
// ignores). A built-in row carries no `draw`: its draw code is the chrome's own.
//
// `reserved` names the built-in types (lib/core/names), which the chrome's
// own code draws: a built-in the listing lacks (its boot install failed —
// U323's daemon still boots) is drawn by the chrome as before rather than
// marked unknown. It lists nothing and grants nothing.
//
// Read and above (audience.requireMirror('read')), as the element API's reads are.
// Remotely it is reached through element-policy FLOOR_RULES' existing
// `GET /api/elements/*` row — no RULES row of its own, no protocol change. A
// type whose gate's `see` the viewer's level does not meet is left out of
// that viewer's listing. No row carries a record, a pane's text or a host
// path.
//
// Mounted BEFORE the element routes (U325), whose `/api/elements/:id` would
// otherwise take `types` for an element id.

const { BUILTIN_ELEMENT_TYPE_NAMES } = require('../../core/names');
const { drawDigest } = require('../element-files');

const TYPES_PATH = '/api/elements/types';

function mountElementTypeRoutes(app, ctx) {
  const { audience, elementTypes } = ctx;
  const drawOf = (row) => {
    const sha256 = drawDigest(ctx, row);
    return sha256 ? { sha256 } : null;
  };
  app.get(TYPES_PATH, audience.requireMirror('read'), (req, res) => {
    const level = audience.levelOf(req);
    const types = elementTypes.list()
      .filter((row) => {
        const gate = elementTypes.gate(row.type);
        return gate && audience.atLeast(level, gate.see);
      })
      .map((row) => ({
        type: row.type,
        schema: row.schema,
        reads: row.reads.slice(),
        anchors: row.anchors.slice(),
        family: row.family,
        remote: { see: row.remote.see, send: row.remote.send },
        private: row.private,
        builtin: row.builtin,
        tier: row.tier,
        pack: row.pack,
        toolbar: row.toolbar,
        ...(row.builtin ? {} : { draw: drawOf(row) }),
      }));
    res.json({ ok: true, types, reserved: BUILTIN_ELEMENT_TYPE_NAMES.slice() });
  });
}

module.exports = { mountElementTypeRoutes, TYPES_PATH };

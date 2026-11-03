'use strict';
// A stroke group's picture (annotation engine tranche 4, 4F.2; U564;
// DECISIONS N.1 AD3, AD5; K.5 J2; L.5 F4 (a) — one PNG, one image block;
// RULED PICTURE@when AG3 (a), U564@request-path-grab-event (a),
// U563-U580@catalogue-tool-edits (a)):
//
//   GET  /api/elements/:id/picture[?as=json]
//        The newest picture of the element's stroke group (?capture=<id>:
//        that picture of it, when it shows the element; lib/server/
//        box-grab pictureOf): the PNG bytes (no-store), or with ?as=json
//        {ok, id, capture, type, elements: [id@v…], describe?, previous?,
//        new?, image, mimeType?, data?} — the image block and, when ready,
//        the same bytes base64 (inspect_capture's one call). 404 when there is
//        no picture yet. Gated as the box grab's own GET /api/elements/:id/grab:
//        the floor's see level (read), a private element 404 to any reader that
//        does not see private records (audience.seesPrivate: AD5/J2, C-16-2),
//        and the type's own see gate (the element routes' ctx.elementGates).
//   POST /api/elements/:id/picture
//        HOST ONLY (audience.requireHost: Claude's tools, lib/client — a
//        pane's fetch, a browser and a remote viewer are refused 403):
//        box-grab picture(id, {reason: 'request'}) — renders the group's
//        picture, or answers the one that already shows exactly its versions
//        — then long-polls the image's settle up to RENDER_TIMEOUT_MS and
//        answers the body above without `data` (inspect_capture then reads the
//        capture). 404 an id the surface does not hold, and a private one (the
//        host never sees private records: a request answers nothing about
//        one, C-16-2); 400 an element that is not a stroke; 429 the render
//        queue full; 503 stopping. Its settle raises no queue item: the image
//        folds onto the group's item only when an undelivered one exists.
//
// Under the floor rows GET/POST /api/elements/* (remote-policy FLOOR_RULES):
// no RULES row, no protocol bump (PROTO@none). Its own file, mounted after
// the element routes (lib/server/index.js): '/api/elements/:id/picture' is
// deeper than every element route's path, so no order between them matters.
// Nothing here builds a document or reads a pin: the engine renders from the
// shared-only export document (lib/server/box-grab).

const { FLOOR } = require('../../core/element-policy');
const { boxGrabFor, RENDER_TIMEOUT_MS } = require('../box-grab');

const safe = (fn) => { try { return fn(); } catch { return null; } };

function mountElementPictureRoutes(app, ctx) {
  const { audience, graph } = ctx;
  if (!audience || typeof audience.requireHost !== 'function') throw new TypeError('mountElementPictureRoutes: ctx.audience is required');
  if (!graph) throw new TypeError('mountElementPictureRoutes: ctx.graph (its element store) is required');
  const elements = () => graph.elements;

  // The element's newest version in the log (a committed or wiped stroke's
  // picture stays reachable), or null.
  function newest(id) {
    const store = elements();
    if (!store) return null;
    const latest = safe(() => store.latest(id));
    return latest ? safe(() => store.record(id, latest.v)) : null;
  }
  // The type's own see gate, through the element routes' resolver; true when
  // it passes (else the 403 has been sent).
  function seeGate(type, req, res) {
    const gates = ctx.elementGates;
    if (!gates || typeof gates.infoOf !== 'function' || typeof gates.passes !== 'function') return true;
    return gates.passes(gates.infoOf(type).gate.see, req, res);
  }
  const hidden = (rec, req) => rec.shared === false && !audience.seesPrivate(req);

  app.get('/api/elements/:id/picture', audience.requireMirror(FLOOR.see), (req, res) => {
    const id = String(req.params.id);
    const rec = newest(id);
    if (!rec || hidden(rec, req)) return res.status(404).json({ error: 'not found', id });
    if (!seeGate(rec.type, req, res)) return undefined;
    return boxGrabFor(ctx).servePicture(req, res, id);
  });

  app.post('/api/elements/:id/picture', audience.requireHost(), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const rec = newest(id);
      if (!rec || hidden(rec, req)) return res.status(404).json({ error: 'not found', id });
      const engine = boxGrabFor(ctx);
      const made = engine.picture(id, { reason: 'request', req });
      if (!made.ok) {
        return res.status(made.status || 409).json({ ok: false, error: made.refused, refused: made.refused, hint: made.hint });
      }
      await engine.whenSettled(made.capture, RENDER_TIMEOUT_MS);
      return res.json({ ...engine.pictureBody(id, made.record), ...(made.reused ? { reused: true } : {}) });
    } catch (e) { return next(e); }
  });
}

module.exports = { mountElementPictureRoutes };

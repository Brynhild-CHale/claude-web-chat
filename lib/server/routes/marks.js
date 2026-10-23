'use strict';
// The transient marks over HTTP (annotation engine 2B.2, U313; DECISIONS.md
// C6; notes-B Q8): the write path of lib/server/domain/marks (ctx.marks).
//
//   POST /api/marks {marks}  REPLACE-ALL: the caller's set becomes `marks`; an
//        empty list clears it. → 200 {ok, owner, count} | 400 / 409 / 413
//        {ok:false, error, field?, hint} | 401 {ok:false, writer:'stale',
//        hint} for a writer token from an earlier boot (lib/driver leases
//        again on it and retries, as for its other writes).
//   GET  /api/marks          → {ok, sets: [{owner, marks, writer, at}]}
//
// Both are HOST ONLY (ctx.audience.requireHost: a remote request — X-WC-Remote
// through the portal — a network peer and a browser are refused 403);
// lib/core/remote-policy RULES refuses `* /api/marks` at the portal too. A
// local process writes through lib/driver (setMarks / clearMarks), a service
// through the driver its runner hands it, Claude's tools through lib/client.
//
// THE OWNER is the writers domain's answer (ctx.writers.resolveWriter(req,
// body)): a lease's or a service child's credential names it; a tokenless
// local caller's body `owner` is a declaration, attributed as such
// (verified: false). The set is keyed by that owner and stamped with the
// writer {class, owner, verified} beside it — attribution, never
// authorization (C-15-3): no write is refused for its owner or its class
// (C-15-2), and requireHost is a transport gate on where a request comes
// from, not an identity rule (C-15-1).
//
// Nothing here touches the store, the graph, a node or the event ring: the
// holder announces a change with a ws-only `marks` frame.

const { STALE_HINT } = require('./writers');

function mountMarksRoutes(app, { marks, writers, audience }) {
  if (!marks || typeof marks.set !== 'function') throw new TypeError('mountMarksRoutes: ctx.marks is required');
  if (!writers || typeof writers.resolveWriter !== 'function') throw new TypeError('mountMarksRoutes: ctx.writers is required');
  if (!audience || typeof audience.requireHost !== 'function') throw new TypeError('mountMarksRoutes: ctx.audience is required');
  const hostOnly = audience.requireHost();

  app.get('/api/marks', hostOnly, (req, res) => {
    res.json({ ok: true, sets: marks.list() });
  });

  app.post('/api/marks', hostOnly, (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const w = writers.resolveWriter(req, body);
    if (w.stale) return res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT });
    const writer = { class: w.class, owner: w.owner, verified: w.verified === true };
    const r = marks.set(w.owner, body.marks, { writer });
    if (!r.ok) {
      const { status, ...rest } = r;
      return res.status(status || 400).json(rest);
    }
    return res.json({ ...r, writer });
  });
}

module.exports = { mountMarksRoutes };

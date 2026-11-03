'use strict';
// The C4 form-shift counter over HTTP (annotation engine 4D.1; DECISIONS.md
// C4): the maintainer's read of lib/server/domain/form-shifts, at each release.
//
//   GET /api/forms/shifts → {ok, current, releases: {<version>: {first_at,
//       last_at, applies, applies_with_shift, kept, shifted, missing}}}
//
// HOST ONLY (ctx.audience.requireHost: a remote request — X-WC-Remote through
// the portal — a network peer and a browser are refused 403); lib/core/
// remote-policy RULES refuses `* /api/forms/*` at the portal too. The counter
// rides as the third argument (mountTunnelRoutes' precedent), never a ctx key.
// Counts and timestamps only: nothing here names a mount, a key or a value.

function mountFormRoutes(app, { audience }, { formShifts } = {}) {
  if (!formShifts || typeof formShifts.read !== 'function') throw new TypeError('mountFormRoutes: formShifts is required');
  if (!audience || typeof audience.requireHost !== 'function') throw new TypeError('mountFormRoutes: ctx.audience is required');
  const hostOnly = audience.requireHost();

  app.get('/api/forms/shifts', hostOnly, (req, res) => {
    res.json({ ok: true, ...formShifts.read() });
  });
}

module.exports = { mountFormRoutes };

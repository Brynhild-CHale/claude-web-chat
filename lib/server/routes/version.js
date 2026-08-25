// Version surface. GET /api/version reports the running build vs the latest
// GitHub RELEASE (throttled + cached in update/check — one home for "is an
// update available").
//
// There is deliberately no POST /api/update. A one-click self-update used to
// live here, spawning a detached `claude-web-chat update`; it was removed
// because updating is a deployment decision, not a page interaction. It could
// also destroy an `npm link` development install with no warning, and — since
// "newer" was decided by string inequality — it would happily install a
// DOWNGRADE over a build that was ahead of the last release. The surface now
// tells the user a release exists and how to take it; the taking is theirs.

const { resolveLatest } = require('../../update/check');
const pkg = require('../../../package.json');

function mountVersionRoutes(app) {
  app.get('/api/version', async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    let info;
    try {
      info = await resolveLatest({ currentVersion: pkg.version, force });
    } catch {
      info = { current: pkg.version, latest: null, updateAvailable: false, checkedAt: 0 };
    }
    res.json({ ok: true, ...info });
  });
}

module.exports = { mountVersionRoutes };

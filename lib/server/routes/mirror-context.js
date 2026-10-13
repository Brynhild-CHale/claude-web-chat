// GET /api/mirror/context?conversation=<id> — the context meter's one read
// (spec §15.7 'Session controls'; notes-C D8; ruled D1 (a)).
//
//   200 {ok: true, context: {tokens, window, percent, at} | null}
//   400 {ok: false, error}            no conversation, or not a single id
//   404 {ok: false, error: 'not found'}   an id over ID_MAX characters
//   503 {ok: false, unavailable: true}    the readings are not wired
//
// What it answers is the newest reading the web-chat mod's `session.measure`
// left for that conversation's sessions (lib/server/control/session-ops.js
// createContextReadings, kept per session from the hook tap): numbers only.
// The rate limits and the cost the event carries never reach the reading, so
// they never reach here. `context: null` is "no reading yet" — Claude Code has
// not measured this conversation since the daemon saw it, or no mod is
// attached — and the chrome hides the meter: there is no transcript fallback
// (D1 (a)), and the meta line's cumulative token counts are not the context's
// size (public/app/chat-panel.js), so nothing here guesses.
//
// Class P0, read-open: numbers, a GET. Behind ctx.audience.requireMirror('read')
// as every other /api/mirror/* route (routes/mirror-tasks.js), and covered by
// remote-policy's existing `GET /api/mirror/*` row at read — no row of its own.
//
// The readings come from ctx.contextReadings (lib/server/index.js wires
// createContextReadings({hooks, mirror}) and stops it in both teardown paths),
// read per request, or from opts.readings (a test's).

const { ID_MAX, BadParam, NotFound, NOT_FOUND, idParam } = require('./mirror-query');

function mountMirrorContextRoutes(app, ctx, { readings = null } = {}) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    // Fail at boot rather than serve the reading with no gate in front of it.
    throw new TypeError('mountMirrorContextRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  const gate = audience.requireMirror('read');
  const source = () => readings || (ctx && ctx.contextReadings) || null;

  app.get('/api/mirror/context', gate, (req, res) => {
    let cid;
    try {
      cid = idParam(req.query || {}, 'conversation');
      if (cid === undefined) throw new BadParam('conversation: an id');
    } catch (e) {
      if (e instanceof NotFound) return res.status(404).json(NOT_FOUND);
      return res.status(400).json({ ok: false, error: e instanceof BadParam ? e.message : 'conversation: an id' });
    }
    const r = source();
    if (!r || typeof r.forConversation !== 'function') return res.status(503).json({ ok: false, unavailable: true });
    let context = null;
    try { context = r.forConversation(cid); } catch { context = null; }
    const out = context ? { tokens: context.tokens, window: context.window, percent: context.percent, at: context.at } : null;
    return res.json({ ok: true, context: out });
  });
}

module.exports = { mountMirrorContextRoutes, ID_MAX };

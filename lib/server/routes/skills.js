// The composer's `/` catalog over HTTP (spec §6.2, U58).
//
//   GET /api/skills?conversation=<id>
//     behind ctx.audience.requireMirror('full') (§5.4; the portal's row is
//     lib/core/remote-policy's): a local viewer, or a remote one whose project
//     opted in at `full`.
//     conversation  the target conversation (absent: the primary one); parsed
//                   with routes/mirror-query's idParam, so one over its ID_MAX
//                   is 404
//     → 200 {ok: true, conversation, source: 'session'|'disk', partial,
//            skills: [{name, description, origin}], note}
//     → 200 {ok: true, disabled: true, skills: [], note} while the chat mirror is off
//     → 503 through routes/mirror's mirrorFor when no mirror is wired
//     → 500 through routes/mirror's sendFailure, which never sends the error's
//       message
//
// The body is exactly §6.2's: no as_of, and nothing about the organisation,
// the account or a path on disk (those never leave lib/server/skills.js).
//
// THIN. The catalog is ctx.skills (lib/server/skills createSkillCatalog),
// built once by lib/server/index.js (U66a) so the queue's message route
// resolves a `/name` against the same catalog the popover offered.

const { mirrorFor, sendFailure } = require('./mirror');
const { idParam, isPlain, BadParam, NotFound, NOT_FOUND } = require('./mirror-query');

const SKILLS_ROUTE = '/api/skills';
const NOTE = 'A skill picked here asks Claude to run it with the Skill tool; it is not a terminal command.';
const ORIGINS = new Set(['project', 'user', 'command', 'plugin', 'synced', 'session']);

// Only {name, description, origin} triples of the right types leave the route.
function skillsOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!isPlain(s) || typeof s.name !== 'string' || !ORIGINS.has(s.origin)) continue;
    out.push({ name: s.name, description: typeof s.description === 'string' ? s.description : '', origin: s.origin });
  }
  return out;
}

function mountSkillsRoutes(app, ctx) {
  const audience = ctx && ctx.audience;
  if (!audience || typeof audience.requireMirror !== 'function') {
    throw new TypeError('mountSkillsRoutes needs ctx.audience (lib/server/audience): requireMirror');
  }
  const skills = ctx.skills;
  if (!skills || typeof skills.catalog !== 'function') {
    throw new TypeError('mountSkillsRoutes needs ctx.skills (lib/server/skills createSkillCatalog)');
  }

  app.get(SKILLS_ROUTE, audience.requireMirror('full'), async (req, res) => {
    let conversation;
    try {
      conversation = idParam(req.query || {}, 'conversation');
    } catch (e) {
      if (e instanceof NotFound) return res.status(404).json(NOT_FOUND);
      if (e instanceof BadParam) return res.status(400).json({ ok: false, error: e.message });
      return sendFailure(res, e, `GET ${SKILLS_ROUTE}`);
    }
    try {
      // Off answers with an empty catalog, before any wait (enabled() may
      // answer at once or as a Promise).
      const m = ctx.mirror;
      const on = m && typeof m.enabled === 'function' ? await m.enabled() : null;
      if (isPlain(on) && on.enabled === false) return res.json({ ok: true, disabled: true, skills: [], note: NOTE });
      const mirror = await mirrorFor(ctx, res);
      if (!mirror) return undefined; // answered: 503, or switched off meanwhile
      const r = await skills.catalog(conversation === undefined ? null : conversation);
      if (!isPlain(r)) throw new TypeError('the skill catalog answered no object');
      return res.json({
        ok: true,
        conversation: typeof r.conversation === 'string' ? r.conversation : (conversation || null),
        source: r.source === 'session' ? 'session' : 'disk',
        partial: r.partial === true,
        skills: skillsOf(r.skills),
        note: NOTE,
      });
    } catch (e) {
      return sendFailure(res, e, `GET ${SKILLS_ROUTE}`);
    }
  });
}

module.exports = { mountSkillsRoutes, SKILLS_ROUTE, NOTE };

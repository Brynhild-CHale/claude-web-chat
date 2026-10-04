// GET /api/mirror/access — what this viewer may see of the chat mirror, and how
// the host changes that (spec §5.4). Readable at every level (its remote-policy
// row is `basic`): it carries no conversation, only the asker's own level.
//
//   { ok, level, remote, project?: { remote_level, tunnel_configured },
//     commands: { on, read_only, off } }
//
//   level     basic | read | full | local — this request's (lib/server/audience
//             levelOf): a label for the page, never a grant
//   remote    the portal's label on this request (as GET /api/health says it)
//   project   the host's business, so a local caller's only: the project's
//             opt-in ('off' | 'read' | 'full') and whether remote access is set
//             up at all (a valid tunnel.json)
//   commands  the host commands that change the opt-in. The page names them and
//             cannot grant: only `claude-web-chat tunnel mirror …` on the host
//             writes the opt-in (~/.web-chat/tunnel/tunnel.json), never a route.
//
// The level itself, the opt-in and its watcher are ctx.audience's; this file
// only answers.

function mountMirrorAccessRoutes(app, ctx) {
  // Mounted with ctx.audience. Without one there is no level to report, which
  // is the facade's "not wired yet" answer (spec §2.10), not a guess.
  const unwired = (req, res) => res.status(503).json({ ok: false, unavailable: true });
  const gate = ctx.audience ? ctx.audience.requireMirror('basic') : unwired;
  app.get('/api/mirror/access', gate, (req, res) => {
    res.json(ctx.audience.accessView(req));
  });
}

module.exports = { mountMirrorAccessRoutes };

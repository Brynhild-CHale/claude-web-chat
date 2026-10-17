// The writer gate (PLAN 1B.4; DECISIONS A1) — route-level middleware in front
// of Claude's write routes, registered BEFORE them (mountWriterRoutes runs
// immediately before mountRenderRoutes in lib/server/index.js; Express runs a
// path's handlers in registration order), so render.js and page.js carry no
// identity code of their own. Who is writing is the writers domain's answer
// (lib/server/domain/writers resolveWriter, ctx.writers); this file decides
// what each class may do on these three routes, and sets `req.writer` for the
// route behind it.
//
//   POST /api/render, POST /api/markdown — Claude's writes (the chrome never
//   calls either; public/ has no caller):
//     stale token   → 401 {ok:false, writer:'stale', hint}: the MCP client
//                     re-reads .web-chat/writer-token once.
//     a browser     → 403 {ok:false, writer:'browser', hint} (a local browser
//     or remote       request without the token, or anything through the
//                     portal): a pane script's same-origin fetch is not Claude.
//     claude, proved → the body owner is dropped, so the route's
//                     normalizeOwner stamps 'claude' — EXCEPT a declared
//                     `service:`/`pane:` owner, left as declared (unverified)
//                     until U214b requires its credential.
//     tokenless local non-browser (lib/client: hooks, the CLI, scripts, the
//     MCP tool tests) → untouched: ADVISORY claude, as today.
//
//   POST /api/clear — the chrome's × and the drawer close panes through it:
//     stale token → 401; a browser's (or the portal's) body owner is dropped
//     (the chrome sends none, so a page script can no longer claim another
//     writer's panes by naming their owner); everything else as today — the
//     remote bulk-clear refusal stays render.js's.
//
// These refusals authenticate a CLAIMED class; they are not ownership rules,
// and none is enforced before GT-15 (DECISIONS A1). POST
// /api/components/:name/use is deliberately not gated: it strips signals and
// force for a browser or remote caller and stamps owner 'claude' itself
// (routes/components.js).
//
// Each path below matches an existing row of lib/core/remote-policy RULES.

const STALE_HINT = 'the writer token is from an earlier boot of this surface — re-read .web-chat/writer-token and retry';
const BROWSER_HINT = 'Claude writes through MCP; a local process through lib/driver';

function mountWriterRoutes(app, { writers }) {
  if (!writers || typeof writers.resolveWriter !== 'function') throw new TypeError('mountWriterRoutes: ctx.writers is required');

  function resolve(req) {
    const w = writers.resolveWriter(req, req.body);
    req.writer = w;
    return w;
  }

  // A declared owner the token does not replace in W1 (notes-B Q4).
  const keepsDeclared = (owner) => typeof owner === 'string' && (owner.startsWith('service:') || owner.startsWith('pane:'));

  function gate(req, res, next) {
    const w = resolve(req);
    if (w.stale) return res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT });
    if (w.class === 'remote' || w.class === 'user') {
      return res.status(403).json({ ok: false, writer: 'browser', hint: BROWSER_HINT });
    }
    if (w.class === 'claude' && w.verified && req.body && typeof req.body === 'object' && !keepsDeclared(req.body.owner)) {
      delete req.body.owner;
    }
    next();
  }

  function clearGate(req, res, next) {
    const w = resolve(req);
    if (w.stale) return res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT });
    if ((w.class === 'remote' || w.class === 'user') && req.body && typeof req.body === 'object') {
      delete req.body.owner;
    }
    next();
  }

  app.post('/api/render', gate);
  app.post('/api/markdown', gate);
  app.post('/api/clear', clearGate);
}

module.exports = { mountWriterRoutes, STALE_HINT, BROWSER_HINT };

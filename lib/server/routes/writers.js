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
//     a service child's or a lease's token (U214b) → the CREDENTIAL'S owner
//                     replaces the body owner (whatever the body names is
//                     ignored).
//     an unproven `service:<n>` body owner — tokenless, or under Claude's
//                     token → 403 {ok:false, writer:'unverified', owner, hint}:
//                     a local process writes through lib/driver createDriver,
//                     which leases its owner (notes-B Q7).
//     a `pane:<id>` body owner, from anyone → 403 (a pane owner is minted
//                     only by a spawn, routes/spawn.js).
//     claude, proved → the body owner is dropped, so the route's
//                     normalizeOwner stamps 'claude'.
//     tokenless local non-browser (lib/client: hooks, the CLI, scripts, the
//     MCP tool tests) naming no `service:`/`pane:` owner → untouched:
//     ADVISORY claude, as today.
//
//   POST /api/clear — the chrome's × and the drawer close panes through it:
//     stale token → 401; a browser's (or the portal's) body owner is dropped
//     (the chrome sends none, so a page script can no longer claim another
//     writer's panes by naming their owner); a credential's owner replaces
//     the body's; an unproven `service:`/`pane:` body owner → 403, as above;
//     everything else as today — the remote bulk-clear refusal stays
//     render.js's.
//
//   POST /api/writers/lease {owner, pid}, DELETE /api/writers/lease — the
//   driver lease (U214b; host only: local and not a browser, audience
//   requireHost; lib/core/remote-policy refuses `* /api/writers/*` remotely):
//     200 {ok:true, owner, token}; 409 {ok:false, refused:'owner_taken', owner,
//     hint} while a running service child or another live driver instance
//     holds the owner; 400 for an owner that is not `service:<kebab>` or a pid
//     that is not a positive integer. DELETE releases the lease whose token is
//     the writer header (WRITER_HEADER): 200 {ok:true, released}.
//
// These refusals authenticate a CLAIMED class; they are not ownership rules,
// and none is enforced before GT-15 (DECISIONS A1). POST
// /api/components/:name/use is deliberately not gated: it strips signals and
// force for a browser or remote caller and stamps owner 'claude' itself
// (routes/components.js).
//
// Each path below matches an existing row of lib/core/remote-policy RULES.

const { WRITER_HEADER } = require('../../core/writer-token');

const STALE_HINT = 'the writer token is from an earlier boot of this surface — re-read .web-chat/writer-token and retry';
const BROWSER_HINT = 'Claude writes through MCP; a local process through lib/driver';
const UNVERIFIED_HINT = 'a local process writes through lib/driver createDriver, which leases its owner';
const PANE_HINT = 'a pane: owner is minted only by a spawn (api.spawn in a pane script)';
const OWNER_TAKEN_SERVICE_HINT = 'a running service holds this owner — its trust approval outranks a lease; pick another owner name';
const OWNER_TAKEN_DRIVER_HINT = 'another live driver holds this owner (one owner per live driver) — release() it, or pick another owner name';
const BAD_OWNER_HINT = 'a lease is for an owner `service:<name>` (lowercase letters, digits and dashes); claude, user, remote and pane:* are never leasable';
const BAD_PID_HINT = 'pid must be the leasing process\'s pid (a positive integer)';

const claims = (owner, prefix) => typeof owner === 'string' && owner.startsWith(prefix);

function mountWriterRoutes(app, { writers, audience }) {
  if (!writers || typeof writers.resolveWriter !== 'function') throw new TypeError('mountWriterRoutes: ctx.writers is required');
  if (!audience || typeof audience.requireHost !== 'function') throw new TypeError('mountWriterRoutes: ctx.audience is required');

  function resolve(req) {
    const w = writers.resolveWriter(req, req.body);
    req.writer = w;
    return w;
  }

  const bodyOf = (req) => (req.body && typeof req.body === 'object' ? req.body : null);

  // The rules every guarded route shares once the browser question is
  // settled: a credential's owner replaces the body's; an unproven
  // `service:`/`pane:` claim is refused. Answers true when it sent the
  // response.
  function owned(req, res, w) {
    const body = bodyOf(req);
    if (w.verified && (w.class === 'service' || w.class === 'driver')) {
      if (body) body.owner = w.owner;
      return false;
    }
    const owner = body ? body.owner : undefined;
    if (claims(owner, 'pane:')) {
      res.status(403).json({ ok: false, writer: 'unverified', owner, hint: PANE_HINT });
      return true;
    }
    if (claims(owner, 'service:')) {
      res.status(403).json({ ok: false, writer: 'unverified', owner, hint: UNVERIFIED_HINT });
      return true;
    }
    return false;
  }

  function gate(req, res, next) {
    const w = resolve(req);
    if (w.stale) return res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT });
    if (w.class === 'remote' || w.class === 'user') {
      return res.status(403).json({ ok: false, writer: 'browser', hint: BROWSER_HINT });
    }
    if (owned(req, res, w)) return undefined;
    const body = bodyOf(req);
    if (w.class === 'claude' && w.verified && body) delete body.owner;
    return next();
  }

  function clearGate(req, res, next) {
    const w = resolve(req);
    if (w.stale) return res.status(401).json({ ok: false, writer: 'stale', hint: STALE_HINT });
    if (w.class === 'remote' || w.class === 'user') {
      const body = bodyOf(req);
      if (body) delete body.owner;
      return next();
    }
    if (owned(req, res, w)) return undefined;
    return next();
  }

  app.post('/api/render', gate);
  app.post('/api/markdown', gate);
  app.post('/api/clear', clearGate);

  // ── the driver lease ──────────────────────────────────────────────────────
  const hostOnly = audience.requireHost();
  const WRITER_KEY = WRITER_HEADER.toLowerCase();

  app.post('/api/writers/lease', hostOnly, (req, res) => {
    const body = bodyOf(req) || {};
    const r = writers.lease({ owner: body.owner, pid: body.pid });
    if (r.ok) return res.json({ ok: true, owner: r.owner, token: r.token });
    if (r.refused === 'owner_taken') {
      return res.status(409).json({
        ok: false, refused: 'owner_taken', owner: r.owner,
        hint: r.holder === 'service' ? OWNER_TAKEN_SERVICE_HINT : OWNER_TAKEN_DRIVER_HINT,
      });
    }
    return res.status(400).json({ ok: false, refused: r.refused, owner: r.owner, hint: r.refused === 'bad_pid' ? BAD_PID_HINT : BAD_OWNER_HINT });
  });

  app.delete('/api/writers/lease', hostOnly, (req, res) => {
    const t = req.headers[WRITER_KEY];
    res.json({ ok: true, released: typeof t === 'string' && t !== '' ? writers.release(t) : false });
  });
}

module.exports = {
  mountWriterRoutes, STALE_HINT, BROWSER_HINT, UNVERIFIED_HINT, PANE_HINT,
};

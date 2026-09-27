// Component packs over HTTP — the routes the drawer's Manage tab drives.
//
// ── The residual risk, stated plainly ───────────────────────────────────────
//
// Pane scripts run via `new Function` in the window realm with `fetch`, under no
// CSP. `POST /api/packs/install` is therefore reachable by any pane, and the
// endpoint cannot tell a user's click from a pane's `fetch` — the two are
// byte-identical requests. The warning copy protects a human who reads it; it
// does not protect against a pane, and nothing delivered to the page can. This
// was raised, and the maintainer has accepted it knowingly.
//
// What remains closed, and must stay closed:
//
//   * A BUILTIN name is hard-refused, no override, either tier, either actor.
//     This is the sharp edge: seedBuiltins (lib/server/builtins.js) only repairs
//     a directory whose meta.json says `builtin: true`, so a pack shadowing
//     `git-dashboard` would win PERMANENTLY.
//   * A user's own same-named component is never silently replaced — `replace`
//     is terminal-only and these routes do not accept it.
//   * `service.js` still cannot run without `claude-web-chat trust`: consent is
//     keyed to the file's hash, so a fresh service is unapproved by construction.
//   * Every install/quarantine/remove appends to `.web-chat/packs/audit.log` and
//     records `actor: "http"|"cli"`, so a pane-initiated install is at least
//     discoverable.
//
// Removing a pack the user has EDITED is likewise terminal-only: DELETE refuses
// with the command that would do it. Destroying something the user made is not a
// decision this endpoint can attribute to them.
//
// Refusal convention: a refusal is 200 with `ok:false` (the lockReject envelope
// shape from routes/render.js). Non-2xx is reserved for transport failures, so a
// caller that reads the body sees WHY rather than a bare status code.

const { lockReject } = require('./render');
const packs = require('../../packs/install');
const { readAudit } = require('../../packs/store');
const { isRemoteRequest } = require('../../core/cors');
const { redactHostPaths } = require('../../core/paths');
const { BRAND_CSP } = require('../brand');
const { resolveDefault } = require('../theme');
const { resolveScope } = require('./theme');

// A refusal the caller can act on. Mirrors lockReject's shape: ok:false plus a
// hint, at HTTP 200.
function reject(res, hint, extra = {}) {
  return res.json({ ok: false, rejected: true, hint, ...extra });
}

function fail(res, e) {
  if (e && e.userFacing) {
    return reject(res, e.message, {
      ...(e.errors ? { errors: e.errors } : {}),
      ...(e.collisions ? { collisions: e.collisions } : {}),
      ...(e.drift ? { drift: true, command: e.command, units: e.units } : {}),
    });
  }
  // A genuine transport/programming failure — 500 is honest here.
  return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
}

const ACTOR = 'http';

function mountPackRoutes(app, ctx) {
  const { paths, bus } = ctx;
  const root = paths.root;
  // The read routes a remote viewer may reach (lib/core/remote-policy) answer
  // it without the host's directory layout — the project root, a backup dir,
  // the staged tree's record — which the picker already withholds by default.
  const reply = (req, res, body) => res.json(isRemoteRequest(req) ? redactHostPaths(body, { root }) : body);

  // Notify every open surface that the component set moved. The drawer and the
  // ⌘K palette share ONE component cache; without this frame an install would be
  // invisible until someone reloaded the page.
  const changed = (detail) => bus.emit({
    event: { kind: 'packs', ...detail },
    ws: [{ type: 'packs:changed', ...detail }, { type: 'components' }],
  });

  // A removal took the ACTIVE theme and put the project back on the default
  // (lib/packs/tree resetActiveTheme). Every open surface repaints to what
  // it now resolves to — the same frame an apply sends — and its brand fill
  // follows (public/app/ws.js refreshes it on any global theme frame).
  const themeReset = (reset) => bus.emit({
    event: { kind: 'theme', op: 'reset', name: reset.name, scope: 'global', reason: 'pack-removed' },
    ws: { type: 'theme', scope: 'global', theme: resolveDefault(paths), resolved: resolveScope(ctx, 'global') },
  });

  // Defence in depth behind the portal's own refusal (lib/core/remote-policy:
  // every non-GET under /api/packs is refused remotely): a pack write — a
  // component pack's host code, a theme pack's theme and logos — is the host's
  // to make, never a remote viewer's. The portal is the gate; this is the
  // second lock, the same one POST /api/themes keeps for a system save.
  app.use('/api/packs', (req, res, next) => {
    if (req.method === 'GET' || !isRemoteRequest(req)) return next();
    return res.status(403).json({ ok: false, remote: true, hint: 'packs are installed and removed on the host (claude-web-chat pack)' });
  });

  app.get('/api/packs', (req, res) => {
    try {
      // `pending` rides ALONGSIDE, never inside `packs` — a half-install must
      // not reach the drawer as an installed pack whose unwritten files then
      // verify as drift and chip "locally edited".
      const { packs: installed, quarantined, pending } = packs.listInstalled({ root, verify: true });
      reply(req, res, { ok: true, packs: installed, quarantined, pending, root });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/packs/audit', (req, res) => {
    reply(req, res, { ok: true, entries: readAudit(root, { limit: Number(req.query.limit) || 50 }) });
  });

  // Direct install. Deliberately does NOT accept `replace` — see the header.
  app.post('/api/packs/install', async (req, res) => {
    const { url, ref = null, asset = null, global: isGlobal = false } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url required' });
    try {
      const out = await packs.installPack({
        url, ref, asset, tier: isGlobal ? 'system' : 'local', root,
        replace: false, actor: ACTOR,
      });
      changed({ op: 'install', pack: out.pack.name, tier: out.tier });
      res.json({
        ok: true, pack: out.pack, tier: out.tier, results: out.results,
        warnings: out.warnings, services: out.pack.services || [], skill: out.pack.skill || null,
      });
    } catch (e) { fail(res, e); }
  });

  // Download for review. Fetches, verifies and stages — installs nothing.
  app.post('/api/packs/quarantine', async (req, res) => {
    const { url, ref = null, asset = null, global: isGlobal = false } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url required' });
    try {
      const out = await packs.quarantinePack({
        url, ref, asset, tier: isGlobal ? 'system' : 'local', root, actor: ACTOR,
      });
      changed({ op: 'quarantine', pack: out.record.name, tier: out.record.tier });
      res.json({ ok: true, record: out.record });
    } catch (e) { fail(res, e); }
  });

  // Read-only review of a staged pack. `?file=` returns one file's text; the
  // path is checked against the staged file list, so it cannot walk out.
  app.get('/api/packs/quarantine/:name/review', (req, res) => {
    try {
      reply(req, res, packs.reviewQuarantine({ name: req.params.name, root, file: req.query.file || null }));
    } catch (e) { fail(res, e); }
  });

  // One logo of a quarantined theme, as an image — the review card's thumbnail
  // is an <img> pointed here. Only a logo that is in the staged file list and
  // passes the Brand check is served (lib/packs/install quarantineLogo), with
  // the /brand/<slot> headers: its own type, nosniff, and a CSP that forbids
  // script and sandboxes the document for whoever opens the URL directly.
  // Anything else is a bare 404: an <img> has no use for a hint.
  app.get('/api/packs/quarantine/:name/logo', (req, res) => {
    let logo;
    try {
      logo = packs.quarantineLogo({ name: req.params.name, root, theme: req.query.theme, file: req.query.file });
    } catch { return res.status(404).end(); }
    res.setHeader('Content-Type', logo.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', BRAND_CSP);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.end(logo.bytes);
  });

  app.post('/api/packs/quarantine/:name/approve', (req, res) => {
    try {
      const out = packs.approvePack({ name: req.params.name, root, replace: false, actor: ACTOR });
      changed({ op: 'approve', pack: out.pack.name, tier: out.tier });
      res.json({
        ok: true, pack: out.pack, tier: out.tier, results: out.results,
        warnings: out.warnings, services: out.pack.services || [], skill: out.pack.skill || null,
      });
    } catch (e) { fail(res, e); }
  });

  // Discarding a quarantined pack is SAFE: it was never live, so nothing that
  // depends on it can break. This is the one destructive-sounding pack route
  // that needs no terminal.
  app.delete('/api/packs/quarantine/:name', (req, res) => {
    try {
      const out = packs.discardPack({ name: req.params.name, root, actor: ACTOR });
      changed({ op: 'discard', pack: out.name });
      res.json({ ok: true, name: out.name });
    } catch (e) { fail(res, e); }
  });

  // Remove — only when nothing has drifted. From a terminal the per-unit rule
  // handles an edited pack gracefully (remove what you did not touch, keep what
  // you did, print both). Here it declines outright and hands back the command,
  // because this endpoint cannot attribute the request to the user.
  app.delete('/api/packs/:name', (req, res) => {
    try {
      const out = packs.removePackByName({ name: req.params.name, root, force: false, refuseOnDrift: true, actor: ACTOR });
      changed({ op: 'remove', pack: out.name, tier: out.tier });
      if (out.theme_reset) themeReset(out.theme_reset);
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, e); }
  });

  // The CLI's nudge: "I changed the component set from a terminal, refresh."
  // `theme_reset` is the CLI saying its removal put the project back on the
  // default theme; the frame re-reads what the project resolves to, so a pane
  // that posts one can only make the surface show the truth again.
  app.post('/api/packs/announce', (req, res) => {
    const body = req.body || {};
    changed({ op: 'announce', pack: body.pack || null });
    if (body.theme_reset && typeof body.theme_reset.name === 'string') themeReset({ name: body.theme_reset.name });
    res.json({ ok: true });
  });
}

module.exports = { mountPackRoutes, reject };

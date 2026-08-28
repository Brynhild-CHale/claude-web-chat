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

function mountPackRoutes(app, { paths, bus }) {
  const root = paths.root;

  // Notify every open surface that the component set moved. The drawer and the
  // ⌘K palette share ONE component cache; without this frame an install would be
  // invisible until someone reloaded the page.
  const changed = (detail) => bus.emit({
    event: { kind: 'packs', ...detail },
    ws: [{ type: 'packs:changed', ...detail }, { type: 'components' }],
  });

  app.get('/api/packs', (req, res) => {
    try {
      // `pending` rides ALONGSIDE, never inside `packs` — a half-install must
      // not reach the drawer as an installed pack whose unwritten files then
      // verify as drift and chip "locally edited".
      const { packs: installed, quarantined, pending } = packs.listInstalled({ root, verify: true });
      res.json({ ok: true, packs: installed, quarantined, pending, root });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/packs/audit', (req, res) => {
    res.json({ ok: true, entries: readAudit(root, { limit: Number(req.query.limit) || 50 }) });
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
      res.json(packs.reviewQuarantine({ name: req.params.name, root, file: req.query.file || null }));
    } catch (e) { fail(res, e); }
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
      res.json({ ok: true, ...out });
    } catch (e) { fail(res, e); }
  });

  // The CLI's nudge: "I changed the component set from a terminal, refresh."
  app.post('/api/packs/announce', (req, res) => {
    changed({ op: 'announce', pack: (req.body && req.body.pack) || null });
    res.json({ ok: true });
  });
}

module.exports = { mountPackRoutes, reject };

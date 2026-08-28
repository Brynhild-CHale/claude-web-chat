const fs = require('fs');
const path = require('path');
const { setMount } = require('../domain/mounts');
const { assertComponentName, isComponentName } = require('../../core/names');
const { componentsRegistry, componentDir } = require('../components-registry');

function mountComponentRoutes(app, { paths, state, bus, services }) {
  // The component library over the tiered resource registry (Phase 5). A
  // component is a DIRECTORY (component.html + meta.json + optional seed.js +
  // optional service.js). The registry (extracted to lib/server/components-registry
  // so the service supervisor shares the exact tier logic) owns tier resolution /
  // listing / save-to-tier; `use` + `seed` (mount side-effects, raw sidecar) stay
  // bespoke and resolve the dir via registry.get + componentDir.
  const registry = componentsRegistry(paths);

  app.post('/api/components', (req, res) => {
    const { name, source, description, params_schema, seed, service, location = 'local' } = req.body || {};
    if (!name || !source) return res.status(400).json({ error: 'name + source required' });
    // The one name policy (lib/core/names). This was the last writer that turned
    // an agent- or pane-supplied name into a component directory without
    // consulting the reserved list — and registry.save writes a meta.json with
    // no `builtin` marker, so a single save over `git-dashboard` made the
    // built-in unrepairable forever. Two refusal shapes, because there are two
    // audiences: a malformed name is a 400 (the caller sent nonsense), a
    // reserved name is a 200 `{ok:false}` (the request was well-formed and the
    // answer is no) — matching the packs route, since save_component and the
    // drawer both read `.ok` rather than the status.
    try {
      assertComponentName(name);
    } catch (e) {
      if (e.code === 'name-reserved') return res.json({ ok: false, reserved: true, hint: e.message });
      return res.status(400).json({ error: e.message });
    }
    const tier = location === 'system' ? 'system' : 'local';
    registry.save(name, { source, description, params_schema, seed, service }, { tier });
    // The surface keeps ONE component cache (public/app/components.js), shared by
    // the drawer and the ⌘K palette. Without this frame a component Claude saved
    // mid-session stayed invisible in both until someone reloaded the page —
    // which is also why a pack install could not have shown up live.
    bus.emit({ ws: { type: 'components' } });
    res.json({ ok: true, location: tier });
  });

  app.get('/api/components', (req, res) => {
    // Wire shape { name, description, params_schema, has_seed, has_service, location }
    // — the engine's `tier` tag renamed to `location` (mirrors GET /api/themes).
    const components = registry.list().map(({ tier, ...c }) => ({ ...c, location: tier }));
    res.json({ components });
  });

  // The three routes below resolve a NAME to a directory, and Express decodes
  // `%2f` into a route param — so `/api/components/..%2f..%2fx/seed` arrives as
  // the name `../../x`, which resourceRegistry.get joins and existsSync's
  // unguarded. The grammar is the containment rule: a name that cannot carry a
  // separator cannot leave the components directory. A non-conforming name
  // answers 404 rather than 400, because from the caller's side the honest
  // answer is that no such component exists — there is no name-shaped thing
  // there to have got wrong.
  const resolvable = (req, res) => {
    if (isComponentName(req.params.name)) return true;
    res.status(404).json({ error: 'not found' });
    return false;
  };

  app.get('/api/components/:name/seed', (req, res) => {
    if (!resolvable(req, res)) return;
    const found = registry.get(req.params.name);
    const seedPath = found && path.join(componentDir(registry, found.tier, req.params.name), 'seed.js');
    if (!seedPath || !fs.existsSync(seedPath)) return res.status(404).json({ error: 'no seed' });
    res.type('text/javascript').send(fs.readFileSync(seedPath, 'utf8'));
  });

  app.get('/api/components/:name', (req, res) => {
    if (!resolvable(req, res)) return;
    const found = registry.get(req.params.name);
    if (!found) return res.status(404).json({ error: 'not found' });
    const dir = componentDir(registry, found.tier, req.params.name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const source = fs.readFileSync(path.join(dir, 'component.html'), 'utf8');
    const has_service = fs.existsSync(path.join(dir, 'service.js'));
    res.json({ ...meta, source, has_service });
  });

  app.post('/api/components/:name/use', (req, res) => {
    // /use is the sharpest of the three: the name it accepts is written into
    // `mount.component`, and the service supervisor turns that string into the
    // service.js path it forks (lib/server/services.js).
    if (!resolvable(req, res)) return;
    const found = registry.get(req.params.name);
    if (!found) return res.status(404).json({ error: 'not found' });
    const source = fs.readFileSync(path.join(componentDir(registry, found.tier, req.params.name), 'component.html'), 'utf8');
    const params = req.body?.params || {};
    const target = req.body?.target || 'main';
    const id = req.body?.id || `mount-${Date.now()}`;
    // The SAME mount-set as /api/render (lib/server/domain/mounts): this route
    // used to hand-copy a third of it — the lock check and the form_state carry
    // — and drop the owner gate, the owner stamp, the gen bump and the theme
    // carry. `component` is the one field /use adds: the supervisor turns that
    // string into the service.js path it forks.
    res.json(setMount(state, bus, {
      id, html: source, target, params,
      owner: 'claude',
      force: req.body?.force,
      component: req.params.name,
    }));
  });

  // ---- service trust (read + nudge only) -------------------------------------
  // What `claude-web-chat trust` lists. Deliberately read-only: the DECISION is
  // a write to the user-tier trust file made by the CLI, never an HTTP call.
  // Pane scripts can reach localhost endpoints (same origin, no CSP), so any
  // endpoint that granted trust would be forgeable by the very code being gated.
  app.get('/api/services/pending', (req, res) => {
    const sup = typeof services === 'function' ? services() : null;
    res.json({ ok: true, pending: sup ? sup.pendingTrust() : [], root: paths.root });
  });

  // "Re-read the trust file now" — so an approval takes effect immediately
  // instead of waiting for an unrelated event. Grants nothing on its own.
  app.post('/api/services/refresh-trust', (req, res) => {
    const sup = typeof services === 'function' ? services() : null;
    if (sup) sup.refreshTrust();
    res.json({ ok: true });
  });
}

module.exports = { mountComponentRoutes };

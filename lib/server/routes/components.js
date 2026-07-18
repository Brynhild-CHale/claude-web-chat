const fs = require('fs');
const path = require('path');
const { lockReject } = require('./render');
const { componentsRegistry, componentDir } = require('../components-registry');

function mountComponentRoutes(app, { paths, state, bus }) {
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
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return res.status(400).json({ error: 'name must be kebab-case' });
    registry.save(name, { source, description, params_schema, seed, service }, { tier: location === 'system' ? 'system' : 'local' });
    res.json({ ok: true, location: location === 'system' ? 'system' : 'local' });
  });

  app.get('/api/components', (req, res) => {
    // Wire shape { name, description, params_schema, has_seed, has_service, location }
    // — the engine's `tier` tag renamed to `location` (mirrors GET /api/themes).
    const components = registry.list().map(({ tier, ...c }) => ({ ...c, location: tier }));
    res.json({ components });
  });

  app.get('/api/components/:name/seed', (req, res) => {
    const found = registry.get(req.params.name);
    const seedPath = found && path.join(componentDir(registry, found.tier, req.params.name), 'seed.js');
    if (!seedPath || !fs.existsSync(seedPath)) return res.status(404).json({ error: 'no seed' });
    res.type('text/javascript').send(fs.readFileSync(seedPath, 'utf8'));
  });

  app.get('/api/components/:name', (req, res) => {
    const found = registry.get(req.params.name);
    if (!found) return res.status(404).json({ error: 'not found' });
    const dir = componentDir(registry, found.tier, req.params.name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const source = fs.readFileSync(path.join(dir, 'component.html'), 'utf8');
    const has_service = fs.existsSync(path.join(dir, 'service.js'));
    res.json({ ...meta, source, has_service });
  });

  app.post('/api/components/:name/use', (req, res) => {
    const found = registry.get(req.params.name);
    if (!found) return res.status(404).json({ error: 'not found' });
    const source = fs.readFileSync(path.join(componentDir(registry, found.tier, req.params.name), 'component.html'), 'utf8');
    const params = req.body?.params || {};
    const target = req.body?.target || 'main';
    const id = req.body?.id || `mount-${Date.now()}`;
    const existing = state.mounts.get(id);
    if (existing && existing.pane_state && existing.pane_state.locked) {
      return res.json(lockReject(id));
    }
    const pane_state = existing ? existing.pane_state : undefined;
    // Mirror /api/render: a stable-id re-use must not eat the user's typed form
    // values (rehydrated by element key); params.form_reset opts out.
    const form_state = (existing && !(params && params.form_reset)) ? existing.form_state : undefined;
    state.mounts.set(id, { html: source, target, params, component: req.params.name, pane_state, form_state });
    bus.emit({
      event: { kind: 'render', id, target, component: req.params.name, params },
      ws: { type: 'render', html: source, target, id, params, pane_state, form_state },
    });
    res.json({ ok: true, id });
  });
}

module.exports = { mountComponentRoutes };

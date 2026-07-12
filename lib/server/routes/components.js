const fs = require('fs');
const path = require('path');
const { lockReject } = require('./render');
const { resourceRegistry } = require('../../core/resources');

function mountComponentRoutes(app, { paths, state, bus }) {
  // The component library over the tiered resource registry (Phase 5). A
  // component is a DIRECTORY (component.html + meta.json + optional seed.js). The
  // registry owns tier resolution / listing / save-to-tier; `use` + `seed`
  // (mount side-effects, raw sidecar) stay bespoke and resolve the dir via
  // registry.get + registry.dir. Two tiers, project shadows user: a same-named
  // project component wins over a ~/.web-chat/components one (mirroring themes).
  const registry = resourceRegistry({
    name: 'components',
    tiers: [
      { tier: 'local', dir: paths.COMPONENTS_DIR },
      { tier: 'system', dir: paths.SYSTEM_COMPONENTS_DIR },
    ],
    // Dir-payload loader. Returns the LIST-shaped record (or null for a non-dir
    // entry, matching the old `.filter(isDirectory)`). A directory without a
    // readable meta.json still lists, as '(missing meta)', preserving old behavior.
    load: (entryDir, { name }) => {
      let stat;
      try { stat = fs.statSync(entryDir); } catch { return null; }
      if (!stat.isDirectory()) return null;
      const has_seed = fs.existsSync(path.join(entryDir, 'seed.js'));
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(entryDir, 'meta.json'), 'utf8'));
        return { name: meta.name, description: meta.description, params_schema: meta.params_schema, has_seed };
      } catch {
        return { name, description: '(missing meta)', params_schema: {}, has_seed };
      }
    },
    write: (dir, name, { source, description, params_schema }) => {
      const d = path.join(dir, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'component.html'), source);
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({
        name, description: description || '', params_schema: params_schema || {}, updated: Date.now(),
      }, null, 2));
    },
  });

  // Absolute dir of a resolved component (the tier dir + the component name).
  const componentDir = (name, found) => path.join(registry.dir(found.tier), name);

  app.post('/api/components', (req, res) => {
    const { name, source, description, params_schema, location = 'local' } = req.body || {};
    if (!name || !source) return res.status(400).json({ error: 'name + source required' });
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return res.status(400).json({ error: 'name must be kebab-case' });
    registry.save(name, { source, description, params_schema }, { tier: location === 'system' ? 'system' : 'local' });
    res.json({ ok: true, location: location === 'system' ? 'system' : 'local' });
  });

  app.get('/api/components', (req, res) => {
    // Wire shape { name, description, params_schema, has_seed, location } —
    // the engine's `tier` tag renamed to `location` (mirrors GET /api/themes).
    const components = registry.list().map(({ tier, ...c }) => ({ ...c, location: tier }));
    res.json({ components });
  });

  app.get('/api/components/:name/seed', (req, res) => {
    const found = registry.get(req.params.name);
    const seedPath = found && path.join(componentDir(req.params.name, found), 'seed.js');
    if (!seedPath || !fs.existsSync(seedPath)) return res.status(404).json({ error: 'no seed' });
    res.type('text/javascript').send(fs.readFileSync(seedPath, 'utf8'));
  });

  app.get('/api/components/:name', (req, res) => {
    const found = registry.get(req.params.name);
    if (!found) return res.status(404).json({ error: 'not found' });
    const dir = componentDir(req.params.name, found);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const source = fs.readFileSync(path.join(dir, 'component.html'), 'utf8');
    res.json({ ...meta, source });
  });

  app.post('/api/components/:name/use', (req, res) => {
    const found = registry.get(req.params.name);
    if (!found) return res.status(404).json({ error: 'not found' });
    const source = fs.readFileSync(path.join(componentDir(req.params.name, found), 'component.html'), 'utf8');
    const params = req.body?.params || {};
    const target = req.body?.target || 'main';
    const id = req.body?.id || `mount-${Date.now()}`;
    const existing = state.mounts.get(id);
    if (existing && existing.pane_state && existing.pane_state.locked) {
      return res.json(lockReject(id));
    }
    const pane_state = existing ? existing.pane_state : undefined;
    state.mounts.set(id, { html: source, target, params, component: req.params.name, pane_state });
    bus.emit({
      event: { kind: 'render', id, target, component: req.params.name, params },
      ws: { type: 'render', html: source, target, id, params, pane_state },
    });
    res.json({ ok: true, id });
  });
}

module.exports = { mountComponentRoutes };

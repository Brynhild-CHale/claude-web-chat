// The components library over the tiered resource registry, extracted from
// routes/components.js so the service supervisor (lib/server/services.js) can
// resolve a component's directory with the identical tier logic instead of
// hand-rolling a second copy. A component is a DIRECTORY: component.html +
// meta.json + optional seed.js + optional service.js. Two tiers, project shadows
// user (a same-named local component wins over a ~/.web-chat one, mirroring themes).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resourceRegistry } = require('../core/resources');

function componentsRegistry(paths) {
  return resourceRegistry({
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
      const has_service = fs.existsSync(path.join(entryDir, 'service.js'));
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(entryDir, 'meta.json'), 'utf8'));
        return { name: meta.name, description: meta.description, params_schema: meta.params_schema, has_seed, has_service };
      } catch {
        return { name, description: '(missing meta)', params_schema: {}, has_seed, has_service };
      }
    },
    write: (dir, name, { source, description, params_schema, seed, service }) => {
      const d = path.join(dir, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'component.html'), source);
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({
        name, description: description || '', params_schema: params_schema || {}, updated: Date.now(),
      }, null, 2));
      // seed.js / service.js are optional sidecars. A string (even '') writes the
      // file; undefined leaves any existing sidecar untouched.
      if (typeof seed === 'string') fs.writeFileSync(path.join(d, 'seed.js'), seed);
      if (typeof service === 'string') fs.writeFileSync(path.join(d, 'service.js'), service);
    },
  });
}

// Absolute dir of a resolved component (the tier dir + the component name).
function componentDir(registry, tier, name) {
  return path.join(registry.dir(tier), name);
}

// What the supervisor needs per reconcile: does this component carry a service.js,
// and what is its content hash (trust is keyed by the hash so an edit re-prompts).
// Returns { dir, servicePath, exists, hash } for a resolvable component, or null
// if the component name doesn't resolve to any tier.
function serviceInfo(paths, name) {
  const registry = componentsRegistry(paths);
  const found = registry.get(name);
  if (!found) return null;
  const dir = componentDir(registry, found.tier, name);
  const servicePath = path.join(dir, 'service.js');
  try {
    const buf = fs.readFileSync(servicePath);
    return { dir, servicePath, exists: true, hash: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch {
    return { dir, servicePath, exists: false, hash: null };
  }
}

module.exports = { componentsRegistry, componentDir, serviceInfo };

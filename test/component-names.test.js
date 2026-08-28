// One name policy, asserted at every entry — the guardrail for lib/core/names.js.
//
// A component name becomes a DIRECTORY, so every site that turns a name into a
// path is a place the policy has to hold. This file enumerates those sites in
// one table and runs the same two questions at each of them:
//
//   * does it refuse EVERY reserved builtin name, in EVERY tier? and
//   * does it refuse a name that is not plain kebab-case?
//
// The table iterates BUILTIN_COMPONENTS rather than a hand-written list, so a
// seventh builtin added to lib/core/names.js is covered at every entry the
// moment it is added — which is the whole point. The regression that motivated
// it: POST /api/components checked the grammar and NOT the reserved list, and
// componentsRegistry.write then wrote a meta.json with no `builtin` marker, so a
// single save_component('git-dashboard') made the builtin unrepairable forever.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { BUILTIN_COMPONENTS } = require('../lib/core/names');
const { componentsRegistry } = require('../lib/server/components-registry');
const { seedBuiltins } = require('../lib/server/builtins');
const { resolvePaths } = require('../lib/server/paths');
const { validateManifest } = require('../lib/packs/manifest');
const { planInstall } = require('../lib/packs/plan');
const { removeUnits, verifyPack } = require('../lib/packs/tree');
const { projectPaths } = require('../lib/core/paths');
const { withServer, withTempHome } = require('../test-support/helpers');
const { tmpDir } = require('../test-support/packs');

// Names that are not plain kebab-case. Every one of them either escapes its
// parent directory when joined, or reaches a case-folding filesystem as a name
// the registry cannot resolve back.
const MALFORMED = ['Bad Name', '../../etc', '/etc/passwd', 'a/b', '..', '', '-leading', 'has.dot', 'UPPER'];

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-names-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

// A refusal is anything that did not write. Each entry reports { refused, detail }
// so the failure message names the site AND what it actually did.
const ENTRIES = [
  {
    label: 'POST /api/components (the save route), tier local',
    // The route is the actor-facing entry: the save_component MCP tool and any
    // pane script's fetch both land here.
    async attempt(t, name) {
      const ctx = t.ctx || (t.ctx = await withServer(t));
      const r = await ctx.api.post('/api/components', { name, source: '<p>x</p>', description: 'd', location: 'local' });
      return { refused: r.json?.ok !== true, detail: `${r.status} ${JSON.stringify(r.json)}` };
    },
  },
  {
    label: 'POST /api/components (the save route), tier system',
    async attempt(t, name) {
      const ctx = t.ctx || (t.ctx = await withServer(t));
      const r = await ctx.api.post('/api/components', { name, source: '<p>x</p>', description: 'd', location: 'system' });
      return { refused: r.json?.ok !== true, detail: `${r.status} ${JSON.stringify(r.json)}` };
    },
  },
  {
    label: 'componentsRegistry().save (the registry write), tier local',
    // The function that actually mkdirs the directory and writes the meta.json
    // without a `builtin` marker. resourceRegistry says the caller owns the
    // policy; this asserts it anyway, so a future caller inherits the refusal.
    async attempt(t, name) {
      const root = t.root || (t.root = project(t));
      try {
        componentsRegistry(resolvePaths(root)).save(name, { source: '<p>x</p>' }, { tier: 'local' });
        return { refused: false, detail: 'save() returned normally' };
      } catch (e) { return { refused: true, detail: e.message }; }
    },
  },
  {
    label: 'componentsRegistry().save (the registry write), tier system',
    async attempt(t, name) {
      const root = t.root || (t.root = project(t));
      try {
        componentsRegistry(resolvePaths(root)).save(name, { source: '<p>x</p>' }, { tier: 'system' });
        return { refused: false, detail: 'save() returned normally' };
      } catch (e) { return { refused: true, detail: e.message }; }
    },
  },
  {
    label: 'validateManifest (the packs manifest reader)',
    async attempt(t, name) {
      const v = validateManifest({ name: 'acme-ops', version: '1.0.0', components: [name] });
      return { refused: v.ok === false && v.components.length === 0, detail: v.errors.join('; ') || 'accepted' };
    },
  },
  {
    label: 'planInstall (the packs plan), tier local',
    // Quarantine deliberately plans packs that FAILED validation, so plan()
    // cannot lean on validateManifest having refused first.
    async attempt(t, name) {
      const root = t.root || (t.root = project(t));
      const p = planInstall({ stageDir: tmpDir('wc-stage-'), manifest: { name: 'acme-ops', components: [{ name }] }, root, tier: 'local', replace: true });
      return { refused: p.errors.length > 0 && !p.units.some((u) => u.kind === 'component'), detail: p.errors.join('; ') || 'planned it' };
    },
  },
  {
    label: 'planInstall (the packs plan), tier system',
    async attempt(t, name) {
      const root = t.root || (t.root = project(t));
      const p = planInstall({ stageDir: tmpDir('wc-stage-'), manifest: { name: 'acme-ops', components: [{ name }] }, root, tier: 'system', replace: true });
      return { refused: p.errors.length > 0 && !p.units.some((u) => u.kind === 'component'), detail: p.errors.join('; ') || 'planned it' };
    },
  },
  {
    label: 'removeUnits (the packs tree, reading a recorded unit name)',
    // GRAMMAR ONLY, deliberately: `reserved: false` below. This is the removal
    // path, not a write — refusing to unlink a unit because its name matches a
    // builtin would strand files rather than protect anything. What it must
    // refuse is a name that escapes its own directory.
    reserved: false,
    async attempt(t, name) {
      const root = t.root || (t.root = project(t));
      const pack = { name: 'acme-ops', tier: 'local', units: [{ kind: 'component', name, files: [{ path: 'component.html', sha256: 'x'.repeat(64) }] }] };
      const out = removeUnits(pack, { root, tier: 'local', force: true });
      const state = verifyPack(pack, { root, tier: 'local' }).units[0].state;
      return {
        refused: state === 'unsafe-name' && out.removedAll === false,
        detail: `state=${state} ${JSON.stringify(out.results)}`,
      };
    },
  },
];

for (const entry of ENTRIES) {
  if (entry.reserved !== false) {
    test(`names: ${entry.label} refuses every reserved builtin name`, async (t) => {
      for (const builtin of BUILTIN_COMPONENTS) {
        const r = await entry.attempt(t, builtin);
        assert.equal(r.refused, true, `${entry.label} accepted the builtin name "${builtin}" — ${r.detail}`);
      }
    });
  }

  test(`names: ${entry.label} refuses a name that is not plain kebab-case`, async (t) => {
    for (const bad of MALFORMED) {
      const r = await entry.attempt(t, bad);
      assert.equal(r.refused, true, `${entry.label} accepted ${JSON.stringify(bad)} — ${r.detail}`);
    }
  });
}

// The refusal exists to keep this true, so assert the consequence rather than
// only the status code: after every attempt to save over a builtin, the seeded
// directory is still the builtin, still marked, still repairable.
const SHADOW = '<div>NOT-THE-BUILTIN</div>';

test('names: a refused save leaves the builtin marked and repairable', async (t) => {
  const { api, webChatDir } = await withServer(t);
  for (const builtin of BUILTIN_COMPONENTS) {
    const r = await api.post('/api/components', { name: builtin, source: SHADOW, description: 'shadow' });
    assert.equal(r.json.ok, false, `saving over "${builtin}" must be refused`);
    assert.equal(r.json.reserved, true, 'the refusal says WHY, so the tool and the drawer can show it');
    assert.match(r.json.hint, /built-in/);

    const dir = path.join(webChatDir, 'components', builtin);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.equal(meta.builtin, true, `"${builtin}" must keep its builtin marker — seedBuiltins gates repair on it`);
    assert.equal(fs.readFileSync(path.join(dir, 'component.html'), 'utf8').includes(SHADOW), false);
  }
});

// A malformed name is a 400 (the caller sent nonsense); a reserved one is a 200
// `{ok:false}` (the request was well-formed and the answer is no). save_component
// and the drawer read `.ok`, not the status, so the second must not be a 4xx.
test('names: the save route splits the two refusals into the two shapes callers read', async (t) => {
  const { api } = await withServer(t);
  const bad = await api.post('/api/components', { name: 'Bad Name', source: '<p>x</p>' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /kebab/);

  const reserved = await api.post('/api/components', { name: 'git-dashboard', source: '<p>x</p>' });
  assert.equal(reserved.status, 200, 'a refusal is 200 + ok:false, the same shape the packs route uses');
  assert.equal(reserved.json.ok, false);
});

// seedBuiltins cannot repair a shadow an earlier build let through — overwriting
// it would destroy whatever the user edited into it — so it has to say so.
test('names: seedBuiltins reports a marker-less directory sitting on a builtin name', (t) => {
  const root = project(t);
  const paths = resolvePaths(root);
  seedBuiltins(paths, { log: null });

  const dir = path.join(projectPaths(root).components, 'git-dashboard');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name: 'git-dashboard', description: 'mine' }));
  fs.writeFileSync(path.join(dir, 'component.html'), '<div>shadow</div>');

  const said = [];
  const out = seedBuiltins(paths, { log: (m) => said.push(m) });
  assert.deepEqual(out.shadowed.map((s) => s.name), ['git-dashboard']);
  assert.equal(said.length, 1);
  assert.match(said[0], /git-dashboard/);
  assert.match(said[0], /delete that directory/);
  // …and it is still left alone, because the user's edits are in it.
  assert.equal(fs.readFileSync(path.join(dir, 'component.html'), 'utf8'), '<div>shadow</div>');
});

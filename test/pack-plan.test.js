// What WOULD happen, computed before anything happens.
//
// planInstall is pure, and this suite holds it to that: after every case the
// destination tiers are byte-identical to what they were before. It is the same
// function three callers depend on agreeing about — install, review, and the
// drawer's quarantine card — so if planning and applying could disagree, "show
// me what this would do" would be a lie.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { planInstall } = require('../lib/packs/plan');
const { parseManifest, validateManifest } = require('../lib/packs/manifest');
const { upsertPack } = require('../lib/packs/store');
const { projectPaths, userPaths, claudePaths } = require('../lib/core/paths');
const { packFixture, tmpDir, write } = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

function plan(dir, root, opts = {}) {
  const manifest = validateManifest(parseManifest(dir), { stageDir: dir });
  return { manifest, plan: planInstall({ stageDir: dir, manifest, root, ...opts }) };
}

function snapshot(root) {
  const out = [];
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs); else out.push(path.relative(root, abs));
    }
  };
  walk(root);
  return out.sort();
}

test('a clean plan names every unit, its destination, and its per-file digest', (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }, { name: 'incident-timeline' }], themes: [{ name: 'acme-dark' }] });
  const before = snapshot(root);

  const { plan: p } = plan(dir, root);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.collisions, []);
  const kinds = p.units.map((u) => `${u.kind}:${u.name}`);
  assert.deepEqual(kinds, ['component:deploy-board', 'component:incident-timeline', 'theme:acme-dark', 'skill:acme-ops']);
  const comp = p.units[0];
  assert.equal(comp.dir, path.join(projectPaths(root).components, 'deploy-board'));
  assert.deepEqual(comp.files.map((f) => f.path), ['component.html', 'meta.json']);
  assert.match(comp.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(p.skill.dest, claudePaths(root).rel('skills', 'acme-ops', 'SKILL.md'));

  assert.deepEqual(snapshot(root), before, 'planning writes nothing');
});

test('a component carrying service.js is reported so the trust command can be named up front', (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board', service: 'module.exports={async start(){}};' }, { name: 'incident-timeline' }] });
  const { plan: p } = plan(dir, root);
  assert.deepEqual(p.services, ['deploy-board']);
  assert.equal(p.units[0].files.some((f) => f.path === 'service.js'), true);
});

test('a builtin name is a refusal with no override — even with replace:true', (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'git-dashboard' }] });
  const manifest = validateManifest(parseManifest(dir), { stageDir: dir });
  // Reach past validation deliberately: the plan is the OTHER gate, and it has
  // to refuse on its own rather than trusting that validation already did.
  const forced = { ...manifest, components: [{ name: 'git-dashboard', description: '', params_schema: {}, has_seed: false, has_service: false }] };
  const p = planInstall({ stageDir: dir, manifest: forced, root, replace: true });
  assert.match(p.errors.join('\n'), /built-in name/);
  const col = p.collisions.find((c) => c.name === 'git-dashboard');
  assert.equal(col.severity, 'refused');
  assert.equal(p.units.some((u) => u.name === 'git-dashboard'), false);
});

test('a component already on disk that no pack installed is the user\'s — never silently replaced', (t) => {
  const root = project(t);
  const dest = path.join(projectPaths(root).components, 'deploy-board');
  write(path.join(dest, 'component.html'), '<div>mine</div>');
  write(path.join(dest, 'meta.json'), JSON.stringify({ name: 'deploy-board', description: 'mine' }));

  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const { plan: p } = plan(dir, root);
  const col = p.collisions.find((c) => c.kind === 'component');
  assert.equal(col.severity, 'replace');
  assert.equal(col.owner, 'you');
  assert.match(p.errors.join('\n'), /--replace/);

  const { plan: forced } = plan(dir, root, { replace: true });
  assert.deepEqual(forced.errors, [], '--replace is what makes it proceed — and it is terminal-only');
});

test('a component belonging to ANOTHER pack names that pack', (t) => {
  const root = project(t);
  const dest = path.join(projectPaths(root).components, 'deploy-board');
  write(path.join(dest, 'component.html'), '<div>theirs</div>');
  upsertPack(root, 'local', { name: 'other-pack', units: [{ kind: 'component', name: 'deploy-board', files: [] }] });

  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const { plan: p } = plan(dir, root);
  const col = p.collisions.find((c) => c.kind === 'component');
  assert.equal(col.owner, 'other-pack');
  assert.match(p.errors.join('\n'), /belongs to the pack "other-pack"/);
});

test('re-installing the SAME pack over itself is an update, not a collision to override', (t) => {
  const root = project(t);
  const dest = path.join(projectPaths(root).components, 'deploy-board');
  write(path.join(dest, 'component.html'), '<div>v1</div>');
  upsertPack(root, 'local', { name: 'acme-ops', units: [{ kind: 'component', name: 'deploy-board', files: [] }] });

  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const { plan: p } = plan(dir, root);
  assert.deepEqual(p.errors, []);
  assert.equal(p.collisions[0].severity, 'update');
});

test('a builtin ALREADY on disk cannot be replaced either — the meta.json flag is what is checked', (t) => {
  const root = project(t);
  const dest = path.join(projectPaths(root).components, 'my-widget');
  write(path.join(dest, 'component.html'), '<div>builtin</div>');
  write(path.join(dest, 'meta.json'), JSON.stringify({ name: 'my-widget', builtin: true }));

  const dir = packFixture({ components: [{ name: 'my-widget' }] });
  const { plan: p } = plan(dir, root, { replace: true });
  assert.match(p.errors.join('\n'), /would shadow a built-in/);
  assert.equal(p.collisions[0].severity, 'refused');
});

test('a --global install whose name this project already uses is flagged as shadowed, not silently useless', (t) => {
  const root = project(t);
  const local = path.join(projectPaths(root).components, 'deploy-board');
  write(path.join(local, 'component.html'), '<div>project copy</div>');
  write(path.join(local, 'meta.json'), JSON.stringify({ name: 'deploy-board', description: 'project copy' }));

  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const { plan: p } = plan(dir, root, { tier: 'system' });
  const shadow = p.collisions.find((c) => c.severity === 'shadowed');
  assert.ok(shadow, 'the project copy keeps winning — say so');
  assert.match(shadow.detail, /project copy keeps winning/);
  assert.deepEqual(p.errors, [], 'shadowing is a warning, not a refusal');
});

test('a --global plan targets the user tier for components AND for the skill', (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const { plan: p } = plan(dir, root, { tier: 'system' });
  assert.equal(p.units[0].dir, path.join(userPaths().components, 'deploy-board'));
  const skill = p.units.find((u) => u.kind === 'skill');
  assert.match(skill.dir, /\.claude\/skills\/acme-ops$/);
  assert.ok(skill.dir.startsWith(process.env.HOME), 'the skill follows its components tier — never discoverable where they are not');
});

test('a pack with no SKILL.md plans no skill unit', (t) => {
  const root = project(t);
  const dir = packFixture({ skill: false });
  const { plan: p } = plan(dir, root);
  assert.equal(p.skill, null);
  assert.equal(p.units.some((u) => u.kind === 'skill'), false);
});

// ── "PURE" means no directories either ──────────────────────────────────────
// snapshot() above walks FILES, which is why this went unnoticed for so long:
// planInstall resolved its registry through lib/server/paths, whose resolvePaths
// calls ensureProjectDirs, so every plan mkdir'd six directories in the target
// project — including the plan quarantinePack computes for a tree the user has
// NOT approved, whose whole promise is "nothing is installed, nothing is
// registered".

function dirSnapshot(root) {
  const out = [];
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory()) continue;
      const abs = path.join(d, e.name);
      out.push(path.relative(root, abs));
      walk(abs);
    }
  };
  walk(root);
  return out;
}

test('planInstall creates no directories in the project or the user tier', (t) => {
  const root = project(t);
  const home = path.dirname(userPaths().root);
  const dir = packFixture({ components: [{ name: 'deploy-board' }], themes: [{ name: 'acme-dark' }] });

  const beforeProject = dirSnapshot(root);
  const beforeHome = dirSnapshot(home);

  const { plan: p } = plan(dir, root);
  assert.ok(p.units.length, 'the plan still describes what it would do');

  assert.deepEqual(dirSnapshot(root), beforeProject, 'planning created a directory in the project');
  assert.deepEqual(dirSnapshot(home), beforeHome, 'planning created a directory in ~/.web-chat');
});

test('planInstall touches nothing at all when the project has no .web-chat yet', (t) => {
  withTempHome(t);
  const root = tmpDir('wc-bare-'); // deliberately NOT initialised
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });

  const { plan: p } = plan(dir, root);
  assert.ok(p.units.length);
  assert.deepEqual(fs.readdirSync(root), [], 'a plan against a bare directory left it bare');
});

test('lib/packs no longer reaches into lib/server for its paths', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'packs', 'plan.js'), 'utf8');
  assert.ok(!/require\(['"]\.\.\/server\/paths['"]\)/.test(src),
    'plan.js imports the server paths adapter again — it mkdirs, which makes planInstall impure');
});

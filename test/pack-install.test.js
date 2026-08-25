// End to end through the library: fetch → validate → plan → apply → record.
//
// The three things that must remain true after an install, whichever actor asked
// for it: the components resolve through the ordinary registry, the skill lands
// beside them in the SAME tier, and a `service.js` is present but UNAPPROVED —
// consent is keyed to the file's hash, so a freshly-installed service is
// unapproved by construction and stays that way until `claude-web-chat trust`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const packs = require('../lib/packs/install');
const { listPacks, findPack, readAudit, readStore } = require('../lib/packs/store');
const { componentsRegistry } = require('../lib/server/components-registry');
const { resolvePaths } = require('../lib/server/paths');
const { projectPaths, userPaths, claudePaths, userClaudePaths } = require('../lib/core/paths');
const { packFixture, tmpDir, write, fakeForge, repoWithArchive, repoWithRelease } = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');

const SHA = 'a'.repeat(40);
const SERVICE = "module.exports = { async start(ctx) { ctx.driver.setStore({ deploys: [] }); }, async stop() {} };\n";

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

async function forgeFor(t, dir, opts = {}) {
  return fakeForge(t, { repos: { 'acme/ops': opts.release ? repoWithRelease(dir, opts) : repoWithArchive(dir, { sha: SHA, ...opts }) } });
}

test('installing a pack lands its components, its theme and its SKILL.md, and records provenance', async (t) => {
  const root = project(t);
  const dir = packFixture({
    components: [{ name: 'deploy-board', description: 'Live deploys.' }, { name: 'incident-timeline' }],
    themes: [{ name: 'acme-dark' }],
  });
  const forge = await forgeFor(t, dir);

  const out = await packs.installPack({ url: forge.url('acme', 'ops'), root, actor: 'cli' });
  assert.equal(out.ok, true);

  // Components resolve through the ORDINARY registry — flat in the tier dir, so
  // use_component can find them with no third tier.
  const registry = componentsRegistry(resolvePaths(root));
  assert.ok(registry.get('deploy-board'), 'the pack component resolves like any other');
  assert.equal(registry.get('deploy-board').tier, 'local');
  assert.equal(registry.list().filter((c) => c.name === 'incident-timeline').length, 1);

  assert.ok(fs.existsSync(path.join(projectPaths(root).themesDir, 'acme-dark.json')));
  assert.ok(fs.existsSync(claudePaths(root).skill('acme-ops')), 'the skill lands beside its components');

  const [rec] = listPacks(root);
  assert.equal(rec.name, 'acme-ops');
  assert.equal(rec.tier, 'local');
  assert.equal(rec.source.sha, SHA);
  assert.equal(rec.source.via, 'archive');
  assert.equal(rec.units.length, 4);
  assert.match(rec.skill.description, /deploys/);
});

test('a `service.js` installs but is NOT trusted — it stays inert until the terminal command', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board', service: SERVICE }] });
  const forge = await forgeFor(t, dir);
  const out = await packs.installPack({ url: forge.url('acme', 'ops'), root });

  const svc = path.join(projectPaths(root).components, 'deploy-board', 'service.js');
  assert.ok(fs.existsSync(svc), 'the file is there');
  assert.deepEqual(out.pack.services, ['deploy-board'], 'and the caller is told, so it can name the trust command');

  // Consent is keyed to (project, service.js hash, params). A fresh service has
  // no record, so it is unapproved BY CONSTRUCTION — nothing had to remember to
  // withhold approval.
  const trustFile = userPaths().trustedServices;
  assert.equal(fs.existsSync(trustFile), false, 'installing a pack grants nothing');
});

test('--global puts the components in the user tier and the skill in ~/.claude', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);
  await packs.installPack({ url: forge.url('acme', 'ops'), root, tier: 'system' });

  assert.ok(fs.existsSync(path.join(userPaths().components, 'deploy-board', 'component.html')));
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
  assert.ok(fs.existsSync(userClaudePaths().skill('acme-ops')));
  assert.equal(listPacks(root)[0].tier, 'system');

  // And it still resolves from this project, through the system tier.
  assert.equal(componentsRegistry(resolvePaths(root)).get('deploy-board').tier, 'system');
});

test('a verified release install records sums_verified and the tag', async (t) => {
  const root = project(t);
  const dir = packFixture();
  const forge = await fakeForge(t, { repos: { 'acme/ops': repoWithRelease(dir, { sha: 'b'.repeat(40) }) } });
  const out = await packs.installPack({ url: forge.url('acme', 'ops'), root });
  assert.equal(out.pack.source.via, 'release');
  assert.equal(out.pack.source.sums_verified, true);
  assert.equal(out.pack.source.ref, 'v1.2.0');
});

test('a builtin collision is refused for the CLI actor and nothing is written', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'git-dashboard' }] });
  const forge = await forgeFor(t, dir);
  await assert.rejects(packs.installPack({ url: forge.url('acme', 'ops'), root, actor: 'cli' }), /built-in name/);
  assert.deepEqual(listPacks(root), []);
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'git-dashboard')), false);
});

test('a user\'s own same-named component is never silently replaced; --replace is what does it', async (t) => {
  const root = project(t);
  const mine = path.join(projectPaths(root).components, 'deploy-board');
  write(path.join(mine, 'component.html'), '<div>mine</div>');
  write(path.join(mine, 'meta.json'), JSON.stringify({ name: 'deploy-board', description: 'mine' }));

  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);

  await assert.rejects(packs.installPack({ url: forge.url('acme', 'ops'), root }), /--replace/);
  assert.match(fs.readFileSync(path.join(mine, 'component.html'), 'utf8'), /mine/, 'refused means untouched');

  await packs.installPack({ url: forge.url('acme', 'ops'), root, replace: true });
  assert.doesNotMatch(fs.readFileSync(path.join(mine, 'component.html'), 'utf8'), /mine/);
});

test('every install appends to the audit log, recording its actor', async (t) => {
  const root = project(t);
  const dir = packFixture();
  const forge = await forgeFor(t, dir);
  await packs.installPack({ url: forge.url('acme', 'ops'), root, actor: 'http' });

  const log = readAudit(root);
  assert.equal(log.length, 1);
  assert.equal(log[0].op, 'install');
  assert.equal(log[0].actor, 'http', 'a pane-initiated install is at least discoverable');
  assert.equal(log[0].sha, SHA);
  assert.ok(fs.existsSync(projectPaths(root).packsAudit));
});

test('installing over this pack\'s own earlier version replaces its units and re-records', async (t) => {
  const root = project(t);
  const v1 = packFixture({ version: '1.0.0', components: [{ name: 'deploy-board', html: '<div>v1</div>' }] });
  const forge1 = await forgeFor(t, v1);
  await packs.installPack({ url: forge1.url('acme', 'ops'), root });

  const v2 = packFixture({ version: '2.0.0', components: [{ name: 'deploy-board', html: '<div>v2</div>' }] });
  const forge2 = await fakeForge(t, { repos: { 'acme/ops': repoWithArchive(v2, { sha: 'c'.repeat(40) }) } });
  const out = await packs.installPack({ url: forge2.url('acme', 'ops'), root });

  assert.equal(out.pack.version, '2.0.0');
  assert.equal(listPacks(root).length, 1, 'one record per pack per tier');
  assert.match(fs.readFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), 'utf8'), /v2/);
});

test('listInstalled reports what is installed, and with verify:true whether it drifted', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);
  await packs.installPack({ url: forge.url('acme', 'ops'), root });

  let { packs: list } = packs.listInstalled({ root, verify: true });
  assert.equal(list[0].drift, false);

  fs.appendFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), '<!-- mine -->');
  ({ packs: list } = packs.listInstalled({ root, verify: true }));
  assert.equal(list[0].drift, true);
  assert.equal(list[0].unit_states.find((u) => u.name === 'deploy-board').state, 'edited');
});

test('a pack whose requires excludes this build is refused before anything is written', async (t) => {
  const root = project(t);
  const dir = packFixture({ requires: { 'web-chat': '>=99.0.0' } });
  const forge = await forgeFor(t, dir);
  await assert.rejects(packs.installPack({ url: forge.url('acme', 'ops'), root }), /needs web-chat >=99\.0\.0/);
  assert.deepEqual(listPacks(root), []);
});

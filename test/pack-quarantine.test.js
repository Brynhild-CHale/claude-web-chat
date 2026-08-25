// Download for review — the advised default for anything the user did not write.
//
// Two properties carry the whole design:
//
//   1. INERT BY LOCATION. The staged tree goes to .web-chat/packs/quarantine/,
//      and nothing in web-chat reads .web-chat/packs/. No registry tier points
//      there; the components registry cannot see it; the service supervisor
//      never hears about it. That is a stronger guarantee than a flag someone
//      has to remember to check.
//   2. THE INTEGRITY RECORD IS USER-TIER. A repository can commit a
//      plausible-looking .web-chat/packs/quarantine/<name>/ tree. It cannot
//      forge the ~/.web-chat/packs.json record this machine wrote, and it cannot
//      make tampered bytes hash to what that record says. So `approve`
//      re-hashes and refuses.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const packs = require('../lib/packs/install');
const { listQuarantine, findQuarantine, listPacks, readStore, readAudit } = require('../lib/packs/store');
const { tmpDir: _tmpDir } = require('../test-support/packs');
const { componentsRegistry } = require('../lib/server/components-registry');
const { resolvePaths } = require('../lib/server/paths');
const { projectPaths, userPaths, claudePaths } = require('../lib/core/paths');
const { packFixture, tmpDir, write, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');

const SHA = 'a'.repeat(40);

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}
const forgeFor = (t, dir, sha = SHA) => fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha }) } });

test('quarantine stages the tree and adds NOTHING to the components registry', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }, { name: 'incident-timeline' }] });
  const forge = await forgeFor(t, dir);

  const before = componentsRegistry(resolvePaths(root)).list().map((c) => c.name).sort();
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  assert.equal(record.name, 'acme-ops');
  assert.ok(fs.existsSync(path.join(record.pack_dir, 'web-chat-pack.json')));
  assert.ok(record.dir.startsWith(projectPaths(root).quarantine), 'inert by LOCATION');

  const after = componentsRegistry(resolvePaths(root)).list().map((c) => c.name).sort();
  assert.deepEqual(after, before, 'a quarantined component is not a component');
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
  assert.equal(fs.existsSync(claudePaths(root).skill('acme-ops')), false, 'and its skill is not in Claude\'s context either');
  assert.deepEqual(listPacks(root), [], 'nothing is recorded as installed');
});

test('the integrity record is written to the USER tier, not into the project', async (t) => {
  const root = project(t);
  const dir = packFixture();
  const forge = await forgeFor(t, dir);
  await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  assert.equal(listQuarantine().length, 1, 'the record lives in ~/.web-chat/packs.json');
  assert.equal(readStore(projectPaths(root).packs).quarantine.length, 0, 'and never in the project, which a repo can commit');
  assert.match(findQuarantine('acme-ops').tree_sha256, /^[0-9a-f]{64}$/);
});

test('review reads the manifest, the plan, the file tree and one file\'s text — and writes nothing', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board', service: 'module.exports={async start(){}};' }] });
  const forge = await forgeFor(t, dir);
  await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  const r = packs.reviewQuarantine({ name: 'acme-ops', root });
  assert.equal(r.manifest.name, 'acme-ops');
  assert.deepEqual(r.plan.services, ['deploy-board'], 'a service.js is flagged before approval, not after');
  assert.ok(r.tree.some((f) => f.path === 'SKILL.md'));
  assert.ok(r.tree.every((f) => typeof f.bytes === 'number'));

  const skill = packs.reviewQuarantine({ name: 'acme-ops', root, file: 'SKILL.md' });
  assert.match(skill.text, /^---/, 'the SKILL.md is readable in full — it is what nobody thinks to read');

  assert.throws(() => packs.reviewQuarantine({ name: 'acme-ops', root, file: '../../../etc/passwd' }), /is not part of the quarantined pack/);
});

test('the record lists EVERY component it would add, not only the ones with a service', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [
    { name: 'deploy-board', description: 'Live deploys.', service: 'module.exports={};' },
    { name: 'incident-timeline', description: 'Incidents.', seed: 'return {};' },
  ] });
  const forge = await forgeFor(t, dir);
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  // "What would this add?" is the first question a reviewer asks, and the card
  // is built from this record.
  assert.deepEqual(record.components.map((c) => c.name), ['deploy-board', 'incident-timeline']);
  assert.equal(record.components[0].has_service, true);
  assert.equal(record.components[1].has_service, false);
  assert.equal(record.components[1].has_seed, true);
  assert.equal(record.components[1].description, 'Incidents.');

  const { quarantined } = packs.listInstalled({ root });
  assert.deepEqual(quarantined[0].components.map((c) => c.name), ['deploy-board', 'incident-timeline']);
});

test('approve installs the reviewed tree and clears the quarantine', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  const out = packs.approvePack({ name: 'acme-ops', root, actor: 'cli' });
  assert.equal(out.ok, true);
  assert.ok(componentsRegistry(resolvePaths(root)).get('deploy-board'));
  assert.ok(fs.existsSync(claudePaths(root).skill('acme-ops')));
  assert.equal(listQuarantine().length, 0);
  assert.equal(fs.existsSync(record.dir), false, 'the staged copy is not left lying around');
  assert.equal(listPacks(root)[0].source.sha, SHA, 'provenance survives the review detour');
});

test('approve REFUSES a staged tree that was tampered with after it was downloaded', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  // Somebody edits the quarantined pane script between review and approval.
  fs.appendFileSync(path.join(record.pack_dir, 'components', 'deploy-board', 'component.html'), '<script>fetch("http://evil")</script>');

  assert.throws(() => packs.approvePack({ name: 'acme-ops', root }), /no longer matches what was downloaded/);
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false, 'refused means nothing installed');
  assert.equal(listQuarantine().length, 1, 'and the quarantine is left for the user to discard deliberately');
});

test('approve REFUSES a quarantine directory this machine did not stage', async (t) => {
  const root = project(t);
  // Exactly what a hostile repository can commit: a complete, plausible
  // quarantine tree, with no user-tier record behind it.
  const fake = path.join(projectPaths(root).quarantine, 'evil-pack');
  write(path.join(fake, 'pack', 'web-chat-pack.json'), JSON.stringify({ name: 'evil-pack', version: '1.0.0', components: ['x'] }));
  write(path.join(fake, 'pack', 'components', 'x', 'component.html'), '<script>fetch("http://evil")</script>');
  write(path.join(fake, 'plan.json'), JSON.stringify({ name: 'evil-pack', units: [] }));

  assert.throws(() => packs.approvePack({ name: 'evil-pack', root }), /it was not staged here/);
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'x')), false);
});

test('a symlink appearing in the staged tree between download and approval is refused', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  fs.symlinkSync('/etc/passwd', path.join(record.pack_dir, 'components', 'deploy-board', 'secrets.txt'));
  assert.throws(() => packs.approvePack({ name: 'acme-ops', root }), /is a symlink/);
});

test('discard removes the tree and the record, and is safe — nothing was live', async (t) => {
  const root = project(t);
  const dir = packFixture();
  const forge = await forgeFor(t, dir);
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  packs.discardPack({ name: 'acme-ops', root, actor: 'http' });
  assert.equal(fs.existsSync(record.dir), false);
  assert.equal(listQuarantine().length, 0);
  assert.equal(readAudit(root).at(-1).op, 'discard');
});

test('a pack that would NOT install is still staged — seeing why is the point of review', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'git-dashboard' }] });
  const forge = await forgeFor(t, dir);
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  assert.ok(record.errors.some((e) => /built-in name/.test(e)));
  const r = packs.reviewQuarantine({ name: 'acme-ops', root });
  assert.ok(r.manifest.errors.some((e) => /built-in name/.test(e)));
  // …and approving it still refuses, with no override anywhere.
  assert.throws(() => packs.approvePack({ name: 'acme-ops', root, replace: true }), /built-in name/);
});

test('quarantine + approve is recorded in the audit log as two steps', async (t) => {
  const root = project(t);
  const dir = packFixture();
  const forge = await forgeFor(t, dir);
  await packs.quarantinePack({ url: forge.url('acme', 'ops'), root, actor: 'http' });
  packs.approvePack({ name: 'acme-ops', root, actor: 'cli' });
  const ops = readAudit(root).map((e) => `${e.op}:${e.actor}`);
  assert.deepEqual(ops, ['quarantine:http', 'approve:cli']);
});

// ── the name is a PATH, and it comes out of the pack ────────────────────────
// A pack's `name` is read from its own web-chat-pack.json — a file written by
// whoever published the repository — and it is used to build the quarantine
// staging directory, which is then rm -rf'd before the files are written into
// it. Quarantine deliberately stages packs that FAILED validation (seeing why
// is the point of review), so "validation would have refused it" is not a
// defence available here.

test('a pack whose NAME is a path traversal is refused before anything is deleted', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  // The name a hostile repository would ship.
  const evil = '../../../../victim';
  fs.writeFileSync(path.join(dir, 'web-chat-pack.json'), JSON.stringify({
    name: evil, version: '1.0.0', components: ['deploy-board'],
  }, null, 2));

  // Something valuable at the path that name resolves to.
  const victim = path.join(projectPaths(root).quarantine, evil);
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keepme.txt'), 'IMPORTANT');

  const forge = await forgeFor(t, dir);
  await assert.rejects(
    packs.quarantinePack({ url: forge.url('acme', 'ops'), root }),
    /not a plain kebab-case name/,
  );
  assert.ok(fs.existsSync(path.join(victim, 'keepme.txt')),
    'the directory that name pointed at is still there, with its contents');
  assert.deepEqual(listQuarantine(), []);
});

test('the same refusal holds at the staging site itself, not only at the caller', async (t) => {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  const { stageQuarantine } = require('../lib/packs/tree');
  const victim = path.join(root, 'victim');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keepme.txt'), 'IMPORTANT');

  assert.throws(() => stageQuarantine({
    stageDir: root, files: [], name: '../../victim',
    quarantineRoot: projectPaths(root).quarantine, tier: 'local', source: {}, plan: {}, manifest: {},
  }), /not a plain kebab-case name/);
  assert.ok(fs.existsSync(path.join(victim, 'keepme.txt')));
});

test('review and discard refuse a traversal name too — they both build paths from it', async (t) => {
  const root = project(t);
  assert.throws(() => packs.reviewQuarantine({ name: '../../etc', root }), /not a plain kebab-case name/);
  assert.throws(() => packs.discardPack({ name: '../../etc', root }), /not a plain kebab-case name/);
});

test('reviewing a file that vanished after staging is a readable refusal, not a raw ENOENT', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);
  const { record } = await packs.quarantinePack({ url: forge.url('acme', 'ops'), root });

  fs.unlinkSync(path.join(record.pack_dir, 'SKILL.md'));
  // The tree walk tolerates this and reports bytes: 0, so reading must too — the
  // 200/ok:false convention this module keeps everywhere else.
  const listing = packs.reviewQuarantine({ name: 'acme-ops', root });
  assert.equal(listing.tree.find((f) => f.path === 'SKILL.md').bytes, 0);
  assert.throws(
    () => packs.reviewQuarantine({ name: 'acme-ops', root, file: 'SKILL.md' }),
    /no longer on disk/,
  );
});

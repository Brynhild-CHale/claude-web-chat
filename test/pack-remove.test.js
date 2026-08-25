// Removal is per UNIT, not per file.
//
// A component is a directory of four files. If the user edited component.html
// and `remove` deleted the other three, what is left is a broken half-component
// the registry still lists and use_component still resolves — worse than either
// "gone" or "kept". So a unit goes only when every recorded file still matches
// its baseline; one edited file keeps the WHOLE unit and releases it to the user
// as their own. `--force` is the terminal-only override.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const packs = require('../lib/packs/install');
const { listPacks, readAudit } = require('../lib/packs/store');
const { verifyPack } = require('../lib/packs/tree');
const { componentsRegistry } = require('../lib/server/components-registry');
const { resolvePaths } = require('../lib/server/paths');
const { projectPaths, userPaths, claudePaths } = require('../lib/core/paths');
const { packFixture, tmpDir, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');

const SHA = 'a'.repeat(40);

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}
const forgeFor = (t, dir) => fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha: SHA }) } });

async function installed(t, opts = {}) {
  const root = project(t);
  const dir = packFixture({
    components: [{ name: 'deploy-board' }, { name: 'incident-timeline' }],
    themes: [{ name: 'acme-dark' }],
    ...opts,
  });
  const forge = await forgeFor(t, dir);
  await packs.installPack({ url: forge.url('acme', 'ops'), root, tier: opts.tier || 'local' });
  return root;
}

test('an untouched pack is removed whole — components, theme, skill and record', async (t) => {
  const root = await installed(t);
  const out = packs.removePackByName({ name: 'acme-ops', root });
  assert.equal(out.removedAll, true);

  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'incident-timeline')), false);
  assert.equal(fs.existsSync(path.join(projectPaths(root).themesDir, 'acme-dark.json')), false);
  assert.equal(fs.existsSync(claudePaths(root).skill('acme-ops')), false);
  assert.deepEqual(listPacks(root), []);
  assert.equal(componentsRegistry(resolvePaths(root)).get('deploy-board'), null);
});

test('removing a theme unit never removes the shared themes directory', async (t) => {
  const root = await installed(t);
  fs.writeFileSync(path.join(projectPaths(root).themesDir, 'mine.json'), '{}');
  packs.removePackByName({ name: 'acme-ops', root });
  assert.ok(fs.existsSync(path.join(projectPaths(root).themesDir, 'mine.json')), 'my own theme is not collateral');
});

test('a DRIFTED pack: the HTTP actor is refused and handed the terminal command', async (t) => {
  const root = await installed(t);
  fs.appendFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), '<!-- my edit -->');

  // refuseOnDrift is what lib/server/routes/packs.js passes — and only it. That
  // endpoint cannot tell a user's click from a pane's fetch, so it declines to
  // touch a pack the user has been editing at all.
  let err = null;
  try { packs.removePackByName({ name: 'acme-ops', root, refuseOnDrift: true }); } catch (e) { err = e; }
  assert.ok(err, 'over HTTP a drifted remove is a refusal, not a silent overwrite');
  assert.match(err.message, /has local edits/);
  assert.equal(err.command, 'claude-web-chat pack remove acme-ops');
  assert.ok(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html')));
  assert.equal(listPacks(root).length, 1);
});

test('a DRIFTED pack from a TERMINAL removes what you did not touch and keeps what you did', async (t) => {
  const root = await installed(t);
  const edited = path.join(projectPaths(root).components, 'deploy-board', 'component.html');
  fs.appendFileSync(edited, '<!-- my edit -->');

  const out = packs.removePackByName({ name: 'acme-ops', root });   // no refuseOnDrift: the CLI default
  assert.equal(out.removedAll, false);
  assert.equal(out.results.find((r) => r.name === 'deploy-board').action, 'kept-edited');
  assert.equal(out.results.find((r) => r.name === 'incident-timeline').action, 'removed');

  assert.ok(fs.existsSync(edited), 'the unit I edited is mine now');
  assert.match(fs.readFileSync(edited, 'utf8'), /my edit/);
  assert.ok(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board', 'meta.json')),
    'and its untouched siblings stay with it — never a broken half-component');
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'incident-timeline')), false);
  assert.equal(fs.existsSync(claudePaths(root).skill('acme-ops')), false, 'the clean units did go');

  const { pack } = require('../lib/packs/store').findPack(root, 'acme-ops');
  assert.deepEqual((pack.units || []).map((u) => u.name), ['deploy-board'],
    'the record keeps only what is still on disk');
});

test('--force removes a drifted pack, edits and all — and SAYS removed, not overwritten', async (t) => {
  const root = await installed(t);
  fs.appendFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), '<!-- my edit -->');
  const out = packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(out.removedAll, true);
  // The one case where the report has to be exact: the user is being told what
  // happened to work they did themselves, and "overwritten" and "deleted" are
  // not the same news.
  assert.equal(out.results.find((r) => r.name === 'deploy-board').action, 'removed');
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
  assert.deepEqual(listPacks(root), []);
});

test('ONE edited file keeps the WHOLE unit — never a broken half-component', async (t) => {
  const root = await installed(t);
  const dir = path.join(projectPaths(root).components, 'deploy-board');
  fs.appendFileSync(path.join(dir, 'meta.json'), '\n');

  // Reach past the drift refusal the way the CLI does after the user confirms
  // per-unit preservation: removeUnits itself is what implements the rule.
  const { pack, tier } = require('../lib/packs/store').findPack(root, 'acme-ops');
  const { results, removedAll } = require('../lib/packs/tree').removeUnits(pack, { root, tier });

  assert.equal(removedAll, false);
  const kept = results.find((r) => r.name === 'deploy-board');
  assert.equal(kept.action, 'kept-edited');
  assert.ok(fs.existsSync(path.join(dir, 'component.html')), 'the untouched siblings stay too — the unit is the unit');
  assert.ok(fs.existsSync(path.join(dir, 'meta.json')));
  // …while the clean unit next door did go.
  assert.equal(results.find((r) => r.name === 'incident-timeline').action, 'removed');
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'incident-timeline')), false);
});

test('a dry run REPORTS drift instead of refusing on it — that is the question being asked', async (t) => {
  const root = await installed(t);
  fs.appendFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), '<!-- mine -->');
  const out = packs.removePackByName({ name: 'acme-ops', root, dryRun: true });
  assert.equal(out.drift, true);
  assert.equal(out.results.find((r) => r.name === 'deploy-board').action, 'kept-edited');
  assert.equal(out.results.find((r) => r.name === 'incident-timeline').action, 'removed');
  assert.ok(fs.existsSync(path.join(projectPaths(root).components, 'incident-timeline', 'component.html')), 'and nothing moved');
});

test('after a partial remove the record keeps ONLY the kept units, so a later --force still knows what it is looking at', async (t) => {
  const root = await installed(t);
  fs.appendFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), '<!-- mine -->');

  const { findPack } = require('../lib/packs/store');
  const { removeUnits } = require('../lib/packs/tree');
  const { pack, tier } = findPack(root, 'acme-ops');
  const { results } = removeUnits(pack, { root, tier });
  assert.equal(results.find((r) => r.name === 'deploy-board').action, 'kept-edited');

  // Which is what removePackByName then persists (exercised via the real path
  // with --force off but the clean units already gone).
  const still = findPack(root, 'acme-ops');
  assert.ok(still, 'the record survives a partial remove');
  assert.equal(verifyPack(still.pack, { root, tier }).units.find((u) => u.name === 'deploy-board').state, 'edited');
});

test('a file the user ADDED to a pack component keeps the directory', async (t) => {
  const root = await installed(t);
  const dir = path.join(projectPaths(root).components, 'deploy-board');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'my notes');
  packs.removePackByName({ name: 'acme-ops', root });
  assert.ok(fs.existsSync(path.join(dir, 'notes.md')), 'we remove what we wrote, not the directory wholesale');
  assert.equal(fs.existsSync(path.join(dir, 'component.html')), false);
});

test('a --global pack removes from the user tier and from ~/.claude', async (t) => {
  const root = await installed(t, { tier: 'system' });
  packs.removePackByName({ name: 'acme-ops', root });
  assert.equal(fs.existsSync(path.join(userPaths().components, 'deploy-board')), false);
  assert.equal(fs.existsSync(require('../lib/core/paths').userClaudePaths().skill('acme-ops')), false);
});

test('removing something that is not installed says so rather than half-working', async (t) => {
  const root = project(t);
  assert.throws(() => packs.removePackByName({ name: 'nope', root }), /no pack called "nope" is installed/);
});

test('a remove is audited with its actor and whether it was forced', async (t) => {
  const root = await installed(t);
  packs.removePackByName({ name: 'acme-ops', root, actor: 'http' });
  const last = readAudit(root).at(-1);
  assert.equal(last.op, 'remove');
  assert.equal(last.actor, 'http');
  assert.equal(last.force, false);
});

test('dryRun computes the result without touching anything', async (t) => {
  const root = await installed(t);
  const out = packs.removePackByName({ name: 'acme-ops', root, dryRun: true });
  assert.equal(out.results.length, 4);
  assert.ok(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html')));
  assert.equal(listPacks(root).length, 1);
});

test('a partial removal trims the record\'s summary fields, not just its units', async (t) => {
  const root = await installed(t, { components: [
    { name: 'deploy-board', service: 'module.exports={async start(){}};' },
    { name: 'incident-timeline' },
  ] });
  fs.appendFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), '<!-- mine -->');

  packs.removePackByName({ name: 'acme-ops', root });

  const [rec] = packs.listInstalled({ root }).packs;
  assert.deepEqual(rec.components, ['deploy-board'], 'only what survived');
  assert.equal(fs.existsSync(claudePaths(root).skill('acme-ops')), false, 'the skill file is gone…');
  assert.equal(rec.skill, null,
    '…so the record must not still advertise it — `pack list` was naming a file the same removal had deleted');
  assert.deepEqual(rec.services, ['deploy-board'], 'services trim to the components that remain');
});

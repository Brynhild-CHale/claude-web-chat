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

// ── the record is untrusted input ───────────────────────────────────────────
// .web-chat/packs.json is PROJECT tier, and lib/packs/store.js already states
// the threat: a repository can commit a plausible-looking .web-chat/ tree. Every
// path removeUnits unlinks is built by joining `unit.name` and `f.path` out of
// that record, so a cloned repo could ship a record naming a file outside the
// project and the documented recovery (`pack remove`) would delete it.

const { upsertPack } = require('../lib/packs/store');

// A record that was never written by an install — the shape a hostile
// repository would commit.
function plantRecord(root, units, { name = 'acme-ops', tier = 'local' } = {}) {
  upsertPack(root, tier, {
    name,
    version: '1.0.0',
    description: 'planted',
    installed_at: new Date().toISOString(),
    source: { slug: 'acme/ops', sha: SHA },
    units,
  });
}

test('a record whose file path traverses out of the unit is refused, not unlinked', async (t) => {
  const root = project(t);
  const victim = path.join(root, 'KEEP-ME.txt');
  fs.writeFileSync(victim, 'do not delete me');

  plantRecord(root, [{
    kind: 'component',
    name: 'deploy-board',
    files: [{ path: '../../../KEEP-ME.txt', sha256: 'x'.repeat(64) }],
  }]);

  const res = await packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(fs.existsSync(victim), true, 'the file outside the unit is still there');
  assert.equal(res.results[0].action, 'refused');
  assert.match(res.results[0].reason, /escapes the unit directory/);
  assert.equal(res.removedAll, false, 'a refused unit keeps the record for a human to look at');
  assert.equal(listPacks(root).length, 1, 'the record survives so the evidence is not erased');
});

test('a record whose UNIT NAME traverses out is refused before a directory is derived', async (t) => {
  const root = project(t);
  const victimDir = path.join(root, 'src');
  fs.mkdirSync(victimDir, { recursive: true });
  fs.writeFileSync(path.join(victimDir, 'index.js'), 'module.exports = 1;\n');

  plantRecord(root, [{
    kind: 'component',
    name: '../../src',
    files: [{ path: 'index.js', sha256: 'x'.repeat(64) }],
  }]);

  const res = await packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(fs.existsSync(path.join(victimDir, 'index.js')), true);
  assert.equal(res.results[0].action, 'refused');
  assert.match(res.results[0].reason, /not a plain kebab-case name/);
});

test('an absolute file path in a record is refused', async (t) => {
  const root = project(t);
  const victim = path.join(tmpDir('wc-victim-'), 'secret');
  fs.writeFileSync(victim, 's');

  plantRecord(root, [{
    kind: 'theme',
    name: 'acme-dark',
    files: [{ path: victim, sha256: 'x'.repeat(64) }],
  }]);

  const res = await packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(fs.existsSync(victim), true);
  assert.equal(res.results[0].action, 'refused');
});

test('a record with an unknown unit kind is refused rather than throwing', async (t) => {
  const root = project(t);
  plantRecord(root, [{ kind: 'wat', name: 'thing', files: [{ path: 'a', sha256: 'x'.repeat(64) }] }]);
  const res = await packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(res.results[0].action, 'refused');
});

test('verifyPack reports a refused unit as drift, so refuseOnDrift stops the HTTP path', async (t) => {
  const root = project(t);
  plantRecord(root, [{
    kind: 'component',
    name: 'deploy-board',
    files: [{ path: '../../../etc/anything', sha256: 'x'.repeat(64) }],
  }]);
  const pack = listPacks(root)[0];
  const v = verifyPack(pack, { root, tier: 'local' });
  assert.equal(v.drift, true);
  assert.equal(v.units[0].state, 'refused');

  // removePackByName is synchronous — it throws rather than rejecting. The
  // message is the REFUSAL one, not the "local edits" one: a refused record is
  // not an edit, and no terminal command will remove it either.
  assert.throws(
    () => packs.removePackByName({ name: 'acme-ops', root, refuseOnDrift: true }),
    (e) => /did not validate/.test(e.message) && /escapes the unit directory/.test(e.message) && !/pack remove/.test(e.message),
  );
});

test('a well-formed record still removes cleanly — the gate is not a blanket refusal', async (t) => {
  const root = await installed(t);
  const res = await packs.removePackByName({ name: 'acme-ops', root });
  assert.equal(res.removedAll, true);
  assert.equal(res.results.some((r) => r.action === 'refused'), false);
});

// ── the fence's anchor ──────────────────────────────────────────────────────
// Fencing each recorded file against the unit's own directory is not enough:
// git commits symlinks, so a hostile repository can ship the unit directory
// ITSELF as a link out of the project and both sides of the check then resolve
// through it. The anchor is the project root (system tier: the home), which the
// repository cannot forge.

test('a unit directory that is a committed symlink out of the project is refused', async (t) => {
  const root = project(t);
  const outside = tmpDir('wc-victim-');
  const victim = path.join(outside, 'component.html');
  fs.writeFileSync(victim, '<p>somebody else\'s file</p>');
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(victim)).digest('hex');

  // .web-chat/components/deploy-board -> /outside  (what the clone commits)
  fs.mkdirSync(projectPaths(root).components, { recursive: true });
  fs.symlinkSync(outside, path.join(projectPaths(root).components, 'deploy-board'));

  // The record names only paths that look innocent, and the digest MATCHES —
  // so without the anchor the unit verifies as 'intact' and is removed.
  plantRecord(root, [{
    kind: 'component',
    name: 'deploy-board',
    files: [{ path: 'component.html', sha256: sha }],
  }]);

  const pack = listPacks(root)[0];
  const v = verifyPack(pack, { root, tier: 'local' });
  assert.equal(v.units[0].state, 'refused', 'the symlinked unit directory is refused, not verified');
  assert.match(v.units[0].refused, /resolves outside/);

  // --force does not override a refusal.
  const res = await packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(res.results[0].action, 'refused');
  assert.equal(fs.existsSync(victim), true, 'the file outside the project is still there');

  // ...and the HTTP path (refuseOnDrift, no force) stops on the drift.
  assert.throws(() => packs.removePackByName({ name: 'acme-ops', root, refuseOnDrift: true }));
  assert.equal(fs.existsSync(victim), true);
  assert.equal(listPacks(root).length, 1, 'the record survives so the evidence is not erased');
});

test('a themes directory that is a committed symlink out of the project is refused', async (t) => {
  const root = project(t);
  const outside = tmpDir('wc-victim-');
  const victim = path.join(outside, 'acme-dark.json');
  fs.writeFileSync(victim, '{"tokens":{}}');
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(victim)).digest('hex');

  // A theme unit ignores its name entirely — the shared themes directory IS the
  // unit directory, so a link there needs no traversal in any recorded path.
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  fs.symlinkSync(outside, projectPaths(root).themesDir);

  plantRecord(root, [{
    kind: 'theme',
    name: 'acme-dark',
    files: [{ path: 'acme-dark.json', sha256: sha }],
  }]);

  const v = verifyPack(listPacks(root)[0], { root, tier: 'local' });
  assert.equal(v.units[0].state, 'refused');
  assert.match(v.units[0].refused, /resolves outside/);

  const res = await packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(res.results[0].action, 'refused');
  assert.equal(fs.existsSync(victim), true, 'the file outside the project is still there');

  assert.throws(() => packs.removePackByName({ name: 'acme-ops', root, refuseOnDrift: true }));
  assert.equal(fs.existsSync(victim), true);
});

test('a record whose file list is not an array is refused, not thrown out of', async (t) => {
  const root = project(t);
  plantRecord(root, [{ kind: 'component', name: 'deploy-board', files: 7 }]);
  const v = verifyPack(listPacks(root)[0], { root, tier: 'local' });
  assert.equal(v.units[0].state, 'refused');
  assert.match(v.units[0].refused, /not an array/);
});

// ── the anchor must not refuse a unit that is simply GONE ───────────────────
// isInside is realpath-based on both sides and falls back to path.resolve for a
// path it cannot resolve, so an anchor reached through a symlink (macOS /var,
// a checkout or a $HOME that is a link) plus a directory that is not there made
// the two sides disagree — and "already gone" came back as a refusal --force
// could not clear, with a reason that read like an escape attempt. These roots
// are deliberately NOT realpath'd: they are symlinks, which is the state the
// suite's own tmpDir was hiding.

function symlinkedRoot(prefix) {
  const real = tmpDir(prefix);
  const link = path.join(tmpDir(`${prefix}link-`), 'proj');
  fs.symlinkSync(real, link);
  return link;
}

test('a unit whose directory the user deleted by hand is `missing`, not refused, under a symlinked root', async (t) => {
  withTempHome(t);
  const root = symlinkedRoot('wc-symroot-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  assert.notEqual(root, fs.realpathSync(root), 'the root must be reached through a symlink for this to test anything');

  // The record is well formed; the directory it names is simply not there.
  plantRecord(root, [{
    kind: 'component',
    name: 'deploy-board',
    files: [{ path: 'component.html', sha256: 'x'.repeat(64) }],
  }]);
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);

  const v = verifyPack(listPacks(root)[0], { root, tier: 'local' });
  assert.equal(v.units[0].state, 'missing', 'a directory that is gone is gone — not an escape');
  assert.equal(v.units[0].refused, undefined);

  const res = await packs.removePackByName({ name: 'acme-ops', root });
  assert.equal(res.results[0].action, 'already gone');
  assert.equal(res.removedAll, true, 'nothing was kept, so the record can go');
  assert.equal(listPacks(root).length, 0, 'the record for a hand-deleted unit is droppable');
});

test('the same holds on the system tier when $HOME is a symlink', async (t) => {
  const home = symlinkedRoot('wc-symhome-');
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  });
  assert.notEqual(home, fs.realpathSync(home));

  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  plantRecord(root, [{
    kind: 'skill',
    name: 'acme-ops',
    files: [{ path: 'SKILL.md', sha256: 'x'.repeat(64) }],
  }], { tier: 'system' });

  const v = verifyPack(listPacks(root)[0], { root, tier: 'system' });
  assert.equal(v.units[0].state, 'missing');

  const res = await packs.removePackByName({ name: 'acme-ops', root, tier: 'system' });
  assert.equal(res.results[0].action, 'already gone');
  assert.equal(res.removedAll, true);
  assert.equal(listPacks(root).length, 0);
});

test('a committed symlink is still refused when the anchor is itself symlinked', async (t) => {
  withTempHome(t);
  const root = symlinkedRoot('wc-symroot2-');
  const outside = tmpDir('wc-victim-');
  const victim = path.join(outside, 'component.html');
  fs.writeFileSync(victim, '<p>somebody else\'s file</p>');
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(victim)).digest('hex');

  fs.mkdirSync(projectPaths(root).components, { recursive: true });
  fs.symlinkSync(outside, path.join(projectPaths(root).components, 'deploy-board'));
  plantRecord(root, [{
    kind: 'component',
    name: 'deploy-board',
    files: [{ path: 'component.html', sha256: sha }],
  }]);

  const v = verifyPack(listPacks(root)[0], { root, tier: 'local' });
  assert.equal(v.units[0].state, 'refused', 'the escape is caught at the ancestor that does exist');
  assert.match(v.units[0].refused, /resolves outside/);
  const res = await packs.removePackByName({ name: 'acme-ops', root, force: true });
  assert.equal(res.results[0].action, 'refused');
  assert.equal(fs.existsSync(victim), true);
});

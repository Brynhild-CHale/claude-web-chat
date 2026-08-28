// Installing a pack is ONE reversible operation.
//
// Before this existed, `applyPlan` copied unit by unit with no try/catch and no
// undo list, and `installFromStage` wrote the provenance record and the audit
// line strictly AFTER the bytes. An EACCES on the third file left the first two
// units installed with no record and no audit line, and the orphans were then
// classified by the next plan as "you already have a component that no pack
// installed" — a state the HTTP route can never clear.
//
// The other half is the same primitive missing its inverse: re-installing a pack
// IS the advertised update, but nothing diffed the previous record against the
// new plan, so a v2 that dropped `service.js` left v1's file on disk, where
// `has_service` is read from disk presence and service trust is keyed to the
// file's unchanged bytes — the old, already-trusted service kept running under
// the new pack's record.
//
// Everything below asserts one of three things: nothing lands on a failure, an
// overwrite is RESTORED rather than unlinked, and an update deletes exactly what
// the new version dropped and nothing else.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const packs = require('../lib/packs/install');
const { droppedUnits, beginJournal } = require('../lib/packs/tree');
const { listPacks, ownerOf, putPending, readPending, clearPending } = require('../lib/packs/store');
const { componentsRegistry, serviceInfo } = require('../lib/server/components-registry');
const { resolvePaths } = require('../lib/server/paths');
const { projectPaths, claudePaths } = require('../lib/core/paths');
const { packFixture, tmpDir, write, fakeForge, repoWithArchive } = require('../test-support/packs');
const { withTempHome } = require('../test-support/helpers');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'c'.repeat(40);
const SERVICE = "module.exports = { async start(ctx) { ctx.driver.setStore({ deploys: [] }); }, async stop() {} };\n";

function project(t) {
  withTempHome(t);
  const root = tmpDir('wc-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

// `has_service` is computed from DISK PRESENCE by the same registry the drawer
// and the supervisor read — which is exactly why a leftover v1 service.js kept
// the component looking service-backed.
function hasService(root, name) {
  const found = componentsRegistry(resolvePaths(root)).list().find((c) => c.name === name);
  return found && found.has_service;
}

async function forgeFor(t, dir, sha = SHA1) {
  return fakeForge(t, { repos: { 'acme/ops': repoWithArchive(dir, { sha }) } });
}

// A content fingerprint of everything the install can WRITE, which is everything
// under the project root except `.web-chat/packs/` — the staging tmp dir, the
// journal's snapshots, the pending marker and the append-only audit log all live
// there and are expected to change even on a failure.
function snapshotTree(root) {
  const out = {};
  const skip = path.join(root, '.web-chat', 'packs');
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (abs === skip) continue;
      if (e.isDirectory()) { out[`${path.relative(root, abs)}/`] = 'dir'; walk(abs); } else {
        out[path.relative(root, abs)] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      }
    }
  })(root);
  return out;
}

// Inject a throwing fs op on the Nth file the apply copies INTO the project.
// Copies into `.web-chat/packs/` (the journal's own snapshots, the staging tmp
// tree) are not counted and never throw — this has to fail the apply, not the
// machinery that makes the apply reversible. It disarms itself after firing so
// the rollback's restores get through.
function throwOnCopy(t, nth) {
  const real = fs.copyFileSync;
  const skip = path.join('.web-chat', 'packs');
  let seen = 0;
  let armed = true;
  fs.copyFileSync = function patched(src, dest, ...rest) {
    const d = String(dest);
    if (armed && d.includes(path.sep) && !d.includes(skip) && ++seen === nth) {
      armed = false;
      const e = new Error(`EACCES: permission denied, copyfile '${d}'`);
      e.code = 'EACCES';
      throw e;
    }
    return real.call(fs, src, dest, ...rest);
  };
  t.after(() => { fs.copyFileSync = real; });
  return () => seen;
}

// The DOUBLE FAULT: the apply fails and the unwind fails too, for the same
// reason — which is the ordinary shape of ENOSPC and of a directory that lost
// its permissions, not a corner case. Every copy into the project throws from
// the Nth onward, the journal's own restores included (they copy OUT of
// `.web-chat/packs/backup` and INTO the project). The snapshots keep working:
// they are taken before the failure.
function throwOnCopyAndRestore(t, nth) {
  const real = fs.copyFileSync;
  const packsDir = path.join('.web-chat', 'packs');
  let seen = 0;
  let firing = false;
  fs.copyFileSync = function patched(src, dest, ...rest) {
    const intoProject = !String(dest).includes(packsDir);
    if (intoProject && !firing && ++seen === nth) firing = true;
    if (intoProject && firing) {
      const e = new Error(`ENOSPC: no space left on device, copyfile '${dest}'`);
      e.code = 'ENOSPC';
      throw e;
    }
    return real.call(fs, src, dest, ...rest);
  };
  t.after(() => { fs.copyFileSync = real; });
}

// ── the pure diff ───────────────────────────────────────────────────────────

test('droppedUnits diffs the previous record against the plan, per unit AND per file', () => {
  const previous = [
    { kind: 'component', name: 'deploy-board', files: [{ path: 'component.html', sha256: '1' }, { path: 'service.js', sha256: '2' }] },
    { kind: 'component', name: 'incident-timeline', files: [{ path: 'component.html', sha256: '3' }] },
    { kind: 'skill', name: 'acme-ops', files: [{ path: 'SKILL.md', sha256: '4' }] },
  ];
  const plan = [
    { kind: 'component', name: 'deploy-board', files: [{ path: 'component.html', sha256: '9' }] },
    { kind: 'skill', name: 'acme-ops', files: [{ path: 'SKILL.md', sha256: '9' }] },
  ];

  const dropped = droppedUnits(previous, plan);
  assert.deepEqual(dropped, [
    // A unit that SURVIVES yields a synthetic record carrying only its dropped
    // files, so the edited-file rule applies file-precisely and the directory
    // survives (readdir is non-empty).
    { kind: 'component', name: 'deploy-board', files: [{ path: 'service.js', sha256: '2' }] },
    { kind: 'component', name: 'incident-timeline', files: [{ path: 'component.html', sha256: '3' }] },
  ]);

  // Pure: same record in, nothing mutated.
  assert.equal(previous[0].files.length, 2);
  assert.deepEqual(droppedUnits(previous, previous), []);
  assert.deepEqual(droppedUnits(null, plan), []);
  assert.deepEqual(droppedUnits(previous, null).map((u) => u.name), ['deploy-board', 'incident-timeline', 'acme-ops']);
});

// ── rollback ────────────────────────────────────────────────────────────────

test('a throw mid-apply leaves the tree byte-identical and writes no record', async (t) => {
  const root = project(t);
  // A theme lands in the SHARED themes directory; put something else there first
  // so the rollback has a directory it must NOT remove.
  write(path.join(projectPaths(root).themesDir, 'mine.json'), '{"tokens":{}}\n');
  const dir = packFixture({
    components: [{ name: 'deploy-board', service: SERVICE }, { name: 'incident-timeline' }],
    themes: [{ name: 'acme-dark' }],
  });
  const forge = await forgeFor(t, dir);

  const before = snapshotTree(root);
  throwOnCopy(t, 4); // partway through — after the first unit has landed
  await assert.rejects(packs.installPack({ url: forge.url('acme', 'ops'), root }), /EACCES/);

  assert.deepEqual(snapshotTree(root), before, 'nothing the apply touched survived the rollback');
  assert.deepEqual(listPacks(root), [], 'and no provenance record was written');
  assert.equal(ownerOf(root, 'local', 'component', 'deploy-board'), null);
  assert.ok(fs.existsSync(path.join(projectPaths(root).themesDir, 'mine.json')), 'the shared themes dir is not rmdir\'d');

  // The marker is cleared by the rollback: the transaction finished (by
  // unwinding), so there is no interrupted install to report.
  assert.deepEqual(packs.listInstalled({ root }).pending, []);
  const failed = require('../lib/packs/store').readAudit(root).find((e) => e.ok === false);
  assert.ok(failed && failed.rolled_back, 'the failed attempt is in the audit log');
});

test('a failed same-pack update RESTORES the previous bytes rather than unlinking them', async (t) => {
  const root = project(t);
  const v1 = packFixture({
    version: '1.0.0',
    components: [{ name: 'deploy-board', html: '<div>v1</div>', service: SERVICE }, { name: 'incident-timeline', html: '<div>v1</div>' }],
  });
  await packs.installPack({ url: (await forgeFor(t, v1)).url('acme', 'ops'), root });
  const installed = snapshotTree(root);

  const v2 = packFixture({
    version: '2.0.0',
    components: [{ name: 'deploy-board', html: '<div>v2</div>' }, { name: 'incident-timeline', html: '<div>v2</div>' }],
  });
  const forge2 = await forgeFor(t, v2, SHA2);
  throwOnCopy(t, 3);
  await assert.rejects(packs.installPack({ url: forge2.url('acme', 'ops'), root }), /EACCES/);

  assert.deepEqual(snapshotTree(root), installed, 'v1 is back, byte for byte — an overwrite is restored, not deleted');
  assert.match(fs.readFileSync(path.join(projectPaths(root).components, 'deploy-board', 'component.html'), 'utf8'), /v1/);
  assert.equal(listPacks(root)[0].version, '1.0.0', 'and the v1 record still stands');
});

test('a rollback that cannot finish keeps every piece of evidence, and says so', async (t) => {
  const root = project(t);
  const v1 = packFixture({ version: '1.0.0', components: [{ name: 'deploy-board', html: '<div>v1</div>' }] });
  await packs.installPack({ url: (await forgeFor(t, v1)).url('acme', 'ops'), root });

  const v2 = packFixture({ version: '2.0.0', components: [{ name: 'deploy-board', html: '<div>v2</div>' }] });
  const forge2 = await forgeFor(t, v2, SHA2);
  throwOnCopyAndRestore(t, 2);   // the second file in, and every restore after it

  const err = await packs.installPack({ url: forge2.url('acme', 'ops'), root }).then(() => null, (e) => e);
  assert.ok(err, 'the install failed');
  assert.match(err.message, /ENOSPC/);
  // `die()` in the CLI and `fail()` in the route print `e.message` and nothing
  // else, and appendAudit is allowed by design to swallow its own write — so a
  // half-applied tree that is only in the audit log is a half-applied tree
  // nobody is told about.
  assert.match(err.message, /rollback could not finish/);
  assert.ok((err.rollbackErrors || []).length, 'and the failures ride the error');

  // The audit does not claim a rollback that did not happen.
  const failed = require('../lib/packs/store').readAudit(root).findLast((e) => e.ok === false);
  assert.equal(failed.rolled_back, false, 'the tree is torn — saying otherwise is worse than saying nothing');
  assert.ok(failed.rollback_errors.length);

  // The marker SURVIVES (a cleared one would mean "nothing to see here"), says
  // what could not be undone, and names where the previous bytes went.
  const { pending, packs: installed } = packs.listInstalled({ root });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'rollback-failed');
  assert.equal(pending[0].name, 'acme-ops');
  assert.ok(pending[0].rollback_errors.length);
  assert.ok(pending[0].backup_dir, 'and it names the snapshot directory');
  assert.deepEqual(installed.map((p) => p.version), ['1.0.0'], 'the v2 record was never written');

  // And those bytes are still on disk. The failed rollback deleting its own
  // snapshots would destroy the only remaining copy of what it clobbered.
  const snaps = fs.readdirSync(pending[0].backup_dir);
  assert.ok(snaps.length, 'the snapshots survive a rollback that failed');
  assert.ok(
    snaps.some((f) => fs.readFileSync(path.join(pending[0].backup_dir, f), 'utf8').includes('v1')),
    'including the v1 bytes the apply had already clobbered',
  );
});

test('an install whose record cannot be written leaves no files behind', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  const forge = await forgeFor(t, dir);

  const before = snapshotTree(root);
  const realRename = fs.renameSync;
  fs.renameSync = function patched(from, to, ...rest) {
    if (String(to).endsWith('packs.json')) {
      const e = new Error('EROFS: read-only file system, rename');
      e.code = 'EROFS';
      throw e;
    }
    return realRename.call(fs, from, to, ...rest);
  };
  t.after(() => { fs.renameSync = realRename; });

  await assert.rejects(packs.installPack({ url: forge.url('acme', 'ops'), root }), /EROFS/);
  assert.deepEqual(snapshotTree(root), before, 'the record failed, so the files came back out too');
  assert.equal(fs.existsSync(path.join(projectPaths(root).components, 'deploy-board')), false);
});

test('the journal rmdirs only directories it created, and only while they are empty', (t) => {
  withTempHome(t);
  const base = tmpDir('wc-journal-');
  const shared = path.join(base, 'shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'theirs.txt'), 'theirs\n');

  const j = beginJournal({ backupDir: path.join(base, 'backup') });
  j.mkdir(path.join(shared, 'deep', 'deeper'));
  j.created(path.join(shared, 'deep', 'deeper', 'new.txt'));
  fs.writeFileSync(path.join(shared, 'deep', 'deeper', 'new.txt'), 'new\n');
  j.overwriting(path.join(shared, 'theirs.txt'));
  fs.writeFileSync(path.join(shared, 'theirs.txt'), 'clobbered\n');

  assert.deepEqual(j.rollback(), []);
  assert.equal(fs.readFileSync(path.join(shared, 'theirs.txt'), 'utf8'), 'theirs\n');
  assert.equal(fs.existsSync(path.join(shared, 'deep')), false, 'the directories it created are gone');
  assert.ok(fs.existsSync(shared), 'the directory it did NOT create survives');
  assert.equal(fs.existsSync(path.join(base, 'backup')) && fs.readdirSync(path.join(base, 'backup')).length, 0, 'snapshots are dropped');

  // Idempotent: applyPlan unwinds on its own throw and the caller unwinds the
  // whole transaction, so a second rollback must not double-restore.
  assert.deepEqual(j.rollback(), []);
  assert.equal(fs.readFileSync(path.join(shared, 'theirs.txt'), 'utf8'), 'theirs\n');
});

test('a failed restore is remembered — every later rollback still reports it', (t) => {
  withTempHome(t);
  const base = tmpDir('wc-journal-');
  const unit = path.join(base, 'unit');
  fs.mkdirSync(unit, { recursive: true });
  const file = path.join(unit, 'component.html');
  fs.writeFileSync(file, 'v1\n');

  const j = beginJournal({ backupDir: path.join(base, 'backup') });
  j.overwriting(file);
  fs.writeFileSync(file, 'v2\n');

  const real = fs.copyFileSync;
  fs.copyFileSync = function patched(src, dest, ...rest) {
    if (String(dest) === file) {
      const e = new Error('ENOSPC: no space left on device');
      e.code = 'ENOSPC';
      throw e;
    }
    return real.call(fs, src, dest, ...rest);
  };
  t.after(() => { fs.copyFileSync = real; });

  const first = j.rollback();
  assert.equal(first.length, 1, 'the restore failed');
  // applyPlan unwinds on its own throw and installFromStage unwinds the whole
  // transaction, so the journal is rolled back TWICE. Clearing the failures with
  // the entries would tell the second caller — the one that writes the audit
  // line and the marker — that the tree came back clean.
  assert.deepEqual(j.rollback(), first, 'the second caller is told the same thing');
  assert.ok(j.backupDir && fs.readdirSync(j.backupDir).length,
    'and the snapshots stay, because they are now the only copy of the old bytes');
});

// ── the same-pack update ────────────────────────────────────────────────────

test('a v2 that drops service.js and a component removes exactly those, and nothing else', async (t) => {
  const root = project(t);
  const v1 = packFixture({
    version: '1.0.0',
    components: [{ name: 'deploy-board', html: '<div>v1</div>', service: SERVICE }, { name: 'incident-timeline' }],
  });
  await packs.installPack({ url: (await forgeFor(t, v1)).url('acme', 'ops'), root });

  const comps = projectPaths(root).components;
  assert.ok(fs.existsSync(path.join(comps, 'deploy-board', 'service.js')));
  assert.equal(hasService(root, 'deploy-board'), true);

  // v2: deploy-board loses its service, incident-timeline is gone entirely.
  const v2 = packFixture({ version: '2.0.0', components: [{ name: 'deploy-board', html: '<div>v2</div>' }] });
  const out = await packs.installPack({ url: (await forgeFor(t, v2, SHA2)).url('acme', 'ops'), root });

  assert.equal(fs.existsSync(path.join(comps, 'deploy-board', 'service.js')), false, 'the dropped file is gone');
  assert.equal(hasService(root, 'deploy-board'), false,
    'so the already-trusted v1 service cannot keep running under the v2 record');
  assert.equal(serviceInfo(resolvePaths(root), 'deploy-board').exists, false, 'and the supervisor agrees');
  assert.equal(fs.existsSync(path.join(comps, 'incident-timeline')), false, 'the dropped component is gone, directory and all');

  // And the surviving unit is intact at v2 — the prune took files, not the unit.
  assert.match(fs.readFileSync(path.join(comps, 'deploy-board', 'component.html'), 'utf8'), /v2/);
  assert.ok(fs.existsSync(path.join(comps, 'deploy-board', 'meta.json')));
  assert.ok(fs.existsSync(claudePaths(root).skill('acme-ops')), 'the skill it still ships stays');

  const rec = listPacks(root)[0];
  assert.equal(rec.version, '2.0.0');
  assert.deepEqual(rec.units.map((u) => `${u.kind}:${u.name}`).sort(), ['component:deploy-board', 'skill:acme-ops']);
  assert.deepEqual(rec.services, []);

  // The report names the deletions with their own action, so an update's
  // deletions cannot be read as a removal the user asked for.
  const pruned = out.results.filter((r) => r.action === 'pruned');
  assert.deepEqual(pruned.map((r) => r.name).sort(), ['deploy-board', 'incident-timeline']);
  assert.match(pruned.find((r) => r.name === 'deploy-board').dest, /service\.js/);
  const audit = require('../lib/packs/store').readAudit(root).at(-1);
  assert.deepEqual(audit.removed.sort(), ['component:deploy-board', 'component:incident-timeline']);
});

test('a dropped file the user edited is KEPT — an update obeys the same edited-file rule as remove', async (t) => {
  const root = project(t);
  const v1 = packFixture({ version: '1.0.0', components: [{ name: 'deploy-board', service: SERVICE }] });
  await packs.installPack({ url: (await forgeFor(t, v1)).url('acme', 'ops'), root });

  const svc = path.join(projectPaths(root).components, 'deploy-board', 'service.js');
  fs.appendFileSync(svc, '// mine\n');

  const v2 = packFixture({ version: '2.0.0', components: [{ name: 'deploy-board', html: '<div>v2</div>' }] });
  const out = await packs.installPack({ url: (await forgeFor(t, v2, SHA2)).url('acme', 'ops'), root });

  assert.match(fs.readFileSync(svc, 'utf8'), /mine/, 'work the user did is never deleted by an update');
  assert.ok(out.results.some((r) => r.action === 'kept-edited' && r.name === 'deploy-board'), 'and they are told');
});

test('a same-pack update touches only that pack — another pack\'s component is not pruned', async (t) => {
  const root = project(t);
  const other = packFixture({ name: 'other-pack', components: [{ name: 'incident-timeline' }] });
  await packs.installPack({ url: (await forgeFor(t, other, 'd'.repeat(40))).url('acme', 'ops'), root });

  const v1 = packFixture({ version: '1.0.0', components: [{ name: 'deploy-board', service: SERVICE }] });
  await packs.installPack({ url: (await forgeFor(t, v1, SHA1)).url('acme', 'ops'), root });
  const v2 = packFixture({ version: '2.0.0', components: [{ name: 'deploy-board' }] });
  await packs.installPack({ url: (await forgeFor(t, v2, SHA2)).url('acme', 'ops'), root });

  assert.ok(fs.existsSync(path.join(projectPaths(root).components, 'incident-timeline', 'component.html')),
    'the other pack is untouched by acme-ops updating');
  assert.equal(listPacks(root).length, 2);
});

// ── the pending marker ──────────────────────────────────────────────────────

test('a pending record is never seen as installed by anything that reads the record store', (t) => {
  const root = project(t);
  putPending(root, 'local', { name: 'acme-ops', status: 'applying', started_at: 'now', units: ['component:deploy-board'] });

  const { packs: installed, pending } = packs.listInstalled({ root, verify: true });
  assert.deepEqual(installed, [], '`pack list` shows no pack');
  assert.deepEqual(listPacks(root), []);
  assert.equal(ownerOf(root, 'local', 'component', 'deploy-board'), null,
    'so the planner does not classify the retry as a collision with an owner');

  // It IS discoverable — that is the whole point of writing it before the files.
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, 'acme-ops');
  assert.equal(pending[0].tier, 'local');
  assert.equal(readPending(root).length, 1);

  // And it lives in its own file, not in the record store.
  assert.ok(fs.existsSync(projectPaths(root).packsPending));
  assert.equal(fs.existsSync(projectPaths(root).packs), false);

  assert.equal(clearPending(root, 'local', 'acme-ops'), true);
  assert.deepEqual(readPending(root), []);
});

test('a completed install leaves no pending marker behind', async (t) => {
  const root = project(t);
  const dir = packFixture({ components: [{ name: 'deploy-board' }] });
  await packs.installPack({ url: (await forgeFor(t, dir)).url('acme', 'ops'), root });
  assert.deepEqual(packs.listInstalled({ root }).pending, []);
  assert.equal(fs.existsSync(projectPaths(root).packsPending), false);
});

// ── the guardrail ───────────────────────────────────────────────────────────
// The defect this unit fixes was not a wrong line, it was a MISSING wrapper: a
// destructive multi-file apply with no undo list. A second caller applying a
// plan without a journal reintroduces it exactly, and would pass every
// behavioural test above (they all go through installFromStage). So the call
// sites are asserted directly.

test('every applyPlan call site passes a journal — a second un-journalled apply fails the build', () => {
  const libDir = path.join(__dirname, '..', 'lib');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs); else if (e.name.endsWith('.js')) files.push(abs);
    }
  })(libDir);

  // The whole call EXPRESSION, not the line it starts on: a call wrapped across
  // two lines would otherwise read as un-journalled, and reformatting is not a
  // defect. Scans forward from `applyPlan(` to the matching close paren.
  function callAt(text, at) {
    let depth = 0;
    for (let i = at; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) return text.slice(at, i + 1).replace(/\s+/g, ' ');
    }
    return text.slice(at).replace(/\s+/g, ' ');
  }

  const sites = [];
  for (const f of files) {
    const rel = path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('applyPlan(')) continue;
      // The definition and the import are not call sites.
      if (/function applyPlan\(/.test(line) || /^\s*(applyPlan,|\s*applyPlan,)/.test(line)) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      sites.push({ rel, call: callAt(text, text.indexOf(line) + line.indexOf('applyPlan(')) });
    }
  }

  assert.ok(sites.length >= 1, 'applyPlan has no call sites at all — this guardrail has gone stale');
  for (const s of sites) {
    assert.ok(
      // `dryRun` is the pure half of the same function — it writes nothing, so it
      // needs nothing to undo.
      /\bjournal\b/.test(s.call) || /\bdryRun\b/.test(s.call),
      `${s.rel} calls applyPlan without a journal:\n    ${s.call}\n` +
      'An un-journalled apply is the packs-5 defect verbatim — a partial copy with no undo list. ' +
      'Pass the transaction\'s journal (see installFromStage in lib/packs/install.js), or dryRun for a pure diff.',
    );
  }
});

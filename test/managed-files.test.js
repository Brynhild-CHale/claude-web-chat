const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const mf = require('../lib/update/managed-files');
const {
  reconcileManagedFiles,
  hashContent,
  readBaselines,
  MANAGED_FILES,
  templatesDir,
} = mf;

// The reconcile reads templates from the real templates/ dir. We point the
// first managed file's dest at a tmp root and exercise the decision table by
// staging local content + baselines relative to the real template content.
const RULES = MANAGED_FILES.find(f => f.dest.endsWith('rules/web-chat.md'));
const RULES_TPL = path.join(templatesDir(), RULES.tpl);
const RULES_DEST = RULES.dest;

function tmpRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mf-')));
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  return root;
}

function shippedContent() {
  return fs.readFileSync(RULES_TPL, 'utf8');
}

function writeDest(root, content) {
  const p = path.join(root, RULES_DEST);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function readDest(root) {
  return fs.readFileSync(path.join(root, RULES_DEST), 'utf8');
}

function sidecarPath(root) {
  return path.join(root, RULES_DEST + '.new');
}

function setBaseline(root, dest, hash) {
  const f = path.join(root, '.web-chat', 'managed.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  data[dest] = hash;
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
}

function resultFor(results, dest) {
  return results.find(r => r.dest === dest);
}

test('created: missing file is written and baseline recorded', () => {
  const root = tmpRoot();
  const results = reconcileManagedFiles(root, {});
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'created');
  assert.equal(readDest(root), shippedContent());
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()));
});

test('up-to-date: local equals shipped, baseline recorded if absent', () => {
  const root = tmpRoot();
  writeDest(root, shippedContent());
  const results = reconcileManagedFiles(root, {});
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'up-to-date');
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()));
});

test('updated: local matches baseline, template changed → auto-apply', () => {
  const root = tmpRoot();
  // Simulate an OLD shipped version that the user never edited.
  const oldVersion = shippedContent() + '\n<!-- old shipped tail -->\n';
  writeDest(root, oldVersion);
  setBaseline(root, RULES_DEST, hashContent(oldVersion));
  const results = reconcileManagedFiles(root, {});
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'updated');
  assert.equal(readDest(root), shippedContent());
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()));
});

test('conflict: local & template both diverged → .new sidecar, original kept, offer recorded', () => {
  const root = tmpRoot();
  const baseVersion = shippedContent() + '\n<!-- baseline tail -->\n';
  const localEdit = shippedContent() + '\n<!-- MY local edit -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));

  const results = reconcileManagedFiles(root, {});
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'conflict');
  assert.equal(r.sidecar, RULES_DEST + '.new');
  // Original untouched
  assert.equal(readDest(root), localEdit);
  // Sidecar holds the shipped version
  assert.equal(fs.readFileSync(sidecarPath(root), 'utf8'), shippedContent());
  // The baseline ADVANCES to the bytes just offered. It used to be pinned as
  // "unchanged", which is precisely the bug: leaving it behind meant the same
  // offer was re-announced on every install and update for the rest of time.
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()));
});

test('kept-edited: local edited, template unchanged → respect edit, no write', () => {
  const root = tmpRoot();
  const localEdit = shippedContent() + '\n<!-- edit, template unchanged -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(shippedContent()));
  const results = reconcileManagedFiles(root, {});
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'kept-edited');
  assert.equal(readDest(root), localEdit);
  assert.ok(!fs.existsSync(sidecarPath(root)));
});

test('differs: no baseline, local != shipped → left untouched and flagged', () => {
  const root = tmpRoot();
  const local = shippedContent() + '\n<!-- pre-existing diff, no baseline -->\n';
  writeDest(root, local);
  const results = reconcileManagedFiles(root, {});
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'differs');
  assert.equal(readDest(root), local);
  // No baseline written (bootstrap leaves it alone)
  assert.ok(!Object.prototype.hasOwnProperty.call(readBaselines(root), RULES_DEST));
});

test('force: overwrites local edits and advances baseline', () => {
  const root = tmpRoot();
  const localEdit = shippedContent() + '\n<!-- will be clobbered -->\n';
  writeDest(root, localEdit);
  const results = reconcileManagedFiles(root, { force: true });
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'overwritten');
  assert.equal(readDest(root), shippedContent());
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()));
});

test('.new sidecar is cleaned up once the conflict resolves', () => {
  const root = tmpRoot();
  // Create a conflict first.
  const baseVersion = shippedContent() + '\n<!-- baseline -->\n';
  const localEdit = shippedContent() + '\n<!-- local -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));
  reconcileManagedFiles(root, {});
  assert.ok(fs.existsSync(sidecarPath(root)), 'sidecar created');

  // Resolve by adopting shipped content; re-run.
  writeDest(root, shippedContent());
  const results = reconcileManagedFiles(root, {});
  assert.equal(resultFor(results, RULES_DEST).action, 'up-to-date');
  assert.ok(!fs.existsSync(sidecarPath(root)), 'stale sidecar removed');
});

test('differs does not discard an existing conflict sidecar (baseline lost mid-conflict)', () => {
  const root = tmpRoot();
  // Stage a real conflict to produce a sidecar.
  const baseVersion = shippedContent() + '\n<!-- baseline -->\n';
  const localEdit = shippedContent() + '\n<!-- local -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));
  reconcileManagedFiles(root, {});
  assert.ok(fs.existsSync(sidecarPath(root)), 'sidecar created');

  // Baseline file is lost while the file still diverges from shipped.
  fs.unlinkSync(path.join(root, '.web-chat', 'managed.json'));
  const results = reconcileManagedFiles(root, {});
  assert.equal(resultFor(results, RULES_DEST).action, 'differs');
  // Sidecar (the shipped reference) must survive — not silently deleted.
  assert.ok(fs.existsSync(sidecarPath(root)), 'sidecar preserved through differs');
});

// ── distribution-4: the conflict→resolution transition ──────────────────────
//
// The reconcile used to have no way OUT of `conflict`. `setBaseline` stayed
// null on that branch, so after the user hand-merged, `local` matched neither
// `baseline` nor `shipped` and the SAME branch fired on every `install` and
// every `update`, forever: the sidecar rewritten, nothing recorded, no
// convergence. The only exits were `--force` (adopt the shipped bytes, discard
// the merge) or living with the reminder — and the shipped advice said
// "review and merge, then re-run", which could not work.
//
// The fix is RECORD-ON-OFFER: `.web-chat/managed.json` keeps its shape, but its
// value's meaning widens from "the shipped bytes we last WROTE" to "the shipped
// bytes this file was last reconciled against — applied OR offered". The
// reminder is derived from the filesystem (`<dest>.new` present while the file
// still differs from shipped), not from new persisted state.

test('a hand-merged conflict converges to kept-edited instead of re-firing forever', () => {
  const root = tmpRoot();
  const baseVersion = shippedContent() + '\n<!-- baseline -->\n';
  const localEdit = shippedContent() + '\n<!-- MY local edit -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));

  // Run 1 — the offer. Announced, sidecar written, and the baseline advances to
  // the bytes we just offered. That last part is the whole fix.
  let r = resultFor(reconcileManagedFiles(root, {}), RULES_DEST);
  assert.equal(r.action, 'conflict');
  assert.ok(fs.existsSync(sidecarPath(root)), 'the offer writes the sidecar');
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()),
    'the offered shipped hash is recorded — without this the machine never converges');

  // The user merges by hand: bytes matching NEITHER side.
  const merged = shippedContent() + '\n<!-- merged by hand -->\n';
  writeDest(root, merged);

  // Runs 2 and 3 — settled. The same offer is never announced twice.
  for (const run of [2, 3]) {
    r = resultFor(reconcileManagedFiles(root, {}), RULES_DEST);
    assert.equal(r.action, 'kept-edited', `run ${run} must not re-flag the same offer`);
    assert.equal(readDest(root), merged, `run ${run} leaves the merge alone`);
  }
});

test('the first offer is never swallowed: a fresh conflict still announces', () => {
  // The trap in the obvious fix ("sidecar absent ⇒ resolved"): on the FIRST
  // conflict the sidecar does not exist either, so that rule would silently
  // adopt the shipped hash, call the file kept-edited, and never tell the user
  // an update was waiting.
  const root = tmpRoot();
  const baseVersion = shippedContent() + '\n<!-- baseline -->\n';
  const localEdit = shippedContent() + '\n<!-- MY local edit -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));
  assert.ok(!fs.existsSync(sidecarPath(root)), 'no sidecar yet — this is the first offer');

  const r = resultFor(reconcileManagedFiles(root, {}), RULES_DEST);
  assert.equal(r.action, 'conflict', 'the first offer is announced, not silently recorded');
  assert.equal(r.sidecar, RULES_DEST + '.new');
  assert.equal(fs.readFileSync(sidecarPath(root), 'utf8'), shippedContent());
  assert.equal(readDest(root), localEdit, 'and the file is untouched');
});

test('the .new sidecar is the reminder: it survives until the user deletes it', () => {
  const root = tmpRoot();
  const baseVersion = shippedContent() + '\n<!-- baseline -->\n';
  const localEdit = shippedContent() + '\n<!-- MY local edit -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));
  reconcileManagedFiles(root, {});

  const merged = shippedContent() + '\n<!-- merged by hand -->\n';
  writeDest(root, merged);

  // Settled, but not finished: the sidecar is still there and still says so.
  for (const run of [1, 2]) {
    const r = resultFor(reconcileManagedFiles(root, {}), RULES_DEST);
    assert.equal(r.action, 'kept-edited');
    assert.ok(r.pending, `run ${run} still reminds`);
    assert.equal(r.sidecar, RULES_DEST + '.new');
    assert.ok(fs.existsSync(sidecarPath(root)),
      'the sidecar is the merge material AND the reminder — cleanup must not eat it');
  }

  // Deleting it ends the reminder. Nothing rewrites it.
  fs.unlinkSync(sidecarPath(root));
  const r = resultFor(reconcileManagedFiles(root, {}), RULES_DEST);
  assert.equal(r.action, 'kept-edited');
  assert.ok(!r.pending, 'quiet once the user has dealt with it');
  assert.ok(!r.sidecar);
  assert.ok(!fs.existsSync(sidecarPath(root)));
});

test('a genuine upstream change re-announces after a resolution', () => {
  const root = tmpRoot();
  const merged = shippedContent() + '\n<!-- merged by hand -->\n';
  writeDest(root, merged);
  // Resolved state: the baseline is the shipped bytes last offered, the file is
  // the user's merge, no sidecar.
  setBaseline(root, RULES_DEST, hashContent(shippedContent()));
  assert.equal(resultFor(reconcileManagedFiles(root, {}), RULES_DEST).action, 'kept-edited');

  // Now the template moves. This test cannot rewrite templates/, so it stages
  // the identical on-disk state: the recorded baseline is the PREVIOUS shipped
  // bytes and the real template is the new ones.
  const previousShipped = shippedContent() + '\n<!-- the version we offered last time -->\n';
  setBaseline(root, RULES_DEST, hashContent(previousShipped));

  const r = resultFor(reconcileManagedFiles(root, {}), RULES_DEST);
  assert.equal(r.action, 'conflict', 'a NEW offer is announced — only the same one goes quiet');
  assert.equal(fs.readFileSync(sidecarPath(root), 'utf8'), shippedContent(), 'a fresh sidecar');
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()));
  assert.equal(readDest(root), merged, 'and the merge is still not clobbered');
});

test('--force adopts the shipped bytes and clears the sidecar', () => {
  const root = tmpRoot();
  const baseVersion = shippedContent() + '\n<!-- baseline -->\n';
  writeDest(root, shippedContent() + '\n<!-- MY local edit -->\n');
  setBaseline(root, RULES_DEST, hashContent(baseVersion));
  reconcileManagedFiles(root, {});
  assert.ok(fs.existsSync(sidecarPath(root)));

  const r = resultFor(reconcileManagedFiles(root, { force: true }), RULES_DEST);
  assert.equal(r.action, 'overwritten');
  assert.ok(!r.pending);
  assert.equal(readDest(root), shippedContent());
  assert.ok(!fs.existsSync(sidecarPath(root)), 'nothing left to merge, nothing left to remind about');
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(shippedContent()));
});

test('dryRun neither writes the sidecar nor advances the offered baseline', () => {
  const root = tmpRoot();
  const baseVersion = shippedContent() + '\n<!-- baseline -->\n';
  const localEdit = shippedContent() + '\n<!-- MY local edit -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));

  const r = resultFor(reconcileManagedFiles(root, { dryRun: true }), RULES_DEST);
  assert.equal(r.action, 'conflict');
  assert.ok(!fs.existsSync(sidecarPath(root)), 'looking is not offering');
  assert.equal(readBaselines(root)[RULES_DEST], hashContent(baseVersion),
    'and looking does not record an offer that was never made');
});

test('dryRun writes nothing', () => {
  const root = tmpRoot();
  const results = reconcileManagedFiles(root, { dryRun: true });
  assert.equal(resultFor(results, RULES_DEST).action, 'created');
  // No file, no baseline written
  assert.ok(!fs.existsSync(path.join(root, RULES_DEST)));
  assert.ok(!fs.existsSync(path.join(root, '.web-chat', 'managed.json')));
});

test('malformed managed.json is treated as no baselines (non-destructive)', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.web-chat', 'managed.json'), '{ this is not json');
  const local = shippedContent() + '\n<!-- diff -->\n';
  writeDest(root, local);
  const results = reconcileManagedFiles(root, {});
  // No baseline → bootstrap 'differs', file untouched.
  assert.equal(resultFor(results, RULES_DEST).action, 'differs');
  assert.equal(readDest(root), local);
});

test('install records baselines; second install is all up-to-date; dryRun clean', () => {
  const root = tmpRoot();
  // First install-style reconcile.
  let results = reconcileManagedFiles(root, {});
  for (const r of results) assert.equal(r.action, 'created');
  const baselines = readBaselines(root);
  for (const { dest } of MANAGED_FILES) {
    assert.ok(baselines[dest], `baseline recorded for ${dest}`);
  }
  // Second install: everything up to date.
  results = reconcileManagedFiles(root, {});
  for (const r of results) assert.equal(r.action, 'up-to-date');
  // dryRun on a clean install: still up-to-date, no surprise writes.
  const before = fs.readFileSync(path.join(root, '.web-chat', 'managed.json'), 'utf8');
  results = reconcileManagedFiles(root, { dryRun: true });
  for (const r of results) assert.equal(r.action, 'up-to-date');
  assert.equal(fs.readFileSync(path.join(root, '.web-chat', 'managed.json'), 'utf8'), before);
});

// ── the bin path a project's .mcp.json / settings.json is pointed at ────────
// A managed install must register ~/.web-chat/current/bin/<name>, never the
// version directory the process happens to be running from. pruneVersions
// deletes all but the newest KEEP_VERSIONS, so a pinned path becomes a dangling
// reference three updates later: the MCP server stops spawning and every hook
// exits non-zero — silently, in every project, with no lock and no graph nodes.

const { withTempHome } = require('../test-support/helpers');
const { installPaths, PACKAGE_ROOT } = require('../lib/core/paths');

test('stableBin points a DEV checkout at its own bin', (t) => {
  withTempHome(t);
  // This test tree is not under ~/.web-chat/versions, so it is unmanaged — and
  // an absolute path to its own bin is exactly right: nothing else resolves.
  const bin = mf.stableBin('claude-web-chat-hook');
  assert.equal(bin, path.join(PACKAGE_ROOT, 'bin', 'claude-web-chat-hook.js'));
  assert.ok(fs.existsSync(bin));
});

test('resolveHookCommand rewrites a BARE command to an absolute one', () => {
  const out = mf.resolveHookCommand('claude-web-chat-hook turn-begin');
  assert.match(out, /^node "\/.*claude-web-chat-hook\.js" turn-begin$/);
});

test('resolveHookCommand REPOINTS a stale absolute path, and is idempotent', () => {
  // The shape a pruned version directory leaves behind. Without this, ensureHooks
  // would skip the event (it already has a web-chat handler) and the stale entry
  // would stay stale forever — the B3 fix would only ever help new projects.
  const stale = 'node "/Users/someone/.web-chat/versions/0.6.0/bin/claude-web-chat-hook.js" turn-begin';
  const fixed = mf.resolveHookCommand(stale);
  assert.doesNotMatch(fixed, /versions\/0\.6\.0/, 'the pinned version directory is gone');
  assert.match(fixed, /claude-web-chat-hook\.js" turn-begin$/, 'and the subcommand survives');
  assert.equal(mf.resolveHookCommand(fixed), fixed, 'idempotent');
});

test('resolveHookCommand leaves a command that is not ours alone', () => {
  const other = 'node /opt/some-other-tool/hook.js run';
  assert.equal(mf.resolveHookCommand(other), other);
});

test('a MANAGED install registers current/, NOT the version directory it is running from', (t) => {
  const home = withTempHome(t);
  const paths = installPaths();
  // The layout an unpacked release actually has. The process cannot move itself
  // into it, so the decision is exercised against a fabricated packageRoot —
  // the same seam describeInstall({ packageRoot }) already offers.
  const vdir = path.join(paths.versions, '0.6.0');
  fs.mkdirSync(path.join(vdir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(vdir, 'bin', 'claude-web-chat-hook.js'), '');

  const bin = mf.stableBin('claude-web-chat-hook', { packageRoot: vdir, paths });
  assert.equal(bin, path.join(home, '.web-chat', 'current', 'bin', 'claude-web-chat-hook.js'));
  assert.doesNotMatch(bin, /versions\/0\.6\.0/,
    'pruneVersions deletes that directory three updates later; every hook would then exit non-zero, silently');

  // An unmanaged tree still gets its own absolute path — nothing else resolves.
  const checkout = path.join(home, 'Dev', 'web-chat-dev');
  fs.mkdirSync(checkout, { recursive: true });
  assert.equal(mf.stableBin('claude-web-chat-hook', { packageRoot: checkout, paths }),
    path.join(checkout, 'bin', 'claude-web-chat-hook.js'));
});

// distribution-4. `install`, `update`, `init` and `status` each printed their
// own version of what a conflict means, and the two that gave a next step gave
// one that could not converge. L6 gave the wording one home; this unit gave the
// state machine the transition, so the wording must now name the step that
// actually ends it — merge, then DELETE the .new — and must no longer claim the
// file gets re-flagged on the next install/update, which stopped being true.
test('the conflict wording has one home and names the step that resolves', () => {
  const rulesNew = new RegExp(RULES_DEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.new');
  const results = [{ action: 'conflict', dest: RULES_DEST, sidecar: RULES_DEST + '.new' }];
  const advice = mf.conflictAdvice(results).join('\n');
  assert.match(advice, /install --force/, 'the one adopt-the-shipped-bytes exit is still named');
  assert.match(advice, rulesNew);
  assert.match(advice, /delete/i, 'and the step that actually resolves it');
  assert.doesNotMatch(advice, /re-flags|matches neither side/,
    'the old text described a loop that no longer exists');
  assert.match(mf.conflictSummary(results), /install --force/);
  assert.deepEqual(mf.conflictAdvice([{ action: 'up-to-date', dest: RULES_DEST }]), []);
  assert.equal(mf.conflictSummary([]), '');

  // A pending sidecar is a reminder, not a fresh offer, and it has the same
  // single home: no consumer grows its own sentence for it.
  const reminder = [{ action: 'kept-edited', dest: RULES_DEST, sidecar: RULES_DEST + '.new', pending: true }];
  const pendingAdvice = mf.conflictAdvice(reminder).join('\n');
  assert.match(pendingAdvice, rulesNew);
  assert.match(pendingAdvice, /delete/i);
  assert.match(mf.conflictSummary(reminder), rulesNew);
  assert.deepEqual(mf.conflictAdvice([{ action: 'kept-edited', dest: RULES_DEST }]), []);

  for (const f of ['install.js', 'update.js', 'status.js', 'init.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli', 'commands', f), 'utf8');
    assert.doesNotMatch(src, /Review and merge|review and merge\./,
      `${f} must print the shared advice, not a fifth wording of it`);
  }
});

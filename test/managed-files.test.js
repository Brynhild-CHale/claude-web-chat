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

test('conflict: local & template both diverged → .new sidecar, original kept, baseline unchanged', () => {
  const root = tmpRoot();
  const baseVersion = shippedContent() + '\n<!-- baseline tail -->\n';
  const localEdit = shippedContent() + '\n<!-- MY local edit -->\n';
  writeDest(root, localEdit);
  setBaseline(root, RULES_DEST, hashContent(baseVersion));
  const baselineBefore = readBaselines(root)[RULES_DEST];

  const results = reconcileManagedFiles(root, {});
  const r = resultFor(results, RULES_DEST);
  assert.equal(r.action, 'conflict');
  assert.equal(r.sidecar, RULES_DEST + '.new');
  // Original untouched
  assert.equal(readDest(root), localEdit);
  // Sidecar holds the shipped version
  assert.equal(fs.readFileSync(sidecarPath(root), 'utf8'), shippedContent());
  // Baseline unchanged
  assert.equal(readBaselines(root)[RULES_DEST], baselineBefore);
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

// distribution-4, the half consolidation can actually reach. `install`,
// `update`, `init` and `status` each printed their own version of what a
// conflict means, and the two that gave a next step gave one that cannot
// converge: after a hand merge, local matches neither the baseline nor the
// shipped bytes, so the same branch fires again on every install and update.
// One helper, one wording, and it names the only step that actually resolves.
// (The missing conflict→resolution TRANSITION is still open — that is a change
// to the reconcile state machine above, not to this text.)
test('the conflict wording has one home and names the step that resolves', () => {
  const results = [{ action: 'conflict', dest: RULES_DEST, sidecar: RULES_DEST + '.new' }];
  const advice = mf.conflictAdvice(results).join('\n');
  assert.match(advice, /install --force/, 'the one exit is named');
  assert.match(advice, new RegExp(RULES_DEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.new'));
  assert.match(mf.conflictSummary(results), /install --force/);
  assert.deepEqual(mf.conflictAdvice([{ action: 'up-to-date', dest: RULES_DEST }]), []);
  assert.equal(mf.conflictSummary([]), '');

  for (const f of ['install.js', 'update.js', 'status.js', 'init.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli', 'commands', f), 'utf8');
    assert.doesNotMatch(src, /Review and merge|review and merge\./,
      `${f} must print the shared advice, not a fifth wording of it`);
  }
});

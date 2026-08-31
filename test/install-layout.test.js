// The install layout: ~/.web-chat/versions/<v>/ + a `current` symlink + three
// links in ~/.local/bin.
//
// What is load-bearing here — and therefore what is tested — is the question
// this module exists to answer: WHICH TREE is the command on your PATH actually
// running? A global npm prefix could not answer it, and a stale binary sat on a
// maintainer's PATH for 16 days because of it. So: classification (managed / dev
// checkout / unmanaged), the PATH-vs-running mismatch flag, the atomic swap that
// makes rollback safe, and the pruning/removal rules that must never delete
// something they do not own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  describeInstall, listVersions, activate, linkBins, pruneVersions, removeInstall, onPath,
} = require('../lib/update/install-layout');
const { installPaths } = require('../lib/core/paths');
const { withTempHome } = require('../test-support/helpers');

// Fabricate an unpacked release: versions/<v>/package.json + the three bins.
function fakeVersion(paths, version) {
  const dir = paths.versionDir(version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version }));
  for (const name of paths.BIN_NAMES) {
    fs.writeFileSync(path.join(dir, 'bin', `${name}.js`), '#!/usr/bin/env node\n');
  }
  return dir;
}

test('a tree under ~/.web-chat/versions is a managed install', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const dir = fakeVersion(paths, '0.5.0');
  const info = describeInstall({ packageRoot: dir, paths });
  assert.equal(info.kind, 'managed');
  assert.equal(info.version, '0.5.0');
  assert.equal(fs.realpathSync(info.versionDir), fs.realpathSync(dir));
});

test('a git working copy is a dev checkout, and never a managed install', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const checkout = path.join(paths.home, 'src', 'claude-web-chat');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '0.9.9-dev' }));

  // Classified from a SUBDIRECTORY too: .git is found by walking up, the way
  // git itself does, so `lib/cli/commands` inside a checkout still says "dev".
  const info = describeInstall({ packageRoot: checkout, paths });
  assert.equal(info.kind, 'dev');
  assert.equal(fs.realpathSync(info.gitRoot), fs.realpathSync(checkout));
});

test('anything else — a leftover npm global, a hand-copied dir — is unmanaged', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const npmish = path.join(paths.home, 'lib', 'node_modules', 'claude-web-chat');
  fs.mkdirSync(npmish, { recursive: true });
  fs.writeFileSync(path.join(npmish, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  assert.equal(describeInstall({ packageRoot: npmish, paths }).kind, 'unmanaged');
});

// The exact failure that motivated the whole layout: the command on PATH
// resolves somewhere other than the tree you think you are running.
test('a PATH link resolving elsewhere is reported as a mismatch', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const good = fakeVersion(paths, '0.5.0');
  const stale = fakeVersion(paths, '0.1.0');

  activate('0.1.0', paths);
  linkBins(paths);
  // Running from 0.5.0 while PATH's `claude-web-chat` resolves into 0.1.0.
  const info = describeInstall({ packageRoot: good, paths });
  assert.equal(info.linkMismatch, true, 'a PATH link pointing at another tree must be flagged');
  assert.equal(info.linkVersion, '0.1.0');
  assert.equal(info.version, '0.5.0');
  assert.equal(fs.realpathSync(info.linkPackageRoot), fs.realpathSync(stale));

  // ...and NOT flagged once they agree.
  activate('0.5.0', paths);
  assert.equal(describeInstall({ packageRoot: good, paths }).linkMismatch, false);
});

test('activate swaps `current` in place, over an existing symlink, relatively', (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');

  activate('0.5.0', paths);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.5.0', 'relative target keeps ~/.web-chat movable');
  activate('0.6.0', paths);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.6.0');
  assert.equal(describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }).currentVersion, '0.6.0');
});

test('activate refuses a version that is not unpacked', (t) => {
  withTempHome(t);
  const paths = installPaths();
  assert.throws(() => activate('9.9.9', paths), /not unpacked/);
});

test('linkBins links all three bins through `current`, not at a version', (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  const rows = linkBins(paths);
  assert.equal(rows.length, 3);
  for (const name of paths.BIN_NAMES) {
    const target = fs.readlinkSync(paths.binLink(name));
    assert.ok(target.includes(`${path.sep}current${path.sep}`), `${name} must point through current/, so rollback is one swap`);
    assert.ok(fs.existsSync(paths.binLink(name)), `${name} must resolve to a real file`);
  }
  // Idempotent: re-running reports "ok", not a relink.
  assert.deepEqual(linkBins(paths).map((r) => r.action), ['ok', 'ok', 'ok']);
});

test('pruneVersions keeps the newest few and never deletes what `current` points at', (t) => {
  withTempHome(t);
  const paths = installPaths();
  for (const v of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0']) fakeVersion(paths, v);
  activate('0.1.0', paths); // the OLDEST is in use

  const removed = pruneVersions({ keep: 2, paths });
  const left = listVersions(paths);
  assert.ok(left.includes('0.1.0'), 'the version in use survives pruning regardless of age');
  assert.deepEqual(left.slice(0, 2), ['0.5.0', '0.4.0'], 'newest-first, newest kept');
  assert.ok(removed.includes('0.3.0') && removed.includes('0.2.0'));
  assert.ok(!removed.includes('0.1.0'));
});

test('listVersions orders semantically, not lexically', (t) => {
  withTempHome(t);
  const paths = installPaths();
  for (const v of ['0.9.0', '0.10.0', '0.2.0']) fakeVersion(paths, v);
  assert.deepEqual(listVersions(paths), ['0.10.0', '0.9.0', '0.2.0']);
});

// distribution-3. A `wc-release-XXXXXX` staging dir used to be created INSIDE
// versions/ and, when an update was Ctrl-C'd mid-download, stayed there: it was
// listed as a version, `update --list` printed `vwc-release-…`, and
// compareVersions' lexical fallback sorted it ABOVE every real release, so the
// prune protected it and dropped a real one instead. Staging moved out of the
// version store; this is the second half — a stray directory can never be a
// version whatever put it there.
test('a directory that is not a version name is never listed, ranked or protected', (t) => {
  withTempHome(t);
  const paths = installPaths();
  for (const v of ['0.5.0', '0.6.0', '0.7.0']) fakeVersion(paths, v);
  // Exactly what an interrupted `update` left behind, plus a hand-made folder.
  fs.mkdirSync(path.join(paths.versions, 'wc-release-Ab12Cd'), { recursive: true });
  fs.mkdirSync(path.join(paths.versions, 'backup'), { recursive: true });

  const listed = listVersions(paths);
  assert.deepEqual(listed, ['0.7.0', '0.6.0', '0.5.0'], 'only real versions, newest first');

  // The consequence that made this more than cosmetic: with the stray ranked
  // first, keep:2 kept it plus 0.7.0 and deleted 0.6.0 — a rollback target gone.
  activate('0.7.0', paths);
  const removed = pruneVersions({ keep: 2, paths });
  assert.deepEqual(removed, ['0.5.0']);
  assert.ok(fs.existsSync(paths.versionDir('0.6.0')), 'the second-newest real version survives');
  assert.ok(fs.existsSync(path.join(paths.versions, 'wc-release-Ab12Cd')), 'a stray dir is left alone, not deleted from under someone');
});

test('a prerelease directory name is still a version', (t) => {
  withTempHome(t);
  const paths = installPaths();
  for (const v of ['0.7.0', '0.8.0-rc1']) fakeVersion(paths, v);
  assert.deepEqual(listVersions(paths), ['0.8.0-rc1', '0.7.0']);
});

test('removeInstall takes our bins and versions, and leaves foreign links alone', (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  // Someone else's `claude-web-chat-hook` — a dev checkout's link, say. Removing
  // a link we did not create would be taking something that is not ours.
  const foreign = path.join(paths.home, 'elsewhere', 'hook.js');
  fs.mkdirSync(path.dirname(foreign), { recursive: true });
  fs.writeFileSync(foreign, '// not ours\n');
  fs.unlinkSync(paths.binLink('claude-web-chat-hook'));
  fs.symlinkSync(foreign, paths.binLink('claude-web-chat-hook'));

  const { bins, versions } = removeInstall({ paths });
  assert.deepEqual(versions, ['0.5.0']);
  assert.ok(!fs.existsSync(paths.versions), 'the version store is removed');
  assert.ok(!fs.existsSync(paths.binLink('claude-web-chat')), 'our bin link is removed');
  assert.ok(fs.existsSync(paths.binLink('claude-web-chat-hook')), 'a link pointing outside ~/.web-chat is left alone');
  assert.match(bins.find((b) => b.name === 'claude-web-chat-hook').action, /left alone/);
  assert.ok(fs.existsSync(paths.root), 'per-user state (~/.web-chat itself) is preserved');
});

test('onPath compares directories, not substrings', () => {
  assert.equal(onPath('/a/bin', '/x:/a/bin:/y'), true);
  assert.equal(onPath('/a/bin', '/x:/a/binaries:/y'), false);
  assert.equal(onPath('/a/bin', ''), false);
});

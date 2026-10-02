// `claude-web-chat version` / `--version`, and `uninstall --self`.
//
// `version` is not decoration: it is the answer to "which copy am I running?",
// which nobody could answer when a stale global install sat on a maintainer's
// PATH for 16 days. It has to print the running tree, `current`, and the PATH
// link — and say so out loud when the last two disagree.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const versionCmd = require('../lib/cli/commands/version');
const uninstall = require('../lib/cli/commands/uninstall');
const { installPaths } = require('../lib/core/paths');
const { describeInstall, activate, linkBins } = require('../lib/update/install-layout');
const { withTempHome } = require('../test-support/helpers');

function fakeVersion(paths, version) {
  const dir = paths.versionDir(version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  for (const name of paths.BIN_NAMES) fs.writeFileSync(path.join(dir, 'bin', `${name}.js`), '#!/usr/bin/env node\n');
  return dir;
}

function sink() {
  const lines = [];
  const fn = (m = '') => lines.push(String(m));
  fn.text = () => lines.join('\n');
  return fn;
}

test('version prints the running tree, current, and the PATH link', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const dir = fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  const log = sink();
  versionCmd([], { log, paths, describeInstall: () => describeInstall({ packageRoot: dir, paths }) });
  const text = log.text();
  assert.match(text.split('\n')[0], /^claude-web-chat v0\.5\.0$/, 'the first line stays terse — scripts read it');
  assert.match(text, /managed install/);
  assert.ok(text.includes(dir), 'it must name the tree it is running from');
  assert.ok(text.includes(paths.current), 'and what current points at');
  assert.ok(text.includes(paths.binLink('claude-web-chat')), 'and what is on PATH');
});

test('version SHOUTS when the command on PATH is a different tree', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const running = fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.1.0');
  activate('0.1.0', paths); // PATH resolves into 0.1.0...
  linkBins(paths);

  const log = sink();
  versionCmd([], { log, paths, describeInstall: () => describeInstall({ packageRoot: running, paths }) });
  const text = log.text();
  assert.match(text, /MISMATCH/, 'the stale-binary case must be impossible to miss');
  assert.match(text, /v0\.1\.0/, 'it must name the version PATH actually gets');
});

test('version --short prints one line and nothing else', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const dir = fakeVersion(paths, '0.5.0');
  const log = sink();
  versionCmd(['--short'], { log, paths, describeInstall: () => describeInstall({ packageRoot: dir, paths }) });
  assert.deepEqual(log.text().split('\n'), ['claude-web-chat v0.5.0']);
});

test('--version is routed to the version command, not "unknown command"', () => {
  const { main } = require('../lib/cli');
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    main(['--version', '--short']);
  } finally {
    console.log = orig;
  }
  assert.match(lines.join('\n'), /^claude-web-chat v/);
});

test('uninstall --self removes the program; plain uninstall only touches the project', async (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-proj-')));
  fs.mkdirSync(path.join(project, '.web-chat'), { recursive: true });
  const logs = [];
  const origLog = console.log;
  console.log = (m = '') => logs.push(String(m));
  // The project is PASSED, and `claude` is stubbed: uninstall now also removes
  // the local-scope registration, and no test may shell out for real.
  const opts = { cwd: project, runClaude: () => ({ ok: true }) };
  try {
    await uninstall([], opts);
    assert.ok(fs.existsSync(paths.binLink('claude-web-chat')), 'a plain uninstall must not remove the program');
    assert.match(logs.join('\n'), /uninstall --self/, 'and it should say how to remove the program too');

    await uninstall(['--self'], opts);
  } finally {
    console.log = origLog;
  }
  assert.ok(!fs.existsSync(paths.binLink('claude-web-chat')), '--self removes the PATH links');
  assert.ok(!fs.existsSync(paths.versions), '--self removes every unpacked version');
  assert.ok(fs.existsSync(paths.root), 'per-user state under ~/.web-chat survives');
  assert.ok(fs.existsSync(path.join(project, '.web-chat')), 'the project graph is never deleted');
});

// ── H-11: the installed dev build is behind the checkout ────────────────────
// The maintainer's managed install ran a dev build cut 111 commits before the
// checkout they were testing in, and nothing said so — "is it broken?" was the
// first symptom. `version` and `status` now say it in one line, for exactly
// that person: inside a git checkout of this package, with a dev build
// installed whose commit is not the checkout's HEAD. Everyone else hears
// nothing, and the check only reads files.

const { devBuildBehind, gitHead } = require('../lib/update/install-layout');

const HEAD_SHA = 'def5678'.padEnd(40, '0');
const DEV = '0.9.0-dev.202610021200.abc1234';

// A git checkout as git leaves one on disk, without git: package.json, .git/HEAD
// and the ref it names (loose, packed, or HEAD detached).
function fakeCheckout(t, { name = 'claude-web-chat', head = HEAD_SHA, ref = 'loose' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-checkout-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.8.2' }));
  const git = path.join(dir, '.git');
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  if (ref === 'detached') {
    fs.writeFileSync(path.join(git, 'HEAD'), `${head}\n`);
  } else {
    fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
    if (ref === 'packed') fs.writeFileSync(path.join(git, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${'9'.repeat(40)} refs/heads/other\n${head} refs/heads/main\n`);
    else fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), `${head}\n`);
  }
  return dir;
}

function devInstalled(t, v = DEV) {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, v);
  activate(v, paths);
  linkBins(paths);
  return paths;
}

const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(`${p}:${e.isDirectory() ? 'd' : fs.statSync(p).mtimeMs}`); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
};

test('H-11: inside a checkout whose HEAD is not the installed dev build\'s commit, version says so in one line', (t) => {
  const paths = devInstalled(t);
  const checkout = fakeCheckout(t);
  const before = snapshot(checkout);
  const b = devBuildBehind({ cwd: path.join(checkout), paths });
  assert.deepEqual(b, { installed: DEV, commit: 'abc1234', head: HEAD_SHA, checkout });

  const log = sink();
  versionCmd([], { log, paths, cwd: checkout, describeInstall: () => describeInstall({ packageRoot: paths.versionDir(DEV), paths }) });
  const lines = log.text().split('\n').filter((l) => l.includes('dev build is from'));
  assert.deepEqual(lines, ['  ⚠ The installed dev build is from abc1234; this checkout is at def5678. Rebuild it: '
    + 'node scripts/build-release.js --dev, then run the `claude-web-chat update --from` line it prints.']);
  assert.deepEqual(snapshot(checkout), before, 'nothing in the checkout was written');

  const short = sink();
  versionCmd(['--short'], { log: short, paths, cwd: checkout, describeInstall: () => describeInstall({ packageRoot: paths.versionDir(DEV), paths }) });
  assert.deepEqual(short.text().split('\n'), [`claude-web-chat v${DEV}`], '--short stays one line');
});

test('H-11: a subdirectory of the checkout, a packed ref and a detached HEAD are read too', (t) => {
  const paths = devInstalled(t);
  const sub = path.join(fakeCheckout(t, { ref: 'packed' }), 'lib', 'cli');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(devBuildBehind({ cwd: sub, paths }).head, HEAD_SHA);
  assert.equal(devBuildBehind({ cwd: fakeCheckout(t, { ref: 'detached' }), paths }).head, HEAD_SHA);
});

test('H-11: a linked worktree reads its own HEAD and the branch from the common dir', (t) => {
  const paths = devInstalled(t);
  const main = fakeCheckout(t, { head: '1'.repeat(40) });
  const common = path.join(main, '.git');
  const wtGit = path.join(common, 'worktrees', 'wt');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  fs.mkdirSync(path.join(common, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(common, 'refs', 'heads', 'feature'), `${HEAD_SHA}\n`);
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-worktree-')));
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
  fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: 'claude-web-chat' }));
  assert.equal(gitHead(wt), HEAD_SHA);
  assert.equal(devBuildBehind({ cwd: wt, paths }).head, HEAD_SHA);
});

test('H-11: silent everywhere else', (t) => {
  // The dev build IS the checkout's HEAD (a short sha matches by prefix).
  let paths = devInstalled(t, `0.9.0-dev.202610021200.${HEAD_SHA.slice(0, 7)}`);
  assert.equal(devBuildBehind({ cwd: fakeCheckout(t), paths }), null, 'the installed build is HEAD');
  // A release installed, or a dev build stamped outside a checkout.
  paths = devInstalled(t, '0.8.2');
  assert.equal(devBuildBehind({ cwd: fakeCheckout(t), paths }), null, 'a release');
  paths = devInstalled(t, '0.9.0-dev.202610021200.nogit');
  assert.equal(devBuildBehind({ cwd: fakeCheckout(t), paths }), null, 'a dev build with no commit');
  // Not a checkout of this package, not a checkout at all, or a HEAD that cannot be read.
  paths = devInstalled(t);
  assert.equal(devBuildBehind({ cwd: fakeCheckout(t, { name: 'some-other-package' }), paths }), null, 'another package');
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-plain-')));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(devBuildBehind({ cwd: plain, paths }), null, 'no checkout');
  const broken = fakeCheckout(t);
  fs.writeFileSync(path.join(broken, '.git', 'HEAD'), 'ref: refs/heads/gone\n');
  assert.equal(devBuildBehind({ cwd: broken, paths }), null, 'a HEAD naming a ref that is not there');
  fs.writeFileSync(path.join(broken, '.git', 'HEAD'), 'ref: refs/heads/../../../../etc/passwd\n');
  assert.equal(gitHead(broken), null, 'a ref that climbs out is not followed');
  // And nothing reaches the output.
  const log = sink();
  versionCmd([], { log, paths, cwd: plain, describeInstall: () => describeInstall({ packageRoot: paths.versionDir(DEV), paths }) });
  assert.doesNotMatch(log.text(), /dev build is from/);
});

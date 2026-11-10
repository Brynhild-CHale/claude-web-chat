// The release half of contract 12 (C-12.6, C-12.11, section 2), U747:
//
//   1. A version with a prerelease tail (0.9.0-alpha.7) is published as a GitHub
//      PRERELEASE, on the create path and on a re-run over an existing release,
//      and a release version (0.9.0) never is. releases/latest is what
//      install.sh, `update` and the update check read, so an unmarked alpha
//      would become every user's update. The rule is a tested function
//      (scripts/build-release.js releaseArgs) that release.yml's publish step
//      takes its gh argv from — and that step is executed here against a stub gh.
//   2. devVersion keeps a prerelease base's core (0.9.0-alpha.7 -> 0.9.0-dev.*),
//      and bumps the minor only for a release base.
//   3. A package tree under node_modules is unmanaged before the git walk: a
//      dependency inside another project's repository is not a checkout.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { releaseArgs, prereleaseOf, devVersion } = require('../scripts/build-release');
const { compareVersions } = require('../lib/core/versions');
const { describeInstall } = require('../lib/update/install-layout');
const { installPaths } = require('../lib/core/paths');
const { withTempHome } = require('../test-support/helpers');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const NOW = new Date(Date.UTC(2026, 10, 10, 9, 5));

function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

// ─────────────────────────────────────────────────────────── releaseArgs ──

test('prereleaseOf: a - after the core is a prerelease, a bare core is not', () => {
  assert.equal(prereleaseOf('0.9.0-alpha.7'), true);
  assert.equal(prereleaseOf('v0.9.0-alpha.7'), true);
  assert.equal(prereleaseOf('0.9.0-dev.202611100905.abc1234'), true);
  assert.equal(prereleaseOf('0.9.0'), false);
  assert.equal(prereleaseOf('0.8.5'), false);
  assert.equal(prereleaseOf('1.0.0+build.5'), false, 'build metadata alone is no prerelease');
});

test('releaseArgs: a new prerelease is created with --prerelease', () => {
  const runs = releaseArgs('v0.9.0-alpha.7', '0.9.0-alpha.7', { exists: false });
  assert.deepEqual(runs, [[
    'release', 'create', 'v0.9.0-alpha.7',
    'dist/claude-web-chat-0.9.0-alpha.7.tar.gz', 'dist/SHA256SUMS',
    '--title', 'v0.9.0-alpha.7', '--generate-notes', '--prerelease',
  ]]);
});

test('releaseArgs: a re-run over an existing prerelease uploads, then marks it prerelease', () => {
  const runs = releaseArgs('v0.9.0-alpha.7', '0.9.0-alpha.7', { exists: true });
  assert.deepEqual(runs, [
    ['release', 'upload', 'v0.9.0-alpha.7', 'dist/claude-web-chat-0.9.0-alpha.7.tar.gz', 'dist/SHA256SUMS', '--clobber'],
    ['release', 'edit', 'v0.9.0-alpha.7', '--prerelease'],
  ]);
});

test('releaseArgs: a release version is never marked prerelease, on either path', () => {
  assert.deepEqual(releaseArgs('v0.9.0', '0.9.0', { exists: false }), [[
    'release', 'create', 'v0.9.0', 'dist/claude-web-chat-0.9.0.tar.gz', 'dist/SHA256SUMS',
    '--title', 'v0.9.0', '--generate-notes',
  ]]);
  assert.deepEqual(releaseArgs('v0.9.0', '0.9.0', { exists: true }), [
    ['release', 'upload', 'v0.9.0', 'dist/claude-web-chat-0.9.0.tar.gz', 'dist/SHA256SUMS', '--clobber'],
  ]);
});

test('releaseArgs: never --latest, and nothing a shell split could misread', () => {
  for (const [tag, version] of [['v0.9.0-alpha.7', '0.9.0-alpha.7'], ['v0.9.0', '0.9.0'], ['v1.0.0-rc.1', '1.0.0-rc.1']]) {
    for (const exists of [false, true]) {
      const flat = releaseArgs(tag, version, { exists }).flat();
      assert.ok(!flat.some((a) => a.startsWith('--latest')), `${tag} exists=${exists}: --latest`);
      assert.ok(flat.every((a) => /^[A-Za-z0-9._/+=:@-]+$/.test(a)), `${tag} exists=${exists}: ${flat.join(' ')}`);
    }
  }
  assert.throws(() => releaseArgs('v0.9.0', '0.9.0', { assets: ['dist/a b.tar.gz'] }), /refusing the argument/);
  assert.throws(() => releaseArgs('v0.9.0', '0.9.0', { assets: ['dist/*.tar.gz'] }), /refusing the argument/);
});

test('releaseArgs: a tag that is not v<version> is refused', () => {
  assert.throws(() => releaseArgs('v0.9.0-alpha.6', '0.9.0-alpha.7'), /does not match/);
  assert.throws(() => releaseArgs('0.9.0', '0.9.0'), /does not match/);
  assert.throws(() => releaseArgs(undefined, '0.9.0'), /does not match/);
  assert.throws(() => releaseArgs('v', ''), /no version/);
});

test('--release-args prints one gh call per line, and builds nothing', () => {
  const run = (...args) => execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build-release.js'), ...args], { encoding: 'utf8' });
  assert.equal(run('--release-args', 'v0.9.0-alpha.7', '--version', '0.9.0-alpha.7', '--exists'),
    'release upload v0.9.0-alpha.7 dist/claude-web-chat-0.9.0-alpha.7.tar.gz dist/SHA256SUMS --clobber\n'
    + 'release edit v0.9.0-alpha.7 --prerelease\n');
  // The version defaults to the repo's package.json.
  const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const lines = run('--release-args', `v${version}`).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^release create v${version.replace(/\./g, '\\.')} `));
});

// ───────────────────────────────────────────────────── the workflow's step ──

// The publish step's `run: |` block, as GitHub would hand it to bash.
function publishStep() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s*- name: Publish the release\s*$/.test(l));
  assert.ok(at >= 0, 'release.yml has a "Publish the release" step');
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  const indent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && l.match(/^\s*/)[0].length <= indent) break;
    body.push(l);
  }
  const strip = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return body.map((l) => l.slice(strip)).join('\n');
}

test('release.yml takes the publish step\'s gh argv from --release-args', () => {
  const step = publishStep();
  const code = step.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /node scripts\/build-release\.js --release-args "\$tag"/);
  assert.doesNotMatch(code, /gh release (create|upload|edit)/, 'no gh release call is spelled by hand any more');
  assert.doesNotMatch(code, /--latest/);
});

// Run the step for real with bash, a stub gh that logs its argv, and a scratch
// project holding package.json at `version`: what gh is asked to do is exactly
// releaseArgs' answer, on both paths.
function runStep(t, { version, exists }) {
  const dir = tmpDir(t, 'wc-release-step-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version }));
  fs.symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(dir, 'scripts'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$GH_LOG"',
    'if [ "$1" = release ] && [ "$2" = view ]; then exit "$GH_VIEW_EXIT"; fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const tag = `v${version}`;
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, publishStep().replace(/\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}/g, tag));
  execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: dir,
    env: {
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      HOME: process.env.HOME,
      GH_LOG: log,
      GH_VIEW_EXIT: exists ? '0' : '1',
    },
    encoding: 'utf8',
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls[0], `release view ${tag}`);
  return { tag, calls: calls.slice(1) };
}

test('the publish step, executed: a prerelease is marked on create and on a re-run', (t) => {
  for (const exists of [false, true]) {
    const { tag, calls } = runStep(t, { version: '0.9.0-alpha.7', exists });
    assert.deepEqual(calls, releaseArgs(tag, '0.9.0-alpha.7', { exists }).map((a) => a.join(' ')));
    assert.ok(calls.some((c) => /--prerelease$/.test(c)), `exists=${exists}: marked prerelease`);
  }
});

test('the publish step, executed: a release is never marked prerelease', (t) => {
  for (const exists of [false, true]) {
    const { tag, calls } = runStep(t, { version: '0.9.0', exists });
    assert.deepEqual(calls, releaseArgs(tag, '0.9.0', { exists }).map((a) => a.join(' ')));
    assert.ok(calls.every((c) => !c.includes('--prerelease') && !c.includes('--latest')), `exists=${exists}: ${calls}`);
  }
});

// ───────────────────────────────────────────────────────────── devVersion ──

test('devVersion keeps a prerelease base\'s core: 0.9.0-alpha.7 -> 0.9.0-dev.*', () => {
  const dev = devVersion('0.9.0-alpha.7', { now: NOW, sha: 'abc1234' });
  assert.equal(dev, '0.9.0-dev.202611100905.abc1234');
  assert.ok(compareVersions(dev, '0.9.0-alpha.7') > 0, 'above the alpha it was built after');
  assert.ok(compareVersions(dev, '0.9.0-alpha.99') > 0, 'above every 0.9.0-alpha.*');
  assert.ok(compareVersions(dev, '0.9.0') < 0, 'below the release it is heading for');
  assert.equal(devVersion('v1.0.0-rc.1', { now: NOW, sha: 'f00' }), '1.0.0-dev.202611100905.f00');
  assert.equal(devVersion('0.9.0-dev.202611010000.aaa', { now: NOW, sha: 'bbb' }), '0.9.0-dev.202611100905.bbb');
  // The core is kept whole, patch included: 0.9.1-alpha.1 heads for 0.9.1, not 0.9.0.
  const patched = devVersion('0.9.1-alpha.1', { now: NOW, sha: 'c0de' });
  assert.equal(patched, '0.9.1-dev.202611100905.c0de');
  assert.ok(compareVersions(patched, '0.9.1-alpha.1') > 0 && compareVersions(patched, '0.9.1') < 0);
});

test('devVersion still bumps the minor for a release base', () => {
  const at = new Date(Date.UTC(2026, 8, 27, 14, 15));
  assert.equal(devVersion('0.7.6', { now: at, sha: 'abc1234' }), '0.8.0-dev.202609271415.abc1234');
  assert.equal(devVersion('v1.9.3', { now: at, sha: 'f00' }), '1.10.0-dev.202609271415.f00');
  assert.equal(devVersion('0.8.5', { now: NOW, sha: 'abc' }), '0.9.0-dev.202611100905.abc');
});

// ───────────────────────────────────────────────────────── describeInstall ──

test('a package tree under node_modules inside a git repository is unmanaged', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const proj = path.join(tmpDir(t, 'wc-hub-'), 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const dep = path.join(proj, 'node_modules', 'claude-web-chat');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version: '0.9.0-alpha.7' }));
  const info = describeInstall({ packageRoot: dep, paths });
  assert.equal(info.kind, 'unmanaged');
  assert.equal(info.gitRoot, null);
  assert.equal(info.version, '0.9.0-alpha.7');
});

test('a plain checkout is still dev, and a versions tree still managed', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const checkout = path.join(tmpDir(t, 'wc-checkout-'), 'claude-web-chat');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '0.9.0-alpha.7' }));
  assert.equal(describeInstall({ packageRoot: checkout, paths }).kind, 'dev');

  // Only a whole node_modules path segment makes a tree a dependency: a checkout
  // under a folder whose name merely contains the word is still a checkout.
  const near = path.join(tmpDir(t, 'wc-near-'), 'my-node_modules-tools', 'claude-web-chat');
  fs.mkdirSync(path.join(near, '.git'), { recursive: true });
  fs.writeFileSync(path.join(near, 'package.json'), JSON.stringify({ version: '0.9.0-alpha.7' }));
  assert.equal(describeInstall({ packageRoot: near, paths }).kind, 'dev');

  const dir = paths.versionDir('0.9.0-alpha.7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.9.0-alpha.7' }));
  assert.equal(describeInstall({ packageRoot: dir, paths }).kind, 'managed');
});

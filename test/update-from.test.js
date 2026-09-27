// `claude-web-chat update --from <tarball>` and `build-release.js --dev`.
//
// The point of both: dogfood an UNRELEASED build as the managed install users
// get — the same verify → unpack → flip → relink as a GitHub update, from a file
// on disk, under a version (`<next minor>-dev.<stamp>.<sha>`) that can never land
// in a real release's directory. Every install here goes into a sandboxed HOME;
// the fixture tarballs are built by the real build script from a tiny fixture
// tree, so the bytes under test are the bytes a real `--dev` build writes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const update = require('../lib/cli/commands/update');
const versionCmd = require('../lib/cli/commands/version');
const { buildRelease, devVersion } = require('../scripts/build-release');
const { installPaths } = require('../lib/core/paths');
const { describeInstall, activate, linkBins, listVersions, readInstallRecord, pruneVersions } = require('../lib/update/install-layout');
const { listTarGz } = require('../lib/update/archive');
const { withTempHome } = require('../test-support/helpers');

function tmpDir(t, prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function sink() {
  const lines = [];
  const fn = (m = '') => lines.push(String(m));
  fn.text = () => lines.join('\n');
  return fn;
}

function inScratchCwd(t) {
  const dir = tmpDir(t, 'wc-cwd-');
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prev));
  return dir;
}

// A minimal claude-web-chat tree the real build script can package: the three
// bins and a package.json. No dependencies, so `npm ls` answers instantly.
function fixtureTree(t, { version = '0.7.6', name = 'claude-web-chat' } = {}) {
  const root = tmpDir(t, 'wc-tree-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version, files: ['bin/'] }, null, 2));
  fs.mkdirSync(path.join(root, 'bin'));
  for (const n of installPaths().BIN_NAMES) fs.writeFileSync(path.join(root, 'bin', `${n}.js`), '#!/usr/bin/env node\n');
  return root;
}

const NOW = new Date(Date.UTC(2026, 8, 27, 14, 15));

function buildDev(t, opts = {}) {
  const root = fixtureTree(t, opts);
  const outDir = tmpDir(t, 'wc-dist-');
  const built = buildRelease({ root, outDir, log: () => {}, dev: true, now: opts.now || NOW, sha: opts.sha || 'abc1234' });
  return { root, outDir, ...built };
}

// A fake managed 0.7.5, active and linked — the machine this is meant for.
function managed075(paths) {
  const dir = paths.versionDir('0.7.5');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version: '0.7.5' }));
  for (const n of paths.BIN_NAMES) fs.writeFileSync(path.join(dir, 'bin', `${n}.js`), '#!/usr/bin/env node\n');
  activate('0.7.5', paths);
  linkBins(paths);
  return dir;
}

function deps(paths, extra = {}) {
  return {
    paths,
    log: sink(),
    errlog: sink(),
    exit: (c) => { throw Object.assign(new Error(`exit ${c}`), { exitCode: c }); },
    restart: async () => {},
    readPortal: () => null,
    describeInstall: () => describeInstall({ packageRoot: paths.versionDir('0.7.5'), paths }),
    ...extra,
  };
}

// ── the dev stamp ──────────────────────────────────────────────────────────

test('devVersion is the next minor, a UTC minute stamp and the short sha', () => {
  assert.equal(devVersion('0.7.6', { now: NOW, sha: 'abc1234' }), '0.8.0-dev.202609271415.abc1234');
  assert.equal(devVersion('v1.9.3', { now: NOW, sha: 'f00' }), '1.10.0-dev.202609271415.f00');
  assert.throws(() => devVersion('nightly'), /cannot derive/);
});

test('a --dev build stamps the dev version into the ARTEFACT only', (t) => {
  const b = buildDev(t);
  assert.equal(b.version, '0.8.0-dev.202609271415.abc1234');
  assert.equal(path.basename(b.tarPath), 'claude-web-chat-0.8.0-dev.202609271415.abc1234.tar.gz');
  assert.match(fs.readFileSync(b.sumsPath, 'utf8'), new RegExp(`^${b.digest}  claude-web-chat-0\\.8\\.0-dev\\.`));
  const names = listTarGz(b.tarPath).map((e) => e.name);
  assert.ok(names.every((n) => n.startsWith('claude-web-chat-0.8.0-dev.202609271415.abc1234/')), 'the prefix directory carries it');
  // Read the packaged package.json back out.
  const out = tmpDir(t, 'wc-x-');
  require('../lib/update/archive').extractTarGz(b.tarPath, out, { strip: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).version, b.version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.root, 'package.json'), 'utf8')).version, '0.7.6',
    'the tree being built is never modified');
});

test('a normal build of the same tree is unaffected by the dev path', (t) => {
  const root = fixtureTree(t);
  const a = buildRelease({ root, outDir: tmpDir(t, 'wc-dist-'), log: () => {} });
  const b = buildRelease({ root, outDir: tmpDir(t, 'wc-dist-'), log: () => {}, dev: false, now: NOW, sha: 'zzz' });
  assert.equal(a.version, '0.7.6');
  assert.equal(a.digest, b.digest, 'still byte-reproducible, and the stamp inputs are ignored without --dev');
});

// ── update --from ──────────────────────────────────────────────────────────

test('update --from installs a dev build as the managed version: current swaps, bins link, version says dev', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  const b = buildDev(t);

  let fetched = false;
  const d = deps(paths, { fetchLatestRelease: async () => { fetched = true; return null; } });
  const res = await update(['--from', b.tarPath], d);

  assert.equal(fetched, false, '--from never asks GitHub');
  assert.deepEqual(res, { before: '0.7.5', after: b.version });
  assert.equal(fs.readlinkSync(paths.current), path.join('versions', b.version));
  for (const n of paths.BIN_NAMES) assert.equal(fs.readlinkSync(paths.binLink(n)), paths.currentBin(n));
  assert.deepEqual(listVersions(paths), [b.version, '0.7.5'], 'the dev build sorts above the release it followed');
  const rec = readInstallRecord(b.version, paths);
  assert.equal(rec.sha256, b.digest);
  assert.equal(rec.tarball, b.tarPath);
  assert.equal(rec.verified, true);
  assert.match(d.log.text(), /checksum ok/);

  const log = sink();
  versionCmd([], { log, paths, describeInstall: () => describeInstall({ packageRoot: paths.versionDir(b.version), paths }) });
  const text = log.text();
  assert.match(text.split('\n')[0], /^claude-web-chat v0\.8\.0-dev\.202609271415\.abc1234$/);
  assert.match(text, /dev build \(installed from a local file\)/);
  assert.ok(text.includes(b.digest), 'it names the tarball\'s sha');

  const list = sink();
  await update(['--list'], { ...d, log: list, describeInstall: () => describeInstall({ packageRoot: paths.versionDir(b.version), paths }) });
  assert.match(list.text(), /v0\.8\.0-dev\.202609271415\.abc1234 {2}\(dev build, from a local file\) {2}← current/);
  assert.match(list.text(), /v0\.7\.5$/m);
});

test('update --from refuses a tarball whose SHA256SUMS disagrees, and changes nothing', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  const b = buildDev(t);
  fs.writeFileSync(b.sumsPath, `${'0'.repeat(64)}  ${path.basename(b.tarPath)}\n`);

  const d = deps(paths);
  await assert.rejects(update(['--from', b.tarPath], d), /exit 1/);
  assert.match(d.errlog.text(), /checksum mismatch/);
  assert.match(d.errlog.text(), /Nothing was changed — you are still on v0\.7\.5/);
  assert.equal(fs.readlinkSync(paths.current), path.join('versions', '0.7.5'));
  assert.deepEqual(listVersions(paths), ['0.7.5'], 'nothing was unpacked');
  assert.deepEqual(fs.readdirSync(paths.staging), [], 'and the staging area was cleaned');
});

test('update --from refuses a SHA256SUMS with no entry for the file', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  const b = buildDev(t);
  fs.writeFileSync(b.sumsPath, `${b.digest}  some-other.tar.gz\n`);
  const d = deps(paths);
  await assert.rejects(update(['--from', b.tarPath], d), /exit 1/);
  assert.match(d.errlog.text(), /has no entry for/);
  assert.deepEqual(listVersions(paths), ['0.7.5']);
});

test('update --from with no SHA256SUMS is refused without --yes, and installs unverified with it', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  const b = buildDev(t);
  fs.unlinkSync(b.sumsPath);

  const d = deps(paths);
  await assert.rejects(update(['--from', b.tarPath], d), /exit 1/);
  assert.match(d.errlog.text(), /No SHA256SUMS beside it/);
  assert.match(d.errlog.text(), /--yes/);
  assert.deepEqual(listVersions(paths), ['0.7.5'], 'refused before anything was unpacked');

  const d2 = deps(paths);
  const res = await update(['--from', b.tarPath, '--yes'], d2);
  assert.equal(res.after, b.version);
  assert.equal(readInstallRecord(b.version, paths).verified, false);

  const log = sink();
  versionCmd([], { log, paths, describeInstall: () => describeInstall({ packageRoot: paths.versionDir(b.version), paths }) });
  assert.match(log.text(), /installed with --yes/);
});

test('update --to the old release rolls a dev install back', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  const b = buildDev(t);
  await update(['--from', b.tarPath], deps(paths));

  const d = deps(paths, { describeInstall: () => describeInstall({ packageRoot: paths.versionDir(b.version), paths }) });
  const res = await update(['--to', '0.7.5'], d);
  assert.deepEqual(res, { before: b.version, after: '0.7.5' });
  assert.equal(fs.readlinkSync(paths.current), path.join('versions', '0.7.5'));
  assert.ok(listVersions(paths).includes(b.version), 'the dev build stays on disk to switch back to');
});

test('update --from refuses from a git checkout, before reading the file', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  const checkout = path.join(paths.home, 'co');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '0.7.6' }));
  let unpacked = false;
  let code = null;
  const d = deps(paths, {
    describeInstall: () => describeInstall({ packageRoot: checkout, paths }),
    unpackLocal: () => { unpacked = true; },
    exit: (c) => { code = c; },
  });
  const res = await update(['--from', path.join(checkout, 'x.tar.gz')], d);
  assert.equal(res.refused, true);
  assert.equal(res.kind, 'dev');
  assert.equal(code, 1);
  assert.equal(unpacked, false);
  assert.match(d.errlog.text(), /REFUSING TO UPDATE/);
});

test('update --from will not overwrite a version already on disk without --force', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  // A NON-dev build of a number that is already installed — the release the
  // user would roll back to.
  const root = fixtureTree(t, { version: '0.7.5' });
  const outDir = tmpDir(t, 'wc-dist-');
  const b = buildRelease({ root, outDir, log: () => {} });
  fs.writeFileSync(path.join(paths.versionDir('0.7.5'), 'marker'), 'the real release');

  const d = deps(paths);
  await assert.rejects(update(['--from', b.tarPath], d), /exit 1/);
  assert.match(d.errlog.text(), /already unpacked/);
  assert.match(d.errlog.text(), /--force/);
  assert.ok(fs.existsSync(path.join(paths.versionDir('0.7.5'), 'marker')), 'the release on disk is untouched');

  const res = await update(['--from', b.tarPath, '--force'], deps(paths));
  assert.equal(res.after, '0.7.5');
  assert.ok(!fs.existsSync(path.join(paths.versionDir('0.7.5'), 'marker')), '--force replaces it');

  const log = sink();
  versionCmd([], { log, paths, describeInstall: () => describeInstall({ packageRoot: paths.versionDir('0.7.5'), paths }) });
  assert.match(log.text(), /local build \(installed from a local file\)/);
});

test('update --from refuses a tarball that is not a claude-web-chat build', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  const b = buildDev(t, { name: 'something-else' });
  const d = deps(paths);
  await assert.rejects(update(['--from', b.tarPath], d), /exit 1/);
  assert.match(d.errlog.text(), /not a claude-web-chat build/);
  assert.deepEqual(listVersions(paths), ['0.7.5']);
});

test('update --from a missing file, or with --to, is refused', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  const d = deps(paths);
  await assert.rejects(update(['--from', path.join(paths.home, 'nope.tar.gz')], d), /exit 1/);
  assert.match(d.errlog.text(), /No such file/);
  const d2 = deps(paths);
  await assert.rejects(update(['--from', 'x.tar.gz', '--to', '0.7.5'], d2), /exit 1/);
  assert.match(d2.errlog.text(), /pass one of them/);
});

test('parseArgs understands --from <f>, --from=<f> and --yes', () => {
  assert.equal(update.parseArgs(['--from', 'a.tar.gz']).from, 'a.tar.gz');
  assert.equal(update.parseArgs(['--from=b.tar.gz']).from, 'b.tar.gz');
  assert.equal(update.parseArgs([]).from, null);
  assert.equal(update.parseArgs(['--yes']).yes, true);
  assert.equal(update.parseArgs(['-y']).yes, true);
});

// ── pruning around dev builds ────────────────────────────────────────────────

test('repeated dev installs never prune the last real release', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  managed075(paths);
  let running = '0.7.5';
  const installed = [];
  for (let i = 0; i < 4; i++) {
    const b = buildDev(t, { now: new Date(NOW.getTime() + i * 60_000), sha: `abc12${i}0` });
    const was = running;
    await update(['--from', b.tarPath], deps(paths, { describeInstall: () => describeInstall({ packageRoot: paths.versionDir(was), paths }) }));
    running = b.version;
    installed.push(b.version);
  }
  const left = listVersions(paths);
  assert.ok(left.includes('0.7.5'), `0.7.5 must survive four dev installs (left: ${left.join(', ')})`);
  assert.deepEqual(left.slice(0, 3), installed.slice(1).reverse(), 'the newest three dev builds are kept, in stamp order');
  assert.ok(!left.includes(installed[0]), 'the oldest dev build is the one pruned');
});

test('pruneVersions keeps the newest release even when it falls outside `keep`', (t) => {
  withTempHome(t);
  const paths = installPaths();
  for (const v of ['0.7.5', '0.8.0-dev.202609270001.a', '0.8.0-dev.202609270002.b']) {
    fs.mkdirSync(paths.versionDir(v), { recursive: true });
    fs.writeFileSync(path.join(paths.versionDir(v), 'package.json'), JSON.stringify({ version: v }));
  }
  activate('0.8.0-dev.202609270002.b', paths);
  const removed = pruneVersions({ keep: 1, paths });
  assert.deepEqual(removed, ['0.8.0-dev.202609270001.a']);
  assert.deepEqual(listVersions(paths), ['0.8.0-dev.202609270002.b', '0.7.5']);
});

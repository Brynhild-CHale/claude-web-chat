// The release artifact. Three things must hold or a published release is broken
// in a way nobody can un-publish:
//
//   1. It is SELF-CONTAINED. The package has four runtime dependencies, so a
//      source-only tarball unpacks fine and then dies on `Cannot find module
//      'express'` — measured, not assumed. Production node_modules must be in it.
//   2. devDependencies are NOT in it. jsdom is ~30 MB of test-only weight.
//   3. It is REPRODUCIBLE. A published SHA256SUMS that depends on which machine
//      cut the release is a checksum nobody can check. The tar is reproducible
//      from the tree alone; the .tar.gz also depends on the zlib Node links
//      (official nodejs.org builds agree, Homebrew/distro Node do not), so the
//      build summary names that zlib and the uncompressed tar's digest.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { buildRelease, collectEntries, splitName, packageDirsFromTree } = require('../scripts/build-release');

const REPO_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

function tmpDir(prefix = 'wc-build-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Built once and shared: the build reads ~28 MB and gzips it, so paying for it
// per-test would be the slowest thing in the suite for no extra coverage. Its
// summary lines are kept for the test that reads them.
let built = null;
const summary = [];
function build() {
  if (!built) built = buildRelease({ outDir: tmpDir('wc-dist-'), log: (line) => summary.push(line) });
  return built;
}

test('the artifact carries production dependencies and no devDependencies', () => {
  const names = build().entries.map((e) => e.name);
  const prefix = `claude-web-chat-${pkg.version}`;

  for (const dep of Object.keys(pkg.dependencies)) {
    assert.ok(
      names.includes(`${prefix}/node_modules/${dep}/package.json`),
      `runtime dependency ${dep} is missing — the CLI would die on "Cannot find module '${dep}'"`,
    );
  }
  for (const dev of Object.keys(pkg.devDependencies || {})) {
    assert.ok(
      !names.some((n) => n.startsWith(`${prefix}/node_modules/${dev}/`)),
      `devDependency ${dev} must not ship in a release`,
    );
  }
  // Every entry sits under the single version prefix — no tarbomb, and
  // `--strip-components 1` therefore always means the same thing.
  for (const n of names) assert.ok(n.startsWith(`${prefix}/`), `entry outside the prefix: ${n}`);
});

test('the artifact carries package.json and everything the files allowlist names', () => {
  const names = new Set(build().entries.map((e) => e.name));
  const prefix = `claude-web-chat-${pkg.version}`;
  assert.ok(names.has(`${prefix}/package.json`), 'the runtime reads its own version out of package.json');
  for (const item of pkg.files) {
    const rel = item.replace(/\/$/, '');
    assert.ok(
      [...names].some((n) => n === `${prefix}/${rel}` || n.startsWith(`${prefix}/${rel}/`)),
      `package.json "files" lists ${item}, which is not in the artifact`,
    );
  }
  // The three bins ship executable — they are what ~/.local/bin points at.
  for (const bin of Object.values(pkg.bin)) {
    const e = build().entries.find((x) => x.name === `${prefix}/${bin}`);
    assert.ok(e, `${bin} missing`);
    assert.equal(e.mode, 0o755, `${bin} must be executable in the archive`);
  }
});

test('the dev-only trees stay out of the artifact (scripts/, the README clips and their recorder)', () => {
  const prefix = `claude-web-chat-${pkg.version}`;
  const names = build().entries.map((e) => e.name);
  for (const dev of ['scripts', '.github', 'test', 'test-support']) {
    assert.ok(!names.some((n) => n === `${prefix}/${dev}` || n.startsWith(`${prefix}/${dev}/`)),
      `${dev}/ is dev-only and must not ship — keep it out of package.json "files"`);
  }
});

test('the build is reproducible — same tree, same bytes, same checksum', () => {
  const a = build();
  const b = buildRelease({ outDir: tmpDir('wc-dist-'), log: () => {} });
  assert.equal(a.digest, b.digest, 'two builds of one tree must produce identical bytes');
  assert.equal(
    fs.readFileSync(a.sumsPath, 'utf8'),
    fs.readFileSync(b.sumsPath, 'utf8'),
  );
});

// Reproducible has to mean ACROSS MACHINES, not just twice on this one. The gzip
// header carries two run/platform-dependent fields: MTIME (node writes 0) and OS
// (RFC 1952 §2.3.1 — zlib stamps 3 on Linux, 19 on macOS). Left alone, the same
// tree cut on Linux and on macOS differs at exactly byte 9, and a user verifying a
// release by rebuilding it on another OS gets a mismatch that reads as tampering.
// (The deflate stream after the header is the zlib build's — see the next test.)
test('the gzip header is platform-independent — OS byte pinned, no mtime', () => {
  const gz = fs.readFileSync(build().tarPath);
  assert.deepEqual([...gz.subarray(0, 3)], [0x1f, 0x8b, 0x08], 'not a gzip stream');
  assert.deepEqual([...gz.subarray(4, 8)], [0, 0, 0, 0], 'MTIME must be zero, not the build time');
  assert.equal(gz[9], 255, 'gzip OS byte must be 255 ("unknown") on every platform');
});

// The one input the tree does not decide is the zlib Node links: official
// nodejs.org builds (what CI's setup-node installs) bundle one zlib and agree
// across 22.x and 24.x, while Homebrew and distro Node link the system zlib and
// deflate the same tar to different bytes. A rebuilder whose digest differs has
// to be able to tell "different zlib" from "different tree" — so the summary
// names the zlib, and the uncompressed tar's digest, which never varies with it.
// (The cross-zlib behaviour itself needs a second Node build to show.)
test('the build summary names the zlib and the uncompressed tar digest', () => {
  const { tarPath, digest, tarDigest, zlib: zlibVersion } = build();
  assert.equal(zlibVersion, process.versions.zlib);
  const zlibLine = summary.find((l) => /^\s*zlib\s/.test(l));
  assert.ok(zlibLine, `no zlib line in the build summary:\n${summary.join('\n')}`);
  assert.ok(zlibLine.includes(process.versions.zlib), `the zlib line must name ${process.versions.zlib}: ${zlibLine}`);

  const tar = require('zlib').gunzipSync(fs.readFileSync(tarPath));
  assert.equal(tarDigest, require('crypto').createHash('sha256').update(tar).digest('hex'),
    'tar sha256 is the digest of the gunzipped tarball — what a rebuild with another zlib can still match');
  assert.ok(summary.some((l) => /^\s*tar\s/.test(l) && l.includes(tarDigest)), 'the summary prints the tar digest');
  assert.ok(summary.some((l) => /^\s*sha256\s/.test(l) && l.includes(digest)), 'and still the published one');
});

test('SHA256SUMS names the tarball in the format shasum -c reads', () => {
  const { sumsPath, tarPath, digest } = build();
  const text = fs.readFileSync(sumsPath, 'utf8');
  assert.equal(text, `${digest}  ${path.basename(tarPath)}\n`);
  const out = execFileSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], {
    cwd: path.dirname(sumsPath), encoding: 'utf8',
  });
  assert.match(out, /: OK$/m, 'the stock checksum tool must accept what we publish');
});

test('a build merges into an existing SHA256SUMS, so older tarballs in dist/ still verify', () => {
  // The local dist/ collects builds (releases, several --dev ones); overwriting
  // SHA256SUMS with one line left every other tarball unverifiable, and
  // `update --from` refuses a tarball with no entry.
  const outDir = tmpDir('wc-dist-merge-');
  const older = 'claude-web-chat-0.7.0.tar.gz';
  fs.writeFileSync(path.join(outDir, older), 'an older build');
  const olderSum = require('crypto').createHash('sha256').update('an older build').digest('hex');
  const { tarPath, digest } = build();
  const tarName = path.basename(tarPath);
  fs.copyFileSync(tarPath, path.join(outDir, tarName));
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), [
    `${olderSum}  ${older}`,
    `${'0'.repeat(64)}  ${tarName}`,                        // a stale line for this very name
    `${'1'.repeat(64)}  claude-web-chat-0.6.0.tar.gz`,     // its tarball is gone
    '',
  ].join('\n'));

  const again = buildRelease({ outDir, log: () => {} });
  assert.equal(again.digest, digest);
  const text = fs.readFileSync(again.sumsPath, 'utf8');
  assert.equal(text, `${olderSum}  ${older}\n${digest}  ${tarName}\n`,
    'keep the older entry, replace this build\'s, drop the one whose tarball is gone');
  const out = execFileSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: outDir, encoding: 'utf8' });
  assert.match(out, new RegExp(`${older.replace(/\./g, '\\.')}: OK`));
  assert.match(out, new RegExp(`${tarName.replace(/\./g, '\\.')}: OK`));
});

test('the system tar can read what we write, preserving the executable bit', () => {
  const { tarPath } = build();
  const dest = tmpDir('wc-unpack-');
  execFileSync('tar', ['-xzf', tarPath, '--strip-components', '1', '-C', dest]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version, pkg.version);
  assert.ok(fs.statSync(path.join(dest, 'bin', 'claude-web-chat.js')).mode & 0o111);
  assert.ok(fs.existsSync(path.join(dest, 'node_modules', 'express', 'package.json')));
});

// The artifact has to actually RUN with nothing else installed — that is the
// whole reason it is not a source tarball. Unpacked into a scratch HOME, laid
// out the way install.sh does, and invoked: no npm, no network.
test('the unpacked artifact runs the CLI with no npm and no network', () => {
  const { tarPath } = build();
  const home = tmpDir('wc-home-');
  const dir = path.join(home, '.web-chat', 'versions', pkg.version);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tarPath, '--strip-components', '1', '-C', dir]);
  fs.symlinkSync(path.join('versions', pkg.version), path.join(home, '.web-chat', 'current'));

  const run = (args) => execFileSync(process.execPath, [path.join(dir, 'bin', 'claude-web-chat.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: path.dirname(process.execPath) },
  });
  assert.match(run(['--version']), new RegExp(`^claude-web-chat v${pkg.version.replace(/\./g, '\\.')}`));
  assert.match(run(['--version']), /managed install/, 'a release under ~/.web-chat/versions must classify as managed');
  assert.match(run(['help']), /claude-web-chat <command>/);
});

test('ustar long paths split at a directory boundary rather than truncating', () => {
  const long = `claude-web-chat-0.5.0/node_modules/${'a'.repeat(60)}/${'b'.repeat(60)}/index.js`;
  const { name, prefix } = splitName(long);
  assert.ok(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155);
  assert.equal(`${prefix}/${name}`, long, 'the split must be lossless');
  assert.deepEqual(splitName('short/path.js'), { name: 'short/path.js', prefix: '' });
  assert.throws(() => splitName(`x/${'y'.repeat(300)}`), /too long/);
});

test('collectEntries is sorted and free of duplicates', () => {
  const entries = collectEntries(REPO_ROOT, 'p');
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), 'entry order must be deterministic');
  assert.equal(new Set(names).size, names.length, 'no path may appear twice');
});

// ── the production tree comes from npm's TREE, never its printed paths ─────
//
// npm redacts a UUID-shaped path segment to `***` in what it prints, and
// `npm ls --parseable` paths are no exception — so a checkout under a
// UUID-named directory (a Claude Code worktree, a mktemp dir) read back as
// `/…/***/…/node_modules/express`, and the build refused every package as
// "resolved outside node_modules". The directories are now built from the root
// and the dependency tree's NAMES, which nothing redacts.

// A tiny installed project under a UUID-named directory: a nested copy (a's own
// b@2 beside the hoisted b@1), a scoped package, a devDependency on disk that
// must never be listed, and a package.json per package the way npm lays it out.
function uuidProject() {
  const root = path.join(tmpDir('wc-npm-tree-'), require('crypto').randomUUID(), 'proj');
  const put = (rel, json) => {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, 'package.json'), JSON.stringify(json));
  };
  put('.', {
    name: 'proj', version: '1.0.0', files: ['index.js'],
    dependencies: { a: '1.0.0', '@s/c': '1.0.0' }, devDependencies: { d: '1.0.0' },
  });
  fs.writeFileSync(path.join(root, 'index.js'), '');
  put('node_modules/a', { name: 'a', version: '1.0.0', dependencies: { b: '2.0.0' } });
  put('node_modules/a/node_modules/b', { name: 'b', version: '2.0.0' });
  put('node_modules/b', { name: 'b', version: '1.0.0' });
  put('node_modules/@s/c', { name: '@s/c', version: '1.0.0', dependencies: { b: '1.0.0' } });
  put('node_modules/d', { name: 'd', version: '1.0.0' });
  return root;
}

// What `npm ls --omit=dev --all --json` prints for it — including the two shapes
// that carry no directory of their own: a deduped node (version only, no
// dependencies) and an optional peer npm reports but never installed (`{}`).
const UUID_TREE = {
  name: 'proj',
  version: '1.0.0',
  dependencies: {
    '@s/c': { version: '1.0.0', dependencies: { b: { version: '1.0.0' }, 'peer-opt': {} } },
    a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } },
  },
};

test('production package dirs are derived from the dependency tree, so a UUID-named checkout builds', () => {
  const root = uuidProject();
  const dirs = packageDirsFromTree(root, UUID_TREE);
  const rels = dirs.map((d) => path.relative(root, d).split(path.sep).join('/'));
  assert.deepEqual(rels, [
    'node_modules/@s/c',
    'node_modules/a',
    'node_modules/a/node_modules/b',
    'node_modules/b',
  ], 'the nearest node_modules/<name> from each requiring package, the way Node resolves it');
  for (const d of dirs) {
    assert.ok(!d.includes('***'), `a derived path is never npm's redacted spelling: ${d}`);
    assert.ok(d.startsWith(path.join(root, 'node_modules') + path.sep), `outside node_modules: ${d}`);
  }
});

test('a package the tree names but the disk lacks fails the build, naming it', () => {
  const root = uuidProject();
  const tree = { ...UUID_TREE, dependencies: { ...UUID_TREE.dependencies, ghost: { version: '3.1.4' } } };
  assert.throws(() => packageDirsFromTree(root, tree), /production dependency ghost@3\.1\.4 \(required by proj\) is not installed/);

  // And a derived directory holding a different version than npm resolved is
  // refused rather than shipped: the lookup and npm disagree about the tree.
  const skew = { name: 'proj', dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '9.9.9' } } } } };
  assert.throws(() => packageDirsFromTree(root, skew), /b@9\.9\.9 \(required by a@1\.0\.0\) resolved to .*which holds 2\.0\.0/);
});

test('collectEntries builds from a UUID-named checkout with the real npm (no "resolved outside node_modules")', () => {
  const root = uuidProject();
  const names = collectEntries(root, 'p').map((e) => e.name);
  for (const want of [
    'p/node_modules/a/package.json',
    'p/node_modules/a/node_modules/b/package.json',
    'p/node_modules/b/package.json',
    'p/node_modules/@s/c/package.json',
  ]) assert.ok(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
  assert.ok(!names.some((n) => n.startsWith('p/node_modules/d/')), 'a devDependency must not ship');
});

// A `.gitkeep` exists to make git track an EMPTY directory. Seven of them
// outlived their directories by many versions and rode into every release
// tarball — dead weight a user unpacks, and a false hint that the directory
// might be empty. The tarball is built from the `files` allowlist, so the fix is
// deleting the placeholder, and the ratchet is here: a directory that needs one
// has no real files, and a directory with no real files has no business in the
// artifact.
test('no vestigial .gitkeep rides into the release tarball', () => {
  const entries = collectEntries(REPO_ROOT, 'p');
  const keeps = entries.map((e) => e.name).filter((n) => n.endsWith('/.gitkeep'));
  assert.deepEqual(keeps, [],
    'these directories all hold real files — delete the placeholder rather than shipping it');
});

// ── the cross-version registration contract ─────────────────────────────────
//
// `update` (0.7.0 and every build after it) syncs a project's managed files
// with the NEWLY INSTALLED build's engine: loadRegistration() in
// lib/cli/commands/update.js resolves
// `~/.web-chat/versions/<target>/lib/setup/registration.js` BY PATH and calls
// `apply()` on it. That path and that export name are therefore frozen for
// every future release — an updater already on a user's machine cannot be
// changed. Renaming the file, moving it, dropping `apply`, or letting it fall
// out of the `files` allowlist does not break THIS build; it breaks every
// `update` already in the wild, which degrades to the loud fallback and syncs
// managed files against its own stale templates — the exact 0.6.0-era trap the
// version-directory resolution exists to remove.
//
// So this is a contract test, not a unit test: it fails the build at the moment
// the rename happens, which is the only moment anyone can still undo it.
test('lib/setup/registration.js still exports apply() — older updaters call it by path', () => {
  const rel = path.join('lib', 'setup', 'registration.js');
  const abs = path.join(REPO_ROOT, rel);
  assert.ok(
    fs.existsSync(abs),
    `${rel} is gone — every shipped update resolves this exact path in the version it just installed`,
  );
  // Required BY PATH, the way loadRegistration requires it out of versions/<target>.
  const mod = require(abs);
  assert.equal(
    typeof mod.apply, 'function',
    'update calls mod.apply(...) on the target version\'s engine — renaming it silently breaks every updater in the wild',
  );
});

test('the release artifact ships lib/setup/registration.js', () => {
  const names = new Set(build().entries.map((e) => e.name));
  const wanted = `claude-web-chat-${pkg.version}/lib/setup/registration.js`;
  assert.ok(
    names.has(wanted),
    `${wanted} is not in the artifact — a "files" allowlist that stops shipping it makes the NEXT release`
    + ' unloadable by every already-installed update, which then syncs with its own older templates',
  );
});

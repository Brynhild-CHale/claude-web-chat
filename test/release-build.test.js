// The release artifact. Three things must hold or a published release is broken
// in a way nobody can un-publish:
//
//   1. It is SELF-CONTAINED. The package has four runtime dependencies, so a
//      source-only tarball unpacks fine and then dies on `Cannot find module
//      'express'` — measured, not assumed. Production node_modules must be in it.
//   2. devDependencies are NOT in it. jsdom is ~30 MB of test-only weight.
//   3. It is REPRODUCIBLE. A published SHA256SUMS that depends on which machine
//      cut the release is a checksum nobody can check.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { buildRelease, collectEntries, splitName } = require('../scripts/build-release');

const REPO_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

function tmpDir(prefix = 'wc-build-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Built once and shared: the build reads ~28 MB and gzips it, so paying for it
// per-test would be the slowest thing in the suite for no extra coverage.
let built = null;
function build() {
  if (!built) built = buildRelease({ outDir: tmpDir('wc-dist-'), log: () => {} });
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
test('the gzip header is platform-independent — OS byte pinned, no mtime', () => {
  const gz = fs.readFileSync(build().tarPath);
  assert.deepEqual([...gz.subarray(0, 3)], [0x1f, 0x8b, 0x08], 'not a gzip stream');
  assert.deepEqual([...gz.subarray(4, 8)], [0, 0, 0, 0], 'MTIME must be zero, not the build time');
  assert.equal(gz[9], 255, 'gzip OS byte must be 255 ("unknown") on every platform');
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

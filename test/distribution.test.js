// Distribution is GitHub Releases into ~/.web-chat/versions, with ~/.local/bin
// symlinks. npm is not part of it — not as a fallback, not "just for the
// install", not in the docs.
//
// This file is the ratchet for that decision. It exists because the decision is
// easy to un-make one convenient line at a time: a `npm i -g` in a shell script
// is three words, and the failure it reintroduces (a shared global prefix that
// any other install can clobber, with no way to tell what you are running) took
// two weeks to notice last time. The docs are checked too — a README that
// documents a path the code no longer takes is the same bug, wearing prose.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// Everything a user's install or update actually executes or reads.
const INSTALL_PATH_FILES = [
  'install.sh',
  'lib/cli/commands/update.js',
  'lib/cli/commands/uninstall.js',
  'lib/cli/commands/version.js',
  'lib/update/release.js',
  'lib/update/install-layout.js',
  'lib/core/paths.js',
  '.github/workflows/release.yml',
  'scripts/build-release.js',
];

test('nothing in the install or update path shells out to npm', () => {
  // install.sh is a shell script: no line may INVOKE npm. (Its error messages
  // may still mention `npm install` when telling someone how to run from a
  // checkout — that is advice about a different situation, not this install.)
  for (const line of read('install.sh').split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    assert.ok(!/^\s*npm\s/.test(line), `install.sh invokes npm:\n  ${line.trim()}`);
    assert.ok(!/npm\s+(i|install|link)\b.*-g|npm\s+link\b/.test(line), `install.sh installs globally via npm:\n  ${line.trim()}`);
  }

  // The JS side: the only npm invocation anywhere is the BUILD script asking
  // the already-installed tree what the production dependencies are. Anything
  // that INSTALLS through npm is the banned thing — a global npm prefix is
  // shared mutable state that an unrelated `npm i -g` silently rewrites.
  const spawnsNpm = /(spawnSync|spawn|execFile|execFileSync|exec|execSync)\(\s*['"`]npm['"`]/g;
  for (const rel of INSTALL_PATH_FILES.filter((f) => f.endsWith('.js'))) {
    const body = read(rel);
    const calls = [...body.matchAll(spawnsNpm)];
    if (rel === 'scripts/build-release.js') {
      for (const m of calls) {
        const args = body.slice(m.index, m.index + 160);
        assert.match(args, /['"`]ls['"`]/, 'the build may only ASK npm what is installed, never install');
      }
      continue;
    }
    assert.equal(calls.length, 0, `${rel} shells out to npm — distribution is GitHub Releases`);
  }

  // And the workflow never publishes to a registry.
  for (const line of read('.github/workflows/release.yml').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    assert.ok(!/npm publish/.test(line), `the release workflow must never publish to npm:\n  ${line.trim()}`);
  }
});

test('install.sh is POSIX sh, needs no sudo, and verifies before it installs', () => {
  const sh = read('install.sh');
  // Actually parse it with /bin/sh — a syntax error here bricks every install.
  execFileSync('/bin/sh', ['-n', path.join(REPO_ROOT, 'install.sh')]);
  assert.match(sh.split('\n')[0], /^#!\/bin\/sh$/, 'must be plain sh, not bash');
  for (const line of sh.split('\n')) {
    if (/^\s*#/.test(line)) continue; // the header comment promises no sudo; that is not a use of it
    assert.ok(!/\bsudo\b/.test(line), `the installer must never need sudo:\n  ${line.trim()}`);
  }
  assert.match(sh, /shasum -a 256|sha256sum/, 'the download must be checksum-verified');
  assert.match(sh, /\$HOME\/\.local\/bin/, 'the install prefix is ~/.local/bin');
  assert.match(sh, /\.web-chat\/versions/, 'releases unpack into a versioned directory');
  // Both downloaders handled, and a clear failure when neither is present.
  assert.match(sh, /command -v curl/);
  assert.match(sh, /command -v wget/);
  assert.match(sh, /needs curl or wget/);
  // The destructive steps come after verification.
  const verifiedAt = sh.indexOf('echo "Checksum verified."');
  const movedAt = sh.indexOf('mv "$dest.incoming" "$dest"');
  assert.ok(verifiedAt > 0 && movedAt > 0, 'both the verify and the move must be present');
  assert.ok(verifiedAt < movedAt, 'nothing may be moved into place before the checksum passes');
});

test('install.sh does not add Windows branches — WSL2 is the whole Windows story', () => {
  const sh = read('install.sh');
  for (const token of ['.cmd', 'powershell', 'MINGW', 'CYGWIN', 'win32']) {
    assert.ok(!sh.includes(token), `install.sh should not branch on Windows (${token})`);
  }
  assert.match(read('README.md'), /WSL2/, 'the README must tell Windows users to use WSL2');
});

test('the docs describe the install that exists, not the npm one that does not', () => {
  const readme = read('README.md');
  // The old quickstart claimed a global npm install and told users to find the
  // extension folder with `npm root -g` — a path that no longer exists.
  assert.ok(!/npm root -g/.test(readme), 'npm root -g no longer resolves to anything');
  assert.ok(!/npm i -g claude-web-chat|npm install -g claude-web-chat/.test(readme));
  assert.match(readme, /~\/\.local\/bin/, 'the README must say where the command is installed');
  assert.match(readme, /~\/\.web-chat\/versions/, 'and where the program itself lives');
  assert.match(readme, /--to /, 'rollback is a documented feature');

  // `npm link` may only appear as the thing NOT to do.
  for (const rel of ['README.md', 'docs/extending.md']) {
    const body = read(rel);
    const idx = body.indexOf('npm link');
    if (idx === -1) continue;
    const context = body.slice(Math.max(0, idx - 220), idx + 220);
    assert.match(context, /not to do|Do not use/i, `${rel} still presents \`npm link\` as the dev setup`);
  }
});

test('package.json keeps the anti-publish guard and ships no build step', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true, '"private": true is what makes an accidental npm publish fail fast');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.ok(pkg.scripts['build:release'], 'the release artifact must be buildable from a script');
  for (const bin of Object.values(pkg.bin)) {
    assert.match(read(bin).split('\n')[0], /^#!\/usr\/bin\/env node$/, `${bin} needs a shebang — it is symlinked onto PATH directly`);
  }
});

test('the release workflow builds the artifact and publishes it, and never publishes to npm', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /tags: \['v\*'\]/, 'a version tag is the trigger');
  assert.match(wf, /node scripts\/build-release\.js/);
  assert.match(wf, /gh release (create|upload)/, 'assets are attached to the GitHub release');
  assert.match(wf, /SHA256SUMS/, 'the checksums must be published alongside the tarball');
  assert.match(wf, /npm test/, 'a release that fails its own suite is not a release');
});

test('the three bin names are minted in one place and used everywhere', () => {
  const { BIN_NAMES } = require('../lib/core/paths');
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(BIN_NAMES.slice().sort(), Object.keys(pkg.bin).sort(),
    'lib/core/paths BIN_NAMES must match package.json "bin" — the installer links exactly these');
  const sh = read('install.sh');
  for (const name of BIN_NAMES) assert.ok(sh.includes(name), `install.sh must link ${name}`);
});

// The plugin manifest has drifted behind package.json twice: fixed deliberately
// in 5d21f38 (0.1.0 → 0.4.0) and regressed one commit later at 5d6635e. Nothing
// reads it at runtime, which is exactly why nobody notices.
test('the plugin manifest tracks the package version', () => {
  const pkg = JSON.parse(read('package.json'));
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(plugin.version, pkg.version,
    '.claude-plugin/plugin.json must not drift behind package.json');
});

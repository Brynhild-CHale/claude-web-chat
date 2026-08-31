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
const { execFileSync, execFile } = require('child_process');

const { docFiles } = require('../test-support/doc-truth');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// The three spellings the docs actually use to forbid `npm link`: README's "the
// one thing not to do here", extending.md's "Do not use `npm link`", and
// CLAUDE.md's bolded "Do **not** `npm link` this package". A bare /not/ would
// pass on any paragraph; each alternative here has to negate npm link itself.
const FORBIDS_NPM_LINK = /not to do|do\s+(?:\*\*)?not(?:\*\*)?\s+(?:use\s+)?`?npm link|never\s+(?:use\s+)?`?npm link/i;

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
  // `current` is a symlink to a DIRECTORY: mv stat()s its destination, sees a
  // directory and moves the source inside it. Only `ln -sfn` replaces it.
  assert.match(sh, /ln -sfn "versions\/\$version" "\$WC_HOME\/current"/,
    'the `current` swap must be `ln -sfn` — see the executed test at the foot of this file');
  for (const line of sh.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    assert.ok(!/^\s*mv\b.*"\$WC_HOME\/current"\s*$/.test(line),
      `mv cannot rename over a symlink-to-a-directory — it moves INTO it:\n  ${line.trim()}`);
  }

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

  // `npm link` may only appear as the thing NOT to do — in EVERY shipped doc,
  // not the two that happened to mention it when this was written. docFiles()
  // is the one home of "where a doc claim can live" (test-support/doc-truth),
  // so a new doc that presents `npm link` as setup is caught the day it lands.
  // Every occurrence is checked, not just the first: a file may name it twice.
  for (const { rel, body } of docFiles()) {
    for (let idx = body.indexOf('npm link'); idx !== -1; idx = body.indexOf('npm link', idx + 1)) {
      const context = body.slice(Math.max(0, idx - 220), idx + 220);
      assert.match(context, FORBIDS_NPM_LINK, `${rel} still presents \`npm link\` as the dev setup`);
    }
  }
});

test('package.json keeps the anti-publish guard and ships no build step', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true, '"private": true is what makes an accidental npm publish fail fast');
  // A bare `node --test` (no path argument — a directory mis-resolves), plus a
  // per-test timeout: without one a single leaked handle hangs the whole run.
  // Deliberately NOT --test-force-exit, which turns a hang into a silent pass.
  // --import loads the throwaway-HOME sandbox before any test file's first
  // require, so an env-less subprocess spawn can't reach the real ~/.web-chat.
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000 --import ./test-support/sandbox.js');
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

// Both workflows explain the shape of `npm test` in a comment, and the shape
// changed under them: the timeout and the HOME sandbox --import landed while
// release.yml still called it "a bare `node --test`". A CI comment is the last
// place anyone looks for a stale fact, so the one it turns on is asserted here
// against package.json rather than left to the next reader to notice.
test('the CI comments describe `npm test` as it actually is', () => {
  const script = JSON.parse(read('package.json')).scripts.test;
  const flags = script.split(/\s+/).slice(2);
  assert.ok(script.startsWith('node --test') && flags.length > 0,
    'the test script is `node --test` PLUS flags — if that ever stops being true, revisit the comments below');
  for (const f of ['.github/workflows/test.yml', '.github/workflows/release.yml']) {
    const wf = read(f);
    assert.match(wf, /npm test/, `${f} must run the suite`);
    assert.doesNotMatch(wf, /bare `node --test`/,
      `${f} calls npm test a bare \`node --test\`, but it is \`${script}\``);
    assert.match(wf, /NO path argument|no path argument/i,
      `${f} must keep the fact that matters: npm test takes no path argument`);
  }
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

// ── install.sh, actually executed ───────────────────────────────────────────
// Everything above READS install.sh. This runs it, twice, against a scratch
// HOME and a loopback stand-in for the GitHub API — no network, nothing outside
// a temp dir, and the CLI itself is never invoked (the tarball's "bins" only
// print their version).
//
// Twice is the whole point. `mv -f current.incoming current` stat()s its
// destination, and a `current` symlink pointing at a version directory stats as
// a directory — so mv moved the new link INTO the old version instead of
// renaming over it. The first install looked perfect; every upgrade after it
// unpacked the new release, printed the new version number, and left `current`
// (and therefore all three bins, which resolve through it) pointing at the old
// code. CI has never run install.sh at all: release.yml's smoke test does its
// own `ln -s` into a fresh scratch HOME, which is exactly the case that works.

const http = require('http');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { makeTar } = require('../scripts/build-release');
const { BIN_NAMES } = require('../lib/core/paths');

function scratchDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function hasCommand(name) {
  return spawnSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

// A minimal but genuine release tarball: the single `claude-web-chat-<v>/`
// prefix install.sh strips, a package.json so its "is this actually a release?"
// check passes, and the three bins it links onto PATH — each stamped with its
// own version, so the test can tell which tree a bin symlink resolves to.
function buildFakeRelease(dir, version) {
  const src = path.join(dir, `src-${version}`);
  fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version }));
  const entries = [{
    name: `claude-web-chat-${version}/package.json`, type: 'file', mode: 0o644, source: path.join(src, 'package.json'),
  }];
  for (const b of BIN_NAMES) {
    const f = path.join(src, 'bin', `${b}.js`);
    fs.writeFileSync(f, `#!/usr/bin/env node\nconsole.log('${version}');\n`);
    entries.push({ name: `claude-web-chat-${version}/bin/${b}.js`, type: 'file', mode: 0o755, source: f });
  }
  const name = `claude-web-chat-${version}.tar.gz`;
  const tgz = zlib.gzipSync(makeTar(entries));
  fs.writeFileSync(path.join(dir, name), tgz);
  const sha = crypto.createHash('sha256').update(tgz).digest('hex');
  fs.writeFileSync(path.join(dir, `SHA256SUMS.${version}`), `${sha}  ${name}\n`);
  return name;
}

// The two endpoints install.sh talks to: /releases/latest and the asset URLs it
// scrapes out of that JSON. `state.version` is what "latest" currently means.
function fakeReleases(t, dir, state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url === '/releases/latest') {
        const v = state.version;
        const base = `http://127.0.0.1:${server.address().port}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          tag_name: `v${v}`,
          assets: [
            { browser_download_url: `${base}/dl/claude-web-chat-${v}.tar.gz` },
            { browser_download_url: `${base}/dl/SHA256SUMS` },
          ],
        }));
        return;
      }
      const file = url === '/dl/SHA256SUMS'
        ? path.join(dir, `SHA256SUMS.${state.version}`)
        : path.join(dir, path.basename(url));
      if (!url.startsWith('/dl/') || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    t.after(() => new Promise((done) => server.close(done)));
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('install.sh moves `current` to the new version when it is re-run over an existing install', async (t) => {
  if (process.platform === 'win32') { t.skip('WSL2 is the Windows story'); return; }
  if (!hasCommand('curl') && !hasCommand('wget')) { t.skip('no curl or wget'); return; }
  if (!hasCommand('shasum') && !hasCommand('sha256sum')) { t.skip('no shasum or sha256sum'); return; }
  if (!hasCommand('tar')) { t.skip('no tar'); return; }

  const dir = scratchDir('wc-install-sh-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  buildFakeRelease(dir, '9.9.1');
  buildFakeRelease(dir, '9.9.2');
  const state = { version: '9.9.1' };
  const base = await fakeReleases(t, dir, state);

  // ASYNC on purpose: the stand-in server shares this process's event loop, so a
  // synchronous spawn would block the thread the installer's own download is
  // waiting on.
  const install = () => new Promise((resolve, reject) => {
    execFile('/bin/sh', [path.join(REPO_ROOT, 'install.sh')], {
      env: { ...process.env, HOME: home, WEB_CHAT_API_BASE: base },
      encoding: 'utf8',
    }, (err, stdout, stderr) => (err ? reject(new Error(`install.sh failed: ${stderr || err.message}`)) : resolve(stdout)));
  });
  const current = path.join(home, '.web-chat', 'current');
  const cli = path.join(home, '.local', 'bin', 'claude-web-chat');

  await install();
  assert.equal(fs.readlinkSync(current), 'versions/9.9.1');
  assert.match(fs.readFileSync(cli, 'utf8'), /9\.9\.1/, 'the bin symlink must resolve into the installed version');

  // Debris exactly where the broken `mv` used to deposit it: a dangling link
  // INSIDE the version directory, which no sweep reached — so an install
  // upgraded through that installer carried it forever, and the write bumped
  // that directory's mtime, which is what the prune sorts on.
  const debris = path.join(home, '.web-chat', 'versions', '9.9.1', 'current.incoming');
  fs.symlinkSync('versions/9.9.1', debris);

  // The re-run. This is the case the installer promises is "always safe".
  state.version = '9.9.2';
  await install();
  assert.equal(fs.existsSync(debris) || fs.lstatSync(debris, { throwIfNoEntry: false }) != null, false,
    'the re-run must sweep the debris an older installer left inside a version dir');
  assert.equal(fs.readlinkSync(current), 'versions/9.9.2', '`current` must point at the version just installed');
  assert.match(fs.readFileSync(cli, 'utf8'), /9\.9\.2/, 'the bins resolve through `current`, so they move with it');
  assert.deepEqual(
    fs.readdirSync(path.join(home, '.web-chat', 'versions', '9.9.1')).sort(),
    ['bin', 'package.json'],
    'the swap must not deposit anything inside the version it replaced, and must sweep what an older one did',
  );
});

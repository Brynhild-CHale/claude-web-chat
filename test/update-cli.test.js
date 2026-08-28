// `claude-web-chat update`.
//
// The guard is the reason this file exists. An unrelated `npm i -g` once
// replaced a maintainer's `npm link` with a copy of a 16-day-old build; the
// checkout stayed green and the command on PATH was ancient, and nothing said
// so. `update` must therefore refuse to run from anything but a managed install,
// loudly — and when it does run, it must leave the previous install intact on
// failure, roll back without a network, and restart the daemon on the code it
// just installed rather than the code it was launched from.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const update = require('../lib/cli/commands/update');
const { installPaths } = require('../lib/core/paths');
const { activate, linkBins, listVersions } = require('../lib/update/install-layout');
const { withTempHome } = require('../test-support/helpers');

function fakeVersion(paths, version, restartBody) {
  const dir = paths.versionDir(version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib', 'cli', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version }));
  for (const name of paths.BIN_NAMES) fs.writeFileSync(path.join(dir, 'bin', `${name}.js`), '#!/usr/bin/env node\n');
  fs.writeFileSync(
    path.join(dir, 'lib', 'cli', 'commands', 'restart.js'),
    restartBody || `module.exports = async function restart() { return '${version}'; };\nmodule.exports.version = '${version}';\n`,
  );
  return dir;
}

// A log sink readable as one string.
function sink() {
  const lines = [];
  const fn = (m = '') => lines.push(String(m));
  fn.text = () => lines.join('\n');
  return fn;
}

// update() syncs managed files for whatever project it is run in; keep every
// test out of this repo's own .web-chat by running from a scratch cwd.
function inScratchCwd(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cwd-')));
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prev));
  return dir;
}

function deps(extra = {}) {
  return {
    log: sink(),
    errlog: sink(),
    exit: (c) => { throw Object.assign(new Error(`exit ${c}`), { exitCode: c }); },
    restart: async () => {},
    ...extra,
  };
}

// ── the guard ───────────────────────────────────────────────────────────────

test('update REFUSES from a git checkout, and says how to update a checkout', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  const checkout = path.join(paths.home, 'src', 'claude-web-chat');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '0.9.9' }));

  const d = deps({ describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: checkout, paths }) });
  let code = null;
  d.exit = (c) => { code = c; };
  const res = await update([], d);

  assert.equal(res.refused, true);
  assert.equal(res.kind, 'dev');
  assert.equal(code, 1, 'a refusal must exit non-zero');
  const text = d.errlog.text();
  assert.match(text, /REFUSING TO UPDATE/);
  assert.match(text, /GIT CHECKOUT/);
  assert.match(text, /git pull/, 'it must say what to do instead');
  assert.ok(text.includes(checkout), 'it must name the tree it is running from');
});

test('update REFUSES from an unmanaged copy (a leftover npm global), naming install.sh', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  const npmish = path.join(paths.home, 'lib', 'node_modules', 'claude-web-chat');
  fs.mkdirSync(npmish, { recursive: true });
  fs.writeFileSync(path.join(npmish, 'package.json'), JSON.stringify({ version: '0.1.0' }));

  const d = deps({ describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: npmish, paths }) });
  let code = null;
  d.exit = (c) => { code = c; };
  const res = await update([], d);
  assert.equal(res.kind, 'unmanaged');
  assert.equal(code, 1);
  assert.match(d.errlog.text(), /install\.sh/);
  assert.match(d.errlog.text(), /npm/, 'the leftover-npm case should be named, since that is what it usually is');
});

test('a refusal never downloads anything', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  const checkout = path.join(paths.home, 'co');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  let fetched = false;
  const d = deps({
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: checkout, paths }),
    fetchLatestRelease: async () => { fetched = true; return null; },
  });
  d.exit = () => {};
  await update([], d);
  assert.equal(fetched, false, 'the guard must run before any network call');
});

// ── the happy path ──────────────────────────────────────────────────────────

test('update downloads, activates, relinks, prunes and restarts', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  let restartedWith = null;
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => {
      fakeVersion(paths, release.version);
      return { version: release.version, dir: versionDir };
    },
    restart: async (args) => { restartedWith = args; },
  });
  const res = await update([], d);

  assert.deepEqual(res, { before: '0.5.0', after: '0.6.0' });
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.6.0');
  assert.ok(fs.existsSync(paths.binLink('claude-web-chat')), 'the bins stay linked');
  assert.ok(restartedWith, 'the daemon must be restarted onto the new build');
  assert.match(d.log.text(), /Updated: v0\.5\.0 → v0\.6\.0/);
});

// cli-ops-2: the help text promises an update propagates the new release's
// rules, skills and hook template. It never did — reconcileManagedFiles and
// friends were required at module load from the tree this process started in
// (the version being REPLACED) and templatesDir() is __dirname-relative, so the
// reconcile compared the project against the OLD templates and reported every
// file up to date. No test asserted WHICH templates were used, which is why it
// survived. This one does, by making the target version's engine identifiable.
test("update syncs with the NEW version's engine, not the one it was launched from", async (t) => {
  withTempHome(t);
  const paths = installPaths();
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-upd-proj-')));
  fs.mkdirSync(path.join(project, '.web-chat'), { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(project);
  t.after(() => process.chdir(prevCwd));

  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => {
      const dir = fakeVersion(paths, release.version);
      // The new build's registration engine, identifiable by what it writes.
      fs.mkdirSync(path.join(dir, 'lib', 'setup'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib', 'setup', 'registration.js'),
        "const fs = require('fs');\nconst path = require('path');\n"
        + "module.exports.apply = (root) => {\n"
        + "  fs.mkdirSync(path.join(root, '.claude', 'rules'), { recursive: true });\n"
        + "  fs.writeFileSync(path.join(root, '.claude', 'rules', 'web-chat.md'), 'shipped by v0.6.0\\n');\n"
        + "  return { managed: [{ dest: '.claude/rules/web-chat.md', action: 'updated' }] };\n};\n");
      return { version: release.version, dir: versionDir };
    },
  });
  await update([], d);

  assert.equal(
    fs.readFileSync(path.join(project, '.claude', 'rules', 'web-chat.md'), 'utf8'),
    'shipped by v0.6.0\n',
    "the sync must come from versions/<target>, not the module graph this process booted with",
  );
});

// `update` now runs the engine's full apply(), which completes an unresolvable
// .mcp.json entry by shelling out to `claude mcp add … --scope local`. That
// writes Claude Code's own config, OUTSIDE this project — install's and doctor's
// job, sanctioned for them and for nobody else. An upgrade must not do it
// silently, so the shell-out is recorded and printed instead of run.
test('update prints the local-scope command instead of shelling out to `claude`', async (t) => {
  withTempHome(t);
  const paths = installPaths();
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-upd-stub-')));
  fs.mkdirSync(path.join(project, '.web-chat'), { recursive: true });
  // The dogfooding shape: a committed plugin stub that cannot resolve outside a
  // plugin install. D4 says preserve it and register at local scope.
  const stub = JSON.stringify({
    mcpServers: { 'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] } },
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(project, '.mcp.json'), stub);
  const prevCwd = process.cwd();
  process.chdir(project);
  const prevPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  t.after(() => {
    process.chdir(prevCwd);
    if (prevPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prevPluginRoot;
  });

  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    // No lib/setup/registration.js in the target, so the sync falls back to THIS
    // build's engine — the real one, whose apply() would otherwise shell out.
    fetchAndUnpack: async ({ release, versionDir }) => {
      fakeVersion(paths, release.version);
      return { version: release.version, dir: versionDir };
    },
  });
  await update([], d);

  assert.equal(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'), stub,
    'the committed plugin stub is preserved byte for byte');
  assert.match(d.log.text(), /run: claude mcp add web-chat --scope local --/,
    'the command is printed for the user to run deliberately, not executed mid-upgrade');
});

test('a target version with no registration engine falls back LOUDLY', async (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.4.0');   // predates the engine
  const errlog = sink();
  const mod = update.loadRegistration(paths, '0.4.0', errlog);
  assert.equal(typeof mod.apply, 'function', 'it still syncs, with this build');
  assert.match(errlog.text(), /ships no registration engine/);
  assert.match(errlog.text(), /THIS build's templates/,
    'the call site downgrades any failure to "sync skipped", so a silent fallback would be indistinguishable from success');
});

test('update does not downgrade when the latest release is older than this build', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.9.0');
  activate('0.9.0', paths);
  let unpacked = false;
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.9.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async () => { unpacked = true; },
  });
  const res = await update([], d);
  assert.equal(res.unchanged, true);
  assert.equal(unpacked, false);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.9.0', 'current must not move');
});

test('a failed download leaves the previous install exactly as it was', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  let restarted = false;
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async () => { throw new Error('checksum mismatch for claude-web-chat-0.6.0.tar.gz'); },
    restart: async () => { restarted = true; },
  });
  let code = null;
  d.exit = (c) => { code = c; };
  const res = await update([], d);

  assert.equal(res.failed, true);
  assert.equal(code, 1);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.5.0', 'current must not move on a failed update');
  assert.equal(restarted, false, 'nothing is restarted when nothing was installed');
  const text = d.errlog.text();
  assert.match(text, /checksum mismatch/);
  assert.match(text, /Nothing was changed/);
  assert.doesNotMatch(text, /at fetchAndUnpack/, 'a failed download is an outcome, not a stack trace');
});

// ── rollback ────────────────────────────────────────────────────────────────

test('--to rolls back to a version on disk without touching the network', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');
  activate('0.6.0', paths);
  linkBins(paths);

  let fetched = false;
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    fetchLatestRelease: async () => { fetched = true; return null; },
  });
  const res = await update(['--to', '0.5.0'], d);
  assert.equal(res.after, '0.5.0');
  assert.equal(fetched, false, 'rollback is a symlink swap — no download');
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.5.0');
});

test('--to a version that is not on disk fails with the list of what is', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
  });
  let code = null;
  d.exit = (c) => { code = c; };
  const res = await update(['--to', '9.9.9'], d);
  assert.equal(res.reason, 'unknown-version');
  assert.equal(code, 1);
  assert.match(d.errlog.text(), /v0\.5\.0/, 'it must say which versions are available');
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.5.0');
});

test('--list shows what is on disk and marks the current one', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');
  activate('0.6.0', paths);
  const d = deps({ paths, describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }) });
  const res = await update(['--list'], d);
  assert.deepEqual(res.listed, ['0.6.0', '0.5.0']);
  assert.match(d.log.text(), /v0\.6\.0\s+← current/);
});

test('parseArgs understands --to <v>, --to=<v>, a v prefix, --list and --force', () => {
  assert.equal(update.parseArgs(['--to', 'v0.4.2']).to, '0.4.2');
  assert.equal(update.parseArgs(['--to=0.4.2']).to, '0.4.2');
  assert.equal(update.parseArgs(['--list']).list, true);
  assert.equal(update.parseArgs(['--force']).force, true);
  assert.equal(update.parseArgs([]).to, null);
});

// ── the restart-from-the-new-build rule ─────────────────────────────────────

// This one is a regression test with a scar. `update` runs from the OLD version
// (the bin on PATH resolved through `current` at startup), and `restart` spawns
// the daemon from a path derived from its own module location. Loading restart
// through ~/.web-chat/current after flipping it LOOKS right and is not: Node
// caches realpath results per process, and `current` had already been resolved —
// to the old version — when the process started. The observed result was an
// update that reported success while restarting the daemon on the old code.
test('loadRestart loads the TARGET version\'s restart, never via the `current` symlink', (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');
  // `current` deliberately still points at the OLD version, the way it would if
  // anything resolved it before the swap.
  activate('0.5.0', paths);

  const fn = update.loadRestart(paths, '0.6.0');
  assert.equal(typeof fn, 'function');
  assert.equal(fn.version, '0.6.0', 'restart must come from versions/0.6.0, not from whatever `current` resolves to');
});

test('loadRestart falls back to this build\'s restart when the target has none', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const fn = update.loadRestart(paths, '9.9.9');
  assert.equal(fn, require('../lib/cli/commands/restart'), 'a missing module must degrade to the running build, not throw');
});

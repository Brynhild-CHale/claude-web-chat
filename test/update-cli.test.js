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

// A scratch cwd that IS a project — `update` restarts a daemon only there.
function inProjectCwd(t) {
  const dir = inScratchCwd(t);
  fs.mkdirSync(path.join(dir, '.web-chat'));
  return dir;
}

// A registration engine that syncs nothing, for tests about something else.
const NO_SYNC = { apply: () => ({ managed: [] }) };

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
  inProjectCwd(t);
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
    registration: NO_SYNC,
  });
  const res = await update([], d);

  assert.deepEqual(res, { before: '0.5.0', after: '0.6.0' });
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.6.0');
  assert.ok(fs.existsSync(paths.binLink('claude-web-chat')), 'the bins stay linked');
  assert.ok(restartedWith, 'the daemon must be restarted onto the new build');
  assert.match(d.log.text(), /Updated: v0\.5\.0 → v0\.6\.0/);
});

// distribution-3. Staging used to happen INSIDE versions/, so a download killed
// with Ctrl-C (nothing in the CLI handles SIGINT, so fetchAndUnpack's `finally`
// never runs) stranded a `wc-release-XXXXXX/` in the version list itself.
test('the download is staged beside the version store, never inside it', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);

  let stagedIn = null;
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir, tmpDir }) => {
      stagedIn = tmpDir;
      // What an interrupted download leaves behind, where it now leaves it.
      fs.mkdirSync(path.join(tmpDir, 'wc-release-Ab12Cd'), { recursive: true });
      fakeVersion(paths, release.version);
      return { version: release.version, dir: versionDir };
    },
  });
  await update([], d);

  assert.equal(stagedIn, paths.staging, 'staging is ~/.web-chat/staging — a sibling, so a rename into place is still same-filesystem');
  assert.ok(fs.existsSync(paths.staging), 'and the caller creates it');
  assert.deepEqual(listVersions(paths).sort(), ['0.5.0', '0.6.0'], 'debris cannot appear in the version list');
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

// The same fallback, in the other direction. `update --to <older>` is a
// deliberate rollback, so "this build's templates, which may be older" is not
// merely a wrong sentence: this build's templates are NEWER than the version
// just activated, and running its apply() syncs the project FORWARD to files
// the build now on `current` does not ship.
test('a ROLLBACK to a version with no registration engine syncs nothing', async (t) => {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, '0.4.0');   // predates the engine
  const errlog = sink();
  const mod = update.loadRegistration(paths, '0.4.0', errlog, { from: '0.6.0' });
  assert.equal(mod, null, 'there is nothing right to sync with going backwards');
  assert.match(errlog.text(), /ships no registration engine/);
  assert.match(errlog.text(), /NEWER than v0\.4\.0/);
  assert.doesNotMatch(errlog.text(), /which may be older/, 'the forward wording must not be printed on a rollback');
});

test('--to an older build leaves the project\'s managed files where they are', async (t) => {
  withTempHome(t);
  const paths = installPaths();
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-upd-back-')));
  fs.mkdirSync(path.join(project, '.web-chat'), { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(project);
  t.after(() => process.chdir(prevCwd));

  fakeVersion(paths, '0.4.0');   // predates the engine
  fakeVersion(paths, '0.6.0');
  activate('0.6.0', paths);
  linkBins(paths);

  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    fetchLatestRelease: async () => { throw new Error('a rollback must not touch the network'); },
  });
  const res = await update(['--to', '0.4.0'], d);

  assert.equal(res.after, '0.4.0');
  assert.equal(fs.existsSync(path.join(project, '.claude')), false,
    "this build's rules and skills must not be written into a project rolled back to v0.4.0");
  assert.match(d.log.text(), /Managed files left alone/);
  assert.match(d.log.text(), /claude-web-chat install/, 'and the way to sync with v0.4.0 templates is named');
  assert.doesNotMatch(d.log.text(), /Syncing managed files/, 'no heading over a sync that did not happen');
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

// ── a running tunnel portal is restarted onto the new build ─────────────────
//
// A portal keeps enforcing the remote policy of the build it was started from.
// `update` used to leave it running and ask, in the docs, for a `tunnel up`
// afterwards; now it restarts a running one itself — with `tunnel up`'s own
// bounce, loaded from the TARGET build (for loadRestart's reason: `portal run`
// is spawned from the package root of the module that spawns it).

// A target build whose tunnel command is the real one, marked so a test can tell
// which build's copy ran, and able to hand the real bounce a stand-in `kill`.
function shimTunnel(dir, version) {
  const real = path.join(__dirname, '..', 'lib', 'cli', 'commands', 'tunnel.js');
  fs.writeFileSync(path.join(dir, 'lib', 'cli', 'commands', 'tunnel.js'),
    `const real = require(${JSON.stringify(real)});\n`
    + 'module.exports = Object.assign((...a) => real(...a), real, {\n'
    + '  restartPortal: (o) => {\n'
    + `    (globalThis.__wcPortalRestarts ||= []).push({ version: '${version}', port: o.env.WEB_CHAT_PORTAL_PORT });\n`
    + '    return real.restartPortal({ ...o, kill: globalThis.__wcPortalKill, waitMs: 15000 });\n'
    + '  },\n'
    + '});\n');
}

test('update restarts a running tunnel portal on the NEW build, and says viewers will reconnect', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const http = require('http');
  const { userPaths } = require('../lib/core/paths');
  const { PORTAL_PROTOCOL_VERSION } = require('../lib/core/versions');
  const { configFingerprint, normalizeConfig } = require('../lib/tunnel/config');
  const { registerRole, deregisterRole } = require('../lib/util/registry');
  const { isPidAlive } = require('../lib/core/portfiles');
  const { freePort, fakeCloudflared } = require('../test-support/helpers');
  const { createFakeAccess } = require('../test-support/fake-access');
  const tunnel = require('../lib/cli/commands/tunnel');

  fakeCloudflared(t);
  const raw = createFakeAccess().config({ tunnel: { kind: 'token', metricsPort: await freePort() } });
  fs.mkdirSync(userPaths().tunnelDir, { recursive: true });
  fs.writeFileSync(userPaths().tunnelConfig, JSON.stringify(raw));
  fs.writeFileSync(userPaths().tunnelToken, 'connector-token\n', { mode: 0o600 });

  // The running portal: CURRENT by every measure `tunnel up` checks (protocol,
  // config fingerprint), so only the update's forced bounce can restart it.
  const port = await freePort();
  const old = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, role: 'portal', pid: 424242, portal_protocol: PORTAL_PROTOCOL_VERSION, config_fp: configFingerprint(normalizeConfig(raw)) }));
  });
  await new Promise((r) => old.listen(port, '127.0.0.1', r));
  registerRole('portal', { port, pid: process.pid });
  const killed = [];
  globalThis.__wcPortalKill = (pid, sig) => { killed.push([pid, sig]); old.close(); old.closeAllConnections(); };
  globalThis.__wcPortalRestarts = [];
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, '..', 'test-support', 'no-outbound.js'))}` };
  delete env.WEB_CHAT_HOST;
  delete env.WEB_CHAT_PORTAL_PORT;

  let res = null;
  t.after(async () => {
    try { old.close(); old.closeAllConnections(); } catch {}
    try { await tunnel(['down'], { log: () => {}, env: { ...env, WEB_CHAT_PORTAL_PORT: String(port) } }); } catch {}
    const pid = res && res.portal && res.portal.pid;
    if (pid && isPidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    deregisterRole('portal', {});
    delete globalThis.__wcPortalKill;
    delete globalThis.__wcPortalRestarts;
  });

  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);
  const d = deps({
    paths,
    env,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => {
      shimTunnel(fakeVersion(paths, release.version), release.version);
      return { version: release.version, dir: versionDir };
    },
  });
  res = await update([], d);

  assert.equal(res.after, '0.6.0', 'the update itself is unchanged');
  assert.deepEqual(globalThis.__wcPortalRestarts, [{ version: '0.6.0', port: String(port) }],
    "the bounce is the TARGET build's, on the port the portal is registered on");
  assert.deepEqual(killed, [[424242, 'SIGTERM']], 'the running portal, by the pid its health reported, once');
  assert.equal(res.portal.restarted, true);
  assert.notEqual(res.portal.pid, 424242);
  const { probeHealth } = require('../lib/client');
  const now = await probeHealth(port);
  assert.equal(now && now.role, 'portal', 'a portal answers on the same port');
  assert.equal(now.pid, res.portal.pid);
  assert.match(d.log.text(), new RegExp(`Restarted the tunnel portal on v0\\.6\\.0 \\(pid 424242 → ${res.portal.pid}\\).*remote viewers will reconnect`));
  assert.equal(d.errlog.text(), '');
});

test('update leaves the tunnel alone when no portal is running', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);
  let called = false;
  const d = deps({
    paths,
    restartPortal: async () => { called = true; return { restarted: true, before: { pid: 1 }, health: { pid: 2 } }; },
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => { fakeVersion(paths, release.version); return { version: release.version, dir: versionDir }; },
  });
  const res = await update([], d);
  assert.deepEqual(res, { before: '0.5.0', after: '0.6.0' });
  assert.equal(called, false, 'no registered portal, no restart');
  assert.doesNotMatch(d.log.text() + d.errlog.text(), /portal/);
});

test('a failed portal restart is reported with `tunnel up`, and the update still succeeds', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const { freePort } = require('../test-support/helpers');
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);
  const port = await freePort();   // nothing answers here any more
  const d = deps({
    paths,
    readPortal: () => ({ role: 'portal', pid: 4242, port }),
    restartPortal: async () => { throw Object.assign(new Error('no connector token in ~/.web-chat/tunnel/token'), { userFacing: true }); },
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => { fakeVersion(paths, release.version); return { version: release.version, dir: versionDir }; },
  });
  const res = await update([], d);   // deps.exit throws: an exit here fails the test
  assert.equal(res.after, '0.6.0');
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.6.0', 'the new build stays activated');
  assert.deepEqual(res.portal, { restarted: false, error: 'no connector token in ~/.web-chat/tunnel/token' });
  const text = d.errlog.text();
  assert.match(text, /Could not restart the tunnel portal \(pid 4242\) on v0\.6\.0: no connector token/);
  assert.match(text, /Remote access is down until the portal is started again/);
  assert.match(text, /The update itself succeeded\. To restart it: claude-web-chat tunnel up/);
  assert.match(d.log.text(), /Updated: v0\.5\.0 → v0\.6\.0/);
});

test('a failed portal restart that left the old portal up says it is still on the previous build', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const http = require('http');
  const { freePort } = require('../test-support/helpers');
  const port = await freePort();
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"role":"portal","pid":4242}'); });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);
  const d = deps({
    paths,
    readPortal: () => ({ role: 'portal', pid: 4242, port }),
    restartPortal: async () => { throw new Error('cloudflared is not on PATH'); },
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => { fakeVersion(paths, release.version); return { version: release.version, dir: versionDir }; },
  });
  const res = await update([], d);
  assert.equal(res.after, '0.6.0');
  assert.equal(res.portal.restarted, false);
  const text = d.errlog.text();
  assert.match(text, /on v0\.6\.0: cloudflared is not on PATH/);
  assert.match(text, /still running, on the previous build's code and remote policy/);
  assert.match(text, /claude-web-chat tunnel up/);
});

// upgrade-rollback-leaves-portal-unmanageable. A rollback to a build with no
// tunnel command used to leave the portal up — on the NEWER build's code,
// starting newer daemons on request — and advise `tunnel up`, which the build
// just activated does not have. Now this build's `tunnel down` stops it BEFORE
// the flip, and nothing names a command the target lacks.
test('a rollback to a build with no tunnel command stops the portal first, with THIS build\'s tunnel down', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');
  activate('0.6.0', paths);
  linkBins(paths);
  const downs = [];
  const d = deps({
    paths,
    readPortal: () => ({ role: 'portal', pid: 4242, port: 45678 }),
    tunnelDown: async (o) => { downs.push({ current: fs.readlinkSync(paths.current), port: o.env.WEB_CHAT_PORTAL_PORT }); return { stopped: true }; },
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
  });
  const res = await update(['--to', '0.5.0'], d);
  assert.equal(res.after, '0.5.0');
  assert.deepEqual(downs, [{ current: 'versions/0.6.0', port: '45678' }], 'stopped once, before the flip, on the registered port');
  assert.deepEqual(res.portal, { restarted: false, stopped: true });
  const out = d.log.text();
  assert.match(out, /Stopped the tunnel portal \(pid 4242\): v0\.5\.0 has no tunnel command to run it with, so remote access is off/);
  assert.match(out, /back on a build that has one \(`claude-web-chat update`\)/);
  assert.doesNotMatch(out + d.errlog.text(), /tunnel up/, 'never a command v0.5.0 does not have');
});

test('a rollback whose portal cannot be stopped changes nothing', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');
  activate('0.6.0', paths);
  linkBins(paths);
  let code = null;
  const d = deps({
    paths,
    readPortal: () => ({ role: 'portal', pid: 4242, port: 45678 }),
    tunnelDown: async () => { throw new Error('the portal (pid 4242) is still answering'); },
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
  });
  d.exit = (c) => { code = c; };
  const res = await update(['--to', '0.5.0'], d);
  assert.equal(res.refused, true);
  assert.equal(code, 1);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.6.0', 'still on the build that can stop it');
  assert.match(d.errlog.text(), /Nothing was changed\. Stop it with `claude-web-chat tunnel down`, then run this again/);
});

test('--to restarts a running portal as well', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');
  activate('0.6.0', paths);
  linkBins(paths);
  const seen = [];
  const d = deps({
    paths,
    env: { WEB_CHAT_PORTAL_PORT: '1' },
    readPortal: () => ({ role: 'portal', pid: 11, port: 45678 }),
    restartPortal: async (o) => { seen.push(o.env.WEB_CHAT_PORTAL_PORT); return { restarted: true, before: { pid: 11 }, health: { pid: 22 } }; },
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
  });
  const res = await update(['--to', '0.5.0'], d);
  assert.deepEqual(res.portal, { restarted: true, pid: 22 });
  assert.deepEqual(seen, ['45678'], 'the registered port wins over whatever the environment says');
  assert.match(d.log.text(), /Restarted the tunnel portal on v0\.5\.0 \(pid 11 → 22\)/);
});

test("loadPortalRestart takes the target's restartPortal, a pre-restartPortal build's down + up, or nothing", async (t) => {
  withTempHome(t);
  const paths = installPaths();
  // Current shape: the exported bounce, from versions/<target>.
  const cur = fakeVersion(paths, '0.8.0');
  fs.writeFileSync(path.join(cur, 'lib', 'cli', 'commands', 'tunnel.js'),
    "module.exports = async () => {};\nmodule.exports.restartPortal = async () => ({ restarted: true, from: '0.8.0' });\n");
  assert.deepEqual(await update.loadPortalRestart(paths, '0.8.0')({ env: {} }), { restarted: true, from: '0.8.0' });

  // An older build: only the tunnel command. Its own down, then its own up.
  const older = fakeVersion(paths, '0.7.9');
  fs.writeFileSync(path.join(older, 'lib', 'cli', 'commands', 'tunnel.js'),
    'module.exports = async (args, o) => { (globalThis.__wcTunnelCalls ||= []).push([args[0], o.env.WEB_CHAT_PORTAL_PORT]);\n'
    + "  return args[0] === 'down' ? { stopped: true, health: { pid: 1 } } : { already: false, health: { pid: 2 } }; };\n");
  t.after(() => { delete globalThis.__wcTunnelCalls; });
  const r = await update.loadPortalRestart(paths, '0.7.9')({ env: { WEB_CHAT_PORTAL_PORT: '5999' } });
  assert.deepEqual(r, { restarted: true, before: { pid: 1 }, health: { pid: 2 } });
  assert.deepEqual(globalThis.__wcTunnelCalls, [['down', '5999'], ['up', '5999']]);

  // No tunnel command at all: never this build's copy instead.
  fakeVersion(paths, '0.4.0');
  assert.equal(update.loadPortalRestart(paths, '0.4.0'), null);
});

// ── the builtin theme's per-user folder is seeded by the NEW build ──────────
// (lib/setup/theme-logos.js — made at install and update, never lazily.) Like
// the restart, the target build's copy decides it: a shim in versions/<v>
// requires the real module and records which build ran.
test('update seeds the per-user theme folders with the TARGET build\'s module; a target without one seeds nothing', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const { userPaths } = require('../lib/core/paths');
  const real = path.join(__dirname, '..', 'lib', 'setup', 'theme-logos.js');
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);
  const folder = userPaths().themeLogosDir('georgetown-blue');

  const run = (version, shim) => update([], deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: `v${version}`, version, assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => {
      const dir = fakeVersion(paths, release.version);
      if (shim) {
        fs.mkdirSync(path.join(dir, 'lib', 'setup'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'lib', 'setup', 'theme-logos.js'),
          `const real = require(${JSON.stringify(real)});\n`
          + `module.exports = { ...real, seedThemeLogos: () => { (globalThis.__wcSeeded ||= []).push('${version}'); real.seedThemeLogos(); } };\n`);
      }
      return { version: release.version, dir: versionDir };
    },
  }));

  await run('0.5.5', false);
  assert.equal(fs.existsSync(folder), false, 'a target with no module: nothing (and no fallback to this build)');
  assert.equal(update.loadThemeLogos(paths, '0.5.5'), null);

  const d = await run('0.6.0', true);
  assert.deepEqual(d, { before: '0.5.0', after: '0.6.0' });
  assert.deepEqual(globalThis.__wcSeeded, ['0.6.0'], 'the target build\'s copy ran');
  assert.deepEqual(fs.readdirSync(folder), ['README.txt']);
});

// ── outside a project, and the projects an update does not restart ──────────

function upgradeDeps(paths, extra = {}) {
  return deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => { fakeVersion(paths, release.version); return { version: release.version, dir: versionDir }; },
    readInstances: () => [],
    ...extra,
  });
}

function onVersion(t, v = '0.5.0') {
  withTempHome(t);
  const paths = installPaths();
  fakeVersion(paths, v);
  activate(v, paths);
  linkBins(paths);
  return paths;
}

// upgrade-update-outside-project-remembers-cwd: `update` typed in ~ or
// ~/Downloads restarted "the daemon" anyway — booting one rooted there.
test('update outside a project restarts nothing, and says so', async (t) => {
  const paths = onVersion(t);
  const dir = inScratchCwd(t);
  let restarted = 0;
  const d = upgradeDeps(paths, { restart: async () => { restarted++; } });
  const res = await update([], d);
  assert.equal(res.after, '0.6.0');
  assert.equal(restarted, 0);
  assert.ok(d.log.text().includes(`No web-chat project here (${dir}) — no server restarted here.`));
  assert.doesNotMatch(d.log.text(), /Restarting bg server/);
});

// upgrade-stale-daemons-other-projects.
test('update lists the other projects still running an older build, with the command for each', async (t) => {
  const paths = onVersion(t);
  inProjectCwd(t);
  const d = upgradeDeps(paths, {
    registration: NO_SYNC,
    readInstances: () => [
      { root: '/p/old', port: 1, url: 'http://localhost:1' },
      { root: '/p/current', port: 2, url: 'http://localhost:2' },
      { root: '/p/silent', port: 3 },
    ],
    runningBuild: async (port) => ({ 1: '0.5.0', 2: '0.6.0', 3: null })[port],
  });
  const res = await update([], d);
  assert.deepEqual(res.others, { stale: ['/p/old'], restarted: [] }, 'the current build and an unknown one are not listed');
  const out = d.log.text();
  assert.match(out, /1 other project\(s\) still run a different build/);
  assert.match(out, /\/p\/old {2}\(v0\.5\.0, not v0\.6\.0\) {2}http:\/\/localhost:1/);
  assert.match(out, /cd <project> && claude-web-chat restart/);
  assert.match(out, /claude-web-chat update --restart-all/);
});

test('update --restart-all restarts each on the new build, one at a time, from its own directory, and sums up', async (t) => {
  const paths = onVersion(t);
  const here = inProjectCwd(t);
  const a = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-other-a-')));
  const b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-other-b-')));
  const calls = [];
  const d = upgradeDeps(paths, {
    registration: NO_SYNC,
    readInstances: () => [{ root: a, port: 1 }, { root: b, port: 2 }, { root: here, port: 3 }],
    runningBuild: async (port) => (port === 3 ? '0.6.0' : '0.5.0'),
    restart: async (args, o = {}) => { calls.push([process.cwd(), o.root || null]); return o.root === b ? { ok: false } : { ok: true }; },
  });
  const res = await update(['--restart-all'], d);
  assert.deepEqual(calls, [[here, null], [a, a], [b, b]], 'this project first, then each other one from inside it');
  assert.equal(process.cwd(), here, 'and back where it started');
  assert.deepEqual(res.others, { stale: [a, b], restarted: [a], failed: [b] });
  const out = d.log.text();
  assert.match(out, /Restarting 2 project\(s\) on v0\.6\.0, one at a time/);
  assert.ok(out.includes(`✓ ${a}  v0.5.0 → v0.6.0`));
  assert.ok(out.includes(`✗ ${b}  v0.5.0 → v0.6.0  (the old daemon did not stop)`));
  assert.match(out, /Restarted 1 of 2\. For the rest: cd <project> && claude-web-chat restart/);
});

// The 0.7.6 updater performs the hop to 0.8 and knows nothing of other
// projects — so on the new build, with nothing left to install, the flag
// still does its job.
test('update --restart-all when already up to date still restarts the stale projects', async (t) => {
  const paths = onVersion(t, '0.6.0');
  inScratchCwd(t);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-other-')));
  const calls = [];
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    readInstances: () => [{ root: other, port: 1 }],
    runningBuild: async () => '0.5.0',
    restart: async (args, o) => { calls.push(o.root); return { ok: true }; },
  });
  const res = await update(['--restart-all'], d);
  assert.equal(res.unchanged, true);
  assert.deepEqual(calls, [other]);
  assert.deepEqual(res.others.restarted, [other]);
});

test('a rollback lists stale projects but never offers --restart-all, which the older build may not have', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, '0.5.0');
  fakeVersion(paths, '0.6.0');
  activate('0.6.0', paths);
  linkBins(paths);
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    readInstances: () => [{ root: '/p/new', port: 1 }],
    runningBuild: async () => '0.6.0',
  });
  const res = await update(['--to', '0.5.0'], d);
  assert.deepEqual(res.others.stale, ['/p/new']);
  const out = d.log.text();
  assert.match(out, /cd <project> && claude-web-chat restart/);
  assert.doesNotMatch(out, /--restart-all/);
  // Direction-aware (R2-5): the others run the NEWER build here, and the flip
  // is a rollback — neither is to be called what it is not.
  assert.match(out, /Rolling back to v0\.5\.0/);
  assert.match(out, /Rolled back: v0\.6\.0 → v0\.5\.0\./);
  assert.doesNotMatch(out, /Updated: v0\.6\.0/);
  assert.match(out, /1 other project\(s\) still run a different build/);
  assert.match(out, /\/p\/new {2}\(v0\.6\.0, not v0\.5\.0\)/);
  assert.doesNotMatch(out, /older build/);
});

// R2-2. Only a 404 comes back from the release lookup as null; an offline
// machine, a proxy or GitHub's rate limit THROWS — and that used to print a raw
// stack and exit before `--restart-all` (a purely local operation) ever ran.
test('update with GitHub unreachable says so in one line, no stack, and installs nothing', async (t) => {
  const paths = onVersion(t, '0.6.0');
  inScratchCwd(t);
  let code = null;
  let unpacked = false;
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    fetchLatestRelease: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9'); },
    fetchAndUnpack: async () => { unpacked = true; },
    readInstances: () => [{ root: '/p/other', port: 1 }],
    runningBuild: async () => '0.5.0',
    restart: async () => { throw new Error('nothing may be restarted without --restart-all'); },
  });
  d.exit = (c) => { code = c; };
  const res = await update([], d);
  assert.deepEqual(res, { refused: true, reason: 'unreachable', error: 'connect ECONNREFUSED 127.0.0.1:9' });
  assert.equal(code, 1);
  assert.equal(unpacked, false);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.6.0', 'current must not move');
  const err = d.errlog.text();
  assert.equal(err, 'GitHub unreachable: connect ECONNREFUSED 127.0.0.1:9. Nothing to install.');
  assert.doesNotMatch(err + d.log.text(), /\n\s+at /, 'an unreachable GitHub is an outcome, not a stack trace');
});

test('update --restart-all still restarts the stale projects when GitHub is unreachable', async (t) => {
  const paths = onVersion(t, '0.6.0');
  inScratchCwd(t);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-other-')));
  const calls = [];
  let code = null;
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    fetchLatestRelease: async () => { throw Object.assign(new Error('github returned 403 for https://api.github.com/x'), { statusCode: 403 }); },
    readInstances: () => [{ root: other, port: 1 }],
    runningBuild: async () => '0.5.0',
    restart: async (args, o) => { calls.push(o.root); return { ok: true }; },
  });
  d.exit = (c) => { code = c; };
  const res = await update(['--restart-all'], d);
  assert.deepEqual(calls, [other], 'the local restart never depends on GitHub');
  assert.deepEqual(res.others, { stale: [other], restarted: [other], failed: [] });
  assert.equal(res.reason, 'unreachable');
  assert.equal(code, 1, 'the update check itself still failed, and the exit code says so');
  assert.match(d.errlog.text(), /^GitHub unreachable: github returned 403 .*\. Nothing to install\.$/);
  assert.ok(d.log.text().includes(`✓ ${other}  v0.5.0 → v0.6.0`));
});

test('update with no published release says so, and --restart-all still runs', async (t) => {
  const paths = onVersion(t, '0.6.0');
  inScratchCwd(t);
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-other-')));
  const calls = [];
  const d = deps({
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    fetchLatestRelease: async () => null,
    readInstances: () => [{ root: other, port: 1 }],
    runningBuild: async () => '0.5.0',
    restart: async (args, o) => { calls.push(o.root); return { ok: true }; },
  });
  d.exit = () => {};
  const res = await update(['--restart-all'], d);
  assert.equal(res.reason, 'no-release');
  assert.deepEqual(calls, [other]);
  assert.equal(d.errlog.text(), 'No published release found on GitHub. Nothing to install.');
});

test('parseArgs knows --restart-all', () => {
  assert.equal(update.parseArgs(['--restart-all']).restartAll, true);
  assert.equal(update.parseArgs([]).restartAll, false);
});

// ── the line an update ends on ──────────────────────────────────────────────
// H-1. An update restarts the daemon, never Claude Code, and every open
// session keeps the MCP server — and the tool list — it started with. So a
// successful update ends by saying so, once.

const CLAUDE_LINE = /^Restart Claude Code to pick up v(\S+): \/exit and reopen it — each open session keeps the MCP server it started with\.$/;
const lastLine = (log) => log.text().split('\n').filter(Boolean).pop();

test('a successful update ends by telling the user to /exit and reopen Claude Code — in a project or not, forward or back', async (t) => {
  const paths = onVersion(t);
  inProjectCwd(t);
  const d = upgradeDeps(paths, { registration: NO_SYNC, restart: async () => ({ ok: true, stopped: {}, started: true }) });
  await update([], d);
  assert.match(lastLine(d.log), CLAUDE_LINE);
  assert.equal(lastLine(d.log).match(CLAUDE_LINE)[1], '0.6.0');
  assert.equal(d.log.text().split('\n').filter((l) => CLAUDE_LINE.test(l)).length, 1, 'said once');

  inScratchCwd(t);
  const outside = upgradeDeps(paths, { restart: async () => { throw new Error('nothing is restarted outside a project'); } });
  outside.describeInstall = () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths });
  const back = await update(['--to', '0.5.0'], outside);
  assert.equal(back.after, '0.5.0');
  assert.match(lastLine(outside.log), /^Restart Claude Code to pick up v0\.5\.0: /, 'a rollback changes the tools just as much');
});

test('a reinstall of the same build does not ask for a Claude Code restart', async (t) => {
  const paths = onVersion(t, '0.6.0');
  inScratchCwd(t);
  const d = upgradeDeps(paths, {
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.6.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ versionDir }) => ({ version: '0.6.0', dir: versionDir }),
  });
  const res = await update(['--force'], d);
  assert.deepEqual(res, { before: '0.6.0', after: '0.6.0' });
  assert.match(d.log.text(), /Reinstalled v0\.6\.0\./);
  assert.doesNotMatch(d.log.text(), /Restart Claude Code/);
});

// The target's restart prints the hop checklist when the server it replaced
// was a pre-0.8 build — its own Claude Code line included. Driven with the real
// restart (only its `start` stubbed) against a stand-in pre-0.8 daemon that
// owns this project's portfile and acknowledges the shutdown by dropping it.
test('when the restart printed the hop checklist, update does not repeat its Claude Code line', async (t) => {
  const http = require('http');
  const portfiles = require('../lib/core/portfiles');
  const realRestart = require('../lib/cli/commands/restart');
  const paths = onVersion(t);
  const root = inProjectCwd(t);
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/health') return res.end(JSON.stringify({ ok: true, role: 'instance', version: 3, pid: process.pid }));
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      portfiles.deletePortfile('server', { root, pid: process.pid });
      return res.end(JSON.stringify({ ok: true, shutting_down: true }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.close(); srv.closeAllConnections(); portfiles.deletePortfile('server', { root, pid: process.pid }); });
  portfiles.writePortfile('server', { root, pid: process.pid, port: srv.address().port });

  const d = upgradeDeps(paths, { registration: NO_SYNC });
  d.restart = (args) => realRestart(args, { log: d.log, start: async () => {} });
  await update([], d);
  const text = d.log.text();
  assert.match(text, /The server here was on a build older than 0\.8; it now runs v\S+\. To finish the upgrade:/);
  assert.match(text, /\/exit and reopen Claude Code/, 'the checklist says it');
  assert.doesNotMatch(text, /Restart Claude Code to pick up/, 'and update does not say it again');
});

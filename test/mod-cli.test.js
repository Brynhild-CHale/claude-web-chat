// `claude-web-chat mod on|off|status`, the registration engine's mod section
// (lib/setup/registration: inspectMod / applyMod / removeMod, apply()'s mod
// cell, remove()'s step 5) and the commands that carry the default (ruling
// C1 (b): `install` switches the mod on wherever Claude Code can run it;
// `mod off` is remembered; `update` prints the command and never runs it;
// `uninstall` takes it off — C2 (a)).
//
// No test runs `claude`: every one injects a runClaude that records argv and
// cwd and answers as Claude Code would. Each test has its own HOME and its own
// CLAUDE_CONFIG_DIR, and checks that nothing under them — and nothing in the
// project outside .web-chat/mod/ — is written by web-chat itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const reg = require('../lib/setup/registration');
const mod = require('../lib/cli/commands/mod');
const init = require('../lib/cli/commands/init');
const update = require('../lib/cli/commands/update');
const { projectPaths, claudePaths, userClaudePaths, installPaths } = require('../lib/core/paths');
const { packageVersion } = require('../lib/core/versions');
const { activate, linkBins } = require('../lib/update/install-layout');
const { withTempHome } = require('../test-support/helpers');

// install pre-warms a daemon through spawnDaemon, which it destructures at
// load: patch it out first, so no test forks a background server.
const daemonMod = require('../lib/util/daemon');
const realSpawnDaemon = daemonMod.spawnDaemon;
daemonMod.spawnDaemon = async () => null;
const install = require('../lib/cli/commands/install');
daemonMod.spawnDaemon = realSpawnDaemon;

const TPL = path.join(__dirname, '..', 'templates', 'claude-mod');
const VERSION = packageVersion();

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function isolate(t) {
  withTempHome(t);
  const cfg = tmp(t, 'wc-modcli-cfg-');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; });
  return cfg;
}

function project(t) {
  const root = tmp(t, 'wc-modcli-proj-');
  fs.mkdirSync(path.join(root, '.web-chat'));
  return root;
}

const hex8 = (root) => crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 8);

// Claude Code as the mod's commands meet it. `version: null` is no `claude`.
function fakeClaude({ version = '2.1.296', validate = true, testHelp = true } = {}) {
  const calls = [];
  const fn = (argv, { cwd } = {}) => {
    calls.push({ argv, cwd });
    if (version === null) return { ok: false, notFound: true, stderr: 'claude not found' };
    if (argv[0] === '--version') return { ok: true, stdout: `${version} (Claude Code)\n` };
    if (argv[0] === 'plugin' && argv[1] === 'validate') {
      return validate ? { ok: true, stdout: 'Validation passed\n' } : { ok: false, stderr: 'hooks/register.js: $.fs.nope is not a call on $\nand more' };
    }
    if (argv[0] === 'plugin' && argv[1] === 'test') return testHelp ? { ok: true, stdout: 'Usage: claude plugin test\n' } : { ok: false, stderr: "error: unknown command 'test'" };
    if (argv[0] === 'plugin') return { ok: true, stdout: 'Done\n{"ok":true}\n' };
    if (argv[0] === 'mcp') return { ok: true, stdout: '' };
    return { ok: false, stderr: `fake claude: ${argv.join(' ')} is not played here` };
  };
  return { fn, calls, argvs: () => calls.map((c) => c.argv), plugin: () => calls.filter((c) => c.argv[0] === 'plugin' || c.argv[0] === '--version').map((c) => c.argv) };
}

function sink() {
  const lines = [];
  const fn = (m = '') => lines.push(String(m));
  fn.text = () => lines.join('\n');
  return fn;
}

async function printed(fn) {
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let out;
  try { out = await fn(); } finally { console.log = prev; }
  return { out, text: lines.join('\n') };
}

// Every file under `dir` (but `skip`), with a hash of its bytes.
function snapshot(dir, skip = []) {
  const out = {};
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (skip.some((s) => p === s || p.startsWith(s + path.sep))) continue;
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const noDaemon = async () => null;
const noGet = async () => { throw new Error('no daemon call expected'); };

// ── mod on ──────────────────────────────────────────────────────────────────

test('mod on: the probe, then the project\'s own marketplace and the plugin at local scope, each from the root', async (t) => {
  isolate(t);
  const root = project(t);
  const claude = fakeClaude();
  const log = sink();
  const r = await mod(['on'], { cwd: root, runClaude: claude.fn, log });
  const name = `web-chat-mod-${hex8(root)}`;
  const mp = reg.modPaths(root);
  assert.equal(r.ok, true);
  assert.deepEqual(claude.argvs(), [
    ['--version'],
    ['plugin', 'validate', mp.plugin],
    ['plugin', 'test', '--help'],
    ['plugin', 'marketplace', 'add', mp.pkg, '--scope', 'local', '--json'],
    ['plugin', 'install', `web-chat-mod@${name}`, '--scope', 'local', '--json'],
  ]);
  assert.ok(claude.calls.every((c) => c.cwd === root), 'from the root: the local scope keys on it');
  assert.equal(reg.modMarketplaceName(root), name);
  assert.match(log.text(), new RegExp(`mod on for ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: restart Claude Code here to load it \\(a running session does not pick it up\\)`));

  // The staged tree is the template, stamped, beside the generated marketplace.
  assert.deepEqual(listTree(mp.plugin), listTree(TPL));
  const manifest = JSON.parse(fs.readFileSync(path.join(mp.plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  const tplManifest = JSON.parse(fs.readFileSync(path.join(TPL, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest, { ...tplManifest, version: VERSION });
  assert.equal(fs.readFileSync(path.join(mp.plugin, 'hooks', 'hooks.json'), 'utf8'), fs.readFileSync(path.join(TPL, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(mp.plugin, 'hooks', 'register.js'), 'utf8'),
    fs.readFileSync(path.join(TPL, 'hooks', 'register.js'), 'utf8').replace("const MOD_VERSION = '0.0.0-template';", `const MOD_VERSION = '${VERSION}';`));
  assert.deepEqual(JSON.parse(fs.readFileSync(mp.marketplace, 'utf8')), {
    name, owner: { name: 'web-chat' },
    plugins: [{ name: 'web-chat-mod', source: './web-chat-mod', description: tplManifest.description }],
  });
  const rec = JSON.parse(fs.readFileSync(mp.installed, 'utf8'));
  assert.equal(rec.version, VERSION);
  assert.equal(rec.marketplace, name);
  assert.equal(rec.plugin_id, `web-chat-mod@${name}`);
  assert.equal(rec.cc_version, '2.1.296');
  assert.ok(!Number.isNaN(Date.parse(rec.at)));
});

test('mod on again at the same version does nothing and says so; a newer web-chat re-stages and updates', async (t) => {
  isolate(t);
  const root = project(t);
  await mod(['on'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  const again = fakeClaude();
  const log = sink();
  const r = await mod(['on'], { cwd: root, runClaude: again.fn, log });
  assert.equal(r.changed, 'none');
  assert.deepEqual(again.argvs(), [], 'no install, nothing run');
  assert.match(log.text(), /mod already on for .*: nothing to do/);

  const newer = fakeClaude();
  const name = reg.modMarketplaceName(root);
  const u = reg.applyMod(root, { runClaude: newer.fn, packageVersion: '99.0.0' });
  assert.equal(u.state, 'on');
  assert.equal(u.changed, 'updated');
  assert.deepEqual(newer.argvs(), [
    ['--version'],
    ['plugin', 'validate', reg.modPaths(root).plugin],
    ['plugin', 'test', '--help'],
    ['plugin', 'marketplace', 'update', name, '--json'],
    ['plugin', 'update', `web-chat-mod@${name}`, '--scope', 'local'],
  ]);
  assert.equal(reg.inspectMod(root).staged_version, '99.0.0');
  assert.equal(reg.inspectMod(root).version, '99.0.0');
});

test('mod on below 2.1.287 says mod unavailable and installs nothing', async (t) => {
  isolate(t);
  const root = project(t);
  const claude = fakeClaude({ version: '2.1.286' });
  const log = sink();
  const prev = process.exitCode;
  const r = await mod(['on'], { cwd: root, runClaude: claude.fn, log });
  process.exitCode = prev;
  assert.equal(r.exitCode, 1);
  assert.equal(log.text(), 'mod unavailable: Claude Code 2.1.286 is older than 2.1.287 — web-chat works without it');
  assert.deepEqual(claude.argvs(), [['--version']]);
  assert.equal(fs.existsSync(projectPaths(root).modDir), false, 'nothing written for the mod');
});

test('mod on with hooks turned off (in any settings file) says mod unavailable and installs nothing', async (t) => {
  const cfg = isolate(t);
  for (const [where, file, key] of [
    ['the project settings', (root) => claudePaths(root).settings, 'disableAllHooks'],
    ['the local settings', (root) => claudePaths(root).settingsLocal, 'allowManagedHooksOnly'],
    ['the user settings', () => userClaudePaths().claudeSettings, 'disableAllHooks'],
  ]) {
    const root = project(t);
    const f = file(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ [key]: true }));
    const claude = fakeClaude();
    const log = sink();
    const prev = process.exitCode;
    const r = await mod(['on'], { cwd: root, runClaude: claude.fn, log });
    process.exitCode = prev;
    assert.equal(r.exitCode, 1, where);
    assert.match(log.text(), /^mod unavailable: hooks are turned off by .*settings(\.local)?\.json — web-chat works without it$/, where);
    assert.deepEqual(claude.argvs(), [['--version']], where);
    assert.equal(fs.existsSync(projectPaths(root).modDir), false, where);
    fs.rmSync(f);
  }
  assert.ok(cfg);
});

test('mod on when plugin validate refuses the mod says mod unavailable and leaves nothing staged', async (t) => {
  isolate(t);
  const root = project(t);
  const claude = fakeClaude({ validate: false });
  const log = sink();
  const prev = process.exitCode;
  const r = await mod(['on'], { cwd: root, runClaude: claude.fn, log });
  process.exitCode = prev;
  assert.equal(r.exitCode, 1);
  assert.equal(log.text(), 'mod unavailable: this Claude Code does not accept the mod: hooks/register.js: $.fs.nope is not a call on $');
  assert.equal(claude.argvs().length, 2);
  assert.equal(fs.existsSync(projectPaths(root).modDir), false, 'the staged copy is gone again');
});

test('mod on where plugin test is not registered installs anyway, saying mods look unavailable', async (t) => {
  isolate(t);
  const root = project(t);
  const log = sink();
  const r = await mod(['on'], { cwd: root, runClaude: fakeClaude({ testHelp: false }).fn, log });
  assert.equal(r.ok, true);
  assert.match(log.text(), /mods look unavailable for this account: installing anyway; `claude-web-chat mod status` will say whether a session attaches/);
  assert.equal(reg.inspectMod(root).state, 'on');
});

test('mod on with no claude prints the commands to run and exits 1', async (t) => {
  isolate(t);
  const root = project(t);
  const log = sink();
  const prev = process.exitCode;
  const r = await mod(['on'], { cwd: root, runClaude: fakeClaude({ version: null }).fn, log });
  process.exitCode = prev;
  assert.equal(r.exitCode, 1);
  const name = reg.modMarketplaceName(root);
  assert.match(log.text(), /claude plugin marketplace add .*\.web-chat\/mod\/package --scope local --json/);
  assert.match(log.text(), new RegExp(`claude plugin install web-chat-mod@${name} --scope local --json`));
  assert.equal(fs.existsSync(projectPaths(root).modDir), false);
});

test('mod with no subcommand prints its usage', async (t) => {
  isolate(t);
  const root = project(t);
  const log = sink();
  const prev = process.exitCode;
  const r = await mod([], { cwd: root, log });
  process.exitCode = prev;
  assert.equal(r.exitCode, 1);
  assert.equal(log.text(), mod.USAGE);
});

// ── mod off, and the opt-out ────────────────────────────────────────────────

test('mod off removes exactly what mod on added, keeps bridge.log, and records the opt-out; mod on removes it again', async (t) => {
  isolate(t);
  const root = project(t);
  const mp = reg.modPaths(root);
  await mod(['on'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  fs.writeFileSync(path.join(mp.dir, 'bridge.log'), '{"what":"hello"}\n');
  const off = fakeClaude();
  const log = sink();
  const r = await mod(['off'], { cwd: root, runClaude: off.fn, log });
  assert.equal(r.ok, true);
  const name = reg.modMarketplaceName(root);
  assert.deepEqual(off.argvs(), [
    ['plugin', 'uninstall', `web-chat-mod@${name}`, '--scope', 'local', '--json'],
    ['plugin', 'marketplace', 'remove', name, '--scope', 'local'],
  ]);
  assert.ok(off.calls.every((c) => c.cwd === root));
  assert.deepEqual(fs.readdirSync(mp.dir).sort(), ['bridge.log', 'opted-out.json']);
  const rec = JSON.parse(fs.readFileSync(mp.optedOut, 'utf8'));
  assert.equal(rec.by, 'mod off');
  assert.ok(!Number.isNaN(Date.parse(rec.at)));
  assert.match(log.text(), /The opt-out is recorded/);
  assert.equal(reg.inspectMod(root).state, 'off (opted out)');

  const on = await mod(['on'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  assert.equal(on.ok, true);
  assert.equal(fs.existsSync(mp.optedOut), false, 'mod on removes the opt-out');
  assert.equal(reg.inspectMod(root).state, 'on');
});

test('mod off answers "not installed" from Claude Code as no error, and records the opt-out even when nothing was on', async (t) => {
  isolate(t);
  const root = project(t);
  await mod(['on'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  const gone = (argv) => ({ ok: false, stderr: argv[2] === 'uninstall' ? 'Plugin "web-chat-mod" is not installed' : 'Marketplace not found' });
  const r = await mod(['off'], { cwd: root, runClaude: gone, log: sink() });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(reg.modPaths(root).installed), false);

  const fresh = project(t);
  const none = fakeClaude();
  const r2 = await mod(['off'], { cwd: fresh, runClaude: none.fn, log: sink() });
  assert.equal(r2.ok, true);
  assert.deepEqual(none.argvs(), [], 'nothing installed: nothing run');
  assert.ok(fs.existsSync(reg.modPaths(fresh).optedOut));
});

// ── mod status ──────────────────────────────────────────────────────────────

test('mod status with no daemon running says so, and never prints the no-session line as if one had answered', async (t) => {
  isolate(t);
  const root = project(t);
  const log = sink();
  const r = await mod(['status'], { cwd: root, log, daemonFor: noDaemon, get: noGet });
  assert.equal(r.state, 'tier 1: not installed');
  const text = log.text();
  assert.match(text, /^web-chat mod: tier 1: not installed$/m);
  assert.match(text, /the web-chat server is not running here/);
  assert.doesNotMatch(text, /no session has attached/);
  assert.match(text, /if a network policy refuses the mod's call to this daemon: network refused: tier 1/);
});

test('mod status words installed, listed and attached from installed.json, settings.local.json and the daemon\'s bridge', async (t) => {
  isolate(t);
  const root = project(t);
  await mod(['on'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  const id = reg.inspectMod(root).plugin_id;
  fs.mkdirSync(claudePaths(root).dir, { recursive: true });
  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ enabledPlugins: { [id]: true } }));
  const asked = [];
  const daemonFor = async (r) => (r === root ? { pid: 4242, port: 61234, url: 'http://localhost:61234' } : null);
  let sessions = [];
  const get = async (p, o) => { asked.push([p, o]); return { ok: true, sessions }; };

  let log = sink();
  await mod(['status'], { cwd: root, log, daemonFor, get });
  assert.deepEqual(asked, [['/api/bridge/status', { port: 61234, noSpawn: true }]]);
  assert.match(log.text(), /^web-chat mod: on$/m);
  assert.match(log.text(), new RegExp(`installed: v${VERSION.replace(/\./g, '\\.')} \\(web-chat-mod@web-chat-mod-[0-9a-f]{8}, staged v`));
  assert.match(log.text(), /settings\.local\.json: lists web-chat-mod@web-chat-mod-[0-9a-f]{8} in enabledPlugins/);
  assert.match(log.text(), /no session has attached — start or restart Claude Code here; with mods turned off \(safe mode, --bare, a policy, the account's rollout\) web-chat carries on without it/);

  sessions = [{
    session_id: 'abcdef12-0000-4000-8000-000000000000', cc_version: '2.1.296', mod_version: VERSION,
    attached_at: Date.now() - 90000, last_poll_at: Date.now() - 2000, shapes: { driver: ['loop'] },
  }];
  log = sink();
  await mod(['status'], { cwd: root, log, daemonFor, get });
  assert.match(log.text(), /session abcdef12 · Claude Code 2\.1\.296 · mod v.* · attached 2m · last poll 2s ago · driver loop/);
  assert.doesNotMatch(log.text(), /no session has attached/);

  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ enabledPlugins: {} }));
  log = sink();
  await mod(['status'], { cwd: root, log, daemonFor, get });
  assert.match(log.text(), /does not list web-chat-mod@/);
});

test('mod status says what the mod lost: the LAST dropped and failed counts beside the driver, and nothing when the diag carries neither', async (t) => {
  isolate(t);
  const root = project(t);
  await mod(['on'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  const daemonFor = async (r) => (r === root ? { pid: 4242, port: 61234, url: 'http://localhost:61234' } : null);
  const at = Date.now();
  const session = (shapes) => ({
    session_id: 'abcdef12-0000-4000-8000-000000000000', cc_version: '2.1.296', mod_version: VERSION,
    attached_at: at - 90000, last_poll_at: at - 2000, shapes,
  });
  const lineOf = async (shapes) => {
    const log = sink();
    await mod(['status'], { cwd: root, log, daemonFor, get: async () => ({ ok: true, sessions: [session(shapes)] }) });
    return log.text().split('\n').find((l) => l.includes('session abcdef12'));
  };

  // The bridge unions each list across diags: the last entry is the count now.
  assert.match(await lineOf({ driver: ['loop'], dropped: ['0', '101'], failed: ['2'] }), / · driver loop · dropped 101, failed 2$/);
  assert.match(await lineOf({ driver: ['loop'], dropped: ['7'] }), / · driver loop · dropped 7, failed \?$/, 'a missing count reads ?');
  assert.match(await lineOf({ failed: ['3'] }), / ago · dropped \?, failed 3$/, 'no driver: the counts follow the poll');
  // Neither: the line as before, ending at the driver.
  assert.match(await lineOf({ driver: ['loop'] }), / · last poll 2s ago · driver loop$/);
  assert.match(await lineOf(undefined), / · last poll 2s ago$/);
});

test('mod status asks only this project\'s verified daemon: a portfile copied from another project is never asked', async (t) => {
  isolate(t);
  const root = project(t);
  const other = tmp(t, 'wc-modcli-other-');
  fs.writeFileSync(projectPaths(root).serverJson, JSON.stringify({ pid: process.pid, port: 61999, root: other, instance: 'x' }));
  const asked = [];
  const log = sink();
  await mod(['status'], { cwd: root, log, get: async (p, o) => { asked.push([p, o]); return { sessions: [] }; } });
  assert.deepEqual(asked, [], 'the real daemonFor reads a copy as no daemon');
  assert.match(log.text(), /not running here/);
});

test('mod on, off and status write nothing under HOME or Claude Code\'s config, and nothing in the project outside .web-chat/mod/', async (t) => {
  const cfg = isolate(t);
  const home = process.env.HOME;
  const root = project(t);
  fs.writeFileSync(path.join(root, 'README.md'), 'hi\n');
  const before = { home: snapshot(home), cfg: snapshot(cfg), root: snapshot(root, [projectPaths(root).modDir]) };
  const claude = fakeClaude();
  await mod(['on'], { cwd: root, runClaude: claude.fn, log: sink() });
  await mod(['status'], { cwd: root, log: sink(), daemonFor: noDaemon, get: noGet });
  await mod(['off'], { cwd: root, runClaude: claude.fn, log: sink() });
  await mod(['on'], { cwd: root, runClaude: claude.fn, log: sink() });
  assert.deepEqual(snapshot(home), before.home);
  assert.deepEqual(snapshot(cfg), before.cfg);
  assert.deepEqual(snapshot(root, [projectPaths(root).modDir]), before.root);
});

// ── the registration engine ─────────────────────────────────────────────────

test('inspectMod, applyMod and removeMod round-trip', (t) => {
  isolate(t);
  const root = project(t);
  const claude = fakeClaude();
  assert.equal(reg.inspectMod(root).state, 'tier 1: not installed');
  assert.equal(reg.inspectMod(root, { runClaude: fakeClaude({ version: '2.1.200' }).fn }).state, 'tier 1: Claude Code 2.1.200 is older than 2.1.287');
  const on = reg.applyMod(root, { runClaude: claude.fn });
  assert.equal(on.state, 'on');
  const m = reg.inspectMod(root);
  assert.equal(m.installed, true);
  assert.equal(m.version, VERSION);
  assert.equal(m.staged_version, VERSION);
  assert.equal(m.listed, false);
  assert.equal(m.opted_out, false);
  const off = reg.removeMod(root, { runClaude: claude.fn });
  assert.equal(off.status, 'removed');
  assert.equal(reg.inspectMod(root).state, 'tier 1: not installed');
  assert.equal(reg.inspectMod(root).staged_version, null);
});

test('inspect() reports the mod; apply() without opts.mod runs no claude command for it and says what mod on would do', (t) => {
  isolate(t);
  const root = project(t);
  assert.equal(reg.inspect(root).mod.state, 'tier 1: not installed');
  const seen = [];
  const recordClaude = (argv) => { seen.push(argv); return { ok: false, stderr: 'not attempted by update' }; };
  const a = reg.apply(root, { force: false, runClaude: recordClaude });
  assert.deepEqual(a.mod, { state: 'would switch on', ran: false, command: 'claude-web-chat mod on' });
  assert.deepEqual(seen.filter((argv) => argv[0] === 'plugin' || argv[0] === '--version'), [], 'no mod argv, the probe included');
  const dry = reg.apply(root, { dryRun: true, mod: 'on', runClaude: recordClaude });
  assert.equal(dry.mod.state, 'would switch on');
  assert.deepEqual(seen.filter((argv) => argv[0] === 'plugin' || argv[0] === '--version'), [], 'a dry run runs nothing for the mod');

  reg.recordModOptOut(root);
  assert.deepEqual(reg.apply(root, { force: false, runClaude: recordClaude }).mod, { state: 'off (opted out)', ran: false });
  assert.equal(reg.inspect(root).mod.state, 'off (opted out)');
});

test('remove() takes the mod off only when installed.json exists, and spawns nothing for it otherwise', (t) => {
  isolate(t);
  const root = project(t);
  const none = fakeClaude();
  const r0 = reg.remove(root, { runClaude: none.fn, knownRoots: [] });
  assert.equal(r0.mod, undefined);
  assert.deepEqual(none.argvs().filter((a) => a[0] === 'plugin'), []);

  reg.applyMod(root, { runClaude: fakeClaude().fn });
  reg.recordModOptOut(root, 'test');
  const c = fakeClaude();
  const r = reg.remove(root, { runClaude: c.fn, knownRoots: [] });
  const name = reg.modMarketplaceName(root);
  assert.equal(r.mod.status, 'removed');
  assert.deepEqual(c.argvs().filter((a) => a[0] === 'plugin'), [
    ['plugin', 'uninstall', `web-chat-mod@${name}`, '--scope', 'local', '--json'],
    ['plugin', 'marketplace', 'remove', name, '--scope', 'local'],
  ]);
  assert.equal(fs.existsSync(reg.modPaths(root).pkg), false);
  assert.equal(fs.existsSync(reg.modPaths(root).installed), false);
  assert.ok(fs.existsSync(reg.modPaths(root).optedOut), 'the opt-out record is left as it is');
});

test('uninstall takes the mod off through remove(), touching no daemon', async (t) => {
  isolate(t);
  const root = project(t);
  reg.applyMod(root, { runClaude: fakeClaude().fn });
  const uninstall = require('../lib/cli/commands/uninstall');
  const c = fakeClaude();
  await printed(() => uninstall(['--keep-running'], { cwd: root, runClaude: c.fn, knownRoots: [], scanPorts: [] }));
  assert.ok(c.argvs().some((a) => a[1] === 'uninstall' && a[2] === `web-chat-mod@${reg.modMarketplaceName(root)}`), JSON.stringify(c.argvs()));
  assert.equal(fs.existsSync(reg.modPaths(root).installed), false);
});

// uninstall's row for the mod: what happened to it, and the commands to run
// when it could not be taken off (the plugin then stays installed).
const runUninstall = (root, runClaude) => printed(() => require('../lib/cli/commands/uninstall')(['--keep-running'], {
  cwd: root, runClaude, knownRoots: [], scanPorts: [],
}));
// The label column pads to the longest managed path: compare label | value.
const modRow = (text) => text.split('\n').filter((l) => l.includes('Claude Code (the mod)')).map((l) => l.trim().replace(/ {3,}/, ' | '));

test('uninstall prints the mod\'s row: removed', async (t) => {
  isolate(t);
  const root = project(t);
  reg.applyMod(root, { runClaude: fakeClaude().fn });
  const { text } = await runUninstall(root, fakeClaude().fn);
  assert.deepEqual(modRow(text), ['Claude Code (the mod) | web-chat mod removed (plugin and marketplace, local scope)']);
});

test('uninstall prints the mod\'s row: claude not on PATH, with the commands to run from the root', async (t) => {
  isolate(t);
  const root = project(t);
  reg.applyMod(root, { runClaude: fakeClaude().fn });
  const name = reg.modMarketplaceName(root);
  const { text } = await runUninstall(root, fakeClaude({ version: null }).fn);
  assert.deepEqual(modRow(text), [
    `Claude Code (the mod) | claude not on PATH — run in ${root}: claude plugin uninstall web-chat-mod@${name} --scope local --json; claude plugin marketplace remove ${name} --scope local`,
  ]);
  assert.ok(fs.existsSync(reg.modPaths(root).installed), 'nothing removed: the record stays');
});

test('uninstall prints the mod\'s row: could not remove, with Claude Code\'s error and the commands', async (t) => {
  isolate(t);
  const root = project(t);
  reg.applyMod(root, { runClaude: fakeClaude().fn });
  const name = reg.modMarketplaceName(root);
  const base = fakeClaude().fn;
  const refusing = (argv, o) => (argv[0] === 'plugin' && argv[1] === 'uninstall' ? { ok: false, stderr: 'EACCES: permission denied\nmore' } : base(argv, o));
  const { text } = await runUninstall(root, refusing);
  assert.deepEqual(modRow(text), [
    `Claude Code (the mod) | could not remove (EACCES: permission denied) — run in ${root}: claude plugin uninstall web-chat-mod@${name} --scope local --json; claude plugin marketplace remove ${name} --scope local`,
  ]);
  assert.ok(fs.existsSync(reg.modPaths(root).installed));
});

test('uninstall prints no mod row for a project that never had the mod', async (t) => {
  isolate(t);
  const root = project(t);
  const { text } = await runUninstall(root, fakeClaude().fn);
  assert.match(text, /web-chat uninstalled from/);
  assert.deepEqual(modRow(text), []);
});

// ── install's default (ruling C1 (b)) ───────────────────────────────────────

const NO_TTY = Object.freeze({ interactive: false, confirm: async () => { throw new Error('asked a question with no terminal'); }, close() {} });
const runInstall = (root, claude) => printed(() => install([], {
  cwd: root, runClaude: claude.fn, prompt: NO_TTY, restartIfStale: async () => ({ restarted: false }), nextSteps: false,
}));

test('install switches the mod on by default where Claude Code 2.1.287+ can run it, and its row says on', async (t) => {
  isolate(t);
  const root = tmp(t, 'wc-modcli-inst-');
  const claude = fakeClaude({ version: '2.1.287' });
  const { text } = await runInstall(root, claude);
  const name = reg.modMarketplaceName(root);
  const mp = reg.modPaths(root);
  assert.deepEqual(claude.plugin(), [
    ['--version'],
    ['plugin', 'validate', mp.plugin],
    ['plugin', 'test', '--help'],
    ['plugin', 'marketplace', 'add', mp.pkg, '--scope', 'local', '--json'],
    ['plugin', 'install', `web-chat-mod@${name}`, '--scope', 'local', '--json'],
  ]);
  assert.ok(claude.calls.every((c) => c.cwd === root));
  assert.match(text, /web-chat mod \(local scope\) +on — switched on at local scope; restart Claude Code here to load it/);
  assert.equal(reg.inspectMod(root).state, 'on');
});

for (const [what, claude, reason] of [
  ['Claude Code 2.1.286', () => fakeClaude({ version: '2.1.286' }), 'tier 1: Claude Code 2.1.286 is older than 2.1.287'],
  ['no claude', () => fakeClaude({ version: null }), 'tier 1: claude not on PATH'],
]) {
  test(`install with ${what} writes nothing for the mod and reports '${reason}'`, async (t) => {
    isolate(t);
    const root = tmp(t, 'wc-modcli-inst-');
    const c = claude();
    const { text } = await runInstall(root, c);
    assert.deepEqual(c.argvs().filter((a) => a[0] === 'plugin'), []);
    assert.equal(fs.existsSync(projectPaths(root).modDir), false);
    assert.match(text, new RegExp(`web-chat mod \\(local scope\\) +${reason} — web-chat works without it`));
  });
}

test('install with hooks turned off writes nothing for the mod and reports why', async (t) => {
  isolate(t);
  const root = tmp(t, 'wc-modcli-inst-');
  fs.mkdirSync(claudePaths(root).dir, { recursive: true });
  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ disableAllHooks: true }));
  const c = fakeClaude();
  const { text } = await runInstall(root, c);
  assert.deepEqual(c.argvs().filter((a) => a[0] === 'plugin'), []);
  assert.equal(fs.existsSync(projectPaths(root).modDir), false);
  assert.match(text, /web-chat mod \(local scope\) +tier 1: hooks are turned off by .*settings\.local\.json — web-chat works without it/);
});

test('a recorded opt-out: install runs no mod argv and reports off (opted out); mod on switches it on again', async (t) => {
  isolate(t);
  const root = tmp(t, 'wc-modcli-inst-');
  await runInstall(root, fakeClaude());
  await mod(['off'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  assert.ok(fs.existsSync(reg.modPaths(root).optedOut));
  const again = fakeClaude();
  const { text } = await runInstall(root, again);
  assert.deepEqual(again.plugin(), [], 'no probe, no install');
  assert.match(text, /web-chat mod \(local scope\) +off \(opted out\) — `claude-web-chat mod on` switches it on/);
  assert.equal(reg.inspectMod(root).state, 'off (opted out)');
  await mod(['on'], { cwd: root, runClaude: fakeClaude().fn, log: sink() });
  assert.equal(reg.inspectMod(root).state, 'on');
  const third = fakeClaude();
  const { text: t3 } = await runInstall(root, third);
  assert.deepEqual(third.plugin(), [], 'on at this version: nothing to do');
  assert.match(t3, /web-chat mod \(local scope\) +on$/m);
});

test('init\'s write list names the mod, or why it stays off', () => {
  const withClaude = init.writeList({ claude: true }).join('\n');
  assert.match(withClaude, /\.web-chat\/mod\/ +the web-chat mod, staged here and switched on by Claude Code at local scope where 2\.1\.287\+ can run it \(`claude-web-chat mod off` opts out\)/);
  const without = init.writeList({ claude: false }).join('\n');
  assert.match(without, /\.web-chat\/mod\/ +nothing: the web-chat mod stays off \(tier 1: claude not on PATH\)/);
});

// ── doctor and status print the mod's row ───────────────────────────────────

test('doctor and status print the mod\'s row from inspect(): on, off (opted out), tier 1: not installed', async (t) => {
  isolate(t);
  const doctor = require('../lib/cli/commands/doctor');
  const status = require('../lib/cli/commands/status');
  const root = project(t);
  const rows = async () => {
    const lines = [];
    const prevHub = process.env.WEB_CHAT_HUB_PORT;
    process.env.WEB_CHAT_HUB_PORT = '65531';
    try {
      await doctor([], { cwd: root, runClaude: () => ({ ok: false, stderr: 'no' }), log: (l) => lines.push(l), prompt: NO_TTY, dryRun: true });
    } finally { if (prevHub === undefined) delete process.env.WEB_CHAT_HUB_PORT; else process.env.WEB_CHAT_HUB_PORT = prevHub; }
    const st = await printed(() => status([], { cwd: root }));
    return { doctor: lines.find((l) => /web-chat mod:/.test(l)), status: st.text.split('\n').find((l) => l.startsWith('Mod:')) };
  };
  let r = await rows();
  assert.match(r.doctor, /web-chat mod: tier 1: not installed/);
  assert.equal(r.status, 'Mod:      tier 1: not installed');
  reg.applyMod(root, { runClaude: fakeClaude().fn });
  r = await rows();
  assert.match(r.doctor, /web-chat mod: on/);
  assert.equal(r.status, `Mod:      on (v${VERSION})`);
  reg.removeMod(root, { runClaude: fakeClaude().fn });
  reg.recordModOptOut(root);
  r = await rows();
  assert.match(r.doctor, /web-chat mod: off \(opted out\)/);
  assert.equal(r.status, 'Mod:      off (opted out)');
});

// ── update prints the command and never runs it ─────────────────────────────

test('update names `claude-web-chat mod on` once for a project where it is not on, nothing for an opted-out one, and runs no claude', async (t) => {
  withTempHome(t);
  const cfg = tmp(t, 'wc-modcli-ucfg-');
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  t.after(() => { if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg; });
  const paths = installPaths();
  const fakeVersion = (v) => {
    const dir = paths.versionDir(v);
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib', 'cli', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version: v }));
    for (const name of paths.BIN_NAMES) fs.writeFileSync(path.join(dir, 'bin', `${name}.js`), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(dir, 'lib', 'cli', 'commands', 'restart.js'), 'module.exports = async function restart() { return { ok: true }; };\n');
  };
  fakeVersion('0.5.0');
  activate('0.5.0', paths);
  linkBins(paths);
  const wired = (prefix) => {
    const dir = tmp(t, prefix);
    fs.mkdirSync(path.join(dir, '.web-chat'));
    reg.apply(dir, { runClaude: () => ({ ok: false, stderr: 'no' }) });
    return dir;
  };
  const here = wired('wc-modcli-uhere-');
  const notOn = wired('wc-modcli-unot-');
  const optedOut = wired('wc-modcli-uopt-');
  reg.recordModOptOut(optedOut);
  const prevCwd = process.cwd();
  process.chdir(here);
  t.after(() => process.chdir(prevCwd));

  const lines = [];
  const logFn = (m = '') => lines.push(String(m));
  const realApply = reg.apply;
  const seen = [];
  const registration = { ...reg, apply: (root, o) => realApply(root, { ...o, runClaude: (argv, x) => { seen.push(argv); return o.runClaude(argv, x); } }) };
  await update(['--restart-all'], {
    log: logFn, errlog: logFn, exit: (c) => { throw new Error(`exit ${c}`); },
    paths,
    describeInstall: () => require('../lib/update/install-layout').describeInstall({ packageRoot: paths.versionDir('0.5.0'), paths }),
    fetchLatestRelease: async () => ({ tag: 'v0.6.0', version: '0.6.0', assets: [] }),
    fetchAndUnpack: async ({ release, versionDir }) => { fakeVersion(release.version); return { version: release.version, dir: versionDir }; },
    readInstances: () => [{ root: notOn, port: 1 }, { root: optedOut, port: 2 }],
    runningBuild: async () => '0.4.0',
    restart: async () => ({ ok: true }),
    registration,
  });
  const text = lines.join('\n');
  assert.deepEqual(seen.filter((a) => a[0] === 'plugin' || a[0] === '--version'), [], 'update ran no claude command for the mod');
  const modLines = lines.filter((l) => /claude-web-chat mod on/.test(l));
  assert.equal(modLines.length, 2, text);
  assert.match(modLines[0], /^ {2}the web-chat mod is not on here \(Claude Code 2\.1\.287\+ can run it\) — run `claude-web-chat mod on` here\.$/);
  assert.match(modLines[1], /^ {6}the web-chat mod is not on here .* — run `claude-web-chat mod on` there\.$/);
  const notOnIdx = lines.findIndex((l) => l.includes(notOn));
  const optIdx = lines.findIndex((l) => l.includes(optedOut));
  assert.ok(notOnIdx >= 0 && optIdx > notOnIdx, text);
  assert.ok(lines.slice(optIdx + 1).every((l) => !/mod on/.test(l)), 'nothing for the opted-out project');
  assert.equal(fs.existsSync(projectPaths(notOn).modDir), false, 'and nothing switched on');
});

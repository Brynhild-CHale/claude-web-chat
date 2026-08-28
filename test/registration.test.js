// The project-registration engine — lib/setup/registration.js.
//
// The guardrail this unit owes: one model of "registered with Claude Code",
// exercised as a ROUND TRIP (apply → inspect → remove → inspect) over the
// model's own fields, plus proof that every command that operates on a project
// resolves the same root from the same starting directory.
//
// Scoped deliberately: `.web-chat/` (the graph), the migrations and the daemon
// are NOT part of the round trip. apply() does not create the state dir or run
// the migrations (those stay in `install`, so doctor's hook repair never forks a
// daemon), and remove() preserves `.web-chat/` and never stops one. A round-trip
// assertion over those fields would encode a contract nobody wants.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const reg = require('../lib/setup/registration');
const { MANAGED_FILES, baselinePath } = require('../lib/update/managed-files');
const { claudePaths, projectPaths } = require('../lib/core/paths');
const { withTempHome } = require('../test-support/helpers');

// The cross-command guardrail below runs `doctor`, which probes the capture hub
// on the fixed hub port. Pin it, for the whole file, at a port nothing is
// listening on — exactly as test/doctor.test.js does — so the check is
// deterministic and never picks up a hub the developer happens to be running.
process.env.WEB_CHAT_HUB_PORT = '65533';

function tmpRoot(prefix = 'wc-reg-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A project that already exists as far as findProjectRoot is concerned.
function installedRoot(prefix = 'wc-reg-') {
  const root = tmpRoot(prefix);
  fs.mkdirSync(path.join(root, '.web-chat', 'graph'), { recursive: true });
  return root;
}

// Nothing in this suite may shell out to a real `claude`. The fake records the
// cwd as well as the argv: `claude mcp add|remove … --scope local` keys the
// registration to the directory it runs in, so an argv-only assertion cannot
// tell "registered the project the engine resolved" from "registered whatever
// directory the user happened to be standing in".
function fakeClaude(result = { ok: true }) {
  const calls = [];
  const cwds = [];
  return { fn: (argv, opts = {}) => { calls.push(argv); cwds.push(opts.cwd); return result; }, calls, cwds };
}

// ── the round trip ──────────────────────────────────────────────────────────

test('apply → inspect → remove → inspect round-trips the registration model', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const events = reg.hookEvents();
  assert.deepEqual(events, ['UserPromptSubmit', 'Stop'], 'both turn-lifecycle events come from the template');

  const before = reg.inspect(root);
  for (const e of events) assert.equal(before.hooks[e], 'missing');
  assert.equal(before.mcp.present, false);
  assert.equal(before.mcp.kind, 'none');
  assert.equal(before.gitignore, 'absent');
  assert.deepEqual(before.managed.map((r) => r.action), MANAGED_FILES.map(() => 'created'));

  const claude = fakeClaude();
  const applied = reg.apply(root, { runClaude: claude.fn });
  assert.equal(applied.hooks.added, 2);
  assert.equal(applied.gitignore, 'added');
  assert.equal(applied.mcp.localScope, null, 'a resolvable .mcp.json entry needs no local-scope shell-out');
  assert.equal(claude.calls.length, 0);

  const after = reg.inspect(root);
  for (const e of events) assert.equal(after.hooks[e], 'ok', `${e} registered and resolvable`);
  assert.equal(after.mcp.present, true);
  assert.equal(after.mcp.kind, 'absolute');
  assert.equal(after.mcp.resolvable, true);
  assert.equal(after.mcp.channelEnv, false);
  assert.equal(after.gitignore, 'covered');
  for (const r of after.managed) assert.equal(r.action, 'up-to-date');
  assert.ok(fs.existsSync(baselinePath(root)), 'baselines recorded');
  // The excluded half, asserted so the exclusion is a contract, not an accident.
  // (The baselines file lives under .web-chat/, so the directory exists — but
  // nothing else install does happened here.)
  const p = projectPaths(root);
  assert.equal(fs.existsSync(p.version), false, 'apply() does not stamp _version.json — the migrations do, in install');
  assert.equal(fs.existsSync(p.graphDir), false, 'apply() does not create the graph dir — ensureProjectDirs does, in install');
  assert.equal(fs.existsSync(p.serverJson), false, 'and it never pre-warms a daemon');

  const removeClaude = fakeClaude();
  const removed = reg.remove(root, { runClaude: removeClaude.fn });
  assert.equal(removed.hooks.removed, 2);
  assert.deepEqual(removed.hooks.events, events);
  assert.equal(removed.mcp.status, 'removed (file empty)');
  assert.equal(removed.baselines, 'removed');
  assert.deepEqual(removeClaude.calls, [['mcp', 'remove', 'web-chat', '--scope', 'local']],
    'uninstall undoes the LOCAL-scope registration doctor writes, not just the project file');
  assert.deepEqual(removeClaude.cwds, [root], 'and it un-registers THE ROOT, not the shell\'s cwd');

  const end = reg.inspect(root);
  for (const e of events) assert.equal(end.hooks[e], 'missing', `${e} unregistered again`);
  assert.equal(end.mcp.present, false);
  assert.equal(end.mcp.kind, 'none');
  for (const r of end.managed) assert.equal(r.action, 'created', 'every managed file is gone');
  assert.ok(!fs.existsSync(baselinePath(root)));
  const settings = JSON.parse(fs.readFileSync(claudePaths(root).settings, 'utf8'));
  assert.ok(!settings.hooks, 'no empty hook husk left behind');
});

test('apply --dryRun writes nothing at all', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const claude = fakeClaude();

  const out = reg.apply(root, { dryRun: true, runClaude: claude.fn });
  assert.equal(out.hooks.added, 2, 'it still reports what it WOULD do');
  assert.equal(claude.calls.length, 0);
  assert.equal(fs.existsSync(claudePaths(root).settings), false);
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(root, MANAGED_FILES[0].dest)), false);
});

test('inspect reports a MISSING hook event, not a smaller count', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  reg.apply(root, { runClaude: fakeClaude().fn });
  const settingsPath = claudePaths(root).settings;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  delete settings.hooks.Stop;               // a hand edit, a merge, an older template
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const state = reg.inspect(root);
  assert.equal(state.hooks.UserPromptSubmit, 'ok');
  assert.equal(state.hooks.Stop, 'missing',
    'the turn lifecycle needs both: turn-begin takes the lock, turn-end commits the node');
});

test('inspect classifies a bare hook command as bare, and a bare MCP entry as unresolvable', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  const settingsPath = claudePaths(root).settings;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }],
    },
  }, null, 2));
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { 'web-chat': { command: 'claude-web-chat-mcp' } },
  }, null, 2));

  const state = reg.inspect(root);
  assert.equal(state.hooks.UserPromptSubmit, 'bare');
  assert.equal(state.hooks.Stop, 'bare');
  assert.equal(state.mcp.kind, 'bare');
  assert.equal(state.mcp.resolvable, false);
  assert.match(state.mcp.reason, /PATH-dependent/);
});

test('inspect separates an unparseable settings.json from an absent one', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  assert.equal(reg.inspect(root).hooksFile, 'absent');
  const settingsPath = claudePaths(root).settings;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{ not json');
  assert.equal(reg.inspect(root).hooksFile, 'unparseable');
});

// ── the argv ────────────────────────────────────────────────────────────────

test('mcpArgv registers at local scope through stableBin, never __dirname', (t) => {
  withTempHome(t);
  const argv = reg.mcpArgv();
  assert.deepEqual(argv.slice(0, 6), ['mcp', 'add', 'web-chat', '--scope', 'local', '--']);
  assert.equal(argv[6], 'node');
  assert.ok(path.isAbsolute(argv[7]) && /bin\/claude-web-chat-mcp\.js$/.test(argv[7]));
  assert.deepEqual(reg.removeArgv(), ['mcp', 'remove', 'web-chat', '--scope', 'local']);
});

test('mcpArgv points a MANAGED install at current/, not the version directory', (t) => {
  const home = withTempHome(t);
  const { installPaths } = require('../lib/core/paths');
  const paths = installPaths();
  // The layout an unpacked release has; the process cannot move itself into it,
  // so the decision is exercised against a fabricated packageRoot.
  const vdir = path.join(paths.versions, '0.6.0');
  fs.mkdirSync(path.join(vdir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(vdir, 'bin', 'claude-web-chat-mcp.js'), '');

  const argv = reg.mcpArgv({ packageRoot: vdir, paths });
  assert.equal(argv[7], path.join(home, '.web-chat', 'current', 'bin', 'claude-web-chat-mcp.js'));
  assert.doesNotMatch(argv[7], /versions\/0\.6\.0/,
    'a local-scope registration overrides .mcp.json and never self-heals — a pruned version dir would be permanent');
});

// ── resolveRoot ─────────────────────────────────────────────────────────────

test('resolveRoot: `existing` refuses outside a project, `install` falls back, `optional` reports null', () => {
  const root = installedRoot();
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });

  assert.equal(reg.resolveRoot(sub, { mode: 'existing' }).root, root);
  assert.equal(reg.resolveRoot(sub, { mode: 'install' }).root, root);
  assert.equal(reg.resolveRoot(sub, { mode: 'install' }).movedUp, true);

  const bare = tmpRoot();
  assert.equal(reg.resolveRoot(bare, { mode: 'install' }).root, bare, 'a fresh install may land here');
  assert.equal(reg.resolveRoot(bare, { mode: 'install' }).source, 'cwd');
  assert.equal(reg.resolveRoot(bare, { mode: 'optional' }).root, null);
  assert.throws(
    () => reg.resolveRoot(bare, { mode: 'existing' }),
    (e) => e.userFacing === true && /run `claude-web-chat init`/.test(e.message),
  );
});

test('resolveRoot inherits findProjectRoot\'s $HOME refusal', (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.web-chat'), { recursive: true });
  const under = path.join(home, 'code', 'app');
  fs.mkdirSync(under, { recursive: true });
  // ~/.web-chat is the USER tier — the same directory name, a different thing.
  assert.equal(reg.resolveRoot(under, { mode: 'install' }).root, under);
  assert.equal(reg.resolveRoot(under, { mode: 'optional' }).root, null);
  assert.equal(projectPaths(under).dir, path.join(under, '.web-chat'));
});

// ── every consumer agrees on the root ───────────────────────────────────────
// The guardrail for cli-setup-7: install/uninstall/on/off used to anchor on
// process.cwd() while doctor/status walked up to findProjectRoot, so the same
// directory meant two different projects depending on which command you typed.

test('doctor, status, install, uninstall, on and off resolve the SAME root from a subdirectory', async (t) => {
  withTempHome(t);
  const root = installedRoot('wc-agree-');
  const sub = path.join(root, 'packages', 'web', 'src');
  fs.mkdirSync(sub, { recursive: true });
  const claude = fakeClaude();
  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));

  // install is required with the daemon pre-warm patched out — it destructures
  // spawnDaemon at module load, so the patch has to happen first.
  const daemonMod = require('../lib/util/daemon');
  const realSpawn = daemonMod.spawnDaemon;
  daemonMod.spawnDaemon = async () => null;
  const install = require('../lib/cli/commands/install');
  daemonMod.spawnDaemon = realSpawn;
  const uninstall = require('../lib/cli/commands/uninstall');
  const status = require('../lib/cli/commands/status');
  const doctor = require('../lib/cli/commands/doctor');
  const on = require('../lib/cli/commands/on');
  const off = require('../lib/cli/commands/off');

  try {
    await install([], { cwd: sub, runClaude: claude.fn });
    assert.ok(fs.existsSync(path.join(root, '.mcp.json')), 'install: the parent');
    assert.equal(fs.existsSync(path.join(sub, '.mcp.json')), false);

    off([], { cwd: sub });
    assert.ok(fs.existsSync(projectPaths(root).disabled), 'off: the parent');
    on([], { cwd: sub });
    assert.equal(fs.existsSync(projectPaths(root).disabled), false, 'on: the parent');

    const summary = await doctor([], { cwd: sub, runClaude: claude.fn, log: () => {} });
    assert.ok(summary.checks.length, 'doctor ran against an installed project, not a bare subdir');

    lines.length = 0;
    await status([], { cwd: sub });
    assert.match(lines.join('\n'), new RegExp(`\\(${root}\\)`), 'status: the parent');

    lines.length = 0;
    uninstall([], { cwd: sub, runClaude: claude.fn });
    assert.match(lines.join('\n'), new RegExp(`uninstalled from ${root}`), 'uninstall: the parent');

    // …including the half that leaves the project: `claude mcp add|remove …
    // --scope local` registers the directory it RUNS in. Resolving the root and
    // then shelling out from process.cwd() would print a success row for a
    // project it never registered, and leave the local-scope entry behind on
    // uninstall — a second, implicit root derivation inside the one module that
    // exists to have exactly one.
    assert.ok(claude.cwds.length, 'the local-scope shell-out happened at least once');
    assert.deepEqual([...new Set(claude.cwds)], [root],
      'every `claude mcp …` ran in the resolved root, never in the subdirectory');
  } finally {
    console.log = prevLog;
  }
});

test('`on` in a directory with no install refuses, exactly like `off`', () => {
  const bare = tmpRoot('wc-agree-bare-');
  const on = require('../lib/cli/commands/on');
  const off = require('../lib/cli/commands/off');
  for (const [name, fn] of [['on', on], ['off', off]]) {
    assert.throws(
      () => fn([], { cwd: bare }),
      // `on` used to print "web-chat is not disabled for this project" here —
      // false reassurance for a project that was never installed.
      (e) => e.userFacing === true && /run `claude-web-chat init`/.test(e.message),
      `${name} must refuse`,
    );
  }
});

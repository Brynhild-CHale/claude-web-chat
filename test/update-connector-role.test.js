// The hub connector's role in `claude-web-chat update`, and the prune rule
// (tranche 6, U754; contract 06 C-06.11, C-06.12, 12 C-12.16, C-12.17).
//
// update bounces a registered connector after it flips `current` (launchd's
// kickstart -k, systemd's restart), and — when the target build has no
// `connect` command — stops the service and removes its unit BEFORE the flip,
// refusing the whole install when the stop fails. Every service-manager call
// goes through lib/setup/connector.js's argv and an injected runner (deps.run
// records the argv; nothing runs — LAUNCHD@stubbed), and every unit file lives
// under the sandboxed HOME. pruneVersions keeps any version a live daemon
// runs, the list computed by update from the registry's rows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const update = require('../lib/cli/commands/update');
const { installPaths } = require('../lib/core/paths');
const { activate, linkBins, listVersions, pruneVersions, describeInstall } = require('../lib/update/install-layout');
const { unitPaths } = require('../lib/setup/connector');
const { registerRole } = require('../lib/util/registry');
const { withTempHome } = require('../test-support/helpers');

const UID = 501;
const KICKSTART = ['launchctl', 'kickstart', '-k', `gui/${UID}/com.claude-web-chat.connector`];
const BOOTOUT = ['launchctl', 'bootout', `gui/${UID}/com.claude-web-chat.connector`];
const SYSTEMD_RESTART = ['systemctl', '--user', 'restart', 'claude-web-chat-connector'];
const SYSTEMD_UNLOAD = ['systemctl', '--user', 'disable', '--now', 'claude-web-chat-connector'];
const SYSTEMD_RELOAD = ['systemctl', '--user', 'daemon-reload'];

// A version tree under versions/<v>; `connect` gives it the connect command.
function fakeVersion(paths, version, { connect = false } = {}) {
  const dir = paths.versionDir(version);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib', 'cli', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version }));
  for (const name of paths.BIN_NAMES) fs.writeFileSync(path.join(dir, 'bin', `${name}.js`), '#!/usr/bin/env node\n');
  if (connect) fs.writeFileSync(path.join(dir, 'lib', 'cli', 'commands', 'connect.js'), 'module.exports = async () => {};\n');
  return dir;
}

function sink() {
  const lines = [];
  const fn = (m = '') => lines.push(String(m));
  fn.text = () => lines.join('\n');
  return fn;
}

// No project here, so update restarts no daemon and syncs nothing.
function inScratchCwd(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cwd-')));
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

// A managed install on `from`, with `to` unpacked beside it.
function machine(t, { from = '0.9.0-alpha.7', to = '0.9.0-alpha.8', fromConnect = true, toConnect = true } = {}) {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  fakeVersion(paths, from, { connect: fromConnect });
  fakeVersion(paths, to, { connect: toConnect });
  activate(from, paths);
  linkBins(paths);
  return paths;
}

// A start-at-login unit as connect would have left it (the text is not read).
function installUnit(kind) {
  const file = unitPaths()[kind];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'unit\n');
  return file;
}

// The runner: records each argv and where `current` pointed when it ran.
function recorder(paths, { fail = () => null } = {}) {
  const calls = [];
  const run = (argv) => {
    calls.push({ argv, current: fs.readlinkSync(paths.current) });
    const why = fail(argv);
    if (why) throw new Error(why);
    return Buffer.alloc(0);
  };
  run.calls = calls;
  run.argvs = () => calls.map((c) => c.argv);
  return run;
}

const CONNECTOR = { id: 'connector', role: 'connector', pid: 4242, port: null, url: null };

function deps(paths, from, extra = {}) {
  return {
    paths,
    log: sink(),
    errlog: sink(),
    exit: (c) => { throw Object.assign(new Error(`exit ${c}`), { exitCode: c }); },
    restart: async () => {},
    readPortal: () => null,
    rows: async () => [],
    uid: UID,
    describeInstall: () => describeInstall({ packageRoot: paths.versionDir(from), paths }),
    ...extra,
  };
}

// ── the bounce after the flip ───────────────────────────────────────────────

test('a registered connector is bounced AFTER the flip with launchctl kickstart -k (launchd)', async (t) => {
  const paths = machine(t);
  installUnit('launchd');
  const run = recorder(paths);
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'launchd', run });
  const res = await update(['--to', '0.9.0-alpha.8'], d);
  assert.equal(res.after, '0.9.0-alpha.8');
  assert.deepEqual(run.calls, [{ argv: KICKSTART, current: 'versions/0.9.0-alpha.8' }],
    'one restart, after `current` points at the target');
  assert.deepEqual(res.connector, { restarted: true });
  assert.match(d.log.text(), /Restarted the hub connector on v0\.9\.0-alpha\.8 — it dials the hub again and reports its new versions\./);
  assert.equal(d.errlog.text(), '');
});

test('a registered connector is bounced with systemctl --user restart (systemd)', async (t) => {
  const paths = machine(t);
  installUnit('systemd-user');
  const run = recorder(paths);
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'systemd-user', run });
  const res = await update(['--to', '0.9.0-alpha.8'], d);
  assert.deepEqual(run.calls, [{ argv: SYSTEMD_RESTART, current: 'versions/0.9.0-alpha.8' }]);
  assert.deepEqual(res.connector, { restarted: true });
});

test('a failed bounce names the command that fixes it, and the update still succeeds', async (t) => {
  const paths = machine(t);
  installUnit('launchd');
  const run = recorder(paths, { fail: () => 'Command failed: kickstart\nboom' });
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'launchd', run });
  const res = await update(['--to', '0.9.0-alpha.8'], d);   // deps.exit throws: an exit fails the test
  assert.equal(res.after, '0.9.0-alpha.8');
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.9.0-alpha.8', 'the new build stays activated');
  assert.deepEqual(res.connector, { restarted: false, error: 'Command failed: kickstart' });
  const text = d.errlog.text();
  assert.match(text, /Could not restart the hub connector \(pid 4242\) on v0\.9\.0-alpha\.8: Command failed: kickstart/);
  assert.ok(text.includes(`The update itself succeeded. To restart it: ${KICKSTART.join(' ')}`));
});

test('a connector running without a unit is not bounced: the update says how to move it', async (t) => {
  const paths = machine(t);
  const run = recorder(paths);
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'launchd', run });
  const res = await update(['--to', '0.9.0-alpha.8'], d);
  assert.equal(res.after, '0.9.0-alpha.8');
  assert.deepEqual(run.argvs(), [], 'no service manager call for a unit that is not there');
  assert.equal(res.connector.restarted, false);
  assert.match(d.errlog.text(), /runs without a start-at-login unit/);
  assert.match(d.errlog.text(), /claude-web-chat connect run/);
});

test("update finds the connector through readRoleEntry('connector'), never the hub's role", async (t) => {
  const paths = machine(t);
  installUnit('launchd');
  const run = recorder(paths);
  // The capture hub's role alone is not a connector.
  registerRole('hub', { port: 45999, pid: process.pid });
  const d1 = deps(paths, '0.9.0-alpha.7', { serviceKind: 'launchd', run });
  const r1 = await update(['--to', '0.9.0-alpha.8'], d1);
  assert.deepEqual(run.argvs(), []);
  assert.equal(r1.connector, undefined);
  // The port-less connector role is.
  registerRole('connector', { pid: process.pid });
  const d2 = deps(paths, '0.9.0-alpha.8', { serviceKind: 'launchd', run });
  const r2 = await update(['--to', '0.9.0-alpha.7'], d2);
  assert.deepEqual(run.argvs(), [KICKSTART]);
  assert.deepEqual(r2.connector, { restarted: true });
});

// ── the stop before a flip to a build without `connect` ─────────────────────

test('a target without connect: the service is stopped and its unit removed BEFORE the flip (launchd)', async (t) => {
  const paths = machine(t, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
  const plist = installUnit('launchd');
  const run = recorder(paths);
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'launchd', run });
  const res = await update(['--to', '0.9.0-alpha.6'], d);
  assert.equal(res.after, '0.9.0-alpha.6');
  assert.deepEqual(run.calls, [{ argv: BOOTOUT, current: 'versions/0.9.0-alpha.7' }],
    'bootout once, while `current` is still the build that has connect; no bounce after');
  assert.equal(fs.existsSync(plist), false, 'the LaunchAgent is gone');
  assert.deepEqual(res.connector, { restarted: false, stopped: true });
  const out = d.log.text();
  assert.match(out, /Stopped the hub connector and removed its start-at-login unit: v0\.9\.0-alpha\.6 has no connect command, so hub access is off/);
  assert.match(out, /run `claude-web-chat connect <hub-url>` there/);
  assert.equal(d.errlog.text(), '');
});

test('a target without connect (systemd): disable --now, the unit removed, then daemon-reload', async (t) => {
  const paths = machine(t, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
  const unit = installUnit('systemd-user');
  const run = recorder(paths);
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'systemd-user', run });
  const res = await update(['--to', '0.9.0-alpha.6'], d);
  assert.deepEqual(run.argvs(), [SYSTEMD_UNLOAD, SYSTEMD_RELOAD]);
  assert.ok(run.calls.every((c) => c.current === 'versions/0.9.0-alpha.7'), 'both before the flip');
  assert.equal(fs.existsSync(unit), false);
  assert.deepEqual(res.connector, { restarted: false, stopped: true });
});

test('the connector record and key are left alone by the stop (it is not a disconnect)', async (t) => {
  const paths = machine(t, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
  installUnit('launchd');
  const { userPaths } = require('../lib/core/paths');
  const dir = userPaths().connectorDir;
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, 'hub-one.json');
  const key = path.join(dir, 'hub-one.key');
  fs.writeFileSync(record, '{"v":1}\n');
  fs.writeFileSync(key, 'not a real key\n');
  const run = recorder(paths);
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'launchd', run });
  await update(['--to', '0.9.0-alpha.6'], d);
  assert.equal(fs.readFileSync(record, 'utf8'), '{"v":1}\n');
  assert.equal(fs.readFileSync(key, 'utf8'), 'not a real key\n');
});

test('a stop that fails refuses the install with nothing flipped', async (t) => {
  const paths = machine(t, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
  const plist = installUnit('launchd');
  const run = recorder(paths, { fail: () => 'Boot-out failed: 5: Input/output error' });
  let code = null;
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'launchd', run });
  d.exit = (c) => { code = c; };
  const res = await update(['--to', '0.9.0-alpha.6'], d);
  assert.deepEqual(res, { refused: true, reason: 'connector-running', error: 'Boot-out failed: 5: Input/output error' });
  assert.equal(code, 1);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.9.0-alpha.7', 'still on the build that can stop it');
  assert.ok(fs.existsSync(plist), 'the unit is left as it was');
  assert.deepEqual(run.argvs(), [BOOTOUT], 'no further call after the failed stop');
  const text = d.errlog.text();
  assert.match(text, /v0\.9\.0-alpha\.6 has no connect command, and the hub connector \(pid 4242\) could not be stopped/);
  assert.ok(text.includes(`Nothing was changed. Stop it with \`${BOOTOUT.join(' ')}\`, then run this again.`));
});

test('a connector running without a unit refuses a flip to a build without connect', async (t) => {
  const paths = machine(t, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
  const run = recorder(paths);
  let code = null;
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => CONNECTOR, serviceKind: 'launchd', run });
  d.exit = (c) => { code = c; };
  const res = await update(['--to', '0.9.0-alpha.6'], d);
  assert.equal(res.refused, true);
  assert.equal(res.reason, 'connector-running');
  assert.equal(code, 1);
  assert.equal(fs.readlinkSync(paths.current), 'versions/0.9.0-alpha.7');
  assert.deepEqual(run.argvs(), []);
  assert.match(d.errlog.text(), /Nothing was changed\. Stop it where `claude-web-chat connect run` runs/);
});

test('a unit left installed with no connector running is still removed before a flip to a build without connect', async (t) => {
  const paths = machine(t, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
  const plist = installUnit('launchd');
  // Not loaded: bootout fails, and with nothing running that is no reason to refuse.
  const run = recorder(paths, { fail: () => 'Boot-out failed: 3: No such process' });
  const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => null, serviceKind: 'launchd', run });
  const res = await update(['--to', '0.9.0-alpha.6'], d);
  assert.equal(res.after, '0.9.0-alpha.6');
  assert.deepEqual(run.argvs(), [BOOTOUT]);
  assert.equal(fs.existsSync(plist), false, 'a unit that would start a missing command at every login is not left behind');
  assert.deepEqual(res.connector, { restarted: false, stopped: true });
});

test('a stopped portal is named when the connector then refuses', async (t) => {
  const paths = machine(t, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
  installUnit('launchd');
  const run = recorder(paths, { fail: () => 'refused' });
  let code = null;
  const d = deps(paths, '0.9.0-alpha.7', {
    readConnector: () => CONNECTOR, serviceKind: 'launchd', run,
    readPortal: () => ({ role: 'portal', pid: 7, port: 45678 }),
    tunnelDown: async () => ({ stopped: true }),
  });
  d.exit = (c) => { code = c; };
  // 0.9.0-alpha.6 here has no tunnel command either, so the portal gate stops it first.
  const res = await update(['--to', '0.9.0-alpha.6'], d);
  assert.equal(res.reason, 'connector-running');
  assert.equal(code, 1);
  assert.match(d.errlog.text(), /The tunnel portal was stopped above; `claude-web-chat tunnel up` starts it again on this build\./);
});

// ── nothing registered ─────────────────────────────────────────────────────

test('no connector registered and no unit: update says and runs nothing more', async (t) => {
  const baseline = async (t2, extra) => {
    const paths = machine(t2, { from: '0.9.0-alpha.7', to: '0.9.0-alpha.6', toConnect: false });
    const run = recorder(paths);
    const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => null, serviceKind: 'launchd', run, ...extra });
    const res = await update(['--to', '0.9.0-alpha.6'], d);
    return { res, run, log: d.log.text(), err: d.errlog.text() };
  };
  await t.test('flip to a build without connect', async (t2) => {
    const r = await baseline(t2);
    assert.deepEqual(r.res, { before: '0.9.0-alpha.7', after: '0.9.0-alpha.6' });
    assert.deepEqual(r.run.argvs(), []);
    assert.doesNotMatch(r.log + r.err, /connector|hub access/i);
  });
  await t.test('flip to a build with connect', async (t2) => {
    const paths = machine(t2);
    const run = recorder(paths);
    const d = deps(paths, '0.9.0-alpha.7', { readConnector: () => null, serviceKind: 'launchd', run });
    const res = await update(['--to', '0.9.0-alpha.8'], d);
    assert.deepEqual(res, { before: '0.9.0-alpha.7', after: '0.9.0-alpha.8' });
    assert.deepEqual(run.argvs(), []);
    assert.doesNotMatch(d.log.text() + d.errlog.text(), /connector|hub access/i);
  });
  await t.test('a machine with no service manager', async (t2) => {
    const r = await baseline(t2, { serviceKind: null });
    assert.deepEqual(r.res, { before: '0.9.0-alpha.7', after: '0.9.0-alpha.6' });
    assert.deepEqual(r.run.argvs(), []);
  });
});

// ── pruneVersions keeps what a live daemon runs ─────────────────────────────

test('pruneVersions keeps a version named in inUse, however old', (t) => {
  withTempHome(t);
  const paths = installPaths();
  const versions = ['0.9.0-alpha.1', '0.9.0-alpha.2', '0.9.0-alpha.3', '0.9.0-alpha.4', '0.9.0-alpha.5'];
  for (const v of versions) fakeVersion(paths, v);
  activate('0.9.0-alpha.5', paths);
  // keep 1: four old versions are candidates; one of them a daemon still runs.
  const removed = pruneVersions({ keep: 1, paths, inUse: ['0.9.0-alpha.2'] });
  assert.deepEqual(removed, ['0.9.0-alpha.4', '0.9.0-alpha.3', '0.9.0-alpha.1']);
  assert.deepEqual(listVersions(paths), ['0.9.0-alpha.5', '0.9.0-alpha.2']);
  // Without inUse the same store loses it: the list is what protects it.
  const removed2 = pruneVersions({ keep: 1, paths });
  assert.deepEqual(removed2, ['0.9.0-alpha.2']);
});

test('pruneVersions ignores an inUse that is not a list of names', (t) => {
  withTempHome(t);
  const paths = installPaths();
  for (const v of ['0.9.0-alpha.1', '0.9.0-alpha.2', '0.9.0-alpha.3']) fakeVersion(paths, v);
  activate('0.9.0-alpha.3', paths);
  assert.deepEqual(pruneVersions({ keep: 1, paths, inUse: 'nope' }), ['0.9.0-alpha.2', '0.9.0-alpha.1']);
});

const ROWS = [
  { role: 'instance', root: '/p/live', pid: 11, port: 45001, package_version: '0.9.0-alpha.2', pid_alive: true, reachable: true },
  { role: 'instance', root: '/p/dead', pid: 12, port: 45002, package_version: '0.9.0-alpha.3', pid_alive: false, reachable: false },
  { role: 'instance', root: '/p/mute', pid: 13, port: 45003, package_version: '0.9.0-alpha.4', pid_alive: true, reachable: false },
  { role: 'instance', root: '/p/old', pid: 14, port: 45004, pid_alive: true, reachable: true },
  { role: 'instance', root: '/p/twin', pid: 15, port: 45005, package_version: '0.9.0-alpha.2', pid_alive: true, reachable: true },
];

test('update passes the package_version of live, reachable instance rows to pruneVersions, and of no dead row', async (t) => {
  const paths = machine(t);
  const seen = [];
  let asked = null;
  const d = deps(paths, '0.9.0-alpha.7', {
    readConnector: () => null,
    rows: async (o) => { asked = o; return ROWS; },
    pruneVersions: (o) => { seen.push(o); return []; },
  });
  await update(['--to', '0.9.0-alpha.8'], d);
  assert.deepEqual(asked, { role: 'instance' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].paths, paths);
  assert.deepEqual(seen[0].inUse, ['0.9.0-alpha.2'], 'alive AND reachable, once each; a dead or silent row protects nothing');
});

test('update keeps a version a live daemon runs through the real prune', async (t) => {
  withTempHome(t);
  inScratchCwd(t);
  const paths = installPaths();
  for (const v of ['0.9.0-alpha.1', '0.9.0-alpha.2', '0.9.0-alpha.3', '0.9.0-alpha.4', '0.9.0-alpha.5', '0.9.0-alpha.6']) fakeVersion(paths, v);
  activate('0.9.0-alpha.5', paths);
  linkBins(paths);
  const d = deps(paths, '0.9.0-alpha.5', { readConnector: () => null, rows: async () => ROWS });
  const res = await update(['--to', '0.9.0-alpha.6'], d);
  assert.equal(res.after, '0.9.0-alpha.6');
  // keep 3 (alpha.6, .5, .4); alpha.2 is a live daemon's; alpha.3 (dead row) and alpha.1 go.
  assert.deepEqual(listVersions(paths), ['0.9.0-alpha.6', '0.9.0-alpha.5', '0.9.0-alpha.4', '0.9.0-alpha.2']);
  assert.match(d.log.text(), /Pruned old versions: v0\.9\.0-alpha\.3, v0\.9\.0-alpha\.1/);
});

test('a registry that cannot be read protects nothing and fails nothing', async (t) => {
  const paths = machine(t);
  const seen = [];
  const d = deps(paths, '0.9.0-alpha.7', {
    readConnector: () => null,
    rows: async () => { throw new Error('registry torn'); },
    pruneVersions: (o) => { seen.push(o.inUse); return []; },
  });
  const res = await update(['--to', '0.9.0-alpha.8'], d);
  assert.equal(res.after, '0.9.0-alpha.8');
  assert.deepEqual(seen, [[]]);
});

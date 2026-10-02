// mcpSessionsFor(root) and the presence row's `interrupt` field — lib/util/registry.
//
// The chat mirror's discovery asks, every few seconds, which Claude Code sessions
// are attached to its project: the live role:'mcp' presence rows for its root.
// Pinned here:
//   * only rows for exactly this root, and only live ones (the MCP server's pid
//     AND its Claude Code parent alive: isLive); never a daemon, the hub, or a
//     nested project's session;
//   * READ-ONLY: dead rows are skipped, never pruned. instances.json is left byte
//     for byte as it was, not even replaced by an identical copy, and no lock is
//     taken (readMcpEntries, the pruning reader beside it, does write: the
//     contrast shows the check can fail);
//   * the root matches through its realpath (a symlinked root; macOS's /var);
//   * `interrupt` ('tty' | null) round-trips through registerMcp and updateMcp,
//     defaults to null and holds no other value; an unknown patch field is still
//     dropped; a row written before 0.8.5 has none and reads as null.
//
// Every test runs under a throwaway HOME (withTempHome).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { withTempHome } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { userPaths } = require('../lib/core/paths');

const DEAD_PID = 2 ** 30;

function project(t, name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wc-mcpsess-${name}-`)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A real, innocent process to hang a presence row off (a row needs a live pid).
function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child;
}

// Add rows to the file exactly as given, past registerMcp (whose write prunes
// dead rows): the dead and legacy rows a real registry accumulates.
function appendRaw(rows) {
  const file = registry.registryPath();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.instances.push(...rows);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const rawRow = (pid) => registry.readAllEntries().find((e) => e.id === registry.mcpId(pid));
const ids = (rows) => rows.map((r) => r.id).sort();

test('mcpSessionsFor: the live presence rows of exactly this root', (t) => {
  withTempHome(t);
  const here = project(t, 'here');
  const there = project(t, 'there');
  const nested = path.join(here, 'nested');
  fs.mkdirSync(path.join(nested, '.web-chat'), { recursive: true });
  const [second, elsewhere, inner, orphan] = [bystander(t), bystander(t), bystander(t), bystander(t)];

  registry.registerInstance({ root: here, port: 4321, pid: process.pid, title: 'here' });
  registry.registerHub({ port: 5170, pid: process.pid });
  registry.registerMcp({ root: here, pid: process.pid, ppid: process.ppid });
  registry.registerMcp({ root: here, pid: second.pid, ppid: process.pid, channel: true });
  registry.registerMcp({ root: there, pid: elsewhere.pid, ppid: process.pid });
  registry.registerMcp({ root: nested, pid: inner.pid, ppid: process.pid });
  appendRaw([
    // its MCP server is gone
    { id: `mcp:${DEAD_PID}`, role: 'mcp', root: here, pid: DEAD_PID, ppid: process.pid, started_at: 1, channel: false },
    // its MCP server lingers, its Claude Code is gone: the session is over
    { id: `mcp:${orphan.pid}`, role: 'mcp', root: here, pid: orphan.pid, ppid: DEAD_PID, started_at: 1, channel: false },
  ]);

  const rows = registry.mcpSessionsFor(here);
  assert.deepEqual(ids(rows), ids([{ id: `mcp:${process.pid}` }, { id: `mcp:${second.pid}` }]),
    'both live sessions, and neither the dead server nor the dead parent');
  for (const r of rows) {
    assert.equal(r.role, 'mcp');
    assert.equal(r.root, here);
    assert.equal(r.interrupt, null);
  }
  const bySecond = rows.find((r) => r.pid === second.pid);
  assert.equal(bySecond.ppid, process.pid, 'the Claude Code process, to join to its sessions file');
  assert.equal(bySecond.channel, true, 'the row as written');

  assert.deepEqual(ids(registry.mcpSessionsFor(there)), [`mcp:${elsewhere.pid}`]);
  assert.deepEqual(ids(registry.mcpSessionsFor(nested)), [`mcp:${inner.pid}`], 'a nested project\'s session is its own, not its parent\'s');
  assert.deepEqual(registry.mcpSessionsFor(path.join(here, 'no-such-dir')), []);
  for (const bad of ['', undefined, null, 42]) assert.deepEqual(registry.mcpSessionsFor(bad), [], String(bad));
});

test('mcpSessionsFor never writes: the dead rows stay, the bytes stay, no lock is taken', (t) => {
  withTempHome(t);
  const here = project(t, 'readonly');
  registry.registerMcp({ root: here, pid: process.pid, ppid: process.ppid });
  appendRaw([
    { id: `mcp:${DEAD_PID}`, role: 'mcp', root: here, pid: DEAD_PID, ppid: process.pid, started_at: 1, channel: false },
    { id: 'abcd1234', role: 'instance', root: here, pid: DEAD_PID, port: 1, started_at: 1 },
  ]);
  const file = registry.registryPath();
  const bytes = fs.readFileSync(file);
  const before = fs.statSync(file);

  const rows = registry.mcpSessionsFor(here);
  assert.deepEqual(ids(rows), [`mcp:${process.pid}`]);
  rows[0].channel = 'changed by the caller';
  registry.mcpSessionsFor(here);

  assert.ok(fs.readFileSync(file).equals(bytes), 'instances.json is byte-identical');
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino, 'not even replaced by an identical copy (an atomic write is a new inode)');
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(fs.existsSync(userPaths().instancesLock), false, 'no lock taken');
  assert.equal(registry.readAllEntries().length, 3, 'the dead rows are still in the file');
  assert.equal(registry.mcpSessionsFor(here)[0].channel, false, 'what a caller does to a row it was handed stays with it');

  // The contrast: the pruning reader beside it does write, so the check above
  // is one that can fail.
  registry.readMcpEntries();
  assert.equal(fs.readFileSync(file).equals(bytes), false, 'readMcpEntries pruned the dead rows');
});

test('mcpSessionsFor with no registry file creates none', (t) => {
  const home = withTempHome(t);
  const here = project(t, 'nofile');
  assert.deepEqual(registry.mcpSessionsFor(here), []);
  assert.equal(fs.existsSync(registry.registryPath()), false);
  assert.deepEqual(fs.readdirSync(home), [], 'not even ~/.web-chat');
});

test('mcpSessionsFor matches the root through its realpath', (t) => {
  withTempHome(t);
  const real = project(t, 'real');
  const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
  fs.symlinkSync(real, link);
  t.after(() => { try { fs.unlinkSync(link); } catch {} });
  const other = bystander(t);
  registry.registerMcp({ root: real, pid: process.pid, ppid: process.ppid });
  registry.registerMcp({ root: link, pid: other.pid, ppid: process.pid });

  const both = ids([{ id: `mcp:${process.pid}` }, { id: `mcp:${other.pid}` }]);
  assert.deepEqual(ids(registry.mcpSessionsFor(real)), both, 'a row recorded under the link is this root\'s');
  assert.deepEqual(ids(registry.mcpSessionsFor(link)), both, 'a daemon handed the link finds the session recorded under the real path');
  assert.deepEqual(ids(registry.mcpSessionsFor(real + path.sep)), both, 'a trailing separator');
  // macOS: os.tmpdir() is /var/folders/…, which is really /private/var/folders/…
  assert.deepEqual(ids(registry.mcpSessionsFor(path.join(os.tmpdir(), path.basename(real)))), both, 'the temp dir as os.tmpdir() spells it');
});

test('the presence row carries interrupt: null by default, \'tty\' when written, and no other value', (t) => {
  withTempHome(t);
  const here = project(t, 'interrupt');
  const [other, third] = [bystander(t), bystander(t)];

  const plain = registry.registerMcp({ root: here, pid: process.pid, ppid: process.ppid });
  assert.equal(plain.interrupt, null, 'registerMcp\'s default');
  assert.equal('interrupt' in rawRow(process.pid), true, 'written to the file as null, not left out');
  assert.equal(rawRow(process.pid).interrupt, null);
  assert.equal(registry.registerMcp({ root: here, pid: other.pid, ppid: process.pid, interrupt: 'tty' }).interrupt, 'tty');
  assert.equal(registry.registerMcp({ root: here, pid: third.pid, ppid: process.pid, interrupt: 'yes' }).interrupt, null, 'only \'tty\'');
  const seen = () => Object.fromEntries(registry.mcpSessionsFor(here).map((r) => [r.pid, r.interrupt]));
  assert.deepEqual(seen(), { [process.pid]: null, [other.pid]: 'tty', [third.pid]: null }, 'mcpSessionsFor returns it');

  // updateMcp whitelists it beside channel and last_tool_at.
  assert.equal(registry.updateMcp(process.pid, { interrupt: 'tty' }), true);
  assert.equal(rawRow(process.pid).interrupt, 'tty');
  registry.updateMcp(process.pid, { channel: true, last_tool_at: 7 });
  assert.equal(rawRow(process.pid).interrupt, 'tty', 'a patch without it leaves it as it was');
  registry.updateMcp(other.pid, { interrupt: 'TTY' });
  assert.equal(rawRow(other.pid).interrupt, null, 'any other value is null');
  registry.updateMcp(third.pid, { interrupt: 'tty' });
  registry.updateMcp(third.pid, { interrupt: null });
  assert.equal(rawRow(third.pid).interrupt, null, 'and back');

  // An unknown patch field is still dropped, and the fields the writer does not
  // own do not move.
  registry.updateMcp(process.pid, { interrupt: 'tty', bogus: 1, pid: 1, ppid: 1, root: '/elsewhere', role: 'instance', started_at: 0 });
  const row = rawRow(process.pid);
  assert.equal(row.interrupt, 'tty');
  assert.equal('bogus' in row, false, 'unknown field dropped');
  assert.deepEqual({ pid: row.pid, ppid: row.ppid, root: row.root, role: row.role, started_at: row.started_at },
    { pid: process.pid, ppid: process.ppid, root: here, role: 'mcp', started_at: plain.started_at });
  assert.deepEqual({ channel: row.channel, last_tool_at: row.last_tool_at }, { channel: true, last_tool_at: 7 });
  assert.deepEqual(seen(), { [process.pid]: 'tty', [other.pid]: null, [third.pid]: null });
});

test('a presence row written before 0.8.5 has no interrupt, and reads as null', (t) => {
  withTempHome(t);
  const here = project(t, 'legacy');
  const other = bystander(t);
  registry.registerMcp({ root: here, pid: process.pid, ppid: process.ppid });
  const file = registry.registryPath();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete data.instances[0].interrupt;
  data.instances.push({ id: `mcp:${other.pid}`, role: 'mcp', root: here, pid: other.pid, ppid: process.pid, started_at: 1, channel: false, interrupt: 'sudo' });
  fs.writeFileSync(file, JSON.stringify(data));
  const bytes = fs.readFileSync(file);

  const rows = registry.mcpSessionsFor(here);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.interrupt, null, `${r.id}: a missing or unknown value is null`);
  assert.ok(fs.readFileSync(file).equals(bytes), 'normalised in the copy handed back, never written back');
});

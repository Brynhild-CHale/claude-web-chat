// Machine-wide sessions: which projects have a web-chat surface, which have a
// Claude Code session attached, and the one classifier that joins the two.
//
// The presence half is the MCP server process itself — Claude Code spawns one per
// session and kills it at exit — writing a role:'mcp' row into the user registry
// for exactly as long as it lives (lib/mcp/presence.js). Pinned here:
//   * a real MCP subprocess registers at startup with NO daemon anywhere, and
//     its row goes when stdin closes or on SIGTERM;
//   * a dead pid (or a dead Claude Code parent) is dropped on read;
//   * sessions() joins daemon rows and presence rows per root, both directions;
//   * readInstances()/rows() — the hub, `ls --reap`, the extension picker — see
//     daemons only, exactly as before;
//   * enrichSessions() reads the turn/viewers/active facts from a real daemon;
//   * last_tool_at writes are throttled and never on the call path;
//   * `ls` prints the VERSION / CLAUDE / TURN / VIEWERS columns and `--json`, `status` its line;
//   * each side's web-chat release rides every row, and a Claude session on a
//     different release than its surface says which side to restart.
//
// Every test runs under a throwaway HOME (withTempHome), so nothing here reads
// or writes the developer's ~/.web-chat.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { withServer, withTempHome, waitUntil } = require('../test-support/helpers');
const registry = require('../lib/util/registry');
const { startPresence } = require('../lib/mcp/presence');
const { startChannelBridge } = require('../lib/channel/bridge');
const ls = require('../lib/cli/commands/ls');
const status = require('../lib/cli/commands/status');
const { packageVersion, PROTOCOL_VERSION } = require('../lib/core/versions');

const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
const DEAD_PID = 2 ** 30;

function project(t, name = 'p') {
  // realpath: the MCP subprocess resolves its root from process.cwd(), which is
  // always the real path (/private/var/... on macOS, not /var/...).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wc-sess-${name}-`)));
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// A real, innocent process to hang a second presence row off (a registry row
// needs a live pid to survive the read).
function bystander(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return child;
}

function sink() {
  const lines = [];
  const fn = (s) => lines.push(String(s));
  fn.text = () => lines.join('\n');
  return fn;
}

function spawnMcp(t, { cwd, home, channel = false, preload = null }) {
  const child = spawn(process.execPath, preload ? ['--require', preload, MCP_BIN] : [MCP_BIN], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_CHANNEL: channel ? '1' : '', WEB_CHAT_PORT: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return { child, exited };
}

const mcpRow = (pid) => registry.readMcpEntries().find((e) => e.pid === pid);

// ──────────────────────────────────────── the real MCP process ────

test('MCP server: registers a presence row at startup with no daemon, drops it when stdin closes', async (t) => {
  const home = withTempHome(t);
  const root = project(t, 'mcp-stdin');
  const { child, exited } = spawnMcp(t, { cwd: root, home });

  const row = await waitUntil(() => mcpRow(child.pid), { timeout: 10_000, what: 'the MCP presence row' });
  assert.equal(row.role, 'mcp');
  assert.equal(row.id, `mcp:${child.pid}`);
  assert.equal(row.root, root);
  assert.equal(row.ppid, process.pid, 'ppid is the process that spawned it (Claude Code, in life)');
  assert.equal(row.channel, false);
  assert.equal(typeof row.started_at, 'number');
  assert.equal(row.package_version, packageVersion(), 'the release this MCP server loaded, for the sessions view');
  assert.equal(row.version, PROTOCOL_VERSION, '`version` stays the protocol number');
  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'server.json')), false, 'no daemon was spawned to say so');

  child.stdin.end();
  await waitUntil(() => !mcpRow(child.pid), { timeout: 10_000, what: 'the row to go on stdin close' });
  await exited;
});

test('MCP server: SIGTERM removes the row and still exits', async (t) => {
  const home = withTempHome(t);
  const root = project(t, 'mcp-term');
  const { child, exited } = spawnMcp(t, { cwd: root, home });
  await waitUntil(() => mcpRow(child.pid), { timeout: 10_000, what: 'the MCP presence row' });

  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143, 'the signal still ends the process');
  // Read RAW: a pruning read would drop a dead pid's row anyway and prove nothing.
  assert.equal(registry.readAllEntries().some((e) => e.pid === child.pid), false,
    'the row was removed by the process on its way out, not pruned after');
});

test('MCP server: a SIGTERM the instant the row lands is still caught — the handler is armed before the row is written', async (t) => {
  const home = withTempHome(t);
  const root = project(t, 'mcp-term-race');
  // Deterministic stand-in for "the harness saw the row and killed at once":
  // signal ourselves synchronously inside registerMcp. With no listener armed
  // yet, the OS default kills the process (code null) and the row outlives it.
  const preload = path.join(root, 'term-on-register.js');
  fs.writeFileSync(preload, `const reg = require(${JSON.stringify(require.resolve('../lib/util/registry'))});
const orig = reg.registerMcp;
reg.registerMcp = function (...a) { const r = orig.apply(this, a); process.kill(process.pid, 'SIGTERM'); return r; };\n`);
  const { child, exited } = spawnMcp(t, { cwd: root, home, preload });
  const { code } = await exited;
  assert.equal(code, 143, 'the SIGTERM handler ran, not the default action');
  assert.equal(registry.readAllEntries().some((e) => e.pid === child.pid), false, 'no orphaned presence row');
});

// The channel end to end, and the reason stdin closing is its own trigger: with
// a daemon up, the bridge's open wake stream keeps the process's event loop
// alive after Claude Code hangs up, so 'exit' alone would leave the row behind
// for as long as the socket lasts.
test('MCP server: channel:true while the bridge holds a wake stream; the row goes on hang-up even while the stream is open', async (t) => {
  const { root, home } = await withServer(t, { writePortfile: true, root: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sess-chan-'))) });
  const { child } = spawnMcp(t, { cwd: root, home, channel: true });

  const row = await waitUntil(() => { const r = mcpRow(child.pid); return r && r.channel ? r : null; },
    { timeout: 10_000, what: 'the presence row to report a live channel' });
  assert.equal(row.root, root);

  child.stdin.end();
  await waitUntil(() => !mcpRow(child.pid), { timeout: 10_000, what: 'the row to go on stdin close' });
});

// ─────────────────────────────────────────── registry rules ────

test('presence rows: a dead pid, or a dead Claude Code parent, is dropped on read', (t) => {
  withTempHome(t);
  const root = project(t, 'dead');
  registry.registerMcp({ root, pid: process.pid, ppid: process.ppid });
  registry.registerMcp({ root, pid: DEAD_PID, ppid: process.pid });
  // Live child, dead parent: the session is over even if the child lingers.
  const file = registry.registryPath();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.instances.push({ id: 'mcp:orphan', role: 'mcp', root, pid: process.pid, ppid: DEAD_PID, started_at: 1 });
  fs.writeFileSync(file, JSON.stringify(data));

  const live = registry.readMcpEntries();
  assert.deepEqual(live.map((e) => e.id), [`mcp:${process.pid}`]);
  assert.equal(registry.readAllEntries().length, 1, 'and the dead rows were pruned from the file');
});

test('readInstances()/rows() stay daemons-only with presence rows in the file', async (t) => {
  withTempHome(t);
  const root = project(t, 'roles');
  registry.registerInstance({ root, port: 1, pid: process.pid, title: 'inst' });
  registry.registerHub({ port: 5170, pid: process.pid });
  registry.registerMcp({ root, pid: process.pid, ppid: process.ppid });

  assert.deepEqual(registry.readInstances().map((e) => e.role), ['instance']);
  assert.deepEqual((await registry.rows({ probe: false })).map((e) => e.title), ['inst']);
  assert.equal(registry.readHubEntry().id, 'hub');
  assert.equal(registry.readMcpEntries().length, 1);
});

test('deregisterMcp removes only its own row', (t) => {
  withTempHome(t);
  const root = project(t, 'dereg');
  const other = bystander(t);
  registry.registerMcp({ root, pid: process.pid, ppid: process.ppid });
  registry.registerMcp({ root, pid: other.pid, ppid: process.pid });
  assert.equal(registry.deregisterMcp({ pid: process.pid }), true);
  assert.deepEqual(registry.readMcpEntries().map((e) => e.pid), [other.pid]);
});

// ─────────────────────────────────────────── sessions() ────

test('sessions(): two presence rows on one root count as two sessions, joined to its daemon', (t) => {
  withTempHome(t);
  const root = project(t, 'both');
  const other = bystander(t);
  registry.registerInstance({ root, port: 4321, pid: process.pid, title: 'both' });
  registry.registerMcp({ root, pid: process.pid, ppid: process.ppid });
  registry.registerMcp({ root, pid: other.pid, ppid: process.pid });
  registry.updateMcp(other.pid, { channel: true, last_tool_at: 5000 });

  const rows = registry.sessions();
  assert.equal(rows.length, 1, 'one row per project root');
  const [r] = rows;
  assert.equal(r.title, 'both');
  assert.deepEqual(
    { running: r.surface.running, port: r.surface.port, pid: r.surface.pid },
    { running: true, port: 4321, pid: process.pid });
  assert.equal(r.claude.sessions, 2);
  assert.deepEqual(r.claude.pids.sort(), [process.pid, other.pid].sort());
  assert.equal(r.claude.channel, true, 'any live channel makes the project channel-connected');
  assert.equal(r.claude.last_tool_at, 5000);
});

test('sessions(): an MCP-only project has surface null; a daemon-only project has claude null', (t) => {
  withTempHome(t);
  const mcpOnly = project(t, 'mcponly');
  const daemonOnly = project(t, 'daemononly');
  registry.registerMcp({ root: mcpOnly, pid: process.pid, ppid: process.ppid });
  registry.registerInstance({ root: daemonOnly, port: 4322, pid: process.pid, title: 'daemononly' });

  const by = Object.fromEntries(registry.sessions().map((r) => [r.root, r]));
  assert.equal(by[mcpOnly].surface, null);
  assert.equal(by[mcpOnly].claude.sessions, 1);
  assert.equal(by[mcpOnly].title, path.basename(mcpOnly));
  assert.equal(by[daemonOnly].claude, null);
  assert.equal(by[daemonOnly].surface.running, true);
});

// ──────────────────────────────────────── channel + throttle ────

test('presence: setChannel flips the row; the bridge reports its stream opening and closing', async (t) => {
  withTempHome(t);
  const root = project(t, 'chan');
  const p = startPresence({ root });
  t.after(() => p.stop());
  assert.equal(mcpRow(process.pid).channel, false);
  p.setChannel(true);
  assert.equal(mcpRow(process.pid).channel, true);
  p.setChannel(false);
  assert.equal(mcpRow(process.pid).channel, false);

  // The bridge side: onConnection hears open (true) then close (false).
  let opts;
  const client = {
    get: async () => ({ boot: 'b1' }),
    post: async () => ({}),
    subscribeSSE: (o) => { opts = o; return { close() {} }; },
  };
  const seen = [];
  const bridge = startChannelBridge({ notify: async () => {}, client, root, onConnection: (up) => seen.push(up) });
  t.after(() => bridge.stop());
  await waitUntil(() => opts, { what: 'the bridge to subscribe' });
  opts.onOpen();
  opts.onClose();
  assert.deepEqual(seen, [true, false]);
});

test('presence: last_tool_at is written at most once per interval, and off the call path', (t) => {
  let clock = 1_000;
  const writes = [];
  const deferred = [];
  const reg = {
    registerMcp: () => {},
    deregisterMcp: () => {},
    updateMcp: (pid, patch) => writes.push(patch),
  };
  const p = startPresence({ root: '/x', pid: 42, now: () => clock, intervalMs: 10_000, defer: (fn) => deferred.push(fn), reg });

  assert.equal(p.touch(), true);
  assert.equal(writes.length, 0, 'nothing is written synchronously inside the tool call');
  deferred.splice(0).forEach((fn) => fn());
  assert.deepEqual(writes, [{ last_tool_at: 1_000 }]);

  clock += 9_999;
  assert.equal(p.touch(), false, 'inside the window: no write');
  clock += 1;
  assert.equal(p.touch(), true, 'window elapsed: one more');
  deferred.splice(0).forEach((fn) => fn());
  assert.deepEqual(writes.map((w) => w.last_tool_at), [1_000, 11_000]);

  p.stop();
  clock += 60_000;
  assert.equal(p.touch(), false, 'stopped: never resurrects the row');
});

// ──────────────────────────────────────── daemon enrichment ────

test('enrichSessions(): viewers, the turn lock, the active label and last commit from a real daemon', async (t) => {
  const { api, port, root } = await withServer(t);
  const realRoot = fs.realpathSync(root);
  registry.registerInstance({ root: realRoot, port, pid: process.pid, title: 'live' });
  registry.registerMcp({ root: realRoot, pid: process.pid, ppid: process.ppid });

  // One committed turn, so there is an active node with a label.
  await api.post('/api/turn-begin', { message: 'first' });
  await api.post('/api/render', { id: 'p1', html: '<p>x</p>' });
  await api.post('/api/turn-end', {});
  let [r] = await registry.enrichSessions(registry.sessions(), { timeoutMs: 2000 });
  assert.equal(r.surface.reachable, true);
  assert.equal(r.surface.viewers, 0);
  assert.equal(r.surface.turn, null, 'no lock held between turns');
  assert.match(r.surface.active_label, /^n\d+(\.\d+)+$/);
  assert.equal(typeof r.surface.last_commit_at, 'number');
  assert.equal(r.claude.sessions, 1, 'the registry half rides through untouched');

  await api.post('/api/turn-begin', { message: 'second' });
  [r] = await registry.enrichSessions(registry.sessions(), { timeoutMs: 2000 });
  assert.equal(r.surface.turn, 'mid-turn');
  assert.equal(typeof r.surface.turn_started_at, 'number');
});

test('enrichSessions(): a wake lock reads "wake", a stale lock reads as no turn, an impostor as unreachable', async () => {
  const row = (pid = 7) => ({ root: '/r', title: 'r', surface: { running: true, port: 9, url: 'u', pid }, claude: null });
  const health = (extra) => async () => ({ ok: true, pid: 7, viewers: 2, ...extra });

  let [r] = await registry.enrichSessions([row()], { get: health({ lock: { author: 'wake', started_at: 1 } }) });
  assert.equal(r.surface.turn, 'wake');
  [r] = await registry.enrichSessions([row()], { get: health({ lock: { author: 'user', started_at: 1 }, lock_stale: true }) });
  assert.equal(r.surface.turn, null, 'a lock past its TTL is not a turn in progress');
  [r] = await registry.enrichSessions([row(8)], { get: health({}) });
  assert.equal(r.surface.reachable, false, 'the port answers as a different pid');
  [r] = await registry.enrichSessions([row()], { get: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual({ reachable: r.surface.reachable, port: r.surface.port }, { reachable: false, port: 9 },
    'unreachable is reported, never dropped');
  const bare = { root: '/m', title: 'm', surface: null, claude: { sessions: 1 } };
  [r] = await registry.enrichSessions([bare], { get: async () => { throw new Error('must not probe'); } });
  assert.equal(r, bare, 'a row with no surface is not probed');
});

// ──────────────────────────────────────────────── ls + status ────

test('ls: CLAUDE / TURN / VIEWERS columns, a session-only project, and --json', async (t) => {
  const { api, port, root } = await withServer(t);
  const surfaced = fs.realpathSync(root);
  const sessionOnly = project(t, 'lsonly');
  const other = bystander(t);
  registry.registerInstance({ root: surfaced, port, pid: process.pid, title: 'surfaced' });
  registry.registerMcp({ root: surfaced, pid: process.pid, ppid: process.ppid });
  registry.registerMcp({ root: surfaced, pid: other.pid, ppid: process.pid });
  registry.updateMcp(other.pid, { channel: true });
  registry.registerMcp({ root: sessionOnly, pid: bystander(t).pid, ppid: process.pid });
  await api.post('/api/turn-begin', { message: 'x' });

  const log = sink();
  await ls([], { log, here: surfaced, timeoutMs: 2000 });
  const out = log.text();
  assert.match(out, /PROJECT +SURFACE +VERSION +CLAUDE +TURN +VIEWERS/);
  const line = out.split('\n').find((l) => /^ {2}surfaced /.test(l));
  assert.match(line, /● 2 · channel +mid-turn +0 +←/);
  assert.ok(line.includes(` v${packageVersion()} `), 'the surface\'s release, from its /api/health');
  assert.doesNotMatch(out, /⚠/, 'one release on both sides: no restart hint');
  const only = out.split('\n').find((l) => l.includes(path.basename(sessionOnly)) && /●/.test(l));
  assert.match(only, /— +v\S+ +● 1\b/, 'a project with a session and no surface is listed');
  assert.match(out, /no surface — `claude-web-chat open` there starts one/);

  const jlog = sink();
  await ls(['--json'], { log: jlog, here: null, timeoutMs: 2000 });
  const parsed = JSON.parse(jlog.text());
  const by = Object.fromEntries(parsed.sessions.map((r) => [r.root, r]));
  assert.equal(by[surfaced].claude.sessions, 2);
  assert.equal(by[surfaced].surface.turn, 'mid-turn');
  assert.equal(by[sessionOnly].surface, null);
  assert.deepEqual(parsed.stale, []);

  await assert.rejects(ls(['--json', '--reap'], { log: sink(), here: null }), /does not combine/);
});

test('status: the Claude line for this project', async (t) => {
  withTempHome(t);
  const root = project(t, 'status');
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await status([], { cwd: root });
    registry.registerMcp({ root, pid: process.pid, ppid: process.ppid });
    registry.updateMcp(process.pid, { channel: true });
    await status([], { cwd: root });
  } finally { console.log = prev; }
  const claude = lines.filter((l) => l.startsWith('Claude:'));
  assert.equal(claude.length, 2);
  assert.match(claude[0], /no Claude Code session attached/);
  assert.match(claude[1], /● 1 session attached · channel on · since \d+s ago · no tool call yet/);
});

// ──────────────────────────────────────────────── versions ────

test('sessions(): each side\'s release; a skew only when a Claude session differs from its surface', (t) => {
  withTempHome(t);
  const same = project(t, 'same');
  const skewed = project(t, 'skewed');
  const other = bystander(t);
  const third = bystander(t);
  registry.registerInstance({ root: same, port: 1, pid: process.pid, title: 'same' });
  registry.registerMcp({ root: same, pid: process.pid, ppid: process.ppid });
  registry.registerInstance({ root: skewed, port: 2, pid: other.pid, title: 'skewed' });
  // Two sessions started before an update (0.6.9), one after.
  registry.registerMcp({ root: skewed, pid: other.pid, ppid: process.pid, package_version: '0.6.9' });
  registry.registerMcp({ root: skewed, pid: third.pid, ppid: process.pid, package_version: '0.6.9' });
  registry.registerMcp({ root: skewed, pid: bystander(t).pid, ppid: process.pid, package_version: packageVersion() });

  const v = packageVersion();
  const by = Object.fromEntries(registry.sessions().map((r) => [r.root, r]));
  assert.equal(by[same].surface.package_version, v, 'the daemon\'s release, as the registry recorded it');
  assert.deepEqual(by[same].claude.package_versions, [{ version: v, sessions: 1 }]);
  assert.equal(by[same].version_skew, null, 'one release on both sides: no skew');

  assert.deepEqual(by[skewed].claude.package_versions.map((x) => x.sessions).sort(), [1, 2]);
  assert.deepEqual(by[skewed].version_skew, { surface: v, sessions: 3, stale: [{ version: '0.6.9', sessions: 2, restart: 'claude' }] });
  assert.equal(registry.versionNote(by[skewed].version_skew),
    `2 of 3 Claude sessions are on v0.6.9 — restart them to pick up v${v}`);
});

test('versionSkew / versionNote: which side is behind, all or some sessions, and nothing without both versions', () => {
  const row = (sv, list, sessions) => ({ surface: sv === undefined ? null : { package_version: sv },
    claude: list ? { sessions: sessions || list.reduce((n, x) => n + x.sessions, 0), package_versions: list } : null });
  const skew = (...a) => registry.versionSkew(row(...a));

  assert.equal(registry.versionNote(skew('0.8.0', [{ version: '0.6.9', sessions: 1 }])),
    'Claude is on v0.6.9 — restart Claude Code to pick up v0.8.0');
  assert.equal(registry.versionNote(skew('0.8.0', [{ version: '0.8.0', sessions: 1 }, { version: '0.6.9', sessions: 1 }])),
    '1 of 2 Claude sessions is on v0.6.9 — restart it to pick up v0.8.0');
  assert.equal(registry.versionNote(skew('0.6.9', [{ version: '0.8.0', sessions: 1 }])),
    'the surface is on v0.6.9, Claude on v0.8.0 — run `claude-web-chat restart` in this project to pick up v0.8.0');
  // Two dev builds of one release: a string difference is still a skew.
  const dev = skew('0.8.0-dev.202609280101.aaaaaaa', [{ version: '0.8.0-dev.202609270101.bbbbbbb', sessions: 1 }]);
  assert.equal(dev.stale[0].restart, 'claude');
  assert.match(registry.versionNote(dev), /^Claude is on v0\.8\.0-dev\.202609270101\.bbbbbbb — restart Claude Code/);

  assert.equal(skew(undefined, [{ version: '0.6.9', sessions: 1 }]), null, 'no surface, nothing to compare against');
  assert.equal(skew(null, [{ version: '0.6.9', sessions: 1 }]), null, 'a daemon that recorded no release');
  assert.equal(skew('0.8.0', [], 1), null, 'a session that recorded no release');
  assert.equal(skew('0.8.0', null), null);
  assert.equal(registry.versionNote(null), null);
});

test('enrichSessions(): the daemon\'s own release replaces the registry\'s; an older daemon keeps the registry\'s', async () => {
  const row = () => ({ root: '/r', title: 'r', surface: { running: true, port: 9, url: 'u', pid: 7, package_version: '0.6.9' },
    claude: { sessions: 1, package_versions: [{ version: '0.8.1', sessions: 1 }] } });
  let [r] = await registry.enrichSessions([row()], { get: async () => ({ ok: true, pid: 7, package_version: '0.8.1' }) });
  assert.equal(r.surface.package_version, '0.8.1');
  assert.equal(r.version_skew, null, 'the skew is recomputed from what the daemon said');
  [r] = await registry.enrichSessions([row()], { get: async () => ({ ok: true, pid: 7 }) });
  assert.equal(r.surface.package_version, '0.6.9', 'a daemon predating the field: the registry\'s record stands');
  assert.equal(r.version_skew.stale[0].restart, 'surface', 'and a surface behind Claude says to restart the surface');
  [r] = await registry.enrichSessions([row()], { get: async () => ({ ok: true, pid: 7, package_version: '<b>x</b> much too long for a release string, really, far too long here' }) });
  assert.equal(r.surface.package_version, '0.6.9', 'a malformed version is not repeated');
});

// R8-2. A 0.7.x daemon records no release in the registry and its health
// carries only the protocol number — so after an update, every other project's
// old daemon beside a reopened 0.8 Claude session (whose write_markdown 404s
// there) showed a blank VERSION and no ⚠. A daemon that answers but names no
// release anywhere is a pre-0.8 build, and the skew says the surface is behind.
test('enrichSessions(): a daemon that names no release anywhere is pre-0.8 — the skew says restart the surface', async () => {
  const row = (claude = { sessions: 2, package_versions: [{ version: '0.8.0', sessions: 2 }] }) => ({
    root: '/r', title: 'r', surface: { running: true, port: 9, url: 'u', pid: 7, package_version: null }, claude });
  const legacyHealth = async () => ({ ok: true, version: PROTOCOL_VERSION, viewers: 1 });   // 0.7.6's shape: no pid, no package_version

  const [r] = await registry.enrichSessions([row()], { get: legacyHealth });
  assert.equal(r.surface.reachable, true);
  assert.equal(r.surface.legacy_build, true);
  assert.equal(r.surface.package_version, null, 'no release is invented for it');
  assert.deepEqual(r.version_skew, { surface: registry.LEGACY_BUILD, sessions: 2, stale: [{ version: '0.8.0', sessions: 2, restart: 'surface' }] },
    'the same skew shape the Sessions panel and the picker already render');
  assert.equal(registry.LEGACY_BUILD, '<0.8');
  assert.equal(registry.versionNote(r.version_skew),
    'the surface is on a build older than 0.8, Claude on v0.8.0 — run `claude-web-chat restart` in this project to pick up v0.8.0');

  const [alone] = await registry.enrichSessions([row(null)], { get: legacyHealth });
  assert.equal(alone.surface.legacy_build, true);
  assert.equal(alone.version_skew, null, 'no Claude session: nothing to be skewed against');

  const [down] = await registry.enrichSessions([row()], { get: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.surface.legacy_build, undefined, 'a daemon that did not answer is not called old');
  assert.equal(down.version_skew, null);
  const [impostor] = await registry.enrichSessions([row()], { get: async () => ({ ok: true, pid: 8 }) });
  assert.equal(impostor.surface.legacy_build, undefined, 'nor is one answering as a different pid');
  const [odd] = await registry.enrichSessions([row()], { get: async () => ({ ok: true, pid: 7, package_version: '<b>' + 'x'.repeat(80) }) });
  assert.equal(odd.surface.legacy_build, undefined, 'a daemon that DID name a (malformed) release is not a pre-0.8 one');
});

test('an inactive project remembers the release it last ran', (t) => {
  withTempHome(t);
  const root = project(t, 'asleep');
  registry.rememberProject({ root, title: 'asleep', now: 1, package_version: '0.6.9' });
  const [r] = registry.sessions();
  assert.equal(registry.isInactive(r), true);
  assert.equal(r.last_package_version, '0.6.9');
});

test('ls: the ⚠ restart hint names the stale sessions, only on a mismatch', async (t) => {
  const { port, root } = await withServer(t);
  const surfaced = fs.realpathSync(root);
  registry.registerInstance({ root: surfaced, port, pid: process.pid, title: 'surfaced' });
  registry.registerMcp({ root: surfaced, pid: process.pid, ppid: process.ppid, package_version: '0.6.9' });
  const log = sink();
  await ls([], { log, here: surfaced, timeoutMs: 2000 });
  const out = log.text();
  assert.ok(out.includes(`⚠ Claude is on v0.6.9 — restart Claude Code to pick up v${packageVersion()}`), out);
  assert.match(out, /⚠ marks a Claude session on a different web-chat release/);

  const jlog = sink();
  await ls(['--json'], { log: jlog, here: null, timeoutMs: 2000 });
  const [row] = JSON.parse(jlog.text()).sessions;
  assert.equal(row.surface.package_version, packageVersion());
  assert.deepEqual(row.version_skew.stale, [{ version: '0.6.9', sessions: 1, restart: 'claude' }]);
});

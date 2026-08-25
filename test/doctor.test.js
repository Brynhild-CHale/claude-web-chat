const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const doctor = require('../lib/cli/commands/doctor');
const { withTempHome, withServer } = require('../test-support/helpers');
const { recordMcpSeen } = require('../lib/core/mcp-seen');

// doctor now probes the capture hub on the fixed hub port. Pin it, for the whole
// file, at a port nothing is listening on so the check is deterministic and never
// picks up a hub the developer happens to be running.
process.env.WEB_CHAT_HUB_PORT = '65533';

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-doctor-'));
  fs.mkdirSync(path.join(dir, '.web-chat', 'graph'), { recursive: true });
  return dir;
}

// A project root PLUS a sandboxed HOME. doctor reads user-tier state now (the
// user disable marker, the cross-project instance registry) — without the
// sandbox the suite would read, and prune-write, the developer's real
// ~/.web-chat.
function project(t) {
  withTempHome(t);
  return tmpProject();
}

// A runClaude that never shells out — records the argv it would have run.
function fakeClaude(result = { ok: true }) {
  const calls = [];
  return { fn: (argv) => { calls.push(argv); return result; }, calls };
}

const silent = () => {};

test('doctor removes a stale portfile (dead pid)', async (t) => {
  const root = project(t);
  // Portfile pointing at a pid that cannot exist.
  fs.writeFileSync(
    path.join(root, '.web-chat', 'server.json'),
    JSON.stringify({ pid: 999999999, port: 65111, url: 'http://localhost:65111' })
  );
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  assert.equal(fs.existsSync(path.join(root, '.web-chat', 'server.json')), false);
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && /stale portfile/.test(c.m)));
});

test('doctor clears an orphaned graph lock from _meta.json when daemon is down', async (t) => {
  const root = project(t);
  const metaPath = path.join(root, '.web-chat', 'graph', '_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ active: null, lock: { base: null, started_at: 0, author: 'user' } }));
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.lock, null);
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && /orphaned graph lock/.test(c.m)));
});

test('doctor clears even a fresh-looking persisted lock when the daemon is down', async (t) => {
  // Daemon down ⇒ the lock has no live holder regardless of age, so doctor
  // clears it (a running daemon is the only place a fresh lock is honored).
  const root = project(t);
  const metaPath = path.join(root, '.web-chat', 'graph', '_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ active: null, lock: { base: null, started_at: Date.now(), author: 'user' } }));
  const claude = fakeClaude();
  await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.lock, null, 'orphaned lock cleared');
});

test('doctor detects and repairs a bare (unresolvable) MCP registration', async (t) => {
  const root = project(t);
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'web-chat': { command: 'claude-web-chat-mcp' } } })
  );
  const claude = fakeClaude({ ok: true });
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  assert.ok(summary.checks.some((c) => c.status === 'problem' && /not resolvable/.test(c.m)));
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && /local scope/.test(c.m)));
  // The repair shells out to the right command, at local scope, with `node <abs>`.
  assert.equal(claude.calls.length, 1);
  const argv = claude.calls[0];
  assert.deepEqual(argv.slice(0, 6), ['mcp', 'add', 'web-chat', '--scope', 'local', '--']);
  assert.equal(argv[6], 'node');
  assert.ok(path.isAbsolute(argv[7]) && /bin\/claude-web-chat-mcp\.js$/.test(argv[7]));
});

test('doctor treats a resolved `node <abs>` MCP registration as healthy', async (t) => {
  const root = project(t);
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin] } } })
  );
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  assert.equal(claude.calls.length, 0, 'no repair should run for a resolvable entry');
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /resolvable/.test(c.m)));
});

// doctor detects + REMOVES a stale channels env block. The polarity inverted in
// the 0.4.x release pass: pinning WEB_CHAT_CHANNEL=1 into .mcp.json makes the MCP
// server start a channel bridge in every session, including ones launched without
// the capability flag — so a Push is written to stdout, self-acked, reported
// "Delivered to Claude ✓", and dropped, while the parked fallback never runs.
// The env now belongs only on the launch line that also carries the flag.
test('doctor removes a stale WEB_CHAT_CHANNEL from a web-chat entry', async (t) => {
  const root = project(t);
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  const mcpPath = path.join(root, '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin], env: { WEB_CHAT_CHANNEL: '1' } } } }));
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  assert.ok(summary.checks.some((c) => c.status === 'problem' && /stale WEB_CHAT_CHANNEL/.test(c.m)));
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && /removed WEB_CHAT_CHANNEL/.test(c.m)));
  const entry = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers['web-chat'];
  assert.equal(entry.env, undefined, 'no empty env block left behind');
});

test('doctor preserves unrelated env keys when removing the stale channels env', async (t) => {
  const root = project(t);
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  const mcpPath = path.join(root, '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin], env: { DEBUG: 'wc:*', WEB_CHAT_CHANNEL: '1' } } } }));
  const claude = fakeClaude();
  await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const entry = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers['web-chat'];
  assert.equal(entry.env.WEB_CHAT_CHANNEL, undefined);
  assert.equal(entry.env.DEBUG, 'wc:*');
});

test('doctor reports ok (no write) when there is no stale channels env', async (t) => {
  const root = project(t);
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  const mcpPath = path.join(root, '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin] } } }, null, 2));
  const before = fs.readFileSync(mcpPath, 'utf8');
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /no stale channels env/.test(c.m)));
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), before, '.mcp.json left byte-identical');
});

test('doctor cleans a stale env even from a ${CLAUDE_PLUGIN_ROOT} plugin stub', async (t) => {
  const root = project(t);
  const mcpPath = path.join(root, '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'], env: { WEB_CHAT_CHANNEL: '1' } } } }, null, 2));
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  // A committed stub carrying the opt-in is exactly as broken as any other
  // entry — the bridge reads the env, not the arg style — so it is repaired too.
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && /removed WEB_CHAT_CHANNEL/.test(c.m)));
  const entry = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers['web-chat'];
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'], 'portable args untouched');
  assert.equal(entry.env, undefined);
});

// ---------------------------------------------------------------------------
// The switch. Every other check can be green while web-chat is simply OFF.
// ---------------------------------------------------------------------------

test('doctor reports the DISABLED toggle instead of sending you to debug a switched-off system', async (t) => {
  const root = project(t);
  const { userPaths } = require('../lib/core/paths');
  const u = userPaths();
  fs.mkdirSync(u.root, { recursive: true });
  fs.writeFileSync(u.disabled, '');

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /DISABLED by the user scope/.test(c.m));
  assert.ok(hit, 'the disabled state is reported');
  assert.equal(hit.status, 'problem');
  assert.match(hit.m, /claude-web-chat on --global/, 'names the exact re-enable command');
});

test('doctor reports the project-scope disable marker too', async (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, '.web-chat', 'disabled'), '');
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /DISABLED by the project scope/.test(c.m));
  assert.ok(hit && hit.status === 'problem');
});

test('doctor confirms the toggle is clear when nothing is disabled', async (t) => {
  const root = project(t);
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /web-chat is enabled/.test(c.m)));
});

// ---------------------------------------------------------------------------
// The $HOME disable-marker collision. Verified live before fixing: running
// `claude-web-chat off` in a sandboxed $HOME printed "web-chat disabled for
// project <$HOME>" and wrote ~/.web-chat/disabled — after which an unrelated
// project resolved {"enabled":false,"by":"user"}.
// ---------------------------------------------------------------------------

test('doctor explains the $HOME collision: the project marker IS the user marker', async (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.web-chat', 'graph'), { recursive: true });
  // Exactly the byte `claude-web-chat off` writes when cwd is $HOME.
  fs.writeFileSync(path.join(home, '.web-chat', 'disabled'), '');

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: home, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /home directory/.test(c.m) && /EVERY project/.test(c.m));
  assert.ok(hit, 'the collision is named, not just the disabled state');
  assert.equal(hit.status, 'problem');
  assert.match(hit.m, /on --global/, 'names the fix that actually clears it');
  // And the toggle line correctly blames the USER scope, not the project.
  assert.ok(summary.checks.some((c) => /DISABLED by the user scope/.test(c.m)));
});

test('doctor flags the latent $HOME collision even with no marker written yet', async (t) => {
  const home = withTempHome(t);
  fs.mkdirSync(path.join(home, '.web-chat', 'graph'), { recursive: true });
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: home, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /home directory/.test(c.m));
  assert.ok(hit, 'the latent trap is named');
  assert.equal(hit.status, 'note', 'latent, not currently broken');
  assert.match(hit.m, /would disable web-chat for every project/);
});

test('doctor says nothing about a $HOME collision for an ordinary project root', async (t) => {
  const root = project(t);
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  assert.ok(!summary.checks.some((c) => /home directory/.test(c.m)));
});

// ---------------------------------------------------------------------------
// Is anyone LOOKING, and can a capture get here?
// ---------------------------------------------------------------------------

test('doctor warns when the daemon is up but no browser is watching', async (t) => {
  const { root } = await withServer(t, { writePortfile: true });
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /no browser is watching/.test(c.m));
  assert.ok(hit, `expected a viewer warning; got ${JSON.stringify(summary.checks.map((c) => c.m))}`);
  assert.equal(hit.status, 'problem');
  assert.match(hit.m, /claude-web-chat open/);
});

test('doctor reports the watching browsers when one is connected', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  const sock = ctx.ws();
  await new Promise((resolve, reject) => {
    sock.on('message', (d) => { try { if (JSON.parse(d.toString()).type === 'hello') resolve(); } catch {} });
    sock.on('error', reject);
  });
  t.after(() => { try { sock.close(); } catch {} });

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: ctx.root, runClaude: claude.fn, log: silent });
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /browser\(s\) watching/.test(c.m)));
  assert.ok(!summary.checks.some((c) => /no browser is watching/.test(c.m)));
});

test('doctor examines the capture path — hub reachability and ingest gating', async (t) => {
  const { root } = await withServer(t, { writePortfile: true });
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  // The hub port is pinned at a dead port for this file.
  const hub = summary.checks.find((c) => /capture hub/.test(c.m));
  assert.ok(hub, 'the hub is examined at all');
  assert.equal(hub.status, 'problem');
  assert.match(hub.m, /65533/, 'names the port the extension talks to');
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /capture ingest is open/.test(c.m)));
});

test('doctor warns that a configured capture token gates every ingest', async (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, '.web-chat', 'capture-token'), 'sekrit\n');
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /token-gated/.test(c.m));
  assert.ok(hit, 'the token is examined');
  assert.match(hit.m, /X-WC-Token/);
});

// ---------------------------------------------------------------------------
// Restart detection: install rewrote .mcp.json, but Claude Code reads that file
// only at startup — so until the user restarts, none of the 23 tools exist.
// ---------------------------------------------------------------------------

function registerMcp(root) {
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin] } } }, null, 2)
  );
}

test('doctor tells the user to restart when the MCP server predates the .mcp.json write', async (t) => {
  const root = project(t);
  registerMcp(root);
  // The MCP server we last heard from booted an hour before .mcp.json changed.
  recordMcpSeen(root, { startedAt: Date.now() - 3600_000, now: Date.now() - 60_000 });

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /restart Claude Code/i.test(c.m));
  assert.ok(hit, `expected a restart warning; got ${JSON.stringify(summary.checks.map((c) => c.m))}`);
  assert.equal(hit.status, 'problem');
  assert.match(hit.m, /tool list predates/);
});

test('doctor confirms the restart when the MCP server started after the write', async (t) => {
  const root = project(t);
  registerMcp(root);
  recordMcpSeen(root, { startedAt: Date.now() + 5000, now: Date.now() });

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /has restarted since \.mcp\.json changed/.test(c.m)));
  assert.ok(!summary.checks.some((c) => /restart Claude Code/i.test(c.m)));
});

test("doctor says \"can't tell\" — never \"you did not restart\" — when no MCP client was ever seen", async (t) => {
  const root = project(t);
  registerMcp(root);

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /can't tell whether Claude Code has restarted/.test(c.m));
  assert.ok(hit, 'the honest not-knowing is reported');
  assert.equal(hit.status, 'note', 'a "can\'t tell" must never be counted as a problem');
  assert.match(hit.m, /no web-chat tool has been used yet/, 'names the innocent explanation too');
});

test('doctor prefers the live daemon sighting over the on-disk one', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  registerMcp(ctx.root);
  // Tag a request as an MCP server started AFTER .mcp.json was written.
  await ctx.api.get('/api/health', { 'X-WC-Client': 'mcp', 'X-WC-MCP-Started': String(Date.now() + 5000) });
  // Then rot the persisted copy, so only the live daemon still knows the truth.
  recordMcpSeen(ctx.root, { startedAt: Date.now() - 3600_000, now: Date.now() - 3600_000 });

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: ctx.root, runClaude: claude.fn, log: silent });
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /has restarted since \.mcp\.json changed/.test(c.m)));
});

// Boot a real hub on the pinned port so the "hub is up" branch — which is where
// the instance-registration check lives — is exercised too.
async function withHub(t) {
  const { createHub } = require('../lib/hub');
  const hub = createHub({ port: Number(process.env.WEB_CHAT_HUB_PORT) });
  await new Promise((resolve, reject) => {
    const onError = (e) => { hub.server.off('error', onError); reject(e); };
    hub.server.once('error', onError);
    hub.server.listen(Number(process.env.WEB_CHAT_HUB_PORT), '127.0.0.1', () => { hub.server.off('error', onError); resolve(); });
  });
  t.after(async () => { try { await new Promise((r) => hub.server.close(r)); } catch {} });
  return hub;
}

test('doctor confirms the hub AND this project being registered with it', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  await withHub(t);
  const { registerInstance } = require('../lib/util/registry');
  registerInstance({ root: ctx.root, port: ctx.port, pid: process.pid, title: 'x' });

  const claude = fakeClaude();
  const summary = await doctor([], { cwd: ctx.root, runClaude: claude.fn, log: silent });
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /capture hub answering/.test(c.m)));
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /registered with the hub/.test(c.m)));
});

test('doctor warns when the hub is up but this project is not in the instance registry', async (t) => {
  const ctx = await withServer(t, { writePortfile: true });
  await withHub(t);
  // Deliberately NOT registered — the hub cannot resolve a capture to us.
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: ctx.root, runClaude: claude.fn, log: silent });
  const hit = summary.checks.find((c) => /NOT in the instance registry/.test(c.m));
  assert.ok(hit, `expected a registry warning; got ${JSON.stringify(summary.checks.map((c) => c.m))}`);
  assert.equal(hit.status, 'problem');
});

// ── dryRun ────────────────────────────────────────────────────────────────────
// `claude-web-chat init --report` and `/web-chat init` both promise the caller
// they change nothing. doctor is otherwise a REPAIRER — it deletes portfiles,
// clears locks, rewrites hook commands, strips a stale env out of .mcp.json and
// shells out to `claude mcp add` — so each of those five write paths is guarded
// and reported as "would repair" instead. If any of these guards regresses, a
// read-only report silently mutates the user's project.

test('doctor --dryRun leaves a stale portfile in place and says it would repair it', async (t) => {
  const root = project(t);
  const portfile = path.join(root, '.web-chat', 'server.json');
  fs.writeFileSync(portfile, JSON.stringify({ pid: 999999999, port: 65111, url: 'http://localhost:65111' }));
  const claude = fakeClaude();

  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent, dryRun: true });

  assert.equal(fs.existsSync(portfile), true, 'dryRun must NOT delete the portfile');
  const hit = summary.checks.find((c) => /stale portfile/.test(c.m));
  assert.ok(hit, 'the check still runs');
  assert.equal(hit.dry, true, 'and is tagged as a repair that did not happen');
});

test('doctor --dryRun leaves an orphaned graph lock in _meta.json', async (t) => {
  const root = project(t);
  const metaPath = path.join(root, '.web-chat', 'graph', '_meta.json');
  const before = JSON.stringify({ active: null, lock: { base: null, started_at: 0, author: 'user' } });
  fs.writeFileSync(metaPath, before);
  const claude = fakeClaude();

  await doctor([], { cwd: root, runClaude: claude.fn, log: silent, dryRun: true });

  assert.equal(fs.readFileSync(metaPath, 'utf8'), before, 'dryRun must not rewrite _meta.json');
});

test('doctor --dryRun never shells out to `claude mcp add`', async (t) => {
  const root = project(t);
  // A bare, PATH-dependent MCP entry: the repair path doctor exists for.
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'web-chat': { command: 'claude-web-chat-mcp' } } }, null, 2)
  );
  const claude = fakeClaude();

  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent, dryRun: true });

  assert.equal(claude.calls.length, 0, 'a read-only run must not register anything with Claude Code');
  assert.ok(summary.checks.some((c) => c.dry && /register web-chat at local scope/.test(c.m)));
});

test('doctor --dryRun does not strip a stale WEB_CHAT_CHANNEL from .mcp.json', async (t) => {
  const root = project(t);
  const mcpPath = path.join(root, '.mcp.json');
  const mcpBin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  const before = JSON.stringify({
    mcpServers: { 'web-chat': { command: 'node', args: [mcpBin], env: { WEB_CHAT_CHANNEL: '1' } } },
  }, null, 2);
  fs.writeFileSync(mcpPath, before);
  const claude = fakeClaude();

  await doctor([], { cwd: root, runClaude: claude.fn, log: silent, dryRun: true });

  assert.equal(fs.readFileSync(mcpPath, 'utf8'), before, 'dryRun must not rewrite .mcp.json');
});

test('doctor --dryRun does not rewrite a bare hook command in .claude/settings.json', async (t) => {
  const root = project(t);
  const settingsPath = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const before = JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] }] },
  }, null, 2);
  fs.writeFileSync(settingsPath, before);
  const claude = fakeClaude();

  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent, dryRun: true });

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), before, 'dryRun must not rewrite settings.json');
  assert.ok(summary.checks.some((c) => c.dry && /rewrote the web-chat hook command/.test(c.m)));
});

test('doctor WITHOUT dryRun still repairs — the guard is opt-in, not a behaviour change', async (t) => {
  const root = project(t);
  const portfile = path.join(root, '.web-chat', 'server.json');
  fs.writeFileSync(portfile, JSON.stringify({ pid: 999999999, port: 65111 }));
  const claude = fakeClaude();

  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  assert.equal(fs.existsSync(portfile), false, 'the default is still to repair');
  const hit = summary.checks.find((c) => /stale portfile/.test(c.m));
  assert.equal(hit.dry, undefined, 'a real repair is not tagged dry');
});

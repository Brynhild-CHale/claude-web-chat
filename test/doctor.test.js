const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const doctor = require('../lib/cli/commands/doctor');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-doctor-'));
  fs.mkdirSync(path.join(dir, '.web-chat', 'graph'), { recursive: true });
  return dir;
}

// A runClaude that never shells out — records the argv it would have run.
function fakeClaude(result = { ok: true }) {
  const calls = [];
  return { fn: (argv) => { calls.push(argv); return result; }, calls };
}

const silent = () => {};

test('doctor removes a stale portfile (dead pid)', async () => {
  const root = tmpProject();
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

test('doctor clears an orphaned graph lock from _meta.json when daemon is down', async () => {
  const root = tmpProject();
  const metaPath = path.join(root, '.web-chat', 'graph', '_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ active: null, lock: { base: null, started_at: 0, author: 'user' } }));
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.lock, null);
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && /orphaned graph lock/.test(c.m)));
});

test('doctor clears even a fresh-looking persisted lock when the daemon is down', async () => {
  // Daemon down ⇒ the lock has no live holder regardless of age, so doctor
  // clears it (a running daemon is the only place a fresh lock is honored).
  const root = tmpProject();
  const metaPath = path.join(root, '.web-chat', 'graph', '_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ active: null, lock: { base: null, started_at: Date.now(), author: 'user' } }));
  const claude = fakeClaude();
  await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.lock, null, 'orphaned lock cleared');
});

test('doctor detects and repairs a bare (unresolvable) MCP registration', async () => {
  const root = tmpProject();
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

test('doctor treats a resolved `node <abs>` MCP registration as healthy', async () => {
  const root = tmpProject();
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

// doctor detects + repairs a missing channels env block.
test('doctor wires WEB_CHAT_CHANNEL=1 into a web-chat entry that lacks it', async () => {
  const root = tmpProject();
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  const mcpPath = path.join(root, '.mcp.json');
  // Resolvable entry, but no env — the pre-channels-wiring install shape.
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin] } } }));
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });

  assert.ok(summary.checks.some((c) => c.status === 'problem' && /channels env not wired/.test(c.m)));
  assert.ok(summary.checks.some((c) => c.status === 'repaired' && /WEB_CHAT_CHANNEL=1/.test(c.m)));
  const entry = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers['web-chat'];
  assert.equal(entry.env.WEB_CHAT_CHANNEL, '1');
});

test('doctor preserves unrelated env keys when repairing the channels env', async () => {
  const root = tmpProject();
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  const mcpPath = path.join(root, '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin], env: { DEBUG: 'wc:*' } } } }));
  const claude = fakeClaude();
  await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  const entry = JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers['web-chat'];
  assert.equal(entry.env.WEB_CHAT_CHANNEL, '1');
  assert.equal(entry.env.DEBUG, 'wc:*');
});

test('doctor reports ok (no write) when the channels env is already wired', async () => {
  const root = tmpProject();
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  const mcpPath = path.join(root, '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin], env: { WEB_CHAT_CHANNEL: '1' } } } }, null, 2));
  const before = fs.readFileSync(mcpPath, 'utf8');
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  assert.ok(summary.checks.some((c) => c.status === 'ok' && /channels env .*wired/.test(c.m)));
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), before, '.mcp.json left byte-identical');
});

test('doctor never edits a ${CLAUDE_PLUGIN_ROOT} plugin stub to add env', async () => {
  const root = tmpProject();
  const mcpPath = path.join(root, '.mcp.json');
  const stub = JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] } } }, null, 2);
  fs.writeFileSync(mcpPath, stub);
  const claude = fakeClaude();
  const summary = await doctor([], { cwd: root, runClaude: claude.fn, log: silent });
  // Env-wiring is a note (leaving the stub alone), not a repair — the committed stub stays pure.
  assert.ok(summary.checks.some((c) => c.status === 'note' && /plugin stub/.test(c.m)));
  assert.ok(!summary.checks.some((c) => c.status === 'repaired' && /WEB_CHAT_CHANNEL/.test(c.m)));
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), stub, 'plugin stub left byte-identical');
});

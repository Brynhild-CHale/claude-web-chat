const test = require('node:test');
const assert = require('node:assert');

// the channels line in `status`. describeChannels is the pure phrasing core —
// given the stale-env flag and the /api/queue/policy body, it returns the
// layman-facing state + line status prints.
//
// The polarity here INVERTED in the 0.4.x release pass. Channels is a property
// of the SESSION (Claude Code launched with the capability flag), not of the
// project, so a WEB_CHAT_CHANNEL pinned into .mcp.json is no longer the desired
// state — it is a defect that makes the MCP server start a channel bridge in
// sessions with no channel behind it, so a Push self-acks as delivered and is
// dropped instead of parked. The live policy is now the only real signal.
const { describeChannels } = require('../lib/cli/commands/status');

test('stale env: a pinned WEB_CHAT_CHANNEL is reported as a defect to repair', () => {
  const r = describeChannels({ staleEnv: true, policy: null });
  assert.equal(r.state, 'stale-env');
  assert.match(r.line, /stale WEB_CHAT_CHANNEL/);
  assert.match(r.line, /claude-web-chat doctor/);
});

test('stale env wins even if the policy shows connected — the wiring still needs cleaning', () => {
  const r = describeChannels({ staleEnv: true, policy: { channel_connected: true } });
  assert.equal(r.state, 'stale-env');
});

test('connected: a channel-enabled session is actually attached', () => {
  const r = describeChannels({ staleEnv: false, policy: { channel_connected: true } });
  assert.equal(r.state, 'connected');
  assert.equal(r.line, 'connected');
});

test('parked: daemon up, no channel connected — states the real fallback', () => {
  const r = describeChannels({ staleEnv: false, policy: { channel_connected: false } });
  assert.equal(r.state, 'parked');
  assert.match(r.line, /delivers with your next message/);
});

test('parked: daemon down (no policy observable) reads the same way', () => {
  const r = describeChannels({ staleEnv: false, policy: null });
  assert.equal(r.state, 'parked');
  assert.match(r.line, /delivers with your next message/);
});

// --------------------------------------------------------------------------
// The MCP restart line. `install` rewrites .mcp.json mid-session, Claude Code
// reads it only at startup, so "registered in .mcp.json" alone is a lie of
// omission — none of the 23 tools exist until the user restarts.
// --------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const status = require('../lib/cli/commands/status');
const { withTempHome, tmpRoot } = require('../test-support/helpers');
const { recordMcpSeen } = require('../lib/core/mcp-seen');

// Run `status` against an installed project, capturing stdout. The root is
// PASSED, not chdir'd into: status resolves it through the registration engine
// like every other command, so a test no longer has to mutate global process
// state to point it somewhere.
async function runStatus(t, seed) {
  withTempHome(t);
  const root = tmpRoot('wc-status-');
  fs.mkdirSync(path.join(root, '.web-chat', 'graph'), { recursive: true });
  const bin = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [bin] } } }, null, 2)
  );
  if (seed) seed(root);

  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await status([], { cwd: root });
  } finally {
    console.log = prevLog;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  return lines.join('\n');
}

test('status flags RESTART when the MCP server we last saw predates the .mcp.json write', async (t) => {
  const out = await runStatus(t, (root) => {
    recordMcpSeen(root, { startedAt: Date.now() - 3600_000, now: Date.now() - 60_000 });
  });
  assert.match(out, /MCP: +registered in \.mcp\.json/);
  assert.match(out, /RESTART:/, 'the restart verdict rides right under the MCP line');
  assert.match(out, /restart Claude Code/i);
});

test('status reports the tools loaded once an MCP server started after the write', async (t) => {
  const out = await runStatus(t, (root) => {
    recordMcpSeen(root, { startedAt: Date.now() + 5000, now: Date.now() });
  });
  assert.match(out, /loaded:/);
  assert.doesNotMatch(out, /RESTART:/);
});

test('status admits "unknown" rather than guessing when no MCP client was ever seen', async (t) => {
  const out = await runStatus(t);
  assert.match(out, /unknown:/);
  assert.match(out, /can't tell/);
  assert.doesNotMatch(out, /RESTART:/);
});

// cli-setup-6, status's half. This line used to count handler GROUPS while
// doctor counted individual handlers — two numbers for the same file, and
// neither noticed a MISSING event. The turn lifecycle needs both:
// UserPromptSubmit takes the lock, Stop commits the node. A project with only
// UserPromptSubmit reported "1 hook(s) registered" and looked healthy while no
// turn ever committed. status now reports per event, off the template's key
// set, and names what is absent.
test('status names the missing hook EVENT rather than reporting a smaller count', async (t) => {
  const hookBin = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
  const out = await runStatus(t, (root) => {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${hookBin}" turn-begin` }] }] },
    }, null, 2));
  });
  assert.match(out, /Hooks: +1\/2 registered/, 'both template events are counted, not just the ones on disk');
  assert.match(out, /missing: Stop/, 'and the absent one is named');
  assert.match(out, /claude-web-chat install/, 'with the command that repairs it');
});

test('status reports both hook events registered when both are present', async (t) => {
  const hookBin = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');
  const out = await runStatus(t, (root) => {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${hookBin}" turn-begin` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `node "${hookBin}" turn-end` }] }],
      },
    }, null, 2));
  });
  assert.match(out, /Hooks: +2\/2 registered/);
  assert.doesNotMatch(out, /missing:/);
  assert.doesNotMatch(out, /bare command:/);
});

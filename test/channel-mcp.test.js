// Commit 4 — the env-gated channel capability on the MCP entrypoint. A normal
// session (WEB_CHAT_CHANNEL unset) must be byte-identical: no experimental
// capability, all 23 tools intact. With WEB_CHAT_CHANNEL=1 the server declares
// experimental['claude/channel'] (the right to push notifications/claude/channel).
//
// Exercised as a real subprocess via the MCP SDK stdio client (index.js runs
// main() on import), mirroring mcp-dispatch.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');

function mkTmp(prefix = 'wc-mcp-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function installedProject() {
  const dir = mkTmp('wc-proj-');
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

async function launchMcp(t, { cwd, home, channel }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    cwd,
    // WEB_CHAT_CHANNEL set explicitly (spread last so it wins over any inherited
    // value — the "off" case must be off regardless of the dev's shell).
    env: { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_CHANNEL: channel ? '1' : '' },
  });
  const client = new Client({ name: 'channel-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test('channel OFF (default): no experimental capability, tools intact', async (t) => {
  const client = await launchMcp(t, { cwd: installedProject(), home: mkTmp(), channel: false });
  const caps = client.getServerCapabilities();
  assert.ok(!(caps && caps.experimental && caps.experimental['claude/channel']), 'no channel capability when off');
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23, 'tool set unchanged');
});

test('channel ON (WEB_CHAT_CHANNEL=1): declares experimental[claude/channel]', async (t) => {
  const client = await launchMcp(t, { cwd: installedProject(), home: mkTmp(), channel: true });
  const caps = client.getServerCapabilities();
  assert.ok(caps.experimental, 'experimental capabilities present');
  assert.deepEqual(caps.experimental['claude/channel'], {}, 'claude/channel declared');
  // Tools still work — the channel is additive to the existing MCP server.
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
});

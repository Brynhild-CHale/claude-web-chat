// Smoke coverage for the MCP entrypoint (lib/mcp/index.js): tool listing +
// dispatch + the user/project toggle gate. Exercised as a real subprocess via the
// MCP SDK stdio client (index.js runs main() on import and calls process.exit, so
// it can't be required in-process). Isolated with a tmp HOME and a tmp cwd; the
// gate/unknown-tool paths short-circuit before any handler, so no real daemon is
// ever spawned.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');

function mkTmp(prefix = 'wc-mcp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function installedProject() {
  const dir = mkTmp('wc-proj-');
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

async function launchMcp(t, { cwd, home }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    cwd,
    // env spread last so HOME wins over the SDK's default-environment HOME.
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const client = new Client({ name: 'phase0-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test('tools/list returns the full tool set with well-formed entries', async (t) => {
  const client = await launchMcp(t, { cwd: installedProject(), home: mkTmp() });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
  const names = new Set(tools.map((x) => x.name));
  for (const n of ['render', 'clear', 'export', 'get_theme', 'get_captures', 'inspect_capture']) {
    assert.ok(names.has(n), `missing tool ${n}`);
  }
  for (const x of tools) {
    assert.ok(x.name, 'tool has a name');
    assert.ok(x.description && x.description.length > 0, `${x.name} has a description`);
    assert.equal(typeof x.inputSchema, 'object', `${x.name} has an inputSchema`);
  }
});

test('tools/call disabled at project scope -> disabled envelope, no --flag', async (t) => {
  const client = await launchMcp(t, { cwd: mkTmp(), home: mkTmp() }); // cwd has no .web-chat
  const res = await client.callTool({ name: 'render', arguments: {} });
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.disabled, true);
  assert.equal(payload.scope, 'project');
  assert.ok(!payload.hint.includes('--'), 'project hint carries no scope flag');
});

test('tools/call disabled at user scope beats project and appends --user', async (t) => {
  const home = mkTmp();
  fs.mkdirSync(path.join(home, '.web-chat'), { recursive: true });
  fs.writeFileSync(path.join(home, '.web-chat', 'disabled'), '');
  const client = await launchMcp(t, { cwd: installedProject(), home }); // project installed & enabled
  const res = await client.callTool({ name: 'render', arguments: {} });
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.scope, 'user');
  assert.match(payload.hint, /--user/);
});

test('tools/call unknown tool while enabled -> error, no daemon spawned', async (t) => {
  const cwd = installedProject();
  const client = await launchMcp(t, { cwd, home: mkTmp() });
  const res = await client.callTool({ name: 'nope', arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(res.content[0].text, 'Unknown tool: nope');
  // dispatch short-circuits before any handler, so the lazy daemon never starts
  assert.equal(fs.existsSync(path.join(cwd, '.web-chat', 'server.json')), false);
});

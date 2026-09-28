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
// lib/mcp/tools/ is the one home of "which tools exist"; doc-truth reads it.
const { mcpTools } = require('../test-support/doc-truth');

const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');

function mkTmp(prefix = 'wc-mcp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function installedProject() {
  const dir = mkTmp('wc-proj-');
  fs.mkdirSync(path.join(dir, '.web-chat'), { recursive: true });
  return dir;
}

async function launchMcp(t, { cwd, home, env = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    cwd,
    // env spread last so HOME wins over the SDK's default-environment HOME.
    env: { ...process.env, ...env, HOME: home, USERPROFILE: home },
  });
  const client = new Client({ name: 'phase0-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

test('tools/list returns the full tool set with well-formed entries', async (t) => {
  const client = await launchMcp(t, { cwd: installedProject(), home: mkTmp() });
  const { tools } = await client.listTools();
  // Names, not just a count: what the SDK exposes IS lib/mcp/tools/, so a tool
  // file that never made it into the `tools` array in lib/mcp/index.js fails
  // here instead of shipping invisible.
  assert.deepEqual(tools.map((x) => x.name).sort(), mcpTools());
  for (const x of tools) {
    assert.ok(x.name, 'tool has a name');
    assert.ok(x.description && x.description.length > 0, `${x.name} has a description`);
    assert.equal(typeof x.inputSchema, 'object', `${x.name} has an inputSchema`);
  }
});

// FLIPPED, deliberately. This asserted only that the hint carries no scope flag,
// which locked in an instruction that cannot work: for a directory with no
// .web-chat/ the project scope reports "disabled" (correct for the hooks, which
// must exit silently), and the dispatcher turned that into "Run
// `claude-web-chat on`" — which answers "web-chat is not disabled for this
// project" and changes nothing. The hint must name a command that would change
// the state, so the two cases are now distinguished by reason.
test('tools/call in an UNINSTALLED project names init, not `on`', async (t) => {
  const client = await launchMcp(t, { cwd: mkTmp(), home: mkTmp() }); // cwd has no .web-chat
  const res = await client.callTool({ name: 'render', arguments: {} });
  assert.equal(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.disabled, true);
  assert.equal(payload.scope, 'project');
  assert.equal(payload.reason, 'not-installed');
  assert.match(payload.hint, /claude-web-chat init/);
  assert.ok(!payload.hint.includes('--'), 'project hint carries no scope flag');
});

test('tools/call disabled BY THE MARKER still points at `claude-web-chat on`', async (t) => {
  const cwd = installedProject();
  fs.writeFileSync(path.join(cwd, '.web-chat', 'disabled'), '');
  const client = await launchMcp(t, { cwd, home: mkTmp() });
  const res = await client.callTool({ name: 'render', arguments: {} });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.scope, 'project');
  assert.equal(payload.reason, 'marker');
  assert.match(payload.hint, /claude-web-chat on/);
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

// H-3. After an update, a Claude Code session reopened in ANOTHER project runs
// the new tools against that project's old daemon, which answers a route it
// never had with Express's default 404 page. That reached Claude as
// `Error: POST /api/markdown → 404: <!DOCTYPE html>…` and nothing more. The
// fake daemon here is plain Express with one route that answers its own 404 as
// JSON, the way every real route does, which must keep its own message.
test('tools/call: a 404 on a route the daemon lacks names `claude-web-chat restart`', async (t) => {
  const express = require('express');
  const app = express();
  app.get('/api/store', (req, res) => res.status(404).json({ error: 'no store here' }));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); });
  const cwd = installedProject();
  // WEB_CHAT_CHANNEL off: the channel bridge would otherwise probe the fake
  // daemon whenever the runner's own shell has it on.
  const client = await launchMcp(t, { cwd, home: mkTmp(), env: { WEB_CHAT_PORT: String(srv.address().port), WEB_CHAT_CHANNEL: '0' } });

  const res = await client.callTool({ name: 'write_markdown', arguments: { text: '# hi' } });
  assert.equal(res.isError, true);
  assert.equal(res.content.length, 1, 'no build notice from a checkout');
  assert.match(res.content[0].text, /^Error: POST \/api\/markdown → 404: /);
  assert.match(res.content[0].text, /`claude-web-chat restart` in this project/);
  assert.doesNotMatch(res.content[0].text, /<html|Cannot POST/i, 'the HTML page is dropped');

  const own = await client.callTool({ name: 'get_store', arguments: {} });
  assert.equal(own.isError, true);
  assert.match(own.content[0].text, /no store here/, 'a route that answers its own 404 keeps its message');
  assert.doesNotMatch(own.content[0].text, /claude-web-chat restart/);
  // The port came from WEB_CHAT_PORT, so no daemon was spawned into the project.
  assert.equal(fs.existsSync(path.join(cwd, '.web-chat', 'server.json')), false);
});

// The "did the user restart Claude Code after install rewrote .mcp.json?" engine
// (lib/core/mcp-seen.js) plus the daemon-side recording that feeds it.
//
// Why it exists: Claude Code reads .mcp.json only at process start. `install`
// writes that file mid-session, so until the user restarts NONE of the 23 MCP
// tools exist — while every other health check stays green. The only evidence a
// restart happened is the start time of the MCP SERVER process Claude Code
// spawned, which lib/mcp/client stamps onto its daemon requests.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withServer } = require('../test-support/helpers');
const {
  describeRestart, readMcpSeen, recordMcpSeen, mcpIdentityFromHeaders,
  mcpClientHeaders, mcpWrittenAt, seenFile,
} = require('../lib/core/mcp-seen');

const MIN = 60_000;

test('describeRestart: never seen an MCP client -> honest "can\'t tell", not a verdict', () => {
  const now = Date.now();
  const r = describeRestart({ seen: null, mcpWrittenAt: now - MIN, now });
  assert.equal(r.state, 'unknown');
  assert.match(r.line, /can't tell/);
  // Names the cheap thing to try AND why a never-used session looks the same.
  assert.match(r.line, /reopen/);
  assert.match(r.line, /no web-chat tool has been used yet/);
});

test('describeRestart: an MCP server started BEFORE the .mcp.json write is provably stale', () => {
  const now = Date.now();
  const r = describeRestart({
    seen: { seen_at: now - 1000, started_at: now - 10 * MIN },
    mcpWrittenAt: now - 2 * MIN,
    now,
  });
  assert.equal(r.state, 'stale');
  assert.match(r.line, /restart Claude Code/i);
  assert.match(r.line, /tool list predates/);
});

test('describeRestart: an MCP server started AFTER the .mcp.json write proves a restart', () => {
  const now = Date.now();
  const r = describeRestart({
    seen: { seen_at: now - 1000, started_at: now - MIN },
    mcpWrittenAt: now - 5 * MIN,
    now,
  });
  assert.equal(r.state, 'fresh');
  assert.match(r.line, /has restarted/);
});

test('describeRestart: a sighting with no start time is never called stale', () => {
  // An older record (or a request that lost the header) can only bound the
  // answer from below — claiming "you did not restart" from it would be a guess.
  const now = Date.now();
  const r = describeRestart({
    seen: { seen_at: now - 10 * MIN, started_at: null },
    mcpWrittenAt: now - 2 * MIN,
    now,
  });
  assert.equal(r.state, 'unknown');
  assert.match(r.line, /did not report its start time/);
});

test('describeRestart: a start-time-less sighting AFTER the write still proves a live client', () => {
  const now = Date.now();
  const r = describeRestart({
    seen: { seen_at: now - MIN, started_at: null },
    mcpWrittenAt: now - 5 * MIN,
    now,
  });
  assert.equal(r.state, 'fresh');
});

test('describeRestart: no .mcp.json at all is its own state', () => {
  const r = describeRestart({ seen: null, mcpWrittenAt: null });
  assert.equal(r.state, 'no-mcp');
});

test('mcpClientHeaders only stamps identity inside the MCP server process', () => {
  assert.equal(mcpClientHeaders({ env: {}, startedAt: 1 }), undefined, 'CLI/hook must not be counted');
  const h = mcpClientHeaders({ env: { WEB_CHAT_MCP_SERVER: '1' }, startedAt: 1234 });
  assert.equal(h['X-WC-Client'], 'mcp');
  assert.equal(h['X-WC-MCP-Started'], '1234');
});

test('mcpIdentityFromHeaders ignores requests that are not from an MCP server', () => {
  assert.equal(mcpIdentityFromHeaders({}), null);
  assert.equal(mcpIdentityFromHeaders({ 'x-wc-client': 'cli' }), null);
  assert.deepEqual(mcpIdentityFromHeaders({ 'x-wc-client': 'mcp', 'x-wc-mcp-started': '99' }), { startedAt: 99 });
  assert.deepEqual(mcpIdentityFromHeaders({ 'x-wc-client': 'mcp' }), { startedAt: null });
});

test('recordMcpSeen/readMcpSeen round-trip through .web-chat/', (t) => {
  const { tmpRoot } = require('../test-support/helpers');
  const root = tmpRoot('wc-mcpseen-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  assert.equal(readMcpSeen(root), null);
  recordMcpSeen(root, { startedAt: 4242, now: 5000 });
  assert.deepEqual(readMcpSeen(root), { seen_at: 5000, started_at: 4242 });
  assert.ok(fs.existsSync(seenFile(root)));
});

test('mcpWrittenAt reads the .mcp.json mtime, null when absent', (t) => {
  const { tmpRoot } = require('../test-support/helpers');
  const root = tmpRoot('wc-mcpwrite-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
  assert.equal(mcpWrittenAt(root), null);
  fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
  assert.ok(Math.abs(mcpWrittenAt(root) - Date.now()) < 10_000);
});

test('the daemon records an MCP-tagged request and exposes it on /api/health', async (t) => {
  const { api, root } = await withServer(t);
  const before = await api.get('/api/health');
  assert.equal(before.json.mcp_seen, null, 'nothing seen yet');

  await api.get('/api/health', { 'X-WC-Client': 'mcp', 'X-WC-MCP-Started': '1700000000000' });

  const after = await api.get('/api/health');
  assert.ok(after.json.mcp_seen, 'health reports the sighting');
  assert.equal(after.json.mcp_seen.started_at, 1700000000000);
  assert.ok(after.json.mcp_seen.seen_at > 0);
  // Persisted, so doctor/status can answer with the daemon down.
  assert.deepEqual(readMcpSeen(root).started_at, 1700000000000);
});

test('the daemon does NOT count an untagged request (CLI, hook, browser) as an MCP client', async (t) => {
  const { api, root } = await withServer(t);
  await api.get('/api/health');
  await api.post('/api/store', { values: { a: 1 } });
  const { json } = await api.get('/api/health');
  assert.equal(json.mcp_seen, null, 'only the MCP server process counts');
  assert.equal(readMcpSeen(root), null);
});

test('a restarted daemon still remembers the last MCP sighting', async (t) => {
  const { root } = await withServer(t, { seed: ({ root: r }) => recordMcpSeen(r, { startedAt: 111, now: 222 }) });
  // A second server on the same root reads the persisted record at boot.
  const { api } = await withServer(t, { root });
  const { json } = await api.get('/api/health');
  assert.deepEqual(json.mcp_seen, { seen_at: 222, started_at: 111 });
});

// The wiring, end to end: the real lib/mcp/client shim (the one every one of the
// 23 tools goes through) must stamp the identity headers when it is running
// inside the MCP server process — and must NOT when it is a CLI or hook call
// sharing the same shim.
async function callThroughMcpShim(port, { asMcpServer }) {
  const prev = process.env.WEB_CHAT_MCP_SERVER;
  if (asMcpServer) process.env.WEB_CHAT_MCP_SERVER = '1';
  else delete process.env.WEB_CHAT_MCP_SERVER;
  delete require.cache[require.resolve('../lib/mcp/client')];
  try {
    const shim = require('../lib/mcp/client');
    await shim.get('/api/health', { port, noSpawn: true });
  } finally {
    if (prev === undefined) delete process.env.WEB_CHAT_MCP_SERVER;
    else process.env.WEB_CHAT_MCP_SERVER = prev;
    delete require.cache[require.resolve('../lib/mcp/client')];
  }
}

test('lib/mcp/client stamps identity from inside the MCP server process', async (t) => {
  const { api, port, root } = await withServer(t);
  await callThroughMcpShim(port, { asMcpServer: true });
  const { json } = await api.get('/api/health');
  assert.ok(json.mcp_seen, 'the daemon saw an MCP client');
  assert.ok(json.mcp_seen.started_at > 0, 'and knows when that process started');
  assert.ok(readMcpSeen(root));
});

test('the same shim used by the CLI/hooks is NOT counted as an MCP client', async (t) => {
  const { api, port } = await withServer(t);
  await callThroughMcpShim(port, { asMcpServer: false });
  const { json } = await api.get('/api/health');
  assert.equal(json.mcp_seen, null, 'a hook firing proves a turn began, not a tool-list reload');
});

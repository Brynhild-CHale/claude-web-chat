// The update check's off switch (H.6, K.2-187): WEB_CHAT_UPDATE_CHECK=0 makes
// lib/update/check.js check() return at once, with no fetch and no write, and
// test-support/sandbox.js sets it for every process the suite starts.
//
// Why it exists: bin/claude-web-chat-mcp.js runs check() fire-and-forget at
// startup, and a fresh per-test HOME is always past its 24 h throttle, so a
// spawned MCP server asked GitHub for the latest release and wrote
// update-check.json into that HOME — once the same second a test's after hook
// removed it (ENOTEMPTY), which skipped the close hook and hung the suite.
//
// Nothing here reaches the network: every child is pointed at a local stand-in
// for GitHub (WEB_CHAT_API_BASE, release.js's own override), which counts what
// it is asked, so a switch that stopped working fails here instead of fetching.

require('../test-support/sandbox');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { withTempHome, waitUntil } = require('../test-support/helpers');

const REPO = path.join(__dirname, '..');
const MCP_BIN = path.join(REPO, 'bin', 'claude-web-chat-mcp.js');
const CHECK_MODULE = require.resolve('../lib/update/check');
const RELEASE_MODULE = require.resolve('../lib/update/release');
const SETTLE_MS = 1500;

const recordIn = (home) => path.join(home, '.web-chat', 'update-check.json');

// A local GitHub that has no release (a 404, which release.js reports as null).
async function fakeGithub(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

// The MCP server over stdio, as Claude Code runs it, with a fresh HOME and the
// {...process.env, HOME} spawn the MCP-spawning suites use. The child closes
// BEFORE its HOME is removed (K.2-187's order): after hooks run in
// registration order, and the removal checks the close ran first.
async function spawnMcp(t, { env: extra = {}, drop = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-update-guard-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-update-guard-cwd-'));
  let client = null;
  let closed = false;
  t.after(async () => { if (client) await client.close(); closed = true; });
  t.after(() => {
    assert.equal(closed, true, 'the child closed before its HOME is removed');
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_CHANNEL: '0', ...extra };
  for (const name of drop) delete env[name];
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_BIN], cwd, env, stderr: 'pipe' });
  client = new Client({ name: 'update-check-guard-test', version: '0.0.0' });
  await client.connect(transport); // initialize answered: startup has run
  return { home, client };
}

// check.js, loaded fresh over a stubbed fetchLatestRelease (it destructures
// the function at require time), and put back afterwards.
function checkWithStub(t, stub) {
  const release = require(RELEASE_MODULE);
  const orig = release.fetchLatestRelease;
  const saved = require.cache[CHECK_MODULE];
  release.fetchLatestRelease = stub;
  delete require.cache[CHECK_MODULE];
  t.after(() => {
    release.fetchLatestRelease = orig;
    if (saved) require.cache[CHECK_MODULE] = saved; else delete require.cache[CHECK_MODULE];
  });
  return require(CHECK_MODULE);
}

// The switch absent (value undefined), or set to anything but its off spelling.
function withoutSwitch(t, value) {
  const prev = process.env.WEB_CHAT_UPDATE_CHECK;
  if (value === undefined) delete process.env.WEB_CHAT_UPDATE_CHECK; else process.env.WEB_CHAT_UPDATE_CHECK = value;
  t.after(() => { if (prev === undefined) delete process.env.WEB_CHAT_UPDATE_CHECK; else process.env.WEB_CHAT_UPDATE_CHECK = prev; });
}

test('the sandbox switches the update check off in this process', () => {
  assert.equal(process.env.WEB_CHAT_UPDATE_CHECK, '0');
});

test('an MCP server a test spawns with a fresh HOME runs no update check and writes no record under that HOME', async (t) => {
  const gh = await fakeGithub(t);
  const { home, client } = await spawnMcp(t, { env: { WEB_CHAT_API_BASE: gh.base } });
  assert.ok((await client.listTools()).tools.some((x) => x.name === 'render'), 'the server is up');
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  assert.equal(fs.existsSync(recordIn(home)), false, 'no update-check.json under the child\'s HOME');
  assert.deepEqual(gh.seen, [], 'and it asked no release server anything');
});

test('the same spawn with the switch absent does check (the control: the test can see a check)', async (t) => {
  const gh = await fakeGithub(t);
  const { home } = await spawnMcp(t, { env: { WEB_CHAT_API_BASE: gh.base }, drop: ['WEB_CHAT_UPDATE_CHECK'] });
  await waitUntil(() => fs.existsSync(recordIn(home)), { timeout: 10000, what: 'the update-check record' });
  assert.ok(gh.seen.some((u) => u.endsWith('/releases/latest')), `it asked for the latest release: ${JSON.stringify(gh.seen)}`);
});

test('check() with WEB_CHAT_UPDATE_CHECK=0 makes no fetch and writes no cache', async (t) => {
  const home = withTempHome(t);
  let calls = 0;
  const { check, cachePath } = checkWithStub(t, async () => { calls++; return { version: '99.0.0' }; });
  assert.equal(process.env.WEB_CHAT_UPDATE_CHECK, '0');
  assert.ok(cachePath().startsWith(home));
  await check({ currentVersion: '0.0.1' });
  assert.equal(calls, 0, 'fetchLatestRelease never called');
  assert.equal(fs.existsSync(cachePath()), false, 'no update-check record');
});

for (const [label, value] of [['without the switch', undefined], ["with WEB_CHAT_UPDATE_CHECK=1 (only '0' is off)", '1']]) test(`check() ${label}: a stale cache triggers the fetch as before`, async (t) => {
  withoutSwitch(t, value);
  withTempHome(t);
  let calls = 0;
  const { check, cachePath } = checkWithStub(t, async () => { calls++; return { version: '99.0.0' }; });
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify({ last_check: 1, latest: '0.0.1' }));
  const out = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { out.push(String(chunk)); return true; };
  try { await check({ currentVersion: '0.0.1' }); } finally { process.stderr.write = write; }
  assert.equal(calls, 1, 'fetchLatestRelease called once');
  const cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  assert.equal(cache.latest, '99.0.0');
  assert.ok(cache.last_check > 1, 'the throttle stamp moved');
  assert.match(out.join(''), /v99\.0\.0 available \(current: v0\.0\.1\)/);
});

test('the switch is check()\'s alone: resolveLatest still fetches with it set', async (t) => {
  withTempHome(t);
  let calls = 0;
  const { resolveLatest } = checkWithStub(t, async () => { calls++; return { version: '99.0.0' }; });
  assert.equal(process.env.WEB_CHAT_UPDATE_CHECK, '0');
  const r = await resolveLatest({ currentVersion: '0.0.1', force: true });
  assert.equal(calls, 1);
  assert.equal(r.latest, '99.0.0');
  assert.equal(r.updateAvailable, true);
});

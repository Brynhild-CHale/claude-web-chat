// lib/mcp/skew: the two build drifts the MCP server now says to CLAUDE, in the
// tool result, instead of to stderr (which Claude Code only shows in its MCP
// logs) or not at all.
//
//   * unknownRouteError: a 404 from a route the daemon has never heard of
//     (Express's default page) means an older daemon. Name the restart.
//   * createBuildNotice: the installed build (~/.web-chat/current, through
//     install-layout describeInstall) moved on since this session loaded its
//     tools. Say it once, naming /exit and reopen.
//
// The dispatcher half (that the text actually reaches a tools/call result) is
// in test/mcp-dispatch.test.js, against a real subprocess.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { HttpError } = require('../lib/client');
const { unknownRouteError, createBuildNotice, CHECK_INTERVAL_MS } = require('../lib/mcp/skew');
const { describeInstall, activate } = require('../lib/update/install-layout');
const { installPaths } = require('../lib/core/paths');
const { withTempHome } = require('../test-support/helpers');

const EXPRESS_404 = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST /api/markdown</pre>\n</body>\n</html>\n';

test('unknownRouteError: Express\'s default 404 names the older daemon and the restart, not the HTML', () => {
  const text = unknownRouteError(new HttpError(404, EXPRESS_404, 'POST', '/api/markdown'));
  assert.match(text, /^Error: POST \/api\/markdown → 404: /);
  assert.match(text, /older build than these tools/);
  assert.match(text, /`claude-web-chat restart` in this project/);
  assert.doesNotMatch(text, /<html|Cannot POST/);
  assert.match(unknownRouteError(new HttpError(404, null, 'GET', '/api/page')), /claude-web-chat restart/, 'an empty 404 body is no route too');
});

test('unknownRouteError: a route that answers its OWN 404 is left alone', () => {
  // Every route the tools call answers "no such node / component" as JSON: that
  // is a wrong argument, not an old daemon, and must keep its own message.
  assert.equal(unknownRouteError(new HttpError(404, { error: 'node not found' }, 'GET', '/api/export/n9')), null);
  assert.equal(unknownRouteError(new HttpError(500, 'boom', 'GET', '/api/store')), null);
  assert.equal(unknownRouteError(new Error('socket hang up')), null);
  assert.equal(unknownRouteError(null), null);
});

// A fabricated managed install in a throwaway HOME: versions/<v>/package.json
// for each version, `current` pointing at the first.
function fakeInstall(t, versions) {
  withTempHome(t);
  const paths = installPaths();
  for (const v of versions) {
    fs.mkdirSync(paths.versionDir(v), { recursive: true });
    fs.writeFileSync(path.join(paths.versionDir(v), 'package.json'), JSON.stringify({ name: 'claude-web-chat', version: v }));
  }
  activate(versions[0], paths);
  return paths;
}

function clock() {
  let t = 1_000_000;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('createBuildNotice: says nothing while current is this build, then once when it moves on', (t) => {
  const paths = fakeInstall(t, ['0.8.0', '0.8.1']);
  const now = clock();
  // The real reader, pointed at the fabricated tree: no second reader of `current`.
  const n = createBuildNotice({ describe: () => describeInstall({ packageRoot: paths.versionDir('0.8.0') }), running: '0.8.0', now });

  assert.equal(n.take(), null, 'installed === running');
  activate('0.8.1', paths); // `update` flips current mid-session
  assert.equal(n.take(), null, 'not looked at again inside the interval');
  now.advance(CHECK_INTERVAL_MS);
  const line = n.take();
  assert.match(line, /^\[web-chat\] v0\.8\.1 is installed, but this Claude Code session still runs the v0\.8\.0 web-chat tools\./);
  assert.match(line, /\/exit and reopen Claude Code/);
  assert.equal(line.split('\n').length, 1, 'one line');

  now.advance(CHECK_INTERVAL_MS);
  assert.equal(n.take(), null, 'once per session');
});

test('createBuildNotice: a rollback (installed OLDER than this session) is news too', (t) => {
  const paths = fakeInstall(t, ['0.8.1', '0.8.0']);
  activate('0.8.0', paths);
  const n = createBuildNotice({ describe: () => describeInstall({ packageRoot: paths.versionDir('0.8.1') }), running: '0.8.1', now: clock() });
  assert.match(n.take(), /v0\.8\.0 is installed, but this Claude Code session still runs the v0\.8\.1/);
});

test('createBuildNotice: a checkout is not a managed install, and is asked once only', () => {
  let calls = 0;
  const now = clock();
  const n = createBuildNotice({ describe: () => { calls++; return { kind: 'dev', version: '0.8.0', currentVersion: '0.9.0' }; }, running: '0.8.0', now });
  assert.equal(n.take(), null);
  now.advance(CHECK_INTERVAL_MS);
  assert.equal(n.take(), null);
  assert.equal(calls, 1, 'a dev tree never becomes managed, so it stops looking');
});

test('createBuildNotice: a pruned own directory does not reclassify the process, and a throw is quiet', () => {
  const now = clock();
  const seq = [
    { kind: 'managed', currentVersion: '0.8.0' },
    null, // describe threw
    { kind: 'unmanaged', currentVersion: '0.8.3' }, // versions/0.8.0 pruned by a later update
  ];
  let i = 0;
  const n = createBuildNotice({
    describe: () => { const d = seq[i++]; if (d === null) throw new Error('EACCES'); return d; },
    running: '0.8.0',
    now,
  });
  assert.equal(n.take(), null);
  now.advance(CHECK_INTERVAL_MS);
  assert.equal(n.take(), null, 'a failing read says nothing');
  now.advance(CHECK_INTERVAL_MS);
  assert.match(n.take(), /v0\.8\.3 is installed/);
});

// End to end: a real MCP server process running from a MANAGED version
// directory (a copy of this tree unpacked as ~/.web-chat/versions/0.0.1, in a
// throwaway HOME) while `current` already points at 0.0.2. The first tool
// result leads with the notice as its own text item; the second carries none.
test('a session whose tools predate the installed build is told once, in the tool result', async (t) => {
  const os = require('os');
  const express = require('express');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const REPO = path.join(__dirname, '..');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-skew-home-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const versions = path.join(home, '.web-chat', 'versions');
  const running = path.join(versions, '0.0.1');
  fs.mkdirSync(running, { recursive: true });
  for (const d of ['lib', 'bin']) fs.cpSync(path.join(REPO, d), path.join(running, d), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(running, 'package.json'), JSON.stringify({ ...pkg, version: '0.0.1' }));
  fs.symlinkSync(fs.realpathSync(path.join(REPO, 'node_modules')), path.join(running, 'node_modules'));
  fs.mkdirSync(path.join(versions, '0.0.2'));
  fs.writeFileSync(path.join(versions, '0.0.2', 'package.json'), JSON.stringify({ name: pkg.name, version: '0.0.2' }));
  fs.symlinkSync(path.join('versions', '0.0.2'), path.join(home, '.web-chat', 'current'));

  const app = express();
  app.get('/api/store', (req, res) => res.json({ store: {} }));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); });

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-skew-proj-'));
  fs.mkdirSync(path.join(cwd, '.web-chat'));
  t.after(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(running, 'bin', 'claude-web-chat-mcp.js')],
    cwd,
    env: { ...process.env, WEB_CHAT_PORT: String(srv.address().port), WEB_CHAT_CHANNEL: '0', HOME: home, USERPROFILE: home },
  });
  const client = new Client({ name: 'skew-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const first = await client.callTool({ name: 'get_store', arguments: {} });
  assert.ok(!first.isError, 'the tool itself still succeeded');
  assert.equal(first.content.length, 2);
  assert.match(first.content[0].text, /^\[web-chat\] v0\.0\.2 is installed, but this Claude Code session still runs the v0\.0\.1 web-chat tools\. Tell the user to \/exit and reopen Claude Code/);
  assert.deepEqual(JSON.parse(first.content[1].text), { store: {} }, 'the payload is the next item, untouched');

  const second = await client.callTool({ name: 'get_store', arguments: {} });
  assert.equal(second.content.length, 1, 'once per session');
});

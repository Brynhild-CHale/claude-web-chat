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
// omission — none of the 24 tools exist until the user restarts.
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
  // 0.8.5 (U95): the state names what a .mcp.json-only registration costs.
  assert.match(out, /MCP: +only in \.mcp\.json — Claude Code asks every launch here; run `claude-web-chat doctor`/);
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
//
// 0.8.5's template has twelve events (spec §1.1), so the count is out of the
// template's event list, and the absent ones are named per ROLE — one line per
// role, saying what its loss costs.
const { hookEvents } = require('../lib/setup/registration');
const { ensureHooks } = require('../lib/update/managed-files');
const HOOK_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-hook.js');

function seedHooks(hooks) {
  return (root) => {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
  };
}

test('status names the missing hook EVENT rather than reporting a smaller count', async (t) => {
  const out = await runStatus(t, seedHooks({
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${HOOK_BIN}" turn-begin` }] }],
  }));
  assert.match(out, new RegExp(`Hooks: +1/${hookEvents().length} events registered`), 'every template event is counted, not just the ones on disk');
  assert.match(out, /lifecycle +missing: Stop, StopFailure — turns never begin or never commit/, 'and the absent ones are named, with what that costs');
  assert.match(out, /claude-web-chat install/, 'with the command that repairs it');
});

test('status reports every hook event registered once the template is in place', async (t) => {
  const out = await runStatus(t, (root) => { ensureHooks(root); });
  assert.match(out, new RegExp(`Hooks: +${hookEvents().length}/${hookEvents().length} events registered in \\.claude/settings\\.json \\(lifecycle, mirror, bridge, halt\\)`));
  assert.doesNotMatch(out, /missing:/);
  assert.doesNotMatch(out, /bare command:/);
  assert.doesNotMatch(out, /outdated:/);
});

test('status words each role for a 0.8.0 project, and the narrower cost of StopFailure alone', async (t) => {
  const out = await runStatus(t, seedHooks({
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${HOOK_BIN}" turn-begin` }] }],
    Stop: [{ hooks: [{ type: 'command', command: `node "${HOOK_BIN}" turn-end` }] }],
  }));
  assert.match(out, /Hooks: +2\/12 events registered in \.claude\/settings\.json — run `claude-web-chat install`, then restart Claude Code \(or open \/hooks to review them\)/);
  assert.match(out, /\n +lifecycle +missing: StopFailure — a turn that ends on an API error holds the turn lock until it times out\n/,
    'a 0.8.0 project still begins and commits its turns: its lifecycle line says what it does lose');
  assert.match(out, /\n +mirror +missing: SessionStart, SessionEnd, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStop, PreCompact — the chat mirror shows no live tool status\n/);
  assert.match(out, /\n +bridge +missing: PermissionRequest — prompts cannot be answered from the browser\n/);
  assert.match(out, /\n +halt +missing: PreToolUse, PostToolUse, PostToolBatch — "Stop after this step" from the browser does nothing\n/);
  assert.doesNotMatch(out, /turns never begin/);
});

test('status reads an outdated handler as outdated, naming the field, and a bare one as bare', async (t) => {
  const out = await runStatus(t, (root) => {
    ensureHooks(root);
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    s.hooks.PreToolUse[0].hooks[0].timeout = 3;                                  // the mirror's
    s.hooks.PostToolBatch[0].hooks[0].command = `node "${HOOK_BIN}" halt batch`;   // a halt the Node dispatcher ignores
    s.hooks.Stop[0].hooks[0].command = 'claude-web-chat-hook turn-end';            // bare
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  });
  assert.match(out, /Hooks: +12\/12 events registered .* — run `claude-web-chat install`/, 'registered, yet not right');
  assert.match(out, /\n +lifecycle +bare command: Stop — runs only where claude-web-chat-hook is on PATH, so turns never begin or never commit\n/);
  assert.match(out, /\n +mirror +outdated: PreToolUse \(timeout differs from this build's template\)\n/,
    'a different timeout is out of date, not broken — no loss is claimed');
  assert.match(out, /\n +halt +outdated: PostToolBatch \(command differs from this build's template\) — as registered, "Stop after this step" from the browser does nothing\n/);
});

// --------------------------------------------------------------------------
// H-4. The daemon's build, and any version skew, on the lines the /web-chat
// guided start reads. `ls` knew both; `status` knew neither, so a daemon an
// update left on the old build read as healthy. The build comes from the
// daemon's own /api/health (a web-chat instance answering without
// package_version is older than 0.8), through registry.enrichSessions: the
// probe and the skew note are the ones `ls` prints.
// --------------------------------------------------------------------------

const http = require('http');
const { writePortfileAt } = require('../lib/core/portfiles');
const { registerMcp } = require('../lib/util/registry');
const { packageVersion } = require('../lib/core/versions');

// A fake daemon answering GET /api/health with `health` (plus a live pid) and
// the queue policy status also asks for. Returns its port.
async function fakeDaemon(t, health) {
  const srv = http.createServer((req, res) => {
    const body = req.url === '/api/health'
      ? { ok: true, role: 'instance', version: 1, pid: process.pid, viewers: 1, ...health }
      : req.url === '/api/queue/policy' ? { channel_connected: false } : { error: 'nope' };
    res.writeHead(req.url === '/api/health' || req.url === '/api/queue/policy' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); });
  return srv.address().port;
}

function withDaemon(port, more) {
  return (root) => {
    writePortfileAt(path.join(root, '.web-chat'), { pid: process.pid, port });
    if (more) more(root);
  };
}

test('status: the Server line names the build a daemon on THIS build runs, with no warning', async (t) => {
  const port = await fakeDaemon(t, { package_version: packageVersion() });
  const out = await runStatus(t, withDaemon(port));
  assert.match(out, new RegExp(`Server: +running at http://localhost:${port} \\(pid ${process.pid}, v${packageVersion().replace(/\./g, '\\.')}\\)`));
  assert.doesNotMatch(out, /⚠/);
});

test('status: a daemon on another build is named, with the restart that fixes it', async (t) => {
  const port = await fakeDaemon(t, { package_version: '0.0.1-old' });
  const out = await runStatus(t, withDaemon(port));
  assert.match(out, /\(pid \d+, v0\.0\.1-old\)/);
  assert.match(out, new RegExp(`⚠ running v0\\.0\\.1-old, not this CLI's v${packageVersion().replace(/\./g, '\\.')} — run \`claude-web-chat restart\``));
});

test('status: a daemon whose health names no build is reported as older than 0.8', async (t) => {
  const port = await fakeDaemon(t, {});
  const out = await runStatus(t, withDaemon(port));
  assert.match(out, /\(pid \d+, <0\.8\)/);
  assert.match(out, /⚠ running a build older than 0\.8, not this CLI's v.* — run `claude-web-chat restart`/);
});

test('status: a daemon that does not answer gets no build and no guess', async (t) => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r)); // a live pid in the portfile, nothing listening
  const out = await runStatus(t, withDaemon(deadPort));
  assert.match(out, new RegExp(`Server: +running at http://localhost:${deadPort} \\(pid ${process.pid}\\)`));
  assert.doesNotMatch(out, /⚠/);
});

test('status: a Claude session on a newer build than the surface gets the note `ls` prints', async (t) => {
  const port = await fakeDaemon(t, { package_version: packageVersion() });
  const out = await runStatus(t, withDaemon(port, (root) => registerMcp({ root, package_version: '99.0.0' })));
  assert.match(out, /Claude: +● 1 session attached/);
  assert.match(out, /⚠ the surface is on v.*, Claude on v99\.0\.0 — run `claude-web-chat restart` in this project to pick up v99\.0\.0/);
});

test('status: a Claude session on an OLDER build is told to restart Claude Code instead', async (t) => {
  const port = await fakeDaemon(t, { package_version: packageVersion() });
  const out = await runStatus(t, withDaemon(port, (root) => registerMcp({ root, package_version: '0.0.1' })));
  assert.match(out, /⚠ Claude is on v0\.0\.1 — restart Claude Code to pick up v/);
  assert.doesNotMatch(out, /Server:.*\n +⚠/, 'the server itself is on this build');
});

// A pre-0.8 daemon with a 0.8 session used to get two ⚠ lines that said the
// same thing — "running a build older than 0.8 … run `claude-web-chat restart`"
// under Server, and "the surface is on a build older than 0.8, Claude on v… —
// run `claude-web-chat restart` in this project" under Claude. One fix, one
// line: the Server line keeps it, and a skew that asks for anything else (a
// session behind the surface, to restart Claude Code) is still said.
const warnings = (out) => out.split('\n').filter((l) => l.includes('⚠'));

test('status: a pre-0.8 daemon with a 0.8 session prints one ⚠, not two', async (t) => {
  const port = await fakeDaemon(t, {});
  const out = await runStatus(t, withDaemon(port, (root) => registerMcp({ root, package_version: packageVersion() })));
  assert.match(out, /Claude: +● 1 session attached/);
  assert.deepStrictEqual(warnings(out).map((l) => l.trim()),
    [`⚠ running a build older than 0.8, not this CLI's v${packageVersion()} — run \`claude-web-chat restart\``]);
});

test('status: a daemon on an older 0.8 build with a session on this one prints one ⚠ too', async (t) => {
  const port = await fakeDaemon(t, { package_version: '0.0.1-old' });
  const out = await runStatus(t, withDaemon(port, (root) => registerMcp({ root, package_version: packageVersion() })));
  assert.equal(warnings(out).length, 1, out);
  assert.match(warnings(out)[0], /⚠ running v0\.0\.1-old, not this CLI's v.* — run `claude-web-chat restart`/);
});

test('status: a session BEHIND an outdated daemon still gets its own ⚠ — a different fix', async (t) => {
  const port = await fakeDaemon(t, { package_version: '0.0.5' });
  const out = await runStatus(t, withDaemon(port, (root) => {
    registerMcp({ root, pid: process.pid, package_version: packageVersion() });
    registerMcp({ root, pid: process.ppid, ppid: 1, package_version: '0.0.1' });
  }));
  const w = warnings(out);
  assert.equal(w.length, 2, out);
  assert.match(w[0], /⚠ running v0\.0\.5, not this CLI's v/);
  assert.match(w[1], /⚠ 1 of 2 Claude sessions is on v0\.0\.1 — restart it to pick up v0\.0\.5/);
  assert.doesNotMatch(w[1], /Claude on v/, 'the surface-restart half is the Server line\'s, not said twice');
});

// H-11, status's half: the same one line `version` prints, right under the
// version, for whoever builds web-chat — standing in a checkout of this
// package whose HEAD is not the commit the installed dev build was cut from.
// Which of the two is newer it cannot know (it reads files, walks no history),
// so it does not say.
const DEV_LINE = /differs from this checkout's HEAD/;
test('status: in a checkout whose HEAD is not the installed dev build\'s commit, the line names both commits', async (t) => {
  const { installPaths } = require('../lib/core/paths');
  const { activate } = require('../lib/update/install-layout');
  const dev = '0.9.0-dev.202610021200.abc1234';
  const out = await runStatus(t, (root) => {
    const paths = installPaths();
    fs.mkdirSync(paths.versionDir(dev), { recursive: true });
    fs.writeFileSync(path.join(paths.versionDir(dev), 'package.json'), JSON.stringify({ version: dev }));
    activate(dev, paths);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'claude-web-chat' }));
    fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), `${'d'.repeat(40)}\n`);
  });
  const lines = out.split('\n');
  assert.match(lines[0], /^claude-web-chat v/);
  assert.equal(lines[1], '  ⚠ The installed dev build\'s commit (abc1234) differs from this checkout\'s HEAD (ddddddd). '
    + 'If you want this checkout\'s code installed instead, run node scripts/build-release.js --dev, '
    + 'then the `claude-web-chat update --from` line it prints.');
  assert.equal(out.split('\n').filter((l) => DEV_LINE.test(l)).length, 1);
});

test('status: no such line outside a checkout', async (t) => {
  const out = await runStatus(t);
  assert.doesNotMatch(out, DEV_LINE);
});

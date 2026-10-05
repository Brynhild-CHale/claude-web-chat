// lib/core/claude-cli: the one way web-chat runs Claude Code's `claude`.
//
// What is load-bearing, and so tested:
//   * claudeEnv — a `claude` child never inherits the calling session's
//     identity (CLAUDE_CODE_*) or web-chat's own switches (WEB_CHAT_*), and
//     always keeps CLAUDE_CONFIG_DIR, so `claude mcp add --scope local` writes
//     the profile the user runs (ruling U95@git-facts);
//   * findClaude — PATH first, then ~/.local/bin, then ~/.claude/local, all
//     through the one home directory; null when there is none;
//   * runClaude — an argv and no shell, from the cwd it is given, with that
//     environment; `notFound` apart from a command that ran and failed.
// Nothing here runs a real `claude`: the stand-in is a fakeBin script.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withTempHome, fakeBin } = require('../test-support/helpers');
const { claudeEnv, findClaude, runClaude, fallbackLocations } = require('../lib/core/claude-cli');
const registration = require('../lib/setup/registration');

// A `claude` that prints what it was handed: its argv, its cwd and its env.
const ECHO = `
const out = { argv: process.argv.slice(2), cwd: process.cwd(), env: process.env };
if (process.argv[2] === 'fail') { process.stderr.write('MCP server web-chat already exists in local config\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(out));
`;

function echoScript(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-claude-echo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'echo.js');
  fs.writeFileSync(file, ECHO);
  return file;
}

function executable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('claudeEnv drops every CLAUDE_CODE_* and WEB_CHAT_* key and keeps CLAUDE_CONFIG_DIR', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    WEB_CHAT_CHANNEL: '1',
    WEB_CHAT_PORT: '5180',
    WEB_CHAT_MCP_SERVER: '1',
    CLAUDEX: 'kept: only the two prefixes go',
  };
  const out = claudeEnv(env);
  assert.deepEqual(Object.keys(out).sort(), ['CLAUDEX', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
  assert.equal(out.CLAUDE_CONFIG_DIR, '/home/me/.claude-work');
  assert.notEqual(out, env, 'a copy, never the caller\'s object');
  assert.equal(env.WEB_CHAT_PORT, '5180', 'the caller\'s environment is untouched');
});

test('findClaude looks on PATH first', (t) => {
  withTempHome(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const onPath = executable(path.join(dir, 'claude'));
  for (const f of fallbackLocations()) executable(f);
  assert.equal(findClaude({ env: { PATH: `/nonexistent${path.delimiter}${dir}` } }), onPath);
});

test('findClaude then tries ~/.local/bin/claude, then ~/.claude/local/claude, through the home directory', (t) => {
  const home = withTempHome(t);
  const empty = { PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'wc-nopath-')) };
  t.after(() => fs.rmSync(empty.PATH, { recursive: true, force: true }));
  assert.deepEqual(fallbackLocations(), [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
  ]);
  assert.equal(findClaude({ env: empty }), null, 'none anywhere');

  const local = executable(path.join(home, '.claude', 'local', 'claude'));
  assert.equal(findClaude({ env: empty }), local);
  const bin = executable(path.join(home, '.local', 'bin', 'claude'));
  assert.equal(findClaude({ env: empty }), bin, '~/.local/bin wins over ~/.claude/local');

  // A file that is not executable is not a `claude`.
  fs.chmodSync(bin, 0o644);
  assert.equal(findClaude({ env: empty }), local);
});

test('runClaude runs the argv with no shell, from the cwd it is given, with claudeEnv', (t) => {
  withTempHome(t);
  const { bin } = fakeBin(t, { name: 'claude', script: echoScript(t) });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cwd-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { PATH: path.dirname(bin) + path.delimiter + process.env.PATH, CLAUDE_CONFIG_DIR: '/x/cfg', CLAUDE_CODE_SESSION_ID: 's', WEB_CHAT_CHANNEL: '1' };

  const tricky = `$(touch ${path.join(cwd, 'pwned')}); echo hi`;
  const r = runClaude(['mcp', 'add', 'web-chat', '-e', `K=${tricky}`, '--', 'node', '/x/bin.js'], { cwd, env });
  assert.equal(r.ok, true, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.deepEqual(seen.argv, ['mcp', 'add', 'web-chat', '-e', `K=${tricky}`, '--', 'node', '/x/bin.js'], 'every argument arrives as one, untouched');
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false, 'no shell ever saw the argv');
  assert.equal(fs.realpathSync(seen.cwd), cwd);
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, '/x/cfg');
  assert.equal(seen.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(seen.env.WEB_CHAT_CHANNEL, undefined);
});

test('runClaude: a command that ran and failed is not `notFound`; no `claude` at all is', (t) => {
  const home = withTempHome(t);
  const { bin } = fakeBin(t, { name: 'claude', script: echoScript(t) });
  const failed = runClaude(['fail'], { cwd: home, bin });
  assert.equal(failed.ok, false);
  assert.equal(failed.notFound, false);
  assert.match(failed.stderr, /already exists/);

  const none = runClaude(['mcp', 'list'], { cwd: home, env: { PATH: '' } });
  assert.equal(none.ok, false);
  assert.equal(none.notFound, true);
});

test('registration.defaultRunClaude IS claude-cli\'s runClaude', () => {
  assert.equal(registration.defaultRunClaude, runClaude);
});

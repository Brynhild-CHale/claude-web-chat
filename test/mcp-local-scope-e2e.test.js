// OPT-IN: drives a REAL Claude Code `claude` (WEB_CHAT_E2E_CLAUDE=1), in a
// sandbox — `env -i` with HOME and CLAUDE_CONFIG_DIR in a temp dir, so the
// user's own ~/.claude.json and settings are never read or written. CI never
// sets the variable. (Ruling U95@e2e-gate: gated through test-support's
// e2eGate(['claude']), folded in by U82.)
//
// The local-scope registration rests on behaviour Claude Code does not
// document, measured on 2.1.289 (design/mcp-approval-local-scope.md). This
// replays it, so a release that changes any of it fails loudly here:
//   1. a .mcp.json server in a non-git folder under a trusted parent is
//      Pending, even with an approval in its settings.local.json;
//   2. a local-scope server has no approval state at all;
//   3. a local entry of the same name shadows a Rejected and a Pending entry;
//   4. a linked worktree's local entry is stored under the MAIN worktree's root.
// And the engine itself, against the real CLI: apply({mcp:'local'}) registers
// and verifies, and inspectLocal finds what `claude` wrote.
//
// Not covered, because `claude mcp get/list` cannot show it: the startup
// approval dialog itself (validation gate V36, run by hand).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { skip } = require('../test-support/helpers').e2eGate(['claude']);

// Resolved only once opted in: nothing probes the machine otherwise.
function realClaude() {
  const { findClaude } = require('../lib/core/claude-cli');
  return findClaude({ env: process.env });
}

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-e2e-claude-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(home);
  fs.mkdirSync(cfg);
  const bin = realClaude();
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    MCP_TIMEOUT: '3000',
  };
  const claude = (cwd, ...args) => {
    try {
      return { ok: true, out: execFileSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }) };
    } catch (e) {
      return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  const configFile = path.join(cfg, '.claude.json');
  const config = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
  const trust = (dir2) => {
    const c = config();
    c.projects = c.projects || {};
    c.projects[dir2] = { ...(c.projects[dir2] || {}), hasTrustDialogAccepted: true };
    fs.writeFileSync(configFile, JSON.stringify(c, null, 2));
  };
  return { dir, env, bin, claude, config, configFile, trust };
}

const PROBE = { command: 'node', args: ['-e', 'setInterval(()=>{},1e9)'] };

function writeMcp(dir, servers) {
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}
function writeLocalSettings(dir, value) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(value));
}

test('a real claude: a .mcp.json server under an inherited-trust parent is Pending; a local one has no approval state', { skip }, (t) => {
  const s = sandbox(t);
  assert.ok(s.bin, 'WEB_CHAT_E2E_CLAUDE=1, but no `claude` found on PATH, in ~/.local/bin or in ~/.claude/local');
  const trusted = path.join(s.dir, 'trusted');
  const p = path.join(trusted, 'p');
  fs.mkdirSync(p, { recursive: true });
  s.trust(trusted);
  writeMcp(p, { 'web-chat': PROBE });
  writeLocalSettings(p, { enabledMcpjsonServers: ['web-chat'] });
  const pending = s.claude(p, 'mcp', 'get', 'web-chat');
  assert.match(pending.out, /Pending/i, `fact 1 changed:\n${pending.out}`);

  const q = path.join(trusted, 'q');
  fs.mkdirSync(q);
  assert.ok(s.claude(q, 'mcp', 'add', 'web-chat', '--scope', 'local', '--', ...[PROBE.command, ...PROBE.args]).ok);
  const local = s.claude(q, 'mcp', 'get', 'web-chat');
  assert.match(local.out, /Local config/i, `fact 2 changed:\n${local.out}`);
  assert.doesNotMatch(local.out, /Pending|Rejected/i);
});

test('a real claude: a local entry shadows a Rejected and a Pending .mcp.json entry', { skip }, (t) => {
  const s = sandbox(t);
  const trusted = path.join(s.dir, 'trusted');
  fs.mkdirSync(trusted);
  s.trust(trusted);
  for (const [name, settings, before] of [
    ['rejected', { enabledMcpjsonServers: ['web-chat'], disabledMcpjsonServers: ['web-chat'] }, /Rejected/i],
    ['pending', { enabledMcpjsonServers: ['web-chat'] }, /Pending/i],
  ]) {
    const p = path.join(trusted, name);
    fs.mkdirSync(p);
    writeMcp(p, { 'web-chat': PROBE });
    writeLocalSettings(p, settings);
    assert.match(s.claude(p, 'mcp', 'get', 'web-chat').out, before, `${name}: the starting state`);
    assert.ok(s.claude(p, 'mcp', 'add', 'web-chat', '--scope', 'local', '--', PROBE.command, ...PROBE.args).ok);
    const after = s.claude(p, 'mcp', 'get', 'web-chat');
    assert.match(after.out, /Local config/i, `fact 3 changed (${name}):\n${after.out}`);
    assert.doesNotMatch(after.out, /Rejected|Pending/i);
  }
});

test('a real claude: a linked worktree\'s local entry is stored under the main worktree\'s root', { skip }, (t) => {
  const s = sandbox(t);
  const repo = path.join(s.dir, 'repo');
  fs.mkdirSync(repo);
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'ignore' });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  git(repo, 'add', 'f');
  git(repo, 'commit', '-q', '-m', 'i');
  const wt = path.join(s.dir, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'w', wt);
  assert.ok(s.claude(wt, 'mcp', 'add', 'web-chat', '--scope', 'local', '--', PROBE.command, ...PROBE.args).ok);
  const projects = s.config().projects || {};
  const keys = Object.keys(projects).filter((k) => projects[k].mcpServers && projects[k].mcpServers['web-chat']);
  assert.deepEqual(keys, [fs.realpathSync(repo)], `fact 4 changed: the entry is under ${keys.join(', ')}`);
});

test('a real claude: the engine registers at local scope, verifies, and reads back what claude wrote', { skip }, (t) => {
  const s = sandbox(t);
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = s.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; });
  const reg = require('../lib/setup/registration');
  const { runClaude } = require('../lib/core/claude-cli');
  const root = path.join(s.dir, 'project');
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  const out = reg.apply(root, { mcp: 'local', runClaude: (argv, o) => runClaude(argv, { ...o, env: s.env, bin: s.bin }) });
  assert.equal(out.mcp.status, 'registered', JSON.stringify(out.mcp));
  const local = reg.inspectLocal(root);
  assert.equal(local.state, 'present');
  assert.equal(local.key, fs.realpathSync(root));
  assert.equal(local.configFile, s.configFile);
  assert.deepEqual(local.entry.args, [require('../lib/update/managed-files').stableBin('claude-web-chat-mcp')]);
});

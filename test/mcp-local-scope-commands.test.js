// The commands on the local-scope registration (lib/setup/registration):
// install, init, doctor, status, open and uninstall — what each asks, what
// each writes, and what each says. The engine's own behaviour is
// test/mcp-local-scope.test.js; this file holds the command contracts:
//
//   * a deliberate No (a rejection recorded in Claude Code) is registered over
//     only by an install that creates .web-chat/, or after a separate question
//     that defaults to No — never under no terminal or --yes without
//     --register-mcp, and never by init's default-Yes refresh;
//   * status is a pure read that never runs `claude`, and prints exactly one
//     of five states with what rides beside it;
//   * open names the rejected, disabled and missing cases; init --report's
//     JSON carries the same fields;
//   * uninstall prints the command instead of removing a shared entry;
//   * the managed /web-chat command and docs/install.md send a user to
//     `claude-web-chat doctor`, not `claude mcp reset-project-choices`.
//
// Every test has a private Claude Code tier and a `claude` stand-in that plays
// Claude Code against it; nothing runs a real `claude`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const reg = require('../lib/setup/registration');
const { stableBin } = require('../lib/update/managed-files');
const { projectPaths, claudePaths, userClaudePaths } = require('../lib/core/paths');
const { withTempHome, fakeBin } = require('../test-support/helpers');

// install destructures spawnDaemon at load: patch it out first, so no test
// forks a background server.
const daemonMod = require('../lib/util/daemon');
const realSpawnDaemon = daemonMod.spawnDaemon;
daemonMod.spawnDaemon = async () => null;
const install = require('../lib/cli/commands/install');
daemonMod.spawnDaemon = realSpawnDaemon;
const doctor = require('../lib/cli/commands/doctor');
const status = require('../lib/cli/commands/status');
const init = require('../lib/cli/commands/init');
const uninstall = require('../lib/cli/commands/uninstall');
const { mcpLine } = require('../lib/cli/commands/open');

// doctor probes the capture hub on the fixed hub port: pin it where nothing
// listens.
process.env.WEB_CHAT_HUB_PORT = '65531';

function tmpRoot(prefix = 'wc-mlsc-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function isolateClaude(t) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const dir = tmpRoot('wc-mlsc-cfg-');
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(userClaudePaths().claudeJson, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  const f = userClaudePaths().claudeJson;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
}

function claudeKey(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const abs = path.resolve(cwd, common);
    if (path.basename(abs) === '.git') return fs.realpathSync(path.dirname(abs));
  } catch {}
  return fs.realpathSync(cwd);
}

// The `claude` stand-in (see test/mcp-local-scope.test.js).
function fakeClaude() {
  const calls = [];
  const fn = (argv, { cwd } = {}) => {
    calls.push(argv);
    const cfg = readConfig();
    cfg.projects = cfg.projects || {};
    const p = (cfg.projects[claudeKey(cwd)] = cfg.projects[claudeKey(cwd)] || {});
    p.mcpServers = p.mcpServers || {};
    if (argv[1] === 'add') {
      if (p.mcpServers[argv[2]]) return { ok: false, stderr: `MCP server ${argv[2]} already exists in local config` };
      const dash = argv.indexOf('--');
      p.mcpServers[argv[2]] = { type: 'stdio', command: argv[dash + 1], args: argv.slice(dash + 2), env: {} };
    } else if (argv[1] === 'remove') {
      if (!p.mcpServers[argv[2]]) return { ok: false, stderr: `No MCP server named "${argv[2]}" in local scope` };
      delete p.mcpServers[argv[2]];
    }
    writeConfig(cfg);
    return { ok: true, stdout: '' };
  };
  return { fn, calls };
}

// A prompt that answers on a terminal: `answer` for every question, or the
// question's own default when undefined. It records what it was asked.
function ttyPrompt(answer) {
  const asked = [];
  return {
    interactive: true,
    asked,
    confirm: async (question, { def = false } = {}) => { asked.push({ question, def }); return answer === undefined ? def : answer; },
    line: async () => '',
    close: () => {},
  };
}

function capture() {
  const lines = [];
  const prev = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return { lines, text: () => lines.join('\n'), restore: () => { console.log = prev; } };
}

async function runInstall(root, args, opts) {
  const out = capture();
  try {
    await install(args, { cwd: root, runClaude: opts.claude.fn, restartIfStale: async () => ({ restarted: false }), nextSteps: false, ...opts });
  } finally {
    out.restore();
  }
  return out.text();
}

const BIN = () => stableBin('claude-web-chat-mcp');

// A project where someone answered No to Claude Code's approval dialog for web-chat.
function rejectedProject({ installed = true } = {}) {
  const root = tmpRoot('wc-mlsc-rej-');
  if (installed) fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [BIN()] } } }, null, 2) + '\n');
  fs.mkdirSync(claudePaths(root).dir, { recursive: true });
  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ enabledMcpjsonServers: ['web-chat'], disabledMcpjsonServers: ['web-chat'] }));
  return root;
}

// ── install ─────────────────────────────────────────────────────────────────

test('a fresh install in a non-git folder registers at local scope, with no .mcp.json entry and no approval step', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const parent = tmpRoot('wc-mlsc-trusted-');
  const root = path.join(parent, 'proj');
  fs.mkdirSync(root);
  writeConfig({ projects: { [parent]: { hasTrustDialogAccepted: true } } });
  const claude = fakeClaude();
  const out = await runInstall(root, [], { claude, nextSteps: true });
  assert.deepEqual(claude.calls, [reg.mcpArgv()]);
  assert.equal(reg.inspectLocal(root).state, 'present');
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false, 'no .mcp.json entry, so no approval dialog');
  assert.match(out, /Claude Code \(local scope\) +web-chat's MCP server registered for this folder/);
  assert.doesNotMatch(out, /[Aa]pprove/);
  assert.match(out, /1\. Restart Claude Code in this project — it loads MCP servers only at startup/);
  assert.ok(fs.existsSync(projectPaths(root).mcpRegistration));
});

test('install says when the registration covers the whole repository', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const repo = tmpRoot('wc-mlsc-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'web');
  fs.mkdirSync(sub);
  const out = await runInstall(sub, [], { claude: fakeClaude() });
  assert.match(out, new RegExp(`covers the whole repository at ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('a recorded rejection: the install that creates .web-chat/ registers over it', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = rejectedProject({ installed: false });
  const claude = fakeClaude();
  const prompt = ttyPrompt(false);
  await runInstall(root, [], { claude, prompt });
  assert.deepEqual(prompt.asked.filter((a) => /anyway/.test(a.question)), [], 'not asked: the user is setting web-chat up here');
  assert.equal(reg.inspectLocal(root).state, 'present');
});

test('a recorded rejection: install on an existing project asks a separate question that defaults to No', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = rejectedProject();
  const claude = fakeClaude();
  const prompt = ttyPrompt(); // takes every default
  const out = await runInstall(root, [], { claude, prompt });
  const q = prompt.asked.find((a) => /Register web-chat's MCP server for this folder at local scope anyway\?/.test(a.question));
  assert.ok(q, out);
  assert.equal(q.def, false, 'the question defaults to No');
  assert.deepEqual(claude.calls, [], 'and its default registers nothing');
  assert.match(out, /claude-web-chat off/);
  assert.match(out, /NOT registered — web-chat was rejected in Claude Code here/);

  const yes = ttyPrompt(true);
  await runInstall(root, [], { claude, prompt: yes });
  assert.equal(reg.inspectLocal(root).state, 'present', 'a yes registers');
});

test('a recorded rejection: no terminal, or --yes, only reports — --register-mcp registers', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  for (const args of [[], ['--yes']]) {
    const root = rejectedProject();
    const claude = fakeClaude();
    const out = await runInstall(root, args, { claude, prompt: { interactive: false, confirm: async () => { throw new Error('asked'); }, close() {} } });
    assert.deepEqual(claude.calls, [], `${args.join(' ') || 'no terminal'}: nothing registered`);
    assert.match(out, /not asked: no terminal, or --yes — pass --register-mcp to do it/);
  }
  const root = rejectedProject();
  const claude = fakeClaude();
  await runInstall(root, ['--yes', '--register-mcp'], { claude, prompt: { interactive: false, close() {} } });
  assert.equal(reg.inspectLocal(root).state, 'present');
});

test('no runnable claude: install writes .mcp.json and says the three things', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = tmpRoot();
  const out = await runInstall(root, [], { claude: { fn: () => ({ ok: false, notFound: true, stderr: 'not found' }) } });
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers['web-chat']);
  assert.match(out, /Claude Code will ask you to approve it/);
  assert.match(out, /may not keep that approval in this folder/);
  assert.match(out, /claude-web-chat doctor` finishes the registration once `claude` is available/);
  // U95b: doctor's no-claude wording changed; install's fallback did not.
  assert.match(out, /`claude` command was not found \(not on PATH, in ~\/\.local\/bin or in ~\/\.claude\/local\), so web-chat is registered in \.mcp\.json instead\./);
});

// U95@doctor.js:no-claude-none (ruled 2026-10-05): doctor's fallback is 'none'
// — it never writes a .mcp.json entry when `claude` cannot run — so its words
// say what did happen: web-chat stays unregistered (or only in .mcp.json), with
// the command to run once `claude` is on PATH. And the state line doctor prints
// does not send the user to run doctor.
test('doctor without a runnable claude writes no .mcp.json and says web-chat stays unregistered, with the command', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const noClaude = () => ({ ok: false, notFound: true, stderr: 'not found' });
  const runDoctor = async (root) => {
    const lines = [];
    const s = await doctor([], { cwd: root, runClaude: noClaude, log: (l) => lines.push(l) });
    return { s, text: lines.join('\n') };
  };

  const root = tmpRoot();
  fs.mkdirSync(projectPaths(root).dir);
  let { s, text } = await runDoctor(root);
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false, 'doctor wrote no .mcp.json');
  assert.doesNotMatch(text, /registered in \.mcp\.json instead/);
  assert.doesNotMatch(text, /not registered — run `claude-web-chat doctor`/);
  assert.ok(s.checks.some((c) => c.status === 'problem' && /^web-chat's MCP server is not registered$/.test(c.m)), text);
  assert.match(text, /`claude` command was not found .*so web-chat stays unregistered here/);
  assert.match(text, new RegExp(`claude mcp add web-chat --scope local -- node ${BIN().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(readConfig().projects, undefined, 'nothing reached Claude Code\'s config');

  // With web-chat's entry already in .mcp.json, it stays there, untouched.
  const two = tmpRoot();
  fs.mkdirSync(projectPaths(two).dir);
  const body = JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [BIN()] } } }, null, 2) + '\n';
  fs.writeFileSync(path.join(two, '.mcp.json'), body);
  ({ text } = await runDoctor(two));
  assert.equal(fs.readFileSync(path.join(two, '.mcp.json'), 'utf8'), body);
  assert.doesNotMatch(text, /registered in \.mcp\.json instead/);
  assert.match(text, /so web-chat stays only in \.mcp\.json here/);
  assert.match(text, /claude mcp add web-chat --scope local -- node /);
});

// ── init ────────────────────────────────────────────────────────────────────

test('init\'s default-Yes refresh does not register over a rejection: its own question defaults to No', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = rejectedProject();
  fs.writeFileSync(projectPaths(root).version, JSON.stringify({ version: 3 }));
  const claude = fakeClaude();
  const prompt = ttyPrompt(); // a reflexive Enter on every question
  const log = [];
  await init([], {
    cwd: root, log: (s) => log.push(String(s)), prompt, latest: null, viewerWaitMs: 0,
    doctor: async (args, o) => doctor(args, { ...o, runClaude: claude.fn }),
    install: async (args, o) => install(args, { ...o, cwd: root, runClaude: claude.fn, restartIfStale: async () => ({ restarted: false }) }),
    collectRows: async () => [],
    client: { get: async () => { throw new Error('no daemon'); }, post: async () => { throw new Error('no daemon'); } },
    reap: async () => ({ stopped: 0, cleared: 0, skipped: [] }),
  });
  const refresh = prompt.asked.find((a) => /^Refresh \d+ managed file/.test(a.question));
  assert.ok(refresh && refresh.def === true, 'the refresh question defaults to Yes');
  const over = prompt.asked.filter((a) => /anyway\?/.test(a.question));
  assert.equal(over.length, 1, 'the rejection is asked about once in the run (doctor), not again by the refresh');
  assert.equal(over[0].def, false);
  assert.deepEqual(claude.calls.filter((a) => a[1] === 'add'), [], 'nothing registered over the No');
});

test('init --report carries the MCP registration\'s state, words and fields, and writes nothing', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = rejectedProject();
  const log = [];
  const state = await init(['--json'], {
    cwd: root, log: (s) => log.push(String(s)), latest: null,
    doctor: async () => ({ ok: 0, repaired: 0, problems: 0, checks: [] }),
    collectRows: async () => [],
    client: { get: async () => { throw new Error('no daemon'); } },
  });
  assert.equal(state.mcp.state, 'rejected');
  assert.match(state.mcp.line, /^REJECTED/);
  assert.deepEqual(state.mcp.rejected_in, [claudePaths(root).settingsLocal]);
  for (const k of ['config_file', 'key', 'covers_repository', 'bin', 'mcp_json', 'disabled', 'approval_dialog', 'nested', 'notes']) {
    assert.ok(k in state.mcp, k);
  }
  assert.equal(readConfig().projects, undefined, 'Claude Code\'s config untouched');
});

// ── doctor ──────────────────────────────────────────────────────────────────

test('doctor asks (default No) over a rejection on a terminal, only reports without one, and --register-mcp registers', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  let root = rejectedProject();
  let claude = fakeClaude();
  const prompt = ttyPrompt();
  let s = await doctor([], { cwd: root, runClaude: claude.fn, log: () => {}, prompt });
  assert.equal(prompt.asked.length, 1);
  assert.equal(prompt.asked[0].def, false);
  assert.deepEqual(claude.calls, []);
  assert.ok(s.checks.some((c) => c.status === 'problem' && /^web-chat's MCP server is REJECTED/.test(c.m)));
  assert.ok(s.checks.some((c) => /doctor --register-mcp/.test(c.m) && /claude-web-chat off/.test(c.m)));

  claude = fakeClaude();
  s = await doctor([], { cwd: root, runClaude: claude.fn, log: () => {}, prompt: { interactive: false, close() {} } });
  assert.deepEqual(claude.calls, [], 'no terminal: reported, not registered');

  s = await doctor(['--register-mcp'], { cwd: root, runClaude: claude.fn, log: () => {}, prompt: { interactive: false, close() {} } });
  assert.deepEqual(claude.calls.map((a) => a[1]), ['add']);
  assert.ok(s.checks.some((c) => c.status === 'repaired' && /registered web-chat's MCP server at local scope/.test(c.m)));
  assert.ok(s.checks.some((c) => c.status === 'note' && /Optional tidy: `claude mcp reset-project-choices`/.test(c.m)),
    'reset-project-choices is named only as an optional tidy');

  // --dryRun repairs nothing and runs no `claude`.
  root = tmpRoot();
  fs.mkdirSync(projectPaths(root).dir);
  claude = fakeClaude();
  s = await doctor([], { cwd: root, runClaude: claude.fn, log: () => {}, dryRun: true });
  assert.deepEqual(claude.calls, []);
  assert.ok(s.checks.some((c) => c.dry && /register web-chat at local scope/.test(c.m)));
  assert.equal(readConfig().projects && readConfig().projects[root], undefined);
});

test('doctor never re-enables a server disabled through /mcp', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = tmpRoot();
  fs.mkdirSync(projectPaths(root).dir);
  writeConfig({ projects: { [root]: { disabledMcpServers: ['web-chat'] } } });
  const claude = fakeClaude();
  const s = await doctor(['--register-mcp'], { cwd: root, runClaude: claude.fn, log: () => {} });
  assert.deepEqual(claude.calls, []);
  assert.ok(s.checks.some((c) => /disabled in Claude Code for this project \(\/mcp\)/.test(c.m)));
});

test('doctor says when a Claude Code session here runs without web-chat\'s tools', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = tmpRoot();
  fs.mkdirSync(projectPaths(root).dir);
  const sessions = { states: [{ pid: 4242, cwd: root }], mcpRows: [], alive: () => true };
  const s = await doctor([], { cwd: root, runClaude: fakeClaude().fn, log: () => {}, sessions });
  assert.ok(s.checks.some((c) => c.status === 'problem' && /a Claude Code session here is running without web-chat's tools \(pid 4242\)/.test(c.m)));
});

// ── status ──────────────────────────────────────────────────────────────────

async function runStatus(root, opts = {}) {
  const out = capture();
  try { await status([], { cwd: root, ...opts }); } finally { out.restore(); }
  return out.text();
}

test('status prints exactly one MCP state, with the dialog, nested sessions and missing-tools lines beside it — and never runs claude', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  // A `claude` on PATH that leaves a mark if anything runs it.
  const marker = path.join(tmpRoot('wc-mlsc-mark-'), 'ran');
  const { dir } = fakeBin(t, { name: 'claude', script: path.join(tmpRoot('wc-mlsc-s-'), 'x.js'), env: { MARK: marker } });
  fs.writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prevPath}`;
  t.after(() => { process.env.PATH = prevPath; });

  const root = tmpRoot();
  fs.mkdirSync(projectPaths(root).dir);
  const mcpLines = (text) => text.split('\n').filter((l) => l.startsWith('MCP:'));

  let out = await runStatus(root);
  assert.deepEqual(mcpLines(out), ['MCP:      not registered — run `claude-web-chat doctor`']);

  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'web-chat': { command: 'node', args: [BIN()] } } }));
  out = await runStatus(root);
  assert.deepEqual(mcpLines(out), ['MCP:      only in .mcp.json — Claude Code asks every launch here; run `claude-web-chat doctor`']);

  fs.mkdirSync(claudePaths(root).dir);
  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ disabledMcpjsonServers: ['web-chat'] }));
  out = await runStatus(root);
  assert.equal(mcpLines(out).length, 1);
  assert.match(mcpLines(out)[0], /^MCP: +REJECTED — web-chat is in disabledMcpjsonServers/);

  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ enabledMcpjsonServers: ['web-chat'] }));
  const nested = path.join(root, 'sda');
  fs.mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested });
  writeConfig({ projects: { [root]: { mcpServers: { 'web-chat': { command: 'node', args: [BIN()] } } }, [nested]: {} } });
  out = await runStatus(root, { sessions: { states: [{ pid: 777, cwd: root }], mcpRows: [], alive: () => true } });
  assert.equal(mcpLines(out).length, 1);
  assert.match(mcpLines(out)[0], /^MCP: +registered for you \(local scope\) in /);
  assert.match(out, /⚠ Claude Code still shows its approval dialog at launch here; answering No once is now harmless/);
  assert.match(out, new RegExp(`⚠ Claude Code sessions below this folder that do not see the local registration: ${nested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(out, /⚠ a Claude Code session here is running without web-chat's tools \(pid 777\)/);

  writeConfig({ projects: { [root]: { mcpServers: { 'web-chat': { command: 'node', args: [BIN()] } }, disabledMcpServers: ['web-chat'] } } });
  out = await runStatus(root);
  assert.deepEqual(mcpLines(out), ['MCP:      disabled in Claude Code for this project (/mcp) — re-enable it there, or run `claude-web-chat off`']);

  assert.equal(fs.existsSync(marker), false, 'status never ran `claude`');
});

// ── open ────────────────────────────────────────────────────────────────────

test('open adds one line for the rejected, disabled and missing cases, and none otherwise', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const state = (kind) => () => ({
    kind, local: { configFile: '/c/.claude.json', state: kind === 'local' ? 'present' : 'absent' },
    approvals: { rejections: [{ file: '/p/.claude/settings.local.json' }] }, mcp: { resolvable: true }, nested: [], dialog: false,
  });
  const root = tmpRoot();
  fs.mkdirSync(projectPaths(root).dir);
  assert.match(mcpLine(root, { mcpState: state('rejected') }), /^web-chat's MCP tools will not load in Claude Code here: REJECTED/);
  assert.match(mcpLine(root, { mcpState: state('disabled') }), /disabled in Claude Code for this project \(\/mcp\)/);
  assert.match(mcpLine(root, { mcpState: state('none') }), /not registered — run `claude-web-chat doctor`/);
  assert.equal(mcpLine(root, { mcpState: state('local') }), null);
  assert.equal(mcpLine(root, { mcpState: state('mcpjson') }), null);
  assert.match(mcpLine(root), /not registered/, 'the real read, on a bare project');
});

// ── uninstall ───────────────────────────────────────────────────────────────

test('uninstall in a web-chat root that shares the repository\'s entry prints the command and removes nothing from Claude Code', async (t) => {
  withTempHome(t);
  isolateClaude(t);
  const repo = tmpRoot('wc-mlsc-un-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const a = path.join(repo, 'a');
  const b = path.join(repo, 'b');
  for (const d of [a, b]) fs.mkdirSync(projectPaths(d).dir, { recursive: true });
  reg.apply(a, { runClaude: fakeClaude().fn, mcp: 'local' });

  const claude = fakeClaude();
  const out = capture();
  try { await uninstall([], { cwd: b, runClaude: claude.fn, knownRoots: [] }); } finally { out.restore(); }
  assert.deepEqual(claude.calls, []);
  assert.match(out.text(), /Claude Code \(local scope\) +kept — it is shared/);
  assert.match(out.text(), /to remove it anyway, run in .*: claude mcp remove web-chat --scope local/);
  assert.equal(reg.inspectLocal(a).state, 'present');

  // A sibling folder with nothing of web-chat's: nothing to uninstall at all.
  const c = path.join(repo, 'c');
  fs.mkdirSync(c);
  const out2 = capture();
  try { await uninstall([], { cwd: c, runClaude: claude.fn, knownRoots: [] }); } finally { out2.restore(); }
  assert.match(out2.text(), /Nothing to uninstall/);
  assert.deepEqual(claude.calls, []);
});

// ── the words users read ────────────────────────────────────────────────────

test('the /web-chat command and docs/install.md name doctor, not reset-project-choices', () => {
  const repo = path.join(__dirname, '..');
  for (const rel of ['templates/commands/web-chat.md', '.claude/commands/web-chat.md']) {
    const text = fs.readFileSync(path.join(repo, rel), 'utf8');
    assert.ok(!text.includes('reset-project-choices'), rel);
    assert.match(text, /The web-chat tools aren't in this session yet\.[^]*claude-web-chat doctor/, rel);
  }
  const doc = fs.readFileSync(path.join(repo, 'docs', 'install.md'), 'utf8');
  assert.ok(!doc.includes('reset-project-choices'));
  assert.match(doc, /claude-web-chat doctor/);
  const writes = doc.slice(doc.indexOf('## What it writes to your machine'));
  assert.match(writes, /Claude Code's own config/);
  assert.match(writes, /`mcp-registration\.json`/);
});

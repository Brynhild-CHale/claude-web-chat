// The registration engine's local scope (lib/setup/registration): web-chat's
// MCP server registered in Claude Code's own config with
// `claude mcp add web-chat --scope local`, instead of relying on a project
// .mcp.json entry Claude Code must approve — and cannot keep approved in a
// non-git folder inside a trusted one (design/mcp-approval-local-scope.md).
//
// Every test gets a private Claude Code tier (CLAUDE_CONFIG_DIR → a fresh temp
// directory), so `.claude.json` and the user settings are the test's own, and
// a `claude` stand-in (fakeClaude) that PLAYS Claude Code: it keys the entry by
// the main worktree's root inside git, else the folder's physical path —
// measured on 2.1.289 — and writes that file. Nothing runs a real `claude`
// (the opt-in test/mcp-local-scope-e2e.test.js does, sandboxed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const reg = require('../lib/setup/registration');
const { stableBin, ensureMcpRegistration } = require('../lib/update/managed-files');
const { projectPaths, claudePaths, userClaudePaths } = require('../lib/core/paths');
const { withTempHome } = require('../test-support/helpers');

const GIT_PREFIX = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor='];

function tmpRoot(prefix = 'wc-mls-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A private Claude Code tier for one test.
function isolateClaude(t) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const dir = tmpRoot('wc-mls-cfg-');
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitRepo(prefix) {
  const root = tmpRoot(prefix);
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'README'), 'x\n');
  git(root, 'add', 'README');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(userClaudePaths().claudeJson, 'utf8')); } catch { return {}; }
}

function writeConfig(cfg) {
  const f = userClaudePaths().claudeJson;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
}

function setLocalEntry(key, entry, extra = {}) {
  const cfg = readConfig();
  cfg.projects = cfg.projects || {};
  cfg.projects[key] = { ...(cfg.projects[key] || {}), ...extra };
  if (entry) cfg.projects[key].mcpServers = { ...(cfg.projects[key].mcpServers || {}), 'web-chat': entry };
  writeConfig(cfg);
}

// Claude Code's key for a folder: the main worktree's root inside git, else
// its physical path.
function claudeKey(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const abs = path.resolve(cwd, common);
    if (path.basename(abs) === '.git') return fs.realpathSync(path.dirname(abs));
  } catch {}
  return fs.realpathSync(cwd);
}

// The `claude` stand-in. `write: false` answers ok and writes nothing (an
// entry lost to another session's write); `notFound: true` is no `claude`.
function fakeClaude({ write = true, notFound = false } = {}) {
  const calls = [];
  const cwds = [];
  const fn = (argv, { cwd } = {}) => {
    calls.push(argv);
    cwds.push(cwd);
    if (notFound) return { ok: false, notFound: true, stderr: 'claude not found' };
    if (!write) return { ok: true, stdout: '' };
    const cfg = readConfig();
    cfg.projects = cfg.projects || {};
    const key = claudeKey(cwd);
    const p = (cfg.projects[key] = cfg.projects[key] || {});
    p.mcpServers = p.mcpServers || {};
    const name = argv[2];
    if (argv[1] === 'add') {
      if (p.mcpServers[name]) return { ok: false, stderr: `MCP server ${name} already exists in local config` };
      const dash = argv.indexOf('--');
      const env = {};
      for (let i = 0; i < dash; i++) if (argv[i] === '-e') { const [k, ...v] = argv[++i].split('='); env[k] = v.join('='); }
      p.mcpServers[name] = { type: 'stdio', command: argv[dash + 1], args: argv.slice(dash + 2), env };
    } else if (argv[1] === 'remove') {
      if (!p.mcpServers[name]) return { ok: false, stderr: `No MCP server named "${name}" in local scope` };
      delete p.mcpServers[name];
    }
    writeConfig(cfg);
    return { ok: true, stdout: '' };
  };
  return { fn, calls, cwds };
}

const BIN = () => stableBin('claude-web-chat-mcp');
const ownEntry = (env) => (env ? { command: 'node', args: [BIN()], env } : { command: 'node', args: [BIN()] });

function writeMcp(root, servers) {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
}
function readMcp(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
}
function project(prefix) {
  const root = tmpRoot(prefix);
  fs.mkdirSync(projectPaths(root).dir, { recursive: true });
  return root;
}

// ── inspectLocal ────────────────────────────────────────────────────────────

test('inspectLocal: absent with no config file, unknown for an unreadable one, present under the physical key', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = tmpRoot();
  let r = reg.inspectLocal(root);
  assert.equal(r.state, 'absent');
  assert.equal(r.configFile, userClaudePaths().claudeJson);

  fs.writeFileSync(userClaudePaths().claudeJson, '{ torn');
  assert.equal(reg.inspectLocal(root).state, 'unknown', 'a torn file is not "absent"');
  writeConfig({});
  fs.chmodSync(userClaudePaths().claudeJson, 0o000);
  t.after(() => { try { fs.chmodSync(userClaudePaths().claudeJson, 0o600); } catch {} });
  if (process.getuid && process.getuid() !== 0) assert.equal(reg.inspectLocal(root).state, 'unknown', 'an unreadable one neither');
  fs.chmodSync(userClaudePaths().claudeJson, 0o600);

  setLocalEntry(root, { type: 'stdio', command: 'node', args: ['/x/bin.js'], env: { WEB_CHAT_PORT: '5180' } });
  r = reg.inspectLocal(root);
  assert.equal(r.state, 'present');
  assert.equal(r.key, root);
  assert.deepEqual(r.entry, { command: 'node', args: ['/x/bin.js'], envKeys: ['WEB_CHAT_PORT'] });
});

test('inspectLocal finds a symlinked root under its physical key, never its spelling', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const real = tmpRoot('wc-mls-real-');
  const link = path.join(tmpRoot('wc-mls-link-'), 'spelled');
  fs.symlinkSync(real, link);
  setLocalEntry(real, { command: 'node', args: ['/x/bin.js'] });
  const r = reg.inspectLocal(link);
  assert.equal(r.state, 'present');
  assert.equal(r.key, real);
  // An entry hand-written under the non-physical spelling is invisible to
  // Claude Code, and to this read.
  const other = tmpRoot('wc-mls-real2-');
  const link2 = path.join(tmpRoot('wc-mls-link2-'), 'spelled');
  fs.symlinkSync(other, link2);
  setLocalEntry(link2, { command: 'node', args: ['/x/bin.js'] });
  assert.equal(reg.inspectLocal(link2).state, 'absent');
});

test('inspectLocal: inside git the key is the toplevel — for a subfolder root too — and a linked worktree\'s is the main worktree\'s root', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const repo = gitRepo('wc-mls-repo-');
  const sub = path.join(repo, 'packages', 'web');
  fs.mkdirSync(sub, { recursive: true });
  setLocalEntry(repo, { command: 'node', args: ['/x/bin.js'] });
  assert.equal(reg.inspectLocal(repo).key, repo);
  const fromSub = reg.inspectLocal(sub);
  assert.equal(fromSub.state, 'present');
  assert.equal(fromSub.key, repo, 'a subfolder root finds the repository\'s entry');
  assert.notEqual(fromSub.key, fromSub.realpath);

  const wt = path.join(tmpRoot('wc-mls-wt-'), 'feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const fromWt = reg.inspectLocal(wt);
  assert.equal(fromWt.state, 'present');
  assert.equal(fromWt.key, repo, 'the linked worktree is covered by the main worktree\'s entry');
  assert.equal(fromWt.git.toplevel, fs.realpathSync(wt));
  assert.equal(fromWt.git.mainRoot, repo);
});

test('inspectLocal reads /mcp\'s Disable, lists nested project keys, and hands out nothing else of the file', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = tmpRoot();
  const nestedPlain = path.join(root, 'notes');
  const nestedRepo = path.join(root, 'vendor', 'lib');
  const nestedOwn = path.join(root, 'tools');
  for (const d of [nestedPlain, nestedRepo, nestedOwn]) fs.mkdirSync(d, { recursive: true });
  git(nestedRepo, 'init', '-q');
  const cfg = {
    oauthAccount: { emailAddress: 'someone@example.com', accessToken: 'sk-ant-SECRET-value' },
    projects: {
      [root]: {
        mcpServers: { 'web-chat': { command: 'node', args: ['/x/bin.js'], env: { TOKEN: 'super-secret-value' } } },
        disabledMcpServers: ['web-chat'],
        hasTrustDialogAccepted: true,
        allowedTools: ['Bash(rm -rf /)'],
      },
      [nestedPlain]: { hasTrustDialogAccepted: true },
      [nestedRepo]: { hasTrustDialogAccepted: true },
      [nestedOwn]: { mcpServers: { 'web-chat': { command: 'node', args: ['/x/bin.js'] } } },
      [path.join(root, 'gone')]: {},
      '/elsewhere/entirely': {},
    },
  };
  writeConfig(cfg);
  const r = reg.inspectLocal(root, { wantEnv: { TOKEN: 'super-secret-value' } });
  assert.equal(r.disabled, true);
  assert.equal(r.disabledKey, root);
  assert.deepEqual(r.nested.sort(), [nestedPlain, nestedRepo].sort(), 'a folder with its own entry, or gone, is not listed');
  assert.equal(r.envMatches, true, 'an env value is compared without being handed out');
  const blob = JSON.stringify(r);
  for (const leaked of ['super-secret-value', 'sk-ant-SECRET-value', 'someone@example.com', 'rm -rf', 'hasTrustDialogAccepted']) {
    assert.ok(!blob.includes(leaked), `inspectLocal handed out ${leaked}`);
  }

  // Inside a repository, a plain subfolder's key is covered by the root's entry.
  const repo = gitRepo('wc-mls-nest-');
  const inside = path.join(repo, 'src');
  fs.mkdirSync(inside);
  writeConfig({ projects: { [repo]: { mcpServers: { 'web-chat': { command: 'node', args: ['/x'] } } }, [inside]: {} } });
  assert.deepEqual(reg.inspectLocal(repo).nested, []);
});

test('the git facts run git with the fixed argv, from the root, never through a shell', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const seen = [];
  const recorder = (argv, opts) => { seen.push({ argv, cwd: opts.cwd, env: opts.env }); return { status: 128, stdout: '' }; };
  const root = tmpRoot();
  reg.inspectLocal(root, { git: recorder });
  assert.ok(seen.length >= 1);
  for (const s of seen) {
    assert.deepEqual(s.argv.slice(0, 4), GIT_PREFIX, 'no hooks, no fsmonitor');
    assert.equal(s.cwd, root);
    assert.ok(!Object.keys(s.env).some((k) => k.startsWith('CLAUDE_CODE_') || k.startsWith('WEB_CHAT_') || k === 'GIT_DIR'));
  }
  // The real one, on a root whose name a shell would run.
  const parent = tmpRoot('wc-mls-sh-');
  const evil = path.join(parent, '$(touch pwned)');
  fs.mkdirSync(evil);
  git(evil, 'init', '-q');
  const r = reg.inspectLocal(evil);
  assert.equal(r.git.toplevel, fs.realpathSync(evil));
  assert.equal(fs.existsSync(path.join(parent, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(evil, 'pwned')), false);
});

// ── inspectApprovals ────────────────────────────────────────────────────────

test('inspectApprovals: a rejection in the user, project or local settings wins over any approval', (t) => {
  withTempHome(t);
  isolateClaude(t);
  for (const scope of ['user', 'project', 'local']) {
    const root = tmpRoot();
    const files = {
      user: userClaudePaths().claudeSettings,
      project: claudePaths(root).settings,
      local: claudePaths(root).settingsLocal,
    };
    for (const f of Object.values(files)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ enabledMcpjsonServers: ['web-chat'] })); }
    fs.writeFileSync(files[scope], JSON.stringify({ enabledMcpjsonServers: ['web-chat'], disabledMcpjsonServers: ['web-chat'] }));
    const a = reg.inspectApprovals(root);
    assert.equal(a.rejected, true, scope);
    assert.deepEqual(a.rejections.map((r) => r.scope), [scope]);
    assert.equal(a.approvals.length, 3, 'the approvals are there, and lose');
    fs.rmSync(files.user);
  }
});

test('inspectApprovals finds nested settings.local.json files that approve web-chat', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = tmpRoot();
  const a = path.join(root, 'sda');
  const b = path.join(root, 'other', 'deep');
  for (const d of [a, b]) {
    fs.mkdirSync(claudePaths(d).dir, { recursive: true });
  }
  fs.writeFileSync(claudePaths(a).settingsLocal, JSON.stringify({ enabledMcpjsonServers: ['web-chat'] }));
  fs.writeFileSync(claudePaths(b).settingsLocal, JSON.stringify({ enabledMcpjsonServers: ['other-server'] }));
  const r = reg.inspectApprovals(root);
  assert.equal(r.rejected, false);
  assert.deepEqual(r.nested, [a]);
});

// ── the old updater path ────────────────────────────────────────────────────

// 0.8.2's lib/cli/commands/update.js, verbatim in shape: the previous build's
// `update --from` loads the NEW engine out of the version it just installed
// and drives it with this — a runClaude that records and fails — then prints
// "cannot resolve" whenever it was called.
function syncProject082(registration, root) {
  let localScope = null;
  const recordClaude = (argv) => { localScope = argv; return { ok: false, stderr: 'not attempted by update' }; };
  const applied = registration.apply(root, { force: false, runClaude: recordClaude });
  return { applied, localScope };
}
function lines082({ localScope }) {
  return localScope ? ['  ⚠ this project\'s .mcp.json entry cannot resolve here (a plugin stub outside a plugin install).'] : [];
}

test('the old updater path: apply()\'s default never calls claude for a resolvable entry, so no "cannot resolve" line', (t) => {
  withTempHome(t);
  isolateClaude(t);
  for (const seed of [
    (root) => writeMcp(root, { 'web-chat': ownEntry() }),             // a 0.8.2 project
    () => {},                                                          // no entry yet
    (root) => setLocalEntry(root, { command: 'node', args: [BIN()] }), // already moved to local scope
  ]) {
    const root = project();
    const hadMcp = (seed(root), fs.existsSync(path.join(root, '.mcp.json')));
    const out = syncProject082(reg, root);
    assert.equal(out.localScope, null, 'claude was never called');
    assert.deepEqual(lines082(out), []);
    if (reg.inspectLocal(root).state === 'present') {
      assert.equal(fs.existsSync(path.join(root, '.mcp.json')), hadMcp, 'a locally registered project is not given its .mcp.json entry back');
    }
  }
});

test('the old updater path: a stub that a local entry already covers is not re-registered either', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  writeMcp(root, { 'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] } });
  setLocalEntry(root, { command: 'node', args: [BIN()] });
  assert.equal(syncProject082(reg, root).localScope, null);
});

test('apply({mcp: \'local\'}) does register, from the root', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  const claude = fakeClaude();
  const out = reg.apply(root, { runClaude: claude.fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'registered');
  assert.deepEqual(claude.calls, [reg.mcpArgv()]);
  assert.deepEqual(claude.cwds, [root]);
  assert.equal(reg.inspectLocal(root).state, 'present');
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false, 'and writes no .mcp.json entry');
});

// ── registering ─────────────────────────────────────────────────────────────

test('registration carries every non-channel env key with -e, verifies it, and records the key names but no values', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  writeMcp(root, { 'web-chat': ownEntry({ WEB_CHAT_PORT: '5180', API_TOKEN: 'tok-value-123', WEB_CHAT_CHANNEL: '1' }) });
  const claude = fakeClaude();
  const at = 1_700_000_000_000;
  const out = reg.apply(root, { runClaude: claude.fn, mcp: 'local', now: () => at });
  assert.equal(out.mcp.status, 'registered');
  const argv = claude.calls[0];
  assert.deepEqual(argv.slice(0, 5), ['mcp', 'add', 'web-chat', '--scope', 'local']);
  const envArgs = [];
  for (let i = 0; i < argv.indexOf('--'); i++) if (argv[i] === '-e') envArgs.push(argv[i + 1]);
  assert.deepEqual(envArgs.sort(), ['API_TOKEN=tok-value-123', 'WEB_CHAT_PORT=5180'], 'the channel opt-in belongs on the launch line, not here');
  assert.deepEqual(argv.slice(-3), ['--', 'node', BIN()]);

  const rec = JSON.parse(fs.readFileSync(projectPaths(root).mcpRegistration, 'utf8'));
  assert.equal(rec.scope, 'local');
  assert.equal(rec.at, at);
  assert.equal(rec.key, root);
  assert.equal(rec.config_file, userClaudePaths().claudeJson);
  assert.ok(rec.argv.includes('API_TOKEN') && rec.argv.includes('WEB_CHAT_PORT'));
  const recText = fs.readFileSync(projectPaths(root).mcpRegistration, 'utf8');
  assert.ok(!recText.includes('tok-value-123') && !recText.includes('5180'), 'no env value in the record');
  assert.ok(!out.mcp.argv.join(' ').includes('tok-value-123'), 'nor in the argv the commands print');
});

test('a present entry at this install\'s stableBin, or in a git checkout of web-chat, is kept as it is', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  setLocalEntry(root, { type: 'stdio', command: 'node', args: [BIN()], env: {} });
  let claude = fakeClaude();
  assert.equal(reg.apply(root, { runClaude: claude.fn, mcp: 'local' }).mcp.status, 'kept');
  assert.deepEqual(claude.calls, []);

  // The dogfood entry: a checkout's own bin.
  const checkout = tmpRoot('wc-mls-checkout-');
  fs.mkdirSync(path.join(checkout, 'bin'));
  fs.mkdirSync(path.join(checkout, '.git'));
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'claude-web-chat' }));
  fs.writeFileSync(path.join(checkout, 'bin', 'claude-web-chat-mcp.js'), '');
  const dogfood = project();
  setLocalEntry(dogfood, { command: 'node', args: [path.join(checkout, 'bin', 'claude-web-chat-mcp.js')] });
  claude = fakeClaude();
  assert.equal(reg.apply(dogfood, { runClaude: claude.fn, mcp: 'local' }).mcp.status, 'kept');
  assert.deepEqual(claude.calls, []);
});

test('an entry at another existing copy, or with a different env, is removed and re-added', (t) => {
  withTempHome(t);
  isolateClaude(t);
  // A surviving copy that is not a checkout: a version directory pruning deletes.
  const copy = tmpRoot('wc-mls-copy-');
  fs.mkdirSync(path.join(copy, 'bin'));
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: 'claude-web-chat' }));
  fs.writeFileSync(path.join(copy, 'bin', 'claude-web-chat-mcp.js'), '');
  const root = project();
  setLocalEntry(root, { command: 'node', args: [path.join(copy, 'bin', 'claude-web-chat-mcp.js')], env: { KEEP: 'me' } });
  let claude = fakeClaude();
  let out = reg.apply(root, { runClaude: claude.fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'repointed');
  assert.deepEqual(claude.calls.map((a) => a[1]), ['remove', 'add']);
  const entry = readConfig().projects[root].mcpServers['web-chat'];
  assert.deepEqual(entry.args, [BIN()]);
  assert.deepEqual(entry.env, { KEEP: 'me' }, 'with no .mcp.json entry to take it from, the entry\'s own env is kept');

  const two = project();
  writeMcp(two, { 'web-chat': ownEntry({ WEB_CHAT_PORT: '5199' }) });
  setLocalEntry(two, { command: 'node', args: [BIN()], env: { WEB_CHAT_PORT: '5173' } });
  claude = fakeClaude();
  out = reg.apply(two, { runClaude: claude.fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'repointed');
  assert.deepEqual(readConfig().projects[two].mcpServers['web-chat'].env, { WEB_CHAT_PORT: '5199' });
});

// ── the .mcp.json migration ─────────────────────────────────────────────────

test('migration: an untracked own entry goes only after a VERIFIED local entry, and the empty file with it', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  writeMcp(root, { 'web-chat': ownEntry() });
  let out = reg.apply(root, { runClaude: fakeClaude({ write: false }).fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'unverified', 'ok from `claude` proves nothing');
  assert.ok(readMcp(root).mcpServers['web-chat'], 'so the entry stays');

  out = reg.apply(root, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'registered');
  assert.equal(out.mcp.mcpJson.action, 'removed (file empty)');
  assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);

  const shared = project();
  writeMcp(shared, { 'web-chat': ownEntry(), other: { command: 'foo' } });
  out = reg.apply(shared, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(out.mcp.mcpJson.action, 'removed');
  assert.deepEqual(readMcp(shared), { mcpServers: { other: { command: 'foo' } } }, 'other servers stay');
});

test('migration: a TRACKED .mcp.json is edited only with consent, and then says to commit', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const repo = gitRepo('wc-mls-tracked-');
  fs.mkdirSync(projectPaths(repo).dir);
  writeMcp(repo, { 'web-chat': ownEntry() });
  git(repo, 'add', '.mcp.json');
  git(repo, 'commit', '-q', '-m', 'mcp');
  assert.deepEqual(reg.mcpQuestions(repo), { tracked: { file: path.join(repo, '.mcp.json') } });

  let out = reg.apply(repo, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'registered');
  assert.deepEqual(out.mcp.mcpJson, { action: 'kept', reason: 'tracked' });
  assert.deepEqual(out.mcp.needs, ['tracked']);
  assert.ok(readMcp(repo).mcpServers['web-chat'], 'untouched without consent');

  out = reg.apply(repo, { runClaude: fakeClaude().fn, mcp: 'local', consent: { editTracked: true } });
  assert.equal(out.mcp.status, 'kept');
  assert.equal(out.mcp.mcpJson.commit, true);
  assert.equal(fs.existsSync(path.join(repo, '.mcp.json')), false);
  assert.ok(reg.mcpResultLines(out.mcp).some((l) => /commit this change/.test(l)));
});

test('migration: an entry that differs (another user\'s path, an extra field) is reported and kept; the plugin stub is never touched', (t) => {
  withTempHome(t);
  isolateClaude(t);
  for (const entry of [
    { command: 'node', args: ['/Users/someone-else/.web-chat/current/bin/claude-web-chat-mcp.js'] },
    { command: 'node', args: [BIN()], cwd: '/tmp' },
    { type: 'sse', command: 'node', args: [BIN()] },
  ]) {
    const root = project();
    writeMcp(root, { 'web-chat': entry });
    const out = reg.apply(root, { runClaude: fakeClaude().fn, mcp: 'local' });
    assert.equal(out.mcp.mcpJson.action, 'kept');
    assert.equal(out.mcp.mcpJson.reason, 'differs');
    assert.deepEqual(readMcp(root).mcpServers['web-chat'], entry);
    assert.ok(reg.mcpResultLines(out.mcp).some((l) => /differs from what was registered/.test(l)));
  }
  const stubbed = project();
  const stub = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] };
  writeMcp(stubbed, { 'web-chat': stub });
  const before = fs.readFileSync(path.join(stubbed, '.mcp.json'), 'utf8');
  const out = reg.apply(stubbed, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'registered');
  assert.deepEqual(out.mcp.mcpJson, { action: 'kept', reason: 'plugin-stub' });
  assert.equal(fs.readFileSync(path.join(stubbed, '.mcp.json'), 'utf8'), before);
});

test('migration: nested Claude Code keys or nested approvals keep the entry, and are reported', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  const nested = path.join(root, 'sda');
  fs.mkdirSync(nested);
  git(nested, 'init', '-q');
  writeMcp(root, { 'web-chat': ownEntry() });
  writeConfig({ projects: { [nested]: { hasTrustDialogAccepted: true } } });
  let out = reg.apply(root, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.deepEqual(out.mcp.mcpJson, { action: 'kept', reason: 'nested' });
  assert.deepEqual(out.mcp.nested, [nested]);
  assert.ok(readMcp(root).mcpServers['web-chat']);

  const two = project();
  const approving = path.join(two, 'writer-face');
  fs.mkdirSync(claudePaths(approving).dir, { recursive: true });
  fs.writeFileSync(claudePaths(approving).settingsLocal, JSON.stringify({ enabledMcpjsonServers: ['web-chat'] }));
  writeMcp(two, { 'web-chat': ownEntry() });
  out = reg.apply(two, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(out.mcp.mcpJson.reason, 'nested');
  assert.ok(reg.describeMcp(reg.mcpState(two)).notes.some((n) => n.includes(approving)));
});

// ── a deliberate No ─────────────────────────────────────────────────────────

test('a recorded rejection is registered over only by an install creating .web-chat/, or with consent', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  fs.mkdirSync(claudePaths(root).dir, { recursive: true });
  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ enabledMcpjsonServers: ['web-chat'], disabledMcpjsonServers: ['web-chat'] }));
  writeMcp(root, { 'web-chat': ownEntry() });
  assert.deepEqual(reg.mcpQuestions(root).rejection, { files: [claudePaths(root).settingsLocal] });
  assert.equal(reg.mcpQuestions(root, { creating: true }).rejection, undefined, 'an install creating .web-chat/ does not ask');

  let claude = fakeClaude();
  let out = reg.apply(root, { runClaude: claude.fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'rejected');
  assert.deepEqual(claude.calls, [], 'no consent: nothing registered');

  claude = fakeClaude();
  out = reg.apply(root, { runClaude: claude.fn, mcp: 'local', creating: true });
  assert.equal(out.mcp.status, 'registered', 'the install that creates .web-chat/');

  const two = project();
  fs.mkdirSync(claudePaths(two).dir, { recursive: true });
  fs.writeFileSync(claudePaths(two).settingsLocal, JSON.stringify({ disabledMcpjsonServers: ['web-chat'] }));
  out = reg.apply(two, { runClaude: fakeClaude().fn, mcp: 'local', consent: { overRejection: true } });
  assert.equal(out.mcp.status, 'registered', 'a yes to the separate question');
});

test('mcpConsent asks each question defaulting to No, answers No with no terminal or --yes, and yes to --register-mcp', async () => {
  const q = { rejection: { files: ['/p/.claude/settings.local.json'] }, tracked: { file: '/p/.mcp.json' } };
  const asked = [];
  const tty = (answer) => ({ interactive: true, confirm: async (question, { def }) => { asked.push({ question, def }); return answer === undefined ? def : answer; } });
  const log = [];
  let c = await reg.mcpConsent(q, { prompt: tty(undefined), log: (m) => log.push(m) });
  assert.deepEqual(c, { overRejection: false });
  assert.equal(asked.length, 1, 'tracked is not asked once the registration itself was declined');
  assert.equal(asked[0].def, false);
  assert.ok(log.some((l) => /claude-web-chat off/.test(l)), 'the deliberate No is named');

  asked.length = 0;
  c = await reg.mcpConsent(q, { prompt: tty(true) });
  assert.deepEqual(c, { overRejection: true, editTracked: true });
  assert.ok(asked.every((a) => a.def === false));

  asked.length = 0;
  c = await reg.mcpConsent(q, { prompt: { interactive: false, confirm: async () => { throw new Error('never asked'); } } });
  assert.deepEqual(c, { overRejection: false });
  c = await reg.mcpConsent(q, { prompt: { interactive: false }, registerMcp: true });
  assert.deepEqual(c, { overRejection: true, editTracked: true });

  const decisions = { overRejection: false };
  c = await reg.mcpConsent(q, { prompt: tty(true), decisions });
  assert.deepEqual(c, { overRejection: false }, 'an answer already given in this run is not asked again');
});

test('a server disabled through /mcp is reported and never re-enabled', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  writeConfig({ projects: { [root]: { disabledMcpServers: ['web-chat'] } } });
  writeMcp(root, { 'web-chat': ownEntry() });
  const claude = fakeClaude();
  const out = reg.apply(root, { runClaude: claude.fn, mcp: 'local', creating: true, consent: { overRejection: true } });
  assert.equal(out.mcp.status, 'disabled');
  assert.deepEqual(claude.calls, []);
  assert.deepEqual(readConfig().projects[root].disabledMcpServers, ['web-chat']);
  assert.equal(reg.mcpState(root).kind, 'disabled');
});

test('no runnable claude: .mcp.json is written as today, with the three-part warning', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  const out = reg.apply(root, { runClaude: fakeClaude({ notFound: true }).fn, mcp: 'local' });
  assert.equal(out.mcp.status, 'no-claude');
  assert.equal(out.mcp.legacy, 'web-chat server registered');
  assert.deepEqual(readMcp(root).mcpServers['web-chat'], ownEntry());
  const w = out.mcp.warnings.join('\n');
  assert.match(w, /not found/);
  assert.match(w, /Claude Code will ask you to approve it/);
  assert.match(w, /may not keep that approval/);
  assert.match(w, /claude-web-chat doctor` finishes the registration once `claude` is available/);
});

// ── isRegistered, remove ────────────────────────────────────────────────────

test('isRegistered counts a local entry only under the root\'s own physical path', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const repo = gitRepo('wc-mls-isreg-');
  const sub = path.join(repo, 'app');
  const sibling = path.join(repo, 'other');
  fs.mkdirSync(sub);
  fs.mkdirSync(sibling);
  reg.apply(sub, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(reg.inspectLocal(sub).key, repo, 'the entry landed under the repository\'s root');
  assert.equal(reg.isRegistered(sibling), false, 'a sibling folder is not registered by it');
  assert.equal(reg.isRegistered(repo), true, 'the folder the key names is');
});

test('remove refuses a local key another web-chat root shares, and prints the command', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const repo = gitRepo('wc-mls-shared-');
  const a = path.join(repo, 'a');
  const b = path.join(repo, 'b');
  for (const d of [a, b]) fs.mkdirSync(projectPaths(d).dir, { recursive: true });
  reg.apply(a, { runClaude: fakeClaude().fn, mcp: 'local' });

  const claude = fakeClaude();
  const r = reg.remove(b, { runClaude: claude.fn, knownRoots: [] });
  assert.equal(r.localScope.status, 'shared');
  assert.deepEqual(r.localScope.others, [a]);
  assert.equal(r.localScope.key, repo);
  assert.deepEqual(claude.calls, [], 'nothing removed');
  assert.equal(reg.inspectLocal(a).state, 'present');

  // A known project (the registry's list) sharing it counts the same way.
  const repo2 = gitRepo('wc-mls-known-');
  const c = path.join(repo2, 'c');
  const d = path.join(repo2, 'deeper', 'than', 'the', 'walk', 'goes', 'd');
  for (const dir of [c, d]) fs.mkdirSync(projectPaths(dir).dir, { recursive: true });
  reg.apply(c, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(reg.remove(c, { runClaude: fakeClaude().fn, knownRoots: [] }).localScope.status, 'removed',
    'a .web-chat/ below the walk\'s depth is unseen without the registry');
  reg.apply(c, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.equal(reg.remove(c, { runClaude: fakeClaude().fn, knownRoots: [d] }).localScope.status, 'shared');

  // A sibling worktree with its own .web-chat/.
  const wt = path.join(tmpRoot('wc-mls-wts-'), 'feature');
  git(repo2, 'worktree', 'add', '-q', '-b', 'feature', wt);
  fs.mkdirSync(projectPaths(wt).dir);
  const fromRepo = reg.remove(c, { runClaude: fakeClaude().fn, knownRoots: [] });
  assert.equal(fromRepo.localScope.status, 'shared');
  assert.ok(fromRepo.localScope.others.includes(fs.realpathSync(wt)));
});

test('remove takes the registration record with the entry', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  reg.apply(root, { runClaude: fakeClaude().fn, mcp: 'local' });
  assert.ok(fs.existsSync(projectPaths(root).mcpRegistration));
  const r = reg.remove(root, { runClaude: fakeClaude().fn, knownRoots: [] });
  assert.equal(r.localScope.status, 'removed');
  assert.equal(fs.existsSync(projectPaths(root).mcpRegistration), false);
  assert.equal(reg.inspectLocal(root).state, 'absent');
});

// ── the writer and the restart verdict ──────────────────────────────────────

test('ensureMcpRegistration leaves an unchanged .mcp.json alone (its mtime is the restart verdict\'s input)', (t) => {
  withTempHome(t);
  const root = tmpRoot();
  assert.equal(ensureMcpRegistration(root), 'web-chat server registered');
  const file = path.join(root, '.mcp.json');
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  const before = fs.statSync(file).mtimeMs;
  assert.equal(ensureMcpRegistration(root), 'already up to date');
  assert.equal(fs.statSync(file).mtimeMs, before, 'not rewritten');
  writeMcp(root, { 'web-chat': { command: 'claude-web-chat-mcp' } });
  fs.utimesSync(file, old, old);
  ensureMcpRegistration(root);
  assert.ok(fs.statSync(file).mtimeMs > before, 'a real change is still written');
});

// ── mcpState / describeMcp ──────────────────────────────────────────────────

test('describeMcp words exactly one of the five states', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const say = (root) => reg.describeMcp(reg.mcpState(root));

  const none = project();
  assert.match(say(none).line, /^not registered — run `claude-web-chat doctor`$/);

  const pending = project();
  writeMcp(pending, { 'web-chat': ownEntry() });
  assert.match(say(pending).line, /^only in \.mcp\.json — Claude Code asks every launch here; run `claude-web-chat doctor`$/);

  const rejected = project();
  writeMcp(rejected, { 'web-chat': ownEntry() });
  fs.mkdirSync(claudePaths(rejected).dir);
  fs.writeFileSync(claudePaths(rejected).settingsLocal, JSON.stringify({ disabledMcpjsonServers: ['web-chat'] }));
  assert.match(say(rejected).line, /^REJECTED — web-chat is in disabledMcpjsonServers \(.*settings\.local\.json\), so web-chat's MCP tools are hidden: run `claude-web-chat doctor`, or `claude-web-chat off` if you meant it$/);

  const disabled = project();
  writeConfig({ ...readConfig(), projects: { ...(readConfig().projects || {}), [disabled]: { disabledMcpServers: ['web-chat'] } } });
  assert.match(say(disabled).line, /^disabled in Claude Code for this project \(\/mcp\) — re-enable it there, or run `claude-web-chat off`$/);

  const local = project();
  setLocalEntry(local, { command: 'node', args: ['/old/copy/bin/claude-web-chat-mcp.js'] });
  const l = say(local).line;
  assert.match(l, /^registered for you \(local scope\) in .*\.claude\.json/);
  assert.match(l, /its server is \/old\/copy\/bin\/claude-web-chat-mcp\.js, not this install's /, 'the bin is named when it differs');
});

test('describeMcp flags the approval dialog that still comes beside a .mcp.json entry — and never calls it harmless shadowing', (t) => {
  withTempHome(t);
  isolateClaude(t);
  const root = project();
  writeMcp(root, { 'web-chat': ownEntry() });
  fs.mkdirSync(claudePaths(root).dir);
  fs.writeFileSync(claudePaths(root).settingsLocal, JSON.stringify({ enabledMcpjsonServers: ['web-chat'] }));
  setLocalEntry(root, { command: 'node', args: [BIN()] });
  const notes = reg.describeMcp(reg.mcpState(root)).notes;
  assert.ok(notes.includes('Claude Code still shows its approval dialog at launch here; answering No once is now harmless'), notes.join('\n'));
  assert.ok(!notes.some((n) => /shadowed/i.test(n)));

  // An approval in the user's own settings is kept everywhere: no dialog.
  fs.mkdirSync(path.dirname(userClaudePaths().claudeSettings), { recursive: true });
  fs.writeFileSync(userClaudePaths().claudeSettings, JSON.stringify({ enabledMcpjsonServers: ['web-chat'] }));
  assert.equal(reg.mcpState(root).dialog, false);
});

test('sessionsWithoutTools: a live Claude Code process here with no MCP presence row naming it as parent', async () => {
  const root = tmpRoot();
  const states = [
    { pid: 101, cwd: root },
    { pid: 102, cwd: path.join(root, 'sub') },
    { pid: 103, cwd: root },
    { pid: 104, cwd: '/elsewhere' },
    { pid: 105, cwd: root },
  ];
  const mcpRows = [{ role: 'mcp', ppid: 103 }];
  const alive = (st) => (st.pid === 105 ? false : true);
  const out = await reg.sessionsWithoutTools(root, { states, mcpRows, alive });
  assert.deepEqual(out.map((x) => x.pid), [101, 102]);
});

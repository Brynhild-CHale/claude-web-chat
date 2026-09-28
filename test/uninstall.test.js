const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const uninstall = require('../lib/cli/commands/uninstall');
const { MANAGED_FILES, baselinePath } = require('../lib/update/managed-files');

// No test may shell out to a real `claude`: uninstall now also removes the
// LOCAL-scope registration doctor's repair writes. The cwd is recorded too —
// `--scope local` un-registers the directory `claude` runs in, so the argv alone
// does not say WHICH project was un-registered.
function fakeClaude(result = { ok: true }) {
  const calls = [];
  const cwds = [];
  return { fn: (argv, opts = {}) => { calls.push(argv); cwds.push(opts.cwd); return result; }, calls, cwds };
}

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-uninstall-')));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('uninstall removes every managed file, sidecars, baselines, and prunes empty dirs', async () => {
  const root = tmpRoot();
  // A populated install: every managed dest, one conflict sidecar, baselines,
  // hooks, an .mcp.json entry — plus an unrelated rule that must survive.
  for (const { dest } of MANAGED_FILES) write(path.join(root, dest), 'managed content\n');
  write(path.join(root, MANAGED_FILES[0].dest + '.new'), 'sidecar\n');
  write(path.join(root, '.claude', 'rules', 'other.md'), 'not ours\n');
  write(baselinePath(root), '{}\n');
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }],
    },
  }, null, 2));
  write(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { 'web-chat': { command: 'node', args: ['/x.js'] }, other: { command: 'foo' } },
  }, null, 2));

  const claude = fakeClaude();
  await uninstall([], { cwd: root, runClaude: claude.fn });
  assert.deepEqual(claude.calls, [['mcp', 'remove', 'web-chat', '--scope', 'local']],
    'the local-scope registration doctor writes is undone too — otherwise Claude Code keeps spawning the MCP server');
  assert.deepEqual(claude.cwds, [root]);

  for (const { dest } of MANAGED_FILES) {
    assert.ok(!fs.existsSync(path.join(root, dest)), `${dest} should be removed`);
  }
  assert.ok(!fs.existsSync(path.join(root, MANAGED_FILES[0].dest + '.new')), 'sidecar should be removed');
  assert.ok(!fs.existsSync(baselinePath(root)), 'baselines should be removed');
  // Skill dirs emptied by the removal are pruned; dirs with other content survive.
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills')), 'emptied skills tree should be pruned');
  assert.ok(fs.existsSync(path.join(root, '.claude', 'rules', 'other.md')), 'unrelated rule must survive');
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks, 'our hooks should be stripped');
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(!mcp.mcpServers['web-chat'], 'web-chat mcp entry should be removed');
  assert.deepEqual(mcp.mcpServers.other, { command: 'foo' }, 'other mcp entries must survive');
});

// A no-op has to be an ACTUAL no-op. uninstall used to resolve its root
// tolerantly (falling back to the cwd) so that `--self` would work anywhere —
// and `remove()` un-registers the LOCAL-scope entry by running `claude mcp
// remove web-chat --scope local` in that directory. So typing it in a directory
// that is not a project, and has no installed parent, wrote to Claude Code's own
// config on behalf of a project that never existed.
test('uninstall on a bare project is a no-op that does not throw, and tells `claude` nothing', async () => {
  const root = tmpRoot();
  const claude = fakeClaude();
  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await uninstall([], { cwd: root, runClaude: claude.fn });
  } finally {
    console.log = prevLog;
  }
  assert.deepEqual(claude.calls, [], 'nothing may be un-registered for a directory web-chat was never installed in');
  assert.match(lines.join('\n'), /Nothing to uninstall/);
  assert.doesNotMatch(lines.join('\n'), /uninstalled from/, 'and no removal is reported');
});

// The other side of that rule: `.web-chat/` deleted by hand leaves the hooks and
// the .mcp.json entry behind, still making Claude Code spawn the MCP server —
// which is exactly what uninstall is for. Refusing on a missing state directory
// would strand it, so the wiring itself decides.
test('a project whose .web-chat/ was deleted by hand is still uninstallable', async () => {
  const root = tmpRoot();
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }] },
  }, null, 2));
  write(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { 'web-chat': { command: 'node', args: ['/x.js'] } },
  }, null, 2));
  assert.equal(fs.existsSync(path.join(root, '.web-chat')), false, 'no state directory to find');

  const claude = fakeClaude();
  const prevLog = console.log;
  console.log = () => {};
  try {
    await uninstall([], { cwd: root, runClaude: claude.fn });
  } finally {
    console.log = prevLog;
  }
  assert.deepEqual(claude.calls, [['mcp', 'remove', 'web-chat', '--scope', 'local']]);
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks, 'the hooks that made Claude Code spawn web-chat are gone');
  const mcpFile = path.join(root, '.mcp.json');
  const mcp = fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : { mcpServers: {} };
  assert.ok(!mcp.mcpServers['web-chat'], 'and so is the entry that registered the server');
});

// From a subdirectory this printed "web-chat uninstalled from <subdir>" with
// every row "not present" — a no-op reported as success — while doctor, status
// and open in the same directory correctly found the parent.
test('uninstall from a SUBDIRECTORY removes from the enclosing project root', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  for (const { dest } of MANAGED_FILES) write(path.join(root, dest), 'managed content\n');
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });

  const claude = fakeClaude();
  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await uninstall([], { cwd: sub, runClaude: claude.fn });
  } finally {
    console.log = prevLog;
  }

  assert.match(lines.join('\n'), new RegExp(`uninstalled from ${root}`));
  // The shell-out is the half that leaves the project. Run from the shell's cwd
  // it would ask Claude Code to un-register the SUBDIRECTORY, leaving the
  // local-scope registration for the root — the exact thing this removal exists
  // to undo — alive after a reported-successful uninstall.
  assert.deepEqual(claude.cwds, [root], '`claude mcp remove --scope local` runs in the resolved root');
  for (const { dest } of MANAGED_FILES) {
    assert.ok(!fs.existsSync(path.join(root, dest)), `${dest} should be removed from the parent`);
  }
});

// The removal is driven by the hook EVENTS the template defines, not by a
// substring scan over whatever events happen to be in settings.json — this was
// the only site in the tree whose notion of "our hooks" was not template-derived.
test('uninstall strips our handlers and leaves someone else\'s alone', async () => {
  const root = tmpRoot();
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] },
        { hooks: [{ type: 'command', command: 'some-other-tool notify' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }],
    },
  }, null, 2));

  await uninstall([], { cwd: root, runClaude: fakeClaude().fn });

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.Stop, undefined, 'the emptied event is dropped');
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /some-other-tool/);
});

// R2-4's other half. `init` and `install` now refuse $HOME, so a 0.7.x user who
// said yes to the old home-directory question has exactly one way out: an
// `uninstall` typed in ~. findProjectRoot never returns $HOME (its .web-chat/ is
// the user tier), so the WIRING decides — and the user tier is left alone.
test('uninstall typed in $HOME removes a pre-0.8 home registration and keeps the user tier', async (t) => {
  const { withTempHome } = require('../test-support/helpers');
  const home = withTempHome(t);
  write(path.join(home, '.web-chat', 'versions', '0.8.0', 'package.json'), '{"version":"0.8.0"}\n');
  const rules = MANAGED_FILES.find((f) => f.dest.endsWith('rules/web-chat.md'));
  write(path.join(home, rules.dest), 'managed content\n');
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-begin' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }],
    },
    permissions: { allow: ['Bash(ls:*)'] },
  }, null, 2));
  write(path.join(home, '.mcp.json'), JSON.stringify({
    mcpServers: { 'web-chat': { command: 'node', args: ['/x.js'] } },
  }, null, 2));

  const claude = fakeClaude();
  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await uninstall([], { cwd: home, runClaude: claude.fn });
  } finally {
    console.log = prevLog;
  }

  assert.match(lines.join('\n'), new RegExp(`uninstalled from ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(claude.calls, [['mcp', 'remove', 'web-chat', '--scope', 'local']]);
  assert.deepEqual(claude.cwds, [home]);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!settings.hooks, 'the machine-wide hooks are gone');
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] }, 'the rest of ~/.claude/settings.json is kept');
  const mcpFile = path.join(home, '.mcp.json');
  const mcp = fs.existsSync(mcpFile) ? JSON.parse(fs.readFileSync(mcpFile, 'utf8')) : { mcpServers: {} };
  assert.ok(!mcp.mcpServers['web-chat'], 'and so is ~/.mcp.json\'s entry');
  assert.equal(fs.existsSync(path.join(home, rules.dest)), false, 'the managed rules file is removed');
  assert.ok(fs.existsSync(path.join(home, '.web-chat', 'versions', '0.8.0', 'package.json')), 'the user tier is untouched');
});

// ── --self and a running tunnel portal (R10-8) ─────────────────────────────
// `uninstall --self` deleted every version and the bins while an internet-
// facing portal and its cloudflared kept serving — with no `tunnel down` left
// on the machine to stop them. It now stops a registered portal first, with
// THIS build's `tunnel down`, and removes nothing when that fails.

function managedInstall(t) {
  const { withTempHome } = require('../test-support/helpers');
  const { installPaths } = require('../lib/core/paths');
  const { activate, linkBins } = require('../lib/update/install-layout');
  withTempHome(t);
  const paths = installPaths();
  const dir = paths.versionDir('0.8.0');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-web-chat', version: '0.8.0' }));
  for (const name of paths.BIN_NAMES) fs.writeFileSync(path.join(dir, 'bin', `${name}.js`), '#!/usr/bin/env node\n');
  activate('0.8.0', paths);
  linkBins(paths);
  return paths;
}

function binsPresent(paths) {
  return paths.BIN_NAMES.every((n) => { try { return fs.lstatSync(paths.binLink(n)).isSymbolicLink(); } catch { return false; } });
}

async function quietly(fn) {
  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = prevLog; }
  return lines.join('\n');
}

test('uninstall --self stops a registered tunnel portal with this build\'s `tunnel down` BEFORE removing anything', async (t) => {
  const paths = managedInstall(t);
  const downs = [];
  let res = null;
  const out = await quietly(async () => {
    res = await uninstall(['--self'], {
      cwd: tmpRoot(),
      runClaude: fakeClaude().fn,
      env: { WEB_CHAT_PORTAL_PORT: '1' },
      readPortal: () => ({ role: 'portal', pid: 4242, port: 45678 }),
      tunnelDown: async (o) => {
        downs.push({ port: o.env.WEB_CHAT_PORTAL_PORT, versions: fs.existsSync(paths.versionDir('0.8.0')), bins: binsPresent(paths) });
        return { stopped: true };
      },
    });
  });
  assert.deepEqual(downs, [{ port: '45678', versions: true, bins: true }],
    'stopped once, on the registered port, while the command that can stop it is still installed');
  assert.deepEqual(res, { portal: { stopped: true } });
  assert.match(out, /Stopped the tunnel portal \(pid 4242\) and its cloudflared — remote access is off\./);
  assert.ok(out.indexOf('Stopped the tunnel portal') < out.indexOf('Removed the claude-web-chat install'));
  assert.equal(fs.existsSync(paths.versions), false, 'then the program is removed');
  assert.equal(binsPresent(paths), false);
});

test('uninstall --self whose portal will not stop removes nothing — not the versions, not the bins, not the project', async (t) => {
  const paths = managedInstall(t);
  const root = tmpRoot();
  write(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'claude-web-chat-hook turn-end' }] }] },
  }, null, 2));
  const claude = fakeClaude();
  let out = '';
  await assert.rejects(
    async () => {
      out = await quietly(() => uninstall(['--self'], {
        cwd: root,
        runClaude: claude.fn,
        readPortal: () => ({ role: 'portal', pid: 4242, port: 45678 }),
        tunnelDown: async () => { throw new Error('the portal (pid 4242) is still answering on 127.0.0.1:45678'); },
      }));
    },
    (e) => e.userFacing === true
      && /tunnel portal \(pid 4242\) could not be stopped: the portal \(pid 4242\) is still answering/.test(e.message)
      && /Nothing was removed\. Stop it with `claude-web-chat tunnel down`/.test(e.message),
  );
  assert.equal(out, '');
  assert.ok(fs.existsSync(paths.versionDir('0.8.0')), 'the versions are still there');
  assert.ok(binsPresent(paths), 'and so are the bins — `tunnel down` is still on PATH');
  assert.deepEqual(claude.calls, [], 'the project was not un-registered either');
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.Stop, 'its hooks are untouched');
});

test('uninstall --self with no portal registered never calls `tunnel down`; plain uninstall never asks', async (t) => {
  const paths = managedInstall(t);
  let downs = 0;
  let asked = 0;
  const opts = {
    cwd: tmpRoot(),
    runClaude: fakeClaude().fn,
    readPortal: () => { asked++; return null; },
    tunnelDown: async () => { downs++; return { stopped: true }; },
  };
  await quietly(() => uninstall([], opts));
  assert.equal(asked, 0, 'a project-only uninstall leaves the portal alone');
  assert.ok(fs.existsSync(paths.versions));
  await quietly(() => uninstall(['--self'], opts));
  assert.equal(asked, 1);
  assert.equal(downs, 0);
  assert.equal(fs.existsSync(paths.versions), false);
});

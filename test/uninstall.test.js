const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const uninstall = require('../lib/cli/commands/uninstall');
const { MANAGED_FILES, baselinePath } = require('../lib/update/managed-files');

// No test may shell out to a real `claude`: uninstall now also removes the
// LOCAL-scope registration doctor's repair writes.
function fakeClaude(result = { ok: true }) {
  const calls = [];
  return { fn: (argv) => { calls.push(argv); return result; }, calls };
}

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-uninstall-')));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('uninstall removes every managed file, sidecars, baselines, and prunes empty dirs', () => {
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
  uninstall([], { cwd: root, runClaude: claude.fn });
  assert.deepEqual(claude.calls, [['mcp', 'remove', 'web-chat', '--scope', 'local']],
    'the local-scope registration doctor writes is undone too — otherwise Claude Code keeps spawning the MCP server');

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

test('uninstall on a bare project is a no-op that does not throw', () => {
  const root = tmpRoot();
  uninstall([], { cwd: root, runClaude: fakeClaude().fn });
});

// From a subdirectory this printed "web-chat uninstalled from <subdir>" with
// every row "not present" — a no-op reported as success — while doctor, status
// and open in the same directory correctly found the parent.
test('uninstall from a SUBDIRECTORY removes from the enclosing project root', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.web-chat'), { recursive: true });
  for (const { dest } of MANAGED_FILES) write(path.join(root, dest), 'managed content\n');
  const sub = path.join(root, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });

  const lines = [];
  const prevLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    uninstall([], { cwd: sub, runClaude: fakeClaude().fn });
  } finally {
    console.log = prevLog;
  }

  assert.match(lines.join('\n'), new RegExp(`uninstalled from ${root}`));
  for (const { dest } of MANAGED_FILES) {
    assert.ok(!fs.existsSync(path.join(root, dest)), `${dest} should be removed from the parent`);
  }
});

// The removal is driven by the hook EVENTS the template defines, not by a
// substring scan over whatever events happen to be in settings.json — this was
// the only site in the tree whose notion of "our hooks" was not template-derived.
test('uninstall strips our handlers and leaves someone else\'s alone', () => {
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

  uninstall([], { cwd: root, runClaude: fakeClaude().fn });

  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.Stop, undefined, 'the emptied event is dropped');
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /some-other-tool/);
});

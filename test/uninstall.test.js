const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const uninstall = require('../lib/cli/commands/uninstall');
const { MANAGED_FILES, baselinePath } = require('../lib/update/managed-files');

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

  const prevCwd = process.cwd();
  process.chdir(root);
  try {
    uninstall();
  } finally {
    process.chdir(prevCwd);
  }

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
  const prevCwd = process.cwd();
  process.chdir(root);
  try {
    uninstall();
  } finally {
    process.chdir(prevCwd);
  }
});

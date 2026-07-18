const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ensureMcpRegistration, channelEnv, mcpEntryHasChannelEnv } = require('../lib/update/managed-files');

// `install` (via ensureMcpRegistration) writes the channels opt-in
// into the PROJECT's .mcp.json. All tests operate on a tmp root so the dogfood
// repo's own tracked .mcp.json is never touched.
function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-install-')));
}

function readMcp(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
}

function writeMcp(root, obj) {
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(obj, null, 2) + '\n');
}

test('install wires WEB_CHAT_CHANNEL=1 into a fresh .mcp.json entry', () => {
  const root = tmpRoot();
  const status = ensureMcpRegistration(root);
  assert.equal(status, 'web-chat server registered');
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.equal(entry.command, 'node');
  assert.ok(path.isAbsolute(entry.args[0]) && /bin\/claude-web-chat-mcp\.js$/.test(entry.args[0]));
  assert.equal(entry.env.WEB_CHAT_CHANNEL, '1');
  assert.ok(mcpEntryHasChannelEnv(entry));
});

test('install is idempotent — re-running on an already-wired entry does not duplicate env', () => {
  const root = tmpRoot();
  ensureMcpRegistration(root);
  const first = readMcp(root);
  const status = ensureMcpRegistration(root);
  assert.equal(status, 'already up to date');
  const second = readMcp(root);
  // Byte-identical: no growth, no duplicate keys, one WEB_CHAT_CHANNEL=1.
  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(second.mcpServers['web-chat'].env), ['WEB_CHAT_CHANNEL']);
});

test('install preserves unrelated env keys a user added', () => {
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: {
      'web-chat': { command: 'node', args: ['/old/path.js'], env: { HTTP_PROXY: 'http://proxy:8080', DEBUG: 'wc:*' } },
    },
  });
  ensureMcpRegistration(root);
  const entry = readMcp(root).mcpServers['web-chat'];
  // Channel opt-in added...
  assert.equal(entry.env.WEB_CHAT_CHANNEL, '1');
  // ...without clobbering the user's keys.
  assert.equal(entry.env.HTTP_PROXY, 'http://proxy:8080');
  assert.equal(entry.env.DEBUG, 'wc:*');
  // Command/args are still rewritten to the resolvable absolute bin.
  assert.equal(entry.command, 'node');
  assert.ok(/bin\/claude-web-chat-mcp\.js$/.test(entry.args[0]));
});

test('install preserves other mcpServers entries', () => {
  const root = tmpRoot();
  writeMcp(root, { mcpServers: { other: { command: 'foo' } } });
  ensureMcpRegistration(root);
  const mcp = readMcp(root);
  assert.deepEqual(mcp.mcpServers.other, { command: 'foo' });
  assert.equal(mcp.mcpServers['web-chat'].env.WEB_CHAT_CHANNEL, '1');
});

test('install preserves a plugin-portable entry when running under plugin packaging', () => {
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: {
      'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] },
    },
  });
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = '/plugin/root';
  try {
    const status = ensureMcpRegistration(root);
    assert.equal(status, 'kept plugin registration');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prev;
  }
  const entry = readMcp(root).mcpServers['web-chat'];
  // Portable args untouched, channels opt-in still wired in.
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js']);
  assert.equal(entry.env.WEB_CHAT_CHANNEL, '1');
});

test('install rewrites a portable entry when NOT under plugin packaging (placeholder cannot resolve)', () => {
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: {
      'web-chat': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js'] },
    },
  });
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  try {
    ensureMcpRegistration(root);
  } finally {
    if (prev !== undefined) process.env.CLAUDE_PLUGIN_ROOT = prev;
  }
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.ok(path.isAbsolute(entry.args[0]) && /bin\/claude-web-chat-mcp\.js$/.test(entry.args[0]));
  assert.equal(entry.env.WEB_CHAT_CHANNEL, '1');
});

test('channelEnv merges without mutating the input and never drops keys', () => {
  const input = { FOO: 'bar' };
  const out = channelEnv(input);
  assert.deepEqual(out, { FOO: 'bar', WEB_CHAT_CHANNEL: '1' });
  assert.deepEqual(input, { FOO: 'bar' }, 'input not mutated');
  // Non-object / array inputs degrade to a clean env with just the opt-in.
  assert.deepEqual(channelEnv(undefined), { WEB_CHAT_CHANNEL: '1' });
  assert.deepEqual(channelEnv([]), { WEB_CHAT_CHANNEL: '1' });
});

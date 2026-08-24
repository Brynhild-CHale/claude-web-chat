const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ensureMcpRegistration, channelEnv, stripChannelEnv, mcpEntryHasChannelEnv } = require('../lib/update/managed-files');

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

// Channels is a SESSION property, not a project one: it exists only when Claude
// Code was launched with the capability flag. Pinning WEB_CHAT_CHANNEL=1 into
// .mcp.json made the MCP server start a channel bridge in EVERY session, so a
// Push in a flag-less session was written to stdout, self-acked, reported
// "Delivered to Claude ✓" — and dropped, with the parked fallback never running.
// install must therefore never write it; the launch line supplies it.
test('install does NOT pin WEB_CHAT_CHANNEL into a fresh .mcp.json entry', () => {
  const root = tmpRoot();
  const status = ensureMcpRegistration(root);
  assert.equal(status, 'web-chat server registered');
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.equal(entry.command, 'node');
  assert.ok(path.isAbsolute(entry.args[0]) && /bin\/claude-web-chat-mcp\.js$/.test(entry.args[0]));
  assert.equal(entry.env, undefined, 'no env block at all when there is nothing to put in it');
  assert.ok(!mcpEntryHasChannelEnv(entry));
});

test('install CLEANS a stale WEB_CHAT_CHANNEL written by an older install', () => {
  const root = tmpRoot();
  writeMcp(root, {
    mcpServers: { 'web-chat': { command: 'node', args: ['/old/path.js'], env: { WEB_CHAT_CHANNEL: '1' } } },
  });
  ensureMcpRegistration(root);
  const entry = readMcp(root).mcpServers['web-chat'];
  assert.ok(!mcpEntryHasChannelEnv(entry), 'stale opt-in removed on upgrade');
  assert.equal(entry.env, undefined, 'no empty env block left behind');
});

test('install is idempotent — re-running produces a byte-identical entry', () => {
  const root = tmpRoot();
  ensureMcpRegistration(root);
  const first = readMcp(root);
  const status = ensureMcpRegistration(root);
  assert.equal(status, 'already up to date');
  const second = readMcp(root);
  assert.deepEqual(second, first);
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
  // No channel opt-in written...
  assert.ok(!mcpEntryHasChannelEnv(entry));
  // ...and the user's own keys survive untouched.
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
  assert.ok(!mcpEntryHasChannelEnv(mcp.mcpServers['web-chat']));
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
  // Portable args untouched, and no channels opt-in pinned into the committed stub.
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/bin/claude-web-chat-mcp.js']);
  assert.ok(!mcpEntryHasChannelEnv(entry));
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
  assert.ok(!mcpEntryHasChannelEnv(entry));
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

test('stripChannelEnv drops only the opt-in, without mutating the input', () => {
  const input = { FOO: 'bar', WEB_CHAT_CHANNEL: '1' };
  assert.deepEqual(stripChannelEnv(input), { FOO: 'bar' });
  assert.deepEqual(input, { FOO: 'bar', WEB_CHAT_CHANNEL: '1' }, 'input not mutated');
  // Nothing left to keep → undefined, so no empty `env: {}` is written.
  assert.equal(stripChannelEnv({ WEB_CHAT_CHANNEL: '1' }), undefined);
  assert.equal(stripChannelEnv(undefined), undefined);
  assert.equal(stripChannelEnv([]), undefined);
});

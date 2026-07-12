const test = require('node:test');
const assert = require('node:assert');

// the channels line in `status`. describeChannels is the pure
// phrasing core — given the env-wiring flag and the /api/queue/policy body, it
// returns the layman-facing state + line status prints.
const { describeChannels } = require('../lib/cli/commands/status');

test('unwired: no WEB_CHAT_CHANNEL in .mcp.json → tells the user to install', () => {
  const r = describeChannels({ envWired: false, policy: null });
  assert.equal(r.state, 'unwired');
  assert.match(r.line, /not wired/);
  assert.match(r.line, /claude-web-chat install/);
});

test('unwired wins even if a stray policy shows connected (env is the gate)', () => {
  const r = describeChannels({ envWired: false, policy: { channel_connected: true } });
  assert.equal(r.state, 'unwired');
});

test('connected: wired + a channel-enabled session actually attached', () => {
  const r = describeChannels({ envWired: true, policy: { channel_connected: true } });
  assert.equal(r.state, 'connected');
  assert.equal(r.line, 'connected');
});

test('wired-waiting: wired but daemon up with no channel connected', () => {
  const r = describeChannels({ envWired: true, policy: { channel_connected: false } });
  assert.equal(r.state, 'wired');
  assert.match(r.line, /wired, waiting for a channel-enabled Claude Code session/);
});

test('wired-waiting: wired but daemon down (no policy observable)', () => {
  const r = describeChannels({ envWired: true, policy: null });
  assert.equal(r.state, 'wired');
  assert.match(r.line, /wired, waiting for a channel-enabled Claude Code session/);
});

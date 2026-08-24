const test = require('node:test');
const assert = require('node:assert');

// the channels line in `status`. describeChannels is the pure phrasing core —
// given the stale-env flag and the /api/queue/policy body, it returns the
// layman-facing state + line status prints.
//
// The polarity here INVERTED in the 0.4.x release pass. Channels is a property
// of the SESSION (Claude Code launched with the capability flag), not of the
// project, so a WEB_CHAT_CHANNEL pinned into .mcp.json is no longer the desired
// state — it is a defect that makes the MCP server start a channel bridge in
// sessions with no channel behind it, so a Push self-acks as delivered and is
// dropped instead of parked. The live policy is now the only real signal.
const { describeChannels } = require('../lib/cli/commands/status');

test('stale env: a pinned WEB_CHAT_CHANNEL is reported as a defect to repair', () => {
  const r = describeChannels({ staleEnv: true, policy: null });
  assert.equal(r.state, 'stale-env');
  assert.match(r.line, /stale WEB_CHAT_CHANNEL/);
  assert.match(r.line, /claude-web-chat doctor/);
});

test('stale env wins even if the policy shows connected — the wiring still needs cleaning', () => {
  const r = describeChannels({ staleEnv: true, policy: { channel_connected: true } });
  assert.equal(r.state, 'stale-env');
});

test('connected: a channel-enabled session is actually attached', () => {
  const r = describeChannels({ staleEnv: false, policy: { channel_connected: true } });
  assert.equal(r.state, 'connected');
  assert.equal(r.line, 'connected');
});

test('parked: daemon up, no channel connected — states the real fallback', () => {
  const r = describeChannels({ staleEnv: false, policy: { channel_connected: false } });
  assert.equal(r.state, 'parked');
  assert.match(r.line, /delivers with your next message/);
});

test('parked: daemon down (no policy observable) reads the same way', () => {
  const r = describeChannels({ staleEnv: false, policy: null });
  assert.equal(r.state, 'parked');
  assert.match(r.line, /delivers with your next message/);
});

// The channel-liveness proof (spec §6.7, lib/mcp/channel-proof.js) and its
// use in the MCP entrypoint: WEB_CHAT_CHANNEL=1 still DECLARES the channel
// capability, but the bridge starts only in a session that loaded the channel
// — WEB_CHAT_CHANNEL_FORCE=1, or the parent's command line naming web-chat on
// the channel flags. An inherited env alone (V11's nested session) starts
// nothing and says so once on stderr.
//
// The sandbox scrubs WEB_CHAT_CHANNEL and WEB_CHAT_CHANNEL_FORCE
// (test-support/sandbox.js), so every subprocess here sets both explicitly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { withServer, waitUntil } = require('../test-support/helpers');
const { channelProof, parseChannelFlags, INITIALIZE_PROOF, INITIALIZE_KEY } = require('../lib/mcp/channel-proof');
const { LAUNCH_COMMAND } = require('../lib/core/channels');

const MCP_BIN = path.join(__dirname, '..', 'bin', 'claude-web-chat-mcp.js');
const DEV = '--dangerously-load-development-channels';

// ───────────────────────────────────────────── parseChannelFlags ────

test('parseChannelFlags: the dev flag with a space-separated value', () => {
  assert.deepEqual(parseChannelFlags(`claude ${DEV} server:web-chat`), { devChannels: ['server:web-chat'], channels: [] });
});

test('parseChannelFlags: the --flag=value form', () => {
  assert.deepEqual(parseChannelFlags(`claude ${DEV}=server:web-chat --model haiku`).devChannels, ['server:web-chat']);
  assert.deepEqual(parseChannelFlags('claude --channels=plugin:web-chat@market').channels, ['plugin:web-chat@market']);
});

test('parseChannelFlags: a comma list is split', () => {
  assert.deepEqual(parseChannelFlags(`claude ${DEV} server:other,server:web-chat`).devChannels, ['server:other', 'server:web-chat']);
});

test('parseChannelFlags: a value ends at the next flag, and several values may follow one flag', () => {
  const f = parseChannelFlags(`node /x/cli.js ${DEV} server:web-chat server:two --model haiku -p say ok`);
  assert.deepEqual(f.devChannels, ['server:web-chat', 'server:two']);
  assert.deepEqual(f.channels, []);
});

test('parseChannelFlags: --channels web-chat and --channels plugin:web-chat@market', () => {
  assert.deepEqual(parseChannelFlags('claude --channels web-chat').channels, ['web-chat']);
  assert.deepEqual(parseChannelFlags('claude --channels plugin:web-chat@market --verbose').channels, ['plugin:web-chat@market']);
});

test('parseChannelFlags: a command naming only server:other names no web-chat', () => {
  const f = parseChannelFlags(`claude ${DEV} server:other --channels server:other`);
  assert.deepEqual(f, { devChannels: ['server:other'], channels: ['server:other'] });
  assert.equal(channelProof({ parentCommand: `claude ${DEV} server:other --channels server:other`, env: {} }).start, false);
});

test('parseChannelFlags: nothing to read → empty lists', () => {
  for (const c of [null, undefined, '', 'claude', 42]) {
    assert.deepEqual(parseChannelFlags(c), { devChannels: [], channels: [] });
  }
});

// ─────────────────────────────────────────────────── channelProof ────

test('channelProof: WEB_CHAT_CHANNEL_FORCE=1 wins, by force, whatever else is true', () => {
  const p = channelProof({ parentCommand: 'claude', clientCapabilities: {}, env: { WEB_CHAT_CHANNEL: '1', WEB_CHAT_CHANNEL_FORCE: '1' } });
  assert.equal(p.start, true);
  assert.equal(p.by, 'force');
  assert.match(p.why, /WEB_CHAT_CHANNEL_FORCE/);
  assert.equal(channelProof({ parentCommand: null, env: { WEB_CHAT_CHANNEL_FORCE: '0' } }).start, false, "only '1' forces");
});

test('channelProof: the flag in the parent command → by argv', () => {
  const dev = channelProof({ parentCommand: `claude ${DEV} server:web-chat`, env: { WEB_CHAT_CHANNEL: '1' } });
  assert.deepEqual([dev.start, dev.by], [true, 'argv']);
  for (const v of ['server:web-chat', 'web-chat', 'plugin:web-chat@market']) {
    const p = channelProof({ parentCommand: `claude --channels ${v}`, env: {} });
    assert.deepEqual([p.start, p.by], [true, 'argv'], v);
  }
  // The dev flag loads a server by its full name only.
  assert.equal(channelProof({ parentCommand: `claude ${DEV} web-chat`, env: {} }).start, false);
  // A near-name is another channel: --channels names web-chat exactly, or its plugin.
  for (const v of ['server:web-chat-dev', 'web-chatty', 'plugin:web-chat-x@market', 'plugin:not-web-chat@market', 'plugin:web-chat@']) {
    assert.equal(channelProof({ parentCommand: `claude --channels ${v}`, env: {} }).start, false, v);
  }
  assert.equal(channelProof({ parentCommand: `claude ${DEV} server:web-chat-dev`, env: {} }).start, false);
});

test('channelProof: a client capability alone does not start while INITIALIZE_PROOF is false', () => {
  assert.equal(INITIALIZE_PROOF, false, 'rule (a) waits on the maintainer recording V26');
  assert.equal(INITIALIZE_KEY, null);
  const caps = { experimental: { 'claude/channel': {} }, channels: { 'web-chat': {} } };
  const p = channelProof({ clientCapabilities: caps, parentCommand: 'claude', env: { WEB_CHAT_CHANNEL: '1' } });
  assert.deepEqual([p.start, p.by], [false, null]);
});

test('channelProof: rule (a), once switched on with a key, starts on that key only', () => {
  const initialize = { enabled: true, key: ['experimental', 'claude/channel'] };
  const on = channelProof({ clientCapabilities: { experimental: { 'claude/channel': {} } }, parentCommand: 'claude', env: {}, initialize });
  assert.deepEqual([on.start, on.by], [true, 'initialize']);
  const off = channelProof({ clientCapabilities: { experimental: {} }, parentCommand: 'claude', env: {}, initialize });
  assert.equal(off.start, false);
  // Switched on without a key, it consults nothing.
  assert.equal(channelProof({ clientCapabilities: { experimental: { 'claude/channel': {} } }, env: {}, initialize: { enabled: true, key: null } }).start, false);
});

test('channelProof: nothing → start false, by null, with a why', () => {
  const unread = channelProof({ parentCommand: null, env: {} });
  assert.deepEqual([unread.start, unread.by], [false, null]);
  assert.match(unread.why, /could not be read/);
  const plain = channelProof({ parentCommand: 'node /x/test-runner.js', env: { WEB_CHAT_CHANNEL: '1' } });
  assert.deepEqual([plain.start, plain.by], [false, null]);
  assert.match(plain.why, /names no web-chat channel/);
  assert.deepEqual(channelProof().start, false, 'no arguments at all');
});

// ─────────────────────────────────── the real MCP server, end to end ────

function channelEnv(home, extra = {}) {
  // FORCE and the channel set explicitly, spread last: the "off" cases must be
  // off whatever the developer's shell carries.
  return { ...process.env, HOME: home, USERPROFILE: home, WEB_CHAT_PORT: '', WEB_CHAT_CHANNEL: '1', WEB_CHAT_CHANNEL_FORCE: '', ...extra };
}

async function launch(t, { root, env, wrapper = null }) {
  const transport = new StdioClientTransport(wrapper
    ? { command: process.execPath, args: wrapper, cwd: root, env, stderr: 'pipe' }
    : { command: process.execPath, args: [MCP_BIN], cwd: root, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', (d) => { stderr += String(d); });
  const client = new Client({ name: 'channel-proof-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, stderr: () => stderr };
}

const policy = async (api) => (await api.get('/api/queue/policy')).json;
const project = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-chproof-')));
const NOTICE = 'WEB_CHAT_CHANNEL is set, but this Claude Code session did not load the web-chat channel';

test('MCP server: an inherited WEB_CHAT_CHANNEL=1 under a parent without the flag declares the capability, starts no bridge, and says so once', async (t) => {
  const { api, root, home } = await withServer(t, { writePortfile: true, root: project() });
  const { client, stderr } = await launch(t, { root, env: channelEnv(home) });

  const caps = client.getServerCapabilities();
  assert.deepEqual(caps.experimental && caps.experimental['claude/channel'], {}, 'the capability is still declared');

  await waitUntil(() => stderr().includes(NOTICE), { timeout: 10_000, what: 'the channel notice on stderr' });
  assert.equal(await waitUntil(async () => (await policy(api)).wake_consumers > 0, { timeout: 2000 }), false,
    'no wake consumer connects for 2 s');
  assert.equal(stderr().split(NOTICE).length - 1, 1, 'the line is written once');
  assert.ok(stderr().includes(`Start Claude Code with: ${LAUNCH_COMMAND} (or set WEB_CHAT_CHANNEL_FORCE=1).`), stderr());
});

test('MCP server: WEB_CHAT_CHANNEL_FORCE=1 starts the bridge with no flag in the parent', async (t) => {
  const { api, root, home } = await withServer(t, { writePortfile: true, root: project() });
  const { stderr } = await launch(t, { root, env: channelEnv(home, { WEB_CHAT_CHANNEL_FORCE: '1' }) });
  await waitUntil(async () => (await policy(api)).wake_consumers === 1, { timeout: 10_000, what: 'the bridge to connect as the wake consumer' });
  assert.ok(!stderr().includes(NOTICE), 'no notice when the bridge starts');
});

test('MCP server: a parent whose command line loads server:web-chat starts the bridge', async (t) => {
  const { api, root, home } = await withServer(t, { writePortfile: true, root: project() });
  // The wrapper is the MCP server's parent, so `ps` shows it carrying the
  // flag, as it would show Claude Code. It passes stdio through and forwards
  // the signals the client's close sends, so the server goes with it.
  const script = "const c=require('child_process').spawn(process.execPath,[process.env.WC_MCP_BIN],{stdio:'inherit'});"
    + "for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>c.kill(s));c.on('exit',(x)=>process.exit(x==null?1:x))";
  const { stderr } = await launch(t, {
    root,
    env: channelEnv(home, { WC_MCP_BIN: MCP_BIN }),
    // `--` ends node's own options, so the flag reaches the wrapper's argv.
    wrapper: ['-e', script, '--', DEV, 'server:web-chat'],
  });
  await waitUntil(async () => (await policy(api)).wake_consumers === 1, { timeout: 10_000, what: 'the bridge to connect as the wake consumer' });
  assert.ok(!stderr().includes(NOTICE), 'no notice when the bridge starts');
});

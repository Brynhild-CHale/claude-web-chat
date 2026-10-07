// The channel-liveness proof (spec §6.7): did THIS Claude Code session load the
// web-chat channel?
//
// WEB_CHAT_CHANNEL=1 is not that proof. It is an environment variable, so it is
// inherited: a session started inside a channel session (a nested `claude`, a
// workflow agent, a shell opened from one) carries it without having loaded
// any channel. Before 0.8.5 the env alone started the bridge, and in such a
// session the bridge drained the park on connect and acked writes nobody read
// (design/chat-mirror-validation.md V11, "Inherited env"). The capability is
// still declared on the env (it must be, before connect), but the bridge starts
// only when one of these says the session loaded the channel, in this order:
//
//   (c) WEB_CHAT_CHANNEL_FORCE=1 — the user's override, for a launcher this
//       proof cannot see through.
//   (a) the MCP `initialize` client capabilities — only once gate V26 shows a
//       key Claude Code advertises WITH the dev-channel flag and not without
//       it. Until then INITIALIZE_PROOF is false and the capabilities are not
//       consulted at all: a key advertised in every session would start the
//       bridge everywhere, which is the very bug.
//   (b) the parent's command line (`ps -o command=`, read by the caller):
//       `--dangerously-load-development-channels` naming server:web-chat, or
//       `--channels` naming web-chat.
//
// Pure: no process is read here. The caller passes the parent command and the
// client capabilities, so every rule is tested without a subprocess.

const { CHANNEL_NAME } = require('../core/channels');

// Rule (a)'s switch and key. Set together, and only from a recorded V26 run
// (spec §10.3): INITIALIZE_KEY is the path into the client capabilities that
// V26 saw differ with and without the flag, e.g. ['experimental', '<key>'].
const INITIALIZE_PROOF = false;
const INITIALIZE_KEY = null;

const DEV_FLAG = '--dangerously-load-development-channels';
const CHANNELS_FLAG = '--channels';

// The values each flag carries on a command line as `ps` prints it. `ps` keeps
// no quoting, so the line is split on whitespace; a value is the `--flag=value`
// form, or the tokens after the flag up to the next one starting with '-', and
// each value is split on commas. Unknown input → empty lists.
function parseChannelFlags(command) {
  const out = { devChannels: [], channels: [] };
  if (typeof command !== 'string' || !command) return out;
  const tokens = command.split(/\s+/).filter(Boolean);
  const listFor = (flag) => (flag === DEV_FLAG ? out.devChannels : out.channels);
  const push = (flag, value) => {
    for (const v of String(value).split(',')) if (v) listFor(flag).push(v);
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    for (const flag of [DEV_FLAG, CHANNELS_FLAG]) {
      if (tok === flag) {
        let j = i + 1;
        while (j < tokens.length && !tokens[j].startsWith('-')) push(flag, tokens[j++]);
        i = j - 1;
      } else if (tok.startsWith(`${flag}=`)) {
        push(flag, tok.slice(flag.length + 1));
      }
    }
  }
  return out;
}

// --channels names a channel server by its MCP name or its plugin.
function namesWebChat(value) {
  return value === CHANNEL_NAME || value === 'web-chat' || /^plugin:web-chat@[^\s,]+$/.test(value);
}

function capabilityAt(caps, key) {
  if (!caps || !Array.isArray(key) || !key.length) return undefined;
  let cur = caps;
  for (const k of key) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// → {start, by: 'force' | 'initialize' | 'argv' | null, why}. `initialize`
// overrides rule (a)'s switch and key; it exists for the tests of the rule
// V26 will turn on, and production never passes it.
function channelProof({ clientCapabilities, parentCommand, env, initialize } = {}) {
  const e = env || {};
  if (e.WEB_CHAT_CHANNEL_FORCE === '1') {
    return { start: true, by: 'force', why: 'WEB_CHAT_CHANNEL_FORCE=1 is set' };
  }

  const rule = initialize || { enabled: INITIALIZE_PROOF, key: INITIALIZE_KEY };
  if (rule.enabled && Array.isArray(rule.key) && rule.key.length) {
    if (capabilityAt(clientCapabilities, rule.key) !== undefined) {
      return { start: true, by: 'initialize', why: `the initialize client capabilities carry ${rule.key.join('.')}` };
    }
  }

  const flags = parseChannelFlags(parentCommand);
  if (flags.devChannels.includes(CHANNEL_NAME)) {
    return { start: true, by: 'argv', why: `the parent command loads ${CHANNEL_NAME} with ${DEV_FLAG}` };
  }
  const named = flags.channels.find(namesWebChat);
  if (named) {
    return { start: true, by: 'argv', why: `the parent command loads ${named} with ${CHANNELS_FLAG}` };
  }

  return {
    start: false,
    by: null,
    why: parentCommand
      ? `the parent command names no web-chat channel (${DEV_FLAG} ${CHANNEL_NAME}, or ${CHANNELS_FLAG} web-chat)`
      : 'the parent command line could not be read, and nothing else shows the channel loaded',
  };
}

module.exports = { channelProof, parseChannelFlags, INITIALIZE_PROOF, INITIALIZE_KEY };

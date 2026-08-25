// Channel activation constants. One home for the env opt-in
// and the launch incantation so the queue-policy hint, install's .mcp.json
// env wiring, install's next-steps checklist, and doctor's env repair all share a
// single source of truth — the launch string is never forked. Zero imports (core
// leaf), so any layer may require it without creating a cycle.
const CHANNEL_ENV = 'WEB_CHAT_CHANNEL';
const CHANNEL_ENV_VALUE = '1';
// NB: the flag takes a VALUE — the channel to load. Without `server:web-chat`
// the flag is inert, so the command install prints, the rail displays, and
// doctor repairs could never actually activate a channel.
const CHANNEL_NAME = 'server:web-chat';
const LAUNCH_COMMAND = `${CHANNEL_ENV}=${CHANNEL_ENV_VALUE} claude --dangerously-load-development-channels ${CHANNEL_NAME}`;

module.exports = { CHANNEL_ENV, CHANNEL_ENV_VALUE, CHANNEL_NAME, LAUNCH_COMMAND };

const client = require('../mcp/client');
const portfiles = require('../core/portfiles');

const NO_SERVER_CONTEXT = '[web-chat] The user does not have a web-chat tab open right now. MCP tools that render to the surface (render, use_component, set_store, clear, etc.) will fail. If your response would benefit from rendering UI, ask the user to run `claude-web-chat open` first; otherwise proceed normally.';

// A Push made while no channel was connected PARKS a wake
// envelope on the daemon. This frame introduces the parked SUMMARY as context on
// the user's next prompt, framed as what it is; bodies stay fetched by tool call
// (get_captures / get_store) per the envelope contract.
const PARKED_PREFIX = '[web-chat] Parked delivery — while the Channels wake path was not connected, the user pushed the following from the web-chat surface. It is delivered now, with this message. Fetch any bodies by tool call (get_captures / get_store) as usual.\n\n';

function emitNoServer() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: NO_SERVER_CONTEXT,
    },
  }));
}

function emitParked(summary) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: PARKED_PREFIX + summary,
    },
  }));
}

module.exports = async function turnBegin(payload, ctx = {}) {
  const root = ctx.root || process.cwd();
  const info = portfiles.readPortfile('server', { root });
  const reachable = info ? await portfiles.probeReachable(info.port, 500) : false;

  if (!reachable) {
    emitNoServer();
    return;
  }

  const message = payload.prompt
    || payload.user_prompt
    || payload.userPrompt
    || payload.message
    || '';
  try {
    await client.post('/api/turn-begin', { message, author: 'user' }, { port: info.port });
  } catch (e) {
    if (e && e.code === 'NO_SERVER') {
      emitNoServer();
      return;
    }
    throw e;
  }

  // Path A — deliver a parked wake (a Push made while no channel was
  // connected) as context on THIS prompt. Read the park, CLAIM it by id, and only
  // surface it if the claim succeeded — so path A and the bridge-connect drain
  // (path B) are mutually exclusive ("first consumer wins"): if the bridge drained
  // it (or a re-push merged into a fresh id) first, our id no longer matches, the
  // consume no-ops, and we print nothing (no double delivery). The daemon is already
  // confirmed reachable above, so noSpawn keeps this silent-fast; any failure here
  // is best-effort and must not disturb the turn.
  try {
    const body = await client.get('/api/queue/pending', { port: info.port, noSpawn: true });
    const pending = body && body.pending;
    if (pending && pending.envelope && pending.envelope.content) {
      const claim = await client.post('/api/queue/pending/consume', { id: pending.id }, { port: info.port, noSpawn: true });
      if (claim && claim.consumed) emitParked(pending.envelope.content);
    }
  } catch {}
};

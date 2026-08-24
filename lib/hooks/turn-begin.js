const client = require('../mcp/client');
const portfiles = require('../core/portfiles');

// Two states that used to be conflated into one wrong sentence.
//
// The old message said the render tools "will fail" whenever the daemon was
// down. They do not: the MCP client auto-spawns the daemon and the call
// succeeds. So the hook was talking Claude out of using the surface on exactly
// the turns that most needed it — and it was doing so on the strength of a claim
// that was false.
//
// What is actually worth saying is the OTHER thing, which the hook never
// checked: whether anyone is watching. A render into a daemon with no browser
// attached succeeds, commits, and is seen by nobody.
const NO_SERVER_CONTEXT = '[web-chat] No web-chat daemon is running for this project, and no browser is open on the surface. The MCP tools still work — they start the daemon on first use — but anything you render will not be SEEN until the user opens the surface. If your answer would be better shown than described, render it and tell the user to run `claude-web-chat open`; otherwise proceed normally.';

const NO_VIEWER_CONTEXT = '[web-chat] The web-chat daemon is running, but no browser is watching the surface. Renders will succeed and will commit to the graph — the user just will not see them until they open it. If you render, say so and point them at `claude-web-chat open`.';

// A Push made while no channel was connected PARKS a wake
// envelope on the daemon. This frame introduces the parked SUMMARY as context on
// the user's next prompt, framed as what it is; bodies stay fetched by tool call
// (get_captures / get_store) per the envelope contract.
const PARKED_PREFIX = '[web-chat] Parked delivery — while the Channels wake path was not connected, the user pushed the following from the web-chat surface. It is delivered now, with this message. Fetch any bodies by tool call (get_captures / get_store) as usual.\n\n';

function emitContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  }));
}

function emitNoServer() { emitContext(NO_SERVER_CONTEXT); }

function emitParked(summary) { emitContext(PARKED_PREFIX + summary); }

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
  let parked = null;
  try {
    const body = await client.get('/api/queue/pending', { port: info.port, noSpawn: true });
    const pending = body && body.pending;
    if (pending && pending.envelope && pending.envelope.content) {
      const claim = await client.post('/api/queue/pending/consume', { id: pending.id }, { port: info.port, noSpawn: true });
      if (claim && claim.consumed) parked = pending.envelope.content;
    }
  } catch {}

  // A parked delivery is the more useful thing to say, and only one
  // additionalContext frame can be emitted per hook — so it wins. Otherwise, tell
  // Claude if nothing is watching, since a render nobody sees is the failure mode
  // this hook exists to prevent.
  if (parked) { emitParked(parked); return; }
  try {
    const health = await client.get('/api/health', { port: info.port, noSpawn: true });
    if (health && health.viewers === 0) emitContext(NO_VIEWER_CONTEXT);
  } catch {}
};

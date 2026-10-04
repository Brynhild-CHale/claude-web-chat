const client = require('../mcp/client');
const portfiles = require('../core/portfiles');
const { replySummary } = require('./reply');
const { hookEnvelope } = require('./envelope');
const { sessionFields, CALL_TIMEOUT_MS } = require('./turn-begin');

// Injectable wall-clock probe budget — see the note on turn-begin's PROBE_MS.
const PROBE_MS = 500;

// Stop or StopFailure (spec §1.1, §3.1). Claude Code fires StopFailure instead
// of Stop when the turn ended on an API error, with that `error`; both run this
// hook. POST /api/turn-end carries which one it was as `ended` — 'failed' for
// StopFailure, else 'stop' — beside:
//   error                   StopFailure's error, at most 500 characters
//   the session fields      turn-begin.js sessionFields: ts, session_id,
//                           transcript_path, cwd, prompt_id, claude_pid,
//                           entrypoint, permission_mode
//   background_tasks        what was still running: at most 50, each
//                           {id, type, status, description ≤ 200, command ≤ 200,
//                           agent_type ≤ 60}
//   last_assistant_message  the final reply, at most 4,000 characters: the chat
//                           mirror shows it as the turn's provisional reply until
//                           the transcript's lands (spec §2.4, C28)
// all bounded in this hook by envelope v1 (lib/hooks/envelope.js), the whole of
// it under 32 KB. The daemon puts the Stop or StopFailure envelope it builds from
// them on the hook tap, for a host request only (lib/server/routes/graph.js).
// The node's own fields (`author`, the `reply` summary) are unchanged.
function stopBody(payload, ctx) {
  const event = payload && payload.hook_event_name === 'StopFailure' ? 'StopFailure' : 'Stop';
  const envelope = hookEnvelope({ ...payload, hook_event_name: event }, ctx.env || process.env, { now: ctx.now });
  const stop = (envelope && envelope.stop) || {};
  return {
    ended: event === 'StopFailure' ? 'failed' : 'stop',
    ...(typeof stop.error === 'string' ? { error: stop.error } : {}),
    ...sessionFields(envelope),
    ...(Array.isArray(stop.background_tasks) ? { background_tasks: stop.background_tasks } : {}),
    ...(typeof stop.last_assistant_message === 'string' ? { last_assistant_message: stop.last_assistant_message } : {}),
  };
}

module.exports = async function turnEnd(payload, ctx = {}) {
  const root = ctx.root || process.cwd();
  const info = portfiles.readPortfile('server', { root });
  if (!info) return;
  // root + noSpawn for the same reason turn-begin passes them: a retry must never
  // resolve to another project's daemon (or spawn one there). See turn-begin.js.
  // The timeout is turn-begin's too: a wedged daemon never holds the turn's end.
  const call = { port: info.port, root, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  const reachable = await portfiles.probeReachable(info.port, Number.isFinite(ctx.probeMs) ? ctx.probeMs : PROBE_MS);
  if (!reachable) {
    // The server didn't answer the probe but the portfile points at a live pid,
    // so it may just be momentarily busy. A turn-begin acquired the lock; if we
    // bail outright the lock orphans for the full TTL and wedges the graph. Make
    // one best-effort unlock attempt instead (the server no-ops if there's no
    // lock). turn-end's commit is forfeit, but the surface stays navigable.
    try {
      await client.post('/api/unlock', {}, call);
    } catch {}
    return;
  }
  // `reply` is a short summary of Claude's final message (hooks/reply.js), so the
  // node — or the folded entry, if the turn changed nothing — records both sides
  // of the turn. Absent when the payload carries no reply; the field is optional.
  const reply = replySummary(payload || {});
  try {
    await client.post('/api/turn-end', { author: 'claude', ...(reply ? { reply } : {}), ...stopBody(payload || {}, ctx) }, call);
  } catch (e) {
    if (e && e.code === 'NO_SERVER') return;
    throw e;
  }
};

module.exports.stopBody = stopBody;

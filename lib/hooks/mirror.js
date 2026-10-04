// lib/hooks/mirror.js — the `mirror` subcommand: one hook fire, one envelope,
// one post (spec §1.1, §1.3).
//
// Registered on the seven events the chat mirror reads live (MIRROR_EVENTS):
// SessionStart, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStop and
// PreCompact asynchronously (`async: true`: neither the tool nor the turn waits
// for it, V24), and SessionEnd synchronously, inside the 1.5 s budget Claude
// Code shares between its SessionEnd hooks.
//
// What it does, in order, and nothing later: build envelope v1
// (lib/hooks/envelope.js, bounded here), find this project's daemon from its
// portfile, and POST the envelope to /api/hooks/event. An async hook still
// running when its session ends is cancelled and whatever it left for later is
// lost (V24), so the post is the first thing it does once stdin has ended.
//
// The rules a hook lives by:
//
//   * It never spawns a daemon. The port comes from the portfile (no portfile,
//     or a dead pid: nothing is posted), and the post goes through lib/client
//     with {port, noSpawn: true, timeout}. A mirror event before the daemon is
//     up is simply lost; the transcript still has the turn.
//   * It ends itself. Claude Code never stops an async hook at its timeout
//     (V24), so the dispatcher's hard exit (2.5 s) is what ends a wedged one, and
//     SessionEnd arms a tighter one here (900 ms) with a 400 ms socket timeout.
//   * It prints nothing.
//
// An event this subcommand is not registered for (a hand-edited settings file
// that puts it on Stop, say) is ignored: the turn hooks report those, through
// the turn routes, and the intake would refuse them.
//
// postEnvelope is the one post of a hook envelope; the `ask` subcommand's report
// mode uses it too.
//
// Dependency direction: lib/hooks → lib/client, lib/core. Never lib/mcp/client,
// whose shim auto-spawns.

const client = require('../client');
const portfiles = require('../core/portfiles');
const { hookEnvelope } = require('./envelope');

const MIRROR_EVENTS = Object.freeze([
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStop', 'PreCompact',
]);

const INTAKE_PATH = '/api/hooks/event';
// The socket timeout of a post, inside the dispatcher's 2.5 s hard exit.
const POST_TIMEOUT_MS = 2000;
// SessionEnd must finish inside Claude Code's shared 1.5 s budget, which cut a
// slow hook 3 times in 4 (V14).
const SESSION_END_DEADLINE_MS = 900;
const SESSION_END_TIMEOUT_MS = 400;

// POST one envelope to this project's daemon. Resolves with what happened:
// 'posted', 'no-server' (no portfile, a dead pid, or a refused connection —
// never a spawn) or 'no-intake' (a 404: a daemon older than the hook intake,
// still running after an update; the turn-begin skew line already asks for its
// restart). Any other failure (a refusal, a timeout) throws, for the dispatcher
// to log by status or code.
async function postEnvelope(envelope, { root, timeout = POST_TIMEOUT_MS } = {}) {
  const info = portfiles.readPortfile('server', { root });
  if (!info) return 'no-server';
  try {
    await client.post(INTAKE_PATH, envelope, { port: info.port, noSpawn: true, timeout });
    return 'posted';
  } catch (e) {
    if (e && e.code === 'NO_SERVER') return 'no-server';
    if (e && e.status === 404) return 'no-intake';
    throw e;
  }
}

async function mirror(payload, ctx = {}) {
  const event = payload && payload.hook_event_name;
  if (!MIRROR_EVENTS.includes(event)) return 'ignored';
  const sessionEnd = event === 'SessionEnd';
  if (sessionEnd && typeof ctx.deadline === 'function') ctx.deadline(SESSION_END_DEADLINE_MS);
  const envelope = hookEnvelope(payload, ctx.env || process.env, { now: ctx.now });
  if (!envelope) return 'dropped';
  return postEnvelope(envelope, {
    root: ctx.root || process.cwd(),
    timeout: sessionEnd ? SESSION_END_TIMEOUT_MS : POST_TIMEOUT_MS,
  });
}

module.exports = mirror;
module.exports.postEnvelope = postEnvelope;
module.exports.MIRROR_EVENTS = MIRROR_EVENTS;
module.exports.INTAKE_PATH = INTAKE_PATH;
module.exports.POST_TIMEOUT_MS = POST_TIMEOUT_MS;
module.exports.SESSION_END_DEADLINE_MS = SESSION_END_DEADLINE_MS;
module.exports.SESSION_END_TIMEOUT_MS = SESSION_END_TIMEOUT_MS;

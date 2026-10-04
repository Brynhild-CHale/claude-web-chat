// lib/hooks/ask.js — the `ask` subcommand on PermissionRequest, in REPORT mode
// (tranches 1–3; spec §1.1, §1.3, C38).
//
// The template registers the final PermissionRequest handler now (sync,
// `timeout: 600`), so an install made in tranche 1 needs no upgrade when
// answering from the browser lands. Until then this handler only REPORTS: it
// posts the request's envelope v1 to the hook intake — the status bar shows the
// waiting tool and question — and exits with no output at all, so Claude Code
// shows its own terminal prompt exactly as it would without the hook (the hook
// and the terminal dialog are live together, V9; a silent hook decides nothing).
//
// It reports nothing under an SDK host (CLAUDE_CODE_ENTRYPOINT `sdk-…`): there
// a PermissionRequest fires in `-p` even for a call that is then auto-denied
// (V3), and a headless session must never show NEEDS YOU.
//
// The dispatcher's hard exit is 2.5 s in this mode; the toggle gate in front of
// it means a disabled project gets the terminal prompt as usual. Tranche 4
// replaces this with the ask bridge (§4.1), which answers; it has a deadline of
// its own.
//
// Dependency direction: lib/hooks → lib/client, lib/core (through mirror.js).

const { hookEnvelope, isSdkEntrypoint } = require('./envelope');
const { postEnvelope, POST_TIMEOUT_MS } = require('./mirror');

async function ask(payload, ctx = {}) {
  const env = ctx.env || process.env;
  if (isSdkEntrypoint(env)) return 'sdk';
  if (!payload || payload.hook_event_name !== 'PermissionRequest') return 'ignored';
  const envelope = hookEnvelope(payload, env, { now: ctx.now });
  if (!envelope) return 'dropped';
  return postEnvelope(envelope, { root: ctx.root || process.cwd(), timeout: POST_TIMEOUT_MS });
}

module.exports = ask;

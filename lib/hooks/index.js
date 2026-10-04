// lib/hooks/index.js — the hook dispatcher: `claude-web-chat-hook <subcommand>`
// (spec §1.3).
//
// One Claude Code hook fire is one short-lived process: read the payload on
// stdin, gate on the toggle, run one subcommand, exit 0. The subcommands are a
// LAZY table, so a fire loads only its own handler: the mirror hook runs on
// every tool call (twice), and must not pay for the turn hooks' requires.
//
//   turn-begin   UserPromptSubmit                         hard exit 20 s
//   turn-end     Stop, StopFailure                        hard exit 20 s
//   mirror       the seven events the chat mirror reads   hard exit 2.5 s
//                (SessionEnd arms 900 ms inside the handler)
//   ask          PermissionRequest, report mode           hard exit 2.5 s
//
// The hard exit is armed once stdin has ended (`setTimeout(exit, ms).unref()`):
// Claude Code never stops an async hook at its timeout (V24), so a hook that
// is wedged on a daemon ends itself. A table entry whose `deadlineMs` is null
// arms none (tranche 4's ask bridge keeps its own deadline). Before stdin ends,
// a STDIN_MAX_MS guard does the same job, so a stdin that never ends cannot keep
// an async hook alive either.
//
// Unchanged from 0.8.0:
//   * an unknown subcommand exits 0 at once, silently. That includes `halt`:
//     the halt handlers are POSIX sh (claude-web-chat-hook-halt.sh), resolved by
//     install to `sh "<root>/lib/hooks/claude-web-chat-hook-halt.sh" <event>`, and
//     never implemented in Node; a bare `claude-web-chat-hook halt …` lands here
//     and does nothing.
//   * the toggle gate exits 0 when web-chat is off for this user, project or
//     session — for `ask`, that means Claude Code's terminal prompt as usual.
//   * a handler's error is caught and the process still exits 0: a hook never
//     fails Claude Code's turn.
//
// Errors go to .web-chat/hook.log (or $WEB_CHAT_HOOK_LOG), one line each, IDS
// AND OUTCOMES ONLY: the subcommand, the event, the session and tool-use ids
// when they are well-formed ids, and the error's status or code. Never an error
// message, a tool input, a prompt or an answer — a message can carry any of
// them (an HttpError's names the response body; a parse error quotes its input).

const fs = require('fs');
const { projectPaths, findProjectRoot, isSafeId } = require('../core/paths');
const { resolve: resolveToggle } = require('../toggle/policy');

const SUBCOMMANDS = new Map([
  ['turn-begin', { load: () => require('./turn-begin'), deadlineMs: 20000 }],
  ['turn-end', { load: () => require('./turn-end'), deadlineMs: 20000 }],
  ['mirror', { load: () => require('./mirror'), deadlineMs: 2500 }],
  ['ask', { load: () => require('./ask'), deadlineMs: 2500 }],
]);

const STDIN_MAX_MS = 10000;

const EVENT_RE = /^[A-Za-z]{1,40}$/;

function arm(ms, exit) {
  const t = setTimeout(() => exit(0), ms);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

// The payload, decoded once as UTF-8 (a character split across two chunks must
// not become two replacement characters).
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    process.stdin.on('data', (c) => { chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c); });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function parsePayload(input) {
  if (!input.trim()) return {};
  try {
    const v = JSON.parse(input);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// What went wrong, without a word of its message.
function outcomeOf(err) {
  if (!err || typeof err !== 'object') return 'error';
  if (Number.isInteger(err.status)) return `error http ${err.status}`;
  if (typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code)) return `error ${err.code}`;
  if (err.message === 'request timeout') return 'error timeout';
  const name = typeof err.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
  return `error ${name}`;
}

function logError(sub, payload, err, root) {
  try {
    const paths = projectPaths(root || process.cwd());
    if (!fs.existsSync(paths.dir)) return;
    const logFile = process.env.WEB_CHAT_HOOK_LOG || paths.hookLog;
    const parts = [`[${new Date().toISOString()}]`, sub];
    if (typeof payload.hook_event_name === 'string' && EVENT_RE.test(payload.hook_event_name)) parts.push(payload.hook_event_name);
    if (isSafeId(payload.session_id)) parts.push(`session=${payload.session_id}`);
    if (isSafeId(payload.tool_use_id)) parts.push(`tool_use=${payload.tool_use_id}`);
    parts.push(outcomeOf(err));
    fs.appendFileSync(logFile, `${parts.join(' ')}\n`);
  } catch {}
}

async function main({ argv = process.argv, exit = (code) => process.exit(code) } = {}) {
  const sub = argv[2];
  const entry = SUBCOMMANDS.get(sub);
  if (!entry) return exit(0);

  const stdinGuard = arm(STDIN_MAX_MS, exit);
  const input = await readStdin();
  const now = Date.now();
  clearTimeout(stdinGuard);
  if (entry.deadlineMs != null) arm(entry.deadlineMs, exit);

  const payload = parsePayload(input);

  // Anchor to the project root (nearest ancestor with .web-chat), not the
  // agent's possibly-cd'd cwd. Claude Code spawns hooks with cwd tracking the
  // agent's `cd`, so process.cwd() can point into a subdirectory.
  const from = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const root = findProjectRoot(from);

  // The session scope's file is named by the session id; an id that could form
  // a path (it came in on stdin) names no file.
  const sessionId = isSafeId(payload.session_id) ? payload.session_id : undefined;
  const decision = resolveToggle({ cwd: root || process.cwd(), sessionId });
  if (!decision.enabled) return exit(0);

  try {
    const handler = entry.load();
    await handler(payload, { root, now, deadline: (ms) => arm(ms, exit) });
  } catch (e) {
    logError(sub, payload, e, root);
  }
  return exit(0);
}

main().catch(() => process.exit(0));

const fs = require('fs');
const path = require('path');
const client = require('../mcp/client');
const portfiles = require('../core/portfiles');
const { projectPaths, claudePaths, isSafeId } = require('../core/paths');
const { packageVersion } = require('../core/versions');
const { readJsonOr, writeJsonAtomic } = require('../core/fsjson');
const { hookEnvelope, promptOf } = require('./envelope');
const { PARKED_PREFIX } = require('../core/prompt-class');

// Every daemon call either turn hook makes has its own socket timeout (spec
// §1.3). There was none: a daemon that answered the liveness probe and then
// wedged held the user's prompt until the dispatcher's hard exit (20 s,
// lib/hooks/index.js) or Claude Code's own timeout. Three seconds a call, so a
// wedged daemon costs a prompt seconds, not half a minute. turn-end uses the
// same budget.
const CALL_TIMEOUT_MS = 3000;

// The one additionalContext string this hook emits (spec §3.1 step 5). Claude
// Code keeps at most CONTEXT_MAX characters of one hook's added context, so the
// parts stay within CONTEXT_MAX − CONTEXT_MARGIN: the parked delivery (never
// cut: ENVELOPE_MAX bounds it) and the control layer's notices first — the
// claim asks only for what fits (max_chars), and the daemon keeps the rest for
// a later turn — then the hook's own no-viewer, skew and drift lines, each only
// when it still fits (the last of them dropped first).
const CONTEXT_MAX = 10000;
const CONTEXT_MARGIN = 500;
const CONTEXT_BUDGET = CONTEXT_MAX - CONTEXT_MARGIN;
const PART_SEP = '\n\n';

// The session a turn hook speaks for (spec §3.1): envelope v1's identity
// fields, built and bounded by lib/hooks/envelope.js — `ts` (when the hook read
// stdin), session_id, transcript_path, cwd, prompt_id, claude_pid, entrypoint
// and permission_mode — with the ones that have no value left out. They ride
// POST /api/turn-begin and /api/turn-end beside the lock's own fields, and the
// daemon builds from them the UserPromptSubmit, Stop or StopFailure envelope it
// puts on the hook tap (lib/server/routes/graph.js) — for a host request only,
// which a hook posting through lib/client is. `cwd` and `transcript_path` are
// what the chat mirror accepts an envelope by (spec §2.2), so a turn post
// carries them as every other hook envelope does.
const SESSION_KEYS = Object.freeze([
  'ts', 'session_id', 'transcript_path', 'cwd', 'prompt_id', 'claude_pid', 'entrypoint', 'permission_mode',
]);

function sessionFields(envelope) {
  const out = {};
  if (!envelope) return out;
  for (const k of SESSION_KEYS) if (envelope[k] !== null && envelope[k] !== undefined) out[k] = envelope[k];
  return out;
}

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
//
// Neither claim holds when web-chat's MCP server is not loaded in the session
// at all (never approved, /mcp-disabled, --strict-mcp-config). The hook cannot
// see Claude's tool list and does not guess (design/mcp-approval-local-scope.md,
// the critic's presence check): it makes the claim conditional on what Claude
// CAN see — its own tool list — and names the command that diagnoses the rest.
// No poll, no wait, no per-session verdict, and never "don't call them".
const NO_SERVER_HEAD = '[web-chat] No web-chat daemon is running for this project, and no browser is open on the surface. The MCP tools still work if they are in your tool list (mcp__web-chat__*) — they start the daemon on first use — but anything you render will not be SEEN until the user opens the surface. If your answer would be better shown than described, render it and tell the user to run `claude-web-chat open`; otherwise proceed normally.';

const NO_VIEWER_HEAD = '[web-chat] The web-chat daemon is running, but no browser is watching the surface. If web-chat\'s tools (mcp__web-chat__*) are in your tool list, renders will succeed and will commit to the graph — the user just will not see them until they open it. If you render, say so and point them at `claude-web-chat open`.';

// A shell word for a directory: as it is when it needs no quoting, else in
// single quotes.
function shellWord(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// The sentence both notices end with. A session run under CLAUDE_CONFIG_DIR
// keeps its MCP approvals there, so `doctor` must be run under it too (ruled
// 2026-10-04, U30@config-dir-prefix).
function mcpAbsentLine(env = process.env) {
  const dir = env && typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : null;
  const cmd = `${dir ? `CLAUDE_CONFIG_DIR=${shellWord(dir)} ` : ''}claude-web-chat doctor`;
  return `If web-chat's tools are not in your tool list, its MCP server is not loaded in this session: tell the user to run \`${cmd}\` in this project, then restart Claude Code.`;
}

const noServerContext = (env) => `${NO_SERVER_HEAD} ${mcpAbsentLine(env)}`;
const noViewerContext = (env) => `${NO_VIEWER_HEAD} ${mcpAbsentLine(env)}`;

// A Push made while no channel was connected PARKS a wake
// envelope on the daemon. PARKED_PREFIX introduces the parked SUMMARY as context
// on the turn that follows, framed as what it is; bodies stay fetched by tool
// call (get_captures / get_store) per the envelope contract. It lives in
// lib/core/prompt-class.js beside the message marker, because the mirror's
// carriers (lib/server, which may not import lib/hooks) recognise a parked
// delivery by its head; it is re-exported here.

function emitContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  }));
}

function emitNoServer(env) { emitContext(noServerContext(env)); }

// A turn-begin the daemon refused (409: another session's turn holds the lock)
// is noted in hook.log — ids and outcomes only, as the dispatcher logs — and
// the hook carries on: the park is still read and claimed and the health still
// read (spec §3.1 step 4). Before 0.8.5 the refusal threw, so a parked delivery
// waited for a prompt that was not refused. Best-effort.
function noteRefused(root, payload, status) {
  try {
    const paths = projectPaths(root);
    if (!fs.existsSync(paths.dir)) return;
    const logFile = process.env.WEB_CHAT_HOOK_LOG || paths.hookLog;
    const parts = [`[${new Date().toISOString()}]`, 'turn-begin', 'UserPromptSubmit'];
    if (payload && isSafeId(payload.session_id)) parts.push(`session=${payload.session_id}`);
    parts.push(`refused http ${status}`);
    fs.appendFileSync(logFile, `${parts.join(' ')}\n`);
  } catch {}
}

// The daemon serving this project runs a different build than this hook.
//
// The hook command resolves through ~/.web-chat/current, so it runs the NEW
// build the moment `update` flips that link — while every other project's
// daemon keeps the build it booted on until something restarts it (a tab
// attached keeps it alive indefinitely). There, a tool the old build lacks
// 404s and newer arguments are silently dropped, and nothing said why. The
// hook already reads /api/health on every prompt, and from 0.8 on that carries
// `package_version`; a web-chat instance answering without one is older than
// 0.8. Message only: this hook has just taken the turn lock, and a restart
// from inside it would pull the daemon out from under the turn.
function skewLine(health, build = packageVersion()) {
  if (!health || health.ok !== true || health.role !== 'instance') return null;
  const pv = typeof health.package_version === 'string' && health.package_version ? health.package_version : null;
  if (pv === build) return null;
  const running = pv ? `v${pv}` : 'a build older than 0.8';
  return `[web-chat] This project's surface is running ${running}, not the installed v${build} — web-chat tools may 404 or ignore arguments until the user runs \`claude-web-chat restart\` in this project. Tell them.`;
}

// Say it once per Claude session per daemon, not on every prompt: the line
// stays in the session's context, and a notice repeated each turn becomes a
// nag. Keyed to the daemon pid and both builds, so a restart onto another
// build, or another update, is news again. Best-effort: a marker that cannot
// be read or written just means the line is said again.
//
// One marker file per notice (`name`): the skew line's, and the hooks-drift
// line's below.
const SKEW_SESSIONS_KEPT = 50;
//
// `peek` answers the same question without recording the answer, for a line
// that may yet be left out for room (the context budget above).
function firstTimeFor(root, key, sessionId, name = 'build-skew-notice.json', { peek = false } = {}) {
  const file = path.join(projectPaths(root).tmp, name);
  const rec = readJsonOr(file, null, {
    validate: (v) => v && typeof v === 'object' && typeof v.key === 'string' && Array.isArray(v.sessions),
  });
  const sessions = rec && rec.key === key ? rec.sessions : [];
  const sid = typeof sessionId === 'string' ? sessionId : '';
  if (sessions.includes(sid)) return false;
  if (peek) return true;
  try { writeJsonAtomic(file, { key, sessions: [...sessions, sid].slice(-SKEW_SESSIONS_KEPT) }); } catch {}
  return true;
}

// The hooks-drift nudge (spec §1.2). Other projects on the machine run a new
// build's hook code the moment `update` flips ~/.web-chat/current, but keep the
// Claude Code hooks registered in their .claude/settings.json until someone
// runs `install` (or `update`, or `doctor`) there — so the new events (the
// mirror's live tool status, answering prompts from the browser) stay off and
// nothing says why. Said once per Claude session per (installed build,
// settings.json mtime): the marker is checked BEFORE anything is read, so a
// session that has been told reads nothing on later prompts. Only when the
// project's own settings.json parses: with none, the hooks running this one
// are registered somewhere else; an unparseable one is doctor's to explain.
// The registration engine is required lazily — the one place this hook
// reaches lib/setup, and only on the first prompt of a session. `fits(line)`
// (optional) says whether the context has room for the line: when it has none
// the line is left out and NOT recorded as said, so a later prompt says it.
const DRIFT_MARKER = 'hooks-drift-notice.json';
function hooksDriftLine(root, sessionId, { inspect, build = packageVersion(), fits } = {}) {
  let mtime = null;
  try { mtime = fs.statSync(claudePaths(root).settings).mtimeMs; } catch { return null; }
  const key = `${build}|${mtime}`;
  if (!firstTimeFor(root, key, sessionId, DRIFT_MARKER, { peek: true })) return null;
  let line = null;
  let roomless = false;
  try {
    line = driftText(root, inspect);
    roomless = Boolean(line) && typeof fits === 'function' && !fits(line);
  } finally {
    // Said, or nothing to say (or a read that failed): either way not again
    // this session. Only a line left out for room waits for a later prompt.
    if (!roomless) firstTimeFor(root, key, sessionId, DRIFT_MARKER);
  }
  return roomless ? null : line;
}

function driftText(root, inspect) {
  const registration = require('../setup/registration');
  const state = (typeof inspect === 'function' ? inspect : registration.inspect)(root);
  if (!state || state.hooksFile !== 'ok') return null;
  const events = [];
  for (const p of registration.hookProblems(state)) for (const e of p.events) if (!events.includes(e)) events.push(e);
  if (!events.length) return null;
  return `[web-chat] This project's Claude Code hooks are older than the installed web-chat (missing: ${events.join(', ')}). Live tool status and answering prompts from the browser stay off until the user runs \`claude-web-chat install\` in this project. Tell them once.`;
}

// How long the liveness probe waits for the daemon's HEAD /api/health. Injectable
// (ctx.probeMs) because it is a wall-clock budget: a loaded machine — or a test
// runner sharing a CPU with a dozen other suites — can miss 500ms on a daemon
// that is perfectly alive, and the hook would then tell Claude nothing is running.
const PROBE_MS = 500;

module.exports = async function turnBegin(payload, ctx = {}) {
  const root = ctx.root || process.cwd();
  const probeMs = Number.isFinite(ctx.probeMs) ? ctx.probeMs : PROBE_MS;
  const info = portfiles.readPortfile('server', { root });
  const reachable = info ? await portfiles.probeReachable(info.port, probeMs) : false;

  const env = ctx.env || process.env;
  if (!reachable) {
    emitNoServer(env);
    return;
  }

  // The prompt, through the one chain envelope.js reads it by (`prompt`, then
  // the names older payloads used).
  const message = promptOf(payload);
  // Envelope v1 for this prompt: its session fields, and its `prompt` section
  // ({author, text, task_summary}: a task notification is authored 'task'; the
  // text is cut to 16 KiB). The event is named here, so a payload without
  // hook_event_name still describes the prompt it carries. The lock's own
  // `message` and `author` are 0.8.0's.
  const envelope = hookEnvelope({ ...payload, hook_event_name: 'UserPromptSubmit' }, env, { now: ctx.now });
  // Who the turn is for (spec §3.1 step 2): a background task's completion
  // (a leading <task-notification>, classifyPrompt via the envelope's prompt
  // section) is authored 'task' — no human typed it — and its lock message is
  // the task's one-line summary, not the notification's XML.
  const prompt = envelope ? envelope.prompt : null;
  const task = Boolean(prompt && prompt.author === 'task');
  const lockMessage = !task ? message
    : (prompt.task_summary ? `background task: ${prompt.task_summary}` : 'background task');
  const body = { message: lockMessage, author: task ? 'task' : 'user', ...sessionFields(envelope), ...(prompt ? { prompt } : {}) };
  // `root` + noSpawn are load-bearing, not decoration. lib/mcp/client defaults
  // spawn:true, and lib/client's retry-on-ECONNREFUSED calls ensureDaemon(root)
  // — with no root that resolves findProjectRoot(process.cwd()), i.e. WHATEVER
  // project the process happens to sit in. A daemon that answered the probe and
  // then died mid-call would therefore lock (or spawn a daemon into) a different
  // project's graph than the one this hook fired for. noSpawn turns that retry
  // into a NO_SERVER we report honestly below; root pins it either way. Every
  // call below carries the same options, the timeout included.
  const call = { port: info.port, root, noSpawn: true, timeout: CALL_TIMEOUT_MS };
  try {
    await client.post('/api/turn-begin', body, call);
  } catch (e) {
    if (e && e.code === 'NO_SERVER') {
      emitNoServer(env);
      return;
    }
    // Refused: another session's turn holds the lock. Noted, and the rest
    // still runs (step 4) — only an unreachable daemon ends the hook here.
    if (e && e.status === 409) noteRefused(root, payload, 409);
    else throw e;
  }

  // Path A — deliver a parked wake (a Push made while no channel was
  // connected) as context on THIS prompt. Read the park, CLAIM it by id, and only
  // surface it if the claim succeeded — so path A and the bridge-connect drain
  // (path B) are mutually exclusive ("first consumer wins"): if the bridge drained
  // it (or a re-push merged into a fresh id) first, our id no longer matches, the
  // consume no-ops, and we print nothing (no double delivery). The daemon is already
  // confirmed reachable above, so noSpawn keeps this silent-fast; any failure here
  // is best-effort and must not disturb the turn.
  //
  // Targeted (§6.4): with the session's Claude Code pid the hook asks only for
  // a park that is untargeted or aimed at this process — a release aimed at
  // another session's process waits for that session's prompt. A hook without
  // CLAUDE_PID claims as before. On a task turn too.
  let parked = null;
  const claudePid = envelope && Number.isSafeInteger(envelope.claude_pid) ? envelope.claude_pid : null;
  const pendingPath = claudePid != null ? `/api/queue/pending?pid=${claudePid}` : '/api/queue/pending';
  try {
    const queued = await client.get(pendingPath, call);
    const pending = queued && queued.pending;
    if (pending && pending.envelope && pending.envelope.content) {
      const claim = await client.post('/api/queue/pending/consume', { id: pending.id }, call);
      if (claim && claim.consumed) parked = pending.envelope.content;
    }
  } catch {}

  const parkedPart = parked ? PARKED_PREFIX + parked : null;

  // The control layer's one-shot notices for Claude (§3.1 step 5, §15.3: e.g.
  // "Files restored from the web-chat page"), claimed once, within the room
  // the parked part leaves. Best-effort: nothing here disturbs the turn.
  const notices = await claimNotices(envelope, parkedPart, call);

  let health = null;
  try {
    health = await client.get('/api/health', call);
  } catch {}

  // Only one additionalContext frame can be emitted per hook, so everything
  // worth saying goes into it, in this order: the parked delivery, the
  // notices, then the hook's own lines. A parked delivery is more useful to
  // say than "nobody is watching", so it wins over that; otherwise tell Claude
  // if nothing is watching, since a render nobody sees is the failure mode
  // this hook exists to prevent. A build skew and the hooks drift ride along.
  // The hook's own lines go in only while the whole stays within the budget.
  const parts = [];
  if (parkedPart) parts.push(parkedPart);
  for (const text of notices) parts.push(text);
  const fits = (line) => {
    const used = parts.reduce((n, p) => n + p.length, 0) + parts.length * PART_SEP.length;
    return used + line.length <= CONTEXT_BUDGET;
  };
  if (!parkedPart && health && health.viewers === 0) {
    const line = noViewerContext(env);
    if (fits(line)) parts.push(line);
  }
  const skew = skewLine(health);
  if (skew && fits(skew)) {
    let first = true;
    try { first = firstTimeFor(root, `${health.pid}|${health.package_version || ''}|${packageVersion()}`, payload.session_id); } catch {}
    if (first) parts.push(skew);
  }
  // The hooks-drift line rides after the skew line (spec §3.1 step 6).
  let drift = null;
  try { drift = hooksDriftLine(root, payload.session_id, { inspect: ctx.inspectRegistration, fits }); } catch {}
  if (drift) parts.push(drift);
  if (parts.length) emitContext(parts.join(PART_SEP));
};

// POST /api/control/notices/claim {session_id, claude_pid, max_chars} (U81's
// route, host only): the notices the control layer keeps for this session,
// whole, oldest first, together within max_chars — the budget less the parked
// part. Answers their texts in order. Under one character of room there is no
// claim (the notices wait for a later turn). A refusal, an error, a timeout,
// a 404 from an older daemon or a malformed answer is no notice; a malformed
// entry is skipped.
async function claimNotices(envelope, parkedPart, call) {
  const max_chars = CONTEXT_BUDGET - (parkedPart ? parkedPart.length : 0);
  if (max_chars < 1) return [];
  const body = {};
  if (envelope && isSafeId(envelope.session_id)) body.session_id = envelope.session_id;
  if (envelope && Number.isSafeInteger(envelope.claude_pid) && envelope.claude_pid > 0) body.claude_pid = envelope.claude_pid;
  body.max_chars = max_chars;
  let answer = null;
  try {
    answer = await client.post('/api/control/notices/claim', body, call);
  } catch {
    return [];
  }
  if (!answer || answer.ok !== true || !Array.isArray(answer.notices)) return [];
  const texts = [];
  for (const n of answer.notices) {
    if (n && typeof n === 'object' && typeof n.text === 'string' && n.text) texts.push(n.text);
  }
  return texts;
}

module.exports.skewLine = skewLine;
module.exports.hooksDriftLine = hooksDriftLine;
module.exports.noServerContext = noServerContext;
module.exports.noViewerContext = noViewerContext;
module.exports.PARKED_PREFIX = PARKED_PREFIX;
module.exports.sessionFields = sessionFields;
module.exports.SESSION_KEYS = SESSION_KEYS;
module.exports.CALL_TIMEOUT_MS = CALL_TIMEOUT_MS;
module.exports.CONTEXT_MAX = CONTEXT_MAX;
module.exports.CONTEXT_MARGIN = CONTEXT_MARGIN;

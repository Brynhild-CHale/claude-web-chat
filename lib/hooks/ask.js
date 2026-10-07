// lib/hooks/ask.js — the `ask` subcommand on PermissionRequest: the ASK BRIDGE
// (spec §4.1, §4.2, §4.5; tranche 4 replaces tranche 1's report mode, C38).
//
// Claude Code shows its own terminal prompt and runs this hook at the same
// time (V9). The bridge holds the PermissionRequest open while the web-chat
// page can answer it, prints Claude Code's decision when the page does, and
// gets out of the way the moment the terminal answers instead:
//
//   1. An SDK host (CLAUDE_CODE_ENTRYPOINT sdk-…: `-p`, the Agent SDK) returns
//      at once, posting nothing: there the hook races the host's own
//      can_use_tool, and a blocking hook would stall `-p` (V9, ruling C38).
//   2. No daemon (no portfile): return. The terminal as usual; a hook never
//      spawns a daemon.
//   3. The LOCAL COPY, kept in memory only, for the echo: the questions as
//      Claude Code handed them, and a plan's text, read from its plan file
//      ONLY through lib/core/claude-files planFile (the plan in the tool input
//      was the previous plan 4 times in 5, V9; the path is untrusted, so a path
//      outside the plans directory is never opened, and the tool input's plan
//      stands in). The plans directory follows Claude Code's `plansDirectory`
//      setting as Claude Code 2.1.292 does (ruling A5 (b), §4.1 as amended):
//      the one merged value of the local, project and user settings (local
//      over project over user), resolved against the project root and taken
//      only while it stays inside the project root, lexically and by realpath
//      (planFile's settingPlansDir does the fencing); the default plans/
//      always counts. Nothing but `plansDirectory` is read from the settings.
//   4. POST /api/asks the create body (notes-A D2: the report-mode envelope,
//      nested, plus the display projection, the questions at the display caps
//      with multiSelect, the plan, the permission suggestions). Any failure,
//      or `wait: false` (nobody can answer, a duplicate handler): return with
//      no output.
//   5. SIGTERM (a terminal No or Esc, or Claude Code's hook timeout, V9):
//      arm a 400 ms hard exit, withdraw {reason: 'sigterm'}, return; the
//      dispatcher exits 0.
//   6. Long-poll the decision until the daemon's deadline (at most 590 s,
//      inside Claude Code's 600 s hook timeout):
//        decided   print buildAskOutput's line (lib/hooks/ask-output.js) and
//                  AWAIT the write (a pipe write is asynchronous on macOS, and
//                  the dispatcher's process.exit would drop it), then POST
//                  handed; a decision the hook cannot map onto its own copy
//                  prints nothing and is thrown as ASK_UNMAPPED, for hook.log
//        resolved  return (the terminal answered, or a newer ask superseded it)
//        a failed poll (a daemon restart answers 404): return, no output
//      and between polls the backstop: a terminal Yes never SIGTERMs the hook
//      (V9), so it reads the session's state file (lib/core/claude-sessions);
//      once the session has been seen `waiting` and leaves it, or it is not
//      `waiting` 2 s after the start, the terminal answered: withdraw
//      ('resolved-elsewhere') and return. At the deadline: withdraw
//      ('deadline') and return; the terminal prompt stays.
//
// The exit code is always 0 (exit 2 is not honoured for this event). Nothing
// goes to stdout but a decision's one line. Errors reach the dispatcher's
// hook.log, ids and outcomes only — never a tool input, a question, a plan or
// an answer. The dispatcher arms no hard exit for this handler
// (`deadlineMs = null`): the bridge keeps its own deadline and SIGTERM handler.
//
// Dependency direction: lib/hooks → lib/client, lib/core. Never lib/mcp/client,
// whose shim auto-spawns; never lib/server.

const client = require('../client');
const portfiles = require('../core/portfiles');
const { claudePaths, userClaudePaths } = require('../core/paths');
const { readJson } = require('../core/fsjson');
const { planFile, readWindow } = require('../core/claude-files');
const { readSessionState } = require('../core/claude-sessions');
const { projectToolInput } = require('../core/tool-input');
const { hookEnvelope, isSdkEntrypoint } = require('./envelope');
const { buildAskOutput } = require('./ask-output');

const ASKS_PATH = '/api/asks';
const SECRET_HEADER = 'X-WC-Ask-Secret';

const CREATE_TIMEOUT_MS = 800;
const POLL_WAIT_MS = 2000;
const POLL_TIMEOUT_MS = 5000;
// A poll that answers `pending` sooner than this (a daemon that cannot hold
// the long-poll) is followed by a pause, so the loop never spins.
const POLL_FLOOR_MS = 250;
const HANDED_TIMEOUT_MS = 500;
const WITHDRAW_TIMEOUT_MS = 1000;
const SIGTERM_WITHDRAW_TIMEOUT_MS = 300;
const SIGTERM_EXIT_MS = 400;
const DEADLINE_MAX_MS = 590_000;
// How long a session that never reads `waiting` gets before the hook takes
// it that the terminal answered.
const SETTLE_MS = 2000;

// The create body's bounds, the asks domain's (U07a's display caps).
const PLAN_MAX_BYTES = 256 * 1024;
const QUESTIONS_MAX = 8;
const OPTIONS_MAX = 12;
const QUESTIONS_MAX_BYTES = 16 * 1024;
const QUESTION_MAX = 4000;
const LABEL_MAX = 500;
const DESCRIPTION_MAX = 2000;
const HEADER_MAX = 200;
const SUGGESTIONS_MAX_BYTES = 4 * 1024;

const ID_RE = /^ask_[0-9a-f]{12}$/;
const KIND_OF_TOOL = Object.freeze({ AskUserQuestion: 'question', ExitPlanMode: 'plan' });

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bytesOf(v) {
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { return Infinity; }
}

// `s` cut to at most `max` UTF-8 bytes, never inside a character.
function cutBytes(s, max) {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let n = 0;
  let out = '';
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > max) break;
    n += b;
    out += ch;
  }
  return out;
}

// ── the plans directory (ruling A5 (b)) ─────────────────────────────────────

// The `plansDirectory` Claude Code applies: local settings over the project's
// over the user's (CLAUDE_CONFIG_DIR honoured). A missing or unreadable file
// names none; nothing else in any of them is read.
function plansDirectoryOf(root) {
  let files;
  try {
    const project = claudePaths(root);
    files = [project.settingsLocal, project.settings, userClaudePaths().claudeSettings];
  } catch {
    return null;
  }
  for (const file of files) {
    const r = readJson(file);
    if (!r.ok || !isPlain(r.value)) continue;
    const v = r.value.plansDirectory;
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// The plan the hook echoes and posts: the plan file through the fence, else
// the tool input's plan. A refused path is never opened.
function readPlan(input, root) {
  const plansDirectory = plansDirectoryOf(root);
  const fenced = planFile(input.planFilePath, plansDirectory ? { projectRoot: root, plansDirectory } : undefined);
  let win = null;
  if (fenced) {
    try { win = readWindow(fenced, { maxBytes: PLAN_MAX_BYTES }); } catch { win = null; }
  }
  if (win && typeof win.text === 'string') {
    const text = cutBytes(win.text, PLAN_MAX_BYTES);
    return { text, file: fenced, from_file: true, truncated: !win.complete || text !== win.text };
  }
  const raw = String(input.plan || '');
  const text = cutBytes(raw, PLAN_MAX_BYTES);
  return { text, file: null, from_file: false, truncated: text !== raw };
}

// ── the questions as posted (notes-A D3) ─────────────────────────────────────

// The questions at the display caps, with multiSelect, in the tool input's
// order (the page's picks index THIS array, and the hook maps them onto its
// own copy, so only the tail is ever dropped). `truncated` when anything was
// cut or did not have the shape Claude Code gives: such an ask is answered
// in the terminal only.
function postedQuestions(qs) {
  let truncated = false;
  const str = (v, max) => {
    if (typeof v !== 'string') { truncated = true; return ''; }
    const chars = Array.from(v);
    if (chars.length <= max) return v;
    truncated = true;
    return chars.slice(0, max).join('');
  };
  if (!Array.isArray(qs)) return { questions: [], truncated: true };
  if (qs.length > QUESTIONS_MAX) truncated = true;
  const questions = qs.slice(0, QUESTIONS_MAX).map((q) => {
    if (!isPlain(q)) truncated = true;
    const o = isPlain(q) ? q : {};
    const out = { question: str(o.question, QUESTION_MAX) };
    if (o.header != null) out.header = str(o.header, HEADER_MAX);
    out.multiSelect = o.multiSelect === true;
    if (!Array.isArray(o.options)) truncated = true;
    const options = Array.isArray(o.options) ? o.options : [];
    if (options.length > OPTIONS_MAX) truncated = true;
    out.options = options.slice(0, OPTIONS_MAX).map((opt) => {
      if (!isPlain(opt)) truncated = true;
      const p = isPlain(opt) ? opt : {};
      const option = { label: str(p.label, LABEL_MAX) };
      if (p.description != null) option.description = str(p.description, DESCRIPTION_MAX);
      return option;
    });
    return out;
  });
  // At most 16 KB of JSON: questions drop from the end, then the longest text
  // halves, until it fits.
  while (bytesOf(questions) > QUESTIONS_MAX_BYTES) {
    truncated = true;
    if (questions.length > 1) { questions.pop(); continue; }
    let longest = null;
    const consider = (obj, key) => {
      if (typeof obj[key] === 'string' && (!longest || obj[key].length > longest.obj[longest.key].length)) longest = { obj, key };
    };
    for (const q of questions) {
      consider(q, 'question');
      consider(q, 'header');
      for (const opt of q.options) { consider(opt, 'label'); consider(opt, 'description'); }
    }
    if (!longest) break;
    const chars = Array.from(longest.obj[longest.key]);
    longest.obj[longest.key] = chars.slice(0, Math.floor(chars.length / 2)).join('');
  }
  return { questions, truncated };
}

// ── the create body ─────────────────────────────────────────────────────────

function createBody(envelope, kind, payload, plan) {
  const input = payload.tool_input;
  const body = {
    v: 1,
    envelope,
    kind,
    display: projectToolInput(payload.tool_name, input, { profile: 'display' }),
  };
  if (kind === 'question') {
    const { questions, truncated } = postedQuestions(isPlain(input) ? input.questions : null);
    body.questions = questions;
    body.questions_truncated = truncated;
  }
  if (kind === 'plan') body.plan = plan;
  const suggestions = payload.permission_suggestions;
  if (suggestions != null && bytesOf(suggestions) <= SUGGESTIONS_MAX_BYTES) body.suggestions = suggestions;
  return body;
}

// Write `text` and resolve once the stream has taken it (or failed to): the
// dispatcher's process.exit would otherwise drop a pipe write still queued.
function writeOut(stream, text) {
  return new Promise((resolve) => {
    const onError = () => resolve();
    try {
      stream.once('error', onError);
      stream.write(text, () => { stream.removeListener('error', onError); resolve(); });
    } catch {
      resolve();
    }
  });
}

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (typeof t.unref === 'function') t.unref();
});

async function ask(payload, ctx = {}) {
  const env = ctx.env || process.env;
  if (isSdkEntrypoint(env)) return 'sdk';
  if (!payload || payload.hook_event_name !== 'PermissionRequest') return 'ignored';
  const envelope = hookEnvelope(payload, env, { now: ctx.now });
  if (!envelope) return 'dropped';
  const root = ctx.root || process.cwd();
  const info = portfiles.readPortfile('server', { root });
  if (!info) return 'no-daemon';
  const port = info.port;
  const start = Date.now();

  // The local copy (never posted as such, never logged).
  const kind = KIND_OF_TOOL[payload.tool_name] || 'permission';
  const input = isPlain(payload.tool_input) ? payload.tool_input : {};
  const plan = kind === 'plan' ? readPlan(input, root) : null;
  const local = { questions: input.questions, plan: plan ? plan.text : null, planFilePath: input.planFilePath };

  let created;
  try {
    created = await client.post(ASKS_PATH, createBody(envelope, kind, payload, plan), {
      port, noSpawn: true, timeout: CREATE_TIMEOUT_MS,
    });
  } catch {
    return 'create-failed';
  }
  if (!isPlain(created) || created.wait !== true) return 'no-wait';
  const id = created.id;
  const secret = created.secret;
  if (typeof id !== 'string' || !ID_RE.test(id) || typeof secret !== 'string' || !secret) return 'create-failed';
  const headers = { [SECRET_HEADER]: secret };
  const opts = (timeout) => ({ port, noSpawn: true, timeout, headers });
  const askPath = `${ASKS_PATH}/${id}`;

  const withdraw = async (reason, timeout = WITHDRAW_TIMEOUT_MS) => {
    try { await client.post(`${askPath}/withdraw`, { reason }, opts(timeout)); } catch {}
  };

  // SIGTERM: Claude Code's terminal No or Esc, or its hook timeout. Withdraw,
  // then let the handler return; a 400 ms hard exit bounds the withdraw.
  const STOPPED = Symbol('stopped');
  let signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  let terminated = false;
  const signals = ctx.signals || process;
  const onTerm = () => {
    if (terminated) return;
    terminated = true;
    if (typeof ctx.deadline === 'function') ctx.deadline(SIGTERM_EXIT_MS);
    withdraw('sigterm', SIGTERM_WITHDRAW_TIMEOUT_MS).then(() => signalStop(STOPPED));
  };
  signals.on('SIGTERM', onTerm);

  try {
    const ms = Number(created.deadline_ms);
    const deadline = start + Math.min(Number.isFinite(ms) && ms > 0 ? ms : DEADLINE_MAX_MS, DEADLINE_MAX_MS);
    const pid = envelope.claude_pid;
    let seenWaiting = false;

    while (Date.now() < deadline) {
      const asked = Date.now();
      const wait = Math.max(0, Math.min(POLL_WAIT_MS, deadline - asked));
      let res;
      try {
        res = await Promise.race([
          client.get(`${askPath}/decision?wait=${wait}`, opts(POLL_TIMEOUT_MS)),
          stopped,
        ]);
      } catch {
        return terminated ? 'withdrawn' : 'poll-failed';
      }
      if (res === STOPPED) return 'withdrawn';
      if (!isPlain(res)) return 'poll-failed';

      if (res.state === 'decided') {
        const out = buildAskOutput(kind, local, res.decision);
        const behavior = isPlain(res.decision) ? res.decision.behavior : null;
        if (out === null && behavior !== 'terminal') {
          // The page answered something the local copy cannot map: print
          // nothing (the terminal prompt stands), and say so in hook.log.
          const e = new Error('unmapped decision');
          e.code = 'ASK_UNMAPPED';
          throw e;
        }
        if (typeof out === 'string') await writeOut(ctx.stdout || process.stdout, out);
        try { await client.post(`${askPath}/handed`, null, opts(HANDED_TIMEOUT_MS)); } catch {}
        return 'decided';
      }
      if (res.state === 'resolved') return 'resolved';

      // The backstop: the terminal answered if the session is not waiting.
      const st = pid ? readSessionState({ pid, sessionId: envelope.session_id }) : null;
      if (st && st.status === 'waiting') {
        seenWaiting = true;
      } else if (st && (seenWaiting || Date.now() - start > SETTLE_MS)) {
        await withdraw('resolved-elsewhere');
        return 'terminal';
      }

      const spent = Date.now() - asked;
      if (spent < POLL_FLOOR_MS) {
        if ((await Promise.race([sleep(POLL_FLOOR_MS - spent), stopped])) === STOPPED) return 'withdrawn';
      }
    }
    await withdraw('deadline');
    return 'deadline';
  } finally {
    signals.removeListener('SIGTERM', onTerm);
  }
}

module.exports = ask;
// No hard exit from the dispatcher's table: the bridge keeps its own deadline
// (at most 590 s) and SIGTERM handler (lib/hooks/index.js reads this).
module.exports.deadlineMs = null;
module.exports.plansDirectoryOf = plansDirectoryOf;
module.exports.postedQuestions = postedQuestions;
module.exports.ASKS_PATH = ASKS_PATH;
module.exports.SECRET_HEADER = SECRET_HEADER;
module.exports.CREATE_TIMEOUT_MS = CREATE_TIMEOUT_MS;
module.exports.POLL_WAIT_MS = POLL_WAIT_MS;
module.exports.POLL_TIMEOUT_MS = POLL_TIMEOUT_MS;
module.exports.HANDED_TIMEOUT_MS = HANDED_TIMEOUT_MS;
module.exports.SIGTERM_WITHDRAW_TIMEOUT_MS = SIGTERM_WITHDRAW_TIMEOUT_MS;
module.exports.SIGTERM_EXIT_MS = SIGTERM_EXIT_MS;
module.exports.DEADLINE_MAX_MS = DEADLINE_MAX_MS;
module.exports.SETTLE_MS = SETTLE_MS;
module.exports.PLAN_MAX_BYTES = PLAN_MAX_BYTES;

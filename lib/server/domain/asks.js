// lib/server/domain/asks.js — the asks domain (spec §4.3), `ctx.asks`: how a
// PermissionRequest the ask hook posts becomes a record the chrome shows, the
// answer surface decides and the hook collects.
//
//   createAsks({ bus, hooks, mirror, getViewers, audience, answerSurface,
//                redactor, root, audit, send, now = Date.now, timers })
//     → { create, createFromMod, withdrawFromMod, poll, withdraw, handed,
//         decide, get, publicView, displayView, waitView, list, pending,
//         noteRefusal, stop, stopped }
//
// THREE WAYS IN (tranche 6, §15.7):
//   the ask hook       POST /api/asks, a PermissionRequest (transport 'hook')
//   the elicit hook    POST /api/asks, an MCP Elicitation (kind 'elicitation',
//                      transport 'hook'; lib/hooks/elicitation.js)
//   the mod            a synthetic ModEvent 'permission.request' on the tap
//                      (transport 'mod', createFromMod); its decision goes back
//                      through `send` (below), never through a poll
//
// bus            the MIRROR bus (ruling A4 (a)): the `mirror:ask` frames and the
//                `{kind:'ask'}` ring entries go there, beside the other mirror:*
//                frames, so Claude's get_events and the SSE drivers (the main
//                bus) never see an ask's outcome.
// hooks          the hook tap (ctx.hooks): the domain publishes each ask's
//                PermissionRequest (with `ask: {id, kind}`) and each
//                resolution's synthetic PermissionResolved on it, and reads the
//                hook envelopes that correlate or resolve an ask.
// mirror         the facade: subscribe(fn) for its transitions (waiting-cleared,
//                state, permission-decision), conversationOf(session id) when it
//                exposes one, else conversationOfPid(pid).
// getViewers     lib/server/ws.js getViewerSummary.
// answerSurface  an object, or a function returning one: ensure() → Promise,
//                remoteAnswering() → boolean, port.
// redactor       ctx.redactor (lib/core/redact createRedactor).
// audit          optional: replaces the JSONL line writer (tests).
// send           optional: ({session_id, request_id, decision}) → a promise of
//                {ok, …} — the mod's permissionDecision op (U94a wires it to
//                bridge.enqueue). `decision` is the classic PermissionRequest
//                result itself, {behavior: 'allow'} or {behavior: 'deny',
//                message} (the message ask-output.js builds for a web deny),
//                or exactly PASS, {pass: true}, which makes the mod hand the
//                prompt on at once (ruled D5 (a)). Never updatedInput, never
//                updatedPermissions, never bypassPermissions. Without it the
//                domain takes no mod ask.
//
// THE MOD'S PERMISSIONS (ruled D2 (a)): kind 'permission' only — a question or
// a plan passes through, so the settings ask hook, which holds the unredacted
// copy the picks and the plan file need (A3, A5), keeps them. A request the
// page cannot answer (no viewer, no answer surface, an input the transport may
// have cut, a duplicate, out of scope) gets PASS at once and leaves no record,
// so the settings hook makes its own. Built and tested switched off:
// MOD_PERMISSION_WAIT_MS is 0 (bridge.setPermissionWait), so a mod forwards
// nothing until gate V41 shows Claude Code keeps its dialog up while the mod
// waits; a one-line follow-up then sets it to DEADLINE_MS.
//
// AN ELICITATION (§15.7, the elicitation-hook row of the control record): the
// hook runs BEFORE the terminal's dialog, so the terminal shows nothing while
// it waits. Answerable only while a LOCAL viewer is connected now, for
// ELICIT_WAIT_MS; never remotely, at any level (ruled D3 (a)). Its display is
// the server, the message and the fields; the page never fills a field. The
// content the user typed is validated against the displayed schema, held in
// the decision only until the hook has printed it (handed) or the ask
// resolves, and never written to the audit, a frame, a ring entry or the tap.
// It is resolved by the hook's withdraw, the turn events, a newer elicitation
// of its session and its TTL — never by a tool event or the sessions file,
// which say nothing about a dialog the terminal is not showing.
//
// STATE IS IN MEMORY ONLY. A daemon restart drops every ask; the hook's next
// poll fails and the hook exits with no decision, so the terminal prompt stands.
//
// THE RECORD (§4.3): { id: 'ask_' + 12 hex, secretHash, conversation_id,
// session_id, claude_pid, agent, kind, tool_name, tool_kind, tool_use_id,
// input_hash, display (redacted), subject (redacted), truncated, questions,
// plan, state: 'pending'|'decided'|'resolved', answerable, hook_attached,
// decision, outcome, via, version, created_at, expires_at, applied, masked }.
// `display`, `subject`, `questions` and `plan` are drawn only by the answer
// frame (displayView, the answer origin): a pane-readable answer (publicView,
// list, the frames) never carries them (ruling Q8).
//
// A DECISION is stored in the HOOK FORM (ruling A3 (a)): a question's answer as
// the picks by index the frame posted, validated against what was displayed,
// so the hook maps them onto its own unredacted copy and a masked question or
// label is never echoed to Claude Code masked. A pick this ask did not display
// is refused and nothing is stored: the terminal prompt stands, and Claude
// never gets a silent wrong answer.
//
// RESOLUTION. Each piece of evidence below resolves every pending or decided
// ask of its session and agent created before it, and each resolution
// publishes ONE synthetic PermissionResolved on the tap, `ask.by` drawn from
// live.js's CLEARED_BY (anything else would read as 'web' there):
//   a decision through the web, handed by the hook   → web
//   the hook's withdraw (sigterm, resolved-elsewhere) → terminal
//   superseded, expired (deadline, TTL, a silent hook) → terminal
//   the mirror's waiting-cleared / a state left waiting → its `by`, else terminal
//     (waiting ⇄ question is not leaving waiting: another agent's ask moved)
//   a tool event (the call ran, or a later one began)  → tool-ran
//   Stop, StopFailure, UserPromptSubmit, SessionEnd    → turn-closed
// A decided ask the hook has collected keeps its outcome and resolves `web` by
// any evidence but the hook's own withdraw; one not yet collected resolves
// like a pending one (the evidence's `by`, outcome terminal).

const crypto = require('crypto');
const fs = require('fs');
const { projectPaths, redactHostPaths } = require('../../core/paths');
const { renameAside } = require('../../core/fsjson');
const {
  toolKind, toolSubject, fileOf, projectToolInput, stepLabel, callLabel, inputHash,
} = require('../../core/tool-input');
const { sensitivePath, WITHHOLD_CATEGORIES, WITHHELD } = require('../../core/redact');
const { stripControls } = require('../../core/text');
const { renderMarkdown } = require('../../core/markdown');
const { projectValue, ASK_SCHEMA, atLeast } = require('../../core/remote-policy');
const { MOD_EVENT, INPUT_MAX } = require('../../core/mod-protocol');
// The one builder of a web deny's words (ruled F8, notes-C Q-C14b (a)): pure,
// and the one edge from lib/server into lib/hooks (a named baseline entry in
// test/dependency-direction.test.js).
const { buildAskOutput } = require('../../hooks/ask-output');

// ── constants ───────────────────────────────────────────────────────────────

const DUPLICATE_MS = 2000;          // ruling A1 (a): a second registered handler's create
const LOCAL_RECENT_MS = 60_000;     // a local viewer connected now or this recently
const REMOTE_RECENT_MS = 600_000;   // a full remote viewer, once remote answering exists (§4.6)
const POLL_MS = 2000;
const DEADLINE_MS = 590_000;        // the hook withdraws before Claude Code's 600 s hook timeout
const CORRELATE_MS = 3000;
const TTL_MS = 620_000;
const HOOK_SILENT_MS = 15_000;      // ruling A2 (a): a hook that stopped polling
const RESOLVED_KEEP_MS = 600_000;   // resolved records answer late decides 409
const RECORDS_MAX = 200;
const POLL_WAIT_MAX = 25_000;
const VIEW_WAIT_MAX = 20_000;
const ENSURE_MS = 600;              // the hook's create call times out at 800 ms
const AUDIT_MAX_BYTES = 1024 * 1024;
// An elicitation waits for the page this long, while the terminal shows no
// dialog (ruled D-defaults (a), U92@elicit-wait); lib/hooks/elicitation.js
// holds the same figure.
const ELICIT_WAIT_MS = 45_000;
// The mod's permission wait, handed to bridge.setPermissionWait (U94a). 0: the
// mod passes every prompt straight through (ruled D2 (a)) until gate V41.
const MOD_PERMISSION_WAIT_MS = 0;
// Gate V41's knob, and nothing else's: the daemon's environment may raise the
// wait for one measured run (read once at boot, an integer 0-590000 ms; any
// other value is the shipped one). A recorded V41 changes the constant above.
const MOD_WAIT_FLAG = 'WEB_CHAT_MOD_PERMISSION_WAIT_MS';
function modPermissionWait(env) {
  const raw = env && typeof env === 'object' ? env[MOD_WAIT_FLAG] : undefined;
  if (typeof raw !== 'string' || !/^[0-9]{1,6}$/.test(raw)) return MOD_PERMISSION_WAIT_MS;
  const ms = Number(raw);
  return ms <= DEADLINE_MS ? ms : MOD_PERMISSION_WAIT_MS;
}
// The decision that makes the mod hand a prompt on at once (ruled D5 (a)).
const PASS = Object.freeze({ pass: true });

// The create body's bounds (§4.1 as nested by notes-A D2; U07a's display caps).
const CREATE_KEYS = new Set(['v', 'envelope', 'kind', 'display', 'questions', 'questions_truncated', 'plan', 'suggestions', 'elicitation']);
const QUESTIONS_MAX = 8;
const QUESTIONS_MAX_BYTES = 16 * 1024;
const OPTIONS_MAX = 12;
const HEADER_MAX = 200;
const QUESTION_MAX = 4000;
const LABEL_MAX = 500;
const DESCRIPTION_MAX = 2000;
const PLAN_MAX_BYTES = 256 * 1024;
const PLAN_MD_MAX = 200_000;        // the markdown engine's chat cap: longer is terminal-only
const SUGGESTIONS_MAX_BYTES = 4 * 1024;
const TRUNCATED_MAX = 64;

// An elicitation's bounds (§15.7): a flat form the page can draw.
const ELICIT_KEYS = new Set(['server', 'message', 'mode', 'elicitation_id', 'schema']);
const ELICIT_SERVER_MAX = 200;
const ELICIT_MESSAGE_MAX = 4000;
const ELICIT_ID_MAX = 200;
const ELICIT_PROPS_MAX = 20;
const ELICIT_NAME_MAX = 100;
const ELICIT_TITLE_MAX = 200;
const ELICIT_DESCRIPTION_MAX = 1000;
const ELICIT_ENUM_MAX = 50;
const ELICIT_ENUM_VALUE_MAX = 200;
const ELICIT_DEFAULT_MAX = 200;
const ELICIT_STRING_MAX = 2000;     // a typed string value, whatever maxLength says
const ELICIT_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const ELICIT_FORMATS = new Set(['email', 'uri', 'date', 'date-time']);
const ELICIT_PROP_KEYS = new Set(['type', 'title', 'description', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'format', 'default']);
const ELICIT_SCHEMA_KEYS = new Set(['type', 'properties', 'required']);

// A decision's bounds (§4.2, §4.4).
const MESSAGE_MAX = 2000;
const OTHER_MAX = 500;
const UA_MAX = 200;
const PLAN_MODES = new Set(['default', 'acceptEdits']);

const KINDS = Object.freeze(['permission', 'question', 'plan', 'elicitation']);
const KIND_OF_TOOL = Object.freeze({ AskUserQuestion: 'question', ExitPlanMode: 'plan' });
// The display fields that carry a file's content: they get the redaction
// context (U23's hand-off: context on a display's output-like fields only).
const CONTENT_FIELDS = new Set(['old_string', 'new_string', 'content', 'new_source', 'edits']);
const WITHHOLD = new Set(WITHHOLD_CATEGORIES);

const OUTCOME_OF = Object.freeze({
  allow: 'allowed', deny: 'denied', answer: 'answered', decline: 'declined',
  approve: 'approved', reject: 'rejected', terminal: 'terminal',
  accept: 'accepted', cancel: 'cancelled',
});
const BEHAVIORS = Object.freeze({
  permission: new Set(['allow', 'deny', 'terminal']),
  question: new Set(['answer', 'decline', 'terminal']),
  plan: new Set(['approve', 'reject', 'terminal']),
  elicitation: new Set(['accept', 'decline', 'cancel', 'terminal']),
});
// The behaviors that act on the user's behalf: refused on a request that
// cannot be shown whole (why_not 'too-long'), whatever the gate let through.
const ACTING = new Set(['allow', 'answer', 'approve', 'accept']);

const WITHDRAW_REASONS = Object.freeze({
  sigterm: { outcome: 'terminal', by: 'terminal' },
  deadline: { outcome: 'expired', by: 'terminal' },
  'resolved-elsewhere': { outcome: 'terminal', by: 'terminal' },
});
// live.js's CLEARED_BY: the only `by` values the mirror reads as themselves.
const CLEARED_BY = new Set(['terminal', 'web', 'esc', 'tool-ran', 'turn-closed']);
const TURN_EVENTS = new Set(['Stop', 'StopFailure', 'UserPromptSubmit']);

// The default timers are unref'd: an ask never holds a process open.
const DEFAULT_TIMERS = Object.freeze({
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    if (h && typeof h.unref === 'function') h.unref();
    return h;
  },
  clearTimeout(h) { clearTimeout(h); },
});

// ── small helpers ───────────────────────────────────────────────────────────

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const bytesOf = (v) => {
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { return Infinity; }
};
const chars = (s) => Array.from(s).length;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const agentKey = (agent) => (isPlain(agent) && typeof agent.id === 'string' && agent.id ? agent.id : null);
const kindOfTool = (name) => KIND_OF_TOOL[name] || 'permission';
const str = (v, max) => (typeof v === 'string' ? stripControls(v).slice(0, max) : null);
const word = (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v) ? v : null);

// Why a create body is not one this domain takes (a field name, never a
// value), or null. The envelope's own shape is the intake's checkEnvelope's to
// judge (the route calls it); this checks what the domain reads of it.
function checkCreate(body) {
  if (!isPlain(body)) return 'body';
  for (const k of Object.keys(body)) if (!CREATE_KEYS.has(k)) return 'body';
  if (body.v !== 1) return 'v';
  const env = body.envelope;
  if (!isPlain(env)) return 'envelope';
  if (env.event === 'Elicitation') return checkElicitationCreate(body, env);
  if (env.event !== 'PermissionRequest') return 'envelope.event';
  const common = checkEnvelopeIds(env);
  if (common) return common;
  if (!isPlain(env.tool) || typeof env.tool.name !== 'string' || !env.tool.name || env.tool.name.length > 200) return 'envelope.tool';
  if (env.tool.use_id != null && typeof env.tool.use_id !== 'string') return 'envelope.tool.use_id';
  if (env.tool.input_hash != null && typeof env.tool.input_hash !== 'string') return 'envelope.tool.input_hash';
  if (body.elicitation !== undefined) return 'elicitation';
  if (!KINDS.includes(body.kind) || body.kind !== kindOfTool(env.tool.name)) return 'kind';
  const d = body.display;
  if (!isPlain(d) || !isPlain(d.input)) return 'display';
  if (!Array.isArray(d.truncated) || d.truncated.length > TRUNCATED_MAX || !d.truncated.every((n) => typeof n === 'string')) return 'display.truncated';
  if (body.questions_truncated != null && typeof body.questions_truncated !== 'boolean') return 'questions_truncated';
  if (body.kind === 'question') {
    const why = checkQuestions(body.questions);
    if (why) return why;
  } else if (body.questions != null) return 'questions';
  if (body.kind === 'plan') {
    const p = body.plan;
    if (!isPlain(p)) return 'plan';
    if (typeof p.text !== 'string' || Buffer.byteLength(p.text, 'utf8') > PLAN_MAX_BYTES) return 'plan.text';
    if (!(p.file === null || p.file === undefined || (typeof p.file === 'string' && p.file.startsWith('/') && p.file.length <= 4096))) return 'plan.file';
    if (p.from_file != null && typeof p.from_file !== 'boolean') return 'plan.from_file';
    if (p.truncated != null && typeof p.truncated !== 'boolean') return 'plan.truncated';
  } else if (body.plan != null) return 'plan';
  if (body.suggestions != null && bytesOf(body.suggestions) > SUGGESTIONS_MAX_BYTES) return 'suggestions';
  return null;
}

// What every create reads of its envelope beyond the event.
function checkEnvelopeIds(env) {
  if (typeof env.session_id !== 'string' || !env.session_id) return 'envelope.session_id';
  if (!(typeof env.ts === 'number' && Number.isFinite(env.ts))) return 'envelope.ts';
  if (env.ask != null) return 'envelope.ask';
  if (hasOwn(env, 'synthetic')) return 'envelope.synthetic';
  return null;
}

// An Elicitation's create: the envelope (no tool section), kind 'elicitation'
// and `elicitation` — nothing of a permission's body.
function checkElicitationCreate(body, env) {
  const common = checkEnvelopeIds(env);
  if (common) return common;
  if (env.tool != null) return 'envelope.tool';
  if (body.kind !== 'elicitation') return 'kind';
  for (const k of ['display', 'questions', 'questions_truncated', 'plan', 'suggestions']) {
    if (body[k] !== undefined) return 'body';
  }
  return checkElicitation(body.elicitation);
}

const isString = (v, max, min = 0) => typeof v === 'string' && chars(v) >= min && chars(v) <= max;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function checkElicitation(e) {
  if (!isPlain(e)) return 'elicitation';
  for (const k of Object.keys(e)) if (!ELICIT_KEYS.has(k)) return 'elicitation';
  if (!isString(e.server, ELICIT_SERVER_MAX, 1)) return 'elicitation.server';
  if (!isString(e.message, ELICIT_MESSAGE_MAX)) return 'elicitation.message';
  if (e.mode !== 'form') return 'elicitation.mode';
  if (e.elicitation_id != null && !isString(e.elicitation_id, ELICIT_ID_MAX)) return 'elicitation.elicitation_id';
  return checkElicitationSchema(e.schema);
}

function checkElicitationSchema(s) {
  const F = 'elicitation.schema';
  if (!isPlain(s)) return F;
  for (const k of Object.keys(s)) if (!ELICIT_SCHEMA_KEYS.has(k)) return F;
  if (s.type !== undefined && s.type !== 'object') return `${F}.type`;
  if (!isPlain(s.properties)) return `${F}.properties`;
  const names = Object.keys(s.properties);
  if (names.length < 1 || names.length > ELICIT_PROPS_MAX) return `${F}.properties`;
  for (const name of names) {
    if (!isString(name, ELICIT_NAME_MAX, 1)) return `${F}.properties`;
    const p = s.properties[name];
    if (!isPlain(p)) return `${F}.properties`;
    for (const k of Object.keys(p)) if (!ELICIT_PROP_KEYS.has(k)) return `${F}.properties`;
    if (!ELICIT_TYPES.has(p.type)) return `${F}.type`;
    const str = p.type === 'string';
    const num = p.type === 'number' || p.type === 'integer';
    if (p.title !== undefined && !isString(p.title, ELICIT_TITLE_MAX)) return `${F}.title`;
    if (p.description !== undefined && !isString(p.description, ELICIT_DESCRIPTION_MAX)) return `${F}.description`;
    if (p.enum !== undefined) {
      if (!str || !Array.isArray(p.enum) || p.enum.length < 1 || p.enum.length > ELICIT_ENUM_MAX
        || !p.enum.every((v) => isString(v, ELICIT_ENUM_VALUE_MAX))) return `${F}.enum`;
    }
    for (const k of ['minimum', 'maximum']) {
      if (p[k] !== undefined && (!num || !(typeof p[k] === 'number' && Number.isFinite(p[k])))) return `${F}.${k}`;
    }
    if (p.minimum !== undefined && p.maximum !== undefined && p.minimum > p.maximum) return `${F}.maximum`;
    for (const k of ['minLength', 'maxLength']) {
      if (p[k] !== undefined && (!str || !isCount(p[k]))) return `${F}.${k}`;
    }
    if (p.minLength !== undefined && p.maxLength !== undefined && p.minLength > p.maxLength) return `${F}.maxLength`;
    if (p.format !== undefined && (!str || !ELICIT_FORMATS.has(p.format))) return `${F}.format`;
    if (p.default !== undefined) {
      const ok = str ? isString(p.default, ELICIT_DEFAULT_MAX)
        : num ? typeof p.default === 'number' && Number.isFinite(p.default)
          : typeof p.default === 'boolean';
      if (!ok) return `${F}.default`;
    }
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.length > names.length) return `${F}.required`;
    const seen = new Set();
    for (const k of s.required) {
      if (typeof k !== 'string' || !hasOwn(s.properties, k) || seen.has(k)) return `${F}.required`;
      seen.add(k);
    }
  }
  return null;
}

// Whether an input the mod forwarded may have been cut by its transport
// (lib/core/mod-protocol boundObject: strings halve until the JSON fits
// INPUT_MAX, so a cut input is always over half of it; keys, items and depth
// stop at 64, 64 and 8). Over-reading costs nothing: such a prompt is the
// terminal's, through the settings hook.
const BOUND_SIDE = 64;
const BOUND_DEPTH = 8;
function possiblyCut(input) {
  if (!isPlain(input) || input.truncated === true) return true;
  if (bytesOf(input) * 2 > INPUT_MAX) return true;
  const walk = (v, depth) => {
    if (v === null || typeof v !== 'object') return false;
    if (depth >= BOUND_DEPTH - 1) return true;
    const kids = Array.isArray(v) ? v : Object.values(v);
    if (kids.length >= BOUND_SIDE) return true;
    return kids.some((x) => walk(x, depth + 1));
  };
  return walk(input, 0);
}

function checkQuestions(qs) {
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > QUESTIONS_MAX) return 'questions';
  if (bytesOf(qs) > QUESTIONS_MAX_BYTES) return 'questions';
  for (const q of qs) {
    if (!isPlain(q)) return 'questions';
    if (typeof q.question !== 'string' || chars(q.question) > QUESTION_MAX) return 'questions.question';
    if (q.header != null && (typeof q.header !== 'string' || chars(q.header) > HEADER_MAX)) return 'questions.header';
    if (typeof q.multiSelect !== 'boolean') return 'questions.multiSelect';
    if (!Array.isArray(q.options) || q.options.length > OPTIONS_MAX) return 'questions.options';
    for (const o of q.options) {
      if (!isPlain(o) || typeof o.label !== 'string' || chars(o.label) > LABEL_MAX) return 'questions.options.label';
      if (o.description != null && (typeof o.description !== 'string' || chars(o.description) > DESCRIPTION_MAX)) return 'questions.options.description';
    }
  }
  return null;
}

// A message or free text: control characters cleaned, then bounded. Returns
// the clean text ('' for none), or null when it is not a string or too long.
function cleanText(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  const s = stripControls(v, { keepNewlines: true }).trim();
  return chars(s) > max ? null : s;
}

// ── the domain ──────────────────────────────────────────────────────────────

function createAsks({
  bus, hooks, mirror, getViewers, audience, answerSurface, redactor, root,
  audit, send, now = Date.now, timers = DEFAULT_TIMERS,
} = {}) {
  void audience; // the routes gate with it; the domain reads the level it is handed
  const records = new Map();
  const offs = [];
  let stopped = false;
  let createSeq = 0; // the order creates were taken in: the last tie-break of `olderThan`

  const clock = () => {
    try { const t = now(); return Number.isFinite(t) ? t : Date.now(); } catch { return Date.now(); }
  };
  const setT = (fn, ms) => timers.setTimeout(fn, ms);
  const clearT = (h) => { if (h != null) { try { timers.clearTimeout(h); } catch {} } };

  // ── the answer surface ──
  const surface = () => {
    try { return typeof answerSurface === 'function' ? answerSurface() : answerSurface; } catch { return null; }
  };
  function answerPort() {
    const s = surface();
    const p = s ? s.port : null;
    return Number.isSafeInteger(p) && p > 0 ? { port: p } : null;
  }
  function remoteAnswering() {
    const s = surface();
    if (!s || typeof s.remoteAnswering !== 'function') return false;
    try { return s.remoteAnswering() === true; } catch { return false; }
  }
  function ensureSurface() {
    const s = surface();
    if (!s || typeof s.ensure !== 'function') return Promise.resolve(false);
    let timer = null;
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ENSURE_MS);
      if (timer.unref) timer.unref();
    });
    let call;
    try { call = Promise.resolve(s.ensure()).then((r) => r !== false && r != null, () => false); } catch { call = Promise.resolve(false); }
    return Promise.race([call, cap]).finally(() => clearTimeout(timer));
  }

  // ── viewers ──
  function viewersOk({ localNow = false } = {}) {
    let v = null;
    try { v = typeof getViewers === 'function' ? getViewers() : null; } catch { v = null; }
    if (!isPlain(v)) return false;
    const t = clock();
    if (v.local > 0) return true;
    // An elicitation holds the terminal's dialog back: only a page open NOW.
    if (localNow) return false;
    if (Number.isFinite(v.last_local_at) && t - v.last_local_at < LOCAL_RECENT_MS) return true;
    if (remoteAnswering() && Number.isFinite(v.last_full_remote_at) && t - v.last_full_remote_at < REMOTE_RECENT_MS) return true;
    return false;
  }

  // ── the conversation an ask belongs to ──
  function conversationFor(sessionId, pid) {
    const m = mirror;
    if (!m) return null;
    try {
      if (typeof m.conversationOf === 'function') {
        const c = m.conversationOf(sessionId);
        if (typeof c === 'string' && c) return c;
      }
    } catch {}
    try {
      if (pid != null && typeof m.conversationOfPid === 'function') {
        const c = m.conversationOfPid(pid);
        if (typeof c === 'string' && c) return c;
      }
    } catch {}
    return null;
  }

  // ── redaction ──
  const red = {
    value: (v, opts) => (redactor && typeof redactor.value === 'function' ? redactor.value(v, opts) : v),
    text: (s, opts) => (redactor && typeof redactor.text === 'function' ? redactor.text(s, opts) : s),
  };
  const hostPaths = (v) => redactHostPaths(v, { root: root || null });

  // The display input, redacted field by field: the content fields with the
  // redaction context ({file, command}), the rest without; then the host's
  // paths. A file in a withheld category (a dotenv included, spec §5.5's file
  // rule) has its content fields withheld whole.
  function redactDisplay(name, input) {
    const file = fileOf(name, input);
    const command = typeof input.command === 'string' ? input.command : undefined;
    const category = file ? sensitivePath(file) : null;
    const withheld = category && WITHHOLD.has(category) ? WITHHELD(category) : null;
    const out = {};
    for (const k of Object.keys(input)) {
      let v;
      if (CONTENT_FIELDS.has(k)) {
        v = withheld ? withholdAll(input[k], withheld) : red.value({ [k]: input[k] }, { context: { file, command } });
      } else {
        v = red.value({ [k]: input[k] });
      }
      if (withheld && CONTENT_FIELDS.has(k)) {
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      } else {
        for (const kk of Object.keys(v)) Object.defineProperty(out, kk, { value: v[kk], enumerable: true, writable: true, configurable: true });
      }
    }
    return hostPaths(out);
  }
  function withholdAll(v, mark) {
    if (typeof v === 'string') return v ? mark : v;
    if (Array.isArray(v)) return v.map((x) => withholdAll(x, mark));
    if (isPlain(v)) {
      const o = {};
      for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: withholdAll(v[k], mark), enumerable: true, writable: true, configurable: true });
      return o;
    }
    return v;
  }

  // ── frames, ring and audit ──
  function publicOf(r) {
    return {
      id: r.id,
      conversation_id: r.conversation_id,
      kind: r.kind,
      tool_name: r.tool_name,
      tool_kind: r.tool_kind,
      agent: r.agent ? { type: r.agent.type } : null,
      created_at: r.created_at,
      state: r.state,
      answerable: r.answerable,
      outcome: r.outcome,
      via: r.via,
      tool_use_id: r.tool_use_id,
      version: r.version,
      masked: r.masked,
    };
  }
  // op: 'open' | 'update' | 'close'; ringOp: 'open' | 'decided' | 'resolved' | null.
  function emitAsk(r, op, ringOp) {
    if (!bus || typeof bus.emit !== 'function') return;
    const event = ringOp
      ? { kind: 'ask', op: ringOp, id: r.id, ask_kind: r.kind, tool_name: r.tool_name, outcome: r.outcome }
      : null;
    try {
      bus.emit({ event, ws: { type: 'mirror:ask', op, ask: publicOf(r), answer: answerPort() } });
    } catch {}
  }

  function writeLine(line) {
    if (typeof audit === 'function') { try { audit(line); } catch {} return; }
    if (!root) return;
    try {
      const p = projectPaths(root);
      fs.mkdirSync(p.asksDir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(p.asksAudit).size; } catch {}
      if (size >= AUDIT_MAX_BYTES) renameAside(p.asksAudit, { tag: '1', keep: 1 });
      fs.appendFileSync(p.asksAudit, JSON.stringify(line) + '\n');
    } catch {}
  }
  function auditLine(r, { outcome, via, remote = false, device = null, ua = null, reason } = {}) {
    const line = {
      at: clock(),
      ask: r ? r.id : null,
      kind: r ? r.kind : null,
      tool: r ? r.tool_name : null,
      outcome: outcome || null,
      via: via || null,
      origin: remote ? 'remote' : 'local',
      device: device === 'mobile' || device === 'desktop' ? device : null,
      ua: str(ua, UA_MAX),
    };
    if (reason) line.reason = word(reason) || 'refused';
    // The mod's asks say so (gate V41 reads which transport held each ask).
    if (r && r.transport === 'mod') line.transport = 'mod';
    writeLine(line);
  }

  // ── waiters (the hook's long-poll, the frame's long-poll) ──
  // A waiter is fn(record) → true when it is done; it runs on every change.
  function changed(r) {
    for (const w of [...r.waiters]) {
      let done = false;
      try { done = w(r); } catch { done = true; }
      if (done) r.waiters.delete(w);
    }
  }
  function bump(r, { op = 'update', ringOp = null, emit = true } = {}) {
    r.version += 1;
    changed(r);
    if (emit) emitAsk(r, op, ringOp);
  }

  // ── the per-record timer: the TTL and a silent hook ──
  // A hook polls; the mod is answered through `send` and settles by its own
  // event, so a mod ask has no silence to watch.
  const polled = (r) => r.hook_attached && r.transport === 'hook';
  function arm(r) {
    clearT(r.timer);
    r.timer = null;
    if (stopped || r.state === 'resolved') return;
    let due = r.expires_at;
    if (polled(r) && r.polling === 0) due = Math.min(due, r.last_poll_at + HOOK_SILENT_MS);
    r.timer = setT(() => { r.timer = null; check(r); }, Math.max(0, due - clock()));
  }
  function check(r) {
    if (stopped || r.state === 'resolved') return;
    const t = clock();
    if (t >= r.expires_at) { resolve(r, { outcome: 'expired', by: 'terminal', cause: 'ttl' }); return; }
    if (polled(r) && r.polling === 0 && t - r.last_poll_at >= HOOK_SILENT_MS) {
      resolve(r, r.collected ? { by: 'web', cause: 'hook-silent' } : { outcome: 'expired', by: 'terminal', cause: 'hook-silent' });
      return;
    }
    arm(r);
  }

  // ── resolution ──
  // `outcome` is used for a pending ask; a decided ask whose decision the hook
  // has collected keeps its own unless `force`. `by` is mapped onto CLEARED_BY;
  // a collected decided ask resolves 'web' (or 'terminal' when the web said
  // "answer in the terminal") unless `force`. An uncollected decided ask never
  // reached the hook, so it resolves like a pending one.
  function resolve(r, { outcome = 'terminal', by = 'terminal', force = false } = {}) {
    if (!r || r.state === 'resolved') return false;
    const decided = r.state === 'decided' && r.collected;
    if (decided && !force) {
      by = r.decision && r.decision.behavior === 'terminal' ? 'terminal' : 'web';
    } else {
      r.outcome = outcome;
    }
    if (!CLEARED_BY.has(by)) by = 'terminal';
    r.state = 'resolved';
    r.by = by;
    forget(r);
    r.resolved_at = clock();
    clearT(r.timer);
    r.timer = null;
    r.version += 1;
    changed(r);
    if (r.published) {
      try {
        hooks.publish({
          v: 1,
          event: 'PermissionResolved',
          synthetic: true,
          ts: r.resolved_at,
          session_id: r.session_id,
          agent: r.agent,
          tool: { name: r.tool_name, use_id: r.tool_use_id, input_hash: r.input_hash },
          ask: { id: r.id, kind: r.kind, by, outcome: r.outcome, decision: r.decision ? r.decision.behavior : null },
        });
      } catch {}
    }
    auditLine(r, { outcome: r.outcome, via: by });
    if (r.published) emitAsk(r, 'close', 'resolved');
    return true;
  }

  // An elicitation's content leaves the record once the hook has printed it
  // or the ask is over: only the behavior stays.
  function forget(r) {
    if (r.decision && hasOwn(r.decision, 'content')) r.decision = { behavior: r.decision.behavior };
  }

  const open = (r) => r.state !== 'resolved' && r.published;
  const isElicitation = (r) => r.kind === 'elicitation';
  // Whether ask `a` is older than ask `b`: created_at, then the envelope's ts,
  // then the order create took them in (a fake or coarse clock can tie both).
  function olderThan(a, b) {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at;
    if (a.ts !== b.ts) return a.ts < b.ts;
    return a.seq < b.seq;
  }
  const sameAgent = (r, env) => r.agent_key === agentKey(env.agent);

  // ── correlation: which tool_use_id the ask is about ──
  function bind(r, useId) {
    if (r.tool_use_id || typeof useId !== 'string' || !useId) return;
    r.tool_use_id = useId;
    if (r.published && r.state !== 'resolved') bump(r);
    else r.version += 1;
  }
  const isOwnCall = (r, env) => isPlain(env.tool) && env.tool.name === r.tool_name
    && typeof env.tool.input_hash === 'string' && env.tool.input_hash === r.input_hash;

  function correlateAtCreate(r) {
    if (r.tool_use_id || !r.input_hash || !hooks || typeof hooks.recent !== 'function') return;
    let best = null;
    let after = null;
    let entries = [];
    try { entries = hooks.recent(); } catch {}
    for (const e of entries) {
      if (!isPlain(e) || e.event !== 'PreToolUse' || e.session_id !== r.session_id || !sameAgent(r, e) || !isOwnCall(r, e)) continue;
      if (!isPlain(e.tool) || typeof e.tool.use_id !== 'string' || !e.tool.use_id) continue;
      const d = e.ts - r.ts;
      if (d <= 0 && d >= -CORRELATE_MS) { if (!best || e.ts >= best.ts) best = e; }
      else if (d > 0 && d <= CORRELATE_MS) { if (!after || e.ts < after.ts) after = e; }
    }
    const hit = best || after;
    if (hit) r.tool_use_id = hit.tool.use_id;
  }

  // ── the tap: envelopes that bind or resolve ──
  function onHook(env) {
    if (stopped || !isPlain(env)) return;
    if (env.synthetic === true && env.event === MOD_EVENT && isPlain(env.mod)) {
      if (env.mod.kind === 'permission.request') createFromMod(env).catch(() => {});
      else if (env.mod.kind === 'permission.settled') withdrawFromMod(env);
      return;
    }
    if (env.synthetic === true || env.ask != null || env.event === 'PermissionRequest' || env.event === 'Elicitation') return;
    const sid = typeof env.session_id === 'string' ? env.session_id : null;
    if (!sid) return;
    const event = env.event;
    const ts = Number.isFinite(env.ts) ? env.ts : clock();
    const useId = isPlain(env.tool) && typeof env.tool.use_id === 'string' && env.tool.use_id ? env.tool.use_id : null;
    const t = clock();
    for (const r of [...records.values()]) {
      if (r.state === 'resolved' || r.session_id !== sid) continue;
      if (event === 'SessionEnd') {
        if (open(r)) resolve(r, { by: 'turn-closed' });
        continue;
      }
      if (!sameAgent(r, env)) continue;
      // A tool event says nothing about an elicitation: it arrives inside
      // its MCP call, and parallel calls run on.
      if (isElicitation(r) && !TURN_EVENTS.has(event)) continue;
      if (event === 'PreToolUse') {
        if (isOwnCall(r, env)) {
          // The ask's own call: it binds the ask, never resolves it (async
          // delivery brings it in after the ask, §1.1).
          if (!r.tool_use_id && useId && (Math.abs(ts - r.ts) <= CORRELATE_MS || t - r.created_at <= CORRELATE_MS)) bind(r, useId);
          continue;
        }
        if (open(r) && ts > r.ts) resolve(r, { by: 'tool-ran' });
        continue;
      }
      if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
        // Unbound, an equal hash counts only when newer than the ask: a late
        // PostToolUse of an earlier identical call is not this one.
        const mine = r.tool_use_id ? useId === r.tool_use_id : isOwnCall(r, env) && ts > r.ts;
        if (mine && open(r)) resolve(r, { by: 'tool-ran' });
        continue;
      }
      if (TURN_EVENTS.has(event) && open(r) && ts > r.ts) resolve(r, { by: 'turn-closed' });
    }
  }

  // ── the mirror: transitions that resolve, name the conversation, or apply ──
  function onMirror(tr) {
    if (stopped || !isPlain(tr)) return;
    const sid = typeof tr.session_id === 'string' ? tr.session_id : null;
    const cid = typeof tr.conversation_id === 'string' && tr.conversation_id ? tr.conversation_id : null;
    if (sid && cid) {
      for (const r of records.values()) {
        if (r.session_id !== sid || r.conversation_id) continue;
        r.conversation_id = cid;
        if (open(r)) bump(r); else r.version += 1;
      }
    }
    if (tr.op === 'waiting-cleared') {
      const by = CLEARED_BY.has(tr.by) ? tr.by : 'terminal';
      const askId = typeof tr.ask_id === 'string' && tr.ask_id ? tr.ask_id : null;
      if (askId) {
        const r = records.get(askId);
        if (r && open(r)) resolve(r, { by });
        return;
      }
      if (!sid) return;
      for (const r of [...records.values()]) if (r.session_id === sid && open(r) && !isElicitation(r)) resolve(r, { by });
      return;
    }
    if (tr.op === 'state') {
      // Only a move AWAY from waiting resolves: live.js draws the state from
      // the newest pending ask of any agent, so waiting ⇄ question is another
      // agent's ask opening or closing, not this one being answered.
      if (!sid || (tr.prev !== 'waiting' && tr.prev !== 'question')) return;
      if (tr.state === 'waiting' || tr.state === 'question') return;
      for (const r of [...records.values()]) if (r.session_id === sid && open(r) && !isElicitation(r)) resolve(r, { by: 'terminal' });
      return;
    }
    if (tr.op === 'permission-decision') {
      const useId = typeof tr.tool_use_id === 'string' && tr.tool_use_id ? tr.tool_use_id : null;
      if (!useId) return;
      for (const r of records.values()) {
        if (r.tool_use_id !== useId || r.applied) continue;
        r.applied = true;
        if (open(r)) bump(r); else r.version += 1;
      }
    }
  }

  if (hooks && typeof hooks.subscribe === 'function') offs.push(hooks.subscribe(onHook));
  if (mirror && typeof mirror.subscribe === 'function') {
    try { offs.push(mirror.subscribe(onMirror)); } catch {}
  }

  // ── housekeeping ──
  function prune() {
    const t = clock();
    for (const [id, r] of records) {
      if (r.state === 'resolved' && t - r.resolved_at >= RESOLVED_KEEP_MS) records.delete(id);
    }
    if (records.size <= RECORDS_MAX) return;
    for (const [id, r] of records) {
      if (records.size <= RECORDS_MAX) break;
      if (r.state === 'resolved') records.delete(id);
    }
  }

  function newId() {
    for (;;) {
      const id = 'ask_' + crypto.randomBytes(6).toString('hex');
      if (!records.has(id)) return id;
    }
  }

  // ── create ──
  // The record's tool-specific half, from a validated permission, question or
  // plan create body.
  function toolSpec(body) {
    const env = body.envelope;
    const tool = env.tool;
    const name = tool.name;
    const input = body.display.input;
    const display = redactDisplay(name, input);
    const subject = hostPaths(red.text(toolSubject(name, input)));
    // The questions as shown: every field the frame draws, nothing else.
    const asked = body.kind === 'question'
      ? body.questions.map((q) => ({
        header: typeof q.header === 'string' ? q.header : '',
        question: q.question,
        multiSelect: q.multiSelect,
        options: q.options.map((o) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
      }))
      : null;
    const questions = asked ? hostPaths(red.value(asked)) : null;
    const plan = body.kind === 'plan'
      ? {
        text: hostPaths(red.text(body.plan.text)),
        file: typeof body.plan.file === 'string' ? hostPaths(body.plan.file) : null,
        from_file: body.plan.from_file === true,
        truncated: body.plan.truncated === true,
      }
      : null;
    const masked = JSON.stringify(display) !== JSON.stringify(input)
      || subject !== toolSubject(name, input)
      || (questions !== null && JSON.stringify(questions) !== JSON.stringify(asked))
      || (plan !== null && plan.text !== body.plan.text);
    const complete = body.display.truncated.length === 0
      && body.questions_truncated !== true
      // The engine's own measure (UTF-16 length) of the text the frame renders.
      && !(plan && (plan.truncated || plan.text.length > PLAN_MD_MAX));
    const envUseId = typeof tool.use_id === 'string' && tool.use_id ? tool.use_id : null;
    return {
      tool_name: name,
      tool_kind: toolKind(name),
      env_use_id: envUseId,
      input_hash: typeof tool.input_hash === 'string' && tool.input_hash ? tool.input_hash : null,
      display,
      subject,
      truncated: body.display.truncated.slice(),
      questions,
      questions_truncated: body.questions_truncated === true,
      plan,
      suggestions: body.suggestions == null ? null : body.suggestions,
      masked,
      complete,
    };
  }

  // An elicitation's: the server, the message and the fields, redacted as a
  // permission's display is. A field NAME or an enum VALUE the redactor would
  // change cannot be shown and still be answered (the content is keyed by the
  // name and an enum is answered by its value), so such a form is incomplete:
  // the terminal answers it.
  function elicitationSpec(body) {
    const e = body.elicitation;
    const say = (v) => hostPaths(red.text(v));
    let masked = false;
    let complete = true;
    const shown = (v) => { const out = say(v); if (out !== v) masked = true; return out; };
    const required = new Set(Array.isArray(e.schema.required) ? e.schema.required : []);
    const fields = [];
    for (const name of Object.keys(e.schema.properties)) {
      const p = e.schema.properties[name];
      if (say(name) !== name) { complete = false; masked = true; }
      const f = { name, type: p.type, required: required.has(name) };
      if (p.title !== undefined) f.title = shown(p.title);
      if (p.description !== undefined) f.description = shown(p.description);
      if (p.enum !== undefined) {
        f.enum = p.enum.map((v) => { const out = say(v); if (out !== v) { complete = false; masked = true; } return out; });
      }
      for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'format']) if (p[k] !== undefined) f[k] = p[k];
      if (p.default !== undefined) f.default = typeof p.default === 'string' ? shown(p.default) : p.default;
      fields.push(f);
    }
    const server = shown(e.server);
    const message = shown(e.message);
    let hash = null;
    try { hash = inputHash({ server: e.server, message: e.message, mode: e.mode, elicitation_id: e.elicitation_id || null, schema: e.schema }); } catch { hash = null; }
    return {
      tool_name: e.server,
      tool_kind: 'elicitation',
      env_use_id: null,
      input_hash: hash,
      display: { server, message, fields },
      subject: message,
      truncated: [],
      questions: null,
      questions_truncated: false,
      plan: null,
      suggestions: null,
      masked,
      complete,
    };
  }

  // Two asks one supersedes the other within: an elicitation only another
  // elicitation; a permission, question or plan only one of those.
  const sameClass = (a, b) => isElicitation(a) === isElicitation(b);

  // opts (in process only): {transport: 'hook'|'mod', request_id}. The route
  // hands the body alone, so an HTTP create is always the hook's.
  async function create(body, opts = {}) {
    if (stopped) return { ok: false, status: 503, error: 'stopped' };
    const transport = opts.transport === 'mod' ? 'mod' : 'hook';
    const env = isPlain(body) ? body.envelope : null;
    // An SDK host (-p, the Agent SDK) races the hook; the hook already returns
    // for one (C38), and the domain refuses one too, keeping nothing.
    if (isPlain(env) && typeof env.entrypoint === 'string' && /^sdk/.test(env.entrypoint)) {
      return { ok: true, wait: false, reason: 'sdk' };
    }
    const invalid = checkCreate(body);
    if (invalid) return { ok: false, status: 400, invalid };
    prune();
    const t = clock();
    const elicitation = body.kind === 'elicitation';
    const spec = elicitation ? elicitationSpec(body) : toolSpec(body);
    const aKey = agentKey(env.agent);

    // A second registered handler posting the same ask (ruling A1 (a)): the
    // settings hook and the mod alike — whichever creates first holds it.
    for (const r of records.values()) {
      if (r.state !== 'pending' || t - r.created_at >= DUPLICATE_MS) continue;
      if (r.session_id !== env.session_id || r.agent_key !== aKey || r.kind !== body.kind || r.tool_name !== spec.tool_name) continue;
      if (r.input_hash !== spec.input_hash || r.env_use_id !== spec.env_use_id) continue;
      return { ok: true, id: r.id, wait: false, reason: 'duplicate' };
    }

    const agent = isPlain(env.agent)
      ? { id: aKey, type: typeof env.agent.type === 'string' ? env.agent.type.slice(0, 100) : null }
      : null;
    const r = {
      id: newId(),
      secretHash: null,
      transport,
      request_id: transport === 'mod' ? opts.request_id : null,
      conversation_id: conversationFor(env.session_id, env.claude_pid),
      session_id: env.session_id,
      claude_pid: Number.isSafeInteger(env.claude_pid) ? env.claude_pid : null,
      agent,
      agent_key: aKey,
      kind: body.kind,
      tool_use_id: spec.env_use_id,
      ts: env.ts,
      ...spec,
      state: 'pending',
      answerable: false,
      hook_attached: false,
      decision: null,
      outcome: null,
      via: null,
      by: null,
      version: 1,
      created_at: t,
      seq: ++createSeq,
      expires_at: t + (elicitation ? ELICIT_WAIT_MS + HOOK_SILENT_MS : TTL_MS),
      resolved_at: null,
      applied: false,
      published: false,
      collected: false,
      polling: 0,
      last_poll_at: t,
      timer: null,
      waiters: new Set(),
    };
    if (!elicitation) correlateAtCreate(r);
    // In the map before anything is awaited, so a concurrent duplicate sees it;
    // evidence skips it until it is published (`open`).
    records.set(r.id, r);

    let answerable = false;
    let reason = 'no-viewer';
    if (viewersOk({ localNow: elicitation })) {
      answerable = await ensureSurface();
      if (!answerable) reason = 'answer-surface';
    }
    if (stopped) {
      records.delete(r.id);
      return { ok: false, status: 503, error: 'stopped' };
    }
    // The mod holds only what the page can answer; anything else is the
    // settings hook's to create, so it leaves no record behind.
    if (transport === 'mod' && (!answerable || !r.complete)) {
      records.delete(r.id);
      return { ok: true, wait: false, reason: answerable ? 'too-long' : reason };
    }

    // Older pending asks of the same session and agent go to the terminal
    // (their hooks read `resolved` and exit silently). Done before this ask is
    // published, so the mirror's reaction to them cannot touch it. Two creates
    // can finish their ensure() out of order, so only an OLDER ask is
    // superseded; a newer one already published supersedes this one instead,
    // once it is published below.
    let newerOpen = false;
    for (const o of [...records.values()]) {
      if (o === r || o.state !== 'pending' || !o.published) continue;
      if (o.session_id !== r.session_id || o.agent_key !== r.agent_key || !sameClass(o, r)) continue;
      if (olderThan(o, r)) resolve(o, { outcome: 'superseded', by: 'terminal' });
      else newerOpen = true;
    }

    let secret = null;
    if (answerable) {
      if (transport === 'hook') {
        secret = crypto.randomBytes(32).toString('base64url');
        r.secretHash = sha256(secret);
      }
      r.answerable = true;
      r.hook_attached = true;
      r.last_poll_at = clock();
    }
    r.published = true;
    arm(r);
    // The mod's request never crossed HTTP: it goes on the tap as the daemon's
    // own, synthetic, routed by its session.
    const published = transport === 'mod' ? { ...env, synthetic: true } : env;
    try { hooks.publish({ ...published, ask: { id: r.id, kind: r.kind } }); } catch {}
    if (r.state !== 'resolved') emitAsk(r, 'open', 'open');
    if (newerOpen) resolve(r, { outcome: 'superseded', by: 'terminal' });
    if (answerable && transport === 'mod') return { ok: true, id: r.id, wait: true };
    if (answerable) {
      return { ok: true, id: r.id, secret, wait: true, poll_ms: POLL_MS, deadline_ms: elicitation ? ELICIT_WAIT_MS : DEADLINE_MS };
    }
    return { ok: true, id: r.id, wait: false, reason };
  }

  // ── the mod's transport (§15.7, U87/U88's wire) ──
  // `send` never throws back here; whatever it answers is read as a promise.
  function callSend(msg) {
    if (typeof send !== 'function') return Promise.resolve({ ok: false, refused: 'no-transport' });
    try { return Promise.resolve(send(msg)).catch(() => ({ ok: false, refused: 'failed' })); } catch { return Promise.resolve({ ok: false, refused: 'failed' }); }
  }

  // A ModEvent 'permission.request' on the tap: the same create the settings
  // hook posts, built here from the mod's payload through lib/core/tool-input,
  // then create's validation, duplicate rule, correlation, supersede and
  // answerable rules unchanged. Whatever the page cannot hold is answered
  // PASS at once, so the mod returns next(e) without waiting.
  async function createFromMod(env) {
    if (stopped || !isPlain(env) || !isPlain(env.mod) || typeof send !== 'function') return { ok: false, reason: 'no-transport' };
    const m = env.mod;
    const sid = typeof env.session_id === 'string' && env.session_id ? env.session_id : null;
    const requestId = typeof m.request_id === 'string' && m.request_id ? m.request_id : null;
    if (!sid || !requestId) return { ok: false, reason: 'bad-event' };
    const pass = (reason) => {
      callSend({ session_id: sid, request_id: requestId, decision: { ...PASS } });
      return { ok: true, pass: true, reason };
    };
    const name = typeof m.tool === 'string' ? m.tool : '';
    const input = isPlain(m.input) ? m.input : null;
    if (!name || !input) return pass('bad-event');
    if (kindOfTool(name) !== 'permission') return pass('scope');
    if (possiblyCut(input)) return pass('too-long');
    const useId = typeof m.tool_use_id === 'string' && m.tool_use_id ? m.tool_use_id : null;
    let hash = null;
    try { hash = inputHash(input); } catch { hash = null; }
    let mirrorInput;
    try { mirrorInput = projectToolInput(name, input, { profile: 'mirror' }).input; } catch { mirrorInput = { truncated: true }; }
    const body = {
      v: 1,
      envelope: {
        v: 1,
        event: 'PermissionRequest',
        ts: Number.isFinite(env.ts) ? env.ts : clock(),
        session_id: sid,
        transcript_path: null,
        cwd: null,
        prompt_id: null,
        claude_pid: null,
        entrypoint: null,
        permission_mode: null,
        agent: null,
        tool: {
          name, use_id: useId, kind: toolKind(name), label: stepLabel(name, input), call: callLabel(name, input),
          input: mirrorInput, input_hash: hash,
        },
        result: null, session: null, compact: null, stop: null, prompt: null, ask: null,
      },
      kind: 'permission',
      display: projectToolInput(name, input, { profile: 'display' }),
    };
    let answer;
    try { answer = await create(body, { transport: 'mod', request_id: requestId }); } catch { answer = null; }
    if (!answer || answer.ok !== true || answer.wait !== true) return pass(answer && answer.reason ? answer.reason : 'refused');
    return { ok: true, id: answer.id, wait: true };
  }

  // A ModEvent 'permission.settled': the mod's prompt is over. By the web, after
  // our decision: handed. By the terminal or a timeout: withdrawn, terminal —
  // unless the web itself said "answer in the terminal".
  function withdrawFromMod(env) {
    if (!isPlain(env) || !isPlain(env.mod)) return false;
    const m = env.mod;
    let r = null;
    for (const x of records.values()) {
      if (x.transport === 'mod' && x.request_id === m.request_id && x.session_id === env.session_id) { r = x; break; }
    }
    if (!r || r.state === 'resolved') return false;
    const decided = r.state === 'decided';
    if (decided && (m.by === 'web' || r.decision.behavior === 'terminal')) {
      r.collected = true;
      return resolve(r, {});
    }
    return resolve(r, { outcome: 'terminal', by: 'terminal', force: true });
  }

  // The classic PermissionRequest result for a web decision on a mod ask: the
  // words of ask-output.js's one builder, never more than {behavior, message}.
  function classicOf(decision) {
    if (decision.behavior === 'allow') return { behavior: 'allow' };
    if (decision.behavior === 'deny') {
      try {
        const out = JSON.parse(buildAskOutput('permission', {}, decision));
        const d = out.hookSpecificOutput.decision;
        return { behavior: 'deny', message: d.message };
      } catch { return null; }
    }
    return { ...PASS };
  }

  function deliverToMod(r) {
    const decision = classicOf(r.decision);
    if (!decision) { resolve(r, { outcome: 'terminal', by: 'terminal', force: true }); return; }
    callSend({ session_id: r.session_id, request_id: r.request_id, decision }).then((res) => {
      if (r.state !== 'decided') return;
      if (isPlain(res) && res.ok === true) { r.collected = true; resolve(r, {}); return; }
      // Not delivered: the mod hands the prompt to the terminal at its wait's end.
      resolve(r, { outcome: 'terminal', by: 'terminal', force: true });
    });
  }

  // ── the hook's calls ──
  function authorize(id, secret) {
    const r = typeof id === 'string' ? records.get(id) : null;
    if (!r || !r.published) return { error: { ok: false, status: 404, error: 'unknown ask' } };
    if (!r.secretHash || typeof secret !== 'string' || !secret
      || !crypto.timingSafeEqual(sha256(secret), r.secretHash)) {
      return { error: { ok: false, status: 403, error: 'bad secret' } };
    }
    return { r };
  }
  function pollAnswer(r) {
    if (r.state === 'decided') { r.collected = true; return { state: 'decided', decision: r.decision }; }
    if (r.state === 'resolved') return { state: 'resolved', by: r.by };
    return { state: 'pending' };
  }

  function poll(id, secret, { wait = 0 } = {}) {
    const { r, error } = authorize(id, secret);
    if (error) return Promise.resolve(error);
    r.last_poll_at = clock();
    const ms = Math.max(0, Math.min(POLL_WAIT_MAX, Math.floor(Number(wait) || 0)));
    if (r.state !== 'pending' || ms === 0 || stopped) {
      arm(r);
      return Promise.resolve(pollAnswer(r));
    }
    r.polling += 1;
    arm(r);
    return new Promise((done) => {
      let timer = null;
      const finish = () => {
        clearT(timer);
        r.waiters.delete(waiter);
        r.polling = Math.max(0, r.polling - 1);
        r.last_poll_at = clock();
        const answer = pollAnswer(r);
        arm(r);
        done(answer);
        return true;
      };
      const waiter = (rec) => (rec.state !== 'pending' || stopped ? finish() : false);
      r.waiters.add(waiter);
      timer = setT(finish, ms);
    });
  }

  function withdraw(id, secret, reason) {
    const { r, error } = authorize(id, secret);
    if (error) return error;
    const m = WITHDRAW_REASONS[reason];
    if (!m) return { ok: false, status: 400, invalid: 'reason' };
    if (r.state !== 'resolved') resolve(r, { outcome: m.outcome, by: m.by, force: !(r.state === 'decided' && r.collected && reason !== 'sigterm') });
    return { ok: true, state: r.state, outcome: r.outcome };
  }

  function handed(id, secret) {
    const { r, error } = authorize(id, secret);
    if (error) return error;
    if (r.state === 'pending') return { ok: false, status: 409, state: r.state };
    // The hook has printed the decision: it has collected it, whatever poll
    // carried it.
    if (r.state === 'decided') { r.collected = true; forget(r); resolve(r, {}); }
    return { ok: true, state: r.state, outcome: r.outcome };
  }

  // ── the answer surface's calls ──
  // Validates a decision against this ask's kind and what it displayed;
  // returns { decision } in the hook form, or { invalid: <field> }.
  function validate(r, d) {
    if (!isPlain(d)) return { invalid: 'decision' };
    if (isElicitation(r)) return validateElicitation(r, d);
    const behavior = d.behavior;
    if (typeof behavior !== 'string' || !BEHAVIORS[r.kind].has(behavior)) return { invalid: 'behavior' };
    const allowed = { behavior: true };
    if (behavior === 'deny' || behavior === 'decline' || behavior === 'reject') allowed.message = true;
    if (behavior === 'approve') allowed.mode = true;
    if (behavior === 'answer') allowed.picks = true;
    for (const k of Object.keys(d)) if (!allowed[k]) return { invalid: k.length <= 40 && /^[A-Za-z_]+$/.test(k) ? k : 'decision' };
    if (allowed.message) {
      const message = cleanText(d.message, MESSAGE_MAX);
      if (message === null) return { invalid: 'message' };
      return { decision: message ? { behavior, message } : { behavior } };
    }
    if (behavior === 'approve') {
      if (!PLAN_MODES.has(d.mode)) return { invalid: 'mode' };
      return { decision: { behavior, mode: d.mode } };
    }
    if (behavior === 'answer') return validatePicks(r, d.picks);
    return { decision: { behavior } };
  }

  // An elicitation's decision. Accept's content is checked against the form
  // as DISPLAYED: keys among its fields, every required one present (a
  // required string not empty), each value of its field's type, an enum's
  // value one of its options, a number in range, a string within its length
  // (and never over ELICIT_STRING_MAX). A refusal names the check, never a
  // value or a key.
  function validateElicitation(r, d) {
    const behavior = d.behavior;
    if (typeof behavior !== 'string' || !BEHAVIORS.elicitation.has(behavior)) return { invalid: 'behavior' };
    for (const k of Object.keys(d)) {
      if (k === 'behavior' || (k === 'content' && behavior === 'accept')) continue;
      return { invalid: k.length <= 40 && /^[A-Za-z_]+$/.test(k) ? k : 'decision' };
    }
    if (behavior !== 'accept') return { decision: { behavior } };
    const c = d.content;
    if (!isPlain(c)) return { invalid: 'content' };
    const fields = new Map(r.display.fields.map((f) => [f.name, f]));
    const out = {};
    for (const k of Object.keys(c)) {
      const f = fields.get(k);
      if (!f) return { invalid: 'content.key' };
      const v = c[k];
      if (f.type === 'string') {
        if (typeof v !== 'string') return { invalid: 'content.type' };
        if (Array.isArray(f.enum) && !f.enum.includes(v)) return { invalid: 'content.enum' };
        const n = chars(v);
        const max = Number.isSafeInteger(f.maxLength) ? Math.min(f.maxLength, ELICIT_STRING_MAX) : ELICIT_STRING_MAX;
        if (n > max || (Number.isSafeInteger(f.minLength) && n < f.minLength)) return { invalid: 'content.length' };
      } else if (f.type === 'boolean') {
        if (typeof v !== 'boolean') return { invalid: 'content.type' };
      } else {
        if (typeof v !== 'number' || !Number.isFinite(v)) return { invalid: 'content.type' };
        if (f.type === 'integer' && !Number.isSafeInteger(v)) return { invalid: 'content.type' };
        if ((Number.isFinite(f.minimum) && v < f.minimum) || (Number.isFinite(f.maximum) && v > f.maximum)) return { invalid: 'content.range' };
      }
      Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    for (const f of fields.values()) {
      if (!f.required) continue;
      if (!hasOwn(out, f.name) || (f.type === 'string' && out[f.name] === '')) return { invalid: 'content.required' };
    }
    return { decision: { behavior, content: out } };
  }

  function validatePicks(r, picks) {
    const qs = r.questions || [];
    if (!Array.isArray(picks) || picks.length === 0 || picks.length > qs.length) return { invalid: 'picks' };
    const byQ = new Map();
    for (const p of picks) {
      if (!isPlain(p)) return { invalid: 'picks' };
      for (const k of Object.keys(p)) if (k !== 'q' && k !== 'options' && k !== 'other') return { invalid: 'picks' };
      if (!Number.isSafeInteger(p.q) || p.q < 0 || p.q >= qs.length) return { invalid: 'picks.q' };
      if (byQ.has(p.q)) return { invalid: 'picks.q' };
      const q = qs[p.q];
      const hasOptions = hasOwn(p, 'options');
      const hasOther = hasOwn(p, 'other');
      if (hasOptions === hasOther) return { invalid: 'picks' };
      if (hasOther) {
        const other = cleanText(p.other, OTHER_MAX);
        if (other === null || !other) return { invalid: 'picks.other' };
        byQ.set(p.q, { q: p.q, other });
        continue;
      }
      const opts = p.options;
      if (!Array.isArray(opts) || opts.length === 0) return { invalid: 'picks.options' };
      if (!q.multiSelect && opts.length > 1) return { invalid: 'picks.options' };
      const seen = new Set();
      for (const i of opts) {
        if (!Number.isSafeInteger(i) || i < 0 || i >= q.options.length || seen.has(i)) return { invalid: 'picks.options' };
        seen.add(i);
      }
      byQ.set(p.q, { q: p.q, options: [...seen].sort((a, b) => a - b) });
    }
    // Every question is answered: a missing one would reach Claude Code as no
    // answer at all.
    if (byQ.size !== qs.length) return { invalid: 'picks' };
    const ordered = [];
    for (let i = 0; i < qs.length; i++) ordered.push(byQ.get(i));
    return { decision: { behavior: 'answer', picks: ordered } };
  }

  function decide(id, decision, meta = {}) {
    const r = typeof id === 'string' ? records.get(id) : null;
    if (!r || !r.published) return { ok: false, status: 404, error: 'unknown ask' };
    const m = isPlain(meta) ? meta : {};
    const refusal = (status, extra) => ({ ok: false, status, ...extra });
    if (r.state !== 'pending') {
      return refusal(409, { state: r.state, outcome: r.outcome, decision: r.decision ? { behavior: r.decision.behavior } : null });
    }
    if (!r.hook_attached) return refusal(409, { state: r.state, outcome: r.outcome, why_not: 'no-hook' });
    if (m.version !== r.version) return refusal(409, { stale: true, version: r.version });
    // An elicitation is local only in 0.8.5, at every level (ruled D3 (a)): a
    // form can ask for credentials.
    if (m.remote === true && (isElicitation(r) || !remoteAnswering())) return refusal(403, { why_not: 'remote-off' });
    const v = validate(r, decision);
    if (v.invalid) return refusal(400, { invalid: v.invalid });
    if (!r.complete && ACTING.has(v.decision.behavior)) return refusal(409, { why_not: 'too-long' });
    r.decision = v.decision;
    r.state = 'decided';
    r.outcome = OUTCOME_OF[v.decision.behavior];
    r.via = 'web';
    auditLine(r, { outcome: r.outcome, via: 'web', remote: m.remote === true, device: m.device, ua: m.ua });
    bump(r, { op: 'update', ringOp: 'decided' });
    const answer = { ok: true, state: r.state, outcome: r.outcome, version: r.version };
    if (r.transport === 'mod') deliverToMod(r);
    return answer;
  }

  function noteRefusal(id, { reason, origin, device, ua } = {}) {
    const r = typeof id === 'string' ? records.get(id) || null : null;
    auditLine(r || { id: typeof id === 'string' ? id.slice(0, 64) : null, kind: null, tool_name: null }, {
      outcome: 'refused', via: 'web', remote: origin === 'remote', device, ua, reason: reason || 'refused',
    });
  }

  // ── views ──
  function internalOf(r) {
    return Object.freeze({
      id: r.id,
      conversation_id: r.conversation_id,
      session_id: r.session_id,
      claude_pid: r.claude_pid,
      agent: r.agent ? { ...r.agent } : null,
      kind: r.kind,
      tool_name: r.tool_name,
      tool_kind: r.tool_kind,
      tool_use_id: r.tool_use_id,
      input_hash: r.input_hash,
      transport: r.transport,
      // Whether an elicitation's typed content is still held (until the hook
      // has printed it, or the ask is over): a yes/no, never the content.
      content_held: !!(r.decision && hasOwn(r.decision, 'content')),
      state: r.state,
      answerable: r.answerable,
      hook_attached: r.hook_attached,
      outcome: r.outcome,
      via: r.via,
      by: r.by,
      version: r.version,
      created_at: r.created_at,
      expires_at: r.expires_at,
      applied: r.applied,
      masked: r.masked,
      complete: r.complete,
    });
  }
  function get(id) {
    const r = records.get(id);
    return r && r.published ? internalOf(r) : null;
  }
  function publicView(id) {
    const r = records.get(id);
    return r && r.published ? publicOf(r) : null;
  }
  function list({ level = 'local' } = {}) {
    const rows = [];
    for (const r of records.values()) if (r.published && r.state !== 'resolved') rows.push(publicOf(r));
    rows.reverse();
    return atLeast(level, 'read') ? rows : projectValue({ rows: ASK_SCHEMA }, rows);
  }
  function pending() {
    const out = [];
    for (const r of records.values()) if (r.published && r.state === 'pending') out.push(internalOf(r));
    return out;
  }

  function fieldValue(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return ''; }
  }
  function displayView(id, { remote = false } = {}) {
    const r = records.get(id);
    if (!r || !r.published) return null;
    let why = null;
    if (r.state !== 'pending') why = 'resolved';
    else if (!r.hook_attached) why = 'no-hook';
    else if (remote && (isElicitation(r) || !remoteAnswering())) why = 'remote-off';
    else if (!r.complete) why = 'too-long';
    const detail = {};
    if (r.kind === 'permission') {
      detail.permission = { fields: Object.keys(r.display).map((name) => ({ name, value: fieldValue(r.display[name]) })) };
    } else if (r.kind === 'question') {
      detail.question = { questions: r.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })) };
    } else if (isElicitation(r)) {
      detail.elicitation = {
        server: r.display.server,
        message: r.display.message,
        fields: r.display.fields.map((f) => ({ ...f, ...(f.enum ? { enum: f.enum.slice() } : {}) })),
      };
    } else {
      detail.plan = { html: renderMarkdown(r.plan.text, { flavor: 'chat' }), file: r.plan.file };
    }
    return {
      id: r.id,
      kind: r.kind,
      tool_name: r.tool_name,
      agent: r.agent ? { type: r.agent.type } : null,
      state: r.state,
      outcome: r.outcome,
      version: r.version,
      subject: r.subject,
      masked: r.masked,
      complete: r.complete,
      detail,
      can_answer: why === null,
      why_not: why,
      // Whether the outcome 'terminal' is the web's own "answer in the
      // terminal" (decided, or collected by the hook and so resolved) rather
      // than the terminal's answer: the frame must not claim an answer the
      // terminal has not given. Only this bit of the decision is shown. An
      // uncollected choice never reached the hook, so an ask resolved after it
      // resolved like a pending one and does not carry it.
      web_chose_terminal: !!(r.decision && r.decision.behavior === 'terminal' && (r.state === 'decided' || r.collected === true)),
    };
  }
  function waitView(id, version, wait = 0, opts = {}) {
    const r = records.get(id);
    if (!r || !r.published) return Promise.resolve(null);
    const ms = Math.max(0, Math.min(VIEW_WAIT_MAX, Math.floor(Number(wait) || 0)));
    if (r.version !== version || ms === 0 || stopped) return Promise.resolve(displayView(id, opts));
    return new Promise((done) => {
      let timer = null;
      const finish = () => {
        clearT(timer);
        r.waiters.delete(waiter);
        done(displayView(id, opts));
        return true;
      };
      const waiter = (rec) => (rec.version !== version || stopped ? finish() : false);
      r.waiters.add(waiter);
      timer = setT(finish, ms);
    });
  }

  // Clears every timer and wakes every waiter: neither teardown path leaves a
  // handle. Idempotent.
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const off of offs.splice(0)) { try { off(); } catch {} }
    for (const r of records.values()) {
      clearT(r.timer);
      r.timer = null;
      changed(r);
    }
  }

  return {
    create, createFromMod, withdrawFromMod, poll, withdraw, handed, decide, get, publicView, displayView, waitView,
    list, pending, noteRefusal, stop,
    // Read-only: true once stop() has run. The routes read it so a request
    // that lands after teardown never restarts the answer surface (U53c).
    stopped: () => stopped,
  };
}

module.exports = {
  createAsks,
  checkCreate,
  DUPLICATE_MS, LOCAL_RECENT_MS, REMOTE_RECENT_MS, POLL_MS, DEADLINE_MS, CORRELATE_MS, TTL_MS,
  HOOK_SILENT_MS, RESOLVED_KEEP_MS, RECORDS_MAX, POLL_WAIT_MAX, VIEW_WAIT_MAX, AUDIT_MAX_BYTES,
  MESSAGE_MAX, OTHER_MAX, PLAN_MD_MAX,
  ELICIT_WAIT_MS, MOD_PERMISSION_WAIT_MS, MOD_WAIT_FLAG, modPermissionWait, PASS, ELICIT_STRING_MAX, ELICIT_PROPS_MAX,
};

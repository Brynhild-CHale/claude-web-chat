// lib/core/mod-protocol.js — the mod's wire, defined once (spec §15.7).
//
// The web-chat mod is a plugin of function hooks running inside Claude Code
// (tier 2, behind a probe, never a dependency: ruling Q-A). It reaches the
// daemon over four host-only routes (lib/server/routes/bridge.js) and the
// daemon keeps its sessions in ctx.bridge (lib/server/domain/bridge.js). This
// file is what both sides agree on: the protocol number, the op and command
// allowlists, the event kinds, the caps, and the validators that hold every op
// and event to them. The bridge, its routes, the mod package (whose
// templates/claude-mod/hooks/register.js keeps a literal copy, test-held equal
// to this file), the control rows, the live feed, the composer and the session
// controls all read it. A second copy of any of these lists is the defect the
// one-engine rule exists to catch.
//
// Pure, and a lib/core leaf: it imports only lib/core (paths for the safe-id
// grammar, text for the control/bidi guard).
//
// THE OPS (validateOp; any key not listed is 'bad-args', an op outside OPS is
// 'not-allowed'). The daemon names what the mod does, never a turn id:
//
//   abort              {}              the mod aborts ITS running turn
//   taskStop           {task_id}       TaskStop's id grammar (lib/channel/envelope
//                                      STOP_TASK_ID_RE: 1-64 of [A-Za-z0-9_-]),
//                                      composed here from core's isSafeId
//   submit             {text}          1..ARG_TEXT_MAX characters, never blank,
//                                      never a text whose first non-blank
//                                      character is '/': Claude Code's
//                                      $.prompt.submit runs such a text as a
//                                      command AS THE USER, so a command goes
//                                      only as a `command` op
//   command            {name, args?}   name ∈ MOD_COMMANDS; args absent or ''
//                                      for context, clear and recap; for plan
//                                      and compact absent, '' (no argument) or
//                                      one line of at most COMMAND_ARGS_MAX
//                                      characters, no control or bidi
//                                      character, no leading '/' (Claude Code
//                                      takes '/plan <description>' and
//                                      '/compact <instructions>'); 1-64
//                                      characters, the same rules, for rename;
//                                      a UUID for resume.
//                                      Every other name — the config-persisting
//                                      ones above all (model, config,
//                                      permissions, autocompact, login, …) — is
//                                      'not-allowed' (ruling Q10)
//   fill               {text}          0..ARG_TEXT_MAX characters
//   permissionDecision {request_id, decision}
//                                      decision a plain object ≤ DECISION_MAX
//                                      bytes of JSON; 'not-allowed' when any
//                                      value (or key) anywhere in it is
//                                      'bypassPermissions' or any `destination`
//                                      is not 'session' — the transport's own
//                                      floor under the asks domain's checks
//   usage              {}
//   messages           {}              its result is counts only (ruling Q-B13)
//
// THE EVENTS (validateEvent → a bounded copy, or null). Unknown keys are
// dropped, strings cut at their caps, and a missing or malformed required
// field, or a kind outside EVENT_KINDS ∪ BRIDGE_ONLY_KINDS, is null. Every
// event keeps `at` (ms; null when the mod sent none) and the `agent_id` it
// came from when it is not the main loop.
//
//   session.start      {}
//   turn.start         {turn_id}
//   turn.step          {turn_id, index, message_id?, delta ≤ DELTA_MAX}
//   turn.complete      {turn_id, reason?, text? ≤ TEXT_MAX, usage?: the four
//                       token counts}
//   tool.call          {tool_use_id, tool, input ≤ INPUT_MAX bytes of JSON}
//   tool.done          {tool_use_id, ok, is_error?, duration_ms?,
//                       background_task_id?}
//   session.append     {uuid, origin?: {kind, as_user?}, agent_id?, message:
//                       {role, id?, model?, content: [blocks]}} — text blocks
//                       cut (TEXT_MAX for the row in all), tool_use blocks keep
//                       id, name and an input cut to INPUT_MAX, tool_result
//                       blocks keep tool_use_id and is_error only, any other
//                       block its type only
//   session.compact    {trigger, phase?}
//   session.measure    {changed?, and numbers only}
//   prompt.submit      {origin: {kind, as_user?}}   never the prompt's text
//   permission.request {request_id, tool, tool_use_id?, input}
//   permission.settled {request_id, by: 'web'|'terminal'|'timeout'}
//   session.end        {reason?}                    bridge only, never published
//   diag               {shapes: {kind: [key paths]}} bridge only: names, never values
//
// THE HELLO (validateHello): exactly {v: 1, protocol, session_id, cc_version,
// mod_version, ops, events, root}, every key required and no other — so a
// Claude Code messaging token can never ride in. `root` is the absolute
// project directory holding the .web-chat/ the mod found (decided by the main
// session, T6-refresh@mod-portfile-identity, 2026-10-13); the bridge answers
// 409 'wrong-project' when it is not the daemon's own. A protocol other than
// MOD_PROTOCOL is the bridge's 409, not a malformed hello.
//
// validateResult(body) holds the mod's POST /api/bridge/result body to
// {id, ok, result?, refused?, error?}: `result` ≤ RESULT_MAX bytes of JSON
// (over it the answer is {ok: false, refused: 'too-large'}, so the caller can
// settle the op rather than leave it to time out), `error` cut to ERROR_MAX.

const path = require('path');
const { isSafeId } = require('./paths');
const { hasForbidden } = require('./text');

const MOD_PROTOCOL = 1;
const MOD_EVENT = 'ModEvent';
const MOD_MIN_CLAUDE = '2.1.287';

const OPS = Object.freeze(['abort', 'taskStop', 'submit', 'command', 'fill', 'permissionDecision', 'usage', 'messages']);
const MOD_COMMANDS = Object.freeze(['plan', 'compact', 'context', 'clear', 'rename', 'resume', 'recap']);
const EVENT_KINDS = Object.freeze([
  'session.start', 'turn.start', 'turn.step', 'turn.complete', 'tool.call', 'tool.done',
  'session.append', 'session.compact', 'session.measure', 'prompt.submit',
  'permission.request', 'permission.settled',
]);
const BRIDGE_ONLY_KINDS = Object.freeze(['session.end', 'diag']);

// The caps (spec §15.7; notes-B §3).
const BODY_MAX = 64 * 1024; // a POST body
const BATCH_MAX = 50; // events per POST /api/bridge/events
const DELTA_MAX = 4096; // characters per turn.step delta
const TEXT_MAX = 32 * 1024; // characters: turn.complete's text, one appended row's text
const INPUT_MAX = 8 * 1024; // bytes of tool input JSON
const ARG_TEXT_MAX = 16 * 1024; // characters: submit and fill
const OPS_WAIT_MAX_MS = 20000; // a long-poll's longest wait
const FLUSH_MS = 100; // how often the mod flushes its event batch
const QUEUE_MAX = 32; // queued ops per session
const WAITERS_MAX = 32; // long-polls waiting, in all
const STALE_MS = 60000; // no poll for this long: the session is detached
const TAP_RATE = 30; // envelopes per second per session onto the hook tap
const OPS_PER_POLL = 8; // ops handed out per poll answer
const DECISION_MAX = 8 * 1024; // bytes of a permissionDecision's decision
const RESULT_MAX = 8 * 1024; // bytes of an op result
const ERROR_MAX = 200; // characters of an op error
const PERMISSION_WAIT_MAX_MS = 590000; // the hello's permission_wait_ms, at most

const DECISION_DEPTH = 16;
const BOUND_DEPTH = 8;
const BOUND_KEYS = 64;
const BOUND_ITEMS = 64;
const BLOCKS_MAX = 64;
const NAME_MAX = 200; // a tool name (the hook envelope's own cap)
const TOOL_USE_ID_MAX = 100; // a tool_use id (the hook envelope's own cap)
const RENAME_MAX = 64;
const COMMAND_ARGS_MAX = 2000; // characters of /plan's or /compact's optional line
const SHAPE_KINDS_MAX = 32;
const SHAPE_PATHS_MAX = 64;
const SHAPE_PATH_MAX = 128;
const LIST_MAX = 64; // the hello's ops and events lists
const MEASURE_KEYS = 32;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// An id the mod hands over (a turn, a message, a request, a tool_use): one
// token of printable ASCII, no space, no slash.
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
// A state word: a reason, a trigger, a phase, an origin's kind, a role.
const WORD_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
// A version as Claude Code and the mod report one: dotted numerics, then an
// optional prerelease or build tail.
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.+-]{1,48})?$/;
// A key path in a diag shape: names, dots, brackets.
const SHAPE_PATH_RE = /^[A-Za-z0-9_$.[\]-]{1,128}$/;

const OPS_SET = new Set(OPS);
const COMMAND_SET = new Set(MOD_COMMANDS);
const ARGLESS_COMMANDS = new Set(['context', 'clear', 'recap']);
const LINE_ARG_COMMANDS = new Set(['plan', 'compact']);
const KIND_SET = new Set([...EVENT_KINDS, ...BRIDGE_ONLY_KINDS]);
const SETTLED_BY = new Set(['web', 'terminal', 'timeout']);
const USAGE_KEYS = Object.freeze(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
const HELLO_KEYS = Object.freeze(['v', 'protocol', 'session_id', 'cc_version', 'mod_version', 'ops', 'events', 'root']);
const RESULT_KEYS = new Set(['id', 'ok', 'result', 'refused', 'error']);
const REFUSED_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ── small helpers ───────────────────────────────────────────────────────────

function isPlain(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// TaskStop's id grammar, /^[A-Za-z0-9_-]{1,64}$/ (lib/channel/envelope
// STOP_TASK_ID_RE), built from core's safe-id grammar (1-100 of the same
// characters) and the length: lib/core may not import lib/channel, and a
// fourth copy of the regex is what the brief forbids. test/mod-protocol.test.js
// holds the two equal.
function isTaskId(v) {
  return isSafeId(v) && v.length <= 64;
}

function isId(v, max = 128) {
  return typeof v === 'string' && v.length <= max && EVENT_ID_RE.test(v);
}

function isWord(v) {
  return typeof v === 'string' && WORD_RE.test(v);
}

// A string cut to `max` characters, never splitting a surrogate pair.
function cut(s, max) {
  if (typeof s !== 'string') return null;
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function bytesOf(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? 0 : Buffer.byteLength(s, 'utf8');
  } catch { return Infinity; }
}

function nonNegative(v) {
  return finite(v) && v >= 0;
}

// ── a JSON value inside a byte bound ────────────────────────────────────────

// A copy of any JSON value: depth, keys and items bounded, functions and other
// non-JSON values gone, strings cut to `limit` characters.
function copyBounded(v, depth, limit) {
  if (typeof v === 'string') return cut(v, limit);
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'object' || depth >= BOUND_DEPTH) return undefined;
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v.slice(0, BOUND_ITEMS)) {
      const c = copyBounded(x, depth + 1, limit);
      out.push(c === undefined ? null : c);
    }
    return out;
  }
  if (!isPlain(v)) return undefined;
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= BOUND_KEYS) break;
    const c = copyBounded(v[k], depth + 1, limit);
    if (c === undefined) continue;
    Object.defineProperty(out, cut(k, 128), { value: c, enumerable: true, writable: true, configurable: true });
    n += 1;
  }
  return out;
}

function longestString(v) {
  if (typeof v === 'string') return v.length;
  if (v === null || typeof v !== 'object') return 0;
  let max = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) max = Math.max(max, longestString(x));
  return max;
}

// A plain object inside `maxBytes` of JSON: the string limit halves until it
// fits; an object that still does not fit (a thousand keys of numbers) is
// replaced by {truncated: true}. Anything but a plain object is {}.
function boundObject(v, maxBytes) {
  if (!isPlain(v)) return {};
  let limit = Math.min(maxBytes, Math.max(16, longestString(v)));
  let out = copyBounded(v, 0, limit);
  while (bytesOf(out) > maxBytes && limit > 16) {
    limit >>= 1;
    out = copyBounded(v, 0, limit);
  }
  return bytesOf(out) > maxBytes ? { truncated: true } : out;
}

// ── ops ─────────────────────────────────────────────────────────────────────

const HINTS = Object.freeze({
  notAllowed: (op) => `${op} is not an op the mod may be asked to run`,
  command: 'only plan, compact, context, clear, rename, resume and recap run through the mod; no config-persisting command is ever offered',
  submitSlash: 'a text beginning with / would run as a command; send a command op instead',
  bypass: 'a permission decision may never grant bypassPermissions, and may only change this session',
});

function refuse(refused, hint) {
  return { ok: false, refused, hint };
}

function exactKeys(args, allowed) {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) return k;
  return null;
}

// Every value and key anywhere in a decision: true when it grants a bypass or
// writes outside the session. `depth` bounds a hostile nest (bad-args).
function decisionProblem(v, depth = 0) {
  if (depth > DECISION_DEPTH) return 'bad-args';
  if (typeof v === 'string') return v === 'bypassPermissions' ? 'not-allowed' : null;
  if (v === null || typeof v !== 'object') return null;
  const entries = Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v);
  for (const [k, x] of entries) {
    if (k === 'bypassPermissions') return 'not-allowed';
    if (k === 'destination' && x !== 'session') return 'not-allowed';
    const p = decisionProblem(x, depth + 1);
    if (p) return p;
  }
  return null;
}

function validateCommand(args) {
  const extra = exactKeys(args, ['name', 'args']);
  if (extra !== null) return refuse('bad-args', 'command takes {name, args?}');
  const { name } = args;
  if (typeof name !== 'string' || !COMMAND_SET.has(name)) return refuse('not-allowed', HINTS.command);
  const a = args.args;
  if (ARGLESS_COMMANDS.has(name)) {
    if (a !== undefined && a !== null && a !== '') return refuse('bad-args', `${name} takes no arguments here`);
    return { ok: true, args: { name } };
  }
  if (LINE_ARG_COMMANDS.has(name)) {
    if (a === undefined || a === null || a === '') return { ok: true, args: { name } };
    if (typeof a !== 'string' || a.length > COMMAND_ARGS_MAX || hasForbidden(a) || a.trimStart().startsWith('/')) {
      return refuse('bad-args', `${name} takes an optional line of at most ${COMMAND_ARGS_MAX} characters, with no control or bidi character, not starting with /`);
    }
    return { ok: true, args: { name, args: a } };
  }
  if (name === 'rename') {
    if (typeof a !== 'string' || a.length < 1 || a.length > RENAME_MAX || a.trim() === ''
      || hasForbidden(a) || a.startsWith('/')) {
      return refuse('bad-args', `rename takes a name of 1 to ${RENAME_MAX} characters on one line, not starting with /`);
    }
    return { ok: true, args: { name, args: a } };
  }
  // resume
  if (!isUuid(a)) return refuse('bad-args', 'resume takes a session id (a UUID)');
  return { ok: true, args: { name, args: a.toLowerCase() } };
}

function validateOp(op, args) {
  if (typeof op !== 'string' || !OPS_SET.has(op)) {
    return refuse('not-allowed', HINTS.notAllowed(typeof op === 'string' && /^[A-Za-z]{1,32}$/.test(op) ? op : 'that'));
  }
  if (args === undefined || args === null) args = {};
  if (!isPlain(args)) return refuse('bad-args', `${op} takes an object of arguments`);
  switch (op) {
    case 'abort': case 'usage': case 'messages':
      if (Object.keys(args).length) return refuse('bad-args', `${op} takes no arguments`);
      return { ok: true, args: {} };
    case 'taskStop':
      if (exactKeys(args, ['task_id']) !== null || !isTaskId(args.task_id)) {
        return refuse('bad-args', 'taskStop takes {task_id}: 1 to 64 letters, digits, _ or -');
      }
      return { ok: true, args: { task_id: args.task_id } };
    case 'submit': {
      const { text } = args;
      if (exactKeys(args, ['text']) !== null || typeof text !== 'string'
        || text.length < 1 || text.length > ARG_TEXT_MAX || text.trim() === '') {
        return refuse('bad-args', `submit takes {text}: 1 to ${ARG_TEXT_MAX} characters`);
      }
      if (text.trimStart().startsWith('/')) return refuse('bad-args', HINTS.submitSlash);
      return { ok: true, args: { text } };
    }
    case 'command':
      return validateCommand(args);
    case 'fill': {
      const { text } = args;
      if (exactKeys(args, ['text']) !== null || typeof text !== 'string' || text.length > ARG_TEXT_MAX) {
        return refuse('bad-args', `fill takes {text}: at most ${ARG_TEXT_MAX} characters`);
      }
      return { ok: true, args: { text } };
    }
    case 'permissionDecision': {
      const { request_id: requestId, decision } = args;
      if (exactKeys(args, ['request_id', 'decision']) !== null || !isSafeId(requestId) || !isPlain(decision)) {
        return refuse('bad-args', 'permissionDecision takes {request_id, decision}');
      }
      if (bytesOf(decision) > DECISION_MAX) return refuse('bad-args', `a decision is at most ${DECISION_MAX} bytes of JSON`);
      const problem = decisionProblem(decision);
      if (problem === 'not-allowed') return refuse('not-allowed', HINTS.bypass);
      if (problem) return refuse('bad-args', 'a decision nests too deep');
      return { ok: true, args: { request_id: requestId, decision: JSON.parse(JSON.stringify(decision)) } };
    }
    default:
      return refuse('not-allowed', HINTS.notAllowed(op));
  }
}

// ── events ──────────────────────────────────────────────────────────────────

function originOf(v) {
  if (!isPlain(v) || !isWord(v.kind)) return null;
  const out = { kind: v.kind };
  if (typeof v.as_user === 'boolean') out.as_user = v.as_user;
  return out;
}

function usageOf(v) {
  if (!isPlain(v)) return null;
  const out = {};
  for (const k of USAGE_KEYS) if (nonNegative(v[k])) out[k] = v[k];
  return Object.keys(out).length ? out : null;
}

// session.measure: `changed` (a list of names, a boolean, or an object of
// numbers), then every other top-level number, or object of numbers.
function measureOf(raw) {
  const out = {};
  let n = 0;
  const numbers = (o) => {
    const r = {};
    let m = 0;
    for (const [k, x] of Object.entries(o)) {
      if (m >= MEASURE_KEYS) break;
      if (isWord(k) && finite(x)) { r[k] = x; m += 1; }
    }
    return r;
  };
  const c = raw.changed;
  if (typeof c === 'boolean') out.changed = c;
  else if (Array.isArray(c)) out.changed = c.filter(isWord).slice(0, MEASURE_KEYS);
  else if (isPlain(c)) out.changed = numbers(c);
  for (const [k, x] of Object.entries(raw)) {
    if (n >= MEASURE_KEYS) break;
    if (k === 'changed' || k === 'kind' || k === 'at' || k === 'agent_id' || !isWord(k)) continue;
    if (finite(x)) { out[k] = x; n += 1; } else if (isPlain(x)) { out[k] = numbers(x); n += 1; }
  }
  return out;
}

function shapesOf(v) {
  if (!isPlain(v)) return null;
  const out = {};
  let n = 0;
  for (const [k, paths] of Object.entries(v)) {
    if (n >= SHAPE_KINDS_MAX) break;
    if (!isWord(k) || !Array.isArray(paths)) continue;
    out[k] = paths.filter((p) => typeof p === 'string' && p.length <= SHAPE_PATH_MAX && SHAPE_PATH_RE.test(p)).slice(0, SHAPE_PATHS_MAX);
    n += 1;
  }
  return out;
}

// One appended row's content blocks, the row's text within TEXT_MAX in all.
function blocksOf(content) {
  let budget = TEXT_MAX;
  const text = (s) => {
    const c = cut(s, Math.max(0, budget)) || '';
    budget -= c.length;
    return c;
  };
  if (typeof content === 'string') return text(content);
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content.slice(0, BLOCKS_MAX)) {
    if (!isPlain(b) || typeof b.type !== 'string' || !isWord(b.type)) continue;
    if (b.type === 'text') out.push({ type: 'text', text: typeof b.text === 'string' ? text(b.text) : '' });
    else if (b.type === 'tool_use') {
      const block = { type: 'tool_use' };
      if (isId(b.id, TOOL_USE_ID_MAX)) block.id = b.id;
      if (typeof b.name === 'string') block.name = cut(b.name, NAME_MAX);
      block.input = boundObject(b.input, INPUT_MAX);
      out.push(block);
    } else if (b.type === 'tool_result') {
      const block = { type: 'tool_result' };
      if (isId(b.tool_use_id, TOOL_USE_ID_MAX)) block.tool_use_id = b.tool_use_id;
      if (typeof b.is_error === 'boolean') block.is_error = b.is_error;
      out.push(block);
    } else out.push({ type: b.type });
  }
  return out;
}

function messageOf(v) {
  if (!isPlain(v) || !isWord(v.role)) return null;
  const out = { role: v.role };
  if (isId(v.id)) out.id = v.id;
  if (typeof v.model === 'string' && v.model) out.model = cut(v.model, 128);
  out.content = blocksOf(v.content);
  return out;
}

// The payload of each kind, or null when a required field is missing or
// malformed.
const PAYLOADS = {
  'session.start': () => ({}),
  'turn.start': (r) => (isId(r.turn_id) ? { turn_id: r.turn_id } : null),
  'turn.step': (r) => {
    if (!isId(r.turn_id) || !(Number.isSafeInteger(r.index) && r.index >= 0) || typeof r.delta !== 'string') return null;
    const out = { turn_id: r.turn_id, index: r.index };
    if (isId(r.message_id)) out.message_id = r.message_id;
    out.delta = cut(r.delta, DELTA_MAX);
    return out;
  },
  'turn.complete': (r) => {
    if (!isId(r.turn_id)) return null;
    const out = { turn_id: r.turn_id };
    if (isWord(r.reason)) out.reason = r.reason;
    if (typeof r.text === 'string') out.text = cut(r.text, TEXT_MAX);
    const usage = usageOf(r.usage);
    if (usage) out.usage = usage;
    return out;
  },
  'tool.call': (r) => {
    if (!isId(r.tool_use_id, TOOL_USE_ID_MAX) || typeof r.tool !== 'string' || !r.tool) return null;
    return { tool_use_id: r.tool_use_id, tool: cut(r.tool, NAME_MAX), input: boundObject(r.input, INPUT_MAX) };
  },
  'tool.done': (r) => {
    if (!isId(r.tool_use_id, TOOL_USE_ID_MAX) || typeof r.ok !== 'boolean') return null;
    const out = { tool_use_id: r.tool_use_id, ok: r.ok };
    if (typeof r.is_error === 'boolean') out.is_error = r.is_error;
    if (nonNegative(r.duration_ms)) out.duration_ms = r.duration_ms;
    if (isTaskId(r.background_task_id)) out.background_task_id = r.background_task_id;
    return out;
  },
  'session.append': (r) => {
    const message = messageOf(r.message);
    if (!isUuid(r.uuid) || !message) return null;
    const out = { uuid: r.uuid };
    const origin = originOf(r.origin);
    if (origin) out.origin = origin;
    out.message = message;
    return out;
  },
  'session.compact': (r) => {
    if (!isWord(r.trigger)) return null;
    const out = { trigger: r.trigger };
    if (isWord(r.phase)) out.phase = r.phase;
    return out;
  },
  'session.measure': (r) => measureOf(r),
  'prompt.submit': (r) => {
    const origin = originOf(r.origin);
    return origin ? { origin } : null;
  },
  'permission.request': (r) => {
    if (!isSafeId(r.request_id) || typeof r.tool !== 'string' || !r.tool) return null;
    const out = { request_id: r.request_id, tool: cut(r.tool, NAME_MAX) };
    if (isId(r.tool_use_id, TOOL_USE_ID_MAX)) out.tool_use_id = r.tool_use_id;
    out.input = boundObject(r.input, INPUT_MAX);
    return out;
  },
  'permission.settled': (r) => (isSafeId(r.request_id) && SETTLED_BY.has(r.by) ? { request_id: r.request_id, by: r.by } : null),
  'session.end': (r) => (isWord(r.reason) ? { reason: r.reason } : {}),
  diag: (r) => {
    const shapes = shapesOf(r.shapes);
    return shapes ? { shapes } : null;
  },
};

function validateEvent(kind, raw) {
  if (typeof kind !== 'string' || !KIND_SET.has(kind) || !isPlain(raw)) return null;
  let payload;
  try { payload = PAYLOADS[kind](raw); } catch { return null; }
  if (!payload) return null;
  const out = { kind, at: finite(raw.at) && raw.at > 0 ? raw.at : null };
  if (isId(raw.agent_id)) out.agent_id = raw.agent_id;
  return { ...out, ...payload };
}

// ── the hello ───────────────────────────────────────────────────────────────

function bad(hint) {
  return { ok: false, refused: 'bad-args', hint };
}

function nameList(v) {
  return Array.isArray(v) && v.length <= LIST_MAX && v.every((x) => typeof x === 'string' && x.length <= 64);
}

function validateHello(body) {
  if (!isPlain(body)) return bad('a hello is a JSON object');
  for (const k of Object.keys(body)) {
    if (!HELLO_KEYS.includes(k)) return bad(/^[A-Za-z_]{1,32}$/.test(k) ? `unknown field ${k}` : 'unknown field');
  }
  for (const k of HELLO_KEYS) if (!hasOwn(body, k)) return bad(`missing ${k}`);
  if (body.v !== 1) return bad('unsupported hello version');
  if (!(Number.isSafeInteger(body.protocol) && body.protocol > 0)) return bad('bad protocol');
  if (!isUuid(body.session_id)) return bad('bad session_id');
  if (typeof body.cc_version !== 'string' || !VERSION_RE.test(body.cc_version)) return bad('bad cc_version');
  if (typeof body.mod_version !== 'string' || !VERSION_RE.test(body.mod_version)) return bad('bad mod_version');
  if (!nameList(body.ops)) return bad('bad ops');
  if (!nameList(body.events)) return bad('bad events');
  const { root } = body;
  if (typeof root !== 'string' || !root || root.length > 4096 || root.includes('\0') || !path.isAbsolute(root)) {
    return bad('bad root: the absolute project directory');
  }
  return {
    ok: true,
    hello: {
      v: 1,
      protocol: body.protocol,
      session_id: body.session_id.toLowerCase(),
      cc_version: body.cc_version,
      mod_version: body.mod_version,
      ops: [...body.ops],
      events: [...body.events],
      root,
    },
  };
}

// ── an op's result ──────────────────────────────────────────────────────────

function validateResult(body) {
  if (!isPlain(body)) return bad('a result is a JSON object');
  for (const k of Object.keys(body)) if (!RESULT_KEYS.has(k)) return bad('unknown field');
  if (typeof body.id !== 'string' || !/^op_[a-z0-9]{1,16}$/.test(body.id)) return bad('bad id');
  if (typeof body.ok !== 'boolean') return bad('bad ok');
  const out = { id: body.id, ok: body.ok };
  if (body.result !== undefined) {
    if (bytesOf(body.result) > RESULT_MAX) return { ok: false, refused: 'too-large', hint: `a result is at most ${RESULT_MAX} bytes of JSON`, id: body.id };
    out.result = JSON.parse(JSON.stringify(body.result));
  }
  if (body.refused !== undefined && body.refused !== null) {
    out.refused = typeof body.refused === 'string' && REFUSED_RE.test(body.refused) ? body.refused : 'failed';
  }
  if (typeof body.error === 'string') out.error = cut(body.error, ERROR_MAX);
  return { ok: true, result: out };
}

module.exports = {
  MOD_PROTOCOL, MOD_EVENT, MOD_MIN_CLAUDE,
  OPS, MOD_COMMANDS, EVENT_KINDS, BRIDGE_ONLY_KINDS, USAGE_KEYS, HELLO_KEYS,
  BODY_MAX, BATCH_MAX, DELTA_MAX, TEXT_MAX, INPUT_MAX, ARG_TEXT_MAX, OPS_WAIT_MAX_MS, FLUSH_MS,
  QUEUE_MAX, WAITERS_MAX, STALE_MS, TAP_RATE, OPS_PER_POLL, DECISION_MAX, RESULT_MAX, ERROR_MAX,
  PERMISSION_WAIT_MAX_MS, RENAME_MAX, COMMAND_ARGS_MAX,
  UUID_RE,
  isUuid, isTaskId,
  validateOp, validateEvent, validateHello, validateResult,
};

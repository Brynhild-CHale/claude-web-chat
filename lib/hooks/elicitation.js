// lib/hooks/elicitation.js — the `elicit` subcommand on Elicitation: an MCP
// server's form request, answerable from the web-chat page (spec §15.7,
// tranche 6).
//
// Claude Code runs this hook BEFORE it shows the terminal's own dialog (the
// control record measured 55–137 ms), and the dialog waits for the hook. So a
// hook that waits leaves the terminal with NO dialog: it waits only while a
// local viewer is connected now (the asks domain decides, `wait`), and only
// for ELICIT_WAIT_MS (ruled D-defaults (a), U92@elicit-wait: 45 s). Every way
// out but a decision prints nothing, and the terminal's dialog appears.
//
//   1. An SDK host (CLAUDE_CODE_ENTRYPOINT sdk-…) returns at once, posting
//      nothing (as ask.js, §4.1).
//   2. mode 'url' — an MCP server asking the user to open a URL — is always
//      the terminal's (ruled D-defaults (a), U92@url-mode-elicitations).
//   3. A requested_schema that is not a flat object of string, number,
//      integer, boolean or string-enum properties (at most SCHEMA_PROPS_MAX)
//      is the terminal's: the page draws only those.
//   4. No daemon (no portfile): return. A hook never spawns a daemon.
//   5. POST /api/asks {v: 1, envelope, kind: 'elicitation', elicitation:
//      {server, message, mode, elicitation_id, schema}} within 800 ms. Any
//      failure, or `wait: false` (no local viewer now, a duplicate handler):
//      return at once with no output — the dialog shows at once.
//   6. SIGTERM: withdraw {reason: 'sigterm'} under a 400 ms hard exit.
//   7. Long-poll the decision as ask.js does (the secret header, a pause
//      after a poll that answers too soon) until ELICIT_WAIT_MS, then
//      withdraw 'deadline' and print nothing. A decision prints
//      buildElicitationOutput's one line, awaited, then POSTs handed:
//        accept   {hookSpecificOutput: {hookEventName: 'Elicitation',
//                  action: 'accept', content}}, each value coerced to its
//                  property's type from the hook's OWN copy of the schema
//                  (a '3' for a number is 3), a key that copy lacks dropped
//        decline  action 'decline'
//        cancel   action 'cancel'
//        terminal nothing: the terminal's dialog
//      An accept the local copy cannot type (a value that is no number, an
//      enum miss, a required key missing) prints nothing and throws
//      ELICIT_UNMAPPED, so hook.log records the outcome.
//
// THE CONTENT IS NEVER KEPT. What the user typed passes through this process
// once, to stdout; it is never logged — hook.log gets ids and outcomes only
// (lib/hooks/index.js's rule), never a field, a value or the message.
//
// This file is the one home of the Elicitation output's event name under lib/
// (a ratchet candidate, U94b), as ask-output.js is PermissionRequest's.
//
// Dependency direction: lib/hooks → lib/client, lib/core. Never lib/server.

const client = require('../client');
const portfiles = require('../core/portfiles');
const { hookEnvelope, isSdkEntrypoint } = require('./envelope');
const {
  ASKS_PATH, SECRET_HEADER, CREATE_TIMEOUT_MS, POLL_WAIT_MS, POLL_TIMEOUT_MS, HANDED_TIMEOUT_MS,
  SIGTERM_WITHDRAW_TIMEOUT_MS, SIGTERM_EXIT_MS,
} = require('./ask');

// How long the hook holds the terminal's dialog back for the page (ruled
// D-defaults (a), U92@elicit-wait). The asks domain answers the same figure
// as deadline_ms; the shorter of the two wins.
const ELICIT_WAIT_MS = 45_000;
// ask.js's pause after a poll that answers `pending` too soon.
const POLL_FLOOR_MS = 250;
const WITHDRAW_TIMEOUT_MS = 1000;

// What the page can draw (the asks domain bounds the same, §15.7).
const SCHEMA_PROPS_MAX = 20;
const TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const PROP_KEYS = ['type', 'title', 'description', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'format', 'default'];

const ID_RE = /^ask_[0-9a-f]{12}$/;
const ACTIONS = new Set(['accept', 'decline', 'cancel']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The schema as the page may draw it — a copy holding only the keys it reads —
// or null when it is not a flat form of supported fields.
function formSchema(schema) {
  if (!isPlain(schema)) return null;
  if (schema.type !== undefined && schema.type !== 'object') return null;
  if (!isPlain(schema.properties)) return null;
  const names = Object.keys(schema.properties);
  if (names.length === 0 || names.length > SCHEMA_PROPS_MAX) return null;
  const properties = {};
  for (const name of names) {
    const p = schema.properties[name];
    if (!isPlain(p) || !TYPES.has(p.type)) return null;
    if (p.enum !== undefined) {
      if (p.type !== 'string' || !Array.isArray(p.enum) || p.enum.length === 0
        || !p.enum.every((v) => typeof v === 'string')) return null;
    }
    const out = {};
    for (const k of PROP_KEYS) if (hasOwn(p, k) && p[k] !== undefined) out[k] = p[k];
    Object.defineProperty(properties, name, { value: out, enumerable: true, writable: true, configurable: true });
  }
  let required = [];
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((k) => typeof k === 'string' && hasOwn(properties, k))) return null;
    required = [...new Set(schema.required)];
  }
  return { type: 'object', properties, required };
}

// One value typed by its property, or undefined when it cannot be.
function coerce(prop, v) {
  switch (prop.type) {
    case 'string':
      if (typeof v !== 'string') return undefined;
      if (Array.isArray(prop.enum) && !prop.enum.includes(v)) return undefined;
      return v;
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?[0-9]+$/.test(v.trim()) ? Number(v) : NaN;
      return Number.isSafeInteger(n) ? n : undefined;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return undefined;
    default:
      return undefined;
  }
}

// What the hook prints for a decision: one line of JSON, or null — print
// nothing, and the terminal's dialog shows. `schema` is the hook's own copy
// (formSchema of the requested_schema Claude Code handed it).
function buildElicitationOutput(decision, schema) {
  if (!isPlain(decision) || typeof decision.behavior !== 'string') return null;
  const action = decision.behavior;
  if (!ACTIONS.has(action)) return null;
  if (action !== 'accept') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action } });
  }
  const s = schema && isPlain(schema.properties) ? schema : null;
  if (!s || !isPlain(decision.content)) return null;
  const content = {};
  for (const name of Object.keys(decision.content)) {
    if (!hasOwn(s.properties, name)) continue; // a key the hook's schema lacks: dropped
    const v = coerce(s.properties[name], decision.content[name]);
    if (v === undefined) return null;
    Object.defineProperty(content, name, { value: v, enumerable: true, writable: true, configurable: true });
  }
  for (const name of s.required || []) if (!hasOwn(content, name)) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content } });
}

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

const defaultSleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (typeof t.unref === 'function') t.unref();
});

// ctx: {root, now, deadline} from the dispatcher; in process (tests) also
// env, stdout, signals, clock (() → ms) and sleep (ms → promise).
async function elicit(payload, ctx = {}) {
  const env = ctx.env || process.env;
  if (isSdkEntrypoint(env)) return 'sdk';
  if (!isPlain(payload) || payload.hook_event_name !== 'Elicitation') return 'ignored';
  const mode = payload.mode === undefined || payload.mode === null ? 'form' : payload.mode;
  if (mode === 'url') return 'url';
  if (mode !== 'form') return 'unsupported';
  const schema = formSchema(payload.requested_schema);
  if (!schema) return 'unsupported';
  if (typeof payload.mcp_server_name !== 'string' || !payload.mcp_server_name) return 'unsupported';
  if (typeof payload.message !== 'string') return 'unsupported';

  const root = ctx.root || process.cwd();
  const info = portfiles.readPortfile('server', { root });
  if (!info) return 'no-daemon';
  const envelope = hookEnvelope(payload, env, { now: ctx.now });
  if (!envelope) return 'dropped';
  const port = info.port;
  const clock = typeof ctx.clock === 'function' ? ctx.clock : Date.now;
  const sleep = typeof ctx.sleep === 'function' ? ctx.sleep : defaultSleep;
  const start = clock();

  let created;
  try {
    created = await client.post(ASKS_PATH, {
      v: 1,
      envelope,
      kind: 'elicitation',
      elicitation: {
        server: payload.mcp_server_name,
        message: payload.message,
        mode,
        elicitation_id: typeof payload.elicitation_id === 'string' ? payload.elicitation_id : null,
        schema,
      },
    }, { port, noSpawn: true, timeout: CREATE_TIMEOUT_MS });
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
    const deadline = start + Math.min(Number.isFinite(ms) && ms > 0 ? ms : ELICIT_WAIT_MS, ELICIT_WAIT_MS);
    while (clock() < deadline) {
      const asked = clock();
      const wait = Math.max(0, Math.min(POLL_WAIT_MS, deadline - asked));
      let res;
      try {
        res = await Promise.race([client.get(`${askPath}/decision?wait=${wait}`, opts(POLL_TIMEOUT_MS)), stopped]);
      } catch {
        return terminated ? 'withdrawn' : 'poll-failed';
      }
      if (res === STOPPED) return 'withdrawn';
      if (!isPlain(res)) return 'poll-failed';
      if (res.state === 'decided') {
        const out = buildElicitationOutput(res.decision, schema);
        const behavior = isPlain(res.decision) ? res.decision.behavior : null;
        if (out === null && behavior !== 'terminal') {
          const e = new Error('unmapped decision');
          e.code = 'ELICIT_UNMAPPED';
          throw e;
        }
        if (typeof out === 'string') await writeOut(ctx.stdout || process.stdout, out);
        try { await client.post(`${askPath}/handed`, null, opts(HANDED_TIMEOUT_MS)); } catch {}
        return 'decided';
      }
      if (res.state === 'resolved') return 'resolved';
      const spent = clock() - asked;
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

module.exports = elicit;
// The dispatcher's hard exit for this handler: the wait plus room to withdraw
// (lib/hooks/index.js reads it in place of its table's).
module.exports.deadlineMs = ELICIT_WAIT_MS + 5000;
module.exports.ELICIT_WAIT_MS = ELICIT_WAIT_MS;
module.exports.SCHEMA_PROPS_MAX = SCHEMA_PROPS_MAX;
module.exports.POLL_FLOOR_MS = POLL_FLOOR_MS;
module.exports.buildElicitationOutput = buildElicitationOutput;
module.exports.formSchema = formSchema;
